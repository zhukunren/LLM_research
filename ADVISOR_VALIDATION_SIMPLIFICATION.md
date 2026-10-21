# 投顾任务合规检查简化方案

## 现状分析

### 当前的合规检查（closing_review.py + advisor_tasks.py）

#### 1. 成交额口径校验
- ✅ 自动检查沪深两市 vs 沪深京三市
- ✅ 强制统一口径，不允许混用
- ✅ 自动校验引文是否支持金额
- ✅ 自动校验万亿/亿元换算是否正确
- ✅ 自动检查取整是否合理

#### 2. 事件时区校验
- ✅ 强制要求 IANA 时区（不允许 CST 等缩写）
- ✅ 自动校验 UTC 偏移与夏令时规则
- ✅ 自动换算北京时间
- ✅ 自动判断盘前/盘中/盘后
- ✅ 检查客户稿是否写明"北京时间 X月X日 HH:mm"
- ✅ 检查客户稿是否标注盘前/盘后

#### 3. 术语拦截
- ✅ 自动检查"个股宽度" → 建议"上涨股票数量"
- ✅ 自动检查"宽度背离" → 建议"指数与多数股票表现不一致"
- ✅ 自动检查"结构性修复" → 建议"部分板块回暖"
- ✅ 自动检查"分母端/分子端" → 建议简明表达
- ✅ 自动检查"右侧确认/催化兑现" → 建议易懂表达

#### 4. 格式强制要求
- ✅ 客户稿必须包含"盘面回顾""热点板块""明日观察"三段
- ✅ 客户稿最多 1000 字符
- ✅ 必须包含风险提示
- ✅ 上涨家数必须使用约数（不允许精确到个位）
- ✅ 成交额必须明确标注市场范围

---

## 简化方案

### 原则
**人工审核后才交付 → 自动校验可以简化为提示，而非强制拦截**

### 保留的验证（基础数据正确性）
✅ 成交额与引文基本对应（允许误差）
✅ 事件时间是否有来源支持
✅ 字段完整性（不允许空值）

### 简化为提示（不拦截）
⚠️ 术语建议（不强制替换）
⚠️ 格式建议（不强制三段式）
⚠️ 字数建议（不强制 1000 字以内）
⚠️ 约数建议（精确家数给提示即可）

### 完全删除
❌ 成交额口径混用检查（人工可判断）
❌ 万亿/亿元换算校验（Excel 可复核）
❌ 时区 IANA 格式强制（简化为记录原文）
❌ 夏令时自动换算（保留换算功能，但不强制）
❌ 客户稿事件必须写"北京时间 X月X日 HH:mm"（提示即可）

---

## 具体修改方案

### 方案 A：最小改动（推荐）
**保留现有代码，增加"宽松模式"开关**

```python
# advisor_tasks.py
def validate_report(kind, scope, report, items, context, cutoff, strict=False):
    if not strict:
        # 简化模式：只检查基本完整性
        return _validate_basic(report, items, context)
    
    # 严格模式：现有的所有检查
    closing_review.validate(report, items, context.get("closing_policy"), context["advisor"]["audience"])
```

**优点**：
- ✅ 向后兼容
- ✅ 可随时切换严格/宽松模式
- ✅ 改动最小

**缺点**：
- ⚠️ 代码冗余（两套逻辑）

---

### 方案 B：重构为分级检查（推荐，更优雅）
**拆分为三个级别：错误 / 警告 / 建议**

```python
class ValidationResult:
    errors: list[str]    # 必须修复，否则拦截
    warnings: list[str]  # 建议修复，但可以继续
    suggestions: list[str]  # 优化建议

# closing_review.py
def validate(report, items, policy, audience) -> ValidationResult:
    result = ValidationResult(errors=[], warnings=[], suggestions=[])
    
    # 错误级别：基础数据完整性
    if review is None:
        result.errors.append("收评需提交 closing_review")
        return result
    
    # 警告级别：数据一致性（可容忍偏差）
    if review.turnover and not _turnover_roughly_matches(review.turnover, items):
        result.warnings.append("成交额与引文存在偏差，请核对")
    
    # 建议级别：术语和格式
    for term in PLAIN_WORDS:
        if term in report.client_copy:
            result.suggestions.append(f"建议将"{term}"改为"{PLAIN_WORDS[term]}"")
    
    return result
```

**调用方式**：
```python
# 只有 errors 才拦截
validation = closing_review.validate(report, items, policy, audience)
if validation.errors:
    raise AdvisorTaskError("\n".join(validation.errors))

# warnings 和 suggestions 返回给前端展示
return {
    "success": True,
    "warnings": validation.warnings,
    "suggestions": validation.suggestions
}
```

**优点**：
- ✅ 清晰的分级
- ✅ 前端可展示建议，但不拦截
- ✅ 更符合"人工审核"的场景

**缺点**：
- ⚠️ 需要改动前端展示逻辑

---

### 方案 C：完全删除校验（不推荐）
**直接注释掉所有 validate 调用**

```python
# 注释掉
# closing_review.validate(report, items, context.get("closing_policy"), context["advisor"]["audience"])
```

**优点**：
- ✅ 最简单

**缺点**：
- ❌ 失去所有数据质量保护
- ❌ 可能导致明显错误被漏掉
- ❌ 不符合"辅助"定位

---

## 推荐实施路径

### 第一步：立即简化（本周）
**采用方案 A（增加宽松模式）**

1. 在 `advisor_tasks.py` 增加 `strict` 参数
2. 默认 `strict=False`（宽松模式）
3. 只保留基本完整性检查
4. 配置文件可切换严格模式

### 第二步：观察使用（1-2 周）
**收集投顾反馈**：
- 哪些提示有用？
- 哪些拦截过严？
- 是否需要警告级别？

### 第三步：优化重构（根据反馈）
**如果需要更细粒度控制**：
- 采用方案 B（分级检查）
- 前端增加警告展示
- 允许"忽略警告并继续"

---

## 具体代码修改

### 1. 增加宽松模式（advisor_tasks.py）

```python
def _validate_basic(report, items, context):
    """Basic validation: only check completeness."""
    if report.advisor_report is None:
        raise AdvisorTaskError("需提交 advisor_report")
    
    kind = context["kind"]
    if kind == "closing":
        review = report.advisor_report.closing_review
        if review is None:
            raise AdvisorTaskError("收评需提交 closing_review")
        # 只检查字段存在，不检查格式
    
    # 不做其他严格检查
    return

def validate_report(kind, scope, report, items, context, cutoff):
    """Validate advisor report with configurable strictness."""
    from .settings import app_settings
    
    if kind not in ADVISOR_KINDS:
        # ... 现有逻辑
    
    # 检查是否启用严格模式
    strict_mode = app_settings.get("advisor_strict_validation", False)
    
    if not strict_mode:
        # 宽松模式：只检查基本完整性
        return _validate_basic(report, items, context)
    
    # 严格模式：现有的所有检查
    try:
        closing_review.validate(report, items, context.get("closing_policy"), context["advisor"]["audience"])
    except ValueError as exc:
        raise AdvisorTaskError(str(exc)) from exc
```

### 2. 配置文件（config.ini）

```ini
[advisor]
# 投顾任务验证模式：strict（严格）/ basic（基础）
validation_mode = basic

# 严格模式下的具体检查项（可选）
# check_terminology = false  # 是否检查术语
# check_formatting = false   # 是否检查格式
# check_turnover_scope = false  # 是否检查成交额口径
```

---

## 预期效果

### 简化前
❌ "客户稿请将'个股宽度'改为'上涨股票数量'等易懂表达" → **拦截提交**
❌ "客户收评须包含盘面回顾、热点板块和明日观察三段" → **拦截提交**
❌ "成交额与前日比较必须使用同一统计口径" → **拦截提交**

### 简化后
✅ 基本检查通过 → **允许提交**
⚠️ 前端显示建议："可将'个股宽度'改为'上涨股票数量'"
⚠️ 前端显示建议："建议包含盘面回顾、热点板块、明日观察"
👤 **人工审核时再决定是否修改**

---

## 需要确认

1. **是否采用方案 A（宽松模式开关）？**
   - 优点：最快实施，向后兼容
   - 缺点：代码冗余

2. **还是方案 B（分级检查）？**
   - 优点：更优雅，更灵活
   - 缺点：需要改前端

3. **哪些检查必须保留？**
   - 字段完整性？
   - 基本数据一致性？
   - 还是全部简化？

4. **是否需要配置化？**
   - 每个投顾可以设置自己的严格程度？
   - 还是全局统一？

---

请确认方案，我立即开始实施。
