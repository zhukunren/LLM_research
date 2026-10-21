# LLM 投研工作平台改进计划

## 目标
- 用户：投资顾问
- 核心场景：研究辅助 + 高频选股
- 要求：易用、美观、减少过度设计

## 一、简化功能（易用性）

### 1.1 删除过度的合规检查
**位置**：`apps/api/app/advisor_tasks.py`、`apps/api/app/closing_review.py`

**删除内容**：
- ❌ 术语拦截（晦涩术语黑名单）
- ❌ 成交额口径自动校验
- ❌ 时区/时刻一致性强制检查
- ❌ "发布契约"和版本冻结逻辑

**保留内容**：
- ✅ 生成投顾任务内容
- ✅ 证据引用和原文定位
- ✅ 历史版本记录（仅供回看）

**原因**：人工审核后才交付，自动合规检查多余

### 1.2 简化情报台版本管理
**位置**：`apps/api/app/intelligence_*.py`、前端 `intelligence.tsx`

**简化方案**：
- 保留生成和证据快照
- 简化版本对比（去掉"新增/变化/延续"的自动标注）
- 投顾手动对比即可

### 1.3 简化动态指标验证
**位置**：`apps/api/app/generated_program.py`

**简化方案**：
- 保留试算和曲线预览
- 保留保存和用于选股
- 简化前视偏差自动检测（多前缀复算）

---

## 二、视觉优化（美观度）

### 2.1 优化色彩系统
**当前问题**：
- 东吴证券蓝 `#00337a` 过于深沉
- 侧栏灰 `#f7f8fa` 缺乏层次
- 整体偏传统，不够现代

**改进方案**：
```css
/* 主色调 - 提亮品牌蓝 */
--ui-primary: #0055a5;  /* 原 #00337a 太暗 */
--ui-primary-hover: #0066bb;
--ui-primary-soft: #e8f2fb;

/* 侧栏 - 增加深度 */
--ui-sidebar: #fafbfc;
--ui-sidebar-border: #e8ecf1;
--ui-sidebar-active: #e6f0fa;

/* 表面 - 增加层次 */
--ui-surface-subtle: #f9fafb;
--ui-border-subtle: #f0f2f5;

/* 阅读区 - 温暖中性 */
--ui-canvas: #fcfcfc;
--ui-text: #1a1a1a;
--ui-text-muted: #5a5a5a;
```

### 2.2 优化圆角系统
**当前**：混用 6px/8px/10px/14px
**改进**：统一语义化圆角

```css
--ui-radius-xs: 8px;   /* 小按钮 */
--ui-radius-sm: 10px;  /* 卡片 */
--ui-radius-md: 12px;  /* 面板 */
--ui-radius-lg: 16px;  /* 对话框 */
--ui-radius-pill: 999px; /* 输入框/按钮 */
```

### 2.3 优化间距系统
**问题**：间距不一致，密度不均

**改进**：
- 侧栏内边距：20px → 16px
- 卡片间距：统一 12px gap
- 阅读区：28px → 24px 左右边距

### 2.4 优化字体系统
**改进**：
```css
--ui-font-sans: "PingFang SC", "Microsoft YaHei UI", -apple-system, sans-serif;
--ui-reading-size: 15px;
--ui-reading-leading: 1.75; /* 原 1.85 太松 */

/* 层次化字号 */
--ui-text-xs: 11px;
--ui-text-sm: 13px;
--ui-text-base: 15px;
--ui-text-lg: 17px;
--ui-text-xl: 20px;
```

---

## 三、交互优化（易用性）

### 3.1 优化侧栏导航
**改进**：
- 突出"新研究"/"新选股"按钮
- 减少层级（合并重复入口）
- 增加图标对比度

### 3.2 优化对话输入
**改进**：
- 输入框圆角 24px → 20px（更平衡）
- focus 状态增加阴影
- placeholder 文案更友好

### 3.3 优化研究结果展示
**改进**：
- 用户消息：圆角气泡
- AI 消息：段落化展示
- 来源引用：卡片式展示

### 3.4 优化加载状态
**改进**：
- 统一 loading spinner
- 增加骨架屏
- 优化进度提示文案

---

## 四、代码重构（可维护性）

### 4.1 统一设计 token
**创建**：`apps/web/src/design-system.css`
- 合并分散的 CSS 变量
- 建立清晰的命名规范

### 4.2 组件化 CSS
**重构**：
- 提取通用按钮样式
- 提取通用卡片样式
- 减少重复代码

---

## 实施优先级

### Phase 1（立即执行）✅
1. 优化色彩系统（tokens.css）
2. 优化圆角和间距（tokens.css）
3. 优化侧栏视觉（chat-layout.css）
4. 优化对话界面（conversation-redesign.css）

### Phase 2（本周完成）
5. 删除投顾任务合规检查代码
6. 简化情报台版本管理
7. 优化按钮和卡片组件

### Phase 3（观察后决定）
8. 简化动态指标验证
9. 重构 CSS 架构
10. 建立设计系统文档

---

## 预期效果

**易用性提升**：
- 减少 30% 的合规拦截
- 简化 20% 的操作步骤
- 更清晰的视觉层次

**美观度提升**：
- 现代化的色彩和圆角
- 统一的间距和字体
- 更好的品牌一致性

**代码质量**：
- 减少 15% CSS 代码量
- 更好的可维护性
- 清晰的设计规范
