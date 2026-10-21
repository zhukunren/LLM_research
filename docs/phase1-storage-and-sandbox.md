# 第一批存储拆分与 SDK 验证

保留 Python SDK 0.159.0 和现有本地研究、选股执行入口。新增可变存储配置、只读应用镜像模板和独立 SDK 兼容性验证程序。标准 OIDC 和个人工作空间已在第二批实现；执行网关和统一计算沙箱仍按后续批次实施。

## 可变存储配置

所有设置由服务端环境变量控制，用户和模型输入不能指定这些值。没有新配置时，继续使用原有目录，不自动搬移或重建数据库、附件和历史研究。

- `LLMR_STATE_ROOT`：数据库默认位置、研报不可变原件、服务 PID/锁/日志与分享配置。默认项目 `runtime`。
- `LLMR_UPLOAD_ROOT`：研报、形态上传及对话附件。默认 `STATE_ROOT/uploads`；未设置此项时，对话附件保留原来的数据库旁 `research-attachments` 布局。
- `LLMR_ARTIFACT_ROOT`：研究目录、原格式成果、项目 PDF 和选股工具产物。默认保留数据库旁的布局，选股工具产物保留 `runtime/artifacts`。
- `LLMR_SANDBOX_STATE_ROOT`：Codex 状态、计算临时目录和生成公式缓存。默认 `STATE_ROOT`；`LLMR_CODEX_HOME` 仍可单独覆盖 Codex 目录。
- `LLMR_DATA_ROOT`：行情、资讯来源及行情同步账本。默认项目 `data`。
- `LLMR_DB_PATH`：单独指定数据库文件，优先于默认的 `STATE_ROOT/app.db`。
- `LLMR_PYTHON_DEPS`：已经安装的依赖目录。默认项目 `runtime/python-deps`，生产镜像放在只读的 `/opt/python-deps`。
- `LLMR_CONFIG_FILE`：只读服务配置文件。默认项目 `config.ini`，可直接指向外部 secret 挂载。
- `LLMR_REQUIRE_EXTERNAL_STORAGE=true`：应用初始化时拒绝任何位于应用目录内的可变存储路径。它是配置检查，源码保护仍由操作系统身份与只读挂载执行。

路径配置见 [storage.py](D:/项目/LLM_research/apps/api/app/storage.py)。研究资料路径仍通过应用数据库决定历史归属，新增配置不会授予用户权限；租户隔离在第二、三批完成。

PowerShell 启动、停止、重载、测试及依赖安装脚本共用 `scripts/storage.ps1`。启动的 Python 服务关闭字节码写入。生成公式缓存从全局临时目录移到显式 sandbox state；独立计算子进程收到指定的依赖位置，并继续过滤模型凭证。

## 切换既有存储

现有本机安装无需设置新变量即可继续运行。需要切换目录时，先等待任务结束、停止该安装并备份，再复制对应的数据目录到新的位置，配置环境后启动。不要一边执行研究，一边移动会话目录。

迁移要包含数据库及 WAL 的一致快照、上传文件、`report-originals`、`research-attachments`、`research`、`research-project-pdfs`、选股 `artifacts` 和 `codex-home`。研报 `source_path`、附件清单和旧研究输入快照可能含旧绝对路径，不能只复制数据库后删除旧目录；需核对并重映射这些引用后再退役旧目录。

`scripts/backup.py` 已能读取配置后的上传与原件位置，并保持原有备份格式。它原来的备份范围不包含全部研究成果和 Codex 状态，迁移时上述目录必须另行保存。`scripts/restore.py` 仍恢复到新的独立目录，显式使用恢复后的配置，不覆盖现有运行目录。

## 只读部署模板

[Dockerfile](D:/项目/LLM_research/deployment/Dockerfile) 有两个独立产物。`app` 包含业务服务与编译后的网页；`sandbox-probe` 只包含 SDK、依赖和最小验证入口，不复制业务项目、Git、真实数据或配置密钥。

[compose.phase1.yaml](D:/项目/LLM_research/deployment/compose.phase1.yaml) 以非 root 身份运行 API 和 worker，应用根文件系统只读，可变卷与代码目录分开。浏览器依赖预装在镜像内，运行时只写受限临时目录。服务配置以只读 secret 挂载，设置 `LLMR_CONFIG_FILE` 指向其实际文件。

使用模板前，把服务配置文件路径作为环境变量提供，再运行：

```powershell
docker compose -f deployment/compose.phase1.yaml build
docker compose -f deployment/compose.phase1.yaml up -d
```

模板仅绑定本机 8000 端口，用于第一批验证。研究 worker 仍使用现有执行流程，源码在它的只读镜像里；后续第四、五批会把代理和计算从完整业务环境中分离。该模板不能作为已经完成认证和多用户隔离的公网部署。

构建后可运行 `python scripts/verify_readonly_app.py`，在无宿主挂载、无公网网络的临时容器中实际验证源码写入被拒绝，以及 API、网页、附件、研究工作区、PDF、原格式文档和计算功能。结果写入 `STATE_ROOT/verification/readonly-app/result.json`。

## SDK 验证入口

验证程序使用真实的固定版本 SDK 与 app-server，连接只在验证环境内运行的确定性 Responses 服务，不使用 ChatGPT 登录或模型账户密钥，也不产生模型推理费用。它检查：SDK 初始化；受限 shell/Python；Excel、Word、PPT、PDF 与图像生成和读取；Playwright；真实 stdio MCP 调用；图像输入；流式回合完成与线程恢复。

MCP 检查要求验证服务实际执行并写入一次调用证明，不能只凭“发出了工具调用”认定成功。容器模式还尝试修改镜像内的代码哨兵，并确认完整业务应用目录不存在。它证明验证环境的边界，不证明后续网关或租户授权已经实现。

严格验证默认要求 gVisor，适配已隔离容器的推荐命令为：

```powershell
python scripts/verify_sdk_sandbox.py --external-sandbox --build
```

要求 Linux Docker engine 已注册 `runsc`。缺少它时返回 `blocked` 和退出码 2，不回退到普通容器或宿主执行。失败返回退出码 1，通过返回 0。结构化记录保存在配置后的 `STATE_ROOT/verification/sdk-gvisor-external/result.json`。省略 `--external-sandbox` 可复核内层 `workspace-write` 的兼容问题，其失败记录单独保留。

可以显式执行另外两种诊断，结果与 gVisor 记录分开：

```powershell
python scripts/verify_sdk_sandbox.py --native
python scripts/verify_sdk_sandbox.py --runtime runc --build
```

`--native` 只验证本机协议与工具兼容，不验证不可写镜像。`--runtime runc` 验证 Linux 只读容器，不代表 gVisor 已通过。这两种都不是默认验证失败后的自动降级。

已经确认，受限容器中的内层 `workspace-write` 会被命名空间限制阻断。可显式验证外层已经隔离后的 `externalSandbox` 协议：

```powershell
python scripts/verify_sdk_sandbox.py --external-sandbox --build
python scripts/verify_sdk_sandbox.py --runtime runc --external-sandbox --build
```

前一条仍要求 `runsc`；后一条只验证普通 Linux 容器。验证程序先实际检查代码哨兵不可写且没有完整业务应用，再允许此模式；禁止在 `--native` 下使用。SDK 的公开 Sandbox 枚举没有 externalSandbox，验证器使用固定版本的 typed app-server client 发送该策略。没有使用 full_access，也没有修改现有业务执行策略。四、五批接入时需要将已验证的策略显式用于外层隔离环境。

所有验证子进程有期限，容器使用无公网网络、丢弃 capabilities、资源配额和限定容量的临时目录，不挂载宿主机项目、Docker socket 或凭证。模板 SDK 与 MCP 私有接口访问只在固定版本的验证程序中封装，现有业务执行未改用这些验证接口。

## 验收记录

### Docker Desktop 的 runsc 配置

[configure_runsc_desktop.py](D:/项目/LLM_research/scripts/configure_runsc_desktop.py) 是仅限服务器维护者执行的安装入口，未注册为 API 或代理工具。它下载官方完整发行包及 SHA-512 校验文件，校验后安装全部 sidecar，保留 Docker 原配置并备份，先验证 daemon 配置再发送 SIGHUP。不会重启 Docker 或修改默认 runtime。

```powershell
python scripts/configure_runsc_desktop.py --release 20261005.0 --platform kvm
python scripts/verify_sdk_sandbox.py --external-sandbox
```

本机安装为 `runsc release-20261005.0`，OCI spec 1.2.1。完整包 SHA-512 为 `79869ae9a589355a46d46fdac068d9a954e741741ffe77c64e38c56ea955498c1cb04e9bce44e1cce5155333e6b76bee72347c6661bb7c78fd2fe3aad198c8fe`。安装位于 Windows `C:/ProgramData/LLMResearch/gvisor/79869ae9a589355a46d46fda`，与仓库分开；Docker VM 使用 `/mnt/host/c/ProgramData/LLMResearch/gvisor/79869ae9a589355a46d46fda/runsc`。配置同时写入 Docker Desktop 用户 daemon 配置及当前 Linux VM。

当前 WSL 内核上 systrap 遇到 syscall thread 初始化失败。显式检查 `/dev/kvm` 后改用 gVisor 官方 KVM 平台并通过验收；没有关闭 seccomp、使用 ptrace 或改成 runc。默认 runtime 仍为 runc，5 个既有容器的启动时间全部保持不变。正式配置已关闭 debug；升级或重启 Docker Desktop 后应重新核对注册与严格验收。其他 Linux 节点应通过自己的系统安装机制配置 runsc，此脚本仅支持本机 Desktop。

2026 年 10 月 12 日的验证结果：

- 完整后端回归：973 项通过，2 项跳过。新增外部存储集成覆盖附件上传/下载、研究快照、PDF 和 Excel/Word/PPT 交付、计算子进程与公式缓存；验证器和存储配置的补充测试为 9 项通过。
- 所有 PowerShell 脚本语法检查通过，Compose 配置检查通过。
- 业务镜像构建通过。实际只读容器中，应用源码写入被拒绝，API 与网页启动、附件、研究工作区、PDF、原格式文档和独立计算全部通过。
- Windows 原生 SDK 的初始化、shell/Python、图像输入、流式完成和续接可用；受限 Windows 沙箱下 Playwright 遇到命名管道权限错误。原生诊断记录不算容器隔离通过。
- Linux 受限容器的嵌套 workspace-write 检查失败：bubblewrap 无权创建新的命名空间。记录保留，未自动放宽权限。
- Linux 只读容器配合显式 externalSandbox：代码不可写、SDK、MCP、浏览器、图像、原格式文档、流式回合和线程续接全部通过。
- 严格 gVisor 检查已通过：实际以 `--runtime runsc`、只读根文件系统、非 root、无宿主挂载及无公网网络运行。8 项探针检查全部通过，包括源码哨兵写入拒绝、SDK 初始化、shell/Python/文档、浏览器、真实 MCP、图像、流式回合和续接。此前缺少 runsc 的阻断已解决；这份本机记录不代替最终生产节点与网关验收。

结构化结果位于运行状态目录的 `verification/sdk-container-external/result.json`、`verification/sdk-container/result.json`、`verification/sdk-gvisor-external/result.json` 及原生诊断目录。它们是本机验证产物，不进入镜像或源码仓库。
