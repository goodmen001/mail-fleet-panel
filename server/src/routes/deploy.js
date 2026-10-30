import db, { encrypt } from '../db/index.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deployCloudMail, initDeployedSite } from '../services/deploy-service.js';
import { credentialHeaders, accountIdOf } from './credential.js';

// the built-in packages ship with the installation (exe: data/…-dist next to
// the exe; docker/node: /app/data/…-dist)
function builtinDist(sub) {
  const candidates = [
    process.env[sub === 'official-dist' ? 'OFFICIAL_DIST' : 'WORKER_DIST'],
    process.env.PANEL_SEA ? path.join(path.dirname(process.execPath), 'data', sub) : null,
    path.join(process.cwd(), 'data', sub),
    // dev mode: panel started from server/ while data lives at repo root
    path.join(process.cwd(), '..', 'data', sub)
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'worker.js'))) return dir;
  }
  return candidates[candidates.length - 1];
}

// resolve the deploy dir for a job: explicit pkgId from the version center,
// a built-in selector (-1 = 内置官方包), or the built-in custom worker-dist
function resolvePkgDir(pkgId) {
  if (pkgId === -1 || pkgId === '-1' || pkgId === 'builtin-official') {
    const dir = builtinDist('official-dist');
    if (!dir || !fs.existsSync(path.join(dir, 'worker.js'))) {
      return { err: '内置官方包缺失：data/official-dist 需包含 worker.js（请更新安装包或从版本中心导入官方包）' };
    }
    return { dir, pkgName: '内置官方包' };
  }
  if (pkgId) {
    const p = db.prepare('SELECT * FROM pkg_version WHERE pkg_id = ?').get(Number(pkgId));
    if (!p) return { err: `版本中心包 ${pkgId} 不存在` };
    if (!fs.existsSync(path.join(p.dir, 'worker.js'))) return { err: `包「${p.name}」数据缺失，请重新上传/导入` };
    return { dir: p.dir, pkgName: p.name, tag: p.tag };
  }
  const dir = builtinDist('worker-dist');
  if (!dir || !fs.existsSync(path.join(dir, 'worker.js'))) {
    return { err: '部署包缺失：exe 旁的 data/worker-dist 目录需包含 worker.js 和静态资源（请重新解压完整安装包）' };
  }
  return { dir, pkgName: '内置定制包' };
}

export default async function (app) {
  // start a batch deployment
  // body: { items: [{ credId, accountId?, pkgId?, domains: [{ domain, adminEmail }] }] }
  //   OR legacy: { credId, pkgId?, domains: [string], adminEmail }
  // pkgId omitted/null → built-in custom package (data/worker-dist)
  app.post('/start', { preHandler: [app.auth] }, async (req, reply) => {
    const body = req.body || {};
    const isAdmin = req.user.role === 'admin';
    const uid = req.user.uid;
    // normalize to items list
    let items = [];
    if (Array.isArray(body.items) && body.items.length) {
      items = body.items;
    } else if (body.credId && Array.isArray(body.domains) && body.domains.length) {
      items = [{ credId: body.credId, accountId: body.accountId, pkgId: body.pkgId, domains: body.domains.map(d => ({ domain: d, adminEmail: body.adminEmail })) }];
    } else {
      return reply.code(400).send({ code: 400, message: 'credId + domains[] 必填（或使用 items 多账号模式）' });
    }

    // validate all packages up front so one bad pkg doesn't start half a batch
    const pkgDirs = new Map();
    for (const item of items) {
      const key = item.pkgId === -1 || item.pkgId === '-1' ? 'builtin-official' : (item.pkgId || 0);
      if (!pkgDirs.has(key)) {
        const r = resolvePkgDir(item.pkgId);
        if (r.err) return reply.code(400).send({ code: 400, message: r.err });
        pkgDirs.set(key, r);
      }
    }

    const records = [];
    const jobs = [];

    for (const item of items) {
      if (!item.credId || !Array.isArray(item.domains) || !item.domains.length) {
        return reply.code(400).send({ code: 400, message: '每个账号分组需要 credId 和 domains[]' });
      }
      const credRow = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(item.credId);
      if (!credRow) return reply.code(404).send({ code: 404, message: `凭证 ${item.credId} 不存在` });
      // data isolation: users may only deploy with their own credentials
      if (!isAdmin && credRow.owner_id !== uid) {
        return reply.code(403).send({ code: 403, message: `凭证「${credRow.name}」不属于你` });
      }
      // invalid/stale token ciphertext would break the async job later — fail early
      if (!credRow.token_enc || !credRow.token_enc.includes(':')) {
        return reply.code(400).send({ code: 400, message: `凭证「${credRow.name}」数据异常，请重新编辑保存` });
      }
      const headers = credentialHeaders(item.credId);
      const accountId = item.accountId || accountIdOf(item.credId);
      if (!accountId) return reply.code(400).send({ code: 400, message: `凭证「${credRow.name}」缺少 Account ID` });

      for (const d of item.domains) {
        if (!d.domain || !d.adminEmail) {
          return reply.code(400).send({ code: 400, message: `域名 ${d.domain || '(空)'} 缺少域名或管理员邮箱` });
        }
        const id = db.prepare('INSERT INTO deploy_record (domain, cred_id, status, steps, owner_id, pkg_id) VALUES (?,?,?,?,?,?)')
          .run(d.domain, item.credId, 'running', '[]', uid, item.pkgId || null).lastInsertRowid;
        records.push(id);
        const pkg = pkgDirs.get(item.pkgId === -1 || item.pkgId === '-1' ? 'builtin-official' : (item.pkgId || 0));
        jobs.push({ headers, accountId, domain: d.domain, adminEmail: d.adminEmail, credId: item.credId, recordId: id, pkgDir: pkg.dir, pkgName: pkg.pkgName, pkgTag: pkg.tag });
      }
    }

    // run async, log steps; on success auto-register admin + add to site manager
    jobs.forEach(j => {
      const steps = [];
      const step = (msg) => steps.push({ t: Date.now(), msg });
      (async () => {
        step(`开始部署 ${j.domain}（部署包：${j.pkgName}${j.pkgTag ? ' ' + j.pkgTag : ''}）`);
        const r = await deployCloudMail(j.headers, j.accountId, j.domain, j.adminEmail, step, j.pkgDir);
        if (r.siteUrl) {
          // initial admin password for the new site
          const adminPassword = crypto.randomBytes(9).toString('base64url');
          try {
            await initDeployedSite(r.siteUrl, j.adminEmail, adminPassword, r.jwtSecret, step);
            step(`站点已自动接入站点管理；管理员 ${j.adminEmail} 初始密码: ${adminPassword}（请尽快登录修改）`);
            db.prepare(`INSERT INTO site (name, base_url, admin_email, admin_password_enc, cred_id, domain, worker_name, status, last_check, jwt_cache, owner_id)
              VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?)`)
              .run(j.domain, r.siteUrl, j.adminEmail, encrypt(adminPassword), j.credId, j.domain, r.workerName, 'online', r.token || null, req.user.uid);
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

  // records: admins see all, users only their own
  app.get('/records', { preHandler: [app.auth] }, async (req) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM deploy_record ORDER BY deploy_id DESC LIMIT 200').all()
      : db.prepare('SELECT * FROM deploy_record WHERE owner_id = ? ORDER BY deploy_id DESC LIMIT 200').all(req.user.uid);
    const list = rows.map(r => ({ ...r, steps: JSON.parse(r.steps || '[]') }));
    return { code: 200, data: list };
  });
}
