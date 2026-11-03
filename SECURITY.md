# Security policy and operating boundaries

## Reporting a vulnerability

Please do not put exploit bundles, credentials, or private source code in public issues. Use GitHub's **Report a vulnerability** option on the repository Security tab when private vulnerability reporting is enabled. If it is unavailable, open an issue asking the maintainer to provide a private reporting channel, without vulnerability details. Maintainers must enable and verify private reporting before public launch.

Security fixes target the latest released version. Pin a known-good package version, review release notes, and upgrade deliberately.

## Trust model

GitFerry is a local CLI and stdio MCP server. It runs with the privileges of the user who starts it and accepts local paths supplied by the client. It is not a filesystem sandbox, an authentication service, or a hosted multi-user server. Use a trusted MCP client, a normal user account, and repositories you control. MCP annotations describe behavior; they do not enforce approvals.

A bundle can contain source code, binary files, commit messages, and untracked files. Ignored untracked files are excluded during packing; tracked secrets remain included. Review what you share. There is no GitFerry backend or automatic source upload. npm installation contacts the package registry; subsequent normal local operations do not require a GitFerry service.

SHA-256 checksums detect accidental corruption and inconsistent payloads. An attacker can replace both a payload and its checksum, so checksums do not authenticate the sender. Only apply bundles from trusted sources. Repository root-commit fingerprints identify shared history, not ownership or authorization.

## Input and filesystem protections

GitFerry validates archive paths and manifest references before applying. It rejects traversal, unsafe Windows path aliases, and Git metadata destinations. Direct snapshot/untracked reads and writes reject symlinks; destination writes use checked paths and atomic replacement. A symlink in a source snapshot or untracked selection is an error rather than an instruction to dereference content outside the repository. These restrictions favor safe, portable bundles over preserving every filesystem feature.

The current resource limits are:

| Resource | Limit |
|----------|-------|
| Compressed bundle input | 32 MiB |
| Expanded ZIP / total entry payload | 128 MiB |
| Individual entry | 64 MiB |
| Manifest JSON before parsing | 4 MiB |
| Archive entries | 10,000 |
| Portable path / individual component | 4,096 / 255 UTF-8 bytes |
| Git command runtime | 120 seconds per command |
| Buffered Git output | 64 MiB per command |

ZIP64, multi-disk archives, and encrypted ZIPs are unsupported. Large repositories may need smaller selections. These are hard limits, not a guarantee that all inputs below them use little memory or complete quickly.

`force` bypasses the documented repository-fingerprint, dirty-tree, and overwrite guards. It does not bypass path validation or resource limits. Pack writes the selected output file; confirm its destination and avoid using a file you need to retain.

## Git, concurrency, and recovery

GitFerry disables Git hooks, signing, and fsmonitor for its Git subprocesses, and enables Git's NTFS/HFS path protections. Repositories and local Git configuration remain trusted: configured filters, attributes, tools, and Git itself are outside GitFerry's sandbox boundary. Do not run it in an attacker-controlled checkout or under a malicious Git configuration.

Pack and apply operations, including dry runs, take an exclusive cross-process lock per canonical worktree root. This coordinates GitFerry processes only. Other editors, Git commands, linked worktrees sharing Git metadata, and local programs can still change files. Avoid concurrent mutation while bundling or applying. Filesystem checks cannot defend against a malicious local process racing to swap directories or mount points.

An interrupted process can leave a stale lock. The error identifies its location. Check that no GitFerry operation is running before removing that specific lock; never delete an active lock to force concurrent application.

Apply is not transactional. A later failure can leave earlier commits or files applied. Use a clean checkout, inspect first, and dry-run before applying. Dry-run validates against current state; it cannot fully predict patches that depend on commits not yet replayed. On commit conflicts use standard `git am --continue` or `git am --abort`; inspect the reported state before retrying.

## QR transfers and manual fallback

QR camera pages bind to 127.0.0.1 and validate Host and Origin headers. They reject requests from unrelated web origins and do not serve a public network endpoint. The local service is not authenticated against other processes running as the user. Close it after use. Optical transfer still requires trusting the source and protecting the screen/camera environment.

Manually extracting a portable bundle and running Git/copy commands bypasses GitFerry's validation, limits, and lock. Review trusted archives and patches before using that fallback.
