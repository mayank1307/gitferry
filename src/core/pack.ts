import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8 } from "fflate";
import { VERSION } from "../version.js";
import { ARCHIVE_LIMITS, type Entries, writeArchive } from "./archive.js";
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
import { safeTarget, withRepositoryLock } from "./safety.js";
import { FORMAT_VERSION, type Manifest, sha256 } from "./manifest.js";

export interface PackOptions {
  cwd: string;
  /** Output file path; defaults to <repo>-<branch>-<shortsha>.gitferry in cwd. */
  output?: string;
  /** Ref/sha the bundle applies onto. Defaults to merge-base with upstream, else HEAD (no commits). */
  base?: string;
  includeCommits?: boolean;
  /** Master switch for both worktree patches (back-compat; see includeStaged/includeUnstaged). */
  includeWorktree?: boolean;
  includeStaged?: boolean;
  includeUnstaged?: boolean;
  includeUntracked?: boolean;
  /**
   * Whole-repo snapshot mode: bundle every tracked file verbatim (current
   * working-tree content). Exclusive — commits/patches/untracked are skipped.
   */
  includeRepoFiles?: boolean;
  /** Write a plain deflate zip (bigger) that any `unzip` can open, instead of the compact brotli wrapper. */
  portable?: boolean;
}

/** What a pack should carry, as a single named choice. */
export const SELECTIONS = ["all", "uncommitted", "staged", "unstaged", "committed", "repo"] as const;
export type Selection = (typeof SELECTIONS)[number];

export const SELECTION_SUMMARY: Record<Selection, string> = {
  all: "commits + staged + unstaged + untracked",
  uncommitted: "staged + unstaged + untracked (no commits)",
  staged: "staged edits only",
  unstaged: "unstaged edits + untracked files",
  committed: "unpushed commits only",
  repo: "every tracked file as-is — seed or sync a whole checkout",
};

/** Map a named selection onto the pack include flags. */
export function selectionIncludes(
  sel: Selection,
): Required<Pick<PackOptions, "includeCommits" | "includeStaged" | "includeUnstaged" | "includeUntracked" | "includeRepoFiles">> {
  const none = { includeCommits: false, includeStaged: false, includeUnstaged: false, includeUntracked: false, includeRepoFiles: false };
  switch (sel) {
    case "all":
      return { ...none, includeCommits: true, includeStaged: true, includeUnstaged: true, includeUntracked: true };
    case "uncommitted":
      return { ...none, includeStaged: true, includeUnstaged: true, includeUntracked: true };
    case "staged":
      return { ...none, includeStaged: true };
    case "unstaged":
      return { ...none, includeUnstaged: true, includeUntracked: true };
    case "committed":
      return { ...none, includeCommits: true };
    case "repo":
      return { ...none, includeRepoFiles: true };
  }
}

/** Parse a user's picker answer: a 1-based number, a selection name, or "" for the default (null = no default). */
export function parseSelectionChoice(
  input: string,
  fallback: Selection | null = "uncommitted",
): Selection | undefined {
  const s = input.trim().toLowerCase();
  if (s === "") return fallback ?? undefined;
  const byNumber = SELECTIONS[Number(s) - 1];
  if (/^\d+$/.test(s) && byNumber) return byNumber;
  if ((SELECTIONS as readonly string[]).includes(s)) return s as Selection;
  if (s === "commits" || s === "commit") return "committed"; // common aliases
  if (s === "unstage") return "unstaged";
  if (s === "stage") return "staged";
  if (s === "tracked" || s === "snapshot" || s === "full") return "repo";
  return undefined;
}

export interface PackResult {
  outputPath: string;
  manifest: Manifest;
  warnings: string[];
}

export async function pack(opts: PackOptions): Promise<PackResult> {
  const root = await repoRoot(opts.cwd);
  return withRepositoryLock(root, () => packUnlocked(opts));
}

async function packUnlocked(opts: PackOptions): Promise<PackResult> {
  const warnings: string[] = [];
  const includeRepoFiles = opts.includeRepoFiles ?? false;
  // Snapshot mode is exclusive: it carries the tree itself, not changes to it.
  const includeCommits = !includeRepoFiles && (opts.includeCommits ?? true);
  const includeWorktree = !includeRepoFiles && (opts.includeWorktree ?? true);
  const includeStaged = (opts.includeStaged ?? true) && includeWorktree;
  const includeUnstaged = (opts.includeUnstaged ?? true) && includeWorktree;
  const includeUntracked = !includeRepoFiles && (opts.includeUntracked ?? true);

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

  const entries: Entries = Object.create(null);
  let entryBytes = 0;
  const addEntry = (name: string, data: Uint8Array) => {
    entryBytes += data.byteLength;
    if (data.byteLength > ARCHIVE_LIMITS.entryBytes || entryBytes > ARCHIVE_LIMITS.expandedBytes) throw new GitFerryError("bundle exceeds expanded size limit", "select fewer changes or split the transfer");
    if (Object.keys(entries).length >= ARCHIVE_LIMITS.entries) throw new GitFerryError("bundle exceeds entry count limit");
    entries[name] = data;
  };
  const readSource = async (file: string) => {
    const handle = await fs.open(file, "r");
    try {
      if ((await handle.stat()).size > Math.min(ARCHIVE_LIMITS.entryBytes, ARCHIVE_LIMITS.expandedBytes - entryBytes)) throw new GitFerryError("source file exceeds bundle size limit", "select fewer files or split the transfer");
      return await handle.readFile();
    } finally { await handle.close(); }
  };

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
        const data = await readSource(patchFiles[i]);
        addEntry(`commits/${fileName}`, new Uint8Array(data));
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
  if (includeStaged) {
    const staged = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--cached"]);
    if (staged) {
      addEntry("worktree/staged.patch", strToU8(staged + "\n"));
      hasStaged = true;
    }
  }
  if (includeUnstaged) {
    const unstaged = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index"]);
    if (unstaged) {
      addEntry("worktree/unstaged.patch", strToU8(unstaged + "\n"));
      hasUnstaged = true;
    }
  }

  // --- Untracked files (respecting .gitignore) ------------------------------
  const untracked: string[] = [];
  if (includeUntracked) {
    const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = out.split("\0").filter(Boolean);
    for (const p of paths) {
      const data = await readSource(safeTarget(root, p));
      addEntry(`untracked/${p}`, new Uint8Array(data));
      untracked.push(p);
    }
  }

  // --- Whole-repo snapshot (every tracked file, current on-disk content) ----
  const repoFiles: string[] = [];
  if (includeRepoFiles) {
    const out = await git(root, ["ls-files", "-z"]);
    const paths = out.split("\0").filter(Boolean);
    for (const p of paths) {
      try {
        const data = await readSource(safeTarget(root, p));
        addEntry(`repo/${p}`, new Uint8Array(data));
        repoFiles.push(p);
      } catch (e) {
        if (e instanceof GitFerryError) throw e;
        warnings.push(`tracked file missing from disk, not bundled: ${p}`);
      }
    }
  }

  if (commits.length === 0 && !hasStaged && !hasUnstaged && untracked.length === 0 && repoFiles.length === 0) {
    const wanted = [
      includeCommits ? "commits in range" : null,
      includeStaged ? "staged changes" : null,
      includeUnstaged ? "unstaged changes" : null,
      includeUntracked ? "untracked files" : null,
      includeRepoFiles ? "tracked files" : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new GitFerryError(
      `nothing to pack: no ${wanted}`,
      "check --base, widen the selection (--only), or make some changes first",
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
    ...(includeRepoFiles ? { repoFiles: repoFiles.length } : {}),
  };

  // --- Manifest + README ------------------------------------------------------
  addEntry("README.txt", strToU8(manualApplyReadme({ repoName, branch, head, base, commits, hasStaged, hasUnstaged, untracked, repoFiles, portable: Boolean(opts.portable) })));

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
      ...(includeRepoFiles ? { repoFiles } : {}),
    },
    stats,
    checksums,
  };
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  if (manifestBytes.byteLength > 4 * 1024 * 1024) throw new GitFerryError("bundle manifest exceeds 4 MiB size limit", "split the transfer into fewer files");
  addEntry("manifest.json", manifestBytes);

  // --- Write archive -----------------------------------------------------------
  const safeBranch = branch.replace(/[^\w.-]+/g, "-");
  const defaultName = `${repoName}-${safeBranch}-${head.slice(0, 7)}.gitferry`;
  const outputPath = path.resolve(opts.cwd, opts.output ?? defaultName);
  writeArchive(outputPath, entries, { portable: opts.portable });

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
  repoFiles: string[];
  portable: boolean;
}): string {
  const steps: string[] = [];
  if (info.commits.length > 0) steps.push("  git am -3 bundle/commits/*.patch");
  if (info.hasStaged) steps.push("  git apply -3 --index bundle/worktree/staged.patch");
  // no -3 here: --3way implies --index, which would wrongly stage these changes
  if (info.hasUnstaged) steps.push("  git apply bundle/worktree/unstaged.patch");
  if (info.untracked.length > 0) steps.push("  cp -R bundle/untracked/. .");
  if (info.repoFiles.length > 0) steps.push("  cp -R bundle/repo/. .    # full tracked-file snapshot — copies the whole tree");
  const unwrap = info.portable
    ? `Manual fallback — needs only git + unzip. From the target repo root
(which should be at commit ${info.base.slice(0, 12)}):

  unzip <this-file> -d bundle/`
    : `Manual fallback — needs git + node (this compact bundle is a brotli-wrapped
zip; \`gitferry pack --portable\` makes plain-unzip bundles instead). From the
target repo root (which should be at commit ${info.base.slice(0, 12)}):

  node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("bundle.zip",z.brotliDecompressSync(f.readFileSync(process.argv[1]).subarray(4)))' <this-file>
  unzip bundle.zip -d bundle/`;
  return `gitferry bundle — portable git changes
=========================================

Source repo : ${info.repoName} (branch: ${info.branch})
Source HEAD : ${info.head}
Applies onto: ${info.base}
Contains    : ${info.repoFiles.length > 0 ? `full snapshot of ${info.repoFiles.length} tracked file(s)` : `${info.commits.length} commit(s), staged=${info.hasStaged}, unstaged=${info.hasUnstaged}, ${info.untracked.length} untracked file(s)`}

Preferred: apply with the gitferry tool (validates checksums & repo state):

  gitferry apply <this-file>

${unwrap}
${steps.join("\n")}

Every file's sha256 is listed in manifest.json if you want to verify integrity.
`;
}
