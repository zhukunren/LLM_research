param([string]$RequestFile)

$ErrorActionPreference = 'Stop'
$Installation = Get-ItemProperty -LiteralPath 'HKCU:\Software\LLMResearchWorkbench' -Name InstallDir -ErrorAction SilentlyContinue
if (-not $Installation -or -not $Installation.InstallDir) {
    throw '请先运行投研工作台 Windows 安装包。'
}
$Python = Join-Path $Installation.InstallDir 'runtime\python\python.exe'
$Launcher = Join-Path $Installation.InstallDir 'scripts\desktop_workbench.py'
if (-not (Test-Path -LiteralPath $Python -PathType Leaf) -or -not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
    throw '本地工作台安装不完整。请重新运行投研工作台 Windows 安装包。'
}

$ConnectionJson = & $Python -B -X utf8 $Launcher connect
if ($LASTEXITCODE -ne 0) { throw '本地投研工作台启动失败。请从桌面打开投研工作台查看提示。' }
if (-not $RequestFile) {
    $ConnectionJson
    return
}

$Connection = $ConnectionJson | ConvertFrom-Json
$Request = (Resolve-Path -LiteralPath $RequestFile).Path
& curl.exe -q --noproxy '*' --connect-timeout 5 --max-time 60 --silent --show-error --fail `
    --header 'Content-Type: application/json' --data-binary ('@' + $Request) $Connection.mcp_url
exit $LASTEXITCODE
