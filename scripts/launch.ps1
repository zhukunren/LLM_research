$ErrorActionPreference = 'Stop'
try {
    & (Join-Path $PSScriptRoot 'start.ps1') -UserMode
    $Records = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\runtime\processes.json') -Raw | ConvertFrom-Json
    Start-Process "http://127.0.0.1:$($Records.web_port)"
    Write-Host '投研工作台已打开。关闭此窗口不会停止服务。'
} catch {
    Write-Host '暂时无法启动投研工作台。请联系维护者检查首次安装或本地服务。'
    Write-Host $_.Exception.Message
    Read-Host '按回车关闭'
    exit 1
}
