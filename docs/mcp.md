# External AI connections: MCP terminal preview

This feature ships in **v1.0.0**, with controlled terminal input in preview. The older 0.9.4
package does not include it. Current source exposes all running Tabby terminal tabs with automatic read/write
access to token-free local MCP clients; optional bearer clients use selected terminals. A sidebar model or API key is not required.
The service runs on Tabby's built-in Electron Node runtime; there is no separate
Node installation or proxy process for the user to manage.

## Connect a client

The unreleased source adds **local connections without a token**. Published
v1.0.0 packages use the optional named-client credential flow described below.

1. Open **Settings → AI Tools → External AI connections (MCP)**. The service is
   disabled by default. Enable it and wait for **Service running** and an endpoint.
2. The default **Local connection (no token)** needs no client creation or token.
   Choose a configuration format and copy the generated URL-only snippet. Merge it into
   your client's personal configuration, preserving existing entries. The entry
   name is `tabby`; choose another name if you already use it. The plugin never
   edits these files. Reconnect the client after saving.
3. Local connections automatically have read/write access to **all terminal tabs**,
   including new/reconnected sessions. No permission mode or tab selection is needed.
   The client can use `list_tabs`, `read_tab` and the input tools. **Last request** changes when
   the service receives a request; it is not a persistent online
   indicator and does not by itself prove a tool succeeded.
4. Disable MCP to revoke all local access. Optional bearer clients retain their
   own selected scopes and modes; uncheck a bearer target to revoke that scope.
   Pending observations are cancelled and later reads are denied.

For Codex, register the shown endpoint with
`codex mcp add tabby --url http://127.0.0.1:PORT/mcp` (replace `PORT`), or merge:

```toml
[mcp_servers.tabby]
url = "http://127.0.0.1:PORT/mcp"
```

Generating or copying this configuration does not register the server. Use the
intended CLI host and its actual `CODEX_HOME` (default `~/.codex`); a configuration
on another host or in another Codex space does not apply. Confirm registration
with `codex mcp list --json`, then reload the MCP client or open a new Codex
session after the active task finishes. Local access automatically covers current terminal sessions after restart;
bearer clients need fresh terminal grants after restart. Verify the MCP handshake/tool discovery, `get_capabilities`,
`read_skill`, `list_tabs` and an authorized terminal read. HTTP responses and
last-request timestamps alone are insufficient.

No `Authorization` header or token environment variable is needed. Remove these
fields from an older entry when switching to the local connection. An invalid
explicit token still receives 401; it never silently uses local permissions.

**All programs connecting locally without a token share one permission set**, its
cursors, request limits and input leases. Client-reported names do not provide
separate identities. The local mode is `auto` and includes every live terminal tab automatically.
New/reconnected sessions receive fresh opaque targets without manual selection.
This does not bypass foreground-process checks or input ownership.

### Optional separate token clients

Existing bearer configurations continue to work with their separate grants.
Under **Separate token clients (optional)**, add a named client, select it, then
copy its credential configuration and select its terminals. This does not
restrict the shared local connection, which covers all terminal tabs. Disable
MCP to revoke local access.
**Revoke client** removes only that bearer client. **Rotate credential and
generate config** immediately invalidates its old token.

Credentials are shown temporarily in this settings view and are not recoverable
from the saved digest. Hide the credential after copying. To copy again, rotate
it. Treat the copied configuration and the destination client file as private.

If an operation fails, the settings view reads back the current service state
instead of repeating the operation or leaving a failed uncheck looking like a
successful revoke. A permissions-file write failure disables the current service;
the change was not saved, so inspect saved clients after resolving the storage
problem and restarting. Bearer terminal grants still do not survive a restart; local connections
automatically cover current terminal sessions.

If the window's MCP bridge temporarily fails to initialize, **Refresh** retries
its registration and restores the terminal feed once the bridge is available.
It does not repeat a failed client change or terminal operation. The utility
retains the host's operating-system environment, including Windows system and
temporary directories, while disabling system Node discovery and Node loader
overrides; no separate Node installation is needed.

Startup waits for a runtime-ready handshake before sending its single service
start request. Cold process creation and bundle loading have a 20-second budget;
after readiness, the HTTP listener has a separate 20-second reply deadline.
Ordinary control replies and the bounded process-exit cleanup retain their
5-second limits; this longer wait applies only to HTTP startup.
Failures identify process creation, runtime loading or HTTP startup separately.
An early exit includes its exit code and a recognized error class when available;
raw dependency diagnostics and credentials are not displayed. Failed or late
startup replies do not trigger another start request.

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
| Codex CLI | TOML `mcp_servers.tabby` with `url`; optional bearer connections also use `http_headers`. Normally `~/.codex/config.toml`, or the selected custom `CODEX_HOME/config.toml`. [Official configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). |
| Cursor | JSON `mcpServers.tabby` with `url`; optional bearer connections also use `headers`. Normally `~/.cursor/mcp.json`. [Official configuration](https://cursor.com/docs/mcp). |
| Claude Code | JSON `mcpServers.tabby` with `type: "http"` and `url`; optional bearer connections also use `headers`. Merge into user-scope configuration in `~/.claude.json`, respecting the client's configured location. [Official scopes and configuration](https://code.claude.com/docs/en/mcp). |

Do not replace an existing configuration file with a snippet or commit a credential
into project configuration. Automatic merge, backups and recovery helpers are
not part of this preview. No account login or authorization settings in these
clients are modified by Tabby.

## Tools and observations

| Tool | Behavior |
| --- | --- |
| `get_capabilities` | Reports this client's mode, the advertised tools, and actual limits. |
| `read_skill` | Static instructions for the external tools only; no arbitrary knowledge sections or upstream files. |
| `list_tabs` | Only this client's granted sessions. Local clients also see disconnected native SSH panes with `connected: false` and a new opaque ID. |
| `read_tab` | A snapshot of up to 300 lines / 20,000 characters. Pass its `nextCursor` for output deltas; optional `waitMs` is bounded at 30 seconds. |
| `send_input` | Command or owned-process stdin; explicit confirm/auto grant, maximum 10,000 characters. Optionally observe the exit code of a submitted single-line command. |
| `send_keys` | Key input only for the current lease; explicit Ctrl+C follows the same permission. |
| `attach_process` | Claim a verified existing process without interrupting it. |
| `release_tab` | Release only your lease; restore input without stopping a process. |
| `ssh_exec` | Execute in a separate channel on a connected native SSH tab. Returns stdout, stderr and exit code. |
| `manage_tab` | Select, rename, split, duplicate or close a terminal pane. Local clients can also list/open saved profiles and reconnect disconnected SSH panes. |
| `sftp_transfer` | Submit one confirmed SSH file upload or download, up to 100 MiB. Returns the receipt before transfer. |
| `sftp_status` | Read the owning client’s transfer receipt, including paths, current status, and completed byte count and SHA-256. |

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
the plugin's existing output protections. When those protections alter a snapshot,
its cursor/highlight interaction metadata is omitted as well, so styled text cannot
reveal a masked payload.

The MCP reader subscribes independently of the sidebar and does not start task
log capture or acquire input ownership. Closing or reconnecting a terminal,
replacing its session invalidates that target, its observations and its lease.
Local connections automatically include the new session while preserving access
and active leases on other tabs. Disabling the service or a crash cancels all
observations/leases without replay; local access resumes for current sessions
when explicitly re-enabled. Saved bearer names and credential digests survive
restart, but bearer clients must **select the new session again**.
Permissions and the port are stored privately under the actual Tabby config
directory's `ai-tools-mcp/state.json`, separately from model credentials.

The endpoint is `http://127.0.0.1:PORT/mcp` in the same local network namespace.
It rejects browser Origins and mismatched Hosts. It is not a LAN/public service,
OAuth server, cloud connector, stdio bridge or automatic WSL/container tunnel.
Limits include a 1 MiB request body, four concurrent tool observations per client,
sixteen globally, and 240 requests per client identity per minute. Headerless local
connections all count as one identity. HTTP slots
are separately bounded at eight per client / thirty-two globally so initialization
and cancellation can still reach the service while observations are saturated.
Legacy cancellation notifications are matched to the client identity and
grant revision; newer HTTP cancellation follows the request's abort signal.

### Observe a command's exit code

For a submitted single-line command, set `waitForExitMs` to an integer from 1 to
5000. The existing input, permission and lease rules apply. For example, on a
local shell that emits OSC 133 completion with exit status:

```json
{ "tabId": "your-tab-id", "text": "false", "waitForExitMs": 3000 }
```

The response includes `sent: true` and `exitCode: 1` if the shell reports status
1. A successful command reports `exitCode: 0`. Use `read_tab` for terminal output.
Without shell integration, add `"exitCodeShell": "posix"` if the target is
known to be Bash, Zsh or another POSIX-compatible shell. This explicitly wraps
the command in same-shell `eval` and prints its status using an invisible OSC
marker. The wrapper accepts at most 768 UTF-8 bytes of command text. Leave it
unset for Fish, PowerShell, CMD and other incompatible shells.

`exitCode: null` means no status was observed, for example when the wait expires,
when integration omits the code, or when the command replaces or exits the shell.
The wait neither stops nor resubmits the command. Observe the terminal and
continue using the lease when input is needed. If the terminal is still owned
after a POSIX result, read the output and release input when finished. The five
second bound leaves room in the existing observation budget for approval and
dispatch. Calls without `waitForExitMs` retain immediate input acknowledgements.

### Work with SSH, terminal panes and files

Use `send_input` when the task must run in the actual shell in the chosen tab,
including its current directory, environment, and any nested SSH or container.
For native SSH, Tabby AI Tools requires a completed OSC 133
`C → D → A → B` prompt sequence for this session. Outgoing terminal input
during that prompt sequence or after it, a new shell command, a session change or the alternate screen
blocks submission until a fresh prompt is verified. There is no automatic
fallback to `ssh_exec`.

Use `ssh_exec` explicitly for non-interactive work on the outer native Tabby
SSH connection. It requires the native exec API and a remote `/bin/sh`.
The channel starts in the remote account’s default working directory. It
returns up to 16,000 bytes of stdout and the last 4,096 bytes of stderr as UTF-8,
plus an exit code after the shell reports it. Use the actual pane for interactive
commands. An observation timeout can occur after the remote command started.

For `manage_tab`, use `list_tabs` to obtain a target ID. `split` accepts
`left`, `right`, `up` or `down`. The target anchors saved-profile operations
to its window. Wrapping an existing pane for its first split preserves its ID and grant. Profile listing returns up to 200 profile IDs, names and types.
Use one of those IDs with `open_profile` and then call `list_tabs` again.
`reconnect` targets a pane with `connected: false` where Tabby offers
reconnection. That operation and `close` require confirmation. Successful
reconnection gets a fresh opaque ID. Bearer grants are never copied to a new
or reconnected pane. Saved-profile actions, close and reconnect are local-only.

Generate a lowercase UUIDv4 as `requestId` before calling `sftp_transfer`.
The reply immediately acknowledges the request and includes an exact destination.
Confirm both paths in the target window. Both paths must be absolute.
For upload, pass the remote parent directory. The receipt gives the destination
in the new private directory. For download, pass the remote source file.
Downloads write to a new local file and preserve existing destinations.
The transfer uses the same order as sidebar attachments: SFTP, independent SSH
with raw bytes, then independent SSH with Base64. Fallback requires an unavailable
capability before payload delivery. Permission, verification and uncertain
outcomes stop the operation. To also permit the last-resort pane shell, set
`allowPtyFallback: true` and confirm that exact shell as a file endpoint.
Tabby requires a fresh idle prompt before the PTY fallback and verifies
authorization on each write. The pane shell may be on a nested host.

Call `sftp_status` with `transferId` equal to the original `requestId` to
observe `awaiting_approval`, `running`, `completed`, `failed` or `unknown`.
A completed receipt gives the transport, byte count and SHA-256. Poll the same ID after
a lost response. Repeating identical submission arguments with a retained ID
returns the same receipt, and changing any argument results in a conflict.
If the outcome is unknown, inspect the exact path in the receipt.

Approval has its own 25-second deadline and approved transfer work gets up to
90 seconds. The transfer continues independently of the submission response.
Receipts are retained in memory for 15 minutes after completion and remain scoped
to the submitting client's permission revision.

## Verification and current limits

The production implementation has been exercised on Linux x64 with official
Tabby 1.0.238, Electron 43.7.0 / Node 24.21.0 and Codex CLI 0.167.1. Codex discovered
the endpoint and read real terminal output without a model turn; actual grants,
unshared terminals, delta/wait, revoke, rotate and service shutdown were checked.
Controlled input was also exercised in the isolated Linux profile: approval/denial, command and stdin, attachment/keys, owned Ctrl+C, shared sidebar conflict, revoke and real Codex command/release, with zero model turns. The utility runs with an empty PATH, using the host's Node. SDK tests cover both
legacy and 2026-07-28 HTTP protocol paths.

Real Cursor/Claude Code client acceptance, older Tabby versions, Windows/macOS
desktop behavior and user SSH terminals remain unverified. A compatible host needs
utilityProcess, Node 20+ and the supported main-process bridge; an unsupported
host reports an MCP-specific error and does not require another model login.

A read-only bearer can discover the write tools, but server-side permission
checks reject calls to them. External logs, workflows and application settings
remain outside the MCP interface. Internal Codex, Claude and API operations
retain their separate behavior.

## Enable command execution and interaction

Token-free local connections automatically allow read/write operations on all
terminal tabs. Their settings do not require a mode or terminal selection.
For an optional bearer client, select its concrete terminals and choose
**Terminal operation permission**: **Read only** (default), **Confirm each
operation**, or **Allow automatic operations**. Bearer permission covers only that client's checked terminals.
Commands use the terminal account's permissions. A mode/scope change invalidates
pending approvals, in-flight input and leases. For bearer clients, restart resets input permission to read-only and clears
concrete targets; disable/reconnect requires fresh terminal grants. Local
connections automatically cover current sessions with auto input permission. Never infer input permission from readable output.

In confirmation mode, each command, attachment, stdin or key request appears in
**Settings → AI Tools → External AI connections (MCP)** with its client, target and
exact arguments. Approve or deny in the window containing that terminal within
25 seconds. Keep this section open while operating a confirmation-mode client;
there is no background auto-approval. Controls remain usable while approval waits.
`release_tab` does not require another approval. Automatic mode uses the existing
explicit grant without repeating operation approvals.

1. `list_tabs`, then `read_tab` to inspect the target. Snapshot results also include
   available cursor/highlight interaction metadata; delta results contain text.
2. `send_input({tabId,text,mode:"command",submit:true})` starts a command only when
   local foreground inspection or a current native SSH shell prompt confirms idle. Maximum text length is 10,000;
   control characters are rejected (use `send_keys`). No automatic Ctrl+C or
   foreground takeover is allowed. Unknown shell state blocks a new command.
   See the SSH section above for same-shell and independent execution.
3. A successful input or `attach_process` returns a server-generated `leaseId`.
   Pass it with `send_input(mode:"stdin")`, `send_keys`, further same-lease commands,
   or `release_tab`. Never invent an owner or reuse another client's lease.
4. `attach_process({tabId,expectedProcess,purpose})` claims a verified existing
   interactive process only when explicitly requested. It never interrupts or
   restarts it. Existing native Linux SSH PID/PTY proof may be used, but actual
   external-MCP SSH acceptance remains pending.
5. Read fresh output after every interaction. Use `send_keys({tabId,leaseId,
   key:"c",ctrl:true})` for explicit Ctrl+C only when needed for the owned task;
   it obeys the selected approval mode. `sent:true` proves submission, not success.
6. `release_tab({tabId,leaseId})` or the local **Release input control** button
   restores user input. Neither stops a running process. A lease expires after
   120 seconds without a successful input operation; reads do not renew it.

Only one lease can reserve a terminal; competing clients receive `busy`. Input
also uses the shared sidebar/scheduler controller: it never overrides their locks.
Unchecking a target, changing mode, cancelling, revoking/rotating credentials,
closing/reconnecting the terminal, stopping the service or losing its process
invalidates affected approvals and leases. It does not send cleanup text or kill
remote processes. Cancellation after dispatch, a response loss or an observation
timeout can mean input already happened (`unknown_outcome`); inspect the terminal
and never automatically resubmit. A 25-second approval wait shares the bounded
33-second observation budget, so late approval can leave little time for inspection.
If that budget expires or the parent channel closes after a write was forwarded,
the client receives `unknown_outcome`, even if no result arrived from the terminal.
Explicit approval denial/expiry remains distinguishable from an unknown result.

Controlled-input evidence is recorded separately from earlier read-only acceptance.
No paid model call is required for protocol/desktop verification. Real user accounts,
Cursor/Claude Code clients, Windows/macOS, older hosts and external MCP SSH remain
pending unless explicitly recorded with versions and actual tool results. Extreme
375px windows retain Tabby's wide settings sidebar and have poor readability;
use a wider desktop window for the approval detail.

## How an agent discovers Tabby

There are three separate stages: discovering instructions, finding the service,
and pairing an authenticated MCP client. Saying “connect to Tabby through MCP”
can select the installed `tabby-mcp` skill in a supporting agent; the skill alone
cannot register a server, obtain a credential or grant a terminal.

On the first start in a supported Tabby host, the plugin copies the portable
`skills/tabby-mcp` folder into `~/.agents/skills/tabby-mcp`. It also installs the
same content in the existing `~/.claude` skill directory (Codex and Cursor use the shared root).
It does not create absent client-specific homes. Existing matching skills are
reported as present; modified, older or unrecognized folders are preserved as a
conflict, never overwritten. Check/retry with **Install / check Agent Skill** in
MCP settings. Conflicts now show an explicit warning that preserved instructions
may still request a token, the bundled source path, and **Copy current connection
instructions**. Back up the preserved folder and reconcile `SKILL.md` and
`references/connection.md` with that source, retaining custom content, then reload
the client. Copying the current guide does not replace the installed skill or
register a client. Use the live service's authentication mode; local token-free
access needs no token, while separate bearer clients retain their credentials.
For custom skill roots, another user/host, or other agents, import
the bundled folder using that client's installation mechanism. There is no
universal directory that every agent reads, and no npm install-time script or
system Node requirement. The skill becomes available after Tabby has started;
client reload/session requirements depend on the client.

Each copy includes `references/local-discovery.json`, a locator for
`~/.agents/tabby/mcp/`. Separate profile JSON records advertise only this plugin's
version, enabled/running status, loopback endpoint and setup route. They contain
no tokens, digests, terminal titles, scopes or user client configuration. They are
application metadata, not a standard MCP-wide registry or proof that a service is
still running after a crash. Stopped/disabled records have an empty endpoint;
records are written privately and atomically. Filesystem failures are reported
separately and do not change MCP authorization or stop an otherwise working service.

For example, in Codex:

1. “Connect to Tabby through MCP” can match the skill description. The agent first
   checks its available MCP tools; if absent, it reads the skill's local locator.
2. The location record helps distinguish disabled Tabby from an unpaired client.
   A missing/stale record is a setup problem, never permission to scan ports or
   extract credentials from another client's configuration.
3. First pairing still uses the generated configuration from Tabby Settings. Once
   installed in the intended client's personal configuration and reloaded as
   needed, the client performs the MCP handshake and tool discovery.
4. `get_capabilities`, `read_skill`, `list_tabs`, and a granted terminal read verify
   the actual connection. Local access includes all terminal tabs with auto input; bearer scope and
   mode remain independent of successful skill or server discovery.

The same workflow applies to other MCP-capable agents that load Agent Skills.
An agent without skill support can follow this guide manually. Remote/cloud
agents cannot reach a desktop loopback service merely because they received a
skill file. No skill invokes a model or changes MCP accounts, scopes or permissions.

Directory references: [Codex skills](https://learn.chatgpt.com/docs/build-skills),
[Claude Code skills](https://code.claude.com/docs/en/skills),
[Cursor skills](https://cursor.com/docs/skills). Their documentation describes
client behavior; actual client/version acceptance is recorded separately.
