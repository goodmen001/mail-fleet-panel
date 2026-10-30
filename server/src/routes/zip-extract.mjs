// Minimal ZIP reader/extractor built on node:zlib — avoids adding a native
// or heavy dependency just to unzip the uploaded worker-dist bundle.
// Supports stored + deflate entries (what any zip tool produces).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

function readAll(buf) {
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42); // local header offset
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, lho });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries.map(e => {
    // local header: skip to the data
    const nameLen = buf.readUInt16LE(e.lho + 26);
    const extraLen = buf.readUInt16LE(e.lho + 28);
    const dataStart = e.lho + 30 + nameLen + extraLen;
    const comp = buf.slice(dataStart, dataStart + e.compSize);
    const data = e.method === 0 ? comp : zlib.inflateRawSync(comp);
    return { name: e.name, data };
  });
}

export async function extractZip(buf, dest) {
  for (const { name, data } of readAll(buf)) {
    if (name.includes('..') || path.isAbsolute(name)) continue; // zip-slip guard
    const out = path.join(dest, name);
    if (name.endsWith('/')) { fs.mkdirSync(out, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}
