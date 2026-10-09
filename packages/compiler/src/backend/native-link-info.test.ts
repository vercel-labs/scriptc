import { describe, expect, test, vi } from "vitest";
import { createNativeLinkInfo, type NativeLinkFeatures } from "./native-link-info.js";
import { MACOS_ARM64_TARGET, WASM32_WASI_TARGET } from "./targets.js";
import { loadRuntimePack } from "./runtime-pack.js";

vi.mock("./runtime-pack.js", () => ({
  loadRuntimePack: vi.fn(async ({ target, optimization }) => ({
    root: "/installed/runtime",
    manifest: { package: target.runtimePackPackage, version: "1.2.3" },
    flavor: optimization,
    runtimeObjects: ["/installed/runtime/base.o"],
    archives: ["/installed/runtime/vendor.a"],
    selectedRuntimeArtifacts: [{ path: "base.o", sha256: "1".repeat(64), size: 42 }],
    selectedArchiveArtifacts: [{ path: "vendor.a", sha256: "2".repeat(64), size: 84 }],
    systemLibraries: [...target.runtimeSystemLibraries],
  })),
}));
const features = {} as NativeLinkFeatures;

describe("native link info", () => {
  test("reports verified precompiled inputs with their integrity metadata and link order", async () => {
    const info = await createNativeLinkInfo({
      programObject: "/out/app.o",
      target: MACOS_ARM64_TARGET,
      features,
      ffi: {
        ffiFormat: 7,
        libraries: ["/ffi/native.a"],
        systemLibraries: ["sqlite3"],
        frameworks: ["Foundation"],
        functions: [
          { name: "native", symbol: "native", params: [], returns: "void" },
          {
            name: "release",
            symbol: "release",
            params: [],
            returns: "void",
            callbackOperation: "release",
          },
        ],
      },
    });
    expect(info.runtime_pack).toEqual({
      kind: "precompiled",
      package: "@scriptc/runtime-darwin-arm64",
      version: "1.2.3",
      root: "/installed/runtime",
      path_base: "runtime_pack.root",
      flavor: "release",
      objects: [{ path: "base.o", sha256: "1".repeat(64), size: 42 }],
      archives: [{ path: "vendor.a", sha256: "2".repeat(64), size: 84 }],
    });
    expect(info.ffi.symbols).toEqual(["native"]);
    expect(info.link.input_order).toEqual([
      "/installed/runtime/base.o",
      "/installed/runtime/vendor.a",
      "/out/app.o",
      "/ffi/native.a",
    ]);
    expect(info.link.system_libraries).toEqual(["sqlite3", "System"]);
    expect(info.link.frameworks).toEqual(["Foundation"]);
    expect(info.link.driver_flags).toContain("-Wl,-dead_strip");
    expect(loadRuntimePack).toHaveBeenLastCalledWith({
      target: MACOS_ARM64_TARGET,
      features,
      optimization: "release",
    });
  });

  test("WASI release and dev select their runtime flavor and debug-link policy", async () => {
    for (const optimization of ["release", "dev"] as const) {
      const info = await createNativeLinkInfo({
        programObject: "/out/app.o",
        target: WASM32_WASI_TARGET,
        features,
        ffi: null,
        optimization,
      });
      expect(info.runtime_pack.flavor).toBe(optimization);
      expect(info.link.driver_flags.includes("-Wl,--strip-debug")).toBe(optimization === "release");
    }
  });

  test("rejects non-Darwin frameworks before selecting a pack", async () => {
    vi.mocked(loadRuntimePack).mockClear();
    await expect(
      createNativeLinkInfo({
        programObject: "/out/app.o",
        target: WASM32_WASI_TARGET,
        features,
        ffi: {
          ffiFormat: 7,
          libraries: [],
          systemLibraries: [],
          frameworks: ["Foundation"],
          functions: [],
        },
      }),
    ).rejects.toThrow("Darwin");
    expect(loadRuntimePack).not.toHaveBeenCalled();
  });
});
