# Unreleased

- Simplify both READMEs and replace the overview illustration on the project page with a six-second Tabby recording of a two-way file handoff using a local test backend.

- Share the sidebar attachment transport selection with MCP file transfers and report the successful transport in the receipt.

- Invalidate SSH prompt evidence on typeahead, preserve pane grants during split wrapping, and give SFTP submissions queryable receipts and a separate post-approval execution deadline.

- Add external MCP native SSH execution, opt-in same-pane shell submission with verified prompt evidence, terminal and saved-profile management, and confirmed SHA-256-verified SFTP uploads/downloads.

- Let external MCP clients request a shell exit code from `send_input` for a submitted single-line command. Use OSC 133 shell integration or opt into POSIX wrapping. Return `null` when status is unobserved during the bounded wait.

- Redesign the sidebar header as consistent 32px reconnect, account and collapse controls with matching SVG icons, clear hover/focus/disabled states, reduced-motion connection progress, and an account disclosure showing sign-in state with keyboard entry and Escape return-focus.
- Remove the redundant header Details button; the status, context and control summaries still open the same details panel.

- Close the sidebar login/logout dropdown when clicking or moving keyboard focus outside it, including terminal widgets that stop event propagation. Escape returns focus to the toggle; menu actions and authentication behavior remain unchanged.

- Clarify preserved Agent Skill conflicts: warn that older instructions may still request a token, show the bundled source and provide current connection instructions for manual reconciliation without overwriting custom files. Separate Codex registration in the intended CODEX_HOME, client reload, MCP handshake/tool checks and terminal grants; copying configuration is not registration, and bearer auto mode covers only checked terminals; local connections automatically cover all terminal tabs. Preserve live grants and the running utility.

- Add token-free loopback MCP connections: enable the service and copy a URL-only Codex/Cursor/Claude configuration. Local programs automatically share read/write access to all terminal tabs, including new/reconnected sessions, without mode or tab selection. Disabling the service revokes local access; leases, foreground checks, Host/Origin checks and request limits remain enforced. Closing or reconnecting another tab preserves unrelated local observations and leases. Optional existing bearer clients keep separate scopes. Update all twelve UI catalogs, bilingual READMEs, setup/skill instructions, discovery records and the SVG/PNG illustration.
- Recover Codex and Claude Code sessions after restart. Codex briefly retries confirmed writer conflicts, and can interrupt a verified old turn when it blocks a tool upgrade. Claude Code starts owned CLI cleanup on window unload and restores interrupted history once its session lock is available. If the session stays occupied, the sidebar opens a new conversation and explains why. The original history and unsent draft are preserved, and recovery never replays tasks or terminal operations.
- Allow 20 seconds for the MCP HTTP listener to start after runtime readiness, independently of the 20-second process/bundle-loading budget. Ordinary controls and process-exit cleanup keep their 5-second limits; late replies do not replay startup or terminal operations.

- Redesign Settings with four categories, a compact connection picker and a full-width editor (up to 1080px within Tabby; other settings pages keep their own width). Prioritize models, permissions and recorded workflows; collapse CLI paths, custom instructions, session storage, startup/log switches, workflow preferences and helper models by default. Preserve existing draft/save behavior and update all twelve UI catalogs, both READMEs and the SVG/PNG illustration.

- Fix MCP startup environment handling: retain host OS variables, including Windows system and temporary directories, while clearing PATH and Node loader overrides regardless of key casing. A transient window-bridge initialization failure can recover on Refresh without replaying settings changes or terminal operations.
- Fix MCP cold-start timeouts: wait for the runtime-ready handshake before sending one start request, separate process/bundle loading from the HTTP reply deadline, and report startup stages and recognized early-exit errors without raw diagnostics.
- Fix Claude Code private-space authentication: use the official selected-space login command instead of copying rotating system OAuth caches. The authentication warning exposes command generation/copy and a login check with reconnect.
- Preserve conversation history, native sessions and drafts; block recovery during active work and never replay inference or terminal tools. CLI paths are resolved from the configured selector again.
- Update both READMEs, the authentication guide, bundled skill and interface illustration. Offline regression and browser evidence are recorded locally; real account/keychain, desktop, Windows/macOS and SSH validation remain pending.

- Fix the sidebar account menu when switching private CLI connections: show Claude Code login-command and check/reconnect actions for Claude, retain Codex browser sign-in/sign-out for Codex, and hide CLI login actions for API connections. Authentication checks preserve drafts and never resend tasks.
