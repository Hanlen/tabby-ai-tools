<div align="center">

<h1>Tabby AI Tools</h1>
<p>An AI sidebar for local and SSH terminals, from a single command to a multi-server workflow.</p>

[![Latest release](https://img.shields.io/github/v/release/Hanlen/tabby-ai-tools?style=flat-square)](https://github.com/Hanlen/tabby-ai-tools/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5b5bf7?style=flat-square)](#quick-start)
[![License](https://img.shields.io/github/license/Hanlen/tabby-ai-tools?style=flat-square)](LICENSE)

[Features](#features) · [Demos](#demos) · [Quick start](#quick-start) · [Model connections](#model-connections) · [User guide](docs/guide.md) · [Release notes](https://github.com/Hanlen/tabby-ai-tools/releases) · [简体中文](README.zh-CN.md)

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.png">
  <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.gif" alt="A small robot coordinating work across terminals" width="176" height="88">
</picture>

</div>

## Features

- **Run commands in local and SSH terminals.** Work in one tab or across multiple tabs and split panes. The assistant reads output, runs commands in the selected terminal, and uses the results to decide the next step. [Multi-terminal tasks](docs/guide.md#任务编排与多服务器协作)
- **Interact with running programs.** Send text and keystrokes to supported foreground programs, including a terminal-based AI agent. Choose read-only access or an approval policy, stop the AI turn, or release terminal input. [Terminal controls](docs/guide.md#标签访问与终端控制)
- **Transfer files using a connected SSH session.** Paste or drag files and screenshots into the sidebar to upload them, or ask the assistant to download a remote file. The target tab shows progress, and the plugin verifies the transfer with SHA-256. [File transfers](docs/attachments.md)
- **Record and reuse workflows.** Start with `/remember` to record commands and verification steps, then run the saved workflow with an alias such as `/check-app`. Workflows can use checks and AI decisions. [Workflows](docs/task-workflows.md)
- **Schedule AI tasks.** Describe what to check, when to run it, and what to do if the check fails. Set up a one-time, interval, or daily task, then use `/schedules` to see results or pause it. Tasks run while Tabby is open. [Scheduled tasks](docs/scheduled-tasks.md)
- **Review and resume work.** Expand tool calls to see what ran, use `/resume` to reopen a conversation for the current directory, and optionally save searchable terminal logs for tasks. [Session history](docs/guide.md#工作目录与线程) · [Task logs](docs/terminal-logs.md)
- **Connect external AI clients over MCP.** Enable the local MCP service in AI Tools settings so a compatible client can read terminal output and send input to Tabby. [MCP setup](docs/mcp.md)

## Demos

### Run a command in an SSH terminal

Open an SSH tab in Tabby, then open **AI Tools**. Send a request like this, using the name of your SSH tab. Approve the operation if prompted.

> In the `staging` SSH tab, run `pwd` and show the result.

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/ssh-command-demo.png">
  <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/ssh-command-demo.gif" alt="The user asks AI Tools to run ./check-health in the staging SSH tab. The command runs in the SSH shell, which returns HTTP 200. The sidebar reports the verified result." width="1080">
</picture>

*In this recording, a local test backend runs `./check-health` through a real Tabby SSH connection to a loopback test server. AI Tools reads the shell output and reports HTTP 200.*

<details>
<summary>Another example · Two-way file handoff between tabs</summary>

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/two-terminal-demo.png">
  <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/two-terminal-demo.gif" alt="In Tabby, the assistant copies brief.md from Tab 1 to Tab 2, then copies checks.txt from Tab 2 to Tab 1 and verifies both." width="1100">
</picture>

*A six-second example recorded in Tabby with a local test backend. The assistant copies `brief.md` from Tab 1 to Tab 2, copies `checks.txt` back, and verifies both files.*

</details>

## Quick start

1. In [Tabby](https://github.com/Eugeny/tabby), open **Settings → Plugins**, install `tabby-ai-tools`, and restart Tabby.
2. Open **AI Tools** from the robot icon. Choose a connection or add one under **Settings → AI Tools → Connections and models**.
3. Open the terminals you want to use. Describe the task in the sidebar and send with **Ctrl+Enter** or **Cmd+Enter**.

## Model connections

Switch connections in the sidebar. Use `/model` to select a model and its supported reasoning level.

| Connection | Setup |
| --- | --- |
| **ChatGPT via Codex CLI** | Install Codex CLI, run `codex login` with a ChatGPT account that has Codex access, and select **Codex (local login)**. This mode uses your ChatGPT entitlement. [Codex sign-in](https://learn.chatgpt.com/docs/auth#codex-cli) |
| **Claude Code local login** | Install Claude Code. For a private session space, generate its login command in AI Tools, run it in a local terminal, then check and reconnect. [Claude Code setup](docs/claude-code.md) |
| **OpenAI, DeepSeek, GLM, or Claude API** | Add the provider in AI Tools and enter its API key and model ID. |
| **Kimi, Alibaba Cloud Coding Plan, or a custom endpoint** | Choose a provider preset or configure an endpoint and model. [Coding plans](docs/coding-plans.md) · [Pi and custom connections](docs/pi.md) |

[Development](docs/development.md)
