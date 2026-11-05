/** Restricted text-only handoff carrier. Importing this module starts nothing. */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 256 * 1024;
const SAFE_ERRORS = Object.freeze({
  INVALID_REQUEST: 'The handoff request is invalid.',
  INVALID_PLAN: 'The explicit target or message preview is invalid.',
  APPROVAL_MISMATCH: 'The complete target and text must match the approved preview.',
  TARGET_NOT_ALLOWED: 'This Bot is outside the enabled target allowlist.',
  TARGET_CHANGED: 'The Bot name or current session changed; create a new preview.',
  GUARD_FAILED: 'The original Bot runtime is not safely disabled.',
  BRIDGE_DISPOSED: 'The handoff bridge is stopped.',
  DEADLINE_EXCEEDED: 'The operation deadline elapsed; query this request ID before any further send.',
  RECEIPT_NOT_FOUND: 'No bridge receipt exists for this request ID.',
  INSTANCE_MISMATCH: 'The receipt belongs to a different instance.',
  ID_CONFLICT: 'This request ID already binds a different target or text.',
  JOURNAL_CORRUPT: 'The local receipt is incomplete or corrupt; do not resend this request ID.',
  JOURNAL_WRITE_FAILED: 'The receipt could not be persisted; query delivery and do not resend.',
  JOURNAL_READ_FAILED: 'The receipt could not be read.',
  INVALID_STORE: 'The receipt store is unavailable.',
  SNAPSHOT_UNAVAILABLE: 'A complete, consistent snapshot is currently unavailable.',
  MAINTENANCE_BLOCKED: 'The Host maintenance gate did not admit this operation.',
  PRIVATE_CARRIER_REQUIRED: 'This route accepts only the private in-process handoff carrier.',
  TRANSPORT_UNKNOWN: 'Prompt admission is uncertain; query this request ID and do not resend.',
  UNSUPPORTED_GROUP_HANDOFF: 'This bridge version supports explicit Bot targets only.',
  INTERNAL: 'The bridge could not complete the operation.',
});

export class BridgeError extends Error {
  constructor(code) { super(SAFE_ERRORS[code] ?? SAFE_ERRORS.INTERNAL); this.code = code; }
}
function fail(code) { throw new BridgeError(code); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value, keys) {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}
function requestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value);
}
function checkSignal(signal) {
  if (signal?.aborted) fail('DEADLINE_EXCEEDED');
}
function safeError(error, sent = null) {
  const code = Object.hasOwn(SAFE_ERRORS, error?.code) ? error.code : 'INTERNAL';
  return { ok: false, error: { code, message: SAFE_ERRORS[code] }, sent,
    definitiveRejection: sent === false };
}

/** An activation marker written last must predate a new Host by one second. */
export function assertColdStart(marker, { instanceId, hostStartedAt }) {
  const completed = Date.parse(marker?.completedAt);
  if (marker?.schemaVersion !== 1 || marker.instanceId !== instanceId ||
      typeof marker.completedAt !== 'string' || !Number.isFinite(completed) ||
      !Number.isFinite(hostStartedAt) || hostStartedAt < completed + 1000) fail('GUARD_FAILED');
}

/** Carrier startup is optional after the one normal team runtime exists. */
export function settleCarrierStartupFailure({ runtimeCreated, close, warn }) {
  try { close(); } catch { /* Cleanup failures must not unload a working team. */ }
  if (!runtimeCreated) return false;
  try { warn?.('DS Bot handoff bridge is unavailable; the team runtime remains available.'); } catch {}
  return true;
}

/**
 * Exact routes receive no Peer argument. Keep this route private with an
 * unforgeable, single-use Request object identity, in addition to Connection's
 * owner check. HTTP requests and clones can never acquire this capability.
 */
export function createPrivateFetchRoute({ instanceId, peer, handle }) {
  const admitted = new WeakSet();
  return {
    async fetch(request) {
      if (!admitted.delete(request)) return Response.json({ ...safeError(new BridgeError('PRIVATE_CARRIER_REQUIRED')), instanceId }, { status: 403 });
      try {
        const text = await request.text();
        if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) fail('INVALID_REQUEST');
        return Response.json(await handle(JSON.parse(text), { signal: request.signal }));
      } catch {
        return Response.json({ ...safeError(new BridgeError('INVALID_REQUEST')), instanceId });
      }
    },
    async dispatch(handler, request) {
      admitted.add(request);
      try { return await handler.fetch(request, peer); }
      finally { admitted.delete(request); }
    },
  };
}

/**
 * Observe one explicitly addressed Session at a single read-only cut. DSH's
 * observeSession does not create/publish/resume an Agent. The observation owns
 * its lease and is released even when projection or sequence checks fail.
 */
export function createSnapshotReader({ sessionQuery }) {
  return async function readSnapshot(sessionId, { signal } = {}) {
    checkSignal(signal);
    let observation;
    try {
      observation = await sessionQuery.observeSession(sessionId, { signal });
      checkSignal(signal);
      const events = [...observation.events];
      const cursor = observation.cursor;
      const projections = observation.projections;
      if (observation.header?.id !== sessionId || !Number.isSafeInteger(cursor) ||
          cursor !== events.length - 1 || events.some((event, index) => event?.seq !== index) ||
          projections?.asOfSeq !== cursor || !record(projections.values) ||
          !Object.hasOwn(projections.values, 'inbox')) fail('SNAPSHOT_UNAVAILABLE');
      return { sessionId, events, inbox: projections.values.inbox, coverageComplete: true };
    } catch (error) {
      if (signal?.aborted) fail('DEADLINE_EXCEEDED');
      if (error instanceof BridgeError) throw error;
      fail('SNAPSHOT_UNAVAILABLE');
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  };
}

/**
 * Reuse the public Host maintenance waterfall after Windows pipe admission.
 * This is a truthful IPC carrier envelope, not an HTTP authentication exchange:
 * no socket is opened and no Cookie, launch token or Authorization is supplied.
 * The signature is (IncomingMessage, ServerResponse, next:()=>Promise<void>).
 * A listener's return value is not an admission boolean: only next() admits.
 */
export async function withMaintenanceGate(ctx, dispatch, { signal, path = '/api/bot/dot-handoff' } = {}) {
  checkSignal(signal);
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  socket.on('error', () => {});
  const request = new IncomingMessage(socket);
  request.method = 'POST';
  request.url = path;
  request.headers = { 'x-ds-bot-carrier': 'windows-logon-pipe' };
  request.complete = true;
  request.push(null);
  const response = new ServerResponse(request);
  response.on('error', () => {});
  response.assignSocket(socket);
  let delegated = false;
  let result;
  let completed = false;
  let abortListener;
  try {
    const work = Promise.resolve().then(() => ctx.waterfall('connection/request', request, response, async () => {
      checkSignal(signal);
      if (delegated || response.headersSent || response.writableEnded || response.statusCode >= 400) fail('MAINTENANCE_BLOCKED');
      delegated = true;
      result = await dispatch();
      completed = true;
      if (!response.writableEnded) response.end();
    }));
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(new BridgeError('DEADLINE_EXCEEDED'));
      signal?.addEventListener('abort', abortListener, { once: true });
      if (signal?.aborted) abortListener();
    });
    try { await (signal ? Promise.race([work, aborted]) : work); }
    catch (error) {
      // Once admission completed, a later wrapper failure cannot retract it.
      if (!completed) throw error;
    }
    if (!delegated || !completed) fail('MAINTENANCE_BLOCKED');
    return result;
  } finally {
    signal?.removeEventListener('abort', abortListener);
    request.destroy();
    response.destroy();
    socket.destroy();
  }
}

function replyText(snapshot, receipt, redact) {
  if (receipt.status === 'conflict' || receipt.anchor?.turn == null) return { replies: [] };
  const allowed = new Set(receipt.replySeqs);
  const replies = [];
  let bytesLeft = MAX_REPLY_BYTES;
  let truncated = false;
  for (const event of snapshot.events) {
    if (!allowed.has(event.seq) || event.type !== 'assistant/message' ||
        event.data?.turn !== receipt.anchor.turn || event.seq <= receipt.anchor.userSeq) continue;
    const blocks = event.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const text = redact(blocks.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'));
    const encoded = Buffer.from(text, 'utf8');
    if (encoded.length > bytesLeft) { truncated = true; break; }
    bytesLeft -= encoded.length;
    const time = Number.isFinite(event.time) ? new Date(event.time).toISOString() :
      typeof event.time === 'string' && Number.isFinite(Date.parse(event.time)) ? new Date(event.time).toISOString() : null;
    replies.push({ seq: event.seq, time, turn: event.data.turn, text });
  }
  return { replies, ...(truncated ? { truncated: true } : {}) };
}

/** All effects are injected so tests cannot accidentally contact a real Bot. */
export function createBridge({ rt, ctx, policy, store, prepare, reconcile, summarize, readSnapshot, guard }) {
  if (policy?.schemaVersion !== 1 || !requestId(policy.instanceId) ||
      !Array.isArray(policy.allowedBotIds) || policy.allowedBotIds.some(id => !requestId(id)) ||
      typeof guard !== 'function' || typeof readSnapshot !== 'function') fail('INVALID_REQUEST');
  const allowed = new Set(policy.allowedBotIds);
  const lifetime = new AbortController();
  let disposed = false;
  async function checkedGuard(signal) {
    if (disposed) fail('BRIDGE_DISPOSED');
    checkSignal(signal);
    if (await guard() === false) fail('GUARD_FAILED');
    if (disposed) fail('BRIDGE_DISPOSED');
    checkSignal(signal);
  }
  function pinned(plan) {
    if (!allowed.has(plan.target.id)) fail('TARGET_NOT_ALLOWED');
    const bot = rt.botOf(plan.target.id);
    if (!bot || bot.name !== plan.target.name || rt.chatOf(plan.target.id) !== plan.target.sessionId) fail('TARGET_CHANGED');
  }
  function response(receipt, extra = {}) {
    return { ok: true, instanceId: policy.instanceId, receipt, summary: summarize(receipt), ...extra };
  }
  function errorResponse(error, { receipt, definitive = false } = {}) {
    if (receipt?.instanceId !== policy.instanceId || !allowed.has(receipt?.target?.id)) receipt = undefined;
    return { ...safeError(error, definitive ? false : null), instanceId: policy.instanceId,
      ...(receipt ? { receipt, summary: summarize(receipt) } : {}) };
  }
  async function query(payload, signal) {
    let stored;
    try {
      if (!onlyKeys(payload, ['action', 'instanceId', 'requestId', 'showText']) || !requestId(payload.requestId) ||
          (payload.showText !== undefined && typeof payload.showText !== 'boolean')) fail('INVALID_REQUEST');
      await checkedGuard(signal);
      stored = store.read(payload.requestId);
      if (!stored) fail('RECEIPT_NOT_FOUND');
      if (stored.instanceId !== policy.instanceId) fail('INSTANCE_MISMATCH');
      if (!allowed.has(stored.target.id)) fail('TARGET_NOT_ALLOWED');
      // No payload-supplied Session is accepted. This address comes only from
      // the durable intent made before this bridge's one dispatch.
      const snapshot = await readSnapshot(stored.target.sessionId, { signal });
      await checkedGuard(signal);
      const observed = reconcile(stored, snapshot);
      const receipt = store.update(stored.requestId, { kind: 'reconciled', receipt: observed });
      stored = receipt;
      const redact = typeof rt.redactSecrets === 'function' ? value => rt.redactSecrets(value) : value => value;
      return response(receipt, payload.showText === true ? replyText(snapshot, receipt, redact) : {});
    } catch (error) {
      if (signal.aborted) error = new BridgeError('DEADLINE_EXCEEDED');
      return errorResponse(error, { receipt: stored?.instanceId === policy.instanceId && allowed.has(stored.target?.id) ? stored : undefined });
    }
  }
  async function send(payload, signal) {
    let intent;
    let knownReceipt;
    let attempted = false;
    try {
      if (!onlyKeys(payload, ['action', 'instanceId', 'requestId', 'target', 'text', 'approvalHash']) ||
          !onlyKeys(payload.target, ['id', 'name', 'kind', 'sessionId']) ||
          typeof payload.text !== 'string' || Buffer.byteLength(payload.text, 'utf8') > MAX_TEXT_BYTES) fail('INVALID_REQUEST');
      const plan = prepare({ instanceId: policy.instanceId, requestId: payload.requestId, target: payload.target, text: payload.text });
      if (typeof payload.approvalHash !== 'string' || payload.approvalHash !== plan.approvalHash) fail('APPROVAL_MISMATCH');
      if (!allowed.has(plan.target.id)) fail('TARGET_NOT_ALLOWED');
      await checkedGuard(signal);
      // An existing durable intent is a result lookup, including if the Bot
      // has moved to another part since that intent. It is never a new send.
      knownReceipt = store.read(plan.requestId);
      if (knownReceipt) {
        intent = store.begin(plan); // Also verifies the existing exact binding.
        return response(intent.receipt);
      }
      await rt.load();
      pinned(plan);
      checkSignal(signal);
      intent = store.begin(plan);
      if (!intent.dispatchAllowed) return response(intent.receipt);
      await rt.ensureCapabilities(plan.target.sessionId);
      await checkedGuard(signal);
      await rt.load();
      const guarded = guard();
      if (guarded === false || guarded?.then) fail('GUARD_FAILED');
      if (disposed) fail('BRIDGE_DISPOSED');
      // No await or dynamic target resolution is allowed after this last pin.
      // Unlike /api/bot action=send, prompt receives the exact approved Session.
      pinned(plan);
      checkSignal(signal);
      attempted = true;
      const accepted = await ctx.sessionController.prompt({
        requestId: plan.requestId,
        sessionId: plan.target.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: plan.wireText }],
      }, signal);
      if (accepted?.accepted !== true) fail('TRANSPORT_UNKNOWN');
      const receipt = store.update(plan.requestId, { kind: 'accepted' });
      return response(receipt);
    } catch (error) {
      if (signal.aborted) error = new BridgeError('DEADLINE_EXCEEDED');
      let receipt;
      if (intent?.dispatchAllowed) {
        try {
          receipt = store.update(intent.receipt.requestId, attempted
            ? { kind: 'unknown', code: 'TRANSPORT_UNKNOWN' }
            : { kind: 'rejected', definitive: true, code: Object.hasOwn(SAFE_ERRORS, error?.code) ? error.code : 'PRE_DISPATCH_FAILED' });
        } catch { /* A partial durable record continues to forbid replay. */ }
      }
      // false is a statement about this request ID, not just this invocation.
      // Only our exclusive, never-dispatched intent proves a final rejection.
      return errorResponse(error, { receipt: receipt ?? intent?.receipt ?? knownReceipt,
        definitive: intent?.dispatchAllowed === true && !attempted });
    }
  }
  return {
    async handle(payload, { signal } = {}) {
      const operation = AbortSignal.any([lifetime.signal, AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]);
      try {
        if (!record(payload) || typeof payload.action !== 'string') fail('INVALID_REQUEST');
        if (payload.instanceId !== policy.instanceId) fail('INSTANCE_MISMATCH');
        if (payload.action === 'capabilities') {
          if (!onlyKeys(payload, ['action', 'instanceId'])) fail('INVALID_REQUEST');
          await checkedGuard(operation);
          return { ok: true, instanceId: policy.instanceId, send: allowed.size > 0, wait: true,
            protocolVersion: 1, botOnly: true, callerRequestId: true, fixedSession: true,
            persistentCredential: false, taskOutcome: 'not_verified' };
        }
        if (payload.action === 'query') return await query(payload, operation);
        if (payload.action === 'send') return await send(payload, operation);
        fail('INVALID_REQUEST');
      } catch (error) {
        return errorResponse(operation.aborted ? new BridgeError('DEADLINE_EXCEEDED') : error);
      }
    },
    dispose() { disposed = true; lifetime.abort(); },
  };
}
