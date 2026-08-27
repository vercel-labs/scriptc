import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadFfiProfile } from "../ffi/ffi-manifest.js";
import { createNativeLinkInfo, type NativeLinkFeatures } from "./native-link-info.js";
import { MACOS_ARM64_TARGET } from "./targets.js";

const BASE: NativeLinkFeatures = {
  dynamic: false,
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  fileHandle: false,
  fetch: false,
  netIsland: false,
  zlib: false,
  assert: false,
  inspect: false,
  dynInvoke: false,
  dc: false,
  dynAsync: false,
  events: false,
  emitter: false,
  symbol: false,
  searchParams: false,
  qs: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  watch: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  tlsCa: false,
};

describe("native link info recipes", () => {
  test("feature source sets reproduce runtime and vendor gates", async () => {
    const info = await createNativeLinkInfo({
      programObject: "/out/app.o",
      target: MACOS_ARM64_TARGET,
      features: {
        ...BASE,
        dynamic: true,
        regex: true,
        inspect: true,
        zlib: true,
        tls: true,
      },
      ffi: null,
    });
    const runtime = info.runtime_pack.source_sets.find((set) => set.name === "runtime")!;
    expect(runtime.sources).toEqual(expect.arrayContaining([
      "src/scr_regex.c",
      "src/scr_assert.c",
      "src/scr_inspect.c",
      "src/scr_zlib.c",
      "src/scr_zlib_island.c",
      "src/scr_tls.c",
      "src/scr_tls_ca.c",
      "src/scr_island.c",
      "src/scr_web.c",
      "src/scr_inspect_island.c",
    ]));
    expect(info.runtime_pack.source_sets.map((set) => set.name)).toEqual([
      "runtime", "quickjs", "mbedtls",
    ]);
    expect(info.runtime_pack.source_sets.find((set) => set.name === "mbedtls")!.sources.length)
      .toBeGreaterThan(100);
    expect(info.link.system_libraries).toEqual(["System", "z", "m"]);
  });

  test("dev object recipes keep runtime optimization in lockstep", async () => {
    const info = await createNativeLinkInfo({
      programObject: "/out/app.o",
      target: MACOS_ARM64_TARGET,
      features: BASE,
      ffi: null,
      optimization: "dev",
    });
    expect(info.runtime_pack.source_sets[0]?.c_flags).toContain("-O0");
    expect(info.runtime_pack.source_sets[0]?.c_flags).not.toContain("-O2");
  });

  test("FFI symbols and resolved inputs remain ordered before the runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-native-link-info-unit-"));
    const library = join(dir, "native.o");
    const manifest = join(dir, "ffi.json");
    await writeFile(library, "fixture");
    await writeFile(manifest, JSON.stringify({
      ffi_format: 1,
      functions: [{
        name: "nativeScale",
        symbol: "native_scale",
        params: ["f64"],
        returns: "f64",
      }],
      libraries: ["./native.o"],
      system_libraries: ["sqlite3"],
    }));
    const loaded = loadFfiProfile(manifest);
    if (!loaded.ok) throw new Error(loaded.diagnostics[0]?.message);
    const info = await createNativeLinkInfo({
      programObject: "/out/app.o",
      target: MACOS_ARM64_TARGET,
      features: BASE,
      ffi: loaded.profile,
    });
    expect(info.ffi).toEqual({
      format: 1,
      symbols: ["native_scale"],
      libraries: [library],
    });
    expect(info.link.input_order.slice(0, 3)).toEqual([
      "/out/app.o", library, "runtime/*.o",
    ]);
    expect(info.link.system_libraries).toEqual(["sqlite3", "System"]);
  });
});
