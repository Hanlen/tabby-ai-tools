# Codex installation recovery and existing SSH agents

Baseline included in v0.9.2, 2026-11-07. See [release scope and validation limits](releases/0.9.2.md).

The reported Windows log identifies a failure to spawn `codex-code-mode-host.exe` from the `a159911ff70742e9` installation. It is evidence of tool-helper startup failure after the CLI had reached tool dispatch, not evidence of failed login. The later `f71a721e0e6193a9` installation and successful user-reported conversation/tool execution demonstrate that a complete alternative existed. Why the older files disappeared is unconfirmed: the repository has no evidence establishing desktop update, cleanup or cache invalidation as the cause.

The plugin previously validated the main executable and compared `--version`, including desktop hash directories. It already rescanned on a new connection; there was no persistent discovery cache to clear. A reused app-server could nevertheless retain an installation that had since become incomplete. The fix retains a per-connection rejection set for confirmed faulty entrypoints, rescans once, and drops that set on a subsequent explicit fresh connection.

Native Windows distributions from the observed `0.167.0-alpha.3.2` baseline check an adjacent code-mode host for tool-enabled connections. Windows sandbox shell execution additionally checks the adjacent command runner. Account inspection and decision-only connections do not require the tool host. This is a version/layout compatibility rule based on the reported distribution, not a claim that every earlier CLI needs these files. Unknown versions and batch/npm launchers keep their existing layout contract and rely on explicit runtime failure recognition. A future distribution with a different layout will require adapting this rule; helper version equality is not independently established by a universally supported helper `--version` command.

Automatic Windows selection excludes incomplete installations before applying existing semantic version ranking; valid-version/unknown-version ordering and tie behavior remain unchanged. Valid explicit files and custom command names stay pinned. Since v0.9.4, unavailable saved selectors are cleared and persisted, then automatic discovery runs once. Explicit permission-denied paths, helper checks and authentication/protocol/model errors do not trigger clearing. An explicit stable desktop `OpenAI/Codex/bin` selector, and a removed version-specific desktop entrypoint, retain recovery within that same installation only. Helpers are never copied between installations.

Health is checked during discovery, before spawn, on connection reuse and before new task admission. Explicit owned-process stderr/RPC/turn helper errors cover removal after a successful check. Chat text, unrelated file ENOENTs and observation timeouts cannot initiate recovery.

One automatic rescan/rebuild is allowed per connection lifecycle. Concurrent reports share the same attempt. Recovery waits until all known turns, RPCs and server requests on this client have ended. It never interrupts another active panel to replace the server. A transport loss with an admitted turn leaves execution unknown and prevents automatic recovery at that boundary. If an active turn never reports completion, recovery waits rather than killing it to manufacture an idle boundary.

Only the connection is restored. No historical `turn/start`, steering prompt, tool call, terminal input, native goal activation or implicit `thread/resume` is sent by recovery. The original thread is resumed when the user next submits a new message, with the existing cwd, model, private space, instruction snapshot and permission settings. The panel retains its history/draft and explicitly asks for actual terminal-state inspection before continuing. A confirmed RPC rejection differs from an unanswered request; the latter is never treated as proof an operation did not run. Native session locks wait for process cleanup without cancelling the recovery controller. Recovery does not refresh or modify login credentials.

If recovery cannot find an allowed complete installation, it stops with the original helper/CLI/install path, attempted rescan and action to select a complete CLI and reconnect. Background runtime timers do not defeat this limit. An explicit user reconnect may start a fresh lifecycle; this still never replays old actions.

## Why existing SSH agents were blocked

Tabby's native SSH shell `getChildProcesses()` returns a placeholder empty array, not a remote process list. The plugin correctly treated it as unknown, but had no alternate identity path, so repeated screen reads could never authorize attachment.

Attachment now uses the existing authenticated SSH transport's independent exec channel, without pasting a probe into the Agent. On Linux it collects only current-user foreground PIDs, start times, PTYs and `/proc/PID/exe` paths. It then writes a random private OSC marker to candidate PTY output and accepts only the identity whose marker is observed in the exact target session. The marker does not enter terminal stdin or display a visible message. A host-wide executable name or a screen saying “Codex” is insufficient. Every later input repeats the identity proof, and existing ownership, cancellation, session-change, read-only and workflow checks still apply.

A proof is bounded to four seconds, 32 KiB and at most 16 candidate processes. Inspection failure retains ownership and sends no answer. Unsupported independent exec, missing/inaccessible procfs, non-native executable names, inaccessible PTYs, nested SSH, containers and terminal multiplexers may remain unsupported; no identity is guessed from a different host or pane. Do not restart a waiting Agent to work around this boundary.

## Verification and loading

Regression tests cover incomplete successful-version probes, complete/incomplete candidates, deleted paths, removal between preflight and spawn, explicit/custom/default selector scope, older/unknown/batch layouts, helper failures, bounded and concurrent recovery, unrelated active turns, pending tool replies, unknown execution state, private-thread resumption and no replay. Remote tests cover pane proof, stale identity, failed inspection, ownership and cancellation. A real local Linux PTY probe verifies output-only identity without stdin writes; SSH channel behavior is covered by transport fixtures. These do not establish a real Windows Tabby or the user's current SSH-pane end-to-end result.

Update to v0.9.2 or later from Tabby's plugin manager and fully exit/restart Tabby. To load a local source build, run `npm run build`, use Tabby's **Open Plugins Directory**, then run `npm run install:tabby -- "<that directory>"` from this checkout. For another machine, transfer the verified `.tgz`, extract its `package` directory, rename it `tabby-ai-tools`, and place it under the `node_modules` directory inside Tabby’s Open Plugins Directory before restarting. Manual extraction needs no separate Node installation.

Protocol reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server). The implementation uses distinct initialization, thread resume, turn start and completion boundaries; only a completed/failed/interrupted turn event establishes the corresponding observed boundary.


## Claude local review added on 2026-11-07

The same review found cached absolute entrypoints between Claude invocations and over-broad auth-status error classification. Claude now re-resolves/checks its configured selector before every native invocation and keeps its previous native session on preflight failure; submitted inference is not retried. CLI spawn/format failures no longer establish that an account is logged out. This does not establish a shared Codex/Claude helper layout. See [the Claude update-path review](claude-code.md#v092-update-path-review--2026-11-07).

## v0.9.4 saved-selector recovery

A literal `codex` and an empty field enter the same discovery branch. The reported restart incident has no diagnostic log establishing its exact cause; deleting the field may also have triggered a fresh connection. Removed version paths, broken symlinks and absent custom commands are confirmed recoverable cases. Clearing configuration never deletes a CLI file, downloads a replacement or resubmits a task. Newer settings edits win over late discovery.
