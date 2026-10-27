import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  stageCachedFile,
  cacheDigestPath,
  publishCachedFile,
  validCachedFile,
} from "./build-cache.js";
import type { CcDriver } from "./native/driver.js";

const execFileAsync = promisify(execFile);

/** The section flags the libregexp/libunicode objects build with (the
 * runtime pack's executable_section_elimination flags). */
const LRE_SECTION_FLAGS = ["-ffunction-sections", "-fdata-sections"];

/** A vendored source's object file name: sources in subdirectories
 * (zlib's contrib/optimizations/inflate.c) flatten to one directory. */
function vendorObjectName(source: string): string {
  return source.replaceAll("/", "-").replace(/\.c$/, ".o");
}

import {
  QJS_COMMIT,
  MBEDTLS_VERSION,
  ZLIB_VERSION,
  BROTLI_VERSION,
  LRE_SOURCES,
  ZLIB_SOURCES,
  zlibInputs,
} from "./vendor-inputs.js";
export {
  QJS_COMMIT,
  MBEDTLS_VERSION,
  ZLIB_VERSION,
  BROTLI_VERSION,
  LRE_SOURCES,
  ZLIB_SOURCES,
} from "./vendor-inputs.js";

export interface VendorArchiveContext {
  runtimeSrcDir(): string;
  targetPlatform(driver: CcDriver): string;
  isZigDriver(driver: Pick<CcDriver, "argv">): boolean;
  resolvedToolIdentity(command: string): Promise<string | null>;
  runtimeFingerprint(runtimeDir: string): Promise<string>;
}

export function createVendorArchives(context: VendorArchiveContext) {
  const { runtimeSrcDir, isZigDriver, resolvedToolIdentity, runtimeFingerprint } = context;
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
    // Zig recipes use Zig for both compilation and archiving, including the
    // targetless host-native path. The default host-clang recipe uses the
    // separate bare clang and ar tools.
    const commands = isZigDriver(driver) ? [driver.argv[0] ?? "zig"] : ["clang", "ar"];
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
        return await Promise.all(
          sources.map(async (source) => {
            const destination = join(stageDir, basename(source));
            await stageCachedFile(source, destination, now);
            return destination;
          }),
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

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
    const cacheDir = join(cacheRoot, `${QJS_COMMIT.slice(0, 12)}-lre-sections-${flavor}`);
    return LRE_SOURCES.map((f) => join(cacheDir, f.replace(/\.c$/, ".o")));
  }

  /** The libregexp objects for one flavor, compiled lazily on the first
   * regex-using build (~1s) and cached under
   * <build-cache>/vendor/<commit>-lre-sections-<flavor>-<target>-<toolchain>/*.o — with the same atomic-rename
   * publish (parallel first builds race safely; losers discard their work).
   * Plain is -Os to keep regex-using binaries small; asan matches the final link so
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
      // Section elimination keeps only the libunicode tables a program
      // reaches: the URL host parser's NFC links the normalization tables
      // without the regex property ones.
      flags: LRE_SECTION_FLAGS,
    });
  }

  function vendorZlibDir(): string {
    return join(runtimeSrcDir(), "..", "vendor", "zlib");
  }

  /** The vendored zlib TUs every C-lane build links (zlibInputs picks them
   * per target; the gzFile file-I/O units are never compiled, nothing in
   * scr_zlib.c references the gzFile API). */

  /** The triple zlibInputs reads for a driver: its explicit target, else
   * the host. */
  function zlibTriple(driver: Pick<CcDriver, "target">): string {
    if (driver.target !== null) return driver.target;
    const cpu =
      process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
    return `${cpu}-${process.platform === "win32" ? "windows" : process.platform}`;
  }

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
    return zlibInputs(zlibTriple(driver)).sources.map((f) => join(cacheDir, vendorObjectName(f)));
  }

  /** The zlib objects for one flavor, compiled lazily on the first zlib-using
   * C-lane build (~1s) and cached like the lre objects —
   * <build-cache>/vendor/zlib-<version>-<flavor>-<target>-<toolchain>/*.o — with the same atomic-rename
   * publish (parallel first builds race safely; losers discard their work).
   * Plain is -O3, as Node builds zlib; asan matches the final link so the
   * sanitized lane instruments the codec too. The flavor keys the driver and target exactly
   * like the lre flavor: the keying
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
    const inputs = zlibInputs(zlibTriple(driver));
    return ensureVendorObjects({
      sanitize,
      driver,
      cacheRoot,
      flavor,
      name: "zlib",
      vendor: vendorZlibDir(),
      sources: inputs.sources,
      objects: zlibObjectPaths(sanitize, driver, buildIdentity, cacheRoot),
      flags: [...(sanitize ? [] : ["-O3"]), ...inputs.defines.map((define) => `-D${define}`)],
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
    flags?: readonly string[];
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
            ...(options.flags ?? []),
            "-I",
            vendor,
            "-c",
            join(vendor, f),
            "-o",
            join(buildDir, vendorObjectName(f)),
          ],
          { cwd: buildDir },
        );
      }
      await Promise.all(
        objects.map((destination) =>
          publishVendorArtifact(join(buildDir, basename(destination)), destination),
        ),
      );
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
    return objects;
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
   * TLS-using build (~15s over ~110 TUs, parallelized) and cached under
   * <build-cache>/vendor/mbedtls-<version>-<flavor>-<target>-<toolchain>/libmbedtls.a
   * with the same atomic-rename publish (parallel first builds race safely;
   * losers discard their work). Plain is -Os (the TLS stack is link-gated
   * but still wants its size class small); asan matches the final link so
   * the sanitized lane instruments every TLS path too. No CMake: the stock
   * config builds every library/*.c standalone with clang, so the recipe is
   * per-TU `-c` compiles plus one `ar rcs` — vendored-build machinery the
   * lre-objects cache already established.
   *
   * Zig drivers add a per-target or native cache flavor (the lre-objects story):
   * TUs compile with the selected `zig cc` invocation and the archive is packed
   * with `zig ar` (llvm-ar — the host BSD ar has no business indexing ELF
   * objects). The default host-clang driver keeps the exact historical clang + ar recipe. */
  async function ensureTlsArchive(
    sanitize: boolean,
    driver: CcDriver,
    buildIdentity: string,
    cacheRoot: string = vendorBuildCacheRoot(),
  ): Promise<string> {
    const flavor = `${sanitize ? "asan" : "plain"}-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
    const compileArgv = isZigDriver(driver) ? driver.argv : ["clang"];
    const arArgv = isZigDriver(driver) ? [...driver.argv.slice(0, 1), "ar"] : ["ar"];
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
        "-I",
        join(vendor, "include"),
        "-I",
        join(vendor, "library"),
      ];
      const width = availableParallelism();
      for (let i = 0; i < sources.length; i += width) {
        await Promise.all(
          sources
            .slice(i, i + width)
            .map((src) =>
              execFileAsync(compileArgv[0] ?? "clang", [
                ...compileArgv.slice(1),
                ...cflags,
                "-c",
                join(vendor, "library", src),
                "-o",
                join(buildDir, `${basename(src, ".c")}.o`),
              ]),
            ),
        );
      }
      await execFileAsync(arArgv[0] ?? "ar", [
        ...arArgv.slice(1),
        "rcs",
        join(buildDir, "libmbedtls.a"),
        ...sources.map((s) => join(buildDir, `${basename(s, ".c")}.o`)),
      ]);
      await publishVendorArtifact(join(buildDir, "libmbedtls.a"), archive);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
    return archive;
  }

  function vendorBrotliDir(): string {
    return join(runtimeSrcDir(), "..", "vendor", "brotli", "c");
  }

  function brotliArchivePath(
    sanitize: boolean,
    driver: CcDriver,
    buildIdentity: string,
    cacheRoot: string = vendorBuildCacheRoot(),
  ): string {
    const flavor = `${sanitize ? "asan" : "plain"}-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
    return join(cacheRoot, `brotli-${BROTLI_VERSION}-${flavor}`, "libbrotli.a");
  }

  /** The brotli archive for one flavor, compiled lazily on the first
   * Brotli-using build and cached under
   * <build-cache>/vendor/brotli-<version>-<flavor>-<target>-<toolchain>/libbrotli.a,
   * with the mbedTLS archive's recipe: per-TU compiles of c/common, c/dec
   * and c/enc against c/include, then one `ar rcs`. dec/ and enc/ share
   * file names, so each object is named after its path (dec-static_init.o). */
  async function ensureBrotliArchive(
    sanitize: boolean,
    driver: CcDriver,
    buildIdentity: string,
    cacheRoot: string = vendorBuildCacheRoot(),
  ): Promise<string> {
    const flavor = `${sanitize ? "asan" : "plain"}-${vendorCacheTargetFlavor(driver)}-${buildIdentity}`;
    const compileArgv = isZigDriver(driver) ? driver.argv : ["clang"];
    const arArgv = isZigDriver(driver) ? [...driver.argv.slice(0, 1), "ar"] : ["ar"];
    const vendor = vendorBrotliDir();
    const archive = brotliArchivePath(sanitize, driver, buildIdentity, cacheRoot);
    if (await validVendorArtifact(archive)) return archive;

    await mkdir(cacheRoot, { recursive: true });
    const buildDir = await mkdtemp(join(tmpdir(), `scriptc-vendor-brotli-${flavor}-`));
    try {
      const sources = (
        await Promise.all(
          ["common", "dec", "enc"].map(async (dir) =>
            (await readdir(join(vendor, dir)))
              .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
              .map((name) => `${dir}/${name}`),
          ),
        )
      )
        .flat()
        .sort();
      const object = (src: string): string =>
        join(buildDir, `${src.replaceAll("/", "-").replace(/\.c$/, "")}.o`);
      const cflags = [
        "-std=c11",
        ...driver.targetArgs,
        ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-Os"]),
        "-I",
        join(vendor, "include"),
      ];
      const width = availableParallelism();
      for (let i = 0; i < sources.length; i += width) {
        await Promise.all(
          sources
            .slice(i, i + width)
            .map((src) =>
              execFileAsync(compileArgv[0] ?? "clang", [
                ...compileArgv.slice(1),
                ...cflags,
                "-c",
                join(vendor, src),
                "-o",
                object(src),
              ]),
            ),
        );
      }
      await execFileAsync(arArgv[0] ?? "ar", [
        ...arArgv.slice(1),
        "rcs",
        join(buildDir, "libbrotli.a"),
        ...sources.map(object),
      ]);
      await publishVendorArtifact(join(buildDir, "libbrotli.a"), archive);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
    return archive;
  }

  return {
    vendorEngineDir,
    vendorTlsDir,
    vendorBrotliDir,
    brotliArchivePath,
    ensureBrotliArchive,
    vendorBuildCacheRoot,
    vendorCacheTargetFlavor,
    vendorCacheBuildIdentity,
    currentVendorCacheBuildIdentity,
    stageVendorInputs,
    lreObjectPaths,
    ensureLreObjects,
    vendorZlibDir,
    zlibObjectPaths,
    ensureZlibObjects,
    tlsArchivePath,
    ensureTlsArchive,
    LRE_SOURCES,
    ZLIB_SOURCES,
  };
}
