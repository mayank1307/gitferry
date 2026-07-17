import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8 } from "fflate";
import { VERSION } from "../version.js";
import { type Entries, writeArchive } from "./archive.js";
import { GitFerryError } from "./errors.js";
import {
  currentBranch,
  git,
  headExists,
  repoRoot,
  resolveCommit,
  rootCommits,
  tryGit,
  upstreamRef,
} from "./git.js";
import { FORMAT_VERSION, type Manifest, sha256 } from "./manifest.js";

export interface PackOptions {
  cwd: string;
  /** Output file path; defaults to <repo>-<branch>-<shortsha>.gitferry in cwd. */
  output?: string;
  /** Ref/sha the bundle applies onto. Defaults to merge-base with upstream, else HEAD (no commits). */
  base?: string;
  includeCommits?: boolean;
  includeWorktree?: boolean;
  includeUntracked?: boolean;
}

export interface PackResult {
  outputPath: string;
  manifest: Manifest;
  warnings: string[];
}

export async function pack(opts: PackOptions): Promise<PackResult> {
  const warnings: string[] = [];
  const includeCommits = opts.includeCommits ?? true;
  const includeWorktree = opts.includeWorktree ?? true;
  const includeUntracked = opts.includeUntracked ?? true;

  const root = await repoRoot(opts.cwd);
  if (!(await headExists(root))) {
    throw new GitFerryError("repository has no commits yet", "make at least one commit before packing");
  }
  const head = await resolveCommit(root, "HEAD");
  const branch = await currentBranch(root);
  const roots = await rootCommits(root);
  const repoName = path.basename(root);

  // --- Resolve base ---------------------------------------------------------
  let base: string;
  let baseRef: string | undefined;
  if (opts.base) {
    base = await resolveCommit(root, opts.base);
    baseRef = opts.base;
  } else {
    const upstream = await upstreamRef(root);
    if (upstream) {
      base = await git(root, ["merge-base", "HEAD", upstream]);
      baseRef = upstream;
    } else {
      base = head;
      if (includeCommits) {
        warnings.push(
          "no --base given and no upstream tracking branch; bundling working-tree changes only (pass --base <ref> to include commits)",
        );
      }
    }
  }

  const entries: Entries = {};

  // --- Unpushed commits (git format-patch) ----------------------------------
  const commits: Manifest["contents"]["commits"] = [];
  if (includeCommits && base !== head) {
    const merges = await git(root, ["rev-list", "--merges", `${base}..HEAD`]);
    if (merges) {
      warnings.push(
        `range ${base.slice(0, 7)}..HEAD contains merge commits; git format-patch skips them — history will be replayed flattened/incomplete. Consider a linear branch or a different --base.`,
      );
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gitferry-pack-"));
    try {
      const out = await git(root, [
        "format-patch",
        "--no-signature",
        "-o",
        tmp,
        `${base}..HEAD`,
      ]);
      const patchFiles = out.split("\n").filter(Boolean);
      const log = await git(root, ["log", "--reverse", "--format=%H%x09%s", `${base}..HEAD`, "--no-merges"]);
      const logLines = log.split("\n").filter(Boolean);
      for (let i = 0; i < patchFiles.length; i++) {
        const fileName = path.basename(patchFiles[i]);
        const data = await fs.readFile(patchFiles[i]);
        entries[`commits/${fileName}`] = new Uint8Array(data);
        const [sha = "", subject = ""] = (logLines[i] ?? "").split("\t");
        commits.push({ file: fileName, sha, subject });
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // --- Working-tree changes (staged + unstaged, binary-safe) ----------------
  let hasStaged = false;
  let hasUnstaged = false;
  if (includeWorktree) {
    const staged = await git(root, ["diff", "--binary", "--full-index", "--cached"]);
    if (staged) {
      entries["worktree/staged.patch"] = strToU8(staged + "\n");
      hasStaged = true;
    }
    const unstaged = await git(root, ["diff", "--binary", "--full-index"]);
    if (unstaged) {
      entries["worktree/unstaged.patch"] = strToU8(unstaged + "\n");
      hasUnstaged = true;
    }
  }

  // --- Untracked files (respecting .gitignore) ------------------------------
  const untracked: string[] = [];
  if (includeUntracked) {
    const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = out.split("\0").filter(Boolean);
    for (const p of paths) {
      const data = await fs.readFile(path.join(root, p));
      entries[`untracked/${p}`] = new Uint8Array(data);
      untracked.push(p);
    }
  }

  if (commits.length === 0 && !hasStaged && !hasUnstaged && untracked.length === 0) {
    throw new GitFerryError(
      "nothing to pack: no commits in range, no working-tree changes, no untracked files",
      "check --base, or make some changes first",
    );
  }

  // --- Stats -----------------------------------------------------------------
  const shortstat = (await tryGit(root, ["diff", "HEAD", "--shortstat"])) ?? "";
  const stats = {
    commits: commits.length,
    filesChanged: parseInt(/(\d+) files? changed/.exec(shortstat)?.[1] ?? "0", 10),
    insertions: parseInt(/(\d+) insertions?/.exec(shortstat)?.[1] ?? "0", 10),
    deletions: parseInt(/(\d+) deletions?/.exec(shortstat)?.[1] ?? "0", 10),
    untracked: untracked.length,
  };

  // --- Manifest + README ------------------------------------------------------
  entries["README.txt"] = strToU8(manualApplyReadme({ repoName, branch, head, base, commits, hasStaged, hasUnstaged, untracked }));

  const checksums: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    checksums[name] = sha256(data);
  }

  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION,
    tool: { name: "gitferry", version: VERSION },
    createdAt: new Date().toISOString(),
    repo: { rootCommits: roots, repoName, branch, head, base, baseRef },
    contents: {
      commits,
      worktree: { staged: hasStaged, unstaged: hasUnstaged },
      untracked,
    },
    stats,
    checksums,
  };
  entries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  // --- Write archive -----------------------------------------------------------
  const safeBranch = branch.replace(/[^\w.-]+/g, "-");
  const defaultName = `${repoName}-${safeBranch}-${head.slice(0, 7)}.gitferry`;
  const outputPath = path.resolve(opts.cwd, opts.output ?? defaultName);
  writeArchive(outputPath, entries);

  return { outputPath, manifest, warnings };
}

function manualApplyReadme(info: {
  repoName: string;
  branch: string;
  head: string;
  base: string;
  commits: { subject: string }[];
  hasStaged: boolean;
  hasUnstaged: boolean;
  untracked: string[];
}): string {
  const steps: string[] = [];
  if (info.commits.length > 0) steps.push("  git am -3 bundle/commits/*.patch");
  if (info.hasStaged) steps.push("  git apply -3 --index bundle/worktree/staged.patch");
  // no -3 here: --3way implies --index, which would wrongly stage these changes
  if (info.hasUnstaged) steps.push("  git apply bundle/worktree/unstaged.patch");
  if (info.untracked.length > 0) steps.push("  cp -R bundle/untracked/. .");
  return `gitferry bundle — portable git changes
=========================================

Source repo : ${info.repoName} (branch: ${info.branch})
Source HEAD : ${info.head}
Applies onto: ${info.base}
Contains    : ${info.commits.length} commit(s), staged=${info.hasStaged}, unstaged=${info.hasUnstaged}, ${info.untracked.length} untracked file(s)

Preferred: apply with the gitferry tool (validates checksums & repo state):

  gitferry apply <this-file>

Manual fallback — needs only git + unzip. From the target repo root
(which should be at commit ${info.base.slice(0, 12)}):

  unzip <this-file> -d bundle/
${steps.join("\n")}

Every file's sha256 is listed in manifest.json if you want to verify integrity.
`;
}
