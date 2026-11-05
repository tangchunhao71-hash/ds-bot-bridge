# Skill-local launcher. Requires existing Node.js 24+; never installs software.
$ErrorActionPreference = 'Stop'
$userArgs = @($args)

function Stop-DsBot {
  param([string]$Code, [string]$Message)
  [Console]::Error.WriteLine("${Code}: $Message")
  [Console]::Out.WriteLine((@{ ok = $false; error = @{ code = $Code; message = $Message } } | ConvertTo-Json -Depth 4 -Compress))
  exit 3
}

$skillDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$entry = Join-Path $skillDir 'bin\ds-bot.mjs'
$sums = Join-Path $skillDir 'bin\SHA256SUMS'
try {
  $requiredFiles = @('bin/ds-bot.mjs', 'lib/cli-transport.mjs', 'lib/pipe-client.mjs', 'lib/send-protocol.mjs')
  $lines = @(Get-Content -LiteralPath $sums -ErrorAction Stop)
  if ($lines.Count -ne $requiredFiles.Count) { Stop-DsBot 'CLI_CHECKSUM_INVALID' 'The skill checksum manifest is incomplete.' }
  $foundFiles = @{}
  foreach ($line in $lines) {
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+([a-zA-Z0-9_./-]+)$') { Stop-DsBot 'CLI_CHECKSUM_INVALID' 'The skill checksum manifest is invalid.' }
    $expected = $Matches[1].ToLowerInvariant()
    $relative = $Matches[2]
    if ($requiredFiles -notcontains $relative -or $foundFiles.ContainsKey($relative)) { Stop-DsBot 'CLI_CHECKSUM_INVALID' 'The skill checksum manifest contains unsupported or repeated paths.' }
    $foundFiles[$relative] = $true
    $stream = [System.IO.File]::OpenRead((Join-Path $skillDir $relative))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($actual -ne $expected) { Stop-DsBot 'CLI_CHECKSUM_MISMATCH' 'A skill CLI module does not match its checksum.' }
  }
} catch { Stop-DsBot 'CLI_CHECKSUM_UNAVAILABLE' 'The skill CLI or checksum could not be verified.' }
if ($userArgs -contains '--text-stdin') { Stop-DsBot 'STDIN_REQUIRES_DIRECT_NODE' 'Use this skill bin/ds-bot.mjs with Node for UTF-8 stdin, or pass a PowerShell string with --text.' }

$previousPathext = [Environment]::GetEnvironmentVariable('PATHEXT', 'Process')
$previousConsoleOut = [Console]::OutputEncoding
$previousConsoleIn = [Console]::InputEncoding
try {
# Some Agent subprocesses omit .EXE from PATHEXT. Windows PowerShell then fails to
# execute an explicit .exe even when its full path exists. Scope the default
# to this invocation and restore the caller's process environment in finally.
if ($previousPathext -notmatch '(?i)(^|;)\.exe(;|$)') { [Environment]::SetEnvironmentVariable('PATHEXT', '.EXE;' + $previousPathext, 'Process') }
$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodePath = $null
if ($node) { $nodePath = $node.Source }
if (-not $nodePath) {
  $programFiles = [Environment]::GetFolderPath('ProgramFiles')
  $candidate = Join-Path $programFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $candidate) { $nodePath = $candidate }
}
if (-not $nodePath) { Stop-DsBot 'RUNTIME_MISSING' 'Existing Node.js 24+ was not found. No installation was attempted.' }
try { $version = & $nodePath --version 2>$null } catch { Stop-DsBot 'RUNTIME_START_FAILED' 'The existing Node.js runtime could not be started.' }
if ($LASTEXITCODE -ne 0 -or "$version" -notmatch '^v(\d+)\.') { Stop-DsBot 'RUNTIME_UNSUPPORTED' 'Could not verify the Node.js version.' }
if ([int]$Matches[1] -lt 24) { Stop-DsBot 'RUNTIME_UNSUPPORTED' 'This skill requires existing Node.js 24+ for archive decompression.' }

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  & $nodePath $entry @userArgs
  $runtimeExit = $LASTEXITCODE
} catch { Stop-DsBot 'RUNTIME_START_FAILED' 'The skill CLI could not be started.' }
if ($null -eq $runtimeExit) { Stop-DsBot 'RUNTIME_START_FAILED' 'The CLI returned no process status.' }
exit $runtimeExit
} finally {
  [Environment]::SetEnvironmentVariable('PATHEXT', $previousPathext, 'Process')
  [Console]::OutputEncoding = $previousConsoleOut
  [Console]::InputEncoding = $previousConsoleIn
}
