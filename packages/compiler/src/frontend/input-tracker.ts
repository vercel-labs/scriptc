import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

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
  | { op: "entries-error"; path: string }
  | { op: "realpath"; path: string; target: string | null };

export interface FrontendInputSnapshot {
  version: 1;
  probes: FrontendInputProbe[];
  stable: boolean;
}

export interface FrontendSemanticChange {
  path: string;
  previous: string;
  current: string;
}

export interface FrontendSemanticMatch {
  changed: FrontendSemanticChange[];
  currentSources: Map<string, string>;
  snapshot: FrontendInputSnapshot;
}

/** Compiler-owned paths whose creation/removal must not invalidate the
 * frontend that produced them. Directory CONTENT remains tracked: only the
 * named artifacts and a generated directory's formerly-missing observation
 * are excluded. */
export interface FrontendInputExclusions {
  outputPaths?: Iterable<string>;
  outputDirectories?: Iterable<string>;
}

function frontendSourceDigest(text: string): string {
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
      // same path only when they also observed a file. A missing/non-file
      // answer followed by a successful read means the input changed during
      // the frontend and the mixed observation must never be published.
      const previousKind = this.probes.get(`kind\0${probe.path}`);
      if (previousKind?.op === "kind" && previousKind.kind !== "file") this.stable = false;
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

function record(probe: FrontendInputProbe): void {
  activeTracker.getStore()?.record(probe);
}

export function trackedReadFile(path: string): string | null {
  path = resolve(path);
  try {
    const text = readFileSync(path, "utf8");
    record({ op: "file", path, digest: frontendSourceDigest(text) });
    return text;
  } catch {
    record({ op: "read-error", path });
    return null;
  }
}

export function trackedFileExists(path: string): boolean {
  path = resolve(path);
  const kind = pathKind(path);
  record({ op: "kind", path, kind });
  return kind === "file";
}

export function trackedDirectoryExists(path: string): boolean {
  path = resolve(path);
  const kind = pathKind(path);
  record({ op: "kind", path, kind });
  return kind === "directory";
}

export function trackedExists(path: string): boolean {
  path = resolve(path);
  const kind = pathKind(path);
  record({ op: "kind", path, kind });
  return kind !== "missing";
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
    // Enumeration can fail even while the path remains a directory. Preserve
    // the failed operation itself so a permission/ACL repair invalidates the
    // cached frontend rather than replaying only the unchanged path kind.
    record({ op: "entries-error", path });
    return null;
  }
}

/** Re-run every recorded probe against the current filesystem. */
export function frontendInputsStillMatch(
  snapshot: FrontendInputSnapshot,
  exclusions: FrontendInputExclusions = {},
): boolean {
  if (snapshot.version !== 1 || snapshot.stable !== true || !Array.isArray(snapshot.probes)) {
    return false;
  }
  const outputPaths = new Set([...(exclusions.outputPaths ?? [])].map((path) => resolve(path)));
  const outputDirectories = new Set(
    [...(exclusions.outputDirectories ?? [])].map((path) => resolve(path)),
  );
  const generatedOnlyDirectory = (directory: string): boolean => {
    const allowedFiles = new Set<string>();
    for (const output of outputPaths) {
      if (dirname(output) === directory) allowedFiles.add(basename(output));
    }
    const allowedDirectories = new Map<string, string>();
    for (const outputDir of outputDirectories) {
      if (outputDir !== directory && dirname(outputDir) === directory) {
        allowedDirectories.set(basename(outputDir), outputDir);
      }
    }
    try {
      return readdirSync(directory).every((name) => {
        if (allowedFiles.has(name)) return true;
        const child = allowedDirectories.get(name);
        return child !== undefined && generatedOnlyDirectory(child);
      });
    } catch {
      return false;
    }
  };
  return snapshot.probes.every((probe) => {
    if (outputPaths.has(probe.path)) return true;
    if (outputDirectories.has(probe.path)) {
      // A fresh output directory can be absent while the frontend runs and
      // created only when emission starts. Admit it only while its current
      // contents are exactly the named compiler artifacts; a user file that
      // appears there still invalidates module resolution.
      if (probe.op === "kind" && probe.kind === "missing") {
        return pathKind(probe.path) === "missing" || generatedOnlyDirectory(probe.path);
      }
      if (probe.op === "entries-error") {
        try {
          readdirSync(probe.path);
          return generatedOnlyDirectory(probe.path);
        } catch {
          return true;
        }
      }
      if (probe.op === "realpath" && probe.target === null) {
        try {
          realpathSync(probe.path);
          return generatedOnlyDirectory(probe.path);
        } catch {
          return true;
        }
      }
    }
    switch (probe.op) {
      case "file": {
        try {
          return frontendSourceDigest(readFileSync(probe.path, "utf8")) === probe.digest;
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
          const ignored = new Set<string>();
          for (const output of outputPaths) {
            if (dirname(output) === probe.path) ignored.add(basename(output));
          }
          for (const outputDir of outputDirectories) {
            if (dirname(outputDir) !== probe.path) continue;
            const name = basename(outputDir);
            // If the directory existed during the frontend, keep tracking its
            // presence. Only suppress a directory introduced by this build.
            if (
              !probe.files.includes(name) &&
              !probe.directories.includes(name) &&
              generatedOnlyDirectory(outputDir)
            ) {
              ignored.add(name);
            }
          }
          const files: string[] = [];
          const directories: string[] = [];
          for (const entry of readdirSync(probe.path, { withFileTypes: true })) {
            const kind = entry.isSymbolicLink() ? pathKind(resolve(probe.path, entry.name)) : null;
            if (entry.isFile() || kind === "file") files.push(entry.name);
            if (entry.isDirectory() || kind === "directory") directories.push(entry.name);
          }
          files.sort();
          directories.sort();
          return JSON.stringify(files.filter((name) => !ignored.has(name))) ===
              JSON.stringify(probe.files.filter((name) => !ignored.has(name))) &&
            JSON.stringify(directories.filter((name) => !ignored.has(name))) ===
              JSON.stringify(probe.directories.filter((name) => !ignored.has(name)));
        } catch {
          return false;
        }
      }
      case "entries-error": {
        try {
          readdirSync(probe.path, { withFileTypes: true });
          return false;
        } catch {
          return true;
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

/**
 * Validate all non-source frontend probes exactly while allowing only
 * caller-approved semantic-equivalent file edits. The old source text is a
 * cache payload; every unchanged input remains content-hash checked.
 */
export function frontendInputsSemanticallyMatch(
  snapshot: FrontendInputSnapshot,
  previousSources: ReadonlyMap<string, string>,
  isSemanticEquivalent: (path: string, previous: string, current: string) => boolean,
  exclusions: FrontendInputExclusions = {},
): FrontendSemanticMatch | null {
  if (!validFrontendInputSnapshot(snapshot)) return null;
  const sourceProbes = new Map(
    snapshot.probes
      .filter((probe): probe is Extract<FrontendInputProbe, { op: "file" }> => probe.op === "file")
      .map((probe) => [probe.path, probe]),
  );
  for (const [path, previous] of previousSources) {
    if (sourceProbes.get(path)?.digest !== frontendSourceDigest(previous)) return null;
  }
  const changed: FrontendSemanticChange[] = [];
  const currentSources = new Map<string, string>();
  const adjusted: FrontendInputSnapshot = {
    ...snapshot,
    probes: snapshot.probes.map((probe) => {
      if (probe.op !== "file") return probe;
      let current: string;
      try {
        current = readFileSync(probe.path, "utf8");
      } catch {
        return probe;
      }
      const previous = previousSources.get(probe.path);
      const currentDigest = frontendSourceDigest(current);
      if (previous === undefined || frontendSourceDigest(previous) !== probe.digest) return probe;
      currentSources.set(probe.path, current);
      if (currentDigest === probe.digest) return probe;
      if (!isSemanticEquivalent(probe.path, previous, current)) return probe;
      changed.push({ path: probe.path, previous, current });
      return { ...probe, digest: currentDigest };
    }),
  };
  if (!frontendInputsStillMatch(adjusted, exclusions)) return null;
  for (const [path, previous] of previousSources) {
    if (!currentSources.has(path)) {
      try {
        currentSources.set(path, readFileSync(path, "utf8"));
      } catch {
        currentSources.set(path, previous);
      }
    }
  }
  return { changed, currentSources, snapshot: adjusted };
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
      case "entries-error":
        return true;
      case "realpath":
        return value.target === null || typeof value.target === "string";
      default:
        return false;
    }
  });
}
