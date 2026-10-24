import { withWorkerRuntimeVariants } from "./worker-matrix.mjs";
import { withLibraryRuntimeFlavors } from "./library-matrix.mjs";

/**
 * Shared release-runtime pack matrix. Platform package scripts provide the
 * target descriptor, then this module fixes feature reachability and the
 * compile/link flags required by every generated runtime object.
 */
const any = (...features) => ({ any: features });
const all = (...features) => ({ all: features });

/* Every runtime pack matrix uses these lists, so a new runtime source is
 * one line here. Their order is the link order of the units an executable
 * selects: keep a new unit next to the units it references, and treat any
 * reordering as a change to every executable's layout. */
export const BASE_RUNTIME_SOURCES = [
  "scr_context.c",
  "scr_shared.c",
  "scr_number.c",
  "scr_bigint.c",
  "scr_string.c",
  "scr_grapheme.c",
  "scr_array.c",
  "scr_bytes.c",
  "scr_bytes_io.c",
  "scr_fs_cp.c",
  "scr_map.c",
  "scr_closure.c",
  "scr_ffi.c",
  "scr_object.c",
  "scr_union.c",
  "scr_exception.c",
  "scr_error.c",
  "scr_console.c",
  "scr_lib.c",
  "scr_hash.c",
  "scr_path.c",
  "scr_os.c",
  "scr_url.c",
  "scr_url_params.c",
  "scr_json.c",
  "scr_node_builtin.c",
  "scr_async.c",
  "scr_crypto_async.c",
  "scr_child.c",
  "scr_cycle.c",
  "scr_publish.c",
  "scr_region.c",
  "scr_itable.c",
  "scr_slots.c",
  "scr_alloc.c",
  // crypto.getCipherInfo's table; it links only into programs that call it.
  "scr_cipher_info.c",
];

export const OPTIONAL_RUNTIME_SOURCES = [
  ["scr_copying.c", "copying"],
  ["scr_file_handle.c", "fileHandle"],
  ["scr_regex.c", "regex"],
  ["scr_glob.c", "regex"],
  ["scr_idna.c", "regex"],
  ["scr_assert.c", any("assert", "regex", "symbol")],
  ["scr_inspect.c", "inspect"],
  ["scr_console_native.c", "inspect"],
  ["scr_dyn_invoke.c", any("dynInvoke", "nativeFetch")],
  // Inherited Object.prototype members on dynamic values (base units only);
  // the dyn-invoke unit reads them too.
  ["scr_dyn_inherited.c", any("dynInherited", "dynInvoke", "nativeFetch")],
  // `new` through those constructors builds dates and collections.
  ["scr_dyn_global_construct.c", any("dynGlobalConstruct", "dynInvoke", "nativeFetch")],
  // Buffer.prototype methods called on checked-dynamic values.
  ["scr_bytes_dyn.c", all("dynBuffer", "dynInvoke")],
  // Builtin functions read as values in JavaScript dependencies.
  ["scr_builtin_values.c", "builtinValues"],
  ["scr_dc.c", "dc"],
  // The dynamic tier's jsval values (two-tier design I3): linked only into
  // programs whose IR has dynamic-tier operations.
  ["scr_js_value.c", "dynTier"],
  ["scr_js_object.c", "dynTier"],
  ["scr_event_target.c", any("eventTarget", "nativeFetch")],
  ["scr_async_dyn.c", any("dynAsync", "dynInvoke", "dc", "fileHandle", "nativeFetch")],
  // The crypto global's object extends scr_async_dyn.c's crypto object.
  ["scr_webcrypto_object.c", all("webcrypto", "dynAsync")],
  // The performance timeline emits its buffer warning through scr_async_dyn.c.
  ["scr_perf.c", "dynAsync"],
  // perf_hooks event-loop metrics, only for programs that read them.
  ["scr_perf_loop.c", "perfLoop"],
  // Blob and File box their reads as dyn promises through scr_async_dyn.c.
  ["scr_blob.c", "dynAsync"],
  ["scr_zlib.c", "zlib"],
  ["scr_events.c", "events"],
  ["scr_readline.c", "events"],
  ["scr_readline_tty.c", all("events", "regex")],
  ["scr_events_emitter.c", "emitter"],
  // events.once with options registers through the emitter and event-target units.
  ["scr_events_once_signal.c", "eventsOnceSignal"],
  ["scr_dyn_handle.c", any("emitter", "netEffective")],
  ["scr_symbol.c", "symbol"],
  ["scr_bigint_assert.c", all("assert", "bigint")],
  ["scr_qs.c", "qs"],
  // The legacy url unit lowercases and normalizes through the regex unit
  // and warns through the dyn-async one.
  ["scr_url_legacy.c", all("regex", "qs", "dynAsync")],
  ["scr_util.c", "parseArgs"],
  // Utility objects must only reference runtime families selected with them.
  ["scr_util_compare.c", all("parseArgs", "symbol")],
  ["scr_util_style.c", all("parseArgs", "inspect", "dynAsync")],
  ["scr_util_callable.c", all("parseArgs", "inspect", "dynAsync", "dynInvoke", "regex")],
  // util.promisify over an untyped function creates dyn promises and calls.
  ["scr_util_promisify.c", all("utilPromisify", "dynAsync", "dynInvoke")],
  // Untyped EventEmitter and stream constructor values call listeners
  // through the dyn-invoke unit, inspect unhandled 'error' payloads and
  // create EventEmitter's private symbols.
  ["scr_dyn_builtin_class.c", all("dynBuiltinClass", "inspect", "dynInvoke", "symbol", "emitter")],
  // Their stream half also references the stream unit.
  [
    "scr_dyn_builtin_stream.c",
    all(
      "dynBuiltinStream",
      "dynBuiltinClass",
      "stream",
      "inspect",
      "dynInvoke",
      "symbol",
      "emitter",
    ),
  ],
  ["scr_stream.c", "stream"],
  // The zlib stream classes reference both the zlib engine and the stream unit.
  ["scr_zlib_stream.c", all("zlib", "stream")],
  // The Readable operators await through the dyn-async unit.
  ["scr_stream_ops.c", all("stream", "dynAsync")],
  // Checked-dynamic stream slots call JavaScript members through the dyn-invoke unit.
  ["scr_stream_dyn.c", "streamDyn"],
  // Own properties JavaScript adds to children.
  ["scr_dyn_handle_props.c", "handleProps"],
  ["scr_decl_adopt.c", "declAdopt"],
  // for await over checked-dynamic values.
  ["scr_dyn_for_await.c", "dynForAwait"],
  ["scr_dyn_for_await_stream.c", all("dynForAwait", "stream", "dynAsync")],
  // fs.ReadStream / fs.WriteStream reference only the stream unit and base units.
  ["scr_fs_stream.c", "stream"],
  // FileHandle streams reference both the stream unit and FileHandle.
  ["scr_fs_stream_fh.c", all("stream", "fileHandle")],
  ["scr_loop_kqueue.c", any("netEffective", "dgram")],
  ["scr_loop_epoll.c", any("netEffective", "dgram")],
  ["scr_loop_wsapoll.c", any("netEffective", "dgram")],
  ["scr_net.c", "netEffective"],
  ["scr_http.c", "httpEffective"],
  ["scr_http2.c", "http2"],
  ["scr_dgram.c", "dgram"],
  // The dns promise forms run over the dgram unit's callback forms.
  ["scr_dns_promises.c", all("dgram", "dnsPromises")],
  // Sockets as untyped values run over the dgram unit.
  ["scr_dgram_dyn.c", all("dgram", "dgramDyn")],
  // TextEncoder and TextDecoder records boxed as untyped values.
  ["scr_text_codec_dyn.c", "textCodecDyn"],
  ["scr_watch.c", "watch"],
  ["scr_ffi_queue.c", "foreignFfi"],
  ["scr_test.c", "nodeTest"],
  ["scr_tls_ca.c", "tlsCaEffective"],
  ["scr_tls.c", "tlsEffective"],
  ["scr_cipher.c", "cipher"],
  ["scr_ecdh.c", "ecdh"],
  ["scr_dh.c", "dh"],
  ["scr_pki.c", "pki"],
  ["scr_wasm.c", "wasm"],
  ["scr_webcrypto.c", "webcrypto"],
  ["scr_webcrypto_pki.c", all("webcrypto", "pki")],
  ["scr_ed25519.c", all("pki", "ed25519")],
  // WebCrypto's AES ciphers run over the cipher feature's mbedTLS archive.
  ["scr_webcrypto_aes.c", all("cipher", "webcrypto")],
  ["scr_fetch.c", "nativeFetch"],
  ["scr_stream_from_web.c", all("stream", "nativeFetch")],
];

export function variantsFor(source) {
  const variants = [{ id: "default", when: {}, defines: [] }];
  // Programs with dynamic-tier code keep the tier's hidden classes current
  // in checked objects (two-tier design S4); every other program links the
  // ordinary object, byte for byte.
  if (source === "scr_json.c") {
    variants.push({ id: "dyn-tier", when: { dynTier: true }, defines: ["SCR_JS_TIER"] });
  }
  if (source === "scr_bytes.c") {
    variants.push({
      id: "text-decoder-legacy",
      when: { textDecoderLegacy: true },
      defines: ["SCR_TEXT_DECODER_LEGACY"],
    });
  }
  // Programs that assign process.emitWarning link the replacement-aware
  // warning paths; every other program keeps the default object.
  if (source === "scr_async_dyn.c") {
    variants.push({
      id: "warning-replace",
      when: { warningReplace: true },
      defines: ["SCR_WARNING_REPLACE"],
    });
  }
  // stdin setEncoding, string data listeners and stdio 'resize' events.
  if (source === "scr_events.c") {
    variants.push({
      id: "stdio-extended",
      when: { stdioExtended: true },
      defines: ["SCR_STDIO_EXTENDED"],
    });
  }
  if (source === "scr_cycle.c") {
    // The young-in nursery (SCRIPTC_YOUNG_NURSERY=1): the collector with
    // nursery collections; programs built without it link the default.
    variants.push({
      id: "young-nursery",
      when: { youngNursery: true },
      defines: ["SCR_YIN"],
    });
  }
  return variants;
}

export function createRuntimePackMatrix({
  target,
  compileFlags,
  systemLibraries,
  extraRuntimeSources = [],
  omitRuntimeSources = [],
  omitOptionalSources = [],
  omitArchives = [],
  libraryOnly = false,
}) {
  const vendorArchives = [
    { id: "quickjs", predicate: false },
    { id: "libregexp", predicate: "regex" },
    { id: "zlib", predicate: "zlibEffective" },
    { id: "mbedtls", predicate: any("tlsEffective", "cipher", "ecdh", "dh", "pki") },
  ];
  const matrix = withLibraryRuntimeFlavors(
    withWorkerRuntimeVariants({
      schema: "scriptc.runtime-pack-matrix.v1",
      target,
      flavors: { release: { optimization: "-O2" }, dev: { optimization: "-O0" } },
      executable_section_elimination: { compile_flags: compileFlags },
      runtime_units: [
        ...BASE_RUNTIME_SOURCES.filter((source) => !omitRuntimeSources.includes(source)).map(
          (source) => ({ source, predicate: true }),
        ),
        ...extraRuntimeSources.map((source) => ({ source, predicate: true })),
        ...OPTIONAL_RUNTIME_SOURCES.filter(([source]) => !omitOptionalSources.includes(source)).map(
          ([source, predicate]) => ({ source, predicate }),
        ),
      ].map((unit) => ({ ...unit, variants: variantsFor(unit.source) })),
      archives: vendorArchives.filter(({ id }) => !omitArchives.includes(id)),
      system_libraries: systemLibraries,
    }),
  );
  if (libraryOnly) {
    matrix.flavors = Object.fromEntries(
      Object.entries(matrix.flavors).filter(([name]) => name.startsWith("library-")),
    );
    matrix.archives = matrix.archives.filter(({ id }) => id === "libregexp" || id === "zlib");
  }
  return matrix;
}
