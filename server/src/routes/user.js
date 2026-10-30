import db, { hashPassword, verifyPassword } from '../db/index.js';
import { clearOwnedProxy } from '../services/out-proxy.js';

export default async function (app) {
  // list users (admin only)
  app.get('/list', { preHandler: [app.auth, app.requireAdmin] }, async () => {
    const list = db.prepare('SELECT user_id, username, role, create_time FROM panel_user ORDER BY user_id').all();
    return { code: 200, data: list };
  });

  // add user (admin only)
  app.post('/add', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) return reply.code(400).send({ code: 400, message: '用户名和密码必填' });
    if (password.length < 6) return reply.code(400).send({ code: 400, message: '密码至少6位' });
    const exists = db.prepare('SELECT 1 FROM panel_user WHERE username = ?').get(username);
    if (exists) return reply.code(400).send({ code: 400, message: '用户名已存在' });
    const r = db.prepare('INSERT INTO panel_user (username, password, role) VALUES (?,?,?)')
      .run(username, hashPassword(password), role === 'admin' ? 'admin' : 'user');
    return { code: 200, data: { userId: r.lastInsertRowid } };
  });

  // change password (self, or admin for others)
  app.put('/password', { preHandler: [app.auth] }, async (req, reply) => {
    const { userId, oldPassword, newPassword } = req.body || {};
    const targetId = userId || req.user.uid;
    const row = db.prepare('SELECT * FROM panel_user WHERE user_id = ?').get(targetId);
    if (!row) return reply.code(404).send({ code: 404, message: '用户不存在' });
    if (req.user.role !== 'admin' && targetId !== req.user.uid) {
      return reply.code(403).send({ code: 403, message: '无权修改他人密码' });
    }
    if (req.user.role !== 'admin' || targetId === req.user.uid) {
      if (!verifyPassword(oldPassword || '', row.password)) {
        return reply.code(400).send({ code: 400, message: '原密码错误' });
      }
    }
    if (!newPassword || newPassword.length < 6) return reply.code(400).send({ code: 400, message: '新密码至少6位' });
    db.prepare('UPDATE panel_user SET password = ? WHERE user_id = ?').run(hashPassword(newPassword), targetId);
    return { code: 200, message: '密码已修改' };
  });

  // delete user (admin only)
  app.delete('/delete', { preHandler: [app.auth, app.requireAdmin] }, async (req, reply) => {
    const { userId } = req.query;
    if (Number(userId) === req.user.uid) return reply.code(400).send({ code: 400, message: '不能删除自己' });
    db.prepare('DELETE FROM panel_user WHERE user_id = ?').run(userId);
    return { code: 200, message: '已删除' };
  });

  // logout (v0.7.4): if the current outbound proxy was configured by this
  // user, auto-remove it (proxy is optional — only needed on blocked lines)
  // and record it in their history so the next login can restore it
  app.post('/logout', { preHandler: [app.auth] }, async (req) => {
    const removed = clearOwnedProxy(req.user.uid);
    return { code: 200, message: removed ? '已退出，出站代理已自动取消' : '已退出' };
  });
}
