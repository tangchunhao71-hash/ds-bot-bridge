// Native file verification stays in a newly created temp tree. It never calls
// applyPlan/rollback, touches a profile, or starts DS Bot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWrite, privateDirectory, securityDescriptor, setSecurityDescriptor } from '../scripts/bridge.mjs';

const pwsh = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
test('Windows atomic patch writes preserve a narrower file ACL and exact rollback bytes', { skip: process.platform !== 'win32' }, t => {
  assert.ok(fs.existsSync(pwsh), 'Existing PowerShell 7 is required for this fixture');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-dot-activation-files-'));
  t.after(() => { const real = fs.realpathSync(base); assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(real).startsWith('ds-dot-activation-files-')); fs.rmSync(real, { recursive: true }); });
  privateDirectory(base, pwsh);
  const fixture = path.join(base, 'synthetic.patch.yml');
  const bytes = Buffer.from('\ufeff# SYNTHETIC ONLY\r\n- id: unrelated\r\n', 'utf8');
  fs.writeFileSync(fixture, bytes);
  // Make this single file more restrictive than its parent: remove SYSTEM's
  // inherited ACE and protect the remaining current-user ACE.
  const command = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress';
  const sid = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  setSecurityDescriptor(fixture, `D:P(A;;FA;;;${sid})`, pwsh);
  const sddl = securityDescriptor(fixture, pwsh);
  const staging = path.join(base, 'private-backup');
  privateDirectory(staging, pwsh);
  atomicWrite(fixture, Buffer.from('SYNTHETIC ACTIVATED\n'), { stagingDirectory: staging, sddl, pwsh });
  assert.equal(securityDescriptor(fixture, pwsh), sddl);
  assert.equal(fs.readFileSync(fixture, 'utf8'), 'SYNTHETIC ACTIVATED\n');
  atomicWrite(fixture, bytes, { stagingDirectory: staging, sddl, pwsh });
  assert.deepEqual(fs.readFileSync(fixture), bytes);
  assert.equal(securityDescriptor(fixture, pwsh), sddl);
  const backups = fs.readdirSync(staging);
  assert.equal(backups.length, 2);
  assert.ok(backups.every(name => name.startsWith('synthetic.patch.yml.native-original-') && name.endsWith('.bin')));
  assert.ok(backups.map(name => fs.readFileSync(path.join(staging, name))).some(value => value.equals(bytes)));
});

test('atomic replacement preserves inherited ACL semantics across a private staging directory', { skip: process.platform !== 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-dot-activation-files-'));
  t.after(() => { const real = fs.realpathSync(base); assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(real).startsWith('ds-dot-activation-files-')); fs.rmSync(real, { recursive: true }); });
  const fixture = path.join(base, 'inherited.patch.yml');
  fs.writeFileSync(fixture, 'SYNTHETIC ORIGINAL\n');
  const originalAcl = securityDescriptor(fixture, pwsh);
  const staging = path.join(base, 'private-backup');
  privateDirectory(staging, pwsh);
  atomicWrite(fixture, Buffer.from('SYNTHETIC REPLACEMENT\n'), { stagingDirectory: staging, sddl: originalAcl, pwsh });
  assert.equal(securityDescriptor(fixture, pwsh), originalAcl);
});
