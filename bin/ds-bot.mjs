#!/usr/bin/env node
// Existing-instance DS Bot adapter. No credential extraction or HTTP login bypass.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { readPolicy, makePlan, createTransport, TransportError } from '../lib/cli-transport.mjs';
import { ProtocolError, ReceiptStore } from '../lib/send-protocol.mjs';
import { PipeRequestError } from '../lib/pipe-client.mjs';

const CLI_VERSION = '0.2.0-candidate.1';
export const EXPECTED = {
  app: '0.2.7', plugin: '0.2.7', dsh: '0.2.1-rc.5',
  channel: '0e05d9a424b188fe338f7102404a9fb295069d0ece241d63cc4f87be18947d03',
  parts: 'f7a2e272f0296414075d2318d45cf58871fff3a22c1d3035707a75bec77ef619',
};
const SESSION_ID = /^session-[0-9a-zA-Z-]{8,128}$/;
const MAX_STATE = 16 * 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024;

class PreviewError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new PreviewError(code, message, details); };

function readJson(file, max = MAX_STATE) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) fail('FILE_UNSUPPORTED', 'Local metadata file is missing or too large.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function windowsPaths(env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform !== 'win32') fail('UNSUPPORTED_PLATFORM', 'This local instance adapter supports Windows only.');
  const profile = env.USERPROFILE || home;
  if (!profile || !path.win32.isAbsolute(profile)) fail('USER_PROFILE_UNAVAILABLE', 'The current Windows user profile is unavailable.');
  return {
    appData: env.APPDATA || path.win32.join(profile, 'AppData', 'Roaming'),
    localAppData: env.LOCALAPPDATA || path.win32.join(profile, 'AppData', 'Local'),
  };
}

export function locations() {
  const paths = windowsPaths();
  const appData = path.join(paths.appData, 'DS Bot');
  const config = readJson(path.join(appData, 'locations.json'));
  if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) fail('LOCATION_INVALID', 'DS Bot data location is invalid.');
  const install = path.join(paths.localAppData, 'Programs', 'DS Bot');
  return { appData, install, dataDir: config.dataDir, workspace: config.workspace };
}

export function asarFacts(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(16);
    if (fs.readSync(fd, b, 0, b.length, 0) !== b.length) fail('ASAR_INVALID', 'Cannot read the installed application archive.');
    const headerSize = b.readUInt32LE(12);
    if (!headerSize || headerSize > 32 * 1024 * 1024) fail('ASAR_INVALID', 'Application archive header is unsupported.');
    const raw = Buffer.alloc(headerSize);
    if (fs.readSync(fd, raw, 0, raw.length, 16) !== raw.length) fail('ASAR_INVALID', 'Application archive header is incomplete.');
    const root = JSON.parse(raw.toString('utf8'));
    const read = (name) => {
      let entry = root;
      for (const part of name.split('/').filter(Boolean)) entry = entry?.files?.[part];
      if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > 2 * 1024 * 1024 || !/^\d+$/.test(entry.offset || '')) fail('ASAR_INVALID', 'Required application code was not found.');
      const result = Buffer.alloc(entry.size);
      const offset = 8 + b.readUInt32LE(4) + Number(entry.offset);
      if (fs.readSync(fd, result, 0, result.length, offset) !== result.length) fail('ASAR_INVALID', 'Required application code is incomplete.');
      return result;
    };
    const pkg = (name) => JSON.parse(read(name).toString('utf8')).version;
    const digest = (name) => crypto.createHash('sha256').update(read(name)).digest('hex');
    return {
      app: pkg('/package.json'), plugin: pkg('/node_modules/ds-bot/package.json'),
      dsh: pkg('/node_modules/@deepseek-ai/dsh/package.json'),
      channel: digest('/node_modules/ds-bot/src/host/channel.js'),
      parts: digest('/node_modules/ds-bot/src/host/parts.js'),
    };
  } finally { fs.closeSync(fd); }
}

function compatible(facts) { return Object.keys(EXPECTED).every(k => facts[k] === EXPECTED[k]); }

export function instanceIdentity(loc, facts) {
  return 'dsbot-' + crypto.createHash('sha256').update(JSON.stringify({ install: path.resolve(loc.install).toLowerCase(), dataDir: path.resolve(loc.dataDir).toLowerCase(), facts })).digest('hex').slice(0, 24);
}

function requireVersion(facts) {
  if (!compatible(facts)) fail('VERSION_UNVERIFIED', 'Installed DS Bot code changed; review compatibility before reading conversations.');
}

// Skip unrequested JSON values without decoding them, including room logs,
// exchange content, instructions and unrelated sessions.
export function parseTeam(source, wantedSession) {
  let i = 0;
  const spaces = () => { while (i < source.length && /\s/.test(source[i])) i++; };
  function string() {
    spaces();
    if (source[i] !== '"') fail('STATE_INVALID', 'Team metadata is not valid JSON.');
    const start = i++;
    while (i < source.length) {
      const c = source[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') return JSON.parse(source.slice(start, i));
    }
    fail('STATE_INVALID', 'Team metadata has an incomplete string.');
  }
  function skip() {
    spaces();
    let c = source[i];
    if (c === '"') {
      i++;
      while (i < source.length) { c = source[i++]; if (c === '\\') i++; else if (c === '"') return; }
      fail('STATE_INVALID', 'Team metadata has an incomplete value.');
    }
    if (c === '{' || c === '[') {
      const stack = [c]; i++;
      while (stack.length && i < source.length) {
        c = source[i++];
        if (c === '"') {
          let closed = false;
          while (i < source.length) { const d = source[i++]; if (d === '\\') i++; else if (d === '"') { closed = true; break; } }
          if (!closed) fail('STATE_INVALID', 'Team metadata has an incomplete value.');
        } else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          const open = stack.pop();
          if ((open === '{' && c !== '}') || (open === '[' && c !== ']')) fail('STATE_INVALID', 'Team metadata has unbalanced values.');
        }
      }
      if (stack.length) fail('STATE_INVALID', 'Team metadata has an incomplete value.');
      return;
    }
    const start = i;
    while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
    if (start === i) fail('STATE_INVALID', 'Team metadata has an invalid value.');
  }
  function object(handler) {
    spaces(); if (source[i++] !== '{') fail('STATE_INVALID', 'Expected an object in team metadata.');
    spaces(); if (source[i] === '}') { i++; return; }
    while (i < source.length) {
      const key = string(); spaces(); if (source[i++] !== ':') fail('STATE_INVALID', 'Expected a property in team metadata.');
      handler(key); spaces(); const c = source[i++];
      if (c === '}') return;
      if (c !== ',') fail('STATE_INVALID', 'Expected a separator in team metadata.');
    }
    fail('STATE_INVALID', 'Team metadata ended early.');
  }
  function array(handler) {
    spaces(); if (source[i++] !== '[') fail('STATE_INVALID', 'Expected an array in team metadata.');
    spaces(); if (source[i] === ']') { i++; return; }
    while (i < source.length) { handler(); spaces(); const c = source[i++]; if (c === ']') return; if (c !== ',') fail('STATE_INVALID', 'Expected an array separator.'); }
    fail('STATE_INVALID', 'Team metadata ended early.');
  }
  function textValue() { spaces(); if (source[i] === '"') return string(); skip(); return undefined; }
  function segments() {
    const result = []; spaces(); if (source[i] !== '[') { skip(); return result; }
    array(() => {
      spaces();
      if (source[i] === '"') { const value = string(); if (SESSION_ID.test(value)) result.push(value); return; }
      if (source[i] !== '{') { skip(); return; }
      object(k => { if (k === 'sessionId') { const value = textValue(); if (value && SESSION_ID.test(value)) result.push(value); } else skip(); });
    });
    return result;
  }
  const result = { bots: [], rooms: [], hiddenTurns: [] };
  function records(kind) {
    spaces(); if (source[i] !== '{') { skip(); return; }
    object(key => {
      const item = { id: key, kind, parts: [] };
      spaces(); if (source[i] !== '{') { skip(); return; }
      object(k => {
        if (['id', 'name', 'sessionId'].includes(k)) { const value = textValue(); if (value !== undefined) item[k] = value; }
        else if (k === 'segments' || k === 'parts' || k === 'ownParts') item.parts.push(...segments());
        else skip();
      });
      item.sessionId ||= item.id;
      if (SESSION_ID.test(item.sessionId)) result[kind].push(item);
    });
  }
  function hidden() {
    spaces(); if (source[i] !== '{' || !wantedSession) { skip(); return; }
    object(key => {
      if (key !== wantedSession) { skip(); return; }
      spaces(); if (source[i] !== '[') { skip(); return; }
      array(() => {
        spaces(); const start = i; skip(); const value = Number(source.slice(start, i));
        if (Number.isInteger(value) && value >= 0) result.hiddenTurns.push(value);
      });
    });
  }
  object(k => { if (k === 'bots' || k === 'rooms') records(k); else if (k === 'exchangeTurns') hidden(); else skip(); });
  spaces(); if (i !== source.length) fail('STATE_INVALID', 'Team metadata has trailing data.');
  return result;
}

function readTeam(loc, wantedSession) {
  const file = path.join(loc.dataDir, 'bot', 'state.json');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_STATE) fail('STATE_UNSUPPORTED', 'Team metadata is missing or too large.');
  const source = fs.readFileSync(file, 'utf8');
  const after = fs.statSync(file);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) fail('SNAPSHOT_CHANGED', 'Team state changed while reading; try again manually.');
  return parseTeam(source, wantedSession);
}

export function sessionRows(team) {
  return [...team.bots, ...team.rooms].flatMap(item => [
    { target: item.name || '(unnamed)', targetId: item.id, kind: item.kind === 'bots' ? 'bot' : 'group', sessionId: item.sessionId, part: 'current' },
    ...item.parts.filter(id => id !== item.sessionId).map(id => ({ target: item.name || '(unnamed)', targetId: item.id, kind: item.kind === 'bots' ? 'bot' : 'group', sessionId: id, part: 'earlier' })),
  ]);
}

function sessionPath(loc, id) {
  if (!SESSION_ID.test(id)) fail('SESSION_ID_INVALID', 'An exact session ID is required.');
  const root = path.join(loc.dataDir, 'sessions');
  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root, entry.name, id);
    const file = path.join(folder, 'session.v4.jsonl.zstd');
    try { if (fs.lstatSync(folder).isDirectory() && fs.lstatSync(file).isFile()) matches.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!matches.length) fail('SESSION_ARCHIVE_NOT_FOUND', 'The selected session archive was not found.');
  if (matches.length !== 1) fail('SESSION_ARCHIVE_AMBIGUOUS', 'More than one archive has this ID; no archive was opened.');
  return matches[0];
}

// DSH appends independent Zstandard frames. Node's one-shot decoder alone
// only returned the header frame in the observed installation. Decode each
// complete standard frame explicitly; never repair or accept a torn tail.
export function decodeArchive(buffer, id, maxOutput = MAX_ARCHIVE) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ARCHIVE) fail('ARCHIVE_TOO_LARGE', 'The selected archive exceeds the CLI limit.');
  const chunks = []; let offset = 0; let total = 0;
  const deadline = Date.now() + 20000;
  const need = count => { if (offset + count > buffer.length) fail('ARCHIVE_INCOMPLETE', 'The selected archive has an incomplete final frame.'); };
  while (offset < buffer.length) {
    if (Date.now() > deadline || chunks.length >= 100000) fail('ARCHIVE_LIMIT', 'Archive decoding exceeded its time or frame limit.');
    const start = offset;
    need(5);
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) fail('ARCHIVE_INVALID', 'The selected archive has an unsupported frame.');
    offset += 4;
    const flags = buffer[offset++];
    if (flags & 0x18) fail('ARCHIVE_INVALID', 'The selected archive has invalid frame flags.');
    const single = Boolean(flags & 0x20);
    const dictionaryBytes = [0, 1, 2, 4][flags & 3];
    const sizeFlag = flags >>> 6;
    const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : (1 << sizeFlag);
    const extraHeader = (single ? 0 : 1) + dictionaryBytes + sizeBytes;
    need(extraHeader); offset += extraHeader;
    let last = false;
    while (!last) {
      need(3); const header = buffer.readUIntLE(offset, 3); offset += 3;
      last = Boolean(header & 1);
      const type = (header >>> 1) & 3;
      if (type === 3) fail('ARCHIVE_INVALID', 'The selected archive has an invalid block.');
      const bytes = type === 1 ? 1 : header >>> 3;
      need(bytes); offset += bytes;
    }
    if (flags & 4) { need(4); offset += 4; }
    if (total >= maxOutput) fail('ARCHIVE_TOO_LARGE', 'The selected archive expands beyond the CLI limit.');
    let decoded;
    try { decoded = zstdDecompressSync(buffer.subarray(start, offset), { maxOutputLength: maxOutput - total }); }
    catch { fail('ARCHIVE_DECODE_FAILED', 'The selected archive failed decompression or checksum validation.'); }
    total += decoded.length; chunks.push(decoded);
  }
  let rows;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    if (!text.endsWith('\n')) fail('ARCHIVE_INCOMPLETE', 'The selected archive ends in an incomplete record.');
    rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    fail('ARCHIVE_INVALID', 'The selected archive contains invalid records.');
  }
  const header = rows.shift();
  if (header?.type !== 'session' || header?.version !== 4 || header?.id !== id) fail('ARCHIVE_HEADER_MISMATCH', 'The archive does not match the selected session and version.');
  if (rows.some(event => !Number.isSafeInteger(event.seq) || typeof event.type !== 'string')) fail('ARCHIVE_INVALID', 'The selected archive has unsupported event records.');
  return rows;
}

function archiveRecords(file, id) {
  const before = fs.statSync(file);
  if (before.size > MAX_ARCHIVE) fail('ARCHIVE_TOO_LARGE', 'The selected archive exceeds the CLI limit.');
  const buffer = fs.readFileSync(file);
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SNAPSHOT_CHANGED', 'The selected archive changed while reading; try again manually.');
  return decodeArchive(buffer, id);
}

export function mask(text) {
  return text
    .replace(/((?:authorization|cookie|set-cookie)\s*[:=：]\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|secret|密码|密钥|口令)\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, '[REDACTED]');
}

export function visibleMessages(records, hiddenTurns, includeText = false) {
  const hidden = new Set(hiddenTurns); const items = []; let currentTurn = null;
  for (const event of records) {
    if (event.type === 'turn/start') { currentTurn = Number.isInteger(event.data?.turn) ? event.data.turn : null; continue; }
    let role, content;
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') { role = 'user'; content = event.data.content; }
    else if (event.type === 'assistant/message' && !hidden.has(event.data?.turn)) { role = 'bot'; content = event.data?.message?.content; }
    else continue;
    for (const [blockIndex, block] of (Array.isArray(content) ? content : []).entries()) {
      if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) continue;
      const item = { role, seq: event.seq, blockIndex, turn: role === 'bot' ? event.data?.turn ?? currentTurn : currentTurn, time: Number.isFinite(event.time) ? new Date(event.time).toISOString() : null };
      if (includeText) item.text = mask(block.text);
      items.push(item);
    }
  }
  return items;
}

export function parseArgs(input) {
  const args = [...input];
  let command = args.shift() || 'help';
  command = ({ '--help': 'help', '-h': 'help', '--version': 'version', '-V': 'version', conversations: 'sessions', chat: 'history' })[command] || command;
  const allowed = {
    help: [], version: [], status: [], capabilities: [], bots: [], groups: [],
    resolve: ['--bot', '--group', '--session'], sessions: ['--bot', '--group'],
    history: ['--bot', '--session', '--limit', '--before-seq', '--show-text', '--metadata'],
    send: ['--bot', '--group', '--session', '--text', '--text-stdin', '--dry-run', '--request-id', '--approval-hash', '--expect-session', '--wait', '--timeout', '--show-text'],
    query: ['--session', '--request-id', '--show-text'],
    wait: ['--session', '--request-id', '--show-text', '--timeout'],
  };
  if (!Object.hasOwn(allowed, command)) fail('COMMAND_UNAVAILABLE', 'Unsupported command; use help --json.');
  const opts = { limit: 30, showText: false, dryRun: false, timeout: 300 }; const seen = new Set();
  const flags = { '--show-text': 'showText', '--metadata': 'metadata', '--text-stdin': 'textStdin', '--dry-run': 'dryRun', '--wait': 'wait' };
  const values = { '--session': 'session', '--bot': 'bot', '--group': 'group', '--limit': 'limit', '--before-seq': 'beforeSeq', '--text': 'text', '--request-id': 'requestId', '--approval-hash': 'approvalHash', '--expect-session': 'expectedSession', '--timeout': 'timeout' };
  while (args.length) {
    const key = args.shift();
    if (seen.has(key)) fail('INVALID_ARGUMENTS', 'Repeated options are not supported.');
    seen.add(key);
    if (key === '--json') continue;
    if (!allowed[command].includes(key)) fail('INVALID_ARGUMENTS', 'An option is not supported by this command.');
    if (flags[key]) { opts[flags[key]] = true; continue; }
    if (!values[key]) fail('INVALID_ARGUMENTS', 'Unknown command option.');
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) fail('INVALID_ARGUMENTS', 'An option value is missing.');
    opts[values[key]] = ['--limit', '--before-seq', '--timeout'].includes(key) ? Number(value) : value;
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200) fail('INVALID_ARGUMENTS', 'The history limit must be between 1 and 200.');
  if (opts.beforeSeq !== undefined && (!Number.isSafeInteger(opts.beforeSeq) || opts.beforeSeq < 0)) fail('INVALID_ARGUMENTS', 'The history cursor must be a nonnegative sequence number.');
  if (opts.showText && opts.metadata) fail('INVALID_ARGUMENTS', 'Choose either metadata or text output.');
  if ([opts.bot, opts.group, opts.session].filter(v => v !== undefined).length > 1) fail('TARGET_CONFLICT', 'Specify one Bot, group, or exact session.');
  if (opts.session && !SESSION_ID.test(opts.session)) fail('SESSION_ID_INVALID', 'An exact session ID is required.');
  if (opts.expectedSession && !SESSION_ID.test(opts.expectedSession)) fail('SESSION_ID_INVALID', 'An exact expected session ID is required.');
  if (!Number.isFinite(opts.timeout) || opts.timeout < 0.001 || opts.timeout > 3600) fail('INVALID_ARGUMENTS', 'Timeout must be between 0.001 and 3600 seconds.');
  if (opts.requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opts.requestId)) fail('REQUEST_ID_INVALID', 'Use a UUID v4 request ID from the preview.');
  if (opts.approvalHash && !/^[0-9a-f]{64}$/.test(opts.approvalHash)) fail('APPROVAL_HASH_INVALID', 'Use the exact SHA-256 approval hash from the preview.');
  if (command === 'send' && opts.timeout !== 300 && !opts.wait) fail('INVALID_ARGUMENTS', 'Send timeout requires --wait.');
  return { command, opts };
}

export function resolveTarget(rows, opts) {
  let candidates;
  if (opts.session) candidates = rows.filter(row => row.sessionId === opts.session);
  else if (opts.bot !== undefined || opts.group !== undefined) {
    const ref = opts.bot ?? opts.group;
    const kind = opts.bot !== undefined ? 'bot' : 'group';
    candidates = rows.filter(row => row.part === 'current' && row.kind === kind && (row.targetId === ref || row.target === ref));
  } else fail('TARGET_REQUIRED', 'Specify the exact authorized Bot name/ID, group, or session.');
  if (!candidates.length) fail('TARGET_NOT_FOUND', 'The requested target was not found in this team.');
  if (candidates.length !== 1) fail('TARGET_AMBIGUOUS', 'The target is ambiguous; use an exact session ID.', { candidates });
  return candidates[0];
}

function capabilities(ready = true, live = false) {
  return { listBots: ready, listGroups: ready, listSessions: ready, readBotTextHistory: ready,
    readGroupHistory: false, prepareSend: ready, send: live, wait: live, query: live, groupSend: false, relay: false, liveApi: false, localIpc: live };
}

function health(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ status: 'unknown' });
  return new Promise(resolve => {
    let settled = false; let timer;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, res => {
      let bytes = 0;
      res.on('data', part => { bytes += part.length; if (bytes > 65536) { finish({ status: 'response-too-large' }); req.destroy(); } });
      res.on('error', () => finish({ status: 'unreachable' }));
      res.on('aborted', () => finish({ status: 'unreachable' }));
      res.on('end', () => finish({ status: 'responded', httpStatus: res.statusCode }));
      res.resume();
    });
    timer = setTimeout(() => { finish({ status: 'timeout' }); req.destroy(); }, 3000);
    req.on('error', () => finish({ status: 'unreachable' })); req.end();
  });
}

function stdinText() {
  if (process.stdin.isTTY) fail('TEXT_REQUIRED', 'Pipe the authorized message into standard input.');
  return new Promise((resolve, reject) => {
    let text = ''; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError); process.stdin.pause(); };
    const onError = () => { cleanup(); reject(new PreviewError('TEXT_READ_FAILED', 'Could not read message text from standard input.')); };
    const onData = part => { bytes += Buffer.byteLength(part); if (bytes > 65536) { cleanup(); reject(new PreviewError('TEXT_TOO_LARGE', 'Message text exceeds the CLI limit.')); } else text += part; };
    const onEnd = () => { cleanup(); resolve(text); };
    const timer = setTimeout(() => { cleanup(); reject(new PreviewError('TEXT_TIMEOUT', 'No complete message was received on standard input.')); }, 5000);
    process.stdin.setEncoding('utf8'); process.stdin.on('data', onData); process.stdin.once('end', onEnd); process.stdin.once('error', onError); process.stdin.resume();
  });
}

async function messageInput(opts) {
  if ((opts.text !== undefined) === Boolean(opts.textStdin)) fail('TEXT_REQUIRED', 'Provide one authorized message using --text or --text-stdin.', { sent: false });
  const text = String(opts.textStdin ? await stdinText() : opts.text).trim();
  if (!text || Buffer.byteLength(text) > 65536) fail('TEXT_REQUIRED', 'A nonempty message within the CLI size limit is required.', { sent: false });
  if (mask(text) !== text) fail('SENSITIVE_TEXT_DETECTED', 'The message appears to contain credentials; no text was printed or sent.', { sent: false });
  return text;
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (command === 'version') return { ok: true, version: CLI_VERSION };
  if (command === 'help') return { ok: true, version: CLI_VERSION, commands: [
    'status --json', 'capabilities --json', 'bots --json', 'groups --json',
    'sessions [--bot <exact name-or-id>] --json', 'resolve --bot <exact name-or-id> --json',
    'history (--session <id> | --bot <exact name-or-id>) [--limit 1..200] [--before-seq <seq>] [--show-text] --json',
    'send --dry-run (--bot <ref> | --session <current-id>) (--text <text> | --text-stdin) [--request-id <uuid>] --json',
    'send --bot <ref> --text <approved-text> --request-id <uuid> --expect-session <approved-session> --approval-hash <hash> [--wait --timeout 300 --show-text] --json',
    'query --request-id <original-uuid> [--session <bound-session>] [--show-text] --json',
    'wait --request-id <original-uuid> [--session <bound-session>] [--timeout 300] [--show-text] --json',
  ], mode: 'existing-instance-adapter', note: 'Real sends require an approved profile-local bridge and a target/content preview. Wait and query never resend.' };
  if (command === 'send' && !opts.dryRun && (!opts.requestId || !opts.approvalHash || !opts.expectedSession)) fail('SEND_APPROVAL_REQUIRED', 'Prepare a preview, obtain approval for its target and content, then supply its request ID, session and hash.', { sent: false });
  if (['wait', 'query'].includes(command) && !opts.requestId) fail('REQUEST_ID_REQUIRED', 'Specify the original request ID. No conversation was opened.', { sent: false });
  const loc = locations(); const facts = asarFacts(path.join(loc.install, 'resources', 'app.asar'));
  const ready = compatible(facts);
  const instanceId = instanceIdentity(loc, facts);
  let policy;
  try { policy = readPolicy(loc.dataDir); } catch (error) { if (error.code !== 'BRIDGE_NOT_CONFIGURED') throw error; }
  if (policy && policy.instanceId !== instanceId) fail('INSTANCE_MISMATCH', 'The bridge policy belongs to a different DS Bot installation.', { sent: false });
  if (command === 'status' || command === 'capabilities') {
    let bridge = { configured: Boolean(policy), ready: false };
    if (policy && ready) {
      try { const probe = await createTransport(policy).capabilities(); bridge = { configured: true, ready: probe.send === true && probe.wait === true, security: probe.security ?? null }; }
      catch { bridge = { configured: true, ready: false, error: 'BRIDGE_UNAVAILABLE' }; }
    }
    const mode = bridge.ready ? 'local-ipc' : 'local-read-only';
    if (command === 'capabilities') return { ok: true, mode, readOnlyReady: ready, bridge, capabilities: capabilities(ready, bridge.ready) };
    let port; try { port = readJson(path.join(loc.appData, 'host-port.json')).port; } catch { port = undefined; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) port = undefined;
    return { ok: true, cliVersion: CLI_VERSION, instanceId, mode, readOnlyReady: ready, bridge,
      versions: { app: facts.app, plugin: facts.plugin, dsh: facts.dsh }, install: loc.install,
      dataDir: loc.dataDir, workspace: loc.workspace,
      host: { address: port ? 'http://127.0.0.1:' + port : null, ...(await health(port)) },
      authentication: bridge.ready ? 'windows-logon-scoped-ipc' : 'current-windows-user-files', authenticatedApi: false, capabilities: capabilities(ready, bridge.ready) };
  }
  requireVersion(facts);
  if (command === 'send' && !opts.dryRun && policy) {
    const previous = new ReceiptStore({ directory: policy.clientReceiptDirectory }).read(opts.requestId);
    if (previous) {
      // Recover the original immutable binding even if the Bot was renamed or
      // moved to another segment. No current-chat lookup or new send is needed.
      if (opts.group || (opts.bot && ![previous.target.id, previous.target.name].includes(opts.bot)) || (opts.session && opts.session !== previous.target.sessionId)) {
        fail('ID_CONFLICT', 'This request ID already belongs to another target. Use query or wait with the original request ID.', { sent: null });
      }
      const plan = makePlan({ instanceId, requestId: opts.requestId, target: previous.target, text: await messageInput(opts) });
      const result = await createTransport(policy).send(plan, { approvalHash: opts.approvalHash, expectedSession: opts.expectedSession, wait: opts.wait,
        timeoutMs: Math.round(opts.timeout * 1000), showText: opts.showText, onProgress: value => process.stderr.write(JSON.stringify(value) + '\n') });
      if (result.replies) result.replies = result.replies.map(row => ({ ...row, text: mask(String(row.text ?? '')) }));
      return result;
    }
  }
  if (['wait', 'query'].includes(command)) {
    if (!policy) fail('BRIDGE_NOT_CONFIGURED', 'The approved bridge is not installed. No send was attempted.', { sent: false });
    const transport = createTransport(policy);
    const settings = { showText: opts.showText, sessionId: opts.session, timeoutMs: Math.round(opts.timeout * 1000), onProgress: value => process.stderr.write(JSON.stringify(value) + '\n') };
    const result = await transport[command](opts.requestId, settings);
    if (result.replies) result.replies = result.replies.map(row => ({ ...row, text: mask(String(row.text ?? '')) }));
    return result;
  }
  let team = readTeam(loc, opts.session);
  const rows = sessionRows(team);
  const brief = ({ id, name, sessionId }) => ({ id, name, sessionId });
  if (command === 'bots') return { ok: true, source: 'local-team-metadata', bots: team.bots.map(brief), groups: team.rooms.map(brief) };
  if (command === 'groups') return { ok: true, source: 'local-team-metadata', groups: team.rooms.map(brief) };
  if (command === 'sessions') {
    const target = opts.bot !== undefined || opts.group !== undefined ? resolveTarget(rows, opts) : null;
    return { ok: true, source: 'local-team-metadata', sessions: target ? rows.filter(row => row.targetId === target.targetId && row.kind === target.kind) : rows };
  }
  const target = resolveTarget(rows, opts);
  if (command === 'resolve') return { ok: true, source: 'local-team-metadata', target };
  if (command === 'send') {
    const text = await messageInput(opts);
    const current = rows.filter(row => row.targetId === target.targetId && row.kind === target.kind && row.part === 'current');
    if (current.length !== 1) fail('TARGET_AMBIGUOUS', 'The current send target could not be uniquely resolved.', { sent: false });
    if (target.sessionId !== current[0].sessionId) fail('SESSION_NOT_CURRENT', 'This is an earlier Bot session. Choose the current session explicitly before preparing a send.', { sent: false });
    const plan = makePlan({ instanceId, requestId: opts.requestId ?? crypto.randomUUID(), target, text });
    if (opts.dryRun) return { ok: true, operation: 'send-preview', dryRun: true, sent: false, deliveryState: 'not_sent',
      requestedTarget: target, target: plan.target, requestId: plan.requestId, instanceId, text: plan.wireText, wireHash: plan.wireHash, approvalHash: plan.approvalHash,
      requiresUserConfirmation: true, bridgeConfigured: Boolean(policy), transportVerified: false };
    if (!policy) fail('BRIDGE_NOT_CONFIGURED', 'The approved profile-local bridge is not installed. Nothing was sent.', { sent: false });
    const result = await createTransport(policy).send(plan, { approvalHash: opts.approvalHash, expectedSession: opts.expectedSession,
      wait: opts.wait, timeoutMs: Math.round(opts.timeout * 1000), showText: opts.showText, onProgress: value => process.stderr.write(JSON.stringify(value) + '\n') });
    if (result.replies) result.replies = result.replies.map(row => ({ ...row, text: mask(String(row.text ?? '')) }));
    return result;
  }
  if (target.kind !== 'bot') fail('GROUP_HISTORY_UNSUPPORTED', 'Group history has not been validated for this adapter.');
  if (!opts.session) team = readTeam(loc, target.sessionId);
  const events = archiveRecords(sessionPath(loc, target.sessionId), target.sessionId);
  const messages = visibleMessages(events, team.hiddenTurns, opts.showText);
  const eligible = opts.beforeSeq === undefined ? messages : messages.filter(row => row.seq < opts.beforeSeq);
  let start = Math.max(0, eligible.length - opts.limit);
  // Keep every block of the oldest included event so --before-seq never skips
  // a sibling text block from the same event on the next page.
  while (start > 0 && eligible[start - 1].seq === eligible[start].seq) start--;
  const page = eligible.slice(start);
  return { ok: true, source: 'local-persisted-session', liveApi: false, target,
    totalTextBlocks: messages.length, messages: page, nextBeforeSeq: start > 0 ? page[0].seq : null };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href === import.meta.url; }
  catch { return false; }
}

if (isEntrypoint()) {
  try { console.log(JSON.stringify({ ...(await main()), observedAt: new Date().toISOString() }, null, 2)); }
  catch (error) {
    const known = error instanceof PreviewError || error instanceof TransportError || error instanceof ProtocolError || error instanceof PipeRequestError;
    const code = known ? error.code : 'LOCAL_READ_FAILED';
    const message = known ? error.message : 'A local read failed; private file contents were not included in the error.';
    console.log(JSON.stringify({ ok: false, error: { code, message, details: known ? error.details ?? {} : {} }, observedAt: new Date().toISOString() }, null, 2));
    process.exitCode = /ARGUMENT|TARGET|SESSION_ID|TEXT_|SENSITIVE_|COMMAND_|SEND_APPROVAL|APPROVAL_|REQUEST_ID|INVALID_PLAN|UNSUPPORTED_GROUP/.test(code) ? 2 : /VERSION|PLATFORM|ASAR|USER_PROFILE|BRIDGE_NOT_CONFIGURED/.test(code) ? 3 : 4;
  }
}
