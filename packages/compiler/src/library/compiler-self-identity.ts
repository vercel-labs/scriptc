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
  /** The entry's CONTENT digest: a file's bytes, or a directory's sorted
   * child names and kinds. The proof compares this and the kind, never the
   * metadata above: a rebuild that leaves the compiler's content the same
   * (its files rewritten with identical bytes, or its directories touched)
   * must keep the identity, or no unit or executable cache entry keyed by it
   * is ever found again. */
  content: string;
}

/** `names` (sorted) as a directory's content digest. */
function directoryContent(
  entries: readonly { name: string; isDirectory: () => boolean }[],
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.name);
    hash.update("\0");
    hash.update(entry.isDirectory() ? "d" : "f");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** `bytes` as a file's content digest. */
function fileContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** An entry's kind and content digest as the proof compares them. */
async function entryContent(
  path: string,
  info: Awaited<ReturnType<typeof lstat>>,
): Promise<{ kind: "file" | "directory"; content: string } | null> {
  if (info.isFile()) return { kind: "file", content: fileContent(await readFile(path)) };
  if (!info.isDirectory()) return null;
  const children = await readdir(path, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  return { kind: "directory", content: directoryContent(children) };
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
  content: string,
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
        content,
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
    const directoryInfo = await lstat(directory);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    // A directory's content is its children's names and kinds: a child
    // arriving during the scan changes this digest on the next check.
    entries.push({
      path: directory,
      directory: dependency(directory, directoryInfo, directoryContent(children)),
    });
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
        const bytes = await readFile(entry.path);
        const info = dependency(entry.path, await lstat(entry.path), fileContent(bytes));
        return { ...entry, info, bytes };
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
    typeof item.ctimeMs === "number" &&
    typeof item.content === "string"
  );
}

export async function compilerImplementationDependenciesStillMatch(
  dependencies: readonly CompilerImplementationDependency[],
): Promise<boolean> {
  if (!Array.isArray(dependencies) || !dependencies.every(validDependency)) return false;
  // The proof compares each entry's kind and CONTENT, not its metadata: a
  // rebuild that rewrites the compiler's files with identical bytes leaves
  // its identity (and every cache entry keyed by it) intact.
  //
  // Read bounded batches: a compiler package can hold more files than the
  // process may keep open at once, and opening them all would fail the proof
  // for an unchanged package — and with it every cache fast path keyed by the
  // identity.
  const batchSize = 64;
  for (let start = 0; start < dependencies.length; start += batchSize) {
    const batch = await Promise.all(
      dependencies.slice(start, start + batchSize).map(async (expected) => {
        const info = await lstat(expected.path).catch(() => null);
        if (info === null) return false;
        const observed = await entryContent(expected.path, info).catch(() => null);
        return (
          observed !== null &&
          observed.kind === expected.kind &&
          observed.content === expected.content
        );
      }),
    );
    if (!batch.every(Boolean)) return false;
  }
  return true;
}
