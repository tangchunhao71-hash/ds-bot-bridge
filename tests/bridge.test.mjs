import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { assertColdStart, createBridge, createPrivateFetchRoute, createSnapshotReader, settleCarrierStartupFailure, withMaintenanceGate } from '../assets/bridge/index.mjs';
import { ReceiptStore, prepare, reconcile, summarize } from '../lib/send-protocol.mjs';

const INSTANCE = 'test-existing-instance';
const TARGET = Object.freeze({ id: 'bot-a', name: 'Mirror', kind: 'bot', sessionId: 'session-a' });
const TEXT = 'Synthetic approved handoff text';
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbot-bridge-test-'));
  t.after(() => {
    // Remove only the exact temporary directory made by this fixture.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('dsbot-bridge-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = new ReceiptStore({ directory });
  const plan = prepare({ instanceId: INSTANCE, requestId: 'handoff-1', target: TARGET, text: TEXT });
  const state = { sessionId: TARGET.sessionId, name: TARGET.name, calls: [], reads: [], loads: 0, ensures: 0 };
  const rt = {
    async load() { state.loads++; },
    botOf(id) { return id === TARGET.id ? { id, name: state.name, sessionId: state.sessionId } : undefined; },
    chatOf() { return state.sessionId; },
    async ensureCapabilities(sessionId) { state.ensures++; if (options.ensure) await options.ensure(state, sessionId); },
    redactSecrets: value => value.replaceAll('SYNTHETIC_SECRET', '[redacted]'),
  };
  const ctx = { sessionController: { async prompt(request, signal) {
    state.calls.push({ request, signal });
    if (options.prompt) return options.prompt(request, signal);
    return { accepted: true };
  } } };
  const policy = { schemaVersion: 1, instanceId: INSTANCE, allowedBotIds: [TARGET.id] };
  const readSnapshot = async (sessionId, { signal }) => {
    state.reads.push(sessionId);
    assert.ok(signal instanceof AbortSignal);
    if (options.read) return options.read(sessionId);
    return state.snapshot;
  };
  const bridge = createBridge({ rt, ctx, policy, store, prepare, reconcile, summarize, readSnapshot,
    guard: options.guard ?? (() => true) });
  t.after(() => bridge.dispose());
  return { state, bridge, store, plan, directory,
    send: (extra = {}) => bridge.handle({ action: 'send', instanceId: INSTANCE, requestId: plan.requestId,
      target: TARGET, text: TEXT, approvalHash: plan.approvalHash, ...extra }),
    query: (extra = {}) => bridge.handle({ action: 'query', instanceId: INSTANCE, requestId: plan.requestId, ...extra }),
  };
}
function events(requestId = 'handoff-1') {
  const time = Date.UTC(2026, 10, 4, 1, 2, 3);
  return [
    { seq: 0, time, type: 'session/start', data: {} },
    { seq: 1, time, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time, type: 'user/message', data: { id: 'message-1', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: TEXT }] } },
    { seq: 3, time, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ACK SYNTHETIC_SECRET' }] } } },
    { seq: 4, time, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

test('capabilities is inert and binds the requested instance', async t => {
  const f = fixture(t);
  const result = await f.bridge.handle({ action: 'capabilities', instanceId: INSTANCE });
  assert.equal(result.instanceId, INSTANCE);
  assert.equal(result.fixedSession, true);
  assert.equal(result.persistentCredential, false);
  assert.equal(f.state.loads + f.state.ensures + f.state.calls.length + f.state.reads.length, 0);
  const wrong = await f.bridge.handle({ action: 'capabilities', instanceId: 'other' });
  assert.equal(wrong.error.code, 'INSTANCE_MISMATCH');
  assert.equal(wrong.instanceId, INSTANCE);
});

test('send uses approved exact session, caller request ID and queue mode', async t => {
  const f = fixture(t);
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.instanceId, INSTANCE);
  assert.equal(result.receipt.transport, 'accepted');
  assert.equal(result.summary.status, 'accepted_unanchored');
  assert.equal(result.summary.taskOutcome, 'not_verified');
  assert.deepEqual(f.state.calls[0].request, { requestId: 'handoff-1', sessionId: 'session-a', mode: 'queue', content: [{ type: 'text', text: TEXT }] });
  assert.equal(f.state.ensures, 1);
  assert.deepEqual(f.state.reads, []);
});

test('hash change and unallowed target never dispatch', async t => {
  const f = fixture(t);
  const mismatch = await f.send({ text: `${TEXT} changed` });
  assert.equal(mismatch.error.code, 'APPROVAL_MISMATCH');
  const target = { ...TARGET, id: 'other-bot' };
  const plan = prepare({ instanceId: INSTANCE, requestId: 'other', target, text: TEXT });
  const denied = await f.send({ requestId: 'other', target, approvalHash: plan.approvalHash });
  assert.equal(denied.error.code, 'TARGET_NOT_ALLOWED');
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.store.read('handoff-1'), null);
});

test('same-name Bot with changed current Session is never rerouted', async t => {
  const f = fixture(t);
  f.state.sessionId = 'new-session';
  const result = await f.send();
  assert.equal(result.error.code, 'TARGET_CHANGED');
  assert.equal(f.state.calls.length, 0);
});

test('session rotation during capability await is definitively rejected', async t => {
  const f = fixture(t, { ensure: async state => { await Promise.resolve(); state.sessionId = 'new-session'; } });
  const result = await f.send();
  assert.equal(result.error.code, 'TARGET_CHANGED');
  assert.equal(result.sent, false);
  assert.equal(result.definitiveRejection, true);
  assert.equal(result.instanceId, INSTANCE);
  assert.equal(result.receipt.transport, 'rejected');
  assert.equal(f.state.calls.length, 0);
});

test('original runtime guard is rechecked after the last asynchronous load', async t => {
  let active = false;
  const f = fixture(t, { guard: () => !active });
  const bridge = createBridge({
    rt: { async load() { if (++f.state.loads === 2) active = true; },
      botOf: () => ({ name: TARGET.name }), chatOf: () => TARGET.sessionId,
      ensureCapabilities: async () => {} },
    ctx: { sessionController: { prompt() { assert.fail('must not dispatch'); } } },
    policy: { schemaVersion: 1, instanceId: INSTANCE, allowedBotIds: [TARGET.id] },
    store: f.store, prepare, reconcile, summarize, readSnapshot: async () => {}, guard: () => !active,
  });
  t.after(() => bridge.dispose());
  const result = await bridge.handle({ action: 'send', instanceId: INSTANCE, requestId: f.plan.requestId,
    target: TARGET, text: TEXT, approvalHash: f.plan.approvalHash });
  assert.equal(result.error.code, 'GUARD_FAILED');
  assert.equal(result.definitiveRejection, true);
});

test('unknown prompt failure retains receipt and never permits replay', async t => {
  const f = fixture(t, { prompt: async () => { throw new Error('SYNTHETIC_SECRET must never be returned'); } });
  const first = await f.send();
  assert.equal(first.ok, false);
  assert.equal(first.sent, null);
  assert.equal(first.definitiveRejection, false);
  assert.equal(first.receipt.status, 'unknown');
  assert.ok(!JSON.stringify(first).includes('SYNTHETIC_SECRET'));
  const second = await f.send();
  assert.equal(second.ok, true);
  assert.equal(second.receipt.status, 'unknown');
  assert.equal(f.state.calls.length, 1);
});

test('repeat send after session rotation returns original accepted receipt', async t => {
  const f = fixture(t);
  await f.send();
  f.state.sessionId = 'new-session';
  const repeated = await f.send();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.receipt.target.sessionId, 'session-a');
  assert.equal(repeated.receipt.transport, 'accepted');
  assert.equal(f.state.calls.length, 1);
});

test('simultaneous identical sends dispatch at most once', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.send(), f.send()]);
  assert.equal(results.filter(result => result.ok).length, 2);
  assert.equal(f.state.calls.length, 1);
});

test('query accepts no arbitrary Session and reads only receipt-bound history', async t => {
  const f = fixture(t);
  await f.send();
  const forged = await f.query({ sessionId: 'unrelated' });
  assert.equal(forged.error.code, 'INVALID_REQUEST');
  assert.deepEqual(f.state.reads, []);
  f.state.snapshot = { sessionId: 'session-a', coverageComplete: true, events: events(), inbox: { 'next-turn': [], 'next-step': [] } };
  const result = await f.query();
  assert.equal(result.ok, true);
  assert.deepEqual(f.state.reads, ['session-a']);
  assert.equal(result.summary.status, 'reply_completed');
  assert.ok(!Object.hasOwn(result, 'replies'));
  assert.ok(!JSON.stringify(result).includes(TEXT));
});

test('showText returns only related seq text, UTC time and redacted known secrets', async t => {
  const f = fixture(t);
  await f.send();
  f.state.snapshot = { sessionId: 'session-a', coverageComplete: true, events: [...events(),
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'unrelated reply' }] } } },
    { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ], inbox: [] };
  const result = await f.query({ showText: true });
  assert.deepEqual(result.replies, [{ seq: 3, time: '2026-11-04T01:02:03.000Z', turn: 1, text: 'ACK [redacted]' }]);
  assert.ok(!JSON.stringify(result).includes('unrelated reply'));
});

test('query read failure preserves server accepted evidence', async t => {
  const f = fixture(t, { read: async () => { throw new Error('SYNTHETIC_SECRET'); } });
  await f.send();
  const result = await f.query();
  assert.equal(result.ok, false);
  assert.equal(result.instanceId, INSTANCE);
  assert.equal(result.sent, null);
  assert.equal(result.receipt.transport, 'accepted');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
});

test('journal files never include submitted text or returned reply text', async t => {
  const f = fixture(t);
  await f.send();
  f.state.snapshot = { sessionId: 'session-a', coverageComplete: true, events: events(), inbox: [] };
  await f.query({ showText: true });
  function collect(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? collect(path.join(directory, entry.name)) : [fs.readFileSync(path.join(directory, entry.name), 'utf8')]); }
  const journal = collect(f.directory).join('\n');
  assert.ok(!journal.includes(TEXT));
  assert.ok(!journal.includes('ACK '));
});

test('disposed bridge cannot load, read or send', async t => {
  const f = fixture(t);
  f.bridge.dispose();
  const result = await f.send();
  assert.equal(result.ok, false);
  assert.equal(result.instanceId, INSTANCE);
  assert.equal(f.state.calls.length + f.state.loads + f.state.reads.length, 0);
});

test('snapshot reader uses one cold-safe observation and always releases it', async () => {
  let releases = 0;
  const observed = events();
  const reader = createSnapshotReader({ sessionQuery: { async observeSession(id) {
    assert.equal(id, 'session-a');
    return { header: { id }, cursor: 4, events: observed, projections: { asOfSeq: 4, values: { inbox: [] } },
      [Symbol.dispose]() { releases++; } };
  } } });
  const snapshot = await reader('session-a', { signal: new AbortController().signal });
  assert.equal(snapshot.coverageComplete, true);
  assert.deepEqual(snapshot.events, observed);
  assert.equal(releases, 1);
});

test('snapshot reader rejects different cuts, incomplete coverage and wrong Session', async () => {
  for (const override of [{ projections: { asOfSeq: 3, values: { inbox: [] } } }, { cursor: 9 }, { header: { id: 'other' } }]) {
    let released = false;
    const reader = createSnapshotReader({ sessionQuery: { async observeSession() {
      return { header: { id: 'session-a' }, cursor: 4, events: events(), projections: { asOfSeq: 4, values: { inbox: [] } },
        ...override, [Symbol.dispose]() { released = true; } };
    } } });
    await assert.rejects(reader('session-a'), { code: 'SNAPSHOT_UNAVAILABLE' });
    assert.equal(released, true);
  }
});

test('maintenance gate uses exact public signature without authentication headers', async () => {
  let calls = 0;
  const ctx = { async waterfall(event, request, response, next) {
    assert.equal(event, 'connection/request');
    assert.ok(request instanceof IncomingMessage);
    assert.ok(response instanceof ServerResponse);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-ds-bot-carrier'], 'windows-logon-pipe');
    await next();
  } };
  const result = await withMaintenanceGate(ctx, async () => { calls++; return { accepted: true }; });
  assert.deepEqual(result, { accepted: true });
  assert.equal(calls, 1);
});

test('maintenance refusal never dispatches and return truthiness is irrelevant', async () => {
  let calls = 0;
  const ctx = { async waterfall(_event, _request, response) { response.statusCode = 503; response.end(); return true; } };
  await assert.rejects(withMaintenanceGate(ctx, async () => { calls++; }), { code: 'MAINTENANCE_BLOCKED' });
  assert.equal(calls, 0);
});

test('a delayed maintenance next cannot dispatch after caller deadline', async () => {
  let unblock;
  let calls = 0;
  const blocker = new Promise(resolve => { unblock = resolve; });
  const controller = new AbortController();
  const ctx = { async waterfall(_event, _request, _response, next) { await blocker; return next(); } };
  const result = withMaintenanceGate(ctx, async () => { calls++; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: 'DEADLINE_EXCEEDED' });
  unblock();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('maintenance failures after completed admission retain its result', async () => {
  let calls = 0;
  const ctx = { async waterfall(_event, _request, _response, next) { await next(); throw new Error('late wrapper failure'); } };
  const result = await withMaintenanceGate(ctx, async () => { calls++; return { accepted: true }; });
  assert.deepEqual(result, { accepted: true });
  assert.equal(calls, 1);
});

test('cold-start marker rejects missing, foreign, hot or too-early Hosts', () => {
  const completedAt = '2026-11-04T01:02:03.000Z';
  const completed = Date.parse(completedAt);
  const marker = { schemaVersion: 1, instanceId: INSTANCE, completedAt };
  for (const [value, start] of [[undefined, completed + 2000], [{ ...marker, instanceId: 'other' }, completed + 2000],
    [marker, completed - 1], [marker, completed + 999], [{ ...marker, completedAt: 'invalid' }, completed + 2000]]) {
    assert.throws(() => assertColdStart(value, { instanceId: INSTANCE, hostStartedAt: start }), { code: 'GUARD_FAILED' });
  }
  assert.doesNotThrow(() => assertColdStart(marker, { instanceId: INSTANCE, hostStartedAt: completed + 1000 }));
});

test('helper or endpoint startup failure closes the carrier but retains a created team', () => {
  let closed = 0;
  const warnings = [];
  const keepRuntime = settleCarrierStartupFailure({ runtimeCreated: true, close() { closed++; }, warn(message) { warnings.push(message); } });
  assert.equal(keepRuntime, true);
  assert.equal(closed, 1);
  assert.deepEqual(warnings, ['DS Bot handoff bridge is unavailable; the team runtime remains available.']);
  assert.equal(settleCarrierStartupFailure({ runtimeCreated: true, close() { throw new Error('SYNTHETIC_SECRET'); }, warn() { throw new Error('log failure'); } }), true);
});

test('a failed pre-runtime source or activation guard never becomes a running fallback', () => {
  let closed = false;
  let warned = false;
  assert.equal(settleCarrierStartupFailure({ runtimeCreated: false, close() { closed = true; }, warn() { warned = true; } }), false);
  assert.equal(closed, true);
  assert.equal(warned, false);
});

test('private exact route rejects authenticated HTTP requests without reading their body', async () => {
  let calls = 0;
  const route = createPrivateFetchRoute({ instanceId: INSTANCE, peer: { principal: { kind: 'owner' } }, handle: async () => { calls++; } });
  const request = new Request('http://127.0.0.1/api/bot/dot-handoff', { method: 'POST', body: JSON.stringify({ action: 'capabilities', instanceId: INSTANCE }) });
  const response = await route.fetch(request);
  assert.equal(response.status, 403);
  assert.equal(request.bodyUsed, false);
  assert.equal((await response.json()).instanceId, INSTANCE);
  assert.equal(calls, 0);
});

test('private carrier keeps the same Request and dedicated owner Peer, then consumes capability', async () => {
  const peer = { principal: { kind: 'owner' }, interactions: 'none' };
  let calls = 0;
  const route = createPrivateFetchRoute({ instanceId: INSTANCE, peer, handle: async payload => { calls++; return { ok: true, instanceId: INSTANCE, action: payload.action }; } });
  const request = new Request('http://dsbot-ipc.invalid/api/bot/dot-handoff', { method: 'POST', body: JSON.stringify({ action: 'capabilities', instanceId: INSTANCE }) });
  const handler = { async fetch(value, suppliedPeer) { assert.equal(value, request); assert.equal(suppliedPeer, peer); return route.fetch(value); } };
  const response = await route.dispatch(handler, request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal((await route.fetch(request)).status, 403);
  assert.equal(calls, 1);
});

test('a request clone with identical URL/body/headers cannot inherit private admission', async () => {
  let calls = 0;
  const route = createPrivateFetchRoute({ instanceId: INSTANCE, peer: { principal: { kind: 'owner' } }, handle: async () => { calls++; } });
  const request = new Request('http://dsbot-ipc.invalid/api/bot/dot-handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const handler = { fetch(value) { return route.fetch(value.clone()); } };
  assert.equal((await route.dispatch(handler, request)).status, 403);
  assert.equal((await route.fetch(request)).status, 403);
  assert.equal(calls, 0);
});
