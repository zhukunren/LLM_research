$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
. (Join-Path $PSScriptRoot 'processes.ps1')
$PythonPath = [System.IO.Path]::GetFullPath((Get-SystemPython312))
$ProcessesFile = Join-Path $ProjectRoot 'runtime\processes.json'
$PythonDeps = Join-Path $ProjectRoot 'runtime\python-deps'
$env:PYTHONNOUSERSITE = '1'
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$PythonDeps;$env:PYTHONPATH" } else { $env:PYTHONPATH = $PythonDeps }
$StopLock = [System.IO.File]::Open((Join-Path $ProjectRoot 'runtime\services.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
& $PythonPath (Join-Path $PSScriptRoot 'service_processes.py') stop
if ($LASTEXITCODE -ne 0) { throw '未能完整停止项目服务。' }
if (-not (Test-Path -LiteralPath $ProcessesFile)) { Write-Host '本地项目服务已停止。'; return }
$Info = Get-Content -Raw -LiteralPath $ProcessesFile | ConvertFrom-Json
$WebScript = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'apps\web\node_modules\vite\bin\vite.js'))
$Targets = @(
    @{ Id = [int]$Info.api; Kind = 'api' },
    @{ Id = [int]$Info.worker; Kind = 'worker' },
    @{ Id = [int]$Info.web; Kind = 'web' }
)
foreach ($Target in $Targets) {
    $Process = Get-OwnedServiceProcess $Info $Target.Kind $ProjectRoot
    if (-not $Process) { continue }
    $Command = [string]$Process.CommandLine
    $Executable = [string]$Process.ExecutablePath
    $Owned = $false
    if ($Target.Kind -in @('api', 'worker')) {
        $Owned = $Executable -and ([System.IO.Path]::GetFileName($Executable) -ieq 'python.exe') -and ($Command.Contains('apps.api.app.main:app') -or $Command.Contains('apps.api.app.worker'))
    } else {
        $Owned = $Command.Contains($WebScript)
    }
    if ($Owned) { Stop-Process -Id $Target.Id -Force -ErrorAction SilentlyContinue }
}
Remove-Item -LiteralPath $ProcessesFile -Force
Write-Host '本地 API、worker 和前端服务已停止。'
} finally { $StopLock.Dispose() }
