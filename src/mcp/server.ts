import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apply } from "../core/apply.js";
import { GitFerryError } from "../core/errors.js";
import { inspect } from "../core/inspect.js";
import { ManifestSchema } from "../core/manifest.js";
import { pack, SELECTIONS, selectionIncludes } from "../core/pack.js";
import { VERSION } from "../version.js";

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(e: unknown) {
  const msg =
    e instanceof GitFerryError && e.hint
      ? `${e.message}\nhint: ${e.hint}`
      : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
}

/** Create an isolated tool server without opening a transport or touching stdio. */
export function createGitFerryServer(): McpServer {
  const server = new McpServer({ name: "gitferry", version: VERSION });

  server.registerTool(
    "pack_changes",
    {
      title: "Pack local Git changes",
      description:
        "Read a local Git repository and write a portable .gitferry bundle of commits, staged/unstaged changes, and untracked files. only=repo instead captures tracked files as a snapshot. Review untracked files for secrets before sharing. No network transfer is performed.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        cwd: z.string().describe("Absolute path to the git repository (or any directory inside it)"),
        output: z.string().optional().describe("Output bundle path; defaults to <repo>-<branch>-<sha>.gitferry in cwd"),
        only: z.enum(SELECTIONS).optional().describe("Select all, uncommitted, staged, unstaged, committed, or repo (tracked-file snapshot). Default all. Include flags can further narrow the selection; repo is exclusive."),
        portable: z.boolean().optional().describe("Write a plain ZIP for git + unzip targets instead of the smaller Brotli-wrapped format (default false)"),
        base: z
          .string()
          .optional()
          .describe("Ref/sha the bundle applies onto (default: merge-base with the upstream tracking branch)"),
        includeCommits: z.boolean().optional().describe("Include unpushed commits (default true)"),
        includeWorktree: z.boolean().optional().describe("Include staged AND unstaged changes; master switch over includeStaged/includeUnstaged (default true)"),
        includeStaged: z.boolean().optional().describe("Include staged (index) changes (default true)"),
        includeUnstaged: z.boolean().optional().describe("Include unstaged working-tree changes (default true)"),
        includeUntracked: z.boolean().optional().describe("Include untracked files (default true)"),
      },
    },
    async (args) => {
      try {
        const selected = args.only ? selectionIncludes(args.only) : undefined;
        const result = await pack({
          ...args,
          ...(selected ? {
            includeCommits: selected.includeCommits && (args.includeCommits ?? true),
            includeStaged: selected.includeStaged && (args.includeStaged ?? true),
            includeUnstaged: selected.includeUnstaged && (args.includeUnstaged ?? true),
            includeUntracked: selected.includeUntracked && (args.includeUntracked ?? true),
            includeRepoFiles: selected.includeRepoFiles,
          } : {}),
        });
        return ok({
          outputPath: result.outputPath,
          warnings: result.warnings,
          summary: {
            repo: result.manifest.repo,
            stats: result.manifest.stats,
            commits: result.manifest.contents.commits.map((c) => c.subject),
            untracked: result.manifest.contents.untracked,
            repoFiles: result.manifest.contents.repoFiles ?? [],
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
      title: "Inspect a local GitFerry bundle",
      description:
        "Read a local .gitferry bundle, verify checksums and manifest structure, and report its contents without modifying files. Checksums detect corruption; they do not authenticate the sender.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        bundlePath: z.string().describe("Absolute path to the .gitferry bundle file"),
      },
      outputSchema: { checksumsVerified: z.literal(true), manifest: ManifestSchema },
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
      title: "Apply a local GitFerry bundle",
      description:
        "Validate and apply a trusted local .gitferry bundle: replay commits, restore staged/unstaged changes, and write untracked or snapshot files. Modifies the target unless dryRun=true. Preview first and review conflicts afterward. force bypasses repository, dirty-tree, and overwrite guards.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
          repoFilesWritten: result.repoFilesWritten,
          repoFilesSkipped: result.repoFilesSkipped,
          repoFilesUnchanged: result.repoFilesUnchanged,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
