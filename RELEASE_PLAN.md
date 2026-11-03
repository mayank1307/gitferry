# GitFerry public MCP release plan

## Released — 3 November 2026

GitFerry 0.4.0 is published on [npm](https://www.npmjs.com/package/gitferry/v/0.4.0) and the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mayank1307%2Fgitferry/versions/0.4.0). The [source repository](https://github.com/mayank1307/gitferry) and [v0.4.0 release assets](https://github.com/mayank1307/gitferry/releases/tag/v0.4.0) are public. The registry identity is `io.github.mayank1307/gitferry`.

The release includes reproducible packaging, three local stdio MCP tools, an importable server factory, npm/registry metadata, installation and deployment examples, standalone offline bundles, archive/path protections, safer writes, repository operation locks, and CI/release workflows. See [INSTALL.md](INSTALL.md) for installation and client setup, [CHANGELOG.md](CHANGELOG.md) for release changes, and [PUBLISHING.md](PUBLISHING.md) for future release procedures.

Validation completed: all 81 tests passed locally; Node 22/24 CI passed on Linux, macOS, and Windows (platform-specific symlink/hook tests are skipped on Windows). A fresh public npm installation completed an MCP handshake and listed all three tools. Published npm bytes, registry metadata, and all five GitHub assets were verified. The release workflow completed successfully. Initial account publication was interactive. npm trusted publishing is now configured for `mayank1307/gitferry`, `release.yml`, and the `release` environment; npm marks the connection pending validation and requires its first publication before 5 November 2026, 06:33 UTC (12:03 PM IST). The first new version published through OIDC will provide end-to-end verification. See [PUBLISHING.md](PUBLISHING.md#configured-npm-trusted-publisher) for the saved configuration.

## Historical plan — 31 October 2026

The sections below preserve the pre-release assessment and proposed work from version 0.3.1. References to missing files, unverified ownership, and proposed versions describe that earlier assessment, not current release status.

## Release decision

Release a publicly installable **local stdio MCP server** first. GitFerry already exposes `pack_changes`, `inspect_bundle`, and `apply_bundle` in `src/mcp/server.ts`. These operations need the user's local repository and filesystem. Publish the package to npm and its discovery metadata to the official MCP Registry; each user runs their own server.

This supports local MCP clients that can launch processes. A hosted URL would operate on the host's filesystem and would need a separate repository upload/checkout or local-agent design. URL-only clients therefore belong to a later release.

Proposed registry identity: `io.github.mayank1307/gitferry`, matching the configured GitHub remote owner. Prefer the npm name `gitferry` if the maintainer controls it; otherwise use a controlled scoped name. Verify npm ownership, existing published versions, and GitHub repository visibility before choosing the release version. None of those account states have been verified in this review.

Proposed next version: `0.4.0`, subject to the version check. Keep a stable CLI and three-tool MCP interface; defer a 1.0 compatibility promise until external testing.

## Current readiness

- TypeScript build passes. All 39 existing tests pass when localhost networking is allowed; the sandbox initially blocked two HTTP-based QR tests. Existing tests cover archive formats, pack selections, apply guards, and QR transfers.
- The package declares both executable entry points and includes `dist/`.
- `package.json` declares MIT but the checkout has no `LICENSE` file. It also lacks repository, homepage, issues, keywords, and `mcpName` metadata.
- No `server.json`, CI workflow, release workflow, changelog, or security-reporting instructions are present.
- `npm pack --dry-run` includes existing `.cjs` bundles, while `prepack` only runs TypeScript compilation. Those bundles can be stale; the npm artifact also omits INSTALL.md and SCENARIOS.md even though the README links to them.
- There are extensive staged and unstaged changes. Select and review the intended release contents before creating a tag; preserve work outside that selection.
- The MCP interface omits CLI whole-repository selection and snapshot result fields. Decide and document whether these are deferred or supported in this release.

## Phase 1 — make the package reproducible (about one day)

1. Verify package ownership and reserve the final npm/registry identities. Choose an unused version.
2. Add the MIT license text with the correct copyright holder, package metadata, CHANGELOG.md, and a private vulnerability-reporting route.
3. Keep package.json, package-lock.json, `src/version.ts`, release tag, and registry package version consistent; add a release check for mismatches.
4. Build artifacts from a clean output directory. Either rebuild the standalone `.cjs` files during packaging or exclude them from npm and attach freshly built copies to GitHub Releases.
5. Include linked installation/scenario documents in the package, or change the README links to public repository URLs.
6. Review dependencies and supported Node versions. Test every advertised runtime; update the current Node >=18 claim if the chosen SDK/runtime combination cannot support it.

**Exit condition:** a clean checkout produces the complete artifact without relying on pre-existing dist files. A tarball installs in an isolated directory and both executable entry points work.

## Phase 2 — verify public-input safety and MCP behavior (one to two days)

1. Add an MCP client integration test: initialize, list exactly the three supported tools, pack a disposable repository, inspect the result, preview apply, and apply it to a second repository. Verify malformed arguments and failures return useful MCP errors without corrupting stdout.
2. Add tool annotations describing read and write behavior accurately. Document that pack writes a bundle, apply changes the repository, and `force` bypasses safeguards. Treat annotations as client hints rather than authorization enforcement.
3. Audit archive and manifest paths together. Add regression coverage for traversal, absolute/Windows paths, symlink escapes, writes into Git metadata, and inconsistent manifest references. Current lexical containment checks alone do not establish symlink safety.
4. Set bounds for compressed input, decompressed output, entry count, and Git execution time. Current archive reads decompress the entire input without explicit expansion limits.
5. Verify dry-run leaves repository state unchanged, conflicts have usable recovery instructions, and concurrent calls cannot interleave writes to the same repository. Document any remaining limitations.
6. Explain that SHA-256 checksums detect corruption; checksums stored with an archive do not authenticate its sender. Document that bundles may contain source code and untracked secrets, even when ignored files are excluded.

**Exit condition:** relevant regression tests and the MCP round trip pass; there are no known paths for bundle-controlled writes outside the intended target. Publish the actual scope of platform testing.

## Phase 3 — installation and release automation (about one day)

1. Add CI for build, tests, version consistency, and clean-package installation on Linux, macOS, and Windows. Include Windows paths, filenames with spaces, binary files, and Unicode names in compatibility coverage.
2. Add copy-paste installation instructions using an explicit binary selection, since the package has two binaries:

   ```json
   {
     "mcpServers": {
       "gitferry": {
         "command": "npx",
         "args": ["--yes", "--package=gitferry@0.4.0", "gitferry-mcp"]
       }
     }
   }
   ```

   This is the proposed post-publication configuration. Replace the package name/version if changed. Explain Node and Git prerequisites and give an offline single-file alternative.
3. Add a short demo using disposable repositories: pack, transfer, inspect, dry-run, apply, and inspect Git status. Recruit a few users to try the instructions on clean machines.
4. Configure npm trusted publishing through GitHub Actions using OIDC. Use a supported publishing Node/npm combination and grant `id-token: write`; run the validation gates before publishing. Bootstrap the package manually if required to configure its trusted publisher.
5. Gate releases on a reviewed version tag. Publish npm first, verify the downloadable artifact, then publish registry metadata and GitHub release assets/checksums. Keep registry publication retryable if npm succeeds and registry publication fails.

**Exit condition:** a user can install the published version and complete the demo without the source checkout.

## Phase 4 — publish and make it discoverable (half a day plus feedback)

1. Add `mcpName: "io.github.mayank1307/gitferry"` to package.json before publishing npm.
2. Generate and validate server.json with the current `mcp-publisher` tooling. Declare the npm package, exact released version, stdio transport, and correct runtime executable/arguments; verify discovery launches `gitferry-mcp` rather than the CLI.
3. Publish the public npm package. Authenticate to the MCP Registry with the corresponding GitHub owner and publish server.json. Verify the returned registry record and install the exact version from npm on a fresh environment.
4. Publish release notes describing supported tools, requirements, known limitations, offline assets, and recovery instructions. Add MCP-related GitHub topics and installation examples to the public README.
5. Submit to relevant client directories separately. Registry publication supplies discovery metadata; it does not guarantee placement in every client's directory.
6. Monitor issues during the first week. For a bad release, deprecate the affected npm version, direct users to a known-good pinned version, and publish a fix with a new version. Never overwrite released artifacts.

## Optional later release — hosted MCP URL

Only pursue this when users need URL-only access. Use Streamable HTTP and design repository access explicitly: uploads and isolated workspaces, remote Git-provider integration, or a user-controlled local bridge. A cloud clone cannot see a user's uncommitted local changes. Return downloadable bundles and patches rather than implying that cloud apply modifies the user's laptop.

Budget separately for authentication, tenant isolation, sandboxed Git execution, storage/retention, transfer limits, and operating costs. Public installability of the local server requires no hosted GitFerry backend.

## Definition of released

- Public source repository with license, usable installation docs, release notes, and support route.
- Public, versioned npm artifact with verified MCP executable and fresh offline assets.
- Official MCP Registry entry that resolves to that artifact and launches the right executable.
- Green build, core tests, MCP integration tests, and documented platform checks.
- Successful install and pack/inspect/apply demo from outside the development checkout.

Estimated implementation effort: roughly 3–5 engineering days plus external feedback, depending on the safety audit and platform failures. This is a planning estimate, not a committed release date.

## Publishing references

- [Official MCP Registry publishing guide](https://modelcontextprotocol.io/registry/quickstart): npm artifact publication, mcpName verification, server.json, namespace authentication, and registry publication.
- [MCP TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/server): local stdio and remote Streamable HTTP transports.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): OIDC setup, supported toolchain requirements, and provenance.
