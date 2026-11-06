import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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

/** Where an installed package keeps the digest it computed for itself. The
 * directory is outside the hashed file set, and the metadata proof the record
 * carries decides whether the digest still describes the package. */
const INSTALL_RECORD_DIRECTORY = ".scriptc";
const INSTALL_RECORD_NAME = "install-digest.json";

interface InstallDigestRecord {
  version: 1;
  /** The install this digest describes. A package copied elsewhere carries the
   * record with it, and its dependencies name the original's files, which are
   * still present and still match; only a matching root says the record is
   * about this install. */
  root: string;
  digest: string;
  dependencies: CompilerImplementationDependency[];
}

/** The installed compiler package whose bytes define frontend identity. The
 * startup route also uses this location to keep metadata proofs from two
 * source checkouts sharing a cache root from standing in for one another.
 * A module reached through a symlinked package path (`--preserve-symlinks`
 * keeps that spelling in module URLs) reports the directory the link names:
 * retargeting the link selects a different install, so every proof and cache
 * namespace built on this path has to follow it. */
export function compilerImplementationRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(moduleDir, "..", "..");
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
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

function installRecordPath(root: string): string {
  return join(root, INSTALL_RECORD_DIRECTORY, INSTALL_RECORD_NAME);
}

async function readInstallDigest(root: string): Promise<InstallDigestRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(installRecordPath(root), "utf8"),
    ) as Partial<InstallDigestRecord>;
    if (parsed.version !== 1 || typeof parsed.digest !== "string") return null;
    if (parsed.root !== root) return null;
    if (!Array.isArray(parsed.dependencies) || parsed.dependencies.length === 0) return null;
    return { version: 1, root, digest: parsed.digest, dependencies: parsed.dependencies };
  } catch {
    return null;
  }
}

/** A read-only install has nowhere to keep a digest and keeps hashing its
 * files on every build; the record is an optimization, never a requirement.
 * An absent package root is left for the scan to report, not created here. */
async function ensureInstallRecordDirectory(root: string): Promise<void> {
  try {
    if (!(await lstat(root)).isDirectory()) return;
    await mkdir(join(root, INSTALL_RECORD_DIRECTORY), { recursive: true });
  } catch {
    // See above.
  }
}

async function writeInstallDigest(
  root: string,
  digest: string,
  dependencies: CompilerImplementationDependency[],
): Promise<void> {
  const record: InstallDigestRecord = { version: 1, root, digest, dependencies };
  try {
    await writeFile(installRecordPath(root), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // See above.
  }
}

/** Content identity plus a cheap replay proof for the compiler package that
 * produced an early frontend artifact. Full compiles hash every byte before
 * publication; the CLI fast path validates the captured inode/time/size
 * metadata and loads the large compiler graph only when anything changed.
 * A build reuses the digest the package recorded for itself while that
 * metadata proof still matches, so one install hashes its files once. */
export async function compilerImplementationIdentity(
  captureDependencies = true,
  implementationRoot = compilerImplementationRoot(),
): Promise<CompilerImplementationIdentity> {
  // An installed package path can be a symlink to the package directory, so
  // the scan starts at what the link names: the walk classifies a directory
  // from its own type, and a symlink is not one of the kinds it records.
  const root = await realpath(implementationRoot).catch(() => implementationRoot);
  const recorded = await readInstallDigest(root);
  if (
    recorded !== null &&
    (await compilerImplementationDependenciesStillMatch(recorded.dependencies))
  )
    return {
      digest: recorded.digest,
      dependencies: captureDependencies ? recorded.dependencies : [],
    };
  // Sorted depth-first order is deliberately DIFFERENT from sorting the
  // complete paths (a.ts would precede a/index.ts).
  const entries: { path: string; directory: CompilerImplementationDependency | null }[] = [];
  const dependencies: CompilerImplementationDependency[] = [];
  const walk = async (directory: string): Promise<void> => {
    // Capture directories BEFORE enumeration: a new child arriving during
    // the scan must invalidate this proof, even if readdir did not see it.
    entries.push({ path: directory, directory: dependency(directory, await lstat(directory)) });
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      // The record directory is outside the identity; it is created before
      // the scan so the root directory's captured metadata stays stable.
      if (directory === root && entry.name === INSTALL_RECORD_DIRECTORY && entry.isDirectory())
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        entries.push({ path, directory: null });
      }
    }
  };
  await ensureInstallRecordDirectory(root);
  await walk(root);
  // Keep the v1 digest byte-identical: dependency metadata augments replay
  // validation without invalidating every existing library/executable entry.
  // Read bounded batches concurrently, then hash in the original sorted DFS
  // order. Serial reads spend hundreds of milliseconds in filesystem round
  // trips on every application edit; reading the entire package at once
  // would retain all its bytes and open an unbounded number of files.
  const hash = createHash("sha256").update("scriptc-frontend-implementation-v1\0");
  const batchSize = 64;
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = await Promise.all(
      entries.slice(start, start + batchSize).map(async (entry) => {
        if (entry.directory !== null) return { ...entry, info: entry.directory, bytes: null };
        const info = dependency(entry.path, await lstat(entry.path));
        return { ...entry, info, bytes: await readFile(entry.path) };
      }),
    );
    for (const entry of batch) {
      if (entry.info !== null) dependencies.push(entry.info);
      if (entry.bytes !== null) {
        hash.update(relative(root, entry.path)).update("\0").update(entry.bytes).update("\0");
      }
    }
  }
  const digest = hash.digest("hex");
  await writeInstallDigest(root, digest, dependencies);
  return {
    digest,
    dependencies: captureDependencies ? dependencies : [],
  };
}

function validDependency(value: unknown): value is CompilerImplementationDependency {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<CompilerImplementationDependency>;
  return (
    typeof item.path === "string" &&
    (item.kind === "file" || item.kind === "directory") &&
    typeof item.dev === "number" &&
    typeof item.ino === "number" &&
    typeof item.size === "number" &&
    typeof item.mtimeMs === "number" &&
    typeof item.ctimeMs === "number"
  );
}

export async function compilerImplementationDependenciesStillMatch(
  dependencies: readonly CompilerImplementationDependency[],
): Promise<boolean> {
  if (!Array.isArray(dependencies) || !dependencies.every(validDependency)) return false;
  const current = await Promise.all(
    dependencies.map(async (expected) => {
      const info = await lstat(expected.path).catch(() => null);
      if (info === null) return false;
      const observed = dependency(expected.path, info);
      return observed !== null && JSON.stringify(observed) === JSON.stringify(expected);
    }),
  );
  return current.every(Boolean);
}
