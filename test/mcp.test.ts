import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitAll, g, initRepo, write } from "./helpers.js";

const entry = process.env.GITFERRY_MCP_ENTRY ?? path.resolve(__dirname, "../dist/mcp.js");

async function connect(args = [entry]) {
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" });
  const client = new Client({ name: "gitferry-release-test", version: "1.0.0" });
  const protocolErrors: Error[] = [];
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  // The transport reports malformed stdout through onerror after connect.
  client.onerror = (error) => { protocolErrors.push(error); };
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`Cannot connect to ${args.join(" ")}: ${String(error)}\n${stderr}`);
  }
  return { client, protocolErrors, stderr: () => stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  const text = (result.content as { type: string; text?: string }[]).find((block) => block.type === "text")?.text;
  expect(JSON.parse(text!)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

describe("published MCP contract over stdio", () => {
  let session: Awaited<ReturnType<typeof connect>>;
  let temp: string;
  let sequence = 0;

  function directory(label: string) {
    const dir = path.join(temp, `${++sequence} ${label}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function repository(label: string) {
    const dir = directory(label);
    initRepo(dir);
    g(dir, "config", "core.autocrlf", "false");
    return dir;
  }

  beforeAll(async () => {
    temp = mkdtempSync(path.join(os.tmpdir(), "gitferry-mcp-contract-"));
    session = await connect();
  });

  afterAll(async () => {
    await session?.client.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
    expect(session?.protocolErrors ?? []).toEqual([]);
    expect(session?.stderr() ?? "").toBe("");
  });

  it("initializes and advertises three tools with accurate side-effect hints", async () => {
    const { tools } = await session.client.listTools();
    expect(session.client.getServerVersion()?.name).toBe("gitferry");
    expect(tools.map((tool) => tool.name).sort()).toEqual(["apply_bundle", "inspect_bundle", "pack_changes"]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.inspect_bundle.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const name of ["pack_changes", "apply_bundle"]) {
      expect(byName[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    }
    expect(byName.inspect_bundle.outputSchema).toBeDefined();
    expect(byName.pack_changes.inputSchema.properties).toHaveProperty("only");
    expect(byName.pack_changes.inputSchema.properties).toHaveProperty("portable");
  });

  it("packs, inspects, previews, and applies commits plus staged, unstaged, binary and Unicode files", async () => {
    const source = repository("source repository");
    write(source, "staged.txt", "base staged\n");
    write(source, "unstaged.txt", "base unstaged\n");
    const base = commitAll(source, "base");
    const target = directory("target repository");
    g(temp, "clone", "--quiet", "-c", "core.autocrlf=false", source, target);
    g(target, "config", "user.email", "receiver@example.com");
    g(target, "config", "user.name", "Receiver");
    g(target, "config", "commit.gpgsign", "false");
    g(target, "config", "core.autocrlf", "false");
    write(source, "committed.txt", "new commit\n");
    commitAll(source, "MCP feature commit");
    write(source, "staged.txt", "staged edit\n");
    g(source, "add", "staged.txt");
    write(source, "unstaged.txt", "unstaged edit\n");
    const binary = Buffer.from([0, 255, 1, 254, 128, 42]);
    write(source, "notes with spaces/नमस्ते.txt", "hello\n");
    write(source, "image.bin", binary);
    const bundlePath = path.join(temp, "full transfer.gitferry");
    const packed = await call(session.client, "pack_changes", { cwd: source, base, output: bundlePath });
    expect(packed.outputPath).toBe(bundlePath);
    expect(packed.summary.commits).toEqual(["MCP feature commit"]);
    expect(packed.summary.repoFiles).toEqual([]);
    const inspected = await call(session.client, "inspect_bundle", { bundlePath });
    expect(inspected.checksumsVerified).toBe(true);
    expect(inspected.manifest.contents.worktree).toEqual({ staged: true, unstaged: true });
    expect(inspected.manifest.contents.untracked).toContain("notes with spaces/नमस्ते.txt");
    const before = { head: g(target, "rev-parse", "HEAD"), status: g(target, "status", "--porcelain"), index: readFileSync(path.join(target, ".git", "index")) };
    const preview = await call(session.client, "apply_bundle", { cwd: target, bundlePath, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.appliedCommits).toBe(0);
    expect(g(target, "rev-parse", "HEAD")).toBe(before.head);
    expect(g(target, "status", "--porcelain")).toBe(before.status);
    expect(readFileSync(path.join(target, ".git", "index"))).toEqual(before.index);
    const applied = await call(session.client, "apply_bundle", { cwd: target, bundlePath });
    expect(applied).toMatchObject({ dryRun: false, appliedCommits: 1, stagedApplied: true, unstagedApplied: true, repoFilesWritten: [], repoFilesSkipped: [], repoFilesUnchanged: 0 });
    expect(g(target, "log", "-1", "--format=%s")).toBe("MCP feature commit");
    expect(g(target, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(g(target, "diff", "--name-only")).toBe("unstaged.txt");
    for (const file of ["staged.txt", "unstaged.txt", "committed.txt", "notes with spaces/नमस्ते.txt", "image.bin"]) {
      expect(readFileSync(path.join(target, file))).toEqual(readFileSync(path.join(source, file)));
    }
    expect(readFileSync(path.join(target, "image.bin"))).toEqual(binary);
  });

  it("supports portable whole-repository snapshots and complete snapshot results", async () => {
    const source = repository("snapshot source");
    write(source, "dir with spaces/hello.txt", "tracked\n");
    commitAll(source, "base snapshot");
    write(source, "excluded.txt", "untracked\n");
    const bundlePath = path.join(temp, "snapshot.gitferry");
    const packed = await call(session.client, "pack_changes", { cwd: source, only: "repo", portable: true, output: bundlePath });
    expect(packed.summary.repoFiles).toEqual(["dir with spaces/hello.txt"]);
    expect(packed.summary.untracked).toEqual([]);
    expect(readFileSync(bundlePath).subarray(0, 2).toString()).toBe("PK");
    const target = directory("snapshot destination");
    const preview = await call(session.client, "apply_bundle", { cwd: target, bundlePath, dryRun: true });
    expect(preview.repoFilesWritten).toEqual(["dir with spaces/hello.txt"]);
    const applied = await call(session.client, "apply_bundle", { cwd: target, bundlePath });
    expect(applied.repoFilesWritten).toEqual(["dir with spaces/hello.txt"]);
    const repeated = await call(session.client, "apply_bundle", { cwd: target, bundlePath });
    expect(repeated).toMatchObject({ repoFilesWritten: [], repoFilesSkipped: [], repoFilesUnchanged: 1 });
  });

  it("narrows named selections using include flags and retains legacy flag arguments", async () => {
    const source = repository("selection source");
    write(source, "tracked.txt", "base\n");
    commitAll(source, "base");
    write(source, "tracked.txt", "unstaged\n");
    write(source, "secret.txt", "exclude me\n");
    for (const args of [{ only: "unstaged", includeUntracked: false }, { includeCommits: false, includeUntracked: false }]) {
      const packed = await call(session.client, "pack_changes", { cwd: source, output: path.join(temp, `selection-${++sequence}.gitferry`), ...args });
      expect(packed.summary.untracked).toEqual([]);
      const inspected = await call(session.client, "inspect_bundle", { bundlePath: packed.outputPath });
      expect(inspected.manifest.contents.worktree).toEqual({ staged: false, unstaged: true });
    }
  });

  it("reports invalid arguments and operational failures without terminating the server", async () => {
    const invalid = await session.client.callTool({ name: "apply_bundle", arguments: { cwd: 42, bundlePath: "missing" } });
    expect(invalid.isError).toBe(true);
    const missing = await session.client.callTool({ name: "inspect_bundle", arguments: { bundlePath: path.join(temp, "does-not-exist.gitferry") } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/cannot read bundle/);
    const unknown = await session.client.callTool({ name: "pack_changes", arguments: { cwd: temp, only: "typo" } });
    expect(unknown.isError).toBe(true);
    const replies = await Promise.all([session.client.listTools(), session.client.listTools(), session.client.listTools()]);
    expect(replies.every((reply) => reply.tools.length === 3)).toBe(true);
  });

  it("keeps concurrent requests for independent repositories and output files separate", async () => {
    const sources = [repository("concurrent alpha"), repository("concurrent beta")];
    for (const [index, source] of sources.entries()) {
      write(source, "base.txt", "base\n");
      commitAll(source, "base");
      write(source, `only-${index}.txt`, `payload ${index}\n`);
    }
    const packed = await Promise.all(sources.map((cwd, index) => call(session.client, "pack_changes", {
      cwd, only: "unstaged", output: path.join(temp, `concurrent-${index}.gitferry`),
    })));
    const inspected = await Promise.all(packed.map((result) => call(session.client, "inspect_bundle", { bundlePath: result.outputPath })));
    for (const [index, result] of inspected.entries()) {
      expect(result.manifest.contents.untracked).toEqual([`only-${index}.txt`]);
    }
  });

  it("also launches silently through the main CLI for standard npm registry clients", async () => {
    const cli = process.env.GITFERRY_CLI_ENTRY ?? path.resolve(__dirname, "../dist/cli.js");
    const alternative = await connect([cli, "mcp"]);
    try {
      expect((await alternative.client.listTools()).tools).toHaveLength(3);
    } finally {
      await alternative.client.close();
    }
    expect(alternative.protocolErrors).toEqual([]);
    expect(alternative.stderr()).toBe("");
  });
});
