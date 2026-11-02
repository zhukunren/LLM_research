# 测试临时文件与失败现场

Windows 入口沿用 `scripts/test.ps1`：

```powershell
.\scripts\test.ps1 tests/unit/test_backup_retention.py
.\scripts\test.ps1 -k "backup or restore"
.\scripts\test.ps1 -KeepArtifacts tests/unit/test_backup_retention.py
```

也可使用精确的 `--keep-artifacts`。仅这两个完整开关由脚本消费；pytest 的 `-k`、`-q` 等参数继续原样传递。

## 生命周期

- 每次在配置的状态目录（`LLMR_STATE_ROOT`，默认项目 `runtime`）下新建 `test-runs/<GUID>`，写入本次所有权标记。永不采用已有目录。
- pytest 正常退出且退出码为0、没有保留开关时，仅清理本次确认拥有的GUID目录，不扫描或清理历史运行。
- pytest失败、保留开关、进程启动异常或中断时保留现场；路径在启动时打印。
- 清理遇到权限、文件占用或路径安全检查失败时输出警告并保留现场。清理失败不会把原pytest退出码改成另一个结果；测试通过不等于临时文件一定已删除。
- pytest真实退出码由Python runner返回，并由PowerShell入口传递。TEMP/TMP及测试环境变量仅设于pytest子进程，调用者环境不被修改。

## 安全边界

清理前验证父路径和本次目录身份、GUID、所有权标记、链接与reparse属性。pytest产生的内部 `current` 链接仅在完整目标仍位于本次目录时允许；外部链接、损坏或不可验证链接导致拒绝清理。POSIX删除使用父目录句柄锚定；Windows固定祖先目录句柄以避免替换，并依赖Python3.12的链接/junction处理。

本入口独占pytest `--basetemp`。不允许命令行或 `PYTEST_ADDOPTS` 覆盖（含等号形式与缩写），也不支持pytest `@响应文件`，以免响应文件展开后绕过路径限制。请改用显式pytest参数；保留现场使用上面的保留开关。

这不是任意测试代码的沙箱，也不会阻止用户编写的测试自行读写其他路径；请只运行可信测试。

## 验证范围

云端合成临时目录测试包含真实pytest子进程：成功清理、失败保留、调用者环境不变及外部哨兵不受影响。没有清理用户历史测试目录。

本次环境没有PowerShell/Windows，PowerShell入口、Windows句柄与junction/reparse分支尚未在实机执行；请在Windows已有项目依赖环境补跑。没有增加历史清理、定时任务或VACUUM。
