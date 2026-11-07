# Claude Code local login

[README](../README.md) · [中文使用指南](guide.md)

Version 0.4.1 includes **Claude Code (local login)** alongside native Codex and the existing Claude API connection. It runs the user's installed, unmodified official CLI. Authentication, model access, subscription limits, and billing remain with Claude Code.

## Setup

1. Install the [official Claude Code CLI](https://code.claude.com/docs/en/setup) on the computer running Tabby.
2. In **Settings → AI Tools → Claude Code → Instructions and sessions**, choose the session space. Unused connections default to a Tabby private space; existing saved CLI references retain system compatibility mode. Check the selected-space login first: an empty private space reuses the local CLI's OAuth file cache when available. If it is unavailable or only in the OS keychain, generate the selected-space login command and run it in a local terminal, choosing your Claude account to use an eligible subscription. A plain `claude auth login`/`claude auth status` uses your terminal's own configured space and may authenticate a different location.
3. In **Settings → AI Tools → Claude Code**, set the executable path if discovery cannot find it. Select **Claude Code (local login)** in the sidebar or make it the default connection. The default alias is `sonnet`; `opus`, `haiku`, and full model IDs can also be configured. These are candidate aliases, not an account entitlement list.
4. Describe a task. Operations use the same Tabby tools, read-only restrictions, approvals, workflow checkpoints, and execution records as API connections. The host's operating system permissions still apply; this mode does not supply an OS sandbox.

The executable resolver checks PATH, the official `~/.local/bin` location, common Homebrew/npm directories, and the current executable's directory. Explicit paths, quoted paths, and `~/` paths are supported. A custom command name searches PATH only. Windows `.exe`, `.com`, `.cmd`, and `.bat` launchers are supported. Custom Node/npm prefixes outside these locations need an explicit path and a working Node environment.

Connecting checks `--help` and `auth status` without model inference, using the same configuration environment as inference. The CLI must support the integration flags, including `--system-prompt-snapshot`, `--append-system-prompt-file`, strict MCP configuration, and streaming partial messages. Update Claude Code if the connection reports a missing flag. Before the check, an absent private `.credentials.json` is initialized from the original `CLAUDE_CONFIG_DIR` (default `~/.claude`) OAuth cache. An existing private login is preserved. If authentication later fails, the warning dialog offers **Copy login again and reconnect** to replace the stale private cache, retaining the conversation and input without replaying tasks. The official CLI continues to manage login and token refresh; credentials are never displayed in chat or sent to a separate API adapter. Private mode removes inherited API-key/token and cloud-routing overrides, while system compatibility retains existing authentication options. OS credential stores and managed policies can still affect an account. See [instruction snapshots, private history and migration](instructions-sessions.md).

## Design decision and official sources

The [official authentication rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) distinguish running unmodified Claude Code with the user's own subscription from a third-party application's reuse of subscription credentials. The integration uses the former: the CLI completes Anthropic's own login flow and makes all model requests. The plugin neither implements a Claude.ai OAuth flow nor forwards subscription tokens to the Messages API. Existing Claude API connections remain separate.

The adapter uses the documented [programmatic CLI](https://code.claude.com/docs/en/headless), [CLI flags](https://code.claude.com/docs/en/cli-reference), and [HTTP MCP configuration](https://code.claude.com/docs/en/mcp). A TypeScript Agent SDK dependency is not needed. The default Claude Code system prompt is retained, with the bundled Tabby skill and current task instructions appended.

```mermaid
sequenceDiagram
    participant User
    participant Panel as Tabby sidebar
    participant CLI as Official Claude Code CLI
    participant MCP as Temporary loopback MCP bridge
    participant Host as Tabby tool executor
    User->>CLI: claude auth login (official flow)
    User->>Panel: Task and selected local connection
    Panel->>CLI: -p + stream-json + appended instructions
    CLI-->>Panel: Streamed response and usage
    CLI->>MCP: Authenticated tools/call
    MCP->>Host: Existing tool validation and permissions
    Host-->>Panel: Approval when required
    Host-->>MCP: Recorded execution result
    MCP-->>CLI: MCP tool result
    CLI-->>Panel: Final result and native session ID
```

## Runtime boundaries

- Each invocation gets an HTTP MCP listener on `127.0.0.1` with a random port and a fresh 256-bit bearer secret. The listener checks the host and rejects browser origins. Calls are serialized before entering the existing executor; intent is saved before execution. The server and private temporary instruction/config files are removed when the invocation ends or stops.
- `--tools ""` disables built-in shell/file tools. `--strict-mcp-config` loads the Tabby bridge, and `--disable-slash-commands` disables CLI skills and commands for this invocation. `--settings '{"disableAllHooks":true}'` disables user/project/plugin hooks; administrator-managed hooks and enforced policy remain governed by Claude Code. Only user settings are loaded to retain the user's authentication helpers; project/local settings are excluded. These options apply to the launched session, without changing the user's settings files.
- MCP approval rules allow the bridge to reach the host executor. They do not waive the host's read-only checks, mutation approval, workflow sequencing, sudo authentication, or scheduled-task restrictions.
- Tabby's conversation index stores portable history and an opaque native session ID. The private CLI directory can contain the locally copied OAuth login cache. Successful continuations use `--resume` and send only new input. Model changes and provider switches import portable text and observed tool outcomes into a fresh session. On an interrupted or failed invocation, the next explicit request reconstructs from recorded history, with a warning to verify the terminal before acting. There is no automatic model retry or silent API fallback.
- Stop cancels pending host requests and terminates the owned CLI process tree before the turn finishes. Commands already submitted to a Tabby terminal may still run. Messages added while Claude Code is working are queued for a new invocation after the current one ends, rather than injected into an in-progress CLI request.
- Observed usage is counted once per native message and checked against the task budget before further operations. Token usage is not a subscription balance or price. Native context compaction belongs to Claude Code; imported plugin history has a 9 MiB input limit.
- Schedules can choose this connection. Existing scheduler isolation, logging, and unattended rules apply. An explicitly requested candidate-model test uses an isolated MCP confirmation tool and consumes model quota; normal connection/model-list checks do not.

## Validation limits

Offline tests use a real child process and authenticated HTTP MCP, with simulated Claude events. They cover streaming, native resume, migration, approvals, read-only mode, durable intent, cancellation, malformed/truncated output, failed results, token accounting/budgets, connection selection, and the scheduler's model probe. They make no model requests.

A real subscription end-to-end run still requires an installed CLI, an eligible user's official login, and real Tabby desktop testing. Passing the offline tests does not establish actual subscription entitlement, model quality, or Windows/macOS execution results.


## v0.9.2 update-path review — 2026-11-07

Claude local has a related cached-entrypoint risk, but this repository does not establish that its distributions use the same companion EXEs as Codex. Connection-time help/auth checks previously resolved one absolute path and later invocations reused it. A removed version directory could therefore break the next invocation.

Each native invocation now re-resolves the original configured selector and rechecks the required CLI flags and selected-space auth status before inference, including native goal continuations. Default `claude` follows a changed installation/PATH target; explicit files and custom command names keep their original discovery scope. An invocation already submitted to the CLI is never retried after failure or timeout. Preflight failure leaves the last successful native session reference intact. Private spaces, cwd, selected model, instruction snapshot, tool bridge and authorization are preserved.

A launcher disappearing between `--help` and `auth status`, malformed status JSON or a changed status schema now produces a CLI/protocol diagnostic rather than a fabricated logged-out result. Valid `loggedIn=false` remains an authentication failure, including the CLI's exit-1 JSON response. This does not inspect credential files or change login/permission settings.

The review/test evidence covers simulated official CLI processes, MCP tool round trips, updated default entrypoints, pinned-path failure, changed tool flags, native session retention and no inference replay. Real Claude account/desktop and vendor layouts remain unverified. The resolver retains existing discovery priority; this is not a claim that every third-party/npm layout is repaired automatically.
