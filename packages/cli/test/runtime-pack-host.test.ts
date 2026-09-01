import { describe, expect, test } from "vitest";
import { hostSupportsRuntimePack } from "../scripts/runtime-pack-host.mjs";

describe("runtime-pack host support", () => {
  test("recognizes each platform with a release-built runtime pack", () => {
    expect(hostSupportsRuntimePack("darwin", "arm64", "24.0.0")).toBe(true);
    expect(hostSupportsRuntimePack("darwin", "x64", "24.0.0")).toBe(true);
    expect(hostSupportsRuntimePack("darwin", "arm64", "23.6.0")).toBe(false);
    expect(hostSupportsRuntimePack("linux", "x64", "6.8.0")).toBe(true);
    expect(hostSupportsRuntimePack("linux", "arm64", "6.8.0")).toBe(true);
    expect(hostSupportsRuntimePack("win32", "x64", "10.0.0")).toBe(true);
    expect(hostSupportsRuntimePack("linux", "ia32", "6.8.0")).toBe(false);
  });
});
