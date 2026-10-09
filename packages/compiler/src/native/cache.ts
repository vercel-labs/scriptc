import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveBuildCacheRoot } from "../backend/cache-root.js";

export function contentDigest(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value);
  else hash.update(value);
  return hash.digest("hex");
}

/** A compiler cache contains private source and executable data. The host
 * checks ownership and permissions before this class accepts a root. */
export class NativeCache {
  readonly root: string;

  constructor(root: string) {
    this.root = join(root, "native-v1");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  read(family: string, key: string): Buffer | null {
    try {
      const path = join(this.root, family, key);
      const bytes = readFileSync(path);
      if (contentDigest(bytes) !== readFileSync(path + ".sha256", "utf8").trim()) return null;
      return bytes;
    } catch {
      return null;
    }
  }

  write(family: string, key: string, bytes: string | Uint8Array): void {
    let stage: string | null = null;
    try {
      const directory = join(this.root, family);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      stage = mkdtempSync(join(directory, ".write-"));
      writeFileSync(join(stage, "payload"), bytes);
      writeFileSync(join(stage, "digest"), contentDigest(bytes) + "\n");
      const path = join(directory, key);
      // Concurrent writers publish identical content under the same key;
      // a reader between the two renames simply treats it as a miss.
      renameSync(join(stage, "payload"), path);
      renameSync(join(stage, "digest"), path + ".sha256");
    } catch {
      /* Cache failures never change a build's result. */
    } finally {
      try {
        if (stage !== null) rmSync(stage, { recursive: true, force: true });
      } catch {
        /* Cleanup is best effort too. */
      }
    }
  }

  prune(): void {
    try {
      const configured = Number(process.env["SCRIPTC_CACHE_MAX_MB"] ?? "4096");
      const limit =
        (Number.isFinite(configured) && configured >= 0 ? configured : 4096) * 1024 * 1024;
      const files: { path: string; size: number; time: number }[] = [];
      let total = 0;
      for (const family of [
        "frontend",
        "object",
        "sanitizer",
        "executable",
        "binary",
        "dsym",
        "coverage",
      ]) {
        const directory = join(this.root, family);
        let names: string[];
        try {
          names = readdirSync(directory);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!/^[0-9a-f]{64}$/.test(name)) continue;
          const path = join(directory, name);
          const info = statSync(path);
          if (!info.isFile()) continue;
          files.push({ path, size: info.size, time: info.mtimeMs });
          total += info.size;
        }
      }
      if (total <= limit) return;
      files.sort((a, b) => a.time - b.time);
      for (const file of files) {
        if (total <= limit) break;
        rmSync(file.path, { force: true });
        rmSync(file.path + ".sha256", { force: true });
        total -= file.size;
      }
    } catch {
      /* Eviction is best effort. */
    }
  }
}

export function openNativeCache(
  isPrivate: (path: string, harden: boolean) => boolean,
): NativeCache | null {
  const root = resolveBuildCacheRoot();
  if (root === null) return null;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!isPrivate(root, process.env["SCRIPTC_CACHE_DIR"] === undefined)) return null;
    const cache = new NativeCache(root);
    if (!isPrivate(cache.root, false)) return null;
    return cache;
  } catch {
    return null;
  }
}
