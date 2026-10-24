# Releasing

Releases are manual, single-commit affairs. The maintainer controls the changelog voice and format. `@scriptc/runtime`, every platform helper/runtime pack, `@scriptc/compiler`, `@scriptc/experimental`, `@scriptc/node`, `@scriptc/threads`, and `scriptc` always publish together at the same version.

To prepare a release:

1. Bump the version in `packages/cli/package.json`
2. Run `node scripts/sync-versions.mjs` to stamp the same version into the runtime, helper, compiler, experimental, node, and threads packages, then `pnpm manifest` to restamp `packages/compiler/surface-manifest.json` with the new version, and commit both (the test suite's staleness guard fails on a version drift)
3. Fold the `## Unreleased` section of `CHANGELOG.md` into a new `## <version>` entry (newest first, below `## Unreleased`), and leave `## Unreleased` empty for the next cycle
4. Wrap the new entry in `<!-- release:start -->` and `<!-- release:end -->` markers; this marked block is also the GitHub release body
5. Remove the `<!-- release:start -->` and `<!-- release:end -->` markers from the previous release entry; only the latest release should have markers
6. With Zig on `PATH`, run `SCRIPTC_CROSS=1 pnpm exec vitest run tests/harness/library-cross.test.ts` and require the cross-target library conformance lane to pass
7. Commit to `main`

CI (`.github/workflows/release.yml`) compares the version in `packages/cli/package.json` to what `scriptc` has on npm. If it differs, it builds platform packages on matching macOS, Linux, and Windows runners, verifies the version spine, and publishes the runtime, helper, compiler, and CLI packages in dependency order. After the publish succeeds, a separate job creates the git tag `v<version>` and the GitHub release with the marked changelog entry as its body, and attaches `surface-manifest.json` — the machine-readable listing of the surface the static tier compiles at that version (stable per-entry ids, so two releases diff mechanically; see `packages/compiler/src/coverage/surface-manifest.ts` for the schema). The job regenerates the manifest from the tree and fails on any byte difference from the committed file before attaching, so the asset is always the manifest of the code being released. The same file ships inside the `@scriptc/compiler` package as `@scriptc/compiler/surface-manifest.json`.

The release job builds each pinned LLVM helper, precompiled runtime pack, and native CLI on its matching host. The native CLI bundles its TypeScript checker, LLVM helper, runtime pack, declarations, and comptime evaluator. npm postinstall installs the matching native executable; Node is needed for npm installation but not native compilation or execution. The user's toolchain performs the final platform link. Sanitized builds also use it to instrument program LLVM and compile the C runtime. Platform packages publish ahead of `@scriptc/compiler` and `scriptc`. The GitHub release attaches standalone compiler archives, their SHA-256 checksums, and the surface manifest after npm publication succeeds.

Release builds of the native CLI optimize the compiler with the committed profile `packages/compiler/native/cli.profdata` on every platform. Code the profile does not describe, or describes from older compiler sources, is optimized as without a profile. Refresh the profile on a quiet Linux x64 host when compiler code has changed substantially since the last refresh: `node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout>` builds an instrumented compiler, runs it on tsc-ts, a slice of the corpus, and the runtime benchmark workloads, and writes the merged sparse profile. Commit the new profile on its own.

Publishing uses npm trusted publishing (OIDC) — there is no npm token secret.
Each published package must have a GitHub Actions trusted publisher for
`release.yml` and the `Release` environment. A missing configuration fails
before upload. Re-runs skip package versions already present on npm, so a
partially published release can be resumed safely.

## libnode packs

The `@scriptc/libnode-<platform>` packs (linux-x64-gnu, linux-arm64-gnu, darwin-arm64, darwin-x64) carry the Node.js shared library that programs with Node islands load in process, plus the scriptc bridge compiled against it. They version in lockstep with the other platform packages (`sync-versions.mjs` stamps them); the Node release they contain is pinned separately in `packages/libnode-common/libnode.json`, which must match `.node-version` and `internal/compatibility/node-v24.json`. Each pack's `manifest.json` records the Node version, `NODE_MODULE_VERSION`, the bridge ABI and the size and SHA-256 of both libraries.

A Node `--shared` build takes about half an hour on 8 cores, so packs never build in `pnpm -r build`, the test suites or the release job. `.github/workflows/libnode-packs.yml` builds them on matching hosts when the pin, the bridge (`packages/libnode-common/bridge/`, `packages/runtime/src/scr_node_bridge.h`) or the pack packages change, or on manual dispatch. Linux packs build in the `manylinux_2_28` images (glibc 2.28, gcc-toolset-14) on native x64 and arm64 runners; Node disables its startup snapshot when cross-compiling, so arm64 is never cross-built. Each platform's libnode build is cached by Node release, configure flags, platform and toolchain; a bridge-only change restores libnode from the cache and rebuilds only the bridge. Every pack is smoke-tested by `packages/libnode-common/smoke/smoke.c`, which loads it the way the runtime does, and uploaded as the `libnode-<platform>` artifact, with zstd copies of both libraries as `libnode-<platform>-zst`. The Linux test lanes of `ci.yml` restore the cached linux-x64 build through `.github/actions/libnode-linux`, assemble the pack (`build.mjs --from-cache`, which never builds Node) and set `SCRIPTC_LIBNODE`, so the Node island tests run; without a cached build they skip with a warning. `packages/libnode-common/build-pack.mjs` assembles a pack from any matching libnode and headers, the bridge-only rebuild path.

To build one pack by hand on its own platform (it needs Python 3.9+, Ninja, a C++20 compiler and zstd; on Linux, build in a manylinux_2_28 container for a distributable pack):

```bash
pnpm --filter @scriptc/libnode-linux-x64-gnu build:native
node packages/libnode-common/scripts/verify.mjs packages/libnode-linux-x64-gnu
node packages/libnode-common/scripts/smoke.mjs
```

The packs are `private` until the in-process Node island runtime ships. Publishing them then means removing `private`, configuring their npm trusted publishers, and having the release job download the `libnode-<platform>` artifacts of the workflow run for the release commit (or call the workflow, which restores every platform from its cache) and publish them with the other platform packages.
