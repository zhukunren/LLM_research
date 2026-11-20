---
name: a-share-company-research
description: Research an A-share company's business transition, order conversion, and competitive advantage using dated, attributable disclosures.
license: MIT
metadata:
  upstream: https://github.com/spikeHongg/china-stock-research-skills
  upstream-revision: "66bea91d78f55aee97011b29aa64afa641824584"
  upstream-modules: "china-stock-research-orchestrator, strategy-business-transition, business-decomposition-order-quality, industry-competition-moat"
---

# A股公司研究

确认公司、证券代码和本轮研究截止日，并说明需要验证的经营判断。用已取得的披露识别影响业绩的业务模式，按用户的问题和 `research_depth` 选择相关检查。

## 经营核验

- **业务转型**。用定期报告、重大交易及融资公告建立时间线。比较新旧业务的收入、毛利、资产投入及现金流贡献，核验管理层披露的里程碑。检查并表、处置和补贴等因素对期间变化的影响。
- **项目与订单**。沿着中标、签约、在手、交付或验收、收入确认、回款逐一核实。记录合同期限、金额口径、履约条件、取消或延期事项。将收入和毛利的变化与合同资产、应收款及经营现金流交叉核验，说明目前证据能确认到哪个阶段。
- **重资产扩张与周期**。用在建工程、投产、有效产能、利用率和单位成本检查扩张兑现程度。结合价格或价差、库存和同行新增产能，判断利润变化中有多少来自行业周期、产能爬坡或公司份额变化。
- **竞争优势**。优先在同一产品或细分市场选择可比公司。核对客户留存、议价能力、成本和利润率等可观察指标，用客户、同行或监管披露交叉检查公司的说法。注明可比范围及无法独立核验的主张。

## 证据与交付

用 `search_disclosures` 定位已归档的年报、附注和公告，再用 `read_disclosure` 读取相关物理页。归档覆盖不足时查找交易所披露、巨潮资讯或公司的公告原文，核对披露时间。用 `get_company_financials` 读取本轮冻结财务口径，并通过 `read_financial_evidence` 引用关键数值。分业务口径以原文为准，保留单位、报告期和披露日期。

先回答用户的问题，随后给出可核验事实及来源、经营判断及推理、尚待验证的问题。深度研究还应给出可能改变判断的指标或事件，并说明到哪份公告或财报核实。仅在证据支持的范围内量化贡献，缺少分部、合同或回款披露时说明缺口。默认使用简体中文，遵循用户指定的输出语言。
