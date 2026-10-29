import db, { encrypt, decrypt } from '../db/index.js';

function mask(row) {
  return { ...row, token: '••••••' + decrypt(row.token_enc).slice(-4), token_enc: undefined };
}

// shared credential helpers — exported so any route module can use them
// (fastify plugin encapsulation makes app-decorated props invisible to
// sibling plugins, which broke deploy's getCredentialHeaders)
export function credentialHeaders(credId) {
  const row = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(Number(credId) || 0);
  if (!row) return null;
  const token = decrypt(row.token_enc).trim();
  return row.kind === 'global_key'
    ? { 'X-Auth-Email': (row.auth_email || '').trim(), 'X-Auth-Key': token }
    : { Authorization: `Bearer ${token}` };
}
export const accountIdOf = (credId) =>
  db.prepare('SELECT account_id FROM cf_credential WHERE cred_id = ?').get(Number(credId) || 0)?.account_id;

// fetch the account id for a credential when the user left it blank:
// tokens list /accounts; global keys use /accounts with X-Auth headers
async function fetchAccountId(headers, kind) {
  const url = kind === 'global_key'
    ? 'https://api.cloudflare.com/client/v4/accounts?per_page=5'
    : 'https://api.cloudflare.com/client/v4/accounts?per_page=5';
  const res = await fetch(url, { headers });
  const j = await res.json();
  if (!j?.success || !j.result?.length) return null;
  return j.result[0].id;
}

export default async function (app) {
  app.get('/list', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT cred_id AS credId, name, kind, account_id AS accountId, auth_email AS authEmail, create_time FROM cf_credential ORDER BY cred_id DESC').all();
    return { code: 200, data: list };
  });

  app.post('/add', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { name, kind, token, accountId, authEmail } = req.body || {};
    if (!name || !token) return reply.code(400).send({ code: 400, message: '名称和凭证必填' });
    if (kind === 'global_key' && !authEmail) {
      return reply.code(400).send({ code: 400, message: 'Global API Key 需要同时填写注册邮箱（Cloudflare 账号登录邮箱）' });
    }
    const tk = String(token).trim();
    // verify against Cloudflare immediately
    const headers = kind === 'global_key'
      ? { 'X-Auth-Email': String(authEmail).trim(), 'X-Auth-Key': tk }
      : { Authorization: `Bearer ${tk}` };
    const verifyUrl = kind === 'global_key'
      ? 'https://api.cloudflare.com/client/v4/user'
      : 'https://api.cloudflare.com/client/v4/user/tokens/verify';
    let j = null;
    try {
      const res = await fetch(verifyUrl, { headers });
      j = await res.json();
    } catch { return reply.code(400).send({ code: 400, message: '无法连接 Cloudflare API' }); }
    if (!j?.success) {
      const label = kind === 'global_key' ? 'Global Key 校验失败' : 'Cloudflare Token 校验失败';
      return reply.code(400).send({ code: 400, message: label + '：' + (j?.errors?.[0]?.message || '响应异常') });
    }
    // auto-fill Account ID from CF when the user left it blank
    let acct = (accountId || '').trim();
    if (!acct) acct = await fetchAccountId(headers, kind);
    const r = db.prepare('INSERT INTO cf_credential (name, kind, token_enc, account_id, auth_email) VALUES (?,?,?,?,?)')
      .run(name, kind === 'global_key' ? 'global_key' : 'token', encrypt(tk), acct, kind === 'global_key' ? String(authEmail).trim() : null);
    return { code: 200, data: { credId: r.lastInsertRowid }, message: acct ? '凭证已保存' : '凭证已保存（未获取到 Account ID，请在编辑中补充）' };
  });

  // edit: rename, re-enter token/key, set Account ID / auth email.
  // Token verify + account auto-fill run only when a new token is provided.
  app.put('/edit', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const credId = Number(req.body?.credId);
    const { name, token, accountId, authEmail } = req.body || {};
    const row = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(credId);
    if (!row) return reply.code(404).send({ code: 404, message: '凭证不存在' });
    if (!name) return reply.code(400).send({ code: 400, message: '名称必填' });

    const kind = row.kind;
    const newToken = token ? String(token).trim() : null;
    let acct = (accountId || '').trim();

    if (newToken) {
      const headers = kind === 'global_key'
        ? { 'X-Auth-Email': String(authEmail || row.auth_email || '').trim(), 'X-Auth-Key': newToken }
        : { Authorization: `Bearer ${newToken}` };
      const verifyUrl = kind === 'global_key'
        ? 'https://api.cloudflare.com/client/v4/user'
        : 'https://api.cloudflare.com/client/v4/user/tokens/verify';
      let j = null;
      try {
        const res = await fetch(verifyUrl, { headers });
        j = await res.json();
      } catch { return reply.code(400).send({ code: 400, message: '无法连接 Cloudflare API' }); }
      if (!j?.success) {
        const label = kind === 'global_key' ? 'Global Key 校验失败' : 'Cloudflare Token 校验失败';
        return reply.code(400).send({ code: 400, message: label + '：' + (j?.errors?.[0]?.message || '响应异常') });
      }
      if (!acct) acct = await fetchAccountId(headers, kind);
    }

    db.prepare('UPDATE cf_credential SET name=?, token_enc=COALESCE(?, token_enc), account_id=?, auth_email=? WHERE cred_id=?')
      .run(name, newToken ? encrypt(newToken) : null, acct || row.account_id,
        kind === 'global_key' ? (authEmail ? String(authEmail).trim() : row.auth_email) : row.auth_email, credId);
    return { code: 200, message: '凭证已更新' };
  });

  app.delete('/delete', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const credId = Number(req.query.credId);
    if (!credId) return reply.code(400).send({ code: 400, message: 'credId 必填' });
    db.prepare('DELETE FROM cf_credential WHERE cred_id = ?').run(credId);
    return { code: 200, message: '已删除' };
  });

  // auto-fetch domains (zones) under a credential, to feed the deploy center
  app.get('/zones', { preHandler: [app.auth] }, async (req, reply) => {
    const credId = Number(req.query.credId);
    if (!credId) return reply.code(400).send({ code: 400, message: 'credId 必填' });
    const headers = credentialHeaders(credId);
    if (!headers) return reply.code(404).send({ code: 404, message: '凭证不存在' });
    const accountId = accountIdOf(credId);
    try {
      let url = 'https://api.cloudflare.com/client/v4/zones?per_page=50';
      if (accountId) url += `&account.id=${accountId}`;
      const res = await fetch(url, { headers });
      const j = await res.json();
      if (!j.success) return reply.code(502).send({ code: 502, message: '拉取域名失败: ' + (j.errors?.[0]?.message || res.status) });
      return { code: 200, data: j.result.map(z => ({ name: z.name, status: z.status, accountId: z.account?.id, accountName: z.account?.name })) };
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '无法连接 Cloudflare: ' + e.message });
    }
  });
}
