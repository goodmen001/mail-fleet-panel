import db, { encrypt, decrypt } from '../db/index.js';

function maskSite(s) {
  return { ...s, admin_password_enc: undefined, jwt_cache: undefined, hasPassword: !!s.admin_password_enc };
}

async function siteLogin(site) {
  const res = await fetch(`${site.base_url}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: site.admin_email, password: decrypt(site.admin_password_enc) })
  });
  const j = await res.json();
  if (j.code !== 200) throw new Error(j.message || '登录失败');
  return j.data.token;
}

export default async function (app) {
  app.get('/list', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT * FROM site ORDER BY site_id').all().map(maskSite);
    return { code: 200, data: list };
  });

  app.post('/add', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { name, baseUrl, adminEmail, adminPassword, credId, domain, workerName } = req.body || {};
    if (!name || !baseUrl || !adminEmail || !adminPassword) {
      return reply.code(400).send({ code: 400, message: '名称、地址、管理员邮箱、密码必填' });
    }
    const url = baseUrl.replace(/\/+$/, '');
    // probe + login
    let token = null;
    try {
      token = await siteLogin({ base_url: url, admin_email: adminEmail, admin_password_enc: encrypt(adminPassword) });
    } catch (e) {
      return reply.code(400).send({ code: 400, message: '站点连接/登录失败: ' + e.message });
    }
    db.prepare("INSERT INTO site (name, base_url, admin_email, admin_password_enc, cred_id, domain, worker_name, status, last_check, jwt_cache) VALUES (?,?,?,?,?,?,?,?,datetime('now'),?)")
      .run(name, url, adminEmail, encrypt(adminPassword), credId || null, domain || null, workerName || null, 'online', token);
    return { code: 200, message: '站点已接入' };
  });

  app.delete('/delete', { preHandler: [app.auth, app.requireAdmin] }, async (req) => {
    db.prepare('DELETE FROM site WHERE site_id = ?').run(req.query.siteId);
    return { code: 200, message: '已删除' };
  });

  // health check
  app.post('/check/:siteId', { preHandler: [app.auth] }, async (req) => {
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(req.params.siteId);
    if (!site) return { code: 404 };
    let status = 'offline';
    try {
      const token = await siteLogin(site);
      status = 'online';
      db.prepare("UPDATE site SET status=?, last_check=datetime('now'), jwt_cache=? WHERE site_id=?").run(status, token, site.site_id);
    } catch {
      db.prepare("UPDATE site SET status=?, last_check=datetime('now') WHERE site_id=?").run(status, site.site_id);
    }
    return { code: 200, data: { status } };
  });

  // proxy: get a fresh token for iframe auto-login
  app.post('/console/:siteId/token', { preHandler: [app.auth] }, async (req, reply) => {
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(req.params.siteId);
    if (!site) return reply.code(404).send({ code: 404 });
    try {
      const token = await siteLogin(site);
      return { code: 200, data: { token, baseUrl: site.base_url } };
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '站点登录失败: ' + e.message });
    }
  });

  // auto-login bridge page: sets site token in localStorage then redirects inside iframe
  app.get('/console/:siteId/console.html', { preHandler: [app.auth] }, async (req, reply) => {
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(req.params.siteId);
    if (!site) return reply.code(404).send();
    let token;
    try { token = await siteLogin(site); } catch (e) { return reply.code(502).send('site login failed'); }
    db.prepare('UPDATE site SET jwt_cache=? WHERE site_id=?').run(token, site.site_id);
    reply.type('text/html').send(`<!DOCTYPE html><html><body><script>
      try { localStorage.setItem('token', ${JSON.stringify(token)}); } catch(e) {}
      location.replace(${JSON.stringify(site.base_url)});
    <\/script></body></html>`);
  });

  // generic API proxy to a site (for health/stats in panel UI)
  app.all('/proxy/:siteId/*', { preHandler: [app.auth] }, async (req, reply) => {
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(req.params.siteId);
    if (!site) return reply.code(404).send({ code: 404 });
    let token = site.jwt_cache;
    const target = site.base_url + '/' + req.params['*'] + (req.raw.url.includes('?') ? '?' + req.raw.url.split('?')[1] : '');
    const res = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: ['POST', 'PUT', 'DELETE'].includes(req.method) ? JSON.stringify(req.body) : undefined
    });
    const text = await res.text();
    if (res.status === 401) {
      // re-login and retry once
      try {
        token = await siteLogin(site);
        db.prepare('UPDATE site SET jwt_cache=? WHERE site_id=?').run(token, site.site_id);
        const r2 = await fetch(target, {
          method: req.method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: ['POST', 'PUT', 'DELETE'].includes(req.method) ? JSON.stringify(req.body) : undefined
        });
        return reply.code(r2.status).send(await r2.text());
      } catch { /* fallthrough */ }
    }
    reply.code(res.status);
    return text;
  });
}
