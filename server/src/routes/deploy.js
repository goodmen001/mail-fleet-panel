import db from '../db/index.js';
import { deployCloudMail } from '../services/deploy-service.js';

export default async function (app) {
  // start a batch deployment: one credential, multiple domains
  app.post('/start', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { credId, domains, adminEmail } = req.body || {};
    if (!credId || !Array.isArray(domains) || !domains.length || !adminEmail) {
      return reply.code(400).send({ code: 400, message: 'credId, domains[], adminEmail 必填' });
    }
    const credRow = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(credId);
    if (!credRow) return reply.code(404).send({ code: 404, message: '凭证不存在' });

    const { getCredentialHeaders, getAccountId } = app;
    const headers = getCredentialHeaders(credId);
    const accountId = getAccountId(credId) || req.body.accountId;
    if (!accountId) return reply.code(400).send({ code: 400, message: '缺少 Account ID' });

    const records = domains.map(d =>
      db.prepare('INSERT INTO deploy_record (domain, cred_id, status, steps) VALUES (?,?,?,?)')
        .run(d, credId, 'running', '[]').lastInsertRowid
    );

    // run async, log steps
    domains.forEach((d, i) => {
      const steps = [];
      deployCloudMail(headers, accountId, d, adminEmail, msg => steps.push({ t: Date.now(), msg }))
        .then(() => {
          db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
            .run('success', JSON.stringify(steps), records[i]);
        })
        .catch(e => {
          steps.push({ t: Date.now(), msg: '失败: ' + e.message });
          db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
            .run('failed', JSON.stringify(steps), records[i]);
        });
    });

    return { code: 200, data: { deployIds: records }, message: '部署任务已启动' };
  });

  app.get('/records', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT * FROM deploy_record ORDER BY deploy_id DESC LIMIT 100').all()
      .map(r => ({ ...r, steps: JSON.parse(r.steps || '[]') }));
    return { code: 200, data: list };
  });
}
