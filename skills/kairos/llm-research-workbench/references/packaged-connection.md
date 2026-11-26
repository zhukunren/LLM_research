# 随包连接线上投研工作台

在开阳同智使用带连接的 Skill 时，用内置命令工具运行 curl。技能目录以加载的 `SKILL.md` 所在目录为准。Windows 使用 `curl.exe`，其他系统使用 `curl`。

```powershell
curl.exe -q --config "<技能绝对目录>/assets/hosted-mcp.curl" --data-binary "@<技能绝对目录>/assets/requests/status.json"
```

连接文件由 curl 读取。展示和引用工具返回的业务结果，连接凭据留在配置文件里。

用户要求在对话查看连接状态时，运行 `status.json`。查询项目、已保存选股方案或观察池时，用同一条命令分别请求对应的 `research-projects.json`、`saved-screening-tasks.json` 或 `watchlists.json`，这些文件都在 `assets/requests/` 中。用户已指定具体任务时，直接调用对应工具。

其他操作在当前对话的工作目录生成请求 JSON，把其绝对路径传给 `--data-binary`。请求格式如下。

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workbench_catalog","arguments":{"query":"研报"}}}
```

用 `workbench_describe` 查询操作的参数和确认要求，再调用 `workbench_read`、`workbench_write` 或 `workbench_download`。将响应中 `result.content` 的文本项按 JSON 解析，依据 `ok`、`isError` 和返回的任务状态回复。连接返回 HTTP 401 时，请维护者更新已授权的 ZIP。
