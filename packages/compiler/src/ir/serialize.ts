/* IR ↔ JSON. Numeric literals preserve JavaScript's complete number domain:
 * JSON's null/zero spellings must not erase NaN, infinities or negative zero.
 *
 * Compiler-scale artifacts are larger than one host string can hold (V8 caps
 * strings at 2^29 - 24 UTF-16 units, and the self-hosted compiler's IR is
 * already close to it). The compact encoding is therefore produced as ordered
 * text parts and decoded from bytes one function at a time; neither direction
 * materializes the complete document as a single string. */
import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";

// Version 17 adds the dynamic tier's jsval type and js.* builtins (two-tier
// design stage S3) and serializes each function's execution tier.
export const IR_VERSION = 17 as const;

/** IR artifacts are plain data. Scan each function once before deciding
 * whether its JSON encoding needs the complete-number-domain replacer. */
function ordinaryNumbers(root: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value === "function") return false;
    if (value === null || typeof value !== "object") return true;
    if (seen.has(value)) return true;
    seen.add(value);
    if (Array.isArray(value)) return value.every(visit);
    return Object.values(value as Record<string, unknown>).every(visit);
  };
  return visit(root);
}

function encodeNumber(_key: string, value: unknown): unknown {
  if (typeof value !== "number") return value;
  if (!Number.isFinite(value)) {
    return { $nonfinite: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
  }
  // JSON.stringify(-0) prints "0", which drops the sign a numLit's
  // f64 semantics depend on (String(-0) is "0" but 1/-0 is -Infinity) —
  // the same sentinel mechanism carries it.
  if (Object.is(value, -0)) {
    return { $nonfinite: "-0" };
  }
  return value;
}

function encodeFunction(fn: IrFunction): string | undefined {
  return ordinaryNumbers(fn) ? JSON.stringify(fn) : JSON.stringify(fn, encodeNumber);
}

/** A directory whose source location files an IR artifact names by a
 * prefix of its own: a location file `from + rest` serializes as
 * `to + rest`. */
export interface SerializedFileRoot {
  from: string;
  to: string;
}

/** Respells the source location files under `roots` in serialized parts.
 * A location's file is the first member of its JSON object, and the
 * escaped spelling of a path prefix is the prefix of the escaped path. */
function relocateFiles(parts: string[], roots: readonly SerializedFileRoot[]): string[] {
  const needles = roots.map(({ from, to }) => ({
    from: `"file":${JSON.stringify(from).slice(0, -1)}`,
    to: `"file":${JSON.stringify(to).slice(0, -1)}`,
  }));
  return parts.map((part) =>
    needles.reduce(
      (text, { from, to }) => (text.includes(from) ? text.replaceAll(from, to) : text),
      part,
    ),
  );
}

/** The compact encoding as ordered parts: the module header up to the
 * function array, one part per function (with separate comma parts), and the
 * header's remainder. Concatenating the parts yields exactly
 * `serializeModule(mod, true)`; writers stream them to disk in batches.
 * `fileRoots` respells the source locations in those directories, so
 * artifacts do not depend on where the compiler that wrote them is
 * installed. */
export function serializeModuleParts(
  mod: IrModule,
  fileRoots: readonly SerializedFileRoot[] = [],
): string[] {
  // A replacer reads through live native views. Serializing the complete
  // function array through one view refreshes every function capsule for
  // each element, making large compiler artifacts quadratic. The sentinel
  // replacer is key-independent, so encode each function as its own root.
  const header = JSON.stringify({ ...mod, functions: [] }, encodeNumber);
  const slot = '"functions":[]';
  const offset = header.indexOf(slot);
  const parts: string[] = [header.slice(0, offset) + '"functions":['];
  for (let index = 0; index < mod.functions.length; index++) {
    const fn = mod.functions[index]!;
    if (index > 0) parts.push(",");
    parts.push(encodeFunction(fn) ?? "null");
  }
  parts.push("]" + header.slice(offset + slot.length));
  return fileRoots.length === 0 ? parts : relocateFiles(parts, fileRoots);
}

/** Compiler artifacts use compact JSON; API consumers can retain the
 * readable default. Both return one string, so modules whose encoding
 * exceeds the host's string limit must use `serializeModuleParts`. */
export function serializeModule(mod: IrModule, compact = false): string {
  if (!compact) return JSON.stringify(mod, encodeNumber, 2);
  return serializeModuleParts(mod).join("");
}

function decodeNumber(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && "$nonfinite" in value) {
    const tag = (value as { $nonfinite: string }).$nonfinite;
    if (tag === "inf") return Infinity;
    if (tag === "-inf") return -Infinity;
    if (tag === "-0") return -0;
    if (tag === "nan") return NaN;
    throw new Error(`Invalid IR number sentinel: ${String(tag)}`);
  }
  return value;
}

function checkedVersion(mod: IrModule): IrModule {
  if (mod.irVersion !== IR_VERSION) {
    throw new Error(
      `IR version mismatch: file has ${String(mod.irVersion)}, compiler expects ${IR_VERSION}`,
    );
  }
  return mod;
}

export function deserializeModule(json: string): IrModule {
  return checkedVersion(JSON.parse(json, decodeNumber) as IrModule);
}

/** A node as it reads back from the compact encoding: a fresh object, as
 * is every node inside it. */
export function reparseExpr(node: IrExpr): IrExpr {
  return JSON.parse(JSON.stringify(node, encodeNumber), decodeNumber) as IrExpr;
}

export function reparseStmt(node: IrStmt): IrStmt {
  return JSON.parse(JSON.stringify(node, encodeNumber), decodeNumber) as IrStmt;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const FUNCTIONS_KEY = '"functions"';

function isJsonSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function skipSpace(bytes: Buffer, index: number): number {
  while (index < bytes.length && isJsonSpace(bytes[index]!)) index++;
  return index;
}

/** `index` is an opening quote; returns the index after its closing quote. */
function skipString(bytes: Buffer, index: number): number {
  const length = bytes.length;
  index++;
  while (index < length) {
    const byte = bytes[index]!;
    if (byte === BACKSLASH) index += 2;
    else if (byte === QUOTE) return index + 1;
    else index++;
  }
  return length;
}

interface FunctionSpans {
  /** Offsets of the function array's brackets. */
  open: number;
  close: number;
  /** Byte range of each element. */
  starts: number[];
  ends: number[];
}

/** Element ranges of the array starting at `open`, or null when the bytes
 * are not well-formed enough to split (the whole-document parse then reports
 * the exact syntax error). */
function elementSpans(bytes: Buffer, open: number): FunctionSpans | null {
  const length = bytes.length;
  const starts: number[] = [];
  const ends: number[] = [];
  let index = skipSpace(bytes, open + 1);
  if (index < length && bytes[index] === CLOSE_BRACKET) return { open, close: index, starts, ends };
  while (index < length) {
    const start = index;
    let depth = 0;
    while (index < length) {
      const byte = bytes[index]!;
      if (byte === QUOTE) {
        index = skipString(bytes, index);
        if (depth === 0) break;
        continue;
      }
      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
      else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        if (depth === 0) break;
        depth--;
        if (depth === 0) {
          index++;
          break;
        }
      } else if (depth === 0 && (byte === COMMA || isJsonSpace(byte))) break;
      index++;
    }
    if (index === start || index >= length) return null;
    starts.push(start);
    ends.push(index);
    index = skipSpace(bytes, index);
    if (index >= length) return null;
    if (bytes[index] === CLOSE_BRACKET) return { open, close: index, starts, ends };
    if (bytes[index] !== COMMA) return null;
    index = skipSpace(bytes, index + 1);
  }
  return null;
}

/** Locate the root object's `"functions"` array. */
function functionSpans(bytes: Buffer): FunctionSpans | null {
  const length = bytes.length;
  let depth = 0;
  let index = 0;
  while (index < length) {
    const byte = bytes[index]!;
    if (byte === QUOTE) {
      const start = index;
      index = skipString(bytes, index);
      if (depth === 1 && index - start === FUNCTIONS_KEY.length) {
        let key = true;
        for (let offset = 1; offset < FUNCTIONS_KEY.length - 1; offset++) {
          if (bytes[start + offset] !== FUNCTIONS_KEY.charCodeAt(offset)) {
            key = false;
            break;
          }
        }
        if (key) {
          let next = skipSpace(bytes, index);
          if (next < length && bytes[next] === COLON) {
            next = skipSpace(bytes, next + 1);
            if (next < length && bytes[next] === OPEN_BRACKET) return elementSpans(bytes, next);
          }
        }
      }
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth--;
    index++;
  }
  return null;
}

/** Decode a UTF-8 IR artifact (compact or readable) without materializing
 * it as one string: the header and each function are parsed separately.
 * Split points are ASCII structural bytes, so every range is valid UTF-8. */
export function deserializeModuleBytes(bytes: Buffer): IrModule {
  const spans = functionSpans(bytes);
  if (spans === null) return deserializeModule(bytes.toString("utf8"));
  const mod = checkedVersion(
    JSON.parse(
      bytes.toString("utf8", 0, spans.open + 1) + bytes.toString("utf8", spans.close),
      decodeNumber,
    ) as IrModule,
  );
  const functions: IrFunction[] = [];
  for (let index = 0; index < spans.starts.length; index++) {
    functions.push(
      JSON.parse(
        bytes.toString("utf8", spans.starts[index]!, spans.ends[index]!),
        decodeNumber,
      ) as IrFunction,
    );
  }
  mod.functions = functions;
  return mod;
}
