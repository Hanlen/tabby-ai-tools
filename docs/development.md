# 开发与验证

[← 返回 README](../README.md) · [使用指南](guide.md)

## 本地开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

CI 使用 Node.js 20，在 Ubuntu、macOS 和 Windows 上运行类型检查、测试和构建。开发时可用 `TABBY_PLUGINS=/path/to/tabby-ai-tools tabby --debug` 加载插件。

### 安装后的重启提示

Tabby 在应用内安装、升级插件后，已由[内置插件管理器](https://github.com/Eugeny/tabby/blob/master/tabby-plugin-manager/src/components/pluginsSettingsTab.component.ts)调用 `ConfigService.requestRestart()`。设置页据此显示“Restart the app to apply changes”，点击时通过 `HostAppService.relaunch()` 重启。首次安装时插件尚未加载，提示由宿主负责；本插件启动成功后不需要再次请求重启。`install:tabby` 是独立的文件复制脚本，无法直接调用 Tabby 进程内的注入服务，仍需用户手动重启。

## 界面翻译

语言文件位于 `src/locales/`，支持的语言和区域代码映射在 `src/i18n.ts`，`AgentI18nService` 负责跟随 Tabby 的 `LocaleService` 或读取插件的独立语言设置。英语是回退语言；所有语言文件直接打包，运行时不访问翻译服务。默认 README 使用英语，中文保留在 `README.zh-CN.md`，两份都随 npm 包和本地安装分发。

添加界面文案时，用 `t(source, [parameters])` 包住完整句子，在全部 12 个 JSON 文件中加入相同的键并翻译值。现有文案以原始中文为键；占位符使用 `{0}`、`{1}`，允许调整顺序，但不能新增或删除。连接名、任务内容和其他用户提供的文本只作为参数，不要单独送入 `t()`。不要翻译用户消息、模型回复或终端输出。保留 `AI Tools`、`Tabby`、`Codex` 等产品名以及命令和配置键。

既有运行状态和日志继续保留原始字符串，在展示边界翻译，以维持完成状态判断和历史兼容。已知组合状态中只有明确标记为插件标签的参数会进一步翻译。部分语言文件由机器翻译起稿，需要人工校对。`test/i18n.test.js` 检查语言文件覆盖、占位符和产品名、语言切换、回退、布局方向、订阅清理与 Angular 模板；`test/sidebar-startup.test.js` 覆盖默认自动打开、缺失配置兼容、明确关闭、启动顺序、目录规则和销毁清理。真实 Tabby 桌面显示仍需人工验证。

## 介绍页效果图

`docs/assets/overview.svg` 是功能界面示意的可编辑源文件，`overview.png` 是中英文 README 使用的导出图。功能变化时一起更新，图中版本号须与发布版本一致，示例任务、连接与输出应明确标注；示意图不能代替真实 Tabby 桌面验证。Linux 上可用 `gdk-pixbuf-thumbnailer -s 1800 docs/assets/overview.svg docs/assets/overview.png` 导出，也可使用支持 SVG 的图形工具，导出后检查字体、布局和图片引用。

标题下的 `robot-multitask.gif` 为 1024 × 512、12 帧的装饰动画，在 README 中按 560 × 280 显示；同尺寸的 `robot-multitask.png` 用于减少动态效果时的静态回退，高清生成提示词和编码参数保存在同目录的 `robot-multitask.prompt.md`。两类图片用途不同，更新功能效果图时保留标题动画。

## 测试范围与平台说明

运行 `npm test`、`npm run typecheck` 和 `npm run build`。自动测试覆盖显式路径和命令名兼容、PATH 优先级、PATH 无 codex、大小写环境变量、哈希目录缺文件、按文件时间选择、升级后重新扫描、无效显式路径不降级，以及 JSONL 握手、进程重用、流式通知和 stderr。`test/executable.test.js` 在 Linux 上模拟 Windows 定位规则；`test/windows-launch.test.js` 仅在真实 Windows 上执行含空格 exe/cmd/bat 和无 PATH 自动定位管道测试，其他平台明确跳过。exe 夹具使用真正的 Node PE 可执行文件配合测试用 preload；它验证启动方式，不代替真实 Codex 测试。

`test/posix-discovery.test.js` 覆盖 Linux/macOS 定位规则、NVM_DIR、自定义命令及显式路径约定、Shell 启动输出隔离、输出上限、超时及失败后的扫描、查找与启动的 PATH 一致、关闭及切换配置时取消发现；并实际启动 `#!/usr/bin/env node` JSONL 夹具验证桌面 PATH 同时缺少 Codex 和 Node 的情况。新增回归覆盖 Codex 已在 PATH 而 Node 缺失、显式路径不切换安装、Shell 配置传递及父环境优先，以及 macOS ChatGPT.app 内置可执行文件发现、PATH 优先级和无执行权限时的拒绝。`test/installations.test.js` 逐项覆盖 standalone 内部入口、新旧 macOS 桌面包、动态 Homebrew/npm prefix、Windows npm 目录、IDE OS/架构和版本筛选，以及无效输出、超时和取消。`test/windows-launch.test.js` 增加真实 npm.cmd prefix 查询并启动 codex.cmd 的回归；全量测试中的进程初始化检查等待实际进程出现，不依赖固定微任务数量。`test/process-lifecycle.test.js` 覆盖强制回收、等待旧服务退出、子进程清理和回收失败时阻止重启；Windows 专用测试验证空 PATH 下 cmd 启动器与常驻 Node 子进程的回收。CI 在 Ubuntu、macOS、Windows 上执行测试、类型检查和构建；本机 Linux 的规则模拟不代表 macOS/Windows 实测。

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

`test/api-agent.test.js` 使用本地 HTTP/SSE 夹具测试真实请求格式、按连接显示的测试进度、鉴权错误、取消、非 SSE 响应，以及在服务端延迟结束请求时首个正文片段已经触发视图刷新。还覆盖 API/Codex 往返迁移、分页历史导出、首次原生消息前的重启恢复和目标延迟激活。真实供应商连通性与 Tabby 桌面 UI 需单独验证。

模型列表测试覆盖四种供应商的 GET 鉴权、分页去重、错误脱敏、不跟随重定向、无模型配置时获取列表、刷新与配置变更失效，以及关闭连接时取消请求。实现遵循 [DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)与 [Claude 模型列表及分页](https://platform.claude.com/docs/en/api/models/list)的接口；不提供模型列表的端点保留手动输入模型 ID。

可运行 `npm run smoke:context`（或 `npm run smoke:context -- /path/to/codex`）验证本机真实 Codex 的上下文导入、恢复、历史导出及目标保留。该脚本不发送 `turn/start`，并检查导入不会自动启动回合；测试线程在退出时归档，不调用模型或执行工具。

用户已在 Windows Node v24.13.0 验证无 PATH 的真实 Codex 自动发现、初始化、6 条流式增量、completed 和 marker，以及 cmd/bat 两项测试。显式枚举全部测试的旧结果为 89 通过、2 项夹具失败、1 项 POSIX 跳过；修正后的 exe / auto discovery 夹具和 npm test 入口待 Windows 重跑。本次验证的具体平台、命令和结果见 [VALIDATION.md](../VALIDATION.md)。

实现依据：[Tabby 插件开发说明](https://github.com/Eugeny/tabby/blob/master/HACKING.md)、[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)及 [Codex Goal 官方说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)。

## Tabby 能力 skill 与每周同步

[`skills/tabby/SKILL.md`](../skills/tabby/SKILL.md) 是插件唯一的模型功能入口，[操作路由](../skills/tabby/references/operations.md)保留终端、本机／内网服务器协作、sudo、任务编排、流程偏好、全部定时任务工具以及面板／设置功能，区分直接工具、Tabby 命令提供者和用户界面入口。新增功能时同步维护该路由，避免 README 精简后模型丢失功能发现入口。

`npm run build` 的 `prebuild` 自动将 skill、操作路由与官方快照合入 `src/tabby-knowledge.json`，再编译到 `dist/index.js`；`npm pack` 的 `prepack` 同样会执行构建。npm 的 `files` 清单和 `install:tabby` 均携带 `skills/` 与 `docs/`。因此用户安装插件就带有 skill，无需额外下载或安装到全局 Codex 目录；内嵌知识离线可读，模型请求仍需连接服务。Codex 新线程和恢复线程注入相同知识，API 模式每次请求注入；旧版 Codex 工具线程在有本地上下文存储时迁移历史与目标，新建具备当前工具的线程，迁移不会启动推理。

`TabbyCapabilitiesService` 通过公开的 `CommandProvider`、`ToolbarButtonProvider`、`TabContextMenuItemProvider`、`ProfilesService` 与设置提供者发现当前可用功能。未导出的 `CommandService` 不能作为插件依赖。第三方功能只有注册命令、配置档或可访问的标签控件时才能操作。所有修改工具共享只读检查，API 模式继续走已有审批流程。

```bash
npm run skill:update # 联网获取官方固定提交的功能摘要、公开 API 签名和快捷键
npm run skill:bundle # 离线重新生成内嵌知识
npm run skill:check  # 检查内嵌知识与 skill 文件是否一致
```

同步从官方 GitHub API 获取同一提交下的全部文件，并保留来源 URL、SHA-256 和 MIT 许可。任一下载失败时保留已有快照；内容未变时不产生仅时间戳的更新。模型只能按需将上游快照作为参考读取，同步脚本不执行上游代码。

`.github/workflows/update-tabby-knowledge.yml` 在每周一 01:00 UTC（北京时间 09:00）运行，也支持手动触发。验证通过且有变化时创建或更新 `automation/tabby-capabilities` 分支的 PR。需要将工作流合入 GitHub 默认分支，并在仓库 Actions 设置启用工作流创建 Pull Request 的权限；本地修改尚不会触发定时任务。GitHub 调度可能延迟，公共仓库长时间无活动时也可能停用 schedule。PR 合并并发布插件后，用户升级才能得到新的打包资料；新增 API 适配仍需实现与验证。

## Review 与已授权修复

纯 review 请求只审查和报告，不能据此自动改码。用户明确要求 fix、修复确认问题或监督其他终端 Agent 完成修复后，交付应包含实际修改、相关回归和再次审查；范围内仍有确认的 P0/P1/P2 时继续修复，有外部阻碍则说明证据与未完成项。不能以 review 报告或修复计划代替已授权的修复，也不能从审查请求推断提交、推送、发布或权限变更授权。

仓库没有独立的 review/fix 状态机或调度器；此规则放入共用 `skills/tabby/SKILL.md`，通过 bundle 注入 Codex 新建/恢复线程和全部 API 供应商请求。回归验证共用知识的实际传递，以及模拟监督 Agent 在 review-only 和 fix-authorized 两种请求下的工具往返、审批与验证反馈；它不是对真实模型决策的证明。终端与审查修复事故的根因、具体改动及验证边界见 [2026-10-22 修复记录](incidents/2026-10-22-review-fix.md)。

任务流程仅由 `/remember TASK` 开始录制，结束后设置别名，`/task1` 执行。`src/sudo-workflow.ts` 构造终端内非交互预检与保活，`src/tab-tools.ts` 管理其任务生命周期；使用假 sudo 测试预检失败和跨命令保活，不能替代真实桌面／SSH 策略验证。

流程身份和验收采用结构化 `TaskStep.server/dependsOn/verification/verificationCommands`。`read_tab` 仅提取连接字段白名单和会话路径；`workflow_checkpoint` 由面板路由到 `TaskMemory`，使用同终端新观察和串行发送门禁。通用规则在 bundled skill，具体流程和约束由发送时隐藏提示注入。旧库字段可选保持兼容；新录制须有完整身份及逐步验收。不将单纯读取或发送回执作为成功证明，语义验收仍由模型判断。

终端接管由 `send_input` 自动处理，不再生成 `local/terminalTakeover` 请求。检测未知（SSH、无枚举接口、枚举异常）时不因检测能力缺失暂停，不盲发 Ctrl+C；已检测的无关进程需要 `foregroundTaskNeeded=false`，发送 Ctrl+C 并验证停止。保留任务所需进程、会话/所有权检查、取消与只读限制。

## Claude Code 本机引擎（开发版）

方案和官方依据见 [Claude Code 接入](claude-code.md)。`claude-code-profile.ts` 提供独立的内置连接与配置；`claude-code-client.ts` 负责发现、能力／登录检查和有界进程回收；`claude-code-mcp.ts` 提供单次运行的认证 loopback MCP；`claude-code-agent.ts` 将官方 CLI 适配到已有会话与面板端口。`ApiAgent.createAdapter` 是可替换推理入口，MCP 与 API 的工具调用共用验证、审批、执行前持久化和重复循环检查。不得把本机连接交给 HTTP API 或密钥服务。

`test/claude-code.test.js` 与 `test/fixtures/claude-cli.cjs` 使用真实子进程和 HTTP，所有模型输出均为夹具。新增代码不依赖 Agent SDK，也不下载或修改 Claude Code。常规验证不运行真实模型；跨平台桌面和真实订阅仍需要单独验证。
