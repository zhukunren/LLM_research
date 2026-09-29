param(
    [string]$AsOf,
    [ValidateRange(1, 365)][int]$Days = 30,
    [switch]$SkipMarket,
    [switch]$SkipNews
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
$PythonExe = Get-SystemPython312
$PythonDeps = Join-Path $ProjectRoot 'runtime\python-deps'
if (-not (Test-Path -LiteralPath $PythonDeps)) {
    throw '项目依赖尚未安装。请先运行 .\scripts\bootstrap.ps1 -SkipFrontend。'
}
$env:PYTHONNOUSERSITE = '1'
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$PythonDeps;$env:PYTHONPATH" } else { $env:PYTHONPATH = $PythonDeps }

$Arguments = @((Join-Path $PSScriptRoot 'update_tushare_data.py'), '--days', [string]$Days)
if ($AsOf) { $Arguments += @('--as-of', $AsOf) }
if ($SkipMarket) { $Arguments += '--skip-market' }
if ($SkipNews) { $Arguments += '--skip-news' }
& $PythonExe @Arguments
exit $LASTEXITCODE
