import { chmodSync, existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ARCHIVE_LIMITS, readArchive, writeArchive } from "../src/core/archive.js";
import { readBundle } from "../src/core/bundle.js";
import { pack } from "../src/core/pack.js";
import { apply } from "../src/core/apply.js";
import { sha256 } from "../src/core/manifest.js";
import { assertSafePath, withRepositoryLock } from "../src/core/safety.js";
import { commitAll, cloneRepo, g, initRepo, tmpDir, write } from "./helpers.js";

function fixture() {
  const repo = tmpDir(); initRepo(repo); write(repo, "file.txt", "base\n"); commitAll(repo, "base");
  return repo;
}
async function bundleFixture() {
  const repo = fixture(); write(repo, "new.txt", "new\n");
  const output = path.join(tmpDir(), "transfer.gitferry");
  await pack({ cwd: repo, output });
  return { repo, output };
}
function alterManifest(file: string, mutate: (manifest: any, entries: Record<string, Uint8Array>) => void) {
  const entries = readArchive(file);
  const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
  mutate(manifest, entries);
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  // Bypass trusted writer to simulate an attacker.
  writeFileSync(file, zipSync(entries));
}

describe("public bundle safety", () => {
  it("bounds manifest parsing and portable path lengths", () => {
    const file = path.join(tmpDir(), "manifest-limit.gitferry");
    writeFileSync(file, zipSync({ "manifest.json": strToU8(" ".repeat(4 * 1024 * 1024 + 1)) }));
    expect(() => readBundle(file)).toThrow(/manifest exceeds/);
    expect(() => assertSafePath("x".repeat(256))).toThrow(/unsafe path/);
    expect(() => assertSafePath("λ".repeat(128))).toThrow(/unsafe path/);
    expect(() => assertSafePath("λ".repeat(127))).not.toThrow();
    expect(() => assertSafePath(Array(20).fill("x".repeat(250)).join("/"))).toThrow(/unsafe path/);
  });

  it("writer enforces limits before creating an unusable bundle", () => {
    const file = path.join(tmpDir(), "oversized.gitferry"), entries = { blob: new Uint8Array(4096) };
    expect(() => writeArchive(file, entries, { limits: {...ARCHIVE_LIMITS, entries: 0} })).toThrow(/entry count/);
    expect(() => writeArchive(file, entries, { limits: {...ARCHIVE_LIMITS, entryBytes: 100} })).toThrow(/expanded size/);
    expect(() => writeArchive(file, entries, { portable:true, limits: {...ARCHIVE_LIMITS, compressedBytes: 5} })).toThrow(/compressed size/);
    expect(() => writeArchive(file, entries, { limits: {...ARCHIVE_LIMITS, expandedBytes:4096} })).toThrow(/expanded ZIP/);
    expect(existsSync(file)).toBe(false);
  });
  it.each(["../escape", "/absolute", "C:/escape", "a\\b", "a/../b", ".git/config", "a/.GIT/config", "git~1/config", "a/.git./config", "a/file:stream", "NUL.txt", "a//b", "a/./b", "", ".git\u200c/config"])("rejects unsafe portable path %j", (name) => {
    expect(() => assertSafePath(name)).toThrow(/unsafe path/);
  });

  it("bounds compressed input, brotli expansion, ZIP expansion, and entry counts", () => {
    const file = path.join(tmpDir(), "limit.gitferry");
    const zip = zipSync({ "blob": new Uint8Array(4096) });
    writeFileSync(file, zip);
    expect(() => readArchive(file, { ...ARCHIVE_LIMITS, compressedBytes: 5 })).toThrow(/compressed size/);
    expect(() => readArchive(file, { ...ARCHIVE_LIMITS, expandedBytes: 100 })).toThrow(/expanded size/);
    expect(() => readArchive(file, { ...ARCHIVE_LIMITS, entries: 0 })).toThrow(/entry count/);
    writeFileSync(file, Buffer.concat([Buffer.from("GFBR"), brotliCompressSync(zip)]));
    expect(() => readArchive(file, { ...ARCHIVE_LIMITS, expandedBytes: 5 })).toThrow(/oversized/);
  });

  it("rejects archive names before inflation and detects central/local name mismatch", () => {
    const file = path.join(tmpDir(), "bad.gitferry");
    writeFileSync(file, zipSync({ "../escape": strToU8("bad") }));
    expect(() => readArchive(file)).toThrow(/unsafe path/);
    const zip = Buffer.from(zipSync({ "normal": strToU8("ok") }));
    zip[30] = "x".charCodeAt(0); writeFileSync(file, zip);
    expect(() => readArchive(file)).toThrow(/malformed zip/);
  });

  it("rejects dishonest expanded sizes instead of inflating beyond their declared bound", () => {
    const file = path.join(tmpDir(), "dishonest.gitferry");
    const zip = Buffer.from(zipSync({ "blob": new Uint8Array(4096) }));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(1, central + 24); writeFileSync(file, zip);
    expect(() => readArchive(file)).toThrow(/not a valid/);
  });

  it("validates semantic references even when the attacker recomputes all checksums", async () => {
    const { output } = await bundleFixture();
    alterManifest(output, (manifest) => { manifest.contents.commits = [{file: "../escape", sha: "a".repeat(40), subject: "evil"}]; });
    expect(() => readBundle(output)).toThrow(/unsafe path/);
  });

  it("rejects missing, duplicate, and unreferenced manifest payloads", async () => {
    for (const change of [
      (m: any) => { m.contents.untracked.push("missing"); },
      (m: any) => { m.contents.untracked.push("new.txt"); },
      (m: any) => { m.contents.untracked = []; },
    ]) {
      const { output } = await bundleFixture(); alterManifest(output, change);
      expect(() => readBundle(output)).toThrow(/reference|unreferenced|colliding/);
    }
  });

  it("rejects metadata writes with force enabled and leaves target untouched", async () => {
    const { repo, output } = await bundleFixture(); const target = cloneRepo(repo);
    const original = readFileSync(path.join(target, ".git", "config"));
    alterManifest(output, (m, entries) => {
      const data = strToU8("bad"); delete entries["untracked/new.txt"]; delete m.checksums["untracked/new.txt"];
      entries["untracked/.git/config"] = data; m.checksums["untracked/.git/config"] = sha256(data); m.contents.untracked = [".git/config"];
    });
    await expect(apply({cwd: target, bundlePath: output, force: true})).rejects.toThrow(/unsafe path/);
    expect(readFileSync(path.join(target, ".git", "config"))).toEqual(original);
  });

  it.skipIf(process.platform === "win32")("rejects symlink parents and leaves outside files intact, including preview and force", async () => {
    const { repo, output } = await bundleFixture(); const target = cloneRepo(repo), outside = tmpDir();
    write(outside, "victim", "outside"); symlinkSync(path.join(outside, "victim"), path.join(target, "new.txt"));
    for (const dryRun of [true, false]) await expect(apply({cwd: target, bundlePath: output, force: true, dryRun})).rejects.toThrow(/symbolic link/);
    expect(readFileSync(path.join(outside, "victim"), "utf8")).toBe("outside");
    expect(lstatSync(path.join(target, "new.txt")).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("pack refuses symlink content and symlink output instead of leaking or overwriting", async () => {
    const repo = fixture(), outside = tmpDir(); write(outside, "secret", "secret");
    symlinkSync(path.join(outside, "secret"), path.join(repo, "link"));
    await expect(pack({cwd: repo, output: path.join(outside, "transfer")})).rejects.toThrow(/symbolic link/);
    const clean = fixture(); write(clean, "new", "new"); symlinkSync(path.join(outside, "secret"), path.join(outside, "output"));
    await expect(pack({cwd: clean, output: path.join(outside, "output")})).rejects.toThrow(/symbolic link/);
    expect(readFileSync(path.join(outside, "secret"), "utf8")).toBe("secret");
  });

  it("rejects unsafe paths embedded in checksummed Git patches", async () => {
    for (const targetPath of [".git/config", "../escaped.txt"]) {
      const {repo, output} = await bundleFixture(), target = cloneRepo(repo);
      const config = readFileSync(path.join(target, ".git", "config"));
      alterManifest(output, (m, entries) => {
        const patch = strToU8(`diff --git a/${targetPath} b/${targetPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${targetPath}\n@@ -0,0 +1 @@\n+malicious\n`);
        entries["worktree/unstaged.patch"] = patch;
        m.contents.worktree.unstaged = true;
        m.checksums["worktree/unstaged.patch"] = sha256(patch);
      });
      await expect(apply({cwd:target, bundlePath:output, force:true})).rejects.toThrow(/does not apply/);
      expect(readFileSync(path.join(target, ".git", "config"))).toEqual(config);
      expect(existsSync(path.join(target, "..", "escaped.txt"))).toBe(false);
    }
  }, 30_000); // Two repository/patch round trips on potentially slow CI runners.

  it.skipIf(process.platform === "win32")("rechecks a target after an earlier patch creates a symlink parent", async () => {
    const {repo, output} = await bundleFixture(), target = cloneRepo(repo), outside = tmpDir();
    write(outside, "victim", "outside");
    alterManifest(output, (m, entries) => {
      const patch = strToU8(`diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+${outside}\n\\ No newline at end of file\n`);
      const data = entries["untracked/new.txt"];
      delete entries["untracked/new.txt"]; delete m.checksums["untracked/new.txt"];
      entries["untracked/link/victim"] = data; m.checksums["untracked/link/victim"] = sha256(data);
      m.contents.untracked = ["link/victim"];
      entries["worktree/unstaged.patch"] = patch; m.checksums["worktree/unstaged.patch"] = sha256(patch);
      m.contents.worktree.unstaged = true;
    });
    await expect(apply({cwd:target, bundlePath:output, force:true})).rejects.toThrow(/symbolic link/);
    expect(lstatSync(path.join(target, "link")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outside, "victim"), "utf8")).toBe("outside");
  });

  it("replaces a hard-linked target inode instead of modifying outside content", async () => {
    const { repo, output } = await bundleFixture(); const target = cloneRepo(repo), outside = tmpDir();
    write(outside, "victim", "outside"); linkSync(path.join(outside, "victim"), path.join(target, "new.txt"));
    await apply({cwd: target, bundlePath: output, force: true});
    expect(readFileSync(path.join(outside, "victim"), "utf8")).toBe("outside");
    expect(readFileSync(path.join(target, "new.txt"), "utf8")).toBe("new\n");
  });

  it("preview preserves index bytes, HEAD, and working files", async () => {
    const repo = fixture(), target = cloneRepo(repo); write(repo, "file.txt", "changed\n");
    g(repo, "add", "file.txt"); write(repo, "new name-λ.txt", "extra");
    const output = path.join(tmpDir(), "preview.gitferry"); await pack({cwd: repo, output});
    const indexPath = path.join(target, ".git", "index"), index = readFileSync(indexPath), head = g(target, "rev-parse", "HEAD");
    await apply({cwd: target, bundlePath: output, dryRun: true});
    expect(readFileSync(indexPath)).toEqual(index); expect(g(target, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(target, "file.txt"), "utf8")).toBe("base\n");
    expect(existsSync(path.join(target, "new name-λ.txt"))).toBe(false);
  });

  it("serializes repositories across operations and releases locks after errors", async () => {
    const { repo, output } = await bundleFixture();
    // Public operations resolve the Git root before locking. Windows temp paths
    // can use an 8.3 alias while Git reports the long path for the same directory.
    const root = g(repo, "rev-parse", "--show-toplevel");
    await withRepositoryLock(root, async () => {
      await expect(pack({cwd: repo, output})).rejects.toThrow(/another GitFerry operation/);
      await expect(apply({cwd: repo, bundlePath: output, dryRun:true})).rejects.toThrow(/another GitFerry operation/);
    });
    await expect(withRepositoryLock(repo, async () => { throw new Error("test failure"); })).rejects.toThrow("test failure");
    await expect(pack({cwd: repo, output})).resolves.toHaveProperty("outputPath");
  });

  it.skipIf(process.platform === "win32")("does not execute applypatch hooks", async () => {
    const repo = fixture(), target = cloneRepo(repo), base = g(repo, "rev-parse", "HEAD");
    write(repo, "file.txt", "commit\n"); commitAll(repo, "change");
    const marker = path.join(tmpDir(), "hook-ran");
    write(target, ".git/hooks/applypatch-msg", `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(path.join(target, ".git/hooks/applypatch-msg"), 0o755);
    const output = path.join(tmpDir(), "commit.gitferry"); await pack({cwd: repo, base, output});
    await apply({cwd: target, bundlePath: output}); expect(existsSync(marker)).toBe(false);
  });
});
