import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

export function protectCachedArtifact(paths: Set<string> | undefined, path: string): void {
  paths?.add(path);
  paths?.add(cacheDigestPath(path));
}

export function privateSiblingPath(destination: string, label: string): string {
  // Keep the temporary component independent of the caller's basename. A
  // destination can validly consume the filesystem's entire NAME_MAX budget;
  // appending or prepending that basename would make the atomic install fail.
  return join(
    dirname(destination),
    `.scriptc-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
}

/** Copy an artifact through a private sibling name, then atomically install it.
 * The source can live on another filesystem (cache/temp roots commonly do), so
 * a direct rename is not portable. */
export async function installArtifact(
  source: string,
  destination: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = privateSiblingPath(destination, "install");
  try {
    await copyFile(source, tmp);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, destination).catch(async (error) => {
      // POSIX rename replaces an existing destination, but Windows does not.
      // Caller-visible artifacts can legitimately change identity at the same
      // path (for example console -> GUI PE subsystem), so retain the private
      // staging step and use the Windows-compatible replacement fallback.
      if (process.platform !== "win32") throw error;
      await rm(destination, { force: true });
      await rename(tmp, destination);
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Resolve the build cache without touching the filesystem. Exported from this
 * internal module so its platform and override behavior can be pinned directly. */
export function resolveBuildCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string | null {
  if (env["SCRIPTC_NO_CACHE"] === "1") return null;
  const configured = env["SCRIPTC_CACHE_DIR"];
  if (configured !== undefined) return configured === "" ? null : resolve(configured);

  const xdg = env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg !== "") return resolve(xdg, "scriptc", "build");
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local !== undefined && local !== "") return resolve(local, "scriptc", "cache", "build");
  }
  return platform === "darwin"
    ? resolve(userHome, "Library", "Caches", "scriptc", "build")
    : resolve(userHome, ".cache", "scriptc", "build");
}

/** Shared persistent-cache root for compiler-level tiers.  The early library
 * cache deliberately follows the native cache's activation and hard-disable
 * contract, while native compilation retains ownership of toolchain safety. */
export function buildCacheRoot(): string | null {
  return resolveBuildCacheRoot();
}

/** Harden/create a compiler-level cache root using the same privacy policy as
 * the artifact caches.  Failure disables only the optional caller's tier. */
export async function prepareBuildCacheRoot(root: string | null): Promise<string | null> {
  if (root === null) return null;
  try {
    await ensurePrivateCacheRoot(root, process.env["SCRIPTC_CACHE_DIR"] === undefined);
    return root;
  } catch {
    return null;
  }
}

/** Register a successful compiler-level cache write with the shared bounded
 * LRU policy. */
export async function pruneBuildCache(root: string | null): Promise<void> {
  if (root !== null) await pruneCache(root).catch(() => undefined);
}

export function cacheRootDir(): string | null {
  return resolveBuildCacheRoot();
}

/** The production cache can contain complete user executables/archives with
 * embedded source literals or comptime values. Its root is therefore private
 * regardless of the caller's ordinary output umask. Windows inherits the
 * per-user LOCALAPPDATA ACL. POSIX platform-default roots are hardened for
 * upgrades; an arbitrary existing SCRIPTC_CACHE_DIR override is never chmod'd
 * and participates only when its caller-provided mode is already private. */
export async function ensurePrivateCacheRoot(
  root: string,
  hardenExisting: boolean,
): Promise<void> {
  const existing = await stat(root).then(
    (info) => info,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (existing !== null && !existing.isDirectory()) {
    throw new Error("native cache root is not a directory");
  }
  if (
    process.platform !== "win32" &&
    existing !== null &&
    !hardenExisting &&
    (existing.mode & 0o077) !== 0
  ) {
    throw new Error("existing native cache override is not private");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (existing === null || hardenExisting)) {
    await chmod(root, 0o700);
  }
}

export function cacheDigestPath(path: string): string {
  return `${path}.sha256`;
}

export async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Cache entries are disposable data, not trusted compiler output. Atomic
 * rename prevents ordinary partial writes, while the adjacent digest catches
 * disk damage, manual truncation, and entries left by an interrupted/older
 * publisher before they reach clang, the linker, or `ar`. */
export async function validCachedFile(object: string): Promise<boolean> {
  try {
    const digestPath = cacheDigestPath(object);
    const expected = (await readFile(digestPath, "utf8")).trim();
    const valid = /^[0-9a-f]{64}$/.test(expected) && (await fileDigest(object)) === expected;
    if (valid) {
      const now = new Date();
      await Promise.all([
        utimes(object, now, now).catch(() => undefined),
        utimes(digestPath, now, now).catch(() => undefined),
      ]);
    }
    return valid;
  } catch {
    return false;
  }
}

/** Copy a cache entry and verify the private copy before it can become a
 * caller-visible artifact. Verifying after the copy closes the gap between a
 * source-side digest check and a concurrent replacement/truncation. */
export async function copyValidCachedFile(source: string, destination: string): Promise<boolean> {
  try {
    const digestPath = cacheDigestPath(source);
    const expected = (await readFile(digestPath, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(expected)) return false;
    await copyFile(source, destination);
    if ((await fileDigest(destination)) !== expected) {
      await rm(destination, { force: true }).catch(() => undefined);
      return false;
    }
    const now = new Date();
    await Promise.all([
      utimes(source, now, now).catch(() => undefined),
      utimes(digestPath, now, now).catch(() => undefined),
    ]);
    return true;
  } catch {
    await rm(destination, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Publish a complete executable/archive and its digest through private names.
 * Data is installed before its verifier, so a racing reader can only observe
 * an invalid/missing digest and take the fresh-build path. */
export async function publishCachedFile(source: string, destination: string): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = join(directory, `.tmp-${basename(destination).slice(0, 8)}-${nonce}`);
  const tmpDigest = `${tmp}.sha256`;
  try {
    await copyFile(source, tmp);
    await chmod(tmp, 0o600);
    await writeFile(tmpDigest, `${await fileDigest(tmp)}\n`, { mode: 0o600 });
    await rename(tmp, destination).catch(async (error) => {
      if (process.platform !== "win32") throw error;
      await rm(destination, { force: true });
      await rename(tmp, destination);
    });
    const digestDestination = cacheDigestPath(destination);
    await rename(tmpDigest, digestDestination).catch(async (error) => {
      if (process.platform !== "win32") throw error;
      await rm(digestDestination, { force: true });
      await rename(tmpDigest, digestDestination);
    });
  } finally {
    await Promise.all([
      rm(tmp, { force: true }).catch(() => undefined),
      rm(tmpDigest, { force: true }).catch(() => undefined),
    ]);
  }
}

/** Size-capped LRU sweep of the whole cache root. A caller-configured cap is
 * enforced after every successful cache write. The 4 GiB default is checked on
 * the first and every 64th write in a long-lived process: a full tree walk per
 * corpus program would otherwise become quadratic as the cache grows. Oldest-
 * mtime files go first until the tree is back under 75% of the cap; reads bump
 * mtimes. Active links use private staged names/hard links, so cache names can
 * be unlinked safely. */
const rootWriteCounts = new Map<string, number>();
export async function pruneCache(root: string, protectedPaths?: ReadonlySet<string>): Promise<void> {
  const configuredCap = process.env["SCRIPTC_CACHE_MAX_MB"];
  const writes = (rootWriteCounts.get(root) ?? 0) + 1;
  rootWriteCounts.set(root, writes);
  if (configuredCap === undefined && writes !== 1 && writes % 64 !== 0) return;
  const capBytes = Number(configuredCap ?? "4096") * 1024 * 1024;
  if (!Number.isFinite(capBytes) || capBytes <= 0) return;
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        // Atomic publishers use private names until their data/digest or
        // metadata stamp is complete. They are active writes, not LRU entries.
        if (
          ent.name.startsWith(".scriptc-") ||
          ent.name.startsWith(".tmp-") ||
          ent.name.includes(".tmp-")
        ) continue;
        if (protectedPaths?.has(p)) continue;
        const s = await stat(p).catch(() => null);
        if (s !== null) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await walk(root);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= capBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= capBytes * 0.75) break;
    try {
      await unlink(f.path);
      total -= f.size;
    } catch {
      // A concurrent reader/publisher may already have moved the name.
    }
  }
}
