param(
    [string]$Executable = '',
    [switch]$Stream,
    [switch]$WithoutPath,
    [string]$Model = ''
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on an actual Windows host.' }
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    # Resolve Node before any smoke child intentionally removes PATH.
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $Npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    foreach ($Task in @('test', 'typecheck', 'build')) {
        & $Npm run $Task
        if ($LASTEXITCODE -ne 0) { throw "npm run $Task failed" }
    }
    $SmokeArgs = @('scripts/smoke-codex.cjs')
    if ($Executable) { $SmokeArgs += @('--executable', $Executable) }
    if ($WithoutPath) { $SmokeArgs += '--without-path' }
    if ($Stream) { $SmokeArgs += '--stream' }
    if ($Model) { $SmokeArgs += @('--model', $Model) }
    & $Node @SmokeArgs
    if ($LASTEXITCODE -ne 0) { throw 'Real Codex smoke failed' }
    Write-Host 'PASS Windows validation completed'
} finally {
    Pop-Location
}
