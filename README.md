# Tabby AI Tools

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/robot-multitask.png">
    <img src="docs/assets/robot-multitask.gif" alt="A cheerful little robot typing while coordinating tasks across multiple terminal windows" width="640" height="320">
  </picture>
</p>

**Let AI work through your terminal, across your computer and multiple servers.**

**English** · [简体中文](README.zh-CN.md) · [Full configuration and user guide (中文)](docs/guide.md)

Tabby AI Tools is an AI assistant inside [Tabby](https://github.com/Eugeny/tabby). It reads terminal output, sends commands, and uses the results to decide what to do next. Describe your goal in the sidebar, follow the work in your terminals, and reclaim terminal input whenever needed.

![Tabby AI Tools 0.2.0 interface illustration: the assistant coordinates two SSH terminals, with scheduled tasks, provider connections, automatic startup and language settings](docs/assets/overview.png)

<sub>Interface illustration with example tasks and connections; appearance varies with your Tabby theme and window size.</sub>

## Work with servers on a private network

Your servers do not need internet access. If your computer can reach the AI service and connect to the servers through Tabby, the assistant can use their SSH terminals to inspect logs, troubleshoot, run commands, and verify results. No server-side AI Agent is required. Terminal content needed for analysis is sent from your computer to your selected model service.

## Coordinate servers without installing an Agent on each one

Use Tabby's connections and signed-in accounts to inspect and operate different servers through tabs and split panes. There is no need to install an Agent, configure a model, or manage separate Agent login credentials on every server.

## Enter sudo passwords yourself, then continue

When elevated access is needed, manually run `sudo ls` or `sudo -v` in the same terminal on the target server and enter your password there. Let the assistant continue afterward without sharing the password with the model. Authentication reuse and expiry follow the server's sudo configuration.

## Use your local Codex subscription login without an API key

Subscription users whose accounts include Codex access can install Codex CLI locally, run `codex login`, and use that login directly. No separate API key is required in this mode; available models and quota depend on the account. OpenAI, DeepSeek, GLM, and Claude API connections are also supported.

## Orchestrate tasks in natural language

Describe the targets, order, conditions, and verification criteria. The assistant can work through multiple servers and steps, using terminal feedback to guide each action. For example:

> Check application-to-database connectivity on staging-app and staging-db. Verify the database first, then inspect the application configuration. Explain any issue before asking me to authorize a fix, and verify the application health check afterward.

Workflows can branch based on observed results and interact with other terminal Agents. Successfully completed terminal tasks can become reusable references for similar work, with fresh checks of the current environment. [Orchestration and reuse guide (中文)](docs/guide.md#任务编排与多服务器协作).

## Schedule checks, decisions, actions, and verification

Create one-time, interval, or daily tasks with an explicit timezone in chat. For example:

> Every day at 09:00 Asia/Shanghai, check service health on the server in the production profile. If unhealthy, analyze logs and attempt repairs within the authorized scope, at most three times. Recheck after each action and record the result.

Use `/schedules` to inspect plans and run records, pause or resume, run immediately, or stop a run. Delete tasks in Settings. Saved tasks reload after restart and **run only while Tabby is open**. Unattended runs stop and record the reason when secrets or additional authorization are required. [Scheduled task guide (中文)](docs/scheduled-tasks.md).

## Install and start

1. In Tabby, open **Settings → Plugins**, find **`tabby-ai-tools`**, and install it. Fully quit and restart Tabby.
2. Use your local Codex login, or add an API connection under **Settings → AI Tools**.
3. Open the target terminal, click the robot icon, describe a task, and send with **Ctrl+Enter / Cmd+Enter**.

**[Full configuration and user guide (中文) →](docs/guide.md)** covers prerequisites, source installation, connections, models, permissions, sudo, orchestration, all feature entry points, and troubleshooting.

One bundled [Tabby skill](skills/tabby/SKILL.md) retains all feature entry points for the model. The build embeds it, installation includes it, and the plugin supplies it to Codex and API models automatically. No separate skill installation is required.

[Development (中文)](docs/development.md) · [Validation scope (中文)](VALIDATION.md) · [Issues](https://github.com/Hanlen/tabby-ai-tools/issues) · [MIT](LICENSE)
