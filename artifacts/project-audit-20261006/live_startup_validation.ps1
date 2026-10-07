$ErrorActionPreference = 'Stop'
$AuditRoot = $PSScriptRoot
$ProjectRoot = (Resolve-Path (Join-Path $AuditRoot '../..')).Path
$RecordPath = Join-Path $ProjectRoot 'runtime/processes.json'
$RootApiPid = 26104
$SummaryPath = Join-Path $AuditRoot 'live-startup-validation.json'
$LogPath = Join-Path $AuditRoot 'live-startup-validation.log'
$Summary = [ordered]@{
    status = 'running'; started_at = (Get-Date).ToUniversalTime().ToString('o')
    audit_database = (Join-Path $AuditRoot 'live/app.db')
    data_root = (Join-Path $ProjectRoot 'data')
    protected_live_server_pid = $RootApiPid
    model_calls = 0
}
$OurServicePids = @()
$StartedOwnServices = $false
$StoppedOwnServices = $false
Set-Content -LiteralPath $LogPath -Value 'UserMode launcher validation against audit DB copy' -Encoding utf8
. (Join-Path $ProjectRoot 'scripts/python312.ps1')
$AuditPythonExe = Get-SystemPython312
$env:PYTHONPATH = Join-Path $ProjectRoot 'runtime/python-deps'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:LLMR_DB_PATH = Join-Path $AuditRoot 'live/app.db'
$env:LLMR_DATA_ROOT = Join-Path $ProjectRoot 'data'
$env:LLMR_CODEX_HOME = Join-Path $AuditRoot 'live/codex-home'

function Get-AuditServiceList {
    $Listing = @(& $AuditPythonExe (Join-Path $ProjectRoot 'scripts/service_processes.py') list)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot safely inspect project service ownership.' }
    return $Listing
}

function Stop-OnlyAuditServices {
    $CurrentServices = @(Get-AuditServiceList)
    $CurrentIds = @($CurrentServices | ForEach-Object {
        if ($_ -match 'pid=(\d+)') { [int]$Matches[1] }
    })
    $Unexpected = @($CurrentIds | Where-Object { $_ -notin $OurServicePids })
    if ($Unexpected.Count) {
        $Summary.cleanup_limitation = 'Other live project services detected; automatic stop withheld.'
        $Summary.unexpected_service_pids = $Unexpected
        throw 'Another active service appeared; stop.ps1 would exceed audit-owned services.'
    }
    & (Join-Path $ProjectRoot 'scripts/stop.ps1') *>&1 | Tee-Object -FilePath $LogPath -Append
    $script:StoppedOwnServices = $true
    $Summary.stop_script_completed = $true
}

try {
    $OriginalServices = @(Get-AuditServiceList)
    $Summary.initial_matching_services = $OriginalServices
    if ($OriginalServices.Count) { throw 'An existing active project service was found; startup and cleanup withheld.' }
    $Protected = Get-CimInstance Win32_Process -Filter "ProcessId = $RootApiPid"
    if (-not $Protected -or -not $Protected.CommandLine.Contains('live_server.py')) { throw 'Protected audit server is unavailable.' }
    $Summary.protected_live_server_creation = $Protected.CreationDate.ToUniversalTime().ToString('o')
    $Tasks = Invoke-RestMethod -Uri 'http://127.0.0.1:8066/api/v1/tasks' -TimeoutSec 10
    $Summary.initial_tasks = $Tasks
    if ($Tasks.active_count -ne 0) { throw 'Audit DB has active tasks; worker startup withheld.' }
    if (Test-Path -LiteralPath $RecordPath) {
        $BackupPath = Join-Path $AuditRoot 'startup-processes-before.json'
        Copy-Item -LiteralPath $RecordPath -Destination $BackupPath
        $Summary.registry_backup = $BackupPath
        $Summary.original_registry = Get-Content -Raw -LiteralPath $RecordPath | ConvertFrom-Json
    }
    $PriorLogs = Join-Path $AuditRoot 'startup-original-logs'
    New-Item -ItemType Directory -Path $PriorLogs -Force | Out-Null
    foreach ($LogName in @('api.log','api-error.log','worker.log','worker-error.log')) {
        $SourceLog = Join-Path $ProjectRoot ('runtime/logs/' + $LogName)
        if (Test-Path -LiteralPath $SourceLog) { Copy-Item -LiteralPath $SourceLog -Destination (Join-Path $PriorLogs $LogName) }
    }
    & (Join-Path $ProjectRoot 'scripts/start.ps1') -UserMode *>&1 | Tee-Object -FilePath $LogPath -Append
    $First = Get-Content -Raw -LiteralPath $RecordPath | ConvertFrom-Json
    $Summary.first_start = $First
    $OurServicePids = @([int]$First.api, [int]$First.worker)
    $StartedOwnServices = $true
    if ($First.web_mode -ne 'bundled' -or $First.web -ne 0 -or $First.api_port -ne $First.web_port) { throw 'UserMode did not use bundled API hosting.' }
    if ($RootApiPid -in $OurServicePids) { throw 'Protected server unexpectedly entered launcher ownership.' }
    foreach ($ServiceId in $OurServicePids) {
        if (-not (Get-Process -Id $ServiceId -ErrorAction SilentlyContinue)) { throw 'New audit service exited.' }
    }
    $ApiBase = 'http://127.0.0.1:' + $First.api_port
    $Health = Invoke-RestMethod -Uri ($ApiBase + '/api/v1/health') -TimeoutSec 10
    $Frontend = Invoke-WebRequest -Uri $ApiBase -TimeoutSec 10
    $Summary.health = $Health
    $Summary.frontend_status = [int]$Frontend.StatusCode
    $Summary.frontend_content_type = $Frontend.Headers['Content-Type']
    $Frontend.Content | Set-Content -LiteralPath (Join-Path $AuditRoot 'live-startup-index.html') -Encoding utf8
    if ($Health.status -ne 'ok' -or $Frontend.StatusCode -ne 200) { throw 'Launcher service was not healthy.' }
    $Summary.listening_addresses = @(Get-NetTCPConnection -State Listen -LocalPort $First.api_port | Select-Object LocalAddress,LocalPort,OwningProcess)
    if (@($Summary.listening_addresses | Where-Object {$_.LocalAddress -ne '127.0.0.1'}).Count) { throw 'Audit API did not bind exclusively to loopback.' }
    & (Join-Path $ProjectRoot 'scripts/start.ps1') -UserMode *>&1 | Tee-Object -FilePath $LogPath -Append
    $Second = Get-Content -Raw -LiteralPath $RecordPath | ConvertFrom-Json
    $Summary.second_start = $Second
    $Summary.reused_same_pids = ($First.api -eq $Second.api -and $First.worker -eq $Second.worker)
    $Summary.reused_same_creation_times = ($First.api_started_at -eq $Second.api_started_at -and $First.worker_started_at -eq $Second.worker_started_at)
    $Summary.matching_services_after_reuse = @(Get-AuditServiceList)
    if (-not $Summary.reused_same_pids -or -not $Summary.reused_same_creation_times -or $Summary.matching_services_after_reuse.Count -ne 2) { throw 'Second startup created or replaced services.' }
    Stop-OnlyAuditServices
    $Summary.remaining_matching_services = @(Get-AuditServiceList)
    $Summary.remaining_owned_pids = @($OurServicePids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $Summary.registry_removed = -not (Test-Path -LiteralPath $RecordPath)
    if ($Summary.remaining_matching_services.Count -or $Summary.remaining_owned_pids.Count -or -not $Summary.registry_removed) { throw 'Launcher cleanup was incomplete.' }
    $StillProtected = Get-CimInstance Win32_Process -Filter "ProcessId = $RootApiPid"
    $Summary.protected_live_server_survived = [bool]($StillProtected -and $StillProtected.CreationDate -eq $Protected.CreationDate)
    $Summary.protected_live_server_health = Invoke-RestMethod -Uri 'http://127.0.0.1:8066/api/v1/health' -TimeoutSec 10
    if (-not $Summary.protected_live_server_survived -or $Summary.protected_live_server_health.status -ne 'ok') { throw 'Protected 8066 server was changed.' }
    $Summary.status = 'passed'
} catch {
    $Summary.status = 'failed'
    $Summary.error = $_.ToString()
    $_ | Out-String | Add-Content -LiteralPath $LogPath -Encoding utf8
} finally {
    if ($StartedOwnServices -and -not $StoppedOwnServices) {
        try { Stop-OnlyAuditServices } catch { $Summary.cleanup_error = $_.ToString() }
    }
    $Summary.finished_at = (Get-Date).ToUniversalTime().ToString('o')
    $Summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $SummaryPath -Encoding utf8
}
$Summary | ConvertTo-Json -Depth 10
if ($Summary.status -ne 'passed') { exit 1 }
