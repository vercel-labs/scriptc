import { expect, test } from "vitest";
import { createRuntimePackMatrix } from "../runtime-pack-matrix.mjs";

const matrix = createRuntimePackMatrix({
  target: { object_format: "macho" },
  compileFlags: [],
  systemLibraries: [],
});

test("checked URL handles include their search-parameter dependency without a feature opt-in", () => {
  for (const object_format of ["elf", "macho", "coff", "wasm"]) {
    const pack = createRuntimePackMatrix({
      target: { object_format },
      compileFlags: [],
      systemLibraries: [],
    });
    const unit = pack.runtime_units.find((unit) => unit.source === "scr_url_params.c");
    expect(unit?.predicate).toBe(true);
  }
});

test("library pack modes preserve pure runtime features and exclude ambient event-loop code", () => {
  for (const optimization of ["release", "dev"]) {
    for (const mode of ["library", "library-thread"]) {
      const flavor = matrix.flavors[`${mode}-${optimization}`];
      expect(flavor.defines).toEqual(
        mode === "library" ? ["SCR_LIB"] : ["SCR_LIB", "SCR_THREAD_INSTANCES"],
      );
      expect(flavor.optimization).toBe(optimization === "release" ? "-O2" : "-O0");
      const sources = flavor.runtime_units.map((unit) => unit.source);
      expect(sources).toContain("scr_library.c");
      for (const source of [
        "scr_async.c",
        "scr_crypto_async.c",
        "scr_child.c",
        "scr_ffi.c",
        "scr_island.c",
        "scr_net.c",
      ])
        expect(sources).not.toContain(source);
      for (const source of [
        "scr_regex.c",
        "scr_glob.c",
        "scr_assert.c",
        "scr_events_emitter.c",
        "scr_zlib.c",
        "scr_inspect.c",
        "scr_console_native.c",
        "scr_copying.c",
      ])
        expect(sources).toContain(source);
      for (const unit of flavor.runtime_units)
        for (const variant of unit.variants) expect(variant.defines).not.toContain("SCR_DYNAMIC");
      expect(
        flavor.runtime_units
          .find((unit) => unit.source === "scr_bytes.c")
          .variants.map((variant) => variant.id),
      ).toEqual(["default", "text-decoder-legacy"]);
    }
  }
  expect(matrix.runtime_units.some((unit) => unit.source === "scr_library.c")).toBe(false);
});

test("the young-in nursery collector is an executable-only variant of scr_cycle.c", () => {
  const ids = (units: { source: string; variants: { id: string }[] }[]) =>
    units.find((unit) => unit.source === "scr_cycle.c")!.variants.map((variant) => variant.id);
  expect(ids(matrix.runtime_units)).toEqual([
    "default",
    "default-workers",
    "young-nursery",
    "young-nursery-workers",
  ]);
  const young = matrix.runtime_units
    .find((unit) => unit.source === "scr_cycle.c")
    .variants.find((variant) => variant.id === "young-nursery");
  expect(young).toMatchObject({
    when: { youngNursery: true, workers: false },
    defines: ["SCR_YIN"],
  });
  for (const mode of ["library-release", "library-thread-release"])
    expect(ids(matrix.flavors[mode].runtime_units)).toEqual(["default"]);
});

test("mobile packs ship only library modes and their permitted vendor archives", () => {
  const mobile = createRuntimePackMatrix({
    target: { object_format: "elf" },
    compileFlags: [],
    systemLibraries: [],
    libraryOnly: true,
  });
  expect(Object.keys(mobile.flavors).sort()).toEqual([
    "library-dev",
    "library-release",
    "library-thread-dev",
    "library-thread-release",
  ]);
  expect(mobile.archives.map(({ id }) => id)).toEqual(["libregexp", "zlib"]);
});

test("Wasm packs include reactor runtimes without thread-local state or a JS engine", () => {
  const wasm = createRuntimePackMatrix({
    target: { object_format: "wasm" },
    compileFlags: [],
    systemLibraries: [],
  });
  expect(Object.keys(wasm.flavors).sort()).toEqual([
    "dev",
    "library-dev",
    "library-release",
    "release",
  ]);
  for (const name of ["library-release", "library-dev"]) {
    expect(wasm.flavors[name].defines).toEqual(["SCR_LIB"]);
    const sources = wasm.flavors[name].runtime_units.map((unit) => unit.source);
    expect(sources).toContain("scr_library.c");
    expect(sources).not.toContain("scr_island.c");
    expect(sources).not.toContain("scr_async.c");
  }
});
