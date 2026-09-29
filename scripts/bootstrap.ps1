param([switch]$SkipFrontend)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
$PythonExe = Get-SystemPython312

$PythonDeps = Join-Path $ProjectRoot 'runtime\python-deps'
New-Item -ItemType Directory -Path $PythonDeps -Force | Out-Null
& $PythonExe -m pip install --disable-pip-version-check --target $PythonDeps -r (Join-Path $ProjectRoot 'requirements.lock')
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }

# URL imports use an isolated headless Edge when present; otherwise install Chromium.
$EdgePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $EdgePath)) {
    $PreviousPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = $PythonDeps
        & $PythonExe -m playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw 'Headless Chromium installation failed.' }
    } finally { $env:PYTHONPATH = $PreviousPythonPath }
}

if (-not $SkipFrontend) {
    Push-Location (Join-Path $ProjectRoot 'apps\web')
    try {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    } finally { Pop-Location }
}

Write-Host '系统 Python 与项目本地依赖安装完成；未创建虚拟环境。模型配置由 config.ini 读取。可运行 .\scripts\start.ps1 启动本地平台。'
