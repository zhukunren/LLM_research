# 官方策略示例入口与选用说明

官方来源：[迅投完整示例](https://dict.thinktrader.net/innerApi/code_examples.html)、[快速开始的运行机制示例](https://dict.thinktrader.net/innerApi/start_now.html)。核对日期：2026-10-15。

原文提供策略示例与不同驱动方式的说明。先按需求判断是历史 bar 回测、盘中逐 bar 信号、行情订阅回调还是定时任务，再阅读对应示例。不能把演示账号、股票、仓位或立即委托参数直接作为用户的设置。

本项目另提供三份独立编写的参考源码：

- `example-ma-signal`：日线均线交叉，只输出上一根已完成 bar 的信号。
- `example-volume-breakout`：日线放量突破，只输出信号。
- `example-backtest-ma`：仅允许回测的股票均线委托示例，委托开关默认关闭。

这些项目示例用于解释代码结构与边界，已做本地逻辑测试，不是官方原例，也没有在用户券商 QMT 上完成运行验证。阅读源码后按需求调整，不能仅替换账号就宣称适合实盘。
