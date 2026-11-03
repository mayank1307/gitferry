import { createHash } from "node:crypto";
import { z } from "zod";

export const FORMAT_VERSION = 1;

export const ManifestSchema = z.object({
  formatVersion: z.number().int().min(1),
  tool: z.object({ name: z.string(), version: z.string() }),
  createdAt: z.string(),
  repo: z.object({
    /** Root (parentless) commit shas — the repo identity fingerprint. */
    rootCommits: z.array(z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)).min(1),
    repoName: z.string(),
    branch: z.string(),
    /** HEAD sha on the source machine when the bundle was created. */
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    /** Commit the bundle applies onto — target repo should be at (or contain) this. */
    base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    /** Human-friendly name for base, if one was used (e.g. "origin/main"). */
    baseRef: z.string().optional(),
  }),
  contents: z.object({
    commits: z.array(
      z.object({ file: z.string(), sha: z.string(), subject: z.string() }),
    ),
    worktree: z.object({ staged: z.boolean(), unstaged: z.boolean() }),
    untracked: z.array(z.string()),
    /** Whole-repo snapshot mode: every tracked file, stored verbatim under repo/. */
    repoFiles: z.array(z.string()).optional(),
  }),
  stats: z.object({
    commits: z.number(),
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    untracked: z.number(),
    repoFiles: z.number().optional(),
  }),
  /** archive path -> sha256 hex, for every entry except manifest.json itself. */
  checksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
