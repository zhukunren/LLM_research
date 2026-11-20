---
name: a-share-valuation
description: Compare A-share company valuations and model reproducible valuation ranges with comparable inputs and explicit assumptions.
license: MIT
metadata:
  upstream: https://github.com/spikeHongg/china-stock-research-skills
  upstream-revision: "66bea91d78f55aee97011b29aa64afa641824584"
  upstream-modules: "valuation-investment-strategy"
---

# A股估值分析

确认证券、研究截止日和估值问题。比较时使用同一估值基准日和盈利口径，并说明实际行情交易日、报告期与披露日期。历史分析使用估值时点已可获得的数据。

## 核对可比数据

- 用工作区行情或 `query_tushare` 的 `daily`、`daily_basic` 取得可核对的未复权收盘价或总市值。使用对应时点的股本，核对市值单位及多地上市公司的股份口径。非交易日或停牌时标明实际行情日及比较局限。
- 用 `get_company_financials` 读取本轮冻结财务口径。比较三至五家公司时优先使用 `compare_company_financials`，并通过 `read_financial_evidence` 引用关键财务数值。核对异常损益、并表变化、净债务及其他影响可比性的调整，注明计算口径和来源。
- 按业务结构、增长和利润质量选择同行，解释纳入依据及可能的估值溢价原因。使用历史分位时给出区间、样本覆盖、倍数口径和缺失值处理方式。

## 选择方法并测算

- 利润稳定的公司可用口径一致的 PE。利润为负或受周期与一次性损益显著影响时，说明 PE 的适用性，并在证据足够时用正常化盈利或其他方法。
- 重资产公司可比较 EV/EBITDA，同时核对净债务、租赁、少数股东权益及维持性资本开支的影响。金融企业可结合 ROE、资产质量和资本充足情况解释 PB。业务差异明显的公司可分部估值，并核对分部边界和重复计入项目。
- 现金流可合理估计时可用 DCF。明确现金流与折现率的对应口径，列出预测期、终值假设，以及企业价值到股东价值的调整。若用永续增长模型，核对永续增长率低于折现率，并检查终值占比与敏感性。

用户需要估值区间且数据足够时，计算保守、基准和乐观情景，注明关键假设、来源或估计依据、公式及敏感项。交付应区分已观察到的倍数和模型测算结果，说明哪些披露会改变区间。仅需比较当前倍数时可直接回答。输入不足时给出可确认的比较及待补数据，估值结论用于研究判断。
