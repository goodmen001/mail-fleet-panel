import jwt from '@fastify/jwt';
import db, { verifyPassword } from '../db/index.js';

export default async function (app) {
  app.post('/login', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) return reply.code(400).send({ code: 400, message: '用户名和密码必填' });
    const row = db.prepare('SELECT * FROM panel_user WHERE username = ?').get(username);
    if (!row || !verifyPassword(password, row.password)) {
      return reply.code(401).send({ code: 401, message: '用户名或密码错误' });
    }
    const token = app.jwt.sign({ uid: row.user_id, username: row.username, role: row.role }, { expiresIn: '7d' });
    return { code: 200, data: { token, user: { userId: row.user_id, username: row.username, role: row.role } } };
  });

  app.get('/me', { preHandler: [app.auth] }, async (req) => {
    const row = db.prepare('SELECT user_id, username, role, create_time FROM panel_user WHERE user_id = ?').get(req.user.uid);
    return { code: 200, data: row };
  });
}
