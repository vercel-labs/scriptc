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
  fileHandle: boolean;
  fetch: boolean;
  eventTarget?: boolean;
  /** The WebAssembly API (scr_wasm.c). Absent when unused, so programs
   * without it keep their link identity. */
  wasm?: boolean;
  /** The program assigns process.emitWarning: links the
   * SCR_WARNING_REPLACE variant of the dyn-async unit. */
  warningReplace?: boolean;
  /** The program uses process.stdin.setEncoding, string 'data' listeners
   * or stdio 'resize' events: links the SCR_STDIO_EXTENDED events unit. */
  stdioExtended?: boolean;
  zlib: boolean;
  assert: boolean;
  inspect: boolean;
  dynInvoke: boolean;
  /** Dynamic reads whose key may name an inherited Object.prototype member:
   * scr_dyn_inherited.c. Absent (not false) for programs without them. */
  dynInherited?: boolean;
  /** `new` through the builtin constructors inherited reads answer:
   * scr_dyn_global_construct.c. Absent (not false) for programs without it. */
  dynGlobalConstruct?: boolean;
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
  declAdopt?: boolean;
  /** for await over checked-dynamic values: scr_dyn_for_await.c. Absent
   * (false) for programs without it. */
  dynForAwait?: boolean;
  /** events.once with options: scr_events_once_signal.c. Absent (not
   * false) for programs without it. */
  eventsOnceSignal?: boolean;
  /** Buffer.prototype methods called on checked-dynamic values link
   * scr_bytes_dyn.c; absent (false) for programs without them. */
  dynBuffer?: boolean;
  /** Builtin functions read as values (Buffer.byteLength, Buffer.alloc,
   * fs.realpathSync) link scr_builtin_values.c; absent (false) otherwise. */
  builtinValues?: boolean;
  events: boolean;
  emitter: boolean;
  symbol: boolean;
  bigint: boolean;
  searchParams: boolean;
  qs: boolean;
  utilPromisify: boolean;
  dynBuiltinClass: boolean;
  dynBuiltinStream: boolean;
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
  /** perf_hooks event-loop metrics: scr_perf_loop.c. */
  perfLoop: boolean;
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
