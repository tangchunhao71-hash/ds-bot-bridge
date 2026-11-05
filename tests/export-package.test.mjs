import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeBotIds, selectedBots, parseActivationArgs, patchedBytes, isManagedPatch, loadBuild } from '../scripts/bridge.mjs';
import { readAsarFile, originalClient, CLIENT_SHA256 } from '../lib/installed-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const first = 'session-fixture-bot-0001';
const second = 'session-fixture-bot-0002';

function temporary(t) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'dsbot-export-test-'));
  t.after(() => {
    const actual = fs.realpathSync(dir);
    assert.equal(path.dirname(actual), base);
    assert.ok(path.basename(actual).startsWith('dsbot-export-test-'));
    fs.rmSync(actual, { recursive: true });
  });
  return dir;
}

function archive(bytes, overrides = {}) {
  const entry = { size: bytes.length, offset: '0', ...overrides };
  const json = Buffer.from(JSON.stringify({ files: { node_modules: { files: { 'ds-bot': { files: { 'client.js': entry } } } } } }));
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + json.length, 4);
  header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, json, bytes]);
}

test('portable activation has no preselected Bot and hashes the explicit normalized list', () => {
  assert.deepEqual(normalizeBotIds([]), []);
  assert.deepEqual(normalizeBotIds([second, first, second]), [first, second]);
  assert.deepEqual(parseActivationArgs(['plan']), { action: 'plan', value: undefined, allowedBotIds: [] });
  assert.deepEqual(parseActivationArgs(['apply', 'a'.repeat(64), '--allow-bot', second, '--allow-bot', first]).allowedBotIds, [first, second]);
  assert.deepEqual(parseActivationArgs([]).action, 'help');
});

test('wildcards, malformed IDs and unrelated command flags cannot expand activation', () => {
  for (const ids of [['*'], ['session-../escape'], ['session-bad\n'], Array(65).fill(first)]) {
    assert.throws(() => normalizeBotIds(ids), { code: 'INVALID_ALLOWLIST' });
  }
  for (const args of [['plan', '--force'], ['verify', '--allow-bot', first], ['apply', 'bad'], ['rollback', '../escape']]) {
    assert.throws(() => parseActivationArgs(args));
  }
});

test('selected targets must be unique real Bots; groups and empty teams are refused', () => {
  const team = { bots: [{ id: first, name: 'Fixture One' }, { id: second, name: 'Fixture Two' }], rooms: [{ id: 'session-fixture-room-0001', name: 'Fixture Room' }] };
  assert.deepEqual(selectedBots([second], team), [{ id: second, name: 'Fixture Two' }]);
  assert.deepEqual(selectedBots([], team), []);
  assert.throws(() => selectedBots(['session-fixture-room-0001'], team), { code: 'ALLOW_BOT_NOT_FOUND' });
  assert.throws(() => selectedBots([first], { bots: [...team.bots, team.bots[0]] }), { code: 'ALLOW_BOT_NOT_FOUND' });
  assert.throws(() => selectedBots([], { bots: [] }), { code: 'NO_EXISTING_BOTS' });
});

test('static ASAR extraction is bounded and never executes archived JavaScript', t => {
  const dir = temporary(t);
  const file = path.join(dir, 'app.asar');
  const payload = Buffer.from('throw new Error("synthetic source must never execute");');
  fs.writeFileSync(file, archive(payload));
  assert.deepEqual(readAsarFile(file, 'node_modules/ds-bot/client.js'), payload);
  assert.throws(() => readAsarFile(file, '../client.js'), { code: 'INSTALLED_SOURCE_INVALID' });
  fs.writeFileSync(file, archive(payload, { offset: '999999999999999999' }));
  assert.throws(() => readAsarFile(file, 'node_modules/ds-bot/client.js'), { code: 'INSTALLED_SOURCE_INVALID' });
  fs.writeFileSync(file, archive(payload, { unpacked: true }));
  assert.throws(() => readAsarFile(file, 'node_modules/ds-bot/client.js'), { code: 'INSTALLED_SOURCE_INVALID' });
});

test('unreviewed frontend source fails before any deployment', t => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, 'resources'));
  fs.writeFileSync(path.join(dir, 'resources/app.asar'), archive(Buffer.from('synthetic mismatch')));
  assert.throws(() => originalClient(dir), { code: 'CLIENT_SOURCE_CHANGED' });
  assert.deepEqual(fs.readdirSync(dir), ['resources']);
});

test('rollback accepts only equivalent wrapping of the managed quoted path', t => {
  const dir = temporary(t);
  const plugin = path.join(dir, '示例 空间', 'local-plugins', 'ds-dot-bridge');
  const original = Buffer.from('# fixture original\r\n- id: fixture-other\r\n  name: fixture\r\n');
  const canonical = patchedBytes(original, plugin);
  const text = canonical.toString('utf8');
  const folded = Buffer.from(text.replace('runtime-wrapper.mjs', 'runtime-\\\n        wrapper.mjs').replace('# END', '\n# END'));
  assert.equal(isManagedPatch(original, canonical, plugin), true);
  assert.equal(isManagedPatch(original, folded, plugin), true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('rollback refuses changed original bytes, paths, fields and extra operations', t => {
  const dir = temporary(t);
  const original = Buffer.from('# immutable original\n');
  const text = patchedBytes(original, dir).toString('utf8');
  for (const altered of [
    text.replace('immutable original', 'later work'),
    text.replace('runtime-wrapper.mjs', 'different.mjs'),
    text.replace('disabled: true', 'disabled: false'),
    text + '\n- id: unrelated-new-entry\n',
    text.replace('  disabled: true', '  disabled: true\\\n'),
  ]) assert.equal(isManagedPatch(original, Buffer.from(altered), dir), false);
});

test('package includes unchanged protocol in both roles and frontend metadata without bundling another runtime', () => {
  assert.deepEqual(fs.readFileSync(path.join(root, 'lib/send-protocol.mjs')), fs.readFileSync(path.join(root, 'assets/bridge/lib/send-protocol.mjs')));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'assets/bridge/package.json')));
  assert.equal(metadata.dsh.client.platform, 'web');
  assert.equal(Object.hasOwn(metadata.dsh, 'bundle'), false);
  assert.equal(metadata.license, 'MIT');
  assert.deepEqual(fs.readFileSync(path.join(root, 'LICENSE')), fs.readFileSync(path.join(root, 'assets/bridge/LICENSE')));
  for (const name of ['THIRD_PARTY_NOTICES.md', 'LICENSE-DS-Bot.txt', 'NOTICE-DS-Bot.txt']) {
    assert.ok(fs.statSync(path.join(root, 'assets/bridge', name)).size > 0);
  }
  const wrapper = fs.readFileSync(path.join(root, 'assets/bridge/runtime-wrapper.mjs'), 'utf8');
  assert.ok(wrapper.includes(CLIENT_SHA256));
  assert.equal(fs.existsSync(path.join(root, 'assets/bridge/client.js')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'PACKAGE.json'))).defaultAllowedBotIds, []);
});

test('packaged manifest and its install payload are complete', () => {
  const build = loadBuild();
  assert.equal(build.version, '0.2.0');
  assert.ok(build.files['lib/installed-source.mjs']);
  assert.ok(build.files['assets/bridge/runtime-wrapper.mjs']);
  assert.ok(build.files['scripts/bridge.mjs']);
  assert.equal(Object.hasOwn(build.files, 'assets/bridge/client.js'), false);
});
