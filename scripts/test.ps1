$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
. (Join-Path $PSScriptRoot 'storage.ps1')
$PythonExe = Get-SystemPython312
$PythonDeps = Get-LlmPythonDeps $ProjectRoot
if (-not (Test-Path -LiteralPath $PythonDeps)) { throw '项目依赖尚未安装。请先运行 .\scripts\bootstrap.ps1。' }
$TestTemp = Join-Path (Get-LlmStateRoot $ProjectRoot) ('test-runs\' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestTemp -Force | Out-Null
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
$env:TEMP = $TestTemp
$env:TMP = $TestTemp
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$PythonDeps;$env:PYTHONPATH" } else { $env:PYTHONPATH = $PythonDeps }
Push-Location $ProjectRoot
try {
    & $PythonExe -m pytest -p no:cacheprovider --basetemp (Join-Path $TestTemp 'pytest') @args
    if ($LASTEXITCODE -ne 0) { throw 'pytest failed.' }
} finally { Pop-Location }
