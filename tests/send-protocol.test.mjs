import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepare, ProtocolError, ReceiptStore, reconcile, summarize, TERMINAL_STATUSES } from '../lib/send-protocol.mjs';

const target = { id: 'bot-test', name: 'Synthetic Bot', kind: 'bot', sessionId: 'session-test' };
const text = 'SYNTHETIC-PRIVATE-TEXT-73ed9d';
function plan(overrides = {}) { return prepare({ instanceId: 'synthetic-instance', requestId: 'request-one', target, text, ...overrides }); }
function temporary(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'dsbot-protocol-'));
  assert.equal(path.dirname(path.resolve(directory)), tempRoot);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function receipt(t) { return new ReceiptStore({ directory: temporary(t) }).begin(plan()).receipt; }
function user(id = 'message-one', rpcId = 'request-one', body = text) {
  return { id, source: { kind: 'user', rpcId }, content: [{ type: 'text', text: body }] };
}
function event(seq, type, data) { return { seq, type, data }; }
function snapshot(events, inbox = [], extra = {}) { return { events, inbox, coverageComplete: true, sessionId: target.sessionId, ...extra }; }
function turnEvents({ reason = 'completed', reply = 'SYNTHETIC-REPLY-8419', interrupted = false, noText = false } = {}) {
  return [
    event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user()] }),
    event(2, 'turn/start', { turn: 7 }),
    event(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    event(4, 'user/message', user()),
    event(5, 'assistant/message', { turn: 7, step: 19, message: { id: 'assistant-one', content: noText ? [] : [{ type: 'text', text: reply }] }, ...(interrupted ? { interrupted: true } : {}) }),
    event(6, 'turn/end', { turn: 7, reason: { kind: reason } }),
  ];
}
function code(expected) { return error => error instanceof ProtocolError && error.code === expected; }

test('prepare binds full normalized text, exact target, request and instance', () => {
  const original = plan({ text: `  ${text}\n` });
  assert.equal(original.wireText, text);
  assert.equal(original.approvalHash, plan().approvalHash);
  assert.notEqual(original.approvalHash, plan({ requestId: 'request-two' }).approvalHash);
  assert.notEqual(original.approvalHash, plan({ instanceId: 'other' }).approvalHash);
  assert.notEqual(original.approvalHash, plan({ target: { ...target, sessionId: 'other' } }).approvalHash);
  assert.ok(Object.isFrozen(original));
  assert.throws(() => plan({ target: { ...target, kind: 'group' } }), code('UNSUPPORTED_GROUP_HANDOFF'));
  assert.throws(() => plan({ text: '  ' }), code('INVALID_PLAN'));
});

test('begin allows only the first caller and immutable existing intents never replay', async t => {
  const directory = temporary(t);
  const store = new ReceiptStore({ directory });
  const attempts = await Promise.all(Array.from({ length: 24 }, () => Promise.resolve().then(() => new ReceiptStore({ directory }).begin(plan()))));
  assert.equal(attempts.filter(result => result.dispatchAllowed).length, 1);
  assert.equal(store.begin(plan()).dispatchAllowed, false);
  assert.equal(store.read('request-one').status, 'unknown');
  assert.equal(store.read('missing'), null);
  assert.throws(() => store.begin(plan({ text: 'different text' })), code('ID_CONFLICT'));
  assert.throws(() => store.begin(plan({ target: { ...target, sessionId: 'different' } })), code('ID_CONFLICT'));
});

test('independent Node processes race for one durable intent without a duplicate dispatch', async t => {
  const directory = temporary(t);
  const moduleUrl = new URL('../lib/send-protocol.mjs', import.meta.url).href;
  const script = `import {prepare,ReceiptStore} from ${JSON.stringify(moduleUrl)};const p=prepare(${JSON.stringify({ instanceId: 'synthetic-instance', requestId: 'request-one', target, text })});try{console.log(JSON.stringify(new ReceiptStore({directory:process.argv[1]}).begin(p)));}catch(e){console.log(JSON.stringify({error:e.code}));}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('exit', exit => exit === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(results.filter(result => result.dispatchAllowed === true).length, 1);
  assert.ok(results.every(result => result.dispatchAllowed === false || result.dispatchAllowed === true || result.error === 'JOURNAL_CORRUPT'));
});

test('journal never contains prompt/reply text or arbitrary observation fields', t => {
  const directory = temporary(t);
  const store = new ReceiptStore({ directory });
  store.begin(plan());
  store.update('request-one', { kind: 'accepted', text, token: 'DO-NOT-STORE-TOKEN' });
  store.update('request-one', { kind: 'snapshot', snapshot: snapshot(turnEvents()) });
  const readAll = location => fs.readdirSync(location, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? readAll(path.join(location, entry.name)) : fs.readFileSync(path.join(location, entry.name), 'utf8'));
  const journal = readAll(directory).join('\n');
  assert.equal(journal.includes(text), false);
  assert.equal(journal.includes('SYNTHETIC-REPLY-8419'), false);
  assert.equal(journal.includes('DO-NOT-STORE-TOKEN'), false);
  assert.equal(store.read('request-one').status, 'reply_completed');
});

test('failed fsync prevents dispatch and retains an intent that cannot be replayed', t => {
  const directory = temporary(t);
  const io = { ...fs, fsyncSync() { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); } };
  assert.throws(() => new ReceiptStore({ directory, io }).begin(plan()), code('JOURNAL_WRITE_FAILED'));
  const recovery = new ReceiptStore({ directory }).begin(plan());
  assert.equal(recovery.dispatchAllowed, false);
  assert.equal(recovery.receipt.status, 'unknown');
});

test('a path/write failure has no successful dispatch reservation', t => {
  const directory = temporary(t);
  const blocker = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'synthetic');
  assert.throws(() => new ReceiptStore({ directory: blocker }).begin(plan()), code('JOURNAL_WRITE_FAILED'));
});

test('accepted is unanchored, transport uncertainty never requests another send', t => {
  const store = new ReceiptStore({ directory: temporary(t) });
  store.begin(plan());
  assert.equal(store.update('request-one', { kind: 'unknown', code: 'NETWORK_TIMEOUT' }).status, 'unknown');
  assert.equal(store.update('request-one', { kind: 'accepted' }).status, 'accepted_unanchored');
  assert.equal(store.update('request-one', { kind: 'unknown', code: 'NETWORK_TIMEOUT' }).status, 'accepted_unanchored');
  assert.equal(store.begin(plan()).dispatchAllowed, false);
  assert.equal(store.read('request-one').retryAllowed, false);
});

test('remote accepted receipt remains accepted in the independent client journal', t => {
  const server = new ReceiptStore({ directory: temporary(t) });
  const client = new ReceiptStore({ directory: temporary(t) });
  server.begin(plan());
  client.begin(plan());
  const remote = server.update('request-one', { kind: 'accepted' });
  const merged = client.update('request-one', { kind: 'reconciled', receipt: remote });
  assert.equal(merged.transport, 'accepted');
  assert.equal(merged.status, 'accepted_unanchored');
  const queried = client.update('request-one', { kind: 'snapshot', snapshot: snapshot([]) });
  assert.equal(queried.status, 'accepted_unanchored');
  assert.equal(queried.transport, 'accepted');
  assert.equal(client.begin(plan()).dispatchAllowed, false);
  assert.equal(TERMINAL_STATUSES.includes(queried.status), false);
});

test('an older remote accepted receipt contributes transport evidence without losing the local anchor', t => {
  const server = new ReceiptStore({ directory: temporary(t) });
  const client = new ReceiptStore({ directory: temporary(t) });
  server.begin(plan());
  client.begin(plan());
  client.update('request-one', { kind: 'snapshot', snapshot: snapshot(turnEvents()) });
  const remote = server.update('request-one', { kind: 'accepted' });
  const merged = client.update('request-one', { kind: 'reconciled', receipt: remote });
  assert.equal(merged.status, 'reply_completed');
  assert.equal(merged.transport, 'accepted');
  assert.equal(TERMINAL_STATUSES.includes(merged.status), true);
});

test('queued and running inputs use the actual rpcId/message and turn boundary', t => {
  const initial = receipt(t);
  const queued = reconcile(initial, snapshot([], { 'next-turn': [user()], 'next-step': [] }));
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.anchor, { rpcId: 'request-one', messageId: 'message-one', userSeq: null, turn: null });
  const running = reconcile(queued, snapshot(turnEvents().slice(0, 5)));
  assert.equal(running.status, 'running');
  assert.equal(running.anchor.turn, 7);
  assert.equal(running.anchor.userSeq, 4);
});

test('normal completion proves only reply turn completion and records no business success', t => {
  const result = reconcile(receipt(t), snapshot(turnEvents()));
  assert.equal(result.status, 'reply_completed');
  assert.equal(result.turnReason, 'completed');
  assert.deepEqual(result.replySeqs, [5]);
  assert.equal(result.taskOutcome, 'not_verified');
  assert.equal(result.completionScope, 'reply_turn');
  const noText = reconcile(receipt(t), snapshot(turnEvents({ noText: true })));
  assert.equal(noText.status, 'turn_completed_no_text');
});

test('interrupted/error/max-token/blocked/aborted terminal states never report complete', t => {
  const initial = receipt(t);
  assert.equal(reconcile(initial, snapshot(turnEvents({ interrupted: true }))).status, 'incomplete');
  for (const [reason, expected] of [['error', 'failed'], ['max-tokens', 'incomplete'], ['blocked', 'needs_attention'], ['aborted', 'canceled']]) {
    assert.equal(reconcile(initial, snapshot(turnEvents({ reason }))).status, expected);
  }
  assert.equal(reconcile(initial, snapshot(turnEvents(), [], { coverageComplete: false })).status, 'unknown');
});

test('queue edit, duplicate request and changed message identity fail closed', t => {
  const initial = receipt(t);
  assert.equal(reconcile(initial, snapshot([], [user('message-one', 'request-one', 'edited')])).code, 'INPUT_CHANGED');
  assert.equal(reconcile(initial, snapshot([], [user(), user('message-two')])).code, 'DUPLICATE_ANCHOR');
  const duplicate = turnEvents();
  duplicate.splice(4, 0, event(4.5, 'user/message', user()));
  // Noninteger seq is rejected before correlation.
  assert.equal(reconcile(initial, snapshot(duplicate)).code, 'INVALID_EVENT_SEQUENCE');
  const duplicated = turnEvents().map(item => ({ ...item, seq: item.seq * 2 }));
  duplicated.splice(4, 0, event(9, 'user/message', user()));
  assert.equal(reconcile(initial, snapshot(duplicated)).code, 'DUPLICATE_ANCHOR');
  const queued = reconcile(initial, snapshot([], [user()]));
  assert.equal(reconcile(queued, snapshot([], [user('replacement')])).code, 'ANCHOR_CHANGED');
});

test('same-turn user steering conflicts; an unrelated later queued turn does not', t => {
  const initial = receipt(t);
  const foreign = turnEvents().map(item => ({ ...item, seq: item.seq * 2 }));
  foreign.splice(4, 0, event(9, 'user/message', user('foreign', 'different-request', 'synthetic steering')));
  assert.equal(reconcile(initial, snapshot(foreign)).code, 'CONCURRENT_USER_INPUT');
  const later = [...turnEvents(), event(7, 'turn/start', { turn: 8 }), event(8, 'user/message', user('later', 'later-request', 'next task'))];
  assert.equal(reconcile(initial, snapshot(later)).status, 'reply_completed');
});

test('explicit queued cancellation is distinct from claim-before-admission crash', t => {
  const initial = receipt(t);
  const inserted = event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user()] });
  const removed = event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
  assert.equal(reconcile(initial, snapshot([inserted, removed])).status, 'canceled');
  const claimed = { ...removed, data: { ...removed.data, outcome: undefined } };
  const crash = reconcile(initial, snapshot([inserted, claimed]));
  assert.equal(crash.status, 'unknown');
  assert.equal(crash.code, 'CLAIMED_WITHOUT_ADMISSION');
  assert.equal(crash.retryAllowed, false);
});

test('session mismatch, malformed boundaries and assistant turn mismatch fail closed', t => {
  const initial = receipt(t);
  assert.equal(reconcile(initial, snapshot([], [], { sessionId: 'not-approved' })).code, 'SESSION_MISMATCH');
  const wrongAssistant = turnEvents();
  wrongAssistant[4].data.turn = 8;
  assert.equal(reconcile(initial, snapshot(wrongAssistant)).code, 'ASSISTANT_TURN_MISMATCH');
  const noStart = turnEvents().filter(item => item.type !== 'turn/start');
  assert.equal(reconcile(initial, snapshot(noStart)).status, 'unknown');
});

test('stale observations cannot replace newer evidence and conflicts remain sticky', t => {
  const store = new ReceiptStore({ directory: temporary(t) });
  store.begin(plan());
  store.update('request-one', { kind: 'snapshot', snapshot: snapshot(turnEvents()) });
  store.update('request-one', { kind: 'snapshot', snapshot: snapshot(turnEvents().slice(0, 5)) });
  assert.equal(store.read('request-one').status, 'reply_completed');
  const edited = turnEvents();
  edited[3].data = user('message-one', 'request-one', 'edited');
  assert.equal(store.update('request-one', { kind: 'snapshot', snapshot: snapshot(edited.slice(0, 5)) }).status, 'conflict');
  assert.equal(store.update('request-one', { kind: 'snapshot', snapshot: snapshot(turnEvents()) }).status, 'conflict');
  assert.throws(() => store.update('request-one', { kind: 'reconciled', receipt: { ...store.read('request-one'), approvalHash: plan({ text: 'other' }).approvalHash } }), code('INVALID_PLAN'));
});

test('an update cannot invent completion without concrete turn evidence', t => {
  const store = new ReceiptStore({ directory: temporary(t) });
  const initial = store.begin(plan()).receipt;
  assert.throws(() => store.update('request-one', { kind: 'reconciled', receipt: { ...initial, status: 'reply_completed' } }), code('INVALID_RECEIPT'));
  assert.throws(() => store.update('request-one', { kind: 'reconciled', receipt: { ...initial, ...plan({ requestId: 'other-request' }) } }), code('ID_CONFLICT'));
});

test('definitive rejection followed by acceptance is a conflict, never success', t => {
  const store = new ReceiptStore({ directory: temporary(t) });
  store.begin(plan());
  assert.equal(store.update('request-one', { kind: 'rejected', code: 'POLICY_DENIED', definitive: true }).status, 'failed');
  assert.equal(store.update('request-one', { kind: 'accepted' }).code, 'ACCEPTANCE_CONTRADICTION');
  const otherStore = new ReceiptStore({ directory: temporary(t) });
  otherStore.begin(plan());
  const rejected = otherStore.update('request-one', { kind: 'rejected', definitive: true });
  assert.equal(reconcile(rejected, snapshot(turnEvents())).code, 'ACCEPTANCE_CONTRADICTION');
});

test('a partial observation is unknown; a subsequent complete snapshot recovers without replay', t => {
  const directory = temporary(t);
  const store = new ReceiptStore({ directory });
  store.begin(plan());
  const locations = store.paths('request-one');
  fs.mkdirSync(locations.observations);
  fs.writeFileSync(path.join(locations.observations, '000000000001.json'), '{');
  assert.equal(store.read('request-one').status, 'unknown');
  assert.equal(store.update('request-one', { kind: 'snapshot', snapshot: snapshot(turnEvents()) }).status, 'reply_completed');
  assert.equal(store.begin(plan()).dispatchAllowed, false);
});

test('wait timeout is presentation metadata and never changes delivery or permits resend', t => {
  const result = reconcile(receipt(t), snapshot(turnEvents().slice(0, 5)));
  const original = JSON.stringify(result);
  const output = summarize(result, { timedOut: true });
  assert.equal(output.status, 'running');
  assert.equal(output.timedOut, true);
  assert.equal(output.retryAllowed, false);
  assert.equal(JSON.stringify(result), original);
  assert.equal('wireText' in output, false);
});
