# gitferry — Usage Scenarios

Every situation where gitferry earns its keep, with the exact commands for each side of the gap. The common thread: **two copies of the same repo that cannot sync over a network** (or shouldn't).

> Quick sanity check first: if both machines can reach a shared git remote, just `git push` / `git pull`. gitferry is for when they can't.

---

## 1. Air-gapped / classified environment

**Signal:** the target machine has no internet, no VPN, no shared git server — only approved file transfer (USB, data diode, secure upload portal).

You develop on a connected machine; the real build/test/deploy repo lives inside the closed network.

```bash
# outside (connected machine)
gitferry pack --base origin/main -o transfer.gitferry
# → carry transfer.gitferry through the approved channel

# inside (closed machine)
gitferry inspect transfer.gitferry        # verify integrity BEFORE touching the repo
gitferry apply transfer.gitferry --dry-run
gitferry apply transfer.gitferry
```

Why gitferry here: checksums prove the file survived the transfer channel intact; the repo-fingerprint check proves it's being applied to the right repo; untracked files (new configs, assets) travel too.

---

## 2. Client site with a locked-down laptop

**Signal:** you work on a client's machine that can't reach your company's git server (or vice versa), and you need to take the day's work home — or bring yesterday's work in.

```bash
# end of day at client site
gitferry pack --base <last-synced-sha> -o day3-work.gitferry
# transfer via whatever the client allows (their secure share, encrypted USB)

# back at your machine
gitferry apply day3-work.gitferry
git push   # now it reaches your real remote
```

The bundle captures *everything* including half-done uncommitted work, so you don't have to fake a "WIP" commit on the client's machine just to move it.

---

## 3. Two of your own machines, no remote for WIP

**Signal:** desktop at the office, laptop at home; you don't want to push broken WIP to the shared remote just to move it between them.

```bash
# office desktop, 6pm — mid-refactor, tests failing, notes everywhere
gitferry pack -o ~/Dropbox/wip.gitferry     # or AirDrop, scp, email to yourself

# home laptop
gitferry apply wip.gitferry
# → same staged/unstaged split, same untracked notes — resume exactly where you stopped
```

Unlike pushing a WIP branch: no polluted remote history, and untracked scratch files (`NOTES.md`, `.env.local`, test fixtures) come along.

---

## 4. Handing changes to a teammate without pushing

**Signal:** "can you try my fix?" — but the fix isn't ready for a branch, or the teammate can't fetch your fork, or you're both offline (plane, retreat, outage).

```bash
# you
gitferry pack --base origin/main -o fix-attempt.gitferry
# send over Slack/email/USB — it's one small checksummed file

# teammate
gitferry inspect fix-attempt.gitferry     # see exactly what's inside before applying
gitferry apply fix-attempt.gitferry --dry-run
gitferry apply fix-attempt.gitferry
```

If they hate it: `git am --abort`-style recovery, or just `git reset --hard` + delete the untracked files listed by `inspect`.

---

## 5. Code review without a forge

**Signal:** no GitHub/GitLab in the environment, but you still want review before merging.

```bash
# author
gitferry pack --base main -o review-JIRA-123.gitferry

# reviewer
gitferry inspect review-JIRA-123.gitferry   # commit list + diffstat without applying
gitferry apply review-JIRA-123.gitferry -C /tmp/review-checkout   # into a scratch clone
git log -p main..HEAD                        # review with full local tooling
```

`inspect` alone answers "what would this do to my repo" — nothing is applied until you say so.

---

## 6. Deploying a hotfix into a restricted environment

**Signal:** production-adjacent machine (jump host, on-prem appliance, factory floor PC) has the repo but no route to your remote; a fix must land *now*.

```bash
# dev machine
gitferry pack --base <sha-running-in-prod> -o hotfix.gitferry

# restricted machine
gitferry apply hotfix.gitferry --dry-run    # prove it lands cleanly before touching anything
gitferry apply hotfix.gitferry
./run-tests && ./restart-service
```

The base-commit validation is the safety net: if the appliance's checkout isn't at the sha you built against, you're warned *before* anything is modified.

---

## 7. Offline build / test machine

**Signal:** a build server or test rig is deliberately offline (license constraints, reproducibility, security), and you iterate against it.

```bash
# loop:
gitferry pack --base $(git merge-base HEAD origin/main) -o try.gitferry
scp try.gitferry buildbox:            # or USB if truly air-gapped
# on buildbox:
gitferry apply try.gitferry && make test
# next iteration: reset buildbox to base, apply the new bundle
git reset --hard <base> && git clean -fd
```

---

## 8. Snapshot before a risky operation

**Signal:** about to run a gnarly rebase / conflict-heavy merge / history rewrite, and `git stash` feels too fragile (stashes don't capture untracked-by-default, aren't portable, die with the machine).

```bash
gitferry pack --base origin/main -o ~/backups/pre-rebase-$(date +%F).gitferry
git rebase -i origin/main    # go wild — your exact state is one file, restorable anywhere
```

A bundle is a *portable, checksummed, self-describing* snapshot — it survives `rm -rf`, works on a different machine, and `inspect` tells future-you what's inside.

---

## 9. Email/chat-friendly patch sharing (the modern `format-patch`)

**Signal:** you'd have used `git format-patch` + mailing-list style flow, but you also have uncommitted bits and new files, and you want the receiver to have validation.

```bash
gitferry pack --base v2.1.0 -o feature-for-upstream.gitferry
# attach to email — one file instead of 0001-*.patch + "oh and also create these files"
```

Receiver without gitferry can still unzip it and `git am` the patches — pack with `--portable` for a plain zip; instructions are inside the bundle (`README.txt`).

---

## 10. Migrating work when policy blocks remotes

**Signal:** compliance forbids pushing this code to any network remote (pre-disclosure security fix, embargoed research, legal hold), but the work must move between authorized machines.

```bash
gitferry pack --base <shared-sha> -o embargoed.gitferry
# move via the approved channel; sha256 manifest doubles as a transfer record
gitferry inspect embargoed.gitferry   # audit exactly what crossed the boundary
```

`manifest.json` inside the bundle is an itemized, checksummed record of every byte transferred — useful when someone later asks "what exactly moved?"

---

## 11. Partial transfers — only what you mean to send

**Signal:** you want *some* of your state to travel, not all of it.

Running `gitferry pack` in a terminal asks directly:

```
what should travel?
  1. all          commits + staged + unstaged + untracked
  2. uncommitted  staged + unstaged + untracked (no commits)  ← default
  3. staged       staged edits only
  4. unstaged     unstaged edits + untracked files
  5. committed    unpushed commits only
```

Or skip the question with flags (also what scripts use — without a TTY, pack takes everything):

```bash
gitferry pack --only staged             # exactly what's in the index — "ship what I reviewed"
gitferry pack --only unstaged           # the experiments you haven't staged, incl. new files
gitferry pack --only committed          # clean commits only — like format-patch, but validated
gitferry pack --only uncommitted        # everything that isn't committed yet
gitferry pack --no-untracked            # trim untracked from any of the above (combinable)
gitferry apply bundle.gitferry --no-untracked   # receiver-side: skip the untracked files
```

---

## 12. Let an agent do it (MCP)

**Signal:** you drive your workflow through Claude Code or another MCP client and want this as a conversational step.

```bash
claude mcp add --transport stdio gitferry -- npx --yes --package=gitferry@0.4.0 gitferry-mcp
```

Then, in conversation:

- *"Pack everything I've changed since origin/main into a bundle on the Desktop"* → `pack_changes`
- *"What's inside transfer.gitferry? Is it safe to apply?"* → `inspect_bundle`
- *"Dry-run this bundle against ~/work/repo, then apply if clean"* → `apply_bundle`

The agent gets structured JSON back (steps, warnings, skipped files), so it can reason about conflicts and report to you.

---

## 13. The receiving machine has nothing but git

**Signal:** worst case — target machine has git and unzip, and you can't install anything (no Node, no npm, nothing).

```bash
# pack with --portable on the sending side so plain unzip works here
unzip transfer.gitferry -d bundle/
cat bundle/README.txt          # the bundle documents its own application
git am -3 bundle/commits/*.patch
git apply -3 --index bundle/worktree/staged.patch
git apply bundle/worktree/unstaged.patch
cp -R bundle/untracked/. .
```

Every bundle is a zip of standard git patches by design (`--portable` = plain zip; the compact default wraps it in brotli and unwraps with a Node one-liner shown in README.txt). The tool is convenience + validation, never a gatekeeper.

Middle ground: if the machine has Node ≥18 but no npm access, copy the single-file `dist/gitferry.cjs` (~760 KB) alongside the bundle and run `node gitferry.cjs apply transfer.gitferry`.

---

## 14. No file channel at all — beam it through the screen

**Signal:** the machines can't even exchange a file (no USB ports, no shared drive, no email between zones) — but they're in the same room, or one can see the other's screen. Any webcam becomes the transfer channel.

```bash
# sender — plays the bundle as a looping sequence of numbered QR codes
gitferry show transfer.gitferry              # in the terminal
gitferry show transfer.gitferry --browser    # bigger/denser browser page
gitferry show transfer.gitferry --color      # experimental 3x: chunks ride the R/G/B channels

# receiver — point its webcam at the sender's screen
gitferry read                                # local camera page; shows which chunk numbers are still missing
gitferry apply transfer.gitferry
```

Every frame is numbered (`chunk 17/117`) and stamped with the transfer's id, so the receiver can prove completeness: it keeps collecting across loops (missed frames come around again) and only writes the file when all numbers are present *and* the whole-file sha256 matches. Then `apply`'s own per-entry checksums verify it a second time. Both sides talk only to `127.0.0.1` — the light between the screens is the network.

Works for the same-room case, and equally over a video call with screen share (webcam pointed at a monitor showing the shared screen is the low-tech fallback; a crisp screen-share window scans far better).

---

## 15. Recovery scenarios (when apply doesn't go cleanly)

| Situation | What happens | What you do |
|---|---|---|
| Target repo has local commits touching other lines | 3-way merge, applied cleanly, warning shown | review with `git log`, done |
| Target repo edited the *same* lines | `git am` stops mid-way with standard conflict markers | fix conflicts → `git am --continue`, or undo all → `git am --abort` |
| Target working tree is dirty | refused before any change | commit/stash first, or `--force` if you accept the mix |
| Bundle's untracked file already exists locally | that file is skipped, everything else applies | keep yours, or re-apply with `--force` to overwrite |
| Bundle corrupted in transit | checksum mismatch — refused entirely | re-create/re-transfer the bundle |
| Wrong repo entirely | fingerprint mismatch — refused | double-check; `--force` only if you truly know better |
| Patches too diverged even for 3-way | best-effort apply + `.rej` files, or clean failure with guidance | hand-merge the `.rej` hunks, or re-pack against a base both sides share |

---

## When **not** to use gitferry

- **Both machines reach a common remote** → `git push` / `git pull`. Always.
- **Transferring a whole repository** (history included, no repo on the other side yet) → `git bundle` is built for exactly that; gitferry assumes the repo already exists on both ends.
- **The packed range contains merge commits** → `format-patch` flattens them; pack warns you. Use a linear branch or transfer via `git bundle`.
- **Git LFS-heavy repos** → LFS pointers travel, the large objects don't. Move LFS objects separately.
- **Continuous, high-frequency sync** → this is a courier, not a sync daemon; if you're doing it every 10 minutes, you want a network solution (or `git bundle` over a scheduled channel).
