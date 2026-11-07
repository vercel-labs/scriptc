import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { equivalentSourceEdit, type EquivalentSourceEdit } from "./token-equivalence.js";
import {
  observeSourceText,
  type SourceTextPredicate,
  type SourceTextSpan,
} from "./ts7/ast-node.js";

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
  /** A read of the file's raw bytes (files that need not be text). */
  | { op: "bytes"; path: string; digest: string }
  | { op: "read-error"; path: string }
  | { op: "kind"; path: string; kind: "file" | "directory" | "other" | "missing" }
  | { op: "entries"; path: string; files: string[]; directories: string[] }
  | { op: "entries-error"; path: string }
  | { op: "realpath"; path: string; target: string | null }
  /** The frontend's output depends on the file's raw text or line
   * positions, not only on its tokens (SourceTextObserver): on exactly the
   * answers `reads` names, or on any of the text when `reads` is absent. */
  | { op: "text"; path: string; reads?: SourceTextReads };

/** What the frontend took from one source file's raw text, as questions that
 * can be asked again of an edited version of the file (token-equivalence.ts
 * answers them): the text between pairs of offsets, the line and character
 * of offsets, and predicates with the answers they gave. Offsets are in the
 * text the file probe of the same path digests. A range's two offsets are
 * anchored (SourceTextSpan): each is stored doubled, plus one when it is the
 * start of a token rather than the place the token before it ended. */
export interface SourceTextReads {
  /** Anchored `start, end` pairs, in order. */
  ranges: number[];
  /** Plain offsets. */
  positions: number[];
  facts: SourceTextFact[];
}

/** One predicate's answers: `whole` over the file's text when it was asked
 * that, and the anchored `start, end` pairs of the ranges it held for
 * (`yes`) and did not (`no`). */
export interface SourceTextFact {
  predicate: SourceTextPredicate;
  whole?: boolean;
  yes: number[];
  no: number[];
}

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

type FrontendPathKind = Extract<FrontendInputProbe, { op: "kind" }>["kind"];

/** One file read this compile already performed: its text, the identity it
 * was read with, and the content digest the probe recorded. */
interface CachedRead {
  text: string;
  identity: string | null;
  digest: string;
}

interface CachedListing {
  files: string[];
  directories: string[];
}

function pathKind(path: string): FrontendPathKind {
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

/** Anchored offsets below this bound pack two to a number (packedRange). */
const OFFSET_BOUND = 2 ** 26;

/** One file's SourceTextReads while they are collected. */
class TextReads {
  /** Packed ranges (packedRange). */
  readonly ranges = new Set<number>();
  readonly positions = new Set<number>();
  /** By sourceTextPredicateKey. */
  readonly facts = new Map<string, TextFact>();

  /** Records one answer. False when the predicate already gave the other
   * answer for the same text: the text is not what it was. */
  addFact(predicate: SourceTextPredicate, result: boolean, range: number | null): boolean {
    const key = sourceTextPredicateKey(predicate);
    let fact = this.facts.get(key);
    if (fact === undefined)
      this.facts.set(key, (fact = { predicate, whole: null, yes: new Set(), no: new Set() }));
    if (range === null) {
      if (fact.whole !== null && fact.whole !== result) return false;
      fact.whole = result;
      return true;
    }
    if ((result ? fact.no : fact.yes).has(range)) return false;
    (result ? fact.yes : fact.no).add(range);
    return true;
  }
}

/** One SourceTextFact while it is collected, with packed ranges. */
interface TextFact {
  predicate: SourceTextPredicate;
  whole: boolean | null;
  yes: Set<number>;
  no: Set<number>;
}

/** The range from `start` to `end` with its anchors, as one number. */
function packedRange(start: number, end: number, span: SourceTextSpan): number {
  return (start * 2 + (span & 1)) * OFFSET_BOUND + end * 2 + ((span >> 1) & 1);
}

/** The `start, end` pairs of packed ranges, in order. */
function unpackedRanges(packed: ReadonlySet<number>): number[] {
  const pairs: number[] = [];
  for (const range of [...packed].sort((a, b) => a - b))
    pairs.push(Math.floor(range / OFFSET_BOUND), range % OFFSET_BOUND);
  return pairs;
}

function sourceTextPredicateKey(predicate: SourceTextPredicate): string {
  return predicate.kind === "includes"
    ? `includes\0${predicate.needle}`
    : `matches\0${predicate.flags}\0${predicate.source}`;
}

const activeTracker = new AsyncLocalStorage<FrontendInputTracker>();
let synchronousTracker: FrontendInputTracker | undefined;

export class FrontendInputTracker {
  private readonly probes = new Map<string, FrontendInputProbe>();
  private stable = true;
  /** The digests `previous` recorded for files read with a settled identity. */
  private readonly known = new Map<string, { identity: string; digest: string }>();

  /* One compile's view of the filesystem, keyed by resolved path. The
   * frontend asks the same questions about the same few hundred thousand
   * paths over and over — every load of an npm-static fixpoint resolves each
   * import of every file again, and every resolution stats the same
   * candidate list — and each answer is a syscall. A probe's first answer is
   * kept here and served from memory afterwards.
   *
   * The compile is the cache's lifetime, so a change on disk between two
   * probes of one path is not observed by re-reading it. That is sound
   * because nothing but the compile itself writes while these probes run,
   * and every such write drops the answers it invalidated (forget for one
   * path, forgetAll for a directory tree); tracked filesystem helpers
   * outside the compile have no tracker and are never cached. */
  private readonly kinds = new Map<string, FrontendPathKind>();
  private readonly reads = new Map<string, CachedRead | null>();
  private readonly byteReads = new Map<string, Uint8Array | null>();
  private readonly realpaths = new Map<string, string | null>();
  private readonly listings = new Map<string, CachedListing | null>();

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

  /** `undefined` when this compile has not classified `path` yet. */
  kindFor(path: string): FrontendPathKind | undefined {
    return this.kinds.get(path);
  }

  rememberKind(path: string, kind: FrontendPathKind): void {
    this.kinds.set(path, kind);
  }

  /** `undefined` when this compile has not read `path` yet, `null` for a
   * read that failed. */
  readFor(path: string): CachedRead | null | undefined {
    return this.reads.has(path) ? this.reads.get(path) : undefined;
  }

  rememberRead(path: string, read: CachedRead | null): void {
    this.reads.set(path, read);
  }

  bytesFor(path: string): Uint8Array | null | undefined {
    return this.byteReads.has(path) ? this.byteReads.get(path) : undefined;
  }

  rememberBytes(path: string, bytes: Uint8Array | null): void {
    this.byteReads.set(path, bytes);
  }

  realpathFor(path: string): string | null | undefined {
    return this.realpaths.has(path) ? this.realpaths.get(path) : undefined;
  }

  rememberRealpath(path: string, target: string | null): void {
    this.realpaths.set(path, target);
  }

  listingFor(path: string): CachedListing | null | undefined {
    return this.listings.has(path) ? this.listings.get(path) : undefined;
  }

  rememberListing(path: string, listing: CachedListing | null): void {
    this.listings.set(path, listing);
  }

  /** Drops every answer cached for `path`, and its directory's listing when
   * the path names that directory or an entry in it. */
  forget(path: string): void {
    this.kinds.delete(path);
    this.reads.delete(path);
    this.byteReads.delete(path);
    this.realpaths.delete(path);
    this.listings.delete(path);
    this.listings.delete(dirname(path));
  }

  /** Drops every cached answer: the filesystem changed under this compile. */
  forgetAll(): void {
    this.kinds.clear();
    this.reads.clear();
    this.byteReads.clear();
    this.realpaths.clear();
    this.listings.clear();
  }

  run<T>(fn: () => T): T {
    const parent = activeTracker.getStore();
    if (parent === undefined || parent === this) return activeTracker.run(this, fn);
    return activeTracker.run(this, () => {
      const result = fn();
      for (const probe of this.probes.values()) parent.record(probe);
      for (const probe of this.textProbes()) parent.record(probe);
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
        for (const probe of this.textProbes()) parent.record(probe);
        if (!this.stable) parent.markUnstable();
      }
    }
  }

  /** What was read of each source file's raw text, by resolved path: null
   * when a reader took the whole text. */
  private readonly texts = new Map<string, TextReads | null>();
  /** The resolved path of each file name a text read named. */
  private readonly textPaths = new Map<string, string>();
  /** By resolved path, the text of a syntax tree that is the content this
   * tracker read from the file: offsets into it are offsets into the
   * content the file probe digests. */
  private readonly digestedTexts = new Map<string, string>();

  private textPath(fileName: string): string {
    let path = this.textPaths.get(fileName);
    if (path === undefined) this.textPaths.set(fileName, (path = resolve(fileName)));
    return path;
  }

  /** This tracker's read of `path`, made now: null when it fails, or when
   * the tracker is not the one reads are recorded under. */
  private readSource(path: string): CachedRead | null {
    if (activeFrontendTracker() !== this || virtualSources.has(path)) return null;
    trackedReadSource(path);
    return this.reads.get(path) ?? null;
  }

  /** The file name of the last whole-text read: a scanner that indexes
   * `sourceFile.text` reports one read per character. */
  private lastWholeText: string | undefined;

  /** Records a read of a source file's whole text. */
  noteText(fileName: string): void {
    if (fileName === this.lastWholeText) return;
    this.lastWholeText = fileName;
    this.texts.set(this.textPath(fileName), null);
  }

  /** Records that a reader other than the parser took the content of `path`
   * (trackedReadFile). */
  noteRawRead(path: string): void {
    this.texts.set(path, null);
  }

  /** The precise reads of the file `text` is the content of, or null when
   * its whole text counts as read: a reader took all of it, or `text` is
   * not the content this tracker read from the file (a rewritten or
   * synthesized source, a read made under another tracker), so offsets into
   * it and predicates over it say nothing about the file. */
  private preciseReads(fileName: string, text: string): TextReads | null {
    const path = this.textPath(fileName);
    let reads = this.texts.get(path);
    if (reads === null) return null;
    if (this.digestedTexts.get(path) !== text) {
      // A syntax tree another process parsed (the shared checker server) is
      // of a file this tracker may not have read yet: read it now, which
      // records its content like any other read.
      const read = this.reads.has(path) ? this.reads.get(path) : this.readSource(path);
      if (read?.text !== text) {
        this.texts.set(path, null);
        return null;
      }
      this.digestedTexts.set(path, text);
    }
    if (reads === undefined) this.texts.set(path, (reads = new TextReads()));
    return reads;
  }

  /** Whether `start` and `end` name a range of `text` that packs. */
  private static validRange(text: string, start: number, end: number): boolean {
    return start >= 0 && start <= end && end <= text.length && end * 2 + 1 < OFFSET_BOUND;
  }

  /** Records a read of `text` from `start` to `end`. */
  noteTextRange(
    fileName: string,
    text: string,
    start: number,
    end: number,
    span: SourceTextSpan,
  ): void {
    const reads = this.preciseReads(fileName, text);
    if (reads === null) return;
    if (!FrontendInputTracker.validRange(text, start, end)) this.noteText(fileName);
    else reads.ranges.add(packedRange(start, end, span));
  }

  /** Records a read of the line and character of `position` in `text`. */
  noteTextPosition(fileName: string, text: string, position: number): void {
    const reads = this.preciseReads(fileName, text);
    if (reads === null) return;
    if (!(position >= 0 && position <= text.length && position < OFFSET_BOUND))
      this.noteText(fileName);
    else reads.positions.add(position);
  }

  /** Records a predicate's answer over `text`, or over its range from
   * `start` to `end` when `start` is not negative. */
  noteTextFact(
    fileName: string,
    text: string,
    predicate: SourceTextPredicate,
    result: boolean,
    start: number,
    end: number,
    span: SourceTextSpan,
  ): void {
    const reads = this.preciseReads(fileName, text);
    if (reads === null) return;
    if (start >= 0 && !FrontendInputTracker.validRange(text, start, end)) this.noteText(fileName);
    else if (!reads.addFact(predicate, result, start < 0 ? null : packedRange(start, end, span)))
      this.noteText(fileName);
  }

  /** The text probes of this tracker's reads, one per file. */
  private textProbes(): FrontendInputProbe[] {
    const probes: FrontendInputProbe[] = [];
    for (const [path, reads] of this.texts) {
      if (reads === null) {
        probes.push({ op: "text", path });
        continue;
      }
      probes.push({
        op: "text",
        path,
        reads: {
          ranges: unpackedRanges(reads.ranges),
          positions: [...reads.positions].sort((a, b) => a - b),
          facts: [...reads.facts.keys()].sort().map((key) => {
            const fact = reads.facts.get(key)!;
            return {
              predicate: fact.predicate,
              ...(fact.whole === null ? {} : { whole: fact.whole }),
              yes: unpackedRanges(fact.yes),
              no: unpackedRanges(fact.no),
            };
          }),
        },
      });
    }
    return probes;
  }

  /** Joins another tracker's text probe of a file with this one's reads. */
  private recordText(probe: Extract<FrontendInputProbe, { op: "text" }>): void {
    const current = this.texts.get(probe.path);
    if (current === null) return;
    if (probe.reads === undefined) {
      this.texts.set(probe.path, null);
      return;
    }
    const reads = current ?? new TextReads();
    if (current === undefined) this.texts.set(probe.path, reads);
    const { ranges, positions, facts } = probe.reads;
    for (let index = 0; index + 1 < ranges.length; index += 2)
      reads.ranges.add(ranges[index]! * OFFSET_BOUND + ranges[index + 1]!);
    for (const position of positions) reads.positions.add(position);
    let consistent = true;
    for (const fact of facts) {
      if (fact.whole !== undefined && !reads.addFact(fact.predicate, fact.whole, null))
        consistent = false;
      for (const [list, result] of [
        [fact.yes, true],
        [fact.no, false],
      ] as const)
        for (let index = 0; index + 1 < list.length; index += 2)
          if (
            !reads.addFact(fact.predicate, result, list[index]! * OFFSET_BOUND + list[index + 1]!)
          )
            consistent = false;
    }
    if (!consistent) this.texts.set(probe.path, null);
  }

  record(probe: FrontendInputProbe): void {
    if (probe.op === "text") {
      this.recordText(probe);
      return;
    }
    const key = `${probe.op}\0${probe.path}`;
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
      probes: [...this.probes.values(), ...this.textProbes()].sort((a, b) =>
        a.path === b.path ? a.op.localeCompare(b.op) : a.path.localeCompare(b.path),
      ),
      stable: this.stable,
    };
  }
}

function record(probe: FrontendInputProbe): void {
  activeFrontendTracker()?.record(probe);
}

/** The tracker this thread's frontend runs under, if any: the synchronous
 * one the native frontend installs, else the async-context one. */
function activeFrontendTracker(): FrontendInputTracker | undefined {
  return synchronousTracker ?? activeTracker.getStore();
}

/** `path`'s kind, from this compile's answers when it already asked. */
function kindOf(path: string, tracked: boolean): FrontendPathKind {
  const tracker = activeFrontendTracker();
  const cached = tracker?.kindFor(path);
  if (cached !== undefined) return cached;
  const kind = pathKind(path);
  tracker?.rememberKind(path, kind);
  if (tracked) record({ op: "kind", path, kind });
  return kind;
}

/** Drops the running frontend's cached answer for `path` after the compile
 * itself wrote it (a generated source, a cache file): the next probe reads
 * the filesystem again. No-op outside a frontend run. */
export function invalidateTrackedPath(path: string): void {
  activeFrontendTracker()?.forget(resolve(path));
}

/** Drops every cached answer after the compile wrote files it may later probe.
 * Prefer `invalidateTrackedPath`; this is for writers that do not know which
 * paths they touched (a tarball extraction, a store compaction). No-op
 * outside a frontend run. */
export function invalidateTrackedFilesystem(): void {
  activeFrontendTracker()?.forgetAll();
}

// Source text the frontend reads raw (call-site text in messages, comptime
// callbacks, line numbers) changes with edits that keep the tokens.
observeSourceText({
  whole(fileName) {
    activeFrontendTracker()?.noteText(fileName);
  },
  range(fileName, text, start, end, span) {
    activeFrontendTracker()?.noteTextRange(fileName, text, start, end, span);
  },
  position(fileName, text, position) {
    activeFrontendTracker()?.noteTextPosition(fileName, text, position);
  },
  fact(fileName, text, predicate, result, start, end, span) {
    activeFrontendTracker()?.noteTextFact(fileName, text, predicate, result, start, end, span);
  },
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
  path = resolve(path);
  virtualSources.set(path, text);
  // A virtual source answers for a path the compile may have probed as a
  // real file (or as missing) before it was registered.
  activeFrontendTracker()?.forget(path);
}

export function isVirtualSource(path: string): boolean {
  return virtualSources.has(resolve(path));
}

export function clearVirtualSources(): void {
  // Each registration already dropped the real answer for its path, so a
  // probe after this one asks the filesystem again; the compile's other
  // answers are about paths the shadow never named.
  virtualSources.clear();
}

/** The content of `path` for a reader that inspects it: the read pins the
 * whole content (a `text` probe), so no edit of the file is taken for an
 * equivalent one. The parser's read is trackedReadSource. */
export function trackedReadFile(path: string): string | null {
  path = resolve(path);
  const text = trackedReadSource(path);
  if (text !== null && !virtualSources.has(path)) activeFrontendTracker()?.noteRawRead(path);
  return text;
}

/** Records that a reader took the whole content of `path` by a way that is
 * not a tracked read (the text a program host serves). */
export function trackedWholeText(path: string): void {
  activeFrontendTracker()?.noteRawRead(resolve(path));
}

/** The content of `path` for the parser, which takes its tokens: whatever
 * else the frontend reads of the text is reported from the syntax tree
 * (SourceTextObserver). */
export function trackedReadSource(path: string): string | null {
  path = resolve(path);
  const virtual = virtualSources.get(path);
  if (virtual !== undefined) return virtual;
  const tracker = activeFrontendTracker();
  const cached = tracker?.readFor(path);
  // A read of a file that had changed too shortly before it has no identity,
  // and a later read of the same bytes is what records one: the compile has
  // to look again for that, so only reads whose identity stands for their
  // content are served from here.
  if (cached !== undefined && (cached === null || cached.identity !== null))
    return cached === null ? null : cached.text;
  try {
    const { text, identity } = readWithIdentity(path);
    const known = identity === null ? undefined : tracker?.knownDigest(path, identity);
    const digest = known ?? frontendSourceDigest(text);
    tracker?.rememberRead(path, { text, identity, digest });
    record(
      identity === null ? { op: "file", path, digest } : { op: "file", path, digest, identity },
    );
    return text;
  } catch {
    tracker?.rememberRead(path, null);
    record({ op: "read-error", path });
    return null;
  }
}

/** A file's raw bytes, recorded by their digest. */
export function trackedReadBytes(path: string): Uint8Array | null {
  path = resolve(path);
  const virtual = virtualSources.get(path);
  if (virtual !== undefined) return new TextEncoder().encode(virtual);
  const tracker = activeFrontendTracker();
  const cached = tracker?.bytesFor(path);
  if (cached !== undefined) return cached;
  try {
    const bytes = new Uint8Array(readFileSync(path));
    tracker?.rememberBytes(path, bytes);
    record({ op: "bytes", path, digest: createHash("sha256").update(bytes).digest("hex") });
    return bytes;
  } catch {
    tracker?.rememberBytes(path, null);
    record({ op: "read-error", path });
    return null;
  }
}

export function trackedFileExists(path: string): boolean {
  path = resolve(path);
  if (virtualSources.has(path)) return true;
  return kindOf(path, true) === "file";
}

export function trackedDirectoryExists(path: string): boolean {
  path = resolve(path);
  if (virtualSources.has(path)) return false;
  return kindOf(path, true) === "directory";
}

export function trackedExists(path: string): boolean {
  path = resolve(path);
  if (virtualSources.has(path)) return true;
  return kindOf(path, true) !== "missing";
}

export function trackedRealpath(path: string): string | null {
  path = resolve(path);
  if (virtualSources.has(path)) return path;
  const tracker = activeFrontendTracker();
  const cached = tracker?.realpathFor(path);
  if (cached !== undefined) return cached;
  try {
    const target = systemRealpath(path);
    tracker?.rememberRealpath(path, target);
    record({ op: "realpath", path, target });
    return target;
  } catch {
    tracker?.rememberRealpath(path, null);
    record({ op: "realpath", path, target: null });
    return null;
  }
}

export function trackedAccessibleEntries(
  path: string,
): { files: string[]; directories: string[] } | null {
  path = resolve(path);
  const tracker = activeFrontendTracker();
  const cached = tracker?.listingFor(path);
  let files: string[];
  let directories: string[];
  if (cached === undefined) {
    try {
      files = [];
      directories = [];
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const kind = entry.isSymbolicLink() ? kindOf(resolve(path, entry.name), false) : null;
        if (entry.isFile() || kind === "file") files.push(entry.name);
        if (entry.isDirectory() || kind === "directory") directories.push(entry.name);
      }
      files.sort();
      directories.sort();
      record({ op: "entries", path, files: [...files], directories });
      tracker?.rememberListing(path, { files: [...files], directories: [...directories] });
    } catch {
      // Enumeration can fail even while the path remains a directory. Preserve
      // the failed operation itself so a permission/ACL repair invalidates the
      // cached frontend rather than replaying only the unchanged path kind.
      tracker?.rememberListing(path, null);
      record({ op: "entries-error", path });
      return null;
    }
  } else if (cached === null) {
    return null;
  } else {
    files = [...cached.files];
    directories = [...cached.directories];
  }
  // The shadow's sources are not part of the disk listing, so they are added
  // to every answer, cached or fresh, and to the caller's own arrays.
  for (const virtual of virtualSources.keys()) {
    if (dirname(virtual) === path && !files.includes(basename(virtual)))
      files.push(basename(virtual));
  }
  files.sort();
  return { files, directories };
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
      case "bytes": {
        try {
          return (
            createHash("sha256").update(readFileSync(probe.path)).digest("hex") === probe.digest
          );
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
 * cache payload; every unchanged input remains content-hash checked. An
 * edited source must be one the entry holds as it was read from the file.
 * Whatever the caller's notion of an equivalent edit, the edit must also
 * leave unchanged what the frontend read of the file's raw text (its `text`
 * probe): every recorded read is replayed over the current text
 * (equivalentSourceEdit), and a file whose whole text was read admits no
 * edit. The returned snapshot holds the reads of an edited file as reads of
 * its current text, so the entry it refreshes can be compared with a later
 * edit.
 */
export function frontendInputsSemanticallyMatch(
  snapshot: FrontendInputSnapshot,
  previousSources: ReadonlyMap<string, string>,
  isSemanticEquivalent: (path: string, previous: string, current: string) => boolean,
  exclusions: FrontendInputExclusions = {},
  /** Receives the first source that rules the match out, and why: no probe
   * read it, the build compiled a rewritten form of it, or its edit is not
   * equivalent. */
  refused?: (path: string, why: "unread" | "rewritten" | "edit") => void,
): FrontendSemanticMatch | null {
  if (!validFrontendInputSnapshot(snapshot)) return null;
  const sourceProbes = new Map<string, Extract<FrontendInputProbe, { op: "file" }>>();
  // Null for a file whose whole text was read.
  const rawText = new Map<string, SourceTextReads | null>();
  for (const probe of snapshot.probes) {
    if (probe.op === "file") sourceProbes.set(probe.path, probe);
    else if (probe.op === "text") {
      // Two probes of one file never come from one tracker; read them as the whole text.
      rawText.set(probe.path, rawText.has(probe.path) ? null : (probe.reads ?? null));
    }
  }
  // A source no probe read came from somewhere this snapshot cannot check.
  for (const path of previousSources.keys()) {
    if (!sourceProbes.has(path)) {
      refused?.(path, "unread");
      return null;
    }
  }
  const changed: FrontendSemanticChange[] = [];
  // By edited file with recorded reads: the reads over its current text.
  const carriedReads = new Map<string, SourceTextReads>();
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
    if (currentDigest === probe.digest) {
      // Unchanged: the entry's source stays, rewritten or not.
      currentSources.set(probe.path, previous);
      probes.push(probe);
      continue;
    }
    currentSources.set(probe.path, current);
    // The edit is compared with the content the entry was built from. A
    // source the build compiled in a rewritten form (an overlay, a package
    // rewrite) is not that content, and its edit cannot be compared.
    if (frontendSourceDigest(previous) !== probe.digest) {
      refused?.(probe.path, "rewritten");
      return null;
    }
    // One edit that is not equivalent already rules out the match, and so
    // does any edit of a file whose whole raw text the frontend read.
    const reads = rawText.get(probe.path);
    const carried =
      reads === null || !isSemanticEquivalent(probe.path, previous, current)
        ? null
        : reads === undefined
          ? NO_READS
          : equivalentSourceEdit(probe.path, previous, current, false, reads);
    if (carried === null) {
      refused?.(probe.path, "edit");
      return null;
    }
    if (carried.reads !== undefined) carriedReads.set(probe.path, carried.reads);
    changed.push({ path: probe.path, previous, current });
    probes.push({ op: "file", path: probe.path, digest: currentDigest });
  }
  // The reads of an edited file are offsets into its previous text.
  const adjusted: FrontendInputSnapshot = {
    ...snapshot,
    probes: probes.map((probe) => {
      const reads = probe.op === "text" ? carriedReads.get(probe.path) : undefined;
      return reads === undefined ? probe : { op: "text", path: probe.path, reads };
    }),
  };
  if (!frontendInputsStillMatch(adjusted, exclusions)) return null;
  return { changed, currentSources, snapshot: adjusted };
}

function validSourceTextReads(value: unknown): value is SourceTextReads {
  if (value === null || typeof value !== "object") return false;
  const reads = value as { ranges?: unknown; positions?: unknown; facts?: unknown };
  const offsets = (list: unknown): list is number[] =>
    Array.isArray(list) &&
    list.every((offset) => Number.isSafeInteger(offset) && offset >= 0 && offset < OFFSET_BOUND);
  const pairs = (list: unknown): boolean => offsets(list) && list.length % 2 === 0;
  return (
    pairs(reads.ranges) &&
    offsets(reads.positions) &&
    Array.isArray(reads.facts) &&
    reads.facts.every((fact: unknown) => {
      if (fact === null || typeof fact !== "object") return false;
      const entry = fact as Record<string, unknown>;
      const predicate = entry.predicate as Record<string, unknown> | null | undefined;
      if (predicate === null || typeof predicate !== "object") return false;
      const known =
        predicate.kind === "includes"
          ? typeof predicate.needle === "string"
          : predicate.kind === "matches" &&
            typeof predicate.source === "string" &&
            typeof predicate.flags === "string" &&
            // A stateful pattern answers differently when asked again.
            !/[gy]/.test(predicate.flags);
      return (
        known &&
        (entry.whole === undefined || typeof entry.whole === "boolean") &&
        pairs(entry.yes) &&
        pairs(entry.no)
      );
    })
  );
}

/** The edit of a file with no recorded reads. */
const NO_READS: EquivalentSourceEdit = { reads: undefined };

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
      case "bytes":
        return typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest);
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
        return value.reads === undefined || validSourceTextReads(value.reads);
      default:
        return false;
    }
  });
}
