import { Activity, Bot, FileText, FolderOpen, LayoutDashboard, ListFilter, MessageCircle, Newspaper, Shapes, Star } from 'lucide-react'

export const workspaceMenus = [
  { id: 'home', label: '开始研究', mobileLabel: '研究', description: '打开新的研究草稿', icon: LayoutDashboard },
  { id: 'screening', label: '研究对话', mobileLabel: '对话', description: '讨论研究问题，计算并整理结果', icon: MessageCircle },
  { id: 'research', label: '研究项目', mobileLabel: '项目', description: '整理项目、公司、笔记与证据', icon: FolderOpen },
  { id: 'conditions', label: '条件选股', mobileLabel: '选股', description: '描述条件、组合执行并回看判断依据', icon: ListFilter },
  { id: 'watchlist', label: '观察池', mobileLabel: '观察', description: '跟踪研究候选与筛选批次', icon: Star },
  { id: 'news', label: '资讯库', mobileLabel: '资讯', description: '阅读资讯，查找业务变化与催化', icon: Newspaper },
  { id: 'technical', label: '技术指标库', mobileLabel: '指标', description: '查看行情与指标，描述选股条件', icon: Activity },
  { id: 'patterns', label: '形态库', mobileLabel: '形态', description: '用真实 K 线核对目标走势', icon: Shapes },
  { id: 'reports', label: '研报库', mobileLabel: '研报', description: '阅读原文，核对公司研究证据', icon: FileText },
  { id: 'assistants', label: '研究助手', mobileLabel: '助手', description: '选择现成的投研助手，一键开始研究', icon: Bot },
] as const

export const workspaceLibraryMenus = workspaceMenus.filter(item => ['news', 'technical', 'patterns', 'reports'].includes(item.id))
// Keep the existing page IDs so saved reading positions remain valid.
export const workspacePrimaryMenus = workspaceMenus.filter(item => ['home', 'screening', 'conditions', 'watchlist'].includes(item.id)).map(item => item.id === 'screening' ? { ...item, label: '研究', mobileLabel: '研究' } : item)

export type PageId = (typeof workspaceMenus)[number]['id']
export const isPageId = (value: unknown): value is PageId => workspaceMenus.some(item => item.id === value)
