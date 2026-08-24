import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CompilerImplementationDependency {
  path: string;
  kind: "file" | "directory";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface CompilerImplementationIdentity {
  digest: string;
  dependencies: CompilerImplementationDependency[];
}

/** The installed compiler package whose bytes define frontend identity. The
 * startup route also uses this location to keep metadata proofs from two
 * source checkouts sharing a cache root from standing in for one another. */
export function compilerImplementationRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "..");
}

function dependency(
  path: string,
  info: Awaited<ReturnType<typeof lstat>>,
): CompilerImplementationDependency | null {
  const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
  return kind === null
    ? null
    : {
        path,
        kind,
        dev: Number(info.dev),
        ino: Number(info.ino),
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        ctimeMs: Number(info.ctimeMs),
      };
}

/** Content identity plus a cheap replay proof for the compiler package that
 * produced an early frontend artifact. Full compiles hash every byte before
 * publication; the CLI fast path validates the captured inode/time/size
 * metadata and loads the large compiler graph only when anything changed. */
export async function compilerImplementationIdentity(
  captureDependencies = true,
): Promise<CompilerImplementationIdentity> {
  const implementationRoot = compilerImplementationRoot();
  const files: string[] = [];
  const dependencies: CompilerImplementationDependency[] = [];
  const walk = async (directory: string): Promise<void> => {
    const directoryInfo = dependency(directory, await lstat(directory));
    if (captureDependencies && directoryInfo !== null) dependencies.push(directoryInfo);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
        const fileInfo = dependency(path, await lstat(path));
        if (captureDependencies && fileInfo !== null) dependencies.push(fileInfo);
      }
    }
  };
  await walk(implementationRoot);
  // Keep the v1 digest byte-identical: dependency metadata augments replay
  // validation without invalidating every existing library/executable entry.
  const hash = createHash("sha256").update("scriptc-frontend-implementation-v1\0");
  for (const file of files) {
    hash.update(relative(implementationRoot, file)).update("\0").update(await readFile(file)).update("\0");
  }
  return { digest: hash.digest("hex"), dependencies };
}

function validDependency(value: unknown): value is CompilerImplementationDependency {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<CompilerImplementationDependency>;
  return typeof item.path === "string" &&
    (item.kind === "file" || item.kind === "directory") &&
    typeof item.dev === "number" && typeof item.ino === "number" &&
    typeof item.size === "number" && typeof item.mtimeMs === "number" &&
    typeof item.ctimeMs === "number";
}

export async function compilerImplementationDependenciesStillMatch(
  dependencies: readonly CompilerImplementationDependency[],
): Promise<boolean> {
  if (!Array.isArray(dependencies) || !dependencies.every(validDependency)) return false;
  const current = await Promise.all(dependencies.map(async (expected) => {
    const info = await lstat(expected.path).catch(() => null);
    if (info === null) return false;
    const observed = dependency(expected.path, info);
    return observed !== null && JSON.stringify(observed) === JSON.stringify(expected);
  }));
  return current.every(Boolean);
}
