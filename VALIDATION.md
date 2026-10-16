# Windows Codex 定位与启动验证包

日期：2026-10-15。源码直接修复；未提交 Git，未修改本机 Codex/Tabby 安装配置，保留工作区原有未跟踪文件及 artifacts。

## 本次改动文件

- `src/codex-executable.ts`：显式路径验证；空值/默认 codex 自动定位；命令名 PATH/PATHEXT 兼容；Windows LOCALAPPDATA 哈希目录筛选；按 codex.exe mtime 排序；具体查找错误和设置入口；环境清理。
- `src/codex-client.ts`：使用定位后的绝对路径；原生程序直接 spawn，参数数组、shell:false；Windows cmd/bat 使用 cross-spawn 转义；子进程去除继承 originator override；保留插件 clientInfo 和三路管道。
- `src/codex-runtime.service.ts`、`src/settings.pug`：更新启动失败入口及设置提示。
- `test/executable.test.js`、`test/windows-launch.test.js`、`test/client.test.js`：补充定位、哈希目录升级、无效显式配置、环境与身份、Windows 原生 exe/cmd/bat 的初始化和流式管道测试。
- `scripts/smoke-codex.cjs`、`scripts/validate-windows.ps1`：使用真实插件传输的跨平台烟测与 Windows 一键验证。
- `package.json`：增加 smoke:codex 命令；测试入口使用 node scripts/run-tests.cjs。
- `scripts/run-tests.cjs`：显式枚举项目 test/*.test.js，用参数数组执行 node --test，不扫描 node_modules。
- `README.md`、`VALIDATION.md`：定位规则、失败处理和复现步骤。
- `dist/index.js`：npm run build 生成的生产构建。

## 已执行结果（本机 Linux，Node 20.20.2，Codex CLI 0.162.1）

- `npm test`：92 项，88 通过，0 失败，4 项 Windows 专用测试跳过。
- `npm run typecheck`：通过。
- `npm run build`：通过（webpack 5.111.1）。
- `node --check scripts/smoke-codex.cjs`：通过。
- `node scripts/smoke-codex.cjs --stream`：真实 `/usr/bin/codex` 初始化成功；在临时目录启动 ephemeral/read-only 线程，收到 6 条 `item/agentMessage/delta`、成功的 `turn/completed` 和测试标记。烟测传入两种大小写的父 originator override，插件在子环境中删除，线程元数据的 originator 如存在须为 tabby_codex_agent。

Linux 上的 Windows 定位测试使用临时文件系统与注入的 Windows 规则，不代表 Windows 实测。Windows 原生测试在 Linux 明确 SKIP。文件 mtime 用于选择文件新旧，不保证软件版本；时间相同按完整路径稳定排序。

## 用户提供的 Windows 实测证据（Node v24.13.0）

以下结果由用户在本机 Windows 执行后反馈，并非本次 Linux 会话代跑：

- `node scripts/smoke-codex.cjs --without-path --stream`：通过。真实 Codex 自动发现 `9614f1d9b40d9c4f/codex.exe`，初始化成功，收到 6 条 delta、completed 和测试 marker。
- 显式枚举全部测试：92 项，89 通过、2 失败、1 项 POSIX 跳过。cmd/bat 两项 Windows 管道测试通过。
- exe 与 auto discovery 两项旧夹具失败：NODE_OPTIONS 的 --require 引号内含 Windows 反斜杠，解析时被当成转义，导致 Cannot find module。两处路径现已使用 split(path.sep).join('/') 转为正斜杠，待 Windows 重跑，尚未记录为修复后通过。
- 旧 npm test 的 node --test test 在 Node 24 报 Cannot find module .../test。现改用 scripts/run-tests.cjs 显式枚举文件后执行 node --test，待 Windows Node 24 重跑。
- 本次修正后 Linux Node 20.20.2 的 npm test：92 项，88 通过、0 失败、4 项 Windows 专用测试跳过。

## Windows 执行

解压到任意目录（可含空格），安装 Node.js 20+，确保本机 Codex 已登录。PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1 -WithoutPath -Stream
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1 -Executable 'C:\Path With Spaces\codex.exe' -Stream
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1 -Executable 'C:\Path With Spaces\codex.cmd' -Stream
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1 -Executable 'C:\Path With Spaces\codex.bat' -Stream
```

请替换后三条中的路径为真实存在的文件。脚本执行 npm ci、npm test、npm run typecheck、npm run build，然后真实初始化。`-WithoutPath` 仅清空烟测进程及其子进程 PATH，保留 LOCALAPPDATA，验证桌面安装的自动定位。`-Stream` 会发送一次真实模型请求并可能消耗额度；可加 `-Model` 指定可用模型。无 -Stream 会明确显示流式验证 SKIP。

如只需重复烟测：

```powershell
node scripts/smoke-codex.cjs --without-path --stream
node scripts/smoke-codex.cjs --executable 'C:\Path With Spaces\codex.cmd' --stream
```

## 尚未验证

- 修正后的 exe / auto discovery 夹具及 npm test 入口在 Windows Node v24.13.0 的重跑。真实 Codex 自动发现、模型流式响应及 cmd/bat 测试已有用户实测通过反馈。
- Windows PowerShell 验证脚本的实际执行。
- 从 Windows 桌面启动的 Tabby UI、CLI 更新后插件重连。

## 包内容与下载服务

压缩包按文件白名单制作：源码、测试、脚本、构建输出、项目构建清单、README/本报告、许可证和 CI 定义；不含 node_modules、.git、artifacts、旧 tgz、用户配置、.codex、.aws、.env、.npmrc 或凭据。src/config.ts 为插件公开默认设置定义，不是用户凭据配置。

HTTP 服务工作目录只含 tabby-codex-windows-validation.tar.gz，日志和 PID 放在目录外。
