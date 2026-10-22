# Codex 定位与启动验证

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
