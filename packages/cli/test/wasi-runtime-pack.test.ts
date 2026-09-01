import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const helperPackage = require.resolve("@scriptc/llvm-darwin-arm64/package.json");
const helper = join(dirname(helperPackage), "bin", "scriptc-llvm-codegen");
const runtimePackage = require.resolve("@scriptc/runtime-wasm32-wasi/package.json");
const runtimeManifest = join(dirname(runtimePackage), "runtime-pack.json");
const supported = existsSync(helper) && existsSync(runtimeManifest);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test.runIf(supported)("WASI helper object plus runtime pack builds and runs without SCRIPTC_CC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-wasi-runtime-pack-"));
  dirs.push(dir);
  const output = join(dir, "hello.wasm");
  const zigCache = join(dir, "zig-cache");
  await expect(execFileAsync(process.execPath, [
    "--import", tsxLoader, cliEntry, "run", join(repoRoot, "tests/corpus/001-hello.ts"), "-o", output,
  ], {
    env: {
      ...process.env,
      SCRIPTC_TARGET: "wasm32-wasi",
      SCRIPTC_NO_CACHE: "1",
      SCRIPTC_LEGACY_C_PIPELINE: "0",
      ZIG_GLOBAL_CACHE_DIR: join(zigCache, "global"),
      ZIG_LOCAL_CACHE_DIR: join(zigCache, "local"),
    },
    encoding: "utf8",
  })).resolves.toMatchObject({ stdout: "hello world\n" });
});
