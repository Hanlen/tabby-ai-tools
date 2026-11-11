# Unreleased

- Hardened MCP fault paths: background startup failures retain terminal registration; failed IPC settles observations and revokes unreachable windows; utility errors wait for actual exit before replacement, with a bounded shutdown deadline. Settings reconcile failed changes and discard late credentials for a removed client; terminal metadata refreshes no longer lose a trailing update. Failed partial state writes clean up their temporary files.
- Fixed legacy HTTP cancellation across the SDK's per-request compatibility instances. Cancellation is scoped to the authenticated client/revision, with bounded HTTP control capacity reserved alongside the 4/16 tool-observation limits.

- Added a default-off, local read-only MCP service in Settings → AI Tools → External AI connections (MCP), with independent named credentials, explicit terminal scopes, immediate revocation/rotation and copy-only Codex/Cursor/Claude configuration previews.
- Connected the production HTTP → Electron main → renderer path to real terminal snapshots, client-bound deltas and bounded waits. Output subscriptions work with the sidebar closed. No command-input or takeover tools are exposed, and concrete scopes clear on reconnect/restart.
- Bundled the SDK into an Electron utility runtime, using the host's Node with no system Node dependency. Added protocol, authorization, lifecycle and routing regression coverage, plus bilingual documentation and updated SVG/PNG illustrations.
- Verified real local-terminal reading through Codex CLI on Linux Tabby without a model request. Cursor/Claude client acceptance, other desktops, SSH, controlled execution and automatic client config installation remain pending. This source preview has not been published; the 0.9.4 Registry package is unchanged.
