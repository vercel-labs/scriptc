/* The WebAssembly binary decoder and validator.
 *
 * Decodes a module completely and validates it against the feature level
 * scriptc means to translate to native code: the MVP plus the finished
 * post-MVP proposals that real npm modules use (sign-extension operators,
 * non-trapping float-to-int conversions, bulk memory, multi-value, mutable
 * globals, reference types and extended constant expressions). Where the
 * WebAssembly 3.0 specification and V8 relax a 2.0 rule inside that set (a
 * global initializer may read any earlier immutable global), the decoder
 * follows them, because Node is the behavior oracle.
 *
 * Modules that use a proposal outside that set (SIMD, threads, exception
 * handling, tail calls, function references and GC, memory64, multiple
 * memories) still decode: the instructions that need the proposal are read
 * for their immediates but not type-checked, and the summary names the
 * proposal so that the module can be reported as not translatable rather
 * than as invalid. Only GC type definitions stop the decode, since their
 * layout would need the full GC type system.
 *
 * The decoder never evaluates anything and keeps no module contents beyond
 * the counts and the feature set it reports. It is plain TypeScript that
 * the native compiler also compiles. */
import { readMemargFlags } from "./module.js";

/** Proposals the summary can name, in report order. The first group is the
 * translatable set; the rest are reported as unsupported. */
export const WASM_FEATURES = [
  "mutable-globals",
  "sign-extension",
  "nontrapping-fptoint",
  "bulk-memory",
  "multi-value",
  "reference-types",
  "extended-const",
  "simd",
  "threads",
  "exceptions",
  "tail-call",
  "function-references",
  "gc",
  "memory64",
  "multi-memory",
] as const;
export type WasmFeature = (typeof WASM_FEATURES)[number];

const TRANSLATABLE: ReadonlySet<string> = new Set([
  "mutable-globals",
  "sign-extension",
  "nontrapping-fptoint",
  "bulk-memory",
  "multi-value",
  "reference-types",
  "extended-const",
]);

/** True for proposals inside the translatable feature level. */
export function isTranslatableFeature(feature: string): boolean {
  return TRANSLATABLE.has(feature);
}

/** What a decoded module reports. `status` is "valid" when the module
 * validates within the translatable feature level, "unsupported" when it
 * uses a proposal outside it (and is otherwise well-formed as far as the
 * decoder checks), and "malformed" or "invalid" for a module that every
 * engine rejects; `error` then says where and why. */
export interface WasmModuleSummary {
  size: number;
  status: "valid" | "unsupported" | "malformed" | "invalid";
  error: string | null;
  features: string[];
  unsupported: string[];
  functions: number;
  imports: number;
  exports: number;
  importModules: string[];
  memories: number;
  tables: number;
  globals: number;
  customSections: string[];
}

/** A decode failure: malformed bytes or an invalid module. */
export class WasmError extends Error {
  kind: "malformed" | "invalid";
  offset: number;
  constructor(kind: "malformed" | "invalid", message: string, offset: number) {
    super(message);
    this.kind = kind;
    this.offset = offset;
  }
}

// Value types. Zero is the "unknown" type of unreachable code.
const UNKNOWN = 0;
const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;
const V128 = 0x7b;
const FUNCREF = 0x70;
const EXTERNREF = 0x6f;

// V8's implementation limits that are part of validation (wasm-limits.h).
const MAX_TYPES = 1000000;
const MAX_FUNCTIONS = 1000000;
const MAX_IMPORTS = 100000;
const MAX_EXPORTS = 100000;
const MAX_GLOBALS = 1000000;
const MAX_DATA_SEGMENTS = 100000;
const MAX_LOCALS = 50000;
const MAX_PARAMS = 1000;
const MAX_RESULTS = 1000;
const MAX_FUNCTION_SIZE = 7654321;
const MAX_MEMORY_PAGES = 65536;
const MAX_TABLE_INIT = 10000000;

interface FuncType {
  params: number[];
  results: number[];
}

interface Global {
  type: number;
  mutable: boolean;
  imported: boolean;
}

interface Table {
  type: number;
}

interface Frame {
  opcode: number;
  start: number[];
  end: number[];
  height: number;
  unreachable: boolean;
  /** An `if` that has not seen its `else`. */
  hasElse: boolean;
}

class Reader {
  bytes: Uint8Array;
  pos: number;
  end: number;
  constructor(bytes: Uint8Array, pos: number, end: number) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }

  malformed(message: string): never {
    throw new WasmError("malformed", message, this.pos);
  }

  eof(): boolean {
    return this.pos >= this.end;
  }

  u8(): number {
    if (this.pos >= this.end) this.malformed("unexpected end");
    const b = this.bytes[this.pos]!;
    this.pos++;
    return b;
  }

  peek(): number {
    if (this.pos >= this.end) this.malformed("unexpected end");
    return this.bytes[this.pos]!;
  }

  skip(n: number): void {
    if (n > this.end - this.pos) this.malformed("unexpected end");
    this.pos += n;
  }

  u32(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 4 && (b & 0xf0) !== 0) {
        this.malformed(b & 0x80 ? "integer representation too long" : "integer too large");
      }
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
    return this.malformed("integer representation too long");
  }

  /** A signed LEB128 of `bits` bits (32, 33 or 64); answers the value for
   * 32 and 33 bits and 0 for 64 (no caller needs it). */
  sleb(bits: number): number {
    const maxBytes = Math.ceil(bits / 7);
    let result = 0;
    let scale = 1;
    for (let i = 0; i < maxBytes; i++) {
      const b = this.u8();
      if (i === maxBytes - 1) {
        // The final byte's bits above the value's width must repeat its
        // sign bit, and it may not continue.
        if (b & 0x80) this.malformed("integer representation too long");
        const used = bits - 7 * i;
        const unused = (b >> (used - 1)) & ((1 << (8 - used)) - 1) & 0x7f;
        const all = (1 << (7 - used + 1)) - 1;
        if (unused !== 0 && unused !== all) this.malformed("integer too large");
      }
      if (bits < 64) result += (b & 0x7f) * scale;
      scale *= 128;
      if ((b & 0x80) === 0) {
        if (bits < 64 && b & 0x40) result -= scale;
        return bits < 64 ? result : 0;
      }
    }
    return this.malformed("integer representation too long");
  }

  u64(): void {
    this.sleb(64);
  }

  name(): string {
    const length = this.u32();
    if (length > this.end - this.pos) this.malformed("length out of bounds");
    const start = this.pos;
    this.pos += length;
    return utf8(this.bytes, start, this.pos, this);
  }
}

function utf8(bytes: Uint8Array, start: number, end: number, reader: Reader): string {
  let out = "";
  let i = start;
  while (i < end) {
    const b = bytes[i]!;
    let cp = 0;
    let need = 0;
    if (b < 0x80) {
      cp = b;
    } else if (b >= 0xc2 && b <= 0xdf) {
      cp = b & 0x1f;
      need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      cp = b & 0x0f;
      need = 2;
    } else if (b >= 0xf0 && b <= 0xf4) {
      cp = b & 0x07;
      need = 3;
    } else {
      reader.malformed("malformed UTF-8 encoding");
    }
    if (i + need >= end) reader.malformed("malformed UTF-8 encoding");
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k]!;
      if ((c & 0xc0) !== 0x80) reader.malformed("malformed UTF-8 encoding");
      cp = cp * 64 + (c & 0x3f);
    }
    if (
      (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ||
      (need === 3 && (cp < 0x10000 || cp > 0x10ffff))
    ) {
      reader.malformed("malformed UTF-8 encoding");
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** Load and store natural alignments (log2) by opcode, 0x28..0x3e. */
const MEMORY_ALIGN = [2, 3, 2, 3, 0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 2, 3, 2, 3, 0, 1, 0, 1, 2];
/** Load result / store operand types by opcode, 0x28..0x3e. */
const MEMORY_TYPE = [
  I32,
  I64,
  F32,
  F64,
  I32,
  I32,
  I32,
  I32,
  I64,
  I64,
  I64,
  I64,
  I64,
  I64,
  I32,
  I64,
  F32,
  F64,
  I32,
  I32,
  I64,
  I64,
  I64,
];

/** Numeric instruction signatures, 0x45..0xc4: operand type, operand
 * count, result type. */
function numericSignature(op: number): [number, number, number] {
  if (op === 0x45) return [I32, 1, I32];
  if (op <= 0x4f) return [I32, 2, I32];
  if (op === 0x50) return [I64, 1, I32];
  if (op <= 0x5a) return [I64, 2, I32];
  if (op <= 0x60) return [F32, 2, I32];
  if (op <= 0x66) return [F64, 2, I32];
  if (op <= 0x69) return [I32, 1, I32];
  if (op <= 0x78) return [I32, 2, I32];
  if (op <= 0x7b) return [I64, 1, I64];
  if (op <= 0x8a) return [I64, 2, I64];
  if (op <= 0x91) return [F32, 1, F32];
  if (op <= 0x98) return [F32, 2, F32];
  if (op <= 0x9f) return [F64, 1, F64];
  if (op <= 0xa6) return [F64, 2, F64];
  switch (op) {
    case 0xa7:
      return [I64, 1, I32];
    case 0xa8:
    case 0xa9:
      return [F32, 1, I32];
    case 0xaa:
    case 0xab:
      return [F64, 1, I32];
    case 0xac:
    case 0xad:
      return [I32, 1, I64];
    case 0xae:
    case 0xaf:
      return [F32, 1, I64];
    case 0xb0:
    case 0xb1:
      return [F64, 1, I64];
    case 0xb2:
    case 0xb3:
      return [I32, 1, F32];
    case 0xb4:
    case 0xb5:
      return [I64, 1, F32];
    case 0xb6:
      return [F64, 1, F32];
    case 0xb7:
    case 0xb8:
      return [I32, 1, F64];
    case 0xb9:
    case 0xba:
      return [I64, 1, F64];
    case 0xbb:
      return [F32, 1, F64];
    case 0xbc:
      return [F32, 1, I32];
    case 0xbd:
      return [F64, 1, I64];
    case 0xbe:
      return [I32, 1, F32];
    case 0xbf:
      return [I64, 1, F64];
    case 0xc0:
    case 0xc1:
      return [I32, 1, I32];
    default:
      return [I64, 1, I64];
  }
}

const SECTION_ORDER: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  13: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  12: 11,
  10: 12,
  11: 13,
};

class ModuleDecoder {
  bytes: Uint8Array;
  features = new Set<string>();
  types: FuncType[] = [];
  funcs: number[] = [];
  importedFuncs = 0;
  tables: Table[] = [];
  memories = 0;
  memory64 = false;
  globals: Global[] = [];
  importedGlobals = 0;
  tags = 0;
  elemTypes: number[] = [];
  dataCount: number | null = null;
  dataSegments = 0;
  declaredRefs = new Set<number>();
  exportNames = new Set<string>();
  importModules: string[] = [];
  customSections: string[] = [];
  imports = 0;
  exports = 0;
  codeCount = 0;
  sawCode = false;
  /** A type definition outside the function-type subset stopped typing. */
  gcTypes = false;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  invalid(message: string, offset: number): never {
    throw new WasmError("invalid", message, offset);
  }

  feature(name: WasmFeature): void {
    this.features.add(name);
  }

  // ── types ────────────────────────────────────────────────────────────

  /** A value type; GC and exception-handling reference types are named as
   * features and answer UNKNOWN (the code that uses them is not typed). */
  valType(r: Reader): number {
    const b = r.u8();
    switch (b) {
      case I32:
      case I64:
      case F32:
      case F64:
        return b;
      case V128:
        this.feature("simd");
        return V128;
      case FUNCREF:
      case EXTERNREF:
        return b;
      default:
        return this.otherRefType(r, b);
    }
  }

  otherRefType(r: Reader, b: number): number {
    if (b === 0x63 || b === 0x64) {
      // (ref null ht) / (ref ht): a heap type follows.
      this.feature("function-references");
      this.heapType(r);
      return UNKNOWN;
    }
    if (b === 0x69 || b === 0x68 || b === 0x74 || b === 0x75) {
      this.feature("exceptions");
      return UNKNOWN;
    }
    if (b >= 0x6a && b <= 0x73) {
      // anyref, eqref, i31ref, structref, arrayref, nullref, ...
      this.feature("gc");
      return UNKNOWN;
    }
    return r.malformed("malformed value type");
  }

  heapType(r: Reader): void {
    const b = r.peek();
    if (b >= 0x60 && b <= 0x7f) {
      r.u8();
      if (b === 0x69 || b === 0x74) this.feature("exceptions");
      else if (b !== FUNCREF && b !== EXTERNREF) this.feature("gc");
      return;
    }
    // A concrete heap type: a typed function reference.
    const offset = r.pos;
    const index = r.sleb(33);
    if (index < 0) r.malformed("malformed heap type");
    this.feature("function-references");
    if (index >= this.types.length && !this.gcTypes) this.invalid(`unknown type ${index}`, offset);
  }

  refType(r: Reader): number {
    const b = r.u8();
    if (b === FUNCREF || b === EXTERNREF) return b;
    if (b >= 0x63 && b <= 0x75 && b !== 0x67 && b !== 0x66 && b !== 0x65) {
      this.otherRefType(r, b);
      return UNKNOWN;
    }
    return r.malformed("malformed reference type");
  }

  typeSection(r: Reader): void {
    const count = r.u32();
    if (count > MAX_TYPES) r.malformed("too many types");
    for (let i = 0; i < count; i++) {
      const form = r.u8();
      if (form === 0x60) {
        this.types.push(this.funcType(r));
        continue;
      }
      if (form === 0x4e || form === 0x50 || form === 0x4f || form === 0x5f || form === 0x5e) {
        // Recursive groups, subtypes, structs and arrays: the GC type
        // system. Stop decoding types; nothing after them can be typed.
        this.feature("gc");
        this.gcTypes = true;
        r.pos = r.end;
        return;
      }
      r.malformed("malformed function type");
    }
  }

  funcType(r: Reader): FuncType {
    const params: number[] = [];
    const nParams = r.u32();
    if (nParams > MAX_PARAMS) r.malformed("too many parameters");
    for (let i = 0; i < nParams; i++) params.push(this.valType(r));
    const results: number[] = [];
    const nResults = r.u32();
    if (nResults > MAX_RESULTS) r.malformed("too many results");
    for (let i = 0; i < nResults; i++) results.push(this.valType(r));
    if (results.length > 1) this.feature("multi-value");
    return { params, results };
  }

  funcTypeAt(index: number, offset: number): FuncType {
    if (index >= this.types.length) {
      if (this.gcTypes) return { params: [], results: [] };
      this.invalid(`unknown type ${index}`, offset);
    }
    return this.types[index]!;
  }

  limits(r: Reader, kind: "memory" | "table"): { min: number; max: number | null } {
    const flags = r.u8();
    if (kind === "memory") {
      if (flags > 0x07) r.malformed("malformed limits flags");
      if (flags & 0x02) this.feature("threads");
      if (flags & 0x04) {
        this.feature("memory64");
        this.memory64 = true;
      }
    } else {
      // Tables: a maximum flag and the table64 flag; no shared tables.
      if ((flags & ~0x05) !== 0) r.malformed("malformed limits flags");
      if (flags & 0x04) this.feature("memory64");
    }
    const wide = (flags & 0x04) !== 0;
    const min = wide ? (r.u64(), 0) : r.u32();
    let max: number | null = null;
    if (flags & 0x01) max = wide ? (r.u64(), 0) : r.u32();
    if (kind === "memory" && flags & 0x02 && max === null && !wide) {
      this.invalid("shared memory must have maximum", r.pos);
    }
    return { min, max };
  }

  memoryType(r: Reader): void {
    const offset = r.pos;
    const { min, max } = this.limits(r, "memory");
    if (this.memory64) return;
    if (min > MAX_MEMORY_PAGES)
      this.invalid("memory size must be at most 65536 pages (4GiB)", offset);
    if (max !== null && max > MAX_MEMORY_PAGES) {
      this.invalid("memory size must be at most 65536 pages (4GiB)", offset);
    }
    if (max !== null && min > max)
      this.invalid("size minimum must not be greater than maximum", offset);
  }

  addMemory(): void {
    this.memories++;
    if (this.memories > 1) this.feature("multi-memory");
  }

  tableType(r: Reader): Table {
    const offset = r.pos;
    if (r.peek() === 0x40) {
      // A table with an explicit initializer (function references).
      r.u8();
      if (r.u8() !== 0x00) r.malformed("malformed table type");
      this.feature("function-references");
    }
    const type = this.refType(r);
    const { min, max } = this.limits(r, "table");
    if (min > MAX_TABLE_INIT) this.invalid("table size must be at most 10000000", offset);
    if (max !== null && min > max)
      this.invalid("size minimum must not be greater than maximum", offset);
    return { type };
  }

  addTable(table: Table): void {
    this.tables.push(table);
    if (this.tables.length > 1) this.feature("reference-types");
    if (table.type === EXTERNREF) this.feature("reference-types");
  }

  globalType(r: Reader): Global {
    const type = this.valType(r);
    if (type === FUNCREF || type === EXTERNREF) this.feature("reference-types");
    const mut = r.u8();
    if (mut > 1) r.malformed("malformed mutability");
    return { type, mutable: mut === 1, imported: false };
  }

  // ── sections ─────────────────────────────────────────────────────────

  importSection(r: Reader): void {
    const count = r.u32();
    if (count > MAX_IMPORTS) r.malformed("too many imports");
    for (let i = 0; i < count; i++) {
      const module = r.name();
      r.name();
      if (!this.importModules.includes(module)) this.importModules.push(module);
      this.imports++;
      const offset = r.pos;
      const kind = r.u8();
      switch (kind) {
        case 0x00: {
          const index = r.u32();
          this.funcTypeAt(index, offset);
          this.funcs.push(index);
          this.importedFuncs++;
          break;
        }
        case 0x01:
          this.addTable(this.tableType(r));
          break;
        case 0x02:
          this.memoryType(r);
          this.addMemory();
          break;
        case 0x03: {
          const global = this.globalType(r);
          if (global.mutable) this.feature("mutable-globals");
          global.imported = true;
          this.globals.push(global);
          this.importedGlobals++;
          break;
        }
        case 0x04:
          this.tagType(r);
          break;
        default:
          r.malformed("malformed import kind");
      }
    }
  }

  tagType(r: Reader): void {
    const offset = r.pos;
    this.feature("exceptions");
    if (r.u8() !== 0x00) r.malformed("malformed tag attribute");
    const type = this.funcTypeAt(r.u32(), offset);
    if (type.results.length !== 0 && !this.gcTypes)
      this.invalid("non-empty tag result type", offset);
    this.tags++;
  }

  functionSection(r: Reader): void {
    const count = r.u32();
    if (count > MAX_FUNCTIONS) r.malformed("too many functions");
    for (let i = 0; i < count; i++) {
      const offset = r.pos;
      const index = r.u32();
      this.funcTypeAt(index, offset);
      this.funcs.push(index);
    }
  }

  tableSection(r: Reader): void {
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      const hasInit = r.peek() === 0x40;
      const table = this.tableType(r);
      if (hasInit) this.constExpr(r, table.type);
      this.addTable(table);
    }
  }

  memorySection(r: Reader): void {
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      this.memoryType(r);
      this.addMemory();
    }
  }

  tagSection(r: Reader): void {
    const count = r.u32();
    for (let i = 0; i < count; i++) this.tagType(r);
  }

  globalSection(r: Reader): void {
    const count = r.u32();
    if (count + this.globals.length > MAX_GLOBALS) r.malformed("too many globals");
    for (let i = 0; i < count; i++) {
      const global = this.globalType(r);
      this.constExpr(r, global.type);
      this.globals.push(global);
    }
  }

  exportSection(r: Reader): void {
    const count = r.u32();
    if (count > MAX_EXPORTS) r.malformed("too many exports");
    for (let i = 0; i < count; i++) {
      const offset = r.pos;
      const name = r.name();
      if (this.exportNames.has(name)) this.invalid("duplicate export name", offset);
      this.exportNames.add(name);
      this.exports++;
      const kind = r.u8();
      const indexOffset = r.pos;
      const index = r.u32();
      switch (kind) {
        case 0x00:
          if (index >= this.funcs.length) this.invalid(`unknown function ${index}`, indexOffset);
          this.declaredRefs.add(index);
          break;
        case 0x01:
          if (index >= this.tables.length) this.invalid(`unknown table ${index}`, indexOffset);
          break;
        case 0x02:
          if (index >= this.memories) this.invalid(`unknown memory ${index}`, indexOffset);
          break;
        case 0x03:
          if (index >= this.globals.length) this.invalid(`unknown global ${index}`, indexOffset);
          if (this.globals[index]!.mutable) this.feature("mutable-globals");
          break;
        case 0x04:
          if (index >= this.tags) this.invalid(`unknown tag ${index}`, indexOffset);
          break;
        default:
          r.malformed("malformed export kind");
      }
    }
  }

  startSection(r: Reader): void {
    const offset = r.pos;
    const index = r.u32();
    if (index >= this.funcs.length) this.invalid(`unknown function ${index}`, offset);
    const type = this.funcTypeAt(this.funcs[index]!, offset);
    if (type.params.length !== 0 || type.results.length !== 0) {
      this.invalid("start function must have type [] -> []", offset);
    }
  }

  elementSection(r: Reader): void {
    const count = r.u32();
    if (count > MAX_TABLE_INIT) r.malformed("too many element segments");
    for (let i = 0; i < count; i++) {
      const offset = r.pos;
      const flags = r.u32();
      if (flags > 7) r.malformed("malformed elements segment kind");
      const passiveOrDeclarative = (flags & 0x01) !== 0;
      const explicitTable = (flags & 0x02) !== 0;
      const usesExprs = (flags & 0x04) !== 0;
      if (flags !== 0) this.feature(usesExprs || explicitTable ? "reference-types" : "bulk-memory");
      let tableIndex = 0;
      if (!passiveOrDeclarative) {
        if (explicitTable) tableIndex = r.u32();
        if (tableIndex >= this.tables.length) this.invalid(`unknown table ${tableIndex}`, offset);
        this.constExpr(r, this.memory64 ? UNKNOWN : I32);
      }
      let elemType = FUNCREF;
      if (passiveOrDeclarative || explicitTable) {
        if (usesExprs) {
          elemType = this.refType(r);
        } else if (r.u8() !== 0x00) {
          r.malformed("malformed element kind");
        }
      }
      if (!passiveOrDeclarative) {
        const tableType = this.tables[tableIndex]!.type;
        if (elemType !== UNKNOWN && tableType !== UNKNOWN && elemType !== tableType) {
          this.invalid("type mismatch", offset);
        }
      }
      const n = r.u32();
      for (let k = 0; k < n; k++) {
        if (usesExprs) {
          this.constExpr(r, elemType);
        } else {
          const at = r.pos;
          const index = r.u32();
          if (index >= this.funcs.length) this.invalid(`unknown function ${index}`, at);
          this.declaredRefs.add(index);
        }
      }
      this.elemTypes.push(elemType);
    }
  }

  dataCountSection(r: Reader): void {
    this.dataCount = r.u32();
    this.feature("bulk-memory");
  }

  dataSection(r: Reader): void {
    const count = r.u32();
    if (count > MAX_DATA_SEGMENTS) r.malformed("too many data segments");
    if (this.dataCount !== null && count !== this.dataCount) {
      r.malformed("data count and data section have inconsistent lengths");
    }
    for (let i = 0; i < count; i++) {
      const offset = r.pos;
      const flags = r.u32();
      if (flags > 2) r.malformed("malformed data segment kind");
      if (flags !== 1) {
        let memory = 0;
        if (flags === 2) memory = r.u32();
        if (memory !== 0) this.feature("multi-memory");
        if (memory >= this.memories) this.invalid(`unknown memory ${memory}`, offset);
        this.constExpr(r, this.memory64 ? UNKNOWN : I32);
      } else {
        this.feature("bulk-memory");
      }
      const length = r.u32();
      r.skip(length);
    }
    this.dataSegments = count;
  }

  customSection(r: Reader): void {
    this.customSections.push(r.name());
    r.pos = r.end;
  }

  // ── constant expressions ────────────────────────────────────────────

  /** A constant expression producing `expected` (UNKNOWN: not checked).
   * global.get may read any earlier immutable global, as in 3.0 and V8
   * (2.0 allowed only imported ones in global initializers). */
  constExpr(r: Reader, expected: number): void {
    const stack: number[] = [];
    const start = r.pos;
    for (;;) {
      const offset = r.pos;
      const op = r.u8();
      switch (op) {
        case 0x0b: {
          if (expected !== UNKNOWN) {
            if (stack.length !== 1 || !matches(stack[0]!, expected)) {
              this.invalid("type mismatch", start);
            }
          }
          return;
        }
        case 0x41:
          r.sleb(32);
          stack.push(I32);
          break;
        case 0x42:
          r.sleb(64);
          stack.push(I64);
          break;
        case 0x43:
          r.skip(4);
          stack.push(F32);
          break;
        case 0x44:
          r.skip(8);
          stack.push(F64);
          break;
        case 0x23: {
          // A global initializer sees the globals before it (they are all
          // that exist yet); offsets see every global.
          const index = r.u32();
          if (index >= this.globals.length) this.invalid(`unknown global ${index}`, offset);
          const global = this.globals[index]!;
          if (global.mutable) this.invalid("constant expression required", offset);
          stack.push(global.type);
          break;
        }
        case 0xd0: {
          this.feature("reference-types");
          const t = this.refHeapNull(r);
          stack.push(t);
          break;
        }
        case 0xd2: {
          this.feature("reference-types");
          const index = r.u32();
          if (index >= this.funcs.length) this.invalid(`unknown function ${index}`, offset);
          this.declaredRefs.add(index);
          stack.push(FUNCREF);
          break;
        }
        case 0x6a:
        case 0x6b:
        case 0x6c:
        case 0x7c:
        case 0x7d:
        case 0x7e: {
          this.feature("extended-const");
          const t = op <= 0x6c ? I32 : I64;
          const b = stack.pop();
          const a = stack.pop();
          if (a === undefined || b === undefined || !matches(a, t) || !matches(b, t)) {
            this.invalid("type mismatch", offset);
          }
          stack.push(t);
          break;
        }
        case 0xfd: {
          this.feature("simd");
          const sub = r.u32();
          if (sub !== 12) this.invalid("constant expression required", offset);
          r.skip(16);
          stack.push(V128);
          break;
        }
        case 0xfb:
          // GC's struct.new and friends: not typed here.
          this.feature("gc");
          return this.skipToEnd(r);
        default:
          this.invalid("constant expression required", offset);
      }
    }
  }

  skipToEnd(r: Reader): void {
    // Only reachable for GC constant expressions, whose immediates this
    // decoder does not model: skip to the next end byte.
    while (r.u8() !== 0x0b) {
      /* scan */
    }
  }

  /** ref.null's heap type, as a value type (UNKNOWN for GC heap types). */
  refHeapNull(r: Reader): number {
    const b = r.peek();
    if (b === FUNCREF || b === EXTERNREF) {
      r.u8();
      return b;
    }
    this.heapType(r);
    return UNKNOWN;
  }

  // ── code ─────────────────────────────────────────────────────────────

  codeSection(r: Reader): void {
    const count = r.u32();
    this.sawCode = true;
    const defined = this.funcs.length - this.importedFuncs;
    if (count !== defined) r.malformed("function and code section have inconsistent lengths");
    this.codeCount = count;
    for (let i = 0; i < count; i++) {
      const size = r.u32();
      if (size > r.end - r.pos) r.malformed("length out of bounds");
      if (size > MAX_FUNCTION_SIZE) r.malformed("function body too large");
      const body = new Reader(this.bytes, r.pos, r.pos + size);
      const type = this.funcTypeAt(this.funcs[this.importedFuncs + i]!, r.pos);
      new FunctionValidator(this, body, type).run();
      r.pos += size;
    }
  }

  decode(): void {
    const bytes = this.bytes;
    const r = new Reader(bytes, 0, bytes.length);
    if (
      bytes.length < 4 ||
      bytes[0] !== 0 ||
      bytes[1] !== 0x61 ||
      bytes[2] !== 0x73 ||
      bytes[3] !== 0x6d
    ) {
      r.malformed("magic header not detected");
    }
    r.pos = 4;
    if (bytes.length < 8) r.malformed("unexpected end");
    if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
      r.malformed("unknown binary version");
    }
    r.pos = 8;
    let last = 0;
    while (!r.eof()) {
      const id = r.u8();
      const size = r.u32();
      if (size > r.end - r.pos) r.malformed("section size out of bounds");
      const section = new Reader(bytes, r.pos, r.pos + size);
      if (id !== 0) {
        const order = SECTION_ORDER[id];
        if (order === undefined) return r.malformed("malformed section id");
        if (order <= last) r.malformed("unexpected section (out of order or duplicate)");
        last = order;
      }
      if (!(this.gcTypes && id !== 0)) {
        switch (id) {
          case 0:
            this.customSection(section);
            break;
          case 1:
            this.typeSection(section);
            break;
          case 2:
            this.importSection(section);
            break;
          case 3:
            this.functionSection(section);
            break;
          case 4:
            this.tableSection(section);
            break;
          case 5:
            this.memorySection(section);
            break;
          case 6:
            this.globalSection(section);
            break;
          case 7:
            this.exportSection(section);
            break;
          case 8:
            this.startSection(section);
            break;
          case 9:
            this.elementSection(section);
            break;
          case 10:
            this.codeSection(section);
            break;
          case 11:
            this.dataSection(section);
            break;
          case 12:
            this.dataCountSection(section);
            break;
          case 13:
            this.tagSection(section);
            break;
        }
      } else {
        section.pos = section.end;
      }
      if (section.pos !== section.end) {
        r.pos = section.pos;
        r.malformed("section size mismatch");
      }
      r.pos = section.end;
    }
    if (!this.gcTypes) {
      if (!this.sawCode && this.funcs.length > this.importedFuncs) {
        r.malformed("function and code section have inconsistent lengths");
      }
      if (this.dataCount !== null && this.dataSegments !== this.dataCount && this.dataCount !== 0) {
        r.malformed("data count and data section have inconsistent lengths");
      }
    }
  }
}

function isRef(t: number): boolean {
  return t === FUNCREF || t === EXTERNREF;
}

function isNum(t: number): boolean {
  return t === I32 || t === I64 || t === F32 || t === F64 || t === V128;
}

function matches(actual: number, expected: number): boolean {
  return actual === expected || actual === UNKNOWN || expected === UNKNOWN;
}

/** Validates one function body (the algorithm of the specification's
 * validation appendix). Once an instruction needs a proposal outside the
 * translatable set, the rest of the body is only decoded. */
class FunctionValidator {
  m: ModuleDecoder;
  r: Reader;
  type: FuncType;
  locals: number[] = [];
  vals: number[] = [];
  ctrls: Frame[] = [];
  typed = true;

  constructor(m: ModuleDecoder, r: Reader, type: FuncType) {
    this.m = m;
    this.r = r;
    this.type = type;
  }

  invalid(message: string): never {
    throw new WasmError("invalid", message, this.r.pos);
  }

  /** Stops typing: the rest of the body only decodes. */
  untyped(feature: WasmFeature): void {
    this.m.feature(feature);
    this.typed = false;
  }

  run(): void {
    const r = this.r;
    for (const p of this.type.params) this.locals.push(p);
    const groups = r.u32();
    let total = this.locals.length;
    for (let i = 0; i < groups; i++) {
      const n = r.u32();
      total += n;
      if (total > MAX_LOCALS) r.malformed("too many locals");
      const t = this.m.valType(r);
      if (t === V128) this.typed = false;
      if (isRef(t)) this.m.feature("reference-types");
      for (let k = 0; k < n; k++) this.locals.push(t);
    }
    if (this.type.params.includes(V128) || this.type.results.includes(V128)) this.typed = false;
    if (this.m.memory64 || this.m.gcTypes) this.typed = false;
    this.pushCtrl(-1, [], this.type.results);
    while (this.ctrls.length > 0) {
      if (r.eof()) r.malformed("unexpected end of section or function");
      this.instruction();
    }
    if (!r.eof()) r.malformed("operators remaining after end of function");
  }

  // The operand stack.
  push(t: number): void {
    this.vals.push(t);
  }

  pop(): number {
    const frame = this.ctrls[this.ctrls.length - 1]!;
    if (this.vals.length === frame.height) {
      if (frame.unreachable) return UNKNOWN;
      this.invalid("type mismatch");
    }
    return this.vals.pop()!;
  }

  popExpect(expected: number): number {
    const actual = this.pop();
    if (!matches(actual, expected)) this.invalid("type mismatch");
    // Unreachable code's unknown operand stays unknown when pushed back
    // (br_if, br_table), so later labels can still meet it.
    return actual;
  }

  pushAll(types: number[]): void {
    for (const t of types) this.push(t);
  }

  popAll(types: number[]): number[] {
    const out: number[] = [];
    for (let i = types.length - 1; i >= 0; i--) out.unshift(this.popExpect(types[i]!));
    return out;
  }

  pushCtrl(opcode: number, start: number[], end: number[]): void {
    this.ctrls.push({
      opcode,
      start,
      end,
      height: this.vals.length,
      unreachable: false,
      hasElse: false,
    });
    this.pushAll(start);
  }

  popCtrl(): Frame {
    if (this.ctrls.length === 0) this.invalid("control stack underflow");
    const frame = this.ctrls[this.ctrls.length - 1]!;
    this.popAll(frame.end);
    if (this.vals.length !== frame.height) this.invalid("type mismatch");
    this.ctrls.pop();
    return frame;
  }

  labelTypes(frame: Frame): number[] {
    return frame.opcode === 0x03 ? frame.start : frame.end;
  }

  setUnreachable(): void {
    const frame = this.ctrls[this.ctrls.length - 1]!;
    this.vals.length = frame.height;
    frame.unreachable = true;
  }

  label(depth: number): Frame {
    if (depth >= this.ctrls.length) this.invalid(`unknown label ${depth}`);
    return this.ctrls[this.ctrls.length - 1 - depth]!;
  }

  blockType(): FuncType {
    const r = this.r;
    const b = r.peek();
    if (b === 0x40) {
      r.u8();
      return { params: [], results: [] };
    }
    if (
      b === I32 ||
      b === I64 ||
      b === F32 ||
      b === F64 ||
      b === V128 ||
      b === FUNCREF ||
      b === EXTERNREF
    ) {
      return { params: [], results: [this.m.valType(r)] };
    }
    if (b >= 0x60) {
      return { params: [], results: [this.m.valType(r)] };
    }
    const offset = r.pos;
    const index = r.sleb(33);
    if (index < 0) r.malformed("malformed block type");
    this.m.feature("multi-value");
    return this.m.funcTypeAt(index, offset);
  }

  local(index: number): number {
    if (index >= this.locals.length) this.invalid(`unknown local ${index}`);
    return this.locals[index]!;
  }

  global(index: number): Global {
    if (index >= this.m.globals.length) this.invalid(`unknown global ${index}`);
    return this.m.globals[index]!;
  }

  table(index: number): Table {
    if (index >= this.m.tables.length) this.invalid(`unknown table ${index}`);
    return this.m.tables[index]!;
  }

  /** A memory other than 0 (multi-memory): it must exist; typing stops. */
  otherMemory(index: number): void {
    if (index >= this.m.memories) this.invalid(`unknown memory ${index}`);
    this.untyped("multi-memory");
  }

  memoryZero(): void {
    if (this.m.memories === 0) this.invalid("unknown memory 0");
  }

  func(index: number): FuncType {
    if (index >= this.m.funcs.length) this.invalid(`unknown function ${index}`);
    return this.m.funcTypeAt(this.m.funcs[index]!, this.r.pos);
  }

  /** A memarg. A memory other than 0 stops typing (multi-memory). */
  memarg(naturalAlign: number): void {
    const r = this.r;
    const { align, memory } = readMemargFlags(() => r.u32());
    if (align < 0) r.malformed("malformed memop flags");
    if (memory !== 0) this.otherMemory(memory);
    if (this.m.memory64) r.u64();
    else r.u32();
    if (!this.typed) return;
    if (memory >= this.m.memories) this.invalid(`unknown memory ${memory}`);
    if (align > naturalAlign) this.invalid("alignment must not be larger than natural");
  }

  instruction(): void {
    const r = this.r;
    const op = r.u8();
    if (!this.typed) {
      this.scan(op);
      return;
    }
    switch (op) {
      case 0x00:
        this.setUnreachable();
        return;
      case 0x01:
        return;
      case 0x02:
      case 0x03: {
        const bt = this.blockType();
        this.popAll(bt.params);
        this.pushCtrl(op, bt.params, bt.results);
        return;
      }
      case 0x04: {
        const bt = this.blockType();
        this.popExpect(I32);
        this.popAll(bt.params);
        this.pushCtrl(op, bt.params, bt.results);
        return;
      }
      case 0x05: {
        const frame = this.ctrls[this.ctrls.length - 1]!;
        if (frame.opcode !== 0x04 || frame.hasElse) this.invalid("else without matching if");
        this.popCtrl();
        this.pushCtrl(0x04, frame.start, frame.end);
        this.ctrls[this.ctrls.length - 1]!.hasElse = true;
        return;
      }
      case 0x0b: {
        const frame = this.popCtrl();
        // An if without else must leave its params as its results.
        if (frame.opcode === 0x04 && !frame.hasElse) {
          if (frame.start.length !== frame.end.length) this.invalid("type mismatch");
          for (let i = 0; i < frame.start.length; i++) {
            if (frame.start[i] !== frame.end[i]) this.invalid("type mismatch");
          }
        }
        this.pushAll(frame.end);
        return;
      }
      case 0x0c: {
        const depth = r.u32();
        this.popAll(this.labelTypes(this.label(depth)));
        this.setUnreachable();
        return;
      }
      case 0x0d: {
        const depth = r.u32();
        this.popExpect(I32);
        // br_if leaves the label's types (even over unknown operands);
        // br_table below leaves what it popped.
        const types = this.labelTypes(this.label(depth));
        this.popAll(types);
        this.pushAll(types);
        return;
      }
      case 0x0e: {
        const n = r.u32();
        const targets: number[] = [];
        for (let i = 0; i < n; i++) targets.push(r.u32());
        const defaultDepth = r.u32();
        this.popExpect(I32);
        const arity = this.labelTypes(this.label(defaultDepth)).length;
        for (const depth of targets) {
          const types = this.labelTypes(this.label(depth));
          if (types.length !== arity) this.invalid("type mismatch");
          this.pushAll(this.popAll(types));
        }
        this.popAll(this.labelTypes(this.label(defaultDepth)));
        this.setUnreachable();
        return;
      }
      case 0x0f:
        this.popAll(this.type.results);
        this.setUnreachable();
        return;
      case 0x10: {
        const type = this.func(r.u32());
        this.popAll(type.params);
        this.pushAll(type.results);
        return;
      }
      case 0x11: {
        const typeIndex = r.u32();
        const tableIndex = r.u32();
        if (tableIndex !== 0) this.m.feature("reference-types");
        const table = this.table(tableIndex);
        if (table.type !== FUNCREF && table.type !== UNKNOWN) this.invalid("type mismatch");
        const type = this.m.funcTypeAt(typeIndex, r.pos);
        this.popExpect(I32);
        this.popAll(type.params);
        this.pushAll(type.results);
        return;
      }
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
        this.untyped(op === 0x14 || op === 0x15 ? "function-references" : "tail-call");
        this.scan(op);
        return;
      case 0x06:
      case 0x07:
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x18:
      case 0x19:
      case 0x1f:
        this.untyped("exceptions");
        this.scan(op);
        return;
      case 0x1a:
        this.pop();
        return;
      case 0x1b: {
        this.popExpect(I32);
        const t1 = this.pop();
        const t2 = this.pop();
        if (!(isNum(t1) || t1 === UNKNOWN) || !(isNum(t2) || t2 === UNKNOWN))
          this.invalid("type mismatch");
        if (t1 !== t2 && t1 !== UNKNOWN && t2 !== UNKNOWN) this.invalid("type mismatch");
        this.push(t1 === UNKNOWN ? t2 : t1);
        return;
      }
      case 0x1c: {
        const n = r.u32();
        if (n !== 1) this.invalid("invalid result arity");
        const t = this.m.valType(r);
        if (isRef(t)) this.m.feature("reference-types");
        this.popExpect(I32);
        this.popExpect(t);
        this.popExpect(t);
        this.push(t);
        return;
      }
      case 0x20:
        this.push(this.local(r.u32()));
        return;
      case 0x21:
        this.popExpect(this.local(r.u32()));
        return;
      case 0x22: {
        const t = this.local(r.u32());
        this.popExpect(t);
        this.push(t);
        return;
      }
      case 0x23:
        this.push(this.global(r.u32()).type);
        return;
      case 0x24: {
        const global = this.global(r.u32());
        if (!global.mutable) this.invalid("global is immutable");
        this.popExpect(global.type);
        return;
      }
      case 0x25: {
        this.m.feature("reference-types");
        const table = this.table(r.u32());
        this.popExpect(I32);
        this.push(table.type);
        return;
      }
      case 0x26: {
        this.m.feature("reference-types");
        const table = this.table(r.u32());
        this.popExpect(table.type);
        this.popExpect(I32);
        return;
      }
      case 0x3f:
      case 0x40: {
        const memory = r.u8();
        if (memory !== 0) {
          // A memory index (multi-memory) or a malformed reserved byte.
          r.pos--;
          const index = r.u32();
          if (index !== 0) this.otherMemory(index);
          if (!this.typed) return;
        }
        this.memoryZero();
        if (op === 0x40) this.popExpect(I32);
        this.push(I32);
        return;
      }
      case 0x41:
        r.sleb(32);
        this.push(I32);
        return;
      case 0x42:
        r.sleb(64);
        this.push(I64);
        return;
      case 0x43:
        r.skip(4);
        this.push(F32);
        return;
      case 0x44:
        r.skip(8);
        this.push(F64);
        return;
      case 0xd0: {
        this.m.feature("reference-types");
        const t = this.m.refHeapNull(r);
        if (t === UNKNOWN) {
          this.typed = false;
          return;
        }
        this.push(t);
        return;
      }
      case 0xd1: {
        this.m.feature("reference-types");
        const t = this.pop();
        if (!isRef(t) && t !== UNKNOWN) this.invalid("type mismatch");
        this.push(I32);
        return;
      }
      case 0xd2: {
        this.m.feature("reference-types");
        const index = r.u32();
        this.func(index);
        if (!this.m.declaredRefs.has(index)) this.invalid("undeclared function reference");
        this.push(FUNCREF);
        return;
      }
      case 0xd3:
      case 0xd4:
      case 0xd5:
      case 0xd6:
        this.untyped(op === 0xd3 ? "gc" : "function-references");
        this.scan(op);
        return;
      case 0xfc:
        this.prefixFC();
        return;
      case 0xfd:
        this.untyped("simd");
        this.scanSimd();
        return;
      case 0xfe:
        this.untyped("threads");
        this.scanAtomic();
        return;
      case 0xfb:
        this.untyped("gc");
        r.pos = r.end;
        this.ctrls.length = 0;
        return;
    }
    if (op >= 0x28 && op <= 0x3e) {
      const k = op - 0x28;
      this.memarg(MEMORY_ALIGN[k]!);
      if (!this.typed) return;
      this.memoryZero();
      if (op <= 0x35) {
        this.popExpect(I32);
        this.push(MEMORY_TYPE[k]!);
      } else {
        this.popExpect(MEMORY_TYPE[k]!);
        this.popExpect(I32);
      }
      return;
    }
    if (op >= 0x45 && op <= 0xc4) {
      if (op >= 0xc0) this.m.feature("sign-extension");
      const [operand, count, result] = numericSignature(op);
      for (let i = 0; i < count; i++) this.popExpect(operand);
      this.push(result);
      return;
    }
    r.pos--;
    r.malformed(`illegal opcode 0x${op.toString(16)}`);
  }

  prefixFC(): void {
    const r = this.r;
    const sub = r.u32();
    if (sub <= 7) {
      this.m.feature("nontrapping-fptoint");
      const from = sub <= 1 || (sub >= 4 && sub <= 5) ? F32 : F64;
      const to = sub <= 3 ? I32 : I64;
      this.popExpect(from);
      this.push(to);
      return;
    }
    switch (sub) {
      case 8: {
        this.m.feature("bulk-memory");
        const segment = r.u32();
        const memory = r.u32();
        if (memory !== 0) {
          this.otherMemory(memory);
          return;
        }
        this.memoryZero();
        const dataCount = this.m.dataCount;
        if (dataCount === null) return r.malformed("data count section required");
        if (segment >= dataCount) this.invalid(`unknown data segment ${segment}`);
        this.popExpect(I32);
        this.popExpect(I32);
        this.popExpect(I32);
        return;
      }
      case 9: {
        this.m.feature("bulk-memory");
        const segment = r.u32();
        const dataCount = this.m.dataCount;
        if (dataCount === null) return r.malformed("data count section required");
        if (segment >= dataCount) this.invalid(`unknown data segment ${segment}`);
        return;
      }
      case 10: {
        this.m.feature("bulk-memory");
        const dst = r.u32();
        const src = r.u32();
        if (dst !== 0 || src !== 0) {
          this.otherMemory(Math.max(dst, src));
          return;
        }
        this.memoryZero();
        this.popExpect(I32);
        this.popExpect(I32);
        this.popExpect(I32);
        return;
      }
      case 11: {
        this.m.feature("bulk-memory");
        const memory = r.u32();
        if (memory !== 0) {
          this.otherMemory(memory);
          return;
        }
        this.memoryZero();
        this.popExpect(I32);
        this.popExpect(I32);
        this.popExpect(I32);
        return;
      }
      case 12: {
        this.m.feature("bulk-memory");
        const segment = r.u32();
        const table = this.table(r.u32());
        if (segment >= this.m.elemTypes.length) this.invalid(`unknown elem segment ${segment}`);
        const elemType = this.m.elemTypes[segment]!;
        if (!matches(elemType, table.type)) this.invalid("type mismatch");
        this.popExpect(I32);
        this.popExpect(I32);
        this.popExpect(I32);
        return;
      }
      case 13: {
        this.m.feature("bulk-memory");
        const segment = r.u32();
        if (segment >= this.m.elemTypes.length) this.invalid(`unknown elem segment ${segment}`);
        return;
      }
      case 14: {
        this.m.feature("bulk-memory");
        const dst = this.table(r.u32());
        const src = this.table(r.u32());
        if (!matches(src.type, dst.type)) this.invalid("type mismatch");
        this.popExpect(I32);
        this.popExpect(I32);
        this.popExpect(I32);
        return;
      }
      case 15: {
        this.m.feature("reference-types");
        const table = this.table(r.u32());
        this.popExpect(I32);
        this.popExpect(table.type);
        this.push(I32);
        return;
      }
      case 16:
        this.m.feature("reference-types");
        this.table(r.u32());
        this.push(I32);
        return;
      case 17: {
        this.m.feature("reference-types");
        const table = this.table(r.u32());
        this.popExpect(I32);
        this.popExpect(table.type);
        this.popExpect(I32);
        return;
      }
    }
    r.malformed(`illegal opcode 0xfc ${sub}`);
  }

  // ── decode-only scanning (proposals outside the translatable set) ─────

  /** One instruction, decoded for its immediates only. Tracks block
   * nesting so that the body's final end is found. */
  scan(op: number): void {
    const r = this.r;
    switch (op) {
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x06:
        this.scanBlockType();
        this.ctrls.push({
          opcode: op,
          start: [],
          end: [],
          height: 0,
          unreachable: true,
          hasElse: false,
        });
        return;
      case 0x1f: {
        this.m.feature("exceptions");
        this.scanBlockType();
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const kind = r.u8();
          if (kind > 3) r.malformed("malformed catch kind");
          if (kind < 2) r.u32();
          r.u32();
        }
        this.ctrls.push({
          opcode: op,
          start: [],
          end: [],
          height: 0,
          unreachable: true,
          hasElse: false,
        });
        return;
      }
      case 0x0b:
        this.ctrls.pop();
        return;
      case 0x18:
        // delegate ends its try block.
        this.m.feature("exceptions");
        r.u32();
        this.ctrls.pop();
        return;
      case 0xfc:
        this.scanFC();
        return;
      case 0xfd:
        this.m.feature("simd");
        this.scanSimd();
        return;
      case 0xfe:
        this.m.feature("threads");
        this.scanAtomic();
        return;
      case 0xfb:
        this.m.feature("gc");
        r.pos = r.end;
        this.ctrls.length = 0;
        return;
    }
    this.scanImmediates(op);
  }

  scanBlockType(): void {
    const r = this.r;
    const b = r.peek();
    if (b === 0x40) {
      r.u8();
      return;
    }
    if (b >= 0x60) {
      this.m.valType(r);
      return;
    }
    if (r.sleb(33) < 0) r.malformed("malformed block type");
  }

  /** The immediates of a single-byte opcode that opens no block. */
  scanImmediates(op: number): void {
    const r = this.r;
    switch (op) {
      case 0x00:
      case 0x01:
      case 0x05:
      case 0x0f:
      case 0x1a:
      case 0x1b:
      case 0x0a:
      case 0x19:
      case 0xd1:
      case 0xd3:
      case 0xd4:
        if (op === 0x0a || op === 0x19) this.m.feature("exceptions");
        return;
      case 0x07:
      case 0x08:
      case 0x09:
      case 0x0c:
      case 0x0d:
      case 0x10:
      case 0x12:
      case 0x14:
      case 0x15:
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x26:
      case 0xd2:
      case 0xd5:
      case 0xd6:
        if (op === 0x07 || op === 0x08 || op === 0x09) this.m.feature("exceptions");
        if (op === 0x12) this.m.feature("tail-call");
        if (op === 0x14 || op === 0x15 || op === 0xd5 || op === 0xd6)
          this.m.feature("function-references");
        r.u32();
        return;
      case 0x0e: {
        const n = r.u32();
        for (let i = 0; i <= n; i++) r.u32();
        return;
      }
      case 0x11:
      case 0x13:
        if (op === 0x13) this.m.feature("tail-call");
        r.u32();
        r.u32();
        return;
      case 0x1c: {
        const n = r.u32();
        for (let i = 0; i < n; i++) this.m.valType(r);
        return;
      }
      case 0x3f:
      case 0x40:
        r.u32();
        return;
      case 0x41:
        r.sleb(32);
        return;
      case 0x42:
        r.sleb(64);
        return;
      case 0x43:
        r.skip(4);
        return;
      case 0x44:
        r.skip(8);
        return;
      case 0xd0:
        this.m.refHeapNull(r);
        return;
    }
    if (op >= 0x28 && op <= 0x3e) {
      this.scanMemarg();
      return;
    }
    if (op >= 0x45 && op <= 0xc4) {
      if (op >= 0xc0) this.m.feature("sign-extension");
      return;
    }
    r.pos--;
    r.malformed(`illegal opcode 0x${op.toString(16)}`);
  }

  scanMemarg(): void {
    const r = this.r;
    const { align, memory } = readMemargFlags(() => r.u32());
    if (align < 0) r.malformed("malformed memop flags");
    if (memory !== 0) this.m.feature("multi-memory");
    if (this.m.memory64) r.u64();
    else r.u32();
  }

  scanFC(): void {
    const r = this.r;
    const sub = r.u32();
    if (sub <= 7) {
      this.m.feature("nontrapping-fptoint");
      return;
    }
    if (sub > 17) r.malformed(`illegal opcode 0xfc ${sub}`);
    this.m.feature(sub >= 15 ? "reference-types" : "bulk-memory");
    switch (sub) {
      case 8:
      case 10:
      case 12:
      case 14:
        r.u32();
        r.u32();
        return;
      default:
        r.u32();
    }
  }

  scanSimd(): void {
    const r = this.r;
    const sub = r.u32();
    if (sub <= 11 || sub === 92 || sub === 93) {
      this.scanMemarg();
      return;
    }
    if (sub === 12 || sub === 13) {
      r.skip(16);
      return;
    }
    if (sub >= 21 && sub <= 34) {
      r.u8();
      return;
    }
    if (sub >= 84 && sub <= 91) {
      this.scanMemarg();
      r.u8();
      return;
    }
    if (sub > 0x113) r.malformed(`illegal opcode 0xfd ${sub}`);
  }

  scanAtomic(): void {
    const r = this.r;
    const sub = r.u32();
    if (sub === 0x03) {
      if (r.u8() !== 0) r.malformed("zero byte expected");
      return;
    }
    if (sub > 0x4e || (sub > 0x03 && sub < 0x10)) r.malformed(`illegal opcode 0xfe ${sub}`);
    this.scanMemarg();
  }
}

/** Decodes and validates `bytes` (a whole module). Never throws. */
export function analyzeWasm(bytes: Uint8Array): WasmModuleSummary {
  const m = new ModuleDecoder(bytes);
  let status: WasmModuleSummary["status"] = "valid";
  let error: string | null = null;
  try {
    m.decode();
  } catch (e) {
    if (!(e instanceof WasmError)) throw e;
    status = e.kind;
    error = `${e.message} (at byte ${e.offset})`;
  }
  const features: string[] = [];
  const unsupported: string[] = [];
  for (const feature of WASM_FEATURES) {
    if (!m.features.has(feature)) continue;
    features.push(feature);
    if (!TRANSLATABLE.has(feature)) unsupported.push(feature);
  }
  if (status === "valid" && unsupported.length > 0) status = "unsupported";
  return {
    size: bytes.length,
    status,
    error,
    features,
    unsupported,
    functions: Math.max(0, m.funcs.length - m.importedFuncs),
    imports: m.imports,
    exports: m.exports,
    importModules: m.importModules,
    memories: m.memories,
    tables: m.tables.length,
    globals: m.globals.length,
    customSections: m.customSections,
  };
}

/** True when `bytes` starts with the WebAssembly magic and version 1. */
export function isWasmHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d &&
    bytes[4] === 1 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0
  );
}
