/* The structure of a WebAssembly module, for the translator.
 *
 * binary.ts validates a module and keeps nothing but counts. This parser
 * reads the parts translation needs (types, imports, functions, tables,
 * memories, globals, exports, the start function, element and data
 * segments, function bodies and custom sections) from bytes that binary.ts
 * already accepted, so it checks nothing beyond what it must to stay in
 * bounds. Constant expressions and function bodies are kept as byte ranges
 * that the translator reads itself.
 *
 * i64 values never become JavaScript numbers: the translator reads their
 * LEB128 encodings into two 32-bit halves. Plain TypeScript, so the native
 * compiler compiles it too. */

export const VAL_I32 = 0x7f;
export const VAL_I64 = 0x7e;
export const VAL_F32 = 0x7d;
export const VAL_F64 = 0x7c;
export const VAL_FUNCREF = 0x70;
export const VAL_EXTERNREF = 0x6f;

export const KIND_FUNC = 0;
export const KIND_TABLE = 1;
export const KIND_MEMORY = 2;
export const KIND_GLOBAL = 3;

export interface WasmFuncType {
  params: number[];
  results: number[];
}

/** A byte range of the module: a constant expression (through its `end`
 * opcode) or a payload. */
export interface WasmRange {
  start: number;
  end: number;
}

export interface WasmImport {
  module: string;
  name: string;
  kind: number;
  /** Functions: the type index. Tables and globals: the value type. */
  type: number;
  min: number;
  max: number | null;
  mutable: boolean;
}

export interface WasmTable {
  elemType: number;
  min: number;
  max: number | null;
  imported: boolean;
  /** A defined table's initializer (reference-types table with an init
   * expression), or null for the null reference. */
  init: WasmRange | null;
}

export interface WasmMemory {
  min: number;
  max: number | null;
  imported: boolean;
}

export interface WasmGlobal {
  type: number;
  mutable: boolean;
  imported: boolean;
  init: WasmRange | null;
}

export interface WasmExport {
  name: string;
  kind: number;
  index: number;
}

export interface WasmElem {
  mode: "active" | "passive" | "declarative";
  table: number;
  offset: WasmRange | null;
  elemType: number;
  /** One initializer per element: a function index (>= 0), or -1 when the
   * element is a constant expression in `exprs`. */
  funcs: number[];
  exprs: (WasmRange | null)[];
}

export interface WasmData {
  mode: "active" | "passive";
  memory: number;
  offset: WasmRange | null;
  payload: WasmRange;
}

export interface WasmCode {
  /** Declared locals, expanded (not including parameters). */
  locals: number[];
  body: WasmRange;
}

export interface WasmCustom {
  name: string;
  payload: WasmRange;
}

export interface WasmModule {
  bytes: Uint8Array;
  types: WasmFuncType[];
  imports: WasmImport[];
  /** The type index of every function, imported functions first. */
  funcTypes: number[];
  importedFuncs: number;
  tables: WasmTable[];
  memories: WasmMemory[];
  globals: WasmGlobal[];
  exports: WasmExport[];
  start: number | null;
  elems: WasmElem[];
  datas: WasmData[];
  codes: WasmCode[];
  customs: WasmCustom[];
  /** Functions referenced outside a body (exports, element segments,
   * ref.func in constant expressions): only these need a function
   * reference record. Bodies add their own ref.func targets, which a valid
   * module also declares in one of these places. */
  declaredRefs: Set<number>;
}

/** A byte cursor over a module that binary.ts validated. */
export class WasmCursor {
  bytes: Uint8Array;
  pos: number;
  constructor(bytes: Uint8Array, pos: number) {
    this.bytes = bytes;
    this.pos = pos;
  }

  u8(): number {
    const b = this.bytes[this.pos];
    if (b === undefined) throw new Error("wasm: unexpected end of module");
    this.pos++;
    return b;
  }

  u32(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
  }

  /** A signed LEB128 of at most 33 bits. */
  s33(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * scale;
      scale *= 128;
      if ((b & 0x80) === 0) {
        if (b & 0x40) result -= scale;
        return result;
      }
    }
  }

  /** A signed 32-bit LEB128 as a signed 32-bit number. */
  s32(): number {
    return this.s33() | 0;
  }

  /** A signed 64-bit LEB128 as its two's-complement halves [lo, hi], each
   * an unsigned 32-bit number. */
  s64(): [number, number] {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    let b = 0;
    do {
      b = this.u8();
      const bits = b & 0x7f;
      if (shift < 32) {
        lo = (lo | (bits << shift)) >>> 0;
        if (shift > 25) hi = (hi | (bits >>> (32 - shift))) >>> 0;
      } else if (shift < 64) {
        hi = (hi | (bits << (shift - 32))) >>> 0;
      }
      shift += 7;
    } while (b & 0x80);
    if (shift < 64 && b & 0x40) {
      // Sign-extend from bit `shift`.
      if (shift < 32) {
        lo = (lo | (~0 << shift)) >>> 0;
        hi = 0xffffffff;
      } else {
        hi = (hi | (~0 << (shift - 32))) >>> 0;
      }
    }
    return [lo, hi];
  }

  u32le(): number {
    const b = this.bytes;
    const p = this.pos;
    this.pos += 4;
    return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
  }

  name(): string {
    const length = this.u32();
    const start = this.pos;
    this.pos += length;
    return decodeUtf8(this.bytes, start, this.pos);
  }

  /** Skips a constant expression through its `end` and answers its range. */
  constExpr(): WasmRange {
    const start = this.pos;
    for (;;) {
      const op = this.u8();
      if (op === 0x0b) break;
      skipImmediates(this, op);
    }
    return { start, end: this.pos };
  }

  valType(): number {
    return this.u8();
  }

  /** A block type: -1 for the empty type, a value type, or a type index. */
  blockType():
    | { kind: "empty" }
    | { kind: "value"; type: number }
    | { kind: "index"; index: number } {
    const b = this.bytes[this.pos]!;
    if (b === 0x40) {
      this.pos++;
      return { kind: "empty" };
    }
    if (
      b === VAL_I32 ||
      b === VAL_I64 ||
      b === VAL_F32 ||
      b === VAL_F64 ||
      b === VAL_FUNCREF ||
      b === VAL_EXTERNREF
    ) {
      this.pos++;
      return { kind: "value", type: b };
    }
    return { kind: "index", index: this.s33() };
  }
}

function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  let i = start;
  while (i < end) {
    const b = bytes[i]!;
    let cp = b;
    let need = 0;
    if (b >= 0xf0) {
      cp = b & 0x07;
      need = 3;
    } else if (b >= 0xe0) {
      cp = b & 0x0f;
      need = 2;
    } else if (b >= 0xc0) {
      cp = b & 0x1f;
      need = 1;
    }
    for (let k = 1; k <= need; k++) cp = cp * 64 + (bytes[i + k]! & 0x3f);
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** The flags of a memarg (the immediates of loads, stores and atomics):
 * the alignment exponent and the memory index. Flags with bit 6 set
 * (multi-memory) are followed by an explicit memory index, which may be
 * 0; flags of 128 or more are malformed and answer align -1 without
 * reading further. The offset follows. Validation (binary.ts), translation
 * and skipImmediates all read memargs through this function, so they agree
 * on where each instruction ends; `u32` reads the next u32 immediate of
 * their own reader. */
export function readMemargFlags(u32: () => number): { align: number; memory: number } {
  const flags = u32();
  if (flags >= 128) return { align: -1, memory: 0 };
  if (flags >= 64) return { align: flags - 64, memory: u32() };
  return { align: flags, memory: 0 };
}

/** Reads the immediates of opcode `op` (already consumed). Covers the
 * translatable feature level; anything else was refused before
 * translation. */
export function skipImmediates(c: WasmCursor, op: number): void {
  switch (op) {
    case 0x02:
    case 0x03:
    case 0x04:
      c.blockType();
      return;
    case 0x0c:
    case 0x0d:
    case 0x10:
    case 0x20:
    case 0x21:
    case 0x22:
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26:
    case 0xd2:
      c.u32();
      return;
    case 0x0e: {
      const n = c.u32();
      for (let i = 0; i <= n; i++) c.u32();
      return;
    }
    case 0x11:
      c.u32();
      c.u32();
      return;
    case 0x1c: {
      const n = c.u32();
      for (let i = 0; i < n; i++) c.valType();
      return;
    }
    case 0x3f:
    case 0x40:
      // The memory index (a LEB128 zero; V8 accepts long encodings).
      c.u32();
      return;
    case 0x41:
      c.s32();
      return;
    case 0x42:
      c.s64();
      return;
    case 0x43:
      c.pos += 4;
      return;
    case 0x44:
      c.pos += 8;
      return;
    case 0xd0:
      c.valType();
      return;
    case 0xfc: {
      const sub = c.u32();
      switch (sub) {
        case 8:
          c.u32();
          c.u32();
          return;
        case 9:
        case 13:
        case 15:
        case 16:
        case 17:
          c.u32();
          return;
        case 10:
          c.u32();
          c.u32();
          return;
        case 11:
          c.u32();
          return;
        case 12:
        case 14:
          c.u32();
          c.u32();
          return;
        default:
          return;
      }
    }
    default:
      if (op >= 0x28 && op <= 0x3e) {
        const flags = readMemargFlags(() => c.u32());
        if (flags.align < 0 || flags.memory !== 0)
          throw new Error(`wasm: memarg of memory ${flags.memory} is not supported`);
        c.u32();
      }
      return;
  }
}

function limits(c: WasmCursor): { min: number; max: number | null } {
  const flags = c.u8();
  const min = c.u32();
  const max = flags & 0x01 ? c.u32() : null;
  return { min, max };
}

/** Parses a module binary.ts reported as valid within the translatable
 * feature level. */
export function parseWasmModule(bytes: Uint8Array): WasmModule {
  const m: WasmModule = {
    bytes,
    types: [],
    imports: [],
    funcTypes: [],
    importedFuncs: 0,
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    start: null,
    elems: [],
    datas: [],
    codes: [],
    customs: [],
    declaredRefs: new Set<number>(),
  };
  const c = new WasmCursor(bytes, 8);
  while (c.pos < bytes.length) {
    const id = c.u8();
    const size = c.u32();
    const end = c.pos + size;
    switch (id) {
      case 0: {
        const name = c.name();
        m.customs.push({ name, payload: { start: c.pos, end } });
        break;
      }
      case 1: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          c.u8(); // 0x60
          const params: number[] = [];
          const np = c.u32();
          for (let k = 0; k < np; k++) params.push(c.valType());
          const results: number[] = [];
          const nr = c.u32();
          for (let k = 0; k < nr; k++) results.push(c.valType());
          m.types.push({ params, results });
        }
        break;
      }
      case 2: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          const module = c.name();
          const name = c.name();
          const kind = c.u8();
          const imp: WasmImport = {
            module,
            name,
            kind,
            type: 0,
            min: 0,
            max: null,
            mutable: false,
          };
          if (kind === KIND_FUNC) {
            imp.type = c.u32();
            m.funcTypes.push(imp.type);
            m.importedFuncs++;
          } else if (kind === KIND_TABLE) {
            imp.type = c.valType();
            const l = limits(c);
            imp.min = l.min;
            imp.max = l.max;
            m.tables.push({
              elemType: imp.type,
              min: l.min,
              max: l.max,
              imported: true,
              init: null,
            });
          } else if (kind === KIND_MEMORY) {
            const l = limits(c);
            imp.min = l.min;
            imp.max = l.max;
            m.memories.push({ min: l.min, max: l.max, imported: true });
          } else {
            imp.type = c.valType();
            imp.mutable = c.u8() === 1;
            m.globals.push({ type: imp.type, mutable: imp.mutable, imported: true, init: null });
          }
          m.imports.push(imp);
        }
        break;
      }
      case 3: {
        const n = c.u32();
        for (let i = 0; i < n; i++) m.funcTypes.push(c.u32());
        break;
      }
      case 4: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          let init: WasmRange | null = null;
          if (c.bytes[c.pos] === 0x40) {
            // table with an initializer: 0x40 0x00 tabletype expr
            c.pos += 2;
            const elemType = c.valType();
            const l = limits(c);
            init = c.constExpr();
            m.tables.push({ elemType, min: l.min, max: l.max, imported: false, init });
            continue;
          }
          const elemType = c.valType();
          const l = limits(c);
          m.tables.push({ elemType, min: l.min, max: l.max, imported: false, init });
        }
        break;
      }
      case 5: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          const l = limits(c);
          m.memories.push({ min: l.min, max: l.max, imported: false });
        }
        break;
      }
      case 6: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          const type = c.valType();
          const mutable = c.u8() === 1;
          const init = c.constExpr();
          noteConstRefs(m, init);
          m.globals.push({ type, mutable, imported: false, init });
        }
        break;
      }
      case 7: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          const name = c.name();
          const kind = c.u8();
          const index = c.u32();
          m.exports.push({ name, kind, index });
          if (kind === KIND_FUNC) m.declaredRefs.add(index);
        }
        break;
      }
      case 8:
        m.start = c.u32();
        break;
      case 9: {
        const n = c.u32();
        for (let i = 0; i < n; i++) m.elems.push(elemSegment(m, c));
        break;
      }
      case 10: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          const size = c.u32();
          const bodyEnd = c.pos + size;
          const locals: number[] = [];
          const groups = c.u32();
          for (let g = 0; g < groups; g++) {
            const count = c.u32();
            const type = c.valType();
            for (let k = 0; k < count; k++) locals.push(type);
          }
          m.codes.push({ locals, body: { start: c.pos, end: bodyEnd } });
          c.pos = bodyEnd;
        }
        break;
      }
      case 11: {
        const n = c.u32();
        for (let i = 0; i < n; i++) {
          const flags = c.u32();
          if (flags === 1) {
            const size = c.u32();
            m.datas.push({
              mode: "passive",
              memory: 0,
              offset: null,
              payload: { start: c.pos, end: c.pos + size },
            });
            c.pos += size;
            continue;
          }
          const memory = flags === 2 ? c.u32() : 0;
          const offset = c.constExpr();
          const size = c.u32();
          m.datas.push({
            mode: "active",
            memory,
            offset,
            payload: { start: c.pos, end: c.pos + size },
          });
          c.pos += size;
        }
        break;
      }
      default:
        // 12 (data count) and anything binary.ts accepted without content
        // translation needs.
        break;
    }
    c.pos = end;
  }
  return m;
}

function elemSegment(m: WasmModule, c: WasmCursor): WasmElem {
  const flags = c.u32();
  const passiveOrDeclarative = (flags & 1) !== 0;
  const explicitTable = (flags & 2) !== 0;
  const usesExprs = (flags & 4) !== 0;
  let mode: WasmElem["mode"] = "active";
  if (passiveOrDeclarative) mode = explicitTable ? "declarative" : "passive";
  let table = 0;
  let offset: WasmRange | null = null;
  if (!passiveOrDeclarative) {
    if (explicitTable) table = c.u32();
    offset = c.constExpr();
  }
  let elemType = VAL_FUNCREF;
  if (passiveOrDeclarative || explicitTable) {
    // elemkind (0x00 = funcref) or a reference type
    const b = c.u8();
    elemType = usesExprs ? b : VAL_FUNCREF;
  }
  const n = c.u32();
  const funcs: number[] = [];
  const exprs: (WasmRange | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (usesExprs) {
      const expr = c.constExpr();
      const direct = refFuncOf(m.bytes, expr);
      if (direct !== null) {
        funcs.push(direct);
        exprs.push(null);
        m.declaredRefs.add(direct);
      } else {
        noteConstRefs(m, expr);
        funcs.push(-1);
        exprs.push(expr);
      }
    } else {
      const f = c.u32();
      funcs.push(f);
      exprs.push(null);
      m.declaredRefs.add(f);
    }
  }
  return { mode, table, offset, elemType, funcs, exprs };
}

/** The function of a `ref.func f; end` expression, or null. */
function refFuncOf(bytes: Uint8Array, expr: WasmRange): number | null {
  if (bytes[expr.start] !== 0xd2) return null;
  const c = new WasmCursor(bytes, expr.start + 1);
  const f = c.u32();
  return c.pos === expr.end - 1 && bytes[c.pos] === 0x0b ? f : null;
}

function noteConstRefs(m: WasmModule, expr: WasmRange): void {
  const c = new WasmCursor(m.bytes, expr.start);
  while (c.pos < expr.end) {
    const op = c.u8();
    if (op === 0xd2) {
      m.declaredRefs.add(c.u32());
      continue;
    }
    skipImmediates(c, op);
  }
}
