import {
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "../toolchain-environment.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  cacheRootDir,
  copyValidCachedFile,
  ensurePrivateCacheRoot,
  installArtifact,
  privateSiblingPath,
  pruneCache,
  publishCachedFile,
} from "../build-cache.js";
import { type LibArchiveOptions } from "./contracts.js";
import { clearCcCaches, ensureRuntimeObjects, stageRuntimeObjects } from "./runtime-objects.js";
import { runtimeSrcDir, LIB_RUNTIME_SOURCES, runtimeFingerprint } from "./runtime-inputs.js";
import {
  resolveCc,
  targetPlatform,
  isMuslTarget,
  executableSectionEliminationFlags,
  isZigDriver,
  cacheTargetIdentity,
} from "./driver.js";
import {
  resolveProgramShardMergeIdentity,
  selectProgramShards,
  updateProgramShardCacheIdentity,
} from "./program-shards.js";
import {
  vendorEngineDir,
  vendorZlibDir,
  currentVendorCacheBuildIdentity,
  vendorBuildCacheRoot,
  stageVendorInputs,
  ensureLreObjects,
  ensureZlibObjects,
} from "./vendor.js";
import {
  compilerDriverSupportsPersistentCache,
  archiverSupportsPersistentCache,
  ccVersion,
  toolVersionOnce,
} from "./tool-identity.js";
import {
  implicitToolchainFingerprints,
  effectiveCompilerInvocationFingerprint,
  translationUnitDependencyFingerprint,
  implicitToolchainFingerprint,
} from "./compiler-fingerprint.js";
import { execFileAsync, subprocessFailureDetail } from "./process.js";
import { localizeLibraryObjects } from "./object-merge.js";
import { CacheInputsChangedError } from "./session.js";

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

export async function compileLibArchive(opts: LibArchiveOptions): Promise<void> {
  clearCcCaches();
  const rtDir = runtimeSrcDir();
  const driver = resolveCc();
  const { programShards, programPublicSymbols, programShardMergeIdentity } =
    await selectProgramShards(driver, opts, true);
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
    ...(regex ? ["scr_regex.c", "scr_glob.c"] : []),
    ...(opts.assert || regex || opts.symbol ? ["scr_assert.c"] : []),
    ...(opts.inspect ? ["scr_inspect.c", "scr_console_native.c"] : []),
    ...(opts.symbol ? ["scr_symbol.c"] : []),
    ...(opts.assert && opts.bigint ? ["scr_bigint_assert.c"] : []),
    ...(opts.emitter ? ["scr_events_emitter.c", "scr_dyn_handle.c"] : []),
    ...(opts.dynInvoke
      ? ["scr_dyn_invoke.c", "scr_dyn_inherited.c", "scr_dyn_global_construct.c"]
      : []),
    ...(opts.dynInvoke && opts.dynBuffer ? ["scr_bytes_dyn.c"] : []),
    ...(opts.dynTier === true ? ["scr_js_value.c", "scr_js_object.c"] : []),
    ...(opts.zlib ? ["scr_zlib.c"] : []),
    ...(opts.copying ? ["scr_copying.c"] : []),
  ];
  const cflags = [
    "-std=c11",
    ...driver.targetArgs,
    ...(sanitize
      ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"]
      : [optimization === "dev" ? "-O0" : "-O2"]),
    ...executableSectionEliminationFlags(targetPlatform(driver)).compile,
    "-fno-math-errno",
    "-fno-strict-aliasing", // the emitted object model type-puns — see compileC's buildArgs
    "-Wno-deprecated-declarations",
    "-DSCR_LIB",
    ...(opts.threadInstances ? ["-DSCR_THREAD_INSTANCES"] : []),
    ...(opts.textDecoderLegacy ? ["-DSCR_TEXT_DECODER_LEGACY"] : []),
    ...(opts.dynTier === true ? ["-DSCR_JS_TIER"] : []),
    "-I",
    rtDir,
    ...(regex ? ["-I", vendorEngineDir()] : []),
    ...(opts.zlib ? ["-I", vendorZlibDir()] : []),
  ];
  const programCompilerArgs = opts.cPath.endsWith(".ll")
    ? [...cflags, "-Wno-override-module"]
    : cflags;
  const programSourceExtension = opts.cPath.endsWith(".ll") ? ".ll" : ".c";
  const arArgv = isZigDriver(driver) ? [driver.argv[0]!, "ar"] : ["ar"];
  const cachePolicy = toolchainEnvironmentCachePolicy();
  const configuredCacheRoot = cacheRootDir();
  const toolchainEnv = toolchainEnvironmentFingerprint();
  const persistentDriverCache =
    cachePolicy.runtimeObjects &&
    configuredCacheRoot !== null &&
    (await compilerDriverSupportsPersistentCache(driver, toolchainEnv));
  // A library archive is compile-only from clang's perspective. Link-only
  // search variables cannot affect it, but any mutable compilation input or
  // opaque compiler wrapper makes every persistent tier unsafe to reuse. An
  // opaque archiver narrows only the completed-archive tier below.
  const cacheIdentity = opts.cacheIdentity;
  let persistentCache: { root: string; identity: string } | null =
    cacheIdentity === undefined || configuredCacheRoot === null || !persistentDriverCache
      ? null
      : { root: configuredCacheRoot, identity: cacheIdentity };
  if (persistentCache !== null) {
    try {
      await ensurePrivateCacheRoot(
        persistentCache.root,
        process.env["SCRIPTC_CACHE_DIR"] === undefined,
      );
    } catch {
      persistentCache = null;
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
      persistentCache = null;
    }
  }
  if (persistentCache !== null) {
    try {
      runtimeCompilerInvocation = await effectiveCompilerInvocationFingerprint(
        driver,
        toolchainEnv,
        cflags,
      );
      programCompilerInvocation =
        programSourceExtension === ".ll"
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
      persistentCache = null;
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
    persistentCache !== null &&
    (await archiverSupportsPersistentCache(arArgv, driver));
  let cachedArchive: string | null = null;
  let compilerVersion = "";
  let archiverVersion = "";
  let runtimeHash = "";
  let programDependencyHash = "";
  let cachedProgramBytes =
    opts.programSource === undefined ? null : Buffer.from(opts.programSource, "utf8");
  const identityBytes =
    opts.identityLlvmSource === undefined ? null : Buffer.from(opts.identityLlvmSource, "utf8");
  if (persistentCache !== null) {
    try {
      const [cv, fingerprint, programBytes] = await Promise.all([
        ccVersion(driver.argv, toolchainEnv, true),
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
          .update(programDependencyHash)
          .update("\0")
          .update(persistentCache.identity)
          .update("\0")
          .update(driver.argv.join("\x1f"))
          .update("\0")
          .update(cv)
          .update("\0")
          .update(fingerprint)
          .update("\0")
          .update(arArgv.join("\x1f"))
          .update("\0")
          .update(av)
          .update("\0")
          .update(cflags.join("\x1f"))
          .update("\0")
          .update(sources.join("\x1f"))
          .update("\0")
          // The compiler-visible spelling and resolved location are both inputs:
          // __FILE__ observes the former, while relative includes follow the
          // latter. Archive members also inherit the TU's basename.
          .update(opts.cPath)
          .update("\0")
          .update(resolve(opts.cPath))
          .update("\0")
          .update(programBytes);
        updateProgramShardCacheIdentity(
          key,
          programShards ?? undefined,
          programPublicSymbols,
          programShardMergeIdentity ?? undefined,
        );
        const keyHex = key
          .update("\0identity\0")
          .update(identityBytes === null ? "<none>" : "<generated>")
          .update("\0")
          .update(identityBytes ?? Buffer.alloc(0))
          .digest("hex");
        cachedArchive = join(persistentCache.root, "lib", keyHex);
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

  const transientVendorRoot =
    persistentCache !== null && implicitToolchain !== null
      ? null
      : join(tmpdir(), `scriptc-lib-vendor-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const vendorCacheRoot = transientVendorRoot ?? vendorBuildCacheRoot(persistentCache?.root);
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
          "-c",
          src,
          "-o",
          obj,
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
        persistentCache !== null &&
        cachedProgramBytes !== null &&
        compilerVersion !== "" &&
        implicitToolchain !== null &&
        programCompilerInvocation !== null
      ) {
        const programKey = createHash("sha256")
          .update("lib-program-obj-v3\0")
          .update(cacheTargetIdentity(driver))
          .update("\0")
          .update(toolchainEnv)
          .update("\0")
          .update(implicitToolchain)
          .update("\0")
          .update(programCompilerInvocation)
          .update("\0")
          .update(persistentCache.identity)
          .update("\0")
          .update(driver.argv.join("\x1f"))
          .update("\0")
          .update(compilerVersion)
          .update("\0")
          .update(runtimeHash)
          .update("\0")
          .update(programDependencyHash)
          .update("\0")
          .update(programCompilerArgs.join("\x1f"))
          .update("\0")
          .update(opts.cPath)
          .update("\0")
          .update(resolve(opts.cPath))
          .update("\0")
          .update(cachedProgramBytes);
        updateProgramShardCacheIdentity(
          programKey,
          programShards ?? undefined,
          programPublicSymbols,
          programShardMergeIdentity ?? undefined,
        );
        const programKeyHex = programKey.digest("hex");
        cachedProgramObject = join(persistentCache.root, "program-obj", programKeyHex);
      }
      const stagedProgramObject = join(buildDir, `${stem}.program.o`);
      let programObject: string;
      let programShardFallback = false;
      if (
        cachedProgramObject !== null &&
        (await copyValidCachedFile(cachedProgramObject, stagedProgramObject))
      ) {
        programObject = stagedProgramObject;
      } else if (programShards !== null) {
        try {
          const shardEntries = programShards.map((shard, index) => {
            const sourcePath = join(buildDir, shard.name);
            const staged = join(buildDir, `${stem}.program-${index.toString().padStart(3, "0")}.o`);
            let cachePath: string | null = null;
            if (
              persistentCache !== null &&
              compilerVersion !== "" &&
              implicitCompileToolchain !== null &&
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
                .update(compilerVersion)
                .update("\0")
                .update(runtimeHash)
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
              cachePath = join(persistentCache.root, "program-shard", key);
            }
            return { ...shard, sourcePath, staged, cachePath, missed: false };
          });
          const shardWidth = Math.min(8, availableParallelism());
          for (let i = 0; i < shardEntries.length; i += shardWidth) {
            await Promise.all(
              shardEntries.slice(i, i + shardWidth).map(async (entry) => {
                await writeFile(entry.sourcePath, entry.source);
                if (
                  entry.cachePath !== null &&
                  (await copyValidCachedFile(entry.cachePath, entry.staged))
                )
                  return;
                entry.missed = true;
                await compileOne(entry.sourcePath, basename(entry.staged), opts.cPath);
              }),
            );
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
                  ccVersion(driver.argv, toolchainEnv, true),
                ]);
              const shardInputsStillMatch =
                currentRuntime === runtimeHash &&
                currentInvocation === programCompilerInvocation &&
                currentDependencies === programDependencyHash &&
                currentCompiler === compilerVersion;
              const currentFingerprints = shardInputsStillMatch
                ? await implicitToolchainFingerprints(driver, toolchainEnv)
                : null;
              const compileInputsStillMatch =
                shardInputsStillMatch && currentFingerprints?.compile === implicitCompileToolchain;
              let mergedInputsStillMatch = false;
              if (compileInputsStillMatch && cachedProgramObject !== null) {
                const currentMerge = await resolveProgramShardMergeIdentity(driver).catch(
                  () => null,
                );
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
            const [
              currentRuntime,
              currentImplicit,
              currentInvocation,
              currentDependencies,
              currentCompiler,
            ] = await Promise.all([
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
              ccVersion(driver.argv, toolchainEnv, true),
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
      const identityObject =
        identityBytes === null
          ? null
          : await (async () => {
              const source = join(buildDir, "identity.ll");
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
      if (persistentCache !== null && compilerVersion !== "" && runtimeHash !== "") {
        try {
          const sourcePaths = sources.map((f) => join(rtDir, f));
          const cached = await ensureRuntimeObjects(
            persistentCache.root,
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
              sources
                .slice(i, i + width)
                .map((f) => compileOne(join(rtDir, f), f.replace(/\.c$/, ".o"))),
            )),
          );
        }
      }
      const objects = [
        programObject,
        ...(identityObject === null ? [] : [identityObject]),
        ...runtimeObjects,
        ...lreObjects,
        ...zlibObjects,
      ];
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
        persistentCache !== null &&
        runtimeHash !== "" &&
        programDependencyHash !== "" &&
        compilerVersion !== "" &&
        archiverVersion !== ""
      ) {
        const [
          currentRuntime,
          currentImplicit,
          currentRuntimeInvocation,
          currentProgramInvocation,
          currentProgramDependencies,
          currentCompiler,
          currentArchiver,
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
            cflags,
            opts.cPath,
            cachedProgramBytes!,
            toolchainEnv,
          ).catch(() => null),
          ccVersion(driver.argv, toolchainEnv, true).catch(() => null),
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
      if (cachedArchive !== null && persistentCache !== null && runtimeStillMatchesKey) {
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
  if (persistentCache !== null) {
    await pruneCache(persistentCache.root).catch(() => undefined);
  }
}
