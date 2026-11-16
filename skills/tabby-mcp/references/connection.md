# Find and pair with Tabby

Discovery, pairing and tool discovery are separate steps. MCP does not by itself
locate an unconfigured desktop application. Installing this skill makes its
instructions discoverable in supporting agents; it does not register an MCP
server or authenticate one. Unsupported agents can import this standard Agent
Skill using their own skill installation mechanism.

If present beside this file, read `local-discovery.json` for the exact registry
path installed by Tabby. Otherwise inspect the current user's
`~/.agents/tabby/mcp/` directory. Read only regular JSON records there, at most 32;
ignore symlinks, oversized files (over 16 KiB), malformed records and unknown
formats. Multiple Tabby configuration spaces have separate profile records. If
more than one running profile is present, identify the one the user intends.
Do not guess based on a terminal title or reuse another profile's credential.

A record with `status: running` supplies a loopback Streamable HTTP `endpoint`.
It is a location hint only: after a crash it can be stale. Reject URLs outside
`http://127.0.0.1:<port>/mcp`. Disabled/stopped/error records require the user to
open Tabby and enable its service. If no record exists, use the setup route below;
do not search the filesystem for tokens or probe arbitrary ports.

For the first connection:

1. Open Tabby → Settings → AI Tools → External AI connections (MCP).
2. Enable the local service. Current source supports a shared **Local connection
   (no token)**, with no client creation or token issuance. Published older
   versions may still require adding a named bearer client.
3. Copy its generated configuration and merge only the Tabby server entry into
   the agent's chosen personal configuration, preserving unrelated entries.
   A Codex client uses a `mcp_servers` TOML entry; Cursor/Claude Code can use the
   generated JSON format. For local no-token access, other MCP clients need only
   the shown HTTP URL. Remove an older entry's Authorization/token-environment
   settings when switching; an invalid supplied token is still rejected. Local
   processes share automatic read/write access to every terminal tab and input
   leases; reported names do not
   isolate them. Optional named bearer clients retain their own permissions.
   Never put credentials into URLs, command
   arguments, shell history, the skill or chat. If installing configuration is
   not authorized or requires handling a secret in chat, ask the user to paste it
   directly into their client's configuration instead.
4. Reconnect/reload the MCP client as required. A running conversation may need a
   new session to discover a newly configured server or skill. Do not restart a
   live agent task merely to reload configuration. Do not restart Tabby for this:
   local access automatically covers current terminals after restart; bearer
   clients lose their selected terminal grants.
5. Call `get_capabilities`, `read_skill`, `list_tabs`. Local connections default to auto with all
   terminal tabs, including new/reconnected sessions; no mode or tab selection
   is needed. Bearer clients need explicit terminal grants. Read one target to
   verify the actual connection before reporting success.

For Codex, generating or copying a snippet does not register it. On the intended
CLI host, use its actual `CODEX_HOME/config.toml` (normally `~/.codex/config.toml`
when unset). For `local_no_token`, merge the URL-only entry or run
`codex mcp add tabby --url ENDPOINT` in that same configuration space, replacing
`ENDPOINT` with the discovered URL. Preserve unrelated entries; use another server
name if `tabby` is already in use. Check `codex mcp list --json` after saving,
then reload the client and verify the MCP handshake and tools. An HTTP response
alone proves neither registration nor a successful MCP tool call.

If Settings reports an existing skill conflict, its on-disk instructions were
preserved and may describe an older bearer-only flow. Back up the existing skill
and reconcile `SKILL.md` and this reference against the bundled source path shown
in Settings, preserving custom content. **Copy current connection instructions**
provides this guide without editing the installed skill. Use the live service's
advertised authentication mode; do not ask for a token for `local_no_token`.

Local connections automatically cover all terminal tabs with read/write access.
Disable the service to revoke local access. Preserve existing bearer operation
modes and checked terminals during connection repair; bearer `auto` covers only
selected targets. Neither mode bypasses foreground-process inspection. Empty
local `list_tabs` means no live registered terminal sessions; bearer clients may
also have no selected grants even after a successful handshake.

Skill discovery does not prove the pairing, authenticated request, target grant
or input permission succeeded. Report the precise stage still missing. A client
outside Tabby's host/network namespace cannot use its loopback endpoint; do not
suggest exposing all interfaces, disabling authentication or copying local
credentials into a remote/cloud agent to bypass this boundary.
