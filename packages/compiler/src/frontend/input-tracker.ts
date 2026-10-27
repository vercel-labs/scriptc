import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { observeSourceText } from "./ts7/ast-node.js";

/**
 * Filesystem observations made while constructing and lowering one frontend
 * program.  The early library cache replays these probes before trusting a
 * generated translation unit: successful reads are content-addressed, while
 * failed candidate probes are retained so a newly-created module cannot hide
 * behind an old resolution answer.
 */
export type FrontendInputProbe =
  /** `identity` (fileIdentity) lets a later check skip hashing the file. */
  | { op: "file"; path: string; digest: string; identity?: string }
  | { op: "read-error"; path: string }
  | { op: "kind"; path: string; kind: "file" | "directory" | "other" | "missing" }
  | { op: "entries"; path: string; files: string[]; directories: string[] }
  | { op: "entries-error"; path: string }
  | { op: "realpath"; path: string; target: string | null }
  /** The frontend's output depends on the file's raw text or line
   * positions, not only on its tokens (observeSourceText). */
  | { op: "text"; path: string };

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
  outputPaths?: readonly string[];
  outputDirectories?: readonly string[];
}

function frontendSourceDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** How long a file must have been unchanged before a read for its identity
 * to stand for its content: a later write then gets a newer change time
 * even on file systems whose timestamps tick once a second or every two. */
const IDENTITY_SETTLE_MS = 2000;

/** The device, inode, size, modification time and change time of `path`. A
 * write changes the change time, which no tool can set back, so an equal
 * identity means the content is the one hashed with it. */
function fileIdentity(path: string): string | null {
  try {
    const info = statSync(path);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return null;
  }
}

/** The text of `path` with its identity when the identity was the same before
 * and after the read and the file had been unchanged for IDENTITY_SETTLE_MS. */
function readWithIdentity(path: string): { text: string; identity: string | null } {
  const readAt = Date.now();
  const before = statSync(path);
  const text = readFileSync(path, "utf8");
  const after = fileIdentity(path);
  const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  const settled =
    before.mtimeMs <= readAt - IDENTITY_SETTLE_MS && before.ctimeMs <= readAt - IDENTITY_SETTLE_MS;
  return { text, identity: settled && after === identity ? identity : null };
}

/** Two reads of one file that saw the same content, as one probe: a read
 * before the file had been unchanged for IDENTITY_SETTLE_MS records no
 * identity, and a later read of the same bytes does. The probe keeps the
 * identity, which the settled read proved for that content. Null when the
 * reads differ in anything else. */
function sameFileContent(
  previous: FrontendInputProbe,
  probe: FrontendInputProbe,
): FrontendInputProbe | null {
  if (previous.op !== "file" || probe.op !== "file" || previous.digest !== probe.digest)
    return null;
  if (previous.identity === undefined) return probe;
  if (probe.identity === undefined || probe.identity === previous.identity) return previous;
  return null;
}

function pathKind(path: string): Extract<FrontendInputProbe, { op: "kind" }>["kind"] {
  try {
    const info = statSync(path);
    return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/** Mirrors TypeScript's system realpath policy: the native implementation
 * canonicalizes Windows casing and expands 8.3 short names, while the JS
 * implementation remains the fallback for Windows paths at the legacy
 * MAX_PATH boundary. */
function systemRealpath(path: string): string {
  return process.platform === "win32" && path.length >= 260
    ? realpathSync(path)
    : realpathSync.native(path);
}

const activeTracker = new AsyncLocalStorage<FrontendInputTracker>();
let synchronousTracker: FrontendInputTracker | undefined;

export class FrontendInputTracker {
  private readonly probes = new Map<string, FrontendInputProbe>();
  private stable = true;
  /** The digests `previous` recorded for files read with a settled identity. */
  private readonly known = new Map<string, { identity: string; digest: string }>();

  /** `previous` is the snapshot of an earlier run whose cache entry is being
   * rebuilt: a file whose settled identity has not changed since then has the
   * content it hashed, so its digest is not computed again. */
  constructor(previous?: FrontendInputSnapshot) {
    for (const probe of previous?.probes ?? [])
      if (probe.op === "file" && probe.identity !== undefined)
        this.known.set(probe.path, { identity: probe.identity, digest: probe.digest });
  }

  /** The digest an earlier run recorded for `path` with this identity. */
  knownDigest(path: string, identity: string): string | undefined {
    const known = this.known.get(path);
    return known?.identity === identity ? known.digest : undefined;
  }

  run<T>(fn: () => T): T {
    const parent = activeTracker.getStore();
    if (parent === undefined || parent === this) return activeTracker.run(this, fn);
    return activeTracker.run(this, () => {
      const result = fn();
      for (const probe of this.probes.values()) parent.record(probe);
      return result;
    });
  }

  /** The native frontend is synchronous; its typed result need not cross an
   * async-context callback boundary. Nested trackers still propagate probes. */
  runSynchronous<T>(fn: () => T): T {
    const parent = synchronousTracker;
    // Install the active tracker so filesystem callbacks can record probes.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    synchronousTracker = this;
    try {
      return fn();
    } finally {
      synchronousTracker = parent;
      if (parent !== undefined && parent !== this) {
        for (const probe of this.probes.values()) parent.record(probe);
        if (!this.stable) parent.markUnstable();
      }
    }
  }

  record(probe: FrontendInputProbe): void {
    const key = `${probe.op}\0${probe.path}`;
    if (probe.op === "text" && this.probes.has(key)) return;
    const previous = this.probes.get(key);
    const merged = previous === undefined ? null : sameFileContent(previous, probe);
    if (
      merged === null &&
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(probe)
    ) {
      // An input changed while this frontend was running.  The build may
      // still finish normally, but it is not safe to publish as a cache key.
      this.stable = false;
    }
    this.probes.set(key, merged ?? probe);
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

  /** Prevent this frontend result from entering a persistent cache.
   *
   * Some host APIs perform semantic filesystem discovery internally and do
   * not expose the candidates they inspected. Callers may still use their
   * exact answer for the current build, but must decline cache publication
   * rather than pretend the observation set is complete. */
  markUnstable(): void {
    this.stable = false;
  }

  snapshot(): FrontendInputSnapshot {
    return {
      version: 1,
      probes: [...this.probes.values()].sort((a, b) =>
        a.path === b.path ? a.op.localeCompare(b.op) : a.path.localeCompare(b.path),
      ),
      stable: this.stable,
    };
  }
}

function record(probe: FrontendInputProbe): void {
  (synchronousTracker ?? activeTracker.getStore())?.record(probe);
}

// Source text the frontend reads raw (call-site text in messages, comptime
// callbacks, line numbers) changes with edits that keep the tokens.
observeSourceText((fileName) => {
  const tracker = synchronousTracker ?? activeTracker.getStore();
  if (tracker !== undefined) tracker.record({ op: "text", path: resolve(fileName) });
});

/** Mark the active frontend as unsafe to persist because an exact host query
 * bypassed the tracked filesystem wrappers. No-op outside a frontend run. */
export function markFrontendInputsUnstable(): void {
  (synchronousTracker ?? activeTracker.getStore())?.markUnstable();
}

/** Compiler-synthesized module sources (a bundle's CommonJS chunks split
 * into sibling modules, npm-static-bundled-chunks.ts). They answer like
 * regular files but are never recorded: each derives from the content of
 * a recorded bundle read, which already keys every cache that sees it. */
const virtualSources = new Map<string, string>();

export function setVirtualSource(path: string, text: string): void {
  virtualSources.set(resolve(path), text);
}

export function isVirtualSource(path: string): boolean {
  return virtualSources.has(resolve(path));
}

export function clearVirtualSources(): void {
  virtualSources.clear();
}

export function trackedReadFile(path: string): string | null {
  path = resolve(path);
  const virtual = virtualSources.get(path);
  if (virtual !== undefined) return virtual;
  try {
    const { text, identity } = readWithIdentity(path);
    const known =
      identity === null
        ? undefined
        : (synchronousTracker ?? activeTracker.getStore())?.knownDigest(path, identity);
    const digest = known ?? frontendSourceDigest(text);
    record(
      identity === null ? { op: "file", path, digest } : { op: "file", path, digest, identity },
    );
    return text;
  } catch {
    record({ op: "read-error", path });
    return null;
  }
}

export function trackedFileExists(path: string): boolean {
  path = resolve(path);
  if (virtualSources.has(path)) return true;
  const kind = pathKind(path);
  record({ op: "kind", path, kind });
  return kind === "file";
}

export function trackedDirectoryExists(path: string): boolean {
  path = resolve(path);
  if (virtualSources.has(path)) return false;
  const kind = pathKind(path);
  record({ op: "kind", path, kind });
  return kind === "directory";
}

export function trackedExists(path: string): boolean {
  path = resolve(path);
  if (virtualSources.has(path)) return true;
  const kind = pathKind(path);
  record({ op: "kind", path, kind });
  return kind !== "missing";
}

export function trackedRealpath(path: string): string | null {
  path = resolve(path);
  if (virtualSources.has(path)) return path;
  try {
    const target = systemRealpath(path);
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
    record({ op: "entries", path, files: [...files], directories });
    for (const virtual of virtualSources.keys()) {
      if (dirname(virtual) === path && !files.includes(basename(virtual)))
        files.push(basename(virtual));
    }
    files.sort();
    return { files, directories };
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
          systemRealpath(probe.path);
          return generatedOnlyDirectory(probe.path);
        } catch {
          return true;
        }
      }
    }
    switch (probe.op) {
      case "file": {
        // An unchanged identity stands for the content hashed with it.
        if (probe.identity !== undefined && fileIdentity(probe.path) === probe.identity)
          return true;
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
          return (
            JSON.stringify(files.filter((name) => !ignored.has(name))) ===
              JSON.stringify(probe.files.filter((name) => !ignored.has(name))) &&
            JSON.stringify(directories.filter((name) => !ignored.has(name))) ===
              JSON.stringify(probe.directories.filter((name) => !ignored.has(name)))
          );
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
          return systemRealpath(probe.path) === probe.target;
        } catch {
          return probe.target === null;
        }
      }
      case "text":
        // The file probe of the same path checks its content.
        return true;
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
  const sourceProbes = new Map<string, Extract<FrontendInputProbe, { op: "file" }>>();
  const rawText = new Set<string>();
  for (const probe of snapshot.probes) {
    if (probe.op === "file") sourceProbes.set(probe.path, probe);
    else if (probe.op === "text") rawText.add(probe.path);
  }
  for (const [path, previous] of previousSources) {
    if (sourceProbes.get(path)?.digest !== frontendSourceDigest(previous)) return null;
  }
  const changed: FrontendSemanticChange[] = [];
  const currentSources = new Map<string, string>();
  const probes: FrontendInputProbe[] = [];
  for (const probe of snapshot.probes) {
    const previous = probe.op === "file" ? previousSources.get(probe.path) : undefined;
    if (probe.op !== "file" || previous === undefined) {
      probes.push(probe);
      continue;
    }
    if (probe.identity !== undefined && fileIdentity(probe.path) === probe.identity) {
      currentSources.set(probe.path, previous);
      probes.push(probe);
      continue;
    }
    let current: string;
    try {
      current = readFileSync(probe.path, "utf8");
    } catch {
      return null;
    }
    const currentDigest = frontendSourceDigest(current);
    currentSources.set(probe.path, current);
    if (currentDigest === probe.digest) {
      probes.push(probe);
      continue;
    }
    // One edit that is not equivalent already rules out the match, and so
    // does any edit of a file whose raw text the frontend read.
    if (rawText.has(probe.path) || !isSemanticEquivalent(probe.path, previous, current))
      return null;
    changed.push({ path: probe.path, previous, current });
    probes.push({ op: "file", path: probe.path, digest: currentDigest });
  }
  const adjusted: FrontendInputSnapshot = { ...snapshot, probes };
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
  const candidate = snapshot as { version?: unknown; stable?: unknown; probes?: unknown };
  if (candidate.version !== 1 || candidate.stable !== true || !Array.isArray(candidate.probes))
    return false;
  return candidate.probes.every((probe) => {
    if (probe === null || typeof probe !== "object") return false;
    const value = probe as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.op !== "string") return false;
    switch (value.op) {
      case "file":
        return (
          typeof value.digest === "string" &&
          /^[0-9a-f]{64}$/.test(value.digest) &&
          (value.identity === undefined || typeof value.identity === "string")
        );
      case "read-error":
        return true;
      case "kind":
        return (
          value.kind === "file" ||
          value.kind === "directory" ||
          value.kind === "other" ||
          value.kind === "missing"
        );
      case "entries":
        return (
          Array.isArray(value.files) &&
          value.files.every((entry) => typeof entry === "string") &&
          Array.isArray(value.directories) &&
          value.directories.every((entry) => typeof entry === "string")
        );
      case "entries-error":
        return true;
      case "realpath":
        return value.target === null || typeof value.target === "string";
      case "text":
        return true;
      default:
        return false;
    }
  });
}
