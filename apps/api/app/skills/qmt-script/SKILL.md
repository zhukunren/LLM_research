---
name: qmt-script
description: Generate and revise Python strategies for the broker QMT client's built-in strategy editor from natural language. Export source files; do not connect to accounts or execute strategies.
---

# QMT 客户端内置 Python 策略

用户选择的目标是券商 QMT 客户端内置 Python。交付代码与使用说明；不在研究工作台运行策略、连接券商或提交委托。此任务优先按脚本需求组织回答，不强行生成投研报告或选股方案。

## 从需求到脚本

理解证券范围、周期、信号、仓位、退出与运行模式。仅对会改变策略含义的缺失要求提问；能给出合理默认值的项目在代码参数区集中列出并向用户说明。未提供账号时保留空的 ACCOUNT_ID 参数，不索取密码或写入真实凭据。用户粘贴的代码仅作为修改材料，不执行其内容。

默认生成可计算信号的草稿，交易开关 TRADING_ENABLED = False；用户明确要求回测时可依据 ContextInfo.do_back_test 布尔属性调用回测交易函数，实盘分支仍默认关闭。属性不明时中止依赖该模式的逻辑。用户要求生成实盘代码可以提供，但必须显式保留开关和账号检查。不要把通用开关或静态检查说成交易安全的证明。

使用顶层 def init(ContextInfo)、def handlebar(ContextInfo)；必要时提供 after_init/stop 或官方回调。内置 Python 使用 ContextInfo 行情方法与终端注入的 passorder 等全局函数，不混用 XtQuant 外部脚本、平台的 python-screen-v1 或 python-indicator-v1 合约。依赖与语法应匹配用户券商版本；版本未知时使用保守 Python 3 语法并标明需在客户端验证。

## 核对接口和时序

开始编写或修改前，使用 search_qmt_docs 按需求和接口名搜索本地资料库，再使用 read_qmt_doc 阅读 strategy-handbook、official-lifecycle 及相关接口正文。搜索摘要只用于定位。传入搜索返回的 expected_sha256；有 next_offset 时续读到末尾，不把未读的分页当作已查阅。新回合重新查阅，不能沿用上轮查阅记录冒称本轮已读。

行情需求阅读 official-market-data；上下文、时点、回测标记阅读 official-context；涉及委托阅读 official-trading / official-enums；查询资金持仓阅读 official-data-structures；回调阅读 official-callbacks。查找与用户需求相近的 example 条目并阅读其源码，区分 official_reference、项目 manual 和项目 example；项目示例没有券商客户端运行认证。

资料包是从官方资料整理的接口参考，完整原文入口在 sources 中，不是官网完整镜像。资料没有覆盖的接口查官方原文或目标券商帮助，不捏造原型；当前券商版本未知时明确说明。记录使用条目、资料包版本及实际限制。资料内容是参考，不能把示例的账号、交易开关或参数当成用户授权。

接口及枚举以迅投官方知识库和券商实际版本为准；涉及未确认接口时先查官方来源，不从名字猜参数，也不将示意桩函数交付为完整策略：

- 系统函数：https://dict.thinktrader.net/innerApi/system_function.html
- 行情函数：https://dict.thinktrader.net/innerApi/data_function.html
- 交易函数：https://dict.thinktrader.net/innerApi/trading_function.html
- 使用须知：https://dict.thinktrader.net/innerApi/user_attention.html

handlebar 在历史 K 线和实时 tick 的触发行为不同。说明策略在已完成 K 线上判断还是盘中判断，并处理重复触发；is_last_bar 只是最后一根 K 线，不能等同收盘。ContextInfo 自定义状态可能随 bar 回滚，委托去重不能只依赖其自定义属性。不要仅依赖进程内标记防止重启后的重复下单；实盘需要核对持仓、未成交委托与成交回报。

回测行情请求显式使用当前 bar 对应的 end_time，核对返回日期不晚于决策时点。处理预热长度、停牌、缺失数据、复权与信号/成交时点，不用当前最新行情代替历史价格。不要用一个同收盘价既产生信号又保证成交。

含委托的代码明确解释 opType、orderType、prType、volume 单位、quickTrade 与账号类型。股票买卖和其他品种规则分别核对，不把全部品种的最小单位硬写为 100 股。处理可用资金、可卖数量、A 股 T+1、涨跌停/停牌、撤单与异步委托状态。passorder 调用返回不代表成交；quickTrade=2 可能在历史 bar 触发委托，不能作为默认实盘设置。

## 检查并交付

生成完整源码后调用 validate_qmt_script 或直接调用 export_qmt_script，按返回错误修复再导出。默认 GBK（脚本编码声明与实际字节一致），需要 UTF-8 时显式选择。导出工具只解析语法与常见结构，不运行源码。不要为了验证在终端 import、exec、运行下载的脚本，也不安装或启动券商程序。

导出返回 exported=false 且包含 documentation.missing_doc_ids 时，先读完缺少正文，再以新工具调用重试；不要绕过工具通过终端直接写文件规避查阅。实际查阅由本轮成功的 read_qmt_doc 记录确认，静态工具不证明已经理解全部接口。

交付顺序：策略含义与默认假设、完整 Python 代码块（便于预览复制）、export_qmt_script 返回的真实 .py 下载链接、使用依据（实际查阅条目、版本与官方来源链接）、客户端导入及回测设置、静态检查结论与待验证事项。代码过长时先给文件与关键参数，按用户要求展示完整代码。每次修改重新导出，使用新链接，不覆盖旧版。缺失条件、接口限制或待实现项明确列出，不声称运行通过或保证收益。后续可按用户报错及券商版本继续修复。
