import fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import staticFiles from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { hashPassword } from './db/index.js';

import authRoutes from './routes/auth.js';
import credRoutes from './routes/credential.js';
import deployRoutes from './routes/deploy.js';
import siteRoutes from './routes/site.js';
import consoleProxy from './routes/console-proxy.js';
import versionRoutes from './routes/version.js';
import userRoutes from './routes/user.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

async function main() {
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.PANEL_SECRET || 'change-me-in-production' });

app.decorate('auth', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ code: 401, message: '未登录或登录已过期' });
  }
});
app.decorate('requireAdmin', async (req, reply) => {
  if (req.user.role !== 'admin') {
    reply.code(403).send({ code: 403, message: '需要管理员权限' });
  }
});

await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(userRoutes, { prefix: '/api/user' });
await app.register(credRoutes, { prefix: '/api/credential' });
await app.register(deployRoutes, { prefix: '/api/deploy' });
// console proxy first: its /:siteId/* wildcard must win over site routes
await app.register(consoleProxy, { prefix: '/api/site/console' });
await app.register(siteRoutes, { prefix: '/api/site' });
await app.register(versionRoutes, { prefix: '/api/version' });

// static frontend (docker image ships built web)
const webDist = path.join(__dirname, '../../web/dist');
try {
  await app.register(staticFiles, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith('/api/')) return reply.code(404).send({ code: 404, message: 'not found' });
    return reply.sendFile('index.html');
  });
} catch { /* dev mode: web runs on vite */ }

// first-run: create default admin admin/admin123
const userCount = db.prepare('SELECT COUNT(*) AS c FROM panel_user').get().c;
if (userCount === 0) {
  db.prepare('INSERT INTO panel_user (username, password, role) VALUES (?,?,?)')
    .run('admin', hashPassword('admin123'), 'admin');
}

const port = Number(process.env.PORT || 3300);
app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`panel listening on ${port}`));
}
main();
