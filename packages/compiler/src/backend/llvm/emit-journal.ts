/* Chunked function emission (emit-module.ts). An emitter that emits one
 * contiguous range of a module's functions records here the helpers and
 * sites it numbers from a counter (`sc_td_${size}` and the like). The
 * emitter that merges the ranges replays each range's records in order:
 * replay calls the same entry point with the same arguments, so every
 * helper gets the number and the definition the serial emission gives it,
 * and the range's text is renamed to those numbers. */
import type { DebugRequest } from "./debug-info.js";
import type { LlEmitter } from "./emitter.js";

/** One event of a range's emission, in order. */
export type JournalEntry =
  /** A helper or site the range's emitter numbered: the name it gave it
   * (a counter prefix and a number), and the replay entry point
   * (registerReplay) with its arguments, which are plain IR values. */
  | {
      readonly kind: "op";
      readonly name: string;
      readonly op: string;
      readonly args: readonly unknown[];
    }
  /** The first request of a key of a module-level table made outside any
   * replayable definition, with the value the range's emitter stored. */
  | {
      readonly kind: "entry";
      readonly table: string;
      readonly key: string;
      readonly value: unknown;
    };

export class EmitJournal {
  readonly entries: JournalEntry[] = [];
  /** The replayable definitions being built, innermost last. */
  private readonly open: string[] = [];

  /** The definitions still open (empty between functions). */
  get unclosed(): readonly string[] {
    return this.open;
  }
  /** Keys already recorded per table. */
  private readonly recorded = new Map<string, Set<string>>();

  /** A keyed helper, recorded when its number is taken, before anything its
   * definition creates in turn: that keeps the serial numbering order.
   * Replaying a helper that exists answers its name, so helpers created
   * inside another helper's definition are recorded too. Opens the
   * definition, which the creating entry point closes with `built`. */
  allocated(name: string, op: string, args: readonly unknown[]): void {
    this.entries.push({ kind: "op", name, op, args });
    this.open.push(op);
  }

  /** Opens a definition whose helper is not replayed itself (its
   * entry point records the request with `used`). */
  opened(op: string): void {
    this.open.push(op);
  }

  /** A request, made outside any definition, of the helper `name` that an
   * entry point answered; recorded once per name. Replay makes the same
   * request. */
  used(name: string, op: string, args: readonly unknown[]): void {
    if (this.open.length !== 0) return;
    if (this.usedNames.has(name)) return;
    this.usedNames.add(name);
    this.entries.push({ kind: "op", name, op, args });
  }
  private readonly usedNames = new Set<string>();

  /** Closes the definition `allocated` or `opened` opened. */
  built(): void {
    if (this.open.pop() === undefined) this.overclosed = true;
  }

  /** A `built` closed a definition no `allocated` opened. */
  overclosed = false;

  /** An unkeyed site (one per use). Sites taken while a definition is built
   * are taken again when the merging emitter replays that definition. */
  site(name: string, op: string, args: readonly unknown[] = []): void {
    if (this.open.length === 0) this.entries.push({ kind: "op", name, op, args });
  }

  /** A request of `key` in a module-level table. Only the first request
   * made outside any definition is recorded: requests made while a
   * definition is built happen again when it is replayed. */
  entry(table: string, key: string, value: unknown): void {
    if (this.open.length !== 0) return;
    let keys = this.recorded.get(table);
    if (keys === undefined) this.recorded.set(table, (keys = new Set()));
    if (keys.has(key)) return;
    keys.add(key);
    this.entries.push({ kind: "entry", table, key, value });
  }
}

/** A range emitter's result (LlEmitter.chunkResult): plain data, so a
 * worker process can write it. */
export interface ChunkResult {
  readonly entries: readonly JournalEntry[];
  /** The requests that added debug metadata nodes (LlvmDebugInfo.record). */
  readonly debugRequests: readonly DebugRequest[];
  readonly flags: {
    readonly usesCoroutines: boolean;
    readonly usesTimers: boolean;
    readonly usesGenSlots: boolean;
    readonly needsUnionNone: boolean;
    readonly needsNullableAbsent: boolean;
    readonly needsOom: boolean;
    readonly needsBadTag: boolean;
    readonly needsBadKey: boolean;
    readonly needsRetainBox: boolean;
  };
  readonly publishedNamesSym: string | null;
  readonly rcHelpers: readonly string[];
  readonly immortalValues: readonly string[];
  readonly fnValues: readonly string[];
  readonly arraySearchKinds: readonly string[];
  readonly recordCloneShapes: readonly string[];
  readonly awaitCallees: readonly string[];
  readonly adoptCallees: readonly string[];
  readonly directAwaitCallees: readonly string[];
  readonly inlineAwaitCallees: readonly string[];
}

type Replay = (emitter: LlEmitter, args: readonly unknown[]) => string;
const replays = new Map<string, Replay>();

/** Registers the entry point that creates (or finds) a numbered helper or
 * site from its recorded arguments and answers its name. */
export function registerReplay(op: string, replay: Replay): void {
  replays.set(op, replay);
}

/** Replays a range's entries on the merging emitter, in record order, and
 * records the renames from the range's names to its own in `names`. */
export function replayJournal(
  emitter: LlEmitter,
  entries: readonly JournalEntry[],
  names: Map<string, string>,
  tags: Map<number, number>,
): void {
  for (const entry of entries) {
    if (entry.kind === "entry") {
      emitter.applyJournalEntry(entry.table, entry.key, entry.value, names, tags);
      continue;
    }
    const replay = replays.get(entry.op);
    if (replay === undefined)
      throw new Error(`llvm emitter bug: no replay for journal entry ${entry.op}`);
    const own = stripSigil(replay(emitter, entry.args));
    const local = stripSigil(entry.name);
    if (own !== local) names.set(local, own);
  }
}

/** The rename of a range's text: numbered names (`names`, without the
 * sigil), field alias tags (`tags`) and debug metadata ids (`debugIds`,
 * `!N`). One scan for each kind of name: a numbered name starts `sc_`
 * after a character that cannot be part of a name, and ends at the last
 * digit after its counter prefix. */
export function renameChunk(
  names: ReadonlyMap<string, string>,
  tags: ReadonlyMap<number, number>,
  debugIds: ReadonlyMap<string, string> = new Map(),
): (text: string) => string {
  const prefixes = new Set<string>();
  for (const name of names.keys()) prefixes.add(name.replace(/\d+$/, ""));
  if (prefixes.size === 0 && tags.size === 0 && debugIds.size === 0) return (text) => text;
  return (text) => {
    let out = prefixes.size === 0 ? text : renameNames(text, names, prefixes);
    if (tags.size > 0) out = renameTags(out, tags);
    if (debugIds.size > 0) out = renameDebugIds(out, debugIds);
    return out;
  };
}

/** Renames metadata references `!N` outside string literals and comments.
 * Debug builds attach no alias tags, so every such reference in a
 * function's text is a debug metadata id. A string literal or a comment
 * (`;` outside a string literal) ends at the end of its line; a quote
 * inside a string literal is escaped (`\22`). */
function renameDebugIds(text: string, ids: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  let copied = 0;
  // The line of the reference being looked at, and whether the reference
  // is inside a string literal or a comment there. The next quote and
  // semicolon positions only move forward, so each is found once.
  let lineEnd = -1;
  let quoted = false;
  let comment = false;
  let quote = text.indexOf('"');
  let semicolon = text.indexOf(";");
  for (let at = text.indexOf("!"); at >= 0; at = text.indexOf("!", at + 1)) {
    if (at > lineEnd) {
      lineEnd = text.indexOf("\n", at);
      if (lineEnd < 0) lineEnd = text.length;
      quoted = false;
      comment = false;
      // Quotes and semicolons of earlier lines end with them.
      if ((quote >= 0 && quote < at) || (semicolon >= 0 && semicolon < at)) {
        const lineStart = text.lastIndexOf("\n", at) + 1;
        while (quote >= 0 && quote < lineStart) quote = text.indexOf('"', quote + 1);
        while (semicolon >= 0 && semicolon < lineStart)
          semicolon = text.indexOf(";", semicolon + 1);
      }
    }
    while (!comment) {
      const nextQuote = quote >= 0 && quote < at ? quote : -1;
      const nextSemicolon = semicolon >= 0 && semicolon < at ? semicolon : -1;
      if (nextQuote < 0 && nextSemicolon < 0) break;
      if (nextQuote >= 0 && (nextSemicolon < 0 || nextQuote < nextSemicolon)) {
        quoted = !quoted;
        quote = text.indexOf('"', quote + 1);
      } else {
        if (!quoted) comment = true;
        semicolon = text.indexOf(";", semicolon + 1);
      }
    }
    if (quoted || comment) continue;
    if (at > 0 && isNameChar(text.charCodeAt(at - 1))) continue;
    let end = at + 1;
    while (end < text.length && isDigit(text.charCodeAt(end))) end++;
    if (end === at + 1 || (end < text.length && isNameChar(text.charCodeAt(end)))) continue;
    const own = ids.get(text.slice(at, end));
    if (own === undefined) continue;
    parts.push(text.slice(copied, at), own);
    copied = end;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

function renameNames(
  text: string,
  names: ReadonlyMap<string, string>,
  prefixes: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  let copied = 0;
  for (let at = text.indexOf("sc_"); at >= 0; at = text.indexOf("sc_", at + 3)) {
    if (at > 0 && isNameChar(text.charCodeAt(at - 1))) continue;
    // The counter prefix ends where the digits start; the number ends at
    // the last digit.
    let end = at + 3;
    while (end < text.length && isNameChar(text.charCodeAt(end)) && !isDigit(text.charCodeAt(end)))
      end++;
    if (end === text.length || !isDigit(text.charCodeAt(end))) continue;
    if (!prefixes.has(text.slice(at, end))) continue;
    let last = end;
    while (last < text.length && isDigit(text.charCodeAt(last))) last++;
    const own = names.get(text.slice(at, last));
    if (own === undefined) continue;
    parts.push(text.slice(copied, at), own);
    copied = last;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

function renameTags(text: string, tags: ReadonlyMap<number, number>): string {
  const marker = "!tbaa !";
  const parts: string[] = [];
  let copied = 0;
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
    const start = at + marker.length;
    let end = start;
    while (end < text.length && isDigit(text.charCodeAt(end))) end++;
    const own = tags.get(Number(text.slice(start, end)));
    if (own === undefined) continue;
    parts.push(text.slice(copied, start), String(own));
    copied = end;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

/** `[-$._A-Za-z0-9]`: a character of an LLVM identifier. */
function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code === 45 ||
    code === 46
  );
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function stripSigil(name: string): string {
  return name.startsWith("@") ? name.slice(1) : name;
}
