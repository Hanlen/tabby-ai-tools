<div align="center">

  <h1>Tabby AI Tools</h1>
  <p>让 AI 通过你的终端，协助完成本机与多台服务器上的任务。</p>

[![最新版本](https://img.shields.io/github/v/release/Hanlen/tabby-ai-tools?style=flat-square)](https://github.com/Hanlen/tabby-ai-tools/releases/latest)
[![支持平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5b5bf7?style=flat-square)](#安装与开始使用)
[![许可证](https://img.shields.io/github/license/Hanlen/tabby-ai-tools?style=flat-square)](LICENSE)

[下载](https://github.com/Hanlen/tabby-ai-tools/releases/latest) · [快速开始](#安装与开始使用) · [模型适配](#多模型适配支持本机-chatgpt-订阅登录) · [使用指南](docs/guide.md) · [English](README.md)

<br>

  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.png">
    <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.gif" alt="萌萌的小机器人敲着键盘，同时协调多个终端窗口中的任务" width="560" height="280">
  </picture>

</div>

<br>

Tabby AI Tools 是集成在 [Tabby](https://github.com/Eugeny/tabby) 中的 AI 助手插件。它可以读取终端输出、发送命令，并根据执行结果继续分析和操作。你在侧栏描述目标，在终端查看过程，也可以随时取回输入控制。

![Tabby AI Tools v0.5.3 界面示意（含已打包的可选 Pi 运行时与上下文压缩）：侧栏协调两个 SSH 终端，展示流程录制验收与已保存的 /pm1 别名、按需读屏、定时任务、Pi 内置运行时与压缩设置、连接列表、启动与语言设置，含自定义 OpenAI 兼容接口设置](https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/overview.png)

<sub>根据当前功能绘制的英文界面示意，任务和连接均为示例；实际外观随 Tabby 主题与窗口尺寸变化。</sub>

终端接管自动完成：前台进程检测不可用（包括 SSH）时不再要求点击确认。AI 先读取终端输出，保留当前任务需要的进程，并可自动中断已检测到的无关任务。

终端输出由 AI 使用 `read_tab` 按需读取，不再自动追加到运行中的回合。后台重试期间，侧栏持续显示等待状态和已等待时长；后台提供重试时间时才显示下次重试时间及倒计时。停止取消 AI 回合，终端命令可能已经完成；继续前先核对实际终端和流程验收点，避免重复执行。详见[流程恢复](docs/task-workflows.md#限流中断与恢复)。

**v0.5.0 新增：** API 连接可选 Pi SDK 运行时，支持 `/compact`、流程归档状态查询与对话设置别名；自动压缩默认关闭。在连接设置的“Agent 运行时”中选择 Pi SDK；[配置、恢复与验证范围](docs/pi.md)见说明。

**v0.5.1 安装修复：** Pi SDK 已打包进插件。通过 Tabby 安装或升级时，不再安装 Pi 的依赖链，也不要求系统中能找到 `node` 命令；Pi 也默认复用 Tabby 自带 Node，通过 Electron 独立进程运行；兼容版本的 Tabby 无需额外安装 Node，仅保留可选的 Node 22.19+ 兼容路径。

## 多模型适配，支持本机 ChatGPT 订阅登录

**已有具备 Codex 使用权限的 ChatGPT 订阅账号，可以通过本机 Codex CLI 登录直接使用，无需为此模式额外配置 API Key。** 插件复用本机 Codex 登录，可用模型、用量限制和工作区权限以账号实际权益为准。参见 [OpenAI 官方认证说明](https://learn.chatgpt.com/docs/auth)。

| 连接方式 | 如何使用 |
| --- | --- |
| **ChatGPT 订阅 → 本机 Codex** | 本机安装 Codex CLI，执行 `codex login`，在插件中选择 **Codex（本机登录）**。 |
| **Claude 订阅 → 本机 Claude Code** | 安装官方 CLI，执行 `claude auth login`，确认 `claude auth status`，在侧栏选择 **Claude Code（本机登录）**。 |
| **OpenAI API** | 添加 OpenAI 连接，配置 API Key、Base URL 和模型 ID。 |
| **DeepSeek** | 添加 DeepSeek API 连接，选择模型与 Thinking 设置。 |
| **GLM／智谱** | 添加 GLM API 连接，使用账号对应套餐的端点和模型。 |
| **Kimi API** | 选择 **Kimi API** 和中国内地／国际区域，使用开放平台 Key，按量计费。 |
| **Kimi Coding Plan** | 选择 **Kimi Coding Plan** 和服务区域，使用 Kimi Code 会员套餐 Key。 |
| **阿里云百炼 Coding Plan** | 选择专用的 Coding Plan 供应商和区域，使用套餐 Key（`sk-sp-`）。 |
| **Claude／Anthropic** | 添加 Claude API 连接，配置其 API Key 和模型 ID。 |
| **自定义 OpenAI 兼容服务** | 选择 **自定义（OpenAI 兼容）**，填写 Base URL 和模型 ID；协议默认 Chat Completions，也可选 Responses。支持直接输入密钥、环境变量或无需密钥。 |

**v0.4.1 已支持 Claude Code 订阅接入。** 插件运行本机官方 CLI，不读取或保存订阅凭据；账号权益、额度和实际认证方式由 CLI 决定。已有 API Key 或云平台配置可能走独立计费。安装与限制见 [Claude Code 接入说明](docs/claude-code.md)。尚未完成真实订阅账号的端到端验证。

v0.4.1 已支持 Kimi 与阿里云百炼 Coding Plan 接入，均提供国内与国际端点预设。详见[端点、密钥与配置说明](docs/coding-plans.md)。套餐用于个人交互式编程，无人值守定时任务应使用适合该场景的普通 API。真实套餐准入和扣费尚未验证。

侧栏模型浮窗统一先选模型，再选 reasoning／推理强度，适用于 API 连接和 Claude Code；可选服务商默认或手动填写等级。API 与 Claude Code 的未完成目标默认自动继续，无需点击 Continue；停止、token 预算及主动设置的工具轮数上限仍然生效。

可保存多个命名连接，在侧栏切换；支持获取模型列表或手动填写模型 ID。API 连接使用对应供应商的 API 凭据和计费，无需安装 Codex CLI。使用代理时，端点须兼容所选供应商协议。

v0.4.1 已支持自定义连接。Base URL 示例为 `https://gateway.example/v1` 或 `http://localhost:1234/v1`，不要附加 `/chat/completions` 或 `/responses`。终端任务要求 SSE 流式响应和工具调用；使用 `/models` 获取模型，不支持时可手动填写。HTTP 仅限本地回环地址。详见[自定义接口配置与限制](docs/guide.md#自定义-openai-兼容接口)。

## 内网服务器，也能使用 AI

服务器无法访问外网时，只要你的电脑能连接 AI 服务，同时能通过 Tabby 连接服务器，就可以让 AI 通过 SSH 终端读取日志、排查问题、执行命令并验证结果。服务器无需访问模型服务，也无需安装 AI Agent；用于分析的终端内容由本机发送给所选模型服务。

## 多台服务器协同，无需逐台部署 Agent

沿用 Tabby 的连接和登录账户，让 AI 在不同服务器的标签页、分屏之间读取状态、执行操作、核对结果。无需在每台服务器上安装 Agent、配置模型或单独管理一套 Agent 登录凭据。

## sudo 密码由你输入，临时认证后继续

需要管理员权限时，先在目标服务器的同一终端中手动执行 `sudo ls` 或 `sudo -v` 并输入密码，再让 AI 继续。无需将 sudo 密码交给模型；认证的有效期与复用范围遵循服务器的 sudo 配置。

## ChatGPT 订阅用户如何开始

1. 在运行 Tabby 的本机安装 [Codex CLI](https://learn.chatgpt.com/docs/cli)。
2. 执行以下命令，在浏览器登录 ChatGPT 账号，并确认 CLI 已登录：

   ```bash
   codex login
   codex login status
   ```

3. 启动 Tabby 后 AI Tools 会自动打开，默认使用 **Codex（本机登录）**，无需先进入设置。直接在侧栏选择账号可用的模型，或沿用 Codex 默认模型。

只需在本机安装和登录 Codex，即可沿用 Tabby 已连接的 SSH 终端协助操作服务器；服务器无需逐台登录 ChatGPT 或安装 AI Agent。

自动查找覆盖 standalone 安装（含 `CODEX_INSTALL_DIR` 和 `CODEX_HOME/packages/standalone/current/bin`）、Homebrew/npm 全局 prefix，并以 VS Code 扩展中的兼容 Codex 作为最后兜底。macOS 检查 `/Applications` 和 `~/Applications` 下的 `ChatGPT.app/Contents/Resources/codex-cli/bin/codex` 及旧 `Contents/Resources/codex` 入口，也兼容原 `Codex.app` 名称。其他位置可在 **Settings → AI Tools → Codex CLI 可执行文件** 中填写完整路径。[查看完整发现矩阵](docs/guide.md#cli-自动发现与启动排查)。

## 用自然语言编排任务

把目标、执行顺序、条件和验证要求一次说清，AI 就可以根据终端反馈推进跨服务器、多步骤任务。例如：

> 在 staging-app 和 staging-db 上检查应用与数据库连接。先确认数据库正常，再检查应用配置；发现问题先说明原因，在我授权后修复，最后验证应用健康检查。

支持按执行结果决定下一步，也可以操作终端中的其他交互式 Agent。用 `/remember 任务描述` 开始录制，任务成功结束后可在侧栏或直接告诉助手设置别名（如 `task1`），下次发送 `/task1` 即执行该流程，并重新核对当前环境。各步骤保存服务器 IP、持久连接／服务器 ID、操作路径及验收条件；多服务器按顺序执行，前一步通过结果验收后才放行下一步。助手可用 `workflow_status` / `workflow_set_alias` 查询录制、归档状态并保存别名；checkpoint 成功不等于归档成功，无法归档时显示原因。普通任务不录制，也不能事后补存。含 sudo 的流程会提前提示在各执行终端运行 `sudo -v` 或 `sudo ls`，任务期间保持认证有效。[查看编排与复用方法](docs/guide.md#任务编排与多服务器协作)。

## 定时任务：到点检查、判断、执行与验证

在对话中创建单次、固定间隔或指定时区的每日任务。例如：

> 每天北京时间 9 点检查 production 配置对应服务器的服务健康状态。异常时分析日志，在授权范围内尝试修复，最多三次；每次操作后重新检查，最后记录结果。

通过 `/schedules` 查看计划和执行记录、暂停或恢复、立即运行及停止；在设置中删除任务。任务重启后自动加载，**仅在 Tabby 保持打开时执行**。无人值守运行遇到需要额外授权或秘密信息的情况会停止留档。[查看定时任务用法](docs/scheduled-tasks.md)。

## 安装与开始使用

1. 在 Tabby 的 **Settings → Plugins** 搜索并安装 **`tabby-ai-tools`**，完成后点击设置页的重启提示（**Restart the app to apply changes**）；安装和升级均在重启后生效。
2. 使用本机 Codex 登录，或在 **Settings → AI Tools** 添加 API 连接。
3. 重启后 AI Tools 会默认自动打开。打开目标终端，在侧栏输入任务，按 **Ctrl+Enter / Cmd+Enter** 发送。收起后可点击工具栏机器人图标重新打开；如需关闭自动打开，在 **Settings → AI Tools** 取消勾选 **启动 Tabby 时自动打开 AI Tools**。已明确关闭的配置会保留。

**[完整配置与使用指南 →](docs/guide.md)** 包含环境准备、源码安装、连接与模型配置、权限、sudo、任务编排、全部操作入口和常见问题。

插件自带一个供模型使用的 [Tabby skill](skills/tabby/SKILL.md)，保留全部功能入口。构建时自动内嵌，随插件安装并提供给 Codex 和 API 模型，无需另行安装。

[开发与验证](docs/development.md) · [验证范围](VALIDATION.md) · [问题反馈](https://github.com/Hanlen/tabby-ai-tools/issues) · [MIT](LICENSE)
