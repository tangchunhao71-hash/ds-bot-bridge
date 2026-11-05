// Explicitly reviewed activation/rollback only. `plan` is the default and
// performs no writes. This script never starts/stops DS Bot or sends a message.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locations, asarFacts, EXPECTED, instanceIdentity, parseTeam } from '../bin/ds-bot.mjs';
import { CLIENT_SHA256, originalClient } from '../lib/installed-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const MARK = 'DS-DOT-BRIDGE-V1';
const BRIDGE_FILES = ['index.mjs', 'runtime-wrapper.mjs', 'pipe-helper.ps1', 'lib/send-protocol.mjs', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSE-DS-Bot.txt', 'NOTICE-DS-Bot.txt'];
const PS_UTF8 = "$ErrorActionPreference='Stop';[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);";
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let activationCheckpoint;
function stop(code) { throw Object.assign(new Error(code), { code }); }
export function normalizeBotIds(ids) {
  if (!Array.isArray(ids) || ids.length > 64 || ids.some(id => typeof id !== 'string' || !/^session-[0-9a-zA-Z-]{8,128}$/.test(id))) stop('INVALID_ALLOWLIST');
  return [...new Set(ids)].sort();
}
export function selectedBots(ids, team) {
  if (!Array.isArray(team?.bots) || team.bots.length === 0) stop('NO_EXISTING_BOTS');
  return normalizeBotIds(ids).map(id => {
    const matches = team.bots.filter(bot => bot.id === id);
    if (matches.length !== 1 || typeof matches[0].name !== 'string') stop('ALLOW_BOT_NOT_FOUND');
    return { id, name: matches[0].name };
  });
}
export function patchFragment(pluginDirectory) {
  const file = path.join(pluginDirectory, 'runtime-wrapper.mjs').replaceAll('\\', '/');
  return `\n# BEGIN ${MARK}\n- id: bot\n  name: ds-bot\n  disabled: true\n\n- insert:\n    - id: ds-dot-bot-wrapper\n      name: ${JSON.stringify(file)}\n# END ${MARK}\n`;
}
export function patchedBytes(original, pluginDirectory) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
  if (text.includes('\0') || text.includes(MARK) || /^[ \t]*(?:---|\.\.\.)(?:[ \t]+#.*)?[ \t]*$/m.test(text)) stop('PROFILE_PATCH_UNSUPPORTED');
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim()).find(x => x && !x.startsWith('#'));
  if (first && !first.startsWith('- ')) stop('PROFILE_PATCH_UNSUPPORTED');
  // Deliberately support only the existing block-sequence grammar. Complex
  // keys, anchors, aliases, flow entries or escaped quoted keys need a real
  // YAML review; never guess their effect on Loader's original Bot entry.
  if (/^[ \t]*-[ \t]*[\[\{&*?]/m.test(text) || /^[ \t]*(?:-[ \t]+)?(?:["'][^\r\n]*["'][ \t]*:|[&*?]|<<[ \t]*:)/m.test(text)) stop('PROFILE_PATCH_UNSUPPORTED');
  if (/(?:^|[\s,{])id[ \t]*:[ \t]*["']?bot["']?(?=[\s,}#]|$)/m.test(text)) stop('ORIGINAL_BOT_OVERRIDE_PRESENT');
  return Buffer.concat([original, Buffer.from((text && !text.endsWith('\n') ? '\n' : '') + patchFragment(pluginDirectory), 'utf8')]);
}
export function isManagedPatch(original, actual, pluginDirectory) {
  try {
    const expected = patchedBytes(original, pluginDirectory);
    if (actual.equals(expected)) return true;
    if (!actual.subarray(0, original.length).equals(original)) return false;
    let tail = new TextDecoder('utf-8', { fatal: true }).decode(actual.subarray(original.length));
    const expectedTail = new TextDecoder('utf-8', { fatal: true }).decode(expected.subarray(original.length));
    // DSH's YAML writer may wrap just the quoted absolute path. Accept that
    // representation only; no original bytes or other bridge fields may change.
    const names = [...tail.matchAll(/^      name: ("(?:[^"\\]|\\[^\r\n]|\\\r?\n[ \t]+)*")[ \t]*\r?$/gm)];
    if (names.length !== 1) return false;
    const unfolded = names[0][1].replace(/\\\r?\n[ \t]+/g, '');
    const expectedPath = path.join(pluginDirectory, 'runtime-wrapper.mjs').replaceAll('\\', '/');
    if (JSON.parse(unfolded) !== expectedPath) return false;
    tail = tail.replace(names[0][0], `      name: ${JSON.stringify(expectedPath)}`);
    const lines = text => text.split(/\r?\n/).filter(line => line.trim()).join('\n');
    return lines(tail) === lines(expectedTail);
  } catch { return false; }
}
export function loadBuild() {
  const build = JSON.parse(fs.readFileSync(path.join(root, 'BUILD.json'), 'utf8'));
  if (build.schemaVersion !== 1 || !build.files) stop('BUILD_INVALID');
  for (const [relative, expected] of Object.entries(build.files)) {
    const absolute = path.resolve(root, relative);
    const relativePath = path.relative(root, absolute);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || sha(fs.readFileSync(absolute)) !== expected) stop('BUILD_CHANGED');
  }
  for (const file of BRIDGE_FILES) if (!build.files['assets/bridge/' + file]) stop('BUILD_INCOMPLETE');
  return build;
}
export function pwshPath() {
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) stop('EXISTING_POWERSHELL_7_REQUIRED');
  const version = JSON.parse(execFileSync(found, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  if (version < 7) stop('EXISTING_POWERSHELL_7_REQUIRED');
  return found;
}
function currentAppPids(pwsh) {
  const observed = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', "ConvertTo-Json -InputObject @(Get-Process -Name 'DS Bot' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -Compress"], { windowsHide: true, encoding: 'utf8', timeout: 10000 }) || '[]');
  if (!Array.isArray(observed) || observed.some(value => value !== null && (!Number.isInteger(value) || value < 1))) stop('PROCESS_QUERY_INVALID');
  return observed.filter(value => value !== null);
}
export function securityDescriptor(file, pwsh) {
  const command = PS_UTF8 + '$dsDotAclFile=([Console]::In.ReadToEnd() | ConvertFrom-Json); (Get-Acl -LiteralPath $dsDotAclFile -ErrorAction Stop).Sddl | ConvertTo-Json -Compress';
  return JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: JSON.stringify(file), encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }));
}
export function permissionsPreserved(expected, actual) {
  if (typeof expected !== 'string' || !expected || typeof actual !== 'string' || !actual) return false;
  if (actual === expected) return true;
  // NTFS may add SE_DACL_AUTO_INHERITED after replacing a regular file.
  // Accept only that one-way addition, with identical owner, group, all ACEs,
  // SACL and P/AR flags. Never normalize ACE flags or a null/absent DACL.
  const header = /^((?:(?:O|G):(?:S-\d+(?:-\d+)+|[A-Z]{2}))*)D:((?:P|AI|AR)*)\(/;
  const before = expected.match(header);
  const after = actual.match(header);
  if (!before || !after || before[1] !== after[1] || before[2].includes('AI') || !after[2].includes('AI')) return false;
  return after[2].replace('AI', '') === before[2] &&
    actual.slice(after[0].length) === expected.slice(before[0].length);
}
export function setSecurityDescriptor(file, sddl, pwsh) {
  const command = PS_UTF8 + '$dsDotAclInput=([Console]::In.ReadToEnd() | ConvertFrom-Json);$dsDotAcl=[System.Security.AccessControl.FileSecurity]::new();$dsDotAcl.SetSecurityDescriptorSddlForm($dsDotAclInput.sddl,([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group));Set-Acl -LiteralPath $dsDotAclInput.file -AclObject $dsDotAcl -ErrorAction Stop';
  execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: JSON.stringify({ file, sddl }), encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function makePlan(allowedBotIds = []) {
  if (process.platform !== 'win32') stop('WINDOWS_REQUIRED');
  const ids = normalizeBotIds(allowedBotIds);
  const build = loadBuild();
  const loc = locations();
  const facts = asarFacts(path.join(loc.install, 'resources', 'app.asar'));
  if (!Object.keys(EXPECTED).every(key => facts[key] === EXPECTED[key])) stop('INSTANCE_VERSION_CHANGED');
  const profile = path.join(loc.dataDir, 'profiles', 'ds-bot');
  const patch = path.join(profile, 'cordis.patch.yml');
  const pluginDirectory = path.join(profile, 'local-plugins', 'ds-dot-bridge');
  const integrationDirectory = path.join(loc.dataDir, 'integrations', 'ds-dot-bridge');
  if (fs.existsSync(pluginDirectory)) stop('PLUGIN_DIRECTORY_EXISTS');
  const stateFile = path.join(loc.dataDir, 'bot', 'state.json');
  const stat = fs.statSync(stateFile);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) stop('EXISTING_TEAM_UNAVAILABLE');
  const approvedBots = selectedBots(ids, parseTeam(fs.readFileSync(stateFile, 'utf8')));
  originalClient(loc.install); // Verify static frontend bytes without writing.
  const existed = fs.existsSync(patch);
  const original = existed ? fs.readFileSync(patch) : Buffer.alloc(0);
  const result = patchedBytes(original, pluginDirectory);
  const pwsh = pwshPath();
  const originalSddl = existed ? securityDescriptor(patch, pwsh) : null;
  const policy = {
    schemaVersion: 1, instanceId: instanceIdentity(loc, facts), allowedBotIds: ids,
    receiptDirectory: path.join(integrationDirectory, 'server-receipts'),
    clientReceiptDirectory: path.join(integrationDirectory, 'client-receipts'),
    pwshPath: pwsh, helperSha256: build.files['assets/bridge/pipe-helper.ps1'],
  };
  const plan = { schemaVersion: 1, version: build.version, instanceId: policy.instanceId,
    installation: loc.install, profile, patch, pluginDirectory, integrationDirectory,
    originalPatchExists: existed, originalPatchHash: sha(original), originalPatchAclHash: originalSddl ? sha(originalSddl) : null, resultingPatchHash: sha(result),
    buildHash: sha(JSON.stringify(build.files)), policy, approvedBots,
    generatedClient: { source: 'existing app.asar/node_modules/ds-bot/client.js', sha256: CLIENT_SHA256 },
    patchAppend: patchFragment(pluginDirectory),
    access: 'new local owner-capable IPC; current Windows logon only; explicit allowlist, empty by default',
    activation: 'close the existing DS Bot normally and keep it closed until apply returns; then reopen that same app',
    rollback: 'close DS Bot; verify exact activated patch hash; restore the private backup; retain bridge and receipt artifacts in backup storage',
  };
  return { plan, planHash: sha(JSON.stringify(plan)), appRunningPids: currentAppPids(pwsh) };
}
export function privateDirectory(directory, pwsh) {
  fs.mkdirSync(directory, { recursive: true });
  // Directory is newly created for this integration. No changes to existing
  // profile/network permissions. Grant current user and SYSTEM only.
  const script = '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;' +
    '$acl=[System.Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);' +
    '$inherit=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;' +
    'foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]::new("S-1-5-18"))){$r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,"FullControl",$inherit,"None","Allow");$acl.AddAccessRule($r)};' +
    'Set-Acl -LiteralPath $dsDotPrivateDirectory -AclObject $acl -ErrorAction Stop';
  // Avoid shell interpolation of user paths. Encoded script consumes JSON stdin.
  const wrapped = PS_UTF8 + '$dsDotPrivateDirectory=([Console]::In.ReadToEnd() | ConvertFrom-Json);' + script;
  execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')], { input: JSON.stringify(directory), windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function atomicWrite(file, bytes, { stagingDirectory = path.dirname(file), sddl, pwsh } = {}) {
  const temporary = path.join(stagingDirectory, path.basename(file) + '.ds-dot-' + crypto.randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (sddl) {
    if (!permissionsPreserved(sddl, securityDescriptor(file, pwsh))) stop('PROFILE_PERMISSIONS_CHANGED');
    // Windows ReplaceFile preserves the destination DACL and metadata, including
    // inherited ACL semantics. Do not use ignoreMetadataErrors or copy an ACL
    // in a different parent. Retain the native backup for partial OS failures.
    const nativeBackup = path.join(stagingDirectory, path.basename(file) + '.native-original-' + crypto.randomUUID() + '.bin');
    const command = PS_UTF8 + '$dsDotReplace=([Console]::In.ReadToEnd() | ConvertFrom-Json);[System.IO.File]::Replace($dsDotReplace.temporary,$dsDotReplace.file,$dsDotReplace.backup,$false)';
    execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: JSON.stringify({ temporary, file, backup: nativeBackup }), windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    // Inherited ACEs can be recalculated from the replacement's old parent.
    // Restore permission-bearing fields at the final path if needed; the
    // staging ACL was private. Only the OS's one-way AI normalization is allowed.
    if (!permissionsPreserved(sddl, securityDescriptor(file, pwsh))) setSecurityDescriptor(file, sddl, pwsh);
    if (!permissionsPreserved(sddl, securityDescriptor(file, pwsh))) stop('PATCH_PERMISSIONS_NOT_PRESERVED');
  } else {
    fs.renameSync(temporary, file);
  }
}

export function applyPlan(approvedHash, allowedBotIds = []) {
  const current = makePlan(allowedBotIds);
  if (approvedHash !== current.planHash) stop('APPROVED_PLAN_CHANGED');
  if (current.appRunningPids.length) stop('CLOSE_EXISTING_DS_BOT_FIRST');
  const { plan } = current;
  const clientBytes = originalClient(plan.installation);
  const original = plan.originalPatchExists ? fs.readFileSync(plan.patch) : Buffer.alloc(0);
  if (sha(original) !== plan.originalPatchHash) stop('PROFILE_CHANGED');
  const originalSddl = plan.originalPatchExists ? securityDescriptor(plan.patch, plan.policy.pwshPath) : null;
  if ((originalSddl ? sha(originalSddl) : null) !== plan.originalPatchAclHash) stop('PROFILE_PERMISSIONS_CHANGED');
  const backupId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  const backup = path.join(plan.integrationDirectory, 'activation-backups', backupId);
  if (!fs.existsSync(plan.integrationDirectory)) privateDirectory(plan.integrationDirectory, plan.policy.pwshPath);
  for (const directory of [plan.policy.receiptDirectory, plan.policy.clientReceiptDirectory]) {
    if (!fs.existsSync(directory)) privateDirectory(directory, plan.policy.pwshPath);
  }
  privateDirectory(backup, plan.policy.pwshPath);
  atomicWrite(path.join(backup, 'original-patch.bin'), original);
  atomicWrite(path.join(backup, 'activation.json'), Buffer.from(JSON.stringify({ ...current, originalPatchSddl: originalSddl, backupId, phase: 'prepared', applied: false }, null, 2)));
  activationCheckpoint = { backupId, phase: 'prepared' };
  // The app is closed, so creating the plugin cannot activate HMR.
  privateDirectory(plan.pluginDirectory, plan.policy.pwshPath);
  const build = loadBuild();
  if (sha(JSON.stringify(build.files)) !== plan.buildHash) stop('BUILD_CHANGED');
  for (const relative of BRIDGE_FILES) {
    const destination = path.join(plan.pluginDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, 'assets', 'bridge', relative), destination, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(destination)) !== build.files['assets/bridge/' + relative]) stop('INSTALLED_FILE_CHANGED');
  }
  fs.writeFileSync(path.join(plan.pluginDirectory, 'client.js'), clientBytes, { flag: 'wx', mode: 0o600 });
  if (sha(fs.readFileSync(path.join(plan.pluginDirectory, 'client.js'))) !== CLIENT_SHA256) stop('CLIENT_SOURCE_CHANGED');
  fs.writeFileSync(path.join(plan.pluginDirectory, 'policy.json'), JSON.stringify(plan.policy, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (currentAppPids(plan.policy.pwshPath).length) stop('APP_STARTED_DURING_ACTIVATION');
  const checked = plan.originalPatchExists ? fs.readFileSync(plan.patch) : Buffer.alloc(0);
  if (sha(checked) !== plan.originalPatchHash) stop('PROFILE_CHANGED');
  if (originalSddl && sha(securityDescriptor(plan.patch, plan.policy.pwshPath)) !== plan.originalPatchAclHash) stop('PROFILE_PERMISSIONS_CHANGED');
  atomicWrite(plan.patch, patchedBytes(checked, plan.pluginDirectory), { stagingDirectory: backup, sddl: originalSddl, pwsh: plan.policy.pwshPath });
  activationCheckpoint.phase = 'patch-applied';
  atomicWrite(path.join(backup, 'activation.json'), Buffer.from(JSON.stringify({ ...current, originalPatchSddl: originalSddl, backupId, phase: 'applied', applied: true }, null, 2)));
  // Last step: an already-running Host cannot pass the wrapper's cold-start
  // gate even if it noticed a patch via HMR during a user startup race.
  atomicWrite(path.join(plan.pluginDirectory, 'activation.complete.json'), Buffer.from(JSON.stringify({ schemaVersion: 1, instanceId: plan.instanceId, completedAt: new Date().toISOString() }) + '\n'));
  return { ok: true, operation: 'activated-files', backupId, instanceId: plan.instanceId, appStarted: false, sent: false, note: 'Wait at least 2 seconds, then open the same existing DS Bot app normally and check bridge capabilities.' };
}
export function rollback(backupId) {
  if (!/^[0-9TZ_-]+[a-f0-9-]{36}$/i.test(backupId || '')) stop('BACKUP_ID_INVALID');
  const loc = locations();
  const base = path.join(loc.dataDir, 'integrations', 'ds-dot-bridge', 'activation-backups');
  const backup = path.join(base, backupId);
  const meta = JSON.parse(fs.readFileSync(path.join(backup, 'activation.json'), 'utf8'));
  const { plan } = meta;
  if (!plan || sha(JSON.stringify(plan)) !== meta.planHash || path.resolve(plan.patch) !== path.resolve(loc.dataDir, 'profiles', 'ds-bot', 'cordis.patch.yml') || path.resolve(plan.pluginDirectory) !== path.resolve(loc.dataDir, 'profiles', 'ds-bot', 'local-plugins', 'ds-dot-bridge')) stop('BACKUP_INVALID');
  if (currentAppPids(plan.policy.pwshPath).length) stop('CLOSE_EXISTING_DS_BOT_FIRST');
  const original = fs.readFileSync(path.join(backup, 'original-patch.bin'));
  if (sha(original) !== plan.originalPatchHash) stop('BACKUP_CHANGED');
  if ((meta.originalPatchSddl ? sha(meta.originalPatchSddl) : null) !== plan.originalPatchAclHash) stop('BACKUP_PERMISSIONS_CHANGED');
  const patchExists = fs.existsSync(plan.patch);
  const actual = patchExists ? fs.readFileSync(plan.patch) : Buffer.alloc(0);
  const actualHash = sha(actual);
  const isOriginal = actualHash === plan.originalPatchHash && patchExists === plan.originalPatchExists;
  const isActivated = patchExists && (actualHash === plan.resultingPatchHash || isManagedPatch(original, actual, plan.pluginDirectory));
  if (!isOriginal && !isActivated) stop('PROFILE_CHANGED_SINCE_ACTIVATION');
  if (plan.originalPatchExists && !permissionsPreserved(meta.originalPatchSddl, securityDescriptor(plan.patch, plan.policy.pwshPath))) stop('PROFILE_PERMISSIONS_CHANGED');
  if (isActivated) {
    if (plan.originalPatchExists) atomicWrite(plan.patch, original, { stagingDirectory: backup, sddl: meta.originalPatchSddl, pwsh: plan.policy.pwshPath });
    else fs.unlinkSync(plan.patch);
  }
  // Preserve all integration evidence, including uncertain send intents.
  const disabledPlugin = path.join(backup, 'disabled-plugin');
  if (fs.existsSync(plan.pluginDirectory)) {
    if (fs.existsSync(disabledPlugin)) stop('ROLLBACK_ARTIFACT_CONFLICT');
    fs.renameSync(plan.pluginDirectory, disabledPlugin);
  }
  atomicWrite(path.join(backup, 'activation.json'), Buffer.from(JSON.stringify({ ...meta, rolledBackAt: new Date().toISOString(), phase: 'rolled-back', applied: false }, null, 2)));
  return { ok: true, operation: 'rolled-back-files', backupId, appStarted: false, sent: false, receiptsPreserved: true };
}

export function parseActivationArgs(input) {
  const args = [...input];
  let action = args.shift() || 'help';
  if (action === '--help' || action === '-h') action = 'help';
  if (!['help', 'verify', 'plan', 'apply', 'rollback'].includes(action)) stop('INVALID_ARGUMENTS');
  const value = ['apply', 'rollback'].includes(action) ? args.shift() : undefined;
  const allowed = [];
  while (args.length) {
    if (args.shift() !== '--allow-bot' || !args.length) stop('INVALID_ARGUMENTS');
    allowed.push(args.shift());
  }
  if (['help', 'verify', 'rollback'].includes(action) && allowed.length) stop('INVALID_ARGUMENTS');
  if (action === 'apply' && !/^[a-f0-9]{64}$/.test(value || '')) stop('INVALID_PLAN_HASH');
  if (action === 'rollback' && !/^[0-9TZ_-]+[a-f0-9-]{36}$/i.test(value || '')) stop('BACKUP_ID_INVALID');
  return { action, value, allowedBotIds: normalizeBotIds(allowed) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { action, value, allowedBotIds } = parseActivationArgs(process.argv.slice(2));
    const result = action === 'help' ? { ok: true, operation: 'help', usage: ['node scripts/bridge.mjs verify', 'node scripts/bridge.mjs plan [--allow-bot <real-bot-id> ...]', 'node scripts/bridge.mjs apply <approved-plan-hash> [--allow-bot <same-id> ...]', 'node scripts/bridge.mjs rollback <backup-id>'], sent: false } :
      action === 'verify' ? { ok: true, operation: 'verify-package', version: loadBuild().version, sent: false } :
      action === 'plan' ? { ok: true, operation: 'activation-plan', ...makePlan(allowedBotIds), changesApplied: false, sent: false } :
      action === 'apply' ? applyPlan(value, allowedBotIds) : rollback(value);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: /^[A-Z_0-9]{3,80}$/.test(error?.code || '') ? error.code : 'ACTIVATION_FAILED', message: 'No automatic restart or send was performed. Preserve any activation backup and inspect the reported state.', ...(activationCheckpoint ? { recovery: { ...activationCheckpoint, command: 'rollback <backupId> with DS Bot kept closed' } } : {}) } }, null, 2));
    process.exitCode = 3;
  }
}
