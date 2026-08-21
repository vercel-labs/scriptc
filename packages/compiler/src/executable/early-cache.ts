import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FrontendInputSnapshot } from "../frontend/input-tracker.js";
import { frontendInputsStillMatch, validFrontendInputSnapshot } from "../frontend/input-tracker.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { nativeArtifactDependenciesStillMatch, type NativeArtifactDependency } from "../backend/cc.js";

interface CachedExecutableFile {
  name: string;
  digest: string;
}

export interface EarlyExecutableNativeFeatures {
  backend: "c" | "llvm";
  llvmRefusal?: string;
  dynamic: boolean;
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
  backend: "auto" | "c" | "llvm";
  npmStatic: readonly string[] | "auto" | null;
  /** Raw manifest identity: path and bytes. Native archives remain under the
   * stricter native cache's independent dependency validation. */
  ffiProfile: { path: string; bytes: Uint8Array } | null;
  target: string;
  compiler: string[];
  nativeEnvironment: string;
  nodeVersion: string;
  implementation: string;
}

export interface EarlyExecutableCacheHit {
  cPath: string;
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
  if (value === null || typeof value !== "object") return false;
  const native = value as Partial<EarlyExecutableNativeFeatures>;
  return (native.backend === "c" || native.backend === "llvm") &&
    (native.llvmRefusal === undefined || typeof native.llvmRefusal === "string") &&
    BOOLEAN_NATIVE_KEYS.every((key) => typeof native[key] === "boolean");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheKey(options: EarlyExecutableCacheOptions): string {
  const hash = createHash("sha256")
    .update("early-executable-v1\0")
    .update(compilerReleaseVersion()).update("\0")
    .update(resolve(options.entryPath)).update("\0")
    .update(resolve(options.outDir)).update("\0")
    .update(resolve(options.outPath)).update("\0")
    .update(options.emitIr ? "emit-ir" : "no-ir").update("\0")
    .update(options.sanitize ? "sanitize" : "plain").update("\0")
    .update(options.dynamic ? "dynamic" : "static").update("\0")
    .update(options.backend).update("\0")
    .update(options.npmStatic === null
      ? "<npm-static-off>"
      : options.npmStatic === "auto"
        ? "<npm-static-auto>"
        : JSON.stringify(options.npmStatic)).update("\0")
    .update(options.target).update("\0")
    .update(options.compiler.join("\x1f")).update("\0")
    .update(options.nativeEnvironment).update("\0")
    .update(options.nodeVersion).update("\0")
    .update(options.implementation).update("\0");
  if (options.ffiProfile === null) {
    hash.update("<ffi-off>");
  } else {
    hash
      .update(resolve(options.ffiProfile.path)).update("\0")
      .update(options.ffiProfile.bytes);
  }
  return hash.digest("hex");
}

function stampPath(root: string, options: EarlyExecutableCacheOptions): string {
  return join(root, "early-exe", cacheKey(options), "stamp.json");
}

function stampIntegrity(stamp: Omit<EarlyExecutableCacheStamp, "integrity">): string {
  return createHash("sha256")
    .update("early-executable-stamp-v1\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

function outputPaths(options: EarlyExecutableCacheOptions, backend: "c" | "llvm"): {
  cPath: string;
  staleCPath: string;
  irPath: string;
} {
  const stem = basename(options.entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  return {
    cPath: join(options.outDir, `${stem}.${backend === "llvm" ? "ll" : "c"}`),
    staleCPath: join(options.outDir, `${stem}.${backend === "llvm" ? "c" : "ll"}`),
    irPath: join(options.outDir, `${stem}.ir.json`),
  };
}

function frontendOutputExclusions(
  options: EarlyExecutableCacheOptions,
  backend: "c" | "llvm",
): { outputPaths: string[]; outputDirectories: Set<string> } {
  const paths = outputPaths(options, backend);
  const outputArtifacts = [
    paths.cPath,
    paths.staleCPath,
    ...(options.emitIr ? [paths.irPath] : []),
    options.outPath,
  ].map((path) => resolve(path));
  const outputDirectories = new Set<string>();
  for (const artifact of outputArtifacts) {
    for (let directory = dirname(artifact); ; directory = dirname(directory)) {
      outputDirectories.add(directory);
      if (dirname(directory) === directory) break;
    }
  }
  return { outputPaths: outputArtifacts, outputDirectories };
}

async function readCachedFile(path: string, expected: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(path);
    return digest(bytes) === expected ? bytes : null;
  } catch {
    return null;
  }
}

async function installBytes(bytes: Uint8Array, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = join(
    dirname(destination),
    `.scriptc-exe-hit-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o666 & ~process.umask());
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
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
  if (root === null) return null;
  const path = stampPath(root, options);
  try {
    const stamp = JSON.parse(await readFile(path, "utf8")) as EarlyExecutableCacheStamp;
    const { integrity, ...unsigned } = stamp;
    if (
      stamp.version !== 1 || stamp.key !== cacheKey(options) ||
      !validFrontendInputSnapshot(stamp.frontend) || !validNativeFeatures(stamp.native) ||
      stamp.files?.translationUnit?.name !== "program.tu" ||
      !/^[0-9a-f]{64}$/.test(stamp.files.translationUnit.digest) ||
      (stamp.files.ir !== null && (
        stamp.files.ir?.name !== "program.ir.json" ||
        !/^[0-9a-f]{64}$/.test(stamp.files.ir.digest)
      )) ||
      (stamp.files.executable !== null && (
        stamp.files.executable?.name !== "program.bin" ||
        !/^[0-9a-f]{64}$/.test(stamp.files.executable.digest)
      )) ||
      (stamp.files.executable === null) !== (stamp.nativeDependencies === null) ||
      (stamp.nativeDependencies !== null && !Array.isArray(stamp.nativeDependencies)) ||
      (stamp.files.ir !== null) !== options.emitIr ||
      stampIntegrity(unsigned) !== integrity ||
      !frontendInputsStillMatch(
        stamp.frontend,
        frontendOutputExclusions(options, stamp.native.backend),
      )
    ) return null;

    const directory = dirname(path);
    const [translationUnit, ir, executable] = await Promise.all([
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
    ]);
    if (
      translationUnit === null ||
      stamp.files.ir !== null && ir === null ||
      stamp.files.executable !== null && executable === null
    ) return null;

    // Validate the native proof before restoring frontend artifacts: replacing
    // a TU can update its output directory metadata, which is itself part of
    // compileC's same-output dependency snapshot.
    let executableRestored =
      executable !== null && stamp.nativeDependencies !== null &&
      await nativeArtifactDependenciesStillMatch(stamp.nativeDependencies) &&
      // Recheck after hashing every dependency: a concurrent tool/runtime
      // update must not win the window immediately before installation.
      await nativeArtifactDependenciesStillMatch(stamp.nativeDependencies);
    const paths = outputPaths(options, stamp.native.backend);
    if (!(await fileMatches(paths.cPath, stamp.files.translationUnit.digest))) {
      await installBytes(translationUnit, paths.cPath);
    }
    await rm(paths.staleCPath, { force: true });
    if (
      ir !== null && stamp.files.ir !== null &&
      !(await fileMatches(paths.irPath, stamp.files.ir.digest))
    ) await installBytes(ir, paths.irPath);
    if (executableRestored) {
      try {
        const expectedMode = 0o777 & ~process.umask();
        if (!(await fileMatches(options.outPath, stamp.files.executable!.digest, expectedMode))) {
          await installExecutable(executable!, options.outPath);
        }
      } catch {
        executableRestored = false;
      }
    }
    const now = new Date();
    await Promise.all([
      path,
      join(directory, stamp.files.translationUnit.name),
      ...(stamp.files.ir === null ? [] : [join(directory, stamp.files.ir.name)]),
      ...(stamp.files.executable === null ? [] : [join(directory, stamp.files.executable.name)]),
    ].map((cachePath) => utimes(cachePath, now, now).catch(() => undefined)));
    return {
      cPath: paths.cPath,
      native: stamp.native,
      executableRestored,
      frontend: stamp.frontend,
      ...(ir === null ? {} : { irPath: paths.irPath }),
    };
  } catch {
    return null;
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
      publishFile(result.cPath, "program.tu"),
      result.irPath === undefined
        ? Promise.resolve(null)
        : publishFile(result.irPath, "program.ir.json"),
      publishExecutable,
    ]);
    if (!frontendInputsStillMatch(
      result.frontend,
      frontendOutputExclusions(options, result.native.backend),
    )) return;
    const unsigned: Omit<EarlyExecutableCacheStamp, "integrity"> = {
      version: 1,
      key: cacheKey(options),
      frontend: result.frontend,
      files: { translationUnit, ir, executable },
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
    await install("stamp.json");
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
