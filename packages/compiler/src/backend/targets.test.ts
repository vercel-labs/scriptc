import { describe, expect, test } from "vitest";
import { MACOS_ARM64_TARGET, nativeCodegenTarget, nativeCodegenTargetRefusal } from "./targets.js";

describe("native code-generation targets", () => {
  test("admits only host-native macOS arm64", () => {
    expect(nativeCodegenTarget({}, "darwin", "arm64", "24.0.0")).toEqual(MACOS_ARM64_TARGET);
    expect(nativeCodegenTarget({}, "darwin", "arm64", "23.6.0")).toBeNull();
    expect(nativeCodegenTarget({}, "darwin", "x64", "24.0.0")).toBeNull();
    expect(nativeCodegenTarget({}, "linux", "arm64", "6.8.0")).toBeNull();
    expect(nativeCodegenTarget(
      { SCRIPTC_TARGET: "aarch64-apple-ios" }, "darwin", "arm64", "24.0.0",
    ))
      .toBeNull();
  });

  test("refusals name the unsupported host or cross target", () => {
    expect(nativeCodegenTargetRefusal({}, "linux", "x64", "6.8.0")).toContain("linux x64");
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
});
