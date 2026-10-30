// Outbound HTTP proxy support (v0.6.0). Node's built-in fetch (undici) has no
// SOCKS support and ignores HTTP_PROXY/HTTPS_PROXY env vars by default, so
// users running v2ray/clash (socks5://127.0.0.1:1080) or a corporate HTTP proxy
// could not reach api.cloudflare.com / github.com at all.
//
// Setting key (panel_setting): out_proxy_url — empty = disabled; otherwise
//   http://  https:// [user:pass@]host:port   → undici ProxyAgent
//   socks5:// socks5h://                      → socks dial + TLS upgrade
// Env fallback when the setting is empty: HTTPS_PROXY / https_proxy /
// HTTP_PROXY / http_proxy.
//
// cf-proxy.js / gh-proxy.js pass getDispatcher() to fetch as `dispatcher`.
// undefined = direct. Verified E2E: fetch→SOCKS5→TLS (self-signed https echo
// server through a mock SOCKS5 hop) returns the body end-to-end.
import { ProxyAgent, Agent, fetch as undiciFetch } from 'undici';
import { SocksClient } from 'socks';
import tls from 'node:tls';
import db from '../db/index.js';

function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM panel_setting WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch { return null; }
}

const envFallback = () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (process.env[k]) return process.env[k];
  }
  return '';
};

// the URL the user explicitly configured (no env fallback) — ownership and
// isolation decisions must use this; env fallback only feeds getDispatcher
export function getConfiguredProxyUrl() {
  return (getSetting('out_proxy_url') || '').trim();
}

export function getOutProxyUrl() {
  const v = getConfiguredProxyUrl();
  if (v) return v;
  return envFallback();
}

export function setOutProxyUrl(url) {
  const u = (url || '').trim();
  if (u && !/^(https?|socks5h?):\/\//.test(u)) throw new Error('代理地址须以 http://、https://、socks5:// 或 socks5h:// 开头');
  db.prepare('INSERT INTO panel_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('out_proxy_url', u);
  // clearing the URL invalidates any recorded owner (v0.7.4 isolation)
  if (!u) db.prepare('DELETE FROM panel_setting WHERE key = ?').run('out_proxy_owner');
}

export function outProxyMode() {
  return getOutProxyUrl() ? 'proxy' : 'direct';
}

// ---- v0.7.4: per-user outbound proxy isolation ----
// Proxy URLs are secrets (host/user/pass), so a normal user may only see and
// manage the one they configured themselves. panel_setting keys:
//   out_proxy_owner  — JSON "uid" of the panel user who set the current URL
//   out_proxy_history — JSON [{ url, uid, removedAt }] of URLs auto-removed on
//     logout (recoverable later by the same user; admins see their own too)
const HISTORY_LIMIT = 10;

const readJson = (key, fallback) => {
  try {
    const raw = getSetting(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};
const writeJson = (key, val) =>
  db.prepare('INSERT INTO panel_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(val));

export function getOutProxyOwner() {
  return readJson('out_proxy_owner', null); // uid or null
}

// history entries visible to this user (own entries; masked for the listing)
export function getOutProxyHistory(uid) {
  return readJson('out_proxy_history', [])
    .filter(h => h.uid === uid)
    .map(h => ({ id: h.id, url: maskProxyUrl(h.url), removedAt: h.removedAt }));
}

export function maskProxyUrl(url) {
  // socks5://user:pass@host:port → socks5://user:•••@host:port
  return String(url).replace(/(:\/\/[^:/@]+:)([^@/]+)@/, '$1•••@');
}

export function setOutProxyOwner(uid) {
  writeJson('out_proxy_owner', uid);
}

// logout: if the CURRENT proxy belongs to this user, remove it and push it to
// history so they can restore it on the next login
export function clearOwnedProxy(uid) {
  const owner = getOutProxyOwner();
  // env-fallback proxies are machine-level config, not owned by a user —
  // only an explicitly configured proxy can be auto-removed on logout
  if (owner !== uid || !getConfiguredProxyUrl()) return false;
  const url = getConfiguredProxyUrl();
  if (url) {
    const hist = readJson('out_proxy_history', []);
    const entry = { id: Date.now(), url, uid, removedAt: new Date().toISOString() };
    // dedupe by url+uid — keep the newest position
    writeJson('out_proxy_history', [entry, ...hist.filter(h => !(h.uid === uid && h.url === url))].slice(0, HISTORY_LIMIT));
    setOutProxyUrl(''); // also clears the owner (stale owner with no URL is meaningless)
  } else {
    setOutProxyUrl('');
  }
  return true;
}

// restore a history entry (by id) as the current proxy
export function restoreOutProxy(uid, id) {
  const hist = readJson('out_proxy_history', []);
  const hit = hist.find(h => h.uid === uid && h.id === id);
  if (!hit) throw new Error('历史代理不存在或已删除');
  setOutProxyUrl(hit.url);
  setOutProxyOwner(uid);
  // it is now the active proxy again — drop it from history
  writeJson('out_proxy_history', hist.filter(h => !(h.uid === uid && h.id === id)));
}

export function deleteOutProxyHistory(uid, id) {
  const hist = readJson('out_proxy_history', []);
  writeJson('out_proxy_history', hist.filter(h => !(h.uid === uid && h.id === id)));
}

// socks5h = DNS resolves at the proxy (best for polluted resolvers); plain
// socks5 resolves locally. socks:// treated as socks5.
function parseSocksUrl(url) {
  const m = url.match(/^(socks5h?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+):(\d+)\/?$/);
  if (!m) throw new Error(`无法解析 SOCKS5 代理地址: ${url}`);
  return {
    type: 5,
    host: m[4],
    port: Number(m[5]),
    userId: m[2] || undefined,
    password: m[3] || undefined,
    lookup: m[1] === 'socks5h' // socks5h → proxy resolves the hostname
  };
}

class SocksDispatcher extends Agent {
  constructor(opts = {}) {
    // undici's Agent reads the `connect` OPTION in its constructor (defaulting
    // to buildConnector) — overriding the connect() METHOD on a subclass is
    // silently ignored and requests fall back to a direct connection (seen as
    // "Connect Timeout Error (attempted addresses: …)" on blocked networks).
    // So the socks dial must be handed to super() as the connect option.
    super({ ...opts, connect: (o, cb) => this.socksConnect(o, cb) });
  }

  socksConnect(opts, cb) {
    let p;
    try { p = parseSocksUrl(cachedUrl); } catch (e) { return cb(e, null); }
    // undici passes port as an empty string when the URL has no explicit one —
    // the default buildConnector defaults it to 443/80, so mirror that here
    // (Number('') is NaN and the socks dial would hang forever)
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    // unauthenticated → skip local lookup when the proxy can resolve (socks5h);
    // socks library needs a destination host:port — for socks5 with a polluted
    // resolver we still pass the hostname and let the proxy resolve it
    // (type 5 ATYP=domain). lookup:false = resolve locally first.
    SocksClient.createConnection({
      proxy: { host: p.host, port: p.port, type: 5, userId: p.userId, password: p.password },
      command: 'connect',
      // pass hostname straight through (ATYP=domain) for both variants — the
      // proxy resolves it when lookup is remote; socks lib handles DNS locally
      // when given an IP. Resolving here would fail on polluted networks, so
      // always send the hostname.
      destination: { host: opts.hostname, port },
      timeout: 15000
    })
      .then((info) => {
        const sock = info.socket;
        if (opts.protocol !== 'https:') return cb(null, sock);
        const tlsSock = tlsConnect(sock, opts);
        tlsSock.once('secureConnect', () => cb(null, tlsSock));
        tlsSock.once('error', (e) => cb(e, null));
      })
      .catch((e) => cb(new Error(`SOCKS5 代理连接失败: ${e.message}`), null));
  }
}

function tlsConnect(sock, opts) {
  return tls.connect({
    socket: sock,
    servername: opts.servername || opts.hostname,
    rejectUnauthorized: opts.rejectUnauthorized !== false,
    ...opts.tls
  });
}

let cachedUrl = null;
let cachedDispatcher = null;

// undici dispatcher for fetch({ dispatcher }); undefined = direct.
export function getDispatcher() {
  const url = getOutProxyUrl();
  if (!url) return undefined;
  if (url === cachedUrl && cachedDispatcher) return cachedDispatcher;
  const dispatcher = /^socks5h?:\/\//.test(url)
    ? new SocksDispatcher()
    : new ProxyAgent({ uri: url });
  cachedUrl = url;
  cachedDispatcher = dispatcher;
  return dispatcher;
}

export async function testOutProxy(testUrl = 'https://api.cloudflare.com/client/v4', timeoutMs = 12000) {
  const url = getOutProxyUrl();
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const dispatcher = url ? getDispatcher() : undefined;
    const res = await undiciFetch(testUrl, { signal: ctrl.signal, dispatcher });
    const ms = Date.now() - started;
    // the probe URL has no token, so CF answers 404/401 with its own JSON —
    // any HTTP response (even non-2xx) proves the proxy path works end-to-end
    return { ok: res.status < 500, status: res.status, ms, via: url || 'direct' };
  } catch (e) {
    return { ok: false, error: e.cause?.message || e.message, via: url || 'direct' };
  } finally {
    clearTimeout(timer);
  }
}
