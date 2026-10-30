import db, { encrypt, decrypt } from '../db/index.js';

// data isolation: load a site and enforce ownership for non-admins
function ownedSite(app, req, siteId) {
  const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(siteId);
  if (!site) return { code: 404, message: '站点不存在' };
  if (req.user.role !== 'admin' && site.owner_id !== req.user.uid) return { code: 403, message: '无权访问该站点' };
  return { site };
}

function maskSite(s) {
  return { ...s, admin_password_enc: undefined, jwt_cache: undefined, hasPassword: !!s.admin_password_enc };
}

async function siteLogin(site) {
  const res = await fetch(`${site.base_url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: site.admin_email, password: decrypt(site.admin_password_enc) })
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`站点响应异常(HTTP ${res.status})，请检查地址是否正确`); }
  if (j.code !== 200) throw new Error(j.message || '登录失败');
  return j.data.token;
}

export default async function (app) {
  app.get('/list', { preHandler: [app.auth] }, async (req) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM site ORDER BY site_id').all()
      : db.prepare('SELECT * FROM site WHERE owner_id = ? ORDER BY site_id').all(req.user.uid);
    return { code: 200, data: rows.map(maskSite) };
  });

  app.post('/add', { preHandler: [app.auth] }, async (req, reply) => {
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
    db.prepare("INSERT INTO site (name, base_url, admin_email, admin_password_enc, cred_id, domain, worker_name, status, last_check, jwt_cache, owner_id) VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?)")
      .run(name, url, adminEmail, encrypt(adminPassword), credId || null, domain || null, workerName || null, 'online', token, req.user.uid);
    return { code: 200, message: '站点已接入' };
  });

  // edit: rename / change base url / change admin email, optionally reset the
  // admin password. Re-verifies the site login whenever any credential-affecting
  // field changes; clears the cached jwt so the next proxy call re-logins.
  app.put('/edit', { preHandler: [app.auth] }, async (req, reply) => {
    const siteId = Number(req.body?.siteId);
    const { name, baseUrl, adminEmail, adminPassword } = req.body || {};
    const o = ownedSite(app, req, siteId);
    if (o.code) return reply.code(o.code).send(o);
    const site = o.site;
    if (!name || !baseUrl || !adminEmail) {
      return reply.code(400).send({ code: 400, message: '名称、站点地址、管理员邮箱必填' });
    }
    const url = baseUrl.replace(/\/+$/, '');
    const password = adminPassword ? String(adminPassword) : null;
    const changed = url !== site.base_url || adminEmail !== site.admin_email || password;
    if (changed) {
      // probe + login with the (possibly new) credentials before saving
      try {
        const token = await siteLogin({
          base_url: url,
          admin_email: adminEmail,
          admin_password_enc: password ? encrypt(password) : site.admin_password_enc
        });
        db.prepare("UPDATE site SET name=?, base_url=?, admin_email=?, admin_password_enc=COALESCE(?, admin_password_enc), jwt_cache=?, status='online', last_check=datetime('now') WHERE site_id=?")
          .run(name, url, adminEmail, password ? encrypt(password) : null, token, siteId);
      } catch (e) {
        return reply.code(400).send({ code: 400, message: '站点连接/登录失败: ' + e.message });
      }
    } else {
      db.prepare('UPDATE site SET name=?, base_url=?, admin_email=? WHERE site_id=?').run(name, url, adminEmail, siteId);
    }
    return { code: 200, message: '站点已更新' };
  });

  app.delete('/delete', { preHandler: [app.auth] }, async (req, reply) => {
    const o = ownedSite(app, req, Number(req.query.siteId));
    if (o.code) return reply.code(o.code).send(o);
    db.prepare('DELETE FROM site WHERE site_id = ?').run(o.site.site_id);
    return { code: 200, message: '已删除' };
  });

  // health check
  app.post('/check/:siteId', { preHandler: [app.auth] }, async (req, reply) => {
    const o = ownedSite(app, req, Number(req.params.siteId));
    if (o.code) return reply.code(o.code).send(o);
    const site = o.site;
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
    const o = ownedSite(app, req, Number(req.params.siteId));
    if (o.code) return reply.code(o.code).send(o);
    try {
      const token = await siteLogin(o.site);
      return { code: 200, data: { token, baseUrl: o.site.base_url } };
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '站点登录失败: ' + e.message });
    }
  });

  // NOTE: no iframe auto-login bridge here. Cloud-mail reads its token from the
  // site origin's own localStorage, so a panel-origin bridge page cannot inject
  // it, and cross-origin iframes are blocked by browser storage partitioning.
  // The console opens the site directly in a new tab instead (see Sites.vue).

  // reveal admin password (for manual login on the site console)
  app.get('/password/:siteId', { preHandler: [app.auth] }, async (req, reply) => {
    const o = ownedSite(app, req, Number(req.params.siteId));
    if (o.code) return reply.code(o.code).send(o);
    const site = o.site;
    try {
      return { code: 200, data: { email: site.admin_email, password: decrypt(site.admin_password_enc) } };
    } catch {
      return reply.code(500).send({ code: 500, message: '密码解密失败' });
    }
  });

  // ---- unread badge: how many UNREAD receive-mails each site has ----
  // Uses the site's admin API /api/allEmail/list (brief columns already carry
  // the per-email `unread` flag) — one login, count locally, cache 30s so a
  // row of open consoles doesn't hammer every site on each poll.
  const unreadCache = new Map(); // siteId -> { at, unread }
  const UNREAD_TTL = 30 * 1000;
  app.get('/unread', { preHandler: [app.auth] }, async (req) => {
    const sites = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM site ORDER BY site_id').all()
      : db.prepare('SELECT * FROM site WHERE owner_id = ? ORDER BY site_id').all(req.user.uid);
    const now = Date.now();
    await Promise.all(sites.map(async s => {
      const c = unreadCache.get(s.site_id);
      if (c && now - c.at < UNREAD_TTL) return;
      try {
        let token = s.jwt_cache;
        const call = () => fetch(`${s.base_url}/api/allEmail/list?type=receive&size=50&full=0`, {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.status === 401 ? null : r.json());
        let j = await call();
        if (!j || j.code !== 200) {
          token = await siteLogin(s);
          db.prepare('UPDATE site SET jwt_cache=?, status=?, last_check=datetime(\'now\') WHERE site_id=?').run(token, 'online', s.site_id);
          j = await call();
        }
        unreadCache.set(s.site_id, { at: now, unread: j?.code === 200 ? (j.data.list || []).filter(e => e.unread === 0).length : null });
      } catch {
        unreadCache.set(s.site_id, { at: now, unread: null }); // offline / unreachable
      }
    }));
    return {
      code: 200,
      data: Object.fromEntries(sites.map(s => {
        const c = unreadCache.get(s.site_id);
        return [s.site_id, c ? c.unread : null];
      }))
    };
  });

  // generic API proxy to a site (for health/stats in panel UI)
  app.all('/proxy/:siteId/*', { preHandler: [app.auth] }, async (req, reply) => {
    const o = ownedSite(app, req, Number(req.params.siteId));
    if (o.code) return reply.code(o.code).send(o);
    const site = o.site;
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
