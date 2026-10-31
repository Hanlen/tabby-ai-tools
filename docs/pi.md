# Pi runtime

Version 0.5.0 offers **Pi SDK** as an optional runtime for API connections. It uses pinned `@earendil-works/pi-coding-agent` / `pi-ai` 1.4.0 in an isolated runtime process. Codex and Claude Code remain independent CLI connections.

Since **0.5.1**, the release includes a self-contained Pi JavaScript bundle and third-party notices. Tabby installs no Pi SDK dependency tree and runs no Pi dependency postinstall scripts. Installing the plugin does not require a system `node` command. Pi defaults to Tabby’s built-in Node through Electron `utilityProcess`, so a compatible Tabby needs no separate Node installation even for Pi. An external Node 22.19+ executable is an explicit compatibility option. Codex, Claude Code and the built-in API connections keep their existing requirements. Version 0.5.0 could fail installation when `protobufjs` tried to run its postinstall script without `node` on PATH; update to 0.5.1 rather than disabling install scripts globally.

## Setup

1. Install or update `tabby-ai-tools` to version 0.5.1 or newer in **Settings → Plugins**, then restart Tabby. For source installations, use Node 22.19+ to run `npm ci`, `npm run build` and `npm run install:tabby -- "<Plugins Directory>"`; the installer copies the built runtime without running npm in the plugin directory.
2. In **Settings → AI Tools**, select an API connection and choose **Agent runtime → Pi SDK**. Leave **Compatibility Node executable** empty to use Tabby’s built-in runtime. No system `node` command is required.
3. Pi needs Node 22.19+ in its selected runtime. If an older Tabby cannot provide it or lacks the utility-process bridge, update Tabby first. For an explicit compatibility override, enter a real external Node 22.19+ executable; do not enter Tabby’s executable or a shell command with flags.
4. Keep the existing provider, Base URL, model ID and key source. OpenAI uses Responses, Claude API uses Anthropic Messages, and the other presets use Chat Completions; custom connections keep their selected protocol. Kimi Coding explicitly uses `system` messages and `max_tokens`, including international and proxy endpoints, rather than relying on SDK URL detection. API billing applies; choosing Pi does not provide a ChatGPT or Claude subscription login.
5. Connect from the sidebar. The sidebar’s **Details** panel reports whether the built-in or compatibility runtime is selected and its Node/Electron versions. The explicit connection test uses the real Pi process and a harmless nonce tool; it consumes model quota when requested.

Only the Tabby tools advertised by the host are available. Pi's built-in shell, filesystem tools, extensions, project context files, external skills, MCP discovery, prompt templates and cache warming are disabled. The existing Tabby skill and task context are supplied by the host. Terminal tools run serially, with the same read-only rules, approvals, terminal ownership, sudo handling and workflow checkpoints as other connections. A command being sent is not evidence that it completed.

## Context and history

`/compact` manually summarizes an idle API or Pi conversation. It consumes model quota. For the built-in API runtime, the original messages remain intact; an independently checked summary projection cuts only at a user-turn boundary so a complete tool batch stays together. Source ranges, a source hash, retained index and summary token usage are saved. Codex and Claude Code continue managing their own native context.

For Pi, the SDK's JSONL session is the sole native model context. Compaction appends a summary with its retained entry boundary; old entries remain readable. Tabby keeps a UI transcript, goal, action journal and portable handoff rather than replacing Pi's history. Changing runtime, model, provider or protocol creates a portable handoff into a separate session. Original native histories stay on disk. Manual compaction does not acknowledge host-only input: queued corrections and interruption recovery notices remain pending until a subsequent normal prompt imports them into Pi.

Automatic compaction is **off by default**. Enable it per connection after trying manual compaction. The API runtime uses a conservative character estimate at 75% of the configured context window (not an exact tokenizer). Pi uses its own threshold/overflow handling. Summaries preserve constraints and pending checkpoints in their instructions; the host's structured workflow checks remain authoritative regardless of summary text.

## Retries, cancellation and budgets

Pi owns its session retries, with two retries and a maximum advertised wait of 60 seconds. Provider SDK retries are disabled, preventing nested retry multiplication. The sidebar consumes structured retry delays; no client timer resends the prompt. Replies truncated by the output token limit are reported as incomplete failures, retaining partial text and reported usage; truncation does not silently restart the Goal or report success. Completion waits for `agent_settled` and process completion. A low-level `agent_end` alone is insufficient.

All Pi model requests, retry attempts and summary requests share a **100-request safety cap per invocation**. Summary usage is counted, even when compaction needs more than one request. Reported tokens count toward the current goal budget; after exhaustion, another model request or host tool cannot proceed. An already-started response may exceed the remaining budget; these are reported usage limits, not a provider billing guarantee. Retry and request limits reset for a new invocation; goal token usage persists.

The sidecar continues active goals itself using the same native session. Tabby does not wrap Pi with the API persistent-goal loop. Existing host tool limits and repeated-tool detection still apply. Stop remains available during model streaming, tool approval, compaction and backoff and terminates the owned process tree. Appended sidebar input is queued for the next host invocation after the current Pi run settles; use Stop first when a correction must interrupt current work.

## Recovery and storage

Sessions live under the Tabby configuration directory in `tabby-agent-sessions/pi/<session-id>/`. Host UI indexes and action journals remain in the existing session store. Use the sidebar history list to resume; reported cumulative usage and the last known model input are restored with the UI history. Do not edit a Pi JSONL file or its host index while a session is active. Missing or unreadable native history stops execution rather than silently creating an empty model context.

Each Pi tool call has a stable native action ID. Before execution, Tabby durably records the intent; afterward it records the result. A duplicate returns the recorded result. An intent without a known result never executes again automatically. The private stdin/stdout bridge has no HTTP transport retries and never automatically restarts a failed process. Accepted user-input cursors are recorded in Pi history and acknowledged by the host before inference. Following a crash or lost response, the next prompt instructs the agent to read the terminal and verify actual state before continuing. This does not make arbitrary shell operations transactional or safe to replay under a new action ID.

## Validation boundary

Local HTTP fixtures exercise the actual SDK, provider streaming, host tools, retries, cancellation, quota errors, goal continuation, persistent restart, repeated compaction and summary budgets without calling a real model. The three-platform CI matrix uses Node 22.19.0. Running those checks locally on Linux does not establish macOS/Windows or desktop Tabby results. A downloaded official Linux Tabby 1.0.238 was also exercised under Xvfb with an isolated configuration: Electron 43.7.0 / host Node 24.21.0 loaded the plugin, the sidecar used Node 22.19.0, and the sidebar completed a local-provider task through the actual `list_tabs` host bridge and goal update. Runtime settings rendered in the actual app. This covers a local desktop fixture, not SSH/PTY mutation, real-provider/subscription access, macOS or Windows end-to-end behavior. Pi remains optional pending those checks.

Upstream API reference: [Pi SDK](https://github.com/earendil-works/pi/blob/f9daca3480732d0042b1df3a6e27221f597a620d/packages/coding-agent/docs/sdk.md).

## Built-in runtime verification

In official Linux Tabby 1.0.238 (Electron 43.7.0, built-in Node 24.21.0), the packaged main-process bridge and actual SDK completed streaming and a host-tool round trip with no system Node on PATH. Separate runs verified cancellation while a host-tool result was pending and termination when the owner window was destroyed. All model traffic used a local HTTP fixture; no real model or terminal mutation was performed. Electron renderer Node worker threads are unsupported in that app, and `ELECTRON_RUN_AS_NODE` did not provide the required startup path, so the implementation uses the supported utility-process API. The main bridge owns window/crash cleanup and acknowledges final IPC before the utility exits. macOS/Windows desktop behavior remains unverified; CI covers bridge ownership, cancellation, protocol handling and package installation on those systems.
