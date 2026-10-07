import {
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "../toolchain-environment.js";
import { isMobileTarget } from "../target-platform.js";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  executableOptimizationLinkerArgs,
  executableStripLinkerArgs,
  windowsSubsystemLinkerArgs,
} from "../targets.js";
import {
  createDarwinDebugSymbols,
  installDarwinDebugSymbols,
  needsDarwinDebugSymbols,
  readDarwinDebugSymbols,
} from "../debug-symbols.js";
import {
  cacheRootDir,
  copyValidCachedFile,
  ensurePrivateCacheRoot,
  fileDigest,
  installArtifact,
  privateSiblingPath,
  protectCachedArtifact,
  pruneCache,
  publishCachedFile,
} from "../build-cache.js";
import { type CcOptions, type NativeArtifactDependency } from "./contracts.js";
import {
  runtimeSrcDir,
  EXECUTABLE_RUNTIME_SOURCES,
  runtimeFingerprint,
  runtimeFingerprintInputPaths,
} from "./runtime-inputs.js";
import {
  resolveCc,
  targetPlatform,
  executableSectionEliminationFlags,
  cacheTargetIdentity,
  isZigDriver,
  isMuslTarget,
} from "./driver.js";
import {
  resolveProgramShardMergeIdentity,
  selectProgramShards,
  updateProgramShardCacheIdentity,
} from "./program-shards.js";
import {
  compilerDriverSupportsPersistentCache,
  resolvedTool,
  directCompilerSelections,
  compilerDriverProbeKey,
  ccVersion,
} from "./tool-identity.js";
import {
  localArtifactIdentity,
  localArtifactStampPath,
  localArtifactHit,
  type NativeMetadataStamp,
  nativeMetadataKey,
  readNativeMetadataStamp,
  publishNativeMetadataStamp,
  snapshotLocalArtifactDependencies,
  nativeArtifactDependenciesStillMatch,
  publishLocalArtifactStamp,
} from "./artifact-stamps.js";
import {
  implicitToolchainFingerprints,
  effectiveCompilerInvocationFingerprint,
  translationUnitDependencyFingerprint,
  implicitToolchainFingerprint,
} from "./compiler-fingerprint.js";
import {
  fingerprintDependencyPaths,
  fingerprintDependenciesStillMatch,
} from "./dependency-files.js";
import {
  currentVendorCacheBuildIdentity,
  vendorBuildCacheRoot,
  engineArchivePath,
  tlsArchivePath,
  lreObjectPaths,
  zlibObjectPaths,
  curlStubDirPath,
  ensureEngineArchive,
  stageVendorInputs,
  ensureTlsArchive,
  ensureLreObjects,
  ensureZlibObjects,
  ensureCurlStub,
  vendorEngineDir,
  vendorZlibDir,
  vendorTlsDir,
  vendorCurlDir,
} from "./vendor.js";
import { execFileAsync, subprocessFailureDetail, CcCompileError } from "./process.js";
import { implicitLinkerFingerprint } from "./linker-fingerprint.js";
import { CacheInputsChangedError } from "./session.js";
import { ensureRuntimeObjects, stageRuntimeObjects, clearCcCaches } from "./runtime-objects.js";
import { localizeLibraryObjects } from "./object-merge.js";

/** Compiles one C program together with the runtime sources.
 * With caching disabled, the runtime (a dozen small files) is recompiled on
 * every build — no cached-archive staleness bugs. Sanitized dev builds compile
 * the program separately so its O0 setting does not slow the O1 runtime.
 * Other builds use one clang invocation. --dynamic additionally compiles
 * scr_island.c under SCR_DYNAMIC and links the cached engine archive (built
 * lazily, see above); regex-using programs additionally compile scr_regex.c
 * and link libregexp (the cached objects, or the archive's own copy under
 * --dynamic). Executable links use the target's section-elimination recipe
 * independently of those feature gates.
 *
 * With a caller-supplied dependency identity and an enabled cache root,
 * unchanged programs skip payload code generation/linking via the binary
 * cache after lightweight metadata probes, and misses link the program's own
 * TU against cached per-flavor runtime objects. */
export async function compileCInternal(
  opts: CcOptions,
  cacheWarmOnly: boolean,
  cacheWarmPaths?: Set<string>,
): Promise<void> {
  const rtDir = runtimeSrcDir();
  const sanitize = opts.sanitize ?? false;
  const optimization = opts.optimization ?? "release";
  const dynamic = opts.dynamic ?? false;
  if (opts.workers && (dynamic || targetPlatform(resolveCc()) === "wasi"))
    throw new Error("worker threads require a native static executable");
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
  const curlFetch = dynamic && fetchOn && process.env["SCRIPTC_FETCH_CURL"] === "1";
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
  const darwinDebugSymbols = needsDarwinDebugSymbols(
    targetPlatform(driver),
    optimization,
    opts.strip,
  );
  if (opts.frameworks?.length && targetPlatform(driver) !== "darwin")
    throw new Error("FFI frameworks require a Darwin target");
  if (opts.frameworks?.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)))
    throw new Error("Invalid FFI framework name");
  const debugFlags =
    optimization === "dev" && !opts.strip
      ? ["-gline-tables-only", ...(opts.cPath.endsWith(".ll") ? [] : ["-gno-column-info"])]
      : [];
  const { programShards, programPublicSymbols, programShardMergeIdentity } =
    await selectProgramShards(driver, opts, optimization === "dev" && !sanitize);
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
  const runtimeSources =
    targetPlatform(driver) === "wasi"
      ? EXECUTABLE_RUNTIME_SOURCES.filter((source) => source !== "scr_child.c")
      : EXECUTABLE_RUNTIME_SOURCES;
  const executableSectionFlags = executableSectionEliminationFlags(targetPlatform(driver));
  const windowsSubsystemArgs = windowsSubsystemLinkerArgs(
    targetPlatform(driver),
    opts.windowsSubsystem,
  );
  const executableLinkFlags = [
    ...executableSectionFlags.link,
    ...executableOptimizationLinkerArgs(targetPlatform(driver), optimization),
    ...executableStripLinkerArgs(targetPlatform(driver), opts.strip ?? false),
    ...windowsSubsystemArgs,
  ];
  // scr_async.c submits callback-style filesystem work to a native worker.
  // POSIX drivers need the thread compile/link mode; win32 uses CreateThread.
  const threadArgs =
    targetPlatform(driver) === "win32" || targetPlatform(driver) === "wasi" ? [] : ["-pthread"];
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
    (await compilerDriverSupportsPersistentCache(driver, toolchainEnv));
  // Only compiler-generated TUs opt in. Arbitrary `compileC` inputs
  // inputs may include caller-owned headers whose contents are not otherwise
  // represented in this key, so they retain the fully uncached historical
  // path unless the caller supplies its own complete dependency identity.
  const cacheIdentity = opts.cacheIdentity;
  let persistentCache: { root: string; identity: string } | null =
    cacheIdentity === undefined || configuredCacheRoot === null || !persistentDriverCache
      ? null
      : { root: configuredCacheRoot, identity: cacheIdentity };
  if (cacheWarmOnly && persistentCache === null) {
    throw new Error("native cache warming requires a persistently cacheable compiler environment");
  }
  if (persistentCache !== null) {
    try {
      await ensurePrivateCacheRoot(
        persistentCache.root,
        process.env["SCRIPTC_CACHE_DIR"] === undefined,
      );
    } catch (error) {
      if (cacheWarmOnly) {
        throw new Error("native cache warming could not prepare the persistent cache root", {
          cause: error,
        });
      }
      persistentCache = null;
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
    persistentCache !== null &&
    cachePolicy.completeArtifacts &&
    persistentCache.identity === "scriptc-generated-v1" &&
    (opts.linkInputs?.length ?? 0) === 0 &&
    (opts.frameworks?.length ?? 0) === 0 &&
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
        const effectiveCompiler =
          directCompilerSelections.get(compilerDriverProbeKey(driver, toolchainEnv)) ?? compiler;
        const key = localArtifactIdentity(
          opts,
          driver,
          toolchainEnv,
          `${compiler.cacheIdentity}\0${effectiveCompiler.cacheIdentity}`,
          runtimeHash,
          programBytes,
          programShardMergeIdentity,
        );
        const stampPath = localArtifactStampPath(persistentCache.root, opts.outPath);
        localArtifact = {
          stampPath,
          key,
          runtimeHash,
          programBytes,
          compilerPath: effectiveCompiler.canonicalPath,
        };
        const hit = await localArtifactHit(stampPath, opts.outPath, key, darwinDebugSymbols);
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
  const metadataCompiler =
    persistentCache === null ? null : await resolvedTool(driver.argv[0] ?? "clang");
  const metadataEffectiveCompiler =
    directCompilerSelections.get(compilerDriverProbeKey(driver, toolchainEnv)) ?? metadataCompiler;
  const toolchainMetadataKey =
    persistentCache === null ||
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
        persistentCache === null || toolchainMetadataKey === null
          ? null
          : await readNativeMetadataStamp(persistentCache.root, toolchainMetadataKey);
      implicitToolchain = toolchainMetadataStamp?.values["implicitToolchain"] ?? null;
      implicitCompileToolchain = toolchainMetadataStamp?.values["implicitCompileToolchain"] ?? null;
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
        compilerVersion = await ccVersion(driver.argv, toolchainEnv, true);
      }
      if (
        toolchainMetadataStamp === null &&
        persistentCache !== null &&
        toolchainMetadataKey !== null
      ) {
        if (metadataCompiler !== null && metadataEffectiveCompiler !== null) {
          toolchainMetadataStamp = await publishNativeMetadataStamp(
            persistentCache.root,
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
      persistentCache = null;
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
  const transientVendorRoot =
    persistentCache !== null && implicitToolchain !== null
      ? null
      : join(tmpdir(), `scriptc-vendor-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const vendorCacheRoot = transientVendorRoot ?? vendorBuildCacheRoot(persistentCache?.root);
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
  let lreObjects =
    regex && !dynamic ? lreObjectPaths(sanitize, driver, vendorBuildIdentity, vendorCacheRoot) : [];
  // Vendored zlib is the Zig story — default host-clang builds keep the exact
  // historical `-lz` system link (see CcOptions.zlib). The native fetch's
  // gzip decoder rides the same objects/link.
  let zlibObjects =
    ((opts.zlib ?? false) || nativeFetch) && isZigDriver(driver)
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
    // Preserve source order to avoid multiplying first-build resource
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
      const paths =
        stageRoot === undefined
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
      const paths =
        stageRoot === undefined
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
      ))
        protectCachedArtifact(cacheWarmPaths, object);
      const materialize = async (): Promise<string[]> =>
        await ensureLreObjects(sanitize, driver, vendorBuildIdentity, materializeCacheRoot);
      lreObjects =
        stageRoot === undefined
          ? await materialize()
          : await stageVendorInputs(materialize, join(stageRoot, "lre"));
    }
    if (zlibObjects.length > 0) {
      for (const object of zlibObjectPaths(
        sanitize,
        driver,
        vendorBuildIdentity,
        materializeCacheRoot,
      ))
        protectCachedArtifact(cacheWarmPaths, object);
      const materialize = async (): Promise<string[]> =>
        await ensureZlibObjects(sanitize, driver, vendorBuildIdentity, materializeCacheRoot);
      zlibObjects =
        stageRoot === undefined
          ? await materialize()
          : await stageVendorInputs(materialize, join(stageRoot, "zlib"));
    }
    if (curlStubDir !== null) {
      protectCachedArtifact(
        cacheWarmPaths,
        join(curlStubDirPath(driver, vendorBuildIdentity, materializeCacheRoot), "libcurl.so"),
      );
      const materialize = async (): Promise<string[]> => [
        join(await ensureCurlStub(driver, vendorBuildIdentity, materializeCacheRoot), "libcurl.so"),
      ];
      const paths =
        stageRoot === undefined
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
    ...debugFlags,
    ...driver.targetArgs,
    ...threadArgs,
    ...(opts.workers ? ["-DSCR_WORKERS"] : []),
    ...(sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : [optimization === "dev" ? "-O0" : "-O2"]),
    ...executableSectionFlags.compile,
    ...(opts.textDecoderLegacy ? ["-DSCR_TEXT_DECODER_LEGACY"] : []),
    "-fno-math-errno",
    // The runtime object model uses type-punned C: a hierarchy
    // upcast is a raw pointer cast, so one object's header (rc, vt) and
    // fields are read and written through BOTH the base and derived struct
    // types (sc_retain_Derived vs sc_release_Base on the same object).
    // C's effective-type rule calls that UB, and clang's TBAA at -O2
    // reorders/elides the rc updates once everything inlines — an upcast
    // identity compare frees the object while a global still owns it.
    // The LLVM backend emits no TBAA metadata; this flag preserves
    // matching memory semantics in the runtime. Mirrored in the
    // cache-miss cflags below and compileLibArchive — the three option
    // sets must stay in lockstep.
    "-fno-strict-aliasing",
    "-Wno-deprecated-declarations", // ucontext fibers (scr_async.c)
    "-I",
    rtDir,
    ...runtimeSources.map((f) => rt(join(rtDir, f))),
    ...(opts.workers
      ? ["scr_worker.c", "scr_worker_events.c", "scr_mailbox.c", "scr_message.c"].map((f) =>
          rt(join(rtDir, f)),
        )
      : []),
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
    ...(regex ? ["-I", vendorEngineDir(), rt(join(rtDir, "scr_regex.c")), ...lreObjects] : []),
    ...(opts.assert || regex || opts.symbol ? [rt(join(rtDir, "scr_assert.c"))] : []),
    ...(opts.inspect
      ? [rt(join(rtDir, "scr_inspect.c")), rt(join(rtDir, "scr_console_native.c"))]
      : []),
    ...(opts.dynInvoke || opts.workers || nativeFetch ? [rt(join(rtDir, "scr_dyn_invoke.c"))] : []),
    ...(opts.dc ? [rt(join(rtDir, "scr_dc.c"))] : []),
    ...(opts.dynAsync || opts.dynInvoke || opts.workers || opts.dc || opts.fileHandle || nativeFetch
      ? [rt(join(rtDir, "scr_async_dyn.c"))]
      : []),
    // The zlib UNIT (scr_zlib.c) gates on zlib.* IR use; the LINK (system
    // libz on the default host-clang build, vendored objects on Zig builds)
    // also serves the native fetch's gzip decoder — spread exactly once.
    ...(opts.zlib
      ? isZigDriver(driver)
        ? ["-I", vendorZlibDir(), rt(join(rtDir, "scr_zlib.c")), ...zlibObjects]
        : [rt(join(rtDir, "scr_zlib.c"))]
      : nativeFetch
        ? isZigDriver(driver)
          ? ["-I", vendorZlibDir(), ...zlibObjects]
          : []
        : []),
    // The zlib ↔ island bridge: only when BOTH halves are in the build
    // (the scr_inspect_island.c pattern) — the emitted main calls its
    // installer exactly then.
    ...(opts.zlib && opts.dynamic ? [rt(join(rtDir, "scr_zlib_island.c"))] : []),
    ...(opts.events ? [rt(join(rtDir, "scr_events.c")), rt(join(rtDir, "scr_readline.c"))] : []),
    ...(opts.emitter || opts.workers ? [rt(join(rtDir, "scr_events_emitter.c"))] : []),
    // The checked-dynamic HANDLE support unit (listener gate + runtime
    // adapter closures): every referencing unit is one of the emitter or
    // net families (http implies net), so handle-free binaries keep
    // their exact size class.
    ...(opts.emitter || opts.workers || net ? [rt(join(rtDir, "scr_dyn_handle.c"))] : []),
    ...(opts.symbol ? [rt(join(rtDir, "scr_symbol.c"))] : []),
    ...(opts.assert && opts.bigint ? [rt(join(rtDir, "scr_bigint_assert.c"))] : []),
    ...(opts.qs ? [rt(join(rtDir, "scr_qs.c"))] : []),
    ...(opts.parseArgs ? [rt(join(rtDir, "scr_util.c"))] : []),
    ...(opts.parseArgs && opts.symbol ? [rt(join(rtDir, "scr_util_compare.c"))] : []),
    ...(opts.parseArgs && opts.inspect && opts.dynAsync
      ? [rt(join(rtDir, "scr_util_style.c"))]
      : []),
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
    ...((opts.http2 ?? false) ? [rt(join(rtDir, "scr_http2.c"))] : []),
    ...(opts.dgram ? [rt(join(rtDir, "scr_dgram.c"))] : []),
    ...(opts.watch ? [rt(join(rtDir, "scr_watch.c"))] : []),
    ...(opts.foreignFfi ? [rt(join(rtDir, "scr_ffi_queue.c"))] : []),
    ...(opts.nodeTest ? [rt(join(rtDir, "scr_test.c"))] : []),
    // The CA-store unit rides its own gate OR the tls one: scr_tls.c
    // references its default-set override unconditionally.
    ...(tlsCa ? [rt(join(rtDir, "scr_tls_ca.c"))] : []),
    ...(tlsArchive
      ? [
          "-I",
          join(vendorTlsDir(), "include"),
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
          "-I",
          vendorEngineDir(),
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
              ? [
                  "-I",
                  join(vendorCurlDir(), "include"),
                  rt(join(rtDir, "scr_fetch_curl.c")),
                  `-L${curlStubDir}`,
                  "-lcurl",
                ]
              : [rt(join(rtDir, "scr_fetch_curl.c")), "-lcurl"]
            : []),
          engineArchive,
          // Linux's libm is appended after every input below for GNU ld's
          // left-to-right archive resolution. Other dynamic targets keep
          // the historical engine-adjacent spelling.
          ...(driver.linkArgs.includes("-lm") ? [] : ["-lm"]),
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
    ...(opts.frameworks ?? []).flatMap((name) => ["-framework", name]),
    // GNU ld resolves libraries from left to right and commonly enables
    // --as-needed: host-clang libz must follow scr_zlib.c/scr_fetch.c and every
    // generated/native input that references inflate symbols. Cross
    // and targetless Zig builds use vendored zlib objects in the input section above.
    ...(((opts.zlib ?? false) || nativeFetch) && !isZigDriver(driver) ? ["-lz"] : []),
    // glibc keeps libm separate from libc. This must trail the generated
    // program and every native FFI input because GNU ld resolves archives
    // from left to right.
    ...driver.linkArgs,
    ...executableLinkFlags,
    "-o",
    build.outPath ?? opts.outPath,
  ];
  // Runtime-object flags. Program compilation and dependency discovery add
  // the dev sanitizer override below so both cache identities match reality.
  const cflags = [
    "-std=c11",
    ...debugFlags,
    ...driver.targetArgs,
    ...threadArgs,
    ...(opts.workers ? ["-DSCR_WORKERS"] : []),
    ...(sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : [optimization === "dev" ? "-O0" : "-O2"]),
    ...executableSectionFlags.compile,
    ...(opts.textDecoderLegacy ? ["-DSCR_TEXT_DECODER_LEGACY"] : []),
    "-fno-math-errno",
    "-fno-strict-aliasing", // the emitted object model type-puns — see buildArgs
    "-Wno-deprecated-declarations",
    "-I",
    rtDir,
    ...(regex || dynamic ? ["-I", vendorEngineDir()] : []),
    ...(zlibObjects.length > 0 ? ["-I", vendorZlibDir()] : []),
    ...(curlStubDir !== null ? ["-I", join(vendorCurlDir(), "include")] : []),
    ...(tlsArchive !== null ? ["-I", join(vendorTlsDir(), "include")] : []),
    ...(dynamic ? ["-DSCR_DYNAMIC"] : []),
  ];
  // Keep sanitizer runtime objects optimized in both postures. Large dev
  // programs still compile at O0, avoiding an expensive LLVM optimization
  // pass while retaining ASan and reference-count checks in every runtime unit.
  const separateSanitizedProgram = sanitize && optimization === "dev";
  const programCompilerArgs = [
    ...cflags,
    ...(separateSanitizedProgram ? ["-O0"] : []),
    ...(opts.cPath.endsWith(".ll") ? ["-Wno-override-module"] : []),
  ];
  const programSourceExtension = opts.cPath.endsWith(".ll") ? ".ll" : ".c";
  const ccName = driver.argv.join(" ");
  const runClang = async (args: string[]): Promise<void> => {
    try {
      await execFileAsync(driver.argv[0] ?? "clang", [...driver.argv.slice(1), ...args]);
    } catch (err) {
      const stderr = subprocessFailureDetail(err);
      const guidance =
        (opts.linkInputs?.length ?? 0) > 0 ||
        (opts.frameworks?.length ?? 0) > 0 ||
        (opts.systemLibraries?.length ?? 0) > 0
          ? "This build includes native FFI link inputs. Check that every symbol and system library exists, " +
            "that archive/object ordering is correct, and that each input matches the selected target."
          : `Check the supplied native source and the selected ${ccName} toolchain.`;
      throw new CcCompileError(
        ccName,
        stderr,
        `${ccName} failed compiling ${opts.cPath}.\n` + `${guidance}\n\n${stderr}`,
      );
    }
  };
  const buildExecutable = async (
    runtimeInput: (path: string) => string,
    build: { programPath?: string; outPath?: string; compilerVisibleSource?: string } = {},
  ): Promise<void> => {
    if (!separateSanitizedProgram) {
      await runClang(buildArgs(runtimeInput, build));
      return;
    }
    const stage = await mkdtemp(join(tmpdir(), "scriptc-sanitized-program-"));
    try {
      const object = join(stage, "program.o");
      await runClang([
        ...programCompilerArgs,
        ...(build.compilerVisibleSource === undefined
          ? []
          : [
              `-ffile-prefix-map=${build.programPath}=${build.compilerVisibleSource}`,
              "-iquote",
              dirname(resolve(build.compilerVisibleSource)),
            ]),
        "-c",
        build.programPath ?? opts.cPath,
        "-o",
        object,
      ]);
      await runClang(
        buildArgs(runtimeInput, { programPath: object, outPath: build.outPath ?? opts.outPath }),
      );
      if (darwinDebugSymbols) await createDarwinDebugSymbols(build.outPath ?? opts.outPath);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  };
  const runUncachedBuild = async (): Promise<void> => {
    const privateVendorRoot =
      transientVendorRoot ??
      join(
        tmpdir(),
        `scriptc-vendor-fallback-${process.pid}-${Math.random().toString(36).slice(2)}`,
      );
    try {
      await materializeVendorPrerequisites(undefined, privateVendorRoot);
      await buildExecutable((p) => p);
    } finally {
      await rm(privateVendorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  let runtimeCompilerInvocation: string | null = null;
  let programCompilerInvocation: string | null = null;
  let payloadMetadata: Promise<[string, string, Buffer]> | null = null;
  let compileMetadataStamp: NativeMetadataStamp | null = null;
  const compileMetadataKey =
    persistentCache === null || process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] === "1"
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
  if (persistentCache !== null) {
    try {
      // These probes inspect disjoint inputs. Start the payload reads here as
      // well so runtime hashing and clang's dry-run traces overlap instead of
      // forming a serial prelude before every cache lookup.
      payloadMetadata = Promise.all([
        Promise.resolve(
          toolchainMetadataStamp?.values["compilerVersion"] ??
            ccVersion(driver.argv, toolchainEnv, true),
        ),
        localArtifact === null
          ? runtimeFingerprint(rtDir)
          : Promise.resolve(localArtifact.runtimeHash),
        localArtifact === null ? readFile(opts.cPath) : Promise.resolve(localArtifact.programBytes),
      ]);
      compileMetadataStamp =
        compileMetadataKey === null
          ? null
          : await readNativeMetadataStamp(persistentCache.root, compileMetadataKey);
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
          programSourceExtension === ".ll" || separateSanitizedProgram
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
            persistentCache.root,
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
      persistentCache = null;
    }
  }

  if (persistentCache === null) {
    // The direct uncached command is the source-of-truth executable recipe.
    await runUncachedBuild();
    return;
  }

  let cv: string;
  let fingerprint: string;
  let cBytes: Buffer;
  try {
    [cv, fingerprint, cBytes] = await (payloadMetadata ??
      Promise.all([
        ccVersion(driver.argv, toolchainEnv, true),
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
    (opts.frameworks?.length ?? 0) === 0 &&
    (opts.systemLibraries?.length ?? 0) === 0;
  let programDependencies: string | null = null;
  const linkProbeArgs = [
    ...(sanitize ? ["-fsanitize=address"] : []),
    ...threadArgs,
    ...(opts.workers ? ["-DSCR_WORKERS"] : []),
    ...(targetPlatform(driver) === "win32" ? ["-ladvapi32", "-liphlpapi", "-lws2_32"] : []),
    ...(tls && targetPlatform(driver) === "win32" ? ["-lbcrypt"] : []),
    ...(tlsCa && targetPlatform(driver) === "win32" ? ["-lcrypt32"] : []),
    ...(curlFetch && driver.target === null ? ["-lcurl"] : []),
    ...(dynamic && !driver.linkArgs.includes("-lm") ? ["-lm"] : []),
    ...(((opts.zlib ?? false) || nativeFetch) && !isZigDriver(driver) ? ["-lz"] : []),
    ...driver.linkArgs,
    ...executableLinkFlags,
  ];
  // Both the wrapper dry run and dependency trace need the real build's
  // compile/link flag shape: wrappers commonly inject flags or native inputs
  // conditionally on optimization, sanitizer, dynamic, or platform switches.
  const effectiveLinkInvocationArgs = [
    ...(separateSanitizedProgram ? cflags : programCompilerArgs),
    ...(targetPlatform(driver) === "win32" ? ["-ladvapi32", "-liphlpapi", "-lws2_32"] : []),
    ...(tls && targetPlatform(driver) === "win32" ? ["-lbcrypt"] : []),
    ...(tlsCa && targetPlatform(driver) === "win32" ? ["-lcrypt32"] : []),
    ...(curlStubDir !== null ? [`-L${curlStubDir}`] : []),
    ...(curlFetch && driver.target === null ? ["-lcurl"] : []),
    ...(dynamic && !driver.linkArgs.includes("-lm") ? ["-lm"] : []),
    ...(dynamic && targetPlatform(driver) === "win32" ? ["-Wl,--stack,8388608"] : []),
    ...(((opts.zlib ?? false) || nativeFetch) && !isZigDriver(driver) ? ["-lz"] : []),
    ...driver.linkArgs,
    ...executableLinkFlags,
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
    process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] === "1"
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
      linkMetadataStamp =
        linkMetadataKey === null
          ? null
          : await readNativeMetadataStamp(persistentCache.root, linkMetadataKey);
      if (linkMetadataStamp !== null) {
        implicitLinker = linkMetadataStamp.values["implicitLinker"] ?? null;
        if (implicitLinker === null) linkMetadataStamp = null;
      }
      [programDependencies, implicitLinker] = await Promise.all([
        translationUnitDependencyFingerprint(
          driver,
          programCompilerArgs,
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
          persistentCache.root,
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
      if (
        !(await fingerprintDependenciesStillMatch([
          implicitToolchain!,
          runtimeCompilerInvocation!,
          programCompilerInvocation!,
          implicitLinker!,
          programDependencies,
          ...(programShardMergeIdentity === null ? [] : [programShardMergeIdentity]),
        ])) ||
        (await runtimeFingerprint(rtDir).catch(() => null)) !== fingerprint ||
        !(
          await Promise.all(
            [toolchainMetadataStamp, compileMetadataStamp, linkMetadataStamp]
              .filter((stamp): stamp is NativeMetadataStamp => stamp !== null)
              .map((stamp) => nativeArtifactDependenciesStillMatch(stamp.dependencies)),
          )
        ).every(Boolean)
      ) {
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
          programCompilerArgs,
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
  const binDir = join(persistentCache.root, "bin");
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
      .update(cacheTargetIdentity(driver))
      .update("\0")
      .update(toolchainEnv)
      .update("\0")
      .update(implicitToolchain!)
      .update("\0")
      .update(runtimeCompilerInvocation!)
      .update("\0")
      .update(programCompilerInvocation!)
      .update("\0")
      .update(implicitLinker!)
      .update("\0")
      .update(programDependencies!)
      .update("\0")
      .update(persistentCache.identity)
      .update("\0")
      // Preserve both the spelling clang sees (__FILE__) and the location used
      // to resolve relative includes. The top-level bytes are not sufficient.
      .update(opts.cPath)
      .update("\0")
      .update(resolve(opts.cPath))
      .update("\0")
      .update(targetPlatform(driver) === "darwin" ? basename(opts.outPath) : "<out>")
      .update("\0")
      // The driver spelling joins the version string: `zig cc --version`
      // reports the clang underneath and could otherwise collide with a
      // same-version host clang.
      .update(ccName)
      .update("\0")
      .update(cv)
      .update("\0")
      .update(fingerprint)
      .update("\0")
      .update(identityArgs.join("\x1f"))
      .update("\0")
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
      if (darwinDebugSymbols) {
        const cachedSymbols = `${cachedBin}.dsym`;
        const symbolsCopy = privateSiblingPath(opts.outPath, "dsym-hit");
        try {
          if (!(await copyValidCachedFile(cachedSymbols, symbolsCopy)))
            throw new Error("invalid cached dSYM");
          const bytes = await readFile(symbolsCopy);
          // A concurrent publisher may replace either payload. The sidecar
          // also names its binary digest so a mixed pair always misses.
          if (bytes.subarray(0, 32).toString("hex") !== (await fileDigest(tmpOut)))
            throw new Error("mismatched cached dSYM");
          await installDarwinDebugSymbols(bytes.subarray(32), opts.outPath);
        } finally {
          await rm(symbolsCopy, { force: true });
        }
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
          [persistentCache.root],
          darwinDebugSymbols,
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
    const programPath = join(buildDir, `program${programSourceExtension}`);
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
        persistentCache.root,
        driver.argv,
        cflags,
        rtInputs,
        `obj-v5\0${cacheTargetIdentity(driver)}\0${toolchainEnv}\0${implicitToolchain}\0${runtimeCompilerInvocation}\0${ccName}\0${cv}\0${fingerprint}\0`,
        async () => await objectImplicitToolchainStillMatches(),
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
        programShards === null ||
        programPublicSymbols === undefined ||
        programCompilerInvocation === null ||
        implicitCompileToolchain === null
      )
        return null;
      try {
        const programDependencyHash =
          programDependencies ??
          (await translationUnitDependencyFingerprint(
            driver,
            programCompilerArgs,
            opts.cPath,
            cBytes,
            toolchainEnv,
          ));
        const stem = basename(opts.cPath, ".ll");
        const entries = programShards.map((shard, index) => {
          const sourcePath = join(buildDir, shard.name);
          const staged = join(buildDir, `${stem}.program-${index.toString().padStart(3, "0")}.o`);
          const key = createHash("sha256")
            .update("exe-program-shard-v1\0")
            .update(cacheTargetIdentity(driver))
            .update("\0")
            .update(toolchainEnv)
            .update("\0")
            .update(implicitCompileToolchain)
            .update("\0")
            .update(programCompilerInvocation)
            .update("\0")
            .update(persistentCache.identity)
            .update("\0")
            .update(driver.argv.join("\x1f"))
            .update("\0")
            .update(cv)
            .update("\0")
            .update(fingerprint)
            .update("\0")
            .update(programDependencyHash)
            .update("\0")
            .update(programCompilerArgs.join("\x1f"))
            .update("\0")
            .update(opts.cPath)
            .update("\0")
            .update(resolve(opts.cPath))
            .update("\0")
            .update(shard.name)
            .update("\0")
            .update(shard.source)
            .digest("hex");
          return {
            ...shard,
            sourcePath,
            staged,
            cachePath: join(persistentCache.root, "program-shard", key),
            missed: false,
          };
        });
        const shardWidth = Math.min(8, availableParallelism());
        for (let i = 0; i < entries.length; i += shardWidth) {
          await Promise.all(
            entries.slice(i, i + shardWidth).map(async (entry) => {
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
            }),
          );
        }
        const arArgv = isZigDriver(driver) ? [driver.argv[0]!, "ar"] : ["ar"];
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
            const [
              currentRuntime,
              currentFingerprints,
              currentInvocation,
              currentDependencies,
              currentCompiler,
              currentMerge,
            ] = await Promise.all([
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
                programCompilerArgs,
                opts.cPath,
                cBytes,
                toolchainEnv,
              ),
              ccVersion(driver.argv, toolchainEnv, true),
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
    await buildExecutable(
      (p) => objects?.get(p) ?? p,
      shardedProgramObject === null
        ? { programPath, outPath: privateOut, compilerVisibleSource: opts.cPath }
        : { programPath: shardedProgramObject, outPath: privateOut },
    );
    if (darwinDebugSymbols) {
      // clang invokes dsymutil when compiling a source TU while linking.
      // A sharded program is already an object, so run it explicitly while
      // the merged object and staged runtime inputs still exist.
      if (shardedProgramObject !== null) await createDarwinDebugSymbols(privateOut);
      await installDarwinDebugSymbols(await readDarwinDebugSymbols(privateOut), opts.outPath);
    }
    await installArtifact(privateOut, opts.outPath);

    if (cachedBin !== null && keyHex !== null) {
      // Metadata comparison catches ordinary changes cheaply, but cannot by
      // itself prove the snapshot was taken from the same bytes hashed into
      // the key. Recompute every content-bearing identity after the final link
      // so a header/SDK/compiler change in either pre-build gap cannot publish
      // new output under an old key.
      const [
        currentRuntime,
        currentImplicit,
        currentRuntimeInvocation,
        currentProgramInvocation,
        currentProgramDependencies,
        currentLinker,
        currentCompiler,
        currentProgramShardMerge,
      ] = await Promise.all([
        runtimeFingerprint(rtDir).catch(() => null),
        implicitToolchainFingerprint(driver, toolchainEnv).catch(() => null),
        effectiveCompilerInvocationFingerprint(driver, toolchainEnv, cflags).catch(() => null),
        effectiveCompilerInvocationFingerprint(
          driver,
          toolchainEnv,
          programCompilerArgs,
          programSourceExtension,
        ).catch(() => null),
        translationUnitDependencyFingerprint(
          driver,
          programCompilerArgs,
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
        ccVersion(driver.argv, toolchainEnv, true).catch(() => null),
        programShards === null
          ? Promise.resolve(null)
          : resolveProgramShardMergeIdentity(driver).catch(() => null),
      ]);
      cacheInputsStable =
        cacheInputsStable &&
        preBuildDependencies !== null &&
        (await nativeArtifactDependenciesStillMatch(preBuildDependencies)) &&
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
        if (darwinDebugSymbols) {
          const symbols = privateSiblingPath(privateOut, "debug-symbols");
          await writeFile(
            symbols,
            Buffer.concat([
              Buffer.from(await fileDigest(privateOut), "hex"),
              await readDarwinDebugSymbols(privateOut),
            ]),
          );
          await publishCachedFile(symbols, `${cachedBin}.dsym`);
        }
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
        [persistentCache.root],
        darwinDebugSymbols,
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
  await pruneCache(persistentCache.root, cacheWarmPaths).catch(() => undefined);
}

export async function compileC(opts: CcOptions): Promise<void> {
  clearCcCaches();
  await compileCInternal(opts, false);
  if (
    targetPlatform(resolveCc()) === "darwin" &&
    !needsDarwinDebugSymbols("darwin", opts.optimization, opts.strip)
  ) {
    await rm(`${opts.outPath}.dSYM`, { recursive: true, force: true });
  }
}
