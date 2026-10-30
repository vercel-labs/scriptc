import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { afterEach, expect, test } from "vitest";
import {
  LLVM_DIST_TAG,
  LLVM_VERSION,
  helperLlvmDistArgs,
  llvmDistAsset,
} from "../../native/llvm-codegen/llvm-dist.mjs";

type Entry = { platform: string; helper?: string; llvm_dist?: string };
const release = load(
  readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, { strategy?: { matrix?: { include?: Entry[] } } }> };
const entries = release.jobs["build-native-packages"]!.strategy!.matrix!.include!;

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test("every release job that uploads a Linux helper links the same LLVM for it", () => {
  // The publish job merges the jobs' artifacts, so two jobs that upload the
  // same helper must build it the same way.
  const linux = entries.filter((entry) => entry.helper?.startsWith("llvm-linux-"));
  expect(linux.map((entry) => entry.platform).sort()).toEqual([
    "linux-arm64",
    "linux-arm64-musl",
    "linux-x64",
    "linux-x64-musl",
    "wasm32-wasi",
  ]);
  for (const entry of linux)
    expect(entry.llvm_dist, entry.platform).toBe(
      entry.helper!.includes("-arm64-") ? "arm64" : "x64",
    );
  for (const entry of entries.filter((entry) => !entry.helper?.startsWith("llvm-linux-")))
    expect(entry.llvm_dist, entry.platform).toBeUndefined();
});

test("the distribution names its archives after the LLVM version", () => {
  expect(LLVM_DIST_TAG).toMatch(
    new RegExp(`^llvm-${LLVM_VERSION.replaceAll(".", "\\.")}-pgo\\.\\d+$`),
  );
  expect(llvmDistAsset("x64")).toBe(`scriptc-llvm-${LLVM_VERSION}-linux-x64.tar.xz`);
});

test("helper builds use ThinLTO and the profile only when asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-llvm-dist-"));
  try {
    delete process.env["SCRIPTC_LLVM_THINLTO"];
    delete process.env["SCRIPTC_LLVM_PROFILE_GENERATE"];
    expect(helperLlvmDistArgs(dir)).toEqual([
      "-DSCRIPTC_LLVM_THINLTO=OFF",
      "-DSCRIPTC_LLVM_PROFILE_USE=",
      "-DSCRIPTC_LLVM_PROFILE_GENERATE=OFF",
    ]);
    process.env["SCRIPTC_LLVM_THINLTO"] = "1";
    const args = helperLlvmDistArgs(dir);
    expect(args).toContain("-DCMAKE_CXX_COMPILER=clang++");
    expect(args).toContain("-DSCRIPTC_LLVM_THINLTO=ON");
    const profile = args
      .find((arg) => arg.startsWith("-DSCRIPTC_LLVM_PROFILE_USE="))!
      .split("=")[1]!;
    // An indexed profile starts with the magic `\xfflprofi`.
    expect(readFileSync(profile).subarray(0, 8)).toEqual(
      Buffer.from([0xff, 0x6c, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x81]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
