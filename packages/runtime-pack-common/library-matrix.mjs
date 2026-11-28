/** Runtime library modes have distinct trap and state ownership contracts. */
export function withLibraryRuntimeFlavors(matrix) {
  // A wasm pack carries the EventTarget unit in every flavor (AbortSignal
  // dispatches through it, and the wasm build lists it in extraRuntimeSources),
  // and that unit propagates an abort through the async unit's spawn-after.
  // Omitting scr_async.c there leaves scr_async_spawn_after and the promise
  // calls it makes undefined when a library flavor links.
  const omitted = new Set([
    ...(matrix.target.object_format === "wasm" ? [] : ["scr_async.c"]),
    "scr_crypto_async.c",
    "scr_child.c",
    "scr_ffi.c",
  ]);
  const optional = new Set([
    "scr_regex.c",
    "scr_path_win32_relative.c",
    "scr_glob.c",
    "scr_assert.c",
    "scr_inspect.c",
    "scr_console_native.c",
    // The inspect unit reads inspect.colors from the style unit's table, so
    // a library whose program renders a colored value carries it too.
    "scr_util_style.c",
    "scr_symbol.c",
    "scr_bigint_assert.c",
    "scr_url_params.c",
    "scr_events_emitter.c",
    "scr_dyn_handle.c",
    "scr_zlib.c",
    "scr_x509.c",
    "scr_copying.c",
    "scr_dyn_invoke.c",
    "scr_bytes_dyn.c",
    "scr_js_value.c",
    "scr_js_object.c",
    // The buffer views registry: a library whose program resizes, grows or
    // detaches a buffer names scr_js_buffers_arm from its own object, so the
    // library flavors must carry the unit the executable flavors compile.
    "scr_js_buffers.c",
    // The kept-source read of a record-to-record conversion: a library
    // whose program projects a record calls it, so the library flavors
    // carry the same optional unit the executable flavors compile.
    "scr_record_source_get.c",
    // The join of an array of strings: a library whose program joins one
    // calls scr_arr_join_str, so the library flavors carry the same optional
    // unit the executable flavors compile.
    "scr_arr_join_str.c",
    // The adoption unit: a library whose program checks a dynamic value's
    // type calls scr_decl_adopt, and the archive must carry it or the
    // embedder's link fails. The executable flavors compile it the same way.
    "scr_decl_adopt.c",
    // The prototype read of a class test's walk: an instanceof on an untyped
    // value calls scr_dyn_class_test_prototype, so the library flavors carry
    // the same optional unit the executable flavors compile.
    "scr_dyn_class_test.c",
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
    // Libraries run neither workers nor the young-in nursery (an
    // executable-only experiment), and they carry no promise unit, so no
    // promise adapter exists for a checked-dynamic key to name.
    variants: unit.variants.filter(
      (variant) =>
        !variant.defines.includes("SCR_WORKERS") &&
        !variant.defines.includes("SCR_YIN") &&
        !variant.defines.includes("SCR_DYN_PROMISE_KEYS"),
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
