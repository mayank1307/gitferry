# Installing GitFerry

GitFerry requires **Node.js 22 or newer** and **Git 2.32 or newer**. It runs locally, including its MCP server. npm installation needs registry access for dependencies; the standalone files run offline.

**v0.4.2 is publicly available.** [npm package](https://www.npmjs.com/package/gitferry/v/0.4.2) · [v0.4.2 release and downloads](https://github.com/mayank1307/gitferry/releases/tag/v0.4.2) · [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mayank1307%2Fgitferry/versions/0.4.2)

## Online installation

```bash
npm install -g gitferry@0.4.2
gitferry --version
gitferry --help
```

## MCP client setup

### Installation versus registration

`npm install -g gitferry@0.4.2` installs the CLI and MCP server executables. It does not add the server to any MCP client. Registration saves the launch command in the selected client's configuration; reconnecting that client starts the local server and discovers its tools.

Choose one launch method: pinned `npx` (downloads the package on first launch), globally installed `gitferry-mcp`, or `node` with an absolute standalone file path. Then register that command in each client you want to use. For the pinned `npx` examples below, no separate global installation is needed. Codex CLI or Claude Code must already be installed to use their registration commands.

### Codex

Register and inspect the pinned local server:

```bash
codex mcp add gitferry -- npx --yes --package=gitferry@0.4.2 gitferry-mcp
codex mcp get gitferry
codex mcp list
```

Alternatively, merge [examples/mcp/codex.toml](examples/mcp/codex.toml) into `~/.codex/config.toml`, preserving other settings and any existing server entries. Use this configuration method instead of adding a second GitFerry entry:

```toml
[mcp_servers.gitferry]
command = "npx"
args = ["--yes", "--package=gitferry@0.4.2", "gitferry-mcp"]
```

For a global installation, use `codex mcp add gitferry -- gitferry-mcp`. For an offline standalone file, use `codex mcp add gitferry -- node /absolute/path/to/gitferry-mcp.cjs`. Choose one method. GitFerry uses local stdio and does not need `codex mcp login` or OAuth.

Reconnect or start a new Codex session. In the CLI, use `/mcp` to inspect active servers and their tools. `codex mcp get` and `codex mcp list` check saved registration; they do not establish that the current session has discovered tools. See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) for configuration locations and client-specific reconnection steps.

### Clients using `mcpServers` JSON

Global installation is optional. Merge the following server entry into your client’s MCP configuration (preserve any existing servers), or copy [examples/mcp/npm.json](examples/mcp/npm.json):

```json
{
  "mcpServers": {
    "gitferry": {
      "command": "npx",
      "args": ["--yes", "--package=gitferry@0.4.2", "gitferry-mcp"]
    }
  }
}
```

This configuration launches a local process. Pinning the version makes updates deliberate. `npx` downloads the package and dependencies on first use, so use the standalone installation in restricted environments.

Clients have different configuration locations and formats. Use their MCP settings to launch `gitferry-mcp` after a global install, or `node` with the absolute standalone path below. JSON `mcpServers` examples are for clients that support that format.

### Claude Code

Register the local server with a pinned npm package:

```bash
claude mcp add --transport stdio gitferry -- npx --yes --package=gitferry@0.4.2 gitferry-mcp
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
      "args": ["--yes", "--package=gitferry@0.4.2", "gitferry-mcp"]
    }
  }
}
```

Use the server controls in the MCP configuration editor to start it. See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) for workspace and user-profile formats.

### Agent-assisted installation

Ask Codex or Claude Code to perform setup using this prompt:

> Set up GitFerry v0.4.2 as a local stdio MCP server in this client using https://github.com/mayank1307/gitferry/blob/main/INSTALL.md. Check Node.js 22+ and Git 2.32+. Check for an existing GitFerry registration, preserve other servers, and register the pinned npx command for this client. A global npm install is optional. Verify the saved configuration, then verify that pack_changes, inspect_bundle, and apply_bundle are available. If a restart or new session is needed, tell me what to do and verify tool discovery afterward.

The agent needs terminal/configuration access and the client's normal approvals. Without that access it can provide the commands for you to run. Reading installation instructions alone does not automatically register or activate the MCP server.

### Connect and verify

Restart or reconnect the client after configuration changes. Confirm it lists `pack_changes`, `inspect_bundle`, and `apply_bundle`. Provide absolute paths and start with a small disposable repository: “Pack the uncommitted changes in /absolute/path/to/repo into /absolute/path/to/transfer.gitferry.” Inspect the bundle and dry-run its application before applying it. No GitFerry API key or account is needed; these tools run on the client machine. The MCP Registry URL is discovery metadata, not an HTTP endpoint to paste into a URL-only client.

On Windows, clients that cannot launch `npx` directly can use `"command": "cmd"` and `"args": ["/c", "npx", "--yes", "--package=gitferry@0.4.2", "gitferry-mcp"]`. The standalone Node configuration below is another option.

## Offline installation

Download these files from the [public v0.4.2 release](https://github.com/mayank1307/gitferry/releases/tag/v0.4.2) on a connected machine:

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

A `.tgz` from `npm pack` contains GitFerry but does **not** embed its npm dependencies. Installing it with `npm install -g ./gitferry-0.4.2.tgz` can still contact the npm registry. Use the standalone `.cjs` files for a disconnected target.

## Build from source

```bash
git clone https://github.com/mayank1307/gitferry.git
cd gitferry
git checkout v0.4.2
npm ci
npm run bundle
node dist/gitferry.cjs --version
```

The standalone executables are generated in `dist/`. To develop against the latest source instead, stay on `main`; post-release documentation updates do not change the immutable v0.4.2 artifacts.

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
