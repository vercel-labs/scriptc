import type { NativeOptimization } from "./optimization.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compilerReleaseVersion } from "../library/sidecar.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { nativeArtifactDependenciesStillMatch } from "./native/artifact-stamps.js";
import { type NativeArtifactDependency } from "./native/contracts.js";
import type { NativeTargetSpec } from "./targets.js";

import {
  RuntimePackError,
  parseRuntimePackManifest,
  selectRuntimePackArtifacts,
  validateRuntimePackIdentity,
  type RuntimePackArtifact,
  type RuntimePackManifest,
  type RuntimeFeatureSet,
  type RuntimePackMode,
} from "./runtime-pack-core.js";
export {
  RUNTIME_PACK_SCHEMA,
  RUNTIME_PACK_FORMAT,
  RuntimePackError,
  parseRuntimePackManifest,
  effectiveRuntimeFeatures,
  evaluateRuntimePredicate,
  type RuntimePackManifest,
  type RuntimePredicate,
  type RuntimeFeatureSet,
} from "./runtime-pack-core.js";

export interface RuntimePackSelection {
  root: string;
  manifestPath: string;
  manifest: RuntimePackManifest;
  flavor: NativeOptimization;
  features: RuntimeFeatureSet;
  runtimeObjects: string[];
  archives: string[];
  systemLibraries: string[];
  dependencyPaths: string[];
  /** Exact installed inputs observed while the selected artifacts were verified. */
  sourceDependencies: NativeArtifactDependency[];
  selectedRuntimeArtifacts: RuntimePackArtifact[];
  selectedArchiveArtifacts: RuntimePackArtifact[];
  /** Bitcode of the selected runtime units that ship it, in unit order. */
  selectedRuntimeBitcode: RuntimePackArtifact[];
}

async function verifyArtifact(root: string, artifact: RuntimePackArtifact): Promise<string> {
  const path = join(root, artifact.path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new RuntimePackError(`runtime pack artifact is missing: ${artifact.path}`, "invalid");
  }
  if (
    bytes.length !== artifact.size ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  ) {
    throw new RuntimePackError(`runtime pack artifact hash mismatch: ${artifact.path}`, "invalid");
  }
  return path;
}

async function snapshotDependencies(paths: readonly string[]): Promise<NativeArtifactDependency[]> {
  const { lstat, realpath, stat } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return Promise.all(
    [...new Set(paths.map((path) => resolve(path)))].sort().map(async (path) => {
      const info = await lstat(path);
      const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "symlink";
      const dependency: NativeArtifactDependency = {
        path,
        kind,
        dev: Number(info.dev),
        ino: Number(info.ino),
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        ctimeMs: Number(info.ctimeMs),
      };
      if (kind === "symlink") {
        const targetPath = await realpath(path);
        const target = await stat(path);
        const targetKind = target.isFile() ? "file" : target.isDirectory() ? "directory" : null;
        if (targetKind === null) throw new Error(`unsupported runtime-pack dependency: ${path}`);
        dependency.targetPath = targetPath;
        dependency.targetKind = targetKind;
        dependency.targetDev = Number(target.dev);
        dependency.targetIno = Number(target.ino);
        dependency.targetSize = Number(target.size);
        dependency.targetMtimeMs = Number(target.mtimeMs);
        dependency.targetCtimeMs = Number(target.ctimeMs);
      }
      return dependency;
    }),
  );
}

export async function stageRuntimePackArtifacts(selection: RuntimePackSelection): Promise<{
  root: string;
  replacements: Map<string, string>;
}> {
  if (
    !(await nativeArtifactDependenciesStillMatch(selection.sourceDependencies).catch(() => false))
  ) {
    throw new RuntimePackError("runtime pack changed after artifact selection", "invalid");
  }
  const stageRoot = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-link-"));
  try {
    const replacements = new Map<string, string>();
    await Promise.all(
      [...selection.selectedRuntimeArtifacts, ...selection.selectedArchiveArtifacts].map(
        async (artifact) => {
          const source = join(selection.root, artifact.path);
          const destination = join(stageRoot, artifact.path);
          const bytes = await readFile(source).catch(() => {
            throw new RuntimePackError(
              `runtime pack artifact is missing: ${artifact.path}`,
              "invalid",
            );
          });
          if (
            bytes.length !== artifact.size ||
            createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
          ) {
            throw new RuntimePackError(
              `runtime pack artifact hash mismatch: ${artifact.path}`,
              "invalid",
            );
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
          replacements.set(source, destination);
        },
      ),
    );
    if (
      !(await nativeArtifactDependenciesStillMatch(selection.sourceDependencies).catch(() => false))
    ) {
      throw new RuntimePackError(
        "runtime pack changed while staging verified artifacts",
        "invalid",
      );
    }
    return { root: stageRoot, replacements };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function loadRuntimePack(options: {
  target: NativeTargetSpec;
  features: NativeLinkFeatures;
  optimization: NativeOptimization;
  mode?: RuntimePackMode;
  env?: NodeJS.ProcessEnv;
  resolver?: (specifier: string) => string;
}): Promise<RuntimePackSelection> {
  const packageName = options.target.runtimePackPackage;
  const resolvePackageJson =
    options.resolver ?? ((specifier: string) => createRequire(import.meta.url).resolve(specifier));
  let packagePath: string;
  try {
    packagePath = resolvePackageJson(`${packageName}/package.json`);
  } catch {
    throw new RuntimePackError(
      `precompiled runtime package ${packageName} is not installed; reinstall scriptc with optional dependencies enabled for ${options.target.name}`,
      "missing",
    );
  }
  const root = dirname(packagePath);
  const manifestPath = join(root, "runtime-pack.json");
  let identityDependencies: NativeArtifactDependency[];
  try {
    identityDependencies = await snapshotDependencies([packagePath, manifestPath]);
  } catch {
    throw new RuntimePackError(`could not read ${packageName}/runtime-pack.json`, "invalid");
  }
  let packageManifest: { name?: string; version?: string };
  let manifest: RuntimePackManifest;
  try {
    [packageManifest, manifest] = await Promise.all([
      readFile(packagePath, "utf8").then((text) => JSON.parse(text)),
      readFile(manifestPath, "utf8").then((text) => parseRuntimePackManifest(JSON.parse(text))),
    ]);
  } catch (error) {
    if (error instanceof RuntimePackError) throw error;
    throw new RuntimePackError(`could not read ${packageName}/runtime-pack.json`, "invalid");
  }
  validateRuntimePackIdentity(
    manifest,
    packageManifest.name,
    packageManifest.version,
    options.target,
    compilerReleaseVersion(),
  );
  const flavor = options.optimization;
  const selected = selectRuntimePackArtifacts(
    manifest,
    options.features,
    flavor,
    options.env,
    options.mode,
  );
  const features = selected.features;
  const selectedVariants = selected.runtime;
  const selectedArchives = selected.archives;
  const selectedArtifactPaths = [...selectedVariants, ...selectedArchives].map((artifact) =>
    join(root, artifact.path),
  );
  let artifactDependencies: NativeArtifactDependency[];
  try {
    artifactDependencies = await snapshotDependencies(selectedArtifactPaths);
  } catch {
    throw new RuntimePackError("runtime pack artifact set changed during selection", "invalid");
  }
  const [runtimeObjects, archives] = await Promise.all([
    Promise.all(selectedVariants.map((artifact) => verifyArtifact(root, artifact))),
    Promise.all(selectedArchives.map((artifact) => verifyArtifact(root, artifact))),
  ]);
  await Promise.all(manifest.licenses.map((license) => readFile(join(root, license.path)))).catch(
    () => {
      throw new RuntimePackError("runtime pack license payload is incomplete", "invalid");
    },
  );
  const sourceDependencies = [...identityDependencies, ...artifactDependencies];
  if (!(await nativeArtifactDependenciesStillMatch(sourceDependencies).catch(() => false))) {
    throw new RuntimePackError(
      "runtime pack changed while verifying selected artifacts",
      "invalid",
    );
  }
  return {
    root,
    manifestPath,
    manifest,
    flavor,
    features,
    runtimeObjects,
    archives,
    systemLibraries: selected.systemLibraries,
    dependencyPaths: [packagePath, manifestPath, ...runtimeObjects, ...archives],
    sourceDependencies,
    selectedRuntimeArtifacts: selectedVariants,
    selectedArchiveArtifacts: selectedArchives,
    selectedRuntimeBitcode: selectedVariants.flatMap((variant) =>
      variant.bitcode === undefined ? [] : [variant.bitcode],
    ),
  };
}

export interface RuntimeBitcodeImport {
  paths: string[];
  /** Content digests, in path order, for cache keys. */
  digests: string[];
  dependencies: NativeArtifactDependency[];
}

/** Verified bitcode for the speed-flavor runtime units a program links, for
 * the helper's available_externally import. Null when the pack ships no
 * bitcode (no speed flavor, or a speed flavor built without the helper). */
export async function loadRuntimeBitcode(options: {
  target: NativeTargetSpec;
  features: NativeLinkFeatures;
  env?: NodeJS.ProcessEnv;
  resolver?: (specifier: string) => string;
}): Promise<RuntimeBitcodeImport | null> {
  const pack = await loadRuntimePack({ ...options, optimization: "speed" });
  // Only a real speed flavor's promoted objects match its bitcode.
  if (pack.manifest.flavors.speed === undefined || pack.selectedRuntimeBitcode.length === 0)
    return null;
  const paths = await Promise.all(
    pack.selectedRuntimeBitcode.map((artifact) => verifyArtifact(pack.root, artifact)),
  );
  let dependencies: NativeArtifactDependency[];
  try {
    dependencies = await snapshotDependencies([pack.manifestPath, ...paths]);
  } catch {
    throw new RuntimePackError("runtime pack bitcode changed during selection", "invalid");
  }
  return {
    paths,
    digests: pack.selectedRuntimeBitcode.map((artifact) => artifact.sha256),
    dependencies,
  };
}
