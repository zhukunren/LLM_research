function Get-OwnedServiceProcess($Info, [string]$Kind, [string]$Root) {
    $ServicePid = [int]$Info.$Kind
    if ($ServicePid -le 0) { return $null }
    $Service = Get-CimInstance Win32_Process -Filter "ProcessId = $ServicePid" -ErrorAction SilentlyContinue
    if (-not $Service) { return $null }
    $Command = [string]$Service.CommandLine
    $Owned = switch ($Kind) {
        'api' { $Command.Contains('apps.api.app.main:app') -and $Command.Contains("--port $($Info.api_port)") }
        'worker' { $Command.Contains('-m apps.api.app.worker') }
        'web' { $Command.Contains((Join-Path $Root 'apps\web\node_modules\vite\bin\vite.js')) }
    }
    if (-not $Owned -or -not $Service.CreationDate) { return $null }
    $SavedStart = $Info."${Kind}_started_at"
    if ($SavedStart) {
        $Difference = [Math]::Abs(($Service.CreationDate.ToUniversalTime() - ([datetime]$SavedStart).ToUniversalTime()).TotalSeconds)
        if ($Difference -gt 1) { return $null }
    } elseif ($Info.started_at) {
        $AgeAtLaunch = (([datetime]$Info.started_at).ToUniversalTime() - $Service.CreationDate.ToUniversalTime()).TotalSeconds
        if ($AgeAtLaunch -lt -1 -or $AgeAtLaunch -gt 120) { return $null }
    } else { return $null }
    return $Service
}
