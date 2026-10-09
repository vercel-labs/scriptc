import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FrontendInputSnapshot } from "../frontend/input-tracker.js";
import { frontendInputsStillMatch, validFrontendInputSnapshot } from "../frontend/input-tracker.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { nativeArtifactDependenciesStillMatch } from "../backend/native/artifact-stamps.js";
import { type NativeArtifactDependency } from "../backend/native/contracts.js";
import { optimizationKeyParts } from "../backend/optimization.js";
import type { CompilerImplementationDependency } from "../library/compiler-self-identity.js";
import {
  installDarwinDebugSymbols,
  needsDarwinDebugSymbols,
  readDarwinDebugSymbols,
} from "../backend/debug-symbols.js";
import {
  compilerImplementationDependenciesStillMatch,
  compilerImplementationRoot,
} from "../library/compiler-self-identity.js";
import {
  cacheKey as sharedCacheKey,
  digest,
  frontendOutputExclusions,
  installBytes,
  outputPaths,
  readCachedFile,
  stampIntegrity as sharedStampIntegrity,
  stampPath as sharedStampPath,
  validNativeFeatures as validSharedNativeFeatures,
} from "../library/cache-primitives.js";

interface CachedExecutableFile {
  name: string;
  digest: string;
}

export interface EarlyExecutableNativeFeatures {
  backend: "llvm";
  /** Omitted is the historical release posture. */
  optimization?: "dev" | "speed";
  dynamic: boolean;
  workers?: boolean;
  regex: boolean;
  copying: boolean;
  textDecoderLegacy: boolean;
  fileHandle: boolean;
  fetch: boolean;
  netIsland: boolean;
  zlib: boolean;
  assert: boolean;
  inspect: boolean;
  dynInvoke: boolean;
  dc: boolean;
  dynAsync: boolean;
  events: boolean;
  emitter: boolean;
  symbol: boolean;
  bigint: boolean;
  searchParams: boolean;
  qs: boolean;
  parseArgs: boolean;
  stream: boolean;
  net: boolean;
  http: boolean;
  http2: boolean;
  dgram: boolean;
  watch: boolean;
  foreignFfi: boolean;
  nodeTest: boolean;
  tls: boolean;
  tlsCa: boolean;
}

interface EarlyExecutableCacheStamp {
  version: 1;
  key: string;
  frontend: FrontendInputSnapshot;
  files: {
    translationUnit: CachedExecutableFile;
    ir: CachedExecutableFile | null;
    executable: CachedExecutableFile | null;
    debugSymbols?: CachedExecutableFile;
  };
  nativeDependencies: NativeArtifactDependency[] | null;
  native: EarlyExecutableNativeFeatures;
  integrity: string;
}

export interface EarlyExecutableCacheOptions {
  entryPath: string;
  outDir: string;
  outPath: string;
  emitIr: boolean;
  sanitize: boolean;
  dynamic: boolean;
  backend: "llvm";
  /** Omitted is the historical release posture and preserves v1 keys. */
  optimization?: "dev" | "speed";
  /** Omitted retains the unstripped executable's historical cache key. */
  strip?: true;
  /** Omitted for the default Windows console subsystem. */
  windowsSubsystem?: "gui";
  npmStatic: readonly string[] | "auto" | null;
  /** Raw manifest identity: path and bytes. Native archives remain under the
   * stricter native cache's independent dependency validation. */
  ffiProfile: { path: string; bytes: Uint8Array } | null;
  target: string;
  compiler: string[];
  nativeEnvironment: string;
  nodeVersion: string;
  implementation: string;
  implementationDependencies: CompilerImplementationDependency[];
}

export type EarlyExecutableRouteOptions = Omit<
  EarlyExecutableCacheOptions,
  "implementation" | "implementationDependencies" | "nativeEnvironment"
> & {
  /** Discovery waits until a complete payload and its frontend proof match. */
  nativeEnvironment: string | (() => Promise<string>);
};

interface EarlyExecutableRouteStamp {
  version: 2;
  key: string;
  implementation: string;
  nativeEnvironment: string;
  integrity: string;
}

interface EarlyExecutableImplementationProof {
  version: 1;
  implementation: string;
  dependencies: CompilerImplementationDependency[];
  integrity: string;
}

export interface EarlyExecutableCacheHit {
  llvmPath: string;
  irPath?: string;
  /** True when the final executable was restored after native dependencies
   * validated. False restores only frontend artifacts and must call compileC. */
  executableRestored: boolean;
  native: EarlyExecutableNativeFeatures;
  frontend: FrontendInputSnapshot;
}

export interface EarlyExecutableCachePublish extends EarlyExecutableCacheHit {
  nativeDependencies?: NativeArtifactDependency[];
}

const BOOLEAN_NATIVE_KEYS = [
  "dynamic",
  "regex",
  "copying",
  "textDecoderLegacy",
  "fileHandle",
  "fetch",
  "netIsland",
  "zlib",
  "assert",
  "inspect",
  "dynInvoke",
  "dc",
  "dynAsync",
  "events",
  "emitter",
  "symbol",
  "bigint",
  "searchParams",
  "qs",
  "parseArgs",
  "stream",
  "net",
  "http",
  "http2",
  "dgram",
  "watch",
  "foreignFfi",
  "nodeTest",
  "tls",
  "tlsCa",
] as const satisfies readonly (keyof EarlyExecutableNativeFeatures)[];

function validNativeFeatures(value: unknown): value is EarlyExecutableNativeFeatures {
  return validSharedNativeFeatures<EarlyExecutableNativeFeatures>(
    value,
    BOOLEAN_NATIVE_KEYS,
    (native) =>
      (native.optimization === undefined ||
        native.optimization === "dev" ||
        native.optimization === "speed") &&
      (native.workers === undefined || typeof native.workers === "boolean"),
  );
}

function cacheKey(options: EarlyExecutableCacheOptions): string {
  const ffiParts: (string | Uint8Array)[] =
    options.ffiProfile === null
      ? ["<ffi-off>"]
      : [resolve(options.ffiProfile.path), options.ffiProfile.bytes];
  return sharedCacheKey("early-executable-v1", [
    resolve(options.entryPath),
    resolve(options.outDir),
    resolve(options.outPath),
    options.emitIr ? "emit-ir" : "no-ir",
    options.sanitize ? "sanitize" : "plain",
    options.dynamic ? "dynamic" : "static",
    options.backend,
    ...optimizationKeyParts(options.optimization),
    ...(options.strip ? ["strip"] : []),
    ...(options.windowsSubsystem === "gui" ? ["windows-subsystem-gui"] : []),
    options.npmStatic === null
      ? "<npm-static-off>"
      : options.npmStatic === "auto"
        ? "<npm-static-auto>"
        : JSON.stringify(options.npmStatic),
    options.target,
    options.compiler.join("\x1f"),
    options.nativeEnvironment,
    options.nodeVersion,
    options.implementation,
    ...ffiParts,
  ]);
}

function routeKey(options: Omit<EarlyExecutableRouteOptions, "nativeEnvironment">): string {
  const hash = createHash("sha256")
    .update("early-executable-route-v2\0")
    .update(compilerReleaseVersion())
    .update("\0")
    .update(compilerImplementationRoot())
    .update("\0")
    .update(resolve(options.entryPath))
    .update("\0")
    .update(resolve(options.outDir))
    .update("\0")
    .update(resolve(options.outPath))
    .update("\0")
    .update(options.emitIr ? "emit-ir" : "no-ir")
    .update("\0")
    .update(options.sanitize ? "sanitize" : "plain")
    .update("\0")
    .update(options.dynamic ? "dynamic" : "static")
    .update("\0")
    .update(options.backend)
    .update("\0");
  for (const part of optimizationKeyParts(options.optimization)) hash.update(`${part}\0`);
  if (options.strip) hash.update("strip\0");
  if (options.windowsSubsystem === "gui") hash.update("windows-subsystem-gui\0");
  hash
    .update(
      options.npmStatic === null
        ? "<npm-static-off>"
        : options.npmStatic === "auto"
          ? "<npm-static-auto>"
          : JSON.stringify(options.npmStatic),
    )
    .update("\0")
    .update(options.target)
    .update("\0")
    .update(options.compiler.join("\x1f"))
    .update("\0")
    .update(options.nodeVersion)
    .update("\0");
  if (options.ffiProfile === null) {
    hash.update("<ffi-off>");
  } else {
    hash.update(resolve(options.ffiProfile.path)).update("\0").update(options.ffiProfile.bytes);
  }
  return hash.digest("hex");
}

function routePath(
  root: string,
  options: Omit<EarlyExecutableRouteOptions, "nativeEnvironment">,
): string {
  return join(root, "early-exe-route", routeKey(options));
}

function routeIntegrity(stamp: Omit<EarlyExecutableRouteStamp, "integrity">): string {
  return createHash("sha256")
    .update("early-executable-route-stamp-v2\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

function implementationProofPath(root: string, implementation: string): string {
  const install = createHash("sha256")
    .update("early-executable-install-v1\0")
    .update(compilerImplementationRoot())
    .digest("hex");
  return join(root, "early-exe-implementation", install, implementation);
}

function implementationProofIntegrity(
  proof: Omit<EarlyExecutableImplementationProof, "integrity">,
): string {
  return createHash("sha256")
    .update("early-executable-implementation-proof-v1\0")
    .update(JSON.stringify(proof))
    .digest("hex");
}

async function installCacheMetadata(source: string, destination: string): Promise<void> {
  await rename(source, destination).catch(async () => {
    // Windows does not replace an existing destination with rename(). Route
    // and implementation-proof files are republished on every full compile,
    // so use the same replacement fallback as the payload cache below.
    await rm(destination, { force: true });
    await rename(source, destination);
  });
}

function stampPath(root: string, options: EarlyExecutableCacheOptions): string {
  return sharedStampPath(root, "early-exe", cacheKey(options));
}

function stampIntegrity(stamp: Omit<EarlyExecutableCacheStamp, "integrity">): string {
  return sharedStampIntegrity("early-executable-stamp-v1", stamp);
}

function executableFrontendOutputExclusions(
  options: EarlyExecutableCacheOptions,
  backend: "llvm",
): ReturnType<typeof frontendOutputExclusions> {
  return frontendOutputExclusions(options, backend, "", [
    options.outPath,
    `${options.outPath}.dSYM`,
  ]);
}

/** Ordinary source/configuration edits are cheap misses before driver
 * discovery. Replay declaration-file bytes and resolution metadata in the
 * final complete proof instead of twice. */
function routedFrontendCandidate(frontend: FrontendInputSnapshot): FrontendInputSnapshot {
  return {
    ...frontend,
    probes: frontend.probes.filter(
      (probe) => probe.op === "file" && !/\.d\.(?:ts|mts|cts)$/.test(probe.path),
    ),
  };
}

async function fileMatches(
  destination: string,
  expectedDigest: string,
  expectedMode?: number,
): Promise<boolean> {
  try {
    if (expectedMode !== undefined) {
      const info = await stat(destination);
      if (!info.isFile() || (info.mode & 0o777) !== expectedMode) return false;
    }
    return digest(await readFile(destination)) === expectedDigest;
  } catch {
    return false;
  }
}

async function installExecutable(bytes: Uint8Array, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = join(
    dirname(destination),
    `.scriptc-exe-bin-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o777 & ~process.umask());
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function readEarlyExecutableCache(
  root: string | null,
  options: EarlyExecutableCacheOptions,
): Promise<EarlyExecutableCacheHit | null> {
  return readExecutableCache(root, options);
}

async function readExecutableCache(
  root: string | null,
  options: EarlyExecutableCacheOptions,
  validateRoute?: () => Promise<boolean>,
): Promise<EarlyExecutableCacheHit | null> {
  if (root === null) return null;
  const path = stampPath(root, options);
  try {
    const stamp = JSON.parse(await readFile(path, "utf8")) as EarlyExecutableCacheStamp;
    const { integrity, ...unsigned } = stamp;
    if (
      stamp.version !== 1 ||
      stamp.key !== cacheKey(options) ||
      !validFrontendInputSnapshot(stamp.frontend) ||
      !validNativeFeatures(stamp.native) ||
      stamp.files?.translationUnit?.name !== "program.tu" ||
      !/^[0-9a-f]{64}$/.test(stamp.files.translationUnit.digest) ||
      (stamp.files.ir !== null &&
        (stamp.files.ir?.name !== "program.ir.json" ||
          !/^[0-9a-f]{64}$/.test(stamp.files.ir.digest))) ||
      (stamp.files.executable !== null &&
        (stamp.files.executable?.name !== "program.bin" ||
          !/^[0-9a-f]{64}$/.test(stamp.files.executable.digest))) ||
      (stamp.files.debugSymbols !== undefined &&
        (stamp.files.executable === null ||
          stamp.files.debugSymbols.name !== "program.dsym" ||
          !/^[0-9a-f]{64}$/.test(stamp.files.debugSymbols.digest))) ||
      (stamp.files.executable !== null &&
        needsDarwinDebugSymbols(
          options.target.split(":")[1] ?? "",
          options.optimization,
          options.strip,
        ) !==
          (stamp.files.debugSymbols !== undefined)) ||
      (stamp.files.executable === null) !== (stamp.nativeDependencies === null) ||
      (stamp.nativeDependencies !== null && !Array.isArray(stamp.nativeDependencies)) ||
      (stamp.files.ir !== null) !== options.emitIr ||
      stampIntegrity(unsigned) !== integrity ||
      !frontendInputsStillMatch(
        validateRoute === undefined ? stamp.frontend : routedFrontendCandidate(stamp.frontend),
        executableFrontendOutputExclusions(options, stamp.native.backend),
      )
    )
      return null;

    // Startup may defer driver discovery until the source/configuration proof
    // matches. A frontend-only entry cannot serve that route, so it should
    // fall through without probing a driver the full compiler will probe too.
    if (validateRoute !== undefined && stamp.files.executable === null) return null;
    const directory = dirname(path);
    const [translationUnit, ir, executable, debugSymbols] = await Promise.all([
      readCachedFile(
        join(directory, stamp.files.translationUnit.name),
        stamp.files.translationUnit.digest,
      ),
      stamp.files.ir === null
        ? Promise.resolve(null)
        : readCachedFile(join(directory, stamp.files.ir.name), stamp.files.ir.digest),
      stamp.files.executable === null
        ? Promise.resolve(null)
        : readCachedFile(
            join(directory, stamp.files.executable.name),
            stamp.files.executable.digest,
          ),
      stamp.files.debugSymbols === undefined
        ? Promise.resolve(null)
        : readCachedFile(
            join(directory, stamp.files.debugSymbols.name),
            stamp.files.debugSymbols.digest,
          ),
    ]);
    if (
      translationUnit === null ||
      (stamp.files.ir !== null && ir === null) ||
      (stamp.files.executable !== null && executable === null) ||
      (stamp.files.debugSymbols !== undefined && debugSymbols === null)
    )
      return null;

    if (validateRoute !== undefined) {
      if (!(await validateRoute())) return null;
      // The compiler proof is checked AFTER deferred discovery by the routed
      // reader. Recheck source/configuration bytes here too before restoring.
      if (
        !frontendInputsStillMatch(
          stamp.frontend,
          executableFrontendOutputExclusions(options, stamp.native.backend),
        )
      )
        return null;
    }
    // Validate the native proof before restoring frontend artifacts: replacing
    // a TU can update its output directory metadata, which is itself part of
    // compileC's same-output dependency snapshot.
    let executableRestored =
      executable !== null &&
      stamp.nativeDependencies !== null &&
      (await nativeArtifactDependenciesStillMatch(stamp.nativeDependencies)) &&
      // Recheck after hashing every dependency: a concurrent tool/runtime
      // update must not win the window immediately before installation.
      (await nativeArtifactDependenciesStillMatch(stamp.nativeDependencies));
    if (validateRoute !== undefined && !executableRestored) return null;
    const paths = outputPaths(options, stamp.native.backend);
    if (!(await fileMatches(paths.llvmPath, stamp.files.translationUnit.digest))) {
      await installBytes(translationUnit, paths.llvmPath);
    }
    if (
      ir !== null &&
      stamp.files.ir !== null &&
      !(await fileMatches(paths.irPath, stamp.files.ir.digest))
    )
      await installBytes(ir, paths.irPath);
    if (executableRestored) {
      try {
        if (debugSymbols !== null) await installDarwinDebugSymbols(debugSymbols, options.outPath);
        const expectedMode = 0o777 & ~process.umask();
        if (!(await fileMatches(options.outPath, stamp.files.executable!.digest, expectedMode))) {
          await installExecutable(executable!, options.outPath);
        }
        if (debugSymbols === null && options.target.split(":")[1] === "darwin") {
          await rm(`${options.outPath}.dSYM`, { recursive: true, force: true });
        }
      } catch {
        executableRestored = false;
      }
    }
    const now = new Date();
    await Promise.all(
      [
        path,
        join(directory, stamp.files.translationUnit.name),
        ...(stamp.files.ir === null ? [] : [join(directory, stamp.files.ir.name)]),
        ...(stamp.files.executable === null ? [] : [join(directory, stamp.files.executable.name)]),
        ...(stamp.files.debugSymbols === undefined
          ? []
          : [join(directory, stamp.files.debugSymbols.name)]),
      ].map((cachePath) => utimes(cachePath, now, now).catch(() => undefined)),
    );
    return {
      llvmPath: paths.llvmPath,
      native: stamp.native,
      executableRestored,
      frontend: stamp.frontend,
      ...(ir === null ? {} : { irPath: paths.irPath }),
    };
  } catch {
    return null;
  }
}

/** Follow the exact-invocation route without hashing/importing the complete
 * compiler package. Source/configuration misses skip deferred driver discovery;
 * a hit still proves the current native environment before restoring output.
 * The route is only an index: the full payload key retains that environment. */
export async function readRoutedExecutableCache(
  root: string | null,
  options: EarlyExecutableRouteOptions,
): Promise<EarlyExecutableCacheHit | null> {
  if (root === null) return null;
  try {
    const routeFile = routePath(root, options);
    const route = JSON.parse(await readFile(routeFile, "utf8")) as EarlyExecutableRouteStamp;
    const { integrity, ...unsigned } = route;
    if (
      route.version !== 2 ||
      !/^[0-9a-f]{64}$/.test(route.key) ||
      !/^[0-9a-f]{64}$/.test(route.implementation) ||
      typeof route.nativeEnvironment !== "string" ||
      (typeof options.nativeEnvironment === "string" &&
        options.nativeEnvironment !== route.nativeEnvironment) ||
      routeIntegrity(unsigned) !== integrity
    )
      return null;
    const proofFile = implementationProofPath(root, route.implementation);
    const proof = JSON.parse(
      await readFile(proofFile, "utf8"),
    ) as EarlyExecutableImplementationProof;
    const { integrity: proofIntegrity, ...proofUnsigned } = proof;
    if (
      proof.version !== 1 ||
      proof.implementation !== route.implementation ||
      !Array.isArray(proof.dependencies) ||
      implementationProofIntegrity(proofUnsigned) !== proofIntegrity
    )
      return null;
    const complete: EarlyExecutableCacheOptions = {
      ...options,
      nativeEnvironment: route.nativeEnvironment,
      implementation: route.implementation,
      implementationDependencies: proof.dependencies,
    };
    if (cacheKey(complete) !== route.key) return null;
    const hit = await readExecutableCache(root, complete, async () => {
      const environment =
        typeof options.nativeEnvironment === "function"
          ? await options.nativeEnvironment()
          : options.nativeEnvironment;
      return (
        environment === route.nativeEnvironment &&
        (await compilerImplementationDependenciesStillMatch(proof.dependencies))
      );
    });
    if (hit?.executableRestored !== true) return null;
    const now = new Date();
    await Promise.all(
      [routeFile, proofFile].map((cachePath) => utimes(cachePath, now, now).catch(() => undefined)),
    );
    return hit;
  } catch {
    return null;
  }
}

/** Publish the lightweight lookup metadata for an already-validated payload.
 * Full-compiler cache hits call this as a repair path: route/proof files can be
 * evicted independently of the larger executable entry, and one fallback
 * lookup should make later CLI invocations lightweight again. */
export async function publishEarlyExecutableRoute(
  root: string | null,
  options: EarlyExecutableCacheOptions,
): Promise<void> {
  if (root === null) return;
  const proofDestination = implementationProofPath(root, options.implementation);
  const proofUnsigned: Omit<EarlyExecutableImplementationProof, "integrity"> = {
    version: 1,
    implementation: options.implementation,
    dependencies: options.implementationDependencies,
  };
  const proof: EarlyExecutableImplementationProof = {
    ...proofUnsigned,
    integrity: implementationProofIntegrity(proofUnsigned),
  };
  await mkdir(dirname(proofDestination), { recursive: true, mode: 0o700 });
  const proofTmp = `${proofDestination}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(proofTmp, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
    await installCacheMetadata(proofTmp, proofDestination);
  } finally {
    await rm(proofTmp, { force: true }).catch(() => undefined);
  }

  const routeOptions: EarlyExecutableRouteOptions = options;
  const routeDestination = routePath(root, routeOptions);
  const routeUnsigned: Omit<EarlyExecutableRouteStamp, "integrity"> = {
    version: 2,
    key: cacheKey(options),
    implementation: options.implementation,
    nativeEnvironment: options.nativeEnvironment,
  };
  const route: EarlyExecutableRouteStamp = {
    ...routeUnsigned,
    integrity: routeIntegrity(routeUnsigned),
  };
  await mkdir(dirname(routeDestination), { recursive: true, mode: 0o700 });
  const routeTmp = `${routeDestination}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(routeTmp, `${JSON.stringify(route)}\n`, { mode: 0o600 });
    await installCacheMetadata(routeTmp, routeDestination);
  } finally {
    await rm(routeTmp, { force: true }).catch(() => undefined);
  }
}

export async function publishEarlyExecutableCache(
  root: string | null,
  options: EarlyExecutableCacheOptions,
  result: EarlyExecutableCachePublish,
): Promise<void> {
  if (root === null || !result.frontend.stable) return;
  const destination = dirname(stampPath(root, options));
  const parent = dirname(destination);
  const stage = join(
    parent,
    `.tmp-${basename(destination).slice(0, 12)}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const publishFile = async (source: string, name: string): Promise<CachedExecutableFile> => {
      const target = join(stage, name);
      await copyFile(source, target);
      await chmod(target, 0o600);
      return { name, digest: digest(await readFile(target)) };
    };
    const publishExecutable =
      result.nativeDependencies === undefined || !result.executableRestored
        ? Promise.resolve(null)
        : publishFile(options.outPath, "program.bin");
    const [translationUnit, ir, executable] = await Promise.all([
      publishFile(result.llvmPath, "program.tu"),
      result.irPath === undefined
        ? Promise.resolve(null)
        : publishFile(result.irPath, "program.ir.json"),
      publishExecutable,
    ]);
    let debugSymbols: CachedExecutableFile | undefined;
    if (
      executable !== null &&
      needsDarwinDebugSymbols(
        options.target.split(":")[1] ?? "",
        options.optimization,
        options.strip,
      )
    ) {
      const bytes = await readDarwinDebugSymbols(options.outPath);
      await writeFile(join(stage, "program.dsym"), bytes, { mode: 0o600 });
      debugSymbols = { name: "program.dsym", digest: digest(bytes) };
    }
    if (
      !frontendInputsStillMatch(
        result.frontend,
        executableFrontendOutputExclusions(options, result.native.backend),
      )
    )
      return;
    const unsigned: Omit<EarlyExecutableCacheStamp, "integrity"> = {
      version: 1,
      key: cacheKey(options),
      frontend: result.frontend,
      files: {
        translationUnit,
        ir,
        executable,
        ...(debugSymbols === undefined ? {} : { debugSymbols }),
      },
      nativeDependencies: executable === null ? null : result.nativeDependencies!,
      native: result.native,
    };
    const stamp: EarlyExecutableCacheStamp = { ...unsigned, integrity: stampIntegrity(unsigned) };
    await writeFile(join(stage, "stamp.json"), `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const install = async (name: string): Promise<void> => {
      const source = join(stage, name);
      const target = join(destination, name);
      await rename(source, target).catch(async () => {
        await rm(target, { force: true });
        await rename(source, target);
      });
    };
    await install(translationUnit.name);
    if (ir !== null) await install(ir.name);
    if (executable !== null) await install(executable.name);
    if (debugSymbols !== undefined) await install(debugSymbols.name);
    await install("stamp.json");
    await publishEarlyExecutableRoute(root, options);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
