# 选股和跨端续接

## 先试算与确认口径

1. 读 `GET /api/v1/screening-templates` 找适合的固定规则和真实参数。用户只想试算时，用 `POST /api/v1/screening-templates/{template_id}/preview`，传用户选定的股票、截止日、模板版本和参数。用户已有条件时可在条件库找版本，使用该条件的 preview 操作。
2. 按用户意图列出口径、实际行情日期、阈值和样本结果。依照用户要求修改参数，保留此前已明确的单位、排除项、分组和有效时间范围。
3. 用户要保存可编辑组合时，从 `GET /api/v1/filters` 或条件库找可用引用；必要时用条件创建与试算接口生成。组合树的叶子示例为 `{"op":"filter_ref","filter_id":"实际条件ID","version":1}`。较复杂规则从工作台已有规则或操作说明读取实际结构。调用 `POST /api/v1/strategies/validate` 校验树，再按用户要求用 `POST /api/v1/strategies` 保存名称、条件树、数量和稳定 `request_id`。修改组合时携带已有组合 ID，由后端追加版本。

## 网页精调与重复执行

- 打开 Web 后可在「我的方案」或「组合选股」按名称找到已保存版本。对话方案可使用工作台返回的网页根地址加 `#/screening/<conversation_id>` 跳回原对话。用户从 Web 返回后，组合从 `GET /api/v1/strategies?include_history=true` 找到选定的版本，对话方案从保存方案和原对话修订接口读取。
- 组合筛选通过 `POST /api/v1/screening-runs` 传真实策略 ID、明确的策略版本、截止日、用户要求的运行模式、股票池和 `request_id`。提交前显示这些参数。
- 对话选股可在同一对话追加用户要求并处理回合。只要方案时令 `execute_plan` 为 `false`，保持草稿意图。模板应用、改范围、改组合和复用完整对话方案可能授予自动筛选权限，确认要执行时才用这些动作。执行使用目录中对应的原回合和修订接口。
- 用返回的 `run_id` 查当次批次，按 `job_id` 看任务状态。查看历史入选原因从原批次的决策或依据接口读取，沿用原顺序与截止日。组合筛选 CSV 用 `workbench_download` 调用 `GET /api/v1/screening-runs/{run_id}/export`。
