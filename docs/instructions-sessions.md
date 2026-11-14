# Custom instructions and CLI session spaces

In Settings → AI Tools, select a connection and open **Instructions and sessions**. These settings have explicit Save / Discard actions. Saving does not run a model or interrupt an active task.

## Choose instructions

Choose **AI Tools default** to edit the shared default, or **This connection** to override it. A connection can inherit the default, use inline text, bind an absolute local AGENTS.md/Markdown file, or disable the custom layer. The connection override replaces the shared custom layer.

Use **Preview selected instructions** to read the chosen content without inference. Bound files must be regular UTF-8 files of at most 32 KiB. The preview shows the source, content hash and file modification time. Saving a file reference never overwrites the original file. A missing/unreadable file can remain saved for later repair, but prevents a new session that depends on it from starting. Relative paths and network URLs are not accepted.

New sessions save a private instruction snapshot. Editing the file or changing settings does not alter existing sessions, including after restart. Use `/new` for the new instructions. Existing histories remain visible; instruction changes are separate from connection compatibility fingerprints. For legacy sessions without a custom snapshot, the custom layer stays empty until a new session is created. Scheduled runs resolve the saved instruction configuration at the start of each new run; a missing file fails that run instead of falling back silently.

Custom instructions work with Codex, Claude Code, Pi and the existing API runtime. Tabby's built-in tool guidance stays enabled, and host permission/approval/read-only checks remain authoritative. Custom text does not activate hooks, extensions, MCP servers or native shell/file tools. The preview covers only this custom layer: Codex may also load native project AGENTS.md and Claude Code may load native CLAUDE.md. Pi's automatic context-file discovery remains disabled. Local instruction files are not automatically read from an SSH host.

## Separate CLI history

Unused Codex and Claude Code connections default to **Tabby private space**. A connection with existing saved CLI thread references retains **System space (legacy compatibility)** until you explicitly change it. The space selector shows its effective mode. API and Pi histories already use Tabby's own store.

Private spaces live below the Tabby configuration directory:

```text
tabby-agent-sessions/spaces/<stable-space-id>/
  manifest.json
  native/        # CLI state, history, indexes and space-local authentication
  index/         # Tabby history, context handoffs and instruction snapshots
```

Codex receives an explicit `CODEX_HOME`, SQLite and log location after executable discovery. Its process identity includes the space, and its private credential store is file-based. Claude Code receives `CLAUDE_CONFIG_DIR` for both authentication checks and inference. The plugin changes only its child-process environment; it does not change your shell, OS HOME or ordinary CLI directories. Private-mode launch removes inherited API-key/token overrides so a subscription connection does not silently use an unrelated API credential. Proxy and certificate settings remain available. The chosen workspace directory stays unchanged.

Before starting a private Codex app-server, Tabby initializes an absent `native/auth.json` from the local CLI's ChatGPT login cache. It uses the `CODEX_HOME` found during CLI discovery, including the login-shell environment, or `~/.codex` by default. Only the login cache is copied; system configuration and history stay separate. Tabby publishes the imported file atomically with owner-only permissions on POSIX and records the imported login owner, or a fingerprint of the refresh token on older CLI versions. This lets Tabby distinguish a copied login from an independently signed-in space. Codex manages refreshes inside that space.

Claude Code follows the same rule before its login check or model probe: an absent `native/.credentials.json` is initialized from `CLAUDE_CONFIG_DIR/.credentials.json`, or `~/.claude/.credentials.json` by default. Only an OAuth login cache is imported; API-key-only files are not copied. CLI history, settings, hooks and project trust remain separate. OS-keychain-only credentials cannot be copied through this file path; use the selected-space official login command if its login check fails.

Tabby only lists/resumes private native sessions whose local metadata belongs to the selected space. A raw native ID cannot cross this boundary. Spaces and thread references are stable across restarts; sessions are not made ephemeral to hide them. Concurrent writers are rejected rather than sharing one native conversation silently.

## Log in and migrate

1. Select the target space and use **Check selected-space login**. For Codex, this automatically initializes a missing private login cache from the local ChatGPT login when available, including for previously created empty spaces. For a private Codex space, the check reads account information and queries the Codex account service without running a model. A successful check does not establish model entitlement or available quota.
2. If the check reports no login, sign in with the sidebar connection dropdown for the saved private Codex space, or use **Generate login command** and run the command in a local terminal. The generated command uses POSIX shell syntax on Linux/macOS and PowerShell syntax on Windows, quotes paths, and targets the selected space. Complete the official account login there, then check again. This fallback is needed when no ChatGPT file cache is available, when the local login exists only in an OS credential store, or when the cached login has expired. API-key-only caches are not imported.
3. Existing private logins are preserved, including a login for a different account. Initialization is a one-time copy when the cache is absent. Claude Code performs the same cache initialization before its selected-space login check.
4. **Save session space**, then click the sidebar's reconnect control when idle. When switching spaces, the current conversation can be transferred through Tabby's portable context handoff into a new native session. Existing source records stay in their original location. Use `/new` to start fresh instead.

Changing the space does not move or erase old shared sessions from your ordinary CLI list. Failed reconnection retains the current sidebar conversation; check login for the target or restore the previous space setting before trying again. Scheduled tasks use the connection's selected space for subsequent runs; active runs keep the backend they started with.

## Recover an expired login

The sidebar opens an authentication warning dialog when Codex or Claude Code reports a 401, an expired/revoked token or a missing login. Repeated errors share one warning; dismissing it leaves a visible entry to reopen it. Permission failures (403), rate limits (429) and unrelated thread/model errors do not trigger this authentication dialog.

When Codex reports an authentication failure and the turn has ended, the sidebar can try one automatic recovery for a known imported login. The source must contain a newer, non-expired login for the same ChatGPT user and workspace. For older spaces without an import record, Tabby can recognize matching local and private grants, or you can explicitly choose **Copy login again and reconnect**. Both recovery paths check the account service before restoring the existing conversation and keep the draft without replaying the turn.

If the system login is also unavailable, choose **Sign in** next to the connection button or in the warning dialog. Complete the official browser login to reconnect the private space. **Sign out** removes the local login for that space and disables future automatic imports there. An explicit browser login also disables imports so that it stays independent. Claude Code retains its manual cache recovery and system space uses the local official CLI login.

System mode deliberately retains existing CLI authentication/environment behavior. Private history does not imply account isolation: platform credential stores and managed policies may still affect an account, particularly with Claude Code. A separate login may be required. This feature is not an operating-system sandbox.

## Evidence and limits

Offline process fixtures cover private persistence, process replacement, source/target indexes, instruction snapshots, restoration and authentication-environment consistency. Local Codex 0.166.0 additionally started an app-server in an empty private home, created/read a thread and placed SQLite/log state there without a `turn/start` request. That CLI does not support the extended-turn listing used by some newer app-server versions; the existing history compatibility path remains relevant.

Real Claude subscription login, model entitlement and macOS/Windows desktop behavior need their own platform/account validation; fixtures are not proof of those results. See [validation](../VALIDATION.md) for the exact local checks. Native account login remains an action you complete through the official CLI; no paid model smoke test is run automatically.

Official references: [Codex login caching and copying auth caches](https://learn.chatgpt.com/docs/auth), [Codex locations and overrides](https://learn.chatgpt.com/docs/config-file/environment-variables), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code authentication and separate configuration directories](https://code.claude.com/docs/en/authentication), [Claude Code settings](https://code.claude.com/docs/en/settings), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference).
