import { describe, expect, test } from "vitest";
import { hostSupportsRuntimePack } from "../scripts/runtime-pack-host.mjs";

describe("runtime-pack host support", () => {
  test("requires macOS 15 or newer on arm64", () => {
    expect(hostSupportsRuntimePack("darwin", "arm64", "24.0.0")).toBe(true);
    expect(hostSupportsRuntimePack("darwin", "arm64", "23.6.0")).toBe(false);
    expect(hostSupportsRuntimePack("darwin", "x64", "24.0.0")).toBe(false);
    expect(hostSupportsRuntimePack("linux", "arm64", "24.0.0")).toBe(false);
  });
});
