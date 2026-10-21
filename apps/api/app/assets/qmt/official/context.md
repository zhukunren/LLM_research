# QMT 内置 Python：ContextInfo 属性、股票池与时间

来源：[迅投变量约定](https://dict.thinktrader.net/innerApi/variable_convention.html)，以及[快速开始](https://dict.thinktrader.net/innerApi/start_now.html)中的时间处理示例。核对日期：2026-10-15。

## 常用属性

- `ContextInfo.barpos`：当前主图 K 线的位置。
- `ContextInfo.stockcode`、`ContextInfo.market`：主图证券及市场。
- `ContextInfo.period`、`ContextInfo.dividend_type`：主图周期、复权设置。
- **`ContextInfo.do_back_test` 是布尔属性**，表示是否回测。不是 `is_back_test`，也不是 `do_back_test()` 方法。未知属性不能当作已经确认的模式判断。
- `ContextInfo.start`、`ContextInfo.end`：回测起止时间；在 init 配置，格式为 `%Y-%m-%d %H:%M:%S`。
- `ContextInfo.capital`：回测初始资金。

## 股票池与时点

```python
ContextInfo.set_universe(['000001.SZ', '600000.SH'])
bar_time = timetag_to_datetime(
    ContextInfo.get_bar_timetag(ContextInfo.barpos), '%Y%m%d%H%M%S')
```

`timetag_to_datetime` 为客户端提供的全局函数，示例不从 xtquant 导入。股票代码使用证券代码加市场后缀；历史请求的截止时间应来自当前策略 bar，不能来自电脑当前时间。

此页只整理常用约定，实际客户端的版本、市场代码和运行配置仍需核对。
