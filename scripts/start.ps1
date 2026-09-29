param([switch]$Restart)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
. (Join-Path $PSScriptRoot 'processes.ps1')
$ApiPython = Get-SystemPython312
$PythonDeps = Join-Path $ProjectRoot 'runtime\python-deps'
$WebRoot = Join-Path $ProjectRoot 'apps\web'
$ViteScript = Join-Path $WebRoot 'node_modules\vite\bin\vite.js'
$Runtime = Join-Path $ProjectRoot 'runtime'
$Logs = Join-Path $Runtime 'logs'
$ProcessesFile = Join-Path $Runtime 'processes.json'
$env:PYTHONNOUSERSITE = '1'
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$PythonDeps;$env:PYTHONPATH" } else { $env:PYTHONPATH = $PythonDeps }

if (-not (Test-Path -LiteralPath $ApiPython) -or -not (Test-Path -LiteralPath $ViteScript) -or -not (Test-Path -LiteralPath $PythonDeps)) {
    throw '系统 Python 或依赖未安装。请先运行 .\scripts\bootstrap.ps1。'
}
New-Item -ItemType Directory -Path $Logs -Force | Out-Null
$LaunchLock = [System.IO.File]::Open((Join-Path $Runtime 'services.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$Launched = @()
try {
$KeepServices = ''
if ((Test-Path -LiteralPath $ProcessesFile) -and -not $Restart) {
    $RecordedServices = Get-Content -Raw -LiteralPath $ProcessesFile | ConvertFrom-Json
    $KeepServices = (@('api','worker','web') | ForEach-Object { $OwnedService = Get-OwnedServiceProcess $RecordedServices $_ $ProjectRoot; if ($OwnedService) { [string]$OwnedService.ProcessId } }) -join ','
}
& $ApiPython (Join-Path $PSScriptRoot 'service_processes.py') stop "--keep=$KeepServices"
if ($LASTEXITCODE -ne 0) { throw '服务清理失败。请运行 bootstrap.ps1 补齐依赖并检查进程后重试。' }
if (Test-Path -LiteralPath $ProcessesFile) {
    $Existing = Get-Content -Raw -LiteralPath $ProcessesFile | ConvertFrom-Json
    $Owned = @(@('api','worker','web') | ForEach-Object { Get-OwnedServiceProcess $Existing $_ $ProjectRoot } | Where-Object { $_ })
    if ($Owned.Count -eq 3 -and -not $Restart) {
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Existing.api_port)/api/v1/health" -TimeoutSec 3
            Invoke-WebRequest -Uri "http://127.0.0.1:$($Existing.web_port)" -TimeoutSec 3 | Out-Null
            if ($Health.status -eq 'ok') {
                Write-Host "投研工作台已在运行：http://127.0.0.1:$($Existing.web_port)"
                return
            }
        } catch { }
    }
    foreach ($Service in $Owned) {
        $Running = Get-Process -Id $Service.ProcessId -ErrorAction SilentlyContinue
        if ($Running) { Stop-Process -InputObject $Running -Force; $Running.WaitForExit(5000) | Out-Null }
    }
}
$env:PYTHONNOUSERSITE = '1'
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$PythonDeps;$env:PYTHONPATH" } else { $env:PYTHONPATH = $PythonDeps }

function Get-FreePort([int]$Preferred) {
    for ($Candidate = $Preferred; $Candidate -lt ($Preferred + 100); $Candidate++) {
        $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Candidate)
        try { $Listener.Start(); $Listener.Stop(); return $Candidate } catch { $Listener.Stop() }
    }
    throw "No free local port near $Preferred."
}

$ApiPort = Get-FreePort 8000
$PreferredWeb = 5173
if ($env:LLMR_WEB_PORT -match '^\d+$') { $PreferredWeb = [int]$env:LLMR_WEB_PORT }
$WebPort = Get-FreePort $PreferredWeb
$env:LLMR_WEB_PORT = [string]$WebPort
$env:LLMR_API_PROXY_TARGET = "http://127.0.0.1:$ApiPort"

$Api = Start-Process -FilePath $ApiPython -ArgumentList @('-m', 'uvicorn', 'apps.api.app.main:app', '--host', '127.0.0.1', '--port', [string]$ApiPort) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'api.log') -RedirectStandardError (Join-Path $Logs 'api-error.log') -PassThru
$Launched += $Api
$Worker = Start-Process -FilePath $ApiPython -ArgumentList @('-m', 'apps.api.app.worker') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'worker.log') -RedirectStandardError (Join-Path $Logs 'worker-error.log') -PassThru
$Launched += $Worker
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Web = Start-Process -FilePath $Node -ArgumentList @("`"$ViteScript`"", '--host', '127.0.0.1', '--port', [string]$WebPort, '--strictPort') -WorkingDirectory $WebRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'web.log') -RedirectStandardError (Join-Path $Logs 'web-error.log') -PassThru
$Launched += $Web

$ProcessInfo = @{ api = $Api.Id; worker = $Worker.Id; web = $Web.Id; api_port = $ApiPort; web_port = $WebPort; started_at = (Get-Date).ToUniversalTime().ToString('o') }
$ProcessInfo.api_started_at = $Api.StartTime.ToUniversalTime().ToString('o')
$ProcessInfo.worker_started_at = $Worker.StartTime.ToUniversalTime().ToString('o')
$ProcessInfo.web_started_at = $Web.StartTime.ToUniversalTime().ToString('o')
$ProcessInfo | ConvertTo-Json | Set-Content -LiteralPath $ProcessesFile -Encoding utf8

$Healthy = $false
for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/health" -TimeoutSec 2 | Out-Null
        Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort" -TimeoutSec 2 | Out-Null
        if ($Worker.HasExited) { throw 'worker exited before startup completed' }
        $Healthy = $true
        break
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $Healthy) { throw "服务没有就绪。请检查日志：$Logs" }

$Url = "http://127.0.0.1:$WebPort"
Write-Host "投研工作台已启动：$Url"
Write-Host "停止服务：.\scripts\stop.ps1"
} catch {
    foreach ($Service in $Launched) { if (-not $Service.HasExited) { Stop-Process -InputObject $Service -Force -ErrorAction SilentlyContinue } }
    throw
} finally { $LaunchLock.Dispose() }
