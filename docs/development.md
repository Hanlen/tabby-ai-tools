# 开发与验证

[← 返回 README](../README.md) · [使用指南](guide.md)

## 本地开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

CI 使用 Node.js 20，在 Ubuntu、macOS 和 Windows 上运行类型检查、测试和构建。开发时可用 `TABBY_PLUGINS=/path/to/tabby-codex-agent tabby --debug` 加载插件。

## 测试范围与平台说明

运行 `npm test`、`npm run typecheck` 和 `npm run build`。自动测试覆盖显式路径和命令名兼容、PATH 优先级、PATH 无 codex、大小写环境变量、哈希目录缺文件、按文件时间选择、升级后重新扫描、无效显式路径不降级，以及 JSONL 握手、进程重用、流式通知和 stderr。`test/executable.test.js` 在 Linux 上模拟 Windows 定位规则；`test/windows-launch.test.js` 仅在真实 Windows 上执行含空格 exe/cmd/bat 和无 PATH 自动定位管道测试，其他平台明确跳过。exe 夹具使用真正的 Node PE 可执行文件配合测试用 preload；它验证启动方式，不代替真实 Codex 测试。

`test/posix-discovery.test.js` 覆盖 Linux/macOS 定位规则、NVM_DIR、自定义命令及显式路径约定、Shell 启动输出隔离、输出上限、超时及失败后的扫描、查找与启动的 PATH 一致、关闭及切换配置时取消发现；并实际启动 `#!/usr/bin/env node` JSONL 夹具验证桌面 PATH 同时缺少 Codex 和 Node 的情况。新增回归覆盖 Codex 已在 PATH 而 Node 缺失、显式路径不切换安装、Shell 配置传递及父环境优先。`test/process-lifecycle.test.js` 覆盖强制回收、等待旧服务退出、子进程清理和回收失败时阻止重启；Windows 专用测试验证空 PATH 下 cmd 启动器与常驻 Node 子进程的回收。CI 在 Ubuntu、macOS、Windows 上执行测试、类型检查和构建；本机 Linux 的规则模拟不代表 macOS/Windows 实测。

Windows 解压验证包后，用已安装 Node.js 20+ 的 PowerShell 运行（需联网安装 npm 依赖）：

```powershell
# 单元测试、类型检查、构建、真实 Codex 初始化；只使用本机已有登录
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1
# 模拟桌面进程 PATH 无 codex，验证桌面安装定位，并发送一次真实模型请求
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1 -WithoutPath -Stream
# 验证指定 exe / 临时 cmd / bat；将路径替换为本机实际文件
powershell -ExecutionPolicy Bypass -File .\scripts\validate-windows.ps1 -Executable 'C:\Path With Spaces\codex.cmd' -Stream
```

烟测使用插件实际 `CodexClient`，`-WithoutPath` 只清空烟测进程及其子进程 PATH，保留 LOCALAPPDATA；未传 `-Executable` 时走自动定位。`-Stream` 使用本机现有 Codex 登录，发送一条要求回复测试标记且禁止使用工具的真实模型请求，可能消耗额度；可用 `-Model` 指定账户可用的模型。脚本在临时目录创建 ephemeral / read-only 线程，要求收到 `item/agentMessage/delta` 和成功的 `turn/completed`；未启用流式烟测会明确显示 SKIP，不把初始化当成模型应答。跨平台也可运行 `node scripts/smoke-codex.cjs --stream`，支持 `--executable`、`--without-path`、`--model`。Linux 上运行成功只能证明 Linux 结果；Windows 桌面 Tabby UI 仍待验证，Windows CLI 实测证据见下文。

`npm test` 通过 `scripts/run-tests.cjs` 显式枚举项目 `test/*.test.js`，以参数数组执行 `node --test`，避免不同 Node 版本对目录入口的解析差异，不扫描 node_modules。Windows 测试夹具的 NODE_OPTIONS preload 路径统一转换为正斜杠，避免反斜杠被解释为转义。

用户已在 Windows Node v24.13.0 验证无 PATH 的真实 Codex 自动发现、初始化、6 条流式增量、completed 和 marker，以及 cmd/bat 两项测试。显式枚举全部测试的旧结果为 89 通过、2 项夹具失败、1 项 POSIX 跳过；修正后的 exe / auto discovery 夹具和 npm test 入口待 Windows 重跑。本次验证的具体平台、命令和结果见 [VALIDATION.md](../VALIDATION.md)。

实现依据：[Tabby 插件开发说明](https://github.com/Eugeny/tabby/blob/master/HACKING.md)、[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)及 [Codex Goal 官方说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)。
