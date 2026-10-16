# Tabby Codex AI 插件

在 [Tabby](https://github.com/Eugeny/tabby) 的左侧栏中使用可复用的 Codex AI 面板。插件以本地 `codex app-server` 进程提供服务，直接消费流式事件，使用 Codex 保存的线程历史和 Goal 状态。

插件加载并读取配置后会立即启动常驻的 `codex app-server --listen stdio://`，每个 Tabby 窗口共用一个进程。打开、收起或切换侧栏均复用该服务，通过 JSONL 通知逐段显示流式应答。进程异常退出后自动重连，重试间隔从 1 秒逐步增加到最多 30 秒；服务启动失败会提示检查 CLI 路径。修改并保存 CLI 路径后自动更换进程，其他设置保存不会重启服务。窗口退出或插件销毁时关闭进程并清理重连定时器。

## 安装

1. 安装 Codex CLI 并在终端运行 `codex login`。建议使用支持 `thread/goal/*` 的版本（已用 `codex-cli 0.162.1` 验证）。
2. 在本目录运行 `npm install && npm run build`。
3. 在 Tabby 的 **Settings → Plugins → Open Plugins Directory** 中打开用户插件目录，复制该目录路径。在本项目运行 `npm run install:tabby -- "<刚打开的插件目录路径>"`，再完全退出并重启 Tabby。安装命令会复制包信息和构建结果到 `node_modules/tabby-codex-agent/`；也可以按此目录结构手动复制。开发时可使用 `TABBY_PLUGINS=/path/to/tabby-ai tabby --debug`。
4. 在 Tabby 设置的 **Codex AI** 页面配置 CLI 路径、工作目录、模型和执行权限。点击工具栏机器人图标打开左侧 AI 面板。

`codexAgent.executable` 留空或保持默认 `codex` 时，先从 **Tabby 自身进程的 PATH** 查找并验证文件。Windows 若 PATH 无可用 Codex，再扫描 `%LOCALAPPDATA%\OpenAI\Codex\bin\<目录>\codex.exe`。目录名可以是哈希；跳过缺文件、不可读或不是普通文件的候选，按 **codex.exe 的修改时间降序** 选择，时间相同用完整路径作稳定排序，不从目录名推断版本。每次重新启动后台进程都会重新扫描，以适配升级和旧目录清理；已有连接继续复用当前进程。文件时间只能表示文件的新旧，不能保证软件版本；需要固定安装时请填写显式路径。无需本机临时启动器，也不依赖开发终端变量。

Linux/macOS 的桌面 PATH 中没有默认 `codex` 时，会异步启动 `$SHELL -ilc` 读取 PATH（未设置 SHELL 时，Linux 使用 `/bin/bash`，macOS 使用 `/bin/zsh`；支持 bash/zsh/sh/dash/ksh/fish）。探测限时 3 秒，通过独立管道读取最多 64 KiB，忽略 Shell 启动输出；超时、失败或未找到 Codex 时继续检查安装目录。补充目录依次为 `~/.local/bin`、`~/.npm-global/bin`、`$NVM_DIR` 及 `~/.nvm` 下的 `current/bin` 和 `versions/node/v*/bin`，最后检查 `/opt/homebrew/bin` 和 `/usr/local/bin`。NVM 优先 current，其余按 Node 版本降序选择含有效 Codex 的目录；Shell 选择的安装优先于目录扫描。不要求 Shell 一定加载 NVM，也不固定用户名或 Node 版本。

查找结果与启动环境一起传递：读取到的 Shell PATH 会传给 app-server，Linux/macOS 还会把选中启动器的所在目录放到子进程 PATH 首位，保证 NVM 的 `#!/usr/bin/env node` 启动器能找到同目录的 Node；显式 NVM 路径也适用。父进程环境不变。关闭连接或切换配置会取消尚未结束的探测，防止旧请求随后启动后台进程。

显式配置的绝对路径、相对路径或 `~/` 路径优先（可带一对外层引号），会验证真实文件存在；无效立即报错，**不会自动降级到另一安装**。自定义命令名（如 `my-codex`、`codex.cmd`）仅按 PATH / Windows PATHEXT 查找，保留命令名配置兼容性；未找到也不会改用桌面安装。Windows 支持原生 exe/com 和 cmd/bat 启动器，含空格、中文路径可用。原生程序使用绝对路径、参数数组和 `shell:false`；cmd/bat 由 cross-spawn 负责 cmd.exe 转义，stdin/stdout JSONL 及 stderr 均保留为管道。只填写文件路径或命令名，不附加参数。

子进程环境会移除所有大小写形式的 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`，初始化始终使用插件自己的 `clientInfo.name = tabby_codex_agent`，父进程环境不变。定位失败会给出 PATH 检查情况、Windows 安装扫描路径或 LOCALAPPDATA 缺失、Linux/macOS 的 Shell 探测结果及补充安装目录、候选拒绝原因，以及 **Settings → Codex AI → Codex CLI 可执行文件（`codexAgent.executable`）** 设置入口。

出现 `Codex app-server exited (1)` 时，侧栏会同时显示实际启动路径和 CLI 的错误输出。可在终端运行 `codex app-server --listen stdio://` 查看相同安装的启动错误；命令启动后等待输入是正常现象，按 Ctrl+C 退出。路径、Codex 配置和安装问题应以错误输出为准。

本地安装后请在 **已安装插件** 中查看；**可用插件** 列表来自 npm 搜索，未发布到 npm 的本地包不会出现在该列表。

## 使用

- 默认读取当前本地终端的工作目录；设置页可指定固定目录。每个目录保存一个 Codex 线程 ID；收起侧栏后面板仍保留，重启 Tabby 后调用 `thread/resume` 恢复上下文。首次升级到支持全标签工具的版本时会为该目录创建新线程，旧线程仍保存在 Codex 本地历史中。
- Codex 可用 `tabby_tabs` 工具列出当前窗口的全部标签及分屏终端、读取终端屏幕和滚屏、切换标签，并向任意仍在运行的终端发送输入。普通标签可读取其文本和控件，按控件 ID 点击或填写。标签和控件 ID 仅在当前 Tabby 窗口中有效，操作前应重新读取。
- 侧栏第二行以“控 N”显示 Codex 当前控制的终端数量，无控制时仅显示短占位。AI 提交命令后，该 Tab 的用户输入会暂时锁定；本地会话检测到命令子进程退出时自动释放，Codex 也可调用 `release_tab` 释放。用户可随时点摘要旁的 **释放** 释放全部受控终端，或在 **详情 → 终端控制** 中逐个点 **临时释放** 取回输入权；当前回合结束、连接断开或标签关闭时也会释放。锁定期间终端仍可查看输出。
- 向已有进程的终端发新命令前，Codex 应先读取 Tab 并判断现有任务是否仍需要。需要时插件阻止覆盖；不需要时侧栏显示进程和新命令用途，由用户决定是否先发送 Ctrl+C。远程会话等无法检测进程状态的终端，会要求用户确认空闲或同意中断；中断后还需确认已回到命令提示符，才会发送新命令。拒绝后不会发送新命令。`getChildProcesses` 只表示本地会话有子进程，不能严格证明它就是前台进程；遇到不确定状态请核对终端内容。
- 再次点击工具栏图标会打开同一侧栏；切换目录时复用对应目录的面板和线程。Codex 侧栏独立位于普通标签栏左侧，右边缘可以拖动改变宽度，宽度会记住。灰色按钮表示连接或会话恢复中，绿色表示会话已就绪，红色表示未连接，点击可重连。输入 `new` 或 `/new` 会创建新线程，旧会话和目标保留，可用 `/resume` 恢复。
- 输入 `/resume` 仅查看当前工作目录下由 Tabby AI Agent 创建的会话，再次输入可关闭列表。列表显示标题或首条消息、更新时间和当前会话标记；点击某项即可恢复，也可在空输入框中用上下方向键选择、Enter 恢复、Esc 关闭，支持刷新和分页加载。正在执行任务时可在列表中点击“停止当前任务”，等待停止后再恢复；等待回答或审批时请先处理。
- 输入框下方，文件访问与操作审批控件位于发送按钮左侧，与发送、停止按钮保持同一行；选择会保存到设置，并在下一个回合生效。
- 输入框中按 ↑ 回看当前会话已发送的消息，按 ↓ 返回较新的消息，翻到最新之后会恢复未发送的草稿。多行输入仅在首行按 ↑、末行按 ↓ 时翻历史；恢复旧会话后也可回看其中的输入。
- 在输入框键入 `/` 可查看面板支持的命令，用上下方向键选择、Enter 执行、Esc 收起列表。普通消息的 Enter 用于换行，`Ctrl+Enter` 或 `Cmd+Enter` 发送。`/model` 打开 Codex 模型列表，选模型后再选推理强度（Thinking level），选项与默认值以该模型上报的能力为准；两项一起保存并在下一回合生效。“当前 Codex 默认”会保存列表上报的具体模型 ID，已有会话也会切换到该模型。也可输入 `/model 模型ID` 进入该模型的推理强度选择。
- 顶部常驻显示当前模型和 reasoning 等级，包括会话实际使用的 Codex 默认配置；点击可切换模型与推理强度，下一回合生效。执行中保留当前回合的模型信息。顶部还显示 Codex、短目录名（悬停可查看完整路径）、连接图标、**详情**、关闭按钮，以及任务状态、上下文占比、终端控制数量和“转发开/关”。长目录名、长任务状态会截断，状态悬停可查看全文。点击 **详情** 或状态摘要可展开或收起详情。
- 发送被拒绝或回合执行失败时，对话区和输入框上方会显示具体原因。用量/频率超限提示等待恢复，并在已收到额度信息时显示重置时间；上下文和预算超限给出相应处理提示。同步发送失败会恢复输入内容；自动重试期间保留执行状态，收到正常回答后清除输入框上方的错误提示。
- **详情**（也可输入 `/status` 打开）完整显示路径、会话 ID、任务状态、查询时 Codex 上报的模型与运行状态、上下文 token 和会话累计、额度、普通用量是否可用、目标、权限、控制终端列表及自动转发说明，并保留 **刷新** 查询。各项独立读取，部分读取失败时仍显示其他信息。详情高度受限且可滚动，窄侧栏内完整信息自动换行；详情与 `/resume` 历史列表互斥。历史、输出等异常通知仍直接显示。还支持 `/new` 和 `/help`。
- 上下文摘要收到 Codex 的 token 用量通知后显示百分比；未上报时显示“上下文 —”。**详情** 显示最近一次模型请求的用量、上下文窗口大小和会话累计 token；切换会话时会清空旧会话数字，等待新通知。
- 每条新任务会设置一个持久 Goal。Codex 的消息、命令输出和审批请求会实时显示。任务运行中发送新文本会追加到当前回合。
- Codex 的交互提问会在侧栏显示为可点击的选项按钮，支持“其他”自由输入；提交后继续任务。若问题附在流式回复中，插件会暂停当前回合，等用户回答后继续。
- 对话消息可以选中文字并使用系统快捷键复制；每条消息也有“复制”按钮。
- 对话默认自动滚动到最新消息，流式回复和工具输出会持续跟随。上翻查看历史时暂停自动滚动，显示“回到最新消息”按钮；点击按钮或手动滚回底部后恢复跟随。恢复其他会话时直接定位到最新消息。
- 恢复会话时先读取元数据，再按 Codex 的历史模式加载旧消息。若本机 app-server 暂不支持历史分页，侧栏会提示旧消息不可用；已恢复的会话仍可继续对话。
- 从终端点击工具栏图标会绑定该终端作为自动转发源；按游标只把新片段送给 Codex。同目录有多个终端时，恢复后的 AI 面板不会猜测自动转发源，需要从目标终端再次点击工具栏图标。AI 面板可随时在 **详情 → 自动转发** 中点击 **停止自动转发**；之后也可从终端重新绑定。独立的 `tabby_tabs` 工具会监控当前窗口的所有终端标签，以便 Codex 按需读取任意标签；停止自动转发不关闭工具读取能力。
- 新任务启动时最多附带 6,000 字，运行中每批最多 2,000 字、每回合最多 16,000 字，超出部分留给后续回合。缓存只保留已绑定终端最近 32,768 字；缓存溢出时会明确标记截断。`new` 会丢弃旧会话的未发送终端输出。
- Tabby 提供的是终端会话的 PTY 输出流。插件目前无法从普通输出流准确判断一条命令的起止、退出码或输出所属进程；全屏程序、持续日志和交互式命令可能产生大量无关片段。终端输出会作为不可信数据传给 Codex，请在显示敏感信息前停止读取。
- Codex CLI 仍在本机执行工具。SSH、容器或其他远程终端的输出可以供分析，但其工作目录和命令环境不会自动变成 Codex 的执行环境；远程工作需要单独配置可访问的工作区或执行通道。相同本地目录下的不同远程会话也不宜共用一个任务线程。
- 只有回合状态为 `completed`，且 Goal 状态为 `complete`，界面才显示“任务已完成”。Goal 仍为 `active` 时，Codex 可以自动继续；必要时点击“继续当前目标”。失败、被中断、达到预算或等待用户处理均显示未完成。
- 默认沙箱是“工作目录可写”、审批为“按需询问”。审批请求会显示在 AI 标签页；可在设置中调整。`Ctrl+Enter` 发送消息。

Goal 通过证据检查和持续执行降低过早结束的概率，但无法数学保证模型做出的每项工作正确。请根据最终文件、测试和工具输出核对关键结果。

## 开发与验证

运行 `npm test`、`npm run typecheck` 和 `npm run build`。自动测试覆盖显式路径和命令名兼容、PATH 优先级、PATH 无 codex、大小写环境变量、哈希目录缺文件、按文件时间选择、升级后重新扫描、无效显式路径不降级，以及 JSONL 握手、进程重用、流式通知和 stderr。`test/executable.test.js` 在 Linux 上模拟 Windows 定位规则；`test/windows-launch.test.js` 仅在真实 Windows 上执行含空格 exe/cmd/bat 和无 PATH 自动定位管道测试，其他平台明确跳过。exe 夹具使用真正的 Node PE 可执行文件配合测试用 preload；它验证启动方式，不代替真实 Codex 测试。

`test/posix-discovery.test.js` 覆盖 Linux/macOS 定位规则、NVM_DIR、自定义命令及显式路径约定、Shell 启动输出隔离、输出上限、超时及失败后的扫描、查找与启动的 PATH 一致、关闭及切换配置时取消发现；并实际启动 `#!/usr/bin/env node` JSONL 夹具验证桌面 PATH 同时缺少 Codex 和 Node 的情况。在 Linux 执行的 darwin 规则测试不代表 macOS 桌面实测。

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

用户已在 Windows Node v24.13.0 验证无 PATH 的真实 Codex 自动发现、初始化、6 条流式增量、completed 和 marker，以及 cmd/bat 两项测试。显式枚举全部测试的旧结果为 89 通过、2 项夹具失败、1 项 POSIX 跳过；修正后的 exe / auto discovery 夹具和 npm test 入口待 Windows 重跑。本次验证的具体平台、命令和结果见验证包中的 `VALIDATION.md`。

实现依据：[Tabby 插件开发说明](https://github.com/Eugeny/tabby/blob/master/HACKING.md)、[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)及 [Codex Goal 官方说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)。
