/**
 * Text-only DS Bot handoff protocol. This module never sends a message.
 *
 * A durable, exclusive intent is the only source of dispatchAllowed=true.
 * An existing intent is never replayed, including after an uncertain crash.
 * Receipt files contain hashes and correlation metadata, never message text.
 * fsync protects application-crash recovery; power-loss guarantees also depend
 * on the filesystem/volume. A failed or partial journal fails closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = 1;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set([
  'dispatching', 'accepted_unanchored', 'queued', 'running',
  'reply_completed', 'turn_completed_no_text', 'needs_attention',
  'incomplete', 'failed', 'canceled', 'unknown', 'conflict',
]);
export const TERMINAL_STATUSES = Object.freeze([
  'reply_completed', 'turn_completed_no_text', 'needs_attention',
  'incomplete', 'failed', 'canceled', 'conflict',
]);
const TERMINAL = new Set(TERMINAL_STATUSES);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(code, message) { throw new ProtocolError(code, message); }
function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function identifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\0\r\n]/.test(value)) {
    fail('INVALID_PLAN', `${label} must be a nonempty, single-line string`);
  }
  return value;
}
function targetOf(target) {
  if (target?.kind === 'group' || target?.kind === 'room') {
    fail('UNSUPPORTED_GROUP_HANDOFF', 'Group handoff completion is not supported by this version');
  }
  if (target?.kind !== 'bot') fail('INVALID_PLAN', 'Only an explicit Bot target is supported');
  return {
    id: identifier(target.id, 'target.id'),
    name: identifier(target.name, 'target.name'),
    kind: 'bot',
    sessionId: identifier(target.sessionId, 'target.sessionId'),
  };
}
function approvalFor({ instanceId, requestId, target, wireHash }) {
  return digest(JSON.stringify([
    'ds-bot-send-v1', instanceId, requestId,
    target.id, target.name, target.kind, target.sessionId, wireHash,
  ]));
}
function bindingOf(value) {
  const binding = {
    instanceId: identifier(value?.instanceId, 'instanceId'),
    requestId: identifier(value?.requestId, 'requestId'),
    target: targetOf(value?.target),
    wireHash: value?.wireHash,
    approvalHash: value?.approvalHash,
  };
  if (!HASH.test(binding.wireHash ?? '') || !HASH.test(binding.approvalHash ?? '') ||
      approvalFor(binding) !== binding.approvalHash) {
    fail('INVALID_PLAN', 'Invalid request binding or approval hash');
  }
  return binding;
}
function sameBinding(left, right) {
  return left.requestId === right.requestId && left.approvalHash === right.approvalHash;
}
function now() { return new Date().toISOString(); }
function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]{1,96}$/.test(value) ? value : fallback;
}
function numberOrNull(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** The returned wireText is the full preview and the exact text to submit. */
export function prepare({ instanceId, requestId, target, text } = {}) {
  if (typeof text !== 'string' || text.trim() === '') fail('INVALID_PLAN', 'Message text must be nonempty');
  const wireText = text.trim(); // Matches the installed DS Bot send contract.
  const plan = {
    schemaVersion: VERSION,
    instanceId: identifier(instanceId, 'instanceId'),
    requestId: identifier(requestId, 'requestId'),
    target: Object.freeze(targetOf(target)),
    wireText,
    wireHash: digest(wireText),
  };
  plan.approvalHash = approvalFor(plan);
  return Object.freeze(plan);
}

function initialReceipt(plan) {
  const binding = bindingOf(plan);
  if (typeof plan.wireText !== 'string' || digest(plan.wireText) !== binding.wireHash) {
    fail('INVALID_PLAN', 'The complete wire text must match its approved hash');
  }
  const at = now();
  return {
    schemaVersion: VERSION, ...binding,
    status: 'dispatching', createdAt: at, updatedAt: at,
    transport: 'not_observed', code: null, anchor: null,
    replySeqs: [], assistantSeqs: [], turnReason: null,
    evidence: { throughSeq: -1, coverageComplete: false },
    retryAllowed: false, completionScope: 'reply_turn', taskOutcome: 'not_verified',
  };
}

// Explicit allowlist: arbitrary observation fields and text cannot reach disk.
function cleanReceipt(value) {
  const binding = bindingOf(value);
  if (value.schemaVersion !== VERSION || !STATUSES.has(value.status)) {
    fail('JOURNAL_CORRUPT', 'Unsupported or corrupt receipt');
  }
  const anchor = value.anchor === null || value.anchor === undefined ? null : {
    rpcId: identifier(value.anchor.rpcId, 'anchor.rpcId'),
    messageId: identifier(value.anchor.messageId, 'anchor.messageId'),
    userSeq: numberOrNull(value.anchor.userSeq),
    turn: numberOrNull(value.anchor.turn),
  };
  if (anchor && anchor.rpcId !== binding.requestId) fail('JOURNAL_CORRUPT', 'Receipt request anchor does not match');
  const seqs = items => [...new Set((Array.isArray(items) ? items : []).map(numberOrNull).filter(x => x !== null))].sort((a, b) => a - b);
  const throughSeq = Number.isSafeInteger(value.evidence?.throughSeq) && value.evidence.throughSeq >= -1
    ? value.evidence.throughSeq : -1;
  const result = {
    schemaVersion: VERSION, ...binding, status: value.status,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now(),
    transport: ['not_observed', 'accepted', 'unknown', 'rejected'].includes(value.transport) ? value.transport : 'unknown',
    code: value.code == null ? null : safeCode(value.code, 'UNCLASSIFIED'),
    anchor, replySeqs: seqs(value.replySeqs), assistantSeqs: seqs(value.assistantSeqs),
    turnReason: value.turnReason == null ? null : safeCode(value.turnReason, 'unknown'),
    evidence: { throughSeq, coverageComplete: value.evidence?.coverageComplete === true },
    retryAllowed: false, completionScope: 'reply_turn', taskOutcome: 'not_verified',
  };
  if (['running', 'reply_completed', 'turn_completed_no_text'].includes(result.status) &&
      (result.anchor?.userSeq == null || result.anchor?.turn == null)) {
    fail('INVALID_RECEIPT', 'A running or completed reply must have a concrete input and turn anchor');
  }
  if (['reply_completed', 'turn_completed_no_text'].includes(result.status) &&
      (!result.evidence.coverageComplete || result.turnReason !== 'completed' ||
       result.evidence.throughSeq < result.anchor.userSeq ||
       result.assistantSeqs.some(seq => seq <= result.anchor.userSeq || seq > result.evidence.throughSeq) ||
       result.replySeqs.some(seq => !result.assistantSeqs.includes(seq)) ||
       (result.status === 'reply_completed' && result.replySeqs.length === 0) ||
       (result.status === 'turn_completed_no_text' && result.replySeqs.length !== 0))) {
    fail('INVALID_RECEIPT', 'Reply completion requires complete, consistent turn evidence');
  }
  return result;
}

function setState(receipt, status, code = null) {
  return { ...receipt, status, code, updatedAt: now() };
}
function conflict(receipt, code) { return setState(receipt, 'conflict', code); }
function messageOf(data) { return data?.source ? data : data?.message?.source ? data.message : null; }
function userRequest(message, requestId) {
  return message?.source?.kind === 'user' && message.source.rpcId === requestId;
}
function messageHash(message) {
  const blocks = message?.content;
  return Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string'
    ? digest(blocks[0].text) : null;
}
function flattenInbox(inbox) {
  if (Array.isArray(inbox)) return inbox.map(item => item?.message ?? item);
  if (inbox && typeof inbox === 'object') {
    return [inbox.nextTurn ?? inbox['next-turn'], inbox.nextStep ?? inbox['next-step']]
      .flatMap(items => Array.isArray(items) ? items.map(item => item?.message ?? item) : []);
  }
  return [];
}
function reasonOf(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind;
  return ['completed', 'blocked', 'max-tokens', 'error', 'aborted'].includes(kind) ? kind : 'unknown';
}
function hasText(message) {
  return Array.isArray(message?.content) && message.content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '');
}

/**
 * Pure reconciliation. events must be original, ordered session-log events;
 * coverageComplete=true promises the complete log from its start through the
 * snapshot. inbox is the current pending projection, not log insertion history.
 * The function reads only the supplied snapshot and never performs I/O.
 */
export function reconcile(storedReceipt, { events = [], inbox = [], coverageComplete = false, sessionId } = {}) {
  let receipt = cleanReceipt(storedReceipt);
  if (receipt.status === 'conflict') return receipt; // Contradictory evidence is sticky.
  if (sessionId !== receipt.target.sessionId) return conflict(receipt, 'SESSION_MISMATCH');
  if (!Array.isArray(events)) return conflict(receipt, 'INVALID_EVENT_SEQUENCE');
  if (events.some(event => numberOrNull(event?.seq) === null)) return conflict(receipt, 'INVALID_EVENT_SEQUENCE');
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  if (sorted.some((event, index) =>
      (index > 0 && sorted[index - 1].seq === event.seq))) {
    return conflict(receipt, 'INVALID_EVENT_SEQUENCE');
  }
  receipt = {
    ...receipt, updatedAt: now(),
    evidence: { throughSeq: sorted.at(-1)?.seq ?? -1, coverageComplete: coverageComplete === true },
    replySeqs: [], assistantSeqs: [], turnReason: null,
  };
  const requestId = receipt.requestId;
  const pending = flattenInbox(inbox).filter(message => userRequest(message, requestId));
  const admitted = sorted.filter(event => event.type === 'user/message' && userRequest(messageOf(event.data), requestId));
  const inserted = sorted.flatMap(event => event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)
    ? event.data.inserted.filter(message => userRequest(message, requestId)) : []);
  const candidates = [...pending, ...admitted.map(event => messageOf(event.data)), ...inserted];
  if (candidates.length && receipt.transport === 'rejected') return conflict(receipt, 'ACCEPTANCE_CONTRADICTION');
  if (candidates.some(message => messageHash(message) !== receipt.wireHash)) return conflict(receipt, 'INPUT_CHANGED');
  if (candidates.some(message => typeof message.id !== 'string' || message.id === '')) return conflict(receipt, 'INVALID_MESSAGE_ID');
  const ids = new Set(candidates.map(message => message.id));
  if (ids.size > 1 || admitted.length > 1 || pending.length > 1) return conflict(receipt, 'DUPLICATE_ANCHOR');
  if (receipt.anchor && ids.size && !ids.has(receipt.anchor.messageId)) return conflict(receipt, 'ANCHOR_CHANGED');
  if (admitted.length && pending.length) return conflict(receipt, 'SNAPSHOT_INCONSISTENT');

  if (!admitted.length) {
    if (pending.length === 1) {
      receipt.anchor = { rpcId: requestId, messageId: pending[0].id, userSeq: null, turn: null };
      return setState(receipt, 'queued');
    }
    // Replay only queue identities to distinguish explicit cancellation from a
    // claim. A removed item without outcome='canceled' is not safe to resend.
    const queues = { 'next-turn': [], 'next-step': [] };
    let lastAction = null;
    for (const event of sorted) {
      if (event.type !== 'agent/inbox/spliced') continue;
      const data = event.data;
      const queue = queues[data?.target];
      if (!queue || !Number.isSafeInteger(data.start) || data.start < 0 || !Array.isArray(data.inserted)) continue;
      const removed = queue.splice(data.start, data.removedCount ?? 0, ...data.inserted);
      if (removed.some(message => userRequest(message, requestId))) lastAction = data.outcome === 'canceled' ? 'canceled' : 'claimed';
      if (data.inserted.some(message => userRequest(message, requestId))) lastAction = 'inserted';
    }
    if (coverageComplete === true && lastAction === 'canceled') return setState(receipt, 'canceled', 'INPUT_REMOVED');
    if (receipt.anchor?.userSeq !== null && receipt.anchor?.userSeq !== undefined) {
      return setState(receipt, 'unknown', 'ANCHOR_NOT_IN_SNAPSHOT');
    }
    return setState(receipt, receipt.transport === 'accepted' ? 'accepted_unanchored' : 'unknown',
      lastAction === 'claimed' ? 'CLAIMED_WITHOUT_ADMISSION' : 'NO_INPUT_ANCHOR');
  }

  const userEvent = admitted[0];
  const start = sorted.filter(event => event.type === 'turn/start' && event.seq < userEvent.seq).at(-1);
  const turn = numberOrNull(start?.data?.turn);
  if (turn === null) return setState(receipt, 'unknown', 'TURN_UNRESOLVED');
  const starts = sorted.filter(event => event.type === 'turn/start' && event.data?.turn === turn);
  const ends = sorted.filter(event => event.type === 'turn/end' && event.data?.turn === turn);
  if (starts.length !== 1 || ends.length > 1 || (ends[0] && ends[0].seq <= userEvent.seq)) {
    return conflict(receipt, 'INVALID_TURN_BOUNDARY');
  }
  if (receipt.anchor?.userSeq != null && receipt.anchor.userSeq !== userEvent.seq) return conflict(receipt, 'ANCHOR_CHANGED');
  if (receipt.anchor?.turn != null && receipt.anchor.turn !== turn) return conflict(receipt, 'ANCHOR_CHANGED');
  receipt.anchor = { rpcId: requestId, messageId: messageOf(userEvent.data).id, userSeq: userEvent.seq, turn };
  const end = ends[0];
  const nextStart = sorted.find(event => event.type === 'turn/start' && event.seq > start.seq);
  if (nextStart && (!end || nextStart.seq < end.seq)) return setState(receipt, 'unknown', 'OVERLAPPING_TURN_BOUNDARY');
  const inTurn = sorted.filter(event => event.seq > start.seq && (!end || event.seq < end.seq));
  if (inTurn.some(event => event.type === 'user/message' && messageOf(event.data)?.source?.kind === 'user' && !userRequest(messageOf(event.data), requestId))) {
    return conflict(receipt, 'CONCURRENT_USER_INPUT');
  }
  const assistants = inTurn.filter(event => event.type === 'assistant/message' && event.seq > userEvent.seq);
  if (assistants.some(event => event.data?.turn !== turn)) return conflict(receipt, 'ASSISTANT_TURN_MISMATCH');
  receipt.assistantSeqs = assistants.map(event => event.seq);
  receipt.replySeqs = assistants.filter(event => hasText(event.data?.message)).map(event => event.seq);
  if (!end) return setState(receipt, 'running');
  receipt.turnReason = reasonOf(end.data?.reason);
  if (coverageComplete !== true) return setState(receipt, 'unknown', 'INCOMPLETE_COVERAGE');
  if (assistants.some(event => event.data?.interrupted === true)) return setState(receipt, 'incomplete', 'INTERRUPTED_REPLY');
  switch (receipt.turnReason) {
    case 'completed': return setState(receipt, receipt.replySeqs.length ? 'reply_completed' : 'turn_completed_no_text');
    case 'blocked': return setState(receipt, 'needs_attention', 'TURN_BLOCKED');
    case 'max-tokens': return setState(receipt, 'incomplete', 'MAX_TOKENS');
    case 'error': return setState(receipt, 'failed', 'TURN_ERROR');
    case 'aborted': return setState(receipt, 'canceled', 'TURN_ABORTED');
    default: return setState(receipt, 'unknown', 'UNKNOWN_TURN_REASON');
  }
}

function mergeSnapshot(current, next) {
  if (!sameBinding(current, next)) fail('ID_CONFLICT', 'Observation does not match the existing request');
  if ((current.transport === 'rejected' && (next.transport === 'accepted' || next.anchor)) ||
      (next.transport === 'rejected' && (current.transport === 'accepted' || current.anchor))) {
    return conflict(current, 'ACCEPTANCE_CONTRADICTION');
  }
  // Remote accepted receipts are evidence too. Keep this monotonic even when
  // their event snapshot is older than the client's latest local snapshot.
  const transport = [current.transport, next.transport].includes('accepted') ? 'accepted'
    : [current.transport, next.transport].includes('rejected') ? 'rejected'
      : [current.transport, next.transport].includes('unknown') ? 'unknown' : 'not_observed';
  current = { ...current, transport };
  if (current.status === 'conflict') return current;
  if (next.status === 'conflict') return conflict(current, next.code ?? 'CONFLICTING_EVIDENCE');
  if (next.evidence.throughSeq < current.evidence.throughSeq) return current;
  if (next.evidence.throughSeq === current.evidence.throughSeq && current.evidence.coverageComplete && !next.evidence.coverageComplete) return current;
  if (current.anchor && next.anchor && (current.anchor.messageId !== next.anchor.messageId ||
      (current.anchor.userSeq != null && next.anchor.userSeq != null && current.anchor.userSeq !== next.anchor.userSeq))) {
    return conflict(current, 'ANCHOR_CHANGED');
  }
  return cleanReceipt({ ...next, createdAt: current.createdAt, transport });
}

function applyObservation(current, observation) {
  switch (observation.kind) {
    case 'accepted':
      if (current.transport === 'rejected') return conflict(current, 'ACCEPTANCE_CONTRADICTION');
      return cleanReceipt({ ...current, transport: 'accepted', updatedAt: observation.at,
        status: ['dispatching', 'unknown', 'accepted_unanchored'].includes(current.status) ? 'accepted_unanchored' : current.status,
        code: ['dispatching', 'unknown', 'accepted_unanchored'].includes(current.status) ? null : current.code });
    case 'unknown':
      return current.transport === 'accepted' || current.anchor || TERMINAL.has(current.status) ? current
        : cleanReceipt({ ...current, status: 'unknown', transport: 'unknown', code: observation.code, updatedAt: observation.at });
    case 'rejected':
      if (!observation.definitive) return applyObservation(current, { ...observation, kind: 'unknown' });
      if (current.anchor || current.transport === 'accepted') return conflict(current, 'ACCEPTANCE_CONTRADICTION');
      return cleanReceipt({ ...current, status: 'failed', transport: 'rejected', code: observation.code, updatedAt: observation.at });
    case 'reconciled': return mergeSnapshot(current, cleanReceipt(observation.receipt));
    default: fail('JOURNAL_CORRUPT', 'Unknown journal observation');
  }
}

/**
 * Synchronous, dependency-free local receipt store. await is also safe to use.
 * `io` is a filesystem adapter solely for fault-injection tests.
 * Each update is an immutable record with an exclusive numeric slot. Readers
 * fold slots in order; incomplete records fail closed, and a later complete
 * session snapshot can recover delivery without creating another dispatch.
 */
export class ReceiptStore {
  constructor({ directory, io = fs } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('INVALID_STORE', 'Receipt directory must be absolute');
    this.directory = directory;
    this.io = io;
  }

  paths(requestId) {
    const key = digest(identifier(requestId, 'requestId'));
    return { intent: path.join(this.directory, `${key}.intent.json`), observations: path.join(this.directory, `${key}.observations`) };
  }

  begin(plan) {
    const receipt = initialReceipt(plan);
    const locations = this.paths(receipt.requestId);
    let descriptor;
    try { this.io.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
    catch { fail('JOURNAL_WRITE_FAILED', 'Could not create the receipt directory; do not send'); }
    try {
      descriptor = this.io.openSync(locations.intent, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = this.read(receipt.requestId);
        if (!existing) fail('JOURNAL_CORRUPT', 'An exclusive intent exists but cannot be read');
        if (!sameBinding(existing, receipt)) fail('ID_CONFLICT', 'The request ID already binds different text or target');
        return { dispatchAllowed: false, receipt: existing };
      }
      fail('JOURNAL_WRITE_FAILED', 'Could not create the durable dispatch intent; do not send');
    }
    try {
      this.io.writeFileSync(descriptor, JSON.stringify(receipt) + '\n', 'utf8');
      this.io.fsyncSync(descriptor); // Must finish before dispatchAllowed=true.
      this.io.closeSync(descriptor);
      descriptor = undefined;
    } catch {
      // Keep even a partial exclusive intent. Removing it could permit replay.
      if (descriptor !== undefined) { try { this.io.closeSync(descriptor); } catch {} }
      fail('JOURNAL_WRITE_FAILED', 'Could not flush the dispatch intent; do not send or replay this ID');
    }
    return { dispatchAllowed: true, receipt: copy(receipt) };
  }

  read(requestId) {
    const locations = this.paths(requestId);
    let value;
    try { value = this.io.readFileSync(locations.intent, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('JOURNAL_READ_FAILED', 'Could not read the dispatch intent');
    }
    let receipt;
    try { receipt = cleanReceipt(JSON.parse(value)); }
    catch { fail('JOURNAL_CORRUPT', 'The existing dispatch intent is incomplete or corrupt; do not resend'); }
    if (receipt.requestId !== requestId) fail('JOURNAL_CORRUPT', 'Dispatch intent identity does not match');
    receipt = setState(receipt, 'unknown', 'DISPATCH_INTENT_ONLY');
    let names;
    try { names = this.io.readdirSync(locations.observations).filter(name => /^\d{12}\.json$/.test(name)).sort(); }
    catch (error) {
      if (error?.code === 'ENOENT') return receipt;
      fail('JOURNAL_READ_FAILED', 'Could not read receipt observations');
    }
    for (const name of names) {
      try {
        const observation = JSON.parse(this.io.readFileSync(path.join(locations.observations, name), 'utf8'));
        if (observation.requestId !== requestId || observation.schemaVersion !== VERSION) throw new Error('identity');
        receipt = applyObservation(receipt, observation);
      } catch {
        if (receipt.status !== 'conflict') receipt = setState(receipt, 'unknown', 'INCOMPLETE_JOURNAL_OBSERVATION');
      }
    }
    return cleanReceipt(receipt);
  }

  update(requestId, observation) {
    const current = this.read(requestId);
    if (!current) fail('RECEIPT_NOT_FOUND', 'No dispatch intent exists for this request');
    const record = { schemaVersion: VERSION, requestId, at: now(), kind: observation?.kind };
    switch (record.kind) {
      case 'accepted': break;
      case 'unknown': record.code = safeCode(observation.code, 'TRANSPORT_UNKNOWN'); break;
      case 'rejected':
        record.code = safeCode(observation.code, 'TRANSPORT_REJECTED');
        record.definitive = observation.definitive === true;
        break;
      case 'snapshot':
        record.kind = 'reconciled';
        record.receipt = cleanReceipt(reconcile(current, observation.snapshot));
        break;
      case 'reconciled':
        record.receipt = cleanReceipt(observation.receipt);
        if (!sameBinding(current, record.receipt)) fail('ID_CONFLICT', 'Receipt update has a different request binding');
        break;
      default: fail('INVALID_OBSERVATION', 'Unsupported receipt observation');
    }
    const locations = this.paths(requestId);
    let descriptor;
    try {
      this.io.mkdirSync(locations.observations, { recursive: true, mode: 0o700 });
      const names = this.io.readdirSync(locations.observations).filter(name => /^\d{12}\.json$/.test(name));
      let sequence = names.reduce((max, name) => Math.max(max, Number(name.slice(0, 12))), 0) + 1;
      while (descriptor === undefined) {
        if (sequence > 999999999999) throw new Error('journal exhausted');
        try { descriptor = this.io.openSync(path.join(locations.observations, `${String(sequence).padStart(12, '0')}.json`), 'wx', 0o600); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; sequence++; }
      }
      this.io.writeFileSync(descriptor, JSON.stringify(record) + '\n', 'utf8');
      this.io.fsyncSync(descriptor);
      this.io.closeSync(descriptor);
      descriptor = undefined;
    } catch {
      if (descriptor !== undefined) { try { this.io.closeSync(descriptor); } catch {} }
      fail('JOURNAL_WRITE_FAILED', 'Could not persist the observation; query delivery and do not resend');
    }
    return this.read(requestId);
  }
}

/** No waiting occurs here: timedOut is presentation metadata, not delivery. */
export function summarize(storedReceipt, { timedOut = false } = {}) {
  const receipt = cleanReceipt(storedReceipt);
  return {
    schemaVersion: VERSION, instanceId: receipt.instanceId, requestId: receipt.requestId,
    target: copy(receipt.target), approvalHash: receipt.approvalHash,
    status: receipt.status === 'dispatching' ? 'unknown' : receipt.status,
    code: receipt.code, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
    transport: receipt.transport, anchor: copy(receipt.anchor),
    replySeqs: [...receipt.replySeqs], assistantSeqs: [...receipt.assistantSeqs],
    turnReason: receipt.turnReason, evidence: copy(receipt.evidence),
    retryAllowed: false, timedOut: timedOut === true,
    completionScope: 'reply_turn', taskOutcome: 'not_verified',
  };
}
