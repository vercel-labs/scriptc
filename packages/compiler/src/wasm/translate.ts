/* WebAssembly to LLVM IR.
 *
 * Translates one validated module (binary.ts accepted it within the
 * translatable feature level) to LLVM assembly that the program's emitter
 * appends to its own module, so the native helper optimizes, partitions and
 * caches it with the program. The runtime (scr_wasm.c) implements the
 * JavaScript API over the descriptor this emits; scr_wasm_abi.h is the
 * contract both sides follow.
 *
 * Shape of the output:
 *   - one internal function per wasm function, taking the instance as its
 *     first parameter (`ptr %inst`) and the wasm values directly (i32, i64,
 *     float, double; references are pointers). Several results return as a
 *     literal struct. An imported function is a stub that packs its
 *     arguments and calls scr_wasm_import_call.
 *   - one thunk per exported function, `void (ptr inst, ptr args, ptr
 *     results)` over 64-bit slots, which the runtime calls under its trap
 *     guard;
 *   - an init function (globals, table initializers, active element and
 *     data segments); the descriptor names the start function;
 *   - constant data (segments, names, signatures) and the descriptor.
 *
 * The instance layout (scr_wasm_abi.h): host at 0, memory base at 8,
 * memory object at 16, function reference records at 24, then one pointer
 * per table and one cell pointer per global.
 *
 * Memory accesses compute `base + zext(address) + offset` in 64 bits. With
 * guard pages (64-bit hosts) the runtime reserves enough address space that
 * every such address past the memory faults, so accesses are unchecked and
 * the base is loaded once per function (the memory never moves). With
 * explicit bounds checks (sanitizer builds and hosts without the fault
 * handler) the base and byte length live in function-local slots that are
 * reloaded after every call and memory.grow.
 *
 * Locals, block results and loop parameters are allocas; LLVM promotes them
 * to SSA values. Traps call scr_wasm_trap, which never returns. Plain
 * TypeScript without bigint, so the native compiler compiles it too. */
import {
  KIND_FUNC,
  KIND_GLOBAL,
  KIND_MEMORY,
  KIND_TABLE,
  VAL_EXTERNREF,
  VAL_F32,
  VAL_F64,
  VAL_FUNCREF,
  VAL_I32,
  VAL_I64,
  VAL_V128,
  WasmCursor,
  parseWasmModule,
  readMemargFlags,
  skipImmediates,
  type WasmFuncType,
  type WasmModule,
  type WasmRange,
} from "./module.js";
import { simdOp } from "./simd.js";

/** Trap codes (scr_wasm_abi.h SCR_WASM_TRAP_*). */
export const TRAP_UNREACHABLE = 1;
export const TRAP_MEMORY_OOB = 2;
export const TRAP_DIV_BY_ZERO = 3;
export const TRAP_DIV_UNREPRESENTABLE = 4;
export const TRAP_REM_BY_ZERO = 5;
export const TRAP_FLOAT_UNREPRESENTABLE = 6;
export const TRAP_TABLE_OOB = 7;
export const TRAP_SIGNATURE = 8;
export const TRAP_NULL = 9;
/** scr_wasm_abi.h SCR_WASM_TRAP_EXHAUSTION. */
export const TRAP_EXHAUSTION = 100;

/** The descriptor ABI version both sides agree on. */
/** The descriptor version: 2 for scalar modules (unchanged), 3 when a
 * module carries v128 in a signature or global. The runtime accepts both. */
export const WASM_ABI_VERSION = 3;
export const WASM_ABI_VERSION_SCALAR = 2;

/** Instance slot offsets (bytes). */
const OFF_MEMBASE = 8;
const OFF_MEMORY = 16;
const OFF_FUNCREFS = 24;
const OFF_TABLES = 32;
/** sizeof(ScrWasmFuncRef). */
const FUNCREF_SIZE = 24;

/** The canonical LLVM type of a v128 value. Every lane shape is a bitcast of
 * it. */
const V4I32 = "<4 x i32>";
const V16I8 = "<16 x i8>";
const V8I16 = "<8 x i16>";
const V2I64 = "<2 x i64>";
const V4F32 = "<4 x float>";
const V2F64 = "<2 x double>";

/** One lane shape's LLVM type, lane type and lane count. */
interface LaneShape {
  type: string;
  lane: string;
  count: number;
}

const SHAPE_I8: LaneShape = { type: V16I8, lane: "i8", count: 16 };
const SHAPE_I16: LaneShape = { type: V8I16, lane: "i16", count: 8 };
const SHAPE_I32: LaneShape = { type: V4I32, lane: "i32", count: 4 };
const SHAPE_I64: LaneShape = { type: V2I64, lane: "i64", count: 2 };
const SHAPE_F32: LaneShape = { type: V4F32, lane: "float", count: 4 };
const SHAPE_F64: LaneShape = { type: V2F64, lane: "double", count: 2 };

function hasV128(types: readonly number[]): boolean {
  for (const t of types) if (t === VAL_V128) return true;
  return false;
}

export interface WasmTranslateOptions {
  /** Explicit bounds checks instead of guard pages. */
  boundsChecks: boolean;
  /** Keep the custom sections, for WebAssembly.Module.customSections. */
  customSections?: boolean;
  /** Attributes every translated function carries besides the translator's
   * own, such as the build's `"target-cpu"` level. */
  targetAttributes?: string;
}

export interface WasmTranslation {
  /** External declarations, one line each. */
  decls: string[];
  /** Definitions in the emitter's top-level grammar. */
  text: string[];
  /** The descriptor's symbol (internal). */
  descriptor: string;
}

/** A construct the translator does not support in an otherwise valid module. */
export class WasmTranslateError extends Error {}

/** Attributes of translated functions. Recursion must exhaust the stack
 * as it does in V8, so LLVM may not turn self-recursion into loops (tail
 * recursion elimination, including its accumulator form, which would make
 * `f(x) + 1` recursion loop forever) or calls into jumps. */
const FUNC_ATTRS = `nounwind "disable-tail-calls"="true"`;

const RUNTIME_DECLS = [
  "declare void @scr_wasm_trap(i32) noreturn nounwind cold",
  "declare void @scr_wasm_import_call(ptr, i32, ptr, ptr)",
  "declare i32 @scr_wasm_memory_grow(ptr, i32)",
  "declare void @scr_wasm_memory_fill(ptr, i32, i32, i32)",
  "declare void @scr_wasm_memory_copy(ptr, i32, i32, i32)",
  "declare void @scr_wasm_memory_init(ptr, i32, i32, i32, i32)",
  "declare void @scr_wasm_data_drop(ptr, i32)",
  "declare ptr @scr_wasm_table_get(ptr, i32, i32)",
  "declare void @scr_wasm_table_set(ptr, i32, i32, ptr)",
  "declare i32 @scr_wasm_table_grow(ptr, i32, ptr, i32)",
  "declare void @scr_wasm_table_fill(ptr, i32, i32, ptr, i32)",
  "declare void @scr_wasm_table_copy(ptr, i32, i32, i32, i32, i32)",
  "declare void @scr_wasm_table_init(ptr, i32, i32, i32, i32, i32)",
  "declare void @scr_wasm_elem_drop(ptr, i32)",
  "declare void @scr_wasm_global_set_ref(ptr, ptr)",
];

function llType(t: number): string {
  switch (t) {
    case VAL_I32:
      return "i32";
    case VAL_I64:
      return "i64";
    case VAL_F32:
      return "float";
    case VAL_F64:
      return "double";
    case VAL_V128:
      return V4I32;
    case VAL_FUNCREF:
    case VAL_EXTERNREF:
      return "ptr";
    default:
      throw new WasmTranslateError(`value type 0x${t.toString(16)} is not supported`);
  }
}

function zeroOf(t: number): string {
  switch (t) {
    case VAL_I32:
    case VAL_I64:
      return "0";
    case VAL_F32:
    case VAL_F64:
      return "0.0";
    case VAL_V128:
      return "zeroinitializer";
    default:
      return "null";
  }
}

/** The runtime's signature letter of a value type. */
function sigChar(t: number): string {
  switch (t) {
    case VAL_I32:
      return "i";
    case VAL_I64:
      return "I";
    case VAL_F32:
      return "f";
    case VAL_F64:
      return "F";
    case VAL_V128:
      return "V";
    case VAL_FUNCREF:
      return "r";
    case VAL_EXTERNREF:
      return "x";
    default:
      throw new WasmTranslateError(`value type 0x${t.toString(16)} is not supported`);
  }
}

function sigString(ft: WasmFuncType): string {
  let s = "";
  for (const p of ft.params) s += sigChar(p);
  s += ":";
  for (const r of ft.results) s += sigChar(r);
  return s;
}

function retType(results: readonly number[]): string {
  if (results.length === 0) return "void";
  if (results.length === 1) return llType(results[0]!);
  return `{ ${results.map(llType).join(", ")} }`;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/** An i64 constant from its halves, in LLVM's unsigned hexadecimal form. */
function i64Lit(lo: number, hi: number): string {
  return `u0x${hex8(hi)}${hex8(lo)}`;
}

/** The canonical signature identity call_indirect compares: two
 * independent 32-bit FNV-1a hashes of the signature text. Equal signatures
 * in different modules get the same identity. */
export function signatureHash(sig: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < sig.length; i++) {
    const c = sig.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return i64Lit(a >>> 0, b >>> 0);
}

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/** An LLVM c"..." string body for bytes. */
export function cBytes(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    if (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c) s += String.fromCharCode(b);
    else s += "\\" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
  }
  return s;
}

interface StackValue {
  v: string;
  t: number;
  /** The line of the load that produced the value (this.lines). */
  load?: number;
}

interface Frame {
  kind: "block" | "loop" | "if" | "func";
  params: number[];
  results: number[];
  /** Branch target: the loop header, or the end label. */
  target: string;
  end: string;
  /** Allocas the values of a branch to this frame are stored in: the loop
   * parameters for a loop, the results otherwise. */
  branchSlots: string[];
  /** Allocas of the results at the frame's end (loops: their own). */
  resultSlots: string[];
  height: number;
  /** An if whose else branch has not started. */
  elseLabel: string | null;
  /** The parameter values of an if, for its implicit else. */
  ifParams: StackValue[];
  /** The start of the frame was reachable. */
  live: boolean;
}

class Lines {
  lines: string[] = [];
  add(line: string): void {
    this.lines.push(line);
  }
}

/** Appends `lines` one at a time. A function body, its locals' entries and a
 * module's text hold more lines than one call can take as arguments. */
function appendLines(out: string[], lines: readonly string[]): void {
  for (const line of lines) out.push(line);
}

/** One module's translation. */
class ModuleTranslator {
  m: WasmModule;
  p: string;
  opts: WasmTranslateOptions;
  text: string[] = [];
  /** Functions that need a reference record. */
  refs: Set<number>;
  /** Functions whose entry checks the stack (stackCheckedFunctions). */
  stackChecked: Set<number>;
  typeHashes: string[];
  memoryCount: number;
  /** Attributes on the functions a module defines. */
  attrs: string;
  /** Attributes on the boundary thunks and the init function, which the
   * runtime calls directly. */
  thunkAttrs: string;
  /** The descriptor ABI version this module's descriptor carries. */
  abiVersion: number;
  /** Whether a v128 import needs scr_wasm_import_funcref. */
  needsImportFuncref = false;

  /** LLVM intrinsic declarations the translated code calls. */
  intrinsics = new Set<string>();

  /** Records an intrinsic declaration, once per module. */
  intrinsic(decl: string): void {
    this.intrinsics.add(decl);
  }

  constructor(m: WasmModule, prefix: string, opts: WasmTranslateOptions) {
    this.m = m;
    this.p = prefix;
    this.opts = opts;
    this.attrs = `${FUNC_ATTRS}${opts.targetAttributes ?? ""}`;
    this.thunkAttrs = `nounwind${opts.targetAttributes ?? ""}`;
    this.refs = new Set(m.declaredRefs);
    this.typeHashes = m.types.map((t) => signatureHash(sigString(t)));
    this.memoryCount = m.memories.length;
    if (m.memories.length > 1) throw new WasmTranslateError("multiple memories are not supported");
    let vectors = false;
    for (const t of m.types) {
      if (hasV128(t.params) || hasV128(t.results)) vectors = true;
    }
    for (const global of m.globals) {
      if (global.type === VAL_V128) vectors = true;
    }
    this.abiVersion = vectors ? WASM_ABI_VERSION : WASM_ABI_VERSION_SCALAR;
    this.stackChecked = stackCheckedFunctions(m);
  }

  fn(index: number): string {
    return `@${this.p}_f${index}`;
  }

  funcType(index: number): WasmFuncType {
    return this.m.types[this.m.funcTypes[index]!]!;
  }

  globalSlot(index: number): number {
    return OFF_TABLES + 8 * (this.m.tables.length + index);
  }

  tableSlot(index: number): number {
    return OFF_TABLES + 8 * index;
  }

  signature(ft: WasmFuncType, name: string): string {
    const params = ["ptr %inst"];
    for (let i = 0; i < ft.params.length; i++) params.push(`${llType(ft.params[i]!)} %p${i}`);
    return `${retType(ft.results)} ${name}(${params.join(", ")})`;
  }

  translate(): void {
    const m = this.m;
    for (let i = 0; i < m.importedFuncs; i++) this.importStub(i);
    for (let i = 0; i < m.codes.length; i++) {
      const index = m.importedFuncs + i;
      const f = new FunctionTranslator(this, index);
      appendLines(this.text, f.translate());
    }
  }

  importStub(index: number): void {
    const ft = this.funcType(index);
    if (hasV128(ft.params) || hasV128(ft.results)) {
      this.importVecStub(index, ft);
      return;
    }
    const out: string[] = [];
    out.push(`define internal ${this.signature(ft, this.fn(index))} ${this.thunkAttrs} {`);
    out.push(`entry:`);
    const np = Math.max(1, ft.params.length);
    const nr = Math.max(1, ft.results.length);
    out.push(`  %args = alloca [${np} x i64], align 8`);
    out.push(`  %res = alloca [${nr} x i64], align 8`);
    for (let i = 0; i < ft.params.length; i++) {
      const slot = toSlot(out, ft.params[i]!, `%p${i}`, `a${i}`);
      out.push(`  %ap${i} = getelementptr i64, ptr %args, i64 ${i}`);
      out.push(`  store i64 ${slot}, ptr %ap${i}`);
    }
    out.push(`  %host = load ptr, ptr %inst`);
    out.push(`  call void @scr_wasm_import_call(ptr %host, i32 ${index}, ptr %args, ptr %res)`);
    emitSlotReturn(out, ft.results, "%res");
    out.push(`}`);
    this.text.push(out.join("\n"));
  }

  /** A v128-carrying import: call the imported WebAssembly function's code
   * directly, with the vectors in registers. The runtime resolves the
   * import to its function reference and throws Node's TypeError when the
   * import is a plain JavaScript function. */
  importVecStub(index: number, ft: WasmFuncType): void {
    this.needsImportFuncref = true;
    const out: string[] = [];
    out.push(`define internal ${this.signature(ft, this.fn(index))} ${this.thunkAttrs} {`);
    out.push(`entry:`);
    const args: string[] = [];
    for (let i = 0; i < ft.params.length; i++) args.push(`${llType(ft.params[i]!)} %p${i}`);
    out.push(`  %host = load ptr, ptr %inst`);
    out.push(`  %ref = call ptr @scr_wasm_import_funcref(ptr %host, i32 ${index})`);
    out.push(`  %code.p = getelementptr inbounds i8, ptr %ref, i64 0`);
    out.push(`  %code = load ptr, ptr %code.p, align 8`);
    out.push(`  %cinst.p = getelementptr inbounds i8, ptr %ref, i64 16`);
    out.push(`  %cinst = load ptr, ptr %cinst.p, align 8`);
    const call = `%code(ptr %cinst${args.length > 0 ? ", " + args.join(", ") : ""})`;
    const ret = retType(ft.results);
    if (ft.results.length === 0) {
      out.push(`  call void ${call}`);
      out.push(`  ret void`);
    } else {
      out.push(`  %r = call ${ret} ${call}`);
      out.push(`  ret ${ret} %r`);
    }
    out.push(`}`);
    this.text.push(out.join("\n"));
  }

  /** The thunk the runtime calls for exported function `index`. */
  exportThunk(index: number): string {
    const name = `@${this.p}_x${index}`;
    const ft = this.funcType(index);
    if (hasV128(ft.params) || hasV128(ft.results)) {
      throw new WasmTranslateError("v128 in an exported function signature is not supported yet");
    }
    const out: string[] = [];
    out.push(`define internal void ${name}(ptr %inst, ptr %a, ptr %r) ${this.thunkAttrs} {`);
    out.push(`entry:`);
    const args: string[] = ["ptr %inst"];
    for (let i = 0; i < ft.params.length; i++) {
      out.push(`  %ap${i} = getelementptr i64, ptr %a, i64 ${i}`);
      out.push(`  %as${i} = load i64, ptr %ap${i}`);
      args.push(`${llType(ft.params[i]!)} ${fromSlot(out, ft.params[i]!, `%as${i}`, `a${i}`)}`);
    }
    const ret = retType(ft.results);
    if (ft.results.length === 0) {
      out.push(`  call void ${this.fn(index)}(${args.join(", ")})`);
    } else {
      out.push(`  %res = call ${ret} ${this.fn(index)}(${args.join(", ")})`);
      for (let i = 0; i < ft.results.length; i++) {
        let v = "%res";
        if (ft.results.length > 1) {
          out.push(`  %rv${i} = extractvalue ${ret} %res, ${i}`);
          v = `%rv${i}`;
        }
        const slot = toSlot(out, ft.results[i]!, v, `r${i}`);
        out.push(`  %rp${i} = getelementptr i64, ptr %r, i64 ${i}`);
        out.push(`  store i64 ${slot}, ptr %rp${i}`);
      }
    }
    out.push(`  ret void`);
    out.push(`}`);
    this.text.push(out.join("\n"));
    return name;
  }

  /** A call thunk for signature `type`: `(code, inst, args, results)`
   * calls `code` (a function of that signature) with the arguments in
   * 64-bit slots. The runtime calls a function reference that reaches
   * JavaScript through it when the module does not export the function. */
  callThunk(type: number): string {
    const name = `@${this.p}_k${type}`;
    const ft = this.m.types[type]!;
    if (hasV128(ft.params) || hasV128(ft.results)) {
      throw new WasmTranslateError("v128 in a function reference's signature is not supported yet");
    }
    const out: string[] = [];
    out.push(
      `define internal void ${name}(ptr %code, ptr %inst, ptr %a, ptr %r) ${this.thunkAttrs} {`,
    );
    out.push(`entry:`);
    const args: string[] = ["ptr %inst"];
    for (let i = 0; i < ft.params.length; i++) {
      out.push(`  %ap${i} = getelementptr i64, ptr %a, i64 ${i}`);
      out.push(`  %as${i} = load i64, ptr %ap${i}`);
      args.push(`${llType(ft.params[i]!)} ${fromSlot(out, ft.params[i]!, `%as${i}`, `a${i}`)}`);
    }
    const ret = retType(ft.results);
    if (ft.results.length === 0) {
      out.push(`  call void %code(${args.join(", ")})`);
    } else {
      out.push(`  %res = call ${ret} %code(${args.join(", ")})`);
      for (let i = 0; i < ft.results.length; i++) {
        let v = "%res";
        if (ft.results.length > 1) {
          out.push(`  %rv${i} = extractvalue ${ret} %res, ${i}`);
          v = `%rv${i}`;
        }
        const slot = toSlot(out, ft.results[i]!, v, `r${i}`);
        out.push(`  %rp${i} = getelementptr i64, ptr %r, i64 ${i}`);
        out.push(`  store i64 ${slot}, ptr %rp${i}`);
      }
    }
    out.push(`  ret void`);
    out.push(`}`);
    this.text.push(out.join("\n"));
    return name;
  }

  /** Emits the init function: globals, table initializers and segments,
   * in the specification's order. The runtime calls the start function
   * (which takes and returns nothing) separately. */
  initFunction(): string {
    const m = this.m;
    const name = `@${this.p}_init`;
    const f = new FunctionTranslator(this, -1);
    const body = f.lines;
    // Globals.
    for (let g = 0; g < m.globals.length; g++) {
      const global = m.globals[g]!;
      if (global.imported || global.init === null) continue;
      const v = f.constExpr(global.init);
      const cell = f.loadPtrSlot(this.globalSlot(g));
      if (global.type === VAL_EXTERNREF) {
        // A defined externref global starts as null or another global's
        // value; the runtime's setter retains it.
        body.add(`  call void @scr_wasm_global_set_ref(ptr ${cell}, ptr ${v})`);
      } else if (global.type === VAL_V128) {
        body.add(`  store ${llType(global.type)} ${v}, ptr ${cell}, align 8`);
      } else {
        body.add(`  store ${llType(global.type)} ${v}, ptr ${cell}`);
      }
    }
    // Defined tables with an initializer.
    for (let t = 0; t < m.tables.length; t++) {
      const table = m.tables[t]!;
      if (table.imported || table.init === null) continue;
      const v = f.constExpr(table.init);
      body.add(
        `  call void @scr_wasm_table_fill(ptr %inst, i32 ${t}, i32 0, ptr ${v}, i32 ${table.min})`,
      );
    }
    // Element segments: active ones initialize their table and drop;
    // declarative ones only drop.
    for (let s = 0; s < m.elems.length; s++) {
      const seg = m.elems[s]!;
      if (seg.mode === "active") {
        const offset = f.constExpr(seg.offset!);
        body.add(
          `  call void @scr_wasm_table_init(ptr %inst, i32 ${seg.table}, i32 ${s}, i32 ${offset}, i32 0, i32 ${seg.funcs.length})`,
        );
      }
      if (seg.mode !== "passive") body.add(`  call void @scr_wasm_elem_drop(ptr %inst, i32 ${s})`);
    }
    for (let s = 0; s < m.datas.length; s++) {
      const seg = m.datas[s]!;
      if (seg.mode !== "active") continue;
      const offset = f.constExpr(seg.offset!);
      const length = seg.payload.end - seg.payload.start;
      body.add(
        `  call void @scr_wasm_memory_init(ptr %inst, i32 ${s}, i32 ${offset}, i32 0, i32 ${length})`,
      );
      body.add(`  call void @scr_wasm_data_drop(ptr %inst, i32 ${s})`);
    }
    body.add(`  ret void`);
    const out = [`define internal void ${name}(ptr %inst) ${this.thunkAttrs} {`, `entry:`];
    appendLines(out, f.entry.lines);
    appendLines(out, body.lines);
    out.push(`}`);
    this.text.push(out.join("\n"));
    return name;
  }

  /** Constant data and the descriptor. */
  descriptor(sha256: Uint8Array): string {
    const m = this.m;
    const p = this.p;
    const lines: string[] = [];
    // First, so that every function its constant expressions reference has
    // a record in the tables below.
    const init = this.initFunction();
    let strings = 0;
    const cstr = (text: readonly number[]): string => {
      const sym = `@${p}_s${strings++}`;
      const bytes = new Uint8Array(text);
      lines.push(
        `${sym} = private unnamed_addr constant [${bytes.length + 1} x i8] c"${cBytes(bytes, 0, bytes.length)}\\00"`,
      );
      return sym;
    };
    const textStr = (text: string): { sym: string; len: number } => {
      const bytes = utf8Bytes(text);
      return { sym: cstr(bytes), len: bytes.length };
    };
    // Imports.
    const importRows: string[] = [];
    let funcImport = 0;
    let tableImport = 0;
    let memoryImport = 0;
    let globalImport = 0;
    for (const imp of m.imports) {
      const mod = textStr(imp.module);
      const name = textStr(imp.name);
      let index = 0;
      let type = "";
      if (imp.kind === KIND_FUNC) {
        index = funcImport++;
        type = sigString(m.types[imp.type]!);
      } else if (imp.kind === KIND_TABLE) {
        index = tableImport++;
        type = sigChar(imp.type);
      } else if (imp.kind === KIND_MEMORY) {
        index = memoryImport++;
      } else {
        index = globalImport++;
        type = sigChar(imp.type);
      }
      const typeSym = cstr(utf8Bytes(type));
      importRows.push(
        `{ ptr, i64, ptr, i64, i64, i64, ptr } { ptr ${mod.sym}, i64 ${mod.len}, ptr ${name.sym}, i64 ${name.len}, i64 ${imp.kind}, i64 ${index}, ptr ${typeSym} }`,
      );
    }
    const importType = "{ ptr, i64, ptr, i64, i64, i64, ptr }";
    const importsSym = `@${p}_imports`;
    lines.push(
      `${importsSym} = private constant [${importRows.length} x ${importType}] [${importRows.join(", ")}]`,
    );
    // Exports.
    const thunks = new Map<number, string>();
    const exportRows: string[] = [];
    for (const ex of m.exports) {
      const name = textStr(ex.name);
      let type = "";
      let call = "null";
      if (ex.kind === KIND_FUNC) {
        const ft = this.funcType(ex.index);
        type = sigString(ft);
        // A v128 export has no 64-bit-slot thunk; the runtime's JavaScript
        // wrapper rejects the call before converting anything.
        if (!hasV128(ft.params) && !hasV128(ft.results)) {
          let thunk = thunks.get(ex.index);
          if (thunk === undefined) {
            thunk = this.exportThunk(ex.index);
            thunks.set(ex.index, thunk);
          }
          call = thunk;
        }
      } else if (ex.kind === KIND_TABLE) {
        type = sigChar(m.tables[ex.index]!.elemType);
      } else if (ex.kind === KIND_GLOBAL) {
        type = sigChar(m.globals[ex.index]!.type);
      }
      const typeSym = cstr(utf8Bytes(type));
      exportRows.push(
        `{ ptr, i64, i64, i64, ptr, ptr } { ptr ${name.sym}, i64 ${name.len}, i64 ${ex.kind}, i64 ${ex.index}, ptr ${typeSym}, ptr ${call} }`,
      );
    }
    const exportType = "{ ptr, i64, i64, i64, ptr, ptr }";
    const exportsSym = `@${p}_exports`;
    lines.push(
      `${exportsSym} = private constant [${exportRows.length} x ${exportType}] [${exportRows.join(", ")}]`,
    );
    // Function references: code, signature identity and signature text for
    // every function a reference can name.
    const nf = m.funcTypes.length;
    const codes: string[] = [];
    const callThunks: string[] = [];
    const callThunkSyms = new Map<number, string>();
    const types: string[] = [];
    const sigs: string[] = [];
    const sigSyms = new Map<string, string>();
    for (let f = 0; f < nf; f++) {
      const referenced = this.refs.has(f);
      codes.push(referenced ? `ptr ${this.fn(f)}` : "ptr null");
      // Referenced functions the module does not export reach JavaScript
      // through their signature's call thunk.
      const referencedFt = this.funcType(f);
      if (
        referenced &&
        !thunks.has(f) &&
        !hasV128(referencedFt.params) &&
        !hasV128(referencedFt.results)
      ) {
        const type = m.funcTypes[f]!;
        let thunk = callThunkSyms.get(type);
        if (thunk === undefined) {
          thunk = this.callThunk(type);
          callThunkSyms.set(type, thunk);
        }
        callThunks.push(`ptr ${thunk}`);
      } else {
        callThunks.push("ptr null");
      }
      types.push(`i64 ${this.typeHashes[m.funcTypes[f]!]!}`);
      const sig = sigString(this.funcType(f));
      let sym = sigSyms.get(sig);
      if (sym === undefined) {
        sym = cstr(utf8Bytes(sig));
        sigSyms.set(sig, sym);
      }
      sigs.push(`ptr ${sym}`);
    }
    const codesSym = `@${p}_codes`;
    const typesSym = `@${p}_types`;
    const sigsSym = `@${p}_sigs`;
    const callThunksSym = `@${p}_calls`;
    lines.push(`${codesSym} = private constant [${nf} x ptr] [${codes.join(", ")}]`);
    lines.push(`${callThunksSym} = private constant [${nf} x ptr] [${callThunks.join(", ")}]`);
    lines.push(`${typesSym} = private constant [${nf} x i64] [${types.join(", ")}]`);
    lines.push(`${sigsSym} = private constant [${nf} x ptr] [${sigs.join(", ")}]`);
    // Tables.
    const tableRows = m.tables.map(
      (t) =>
        `{ i64, i64, i64, i64 } { i64 ${sigChar(t.elemType).charCodeAt(0)}, i64 ${t.min}, i64 ${t.max === null ? -1 : t.max}, i64 ${t.imported ? 1 : 0} }`,
    );
    const tablesSym = `@${p}_tables`;
    lines.push(
      `${tablesSym} = private constant [${tableRows.length} x { i64, i64, i64, i64 }] [${tableRows.join(", ")}]`,
    );
    // Globals.
    const globalRows = m.globals.map(
      (g) =>
        `{ i64, i64, i64 } { i64 ${sigChar(g.type).charCodeAt(0)}, i64 ${g.mutable ? 1 : 0}, i64 ${g.imported ? 1 : 0} }`,
    );
    const globalsSym = `@${p}_globals`;
    lines.push(
      `${globalsSym} = private constant [${globalRows.length} x { i64, i64, i64 }] [${globalRows.join(", ")}]`,
    );
    // Data segments.
    const dataRows: string[] = [];
    for (let s = 0; s < m.datas.length; s++) {
      const seg = m.datas[s]!;
      const len = seg.payload.end - seg.payload.start;
      if (len === 0) {
        dataRows.push(`{ ptr, i64 } { ptr null, i64 0 }`);
        continue;
      }
      const sym = `@${p}_d${s}`;
      lines.push(
        `${sym} = private unnamed_addr constant [${len} x i8] c"${cBytes(m.bytes, seg.payload.start, seg.payload.end)}", align 1`,
      );
      dataRows.push(`{ ptr, i64 } { ptr ${sym}, i64 ${len} }`);
    }
    const datasSym = `@${p}_datas`;
    lines.push(
      `${datasSym} = private constant [${dataRows.length} x { ptr, i64 }] [${dataRows.join(", ")}]`,
    );
    // Element segments: a function index, -1 for null, or -(2 + g) for the
    // value of global g.
    const elemRows: string[] = [];
    for (let s = 0; s < m.elems.length; s++) {
      const seg = m.elems[s]!;
      const items: string[] = [];
      for (let k = 0; k < seg.funcs.length; k++) {
        const f = seg.funcs[k]!;
        if (f >= 0) {
          items.push(`i64 ${f}`);
          continue;
        }
        items.push(`i64 ${this.elemExprCode(seg.exprs[k]!)}`);
      }
      let itemsRef = "ptr null";
      if (items.length > 0) {
        const sym = `@${p}_e${s}`;
        lines.push(`${sym} = private constant [${items.length} x i64] [${items.join(", ")}]`);
        itemsRef = `ptr ${sym}`;
      }
      elemRows.push(
        `{ i64, i64, ptr } { i64 ${sigChar(seg.elemType).charCodeAt(0)}, i64 ${items.length}, ${itemsRef} }`,
      );
    }
    const elemsSym = `@${p}_elems`;
    lines.push(
      `${elemsSym} = private constant [${elemRows.length} x { i64, i64, ptr }] [${elemRows.join(", ")}]`,
    );
    // Custom sections, when the program reads them.
    const customRows: string[] = [];
    if (this.opts.customSections === true) {
      for (let s = 0; s < m.customs.length; s++) {
        const custom = m.customs[s]!;
        const name = textStr(custom.name);
        const len = custom.payload.end - custom.payload.start;
        let data = "ptr null";
        if (len > 0) {
          const sym = `@${p}_c${s}`;
          lines.push(
            `${sym} = private unnamed_addr constant [${len} x i8] c"${cBytes(m.bytes, custom.payload.start, custom.payload.end)}", align 1`,
          );
          data = `ptr ${sym}`;
        }
        customRows.push(
          `{ ptr, i64, ptr, i64 } { ptr ${name.sym}, i64 ${name.len}, ${data}, i64 ${len} }`,
        );
      }
    }
    const customsSym = `@${p}_customs`;
    lines.push(
      `${customsSym} = private constant [${customRows.length} x { ptr, i64, ptr, i64 }] [${customRows.join(", ")}]`,
    );
    const memory = m.memories[0];
    const sha: string[] = [];
    for (let i = 0; i < 32; i++) sha.push(`i8 ${sha256[i]!}`);
    const desc = `@${p}_desc`;
    const fields = [
      `[32 x i8] [${sha.join(", ")}]`,
      `i64 ${m.bytes.length}`,
      `i64 ${this.abiVersion}`,
      `i64 ${this.opts.boundsChecks ? 1 : 0}`,
      `i64 ${m.imports.length}`,
      `ptr ${importsSym}`,
      `i64 ${m.exports.length}`,
      `ptr ${exportsSym}`,
      `i64 ${nf}`,
      `i64 ${m.importedFuncs}`,
      `ptr ${codesSym}`,
      `ptr ${typesSym}`,
      `ptr ${sigsSym}`,
      `i64 ${m.tables.length}`,
      `ptr ${tablesSym}`,
      `i64 ${this.memoryCount}`,
      `i64 ${memory === undefined ? 0 : memory.min}`,
      `i64 ${memory === undefined || memory.max === null ? -1 : memory.max}`,
      `i64 ${m.globals.length}`,
      `ptr ${globalsSym}`,
      `i64 ${m.datas.length}`,
      `ptr ${datasSym}`,
      `i64 ${m.elems.length}`,
      `ptr ${elemsSym}`,
      `ptr ${init}`,
      `ptr ${m.start === null ? "null" : this.fn(m.start)}`,
      `i64 ${customRows.length}`,
      `ptr ${customsSym}`,
      `ptr ${callThunksSym}`,
    ];
    const descType =
      "{ [32 x i8], i64, i64, i64, i64, ptr, i64, ptr, i64, i64, ptr, ptr, ptr, i64, ptr, i64, i64, i64, i64, ptr, i64, ptr, i64, ptr, ptr, ptr, i64, ptr, ptr }";
    lines.push(`${desc} = internal constant ${descType} { ${fields.join(", ")} }`);
    this.text.push(lines.join("\n"));
    return desc;
  }

  /** The element-segment code of a non-ref.func constant expression. */
  elemExprCode(expr: WasmRange): number {
    const c = new WasmCursor(this.m.bytes, expr.start);
    const op = c.u8();
    if (op === 0xd0) {
      c.valType();
      if (c.u8() === 0x0b) return -1;
    } else if (op === 0x23) {
      const g = c.u32();
      if (c.u8() === 0x0b) return -(2 + g);
    }
    throw new WasmTranslateError(
      "element segment initializers other than ref.null, ref.func and global.get are not supported",
    );
  }
}

/** Store a value as a 64-bit slot; answers the slot operand. */
function toSlot(out: string[], t: number, v: string, tag: string): string {
  switch (t) {
    case VAL_I32:
      out.push(`  %${tag}z = zext i32 ${v} to i64`);
      return `%${tag}z`;
    case VAL_I64:
      return v;
    case VAL_F32:
      out.push(`  %${tag}b = bitcast float ${v} to i32`);
      out.push(`  %${tag}z = zext i32 %${tag}b to i64`);
      return `%${tag}z`;
    case VAL_F64:
      out.push(`  %${tag}z = bitcast double ${v} to i64`);
      return `%${tag}z`;
    case VAL_V128:
      throw new WasmTranslateError("v128 cannot cross the JavaScript boundary");
    default:
      out.push(`  %${tag}z = ptrtoint ptr ${v} to i64`);
      return `%${tag}z`;
  }
}

function fromSlot(out: string[], t: number, slot: string, tag: string): string {
  switch (t) {
    case VAL_I32:
      out.push(`  %${tag}v = trunc i64 ${slot} to i32`);
      return `%${tag}v`;
    case VAL_I64:
      return slot;
    case VAL_F32:
      out.push(`  %${tag}t = trunc i64 ${slot} to i32`);
      out.push(`  %${tag}v = bitcast i32 %${tag}t to float`);
      return `%${tag}v`;
    case VAL_F64:
      out.push(`  %${tag}v = bitcast i64 ${slot} to double`);
      return `%${tag}v`;
    case VAL_V128:
      throw new WasmTranslateError("v128 cannot cross the JavaScript boundary");
    default:
      out.push(`  %${tag}v = inttoptr i64 ${slot} to ptr`);
      return `%${tag}v`;
  }
}

function emitSlotReturn(out: string[], results: readonly number[], buffer: string): void {
  if (results.length === 0) {
    out.push(`  ret void`);
    return;
  }
  const vals: string[] = [];
  for (let i = 0; i < results.length; i++) {
    out.push(`  %rp${i} = getelementptr i64, ptr ${buffer}, i64 ${i}`);
    out.push(`  %rs${i} = load i64, ptr %rp${i}`);
    vals.push(fromSlot(out, results[i]!, `%rs${i}`, `r${i}`));
  }
  if (results.length === 1) {
    out.push(`  ret ${llType(results[0]!)} ${vals[0]}`);
    return;
  }
  const ret = retType(results);
  let agg = "undef";
  for (let i = 0; i < results.length; i++) {
    out.push(`  %agg${i} = insertvalue ${ret} ${agg}, ${llType(results[i]!)} ${vals[i]}, ${i}`);
    agg = `%agg${i}`;
  }
  out.push(`  ret ${ret} ${agg}`);
}

const LOAD_INFO: Record<number, [number, string, number, string]> = {
  // opcode: [result type, memory type, bytes, extension]
  0x28: [VAL_I32, "i32", 4, ""],
  0x29: [VAL_I64, "i64", 8, ""],
  0x2a: [VAL_F32, "float", 4, ""],
  0x2b: [VAL_F64, "double", 8, ""],
  0x2c: [VAL_I32, "i8", 1, "sext"],
  0x2d: [VAL_I32, "i8", 1, "zext"],
  0x2e: [VAL_I32, "i16", 2, "sext"],
  0x2f: [VAL_I32, "i16", 2, "zext"],
  0x30: [VAL_I64, "i8", 1, "sext"],
  0x31: [VAL_I64, "i8", 1, "zext"],
  0x32: [VAL_I64, "i16", 2, "sext"],
  0x33: [VAL_I64, "i16", 2, "zext"],
  0x34: [VAL_I64, "i32", 4, "sext"],
  0x35: [VAL_I64, "i32", 4, "zext"],
};

const STORE_INFO: Record<number, [number, string, number]> = {
  0x36: [VAL_I32, "i32", 4],
  0x37: [VAL_I64, "i64", 8],
  0x38: [VAL_F32, "float", 4],
  0x39: [VAL_F64, "double", 8],
  0x3a: [VAL_I32, "i8", 1],
  0x3b: [VAL_I32, "i16", 2],
  0x3c: [VAL_I64, "i8", 1],
  0x3d: [VAL_I64, "i16", 2],
  0x3e: [VAL_I64, "i32", 4],
};

/** Translates one function body (index >= 0) or hosts the init function's
 * constant expressions (index -1). */
class FunctionTranslator {
  mt: ModuleTranslator;
  m: WasmModule;
  index: number;
  ft: WasmFuncType;
  entry = new Lines();
  lines = new Lines();
  stack: StackValue[] = [];
  frames: Frame[] = [];
  localTypes: number[] = [];
  next = 0;
  labels = 0;
  live = true;
  trapLabels = new Map<number, string>();
  /** Guard mode: the memory base, loaded once in the entry block. */
  baseValue: string | null = null;
  checked: boolean;

  constructor(mt: ModuleTranslator, index: number) {
    this.mt = mt;
    this.m = mt.m;
    this.index = index;
    this.ft = index >= 0 ? mt.funcType(index) : { params: [], results: [] };
    this.checked = mt.opts.boundsChecks;
  }

  tmp(): string {
    return `%v${this.next++}`;
  }

  label(hint: string): string {
    return `${hint}${this.labels++}`;
  }

  add(line: string): void {
    this.lines.add(line);
  }

  emit(expr: string): string {
    const v = this.tmp();
    this.add(`  ${v} = ${expr}`);
    return v;
  }

  /** Emits an intrinsic call and records its declaration once per module. */
  intrinsic(decl: string, call: string): string {
    this.mt.intrinsic(decl);
    return this.emit(call);
  }

  push(v: string, t: number): void {
    this.stack.push({ v, t });
  }

  pop(): StackValue {
    const v = this.stack.pop();
    if (v === undefined) throw new Error("wasm translator: operand stack underflow");
    return v;
  }

  /** Pops a value that must have type `t`: the type a local, global,
   * table or memory store writes. Validation guarantees it; a mismatch
   * means the translator and the validator disagree about the code, so
   * the module is not translated. */
  popType(t: number, what: string): StackValue {
    const v = this.pop();
    if (v.t !== t) throw new WasmTranslateError(`${what} operand type does not match`);
    return v;
  }

  /** The declared type of local `i` (parameters first). */
  localType(i: number): number {
    const t = this.localTypes[i];
    if (t === undefined) throw new WasmTranslateError(`unknown local ${i}`);
    return t;
  }

  /** The offset of a memarg over memory 0 (the only memory a translatable
   * module has). */
  memarg(c: WasmCursor): { offset: number; align: number } {
    const flags = readMemargFlags(() => c.u32());
    if (flags.align < 0 || flags.memory !== 0)
      throw new WasmTranslateError(`memarg of memory ${flags.memory} is not supported`);
    return { offset: c.u32(), align: flags.align };
  }

  memargOffset(c: WasmCursor): number {
    return this.memarg(c).offset;
  }

  /** A memory index immediate (memory.size, memory.grow and the bulk
   * memory instructions), which must be 0. */
  memoryIndex(c: WasmCursor): void {
    const index = c.u32();
    if (index !== 0) throw new WasmTranslateError(`memory ${index} is not supported`);
  }

  popN(n: number): StackValue[] {
    const out = this.stack.splice(this.stack.length - n, n);
    if (out.length !== n) throw new Error("wasm translator: operand stack underflow");
    return out;
  }

  /** Starts a new basic block. */
  startBlock(label: string): void {
    this.add(`${label}:`);
  }

  alloca(type: string): string {
    const v = `%s${this.next++}`;
    this.entry.add(`  ${v} = alloca ${type}`);
    return v;
  }

  slotPtr(offset: number): string {
    if (offset === 0) return "%inst";
    return this.emit(`getelementptr inbounds i8, ptr %inst, i64 ${offset}`);
  }

  loadPtrSlot(offset: number): string {
    return this.emit(`load ptr, ptr ${this.slotPtr(offset)}, align 8`);
  }

  trap(code: number): string {
    let label = this.trapLabels.get(code);
    if (label === undefined) {
      label = `trap${code}`;
      this.trapLabels.set(code, label);
    }
    return label;
  }

  // ── memory ──────────────────────────────────────────────────────────

  /** Checked mode: the slots holding the base and byte length. */
  memSlots: { base: string; size: string } | null = null;

  refreshMemory(): void {
    if (!this.checked || this.memSlots === null) return;
    // From the memory object, not the instance: a memory another instance
    // (or JavaScript) grew may have moved.
    const mem = this.loadPtrSlot(OFF_MEMORY);
    const base = this.emit(`load ptr, ptr ${mem}, align 8`);
    this.add(`  store ptr ${base}, ptr ${this.memSlots.base}`);
    const sizePtr = this.emit(`getelementptr inbounds i8, ptr ${mem}, i64 8`);
    const size = this.emit(`load i64, ptr ${sizePtr}, align 8`);
    this.add(`  store i64 ${size}, ptr ${this.memSlots.size}`);
  }

  base(): string {
    if (this.checked) {
      return this.emit(`load ptr, ptr ${this.memSlots!.base}`);
    }
    if (this.baseValue === null) {
      this.baseValue = "%membase";
    }
    return this.baseValue;
  }

  /** The address of an access of `bytes` bytes at `addr + offset`. */
  address(addr: string, offset: number, bytes: number): string {
    const wide = this.emit(`zext i32 ${addr} to i64`);
    const ea = offset === 0 ? wide : this.emit(`add i64 ${wide}, ${offset}`);
    if (this.checked) {
      const size = this.emit(`load i64, ptr ${this.memSlots!.size}`);
      const endAddr = this.emit(`add i64 ${ea}, ${bytes}`);
      const oob = this.emit(`icmp ugt i64 ${endAddr}, ${size}`);
      const ok = this.label("ok");
      this.add(`  br i1 ${oob}, label %${this.trap(TRAP_MEMORY_OOB)}, label %${ok}`);
      this.startBlock(ok);
    }
    return this.emit(`getelementptr i8, ptr ${this.base()}, i64 ${ea}`);
  }

  // ── constant expressions ────────────────────────────────────────────

  constExpr(range: WasmRange): string {
    const c = new WasmCursor(this.m.bytes, range.start);
    const stack: string[] = [];
    for (;;) {
      const op = c.u8();
      if (op === 0x0b) break;
      switch (op) {
        case 0x41:
          stack.push(String(c.s32()));
          break;
        case 0x42: {
          const [lo, hi] = c.s64();
          stack.push(i64Lit(lo, hi));
          break;
        }
        case 0x43:
          stack.push(this.emit(`bitcast i32 ${c.u32le() | 0} to float`));
          break;
        case 0x44: {
          const lo = c.u32le();
          const hi = c.u32le();
          stack.push(this.emit(`bitcast i64 ${i64Lit(lo, hi)} to double`));
          break;
        }
        case 0x23: {
          const g = c.u32();
          const cell = this.loadPtrSlot(this.mt.globalSlot(g));
          const t = this.m.globals[g]!.type;
          const align = t === VAL_V128 ? ", align 8" : "";
          stack.push(this.emit(`load ${llType(t)}, ptr ${cell}${align}`));
          break;
        }
        case 0xd0:
          c.valType();
          stack.push("null");
          break;
        case 0xd2:
          stack.push(this.funcRef(c.u32()));
          break;
        case 0xfd: {
          // v128.const: four little-endian 32-bit words.
          const sub = c.u32();
          if (sub !== 12)
            throw new WasmTranslateError(`constant expression opcode 0xfd ${sub} is not supported`);
          const w = [c.u32le(), c.u32le(), c.u32le(), c.u32le()];
          stack.push(`<i32 ${w[0]! | 0}, i32 ${w[1]! | 0}, i32 ${w[2]! | 0}, i32 ${w[3]! | 0}>`);
          break;
        }
        case 0x6a:
        case 0x6b:
        case 0x6c:
        case 0x7c:
        case 0x7d:
        case 0x7e: {
          const b = stack.pop()!;
          const a = stack.pop()!;
          const t = op < 0x70 ? "i32" : "i64";
          const name =
            op === 0x6a || op === 0x7c ? "add" : op === 0x6b || op === 0x7d ? "sub" : "mul";
          stack.push(this.emit(`${name} ${t} ${a}, ${b}`));
          break;
        }
        default:
          throw new WasmTranslateError(
            `constant expression opcode 0x${op.toString(16)} is not supported`,
          );
      }
    }
    return stack[stack.length - 1]!;
  }

  funcRef(f: number): string {
    this.mt.refs.add(f);
    const records = this.loadPtrSlot(OFF_FUNCREFS);
    return this.emit(`getelementptr inbounds i8, ptr ${records}, i64 ${f * FUNCREF_SIZE}`);
  }

  // ── control ─────────────────────────────────────────────────────────

  blockSig(c: WasmCursor): { params: number[]; results: number[] } {
    const bt = c.blockType();
    if (bt.kind === "empty") return { params: [], results: [] };
    if (bt.kind === "value") return { params: [], results: [bt.type] };
    const t = this.m.types[bt.index]!;
    return { params: t.params.slice(), results: t.results.slice() };
  }

  slotsFor(types: readonly number[]): string[] {
    return types.map((t) => this.alloca(llType(t)));
  }

  storeTo(slots: readonly string[], values: readonly StackValue[]): void {
    for (let i = 0; i < slots.length; i++) {
      const v = values[i]!;
      this.add(`  store ${llType(v.t)} ${v.v}, ptr ${slots[i]}`);
    }
  }

  loadFrom(slots: readonly string[], types: readonly number[]): void {
    for (let i = 0; i < slots.length; i++) {
      const t = types[i]!;
      this.push(this.emit(`load ${llType(t)}, ptr ${slots[i]}`), t);
    }
  }

  /** Branch to the frame `depth` levels out (the stack keeps its values). */
  branch(depth: number): void {
    const f = this.frames[this.frames.length - 1 - depth]!;
    const n = f.branchSlots.length;
    if (n > 0) this.storeTo(f.branchSlots, this.stack.slice(this.stack.length - n));
    this.add(`  br label %${f.target}`);
  }

  /** The label of a block that branches to `depth`, for conditional
   * branches and tables: the target itself when no values travel. */
  branchEdge(depth: number, pending: string[]): string {
    const f = this.frames[this.frames.length - 1 - depth]!;
    if (f.branchSlots.length === 0) return f.target;
    const edge = this.label("edge");
    const saved = this.lines;
    const edgeLines = new Lines();
    this.lines = edgeLines;
    this.startBlock(edge);
    this.branch(depth);
    this.lines = saved;
    pending.push(...edgeLines.lines);
    return edge;
  }

  goDead(): void {
    this.live = false;
  }

  pushFrame(kind: Frame["kind"], sig: { params: number[]; results: number[] }): Frame {
    const end = this.label("end");
    const frame: Frame = {
      kind,
      params: sig.params,
      results: sig.results,
      target: end,
      end,
      branchSlots: [],
      resultSlots: this.slotsFor(sig.results),
      height: this.stack.length - sig.params.length,
      elseLabel: null,
      ifParams: [],
      live: true,
    };
    frame.branchSlots = frame.resultSlots;
    this.frames.push(frame);
    return frame;
  }

  /** Skips dead code from just after a terminator to the `else` or `end`
   * of the current frame; answers the opcode it stopped at (consumed). */
  skipDead(c: WasmCursor): number {
    let depth = 0;
    for (;;) {
      const op = c.u8();
      if (op === 0x02 || op === 0x03 || op === 0x04) {
        c.blockType();
        depth++;
        continue;
      }
      if (op === 0x0b) {
        if (depth === 0) return op;
        depth--;
        continue;
      }
      if (op === 0x05 && depth === 0) return op;
      skipImmediates(c, op);
    }
  }

  translate(): string[] {
    const ft = this.ft;
    const code = this.m.codes[this.index - this.m.importedFuncs]!;
    // Locals.
    const localSlots: string[] = [];
    this.localTypes = ft.params.concat(code.locals);
    for (let i = 0; i < this.localTypes.length; i++) {
      const t = this.localTypes[i]!;
      const slot = `%l${i}`;
      localSlots.push(slot);
      this.entry.add(`  ${slot} = alloca ${llType(t)}`);
    }
    for (let i = 0; i < ft.params.length; i++) {
      this.entry.add(`  store ${llType(ft.params[i]!)} %p${i}, ptr %l${i}`);
    }
    for (let i = ft.params.length; i < this.localTypes.length; i++) {
      const t = this.localTypes[i]!;
      this.entry.add(`  store ${llType(t)} ${zeroOf(t)}, ptr %l${i}`);
    }
    if (this.checked && this.mt.memoryCount > 0) {
      this.memSlots = { base: "%mbase", size: "%msize" };
      this.entry.add(`  %mbase = alloca ptr`);
      this.entry.add(`  %msize = alloca i64`);
    }
    // The function frame: branches to it return.
    const ret = this.label("ret");
    const fnFrame: Frame = {
      kind: "func",
      params: [],
      results: ft.results,
      target: ret,
      end: ret,
      branchSlots: [],
      resultSlots: this.slotsFor(ft.results),
      height: 0,
      elseLabel: null,
      ifParams: [],
      live: true,
    };
    fnFrame.branchSlots = fnFrame.resultSlots;
    this.frames.push(fnFrame);
    if (this.memSlots !== null) this.refreshMemory();
    const c = new WasmCursor(this.m.bytes, code.body.start);
    this.body(c, code.body.end);
    // Epilogue.
    const out: string[] = [];
    out.push(`define internal ${this.mt.signature(ft, this.mt.fn(this.index))} ${this.mt.attrs} {`);
    out.push(`entry:`);
    appendLines(out, this.entry.lines);
    if (!this.checked && this.baseValue !== null) {
      out.push(`  %membase.p = getelementptr inbounds i8, ptr %inst, i64 ${OFF_MEMBASE}`);
      out.push(`  %membase = load ptr, ptr %membase.p, align 8`);
    }
    if (this.checked && this.mt.stackChecked.has(this.index)) {
      // Without the fault handler, stack exhaustion is an explicit check of
      // the stack pointer against the runtime's guard for the running stack
      // (thread or async fiber), in the functions through which the stack
      // can grow without bound (stackCheckedFunctions).
      // The address of a frame slot stands for the stack pointer; unlike
      // llvm.stacksave it constrains no other code.
      out.push(`  %sp = alloca i8, align 1`);
      out.push(`  %sp.i = ptrtoint ptr %sp to i64`);
      out.push(`  %limit.p = call ptr @llvm.threadlocal.address.p0(ptr @scr_wasm_stack_limit)`);
      out.push(`  %limit = load i64, ptr %limit.p, align 8`);
      out.push(`  %exhausted = icmp ult i64 %sp.i, %limit`);
      out.push(`  br i1 %exhausted, label %exhausted.trap, label %body`);
      out.push(`exhausted.trap:`);
      out.push(`  call void @scr_wasm_trap(i32 ${TRAP_EXHAUSTION})`);
      out.push(`  unreachable`);
    } else {
      out.push(`  br label %body`);
    }
    out.push(`body:`);
    appendLines(out, this.lines.lines);
    for (const [code2, label] of this.trapLabels) {
      out.push(`${label}:`);
      out.push(`  call void @scr_wasm_trap(i32 ${code2})`);
      out.push(`  unreachable`);
    }
    out.push(`}`);
    return [out.join("\n")];
  }

  /** The function body; returns at the function's final `end`. */
  body(c: WasmCursor, end: number): void {
    while (c.pos < end) {
      if (!this.live) {
        const op = this.skipDead(c);
        if (op === 0x05) this.opElse();
        else if (this.opEnd()) return;
        continue;
      }
      const op = c.u8();
      if (op === 0x0b) {
        if (this.opEnd()) return;
        continue;
      }
      this.instruction(c, op);
    }
  }

  /** `end`: closes the innermost frame; true when that was the function. */
  opEnd(): boolean {
    const f = this.frames[this.frames.length - 1]!;
    if (this.live) {
      const n = f.results.length;
      this.storeTo(f.resultSlots, this.stack.slice(this.stack.length - n));
      this.add(`  br label %${f.end}`);
    }
    if (f.elseLabel !== null) {
      // An if without else: the implicit else passes its parameters on.
      this.startBlock(f.elseLabel);
      if (f.live) {
        this.storeTo(f.resultSlots, f.ifParams);
      }
      this.add(`  br label %${f.end}`);
      f.elseLabel = null;
    }
    this.frames.pop();
    this.stack.length = f.height;
    this.startBlock(f.end);
    if (f.kind === "func") {
      if (f.results.length === 0) this.add(`  ret void`);
      else {
        this.loadFrom(f.resultSlots, f.results);
        const vals = this.popN(f.results.length);
        if (vals.length === 1) this.add(`  ret ${llType(vals[0]!.t)} ${vals[0]!.v}`);
        else {
          const rt = retType(f.results);
          let agg = "undef";
          for (let i = 0; i < vals.length; i++) {
            agg = this.emit(`insertvalue ${rt} ${agg}, ${llType(vals[i]!.t)} ${vals[i]!.v}, ${i}`);
          }
          this.add(`  ret ${rt} ${agg}`);
        }
      }
      return true;
    }
    this.loadFrom(f.resultSlots, f.results);
    this.live = true;
    return false;
  }

  opElse(): void {
    const f = this.frames[this.frames.length - 1]!;
    if (this.live) {
      const n = f.results.length;
      this.storeTo(f.resultSlots, this.stack.slice(this.stack.length - n));
      this.add(`  br label %${f.end}`);
    }
    this.stack.length = f.height;
    this.startBlock(f.elseLabel!);
    f.elseLabel = null;
    for (const v of f.ifParams) this.stack.push(v);
    this.live = f.live;
    if (!f.live) {
      // The if itself was dead: its else branch is too.
      this.add(`  unreachable`);
    }
  }

  call(index: number): void {
    const ft = this.mt.funcType(index);
    const args = this.popN(ft.params.length);
    const argText = ["ptr %inst", ...args.map((a) => `${llType(a.t)} ${a.v}`)].join(", ");
    this.callWith(this.mt.fn(index), ft, argText);
  }

  callWith(callee: string, ft: WasmFuncType, argText: string): void {
    const rt = retType(ft.results);
    if (ft.results.length === 0) {
      this.add(`  call void ${callee}(${argText})`);
    } else {
      const r = this.emit(`call ${rt} ${callee}(${argText})`);
      if (ft.results.length === 1) this.push(r, ft.results[0]!);
      else
        for (let i = 0; i < ft.results.length; i++)
          this.push(this.emit(`extractvalue ${rt} ${r}, ${i}`), ft.results[i]!);
    }
    this.refreshMemory();
  }

  callIndirect(typeIndex: number, table: number): void {
    const ft = this.m.types[typeIndex]!;
    const idx = this.pop();
    const args = this.popN(ft.params.length);
    const t = this.loadPtrSlot(this.mt.tableSlot(table));
    const sizePtr = this.emit(`getelementptr inbounds i8, ptr ${t}, i64 8`);
    const size = this.emit(`load i32, ptr ${sizePtr}, align 8`);
    const inRange = this.emit(`icmp ult i32 ${idx.v}, ${size}`);
    const ok = this.label("ci");
    this.add(`  br i1 ${inRange}, label %${ok}, label %${this.trap(TRAP_TABLE_OOB)}`);
    this.startBlock(ok);
    const elems = this.emit(`load ptr, ptr ${t}, align 8`);
    const wide = this.emit(`zext i32 ${idx.v} to i64`);
    const slot = this.emit(`getelementptr inbounds ptr, ptr ${elems}, i64 ${wide}`);
    const rec = this.emit(`load ptr, ptr ${slot}, align 8`);
    const isNull = this.emit(`icmp eq ptr ${rec}, null`);
    const nn = this.label("cn");
    this.add(`  br i1 ${isNull}, label %${this.trap(TRAP_SIGNATURE)}, label %${nn}`);
    this.startBlock(nn);
    const typePtr = this.emit(`getelementptr inbounds i8, ptr ${rec}, i64 8`);
    const type = this.emit(`load i64, ptr ${typePtr}, align 8`);
    const same = this.emit(`icmp eq i64 ${type}, ${this.mt.typeHashes[typeIndex]}`);
    const go = this.label("cg");
    this.add(`  br i1 ${same}, label %${go}, label %${this.trap(TRAP_SIGNATURE)}`);
    this.startBlock(go);
    const codePtr = this.emit(`load ptr, ptr ${rec}, align 8`);
    const instPtr = this.emit(`getelementptr inbounds i8, ptr ${rec}, i64 16`);
    const inst = this.emit(`load ptr, ptr ${instPtr}, align 8`);
    const argText = [`ptr ${inst}`, ...args.map((a) => `${llType(a.t)} ${a.v}`)].join(", ");
    this.callWith(codePtr, ft, argText);
  }

  /** Integer division and remainder with wasm's traps. */
  divRem(op: number, t: string): void {
    const b = this.pop();
    const a = this.pop();
    const ty = b.t;
    const zero = this.emit(`icmp eq ${t} ${b.v}, 0`);
    const signed = op === 0x6d || op === 0x6f || op === 0x7f || op === 0x81;
    const rem = op === 0x6f || op === 0x70 || op === 0x81 || op === 0x82;
    const nz = this.label("nz");
    this.add(
      `  br i1 ${zero}, label %${this.trap(rem ? TRAP_REM_BY_ZERO : TRAP_DIV_BY_ZERO)}, label %${nz}`,
    );
    this.startBlock(nz);
    const min = t === "i32" ? "-2147483648" : "-9223372036854775808";
    if (signed && !rem) {
      const isMin = this.emit(`icmp eq ${t} ${a.v}, ${min}`);
      const isNeg1 = this.emit(`icmp eq ${t} ${b.v}, -1`);
      const ovf = this.emit(`and i1 ${isMin}, ${isNeg1}`);
      const okl = this.label("dv");
      this.add(`  br i1 ${ovf}, label %${this.trap(TRAP_DIV_UNREPRESENTABLE)}, label %${okl}`);
      this.startBlock(okl);
      this.push(this.emit(`sdiv ${t} ${a.v}, ${b.v}`), ty);
      return;
    }
    if (signed && rem) {
      // INT_MIN % -1 is 0 in wasm (LLVM's srem would be undefined).
      const isNeg1 = this.emit(`icmp eq ${t} ${b.v}, -1`);
      const divisor = this.emit(`select i1 ${isNeg1}, ${t} 1, ${t} ${b.v}`);
      this.push(this.emit(`srem ${t} ${a.v}, ${divisor}`), ty);
      return;
    }
    this.push(this.emit(`${rem ? "urem" : "udiv"} ${t} ${a.v}, ${b.v}`), ty);
  }

  /** Trapping float-to-int conversion. */
  truncTrap(op: number): void {
    const x = this.pop();
    const from = x.t === VAL_F32 ? "float" : "double";
    // [lower bound exclusive?, lower, upper (exclusive)] as exact doubles.
    let lo = "";
    let loInclusive = false;
    let hi = "";
    let to = "i32";
    let signed = true;
    switch (op) {
      case 0xa8: // i32.trunc_f32_s
      case 0xaa: // i32.trunc_f64_s
        lo = op === 0xa8 ? "-2147483648.0" : "-2147483649.0";
        loInclusive = op === 0xa8;
        hi = "2147483648.0";
        break;
      case 0xa9:
      case 0xab:
        lo = "-1.0";
        hi = "4294967296.0";
        signed = false;
        break;
      case 0xae:
      case 0xb0:
        lo = "-9223372036854775808.0";
        loInclusive = true;
        hi = "9223372036854775808.0";
        to = "i64";
        break;
      default:
        lo = "-1.0";
        hi = "18446744073709551616.0";
        to = "i64";
        signed = false;
        break;
    }
    const d = from === "double" ? x.v : this.emit(`fpext float ${x.v} to double`);
    const above = this.emit(`fcmp ${loInclusive ? "oge" : "ogt"} double ${d}, ${hexDouble(lo)}`);
    const below = this.emit(`fcmp olt double ${d}, ${hexDouble(hi)}`);
    const ok = this.emit(`and i1 ${above}, ${below}`);
    const okl = this.label("cv");
    this.add(`  br i1 ${ok}, label %${okl}, label %${this.trap(TRAP_FLOAT_UNREPRESENTABLE)}`);
    this.startBlock(okl);
    this.push(
      this.emit(`${signed ? "fptosi" : "fptoui"} ${from} ${x.v} to ${to}`),
      to === "i32" ? VAL_I32 : VAL_I64,
    );
  }

  unaryIntrinsic(name: string, t: string, vt: number, extra = ""): void {
    const a = this.pop();
    this.push(this.emit(`call ${t} @llvm.${name}(${t} ${a.v}${extra})`), vt);
  }

  binaryIntrinsic(name: string, t: string, vt: number): void {
    const b = this.pop();
    const a = this.pop();
    this.push(this.emit(`call ${t} @llvm.${name}(${t} ${a.v}, ${t} ${b.v})`), vt);
  }

  binary(instr: string, t: string, vt: number): void {
    const b = this.pop();
    const a = this.pop();
    this.push(this.emit(`${instr} ${t} ${a.v}, ${b.v}`), vt);
  }

  compare(pred: string, t: string, float: boolean): void {
    const b = this.pop();
    const a = this.pop();
    const r = this.emit(`${float ? "fcmp" : "icmp"} ${pred} ${t} ${a.v}, ${b.v}`);
    this.push(this.emit(`zext i1 ${r} to i32`), VAL_I32);
  }

  eqz(t: string): void {
    const a = this.pop();
    const r = this.emit(`icmp eq ${t} ${a.v}, 0`);
    this.push(this.emit(`zext i1 ${r} to i32`), VAL_I32);
  }

  shift(instr: string, t: string, vt: number): void {
    const b = this.pop();
    const a = this.pop();
    const masked = this.emit(`and ${t} ${b.v}, ${t === "i32" ? 31 : 63}`);
    this.push(this.emit(`${instr} ${t} ${a.v}, ${masked}`), vt);
  }

  rotate(name: string, t: string, vt: number): void {
    const b = this.pop();
    const a = this.pop();
    this.push(this.emit(`call ${t} @llvm.${name}.${t}(${t} ${a.v}, ${t} ${a.v}, ${t} ${b.v})`), vt);
  }

  convert(instr: string, from: string, to: string, vt: number): void {
    const a = this.pop();
    this.push(this.emit(`${instr} ${from} ${a.v} to ${to}`), vt);
  }

  instruction(c: WasmCursor, op: number): void {
    switch (op) {
      case 0x00: // unreachable
        this.add(`  br label %${this.trap(TRAP_UNREACHABLE)}`);
        this.goDead();
        return;
      case 0x01:
        return;
      case 0x02: {
        // block
        const sig = this.blockSig(c);
        this.pushFrame("block", sig);
        return;
      }
      case 0x03: {
        // loop
        const sig = this.blockSig(c);
        const f = this.pushFrame("loop", sig);
        f.target = this.label("loop");
        f.branchSlots = this.slotsFor(sig.params);
        const params = this.popN(sig.params.length);
        this.storeTo(f.branchSlots, params);
        this.add(`  br label %${f.target}`);
        this.startBlock(f.target);
        this.loadFrom(f.branchSlots, sig.params);
        return;
      }
      case 0x04: {
        // if
        const sig = this.blockSig(c);
        const cond = this.pop();
        const f = this.pushFrame("if", sig);
        f.ifParams = this.stack.slice(this.stack.length - sig.params.length);
        const then = this.label("then");
        f.elseLabel = this.label("else");
        const test = this.emit(`icmp ne i32 ${cond.v}, 0`);
        this.add(`  br i1 ${test}, label %${then}, label %${f.elseLabel}`);
        this.startBlock(then);
        return;
      }
      case 0x05:
        this.opElse();
        return;
      case 0x0c: {
        const depth = c.u32();
        this.branch(depth);
        this.goDead();
        return;
      }
      case 0x0d: {
        const depth = c.u32();
        const cond = this.pop();
        const test = this.emit(`icmp ne i32 ${cond.v}, 0`);
        const pending: string[] = [];
        const target = this.branchEdge(depth, pending);
        const cont = this.label("br");
        this.add(`  br i1 ${test}, label %${target}, label %${cont}`);
        for (const line of pending) this.add(line);
        this.startBlock(cont);
        return;
      }
      case 0x0e: {
        const n = c.u32();
        const depths: number[] = [];
        for (let i = 0; i < n; i++) depths.push(c.u32());
        const def = c.u32();
        const idx = this.pop();
        const pending: string[] = [];
        const edges = new Map<number, string>();
        const edgeOf = (d: number): string => {
          let e = edges.get(d);
          if (e === undefined) {
            e = this.branchEdge(d, pending);
            edges.set(d, e);
          }
          return e;
        };
        const cases = depths.map((d, i) => `i32 ${i}, label %${edgeOf(d)}`);
        this.add(`  switch i32 ${idx.v}, label %${edgeOf(def)} [${cases.join(" ")}]`);
        for (const line of pending) this.add(line);
        this.goDead();
        return;
      }
      case 0x0f: // return
        this.branch(this.frames.length - 1);
        this.goDead();
        return;
      case 0x10:
        this.call(c.u32());
        return;
      case 0x11: {
        const type = c.u32();
        const table = c.u32();
        this.callIndirect(type, table);
        return;
      }
      case 0x1a: {
        // A dropped load must still fault when it is out of bounds: LLVM
        // would delete an unused ordinary load.
        const v = this.pop();
        if (v.load !== undefined) {
          const line = this.lines.lines[v.load]!;
          this.lines.lines[v.load] = line.replace(" = load ", " = load volatile ");
        }
        return;
      }
      case 0x1b:
      case 0x1c: {
        if (op === 0x1c) {
          const n = c.u32();
          for (let i = 0; i < n; i++) c.valType();
        }
        const cond = this.pop();
        const b = this.pop();
        const a = this.pop();
        const test = this.emit(`icmp ne i32 ${cond.v}, 0`);
        const t = llType(a.t);
        this.push(this.emit(`select i1 ${test}, ${t} ${a.v}, ${t} ${b.v}`), a.t);
        return;
      }
      case 0x20: {
        const i = c.u32();
        const t = this.localType(i);
        this.push(this.emit(`load ${llType(t)}, ptr %l${i}`), t);
        return;
      }
      case 0x21: {
        const i = c.u32();
        const t = this.localType(i);
        const v = this.popType(t, "local.set");
        this.add(`  store ${llType(t)} ${v.v}, ptr %l${i}`);
        return;
      }
      case 0x22: {
        const i = c.u32();
        const t = this.localType(i);
        const v = this.popType(t, "local.tee");
        this.stack.push(v);
        this.add(`  store ${llType(t)} ${v.v}, ptr %l${i}`);
        return;
      }
      case 0x23: {
        const g = c.u32();
        const t = this.m.globals[g]!.type;
        const cell = this.loadPtrSlot(this.mt.globalSlot(g));
        this.push(this.emit(`load ${llType(t)}, ptr ${cell}, align 8`), t);
        return;
      }
      case 0x24: {
        const g = c.u32();
        const global = this.m.globals[g];
        if (global === undefined) throw new WasmTranslateError(`unknown global ${g}`);
        const v = this.popType(global.type, "global.set");
        const cell = this.loadPtrSlot(this.mt.globalSlot(g));
        if (v.t === VAL_EXTERNREF)
          this.add(`  call void @scr_wasm_global_set_ref(ptr ${cell}, ptr ${v.v})`);
        else this.add(`  store ${llType(v.t)} ${v.v}, ptr ${cell}, align 8`);
        return;
      }
      case 0x25: {
        const t = c.u32();
        const i = this.pop();
        this.push(
          this.emit(`call ptr @scr_wasm_table_get(ptr %inst, i32 ${t}, i32 ${i.v})`),
          this.m.tables[t]!.elemType,
        );
        return;
      }
      case 0x26: {
        const t = c.u32();
        const table = this.m.tables[t];
        if (table === undefined) throw new WasmTranslateError(`unknown table ${t}`);
        const v = this.popType(table.elemType, "table.set");
        const i = this.popType(VAL_I32, "table.set");
        this.add(`  call void @scr_wasm_table_set(ptr %inst, i32 ${t}, i32 ${i.v}, ptr ${v.v})`);
        return;
      }
      case 0x3f: {
        this.memoryIndex(c);
        const mem = this.loadPtrSlot(OFF_MEMORY);
        const sizePtr = this.emit(`getelementptr inbounds i8, ptr ${mem}, i64 8`);
        const size = this.emit(`load i64, ptr ${sizePtr}, align 8`);
        const pages = this.emit(`lshr i64 ${size}, 16`);
        this.push(this.emit(`trunc i64 ${pages} to i32`), VAL_I32);
        return;
      }
      case 0x40: {
        this.memoryIndex(c);
        const delta = this.pop();
        this.push(this.emit(`call i32 @scr_wasm_memory_grow(ptr %inst, i32 ${delta.v})`), VAL_I32);
        this.refreshMemory();
        return;
      }
      case 0x41:
        this.push(String(c.s32()), VAL_I32);
        return;
      case 0x42: {
        const [lo, hi] = c.s64();
        this.push(i64Lit(lo, hi), VAL_I64);
        return;
      }
      case 0x43:
        this.push(this.emit(`bitcast i32 ${c.u32le() | 0} to float`), VAL_F32);
        return;
      case 0x44: {
        const lo = c.u32le();
        const hi = c.u32le();
        this.push(this.emit(`bitcast i64 ${i64Lit(lo, hi)} to double`), VAL_F64);
        return;
      }
      case 0xd0:
        c.valType();
        this.push("null", c.bytes[c.pos - 1]!);
        return;
      case 0xd1: {
        const a = this.pop();
        const r = this.emit(`icmp eq ptr ${a.v}, null`);
        this.push(this.emit(`zext i1 ${r} to i32`), VAL_I32);
        return;
      }
      case 0xd2:
        this.push(this.funcRef(c.u32()), VAL_FUNCREF);
        return;
      case 0xfc:
        this.prefixed(c);
        return;
      case 0xfd:
        this.simd(c);
        return;
      default:
        break;
    }
    if (op >= 0x28 && op <= 0x35) {
      const offset = this.memargOffset(c);
      const [vt, mt, bytes, ext] = LOAD_INFO[op]!;
      const addr = this.popType(VAL_I32, "load address");
      const p = this.address(addr.v, offset, bytes);
      const line = this.lines.lines.length;
      const loaded = this.emit(`load ${mt}, ptr ${p}, align 1`);
      if (ext === "") this.stack.push({ v: loaded, t: vt, load: line });
      else {
        const extended = this.emit(`${ext} ${mt} ${loaded} to ${llType(vt)}`);
        this.stack.push({ v: extended, t: vt, load: line });
      }
      return;
    }
    if (op >= 0x36 && op <= 0x3e) {
      const offset = this.memargOffset(c);
      const [vt, mt, bytes] = STORE_INFO[op]!;
      const v = this.popType(vt, "store");
      const addr = this.popType(VAL_I32, "store address");
      const p = this.address(addr.v, offset, bytes);
      let value = v.v;
      if (mt === "i8" || mt === "i16" || (mt === "i32" && v.t === VAL_I64)) {
        value = this.emit(`trunc ${llType(v.t)} ${v.v} to ${mt}`);
      }
      this.add(`  store ${mt} ${value}, ptr ${p}, align 1`);
      return;
    }
    this.numeric(op);
  }

  // ── SIMD ────────────────────────────────────────────────────────────

  /** A canonical v128 value viewed as `shape` (a no-op for <4 x i32>). */
  view(v: string, shape: LaneShape): string {
    if (shape.type === V4I32) return v;
    return this.emit(`bitcast ${V4I32} ${v} to ${shape.type}`);
  }

  /** A shaped value back as the canonical v128. */
  canon(v: string, shape: LaneShape): string {
    if (shape.type === V4I32) return v;
    return this.emit(`bitcast ${shape.type} ${v} to ${V4I32}`);
  }

  /** Every lane of `shape` set to `scalar`. */
  splat(scalar: string, lane: string, shape: LaneShape): string {
    const one = this.emit(`insertelement ${shape.type} undef, ${lane} ${scalar}, i32 0`);
    return this.emit(
      `shufflevector ${shape.type} ${one}, ${shape.type} undef, <${shape.count} x i32> zeroinitializer`,
    );
  }

  /** Pops a v128 operand and views it as `shape`. */
  popShape(shape: LaneShape, what: string): string {
    return this.view(this.popType(VAL_V128, what).v, shape);
  }

  /** A v128 immediate and instruction. */
  simd(c: WasmCursor): void {
    const sub = c.u32();
    const op = simdOp(sub);
    if (op === undefined) throw new WasmTranslateError(`opcode 0xfd ${sub} is not supported`);
    let offset = 0;
    let lane = 0;
    let shuffle: number[] | null = null;
    switch (op.immediate) {
      case 1: {
        const bytes: number[] = [];
        for (let i = 0; i < 16; i++) bytes.push(c.u8());
        const lanes: number[] = [];
        for (let i = 0; i < 16; i += 4) {
          lanes.push(
            bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24) | 0,
          );
        }
        this.push(`<i32 ${lanes[0]}, i32 ${lanes[1]}, i32 ${lanes[2]}, i32 ${lanes[3]}>`, VAL_V128);
        return;
      }
      case 2:
        shuffle = [];
        for (let i = 0; i < 16; i++) shuffle.push(c.u8());
        break;
      case 3:
        lane = c.u8();
        break;
      case 4:
        offset = this.memarg(c).offset;
        break;
      case 5: {
        offset = this.memarg(c).offset;
        lane = c.u8();
        break;
      }
    }
    if (sub <= 11 || (sub >= 84 && sub <= 93)) {
      this.simdMemory(sub, offset, lane);
      return;
    }
    if (sub === 13) {
      this.simdShuffle(shuffle!);
      return;
    }
    if (sub === 14) {
      this.simdSwizzle();
      return;
    }
    if (sub >= 15 && sub <= 20) {
      this.simdSplat(sub);
      return;
    }
    if (sub >= 21 && sub <= 34) {
      this.simdLane(sub, lane);
      return;
    }
    if ((sub >= 35 && sub <= 76) || (sub >= 214 && sub <= 219)) {
      this.simdCompare(sub);
      return;
    }
    if (sub >= 77 && sub <= 83) {
      this.simdBitwise(sub);
      return;
    }
    if (sub === 94 || sub === 95 || (sub >= 248 && sub <= 255)) {
      this.simdConvert(sub);
      return;
    }
    if ((sub >= 103 && sub <= 106) || sub === 116 || sub === 117 || sub === 122 || sub === 148) {
      this.simdFloat(sub);
      return;
    }
    if (sub >= 224 && sub <= 247) {
      this.simdFloat(sub);
      return;
    }
    if (sub >= 96 && sub <= 223) {
      this.simdInteger(sub);
      return;
    }
    throw new WasmTranslateError(`SIMD instruction 0xfd ${sub} is not supported yet`);
  }

  /** The lane shape of a splat, extract/replace or load/store lane opcode. */
  simdShape(sub: number): LaneShape {
    if (sub >= 15 && sub <= 20) {
      return [SHAPE_I8, SHAPE_I16, SHAPE_I32, SHAPE_I64, SHAPE_F32, SHAPE_F64][sub - 15]!;
    }
    if (sub === 21 || sub === 22 || sub === 23) return SHAPE_I8;
    if (sub === 24 || sub === 25 || sub === 26) return SHAPE_I16;
    if (sub === 27 || sub === 28) return SHAPE_I32;
    if (sub === 29 || sub === 30) return SHAPE_I64;
    if (sub === 31 || sub === 32) return SHAPE_F32;
    if (sub === 33 || sub === 34) return SHAPE_F64;
    throw new WasmTranslateError(`SIMD instruction 0xfd ${sub} is not supported yet`);
  }

  simdSplat(sub: number): void {
    const shape = this.simdShape(sub);
    const scalar = this.pop();
    let value = scalar.v;
    if (shape.lane === "i8" || shape.lane === "i16") {
      value = this.emit(`trunc i32 ${value} to ${shape.lane}`);
    }
    this.push(this.canon(this.splat(value, shape.lane, shape), shape), VAL_V128);
  }

  simdLane(sub: number, lane: number): void {
    const shape = this.simdShape(sub);
    if (
      sub === 21 ||
      sub === 22 ||
      sub === 24 ||
      sub === 25 ||
      sub === 27 ||
      sub === 29 ||
      sub === 31 ||
      sub === 33
    ) {
      const x = this.popShape(shape, "extract_lane");
      let value = this.emit(`extractelement ${shape.type} ${x}, i32 ${lane}`);
      if (shape.lane === "i8" || shape.lane === "i16") {
        const signed = sub === 21 || sub === 24;
        value = this.emit(`${signed ? "sext" : "zext"} ${shape.lane} ${value} to i32`);
      }
      const result =
        shape.lane === "i64"
          ? VAL_I64
          : shape.lane === "float"
            ? VAL_F32
            : shape.lane === "double"
              ? VAL_F64
              : VAL_I32;
      this.push(value, result);
      return;
    }
    const scalar = this.pop();
    const x = this.popType(VAL_V128, "replace_lane");
    let value = scalar.v;
    if (shape.lane === "i8" || shape.lane === "i16") {
      value = this.emit(`trunc i32 ${value} to ${shape.lane}`);
    }
    const inserted = this.emit(
      `insertelement ${shape.type} ${this.view(x.v, shape)}, ${shape.lane} ${value}, i32 ${lane}`,
    );
    this.push(this.canon(inserted, shape), VAL_V128);
  }

  simdShuffle(mask: readonly number[]): void {
    const b = this.popShape(SHAPE_I8, "shuffle");
    const a = this.popShape(SHAPE_I8, "shuffle");
    const lanes: string[] = [];
    for (const lane of mask) lanes.push(`i32 ${lane}`);
    const shuffled = this.emit(
      `shufflevector ${V16I8} ${a}, ${V16I8} ${b}, <16 x i32> <${lanes.join(", ")}>`,
    );
    this.push(this.canon(shuffled, SHAPE_I8), VAL_V128);
  }

  simdCompare(sub: number): void {
    if (sub >= 65 && sub <= 76) {
      // Float comparisons: eq/ne are ordered/unordered so NaN compares as
      // WebAssembly requires; the result is an all-ones lane mask.
      const f32 = sub <= 70;
      const operand = f32 ? SHAPE_F32 : SHAPE_F64;
      const maskShape = f32 ? SHAPE_I32 : SHAPE_I64;
      const pred = ["oeq", "une", "olt", "ogt", "ole", "oge"][(sub - 65) % 6]!;
      const b = this.popShape(operand, "simd comparison");
      const a = this.popShape(operand, "simd comparison");
      const bits = this.emit(`fcmp ${pred} ${operand.type} ${a}, ${b}`);
      const mask = this.emit(`sext <${operand.count} x i1> ${bits} to ${maskShape.type}`);
      this.push(this.canon(mask, maskShape), VAL_V128);
      return;
    }
    let shape: LaneShape;
    let pred: string;
    const signed = ["eq", "ne", "slt", "ult", "sgt", "ugt", "sle", "ule", "sge", "uge"];
    if (sub >= 35 && sub <= 64) {
      const group = Math.floor((sub - 35) / 10);
      shape = group === 0 ? SHAPE_I8 : group === 1 ? SHAPE_I16 : SHAPE_I32;
      pred = signed[(sub - 35) % 10]!;
    } else {
      shape = SHAPE_I64;
      pred = ["eq", "ne", "slt", "sgt", "sle", "sge"][sub - 214]!;
    }
    const b = this.popShape(shape, "simd comparison");
    const a = this.popShape(shape, "simd comparison");
    const bits = this.emit(`icmp ${pred} ${shape.type} ${a}, ${b}`);
    const mask = this.emit(`sext <${shape.count} x i1> ${bits} to ${shape.type}`);
    this.push(this.canon(mask, shape), VAL_V128);
  }

  /** The all-ones value of the canonical vector. */
  simdAllOnes(): string {
    return "<i32 -1, i32 -1, i32 -1, i32 -1>";
  }

  simdBitwise(sub: number): void {
    if (sub === 77) {
      const a = this.popShape(SHAPE_I32, "v128.not");
      this.push(this.emit(`xor ${V4I32} ${a}, ${this.simdAllOnes()}`), VAL_V128);
      return;
    }
    if (sub === 82) {
      const c = this.popShape(SHAPE_I32, "v128.bitselect");
      const b = this.popShape(SHAPE_I32, "v128.bitselect");
      const a = this.popShape(SHAPE_I32, "v128.bitselect");
      const notC = this.emit(`xor ${V4I32} ${c}, ${this.simdAllOnes()}`);
      const left = this.emit(`and ${V4I32} ${a}, ${c}`);
      const right = this.emit(`and ${V4I32} ${b}, ${notC}`);
      this.push(this.emit(`or ${V4I32} ${left}, ${right}`), VAL_V128);
      return;
    }
    if (sub === 83) {
      const a = this.popShape(SHAPE_I32, "v128.any_true");
      const wide = this.emit(`bitcast ${V4I32} ${a} to i128`);
      const any = this.emit(`icmp ne i128 ${wide}, 0`);
      this.push(this.emit(`zext i1 ${any} to i32`), VAL_I32);
      return;
    }
    const name = sub === 78 ? "and" : sub === 79 ? "andnot" : sub === 80 ? "or" : "xor";
    const b = this.popShape(SHAPE_I32, `v128.${name}`);
    const a = this.popShape(SHAPE_I32, `v128.${name}`);
    if (name === "andnot") {
      const notB = this.emit(`xor ${V4I32} ${b}, ${this.simdAllOnes()}`);
      this.push(this.emit(`and ${V4I32} ${a}, ${notB}`), VAL_V128);
      return;
    }
    this.push(this.emit(`${name} ${V4I32} ${a}, ${b}`), VAL_V128);
  }

  /** A SIMD memory instruction. Wasm's memarg alignment is a hint: the same
   * instruction may run unaligned, so every access is emitted `align 1`
   * (like the scalar loads and stores at `instruction`). */
  simdMemory(sub: number, offset: number, lane: number): void {
    const shape =
      sub >= 7 && sub <= 10
        ? [SHAPE_I8, SHAPE_I16, SHAPE_I32, SHAPE_I64][sub - 7]!
        : sub >= 84 && sub <= 91
          ? [SHAPE_I8, SHAPE_I16, SHAPE_I32, SHAPE_I64][(sub - 84) % 4]!
          : SHAPE_I32;
    const bytes = sub === 0 || sub === 11 ? 16 : sub === 92 ? 4 : sub === 93 ? 8 : 16 / shape.count;
    if (sub === 0) {
      const address = this.popType(VAL_I32, "load address");
      const p = this.address(address.v, offset, 16);
      const line = this.lines.lines.length;
      const loaded = this.emit(`load ${V4I32}, ptr ${p}, align 1`);
      this.stack.push({ v: loaded, t: VAL_V128, load: line });
      return;
    }
    if (sub === 11) {
      const value = this.popType(VAL_V128, "store");
      const address = this.popType(VAL_I32, "store address");
      const p = this.address(address.v, offset, 16);
      this.add(`  store ${V4I32} ${value.v}, ptr ${p}, align 1`);
      return;
    }
    if (sub >= 1 && sub <= 6) {
      // load8x8/16x4/32x2: widen the eight bytes read from memory.
      const dst = sub <= 2 ? SHAPE_I16 : sub <= 4 ? SHAPE_I32 : SHAPE_I64;
      const signed = sub === 1 || sub === 3 || sub === 5;
      const halfType = sub <= 2 ? "<8 x i8>" : sub <= 4 ? "<4 x i16>" : "<2 x i32>";
      const address = this.popType(VAL_I32, "load address");
      const p = this.address(address.v, offset, 8);
      const line = this.lines.lines.length;
      const loaded = this.emit(`load ${halfType}, ptr ${p}, align 1`);
      const extended = this.emit(
        `${signed ? "sext" : "zext"} ${halfType} ${loaded} to ${dst.type}`,
      );
      this.stack.push({ v: this.canon(extended, dst), t: VAL_V128, load: line });
      return;
    }
    if (sub >= 7 && sub <= 10) {
      const address = this.popType(VAL_I32, "load address");
      const p = this.address(address.v, offset, bytes);
      const line = this.lines.lines.length;
      const scalar = this.emit(`load ${shape.lane}, ptr ${p}, align 1`);
      this.stack.push({
        v: this.canon(this.splat(scalar, shape.lane, shape), shape),
        t: VAL_V128,
        load: line,
      });
      return;
    }
    if (sub >= 84 && sub <= 87) {
      const vector = this.popType(VAL_V128, "load lane");
      const address = this.popType(VAL_I32, "load lane address");
      const p = this.address(address.v, offset, bytes);
      const line = this.lines.lines.length;
      const scalar = this.emit(`load ${shape.lane}, ptr ${p}, align 1`);
      const inserted = this.emit(
        `insertelement ${shape.type} ${this.view(vector.v, shape)}, ${shape.lane} ${scalar}, i32 ${lane}`,
      );
      this.stack.push({ v: this.canon(inserted, shape), t: VAL_V128, load: line });
      return;
    }
    if (sub >= 88 && sub <= 91) {
      const vector = this.popType(VAL_V128, "store lane");
      const address = this.popType(VAL_I32, "store lane address");
      const p = this.address(address.v, offset, bytes);
      const scalar = this.emit(
        `extractelement ${shape.type} ${this.view(vector.v, shape)}, i32 ${lane}`,
      );
      this.add(`  store ${shape.lane} ${scalar}, ptr ${p}, align 1`);
      return;
    }
    if (sub === 92 || sub === 93) {
      const address = this.popType(VAL_I32, "load address");
      const p = this.address(address.v, offset, bytes);
      const line = this.lines.lines.length;
      let value: string;
      if (sub === 92) {
        const loaded = this.emit(`load i32, ptr ${p}, align 1`);
        value = this.emit(`zext i32 ${loaded} to i64`);
      } else {
        value = this.emit(`load i64, ptr ${p}, align 1`);
      }
      const inserted = this.emit(`insertelement ${V2I64} zeroinitializer, i64 ${value}, i32 0`);
      this.stack.push({ v: this.canon(inserted, SHAPE_I64), t: VAL_V128, load: line });
      return;
    }
    throw new WasmTranslateError(`SIMD instruction 0xfd ${sub} is not supported yet`);
  }

  /** A lane-wise integer instruction: comparisons, arithmetic, mask ops. */
  simdInteger(sub: number): void {
    let shape: LaneShape;
    if (sub >= 96 && sub <= 123) shape = SHAPE_I8;
    else if (sub >= 128 && sub <= 159) shape = SHAPE_I16;
    else if (sub >= 160 && sub <= 191) shape = SHAPE_I32;
    else shape = SHAPE_I64;
    switch (sub) {
      case 96:
      case 128:
      case 160:
      case 192: {
        // abs
        const a = this.popShape(shape, "abs");
        const zero = "zeroinitializer";
        const negative = this.emit(`icmp slt ${shape.type} ${a}, ${zero}`);
        const negated = this.emit(`sub ${shape.type} ${zero}, ${a}`);
        const chosen = this.emit(
          `select <${shape.count} x i1> ${negative}, ${shape.type} ${negated}, ${shape.type} ${a}`,
        );
        this.push(this.canon(chosen, shape), VAL_V128);
        return;
      }
      case 97:
      case 129:
      case 161:
      case 193: {
        // neg
        const a = this.popShape(shape, "neg");
        const zero = "zeroinitializer";
        this.push(this.canon(this.emit(`sub ${shape.type} ${zero}, ${a}`), shape), VAL_V128);
        return;
      }
      case 99:
      case 131:
      case 163:
      case 195: {
        // all_true
        const a = this.popShape(shape, "all_true");
        const zero = "zeroinitializer";
        const bits = this.emit(`icmp ne ${shape.type} ${a}, ${zero}`);
        const packed = this.emit(`bitcast <${shape.count} x i1> ${bits} to i${shape.count}`);
        const all = this.emit(`icmp eq i${shape.count} ${packed}, -1`);
        this.push(this.emit(`zext i1 ${all} to i32`), VAL_I32);
        return;
      }
      case 100:
      case 132:
      case 164:
      case 196: {
        // bitmask
        const a = this.popShape(shape, "bitmask");
        const zero = "zeroinitializer";
        const bits = this.emit(`icmp slt ${shape.type} ${a}, ${zero}`);
        const packed = this.emit(`bitcast <${shape.count} x i1> ${bits} to i${shape.count}`);
        this.push(this.emit(`zext i${shape.count} ${packed} to i32`), VAL_I32);
        return;
      }
      case 107:
      case 108:
      case 109:
      case 139:
      case 140:
      case 141:
      case 171:
      case 172:
      case 173:
      case 203:
      case 204:
      case 205: {
        // shifts: the count is a masked i32 splatted to the lanes.
        const count = this.popType(VAL_I32, "shift");
        const a = this.popShape(shape, "shift");
        const laneBits =
          shape.lane === "i8" ? 7 : shape.lane === "i16" ? 15 : shape.lane === "i32" ? 31 : 63;
        let masked = this.emit(`and i32 ${count.v}, ${laneBits}`);
        if (shape.lane === "i8" || shape.lane === "i16") {
          masked = this.emit(`trunc i32 ${masked} to ${shape.lane}`);
        } else if (shape.lane === "i64") {
          masked = this.emit(`zext i32 ${masked} to i64`);
        }
        const amounts = this.splat(masked, shape.lane, shape);
        const name =
          sub === 107 || sub === 139 || sub === 171 || sub === 203
            ? "shl"
            : sub === 108 || sub === 140 || sub === 172 || sub === 204
              ? "ashr"
              : "lshr";
        this.push(this.canon(this.emit(`${name} ${shape.type} ${a}, ${amounts}`), shape), VAL_V128);
        return;
      }
      case 110:
      case 113:
      case 142:
      case 145:
      case 174:
      case 177:
      case 206:
      case 209: {
        const name = sub === 110 || sub === 142 || sub === 174 || sub === 206 ? "add" : "sub";
        const b = this.popShape(shape, `i${shape.lane}.${name}`);
        const a = this.popShape(shape, `i${shape.lane}.${name}`);
        this.push(this.canon(this.emit(`${name} ${shape.type} ${a}, ${b}`), shape), VAL_V128);
        return;
      }
      case 118:
      case 119:
      case 120:
      case 121:
      case 150:
      case 151:
      case 152:
      case 153:
      case 182:
      case 183:
      case 184:
      case 185: {
        const signed =
          sub === 118 || sub === 120 || sub === 150 || sub === 152 || sub === 182 || sub === 184;
        const max =
          sub === 120 || sub === 121 || sub === 152 || sub === 153 || sub === 184 || sub === 185;
        const b = this.popShape(shape, "min/max");
        const a = this.popShape(shape, "min/max");
        const pred = max ? (signed ? "sgt" : "ugt") : signed ? "slt" : "ult";
        const bits = this.emit(`icmp ${pred} ${shape.type} ${a}, ${b}`);
        const chosen = this.emit(
          `select <${shape.count} x i1> ${bits}, ${shape.type} ${a}, ${shape.type} ${b}`,
        );
        this.push(this.canon(chosen, shape), VAL_V128);
        return;
      }
      case 98: {
        const a = this.popShape(SHAPE_I8, "popcnt");
        const decl = `declare ${V16I8} @llvm.ctpop.v16i8(${V16I8})`;
        const call = `call ${V16I8} @llvm.ctpop.v16i8(${V16I8} ${a})`;
        this.push(this.canon(this.intrinsic(decl, call), SHAPE_I8), VAL_V128);
        return;
      }
      case 101:
      case 102:
      case 133:
      case 134:
        this.simdNarrow(sub);
        return;
      case 111:
        this.simdSat("sadd.sat", SHAPE_I8);
        return;
      case 112:
        this.simdSat("uadd.sat", SHAPE_I8);
        return;
      case 114:
        this.simdSat("ssub.sat", SHAPE_I8);
        return;
      case 115:
        this.simdSat("usub.sat", SHAPE_I8);
        return;
      case 123:
        this.simdAvgr(SHAPE_I8);
        return;
      case 124:
      case 125:
      case 126:
      case 127:
        this.simdExtadd(sub);
        return;
      case 130:
        this.simdQ15();
        return;
      case 135:
      case 136:
      case 137:
      case 138:
      case 167:
      case 168:
      case 169:
      case 170:
      case 199:
      case 200:
      case 201:
      case 202:
        this.simdExtend(sub);
        return;
      case 143:
        this.simdSat("sadd.sat", SHAPE_I16);
        return;
      case 144:
        this.simdSat("uadd.sat", SHAPE_I16);
        return;
      case 146:
        this.simdSat("ssub.sat", SHAPE_I16);
        return;
      case 147:
        this.simdSat("usub.sat", SHAPE_I16);
        return;
      case 149:
        this.simdMul(SHAPE_I16);
        return;
      case 155:
        this.simdAvgr(SHAPE_I16);
        return;
      case 156:
      case 157:
      case 158:
      case 159:
      case 188:
      case 189:
      case 190:
      case 191:
      case 220:
      case 221:
      case 222:
      case 223:
        this.simdExtmul(sub);
        return;
      case 181:
        this.simdMul(SHAPE_I32);
        return;
      case 186:
        this.simdDot();
        return;
      case 213:
        this.simdMul(SHAPE_I64);
        return;
      case 214:
      case 215:
      case 216:
      case 217:
      case 218:
      case 219:
        this.simdCompare(sub);
        return;
      default:
        throw new WasmTranslateError(`SIMD instruction 0xfd ${sub} is not supported yet`);
    }
  }

  /** add_sat/sub_sat through LLVM's saturating vector intrinsics. */
  simdSat(name: string, shape: LaneShape): void {
    const suffix = `v${shape.count}${shape.lane}`;
    const decl = `declare ${shape.type} @llvm.${name}.${suffix}(${shape.type}, ${shape.type})`;
    const b = this.popShape(shape, name);
    const a = this.popShape(shape, name);
    const call = `call ${shape.type} @llvm.${name}.${suffix}(${shape.type} ${a}, ${shape.type} ${b})`;
    this.push(this.canon(this.intrinsic(decl, call), shape), VAL_V128);
  }

  simdMul(shape: LaneShape): void {
    const b = this.popShape(shape, "mul");
    const a = this.popShape(shape, "mul");
    this.push(this.canon(this.emit(`mul ${shape.type} ${a}, ${b}`), shape), VAL_V128);
  }

  /** avgr_u: (a + b + 1) >> 1 in one wider lane. */
  simdAvgr(shape: LaneShape): void {
    const wide: LaneShape =
      shape === SHAPE_I8
        ? { type: "<16 x i16>", lane: "i16", count: 16 }
        : { type: "<8 x i32>", lane: "i32", count: 8 };
    const b = this.popShape(shape, "avgr_u");
    const a = this.popShape(shape, "avgr_u");
    const aw = this.emit(`zext ${shape.type} ${a} to ${wide.type}`);
    const bw = this.emit(`zext ${shape.type} ${b} to ${wide.type}`);
    const sum = this.emit(`add ${wide.type} ${aw}, ${bw}`);
    const plus = this.emit(`add ${wide.type} ${sum}, ${this.splat("1", wide.lane, wide)}`);
    const half = this.emit(`lshr ${wide.type} ${plus}, ${this.splat("1", wide.lane, wide)}`);
    this.push(
      this.canon(this.emit(`trunc ${wide.type} ${half} to ${shape.type}`), shape),
      VAL_V128,
    );
  }

  /** i16x8.q15mulr_sat_s: (a*b + 0x4000) >> 15, saturated to i16. */
  simdQ15(): void {
    const b = this.popShape(SHAPE_I16, "q15mulr");
    const a = this.popShape(SHAPE_I16, "q15mulr");
    const wide = "<8 x i32>";
    const wideShape: LaneShape = { type: wide, lane: "i32", count: 8 };
    const aw = this.emit(`sext ${V8I16} ${a} to ${wide}`);
    const bw = this.emit(`sext ${V8I16} ${b} to ${wide}`);
    const product = this.emit(`mul ${wide} ${aw}, ${bw}`);
    const rounded = this.emit(`add ${wide} ${product}, ${this.splat("16384", "i32", wideShape)}`);
    const scaled = this.emit(`ashr ${wide} ${rounded}, ${this.splat("15", "i32", wideShape)}`);
    const max = this.splat("32767", "i32", wideShape);
    const over = this.emit(`icmp sgt ${wide} ${scaled}, ${max}`);
    const clamped = this.emit(`select <8 x i1> ${over}, ${wide} ${max}, ${wide} ${scaled}`);
    this.push(this.canon(this.emit(`trunc ${wide} ${clamped} to ${V8I16}`), SHAPE_I16), VAL_V128);
  }

  /** One half (low or high) of `value` extended to the wider lane shape. */
  extendHalf(
    value: string,
    src: LaneShape,
    dst: LaneShape,
    signed: boolean,
    high: boolean,
  ): string {
    const half = src.count / 2;
    const lanes: string[] = [];
    for (let i = 0; i < half; i++) lanes.push(`i32 ${high ? i + half : i}`);
    const shuffled = this.emit(
      `shufflevector ${src.type} ${value}, ${src.type} undef, <${half} x i32> <${lanes.join(", ")}>`,
    );
    const halfType = `<${half} x ${src.lane}>`;
    return this.emit(`${signed ? "sext" : "zext"} ${halfType} ${shuffled} to ${dst.type}`);
  }

  /** extend_low/high_s/u for every shape. */
  simdExtend(sub: number): void {
    let src: LaneShape;
    let dst: LaneShape;
    let signed: boolean;
    let high: boolean;
    if (sub >= 135 && sub <= 138) {
      src = SHAPE_I8;
      dst = SHAPE_I16;
      signed = sub <= 136;
      high = sub === 136 || sub === 138;
    } else if (sub >= 167 && sub <= 170) {
      src = SHAPE_I16;
      dst = SHAPE_I32;
      signed = sub <= 168;
      high = sub === 168 || sub === 170;
    } else {
      src = SHAPE_I32;
      dst = SHAPE_I64;
      signed = sub <= 200;
      high = sub === 200 || sub === 202;
    }
    const a = this.popShape(src, "extend");
    const extended = this.extendHalf(a, src, dst, signed, high);
    this.push(this.canon(extended, dst), VAL_V128);
  }

  /** extmul_low/high_s/u: widen both operands, then multiply. */
  simdExtmul(sub: number): void {
    let src: LaneShape;
    let dst: LaneShape;
    let signed: boolean;
    let high: boolean;
    if (sub >= 156 && sub <= 159) {
      src = SHAPE_I8;
      dst = SHAPE_I16;
      signed = sub <= 157;
      high = sub === 157 || sub === 159;
    } else if (sub >= 188 && sub <= 191) {
      src = SHAPE_I16;
      dst = SHAPE_I32;
      signed = sub <= 189;
      high = sub === 189 || sub === 191;
    } else {
      src = SHAPE_I32;
      dst = SHAPE_I64;
      signed = sub <= 221;
      high = sub === 221 || sub === 223;
    }
    const b = this.popShape(src, "extmul");
    const a = this.popShape(src, "extmul");
    const aw = this.extendHalf(a, src, dst, signed, high);
    const bw = this.extendHalf(b, src, dst, signed, high);
    this.push(this.canon(this.emit(`mul ${dst.type} ${aw}, ${bw}`), dst), VAL_V128);
  }

  /** extadd_pairwise_s/u: extend the even and odd lanes and add them. */
  simdExtadd(sub: number): void {
    const from8 = sub <= 125;
    const src = from8 ? SHAPE_I8 : SHAPE_I16;
    const dst = from8 ? SHAPE_I16 : SHAPE_I32;
    const signed = sub === 124 || sub === 126;
    const a = this.popShape(src, "extadd_pairwise");
    const even: string[] = [];
    const odd: string[] = [];
    for (let i = 0; i < dst.count; i++) {
      even.push(`i32 ${2 * i}`);
      odd.push(`i32 ${2 * i + 1}`);
    }
    const evens = this.emit(
      `shufflevector ${src.type} ${a}, ${src.type} undef, <${dst.count} x i32> <${even.join(", ")}>`,
    );
    const odds = this.emit(
      `shufflevector ${src.type} ${a}, ${src.type} undef, <${dst.count} x i32> <${odd.join(", ")}>`,
    );
    const halfType = `<${dst.count} x ${src.lane}>`;
    const ev = this.emit(`${signed ? "sext" : "zext"} ${halfType} ${evens} to ${dst.type}`);
    const od = this.emit(`${signed ? "sext" : "zext"} ${halfType} ${odds} to ${dst.type}`);
    this.push(this.canon(this.emit(`add ${dst.type} ${ev}, ${od}`), dst), VAL_V128);
  }

  /** i32x4.dot_i16x8_s: widen, multiply, add adjacent products. */
  simdDot(): void {
    const b = this.popShape(SHAPE_I16, "dot");
    const a = this.popShape(SHAPE_I16, "dot");
    const wide = "<8 x i32>";
    const aw = this.emit(`sext ${V8I16} ${a} to ${wide}`);
    const bw = this.emit(`sext ${V8I16} ${b} to ${wide}`);
    const product = this.emit(`mul ${wide} ${aw}, ${bw}`);
    const evens = this.emit(
      `shufflevector ${wide} ${product}, ${wide} undef, <4 x i32> <i32 0, i32 2, i32 4, i32 6>`,
    );
    const odds = this.emit(
      `shufflevector ${wide} ${product}, ${wide} undef, <4 x i32> <i32 1, i32 3, i32 5, i32 7>`,
    );
    this.push(this.emit(`add ${V4I32} ${evens}, ${odds}`), VAL_V128);
  }

  /** narrow_iNxM_s/u: concatenate, clamp, truncate. The unsigned form's
   * inputs are signed, so it clamps to 0 first. */
  simdNarrow(sub: number): void {
    const from16 = sub === 101 || sub === 102;
    const src = from16 ? SHAPE_I16 : SHAPE_I32;
    const dst = from16 ? SHAPE_I8 : SHAPE_I16;
    const signed = sub === 101 || sub === 133;
    const b = this.popShape(src, "narrow");
    const a = this.popShape(src, "narrow");
    const joinedShape: LaneShape = {
      type: `<${src.count * 2} x ${src.lane}>`,
      lane: src.lane,
      count: src.count * 2,
    };
    const lanes: string[] = [];
    for (let i = 0; i < src.count * 2; i++) lanes.push(`i32 ${i}`);
    const joined = this.emit(
      `shufflevector ${src.type} ${a}, ${src.type} ${b}, <${src.count * 2} x i32> <${lanes.join(", ")}>`,
    );
    const bits = from16 ? 8 : 16;
    const low = signed ? -(1 << (bits - 1)) : 0;
    const high = signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1;
    const lowSplat = this.splat(String(low), src.lane, joinedShape);
    const highSplat = this.splat(String(high), src.lane, joinedShape);
    const below = this.emit(`icmp slt ${joinedShape.type} ${joined}, ${lowSplat}`);
    const clampedLow = this.emit(
      `select <${joinedShape.count} x i1> ${below}, ${joinedShape.type} ${lowSplat}, ${joinedShape.type} ${joined}`,
    );
    const above = this.emit(`icmp sgt ${joinedShape.type} ${clampedLow}, ${highSplat}`);
    const clamped = this.emit(
      `select <${joinedShape.count} x i1> ${above}, ${joinedShape.type} ${highSplat}, ${joinedShape.type} ${clampedLow}`,
    );
    const narrowed = this.emit(`trunc ${joinedShape.type} ${clamped} to ${dst.type}`);
    this.push(this.canon(narrowed, dst), VAL_V128);
  }

  /** i8x16.swizzle: each lane selects source[idx] or zero when idx > 15.
   * Sixteen vector compare/select steps, no scalar loop; a target with
   * pshufb/tbl1 can fold this, which the target-cpu attribute enables. */
  simdSwizzle(): void {
    const indices = this.popShape(SHAPE_I8, "swizzle");
    const source = this.popShape(SHAPE_I8, "swizzle");
    let result = this.emit(`bitcast ${V4I32} zeroinitializer to ${V16I8}`);
    for (let lane = 0; lane < 16; lane++) {
      const wanted = this.splat(String(lane), "i8", SHAPE_I8);
      const match = this.emit(`icmp eq ${V16I8} ${indices}, ${wanted}`);
      const value = this.splat(
        this.emit(`extractelement ${V16I8} ${source}, i32 ${lane}`),
        "i8",
        SHAPE_I8,
      );
      result = this.emit(`select <16 x i1> ${match}, ${V16I8} ${value}, ${V16I8} ${result}`);
    }
    this.push(this.canon(result, SHAPE_I8), VAL_V128);
  }

  /** The float arithmetic and rounding instructions. `min`/`max` are IEEE
   * minimum/maximum (NaN-propagating, -0 < +0); `pmin`/`pmax` are the
   * WebAssembly pseudo-forms b < a ? b : a and a < b ? b : a. */
  simdFloat(sub: number): void {
    const rounding = new Map<number, [string, string]>([
      [103, ["llvm.ceil", "ceil"]],
      [104, ["llvm.floor", "floor"]],
      [105, ["llvm.trunc", "trunc"]],
      [106, ["llvm.roundeven", "roundeven"]],
      [116, ["llvm.ceil", "ceil"]],
      [117, ["llvm.floor", "floor"]],
      [122, ["llvm.trunc", "trunc"]],
      [148, ["llvm.roundeven", "roundeven"]],
    ]);
    const f32 = (sub >= 103 && sub <= 106) || (sub >= 224 && sub <= 235);
    const shape = f32 ? SHAPE_F32 : SHAPE_F64;
    const mangle = f32 ? "v4f32" : "v2f64";
    const round = rounding.get(sub);
    if (round !== undefined) {
      const a = this.popShape(shape, round[1]);
      const decl = `declare ${shape.type} @${round[0]}.${mangle}(${shape.type})`;
      const call = `call ${shape.type} @${round[0]}.${mangle}(${shape.type} ${a})`;
      this.push(this.canon(this.intrinsic(decl, call), shape), VAL_V128);
      return;
    }
    const kind = sub >= 236 ? sub - 12 : sub;
    if (kind === 224 || kind === 225 || kind === 227) {
      const a = this.popShape(shape, kind === 224 ? "abs" : kind === 225 ? "neg" : "sqrt");
      if (kind === 225) {
        this.push(this.canon(this.emit(`fneg ${shape.type} ${a}`), shape), VAL_V128);
        return;
      }
      const name = kind === 224 ? "llvm.fabs" : "llvm.sqrt";
      const decl = `declare ${shape.type} @${name}.${mangle}(${shape.type})`;
      const call = `call ${shape.type} @${name}.${mangle}(${shape.type} ${a})`;
      this.push(this.canon(this.intrinsic(decl, call), shape), VAL_V128);
      return;
    }
    if (kind >= 228 && kind <= 235) {
      const b = this.popShape(shape, "simd arithmetic");
      const a = this.popShape(shape, "simd arithmetic");
      if (kind <= 231) {
        const name = ["fadd", "fsub", "fmul", "fdiv"][kind - 228]!;
        this.push(this.canon(this.emit(`${name} ${shape.type} ${a}, ${b}`), shape), VAL_V128);
        return;
      }
      if (kind === 232 || kind === 233) {
        const name = kind === 232 ? "llvm.minimum" : "llvm.maximum";
        const decl = `declare ${shape.type} @${name}.${mangle}(${shape.type}, ${shape.type})`;
        const call = `call ${shape.type} @${name}.${mangle}(${shape.type} ${a}, ${shape.type} ${b})`;
        this.push(this.canon(this.intrinsic(decl, call), shape), VAL_V128);
        return;
      }
      // pmin(a, b) = b < a ? b : a; pmax(a, b) = a < b ? b : a.
      const test = this.emit(
        kind === 234 ? `fcmp olt ${shape.type} ${b}, ${a}` : `fcmp olt ${shape.type} ${a}, ${b}`,
      );
      const chosen = this.emit(
        `select <${shape.count} x i1> ${test}, ${shape.type} ${b}, ${shape.type} ${a}`,
      );
      this.push(this.canon(chosen, shape), VAL_V128);
      return;
    }
    throw new WasmTranslateError(`SIMD instruction 0xfd ${sub} is not supported yet`);
  }

  /** Float/integer conversions, including the saturating truncations. */
  simdConvert(sub: number): void {
    if (sub === 94) {
      // f32x4.demote_f64x2_zero
      const a = this.popShape(SHAPE_F64, "demote");
      const low = this.emit(`fptrunc ${V2F64} ${a} to <2 x float>`);
      const joined = this.emit(
        `shufflevector <2 x float> ${low}, <2 x float> zeroinitializer, <4 x i32> <i32 0, i32 1, i32 2, i32 3>`,
      );
      this.push(this.canon(joined, SHAPE_F32), VAL_V128);
      return;
    }
    if (sub === 95) {
      // f64x2.promote_low_f32x4
      const a = this.popShape(SHAPE_F32, "promote");
      const low = this.emit(
        `shufflevector ${V4F32} ${a}, ${V4F32} undef, <2 x i32> <i32 0, i32 1>`,
      );
      this.push(this.canon(this.emit(`fpext <2 x float> ${low} to ${V2F64}`), SHAPE_F64), VAL_V128);
      return;
    }
    if (sub === 248 || sub === 249) {
      const a = this.popShape(SHAPE_F32, "trunc_sat");
      const name = sub === 248 ? "llvm.fptosi.sat.v4i32.v4f32" : "llvm.fptoui.sat.v4i32.v4f32";
      const decl = `declare <4 x i32> @${name}(${V4F32})`;
      const call = `call <4 x i32> @${name}(${V4F32} ${a})`;
      this.push(this.intrinsic(decl, call), VAL_V128);
      return;
    }
    if (sub === 250 || sub === 251) {
      const a = this.popShape(SHAPE_I32, "convert");
      const name = sub === 250 ? "sitofp" : "uitofp";
      this.push(this.canon(this.emit(`${name} ${V4I32} ${a} to ${V4F32}`), SHAPE_F32), VAL_V128);
      return;
    }
    if (sub === 252 || sub === 253) {
      const a = this.popShape(SHAPE_F64, "trunc_sat");
      const name = sub === 252 ? "llvm.fptosi.sat.v2i32.v2f64" : "llvm.fptoui.sat.v2i32.v2f64";
      const decl = `declare <2 x i32> @${name}(${V2F64})`;
      const call = `call <2 x i32> @${name}(${V2F64} ${a})`;
      const low = this.intrinsic(decl, call);
      const joined = this.emit(
        `shufflevector <2 x i32> ${low}, <2 x i32> zeroinitializer, <4 x i32> <i32 0, i32 1, i32 2, i32 3>`,
      );
      this.push(joined, VAL_V128);
      return;
    }
    if (sub === 254 || sub === 255) {
      const a = this.popShape(SHAPE_I32, "convert");
      const low = this.emit(
        `shufflevector ${V4I32} ${a}, ${V4I32} undef, <2 x i32> <i32 0, i32 1>`,
      );
      const name = sub === 254 ? "sitofp" : "uitofp";
      this.push(this.canon(this.emit(`${name} <2 x i32> ${low} to ${V2F64}`), SHAPE_F64), VAL_V128);
      return;
    }
    throw new WasmTranslateError(`SIMD instruction 0xfd ${sub} is not supported yet`);
  }

  numeric(op: number): void {
    const I32 = VAL_I32;
    const I64 = VAL_I64;
    const F32 = VAL_F32;
    const F64 = VAL_F64;
    switch (op) {
      case 0x45:
        return this.eqz("i32");
      case 0x46:
        return this.compare("eq", "i32", false);
      case 0x47:
        return this.compare("ne", "i32", false);
      case 0x48:
        return this.compare("slt", "i32", false);
      case 0x49:
        return this.compare("ult", "i32", false);
      case 0x4a:
        return this.compare("sgt", "i32", false);
      case 0x4b:
        return this.compare("ugt", "i32", false);
      case 0x4c:
        return this.compare("sle", "i32", false);
      case 0x4d:
        return this.compare("ule", "i32", false);
      case 0x4e:
        return this.compare("sge", "i32", false);
      case 0x4f:
        return this.compare("uge", "i32", false);
      case 0x50:
        return this.eqz("i64");
      case 0x51:
        return this.compare("eq", "i64", false);
      case 0x52:
        return this.compare("ne", "i64", false);
      case 0x53:
        return this.compare("slt", "i64", false);
      case 0x54:
        return this.compare("ult", "i64", false);
      case 0x55:
        return this.compare("sgt", "i64", false);
      case 0x56:
        return this.compare("ugt", "i64", false);
      case 0x57:
        return this.compare("sle", "i64", false);
      case 0x58:
        return this.compare("ule", "i64", false);
      case 0x59:
        return this.compare("sge", "i64", false);
      case 0x5a:
        return this.compare("uge", "i64", false);
      case 0x5b:
        return this.compare("oeq", "float", true);
      case 0x5c:
        return this.compare("une", "float", true);
      case 0x5d:
        return this.compare("olt", "float", true);
      case 0x5e:
        return this.compare("ogt", "float", true);
      case 0x5f:
        return this.compare("ole", "float", true);
      case 0x60:
        return this.compare("oge", "float", true);
      case 0x61:
        return this.compare("oeq", "double", true);
      case 0x62:
        return this.compare("une", "double", true);
      case 0x63:
        return this.compare("olt", "double", true);
      case 0x64:
        return this.compare("ogt", "double", true);
      case 0x65:
        return this.compare("ole", "double", true);
      case 0x66:
        return this.compare("oge", "double", true);
      case 0x67:
        return this.unaryIntrinsic("ctlz.i32", "i32", I32, ", i1 false");
      case 0x68:
        return this.unaryIntrinsic("cttz.i32", "i32", I32, ", i1 false");
      case 0x69:
        return this.unaryIntrinsic("ctpop.i32", "i32", I32);
      case 0x6a:
        return this.binary("add", "i32", I32);
      case 0x6b:
        return this.binary("sub", "i32", I32);
      case 0x6c:
        return this.binary("mul", "i32", I32);
      case 0x6d:
      case 0x6e:
      case 0x6f:
      case 0x70:
        return this.divRem(op, "i32");
      case 0x71:
        return this.binary("and", "i32", I32);
      case 0x72:
        return this.binary("or", "i32", I32);
      case 0x73:
        return this.binary("xor", "i32", I32);
      case 0x74:
        return this.shift("shl", "i32", I32);
      case 0x75:
        return this.shift("ashr", "i32", I32);
      case 0x76:
        return this.shift("lshr", "i32", I32);
      case 0x77:
        return this.rotate("fshl", "i32", I32);
      case 0x78:
        return this.rotate("fshr", "i32", I32);
      case 0x79:
        return this.unaryIntrinsic("ctlz.i64", "i64", I64, ", i1 false");
      case 0x7a:
        return this.unaryIntrinsic("cttz.i64", "i64", I64, ", i1 false");
      case 0x7b:
        return this.unaryIntrinsic("ctpop.i64", "i64", I64);
      case 0x7c:
        return this.binary("add", "i64", I64);
      case 0x7d:
        return this.binary("sub", "i64", I64);
      case 0x7e:
        return this.binary("mul", "i64", I64);
      case 0x7f:
      case 0x80:
      case 0x81:
      case 0x82:
        return this.divRem(op, "i64");
      case 0x83:
        return this.binary("and", "i64", I64);
      case 0x84:
        return this.binary("or", "i64", I64);
      case 0x85:
        return this.binary("xor", "i64", I64);
      case 0x86:
        return this.shift("shl", "i64", I64);
      case 0x87:
        return this.shift("ashr", "i64", I64);
      case 0x88:
        return this.shift("lshr", "i64", I64);
      case 0x89:
        return this.rotate("fshl", "i64", I64);
      case 0x8a:
        return this.rotate("fshr", "i64", I64);
      case 0x8b:
        return this.unaryIntrinsic("fabs.f32", "float", F32);
      case 0x8c: {
        const a = this.pop();
        this.push(this.emit(`fneg float ${a.v}`), F32);
        return;
      }
      case 0x8d:
        return this.unaryIntrinsic("ceil.f32", "float", F32);
      case 0x8e:
        return this.unaryIntrinsic("floor.f32", "float", F32);
      case 0x8f:
        return this.unaryIntrinsic("trunc.f32", "float", F32);
      case 0x90:
        return this.unaryIntrinsic("roundeven.f32", "float", F32);
      case 0x91:
        return this.unaryIntrinsic("sqrt.f32", "float", F32);
      case 0x92:
        return this.binary("fadd", "float", F32);
      case 0x93:
        return this.binary("fsub", "float", F32);
      case 0x94:
        return this.binary("fmul", "float", F32);
      case 0x95:
        return this.binary("fdiv", "float", F32);
      case 0x96:
        return this.binaryIntrinsic("minimum.f32", "float", F32);
      case 0x97:
        return this.binaryIntrinsic("maximum.f32", "float", F32);
      case 0x98:
        return this.binaryIntrinsic("copysign.f32", "float", F32);
      case 0x99:
        return this.unaryIntrinsic("fabs.f64", "double", F64);
      case 0x9a: {
        const a = this.pop();
        this.push(this.emit(`fneg double ${a.v}`), F64);
        return;
      }
      case 0x9b:
        return this.unaryIntrinsic("ceil.f64", "double", F64);
      case 0x9c:
        return this.unaryIntrinsic("floor.f64", "double", F64);
      case 0x9d:
        return this.unaryIntrinsic("trunc.f64", "double", F64);
      case 0x9e:
        return this.unaryIntrinsic("roundeven.f64", "double", F64);
      case 0x9f:
        return this.unaryIntrinsic("sqrt.f64", "double", F64);
      case 0xa0:
        return this.binary("fadd", "double", F64);
      case 0xa1:
        return this.binary("fsub", "double", F64);
      case 0xa2:
        return this.binary("fmul", "double", F64);
      case 0xa3:
        return this.binary("fdiv", "double", F64);
      case 0xa4:
        return this.binaryIntrinsic("minimum.f64", "double", F64);
      case 0xa5:
        return this.binaryIntrinsic("maximum.f64", "double", F64);
      case 0xa6:
        return this.binaryIntrinsic("copysign.f64", "double", F64);
      case 0xa7:
        return this.convert("trunc", "i64", "i32", I32);
      case 0xa8:
      case 0xa9:
      case 0xaa:
      case 0xab:
      case 0xae:
      case 0xaf:
      case 0xb0:
      case 0xb1:
        return this.truncTrap(op);
      case 0xac:
        return this.convert("sext", "i32", "i64", I64);
      case 0xad:
        return this.convert("zext", "i32", "i64", I64);
      case 0xb2:
        return this.convert("sitofp", "i32", "float", F32);
      case 0xb3:
        return this.convert("uitofp", "i32", "float", F32);
      case 0xb4:
        return this.convert("sitofp", "i64", "float", F32);
      case 0xb5:
        return this.convert("uitofp", "i64", "float", F32);
      case 0xb6:
        return this.convert("fptrunc", "double", "float", F32);
      case 0xb7:
        return this.convert("sitofp", "i32", "double", F64);
      case 0xb8:
        return this.convert("uitofp", "i32", "double", F64);
      case 0xb9:
        return this.convert("sitofp", "i64", "double", F64);
      case 0xba:
        return this.convert("uitofp", "i64", "double", F64);
      case 0xbb:
        return this.convert("fpext", "float", "double", F64);
      case 0xbc:
        return this.convert("bitcast", "float", "i32", I32);
      case 0xbd:
        return this.convert("bitcast", "double", "i64", I64);
      case 0xbe:
        return this.convert("bitcast", "i32", "float", F32);
      case 0xbf:
        return this.convert("bitcast", "i64", "double", F64);
      case 0xc0:
      case 0xc1: {
        const a = this.pop();
        const n = op === 0xc0 ? "i8" : "i16";
        const narrow = this.emit(`trunc i32 ${a.v} to ${n}`);
        this.push(this.emit(`sext ${n} ${narrow} to i32`), I32);
        return;
      }
      case 0xc2:
      case 0xc3:
      case 0xc4: {
        const a = this.pop();
        const n = op === 0xc2 ? "i8" : op === 0xc3 ? "i16" : "i32";
        const narrow = this.emit(`trunc i64 ${a.v} to ${n}`);
        this.push(this.emit(`sext ${n} ${narrow} to i64`), I64);
        return;
      }
      default:
        throw new WasmTranslateError(`opcode 0x${op.toString(16)} is not supported`);
    }
  }

  prefixed(c: WasmCursor): void {
    const sub = c.u32();
    if (sub <= 7) {
      // Saturating float-to-int conversions.
      const a = this.pop();
      const from = a.t === VAL_F32 ? "f32" : "f64";
      const fromTy = a.t === VAL_F32 ? "float" : "double";
      const to = sub < 4 ? "i32" : "i64";
      const signed = (sub & 1) === 0;
      this.push(
        this.emit(
          `call ${to} @llvm.${signed ? "fptosi" : "fptoui"}.sat.${to}.${from}(${fromTy} ${a.v})`,
        ),
        to === "i32" ? VAL_I32 : VAL_I64,
      );
      return;
    }
    switch (sub) {
      case 8: {
        // memory.init
        const seg = c.u32();
        this.memoryIndex(c);
        const n = this.pop();
        const s = this.pop();
        const d = this.pop();
        this.add(
          `  call void @scr_wasm_memory_init(ptr %inst, i32 ${seg}, i32 ${d.v}, i32 ${s.v}, i32 ${n.v})`,
        );
        return;
      }
      case 9:
        this.add(`  call void @scr_wasm_data_drop(ptr %inst, i32 ${c.u32()})`);
        return;
      case 10: {
        this.memoryIndex(c);
        this.memoryIndex(c);
        const n = this.pop();
        const s = this.pop();
        const d = this.pop();
        this.add(
          `  call void @scr_wasm_memory_copy(ptr %inst, i32 ${d.v}, i32 ${s.v}, i32 ${n.v})`,
        );
        return;
      }
      case 11: {
        this.memoryIndex(c);
        const n = this.pop();
        const v = this.pop();
        const d = this.pop();
        this.add(
          `  call void @scr_wasm_memory_fill(ptr %inst, i32 ${d.v}, i32 ${v.v}, i32 ${n.v})`,
        );
        return;
      }
      case 12: {
        const seg = c.u32();
        const t = c.u32();
        const n = this.pop();
        const s = this.pop();
        const d = this.pop();
        this.add(
          `  call void @scr_wasm_table_init(ptr %inst, i32 ${t}, i32 ${seg}, i32 ${d.v}, i32 ${s.v}, i32 ${n.v})`,
        );
        return;
      }
      case 13:
        this.add(`  call void @scr_wasm_elem_drop(ptr %inst, i32 ${c.u32()})`);
        return;
      case 14: {
        const dt = c.u32();
        const st = c.u32();
        const n = this.pop();
        const s = this.pop();
        const d = this.pop();
        this.add(
          `  call void @scr_wasm_table_copy(ptr %inst, i32 ${dt}, i32 ${st}, i32 ${d.v}, i32 ${s.v}, i32 ${n.v})`,
        );
        return;
      }
      case 15: {
        const t = c.u32();
        const n = this.pop();
        const v = this.pop();
        this.push(
          this.emit(`call i32 @scr_wasm_table_grow(ptr %inst, i32 ${t}, ptr ${v.v}, i32 ${n.v})`),
          VAL_I32,
        );
        return;
      }
      case 16: {
        const t = c.u32();
        const tab = this.loadPtrSlot(this.mt.tableSlot(t));
        const sizePtr = this.emit(`getelementptr inbounds i8, ptr ${tab}, i64 8`);
        this.push(this.emit(`load i32, ptr ${sizePtr}, align 8`), VAL_I32);
        return;
      }
      case 17: {
        const t = c.u32();
        const n = this.pop();
        const v = this.pop();
        const d = this.pop();
        this.add(
          `  call void @scr_wasm_table_fill(ptr %inst, i32 ${t}, i32 ${d.v}, ptr ${v.v}, i32 ${n.v})`,
        );
        return;
      }
      default:
        throw new WasmTranslateError(`opcode 0xfc ${sub} is not supported`);
    }
  }
}

/** The functions through which the stack can grow without bound, which
 * check the stack pointer on entry: members of a cycle of direct calls
 * (including self-recursion), and functions that call through a table or
 * call an import (an indirect call can reach any function, and an import
 * can call back into an export). Every other call chain is finite, so its
 * depth is bounded by the module and the guard's reserve absorbs it. */
export function stackCheckedFunctions(m: WasmModule): Set<number> {
  const n = m.funcTypes.length;
  const callees: number[][] = [];
  const checked = new Set<number>();
  for (let f = 0; f < n; f++) callees.push([]);
  for (let i = 0; i < m.codes.length; i++) {
    const f = m.importedFuncs + i;
    const body = m.codes[i]!.body;
    const c = new WasmCursor(m.bytes, body.start);
    while (c.pos < body.end) {
      const op = c.u8();
      if (op === 0x10) {
        const callee = c.u32();
        if (callee < m.importedFuncs) checked.add(f);
        else callees[f]!.push(callee);
      } else if (op === 0x11) {
        c.u32();
        c.u32();
        checked.add(f);
      } else {
        skipImmediates(c, op);
      }
    }
  }
  // Tarjan's strongly connected components, iteratively.
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let next = 0;
  for (let root = m.importedFuncs; root < n; root++) {
    if (index[root] !== -1) continue;
    const workNode: number[] = [root];
    const workEdge: number[] = [0];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (workNode.length > 0) {
      const top = workNode.length - 1;
      const v = workNode[top]!;
      const edges = callees[v]!;
      const e = workEdge[top]!;
      if (e < edges.length) {
        workEdge[top] = e + 1;
        const w = edges[e]!;
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          workNode.push(w);
          workEdge.push(0);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      workNode.pop();
      workEdge.pop();
      if (workNode.length > 0) {
        const parent = workNode[workNode.length - 1]!;
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const component: number[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = 0;
          component.push(w);
          if (w === v) break;
        }
        if (component.length > 1 || edges.includes(v)) for (const w of component) checked.add(w);
      }
    }
  }
  return checked;
}

/** A decimal double literal as LLVM's exact hexadecimal form. */
function hexDouble(text: string): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Number(text));
  return `0x${hex8(view.getUint32(0))}${hex8(view.getUint32(4))}`.toUpperCase().replace("0X", "0x");
}

function hexOf(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/** The symbol prefix of a module's translation. */
export function wasmSymbolPrefix(sha256: Uint8Array): string {
  return `scr_wasm_${hexOf(sha256).slice(0, 16)}`;
}

/** Translates a module that binary.ts validated within the translatable
 * feature level. Throws WasmTranslateError for constructs outside it. */
export function translateWasmModule(
  bytes: Uint8Array,
  sha256: Uint8Array,
  opts: WasmTranslateOptions,
): WasmTranslation {
  const m = parseWasmModule(bytes);
  for (const t of m.tables) llType(t.elemType);
  const mt = new ModuleTranslator(m, wasmSymbolPrefix(sha256), opts);
  mt.translate();
  const descriptor = mt.descriptor(sha256);
  const decls = RUNTIME_DECLS.slice();
  for (const decl of mt.intrinsics) decls.push(decl);
  if (mt.needsImportFuncref) decls.push("declare ptr @scr_wasm_import_funcref(ptr, i32)");
  // Initial-exec: executables and their static runtime define it, so the
  // check is one thread-pointer-relative load, not a TLS lookup call.
  if (opts.boundsChecks)
    decls.push("@scr_wasm_stack_limit = external thread_local(initialexec) global i64");
  return { decls, text: mt.text, descriptor };
}
