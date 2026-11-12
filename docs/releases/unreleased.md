# Unreleased

## Terminal observation latency

- Default internal terminal snapshots wake on unread output after the task's input or reliable shell completion, including output received before the read. Render/burst coalescing is about 50 ms, capped at 200 ms for continuous output; explicit zero and quiet-terminal wait limits are preserved.
- Output does not mark completion or release multiline ownership. Per-owner observation baselines rearm before stdin/keys; cancellation and session changes clean up listeners without replaying input. Snapshot results include wakeReason/waitedMs, and cwd/process metadata reads run concurrently.
- Updated model guidance to prefer cursor-based deltas for non-interactive output and snapshots for prompts. Bilingual README, guide, operation skill and SVG/PNG illustration describe the source-only change. Native Codex exec_command timing and model/network latency are outside this optimization.

- Fixed attachment masking in external MCP snapshots: masked snapshots omit cursor/highlight metadata so styled payload text cannot bypass the mask, including repeated reads.
- Fixed forwarded MCP writes reporting observation timeouts as proof that no input was sent. Deadline expiry, cancellation and parent-channel loss now preserve `unknown_outcome`; explicit approval denials remain distinguishable, and lost replies never trigger a replay.

- Bundled a portable `tabby-mcp` Agent Skill for external MCP clients, with user-scope discovery installation, a shared Codex/Cursor root and existing Claude directory adapter and a Settings check/retry action. Credential-free per-profile records locate the service; pairing, authentication and terminal grants remain explicit. Existing skills and client configurations are preserved.

- Added opt-in external MCP command and interaction tools (`send_input`, `send_keys`, `attach_process`, `release_tab`). Clients remain read-only until explicitly granted confirm/auto mode; target-window approvals, client-bound expiring leases, shared sidebar/scheduler ownership and final send checks prevent implicit takeover. Cancellation/release never kills a command and unknown outcomes must not be replayed. New shell commands require verified idle process inspection; ordinary SSH shell execution remains blocked.
- Updated bilingual setup, model guidance and the SVG/PNG illustration for the controlled-input preview; real client/platform evidence remains scoped separately from fixtures.

- Hardened MCP fault paths: background startup failures retain terminal registration; failed IPC settles observations and revokes unreachable windows; utility errors wait for actual exit before replacement, with a bounded shutdown deadline. Settings reconcile failed changes and discard late credentials for a removed client; terminal metadata refreshes no longer lose a trailing update. Failed partial state writes clean up their temporary files.
- Fixed legacy HTTP cancellation across the SDK's per-request compatibility instances. Cancellation is scoped to the authenticated client/revision, with bounded HTTP control capacity reserved alongside the 4/16 tool-observation limits.

- Added a default-off local MCP service with read-only initial grants in Settings → AI Tools → External AI connections (MCP), with independent named credentials, explicit terminal scopes, immediate revocation/rotation and copy-only Codex/Cursor/Claude configuration previews.
- Connected the production HTTP → Electron main → renderer path to real terminal snapshots, client-bound deltas and bounded waits. Output subscriptions work with the sidebar closed. No command-input or takeover tools are exposed, and concrete scopes clear on reconnect/restart.
- Bundled the SDK into an Electron utility runtime, using the host's Node with no system Node dependency. Added protocol, authorization, lifecycle and routing regression coverage, plus bilingual documentation and updated SVG/PNG illustrations.
- Verified real terminal reads and controlled command/release through Codex CLI on Linux Tabby without a model request. Cursor/Claude client acceptance, other desktops, SSH and automatic client config installation remain pending. This source preview has not been published; the 0.9.4 Registry package is unchanged.
