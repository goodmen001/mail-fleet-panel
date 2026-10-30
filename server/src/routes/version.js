import db, { dataDir } from '../db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import { ghFetch, getGhConfig, setGhConfig, KNOWN_MIRRORS } from '../services/gh-proxy.js';
import { getCfConfig, setCfConfig } from '../services/cf-proxy.js';
import { getOutProxyUrl, setOutProxyUrl, outProxyMode, testOutProxy } from '../services/out-proxy.js';
import { listZones, deployProxyWorker, getProxyStatus, PROXY_HOST_PREFIX } from '../services/onlycf-proxy.js';
import { credentialHeaders, accountIdOf } from './credential.js';

const REPO = 'maillab/cloud-mail';
const BRANCH = 'main';
// fallback when APP_VERSION env is absent (dev mode): package.json lives two levels
// above the data dir in dev (server/data → server/../package.json) and next to the
// exe's data dir in SEA builds (env APP_VERSION is set there anyway)
const APP_VERSION = (() => {
  const candidates = [
    process.env.PANEL_SEA ? path.join(path.dirname(process.execPath), 'package.json') : null,
    path.join(dataDir, '..', '..', 'package.json')
  ].filter(Boolean);
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch { /* next */ }
  }
  return null;
})();

const GH_HEADERS = () => ({
  'User-Agent': 'mail-fleet-panel',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
});

async function gh(path) {
  const res = await ghFetch(`https://api.github.com/repos/${REPO}/${path}`, { headers: GH_HEADERS() });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return res.json();
}

// same but against the panel's own repo (custom packages built by CI)
function ghSelf(path) {
  const repo = process.env.PANEL_GITHUB_REPO || 'goodmen001/mail-fleet-panel';
  return ghFetch(`https://api.github.com/repos/${repo}/${path}`, { headers: GH_HEADERS() })
    .then(r => {
      if (!r.ok) throw new Error(`GitHub API ${path}: ${r.status}`);
      return r.json();
    });
}

// packages live under DATA_DIR/packages/<pkg_id> (also mirrors the Windows
// package layout data/…). Kept out of the repo data dir shipped in the zip.
function packagesRoot() {
  const root = path.join(dataDir, 'packages');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// validate an extracted deploy dir: the deploy engine needs worker.js + assets
function validatePkgDir(dir) {
  if (!fs.existsSync(path.join(dir, 'worker.js'))) return '缺少 worker.js';
  if (!fs.existsSync(path.join(dir, 'index.html'))) return '缺少 index.html';
  return null;
}

// unzip a worker-dist bundle zip into dest and return the dir that actually
// contains worker.js (accepts both zip-root and one-level-nested layouts)
async function extractZipTo(buf, dest) {
  const { extractZip } = await import('./zip-extract.mjs');
  await extractZip(buf, dest);
  if (fs.existsSync(path.join(dest, 'worker.js'))) return dest;
  const entries = fs.readdirSync(dest, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const e of entries) {
    const sub = path.join(dest, e.name);
    if (fs.existsSync(path.join(sub, 'worker.js'))) return sub;
  }
  return null;
}

export default async function (app) {
  // panel's own version (package.json at build time) — shown in the sidebar
  app.get('/app', async () => ({ code: 200, data: { version: process.env.APP_VERSION || APP_VERSION } }));
  // latest panel release from GitHub (topbar 更新检查); non-fatal on network failure
  app.get('/latest', async () => {
    try {
      const rel = await ghSelf('releases/latest');
      return { code: 200, data: { tag: rel.tag_name, name: rel.name } };
    } catch (e) {
      return { code: 200, data: {}, message: `检查更新失败: ${e.message}` };
    }
  });

  // ---- GitHub acceleration proxy config (v28) ----
  app.get('/proxy', { preHandler: [app.auth] }, async () => {
    const cfg = getGhConfig();
    return { code: 200, data: { ...cfg, mirrors: KNOWN_MIRRORS } };
  });

  app.post('/proxy', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    try {
      setGhConfig(req.body || {});
      return { code: 200, message: 'GitHub 加速配置已保存' };
    } catch (e) {
      return reply.code(400).send({ code: 400, message: e.message });
    }
  });

  // probe a mirror/prefix with a tiny API call (does NOT change saved config)
  app.post('/proxy/test', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { prefix } = req.body || {};
    const url = `https://api.github.com/rate_limit`;
    const target = prefix ? prefix + url.replace(/^https?:\/\//, '') : url;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(target, { headers: GH_HEADERS(), signal: ctrl.signal });
      return { code: 200, data: { ok: res.ok, status: res.status } };
    } catch (e) {
      return { code: 200, data: { ok: false, status: 0, error: e.message } };
    } finally { clearTimeout(timer); }
  });

  // ---- Cloudflare API acceleration proxy (v0.4.0) ----
  app.get('/cfproxy', { preHandler: [app.auth] }, async () => {
    return { code: 200, data: getCfConfig() };
  });

  app.post('/cfproxy', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    try {
      setCfConfig(req.body || {});
      return { code: 200, message: 'Cloudflare 加速配置已保存' };
    } catch (e) {
      return reply.code(400).send({ code: 400, message: e.message });
    }
  });

  // probe a CF proxy prefix / direct line (no config change). Uses the SAME
  // path shape cf-proxy produces in custom mode (<prefix>/api.cloudflare.com/…)
  // so a prefix that only proxies part of the URL fails here like it would
  // for real requests, and requires a CF-shaped JSON response.
  app.post('/cfproxy/test', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { prefix } = req.body || {};
    const url = `https://api.cloudflare.com/client/v4/user/tokens/verify`;
    const target = prefix ? prefix + url.replace(/^https?:\/\//, '') : url;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(target, { headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal });
      const body = await res.text().catch(() => '');
      let cf = null;
      try { cf = JSON.parse(body); } catch { /* not JSON → bad proxy */ }
      return {
        code: 200,
        data: {
          ok: !!cf && typeof cf.success === 'boolean' && res.status < 500,
          status: res.status,
          cf: !!cf,
          error: cf ? undefined : '响应不是 Cloudflare API 格式（反代可能只代理了部分路径）'
        }
      };
    } catch (e) {
      return { code: 200, data: { ok: false, status: 0, error: e.message } };
    } finally { clearTimeout(timer); }
  });

  // ---- outbound proxy (v0.6.0): socks5/http for api.cloudflare.com & github ----
  app.get('/outproxy', { preHandler: [app.auth] }, async () => {
    return { code: 200, data: { url: getOutProxyUrl(), mode: outProxyMode() } };
  });

  app.post('/outproxy', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    try {
      setOutProxyUrl((req.body || {}).url);
      return { code: 200, message: '出站代理已保存' };
    } catch (e) {
      return reply.code(400).send({ code: 400, message: e.message });
    }
  });

  app.post('/outproxy/test', { preHandler: [app.auth, app.requireAdmin] }, async () => {
    return { code: 200, data: await testOutProxy() };
  });

  // ---- one-click onlycf.<domain> API reverse-proxy (v0.6.0) ----
  // zones of the chosen credential, for the domain dropdown
  app.get('/cfproxy/zones', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    try {
      const headers = credentialHeaders(req.query.credId);
      if (!headers) return reply.code(404).send({ code: 404, message: '凭证不存在' });
      return { code: 200, data: await listZones(headers) };
    } catch (e) {
      return { code: 400, message: e.message };
    }
  });

  // deployment status of the proxy worker for a credential
  app.get('/cfproxy/onlycf-status', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    try {
      const headers = credentialHeaders(req.query.credId);
      const accountId = accountIdOf(req.query.credId);
      if (!headers || !accountId) return reply.code(404).send({ code: 404, message: '凭证不存在或缺账号 ID' });
      return { code: 200, data: await getProxyStatus(headers, accountId) };
    } catch (e) {
      return { code: 400, message: e.message };
    }
  });

  // one-click deploy: worker upload → disable workers.dev → bind onlycf.<domain>
  app.post('/cfproxy/onlycf-deploy', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { credId, domain } = req.body || {};
    if (!credId || !domain) return reply.code(400).send({ code: 400, message: 'credId 与 domain 必填' });
    const headers = credentialHeaders(credId);
    if (!headers) return reply.code(404).send({ code: 404, message: '凭证不存在' });
    const accountId = accountIdOf(credId);
    if (!accountId) return reply.code(400).send({ code: 400, message: '凭证缺少账号 ID，请重新验证凭证' });
    const steps = [];
    try {
      const r = await deployProxyWorker(headers, accountId, domain, (msg) => steps.push(msg));
      return { code: 200, message: `已部署并启用 https://${r.hostname}`, data: { ...r, steps } };
    } catch (e) {
      return { code: 400, message: e.message, data: { steps } };
    }
  });

  // custom file registry (upstream-diff tracking, unchanged)
  app.get('/customs', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT * FROM custom_file ORDER BY path').all();
    return { code: 200, data: list };
  });

  app.post('/customs/add', { preHandler: [app.auth, app.requireAdmin] }, async (req) => {
    const { path: p, note } = req.body || {};
    if (!p) return { code: 400, message: 'path 必填' };
    db.prepare('INSERT OR IGNORE INTO custom_file (path, note) VALUES (?,?)').run(p, note || '');
    return { code: 200, message: '已登记' };
  });

  app.delete('/customs/delete', { preHandler: [app.auth, app.requireAdmin] }, async (req) => {
    db.prepare('DELETE FROM custom_file WHERE file_id = ?').run(req.query.fileId);
    return { code: 200, message: '已删除' };
  });

  // check upstream for updates and compute conflicts
  app.get('/check', { preHandler: [app.auth] }, async (req, reply) => {
    try {
      const state = db.prepare('SELECT * FROM version_state WHERE id = 1').get();
      const head = await gh(`commits/${BRANCH}`);
      const latestSha = head.sha;
      const latestMsg = head.commit.message.split('\n')[0];

      let conflicts = [];
      let changedFiles = [];
      if (state.current_upstream && state.current_upstream !== latestSha) {
        const compare = await gh(`compare/${state.current_upstream}...${latestSha}`);
        changedFiles = compare.files.map(f => ({ filename: f.filename, status: f.status }));
        const customs = db.prepare('SELECT path FROM custom_file').all().map(r => r.path);
        conflicts = changedFiles.filter(f => customs.includes(f.filename));
      }

      db.prepare("UPDATE version_state SET last_check = datetime('now') WHERE id = 1").run();
      return {
        code: 200,
        data: {
          currentUpstream: state.current_upstream,
          latestSha,
          latestMsg,
          hasUpdate: state.current_upstream ? state.current_upstream !== latestSha : false,
          changedCount: changedFiles.length,
          changedFiles,
          conflicts: conflicts.map(f => f.filename),
          conflictCount: conflicts.length,
          canAutoUpgrade: state.current_upstream ? conflicts.length === 0 && changedFiles.length > 0 : false
        }
      };
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '检查上游失败: ' + e.message });
    }
  });

  // record that we've adopted an upstream version (after manual or auto upgrade)
  app.post('/adopt', { preHandler: [app.auth, app.requireAdmin] }, async (req) => {
    const { sha } = req.body || {};
    if (!sha) return { code: 400, message: 'sha 必填' };
    db.prepare('UPDATE version_state SET current_upstream = ? WHERE id = 1').run(sha);
    return { code: 200, message: '已记录当前上游版本' };
  });

  app.get('/state', { preHandler: [app.auth] }, async () => {
    return { code: 200, data: db.prepare('SELECT * FROM version_state WHERE id = 1').get() };
  });

  // ---- deployment package registry (version center) ----

  app.get('/pkgs', { preHandler: [app.auth] }, async () => {
    const list = db.prepare('SELECT pkg_id AS pkgId, name, kind, version, tag, dir, note, create_time AS createTime FROM pkg_version ORDER BY pkg_id DESC').all()
      .map(p => ({ ...p, exists: fs.existsSync(path.join(p.dir || '', 'worker.js')), dir: undefined }));
    return { code: 200, data: list };
  });

  // upstream custom-package upload: multipart zip of the built worker-dist
  app.post('/pkgs/upload', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ code: 400, message: '请选择 zip 包（cloud-mail mail-worker/dist 的打包文件）' });
    const name = (file.fields?.name?.value ?? file.filename?.replace(/\.zip$/i, '') ?? '定制包').toString().trim() || '定制包';
    const version = (file.fields?.version?.value ?? '').toString().trim();
    const note = (file.fields?.note?.value ?? '').toString().trim();
    if (!/\.zip$/i.test(file.filename || '')) return reply.code(400).send({ code: 400, message: '只支持 .zip 包' });

    const buf = Buffer.from(await file.toBuffer());
    const info = db.prepare('INSERT INTO pkg_version (name, kind, version, tag, dir, note) VALUES (?,?,?,?,?,?)')
      .run(name, 'custom', version || null, null, '', note || null);
    const pkgId = info.lastInsertRowid;
    const dest = path.join(packagesRoot(), String(pkgId));
    fs.mkdirSync(dest, { recursive: true });
    try {
      const dir = await extractZipTo(buf, dest);
      if (!dir) throw new Error('包内未找到 worker.js');
      const err = validatePkgDir(dir);
      if (err) throw new Error(err);
      db.prepare('UPDATE pkg_version SET dir=? WHERE pkg_id=?').run(dir, pkgId);
      return { code: 200, data: { pkgId }, message: '定制包已上传' };
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      db.prepare('DELETE FROM pkg_version WHERE pkg_id=?').run(pkgId);
      return reply.code(400).send({ code: 400, message: '导入失败: ' + e.message });
    }
  });

  // official package import: pull a GitHub release source tarball, build the
  // frontend (vite build outputs to mail-worker/dist) and bundle the worker
  // with the SAME wrangler dry-run used for the built-in custom package, so
  // the deployed artifacts are identical to `wrangler deploy` on that tag.
  app.post('/pkgs/import-official', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { tag, name, note } = req.body || {};
    if (!tag) return reply.code(400).send({ code: 400, message: 'tag 必填（如 v3.4.0）' });
    // releases only: refuse arbitrary refs to keep the source trusted
    const releases = await gh(`releases?per_page=100`).catch(() => []);
    const rel = (releases || []).find(r => r.tag_name === tag);
    if (!rel) return reply.code(400).send({ code: 400, message: `未找到官方 Release ${tag}` });
    const version = rel.tag_name.replace(/^v/, '');

    const info = db.prepare('INSERT INTO pkg_version (name, kind, version, tag, dir, note) VALUES (?,?,?,?,?,?)')
      .run(name || `官方 cloud-mail ${rel.tag_name}`, 'official', version, rel.tag_name, '', note || null);
    const pkgId = info.lastInsertRowid;
    const dest = path.join(packagesRoot(), String(pkgId));
    const work = path.join(dest, '_build');
    fs.mkdirSync(work, { recursive: true });
    try {
      // 1. download the release source tarball
      const res = await ghFetch(`https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(rel.tag_name)}`, { headers: GH_HEADERS() }, { timeoutMs: 300000 });
      if (!res.ok) throw new Error(`下载源码失败: HTTP ${res.status}`);
      // 2. untar (strip the top-level maillab-cloud-mail-<sha>/ component)
      const extract = tar.extract();
      const extractDone = new Promise((resolve, reject) => {
        extract.on('finish', resolve);
        extract.on('error', reject);
        extract.on('entry', (hdr, stream, next) => {
          const rel2 = hdr.name.split('/').slice(1).join('/');
          if (!rel2 || hdr.type === 'directory') { stream.resume(); return next(); }
          const out = path.join(work, rel2);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const ws = fs.createWriteStream(out);
          stream.pipe(ws).on('finish', next).on('error', next);
        });
      });
      // GitHub source tarballs are gzip-compressed
      await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), extract);
      await extractDone;

      const src = work;
      // 3. build the frontend → outputs into mail-worker/dist (official repo's
      //    release .env sets VITE_OUT_DIR=../mail-worker/dist)
      const hasLock = fs.existsSync(path.join(src, 'mail-vue', 'package-lock.json'));
      const vueCmd = hasLock ? 'npm ci' : 'npm install';
      await run(`cd ${JSON.stringify(src + '/mail-vue')} && ${vueCmd} --no-audit --no-fund --legacy-peer-deps && npm run build`, '前端构建失败');
      if (!fs.existsSync(path.join(src, 'mail-worker', 'dist', 'index.html'))) {
        // some versions build in-place under mail-vue/dist — copy over
        if (fs.existsSync(path.join(src, 'mail-vue', 'dist', 'index.html'))) {
          fs.mkdirSync(path.join(src, 'mail-worker', 'dist'), { recursive: true });
          fs.cpSync(path.join(src, 'mail-vue', 'dist'), path.join(src, 'mail-worker', 'dist'), { recursive: true });
        } else throw new Error('前端构建产物缺少 index.html');
      }
      // 4. bundle the worker (same engine as the shipped built-in package);
      //    mail-worker deps must be installed for wrangler to resolve imports
      const wkHasLock = fs.existsSync(path.join(src, 'mail-worker', 'package-lock.json'));
      const wkCmd = wkHasLock ? 'npm ci' : 'npm install';
      await run(`cd ${JSON.stringify(src + '/mail-worker')} && ${wkCmd} --no-audit --no-fund --legacy-peer-deps`, 'Worker 依赖安装失败');
      const outDir = path.join(dest, 'bundle');
      await run(`cd ${JSON.stringify(src + '/mail-worker')} && npx --yes wrangler@4 deploy --dry-run --outdir ${JSON.stringify(outDir)}`, 'Worker 打包失败');
      if (!fs.existsSync(path.join(outDir, 'index.js'))) throw new Error('Worker 打包产物缺少 index.js');
      // 5. assemble the deploy dir: worker.js (bundled) + static assets (dist)
      const finalDir = path.join(dest, 'deploy');
      fs.mkdirSync(finalDir, { recursive: true });
      fs.copyFileSync(path.join(outDir, 'index.js'), path.join(finalDir, 'worker.js'));
      fs.cpSync(path.join(src, 'mail-worker', 'dist'), finalDir, { recursive: true });
      const err = validatePkgDir(finalDir);
      if (err) throw new Error(err);
      db.prepare('UPDATE pkg_version SET dir=? WHERE pkg_id=?').run(finalDir, pkgId);
      fs.rmSync(work, { recursive: true, force: true });
      return { code: 200, data: { pkgId }, message: `官方包 ${rel.tag_name} 已导入` };
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      db.prepare('DELETE FROM pkg_version WHERE pkg_id=?').run(pkgId);
      return reply.code(400).send({ code: 400, message: '导入官方包失败: ' + e.message });
    }
  });

  app.delete('/pkgs/delete', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const pkgId = Number(req.query.pkgId);
    const row = db.prepare('SELECT * FROM pkg_version WHERE pkg_id = ?').get(pkgId);
    if (!row) return reply.code(404).send({ code: 404, message: '包不存在' });
    if (row.dir) { try { fs.rmSync(row.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    // also remove the parent packages/<pkgId> (import-official leaves bundle/ etc.)
    try { fs.rmSync(path.join(packagesRoot(), String(pkgId)), { recursive: true, force: true }); } catch { /* best effort */ }
    db.prepare('DELETE FROM pkg_version WHERE pkg_id = ?').run(pkgId);
    return { code: 200, message: '已删除' };
  });

  // list available official releases (for the import dialog)
  app.get('/pkgs/official-releases', { preHandler: [app.auth] }, async (req, reply) => {
    try {
      const releases = await gh(`releases?per_page=30`);
      return { code: 200, data: (releases || []).map(r => ({ tag: r.tag_name, name: r.name, prerelease: r.prerelease, publishedAt: r.published_at, body: (r.body || '').slice(0, 400) })) };
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '获取官方 Release 失败: ' + e.message });
    }
  });

  // ---- per-package online update ----
  // official pkg → rebuild from the LATEST upstream release and swap in place;
  // custom pkg  → re-pull the newest custom-worker-dist-*.zip asset from the
  // panel's own GitHub release. The old deploy dir is kept until the new one
  // validates, so a failed update never breaks deployments.
  app.post('/pkgs/update', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { pkgId } = req.body || {};
    const row = db.prepare('SELECT * FROM pkg_version WHERE pkg_id = ?').get(Number(pkgId));
    if (!row) return reply.code(404).send({ code: 404, message: '包不存在' });

    // stage the new deploy dir next to the old one; swap only after validation
    const stage = path.join(packagesRoot(), `update-${row.pkg_id}-${Date.now()}`);
    fs.mkdirSync(stage, { recursive: true });
    try {
      let version = null, tag = null, srcNote = '';
      if (row.kind === 'official') {
        // latest official release of the upstream repo
        const rel = await gh('releases/latest');
        tag = rel.tag_name;
        version = tag.replace(/^v/, '');
        srcNote = `上游 ${tag}`;
        const res = await ghFetch(`https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(tag)}`, { headers: GH_HEADERS() }, { timeoutMs: 300000 });
        if (!res.ok) throw new Error(`下载源码失败: HTTP ${res.status}`);
        const work = path.join(stage, '_build');
        const extract = tar.extract();
        const extractDone = new Promise((resolve, reject) => {
          extract.on('finish', resolve); extract.on('error', reject);
          extract.on('entry', (hdr, stream, next) => {
            const rel2 = hdr.name.split('/').slice(1).join('/');
            if (!rel2 || hdr.type === 'directory') { stream.resume(); return next(); }
            const out = path.join(work, rel2);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            stream.pipe(fs.createWriteStream(out)).on('finish', next).on('error', next);
          });
        });
        await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), extract);
        await extractDone;
        const src = work;
        const hasLock = fs.existsSync(path.join(src, 'mail-vue', 'package-lock.json'));
        await run(`cd ${JSON.stringify(src + '/mail-vue')} && ${hasLock ? 'npm ci' : 'npm install'} --no-audit --no-fund --legacy-peer-deps && npm run build`, '前端构建失败');
        if (!fs.existsSync(path.join(src, 'mail-worker', 'dist', 'index.html')) && fs.existsSync(path.join(src, 'mail-vue', 'dist', 'index.html'))) {
          fs.mkdirSync(path.join(src, 'mail-worker', 'dist'), { recursive: true });
          fs.cpSync(path.join(src, 'mail-vue', 'dist'), path.join(src, 'mail-worker', 'dist'), { recursive: true });
        }
        if (!fs.existsSync(path.join(src, 'mail-worker', 'dist', 'index.html'))) throw new Error('前端构建产物缺少 index.html');
        const wkHasLock = fs.existsSync(path.join(src, 'mail-worker', 'package-lock.json'));
        await run(`cd ${JSON.stringify(src + '/mail-worker')} && ${wkHasLock ? 'npm ci' : 'npm install'} --no-audit --no-fund --legacy-peer-deps`, 'Worker 依赖安装失败');
        await run(`cd ${JSON.stringify(src + '/mail-worker')} && npx --yes wrangler@4 deploy --dry-run --outdir ${JSON.stringify(path.join(stage, 'bundle'))}`, 'Worker 打包失败');
        if (!fs.existsSync(path.join(stage, 'bundle', 'index.js'))) throw new Error('Worker 打包产物缺少 index.js');
        fs.copyFileSync(path.join(stage, 'bundle', 'index.js'), path.join(stage, 'worker.js'));
        fs.cpSync(path.join(src, 'mail-worker', 'dist'), stage, { recursive: true });
        fs.rmSync(work, { recursive: true, force: true });
      } else {
        // custom: newest custom-worker-dist-*.zip from the panel's own releases
        const rels = await ghSelf('releases?per_page=30');
        let asset = null;
        for (const r of rels || []) {
          const a = (r.assets || []).filter(a => /^custom-worker-dist-\d+\.\d+\.\d+\.zip$/.test(a.name))
            .sort((x, y) => y.name.localeCompare(x.name))[0];
          if (a) { asset = a; break; }
        }
        if (!asset) throw new Error('GitHub Release 上未找到 custom-worker-dist-*.zip，无法在线更新');
        version = (asset.name.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
        srcNote = `GitHub ${asset.name}`;
        const res = await ghFetch(asset.url, { headers: { Accept: 'application/octet-stream', ...GH_HEADERS() } }, { timeoutMs: 300000 });
        if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const { extractZip } = await import('./zip-extract.mjs');
        await extractZip(buf, stage);
        if (!fs.existsSync(path.join(stage, 'worker.js'))) {
          // nested zip-root layout: hoist the dir containing worker.js
          const sub = fs.readdirSync(stage, { withFileTypes: true }).filter(e => e.isDirectory())
            .map(e => path.join(stage, e.name)).find(d => fs.existsSync(path.join(d, 'worker.js')));
          if (!sub) throw new Error('包内未找到 worker.js');
          for (const f of fs.readdirSync(sub)) fs.cpSync(path.join(sub, f), path.join(stage, f), { recursive: true });
        }
      }
      const err = validatePkgDir(stage);
      if (err) throw new Error(err);
      // validated: swap dirs
      const oldDir = row.dir;
      db.prepare('UPDATE pkg_version SET version=?, tag=?, dir=?, note=?, create_time=datetime(\'now\') WHERE pkg_id=?')
        .run(version, tag, stage, (row.note ? row.note + '；' : '') + `在线更新 ${srcNote} ${new Date().toISOString().slice(0, 10)}`, row.pkg_id);
      if (oldDir && oldDir.startsWith(packagesRoot()) && oldDir !== stage) {
        fs.rmSync(oldDir, { recursive: true, force: true });
      }
      return { code: 200, message: `「${row.name}」已更新到 ${version || '最新'}（${srcNote}）` };
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      return reply.code(400).send({ code: 400, message: '更新失败: ' + e.message });
    }
  });

  // ---- sync deploy packages from our own GitHub repo releases ----
  // The CI (see .github/workflows/release.yml) attaches custom-worker-dist-*.zip
  // to each build release; here we list them and pull one into the version
  // center as a custom package. Official packages: pull the SAME asset pattern
  // from upstream maillab/cloud-mail is not available (they ship no worker
  // bundle), so official sync = import-official (source build) — kept as is.
  const SELF_REPO = process.env.PANEL_GITHUB_REPO || 'goodmen001/mail-fleet-panel';

  app.get('/pkgs/github-releases', { preHandler: [app.auth] }, async (req, reply) => {
    try {
      const res = await ghFetch(`https://api.github.com/repos/${SELF_REPO}/releases?per_page=30`, { headers: GH_HEADERS() });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const releases = await res.json();
      return {
        code: 200,
        data: (releases || []).map(r => ({
          tag: r.tag_name,
          name: r.name,
          publishedAt: r.published_at,
          packages: (r.assets || []).filter(a => /^(custom|official)-worker-dist-.*\.zip$/.test(a.name))
            .map(a => ({ name: a.name, kind: a.name.startsWith('official-') ? 'official' : 'custom', size: a.size, downloadUrl: a.browser_download_url }))
        })).filter(r => r.packages.length > 0)
      };
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '获取 GitHub Release 失败: ' + e.message });
    }
  });

  // pull a custom-worker-dist-*.zip asset from our GitHub release into the
  // version center as a custom package (no build needed — CI built it)
  app.post('/pkgs/sync-github', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { downloadUrl, name, note } = req.body || {};
    // accept either the browser download URL or the API asset URL; both
    // custom-worker-dist-*.zip and official-worker-dist-*.zip are supported
    const m = (downloadUrl || '').match(
      new RegExp(`^https://(github\\.com/${SELF_REPO}/releases/download/[^/]+/((?:custom|official)-worker-dist-[^/]+\\.zip)|api\\.github\\.com/repos/${SELF_REPO}/releases/assets/\\d+)`)
    );
    if (!m) return reply.code(400).send({ code: 400, message: 'downloadUrl 必须是本仓库 Release 的资源地址（custom/official-worker-dist-*.zip）' });
    const kind = (m[2] || '').startsWith('official-') ? 'official' : 'custom';
    let assetUrl = downloadUrl;
    if (m[2]) {
      // browser URL → API asset URL (API + Accept: octet-stream handles private repos too)
      const assetName = m[2];
      const rel = await ghFetch(`https://api.github.com/repos/${SELF_REPO}/releases?per_page=30`, { headers: GH_HEADERS() });
      const rels = rel.ok ? await rel.json() : [];
      let assetId = null;
      for (const r of rels) {
        const a = (r.assets || []).find(a => a.name === assetName);
        if (a) { assetId = a.id; break; }
      }
      if (!assetId) return reply.code(404).send({ code: 404, message: `未找到资源 ${assetName}` });
      assetUrl = `https://api.github.com/repos/${SELF_REPO}/releases/assets/${assetId}`;
    }
    try {
      const res = await ghFetch(assetUrl, { headers: { Accept: 'application/octet-stream', ...GH_HEADERS() } }, { timeoutMs: 300000 });
      if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const assetName = name || '';
      // version/tag from the asset name: custom-worker-dist-<ver>.zip or
      // official-worker-dist-<ver>+v3.4.0.zip (semver release naming)
      const vm = assetName.match(/(?:custom|official)-worker-dist-(\d+\.\d+\.\d+)(?:\+(\S+))?\.zip/);
      const version = vm ? vm[1] : null;
      const tag = vm && vm[2] ? vm[2] : null;

      const info = db.prepare('INSERT INTO pkg_version (name, kind, version, tag, dir, note) VALUES (?,?,?,?,?,?)')
        .run(assetName || (kind === 'official' ? 'GitHub 官方包' : 'GitHub 定制包'), kind, version, tag, '', note || `同步自 GitHub ${SELF_REPO}`);
      const pkgId = info.lastInsertRowid;
      const dest = path.join(packagesRoot(), String(pkgId));
      fs.mkdirSync(dest, { recursive: true });
      try {
        const dir = await extractZipTo(buf, dest);
        if (!dir) throw new Error('包内未找到 worker.js');
        const err = validatePkgDir(dir);
        if (err) throw new Error(err);
        db.prepare('UPDATE pkg_version SET dir=? WHERE pkg_id=?').run(dir, pkgId);
        return { code: 200, data: { pkgId }, message: `已从 GitHub 同步 ${name}` };
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true });
        db.prepare('DELETE FROM pkg_version WHERE pkg_id=?').run(pkgId);
        return reply.code(400).send({ code: 400, message: '同步失败: ' + e.message });
      }
    } catch (e) {
      return reply.code(502).send({ code: 502, message: '同步失败: ' + e.message });
    }
  });
}

function run(cmd, label) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${label}: ${(stderr || stdout || err.message).slice(-500)}`));
      resolve(stdout);
    });
  });
}
