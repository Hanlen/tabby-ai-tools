# v0.5.3 trusted publishing validation (2026-10-31)

The release workflow uses npm Trusted Publishing with GitHub OIDC. It has read-only repository/actions access plus the publish job's id-token permission, with no stored npm token. A published stable GitHub Release triggers validation of its annotated tag, the exact commit's branch/tag three-platform checks, the attached tarball digest and review-note checksum, package identity, required artifacts and private-file exclusions. The same attachment is published without rebuilding; registry processing and downloaded bytes are verified before success. Manual dispatch defaults to a dry run. Already-published identical versions are no-ops; version overwrites and a backward latest tag are rejected.

Local Linux / Node 22.19.0 passed all seven release checks and 772 tests (766 passed, 6 Windows-only skips). Five new policy tests cover stable-tag parsing, wrong source commits/workflows, incomplete or failed platform checks, wrong package/repository/version, install hooks, SDK dependencies, archive traversal and local instructions/research. A real dry run validated the existing v0.5.1 GitHub artifact, both successful CI matrices and npm integrity, without sending a publish request. The one-time npm publisher binding and the first actual OIDC publication are checked during release; they are not inferred from dry-run success.

The v0.5.2 tag exposed a macOS timing assumption in the existing sudo lease test: a fixed 120 ms delay did not guarantee multiple refreshes. The test now waits for actual refresh events and removal of the worker directory with bounded deadlines; it retains command, refresh and stop assertions. The v0.5.2 tag is preserved without npm publication.

The runtime and missing-Node installation checks from 0.5.1 remain in the full test/build/package pipeline. The version label in the SVG/PNG overview and both README image descriptions is current; the robot GIF and static fallback remain unchanged. No paid inference or original-task replay is performed. CI/publish results and the exact release artifact checksum are recorded in the GitHub Release.

# v0.5.1 installation compatibility validation (2026-10-31)

The 0.5.0 release checks did not exercise installation without system Node. Its ordinary Pi dependencies caused every installation to install the SDK dependency tree, including a `protobufjs` postinstall script. A local reproduction with lifecycle scripts enabled, an explicit system shell and no `node` on PATH failed with `protobufjs@7.6.6 postinstall`, `node scripts/postinstall`, `/bin/sh: node: not found` and exit 127. The same environment successfully installs the 0.5.1 tarball.

Both Pi SDKs are now build-only devDependencies; esbuild emits a self-contained ESM runtime and third-party notices for 72 bundled packages. The build rejects remaining external package imports and uses JavaScript WebSocket implementations without optional native accelerators. The only ordinary npm runtime dependency is again `cross-spawn`. Local source installation copies the built runtime without invoking npm and excludes local roadmap/research files.

Local Linux / Node 22.19.0: skill bundle/check, typecheck, all 767 tests (761 passed, 0 failed, 6 Windows-only skips), production build, actual-tarball installation and whitespace checks passed. The package check explicitly enables lifecycle scripts, preserves the system shell by absolute path, removes Node from PATH and requires a control postinstall calling `node` to fail. It recursively inspects the installed production dependency closure for leaked SDK packages and install hooks. The initial test helper also removed the shell, causing a `spawn sh ENOENT` control failure; the corrected environment isolates the intended missing-Node condition. The final corrected check passes. Three-platform CI now includes this actual package installation check after building.

A separate regression copies only the built Pi sidecar to an isolated temporary directory outside the repository, then completes local HTTP streaming and a host-tool round trip without installed SDK packages. The local installer is also exercised with no npm entry point or Node on PATH. Both README renders and the current SVG/PNG overview are reviewed; the robot GIF and static fallback are unchanged. The final release records the verified tarball checksum and both branch/tag CI results. These checks do not establish a full Windows/macOS Tabby desktop upgrade or real provider access. No paid inference or user-task replay was performed.

The first pre-tag branch CI passed type checks, tests and builds on all three operating systems, then exposed an `ENOTCACHED` failure in the package check: `npm ci` caches locked archives but does not guarantee the version metadata needed by an offline fresh installation. The check now uses its own empty cache and the public registry, while preserving the missing-Node environment and enabled lifecycle scripts. Its result no longer depends on development-machine cache history. This changes the verification harness; the runtime bundle is unchanged.

The runtime also now defaults to Electron utility processes using Tabby’s built-in Node rather than searching PATH for an external executable. The external Node path is an explicit compatibility override. On official isolated Linux Tabby 1.0.238 / Electron 43.7.0 / Node 24.21.0, actual SDK streaming and a host-tool round trip passed without system Node on PATH; cancellation while a tool result was pending and destruction of the owner window both closed the owned utility process. This uses the actual packaged main bridge and sidecar with a local HTTP fixture. Final done/fatal IPC is acknowledged before shutdown. Node worker threads in the renderer and direct RunAsNode startup were checked and do not provide the supported path in that app. No real provider or terminal mutation was involved.

A later pre-tag Windows run exposed a transient EBUSY while removing an already closed mock executable in the existing Windows test fixture. Cleanup now uses bounded filesystem retries after confirmed child close; process lifecycle assertions remain unchanged. Windows/macOS Electron utility-process desktop runs remain outside the local Linux evidence, while bridge protocol, cancellation, owner/crash cleanup and missing-Node installation are covered by CI.

# v0.5.0 release validation (2026-10-31)

Local Linux / Node 22.19.0: `npm run skill:bundle`, `npm run skill:check`, `npm run typecheck`, `npm test` (760 tests: 754 passed, 0 failed, 6 Windows-only skips), `npm run build` and `git diff --check` passed. No paid inference or original upload/apply operations were run. Branch and tag CI results are recorded in the GitHub Release after all three operating systems pass.

The English and Chinese READMEs were rendered and checked for the centered header, badges, model-provider table, absolute image URLs, workflow tool descriptions and reduced-motion fallback. Codex login commands and the distinction between ChatGPT subscription access and API billing were checked against [official authentication documentation](https://learn.chatgpt.com/docs/auth). The current SVG/PNG illustration was regenerated and visually checked at 1800×1440; the existing robot GIF has 12 frames and its static fallback matches the 1024×512 dimensions. The real npm tarball is inspected before publication; its exact checksum is recorded with the GitHub Release. Roadmaps, research, the local issue report and AGENTS.md remain local and are excluded from the package.

Real provider/subscription access and full desktop/SSH workflows are not claimed by these offline release checks. The prior development records below retain their own dates, environments and validation limits.

# Workflow archive and alias development validation (2026-10-28)

Added session/workspace-scoped `workflow_status` and `workflow_set_alias`, explicit archive eligibility/rejection diagnostics, verified-recording retention after archive write failure, read-back confirmation and a guard that waits for archiving before starting a follow-up goal. Ordinary tasks remain unrecorded; these tools cannot recover an old, lost recording or manufacture a workflow from chat history. In-memory status and retry buffers are cleared on session changes, new recordings/alias runs, disablement or restart; already persisted workflows remain in Settings.

Local Linux / Node 22.23.3 validation: 760 tests, 754 passed and 6 Windows-only skips; skill bundle/check, typecheck, production build and `git diff --check` passed. Regression fixtures cover the four-step upload/extract/check/apply sequence followed by “设置别名为 pm1”, unrecorded and disabled states, archive rejection, failed-write retry, session/workspace/ID isolation, read-only writes, deleted/replaced workflows, concurrent retry deduplication and a follow-up arriving during archive persistence. No model inference or original upload/apply operations were performed. An initial full run under the shell's Node 20.20.2 failed two Pi tests because they require Node >=22.19; the complete suite passed after switching to Node 22.

Both READMEs were rendered with the Markdown parser and checked for the centered header, provider table, workflow tool descriptions, absolute public image paths and reduced-motion fallback. The SVG/PNG illustration now shows an explicitly recorded workflow and a saved `/pm1` alias and was previewed at 1800×1440. The robot animation and static fallback are unchanged. Real Tabby desktop/SSH behavior, macOS/Windows execution, CI and publication are not established by these local fixtures; no commit, tag or release was requested.

# v0.4.1 release validation (2026-10-25)

The release includes custom OpenAI-compatible Chat Completions/Responses connections, explicit no-key authentication, protocol-safe history/context transfer, Kimi/Alibaba Coding Plan presets, continuous API/Claude Code goals and model → reasoning selection. Local HTTP/SSE and CLI/MCP fixtures exercise discovery, native request parameters, streaming, continuous tool rounds, approvals, read-only behavior, cancellation, usage/budgets, repeated-loop protection, history recovery and context handoff. Existing provider fingerprints remain unchanged.

Local checks: `npm run skill:bundle`, `npm run skill:check`, `npm run typecheck`, `npm test` (710 tests: 704 passed, 6 Windows-only skips), `npm run build` and `git diff --check`. The two READMEs are rendered and checked for title, model table, image paths and reduced-motion fallback. The versioned SVG/PNG illustration is previewed and the robot GIF's animation/static dimensions are checked. A real npm tarball is inspected for version, entry point, runtime dependency, complete docs, bilingual READMEs, images and bundled skill; local instructions, research, credentials and node_modules are excluded. Branch and tag Linux/macOS/Windows CI are checked during release; remote publication and artifact integrity are verified after upload.

The first pre-tag Windows CI exposed a Claude batch-launcher default-import interop failure in the CommonJS test harness. The launcher now uses the same named `cross-spawn` export as Codex; the regression test covers Windows batch/native selection and piped arguments on every platform. The v0.4.0 tag then exposed a macOS stdin-close race after the branch checks passed. Claude now ignores EPIPE and pipe errors after close, relying on the process exit status, while preserving other pipe failures. A regression simulates early EPIPE and late errors without signaling a stale process group. The v0.4.0 tag remains unchanged and is not published to npm; v0.4.1 carries the fix.

No paid model request was made. Real third-party gateways, membership access/quota deduction and full Tabby desktop/SSH behavior remain unverified. These limits also apply to the local Claude Code integration included since the previous npm release. The prior development validation records below describe their own scope and dates.

The macOS CLI-discovery cancellation regression retains its ESRCH assertion but allows up to two seconds for kernel PID reaping after termination, avoiding an assumption that process IDs disappear synchronously. A still-running query continues to fail the test.

# Claude Code local-login development validation (2026-10-24)

The new native connection runs the installed official CLI with its own login and an authenticated loopback MCP bridge. Existing Claude API configuration remains separate. The implementation and official references are documented in [Claude Code integration](docs/claude-code.md).

Local Linux validation passed: `npm run skill:bundle`, `npm run skill:check`, `npm run typecheck`, `npm test` (522 tests: 516 passed, 6 Windows-only skips), `npm run build`, and `git diff --check`. The 21 new offline tests exercise real child-process pipes and HTTP MCP for streaming, successful native resume, portable history, crash recovery, read-only restrictions, accepted/rejected approvals, cancellation during approvals, unexpected CLI exit, malformed/truncated output, usage accounting/budgets, queued messages, repeated-tool detection, independent settings, native scheduler execution, and the isolated candidate-model probe. No model inference was performed.

The real Angular settings component was rendered in Chromium at 320, 600, and 1100 pixels in dark and light themes. Connection selection, independent model persistence, default badges, and input layout passed without horizontal overflow or browser errors. Scripts, screenshots, and report: `artifacts/claude-code-20261024/` (local validation artifacts). The real Angular sidebar also passed at 320 and 600 pixels: the native connection is selected, API Thinking controls stay hidden, native status/permission labels render, the selector remains within the viewport, and both status columns keep readable widths without browser errors (`artifacts/claude-code-sidebar-20261024/`). Both READMEs were rendered with the CommonMark parser and their model tables and image fallback markup were checked. Both README documents, the guide, development/architecture notes, bundled skill, and SVG/PNG illustration were updated. The illustration explicitly describes an unreleased development example; the robot GIF and static reduced-motion fallback are preserved.

No Claude Code installation or logged-in subscription is available on this host. Actual subscription inference, Tabby desktop/SSH behavior, and macOS/Windows execution are not established by these tests. No GitHub CI run, release, or npm publication was performed for this development change.

# v0.3.0 release validation (2026-10-24)

Automatic terminal takeover removes the foreground-detection confirmation dialog for ordinary and scheduled tasks. SSH/unknown enumeration proceeds without a confirmation callback or blind Ctrl+C. Detected unrelated processes are interrupted only after the agent marks them unnecessary, with stop/session/ownership checks and verification that the process ended. Needed processes and other owners remain protected.

This release also includes explicit `/remember TASK` recording, workspace-scoped workflow aliases, structured server/path identity and ordered result checkpoints, and same-terminal sudo preflight/refresh. Documentation and SVG/PNG illustrations are synchronized. Model-facing skill sources and the generated knowledge bundle are updated.

Local Linux validation passed: `skill:bundle`, `skill:check`, `typecheck`, all 467 tests (462 passed, 5 platform skips), production build and `git diff --check`. Both READMEs were rendered with CommonMark and the updated illustration was previewed.

Local validation uses simulated terminals/backends, a real PTY fixture and fake sudo; no paid model requests or real sudo credentials are used. The Linux run does not establish real Tabby desktop/SSH compatibility. Existing unknown processes still require verified identity to attach; API tool approvals and sudo authentication are separate from automatic terminal takeover. Sudo refresh requires a compatible POSIX shell/policy, and immediate cleanup may be unavailable in an occupied remote terminal without shell integration. Semantic completion evidence remains model-evaluated.

# Codex 定位与启动验证

## 默认启动与高清介绍动画（0.2.3）

AI Tools 默认在 Tabby 启动后打开，兼容未保存该设置的已有配置，保留明确关闭。等待应用与配置就绪后延迟挂载，沿用目录优先级与单次打开规则。双语 README、指南、开发说明、内置 Skill 和效果图已同步。

本机 Linux / Node v20.20.2：`npm test` 共 458 项，453 通过、0 失败、5 项 Windows 专用测试跳过；`npm run skill:bundle`、`npm run skill:check`、`npm run typecheck`、`npm run build`、`git diff --check` 通过。启动回归覆盖默认配置、缺失配置、明确关闭、就绪顺序、目录、单次打开和销毁。

README 机器人 GIF 与降动态静态 PNG 同步更新为 1024 × 512，保留 12 帧无限循环和原有节奏，显示尺寸仍为 560 × 280。图像检查与最终包验证记录在发布产物校验中。未调用真实模型，未进行本轮 Tabby 桌面启动实测；跨平台执行结果以本次 GitHub Actions 为准。

## 无人值守定时任务、重启加载与配置页删除（2026-10-22）

定时会话统一使用不询问策略，保留保存的沙箱范围，不修改全局或普通对话设置。终端交互按任务目标和最新输出自主判断；后端 `requestUserInput` 使用本次实际模型的独立只读会话查找并选择具体答案，持久化依据后回传主会话。拒绝额外权限审批，无法查询或回答时留档暂停。自动决策用量计入预算，停止、退出、连接中断及查询卡住都能取消决策并关闭专用后端。插件移除 Vault 依赖和读写入口，密钥仅从插件配置或环境变量读取；旧 Vault 来源明确要求重新配置，不访问或弹出解锁界面。

设置 → AI Tools → 定时任务显示所有目录的计划，支持暂停/恢复、停止和页面内确认删除。删除任务及执行记录使用与触发相同的文件锁，运行中或被其他窗口领取的任务不能删除。重建调度服务的回归测试验证：配置已完成加载也能自动启动、关闭期间错过多次触发只运行一次、保留暂停计划、删除后不再加载、未完成运行记为中断并暂停而非重放。

Linux / Node v20.20.2：`npm test` 共 432 项，427 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。四种 API 的本地 HTTP/SSE 回归覆盖无人值守操作继续执行且不发布用户审批；自动回答使用模拟模型分别依据实际查询结果选择不同分支，并验证只读、日志、累计用量和取消。

真实 Angular 配置模板在 Chromium 的 220、320、420、600、1100 像素宽度下验证任务列表、暂停、运行中禁止删除、删除确认、停止后可删除、页面切换及无 Vault 入口，没有横向溢出、按钮越界或页面运行错误。脚本、截图与报告位于 `artifacts/unattended-settings-20261022/`。浏览器数据为模拟数据；未调用真实供应商，也未进行真实 Tabby 桌面端到端验证，不证明真实模型每次都能选出正确答案。

## 任务独立选模、预检与默认回退（2026-10-22）

对话可为单个任务选择已配置的连接、模型与推理强度，包括 Codex `gpt-6-sol` / `high`；调整仅影响后续任务运行，保留当前对话、全局默认及原有权限。先发送独立的工具调用预检，通过后保存；候选失败再测试插件默认模型，默认通过才回退，均失败则不变更原任务。运行前重新测试首选，临时回退保留首选供下次重试；取消测试不触发回退，已开始的任务操作不跨模型自动重放。执行记录包含实际模型、推理强度、测试结果、回退原因及已上报的测试用量。

Linux / Node v20.20.2 验证：`npm test` 共 368 项，363 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。覆盖配置隔离、未来运行快照、四种 API 协议的限流和缺少工具调用、默认同时失败、停止预检、首选恢复重试、测试结果不可伪造、凭据脱敏及 Codex 精确模型/effort 传参、超时和独立会话清理。与构建同时运行的一轮检查触发了原有 process-lifecycle 子进程回收时序断言；该文件独立复查及后续全量回归通过，未修改进程回收代码。

API 生成使用本地 HTTP/SSE，Codex 生成使用模拟 app-server。真实 `/usr/bin/codex` 另验证预检实际代码的 ephemeral 只读临时会话、关闭 shell/apps/web search 的配置、校验工具注册和模型参数；在本地拦截 `turn/start`，没有发送真实推理请求。此检查发现并修复预检 namespace 缺少必填 description；测试补充了相应约束。已有 `smoke:context` 验证工具版本 5 的注册及会话创建/恢复，不调用模型。没有验证账号实际可调用 `gpt-6-sol`，生产预检才会验证实时可用性并产生模型用量。

真实 Angular 模板配合模拟回退记录，在 Chromium 的 220、320、420、600 像素宽度验证实际模型与回退状态、审批、暂停、延迟加载记录及关闭，未见横向溢出、按钮越界或页面错误。报告、脚本及截图位于 `artifacts/task-model-fallback-20261022/`。未进行真实供应商定时流程或 Tabby 桌面端到端实测。

## 对话定时 AI 流程（2026-10-22）

新增单次、固定间隔和带时区的每日任务；由插件生命周期启动调度，复用 Codex / API 工具循环，按每轮结果继续判断与执行。每次独立会话、显式验证结论、持久化操作与结果、审批等待、暂停/恢复、立即运行、停止与记录查看一并接入。

Linux / Node v20.20.2 验证：`npm test` 共 315 项，310 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。新增测试覆盖时区与夏令时、多窗口原子领取、错过触发合并、租约失效不重放、后台启动、权限快照、输出分支、多回合继续、人工输入、审批拒绝、用户停止、token 预算、日志失败与脱敏，以及创建已持久化但界面刷新失败时不误报创建失败。

四种 API 使用本地 HTTP/SSE 模拟响应完整执行“检查异常 → 执行修复 → 再次验证 → 留档”。真实 `/usr/bin/codex` 的 `npm run smoke:context -- /usr/bin/codex` 验证新增工具注册、会话创建/恢复和上下文保留，不发送模型请求或执行工具。

真实 Angular 模板在 Chromium 的 220、320、420、600 像素宽度下验证打开面板、审批、暂停、展开/收起记录及关闭；无横向溢出、按钮越界或页面运行错误。脚本、报告与截图位于 `artifacts/scheduled-tasks-20261022/`，使用模拟任务和运行记录。未进行真实供应商定时运行或 Tabby 桌面端到端实测。

## 根据 Agent 最新输出动态响应（2026-10-22）

明确控制策略：用户给目标；外层模型每次读取被控 Agent 最新输出及选择状态，决定本次按键、文字回答或等待，操作后重新观察。创建定时任务时保存目标与判断要求，不根据示例生成固定按键顺序。Codex 和 API 共用的控制说明及定时运行提示均已更新。

新增四种 API × 三种输出场景的反馈测试。同一用户目标分别收到 Shift+Left 后 Enter、Down 后 Tab、直接询问分支三种不同提示；模拟模型从真实协议请求中的最新工具结果选取响应，等待状态不发送输入，最后验证结论及留档。测试使用本地 SSE 模拟模型，验证运行时反馈传递和分支衔接，不证明真实模型的推理判断能力。

最终全量测试共 338 项，333 通过、0 失败、5 项 Windows 专用测试跳过；类型检查、生产构建和差异格式检查通过。未调用真实供应商，未新增真实 Codex 交互实测。

## 交互式 Agent 控制补充（2026-10-22）

新增 `attach_process` 和 `send_keys`：不重启已运行 Agent，先核对进程再取得输入控制，支持 Shift+Left、方向键、回车、Tab、Shift+Tab、Escape 与 Ctrl+字母等终端按键。接管后的按键和文本输入会再次检查进程、会话、取消状态与所有权。`read_tab` 提供光标及高亮片段；控制提示要求逐步读屏、判断、操作、验证。原有审批和只读限制覆盖新工具，工具版本升至 4，让旧 Codex 会话保留上下文并升级工具。

模拟 Agent 界面配合真实 Tabby 工具路由及定时执行器验证“接管 → 读取提示 → Shift+Left → 检查选择 → 回车 → 读取问题 → 输入回答 → 验证完成 → 留档”。四种 API 的本地 SSE 测试验证接管、按键参数及逐次审批；额外覆盖错误进程、未知进程、Agent 退出、其他任务占用、只读和停止时不误发输入。

最终 `npm test` 共 326 项，321 通过、0 失败、5 项 Windows 专用测试跳过；类型检查、生产构建、差异格式检查通过。真实 Codex 的 `smoke:context` 验证新增工具注册和会话恢复，不发送模型请求。较早的并行验证曾触发原有进程回收测试读取 `/proc` 的时序竞态，该文件的独立回归及最终全量回归通过，未修改进程回收代码。

尚未在真实 Codex 或其他 Agent 的交互界面发送按键；实际快捷键、界面兼容性及远程进程检测仍以实测为准。

## Tabby AI Tools 0.1.0 发布检查（2026-10-18）

插件更名为 Tabby AI Tools，npm 包名为 `tabby-ai-tools`。同步更新设置页、工具栏、错误提示、文档和界面示意；保留内部 `codexAgent` 配置键与 `tabby_codex_agent` 会话来源标识，以兼容已保存的配置和会话。

Linux / Node v20.20.2：类型检查、生产构建通过；测试共 267 项，262 通过、0 失败、5 项 Windows 专用测试跳过。发布包只包含入口、文档、包信息和许可证，共 11 个文件；在临时目录中以生产依赖安装 `.tgz` 成功，并通过使用 Tabby/Angular 宿主 API 替身的构建入口加载检查。上述检查不代表 Tabby 桌面 UI 或 macOS/Windows 实测。

## 本地任务流程与操作偏好（2026-10-18）

新增 `task-memory.ts` / `task-memory.service.ts`，在插件共用的发送与工具返回入口记录已提交命令、操作意图和检查点；任务回合和 Goal 均完成，并在最后命令后读取终端才归档。恢复中的未录制任务、stdin、含已识别密钥的命令、过长或不完整记录不会自动拼成可复用流程。匹配在本地按工作目录进行，每次只附上一份流程与最多八条适用偏好；区分常见操作意图和否定操作，不执行历史命令、不增加模型调用。提供 `/workflows`、`/remember`、单次跳过与全局开关，设置支持编辑、停用、删除和偏好作用域。手动编辑的步骤不会被后续归档覆盖。库文件采用写锁和原子替换，损坏库不会覆盖，也不会阻止普通任务发送。

Linux / Node v20.20.2：`npm test` 共 267 项，262 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。新增测试覆盖重启持久化、同目录检索、操作同义词与相反/否定意图、归档条件、步骤去重、敏感内容与交互输入过滤、偏好 CRUD 和作用域、手动步骤保留、并发窗口写入、损坏库不覆盖、旧任务回调隔离，以及 Codex/API 面板从完成归档到下一请求注入的完整链路。测试不调用真实模型、不操作真实终端。

使用真实 Angular 组件和模板、Tabby 基础样式及内存存储夹具，在 Chromium 中验证流程列表、编辑保存、停用、添加偏好、偏好作用域编辑、全局开关与 375px 内容区域适配。脚本和截图在 `artifacts/settings-review/`。尚未进行 Tabby 桌面端实测或真实任务 token/耗时对比；词项匹配不等于完整语义检索，已完成任务记录也不提供逐命令退出码证明。

## API 重复工具循环检测（2026-10-18）

新增 `api-loop-guard.ts`，独立于固定轮数上限检测最近 96 次调用中的重复序列：操作与结果连续重复三次、周期最多 32 步时停止后续操作。规范化 JSON 和非操作参数，比较终端新增输出，排除仅有发送回执及活跃/未知进程的静止画面。触发后补齐同批未执行工具的错误结果，Goal 标为 blocked，保留一次无工具总结请求。记录随会话保存，恢复后可在发送前阻止同一循环的下一条命令；新 Goal 清空记录。

本机 Linux / Node v20.20.2：`npm test` 共 244 项，239 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。新增测试覆盖四种供应商的 A/B/C 循环拦截、20 步较长周期、滚屏累积、正常等待与进展不误判、同批调用停止及结果配对、持久化恢复和命令发送前拦截、新目标重置。测试使用本地 HTTP/SSE 夹具，未调用真实供应商 API，未进行 Tabby 桌面实测。检测不推断语义等价，命令写法变化、输出噪声或超出观察窗口的循环仍可能漏检。

## API 工具循环上限与终端等待修复（2026-10-18）

四种 API 共用的运行时支持将工具轮数上限设为 0（新连接默认），已有显式数值保留。有限模式只统计含工具调用的请求，最后额外允许读取结果、更新一次本地 Goal 并输出回复，收尾阶段禁止继续操作终端；未完成目标仍显示未完成。系统提示明确命令提交、复用标签 ID 和等待输出，`read_tab` 支持可取消的延时读取，受控终端默认等待 1 秒。

本机 Linux / Node v20.20.2 验证：`npm test` 共 234 项，229 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。新增回归覆盖四种供应商超过原默认 20 轮后继续、最后一轮目标完成及最后终端结果后的目标更新、收尾工具限制、未完成目标保留、排队文本不消耗工具轮数、0 值规范化、无限轮数模式的 token 预算与取消，以及延时读取取消和标签关闭。API 请求使用本地 HTTP/SSE 夹具，未调用真实供应商 API，未进行 Tabby 桌面实测。

## Thinking 紧凑布局与自动获取模型列表（2026-10-17）

Thinking 开关与等级移到模型摘要同一行，宽度不足时换行；模型名称截断后可悬停查看完整信息。设置页聚焦模型输入框或点击获取按钮，侧栏打开模型选择器时，从当前连接的 `/models` 自动读取列表；支持刷新、分页去重与手动输入。修改端点或密钥来源后使旧列表失效，关闭连接或设置页时取消请求。

本机验证：`npm test` 共 212 项，207 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。新增本地 HTTP 夹具覆盖四种供应商鉴权、分页、无模型配置时获取、错误脱敏、重定向拒绝、取消、旧连接结果隔离，以及选择远端模型后保留对话与 Goal 并继续请求。

使用真实组件及模板的 Chromium 浏览器验证：320、400、600 像素下模型与 Thinking 控件同一行，220 像素下自动换行，各宽度无横向溢出；Thinking 开关与等级保存、自动读取、刷新、选择及失败后手动输入均通过。设置页验证模型建议、聚焦获取、手动刷新和修改端点后失效。记录、脚本与截图位于 `artifacts/thinking-models-20261017/`。浏览器使用模型列表夹具，真实 HTTP 协议由单元测试覆盖；未调用真实供应商 API，未进行 Tabby 桌面实测。

## 连接测试、DeepSeek 流式与 Codex 上下文互通（2026-10-17）

- “检查配置”改为实际发送简短模型请求的“测试连接”；四种协议使用与运行时相同的配置规范化和流式适配器。进度与成功/错误结果显示在对应卡片，支持取消、60 秒超时及销毁后停止刷新。
- DeepSeek 侧栏新增 Thinking 开关与 low/high/max，下一回合生效；关闭时不发送可能重新启用思考的 effort。接收思考时显示字符进度，Node 回调内显式刷新正文增量。延迟 SSE 夹具确认首段已经显示时服务端尚未结束请求；非 SSE 响应明确报告兼容错误。
- API/Codex 双向迁移保留对话、工具结果、转发输出和目标；Codex 原生分页历史与继承历史共同导出，导入历史用于模型上下文并单独持久化供 UI 和重启恢复使用。准备和恢复失败均回到原连接，恢复两类会话索引。
- 真实 app-server 验证发现 active Goal 会自动启动回合。迁移与新用户目标改为先持久化为 paused，在用户显式回合被接受后才激活；UI 显示待继续的逻辑目标。目标激活失败不会把已接受的回合误报为发送失败。

本机验证：`npm test` 共 192 项，187 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。`npm run smoke:context -- /usr/bin/codex` 通过，使用真实本机 Codex 验证导入、恢复、显示历史、再导出与目标连续性，并断言迁移未启动任何回合；测试线程退出时归档。API 协议与侧栏回归使用本地 HTTP/SSE 夹具，尚未使用真实 DeepSeek 等服务商 API 或 Tabby 桌面 UI 实测。

## API Key 直接输入与上下文迁移（2026-10-17）

API 连接新增“直接输入”密钥来源，新连接默认使用此方式，无需启用 Vault；密钥保存在本地插件配置，旧配置继续使用原有环境变量或 Vault 来源。切换 API 连接、供应商、端点或模型时，迁移对话正文、转发的终端输出、工具记录、Goal 及累计用量；原生推理块不跨模型传递，历史工具只作为文本参考。同配置重连保留原生消息，新会话仍从空白开始。迁移或恢复失败时恢复原连接、对话和历史索引。

本机验证：`npm test` 共 179 项，174 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。新增覆盖四种 API 供应商之间的 16 种迁移组合、迁移后继续请求与重启恢复、模型及端点变更、同配置重连保留原生推理、直接输入密钥的请求鉴权及其不进入会话文件、旧密钥来源兼容、侧栏迁移入口与两阶段失败恢复。协议测试使用本地 HTTP/SSE 夹具，没有发送真实供应商请求；Tabby 桌面 UI 尚未实测。

## 多模型 Agent 设计、评审与实施（2026-10-17）

方案与实施前评审见 [多模型 Agent 设计](docs/multi-provider-agent.md)。保留 Codex 引擎，新增绑定单个面板的 API Backend、Node SSE 传输、OpenAI Responses / DeepSeek 与 GLM Chat Completions / Claude Messages 协议、本地会话和 Goal 存储、Vault 与环境变量密钥入口。

实现后的复查修正了：停止后终端检测完成时误发命令的窗口、切换连接后旧工具结果误回传到新 Backend 的可能性、Vault 等待阻塞停止、结束阶段的追加输入、Claude 缓存输入统计，以及缺少用量时误报零占用。此前 context 状态卡的 Angular 刷新修复继续保留。

在本机 Linux、Node v20.20.2 执行：

- `npm test`：158 项，153 通过、0 失败、5 项 Windows 专用测试跳过。
- `npm run typecheck`：通过。
- `npm run build`：通过，生成 `dist/index.js`。
- `git diff --check`：通过。

新测试使用本地 HTTP/SSE 夹具验证四家协议的连续两轮工具调用、原始推理内容回传、正文流式显示、审批接受/拒绝、只读限制、停止请求、排队输入、循环和 token 预算、跨连接历史隔离、重启恢复、损坏文件保护、密钥存储边界及错误流。所有请求均发往测试回环地址，未使用真实 API Key，未发送付费模型请求。

尚未完成真实供应商连通性、Tabby 桌面 UI、macOS/Windows 新 API 路径的实测。API 模式没有 Codex 的 OS 沙箱，不自动压缩上下文；操作终端使用终端账户权限，停止 HTTP 请求不等于已经终止终端命令。用量为服务商已上报 token 的统计，预算为请求边界的软上限。

## Review 修复验证（2026-10-16）

本轮修复四项 review 问题，以下结果在 Linux、Node 20.20.2、Codex CLI 0.162.1 上执行：

- 默认命令发现补充 `CODEX_INSTALL_DIR`，Windows 补充官方独立安装 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`，保留 PATH、显式设置及自定义命令的优先级约定。
- 已选中 Codex 的 JavaScript 启动器缺少 Node 时，恢复 Shell / NVM 的 Node 环境；不替换选中的启动器，无法恢复时给出运行环境错误。
- 默认模式即使在 PATH 找到 Codex，也读取 Shell 的指定 Codex 状态目录、代理、证书及认证变量；父环境已有值优先。独立管道、超时、输出上限继续生效，不导入 NODE_OPTIONS，不在诊断中回显环境值。
- POSIX 使用独立进程组，SIGTERM 超时后升级 SIGKILL，并等待旧服务退出后再启动新服务；覆盖忽略终止信号、存活子进程、父进程退出但子进程持有管道，以及回收失败阻止重启。Windows 改用绝对路径 taskkill，新增空 PATH 下常驻 Node 子进程的真实 Windows 回收测试。
- CI 矩阵新增 macOS，保留 Ubuntu 和 Windows。

验证结果：`npm test` 共 129 项，124 通过、0 失败、5 项 Windows 专用测试跳过；`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。`node scripts/smoke-codex.cjs --without-path` 通过，实际 CLI 为 `/usr/bin/codex`，完成 initialize/initialized；未发送模型请求。macOS/Windows 的本轮真实执行结果尚未取得，规则模拟与 CI 配置不视为实测通过。

## 历史 Windows 验证记录

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


## 显式流程别名、服务器身份与步骤验收（2026-10-24）

流程由 `/remember TASK` 显式录制，完成后配置别名，`/task1` 调用。步骤保存服务器连接／持久 ID、已确认 IP、账户、端口、绝对操作路径、串行依赖、验收条件与证据。增加 `workflow_checkpoint` 与 `verificationFor`，对同终端的新观察、未完成前置步骤、并行发送、身份／目录不符和弱化验收条件进行门禁；业务结果语义仍由模型判断。旧格式可读，缺失结构建议重新录制。

验证使用真实流程存储与模拟后端／终端：覆盖两台服务器相同命令不合并、跨服务器阻断、旧读／错误终端／运行中结果不能确认、检查命令不推进步骤、目标及路径不符、显式身份探测和绑定。sudo 用假命令测试，不使用真实凭据；未进行真实 Tabby 桌面、SSH、多供应商模型端到端或耗时／token 对比测试。


## macOS ChatGPT.app 路径修复（0.3.1）

默认发现补充 `~/Applications/ChatGPT.app/Contents/Resources/codex` 和 `/Applications/ChatGPT.app/Contents/Resources/codex`，保留 PATH、Shell、NVM 及常见安装目录优先级。回归验证用户应用目录、替代系统应用目录、带空格显式路径、无执行权限拒绝、自定义命令不降级，以及 Linux 不扫描 macOS 用户应用目录。

本地 Linux：469 项测试，464 通过、5 项平台跳过；类型检查、skill 一致性和生产构建通过。真实 ChatGPT.app 安装布局及 Tabby macOS 桌面端到端未在本机验证；不调用收费模型烟测。跨平台分支与标签 CI 结果由 GitHub Actions 单独核验。


## 完整 Codex 安装来源发现（0.3.2）

按跨平台路径表补齐 standalone 内部 current/bin 与旧 current 入口、动态 Homebrew/npm prefix、macOS 新 codex-cli/bin 与 Codex.app 兼容入口，以及 VS Code/Insiders/远程扩展兜底。候选逐个验证，IDE 按 OS/架构筛选并按扩展版本降序；显式路径、自定义命令和已选 CLI 不被替换。包管理器查询独立限时、限输出，失败后继续其他来源，取消会回收进程树；查询输出不写入诊断。

新增路径矩阵测试、prefix 故障/超时/取消测试，以及 Windows 真实 npm.cmd 查询和 codex.cmd JSONL 连接夹具。源路径固定为临时目录；不访问真实模型，不将本机发现规则模拟报告为 macOS/Windows 桌面端到端验证。完整结果见发布说明和本次 GitHub Actions 分支/标签运行记录。

本地 Linux 结果：501 项测试，495 通过、6 项平台跳过；skill bundle/check、TypeScript、生产构建及 git diff --check 通过。Windows 专用 npm.cmd 连接测试仅在真实 Windows CI 上执行，本机明确跳过。


## 2026-10-26 — optional Pi runtime (unreleased)

Development/CI Node is pinned to 22.19.0; the Angular plugin retains TypeScript 4.9 and the separate Pi ESM build uses pinned TypeScript 5.9.3. `npm ci --ignore-scripts`, skill bundle/check, both type checks, production webpack + Pi build, and `git diff --check` passed locally. The initial implementation suite reported 743 tests: 737 pass and 6 platform-specific skips. No real model calls were used.

Actual Pi SDK 1.4.0 HTTP fixtures cover Chat Completions, Responses and Anthropic streaming; registered host tools only; serial execution; policy denial in durable history; 429 after a completed tool without replay; cancellation during backoff; quota exhaustion; native Goal continuation without an outer API replay; restart and model handoff; repeated compaction with raw entry retention; summary usage and budget exhaustion; API projection boundaries and summary source hashes; duplicate-action result reuse and unknown-result refusal; process death during a host tool wait; and accepted-input reconciliation after host persistence failure; missing authoritative history failing closed; and repeated text with fresh tool observations remaining valid progress. UI regression checks cover structured retry delays, late cancellation events, and the separate /compact maintenance turn. Readiness probes use the actual external Pi path with a harmless nonce tool.

An additional official Linux Tabby desktop fixture was executed using downloaded Tabby 1.0.238 (release tarball SHA-256 `36436de2c2f8651ebed4a222e759583d6fedf3f62904b13d7c9599a084859309`). Under Xvfb, the actual host reported Electron 43.7.0 / Node 24.21.0. An isolated configuration loaded the plugin and rendered Pi runtime settings. The sidebar used external Node 22.19.0, received three local-provider streaming responses, called the actual Tabby list_tabs host bridge, received the Welcome tab metadata, updated its Goal with evidence and displayed `PI_DESKTOP_FIXTURE_OK`. The bridge inspected the isolated desktop's actual tabs; it did not execute a terminal command or contact a real model.

The implementation branch configures the full check matrix on Ubuntu, macOS and Windows with Node 22.19.0; consult its GitHub checks for authoritative remote results. Real provider credentials, subscription access, SSH/PTY mutation and real-model summary quality remain unverified. Pi stays optional and does not replace Codex, Claude Code or the API backend. The overview SVG/PNG is a development illustration, not the desktop fixture screenshot; the existing 12-frame robot GIF and static fallback are preserved. Research/evidence and local AGENTS.md remain excluded from Git and npm packaging. No version/tag/npm/GitHub release was requested or performed.


## 2026-10-27 — Pi review fixes (unreleased)

Seven new regressions reproduced the three review findings before the fix. They exercise real SDK `steer → interrupt → /compact → restart → continue` sequences with both actual and no-op compaction; truncated streaming responses with and without an active Goal; and request construction at Kimi Coding mainland, international and proxy URLs by intercepting the SDK fetch boundary without network access. Assertions cover queued corrections and unknown-outcome recovery reaching the next model request exactly once, unchanged compaction acknowledgement cursors, retained partial text/token usage with a failed turn, no silent truncation continuation, and explicit system/max_tokens compatibility with thinking enabled.

The fixes change context acknowledgement, error classification and provider wire configuration; the existing settings and interface illustration remain accurate. No real model requests or quota-consuming smoke tests were used. Skill bundle/check, both type checks, production build and diff checks passed locally. The updated full suite reports 750 tests: 744 pass and 6 platform-specific skips on Linux. Current-head cross-platform results are recorded in the implementation PR checks.
