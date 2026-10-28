/** Native-library LLVM IR sharding.
 *
 * The public `.ll` remains the emitter's single canonical module. Native dev
 * builds may compile this equivalent set of smaller modules in parallel, then
 * relocatably merge their objects before archive assembly:
 *
 * - the first shard owns every module-scope global and the first function
 *   group; later shards own only function groups;
 * - the shared preamble carries types and declarations into every shard;
 * - generated internal functions/globals are promoted to hidden linkage so
 *   references can cross object files; the post-compile relocatable link turns
 *   those hidden definitions back into local symbols on every supported object
 *   format;
 * - declarations synthesized from definitions make every shard independently
 *   valid LLVM IR without changing call signatures.
 *
 * The splitter deliberately accepts only the narrow grammar scriptc emits.
 * An unexpected top-level form returns null and the caller compiles the
 * canonical TU normally — cache optimization must never become correctness.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface LlvmProgramShard {
  /** Stable source identity used in object cache keys and diagnostics. */
  name: string;
  /** Assembles the shard's LLVM text. A module split from a file reads its
   * function bodies back from there on each call, so only the shards being
   * written are in memory. */
  source: () => string;
}

export interface LlvmProgramSplit {
  shards: LlvmProgramShard[];
  /** Generated definitions promoted for shard linkage. The relocatable merge
   * must demote these while retaining the canonical public definitions. */
  promotedSymbols: string[];
  /** Canonical non-internal definitions that must stay externally visible
   * after the shard objects are relocatably merged. */
  publicSymbols: string[];
}

export interface LlvmProgramSplitOptions {
  /** Desired maximum source size per function shard. */
  targetBytes?: number;
  /** Inputs smaller than this keep the single-TU path. */
  minimumBytes?: number;
}

const DEFAULT_TARGET_BYTES = 2 * 1024 * 1024;
const DEFAULT_MINIMUM_BYTES = 4 * 1024 * 1024;
// Library edits pay a relocatable merge/archive cost after shard compilation,
// but their stable per-bucket object cache starts winning earlier than the
// executable lane's whole-program posture. Node 24 Linux profiling across
// 1.62–3.24MB generated modules found the crossover at roughly 2MB; four
// function buckets were the best general tradeoff for the 2.15MB target and
// remained profitable through 3.24MB. Executables retain the defaults above.
const LIBRARY_TARGET_BYTES = 768 * 1024;
const LIBRARY_MINIMUM_BYTES = 2 * 1024 * 1024;

interface FunctionDef {
  /** UTF-8 length of the definition's text. */
  bytes: number;
  /** The definition's text: its header (promoted to hidden linkage when
   * internal), body and closing brace. A definition left in a file reads
   * its body through `read`. */
  text: (read: RangeReader) => string;
  declaration: string;
  symbol: string;
  promoted: boolean;
}

/** Reads the text between two byte offsets of the module file. */
type RangeReader = (start: number, end: number) => string;

interface GlobalDef {
  line: string;
  declaration: string | null;
  symbol: string;
  promoted: boolean;
}

function symbolOf(spelling: string): string | null {
  const match = /^@([-$._A-Za-z][-$.\w]*)$/.exec(spelling);
  return match?.[1] ?? null;
}

/** A definition's header line: the line its shard compiles, the
 * declaration every other shard carries, and its linkage. */
function functionHeader(
  header: string,
): { line: string; declaration: string; symbol: string; promoted: boolean } | null {
  const match =
    /^define\s+(internal\s+)?(.+?)\s+(@[-$._A-Za-z][-$.\w]*)\((.*)\)(.*)\{(?:\s*;.*)?$/.exec(
      header,
    );
  if (!match) return null;
  const symbol = symbolOf(match[3]!);
  if (symbol === null) return null;
  const promoted = match[1] !== undefined;
  const linkage = promoted ? "hidden " : "";
  const line = promoted ? header.replace(/^define internal /, "define hidden ") : header;
  // Parameter names are legal on declarations. Preserve the emitted text so
  // attributes, zeroext, and varargs stay byte-exact.
  // A definition's DISubprogram cannot be attached to a declaration in a
  // different shard. Its owning definition retains the original metadata.
  // A personality routine belongs to a definition too: LLVM rejects it on a
  // declaration, which would fail every shard that calls a function with
  // landing pads (Linux unwinding) and fall back to the single-TU compile.
  const attrs = match[5]!
    .replace(/\s+!dbg !\d+/g, "")
    .replace(/\s+personality\s+ptr\s+@[-$._A-Za-z][-$.\w]*/g, "");
  const declaration = `declare ${linkage}${match[2]} ${match[3]}(${match[4]})${attrs}`.trimEnd();
  return { line, declaration, symbol, promoted };
}

function functionDefAt(
  lines: readonly string[],
  start: number,
): { def: FunctionDef; end: number } | null {
  const header = functionHeader(lines[start]!);
  if (header === null) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "}") end++;
  if (end >= lines.length) return null;
  const source = [header.line, ...lines.slice(start + 1, end + 1)].join("\n");
  return {
    def: {
      bytes: Buffer.byteLength(source),
      text: () => source,
      declaration: header.declaration,
      symbol: header.symbol,
      promoted: header.promoted,
    },
    end,
  };
}

function globalDef(line: string): GlobalDef | null {
  const match =
    /^(@[-$._A-Za-z][-$.\w]*)\s+=\s+((?:internal|private)\s+)?(thread_local(?:\([^)]*\))?\s+)?((?:local_)?unnamed_addr\s+)?(global|constant)\s+([\s\S]+)$/.exec(
      line,
    );
  if (!match) return null;
  const symbol = symbolOf(match[1]!);
  if (symbol === null) return null;
  // Internal and private definitions (such as private unnamed_addr lookup
  // tables) are local to their module: shards reach them as hidden ones.
  const promoted = match[2] !== undefined;
  const threadLocal = match[3] === undefined ? "" : `${match[3].trim()} `;
  // The declaration needs only the complete type. Emitted initializers begin
  // after it; the generated LLVM subset uses first-class scalars/pointers or
  // balanced aggregate types, so one small scanner is sufficient.
  const rest = match[6]!;
  let depth = 0;
  let quote = false;
  let typeEnd = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === '"' && rest[i - 1] !== "\\") quote = !quote;
    if (quote) continue;
    if (ch === "{" || ch === "[" || ch === "<" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ">" || ch === ")") depth--;
    else if (ch === " " && depth === 0) {
      typeEnd = i;
      break;
    }
  }
  if (typeEnd < 0) return null;
  const type = rest.slice(0, typeEnd);
  return {
    line: promoted ? line.replace(`${match[1]} = ${match[2]}`, `${match[1]} = hidden `) : line,
    declaration: `${match[1]} = external ${promoted ? "hidden " : ""}${threadLocal}${match[5]} ${type}`,
    symbol,
    promoted,
  };
}

/** The change in aggregate nesting depth over one line of LLVM text,
 * outside string constants and comments (a regex global's comment spells
 * its source). */
function bracketDepth(line: string): number {
  let depth = 0;
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') quote = !quote;
    if (quote) continue;
    if (ch === ";") break;
    if (ch === "{" || ch === "[" || ch === "<" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ">" || ch === ")") depth--;
  }
  return depth;
}

function stableBucket(symbol: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < symbol.length; i++) {
    hash ^= symbol.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
}

function chunksOf(
  functions: readonly FunctionDef[],
  targetBytes: number,
  maximumBuckets: number,
): { bucket: number; functions: FunctionDef[] }[] {
  const totalBytes = functions.reduce((sum, fn) => sum + fn.bytes + 2, 0);
  // A power-of-two bucket count changes only when the program crosses a wide
  // size band. Ordinary edits therefore keep every function in the same
  // symbol-hash bucket; ceil(total/target) would reshuffle the whole program
  // whenever a small edit happened to add the next bucket.
  const required = Math.max(2, Math.ceil(totalBytes / targetBytes));
  const count = Math.min(maximumBuckets, 2 ** Math.ceil(Math.log2(required)));
  const chunks = Array.from({ length: count }, (): FunctionDef[] => []);
  for (const fn of functions) chunks[stableBucket(fn.symbol, count)]!.push(fn);
  return chunks.flatMap((chunk, bucket) =>
    chunk.length === 0 ? [] : [{ bucket, functions: chunk }],
  );
}

/** A module's top-level forms, as the splitter classifies them. */
interface ModuleParts {
  preamble: string[];
  globals: GlobalDef[];
  functions: FunctionDef[];
  trailer: string[];
}

/** Classifies a module one line at a time. `define` lines go to
 * `onFunction`, which takes the following lines through the definition's
 * closing brace; every other line is offered to `line`. */
class ModuleReader {
  readonly parts: ModuleParts = { preamble: [], globals: [], functions: [], trailer: [] };
  private sawDefinition = false;
  private inTrailer = false;
  /** A global definition whose aggregate initializer continues over the
   * following lines (vtable arrays list one element per line). */
  private pendingGlobal: { text: string; depth: number } | null = null;
  failed = false;

  /** Whether a definition may start here (none may follow the trailer). */
  startFunction(): boolean {
    if (this.inTrailer || this.pendingGlobal !== null) this.failed = true;
    this.sawDefinition = true;
    return !this.failed;
  }

  line(line: string): void {
    if (this.pendingGlobal !== null) {
      this.pendingGlobal.text += "\n" + line;
      this.pendingGlobal.depth += bracketDepth(line);
      if (this.pendingGlobal.depth <= 0) {
        const { text } = this.pendingGlobal;
        this.pendingGlobal = null;
        this.global(text);
      }
      return;
    }
    if (line.startsWith("@") && line.includes(" = ")) {
      const depth = bracketDepth(line);
      if (depth > 0) this.pendingGlobal = { text: line, depth };
      else this.global(line);
      return;
    }
    if (line.startsWith("attributes ") || line.startsWith("!")) this.inTrailer = true;
    if (this.inTrailer) this.parts.trailer.push(line);
    else if (!this.sawDefinition || line.trim() !== "") this.parts.preamble.push(line);
  }

  /** Globals may follow the attributes and metadata (the feature flags the
   * link-features step appends); they are module storage like any other. */
  private global(definition: string): void {
    const parsed = globalDef(definition);
    if (parsed === null) {
      // External declarations are already valid in every shard.
      if (/^@.+\s+=\s+external\s+/.test(definition)) this.parts.preamble.push(definition);
      else this.failed = true;
    } else {
      this.parts.globals.push(parsed);
      this.sawDefinition = true;
    }
  }

  finish(): ModuleParts | null {
    return this.failed || this.pendingGlobal !== null ? null : this.parts;
  }
}

export function splitLlvmProgram(
  source: string,
  options: LlvmProgramSplitOptions = {},
): LlvmProgramSplit | null {
  const minimumBytes = options.minimumBytes ?? DEFAULT_MINIMUM_BYTES;
  const sourceBytes = Buffer.byteLength(source);
  if (sourceBytes < minimumBytes) return null;
  const lines = source.split("\n");
  const reader = new ModuleReader();
  for (let i = 0; i < lines.length && !reader.failed; i++) {
    const line = lines[i]!;
    if (line.startsWith("define ")) {
      if (!reader.startFunction()) break;
      const parsed = functionDefAt(lines, i);
      if (parsed === null) return null;
      reader.parts.functions.push(parsed.def);
      i = parsed.end;
    } else reader.line(line);
  }
  const parts = reader.finish();
  return parts === null ? null : shardModule(parts, sourceBytes, options, null);
}

/** The read size of splitLlvmProgramFile's scan. */
const FILE_CHUNK_BYTES = 16 * 1024 * 1024;

/** splitLlvmProgram over LLVM text already written to `path`, for modules
 * too large to hold in memory more than once (or past the longest string the
 * engine allows). Function bodies stay in the file: each shard's source
 * reads its bodies when it is read, so only the shards being written at a
 * time are in memory. */
export function splitLlvmProgramFile(
  path: string,
  options: LlvmProgramSplitOptions = {},
): LlvmProgramSplit | null {
  const minimumBytes = options.minimumBytes ?? DEFAULT_MINIMUM_BYTES;
  const sourceBytes = statSync(path).size;
  if (sourceBytes < minimumBytes) return null;
  const reader = new ModuleReader();
  // The definition being read: its header and where its body starts.
  let current: { header: NonNullable<ReturnType<typeof functionHeader>>; body: number } | null =
    null;
  const onLine = (bytes: Buffer, start: number, end: number, offset: number): void => {
    if (current !== null) {
      // Only the closing brace ends a definition; its body is not decoded.
      if (end - start === 1 && bytes[start] === 0x7d) {
        const { header, body } = current;
        const bodyEnd = offset + 1;
        reader.parts.functions.push({
          bytes: Buffer.byteLength(header.line) + 1 + (bodyEnd - body),
          text: (read) => `${header.line}\n${read(body, bodyEnd)}`,
          declaration: header.declaration,
          symbol: header.symbol,
          promoted: header.promoted,
        });
        current = null;
      }
      return;
    }
    const line = bytes.toString("utf8", start, end);
    if (line.startsWith("define ")) {
      const header = functionHeader(line);
      if (header === null || !reader.startFunction()) reader.failed = true;
      else current = { header, body: offset + (end - start) + 1 };
    } else reader.line(line);
  };
  const fd = openSync(path, "r");
  try {
    let carry: Buffer = Buffer.alloc(0);
    let carryOffset = 0;
    for (let position = 0; position < sourceBytes && !reader.failed;) {
      const chunk = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, sourceBytes - position));
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      const data =
        carry.length === 0
          ? chunk.subarray(0, read)
          : Buffer.concat([carry, chunk.subarray(0, read)]);
      const dataOffset = carry.length === 0 ? position : carryOffset;
      position += read;
      let lineStart = 0;
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, lineStart)) {
        onLine(data, lineStart, newline, dataOffset + lineStart);
        lineStart = newline + 1;
      }
      carry = Buffer.from(data.subarray(lineStart));
      carryOffset = dataOffset + lineStart;
    }
    // The text after the last newline is a line too (empty when the file
    // ends with one), as String.prototype.split answers it.
    if (!reader.failed) onLine(carry, 0, carry.length, carryOffset);
  } finally {
    closeSync(fd);
  }
  if (current !== null) return null;
  const parts = reader.finish();
  return parts === null ? null : shardModule(parts, sourceBytes, options, path);
}

/** Runs `use` with a reader of `path`'s byte ranges (or of nothing, for a
 * module held in memory). */
function withRangeReader<T>(path: string | null, use: (read: RangeReader) => T): T {
  if (path === null)
    return use(() => {
      throw new Error("an in-memory LLVM module has no file to read");
    });
  const fd = openSync(path, "r");
  try {
    return use((start, end) => {
      const bytes = Buffer.allocUnsafe(end - start);
      for (let done = 0; done < bytes.length;) {
        const read = readSync(fd, bytes, done, bytes.length - done, start + done);
        if (read === 0) throw new Error(`${path} ended before byte ${end}`);
        done += read;
      }
      return bytes.toString("utf8");
    });
  } finally {
    closeSync(fd);
  }
}

function shardModule(
  parts: ModuleParts,
  sourceBytes: number,
  options: LlvmProgramSplitOptions,
  path: string | null,
): LlvmProgramSplit | null {
  const { preamble, globals, functions, trailer } = parts;
  const targetBytes = Math.max(64 * 1024, options.targetBytes ?? DEFAULT_TARGET_BYTES);
  if (functions.length < 2) return null;
  const globalDecls = globals.flatMap((global) =>
    global.declaration === null ? [] : [global.declaration],
  );
  // Every shard repeats declarations and metadata. Bound that shared text
  // before materializing sources: function size alone can otherwise turn a
  // large debug module into many times its original size. Coarsen stable
  // power-of-two buckets, retaining the canonical path when even two would
  // exceed the budget. Small modules allow one target-sized shared budget.
  const sharedBytes =
    [...preamble, ...globalDecls, ...trailer].reduce(
      (bytes, line) => bytes + Buffer.byteLength(line) + 1,
      0,
    ) + functions.reduce((bytes, fn) => bytes + Buffer.byteLength(fn.declaration) + 1, 0);
  const bucketLimit = Math.floor(Math.max(sourceBytes, DEFAULT_TARGET_BYTES) / sharedBytes) - 1;
  if (bucketLimit < 2) return null;
  const chunks = chunksOf(functions, targetBytes, 2 ** Math.floor(Math.log2(bucketLimit)));
  if (chunks.length < 2) return null;
  const tail = trailer.length === 0 ? "" : `\n${trailer.join("\n")}`;
  // A shard's source is assembled when it is read; a module split from a
  // file reads its function bodies from there each time.
  const functionShards = chunks.map(({ bucket, functions: chunk }): LlvmProgramShard => {
    const owned = new Set(chunk);
    return {
      name: `program-f${bucket.toString().padStart(3, "0")}.ll`,
      source: () => {
        const declarations = functions.filter((fn) => !owned.has(fn)).map((fn) => fn.declaration);
        return withRangeReader(path, (read) =>
          [
            [...preamble, ...globalDecls, ...declarations, ""].join("\n"),
            ...chunk.map((fn) => fn.text(read)),
            tail,
          ].join("\n"),
        );
      },
    };
  });
  // Global initializer changes are common (literal text, generated tables)
  // and should not invalidate an otherwise unrelated function bucket. Keep
  // all module storage in one dedicated shard that declares every function.
  const globalShard: LlvmProgramShard = {
    name: "program-globals.ll",
    source: () =>
      [
        [...preamble, ...functions.map((fn) => fn.declaration), ""].join("\n"),
        ...globals.map((global) => global.line),
        tail,
      ].join("\n"),
  };
  return {
    shards: [globalShard, ...functionShards],
    promotedSymbols: [
      ...globals.filter((global) => global.promoted).map((global) => global.symbol),
      ...functions.filter((fn) => fn.promoted).map((fn) => fn.symbol),
    ],
    publicSymbols: [
      ...globals.filter((global) => !global.promoted).map((global) => global.symbol),
      ...functions.filter((fn) => !fn.promoted).map((fn) => fn.symbol),
    ],
  };
}

/** Dev-library policy tuned independently from executable splitting. */
export function splitLlvmLibraryProgram(source: string): LlvmProgramSplit | null {
  return splitLlvmProgram(source, {
    minimumBytes: LIBRARY_MINIMUM_BYTES,
    targetBytes: LIBRARY_TARGET_BYTES,
  });
}
