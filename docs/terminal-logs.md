# Terminal streaming and task logs

**Available in v1.0.0:** default `read_tab` snapshots wake on new output or reliable shell completion, with about 50 ms for rendering/burst coalescing and a 200 ms coalescing cap for continuous output. A task also sees unread output received after its own input and before the read; a successful snapshot advances that task's observation baseline. Other observers do not consume this baseline, and stdin/keys rearm it. No output means waiting up to `waitMs` (default 1000 ms when controlled, otherwise 0); explicit zero remains immediate. Snapshot `wakeReason` and `waitedMs` explain the wait. Output is not completion: multiline batches retain ownership even at intermediate prompts. Explicit `waitFor` and delta cursors keep their existing policies.

`read_tab` reads the current screen by default. Use `mode="delta"` to read new terminal stream text, then pass the returned `nextCursor` unchanged on the next call. Start without a cursor to establish a baseline. Use `maxChars` (2–20,000) for bounded pages; follow `hasMore` before waiting again.

```json
{"tabId":"tab-2","mode":"delta","cursor":"<nextCursor>","waitFor":"either","waitMs":10000}
```

`waitFor` accepts `output`, `completion`, or `either`. Waiting for output combines a short burst before returning, with a bounded maximum delay. A timeout does not prove completion. Reliable shell completion remains separate from workflow verification and input ownership. No output event automatically starts a model request.

Cursors belong to one terminal session and AI scope. Reconnecting or restarting invalidates them. `cursor_expired` means the in-memory range was evicted: take a new screen snapshot and use saved logs where available. Screen snapshots also return a cursor taken before reading the screen, so switching to delta can repeat a little text rather than omit output still being rendered.

Delta text preserves arrival order and removes terminal controls. It does not reconstruct the current screen. Read a normal snapshot before interacting with menus, pagers, editors or terminal agents. Non-terminal tabs retain their existing screen/control interface.

## Saved task logs

**AI Tools → Save task terminal logs** controls local persistence. It defaults to enabled. Only terminals read or operated by the current task are captured; listing tabs or keeping a tab open does not start saving. Captures stop when the owning turn/task releases its resources or the terminal session changes. Disabling saving stops additional output from being saved. Already saved logs remain subject to retention.

Logs may contain sensitive terminal output, including command echoes. Attachment transport payloads are excluded using the same privacy boundary as terminal context. Plain text filtering does not identify all secrets.

The assistant can use:

- `list_logs()` to discover logs in its current session scope.
- `read_log(logId, maxChars?, cursor?)` to read bounded pages. `nextCursor` fixes the original read boundary while a log grows. Use `followCursor` as a new read cursor to inspect text appended after that boundary.
- `search_log(logId, query, cursor?)` for case-sensitive literal search. Continue with `nextCursor` when `partial=true`; each call scans a bounded slice and returns at most 50 matches. A hit cursor can be passed to `read_log`.

Log references do not execute commands, grant access to other sessions, or prove an action succeeded. Logs captured after output began are marked `captureStartedLate`; screen history before capture is not automatically reconstructed. Saved logs can be read after their terminal closes, while their session scope remains available. Switching connections or session spaces does not transfer access automatically.

Storage uses the host runtime and a private `tabby-terminal-logs` directory beside Tabby's configuration. Default limits are 32 MiB per log, 256 MiB of committed text overall, 2,000 log records, 2,048 segments per log, and a bounded asynchronous write queue. Overload or write failure produces `partial`; it does not freeze the terminal or rerun a command. Restarted open captures become `interrupted`, without resuming execution. Seven-day retention is checked when the store starts and when a new capture starts; expired logs cannot be read. No additional Node installation is required.

The in-memory tail is limited to 256 Ki characters per terminal and 8 Mi characters globally. Public cursors are opaque; internal character positions remain compatible with the terminal summary buffer. Unicode pairs are preserved at page boundaries.

Current limits: no terminal replay, arbitrary regex, cross-session log search, automatic log export, restoration of dropped pre-capture output, or scheduled-run log browsing from a separate interactive session. Retention cleanup runs lazily at startup and new captures. Actual desktop, SSH and platform-specific behavior must be verified separately from local fixtures.

## Regression checks

Run `npm run test:terminal-logs` with the current Node runtime. The script covers capacity recovery after retention expires, protection of active captures and in-flight readers, queued-file cleanup and byte accounting. Delta reads reuse the controlled terminal's 1,000 ms default; explicit `waitMs: 0` and the uncontrolled-terminal default remain immediate. These cases also run in `npm test` and require no model requests or Node version switching.
