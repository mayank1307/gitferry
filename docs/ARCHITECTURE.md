# Repository structure

GitFerry is one TypeScript package with a CLI, a local MCP server, and reusable core operations.

```text
src/
  core/              Git, bundle, validation, apply, and QR operations
  index.ts           Public core library exports
  cli.ts             CLI commands, including `gitferry mcp`
  mcp.ts             Executable stdio MCP entry point
  mcp/server.ts      Transport-independent server factory and tool definitions
  version.ts         Shared executable/server version
test/                Core and MCP integration tests using temporary repositories
examples/mcp/        Client configuration templates
docs/                Architecture and deployment guides
scripts/             Build, artifact verification, and publication commands
.github/workflows/   Cross-platform validation and tagged releases
server.json          Official MCP Registry metadata for npm distribution
Dockerfile           Optional local stdio container
dist/                Generated JS, type declarations, and standalone bundles
release/             Generated release assets and checksums
```

The CLI and MCP tools call the same core functions. MCP tool registration lives in `createGitFerryServer()`, which returns a fresh server without starting a process or connecting a transport. `src/mcp.ts` owns stdio startup; its executable paths remain stable for existing clients.

After building, ESM consumers can import core operations from `gitferry` or the factory from `gitferry/mcp`. Each connection needs its own factory instance. Importing the factory does not read stdin or write stdout. Transport owners connect and close their instances.

The public tools remain `pack_changes`, `inspect_bundle`, and `apply_bundle`. Tool results include human-readable text and structured content; operational failures return `isError`. Existing contract tests exercise real MCP connections and Git repositories, including both executable routes.

`npm run build` cleans and compiles `dist/`. `npm run bundle` also creates standalone CommonJS executables for offline use. `npm pack` runs that bundle build automatically. Generated outputs stay out of Git. See [deployment](DEPLOYMENT.md) and [publishing](../PUBLISHING.md) for operational steps.
