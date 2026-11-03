# Installing GitFerry

GitFerry requires **Node.js 22 or newer** and **Git 2.32 or newer**. It runs locally, including its MCP server. npm installation needs registry access for dependencies; the standalone files run offline.

Version 0.4.0 is the release being prepared. Registry commands below become available after publication. To use the source checkout today:

```bash
npm ci
npm run bundle
node dist/gitferry.cjs --version
```

## Online installation

```bash
npm install -g gitferry@0.4.0
gitferry --version
gitferry --help
```

For an MCP client, global installation is optional. Use explicit package and binary selection:

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

## Offline installation

On a connected build machine:

```bash
npm ci
npm run release:artifacts
```

Transfer the standalone CLI and MCP files plus SHA256SUMS from the generated release directory. Both `.cjs` files embed their JavaScript dependencies; no npm install or administrator access is needed on the target machine. The target still needs Node and Git.

Verify transferred files against the checksums obtained through your trusted release channel. On macOS/Linux, run `shasum -a 256 -c SHA256SUMS` from the directory containing the listed files. On Windows, compare `Get-FileHash -Algorithm SHA256` output with SHA256SUMS.

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
