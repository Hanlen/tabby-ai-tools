# Unreleased

Changes through the custom OpenAI-compatible provider implementation are included in [v0.4.1](0.4.1.md). Future provider/setup redesign is not implemented; planning and research documents remain local and are excluded from the package.


## Workflow recording stalls and backend rate limits

- Removed automatic terminal-output injection into active turns. High-frequency echoes remain in the bounded local buffer; agents read results explicitly with `read_tab`. User-initiated sends/continuations still include one bounded source-terminal summary.
- Added persistent backend retry waiting with a live elapsed timer and countdown when timing is supplied, an honest unknown-time fallback, duplicate-error coalescing, cancellation feedback and stale-turn error filtering. HTTP 429 is not presented as proof of long-term quota exhaustion. The plugin does not implement its own model retry loop.
- Workflow continuation retains pending checkpoints and instructs the agent to inspect live terminal results, artifacts and Git state before confirming a completed step, avoiding replay of stash, restore or apply.
- Updated both READMEs, the guide, workflow/development documentation, all 12 UI catalogs and the SVG/PNG interface illustration. The title robot animation remains unchanged.
- Validation uses local fixtures for high-frequency echo, retry waiting/cancellation and workflow continuation; no paid inference, original-task replay or real Tabby desktop/Windows validation.
