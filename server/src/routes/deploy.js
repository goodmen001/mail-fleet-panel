import db, { encrypt } from '../db/index.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deployCloudMail, initDeployedSite } from '../services/deploy-service.js';
import { credentialHeaders, accountIdOf } from './credential.js';

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

    const records = [];
    const jobs = [];

    for (const item of items) {
      if (!item.credId || !Array.isArray(item.domains) || !item.domains.length) {
        return reply.code(400).send({ code: 400, message: '每个账号分组需要 credId 和 domains[]' });
      }
      const credRow = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(item.credId);
      if (!credRow) return reply.code(404).send({ code: 404, message: `凭证 ${item.credId} 不存在` });
      const headers = credentialHeaders(item.credId);
      const accountId = item.accountId || accountIdOf(item.credId);
      if (!accountId) return reply.code(400).send({ code: 400, message: `凭证「${credRow.name}」缺少 Account ID` });

      for (const d of item.domains) {
        if (!d.domain || !d.adminEmail) {
          return reply.code(400).send({ code: 400, message: `域名 ${d.domain || '(空)'} 缺少域名或管理员邮箱` });
        }
        const id = db.prepare('INSERT INTO deploy_record (domain, cred_id, status, steps) VALUES (?,?,?,?)')
          .run(d.domain, item.credId, 'running', '[]').lastInsertRowid;
        records.push(id);
        jobs.push({ headers, accountId, domain: d.domain, adminEmail: d.adminEmail, credId: item.credId, recordId: id });
      }
    }

    // worker entry + assets dir ship next to the exe (data/worker-dist)
    const workerDist = process.env.WORKER_DIST || path.join(path.dirname(process.execPath), 'data', 'worker-dist');
    if (!fs.existsSync(workerDist) || !fs.existsSync(path.join(workerDist, 'worker.js'))) {
      return reply.code(400).send({ code: 400, message: '部署包缺失：exe 旁的 data/worker-dist 目录需包含 worker.js 和静态资源（请重新解压完整安装包）' });
    }

    // run async, log steps; on success auto-register admin + add to site manager
    jobs.forEach(j => {
      const steps = [];
      const step = (msg) => steps.push({ t: Date.now(), msg });
      (async () => {
        step('开始部署 ' + j.domain);
        const r = await deployCloudMail(j.headers, j.accountId, j.domain, j.adminEmail, step, workerDist);
        if (r.siteUrl) {
          // initial admin password for the new site
          const adminPassword = crypto.randomBytes(9).toString('base64url');
          try {
            await initDeployedSite(r.siteUrl, j.adminEmail, adminPassword, r.jwtSecret, step);
            step(`站点已自动接入站点管理；管理员 ${j.adminEmail} 初始密码: ${adminPassword}（请尽快登录修改）`);
            db.prepare(`INSERT INTO site (name, base_url, admin_email, admin_password_enc, cred_id, domain, worker_name, status, last_check, jwt_cache)
              VALUES (?,?,?,?,?,?,?,?,datetime('now'),?)`)
              .run(j.domain, r.siteUrl, j.adminEmail, encrypt(adminPassword), item_credId(j), j.domain, r.workerName, 'online', r.token || null);
          } catch (e) {
            step('自动注册/接入失败（站点本身已部署成功）: ' + e.message);
          }
        }
        db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
          .run('success', JSON.stringify(steps), j.recordId);
      })().catch(e => {
        step('失败: ' + e.message);
        db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
          .run('failed', JSON.stringify(steps), j.recordId);
      });
    });

    return { code: 200, data: { deployIds: records, count: jobs.length }, message: `已启动 ${jobs.length} 个部署任务` };
  });

  // helper: jobs carry credId directly
  function item_credId(j) { return j.credId; }

  app.get('/records', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT * FROM deploy_record ORDER BY deploy_id DESC LIMIT 100').all()
      .map(r => ({ ...r, steps: JSON.parse(r.steps || '[]') }));
    return { code: 200, data: list };
  });
}
