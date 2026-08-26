import { describe, expect, test } from "vitest";
import { MACOS_ARM64_TARGET, nativeCodegenTarget, nativeCodegenTargetRefusal } from "./targets.js";

describe("native code-generation targets", () => {
  test("admits only host-native macOS arm64", () => {
    expect(nativeCodegenTarget({}, "darwin", "arm64")).toEqual(MACOS_ARM64_TARGET);
    expect(nativeCodegenTarget({}, "darwin", "x64")).toBeNull();
    expect(nativeCodegenTarget({}, "linux", "arm64")).toBeNull();
    expect(nativeCodegenTarget({ SCRIPTC_TARGET: "aarch64-apple-ios" }, "darwin", "arm64"))
      .toBeNull();
  });

  test("refusals name the unsupported host or cross target", () => {
    expect(nativeCodegenTargetRefusal({}, "linux", "x64")).toContain("linux x64");
    expect(nativeCodegenTargetRefusal(
      { SCRIPTC_TARGET: "x86_64-linux-gnu.2.36" },
      "darwin",
      "arm64",
    )).toContain("SCRIPTC_TARGET=x86_64-linux-gnu.2.36");
  });
});
