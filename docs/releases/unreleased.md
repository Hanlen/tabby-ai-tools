# Unreleased: local Claude Code

Adds a built-in Claude Code (local login) connection, using the installed official CLI and its own authentication. A temporary authenticated loopback MCP bridge connects the native agent loop to existing Tabby tools, approvals, history, workflow checks, and schedules. Native sessions resume after successful turns; interrupted runs preserve observations and require fresh verification.

The status panel bounds its label column so long labels cannot hide values in narrow windows. The sidebar, settings, bilingual README, guide, architecture notes, bundled skill, and interface illustration describe both Claude Code login and the separate Claude API connection. Connection checks do not consume model quota.

Validation uses offline child-process and MCP fixtures, type checking, skill consistency, and a production build. Actual subscription inference and Tabby desktop/SSH behavior remain unverified. No release or npm publication has been requested for this implementation.
