// Cloudflare API access gateway (v0.4.0) — same shape as gh-proxy.js.
// api.cloudflare.com is blocked/unstable on many mainland networks, which made
// 凭证保存/域名拉取/部署 fail with "无法连接 Cloudflare API" even with valid
// credentials. Modes (setting cf_proxy_mode):
//   direct  → api.cloudflare.com as-is
//   custom  → user-supplied prefix that transparently proxies the CF API
//             (same style as the GitHub mirrors: <prefix>/client/v4/…)
//   auto    → try custom prefix if configured, then direct (default)
// Cloudflare does not publish public API mirrors, so there is no mirror list —
// users who need a proxy run their own (e.g. a CF Worker reverse proxy).
import db from '../db/index.js';
import { fetch as undiciFetch } from 'undici';
// dispatcher must pair with undici's own fetch — the Node built-in fetch is a
// different undici copy and rejects foreign dispatchers with
// "invalid onRequestStart method"
import { getDispatcher } from './out-proxy.js';

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

export function getCfConfig() {
  return {
    mode: getSetting('cf_proxy_mode') || 'auto',
    customUrl: getSetting('cf_proxy_url') || ''
  };
}

export function setCfConfig({ mode, customUrl }) {
  if (mode !== undefined) {
    if (!['auto', 'direct', 'custom'].includes(mode)) throw new Error('mode 须为 auto|direct|custom');
    setSetting('cf_proxy_mode', mode);
  }
  if (customUrl !== undefined) {
    const u = (customUrl || '').trim();
    if (u && !/^https?:\/\//.test(u)) throw new Error('代理地址须以 http(s):// 开头');
    setSetting('cf_proxy_url', u.replace(/\/?$/, u ? '/' : ''));
  }
}

function withPrefix(prefix, url) {
  return prefix + url.replace(/^https?:\/\//, '');
}

// attempt() must surface WHY it failed: callers used to see only the URL, so
// "直连与代理均失败" gave no clue whether it was the timeout, a refused
// connection, or TLS reset — unfixable from the user side without that.
function errInfo(e, timeoutMs) {
  if (!e) return '未知错误';
  if (e.name === 'AbortError' || e.name === 'TimeoutError') {
    return `超时（${Math.round(timeoutMs / 1000)}s 内未完成）`;
  }
  const cause = e.cause?.message || e.cause?.code || '';
  return e.message + (cause && cause !== e.message ? ` (${cause})` : '');
}

async function attempt(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await undiciFetch(url, { ...init, signal: ctrl.signal, dispatcher: getDispatcher() });
  } catch (e) {
    lastAttemptError = errInfo(e, timeoutMs);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// why the most recent attempt() failed — cfFetch folds this into its error
let lastAttemptError = null;

// multipart bodies for the CF Workers upload API must use undici's own
// FormData: npm undici's fetch cannot serialize the Node built-in FormData —
// it stringifies the whole thing to "[object FormData]" with Content-Type
// text/plain, and CF rejects it with "Content-Type must be one of:
// application/javascript, text/javascript, multipart/form-data". Node's Blob
// is fine as the part source (verified: correct boundary + part content types).
export async function cfFormData() {
  const { FormData } = await import('undici');
  return new FormData();
}

// single entry point for every api.cloudflare.com call in the panel.
// Only https://api.cloudflare.com URLs are routed; other hosts pass through.
//
// timeoutMs: callers MAY pass a larger value for large-body calls. The
// Workers assets upload sends all missing files in ONE multipart POST (can be
// 10-15MB for cloud-mail's 71-file dist); measured through a CF-Worker reverse
// proxy that is ~3s/MB, i.e. 40s+ — a plain 30s timeout killed the request
// mid-flight and deploy reported "无法连接 Cloudflare API" although small
// calls (token verify, asset-upload-session) succeeded seconds earlier.
export async function cfFetch(url, init = {}, { timeoutMs = 30000 } = {}) {
  if (!url.startsWith('https://api.cloudflare.com/')) return undiciFetch(url, init);
  const cfg = getCfConfig();
  const targets = [];
  if (cfg.mode === 'direct') targets.push(null);
  else if (cfg.mode === 'custom' && cfg.customUrl) targets.push(cfg.customUrl);
  else { // auto: custom proxy first (when set), then direct
    if (cfg.customUrl) targets.push(cfg.customUrl);
    targets.push(null);
  }
  let lastErr = null;
  for (const prefix of targets) {
    lastAttemptError = null;
    const target = prefix ? withPrefix(prefix, url) : url;
    const res = await attempt(target, init, timeoutMs);
    if (res) return res;
    lastErr = new Error(`请求失败: ${target}（${lastAttemptError}）`);
  }
  throw new Error(
    `无法连接 Cloudflare API（直连与代理均失败）。可在「版本中心 → Cloudflare 加速代理」配置自建反代地址: ${lastErr?.message || ''}`
  );
}
