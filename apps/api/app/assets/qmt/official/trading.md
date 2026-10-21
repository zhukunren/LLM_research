# QMT 内置 Python：委托与交易查询

来源：[迅投交易函数](https://dict.thinktrader.net/innerApi/trading_function.html)。核对日期：2026-10-15。本页是接口参考，运行模式及账号权限以券商客户端为准。

## passorder

```python
passorder(opType, orderType, accountid, orderCode, prType, price, volume,
          strategyName, quickTrade, userOrderId, ContextInfo)
```

opType 表示交易动作；orderType 决定委托组织方式和数量口径；prType 决定选价；price 与 volume 的解释受枚举影响。完整传参时不要省略中间位置参数。返回值不是可据以确认成交的成交回报。回测调用由回测环境处理，实际交易模式可能产生真实委托。

## get_trade_detail_data

```python
get_trade_detail_data(accountID, strAccountType, strDatatype)
get_trade_detail_data(accountID, strAccountType, strDatatype, strategyName)
```

账号类型包括 STOCK、FUTURE、CREDIT 等；数据类型包括 ACCOUNT、POSITION、ORDER、DEAL、TASK 等。返回对象列表，使用对象属性读取，不能假设是字典或 DataFrame。strategyName 对委托和成交筛选有作用，不应当作全局唯一标识或跨终端持仓隔离机制。

委托、成交、可用资金、可卖数量分别查询。撤单前核对对象、状态与 `can_cancel_order` / `cancel` 原型，不猜测委托编号或自动循环报撤。
