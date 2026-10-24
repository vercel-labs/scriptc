/** Check the only JSON string form the native runtime cannot yet retain.
 * JSON.parse itself validates grammar. A valid surrogate pair is preserved;
 * a lone escape must not change a type literal or symbol name. */
export function checkSemanticJsonStrings(json: string, preservesSurrogates: boolean): void {
  // Most checker responses contain no Unicode escapes. Inspect only escape
  // sequences instead of mapping every native string index to UTF-16. Valid
  // JSON has no backslashes outside strings; JSON.parse checks the grammar.
  if (preservesSurrogates || !json.includes("\\u")) return;
  for (let index = json.indexOf("\\"); index >= 0; index = json.indexOf("\\", index + 1)) {
    if (json.charCodeAt(++index) !== 117) continue;
    const unit = jsonHexUnit(json, index + 1);
    index += 4;
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff && json.charCodeAt(index + 1) === 92 && json.charCodeAt(index + 2) === 117) {
      const next = jsonHexUnit(json, index + 3);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 6;
        continue;
      }
    }
    throw new Error("TypeScript semantic response: runtime cannot preserve lone UTF-16 surrogates");
  }
}

function jsonHexUnit(json: string, offset: number): number {
  if (offset + 4 > json.length) return -1;
  let value = 0;
  for (let index = offset; index < offset + 4; index++) {
    const code = json.charCodeAt(index);
    const digit =
      code >= 48 && code <= 57
        ? code - 48
        : code >= 65 && code <= 70
          ? code - 55
          : code >= 97 && code <= 102
            ? code - 87
            : -1;
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}

// Capability-based so the boundary automatically disappears once native
// strings and JSON parsing support lossless UTF-16. Probe once per process.
const preservesJsonSurrogates = (JSON.parse('"\\ud800"') as string).charCodeAt(0) === 0xd800;

export function parseSemanticJson<T>(json: string): T {
  checkSemanticJsonStrings(json, preservesJsonSurrogates);
  return JSON.parse(json) as T;
}

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const LOWER_N = 0x6e;
/** `{"id":`, the start of every object reply the checker sends. */
const ID_PREFIX = [OPEN_BRACE, QUOTE, 0x69, 0x64, QUOTE, 0x3a];

function isJsonSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function skipJsonSpace(bytes: Uint8Array, index: number): number {
  while (index < bytes.length && isJsonSpace(bytes[index]!)) index++;
  return index;
}

function malformedReply(): never {
  throw new Error("TypeScript semantic response: malformed JSON");
}

/** The index after the JSON value that starts at `start`: an object, an
 * array, a string or a bare literal. Strings are skipped with their escapes,
 * so brackets inside them do not count. Throws when the value is unclosed. */
export function jsonValueEnd(bytes: Uint8Array, start: number): number {
  let depth = 0;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte === QUOTE) {
      index++;
      while (index < bytes.length && bytes[index] !== QUOTE)
        index += bytes[index] === BACKSLASH ? 2 : 1;
      if (index >= bytes.length) malformedReply();
      index++;
      if (depth === 0) return index;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      if (depth === 0) return index;
      depth--;
      if (depth === 0) return index + 1;
    } else if (depth === 0 && (byte === COMMA || isJsonSpace(byte))) return index;
    index++;
  }
  if (depth !== 0) malformedReply();
  return index;
}

/** The scanner the decoders find value ends with: jsonValueEnd, or the
 * native compiler's scanner (useNativeJsonValueEnd). */
let valueEnd: (bytes: Uint8Array, start: number) => number = jsonValueEnd;

/** Has the decoders find value ends with `scan`, which returns what
 * jsonValueEnd returns, or -1 where jsonValueEnd throws. The native compiler
 * installs its C scanner (native/ts7-process.c), which skips the strings that
 * make up most reply bytes with memchr. */
export function useNativeJsonValueEnd(scan: (bytes: Uint8Array, start: number) => number): void {
  valueEnd = (bytes, start) => {
    const end = scan(bytes, start);
    if (end < 0) malformedReply();
    return end;
  };
}

/** The id an object reply starts with (`{"id":N`), or -1 when it starts
 * otherwise. */
function leadingId(bytes: Uint8Array, start: number, end: number): number {
  if (end - start < ID_PREFIX.length + 1) return -1;
  for (let k = 0; k < ID_PREFIX.length; k++) if (bytes[start + k] !== ID_PREFIX[k]) return -1;
  let index = start + ID_PREFIX.length;
  let id = 0;
  let digits = 0;
  while (index < end && bytes[index]! >= 0x30 && bytes[index]! <= 0x39) {
    id = id * 10 + (bytes[index]! - 0x30);
    index++;
    digits++;
  }
  if (digits === 0 || digits > 15 || (bytes[index] !== COMMA && bytes[index] !== CLOSE_BRACE))
    return -1;
  return id;
}

function parseJsonSlice<T>(bytes: Uint8Array, start: number, end: number): T {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString("utf8");
  return parseSemanticJson<T>(text);
}

/** One element of a reply: null, or the object with leading id `id`. Objects
 * the caller already holds under that id are not decoded. */
function replyElement<T extends { id: number }, R>(
  bytes: Uint8Array,
  start: number,
  end: number,
  cached: (id: number) => R | undefined,
  build: (data: T) => R,
): R | null {
  if (bytes[start] === LOWER_N) {
    if (parseJsonSlice<null>(bytes, start, end) !== null) malformedReply();
    return null;
  }
  const id = leadingId(bytes, start, end);
  if (id >= 0) {
    const known = cached(id);
    if (known !== undefined) return known;
  }
  return build(parseJsonSlice<T>(bytes, start, end));
}

/** A checker reply that is one object (with a numeric `id`) or null. An empty
 * reply is null. Objects the caller already holds under their id, which a
 * reply repeats whenever it names them, are returned from `cached` without
 * decoding their text; the rest are decoded and handed to `build`. */
export function decodeSemanticObject<T extends { id: number }, R>(
  bytes: Uint8Array,
  cached: (id: number) => R | undefined,
  build: (data: T) => R,
): R | null {
  const start = skipJsonSpace(bytes, 0);
  if (start === bytes.length) return null;
  const end = valueEnd(bytes, start);
  if (skipJsonSpace(bytes, end) !== bytes.length) malformedReply();
  return replyElement(bytes, start, end, cached, build);
}

/** A checker reply that is an array of objects (each with a numeric `id`) and
 * nulls, or null. An empty reply is null. Elements are resolved as in
 * decodeSemanticObject. */
export function decodeSemanticObjects<T extends { id: number }, R>(
  bytes: Uint8Array,
  cached: (id: number) => R | undefined,
  build: (data: T) => R,
): (R | null)[] | null {
  let index = skipJsonSpace(bytes, 0);
  if (index === bytes.length) return null;
  if (bytes[index] !== OPEN_BRACKET) {
    const end = valueEnd(bytes, index);
    if (
      skipJsonSpace(bytes, end) !== bytes.length ||
      parseJsonSlice<null>(bytes, index, end) !== null
    )
      malformedReply();
    return null;
  }
  const result: (R | null)[] = [];
  index = skipJsonSpace(bytes, index + 1);
  if (bytes[index] === CLOSE_BRACKET) {
    if (skipJsonSpace(bytes, index + 1) !== bytes.length) malformedReply();
    return result;
  }
  for (;;) {
    const end = valueEnd(bytes, index);
    if (end === index) malformedReply();
    result.push(replyElement(bytes, index, end, cached, build));
    index = skipJsonSpace(bytes, end);
    if (bytes[index] === COMMA) {
      index = skipJsonSpace(bytes, index + 1);
      continue;
    }
    if (bytes[index] !== CLOSE_BRACKET || skipJsonSpace(bytes, index + 1) !== bytes.length)
      malformedReply();
    return result;
  }
}
