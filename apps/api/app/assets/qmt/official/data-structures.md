# QMT 内置 Python：交易对象字段

来源：[迅投数据结构](https://dict.thinktrader.net/innerApi/data_structure.html)。核对日期：2026-10-15。本页整理示例使用的字段，未列出的对象和字段查原文。

## ACCOUNT、POSITION、ORDER、DEAL

`get_trade_detail_data` 返回的对象列表随查询类型变化，先核对类型再读属性。

- 账号对象：`m_dAvailable` 表示可用金额；它与总资产不是同一概念。
- 持仓对象：`m_strInstrumentID`、`m_strExchangeID` 用于证券识别；`m_nVolume` 为持仓数量，`m_nCanUseVolume` 为可用数量。卖出上限不能仅取持仓总量。
- 委托对象：`m_strOrderSysID`、`m_nOrderStatus`、`m_nVolumeTotalOriginal`、`m_nVolumeTraded`、`m_strRemark` 用于关联和跟踪委托；字段缺失时不能编造默认成交。
- 成交对象：`m_strInstrumentID`、`m_strExchangeID`、`m_dPrice`、`m_nVolume` 为常用成交信息。

同名字段在账号类型或对象类型之间不一定具有相同语义。属性查询失败应保留错误并中止依赖该数据的交易判断；不能用 0 静默替代失败的资金或持仓查询。
