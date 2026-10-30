// One-click Cloudflare API reverse-proxy Worker (v0.6.0).
// Deploys a tiny passthrough Worker named onlycf-proxy into the user's OWN
// Cloudflare account, binds it to https://onlycf.<domain> (Workers Custom
// Domain), disables the *.workers.dev preview endpoint, and returns the
// final URL so the panel can fill it into the CF 加速代理 config. Quota and
// trust stay with the user; the panel never depends on a third-party relay.
//
// Flow (all calls via the user's stored credential headers):
//   1. PUT /accounts/{a}/workers/scripts/onlycf-proxy  (module worker)
//   2. PUT /accounts/{a}/workers/scripts/onlycf-proxy/subdomain  {enabled:false}
//   3. PUT /accounts/{a}/workers/domains  {hostname: onlycf.<domain>}
import { cfFetch, cfFormData } from './cf-proxy.js';
import db from '../db/index.js';

export const PROXY_WORKER_NAME = 'onlycf-proxy';
export const PROXY_HOST_PREFIX = 'onlycf.';

// the worker source: transparent api.cloudflare.com relay. ESM module worker.
const WORKER_SRC = `// onlycf — Cloudflare API reverse proxy (deployed by Mail Fleet Panel)
// Accepts both /client/v4/* and the panel's custom-prefix style
// /api.cloudflare.com/client/v4/*, forwarding to api.cloudflare.com.
// Anything else → 403.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    let p = url.pathname;
    if (p.indexOf('/api.cloudflare.com/') === 0) p = p.slice('/api.cloudflare.com'.length);
    if (p.indexOf('/client/v4') !== 0) {
      return new Response('forbidden', { status: 403 });
    }
    const target = 'https://api.cloudflare.com' + p + url.search;
    const headers = new Headers(request.headers);
    headers.set('Host', 'api.cloudflare.com');
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].indexOf(request.method) >= 0 ? undefined : request.body
    });
    const out = new Headers(res.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    return new Response(res.body, { status: res.status, headers: out });
  }
}
`;

function setting(key) {
  try { return db.prepare('SELECT value FROM panel_setting WHERE key = ?').get(key)?.value || null; }
  catch { return null; }
}

function setSetting(key, value) {
  db.prepare('INSERT INTO panel_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

async function cf(headers, method, pathName, body) {
  const res = await cfFetch('https://api.cloudflare.com/client/v4' + pathName, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json();
  if (!j.success) throw new Error(`CF API ${pathName}: ${j.errors?.map(e => e.message).join('; ') || res.status}`);
  return j.result;
}

export async function listZones(headers) {
  const r = await cf(headers, 'GET', '/zones?per_page=50&status=active');
  return (r || []).map(z => ({ id: z.id, name: z.name }));
}

export async function getProxyStatus(headers, accountId) {
  try {
    const sub = await cf(headers, 'GET', `/accounts/${accountId}/workers/scripts/${PROXY_WORKER_NAME}/subdomain`);
    return { deployed: true, workersDevEnabled: !!sub.enabled };
  } catch {
    return { deployed: false };
  }
}

// step(msg) reports progress; returns { url }
export async function deployProxyWorker(headers, accountId, domain, onStep) {
  const step = (msg) => onStep?.(msg);
  const zoneName = domain.replace(/^\./, '');
  const hostname = PROXY_HOST_PREFIX + zoneName;

  // zone must be hosted in this account (custom domains need its zone_id)
  const zones = await cf(headers, 'GET', `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!zones?.length) throw new Error(`域名 ${zoneName} 不在当前 Cloudflare 账号（或未托管到 Cloudflare）`);
  const zoneId = zones[0].id;

  step(`部署 API 反代 Worker（${PROXY_WORKER_NAME}）`);
  const metadata = {
    main_module: 'proxy.js',
    compatibility_date: '2025-01-01',
    bindings: [],
    migrations: { new_tag: 'v1' }
  };
  const form = await cfFormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append('proxy.js', new Blob([WORKER_SRC], { type: 'application/javascript+module' }), 'proxy.js');
  const res = await cfFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${PROXY_WORKER_NAME}`, {
    method: 'PUT', headers, body: form
  });
  const j = await res.json();
  if (!j.success) throw new Error('反代 Worker 上传失败: ' + (j.errors?.map(e => e.message).join('; ') || res.status));

  step('关闭 workers.dev 预览地址');
  try {
    await cf(headers, 'PUT', `/accounts/${accountId}/workers/scripts/${PROXY_WORKER_NAME}/subdomain`, { enabled: false });
  } catch (e) {
    step(`关闭 workers.dev 提示: ${e.message}`);
  }

  step(`绑定自定义域名 https://${hostname}`);
  await cf(headers, 'PUT', `/accounts/${accountId}/workers/domains`,
    { zone_id: zoneId, hostname, service: PROXY_WORKER_NAME, environment: 'production', override_existing_origin: true });

  const url = `https://${hostname}`;
  // auto-fill the CF 加速代理 config: custom mode + our URL
  setSetting('cf_proxy_mode', 'custom');
  setSetting('cf_proxy_url', url + '/');
  step('已自动填入「Cloudflare 加速代理」自定义地址（custom 模式）');
  return { url, hostname, workerName: PROXY_WORKER_NAME };
}

export function getCfProxyConfigPublic() {
  return { mode: setting('cf_proxy_mode') || 'auto', customUrl: setting('cf_proxy_url') || '' };
}
