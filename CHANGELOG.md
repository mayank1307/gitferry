# Changelog

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
