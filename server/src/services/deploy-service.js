// Cloudflare deployment engine for cloud-mail
// Ported from the manual wrangler/REST deploy flow.
import crypto from 'node:crypto';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(headers, method, path, body, isForm = false) {
  const res = await fetch(CF_API + path, {
    method,
    headers: isForm ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });
  const j = await res.json();
  if (!j.success) throw new Error(`CF API ${path}: ${j.errors?.map(e => e.message).join('; ') || res.status}`);
  return j.result;
}

export async function deployCloudMail(headers, accountId, domain, adminEmail, onStep) {
  const step = (msg) => onStep?.(msg);
  const rnd = () => Math.random().toString(36).slice(2, 10);
  const jwtSecret = crypto.randomBytes(16).toString("hex");

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

  // 4. get source zip from GitHub (built worker bundle) — use the project's deploy API
  step('获取 cloud-mail 源码包');
  // We upload a prebuilt worker bundle. The panel keeps a built bundle at data/bundles/worker.zip
  // and patches wrangler.jsonc with the new resource ids.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const bundlePath = process.env.WORKER_BUNDLE || '/app/data/bundles/worker.zip';
  if (!fs.existsSync(bundlePath)) throw new Error('未找到 worker 部署包，请先在版本中心构建/上传');

  // patch config inside bundle is handled by bundle-preparation step (version module)
  // worker name for later management
  const workerName = `cloud-mail-${rnd()}`;

  step('上传 Worker');
  const form = new FormData();
  const metadata = {
    main: 'worker.js',
    compatibility_date: '2024-09-23',
    bindings: [
      { type: 'd1', id: db.uuid, name: 'db' },
      { type: 'kv_namespace', id: kv.id, name: 'kv' },
      { type: 'plain_text', name: 'domain', text: JSON.stringify([domain]) },
      { type: 'plain_text', name: 'admin', text: adminEmail },
      { type: 'plain_text', name: 'jwt_secret', text: jwtSecret },
      { type: 'plain_text', name: 'r2domain', text: '' }
    ],
    ...(r2 ? { bindings_extra: [] } : {})
  };
  form.append('metadata', JSON.stringify(metadata));
  form.append('file', new Blob([fs.readFileSync(bundlePath)]), 'worker.zip');
  await cf(headers, 'PUT', `/accounts/${accountId}/workers/scripts/${workerName}`, form, true);

  step('绑定自定义域名');
  // workers domain
  let siteUrl = null;
  const zone = await cf(headers, 'GET', `/zones?name=${domain}`);
  if (zone.length) {
    siteUrl = `https://${domain}`;
    await cf(headers, 'PUT', `/accounts/${accountId}/workers/domains`,
      { zone_id: zone[0].id, hostname: domain, service: workerName, environment: 'production' }).catch(e => step(`域名绑定提示: ${e.message}`));
    // email routing
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

  step('初始化站点数据库 (/init)');
  const initRes = await fetch(`${base}/init/${jwtSecret}`).catch(e => { throw new Error('初始化请求失败: ' + e.message); });
  const initText = await initRes.text();
  if (!initRes.ok || !initText.includes('success')) throw new Error(`初始化失败: HTTP ${initRes.status} ${initText.slice(0, 100)}`);

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
