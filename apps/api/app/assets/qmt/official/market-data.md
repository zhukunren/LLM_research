# QMT 内置 Python：行情与历史数据

来源：[迅投行情函数](https://dict.thinktrader.net/innerApi/data_function.html)。核对日期：2026-10-15；本页保留常用接口事实，完整字段与其他数据类型请查原文。

## get_market_data_ex

```python
ContextInfo.get_market_data_ex(
    fields=[], stock_code=[], period='follow', start_time='', end_time='',
    count=-1, dividend_type='follow', fill_data=True, subscribe=True)
```

返回证券代码到 pandas.DataFrame 的字典；列对应请求字段，索引为时间序列。常用字段：open、high、low、close、volume、amount、time、suspendFlag。周期如 `1d`、`1m`、`5m`；复权方式如 none、front、back、front_ratio、back_ratio。

回测先下载本地历史数据，明确 `end_time`，通常设置 `subscribe=False`。`fill_data` 决定缺失时的填充行为；返回后仍要检查空表、预热长度、非有限值与时间范围。不要把 init 阶段的本地可用数据视为已成功订阅实时行情。

## 订阅与下载

```python
ContextInfo.subscribe_quote(stock_code, period='follow', dividend_type='follow',
                            result_type='', callback=None)
ContextInfo.unsubscribe_quote(subscribe_id)
```

订阅返回值与回调数据结构需按实际版本核对。`download_history_data` 用于补历史数据，详细参数见原文；不在每次 handlebar 中重复下载。

旧 `get_history_data` / `get_market_data` 的数据形状与新接口不同，不能直接套用相同索引方法。财务历史查询还需核对公告时间口径，避免把报告期当作可获知日期。
