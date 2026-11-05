import { spawn } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_PIPE_TIMEOUT_MS = 45_000;
export const PIPE_NAME_PATTERN = /^ds-dot-bridge-[A-Za-z0-9_-]{1,106}$/;
const MAX_HELPER_LINE_BYTES = 8 * MAX_FRAME_BYTES;

export class PipeRequestError extends Error {
  constructor(code, message, state = {}) {
    super(message);
    this.name = 'PipeRequestError';
    this.code = code;
    // Completed native writes are a lower bound, not a peer acknowledgement.
    // An interrupted or partially written request must never be replayed here.
    this.sentBytes = state.sentBytes ?? 0;
    this.requestWritten = state.requestWritten ?? false;
    this.dispatchUnknown = state.dispatchUnknown ?? false;
  }
}

export function validatePipeName(pipeName) {
  if (typeof pipeName !== 'string' || !PIPE_NAME_PATTERN.test(pipeName)) {
    throw new PipeRequestError('INVALID_PIPE_NAME', 'Use a local ds-dot-bridge- pipe name with a safe suffix.');
  }
  return pipeName;
}

function localExecutablePath(value, basename, field) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.includes('\0') ||
      path.win32.basename(value).toLowerCase() !== basename) {
    throw new PipeRequestError('INVALID_CLIENT_OPTIONS', field + ' must be an absolute local ' + basename + ' path.');
  }
  return path.win32.normalize(value);
}

/**
 * One native connection, one request, no retries. Required runtime paths are
 * already-installed files, not instructions to acquire or configure software.
 * The native client uses anonymous SQOS, verifies server PID and image on that
 * same handle, and only then asks Node to supply the payload over stdin.
 * Server ACLs cover the current logon session; they do not identify Dot alone.
 */
export async function requestPipe(pipeName, payload, {
  timeoutMs = DEFAULT_PIPE_TIMEOUT_MS, signal, pwshPath, helperPath, expectedServerPid,
} = {}) {
  validatePipeName(pipeName);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_PIPE_TIMEOUT_MS) {
    throw new PipeRequestError('INVALID_TIMEOUT', 'timeoutMs must be an integer from 1 through 45000.');
  }
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.aborted !== 'boolean')) {
    throw new PipeRequestError('INVALID_SIGNAL', 'signal must be an AbortSignal.');
  }
  if (signal?.aborted) throw new PipeRequestError('ABORTED', 'Pipe request was cancelled before dispatch.');

  let json;
  try { json = JSON.stringify(payload); }
  catch { throw new PipeRequestError('INVALID_JSON', 'Request payload must be JSON serializable.'); }
  if (json === undefined) throw new PipeRequestError('INVALID_JSON', 'Request payload must be a JSON value.');
  const bodyLength = Buffer.byteLength(json, 'utf8');
  if (bodyLength < 1 || bodyLength > MAX_FRAME_BYTES) {
    throw new PipeRequestError('FRAME_TOO_LARGE', 'Request frame exceeds the 1 MiB limit.');
  }
  const executable = localExecutablePath(pwshPath, 'pwsh.exe', 'pwshPath');
  const helper = localExecutablePath(helperPath, 'pipe-helper.ps1', 'helperPath');
  if (!Number.isInteger(expectedServerPid) || expectedServerPid < 1 || expectedServerPid > 0xffffffff) {
    throw new PipeRequestError('INVALID_CLIENT_OPTIONS', 'expectedServerPid must identify the approved live helper process.');
  }
  if (process.platform !== 'win32') throw new PipeRequestError('UNSUPPORTED_PLATFORM', 'This transport requires Windows.');

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let verified = false;
    let payloadSubmitted = false;
    let sentBytes = 0;
    let requestWritten = false;
    let dispatchUnknown = false;
    let resultSeen = false;
    let result;
    let stdout = '';
    let stderrSeen = false;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const state = () => ({ sentBytes, requestWritten, dispatchUnknown: dispatchUnknown || payloadSubmitted });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child?.stdin.destroy();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (code, message, errorState = state()) => finish(new PipeRequestError(code, message, errorState));
    const onAbort = () => fail('ABORTED', 'Pipe request was cancelled; inspect dispatchUnknown before any further action.');
    const timer = setTimeout(() => fail('PIPE_TIMEOUT', 'Pipe request timed out; it was not retried.'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }

    try {
      const helperEnv = {};
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']) {
        if (typeof process.env[key] === 'string') helperEnv[key] = process.env[key];
      }
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
        '-Mode', 'Client', '-PipeName', pipeName, '-ExpectedServerPid', String(expectedServerPid),
        '-ExpectedServerImage', executable, '-TimeoutMs', String(timeoutMs)], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnv,
      });
    } catch {
      fail('HELPER_START_FAILED', 'The existing native client could not be started.');
      return;
    }

    const accept = (message) => {
      if (message?.kind === 'fatal') {
        const code = typeof message.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(message.code) ? message.code : 'HELPER_FAILED';
        const reported = typeof message.dispatchUnknown === 'boolean' && typeof message.requestWritten === 'boolean' &&
          Number.isInteger(message.sentBytes) && message.sentBytes >= 0 && message.sentBytes <= MAX_FRAME_BYTES + 4;
        // An explicit native pre-write failure is known not to have dispatched.
        // Losing the subprocess without such a final report stays conservative.
        fail(code, 'Native pipe request failed; no automatic retry was attempted.', reported ? {
          sentBytes: message.sentBytes, requestWritten: message.requestWritten, dispatchUnknown: message.dispatchUnknown,
        } : state());
        return;
      }
      if (message?.kind === 'verified' && !verified && !payloadSubmitted &&
          message.serverPid === expectedServerPid && message.security?.anonymous === true &&
          message.security?.serverPidVerified === true && message.security?.serverImageVerified === true) {
        verified = true;
        payloadSubmitted = true;
        child.stdin.write('{"payload":' + json + '}\n', (error) => {
          if (error) fail('HELPER_STDIN_FAILED', 'Supplying the native request failed; dispatch is unknown.');
        });
        return;
      }
      if (message?.kind === 'dispatching' && verified && payloadSubmitted && !resultSeen) {
        dispatchUnknown = true;
        return;
      }
      if (message?.kind === 'written' && dispatchUnknown && Number.isInteger(message.sentBytes) &&
          message.sentBytes >= 4 && message.sentBytes <= MAX_FRAME_BYTES + 4 && !requestWritten) {
        sentBytes = message.sentBytes;
        requestWritten = true;
        return;
      }
      if (message?.kind === 'result' && verified && payloadSubmitted && !resultSeen && Object.hasOwn(message, 'payload')) {
        resultSeen = true;
        result = message.payload;
        return;
      }
      fail('HELPER_PROTOCOL_INVALID', 'Native client metadata was out of sequence.');
    };

    child.stdin.on('error', () => fail('HELPER_STDIN_FAILED', 'Native client input closed unexpectedly.'));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      try {
        stdout += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(stdout, 'utf8') > MAX_HELPER_LINE_BYTES) throw new Error();
        let newline;
        while ((newline = stdout.indexOf('\n')) !== -1 && !settled) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          accept(JSON.parse(line));
        }
      } catch { fail('HELPER_PROTOCOL_INVALID', 'Native client output was not bounded UTF-8 JSON metadata.'); }
    });
    child.stdout.on('error', () => fail('HELPER_STDOUT_FAILED', 'Native client output closed unexpectedly.'));
    child.stderr.on('data', () => { stderrSeen = true; });
    child.once('error', () => fail('HELPER_START_FAILED', 'The existing native client could not be started.'));
    child.once('close', (code) => {
      if (settled) return;
      try { stdout += decoder.decode(); }
      catch { fail('HELPER_PROTOCOL_INVALID', 'Native client output ended with incomplete UTF-8.'); return; }
      if (stderrSeen) { fail('HELPER_STDERR', 'Native client emitted unexpected diagnostics.'); return; }
      if (stdout.trim() || code !== 0 || !resultSeen) {
        fail('HELPER_CLOSED', 'Native client exited before one complete result.');
        return;
      }
      finish(undefined, result);
    });
  });
}
