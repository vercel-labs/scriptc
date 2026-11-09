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
  // The receiver a generator function's body reads (dyn.generatorThis).
  ["scr_gen_receiver.c", "genReceiver"],
  // The kept-source read a record width copy emits; a unit of its own so a
  // program that only casts records keeps scr_json.o byte-identical.
  ["scr_record_source_get.c", "recordSourceGet"],
  ["scr_copying.c", "copying"],
  ["scr_file_handle.c", "fileHandle"],
  // writeFile's `flag` disposition and the fs/promises twins; the copyFile
  // mode form is the SCR_FS_FLAGS build of scr_fs_cp.c.
  ["scr_fs_flags.c", "fsFlags"],
  // existsSync over a path value that may not be a string (the DEP0187
  // fallback), apart from scr_lib.c's typed form.
  ["scr_fs_exists_dyn.c", "fsExistsValue"],
  // node:module's compile cache family (enableCompileCache and its
  // neighbours), linked only by a program that names one of them.
  ["scr_module_cache.c", "moduleCompileCache"],
  // The BYTE-data spellings of the option write and fs.promises.writeFile.
  ["scr_fs_bytes_write.c", "fsBytesWrites"],
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
  // The worker unit's SHARE_ENV symbol reaches the symbol unit
  // (scr_worker_events.c), which assembles symbol equality messages here.
  ["scr_assert.c", any("assert", "regex", "symbol", "workers")],
  ["scr_inspect.c", "inspect"],
  ["scr_console_native.c", "inspect"],
  // Island libCalls on native values typed by island declarations invoke
  // through the checked-dynamic path (scr_node_island_handle.c).
  ["scr_dyn_invoke.c", any("dynInvoke", "nativeFetch", "nodeIsland")],
  // Array.prototype generic algorithms over array-like receivers
  // (scr_dyn_array_like.c); it calls the invoke unit's dispatch.
  ["scr_dyn_array_like.c", all("arrayLikeDispatch", "dynInvoke")],
  // A builtin prototype method read as a value in JavaScript (String trim,
  // RegExp exec/test/toString).
  ["scr_dyn_builtin_methods.c", all("builtinMethodValue", "dynInvoke")],
  // Buffer.prototype methods called on checked-dynamic values.
  ["scr_bytes_dyn.c", all("dynBuffer", "dynInvoke")],
  // Builtin functions read as values in JavaScript dependencies.
  ["scr_builtin_values.c", "builtinValues"],
  // An untyped path of a synchronous fs function in a JavaScript source; a
  // unit of its own so no other executable changes.
  ["scr_fs_path_value.c", "fsPathValue"],
  // A standard library prototype object read as a value in JavaScript
  // (`Date.prototype`); it calls the invoke unit's interned method table.
  ["scr_dyn_stdlib_prototype.c", all("stdlibPrototypeValue", "dynInvoke")],
  // DataView.prototype as a value in JavaScript (`DataView.prototype`,
  // its getter/setter family, its see-through accessors and its
  // [[@@toStringTag]]); it builds that object on the dynamic object model.
  ["scr_data_view_proto.c", all("dataViewPrototypeValue", "dynInvoke")],
  // createRequire's computed require and require.resolve.
  ["scr_require.c", "computedRequire"],
  ["scr_dc.c", "dc"],
  // The dynamic tier's jsval values (two-tier design I3): linked only into
  // programs whose IR has dynamic-tier operations.
  ["scr_js_value.c", "dynTier"],
  ["scr_js_object.c", "dynTier"],
  // Mutable ArrayBuffers (t262-dc C1/C2): the views registry that recomputes
  // every view's length when a buffer resizes, grows or detaches, and the
  // operations themselves. A JavaScript source with the `mutableBuffers`
  // fact arms it at the top of %main (arrayBuffer.armMutable); every other
  // program keeps the base units' hooks NULL and links no registry.
  ["scr_js_buffers.c", "mutableBuffers"],
  ["scr_event_target.c", any("eventTarget", "nativeFetch", "abortSignal")],
  [
    "scr_async_dyn.c",
    any("dynAsync", "dynInvoke", "dc", "fileHandle", "nativeFetch", "nodeIsland", "nodeTest"),
  ],
  // Promise statics with a foreign constructor (Promise.all.call(C, ...)):
  // the specification's algorithms over the checked-dynamic tier. Its
  // feature also selects dynInvoke and dynAsync, whose units it calls.
  ["scr_js_promise_generic.c", "promiseGeneric"],
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
  // %Iterator% and %Iterator.prototype% as values.
  ["scr_js_iterator.c", "iteratorProto"],
  // Blob and File box their reads as dyn promises through scr_async_dyn.c.
  ["scr_blob.c", "dynAsync"],
  ["scr_zlib.c", "zlib"],
  ["scr_brotli.c", all("zlib", "brotli")],
  ["scr_zstd.c", all("zlib", "zstd")],
  // Intl over ICU (scr_intl.c): the default-locale number/date formats and
  // word segmentation, over the packed ICU archive and its data file.
  // Every engine-free Intl form (the en-US fast paths, default grapheme
  // clusters) keeps its own unit and links none of this.
  ["scr_intl.c", "intl"],
  ["scr_events.c", "events"],
  // getColorDepth and hasColors of the process stream object: a program
  // that holds a process stream as a value and names one of them. It is
  // called by the SCR_TTY_COLORS build of scr_events.c.
  ["scr_tty_colors.c", all("events", "ttyColors")],
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
  // Worker programs link the symbol unit even without symbols of their own:
  // the Worker env option compares against worker_threads.SHARE_ENV.
  ["scr_symbol.c", any("symbol", "workers")],
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
  // Node's pipe lifecycle, installed into the stream unit for programs
  // that pipe, unpipe or build a pipeline.
  ["scr_stream_pipe_events.c", all("stream", "streamPipeEvents")],
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
  // Reflect.getPrototypeOf's primitive-target check; a unit of its own so
  // scr_json.c keeps its layout for every program that never reflects.
  ["scr_dyn_reflect_proto.c", "reflectProtoTarget"],
  // `delete` of a key a record's type does not declare, removed from the
  // record's kept source; a unit of its own so scr_json.c keeps its layout
  // for every other program.
  ["scr_record_source_delete.c", "recordSourceDelete"],
  // Record views of types whose values may also be frozen; a unit of its own
  // so scr_json.c keeps its layout for every program without one.
  ["scr_record_view_frozen.c", "recordViewFrozen"],
  // ChildProcess listener removal (off/removeListener) and signalCode; a
  // unit of its own so scr_child.c's layout stays put for every program.
  ["scr_child_lifecycle.c", "childLifecycle"],
  // The spawnSync capture Buffers; a unit of its own for the same reason.
  ["scr_child_capture.c", "spawnCaptureBytes"],
  // process.features as a value: the stable flags object.
  ["scr_process_features.c", "processFeatures"],
  ["scr_decl_adopt.c", "declAdopt"],
  ["scr_type_origin.c", "typeOrigins"],
  // The report of failed checked conversions; dev executables link it.
  ["scr_conversion_trace.c", "conversionTrace"],
  // for await over checked-dynamic values.
  ["scr_dyn_for_await.c", "dynForAwait"],
  // Set.prototype method values, the ES2025 Set compositions and
  // Object.getPrototypeOf of a Set.
  ["scr_dyn_collections.c", "dynCollections"],
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
  // One process.stdout.write for the program and its islands: a program that
  // holds a process output stream as a value can replace its write method,
  // and its islands then read and write the same slot. It is called by the
  // SCR_NODE_ISLAND_STDIO build of scr_node_island.c.
  ["scr_node_island_stdio.c", all("nodeIsland", "stdioObject")],
  // A native AbortSignal's twin in an island: programs with islands and
  // native signals (the signal unit or the fetch unit).
  ["scr_node_island_abort.c", { all: ["nodeIsland"], any: ["abortSignal", "nativeFetch"] }],
  ["scr_node_island_events.c", "nodeIsland"],
  // A child process an island made, in a native ChildProcess slot: programs
  // with both islands and child_process. An object on the link line leaves
  // its file symbol in the executable, so no other program gets it.
  ["scr_node_island_child.c", "islandChild"],
  ["scr_stream_from_web.c", all("stream", "nativeFetch")],
  // The dynamic global object's answer for the Node globals the native runtime
  // does not implement (host-globals.ts): the compiler hands over its derived
  // name table, and scr_node_builtin.c's SCR_GLOBAL_HOST_ABSENT build throws
  // instead of answering undefined.
  ["scr_global_host_absent.c", "hostAbsentGlobals"],
  // The stderr report of a deferred diagnostic that fires: only a program
  // that contains one links it, so no other executable changes.
  ["scr_deferred_fence.c", "deferredFence"],
  // `fn.constructor = value` on a value the checker types as a function: the
  // write into the function's own property table (lower-stmts.ts,
  // lowerFunctionConstructorWrite).
  ["scr_dyn_fn_own.c", "functionOwnWrite"],
];

/** One more build column for a unit: a twin, with `define`, of every build
 * the unit has so far, selected by `feature`. A program links one build per
 * unit, so a unit whose builds are keyed on several features needs a build
 * for every combination of them; listing a column's builds by hand names
 * only the columns its author knew, and a program with a combination nobody
 * listed would link a build without one of its defines. Doubling what is
 * there keeps every combination, whichever order the columns were added. */
function withBuildColumn(variants, id, feature, define) {
  for (const { id: other, when, defines } of variants.slice()) {
    variants.push({
      id: other === "default" ? id : `${id}-${other}`,
      when: { ...when, [feature]: true },
      defines: [...defines, define],
    });
  }
  return variants;
}

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
  // program links them, its dynamic-tier primitives are always defined, and
  // its view slot answers NULL for a field the viewed record does not
  // declare (a partial record assertion, record-views.ts), so the emitted
  // guard, clone helper and presence test stop with the program's message.
  // A full view holds an offset for every target field, so the NULL case is
  // unreachable in a program without a partial assertion.
  if (source === "scr_json.c") {
    // A program that writes, defines or deletes one of a function's
    // inherited member names (`fn.call = f`, `Object.defineProperty(fn,
    // "bind", …)`, `delete fn.apply`) keeps the own data property JS
    // creates: scr_json.c's member write/define/delete and own-valueOf
    // paths answer it, and scr_dyn_invoke.c's own call/apply/bind dispatch
    // reads it first. The column is a twin of every build above, so a
    // program with it and any of their features links one build that
    // carries each define; the object model twins below double it in turn.
    // Every other program keeps the default object, byte for byte.
    withBuildColumn(variants, "fn-member-props", "fnMemberProps", "SCR_FN_MEMBER_PROPS");
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
  // util.inspect and instanceof of Node island handles, Node's report for
  // an uncaught island error and an island error's constructor need no
  // build of their own: scr_inspect.c, scr_dyn_builtin_class.c,
  // scr_exception.c and scr_json.c reach the island units through the
  // table scr_node_island_handle.c installs (ScrNiDynOps), which is NULL in
  // a program without them.
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
  // The mutable-buffers registry (t262-dc C1/C2) is part of the JavaScript
  // object model build: its tables and the ScrJsBufferOps contract it fills
  // exist only there (SCR_JS_OBJECT_MODEL), so the unit selects that build
  // and its default object compiles empty. A program with the fact links
  // the unit at all (OPTIONAL_RUNTIME_SOURCES).
  if (source === "scr_js_buffers.c") withJsObjectModel(variants);
  // A dynamic store to the `__proto__` member is Object.prototype's setter,
  // never a field the receiver's shape grows (scr_json.c answers it), so the
  // shape store probe declines it. Only the object model build models that
  // accessor: every other program keeps the default object, byte for byte.
  if (source === "scr_js_object.c") withJsObjectModel(variants);
  // util.inspect prints a BigInt typed array by reading its elements as
  // BigInts, whichever build of the unit the program selects.
  // A method call on an island promise reaches the island object for the
  // methods an island Promise subclass adds (a request promise's
  // `withResponse()`): the Node island build of the invoke unit asks it.
  // Pushed first, so each build gets its object model twin.
  if (source === "scr_dyn_invoke.c") {
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
  }
  // A function's own call/apply/bind shadows the inherited member: the
  // FUNC dispatch of a method call reads the closure's table first, which
  // only the fnMemberProps programs can populate (scr_json.c's write path,
  // the same variant). The column is a twin of the builds above, so a
  // program with it and a Node island links one build that carries both
  // defines. Every other program keeps the default object, byte for byte.
  if (source === "scr_dyn_invoke.c") {
    withBuildColumn(variants, "fn-member-props", "fnMemberProps", "SCR_FN_MEMBER_PROPS");
  }
  if (source === "scr_inspect.c" || source === "scr_assert.c" || source === "scr_dyn_invoke.c") {
    withJsObjectModel(variants);
  }
  // console.table reads the cells of a row's typed array, so a BigInt view
  // needs the element accessor that answers BigInts. The default object keeps
  // the numeric read, byte for byte.
  if (source === "scr_console_native.c") {
    withJsObjectModel(variants);
  }
  // DataView.prototype's byteLength and byteOffset accessors read through
  // the buffer registry in the object model build, where a view over a
  // resized or detached buffer throws, and the array-like algorithms read an
  // array's length, which that build keeps apart from its dense prefix
  // (scr_dyn.h's scr_dyn_arr_length). Both units test the define, so both
  // need its build: without one a program with the object model linked the
  // arm written for programs without it.
  if (source === "scr_data_view_proto.c" || source === "scr_dyn_array_like.c") {
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
    // Programs with Node islands get a build of their own. An island object
    // with a `then` method is a thenable to every promise resolution
    // (Promise.resolve, a combinator's entry, an async function's return):
    // the Node island build reads `then` in V8. It also moves the process
    // event listeners onto Node's `process` once Node is loaded
    // (scr_node_island_events.c). The selector takes the variant with the
    // most conditions, so each build above gets its island twin; every other
    // program keeps its object, byte for byte.
    for (const { id, when, defines } of variants.slice()) {
      variants.push({
        id: id === "default" ? "node-island" : `${id}-node-island`,
        when: { ...when, nodeIsland: true },
        defines: [...defines, "SCR_NODE_ISLANDS"],
      });
    }
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
  // server.off / removeListener and server.listeners: the event-registry
  // query entries, in builds of their own so a program that never removes
  // or reads a listener keeps the default objects.
  if (source === "scr_net.c") {
    variants.push({
      id: "server-off",
      when: { processExtras: true },
      defines: ["SCR_NET_SERVER_OFF"],
    });
  }
  if (source === "scr_http.c") {
    variants.push({
      id: "server-meta",
      when: { processExtras: true },
      defines: ["SCR_HTTP_SERVER_META"],
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
  // A Blob or File request body sends the blob's bytes and type, as Node
  // does; programs that build no Blob or File keep the default fetch unit
  // byte for byte, and the combination with web streams has its own build.
  if (source === "scr_fetch.c") {
    variants.push({
      id: "web-bodies",
      when: { webBodies: true },
      defines: ["SCR_WEB_BODIES"],
    });
    variants.push({
      id: "handle-classes-web-bodies",
      when: { webStreams: true, webBodies: true },
      defines: ["SCR_HANDLE_CLASSES", "SCR_WEB_BODIES"],
    });
  }
  // Programs with Node islands link the event loop with the Node island slot;
  // every other program keeps the default object, byte for byte.
  if (source === "scr_async.c") {
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
    // A checked-dynamic promise whose executor takes a reject parameter
    // builds its reject closure with scr_make_reject_dyn, the reason being
    // the program's own value; every other program keeps the default
    // object, byte for byte. The selector takes the variant with the most
    // conditions, so each build above needs its counterpart.
    for (const [id, when, defines] of [
      ["promise-reject-dyn", { promiseRejectDyn: true }, ["SCR_PROMISE_REJECT_DYN"]],
      [
        "native-reactions-promise-reject-dyn",
        { webStreams: true, promiseRejectDyn: true },
        ["SCR_NATIVE_REACTIONS", "SCR_PROMISE_REJECT_DYN"],
      ],
      [
        "node-island-promise-reject-dyn",
        { nodeIsland: true, promiseRejectDyn: true },
        ["SCR_NODE_ISLANDS", "SCR_PROMISE_REJECT_DYN"],
      ],
      [
        "native-reactions-node-island-promise-reject-dyn",
        { webStreams: true, nodeIsland: true, promiseRejectDyn: true },
        ["SCR_NATIVE_REACTIONS", "SCR_NODE_ISLANDS", "SCR_PROMISE_REJECT_DYN"],
      ],
    ])
      variants.push({ id, when, defines });
  }
  // A program that names getColorDepth or hasColors of a process stream it
  // holds as a value: the stream object asks scr_tty_colors.c for the two
  // methods on a terminal. Every other program keeps the default object,
  // byte for byte.
  if (source === "scr_events.c") {
    variants.push({
      id: "tty-colors",
      when: { ttyColors: true },
      defines: ["SCR_TTY_COLORS"],
    });
  }
  // A program with islands that holds a process output stream as a value:
  // the bootstrap carries the accessor that joins the island's
  // process.stdout.write to the program's write slot, and the start of Node
  // calls scr_node_island_stdio.c to install it. Every other program with
  // islands keeps the default object, byte for byte.
  if (source === "scr_node_island.c") {
    variants.push({
      id: "stdio",
      when: { stdioObject: true },
      defines: ["SCR_NODE_ISLAND_STDIO"],
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
  // fs.ReadStream / fs.WriteStream options that can hold a `signal`: the
  // fs stream unit applies it, with the event-target unit's abort listener;
  // every other program keeps the default object, byte for byte.
  if (source === "scr_fs_stream.c") {
    variants.push({
      id: "signal",
      when: { fsStreamSignal: true },
      defines: ["SCR_FS_STREAM_SIGNAL"],
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
  // A program that reads the global object through a computed key or asks
  // `… in globalThis` arms the runtime check for the Node globals the native
  // runtime does not implement (scr_global_host_absent.c). Every other
  // program keeps the default object, byte for byte.
  if (source === "scr_node_builtin.c") {
    variants.push({
      id: "host-absent-globals",
      when: { hostAbsentGlobals: true },
      defines: ["SCR_GLOBAL_HOST_ABSENT"],
    });
  }
  // The spawnSync result's `.error` property: the build that keeps the spawn
  // errno and argv on the result and stamps Node's errnoException fields
  // (errno, syscall, path, spawnargs). A program that never reads `.error`
  // keeps the default object and the result container exactly as they were.
  if (source === "scr_child.c") {
    variants.push({
      id: "err-fields",
      when: { childErrorFields: true },
      defines: ["SCR_CHILD_ERR_FIELDS"],
    });
    // A program that passes the extended options AND reads `.error` needs
    // both builds in one object: the extended core answers the result the
    // error fields are stamped from, so a build with the options alone
    // would drop them.
    variants.push({
      id: "cp-options-err-fields",
      when: { childOptionExt: true, childErrorFields: true },
      defines: ["SCR_CHILD_CP_OPTIONS", "SCR_CHILD_ERR_FIELDS"],
    });
    // pause(), resume(), isPaused() and readableFlowing on a child's output
    // stream: the build where the stream handle keeps Node's flowing state
    // (scr_child_flow.h). A program that never calls them keeps the default
    // object. The combinations with the builds above need their own objects,
    // since the variant with the most conditions is the one selected.
    for (const [id, when, defines] of [
      ["stream-flow", { childStreamFlow: true }, ["SCR_CHILD_STREAM_FLOW"]],
      [
        "cp-options-stream-flow",
        { childOptionExt: true, childStreamFlow: true },
        ["SCR_CHILD_CP_OPTIONS", "SCR_CHILD_STREAM_FLOW"],
      ],
      [
        "err-fields-stream-flow",
        { childErrorFields: true, childStreamFlow: true },
        ["SCR_CHILD_ERR_FIELDS", "SCR_CHILD_STREAM_FLOW"],
      ],
      [
        "cp-options-err-fields-stream-flow",
        { childOptionExt: true, childErrorFields: true, childStreamFlow: true },
        ["SCR_CHILD_CP_OPTIONS", "SCR_CHILD_ERR_FIELDS", "SCR_CHILD_STREAM_FLOW"],
      ],
    ])
      variants.push({ id, when, defines });
    // A program with Node islands can hold a child process an island made in
    // a ChildProcess slot (scr_node_island_child.c): in the SCR_NODE_ISLANDS
    // build every entry point hands such a child to the island's object.
    // Every other program keeps the builds above, byte for byte. The selector
    // takes the variant with the most conditions, so each build above has its
    // counterpart.
    for (const { id, when, defines } of variants.slice()) {
      variants.push({
        id: id === "default" ? "node-island" : `${id}-node-island`,
        when: { ...when, nodeIsland: true },
        defines: [...defines, "SCR_NODE_ISLANDS"],
      });
    }
  }
  // The listener removal and signalCode entries of the same children.
  if (source === "scr_child_lifecycle.c") {
    variants.push({
      id: "node-island",
      when: { nodeIsland: true },
      defines: ["SCR_NODE_ISLANDS"],
    });
  }
  // A static executable cannot load NSS modules, so the os unit's passwd
  // fallback (os.homedir() with HOME unset, and os.userInfo()) reads
  // /etc/passwd directly in that build; every dynamically linked build
  // keeps the unchanged getpwuid_r object. staticLink is the link
  // plan's fact (link-plan.ts), not a program fact.
  if (source === "scr_lib.c") {
    variants.push({
      id: "static-passwd",
      when: { staticLink: true },
      defines: ["SCR_STATIC_PASSWD"],
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
    { id: "libregexp", predicate: "regex" },
    { id: "zlib", predicate: "zlibEffective" },
    { id: "brotli", predicate: all("zlib", "brotli") },
    { id: "zstd", predicate: all("zlib", "zstd") },
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
