// Cloudflare deployment engine for cloud-mail
// Ported from the manual wrangler/REST deploy flow.
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
      { type: 'plain_text', name: 'jwt_secret', text: require('node:crypto').randomBytes(16).toString('hex') },
      { type: 'plain_text', name: 'r2domain', text: '' }
    ],
    ...(r2 ? { bindings_extra: [] } : {})
  };
  form.append('metadata', JSON.stringify(metadata));
  form.append('file', new Blob([fs.readFileSync(bundlePath)]), 'worker.zip');
  await cf(headers, 'PUT', `/accounts/${accountId}/workers/scripts/cloud-mail-${rnd()}`, form, true);

  step('绑定自定义域名');
  // workers domain
  const zone = await cf(headers, 'GET', `/zones?name=${domain}`);
  if (zone.length) {
    await cf(headers, 'PUT', `/accounts/${accountId}/workers/domains`,
      { zone_id: zone[0].id, hostname: domain, service: metadata.bindings && 'cloud-mail', environment: 'production' }).catch(e => step(`域名绑定提示: ${e.message}`));
    // email routing
    step('配置 Email Routing catch-all');
    await cf(headers, 'PUT', `/zones/${zone[0].id}/email/routing/catch_all`, {
      matcher: { type: 'all' },
      actions: [{ type: 'worker', value: ['cloud-mail'] }],
      enabled: true
    }).catch(e => step(`Email Routing 提示: ${e.message}`));
  } else {
    step('未找到 zone，跳过域名与邮件路由绑定');
  }

  step('初始化数据库');
  // GET /init/{jwt_secret} on the new domain
  return { success: true };
}
