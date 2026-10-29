// Cloudflare deployment engine for cloud-mail
// Implements the same REST flow as `wrangler deploy` for a Worker with a
// static assets directory:
//   1. create D1 / KV / (optional) R2 resources
//   2. assets-upload-session with a blake3 manifest of the assets dir
//   3. upload missing asset files (base64) with the session JWT
//   4. PUT the worker script (ESM module) with metadata that includes the
//      completion JWT in `assets.jwt` and an `{name:'assets', type:'assets'}`
//      binding, plus all plain_text vars / d1 / kv / r2 / ai / send_email
//   5. attach the custom domain + email routing catch-all
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import blake3 from '../vendor/blake3-inline.cjs';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(headers, method, pathName, body, isForm = false) {
  const res = await fetch(CF_API + pathName, {
    method,
    headers: isForm ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch {
    throw new Error(`CF API ${pathName}: 响应非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!j.success) throw new Error(`CF API ${pathName}: ${j.errors?.map(e => e.message).join('; ') || res.status}`);
  return j.result;
}

// blake3 hash identical to wrangler's: hash(base64(content) + extension).hex[0:32]
function hashAssetFile(filepath) {
  const contents = fs.readFileSync(filepath);
  const ext = path.extname(filepath).substring(1);
  const out = new Uint8Array(32);
  blake3.hash(Buffer.from(contents.toString('base64') + ext, 'utf8'), out);
  return Buffer.from(out).toString('hex').slice(0, 32);
}

function buildAssetManifest(dir) {
  const manifest = {};
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relPath = path.posix.join(rel, name.name);
      if (name.isDirectory()) walk(relPath);
      else if (!name.isSymbolicLink()) {
        const full = path.join(dir, relPath);
        // CF requires manifest keys to start with "/"
        manifest['/' + relPath.replace(/\\/g, '/')] = { hash: hashAssetFile(full), size: fs.statSync(full).size };
      }
    }
  };
  walk('');
  return manifest;
}

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.map': 'application/json',
  '.xml': 'application/xml', '.wasm': 'application/wasm'
};

export async function deployCloudMail(headers, accountId, domain, adminEmail, onStep, workerDistDir) {
  const step = (msg) => onStep?.(msg);
  const rnd = () => Math.random().toString(36).slice(2, 10);
  const jwtSecret = crypto.randomBytes(16).toString('hex');
  const workerName = `cloud-mail-${rnd()}`;

  // 1. D1
  step('创建 D1 数据库');
  const db = await cf(headers, 'POST', `/accounts/${accountId}/d1/database`, { name: `cloud-mail-${domain.replace(/\./g, '-')}-${rnd()}` });

  // 2. KV
  step('创建 KV 命名空间');
  const kv = await cf(headers, 'POST', `/accounts/${accountId}/storage/kv/namespaces`, { title: `cloud-mail-${rnd()}` });

  // 3. R2 (optional, ignore failure)
  let r2 = null;
  try {
    step('创建 R2 存储桶');
    r2 = await cf(headers, 'POST', `/accounts/${accountId}/r2/buckets`, { name: `cloud-mail-${rnd()}` });
  } catch { step('R2 创建跳过（可选）'); }

  // 4. assets upload session
  step('上传静态资源');
  const manifest = buildAssetManifest(workerDistDir);
  step(`静态资源 ${Object.keys(manifest).length} 个文件`);
  const session = await cf(headers, 'POST', `/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`, { manifest });
  let completionJwt = session.jwt;
  // CF returns buckets as [[hashStr,...],...] or [[{hash},...],...] depending on API version — accept both
  const missing = (session.buckets || []).flat().map(e => typeof e === 'string' ? { hash: e } : e).filter(e => e && e.hash);
  if (missing.length) {
    step(`需上传 ${missing.length} 个资源文件`);
    // hash → path index (case-insensitive compare, CF sometimes normalizes case)
    const byHash = new Map();
    for (const k of Object.keys(manifest)) byHash.set(manifest[k].hash.toLowerCase(), k.slice(1));
    const form = new FormData();
    for (const entry of missing) {
      const relPath = byHash.get(String(entry.hash).toLowerCase());
      if (!relPath) throw new Error(`静态资源清单缺少 hash ${entry.hash}（资源目录与清单不一致，请检查 data/worker-dist 完整性）`);
      const buf = fs.readFileSync(path.join(workerDistDir, relPath));
      form.append(entry.hash, new Blob([buf.toString('base64')], { type: MIME[path.extname(relPath)] || 'application/octet-stream' }), entry.hash);
    }
    const up = await fetch(`${CF_API}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST', headers: { ...headers, Authorization: `Bearer ${session.jwt}` }, body: form
    });
    const j = await up.json();
    if (!j.success) throw new Error('静态资源上传失败: ' + (j.errors?.map(e => e.message).join('; ') || up.status));
    completionJwt = j.result?.jwt || completionJwt;
  }

  // 5. bundle the worker entry and upload as ESM module with assets completion JWT
  step('上传 Worker');
  const workerJs = fs.readFileSync(path.join(workerDistDir, 'worker.js'));
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2025-06-04',
    bindings: [
      { type: 'd1', id: db.uuid, name: 'db' },
      { type: 'kv_namespace', namespace_id: kv.id, name: 'kv' },
      ...(r2 ? [{ type: 'r2_bucket', bucket_name: r2.name, name: 'r2' }] : []),
      { type: 'send_email', name: 'forward' },
      { type: 'ai', name: 'ai' },
      { type: 'assets', name: 'assets' },
      { type: 'plain_text', name: 'domain', text: JSON.stringify([domain]) },
      { type: 'plain_text', name: 'admin', text: adminEmail },
      { type: 'plain_text', name: 'jwt_secret', text: jwtSecret },
      { type: 'plain_text', name: 'ai_model', text: '' },
      { type: 'plain_text', name: 'analysis_cache', text: '' },
      { type: 'plain_text', name: 'project_link', text: '' }
    ],
    keep_bindings: ['plain_text', 'json'],
    assets: {
      jwt: completionJwt,
      config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: true }
    },
    observability: { enabled: true }
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('worker.js', new File([workerJs], 'worker.js', { type: 'application/javascript+module' }));
  await cf(headers, 'PUT', `/accounts/${accountId}/workers/scripts/${workerName}`, form, true);

  // 6. custom domain + email routing
  let siteUrl = null;
  const zone = await cf(headers, 'GET', `/zones?name=${domain}`);
  if (zone.length) {
    siteUrl = `https://${domain}`;
    step('绑定自定义域名');
    await cf(headers, 'PUT', `/accounts/${accountId}/workers/domains`,
      { zone_id: zone[0].id, hostname: domain, service: workerName, environment: 'production' }).catch(e => step(`域名绑定提示: ${e.message}`));
    step('配置 Email Routing catch-all');
    await cf(headers, 'PUT', `/zones/${zone[0].id}/email/routing/catch_all`, {
      matcher: { type: 'all' },
      actions: [{ type: 'worker', value: [workerName] }],
      enabled: true
    }).catch(e => step(`Email Routing 提示: ${e.message}`));
  } else {
    step('未找到 zone，跳过域名与邮件路由绑定');
  }

  return { success: true, siteUrl, workerName, jwtSecret, adminEmail };
}

// post-deploy: init DB, register the admin account (initial admin), lock down register switch
export async function initDeployedSite(siteUrl, adminEmail, adminPassword, jwtSecret, onStep) {
  const step = (msg) => onStep?.(msg);
  const base = siteUrl.replace(/\/+$/, '');

  // the custom domain was JUST attached — DNS/TLS can take a while to go
  // live, so retry the first contact with backoff before giving up
  step('初始化站点数据库 (/init)');
  let initText = '', initRes;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      initRes = await fetch(`${base}/init/${jwtSecret}`);
      initText = await initRes.text();
      if (initRes.ok && initText.includes('success')) break;
    } catch (e) {
      initText = e.message;
    }
    if (attempt < 6) {
      step(`站点尚未就绪，${10 * attempt} 秒后重试 (${attempt}/5)：${String(initText).slice(0, 60)}`);
      await wait(10000 * attempt);
    }
  }
  if (!initRes || !initRes.ok || !initText.includes('success')) {
    throw new Error(`初始化失败: ${initRes ? 'HTTP ' + initRes.status + ' ' : ''}${String(initText).slice(0, 100)}`);
  }

  // registration switch is open by default after init (setting.register = 0 open)
  step(`注册管理员 ${adminEmail}`);
  const regRes = await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  const regText = await regRes.text();
  let regJson; try { regJson = JSON.parse(regText); } catch { throw new Error(`注册响应异常: HTTP ${regRes.status} ${regText.slice(0, 100)}`); }
  if (regJson.code !== 200) throw new Error('管理员注册失败: ' + (regJson.message || regRes.status));

  step('登录并关闭公开注册');
  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  const loginJson = await loginRes.json();
  if (loginJson.code !== 200) throw new Error('管理员登录失败: ' + (loginJson.message || loginRes.status));
  const token = loginJson.data?.token || loginJson.data;
  await fetch(`${base}/api/setting/set`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ register: 1 })
  }).catch(e => step('关闭注册提示: ' + e.message));

  return { success: true, token };
}
