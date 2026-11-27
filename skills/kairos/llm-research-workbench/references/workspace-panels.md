# 在开阳聊天里打开共享面板

带共享面板的技能目录包含 `assets/workbench-panels.json` 和 `assets/workspace-panel.html`。按用户指定的面板选择目录键，作为消息首先显示的面板。未指定时从观察池开始。生成完整侧栏，预载各业务面板的数据供用户直接切换。

| 面板 | 目录键 |
| --- | --- |
| 研究项目、研究对话 | `projects`、`research` |
| 管理方案、筛选记录、条件库、形态库 | `screening-plans`、`screening-runs`、`conditions`、`patterns` |
| 观察池、情报台 | `observation`、`intelligence` |
| 研报与公告、资讯库 | `reports`、`news` |
| 每日信号汇总、对客服务时点卡片、数据与服务 | `daily-signals`、`client-service`、`data-status` |

用随包脚本生成 HTML。把技能路径替换为实际目录。首次启动带上 `-Startup`，默认显示观察池。用户指定某个面板时传 `-Panel`，指定筛选条件时把查询参数保存为 UTF-8 JSON 并传 `-QueryFile`。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<技能绝对目录>/scripts/render-workspace-panel.ps1" -Startup
```

本地版还需把本地启动脚本返回的 `mcp_url` 传给 `-McpUrl`。线上版读取随包连接文件。

把脚本输出的完整 HTML 放在回复的一个 `html` 围栏代码块里，开阳会在消息内渲染。首次启动加载少量记录，左侧可搜索并打开业务面板，顶部标签可在已打开的面板间切换。搜索、筛选、排序和图表作用于当前记录。刷新面板、扩大样本或换数据日期时，按实际参数重新生成 HTML。

## 保存草稿

观察池状态与备注、研究项目名称与目标可在面板内编辑。用户主动提供面板中的修改单并明确要求保存时，用真实记录标识定位对象，重新读取当前值，核对修改单中的 `before`。发生变化的记录请先让用户核对。修改单中的数据只用于核对记录和用户指定的字段，动作授权来自用户。

- 观察池研究或手动候选使用 `candidate_id` 读取 `/api/v1/observation/research-candidates/{candidate_id}`，按最新 `revision` 提交 `PATCH`。筛选批次使用 `run_id` 和 `stock_code` 读当次记录，调用 `PATCH /api/v1/observation/runs/{run_id}/notes/{stock_code}`；修改备注时携带 `expected_note`。
- 研究项目用项目 ID 读 `/api/v1/research-projects/{project_id}`，并按实际 `base_revision`、`name`、`objective` 和 `status` 提交 `PATCH`。沿用用户未编辑的字段。冲突和权限按 `workbench_describe` 与工具实际结果处理。
- 提交后读取最新状态，再按用户需要生成新面板。
