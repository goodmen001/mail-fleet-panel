import db from '../db/index.js';
import { deployCloudMail } from '../services/deploy-service.js';

export default async function (app) {
  // start a batch deployment
  // body: { items: [{ credId, accountId?, domains: [{ domain, adminEmail }] }] }  (multi-account mode)
  //   OR legacy: { credId, domains: [string], adminEmail }   (single account, shared admin email)
  app.post('/start', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const body = req.body || {};
    // normalize to items list
    let items = [];
    if (Array.isArray(body.items) && body.items.length) {
      items = body.items;
    } else if (body.credId && Array.isArray(body.domains) && body.domains.length) {
      items = [{ credId: body.credId, accountId: body.accountId, domains: body.domains.map(d => ({ domain: d, adminEmail: body.adminEmail })) }];
    } else {
      return reply.code(400).send({ code: 400, message: 'credId + domains[] 必填（或使用 items 多账号模式）' });
    }

    const { getCredentialHeaders, getAccountId } = app;
    const records = [];
    const jobs = [];

    for (const item of items) {
      if (!item.credId || !Array.isArray(item.domains) || !item.domains.length) {
        return reply.code(400).send({ code: 400, message: '每个账号分组需要 credId 和 domains[]' });
      }
      const credRow = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(item.credId);
      if (!credRow) return reply.code(404).send({ code: 404, message: `凭证 ${item.credId} 不存在` });
      const headers = getCredentialHeaders(item.credId);
      const accountId = item.accountId || getAccountId(item.credId);
      if (!accountId) return reply.code(400).send({ code: 400, message: `凭证「${credRow.name}」缺少 Account ID` });

      for (const d of item.domains) {
        if (!d.domain || !d.adminEmail) {
          return reply.code(400).send({ code: 400, message: `域名 ${d.domain || '(空)'} 缺少域名或管理员邮箱` });
        }
        const id = db.prepare('INSERT INTO deploy_record (domain, cred_id, status, steps) VALUES (?,?,?,?)')
          .run(d.domain, item.credId, 'running', '[]').lastInsertRowid;
        records.push(id);
        jobs.push({ headers, accountId, domain: d.domain, adminEmail: d.adminEmail, recordId: id });
      }
    }

    // run async, log steps
    jobs.forEach(j => {
      const steps = [];
      deployCloudMail(j.headers, j.accountId, j.domain, j.adminEmail, msg => steps.push({ t: Date.now(), msg }))
        .then(() => {
          db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
            .run('success', JSON.stringify(steps), j.recordId);
        })
        .catch(e => {
          steps.push({ t: Date.now(), msg: '失败: ' + e.message });
          db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
            .run('failed', JSON.stringify(steps), j.recordId);
        });
    });

    return { code: 200, data: { deployIds: records, count: jobs.length }, message: `已启动 ${jobs.length} 个部署任务` };
  });

  app.get('/records', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT * FROM deploy_record ORDER BY deploy_id DESC LIMIT 100').all()
      .map(r => ({ ...r, steps: JSON.parse(r.steps || '[]') }));
    return { code: 200, data: list };
  });
}
