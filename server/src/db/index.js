import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'panel.db'));
db.exec('PRAGMA journal_mode = WAL');

// ---- crypto for Cloudflare credentials ----
const SECRET = process.env.PANEL_SECRET || 'change-me-in-production';

export function encrypt(plain) {
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':');
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt] = stored.split(':');
  return hashPassword(password, salt) === stored;
}

db.exec(`
CREATE TABLE IF NOT EXISTS panel_user (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- admin | user
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cf_credential (
  cred_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'token',      -- token | global_key
  token_enc TEXT NOT NULL,                 -- encrypted
  account_id TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site (
  site_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,                  -- https://mail.example.com
  admin_email TEXT NOT NULL,
  admin_password_enc TEXT NOT NULL,
  cred_id INTEGER,
  domain TEXT,
  worker_name TEXT,
  status TEXT DEFAULT 'unknown',           -- unknown|online|offline
  last_check DATETIME,
  jwt_cache TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deploy_record (
  deploy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  cred_id INTEGER NOT NULL,
  status TEXT DEFAULT 'running',           -- running|success|failed
  steps TEXT,                              -- JSON log
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS custom_file (
  file_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,               -- repo-relative path we customized
  note TEXT
);
CREATE TABLE IF NOT EXISTS version_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_upstream TEXT,                   -- upstream commit/tag we're based on
  last_check DATETIME
);
`);

// migration: auth email for Global API Key credentials (must run AFTER table creation)
try { db.exec('ALTER TABLE cf_credential ADD COLUMN auth_email TEXT'); } catch { /* exists */ }

// seed version state
db.prepare(`INSERT OR IGNORE INTO version_state (id) VALUES (1)`).run();

export default db;
