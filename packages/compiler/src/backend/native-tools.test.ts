import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  NATIVE_CODEGEN_LLVM_VERSION,
  NATIVE_CODEGEN_PROTOCOL_VERSION,
} from "./native-codegen-core.js";
import { verifyNativeHelper } from "./native-tools.js";
import { LINUX_X64_GNU_TARGET } from "./targets.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A helper package directory and the options that verify it. */
function helperOptions() {
  const packageRoot = mkdtempSync(join(tmpdir(), "scriptc-helper-"));
  directories.push(packageRoot);
  const target = LINUX_X64_GNU_TARGET;
  const helper = target.helper;
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: helper.packageName, version: "1.2.3" }),
  );
  vi.mocked(execFileSync).mockReturnValue(
    JSON.stringify({
      ok: true,
      protocol_version: NATIVE_CODEGEN_PROTOCOL_VERSION,
      scriptc_package_version: "1.2.3",
      llvm_version: NATIVE_CODEGEN_LLVM_VERSION,
      default_target: helper.defaultTarget,
      data_layout: helper.defaultDataLayout,
      targets: [target.llvmBackend],
      supported_targets: [target.llvmTriple],
      host_triple: target.llvmTriple,
    }),
  );
  return {
    executable: join(packageRoot, "helper"),
    packageRoot,
    compilerVersion: "1.2.3",
    target,
    helper,
  };
}

test("a helper the verification record knows is not asked for its version again", () => {
  const options = helperOptions();
  let known = false;
  const remember = vi.fn(() => {
    known = true;
  });
  const verified = { known: () => known, remember };
  verifyNativeHelper({ ...options, verified });
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(remember).toHaveBeenCalledTimes(1);
  verifyNativeHelper({ ...options, verified });
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(remember).toHaveBeenCalledTimes(1);
});

test("a helper whose version answer is rejected is not recorded", () => {
  const options = helperOptions();
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ ok: false }));
  const remember = vi.fn();
  expect(() =>
    verifyNativeHelper({ ...options, verified: { known: () => false, remember } }),
  ).toThrow(/incompatible/);
  expect(remember).not.toHaveBeenCalled();
});

test("the package identity is checked even for a helper the record knows", () => {
  const options = helperOptions();
  const remember = vi.fn();
  expect(() =>
    verifyNativeHelper({
      ...options,
      compilerVersion: "9.9.9",
      verified: { known: () => true, remember },
    }),
  ).toThrow(/package mismatch/);
  expect(execFileSync).not.toHaveBeenCalled();
});
