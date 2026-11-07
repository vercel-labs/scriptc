import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { executableHardeningLinkerArgs, executableOptimizationLinkerArgs } from "../targets.js";
import { readDarwinDebugSymbols } from "../debug-symbols.js";
import { fileDigest } from "../build-cache.js";
import { type NativeArtifactDependency, type CcOptions } from "./contracts.js";
import { fingerprintDependenciesStillMatch } from "./dependency-files.js";
import { CacheInputsChangedError } from "./session.js";
import {
  type CcDriver,
  executableSectionEliminationFlags,
  isMuslTarget,
  targetPlatform,
  cacheTargetIdentity,
} from "./driver.js";
import { updateProgramShardCacheIdentity } from "./program-shards.js";

interface LocalArtifactStamp {
  version: 2;
  key: string;
  digest: string;
  debugSymbolsDigest?: string;
  dependencies: NativeArtifactDependency[];
  integrity: string;
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
      if (
        excluded.some(
          (candidate) =>
            absolute === candidate ||
            absolute.startsWith(`${candidate}/`) ||
            absolute.startsWith(`${candidate}\\`),
        )
      )
        continue;
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
      dependency.treeExclusions = [
        ...new Set(treeExclusions.map((entry) => resolve(entry))),
      ].sort();
      dependency.treeDigest = await directoryTreeDigest(path, dependency.treeExclusions);
    }
  }
  return dependency;
}

export async function snapshotLocalArtifactDependencies(
  dependencyPaths: readonly string[],
  recursiveDirectories: readonly string[] = [],
  recursiveExclusions: readonly string[] = [],
): Promise<NativeArtifactDependency[]> {
  const recursive = new Set(recursiveDirectories.map((path) => resolve(path)));
  return Promise.all(
    [...new Set(dependencyPaths)]
      .sort()
      .map((path) =>
        snapshotLocalArtifactDependency(
          path,
          recursive.has(resolve(path)) ? recursiveExclusions : null,
        ),
      ),
  );
}

/** Capture exact filesystem identities for inputs produced outside the C
 * toolchain but consumed by its cache proofs. Callers carry this snapshot
 * forward so later stages can prove the same inputs remained installed. */
export async function snapshotNativeArtifactDependencies(
  dependencyPaths: readonly string[],
): Promise<NativeArtifactDependency[]> {
  return snapshotLocalArtifactDependencies(dependencyPaths);
}

export async function nativeArtifactDependenciesStillMatch(
  dependencies: readonly NativeArtifactDependency[],
): Promise<boolean> {
  if (
    !dependencies.every(
      (dependency) =>
        dependency !== null &&
        typeof dependency === "object" &&
        typeof dependency.path === "string" &&
        (dependency.kind === "file" ||
          dependency.kind === "directory" ||
          dependency.kind === "symlink") &&
        typeof dependency.dev === "number" &&
        typeof dependency.ino === "number" &&
        typeof dependency.size === "number" &&
        typeof dependency.mtimeMs === "number" &&
        typeof dependency.ctimeMs === "number" &&
        (dependency.treeDigest === undefined || typeof dependency.treeDigest === "string") &&
        (dependency.treeExclusions === undefined ||
          (Array.isArray(dependency.treeExclusions) &&
            dependency.treeExclusions.every((path) => typeof path === "string"))) &&
        (dependency.kind !== "symlink" ||
          (typeof dependency.targetPath === "string" &&
            (dependency.targetKind === "file" || dependency.targetKind === "directory") &&
            typeof dependency.targetDev === "number" &&
            typeof dependency.targetIno === "number" &&
            typeof dependency.targetSize === "number" &&
            typeof dependency.targetMtimeMs === "number" &&
            typeof dependency.targetCtimeMs === "number")),
    )
  )
    return false;
  return (
    await Promise.all(
      dependencies.map(async (dependency) => {
        const current = await snapshotLocalArtifactDependency(
          dependency.path,
          dependency.treeDigest === undefined ? null : (dependency.treeExclusions ?? []),
        ).catch(() => null);
        return current !== null && JSON.stringify(current) === JSON.stringify(dependency);
      }),
    )
  ).every(Boolean);
}

export interface NativeMetadataStamp {
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

export async function readNativeMetadataStamp(
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

export async function publishNativeMetadataStamp(
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
  await writeNativeStamp(destination, stamp);
  return stamp;
}

export function nativeMetadataKey(
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
export function localArtifactIdentity(
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
      .filter(
        ([key, value]) =>
          value !== undefined && key !== "programShards" && key !== "programPublicSymbols",
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const executableSectionFlags = executableSectionEliminationFlags(targetPlatform(driver));
  const executableOptimizationFlags = [
    ...executableHardeningLinkerArgs(targetPlatform(driver), isMuslTarget(driver)),
    ...executableOptimizationLinkerArgs(
      targetPlatform(driver),
      opts.optimization ?? "release",
      isMuslTarget(driver),
    ),
  ];
  const hash = createHash("sha256")
    .update("local-artifact-v2\0")
    .update(cacheTargetIdentity(driver))
    .update("\0")
    .update(environmentFingerprint)
    .update("\0")
    .update(compilerIdentity)
    .update("\0")
    .update(runtimeHash)
    .update("\0")
    .update(driver.argv.join("\x1f"))
    .update("\0")
    .update(driver.targetArgs.join("\x1f"))
    .update("\0")
    .update(driver.linkArgs.join("\x1f"))
    .update("\0")
    .update(executableSectionFlags.compile.join("\x1f"))
    .update("\0")
    .update(executableSectionFlags.link.join("\x1f"))
    .update("\0");
  // Only some targets add hardening or optimization-specific link flags.
  // Salt that identity so an output linked without them cannot hit, without
  // invalidating the artifacts of targets that add none.
  if (executableOptimizationFlags.length > 0) {
    hash
      .update("optimization-linker-flags\0")
      .update(executableOptimizationFlags.join("\x1f"))
      .update("\0");
  }
  if (opts.sanitize && opts.optimization === "dev") hash.update("sanitized-runtime-o1-v1\0");
  if (programShardMerge !== null) {
    updateProgramShardCacheIdentity(
      hash,
      opts.programShards,
      opts.programPublicSymbols,
      programShardMerge,
    );
  }
  return hash
    .update(JSON.stringify(normalizedOptions))
    .update("\0")
    .update(resolve(opts.cPath))
    .update("\0")
    .update(resolve(opts.outPath))
    .update("\0")
    .update(programBytes)
    .digest("hex");
}

export function localArtifactStampPath(root: string, outPath: string): string {
  const outputKey = createHash("sha256").update(resolve(outPath)).digest("hex");
  return join(root, "local", outputKey);
}

function localArtifactStampIntegrity(
  stamp: Pick<
    LocalArtifactStamp,
    "version" | "key" | "digest" | "dependencies" | "debugSymbolsDigest"
  >,
): string {
  return createHash("sha256")
    .update("local-artifact-stamp-v2\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

export async function localArtifactHit(
  stampPath: string,
  outPath: string,
  key: string,
  darwinDebugSymbols = false,
): Promise<LocalArtifactStamp | null> {
  try {
    const stamp = JSON.parse(await readFile(stampPath, "utf8")) as Partial<LocalArtifactStamp>;
    const output = await lstat(outPath);
    const expectedMode = 0o777 & ~process.umask();
    if (
      stamp.version !== 2 ||
      stamp.key !== key ||
      !/^[0-9a-f]{64}$/.test(stamp.digest ?? "") ||
      darwinDebugSymbols !== (stamp.debugSymbolsDigest !== undefined) ||
      (stamp.debugSymbolsDigest !== undefined &&
        !/^[0-9a-f]{64}$/.test(stamp.debugSymbolsDigest)) ||
      !Array.isArray(stamp.dependencies) ||
      !/^[0-9a-f]{64}$/.test(stamp.integrity ?? "") ||
      localArtifactStampIntegrity({
        version: stamp.version,
        key: stamp.key,
        digest: stamp.digest!,
        dependencies: stamp.dependencies,
        ...(stamp.debugSymbolsDigest === undefined
          ? {}
          : { debugSymbolsDigest: stamp.debugSymbolsDigest }),
      }) !== stamp.integrity ||
      !output.isFile() ||
      (output.mode & 0o777) !== expectedMode ||
      stamp.dependencies.some(
        (dependency) =>
          dependency === null ||
          typeof dependency !== "object" ||
          typeof dependency.path !== "string" ||
          (dependency.kind !== "file" &&
            dependency.kind !== "directory" &&
            dependency.kind !== "symlink") ||
          typeof dependency.dev !== "number" ||
          typeof dependency.ino !== "number" ||
          typeof dependency.size !== "number" ||
          typeof dependency.mtimeMs !== "number" ||
          typeof dependency.ctimeMs !== "number" ||
          (dependency.treeDigest !== undefined && typeof dependency.treeDigest !== "string") ||
          (dependency.kind === "symlink" &&
            (typeof dependency.targetPath !== "string" ||
              (dependency.targetKind !== "file" && dependency.targetKind !== "directory") ||
              typeof dependency.targetDev !== "number" ||
              typeof dependency.targetIno !== "number" ||
              typeof dependency.targetSize !== "number" ||
              typeof dependency.targetMtimeMs !== "number" ||
              typeof dependency.targetCtimeMs !== "number")),
      ) ||
      !(await nativeArtifactDependenciesStillMatch(stamp.dependencies)) ||
      (await fileDigest(outPath)) !== stamp.digest ||
      (darwinDebugSymbols &&
        createHash("sha256")
          .update(await readDarwinDebugSymbols(outPath))
          .digest("hex") !== stamp.debugSymbolsDigest)
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

export async function publishLocalArtifactStamp(
  stampPath: string,
  outPath: string,
  key: string,
  dependencyPaths: readonly string[],
  recursiveDirectories: readonly string[] = [],
  recursiveExclusions: readonly string[] = [],
  darwinDebugSymbols = false,
): Promise<LocalArtifactStamp> {
  await mkdir(dirname(stampPath), { recursive: true });
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
    ...(darwinDebugSymbols
      ? {
          debugSymbolsDigest: createHash("sha256")
            .update(await readDarwinDebugSymbols(outPath))
            .digest("hex"),
        }
      : {}),
  } as const;
  const stamp: LocalArtifactStamp = {
    ...unsigned,
    integrity: localArtifactStampIntegrity(unsigned),
  };
  await writeNativeStamp(stampPath, stamp);
  return stamp;
}

/** Metadata and output-local stamps share atomic private publication, while
 * each caller retains its own identity, integrity, and dependency proof. */
async function writeNativeStamp(
  destination: string,
  stamp: NativeMetadataStamp | LocalArtifactStamp,
): Promise<void> {
  const tmp = `${destination}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
