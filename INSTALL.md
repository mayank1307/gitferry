# Installing gitferry on another device

Three install paths, by how locked-down the target device is. All of them are offline — nothing downloads anything.

## The transfer kit

Copy these files from this machine (all in `~/Documents/gitferry/`, regenerable with `npm pack` and `npm run bundle`):

| File | Size | Needs on target | Gives you |
|------|------|-----------------|-----------|
| `gitferry-0.1.0.tgz` | 216 KB | Node ≥18 + npm | full install: `gitferry` + `gitferry-mcp` commands on PATH |
| `dist/gitferry.cjs` | 278 KB | Node ≥18 only | single-file CLI, zero install |
| `dist/gitferry-mcp.cjs` | 760 KB | Node ≥18 only | single-file MCP server, zero install |

Verify integrity after transfer (sha256 for v0.1.0 as built on 2026-07-17):

```
31c757849021a5e7d4600960afb847670ef3635cbe23fb0ef7a312c3d06c4c94  gitferry-0.1.0.tgz
9c3869f8d051d3967eb8de66af64c2d04047fb42fb074c6be210257ba84a3a74  dist/gitferry.cjs
633c6921bba73a0a821d1f909250efc965b420a6968f9cf4194fee0c29828c9c  dist/gitferry-mcp.cjs
```

```bash
shasum -a 256 -c <<'EOF'   # macOS/Linux (on Windows: certutil -hashfile <file> SHA256)
31c757849021a5e7d4600960afb847670ef3635cbe23fb0ef7a312c3d06c4c94  gitferry-0.1.0.tgz
EOF
```

> If you re-build, checksums change — regenerate this table with
> `shasum -a 256 gitferry-*.tgz dist/*.cjs`.

---

## Path A — normal device (has npm + registry access): tarball install

```bash
# copy gitferry-0.1.0.tgz over, then:
npm install -g ./gitferry-0.1.0.tgz

# verify
gitferry --version        # → 0.1.0
gitferry --help
```

> ⚠️ The tarball contains gitferry itself but **not** its four dependencies — npm
> fetches those from the registry. If the device has no npm registry access
> (or a proxy that blocks it), use Path B instead: the `.cjs` files embed everything.

### Troubleshooting: `EACCES: permission denied, mkdir '/usr/local/lib/node_modules/...'`

The device's Node is a system install, so `npm -g` targets a root-owned directory. Fix without sudo (one-time, also fixes all future `npm -g`):

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
npm install -g ./gitferry-0.1.0.tgz
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # or .bashrc
source ~/.zshrc
```

(Or skip npm entirely with Path B — often easier on managed work machines. `sudo npm install -g` also works but runs install scripts as root; last resort.)

## Path B — restricted device (Node exists, npm blocked): single files

```bash
# copy dist/gitferry.cjs (and dist/gitferry-mcp.cjs if you want the MCP server)
node gitferry.cjs --version

# optional: make it feel installed
mkdir -p ~/bin && mv gitferry.cjs ~/bin/
echo 'alias gitferry="node ~/bin/gitferry.cjs"' >> ~/.zshrc   # or .bashrc
```

No `node_modules`, no install step, no admin rights. Each `.cjs` file is fully self-contained.

## Path C — bare device (only git + unzip): no install at all

You don't install gitferry — you only need it on the *packing* side. Every `.gitferry` bundle is a plain zip containing standard git patches and its own instructions:

```bash
unzip transfer.gitferry -d bundle/
cat bundle/README.txt        # exact apply commands for that specific bundle
```

---

## Registering the MCP server (per client)

Use the global command if you installed via **Path A**, or the absolute `.cjs` path for **Path B**.

**Claude Code:**
```bash
claude mcp add --scope user gitferry -- gitferry-mcp
# Path B: claude mcp add --scope user gitferry -- node /path/to/gitferry-mcp.cjs
claude mcp list              # → gitferry ... ✓ Connected
```

**Codex CLI:**
```bash
codex mcp add gitferry -- gitferry-mcp
```
or in `~/.codex/config.toml`:
```toml
[mcp_servers.gitferry]
command = "node"
args = ["/path/to/gitferry-mcp.cjs"]
```

**Cursor / Windsurf / VS Code / any stdio MCP client** — same shape in their JSON config:
```json
{ "mcpServers": { "gitferry": { "command": "node", "args": ["/path/to/gitferry-mcp.cjs"] } } }
```

---

## Smoke test on the new device (30 seconds)

```bash
cd /tmp && mkdir ferry-test && cd ferry-test
git init -qb main && git config user.email t@t.co && git config user.name t
echo one > f.txt && git add -A && git commit -qm base
echo two > f.txt && echo new > untracked.txt
gitferry pack -o /tmp/t.gitferry          # should report 1 modified + 1 untracked
gitferry inspect /tmp/t.gitferry          # → ✓ all checksums verified
```

## Requirements recap

| | Path A | Path B | Path C |
|---|---|---|---|
| git ≥ 2.32 | ✔ | ✔ | ✔ |
| Node ≥ 18 | ✔ | ✔ | — |
| npm | ✔ | — | — |
| npm registry access (for deps) | ✔ | — | — |
| admin rights | — | — | — |
| network | deps only | — | — |
