#!/usr/bin/env node
/**
 * gitferry MCP server — exposes pack/inspect/apply as MCP tools over stdio,
 * so agents (Claude Code, etc.) can ferry git changes across air-gapped machines.
 *
 * Register: claude mcp add gitferry -- gitferry-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apply } from "./core/apply.js";
import { GitFerryError } from "./core/errors.js";
import { inspect } from "./core/inspect.js";
import { pack } from "./core/pack.js";
import { VERSION } from "./version.js";

const server = new McpServer({ name: "gitferry", version: VERSION });

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(e: unknown) {
  const msg =
    e instanceof GitFerryError && e.hint
      ? `${e.message}\nhint: ${e.hint}`
      : (e as Error).message;
  return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
}

server.registerTool(
  "pack_changes",
  {
    description:
      "Bundle a git repository's unpushed commits, staged/unstaged working-tree changes, and untracked files into a single portable .gitferry file that can be carried to an air-gapped machine and applied there.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the git repository (or any directory inside it)"),
      output: z.string().optional().describe("Output bundle path; defaults to <repo>-<branch>-<sha>.gitferry in cwd"),
      base: z
        .string()
        .optional()
        .describe("Ref/sha the bundle applies onto (default: merge-base with the upstream tracking branch)"),
      includeCommits: z.boolean().optional().describe("Include unpushed commits (default true)"),
      includeWorktree: z.boolean().optional().describe("Include staged/unstaged changes (default true)"),
      includeUntracked: z.boolean().optional().describe("Include untracked files (default true)"),
    },
  },
  async (args) => {
    try {
      const result = await pack(args);
      return ok({
        outputPath: result.outputPath,
        warnings: result.warnings,
        summary: {
          repo: result.manifest.repo,
          stats: result.manifest.stats,
          commits: result.manifest.contents.commits.map((c) => c.subject),
          untracked: result.manifest.contents.untracked,
        },
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "inspect_bundle",
  {
    description:
      "Verify a .gitferry bundle's integrity (sha256 checksums, manifest schema) and report what it contains, without touching any repository.",
    inputSchema: {
      bundlePath: z.string().describe("Absolute path to the .gitferry bundle file"),
    },
  },
  async (args) => {
    try {
      const result = inspect(args.bundlePath);
      return ok({
        checksumsVerified: true,
        manifest: result.manifest,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "apply_bundle",
  {
    description:
      "Validate and apply a .gitferry bundle to a local git repository: verifies checksums and repo identity, replays commits (git am -3), applies staged/unstaged patches, and writes untracked files. Use dryRun first to preview.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the target git repository"),
      bundlePath: z.string().describe("Absolute path to the .gitferry bundle file"),
      dryRun: z.boolean().optional().describe("Validate and report the plan without changing anything (default false)"),
      force: z
        .boolean()
        .optional()
        .describe("Override repo-fingerprint, dirty-tree, and file-overwrite guards (default false)"),
      includeUntracked: z.boolean().optional().describe("Write untracked files from the bundle (default true)"),
    },
  },
  async (args) => {
    try {
      const result = await apply(args);
      return ok({
        dryRun: result.dryRun,
        steps: result.steps,
        warnings: result.warnings,
        appliedCommits: result.appliedCommits,
        stagedApplied: result.stagedApplied,
        unstagedApplied: result.unstagedApplied,
        untrackedWritten: result.untrackedWritten,
        untrackedSkipped: result.untrackedSkipped,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// No top-level await: keeps the esbuild cjs single-file bundle valid.
server.connect(new StdioServerTransport()).catch((e: unknown) => {
  console.error(`gitferry-mcp failed to start: ${(e as Error).message}`);
  process.exit(1);
});
