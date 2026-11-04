# Post-0.4.2 discoverability to-dos

Plan for finishing directory placement and discoverability after the 0.4.2
release. This is discoverability only — **do not cut a new release or modify any
published artifact** (npm 0.4.2, the official MCP Registry record, or the GitHub
release). Created 2026-11-04.

## Canonical facts (keep every listing consistent with these)

- Repo: <https://github.com/mayank1307/gitferry> — MIT, Node >= 22, Git required.
- npm: `gitferry`, `latest` = 0.4.2. Official MCP Registry: `io.github.mayank1307/gitferry` (0.4.2 `isLatest`).
- Local **stdio** MCP server. Tools: `pack_changes`, `inspect_bundle`, `apply_bundle`.
- One-liner: Pack unpushed commits, worktree changes, and untracked files into one
  portable bundle, inspect it, and apply it to another repository for air-gapped transfer.

## Done

- [x] GitHub About: description, homepage (npm), and topics (`mcp`, `model-context-protocol`, `mcp-server`, `git`, `git-bundle`, `air-gapped`, `offline`, `cli`, `nodejs`).
- [x] README: quick MCP-install snippet near the top (links to the full MCP server section).
- [x] PUBLISHING.md: first-week monitoring + bad-release fix-forward recovery runbook.
- [x] `glama.json` at repo root (maintainer `mayank1307`).
- [x] Awesome MCP Servers PR opened: <https://github.com/punkpeye/awesome-mcp-servers/pull/18563> (Version Control category).

## To do — now (manual, maintainer sign-in)

- [ ] **Cursor** — submit at <https://cursor.directory> (sign in with GitHub/Google,
      use the new-plugin/MCP form, paste the repo URL). No PR route exists; the form
      is the only path. Self-managed, free.

## To do — monitor (a few days)

- [ ] **Awesome MCP Servers PR #18563** — respond only if a maintainer requests a
      change. It is opted into the `🤖🤖🤖` agent fast-track and may auto-merge.

## To do — verify ~1 week after release (registry auto-indexing)

These ingest the official registry, so they should appear without a submission.
Target check date: **~2026-11-11**.

- [ ] **Glama.ai** — once gitferry is listed, sign in and click **Claim ownership**;
      `glama.json` already names the maintainer, so the claim attaches to this repo.
      Re-run the claim flow if it does not pick up at first.
- [ ] **mcp.so** — search "gitferry"; no action if present.
- [ ] **PulseMCP** — search for it. If missing after ~1 week, email `hello@pulsemcp.com`
      with: registry name `io.github.mayank1307/gitferry`, repo URL, version `0.4.2`,
      and the one-line description. (Direct submit is paused; email is the fallback.)
- [ ] **VS Code gallery** — enable `chat.mcp.gallery.enabled`, open Extensions, search
      `@mcp`, and confirm gitferry appears.

Health spot-check:

```bash
npm view gitferry dist-tags        # latest should be 0.4.2
```

## Decided against

- **Smithery** — skipped. It is hosted-first (Dockerfile / WebSocket hosting), and
  gitferry is a local-only stdio server, so it is a marginal fit. A validated
  `smithery.yaml` (`target: local`, pinned to 0.4.2) can be added at the repo root
  if that changes.

## Guardrails for every remaining listing

- No new npm/registry version; never modify or re-upload an existing released artifact.
- Submit only under the maintainer's own accounts; never impersonate the project.
- Pause and review the exact submission content before any irreversible external action.
- Add a directory badge/link to the README only once that listing is actually live.
