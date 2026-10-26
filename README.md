<div align="center">

  <h1>Tabby AI Tools</h1>
  <p>Let AI work through your terminal, across your computer and multiple servers.</p>

[![Latest release](https://img.shields.io/github/v/release/Hanlen/tabby-ai-tools?style=flat-square)](https://github.com/Hanlen/tabby-ai-tools/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5b5bf7?style=flat-square)](#install-and-start)
[![License](https://img.shields.io/github/license/Hanlen/tabby-ai-tools?style=flat-square)](LICENSE)

[Download](https://github.com/Hanlen/tabby-ai-tools/releases/latest) · [Quick start](#install-and-start) · [Models](#multiple-model-providers-including-your-chatgpt-subscription) · [User guide](docs/guide.md) · [简体中文](README.zh-CN.md)

<br>

  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.png">
    <img src="https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/robot-multitask.gif" alt="A cheerful little robot typing while coordinating tasks across multiple terminal windows" width="560" height="280">
  </picture>

</div>

<br>

Tabby AI Tools is an AI assistant inside [Tabby](https://github.com/Eugeny/tabby). It reads terminal output, sends commands, and uses the results to decide what to do next. Describe your goal in the sidebar, follow the work in your terminals, and reclaim terminal input whenever needed.

![Tabby AI Tools v0.4.1 interface illustration: the assistant coordinates two SSH terminals, with retry waiting, on-demand terminal reads, scheduled tasks, custom OpenAI-compatible and Coding Plan connections, automatic startup and language settings](https://raw.githubusercontent.com/Hanlen/tabby-ai-tools/main/docs/assets/overview.png)

<sub>Interface illustration with example tasks and connections; appearance varies with your Tabby theme and window size.</sub>

Terminal takeover is automatic: unavailable foreground-process detection (including SSH) does not require a confirmation click. The agent inspects terminal output, preserves needed tasks, and can interrupt detected unrelated tasks.

Terminal output is read on demand with `read_tab`; it is no longer automatically forwarded into an active turn. During backend retries, the sidebar keeps a visible waiting state with elapsed time, and shows the next retry time plus a countdown only if the backend supplies it. Stop cancels the AI turn; check the terminal and workflow checkpoint before continuing, since commands may already have completed. See [workflow recovery](docs/task-workflows.md#限流中断与恢复).

## Multiple model providers, including your ChatGPT subscription

**Have a ChatGPT subscription with Codex access? Use your existing account through Codex CLI on your own computer, with no separate API key for this mode.** The plugin reuses the local Codex login. Model availability and usage limits follow your account and workspace permissions. See [OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth).

| Connection | How to use it |
| --- | --- |
| **ChatGPT subscription → local Codex** | Install Codex CLI locally, run `codex login`, and select **Codex (local login)** in AI Tools. |
| **Claude subscription → local Claude Code** | Install the official CLI, run `claude auth login`, check `claude auth status`, and select **Claude Code (local login)**. |
| **OpenAI API** | Add an OpenAI connection with an API key, Base URL, and model ID. |
| **DeepSeek** | Add a DeepSeek API connection and choose the model and Thinking settings. |
| **GLM / Zhipu** | Add a GLM API connection using the endpoint and model available to your account. |
| **Kimi API** | Select **Kimi API**, choose China mainland or International, and use an open-platform key. |
| **Kimi Coding Plan** | Select **Kimi Coding Plan**, choose the region, and use a Kimi Code membership key. |
| **Alibaba Cloud Coding Plan** | Select the dedicated Coding Plan provider and region, then use its plan key (`sk-sp-`). |
| **Claude / Anthropic** | Add a Claude API connection with its API key and model ID. |
| **Custom OpenAI-compatible service** | Select **Custom (OpenAI compatible)**, enter a Base URL and model ID, and choose Chat Completions (default) or Responses. Use a direct key, an environment variable, or no key for services without authentication. |

**Claude Code subscription support is available in v0.4.1.** The plugin runs the local official CLI without reading or saving subscription credentials. Entitlements, limits, and authentication follow the CLI; API keys or cloud configuration may use separate billing. See [setup and limitations](docs/claude-code.md). A real subscription end-to-end run remains unverified.

Kimi and Alibaba Cloud Coding Plan connections are available in v0.4.1, with separate China mainland and international presets. See [endpoints, keys and setup](docs/coding-plans.md). Plans are for personal interactive coding; use an appropriate ordinary API for unattended schedules. Real plan access and quota deduction remain unverified.

Choose a model, then choose reasoning effort in the sidebar model picker, including for API connections and Claude Code. Provider defaults and manual effort values are available. API and Claude Code goals continue automatically by default without asking you to click Continue; stop controls, token budgets, and explicitly configured tool limits still apply.

Save multiple named connections and switch them in the sidebar. Discover available models or enter a model ID manually. API connections use the selected provider's credentials and billing plan; they can be used without Codex CLI. Compatible proxies must implement the selected provider's protocol.

Custom connections are available in v0.4.1. For example, use `https://gateway.example/v1` or `http://localhost:1234/v1` as the Base URL, without `/chat/completions` or `/responses`. Terminal tasks require SSE streaming and function calling; model discovery uses `/models` with manual entry as a fallback. HTTP is restricted to loopback addresses. See [custom connection setup and limitations (中文)](docs/guide.md#自定义-openai-兼容接口).

## Work with servers on a private network

Your servers do not need internet access. If your computer can reach the AI service and connect to the servers through Tabby, the assistant can use their SSH terminals to inspect logs, troubleshoot, run commands, and verify results. No server-side AI Agent is required. Terminal content needed for analysis is sent from your computer to your selected model service.

## Coordinate servers without installing an Agent on each one

Use Tabby's connections and signed-in accounts to inspect and operate different servers through tabs and split panes. There is no need to install an Agent, configure a model, or manage separate Agent login credentials on every server.

## Enter sudo passwords yourself, then continue

When elevated access is needed, manually run `sudo ls` or `sudo -v` in the same terminal on the target server and enter your password there. Let the assistant continue afterward without sharing the password with the model. Authentication reuse and expiry follow the server's sudo configuration.

## Start with your local ChatGPT subscription login

1. Install [Codex CLI](https://learn.chatgpt.com/docs/cli) on the computer running Tabby.
2. Run the following commands, sign in with your ChatGPT account in the browser, and confirm that the CLI is logged in:

   ```bash
   codex login
   codex login status
   ```

3. AI Tools opens automatically when Tabby starts, using **Codex (local login)** by default. Choose a model available to your account in the sidebar, or use the Codex default. No settings change is required.

Only your computer needs this Codex installation and login. The assistant can then use your existing Tabby SSH terminals to work on servers; those servers do not need their own ChatGPT login or AI Agent installation.

Automatic discovery covers standalone installations (including `CODEX_INSTALL_DIR` and `CODEX_HOME/packages/standalone/current/bin`), Homebrew and npm global prefixes, and compatible Codex binaries in VS Code extensions as a final fallback. On macOS, it checks `ChatGPT.app/Contents/Resources/codex-cli/bin/codex` and the older `Contents/Resources/codex` entry under `/Applications` and `~/Applications`, including the former `Codex.app` name. For other locations, set the full path in **Settings → AI Tools → Codex CLI executable**. See the [discovery matrix (中文)](docs/guide.md#cli-自动发现与启动排查).

## Orchestrate tasks in natural language

Describe the targets, order, conditions, and verification criteria. The assistant can work through multiple servers and steps, using terminal feedback to guide each action. For example:

> Check application-to-database connectivity on staging-app and staging-db. Verify the database first, then inspect the application configuration. Explain any issue before asking me to authorize a fix, and verify the application health check afterward.

Workflows can branch based on observed results and interact with other terminal Agents. Start a recording with `/remember TASK`. After successful completion, give the workflow an alias such as `task1`; send `/task1` to execute it again with fresh environment checks. Each step retains the server IP, stable connection/server ID, operation path and completion checks. Multi-server steps follow their saved order; a result checkpoint must confirm the preceding step before the next operation. Ordinary tasks are not recorded. Workflows containing sudo ask you to authenticate with `sudo -v` or `sudo ls` in each execution terminal, then keep that terminal’s credentials refreshed during the task. [Orchestration and reuse guide (中文)](docs/guide.md#任务编排与多服务器协作).

## Schedule checks, decisions, actions, and verification

Create one-time, interval, or daily tasks with an explicit timezone in chat. For example:

> Every day at 09:00 Asia/Shanghai, check service health on the server in the production profile. If unhealthy, analyze logs and attempt repairs within the authorized scope, at most three times. Recheck after each action and record the result.

Use `/schedules` to inspect plans and run records, pause or resume, run immediately, or stop a run. Delete tasks in Settings. Saved tasks reload after restart and **run only while Tabby is open**. Unattended runs stop and record the reason when secrets or additional authorization are required. [Scheduled task guide (中文)](docs/scheduled-tasks.md).

## Install and start

1. In Tabby, open **Settings → Plugins**, find **`tabby-ai-tools`**, and install it. Click Tabby's **Restart the app to apply changes** prompt when ready; installations and updates take effect after the restart.
2. Use your local Codex login, or add an API connection under **Settings → AI Tools**.
3. AI Tools opens automatically after restart. Open the target terminal, describe a task in the sidebar, and send with **Ctrl+Enter / Cmd+Enter**. Use the robot icon to reopen a hidden sidebar. To disable automatic opening, uncheck **Open AI Tools when Tabby starts** in **Settings → AI Tools**; an existing opt-out is preserved.

**[Full configuration and user guide (中文) →](docs/guide.md)** covers prerequisites, source installation, connections, models, permissions, sudo, orchestration, all feature entry points, and troubleshooting.

One bundled [Tabby skill](skills/tabby/SKILL.md) retains all feature entry points for the model. The build embeds it, installation includes it, and the plugin supplies it to Codex and API models automatically. No separate skill installation is required.

[Development (中文)](docs/development.md) · [Validation scope (中文)](VALIDATION.md) · [Issues](https://github.com/Hanlen/tabby-ai-tools/issues) · [MIT](LICENSE)
