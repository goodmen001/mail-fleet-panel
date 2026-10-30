// GitHub access gateway with acceleration mirrors (v28).
// Modes, in priority order (mode = 'auto' | 'direct' | 'mirror' | 'custom'):
//   custom  → user-supplied prefix (setting gh_proxy_url, e.g. https://ghproxy.net/)
//   direct  → github.com / api.github.com as-is
//   mirror  → cycle through KNOWN_MIRRORS until one works (remembered in DB)
// 'auto' (default) tries direct first, falls back to mirrors. All GitHub
// fetches in the panel go through ghFetch(); api paths get the prefix on the
// host (api.github.com → <mirror>/api.github.com), asset/browser URLs the
// whole URL — the mirrors are transparent proxies that accept full GitHub URLs.

import db from '../db/index.js';

// settings table lives in db/index.js migrations (below); keep reads defensive
export const KNOWN_MIRRORS = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/'
];

function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM panel_setting WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch { return null; }
}

function setSetting(key, value) {
  db.prepare('INSERT INTO panel_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getGhConfig() {
  return {
    mode: getSetting('gh_proxy_mode') || 'auto',
    customUrl: getSetting('gh_proxy_url') || '',
    // last mirror that worked (empty = none yet)
    lastGood: getSetting('gh_proxy_last_good') || ''
  };
}

export function setGhConfig({ mode, customUrl }) {
  if (mode !== undefined) {
    if (!['auto', 'direct', 'mirror', 'custom'].includes(mode)) throw new Error('mode 须为 auto|direct|mirror|custom');
    setSetting('gh_proxy_mode', mode);
  }
  if (customUrl !== undefined) {
    const u = (customUrl || '').trim();
    if (u && !/^https?:\/\//.test(u)) throw new Error('代理地址须以 http(s):// 开头');
    setSetting('gh_proxy_url', u.replace(/\/?$/, u ? '/' : ''));
  }
}

// apply a mirror prefix to a github URL
function withPrefix(prefix, url) {
  return prefix + url.replace(/^https?:\/\//, '');
}

// try one fetch; returns the Response or null on network failure. A 5xx is a
// line failure; 403/429 from a mirror usually means it refuses API passthrough
// — treat those as line failures too so we fall through to the next mirror.
async function attempt(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (res.status >= 500 || res.status === 403 || res.status === 429) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// the single entry point every GitHub call goes through
export async function ghFetch(url, init = {}, { timeoutMs = 30000 } = {}) {
  const cfg = getGhConfig();
  const headers = { 'User-Agent': 'mail-fleet-panel', ...(init.headers || {}) };

  if (cfg.mode === 'direct') {
    return fetch(url, { ...init, headers });
  }
  if (cfg.mode === 'custom' && cfg.customUrl) {
    const res = await attempt(withPrefix(cfg.customUrl, url), { ...init, headers }, timeoutMs);
    if (res) return res;
    throw new Error(`自定义 GitHub 加速地址不可用（${cfg.customUrl}），请检查或换一个地址`);
  }

  const mirrors = [];
  if (cfg.mode === 'auto') mirrors.push(null); // direct first
  if (cfg.lastGood) mirrors.push(cfg.lastGood);
  for (const m of KNOWN_MIRRORS) if (!mirrors.includes(m)) mirrors.push(m);
  if (cfg.mode === 'auto') mirrors.push(null); // in case lastGood was a stale mirror

  let lastErr = null;
  let directRes = null; // a genuine GitHub answer (e.g. real 403) kept as fallback
  for (const m of mirrors) {
    const target = m ? withPrefix(m, url) : url;
    const res = await attempt(target, { ...init, headers }, timeoutMs);
    if (res) {
      if (m) setSetting('gh_proxy_last_good', m);
      return res;
    }
    // remember the plain-direct answer even when mirrored lines "failed" —
    // a real GitHub 403/404 should surface, not a generic line error
    if (!m) {
      try {
        directRes = await fetch(url, { ...init, headers });
      } catch (e) { lastErr = e; }
    }
  }
  if (directRes) return directRes;
  throw new Error(`GitHub 访问失败（已尝试直连与加速镜像），可在「版本中心 → GitHub 加速代理」里切换线路或填入自定义代理: ${lastErr?.message || ''}`);
}
