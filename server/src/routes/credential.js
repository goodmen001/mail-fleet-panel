import db, { encrypt, decrypt } from '../db/index.js';

function mask(row) {
  return { ...row, token: '••••••' + decrypt(row.token_enc).slice(-4), token_enc: undefined };
}

export default async function (app) {
  app.get('/list', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT cred_id, name, kind, account_id, create_time FROM cf_credential ORDER BY cred_id DESC').all();
    return { code: 200, data: list };
  });

  app.post('/add', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { name, kind, token, accountId } = req.body || {};
    if (!name || !token) return reply.code(400).send({ code: 400, message: '名称和凭证必填' });
    // verify against Cloudflare immediately
    const headers = kind === 'global_key'
      ? { 'X-Auth-Email': req.body.authEmail || '', 'X-Auth-Key': token }
      : { Authorization: `Bearer ${token}` };
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers }).catch(() => null);
    let accountChecked = null;
    if (res && res.ok) {
      const j = await res.json();
      if (!j.success && kind === 'token') {
        return reply.code(400).send({ code: 400, message: 'Cloudflare Token 校验失败：' + (j.errors?.[0]?.message || 'unknown') });
      }
      if (kind === 'global_key') {
        const v = await fetch('https://api.cloudflare.com/client/v4/user', { headers });
        const vj = await v.json();
        if (!vj.success) return reply.code(400).send({ code: 400, message: 'Global Key 校验失败' });
        accountChecked = accountId || null;
      }
    }
    if (kind !== 'global_key' && !res) {
      return reply.code(400).send({ code: 400, message: '无法连接 Cloudflare API' });
    }
    const r = db.prepare('INSERT INTO cf_credential (name, kind, token_enc, account_id) VALUES (?,?,?,?)')
      .run(name, kind === 'global_key' ? 'global_key' : 'token', encrypt(token), accountId || accountChecked);
    return { code: 200, data: { credId: r.lastInsertRowid }, message: '凭证已保存' };
  });

  app.delete('/delete', { preHandler: [app.auth, app.requireAdmin] }, async (req) => {
    db.prepare('DELETE FROM cf_credential WHERE cred_id = ?').run(req.query.credId);
    return { code: 200, message: '已删除' };
  });

  // internal helper for other modules
  app.getCredentialHeaders = (credId) => {
    const row = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(credId);
    if (!row) return null;
    const token = decrypt(row.token_enc);
    return row.kind === 'global_key'
      ? { 'X-Auth-Email': row.auth_email || '', 'X-Auth-Key': token }
      : { Authorization: `Bearer ${token}` };
  };
  app.getAccountId = (credId) => db.prepare('SELECT account_id FROM cf_credential WHERE cred_id = ?').get(credId)?.account_id;
}
