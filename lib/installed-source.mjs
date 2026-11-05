import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLIENT_SHA256 = '8d25c9a5e036cdd5c6d3bf27977ef3a49848b407e9eb2f225a12faeb55a633df';

function invalid() { throw Object.assign(new Error('Installed static source is unsupported.'), { code: 'INSTALLED_SOURCE_INVALID' }); }

// Static, bounded ASAR reads only. No archive code is executed or modified.
export function readAsarFile(filename, relative) {
  if (typeof relative !== 'string' || !relative || relative.split('/').some(x => !x || x === '.' || x === '..')) invalid();
  const fd = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16) invalid();
    const headerSize = header.readUInt32LE(12);
    if (!headerSize || headerSize > 32 * 1024 * 1024 || 16 + headerSize > size) invalid();
    const raw = Buffer.alloc(headerSize);
    if (fs.readSync(fd, raw, 0, raw.length, 16) !== raw.length) invalid();
    let entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    for (const component of relative.split('/')) entry = entry?.files?.[component];
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 1 ||
        entry.size > 2 * 1024 * 1024 || !/^\d+$/.test(entry.offset || '')) invalid();
    const offset = 8 + header.readUInt32LE(4) + Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 16 + headerSize || offset > size - entry.size) invalid();
    const bytes = Buffer.alloc(entry.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) invalid();
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function originalClient(installation) {
  const bytes = readAsarFile(path.join(installation, 'resources', 'app.asar'), 'node_modules/ds-bot/client.js');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== CLIENT_SHA256) {
    throw Object.assign(new Error('Installed browser client differs from the reviewed version.'), { code: 'CLIENT_SOURCE_CHANGED' });
  }
  return bytes;
}
