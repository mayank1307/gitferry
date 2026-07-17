import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).replace(/\n$/, "");
}

export function g(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args);
}

export function tmpDir(prefix = "gitferry-test-"): string {
  // realpath: on macOS os.tmpdir() is a /var -> /private/var symlink and git resolves it.
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Init a repo with identity configured so commit/am work in CI-like envs. */
export function initRepo(dir: string): void {
  g(dir, "init", "-b", "main");
  g(dir, "config", "user.email", "test@example.com");
  g(dir, "config", "user.name", "Test User");
  g(dir, "config", "commit.gpgsign", "false");
}

export function write(dir: string, rel: string, content: string | Buffer): void {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function commitAll(dir: string, message: string): string {
  g(dir, "add", "-A");
  g(dir, "commit", "-m", message);
  return g(dir, "rev-parse", "HEAD");
}

/** Clone src to a new temp dir, with identity configured. */
export function cloneRepo(src: string): string {
  const dest = path.join(tmpDir(), "clone");
  execFileSync("git", ["clone", "--quiet", src, dest], { encoding: "utf8" });
  g(dest, "config", "user.email", "other@example.com");
  g(dest, "config", "user.name", "Other User");
  g(dest, "config", "commit.gpgsign", "false");
  return dest;
}
