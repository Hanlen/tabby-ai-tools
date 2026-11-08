# Unreleased

## Markdown replies

Assistant replies, restored history and scheduled AI explanations render Markdown tables, headings, lists, quotes, emphasis, links and code. Tables preserve column alignment and scroll horizontally within the sidebar. Code blocks keep indentation and have a copy button, including when nested in a list or quote. Whole-message copy retains the original Markdown.

Streaming updates are grouped by animation frame and keep unchanged root blocks mounted. Horizontal scroll positions survive updates, and the existing follow / scrollback / jump-to-latest behavior is retained. Labels are available in all twelve interface languages; code remains left-to-right in RTL interfaces.

Raw HTML is escaped and Angular sanitization remains enabled. HTTP, HTTPS and mailto links use the host's external opener; relative file links stay inert. Markdown images become text links without automatic network requests. Labeled code fences now receive syntax highlighting, including JavaScript/TypeScript, Python, Shell, JSON, HTML, Markdown and PowerShell aliases. Code uses a consistent dark surface in both light and dark host themes. Unlabeled, unknown and over-20,000-character blocks remain escaped plain text; no language guessing or remote assets are used. Code copy preserves the exact original code text during streaming.

The bilingual README, guide, development notes and SVG/PNG interface illustration are updated. The illustration contains example content and is labeled unreleased. This change does not modify provider protocols, CLI discovery, authentication or task execution. Local validation is recorded in [VALIDATION.md](../../VALIDATION.md); this entry does not indicate an npm release.

## Long workflow recordings and AI decision steps

Recordings now preserve complete installation commands and multiline scripts up to the terminal transport’s 10,000-character limit, replacing the recorder’s 1,200-character cutoff. Independent verification commands, policy schemas and unknown-action recovery use the same limit. Sensitive or altered executable content is still rejected rather than saved as a partial command.

Fixed steps should use recorded machine checks for local progression. An optional `policy.decision` returns to the main AI before the marked operation, carrying its intent and current observation. After the AI submits that logical step, the runner resumes verification and subsequent scripted steps without replaying completed operations. Automation status includes required AI judgment and missing machine checks. Workflow documentation, bundled guidance and the SVG/PNG illustration are updated. This entry describes local changes, not an npm release; real desktop/account verification remains pending.
