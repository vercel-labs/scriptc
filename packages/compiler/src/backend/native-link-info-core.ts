import type { NativeOptimization } from "./optimization.js";
import { join } from "node:path";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import {
  EXTERNAL_OBJECT_ABI_STABILITY,
  RUNTIME_ABI_MARKER,
  RUNTIME_ABI_VERSION,
} from "./runtime-abi.js";
import { executableLinkInputs } from "./link-plan-core.js";
import type {
  RuntimePackArtifact,
  RuntimePackArtifacts,
  RuntimePackManifest,
} from "./runtime-pack-core.js";
import type { NativeTargetSpec } from "./targets.js";

export interface NativeLinkFeatures {
  workers?: boolean;
  /** The young-in nursery (backend/young-nursery.ts): the SCR_YIN
   * variant of the collector unit. Absent when off. */
  youngNursery?: boolean;
  regex: boolean;
  copying: boolean;
  textDecoderLegacy: boolean;
  /** A BigInt typed-array constructor is read as a value: its element kinds
   * live in the JavaScript object model build (t262-da §J), which
   * jsObjectModelFact ORs this fact into. */
  bigintBytes: boolean;
  fileHandle: boolean;
  fetch: boolean;
  eventTarget?: boolean;
  /** The WebAssembly API (scr_wasm.c). Absent when unused, so programs
   * without it keep their link identity. */
  wasm?: boolean;
  /** The program assigns process.emitWarning: links the
   * SCR_WARNING_REPLACE variant of the dyn-async unit. */
  warningReplace?: boolean;
  /** The program creates a checked-dynamic promise whose executor takes a
   * reject parameter: links the SCR_PROMISE_REJECT_DYN variant of
   * scr_async.c. Absent for every other program, so their objects stay
   * identical. */
  promiseRejectDyn?: boolean;
  /** The program uses a runtime feature only a JavaScript source reaches:
   * links the SCR_JS_OBJECT_MODEL build of every unit those features touch
   * (t262-da §J). Absent for every other program, so their objects stay
   * identical. */
  jsObjectModel?: boolean;
  /** A JavaScript source resizes, grows or detaches an ArrayBuffer
   * (frontend/lowering/buffers.ts): compiles scr_js_buffers.c, the views
   * registry those operations maintain. The fact ORs into jsObjectModel
   * (jsObjectModelFact), so it selects no build column of its own. Absent
   * for every other program, so their objects stay identical. */
  mutableBuffers?: boolean;
  /** writeFile's `flag` disposition or copyFile's mode argument:
   * scr_fs_flags.c and the SCR_FS_FLAGS build of scr_fs_cp.c. */
  fsFlags?: boolean;
  /** existsSync over a path value that is not statically a string:
   * scr_fs_exists_dyn.c. */
  fsExistsValue?: boolean;
  /** node:module's compile cache family: scr_module_cache.c. */
  moduleCompileCache?: boolean;
  /** The program writes, defines or deletes a function's inherited member
   * name (`fn.call = f`): links the SCR_FN_MEMBER_PROPS builds of scr_json.c
   * and scr_dyn_invoke.c. Absent for every other program, so their objects
   * stay identical. */
  fnMemberProps?: boolean;
  /** The BYTE-data spellings of the options write and
   * fs.promises.writeFile: scr_fs_bytes_write.c. */
  fsBytesWrites?: boolean;
  /** string_decoder's checked-dynamic chunk forms: scr_bytes_strdec_dyn.c. */
  strdecDyn?: boolean;
  /** process.prependListener, stdin.isRaw or server.off: the
   * SCR_PROCESS_EXTRAS build of scr_async_dyn.c and the
   * SCR_NET_SERVER_OFF build of scr_net.c. */
  processExtras?: boolean;
  /** A write completion callback takes the error argument: links the
   * SCR_STREAM_WRITE_ERRORS build of the stream unit. */
  streamWriteErrors?: boolean;
  /** The program holds a process output stream as a value, so it can
   * replace the stream's write method. With Node islands it links
   * scr_node_island_stdio.c and the SCR_NODE_ISLAND_STDIO build of
   * scr_node_island.c, which join the island's process.stdout.write and
   * process.stderr.write to the program's write slots. */
  stdioObject?: boolean;
  /** The program holds a process stream as a value and names getColorDepth
   * or hasColors: links scr_tty_colors.c and the SCR_TTY_COLORS build of
   * the events unit, whose stream object has the two methods. */
  ttyColors?: boolean;
  /** The program pipes or unpipes a stream: links scr_stream_pipe_events.c,
   * which installs Node's pipe lifecycle into the stream unit. */
  streamPipeEvents?: boolean;
  /** An fs.ReadStream or fs.WriteStream whose options can hold a `signal`:
   * links the SCR_FS_STREAM_SIGNAL build of the fs stream unit, and the
   * event-target unit its abort listener comes from. */
  fsStreamSignal?: boolean;
  /** Calls into Node.js (@scriptc/node): scr_node_island.c and the
   * SCR_NODE_ISLANDS variant of the event loop unit. */
  nodeIsland?: boolean;
  /** Module namespace objects as checked-dynamic values link
   * scr_module_namespace.c; absent (false) otherwise. */
  moduleNamespace?: boolean;
  /** A module namespace boxed for typed code links
   * scr_module_namespace_dyn.c; absent (false) otherwise. */
  moduleNamespaceDyn?: boolean;
  /** Primitive wrapper objects link scr_js_wrapper.c; absent (false)
   * otherwise. */
  primitiveWrapper?: boolean;
  /** The Promise statics through Function.prototype.call with a foreign
   * constructor link scr_js_promise_generic.c; absent (false) otherwise. */
  promiseGeneric?: boolean;
  /** %Iterator% and %Iterator.prototype% as values link
   * scr_js_iterator.c; absent (false) otherwise. */
  iteratorProto?: boolean;
  zlib: boolean;
  /** node:zlib's Brotli forms: scr_brotli.c and the vendored brotli archive. */
  brotli?: boolean;
  /** node:zlib's zstd forms: scr_zstd.c and the vendored zstd archive. */
  zstd?: boolean;
  assert: boolean;
  inspect: boolean;
  dynInvoke: boolean;
  dc: boolean;
  dynAsync: boolean;
  /** Dynamic-tier jsval operations: the scr_js_* units. Absent (not false)
   * for programs without them, so their link features stay unchanged. */
  dynTier?: boolean;
  /** Checked-dynamic stream slots: the scr_stream_dyn.c unit. Absent (not
   * false) for programs without them. */
  streamDyn?: boolean;
  /** Own properties JavaScript adds to children: scr_dyn_handle_props.c.
   * Absent (false) for programs without them. */
  handleProps?: boolean;
  /** ChildProcess listener removal and signalCode link scr_child_lifecycle.c;
   * absent (false) otherwise. */
  childLifecycle?: boolean;
  /** process.features read as a value links scr_process_features.c (the
   * stable flags object); absent (false) otherwise. */
  processFeatures?: boolean;
  /** A program with both Node islands and child_process links
   * scr_node_island_child.c (a child process an island made, in a native
   * ChildProcess slot); absent (false) otherwise. */
  islandChild?: boolean;
  /** The spawnSync and exec/execFile-callback `cwd`/`input`/`shell`
   * entries: selects the SCR_CHILD_CP_OPTIONS build of scr_child.c.
   * Absent (false) otherwise. */
  childOptionExt?: boolean;
  /** A spawnSync capture read as a Buffer links scr_child_capture.c;
   * absent (false) otherwise. */
  spawnCaptureBytes?: boolean;
  /** The spawnSync result's `.error` errnoException fields (errno, syscall,
   * path, spawnargs) select scr_child.c's SCR_CHILD_ERR_FIELDS build; absent
   * (false) otherwise. */
  childErrorFields?: boolean;
  /** pause(), resume(), isPaused() or readableFlowing on a child's output
   * stream selects scr_child.c's SCR_CHILD_STREAM_FLOW build; absent (false)
   * otherwise. */
  childStreamFlow?: boolean;
  declAdopt?: boolean;
  typeOrigins?: boolean;
  /** The executable carries debug sources (`--optimization dev` without
   * `--strip`): its checked conversions report their failures
   * (scr_conversion_trace.c). Absent (false) for every other build. */
  conversionTrace?: boolean;
  /** for await over checked-dynamic values: scr_dyn_for_await.c. Absent
   * (false) for programs without it. */
  dynForAwait?: boolean;
  /** The keyed collections' prototype objects and member values, their
   * constructors' adder lookup, Map.prototype's dynamic forEach and the
   * ES2025 Set compositions: scr_dyn_collections.c. Absent (false)
   * otherwise. */
  dynCollections?: boolean;
  /** Object.isExtensible and Object.isSealed of a value typed dynamically:
   * scr_dyn_integrity.c. Absent (false) for programs without it. */
  dynIntegrityQueries?: boolean;
  /** Reflect.getPrototypeOf's primitive-target check compiles
   * scr_dyn_reflect_proto.c; absent (false) otherwise. */
  reflectProtoTarget?: boolean;
  /** `delete` of a key a record's type does not declare:
   * scr_record_source_delete.c. Absent (false) for programs without one. */
  recordSourceDelete?: boolean;
  /** A partial record assertion to a type whose values may be frozen
   * compiles scr_record_view_frozen.c; absent (false) otherwise. */
  recordViewFrozen?: boolean;
  /** A generator that binds its parameters at the call: scr_gen_bind.c.
   * Absent (false) for programs without one. */
  genBind?: boolean;
  /** A generator function that reads `this`: scr_gen_receiver.c. Absent
   * (false) for programs without one. */
  genReceiver?: boolean;
  /** A record-to-record conversion reads a field the source type does not
   * declare through the kept-source table (frontend/lowering/
   * record-sources.ts): scr_record_source_get.c. Absent (false) for every
   * program, including one that only casts records, so a cast alone keeps
   * its runtime objects byte for byte. */
  recordSourceGet?: boolean;
  /** events.once with options: scr_events_once_signal.c. Absent (not
   * false) for programs without it. */
  eventsOnceSignal?: boolean;
  /** util.MIMEType and util.MIMEParams: scr_mime.c. */
  mime?: boolean;
  /** `--large-pages`: scr_text_pages.c, which moves the executable's code
   * onto transparent huge pages at startup. Absent (false) without it. */
  largePages?: boolean;
  /** Web streams in checked-dynamic code: scr_webstreams.c and
   * scr_dyn_handle_class.c. */
  webStreams?: boolean;
  /** A program that builds a Blob or File: selects scr_fetch.c's
   * SCR_WEB_BODIES build, which sends the blob's bytes and its type as
   * Content-Type, as Node does. Absent (false) for programs that build
   * neither, which keep the default fetch unit byte for byte. */
  webBodies?: boolean;
  /** AbortController and AbortSignal: scr_abort.c, unless the program
   * links the fetch unit, which has them. */
  abortSignal?: boolean;
  /** util.debounce and util.throttle: scr_util_timing.c. */
  utilTiming?: boolean;
  /** Buffer.prototype methods called on checked-dynamic values link
   * scr_bytes_dyn.c; absent (false) for programs without them. */
  dynBuffer?: boolean;
  /** An untyped path of a synchronous fs function in a JavaScript source
   * (dyn.validateFsPath) links scr_fs_path_value.c; absent (false) otherwise. */
  fsPathValue?: boolean;
  /** Builtin functions read as values (Buffer.byteLength, Buffer.alloc,
   * fs.realpathSync) link scr_builtin_values.c; absent (false) otherwise. */
  builtinValues?: boolean;
  /** A standard library prototype object read as a value in a JavaScript
   * source (`Date.prototype`) links scr_dyn_stdlib_prototype.c; absent
   * (false) otherwise, so other programs keep their exact link line. */
  stdlibPrototypeValue?: boolean;
  /** DataView.prototype read as a value in a JavaScript source
   * (`DataView.prototype`) links scr_data_view_proto.c; absent (false)
   * otherwise, so other programs keep their exact link line. */
  dataViewPrototypeValue?: boolean;
  /** A computed read of the global object, or `… in globalThis`, links
   * scr_global_host_absent.c and the SCR_GLOBAL_HOST_ABSENT build of
   * scr_node_builtin.c; absent (false) otherwise. */
  hostAbsentGlobals?: boolean;
  /** A runtimeFence that stands for a deferred diagnostic links
   * scr_deferred_fence.c, its stderr reporter; absent (false) otherwise. */
  deferredFence?: boolean;
  /** `fn.constructor = value` on a function value links scr_dyn_fn_own.c;
   * absent (false) otherwise. */
  functionOwnWrite?: boolean;
  /** createRequire's computed require and require.resolve link
   * scr_require.c; absent (false) otherwise. */
  computedRequire?: boolean;
  events: boolean;
  emitter: boolean;
  symbol: boolean;
  bigint: boolean;
  /** BigIntStats member reads (`statSync(p, { bigint: true })` members):
   * scr_stats_bigint.c. Absent (false) otherwise, so BigInt programs that
   * never read a stat member keep their link line and size. */
  bigstats?: boolean;
  searchParams: boolean;
  qs: boolean;
  utilPromisify: boolean;
  dynBuiltinClass: boolean;
  dynBuiltinStream: boolean;
  /** An Array.prototype method runs over an array-like receiver:
   * scr_dyn_array_like.c. Absent (false) otherwise, so programs that never
   * call one over an array-like keep their exact link line. */
  arrayLikeDispatch?: boolean;
  /** A String.prototype trim method read as a value:
   * scr_dyn_builtin_methods.c. Absent (false) otherwise. */
  builtinMethodValue?: boolean;
  parseArgs: boolean;
  stream: boolean;
  net: boolean;
  http: boolean;
  http2: boolean;
  dgram: boolean;
  /** node:dns/promises: scr_dns_promises.c. */
  dnsPromises: boolean;
  /** dgram sockets as untyped values: scr_dgram_dyn.c. */
  dgramDyn: boolean;
  /** TextEncoder and TextDecoder records as untyped values:
   * scr_text_codec_dyn.c. */
  textCodecDyn: boolean;
  watch: boolean;
  /** fs.watchFile/fs.unwatchFile: scr_watch_file.c. */
  watchFile: boolean;
  foreignFfi: boolean;
  nodeTest: boolean;
  tls: boolean;
  /** crypto.createCipheriv/createDecipheriv and WebCrypto's encrypt and
   * decrypt: scr_cipher.c plus the mbedTLS archive (and, with webcrypto,
   * scr_webcrypto_aes.c). */
  cipher: boolean;
  /** crypto.createECDH and ECDH.convertKey: scr_ecdh.c plus the mbedTLS
   * archive. */
  ecdh: boolean;
  /** crypto.createDiffieHellman, getDiffieHellman and
   * createDiffieHellmanGroup: scr_dh.c plus the mbedTLS archive. */
  dh: boolean;
  /** Asymmetric KeyObjects, crypto.sign/verify and Sign/Verify: scr_pki.c
   * plus the mbedTLS archive. */
  pki: boolean;
  /** Ed25519 keys and signatures with pki: scr_ed25519.c (the vendored
   * libsodium Ed25519). */
  ed25519: boolean;
  /** X509Certificate fields beyond the validity window and fingerprint:
   * scr_x509.c. */
  x509: boolean;
  /** perf_hooks event-loop metrics: scr_perf_loop.c. */
  perfLoop: boolean;
  /** Intl over ICU (scr_intl.c plus the ICU archive and its data
   * file): the `icu.*` libCalls of the first slice. Absent (false) for
   * programs without them, so their link features stay unchanged. */
  intl?: boolean;
  tlsCa: boolean;
  /** crypto.subtle importKey/sign/verify/digest and CryptoKey values:
   * scr_webcrypto.c. */
  webcrypto: boolean;
  /** The link is a static executable (`--static`): selects the runtime
   * pack's /etc/passwd build of the os unit, which needs no NSS and so
   * passes targets.ts's staticLinkRefusal. A property of the link, set by
   * the link plan, never a fact the program analysis answers; absent for
   * every dynamically linked build, whose objects stay unchanged. */
  staticLink?: boolean;
}

/** The keys a NativeLinkFeatures value always spells, on or off: the ones
 * declared without `?`. An optional key is absent when its feature is off,
 * so a program without the feature keeps its link identity, and no list
 * below names it. */
export type RequiredLinkFeatureName = {
  [Name in keyof NativeLinkFeatures]-?: undefined extends NativeLinkFeatures[Name] ? never : Name;
}[keyof NativeLinkFeatures];

/** A compile error that names this type means NO_LINK_FEATURES and
 * NativeLinkFeatures disagree about the required keys: a key declared
 * without `?` is not listed there (add `<key>: false,` at the key's place in
 * the interface's order), or a listed name is not such a key (delete it). */
type EveryRequiredLinkFeatureOff = { readonly [Name in RequiredLinkFeatureName]: false };

/** Every required key, off, in the interface's order. This is the one list
 * of those keys: the cache validators and the warm-cache profiles read it,
 * so a required key is added by declaring it in the interface and adding
 * its line here, and removed by deleting both. An optional key has no line
 * anywhere but the interface. */
const NO_LINK_FEATURES: EveryRequiredLinkFeatureOff = {
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  bigintBytes: false,
  fileHandle: false,
  fetch: false,
  zlib: false,
  assert: false,
  inspect: false,
  dynInvoke: false,
  dc: false,
  dynAsync: false,
  events: false,
  emitter: false,
  symbol: false,
  bigint: false,
  searchParams: false,
  qs: false,
  utilPromisify: false,
  dynBuiltinClass: false,
  dynBuiltinStream: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  dnsPromises: false,
  dgramDyn: false,
  textCodecDyn: false,
  watch: false,
  watchFile: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  cipher: false,
  ecdh: false,
  dh: false,
  pki: false,
  ed25519: false,
  x509: false,
  perfLoop: false,
  tlsCa: false,
  webcrypto: false,
};

const requiredLinkFeatures: RequiredLinkFeatureName[] = [];
for (const name in NO_LINK_FEATURES) requiredLinkFeatures.push(name as RequiredLinkFeatureName);

/** The required keys, in the interface's order. */
export const REQUIRED_LINK_FEATURES: readonly RequiredLinkFeatureName[] = requiredLinkFeatures;

/** The link features of a program that links none of the optional runtime:
 * every required key present and false, no optional key. A caller turns on
 * what it links: `{ ...noLinkFeatures(), fetch: true }`. */
export function noLinkFeatures(): NativeLinkFeatures {
  return { ...NO_LINK_FEATURES };
}

/** A link feature whose runtime units call into another feature's units,
 * with the features that own those units. */
interface LinkFeatureRequirement {
  feature: RequiredLinkFeatureName;
  requires: readonly RequiredLinkFeatureName[];
}

/** The link features that cannot link alone: each one's runtime units call
 * functions of the units its `requires` features select, on a path the
 * program reaches as soon as the feature is on. executableLinkFeatures turns
 * the required features on, so the one list says what a feature needs
 * whichever fact of the program selected it.
 *
 * `http2`: scr_http2.c releases a stream's compatibility request and
 * response through scr_http.c and runs its sockets through scr_net.c. A
 * program that only holds a session or stream type (`ClientHttp2Session` in
 * a signature, with no node:http2 call left) selects the http2 units for the
 * type's reference counting, and reaches those calls.
 *
 * A reference that only a call selecting the other unit reaches needs no
 * line: the link's section collection drops it otherwise. The reference
 * check in tests/harness/runtime-unit-references.test.ts lists those, and
 * fails on a reference that is in neither list. */
export const LINK_FEATURE_REQUIREMENTS: readonly LinkFeatureRequirement[] = [
  { feature: "http2", requires: ["http", "net"] },
];

/** Turns on, in `features`, every feature that one of its features
 * requires, directly or through another requirement, and returns it. The
 * value keeps its keys and their order. */
export function withRequiredLinkFeatures(features: NativeLinkFeatures): NativeLinkFeatures {
  for (;;) {
    let changed = false;
    for (const { feature, requires } of LINK_FEATURE_REQUIREMENTS) {
      if (!features[feature]) continue;
      for (const name of requires) {
        if (features[name]) continue;
        features[name] = true;
        changed = true;
      }
    }
    if (!changed) return features;
  }
}

export interface NativeLinkInfo {
  schema: "scriptc.native-link-info.v1";
  format: 1;
  compiler_version: string;
  object_abi: {
    stability: "experimental";
    compatibility: "exact-runtime-version";
  };
  target: {
    name: NativeTargetSpec["name"];
    llvm_triple: NativeTargetSpec["llvmTriple"];
    architecture: NativeTargetSpec["architecture"];
    object_format: NativeTargetSpec["objectFormat"];
    minimum_os: NativeTargetSpec["minimumOs"];
    relocation_model: NativeTargetSpec["relocationModel"];
  };
  program: {
    object: string;
    entry_symbol: "main";
    undefined_runtime_symbol_prefix: "scr_";
  };
  runtime_abi: {
    version: typeof RUNTIME_ABI_VERSION;
    marker: typeof RUNTIME_ABI_MARKER;
  };
  runtime_pack: {
    kind: "precompiled";
    package: string;
    version: string;
    root: string;
    path_base: "runtime_pack.root";
    flavor: NativeOptimization;
    objects: RuntimePackArtifact[];
    archives: RuntimePackArtifact[];
  };
  ffi: {
    format: number | null;
    symbols: string[];
    libraries: string[];
  };
  link: {
    input_order: string[];
    driver_flags: string[];
    system_libraries: string[];
    frameworks: string[];
  };
}

/** Format the same external-link contract after either host verifies a pack. */
export function formatNativeLinkInfo(
  options: {
    programObject: string;
    target: NativeTargetSpec;
    ffi: FfiProfile | null;
  },
  compilerVersion: string,
  pack: {
    root: string;
    manifest: RuntimePackManifest;
    selected: RuntimePackArtifacts;
    flavor: NativeOptimization;
  },
): NativeLinkInfo {
  const ffiLibraries = options.ffi?.libraries ?? [];
  const plan = executableLinkInputs({
    target: options.target,
    programObject: options.programObject,
    ffiLibraries,
    ffiSystemLibraries: options.ffi?.systemLibraries ?? [],
    ffiFrameworks: options.ffi?.frameworks ?? [],
    runtimeObjects: pack.selected.runtime.map((artifact) => join(pack.root, artifact.path)),
    runtimeArchives: pack.selected.archives.map((artifact) => join(pack.root, artifact.path)),
    runtimeSystemLibraries: pack.selected.systemLibraries,
    optimization: pack.flavor,
  });
  return {
    schema: "scriptc.native-link-info.v1",
    format: 1,
    compiler_version: compilerVersion,
    object_abi: {
      stability: EXTERNAL_OBJECT_ABI_STABILITY,
      compatibility: "exact-runtime-version",
    },
    target: {
      name: options.target.name,
      llvm_triple: options.target.llvmTriple,
      architecture: options.target.architecture,
      object_format: options.target.objectFormat,
      minimum_os: options.target.minimumOs,
      relocation_model: options.target.relocationModel,
    },
    program: {
      object: options.programObject,
      entry_symbol: "main",
      undefined_runtime_symbol_prefix: "scr_",
    },
    runtime_abi: {
      version: RUNTIME_ABI_VERSION,
      marker: RUNTIME_ABI_MARKER,
    },
    runtime_pack: {
      kind: "precompiled",
      package: pack.manifest.package,
      version: pack.manifest.version,
      root: pack.root,
      path_base: "runtime_pack.root",
      flavor: pack.flavor,
      objects: pack.selected.runtime,
      archives: pack.selected.archives,
    },
    ffi: {
      format: options.ffi?.ffiFormat ?? null,
      symbols:
        options.ffi?.functions.filter((fn) => !fn.callbackOperation).map((fn) => fn.symbol) ?? [],
      libraries: [...ffiLibraries],
    },
    link: {
      input_order: plan.inputs,
      driver_flags: plan.driverFlags,
      system_libraries: plan.systemLibraries,
      frameworks: [...(options.ffi?.frameworks ?? [])],
    },
  };
}
