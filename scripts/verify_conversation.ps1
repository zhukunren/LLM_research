param(
    [ValidateSet('offline', 'live')]
    [string]$Mode = 'offline',
    [string]$CaseSet = 'smoke'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
$PythonExe = Get-SystemPython312
Push-Location $ProjectRoot
try {
    & $PythonExe scripts/verify_conversation.py --mode $Mode --case-set $CaseSet
    if ($LASTEXITCODE -ne 0) { throw 'conversation verification failed.' }
} finally { Pop-Location }
