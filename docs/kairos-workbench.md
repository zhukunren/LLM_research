# 投研工作台 Web 与 Agent 使用方式

Agent 和网页共用所连接工作台的数据库、模型配置和后台队列。已保存的项目、资料、条件、方案版本、运行批次、笔记和报告在两端可以继续使用。

## 开阳同智连接线上工作台

参赛 ZIP 内提供 Skill、使用说明和 MCP 地址模板。使用开阳同智时导入 ZIP，再导入维护者单独发放的个人 MCP 配置，并在智能体中启用 `llm-research-workbench-remote`。它连接 `https://zjg.dwzq.top/mcp`，直接使用同一工作台服务中已有的研究资料、行情、资讯和任务。[使用和连接](../skills/kairos/llm-research-workbench/references/setup.md)

打开对话后可以说「打开完整投研工作台，列出我的研究项目、已保存选股方案和观察池」，或请智能体检查一只股票的最新可用行情、近期资讯与相关研报。下载时可在网页中打开工具返回的链接。

维护者在本仓库用 `python -X utf8 scripts/build_kairos_workbench_skill.py` 打包，产物位于 `artifacts/kairos-workbench/llm-research-workbench.zip`。线上 MCP 有独立的监听进程和个人连接鉴权，工作台 API 与后台任务继续由现有服务器进程提供。[服务器部署说明](../deployment/SERVER.md)

## 服务工作流

时点卡片、开盘计划、调仓建议和喜报通过 MCP 返回完整图片。已有时点卡片可领取原图，生成计划和模板按当前版本读取与保存。[服务工作流](../skills/kairos/llm-research-workbench/references/client-service.md)
