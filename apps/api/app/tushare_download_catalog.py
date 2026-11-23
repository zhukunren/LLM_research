"""Datasets and the filters exposed by the Tushare download page."""

from dataclasses import dataclass
from typing import Literal


STOCK, ETF, INDEX = "股票代码", "ETF 代码", "指数代码"
FUND, BOND, CONTRACT = "基金代码", "转债代码", "期货合约代码"
SW_INDEX, THS_CODE, DC_CODE = "申万行业代码", "同花顺板块代码", "东方财富板块代码"
MARKET, FUNDS, FINANCE, RESEARCH = "A 股行情", "ETF 与指数", "财务数据", "特色数据"
INDUSTRY, TRADING, EVENTS, ASSETS, MACRO = "行业与板块", "交易与资金", "公司事件", "可转债与期货", "宏观经济"

CODE_EXAMPLES = {
    STOCK: "600519.SH", ETF: "510300.SH", INDEX: "000300.SH", FUND: "510300.SH",
    BOND: "113052.SH", CONTRACT: "IF2412.CFX", SW_INDEX: "801120.SI",
    THS_CODE: "885785.TI", DC_CODE: "BK1184.DC",
}
DATE_LABELS = {
    "trade_date": "交易日期", "cal_date": "日历日期", "report_date": "研报日期", "surv_date": "调研日期",
    "ann_date": "公告日期", "float_date": "解禁日期", "nav_date": "净值日期",
}


@dataclass(frozen=True)
class Choice:
    parameter: str
    label: str
    options: tuple[tuple[str, str], ...]
    response_field: str = ""


@dataclass(frozen=True)
class Dataset:
    category: str
    label: str
    document: int
    points: int
    description: str
    mode: Literal["range", "listing", "period", "month", "months", "quarters", "snapshot"] = "range"
    code_label: str = STOCK
    market_wide: bool = False
    date_field: str = "trade_date"
    limit: int | None = None
    fields: str = ""
    page_size: int | None = None
    code_parameter: str = "ts_code"
    code_example: str = ""
    day_parameter: str = ""
    market_day_parameter: str = ""
    future_dates: bool = False
    fixed_params: tuple[tuple[str, str], ...] = ()
    choice: Choice | None = None

    @property
    def code_required(self) -> bool:
        return bool(self.code_label and not self.market_wide and self.mode != "listing")


DATASETS = {
    "daily": Dataset(MARKET, "A 股日线", 27, 120, "未复权的开盘价、收盘价、成交量和成交额。", market_wide=True, limit=6_000),
    "daily_adjusted": Dataset(MARKET, "A 股日线（前复权与后复权）", 109, 2_000,
                              "用在线日线和复权因子计算两种价格。前复权以区间内最后一个复权因子为基准。", limit=6_000),
    "weekly": Dataset(MARKET, "A 股周线", 144, 2_000, "每周最后一个交易日更新的开收盘价、最高最低价和成交量。", limit=6_000),
    "monthly": Dataset(MARKET, "A 股月线", 145, 2_000, "每月最后一个交易日的月度行情。", limit=4_500),
    "daily_basic": Dataset(MARKET, "A 股每日指标", 32, 2_000, "换手率、量比、市盈率、市净率和市值。", market_wide=True, limit=6_000),
    "adj_factor": Dataset(MARKET, "A 股复权因子", 28, 2_000, "用于计算前复权和后复权价格的因子。", market_wide=True, limit=6_000),
    "moneyflow": Dataset(MARKET, "个股资金流向", 170, 2_000, "沪深股票按成交单大小统计的买卖量和金额。", market_wide=True, limit=6_000),
    "limit_list_d": Dataset(MARKET, "涨跌停与炸板", 298, 5_000, "涨停、跌停和打开涨停板的股票，不含 ST 股票。", market_wide=True, limit=2_500),
    "stock_basic": Dataset(MARKET, "A 股股票列表", 25, 2_000, "证券代码、名称、行业、交易所和上市退市日期。", mode="listing", limit=6_000,
                           fields="ts_code,symbol,name,area,industry,market,exchange,list_status,list_date,delist_date,is_hs"),
    "trade_cal": Dataset(MARKET, "交易日历", 26, 2_000, "上交所的开市、休市及上一交易日。", code_label="", date_field="cal_date",
                         fixed_params=(("exchange", "SSE"),)),
    "index_classify": Dataset(INDUSTRY, "申万行业分类", 181, 2_000, "申万 2021 版各级行业的名称和代码。", mode="snapshot", code_label="",
                              fixed_params=(("src", "SW2021"),),
                              choice=Choice("level", "行业层级", (("L1", "一级"), ("L2", "二级"), ("L3", "三级")), "level")),
    "index_member_all": Dataset(INDUSTRY, "申万行业成分", 335, 2_000,
                                "成分股票的三级行业及可取得的纳入、剔除日期。", mode="snapshot", market_wide=True, page_size=1_000,
                                choice=Choice("is_new", "成分状态", (("Y", "当前成分"), ("N", "已剔除成分")), "is_new")),
    "sw_daily": Dataset(INDUSTRY, "申万行业指数日线", 327, 5_000, "申万行业的开收盘点位、涨跌幅和成交额。", code_label=SW_INDEX,
                        market_wide=True, limit=4_000),
    "index_weight": Dataset(INDUSTRY, "指数成分和权重", 96, 2_000, "沪深 300 等指数在各月披露的成分股与权重。", code_label=INDEX,
                            code_parameter="index_code", limit=5_000),
    "ths_index": Dataset(INDUSTRY, "同花顺概念板块列表", 259, 6_000, "A 股概念板块名称、代码和成分数量。", mode="snapshot", code_label="",
                         limit=5_000, fixed_params=(("exchange", "A"), ("type", "N"))),
    "ths_member": Dataset(INDUSTRY, "同花顺概念板块成分", 261, 6_000, "指定同花顺概念板块的最新成分股。", mode="snapshot", code_label=THS_CODE),
    "dc_index": Dataset(INDUSTRY, "东方财富板块行情", 362, 6_000, "板块的涨跌幅、领涨股票和上涨家数。", code_label="", day_parameter="trade_date",
                        choice=Choice("idx_type", "板块类型", (("概念板块", "概念"), ("行业板块", "行业"), ("地域板块", "地域")), "idx_type"),
                        limit=5_000),
    "dc_member": Dataset(INDUSTRY, "东方财富板块成分", 363, 6_000, "指定板块在各交易日的历史成分股。", code_label=DC_CODE, limit=8_000),
    "top_list": Dataset(TRADING, "龙虎榜每日明细", 106, 2_000, "上榜股票、上榜原因和席位成交汇总。", market_wide=True, day_parameter="trade_date", limit=10_000),
    "top_inst": Dataset(TRADING, "龙虎榜席位明细", 107, 5_000, "龙虎榜中的营业部或机构席位及其买卖金额。", market_wide=True,
                        day_parameter="trade_date", limit=10_000),
    "margin_detail": Dataset(TRADING, "融资融券明细", 59, 2_000, "证券每日融资余额、融资买入额与融券余额。", market_wide=True, limit=6_000),
    "block_trade": Dataset(TRADING, "大宗交易", 161, 2_000, "每笔大宗交易的成交价、成交额和买卖营业部。", market_wide=True, limit=1_000),
    "limit_step": Dataset(TRADING, "连板天梯", 356, 8_000, "每个交易日连续涨停的股票以及连板次数。", market_wide=True, limit=2_000),
    "stk_limit": Dataset(TRADING, "每日涨跌停价格", 183, 2_000, "证券每日的涨停价与跌停价。", market_wide=True, limit=5_800),
    "dividend": Dataset(EVENTS, "分红送股", 103, 2_000, "指定股票的分红方案、每股派息、股权登记和除息日期。", mode="snapshot", limit=2_000),
    "share_float": Dataset(EVENTS, "限售股解禁", 160, 120, "按解禁日期查看已披露的解禁股数和股东。可选未来日期。", market_wide=True,
                           date_field="float_date", market_day_parameter="float_date", future_dates=True, limit=6_000),
    "stk_holdertrade": Dataset(EVENTS, "股东增减持", 175, 2_000, "在所选公告日期内披露的股东、方向和股份变动。", market_wide=True,
                               date_field="ann_date", limit=3_000),
    "repurchase": Dataset(EVENTS, "股票回购", 124, 2_000, "在所选公告日期内披露的回购进度、股数与金额。", market_wide=True,
                          date_field="ann_date", limit=2_000),
    "fund_daily": Dataset(FUNDS, "ETF 日线", 127, 5_000, "ETF 的开盘价、收盘价、成交量和成交额。", code_label=ETF, market_wide=True, limit=5_000),
    "etf_share_size": Dataset(FUNDS, "ETF 份额与规模", 408, 8_000, "沪深 ETF 的总份额和规模，通常次日更新。", code_label=ETF, market_wide=True, limit=5_000),
    "etf_basic": Dataset(FUNDS, "ETF 列表", 385, 5_000, "ETF 代码、名称、跟踪指数和基金管理人。", mode="listing", code_label=ETF, limit=5_000),
    "index_daily": Dataset(FUNDS, "指数日线", 95, 2_000, "沪深 300 等指数的开收盘点位、涨跌幅与成交额。", code_label=INDEX, limit=6_000),
    "fund_nav": Dataset(FUNDS, "公募基金净值", 119, 2_000, "指定基金的单位净值、累计净值和复权净值。场外基金代码以 .OF 结尾。",
                        code_label=FUND, date_field="nav_date"),
    "fund_portfolio": Dataset(FUNDS, "公募基金披露持仓", 121, 5_000, "指定基金在报告期披露的持仓、持仓市值和比例。",
                              mode="period", code_label=FUND, limit=2_000),
    "etf_sh_cons": Dataset(FUNDS, "ETF 每日申赎清单（沪市）", 471, 8_000, "上交所 ETF 盘前披露的一篮子证券及现金替代信息。", code_label=ETF, limit=3_000),
    "etf_sz_cons": Dataset(FUNDS, "ETF 每日申赎清单（深市）", 472, 8_000, "深交所 ETF 盘前披露的一篮子证券及现金替代信息。", code_label=ETF,
                           code_example="159051.SZ", limit=3_000),
    "income": Dataset(FINANCE, "利润表", 33, 2_000, "营业收入、营业成本、利润和每股收益。", mode="period", market_wide=True),
    "balancesheet": Dataset(FINANCE, "资产负债表", 36, 2_000, "资产、负债和所有者权益。", mode="period", market_wide=True),
    "cashflow": Dataset(FINANCE, "现金流量表", 44, 2_000, "经营、投资和筹资活动现金流。", mode="period", market_wide=True),
    "fina_indicator": Dataset(FINANCE, "财务指标", 79, 2_000, "每股收益、净资产收益率、毛利率等指标。", mode="period", market_wide=True, limit=100),
    "forecast": Dataset(FINANCE, "公司业绩预告", 45, 2_000, "上市公司预告的业绩变动类型和净利润区间。", mode="period", market_wide=True, limit=3_500),
    "express": Dataset(FINANCE, "公司业绩快报", 46, 2_000, "上市公司快报披露的收入、利润和资产。", mode="period", market_wide=True),
    "fina_mainbz": Dataset(FINANCE, "主营业务构成", 81, 2_000, "指定公司的分产品、地区或行业收入、利润与成本。", mode="period", limit=100,
                           choice=Choice("type", "拆分方式", (("P", "按产品"), ("D", "按地区"), ("I", "按行业")))),
    "report_rc": Dataset(RESEARCH, "券商盈利预测", 292, 8_000, "研报发布日、预测财年、每股收益、评级与目标价。", market_wide=True, date_field="report_date", limit=3_000),
    "cyq_perf": Dataset(RESEARCH, "筹码成本与胜率", 293, 5_000, "Tushare 估算的持仓成本区间、平均成本和获利筹码占比。", limit=6_000),
    "cyq_chips": Dataset(RESEARCH, "筹码价位分布", 294, 5_000, "Tushare 估算的各价位筹码占比。", limit=6_000),
    "broker_recommend": Dataset(RESEARCH, "券商月度金股", 267, 6_000, "指定月份各券商推荐的股票。", mode="month", code_label="", date_field="month", limit=1_000),
    "stk_surv": Dataset(RESEARCH, "机构调研", 275, 5_000, "上市公司的机构调研日期、参与机构和接待方式。", market_wide=True, date_field="surv_date", limit=400),
    "cb_daily": Dataset(ASSETS, "可转债日线", 187, 2_000, "可转债的开收盘价、涨跌幅与成交额。", code_label=BOND, market_wide=True, limit=2_000),
    "fut_daily": Dataset(ASSETS, "期货合约日线", 138, 2_000, "指定期货合约的开收盘价、结算价和持仓量。", code_label=CONTRACT, limit=2_000),
    "cn_cpi": Dataset(MACRO, "居民消费价格（CPI）", 228, 600, "全国、城市和农村消费价格的月度同比和环比。", mode="months", code_label="", date_field="month"),
    "cn_pmi": Dataset(MACRO, "采购经理指数（PMI）", 325, 5_000, "制造业与非制造业的月度景气度。", mode="months", code_label="", date_field="month"),
    "cn_gdp": Dataset(MACRO, "国内生产总值（GDP）", 227, 600, "按季度查看国内生产总值、同比增速和三次产业构成。", mode="quarters", code_label="", date_field="quarter"),
}
