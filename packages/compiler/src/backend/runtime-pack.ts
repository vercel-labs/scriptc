import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import {
  CcCompileError,
  executableSectionEliminationFlags,
  nativeArtifactDependenciesStillMatch,
  nativeLinkerDependencyPaths,
  subprocessFailureDetail,
  type NativeArtifactDependency,
} from "./native-toolchain.js";
import { RUNTIME_ABI_MARKER, RUNTIME_ABI_VERSION } from "./runtime-abi.js";
import type { NativeTargetSpec } from "./targets.js";

const execFileAsync = promisify(execFile);
export const RUNTIME_PACK_SCHEMA = "scriptc.runtime-pack.v1" as const;
export const RUNTIME_PACK_FORMAT = 1 as const;

export type RuntimePredicate =
  | boolean
  | string
  | { all?: string[]; any?: string[]; not?: string[] };

interface RuntimePackArtifact {
  path: string;
  sha256: string;
  size: number;
}

interface RuntimePackVariant extends RuntimePackArtifact {
  id: string;
  when: Record<string, boolean>;
  defines: string[];
}

interface RuntimePackUnit {
  source: string;
  predicate: RuntimePredicate;
  variants: RuntimePackVariant[];
}

interface RuntimePackArchive extends RuntimePackArtifact {
  id: "quickjs" | "libregexp" | "zlib" | "mbedtls";
  predicate: RuntimePredicate;
}

export interface RuntimePackManifest {
  schema: typeof RUNTIME_PACK_SCHEMA;
  format: typeof RUNTIME_PACK_FORMAT;
  package: string;
  version: string;
  target: {
    name: NativeTargetSpec["name"];
    llvm_triple: NativeTargetSpec["llvmTriple"];
    architecture: "arm64";
    object_format: NativeTargetSpec["objectFormat"];
    minimum_os: NativeTargetSpec["minimumOs"];
  };
  runtime_abi: { version: number; marker: string };
  compiler: { command: string; identity: string; target: string };
  macros: {
    executable: string[];
    excluded: string[];
    sanitizer: "external-toolchain-required";
  };
  flavors: Record<"release" | "dev", {
    optimization: "-O2" | "-O0";
    runtime_units: RuntimePackUnit[];
  }>;
  archives: RuntimePackArchive[];
  system_libraries: { name: string; predicate: RuntimePredicate }[];
  licenses: { path: string; license: string }[];
}

export interface RuntimeFeatureSet extends NativeLinkFeatures {
  nativeFetch: boolean;
  netIslandEffective: boolean;
  netEffective: boolean;
  httpEffective: boolean;
  tlsEffective: boolean;
  tlsCaEffective: boolean;
  zlibEffective: boolean;
}

export interface RuntimePackSelection {
  root: string;
  manifestPath: string;
  manifest: RuntimePackManifest;
  flavor: "release" | "dev";
  features: RuntimeFeatureSet;
  runtimeObjects: string[];
  archives: string[];
  systemLibraries: string[];
  dependencyPaths: string[];
  /** Exact installed inputs observed while the selected artifacts were verified. */
  sourceDependencies: NativeArtifactDependency[];
  selectedRuntimeArtifacts: RuntimePackArtifact[];
  selectedArchiveArtifacts: RuntimePackArtifact[];
}

export interface RuntimeLinkPlan {
  target: NativeTargetSpec;
  outputPath: string;
  inputs: string[];
  systemLibraries: string[];
  driverFlags: string[];
  dependencyPaths: string[];
  /** Inputs already snapshotted by the stage that produced the program object. */
  programObjectDependencies: NativeArtifactDependency[];
  runtimePack: RuntimePackSelection;
}

export class RuntimePackError extends Error {
  constructor(message: string, readonly code: "missing" | "invalid" | "unsupported") {
    super(message);
    this.name = "RuntimePackError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validPredicate(value: unknown): value is RuntimePredicate {
  if (typeof value === "boolean" || typeof value === "string") return true;
  const item = object(value);
  if (item === null) return false;
  const keys = Object.keys(item);
  if (keys.some((key) => key !== "all" && key !== "any" && key !== "not")) return false;
  return keys.length > 0 && keys.every((key) =>
    Array.isArray(item[key]) && (item[key] as unknown[]).every((feature) => typeof feature === "string")
  );
}

function validArtifact(value: unknown): value is RuntimePackArtifact {
  const item = object(value);
  return item !== null && typeof item.path === "string" && !item.path.startsWith("/") &&
    !item.path.split(/[\\/]/).includes("..") && validDigest(item.sha256) &&
    typeof item.size === "number" && Number.isInteger(item.size) && item.size >= 0;
}

export function parseRuntimePackManifest(value: unknown): RuntimePackManifest {
  const manifest = object(value);
  const target = object(manifest?.target);
  const abi = object(manifest?.runtime_abi);
  const compiler = object(manifest?.compiler);
  const macros = object(manifest?.macros);
  const flavors = object(manifest?.flavors);
  const validFlavor = (value: unknown, optimization: string): boolean => {
    const flavor = object(value);
    return flavor?.optimization === optimization && Array.isArray(flavor.runtime_units) &&
      flavor.runtime_units.every((raw) => {
        const unit = object(raw);
        return typeof unit?.source === "string" && validPredicate(unit.predicate) &&
          Array.isArray(unit.variants) && unit.variants.length > 0 && unit.variants.every((variantRaw) => {
            const variant = object(variantRaw);
            const when = object(variant?.when);
            return validArtifact(variantRaw) && typeof variant?.id === "string" && when !== null &&
              Object.values(when).every((entry) => typeof entry === "boolean") &&
              Array.isArray(variant.defines) && variant.defines.every((entry) => typeof entry === "string");
          });
      });
  };
  if (
    manifest?.schema !== RUNTIME_PACK_SCHEMA || manifest.format !== RUNTIME_PACK_FORMAT ||
    typeof manifest.package !== "string" || typeof manifest.version !== "string" ||
    target?.name !== "macos-arm64" || target.llvm_triple !== "arm64-apple-macosx14.0.0" ||
    target.architecture !== "arm64" || target.object_format !== "macho" || target.minimum_os !== "14.0" ||
    abi?.version !== RUNTIME_ABI_VERSION || abi.marker !== RUNTIME_ABI_MARKER ||
    typeof compiler?.command !== "string" || typeof compiler.identity !== "string" ||
    compiler.target !== target.llvm_triple ||
    !Array.isArray(macros?.executable) || !macros.executable.every((entry) => typeof entry === "string") ||
    !Array.isArray(macros.excluded) || !macros.excluded.every((entry) => typeof entry === "string") ||
    macros.sanitizer !== "external-toolchain-required" ||
    flavors === null || !validFlavor(flavors.release, "-O2") || !validFlavor(flavors.dev, "-O0") ||
    !Array.isArray(manifest.archives) || !manifest.archives.every((raw) => {
      const archive = object(raw);
      return validArtifact(raw) && typeof archive?.id === "string" && validPredicate(archive.predicate);
    }) ||
    !Array.isArray(manifest.system_libraries) || !manifest.system_libraries.every((raw) => {
      const library = object(raw);
      return typeof library?.name === "string" && validPredicate(library.predicate);
    }) ||
    !Array.isArray(manifest.licenses) || !manifest.licenses.every((raw) => {
      const license = object(raw);
      return typeof license?.path === "string" && typeof license.license === "string";
    })
  ) throw new RuntimePackError("installed runtime-pack.json is malformed or incompatible", "invalid");
  return manifest as unknown as RuntimePackManifest;
}

export function effectiveRuntimeFeatures(
  features: NativeLinkFeatures,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeFeatureSet {
  const curlFetch = features.dynamic && features.fetch && env["SCRIPTC_FETCH_CURL"] === "1";
  if (curlFetch) {
    throw new RuntimePackError(
      "SCRIPTC_FETCH_CURL=1 is an external developer-toolchain comparison mode and is not available with precompiled runtime packs",
      "unsupported",
    );
  }
  const nativeFetch = features.fetch;
  const netIslandEffective = features.dynamic && (features.netIsland || nativeFetch);
  const netEffective = features.net || nativeFetch || netIslandEffective;
  const httpEffective = features.http || nativeFetch || netIslandEffective;
  const tlsEffective = features.tls || nativeFetch || netIslandEffective;
  const tlsCaEffective = features.tlsCa || tlsEffective;
  return {
    ...features,
    nativeFetch,
    netIslandEffective,
    netEffective,
    httpEffective,
    tlsEffective,
    tlsCaEffective,
    zlibEffective: features.zlib || nativeFetch,
  };
}

export function evaluateRuntimePredicate(
  predicate: RuntimePredicate,
  features: object,
): boolean {
  const values = features as Record<string, boolean>;
  if (typeof predicate === "boolean") return predicate;
  if (typeof predicate === "string") return values[predicate] === true;
  return (predicate.all?.every((name) => values[name] === true) ?? true) &&
    (predicate.any?.some((name) => values[name] === true) ?? true) &&
    (predicate.not?.every((name) => values[name] !== true) ?? true);
}

function selectVariant(unit: RuntimePackUnit, features: RuntimeFeatureSet): RuntimePackVariant {
  const matches = unit.variants.filter((variant) =>
    Object.entries(variant.when).every(([name, expected]) => features[name as keyof RuntimeFeatureSet] === expected)
  );
  matches.sort((a, b) => Object.keys(b.when).length - Object.keys(a.when).length || a.id.localeCompare(b.id));
  const selected = matches[0];
  if (selected === undefined) {
    throw new RuntimePackError(`runtime pack has no variant for ${unit.source}`, "invalid");
  }
  return selected;
}

async function verifyArtifact(root: string, artifact: RuntimePackArtifact): Promise<string> {
  const path = join(root, artifact.path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new RuntimePackError(`runtime pack artifact is missing: ${artifact.path}`, "invalid");
  }
  if (bytes.length !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new RuntimePackError(`runtime pack artifact hash mismatch: ${artifact.path}`, "invalid");
  }
  return path;
}

async function stageRuntimePackArtifacts(selection: RuntimePackSelection): Promise<{
  root: string;
  replacements: Map<string, string>;
}> {
  if (!(await nativeArtifactDependenciesStillMatch(selection.sourceDependencies).catch(() => false))) {
    throw new RuntimePackError("runtime pack changed after artifact selection", "invalid");
  }
  const stageRoot = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-link-"));
  try {
    const replacements = new Map<string, string>();
    await Promise.all([
      ...selection.selectedRuntimeArtifacts,
      ...selection.selectedArchiveArtifacts,
    ].map(async (artifact) => {
      const source = join(selection.root, artifact.path);
      const destination = join(stageRoot, artifact.path);
      const bytes = await readFile(source).catch(() => {
        throw new RuntimePackError(`runtime pack artifact is missing: ${artifact.path}`, "invalid");
      });
      if (
        bytes.length !== artifact.size ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      ) {
        throw new RuntimePackError(`runtime pack artifact hash mismatch: ${artifact.path}`, "invalid");
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
      replacements.set(source, destination);
    }));
    if (!(await nativeArtifactDependenciesStillMatch(selection.sourceDependencies).catch(() => false))) {
      throw new RuntimePackError("runtime pack changed while staging verified artifacts", "invalid");
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
  optimization: "release" | "dev";
  env?: NodeJS.ProcessEnv;
  resolver?: (specifier: string) => string;
}): Promise<RuntimePackSelection> {
  const packageName = options.target.name === "macos-arm64"
    ? "@scriptc/runtime-darwin-arm64"
    : (() => { throw new RuntimePackError(`no runtime pack supports ${options.target.name}`, "unsupported"); })();
  const resolvePackageJson = options.resolver ?? ((specifier: string) => createRequire(import.meta.url).resolve(specifier));
  let packagePath: string;
  try {
    packagePath = resolvePackageJson(`${packageName}/package.json`);
  } catch {
    throw new RuntimePackError(
      `precompiled runtime package ${packageName} is not installed; reinstall scriptc with optional dependencies enabled for macOS arm64`,
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
  if (
    packageManifest.name !== packageName || manifest.package !== packageName ||
    packageManifest.version !== compilerReleaseVersion() || manifest.version !== compilerReleaseVersion()
  ) {
    throw new RuntimePackError(
      `runtime pack version mismatch: expected ${packageName}@${compilerReleaseVersion()}, found ${packageManifest.name}@${packageManifest.version}`,
      "invalid",
    );
  }
  if (
    manifest.target.name !== options.target.name ||
    manifest.target.llvm_triple !== options.target.llvmTriple ||
    manifest.target.object_format !== options.target.objectFormat ||
    manifest.target.minimum_os !== options.target.minimumOs
  ) throw new RuntimePackError(`runtime pack does not support target ${options.target.name}`, "invalid");
  const features = effectiveRuntimeFeatures(options.features, options.env);
  const flavor = options.optimization;
  const selectedUnits = manifest.flavors[flavor].runtime_units
    .filter((unit) => evaluateRuntimePredicate(unit.predicate, features));
  const selectedVariants = selectedUnits.map((unit) => selectVariant(unit, features));
  const selectedArchives = manifest.archives
    .filter((archive) => evaluateRuntimePredicate(archive.predicate, features));
  const selectedArtifactPaths = [
    ...selectedVariants,
    ...selectedArchives,
  ].map((artifact) => join(root, artifact.path));
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
  await Promise.all(manifest.licenses.map((license) => readFile(join(root, license.path)))).catch(() => {
    throw new RuntimePackError("runtime pack license payload is incomplete", "invalid");
  });
  const sourceDependencies = [...identityDependencies, ...artifactDependencies];
  if (!(await nativeArtifactDependenciesStillMatch(sourceDependencies).catch(() => false))) {
    throw new RuntimePackError("runtime pack changed while verifying selected artifacts", "invalid");
  }
  return {
    root,
    manifestPath,
    manifest,
    flavor,
    features,
    runtimeObjects,
    archives,
    systemLibraries: manifest.system_libraries
      .filter((entry) => evaluateRuntimePredicate(entry.predicate, features))
      .map((entry) => entry.name),
    dependencyPaths: [packagePath, manifestPath, ...runtimeObjects, ...archives],
    sourceDependencies,
    selectedRuntimeArtifacts: selectedVariants,
    selectedArchiveArtifacts: selectedArchives,
  };
}

export async function createRuntimeLinkPlan(options: {
  target: NativeTargetSpec;
  programObject: string;
  outPath: string;
  features: NativeLinkFeatures;
  ffi: FfiProfile | null;
  optimization: "release" | "dev";
  programObjectDependencies?: readonly NativeArtifactDependency[];
  env?: NodeJS.ProcessEnv;
  resolver?: (specifier: string) => string;
}): Promise<RuntimeLinkPlan> {
  const runtimePack = await loadRuntimePack(options);
  return {
    target: options.target,
    outputPath: options.outPath,
    inputs: [
      options.programObject,
      ...(options.ffi?.libraries ?? []),
      ...runtimePack.runtimeObjects,
      ...runtimePack.archives,
    ],
    systemLibraries: [...new Set([
      ...(options.ffi?.systemLibraries ?? []),
      ...runtimePack.systemLibraries,
    ])],
    driverFlags: [
      "-target", options.target.llvmTriple, "-pthread",
      ...executableSectionEliminationFlags("darwin").link,
    ],
    dependencyPaths: [
      ...runtimePack.dependencyPaths,
      ...(options.ffi?.libraries ?? []),
    ],
    programObjectDependencies: [...(options.programObjectDependencies ?? [])],
    runtimePack,
  };
}

async function snapshotDependencies(paths: readonly string[]): Promise<NativeArtifactDependency[]> {
  const { lstat } = await import("node:fs/promises");
  return Promise.all([...new Set(paths.map((path) => resolve(path)))].sort().map(async (path) => {
    const info = await lstat(path);
    const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "symlink";
    const dependency: NativeArtifactDependency = {
      path,
      kind,
      dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size),
      mtimeMs: Number(info.mtimeMs), ctimeMs: Number(info.ctimeMs),
    };
    if (kind === "symlink") {
      const targetPath = await realpath(path);
      const target = await stat(path);
      const targetKind = target.isFile() ? "file" : target.isDirectory() ? "directory" : null;
      if (targetKind === null) throw new Error(`unsupported linker dependency: ${path}`);
      dependency.targetPath = targetPath;
      dependency.targetKind = targetKind;
      dependency.targetDev = Number(target.dev);
      dependency.targetIno = Number(target.ino);
      dependency.targetSize = Number(target.size);
      dependency.targetMtimeMs = Number(target.mtimeMs);
      dependency.targetCtimeMs = Number(target.ctimeMs);
    }
    return dependency;
  }));
}

export async function linkRuntimePackExecutable(
  plan: RuntimeLinkPlan,
  options: {
    linker?: string;
    onArtifactReady?: (artifact: { dependencies: NativeArtifactDependency[] }) => Promise<void>;
  } = {},
): Promise<void> {
  const linker = options.linker ?? process.env["SCRIPTC_LINKER"] ?? "clang";
  // ld64 derives an ad-hoc signature identifier from the output basename.
  // Keep that basename caller-visible while a private sibling directory gives
  // the link its own inode and preserves an atomic same-filesystem install.
  const privateOutRoot = await mkdtemp(
    join(dirname(plan.outputPath), ".scriptc-runtime-pack-link-"),
  );
  const privateOut = join(privateOutRoot, basename(plan.outputPath));
  let stagedRoot: string | null = null;
  try {
    const staged = await stageRuntimePackArtifacts(plan.runtimePack);
    stagedRoot = staged.root;
    const args = [
      ...plan.driverFlags,
      ...plan.inputs.map((input) => staged.replacements.get(input) ?? input),
      ...plan.systemLibraries.map((name) => `-l${name}`),
      "-o", privateOut,
    ];
    // The pack snapshots bracket both verification passes and private staging;
    // the program-object snapshot begins before helper emission. Snapshot the
    // remaining cache-bearing inputs before the linker consumes them, then
    // require the complete set to remain stable through publication.
    const inheritedDependencies = [
      ...plan.runtimePack.sourceDependencies,
      ...plan.programObjectDependencies,
    ];
    const inheritedDependencyPaths = new Set(
      inheritedDependencies.map((dependency) => resolve(dependency.path)),
    );
    const additionalDependencyPaths = plan.dependencyPaths.filter(
      (path) => !inheritedDependencyPaths.has(resolve(path)),
    );
    const preLinkDependencies = options.onArtifactReady === undefined ||
        !(await nativeArtifactDependenciesStillMatch(inheritedDependencies).catch(() => false))
      ? null
      : await nativeLinkerDependencyPaths(linker, [
          ...plan.driverFlags,
          ...plan.systemLibraries.map((name) => `-l${name}`),
        ])
        .then(async (toolchain) => [
          ...inheritedDependencies,
          ...await snapshotDependencies([...toolchain, ...additionalDependencyPaths]),
        ])
        .catch(() => null);
    await execFileAsync(linker, args);
    const output = await stat(privateOut);
    if (!output.isFile() || output.size === 0) throw new Error("linker produced no executable");
    await rename(privateOut, plan.outputPath).catch(async () => {
      await rm(plan.outputPath, { force: true });
      await rename(privateOut, plan.outputPath);
    });
    if (
      options.onArtifactReady !== undefined && preLinkDependencies !== null &&
      await nativeArtifactDependenciesStillMatch(preLinkDependencies).catch(() => false)
    ) {
      // A complete executable cache entry is published only when the driver,
      // platform linker, compiler runtime, selected SDK stubs/settings, pack,
      // and FFI inputs all remained unchanged across the link. Failure to
      // prove any ambient input keeps a correct executable but no complete
      // cache.
      await options.onArtifactReady({ dependencies: preLinkDependencies }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CcCompileError || error instanceof RuntimePackError) throw error;
    const detail = subprocessFailureDetail(error);
    throw new CcCompileError(
      linker,
      detail,
      `${linker} failed linking ${basename(plan.outputPath)} from the precompiled runtime pack.\n${detail}`,
    );
  } finally {
    await Promise.all([
      rm(privateOutRoot, { recursive: true, force: true }).catch(() => undefined),
      stagedRoot === null
        ? Promise.resolve()
        : rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined),
    ]);
  }
}
