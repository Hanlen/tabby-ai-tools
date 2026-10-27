# Unreleased: optional Pi runtime and context compaction

- Add an optional Pi SDK 1.4.0 backend using an external Node 22.19+ process and isolated resources. Existing Codex, Claude Code and API connections retain their authentication paths.
- Route host tools through a serial, journaled pipe bridge with approvals, read-only policies, cancellation, workflow verification, duplicate-result reuse and unknown-action recovery.
- Show structured retry/compaction states and wait for Pi settlement. Account model and summary usage against goal budgets; disable nested provider retries and cache warming.
- Add `/compact` and opt-in automatic compaction. Built-in API projections preserve raw history and entire tool batches; Pi keeps its native append-only session history.
- Add runtime/Node/compaction settings, translations, a development interface illustration and bilingual setup documentation.

Review fixes preserve unimported steering and recovery notices across manual compaction, report output-limit truncation as incomplete while keeping partial text/usage, and explicitly configure Kimi Coding compatibility for system messages and max_tokens across preset and proxy endpoints.

Validation uses local HTTP fixtures and existing regression/build checks; no real model requests are part of routine checks. An isolated Linux Tabby 1.0.238 / Electron 43.7.0 fixture additionally verified sidebar loading, runtime settings and the real host list_tabs bridge with a local simulated provider. Windows/macOS desktop, SSH/PTY mutations and real provider access remain unverified. See [Pi setup and validation boundaries](../pi.md). This note does not indicate an npm or GitHub release.
