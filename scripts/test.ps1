# Consume only the exact script option: a declared KeepArtifacts parameter would
# also bind pytest's common -k abbreviation in PowerShell.
$KeepArtifacts = $false
$PytestArgs = @()
$OptionsEnded = $false
foreach ($Argument in $args) {
    if (-not $OptionsEnded -and $Argument -eq '--') { $OptionsEnded = $true }
    if (-not $OptionsEnded -and ($Argument -ieq '-KeepArtifacts' -or $Argument -ceq '--keep-artifacts')) { $KeepArtifacts = $true }
    else { $PytestArgs += $Argument }
}

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'python312.ps1')
. (Join-Path $PSScriptRoot 'storage.ps1')
$PythonExe = Get-SystemPython312
$PythonDeps = Get-LlmPythonDeps $ProjectRoot
if (-not (Test-Path -LiteralPath $PythonDeps)) { throw '项目依赖尚未安装。请先运行 .\scripts\bootstrap.ps1。' }
$RunnerArgs = @((Join-Path $PSScriptRoot 'test_runner.py'), '--state-root', (Get-LlmStateRoot $ProjectRoot), '--dependencies', $PythonDeps)
if ($KeepArtifacts) { $RunnerArgs += '--keep-artifacts' }
$RunnerArgs += '--'
# The runner changes only the pytest child's environment; TEMP/TMP and other
# caller variables remain unchanged even on launch failure or interruption.
$TestExitCode = 1
$NativePreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
$HadNativePreference = $null -ne $NativePreference
$SavedNativePreference = if ($HadNativePreference) { $NativePreference.Value } else { $null }
Push-Location $ProjectRoot
try {
    # PowerShell 7 can otherwise throw before we capture a native nonzero exit.
    $PSNativeCommandUseErrorActionPreference = $false
    & $PythonExe @RunnerArgs @PytestArgs
    $TestExitCode = $LASTEXITCODE
} finally {
    Pop-Location
    if ($HadNativePreference) { $PSNativeCommandUseErrorActionPreference = $SavedNativePreference }
    else { Remove-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue }
}
exit $TestExitCode
