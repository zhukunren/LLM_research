# QMT 内置 Python：生命周期与触发时序

根据[迅投系统函数](https://dict.thinktrader.net/innerApi/system_function.html)整理的本地接口参考，核对日期：2026-10-15。完整说明以链接原文及券商客户端帮助为准。

## 基本入口

```python
def init(ContextInfo): ...
def after_init(ContextInfo): ...
def handlebar(ContextInfo): ...
def stop(ContextInfo): ...
```

init 负责启动配置；after_init 在初始化完成后执行一次，适合依赖初始化结果的工作。handlebar 随历史 K 线推进和实时行情到达触发，不能假定一次调用就是一根已收盘 K 线。stop 用于结束处理，停止阶段交易连接已断开，不在此报撤单。

## 状态判断与定时器

- `ContextInfo.is_last_bar()` 返回是否位于最后一根 K 线；它不证明该 K 线已经收盘，也不用于判断回测模式。
- `ContextInfo.is_new_bar()` 用于识别新 K 线。
- `ContextInfo.run_time(funcName, period, startTime)` 注册定时回调，回测不使用此机制。funcName 是函数名字符串。
- 新版另有 `ContextInfo.schedule_run(func, time_point, repeat_times=0, interval=None, name='')`；目标版本不明时先核对可用性。

回测模式应遍历历史，不能用 `if not C.is_last_bar(): return` 跳过全部中间历史 bar。盘中策略须明确使用上一根已完成 bar 还是当前未完成 bar。
