# zjg.dwzq.top 单用户部署

- 源码：`/data/projects/LLM_research`，部署基线 `d8b308d`。
- 地址：`https://zjg.dwzq.top`；Nginx Basic Auth 保护整个站点，共享一个工作空间。
- 账户记录：`sudo cat /etc/llmr/login.txt`。密码哈希：`/etc/nginx/llmr.htpasswd`。
- 服务：`llmr-api`、`llmr-worker`，开机自动启动，API 仅监听 `127.0.0.1:18860`。
- 配置：`/etc/llmr/config.ini`、`/etc/llmr/service.env`。
- 数据：`/var/lib/llmr`，运行账户 `llmr`。
- Nginx：`/etc/nginx/sites-available/zjg.dwzq.top`。
- HTTPS 使用 Certbot 自动续期，deploy hook 重新加载 Nginx。

## 模型与行情

在 `/etc/llmr/service.env` 设置 `OPENAI_API_KEY`、`TUSHARE_TOKEN`。
模型、API 地址及协议在 `/etc/llmr/config.ini` 设置；已按本机 Codex 用户配置接入 gpt-6.1-sol（Responses、low），Tushare Token 从部署会话环境导入；凭证仅保存在服务器配置中。
修改后运行 `sudo systemctl restart llmr-api llmr-worker`。
不要提交密钥，不要将本部署当作多用户隔离服务。

## 运维

```sh
sudo systemctl status llmr-api llmr-worker
sudo journalctl -u llmr-api -u llmr-worker -n 100 --no-pager
sudo systemctl restart llmr-api llmr-worker
```

更新前停止后台任务并备份 `/var/lib/llmr` 和 `/etc/llmr`。
前端更新需在 `apps/web` 运行 `npm ci && npm run build`。
`npm run build` 的 postbuild 会将生成的 `dist` 目录设为 755、文件设为 644，确保独立的 `llmr` 服务账户可读取。若直接调用 Vite 构建，完成后需运行 `npm run postbuild`；构建账户的 `umask 0077` 会使未处理的文件仅本人可读，并导致首页 500。
本地变更 `LLMR_TRUSTED_ORIGIN` 仅接纳服务器配置的准确源，不信任请求 Host；更新源码时保留此变更和相应安全测试。

验证：前端生产构建通过；HTTPS 未登录返回 401，登录后首页及健康检查返回 200；浏览器无 JS 异常；模型真实 JSON 请求成功；Tushare trade_cal 返回 code=0。
Codex SDK 原生搜索实测通过：返回 6 条搜索结果，并成功打开官方页面。模型客户端和请求来源检查共 30 项测试通过。

## 模型选择策略（2026-11-06 更新）

通过本机 Codex `model/list` 获取当前 22 个可见模型及推理档位，元数据保存在 `/etc/llmr/codex-models.json`，由 `LLMR_CODEX_MODEL_CATALOG` 指定。仍以服务端模型发现核对访问权。
`LLMR_DISABLED_MODELS` 禁用 Sol/Astra 及别名（gpt-5.6、gpt-6），在网页显示灰色并由后端拒绝执行。
默认改为 `gpt-6-luna` / high；旧的仅允许 gpt-6.1-sol 限制已移除。34 项模型目录和接口测试通过。

2026-11-06 搜索检查修复：兼容原生工具 `action=other`、`turnNviewN` 与 `Total lines` 的官方页面读取证据；搜索结果本身不会当作页面读取成功。26 项 Codex runtime 单元测试通过。修复后在线 API 复测 verified=true、search_results=14、opened_page=true（约 27.5 秒）；服务账户独立复测同样成功。
Tushare 同日实测 trade_cal、stock_basic、daily 均 HTTP 200 / code 0，分别返回 2、1、1 行；此结果仅覆盖以上接口权限。

## 运行修复和资源上限（2026-11-06）

MCP 保留虚拟环境解释器路径，禁止 resolve 到系统 Python。使用 `deployment/verify_hosted_runtime.py` 可验证 stdio initialize、45 个工具及真实 Codex required MCP 会话创建，不提交模型请求。已在与服务一致的权限与资源边界内通过。

网页桌面默认 80% 显示，手机保留原字号。营业部名称仅在侧栏左上显示为“张家港营业部投研工作台”，使用正常字号与字重。

`llmr.slice` 为 API、worker 及其 Codex/MCP/浏览器子进程提供共享上限：

- CPU 80%（0.8 个核心）；低 CPU/IO 调度优先级。
- 内存软阈值 1 GiB、硬上限 1280 MiB，swap 最多 256 MiB；进程/线程最多 160。
- 每服务 `/tmp` 192 MiB、`/var/tmp` 32 MiB，均为独立 tmpfs，计入内存。
- 数据 `/var/lib/llmr` 迁到 `/var/lib/llmr-storage.ext4` 的 3 GiB 有界卷，fstab 持久挂载；源码和依赖为只读固定安装，不计入数据卷。
- 独立 `llmr` 日志命名空间，磁盘上限 64 MiB，最长保留 7 天。查看：`sudo journalctl --namespace=llmr -u llmr-api -u llmr-worker`。
- 禁止无关插件市场自动下载，计算库线程数限制为 1；已移除应用内不用的 Chromium 1194 副本。

数据卷现有浏览器组件约 924 MiB，剩余约 2 GiB 给研究、上传和行情。卷满时写入会失败，需要导出或清理数据；内存超过硬上限会终止任务并重启服务。迁移前用户数据备份在 `/etc/llmr/backups/before-storage-limit-20261106.tar.gz`。
资源配置参考同目录 `llmr.slice`、`resources.conf`、`journald-llmr.conf`。

视觉复核：1440×900、1280×720、390×844、360×640 均无横向溢出，入口卡片完整可见，无 JavaScript 错误。模型菜单限制高度，列表独立滚动，标题和推理设置固定可见；22 个模型和 6 个禁用项均保留。模型菜单 7 项现有测试及生产构建通过。

## Sub2API 项目配置（2026-11-06）

本项目独立读取 `/etc/llmr/codex.toml`（环境变量 `LLMR_CODEX_CONFIG_FILE`），SDK 的会话创建、恢复及原生搜索都使用其中的 OpenAI provider。当前默认模型与 review_model 均为 gpt-6-luna；用户原先指定的 gpt-5.5 被中转明确以 model_not_found 拒绝，已按用户后续选择改用 Luna。
地址 `http://111.229.72.145:8081/v1`，Responses 协议，模型目录 `/v1/models`；启用用户指定的 api_key_model_discovery、goals、网络访问与 disable_response_storage。配置样本见 `deployment/codex.toml`，实际 API key 只保存在 `/etc/llmr/service.env`。
新密钥真实认证、模型 JSON 请求、Codex SDK 模型请求和 required MCP 启动均验证成功。模型目录由新密钥的 Codex model/list 同步为 20 个，Sol/Astra 及别名 5 个禁用。后续刷新目录应使用同一服务配置与凭证。

## 每日信号汇总工具（2026-11-13）

入口：研究/选股侧栏的“共享资料 → 每日信号汇总”，地址 `#/tools/daily-signals`。
按 `/home/ubuntu/fast-backtest/web/docs/daily-signals-api.md` 接入公开只读接口 `https://jshs.dwzq.top/api/strategies/signals`。浏览器通过本站 `/api/v1/daily-signals/signals` 查询，服务端替换策略名称及标识后仅返回展示所需字段，不转发上游 items、原名称、generation_id 或额外元数据。初次加载读最新缓存，按日期和 N 手动查询/刷新，不进行轮询、回测或行情更新，不增加服务端定时任务及数据落盘。
按策略展示买卖股票、胜率、平均每笔收益及年化收益，并提供样本与净值区间。默认仅显示有信号或未覆盖日期的策略；缺失缓存、未覆盖、没有信号、零收益与空值分别呈现。页面支持手机布局，与工作区标签和快捷导航集成。
上线验证：78 项页面/路由/导航相关测试通过，生产构建通过。真实跨域请求确认未携带 Authorization；最新缓存与历史日期/N 查询成功。研究和选股侧栏入口均通过浏览器验证，390px/360px 手机查询栏完整显示，无横向溢出。

2026-11-15 策略更名：15 个现有策略使用“云岫择时策略、听澜短线策略、青禾逆转策略、竹隐加速策略、棠溪顺势策略、月白蓄势策略、晴川复合策略、松弦回调策略、栖迟量价策略、星汐修复策略、沐岚承接策略、知夏双驱策略、疏影动能策略、砚池领涨策略、雾舟量能策略”，独立代号保留固定对应关系，风格词依据2026-11-15已核对且与源码SHA256匹配的策略说明概括，不使用原名或近期收益命名。`daily_signal_aliases.py` 保存固定对应关系（仅使用摘要键），现有名称统一为 6 字，新增策略采用稳定的 6 字金融策略备用名。切换日期、N、排序、筛选及刷新不改名，行情面板与信号标记沿用卡片名称。
每日信号面板详情已改为常显：样本数、有效盈亏数、盈利笔数、缓存截止、样本平仓区间、年化净值区间及交易日数直接展示；统计口径常显。页面无折叠区块，已完成桌面/手机真实数据检查、4 项页面测试及生产构建。

每日信号页已设置独立滚动区域，修复父容器隐藏溢出造成的滚轮无法向下浏览问题；面板支持键盘焦点及 PageDown/End。导航入口移到共享资料，并保留已有直达地址兼容书签。
每日信号配色：买入红、卖出绿（汇总数量、方向标题与股票标签一致）；胜率严格高于 50% 为红、低于 50% 为绿，50% 与不可计算值保持中性。股票标签复用 StockMention，打开现有行情面板，并按信号查询日传递 as_of。修复公共股票操作浮层在 80% CSS 缩放下的坐标偏移，避免浮层遮挡代码点击。9 项相关测试、生产构建、桌面/手机真实代码展开及 0/50/>50/null 阈值检查通过。

## 每日信号行情与操作说明（2026-11-13 更新）

共享资料包含每日信号汇总和更多工具，QMT 工具保留当前研究/选股工作区。每日信号标题与数据状态提示已合并；点击卡片上的胜率、每笔收益或年化收益可切换全列表升降序，缺失/未覆盖指标始终排在末尾。

股票代码复用全局行情面板并传入所选策略、日期及已确认方向。每日信号行情通过 `/api/v1/daily-signals/chart/{code}?as_of=YYYY-MM-DD` 按需读取官方未复权日线，默认最近 180 个实际交易日；不足时显示实际数量，不填充虚拟 K 线。最多缓存 12 个证券/日期组合、5 分钟有效。红买/绿卖标记只对应所选日期的已确认信号，不把成交日或期末估值记录伪装成历史信号。

成交量按日批量接口 `/api/v1/daily-signals/market` 每批最多 500 只，日缓存最多 2 天、5 分钟有效，不落盘、不轮询。行情面板含成交量副图及联动读数。

列表上的合规理由按钮已移除。行情面板内的客户操作说明支持买入/卖出，点击后由 Codex 原生网页检索并打开公开原文，结合独立计算的 MA5/20/60、5/20 日涨跌幅及量比生成客户文案，不读取上游策略、信号或规则接口。只使用查询日及以前的行情与公开资料，不用事后走势为操作辩护；可编辑、复制并查看来源。输出仅解释操作考虑，不证明实际成交或客户真实决策动机。

任务使用已有 research_turn 队列，054_trade_explanations.sql 保存幂等请求与业务会话绑定；关闭面板后可恢复结果/进度。已完成的说明不自动重新调用模型；专用说明回合不生成 PDF，继续受 llmr.slice 资源限制。`POST /daily-signals/reason` 只接受 request_id/code/date/side，GET 同路径 /{request_id} 查询进度，POST /{request_id}/cancel 停止。仅接受实际检索且已打开的公开来源，排除晚于查询日期的引用。

实测：180 根真实 K 线、买卖信号标记、缺失值排序、共享入口、桌面鼠标和手机触屏。已完成真实 Codex 买入（300148.SZ，2026-11-11）与卖出（300310.SZ，2026-11-12）研究，分别保留 2 / 3 条实际打开的公开来源。
交付验证：后端 33 项相关测试通过；前端排序、标记、导航、股票交互和工作区回归通过，TypeScript 与生产构建通过。桌面已实测指标升降序、180 根 K 线、卖出标记和结果复制；手机已实测 180 根 K 线、买入标记、研究结果恢复与复制。另修复触屏聚焦时的 hover 操作浮层抢先干扰点击问题。客户稿直接解释买入/卖出考虑，内部成交核验缺口保留在 limitations 中，不混入可复制正文。真实 Codex 两种方向均已取得实际打开的公开来源。

视觉复核（同日）：在 1440×900、1280×720、390×844、360×640 检查每日信号列表、行情和已生成的操作说明。修正 80% 桌面缩放下行情抽屉仅占 80% 屏高的问题，改为占满可用高度；手机买卖方向和统计字段名称不再拆行，来源日期保持完整。各尺寸排序、列表滚动、180 根 K 线、抽屉关闭与横向溢出检查通过；完成态复用已生成结果，不新增模型调用。历史信号随上游缓存更新可能变化，完成态视觉检查在浏览器内回放先前确认的证券信号上下文，行情及说明仍读取本站真实接口。

## 对客服务（2026-11-15）

入口“更多工具 → 对客服务”，地址 `#/tools/client-service`。055 迁移保存六个时点的模板、计划、卡片和幂等请求；`llmr-worker` 内部调度线程按北京时间检查计划，Codex 只采集市场状态。用户文案单独存储并进行 revision 冲突检查。已生成 PNG 存入工作空间的 `artifact_root/client-service`；实时预览与下载共用 Pillow 排版，中文依赖 Noto Sans CJK。

默认六个时点为 08:45、09:45、10:30、11:35、14:30、15:30，生成星期可选。初始新工作空间默认未启用计划，当前单用户站点按本次用户要求配置后开启。任务完成、请求重试和服务重启均保留结果；采集不生成 PDF，不进入普通研究历史，不向外发送内容。图片模型底图由用户明确后置；现有中转分组图片接口返回 403，暂使用标准蓝白版式。完整数据契约和维护方法见 `docs/client-service.md`。

部署前数据库备份为 `/etc/llmr/backups/before-client-service-20261115T083926Z.sqlite`。当前已开启周一至周五六个时点。真实 Codex 已完成 2026-11-13 收盘采集，保留实际检索并打开的来源；该次来源为财经社区，因此数据口径和来源限制标为 partial，未伪装成交易所直接发布。图片接口返回 PNG 200。桌面与手机验证了编辑即时预览、预览和下载字节一致、无横向溢出及无 JavaScript 异常；已通过相关后台、界面、导航、队列与请求来源测试及生产构建。
