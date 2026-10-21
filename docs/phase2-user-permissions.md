# 第二批用户权限改造

标准 OIDC 接口、用户角色、个人工作空间和后台任务身份已实现。保留原 Python SDK、研究与选股接口，本机默认仍为可信单用户模式。此批供封闭测试；公网开放须等待第三至六批完成。

## 登录与配置

生产网页与 API 使用同一 HTTPS 站点。服务器设置以下配置，用户请求和代理输入不能决定这些值：

- `LLMR_AUTH_MODE=oidc`：启用认证；默认 `local` 保留现有本机功能。
- `LLMR_AUTH_ISSUER`：提供方的完整 issuer，必须与 discovery 和 JWT 精确一致。
- `LLMR_AUTH_CLIENT_ID`：OIDC 应用 ID。
- `LLMR_AUTH_CLIENT_SECRET`：机密客户端密钥，仅放在服务端环境或 secret 配置中；公共 PKCE 客户端可省略。
- `LLMR_AUTH_PUBLIC_URL`：网页根地址，例如 `https://research.example.com`。
- `LLMR_IDENTITY_DB_PATH`：可选的身份数据库路径；默认 `STATE_ROOT/identity.db`。

也可使用外部只读 `config.ini` 的 `[auth]` 配置，示例见 [config.example.ini](D:/项目/LLM_research/config.example.ini)。提供方登记的回调为 `PUBLIC_URL/auth/callback`。开发环境只有显式设置 `LLMR_AUTH_ALLOW_HTTP_LOOPBACK=true` 才允许 loopback HTTP；其余 URL 必须 HTTPS。Vite 开发模式另设置 `LLMR_AUTH_MODE=oidc`，它会注入认证标记并代理 `/auth`。

登录使用 authorization code、PKCE S256、一次性 state 和 nonce。回调检查真正的 RS256 签名、issuer、audience、azp、sub、iat、exp 与 nonce；支持 `client_secret_basic`、`client_secret_post` 及无密钥的 PKCE 客户端。认证成功后只向浏览器发送随机的 HttpOnly、Secure、SameSite=Lax 会话 cookie。JWT、供应商 token 和密钥不进入浏览器存储。

`GET /api/v1/me` 返回服务器确定的用户、租户、角色、权限版本及会话 CSRF 值。写请求要求 `X-CSRF-Token` 并保留浏览器来源检查。会话有效期 8 小时；退出在服务端撤销会话。启用 OIDC 后缺少身份的 API、worker store 和 MCP 请求都拒绝执行，身份伪造字段与请求头不能获得额外权限。私有响应禁止缓存。

## 权限与资料归属

平台维护者权限与空间角色分开。`owner` 和 `editor` 可研究、上传和执行选股；`viewer` 可读取、下载和检索，不能修改资料、调用模型或启动计算。全局本地导入、模型诊断和维护同步仅平台维护者可执行。注册新 OIDC 身份默认创建个人空间与 editor 角色，不授予平台管理权限。

本批采用过渡存储：身份、会话、成员关系和审计在单独的控制数据库；每位用户的业务数据库是 `STATE_ROOT/tenants/<tenant>/users/<user>/app.db`。`workspace_owner` 绑定不可修改的租户和用户，所有业务连接在提交前重新检查身份。列表、搜索、旧版条件、观察池、动态指标、历史、快照和导出沿用现有 SQL，连接始终指向当前用户数据库。

附件、研报原件、截图、研究目录、PDF、选股产物、Codex 状态和生成公式的磁盘与内存缓存都按同样的归属分开。相同内容哈希或相同请求 ID 不会复用另一用户的私人资源。同租户成员也有独立个人数据库，不自动共享。新空间只复制服务器公共股票名称，不继承旧用户的报告、对话或策略。

这不是第三批的 PostgreSQL/RLS。旧表中 `owner_id='local'` 等字段暂时保留兼容语义，授权依据是可信 actor 与数据库所有者。团队共享、生产数据库和对象存储迁移仍待实施。

## 后台任务与代理工具

HTTP、数据库、worker、续接、心跳线程和 stdio MCP 传递相同的 actor。队列记录提交用户、租户和权限版本；worker 在对应工作空间领取任务。权限版本不匹配、缺少有效归属或只读角色都不能继续领取任务。

代理工具凭证是有期限的随机 token，服务端只存其摘要，并绑定用户、租户、对话、回合、权限版本和服务器选定的路径。MCP 每次请求重新核验。深度研究凭证使用实际回合预算；降权或停用使会话和工具凭证失效，取消在排队及运行中的工作，拒绝旧 lease 和迟到结果提交。退出登录撤销浏览器会话；已有后台任务按当前用户权限与原有取消机制继续运行。

这些检查位于可信服务边界。第四批才会移除代理对完整业务模块、生产数据库和长期凭证的访问；第五批才会将生成公式、计算和解析统一迁入隔离环境。本机 gVisor 探针已通过，业务执行流程仍等待网关接入，不能据此把当前开发安装直接公开。

## 旧数据与账户管理

旧本机数据仍绑定服务器保留的 `local-admin/local` 工作空间。新用户自动进入空白个人空间。维护者可在该身份首次 OIDC 登录前，关联提供方的 subject，使原维护者继续读取历史资料：

```powershell
python scripts/manage_users.py link --issuer https://issuer.example --subject ORIGINAL_SUBJECT --user local-admin
python scripts/manage_users.py list
python scripts/manage_users.py permissions --user USER_ID --role viewer
python scripts/manage_users.py permissions --user USER_ID --active false
```

命令使用与服务一致的存储与配置环境。issuer 与 subject 是身份标识，不要使用邮件地址自动猜测归属。已关联另一空间的身份会拒绝重新绑定，避免无意吞并私人数据。管理命令只供服务器运维执行，没有提供用户自助授权 API 或 MCP 工具。

封闭测试的数据备份需包含身份数据库及全部个人数据库、上传、成果和 Codex 状态，并使用一致性数据库快照。现有 `backup.py` 仍服务于旧本机备份范围，不能单独覆盖新增的身份与多用户资料；生产备份和恢复验收在第三批一并完成。

浏览器在挂载业务页面前完成登录检查。草稿、附件选择、工作台状态和模型偏好按用户与租户命名；退出、失效、账号切换会清理旧缓存并卸载私人页面。多标签页身份改变会卸载旧标签页的私人内容，本机模式保持旧存储键。

## 验证

测试涵盖真实 RSA 签名与无效声明、PKCE、state 过期与重放、cookie 属性、三个客户端认证方式、CSRF、只读角色、旧数据关联、独立用户与同租户成员、附件和成果、截图、源码缓存、研究输入快照、worker 归属、权限撤销和提交回滚。现有研究与选股的完整后端和前端回归继续运行。

实际镜像检查使用无公网网络、无宿主挂载、只读代码与一次性可变目录：

```powershell
python scripts/verify_readonly_app.py --image llmr-app:phase2
python scripts/verify_readonly_app.py --image llmr-app:phase2 --oidc
```

OIDC 镜像检查只注入合成身份，不消耗模型额度，也不替代接入真实提供方后的登录联调。结果分别存于 `STATE_ROOT/verification/readonly-app/result.json` 与 `readonly-app-oidc/result.json`。

2026 年 10 月 12 日最终验收：后端全量 1005 项通过、2 项跳过；前端全量 504 项通过，生产构建通过。最后的任务绑定与静默模型中断补充检查 6 项通过。PowerShell 语法、Compose 配置与 Git 空白检查通过。新 `llmr-app:phase2` 镜像实际本机模式的 8 项检查、OIDC 双用户模式的 9 项检查均通过；重建的 `llmr-sdk-probe:phase2` 再次以 runsc/KVM 通过全部 8 项 SDK 检查。验收摘要及镜像标识见 [机器可读记录](D:/项目/LLM_research/docs/verification/2026-10-12-phase2.json)。
