# Releasing

Releases are manual, single-commit affairs. The maintainer controls the changelog voice and format. The three npm packages — `@scriptc/runtime`, `@scriptc/compiler`, `scriptc` — always publish together at the same version.

To prepare a release:

1. Bump the version in `packages/cli/package.json`
2. Run `node scripts/sync-versions.mjs` to stamp the same version into `packages/runtime` and `packages/compiler`, then `pnpm manifest` to restamp `packages/compiler/surface-manifest.json` with the new version, and commit both (the test suite's staleness guard fails on a version drift)
3. Fold the `## Unreleased` section of `CHANGELOG.md` into a new `## <version>` entry (newest first, below `## Unreleased`), and leave `## Unreleased` empty for the next cycle
4. Wrap the new entry in `<!-- release:start -->` and `<!-- release:end -->` markers; this marked block is also the GitHub release body
5. Remove the `<!-- release:start -->` and `<!-- release:end -->` markers from the previous release entry; only the latest release should have markers
6. With Zig on `PATH`, run `SCRIPTC_CROSS=1 pnpm exec vitest run tests/harness/library-cross.test.ts` and require the cross-target library conformance lane to pass
7. Commit to `main`

CI (`.github/workflows/release.yml`) compares the version in `packages/cli/package.json` to what `scriptc` has on npm. If it differs, it builds the workspace, verifies all three package versions match (a mismatch fails with a hint to run `scripts/sync-versions.mjs`), and publishes to npm in dependency order — `@scriptc/runtime`, then `@scriptc/compiler`, then `scriptc` — so each package's dependencies are resolvable the moment it lands. After the publish succeeds, a separate job creates the git tag `v<version>` and the GitHub release with the marked changelog entry as its body, and attaches `surface-manifest.json` — the machine-readable listing of the surface the static tier compiles at that version (stable per-entry ids, so two releases diff mechanically; see `packages/compiler/src/coverage/surface-manifest.ts` for the schema). The job regenerates the manifest from the tree and fails on any byte difference from the committed file before attaching, so the asset is always the manifest of the code being released. The same file ships inside the `@scriptc/compiler` package as `@scriptc/compiler/surface-manifest.json`.

Two deliberate differences from repositories that ship prebuilt binaries: there are no platform binary assets to build or stage — scriptc compiles programs on the user's machine with the local clang. The npm package's best-effort postinstall warms runtime, TLS, and engine caches against that exact local toolchain; it does not ship foreign objects. The GitHub release is therefore a tag, release notes, and the manifest asset only, and the npm publish never waits on the GitHub release (the release job runs after the publish, not before it).

Publishing uses npm trusted publishing (OIDC) — there is no npm token secret. The one-time setup is already done: each of the three packages is configured on npmjs.com with a GitHub Actions trusted publisher pointing at repository `vercel-labs/scriptc`, workflow `release.yml`, environment `Release`. A package missing that configuration fails with an OIDC authentication error before anything is uploaded. Re-runs are safe: any package already on the registry at the target version is skipped, so a partially published release can be resumed by re-running the workflow.
