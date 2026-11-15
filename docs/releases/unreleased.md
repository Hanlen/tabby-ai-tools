# Unreleased

- Fix Claude Code private-space authentication: use the official selected-space login command instead of copying rotating system OAuth caches. The authentication warning exposes command generation/copy and a login check with reconnect.
- Preserve conversation history, native sessions and drafts; block recovery during active work and never replay inference or terminal tools. CLI paths are resolved from the configured selector again.
- Update both READMEs, the authentication guide, bundled skill and interface illustration. Offline regression and browser evidence are recorded locally; real account/keychain, desktop, Windows/macOS and SSH validation remain pending.
