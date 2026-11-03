# Changelog

## 0.4.2 — 3 November 2026

- Ship Codex CLI registration instructions and a copyable TOML configuration, plus agent-assisted installation prompts for Codex and Claude Code.
- Clarify package installation, MCP registration, reconnection, and verification of tool discovery.
- Allow up to five minutes for npm processing after an accepted publication before failing release verification; retries preserve the exact published artifact.
- Update pinned npm/client examples and public release links to 0.4.2.

## 0.4.1 — 3 November 2026

- Publish through GitHub Actions using the configured npm trusted publisher, alongside MCP Registry metadata and checksummed GitHub release assets.
- Update public release links, npm installation instructions, and Claude Code, VS Code, Windows, and offline MCP setup examples.
- Stabilize slow Windows CI runs with longer timeouts for two Git integration tests that launch multiple processes.
- Document the trusted publisher scope and release maintenance procedure.

## 0.4.0 — 3 November 2026

- Separate MCP tool registration into an importable server factory; add architecture/deployment guides, client configuration examples, and an optional stdio Docker image.
- Prepare GitFerry for public npm distribution and MCP Registry discovery as `io.github.mayank1307/gitferry`.
- Support local stdio MCP through `gitferry-mcp` and `gitferry mcp`, with pack, inspect, and apply tools.
- Build fresh standalone CLI and MCP bundles whenever packing a release; ship installation, demo, and security documentation with npm.
- Add version/schema checks, isolated package installation checks, and CI for Node 22/24 on Linux, macOS, and Windows.
- Add a version-tag release workflow with npm and MCP Registry OIDC publishing, checksummed offline artifacts, and safe retries.
- Update MCP SDK, validation, compression, and test dependencies to patched versions.
- Harden bundle input validation, resource limits, repository writes, and concurrent apply behavior.

Node 22 or newer and Git 2.32 or newer are required. Existing bundle formats remain supported; malformed or unsafe bundles may now be rejected. Checksums establish integrity rather than sender identity. See SECURITY.md for scope and limitations.
