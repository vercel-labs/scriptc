import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Filesystem observations made while constructing and lowering one frontend
 * program.  The early library cache replays these probes before trusting a
 * generated translation unit: successful reads are content-addressed, while
 * failed candidate probes are retained so a newly-created module cannot hide
 * behind an old resolution answer.
 */
export type FrontendInputProbe =
  | { op: "file"; path: string; digest: string }
  | { op: "read-error"; path: string }
  | { op: "kind"; path: string; kind: "file" | "directory" | "other" | "missing" }
  | { op: "entries"; path: string; files: string[]; directories: string[] }
  | { op: "realpath"; path: string; target: string | null };

export interface FrontendInputSnapshot {
  version: 1;
  probes: FrontendInputProbe[];
  stable: boolean;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function pathKind(path: string): Extract<FrontendInputProbe, { op: "kind" }>["kind"] {
  try {
    const info = statSync(path);
    return info.isFile()
      ? "file"
      : info.isDirectory()
        ? "directory"
        : "other";
  } catch {
    return "missing";
  }
}

const activeTracker = new AsyncLocalStorage<FrontendInputTracker>();

export class FrontendInputTracker {
  private readonly probes = new Map<string, FrontendInputProbe>();
  private stable = true;

  run<T>(fn: () => T): T {
    const parent = activeTracker.getStore();
    if (parent === undefined || parent === this) return activeTracker.run(this, fn);
    return activeTracker.run(this, () => {
      const result = fn();
      for (const probe of this.probes.values()) parent.record(probe);
      return result;
    });
  }

  record(probe: FrontendInputProbe): void {
    const key = `${probe.op}\0${probe.path}`;
    const previous = this.probes.get(key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(probe)) {
      // An input changed while this frontend was running.  The build may
      // still finish normally, but it is not safe to publish as a cache key.
      this.stable = false;
    }
    this.probes.set(key, probe);
    if (probe.op === "file") {
      // A successful content read supersedes earlier existence probes for the
      // same path. Retaining both would make the post-build stability check
      // reject a perfectly stable input (`kind` vs `file` are two views of
      // the same current file, not two historical states).
      this.probes.delete(`kind\0${probe.path}`);
      const failedRead = this.probes.get(`read-error\0${probe.path}`);
      if (failedRead !== undefined) this.stable = false;
      this.probes.delete(`read-error\0${probe.path}`);
    } else if (probe.op === "read-error") {
      // A path can remain a regular file while its readability changes.
      // Keep the failed operation itself, rather than reducing it to a kind
      // probe, so a permission/ACL repair invalidates the cached frontend.
      const successfulRead = this.probes.get(`file\0${probe.path}`);
      if (successfulRead !== undefined) this.stable = false;
      this.probes.delete(`file\0${probe.path}`);
    }
  }

  snapshot(): FrontendInputSnapshot {
    return {
      version: 1,
      probes: [...this.probes.values()].sort((a, b) =>
        a.path === b.path ? a.op.localeCompare(b.op) : a.path.localeCompare(b.path)
      ),
      stable: this.stable,
    };
  }
}

export function frontendInputTrackingActive(): boolean {
  return activeTracker.getStore() !== undefined;
}

function record(probe: FrontendInputProbe): void {
  activeTracker.getStore()?.record(probe);
}

export function trackedReadFile(path: string): string | null {
  path = resolve(path);
  try {
    const text = readFileSync(path, "utf8");
    record({ op: "file", path, digest: digest(text) });
    return text;
  } catch {
    record({ op: "read-error", path });
    return null;
  }
}

export function trackedFileExists(path: string): boolean {
  path = resolve(path);
  let exists = false;
  try {
    exists = statSync(path).isFile();
  } catch {
    // The exact failed candidate is part of the resolution answer.
  }
  record({ op: "kind", path, kind: pathKind(path) });
  return exists;
}

export function trackedDirectoryExists(path: string): boolean {
  path = resolve(path);
  let exists = false;
  try {
    exists = statSync(path).isDirectory();
  } catch {
    // The exact failed candidate is part of the resolution answer.
  }
  record({ op: "kind", path, kind: pathKind(path) });
  return exists;
}

export function trackedExists(path: string): boolean {
  path = resolve(path);
  const exists = existsSync(path);
  record({ op: "kind", path, kind: pathKind(path) });
  return exists;
}

export function trackedRealpath(path: string): string | null {
  path = resolve(path);
  try {
    const target = realpathSync(path);
    record({ op: "realpath", path, target });
    return target;
  } catch {
    record({ op: "realpath", path, target: null });
    return null;
  }
}

export function trackedAccessibleEntries(
  path: string,
): { files: string[]; directories: string[] } | null {
  path = resolve(path);
  try {
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const kind = entry.isSymbolicLink() ? pathKind(resolve(path, entry.name)) : null;
      if (entry.isFile() || kind === "file") files.push(entry.name);
      if (entry.isDirectory() || kind === "directory") directories.push(entry.name);
    }
    files.sort();
    directories.sort();
    const answer = { files, directories };
    record({ op: "entries", path, ...answer });
    return answer;
  } catch {
    record({ op: "kind", path, kind: pathKind(path) });
    return null;
  }
}

/** Re-run every recorded probe against the current filesystem. */
export function frontendInputsStillMatch(snapshot: FrontendInputSnapshot): boolean {
  if (snapshot.version !== 1 || snapshot.stable !== true || !Array.isArray(snapshot.probes)) {
    return false;
  }
  return snapshot.probes.every((probe) => {
    switch (probe.op) {
      case "file": {
        try {
          return digest(readFileSync(probe.path, "utf8")) === probe.digest;
        } catch {
          return false;
        }
      }
      case "read-error": {
        try {
          readFileSync(probe.path, "utf8");
          return false;
        } catch {
          return true;
        }
      }
      case "kind":
        return pathKind(probe.path) === probe.kind;
      case "entries": {
        try {
          const files: string[] = [];
          const directories: string[] = [];
          for (const entry of readdirSync(probe.path, { withFileTypes: true })) {
            const kind = entry.isSymbolicLink() ? pathKind(resolve(probe.path, entry.name)) : null;
            if (entry.isFile() || kind === "file") files.push(entry.name);
            if (entry.isDirectory() || kind === "directory") directories.push(entry.name);
          }
          files.sort();
          directories.sort();
          return JSON.stringify(files) === JSON.stringify(probe.files) &&
            JSON.stringify(directories) === JSON.stringify(probe.directories);
        } catch {
          return false;
        }
      }
      case "realpath": {
        try {
          return realpathSync(probe.path) === probe.target;
        } catch {
          return probe.target === null;
        }
      }
    }
  });
}

/** Pure validator used by the persistent-cache reader before any path probes. */
export function validFrontendInputSnapshot(snapshot: unknown): snapshot is FrontendInputSnapshot {
  if (snapshot === null || typeof snapshot !== "object") return false;
  const candidate = snapshot as Partial<FrontendInputSnapshot>;
  if (candidate.version !== 1 || candidate.stable !== true || !Array.isArray(candidate.probes)) return false;
  return candidate.probes.every((probe) => {
    if (probe === null || typeof probe !== "object") return false;
    const value = probe as Partial<FrontendInputProbe>;
    if (typeof value.path !== "string" || typeof value.op !== "string") return false;
    switch (value.op) {
      case "file":
        return typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest);
      case "read-error":
        return true;
      case "kind":
        return value.kind === "file" || value.kind === "directory" || value.kind === "other" ||
          value.kind === "missing";
      case "entries":
        return Array.isArray(value.files) && value.files.every((entry) => typeof entry === "string") &&
          Array.isArray(value.directories) && value.directories.every((entry) => typeof entry === "string");
      case "realpath":
        return value.target === null || typeof value.target === "string";
      default:
        return false;
    }
  });
}
