# Reload web/API code while the independent research worker keeps its lease.
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
. (Join-Path $PSScriptRoot 'processes.ps1')
$Runtime = Join-Path $ProjectRoot 'runtime'
$RegistryPath = Join-Path $Runtime 'processes.json'
$LaunchLock = [IO.File]::Open((Join-Path $Runtime 'services.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $ProcessInfo = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
    $OwnedApi = Get-OwnedServiceProcess $ProcessInfo 'api' $ProjectRoot
    if (-not $OwnedApi) { throw 'Cannot verify the API process owned by this workspace.' }
    $ApiPython = Get-SystemPython312
    $env:PYTHONNOUSERSITE = '1'
    $env:PYTHONPATH = Join-Path $ProjectRoot 'runtime/python-deps'
    $env:LLMR_WEB_PORT = [string]$ProcessInfo.web_port
    $OldApi = Get-Process -Id $OwnedApi.ProcessId -ErrorAction Stop
    Stop-Process -InputObject $OldApi
    $OldApi.WaitForExit(5000) | Out-Null
    $LogPrefix = Join-Path $Runtime ('logs/api-refresh-' + [guid]::NewGuid().ToString('N'))
    $NewApi = Start-Process -FilePath $ApiPython -ArgumentList @('-m','uvicorn','apps.api.app.main:app','--host','127.0.0.1','--port',[string]$ProcessInfo.api_port) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput ($LogPrefix + '.log') -RedirectStandardError ($LogPrefix + '-error.log') -PassThru
    $ProcessInfo.api = $NewApi.Id
    $ProcessInfo.api_started_at = $NewApi.StartTime.ToUniversalTime().ToString('o')
    $ProcessInfo | ConvertTo-Json | Set-Content -LiteralPath $RegistryPath -Encoding utf8
    for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
        if ($NewApi.HasExited) { throw ('API startup failed. See ' + $LogPrefix + '-error.log') }
        try {
            $Health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $ProcessInfo.api_port + '/api/v1/health') -TimeoutSec 2
            if ($Health.status -eq 'ok') { Write-Output 'API updated; the research worker was preserved.'; return }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw ('API did not become healthy. See ' + $LogPrefix + '-error.log')
} finally { $LaunchLock.Dispose() }
