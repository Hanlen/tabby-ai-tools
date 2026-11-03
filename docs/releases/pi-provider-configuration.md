# Unreleased — Pi native API configuration (P0/P1)

New API connections recommend Pi SDK 1.4.0 with searchable native providers, offline model metadata, explicit API-key/environment authentication and four custom protocols. Native Gemini and OpenRouter retain their SDK identity and metadata through endpoint overrides. Manual models require explicit capabilities; request output budgets and SDK thinking levels are validated.

Connection edits use independent Save / Discard / Copy drafts. Saving does not infer or hot-switch an active task. The no-inference runtime/configuration check and explicit usage-consuming model/tool test have separate meanings. Legacy Pi connections, Kimi/Alibaba product presets, native history and both independent CLI engines retain their compatibility paths. Host tool permissions and bundled Electron launch are preserved.

The bilingual README, guide, Pi/development docs, model-facing skill/knowledge and SVG/PNG overview describe the new behavior. The full SDK provider catalog labels unavailable adapters. P2/P3 remain pending; this delivery does not claim OAuth, cloud identity, arbitrary headers/JSON import/export or remote catalog refresh. The separate [custom instructions and CLI spaces](../instructions-sessions.md) change adds its own settings, persistence and compatibility paths; its platform/account evidence is recorded separately.

Validation uses local fixtures and the actual pinned SDK, with no paid model calls. See VALIDATION.md for exact local check, desktop and tarball evidence. No commit, tag, remote CI or publication is part of this implementation session.
