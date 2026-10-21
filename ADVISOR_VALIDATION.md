# 投顾验证级别设置功能

## 概述

投顾验证级别设置允许用户自定义报告提交前的验证严格程度，支持两种级别：

- **基础级别** (`basic`): 只检查必填字段和基本格式，适合人工审核后交付的场景
- **严格级别** (`strict`): 自动检查成交额口径、时区格式、术语规范等所有细节，确保输出质量

## 架构

### 后端 (Python/FastAPI)

#### 配置存储
- 位置: `~/.config/llmresearch/config.ini`
- 配置段: `[advisor]`
- 配置项: `validation_level`

#### API 端点

**GET /api/v1/settings/advisor-validation**
- 获取当前验证级别和可用选项
- 响应示例:
```json
{
  "level": "basic",
  "description": "基础级别 - 只检查必填字段和基本格式",
  "available_levels": [
    {
      "value": "basic",
      "label": "基础级别",
      "description": "只检查必填字段和基本格式，适合人工审核后交付的场景。"
    },
    {
      "value": "strict",
      "label": "严格级别",
      "description": "自动检查成交额口径、时区格式、术语规范等所有细节，确保输出质量。"
    }
  ]
}
```

**POST /api/v1/settings/advisor-validation**
- 设置验证级别
- 请求体:
```json
{
  "level": "strict"
}
```
- 响应示例:
```json
{
  "success": true,
  "level": "strict",
  "message": "验证级别已设置为 strict"
}
```

#### 核心函数

**`app/settings.py`**:
- `AVAILABLE_VALIDATION_LEVELS`: 可用验证级别的常量列表
- `advisor_validation_level() -> str`: 获取当前验证级别
- `set_advisor_validation_level(level: str) -> None`: 设置验证级别

### 前端 (React/TypeScript)

#### 组件

**`src/components/ValidationSettings.tsx`**
- 验证级别设置面板
- 显示当前级别
- 单选按钮组选择级别
- 自动保存

#### 集成位置

**系统设置抽屉 (`SystemDrawer`)**
- 路径: 右上角齿轮图标 → 系统设置
- 位置: "验证设置" 部分

## 使用方式

### 用户界面

1. 点击右上角齿轮图标打开系统设置
2. 找到"验证设置"部分
3. 选择验证级别:
   - **基础级别**: 适合人工审核场景
   - **严格级别**: 自动化质量保证
4. 自动保存，立即生效

### 编程接口

```python
from app.settings import advisor_validation_level, set_advisor_validation_level

# 获取当前级别
current = advisor_validation_level()  # 'basic' 或 'strict'

# 设置级别
set_advisor_validation_level('strict')
```

## 验证行为

验证级别影响以下场景的检查严格程度：

1. **情报台报告生成** (`intelligence.py`)
2. **投顾任务报告** (`advisor_tasks.py`)
3. **其他需要验证的投顾输出**

### 基础级别检查项
- 必填字段存在性
- 基本格式正确性
- 字段类型匹配

### 严格级别额外检查项
- 成交额口径一致性
- 时区格式规范性
- 专业术语正确性
- 数据引用完整性
- 格式规范完整性

## 测试

运行测试脚本验证功能：

```bash
python test_validation_settings.py
```

测试覆盖:
- 默认级别获取
- 可用级别列表
- 设置到 strict
- 设置到 basic
- 无效级别错误处理
- 配置持久化

## 文件清单

### 新增文件
- `test_validation_settings.py` - 功能测试脚本
- `ADVISOR_VALIDATION.md` - 功能文档（本文件）

### 修改文件

**后端**:
- `apps/api/app/settings.py` - 添加 `AVAILABLE_VALIDATION_LEVELS`, `set_advisor_validation_level`
- `apps/api/app/main.py` - 添加 GET/POST `/settings/advisor-validation` 端点和 `AdvisorValidationLevelInput` 模型

**前端**:
- `apps/web/src/components/ValidationSettings.tsx` - 新增验证设置组件
- `apps/web/src/components/SystemDrawer.tsx` - 集成验证设置组件

## 注意事项

1. **配置持久化**: 设置保存在本地配置文件，重启后保持
2. **即时生效**: 修改后立即应用于后续报告生成
3. **向后兼容**: 未配置时默认为 `basic` 级别
4. **错误处理**: 无效级别会抛出 `ValueError` 并拒绝保存

## 未来扩展

可能的扩展方向：
- 添加自定义验证规则
- 每个投顾任务类型独立配置
- 验证规则的详细说明文档
- 验证失败的详细报告和修复建议
