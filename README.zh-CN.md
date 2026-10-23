# Tabby AI Tools

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/v0.2.1/docs/assets/robot-multitask.png">
    <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/v0.2.1/docs/assets/robot-multitask.gif" alt="萌萌的小机器人敲着键盘，同时协调多个终端窗口中的任务" width="640" height="320">
  </picture>
</p>

**让 AI 通过你的终端，协助完成本机与多台服务器上的任务。**

[English](README.md) · **简体中文** · [完整配置与使用指南](docs/guide.md)

Tabby AI Tools 是集成在 [Tabby](https://github.com/Eugeny/tabby) 中的 AI 助手插件。它可以读取终端输出、发送命令，并根据执行结果继续分析和操作。你在侧栏描述目标，在终端查看过程，也可以随时取回输入控制。

![Tabby AI Tools 0.2.1 界面示意：侧栏协调两个 SSH 终端，展示定时任务、API 连接、启动开关与语言设置](https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/v0.2.1/docs/assets/overview.png)

<sub>根据当前功能绘制的英文界面示意，任务和连接均为示例；实际外观随 Tabby 主题与窗口尺寸变化。</sub>

## 多模型适配，支持本机 ChatGPT 订阅登录

**已有具备 Codex 使用权限的 ChatGPT 订阅账号，可以通过本机 Codex CLI 登录直接使用，无需为此模式额外配置 API Key。** 插件复用本机 Codex 登录，可用模型、用量限制和工作区权限以账号实际权益为准。参见 [OpenAI 官方认证说明](https://learn.chatgpt.com/docs/auth)。

| 连接方式 | 如何使用 |
| --- | --- |
| **ChatGPT 订阅 → 本机 Codex** | 本机安装 Codex CLI，执行 `codex login`，在插件中选择 **Codex（本机登录）**。 |
| **OpenAI API** | 添加 OpenAI 连接，配置 API Key、Base URL 和模型 ID。 |
| **DeepSeek** | 添加 DeepSeek API 连接，选择模型与 Thinking 设置。 |
| **GLM／智谱** | 添加 GLM API 连接，使用账号对应套餐的端点和模型。 |
| **Claude／Anthropic** | 添加 Claude API 连接，配置其 API Key 和模型 ID。 |

可保存多个命名连接，在侧栏切换；支持获取模型列表或手动填写模型 ID。API 连接使用对应供应商的 API 凭据和计费，无需安装 Codex CLI。使用代理时，端点须兼容所选供应商协议。

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

3. 在 **Settings → AI Tools** 将默认连接设为 **Codex（本机登录）**。打开侧栏后选择账号可用的模型，或沿用 Codex 默认模型。

只需在本机安装和登录 Codex，即可沿用 Tabby 已连接的 SSH 终端协助操作服务器；服务器无需逐台登录 ChatGPT 或安装 AI Agent。

## 用自然语言编排任务

把目标、执行顺序、条件和验证要求一次说清，AI 就可以根据终端反馈推进跨服务器、多步骤任务。例如：

> 在 staging-app 和 staging-db 上检查应用与数据库连接。先确认数据库正常，再检查应用配置；发现问题先说明原因，在我授权后修复，最后验证应用健康检查。

支持按执行结果决定下一步，也可以操作终端中的其他交互式 Agent。成功完成的终端任务可归档为可复用流程，下次相似任务参考已有步骤，并结合当前环境重新核对。[查看编排与复用方法](docs/guide.md#任务编排与多服务器协作)。

## 定时任务：到点检查、判断、执行与验证

在对话中创建单次、固定间隔或指定时区的每日任务。例如：

> 每天北京时间 9 点检查 production 配置对应服务器的服务健康状态。异常时分析日志，在授权范围内尝试修复，最多三次；每次操作后重新检查，最后记录结果。

通过 `/schedules` 查看计划和执行记录、暂停或恢复、立即运行及停止；在设置中删除任务。任务重启后自动加载，**仅在 Tabby 保持打开时执行**。无人值守运行遇到需要额外授权或秘密信息的情况会停止留档。[查看定时任务用法](docs/scheduled-tasks.md)。

## 安装与开始使用

1. 在 Tabby 的 **Settings → Plugins** 搜索并安装 **`tabby-ai-tools`**，完全退出并重启 Tabby。
2. 使用本机 Codex 登录，或在 **Settings → AI Tools** 添加 API 连接。
3. 打开目标终端，点击工具栏机器人图标，输入任务，按 **Ctrl+Enter / Cmd+Enter** 发送。

**[完整配置与使用指南 →](docs/guide.md)** 包含环境准备、源码安装、连接与模型配置、权限、sudo、任务编排、全部操作入口和常见问题。

插件自带一个供模型使用的 [Tabby skill](skills/tabby/SKILL.md)，保留全部功能入口。构建时自动内嵌，随插件安装并提供给 Codex 和 API 模型，无需另行安装。

[开发与验证](docs/development.md) · [验证范围](VALIDATION.md) · [问题反馈](https://github.com/Hanlen/tabby-ai-tools/issues) · [MIT](LICENSE)
