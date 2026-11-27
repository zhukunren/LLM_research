param(
    [string]$Panel = 'observation',
    [string]$QueryFile,
    [string]$McpUrl,
    [switch]$Startup
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$assetDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
$catalog = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $assetDir 'workbench-panels.json') | ConvertFrom-Json
if (-not $catalog.PSObject.Properties[$Panel]) { throw '没有这个面板。' }
$requested = if ($QueryFile) { Get-Content -Raw -Encoding UTF8 -LiteralPath $QueryFile | ConvertFrom-Json }

if ($McpUrl) {
    if ($McpUrl -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}/mcp$') { throw '本地工作台地址无效。' }
    $connection = @('--noproxy', '*', '--silent', '--show-error', '--fail',
        '--header', 'Content-Type: application/json', '--url', $McpUrl)
} else {
    $connection = @('--config', (Join-Path $assetDir 'hosted-mcp.curl'))
}
$timeout = if ($Startup) { '6' } else { '14' }

function Write-PanelRequest($job) {
    $request = @{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{
        name='workbench_read'; arguments=@{ operation=$job.Definition.operation; query=$job.Query }
    } } | ConvertTo-Json -Depth 8 -Compress
    [IO.File]::WriteAllText($job.Request, $request, $utf8)
}

function Read-PanelReply($file) {
    try {
        $result = (Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json).result
        return $result.content[0].text | ConvertFrom-Json
    } catch { return $null }
}

function Read-Field($record, [string]$path) {
    foreach ($part in $path.Split('.')) {
        if ($null -eq $record) { return $null }
        $record = $record.PSObject.Properties[$part].Value
    }
    return $record
}

function Get-RequestArguments($job) {
    $connection + @('--max-time', $timeout, '--data-binary', ('@' + $job.Request), '--output', $job.Response)
}

$jobs = @()
$batchArguments = @('-q', '--parallel', '--parallel-max', '6')
try {
    foreach ($entry in $catalog.PSObject.Properties) {
        $definition = $entry.Value
        $active = $entry.Name -eq $Panel
        $limit = if ($Startup) { if ($active) { 6 } else { 2 } } elseif ($active) { 12 } else { 4 }
        $query = @{}
        if ($definition.query) { foreach ($item in $definition.query.PSObject.Properties) { $query[$item.Name] = $item.Value } }
        if ($query.ContainsKey('limit')) { $query.limit = $limit }
        if ($active -and $requested) { foreach ($item in $requested.PSObject.Properties) { $query[$item.Name] = $item.Value } }
        if ($definition.currentDate -and -not $query.date) {
            $query.date = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'China Standard Time').ToString('yyyy-MM-dd')
        }
        if ($jobs.Count) { $batchArguments += '--next' }
        $job = @{ Key=$entry.Name; Definition=$definition; Query=$query; Limit=$limit;
            Request=[IO.Path]::GetTempFileName(); Response=[IO.Path]::GetTempFileName() }
        $jobs += $job
        Write-PanelRequest $job
        $batchArguments += Get-RequestArguments $job
    }
    & curl.exe @batchArguments | Out-Null
    if ($LASTEXITCODE -eq 2) {
        foreach ($job in $jobs) {
            $requestArguments = Get-RequestArguments $job
            & curl.exe -q @requestArguments | Out-Null
        }
    }
    $snapshots = @(foreach ($job in $jobs) {
        $definition = $job.Definition
        $reply = Read-PanelReply $job.Response
        $notice = $null
        if (-not $reply.ok -and $definition.fallbackQuery) {
            foreach ($item in $definition.fallbackQuery.PSObject.Properties) { $job.Query[$item.Name] = $item.Value }
            Write-PanelRequest $job
            $requestArguments = Get-RequestArguments $job
            & curl.exe -q @requestArguments | Out-Null
            $reply = Read-PanelReply $job.Response
            $notice = $definition.fallbackMessage
        }
        if (-not $reply.ok) {
            @{ panel=$job.Key; rows=@(); total=0; unavailable=$true; notice='暂未取到数据，可在网页查看或发送「刷新面板」。' }
            continue
        }
        $data = $reply.data
        $items = if ($definition.items) { $data.PSObject.Properties[$definition.items].Value } else { $data }
        $items = @($items | Where-Object { $null -ne $_ })
        $keys = @($definition.columns | ForEach-Object { $_.key; $_.detail }) + @($definition.identity)
        $keys = $keys | Where-Object { $_ } | Select-Object -Unique
        $rows = @(foreach ($item in ($items | Select-Object -First $job.Limit)) {
            $row = @{}
            foreach ($key in $keys) { $row[$key] = Read-Field $item $key }
            foreach ($column in $definition.columns) {
                if ($column.fallback -and -not $row[$column.key]) {
                    $row[$column.key] = Read-Field $item $column.fallback
                }
                if ($column.countOf) {
                    if ($item.covers_date -eq $false) { $row[$column.key] = $null }
                    elseif ($null -eq $row[$column.key]) {
                        $collection = $item.PSObject.Properties[$column.countOf].Value
                        if ($collection -is [array]) { $row[$column.key] = $collection.Count }
                    }
                }
            }
            if ($definition.previewPoints) {
                $points = $item.PSObject.Properties[$definition.previewPoints].Value
                if ($points -is [array] -and $points.Count -ge 2) {
                    $samples = [Math]::Min($points.Count, 32)
                    $row['preview_points'] = @(for ($sample = 0; $sample -lt $samples; $sample++) {
                        $points[[int][Math]::Round($sample * ($points.Count - 1) / ($samples - 1))]
                    })
                }
            }
            $row
        })
        $total = if ($null -ne $data.total) { [int]$data.total } else { $items.Count }
        $partial = $null -eq $data.total -and $job.Query.ContainsKey('limit') -and $items.Count -ge [int]$job.Query.limit
        $date = if ($definition.dateField) { Read-Field $data $definition.dateField } elseif ($definition.currentDate) { $job.Query.date }
        $snapshot = @{ panel=$job.Key; rows=$rows; total=$total; date=[string]$date; notice=[string]$notice; partial=$partial }
        if ($definition.sampleSizeField) {
            $samples = Read-Field $data $definition.sampleSizeField
            if ($null -ne $samples) { $snapshot.sampleSize = [int]$samples }
        }
        $snapshot
    })
} finally {
    foreach ($job in $jobs) { Remove-Item -LiteralPath $job.Request,$job.Response }
}

$payload = (@{ panel=$Panel; panels=$snapshots } | ConvertTo-Json -Depth 8 -Compress).Replace('<', '\u003c')
(Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $assetDir 'workspace-panel.html')).Replace('__LLMR_PANEL_DATA__', $payload)
