# QMT 内置 Python：交易回调

来源：[迅投成交回报实时主推函数](https://dict.thinktrader.net/innerApi/callback_function.html)。核对日期：2026-10-15。

```python
def account_callback(ContextInfo, accountInfo): ...
def order_callback(ContextInfo, orderInfo): ...
def deal_callback(ContextInfo, dealInfo): ...
def position_callback(ContextInfo, positionInfo): ...
def orderError_callback(ContextInfo, orderArgs, errMsg): ...
```

这些是由终端调用的函数，不要手动调用以伪造执行结果。所列账号回调在实盘运行模式生效，需按原文在 init 中设置 `ContextInfo.set_account(account_id)`；回测不能以没有收到这些回调推断下单失败。

order_callback 反映委托状态变化，deal_callback 反映成交；一笔委托可以有多次部分成交。使用实际回报中的证券、委托标识、备注和状态关联记录，不能只靠调用顺序。

orderError_callback 的 orderArgs 与 errMsg 表示异常下单信息。发生错误后保存可诊断信息，先复核资金、可卖数量、价格、权限和未成交委托，不在回调中无限重试。
