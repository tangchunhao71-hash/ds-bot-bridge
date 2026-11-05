import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare, ReceiptStore, summarize } from './send-protocol.mjs';
import { DEFAULT_PIPE_TIMEOUT_MS, requestPipe, validatePipeName } from './pipe-client.mjs';

export class TransportError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TransportError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new TransportError(code, message, details); };
const TERMINAL = new Set(['reply_completed', 'turn_completed_no_text', 'needs_attention', 'incomplete', 'failed', 'canceled', 'conflict']);

export function policyFile(dataDir) {
  return path.join(dataDir, 'profiles', 'ds-bot', 'local-plugins', 'ds-dot-bridge', 'policy.json');
}

// Configuration contains no login material. Do not search for an alternative
// credential or transport if the approved profile-local integration is absent.
export function readPolicy(dataDir) {
  const file = policyFile(dataDir);
  let policy;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { fail('BRIDGE_NOT_CONFIGURED', 'The approved DS Bot bridge is not installed in the existing profile.', { sent: false }); }
  if (policy.schemaVersion !== 1 || typeof policy.instanceId !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(policy.instanceId)
      || !Array.isArray(policy.allowedBotIds) || policy.allowedBotIds.some(id => typeof id !== 'string')
      || !path.isAbsolute(policy.receiptDirectory || '') || !path.isAbsolute(policy.clientReceiptDirectory || '')
      || !path.isAbsolute(policy.pwshPath || '') || !/^[a-f0-9]{64}$/.test(policy.helperSha256 || '')) {
    fail('BRIDGE_POLICY_INVALID', 'The profile-local bridge policy is invalid.', { sent: false });
  }
  const base = path.resolve(dataDir, 'integrations', 'ds-dot-bridge');
  for (const folder of [policy.receiptDirectory, policy.clientReceiptDirectory]) {
    const rel = path.relative(base, path.resolve(folder));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('BRIDGE_POLICY_INVALID', 'Receipt storage is outside the approved integration directory.', { sent: false });
  }
  return { ...policy, pluginDirectory: path.dirname(file) };
}

export function readEndpoint(policy) {
  let value;
  const helperPath = path.join(policy.pluginDirectory, 'pipe-helper.ps1');
  try {
    const bytes = fs.readFileSync(helperPath);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== policy.helperSha256) throw new Error();
    const file = path.join(policy.pluginDirectory, 'endpoint.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 8192) throw new Error();
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { fail('BRIDGE_NOT_RUNNING', 'The existing DS Bot bridge is stopped or its native helper failed integrity validation.', { sent: false }); }
  if (value.schemaVersion !== 1 || value.instanceId !== policy.instanceId || !Number.isInteger(value.helperPid) || value.helperPid < 1) fail('BRIDGE_ENDPOINT_INVALID', 'The profile-local bridge endpoint is invalid.', { sent: false });
  validatePipeName(value.pipeName);
  return { pipeName: value.pipeName, expectedServerPid: value.helperPid, pwshPath: policy.pwshPath, helperPath };
}

export function makePlan({ instanceId, requestId, target, text }) {
  return prepare({ instanceId, requestId, target: { id: target.targetId ?? target.id, name: target.target ?? target.name, kind: target.kind, sessionId: target.sessionId }, text });
}

export function requireApproval(plan, approvalHash, expectedSession) {
  if (!approvalHash || !expectedSession) fail('SEND_APPROVAL_REQUIRED', 'Use the request ID, approval hash and exact session from the approved preview.', { sent: false });
  if (expectedSession !== plan.target.sessionId) fail('SESSION_CHANGED', 'The current Bot session differs from the approved session. Prepare a new preview.', { sent: false });
  if (approvalHash !== plan.approvalHash) fail('APPROVAL_MISMATCH', 'The approved target, message or instance changed. Nothing was sent.', { sent: false });
}

function checkResponse(value, instanceId) {
  if (value?.instanceId !== instanceId) fail('INSTANCE_MISMATCH', 'The bridge does not match the approved DS Bot instance.', { sent: null });
  if (!value || typeof value !== 'object' || value.ok !== true) {
    const code = typeof value?.error?.code === 'string' && /^[A-Z_0-9]{3,80}$/.test(value.error.code) ? value.error.code : 'BRIDGE_REJECTED';
    const rejection = value?.sent === false && value?.definitiveRejection === true;
    const error = new TransportError(code, 'The DS Bot bridge rejected this operation. Inspect the structured delivery state before taking further action.', { sent: rejection ? false : null });
    error.definitiveRejection = rejection;
    error.boundReceipt = value?.receipt;
    throw error;
  }
  return value;
}

function boundReplies(items, receipt) {
  if (!Array.isArray(items)) fail('REPLY_BINDING_INVALID', 'The bridge returned an unsupported reply format.', { sent: null });
  const seen = new Set();
  return items.map(item => {
    if (!item || !receipt.replySeqs.includes(item.seq) || item.turn !== receipt.anchor?.turn || typeof item.text !== 'string'
        || (item.sessionId !== undefined && item.sessionId !== receipt.target.sessionId) || seen.has(item.seq)) {
      fail('REPLY_BINDING_INVALID', 'A reply does not match the original request and turn. No unrelated text was returned.', { sent: null });
    }
    seen.add(item.seq);
    return { seq: item.seq, turn: item.turn, time: typeof item.time === 'string' ? item.time : null, text: item.text };
  });
}

export function createTransport(policy, { rpc = requestPipe, store = new ReceiptStore({ directory: policy.clientReceiptDirectory }), endpoint = readEndpoint, now = Date.now, pause = delay } = {}) {
  const call = async (payload, timeoutMs = 45000) => {
    const server = endpoint(policy);
    return checkResponse(await rpc(server.pipeName, { ...payload, instanceId: policy.instanceId }, { ...server, timeoutMs }), policy.instanceId);
  };
  const capabilities = ({ timeoutMs = 5000 } = {}) => call({ action: 'capabilities' }, timeoutMs);
  async function query(requestId, { showText = false, sessionId, timeoutMs = 45000 } = {}) {
    const local = store.read(requestId);
    if (!local) fail('REQUEST_NOT_FOUND', 'This CLI has no recorded intent for that request. No conversation was opened.', { sent: false });
    if (sessionId && sessionId !== local.target.sessionId) fail('SESSION_MISMATCH', 'The supplied session is not bound to this request.', { sent: false });
    let result;
    try { result = await call({ action: 'query', requestId, showText }, Math.min(45000, timeoutMs)); }
    catch (error) {
      if (error.boundReceipt) store.update(requestId, { kind: 'reconciled', receipt: error.boundReceipt });
      if (error instanceof TransportError) error.details = { ...error.details, resumed: true, sent: null, receipt: summarize(store.read(requestId)) };
      throw error;
    }
    if (!result.receipt) fail('RECEIPT_MISSING', 'The bridge returned no bound receipt.', { sent: null });
    const receipt = store.update(requestId, { kind: 'reconciled', receipt: result.receipt });
    return { ok: true, operation: 'query', resumed: true, receipt, summary: summarize(receipt), ...(showText ? { replies: boundReplies(result.replies ?? [], receipt), truncated: Boolean(result.truncated) } : {}) };
  }
  async function send(plan, { approvalHash, expectedSession, wait = false, timeoutMs = 300000, showText = false, onProgress } = {}) {
    const existing = store.read(plan.requestId);
    if (existing) {
      // Binding validation is local. Recovery does not depend on send readiness,
      // the Bot's current name/segment, or permission to submit another prompt.
      try { requireApproval(plan, approvalHash, expectedSession); store.begin(plan); }
      catch (error) {
        if (error instanceof TransportError) error.details = { ...error.details, sent: null, receipt: summarize(existing) };
        throw error;
      }
      const result = wait
        ? await waitFor(plan.requestId, { timeoutMs, showText, sessionId: plan.target.sessionId, onProgress })
        : await query(plan.requestId, { showText, sessionId: plan.target.sessionId });
      return { ...result, duplicatePrevented: true, dispatchAttempted: false };
    }
    requireApproval(plan, approvalHash, expectedSession);
    if (plan.instanceId !== policy.instanceId || !policy.allowedBotIds.includes(plan.target.id)) fail('TARGET_NOT_ALLOWED', 'The selected Bot is outside the approved local bridge allowlist.', { sent: false });
    // Probe before journaling. This does not submit content or open a chat.
    let caps;
    const probeStarted = now();
    try { caps = await capabilities({ timeoutMs: DEFAULT_PIPE_TIMEOUT_MS }); }
    catch (error) {
      fail('BRIDGE_PREFLIGHT_FAILED', 'The read-only readiness check failed before a send intent was created. No message was submitted; no automatic retry was attempted.', {
        requestId: plan.requestId, phase: 'capabilities', sent: false, dispatchAttempted: false,
        deliveryState: 'not_dispatched', retryAllowed: false,
        transportCode: /^[A-Z_0-9]{3,80}$/.test(error?.code ?? '') ? error.code : 'TRANSPORT_FAILED',
        probe: { timeoutMs: DEFAULT_PIPE_TIMEOUT_MS, elapsedMs: Math.max(0, now() - probeStarted),
          sentBytes: Number.isInteger(error?.sentBytes) && error.sentBytes >= 0 ? error.sentBytes : null,
          requestWritten: typeof error?.requestWritten === 'boolean' ? error.requestWritten : null,
          dispatchUnknown: typeof error?.dispatchUnknown === 'boolean' ? error.dispatchUnknown : null },
      });
    }
    if (caps.send !== true || caps.wait !== true) fail('BRIDGE_NOT_READY', 'The existing DS Bot runtime is not ready for tracked sends.', { sent: false });
    const started = store.begin(plan);
    if (!started.dispatchAllowed) {
      // Re-running a command is a query, including after a process crash.
      const result = wait
        ? await waitFor(plan.requestId, { timeoutMs, showText, sessionId: plan.target.sessionId, onProgress })
        : await query(plan.requestId, { showText, sessionId: plan.target.sessionId });
      return { ...result, duplicatePrevented: true, dispatchAttempted: false };
    }
    let result;
    try {
      result = await call({ action: 'send', requestId: plan.requestId, target: plan.target, text: plan.wireText, approvalHash: plan.approvalHash });
      if (!result.receipt) fail('RECEIPT_MISSING', 'The bridge returned no bound send receipt.', { sent: null });
      store.update(plan.requestId, { kind: 'reconciled', receipt: result.receipt });
    } catch (error) {
      // A client write/connection failure is never an instruction to replay.
      const rejected = error.definitiveRejection === true;
      let receipt;
      try {
        if (error.boundReceipt) store.update(plan.requestId, { kind: 'reconciled', receipt: error.boundReceipt });
        receipt = store.update(plan.requestId, rejected ? { kind: 'rejected', definitive: true, code: error.code } : { kind: 'unknown' });
      } catch (journalError) {
        fail('SEND_UNCONFIRMED', 'The request may have been accepted, but its local observation could not be saved. Preserve this request ID and query it; do not resend.', {
          requestId: plan.requestId, sent: null, dispatchAttempted: true, deliveryState: 'unknown', retryAllowed: false,
          journalCode: /^[A-Z_0-9]{3,80}$/.test(journalError?.code ?? '') ? journalError.code : 'JOURNAL_FAILED',
        });
      }
      fail(rejected ? error.code : 'SEND_UNCONFIRMED', rejected ? 'The bridge confirmed rejection before dispatch. This request ID will not be reused automatically.' : 'The send result is unconfirmed. Query or wait using this request ID; do not resend.', { requestId: plan.requestId, sent: rejected ? false : null, dispatchAttempted: true, deliveryState: receipt.status, receipt: summarize(receipt), transportCode: /^[A-Z_0-9]{3,80}$/.test(error?.code ?? '') ? error.code : 'TRANSPORT_FAILED' });
    }
    if (wait) return waitFor(plan.requestId, { timeoutMs, showText, sessionId: plan.target.sessionId, onProgress });
    const receipt = store.read(plan.requestId);
    return { ok: true, operation: 'send', dispatchAttempted: true, receipt, summary: summarize(receipt) };
  }
  async function waitFor(requestId, { timeoutMs = 300000, showText = false, sessionId, onProgress } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) fail('INVALID_TIMEOUT', 'Wait timeout must be between 1 ms and 1 hour.', { sent: false });
    const deadline = now() + timeoutMs;
    let last; let failures = 0; let previous;
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        const receipt = store.read(requestId);
        return { ok: true, operation: 'wait', resumed: true, timedOut: true, receipt, summary: summarize(receipt, { timedOut: true }), ...(showText ? { replies: last?.replies ?? [] } : {}) };
      }
      try {
        last = await query(requestId, { showText, sessionId, timeoutMs: Math.min(45000, remaining) });
        failures = 0;
      } catch (error) {
        if (++failures > 1 || error instanceof TransportError) throw error;
        // At most one retry of a read, never a mutation.
        await pause(Math.min(250, Math.max(1, deadline - now())));
        continue;
      }
      const status = last.receipt.status;
      if (status !== previous) { onProgress?.({ requestId, status }); previous = status; }
      if (TERMINAL.has(status)) return { ...last, operation: 'wait', timedOut: false };
      await pause(Math.min(1000, Math.max(1, deadline - now())));
    }
  }
  return { capabilities, send, query, wait: waitFor };
}
