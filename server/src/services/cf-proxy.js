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

// Cloudflare WAF sometimes answers the API with an HTML challenge/block page
// (HTTP 403, "<!doctype html>...Just a moment...") instead of JSON. Treating
// that as a normal response made deploys die with "响应非 JSON" even though
// the OTHER route (proxy ⇄ direct) would have succeeded. A block page is a
// property of the client IP + route, not of the request — so it means "this
// route is unusable", and cfFetch should fall through to the next target.
function isBlockPage(res, text) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const head = text.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

// a flaky custom proxy (self-hosted Worker reverse proxy) often fails the
// connection outright for a minority of requests — retry the SAME route a
// couple of times before giving up and falling to the next target
const PROXY_RETRIES = 2;

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
//
// route selection: a failure here does NOT always mean "try the other route" —
//   - transport error / timeout          → retry same route, then fall through
//   - HTML challenge page (CF WAF block) → fall through IMMEDIATELY (the page
//     is IP+route specific; retrying the same route just returns the same page)
//   - other HTTP responses (JSON incl. API errors) → valid answer, return it
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
    const target = prefix ? withPrefix(prefix, url) : url;
    const tries = prefix ? 1 + PROXY_RETRIES : 1;
    for (let t = 1; t <= tries; t++) {
      lastAttemptError = null;
      const res = await attempt(target, init, timeoutMs);
      if (!res) {
        // transport-level failure: same-route retry (flaky proxy), then next route
        lastErr = new Error(`请求失败: ${target}（${lastAttemptError}）`);
        if (t < tries) continue;
        break;
      }
      // got an HTTP response. A CF WAF block page (403 HTML) means THIS route's
      // egress IP is challenged — switch route right away instead of surfacing
      // the HTML to callers (which used to die parsing it as JSON).
      if (isBlockPage(res, '')) {
        // peek at the body to confirm it's really a block page before switching
        const clone = res.clone();
        const text = await clone.text().catch(() => '');
        if (isBlockPage(res, text)) {
          lastErr = new Error(`目标返回 Cloudflare 拦截页 (HTTP ${res.status}): ${target}`);
          break; // next route immediately — retrying this one repeats the block
        }
      }
      return res;
    }
  }
  throw new Error(
    `无法连接 Cloudflare API（直连与代理均失败）。可在「版本中心 → Cloudflare 加速代理」配置自建反代地址: ${lastErr?.message || ''}`
  );
}
