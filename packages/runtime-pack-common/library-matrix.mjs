/** Runtime library modes have distinct trap and state ownership contracts. */
export function withLibraryRuntimeFlavors(matrix) {
  const omitted = new Set(["scr_async.c", "scr_crypto_async.c", "scr_child.c", "scr_ffi.c"]);
  const optional = new Set([
    "scr_regex.c",
    "scr_assert.c",
    "scr_inspect.c",
    "scr_console_native.c",
    "scr_symbol.c",
    "scr_bigint_assert.c",
    "scr_url_params.c",
    "scr_events_emitter.c",
    "scr_dyn_handle.c",
    "scr_zlib.c",
    "scr_copying.c",
    "scr_dyn_invoke.c",
  ]);
  const libraryUnits = [
    ...matrix.runtime_units.filter(
      (unit) => !omitted.has(unit.source) && (unit.predicate === true || optional.has(unit.source)),
    ),
    {
      source: "scr_library.c",
      predicate: true,
      variants: [{ id: "default", when: {}, defines: [] }],
    },
  ].map((unit) => ({
    ...unit,
    variants: unit.variants.filter(
      (variant) =>
        !variant.defines.includes("SCR_DYNAMIC") && !variant.defines.includes("SCR_WORKERS"),
    ),
  }));
  const flavors = { ...matrix.flavors };
  for (const [flavor, spec] of Object.entries(matrix.flavors)) {
    flavors[`library-${flavor}`] = { ...spec, defines: ["SCR_LIB"], runtime_units: libraryUnits };
    if (matrix.target.object_format !== "wasm") {
      flavors[`library-thread-${flavor}`] = {
        ...spec,
        defines: ["SCR_LIB", "SCR_THREAD_INSTANCES"],
        runtime_units: libraryUnits,
      };
    }
  }
  return { ...matrix, flavors };
}
