# Installing GitFerry

GitFerry requires **Node.js 22 or newer** and **Git 2.32 or newer**. It runs locally, including its MCP server. npm installation needs registry access for dependencies; the standalone files run offline.

**v0.4.0 is publicly available.** [npm package](https://www.npmjs.com/package/gitferry/v/0.4.0) · [v0.4.0 release and downloads](https://github.com/mayank1307/gitferry/releases/tag/v0.4.0) · [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mayank1307%2Fgitferry/versions/0.4.0)

## Online installation

```bash
npm install -g gitferry@0.4.0
gitferry --version
gitferry --help
```

## MCP client setup

### Clients using `mcpServers` JSON

Global installation is optional. Merge the following server entry into your client’s MCP configuration (preserve any existing servers), or copy [examples/mcp/npm.json](examples/mcp/npm.json):

```json
{
  "mcpServers": {
    "gitferry": {
      "command": "npx",
      "args": ["--yes", "--package=gitferry@0.4.0", "gitferry-mcp"]
    }
  }
}
```

This configuration launches a local process. Pinning the version makes updates deliberate. `npx` downloads the package and dependencies on first use, so use the standalone installation in restricted environments.

Clients have different configuration locations and formats. Use their MCP settings to launch `gitferry-mcp` after a global install, or `node` with the absolute standalone path below. JSON `mcpServers` examples are for clients that support that format.

### Claude Code

Register the local server with a pinned npm package:

```bash
claude mcp add --transport stdio gitferry -- npx --yes --package=gitferry@0.4.0 gitferry-mcp
claude mcp get gitferry
```

After a global installation, you can instead use `claude mcp add --transport stdio gitferry -- gitferry-mcp`. Choose one registration method. See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) for scopes and configuration locations.

### VS Code

For VS Code’s workspace MCP configuration, merge [examples/mcp/vscode.json](examples/mcp/vscode.json) into `.vscode/mcp.json`:

```json
{
  "servers": {
    "gitferry": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=gitferry@0.4.0", "gitferry-mcp"]
    }
  }
}
```

Use the server controls in the MCP configuration editor to start it. See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) for workspace and user-profile formats.

### Connect and verify

Restart or reconnect the client after configuration changes. Confirm it lists `pack_changes`, `inspect_bundle`, and `apply_bundle`. Provide absolute paths and start with a small disposable repository: “Pack the uncommitted changes in /absolute/path/to/repo into /absolute/path/to/transfer.gitferry.” Inspect the bundle and dry-run its application before applying it. No GitFerry API key or account is needed; these tools run on the client machine. The MCP Registry URL is discovery metadata, not an HTTP endpoint to paste into a URL-only client.

On Windows, clients that cannot launch `npx` directly can use `"command": "cmd"` and `"args": ["/c", "npx", "--yes", "--package=gitferry@0.4.0", "gitferry-mcp"]`. The standalone Node configuration below is another option.

## Offline installation

Download these files from the [public v0.4.0 release](https://github.com/mayank1307/gitferry/releases/tag/v0.4.0) on a connected machine:

- `gitferry.cjs` — standalone CLI
- `gitferry-mcp.cjs` — standalone MCP server
- `SHA256SUMS` — checksums for the release assets

Transfer the standalone files and checksums to the disconnected machine. Both `.cjs` files embed their JavaScript dependencies; no npm install or administrator access is needed on the target machine. The target still needs Node and Git.

Verify transferred files against the checksums obtained through your trusted release channel. On macOS/Linux, compare `shasum -a 256 gitferry.cjs gitferry-mcp.cjs` with the matching entries in SHA256SUMS. If you download all five release assets, `shasum -a 256 -c SHA256SUMS` verifies the complete set. On Windows, compare `Get-FileHash -Algorithm SHA256` output with SHA256SUMS.

```bash
node /absolute/path/to/gitferry.cjs --version
node /absolute/path/to/gitferry.cjs pack -C /absolute/path/to/repo
```

Configure the local MCP server:

```json
{
  "mcpServers": {
    "gitferry": {
      "command": "node",
      "args": ["/absolute/path/to/gitferry-mcp.cjs"]
    }
  }
}
```

On Windows, use an absolute path such as `C:\\Tools\\gitferry-mcp.cjs` in JSON. The server communicates over stdin/stdout and normally waits silently; verify connection through your MCP client rather than expecting a web page.

A `.tgz` from `npm pack` contains GitFerry but does **not** embed its npm dependencies. Installing it with `npm install -g ./gitferry-0.4.0.tgz` can still contact the npm registry. Use the standalone `.cjs` files for a disconnected target.

## Build from source

```bash
git clone https://github.com/mayank1307/gitferry.git
cd gitferry
git checkout v0.4.0
npm ci
npm run bundle
node dist/gitferry.cjs --version
```

The standalone executables are generated in `dist/`. To develop against the latest source instead, stay on `main`; post-release documentation updates do not change the immutable v0.4.0 artifacts.

## Target with only Git and unzip

Create a portable bundle on the sending machine:

```bash
gitferry pack --portable -o transfer.gitferry
```

On the target, extract it into a fresh directory and review its README.txt for manual commands. Manual extraction/application bypasses GitFerry's validation and protections; use only trusted bundles and review paths and patches first. GitFerry itself is not installed on this target.

The compact default format starts with `GFBR` and needs GitFerry or Node to unwrap. Use `--portable` when the target only has Git and unzip.

## Verify the installation

Follow [DEMO.md](DEMO.md) to pack changes, inspect the bundle, dry-run it, and apply it to a disposable clone. In an MCP client, verify the three tools appear: `pack_changes`, `inspect_bundle`, and `apply_bundle`.

## Troubleshooting

- **Command not found:** ensure Node, Git, and the global npm executable directory are on the MCP client's PATH. Desktop clients may need an absolute Node path or a restart after environment changes.
- **Global installation permission error:** use `npx` or the standalone file instead of changing permissions on system directories.
- **MCP connection hangs:** stdio servers wait for a client handshake. Use the MCP client to connect; do not send ordinary terminal text to stdout.
- **Bundle rejected:** read the error before using `force`. Checksums, path validation, and size limits protect the receiver; `force` only bypasses the documented repository/overwrite guards.
- **Older Node:** upgrade to the supported runtime. The bare Git/unzip fallback is available for trusted portable bundles.
