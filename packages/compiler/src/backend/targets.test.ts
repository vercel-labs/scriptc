import { describe, expect, test } from "vitest";
import {
  LINUX_ARM64_GNU_TARGET,
  LINUX_ARM64_MUSL_TARGET,
  LINUX_X64_GNU_TARGET,
  LINUX_X64_MUSL_TARGET,
  MACOS_ARM64_TARGET,
  MACOS_X64_TARGET,
  WASM32_WASI_TARGET,
  WINDOWS_X64_MSVC_TARGET,
  nativeCodegenTarget,
  nativeCodegenTargetRefusal,
} from "./targets.js";

describe("native code-generation targets", () => {
  test("selects only fully specified host-native targets", () => {
    expect(nativeCodegenTarget({}, "darwin", "arm64", "24.0.0")).toEqual(MACOS_ARM64_TARGET);
    expect(nativeCodegenTarget({}, "darwin", "x64", "24.0.0")).toEqual(MACOS_X64_TARGET);
    expect(nativeCodegenTarget({}, "linux", "x64", "6.8.0", "gnu")).toEqual(LINUX_X64_GNU_TARGET);
    expect(nativeCodegenTarget({}, "linux", "arm64", "6.8.0", "gnu")).toEqual(LINUX_ARM64_GNU_TARGET);
    expect(nativeCodegenTarget({}, "linux", "x64", "6.8.0", "musl")).toEqual(LINUX_X64_MUSL_TARGET);
    expect(nativeCodegenTarget({}, "linux", "arm64", "6.8.0", "musl")).toEqual(LINUX_ARM64_MUSL_TARGET);
    expect(nativeCodegenTarget({}, "win32", "x64", "10.0.0")).toEqual(WINDOWS_X64_MSVC_TARGET);
    expect(nativeCodegenTarget({}, "darwin", "arm64", "23.6.0")).toBeNull();
    expect(nativeCodegenTarget({}, "linux", "ia32", "6.8.0")).toBeNull();
    expect(nativeCodegenTarget({ SCRIPTC_TARGET: "x86_64-linux-musl" }, "linux", "x64", "6.8.0", "musl"))
      .toEqual(LINUX_X64_MUSL_TARGET);
    expect(nativeCodegenTarget({ SCRIPTC_TARGET: "aarch64-linux-musl" }, "linux", "arm64", "6.8.0", "musl"))
      .toEqual(LINUX_ARM64_MUSL_TARGET);
    expect(nativeCodegenTarget({ SCRIPTC_TARGET: "wasm32-wasi" }, "darwin", "x64", "24.0.0"))
      .toEqual(WASM32_WASI_TARGET);
    expect(nativeCodegenTarget(
      { SCRIPTC_TARGET: "aarch64-apple-ios" }, "darwin", "arm64", "24.0.0",
    ))
      .toBeNull();
  });

  test("refusals name the unsupported host or cross target", () => {
    expect(nativeCodegenTargetRefusal({}, "linux", "ia32", "6.8.0")).toContain("linux ia32");
    expect(nativeCodegenTargetRefusal({}, "darwin", "arm64", "23.6.0"))
      .toContain("requires macOS 15.0 or newer");
    expect(nativeCodegenTargetRefusal(
      { SCRIPTC_TARGET: "x86_64-linux-gnu.2.36" },
      "darwin",
      "arm64",
      "24.0.0",
    )).toContain("SCRIPTC_TARGET=x86_64-linux-gnu.2.36");
  });

  test("owns helper executable linker arguments in the target specification", () => {
    expect(MACOS_ARM64_TARGET.executableLinkerArgs).toEqual([
      "-target",
      "arm64-apple-macosx14.0.0",
      "-pthread",
      "-Wl,-dead_strip",
    ]);
  });

  test("describes the WASI relocatable-object ABI", () => {
    expect(WASM32_WASI_TARGET.supports).toMatchObject({ asm: true, obj: true, exe: true });
  });
});
