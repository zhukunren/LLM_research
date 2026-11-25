# 服务工作流

先确认用户要查看、预览、生成或保存的对象。`workbench_catalog` 的 `service` 分组提供当前服务操作，具体版本和字段从 `workbench_describe` 获取。预览返回独立的 MCP 图片，直接展示原图并说明可见状态。

- **时点卡片**。用 `GET /api/v1/client-service/cards` 指定北京时间日期，按 `slot_id` 找卡片。已有卡片使用原卡片 ID 读取详情。用户要求生成或重新采集时调用 `POST /api/v1/client-service/cards`，给新的生成意图分配 `request_id`，重试同一次请求时复用它。按卡片 ID 查询状态。草稿调用 `POST /api/v1/client-service/preview`，已保存的图片使用 `workbench_download` 和 `GET /api/v1/client-service/cards/{card_id}/image.png`。
- **开盘计划**。读取 `GET /api/v1/client-service/opening-plans/default-date`，核对日期，再读取对应编辑内容。按用户要求发起采集，并用返回的请求编号查询结果。按用户确认过的内容预览或保存。预览用 `POST /api/v1/client-service/opening-plans/preview`。
- **调仓建议**。核对证券、当前与目标仓位等输入，再按用户要求提交调仓建议任务。用请求编号查看采集结果，保留资料时点与引用。`POST /api/v1/client-service/rebalance-suggestions/preview` 展示已核对的草稿。
- **喜报**。取得组合名称、股票代码和「收盘涨幅」或「盘中最高」口径后，使用 `POST /api/v1/client-service/celebrations`。根据返回的行情时点、来源和校验结果展示图片。
- **生成计划与模板**。先从 `GET /api/v1/client-service/settings` 取实际设置。保存时用 `PUT /api/v1/client-service/settings` 提交当前版本号、所需的修改和完整时点配置，保留其它时点的配置。遇到版本冲突时重新读取后合并用户要求的改动。
