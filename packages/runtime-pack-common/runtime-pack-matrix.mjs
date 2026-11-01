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
  "scr_unwind.c",
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
  "scr_arena.c",
  "scr_itable.c",
  "scr_slots.c",
  "scr_alloc.c",
  // crypto.getCipherInfo's table; it links only into programs that call it.
  "scr_cipher_info.c",
  // Math's transcendental functions as V8 computes them, and on glibc the
  // exact libm functions that let a program link without libm.so.
  "scr_ieee754.c",
  "scr_glibc_math.c",
];

export const OPTIONAL_RUNTIME_SOURCES = [
  // The call-time parameter bind of a generator (fn.generator.bindAtCall).
  ["scr_gen_bind.c", "genBind"],
  ["scr_copying.c", "copying"],
  ["scr_file_handle.c", "fileHandle"],
  // writeFile's `flag` disposition and the fs/promises twins; the copyFile
  // mode form is the SCR_FS_FLAGS build of scr_fs_cp.c.
  ["scr_fs_flags.c", "fsFlags"],
  // string_decoder's checked-dynamic chunk forms, apart from scr_bytes.c's
  // typed twins so a typed program keeps that object byte for byte.
  ["scr_bytes_strdec_dyn.c", "strdecDyn"],
  // BigIntStats member reads (`statSync(p, { bigint: true })` members). The
  // bigstats gate is narrower than bigint, which every bigint value turns on.
  ["scr_stats_bigint.c", "bigstats"],
  ["scr_regex.c", "regex"],
  // path.win32.relative uses the regex unit's Unicode case mapping.
  ["scr_path_win32_relative.c", "regex"],
  ["scr_glob.c", "regex"],
  ["scr_idna.c", "regex"],
  ["scr_assert.c", any("assert", "regex", "symbol")],
  ["scr_inspect.c", "inspect"],
  ["scr_console_native.c", "inspect"],
  // Island libCalls on native values typed by island declarations invoke
  // through the checked-dynamic path (scr_node_island_handle.c).
  ["scr_dyn_invoke.c", any("dynInvoke", "nativeFetch", "nodeIsland")],
  // Array.prototype generic algorithms over array-like receivers
  // (scr_dyn_array_like.c); it calls the invoke unit's dispatch.
  ["scr_dyn_array_like.c", all("arrayLikeDispatch", "dynInvoke")],
  // Number.prototype and Boolean.prototype read as values in JavaScript.
  ["scr_dyn_builtin_prototype.c", all("builtinPrototypeValue", "dynInvoke")],
  // Buffer.prototype methods called on checked-dynamic values.
  ["scr_bytes_dyn.c", all("dynBuffer", "dynInvoke")],
  // Builtin functions read as values in JavaScript dependencies.
  ["scr_builtin_values.c", "builtinValues"],
  // A standard library prototype object read as a value in JavaScript
  // (`Date.prototype`); it calls the invoke unit's interned method table.
  ["scr_dyn_stdlib_prototype.c", all("stdlibPrototypeValue", "dynInvoke")],
  // createRequire's computed require and require.resolve.
  ["scr_require.c", "computedRequire"],
  ["scr_dc.c", "dc"],
  // The dynamic tier's jsval values (two-tier design I3): linked only into
  // programs whose IR has dynamic-tier operations.
  ["scr_js_value.c", "dynTier"],
  ["scr_js_object.c", "dynTier"],
  ["scr_event_target.c", any("eventTarget", "nativeFetch", "abortSignal")],
  [
    "scr_async_dyn.c",
    any("dynAsync", "dynInvoke", "dc", "fileHandle", "nativeFetch", "nodeIsland"),
  ],
  // The crypto global's object extends scr_async_dyn.c's crypto object.
  ["scr_webcrypto_object.c", all("webcrypto", "dynAsync")],
  // The performance timeline emits its buffer warning through scr_async_dyn.c.
  ["scr_perf.c", "dynAsync"],
  // perf_hooks event-loop metrics, only for programs that read them.
  ["scr_perf_loop.c", "perfLoop"],
  // Module namespace objects as checked-dynamic values.
  ["scr_module_namespace.c", "moduleNamespace"],
  // The same namespace as the frozen null-prototype object typed code sees.
  ["scr_module_namespace_dyn.c", "moduleNamespaceDyn"],
  // Primitive wrapper objects.
  ["scr_js_wrapper.c", "primitiveWrapper"],
  // Blob and File box their reads as dyn promises through scr_async_dyn.c.
  ["scr_blob.c", "dynAsync"],
  ["scr_zlib.c", "zlib"],
  ["scr_brotli.c", all("zlib", "brotli")],
  // Intl over ICU (scr_intl.c): the default-locale number/date formats and
  // word segmentation, over the packed ICU archive and its data file.
  // Every engine-free Intl form (the en-US fast paths, default grapheme
  // clusters) keeps its own unit and links none of this.
  ["scr_intl.c", "intl"],
  ["scr_events.c", "events"],
  ["scr_readline.c", "events"],
  ["scr_readline_tty.c", all("events", "regex")],
  ["scr_events_emitter.c", "emitter"],
  // events.once with options registers through the emitter and event-target units.
  ["scr_events_once_signal.c", "eventsOnceSignal"],
  ["scr_mime.c", "mime"],
  // `scriptc build --large-pages`: executable code on transparent huge pages (Linux).
  ["scr_text_pages.c", "largePages"],
  ["scr_webstreams.c", "webStreams"],
  ["scr_dyn_handle_class.c", "webStreams"],
  ["scr_util_timing.c", "utilTiming"],
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
  // Object.isExtensible and Object.isSealed of a value typed dynamically; a
  // unit of its own so scr_json.c keeps its layout for every other program.
  ["scr_dyn_integrity.c", "dynIntegrityQueries"],
  // ChildProcess listener removal (off/removeListener) and signalCode; a
  // unit of its own so scr_child.c's layout stays put for every program.
  ["scr_child_lifecycle.c", "childLifecycle"],
  ["scr_decl_adopt.c", "declAdopt"],
  ["scr_type_origin.c", "typeOrigins"],
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
  ["scr_watch_file.c", "watchFile"],
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
  ["scr_x509.c", "x509"],
  // The TLS socket certificate accessors read scr_tls.c and build with scr_x509.c.
  ["scr_tls_x509.c", all("tlsEffective", "x509")],
  // WebCrypto's AES ciphers run over the cipher feature's mbedTLS archive.
  ["scr_webcrypto_aes.c", all("cipher", "webcrypto")],
  ["scr_abort.c", "abortSignalOnly"],
  ["scr_fetch.c", "nativeFetch"],
  // Node islands: libnode loaded on first use (explicit @scriptc/node calls),
  // over the SCR_NODE_ISLANDS build of scr_async.c.
  ["scr_node_island.c", "nodeIsland"],
  ["scr_node_island_handle.c", "nodeIsland"],
  ["scr_node_island_export.c", "nodeIsland"],
  ["scr_node_island_boot.c", "nodeIsland"],
  ["scr_node_island_gc.c", "nodeIsland"],
  ["scr_stream_from_web.c", all("stream", "nativeFetch")],
];

/** One SCR_JS_OBJECT_MODEL twin of each variant of a unit the JavaScript
 * object model features reach (t262-da §J). Every such feature is inert
 * until its own runtime state exists, so one build carries all of them. */
function withJsObjectModel(variants) {
  for (const { id, when, defines } of variants.slice()) {
    const suffix = id === "default" ? "" : `-${id}`;
    variants.push({
      id: `js-om${suffix}`,
      when: { ...when, jsObjectModel: true },
      defines: [...defines, "SCR_JS_OBJECT_MODEL"],
    });
  }
  return variants;
}

export function variantsFor(source) {
  const variants = [{ id: "default", when: {}, defines: [] }];
  // scr_json.c builds one object per flavor (and workers mode): its paths
  // for Node island handles and handle classes call through tables that
  // scr_node_island_handle.c and scr_dyn_handle_class.c install when a
  // program links them, and its dynamic-tier primitives are always defined.
  // A program with a partial record assertion (record-views.ts) links the
  // build whose view slot answers NULL for a field the viewed record does
  // not declare, so the emitted guard, clone helper and presence test can
  // stop with the program's message instead of reading a bogus slot; every
  // other program keeps the default object.
  if (source === "scr_json.c") {
    variants.push({
      id: "record-view-partial",
      when: { recordViewPartial: true },
      defines: ["SCR_RECORD_VIEW_PARTIAL"],
    });
    // An error thrown by island code answers `constructor` from V8 (NI-4),
    // so `e.constructor === TypeError` holds with the island's TypeError.
    // Pushed before the object model twins below, so a program that has both
    // selects one build that carries both defines. Every other program keeps
    // the default object, byte for byte.
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
    // A program with both a partial record assertion and Node islands links
    // the build that carries both defines; the variant with the most
    // conditions is the one selected.
    variants.push({
      id: "record-view-partial-node-island",
      when: { recordViewPartial: true, nodeIsland: true },
      defines: ["SCR_RECORD_VIEW_PARTIAL", "SCR_NODE_ISLANDS"],
    });
    // The JavaScript object model build (t262-da §J): every runtime feature
    // reached only from JavaScript-source facts — builtin intrinsics, array
    // attributes, BigInt views, handle property tables, buffer views —
    // shares SCR_JS_OBJECT_MODEL instead of adding a variant column of its
    // own. jsObjectModel implies dynTier, so such a program links the
    // dynamic tier's units as well, and each feature's code is inert until
    // its own runtime state exists. #2701 made this unit one
    // build per flavor, so every variant here already carries the dynamic
    // tier's primitives and each one gets its object model twin. Every other
    // program keeps the default object, byte for byte.
    withJsObjectModel(variants);
  }
  // util.inspect and instanceof of Node island handles; Node's report for
  // an uncaught island error.
  if (
    source === "scr_inspect.c" ||
    source === "scr_dyn_builtin_class.c" ||
    source === "scr_exception.c"
  ) {
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
  }
  if (source === "scr_bytes.c") {
    variants.push({
      id: "text-decoder-legacy",
      when: { textDecoderLegacy: true },
      defines: ["SCR_TEXT_DECODER_LEGACY"],
    });
    // The BigInt element kinds and their element accessors are part of the
    // JavaScript object model build (t262-da §J): a BigInt view's program
    // has jsObjectModel, so it selects the object model build beside the
    // TextDecoder legacy one when it has both. Every other program keeps the
    // default object, byte for byte.
    withJsObjectModel(variants);
  }
  // util.inspect prints a BigInt typed array by reading its elements as
  // BigInts, whichever build of the unit the program selects. Its Node island
  // build is not the one these variants name: island output keeps its own
  // object.
  if (source === "scr_inspect.c" || source === "scr_assert.c" || source === "scr_dyn_invoke.c") {
    withJsObjectModel(variants);
  }
  // console.table reads the cells of a row's typed array, so a BigInt view
  // needs the element accessor that answers BigInts. The default object keeps
  // the numeric read, byte for byte.
  if (source === "scr_console_native.c") {
    withJsObjectModel(variants);
  }
  // The integrity queries answer from the handle property table when the
  // program's JavaScript object model build carries it (a program whose
  // JavaScript adds own properties to handles).
  if (source === "scr_dyn_integrity.c") {
    withJsObjectModel(variants);
  }
  // Programs that assign process.emitWarning link the replacement-aware
  // warning paths; every other program keeps the default object.
  if (source === "scr_async_dyn.c") {
    variants.push({
      id: "warning-replace",
      when: { warningReplace: true },
      defines: ["SCR_WARNING_REPLACE"],
    });
    // The process-prepend registries (processExtras) add
    // scr_process_prepend_uncaught_exception, in a build of its own so the
    // default object stays put for every program.
    variants.push({
      id: "process-extras",
      when: { processExtras: true },
      defines: ["SCR_PROCESS_EXTRAS"],
    });
    variants.push({
      id: "warning-replace-process-extras",
      when: { warningReplace: true, processExtras: true },
      defines: ["SCR_WARNING_REPLACE", "SCR_PROCESS_EXTRAS"],
    });
  }
  // copyFileSync's mode argument reuses scr_fs_cp.c's reflink walk, so the
  // entry lives in a build of this unit rather than a unit of its own.
  if (source === "scr_fs_cp.c") {
    variants.push({
      id: "flags",
      when: { fsFlags: true },
      defines: ["SCR_FS_FLAGS"],
    });
  }
  // spawnSync's and the exec/execFile callback form's cwd/input/shell
  // entries (SCR_CHILD_CP_OPTIONS) live in a build of scr_child.c of their
  // own, so a program that never passes those options keeps the default
  // object, byte for byte.
  if (source === "scr_child.c") {
    variants.push({
      id: "cp-options",
      when: { childOptionExt: true },
      defines: ["SCR_CHILD_CP_OPTIONS"],
    });
  }
  // server.off / removeListener: the listener-removal entry, in a build of
  // its own so a program that never removes a listener keeps the default.
  if (source === "scr_net.c") {
    variants.push({
      id: "server-off",
      when: { processExtras: true },
      defines: ["SCR_NET_SERVER_OFF"],
    });
  }
  // Programs with web streams link the promise unit with native promise
  // reactions, the builtin-class unit whose instanceof knows their classes,
  // and the fetch unit that takes their streams as bodies; every other
  // program keeps the default objects.
  if (source === "scr_async.c") {
    variants.push({
      id: "native-reactions",
      when: { webStreams: true },
      defines: ["SCR_NATIVE_REACTIONS"],
    });
    // A program with both web streams and Node islands needs both builds:
    // the island slot carries the hosted loop, and the variant with the
    // most conditions is the one selected.
    variants.push({
      id: "native-reactions-node-island",
      when: { webStreams: true, nodeIsland: true },
      defines: ["SCR_NATIVE_REACTIONS", "SCR_NODE_ISLANDS"],
    });
  }
  if (source === "scr_dyn_builtin_class.c" || source === "scr_fetch.c") {
    variants.push({
      id: "handle-classes",
      when: { webStreams: true },
      defines: ["SCR_HANDLE_CLASSES"],
    });
  }
  // instanceof over both web stream and Node island handles.
  if (source === "scr_dyn_builtin_class.c") {
    variants.push({
      id: "handle-classes-node-island",
      when: { webStreams: true, nodeIsland: true },
      defines: ["SCR_HANDLE_CLASSES", "SCR_NODE_ISLANDS"],
    });
  }
  // stdin setEncoding, string data listeners and stdio 'resize' events.
  if (source === "scr_events.c") {
    variants.push({
      id: "stdio-extended",
      when: { stdioExtended: true },
      defines: ["SCR_STDIO_EXTENDED"],
    });
    // Island listeners for signals and 'exit' join the registries.
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
    variants.push({
      id: "stdio-extended-node-island",
      when: { stdioExtended: true, nodeIsland: true },
      defines: ["SCR_STDIO_EXTENDED", "SCR_NODE_ISLANDS"],
    });
    // processExtras adds the prepend registrations and stdin's raw-mode
    // flag; the combinations above then need their own builds, since the
    // variant with the most conditions is the one selected.
    variants.push({
      id: "process-extras",
      when: { processExtras: true },
      defines: ["SCR_PROCESS_EXTRAS"],
    });
    variants.push({
      id: "process-extras-stdio-extended",
      when: { processExtras: true, stdioExtended: true },
      defines: ["SCR_PROCESS_EXTRAS", "SCR_STDIO_EXTENDED"],
    });
    variants.push({
      id: "process-extras-node-island",
      when: { processExtras: true, nodeIsland: true },
      defines: ["SCR_PROCESS_EXTRAS", "SCR_NODE_ISLANDS"],
    });
    variants.push({
      id: "process-extras-stdio-extended-node-island",
      when: { processExtras: true, stdioExtended: true, nodeIsland: true },
      defines: ["SCR_PROCESS_EXTRAS", "SCR_STDIO_EXTENDED", "SCR_NODE_ISLANDS"],
    });
    // The typed process output write slot (the write method as a value, its
    // replacement, run-time-typed chunks): the shared write body, the
    // dynamic-chunk entry point and Node's anonymous write function. Every
    // other program keeps the default object, byte for byte.
    for (const [id, when, defines] of [
      ["stdio-write-slot", { stdioWriteSlot: true }, ["SCR_STDIO_WRITE_SLOT"]],
      [
        "stdio-extended-write-slot",
        { stdioExtended: true, stdioWriteSlot: true },
        ["SCR_STDIO_EXTENDED", "SCR_STDIO_WRITE_SLOT"],
      ],
      [
        "node-island-write-slot",
        { nodeIsland: true, stdioWriteSlot: true },
        ["SCR_NODE_ISLANDS", "SCR_STDIO_WRITE_SLOT"],
      ],
      [
        "stdio-extended-node-island-write-slot",
        { stdioExtended: true, nodeIsland: true, stdioWriteSlot: true },
        ["SCR_STDIO_EXTENDED", "SCR_NODE_ISLANDS", "SCR_STDIO_WRITE_SLOT"],
      ],
    ])
      variants.push({ id, when, defines });
    // A program with both the process extras and the write slot needs both
    // defines in one build.
    for (const [id, when, defines] of [
      [
        "process-extras-write-slot",
        { processExtras: true, stdioWriteSlot: true },
        ["SCR_PROCESS_EXTRAS", "SCR_STDIO_WRITE_SLOT"],
      ],
      [
        "process-extras-stdio-extended-write-slot",
        { processExtras: true, stdioExtended: true, stdioWriteSlot: true },
        ["SCR_PROCESS_EXTRAS", "SCR_STDIO_EXTENDED", "SCR_STDIO_WRITE_SLOT"],
      ],
      [
        "process-extras-node-island-write-slot",
        { processExtras: true, nodeIsland: true, stdioWriteSlot: true },
        ["SCR_PROCESS_EXTRAS", "SCR_NODE_ISLANDS", "SCR_STDIO_WRITE_SLOT"],
      ],
      [
        "process-extras-stdio-extended-node-island-write-slot",
        { processExtras: true, stdioExtended: true, nodeIsland: true, stdioWriteSlot: true },
        ["SCR_PROCESS_EXTRAS", "SCR_STDIO_EXTENDED", "SCR_NODE_ISLANDS", "SCR_STDIO_WRITE_SLOT"],
      ],
    ])
      variants.push({ id, when, defines });
  }
  // Programs with Node islands link the event loop with the Node island slot;
  // every other program keeps the default object, byte for byte.
  if (source === "scr_async.c") {
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
  }
  // Error-taking write completion callbacks: the stream unit publishes the
  // error each callback receives; every other program keeps the default
  // object, byte for byte.
  if (source === "scr_stream.c") {
    variants.push({
      id: "write-errors",
      when: { streamWriteErrors: true },
      defines: ["SCR_STREAM_WRITE_ERRORS"],
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
    { id: "brotli", predicate: all("zlib", "brotli") },
    { id: "icu", predicate: "intl" },
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
