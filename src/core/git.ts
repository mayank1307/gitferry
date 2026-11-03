import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { GitFerryError } from "./errors.js";

const execFileP = promisify(execFile);

/** Large diffs are common; allow up to 64 MB of git output. */
const MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Run git in `cwd`, return stdout with the trailing newline stripped. Throws GitError on failure. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-c", `core.hooksPath=${devNull}`, "-c", "core.protectNTFS=true", "-c", "core.protectHFS=true", "-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
    });
    return stdout.replace(/\n$/, "");
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = err.stderr?.trim() || err.message || "unknown error";
    throw new GitError(`git ${args.join(" ")}: ${detail}`, args, err.stderr ?? "");
  }
}

/** Like git(), but returns null instead of throwing. */
export async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** Absolute path of the repo working-tree root containing `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    throw new GitFerryError(
      `not a git repository: ${cwd}`,
      "run this inside a git working tree, or pass -C <dir>",
    );
  }
  return root;
}

/** Resolve any ref/expression to a full commit sha. */
export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const sha = await tryGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (!sha) {
    throw new GitFerryError(`cannot resolve '${ref}' to a commit`, "check the ref name / sha");
  }
  return sha;
}

/** Root (parentless) commits reachable from HEAD — used as a repo identity fingerprint. */
export async function rootCommits(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  return out.split("\n").filter(Boolean).sort();
}

/** Current branch name, or "HEAD" when detached. */
export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Upstream tracking ref of the current branch (e.g. "origin/main"), or null. */
export async function upstreamRef(cwd: string): Promise<string | null> {
  return tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
}

export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  return (await tryGit(cwd, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
}

export async function headExists(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
}

/** `git status --porcelain` lines. */
export async function statusLines(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["status", "--porcelain"]);
  return out.split("\n").filter(Boolean);
}

/** True if there are staged or unstaged changes to tracked files (untracked files ignored). */
export async function hasTrackedChanges(cwd: string): Promise<boolean> {
  return (await statusLines(cwd)).some((l) => !l.startsWith("??"));
}
