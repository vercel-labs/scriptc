import { chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Compiled-binary + oracle caches for the test lanes (see cc.ts's cache block
// and tests/harness/README.md). Workers inherit SCRIPTC_CACHE_DIR from here;
// SCRIPTC_NO_CACHE=1 in the caller's environment bypasses every cache in both
// directions (no reads, no writes). Production builds use the platform cache;
// this explicit override keeps test artifacts repo-local and disposable.
const configuredCacheDir = process.env["SCRIPTC_CACHE_DIR"];
const cacheDir =
  configuredCacheDir ??
  fileURLToPath(new URL("./node_modules/.cache/scriptc-tests/cas", import.meta.url));

// The production cache refuses an existing explicit override that is visible
// to other users. This repository owns the default test-only override, so
// create (or repair) it before any oracle subdirectory can implicitly create
// the root with the process umask (normally 0755). Otherwise native caching is
// silently disabled and every corpus case recompiles the complete C runtime.
if (configuredCacheDir === undefined && process.env["SCRIPTC_NO_CACHE"] !== "1") {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(cacheDir, 0o700);
}

// Contention control for concurrent agents: SCRIPTC_TEST_WORKERS caps the vitest
// worker pool (the default — all cores — is unchanged when unset). Full-suite
// runs additionally queue behind an advisory lock; see suite-lock.mjs.
const workers = process.env["SCRIPTC_TEST_WORKERS"];
const effectConcurrency = process.env["SCRIPTC_EFFECT_TEST_CONCURRENCY"];
if (effectConcurrency !== undefined && effectConcurrency !== "1" && effectConcurrency !== "2") {
  throw new Error("SCRIPTC_EFFECT_TEST_CONCURRENCY must be 1 or 2");
}

export default defineConfig({
  resolve: {
    alias: {
      "@scriptc/compiler/cli/command": fileURLToPath(
        new URL("./packages/compiler/src/cli/command.ts", import.meta.url),
      ),
      "@scriptc/compiler/cli/host": fileURLToPath(
        new URL("./packages/compiler/src/cli/host.ts", import.meta.url),
      ),
      "@scriptc/compiler/cli/paths": fileURLToPath(
        new URL("./packages/compiler/src/cli/paths.ts", import.meta.url),
      ),
      "@scriptc/compiler/cli/output-options": fileURLToPath(
        new URL("./packages/compiler/src/cli/output-options.ts", import.meta.url),
      ),
      "@scriptc/compiler/cli/usage": fileURLToPath(
        new URL("./packages/compiler/src/cli/usage.ts", import.meta.url),
      ),
      // Tests run against compiler source directly — no build step needed.
      "@scriptc/compiler": fileURLToPath(
        new URL("./packages/compiler/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "tests/harness/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
    ],
    // Differential tests spawn clang + binaries; give them room. 300s is a
    // hang detector, not a performance bound: under a merge gate sharing
    // the box with lane compiles, a legitimately compile-heavy corpus
    // entry can starve past 120s (1751 timed out twice on 2026-07-20 while
    // passing in 3s isolated and uncached). The sanitized lane gets twice
    // that: ASan runs the heavy tests at up to twice their plain time, and on
    // 2026-11-04 five sanitized self-hosting tests that had been passing at
    // 259 to 296 s on the shared 300 s went past it on slower runners (the
    // same test varies by 20 to 40% from run to run). The longest sanitized
    // test on this default now takes 186 s.
    testTimeout: process.env["SCRIPTC_SAN"] === "1" ? 600_000 : 300_000,
    hookTimeout: 300_000,
    ...(effectConcurrency === "2" ? { maxConcurrency: 2 } : {}),
    env: {
      SCRIPTC_CACHE_DIR: cacheDir,
      // The compiler-level store sits outside the build cache by design; point
      // it at the repo-local test directory too, so a test run leaves nothing
      // in the user's cache.
      SCRIPTC_STATE_DIR: fileURLToPath(
        new URL("./node_modules/.cache/scriptc-tests/compiler-state", import.meta.url),
      ),
      // The differential lanes run against one immutable checkout/toolchain
      // per worker. Reuse expensive compiler/linker metadata probes inside
      // that session; cc.test.ts removes this flag to keep exercising
      // production's fresh-probe invalidation guarantees.
      SCRIPTC_TEST_STABLE_TOOLCHAIN: process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"] ?? "1",
    },
    ...(workers !== undefined && workers !== ""
      ? { maxWorkers: Number(workers), minWorkers: 1 }
      : {}),
    globalSetup: ["./tests/harness/suite-lock.mjs"],
  },
});
