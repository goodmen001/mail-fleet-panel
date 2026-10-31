#!/usr/bin/env node
// tools/decrypt-cred.js — 离线解密面板存储的 Cloudflare 凭证（本地工具，不随产品发布）
//
// 用法：
//   node tools/decrypt-cred.js                    # 列出库里全部凭证并解密
//   node tools/decrypt-cred.js 3                  # 只解密 credId=3
//   node tools/decrypt-cred.js <ivhex>:<taghex>:<enchex>   # 直接解一段密文
//   DATA_DIR=/path/to/data node tools/decrypt-cred.js      # 指定数据目录
//   PANEL_SECRET=xxxx node tools/decrypt-cred.js           # 指定密钥（否则读 <data>/panel_secret）
//
// 加密方案与 server/src/db/index.js 一致：
//   key = sha256(PANEL_SECRET)，AES-256-GCM，存储格式 iv:tag:ciphertext（均 hex）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PLACEHOLDERS = ['change-me-in-production', 'please-change-me-to-a-long-random-string', 'please-change-this-secret'];

const SECRET = (() => {
  const env = process.env.PANEL_SECRET;
  if (env && !PLACEHOLDERS.includes(env)) return env;
  return fs.readFileSync(path.join(DATA_DIR, 'panel_secret'), 'utf8').trim();
})();

const key = crypto.createHash('sha256').update(SECRET).digest();

function decryptOne(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

const arg = process.argv[2];

// 直接解一段密文
if (arg && arg.includes(':') && /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(arg.trim())) {
  try {
    console.log(decryptOne(arg.trim()));
  } catch (e) {
    console.error('解密失败（密钥不对或密文损坏）:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

const dbFile = path.join(DATA_DIR, 'panel.db');
if (!fs.existsSync(dbFile)) { console.error(`找不到数据库 ${dbFile}（用 DATA_DIR 指定数据目录）`); process.exit(1); }
const db = new DatabaseSync(dbFile);
let rows;
if (arg) {
  rows = db.prepare('SELECT * FROM cf_credential WHERE cred_id = ?').all(Number(arg));
  if (!rows.length) { console.error(`credId=${arg} 不存在`); process.exit(1); }
} else {
  rows = db.prepare('SELECT * FROM cf_credential ORDER BY cred_id').all();
  if (!rows.length) { console.log('库里没有凭证'); process.exit(0); }
}

for (const r of rows) {
  console.log(`── credId=${r.cred_id}  ${r.name}  (${r.kind || 'token'})`);
  for (const [label, col] of [['API Token / Key', 'token_enc']]) {
    if (r[col]) {
      try { console.log(`  ${label}: ${decryptOne(r[col])}`); }
      catch (e) { console.log(`  ${label}: <解密失败：${e.message}>`); }
    }
  }
  console.log('');
}
