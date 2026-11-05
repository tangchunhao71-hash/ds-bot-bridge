/**
 * Opt-in replacement for the one original DS Bot loader entry. This file is
 * inert until DSH calls apply after an explicitly approved profile change.
 * It never reads credentials, extracts cookies, or opens a TCP listener.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { BridgeError, assertColdStart, createBridge, createPrivateFetchRoute, createSnapshotReader, settleCarrierStartupFailure, withMaintenanceGate } from './index.mjs';
import { ReceiptStore, prepare, reconcile, summarize } from './lib/send-protocol.mjs';

export const name = 'ds-bot';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions',
  'sessionTitle', 'workspaceRegistry', 'connection', 'loader', 'sessionQuery', 'profileContext'];

const ROUTE = '/api/bot/dot-handoff';
const MAX_FRAME = 1024 * 1024;
const SINGLETON = Symbol.for('ds-bot.dot-handoff.active-wrapper');
const EXPECTED = Object.freeze({ bot: '0.2.7', boot: '0.2.1-rc.5', loader: '1.0.6' });
const CLIENT_HASH = '8d25c9a5e036cdd5c6d3bf27977ef3a49848b407e9eb2f225a12faeb55a633df';
// Three reviewed source groups. Same-version package edits also fail closed.
const SOURCE_PINS = Object.freeze([
  ['ds-bot', '.', '5bdc0c6c25249cb46864651311c58034e67ce34371a6cdb82e14e30e19ab1884'],
  ['ds-bot/package.json', '.', '1e048fe3d7c1db9c6274d77d188265973417318989409e8bf7d09ee10d7deaed'],
  ['ds-bot', './client.js', CLIENT_HASH],
  ['ds-bot', './src/host/store.js', 'aae02595f97b2337e485f16a84091c9d91d40f6dbdc211350fe3fe0cddf52b19'],
  ['ds-bot', './src/host/capabilities.js', '33681d752218d5ec5082e2cc6e9969c88503e7e9ea5effad43f04e271fc46b28'],
  ['ds-bot', './src/host/channel.js', '0e05d9a424b188fe338f7102404a9fb295069d0ece241d63cc4f87be18947d03'],
  ['@deepseek-ai/dsh-api-session-controller', '.', 'a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386'],
  ['@deepseek-ai/dsh-session-query', '.', '76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939'],
  ['@deepseek-ai/dsh-client-connection', '.', '0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684'],
  ['@deepseek-ai/cordis-plugin-loader', '.', '638b9ad360e01236120772323f80a65570c4f3f42f4cfc6243330241025b6d72'],
  ['@deepseek-ai/dsh-client-modules', '.', 'a2a33e32f13fdc9598b4751c4c22fb72789190bf5ba7337cd5a3d0cb4b4417ec'],
]);
function startupFailure() { return new Error('DS Bot handoff wrapper could not start; restore its profile patch before restarting.'); }
function hashFile(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function simpleString(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
// This local compatibility package is intentionally named ds-bot for the
// client graph. Resolve the real Host package from the installation anchor,
// never from this package's self-reference or its copied browser asset.
export function createInstalledResolver(installAnchor) {
  if (typeof installAnchor !== 'string' || !path.isAbsolute(installAnchor)) throw startupFailure();
  const fromInstallation = createRequire(installAnchor);
  return specifier => pathToFileURL(fromInstallation.resolve(specifier));
}
function packageVersion(specifier, resolveInstalled) { return JSON.parse(fs.readFileSync(resolveInstalled(specifier), 'utf8')).version; }
function checkSources(resolveInstalled) {
  for (const [specifier, relative, expected] of SOURCE_PINS) {
    const entry = resolveInstalled(specifier);
    if (hashFile(relative === '.' ? entry : new URL(relative, entry)) !== expected) throw startupFailure();
  }
}
export function checkFrontend(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'ds-bot' || manifest.dsh?.client?.platform !== 'web' ||
      manifest.exports?.['./client'] !== './client.js' ||
      hashFile(path.join(directory, 'client.js')) !== CLIENT_HASH) throw startupFailure();
}
function containsExpression(value) {
  return value !== null && typeof value === 'object' &&
    (Object.hasOwn(value, '__jsExpr') || Object.values(value).some(containsExpression));
}
function checkActivation(directory, instanceId) {
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'activation.complete.json'), 'utf8'));
  const hostStarted = Date.now() - process.uptime() * 1000;
  // Installer writes this marker last. HMR in a Host already running at that
  // point cannot enable the bridge, including during an install/start race.
  assertColdStart(marker, { instanceId, hostStartedAt: hostStarted });
}
function helperEnvironment(extra = {}) {
  const result = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']) {
    if (typeof process.env[key] === 'string') result[key] = process.env[key];
  }
  return { ...result, ...extra };
}

// Read ACL metadata only; identities and native diagnostics never leave this
// child. The installer owns granting these permissions, not this startup code.
const ACL_CHECK = `
$ErrorActionPreference = 'Stop'
try {
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $paths = @($env:DS_DOT_PLUGIN_DIR, $env:DS_DOT_RECEIPT_DIR,
    (Join-Path $env:DS_DOT_PLUGIN_DIR 'policy.json'),
    (Join-Path $env:DS_DOT_PLUGIN_DIR 'activation.complete.json'),
    (Join-Path $env:DS_DOT_PLUGIN_DIR 'package.json'),
    (Join-Path $env:DS_DOT_PLUGIN_DIR 'client.js'),
    (Join-Path $env:DS_DOT_PLUGIN_DIR 'pipe-helper.ps1'))
  $endpointPath = Join-Path $env:DS_DOT_PLUGIN_DIR 'endpoint.json'
  if (Test-Path -LiteralPath $endpointPath) { $paths += $endpointPath }
  foreach ($itemPath in $paths) {
    $item = Get-Item -LiteralPath $itemPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 71 }
    $acl = Get-Acl -LiteralPath $itemPath
    if (($item.PSIsContainer) -and (-not $acl.AreAccessRulesProtected)) { exit 72 }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $userSid) { exit 73 }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
        if ($rule.IdentityReference.Value -notin @($userSid, 'S-1-5-18')) { exit 74 }
      }
    }
  }
  [Console]::Out.Write('ACL_OK')
} catch { exit 75 }
`;

function checkPolicy(policy, directory) {
  const keys = ['schemaVersion', 'instanceId', 'allowedBotIds', 'receiptDirectory',
    'clientReceiptDirectory', 'pwshPath', 'helperSha256'];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some(key => !keys.includes(key)) || policy.schemaVersion !== 1 ||
      !simpleString(policy.instanceId) || !Array.isArray(policy.allowedBotIds) ||
      policy.allowedBotIds.some(id => !simpleString(id)) ||
      !path.isAbsolute(policy.receiptDirectory ?? '') || !path.isAbsolute(policy.clientReceiptDirectory ?? '') ||
      !path.isAbsolute(policy.pwshPath ?? '') || path.basename(policy.pwshPath).toLowerCase() !== 'pwsh.exe' ||
      !/^[a-f0-9]{64}$/u.test(policy.helperSha256 ?? '') || process.platform !== 'win32') throw startupFailure();
  const helperPath = path.join(directory, 'pipe-helper.ps1');
  if (hashFile(helperPath) !== policy.helperSha256) throw startupFailure();
  const output = execFileSync(policy.pwshPath,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_CHECK], {
      windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024,
      env: helperEnvironment({ DS_DOT_PLUGIN_DIR: directory, DS_DOT_RECEIPT_DIR: policy.receiptDirectory }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  if (output !== 'ACL_OK') throw startupFailure();
  return helperPath;
}

function originalEntry(ctx) {
  const matches = [...ctx.loader.entries()].filter(entry =>
    entry.options?.id === 'bot' && entry.options?.name === 'ds-bot');
  if (matches.length !== 1) throw new BridgeError('GUARD_FAILED');
  const original = matches[0];
  // A normal close/restart is required. A disposed-but-still-retained fiber
  // during HMR is deliberately insufficient proof that the old runtime ended.
  if (original.options.disabled !== true || !original.disabled || original.fiber !== undefined ||
      original.options.group || original.options.isolate || original.options.intercept || original.options.inject) {
    throw new BridgeError('GUARD_FAILED');
  }
  return original;
}

function publishEndpoint(filename, endpoint) {
  const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(endpoint) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
  }
}
function removeOwnEndpoint(filename, owned) {
  if (!owned) return;
  try {
    const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (current.instanceId === owned.instanceId && current.pipeName === owned.pipeName && current.helperPid === owned.helperPid) fs.unlinkSync(filename);
  } catch { /* Never remove an endpoint belonging to another startup. */ }
}

export async function apply(ctx) {
  const partialCleanup = [];
  let close = () => { for (const cleanup of partialCleanup.splice(0).reverse()) { try { cleanup(); } catch {} } };
  let runtimeCreated = false;
  const singletonOwner = {};
  try {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const policy = JSON.parse(fs.readFileSync(path.join(directory, 'policy.json'), 'utf8'));
    checkActivation(directory, policy.instanceId);
    const helperPath = checkPolicy(policy, directory);
    const resolveInstalled = createInstalledResolver(ctx.get('profileContext')?.installAnchor);
    if (packageVersion('ds-bot/package.json', resolveInstalled) !== EXPECTED.bot ||
        packageVersion('@deepseek-ai/dsh-app-boot/package.json', resolveInstalled) !== EXPECTED.boot ||
        packageVersion('@deepseek-ai/cordis-plugin-loader/package.json', resolveInstalled) !== EXPECTED.loader) throw startupFailure();
    checkSources(resolveInstalled);
    checkFrontend(directory);
    if (typeof ctx.connection.createPeer !== 'function' || typeof ctx.connection.createSharedFetchHandler !== 'function' ||
        typeof ctx.sessionQuery.observeSession !== 'function') throw startupFailure();
    const original = originalEntry(ctx);
    // The observed instance uses default Bot config. A disabled row has no
    // original plugin fiber, so dynamic expressions depending on that fiber
    // cannot honestly be reproduced here. Require a separate review instead.
    if (containsExpression(original.options.config)) throw startupFailure();
    const dsBot = await import(resolveInstalled('ds-bot').href);
    const { interpolate } = await import(resolveInstalled('@deepseek-ai/cordis-plugin-loader').href);
    if (dsBot.name !== name || typeof dsBot.createRuntime !== 'function' ||
        dsBot.inject.some(service => !inject.includes(service))) throw startupFailure();
    const config = interpolate(original.ctx, original.options.config ?? {});
    originalEntry(ctx);
    if (globalThis[SINGLETON]) throw startupFailure();
    globalThis[SINGLETON] = singletonOwner;
    ctx.effect(() => () => {
      if (globalThis[SINGLETON] === singletonOwner) delete globalThis[SINGLETON];
    }, 'ds-bot: single wrapper runtime');
    // Replaces original apply, never accompanies it. No second runtime starts.
    const rt = dsBot.createRuntime(ctx, config);
    runtimeCreated = true;
    const store = new ReceiptStore({ directory: policy.receiptDirectory });
    const readSnapshot = createSnapshotReader({ sessionQuery: ctx.sessionQuery });
    let stopped = false;
    const guard = () => {
      if (stopped) throw new BridgeError('BRIDGE_DISPOSED');
      checkActivation(directory, policy.instanceId);
      originalEntry(ctx);
      return true;
    };
    const core = createBridge({ rt, ctx, policy, store, prepare, reconcile, summarize, readSnapshot, guard });
    partialCleanup.push(() => core.dispose());
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    partialCleanup.push(() => { try { Promise.resolve(peer.dispose()).catch(() => {}); } catch {} });
    const handler = ctx.connection.createSharedFetchHandler('/api');
    const privateRoute = createPrivateFetchRoute({ instanceId: policy.instanceId, peer, handle: core.handle });
    const unregister = ctx.connection.fetch.register({ path: ROUTE, methods: ['POST'], requestBody: 'buffered',
      fetch: privateRoute.fetch,
    });
    partialCleanup.push(() => { if (typeof unregister === 'function') unregister(); });
    const pipeName = `ds-dot-bridge-${randomBytes(16).toString('hex')}`;
    const endpointPath = path.join(directory, 'endpoint.json');
    let endpoint;
    const child = spawn(policy.pwshPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath, '-PipeName', pipeName],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment() });
    let killTimer;
    close = () => {
      if (stopped) return;
      stopped = true;
      core.dispose();
      removeOwnEndpoint(endpointPath, endpoint);
      try { if (typeof unregister === 'function') unregister(); } catch {}
      try { Promise.resolve(peer.dispose()).catch(() => {}); } catch {}
      try { child.stdin.end(); } catch {}
      if (child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 1500);
        killTimer.unref();
      }
    };
    ctx.effect(() => () => close(), 'ds-bot: restricted Dot handoff carrier');
    child.stderr.on('data', () => {}); // Native diagnostics may contain private paths.
    child.stdin.on('error', () => close());
    let buffered = Buffer.alloc(0);
    let ready = false;
    let pending = false;
    let resolveReady;
    let rejectReady;
    const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.stdout.on('error', () => { rejectReady(startupFailure()); close(); });
    child.stderr.on('error', () => { rejectReady(startupFailure()); close(); });
    const startupTimer = setTimeout(() => { rejectReady(startupFailure()); close(); }, 15_000);
    startupTimer.unref();
    child.on('error', () => { rejectReady(startupFailure()); close(); });
    child.on('exit', () => {
      if (killTimer) clearTimeout(killTimer);
      rejectReady(startupFailure());
      close();
    });
    async function onFrame(frame) {
      if (stopped) return;
      if (!ready) {
        if (frame?.kind !== 'ready' || frame.pipeName !== pipeName || frame.maxFrameBytes !== MAX_FRAME ||
            ['logonOnly', 'remoteRejected', 'firstInstance', 'protectedDacl'].some(key => frame.security?.[key] !== true) ||
            frame.security?.inheritable !== false || !Number.isSafeInteger(child.pid)) throw startupFailure();
        ready = true;
        endpoint = { schemaVersion: 1, instanceId: policy.instanceId, pipeName, helperPid: child.pid };
        publishEndpoint(endpointPath, endpoint);
        clearTimeout(startupTimer);
        resolveReady();
        return;
      }
      if (pending || frame?.kind !== 'request' || !/^[a-f0-9]{32}$/u.test(frame.id ?? '') || !Object.hasOwn(frame, 'payload')) throw startupFailure();
      pending = true;
      const signal = AbortSignal.timeout(40_000);
      let payload;
      try {
        payload = await withMaintenanceGate(ctx, async () => {
          guard();
          const request = new Request(`http://dsbot-ipc.invalid${ROUTE}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame.payload), signal,
          });
          const response = await privateRoute.dispatch(handler, request);
          if (response.status !== 200) throw new BridgeError('MAINTENANCE_BLOCKED');
          return response.json();
        }, { signal, path: ROUTE });
      } catch (error) {
        payload = { ok: false, instanceId: policy.instanceId, sent: null, definitiveRejection: false,
          error: { code: error?.code === 'DEADLINE_EXCEEDED' ? 'DEADLINE_EXCEEDED' : 'MAINTENANCE_BLOCKED',
            message: 'The Host did not admit the operation; query the request ID before sending again.' } };
      }
      if (!stopped) {
        const line = JSON.stringify({ id: frame.id, payload }) + '\n';
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) throw startupFailure();
        child.stdin.write(line);
      }
      pending = false;
    }
    child.stdout.on('data', chunk => {
      if (stopped) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_FRAME) { rejectReady(startupFailure()); close(); return; }
      for (;;) {
        const end = buffered.indexOf(10);
        if (end < 0) break;
        const line = buffered.subarray(0, end).toString('utf8');
        buffered = buffered.subarray(end + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { rejectReady(startupFailure()); close(); return; }
        onFrame(frame).catch(() => { rejectReady(startupFailure()); close(); });
      }
    });
    await readiness;
  } catch {
    if (settleCarrierStartupFailure({ runtimeCreated, close, warn: message => ctx.logger.warn(message) })) return;
    if (globalThis[SINGLETON] === singletonOwner) delete globalThis[SINGLETON];
    throw startupFailure();
  }
}
