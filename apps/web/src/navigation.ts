import { BookOpen, Bot, CalendarDays, ChartNoAxesCombined, Code2, FilePenLine, FileText, History, LayoutDashboard, ListFilter, MessageCircle, Newspaper, Radio, Send, Shapes, Star } from 'lucide-react'

export const workspaceMenus = [
  { id: 'intelligence', label: '情报台', mobileLabel: '情报', description: '市场简报、政策追踪与产业跟踪，核对证据和历史版本', icon: Newspaper },
  { id: 'library', label: '资料库', mobileLabel: '资料', description: '统一检索与阅读资讯、研报和公告', icon: BookOpen },
  { id: 'home', label: '开始研究', mobileLabel: '研究', description: '打开新的研究草稿', icon: LayoutDashboard },
  { id: 'screening', label: '研究对话', mobileLabel: '对话', description: '讨论研究问题，计算并整理结果', icon: MessageCircle },
  { id: 'conditions', label: '条件选股', mobileLabel: '选股', description: '描述条件、组合执行并回看判断依据', icon: ListFilter },
  { id: 'watchlist', label: '观察池', mobileLabel: '观察', description: '跟踪研究候选与筛选批次', icon: Star },
  { id: 'news', label: '资讯库', mobileLabel: '资讯', description: '阅读资讯，查找业务变化与催化', icon: Newspaper },
  { id: 'patterns', label: '形态库', mobileLabel: '形态', description: '用真实 K 线核对目标走势', icon: Shapes },
  { id: 'reports', label: '研报库', mobileLabel: '研报', description: '阅读原文，核对公司研究证据', icon: FileText },
  { id: 'qmt', label: 'QMT 脚本生成', mobileLabel: 'QMT', description: '用自然语言生成 QMT 客户端内置 Python 策略，检查并下载脚本', icon: Code2 },
  { id: 'daily-signals', label: '每日信号汇总', mobileLabel: '信号', description: '查看每日策略买卖信号、近期胜率与回测收益', icon: Radio },
  { id: 'etf', label: 'ETF 同类比较', mobileLabel: 'ETF', description: '按跟踪指数比较 ETF 份额、规模和成交额', icon: ChartNoAxesCombined },
  { id: 'client-service', label: '对客服务', mobileLabel: '对客', description: '定时采集市场状态，编辑时点卡模板并下载对客图片', icon: Send },
] as const

export const clientServiceMenus = [
  { id: 'cards', label: '时点卡片', description: '编辑并导出各个时点的市场卡片', icon: Send },
  { id: 'opening-plan', label: '开盘计划', description: '按日期采集资料并编辑盘前计划', icon: CalendarDays },
  { id: 'suggestions', label: '调仓建议', description: '整理股票、仓位和调仓依据', icon: FilePenLine },
  { id: 'templates', label: '生成计划与模板', description: '设置生成时间和默认文案', icon: FileText },
  { id: 'robots', label: '群机器人', description: '配置企业微信群和群发功能', icon: Bot },
  { id: 'deliveries', label: '发送记录', description: '查看已发送内容和状态', icon: History },
] as const
export type ServiceView = typeof clientServiceMenus[number]['id']

export const workspaceLibraryMenus = workspaceMenus.filter(item => ['library'].includes(item.id))
// Keep the existing page IDs so saved reading positions remain valid.
export const workspacePrimaryMenus = workspaceMenus.filter(item => ['home', 'screening', 'conditions', 'watchlist'].includes(item.id)).map(item => item.id === 'screening' ? { ...item, label: '研究', mobileLabel: '研究' } : item)

export type PageId = (typeof workspaceMenus)[number]['id']
export const isPageId = (value: unknown): value is PageId => workspaceMenus.some(item => item.id === value)
