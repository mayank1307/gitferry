import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBundle } from "./bundle.js";
import { GitFerryError } from "./errors.js";
import {
  commitExists,
  git,
  hasTrackedChanges,
  headExists,
  repoRoot,
  resolveCommit,
  rootCommits,
  tryGit,
} from "./git.js";
import type { Manifest } from "./manifest.js";

export interface ApplyOptions {
  cwd: string;
  bundlePath: string;
  /** Skip repo-fingerprint / clean-tree / overwrite guards. */
  force?: boolean;
  /** Validate and report what would happen without changing anything. */
  dryRun?: boolean;
  includeUntracked?: boolean;
}

export interface ApplyResult {
  dryRun: boolean;
  manifest: Manifest;
  steps: string[];
  warnings: string[];
  appliedCommits: number;
  stagedApplied: boolean;
  unstagedApplied: boolean;
  untrackedWritten: string[];
  untrackedSkipped: string[];
}

export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  const includeUntracked = opts.includeUntracked ?? true;
  const warnings: string[] = [];
  const steps: string[] = [];

  // Integrity first: checksums + manifest schema (throws on any problem).
  const { entries, manifest } = readBundle(path.resolve(opts.cwd, opts.bundlePath));
  const { contents, repo } = manifest;

  const root = await repoRoot(opts.cwd);
  if (!(await headExists(root))) {
    throw new GitFerryError("target repository has no commits", "clone/fetch the shared history first — a gitferry bundle applies onto an existing base commit");
  }

  // --- Preflight -------------------------------------------------------------
  // 1. Same repo? Root-commit fingerprints must intersect.
  const localRoots = await rootCommits(root);
  const related = repo.rootCommits.some((r) => localRoots.includes(r));
  if (!related) {
    if (!opts.force) {
      throw new GitFerryError(
        `this does not look like the same repository: bundle came from '${repo.repoName}' (root commit ${repo.rootCommits[0].slice(0, 12)}), which shares no history with this repo`,
        "if you are sure, re-run with --force",
      );
    }
    warnings.push("repo fingerprint mismatch overridden with --force");
  }

  // 2. Base commit present?
  const baseKnown = await commitExists(root, repo.base);
  if (!baseKnown) {
    warnings.push(
      `base commit ${repo.base.slice(0, 12)} not found locally — attempting 3-way merges from patch blob ids; conflicts are more likely`,
    );
  }

  // 3. HEAD at base?
  const head = await resolveCommit(root, "HEAD");
  if (head !== repo.base) {
    warnings.push(
      `HEAD (${head.slice(0, 12)}) differs from the bundle base (${repo.base.slice(0, 12)}); applying via 3-way merge — review the result`,
    );
  }

  // 4. No git am already in progress.
  const rebaseApply = await tryGit(root, ["rev-parse", "--git-path", "rebase-apply"]);
  if (rebaseApply && existsSync(path.resolve(root, rebaseApply))) {
    throw new GitFerryError(
      "a 'git am' or rebase is already in progress in this repository",
      "finish it or run 'git am --abort' first",
    );
  }

  // 5. Clean tracked working tree (local untracked files are fine unless they collide).
  if (await hasTrackedChanges(root)) {
    if (!opts.force) {
      throw new GitFerryError(
        "target working tree has uncommitted changes to tracked files",
        "commit or stash them first, or re-run with --force",
      );
    }
    warnings.push("applying onto a dirty working tree (--force)");
  }

  // 6. Untracked collisions.
  const untrackedWritten: string[] = [];
  const untrackedSkipped: string[] = [];
  const untrackedPlanned: string[] = [];
  if (includeUntracked) {
    for (const p of contents.untracked) {
      const target = path.resolve(root, p);
      if (!(target === root || target.startsWith(root + path.sep))) {
        throw new GitFerryError(`unsafe untracked path in bundle: ${p}`);
      }
      if (existsSync(target) && !opts.force) {
        untrackedSkipped.push(p);
      } else {
        untrackedPlanned.push(p);
      }
    }
    if (untrackedSkipped.length > 0) {
      warnings.push(
        `${untrackedSkipped.length} untracked file(s) already exist locally and will be skipped (use --force to overwrite): ${untrackedSkipped.join(", ")}`,
      );
    }
  }

  // --- Dry run: report the plan, change nothing ------------------------------
  if (opts.dryRun) {
    if (contents.commits.length > 0) {
      steps.push(`would replay ${contents.commits.length} commit(s) with 'git am -3'`);
    }
    if (contents.worktree.staged) steps.push("would apply staged.patch with 'git apply -3 --index'");
    if (contents.worktree.unstaged) steps.push("would apply unstaged.patch to the working tree ('git apply', 3-way fallback)");
    if (contents.commits.length === 0) {
      // Only meaningful to pre-check patches against the *current* tree when no
      // commits will change it first.
      for (const key of ["worktree/staged.patch", "worktree/unstaged.patch"] as const) {
        if (entries[key]) {
          const tmpFile = await writeTemp(entries[key], path.basename(key));
          try {
            await git(root, ["apply", "--check", "--3way", tmpFile]);
            steps.push(`${path.basename(key)}: applies cleanly`);
          } catch {
            warnings.push(`${path.basename(key)}: does not apply cleanly to the current tree (3-way merge will be attempted)`);
          } finally {
            await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
          }
        }
      }
    } else if (contents.worktree.staged || contents.worktree.unstaged) {
      steps.push("worktree patches can only be pre-validated after commits are applied — skipped in dry-run");
    }
    if (untrackedPlanned.length > 0) steps.push(`would write ${untrackedPlanned.length} untracked file(s)`);
    return {
      dryRun: true,
      manifest,
      steps,
      warnings,
      appliedCommits: 0,
      stagedApplied: false,
      unstagedApplied: false,
      untrackedWritten: untrackedPlanned,
      untrackedSkipped,
    };
  }

  // --- Apply ------------------------------------------------------------------
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gitferry-apply-"));
  let appliedCommits = 0;
  let stagedApplied = false;
  let unstagedApplied = false;
  try {
    // 1) Replay commits with full metadata.
    if (contents.commits.length > 0) {
      const patchPaths: string[] = [];
      for (const c of contents.commits) {
        const data = entries[`commits/${c.file}`];
        if (!data) throw new GitFerryError(`bundle manifest lists commit patch ${c.file} but it is missing`);
        const p = path.join(tmp, c.file);
        await fs.writeFile(p, data);
        patchPaths.push(p);
      }
      try {
        await git(root, ["am", "--3way", "--whitespace=nowarn", ...patchPaths]);
        appliedCommits = contents.commits.length;
        steps.push(`replayed ${appliedCommits} commit(s)`);
      } catch (e) {
        throw new GitFerryError(
          `replaying commits failed: ${(e as Error).message}`,
          "the repository is now mid-'git am'. Resolve conflicts and run 'git am --continue', or undo everything with 'git am --abort'. (If the error mentions committer identity, set user.name/user.email in git config.)",
        );
      }
    }

    // 2) Staged changes — restore both index and working tree.
    if (contents.worktree.staged) {
      const p = path.join(tmp, "staged.patch");
      await fs.writeFile(p, entries["worktree/staged.patch"]);
      await applyStagedPatch(root, p, warnings);
      stagedApplied = true;
      steps.push("applied staged changes (index + working tree)");
    }

    // 3) Unstaged changes — working tree only.
    if (contents.worktree.unstaged) {
      const p = path.join(tmp, "unstaged.patch");
      await fs.writeFile(p, entries["worktree/unstaged.patch"]);
      await applyUnstagedPatch(root, p, warnings);
      unstagedApplied = true;
      steps.push("applied unstaged changes (working tree)");
    }

    // 4) Untracked files.
    for (const p of untrackedPlanned) {
      const target = path.resolve(root, p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entries[`untracked/${p}`]);
      untrackedWritten.push(p);
    }
    if (untrackedWritten.length > 0) steps.push(`wrote ${untrackedWritten.length} untracked file(s)`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return {
    dryRun: false,
    manifest,
    steps,
    warnings,
    appliedCommits,
    stagedApplied,
    unstagedApplied,
    untrackedWritten,
    untrackedSkipped,
  };
}

/**
 * Staged patch: 3-way merge into index + working tree (note: --3way implies
 * --index, which is exactly what staged changes need). Falls back to --reject.
 */
async function applyStagedPatch(root: string, patchFile: string, warnings: string[]): Promise<void> {
  try {
    await git(root, ["apply", "--3way", "--index", patchFile]);
  } catch (threeWayErr) {
    await handlePatchFailure(root, patchFile, threeWayErr as Error, warnings, "staged.patch", true);
  }
}

/**
 * Unstaged patch: must touch the working tree only. Plain `git apply` first;
 * on failure fall back to 3-way — but since --3way implies --index (git ≥2.32),
 * snapshot the index and restore it afterwards so staging state stays faithful.
 */
async function applyUnstagedPatch(root: string, patchFile: string, warnings: string[]): Promise<void> {
  try {
    await git(root, ["apply", patchFile]);
    return;
  } catch {
    const savedIndexTree = await tryGit(root, ["write-tree"]);
    try {
      await git(root, ["apply", "--3way", patchFile]);
      if (savedIndexTree) await git(root, ["read-tree", savedIndexTree]);
      warnings.push("unstaged.patch: applied via 3-way merge (target tree had drifted)");
    } catch (threeWayErr) {
      await handlePatchFailure(root, patchFile, threeWayErr as Error, warnings, "unstaged.patch", false);
    }
  }
}

/** Shared failure path: detect conflict-marker outcome, else --reject, else give up with guidance. */
async function handlePatchFailure(
  root: string,
  patchFile: string,
  threeWayErr: Error,
  warnings: string[],
  label: string,
  restoresIndex: boolean,
): Promise<void> {
  // --3way may leave conflict markers + unmerged index entries and exit non-zero.
  const status = await git(root, ["status", "--porcelain"]);
  if (/^(UU|AA|DU|UD|AU|UA|DD)/m.test(status)) {
    warnings.push(`${label}: applied with conflicts — resolve the conflict markers, then 'git add' the files`);
    return;
  }
  try {
    await git(root, ["apply", "--reject", patchFile]);
    warnings.push(
      `${label}: could not merge cleanly; applied what was possible and left .rej files for the rest${restoresIndex ? " (staging state not restored)" : ""}`,
    );
  } catch {
    throw new GitFerryError(
      `${label} does not apply: ${threeWayErr.message}`,
      "the target tree has diverged too far from the bundle base — apply manually from the extracted bundle, or re-create the bundle against a base both machines share",
    );
  }
}

async function writeTemp(data: Uint8Array, name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitferry-chk-"));
  const p = path.join(dir, name);
  await fs.writeFile(p, data);
  return p;
}
