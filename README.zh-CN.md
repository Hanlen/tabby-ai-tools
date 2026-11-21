<div align="center">

<h1>Tabby AI Tools</h1>
<p>用一个 AI 侧栏协作操作你已打开的终端。</p>

[![最新版本](https://img.shields.io/github/v/release/Hanlen/tabby-ai-tools?style=flat-square)](https://github.com/Hanlen/tabby-ai-tools/releases/latest)
[![支持平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5b5bf7?style=flat-square)](#快速开始)
[![许可证](https://img.shields.io/github/license/Hanlen/tabby-ai-tools?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [模型连接](#模型连接) · [使用指南](docs/guide.md) · [发布说明](https://github.com/Hanlen/tabby-ai-tools/releases) · [English](README.md)

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.png">
  <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.gif" alt="小机器人正在协调多个终端的工作" width="176" height="88">
</picture>

</div>

## 两个终端，一个任务

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/two-terminal-demo.png">
  <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/two-terminal-demo.gif" alt="Tabby 侧栏将 brief.md 从终端 1 复制到终端 2，再将 checks.txt 从终端 2 复制回终端 1，并验证两份副本。" width="1100">
</picture>

*使用本地测试后端在 Tabby 实录。两个终端实际执行命令，复制并校验示例文件。*

- 在一次对话中读取多个本地或 SSH 终端的输出，并在指定终端执行命令。
- 复用已有 SSH 连接传输文件。重复任务可以保存为工作流，也可以在 Tabby 打开期间定时运行。
- 通过 [MCP](docs/mcp.md) 将 Tabby 的终端工具开放给外部 AI 客户端。

## 快速开始

1. 在 [Tabby](https://github.com/Eugeny/tabby) 打开 **设置 → 插件**，安装 `tabby-ai-tools` 后重启。
2. 点击机器人图标打开 **AI Tools**。选择已有连接，或在 **设置 → AI Tools → 连接与模型** 中添加。
3. 打开需要使用的终端，在侧栏描述任务，按 **Ctrl+Enter** 或 **Cmd+Enter** 发送。

## 模型连接

| 连接方式 | 配置 |
| --- | --- |
| **ChatGPT 订阅 → Codex CLI** | 安装 Codex CLI，运行 `codex login`，用有 Codex 权限的 ChatGPT 账号登录，然后选择 **Codex（本机登录）**。此模式使用 ChatGPT 账号权益。 [Codex 登录说明](https://learn.chatgpt.com/docs/auth#codex-cli) |
| **Claude Code 本机登录** | 安装 Claude Code。使用独立会话空间时，在 AI Tools 生成该空间的登录命令，在本地终端完成登录，再检查并重连。 [Claude Code 配置](docs/claude-code.md) |
| **OpenAI、DeepSeek、GLM、Claude API** | 在 AI Tools 添加对应供应商，填写 API Key 和模型 ID。 |
| **Kimi、阿里云 Coding Plan 或自定义服务** | 选择供应商预设，或填写自定义服务地址和模型。 [Coding Plan 配置](docs/coding-plans.md) · [Pi 和自定义连接](docs/pi.md) |

[工作流](docs/task-workflows.md) · [定时任务](docs/scheduled-tasks.md) · [开发说明](docs/development.md)
