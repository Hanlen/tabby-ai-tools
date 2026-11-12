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
2. Enable the local service and add a named client specifically for this agent.
3. Copy its generated configuration and merge only the Tabby server entry into
   the agent's chosen personal configuration, preserving unrelated entries.
   A Codex client uses a `mcp_servers` TOML entry; Cursor/Claude Code can use the
   generated JSON format. Other MCP clients need the shown HTTP URL and Bearer
   header in their own supported format. Never put credentials into URLs, command
   arguments, shell history, the skill or chat. If installing configuration is
   not authorized or requires handling a secret in chat, ask the user to paste it
   directly into their client's configuration instead.
4. Reconnect/reload the MCP client as required. A running conversation may need a
   new session to discover a newly configured server or skill. Do not restart a
   live agent task merely to reload configuration.
5. Call `get_capabilities`, `read_skill`, `list_tabs`. New clients have no terminal
   grants: the user must select concrete terminals in Tabby. Read one granted
   target to verify the actual connection before reporting success.

Skill discovery does not prove the pairing, authenticated request, target grant
or input permission succeeded. Report the precise stage still missing. A client
outside Tabby's host/network namespace cannot use its loopback endpoint; do not
suggest exposing all interfaces, disabling authentication or copying local
credentials into a remote/cloud agent to bypass this boundary.
