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
 *     results)` over 64-bit scalar slots, which the runtime calls under its trap
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
  hasVectorSignature,
  hasVectorInterfaces,
  readMemargFlags,
  skipImmediates,
  type WasmFuncType,
  type WasmModule,
  type WasmRange,
} from "./module.js";

import { simdIntegerOp, simdFloatOp, type SimdFloatOp, relaxedSimdAlias } from "./simd.js";

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
export const WASM_ABI_VERSION = 3;
const WASM_SCALAR_ABI_VERSION = 2;

/** Instance slot offsets (bytes). */
const OFF_MEMBASE = 8;
const OFF_MEMORY = 16;
const OFF_FUNCREFS = 24;
const OFF_TABLES = 32;
/** sizeof(ScrWasmFuncRef). */
const FUNCREF_SIZE = 24;

export interface WasmTranslateOptions {
  /** Explicit bounds checks instead of guard pages. */
  boundsChecks: boolean;
  /** Keep the custom sections, for WebAssembly.Module.customSections. */
  customSections?: boolean;
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
    case VAL_V128:
      return "<16 x i8>";
    case VAL_I32:
      return "i32";
    case VAL_I64:
      return "i64";
    case VAL_F32:
      return "float";
    case VAL_F64:
      return "double";
    case VAL_FUNCREF:
    case VAL_EXTERNREF:
      return "ptr";
    default:
      throw new WasmTranslateError(`value type 0x${t.toString(16)} is not supported`);
  }
}

function zeroOf(t: number): string {
  switch (t) {
    case VAL_V128:
      return "zeroinitializer";
    case VAL_I32:
    case VAL_I64:
      return "0";
    case VAL_F32:
    case VAL_F64:
      return "0.0";
    default:
      return "null";
  }
}

/** The runtime's signature letter of a value type. */
function sigChar(t: number): string {
  switch (t) {
    case VAL_V128:
      return "v";
    case VAL_I32:
      return "i";
    case VAL_I64:
      return "I";
    case VAL_F32:
      return "f";
    case VAL_F64:
      return "F";
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
  intrinsicDecls = new Set<string>();
  /** Functions that need a reference record. */
  refs: Set<number>;
  /** Functions whose entry checks the stack (stackCheckedFunctions). */
  stackChecked: Set<number>;
  typeHashes: string[];
  memoryCount: number;

  constructor(m: WasmModule, prefix: string, opts: WasmTranslateOptions) {
    this.m = m;
    this.p = prefix;
    this.opts = opts;
    this.refs = new Set(m.declaredRefs);
    this.typeHashes = m.types.map((t) => signatureHash(sigString(t)));
    this.memoryCount = m.memories.length;
    if (m.memories.length > 1) throw new WasmTranslateError("multiple memories are not supported");
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
    if (hasVectorSignature(ft)) {
      // Vectors never cross JavaScript. Resolve a native Wasm import's
      // original reference, preserving its instance through chained imports.
      const out = [
        `define internal ${this.signature(ft, this.fn(index))} nounwind "disable-tail-calls"="true" {`,
        "entry:",
      ];
      out.push("  %host = load ptr, ptr %inst");
      out.push(`  %ref = call ptr @scr_wasm_import_vector_ref(ptr %host, i32 ${index})`);
      out.push("  %code = load ptr, ptr %ref, align 8");
      out.push("  %ip = getelementptr i8, ptr %ref, i64 16");
      out.push("  %callee = load ptr, ptr %ip, align 8");
      const args = ["ptr %callee", ...ft.params.map((t, i) => `${llType(t)} %p${i}`)].join(", ");
      const ret = retType(ft.results);
      if (ft.results.length === 0) {
        out.push(`  call void %code(${args})`, "  ret void");
      } else {
        out.push(`  %result = call ${ret} %code(${args})`, `  ret ${ret} %result`);
      }
      out.push("}");
      this.text.push(out.join("\n"));
      return;
    }
    const out: string[] = [];
    out.push(`define internal ${this.signature(ft, this.fn(index))} nounwind {`);
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

  /** The thunk the runtime calls for exported function `index`. */
  exportThunk(index: number): string {
    const name = `@${this.p}_x${index}`;
    const ft = this.funcType(index);
    if (hasVectorSignature(ft)) return this.vectorJsThunk(name, false);
    const out: string[] = [];
    out.push(`define internal void ${name}(ptr %inst, ptr %a, ptr %r) nounwind {`);
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
    if (hasVectorSignature(ft)) return this.vectorJsThunk(name, true);
    const out: string[] = [];
    out.push(`define internal void ${name}(ptr %code, ptr %inst, ptr %a, ptr %r) nounwind {`);
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

  vectorJsThunk(name: string, indirect: boolean): string {
    this.text.push(
      `define internal void ${name}(${indirect ? "ptr %code, " : ""}ptr %inst, ptr %a, ptr %r) nounwind {\nentry:\n  call void @scr_wasm_vector_js_error()\n  unreachable\n}`,
    );
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
      } else {
        body.add(
          `  store ${llType(global.type)} ${v}, ptr ${cell}${global.type === VAL_V128 ? ", align 8" : ""}`,
        );
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
    const out = [`define internal void ${name}(ptr %inst) nounwind {`, `entry:`];
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
        type = sigString(this.funcType(ex.index));
        let thunk = thunks.get(ex.index);
        if (thunk === undefined) {
          thunk = this.exportThunk(ex.index);
          thunks.set(ex.index, thunk);
        }
        call = thunk;
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
      if (referenced && !thunks.has(f)) {
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
      `i64 ${hasVectorInterfaces(m) ? WASM_ABI_VERSION : WASM_SCALAR_ABI_VERSION}`,
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
  memargOffset(c: WasmCursor): number {
    const flags = readMemargFlags(() => c.u32());
    if (flags.align < 0 || flags.memory !== 0)
      throw new WasmTranslateError(`memarg of memory ${flags.memory} is not supported`);
    return c.u32();
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
  address(addr: string, offset: number, bytes: number, checkStore = false): string {
    const wide = this.emit(`zext i32 ${addr} to i64`);
    const ea = offset === 0 ? wide : this.emit(`add i64 ${wide}, ${offset}`);
    if (this.checked || checkStore) {
      // A vector store may be legalized into several scalar stores. Check
      // the whole range first so a trap cannot leave a partial write.
      const sizePtr = this.checked
        ? this.memSlots!.size
        : this.emit(`getelementptr inbounds i8, ptr ${this.loadPtrSlot(OFF_MEMORY)}, i64 8`);
      const size = this.emit(`load i64, ptr ${sizePtr}`);
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
          stack.push(
            this.emit(
              `load ${llType(this.m.globals[g]!.type)}, ptr ${cell}${this.m.globals[g]!.type === VAL_V128 ? ", align 8" : ""}`,
            ),
          );
          break;
        }
        case 0xfd: {
          if (c.u32() !== 12) throw new WasmTranslateError("invalid SIMD constant expression");
          const lanes: string[] = [];
          for (let i = 0; i < 16; i++) lanes.push(`i8 ${c.u8()}`);
          stack.push(`<${lanes.join(", ")}>`);
          break;
        }
        case 0xd0:
          c.valType();
          stack.push("null");
          break;
        case 0xd2:
          stack.push(this.funcRef(c.u32()));
          break;
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
    out.push(`define internal ${this.mt.signature(ft, this.mt.fn(this.index))} ${FUNC_ATTRS} {`);
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
      case 0xfd:
        this.simd(c);
        return;
      case 0xfc:
        this.prefixed(c);
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

  /** Non-bitwise float operations may produce any permitted arithmetic NaN.
   * Canonicalizing their NaNs also guarantees that signaling inputs quiet. */
  simdFloatMath(op: SimdFloatOp): void {
    const lanes = 128 / op.bits;
    const scalar = op.bits === 32 ? "float" : "double";
    const type = `<${lanes} x ${scalar}>`;
    const integer = `<${lanes} x i${op.bits}>`;
    const mask = `<${lanes} x i1>`;
    const read = (): string =>
      this.emit(`bitcast <16 x i8> ${this.popType(VAL_V128, "SIMD float").v} to ${type}`);
    const push = (value: string, valueType: string): void =>
      this.push(this.emit(`bitcast ${valueType} ${value} to <16 x i8>`), VAL_V128);
    const intConstant = (bits: number, count: number, value: string): string =>
      `<${Array.from({ length: count }, () => `i${bits} ${value}`).join(", ")}>`;
    const canonical = (value: string, bits: number, count: number, nan = ""): string => {
      const valueType = `<${count} x ${bits === 32 ? "float" : "double"}>`;
      const nanMask = nan || this.emit(`fcmp uno ${valueType} ${value}, ${value}`);
      const nanBits = intConstant(bits, count, bits === 32 ? "2143289344" : "u0x7FF8000000000000");
      const quiet = this.emit(`bitcast <${count} x i${bits}> ${nanBits} to ${valueType}`);
      return this.emit(
        `select <${count} x i1> ${nanMask}, ${valueType} ${quiet}, ${valueType} ${value}`,
      );
    };
    const intrinsic = (
      name: string,
      resultType: string,
      inputType: string,
      value: string,
    ): string => {
      this.mt.intrinsicDecls.add(`declare ${resultType} @llvm.${name}(${inputType})`);
      return this.emit(`call ${resultType} @llvm.${name}(${inputType} ${value})`);
    };
    const b = read();
    if (op.kind === "convert") {
      if (op.operation === "demote") {
        const small = this.emit(`fptrunc ${type} ${b} to <2 x float>`);
        const value = canonical(small, 32, 2);
        push(
          this.emit(
            `shufflevector <2 x float> ${value}, <2 x float> zeroinitializer, <4 x i32> <i32 0, i32 1, i32 2, i32 3>`,
          ),
          "<4 x float>",
        );
      } else if (op.operation === "promote") {
        const small = this.emit(
          `shufflevector ${type} ${b}, ${type} poison, <2 x i32> <i32 0, i32 1>`,
        );
        const value = this.emit(`fpext <2 x float> ${small} to <2 x double>`);
        push(canonical(value, 64, 2), "<2 x double>");
      } else if (op.operation.startsWith("trunc")) {
        const resultType = `<${lanes} x i32>`;
        const signed = op.operation.endsWith("s");
        let value = intrinsic(
          `fpto${signed ? "si" : "ui"}.sat.v${lanes}i32.v${lanes}f${op.bits}`,
          resultType,
          type,
          b,
        );
        if (op.bits === 64)
          value = this.emit(
            `shufflevector <2 x i32> ${value}, <2 x i32> zeroinitializer, <4 x i32> <i32 0, i32 1, i32 2, i32 3>`,
          );
        push(value, "<4 x i32>");
      } else {
        let value = this.emit(`bitcast ${type} ${b} to <4 x i32>`);
        const sourceType = `<${lanes} x i32>`;
        if (op.bits === 64)
          value = this.emit(
            `shufflevector <4 x i32> ${value}, <4 x i32> poison, <2 x i32> <i32 0, i32 1>`,
          );
        push(
          this.emit(
            `${op.operation.endsWith("s") ? "sitofp" : "uitofp"} ${sourceType} ${value} to ${type}`,
          ),
          type,
        );
      }
      return;
    }
    if (op.kind === "unary") {
      let value: string;
      if (op.operation === "nearest") {
        const source = this.emit(`bitcast ${type} ${b} to ${integer}`);
        const sign = intConstant(
          op.bits,
          lanes,
          op.bits === 32 ? "2147483648" : "u0x8000000000000000",
        );
        const magnitude = intConstant(
          op.bits,
          lanes,
          op.bits === 32 ? "2147483647" : "u0x7FFFFFFFFFFFFFFF",
        );
        const absoluteBits = this.emit(`and ${integer} ${source}, ${magnitude}`);
        const absolute = this.emit(`bitcast ${integer} ${absoluteBits} to ${type}`);
        const magicBits = intConstant(
          op.bits,
          lanes,
          op.bits === 32 ? "1258291200" : "u0x4330000000000000",
        );
        const magic = this.emit(`bitcast ${integer} ${magicBits} to ${type}`);
        const sum = this.emit(`fadd ${type} ${absolute}, ${magic}`);
        const rounded = this.emit(`fsub ${type} ${sum}, ${magic}`);
        const large = this.emit(`fcmp oge ${type} ${absolute}, ${magic}`);
        const chosen = this.emit(
          `select ${mask} ${large}, ${type} ${absolute}, ${type} ${rounded}`,
        );
        const roundedBits = this.emit(`bitcast ${type} ${chosen} to ${integer}`);
        const signBits = this.emit(`and ${integer} ${source}, ${sign}`);
        const result = this.emit(`or ${integer} ${roundedBits}, ${signBits}`);
        value = this.emit(`bitcast ${integer} ${result} to ${type}`);
      } else value = intrinsic(`${op.operation}.v${lanes}f${op.bits}`, type, type, b);
      push(canonical(value, op.bits, lanes), type);
      return;
    }
    const a = read();
    if (op.operation === "min" || op.operation === "max") {
      const less = this.emit(`fcmp ${op.operation === "min" ? "olt" : "ogt"} ${type} ${a}, ${b}`);
      const chosen = this.emit(`select ${mask} ${less}, ${type} ${a}, ${type} ${b}`);
      const equal = this.emit(`fcmp oeq ${type} ${a}, ${b}`);
      const aBits = this.emit(`bitcast ${type} ${a} to ${integer}`);
      const bBits = this.emit(`bitcast ${type} ${b} to ${integer}`);
      // Equal finite values have identical bits except for signed zero.
      const tieBits = this.emit(
        `${op.operation === "min" ? "or" : "and"} ${integer} ${aBits}, ${bBits}`,
      );
      const tie = this.emit(`bitcast ${integer} ${tieBits} to ${type}`);
      const value = this.emit(`select ${mask} ${equal}, ${type} ${tie}, ${type} ${chosen}`);
      const nan = this.emit(`fcmp uno ${type} ${a}, ${b}`);
      push(canonical(value, op.bits, lanes, nan), type);
    } else {
      const value = this.emit(`f${op.operation} ${type} ${a}, ${b}`);
      push(canonical(value, op.bits, lanes), type);
    }
  }

  /** Float predicates and operand-selection instructions preserve NaN bits. */
  simdFloat(op: SimdFloatOp): void {
    if (
      op.kind === "convert" ||
      (op.kind === "unary" && op.operation !== "abs" && op.operation !== "neg") ||
      (op.kind === "binary" && op.operation !== "pmin" && op.operation !== "pmax")
    ) {
      this.simdFloatMath(op);
      return;
    }
    const lanes = 128 / op.bits;
    const type = `<${lanes} x ${op.bits === 32 ? "float" : "double"}>`;
    const integer = `<${lanes} x i${op.bits}>`;
    const mask = `<${lanes} x i1>`;
    const read = (): string =>
      this.emit(`bitcast <16 x i8> ${this.popType(VAL_V128, "SIMD float").v} to ${type}`);
    const push = (value: string, valueType: string): void =>
      this.push(this.emit(`bitcast ${valueType} ${value} to <16 x i8>`), VAL_V128);
    const b = read();
    if (op.kind === "compare") {
      const a = read();
      const result = this.emit(`fcmp ${op.operation} ${type} ${a}, ${b}`);
      push(this.emit(`sext ${mask} ${result} to ${integer}`), integer);
    } else if (op.kind === "unary") {
      const bits = this.emit(`bitcast ${type} ${b} to ${integer}`);
      const value =
        op.operation === "abs"
          ? op.bits === 32
            ? "2147483647"
            : "u0x7FFFFFFFFFFFFFFF"
          : op.bits === 32
            ? "2147483648"
            : "u0x8000000000000000";
      const constant = `<${Array.from({ length: lanes }, () => `i${op.bits} ${value}`).join(", ")}>`;
      push(
        this.emit(`${op.operation === "abs" ? "and" : "xor"} ${integer} ${bits}, ${constant}`),
        integer,
      );
    } else {
      const a = read();
      // Pseudo-min/max select an input exactly, including its NaN payload
      // and zero sign. An unordered comparison selects the left operand.
      const condition = this.emit(
        `fcmp olt ${type} ${op.operation === "pmin" ? b : a}, ${op.operation === "pmin" ? a : b}`,
      );
      push(this.emit(`select ${mask} ${condition}, ${type} ${b}, ${type} ${a}`), type);
    }
  }

  /** Deterministic legal projections of relaxed SIMD. In particular madd
   * uses two roundings, and dot products interpret both inputs as signed. */
  simdRelaxed(sub: number): void {
    const vt = "<16 x i8>";
    const pop = (): string => this.popType(VAL_V128, "relaxed SIMD").v;
    const push = (v: string, t: string): void =>
      this.push(this.emit(`bitcast ${t} ${v} to ${vt}`), VAL_V128);
    if (sub >= 0x105 && sub <= 0x108) {
      const bits = sub <= 0x106 ? 32 : 64;
      const lanes = 128 / bits;
      const t = `<${lanes} x ${bits === 32 ? "float" : "double"}>`;
      const read = (): string => this.emit(`bitcast ${vt} ${pop()} to ${t}`);
      const c = read(),
        b = read(),
        a = read();
      let product = this.emit(`fmul ${t} ${a}, ${b}`);
      if (sub === 0x106 || sub === 0x108) product = this.emit(`fneg ${t} ${product}`);
      const sum = this.emit(`fadd ${t} ${product}, ${c}`);
      const nan = this.emit(`fcmp uno ${t} ${sum}, ${sum}`);
      const canonical = `<${Array.from({ length: lanes }, () => `${bits === 32 ? "float" : "double"} 0x7FF8000000000000`).join(", ")}>`;
      push(this.emit(`select <${lanes} x i1> ${nan}, ${t} ${canonical}, ${t} ${sum}`), t);
      return;
    }
    const acc = sub === 0x113 ? this.emit(`bitcast ${vt} ${pop()} to <4 x i32>`) : "";
    const b = pop(),
      a = pop();
    const aw = this.emit(`sext ${vt} ${a} to <16 x i16>`);
    const bw = this.emit(`sext ${vt} ${b} to <16 x i16>`);
    const product = this.emit(`mul <16 x i16> ${aw}, ${bw}`);
    const half = (start: number): string =>
      this.emit(
        `shufflevector <16 x i16> ${product}, <16 x i16> poison, <8 x i32> <${Array.from({ length: 8 }, (_, i) => `i32 ${2 * i + start}`).join(", ")}>`,
      );
    const pairs = this.emit(`add <8 x i16> ${half(0)}, ${half(1)}`);
    if (sub === 0x112) {
      push(pairs, "<8 x i16>");
      return;
    }
    const wide = this.emit(`sext <8 x i16> ${pairs} to <8 x i32>`);
    const groups = (start: number): string =>
      this.emit(
        `shufflevector <8 x i32> ${wide}, <8 x i32> poison, <4 x i32> <${Array.from({ length: 4 }, (_, i) => `i32 ${2 * i + start}`).join(", ")}>`,
      );
    const sum = this.emit(`add <4 x i32> ${groups(0)}, ${groups(1)}`);
    push(this.emit(`add <4 x i32> ${sum}, ${acc}`), "<4 x i32>");
  }

  /** SIMD uses LLVM vectors with no host ISA requirement. LLVM legalizes the
   * operations for the selected target; lane order is WebAssembly byte order. */
  simd(c: WasmCursor): void {
    const sub = relaxedSimdAlias(c.u32());
    if (sub >= 0x100 && sub <= 0x113) {
      this.simdRelaxed(sub);
      return;
    }
    const floating = simdFloatOp(sub);
    if (floating !== null) {
      this.simdFloat(floating);
      return;
    }
    const vt = "<16 x i8>";
    const vector = (v: string, type: string): string =>
      type === vt ? v : this.emit(`bitcast ${vt} ${v} to ${type}`);
    const push = (v: string, type: string): void =>
      this.push(type === vt ? v : this.emit(`bitcast ${type} ${v} to ${vt}`), VAL_V128);
    const pop = (): string => this.popType(VAL_V128, "SIMD").v;
    const splat = (v: string, scalar: string, lanes: number): string => {
      const type = `<${lanes} x ${scalar}>`;
      const first = this.emit(`insertelement ${type} poison, ${scalar} ${v}, i32 0`);
      return this.emit(
        `shufflevector ${type} ${first}, ${type} poison, <${lanes} x i32> zeroinitializer`,
      );
    };
    const integer = simdIntegerOp(sub);
    if (integer !== null) {
      const lanes = 128 / integer.bits;
      const type = `<${lanes} x i${integer.bits}>`;
      const maskType = `<${lanes} x i1>`;
      const count = integer.kind === "shift" ? this.popType(VAL_I32, "SIMD shift count").v : "";
      const widening =
        integer.kind === "extend" ||
        integer.kind === "extmul" ||
        integer.kind === "pairwise" ||
        integer.kind === "dot";
      const inputType =
        integer.kind === "narrow"
          ? `<${lanes / 2} x i${2 * integer.bits}>`
          : widening
            ? `<${2 * lanes} x i${integer.bits / 2}>`
            : type;
      const b = vector(pop(), inputType);
      if (widening) {
        const halfType = `<${lanes} x i${integer.bits / 2}>`;
        const signed = integer.operation.endsWith("s");
        const widen = (value: string, start: number, stride: number): string => {
          const indices: string[] = [];
          for (let i = 0; i < lanes; i++) indices.push(`i32 ${start + i * stride}`);
          const half = this.emit(
            `shufflevector ${inputType} ${value}, ${inputType} poison, <${lanes} x i32> <${indices.join(", ")}>`,
          );
          return this.emit(`${signed ? "sext" : "zext"} ${halfType} ${half} to ${type}`);
        };
        if (integer.kind === "pairwise") {
          const even = widen(b, 0, 2),
            odd = widen(b, 1, 2);
          push(this.emit(`add ${type} ${even}, ${odd}`), type);
        } else if (integer.kind === "dot") {
          const a = vector(pop(), inputType);
          const even = this.emit(`mul ${type} ${widen(a, 0, 2)}, ${widen(b, 0, 2)}`);
          const odd = this.emit(`mul ${type} ${widen(a, 1, 2)}, ${widen(b, 1, 2)}`);
          // The pair sum wraps, including (-32768 * -32768) twice.
          push(this.emit(`add ${type} ${even}, ${odd}`), type);
        } else {
          const start = integer.operation.startsWith("high") ? lanes : 0;
          const right = widen(b, start, 1);
          if (integer.kind === "extend") push(right, type);
          else {
            const left = widen(vector(pop(), inputType), start, 1);
            push(this.emit(`mul ${type} ${left}, ${right}`), type);
          }
        }
      } else if (integer.kind === "popcnt") {
        const constant = (value: number): string =>
          `<${Array.from({ length: lanes }, () => `i8 ${value}`).join(", ")}>`;
        const shifted = this.emit(`lshr ${type} ${b}, ${constant(1)}`);
        const pairs = this.emit(`and ${type} ${shifted}, ${constant(0x55)}`);
        const x = this.emit(`sub ${type} ${b}, ${pairs}`);
        const low = this.emit(`and ${type} ${x}, ${constant(0x33)}`);
        const high = this.emit(`lshr ${type} ${x}, ${constant(2)}`);
        const highBits = this.emit(`and ${type} ${high}, ${constant(0x33)}`);
        const nibbles = this.emit(`add ${type} ${low}, ${highBits}`);
        const upper = this.emit(`lshr ${type} ${nibbles}, ${constant(4)}`);
        const sum = this.emit(`add ${type} ${nibbles}, ${upper}`);
        push(this.emit(`and ${type} ${sum}, ${constant(15)}`), type);
      } else if (
        integer.kind === "saturating" ||
        integer.kind === "average" ||
        integer.kind === "narrow"
      ) {
        const a = vector(pop(), inputType);
        const wideBits = 2 * integer.bits;
        const wideLanes = integer.kind === "narrow" ? lanes / 2 : lanes;
        const wideType = `<${wideLanes} x i${wideBits}>`;
        const boolType = `<${wideLanes} x i1>`;
        const constant = (value: number): string =>
          value === 0
            ? "zeroinitializer"
            : `<${Array.from({ length: wideLanes }, () => `i${wideBits} ${value}`).join(", ")}>`;
        const signed =
          integer.operation.endsWith("s") ||
          integer.operation === "s" ||
          integer.operation === "q15";
        const minimum = signed ? -Math.pow(2, integer.bits - 1) : 0;
        const maximum = signed ? Math.pow(2, integer.bits - 1) - 1 : Math.pow(2, integer.bits) - 1;
        const clamp = (value: string): string => {
          const below = this.emit(`icmp slt ${wideType} ${value}, ${constant(minimum)}`);
          const lower = this.emit(
            `select ${boolType} ${below}, ${wideType} ${constant(minimum)}, ${wideType} ${value}`,
          );
          const above = this.emit(`icmp sgt ${wideType} ${lower}, ${constant(maximum)}`);
          return this.emit(
            `select ${boolType} ${above}, ${wideType} ${constant(maximum)}, ${wideType} ${lower}`,
          );
        };
        if (integer.kind === "narrow") {
          // Both narrow_s and narrow_u interpret the wide source as signed.
          // The suffix selects the destination's saturation interval only.
          const halfType = `<${wideLanes} x i${integer.bits}>`;
          const left = this.emit(`trunc ${wideType} ${clamp(a)} to ${halfType}`);
          const right = this.emit(`trunc ${wideType} ${clamp(b)} to ${halfType}`);
          const indices = Array.from({ length: lanes }, (_, i) => `i32 ${i}`).join(", ");
          push(
            this.emit(
              `shufflevector ${halfType} ${left}, ${halfType} ${right}, <${lanes} x i32> <${indices}>`,
            ),
            type,
          );
        } else {
          const left = this.emit(`${signed ? "sext" : "zext"} ${type} ${a} to ${wideType}`);
          const right = this.emit(`${signed ? "sext" : "zext"} ${type} ${b} to ${wideType}`);
          let result: string;
          if (integer.operation === "q15") {
            const product = this.emit(`mul ${wideType} ${left}, ${right}`);
            const rounded = this.emit(`add ${wideType} ${product}, ${constant(0x4000)}`);
            result = clamp(this.emit(`ashr ${wideType} ${rounded}, ${constant(15)}`));
          } else {
            result = this.emit(
              `${integer.operation.startsWith("sub") ? "sub" : "add"} ${wideType} ${left}, ${right}`,
            );
            if (integer.kind === "average") {
              const rounded = this.emit(`add ${wideType} ${result}, ${constant(1)}`);
              result = this.emit(`lshr ${wideType} ${rounded}, ${constant(1)}`);
            } else result = clamp(result);
          }
          push(this.emit(`trunc ${wideType} ${result} to ${type}`), type);
        }
      } else if (integer.kind === "compare") {
        const a = vector(pop(), type);
        const mask = this.emit(`icmp ${integer.operation} ${type} ${a}, ${b}`);
        // WebAssembly comparisons return all bits set in each true lane.
        push(this.emit(`sext ${maskType} ${mask} to ${type}`), type);
      } else if (integer.kind === "shift") {
        // WebAssembly masks counts modulo lane width. LLVM does not: an
        // oversized count would produce poison, even on masking CPUs.
        let masked = this.emit(`and i32 ${count}, ${integer.bits - 1}`);
        if (integer.bits < 32) masked = this.emit(`trunc i32 ${masked} to i${integer.bits}`);
        if (integer.bits > 32) masked = this.emit(`zext i32 ${masked} to i${integer.bits}`);
        const counts = splat(masked, `i${integer.bits}`, lanes);
        push(this.emit(`${integer.operation} ${type} ${b}, ${counts}`), type);
      } else if (integer.kind === "unary") {
        const negated = this.emit(`sub ${type} zeroinitializer, ${b}`);
        if (integer.operation === "neg") push(negated, type);
        else {
          const negative = this.emit(`icmp slt ${type} ${b}, zeroinitializer`);
          push(this.emit(`select ${maskType} ${negative}, ${type} ${negated}, ${type} ${b}`), type);
        }
      } else if (integer.kind === "binary") {
        const a = vector(pop(), type);
        if (integer.operation.startsWith("min") || integer.operation.startsWith("max")) {
          const condition = `${integer.operation.endsWith("_s") ? "s" : "u"}${integer.operation.startsWith("min") ? "lt" : "gt"}`;
          const pick = this.emit(`icmp ${condition} ${type} ${a}, ${b}`);
          push(this.emit(`select ${maskType} ${pick}, ${type} ${a}, ${type} ${b}`), type);
        } else {
          // No nsw/nuw flags: these operations wrap at the lane width.
          push(this.emit(`${integer.operation} ${type} ${a}, ${b}`), type);
        }
      } else {
        const mask = this.emit(
          `icmp ${integer.kind === "all-true" ? "ne" : "slt"} ${type} ${b}, zeroinitializer`,
        );
        // All supported targets are little-endian: lane zero is bit zero.
        const packed = this.emit(`bitcast ${maskType} ${mask} to i${lanes}`);
        const result =
          integer.kind === "all-true" ? this.emit(`icmp eq i${lanes} ${packed}, -1`) : packed;
        this.push(
          this.emit(`zext i${integer.kind === "all-true" ? 1 : lanes} ${result} to i32`),
          VAL_I32,
        );
      }
      return;
    }
    if (sub <= 11 || (sub >= 84 && sub <= 93)) {
      const offset = this.memargOffset(c);
      const laneOp = sub >= 84 && sub <= 91;
      const store = sub === 11 || (sub >= 88 && sub <= 91);
      const input = store || laneOp ? pop() : "";
      const addr = this.popType(VAL_I32, "SIMD memory address").v;
      const lane = laneOp ? c.u8() : 0;
      const bytes =
        sub === 0 || sub === 11
          ? 16
          : sub <= 6
            ? 8
            : sub <= 10
              ? 1 << (sub - 7)
              : laneOp
                ? 1 << ((sub - 84) % 4)
                : sub === 92
                  ? 4
                  : 8;
      const ptr = this.address(addr, offset, bytes, store);
      if (sub === 11) {
        this.add(`  store volatile ${vt} ${input}, ptr ${ptr}, align 1`);
        return;
      }
      if (laneOp) {
        const scalar = `i${bytes * 8}`;
        const type = `<${16 / bytes} x ${scalar}>`;
        const v = vector(input, type);
        if (store) {
          const element = this.emit(`extractelement ${type} ${v}, i32 ${lane}`);
          this.add(`  store volatile ${scalar} ${element}, ptr ${ptr}, align 1`);
        } else {
          const loaded = this.emit(`load volatile ${scalar}, ptr ${ptr}, align 1`);
          push(this.emit(`insertelement ${type} ${v}, ${scalar} ${loaded}, i32 ${lane}`), type);
        }
        return;
      }
      if (sub === 0) {
        this.push(this.emit(`load volatile ${vt}, ptr ${ptr}, align 1`), VAL_V128);
        return;
      }
      if (sub <= 6) {
        const bits = 8 << Math.floor((sub - 1) / 2);
        const lanes = 64 / bits;
        const from = `<${lanes} x i${bits}>`;
        const to = `<${lanes} x i${bits * 2}>`;
        const loaded = this.emit(`load volatile ${from}, ptr ${ptr}, align 1`);
        push(this.emit(`${sub % 2 === 1 ? "sext" : "zext"} ${from} ${loaded} to ${to}`), to);
      } else {
        const scalar = `i${bytes * 8}`;
        const loaded = this.emit(`load volatile ${scalar}, ptr ${ptr}, align 1`);
        const type = `<${16 / bytes} x ${scalar}>`;
        push(
          sub <= 10
            ? splat(loaded, scalar, 16 / bytes)
            : this.emit(`insertelement ${type} zeroinitializer, ${scalar} ${loaded}, i32 0`),
          type,
        );
      }
      return;
    }
    if (sub === 12) {
      const lanes: string[] = [];
      for (let i = 0; i < 16; i++) lanes.push(`i8 ${c.u8()}`);
      this.push(`<${lanes.join(", ")}>`, VAL_V128);
      return;
    }
    if (sub === 13) {
      const b = pop(),
        a = pop();
      const lanes: string[] = [];
      for (let i = 0; i < 16; i++) lanes.push(`i32 ${c.u8()}`);
      this.push(
        this.emit(`shufflevector ${vt} ${a}, ${vt} ${b}, <16 x i32> <${lanes.join(", ")}>`),
        VAL_V128,
      );
      return;
    }
    if (sub === 14) {
      const indices = pop(),
        input = pop();
      let result = "poison";
      for (let i = 0; i < 16; i++) {
        const index = this.emit(`extractelement ${vt} ${indices}, i32 ${i}`);
        const valid = this.emit(`icmp ult i8 ${index}, 16`);
        // An out-of-range LLVM extract is poison even if its result is unused.
        const safe = this.emit(`and i8 ${index}, 15`);
        const element = this.emit(`extractelement ${vt} ${input}, i8 ${safe}`);
        const value = this.emit(`select i1 ${valid}, i8 ${element}, i8 0`);
        result = this.emit(`insertelement ${vt} ${result}, i8 ${value}, i32 ${i}`);
      }
      this.push(result, VAL_V128);
      return;
    }
    if (sub >= 15 && sub <= 34) {
      const group =
        sub <= 20
          ? sub - 15
          : sub <= 23
            ? 0
            : sub <= 26
              ? 1
              : sub <= 28
                ? 2
                : sub <= 30
                  ? 3
                  : sub <= 32
                    ? 4
                    : 5;
      const scalar =
        group === 0
          ? "i8"
          : group === 1
            ? "i16"
            : group === 2
              ? "i32"
              : group === 3
                ? "i64"
                : group === 4
                  ? "float"
                  : "double";
      const lanes = group === 0 ? 16 : group === 1 ? 8 : group === 2 || group === 4 ? 4 : 2;
      const t = group <= 2 ? VAL_I32 : group === 3 ? VAL_I64 : group === 4 ? VAL_F32 : VAL_F64;
      const type = `<${lanes} x ${scalar}>`;
      const replace =
        sub === 23 || sub === 26 || sub === 28 || sub === 30 || sub === 32 || sub === 34;
      if (sub <= 20 || replace) {
        let value = this.popType(t, "SIMD scalar").v;
        if (group <= 1) value = this.emit(`trunc i32 ${value} to ${scalar}`);
        if (sub <= 20) push(splat(value, scalar, lanes), type);
        else {
          const lane = c.u8();
          const input = vector(pop(), type);
          push(this.emit(`insertelement ${type} ${input}, ${scalar} ${value}, i32 ${lane}`), type);
        }
      } else {
        const lane = c.u8();
        const input = vector(pop(), type);
        let value = this.emit(`extractelement ${type} ${input}, i32 ${lane}`);
        if (group <= 1)
          value = this.emit(
            `${sub === 21 || sub === 24 ? "sext" : "zext"} ${scalar} ${value} to i32`,
          );
        this.push(value, t);
      }
      return;
    }
    if (sub >= 77 && sub <= 83) {
      const all = "<" + Array.from({ length: 16 }, () => "i8 -1").join(", ") + ">";
      const b = pop();
      if (sub === 77) {
        this.push(this.emit(`xor ${vt} ${b}, ${all}`), VAL_V128);
        return;
      }
      if (sub === 83) {
        const wide = this.emit(`bitcast ${vt} ${b} to i128`);
        const nonzero = this.emit(`icmp ne i128 ${wide}, 0`);
        this.push(this.emit(`zext i1 ${nonzero} to i32`), VAL_I32);
        return;
      }
      const a = pop();
      if (sub === 82) {
        const first = pop();
        const yes = this.emit(`and ${vt} ${first}, ${b}`);
        const inv = this.emit(`xor ${vt} ${b}, ${all}`);
        const no = this.emit(`and ${vt} ${a}, ${inv}`);
        this.push(this.emit(`or ${vt} ${yes}, ${no}`), VAL_V128);
      } else {
        const right = sub === 79 ? this.emit(`xor ${vt} ${b}, ${all}`) : b;
        this.push(
          this.emit(`${sub <= 79 ? "and" : sub === 80 ? "or" : "xor"} ${vt} ${a}, ${right}`),
          VAL_V128,
        );
      }
      return;
    }
    throw new WasmTranslateError(`opcode 0xfd ${sub} is not supported`);
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
  const decls = [...RUNTIME_DECLS, ...mt.intrinsicDecls];
  if (m.funcTypes.some((type) => hasVectorSignature(m.types[type]!))) {
    decls.push("declare ptr @scr_wasm_import_vector_ref(ptr, i32)");
    decls.push("declare void @scr_wasm_vector_js_error()");
  }
  // Initial-exec: executables and their static runtime define it, so the
  // check is one thread-pointer-relative load, not a TLS lookup call.
  if (opts.boundsChecks)
    decls.push("@scr_wasm_stack_limit = external thread_local(initialexec) global i64");
  return { decls, text: mt.text, descriptor };
}
