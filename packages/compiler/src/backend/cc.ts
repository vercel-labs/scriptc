import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUNTIME_SOURCES = ["scr_number.c", "scr_string.c", "scr_array.c", "scr_bytes.c", "scr_bytes_io.c", "scr_map.c", "scr_closure.c", "scr_object.c", "scr_union.c", "scr_exception.c", "scr_error.c", "scr_console.c", "scr_lib.c", "scr_path.c", "scr_url.c", "scr_json.c", "scr_async.c", "scr_child.c", "scr_cycle.c"];

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

export interface CcOptions {
  /** Path of the generated (or hand-written) program TU: a .c file, or the
   * LLVM backend's .ll — clang compiles IR text natively on the same
   * command line, so both ride this one seat. */
  cPath: string;
  /** Path of the native executable to produce. */
  outPath: string;
  /** Build with ASan + the runtime RC audit (test/debug lane). */
  sanitize?: boolean;
  /** Additional native archives/objects, appended after the generated
   * program TU so their symbols resolve outbound FFI calls. */
  linkInputs?: readonly string[];
  /** Driver-neutral system library names, emitted as `-l<name>` after
   * linkInputs. */
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
   * setDefaultCACertificates): compiles scr_tls_ca.c, plain PEM-block
   * bookkeeping with NO mbedTLS dependency, so an introspection-only
   * binary never builds the archive. The unit also compiles whenever
   * `tls` does — scr_tls.c consults its default-set override for the
   * client trust anchors. */
  tlsCa?: boolean;
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

export function runtimeSrcDir(): string {
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
 * adds `-target <triple>` to every compile. Linux-gnu triples also add
 * -D_GNU_SOURCE: glibc hides POSIX/GNU declarations (kill, realpath, stpcpy,
 * arc4random_buf, posix_spawn_file_actions_addchdir_np, ...) under plain
 * -std=c11, where macOS exposes everything by default. Pin the glibc minor
 * in the triple (e.g. aarch64-linux-gnu.2.36) so the binary runs on the
 * differential container's distro (see docs/linux-port.md).
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
 * buildEngineArchiveCross — host zlib builds still link the system libz,
 * byte-identically).
 * Windows triples (x86_64-windows-gnu, mingw-w64 headers and CRT via zig)
 * have no gates left: events, net/http, fetch, watch, zlib, dgram/dns,
 * tls, and the engine archive (--dynamic) all build per target through
 * their win32 arms (mbedTLS compiles unchanged for the triple — its own _WIN32
 * port covers entropy and timing; the archive link adds -lbcrypt for
 * BCryptGenRandom there). They additionally compile
 * scr_win.c, the win32 libc shim TU (stpcpy, arc4random_buf — see the
 * _WIN32 block in scr_runtime.h), linking -ladvapi32 for its CSPRNG
 * (RtlGenRandom) and GetUserNameA. Native zigcc builds (no SCRIPTC_TARGET)
 * support everything: same platform, same archives, just a different
 * driver binary. */
export interface CcDriver {
  /** The compiler argv prefix: ["clang"] (default) or ["zig", "cc"]. */
  argv: string[];
  /** The SCRIPTC_TARGET triple, or null for a host-native build. */
  target: string | null;
  /** Extra compile args the produced platform demands. */
  targetArgs: string[];
  /** Platform libraries appended after every object/archive input. */
  linkArgs: string[];
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
    return { argv: ["clang"], target: null, ...hostArgs };
  }
  if (cc !== "zigcc") {
    throw new Error(`unknown SCRIPTC_CC '${cc}' (supported: clang, zigcc)`);
  }
  if (target === "") return { argv: ["zig", "cc"], target: null, ...hostArgs };
  const linux = target.includes("linux");
  const musl = linux && target.includes("musl");
  return {
    argv: ["zig", "cc"],
    target,
    targetArgs: [
      "-target", target,
      ...(linux ? ["-D_GNU_SOURCE"] : []),
      ...(musl ? ["-DSCR_MUSL"] : []),
    ],
    linkArgs: linux ? ["-lm"] : [],
  };
}

/** The OS the produced binary runs on: the triple's OS under SCRIPTC_TARGET,
 * the host's otherwise — so platform-conditional link flags follow the
 * TARGET, not the machine running the compiler. Exported for compile()/
 * analyze(): the FRONTEND consults it too (path.sep / os.EOL literals and
 * the path-module binding follow the target — a win32 triple compiles
 * Node-on-Windows semantics, path.win32 backing the bare module). */
export function targetPlatform(driver: CcDriver): string {
  if (driver.target === null) return process.platform;
  if (driver.target.includes("linux")) return "linux";
  if (driver.target.includes("windows")) return "win32";
  return driver.target.includes("macos") || driver.target.includes("darwin") ? "darwin" : "other";
}

function vendorEngineDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "quickjs-ng");
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** The engine archive for one flavor, built lazily on the first --dynamic
 * compile (~10s) and cached under vendor/.cache/<commit>-<flavor>/ — unlike
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
 * SCRIPTC_TARGET adds a per-target cache flavor built WITHOUT CMake (the
 * mbedTLS recipe): the qjs library target is just four TUs
 * (QJS_ENGINE_SOURCES) compiled with `zig cc -target <triple>` under the
 * same flags CMake's MinSizeRel/Debug+ASan configurations apply, packed
 * with `zig ar`. Host builds keep the exact historical CMake recipe. */
async function ensureEngineArchive(sanitize: boolean, driver: CcDriver): Promise<string> {
  const flavor = `${sanitize ? "asan" : "plain"}${driver.target !== null ? `-${driver.target}` : ""}`;
  const vendor = vendorEngineDir();
  const cacheRoot = join(vendor, "..", ".cache");
  const cacheDir = join(cacheRoot, `${QJS_COMMIT.slice(0, 12)}-${flavor}`);
  const archive = join(cacheDir, "libqjs.a");
  if (await fileExists(archive)) return archive;
  if (driver.target !== null) return buildEngineArchiveCross(sanitize, driver, cacheRoot, cacheDir);

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(cacheRoot, `build-${flavor}-`));
  const stageDir = `${buildDir}.stage`;
  try {
    const configureArgs = [
      "-S", vendor,
      "-B", buildDir,
      ...(sanitize
        ? ["-DCMAKE_BUILD_TYPE=Debug", "-DQJS_ENABLE_ASAN=ON"]
        : ["-DCMAKE_BUILD_TYPE=MinSizeRel"]),
      "-DQJS_BUILD_EXAMPLES=OFF",
      "-DQJS_ENABLE_INSTALL=OFF",
    ];
    try {
      await execFileAsync("cmake", configureArgs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "--dynamic builds the embedded engine once with CMake, which was not found on PATH.\n" +
            "Install cmake (e.g. `brew install cmake`) and retry. Static builds do not need it.",
        );
      }
      throw new Error(
        `cmake failed configuring the embedded engine (${vendor}).\n\n` +
          `${(err as { stderr?: string }).stderr ?? String(err)}`,
      );
    }
    await execFileAsync("cmake", [
      "--build", buildDir,
      "--target", "qjs",
      `-j${availableParallelism()}`,
    ]);
    // Publish only the archive, atomically: rename fails if a concurrent
    // build won the race, and the winner's archive is just as good.
    await mkdir(stageDir);
    await copyFile(join(buildDir, "libqjs.a"), join(stageDir, "libqjs.a"));
    await rename(stageDir, cacheDir).catch(() => undefined);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
    await rm(stageDir, { recursive: true, force: true });
  }
  return archive;
}

/** The qjs library target's source list (CMakeLists.txt `qjs_sources` with
 * QJS_BUILD_LIBC off — cutils is header-only): the cross-build recipe
 * compiles exactly these. */
const QJS_ENGINE_SOURCES = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];

/** The engine archive for a CROSS target, per-TU `zig cc` compiles + `zig
 * ar` (no CMake — the mbedTLS recipe). The flags mirror what the CMake
 * configurations apply to the qjs library target: gnu11 (CMAKE_C_EXTENSIONS
 * ON), hidden visibility, -funsigned-char, -DQUICKJS_NG_BUILD and
 * -D_GNU_SOURCE (qjs_defines; linux targetArgs already carry the latter),
 * then MinSizeRel (-Os -DNDEBUG) for plain or Debug+QJS_ENABLE_ASAN
 * (-O0 -ggdb -fno-omit-frame-pointer -fsanitize=address
 * -fno-sanitize-recover=all) for asan. Same atomic-rename publish as every
 * vendor cache. */
async function buildEngineArchiveCross(sanitize: boolean, driver: CcDriver, cacheRoot: string, cacheDir: string): Promise<string> {
  const vendor = vendorEngineDir();
  const archive = join(cacheDir, "libqjs.a");
  const arArgv = [...driver.argv.slice(0, 1), "ar"];
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
  const buildDir = await mkdtemp(join(cacheRoot, `build-qjs-${driver.target ?? "host"}-`));
  try {
    const width = Math.min(QJS_ENGINE_SOURCES.length, availableParallelism());
    for (let i = 0; i < QJS_ENGINE_SOURCES.length; i += width) {
      await Promise.all(
        QJS_ENGINE_SOURCES.slice(i, i + width).map((src) =>
          execFileAsync(
            driver.argv[0] ?? "clang",
            [...driver.argv.slice(1), ...cflags, "-c", join(vendor, src), "-o", join(buildDir, `${basename(src, ".c")}.o`)],
            { cwd: buildDir },
          ),
        ),
      );
    }
    await execFileAsync(arArgv[0] ?? "ar", [...arArgv.slice(1), "rcs", join(buildDir, "libqjs.a"), ...QJS_ENGINE_SOURCES.map((s) => join(buildDir, `${basename(s, ".c")}.o`))]);
    // Atomic publish: rename fails if a concurrent build won the race, and
    // the winner's archive is just as good.
    const stageDir = `${buildDir}.stage`;
    await mkdir(stageDir);
    await copyFile(join(buildDir, "libqjs.a"), join(stageDir, "libqjs.a"));
    await rename(stageDir, cacheDir).catch(async () => {
      await rm(stageDir, { recursive: true, force: true });
    });
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

/** The libregexp objects for one flavor, compiled lazily on the first
 * regex-using static build (~1s) and cached like the engine archive —
 * vendor/.cache/<commit>-lre-<flavor>/*.o — with the same atomic-rename
 * publish (parallel first builds race safely; losers discard their work).
 * Plain is -Os (size class matters: the regex fence pins regex-using
 * binaries well under the engine class); asan matches the final link so
 * the sanitized lane instruments the matcher too. Cross targets get their
 * own flavor directory, compiled with the SCRIPTC_CC driver and its target
 * args — libregexp/libunicode are plain C11, so the cross story is exactly
 * the runtime sources' (no host-built inputs); vendored SOURCES are
 * untouched, only the build wiring knows about targets. */
async function ensureLreObjects(sanitize: boolean, driver: CcDriver): Promise<string[]> {
  const pic = driver.target?.includes("musl") ?? false;
  // The flavor keys the DRIVER as well as the target: a zig-cc-built object
  // set must never be handed to a clang link (or vice versa) off a shared
  // cache directory — the historical `lre-plain`/`lre-asan` names stay
  // clang's alone.
  const flavor =
    (sanitize ? "asan" : "plain") +
    (driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc") +
    (driver.target !== null ? `-${driver.target}` : "") +
    (pic ? "-pic" : "");
  const vendor = vendorEngineDir();
  const cacheRoot = join(vendor, "..", ".cache");
  const cacheDir = join(cacheRoot, `${QJS_COMMIT.slice(0, 12)}-lre-${flavor}`);
  const objects = LRE_SOURCES.map((f) => join(cacheDir, f.replace(/\.c$/, ".o")));
  if ((await Promise.all(objects.map(fileExists))).every(Boolean)) return objects;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(cacheRoot, `build-lre-${flavor}-`));
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
          ...(pic ? ["-fPIC"] : []),
          ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-Os"]),
          "-I", vendor,
          "-c", join(vendor, f),
          "-o", join(buildDir, f.replace(/\.c$/, ".o")),
        ],
        { cwd: buildDir },
      );
    }
    // Atomic publish: rename fails if a concurrent build won the race, and
    // the winner's objects are just as good.
    await rename(buildDir, cacheDir).catch(() => undefined);
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

/** The zlib objects for one flavor, compiled lazily on the first zlib-using
 * CROSS build (~1s) and cached like the lre objects —
 * vendor/.cache/zlib-<version>-<flavor>/*.o — with the same atomic-rename
 * publish (parallel first builds race safely; losers discard their work).
 * Plain is -Os, asan matches the final link so the sanitized lane
 * instruments the codec too. The flavor keys the driver and target exactly
 * like the lre flavor: only cross builds call this today, but the keying
 * must never hand a zig-built object set to a clang link off a shared
 * directory. */
async function ensureZlibObjects(sanitize: boolean, driver: CcDriver): Promise<string[]> {
  const pic = driver.target?.includes("musl") ?? false;
  const flavor =
    (sanitize ? "asan" : "plain") +
    (driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc") +
    (driver.target !== null ? `-${driver.target}` : "") +
    (pic ? "-pic" : "");
  const vendor = vendorZlibDir();
  const cacheRoot = join(vendor, "..", ".cache");
  const cacheDir = join(cacheRoot, `zlib-${ZLIB_VERSION}-${flavor}`);
  const objects = ZLIB_SOURCES.map((f) => join(cacheDir, f.replace(/\.c$/, ".o")));
  if ((await Promise.all(objects.map(fileExists))).every(Boolean)) return objects;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(cacheRoot, `build-zlib-${flavor}-`));
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
          ...(pic ? ["-fPIC"] : []),
          ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-Os"]),
          "-I", vendor,
          "-c", join(vendor, f),
          "-o", join(buildDir, f.replace(/\.c$/, ".o")),
        ],
        { cwd: buildDir },
      );
    }
    // Atomic publish: rename fails if a concurrent build won the race, and
    // the winner's objects are just as good.
    await rename(buildDir, cacheDir).catch(() => undefined);
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

/** The libcurl import stub for one CROSS target, generated lazily on the
 * first fetch-using cross build and cached like the zlib objects —
 * vendor/.cache/curl-stub-<target>/libcurl.so, atomic-rename publish. The
 * stub is empty definitions of CURL_STUB_SYMBOLS compiled `-shared` with
 * `-soname libcurl.so.4`: linking against it satisfies scr_fetch_curl.c's
 * references and records a plain `DT_NEEDED libcurl.so.4`, which the
 * TARGET system's real libcurl satisfies at load time (curl's unversioned
 * exports make the classic import-stub technique sound here — nothing
 * from the stub's bodies ever ships in the binary). One stub per target,
 * no sanitize flavor: the stub's code is never executed or instrumented,
 * and asan links against plain shared libraries freely. */
async function ensureCurlStub(driver: CcDriver): Promise<string> {
  const cacheRoot = join(vendorCurlDir(), "..", ".cache");
  const cacheDir = join(cacheRoot, `curl-stub-${driver.target}`);
  const lib = join(cacheDir, "libcurl.so");
  if (await fileExists(lib)) return cacheDir;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(cacheRoot, `build-curl-stub-`));
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
    // Atomic publish: rename fails if a concurrent build won the race, and
    // the winner's stub is just as good.
    const stageDir = `${buildDir}.stage`;
    await mkdir(stageDir);
    await copyFile(join(buildDir, "libcurl.so"), join(stageDir, "libcurl.so"));
    await rename(stageDir, cacheDir).catch(async () => {
      await rm(stageDir, { recursive: true, force: true });
    });
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return cacheDir;
}

function vendorTlsDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "mbedtls");
}

/** The mbedTLS archive for one flavor, compiled lazily on the first
 * TLS-using build (~15s over ~110 TUs, parallelized) and cached like the
 * engine archive — vendor/.cache/mbedtls-<version>-<flavor>/libmbedtls.a —
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
async function ensureTlsArchive(sanitize: boolean, driver: CcDriver): Promise<string> {
  const flavor = `${sanitize ? "asan" : "plain"}${driver.target !== null ? `-${driver.target}` : ""}`;
  const compileArgv = driver.target !== null ? driver.argv : ["clang"];
  const arArgv = driver.target !== null ? [...driver.argv.slice(0, 1), "ar"] : ["ar"];
  const vendor = vendorTlsDir();
  const cacheRoot = join(vendor, "..", ".cache");
  const cacheDir = join(cacheRoot, `mbedtls-${MBEDTLS_VERSION}-${flavor}`);
  const archive = join(cacheDir, "libmbedtls.a");
  if (await fileExists(archive)) return archive;

  await mkdir(cacheRoot, { recursive: true });
  const buildDir = await mkdtemp(join(cacheRoot, `build-mbedtls-${flavor}-`));
  try {
    const sources = (await readdir(join(vendor, "library"))).filter((n) => n.endsWith(".c")).sort();
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
    // Atomic publish: rename fails if a concurrent build won the race, and
    // the winner's archive is just as good.
    const stageDir = `${buildDir}.stage`;
    await mkdir(stageDir);
    await copyFile(join(buildDir, "libmbedtls.a"), join(stageDir, "libmbedtls.a"));
    await rename(stageDir, cacheDir).catch(async () => {
      await rm(stageDir, { recursive: true, force: true });
    });
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
  return archive;
}

/* ── library mode: the static-archive artifact ────────────────────────────
 * One `scriptc build --lib` invocation produces <name>.lib.a: the program TU
 * object plus exactly the runtime objects the program's IR gates in, every
 * TU compiled with -DSCR_LIB (the per-flavor discipline that keeps library
 * objects apart from executable-lane objects — here trivially, because library
 * builds compile fresh into the archive and never touch the object cache).
 * The base set narrows from the executable lane's unconditional sources:
 * scr_async.c (fibers, timers, the loop) and scr_child.c drop — the
 * async_free refusal already guarantees nothing references them — and
 * scr_library.c (sink, arena, reset registry, library funnel) joins. The gated
 * units a library may reach are the pure-data ones (regex + the vendored matcher, assert,
 * inspect, symbol, searchParams, emitter+dyn_handle, zlib); every
 * loop-hooked or ambient unit was refused at SC4005 before emission.
 * External-symbol contract: undefined references only to libc/libm — which
 * is why zlib rides the VENDORED per-flavor objects here even on hosts
 * (the executable lane's system `-lz` cannot ride inside an archive). */

/** The library base: the executable lane's unconditional sources minus the
 * fiber/loop and child-process units, plus the library-mode TU. */
const LIB_RUNTIME_SOURCES = [
  ...RUNTIME_SOURCES.filter((f) => f !== "scr_async.c" && f !== "scr_child.c"),
  "scr_library.c",
];

export interface LibArchiveOptions {
  /** The program TU (.c or .ll — clang compiles either with -c). */
  cPath: string;
  /** The archive to produce (<name>.lib.a). */
  outPath: string;
  sanitize?: boolean;
  /** IR-detected link gates (the compileC precedent, refusal-narrowed). */
  regex?: boolean;
  assert?: boolean;
  inspect?: boolean;
  symbol?: boolean;
  searchParams?: boolean;
  emitter?: boolean;
  zlib?: boolean;
  copying?: boolean;
}

export async function compileLibArchive(opts: LibArchiveOptions): Promise<void> {
  const rtDir = runtimeSrcDir();
  const driver = resolveCc();
  const sanitize = opts.sanitize ?? false;
  if (driver.target !== null && sanitize) {
    throw new Error(
      `SCRIPTC_TARGET=${driver.target}: --sanitize not supported under a cross target yet ` +
        `(target-specific runtime / system inputs — see docs/linux-port.md).`,
    );
  }
  const regex = opts.regex ?? false;
  const lreObjects = regex ? await ensureLreObjects(sanitize, driver) : [];
  const zlibObjects = opts.zlib ? await ensureZlibObjects(sanitize, driver) : [];
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
    ...(driver.target?.includes("musl") ? ["-fPIC"] : []),
    ...(sanitize ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"] : ["-O2"]),
    "-fno-math-errno",
    "-fno-strict-aliasing", // the emitted object model type-puns — see compileC's buildArgs
    "-Wno-deprecated-declarations",
    "-DSCR_LIB",
    "-I", rtDir,
    ...(regex ? ["-I", vendorEngineDir()] : []),
    ...(opts.zlib ? ["-I", vendorZlibDir()] : []),
  ];
  const arArgv = driver.argv[0] === "zig" ? [driver.argv[0]!, "ar"] : ["ar"];
  const buildDir = await mkdtemp(join(tmpdir(), "scriptc-lib-"));
  try {
    const objects: string[] = [];
    const compileOne = async (src: string, objName: string): Promise<void> => {
      const obj = join(buildDir, objName);
      const args = [
        ...driver.argv.slice(1),
        ...cflags,
        ...(src.endsWith(".ll") ? ["-Wno-override-module"] : []),
        "-c", src,
        "-o", obj,
      ];
      try {
        await execFileAsync(driver.argv[0] ?? "clang", args);
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? String(err);
        throw new Error(
          `${driver.argv.join(" ")} failed compiling ${src} for the library archive.\n` +
            `This is a scriptc bug (generated/runtime C should always compile) unless the compiler itself is missing/broken.\n\n${stderr}`,
        );
      }
      objects.push(obj);
    };
    const stem = basename(opts.cPath).replace(/\.(c|ll)$/, "");
    await compileOne(opts.cPath, `${stem}.program.o`);
    const width = Math.min(4, availableParallelism());
    for (let i = 0; i < sources.length; i += width) {
      await Promise.all(sources.slice(i, i + width).map((f) => compileOne(join(rtDir, f), f.replace(/\.c$/, ".o"))));
    }
    objects.push(...lreObjects, ...zlibObjects);
    await rm(opts.outPath, { force: true }); // `ar r` would append into a stale archive
    await mkdir(dirname(opts.outPath), { recursive: true });
    await execFileAsync(arArgv[0] ?? "ar", [...arArgv.slice(1), "rcs", opts.outPath, ...objects]);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

/* ------------------- build cache (opt-in via SCRIPTC_CACHE_DIR) ----------------
 * Content-addressed caches that let repeat builds of unchanged programs skip
 * clang entirely — the test lanes' dominant cost. Two keyspaces under the
 * cache root:
 *
 *   bin/<key>       — whole program binaries. key = sha256(clang version,
 *                     runtime fingerprint (every .c/.h in the runtime src dir
 *                     plus the vendor pin QJS_COMMIT), the FULL normalized
 *                     command line, the emitted C bytes). Emitted C is
 *                     byte-stable by project invariant, so unchanged programs
 *                     hit; any flag difference — e.g. the sanitized lane's
 *                     -O1/-fsanitize=address/-DSCR_RC_AUDIT — lands in a
 *                     naturally distinct key. On a hit the cached binary is
 *                     copied and atomically renamed onto outPath (never an
 *                     in-place overwrite — see the hit path) and clang never
 *                     runs; the binary is still EXECUTED live by whoever
 *                     asked for it, so no comparison or sanitizer coverage
 *                     is ever skipped.
 *
 *   obj/<set>/<f>.o — per-flavor runtime objects for cache-miss builds. The
 *                     historical single invocation recompiles every runtime
 *                     TU per program (~1.3s at -O2); with cached objects a
 *                     miss compiles ONLY the program's C and links (~0.15s).
 *                     The clang driver hands every input the same option set,
 *                     so per-TU `-c` compiles with those options plus a final
 *                     link reproduce the single invocation exactly. Object
 *                     compiles go through ccache when it is installed (silent
 *                     fallback when not).
 *
 * Escape hatches, honored in BOTH directions (no reads, no writes): leave
 * SCRIPTC_CACHE_DIR unset (the production default — the CLI never caches unless
 * asked; vitest.config.ts sets it for the test lanes) or set SCRIPTC_NO_CACHE=1.
 * Either way compileC issues the exact historical command line.
 *
 * Eviction: size-capped LRU over the whole cache root (SCRIPTC_CACHE_MAX_MB,
 * default 4096) swept at most once per process after a write; reads bump
 * mtimes. The harness's oracle cache lives under the same root and is swept
 * by the same pass. Cache trouble is never a build failure — every cache
 * error falls back to a real compile. */

function cacheRootDir(): string | null {
  if (process.env["SCRIPTC_NO_CACHE"] === "1") return null;
  const dir = process.env["SCRIPTC_CACHE_DIR"];
  return dir !== undefined && dir !== "" ? dir : null;
}

const ccVersionMemos = new Map<string, Promise<string>>();
function ccVersionOnce(argv: string[]): Promise<string> {
  const key = argv.join("\x1f");
  let memo = ccVersionMemos.get(key);
  if (memo === undefined) {
    // cwd: the version probe must not touch the caller's directory —
    // `zig cc --version` (zig 0.16) drops an empty a.o wherever it runs.
    memo = execFileAsync(argv[0] ?? "clang", [...argv.slice(1), "--version"], { cwd: tmpdir() }).then(
      (r) => r.stdout.split("\n", 1)[0] ?? "",
    );
    ccVersionMemos.set(key, memo);
  }
  return memo;
}

let ccacheMemo: Promise<boolean> | null = null;
function ccacheAvailable(): Promise<boolean> {
  ccacheMemo ??= execFileAsync("ccache", ["--version"]).then(
    () => true,
    () => false,
  );
  return ccacheMemo;
}

/** Content hash of every .c/.h in the runtime src dir plus the vendor pin —
 * everything a binary links that the emitted C bytes don't already cover
 * (npm-embedded C rides inside the emitted C; the engine archive and lre
 * objects are pinned by QJS_COMMIT, the same trust their own caches use).
 * Memoized behind a stat signature so watch-mode edits re-hash. */
let rtFingerprintMemo: { sig: string; hash: string } | null = null;
async function runtimeFingerprint(rtDir: string): Promise<string> {
  const names = (await readdir(rtDir)).filter((n) => n.endsWith(".c") || n.endsWith(".h")).sort();
  const stats = await Promise.all(names.map((n) => stat(join(rtDir, n))));
  const sig = stats.map((s, i) => `${names[i] ?? ""}:${s.size}:${s.mtimeMs}`).join("|");
  if (rtFingerprintMemo !== null && rtFingerprintMemo.sig === sig) return rtFingerprintMemo.hash;
  const h = createHash("sha256").update(QJS_COMMIT).update(MBEDTLS_VERSION).update(ZLIB_VERSION);
  for (const n of names) h.update(n).update("\0").update(await readFile(join(rtDir, n))).update("\0");
  const hash = h.digest("hex");
  rtFingerprintMemo = { sig, hash };
  return hash;
}

/** The cached .o set for one flag flavor, compiled on first need. Concurrent
 * first builds (parallel test workers on a cold cache) may duplicate work;
 * per-file atomic renames make every winner equivalent. */
async function ensureRuntimeObjects(
  root: string,
  ccArgv: string[],
  cflags: string[],
  sources: string[],
  keyPrefix: string,
): Promise<Map<string, string>> {
  const setKey = createHash("sha256")
    .update(keyPrefix)
    .update(cflags.join("\x1f"))
    .digest("hex")
    .slice(0, 24);
  const objDir = join(root, "obj", setKey);
  const objOf = (src: string): string => join(objDir, `${basename(src, ".c")}.o`);
  const present = await Promise.all(sources.map((s) => fileExists(objOf(s))));
  const missing = sources.filter((_, i) => !present[i]);
  if (missing.length > 0) {
    // ccache wraps only the default clang driver — multi-word drivers
    // (`zig cc`) run bare; their object sets are keyed apart anyway.
    const useCcache = ccArgv.length === 1 && ccArgv[0] === "clang" && (await ccacheAvailable());
    await mkdir(objDir, { recursive: true });
    const tmpDir = await mkdtemp(join(root, "obj", "build-"));
    try {
      // Modest parallelism: a flavor's objects build once, but several cold
      // workers can race here — keep each build's CPU footprint small.
      const width = 4;
      for (let i = 0; i < missing.length; i += width) {
        await Promise.all(
          missing.slice(i, i + width).map(async (src) => {
            const tmpObj = join(tmpDir, `${basename(src, ".c")}.o`);
            const argv = [...(useCcache ? ["ccache"] : []), ...ccArgv, ...cflags, "-c", src, "-o", tmpObj];
            await execFileAsync(argv[0] ?? "clang", argv.slice(1));
            await rename(tmpObj, objOf(src));
          }),
        );
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  return new Map(sources.map((s) => [s, objOf(s)]));
}

/** Size-capped LRU sweep of the whole cache root, at most once per process
 * and only after a write. Oldest-mtime files go first until the tree is back
 * under 75% of the cap; read hits bump mtimes so hot entries survive. */
let pruneDone = false;
async function pruneCache(root: string): Promise<void> {
  if (pruneDone) return;
  pruneDone = true;
  const capBytes = Number(process.env["SCRIPTC_CACHE_MAX_MB"] ?? "4096") * 1024 * 1024;
  if (!Number.isFinite(capBytes) || capBytes <= 0) return;
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        const s = await stat(p).catch(() => null);
        if (s !== null) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await walk(root);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= capBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const recent = Date.now() - 60 * 60 * 1000; // never evict anything a live run may be using
  for (const f of files) {
    if (total <= capBytes * 0.75 || f.mtimeMs > recent) break;
    await unlink(f.path).catch(() => undefined);
    total -= f.size;
  }
}

/** Compiles one C program together with the runtime sources.
 * Without a cache dir (the production default), the runtime (a dozen small
 * files) is recompiled on every build in one historical clang invocation —
 * no cached-archive staleness bugs. --dynamic additionally compiles
 * scr_island.c under SCR_DYNAMIC and links the cached engine archive (built
 * lazily, see above); regex-using programs additionally compile scr_regex.c
 * and link libregexp (the cached objects, or the archive's own copy under
 * --dynamic). Without either, the command line is exactly the historical
 * one — regex-free static builds must stay byte-identical.
 *
 * With SCRIPTC_CACHE_DIR set (the test lanes; see the cache block above),
 * unchanged programs skip clang via the binary cache, and misses link the
 * program's own TU against cached per-flavor runtime objects. */
export async function compileC(opts: CcOptions): Promise<void> {
  const rtDir = runtimeSrcDir();
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
  const driver = resolveCc();
  if (driver.target !== null) {
    // See the resolveCc block: these inputs are built on and for the HOST
    // (vendored archives, system libs). Regex, zlib, and the engine archive
    // are NOT here: their vendored sources are plain C that ensureLreObjects
    // / ensureZlibObjects / buildEngineArchiveCross compile per target with
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
        ["--sanitize", opts.sanitize ?? false],
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
          `(target-specific runtime / system inputs — see docs/linux-port.md).`,
      );
    }
  }
  const engineArchive = dynamic ? await ensureEngineArchive(opts.sanitize ?? false, driver) : null;
  const tlsArchive = tls ? await ensureTlsArchive(opts.sanitize ?? false, driver) : null;
  // --dynamic + regex shares the archive's libregexp (its host hooks and
  // ours would collide; see scr_regex.c) — the standalone objects are for
  // static builds only.
  const lreObjects = regex && !dynamic ? await ensureLreObjects(opts.sanitize ?? false, driver) : [];
  // Vendored zlib is the CROSS story only — host builds keep the exact
  // historical `-lz` system link (see CcOptions.zlib). The native fetch's
  // gzip decoder rides the same objects/link.
  const zlibObjects =
    ((opts.zlib ?? false) || nativeFetch) && driver.target !== null
      ? await ensureZlibObjects(opts.sanitize ?? false, driver)
      : [];
  // The libcurl import stub is likewise CROSS-only — host builds keep the
  // exact historical system `-lcurl` link (see CcOptions.fetch). Curl
  // reference builds only.
  const curlStubDir =
    curlFetch && driver.target !== null ? await ensureCurlStub(driver) : null;
  // rt() maps each runtime source's path on the command line: identity for
  // the historical single invocation, cached-.o substitution on cache misses.
  const buildArgs = (rt: (path: string) => string): string[] => [
    "-std=c11",
    ...driver.targetArgs,
    ...(opts.sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : ["-O2"]),
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
    ...RUNTIME_SOURCES.map((f) => rt(join(rtDir, f))),
    ...(opts.copying ? [rt(join(rtDir, "scr_copying.c"))] : []),
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
    ...(opts.nodeTest ? [rt(join(rtDir, "scr_test.c"))] : []),
    // The CA-store unit rides its own gate OR the tls one: scr_tls.c
    // references its default-set override unconditionally.
    ...(opts.tlsCa || tls ? [rt(join(rtDir, "scr_tls_ca.c"))] : []),
    ...(tlsArchive
      ? [
          "-I", join(vendorTlsDir(), "include"),
          rt(join(rtDir, "scr_tls.c")),
          tlsArchive,
          // mbedTLS's win32 entropy poll is BCryptGenRandom (bcrypt.h) —
          // an import the unconditional win32 libs above don't carry.
          // Never present on the default path, so the historical TLS
          // link line cannot change.
          ...(targetPlatform(driver) === "win32" ? ["-lbcrypt"] : []),
        ]
        : []),
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
    opts.cPath,
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
    "-o", opts.outPath,
  ];
  const ccName = driver.argv.join(" ");
  const runClang = async (args: string[]): Promise<void> => {
    try {
      await execFileAsync(driver.argv[0] ?? "clang", [...driver.argv.slice(1), ...args]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? String(err);
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

  const root = cacheRootDir();
  if (root === null) {
    // The exact historical command line, byte for byte.
    await runClang(buildArgs((p) => p));
    return;
  }

  const [cv, fingerprint, cBytes, linkBytes] = await Promise.all([
    ccVersionOnce(driver.argv),
    runtimeFingerprint(rtDir),
    readFile(opts.cPath),
    Promise.all((opts.linkInputs ?? []).map((path) => readFile(path))),
  ]);
  // The key sees the full command line with the two program-specific paths
  // normalized out (their CONTENT is what matters: the C bytes are hashed,
  // the out path is where the result lands). Runtime and vendor paths stay
  // verbatim — their contents are covered by the fingerprint and the pin.
  const identityArgs = buildArgs((p) => p).map((a) =>
    a === opts.cPath ? "<program.c>" : a === opts.outPath ? "<out>" : a,
  );
  const key = createHash("sha256")
    .update("bin-v1\0")
    // The driver spelling joins the version string: `zig cc --version`
    // reports the clang underneath and could otherwise collide with a
    // same-version host clang.
    .update(ccName).update("\0")
    .update(cv).update("\0")
    .update(fingerprint).update("\0")
    .update(identityArgs.join("\x1f")).update("\0")
    .update(cBytes);
  for (const bytes of linkBytes) key.update("\0ffi-link\0").update(bytes);
  const keyHex = key
    .digest("hex");
  const binDir = join(root, "bin");
  const cachedBin = join(binDir, keyHex);
  try {
    // NEVER copy over outPath in place: overwriting an already-executed
    // signed binary invalidates the kernel's per-vnode code-signature cache
    // on macOS and the next exec dies with SIGKILL. Copy to a fresh inode
    // and rename it into place instead.
    const tmpOut = `${opts.outPath}.hit-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await copyFile(cachedBin, tmpOut);
    await chmod(tmpOut, 0o755);
    await rename(tmpOut, opts.outPath);
    const now = new Date();
    await utimes(cachedBin, now, now).catch(() => undefined); // LRU bump
    return; // hit: clang skipped entirely
  } catch {
    /* miss — build below, then publish */
  }

  // Miss: link the program's own TU against cached per-flavor runtime
  // objects. cflags reproduces exactly the option set every TU sees in the
  // single invocation (the clang driver applies all options to all inputs).
  const cflags = [
    "-std=c11",
    ...driver.targetArgs,
    ...(opts.sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : ["-O2"]),
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
  // Collect the runtime sources this build actually compiles (the same
  // conditionals as the command line, by construction).
  const rtInputs: string[] = [];
  buildArgs((p) => {
    rtInputs.push(p);
    return p;
  });
  let objects: Map<string, string> | null = null;
  try {
    objects = await ensureRuntimeObjects(root, driver.argv, cflags, rtInputs, `obj-v1\0${ccName}\0${cv}\0${fingerprint}\0`);
  } catch {
    objects = null; // cache trouble is never a build failure
  }
  await runClang(buildArgs((p) => objects?.get(p) ?? p));
  try {
    await mkdir(binDir, { recursive: true });
    const tmp = join(binDir, `.tmp-${keyHex.slice(0, 8)}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await copyFile(opts.outPath, tmp);
    await chmod(tmp, 0o755);
    await rename(tmp, cachedBin);
    await pruneCache(root);
  } catch {
    /* publishing is best-effort */
  }
}
