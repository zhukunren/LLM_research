---
name: llm-research-workbench-local
description: 在开阳启动 Windows 本地投研工作台和聊天操作面板，继续电脑上的研究项目、资料、选股方案、观察池和后台任务。
metadata:
  version: "1.2.0"
---

# 本地投研工作台

用户单独发送本技能、首次用本技能打招呼，或要求启动工作台时，使用 Windows 命令工具运行以下命令。技能目录取当前 `SKILL.md` 的绝对目录。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<技能绝对目录>/scripts/local-workbench.ps1"
```

读取脚本输出的 `url`，调用开阳内置的 `browser_open` 打开该地址。浏览器工具不可用时，附上脚本给出的网页链接。然后在同一轮按 [面板说明](references/workspace-panels.md) 运行面板脚本，传入 `-Startup` 和脚本返回的 `mcp_url`，把生成的完整 HTML 放在回复的一个 `html` 围栏。用一句话提示用户可通过左侧菜单打开面板，并用顶部标签在已打开的面板间切换。

脚本提示工作台未安装时，请用户先运行 Windows 工作台安装包。用户只要网页时执行网页打开步骤。用户指定某个聊天面板或要求刷新时，按 [面板说明](references/workspace-panels.md) 生成相应面板。

用户指定投研操作时，把请求写成 UTF-8 JSON 文件，调用同一脚本加 `-RequestFile "<请求绝对路径>"`。脚本会连接 Windows 安装器提供的本地 MCP。请求示例如下。

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workbench_catalog","arguments":{"query":"观察池"}}}
```

状态用 `workbench_status`。业务操作用 `workbench_catalog` 找接口、`workbench_describe` 核对参数，再用 `workbench_read`、`workbench_write` 或 `workbench_download`。将响应中的文本项按 JSON 解析。需要确认的写入在用户明确确认后传 `user_confirmed: true`。项目与材料参见[项目与证据](references/project-review.md)，选股参见[选股与版本](references/screening.md)，对客服务参见[服务工作流](references/client-service.md)。
