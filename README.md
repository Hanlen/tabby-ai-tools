<div align="center">

# Tabby AI Tools

**把 AI 助手放进终端，让上下文留在工作现场。**

在 Tabby 左侧与 AI 对话，读取终端输出、操作标签，并接着上次的任务继续工作。支持 Codex、OpenAI、DeepSeek、GLM 和 Claude。

[![Check](https://github.com/Hanlen/tabby-ai-tools/actions/workflows/check.yml/badge.svg)](https://github.com/Hanlen/tabby-ai-tools/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/tabby-ai-tools?color=8b9cf6&style=flat-square)](https://www.npmjs.com/package/tabby-ai-tools)
[![Tabby plugin](https://img.shields.io/badge/Tabby-plugin-59d9b0?style=flat-square)](https://github.com/Eugeny/tabby)
[![License: MIT](https://img.shields.io/badge/license-MIT-94a3b8?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [功能亮点](#功能亮点) · [使用指南](docs/guide.md) · [开发与验证](docs/development.md)

![Tabby AI Tools 界面示意：左侧 Codex 对话面板，右侧终端与标签，底部展示会话恢复、终端协作和持续目标三项能力](https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/overview.png)

<sub>根据现有面板功能绘制的界面示意，内容为示例；实际外观随 Tabby 主题和窗口尺寸变化。</sub>

</div>

## 为什么放在 Tabby 里？

排查报错时，直接让 Codex 读取终端；切换项目时，回到该目录的会话；需要执行操作时，在同一个窗口里查看输出、回答问题和处理审批。

插件通过本机的 `codex app-server` 工作。每个 Tabby 窗口复用一个后台进程，收起侧栏后仍保留面板与会话，连接异常时自动重连。

也支持直接连接 **DeepSeek、GLM、OpenAI API 和 Claude API**。API 模式由插件管理工具调用与本地历史，无需安装 Codex CLI；现有 Codex 登录方式继续保留。

重复的 Shell 任务可以自动归档为[可复用流程](docs/task-workflows.md)。下一次相似任务在当前工作目录中匹配此前步骤；使用 `/remember` 保存明确的操作偏好，在设置中编辑流程和偏好。归档和匹配不额外调用模型。

也可以在对话中创建[定时 AI 流程](docs/scheduled-tasks.md)：到点后根据终端输出反复判断和执行，并保留每次运行记录。输入 `/schedules` 管理计划和查看结果；运行时自主查找并回答问题，不等待用户。重启自动加载，可在设置 → AI Tools → 定时任务删除；Tabby 需保持打开。

## 快速开始

### 1. 准备环境

- 安装 [Tabby](https://github.com/Eugeny/tabby)。
- 使用 Codex 本机登录模式时，安装 Codex CLI，并在终端执行 `codex login` 完成登录。使用支持 `thread/goal/*` 的 CLI 版本；项目已有 `codex-cli 0.162.1` 的[验证记录](VALIDATION.md)。
- 使用 DeepSeek、GLM、OpenAI API 或 Claude API 时，只需准备对应的 API Key，无需安装 Codex CLI。

### 2. 安装插件

在 Tabby 打开 **Settings → Plugins**，搜索 **`tabby-ai-tools`**（或 `ai-tools`），点击安装，然后**完全退出并重启 Tabby**。

插件通过 [npm](https://www.npmjs.com/package/tabby-ai-tools) 分发。新版本发布后，插件列表可能需要等待搜索索引更新。

<details>
<summary>从源码构建并安装（开发者）</summary>

需要 Node.js 20+：

```bash
git clone https://github.com/Hanlen/tabby-ai-tools.git
cd tabby-ai-tools
npm ci
npm run build
```

在 Tabby 打开 **Settings → Plugins → Open Plugins Directory**，复制打开的目录路径，再执行：

```bash
npm run install:tabby -- "<Tabby 插件目录路径>"
```

将尖括号及其中的文字替换为实际路径，然后**完全退出并重启 Tabby**。安装后在插件设置的「已安装插件」中查看。

</details>

### 3. 开始第一个任务

1. 打开本地终端并进入项目目录。
2. 点击 Tabby 工具栏的机器人图标，打开左侧 Codex 面板。
3. 输入任务，按 **Ctrl+Enter / Cmd+Enter** 发送。

```text
看看当前终端的报错，帮我定位原因并验证修复结果。
```

默认自动查找 `codex`，使用当前本地终端目录和 Codex 默认模型。需要指定 CLI 路径、固定目录或权限时，打开 **Settings → AI Tools**。

> 默认权限为「工作目录可写」与「按需询问」。模型、推理强度和权限也可以在侧栏中调整，下一回合生效。

### 使用商业模型 API

1. 安装插件后，打开 **Settings → AI Tools → 添加 API 连接**。
2. 选择供应商，检查 Base URL。默认使用服务商官方端点，也可填写对应协议的代理地址。
3. 选择密钥来源：默认可**直接输入 API Key**，密钥由插件保存在本地配置中。也可使用 Tabby 进程可读取的环境变量。插件不访问 Vault，旧 Vault 连接需重新选择密钥来源。
4. 聚焦模型 ID 输入框会自动获取当前连接的模型列表，也可点击 **获取模型列表** 刷新，或手动填写完整模型 ID。获取列表无需先填写模型；若端点不提供列表，会显示错误原因并保留手动输入。
5. 将此连接设为默认连接，或在侧栏顶部选择它。修改连接参数后，点击侧栏的连接图标应用修改。侧栏点击模型摘要或输入 `/model` 会自动获取列表，可刷新、选择模型或手动输入 ID；切换时保留当前对话。

| 供应商 | 协议 | 默认密钥环境变量 |
| --- | --- | --- |
| OpenAI API | Responses | `OPENAI_API_KEY` |
| DeepSeek | Chat Completions | `DEEPSEEK_API_KEY` |
| GLM | Chat Completions | `ZAI_API_KEY` |
| Claude | Messages | `ANTHROPIC_API_KEY` |

环境变量修改后需要完全退出并重启 Tabby。GLM 的不同平台或套餐需要使用对应的端点与密钥。点击每个连接下方的 **测试连接** 会发送一条简短模型请求，实际验证鉴权、模型参数与 SSE 流式响应，产生少量 API 用量；进度、成功或错误原因直接显示在按钮下方，支持取消，超时为 60 秒。

DeepSeek 侧栏提供 **Thinking 开关与 Low / High / Max 等级**，与模型摘要共用一行，修改后下一回合生效，无需重连。思考阶段显示已接收字符数，正文收到一个片段就刷新一个片段；如果代理未返回 SSE，会明确提示流式兼容错误。服务商或代理自身集中发送片段时，前端无法提前显示尚未收到的正文。

API 模式可读取和操作 Tabby 终端、执行命令、接收工具结果并继续处理任务。只读模式禁止终端输入和控件操作；可操作模式使用终端账户本身的权限，**不提供 Codex 的 OS 沙箱**。停止会取消模型请求，已发送到终端的命令可能仍在运行。

API 运行中的追加输入在下一次模型请求时处理。**API 连接之间，以及 DeepSeek 等 API 与 Codex 本机登录之间，切换时都保留当前对话上下文**，包括用户消息、模型回复、终端输出、工具调用结果与任务目标；修改端点或模型也会保留。更换接口时将历史转换成通用文本，不传递原供应商的内部推理块，也不会重新执行历史工具。转入 Codex 时先保存上下文和目标，下一次主动发送消息后才开始执行。新连接保留独立的历史快照，原会话仍可恢复；`/new` 可主动开始空白会话。API 模式当前不自动压缩上下文，长任务可新建会话。用量显示上次请求输入与本地累计 tokens，不显示 Codex 订阅额度。完整架构及实施前评审见 [多模型 Agent 设计](docs/multi-provider-agent.md)。

## 功能亮点

| 能力 | 实际使用体验 |
| :--- | :--- |
| **常驻侧栏** | 对话与终端并排显示，拖动边缘调整宽度，收起再打开继续使用。 |
| **按目录恢复会话** | 每个工作目录保存线程，重启后恢复上下文；`/resume` 可找回该目录的历史会话。 |
| **访问标签与分屏** | Codex 可列出标签、读取终端屏幕与滚屏、切换标签、向运行中的终端发送输入，也可读取普通标签的文本与控件。 |
| **Tabby 能力 skill** | 插件内置操作知识，供 Codex 和所有 API 模型共用；可发现连接配置档、设置页、快捷键和插件命令，管理连接、标签与分屏。 |
| **终端输出自动转发** | 从目标终端打开侧栏即可绑定，只转发新增输出；可在「详情」中停止。 |
| **持续任务目标** | 每条新任务设置持久 Goal，跟踪完成状态；目标仍在进行时可以继续执行。 |
| **流式交互** | 实时显示回复、工具输出、提问选项与审批请求；执行中可追加指令。 |
| **模型与用量可见** | 切换模型及推理强度，在「详情」中查看上下文、额度、目标与权限。 |
| **终端控制可取回** | AI 执行命令时暂时锁定对应终端输入；点击「释放」即可取回输入权。 |

## 常用操作

| 命令或快捷键 | 用途 |
| :--- | :--- |
| `/` | 打开命令列表，使用 ↑ / ↓ 选择、Enter 执行、Esc 关闭。 |
| `/new` 或 `new` | 创建新线程，旧会话保留。 |
| `/resume` | 浏览并恢复当前目录下由插件创建的会话。 |
| `/model` | 选择模型，再选择推理强度；也支持 `/model 模型ID`。 |
| `/status` | 展开状态详情。 |
| `/help` | 查看面板帮助。 |
| Ctrl+Enter / Cmd+Enter | 发送消息；普通 Enter 换行。 |
| ↑ / ↓ | 回看当前会话的已发送消息；多行输入需位于首行 / 末行。 |

上翻消息会暂停自动滚动，点击「回到最新消息」恢复跟随。执行中的任务可以用输入框旁的「停止」按钮中断。

## 使用前了解这些边界

- **执行环境在本机。** SSH 或容器终端的输出可以用于分析，但不会自动改变 Codex 的工作目录与命令执行环境。
- **Tabby 操作以实际安装能力为准。** AI 可通过 `get_capabilities` 发现能力，使用配置档、分屏、设置和命令工具操作 Tabby。SFTP、隧道及第三方功能通过已注册的上下文命令或设置控件访问；没有暴露操作入口的功能仍需补充适配，原生弹窗可能需要用户交互。
- **终端读取与自动转发分别工作。** 停止自动转发后，Codex 仍能通过 `tabby_tabs` 按需读取标签；展示敏感信息前应停止相应读取。
- **已有任务需要确认后再接管。** 检测到终端已有进程时会先判断是否仍需保留；状态不明时会请求用户确认，必要时确认中断后才发送新命令。
- **完成状态取决于回合与 Goal。** 只有回合为 `completed` 且 Goal 为 `complete` 才显示「任务已完成」；关键结果仍需结合文件、测试与输出核对。

跨平台测试的覆盖范围与尚未验证项见 [验证记录](VALIDATION.md)。

## 文档与排查

Tabby skill 随 npm 包和本地安装一起分发，无需另外安装。仓库的每周同步任务在北京时间周一 09:00 检查 [Tabby 官方仓库](https://github.com/Eugeny/tabby)，更新固定提交的能力资料并创建更新 PR；合并、发布并升级插件后进入已安装版本。运行时的配置档、命令和设置页则按需实时发现。同步不会自动安装上游代码，也不会让尚未适配的 API 自动变成工具。维护方式见[开发文档](docs/development.md#tabby-能力-skill-与每周同步)。

| 你想了解 | 从这里开始 |
| :--- | :--- |
| 目录、会话、模型、终端控制和自动转发 | [详细使用指南](docs/guide.md) |
| 找不到 CLI、桌面 PATH、NVM、Windows 启动路径 | [CLI 自动发现与启动排查](docs/guide.md#cli-自动发现与启动排查) |
| 构建、测试、真实 Codex 烟测及 Windows 验证 | [开发与验证](docs/development.md) |
| 已有实测结果与平台限制 | [VALIDATION.md](VALIDATION.md) |
| 反馈问题或提出改进建议 | [GitHub Issues](https://github.com/Hanlen/tabby-ai-tools/issues) |

## 参与开发

欢迎提交 Issue 和 Pull Request。提交代码前，在项目目录执行：

```bash
npm run typecheck
npm test
npm run build
```

真实模型烟测为可选操作，会使用本机已有登录并可能消耗额度，详见[开发文档](docs/development.md)。

## 致谢与许可

基于 [Tabby](https://github.com/Eugeny/tabby) 的插件能力与 Codex App Server 构建。

[MIT](LICENSE) © 2026 Tabby Codex AI contributors
