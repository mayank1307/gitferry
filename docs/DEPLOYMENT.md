# Deploy GitFerry as an MCP server

GitFerry uses local stdio: the MCP client launches one server process and exchanges protocol messages on stdin/stdout. This follows the [MCP TypeScript SDK's local server transport](https://ts.sdk.modelcontextprotocol.io/server). No listening port or HTTP endpoint is configured. Repositories and bundle paths refer to the server's filesystem.

## Build and validate a checkout

Install Node.js 22 or newer and Git 2.32 or newer, then run at the repository root:

```sh
npm ci
npm run release:check
```

The release check validates metadata, builds, runs tests, and installs the actual npm tarball in a temporary project to verify all MCP entry points. It needs network access for package installation. For a shorter development loop use `npm run test:mcp`; `npm run typecheck` checks source types without producing artifacts.

## Local or offline installation

```sh
npm run bundle
```

Copy [examples/mcp/local.json](../examples/mcp/local.json) into a client's `mcpServers` configuration, replacing the absolute entry path. You can copy `dist/gitferry-mcp.cjs` to another machine with Node and Git without installing npm dependencies there. Restart or reconnect the client after changing its configuration. `npm run start:mcp` starts the compiled modular entry point for development; it waits for an MCP client on stdio.

## npm installation

After version 0.4.0 has been published, use [examples/mcp/npm.json](../examples/mcp/npm.json). It pins the package version and selects the MCP executable explicitly. A global installation can instead use the command `gitferry-mcp`. Source preparation does not publish anything; maintainers follow [PUBLISHING.md](../PUBLISHING.md) for npm and MCP Registry releases.

## Container installation

Build locally with Docker:

```sh
docker build --target runtime -t gitferry-mcp:local .
```

Use [examples/mcp/docker.json](../examples/mcp/docker.json), replacing the host workspace path. The client starts the container with `-i` to preserve stdin; do not add `-t` because a terminal can interfere with the protocol. No port mapping is needed. The runtime contains Node, Git, CA certificates, and the standalone MCP bundle; build tools and npm dependencies remain in the build stage.

Mount a workspace containing the repositories and bundle files you need. Tool arguments must use container paths such as `/workspace/source` and `/workspace/transfer.gitferry`. Mount destinations must be writable for packing or applying. The image runs as the `node` user (UID 1000). On Linux, add `--user` followed by your numeric `UID:GID` to the client args when host ownership differs. For commit replay, configure `user.name` and `user.email` in the target repository before launching; the container does not inherit your host's global Git configuration. Linked worktrees require their external Git directory to be mounted at a matching accessible path too.

The example disables container networking; GitFerry's tools operate locally. Use the full workspace mount only for trusted repositories. Mount a bundle directory read-only when only inspection is needed. GitFerry disables Git hooks, signing, and fsmonitor, but local Git configuration and filters remain trusted inputs; see [SECURITY.md](../SECURITY.md).

## Verify the connection

Confirm the client lists `pack_changes`, `inspect_bundle`, and `apply_bundle`. Use absolute paths to pack a small temporary repository, inspect its bundle, and call `apply_bundle` with `dryRun: true` against a matching target before applying. [DEMO.md](../DEMO.md) supplies a repeatable two-repository walkthrough.

Startup errors go to stderr; stdout is reserved for MCP messages. If a client cannot launch the server, check its Node/Git PATH, entry path, mount permissions, and stderr logs. A URL-only client requires a separate remote deployment design with access control and repository storage; the configurations here deploy the existing local server.
