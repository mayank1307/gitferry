import { constants, lstatSync, realpathSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { GitFerryError } from "./errors.js";

/** Portable relative file paths only. Git metadata is never bundle content. */
export function assertSafePath(name: string): void {
  const parts = name.split("/");
  if (!name || Buffer.byteLength(name, "utf8") > 4096 || parts.some((part) => {
    const canonical = part.normalize("NFKC").replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "").toLowerCase();
    return !part || Buffer.byteLength(part, "utf8") > 255 || part === "." || part === ".." || /[\x00-\x1f\x7f\\<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
      canonical === ".git" || /^git~\d+$/.test(canonical) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
  })) throw new GitFerryError(`unsafe path in bundle: ${name}`, "paths must be portable relative filenames outside Git metadata");
}

/** Inspect every existing component; lexical containment alone misses symlinks. */
export function safeTarget(root: string, relative: string): string {
  assertSafePath(relative);
  const canonicalRoot = realpathSync(root);
  let target = canonicalRoot;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    try {
      if (lstatSync(target).isSymbolicLink()) throw new GitFerryError(`unsafe symbolic link in path: ${relative}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}

/** Replace the directory entry, never truncate a symlink or hard-linked inode. */
export function atomicWrite(file: string, data: Uint8Array): void {
  const parent = realpathSync(path.dirname(file));
  const target = path.join(parent, path.basename(file));
  // An explicit output may live outside the repo, but never inside Git metadata.
  const components = parent.split(path.sep).filter(Boolean).concat(path.basename(file));
  for (const component of components) {
    const normalized = component.normalize("NFKC").toLowerCase();
    if (normalized === ".git" || /^git~\d+$/.test(normalized)) throw new GitFerryError(`refusing to write Git metadata: ${file}`);
  }
  let mode = 0o600;
  try {
    const previous = lstatSync(target);
    if (previous.isSymbolicLink()) throw new GitFerryError(`refusing to overwrite symbolic link: ${file}`);
    if (previous.isFile()) mode = previous.mode & 0o777;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const temp = path.join(parent, `.gitferry-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    writeFileSync(fd, data);
    closeSync(fd); fd = undefined;
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}

export function writeSafeTarget(root: string, relative: string, data: Uint8Array): void {
  const target = safeTarget(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  safeTarget(root, relative); // Check newly created parents again before opening.
  atomicWrite(target, data);
}

/** Cross-process exclusion, outside the repository so previews leave it untouched. */
export async function withRepositoryLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const canonical = realpathSync(root);
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const file = path.join(os.tmpdir(), `gitferry-${key}.lock`);
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw new GitFerryError("another GitFerry operation is using this repository", `wait for it to finish; after a crashed process, remove the stale lock only after checking no operation is running: ${file}`);
  }
  try { writeFileSync(fd, `${process.pid}\n${canonical}\n`); return await action(); }
  finally { closeSync(fd); unlinkSync(file); }
}
