import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  NATIVE_CODEGEN_LLVM_VERSION,
  NATIVE_CODEGEN_PROTOCOL_VERSION,
} from "./native-codegen-core.js";
import { emitNativeObject, verifyNativeHelper } from "./native-tools.js";
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

/** The options of an emit whose helper the record already verified. */
function emitOptions() {
  const options = helperOptions();
  return {
    ...options,
    verified: { known: () => true, remember: vi.fn() },
    inputPath: join(options.packageRoot, "program.ll"),
    outputPath: join(options.packageRoot, "program.o"),
    sourcePath: "program.ts",
    optimization: "release" as const,
  };
}

test.skipIf(process.platform === "win32")(
  "a helper killed without a diagnostic reports the signal that ended it",
  () => {
    const options = emitOptions();
    vi.mocked(execFileSync).mockImplementation((() => {
      throw Object.assign(new Error("Command failed: helper emit --input program.ll"), {
        code: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
      });
    }) as never);
    expect(() => emitNativeObject(options)).toThrow(
      /LLVM native helper failed: Command failed: helper emit --input program\.ll \(signal SIGKILL\)$/,
    );
  },
);

test("a helper's structured diagnostic reaches the build diagnostic", () => {
  const options = emitOptions();
  const stderr = '{"ok":false,"code":"verification_failed","message":"bad module"}';
  vi.mocked(execFileSync).mockImplementation((() => {
    throw Object.assign(new Error(`Command failed: helper emit --input program.ll\n${stderr}`), {
      status: 1,
      signal: null,
      stdout: "",
      stderr,
    });
  }) as never);
  expect(() => emitNativeObject(options)).toThrow(
    "LLVM native helper failed (verification_failed): bad module",
  );
});

test.skipIf(process.platform === "win32")(
  "a helper that exits without a diagnostic reports its exit status",
  () => {
    const options = emitOptions();
    vi.mocked(execFileSync).mockImplementation((() => {
      throw Object.assign(new Error("Command failed: helper emit --input program.ll\n"), {
        status: 3,
        signal: null,
        stdout: "",
        stderr: "",
      });
    }) as never);
    expect(() => emitNativeObject(options)).toThrow(/\(exit status 3\)$/);
  },
);

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
