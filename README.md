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
- **Plain-git fallback**: the bundle is a standard zip of standard git patches — worst case, a machine with only git + unzip applies it by hand (instructions are inside every bundle)

## Install

```bash
npm install -g gitferry        # or: npm pack && npm i -g ./gitferry-0.1.0.tgz (offline)
```

### Closed environments (no npm)

Build one self-contained file and copy it anywhere Node ≥18 exists:

```bash
npm run bundle                 # → dist/gitferry.cjs (~760 KB, zero dependencies)
node gitferry.cjs pack         # runs without any install or node_modules
```

## Usage

### On the machine with changes

```bash
gitferry pack                          # asks what should travel (Enter = uncommitted); base = merge-base with upstream
gitferry pack --only staged            # skip the question: all | uncommitted | staged | unstaged | committed
gitferry pack --base origin/main       # explicit base
gitferry pack -o changes.gitferry --no-untracked
```

The interactive picker only appears in a terminal; in scripts (no TTY) `pack` takes everything unless `--only` or `--no-*` flags say otherwise. Selections mean: **all** = commits + staged + unstaged + untracked · **uncommitted** = everything except commits · **staged** = index edits only · **unstaged** = worktree edits + untracked · **committed** = unpushed commits only.

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

Throughput is roughly `chunk × fps`: defaults give ~0.6 KB/s in the terminal, ~3 KB/s in the browser, ~10 KB/s with `--color` — meant for patch-sized bundles, not megabyte piles (`pack --no-untracked` helps keep them small).

### Applying

Apply order: commits (`git am -3`, full author/date/message preserved) → staged patch (index + worktree) → unstaged patch (worktree only) → untracked files (never overwrites existing files unless `--force`).

On conflicts you get standard git conflict markers and clear instructions (`git am --continue` / `--abort`, `.rej` files as last resort) — never a half-broken repo without a way back.

### Flags

| Flag | Command | Effect |
|------|---------|--------|
| `--base <ref>` | pack | commit the bundle applies onto |
| `--only <what>` | pack | `all` / `uncommitted` / `staged` / `unstaged` / `committed` — non-interactive selection |
| `--no-commits` / `--no-worktree` / `--no-untracked` | pack | trim what's captured (combinable with `--only`) |
| `--dry-run` | apply | validate + show the plan, change nothing |
| `--force` | apply | override same-repo, clean-tree, and overwrite guards |
| `-C <dir>` | pack/apply | run against another directory |
| `--chunk <bytes>` / `--fps <n>` | show | QR payload size and display speed |
| `--browser` / `--color` | show | browser-page display; experimental 3× density via R/G/B channels |
| `--no-open` / `--port <n>` | show/read | don't auto-open the local page / pin its port |
| `-o <file>` / `--force` | read | output path / overwrite an existing file |

## MCP server (drive it from Claude or any agent)

```bash
claude mcp add gitferry -- gitferry-mcp
# closed env: claude mcp add gitferry -- node /path/to/gitferry-mcp.cjs
```

Exposes `pack_changes`, `inspect_bundle`, `apply_bundle` over stdio. Then: *"pack my changes here into a bundle"* / *"apply ~/transfer.gitferry to this repo and show me what changed"*.

## Bundle format

A `.gitferry` file is a plain zip:

```
manifest.json            # versioned manifest: repo fingerprint, base/head shas,
                         # content listing, sha256 of every entry
commits/00NN-*.patch     # git format-patch output (mbox — author, date, message)
worktree/staged.patch    # git diff --binary --cached
worktree/unstaged.patch  # git diff --binary
untracked/<paths>        # verbatim file bytes
README.txt               # human instructions for manual apply with plain git
```

Everything inside is standard-git-consumable by design; gitferry adds integrity checking and one-command UX, never a proprietary encoding.

## Notes & limitations

- Merge commits in the packed range are flattened by `format-patch` — pack warns; prefer linear branches or pick a different `--base`
- Replayed commits get new shas (same content/author, new committer) — normal for `git am`
- Both machines need the repo to share history (validated via root-commit fingerprint)
- Requires git ≥ 2.32 on the applying machine

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest: round-trip e2e on real temp repos + guard tests
npm run bundle    # single-file dist/gitferry.cjs + dist/gitferry-mcp.cjs
```
