# 开发与验证

[← 返回 README](../README.md) · [使用指南](guide.md)

粘贴、图片预览与附件传输回归直接运行 `npm run test:attachments`，无需切换 Node。`npm test` 自动包含这些用例；真正启动 Pi 的测试会检查当前 Node，低于 22.19 时显示明确的跳过原因。API 压缩测试使用独立的 API 夹具，不启动 Pi，也不因 Pi 的版本要求跳过。完整 Pi 集成验证仍由 Node 22.19+ 的开发环境／CI 执行；脚本不下载或切换运行时。

后续供应商设置页改版尚未实现；规划和研究资料仅保留在本地，不随插件分发。功能与发布状态以实际代码和发布说明为准。

v0.4.1 已优先加入 `provider: custom`：可选 `apiFormat: chat-completions | responses`，缺省为 Chat Completions。`apiPath` / `usesResponsesApi` 统一推理路径与工具结果格式；模型发现仍用 `/models`。`keySource: none` 仅限自定义连接，密钥服务返回空值且请求省略认证头。自定义协议加入历史指纹，既有供应商指纹不变；切换协议通过已有通用上下文导入路径处理。设置中变更协议、端点或密钥会取消并清除旧连接测试和模型列表，旧异步结果不能覆盖新状态。自定义接口不推断厂商 Thinking 参数，不硬编码模型能力。

`test/api-agent.test.js` 覆盖自定义 Chat Completions 的现有 Agent 回归、Responses 连续工具往返与恢复、协议切换、无密钥模型发现与流式回复、配置失效及原供应商指纹兼容。全部使用本地 HTTP/SSE 夹具；真实第三方服务和桌面端需另行验证。协议参考：[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses 迁移与原生历史](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

## 本地开发

### Markdown 输出

`markdown.ts` 使用固定版本的 `markdown-it` 解析正文，禁用原始 HTML。表格的列对齐转为 CSS class，以保留 Angular 15 清理后的排版；图片转为文字链接，外部 URL 只允许 HTTP、HTTPS 和 mailto。原文留在 `ChatEntry.text`，不把渲染 HTML 写入历史或模型上下文。

`MarkdownComponent` 以动画帧合并文本变化，按顶层块绑定经过 Angular 清理的 HTML；未变化的块保留 DOM，更新时恢复表格／代码横向位置。HTML 后代不会获得 Angular 的模拟样式属性，因此样式使用 `ViewEncapsulation.None`，每条规则均限定在 `.codex-markdown` 内。复制按钮是清理后由 `Renderer2` 创建的固定控件，不编译模型 HTML、不绕过清理；嵌套代码同样可复制。复制和链接打开复用 Tabby `PlatformService`，组件卸载时取消帧、反馈计时器和语言监听。

语法高亮使用固定版本 `highlight.js/lib/common` 加 PowerShell／Dockerfile 语法，只对显式语言及别名着色；不自动猜测语言。HTML 中仅增加 token span/class，仍经过 Angular 清理。单块超过 20,000 字符或语法不可用时退回安全转义，最多缓存 32 个代码结果以避免流式追加时反复着色完整块。代码区使用固定深色背景和限定在 `.codex-markdown pre` 的配色，避免宿主深浅主题或全局高亮样式影响可读性。

Markdown 解析器与高亮器随 webpack 主包打包，仅为构建依赖，不给终端用户增加 Node.js 或安装脚本要求；升级解析器或相关依赖时同步 [第三方声明](markdown-third-party-notices.md)。使用 `node --test test/markdown.test.js test/chat-scroll.test.js test/i18n.test.js` 验证解析、流式片段、安全边界、复制、销毁与语言切换。浏览器检查应覆盖 Angular 实际清理和样式、320／480／800 px、深浅主题、嵌套代码复制、宽表格／代码滚动、历史恢复和暂停／恢复自动跟随。真实桌面和跨平台结果需另行记录。

### 对话与终端输出

对话过程展示由 `chat-activity.ts` 统一转换实时条目与历史条目。思考摘要／文本增量与工具开始、完成事件更新同一记录；原生 `details/summary` 默认折叠，正文按需挂载，`trackBy` 保留展开状态。API、Claude Code 和 Pi 仅转发服务提供的可展示文本，不渲染加密载荷；展示记录与模型原生历史分开保存。默认终端快照可由规范化的新输出或 OSC 133 的 C→D→A 完成序列提前唤醒，保留约 50 ms 渲染／合并时间、持续输出约 200 ms 合并上限和原 waitMs 上限。控制状态保存 observedCursor，在输入前重置、同 owner 成功快照后推进（屏幕读取前的高水位），因此读屏前已到达的输出不必继续空等，其他 owner 不消费该游标。只订阅过滤后的 output.updates$，遵循附件遮蔽；取消、会话更换／关闭清理等待订阅。快照返回 wakeReason/waitedMs；目录和进程元数据并行读取，读取后仍复核 session。输出唤醒只触发观察；多行中间提示符不释放批次锁，新命令、会话更换或结束会清除旧完成记录。

2026-11-01 本地 Linux 验证：Node 22.19.0 下完整测试 771 项通过、6 项平台相关跳过；类型检查和生产构建通过。新增夹具覆盖完成前／完成后读屏提前返回、伪提示符与多行批次不提前返回、取消订阅清理、工具结果未到时的过程显示、思考展示上限和历史恢复。当前默认 Node 20 会导致两项 Pi 夹具在运行时版本检查处失败，完整验证使用临时 Node 22.19.0。未调用收费模型，也未验证真实 Tabby 桌面或本次提交的跨平台 CI。

```bash
npm ci
npm run typecheck
npm test
npm run build
```

CI 使用 Node.js 22.19.0，在 Ubuntu、macOS 和 Windows 上运行类型检查、测试和构建。开发时可用 `TABBY_PLUGINS=/path/to/tabby-ai-tools tabby --debug` 加载插件。

### 普通终端工具与流程回归

启用流程库但没有活动录制／别名执行时，当前令牌和工具捕获的令牌都可能为 `undefined`。读取流程运行状态前必须要求令牌存在且与当前令牌一致；普通任务仍经过终端适配器的只读、所有权和进程核验。`test/task-memory-panel.test.js` 覆盖 Codex／API 下流程关闭／idle 时的命令、stdin、按键与进程接管，以及活动流程的辅助 token 预算和取消后失效令牌隔离。

Pi 连续压缩回归包含十轮独立 sidecar 启动，统一使用 90 秒时限。Windows Node 22.19.0 的外部实测在约 33.4 秒完成全部断言，超过原来的 30 秒；此调整保留原始历史、两次压缩、摘要成本及恢复断言，不改变产品压缩实现。此处耗时证据不代表本机已完成 Windows 复测。

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

`test/sidebar-keyboard.test.js` 覆盖侧栏键盘事件隔离、原生默认行为保留、选中文字时的焦点转移和销毁清理。`test/api-agent.test.js` 覆盖空／加密推理记录过滤、真实摘要流式显示与恢复历史；`test/thread-tools.test.js` 核对 Codex 请求开启摘要。浏览器夹具与本地 HTTP 服务用于回归，不消耗真实模型额度；完整 Tabby 桌面中的终端及剪贴板行为仍需实际验证。

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

模型列表测试覆盖 OpenAI、DeepSeek、GLM、Kimi API、Kimi Coding Plan、百炼 Coding Plan 与 Claude的 GET 鉴权、分页去重、错误脱敏、不跟随重定向、无模型配置时获取列表、刷新与配置变更失效，以及关闭连接时取消请求。实现遵循 [DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)与 [Claude 模型列表及分页](https://platform.claude.com/docs/en/api/models/list)的接口；不提供模型列表的端点保留手动输入模型 ID。

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

流程身份和验收采用结构化 `TaskStep.server/dependsOn/verification/verificationCommands`。`read_tab` 仅提取连接字段白名单和会话路径；`workflow_checkpoint` 由面板路由到 `TaskMemory`，使用同终端新观察和串行发送门禁。通用规则在 bundled skill，具体流程和约束由发送时隐藏提示注入。旧库字段可选保持兼容；新录制须有完整身份及逐步验收。不将单纯读取或发送回执作为成功证明，语义验收仍由模型判断。`workflow_status` 与 `workflow_set_alias` 同样由面板路由：前者区分录制、别名执行、归档中、拒绝归档和写盘失败，后者仅操作本会话／目录最近完成的显式录制，禁止只读模式修改。checkpoint 返回录制模式和归档资格；写盘失败保留已验收记录供别名工具重试，不重放终端命令。发送后续目标前等待完成中的归档，避免清理录制进度。最近录制及失败重试缓冲仅在当前进程保留，重启后已落盘流程仍通过设置管理。

终端接管由 `send_input` 自动处理，不再生成 `local/terminalTakeover` 请求。检测未知（SSH、无枚举接口、枚举异常）时不因检测能力缺失暂停，不盲发 Ctrl+C；已检测的无关进程需要 `foregroundTaskNeeded=false`，发送 Ctrl+C 并验证停止。保留任务所需进程、会话/所有权检查、取消与只读限制。

## Claude Code 本机引擎（开发版）

方案和官方依据见 [Claude Code 接入](claude-code.md)。`claude-code-profile.ts` 提供独立的内置连接与配置；`claude-code-client.ts` 负责发现、能力／登录检查和有界进程回收；`claude-code-mcp.ts` 提供单次运行的认证 loopback MCP；`claude-code-agent.ts` 将官方 CLI 适配到已有会话与面板端口。`ApiAgent.createAdapter` 是可替换推理入口，MCP 与 API 的工具调用共用验证、审批、执行前持久化和重复循环检查。不得把本机连接交给 HTTP API 或密钥服务。

`test/claude-code.test.js` 与 `test/fixtures/claude-cli.cjs` 使用真实子进程和 HTTP，所有模型输出均为夹具。新增代码不依赖 Agent SDK，也不下载或修改 Claude Code。常规验证不运行真实模型；跨平台桌面和真实订阅仍需要单独验证。

## 默认持续执行与统一 reasoning 选择

API / Claude Code 的 active Goal 在普通文本响应结束后由 `ApiAgent` 自动续行，保持同一个 turn、原生工具和推理历史、预算累计以及停止句柄。测试覆盖超过历史 20 轮、普通响应后的继续、完成/阻塞/显式暂停、文字空转检测与预算/中断。历史默认 20 迁移为 0；主动设置的限制带 `toolRoundLimitConfigured` 标记。

`model-reasoning.ts` 为缺少服务端能力元数据的已知模型提供保守等级，模型浮窗对 API / Claude Code 统一提供第二步、默认值与手动输入。离线 HTTP / CLI 测试覆盖选中后保存、下一次推理请求中的供应商原生参数、默认值清除及保存失败回滚。不以真实模型调用作为常规验证。

Kimi／百炼 Coding Plan 的实现与验证边界见 [配置说明](coding-plans.md)。本地夹具还验证区域端点预设、保留自定义代理和密钥草稿、切换区域取消旧模型发现、两套 Kimi Key 配置、持久缓存标识、仅思考模型参数和百炼 `enable_thinking`。没有运行收费模型或证明真实套餐准入；区域的可用模型与额度须以各平台控制台为准。

## 终端回显与重试回归

面板不订阅 `terminalOutput.updates$`，移除了 700ms / 2,000 字符批次经 `turn/steer` 注入的路径。终端服务仍使用有界缓冲供 `read_tab` 和用户发送／继续时的一次摘要读取；重试等待只用每秒刷新的本地 UI 时钟展示已等待时长与可用的倒计时，不创建模型请求或新的后台重试循环；恢复、断线、换会话、取消和销毁面板时清理 UI 时钟。

`turn-retry.ts` 识别字符串错误类别与结构化 `httpStatusCode: 429`。本地 Codex app-server 生成的 `ErrorNotification` 仅包含 `error / willRetry / threadId / turnId`；`TurnError` 的 `message / additionalDetails` 可以包含重试时长，但没有独立截止时间字段。只解析明确的 `retry in/after N seconds/ms/minutes` 文本；缺失时显示未知。后台日志中未发给客户端的信息不会被推测或轮询数据库补齐。

`test/turn-retry.test.js` 使用真实终端缓冲和模拟后台事件，覆盖一万段高频回显、等待期合并、重试时间缺失与显式时长、重复错误合并、旧回合事件、停止失败／成功、断线与恢复、UI 时钟自动刷新与清理。`test/task-memory-panel.test.js` 覆盖第二步已发送后限流、中断、恢复读取验收并继续，不重复发送 stash 或解压。全部为本地夹具；未访问用户 Windows 现场日志、未恢复原任务，也没有真实模型压力测试或 Tabby 桌面端到端验证。

## Optional Pi sidecar and context projections

Use Node 22.19+ (`.nvmrc` and both CI workflows pin 22.19.0). Angular 15/webpack retain TypeScript 4.9; `typescript-pi` aliases the pinned 5.9.3 compiler for `runtime/pi/tsconfig.json` in NodeNext mode. `npm run typecheck` checks both boundaries, `npm test` first builds the sidecar, and `npm run build` emits `dist/index.js` plus `dist/pi/sidecar.mjs`. Since 0.5.1, both pinned Pi SDKs are build-only devDependencies. `scripts/build-pi.mjs` uses pinned esbuild to bundle their JavaScript into the ESM sidecar, rejects external package imports, disables optional native WebSocket accelerators and emits third-party license/notice text. Keep the SDK outside the Angular bundle. Pi defaults to Electron `utilityProcess` using the host Node; a Node 22.19+ executable is only an explicit compatibility override.

`npm run test:package` packs the built files and installs the actual tarball with no `node` on PATH and lifecycle scripts explicitly enabled. It uses an independent empty cache and the public registry, avoiding assumptions about metadata cached by `npm ci`. A control package whose postinstall calls `node` must fail in the same environment, and the entire installed production dependency closure is checked for lifecycle hooks and leaked Pi/Google/protobuf packages. An optional tarball argument checks the saved release artifact directly. This check runs after the build in Linux/macOS/Windows CI. The isolated-sidecar regression copies only the bundle outside the repository and completes a real local HTTP/host-tool exchange without installed SDK packages. `install:tabby` copies built files without invoking npm and excludes local roadmap/research files. These checks do not replace a Windows Tabby desktop upgrade test.

`PiBackend` reuses the host's API thread/UI/tool-policy port, while `PiAdapter` delegates the complete native loop to the SDK. The pipe acknowledges persisted session setup and accepted input before inference. Host action intents/results are stored before/after execution; repeated IDs use the saved result or return unknown-state evidence. Process exit aborts pending host tool waits. No process auto-restart or whole-prompt retry is allowed. `agent/lifecycle` carries structured retry, compaction and settled events; the panel clock only displays the supplied delay.

`api-context.ts` owns immutable API request projections. Summaries record source hashes/ranges and retain whole batches from a user-turn boundary; private reasoning is not passed to the summarizer. Pi session JSONL is the authority for Pi model context, with the Tabby store used for UI, goals, journals and portable migrations. The existing structured workflow state and checkpoint enforcement stay in the host.

`test/pi-agent.test.js` uses actual local HTTP streaming fixtures, without credentials or real model calls. Validate persistence, retry-after-tool, cancellation, budget/quota, repeated compaction and raw entry retention. The isolated Linux desktop fixture additionally loaded the plugin in official Tabby 1.0.238 (Electron 43.7.0 / Node 24.21.0), rendered runtime settings and exercised the sidebar → Node 22.19 Pi → host list_tabs → verified Goal flow. It used Xvfb and no real model. Windows/macOS, SSH/PTY mutations and real-provider execution still require their actual environments. See [runtime details](pi.md) and the [unreleased change note](releases/pi-runtime.md).

### Built-in Pi runtime lifecycle

`dist/pi/electron-host.cjs` runs in Electron main through Tabby’s existing remote bridge and Node `createRequire`. This avoids relying on the bundled app’s `process.mainModule.require`. It forks the fixed packaged sidecar with Electron `utilityProcess`, bounds the JSON/diagnostic channels, strips loader injection variables and owns termination on renderer/window destruction. SDK traffic uses `process.parentPort`; final done/fatal IPC is acknowledged before shutdown so the utility cannot remain alive after a completed turn. Explicit compatibility paths retain the existing Node subprocess transport. Empty paths do not search PATH for node. The selected runtime must provide Node 22.19+; older hosts should update Tabby first.

Tests cover default host selection without node on PATH, main-process bridge selection, output acknowledgment, cancellation waiting for exit and owner/crash cleanup. Actual isolated Linux Tabby 1.0.238 / Electron 43.7.0 / Node 24.21.0 exercised SDK streaming, a host-tool round trip, cancellation while waiting for a tool result and owner-window termination without system Node on PATH. It uses only local HTTP fixtures. Windows/macOS utility-process desktop behavior remains a separate validation scope.

## Trusted npm publishing

Stable GitHub Releases trigger `.github/workflows/publish.yml`. After exact-commit branch/tag CI verification, the workflow publishes the reviewed release attachment through GitHub OIDC, without a stored npm token or rebuilding the tarball. npm performs a one-time trusted publisher binding to `Hanlen/tabby-ai-tools` and `publish.yml`; direct publishing must be allowed. Create Releases as drafts, attach the verified tarball and checksum, then publish. The workflow waits for registry processing and verifies downloaded bytes. See [release setup and recovery](../.github/RELEASING.md).

## Conditional workflow runtime

`terminal-limits.ts` shares the 10,000-character input cap across terminal transport, tool schema, recording, verification policies and uncertain-action receipts. Accepted commands retain their complete text, including multiline scripts; redaction must not silently change executable content. `policy.decision` marks a required main-model judgment before an operation: the runner returns `needs_model` before sending, the main model submits the current logical step, and the runner resumes its verification and successors. Missing machine checks also count as model-assisted automation. Fixed steps should record independent positive checks instead of requiring AI verification on every run.

`workflow-policy.ts` defines bounded declarative predicates and response policies; `task-memory.ts` records intents and maintains ordered identity/result gates. `workflow-runner.ts` interprets conditional steps and independent verification, and `workflow-session.ts` binds calls to the current connection, Goal budget and cancellation. `workflow-decision.ts` uses isolated tool-free decision sessions; the backend factory applies model overrides to Codex, Claude Code, API and Pi without mutating the foreground profile. Temporary auxiliary transcripts are removed after disposal. v2 libraries retain v1 compatibility; separate minimal run journals omit raw observations, replies and live tab IDs. Offline fixtures in `test/workflow.test.js` cover rule execution, helper fallback, stale decisions, duplicate input, unknown results, restart/rebind and budget attribution. General TUI interpretation and missing shell completion still require the main model.

Windows 默认 CLI 选择：`node --test test/codex-version.test.js test/executable.test.js test/windows-launch.test.js test/installations.test.js` 验证语义版本比较、多个 PATH 入口、桌面升级目录清理、固定路径、超时与取消。Linux 上的 win32 文件系统模拟不替代真实 Windows 启动测试。

## Pi provider configuration (v0.8.0 P0/P1)

Keep both SDK packages pinned to 1.4.0. `runtime/pi/resolver.mts` is the connection/model/auth resolver used by the sidecar and local no-inference check; it creates an in-memory credential store, disables user models and network refresh, and rejects deferred providers. `npm run pi:catalog` (Node 22.19+) generates the safe offline `src/pi-catalog.json` DTO through that resolver; `npm run pi:catalog:check` verifies reproducibility. Angular never imports the SDK. `pi:build` includes the resolver inside the sidecar (its separate internal test bundle in `artifacts/` is not shipped), while native request paths skip legacy provider payload patches.

Use the P0/P1 fixtures in `test/pi-agent.test.js` for native Gemini/OpenRouter, endpoint metadata preservation, independent credentials, all four custom streaming protocols and host-tool round trips. Gemini SSE fixtures must use `data:` events; the pinned Google client ignores blocks beginning with `event:`. `test/pi-settings.test.js` covers draft isolation, cancellation, save failure, copying, capabilities and legacy fingerprints. These use local HTTP only, never real model credentials. Test the extracted reviewed tarball too, then `npm run test:package -- /absolute/path/package.tgz` for scripts-enabled installation without Node on PATH. Bedrock's variable dynamic import remains unavailable: statically bundling it exposes additional optional `kerberos` dependency requirements; the existing external-import check alone is not evidence of support.

P2/P3 remain pending. Custom instructions and private CLI storage are implemented separately below; local Linux fixtures, Linux Electron utility-process evidence, remote three-platform CI and real provider/account tests must be reported separately. Release validation and publishing follow the repository release workflow.

Windows 桌面 Codex 路径回归：`node --test test/executable.test.js test/windows-launch.test.js test/installations.test.js`。覆盖稳定 bin 目录、升级目录清理、旧 PATH 安装优先级、显式路径固定及禁止跨安装降级。Linux 的 win32 文件系统模拟不代表真实 Windows 启动；后者仅在 Windows 运行。

Windows 默认启动还通过 `test/codex-version.test.js` 验证 PATH 旧版与桌面新版共存、文件时间与真实版本相反、多个 PATH 入口、预发布语义比较、超时/异常输出及取消清理。同步文件定位器保留原优先级，实际异步启动器收集候选并查询版本。`--version` 不启动模型；明确文件路径固定版本。

## Custom instructions and CLI session storage

`agent-instructions.ts` validates the explicit text/file source, bounds UTF-8 reads at 32 KiB and produces a hashed immutable snapshot. `ApiSession.instructions` and the Codex private index persist it; missing metadata on old sessions represents an empty custom layer. Instruction changes never participate in provider compatibility fingerprints. Do not enable Pi's resource discovery to load a user-selected file. Settings provide explicit drafts and source/content preview; ordinary logs and configuration exports must not include saved session snapshots.

`session-space.ts` resolves stable Codex/Claude connection identities beneath the Tabby data root, prepares a manifest and constructs child-only environments. Executable discovery uses the original environment; private storage is applied afterward. Codex overrides both SQLite configuration/environment and log/auth storage; its client cache includes the space. Claude passes the same environment to auth inspection and inference. Native references and host indexes use the selected space, with separate legacy dictionaries for system mode. Session locks reject simultaneous writers and can recover after a recorded owner process exits. Private Codex clients are panel-owned; the legacy background runtime does not start an unused server in the system home for private connections.

Tests use offline process/MCP fixtures and temporary homes. The system Codex CLI can also be checked with `account/read`, `thread/start` and `thread/read` without `turn/start`; do not introduce paid model calls into routine verification. Validate actual desktop config persistence because Tabby's dynamic dictionaries require nonstructural defaults. Platform credential stores can differ; CLI history isolation does not establish independent account or OS sandbox boundaries. See [user instructions](instructions-sessions.md) and VALIDATION.md for current evidence.

## SSH attachment transfers (0.8.0)

AttachmentStore owns immutable private snapshots; AttachmentTransferService owns bounded operations, idempotency and UI events. Model tools return receipts rather than base64. attachment-transport.ts streams SFTP and independent exec, with SHA-256 verification before publication; attachment-pty.ts provides the guarded POSIX fallback. Native tab progress uses the actual percentage rendering of TabHeader (0–100), despite the host type comment claiming 0–1. Other progress producers take precedence. Do not infer an Agent attached an image from an upload receipt.

The composer accepts clipboard files and drag-and-drop directly, displays inline thumbnails and removal, and has no attachment button or transfer popup. Cached raster previews enforce conversation ownership and are restored asynchronously; SSH transfers remain available through model tools.

Run test/attachments.test.js for filesystem/SFTP fixtures, actual POSIX subprocess and Linux PTY round trips, changing files and owner/idempotency/progress checks. Tests never call a real model. Native desktop, authenticated SSH, Windows/macOS desktop and simulated cross-platform cases must be reported separately.

The scoped russh event-buffer retention adapter is adapted from [tabby-ai-workspace-manager](https://github.com/SupremeJulyan/tabby-ai-workspace-manager/blob/b77c4dfe1f2de9e89419a23ce89fc938d1ebf309/src/adapters/exec-event-buffers.ts) (MIT, Copyright 2026 Julyan). Its notice is preserved in source and the bundled license notices. Only attachment-owned channel IDs are retained; other channel cleanup remains unchanged.

### CLI 启动并发

`CodexClient` 将缺省空间与 `system:codex` 视为同一连接身份，启动时冻结传给探测的空间，避免后台预连接被侧栏补充空间元数据时取消。后台运行时只报告最新连接尝试的错误。`ClaudeCodeAgent` 对相同 CLI、工作目录与空间的并发连接共享正在进行的就绪检查；替换、关闭和失败后允许重新检查。`test/client.test.js`、`test/runtime.test.js` 与 `test/claude-code.test.js` 覆盖这些竞态及取消／重试，不调用真实模型。

## Terminal streams and task logs

`terminal-stream.ts` owns stateful control filtering and scoped opaque tokens. `terminal-output.service.ts` rotates stream identity on session changes and publishes only privacy-filtered chunks. `terminal-log-store.ts` writes bounded private text segments with atomic manifests; `tab-tools.ts` owns capture lifecycle and read/search routing. Panel and scheduled bridges supply session-space/run-scoped identities. Continuation cursors pin the committed log boundary; reads do not execute or verify commands. See [terminal logs](terminal-logs.md) for limits and retention timing.


### v0.9.2 Codex installation and SSH identity maintenance (2026-11-07)

See [installation recovery and SSH process identity](codex-installation-recovery.md) for the fault boundaries, known Windows version/layout rule and loading a local build. Regression sources are `test/client.test.js`, `codex-version.test.js`, `installations.test.js`, `thread-tools.test.js`, `remote-process.test.js`, `tab-tools.test.js`, `task-memory-panel.test.js` and `runtime.test.js`. The real Linux PTY probe is local; transport fixtures and Windows discovery simulations do not prove a real Windows desktop or user SSH session. Run the full suite on Node >=22.19 to include the bundled Pi integration checks. The repair does not add runtime dependencies or require a separate system Node installation for ordinary plugin use.

### v0.9.4 navigation outcomes

`agent-conversation-state.ts` resolves task evidence separately from transport status. Ordinary interruptions are pale green; only confirmed user Stop, unfinished goals and execution limits are red. Completed turns await goal observation; external blockers are blue. API turns retain typed termination causes; Claude native result subtypes identify execution limits. Snapshots use v2 storage with v1 fallback, downgrading unclassified legacy failures. Goal reads are guarded against later turns and goal events; navigation does not invoke providers or replay tools.

## MCP 终端预览开发增量（未发布）

`runtime/mcp` 独立于 Angular TS 4.9，使用 `typescript-pi` 对应的 TS 5.9 做类型检查。`scripts/build-mcp.mjs` 将官方 SDK server/core、Node adapter 和 schema 依赖打入 `dist/mcp/utility.cjs`，main 协调器为 `electron-host.cjs`，附上 `THIRD_PARTY_NOTICES.txt`；生产包不安装 SDK，也没有新增安装脚本。`mcp:build` 纳入 build/pretest；MCP 运行在 Electron utilityProcess，PATH 为空，没有系统 Node 回退。

main 从 Tabby 主进程的 `TABBY_CONFIG_DIRECTORY`（缺省 userData）取 canonical 配置空间，不接受 renderer/HTTP 传入路径或窗口路由。实际 Electron IPC sender、顶层 frame 与 Tabby document URL 校验后注册 renderer。main 管理持久 token 摘要、空初始范围、不透明目标与授权代际，utility 只持有最小认证快照，renderer 在读取前后再验证实际 session/stream 与范围。snapshot/delta cursor 绑定客户端、revision、target、stream，客户端不能指定内部 owner/log scope。范围变更、取消、异常和退出不重放请求；只读适配器不调用输入工具。`mcp-execution.ts` 延迟获取共享 `TabbyTabToolsService`，仅映射四个输入／控制工具；context.beforeInput 在最终发送边界复核，allowTakeover=false 禁止自动中断，onInput 区分尚未发送与未知结果。

`src/mcp.service.ts` 从模块启动，设置关闭时不监听网络；`mcp-terminals.ts` 按授权引用计数 watch/unwatch 并取消等待。`mcp-settings.*` 是现有 Settings 内的可折叠分组；`mcp-client-config.ts` 仅生成复制预览，不写客户端文件。新增 MCP 界面文案在简体中文以外可使用英文回退，既有语言选择与翻译不变。权限与端口写入私有文件，终端范围不跨重启恢复。

`test/mcp.test.js` 覆盖官方 SDK 实际 HTTP 和真实输出服务，`mcp-electron.test.js` 覆盖可信路由／双窗口／崩溃／端口与撤销竞态；它们不能替代真实桌面。Linux Tabby/Codex 无模型真实终端闭环已取得；真实 Cursor／Claude、Windows/macOS、SSH 和旧宿主待补。更新后的 overview 是示意图，明确标注未发布与示例，不能冒充运行截图。

main 的 confirm/auto 权限以客户端绑定所选目标；重启回到 read_only。输入预约和 lease 在 main 同步创建，批准等待不占用 IPC 串行控制队列。目标窗口可批准／拒绝具体参数，25 秒超时；120 秒输入空闲 lease 自动释放。取消、撤销、范围／模式／会话变化、停止或崩溃清观察和 lease，通过独立 release 消息还原 renderer 控制，不发 Ctrl+C、不重放。客户端不能提供 owner、内部 tabId、sudo、foreground takeover 或日志 scope。33 秒总观察预算含批准等待，晚批准可能得到 unknown_outcome；不得将“已发送”当作命令完成。
renderer 同时持有独立 lease 截止计时器：即使 main 无法再投递 release/state，输入控制也会在本地截止时解除；续期只使用 main 签发的 expiresAt。

输出遮蔽先作用于完整快照；若正文被替换，则省略 interaction 元数据，不能对高亮片段分别调用有状态的 sanitizeView。utility 对已转发的四类写操作在总截止、取消或父通道断开时返回 unknown_outcome；HTTP 边界也将写入 observation_timeout／cancelled 保守映射为未知，只有明确的 main 拒绝保留具体原因。回归覆盖附件重复快照／其他读取者先识别 footer，以及两代真实 HTTP 协议经过 main 的晚批准、丢失 renderer 回复、清理租约和不重放；合成终端与宿主 fixture 不代表实机验证。

`runtime/mcp/discovery.cts` 管理独立标准 Agent Skill 的首次发现安装及无凭据位置记录。以 main 的真实 home/config-space 为准，绝不接受 HTTP 传入用户目录；同名已有技能只比较不覆盖。复制支持文件后最后写 SKILL.md，独占创建冲突不覆盖用户文件。每配置空间独立 hash 记录，内容白名单不含客户端摘要／凭据或目标范围；状态未变不写盘。发现写入失败与 MCP 生命周期分开，不修改授权，不注册客户端。设置页提供重试／检查，自定义技能路径仍手动导入。
