import db from '../db/index.js';

const REPO = 'maillab/cloud-mail';
const BRANCH = 'main';

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { 'User-Agent': 'mail-fleet-panel', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return res.json();
}

export default async function (app) {
  // custom file registry
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
}
