import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { cacheDigestPath, publishCachedFile, validCachedFile } from "./build-cache.js";
import type { CcDriver } from "./native-toolchain.js";

const execFileAsync = promisify(execFile);

/** The pinned QuickJS, mbedTLS, and zlib inputs used by native recipes. */
export const QJS_COMMIT = "3c8f3d68953955950074c41c6e4d999562ae82a7";
export const MBEDTLS_VERSION = "3.6.7";
export const ZLIB_VERSION = "1.3.1";
/** Exact translation-unit membership shared by cache builds and external
 * source-pack recipes. */
export const QJS_ENGINE_SOURCES = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"] as const;
export const LRE_SOURCES = ["libregexp.c", "libunicode.c"] as const;
export const ZLIB_SOURCES = ["adler32.c", "compress.c", "crc32.c", "deflate.c", "infback.c", "inffast.c", "inflate.c", "inftrees.c", "trees.c", "uncompr.c", "zutil.c"] as const;

export interface VendorArchiveContext {
  runtimeSrcDir(): string;
  targetPlatform(driver: CcDriver): string;
  resolvedToolIdentity(command: string): Promise<string | null>;
  runtimeFingerprint(runtimeDir: string): Promise<string>;
}

export function createVendorArchives(context: VendorArchiveContext) {
  const {
    runtimeSrcDir,
    targetPlatform,
    resolvedToolIdentity,
    runtimeFingerprint,
  } = context;
  const validVendorArtifact = validCachedFile;

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
  function vendorCacheTargetFlavor(
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
  function vendorCacheBuildIdentity(
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
    return ensureVendorObjects({
      sanitize,
      driver,
      cacheRoot,
      flavor,
      name: "lre",
      vendor: vendorEngineDir(),
      sources: LRE_SOURCES,
      objects: lreObjectPaths(sanitize, driver, buildIdentity, cacheRoot),
    });
  }
  
  function vendorZlibDir(): string {
    return join(runtimeSrcDir(), "..", "vendor", "zlib");
  }
  
  /** The vendored zlib TUs behind CROSS-target zlib support: every root *.c
   * except the gzFile file-I/O units (gz*.c — nothing in scr_zlib.c
   * references the gzFile API, and those TUs alone want unistd/io headers).
   * Host builds never touch this list — they link the system libz. */
  
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
    return ensureVendorObjects({
      sanitize,
      driver,
      cacheRoot,
      flavor,
      name: "zlib",
      vendor: vendorZlibDir(),
      sources: ZLIB_SOURCES,
      objects: zlibObjectPaths(sanitize, driver, buildIdentity, cacheRoot),
    });
  }
  
  /** Compile and atomically publish one cached set of vendored C objects. */
  async function ensureVendorObjects(options: {
    sanitize: boolean;
    driver: CcDriver;
    cacheRoot: string;
    flavor: string;
    name: string;
    vendor: string;
    sources: readonly string[];
    objects: string[];
  }): Promise<string[]> {
    const { sanitize, driver, cacheRoot, flavor, name, vendor, sources, objects } = options;
    if ((await Promise.all(objects.map(validVendorArtifact))).every(Boolean)) return objects;
  
    await mkdir(cacheRoot, { recursive: true });
    const buildDir = await mkdtemp(join(tmpdir(), `scriptc-vendor-${name}-${flavor}-`));
    try {
      // Zig's COFF driver rejects multiple -c inputs in a single command.
      for (const f of sources) {
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
  
  return {
    vendorEngineDir,
    vendorTlsDir,
    vendorCurlDir,
    vendorBuildCacheRoot,
    vendorCacheTargetFlavor,
    vendorCacheBuildIdentity,
    currentVendorCacheBuildIdentity,
    engineArchivePath,
    stageVendorInputs,
    ensureEngineArchive,
    lreObjectPaths,
    ensureLreObjects,
    vendorZlibDir,
    zlibObjectPaths,
    ensureZlibObjects,
    curlStubDirPath,
    ensureCurlStub,
    tlsArchivePath,
    ensureTlsArchive,
    QJS_ENGINE_SOURCES,
    LRE_SOURCES,
    ZLIB_SOURCES,
  };
}
