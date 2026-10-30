import db, { encrypt, dataDir } from '../db/index.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deployCloudMail, initDeployedSite, upgradeDeployedMail, findDeployedWorker, listMailWorkers, listWorkerCustomDomains, matchMailWorkerDeep } from '../services/deploy-service.js';
import { credentialHeaders, accountIdOf } from './credential.js';

// the built-in packages ship with the installation. They must NOT live under
// the data dir: a Docker volume mount (./data:/app/data) hides whatever the
// image put in /app/data, and users replacing/restoring data/ would lose the
// packages too — both surfaced as "部署包缺失：…data/worker-dist…". Search
// order: explicit env → install-dir builtin/ (exe: builtin next to the exe,
// docker: /app/builtin) → legacy data/<sub> (old installs still work) →
// repo-relative (dev checkout).
function builtinDist(sub) {
  const exeDir = process.env.PANEL_SEA ? path.dirname(process.execPath) : null;
  const candidates = [
    process.env[sub === 'official-dist' ? 'OFFICIAL_DIST' : 'WORKER_DIST'],
    exeDir && path.join(exeDir, 'builtin', sub),
    !process.env.PANEL_SEA && path.join(process.cwd(), 'builtin', sub),
    path.join(dataDir, sub),
    // dev mode: panel started from server/ while data lives at repo root
    path.join(process.cwd(), '..', 'data', sub)
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'worker.js'))) return dir;
  }
  return candidates[0];
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
  const isAdminCheck = (req) => req.user.role === 'admin';
  // preflight: which of these domains already have a cloud-mail worker on the
  // account (those will be UPGRADED in place instead of fresh-deployed).
  // Detection walks the account's Workers and reads their settings (d1+kv
  // signature = a cloud-mail site), so it also catches workers attached via
  // routes rather than custom domains.
  app.post('/check', { preHandler: [app.auth] }, async (req, reply) => {
    const { credId, accountId, domains } = req.body || {};
    if (!credId || !Array.isArray(domains)) return reply.code(400).send({ code: 400, message: 'credId + domains[] 必填' });
    const credRow = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').get(credId);
    if (!credRow) return reply.code(404).send({ code: 404, message: `凭证 ${credId} 不存在` });
    if (!isAdminCheck(req) && credRow.owner_id !== req.user.uid) return reply.code(403).send({ code: 403, message: '凭证不属于你' });
    const accId = accountId || accountIdOf(credId);
    if (!accId) return reply.code(400).send({ code: 400, message: '凭证缺少 Account ID' });
    // read all mail workers once for the whole batch (settings carry the
    // original config we will reuse when upgrading)
    const headers = credentialHeaders(credId);
    let mailWorkers = [];
    let customDomains = [];
    try {
      mailWorkers = await listMailWorkers(headers, accId);
      customDomains = await listWorkerCustomDomains(headers, accId);
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '读取 Workers 列表失败: ' + e.message });
    }
    const result = {};
    for (const d of domains) {
      // deep match: custom domains + zone routes + email routing rules + D1 names
      const m = await matchMailWorkerDeep(mailWorkers, customDomains, headers, accId, d);
      if (!m) { result[d] = { deployed: false }; continue; }
      // surface the existing deployment's config so the user can visually
      // confirm it is the right site before upgrading. jwt_secret is NEVER
      // returned — only a boolean readability flag.
      const b = m.settings.bindings || [];
      const plain = {};
      for (const x of b) if (x.type === 'plain_text') plain[x.name] = x.text;
      let domainsVar = null;
      try { domainsVar = JSON.parse(plain.domain || 'null'); } catch { /* keep raw null */ }
      // the site's ACTUAL access URL: prefer mail.<domain>, then the apex,
      // then any other sub-domain bound to this worker — deployments made with
      // an older panel / wrong root-domain input may live elsewhere, and the
      // preflight must not report mail.<domain> blindly.
      const zoneSuffix = '.' + d;
      const realDomains = customDomains.filter(x => x.service === m.workerName &&
        (x.hostname === `mail.${d}` || x.hostname === d || x.hostname.endsWith(zoneSuffix)))
        .map(x => x.hostname)
        .sort((a, b2) => (a === `mail.${d}` ? 0 : a === d ? 1 : 2) - (b2 === `mail.${d}` ? 0 : b2 === d ? 1 : 2));
      const siteDomain = realDomains[0] || `mail.${d}`;
      result[d] = {
        deployed: true,
        workerName: m.workerName,
        siteDomain,
        siteUrl: `https://${siteDomain}`,
        hasJwt: !!b.find(x => x.type === 'plain_text' && x.name === 'jwt_secret')?.text,
        // readable config summary
        admin: plain.admin || '',
        domains: Array.isArray(domainsVar) ? domainsVar : (plain.domain ? [plain.domain] : []),
        mailDomain: siteDomain,
        dbId: b.find(x => x.type === 'd1')?.id || '',
        kvId: b.find(x => x.type === 'kv_namespace')?.namespace_id || b.find(x => x.type === 'kv_namespace')?.id || '',
        r2Bucket: b.find(x => x.type === 'r2_bucket')?.bucket_name || '',
        hasSendEmail: b.some(x => x.type === 'send_email'),
        hasAi: b.some(x => x.type === 'ai'),
        compatDate: m.settings.compatibility_date || '',
        observability: !!(m.settings.observability?.enabled),
        // custom domains attached to THIS worker
        workerDomains: customDomains.filter(x => x.service === m.workerName).map(x => x.hostname)
      };
      // 拉取信息阶段即核对站点管理里的网址：旧部署可能不是 mail.<域名>（用错根
      // 账号域名等），发现不一致就只修正 site.base_url 这一个字段——邮件/用户/
      // 凭证/版本号等其它数据一律不动。无记录则跳过（升级部署后会再核对一次）。
      const actualUrl = `https://${siteDomain}`;
      const siteRows = db.prepare('SELECT site_id, base_url FROM site WHERE worker_name = ? OR domain = ?')
        .all(m.workerName, d);
      const fixes = [];
      for (const s of siteRows) {
        const normalized = (s.base_url || '').replace(/\/+$/, '');
        if (normalized !== actualUrl) {
          db.prepare('UPDATE site SET base_url = ? WHERE site_id = ?').run(actualUrl, s.site_id);
          fixes.push({ from: normalized || '(空)', to: actualUrl });
        }
      }
      if (fixes.length) result[d].siteUrlFixed = fixes;
    }
    return { code: 200, data: result };
  });

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

    // run async, log steps; fresh deploy auto-registers admin + adds to site
    // manager, an existing deployment is upgraded in place (data preserved)
    jobs.forEach(j => {
      const steps = [];
      const step = (msg) => steps.push({ t: Date.now(), msg });
      (async () => {
        step(`开始部署 ${j.domain}（部署包：${j.pkgName}${j.pkgTag ? ' ' + j.pkgTag : ''}）`);
        // already deployed? → in-place upgrade: reuse the SAME worker + bindings
        const existing = await findDeployedWorker(j.headers, j.accountId, j.domain);
        if (existing) {
          step(`检测到已部署的邮箱服务（Worker: ${existing.workerName}${existing.settings ? '，配置已读出' : ''}），进入升级模式：只更新邮局程序，原邮件/用户/配置数据不动`);
          const ur = await upgradeDeployedMail(j.headers, j.accountId, existing.workerName, j.pkgDir, step, existing.settings);
          // 升级后核对站点网址：早期可能用错根账号域名部署，站点管理里记录的
          // base_url 与 Worker 实际绑定的域名不符。只修正 site.base_url 这一个
          // 字段（按 worker_name 定位），邮件/用户/凭证/版本号等其它数据一律不动。
          const actualUrl = existing.siteUrl;
          const siteRows = db.prepare('SELECT site_id, base_url FROM site WHERE worker_name = ? OR domain = ?')
            .all(existing.workerName, j.domain);
          for (const s of siteRows) {
            const normalized = (s.base_url || '').replace(/\/+$/, '');
            if (normalized !== actualUrl) {
              db.prepare('UPDATE site SET base_url = ? WHERE site_id = ?').run(actualUrl, s.site_id);
              step(`站点网址已核对修正：${normalized || '(空)'} → ${actualUrl}（仅修正网址，其它数据未动）`);
            } else {
              step(`站点网址核对无误：${actualUrl}`);
            }
          }
          if (!siteRows.length) step(`站点管理中未找到该站点的记录，未做网址修正（实际地址：${actualUrl}）`);
          db.prepare('UPDATE deploy_record SET status=?, steps=? WHERE deploy_id=?')
            .run('success', JSON.stringify(steps), j.recordId);
          return;
        }
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
