import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveBuildCacheRoot } from "../backend/cache-root.js";
import { joinedParts, writeTextGeneratedSync } from "./text-file.js";

/** UTF-8 bytes one native compiler string can hold (the runtime's
 * SCR_STR_MAX_CAP). Exceeding it traps rather than throwing, so payloads
 * decoded as one string are bounded by it up front. */
export const NATIVE_STRING_BYTES = 0x7fffffff;

export function contentDigest(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value);
  else hash.update(value);
  return hash.digest("hex");
}

/** contentDigest of the text the parts concatenate to. */
export function partsDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of joinedParts(parts)) hash.update(part);
  return hash.digest("hex");
}

/** contentDigest of a file's bytes, read in 1 MiB blocks so a large file
 * (a module's LLVM text) is never held whole. */
export function fileDigest(path: string): string {
  const hash = createHash("sha256");
  const block = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let read = readSync(fd, block, 0, block.length, null); read > 0;) {
      hash.update(block.subarray(0, read));
      read = readSync(fd, block, 0, block.length, null);
    }
  } finally {
    closeSync(fd);
  }
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

  /** Entries larger than `maxBytes` are misses. */
  read(family: string, key: string, maxBytes = Infinity): Buffer | null {
    try {
      const path = join(this.root, family, key);
      if (maxBytes < Infinity && statSync(path).size > maxBytes) return null;
      const bytes = readFileSync(path);
      if (contentDigest(bytes) !== readFileSync(path + ".sha256", "utf8").trim()) return null;
      return bytes;
    } catch {
      return null;
    }
  }

  /** Directory where the LLVM helper reuses partition artifacts for one
   * helper build. The helper names and verifies the entries itself. */
  partitionDirectory(helperIdentity: string): string | null {
    const directory = join(this.root, "partitions", contentDigest(helperIdentity).slice(0, 32));
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return directory;
    } catch {
      /* An unavailable cache only prevents reuse. */
      return null;
    }
  }

  write(
    family: string,
    key: string,
    bytes: string | Uint8Array,
    digest = contentDigest(bytes),
  ): void {
    let stage: string | null = null;
    try {
      const directory = join(this.root, family);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      stage = mkdtempSync(join(directory, ".write-"));
      writeFileSync(join(stage, "payload"), bytes);
      writeFileSync(join(stage, "digest"), digest + "\n");
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

  /** Whether a marker or entry exists, without reading or checking it. */
  has(family: string, key: string): boolean {
    return existsSync(join(this.root, family, key));
  }

  /** Records an empty marker that has() finds. */
  mark(family: string, key: string): void {
    try {
      const directory = join(this.root, family);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, key), "");
    } catch {
      /* Cache failures never change a build's result. */
    }
  }

  /** Writes `bytes` under their content digest, and returns the digest. */
  writeContent(family: string, bytes: Uint8Array): string {
    const digest = contentDigest(bytes);
    this.write(family, digest, bytes, digest);
    return digest;
  }

  /** Publish text parts without joining them into one string. */
  writeParts(family: string, key: string, parts: Generator<string>): void {
    let stage: string | null = null;
    try {
      const directory = join(this.root, family);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      stage = mkdtempSync(join(directory, ".write-"));
      // One pass over the parts: they may be generated while they are written.
      const hash = createHash("sha256");
      writeTextGeneratedSync(join(stage, "payload"), parts, (slice) => hash.update(slice));
      writeFileSync(join(stage, "digest"), hash.digest("hex") + "\n");
      const path = join(directory, key);
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
        "linked",
        "runtime-pack",
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
      // Helper partition entries: partitions/<helper>/<xx>/<key>.<kind>.
      const partitions = join(this.root, "partitions");
      const list = (directory: string) => {
        try {
          return readdirSync(directory, { withFileTypes: true });
        } catch {
          return [];
        }
      };
      for (const helper of list(partitions)) {
        if (!helper.isDirectory()) continue;
        for (const bucket of list(join(partitions, helper.name))) {
          if (!bucket.isDirectory()) continue;
          const directory = join(partitions, helper.name, bucket.name);
          for (const entry of list(directory)) {
            if (!entry.isFile() || !/^[0-9a-f]{64}\.(?:o|bc)$/.test(entry.name)) continue;
            const path = join(directory, entry.name);
            const info = statSync(path);
            files.push({ path, size: info.size, time: info.mtimeMs });
            total += info.size;
          }
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
