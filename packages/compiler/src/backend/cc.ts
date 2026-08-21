import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { access, chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { localizeElfObject, mergeAndLocalizeCoffObjects } from "./object-localize.js";

const execFileAsync = promisify(execFile);
const CC_IMPLEMENTATION_PATH = fileURLToPath(import.meta.url);

/** Test lanes run against one immutable checkout and one immutable toolchain
 * for the lifetime of each Vitest worker. Production deliberately rediscovers
 * compiler/linker inputs on every invocation, but doing that thousands of
 * times in the differential corpus costs far more than the compile itself.
 * This test-only opt-in lets those workers reuse metadata probes for their
 * session; the cache-correctness suite removes the flag and exercises the
 * strict production path. */
function stableTestToolchainSession(): boolean {
  return process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"] === "1";
}

function stableTestMemo<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  probe: () => Promise<T>,
): Promise<T> {
  if (!stableTestToolchainSession()) return probe();
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const pending = probe();
  cache.set(key, pending);
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

const RUNTIME_SOURCES = ["scr_number.c", "scr_string.c", "scr_array.c", "scr_bytes.c", "scr_bytes_io.c", "scr_map.c", "scr_closure.c", "scr_ffi.c", "scr_object.c", "scr_union.c", "scr_exception.c", "scr_error.c", "scr_console.c", "scr_lib.c", "scr_path.c", "scr_url.c", "scr_json.c", "scr_async.c", "scr_child.c", "scr_cycle.c"];

/** The pinned quickjs-ng snapshot under packages/runtime/vendor/quickjs-ng
 * (see vendor/README.md — update both together). Keys the archive cache so
 * a vendor bump can never reuse a stale engine build. */
const QJS_COMMIT = "3c8f3d68953955950074c41c6e4d999562ae82a7";

/** The pinned mbedTLS snapshot under packages/runtime/vendor/mbedtls (see
 * vendor/README.md — update both together). Keys the archive cache so a
 * vendor bump can never reuse a stale TLS build, and joins the runtime
 * fingerprint so cached binaries re-key too. */
const MBEDTLS_VERSION = "3.6.7";

/** The pinned zlib snapshot under packages/runtime/vendor/zlib (see
 * vendor/README.md — update both together). Keys the per-target object
 * cache and joins the runtime fingerprint. Host builds never compile it —
 * they keep the historical system `-lz` link; the vendored copy exists so
 * zlib-using programs CROSS-compile (zig has no target sysroot libz). */
const ZLIB_VERSION = "1.3.1";

/** Environment variables consumed by clang, its linker/subtools, or the
 * platform SDK selection. They are implicit command-line inputs: changing one
 * must never reuse an artifact produced under the old toolchain posture. */
const TOOLCHAIN_ENV_KEYS = [
  "COMPILER_PATH",
  "GCC_EXEC_PREFIX",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "OBJC_INCLUDE_PATH",
  "OBJCPLUS_INCLUDE_PATH",
  "LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_RUN_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "SDKROOT",
  "DEVELOPER_DIR",
  "MACOSX_DEPLOYMENT_TARGET",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "TVOS_DEPLOYMENT_TARGET",
  "WATCHOS_DEPLOYMENT_TARGET",
  "DRIVERKIT_DEPLOYMENT_TARGET",
  "XROS_DEPLOYMENT_TARGET",
  "CCC_OVERRIDE_OPTIONS",
  "CCC_ADD_ARGS",
  "CLANG_CONFIG_FILE_SYSTEM_DIR",
  "CLANG_CONFIG_FILE_USER_DIR",
  "CC",
  "CFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "AR",
  "RANLIB",
  "CMAKE_GENERATOR",
  "CMAKE_TOOLCHAIN_FILE",
  "ZIG_LIB_DIR",
  "ZIG_LIBC",
  "SOURCE_DATE_EPOCH",
  "ZERO_AR_DATE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

/** Toolchain variables whose values name mutable files/directories consumed
 * while compiling a TU (or can inject arbitrary compiler options). Hashing the
 * value is insufficient: a header, SDK, config, compiler helper, or loaded
 * dylib can change in place while the spelling remains stable. In that posture
 * neither complete artifacts nor per-TU runtime objects are safe to reuse. */
const MUTABLE_COMPILE_ENV_KEYS = [
  "COMPILER_PATH",
  "GCC_EXEC_PREFIX",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "OBJC_INCLUDE_PATH",
  "OBJCPLUS_INCLUDE_PATH",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "SDKROOT",
  "DEVELOPER_DIR",
  "CCC_OVERRIDE_OPTIONS",
  "CCC_ADD_ARGS",
  "CLANG_CONFIG_FILE_SYSTEM_DIR",
  "CLANG_CONFIG_FILE_USER_DIR",
  // `zig cc` resolves its bundled headers/runtime through ZIG_LIB_DIR and a
  // caller-selected native libc description through ZIG_LIBC. Both values name
  // mutable compiler inputs whose contents can change behind a stable path.
  "ZIG_LIB_DIR",
  "ZIG_LIBC",
] as const;

/** These variables only redirect link-time inputs. Runtime objects remain
 * reusable, but a complete executable could otherwise retain a library that
 * was rebuilt in place behind the same search-path spelling. */
const MUTABLE_LINK_ENV_KEYS = ["LIBRARY_PATH", "LD_RUN_PATH"] as const;

export interface ToolchainEnvironmentCachePolicy {
  completeArtifacts: boolean;
  runtimeObjects: boolean;
}

export function toolchainEnvironmentCachePolicy(
  env: NodeJS.ProcessEnv = process.env,
): ToolchainEnvironmentCachePolicy {
  const mutableCompileInput = MUTABLE_COMPILE_ENV_KEYS.some((name) => env[name] !== undefined);
  const mutableLinkInput = MUTABLE_LINK_ENV_KEYS.some((name) => env[name] !== undefined);
  return {
    completeArtifacts: !mutableCompileInput && !mutableLinkInput,
    runtimeObjects: !mutableCompileInput,
  };
}

export function toolchainEnvironmentFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256").update("toolchain-env-v1\0");
  for (const name of TOOLCHAIN_ENV_KEYS) {
    const value = env[name];
    hash.update(name).update(value === undefined ? "\0unset\0" : "\0set\0").update(value ?? "").update("\0");
  }
  return hash.digest("hex");
}

/** Inputs that can change which native tool/runtime implementation an
 * executable build selects before compileC has a chance to rediscover it.
 * The early whole-program cache keys this exact posture before restoring a
 * final binary; compileC retains its deeper inode/content validation. */
export async function executableNativeEnvironmentFingerprint(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configuredCompiler = env["SCRIPTC_CC"] ?? "";
  let compilerIdentity: string;
  try {
    compilerIdentity = await effectiveCompilerEnvironmentIdentity(resolveCc(env), env);
  } catch {
    // A failed trace cannot safely describe a reusable native posture. Keep
    // the build working, but make this invocation miss every persistent early
    // entry so compileC performs its full discovery and validation.
    compilerIdentity = `<unavailable:${configuredCompiler}:${randomUUID()}>`;
  }
  const hash = createHash("sha256")
    .update("executable-native-environment-v2\0")
    .update(toolchainEnvironmentFingerprint(env)).update("\0")
    // PATH text alone is not a resolution proof, and on Darwin /usr/bin/clang
    // is a stable shim whose selected Xcode compiler can change underneath it.
    // Re-resolve and trace the effective driver on every early lookup.
    .update(compilerIdentity).update("\0");
  for (const name of [
    "PATH",
    "SCRIPTC_FETCH_CURL",
    "SCRIPTC_TEST_RUNTIME_SRC_DIR",
    "SCRIPTC_TEST_VENDOR_CACHE_DIR",
    "SCRIPTC_TEST_TRUST_COMPILER_WRAPPER",
  ]) {
    const value = env[name];
    hash.update(name).update(value === undefined ? "\0unset\0" : "\0set\0").update(value ?? "").update("\0");
  }
  return hash.digest("hex");
}

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
   * this for its generated C/LLVM IR; `--from-c` deliberately does not. */
  cacheIdentity?: string;
  /** Native optimization posture. Release preserves the historical -O2
   * executable lane; dev selects -O0 and may compile a caller-provided LLVM
   * shard set into independently cached objects before the final link. */
  optimization?: "release" | "dev";
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
  /** Embed the dynamic-island engine (--dynamic): compiles scr_island.c,
   * defines SCR_DYNAMIC, and links the cached libqjs.a. Off = the static
   * default, byte-identical to builds predating the flag. */
  dynamic?: boolean;
  /** The program contains a regex construct (index.ts detects it on the
   * IR): compiles scr_regex.c and links the vendored libregexp — as cached
   * standalone objects in static builds, from the engine archive under
   * --dynamic (one libregexp per binary; its host hooks want the island's
   * JSContext there). Off = regex-free: the command line is exactly the
   * historical one, so regex-free binaries cannot change by a byte. */
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
   * binaries keep their exact link line. Host builds link the SYSTEM libz
   * (macOS ships it), byte-identical to the historical line; cross targets
   * compile the vendored zlib per target instead (ensureZlibObjects — zig
   * has no libz in its sysroots). Compressed bytes may differ between the
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
  /** The program uses the URLSearchParams surface (moduleUsesSearchParams
   * on the IR): compiles scr_url_params.c into the binary — the symbol
   * gating precedent: pure data structure (no loop hooks, no install),
   * cross-compiles everywhere. sp-free binaries keep their exact link
   * line (scr_url.c never references the unit). */
  searchParams?: boolean;
  /** The program uses the node:querystring surface (moduleUsesQs on the
   * IR): compiles scr_qs.c into the binary — the searchParams gating
   * precedent: pure data transforms (no loop hooks, no install),
   * cross-compiles everywhere. qs-free binaries keep their exact link
   * line (escape-only programs ride the always-linked component encoder
   * and never flip this). */
  qs?: boolean;
  /** The program uses static util.parseArgs (index.ts detects its libCall):
   * compiles scr_util.c, a pure checked-dynamic data transform. */
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

/** Structured compiler-driver failure. Most callers still let this surface
 * as an internal build error; the TypeScript compiler pipeline recognizes it
 * when an outbound FFI profile is active and turns user-controlled native
 * link failures into SC5004. */
export class CcCompileError extends Error {
  constructor(
    readonly driver: string,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "CcCompileError";
  }
}

/** Preserve the useful output from a failed compiler/tool invocation. Node's
 * execFile error exposes stderr and stdout independently, but either stream
 * may be present as an empty string. Prefer compiler diagnostics, retain a
 * non-standard stdout diagnostic when that is all the tool emitted, and only
 * then fall back to the process error itself. */
export function subprocessFailureDetail(err: unknown): string {
  const failure = err as {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  const output = (value: string | Buffer | undefined): string => {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "";
    return text.trim().length > 0 ? text.trimEnd() : "";
  };
  const stderr = output(failure.stderr);
  const stdout = output(failure.stdout);
  if (stderr !== "" && stdout !== "") return `${stderr}\n\ncompiler stdout:\n${stdout}`;
  if (stderr !== "") return stderr;
  if (stdout !== "") return `compiler stdout:\n${stdout}`;
  if (typeof failure.message === "string" && failure.message.trim() !== "") {
    return failure.message;
  }
  return String(err);
}

export function runtimeSrcDir(): string {
  const testRoot = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
  if (testRoot !== undefined) return resolve(testRoot);
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@scriptc/runtime/package.json")), "src");
}

/* ── alternate C compiler (SCRIPTC_CC) and cross target (SCRIPTC_TARGET) ──────────
 * SCRIPTC_CC=zigcc swaps the compiler driver to `zig cc` (clang underneath, with
 * zig's bundled sysroots — the door to cross-compiling). Unset or
 * SCRIPTC_CC=clang is the default. Host Linux adds the two glibc requirements
 * that macOS does not need: -D_GNU_SOURCE while compiling, and -lm after all
 * link inputs. Other hosts keep the historical bare-clang command line.
 *
 * SCRIPTC_TARGET=<triple> (zigcc only — plain clang has no cross sysroots here)
 * adds `-target <triple>` to every compile. Linux triples also add
 * -D_GNU_SOURCE: glibc hides POSIX/GNU declarations (kill, realpath, stpcpy,
 * arc4random_buf, posix_spawn_file_actions_addchdir_np, ...) under plain
 * -std=c11, where macOS exposes everything by default. Musl triples additionally
 * carry SCR_MUSL because musl deliberately exposes no libc-identification macro;
 * the runtime uses it only for the narrow libc shim in scr_musl.c. Pin the glibc
 * minor in GNU triples (e.g. aarch64-linux-gnu.2.36) so the binary runs on the
 * differential container's distro (see tests/harness/linux-differential.test.ts).
 *
 * Fetch is NATIVE everywhere (scr_fetch.c over the socket units — no
 * libcurl), so it cross-compiles wherever net/http/tls do, win32
 * included. The retired curl reference (SCRIPTC_FETCH_CURL=1) keeps the
 * historical host -lcurl link and the linux-gnu import-STUB arm (soname
 * libcurl.so.4 — see ensureCurlStub). The event-loop units
 * (net/http/dgram/watch) cross-compile to Linux: the readiness poller is
 * the scr_platform.h contract with kqueue and epoll backends; libregexp,
 * zlib, mbedTLS, and the engine archive (--dynamic) build per target
 * (ensureLreObjects / ensureZlibObjects / ensureTlsArchive /
 * buildEngineArchiveDirect — host zlib builds still link the system libz,
 * byte-identically).
 * Windows triples (x86_64-windows-gnu, mingw-w64 headers and CRT via zig)
 * have no gates left: events, net/http, fetch, watch, zlib, dgram/dns,
 * tls, and the engine archive (--dynamic) all build per target through
 * their win32 arms (mbedTLS compiles unchanged for the triple — its own _WIN32
 * port covers entropy and timing; the TLS link adds bcrypt for
 * BCryptGenRandom, while the CA-store unit adds crypt32 for the Windows
 * system certificate stores).
 * They additionally compile
 * scr_win.c, the win32 libc shim TU (stpcpy, arc4random_buf — see the
 * _WIN32 block in scr_runtime.h), linking -ladvapi32 for its CSPRNG
 * (RtlGenRandom) and GetUserNameA. Native zigcc builds (no SCRIPTC_TARGET)
 * support everything: same platform, same archives, just a different
 * driver binary.
 * Mobile triples (aarch64-apple-ios, aarch64-apple-ios-simulator,
 * aarch64-linux-android — see the mobile-targets block below) are
 * LIBRARY-MODE targets: compileLibArchive accepts them, compile()/compileC
 * refuse the executable lane with the pointer to --lib. */
export interface CcDriver {
  /** The compiler argv prefix: ["clang"] (default) or ["zig", "cc"]. */
  argv: string[];
  /** The SCRIPTC_TARGET triple, or null for a host-native build. */
  target: string | null;
  /** The spelling handed to `zig cc -target` (and the relocatable-merge
   * link). Identical to `target` except for the mobile triples, whose
   * canonical LLVM spellings map to zig's own (`aarch64-apple-ios` →
   * `aarch64-ios.15.0`), pinning the minimum OS version in the same
   * breath. Null for a host-native build. */
  zigTarget: string | null;
  /** Extra compile args the produced platform demands. */
  targetArgs: string[];
  /** Platform libraries appended after every object/archive input. */
  linkArgs: string[];
}

/* ── mobile targets (library mode) ─────────────────────────────────────────
 * Three mobile triples are admitted, and only for LIBRARY-MODE archive
 * builds — the consuming pattern is an embedding app linking the archive,
 * never a standalone executable (compile()/compileC refuse the executable
 * lane with the pointer to --lib):
 *
 *   aarch64-apple-ios            device archives; zig `aarch64-ios.15.0`
 *   aarch64-apple-ios-simulator  simulator archives; zig
 *                                `aarch64-ios.15.0-simulator`
 *   aarch64-linux-android        zig `aarch64-linux-android.26`
 *
 * The minimum-version floors are part of the target contract: iOS archives
 * build for iOS 15.0 (IPHONEOS_MIN_VERSION), Android archives for API level
 * 26 (ANDROID_MIN_API) — LC_BUILD_VERSION minos and the bionic stub level
 * both come from the pinned zig spelling above, so an embedder's deployment
 * target at or above the floor links cleanly.
 *
 * Zig bundles no Apple or bionic libc, so both families compile against an
 * explicit sysroot discovered here and spelled into targetArgs (where every
 * cache tier already keys it):
 *
 *   iOS      darwin hosts only — `xcrun --show-sdk-path` selects the
 *            iPhoneOS/iPhoneSimulator SDK; compiles add `-isysroot <sdk>`
 *            plus `-isystem <sdk>/usr/include` (zig's driver manages libc
 *            header search itself and would otherwise find no headers).
 *   Android  any host with an NDK — ANDROID_NDK_ROOT/ANDROID_NDK_HOME, or
 *            the newest ndk/<version> under ANDROID_HOME/ANDROID_SDK_ROOT
 *            or the platform-default SDK location; compiles add the NDK
 *            sysroot's generic and per-triple include directories.
 *
 * Library archives never link, so the sysroot's LIBRARIES are the
 * embedder's side of the contract: Xcode links iOS archives against the
 * selected SDK, and Gradle/NDK builds link Android archives against the
 * API-26+ bionic stubs. */
export const IPHONEOS_MIN_VERSION = "15.0";
export const ANDROID_MIN_API = 26;

const MOBILE_LIBRARY_TARGETS = [
  "aarch64-apple-ios",
  "aarch64-apple-ios-simulator",
  "aarch64-linux-android",
] as const;

export function isIosTarget(target: string | null): boolean {
  return target === "aarch64-apple-ios" || target === "aarch64-apple-ios-simulator";
}

export function isAndroidTarget(target: string | null): boolean {
  return target === "aarch64-linux-android";
}

export function isMobileTarget(target: string | null): boolean {
  return isIosTarget(target) || isAndroidTarget(target);
}

/** The canonical mobile triple SCRIPTC_TARGET selects, or null when the
 * environment names none. Pure string inspection — safe to consult before
 * any toolchain discovery runs. */
export function mobileLibraryTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  const target = env["SCRIPTC_TARGET"] ?? "";
  return isMobileTarget(target) ? target : null;
}

/** The admission verdict for a mobile-family triple: null when the spelling
 * and host pairing are supported, otherwise the refusal text (the same text
 * resolveCc throws and compileLibrary reports as SC3002). Pure string/host
 * inspection — no discovery, no subprocess. */
export function mobileTargetRefusal(
  target: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string | null {
  if (isIosTarget(target)) {
    return hostPlatform === "darwin"
      ? null
      : `${target} library archives build on macOS hosts only (the Apple iOS SDK sysroot and Mach-O symbol localization live there); this host is ${hostPlatform}`;
  }
  if (isAndroidTarget(target)) return null;
  // A near-miss mobile spelling must refuse with the supported set named,
  // never reach zig with no sysroot wired (the compile would fail on the
  // first libc header) or produce an artifact for an unverified device
  // class.
  if (/(?:^|-)(?:ios|tvos|watchos|visionos|android)/.test(target)) {
    return `unsupported mobile target '${target}' (supported: ${MOBILE_LIBRARY_TARGETS.join(", ")})`;
  }
  return null;
}

/** The Apple SDK root for one mobile platform, discovered through xcrun the
 * way Xcode's own build system selects it. Memoized per SDK name and
 * selection environment: production rediscovers per process, and the two
 * selection variables (DEVELOPER_DIR/SDKROOT) are already mutable-input
 * keys that disable persistent caching. */
const appleSdkMemos = new Map<string, string>();
function appleSdkRoot(sdk: "iphoneos" | "iphonesimulator", env: NodeJS.ProcessEnv): string {
  const key = [sdk, env["PATH"] ?? "", env["DEVELOPER_DIR"] ?? "", env["SDKROOT"] ?? ""].join("\0");
  const memo = appleSdkMemos.get(key);
  if (memo !== undefined) return memo;
  const probe = spawnSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], {
    encoding: "utf8",
    env,
  });
  const path = probe.status === 0 ? (probe.stdout ?? "").trim() : "";
  if (path === "" || !existsSync(join(path, "usr", "include"))) {
    throw new Error(
      `the ${sdk} SDK was not found (xcrun --sdk ${sdk} --show-sdk-path failed) — ` +
        `iOS targets need Xcode with the ${sdk === "iphoneos" ? "iPhoneOS" : "iPhoneSimulator"} SDK installed`,
    );
  }
  appleSdkMemos.set(key, path);
  return path;
}

/** Compare dotted-numeric NDK version directory names, newest first. */
function compareNdkVersionsDesc(a: string, b: string): number {
  const as = a.split(".").map((s) => Number.parseInt(s, 10));
  const bs = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (bs[i] ?? 0) - (as[i] ?? 0);
    if (d !== 0 && Number.isFinite(d)) return d;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/** The Android NDK sysroot for the selected environment: an explicit
 * ANDROID_NDK_ROOT/ANDROID_NDK_HOME wins; otherwise the newest ndk/<version>
 * under ANDROID_HOME, ANDROID_SDK_ROOT, or the platform-default SDK
 * location. The prebuilt host directory is discovered rather than guessed —
 * the NDK ships exactly one per host OS. Memoized per selection
 * environment. */
const ndkSysrootMemos = new Map<string, string>();
function androidNdkSysroot(env: NodeJS.ProcessEnv): string {
  const key = ["ANDROID_NDK_ROOT", "ANDROID_NDK_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"]
    .map((name) => env[name] ?? "")
    .join("\0");
  const memo = ndkSysrootMemos.get(key);
  if (memo !== undefined) return memo;
  const ndkRoots: string[] = [];
  const explicit = [env["ANDROID_NDK_ROOT"], env["ANDROID_NDK_HOME"]]
    .find((root): root is string => root !== undefined && root !== "");
  if (explicit !== undefined) {
    ndkRoots.push(explicit);
  } else {
    const sdkRoots = [
      env["ANDROID_HOME"],
      env["ANDROID_SDK_ROOT"],
      process.platform === "darwin"
        ? join(homedir(), "Library", "Android", "sdk")
        : process.platform === "win32"
          ? join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Android", "Sdk")
          : join(homedir(), "Android", "Sdk"),
    ].filter((root): root is string => root !== undefined && root !== "");
    for (const root of sdkRoots) {
      let versions: string[] = [];
      try {
        versions = readdirSync(join(root, "ndk")).filter((name) => /^\d/.test(name));
      } catch {
        continue;
      }
      versions.sort(compareNdkVersionsDesc);
      ndkRoots.push(...versions.map((version) => join(root, "ndk", version)));
    }
  }
  for (const ndk of ndkRoots) {
    const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt");
    let hosts: string[] = [];
    try {
      hosts = readdirSync(prebuilt).sort();
    } catch {
      continue;
    }
    for (const host of hosts) {
      const sysroot = join(prebuilt, host, "sysroot");
      if (existsSync(join(sysroot, "usr", "include", "aarch64-linux-android"))) {
        ndkSysrootMemos.set(key, sysroot);
        return sysroot;
      }
    }
  }
  throw new Error(
    "no Android NDK sysroot was found — install an NDK (sdkmanager 'ndk;<version>') and/or set " +
      "ANDROID_NDK_ROOT to it (ANDROID_HOME with an ndk/ directory also works). " +
      "aarch64-linux-android compiles against the NDK's bionic headers.",
  );
}

/** Resolve native platform flags independently of the machine running tests,
 * so the host-Linux contract remains pinned on every development host. */
function nativePlatformArgs(platform: NodeJS.Platform): Pick<CcDriver, "targetArgs" | "linkArgs"> {
  return platform === "linux"
    ? { targetArgs: ["-D_GNU_SOURCE"], linkArgs: ["-lm"] }
    : { targetArgs: [], linkArgs: [] };
}

export function resolveCc(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
): CcDriver {
  const cc = env["SCRIPTC_CC"] ?? "";
  const target = env["SCRIPTC_TARGET"] ?? "";
  const hostArgs = nativePlatformArgs(hostPlatform);
  if (cc === "" || cc === "clang") {
    if (target !== "") {
      throw new Error(
        `SCRIPTC_TARGET=${target} requires SCRIPTC_CC=zigcc — the default clang path has no cross-target sysroots.`,
      );
    }
    return { argv: ["clang"], target: null, zigTarget: null, ...hostArgs };
  }
  if (cc !== "zigcc") {
    throw new Error(`unknown SCRIPTC_CC '${cc}' (supported: clang, zigcc)`);
  }
  if (target === "") return { argv: ["zig", "cc"], target: null, zigTarget: null, ...hostArgs };
  if (target.includes("wasi") && target !== "wasm32-wasi") {
    throw new Error(`unsupported WASI target '${target}' (supported: wasm32-wasi)`);
  }
  const mobileRefusal = mobileTargetRefusal(target, hostPlatform);
  if (mobileRefusal !== null) throw new Error(mobileRefusal);
  if (isIosTarget(target)) {
    // Library-mode-only target (compile()/compileC own the executable-lane
    // refusal). Zig bundles no Apple libc: the compile rides the selected
    // SDK sysroot, with the libc header directory spelled explicitly
    // because zig's driver manages libc search itself and consults no
    // -isysroot for it. The zig spelling pins the iOS 15.0 floor into
    // every object's LC_BUILD_VERSION minos.
    const simulator = target === "aarch64-apple-ios-simulator";
    const sdk = appleSdkRoot(simulator ? "iphonesimulator" : "iphoneos", env);
    const zigTarget = `aarch64-ios.${IPHONEOS_MIN_VERSION}${simulator ? "-simulator" : ""}`;
    return {
      argv: ["zig", "cc"],
      target,
      zigTarget,
      targetArgs: ["-target", zigTarget, "-isysroot", sdk, "-isystem", join(sdk, "usr", "include")],
      linkArgs: [],
    };
  }
  if (isAndroidTarget(target)) {
    // Library-mode-only target. Zig bundles no bionic: compiles ride the
    // NDK sysroot's generic and per-triple include directories. Bionic
    // supports _GNU_SOURCE like glibc (and hides some POSIX declarations
    // without it); the zig spelling pins the API 26 floor, which the NDK's
    // versioned stub libraries enforce at the embedder's link. API 26
    // bionic carries everything the library-lane units call (arc4random_buf
    // included), so no shim TU joins the archive.
    const sysroot = androidNdkSysroot(env);
    const zigTarget = `aarch64-linux-android.${ANDROID_MIN_API}`;
    return {
      argv: ["zig", "cc"],
      target,
      zigTarget,
      targetArgs: [
        "-target",
        zigTarget,
        "-D_GNU_SOURCE",
        "-isystem",
        join(sysroot, "usr", "include"),
        "-isystem",
        join(sysroot, "usr", "include", "aarch64-linux-android"),
      ],
      linkArgs: ["-lm"],
    };
  }
  const linux = target.includes("linux");
  const wasi = target.includes("wasi");
  const musl = target.includes("linux-musl");
  return {
    argv: ["zig", "cc"],
    target,
    zigTarget: target,
    targetArgs: [
      "-target",
      target,
      ...(linux || wasi ? ["-D_GNU_SOURCE"] : []),
      ...(musl ? ["-DSCR_MUSL"] : []),
      ...(wasi ? ["-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_PROCESS_CLOCKS"] : []),
    ],
    linkArgs: linux
      ? ["-lm"]
      : wasi
        ? ["-lwasi-emulated-signal", "-lwasi-emulated-process-clocks"]
        : [],
  };
}

/** Musl intentionally has no predefined libc macro. The explicit Zig target
 * is therefore the source of truth for selecting its small runtime shim. */
export function isMuslTarget(driver: Pick<CcDriver, "target">): boolean {
  return driver.target?.includes("linux-musl") ?? false;
}

/** The OS the produced binary runs on: the triple's OS under SCRIPTC_TARGET,
 * the host's otherwise — so platform-conditional link flags follow the
 * TARGET, not the machine running the compiler. Exported for compile()/
 * analyze(): the FRONTEND consults it too (path.sep / os.EOL literals and
 * the path-module binding follow the target — a win32 triple compiles
 * Node-on-Windows semantics, path.win32 backing the bare module). */
export function targetPlatform(driver: CcDriver): string {
  if (driver.target === null) return process.platform;
  if (driver.target.includes("wasi")) return "wasi";
  // iOS is a darwin-family target: Mach-O objects, ld64 localization,
  // POSIX path/EOL semantics. Android falls to the linux arm below —
  // bionic is a linux libc and its archives are ordinary ELF.
  if (isIosTarget(driver.target)) return "darwin";
  if (driver.target.includes("linux")) return "linux";
  if (driver.target.includes("windows")) return "win32";
  return driver.target.includes("macos") || driver.target.includes("darwin") ? "darwin" : "other";
}

/** Architecture identity for host-native cache entries. Explicit cross targets
 * already name their complete target triple; native builds need the process
 * architecture too because one per-user cache can serve both native and
 * emulated processes (arm64 and Rosetta on macOS, for example). */
export function cacheTargetIdentity(
  driver: Pick<CcDriver, "target">,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): string {
  return driver.target === null ? `native:${hostPlatform}:${hostArch}` : `cross:${driver.target}`;
}

function vendorEngineDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "quickjs-ng");
}

/** Vendor prerequisites follow the per-user build root when persistent cache
 * validation succeeds. Keeping generated objects out of node_modules makes
 * npm installations, read-only package stores, and explicit cache warming all
 * share one writable cache. The test-only override remains the first choice;
 * callers without a validated root retain the historical package-local
 * default (ordinary builds give those callers a private transient root). */
function vendorBuildCacheRoot(buildRoot?: string): string {
  const testRoot = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  if (testRoot !== undefined) return resolve(testRoot);
  return buildRoot === undefined
    ? join(runtimeSrcDir(), "..", "vendor", ".cache")
    : join(buildRoot, "vendor");
}

/** Cross targets already carry their architecture in the explicit triple.
 * Host-native prerequisites need the same separation: a checkout/package can
 * be used by both arm64 Node and Rosetta/x64 Node on macOS. */
export function vendorCacheTargetFlavor(
  driver: Pick<CcDriver, "target">,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): string {
  return driver.target === null ? `native-${hostPlatform}-${hostArch}` : driver.target;
}

/** Vendor prerequisites live outside the content-addressed build root, so
 * their directory name must carry the environment, resolved compiler, owned
 * source bytes, and build-recipe identity of the artifacts that consume them.
 * The short digest keeps the cache path readable while preventing build-order
 * and cross-installation contamination. */
export function vendorCacheBuildIdentity(
  environmentFingerprint: string,
  compilerIdentity: string,
  nativeSourceIdentity: string,
): string {
  return createHash("sha256")
    .update("vendor-toolchain-v2\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(compilerIdentity)
    .update("\0")
    .update(nativeSourceIdentity)
    .digest("hex")
    .slice(0, 20);
}

const vendorCompilerIdentityFallbacks = new Map<string, string>();

async function currentVendorCacheBuildIdentity(
  driver: Pick<CcDriver, "argv" | "target">,
  environmentFingerprint: string,
): Promise<string> {
  // Native vendor recipes additionally use bare clang/ar; cross
  // recipes use the zig driver for compilation and `zig ar`. Include every
  // executable that can affect the cached prerequisite, not just the
  // final program's driver.
  const commands = [
    driver.argv[0] ?? "clang",
    ...(driver.target === null ? ["clang", "ar"] : []),
  ].filter((command, index, all) => all.indexOf(command) === index);
  const identities = await Promise.all(
    commands.map(async (command) => {
      const spellingKey = `${environmentFingerprint}\0${command}`;
      const resolved = await resolvedToolIdentity(command);
      if (resolved !== null) vendorCompilerIdentityFallbacks.set(spellingKey, resolved);
      return [
        command,
        resolved ??
          vendorCompilerIdentityFallbacks.get(spellingKey) ??
          `<unresolved>\0${command}`,
      ].join("\0");
    }),
  );
  return vendorCacheBuildIdentity(
    environmentFingerprint,
    identities.join("\x1f"),
    await runtimeFingerprint(runtimeSrcDir()),
  );
}

function engineArchivePath(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): string {
  const flavor = `${sanitize ? "asan" : "plain"}-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  return join(cacheRoot, `${QJS_COMMIT.slice(0, 12)}-${flavor}`, "libqjs.a");
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** Vendor prerequisites are shared persistent cache entries, so they carry
 * the same adjacent content digest as runtime objects and complete artifacts.
 * Missing/invalid pairs are rebuilt. Do not remove them during validation: a
 * concurrent publisher installs data before its digest, and that temporary
 * invalid window must not let a reader unlink the publisher's data. */
async function validVendorArtifact(path: string): Promise<boolean> {
  return validCachedFile(path);
}

function protectCachedArtifact(paths: Set<string> | undefined, path: string): void {
  paths?.add(path);
  paths?.add(cacheDigestPath(path));
}

function privateSiblingPath(destination: string, label: string): string {
  // Keep the temporary component independent of the caller's basename. A
  // destination can validly consume the filesystem's entire NAME_MAX budget;
  // appending or prepending that basename would make the atomic install fail.
  return join(
    dirname(destination),
    `.scriptc-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
}

/** Copy an artifact through a private sibling name, then atomically install it.
 * The source can live on another filesystem (cache/temp roots commonly do), so
 * a direct rename is not portable. */
async function installArtifact(
  source: string,
  destination: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = privateSiblingPath(destination, "install");
  try {
    await copyFile(source, tmp);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Publish one finished vendor prerequisite from disposable build scratch.
 * The shared data and digest use the ordinary atomic cache publisher.
 * Concurrent builders produce equivalent bytes; on platforms where rename
 * cannot replace the winner, accept only a checksum-verified winner. */
async function publishVendorArtifact(source: string, destination: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await publishCachedFile(source, destination);
    } catch (error) {
      // A concurrent equivalent publisher may have won on a platform where
      // rename cannot replace an existing file. Accept only its verified pair.
      if (await validCachedFile(destination)) return;
      if (attempt > 0) throw error;
      // Otherwise the existing pair is genuinely stale/corrupt and blocked
      // replacement (notably on Windows). Remove it only after a complete
      // replacement is ready in private scratch, then retry once.
      await Promise.all([
        rm(destination, { force: true }).catch(() => undefined),
        rm(cacheDigestPath(destination), { force: true }).catch(() => undefined),
      ]);
      continue;
    }
    // Close publication races where another writer replaced only one member
    // of the pair between this publisher's two atomic renames.
    if (await validCachedFile(destination)) return;
  }
  throw new Error(`vendor cache publication failed integrity validation: ${destination}`);
}

/** Pin cache-backed vendor inputs under an invocation-private directory before
 * linking/archiving. The shared LRU may unlink their cache names at any time;
 * hard links (or copies where links are unavailable) keep active inputs alive.
 * A sweep can race the initial pin, so rematerialize and retry once. */
async function stageVendorInputs(
  materialize: () => Promise<string[]>,
  stageDir: string,
): Promise<string[]> {
  let lastError: unknown = new Error("vendor cache input disappeared while staging");
  for (let attempt = 0; attempt < 2; attempt++) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(stageDir, { recursive: true });
    const sources = await materialize();
    try {
      const now = new Date();
      return await Promise.all(sources.map(async (source) => {
        const destination = join(stageDir, basename(source));
        try {
          await link(source, destination);
        } catch {
          await copyFile(source, destination);
        }
        // Vendor prerequisites share the cache root's mtime-based LRU. A
        // successful stage is a cache read, so promote the shared source name
        // best-effort (it may have raced an eviction after the hard link).
        await utimes(source, now, now).catch(() => undefined);
        return destination;
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** The engine archive for one flavor, built lazily on the first --dynamic
 * compile and cached under <build-cache>/vendor/<commit>-<flavor>-<target>-<toolchain>/ — unlike
 * the runtime's own sources (recompiled every build, ~100ms), the engine is
 * far too big to rebuild per compile. The plain flavor is ALWAYS MinSizeRel
 * regardless of the program's optimization level: measured binary delta is
 * ~620KB vs ~900KB at -O2, and eval-in-an-island workloads don't earn the
 * difference. The asan flavor (Debug + QJS_ENABLE_ASAN) exists so the
 * sanitized test lane checks engine interop under instrumentation.
 *
 * Concurrency: parallel first builds (e.g. test workers) each build in a
 * private temp dir and publish with an atomic rename — first one wins,
 * losers discard their work and use the winner's archive.
 *
 * The qjs library target is just four TUs (QJS_ENGINE_SOURCES), so both host
 * and cross builds use the same direct per-TU recipe. This removes CMake from
 * the runtime dependency set and lets cache warming compile exactly the
 * archive a later program consumes. Host builds use clang + ar; cross builds
 * use the selected zig driver + zig ar. */
async function ensureEngineArchive(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): Promise<string> {
  const archive = engineArchivePath(sanitize, driver, buildIdentity, cacheRoot);
  const cacheDir = dirname(archive);
  if (await validVendorArtifact(archive)) return archive;
  return buildEngineArchiveDirect(sanitize, driver, cacheRoot, cacheDir);
}

/** The qjs library target's source list (CMakeLists.txt `qjs_sources` with
 * QJS_BUILD_LIBC off — cutils is header-only): the cross-build recipe
 * compiles exactly these. */
const QJS_ENGINE_SOURCES = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];

/** The engine archive for one target, per-TU compiler invocations plus ar.
 * The flags mirror what the former CMake
 * configurations apply to the qjs library target: gnu11 (CMAKE_C_EXTENSIONS
 * ON), hidden visibility, -funsigned-char, -DQUICKJS_NG_BUILD and
 * -D_GNU_SOURCE (qjs_defines; linux targetArgs already carry the latter),
 * then MinSizeRel (-Os -DNDEBUG) for plain or Debug+QJS_ENABLE_ASAN
 * (-O0 -ggdb -fno-omit-frame-pointer -fsanitize=address
 * -fno-sanitize-recover=all) for asan. Same atomic-rename publish as every
 * vendor cache. */
async function buildEngineArchiveDirect(sanitize: boolean, driver: CcDriver, cacheRoot: string, cacheDir: string): Promise<string> {
  const vendor = vendorEngineDir();
  const archive = join(cacheDir, "libqjs.a");
  const compileArgv = driver.target === null ? ["clang"] : driver.argv;
  const arArgv = driver.target === null ? ["ar"] : [...driver.argv.slice(0, 1), "ar"];
  const cflags = [
    "-std=gnu11",
    ...driver.targetArgs,
    "-fvisibility=hidden",
    "-funsigned-char",
    "-DQUICKJS_NG_BUILD",
    "-D_GNU_SOURCE",
    // CMake's qjs_defines on WIN32 (quickjs.c's own _WIN32 arms cover the
    // rest — timezoneapi, intrin, cutils.h's _msize usable-size probe).
    ...(targetPlatform(driver) === "win32" ? ["-DWIN32_LEAN_AND_MEAN", "-D_WIN32_WINNT=0x0601"] : []),
    ...(sanitize
      ? ["-O0", "-ggdb", "-fno-omit-frame-pointer", "-fsanitize=address", "-fno-sanitize-recover=all", "-DQJS_ENABLE_ASAN"]
      : ["-Os", "-DNDEBUG"]),
    "-I", vendor,
  ];
  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(tmpdir(), `scriptc-vendor-qjs-${driver.target ?? "host"}-`));
  try {
    const width = Math.min(QJS_ENGINE_SOURCES.length, availableParallelism());
    for (let i = 0; i < QJS_ENGINE_SOURCES.length; i += width) {
      await Promise.all(
        QJS_ENGINE_SOURCES.slice(i, i + width).map((src) =>
          execFileAsync(
            compileArgv[0] ?? "clang",
            [...compileArgv.slice(1), ...cflags, "-c", join(vendor, src), "-o", join(buildDir, `${basename(src, ".c")}.o`)],
            { cwd: buildDir },
          ),
        ),
      );
    }
    await execFileAsync(arArgv[0] ?? "ar", [...arArgv.slice(1), "rcs", join(buildDir, "libqjs.a"), ...QJS_ENGINE_SOURCES.map((s) => join(buildDir, `${basename(s, ".c")}.o`))]);
    await publishVendorArtifact(join(buildDir, "libqjs.a"), archive);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return archive;
}

/** The vendor sources behind static-build regex support: quickjs-ng's
 * libregexp and its unicode tables (cutils is header-only). Deliberately
 * NOT the engine — a regex-using static binary links ~110KB of matcher,
 * never the ~620KB island. */
const LRE_SOURCES = ["libregexp.c", "libunicode.c"];

function lreObjectPaths(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): string[] {
  const flavor =
    (sanitize ? "asan" : "plain") +
    (driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc") +
    `-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  const cacheDir = join(cacheRoot, `${QJS_COMMIT.slice(0, 12)}-lre-${flavor}`);
  return LRE_SOURCES.map((f) => join(cacheDir, f.replace(/\.c$/, ".o")));
}

/** The libregexp objects for one flavor, compiled lazily on the first
 * regex-using static build (~1s) and cached like the engine archive —
 * <build-cache>/vendor/<commit>-lre-<flavor>-<target>-<toolchain>/*.o — with the same atomic-rename
 * publish (parallel first builds race safely; losers discard their work).
 * Plain is -Os (size class matters: the regex fence pins regex-using
 * binaries well under the engine class); asan matches the final link so
 * the sanitized lane instruments the matcher too. Cross targets get their
 * own flavor directory, compiled with the SCRIPTC_CC driver and its target
 * args — libregexp/libunicode are plain C11, so the cross story is exactly
 * the runtime sources' (no host-built inputs); vendored SOURCES are
 * untouched, only the build wiring knows about targets. */
async function ensureLreObjects(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): Promise<string[]> {
  // The flavor keys the DRIVER as well as the target: a zig-cc-built object
  // set must never be handed to a clang link (or vice versa) off a shared
  // cache directory. Native targets include host platform + architecture so
  // arm64 and Rosetta processes never exchange Mach-O objects.
  const flavor =
    (sanitize ? "asan" : "plain") +
    (driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc") +
    `-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  const vendor = vendorEngineDir();
  const objects = lreObjectPaths(sanitize, driver, buildIdentity, cacheRoot);
  if ((await Promise.all(objects.map(validVendorArtifact))).every(Boolean)) return objects;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(tmpdir(), `scriptc-vendor-lre-${flavor}-`));
  try {
    // One -c per invocation: zig's COFF driver rejects multiple -c inputs
    // in a single command ("coff does not support linking multiple
    // objects"); per-file compiles produce the identical objects on every
    // target.
    for (const f of LRE_SOURCES) {
      await execFileAsync(
        driver.argv[0] ?? "clang",
        [
          ...driver.argv.slice(1),
          "-std=c11",
          ...driver.targetArgs,
          ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-Os"]),
          "-I", vendor,
          "-c", join(vendor, f),
          "-o", join(buildDir, f.replace(/\.c$/, ".o")),
        ],
        { cwd: buildDir },
      );
    }
    await Promise.all(objects.map((destination) =>
      publishVendorArtifact(join(buildDir, basename(destination)), destination)
    ));
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return objects;
}

function vendorZlibDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "zlib");
}

/** The vendored zlib TUs behind CROSS-target zlib support: every root *.c
 * except the gzFile file-I/O units (gz*.c — nothing in scr_zlib.c
 * references the gzFile API, and those TUs alone want unistd/io headers).
 * Host builds never touch this list — they link the system libz. */
const ZLIB_SOURCES = ["adler32.c", "compress.c", "crc32.c", "deflate.c", "infback.c", "inffast.c", "inflate.c", "inftrees.c", "trees.c", "uncompr.c", "zutil.c"];

function zlibObjectPaths(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): string[] {
  const flavor =
    (sanitize ? "asan" : "plain") +
    (driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc") +
    `-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  const cacheDir = join(cacheRoot, `zlib-${ZLIB_VERSION}-${flavor}`);
  return ZLIB_SOURCES.map((f) => join(cacheDir, f.replace(/\.c$/, ".o")));
}

/** The zlib objects for one flavor, compiled lazily on the first zlib-using
 * CROSS build (~1s) and cached like the lre objects —
 * <build-cache>/vendor/zlib-<version>-<flavor>-<target>-<toolchain>/*.o — with the same atomic-rename
 * publish (parallel first builds race safely; losers discard their work).
 * Plain is -Os, asan matches the final link so the sanitized lane
 * instruments the codec too. The flavor keys the driver and target exactly
 * like the lre flavor: only cross builds call this today, but the keying
 * must never hand a zig-built object set to a clang link off a shared
 * directory. */
async function ensureZlibObjects(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): Promise<string[]> {
  const flavor =
    (sanitize ? "asan" : "plain") +
    (driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc") +
    `-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  const vendor = vendorZlibDir();
  const objects = zlibObjectPaths(sanitize, driver, buildIdentity, cacheRoot);
  if ((await Promise.all(objects.map(validVendorArtifact))).every(Boolean)) return objects;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(tmpdir(), `scriptc-vendor-zlib-${flavor}-`));
  try {
    // One -c per invocation, the lre recipe (zig's COFF driver rejects
    // multiple -c inputs in a single command).
    for (const f of ZLIB_SOURCES) {
      await execFileAsync(
        driver.argv[0] ?? "clang",
        [
          ...driver.argv.slice(1),
          "-std=c11",
          ...driver.targetArgs,
          ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-Os"]),
          "-I", vendor,
          "-c", join(vendor, f),
          "-o", join(buildDir, f.replace(/\.c$/, ".o")),
        ],
        { cwd: buildDir },
      );
    }
    await Promise.all(objects.map((destination) =>
      publishVendorArtifact(join(buildDir, basename(destination)), destination)
    ));
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return objects;
}

function vendorCurlDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "curl");
}

/** Every libcurl function scr_fetch_curl.c references — the generated import
 * stub defines exactly these. A new curl call in scr_fetch_curl.c that is
 * missing here fails the CROSS link immediately with the symbol's name
 * (host builds resolve it from the real system libcurl and never look). */
const CURL_STUB_SYMBOLS = [
  "curl_easy_cleanup", "curl_easy_getinfo", "curl_easy_init", "curl_easy_setopt", "curl_easy_strerror",
  "curl_free", "curl_global_cleanup", "curl_global_init",
  "curl_multi_add_handle", "curl_multi_cleanup", "curl_multi_info_read", "curl_multi_init",
  "curl_multi_perform", "curl_multi_poll", "curl_multi_remove_handle",
  "curl_slist_append", "curl_slist_free_all",
  "curl_url", "curl_url_cleanup", "curl_url_get", "curl_url_set",
];

function curlStubDirPath(
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): string {
  return join(cacheRoot, `curl-stub-${driver.target}-${buildIdentity}`);
}

/** The libcurl import stub for one CROSS target, generated lazily on the
 * first fetch-using cross build and cached like the zlib objects —
 * <build-cache>/vendor/curl-stub-<target>-<toolchain>/libcurl.so, atomic-rename publish. The
 * stub is empty definitions of CURL_STUB_SYMBOLS compiled `-shared` with
 * `-soname libcurl.so.4`: linking against it satisfies scr_fetch_curl.c's
 * references and records a plain `DT_NEEDED libcurl.so.4`, which the
 * TARGET system's real libcurl satisfies at load time (curl's unversioned
 * exports make the classic import-stub technique sound here — nothing
 * from the stub's bodies ever ships in the binary). One stub per target,
 * no sanitize flavor: the stub's code is never executed or instrumented,
 * and asan links against plain shared libraries freely. */
async function ensureCurlStub(
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): Promise<string> {
  const cacheDir = curlStubDirPath(driver, buildIdentity, cacheRoot);
  const lib = join(cacheDir, "libcurl.so");
  if (await validVendorArtifact(lib)) return cacheDir;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(tmpdir(), "scriptc-vendor-curl-stub-"));
  try {
    const src = join(buildDir, "stub.c");
    await writeFile(src, CURL_STUB_SYMBOLS.map((s) => `void ${s}(void) {}\n`).join(""));
    await execFileAsync(driver.argv[0] ?? "clang", [
      ...driver.argv.slice(1),
      ...driver.targetArgs,
      "-shared", "-fPIC",
      "-Wl,-soname,libcurl.so.4",
      src,
      "-o", join(buildDir, "libcurl.so"),
    ]);
    await publishVendorArtifact(join(buildDir, "libcurl.so"), lib);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return cacheDir;
}

function vendorTlsDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "mbedtls");
}

function tlsArchivePath(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): string {
  const flavor = `${sanitize ? "asan" : "plain"}-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  return join(cacheRoot, `mbedtls-${MBEDTLS_VERSION}-${flavor}`, "libmbedtls.a");
}

/** The mbedTLS archive for one flavor, compiled lazily on the first
 * TLS-using build (~15s over ~110 TUs, parallelized) and cached like the
 * engine archive — <build-cache>/vendor/mbedtls-<version>-<flavor>-<target>-<toolchain>/libmbedtls.a —
 * with the same atomic-rename publish (parallel first builds race safely;
 * losers discard their work). Plain is -Os (the TLS stack is link-gated
 * but still wants its size class small); asan matches the final link so
 * the sanitized lane instruments every TLS path too. No CMake: the stock
 * config builds every library/*.c standalone with clang, so the recipe is
 * per-TU `-c` compiles plus one `ar rcs` — vendored-build machinery the
 * lre-objects cache already established.
 *
 * SCRIPTC_TARGET adds a per-target cache flavor (the lre-objects story):
 * TUs compile with `zig cc -target <triple>` and the archive is packed
 * with `zig ar` (llvm-ar — the host BSD ar has no business indexing ELF
 * objects). Host builds keep the exact historical clang + ar recipe. */
async function ensureTlsArchive(
  sanitize: boolean,
  driver: CcDriver,
  buildIdentity: string,
  cacheRoot: string = vendorBuildCacheRoot(),
): Promise<string> {
  const flavor = `${sanitize ? "asan" : "plain"}-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
  const compileArgv = driver.target !== null ? driver.argv : ["clang"];
  const arArgv = driver.target !== null ? [...driver.argv.slice(0, 1), "ar"] : ["ar"];
  const vendor = vendorTlsDir();
  const archive = tlsArchivePath(sanitize, driver, buildIdentity, cacheRoot);
  if (await validVendorArtifact(archive)) return archive;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(tmpdir(), `scriptc-vendor-mbedtls-${flavor}-`));
  try {
    const sources = (await readdir(join(vendor, "library")))
      .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
      .sort();
    const cflags = [
      "-std=c11",
      ...driver.targetArgs,
      ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-Os"]),
      "-I", join(vendor, "include"),
      "-I", join(vendor, "library"),
    ];
    const width = availableParallelism();
    for (let i = 0; i < sources.length; i += width) {
      await Promise.all(
        sources.slice(i, i + width).map((src) =>
          execFileAsync(
            compileArgv[0] ?? "clang",
            [...compileArgv.slice(1), ...cflags, "-c", join(vendor, "library", src), "-o", join(buildDir, `${basename(src, ".c")}.o`)],
          ),
        ),
      );
    }
    await execFileAsync(arArgv[0] ?? "ar", [...arArgv.slice(1), "rcs", join(buildDir, "libmbedtls.a"), ...sources.map((s) => join(buildDir, `${basename(s, ".c")}.o`))]);
    await publishVendorArtifact(join(buildDir, "libmbedtls.a"), archive);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return archive;
}

/* ── library mode: the static-archive artifact ────────────────────────────
 * One `scriptc build --lib` invocation produces <name>.lib.a: the program TU
 * object plus exactly the runtime objects the program's IR gates in, every
 * TU compiled with -DSCR_LIB (the per-flavor discipline that keeps library
 * objects apart from executable-lane objects). Persistent builds cache the
 * completed archive by program-TU content and cache runtime objects separately,
 * so an edit recompiles only the changed program object before re-archiving.
 * Large LLVM dev TUs split further into stable symbol-hash shards: compile
 * those in parallel, cache each object independently, then relocatably merge
 * them back into the archive's one canonical program member. A localized edit
 * recompiles only the changed buckets; exact repeats use the merged-object or
 * completed-archive tiers and never repeat the merge.
 * The base set narrows from the executable lane's unconditional sources:
 * scr_async.c (fibers, timers, the loop) and scr_child.c drop — the
 * async_free refusal already guarantees nothing references them — and
 * scr_library.c (sink, arena, reset registry, library funnel) joins. The gated
 * units a library may reach are the pure-data ones (regex + the vendored matcher, assert,
 * inspect, symbol, searchParams, emitter+dyn_handle, zlib); every
 * loop-hooked or ambient unit was refused at SC4005 before emission.
 * External-symbol contract: undefined references only to the target's C/math
 * runtime and system APIs. Windows embedders additionally link advapi32,
 * iphlpapi, and ws2_32; the platform driver supplies its ordinary CRT and
 * kernel imports. Zlib rides the VENDORED per-flavor objects here even on
 * hosts because the executable lane's system `-lz` cannot ride inside an
 * archive. */

/** The library base: the executable lane's unconditional sources minus the
 * fiber/loop and child-process units, plus the library-mode TU. */
const LIB_RUNTIME_SOURCES = [
  ...RUNTIME_SOURCES.filter(
    (f) => f !== "scr_async.c" && f !== "scr_child.c" && f !== "scr_ffi.c",
  ),
  "scr_library.c",
];

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
  /** Tiny generated C source carrying volatile library identity getters.
   * Its bytes join the complete archive key, but the source itself exists
   * only in the invocation-private build directory and the large program-
   * object cache is keyed independently. */
  identityCSource?: string;
  /** The archive to produce (<name>.lib.a). */
  outPath: string;
  /** Caller-owned identity for the generated TU's complete non-system
   * dependency graph. Omission bypasses persistent artifact/object caching,
   * matching compileC's arbitrary-input safety boundary. */
  cacheIdentity?: string;
  sanitize?: boolean;
  /** Native optimization posture: release = -O2, dev = -O0. */
  optimization?: "release" | "dev";
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
  regex?: boolean;
  assert?: boolean;
  inspect?: boolean;
  symbol?: boolean;
  searchParams?: boolean;
  emitter?: boolean;
  zlib?: boolean;
  copying?: boolean;
  textDecoderLegacy?: boolean;
}

function updateProgramShardCacheIdentity(
  hash: ReturnType<typeof createHash>,
  shards: readonly { name: string; source: string }[] | undefined,
  publicSymbols: readonly string[] | undefined,
  mergeIdentity: string | undefined,
): void {
  hash.update("\0program-shards\0");
  if (shards === undefined) {
    hash.update("<none>\0");
  } else {
    hash.update("<present>\0");
    for (const shard of shards) {
      hash.update(shard.name).update("\0").update(shard.source).update("\0");
    }
  }
  hash.update("\0program-public-symbols\0");
  if (publicSymbols === undefined) {
    hash.update("<none>\0");
  } else {
    hash.update("<present>\0");
    for (const symbol of publicSymbols) hash.update(symbol).update("\0");
  }
  hash.update("\0program-shard-merge\0");
  hash.update(mergeIdentity === undefined ? "<none>\0" : `<present>\0${mergeIdentity}\0`);
}

/** Identity of the machinery that turns LLVM shard objects back into the
 * canonical program member, or null when the target cannot do so. Sharding is
 * only a build optimization: a missing host tool or unsupported object class
 * retains the ordinary single-TU compile. The identity joins every cache tier
 * that contains merged bytes; raw shard-object keys deliberately omit it. */
async function resolveProgramShardMergeIdentity(driver: CcDriver): Promise<string | null> {
  const platform = targetPlatform(driver);
  // Mach-O merging uses the host's ld64. A Darwin target produced from a
  // non-Darwin host can still compile as one canonical Zig TU, but the host's
  // ELF/COFF linker cannot combine those objects.
  if (platform === "darwin") {
    if (process.platform !== "darwin") return null;
    const ld = await resolvedTool("ld");
    return ld === null
      ? null
      : rememberFingerprintDependencies(
          `program-shard-merge-darwin-v1\0${ld.cacheIdentity}`,
          [ld.canonicalPath],
        );
  }
  if (platform === "linux") {
    if (driver.target === null) {
      const [ld, objcopy] = await Promise.all([
        resolvedTool("ld"),
        resolvedTool("objcopy"),
      ]);
      return ld === null || objcopy === null
        ? null
        : rememberFingerprintDependencies(
            `program-shard-merge-linux-v1\0${ld.cacheIdentity}\0${objcopy.cacheIdentity}`,
            [ld.canonicalPath, objcopy.canonicalPath],
          );
    }
    const arch = driver.target.split("-", 1)[0];
    if (arch !== "x86_64" && arch !== "aarch64") return null;
    const compiler = await resolvedTool(driver.argv[0] ?? "zig");
    return compiler === null
      ? null
      : rememberFingerprintDependencies(
          `program-shard-merge-cross-elf-v1\0${arch}\0${compiler.cacheIdentity}`,
          [compiler.canonicalPath],
        );
  }
  if (platform === "win32") {
    const arch = driver.target?.split("-", 1)[0] ?? process.arch;
    return arch === "x86_64" || arch === "x64"
      ? `program-shard-merge-coff-v1\0${arch}`
      : null;
  }
  return null;
}

export async function compileLibArchive(opts: LibArchiveOptions): Promise<void> {
  const rtDir = runtimeSrcDir();
  const driver = resolveCc();
  const shardNames = new Set<string>();
  const programShardsValid = opts.programShards?.every((shard) => {
    if (
      basename(shard.name) !== shard.name || !shard.name.endsWith(".ll") ||
      shardNames.has(shard.name)
    ) return false;
    shardNames.add(shard.name);
    return true;
  }) === true;
  const programShardsRequested =
    opts.cPath.endsWith(".ll") &&
    programShardsValid && opts.programShards !== undefined && opts.programShards.length > 1 &&
    opts.programPublicSymbols !== undefined
      ? opts.programShards
      : null;
  const programShardMergeIdentity = programShardsRequested === null
    ? null
    : await resolveProgramShardMergeIdentity(driver);
  const programShards = programShardMergeIdentity === null ? null : programShardsRequested;
  const programPublicSymbols = programShards === null ? undefined : opts.programPublicSymbols;
  const sanitize = opts.sanitize ?? false;
  const optimization = opts.optimization ?? "release";
  const regex = opts.regex ?? false;
  const sources = [
    ...LIB_RUNTIME_SOURCES,
    // win32 targets compile the libc-shim TU into the archive (stpcpy,
    // arc4random_buf — scr_number.c/scr_lib.c/scr_bytes_io.c call them and
    // mingw's CRT has neither), exactly like compileC's unconditional win32
    // arm. The system-DLL imports the shim and scr_lib.c reference
    // (advapi32's CSPRNG/GetUserNameA, iphlpapi's GetAdaptersAddresses,
    // ws2_32's inet_ntop/htonl) stay the EMBEDDER's link line — an archive
    // carries no -l flags. Never present off win32, so host archives
    // cannot change by a byte.
    ...(targetPlatform(driver) === "win32" ? ["scr_win.c"] : []),
    // Zig's musl sysroot does not provide arc4random_buf. Keep the fallback
    // inside the archive so library embedders need no extra system library.
    ...(isMuslTarget(driver) ? ["scr_musl.c"] : []),
    ...(regex ? ["scr_regex.c"] : []),
    ...(opts.assert || regex || opts.symbol ? ["scr_assert.c"] : []),
    ...(opts.inspect ? ["scr_inspect.c"] : []),
    ...(opts.symbol ? ["scr_symbol.c"] : []),
    ...(opts.searchParams ? ["scr_url_params.c"] : []),
    ...(opts.emitter ? ["scr_events_emitter.c", "scr_dyn_handle.c"] : []),
    ...(opts.zlib ? ["scr_zlib.c"] : []),
    ...(opts.copying ? ["scr_copying.c"] : []),
  ];
  const cflags = [
    "-std=c11",
    ...driver.targetArgs,
    ...(sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : [optimization === "dev" ? "-O0" : "-O2"]),
    "-fno-math-errno",
    "-fno-strict-aliasing", // the emitted object model type-puns — see compileC's buildArgs
    "-Wno-deprecated-declarations",
    "-DSCR_LIB",
    ...(opts.threadInstances ? ["-DSCR_THREAD_INSTANCES"] : []),
    ...(opts.textDecoderLegacy ? ["-DSCR_TEXT_DECODER_LEGACY"] : []),
    "-I", rtDir,
    ...(regex ? ["-I", vendorEngineDir()] : []),
    ...(opts.zlib ? ["-I", vendorZlibDir()] : []),
  ];
  const programCompilerArgs = opts.cPath.endsWith(".ll")
    ? [...cflags, "-Wno-override-module"]
    : cflags;
  const programSourceExtension = opts.cPath.endsWith(".ll") ? ".ll" : ".c";
  const arArgv = driver.argv[0] === "zig" ? [driver.argv[0]!, "ar"] : ["ar"];
  const cachePolicy = toolchainEnvironmentCachePolicy();
  const configuredCacheRoot = cacheRootDir();
  const toolchainEnv = toolchainEnvironmentFingerprint();
  const persistentDriverCache =
    cachePolicy.runtimeObjects &&
    configuredCacheRoot !== null &&
    await compilerDriverSupportsPersistentCache(driver, toolchainEnv);
  // A library archive is compile-only from clang's perspective. Link-only
  // search variables cannot affect it, but any mutable compilation input or
  // opaque compiler wrapper makes every persistent tier unsafe to reuse. An
  // opaque archiver narrows only the completed-archive tier below.
  let root =
    opts.cacheIdentity === undefined || !persistentDriverCache
      ? null
      : configuredCacheRoot;
  if (root !== null) {
    try {
      await ensurePrivateCacheRoot(
        root,
        process.env["SCRIPTC_CACHE_DIR"] === undefined,
      );
    } catch {
      root = null;
    }
  }
  let implicitToolchain: string | null = null;
  let implicitCompileToolchain: string | null = null;
  let runtimeCompilerInvocation: string | null = null;
  let programCompilerInvocation: string | null = null;
  if (persistentDriverCache) {
    try {
      const fingerprints = await implicitToolchainFingerprints(driver, toolchainEnv);
      implicitToolchain = fingerprints.complete;
      implicitCompileToolchain = fingerprints.compile;
    } catch {
      // An identity probe is cache machinery, never a reason a valid native
      // compile should fail. Disable every persistent tier for this invocation.
      root = null;
    }
  }
  if (root !== null) {
    try {
      runtimeCompilerInvocation = await effectiveCompilerInvocationFingerprint(
        driver,
        toolchainEnv,
        cflags,
      );
      programCompilerInvocation = programSourceExtension === ".ll"
        ? await effectiveCompilerInvocationFingerprint(
            driver,
            toolchainEnv,
            programCompilerArgs,
            programSourceExtension,
          )
        : runtimeCompilerInvocation;
    } catch {
      // A wrapper that cannot expose its effective invocation can still build,
      // but its outputs cannot safely participate in a persistent cache.
      root = null;
    }
  }
  const vendorBuildIdentity = await currentVendorCacheBuildIdentity(
    driver,
    `${toolchainEnv}\0${implicitToolchain ?? "<uncached>"}`,
  );
  // Runtime-localized archives skip the completed-archive tier: their bytes
  // additionally depend on the localization toolchain's identity (host ld/
  // objcopy or the cross driver's lld), which the archive key does not
  // fingerprint. The runtime-object tier still serves them (localization
  // consumes the same per-flavor objects).
  const cacheCompleteArchive =
    opts.localizeSymbols === undefined &&
    root !== null && await archiverSupportsPersistentCache(arArgv, driver);
  let cachedArchive: string | null = null;
  let compilerVersion = "";
  let archiverVersion = "";
  let runtimeHash = "";
  let programDependencyHash = "";
  let cachedProgramBytes = opts.programSource === undefined
    ? null
    : Buffer.from(opts.programSource, "utf8");
  const identityBytes = opts.identityCSource === undefined
    ? null
    : Buffer.from(opts.identityCSource, "utf8");
  if (root !== null) {
    try {
      const [cv, fingerprint, programBytes] = await Promise.all([
        ccVersionOnce(driver.argv, toolchainEnv, true),
        runtimeFingerprint(rtDir),
        cachedProgramBytes === null ? readFile(opts.cPath) : Promise.resolve(cachedProgramBytes),
      ]);
      compilerVersion = cv;
      runtimeHash = fingerprint;
      cachedProgramBytes = programBytes;
      programDependencyHash = await translationUnitDependencyFingerprint(
        driver,
        cflags,
        opts.cPath,
        programBytes,
        toolchainEnv,
      );
      if (cacheCompleteArchive) {
        const av = await toolVersionOnce(arArgv, toolchainEnv, true);
        archiverVersion = av;
        const key = createHash("sha256")
          // v10 adds the shard-merge implementation/tool identity. The
          // canonical TU still keys source semantics; shard, keep, and merge
          // bytes key the exact merged program object so ABI projections,
          // tool replacements, and single-/multi-TU producers never collide.
          .update("lib-v10\0")
          .update(cacheTargetIdentity(driver)).update("\0")
          .update(toolchainEnv).update("\0")
          .update(implicitToolchain!).update("\0")
          .update(runtimeCompilerInvocation!).update("\0")
          .update(programCompilerInvocation!).update("\0")
          .update(programDependencyHash).update("\0")
          .update(opts.cacheIdentity!).update("\0")
          .update(driver.argv.join("\x1f")).update("\0")
          .update(cv).update("\0")
          .update(fingerprint).update("\0")
          .update(arArgv.join("\x1f")).update("\0")
          .update(av).update("\0")
          .update(cflags.join("\x1f")).update("\0")
          .update(sources.join("\x1f")).update("\0")
          // The compiler-visible spelling and resolved location are both inputs:
          // __FILE__ observes the former, while relative includes follow the
          // latter. Archive members also inherit the TU's basename.
          .update(opts.cPath).update("\0")
          .update(resolve(opts.cPath)).update("\0")
          .update(programBytes);
        updateProgramShardCacheIdentity(
          key,
          programShards ?? undefined,
          programPublicSymbols,
          programShardMergeIdentity ?? undefined,
        );
        const keyHex = key
          .update("\0identity\0")
          .update(identityBytes === null ? "<none>" : "<generated>").update("\0")
          .update(identityBytes ?? Buffer.alloc(0))
          .digest("hex");
        cachedArchive = join(root, "lib", keyHex);
        const tmpOut = privateSiblingPath(opts.outPath, "lib-hit");
        try {
          await mkdir(dirname(opts.outPath), { recursive: true });
          if (!(await copyValidCachedFile(cachedArchive, tmpOut))) {
            throw new Error("invalid cached library archive");
          }
          // Match a fresh `ar` output under the caller's current umask. Cache
          // entries may have been populated by a less restrictive shell.
          await chmod(tmpOut, 0o666 & ~process.umask());
          await rename(tmpOut, opts.outPath);
          return;
        } catch {
          await rm(tmpOut, { force: true }).catch(() => undefined);
          // Miss (or unreadable cache): compile below and publish best-effort.
        }
      }
    } catch {
      // Cache identity trouble is never a build failure. The fresh path below
      // retains the historical compile-everything behavior.
      cachedArchive = null;
    }
  }

  const transientVendorRoot = root !== null && implicitToolchain !== null
    ? null
    : join(
        tmpdir(),
        `scriptc-lib-vendor-${process.pid}-${Math.random().toString(36).slice(2)}`,
      );
  const vendorCacheRoot = transientVendorRoot ?? vendorBuildCacheRoot(root ?? undefined);
  try {
    const buildDir = await mkdtemp(join(tmpdir(), "scriptc-lib-"));
    try {
      const lreObjects = regex
        ? await stageVendorInputs(
            () => ensureLreObjects(sanitize, driver, vendorBuildIdentity, vendorCacheRoot),
            join(buildDir, "vendor-lre"),
          )
        : [];
      const zlibObjects = opts.zlib
        ? await stageVendorInputs(
            () => ensureZlibObjects(sanitize, driver, vendorBuildIdentity, vendorCacheRoot),
            join(buildDir, "vendor-zlib"),
          )
        : [];
      const compileOne = async (
        src: string,
        objName: string,
        compilerVisibleSource?: string,
      ): Promise<string> => {
        const obj = join(buildDir, objName);
        const args = [
          ...driver.argv.slice(1),
          ...cflags,
          ...(compilerVisibleSource !== undefined
            ? [
                `-ffile-prefix-map=${src}=${compilerVisibleSource}`,
                "-iquote",
                dirname(resolve(compilerVisibleSource)),
              ]
            : []),
          ...(src.endsWith(".ll") ? ["-Wno-override-module"] : []),
          "-c", src,
          "-o", obj,
        ];
        try {
          await execFileAsync(driver.argv[0] ?? "clang", args);
        } catch (err) {
          const stderr = subprocessFailureDetail(err);
          throw new Error(
            `${driver.argv.join(" ")} failed compiling ${src} for the library archive.\n` +
              `This is a scriptc bug (generated/runtime C should always compile) unless the compiler itself is missing/broken.\n\n${stderr}`,
          );
        }
        return obj;
      };
      const stem = basename(opts.cPath).replace(/\.(c|ll)$/, "");
      const programSource =
        cachedProgramBytes === null
          ? opts.cPath
          : join(buildDir, `program${opts.cPath.endsWith(".ll") ? ".ll" : ".c"}`);
      if (cachedProgramBytes !== null && programShards === null) {
        await writeFile(programSource, cachedProgramBytes);
      }
      let cachedProgramObject: string | null = null;
      if (
        root !== null && cachedProgramBytes !== null && compilerVersion !== "" &&
        implicitToolchain !== null && programCompilerInvocation !== null
      ) {
        const programKey = createHash("sha256")
          .update("lib-program-obj-v3\0")
          .update(cacheTargetIdentity(driver)).update("\0")
          .update(toolchainEnv).update("\0")
          .update(implicitToolchain).update("\0")
          .update(programCompilerInvocation).update("\0")
          .update(opts.cacheIdentity!).update("\0")
          .update(driver.argv.join("\x1f")).update("\0")
          .update(compilerVersion).update("\0")
          .update(runtimeHash).update("\0")
          .update(programDependencyHash).update("\0")
          .update(programCompilerArgs.join("\x1f")).update("\0")
          .update(opts.cPath).update("\0")
          .update(resolve(opts.cPath)).update("\0")
          .update(cachedProgramBytes);
        updateProgramShardCacheIdentity(
          programKey,
          programShards ?? undefined,
          programPublicSymbols,
          programShardMergeIdentity ?? undefined,
        );
        const programKeyHex = programKey.digest("hex");
        cachedProgramObject = join(root, "program-obj", programKeyHex);
      }
      const stagedProgramObject = join(buildDir, `${stem}.program.o`);
      let programObject: string;
      let programShardFallback = false;
      if (
        cachedProgramObject !== null &&
        await copyValidCachedFile(cachedProgramObject, stagedProgramObject)
      ) {
        programObject = stagedProgramObject;
      } else if (programShards !== null) {
        try {
          const shardEntries = programShards.map((shard, index) => {
            const sourcePath = join(buildDir, shard.name);
            const staged = join(buildDir, `${stem}.program-${index.toString().padStart(3, "0")}.o`);
            let cachePath: string | null = null;
            if (
              root !== null && compilerVersion !== "" && implicitCompileToolchain !== null &&
              programCompilerInvocation !== null
            ) {
              const key = createHash("sha256")
                // v2 removes the broad implicit-toolchain fingerprint: it
                // includes the linker selected by the driver, but raw shard
                // objects are compile-only outputs. The compile-only toolchain
                // identity retains compiler/config/header/assembler inputs;
                // the effective program invocation pins this exact flag lane.
                // Merge-tool identity belongs only to the merged-object and
                // completed-archive tiers.
                .update("lib-program-shard-v2\0")
                .update(cacheTargetIdentity(driver)).update("\0")
                .update(toolchainEnv).update("\0")
                .update(implicitCompileToolchain).update("\0")
                .update(programCompilerInvocation).update("\0")
                .update(opts.cacheIdentity!).update("\0")
                .update(driver.argv.join("\x1f")).update("\0")
                .update(compilerVersion).update("\0")
                .update(runtimeHash).update("\0")
                .update(programDependencyHash).update("\0")
                .update(programCompilerArgs.join("\x1f")).update("\0")
                .update(opts.cPath).update("\0")
                .update(resolve(opts.cPath)).update("\0")
                .update(shard.name).update("\0")
                .update(shard.source)
                .digest("hex");
              cachePath = join(root, "program-shard", key);
            }
            return { ...shard, sourcePath, staged, cachePath, missed: false };
          });
          const shardWidth = Math.min(8, availableParallelism());
          for (let i = 0; i < shardEntries.length; i += shardWidth) {
            await Promise.all(shardEntries.slice(i, i + shardWidth).map(async (entry) => {
              await writeFile(entry.sourcePath, entry.source);
              if (
                entry.cachePath !== null &&
                await copyValidCachedFile(entry.cachePath, entry.staged)
              ) return;
              entry.missed = true;
              await compileOne(entry.sourcePath, basename(entry.staged), opts.cPath);
            }));
          }
          const publishable = shardEntries.filter(
            (entry) => entry.missed && entry.cachePath !== null,
          );
          const mergedProgramObject = await localizeLibraryObjects(
            driver,
            arArgv,
            buildDir,
            shardEntries.map((entry) => entry.staged),
            [],
            programPublicSymbols!,
            `${stem}.program`,
          );
          // Keep the canonical archive member spelling. The fact that native
          // compilation used shards is an implementation detail; consumers and
          // deterministic cache tests continue to see `<stem>.program.o`.
          await rename(mergedProgramObject, stagedProgramObject);
          programObject = stagedProgramObject;
          if (cachedProgramObject !== null || publishable.length > 0) {
            try {
              const [currentRuntime, currentInvocation, currentDependencies, currentCompiler] =
                await Promise.all([
                  runtimeFingerprint(rtDir),
                  effectiveCompilerInvocationFingerprint(
                    driver,
                    toolchainEnv,
                    programCompilerArgs,
                    programSourceExtension,
                  ),
                  translationUnitDependencyFingerprint(
                    driver,
                    cflags,
                    opts.cPath,
                    cachedProgramBytes!,
                    toolchainEnv,
                  ),
                  ccVersionOnce(driver.argv, toolchainEnv, true),
                ]);
              const shardInputsStillMatch =
                currentRuntime === runtimeHash &&
                currentInvocation === programCompilerInvocation &&
                currentDependencies === programDependencyHash && currentCompiler === compilerVersion;
              const currentFingerprints = shardInputsStillMatch
                ? await implicitToolchainFingerprints(driver, toolchainEnv)
                : null;
              const compileInputsStillMatch =
                shardInputsStillMatch &&
                currentFingerprints?.compile === implicitCompileToolchain;
              let mergedInputsStillMatch = false;
              if (compileInputsStillMatch && cachedProgramObject !== null) {
                const currentMerge = await resolveProgramShardMergeIdentity(driver).catch(() => null);
                mergedInputsStillMatch =
                  currentFingerprints?.complete === implicitToolchain &&
                  currentMerge === programShardMergeIdentity;
              }
              if (compileInputsStillMatch) {
                await Promise.all([
                  ...(mergedInputsStillMatch
                    ? [publishCachedFile(programObject, cachedProgramObject!)]
                    : []),
                  ...publishable.map((entry) => publishCachedFile(entry.staged, entry.cachePath!)),
                ]);
              }
            } catch {
              // Best-effort: the merged program object is already valid.
            }
          }
        } catch {
          // Sharding is only an optimization. A present but incompatible or
          // failing merge tool (or a shard-only compiler failure) must not
          // turn a valid canonical LLVM TU into a failed library build. Do not
          // publish this retry under shard-derived object/archive cache keys.
          programShardFallback = true;
          if (cachedProgramBytes !== null) await writeFile(programSource, cachedProgramBytes);
          programObject = await compileOne(
            programSource,
            `${stem}.program.o`,
            cachedProgramBytes === null ? undefined : opts.cPath,
          );
        }
      } else {
        programObject = await compileOne(
          programSource,
          `${stem}.program.o`,
          cachedProgramBytes === null ? undefined : opts.cPath,
        );
        if (cachedProgramObject !== null) {
          try {
            const [currentRuntime, currentImplicit, currentInvocation, currentDependencies, currentCompiler] =
              await Promise.all([
                runtimeFingerprint(rtDir),
                implicitToolchainFingerprint(driver, toolchainEnv),
                effectiveCompilerInvocationFingerprint(
                  driver,
                  toolchainEnv,
                  programCompilerArgs,
                  programSourceExtension,
                ),
                translationUnitDependencyFingerprint(
                  driver,
                  cflags,
                  opts.cPath,
                  cachedProgramBytes!,
                  toolchainEnv,
                ),
                ccVersionOnce(driver.argv, toolchainEnv, true),
              ]);
            if (
              currentRuntime === runtimeHash &&
              currentImplicit === implicitToolchain &&
              currentInvocation === programCompilerInvocation &&
              currentDependencies === programDependencyHash &&
              currentCompiler === compilerVersion
            ) {
              await publishCachedFile(programObject, cachedProgramObject);
            }
          } catch {
            // Best-effort: the archive build already owns a valid object.
          }
        }
      }
      const identityObject = identityBytes === null
        ? null
        : await (async () => {
            const source = join(buildDir, "identity.c");
            await writeFile(source, identityBytes);
            return compileOne(source, `${stem}.identity.o`);
          })();
      let runtimeObjects: string[] | null = null;
      let cacheInputsStable = true;
      let objectImplicitVerification: Promise<boolean> | null = null;
      const objectImplicitToolchainStillMatches = (): Promise<boolean> => {
        objectImplicitVerification ??= Promise.all([
          implicitToolchainFingerprint(driver, toolchainEnv),
          effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags),
        ]).then(
          ([currentImplicit, currentInvocation]) =>
            currentImplicit === implicitToolchain &&
            currentInvocation === runtimeCompilerInvocation,
          () => false,
        );
        return objectImplicitVerification;
      };
      if (root !== null && compilerVersion !== "" && runtimeHash !== "") {
        try {
          const sourcePaths = sources.map((f) => join(rtDir, f));
          const cached = await ensureRuntimeObjects(
            root,
            driver.argv,
            cflags,
            sourcePaths,
            `lib-obj-v5\0${cacheTargetIdentity(driver)}\0${toolchainEnv}\0${implicitToolchain}\0${runtimeCompilerInvocation}\0${driver.argv.join(" ")}\0${compilerVersion}\0${runtimeHash}\0`,
            async () =>
              (await runtimeFingerprint(rtDir)) === runtimeHash &&
              (await objectImplicitToolchainStillMatches()),
          );
          const staged = await stageRuntimeObjects(cached, join(buildDir, "cached-runtime"));
          runtimeObjects = sourcePaths.map((path) => staged.get(path)!);
        } catch (err) {
          if (err instanceof CacheInputsChangedError) cacheInputsStable = false;
          runtimeObjects = null;
        }
      }
      if (runtimeObjects === null) {
        runtimeObjects = [];
        const width = Math.min(4, availableParallelism());
        for (let i = 0; i < sources.length; i += width) {
          runtimeObjects.push(
            ...(await Promise.all(
              sources.slice(i, i + width).map((f) =>
                compileOne(join(rtDir, f), f.replace(/\.c$/, ".o")),
              ),
            )),
          );
        }
      }
      const objects = [programObject, ...(identityObject === null ? [] : [identityObject]), ...runtimeObjects, ...lreObjects, ...zlibObjects];
      // Multi-instance library mode: the archive's one member becomes the
      // combined, symbol-localized object (cached vendor/runtime objects
      // are read-only inputs here — the combine step never mutates them).
      const archiveMembers =
        opts.localizeSymbols === undefined
          ? objects
          : [
              await localizeLibraryObjects(
                driver,
                arArgv,
                buildDir,
                [programObject, ...(identityObject === null ? [] : [identityObject])],
                [...runtimeObjects, ...lreObjects, ...zlibObjects],
                opts.localizeSymbols,
                stem,
              ),
            ];
      // A cacheable or runtime-localized build owns a private archive from
      // `ar` through publication. Localized archives deliberately bypass the
      // completed-artifact cache, but still need atomic installation so two
      // invocations sharing a caller-visible output cannot race `rm`/`ar` on
      // that path.
      const archiveOutput =
        cachedArchive === null && opts.localizeSymbols === undefined
          ? opts.outPath
          : join(buildDir, "artifact.lib.a");
      await rm(archiveOutput, { force: true }); // `ar r` would append into a stale archive
      await mkdir(dirname(archiveOutput), { recursive: true });
      await execFileAsync(arArgv[0] ?? "ar", [
        ...arArgv.slice(1),
        "rcs",
        archiveOutput,
        ...archiveMembers,
      ]);
      if (archiveOutput !== opts.outPath) await installArtifact(archiveOutput, opts.outPath);
      let runtimeStillMatchesKey = false;
      if (
        cachedArchive !== null &&
        root !== null &&
        runtimeHash !== "" &&
        programDependencyHash !== "" &&
        compilerVersion !== "" &&
        archiverVersion !== ""
      ) {
        const [currentRuntime, currentImplicit, currentRuntimeInvocation, currentProgramInvocation, currentProgramDependencies, currentCompiler, currentArchiver, currentProgramShardMerge] =
          await Promise.all([
            runtimeFingerprint(rtDir).catch(() => null),
            implicitToolchainFingerprint(driver, toolchainEnv).catch(() => null),
            effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags).catch(
              () => null,
            ),
            effectiveCompilerInvocationFingerprint(
              driver,
              toolchainEnv,
              programCompilerArgs,
              programSourceExtension,
            ).catch(() => null),
            translationUnitDependencyFingerprint(
              driver,
              cflags,
              opts.cPath,
              cachedProgramBytes!,
              toolchainEnv,
            ).catch(() => null),
            ccVersionOnce(driver.argv, toolchainEnv, true).catch(() => null),
            toolVersionOnce(arArgv, toolchainEnv, true).catch(() => null),
            programShards === null
              ? Promise.resolve(null)
              : resolveProgramShardMergeIdentity(driver).catch(() => null),
          ]);
        runtimeStillMatchesKey =
          cacheInputsStable &&
          !programShardFallback &&
          currentRuntime === runtimeHash &&
          currentImplicit === implicitToolchain &&
          currentRuntimeInvocation === runtimeCompilerInvocation &&
          currentProgramInvocation === programCompilerInvocation &&
          currentProgramDependencies === programDependencyHash &&
          currentCompiler === compilerVersion &&
          currentArchiver === archiverVersion &&
          currentProgramShardMerge === programShardMergeIdentity;
      }
      if (cachedArchive !== null && root !== null && runtimeStillMatchesKey) {
        try {
          await publishCachedFile(archiveOutput, cachedArchive);
        } catch {
          // Publishing is best-effort; the requested archive is already valid.
        }
      }
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  } finally {
    if (transientVendorRoot !== null) {
      await rm(transientVendorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (root !== null) await pruneCache(root).catch(() => undefined);
}

/* Multi-instance library mode's localization step: combine the program
 * object with exactly the runtime/vendor members it reaches into ONE
 * relocatable object, then demote every scriptc external definition except
 * the profile-declared symbols to a local symbol. The internals are not
 * renamed apart — they stop being visible to the embedder's linker at all,
 * so a second archive built under a different prefix brings its own private
 * copy of the whole runtime (allocator, collector, arena, panic sink) into
 * the same process. Undefined references (the target C/math runtime and
 * system APIs, plus sanitizer ABI in instrumented builds) keep their global
 * binding: those platform services and the sanitizer are the embedder's,
 * shared by design. Windows embedders additionally link advapi32, iphlpapi,
 * and ws2_32.
 *
 * The generated program and optional identity objects are mandatory roots;
 * support-member selection still matters. A classic archive's unused members (and their
 * undefined references to units library mode excludes, like the
 * fs-promises unit's fiber symbols) never reach an embedder's link. A
 * blind merge of every object would carry those references into the one
 * combined member. Staging the support objects into an intermediate
 * archive keeps the linker's own member semantics: `ld -r` pulls only the
 * members the program object transitively needs (the COFF arm implements
 * the same member semantics in process).
 *
 *   Mach-O — one host-ld64 invocation: -r merges roots + needed members,
 *            -exported_symbols_list demotes every unlisted global to
 *            private extern, and -r without -keep_private_externs writes
 *            private externs out as non-external symbols. Apple ASan's
 *            image-registration COMMON remains shared so the final Mach-O
 *            image registers its globals once. ld64 reads every Apple
 *            platform's objects — macOS architectures and the iOS/
 *            iOS-simulator triples alike (LC_BUILD_VERSION platform and
 *            minos survive the merge) — so darwin-host macos AND ios
 *            targets ride the same arm; compileLibrary refuses those
 *            targets elsewhere.
 *   ELF, native linux host — ld -r merges with --force-group-allocation
 *            (ASan's instrumented globals ride ELF section groups whose
 *            signatures repeat across archives sharing runtime objects;
 *            resolving the groups into the combined member keeps a later
 *            multi-archive link from discarding one archive's copies),
 *            then binutils objcopy --keep-global-symbols localizes every
 *            other DEFINED global (objcopy leaves undefined symbols
 *            global by its own rule). The exact historical recipe.
 *   ELF, cross triples from any host — `zig cc -target <triple> -r`
 *            merges (zig is already the cross driver's hard requirement),
 *            then localizeElfObject demotes in process and resolves
 *            section groups the way --force-group-allocation does, with
 *            no host binutils/llvm-objcopy dependency.
 *   COFF, native win32 hosts and windows cross triples from any host —
 *            mergeAndLocalizeCoffObjects performs member selection, the
 *            merge, cross-object symbol resolution, and demotion in
 *            process: no linker offers a COFF relocatable mode (lld-link
 *            mirrors MSVC link.exe; zig's COFF driver refuses multi-object
 *            merges) and llvm-objcopy rejects symbol-scope flags for
 *            COFF, so no tool pairing exists to shell out to. */
async function localizeLibraryObjects(
  driver: CcDriver,
  arArgv: readonly string[],
  buildDir: string,
  rootObjects: readonly string[],
  supportObjects: readonly string[],
  keepSymbols: readonly string[],
  stem: string,
): Promise<string> {
  const platform = targetPlatform(driver);
  const combined = join(buildDir, `${stem}.localized.o`);
  const staging = join(buildDir, `${stem}.localize-staging.a`);
  const keepFile = join(buildDir, "localize-keep.syms");
  const run = async (argv: readonly string[]): Promise<void> => {
    try {
      await execFileAsync(argv[0]!, [...argv.slice(1)]);
    } catch (err) {
      const stderr = subprocessFailureDetail(err);
      throw new Error(
        `${argv[0]} failed while localizing the library archive's runtime symbols (abi.localize_runtime).\n` +
          `Runtime symbol localization needs the ${platform === "darwin" ? "host toolchain's ld" : driver.target === null ? "host toolchain's ld and objcopy" : "cross driver's relocatable link"} beside the C compiler.\n\n${stderr}`,
      );
    }
  };
  if (platform === "win32") {
    // COFF has no relocatable-link tool to stage through; the member
    // selection and combine+demote happen in process over the object bytes.
    const [roots, support] = await Promise.all([
      Promise.all(rootObjects.map((path) => readFile(path))),
      Promise.all(supportObjects.map((path) => readFile(path))),
    ]);
    try {
      await writeFile(
        combined,
        mergeAndLocalizeCoffObjects(roots, support, new Set(keepSymbols), {
          roots: rootObjects.map((path) => basename(path)),
          support: supportObjects.map((path) => basename(path)),
        }),
      );
    } catch (err) {
      throw new Error(
        `COFF symbol localization failed while localizing the library archive's runtime symbols (abi.localize_runtime).\n\n${(err as Error).message}`,
      );
    }
    return combined;
  }
  const supportArgs = supportObjects.length === 0 ? [] : [staging];
  if (supportObjects.length > 0) {
    await run([arArgv[0] ?? "ar", ...arArgv.slice(1), "rcs", staging, ...supportObjects]);
  }
  if (platform === "darwin") {
    await writeFile(keepFile, keepSymbols.map((s) => `_${s}\n`).join(""));
    await run(["ld", "-r", ...rootObjects, ...supportArgs, "-o", combined, "-exported_symbols_list", keepFile]);
  } else if (platform === "linux" && driver.target === null) {
    await writeFile(keepFile, keepSymbols.map((s) => `${s}\n`).join(""));
    await run(["ld", "-r", "--force-group-allocation", ...rootObjects, ...supportArgs, "-o", combined]);
    await run(["objcopy", `--keep-global-symbols=${keepFile}`, combined]);
  } else if (platform === "linux") {
    // Cross ELF: the cross driver's own lld performs the relocatable merge
    // (with the staging archive's member semantics); demotion and section-
    // group resolution happen in process. -nostdlib keeps zig from feeding
    // libc/compiler-rt inputs into the merge. Android rides this arm
    // unchanged: bionic archives are ordinary aarch64 ELF64, and the merge
    // uses the driver's zig spelling (which pins the API floor).
    await run([
      driver.argv[0] ?? "zig",
      ...driver.argv.slice(1),
      "-target", driver.zigTarget ?? driver.target!,
      "-nostdlib",
      "-r", ...rootObjects, ...supportArgs,
      "-o", combined,
    ]);
    try {
      await writeFile(combined, localizeElfObject(await readFile(combined), new Set(keepSymbols)));
    } catch (err) {
      throw new Error(
        `ELF symbol localization failed while localizing the library archive's runtime symbols (abi.localize_runtime).\n\n${(err as Error).message}`,
      );
    }
  } else {
    throw new Error(
      `runtime symbol localization (abi.localize_runtime) has no ${platform} arm; compileLibrary admits darwin, linux, and win32 builds only`,
    );
  }
  return combined;
}

/* -------------------------- persistent build cache ---------------------------
 * Content-addressed caches that let repeat builds of unchanged programs skip
 * payload code generation/linking — the test lanes' dominant cost. Executable
 * lookups still run lightweight dependency and link-input metadata probes.
 * Principal keyspaces under the cache root:
 *
 *   bin/<key>       — whole program binaries. key = sha256(resolved clang
 *                     identity/version, target + compiler/linker environment,
 *                     effective driver invocations for the real build flags,
 *                     implicit system-header and resolved linker-input bytes,
 *                     linker/assembler identities, runtime fingerprint
 *                     (every .c/.h in the runtime src dir plus the vendor pin
 *                     QJS_COMMIT), the caller's dependency identity, the
 *                     compiler-visible TU path, Darwin output basename, the
 *                     FULL normalized command line, and the emitted C bytes).
 *                     Emitted C is
 *                     byte-stable by project invariant, so unchanged programs
 *                     hit; any flag difference — e.g. the sanitized lane's
 *                     -O1/-fsanitize=address/-DSCR_RC_AUDIT — lands in a
 *                     naturally distinct key. On a hit the cached binary is
 *                     copied and atomically renamed onto outPath (never an
 *                     in-place overwrite — see the hit path) after its digest
 *                     is verified; the binary is still EXECUTED live by whoever
 *                     asked for it, so no comparison or sanitizer coverage
 *                     is ever skipped.
 *
 *   lib/<key>       — whole library archives. The identity covers the resolved
 *                     compiler and archiver identities/versions, compiler/linker
 *                     environment, effective build-flavor driver invocations,
 *                     implicit toolchain inputs, runtime fingerprint,
 *                     target/flags, gated source set, caller dependency
 *                     identity, TU path, and program-TU bytes.
 *                     Checksum-verified hits skip native code generation and ar.
 *
 *   program-obj/<key> — the canonical library program object, after any LLVM
 *                     shard merge. Exact TU repeats reuse it directly.
 *
 *   program-shard/<key> — stable LLVM dev-library buckets keyed by their IR
 *                     text and complete toolchain/TU identity. Local edits
 *                     retain every bucket whose definitions/declarations did
 *                     not change.
 *
 *   obj/<set>/<f>.o — per-flavor runtime objects for cache-miss builds. The
 *                     historical single invocation recompiles every runtime
 *                     TU per program (~1.3s at -O2); with cached objects a
 *                     miss compiles ONLY the program's C and links (~0.15s).
 *                     Library-mode -DSCR_LIB objects use a distinct flavor.
 *                     The clang driver hands every input the same option set,
 *                     so per-TU `-c` compiles with those options plus a final
 *                     link reproduce the single invocation exactly; the
 *                     driver's effective invocation under that flavor also
 *                     joins the object-set identity. Every
 *                     cached object carries a verified digest. Object
 *                     compiles go through ccache when it is installed (silent
 *                     fallback when not).
 *
 * Frontend-generated production builds supply a dependency identity and use a
 * per-user platform cache by default. Arbitrary low-level TUs omit the identity
 * and bypass this cache because their include graph is caller-owned.
 * Compiler wrappers also bypass every persistent tier: a wrapper can branch on
 * the real source/object topology and inject inputs no synthetic probe sees.
 * Direct Clang/Zig drivers and Apple's immutable /usr/bin/clang handoff retain
 * caching; wrapper-driven builds use private, invocation-local vendor outputs.
 * Opaque archiver wrappers bypass completed library archives for the same
 * reason while retaining safely keyed runtime objects.
 * Builds with caller-supplied native link inputs (archive/object paths or
 * `-l<name>` libraries) also bypass the whole binary cache: a thin archive,
 * linker script, or ambient resolution can change transitively without
 * changing the named input's bytes or spelling. Their runtime objects remain
 * cached, and every invocation performs the final link against current inputs.
 * SCRIPTC_CACHE_DIR overrides the root (the test lanes use this to stay
 * repo-local); an explicitly empty value or SCRIPTC_NO_CACHE=1 disables reads
 * and writes. With caching disabled compileC issues the exact historical
 * command line.
 *
 * Eviction: size-capped LRU over the whole cache root (SCRIPTC_CACHE_MAX_MB,
 * default 4096). Explicit caps are checked after every successful write; the
 * large default is swept on the first and every 64th write so corpus/watch
 * loops do not repeatedly walk a growing tree. Reads bump mtimes. The harness's
 * oracle cache lives under the same root and is swept by the same pass. Cache
 * trouble is never a build failure — every cache error falls back to a real
 * compile. */

/** Resolve the build cache without touching the filesystem. Exported from this
 * internal module so its platform and override behavior can be pinned directly. */
export function resolveBuildCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string | null {
  if (env["SCRIPTC_NO_CACHE"] === "1") return null;
  const configured = env["SCRIPTC_CACHE_DIR"];
  if (configured !== undefined) return configured === "" ? null : resolve(configured);

  const xdg = env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg !== "") return resolve(xdg, "scriptc", "build");
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local !== undefined && local !== "") return resolve(local, "scriptc", "cache", "build");
  }
  return platform === "darwin"
    ? resolve(userHome, "Library", "Caches", "scriptc", "build")
    : resolve(userHome, ".cache", "scriptc", "build");
}

/** Shared persistent-cache root for compiler-level tiers.  The early library
 * cache deliberately follows the native cache's activation and hard-disable
 * contract, while native compilation retains ownership of toolchain safety. */
export function buildCacheRoot(): string | null {
  return resolveBuildCacheRoot();
}

/** Harden/create a compiler-level cache root using the same privacy policy as
 * the artifact caches.  Failure disables only the optional caller's tier. */
export async function prepareBuildCacheRoot(root: string | null): Promise<string | null> {
  if (root === null) return null;
  try {
    await ensurePrivateCacheRoot(root, process.env["SCRIPTC_CACHE_DIR"] === undefined);
    return root;
  } catch {
    return null;
  }
}

/** Register a successful compiler-level cache write with the shared bounded
 * LRU policy. */
export async function pruneBuildCache(root: string | null): Promise<void> {
  if (root !== null) await pruneCache(root).catch(() => undefined);
}

function cacheRootDir(): string | null {
  return resolveBuildCacheRoot();
}

/** The production cache can contain complete user executables/archives with
 * embedded source literals or comptime values. Its root is therefore private
 * regardless of the caller's ordinary output umask. Windows inherits the
 * per-user LOCALAPPDATA ACL. POSIX platform-default roots are hardened for
 * upgrades; an arbitrary existing SCRIPTC_CACHE_DIR override is never chmod'd
 * and participates only when its caller-provided mode is already private. */
async function ensurePrivateCacheRoot(
  root: string,
  hardenExisting: boolean,
): Promise<void> {
  const existing = await stat(root).then(
    (info) => info,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (existing !== null && !existing.isDirectory()) {
    throw new Error("native cache root is not a directory");
  }
  if (
    process.platform !== "win32" &&
    existing !== null &&
    !hardenExisting &&
    (existing.mode & 0o077) !== 0
  ) {
    throw new Error("existing native cache override is not private");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (existing === null || hardenExisting)) {
    await chmod(root, 0o700);
  }
}

const ccVersionMemos = new Map<string, Promise<string>>();

interface ResolvedTool {
  canonicalPath: string;
  cacheIdentity: string;
  fileIdentity: string;
}

/** Identity of the compiler implementation and configuration selected by a
 * fresh driver invocation. In particular, Darwin's stable /usr/bin/clang shim
 * exposes the currently selected Xcode clang only in its `-###` trace. The
 * normalized trace also covers output-affecting default driver configuration
 * that can change while argv[0] and PATH retain the same spelling. */
async function effectiveCompilerEnvironmentIdentity(
  driver: Pick<CcDriver, "argv" | "targetArgs">,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const compiler = driver.argv[0] ?? "clang";
  const resolvedDriver = await resolvedTool(compiler, env);
  if (resolvedDriver === null) return `<unresolved:${compiler}>`;
  const probeDir = await mkdtemp(join(tmpdir(), "scriptc-early-cc-probe-"));
  try {
    const source = join(probeDir, "empty.c");
    const object = join(probeDir, "empty.o");
    await writeFile(source, "int scriptc_early_driver_probe;\n");
    const trace = await execFileAsync(
      compiler,
      [
        ...driver.argv.slice(1),
        ...driver.targetArgs,
        "-###",
        "-std=c11",
        "-c",
        source,
        "-o",
        object,
      ],
      { cwd: probeDir, env, maxBuffer: 16 * 1024 * 1024 },
    );
    const effectiveSpellings: string[] = [];
    for (const line of `${trace.stdout}\n${trace.stderr}`.split(/\r?\n/)) {
      const tokens = driverTraceCandidates(line);
      const cc1 = tokens.indexOf("-cc1");
      if (cc1 > 0) effectiveSpellings.push(tokens[cc1 - 1]!);
    }
    const effective = effectiveSpellings.length === 1
      ? await resolvedTool(effectiveSpellings[0]!, env)
      : null;
    return createHash("sha256")
      .update("effective-compiler-environment-v1\0")
      .update(resolvedDriver.cacheIdentity).update("\0")
      .update(normalizedProbeInvocation(trace, probeDir)).update("\0")
      .update(effective?.cacheIdentity ?? `<unresolved-effective:${effectiveSpellings.join("\x1f")}>`)
      .digest("hex");
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Resolve the executable the OS will select for an argv[0] spelling. The
 * path and inode metadata join the version output below: two PATH postures
 * must not share cache entries merely because both drivers call themselves
 * `clang` or print the same upstream version. ctime catches an in-place tool
 * replacement even when a package manager preserves its size and mtime. */
async function resolvedTool(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTool | null> {
  const hasSeparator = command.includes("/") || command.includes("\\");
  const configuredPath = (env["PATH"] ?? (process.platform === "win32" ? "" : "/usr/bin:/bin"))
    .split(delimiter);
  const pathEntries = hasSeparator
    ? [""]
    : process.platform === "win32"
      ? ["", dirname(process.execPath), ...configuredPath]
      : configuredPath;
  const windowsExtensions =
    process.platform === "win32" && extname(command) === ""
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension !== "")
      : [""];
  for (const entry of pathEntries) {
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    const base = hasSeparator
      ? isAbsolute(command) ? command : resolve(command)
      : join(directory === "" ? process.cwd() : directory, command);
    for (const extension of windowsExtensions) {
      const candidate = `${base}${extension}`;
      try {
        await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        const [canonical, info] = await Promise.all([realpath(candidate), stat(candidate)]);
        if (!info.isFile()) continue;
        const fileIdentity = [
          canonical,
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ].join("\0");
        return {
          canonicalPath: canonical,
          fileIdentity,
          cacheIdentity: [resolve(candidate), fileIdentity].join("\0"),
        };
      } catch {
        // Keep searching PATH/PATHEXT exactly as process spawning would.
      }
    }
  }
  return null;
}

async function resolvedToolIdentity(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return (await resolvedTool(command, env))?.cacheIdentity ?? null;
}

const directCompilerDriverMemos = new Map<string, boolean>();
const directCompilerSelections = new Map<string, ResolvedTool>();

function compilerDriverProbeKey(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): string {
  return [
    environmentFingerprint,
    driver.argv.join("\x1f"),
    driver.target ?? "<native>",
    driver.targetArgs.join("\x1f"),
  ].join("\0");
}

/** `/usr/bin/clang` on Darwin is Apple's immutable driver shim: its `-###`
 * trace names the selected Xcode/CommandLineTools clang rather than the shim
 * itself. The ordinary implicit-toolchain fingerprint below captures that
 * selected executable and its dependencies, so this trusted system handoff is
 * the one intentional exception to the same-executable rule. */
function isAppleSystemClangHandoff(
  driver: ResolvedTool,
  effectiveCompiler: ResolvedTool,
): boolean {
  return process.platform === "darwin" &&
    driver.canonicalPath === "/usr/bin/clang" &&
    basename(effectiveCompiler.canonicalPath) === "clang";
}

/** Persistent caches require an inspectable compiler driver. A general
 * wrapper can branch on the real source/object paths or argument topology and
 * inject inputs only into the final invocation; no synthetic metadata probe
 * can safely represent that behavior. Accept direct Clang/Zig drivers (plus
 * Apple's system shim) and conservatively keep wrapper-driven builds on the
 * uncached path. */
async function compilerDriverSupportsPersistentCache(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<boolean> {
  // Cache-race tests exercise publication below an intentionally instrumented
  // wrapper. This is deliberately undocumented and test-scoped.
  if (process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] === "1") return true;

  const driverKey = compilerDriverProbeKey(driver, environmentFingerprint);
  const compiler = driver.argv[0] ?? "clang";
  const resolvedDriver = await resolvedTool(compiler);
  // A prior dependency list cannot prove that name resolution is unchanged:
  // a new header in an earlier search directory leaves every previously
  // resolved file untouched. Require the driver to be present so each cache
  // invocation can rediscover its complete dependency graph.
  if (resolvedDriver === null) return false;
  const probeKey = `${driverKey}\0${resolvedDriver.fileIdentity}`;
  const memoized = directCompilerDriverMemos.get(probeKey);
  if (memoized !== undefined) return memoized;

  const probeDir = await mkdtemp(join(tmpdir(), "scriptc-driver-probe-"));
  let direct = false;
  try {
    const source = join(probeDir, "empty.c");
    const object = join(probeDir, "empty.o");
    await writeFile(source, "int scriptc_driver_probe;\n");
    const trace = await execFileAsync(
      compiler,
      [
        ...driver.argv.slice(1),
        ...driver.targetArgs,
        "-###",
        "-std=c11",
        "-c",
        source,
        "-o",
        object,
      ],
      { cwd: probeDir, maxBuffer: 16 * 1024 * 1024 },
    );
    const effectiveSpellings: string[] = [];
    for (const line of `${trace.stdout}\n${trace.stderr}`.split(/\r?\n/)) {
      const tokens = driverTraceCandidates(line);
      const cc1 = tokens.indexOf("-cc1");
      if (cc1 > 0) effectiveSpellings.push(tokens[cc1 - 1]!);
    }
    if (effectiveSpellings.length === 1) {
      const effectiveCompiler = await resolvedTool(effectiveSpellings[0]!);
      direct = effectiveCompiler !== null &&
        (effectiveCompiler.fileIdentity === resolvedDriver.fileIdentity ||
          isAppleSystemClangHandoff(resolvedDriver, effectiveCompiler));
      if (direct) directCompilerSelections.set(driverKey, effectiveCompiler!);
    }
  } catch {
    direct = false;
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
  directCompilerDriverMemos.set(probeKey, direct);
  if (!direct) directCompilerSelections.delete(driverKey);
  return direct;
}

/** Complete library archives may skip `ar`, so the selected archiver must be
 * as inspectable as the compiler. `zig ar` is the already-validated Zig
 * executable. For the host spelling, accept only the immutable platform
 * tool locations; a PATH wrapper can branch on the real member topology or
 * inject mutable inputs that `ar --version` cannot expose. Other archivers
 * retain runtime-object reuse but rebuild the program member and archive. */
async function archiverSupportsPersistentCache(
  arArgv: readonly string[],
  driver: Pick<CcDriver, "argv">,
): Promise<boolean> {
  if (
    arArgv.length === 2 &&
    arArgv[0] === driver.argv[0] &&
    arArgv[1] === "ar" &&
    driver.argv[0] === "zig"
  ) {
    return true;
  }
  if (arArgv.length !== 1) return false;
  const archiver = await resolvedTool(arArgv[0] ?? "ar");
  if (archiver === null || !/(?:^|-)ar$/.test(basename(archiver.canonicalPath))) {
    return false;
  }
  if (archiver.canonicalPath.startsWith("/usr/bin/") || archiver.canonicalPath.startsWith("/bin/")) {
    return true;
  }
  return process.platform === "darwin" &&
    /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\/Toolchains\/[^/]+\.xctoolchain\/usr\/bin\/[^/]*ar$/.test(
      archiver.canonicalPath,
    );
}

export async function ccVersionOnce(
  argv: string[],
  environmentFingerprint: string = toolchainEnvironmentFingerprint(),
  fresh: boolean = false,
): Promise<string> {
  const spellingKey = `${environmentFingerprint}\0${argv.join("\x1f")}`;
  const executableIdentity = await resolvedToolIdentity(argv[0] ?? "clang");
  const key = `${spellingKey}\0${executableIdentity ?? "<unresolved>"}`;
  const probe = (): Promise<string> =>
    // `zig cc --version` (zig 0.16) drops an empty a.o in its cwd. A private
    // probe directory avoids both caller pollution and the cross-process /
    // cross-user collision a fixed tmpdir()/a.o would create on Linux.
    (async () => {
      const probeDir = await mkdtemp(join(tmpdir(), "scriptc-cc-version-"));
      try {
        const r = await execFileAsync(
          argv[0] ?? "clang",
          [...argv.slice(1), "--version"],
          { cwd: probeDir },
        );
        return `${executableIdentity ?? "<unresolved>"}\0${`${r.stdout}\n${r.stderr}`.trim()}`;
      } finally {
        await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
      }
    })();
  const requireFreshProbe = fresh && !stableTestToolchainSession();
  let memo = requireFreshProbe && executableIdentity !== null ? probe() : ccVersionMemos.get(key);
  if (memo === undefined) {
    memo = probe();
    ccVersionMemos.set(key, memo);
  } else if (requireFreshProbe) {
    ccVersionMemos.set(key, memo);
  }
  return memo;
}

const toolVersionMemos = new Map<string, Promise<string>>();
const toolVersionFallbacks = new Map<string, Promise<string>>();
async function toolVersionOnce(
  argv: string[],
  environmentFingerprint: string = toolchainEnvironmentFingerprint(),
  fresh: boolean = false,
): Promise<string> {
  const spellingKey = `${environmentFingerprint}\0${argv.join("\x1f")}`;
  const executableIdentity = await resolvedToolIdentity(argv[0] ?? "ar");
  if (executableIdentity === null) {
    const fallback = toolVersionFallbacks.get(spellingKey);
    if (fallback !== undefined) return fallback;
  }
  const key = `${spellingKey}\0${executableIdentity ?? "<unresolved>"}`;
  const probe = (): Promise<string> =>
    execFileAsync(argv[0] ?? "ar", [...argv.slice(1), "--version"]).then(
      (r) => `${executableIdentity ?? "<unresolved>"}\0${`${r.stdout}\n${r.stderr}`.trim()}`,
      (err: { stdout?: string; stderr?: string; message?: string }) =>
        `${executableIdentity ?? "<unresolved>"}\0${`${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || err.message || key}`,
    );
  let memo = fresh && executableIdentity !== null ? probe() : toolVersionMemos.get(key);
  if (memo === undefined) {
    memo = probe();
    toolVersionMemos.set(key, memo);
  } else if (fresh) {
    toolVersionMemos.set(key, memo);
  }
  if (executableIdentity !== null) toolVersionFallbacks.set(spellingKey, memo);
  return memo;
}

interface ImplicitToolchainProbe {
  compilerIdentity: string;
  compilerInvocation: string;
  dependencies: string[];
  dependencyFingerprint: string;
  invocationPaths: string[];
  tools: { spelling: string; identity: string | null; path: string | null }[];
  compileToolSpellings: string[];
}

interface ImplicitToolchainFingerprints {
  /** Compiler inputs plus assembler identity: safe for compile-only objects. */
  compile: string;
  /** The compile identity plus the driver's selected linker identity. */
  complete: string;
}

interface ImplicitLinkerProbe {
  compilerIdentity: string;
  linkerInvocation: string;
  dependencies: string[];
  dependencyFingerprint: string;
  invocationPaths: string[];
  linker: { spelling: string; identity: string | null; path: string | null };
}

interface FingerprintDependencies {
  paths: string[];
  /** Content identity computed while the enclosing fingerprint was minted.
   * Null means the fingerprint has no file-content component. */
  contentPaths: string[];
  contentFingerprint: string | null;
}

/** Dependency paths discovered while computing one strict fingerprint. The
 * output-local cache stamp snapshots these exact files/directories after a
 * validated build, then can prove a later same-output no-op without spawning
 * clang again. The content identity closes the gap between hashing and that
 * metadata snapshot: a file changed in the gap cannot make new bytes ride an
 * old key. Keep the map bounded for long-lived corpus/test processes. */
const fingerprintDependencies = new Map<string, FingerprintDependencies>();
function rememberFingerprintDependencies(
  fingerprint: string,
  paths: readonly string[],
  contentPaths: readonly string[] = [],
  contentFingerprint: string | null = null,
): string {
  fingerprintDependencies.set(fingerprint, {
    paths: [...new Set(paths)].sort(),
    contentPaths: [...new Set(contentPaths)].sort(),
    contentFingerprint,
  });
  if (fingerprintDependencies.size > 256) {
    const oldest = fingerprintDependencies.keys().next().value as string | undefined;
    if (oldest !== undefined) fingerprintDependencies.delete(oldest);
  }
  return fingerprint;
}

function fingerprintDependencyPaths(fingerprint: string): string[] {
  return fingerprintDependencies.get(fingerprint)?.paths ?? [];
}

function parseMakeDependencies(output: string, cwd: string = process.cwd()): string[] {
  const flattened = output.replace(/\\\r?\n/g, " ");
  const separator = flattened.indexOf(": ");
  if (separator < 0) throw new Error("compiler dependency probe returned no make rule");
  const input = flattened.slice(separator + 2);
  const paths: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (/\s/.test(char)) {
      if (current !== "") {
        paths.push(current.replace(/\$\$/g, "$"));
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (current !== "") paths.push(current.replace(/\$\$/g, "$"));
  return [...new Set(paths.map((path) => resolve(cwd, path)))].sort();
}

function normalizedProbeInvocation(
  result: { stdout: string; stderr: string },
  probeDir: string,
): string {
  return `${result.stdout}\n${result.stderr}`
    // Probe-local paths vary on every invocation and carry no toolchain
    // identity. Both ordinary and shell-escaped Windows spellings can appear
    // in a driver's quoted trace.
    .split(probeDir).join("<probe>")
    .split(probeDir.replace(/\\/g, "\\\\")).join("<probe>")
    .trim();
}

interface EffectiveCompilerInvocationProbe {
  compilerIdentity: string;
  invocation: string;
  dependencies: string[];
  dependencyFingerprint: string;
  invocationPaths: string[];
}

/** The effective cc1 invocation and injected dependencies for the flags used
 * by real runtime/program compiles. The broad implicit-toolchain probe below
 * intentionally uses a target-wide synthetic TU so it can discover every
 * owned system header, but that generic command is not sufficient identity for
 * a wrapper that injects flags or preincluded files only for a particular build
 * flavor (for example, only when it sees -O2 or -DSCR_DYNAMIC). */
async function effectiveCompilerInvocationFingerprintFresh(
  driver: Pick<CcDriver, "argv">,
  environmentFingerprint: string,
  compileArgs: readonly string[],
  sourceExtension: ".c" | ".ll" = ".c",
): Promise<string> {
  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before effective invocation identity was established");
  }
  let probe: EffectiveCompilerInvocationProbe;
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-effective-cc-probe-"));
    try {
      const source = join(probeDir, `program${sourceExtension}`);
      const output = join(probeDir, "program.o");
      await writeFile(
        source,
        sourceExtension === ".ll"
          ? "define i32 @scriptc_effective_probe() { ret i32 0 }\n"
          : "int scriptc_effective_probe(void) { return 0; }\n",
      );
      const prefix = [...driver.argv.slice(1), ...compileArgs];
      const [invocation, dependencyResult] = await Promise.all([
        execFileAsync(
          compiler,
          [...prefix, "-###", "-c", source, "-o", output],
          { cwd: probeDir, maxBuffer: 16 * 1024 * 1024 },
        ),
        sourceExtension === ".c"
          ? execFileAsync(compiler, [...prefix, "-M", source], {
              cwd: probeDir,
              maxBuffer: 16 * 1024 * 1024,
            })
          : Promise.resolve(null),
      ]);
      const dependencies =
        dependencyResult === null
          ? []
          : parseMakeDependencies(dependencyResult.stdout, probeDir).filter(
              (path) => path !== resolve(source),
            );
      probe = {
        compilerIdentity,
        invocation: normalizedProbeInvocation(invocation, probeDir),
        dependencies,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencies),
        invocationPaths: await existingDriverTracePaths(
          `${invocation.stdout}\n${invocation.stderr}`,
          probeDir,
          probeDir,
        ),
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const fingerprint = createHash("sha256")
    .update("effective-compiler-invocation-v2\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(probe.compilerIdentity)
    .update("\0")
    .update(driver.argv.join("\x1f"))
    .update("\0")
    .update(compileArgs.join("\x1f"))
    .update("\0")
    .update(sourceExtension)
    .update("\0")
    .update(probe.invocation)
    .update("\0")
    .update(probe.dependencies.join("\x1f"))
    .update("\0")
    .update(probe.dependencyFingerprint)
    .digest("hex");
  return rememberFingerprintDependencies(
    fingerprint,
    [...probe.dependencies, ...probe.invocationPaths],
    probe.dependencies,
    probe.dependencyFingerprint,
  );
}

const stableEffectiveCompilerInvocationMemos = new Map<string, Promise<string>>();
function effectiveCompilerInvocationFingerprint(
  driver: Pick<CcDriver, "argv">,
  environmentFingerprint: string,
  compileArgs: readonly string[],
  sourceExtension: ".c" | ".ll" = ".c",
): Promise<string> {
  const key = [
    environmentFingerprint,
    driver.argv.join("\x1f"),
    compileArgs.join("\x1f"),
    sourceExtension,
  ].join("\0");
  return stableTestMemo(stableEffectiveCompilerInvocationMemos, key, () =>
    effectiveCompilerInvocationFingerprintFresh(
      driver,
      environmentFingerprint,
      compileArgs,
      sourceExtension,
    ),
  );
}

async function nativeSourceFiles(
  directory: string,
  recursive: boolean,
  include: (name: string) => boolean = (name) => name.endsWith(".c") || name.endsWith(".h"),
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const canonical = await realpath(current).catch(() => resolve(current));
    if (ancestors.has(canonical)) return;
    const nestedAncestors = new Set(ancestors).add(canonical);
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && recursive) {
        await walk(path, nestedAncestors);
      } else if (entry.isSymbolicLink()) {
        const target = await stat(path).catch(() => null);
        if (target?.isDirectory() && recursive) await walk(path, nestedAncestors);
        else if (target?.isFile() && include(entry.name)) files.push(path);
      } else if (entry.isFile() && include(entry.name)) {
        files.push(path);
      }
    }
  };
  await walk(directory, new Set());
  return files.sort();
}

/** Every system-header spelling consumed by a source tree scriptc owns. The
 * dependency probe preprocesses these spellings with the selected driver and
 * hashes the resolved files. Runtime-local and vendored source/header bytes
 * have their own content/version identities; scanning every owned file for
 * angle includes closes the system-header gap in separately built QuickJS,
 * libregexp, mbedTLS, zlib, curl, and Ryū translation units. */
export async function implicitDependencyProbeIncludes(rtDir: string): Promise<string[]> {
  const vendor = join(rtDir, "..", "vendor");
  const quickjsSources = new Set([...QJS_ENGINE_SOURCES, ...LRE_SOURCES]);
  const zlibSources = new Set(ZLIB_SOURCES);
  const fileGroups = await Promise.all([
    nativeSourceFiles(rtDir, false),
    nativeSourceFiles(join(vendor, "ryu"), false),
    nativeSourceFiles(
      join(vendor, "quickjs-ng"),
      false,
      (name) => name.endsWith(".h") || quickjsSources.has(name),
    ),
    nativeSourceFiles(join(vendor, "mbedtls", "include"), true),
    nativeSourceFiles(join(vendor, "mbedtls", "library"), true),
    nativeSourceFiles(
      join(vendor, "zlib"),
      false,
      (name) => name.endsWith(".h") || zlibSources.has(name),
    ),
    nativeSourceFiles(join(vendor, "curl", "include"), true, (name) => name.endsWith(".h")),
  ]);
  const includes = new Set<string>();
  for (const path of fileGroups.flat()) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/^\s*#\s*include\s*<([^>]+)>/gm)) {
      includes.add(`<${match[1]!}>`);
    }
  }
  return [...includes].sort();
}

function implicitDependencyIncludeDirective(include: string): string {
  const targetCondition =
    include === "<cpuid.h>" || include === "<immintrin.h>"
      ? " && (defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64))"
      : include === "<intrin.h>"
        ? " && defined(_WIN32)"
        : include === "<arm64_neon.h>" || include === "<arm_acle.h>" || include === "<arm_neon.h>"
          ? " && (defined(__arm__) || defined(__aarch64__) || defined(_M_ARM) || defined(_M_ARM64))"
          : "";
  return `#if __has_include(${include})${targetCondition}\n#include ${include}\n#endif\n`;
}

async function fingerprintDependencyFiles(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256").update("implicit-dependencies-v1\0");
  for (let i = 0; i < paths.length; i += 128) {
    const batch = paths.slice(i, i + 128);
    const contents = await Promise.all(batch.map((path) => readFile(path)));
    for (let j = 0; j < batch.length; j++) {
      hash.update(batch[j]!).update("\0").update(contents[j]!).update("\0");
    }
  }
  return hash.digest("hex");
}

async function fingerprintDependenciesStillMatch(fingerprints: readonly string[]): Promise<boolean> {
  const distinct = [...new Set(fingerprints)];
  const identities = distinct
    .map((fingerprint) => fingerprintDependencies.get(fingerprint))
    // A restored native-metadata stamp carries and revalidates the dependency
    // snapshot from the process that minted this fingerprint. Only identities
    // computed in this process have an additional content hash to recheck here.
    .filter((identity): identity is FingerprintDependencies => identity !== undefined);
  return (await Promise.all(
    identities.map(async (identity) =>
      identity.contentFingerprint === null ||
      await fingerprintDependencyFiles(identity.contentPaths).catch(() => null) ===
        identity.contentFingerprint
    ),
  )).every(Boolean);
}

interface TranslationUnitDependencyProbe {
  compilerIdentity: string;
  dependencies: string[];
  dependencyFingerprint: string;
}

/** Exact headers selected while preprocessing the caller's translation unit.
 * The shared toolchain probe covers the runtime/vendor trees, but compileC is
 * also a public API: an opted-in caller can include a system or header-only SDK
 * surface that no runtime source names. Probe an invocation-private snapshot
 * of the keyed bytes with the real compile flags, preserving the original
 * quote-include directory and compiler-visible source spelling. */
async function translationUnitDependencyFingerprintFresh(
  driver: Pick<CcDriver, "argv">,
  cflags: readonly string[],
  sourcePath: string,
  sourceBytes: Buffer,
  environmentFingerprint: string,
): Promise<string> {
  if (sourcePath.endsWith(".ll")) {
    return rememberFingerprintDependencies(
      createHash("sha256").update("translation-unit-dependencies-v1\0llvm-ir").digest("hex"),
      [],
    );
  }

  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before translation-unit dependencies were established");
  }
  let probe: TranslationUnitDependencyProbe;
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-tu-probe-"));
    try {
      const snapshot = join(probeDir, "program.c");
      await writeFile(snapshot, sourceBytes);
      const result = await execFileAsync(
        compiler,
        [
          ...driver.argv.slice(1),
          // The real source directory is searched before every caller-supplied
          // -iquote/-I directory. Put its surrogate first to preserve that
          // precedence after moving the keyed bytes into the probe directory.
          "-iquote",
          dirname(resolve(sourcePath)),
          ...cflags,
          `-ffile-prefix-map=${snapshot}=${sourcePath}`,
          "-M",
          snapshot,
        ],
        { cwd: probeDir, maxBuffer: 16 * 1024 * 1024 },
      );
      const ownPaths = new Set([resolve(snapshot), resolve(sourcePath)]);
      const dependencies = parseMakeDependencies(result.stdout, probeDir).filter(
        (path) => !ownPaths.has(path),
      );
      probe = {
        compilerIdentity,
        dependencies,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencies),
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const fingerprint = createHash("sha256")
    .update("translation-unit-dependencies-v1\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(probe.compilerIdentity)
    .update("\0")
    .update(probe.dependencies.join("\x1f"))
    .update("\0")
    .update(probe.dependencyFingerprint)
    .digest("hex");
  return rememberFingerprintDependencies(
    fingerprint,
    probe.dependencies,
    probe.dependencies,
    probe.dependencyFingerprint,
  );
}

const stableTranslationUnitDependencyMemos = new Map<string, Promise<string>>();
function translationUnitDependencyFingerprint(
  driver: Pick<CcDriver, "argv">,
  cflags: readonly string[],
  sourcePath: string,
  sourceBytes: Buffer,
  environmentFingerprint: string,
): Promise<string> {
  const key = createHash("sha256")
    .update(environmentFingerprint)
    .update("\0")
    .update(driver.argv.join("\x1f"))
    .update("\0")
    .update(cflags.join("\x1f"))
    .update("\0")
    .update(sourcePath)
    .update("\0")
    .update(resolve(sourcePath))
    .update("\0")
    .update(sourceBytes)
    .digest("hex");
  return stableTestMemo(stableTranslationUnitDependencyMemos, key, () =>
    translationUnitDependencyFingerprintFresh(
      driver,
      cflags,
      sourcePath,
      sourceBytes,
      environmentFingerprint,
    ),
  );
}

/** Identity of implicit compiler inputs that do not appear in buildArgs:
 * default SDK/system headers and the assembler/linker selected by the driver.
 * Small preprocessor dependency probes include every header spelling used by
 * the runtime when it is available for the selected target (and therefore the
 * vendored headers those TUs consume), then hash the exact dependency bytes.
 * Vendored source snapshots remain keyed by their version pins. When the
 * compiler is available, dependency discovery runs afresh so an SDK/config
 * change that redirects includes cannot hide behind an unchanged old path
 * list. Dependency discovery must succeed on every cache-enabled invocation;
 * a prior path list cannot reveal a new higher-priority header. */
async function implicitToolchainFingerprintsFresh(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<ImplicitToolchainFingerprints> {
  let probe: ImplicitToolchainProbe;
  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before implicit toolchain identity was established");
  }
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-toolchain-probe-"));
    try {
      const dependencyIncludes = await implicitDependencyProbeIncludes(runtimeSrcDir());
      // Clang's GNU cpuid.h and Windows intrin.h both define `__cpuid` with
      // incompatible signatures. Real TUs select only one context; preserve
      // that isolation while still discovering both targets' dependency sets.
      const sourceGroups = [
        dependencyIncludes.filter((include) => include !== "<intrin.h>"),
        dependencyIncludes.filter((include) => include === "<intrin.h>"),
      ].filter((group) => group.length > 0);
      const sources = sourceGroups.map((_, index) => join(probeDir, `empty-${index}.c`));
      const driverSource = join(probeDir, "driver-empty.c");
      const driverOutput = join(probeDir, "driver-output.o");
      await Promise.all([
        ...sources.map((source, index) =>
          writeFile(source, sourceGroups[index]!.map(implicitDependencyIncludeDirective).join("")),
        ),
        writeFile(driverSource, "int scriptc_driver_probe;\n"),
      ]);
      const prefix = [...driver.argv.slice(1), ...driver.targetArgs];
      const probeArgs = [
        ...prefix,
        "-std=c11",
        "-D_GNU_SOURCE",
        "-D_XOPEN_SOURCE=700",
        "-I", runtimeSrcDir(),
        "-I", vendorEngineDir(),
        "-I", join(vendorTlsDir(), "include"),
        "-I", join(vendorTlsDir(), "library"),
        "-I", vendorZlibDir(),
        "-I", join(vendorCurlDir(), "include"),
        "-M",
      ];
      const [dependencyResults, linker, assembler, compilerInvocation] = await Promise.all([
        Promise.all(
          sources.map((source) =>
            execFileAsync(compiler, [...probeArgs, source], {
              cwd: probeDir,
              maxBuffer: 16 * 1024 * 1024,
            }),
          ),
        ),
        execFileAsync(compiler, [...prefix, "-print-prog-name=ld"], { cwd: probeDir }),
        execFileAsync(compiler, [...prefix, "-print-prog-name=as"], { cwd: probeDir }),
        // `-###` exposes the effective cc1 invocation after compiler-driver
        // config and ordinary wrappers have injected their implicit flags. A
        // wrapper can read environment variables unknown to scriptc; hashing
        // this trace keeps those flags from hiding behind an unchanged wrapper
        // executable/version and dependency set.
        execFileAsync(
          compiler,
          [...prefix, "-std=c11", "-###", "-c", driverSource, "-o", driverOutput],
          { cwd: probeDir, maxBuffer: 16 * 1024 * 1024 },
        ),
      ]);
      const assemblerSpelling = assembler.stdout.trim();
      const toolSpellings = [linker.stdout.trim(), assemblerSpelling].filter(
        (value, index, all) => value !== "" && all.indexOf(value) === index,
      );
      const sourceSet = new Set(sources);
      const dependencyPaths = [
        ...new Set(
          dependencyResults
            .flatMap((dependencies) => parseMakeDependencies(dependencies.stdout))
            .filter((path) => !sourceSet.has(path)),
        ),
      ].sort();
      probe = {
        compilerIdentity: compilerIdentity ?? `<unresolved>\0${compiler}`,
        compilerInvocation: normalizedProbeInvocation(compilerInvocation, probeDir),
        dependencies: dependencyPaths,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencyPaths),
        invocationPaths: await existingDriverTracePaths(
          `${compilerInvocation.stdout}\n${compilerInvocation.stderr}`,
          probeDir,
          probeDir,
        ),
        tools: await Promise.all(
          toolSpellings.map(async (spelling) => {
            const resolved = await resolvedTool(spelling);
            return {
              spelling,
              identity: resolved?.cacheIdentity ?? null,
              path: resolved?.canonicalPath ?? null,
            };
          }),
        ),
        compileToolSpellings: assemblerSpelling === "" ? [] : [assemblerSpelling],
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const tools = await Promise.all(probe.tools.map(async (tool) => ({
    ...tool,
    currentIdentity: await resolvedToolIdentity(tool.spelling),
  })));
  const fingerprint = (
    domain: string,
    selectedTools: readonly (typeof tools)[number][],
  ): string => {
    const hash = createHash("sha256")
      .update(domain)
      .update(environmentFingerprint)
      .update("\0")
      .update(probe.compilerIdentity)
      .update("\0")
      .update(probe.compilerInvocation)
      .update("\0")
      .update(driver.argv.join("\x1f"))
      .update("\0")
      .update(driver.targetArgs.join("\x1f"))
      .update("\0")
      .update(probe.dependencies.join("\x1f"))
      .update("\0")
      .update(probe.dependencyFingerprint)
      .update("\0");
    for (const tool of selectedTools) {
      hash
        .update(tool.spelling)
        .update("\0")
        .update(tool.currentIdentity ?? tool.identity ?? "<unresolved>")
        .update("\0");
    }
    return rememberFingerprintDependencies(
      hash.digest("hex"),
      [
        ...probe.dependencies,
        ...probe.invocationPaths,
        ...selectedTools.flatMap((tool) => tool.path === null ? [] : [tool.path]),
      ],
      probe.dependencies,
      probe.dependencyFingerprint,
    );
  };
  const compileSpellingSet = new Set(probe.compileToolSpellings);
  return {
    // Preserve the established complete fingerprint domain and byte stream.
    complete: fingerprint("implicit-toolchain-v2\0", tools),
    compile: fingerprint(
      "implicit-compile-toolchain-v1\0",
      tools.filter((tool) => compileSpellingSet.has(tool.spelling)),
    ),
  };
}

const stableImplicitToolchainMemos = new Map<string, Promise<ImplicitToolchainFingerprints>>();
function implicitToolchainFingerprints(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<ImplicitToolchainFingerprints> {
  const key = [
    environmentFingerprint,
    driver.argv.join("\x1f"),
    driver.target ?? "<native>",
    driver.targetArgs.join("\x1f"),
    runtimeSrcDir(),
  ].join("\0");
  return stableTestMemo(stableImplicitToolchainMemos, key, () =>
    implicitToolchainFingerprintsFresh(driver, environmentFingerprint),
  );
}

function implicitToolchainFingerprint(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
): Promise<string> {
  return implicitToolchainFingerprints(driver, environmentFingerprint).then(
    (fingerprints) => fingerprints.complete,
  );
}

function linkTraceCandidate(line: string): string[] {
  const trimmed = line.trim().replace(/^(?:LOAD|load)\s+/, "");
  if (trimmed === "") return [];
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  const candidates = [unquoted];
  const member = unquoted.lastIndexOf("(");
  if (member > 0 && unquoted.endsWith(")")) candidates.push(unquoted.slice(0, member));
  return candidates;
}

function driverTraceCandidates(line: string): string[] {
  const candidates: string[] = [];
  for (const match of line.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["\\])/g, "$1");
    if (token !== "") candidates.push(token);
  }
  return candidates;
}

async function existingDriverTracePaths(
  output: string,
  cwd: string,
  excludedRoot: string,
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tokens = driverTraceCandidates(line);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const joinedPathOption = ["-I", "-L", "-F"].find(
        (option) => token.startsWith(option) && token.length > option.length,
      );
      const equalsPathOption = ["--sysroot=", "-resource-dir="].find((option) =>
        token.startsWith(option)
      );
      const separatePathOptions = [
        "-I",
        "-L",
        "-F",
        "--sysroot",
        "-isysroot",
        "-resource-dir",
        "-isystem",
        "-iquote",
        "-internal-isystem",
        "-internal-externc-isystem",
        "-internal-iframework",
      ];
      const optionPath = joinedPathOption !== undefined
        ? token.slice(joinedPathOption.length)
        : equalsPathOption !== undefined
          ? token.slice(equalsPathOption.length)
          : separatePathOptions.includes(token)
            ? tokens[index + 1] ?? ""
            : token;
      if (!isAbsolute(optionPath)) continue;
      const path = resolve(cwd, optionPath);
      if (
        path === excludedRoot ||
        path.startsWith(`${excludedRoot}/`) ||
        path.startsWith(`${excludedRoot}\\`)
      ) {
        continue;
      }
      candidates.add(path);
    }
  }
  const existing = await Promise.all(
    [...candidates].map(async (path) => [path, await lstat(path).catch(() => null)] as const),
  );
  return existing
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null)
    .map(([path]) => path)
    .sort();
}

export async function parseLinkTraceFiles(
  output: string,
  cwd: string,
  excludedRoot: string,
  driverDryRun: boolean = false,
): Promise<string[]> {
  const files = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const candidates = driverDryRun ? driverTraceCandidates(line) : linkTraceCandidate(line);
    for (const candidate of candidates) {
      const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
      if (path === excludedRoot || path.startsWith(`${excludedRoot}/`) || path.startsWith(`${excludedRoot}\\`)) {
        continue;
      }
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) {
        files.add(path);
        // Traditional `-Wl,-t` output has one dependency per line, while
        // Zig's COFF `-###` fallback prints the entire lld-link argv on one
        // line. Keep scanning every dry-run token so CRT/import/runtime
        // libraries after the first path also join the fingerprint.
        if (!driverDryRun) break;
      }
    }
  }
  return [...files].sort();
}

/** Exact files selected by the compiler driver's implicit link. A tiny
 * target object plus the linker's trace mode resolves CRT objects, compiler
 * runtimes, linker scripts, SDK stubs/import libraries, and every ambient
 * default library without guessing platform search layouts. The caller adds
 * build-flavor flags such as ASan and scriptc's own fixed `-l` arguments.
 * Every cache-enabled invocation performs a fresh trace; a prior resolved path
 * list cannot reveal a newly selected higher-priority linker input. */
async function implicitLinkerFingerprintFresh(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
  linkArgs: readonly string[],
  effectiveInvocationArgs?: readonly string[],
  traceInvocationArgs?: readonly string[],
): Promise<string> {
  const invocationArgs =
    effectiveInvocationArgs ?? [...driver.targetArgs, ...linkArgs];
  const traceArgs = traceInvocationArgs ?? [...driver.targetArgs, ...linkArgs];
  const compiler = driver.argv[0] ?? "clang";
  const compilerIdentity = await resolvedToolIdentity(compiler);
  if (compilerIdentity === null) {
    throw new Error("compiler unavailable before implicit linker identity was established");
  }
  let probe: ImplicitLinkerProbe;
  {
    const probeDir = await mkdtemp(join(tmpdir(), "scriptc-linker-probe-"));
    try {
      const source = join(probeDir, "empty.c");
      const object = join(probeDir, "empty.o");
      const output = join(probeDir, process.platform === "win32" ? "empty.exe" : "empty");
      await writeFile(source, "int main(void) { return 0; }\n");
      const prefix = [...driver.argv.slice(1), ...driver.targetArgs];
      const [, linker] = await Promise.all([
        execFileAsync(
          compiler,
          [...prefix, "-std=c11", "-c", source, "-o", object],
          { cwd: probeDir },
        ),
        execFileAsync(
          compiler,
          [...prefix, "-print-prog-name=ld"],
          { cwd: probeDir },
        ),
      ]);
      // Unlike the compile-only toolchain trace, this exposes options a
      // compiler wrapper/config injects only for link invocations (rpaths,
      // subsystem/stack settings, --defsym, and peers). Resolved input files
      // alone cannot represent those output-affecting flags.
      const driverInvocation = await execFileAsync(
        compiler,
        [...driver.argv.slice(1), ...invocationArgs, object, "-###", "-o", output],
        { cwd: probeDir, maxBuffer: 32 * 1024 * 1024 },
      );
      // The dry run exposes absolute files a wrapper injects for this exact
      // build flavor. Its unresolved -l spellings are supplemented by the
      // real trace below, which runs with the same flavor flags but omits
      // not-yet-materialized scriptc-owned vendor prerequisites.
      const driverDependencies = await parseLinkTraceFiles(
        `${driverInvocation.stdout}\n${driverInvocation.stderr}`,
        probeDir,
        probeDir,
        true,
      );
      let tracedDependencies: string[] = [];
      try {
        const trace = await execFileAsync(
          compiler,
          [...driver.argv.slice(1), ...traceArgs, object, "-Wl,-t", "-o", output],
          { cwd: probeDir, maxBuffer: 32 * 1024 * 1024 },
        );
        tracedDependencies = await parseLinkTraceFiles(
          `${trace.stdout}\n${trace.stderr}`,
          probeDir,
          probeDir,
        );
      } catch (error) {
        // Zig's COFF linker deliberately rejects GNU ld's `-t`, but `zig cc
        // -###` prints its fully resolved lld-link input list (CRT and every
        // import/compiler-runtime library as absolute cache paths). Other
        // drivers' dry runs commonly leave `-lc`/`-lSystem` unresolved, so
        // they must not use this fallback as a complete artifact identity.
        if (driver.argv[0] !== "zig" || driver.argv[1] !== "cc") throw error;
      }
      const dependencies = [...new Set([...driverDependencies, ...tracedDependencies])].sort();
      if (dependencies.length === 0) {
        throw new Error("linker trace reported no resolved input files");
      }
      const linkerSpelling = linker.stdout.trim();
      probe = {
        compilerIdentity,
        linkerInvocation: normalizedProbeInvocation(driverInvocation, probeDir),
        dependencies,
        dependencyFingerprint: await fingerprintDependencyFiles(dependencies),
        invocationPaths: await existingDriverTracePaths(
          `${driverInvocation.stdout}\n${driverInvocation.stderr}`,
          probeDir,
          probeDir,
        ),
        linker: {
          spelling: linkerSpelling,
          identity:
            linkerSpelling === ""
              ? null
              : (await resolvedTool(linkerSpelling))?.cacheIdentity ?? null,
          path:
            linkerSpelling === ""
              ? null
              : (await resolvedTool(linkerSpelling))?.canonicalPath ?? null,
        },
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const linkerIdentity =
    probe.linker.spelling === ""
      ? null
      : await resolvedToolIdentity(probe.linker.spelling);
  const fingerprint = createHash("sha256")
    .update("implicit-linker-v3\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(probe.compilerIdentity)
    .update("\0")
    .update(probe.linkerInvocation)
    .update("\0")
    .update(driver.argv.join("\x1f"))
    .update("\0")
    .update(driver.targetArgs.join("\x1f"))
    .update("\0")
    .update(linkArgs.join("\x1f"))
    .update("\0")
    .update(invocationArgs.join("\x1f"))
    .update("\0")
    .update(traceArgs.join("\x1f"))
    .update("\0")
    .update(probe.dependencies.join("\x1f"))
    .update("\0")
    .update(probe.dependencyFingerprint)
    .update("\0")
    .update(probe.linker.spelling)
    .update("\0")
    .update(linkerIdentity ?? probe.linker.identity ?? "<unresolved>")
    .digest("hex");
  return rememberFingerprintDependencies(
    fingerprint,
    [
      ...probe.dependencies,
      ...probe.invocationPaths,
      ...(probe.linker.path === null ? [] : [probe.linker.path]),
    ],
    probe.dependencies,
    probe.dependencyFingerprint,
  );
}

const stableImplicitLinkerMemos = new Map<string, Promise<string>>();
function implicitLinkerFingerprint(
  driver: Pick<CcDriver, "argv" | "targetArgs" | "target">,
  environmentFingerprint: string,
  linkArgs: readonly string[],
  effectiveInvocationArgs?: readonly string[],
  traceInvocationArgs?: readonly string[],
): Promise<string> {
  const invocationArgs = effectiveInvocationArgs ?? [...driver.targetArgs, ...linkArgs];
  const traceArgs = traceInvocationArgs ?? [...driver.targetArgs, ...linkArgs];
  const key = [
    environmentFingerprint,
    driver.argv.join("\x1f"),
    driver.target ?? "<native>",
    driver.targetArgs.join("\x1f"),
    linkArgs.join("\x1f"),
    invocationArgs.join("\x1f"),
    traceArgs.join("\x1f"),
  ].join("\0");
  return stableTestMemo(stableImplicitLinkerMemos, key, () =>
    implicitLinkerFingerprintFresh(
      driver,
      environmentFingerprint,
      linkArgs,
      effectiveInvocationArgs,
      traceInvocationArgs,
    ),
  );
}

let ccacheMemo: Promise<boolean> | null = null;
function ccacheAvailable(): Promise<boolean> {
  ccacheMemo ??= execFileAsync("ccache", ["--version"]).then(
    () => true,
    () => false,
  );
  return ccacheMemo;
}

/** Content hash of every owned native source/header plus this backend's build
 * recipe implementation. It keys complete artifacts, runtime objects, and the
 * separately built vendor prerequisites, so two installed scriptc versions or
 * worktrees can share a user cache without exchanging outputs produced from
 * different vendored bytes or compile/archive recipes. Recursive enumeration
 * also catches a newly added nested header that begins shadowing a system
 * include, while content hashing catches same-size timestamp-preserving edits. */
async function runtimeFingerprintFresh(rtDir: string): Promise<string> {
  const groups = await runtimeFingerprintInputGroups(rtDir);
  const h = createHash("sha256")
    .update("native-owned-inputs-v2\0")
    .update(QJS_COMMIT).update(MBEDTLS_VERSION).update(ZLIB_VERSION)
    .update("\0backend-recipe\0")
    .update(await readFile(CC_IMPLEMENTATION_PATH));
  for (const group of groups) {
    for (const n of group.names) {
      h.update(group.label).update("/").update(n).update("\0").update(await readFile(join(group.dir, n))).update("\0");
    }
  }
  return h.digest("hex");
}

async function runtimeFingerprintInputGroups(
  rtDir: string,
): Promise<{ label: string; dir: string; names: string[] }[]> {
  return Promise.all(
    [
      { label: "runtime", dir: rtDir },
      { label: "ryu", dir: join(rtDir, "..", "vendor", "ryu") },
      { label: "quickjs-ng", dir: join(rtDir, "..", "vendor", "quickjs-ng") },
      { label: "mbedtls", dir: join(rtDir, "..", "vendor", "mbedtls") },
      { label: "zlib", dir: join(rtDir, "..", "vendor", "zlib") },
      { label: "curl", dir: join(rtDir, "..", "vendor", "curl") },
    ].map(async (group) => {
      const names = (await nativeSourceFiles(group.dir, true))
        .map((path) => relative(group.dir, path))
        .sort();
      return { ...group, names };
    }),
  );
}

async function runtimeFingerprintInputPaths(rtDir: string): Promise<string[]> {
  return [
    ...(await runtimeFingerprintInputGroups(rtDir)).flatMap((group) =>
      group.names.map((name) => join(group.dir, name))
    ),
    CC_IMPLEMENTATION_PATH,
  ];
}

const stableRuntimeFingerprintMemos = new Map<string, Promise<string>>();
export function runtimeFingerprint(rtDir: string): Promise<string> {
  const key = resolve(rtDir);
  return stableTestMemo(stableRuntimeFingerprintMemos, key, () => runtimeFingerprintFresh(rtDir));
}

class CacheInputsChangedError extends Error {
  constructor() {
    super("runtime inputs changed while populating the native object cache");
    this.name = "CacheInputsChangedError";
  }
}

function cacheDigestPath(path: string): string {
  return `${path}.sha256`;
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Cache entries are disposable data, not trusted compiler output. Atomic
 * rename prevents ordinary partial writes, while the adjacent digest catches
 * disk damage, manual truncation, and entries left by an interrupted/older
 * publisher before they reach clang, the linker, or `ar`. */
async function validCachedFile(object: string): Promise<boolean> {
  try {
    const digestPath = cacheDigestPath(object);
    const expected = (await readFile(digestPath, "utf8")).trim();
    const valid = /^[0-9a-f]{64}$/.test(expected) && (await fileDigest(object)) === expected;
    if (valid) {
      const now = new Date();
      await Promise.all([
        utimes(object, now, now).catch(() => undefined),
        utimes(digestPath, now, now).catch(() => undefined),
      ]);
    }
    return valid;
  } catch {
    return false;
  }
}

/** Copy a cache entry and verify the private copy before it can become a
 * caller-visible artifact. Verifying after the copy closes the gap between a
 * source-side digest check and a concurrent replacement/truncation. */
async function copyValidCachedFile(source: string, destination: string): Promise<boolean> {
  try {
    const digestPath = cacheDigestPath(source);
    const expected = (await readFile(digestPath, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(expected)) return false;
    await copyFile(source, destination);
    if ((await fileDigest(destination)) !== expected) {
      await rm(destination, { force: true }).catch(() => undefined);
      return false;
    }
    const now = new Date();
    await Promise.all([
      utimes(source, now, now).catch(() => undefined),
      utimes(digestPath, now, now).catch(() => undefined),
    ]);
    return true;
  } catch {
    await rm(destination, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Publish a complete executable/archive and its digest through private names.
 * Data is installed before its verifier, so a racing reader can only observe
 * an invalid/missing digest and take the fresh-build path. */
async function publishCachedFile(source: string, destination: string): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = join(directory, `.tmp-${basename(destination).slice(0, 8)}-${nonce}`);
  const tmpDigest = `${tmp}.sha256`;
  try {
    await copyFile(source, tmp);
    await chmod(tmp, 0o600);
    await writeFile(tmpDigest, `${await fileDigest(tmp)}\n`, { mode: 0o600 });
    await rename(tmp, destination);
    await rename(tmpDigest, cacheDigestPath(destination));
  } finally {
    await Promise.all([
      rm(tmp, { force: true }).catch(() => undefined),
      rm(tmpDigest, { force: true }).catch(() => undefined),
    ]);
  }
}

interface LocalArtifactStamp {
  version: 2;
  key: string;
  digest: string;
  dependencies: NativeArtifactDependency[];
  integrity: string;
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

async function directoryTreeDigest(
  root: string,
  excludedPaths: readonly string[] = [],
): Promise<string> {
  const hash = createHash("sha256").update("native-dependency-tree-v1\0");
  const visited = new Set<string>();
  const excluded = excludedPaths.map((path) => resolve(path));
  const walk = async (directory: string, relative: string): Promise<void> => {
    const canonical = await realpath(directory);
    if (visited.has(canonical)) {
      hash.update(relative).update("\0cycle\0").update(canonical).update("\0");
      return;
    }
    visited.add(canonical);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const absolute = resolve(path);
      if (excluded.some((candidate) =>
        absolute === candidate ||
        absolute.startsWith(`${candidate}/`) ||
        absolute.startsWith(`${candidate}\\`)
      )) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(path);
      const kind = info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : info.isSymbolicLink()
            ? "symlink"
            : "other";
      hash.update(child).update("\0").update(kind).update("\0");
      if (kind === "symlink") {
        const target = await realpath(path).catch(() => "<missing>");
        hash.update(target).update("\0");
        const targetInfo = await stat(path).catch(() => null);
        if (targetInfo?.isDirectory()) await walk(path, child);
      }
      if (kind === "directory") await walk(path, child);
    }
    visited.delete(canonical);
  };
  await walk(root, "");
  return hash.digest("hex");
}

function localDependencyKind(
  info: Awaited<ReturnType<typeof lstat>>,
): NativeArtifactDependency["kind"] | null {
  return info.isFile()
    ? "file"
    : info.isDirectory()
      ? "directory"
      : info.isSymbolicLink()
        ? "symlink"
        : null;
}

async function snapshotLocalArtifactDependency(
  path: string,
  treeExclusions: readonly string[] | null = null,
): Promise<NativeArtifactDependency> {
  const info = await lstat(path);
  const kind = localDependencyKind(info);
  if (kind === null) throw new Error(`unsupported local artifact dependency: ${path}`);
  const dependency: NativeArtifactDependency = {
    path,
    kind,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
  if (kind === "directory" && treeExclusions !== null) {
    dependency.treeExclusions = [...new Set(treeExclusions.map((entry) => resolve(entry)))].sort();
    dependency.treeDigest = await directoryTreeDigest(path, dependency.treeExclusions);
  }
  if (kind === "symlink") {
    const targetPath = await realpath(path);
    const target = await stat(path);
    const targetKind = target.isFile() ? "file" : target.isDirectory() ? "directory" : null;
    if (targetKind === null) throw new Error(`unsupported symlink target dependency: ${path}`);
    dependency.targetPath = targetPath;
    dependency.targetKind = targetKind;
    dependency.targetDev = target.dev;
    dependency.targetIno = target.ino;
    dependency.targetSize = target.size;
    dependency.targetMtimeMs = target.mtimeMs;
    dependency.targetCtimeMs = target.ctimeMs;
    if (targetKind === "directory" && treeExclusions !== null) {
      dependency.treeExclusions = [...new Set(treeExclusions.map((entry) => resolve(entry)))].sort();
      dependency.treeDigest = await directoryTreeDigest(path, dependency.treeExclusions);
    }
  }
  return dependency;
}

async function snapshotLocalArtifactDependencies(
  dependencyPaths: readonly string[],
  recursiveDirectories: readonly string[] = [],
  recursiveExclusions: readonly string[] = [],
): Promise<NativeArtifactDependency[]> {
  const recursive = new Set(recursiveDirectories.map((path) => resolve(path)));
  return Promise.all(
    [...new Set(dependencyPaths)].sort().map((path) =>
      snapshotLocalArtifactDependency(
        path,
        recursive.has(resolve(path)) ? recursiveExclusions : null,
      )
    ),
  );
}

export async function nativeArtifactDependenciesStillMatch(
  dependencies: readonly NativeArtifactDependency[],
): Promise<boolean> {
  if (!dependencies.every((dependency) =>
    dependency !== null && typeof dependency === "object" &&
    typeof dependency.path === "string" &&
    (dependency.kind === "file" || dependency.kind === "directory" || dependency.kind === "symlink") &&
    typeof dependency.dev === "number" && typeof dependency.ino === "number" &&
    typeof dependency.size === "number" && typeof dependency.mtimeMs === "number" &&
    typeof dependency.ctimeMs === "number" &&
    (dependency.treeDigest === undefined || typeof dependency.treeDigest === "string") &&
    (dependency.treeExclusions === undefined || (
      Array.isArray(dependency.treeExclusions) &&
      dependency.treeExclusions.every((path) => typeof path === "string")
    )) &&
    (dependency.kind !== "symlink" || (
      typeof dependency.targetPath === "string" &&
      (dependency.targetKind === "file" || dependency.targetKind === "directory") &&
      typeof dependency.targetDev === "number" && typeof dependency.targetIno === "number" &&
      typeof dependency.targetSize === "number" && typeof dependency.targetMtimeMs === "number" &&
      typeof dependency.targetCtimeMs === "number"
    ))
  )) return false;
  return (await Promise.all(
    dependencies.map(async (dependency) => {
      const current = await snapshotLocalArtifactDependency(
        dependency.path,
        dependency.treeDigest === undefined ? null : dependency.treeExclusions ?? [],
      ).catch(() => null);
      return current !== null && JSON.stringify(current) === JSON.stringify(dependency);
    }),
  )).every(Boolean);
}

interface NativeMetadataStamp {
  version: 2;
  key: string;
  values: Record<string, string>;
  dependencies: NativeArtifactDependency[];
  integrity: string;
}

function nativeMetadataStampPath(root: string, key: string): string {
  return join(root, "meta", createHash("sha256").update(key).digest("hex"));
}

function nativeMetadataStampIntegrity(
  stamp: Pick<NativeMetadataStamp, "version" | "key" | "values" | "dependencies">,
): string {
  return createHash("sha256")
    .update("native-metadata-stamp-v2\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

async function readNativeMetadataStamp(
  root: string,
  key: string,
): Promise<NativeMetadataStamp | null> {
  try {
    const stamp = JSON.parse(
      await readFile(nativeMetadataStampPath(root, key), "utf8"),
    ) as NativeMetadataStamp;
    if (
      stamp.version !== 2 ||
      stamp.key !== key ||
      stamp.values === null ||
      typeof stamp.values !== "object" ||
      !Array.isArray(stamp.dependencies) ||
      !/^[0-9a-f]{64}$/.test(stamp.integrity) ||
      nativeMetadataStampIntegrity({
        version: stamp.version,
        key: stamp.key,
        values: stamp.values,
        dependencies: stamp.dependencies,
      }) !== stamp.integrity ||
      !(await nativeArtifactDependenciesStillMatch(stamp.dependencies))
    ) {
      return null;
    }
    return stamp;
  } catch {
    return null;
  }
}

async function publishNativeMetadataStamp(
  root: string,
  key: string,
  values: Record<string, string>,
  dependencyPaths: readonly string[],
  fingerprints: readonly string[] = [],
): Promise<NativeMetadataStamp> {
  const destination = nativeMetadataStampPath(root, key);
  await mkdir(dirname(destination), { recursive: true });
  const dependencies = await snapshotLocalArtifactDependencies(dependencyPaths);
  if (!(await fingerprintDependenciesStillMatch(fingerprints))) {
    throw new CacheInputsChangedError();
  }
  const unsigned = { version: 2, key, values, dependencies } as const;
  const stamp: NativeMetadataStamp = {
    ...unsigned,
    integrity: nativeMetadataStampIntegrity(unsigned),
  };
  const tmp = `${destination}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  return stamp;
}

function nativeMetadataKey(
  kind: string,
  parts: readonly (string | readonly string[])[],
): string {
  const hash = createHash("sha256").update(`native-metadata-${kind}-v2\0`);
  for (const part of parts) {
    hash.update(typeof part === "string" ? part : part.join("\x1f")).update("\0");
  }
  return `${kind}-${hash.digest("hex")}`;
}

/** The caller-visible output is itself the cheapest safe cache tier. Once a
 * generated TU has produced this exact binary, an unchanged rebuild need not
 * rediscover every SDK header and linker input merely to copy equivalent bytes
 * back onto the same path. This tier is deliberately narrower than the CAS:
 * only frontend-generated programs with no caller-owned native inputs opt in.
 * The generated TU bytes, every scriptc runtime source, the selected direct
 * compiler inode, target/options/environment, and the output path all join the
 * key. A digest rejects a modified/truncated output before the no-op hit. */
function localArtifactIdentity(
  opts: CcOptions,
  driver: CcDriver,
  environmentFingerprint: string,
  compilerIdentity: string,
  runtimeHash: string,
  programBytes: Buffer,
  programShardMerge: string | null,
): string {
  const normalizedOptions = Object.fromEntries(
    Object.entries(opts)
      // Shard source can be tens of megabytes. Hash it incrementally below
      // instead of materializing a second giant JSON string solely for this
      // output-local fast-path identity.
      .filter(([key, value]) =>
        value !== undefined && key !== "programShards" && key !== "programPublicSymbols"
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const hash = createHash("sha256")
    .update("local-artifact-v1\0")
    .update(cacheTargetIdentity(driver)).update("\0")
    .update(environmentFingerprint).update("\0")
    .update(compilerIdentity).update("\0")
    .update(runtimeHash).update("\0")
    .update(driver.argv.join("\x1f")).update("\0")
    .update(driver.targetArgs.join("\x1f")).update("\0")
    .update(driver.linkArgs.join("\x1f")).update("\0");
  if (programShardMerge !== null) {
    updateProgramShardCacheIdentity(
      hash,
      opts.programShards,
      opts.programPublicSymbols,
      programShardMerge,
    );
  }
  return hash
    .update(process.env["SCRIPTC_FETCH_CURL"] === "1" ? "fetch-curl" : "fetch-native").update("\0")
    .update(JSON.stringify(normalizedOptions)).update("\0")
    .update(resolve(opts.cPath)).update("\0")
    .update(resolve(opts.outPath)).update("\0")
    .update(programBytes)
    .digest("hex");
}

function localArtifactStampPath(root: string, outPath: string): string {
  const outputKey = createHash("sha256").update(resolve(outPath)).digest("hex");
  return join(root, "local", outputKey);
}

function localArtifactStampIntegrity(
  stamp: Pick<LocalArtifactStamp, "version" | "key" | "digest" | "dependencies">,
): string {
  return createHash("sha256")
    .update("local-artifact-stamp-v2\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

async function localArtifactHit(
  stampPath: string,
  outPath: string,
  key: string,
): Promise<LocalArtifactStamp | null> {
  try {
    const stamp = JSON.parse(await readFile(stampPath, "utf8")) as Partial<LocalArtifactStamp>;
    const output = await lstat(outPath);
    const expectedMode = 0o777 & ~process.umask();
    if (
      stamp.version !== 2 ||
      stamp.key !== key ||
      !/^[0-9a-f]{64}$/.test(stamp.digest ?? "") ||
      !Array.isArray(stamp.dependencies) ||
      !/^[0-9a-f]{64}$/.test(stamp.integrity ?? "") ||
      localArtifactStampIntegrity({
        version: stamp.version,
        key: stamp.key,
        digest: stamp.digest!,
        dependencies: stamp.dependencies,
      }) !== stamp.integrity ||
      !output.isFile() ||
      (output.mode & 0o777) !== expectedMode ||
      stamp.dependencies.some((dependency) =>
        dependency === null ||
        typeof dependency !== "object" ||
        typeof dependency.path !== "string" ||
        dependency.kind !== "file" &&
          dependency.kind !== "directory" &&
          dependency.kind !== "symlink" ||
        typeof dependency.dev !== "number" ||
        typeof dependency.ino !== "number" ||
        typeof dependency.size !== "number" ||
        typeof dependency.mtimeMs !== "number" ||
        typeof dependency.ctimeMs !== "number" ||
        dependency.treeDigest !== undefined && typeof dependency.treeDigest !== "string" ||
        dependency.kind === "symlink" && (
          typeof dependency.targetPath !== "string" ||
          dependency.targetKind !== "file" && dependency.targetKind !== "directory" ||
          typeof dependency.targetDev !== "number" ||
          typeof dependency.targetIno !== "number" ||
          typeof dependency.targetSize !== "number" ||
          typeof dependency.targetMtimeMs !== "number" ||
          typeof dependency.targetCtimeMs !== "number"
        )
      ) ||
      !(await nativeArtifactDependenciesStillMatch(stamp.dependencies)) ||
      await fileDigest(outPath) !== stamp.digest
    ) {
      return null;
    }
    const now = new Date();
    await utimes(stampPath, now, now).catch(() => undefined);
    return stamp as LocalArtifactStamp;
  } catch {
    return null;
  }
}

async function publishLocalArtifactStamp(
  stampPath: string,
  outPath: string,
  key: string,
  dependencyPaths: readonly string[],
  recursiveDirectories: readonly string[] = [],
  recursiveExclusions: readonly string[] = [],
): Promise<LocalArtifactStamp> {
  await mkdir(dirname(stampPath), { recursive: true });
  const tmp = `${stampPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    const dependencies = await snapshotLocalArtifactDependencies(
      dependencyPaths,
      recursiveDirectories,
      recursiveExclusions,
    );
    const unsigned = {
      version: 2,
      key,
      digest: await fileDigest(outPath),
      dependencies,
    } as const;
    const stamp: LocalArtifactStamp = {
      ...unsigned,
      integrity: localArtifactStampIntegrity(unsigned),
    };
    await writeFile(tmp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    await rename(tmp, stampPath);
    return stamp;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** The cached .o set for one flag flavor, compiled on first need. Concurrent
 * first builds (parallel test workers on a cold cache) may duplicate work;
 * per-file atomic renames make every winner equivalent. Publication is held
 * until verifyInputs confirms that the source/header fingerprint used by the
 * key still describes the bytes clang just read. */
async function ensureRuntimeObjects(
  root: string,
  ccArgv: string[],
  cflags: string[],
  sources: string[],
  keyPrefix: string,
  verifyInputs: () => Promise<boolean>,
  protectedPaths?: Set<string>,
): Promise<Map<string, string>> {
  const setKey = createHash("sha256")
    .update(keyPrefix)
    .update(cflags.join("\x1f"))
    .digest("hex")
    .slice(0, 24);
  const objDir = join(root, "obj", setKey);
  const objOf = (src: string): string => join(objDir, `${basename(src, ".c")}.o`);
  if (protectedPaths !== undefined) {
    for (const source of sources) {
      const object = objOf(source);
      protectedPaths.add(object);
      protectedPaths.add(cacheDigestPath(object));
    }
  }
  const present = await Promise.all(sources.map((s) => validCachedFile(objOf(s))));
  const missing = sources.filter((_, i) => !present[i]);
  if (missing.length > 0) {
    // ccache wraps only the default clang driver — multi-word drivers
    // (`zig cc`) run bare; their object sets are keyed apart anyway.
    const useCcache =
      process.env["SCRIPTC_TEST_DISABLE_CCACHE"] !== "1" &&
      ccArgv.length === 1 &&
      ccArgv[0] === "clang" &&
      (await ccacheAvailable());
    await mkdir(objDir, { recursive: true });
    const tmpDir = await mkdtemp(join(tmpdir(), "scriptc-cache-obj-"));
    try {
      const compiled = new Map<string, string>();
      // Modest parallelism: a flavor's objects build once, but several cold
      // workers can race here — keep each build's CPU footprint small.
      const width = 4;
      for (let i = 0; i < missing.length; i += width) {
        await Promise.all(
          missing.slice(i, i + width).map(async (src) => {
            const tmpObj = join(tmpDir, `${basename(src, ".c")}.o`);
            const argv = [...(useCcache ? ["ccache"] : []), ...ccArgv, ...cflags, "-c", src, "-o", tmpObj];
            await execFileAsync(argv[0] ?? "clang", argv.slice(1), useCcache
              ? {
                  // ccache direct mode remembers only the headers selected by
                  // its previous manifest and can miss a newly created,
                  // higher-priority header. The scriptc object-set key already
                  // includes the recursive runtime namespace fingerprint, so
                  // carry it into ccache's own keyspace as well.
                  env: {
                    ...process.env,
                    CCACHE_NAMESPACE: [
                      process.env["CCACHE_NAMESPACE"],
                      `scriptc-${setKey}`,
                    ].filter((value) => value !== undefined && value !== "").join(":"),
                  },
                }
              : undefined);
            compiled.set(src, tmpObj);
          }),
        );
      }
      // The fingerprint was computed before these subprocesses started. Do
      // not place their outputs under that key if a checkout/package update
      // changed any runtime source or included header while clang was reading.
      if (!(await verifyInputs())) throw new CacheInputsChangedError();
      for (const [src, built] of compiled) {
        const destination = objOf(src);
        await publishCachedFile(built, destination);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  if (!(await verifyInputs())) throw new CacheInputsChangedError();
  const objects = new Map(sources.map((s) => [s, objOf(s)]));
  if (!(await Promise.all([...objects.values()].map(validCachedFile))).every(Boolean)) {
    throw new Error("native object cache integrity check failed");
  }
  return objects;
}

/** Give one active link/archive operation private names for its cached
 * runtime objects. A hard link keeps the inode alive if another process's LRU
 * sweep unlinks the cache entry; filesystems that cannot hard-link across the
 * cache/tmp boundary fall back to a copy. If eviction wins before staging,
 * the caller catches the read failure and performs a fully fresh compile. */
export async function stageRuntimeObjects(
  objects: ReadonlyMap<string, string>,
  stageDir: string,
): Promise<Map<string, string>> {
  await mkdir(stageDir, { recursive: true });
  const now = new Date();
  const staged = await Promise.all(
    [...objects].map(async ([source, object]) => {
      const destination = join(stageDir, basename(object));
      try {
        await link(object, destination);
      } catch {
        await copyFile(object, destination);
      }
      // Object files participate in the same mtime-based LRU as complete
      // artifacts. A successful stage is a cache read, so promote the source
      // name best-effort (it may have raced an eviction after the hard link).
      await utimes(object, now, now).catch(() => undefined);
      return [source, destination] as const;
    }),
  );
  return new Map(staged);
}

/** Size-capped LRU sweep of the whole cache root. A caller-configured cap is
 * enforced after every successful cache write. The 4 GiB default is checked on
 * the first and every 64th write in a long-lived process: a full tree walk per
 * corpus program would otherwise become quadratic as the cache grows. Oldest-
 * mtime files go first until the tree is back under 75% of the cap; reads bump
 * mtimes. Active links use private staged names/hard links, so cache names can
 * be unlinked safely. */
const rootWriteCounts = new Map<string, number>();
async function pruneCache(root: string, protectedPaths?: ReadonlySet<string>): Promise<void> {
  const configuredCap = process.env["SCRIPTC_CACHE_MAX_MB"];
  const writes = (rootWriteCounts.get(root) ?? 0) + 1;
  rootWriteCounts.set(root, writes);
  if (configuredCap === undefined && writes !== 1 && writes % 64 !== 0) return;
  const capBytes = Number(configuredCap ?? "4096") * 1024 * 1024;
  if (!Number.isFinite(capBytes) || capBytes <= 0) return;
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        // Atomic publishers use private names until their data/digest or
        // metadata stamp is complete. They are active writes, not LRU entries.
        if (
          ent.name.startsWith(".scriptc-") ||
          ent.name.startsWith(".tmp-") ||
          ent.name.includes(".tmp-")
        ) continue;
        if (protectedPaths?.has(p)) continue;
        const s = await stat(p).catch(() => null);
        if (s !== null) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await walk(root);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= capBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= capBytes * 0.75) break;
    try {
      await unlink(f.path);
      total -= f.size;
    } catch {
      // A concurrent reader/publisher may already have moved the name.
    }
  }
}

/** Compiles one C program together with the runtime sources.
 * With caching disabled, the runtime (a dozen small files) is recompiled on
 * every build in one historical clang invocation — no cached-archive
 * staleness bugs. --dynamic additionally compiles
 * scr_island.c under SCR_DYNAMIC and links the cached engine archive (built
 * lazily, see above); regex-using programs additionally compile scr_regex.c
 * and link libregexp (the cached objects, or the archive's own copy under
 * --dynamic). Without either, the command line is exactly the historical
 * one — regex-free static builds must stay byte-identical.
 *
 * With a caller-supplied dependency identity and an enabled cache root,
 * unchanged programs skip payload code generation/linking via the binary
 * cache after lightweight metadata probes, and misses link the program's own
 * TU against cached per-flavor runtime objects. */
async function compileCInternal(
  opts: CcOptions,
  cacheWarmOnly: boolean,
  cacheWarmPaths?: Set<string>,
): Promise<void> {
  const rtDir = runtimeSrcDir();
  const sanitize = opts.sanitize ?? false;
  const optimization = opts.optimization ?? "release";
  const dynamic = opts.dynamic ?? false;
  const regex = opts.regex ?? false;
  // fetch's implementation switch: the default is the NATIVE bridge
  // (scr_fetch.c over scr_net + scr_tls + scr_http's client parser +
  // zlib — no libcurl anywhere), which implies the socket units into the
  // link. SCRIPTC_FETCH_CURL=1 keeps the retired curl reference
  // (scr_fetch_curl.c + system libcurl / the linux soname stub)
  // compilable for one release as the flip's reference.
  const fetchOn = opts.fetch ?? false;
  // The retired curl bridge has only a SCR_DYNAMIC implementation.
  // Static fetch always keeps the native runtime even when a developer
  // has the comparison switch exported in their shell.
  const curlFetch =
    dynamic && fetchOn && process.env["SCRIPTC_FETCH_CURL"] === "1";
  const nativeFetch = fetchOn && !curlFetch;
  // The island's node:http/https client bridge: embedded graphs that
  // import those builtins get working clients over the same socket units
  // (native-fetch builds always carry it — scr_fetch_install registers it).
  const netIsland = dynamic && ((opts.netIsland ?? false) || nativeFetch);
  const net = (opts.net ?? false) || nativeFetch || netIsland;
  const http = (opts.http ?? false) || nativeFetch || netIsland;
  const tls = (opts.tls ?? false) || nativeFetch || netIsland;
  const tlsCa = (opts.tlsCa ?? false) || tls;
  const driver = resolveCc();
  const shardNames = new Set<string>();
  const programShardsValid = opts.programShards?.every((shard) => {
    if (
      basename(shard.name) !== shard.name || !shard.name.endsWith(".ll") ||
      shardNames.has(shard.name)
    ) return false;
    shardNames.add(shard.name);
    return true;
  }) === true;
  const programShardsRequested =
    optimization === "dev" && !sanitize && opts.cPath.endsWith(".ll") &&
    programShardsValid && opts.programShards !== undefined && opts.programShards.length > 1 &&
    opts.programPublicSymbols !== undefined
      ? opts.programShards
      : null;
  const programShardMergeIdentity = programShardsRequested === null
    ? null
    : await resolveProgramShardMergeIdentity(driver);
  const programShards = programShardMergeIdentity === null ? null : programShardsRequested;
  const programPublicSymbols = programShards === null ? undefined : opts.programPublicSymbols;
  // Mobile triples produce library archives, never standalone executables:
  // the executable-lane runtime (event loop, sockets, child processes) is
  // not verified on those device classes. compile() reports the SC3002
  // diagnostic first; this is the backstop for direct compileC callers.
  if (isMobileTarget(driver.target)) {
    throw new Error(
      `SCRIPTC_TARGET=${driver.target} builds library-mode static archives only — ` +
        `compile with a library profile (SCRIPTC_CC=zigcc scriptc build --lib --profile <profile.json>) and link the archive from the app project.`,
    );
  }
  const runtimeSources = targetPlatform(driver) === "wasi"
    ? RUNTIME_SOURCES.filter((source) => source !== "scr_child.c")
    : RUNTIME_SOURCES;
  // scr_async.c submits callback-style filesystem work to a native worker.
  // POSIX drivers need the thread compile/link mode; win32 uses CreateThread.
  const threadArgs = targetPlatform(driver) === "win32" || targetPlatform(driver) === "wasi"
    ? []
    : ["-pthread"];
  if (driver.target !== null) {
    // See the resolveCc block: these inputs are built on and for the HOST
    // (vendored archives, system libs). Regex, zlib, and the engine archive
    // are NOT here: their vendored sources are plain C that ensureLreObjects
    // / ensureZlibObjects / buildEngineArchiveDirect compile per target with
    // the driver itself — win32 included (the Windows lane runs the
    // @dynamic corpus and the zlib program against the box's Node). The
    // NATIVE fetch rides the socket units and cross-compiles with them —
    // no gate; only the retired curl REFERENCE (SCRIPTC_FETCH_CURL=1)
    // keeps a linux-only arm (the vendored curl headers + the generated
    // soname stub, ensureCurlStub — win32 has no system libcurl contract
    // to bind at load time). The event-loop units, tls, and dgram cross-compile to Linux
    // AND Windows (scr_platform.h poller + per-target mbedTLS; the
    // loop's win32 arm is WSAPoll, scr_loop_wsapoll.c, and the socket
    // units' win32 arms respell winsock behind POSIX-errno wrappers —
    // scr_net.c/scr_dgram.c/scr_tls.c). The events unit cross-compiles
    // everywhere: its win32 arm is CRT signal() +
    // PeekNamedPipe/WaitForSingleObject probes (scr_events.c), served by
    // the loop's capped win32 idle sleep (scr_async.c).
    const unsupported = (
      [
        // The NATIVE fetch cross-compiles wherever the socket units do
        // (linux and win32 both); only the retired curl reference keeps
        // its linux-only soname-stub arm.
        ["fetch (SCRIPTC_FETCH_CURL)", curlFetch && targetPlatform(driver) !== "linux"],
      ] as const
    )
      .filter(([, on]) => on)
      .map(([name]) => name);
    if (unsupported.length > 0) {
      throw new Error(
        `SCRIPTC_TARGET=${driver.target}: ${unsupported.join(", ")} not supported under a cross target yet ` +
          `(host-built vendor archives / system libs — see docs/linux-port.md).`,
      );
    }
  }
  const cachePolicy = toolchainEnvironmentCachePolicy();
  const configuredCacheRoot = cacheRootDir();
  const toolchainEnv = toolchainEnvironmentFingerprint();
  const persistentDriverCache =
    cachePolicy.runtimeObjects &&
    configuredCacheRoot !== null &&
    await compilerDriverSupportsPersistentCache(driver, toolchainEnv);
  // Only compiler-generated TUs opt in. Arbitrary `compileC` / `--from-c`
  // inputs may include caller-owned headers whose contents are not otherwise
  // represented in this key, so they retain the fully uncached historical
  // path unless the caller supplies its own complete dependency identity.
  let root =
    opts.cacheIdentity === undefined || !persistentDriverCache
      ? null
      : configuredCacheRoot;
  if (cacheWarmOnly && root === null) {
    throw new Error(
      "native cache warming requires a persistently cacheable compiler environment",
    );
  }
  if (root !== null) {
    try {
      await ensurePrivateCacheRoot(
        root,
        process.env["SCRIPTC_CACHE_DIR"] === undefined,
      );
    } catch (error) {
      if (cacheWarmOnly) {
        throw new Error("native cache warming could not prepare the persistent cache root", {
          cause: error,
        });
      }
      root = null;
    }
  }
  let localArtifact: {
    stampPath: string;
    key: string;
    runtimeHash: string;
    programBytes: Buffer;
    compilerPath: string;
  } | null = null;
  // Generated executable TUs are closed over scriptc's own runtime tree. A
  // same-output rebuild can therefore check those bytes directly before the
  // broader cross-output CAS performs its compiler/SDK/linker rediscovery.
  // FFI/native-input builds and the public arbitrary-C cache API stay on the
  // strict path because their dependency graphs are caller-owned.
  if (
    !cacheWarmOnly &&
    root !== null &&
    cachePolicy.completeArtifacts &&
    opts.cacheIdentity === "scriptc-generated-v1" &&
    (opts.linkInputs?.length ?? 0) === 0 &&
    (opts.systemLibraries?.length ?? 0) === 0 &&
    process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] !== "1"
  ) {
    try {
      const [compiler, runtimeHash, programBytes] = await Promise.all([
        resolvedTool(driver.argv[0] ?? "clang"),
        runtimeFingerprint(rtDir),
        readFile(opts.cPath),
      ]);
      if (compiler !== null) {
        const effectiveCompiler = directCompilerSelections.get(
          compilerDriverProbeKey(driver, toolchainEnv),
        ) ?? compiler;
        const key = localArtifactIdentity(
          opts,
          driver,
          toolchainEnv,
          `${compiler.cacheIdentity}\0${effectiveCompiler.cacheIdentity}`,
          runtimeHash,
          programBytes,
          programShardMergeIdentity,
        );
        const stampPath = localArtifactStampPath(root, opts.outPath);
        localArtifact = {
          stampPath,
          key,
          runtimeHash,
          programBytes,
          compilerPath: effectiveCompiler.canonicalPath,
        };
        const hit = await localArtifactHit(stampPath, opts.outPath, key);
        if (hit !== null) {
          await opts.onArtifactReady?.({ dependencies: hit.dependencies }).catch(() => undefined);
          return;
        }
      }
    } catch {
      // The output-local tier is only an optimization; the fully validated
      // CAS below remains the source of truth on any metadata trouble.
      localArtifact = null;
    }
  }
  let implicitToolchain: string | null = null;
  let implicitCompileToolchain: string | null = null;
  let toolchainMetadataStamp: NativeMetadataStamp | null = null;
  const metadataCompiler = root === null
    ? null
    : await resolvedTool(driver.argv[0] ?? "clang");
  const metadataEffectiveCompiler = directCompilerSelections.get(
    compilerDriverProbeKey(driver, toolchainEnv),
  ) ?? metadataCompiler;
  const toolchainMetadataKey =
    root === null ||
      metadataCompiler === null ||
      metadataEffectiveCompiler === null ||
      process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] === "1"
    ? null
    : nativeMetadataKey("toolchain", [
        cacheTargetIdentity(driver),
        toolchainEnv,
        driver.argv,
        driver.targetArgs,
        metadataCompiler.cacheIdentity,
        metadataEffectiveCompiler.cacheIdentity,
        rtDir,
      ]);
  if (persistentDriverCache) {
    try {
      toolchainMetadataStamp =
        root === null || toolchainMetadataKey === null
          ? null
          : await readNativeMetadataStamp(root, toolchainMetadataKey);
      implicitToolchain = toolchainMetadataStamp?.values["implicitToolchain"] ?? null;
      implicitCompileToolchain =
        toolchainMetadataStamp?.values["implicitCompileToolchain"] ?? null;
      if (
        implicitToolchain === null ||
        (programShards !== null && implicitCompileToolchain === null)
      ) {
        const fingerprints = await implicitToolchainFingerprints(driver, toolchainEnv);
        implicitToolchain = fingerprints.complete;
        implicitCompileToolchain = fingerprints.compile;
        toolchainMetadataStamp = null;
      }
      let compilerVersion = toolchainMetadataStamp?.values["compilerVersion"];
      if (compilerVersion === undefined) {
        compilerVersion = await ccVersionOnce(driver.argv, toolchainEnv, true);
      }
      if (
        toolchainMetadataStamp === null &&
        root !== null &&
        toolchainMetadataKey !== null
      ) {
        if (metadataCompiler !== null && metadataEffectiveCompiler !== null) {
          toolchainMetadataStamp = await publishNativeMetadataStamp(
            root,
            toolchainMetadataKey,
            {
              implicitToolchain,
              ...(implicitCompileToolchain === null ? {} : { implicitCompileToolchain }),
              compilerVersion,
            },
            [
              metadataCompiler.canonicalPath,
              metadataEffectiveCompiler.canonicalPath,
              ...fingerprintDependencyPaths(implicitToolchain),
              ...(implicitCompileToolchain === null
                ? []
                : fingerprintDependencyPaths(implicitCompileToolchain)),
            ],
            [
              implicitToolchain,
              ...(implicitCompileToolchain === null ? [] : [implicitCompileToolchain]),
            ],
          );
        }
      }
    } catch (error) {
      // Cache discovery is best-effort. In particular, a compiler wrapper can
      // compile successfully without implementing the metadata probes.
      if (cacheWarmOnly) {
        throw new Error("native cache warming could not validate the compiler toolchain", {
          cause: error,
        });
      }
      root = null;
    }
  }
  const vendorBuildIdentity = await currentVendorCacheBuildIdentity(
    driver,
    `${toolchainEnv}\0${implicitToolchain ?? "<uncached>"}`,
  );
  // Mutable include/SDK/config inputs can change behind a stable environment
  // spelling. The complete/runtime cache is disabled below; vendor objects
  // must follow the same rule instead of silently surviving in the user cache.
  // A private root gives this invocation the usual vendor build recipe
  // without publishing or reusing those prerequisites.
  const transientVendorRoot = root !== null && implicitToolchain !== null
    ? null
    : join(
        tmpdir(),
        `scriptc-vendor-${process.pid}-${Math.random().toString(36).slice(2)}`,
      );
  const vendorCacheRoot = transientVendorRoot ?? vendorBuildCacheRoot(root ?? undefined);
  // Every vendor output path is deterministic from pins, flags, driver, and
  // target. Build the command/key from those paths now, but do not materialize
  // them until a complete-binary lookup has missed.
  let engineArchive = dynamic
    ? engineArchivePath(sanitize, driver, vendorBuildIdentity, vendorCacheRoot)
    : null;
  let tlsArchive = tls
    ? tlsArchivePath(sanitize, driver, vendorBuildIdentity, vendorCacheRoot)
    : null;
  // --dynamic + regex shares the archive's libregexp (its host hooks and
  // ours would collide; see scr_regex.c) — the standalone objects are for
  // static builds only.
  let lreObjects = regex && !dynamic
    ? lreObjectPaths(sanitize, driver, vendorBuildIdentity, vendorCacheRoot)
    : [];
  // Vendored zlib is the CROSS story only — host builds keep the exact
  // historical `-lz` system link (see CcOptions.zlib). The native fetch's
  // gzip decoder rides the same objects/link.
  let zlibObjects =
    ((opts.zlib ?? false) || nativeFetch) && driver.target !== null
      ? zlibObjectPaths(sanitize, driver, vendorBuildIdentity, vendorCacheRoot)
      : [];
  // The libcurl import stub is likewise CROSS-only — host builds keep the
  // exact historical system `-lcurl` link (see CcOptions.fetch). Curl
  // reference builds only.
  let curlStubDir =
    curlFetch && driver.target !== null
      ? curlStubDirPath(driver, vendorBuildIdentity, vendorCacheRoot)
      : null;
  const materializeVendorPrerequisites = async (
    stageRoot?: string,
    materializeCacheRoot: string = vendorCacheRoot,
  ): Promise<void> => {
    // Preserve the historical order to avoid multiplying first-build resource
    // pressure when several large vendor sets are cold simultaneously.
    if (dynamic) {
      const cachedArchive = engineArchivePath(
        sanitize,
        driver,
        vendorBuildIdentity,
        materializeCacheRoot,
      );
      protectCachedArtifact(cacheWarmPaths, cachedArchive);
      const materialize = async (): Promise<string[]> => [
        await ensureEngineArchive(sanitize, driver, vendorBuildIdentity, materializeCacheRoot),
      ];
      const paths = stageRoot === undefined
        ? await materialize()
        : await stageVendorInputs(materialize, join(stageRoot, "engine"));
      engineArchive = paths[0]!;
    }
    if (tls) {
      const cachedArchive = tlsArchivePath(
        sanitize,
        driver,
        vendorBuildIdentity,
        materializeCacheRoot,
      );
      protectCachedArtifact(cacheWarmPaths, cachedArchive);
      const materialize = async (): Promise<string[]> => [
        await ensureTlsArchive(sanitize, driver, vendorBuildIdentity, materializeCacheRoot),
      ];
      const paths = stageRoot === undefined
        ? await materialize()
        : await stageVendorInputs(materialize, join(stageRoot, "tls"));
      tlsArchive = paths[0]!;
    }
    if (regex && !dynamic) {
      for (const object of lreObjectPaths(
        sanitize,
        driver,
        vendorBuildIdentity,
        materializeCacheRoot,
      )) protectCachedArtifact(cacheWarmPaths, object);
      const materialize = async (): Promise<string[]> =>
        await ensureLreObjects(sanitize, driver, vendorBuildIdentity, materializeCacheRoot);
      lreObjects = stageRoot === undefined
        ? await materialize()
        : await stageVendorInputs(materialize, join(stageRoot, "lre"));
    }
    if (zlibObjects.length > 0) {
      for (const object of zlibObjectPaths(
        sanitize,
        driver,
        vendorBuildIdentity,
        materializeCacheRoot,
      )) protectCachedArtifact(cacheWarmPaths, object);
      const materialize = async (): Promise<string[]> =>
        await ensureZlibObjects(sanitize, driver, vendorBuildIdentity, materializeCacheRoot);
      zlibObjects = stageRoot === undefined
        ? await materialize()
        : await stageVendorInputs(materialize, join(stageRoot, "zlib"));
    }
    if (curlStubDir !== null) {
      protectCachedArtifact(cacheWarmPaths, join(
        curlStubDirPath(driver, vendorBuildIdentity, materializeCacheRoot),
        "libcurl.so",
      ));
      const materialize = async (): Promise<string[]> => [
        join(await ensureCurlStub(driver, vendorBuildIdentity, materializeCacheRoot), "libcurl.so"),
      ];
      const paths = stageRoot === undefined
        ? await materialize()
        : await stageVendorInputs(materialize, join(stageRoot, "curl"));
      curlStubDir = dirname(paths[0]!);
    }
  };
  // rt() maps each runtime source's path on the command line: identity for
  // the historical single invocation, cached-.o substitution on cache misses.
  const buildArgs = (
    rt: (path: string) => string,
    build: {
      programPath?: string;
      outPath?: string;
      compilerVisibleSource?: string;
    } = {},
  ): string[] => [
    "-std=c11",
    ...driver.targetArgs,
    ...threadArgs,
    ...(sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : [optimization === "dev" ? "-O0" : "-O2"]),
    ...(opts.textDecoderLegacy ? ["-DSCR_TEXT_DECODER_LEGACY"] : []),
    "-fno-math-errno",
    // The emitted object model is deliberately type-punned C: a hierarchy
    // upcast is a raw pointer cast, so one object's header (rc, vt) and
    // fields are read and written through BOTH the base and derived struct
    // types (sc_retain_Derived vs sc_release_Base on the same object).
    // C's effective-type rule calls that UB, and clang's TBAA at -O2
    // reorders/elides the rc updates once everything inlines — an upcast
    // identity compare frees the object while a global still owns it.
    // The LLVM backend emits no TBAA metadata, so this flag is also what
    // keeps the two backends' memory semantics identical. Mirrored in the
    // cache-miss cflags below and compileLibArchive — the three option
    // sets must stay in lockstep.
    "-fno-strict-aliasing",
    "-Wno-deprecated-declarations", // ucontext fibers (scr_async.c)
    "-I", rtDir,
    ...runtimeSources.map((f) => rt(join(rtDir, f))),
    ...(opts.copying ? [rt(join(rtDir, "scr_copying.c"))] : []),
    ...(opts.fileHandle ? [rt(join(rtDir, "scr_file_handle.c"))] : []),
    // win32 targets compile the libc-shim TU (stpcpy, arc4random_buf,
    // gmtime_r, strcasestr — the _WIN32 block in scr_runtime.h declares
    // them) and link advapi32 (the CSPRNG RtlGenRandom/SystemFunction036,
    // GetUserNameA), iphlpapi (GetAdaptersAddresses behind
    // os.networkInterfaces), and ws2_32 (inet_ntop there; the socket
    // units ride the same import). Never present on the default path, so
    // the historical line cannot change.
    ...(targetPlatform(driver) === "win32"
      ? [rt(join(rtDir, "scr_win.c")), "-ladvapi32", "-liphlpapi", "-lws2_32"]
      : []),
    // musl deliberately has no libc-identification predefine; resolveCc's
    // SCR_MUSL flag and this target-selected TU travel together.
    ...(isMuslTarget(driver) ? [rt(join(rtDir, "scr_musl.c"))] : []),
    ...(regex
      ? ["-I", vendorEngineDir(), rt(join(rtDir, "scr_regex.c")), ...lreObjects]
      : []),
    ...(opts.assert || regex || opts.symbol ? [rt(join(rtDir, "scr_assert.c"))] : []),
    ...(opts.inspect ? [rt(join(rtDir, "scr_inspect.c"))] : []),
    ...((opts.dynInvoke || nativeFetch) ? [rt(join(rtDir, "scr_dyn_invoke.c"))] : []),
    ...(opts.dc ? [rt(join(rtDir, "scr_dc.c"))] : []),
    ...(opts.dynAsync || opts.dynInvoke || opts.dc || nativeFetch ? [rt(join(rtDir, "scr_async_dyn.c"))] : []),
    // The zlib UNIT (scr_zlib.c) gates on zlib.* IR use; the LINK (system
    // libz on hosts, the vendored per-target objects on cross builds)
    // also serves the native fetch's gzip decoder — spread exactly once.
    ...(opts.zlib
      ? driver.target !== null
        ? ["-I", vendorZlibDir(), rt(join(rtDir, "scr_zlib.c")), ...zlibObjects]
        : [rt(join(rtDir, "scr_zlib.c"))]
      : nativeFetch
        ? driver.target !== null
          ? ["-I", vendorZlibDir(), ...zlibObjects]
          : []
      : []),
    // The zlib ↔ island bridge: only when BOTH halves are in the build
    // (the scr_inspect_island.c pattern) — the emitted main calls its
    // installer exactly then.
    ...(opts.zlib && opts.dynamic ? [rt(join(rtDir, "scr_zlib_island.c"))] : []),
    ...(opts.events ? [rt(join(rtDir, "scr_events.c")), rt(join(rtDir, "scr_readline.c"))] : []),
    ...(opts.emitter ? [rt(join(rtDir, "scr_events_emitter.c"))] : []),
    // The checked-dynamic HANDLE support unit (listener gate + runtime
    // adapter closures): every referencing unit is one of the emitter or
    // net families (http implies net), so handle-free binaries keep
    // their exact size class.
    ...(opts.emitter || net ? [rt(join(rtDir, "scr_dyn_handle.c"))] : []),
    ...(opts.symbol ? [rt(join(rtDir, "scr_symbol.c"))] : []),
    ...(opts.searchParams ? [rt(join(rtDir, "scr_url_params.c"))] : []),
    ...(opts.qs ? [rt(join(rtDir, "scr_qs.c"))] : []),
    ...(opts.parseArgs ? [rt(join(rtDir, "scr_util.c"))] : []),
    ...(opts.stream ? [rt(join(rtDir, "scr_stream.c"))] : []),
    // The readiness-poller backends (scr_platform.h): kqueue on macOS/BSD,
    // epoll on Linux, WSAPoll on Windows — each TU is empty off its
    // platform, so all three link whenever a poller-using unit does and
    // the others cost nothing (ws2_32 rides the unconditional win32 libs
    // above).
    ...(net || opts.dgram
      ? [
          rt(join(rtDir, "scr_loop_kqueue.c")),
          rt(join(rtDir, "scr_loop_epoll.c")),
          rt(join(rtDir, "scr_loop_wsapoll.c")),
        ]
      : []),
    ...(net ? [rt(join(rtDir, "scr_net.c"))] : []),
    ...(http ? [rt(join(rtDir, "scr_http.c"))] : []),
    ...(opts.http2 ?? false ? [rt(join(rtDir, "scr_http2.c"))] : []),
    ...(opts.dgram ? [rt(join(rtDir, "scr_dgram.c"))] : []),
    ...(opts.watch ? [rt(join(rtDir, "scr_watch.c"))] : []),
    ...(opts.foreignFfi ? [rt(join(rtDir, "scr_ffi_queue.c"))] : []),
    ...(opts.nodeTest ? [rt(join(rtDir, "scr_test.c"))] : []),
    // The CA-store unit rides its own gate OR the tls one: scr_tls.c
    // references its default-set override unconditionally.
    ...(tlsCa ? [rt(join(rtDir, "scr_tls_ca.c"))] : []),
    ...(tlsArchive
      ? [
          "-I", join(vendorTlsDir(), "include"),
          rt(join(rtDir, "scr_tls.c")),
          tlsArchive,
          // mbedTLS's win32 entropy poll is BCryptGenRandom (bcrypt.h).
          // The unconditional win32 libs above do not carry it.
          // Never present on the default path, so the historical TLS
          // link line cannot change.
          ...(targetPlatform(driver) === "win32" ? ["-lbcrypt"] : []),
        ]
        : []),
    // scr_tls_ca.c enumerates and PEM-encodes Windows system-store entries.
    // This is independent of the mbedTLS archive: getCACertificates-only
    // programs need crypt32 too, while TLS programs imply the CA unit.
    ...(tlsCa && targetPlatform(driver) === "win32" ? ["-lcrypt32"] : []),
    // Static fetch is the engine-free half of scr_fetch.c. Dynamic builds
    // compile the same source beside scr_island.c below, where its
    // SCR_DYNAMIC half installs the full web surface.
    ...(nativeFetch && !dynamic ? [rt(join(rtDir, "scr_fetch.c"))] : []),
    ...(engineArchive
      ? [
          "-DSCR_DYNAMIC",
          "-I", vendorEngineDir(),
          rt(join(rtDir, "scr_island.c")),
          rt(join(rtDir, "scr_web.c")),
          // The one unit referencing BOTH the island and the inspect
          // engine (insp.jsval): linked exactly when both halves are.
          ...(opts.inspect ? [rt(join(rtDir, "scr_inspect_island.c"))] : []),
          // fetch: the NATIVE bridge by default (its socket/tls/zlib
          // dependencies joined the link above); the curl REFERENCE
          // (SCRIPTC_FETCH_CURL=1) keeps the historical system -lcurl /
          // linux soname-stub arms for one release.
          ...(nativeFetch ? [rt(join(rtDir, "scr_fetch.c"))] : []),
          // The island's node:http/https CLIENT bridge (scr_net_island.c):
          // the one TU referencing both the socket units and the engine —
          // compiled beside the native fetch (scr_fetch_install registers
          // it) and whenever the embedded graph imports node:http/https
          // (the emitted main calls scr_net_island_install exactly then).
          ...(netIsland ? [rt(join(rtDir, "scr_net_island.c"))] : []),
          ...(curlFetch
            ? curlStubDir !== null
              ? ["-I", join(vendorCurlDir(), "include"), rt(join(rtDir, "scr_fetch_curl.c")), `-L${curlStubDir}`, "-lcurl"]
              : [rt(join(rtDir, "scr_fetch_curl.c")), "-lcurl"]
            : []),
          engineArchive,
          // Linux's libm is appended after every input below for GNU ld's
          // left-to-right archive resolution. Other dynamic targets keep
          // the historical engine-adjacent spelling.
          ...(driver.linkArgs.includes("-lm") ? [] : ["-lm"]),
          // ld64 dead-stripping claws back a chunk of the engine archive;
          // harmless elsewhere but only spelled this way on macOS. Keyed on
          // the TARGET platform (= the host on the default path, where this
          // expression is byte-identical to the historical one).
          ...(targetPlatform(driver) === "darwin" ? ["-Wl,-dead_strip"] : []),
          // The PE stack reserve, pinned to the 8MB POSIX main-stack
          // geometry ISL_MAIN_STACK_BUDGET is sized against (4MB engine
          // budget + 4MB excursion margin) — quickjs-ng's own CMake makes
          // the same 8MB choice on Windows. Not left to the driver:
          // classic mingw ld defaults to 2MB (which the budget would blow
          // straight past); zig's lld happens to default to 16MB today,
          // but that is nobody's contract.
          ...(targetPlatform(driver) === "win32" ? ["-Wl,--stack,8388608"] : []),
        ]
      : []),
    // A .ll program TU (the LLVM backend) deliberately carries no target
    // triple (byte-stable output; clang supplies the host/SCRIPTC_TARGET
    // triple exactly as it does for .c) — silence the -Woverride-module
    // note about that. Never present for .c inputs, so the historical C
    // command line cannot change by a byte.
    ...(opts.cPath.endsWith(".ll") ? ["-Wno-override-module"] : []),
    ...(build.compilerVisibleSource !== undefined && build.programPath !== undefined
      ? [
          `-ffile-prefix-map=${build.programPath}=${build.compilerVisibleSource}`,
          "-iquote",
          dirname(resolve(build.compilerVisibleSource)),
        ]
      : []),
    build.programPath ?? opts.cPath,
    ...(opts.linkInputs ?? []),
    ...(opts.systemLibraries ?? []).map((name) => `-l${name}`),
    // GNU ld resolves libraries from left to right and commonly enables
    // --as-needed: host libz must follow scr_zlib.c/scr_fetch.c and every
    // generated/native input that references inflate symbols. Cross
    // builds use vendored zlib objects in the input section above.
    ...(((opts.zlib ?? false) || nativeFetch) && driver.target === null
      ? ["-lz"]
      : []),
    // glibc keeps libm separate from libc. This must trail the generated
    // program and every native FFI input because GNU ld resolves archives
    // from left to right.
    ...driver.linkArgs,
    "-o", build.outPath ?? opts.outPath,
  ];
  // Compile-only flags shared by runtime-object population and the caller-TU
  // dependency probe. They reproduce the option set every TU sees in the
  // historical single clang invocation.
  const cflags = [
    "-std=c11",
    ...driver.targetArgs,
    ...threadArgs,
    ...(sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : [optimization === "dev" ? "-O0" : "-O2"]),
    ...(opts.textDecoderLegacy ? ["-DSCR_TEXT_DECODER_LEGACY"] : []),
    "-fno-math-errno",
    "-fno-strict-aliasing", // the emitted object model type-puns — see buildArgs
    "-Wno-deprecated-declarations",
    "-I", rtDir,
    ...(regex || dynamic ? ["-I", vendorEngineDir()] : []),
    ...(zlibObjects.length > 0 ? ["-I", vendorZlibDir()] : []),
    ...(curlStubDir !== null ? ["-I", join(vendorCurlDir(), "include")] : []),
    ...(tlsArchive !== null ? ["-I", join(vendorTlsDir(), "include")] : []),
    ...(dynamic ? ["-DSCR_DYNAMIC"] : []),
  ];
  const programCompilerArgs = opts.cPath.endsWith(".ll")
    ? [...cflags, "-Wno-override-module"]
    : cflags;
  const programSourceExtension = opts.cPath.endsWith(".ll") ? ".ll" : ".c";
  const ccName = driver.argv.join(" ");
  const runClang = async (args: string[]): Promise<void> => {
    try {
      await execFileAsync(driver.argv[0] ?? "clang", [...driver.argv.slice(1), ...args]);
    } catch (err) {
      const stderr = subprocessFailureDetail(err);
      const guidance =
        (opts.linkInputs?.length ?? 0) > 0 ||
        (opts.systemLibraries?.length ?? 0) > 0
          ? "This build includes native FFI link inputs. Check that every symbol and system library exists, " +
            "that archive/object ordering is correct, and that each input matches the selected target."
          : `This is a scriptc bug (generated C should always compile) unless ` +
            `${ccName} itself is missing/broken.`;
      throw new CcCompileError(
        ccName,
        stderr,
        `${ccName} failed compiling ${opts.cPath}.\n` +
          `${guidance}\n\n${stderr}`,
      );
    }
  };
  const runUncachedBuild = async (): Promise<void> => {
    const privateVendorRoot = transientVendorRoot ?? join(
      tmpdir(),
      `scriptc-vendor-fallback-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      await materializeVendorPrerequisites(undefined, privateVendorRoot);
      await runClang(buildArgs((p) => p));
    } finally {
      await rm(privateVendorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  let runtimeCompilerInvocation: string | null = null;
  let programCompilerInvocation: string | null = null;
  let payloadMetadata: Promise<[string, string, Buffer]> | null = null;
  let compileMetadataStamp: NativeMetadataStamp | null = null;
  const compileMetadataKey =
    root === null || process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] === "1"
    ? null
    : nativeMetadataKey("compile", [
        cacheTargetIdentity(driver),
        toolchainEnv,
        implicitToolchain ?? "<uncached>",
        driver.argv,
        cflags,
        programCompilerArgs,
        programSourceExtension,
      ]);
  if (root !== null) {
    try {
      // These probes inspect disjoint inputs. Start the payload reads here as
      // well so runtime hashing and clang's dry-run traces overlap instead of
      // forming a serial prelude before every cache lookup.
      payloadMetadata = Promise.all([
        Promise.resolve(
          toolchainMetadataStamp?.values["compilerVersion"] ??
            ccVersionOnce(driver.argv, toolchainEnv, true),
        ),
        localArtifact === null
          ? runtimeFingerprint(rtDir)
          : Promise.resolve(localArtifact.runtimeHash),
        localArtifact === null
          ? readFile(opts.cPath)
          : Promise.resolve(localArtifact.programBytes),
      ]);
      compileMetadataStamp = compileMetadataKey === null
        ? null
        : await readNativeMetadataStamp(root, compileMetadataKey);
      if (compileMetadataStamp !== null) {
        runtimeCompilerInvocation = compileMetadataStamp.values["runtimeInvocation"] ?? null;
        programCompilerInvocation = compileMetadataStamp.values["programInvocation"] ?? null;
        if (runtimeCompilerInvocation === null || programCompilerInvocation === null) {
          compileMetadataStamp = null;
        }
      }
      if (compileMetadataStamp === null) {
        const [runtimeInvocation, programInvocation] = await Promise.all([
          effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags),
          programSourceExtension === ".ll"
            ? effectiveCompilerInvocationFingerprint(
                driver,
                toolchainEnv,
                programCompilerArgs,
                programSourceExtension,
              )
            : Promise.resolve(null),
        ]);
        runtimeCompilerInvocation = runtimeInvocation;
        programCompilerInvocation = programInvocation ?? runtimeInvocation;
        if (compileMetadataKey !== null) {
          compileMetadataStamp = await publishNativeMetadataStamp(
            root,
            compileMetadataKey,
            {
              runtimeInvocation: runtimeCompilerInvocation,
              programInvocation: programCompilerInvocation,
            },
            [
              ...fingerprintDependencyPaths(runtimeCompilerInvocation),
              ...fingerprintDependencyPaths(programCompilerInvocation),
            ],
            [runtimeCompilerInvocation, programCompilerInvocation],
          );
        }
      }
    } catch (error) {
      // Preserve the uncached build for wrappers that compile successfully but
      // cannot provide a dry-run trace for the real build flavor.
      if (cacheWarmOnly) {
        throw new Error("native cache warming could not validate the compiler invocation", {
          cause: error,
        });
      }
      root = null;
    }
  }

  if (root === null) {
    // The exact historical command line, byte for byte.
    await runUncachedBuild();
    return;
  }

  let cv: string;
  let fingerprint: string;
  let cBytes: Buffer;
  try {
    [cv, fingerprint, cBytes] = await (payloadMetadata ?? Promise.all([
      ccVersionOnce(driver.argv, toolchainEnv, true),
      runtimeFingerprint(rtDir),
      readFile(opts.cPath),
    ]));
  } catch (error) {
    // A version/fingerprint probe is an optimization boundary. If the compiler
    // itself can still compile, preserve the pre-cache behavior instead of
    // surfacing a metadata command's failure as the build result.
    if (cacheWarmOnly) {
      throw new Error("native cache warming could not validate cache inputs", {
        cause: error,
      });
    }
    await runUncachedBuild();
    return;
  }
  // Caller-supplied native inputs can all hide mutable dependencies: `-l`
  // resolves through ambient search paths, while a thin archive or linker
  // script can retain identical top-level bytes as its referenced files are
  // rebuilt. Keep the safe runtime-object cache, but force a fresh final link
  // whenever the caller supplies either form.
  let cacheCompleteArtifact =
    !cacheWarmOnly &&
    cachePolicy.completeArtifacts &&
    (opts.linkInputs?.length ?? 0) === 0 &&
    (opts.systemLibraries?.length ?? 0) === 0;
  let programDependencies: string | null = null;
  const linkProbeArgs = [
    ...(sanitize ? ["-fsanitize=address"] : []),
    ...threadArgs,
    ...(targetPlatform(driver) === "win32"
      ? ["-ladvapi32", "-liphlpapi", "-lws2_32"]
      : []),
    ...(tls && targetPlatform(driver) === "win32" ? ["-lbcrypt"] : []),
    ...(tlsCa && targetPlatform(driver) === "win32" ? ["-lcrypt32"] : []),
    ...(curlFetch && driver.target === null ? ["-lcurl"] : []),
    ...(dynamic && !driver.linkArgs.includes("-lm") ? ["-lm"] : []),
    ...(((opts.zlib ?? false) || nativeFetch) && driver.target === null ? ["-lz"] : []),
    ...driver.linkArgs,
  ];
  // Both the wrapper dry run and dependency trace need the real build's
  // compile/link flag shape: wrappers commonly inject flags or native inputs
  // conditionally on optimization, sanitizer, dynamic, or platform switches.
  const effectiveLinkInvocationArgs = [
    ...programCompilerArgs,
    ...(targetPlatform(driver) === "win32"
      ? ["-ladvapi32", "-liphlpapi", "-lws2_32"]
      : []),
    ...(tls && targetPlatform(driver) === "win32" ? ["-lbcrypt"] : []),
    ...(tlsCa && targetPlatform(driver) === "win32" ? ["-lcrypt32"] : []),
    ...(curlStubDir !== null ? [`-L${curlStubDir}`] : []),
    ...(curlFetch && driver.target === null ? ["-lcurl"] : []),
    ...(dynamic && !driver.linkArgs.includes("-lm") ? ["-lm"] : []),
    ...(dynamic && targetPlatform(driver) === "darwin" ? ["-Wl,-dead_strip"] : []),
    ...(dynamic && targetPlatform(driver) === "win32"
      ? ["-Wl,--stack,8388608"]
      : []),
    ...(((opts.zlib ?? false) || nativeFetch) && driver.target === null ? ["-lz"] : []),
    ...driver.linkArgs,
  ];
  // A complete hit is checked before cross-target curl's generated import stub
  // is materialized. Its -L spelling still joins the dry-run identity, while
  // the real trace omits only that not-yet-existing scriptc-owned directory.
  const linkTraceInvocationArgs =
    curlStubDir === null
      ? effectiveLinkInvocationArgs
      : effectiveLinkInvocationArgs.filter((arg) => arg !== `-L${curlStubDir}`);
  let implicitLinker: string | null = null;
  let preBuildDependencies: NativeArtifactDependency[] | null = null;
  let localArtifactDependencyPaths: string[] | null = null;
  let linkMetadataStamp: NativeMetadataStamp | null = null;
  const linkMetadataKey =
    root === null || process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] === "1"
    ? null
    : nativeMetadataKey("link", [
        cacheTargetIdentity(driver),
        toolchainEnv,
        implicitToolchain ?? "<uncached>",
        runtimeCompilerInvocation ?? "<uncached>",
        programCompilerInvocation ?? "<uncached>",
        driver.argv,
        linkProbeArgs,
        effectiveLinkInvocationArgs,
        linkTraceInvocationArgs,
        ...(programShardMergeIdentity === null ? [] : [programShardMergeIdentity]),
      ]);
  if (cacheCompleteArtifact) {
    try {
      // Header discovery and linker tracing are independent subprocess trees.
      // Running them together removes one complete probe round-trip from both
      // cache hits and ordinary edit/build misses without changing either key.
      linkMetadataStamp = linkMetadataKey === null
        ? null
        : await readNativeMetadataStamp(root, linkMetadataKey);
      if (linkMetadataStamp !== null) {
        implicitLinker = linkMetadataStamp.values["implicitLinker"] ?? null;
        if (implicitLinker === null) linkMetadataStamp = null;
      }
      [programDependencies, implicitLinker] = await Promise.all([
        translationUnitDependencyFingerprint(
          driver,
          cflags,
          opts.cPath,
          cBytes,
          toolchainEnv,
        ),
        linkMetadataStamp === null
          ? implicitLinkerFingerprint(
              driver,
              toolchainEnv,
              linkProbeArgs,
              effectiveLinkInvocationArgs,
              linkTraceInvocationArgs,
            )
          : Promise.resolve(implicitLinker!),
      ]);
      if (linkMetadataStamp === null && linkMetadataKey !== null) {
        linkMetadataStamp = await publishNativeMetadataStamp(
          root,
          linkMetadataKey,
          { implicitLinker },
          fingerprintDependencyPaths(implicitLinker),
          [implicitLinker],
        );
      }
      preBuildDependencies = await snapshotLocalArtifactDependencies([
        ...(await runtimeFingerprintInputPaths(rtDir)),
        ...(toolchainMetadataStamp?.dependencies.map((dependency) => dependency.path) ??
          fingerprintDependencyPaths(implicitToolchain!)),
        ...(compileMetadataStamp?.dependencies.map((dependency) => dependency.path) ?? []),
        ...(linkMetadataStamp?.dependencies.map((dependency) => dependency.path) ??
          fingerprintDependencyPaths(implicitLinker!)),
        ...fingerprintDependencyPaths(programDependencies),
        ...(programShardMergeIdentity === null
          ? []
          : fingerprintDependencyPaths(programShardMergeIdentity)),
      ]);
      // Every content-bearing fingerprint was computed before this metadata
      // snapshot. Re-read those exact files now so the snapshot cannot certify
      // bytes that changed after hashing but before the final compile starts.
      if (!(await fingerprintDependenciesStillMatch([
        implicitToolchain!,
        runtimeCompilerInvocation!,
        programCompilerInvocation!,
        implicitLinker!,
        programDependencies,
        ...(programShardMergeIdentity === null ? [] : [programShardMergeIdentity]),
      ])) ||
        await runtimeFingerprint(rtDir).catch(() => null) !== fingerprint ||
        !(await Promise.all(
          [toolchainMetadataStamp, compileMetadataStamp, linkMetadataStamp]
            .filter((stamp): stamp is NativeMetadataStamp => stamp !== null)
            .map((stamp) => nativeArtifactDependenciesStillMatch(stamp.dependencies)),
        )).every(Boolean)) {
        throw new CacheInputsChangedError();
      }
      if (localArtifact !== null) {
        // Native metadata stamps persist their dependency paths across CLI
        // processes; fingerprintDependencyPaths deliberately does not. Build
        // the output-local stamp from this complete validated snapshot so a
        // source edit in a fresh process cannot replace it with only the two
        // process-local fallback paths.
        localArtifactDependencyPaths = [
          localArtifact.compilerPath,
          dirname(resolve(opts.cPath)),
          ...preBuildDependencies.map((dependency) => dependency.path),
        ];
      }
    } catch {
      // Program-header discovery and linker tracing are both required for a
      // complete hit. Runtime objects remain safely cacheable if either probe
      // is unavailable.
      cacheCompleteArtifact = false;
      preBuildDependencies = null;
      localArtifactDependencyPaths = null;
    }
  }
  // Warm-only builds deliberately do not need linker/header identity for a
  // complete executable, but they still need a stable runtime-object key.
  // The ordinary complete-artifact path computes these values above.
  if (cacheWarmOnly && preBuildDependencies === null) {
    try {
      const [dependencies, invocation] = await Promise.all([
        translationUnitDependencyFingerprint(
          driver,
          cflags,
          opts.cPath,
          cBytes,
          toolchainEnv,
        ),
        effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags),
      ]);
      programDependencies = dependencies;
      if (runtimeCompilerInvocation === null) runtimeCompilerInvocation = invocation;
    } catch (error) {
      throw new Error("native cache warming could not validate runtime-object inputs", {
        cause: error,
      });
    }
  }
  const binDir = join(root, "bin");
  let keyHex: string | null = null;
  let cachedBin: string | null = null;
  if (cacheCompleteArtifact) {
    // The key sees the full command line with the two program-specific paths
    // normalized out. The C bytes are hashed separately; Darwin additionally
    // keys the output basename because ld embeds it in the ad-hoc signature.
    // Runtime and vendor paths stay verbatim — their contents are covered by
    // the fingerprint and the pin.
    const identityArgs = buildArgs((p) => p).map((a) =>
      a === opts.cPath ? "<program.c>" : a === opts.outPath ? "<out>" : a,
    );
    const key = createHash("sha256")
      // Sharded dev builds need the v10 identity below. Canonical single-TU
      // builds retain v9 so adding the opt-in mode does not evict release
      // binaries compiled by an earlier scriptc.
      .update(programShards === null ? "bin-v9\0" : "bin-v10\0")
      .update(cacheTargetIdentity(driver)).update("\0")
      .update(toolchainEnv).update("\0")
      .update(implicitToolchain!).update("\0")
      .update(runtimeCompilerInvocation!).update("\0")
      .update(programCompilerInvocation!).update("\0")
      .update(implicitLinker!).update("\0")
      .update(programDependencies!).update("\0")
      .update(opts.cacheIdentity!).update("\0")
      // Preserve both the spelling clang sees (__FILE__) and the location used
      // to resolve relative includes. The top-level bytes are not sufficient.
      .update(opts.cPath).update("\0")
      .update(resolve(opts.cPath)).update("\0")
      .update(targetPlatform(driver) === "darwin" ? basename(opts.outPath) : "<out>").update("\0")
      // The driver spelling joins the version string: `zig cc --version`
      // reports the clang underneath and could otherwise collide with a
      // same-version host clang.
      .update(ccName).update("\0")
      .update(cv).update("\0")
      .update(fingerprint).update("\0")
      .update(identityArgs.join("\x1f")).update("\0")
      .update(cBytes);
    if (programShards !== null) {
      updateProgramShardCacheIdentity(
        key,
        programShards,
        programPublicSymbols,
        programShardMergeIdentity ?? undefined,
      );
    }
    keyHex = key.digest("hex");
    cachedBin = join(binDir, keyHex);
    const tmpOut = privateSiblingPath(opts.outPath, "bin-hit");
    try {
      // NEVER copy over outPath in place: overwriting an already-executed
      // signed binary invalidates the kernel's per-vnode code-signature cache
      // on macOS and the next exec dies with SIGKILL. Copy to a fresh inode
      // and rename it into place instead.
      if (!(await copyValidCachedFile(cachedBin, tmpOut))) {
        throw new Error("invalid cached executable");
      }
      // Match a fresh linker output under the caller's current umask. Reusing a
      // cache entry populated by a less restrictive shell must not widen access.
      await chmod(tmpOut, 0o777 & ~process.umask());
      await rename(tmpOut, opts.outPath);
      if (localArtifact !== null && localArtifactDependencyPaths !== null) {
        const stamp = await publishLocalArtifactStamp(
          localArtifact.stampPath,
          opts.outPath,
          localArtifact.key,
          localArtifactDependencyPaths,
          [dirname(resolve(opts.cPath))],
          [root],
        ).catch(() => null);
        if (stamp !== null) {
          await opts.onArtifactReady?.({ dependencies: stamp.dependencies }).catch(() => undefined);
        }
      }
      return; // hit: the program/runtime payload compile and link were skipped
    } catch {
      await rm(tmpOut, { force: true }).catch(() => undefined);
      /* miss — build below, then publish */
    }
  }

  // Miss: link the program's own TU against cached per-flavor runtime objects.
  // Collect the runtime sources this build actually compiles (the same
  // conditionals as the command line, by construction).
  const rtInputs: string[] = [];
  buildArgs((p) => {
    rtInputs.push(p);
    return p;
  });
  const buildDir = await mkdtemp(join(tmpdir(), "scriptc-cache-build-"));
  try {
    await materializeVendorPrerequisites(join(buildDir, "vendor-inputs"));
    // Freeze the exact bytes used for the key. Generated TUs live at stable
    // paths under .scriptc/, so two builds can otherwise overwrite that path
    // between hashing and clang and publish one invocation's code under the
    // other's key. The prefix map preserves the original __FILE__/debug-file
    // spelling while clang reads this invocation-private snapshot.
    const programPath = join(buildDir, `program${opts.cPath.endsWith(".ll") ? ".ll" : ".c"}`);
    // Preserve the caller-visible basename while keeping Darwin builds on a
    // private inode: ld uses this spelling as the embedded ad-hoc signing
    // identifier. Other targets retain the basename-independent cache key.
    const privateOut = join(
      buildDir,
      targetPlatform(driver) === "darwin"
        ? basename(opts.outPath)
        : process.platform === "win32"
          ? "artifact.exe"
          : "artifact",
    );
    await writeFile(programPath, cBytes);

    let objects: Map<string, string> | null = null;
    let cacheInputsStable = true;
    let strictObjectVerification: Promise<boolean> | null = null;
    const objectImplicitToolchainStillMatches = (): Promise<boolean> => {
      if (preBuildDependencies !== null) {
        return nativeArtifactDependenciesStillMatch(preBuildDependencies);
      }
      // Complete-artifact caching can be disabled by caller-owned native
      // inputs while the safe runtime-object tier remains active. Preserve its
      // strict discovery fallback in that posture.
      strictObjectVerification ??= Promise.all([
        runtimeFingerprint(rtDir),
        implicitToolchainFingerprint(driver, toolchainEnv),
        effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags),
      ]).then(
        ([currentRuntime, currentImplicit, currentInvocation]) =>
          currentRuntime === fingerprint &&
          currentImplicit === implicitToolchain &&
          currentInvocation === runtimeCompilerInvocation,
        () => false,
      );
      return strictObjectVerification;
    };
    try {
      const cached = await ensureRuntimeObjects(
        root,
        driver.argv,
        cflags,
        rtInputs,
        `obj-v5\0${cacheTargetIdentity(driver)}\0${toolchainEnv}\0${implicitToolchain}\0${runtimeCompilerInvocation}\0${ccName}\0${cv}\0${fingerprint}\0`,
        async () =>
          await objectImplicitToolchainStillMatches(),
        cacheWarmPaths,
      );
      objects = await stageRuntimeObjects(cached, join(buildDir, "runtime-objects"));
    } catch (err) {
      if (err instanceof CacheInputsChangedError) cacheInputsStable = false;
      if (cacheWarmOnly) {
        throw new Error("native cache warming could not persist runtime objects", {
          cause: err,
        });
      }
      objects = null; // cache trouble is never a build failure
    }

    const compileShardedProgram = async (): Promise<string | null> => {
      if (
        programShards === null || programPublicSymbols === undefined ||
        programCompilerInvocation === null || implicitCompileToolchain === null
      ) return null;
      try {
        const programDependencyHash = programDependencies ??
          await translationUnitDependencyFingerprint(
            driver,
            cflags,
            opts.cPath,
            cBytes,
            toolchainEnv,
          );
        const stem = basename(opts.cPath, ".ll");
        const entries = programShards.map((shard, index) => {
          const sourcePath = join(buildDir, shard.name);
          const staged = join(
            buildDir,
            `${stem}.program-${index.toString().padStart(3, "0")}.o`,
          );
          const key = createHash("sha256")
            .update("exe-program-shard-v1\0")
            .update(cacheTargetIdentity(driver)).update("\0")
            .update(toolchainEnv).update("\0")
            .update(implicitCompileToolchain).update("\0")
            .update(programCompilerInvocation).update("\0")
            .update(opts.cacheIdentity!).update("\0")
            .update(driver.argv.join("\x1f")).update("\0")
            .update(cv).update("\0")
            .update(fingerprint).update("\0")
            .update(programDependencyHash).update("\0")
            .update(programCompilerArgs.join("\x1f")).update("\0")
            .update(opts.cPath).update("\0")
            .update(resolve(opts.cPath)).update("\0")
            .update(shard.name).update("\0")
            .update(shard.source)
            .digest("hex");
          return {
            ...shard,
            sourcePath,
            staged,
            cachePath: join(root, "program-shard", key),
            missed: false,
          };
        });
        const shardWidth = Math.min(8, availableParallelism());
        for (let i = 0; i < entries.length; i += shardWidth) {
          await Promise.all(entries.slice(i, i + shardWidth).map(async (entry) => {
            await writeFile(entry.sourcePath, entry.source);
            if (await copyValidCachedFile(entry.cachePath, entry.staged)) return;
            entry.missed = true;
            await runClang([
              ...programCompilerArgs,
              `-ffile-prefix-map=${entry.sourcePath}=${opts.cPath}`,
              "-c",
              entry.sourcePath,
              "-o",
              entry.staged,
            ]);
          }));
        }
        const arArgv = driver.argv[0] === "zig" ? [driver.argv[0]!, "ar"] : ["ar"];
        const merged = await localizeLibraryObjects(
          driver,
          arArgv,
          buildDir,
          entries.map((entry) => entry.staged),
          [],
          programPublicSymbols,
          `${stem}.program`,
        );
        const publishable = entries.filter((entry) => entry.missed);
        if (publishable.length > 0) {
          try {
            const [currentRuntime, currentFingerprints, currentInvocation, currentDependencies, currentCompiler, currentMerge] =
              await Promise.all([
                runtimeFingerprint(rtDir),
                implicitToolchainFingerprints(driver, toolchainEnv),
                effectiveCompilerInvocationFingerprint(
                  driver,
                  toolchainEnv,
                  programCompilerArgs,
                  ".ll",
                ),
                translationUnitDependencyFingerprint(
                  driver,
                  cflags,
                  opts.cPath,
                  cBytes,
                  toolchainEnv,
                ),
                ccVersionOnce(driver.argv, toolchainEnv, true),
                resolveProgramShardMergeIdentity(driver),
              ]);
            if (
              currentRuntime === fingerprint &&
              currentFingerprints.compile === implicitCompileToolchain &&
              currentInvocation === programCompilerInvocation &&
              currentDependencies === programDependencyHash &&
              currentCompiler === cv &&
              currentMerge === programShardMergeIdentity
            ) {
              await Promise.all(
                publishable.map((entry) => publishCachedFile(entry.staged, entry.cachePath)),
              );
            }
          } catch {
            // The merged object is valid for this invocation; publication is
            // only an optimization for later edits.
          }
        }
        return merged;
      } catch {
        // Sharding is an optimization. Compile/link the canonical TU below if
        // a target tool, one shard, or relocatable merge is unavailable.
        return null;
      }
    };
    const shardedProgramObject = await compileShardedProgram();
    if (programShards !== null && shardedProgramObject === null) {
      // The canonical TU fallback is valid output, but it must not populate a
      // cache key describing a successful shard projection/merge.
      cacheInputsStable = false;
    }
    await runClang(
      buildArgs(
        (p) => objects?.get(p) ?? p,
        shardedProgramObject === null
          ? { programPath, outPath: privateOut, compilerVisibleSource: opts.cPath }
          : { programPath: shardedProgramObject, outPath: privateOut },
      ),
    );
    await installArtifact(privateOut, opts.outPath);

    if (cachedBin !== null && keyHex !== null) {
      // Metadata comparison catches ordinary changes cheaply, but cannot by
      // itself prove the snapshot was taken from the same bytes hashed into
      // the key. Recompute every content-bearing identity after the final link
      // so a header/SDK/compiler change in either pre-build gap cannot publish
      // new output under an old key.
      const [currentRuntime, currentImplicit, currentRuntimeInvocation, currentProgramInvocation, currentProgramDependencies, currentLinker, currentCompiler, currentProgramShardMerge] =
        await Promise.all([
          runtimeFingerprint(rtDir).catch(() => null),
          implicitToolchainFingerprint(driver, toolchainEnv).catch(() => null),
          effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags).catch(
            () => null,
          ),
          effectiveCompilerInvocationFingerprint(
            driver,
            toolchainEnv,
            programCompilerArgs,
            programSourceExtension,
          ).catch(() => null),
          translationUnitDependencyFingerprint(
            driver,
            cflags,
            opts.cPath,
            cBytes,
            toolchainEnv,
          ).catch(() => null),
          implicitLinkerFingerprint(
            driver,
            toolchainEnv,
            linkProbeArgs,
            effectiveLinkInvocationArgs,
            linkTraceInvocationArgs,
          ).catch(() => null),
          ccVersionOnce(driver.argv, toolchainEnv, true).catch(() => null),
          programShards === null
            ? Promise.resolve(null)
            : resolveProgramShardMergeIdentity(driver).catch(() => null),
        ]);
      cacheInputsStable =
        cacheInputsStable &&
        preBuildDependencies !== null &&
        await nativeArtifactDependenciesStillMatch(preBuildDependencies) &&
        currentRuntime === fingerprint &&
        currentImplicit === implicitToolchain &&
        currentRuntimeInvocation === runtimeCompilerInvocation &&
        currentProgramInvocation === programCompilerInvocation &&
        currentProgramDependencies === programDependencies &&
        currentLinker === implicitLinker &&
        currentCompiler === cv &&
        currentProgramShardMerge === programShardMergeIdentity;
    }
    if (cachedBin !== null && keyHex !== null && cacheInputsStable) {
      try {
        // Cache artifacts are data, never execution targets. Publication keeps
        // generated code and embedded literals private; the hit path reapplies
        // the caller's current executable mode to its destination copy.
        await publishCachedFile(privateOut, cachedBin);
      } catch {
        /* publishing is best-effort */
      }
    }
    if (
      localArtifact !== null &&
      localArtifactDependencyPaths !== null &&
      cacheCompleteArtifact &&
      cacheInputsStable
    ) {
      const stamp = await publishLocalArtifactStamp(
        localArtifact.stampPath,
        opts.outPath,
        localArtifact.key,
        localArtifactDependencyPaths,
        [dirname(resolve(opts.cPath))],
        [root],
      ).catch(() => null);
      if (stamp !== null) {
        await opts.onArtifactReady?.({ dependencies: stamp.dependencies }).catch(() => undefined);
      }
    }
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  }
  // Runtime-object population is itself a cache write, including on builds
  // whose native link inputs disable complete-artifact publication.
  await pruneCache(root, cacheWarmPaths).catch(() => undefined);
}

export async function compileC(opts: CcOptions): Promise<void> {
  await compileCInternal(opts, false);
}

export type NativeCacheWarmProfile = "runtime" | "tls" | "dynamic";

export interface WarmNativeCachesOptions {
  /** Native object posture to seed. Defaults to the shipped release/-O2 lane. */
  optimization?: "release" | "dev";
  /** Seed ASan + RC-audit objects instead of the ordinary lane. */
  sanitize?: boolean;
  /** Feature families to seed. Defaults to every expensive native family. */
  profiles?: readonly NativeCacheWarmProfile[];
}

export interface WarmNativeCachesResult {
  cacheRoot: string;
  profiles: { profile: NativeCacheWarmProfile; elapsedMs: number }[];
}

export function supportedNativeCacheWarmProfiles(
  driver: CcDriver,
): readonly NativeCacheWarmProfile[] {
  if (isMobileTarget(driver.target) || targetPlatform(driver) === "wasi") return [];
  return ["runtime", "tls", "dynamic"];
}

/** Populate expensive native prerequisites against the current compiler,
 * target, SDK, and environment. The resulting entries use the exact same
 * identities and validators as ordinary builds; this merely pays their cost
 * before a developer's first program asks for them. Synthetic link products
 * are discarded and never enter the complete-executable cache. */
export async function warmNativeCaches(
  options: WarmNativeCachesOptions = {},
): Promise<WarmNativeCachesResult> {
  const cacheRoot = cacheRootDir();
  if (cacheRoot === null) {
    throw new Error(
      "the native build cache is disabled (unset SCRIPTC_NO_CACHE and use a non-empty SCRIPTC_CACHE_DIR)",
    );
  }
  await ensurePrivateCacheRoot(
    cacheRoot,
    process.env["SCRIPTC_CACHE_DIR"] === undefined,
  );
  const known = new Set<NativeCacheWarmProfile>(["runtime", "tls", "dynamic"]);
  for (const profile of options.profiles ?? []) {
    if (!known.has(profile)) throw new Error(`unknown native cache warm profile '${profile}'`);
  }
  if (options.profiles?.length === 0) return { cacheRoot, profiles: [] };
  const mobileTarget = mobileLibraryTarget();
  if (mobileTarget !== null) {
    throw new Error(
      `native cache warming targets executable builds and is unsupported for SCRIPTC_TARGET=${mobileTarget}`,
    );
  }
  const driver = resolveCc();
  const supported = supportedNativeCacheWarmProfiles(driver);
  if (supported.length === 0) {
    throw new Error(
      `native cache warming targets persistently cached native executables and is unsupported for SCRIPTC_TARGET=${driver.target}`,
    );
  }
  const profiles = [...new Set(options.profiles ?? supported)];
  for (const profile of profiles) {
    if (!supported.includes(profile)) {
      throw new Error(
        `native cache warm profile '${profile}' is unsupported for SCRIPTC_TARGET=${driver.target}`,
      );
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), "scriptc-cache-warm-"));
  const cPath = join(workDir, "warm.c");
  await writeFile(cPath, "int main(void) { return 0; }\n");
  const protectedPaths = new Set<string>();
  try {
    const results = await Promise.all(profiles.map(async (profile) => {
      const started = performance.now();
      await compileCInternal({
        cPath,
        outPath: join(workDir, process.platform === "win32" ? `${profile}.exe` : profile),
        cacheIdentity: "scriptc-native-cache-warm-v1",
        optimization: options.optimization ?? "release",
        sanitize: options.sanitize ?? false,
        ...(profile === "tls" ? { fetch: true } : {}),
        ...(profile === "dynamic" ? { dynamic: true } : {}),
      }, true, protectedPaths);
      return {
        profile,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      };
    }));
    await pruneCache(cacheRoot).catch(() => undefined);
    if (!(await Promise.all([...protectedPaths].map(fileExists))).every(Boolean)) {
      throw new Error(
        `SCRIPTC_CACHE_MAX_MB is too small to retain the requested native cache warm profiles (${profiles.join(", ")})`,
      );
    }
    return { cacheRoot, profiles: results };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
