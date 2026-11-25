# 从 Agent 续接真实研究项目

操作名可以直接用于工具。参数结构和是否需要确认以 `workbench_describe` 返回的工作台版本为准。

1. 读 `GET /api/v1/research-projects`，在 `items` 里定位项目。名称有歧义时用 `AskUserQuestion` 列出匹配项。选定后读 `GET /api/v1/research-projects/{project_id}`，确认公司、项目状态、已有笔记和记录。跨会话续接时重新读工作台。
2. 用用户提供的官方 PDF 链接调用 `POST /api/v1/disclosures/import-url`。上传文件调用 `POST /api/v1/disclosures/upload`，远程 `files.file` 使用 `filename` 和 `content_base64`，披露导入对象放进 `form.payload`。也可在网页先上传原件。遇到未知公司、发布日期或修订关系时，补齐必要信息并保留待核字段。对非披露资料，在目录找资料库上传或研究对话附件。
3. 导入接受后用 `GET /api/v1/disclosure-imports/{import_id}` 或 `GET /api/v1/jobs/{job_id}` 确认真实状态。可在 Agent 内按用户要求调用任务的 `cancel` 或 `retry`。导入完成后再提交 `POST /api/v1/research-projects/{project_id}/companies/{stock_code}/changes`，提供本轮研究截止日 `as_of` 和稳定的 `request_id`。这一步记录当前已接入资料的变化。没有变化时先说清工作台的资料范围。
4. 阅读变化、相关旧判断和原文引用，给出草稿。用 `GET /api/v1/research-projects/{project_id}/notes/{note_id}/history` 查看旧版，用 `GET /api/v1/disclosures/versions/{version_id}/pages/{page}` 核对物理页。通过 `workbench_download` 返回原件的下载链接。引文、页码和可用日期以返回值为准。
5. 用户选保存后，按接口提交 `PATCH /api/v1/research-projects/{project_id}/notes/{note_id}`。发送当前 `base_revision`，保留未修改的标题、主体、验证计划、可推翻条件和状态；把新论点使用的证据及流程返回的引用写进笔记。需要结构化证据时按目录调用该笔记的判断与证据接口。发生 409 时重新读取、展示实际冲突后再写。
6. 重新查询笔记版本，告诉用户已保存的版本、项目和证据链接。用户决定只记录某条资料变化的复核意见时，调用 `POST /api/v1/research-projects/{project_id}/change-checks/{check_id}/review`，按实际 `change_key` 提交。

项目、任务和资料可以分阶段完成。从用户给出的实际状态续接，避免重复创建。
