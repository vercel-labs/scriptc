import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FrontendInputExclusions } from "../frontend/input-tracker.js";
import { compilerReleaseVersion } from "./sidecar.js";

export type CacheBackend = "c" | "llvm";

interface CacheOutputOptions {
  entryPath: string;
  outDir: string;
  emitIr: boolean;
}

export interface CacheOutputPaths {
  cPath: string;
  staleCPath: string;
  irPath: string;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function cacheKey(
  namespace: string,
  parts: readonly (string | Uint8Array)[],
): string {
  const hash = createHash("sha256")
    .update(namespace).update("\0")
    .update(compilerReleaseVersion()).update("\0");
  for (const [index, part] of parts.entries()) {
    hash.update(part);
    if (index + 1 < parts.length) hash.update("\0");
  }
  return hash.digest("hex");
}

export function stampPath(root: string, namespace: string, key: string): string {
  return join(root, namespace, key, "stamp.json");
}

export function stampIntegrity(namespace: string, stamp: object): string {
  return createHash("sha256")
    .update(namespace).update("\0")
    .update(JSON.stringify(stamp))
    .digest("hex");
}

export function outputPaths(
  options: CacheOutputOptions,
  backend: CacheBackend,
  stemSuffix = "",
): CacheOutputPaths {
  const stem = basename(options.entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "") + stemSuffix;
  return {
    cPath: join(options.outDir, `${stem}.${backend === "llvm" ? "ll" : "c"}`),
    staleCPath: join(options.outDir, `${stem}.${backend === "llvm" ? "c" : "ll"}`),
    irPath: join(options.outDir, `${stem}.ir.json`),
  };
}

export function frontendOutputExclusions(
  options: CacheOutputOptions,
  backend: CacheBackend,
  stemSuffix: string,
  additionalPaths: readonly string[],
): FrontendInputExclusions {
  const paths = outputPaths(options, backend, stemSuffix);
  const outputArtifacts = [
    paths.cPath,
    paths.staleCPath,
    ...(options.emitIr ? [paths.irPath] : []),
    ...additionalPaths,
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

export async function readCachedFile(path: string, expected: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(path);
    return digest(bytes) === expected ? bytes : null;
  } catch {
    return null;
  }
}

export async function installBytes(bytes: Uint8Array, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = join(
    dirname(destination),
    `.scriptc-early-hit-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o666 & ~process.umask());
    await rename(tmp, destination);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function validNativeFeatures<T extends { backend: CacheBackend }>(
  value: unknown,
  booleanKeys: readonly (keyof T)[],
  validAdditional: (native: Partial<T>) => boolean = () => true,
): value is T {
  if (value === null || typeof value !== "object") return false;
  const native = value as Partial<T>;
  return (native.backend === "c" || native.backend === "llvm") &&
    booleanKeys.every((key) => typeof native[key] === "boolean") &&
    validAdditional(native);
}
