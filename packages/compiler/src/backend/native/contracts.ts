import type { NativeOptimization } from "../optimization.js";
import { type WindowsSubsystem } from "../targets.js";

export interface CcOptions {
  /** Path of the generated (or hand-written) program TU: a .c file, or the
   * LLVM backend's .ll — clang compiles IR text natively on the same
   * command line, so both ride this one seat. */
  cPath: string;
  /** Path of the native executable to produce. */
  outPath: string;
  /** Additional identity for a translation unit whose complete non-system
   * dependency graph is owned by the caller. Persistent caching is disabled
   * when omitted: arbitrary C can depend on same-path edited headers and on
   * compiler-visible source spelling (`__FILE__`), neither of which the
   * top-level bytes alone can safely represent. scriptc's frontend supplies
   * this for its generated LLVM IR; caller-supplied C deliberately does not. */
  cacheIdentity?: string;
  /** Native optimization posture. Release preserves the historical -O2
   * executable lane; dev selects -O0 and may compile a caller-provided LLVM
   * shard set into independently cached objects before the final link. */
  optimization?: NativeOptimization;
  /** Remove symbol/debug payload from the linked executable. */
  strip?: boolean;
  /** PE executable subsystem; omitted and console use the driver default. */
  windowsSubsystem?: WindowsSubsystem;
  /** Optional equivalent LLVM modules for dev compilation. Unsupported
   * targets or merge failures fall back to the canonical cPath TU. */
  programShards?: readonly { name: string; source: string }[];
  /** Canonical externally visible definitions retained while shard merging
   * demotes generated cross-shard linkage back to local symbols. */
  programPublicSymbols?: readonly string[];
  /** Build with ASan + the runtime RC audit (test/debug lane). */
  sanitize?: boolean;
  /** Additional native archives/objects, appended after the generated
   * program TU so their symbols resolve outbound FFI calls. These inputs can
   * be thin archives or linker scripts with mutable transitive dependencies,
   * so their builds bypass the complete-executable cache while still reusing
   * cached runtime objects. */
  linkInputs?: readonly string[];
  /** Driver-neutral system library names, emitted as `-l<name>` after
   * linkInputs. Because the linker resolves these ambient names to files,
   * their builds bypass the complete-executable cache while still reusing
   * cached runtime objects. */
  systemLibraries?: readonly string[];
  /** Darwin framework names, emitted as distinct driver arguments. */
  frameworks?: readonly string[];
  /** Embed the dynamic-island engine (--dynamic): compiles scr_island.c,
   * defines SCR_DYNAMIC, and links the cached libqjs.a. Off retains the
   * static runtime selection; executable section GC may still remove
   * unreachable static-runtime code. */
  dynamic?: boolean;
  /** Isolated native Worker contexts; every runtime object must use TLS. */
  workers?: boolean;
  /** The program contains a regex construct (index.ts detects it on the
   * IR): compiles scr_regex.c and links the vendored libregexp — as cached
   * standalone objects in static builds, from the engine archive under
   * --dynamic (one libregexp per binary; its host hooks want the island's
   * JSContext there). Off = regex-free: the command line is exactly the
   * historical runtime selection; executable section GC may remove unrelated
   * unreachable code. */
  regex?: boolean;
  /** The program uses one of the copying/typed-array bridge intrinsics
   * implemented in scr_copying.c (index.ts detects them on the IR).
   * Off keeps that optional TU out of unrelated binaries. */
  copying?: boolean;
  /** The program uses a statically-labelled non-UTF-8 TextDecoder. Its
   * generated mapping tables live behind SCR_TEXT_DECODER_LEGACY so the
   * always-compiled bytes TU stays in the historical size class otherwise. */
  textDecoderLegacy?: boolean;
  /** The program uses fs/promises.open or a FileHandle value
   * (moduleUsesFileHandle on the IR): compiles scr_file_handle.c. Keeping
   * the descriptor object and promise adapters in their own unit preserves
   * the base runtime's size class for programs that never open a handle. */
  fileHandle?: boolean;
  /** The embedded npm graph references fetch (index.ts detects it on the
   * IR): compiles the NATIVE fetch bridge (scr_fetch.c over scr_net +
   * scr_tls + scr_http's client parser + zlib — the socket units join
   * the link implicitly, no libcurl anywhere), which builds for every
   * target the socket units reach: hosts, linux cross, win32 cross.
   * Static user-code fetch compiles the same TU without the engine; the
   * broader web surface still uses its dynamic half. Fetch-free builds
   * keep their exact link line. SCRIPTC_FETCH_CURL=1 selects the retired
   * curl reference instead
   * (scr_fetch_curl.c + system libcurl on hosts / the generated soname
   * stub on linux cross targets — ensureCurlStub), kept compilable for
   * one release as the flip's reference. */
  fetch?: boolean;
  /** The embedded npm graph imports node:http or node:https (index.ts
   * detects it on the IR): compiles the island's http/https client
   * bridge (scr_net_island.c) and implies the socket units into the
   * link, exactly like fetch. The emitted main calls
   * scr_net_island_install on the same predicate (native-fetch builds
   * also register it from scr_fetch_install). */
  netIsland?: boolean;
  /** The program uses zlib (index.ts detects zlib.* libCalls on the IR):
   * compiles scr_zlib.c — the regex/curl gating precedent, so zlib-free
   * binaries keep their exact link line. The default host-clang build links
   * the SYSTEM libz (macOS ships it), byte-identical to the historical line;
   * every Zig build compiles the vendored zlib with the selected driver instead
   * (ensureZlibObjects — zig has no libz in its sysroots). Compressed bytes may
   * differ between the
   * system and vendored libraries, which is why the corpus only ever
   * compares round-trips and fixed-blob inflation, never raw deflate
   * output. */
  zlib?: boolean;
  /** The program uses node:assert (index.ts detects assert.* libCalls on
   * the IR): compiles scr_assert.c — the zlib gating precedent, so
   * assert-free binaries keep their exact size class. scr_regex.c calls
   * the assert throw/inspect helpers (assert.match lives there) and
   * scr_symbol.c calls the equality message assemblers (assert.eqSym
   * lives there), so the regex and symbol switches also pull this
   * file. */
  assert?: boolean;
  /** The program uses util.inspect/format (index.ts detects insp.*
   * libCalls on the IR): compiles scr_inspect.c — the assert gating
   * precedent, so inspect-free binaries keep their exact size class. */
  inspect?: boolean;
  /** The program dispatches prototype methods on dyn receivers (index.ts
   * detects dynInvoke nodes / dyn.defineProps libCalls on the IR):
   * compiles scr_dyn_invoke.c — the assert gating precedent, so
   * dispatch-free binaries keep their exact size class. */
  dynInvoke?: boolean;
  /** The program uses the diagnostics_channel surface (index.ts detects
   * dc.* libCalls on the IR): compiles scr_dc.c — pure data structure
   * over the checked-dynamic tree (no loop hooks, no install), cross-compiles everywhere.
   * Channel-free binaries keep their exact size class. */
  dc?: boolean;
  /** The program uses the checked-dynamic async surfaces
   * (moduleUsesDynAsync on the IR, or the dynInvoke/dc gates — their TUs
   * call into this one): compiles scr_async_dyn.c — dyn-promise
   * reactions, AsyncLocalStorage, the unhandledRejection/warning
   * process events. */
  dynAsync?: boolean;
  /** The program uses the process-events surface (signal/exit listeners,
   * stdin events, for-await over stdin — moduleUsesProcessEvents on the
   * IR): compiles scr_events.c into the binary. Event-free binaries keep
   * their exact link line and size class. */
  events?: boolean;
  /** The program uses the node:events EventEmitter surface
   * (moduleUsesEmitter on the IR): compiles scr_events_emitter.c into the
   * binary — the events gating precedent, but pure data structure (no
   * loop hooks, no install), so it cross-compiles everywhere win32
   * included. Emitter-free binaries keep their exact link line. */
  emitter?: boolean;
  /** The program uses ES Symbol values (moduleUsesSymbol on the IR):
   * compiles scr_symbol.c into the binary — the emitter gating precedent:
   * pure data structure (no loop hooks, no install; the Symbol.for
   * registry initializes lazily), so it cross-compiles everywhere.
   * Symbol-free binaries keep their exact link line. */
  symbol?: boolean;
  bigint?: boolean;
  /** Records URLSearchParams use in the build identity. Its runtime unit is
   * part of the base sources because checked URL handles expose searchParams. */
  searchParams?: boolean;
  /** The program uses the node:querystring surface (moduleUsesQs on the
   * IR): compiles scr_qs.c into the binary — the searchParams gating
   * precedent: pure data transforms (no loop hooks, no install),
   * cross-compiles everywhere. qs-free binaries keep their exact link
   * line (escape-only programs ride the always-linked component encoder
   * and never flip this). */
  qs?: boolean;
  /** The program uses native util parsing, comparison, or styling. Optional
   * utility units also require their symbol, inspection, and warning features. */
  parseArgs?: boolean;
  /** The program uses the node:stream class surface (moduleUsesStream on
   * the IR): compiles scr_stream.c into the binary — always alongside
   * scr_events_emitter.c, which moduleUsesEmitter answers true for
   * whenever this does (the stream classes root at the emitter). Pure
   * data structure plus the loop's deferred-tick hook — no poller, so it
   * cross-compiles everywhere win32 included. */
  stream?: boolean;
  /** The program uses the node:net surface (moduleUsesNet on the IR):
   * compiles scr_net.c into the binary — the events gating precedent, so
   * net-free binaries keep their exact link line. */
  net?: boolean;
  /** The program uses the node:http server surface (moduleUsesHttpServer
   * on the IR): compiles scr_http.c — always alongside scr_net.c, which
   * moduleUsesNet answers true for whenever this does. */
  http?: boolean;
  /** The program uses the REAL node:http2 surface (moduleUsesHttp2 on
   * the IR): compiles scr_http2.c — always alongside scr_net.c, which
   * moduleUsesNet answers true for whenever this does. */
  http2?: boolean;
  /** The program uses the node:dgram or node:dns surface (moduleUsesDgram
   * on the IR): compiles scr_dgram.c into the binary — the net gating
   * precedent, so dgram-free binaries keep their exact link line. */
  dgram?: boolean;
  /** The program uses fs.watch (moduleUsesFsWatch on the IR): compiles
   * scr_watch.c into the binary — the net gating precedent, so watch-free
   * binaries keep their exact link line. */
  watch?: boolean;
  /** The executable manifest has a format-5 foreign callback descriptor:
   * compiles the MPSC queue/self-pipe unit. Other FFI and non-FFI binaries
   * keep their existing runtime size class. */
  foreignFfi?: boolean;
  /** The program uses node:test (moduleUsesNodeTest on the IR): compiles
   * scr_test.c into the binary — the net gating precedent, so test-free
   * binaries keep their exact link line. */
  nodeTest?: boolean;
  /** The program uses the node:tls or node:https surface (moduleUsesTls on
   * the IR): compiles scr_tls.c and links the vendored mbedTLS archive
   * (built lazily like the engine archive, cached per flavor). Always
   * alongside scr_net.c and scr_http.c, which moduleUsesNet /
   * moduleUsesHttpServer answer true for whenever this does. TLS-free
   * binaries keep their exact link line and never compile mbedTLS. */
  tls?: boolean;
  /** The program uses the CA-store introspection surface (moduleUsesTlsCa
   * on the IR — getCACertificates / rootCertificates /
   * setDefaultCACertificates): compiles scr_tls_ca.c, PEM-block bookkeeping
   * plus the platform certificate-store reader on Windows, with NO mbedTLS
   * dependency, so an introspection-only binary never builds the archive.
   * The unit also compiles whenever `tls` does — scr_tls.c consults its
   * default-set override and shared Windows-certificate enumerator. */
  tlsCa?: boolean;
  /** Internal compiler hook: called only after a strict native artifact hit
   * or a successful stable build has installed `outPath`. The executable
   * frontend cache uses it to publish its stamp after native dependencies
   * have validated; arbitrary compileC callers leave it unset. */
  onArtifactReady?: (artifact: ValidatedNativeArtifact) => Promise<void>;
}

/** Native dependency proof attached to an executable frontend-cache entry.
 * compileC produces this only after its strict local/CAS validation succeeds;
 * the early reader replays it before restoring the final executable. */
export interface ValidatedNativeArtifact {
  dependencies: NativeArtifactDependency[];
}

export interface LibArchiveOptions {
  /** The program TU (.c or .ll — clang compiles either with -c). */
  cPath: string;
  /** Invocation-owned program source to compile under `cPath`'s public
   * spelling. Library assembly uses this for the identity-free projection of
   * a complete caller-visible TU; its bytes drive every native cache key. */
  programSource?: string;
  /** Optional equivalent LLVM modules for native compilation. The public
   * `programSource` remains the canonical TU/cache identity; these stable
   * shards compile independently and are relocatably merged into one program
   * object before archive assembly. */
  programShards?: readonly { name: string; source: string }[];
  /** Canonical externally visible definitions retained while the shard merge
   * demotes generated cross-shard linkage back to local symbols. */
  programPublicSymbols?: readonly string[];
  /** Tiny LLVM module carrying volatile library identity getters.
   * Its bytes join the complete archive key, but the source itself exists
   * only in the invocation-private build directory and the large program-
   * object cache is keyed independently. */
  identityLlvmSource?: string;
  /** The archive to produce (<name>.lib.a). */
  outPath: string;
  /** Caller-owned identity for the generated TU's complete non-system
   * dependency graph. Omission bypasses persistent artifact/object caching,
   * matching compileC's arbitrary-input safety boundary. */
  cacheIdentity?: string;
  sanitize?: boolean;
  /** Native optimization posture: release = -O2, dev = -O0. */
  optimization?: NativeOptimization;
  /** Multi-instance library mode (the profile's abi.localize_runtime): the
   * external symbols to KEEP global — every other scriptc external
   * definition in the archive (the runtime's internals, the program TU's
   * mangled functions and globals, vendor objects) is demoted to a local
   * symbol. Toolchain sanitizer ABI remains external as required,
   * so N archives built under pairwise-distinct prefixes link into one
   * process with no symbol collisions and no shared mutable runtime state.
   * Undefined references (the target C/math runtime and system APIs, plus
   * sanitizer ABI in instrumented builds) keep their global binding. Windows
   * embedders additionally link advapi32, iphlpapi, and ws2_32. Omitted = the
   * classic archive, byte-for-byte. Admitted for darwin/linux/win32 native
   * hosts, linux/android/windows cross triples from any host, and macos/ios
   * cross triples from a darwin host (compileLibrary owns the refusal
   * fence). */
  localizeSymbols?: readonly string[];
  /** Thread-instanced state (the profile's abi.instance_per_thread): every
   * TU of the archive compiles with -DSCR_THREAD_INSTANCES, moving the
   * runtime units' mutable statics into thread-local storage (SCR_TL in
   * scr_runtime.h) to match the program TU's thread-local globals — one
   * complete instance per embedder thread. The define rides cflags, so
   * every cache tier keys it automatically; omitted = the classic
   * archive, byte-for-byte. */
  threadInstances?: boolean;
  /** IR-detected link gates (the compileC precedent, refusal-narrowed). */
  dynInvoke?: boolean;
  regex?: boolean;
  assert?: boolean;
  inspect?: boolean;
  symbol?: boolean;
  bigint?: boolean;
  searchParams?: boolean;
  emitter?: boolean;
  zlib?: boolean;
  copying?: boolean;
  textDecoderLegacy?: boolean;
}

export interface NativeArtifactDependency {
  path: string;
  kind: "file" | "directory" | "symlink";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Symlinks are identity-bearing paths whose target bytes also matter. */
  targetPath?: string;
  targetKind?: "file" | "directory";
  targetDev?: number;
  targetIno?: number;
  targetSize?: number;
  targetMtimeMs?: number;
  targetCtimeMs?: number;
  /** A directory's recursive namespace. This detects a new nested candidate
   * that can begin shadowing an existing system/header dependency. */
  treeDigest?: string;
  treeExclusions?: string[];
}
