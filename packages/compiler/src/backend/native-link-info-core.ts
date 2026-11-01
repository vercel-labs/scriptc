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
  /** The program uses a runtime feature only a JavaScript source reaches:
   * links the SCR_JS_OBJECT_MODEL build of every unit those features touch
   * (t262-da §J). Absent for every other program, so their objects stay
   * identical. */
  jsObjectModel?: boolean;
  /** writeFile's `flag` disposition or copyFile's mode argument:
   * scr_fs_flags.c and the SCR_FS_FLAGS build of scr_fs_cp.c. */
  fsFlags?: boolean;
  /** string_decoder's checked-dynamic chunk forms: scr_bytes_strdec_dyn.c. */
  strdecDyn?: boolean;
  /** process.prependListener, stdin.isRaw or server.off: the
   * SCR_PROCESS_EXTRAS build of scr_async_dyn.c and the
   * SCR_NET_SERVER_OFF build of scr_net.c. */
  processExtras?: boolean;
  /** A write completion callback takes the error argument: links the
   * SCR_STREAM_WRITE_ERRORS build of the stream unit. */
  streamWriteErrors?: boolean;
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
  zlib: boolean;
  /** node:zlib's Brotli forms: scr_brotli.c and the vendored brotli archive. */
  brotli?: boolean;
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
  /** The spawnSync and exec/execFile-callback `cwd`/`input`/`shell`
   * entries: selects the SCR_CHILD_CP_OPTIONS build of scr_child.c.
   * Absent (false) otherwise. */
  childOptionExt?: boolean;
  declAdopt?: boolean;
  typeOrigins?: boolean;
  /** for await over checked-dynamic values: scr_dyn_for_await.c. Absent
   * (false) for programs without it. */
  dynForAwait?: boolean;
  /** Object.isExtensible and Object.isSealed of a value typed dynamically:
   * scr_dyn_integrity.c. Absent (false) for programs without it. */
  dynIntegrityQueries?: boolean;
  /** A generator that binds its parameters at the call: scr_gen_bind.c.
   * Absent (false) for programs without one. */
  genBind?: boolean;
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
  /** AbortController and AbortSignal: scr_abort.c, unless the program
   * links the fetch unit, which has them. */
  abortSignal?: boolean;
  /** util.debounce and util.throttle: scr_util_timing.c. */
  utilTiming?: boolean;
  /** Buffer.prototype methods called on checked-dynamic values link
   * scr_bytes_dyn.c; absent (false) for programs without them. */
  dynBuffer?: boolean;
  /** Builtin functions read as values (Buffer.byteLength, Buffer.alloc,
   * fs.realpathSync) link scr_builtin_values.c; absent (false) otherwise. */
  builtinValues?: boolean;
  /** A standard library prototype object read as a value in a JavaScript
   * source (`Date.prototype`) links scr_dyn_stdlib_prototype.c; absent
   * (false) otherwise, so other programs keep their exact link line. */
  stdlibPrototypeValue?: boolean;
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
  /** Number.prototype or Boolean.prototype read as a value:
   * scr_dyn_builtin_prototype.c. Absent (false) otherwise. */
  builtinPrototypeValue?: boolean;
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
