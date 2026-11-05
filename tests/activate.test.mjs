// Pure patch helpers only. Never call makePlan/applyPlan/rollback in these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchFragment, patchedBytes } from '../scripts/bridge.mjs';

function directory(t) {
  const base = path.resolve(os.tmpdir());
  const value = fs.mkdtempSync(path.join(base, 'dsbot-activate-pure-'));
  t.after(() => {
    const resolved = fs.realpathSync(value);
    assert.equal(path.dirname(resolved), fs.realpathSync(base));
    assert.ok(path.basename(resolved).startsWith('dsbot-activate-pure-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return value;
}
function rejected(original, pluginDirectory) {
  assert.throws(() => patchedBytes(Buffer.from(original, 'utf8'), pluginDirectory),
    error => ['PROFILE_PATCH_UNSUPPORTED', 'ORIGINAL_BOT_OVERRIDE_PRESENT'].includes(error.code));
}

test('patch helpers preserve exact original bytes and never write or enable an app', t => {
  const root = directory(t);
  const plugin = path.join(root, '中文 空间', 'ds-dot-bridge');
  const original = Buffer.from('\ufeff# SYNTHETIC ONLY\r\n# existing comments\r\n', 'utf8');
  const saved = Buffer.from(original);
  const result = patchedBytes(original, plugin);
  assert.deepEqual(original, saved);
  assert.deepEqual(result.subarray(0, original.length), original);
  assert.equal(result.toString('utf8').split('# BEGIN DS-DOT-BRIDGE-V1').length, 2);
  assert.deepEqual(fs.readdirSync(root), []);
  const fragment = patchFragment(plugin);
  const name = fragment.match(/^      name: (.+)$/m)?.[1];
  assert.equal(JSON.parse(name), path.join(plugin, 'runtime-wrapper.mjs').replaceAll('\\', '/'));
  assert.match(fragment, /- id: bot\n  name: ds-bot\n  disabled: true/);
  assert.match(fragment, /- id: ds-dot-bot-wrapper/);
});

test('empty/comment-only documents produce a preview without touching mock folders', t => {
  const root = directory(t);
  for (const original of ['', '# synthetic comment', '# one\n\n# two\n']) {
    const value = patchedBytes(Buffer.from(original), root).toString('utf8');
    assert.ok(value.startsWith(original));
    assert.match(value, /# END DS-DOT-BRIDGE-V1/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('invalid UTF-8, NUL, existing markers, mappings and explicit document markers reject', t => {
  const root = directory(t);
  assert.throws(() => patchedBytes(Buffer.from([0xc3, 0x28]), root));
  for (const original of ['# nul\0', '# DS-DOT-BRIDGE-V1', 'name: anything\n', '---\n- id: unrelated\n', '- id: unrelated\n...\n']) {
    rejected(original, root);
  }
});

test('existing direct original-Bot overrides reject rather than being silently disabled', t => {
  const root = directory(t);
  for (const original of [
    '- id: bot\n  name: ds-bot\n',
    '- id: "bot" # existing override\n  config: {}\n',
    "- id: 'bot'\n  disabled: false\n",
  ]) rejected(original, root);
});

test('reordered Bot override fields also reject', t => {
  const root = directory(t);
  rejected('- name: ds-bot\n  id: bot\n  config: { synthetic: true }\n', root);
});

test('flow-map and anchored Bot overrides fail closed', t => {
  const root = directory(t);
  for (const original of [
    '- { id: bot, name: ds-bot, disabled: false }\n',
    '- &existing\n  id: bot\n  name: ds-bot\n',
  ]) rejected(original, root);
});

test('document-end marker with a comment cannot hide a second document', t => {
  const root = directory(t);
  rejected('- id: unrelated\n... # end of synthetic document\n', root);
});

test('a generated patch cannot be appended twice', t => {
  const root = directory(t);
  const first = patchedBytes(Buffer.from('# synthetic\n'), root);
  assert.throws(() => patchedBytes(first, root), { code: 'PROFILE_PATCH_UNSUPPORTED' });
});
