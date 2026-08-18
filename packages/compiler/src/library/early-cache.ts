import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilerReleaseVersion } from "./sidecar.js";
import { frontendInputsStillMatch, validFrontendInputSnapshot, type FrontendInputSnapshot } from "../frontend/input-tracker.js";

interface CachedLibraryFile {
  name: string;
  digest: string;
}

interface EarlyLibraryCacheStamp {
  version: 1;
  key: string;
  frontend: FrontendInputSnapshot;
  files: {
    translationUnit: CachedLibraryFile;
    ir: CachedLibraryFile | null;
    sidecar: CachedLibraryFile | null;
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
    ].every((flag) => typeof flag === "boolean");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheKey(options: EarlyLibraryCacheOptions): string {
  return createHash("sha256")
    .update("early-library-v1\0")
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
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const implementationRoot = resolve(moduleDir, "..", "..");
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(implementationRoot);
  const hash = createHash("sha256").update("scriptc-frontend-implementation-v1\0");
  for (const file of files) {
    hash.update(relative(implementationRoot, file)).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}

function stampPath(root: string, options: EarlyLibraryCacheOptions): string {
  return join(root, "early-lib", cacheKey(options), "stamp.json");
}

function stampIntegrity(stamp: Omit<EarlyLibraryCacheStamp, "integrity">): string {
  return createHash("sha256")
    .update("early-library-stamp-v1\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

function outputPaths(options: EarlyLibraryCacheOptions, backend: "c" | "llvm"): {
  cPath: string;
  irPath: string;
} {
  const stem = basename(options.entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  return {
    cPath: join(options.outDir, `${stem}.lib.${backend === "llvm" ? "ll" : "c"}`),
    irPath: join(options.outDir, `${stem}.lib.ir.json`),
  };
}

function sidecarOutputPath(options: EarlyLibraryCacheOptions, configured: string | null): string {
  const archivePath = options.outPath ?? join(
    options.outDir,
    `${basename(options.entryPath).replace(/\.(ts|js|mjs|cjs)$/, "")}.lib.a`,
  );
  return configured !== null ? resolve(dirname(archivePath), configured) : `${archivePath}.contract.json`;
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
      stamp.version !== 1 ||
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
      stampIntegrity(unsigned) !== integrity ||
      !frontendInputsStillMatch(stamp.frontend) ||
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
    if (ir !== null) await installBytes(ir, paths.irPath);
    let sidecarPath: string | undefined;
    if (sidecar !== null) {
      sidecarPath = sidecarOutputPath(options, sidecarConfiguredPath ?? null);
      await installBytes(sidecar, sidecarPath);
    }
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
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
    const [translationUnit, ir, sidecar] = await Promise.all([
      publishFile(result.cPath, "program.tu"),
      result.irPath === undefined ? Promise.resolve(null) : publishFile(result.irPath, "program.ir.json"),
      result.sidecarPath === undefined ? Promise.resolve(null) : publishFile(result.sidecarPath, "contract.json"),
    ]);
    if (!frontendInputsStillMatch(result.frontend)) return;
    const unsigned: Omit<EarlyLibraryCacheStamp, "integrity"> = {
      version: 1,
      key: cacheKey(options),
      frontend: result.frontend,
      files: { translationUnit, ir, sidecar },
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
    await install("stamp.json");
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
