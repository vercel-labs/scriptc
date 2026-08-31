/**
 * The executable runtime-pack matrix. This is the single source of truth for
 * both release compilation and the generated feature predicates consumed by
 * the compiler. A predicate is intentionally data, not JavaScript, so the
 * installed compiler can validate and evaluate it deterministically.
 */

const any = (...features) => ({ any: features });
const all = (...features) => ({ all: features });

const BASE_RUNTIME_SOURCES = [
  "scr_number.c", "scr_string.c", "scr_array.c", "scr_bytes.c",
  "scr_bytes_io.c", "scr_map.c", "scr_closure.c", "scr_ffi.c",
  "scr_object.c", "scr_union.c", "scr_exception.c", "scr_error.c",
  "scr_console.c", "scr_lib.c", "scr_path.c", "scr_url.c", "scr_json.c",
  "scr_async.c", "scr_child.c", "scr_cycle.c",
];

// ld64 dead-strips Mach-O symbol subsections without an ELF-style compile
// flag. Keep this checked-in metadata alongside the matrix so pack build and
// source/external linking share one documented executable recipe.
export const EXECUTABLE_SECTION_ELIMINATION = {
  compile_flags: [],
  link_flags: ["-Wl,-dead_strip"],
};

const optional = [
  ["scr_copying.c", "copying"],
  ["scr_file_handle.c", "fileHandle"],
  ["scr_regex.c", "regex"],
  ["scr_assert.c", any("assert", "regex", "symbol")],
  ["scr_inspect.c", "inspect"],
  ["scr_dyn_invoke.c", any("dynInvoke", "nativeFetch")],
  ["scr_dc.c", "dc"],
  ["scr_async_dyn.c", any("dynAsync", "dynInvoke", "dc", "nativeFetch")],
  ["scr_zlib.c", "zlib"],
  ["scr_zlib_island.c", all("zlib", "dynamic")],
  ["scr_events.c", "events"],
  ["scr_readline.c", "events"],
  ["scr_events_emitter.c", "emitter"],
  ["scr_dyn_handle.c", any("emitter", "netEffective")],
  ["scr_symbol.c", "symbol"],
  ["scr_url_params.c", "searchParams"],
  ["scr_qs.c", "qs"],
  ["scr_util.c", "parseArgs"],
  ["scr_stream.c", "stream"],
  ["scr_loop_kqueue.c", any("netEffective", "dgram")],
  ["scr_loop_epoll.c", any("netEffective", "dgram")],
  ["scr_loop_wsapoll.c", any("netEffective", "dgram")],
  ["scr_net.c", "netEffective"],
  ["scr_http.c", "httpEffective"],
  ["scr_http2.c", "http2"],
  ["scr_dgram.c", "dgram"],
  ["scr_watch.c", "watch"],
  ["scr_ffi_queue.c", "foreignFfi"],
  ["scr_test.c", "nodeTest"],
  ["scr_tls_ca.c", "tlsCaEffective"],
  ["scr_tls.c", "tlsEffective"],
  ["scr_fetch.c", "nativeFetch"],
  ["scr_island.c", "dynamic"],
  ["scr_web.c", "dynamic"],
  ["scr_inspect_island.c", all("dynamic", "inspect")],
  ["scr_net_island.c", "netIslandEffective"],
];

function variantsFor(source) {
  const dynamicOnly = new Set([
    "scr_zlib_island.c", "scr_island.c", "scr_web.c",
    "scr_inspect_island.c", "scr_net_island.c",
  ]);
  if (dynamicOnly.has(source)) {
    return [{ id: "dynamic", when: { dynamic: true }, defines: ["SCR_DYNAMIC"] }];
  }
  const variants = [{ id: "default", when: {}, defines: [] }];
  if (source === "scr_bytes.c") {
    variants.push({
      id: "text-decoder-legacy",
      when: { textDecoderLegacy: true },
      defines: ["SCR_TEXT_DECODER_LEGACY"],
    });
  }
  variants.push({ id: "dynamic", when: { dynamic: true }, defines: ["SCR_DYNAMIC"] });
  if (source === "scr_bytes.c") {
    variants.push({
      id: "dynamic-text-decoder-legacy",
      when: { dynamic: true, textDecoderLegacy: true },
      defines: ["SCR_DYNAMIC", "SCR_TEXT_DECODER_LEGACY"],
    });
  }
  return variants;
}

export const RUNTIME_PACK_MATRIX = {
  schema: "scriptc.runtime-pack-matrix.v1",
  target: {
    name: "macos-arm64",
    llvm_triple: "arm64-apple-macosx14.0.0",
    architecture: "arm64",
    object_format: "macho",
    minimum_os: "14.0",
  },
  flavors: {
    release: { optimization: "-O2" },
    dev: { optimization: "-O0" },
  },
  executable_section_elimination: EXECUTABLE_SECTION_ELIMINATION,
  runtime_units: [
    ...BASE_RUNTIME_SOURCES.map((source) => ({ source, predicate: true })),
    ...optional.map(([source, predicate]) => ({ source, predicate })),
  ].map((unit) => ({ ...unit, variants: variantsFor(unit.source) })),
  archives: [
    { id: "quickjs", predicate: "dynamic" },
    { id: "libregexp", predicate: { all: ["regex"], not: ["dynamic"] } },
    { id: "zlib", predicate: "zlibEffective" },
    { id: "mbedtls", predicate: "tlsEffective" },
  ],
  system_libraries: [
    { name: "System", predicate: true },
    { name: "m", predicate: "dynamic" },
  ],
};
