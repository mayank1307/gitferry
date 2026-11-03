# gitferry

**Portable git-change bundles for air-gapped repos.** Pack your unpushed commits, staged/unstaged changes, and untracked files into a single shareable file on one machine — carry it across the air gap (USB, secure file transfer, email, or QR codes across a webcam) — validate and apply it to the same repo on another machine. No shared remote, no network, no sync required.

```
machine A (has your changes)          machine B (same repo, no sync)
┌─────────────────────────┐           ┌─────────────────────────┐
│ $ gitferry pack         │  ──────▶  │ $ gitferry apply        │
│   → repo-main-a1b2c3d   │  USB /    │   ✓ checksums verified  │
│     .gitferry           │  scp /    │   ✓ same repo confirmed │
│                         │  email    │   ✓ 2 commits replayed  │
│  commits + worktree     │           │   ✓ staged/unstaged     │
│  + untracked, checksummed│          │     state restored      │
└─────────────────────────┘           └─────────────────────────┘
```

See [SCENARIOS.md](SCENARIOS.md) for every situation this is built for — air-gapped environments, client-site work, WIP handoffs, offline review, and more. See [INSTALL.md](INSTALL.md) for offline installation on other devices.

## Why not just `git format-patch` / `git bundle`?

You can — gitferry *uses* them under the hood. What raw git doesn't give you:

- **Untracked files travel too** (respecting `.gitignore`) — `git diff` never sees them
- **Staged vs unstaged state is preserved** — your index looks the same on the other side
- **Validation before anything touches the repo**: sha256 checksums of every file, same-repository fingerprint check (root commits), base-commit check, clean-tree check
- **One command each way** instead of a multi-step `format-patch`/`diff`/`am`/`apply` choreography
- **Binary-safe** (`--binary` patches for tracked files, verbatim bytes for untracked)
- **Plain-git fallback**: the bundle is a zip of standard git patches — pack with `--portable` and a machine with only git + unzip applies it by hand (instructions are inside every bundle; the compact default needs node's one-liner to unwrap first)

## Install

```bash
npm install -g gitferry@0.4.0
```

### Closed environments (no npm)

Requires Node.js 22 or newer and Git 2.32 or newer. The commands above target the upcoming 0.4.0 release; they work once it is published. To try this checkout now, run `npm ci && npm run bundle` and configure the local MCP entry point below.

Build self-contained files and copy them anywhere Node.js 22 or newer exists:

```bash
npm run bundle                 # → dist/gitferry.cjs + dist/gitferry-mcp.cjs
node gitferry.cjs pack         # runs without any install or node_modules
```

## Usage

### On the machine with changes

```bash
gitferry pack                          # asks what should travel (Enter = uncommitted); base = merge-base with upstream
gitferry pack --only staged            # skip the question: all | uncommitted | staged | unstaged | committed | repo
gitferry pack --only repo              # whole-repo snapshot: every tracked file as-is — seed/sync another machine
gitferry pack --base origin/main       # explicit base
gitferry pack -o changes.gitferry --no-untracked
```

The interactive picker only appears in a terminal; in scripts (no TTY) `pack` takes everything unless `--only` or `--no-*` flags say otherwise. Selections mean: **all** = commits + staged + unstaged + untracked · **uncommitted** = everything except commits · **staged** = index edits only · **unstaged** = worktree edits + untracked · **committed** = unpushed commits only · **repo** = a snapshot of every tracked file as it is on disk (no history) — apply seeds a bare directory or syncs an existing checkout, skipping identical files and touching drifted ones only with `--force`.

### On the receiving machine

```bash
gitferry inspect changes.gitferry      # verify + preview, touches nothing
gitferry apply changes.gitferry --dry-run
gitferry apply changes.gitferry
```

### No transfer channel at all? Beam it over QR

When even USB is off the table, the screen itself is the channel: one machine plays the bundle as a looping sequence of QR codes, the other watches with any webcam.

```bash
# machine A (sender)
gitferry show changes.gitferry             # QR loop right in the terminal
gitferry show changes.gitferry --browser   # bigger + denser, in a local browser page
gitferry show changes.gitferry --color     # experimental: 3x density, 3 chunks per image in R/G/B

# machine B (receiver) — point its webcam at A's screen
gitferry read                              # opens a local camera page, reassembles the bundle
gitferry apply changes.gitferry
```

Every QR frame carries its **chunk number / total** plus a transfer id, so the receiver knows exactly which pieces it still needs — it shows the missing numbers live and keeps collecting as the loop repeats (order doesn't matter; missed frames come around again). The file is only written once **every numbered chunk arrived and the whole-file sha256 matches**, so a completed `read` is proof nothing was skipped or corrupted. Both pages live on `127.0.0.1`; no network between the machines is used or needed.

**Point the sender's webcam back at the receiver and the loop gets smart.** The `read` page displays a small **progress QR** of its own (tiny payload, high error correction, so it scans easily). If the `show --browser` machine also has a camera watching the receiver's screen, then after each loop the sender re-shows **only the chunks that are still missing**, dropping from the first-loop rate (default 4 fps) to a slower retry rate (default 1 fps, `--retry-fps`) so the stragglers are easy to catch — and stops automatically once the receiver's code says *complete*. No camera on the sender's side? Everything simply loops at full speed like before.

Throughput is roughly `chunk × fps`: defaults give ~0.3 KB/s in the terminal, ~0.6 KB/s in the browser, ~1.8 KB/s with `--color` — meant for patch-sized bundles, not megabyte piles (`pack --no-untracked` helps keep them small). The default is deliberately a **coarse, easy-scan code** (150 bytes ≈ QR version 8, 49×49 modules): webcams reading another screen fail on fine modules long before they fail on frame count. Raise `--chunk` (up to 2900) if your camera and screens are good.

### Applying

Apply order: commits (`git am -3`, full author/date/message preserved) → staged patch (index + worktree) → unstaged patch (worktree only) → untracked files (never overwrites existing files unless `--force`).

On conflicts you get standard git conflict markers and clear instructions (`git am --continue` / `--abort`, `.rej` files as last resort) — application is not transactional, so review the error and recovery instructions before continuing.

### Flags

| Flag | Command | Effect |
|------|---------|--------|
| `--base <ref>` | pack | commit the bundle applies onto |
| `--only <what>` | pack | `all` / `uncommitted` / `staged` / `unstaged` / `committed` / `repo` — non-interactive selection |
| `--no-commits` / `--no-worktree` / `--no-untracked` | pack | trim what's captured (combinable with `--only`) |
| `--portable` | pack | plain-zip bundle (~30% bigger) for targets with only git + unzip |
| `--dry-run` | apply | validate + show the plan, change nothing |
| `--force` | apply | override same-repo, clean-tree, and overwrite guards |
| `-C <dir>` | pack/apply | run against another directory |
| `--chunk <bytes>` / `--fps <n>` | show | QR payload size (default 150 ≈ version-8 code; raise for speed, lower for even easier scanning) and first-loop display speed |
| `--retry-fps <n>` | show | slower rate for re-loops of missing chunks once the receiver's progress QR is seen (default 1) |
| `--browser` / `--color` | show | browser-page display; experimental 3× density via R/G/B channels |
| `--no-open` / `--port <n>` | show/read | don't auto-open the local page / pin its port |
| `-o <file>` / `--force` | read | output path / overwrite an existing file |

## MCP server

GitFerry runs locally over **stdio**. Your MCP client starts the process, and it works with repositories on that same machine. No GitFerry account, API key, hosted service, or source upload is required. URL-only MCP clients need a separate bridge and cannot connect directly to this local server.

After 0.4.0 is published, use this configuration in clients that accept `mcpServers` JSON. The explicit executable matters because this package supplies both a CLI and an MCP server:

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

For a source checkout or offline installation, build with `npm run bundle` and use:

```json
{
  "mcpServers": {
    "gitferry": {
      "command": "node",
      "args": ["/absolute/path/to/gitferry/dist/gitferry-mcp.cjs"]
    }
  }
}
```

If you installed the package globally, the server command is `gitferry-mcp`.

| Tool | Action | Key arguments |
|------|--------|---------------|
| `pack_changes` | Writes a portable bundle from local changes | `cwd`, optional `output`, `base`, `only`, `portable` and include flags |
| `inspect_bundle` | Reads and validates a bundle without changing a repository | `bundlePath` |
| `apply_bundle` | Previews or applies a bundle to a local target | `cwd`, `bundlePath`, `dryRun`, `force`, `includeUntracked` |

Use absolute paths. Start with: *“Pack the uncommitted changes in /absolute/path/to/repo into /absolute/path/to/transfer.gitferry.”* On the receiving machine: *“Inspect this bundle, then dry-run it against /absolute/path/to/repo and show the plan before applying.”*

`only` accepts `all`, `uncommitted`, `staged`, `unstaged`, `committed`, or `repo`. Snapshot mode (`repo`) carries current tracked-file contents rather than history; it can seed an empty directory. The default without a selection includes all change categories, matching non-interactive CLI use. Tool annotations describe side effects to the client; they do not enforce approvals or restrict filesystem access.

See [INSTALL.md](INSTALL.md) for setup and offline transfer, [DEMO.md](DEMO.md) for a two-repository walkthrough, and [PUBLISHING.md](PUBLISHING.md) for maintainer release steps. Proposed registry identity: `io.github.mayank1307/gitferry`.

## Bundle format

A `.gitferry` file is a zip with this layout — by default **brotli-wrapped** (`GFBR` magic + brotli stream of a stored zip, ~30% smaller than a deflate zip; `pack --portable` writes a plain zip instead, and `inspect`/`apply` auto-detect both):

```
manifest.json            # versioned manifest: repo fingerprint, base/head shas,
                         # content listing, sha256 of every entry
commits/00NN-*.patch     # git format-patch output (mbox — author, date, message)
worktree/staged.patch    # git diff --binary --cached
worktree/unstaged.patch  # git diff --binary
untracked/<paths>        # verbatim file bytes
README.txt               # human instructions for manual apply with plain git
```

Everything inside is standard-git-consumable by design; gitferry adds integrity checking and one-command UX, never a proprietary encoding. For a target with only git + unzip, pack with `--portable`; the compact default can still be unwrapped by any machine with node (the one-liner is in the bundle's own README.txt).

## Notes & limitations

- Merge commits in the packed range are flattened by `format-patch` — pack warns; prefer linear branches or pick a different `--base`
- Replayed commits get new shas (same content/author, new committer) — normal for `git am`
- Change bundles require shared repository history (validated via root-commit fingerprint); snapshot bundles can also seed an empty directory.
- Requires git ≥ 2.32 on the applying machine

## Safety and trust

Bundles contain source code, commit messages, and potentially untracked secrets. Review the selection and destination before sharing. `.gitignore` excludes ignored untracked files; it does not remove secrets already tracked in Git. Checksums detect corruption, not the identity or trustworthiness of the sender. Only apply bundles from sources you trust.

The server has the filesystem privileges of the process that starts it. Configure it only in trusted clients and run it as your normal user. `force` bypasses repository, dirty-tree, and overwrite guards. See [SECURITY.md](SECURITY.md) for enforced limits, symlink behavior, and concurrency boundaries.

## Development

See [repository architecture](docs/ARCHITECTURE.md) for the source layout and [MCP deployment](docs/DEPLOYMENT.md) for local, npm, and Docker setup. Copyable client configurations live in [examples/mcp](examples/mcp).

```bash
npm ci
npm run build     # tsc → dist/
npm test          # vitest: round-trip e2e on real temp repos + guard tests
npm run bundle    # fresh single-file CLI + MCP server
npm run release:check  # versions, build, tests, and isolated package smoke test
```
