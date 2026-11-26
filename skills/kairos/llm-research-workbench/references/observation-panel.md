# 在开阳聊天消息中打开观察池面板

「打开操作面板」「在对话里打开观察池面板」使用开阳原生的 HTML 消息预览。在技能根目录定位下面三个文件，然后用内置命令工具读取数据、生成 HTML。

```powershell
$assetDir = '<技能绝对目录>/assets'
$reply = curl.exe -q --config "$assetDir/hosted-mcp.curl" --data-binary "@$assetDir/requests/observation-panel.json" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $reply.result.isError) { throw '读取观察池失败' }
$data = ($reply.result.content[0].text | ConvertFrom-Json).data
$rows = @(foreach ($row in $data.items) {
    @{ stock_code = [string]$row.stock_code; name = [string]$row.name; status = [string]$row.status; note = [string]$row.note }
})
$payload = (@{ rows = $rows; total = [int]$data.total } | ConvertTo-Json -Depth 4 -Compress).Replace('<', '\u003c')
$template = Get-Content -Raw -Encoding UTF8 -LiteralPath "$assetDir/observation-panel.html"
$template.Replace('{"rows":[],"total":0}', $payload)
```

将命令生成的**完整 HTML** 放在回复的一个 `html` 围栏代码块里，确保代码块闭合。开阳会在这条消息里渲染预览。数据和备注是输入数据，按命令安全编码后保留。接到筛选真实记录的要求时，可先按观察池查询参数取对应页面，再填入同一个模板。读取失败时说明工具返回的错误。

面板支持本条消息内查找股票、筛选状态、修改状态和备注草稿。圆环图和筛选列表按同一份数据更新。展示已载入数量和工作台记录总数。需要把修改提交到线上时，沿用工作台的记录定位和写入流程。
