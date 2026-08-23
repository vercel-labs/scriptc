import { InternalCompilerError } from "../errors.js";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { deserialize as deserializeV8, serialize as serializeV8 } from "node:v8";
import { gzip, gunzip } from "node:zlib";
import { compilerReleaseVersion } from "./sidecar.js";
import type { IrModule } from "../ir/nodes.js";
import { IR_VERSION } from "../ir/serialize.js";
import { frontendInputsSemanticallyMatch, frontendInputsStillMatch, validFrontendInputSnapshot, type FrontendInputExclusions, type FrontendInputSnapshot } from "../frontend/input-tracker.js";
import { rebaseSourceLocations, semanticallyEqualSource, sourceLineRebaseIsIdentity } from "./semantic-source.js";
import { compilerImplementationIdentity } from "./implementation-identity.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface CachedLibraryFile {
  name: string;
  digest: string;
}

interface EarlyLibraryCacheStamp {
  version: 2;
  key: string;
  frontend: FrontendInputSnapshot;
  files: {
    translationUnit: CachedLibraryFile;
    ir: CachedLibraryFile | null;
    sidecar: CachedLibraryFile | null;
    semanticIr: CachedLibraryFile | null;
    sources: CachedLibraryFile | null;
  };
  native: {
    backend: "c" | "llvm";
    regex: boolean;
    assert: boolean;
    inspect: boolean;
    symbol: boolean;
    searchParams: boolean;
    emitter: boolean;
    zlib: boolean;
    copying: boolean;
    textDecoderLegacy: boolean;
  };
  integrity: string;
}

export interface EarlyLibraryNativeFeatures {
  backend: "c" | "llvm";
  regex: boolean;
  assert: boolean;
  inspect: boolean;
  symbol: boolean;
  searchParams: boolean;
  emitter: boolean;
  zlib: boolean;
  copying: boolean;
  textDecoderLegacy: boolean;
  /** Volatile exact-source build identity emitted from the tiny identity TU. */
  buildId?: string;
}

export interface EarlyLibraryCacheOptions {
  profilePath: string;
  profileBytes: Uint8Array;
  entryPath: string;
  outDir: string;
  outPath?: string;
  emitIr: boolean;
  sanitize: boolean;
  target: string;
  compiler: string[];
  /** Host Node runtime whose builtin-module inventory participates in
   * frontend classification. */
  nodeVersion: string;
  implementation: string;
}

export interface EarlyLibraryCacheHit {
  cPath: string;
  irPath?: string;
  sidecarPath?: string;
  native: EarlyLibraryNativeFeatures;
}

export interface EarlyLibraryCachePublish extends EarlyLibraryCacheHit {
  frontend: FrontendInputSnapshot;
  semantic?: {
    mod: IrModule;
    sources: ReadonlyMap<string, string>;
  };
}

export interface SemanticLibraryCacheHit {
  mod: IrModule;
  translationUnit: string;
  sourceTexts: Map<string, string>;
  previousSources: Map<string, string>;
  frontend: FrontendInputSnapshot;
  sidecarJson: string | null;
  native: EarlyLibraryNativeFeatures;
  changedSources: string[];
}

function validNativeFeatures(value: unknown): value is EarlyLibraryNativeFeatures {
  if (value === null || typeof value !== "object") return false;
  const native = value as Partial<EarlyLibraryNativeFeatures>;
  return (native.backend === "c" || native.backend === "llvm") &&
    [
      native.regex,
      native.assert,
      native.inspect,
      native.symbol,
      native.searchParams,
      native.emitter,
      native.zlib,
      native.copying,
      native.textDecoderLegacy,
    ].every((flag) => typeof flag === "boolean") &&
    (native.buildId === undefined || /^[0-9a-f]{16}$/.test(native.buildId));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheKey(options: EarlyLibraryCacheOptions): string {
  return createHash("sha256")
    .update("early-library-v2\0")
    .update(compilerReleaseVersion()).update("\0")
    .update(resolve(options.profilePath)).update("\0")
    .update(options.profileBytes).update("\0")
    .update(resolve(options.entryPath)).update("\0")
    .update(resolve(options.outDir)).update("\0")
    .update(options.outPath === undefined ? "<default>" : resolve(options.outPath)).update("\0")
    .update(options.emitIr ? "emit-ir" : "no-ir").update("\0")
    .update(options.sanitize ? "sanitize" : "plain").update("\0")
    .update(options.target).update("\0")
    .update(options.compiler.join("\x1f")).update("\0")
    .update(options.nodeVersion).update("\0")
    .update(options.implementation)
    .digest("hex");
}

/**
 * Release versions separate published compilers. A source checkout keeps the
 * package version unchanged while a branch is under test, so the built
 * implementation directory also joins the key. Published packages execute
 * the same `dist` tree and therefore get the same protection from partial or
 * mixed installs without hashing the TypeScript source tree beside it.
 */
export async function libraryFrontendImplementationFingerprint(): Promise<string> {
  return (await compilerImplementationIdentity(false)).digest;
}

function stampPath(root: string, options: EarlyLibraryCacheOptions): string {
  return join(root, "early-lib", cacheKey(options), "stamp.json");
}

function stampIntegrity(stamp: Omit<EarlyLibraryCacheStamp, "integrity">): string {
  return createHash("sha256")
    .update("early-library-stamp-v2\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

function outputPaths(options: EarlyLibraryCacheOptions, backend: "c" | "llvm"): {
  cPath: string;
  staleCPath: string;
  irPath: string;
} {
  const stem = basename(options.entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  return {
    cPath: join(options.outDir, `${stem}.lib.${backend === "llvm" ? "ll" : "c"}`),
    staleCPath: join(options.outDir, `${stem}.lib.${backend === "llvm" ? "c" : "ll"}`),
    irPath: join(options.outDir, `${stem}.lib.ir.json`),
  };
}

function sidecarOutputPath(options: EarlyLibraryCacheOptions, configured: string | null): string {
  const archivePath = archiveOutputPath(options);
  return configured !== null ? resolve(dirname(archivePath), configured) : `${archivePath}.contract.json`;
}

function archiveOutputPath(options: EarlyLibraryCacheOptions): string {
  return options.outPath ?? join(
    options.outDir,
    `${basename(options.entryPath).replace(/\.(ts|js|mjs|cjs)$/, "")}.lib.a`,
  );
}

function frontendOutputExclusions(
  options: EarlyLibraryCacheOptions,
  backend: "c" | "llvm",
  sidecarPath: string | undefined,
): FrontendInputExclusions {
  const paths = outputPaths(options, backend);
  const outputArtifacts = [
    paths.cPath,
    paths.staleCPath,
    ...(options.emitIr ? [paths.irPath] : []),
    archiveOutputPath(options),
    ...(sidecarPath === undefined ? [] : [sidecarPath]),
  ].map((path) => resolve(path));
  const outputDirectories = new Set<string>();
  for (const artifact of outputArtifacts) {
    for (let directory = dirname(artifact); ; directory = dirname(directory)) {
      outputDirectories.add(directory);
      if (dirname(directory) === directory) break;
    }
  }
  return {
    outputPaths: outputArtifacts,
    outputDirectories,
  };
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
  const tmp = join(dirname(destination), `.scriptc-early-hit-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o666 & ~process.umask());
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function readEarlyLibraryCache(
  root: string | null,
  options: EarlyLibraryCacheOptions,
  sidecarConfiguredPath: string | null | undefined,
): Promise<EarlyLibraryCacheHit | null> {
  if (root === null) return null;
  const path = stampPath(root, options);
  try {
    const stamp = JSON.parse(await readFile(path, "utf8")) as EarlyLibraryCacheStamp;
    const { integrity, ...unsigned } = stamp;
    if (
      stamp.version !== 2 ||
      stamp.key !== cacheKey(options) ||
      !validFrontendInputSnapshot(stamp.frontend) ||
      !validNativeFeatures(stamp.native) ||
      stamp.files?.translationUnit?.name !== "program.tu" ||
      !/^[0-9a-f]{64}$/.test(stamp.files.translationUnit.digest) ||
      (stamp.files.ir !== null && (
        stamp.files.ir?.name !== "program.ir.json" || !/^[0-9a-f]{64}$/.test(stamp.files.ir.digest)
      )) ||
      (stamp.files.sidecar !== null && (
        stamp.files.sidecar?.name !== "contract.json" || !/^[0-9a-f]{64}$/.test(stamp.files.sidecar.digest)
      )) ||
      (stamp.files.semanticIr !== null && (
        stamp.files.semanticIr?.name !== "semantic.ir.json.gz" || !/^[0-9a-f]{64}$/.test(stamp.files.semanticIr.digest)
      )) ||
      (stamp.files.sources !== null && (
        stamp.files.sources?.name !== "sources.json.gz" || !/^[0-9a-f]{64}$/.test(stamp.files.sources.digest)
      )) ||
      (stamp.files.semanticIr === null) !== (stamp.files.sources === null) ||
      stampIntegrity(unsigned) !== integrity ||
      !frontendInputsStillMatch(
        stamp.frontend,
        frontendOutputExclusions(
          options,
          stamp.native.backend,
          stamp.files.sidecar === null
            ? undefined
            : sidecarOutputPath(options, sidecarConfiguredPath ?? null),
        ),
      ) ||
      (stamp.files.ir !== null) !== options.emitIr ||
      (stamp.files.sidecar !== null) !== (sidecarConfiguredPath !== undefined)
    ) return null;

    const directory = dirname(path);
    const [translationUnit, ir, sidecar] = await Promise.all([
      readCachedFile(join(directory, stamp.files.translationUnit.name), stamp.files.translationUnit.digest),
      stamp.files.ir === null
        ? Promise.resolve(null)
        : readCachedFile(join(directory, stamp.files.ir.name), stamp.files.ir.digest),
      stamp.files.sidecar === null
        ? Promise.resolve(null)
        : readCachedFile(join(directory, stamp.files.sidecar.name), stamp.files.sidecar.digest),
    ]);
    if (
      translationUnit === null ||
      stamp.files.ir !== null && ir === null ||
      stamp.files.sidecar !== null && sidecar === null
    ) return null;

    const paths = outputPaths(options, stamp.native.backend);
    await installBytes(translationUnit, paths.cPath);
    await rm(paths.staleCPath, { force: true });
    if (ir !== null) await installBytes(ir, paths.irPath);
    let sidecarPath: string | undefined;
    if (sidecar !== null) {
      sidecarPath = sidecarOutputPath(options, sidecarConfiguredPath ?? null);
      await installBytes(sidecar, sidecarPath);
    }
    const now = new Date();
    await Promise.all([
      path,
      join(directory, stamp.files.translationUnit.name),
      ...(stamp.files.ir === null ? [] : [join(directory, stamp.files.ir.name)]),
      ...(stamp.files.sidecar === null ? [] : [join(directory, stamp.files.sidecar.name)]),
    ].map((cachePath) => utimes(cachePath, now, now).catch(() => undefined)));
    return {
      cPath: paths.cPath,
      native: stamp.native,
      ...(ir !== null ? { irPath: paths.irPath } : {}),
      ...(sidecarPath !== undefined ? { sidecarPath } : {}),
    };
  } catch {
    return null;
  }
}

function decodeSources(bytes: Uint8Array): Map<string, string> {
  const entries = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!Array.isArray(entries)) throw new InternalCompilerError("semantic source payload is not an array");
  const sources = new Map<string, string>();
  for (const entry of entries) {
    if (
      !Array.isArray(entry) || entry.length !== 2 ||
      typeof entry[0] !== "string" || typeof entry[1] !== "string"
    ) throw new InternalCompilerError("semantic source payload has an invalid entry");
    sources.set(entry[0], entry[1]);
  }
  return sources;
}

export async function readSemanticLibraryCache(
  root: string | null,
  options: EarlyLibraryCacheOptions,
  sidecarConfiguredPath: string | null | undefined,
): Promise<SemanticLibraryCacheHit | null> {
  if (root === null) return null;
  const path = stampPath(root, options);
  try {
    const stamp = JSON.parse(await readFile(path, "utf8")) as EarlyLibraryCacheStamp;
    const { integrity, ...unsigned } = stamp;
    if (
      stamp.version !== 2 || stamp.key !== cacheKey(options) ||
      !validFrontendInputSnapshot(stamp.frontend) || !validNativeFeatures(stamp.native) ||
      stamp.files?.translationUnit?.name !== "program.tu" ||
      stamp.files?.semanticIr?.name !== "semantic.ir.json.gz" ||
      stamp.files?.sources?.name !== "sources.json.gz" ||
      !/^[0-9a-f]{64}$/.test(stamp.files.translationUnit.digest) ||
      !/^[0-9a-f]{64}$/.test(stamp.files.semanticIr.digest) ||
      !/^[0-9a-f]{64}$/.test(stamp.files.sources.digest) ||
      (stamp.files.sidecar !== null) !== (sidecarConfiguredPath !== undefined) ||
      stampIntegrity(unsigned) !== integrity
    ) return null;
    const directory = dirname(path);
    const [translationUnit, irCompressed, sourcesCompressed, sidecar] = await Promise.all([
      readCachedFile(join(directory, stamp.files.translationUnit.name), stamp.files.translationUnit.digest),
      readCachedFile(join(directory, stamp.files.semanticIr.name), stamp.files.semanticIr.digest),
      readCachedFile(join(directory, stamp.files.sources.name), stamp.files.sources.digest),
      stamp.files.sidecar === null
        ? Promise.resolve(null)
        : readCachedFile(join(directory, stamp.files.sidecar.name), stamp.files.sidecar.digest),
    ]);
    if (
      translationUnit === null || irCompressed === null || sourcesCompressed === null ||
      (stamp.files.sidecar !== null && sidecar === null)
    ) {
      return null;
    }
    const [irJson, sourcesJson] = await Promise.all([
      gunzipAsync(irCompressed),
      gunzipAsync(sourcesCompressed),
    ]);
    const previousSources = decodeSources(sourcesJson);
    const semantic = frontendInputsSemanticallyMatch(
      stamp.frontend,
      previousSources,
      semanticallyEqualSource,
      frontendOutputExclusions(
        options,
        stamp.native.backend,
        stamp.files.sidecar === null
          ? undefined
          : sidecarOutputPath(options, sidecarConfiguredPath ?? null),
      ),
    );
    if (semantic === null || semantic.changed.length === 0) return null;
    // C source annotations are rendered through the entry source's line table,
    // including imported offsets stamped with the entry path and synthetic
    // byte-zero locations. Their line-only text cannot be rebased exactly for
    // multi-source graphs or line-shifting edits. Keep TU reuse to the safe
    // single-source, line-preserving subset; take the normal frontend path for
    // the other uncommon trivia edits.
    if (stamp.native.backend === "c") {
      const entry = resolve(options.entryPath);
      const change = semantic.changed.find((candidate) => candidate.path === entry);
      if (
        previousSources.size > 1 || semantic.changed.length !== 1 || change === undefined ||
        !sourceLineRebaseIsIdentity(entry, change.previous, change.current)
      ) return null;
    }
    const mod = deserializeV8(irJson) as IrModule;
    if (mod.irVersion !== IR_VERSION) return null;
    rebaseSourceLocations(mod, previousSources, semantic.currentSources);
    const now = new Date();
    await Promise.all([
      path,
      join(directory, stamp.files.translationUnit.name),
      join(directory, stamp.files.semanticIr.name),
      join(directory, stamp.files.sources.name),
      ...(stamp.files.sidecar === null ? [] : [join(directory, stamp.files.sidecar.name)]),
    ].map((cachePath) => utimes(cachePath, now, now).catch(() => undefined)));
    return {
      mod,
      translationUnit: translationUnit.toString("utf8"),
      sourceTexts: semantic.currentSources,
      previousSources,
      frontend: semantic.snapshot,
      sidecarJson: sidecar === null ? null : sidecar.toString("utf8"),
      native: stamp.native,
      changedSources: semantic.changed.map((change) => change.path),
    };
  } catch {
    return null;
  }
}

export async function publishEarlyLibraryCache(
  root: string | null,
  options: EarlyLibraryCacheOptions,
  result: EarlyLibraryCachePublish,
): Promise<void> {
  if (root === null || !result.frontend.stable) return;
  const destination = dirname(stampPath(root, options));
  const parent = dirname(destination);
  const stage = join(parent, `.tmp-${basename(destination).slice(0, 12)}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const publishFile = async (source: string, name: string): Promise<CachedLibraryFile> => {
      const target = join(stage, name);
      await copyFile(source, target);
      await chmod(target, 0o600);
      return { name, digest: digest(await readFile(target)) };
    };
    const [translationUnit, ir, sidecar, semanticIr, sources] = await Promise.all([
      publishFile(result.cPath, "program.tu"),
      result.irPath === undefined ? Promise.resolve(null) : publishFile(result.irPath, "program.ir.json"),
      result.sidecarPath === undefined ? Promise.resolve(null) : publishFile(result.sidecarPath, "contract.json"),
      result.semantic === undefined
        ? Promise.resolve(null)
        : gzipAsync(serializeV8(result.semantic.mod), { level: 1 }).then(async (bytes) => {
            const target = join(stage, "semantic.ir.json.gz");
            await writeFile(target, bytes, { mode: 0o600 });
            return { name: "semantic.ir.json.gz", digest: digest(bytes) };
          }),
      result.semantic === undefined
        ? Promise.resolve(null)
        : gzipAsync(Buffer.from(JSON.stringify([...result.semantic.sources]), "utf8"), { level: 1 }).then(async (bytes) => {
            const target = join(stage, "sources.json.gz");
            await writeFile(target, bytes, { mode: 0o600 });
            return { name: "sources.json.gz", digest: digest(bytes) };
          }),
    ]);
    if (!frontendInputsStillMatch(
      result.frontend,
      frontendOutputExclusions(options, result.native.backend, result.sidecarPath),
    )) return;
    const unsigned: Omit<EarlyLibraryCacheStamp, "integrity"> = {
      version: 2,
      key: cacheKey(options),
      frontend: result.frontend,
      files: { translationUnit, ir, sidecar, semanticIr, sources },
      native: result.native,
    };
    const stamp: EarlyLibraryCacheStamp = { ...unsigned, integrity: stampIntegrity(unsigned) };
    await writeFile(join(stage, "stamp.json"), `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const install = async (name: string): Promise<void> => {
      const source = join(stage, name);
      const target = join(destination, name);
      await rename(source, target).catch(async () => {
        // Windows does not replace an existing destination through rename.
        // A racing reader sees either the old file or a miss; the stamp lands
        // last, so no mixed artifact set can validate as a hit.
        await rm(target, { force: true });
        await rename(source, target);
      });
    };
    await install(translationUnit.name);
    if (ir !== null) await install(ir.name);
    if (sidecar !== null) await install(sidecar.name);
    if (semanticIr !== null) await install(semanticIr.name);
    if (sources !== null) await install(sources.name);
    await install("stamp.json");
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
