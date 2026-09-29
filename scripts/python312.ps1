function Get-SystemPython312 {
    $PythonCommand = Get-Command python.exe -ErrorAction Stop | Where-Object {
        $_.Source -and $_.Source -notmatch '\\WindowsApps\\'
    } | Select-Object -First 1
    if (-not $PythonCommand) { throw '系统 Python 3.12 未在 PATH 中找到。' }
    $PythonExe = $PythonCommand.Source
    $Version = (& $PythonExe -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")').Trim()
    if ($LASTEXITCODE -ne 0 -or $Version -ne '3.12') { throw "需要系统 Python 3.12，当前检测到 $Version。" }
    return $PythonExe
}
