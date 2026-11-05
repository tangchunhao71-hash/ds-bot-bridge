import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makePlan, createTransport, requireApproval } from '../lib/cli-transport.mjs';
import { ReceiptStore } from '../lib/send-protocol.mjs';

const target = { targetId: 'session-fixture-bot-0001', target: 'Fixture Bot', kind: 'bot', sessionId: 'session-fixture-current-0001' };
const requestId = '1cb1a5fa-bd54-4c77-a7c1-b7095d31ab91';
function fixture(t, override = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-dot-cli-test-'));
  t.after(() => { const real = fs.realpathSync(root); assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(real).startsWith('ds-dot-cli-test-')); fs.rmSync(real, { recursive: true }); });
  const policy = { instanceId: 'dsbot-fixture-0001', allowedBotIds: [target.targetId], clientReceiptDirectory: path.join(root, 'client') };
  const server = new ReceiptStore({ directory: path.join(root, 'server') });
  const plan = makePlan({ instanceId: policy.instanceId, requestId, target, text: '测试\nOnly ACK 🐾' });
  const calls = [];
  const rpc = async (_pipe, payload) => {
    calls.push(payload.action);
    if (payload.action === 'capabilities') return { ok: true, instanceId: policy.instanceId, send: true, wait: true };
    if (payload.action === 'send') {
      assert.equal(server.begin(plan).dispatchAllowed, true);
      server.update(requestId, { kind: 'accepted' });
    }
    return { ok: true, instanceId: policy.instanceId, receipt: server.read(requestId) };
  };
  const transport = createTransport(policy, { rpc, endpoint: () => ({ pipeName: 'ds-dot-bridge-fixture' }), ...override });
  return { root, policy, server, plan, calls, transport, settings: { approvalHash: plan.approvalHash, expectedSession: plan.target.sessionId } };
}

test('approved send dispatches once; repeated send queries the same request after process recreation', async t => {
  const f = fixture(t);
  const result = await f.transport.send(f.plan, f.settings);
  assert.equal(result.summary.transport, 'accepted');
  const duplicate = await f.transport.send(f.plan, f.settings);
  assert.equal(duplicate.duplicatePrevented, true);
  assert.deepEqual(f.calls, ['capabilities', 'send', 'query']);
  assert.equal(JSON.stringify(fs.readFileSync(path.join(f.root, 'client', fs.readdirSync(path.join(f.root, 'client')).find(x => x.endsWith('.intent.json'))), 'utf8')).includes('Only ACK'), false);
});

test('changed approval or session fails before probing or journaling', async t => {
  const f = fixture(t);
  await assert.rejects(f.transport.send(f.plan, { ...f.settings, approvalHash: '0'.repeat(64) }), { code: 'APPROVAL_MISMATCH' });
  assert.throws(() => requireApproval(f.plan, f.plan.approvalHash, 'session-other'), { code: 'SESSION_CHANGED' });
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.policy.clientReceiptDirectory), false);
});

test('preflight timeout submits no message or intent; explicit same-ID continuation dispatches once', async t => {
  let f; let failProbe = true; const actions = [];
  f = fixture(t, { rpc: async (_pipe, payload, options) => {
    actions.push(payload.action);
    if (payload.action === 'capabilities') {
      assert.equal(options.timeoutMs, 45000);
      assert.equal(Object.hasOwn(payload, 'text'), false);
      if (failProbe) throw Object.assign(new Error('private native diagnostic'), { code: 'PIPE_TIMEOUT', dispatchUnknown: true });
      return { ok: true, instanceId: f.policy.instanceId, send: true, wait: true };
    }
    if (payload.action === 'send') {
      assert.equal(f.server.begin(f.plan).dispatchAllowed, true);
      f.server.update(requestId, { kind: 'accepted' });
    }
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId) };
  } });
  await assert.rejects(f.transport.send(f.plan, f.settings), error => {
    assert.equal(error.code, 'BRIDGE_PREFLIGHT_FAILED');
    const { probe, ...details } = error.details;
    assert.deepEqual(details, { requestId, phase: 'capabilities', sent: false,
      dispatchAttempted: false, deliveryState: 'not_dispatched', retryAllowed: false, transportCode: 'PIPE_TIMEOUT' });
    assert.equal(probe.timeoutMs, 45000);
    assert.ok(probe.elapsedMs >= 0);
    assert.equal(probe.dispatchUnknown, true);
    assert.equal(probe.requestWritten, null);
    assert.equal(probe.sentBytes, null);
    assert.equal(JSON.stringify(error).includes('private native'), false);
    return true;
  });
  assert.deepEqual(actions, ['capabilities']);
  assert.equal(fs.existsSync(f.policy.clientReceiptDirectory), false);
  assert.equal(f.server.read(requestId), null);
  failProbe = false;
  assert.equal((await f.transport.send(f.plan, f.settings)).summary.transport, 'accepted');
  assert.equal((await f.transport.send(f.plan, f.settings)).duplicatePrevented, true);
  assert.deepEqual(actions, ['capabilities', 'capabilities', 'send', 'query']);
});

test('one send preflight allows native startup beyond the quick status budget without retrying', async t => {
  let f; const actions = [];
  f = fixture(t, { rpc: async (_pipe, payload, options) => {
    actions.push(payload.action);
    if (payload.action === 'capabilities') {
      if (options.timeoutMs < 8000) throw Object.assign(new Error('slow native startup'), { code: 'PIPE_TIMEOUT' });
      return { ok: true, instanceId: f.policy.instanceId, send: true, wait: true };
    }
    assert.equal(payload.action, 'send');
    assert.equal(f.server.begin(f.plan).dispatchAllowed, true);
    f.server.update(requestId, { kind: 'accepted' });
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId) };
  } });
  await assert.rejects(f.transport.capabilities(), { code: 'PIPE_TIMEOUT' });
  actions.length = 0;
  assert.equal((await f.transport.send(f.plan, f.settings)).summary.transport, 'accepted');
  assert.deepEqual(actions, ['capabilities', 'send']);
});

test('uncertain client write persists intent; a repeated command never retries send', async t => {
  let sendCount = 0;
  let f;
  f = fixture(t, { rpc: async (_pipe, payload) => {
    if (payload.action === 'capabilities') return { ok: true, instanceId: f.policy.instanceId, send: true, wait: true };
    if (payload.action === 'send') { sendCount++; f.server.begin(f.plan); f.server.update(requestId, { kind: 'accepted' }); throw Object.assign(new Error('private socket message'), { code: 'PIPE_TIMEOUT', dispatchUnknown: true, sentBytes: 1 }); }
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId) };
  } });
  await assert.rejects(f.transport.send(f.plan, f.settings), error => error.code === 'SEND_UNCONFIRMED' && error.details.sent === null && !error.message.includes('private'));
  assert.equal((await f.transport.send(f.plan, f.settings)).duplicatePrevented, true);
  assert.equal(sendCount, 1);
});

test('wait timeout never changes accepted delivery and performs no send', async t => {
  let elapsed = 0;
  const f = fixture(t, { now: () => elapsed, pause: async ms => { elapsed += ms; } });
  await f.transport.send(f.plan, f.settings);
  const before = f.calls.filter(x => x === 'send').length;
  const result = await f.transport.wait(requestId, { timeoutMs: 4 });
  assert.equal(result.timedOut, true);
  assert.equal(result.summary.transport, 'accepted');
  assert.equal(result.summary.retryAllowed, false);
  assert.equal(f.calls.filter(x => x === 'send').length, before);
});

test('query cannot choose a different session or an unrecorded request', async t => {
  const f = fixture(t);
  await assert.rejects(f.transport.query(requestId), { code: 'REQUEST_NOT_FOUND' });
  await f.transport.send(f.plan, f.settings);
  await assert.rejects(f.transport.query(requestId, { sessionId: 'session-other' }), { code: 'SESSION_MISMATCH' });
  assert.equal(f.calls.filter(x => x === 'query').length, 0);
});

test('repeated send --wait resumes even when new sends are no longer ready', async t => {
  let elapsed = 0; let f; let ready = true;
  f = fixture(t, { now: () => elapsed, pause: async ms => { elapsed += ms; }, rpc: async (_pipe, payload) => {
    f.calls.push(payload.action);
    if (payload.action === 'capabilities') return { ok: true, instanceId: f.policy.instanceId, send: ready, wait: true };
    if (payload.action === 'send') { f.server.begin(f.plan); f.server.update(requestId, { kind: 'accepted' }); }
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId) };
  } });
  await f.transport.send(f.plan, f.settings); ready = false;
  const result = await f.transport.send(f.plan, { ...f.settings, wait: true, timeoutMs: 2 });
  assert.equal(result.operation, 'wait'); assert.equal(result.timedOut, true); assert.equal(result.summary.transport, 'accepted');
  assert.deepEqual(f.calls, ['capabilities', 'send', 'query']);
});

test('explicit authenticated pre-dispatch rejection is recorded distinctly from network uncertainty', async t => {
  let f;
  f = fixture(t, { rpc: async (_pipe, payload) => payload.action === 'capabilities'
    ? { ok: true, instanceId: f.policy.instanceId, send: true, wait: true }
    : { ok: false, instanceId: f.policy.instanceId, sent: false, definitiveRejection: true, error: { code: 'SESSION_CHANGED' } } });
  await assert.rejects(f.transport.send(f.plan, f.settings), error => error.code === 'SESSION_CHANGED' && error.details.sent === false);
  const local = new ReceiptStore({ directory: f.policy.clientReceiptDirectory }).read(requestId);
  assert.equal(local.transport, 'rejected'); assert.equal(local.retryAllowed, false);
});

test('unbound reply and arbitrary response fields never reach CLI output', async t => {
  let f;
  f = fixture(t, { rpc: async (_pipe, payload) => {
    if (payload.action === 'capabilities') return { ok: true, instanceId: f.policy.instanceId, send: true, wait: true };
    if (payload.action === 'send') { f.server.begin(f.plan); f.server.update(requestId, { kind: 'accepted' }); }
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId), replies: [{ seq: 999, turn: 9, text: 'UNRELATED', extraSecret: 'PRIVATE' }] };
  } });
  await f.transport.send(f.plan, f.settings);
  await assert.rejects(f.transport.query(requestId, { showText: true }), error => error.code === 'REPLY_BINDING_INVALID' && !JSON.stringify(error).includes('PRIVATE'));
});

test('post-send journal failure preserves request ID and unknown delivery in the error', async t => {
  const f = fixture(t);
  const real = new ReceiptStore({ directory: f.policy.clientReceiptDirectory });
  const broken = { begin: plan => real.begin(plan), read: id => real.read(id), update: () => { throw Object.assign(new Error('private disk path'), { code: 'JOURNAL_WRITE_FAILED' }); } };
  const transport = createTransport(f.policy, { store: broken, endpoint: () => ({ pipeName: 'ds-dot-bridge-fixture' }), rpc: async (_pipe, payload) => {
    if (payload.action === 'capabilities') return { ok: true, instanceId: f.policy.instanceId, send: true, wait: true };
    f.server.begin(f.plan); f.server.update(requestId, { kind: 'accepted' });
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId) };
  } });
  await assert.rejects(transport.send(f.plan, f.settings), error => error.code === 'SEND_UNCONFIRMED' && error.details.requestId === requestId && error.details.sent === null && error.details.retryAllowed === false && !JSON.stringify(error).includes('private disk'));
});

test('standalone query clamps a CLI wait budget to the native per-request deadline', async t => {
  let f; const budgets = [];
  f = fixture(t, { rpc: async (_pipe, payload, options) => {
    assert.ok(options.timeoutMs <= 45000, 'Native client cannot accept the CLI 300-second wait budget');
    if (payload.action === 'capabilities') return { ok: true, instanceId: f.policy.instanceId, send: true, wait: true };
    if (payload.action === 'send') { f.server.begin(f.plan); f.server.update(requestId, { kind: 'accepted' }); }
    if (payload.action === 'query') budgets.push(options.timeoutMs);
    return { ok: true, instanceId: f.policy.instanceId, receipt: f.server.read(requestId) };
  } });
  await f.transport.send(f.plan, f.settings);
  assert.equal((await f.transport.query(requestId, { timeoutMs: 300000 })).summary.transport, 'accepted');
  assert.deepEqual(budgets, [45000]);
});
