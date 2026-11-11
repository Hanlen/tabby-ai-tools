# External AI connections: read-only MCP preview

This feature is currently an **unreleased source preview**. The published 0.9.4
package does not include it. It exposes explicitly selected, running Tabby
terminals to a local MCP client. A sidebar model or API key is not required.
The service runs on Tabby's built-in Electron Node runtime; there is no separate
Node installation or proxy process for the user to manage.

## Connect a client

1. Open **Settings → AI Tools → External AI connections (MCP)**. The service is
   disabled by default. Enable it and wait for **Service running** and an endpoint.
2. Enter a recognizable client name and click **Add client**. Each client has its
   own credential and starts with **no terminal access**.
3. Choose a configuration format and copy the generated snippet. Merge it into
   your client's personal configuration, preserving existing entries. The entry
   name is `tabby`; choose another name if you already use it. The plugin never
   edits these files. Reconnect the client after saving.
4. Under **Readable terminals**, select the exact terminals that client may read.
   The client can now use `list_tabs` and `read_tab`. **Last request** changes when
   the service receives an authenticated request; it is not a persistent online
   indicator and does not by itself prove a tool succeeded.
5. Uncheck a terminal to revoke that scope, or click **Revoke client** to remove
   the credential entirely. Pending observations are cancelled and later reads
   are denied. **Rotate credential and generate config** invalidates the previous
   credential immediately; replace the client's copied configuration.

Credentials are shown temporarily in this settings view and are not recoverable
from the saved digest. Hide the credential after copying. To copy again, rotate
it. Treat the copied configuration and the destination client file as private.

If an operation fails, the settings view reads back the current service state
instead of repeating the operation or leaving a failed uncheck looking like a
successful revoke. A permissions-file write failure disables the current service;
the change was not saved, so inspect saved clients after resolving the storage
problem and restarting. Terminal grants still do not survive a restart.

The first successful start chooses an available port and saves it. Later starts
reuse it. If that port is occupied, the service reports the conflict and stops;
it never kills another process or silently changes the URL. Disable the service
to choose another port, then regenerate configuration if the endpoint changed.
An automatic startup failure keeps the window's terminal registration active,
so correcting the port and enabling again does not require reopening the window.
If utility termination cannot be confirmed within the shutdown deadline, the
service retains that process slot and reports an error; it does not start an
overlapping replacement. Restart Tabby if the process remains unavailable.

## Configuration locations

Use the actual configuration space for the client you intend to connect:

| Client | Copy format and personal configuration |
| --- | --- |
| Codex CLI | TOML `mcp_servers.tabby`, `url`, and `http_headers`; normally `~/.codex/config.toml`, or the selected custom `CODEX_HOME/config.toml`. [Official configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). |
| Cursor | JSON `mcpServers.tabby` with `url` and `headers`; normally `~/.cursor/mcp.json`. [Official configuration](https://cursor.com/docs/mcp). |
| Claude Code | JSON `mcpServers.tabby` with `type: "http"`, `url`, and `headers`; merge the entry into user-scope configuration in `~/.claude.json`, respecting the client's configured location. [Official scopes and configuration](https://code.claude.com/docs/en/mcp). |

Do not replace an existing configuration file with a snippet or commit a credential
into project configuration. Automatic merge, backups and recovery helpers are
not part of this preview. No account login or authorization settings in these
clients are modified by Tabby.

## Tools and observations

| Tool | Behavior |
| --- | --- |
| `get_capabilities` | Reports this endpoint's read-only tools and actual limits. |
| `read_skill` | Static instructions for these four external tools only; no arbitrary knowledge sections or upstream files. |
| `list_tabs` | Only this client's granted, currently valid terminal sessions; opaque IDs, no hidden terminal names or raw profiles. |
| `read_tab` | A snapshot of up to 300 lines / 20,000 characters. Pass its `nextCursor` for output deltas; optional `waitMs` is bounded at 30 seconds. |

Snapshot cursors are captured before the snapshot so concurrent fresh output can
appear again in the next delta. A delta cursor follows the returned bytes. Output
may be truncated; `truncated` and `hasMore` describe that condition. Cursors bind
the client, grant revision, target and output stream; sharing or editing them,
changing scope, rotating credentials or restarting the service invalidates them.

Read access exposes the **whole authorized terminal's output**, including earlier
visible scrollback. The output may contain secrets and must be treated as
untrusted data rather than instructions. Profile host/account labels are configured
identity hints, not proof of nested SSH/container identity. Rename ambiguous
terminals before granting them. Attachment transfer payloads are masked using
the plugin's existing output protections.

The MCP reader subscribes independently of the sidebar and does not start task
log capture or acquire input ownership. Closing or reconnecting a terminal,
replacing its session, disabling the service, a service crash, or restarting
Tabby clears applicable terminal grants. **Select the new session again.** Saved
client names and credential digests survive restart; terminal access does not.
Permissions and the port are stored privately under the actual Tabby config
directory's `ai-tools-mcp/state.json`, separately from model credentials.

The endpoint is `http://127.0.0.1:PORT/mcp` in the same local network namespace.
It rejects browser Origins and mismatched Hosts. It is not a LAN/public service,
OAuth server, cloud connector, stdio bridge or automatic WSL/container tunnel.
Limits include a 1 MiB request body, four concurrent tool observations per client,
sixteen globally, and 240 authenticated requests per client per minute. HTTP slots
are separately bounded at eight per client / thirty-two globally so initialization
and cancellation can still reach the service while observations are saturated.
Legacy cancellation notifications are matched to the authenticated client and
grant revision; newer HTTP cancellation follows the request's abort signal.

## Verification and current limits

The production implementation has been exercised on Linux x64 with official
Tabby 1.0.238, Electron 43.7.0 / Node 24.21.0 and Codex CLI 0.167.1. Codex discovered
the endpoint and read real terminal output without a model turn; actual grants,
unshared terminals, delta/wait, revoke, rotate and service shutdown were checked.
The utility runs with an empty PATH, using the host's Node. SDK tests cover both
legacy and 2026-07-28 HTTP protocol paths.

Real Cursor/Claude Code client acceptance, older Tabby versions, Windows/macOS
desktop behavior and user SSH terminals remain unverified. A compatible host needs
utilityProcess, Node 20+ and the supported main-process bridge; an unsupported
host reports an MCP-specific error and does not require another model login.

This preview provides **no terminal input, command execution, process takeover,
write approvals, execution leases, external task logs or automatic client file
installation**. Those remain later MCP stages. Observation cancellation or a
timeout never stops an existing terminal command or replays input. The existing
internal Codex/Claude/API terminal tools retain their separate behavior.
