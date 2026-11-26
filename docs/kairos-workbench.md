# 投研工作台 Web 与 Agent 使用方式

Agent 和网页共用所连接工作台的数据库、模型配置和后台队列。已保存的项目、资料、条件、方案版本、运行批次、笔记和报告在两端可以继续使用。

## 开阳同智连接线上工作台

在「设置 → 技能 → 上传技能 → 上传 .zip 技能包」选择维护者发放的 ZIP。在新对话选用 `llm-research-workbench-workspace`，发送「打开操作面板」。左侧菜单可在同一条消息里切换业务面板，各面板的筛选和草稿随消息保留。

指定「在对话里打开观察池面板」或其他面板，会从指定页面开始。侧栏包含研究项目、研究对话、方案、筛选记录、条件库、形态库、观察池、情报、研报、资讯、信号、对客服务和行情覆盖。面板复用 Web 的界面组件，支持在消息内筛选、排序和联动图表。观察池和研究项目的修改单可交给 Agent 核对保存。

发送「打开投研工作台」后，点击回复中的链接可在开阳打开网站。首次打开时按网页提示登录。开阳中的网站使用 PC 布局，并按预览区宽度等比缩放。[投研工作台网页](https://zjg.dwzq.top/)

维护者从 `apps/web` 运行 `node scripts/build-workbench-panels.mjs` 编译共享资源并发布，然后从仓库根目录运行 `python -X utf8 scripts/build_kairos_workbench_skill.py --mcp-config "<已授权的 MCP 配置文件>" --panel-assets artifacts/kairos-workbench/shared-panels`。产物位于 `artifacts/kairos-workbench/llm-research-workbench-kairos.zip`，按工作台的授权范围发放。[服务器配置](../deployment/SERVER.md#聊天共享面板)

## 服务工作流

时点卡片、开盘计划、调仓建议和喜报通过 MCP 返回完整图片。已有时点卡片可领取原图，生成计划和模板按当前版本读取与保存。[服务工作流](../skills/kairos/llm-research-workbench/references/client-service.md)
