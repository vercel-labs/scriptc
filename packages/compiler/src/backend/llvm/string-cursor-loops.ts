/* A string local that only ever steps over its own value, one slice at a
 * time: `rest = rest.slice(k + 1)` in a loop. Every slice copies the
 * remainder, so a scan written that way costs the square of the text's
 * length. The emitter keeps the string the local entered the loop with and
 * how many of its UTF-16 units the loop has consumed, and answers length,
 * indexOf, charAt/charCodeAt and slice through that pair: a step is the
 * arithmetic of its bound instead of a copy of the rest.
 *
 * The rewrite means the same string the source does for every input, not
 * only ASCII ones: the offset counts UTF-16 units, negative and fractional
 * bounds go through the same normalization as the ordinary slice, and
 * every read calls the runtime helper the ordinary form calls, on the base
 * string at the offset. The base never changes, so its length is read once
 * where the loop starts.
 *
 * A loop is versioned only when every read of the local is inside it,
 * through one of the forms below, and every write inside it is a suffix of
 * the local itself. The slot keeps the string it entered with, so a read
 * after the loop would see that string instead of the suffix the source
 * leaves: such a local keeps the ordinary representation. The same goes for
 * every read the emitter cannot express at an offset (a call argument, a
 * comparison, a captured binding). Only while and do-while loops are
 * versioned — the forms the idiom takes — and a local declared inside its
 * loop (a fresh binding per iteration) is left alone.
 */

import { type IrExpr, type IrFunction, type IrLocal, type IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { InternalCompilerError } from "../../errors.js";
import { F64_INF, f64Lit } from "./common.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitStringInputs } from "./string-lifetimes.js";
import {
  STRING_CHAR_AT_DECL,
  STRING_CHAR_CODE_AT_DECL,
  STRING_UTF16_LEN_DECL,
} from "./string-reads.js";
import { emitSliceUnit } from "./string-slices.js";

type AnyLoop = Extract<IrStmt, { kind: "while" | "doWhile" | "for" | "forOf" }>;
/** The loops a cursor is versioned on. */
type CursorLoop = Extract<IrStmt, { kind: "while" | "doWhile" }>;

/** One loop, and the string local whose value it walks. */
export interface StringCursorLoop {
  loop: CursorLoop;
  localId: string;
}

/** A suffix step `rest = rest.slice(bound)` (or `substring`). */
export interface StringCursorAdvance {
  bound: IrExpr;
  substring: boolean;
}

/** The state of one versioned loop: the string it entered with, its unit
 * length, and the alloca holding the units consumed so far. */
export interface StringCursor {
  slot: string;
  base: string;
  /** Loop-invariant UTF-16 length of `base`, as a size integer. */
  length: string;
  /** alloca of the size type: the consumed units. */
  offset: string;
}

/** `rest.slice(start)` — one argument, and the omitted end is the whole
 * remainder, so the result is the suffix that starts at `start`. */
export function matchCursorAdvance(value: IrExpr, localId: string): StringCursorAdvance | null {
  if (value.kind !== "strIntrinsic") return null;
  if (value.method !== "slice" && value.method !== "substring") return null;
  if (value.receiver.kind !== "varRef" || value.receiver.localId !== localId) return null;
  if (value.args.length !== 1 && value.args.length !== 2) return null;
  if (value.args.length === 2 && !isEndless(value.args[1]!)) return null;
  return { bound: value.args[0]!, substring: value.method === "substring" };
}

/** The end bound the frontend writes for an omitted slice end: `1 / 0`. */
function isEndless(value: IrExpr): boolean {
  if (value.kind === "numLit") return value.value === Infinity;
  return (
    value.kind === "bin" &&
    value.op === "/" &&
    value.left.kind === "numLit" &&
    value.left.value === 1 &&
    value.right.kind === "numLit" &&
    value.right.value === 0
  );
}

/** The reads of a cursor local the emitter answers at an offset. Every
 * other form reads the local's own value. */
export function cursorRead(value: IrExpr & { kind: "strIntrinsic" }): boolean {
  const numbers = (args: readonly IrExpr[]): boolean =>
    args.every((arg) => arg.type.kind === "f64");
  switch (value.method) {
    case "length":
      return value.args.length === 0;
    case "indexOf":
      return (
        (value.args.length === 1 || value.args.length === 2) &&
        value.args[0]!.type.kind === "string" &&
        numbers(value.args.slice(1))
      );
    case "charCodeAt":
    case "charAt":
      return value.args.length === 1 && numbers(value.args);
    case "slice":
    case "substring":
      return value.args.length <= 2 && numbers(value.args);
    default:
      return false;
  }
}

interface Read {
  ok: boolean;
  chain: readonly AnyLoop[];
}

interface Write {
  ok: boolean;
  chain: readonly AnyLoop[];
}

interface Declaration {
  chain: readonly AnyLoop[];
}

/** The versioned loops of `fn`, keyed by statement. `facts` decides which
 * locals keep the ordinary representation: a captured, boxed or
 * value-captured binding has a home the loop does not reach. */
export function findStringCursorLoops(
  fn: IrFunction,
  facts: {
    plain: (id: string) => boolean;
    captured: ReadonlySet<string>;
    /** Parameters, which are initialized before the body runs. */
    parameters: ReadonlySet<string>;
  },
): Map<IrStmt, StringCursorLoop> {
  const loops = new Map<IrStmt, StringCursorLoop>();
  if (fn.async || fn.generator) return loops;
  const candidates = new Map<string, IrLocal>();
  for (const local of fn.locals)
    if (
      local.type.kind === "string" &&
      local.mutable &&
      !local.boxed &&
      !local.tdz &&
      facts.plain(local.id)
    )
      candidates.set(local.id, local);
  for (const id of facts.captured) candidates.delete(id);
  if (candidates.size === 0) return loops;

  const reads = new Map<string, Read[]>();
  const writes = new Map<string, Write[]>();
  const declarations = new Map<string, Declaration[]>();
  const record = <T>(map: Map<string, T[]>, id: string, event: T): void => {
    const list = map.get(id);
    if (list === undefined) map.set(id, [event]);
    else list.push(event);
  };
  const chain: AnyLoop[] = [];
  const expr = (value: IrExpr): boolean => {
    if (value.kind === "strIntrinsic" && value.receiver.kind === "varRef") {
      const id = value.receiver.localId;
      if (candidates.has(id)) {
        record(reads, id, { ok: cursorRead(value), chain: [...chain] });
        // The receiver is the pair's base, not a read of the local; its
        // arguments are ordinary reads.
        return value.args.every(expr);
      }
    }
    if (value.kind === "varRef" && candidates.has(value.localId)) {
      record(reads, value.localId, { ok: false, chain: [...chain] });
      return true;
    }
    if ((value.kind === "assignExpr" || value.kind === "incDec") && candidates.has(value.localId)) {
      record(writes, value.localId, { ok: false, chain: [...chain] });
    }
    return everyExprChild(value, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => {
    switch (node.kind) {
      case "assign": {
        const id = node.localId;
        if (candidates.has(id)) {
          const advance = matchCursorAdvance(node.value, id);
          record(writes, id, { ok: advance !== null, chain: [...chain] });
          if (advance !== null) return expr(advance.bound);
        }
        break;
      }
      case "varDecl":
        if (candidates.has(node.localId)) record(declarations, node.localId, { chain: [...chain] });
        break;
      case "forOf":
        if (candidates.has(node.localId))
          record(writes, node.localId, { ok: false, chain: [...chain] });
        break;
    }
    if (
      node.kind === "while" ||
      node.kind === "doWhile" ||
      node.kind === "for" ||
      node.kind === "forOf"
    ) {
      chain.push(node);
      try {
        return everyStmtChild(node, expr, stmt);
      } finally {
        chain.pop();
      }
    }
    return everyStmtChild(node, expr, stmt);
  };
  for (const node of fn.body) stmt(node);

  for (const id of candidates.keys()) {
    const localReads = reads.get(id);
    if (localReads === undefined || localReads.length === 0) continue;
    // The innermost loop holding every read: the only one whose entry the
    // loop's first read can rely on.
    const loop = localReads[0]!.chain.findLast((outer) =>
      localReads.every((read) => read.chain.includes(outer)),
    );
    if (loop === undefined || (loop.kind !== "while" && loop.kind !== "doWhile")) continue;
    if (localReads.some((read) => !read.ok)) continue;
    const inside = (event: { chain: readonly AnyLoop[] }): boolean => event.chain.includes(loop);
    const localWrites = writes.get(id) ?? [];
    if (localWrites.some((write) => inside(write) && !write.ok)) continue;
    const steps = localWrites.filter((write) => inside(write) && write.ok).length;
    if (steps === 0) continue;
    // A declaration inside the loop makes a fresh binding each pass, and
    // its value at the loop's entry is not the one the cursor starts from.
    if ((declarations.get(id) ?? []).some(inside)) continue;
    const declared = declarations.get(id) ?? [];
    const parameter = facts.parameters.has(id);
    if (!parameter && !declared.some((declaration) => !inside(declaration))) continue;
    loops.set(loop, { loop, localId: id });
  }
  return loops;
}

/** Emit `loop` with the cursor local read and stepped at an offset. The
 * loop itself is emitted exactly as it would be without this, so its own
 * copies, guards and integer forms keep working on the pair. */
export function emitStringCursorLoop(
  host: LlvmEmitterContext,
  loop: CursorLoop,
  cursor: StringCursorLoop,
): void {
  const B = host.B;
  const size = host.sizeType;
  const slot = host.binding(cursor.localId).slot;
  const base = B.tmp();
  B.line(`${base} = load ptr, ptr ${slot}`);
  // The base string never changes, so its length is read once.
  host.declare(STRING_UTF16_LEN_DECL);
  const lengthNumber = B.tmp();
  B.line(`${lengthNumber} = call double @scr_str_utf16_len(ptr ${base})`);
  const length = B.tmp();
  B.line(`${length} = fptosi double ${lengthNumber} to ${size}`);
  const offset = B.slot();
  B.entryAllocas.push(`${offset} = alloca ${size} ; string cursor units`);
  B.line(`store ${size} 0, ptr ${offset}`);
  host.stringCursors.set(cursor.localId, { slot, base, length, offset });
  host.stringCursorEmitting.add(loop);
  try {
    host.emitStmt(loop);
  } finally {
    host.stringCursors.delete(cursor.localId);
    host.stringCursorEmitting.delete(loop);
  }
}

interface CursorOffsets {
  offset: string;
  offsetNumber: string;
  length: string;
  remaining: string;
  remainingNumber: string;
}

function loadCursor(host: LlvmEmitterContext, cursor: StringCursor): CursorOffsets {
  const B = host.B;
  const size = host.sizeType;
  const offset = B.tmp();
  B.line(`${offset} = load ${size}, ptr ${cursor.offset}`);
  const offsetNumber = B.tmp();
  B.line(`${offsetNumber} = sitofp ${size} ${offset} to double`);
  const remaining = B.tmp();
  B.line(`${remaining} = sub ${size} ${cursor.length}, ${offset}`);
  const remainingNumber = B.tmp();
  B.line(`${remainingNumber} = sitofp ${size} ${remaining} to double`);
  return { offset, offsetNumber, length: cursor.length, remaining, remainingNumber };
}

/** A read of the cursor local. The analysis admitted only the forms
 * `cursorRead` names. */
export function emitCursorStrIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "strIntrinsic" },
  cursor: StringCursor,
): LlValue {
  const B = host.B;
  const size = host.sizeType;
  const c = loadCursor(host, cursor);
  switch (e.method) {
    case "length":
      return { name: c.remainingNumber, type: e.type };
    case "indexOf": {
      const args = emitStringInputs(host, e.args);
      let from = c.offsetNumber;
      if (args.length > 1) {
        // A position below 0 (and NaN) searches from the start of the
        // suffix; a longer one is clamped by the runtime, which is the
        // clamped position in the suffix too.
        const positive = B.tmp();
        B.line(`${positive} = fcmp ogt double ${args[1]!.name}, 0.0`);
        const clamped = B.tmp();
        B.line(`${clamped} = select i1 ${positive}, double ${args[1]!.name}, double 0.0`);
        from = B.tmp();
        B.line(`${from} = fadd double ${c.offsetNumber}, ${clamped}`);
      }
      host.declare("declare double @scr_str_index_of(ptr, ptr, double)");
      const found = B.tmp();
      B.line(
        `${found} = call double @scr_str_index_of(ptr ${cursor.base}, ptr ${args[0]!.name}, double ${from})`,
      );
      const relative = B.tmp();
      B.line(`${relative} = fsub double ${found}, ${c.offsetNumber}`);
      const hit = B.tmp();
      B.line(`${hit} = fcmp oge double ${found}, 0.0`);
      const result = B.tmp();
      B.line(`${result} = select i1 ${hit}, double ${relative}, double ${f64Lit(-1)}`);
      return { name: result, type: e.type };
    }
    case "charCodeAt":
    case "charAt": {
      const args = emitStringInputs(host, e.args);
      const index = cursorUnitIndex(host, args[0]?.name ?? f64Lit(0), c);
      const result = B.tmp();
      if (e.method === "charCodeAt") {
        host.declare(STRING_CHAR_CODE_AT_DECL);
        B.line(
          `${result} = call double @scr_str_char_code_at(ptr ${cursor.base}, double ${index})`,
        );
        return { name: result, type: e.type };
      }
      host.declare(STRING_CHAR_AT_DECL);
      B.line(`${result} = call ptr @scr_str_char_at(ptr ${cursor.base}, double ${index})`);
      return host.own({ name: result, type: e.type });
    }
    case "slice":
    case "substring": {
      const args = emitStringInputs(host, e.args);
      const substring = e.method === "substring";
      const start = emitSliceUnit(host, args[0]?.name ?? f64Lit(0), c.remaining, substring);
      const end = emitSliceUnit(host, args[1]?.name ?? F64_INF, c.remaining, substring);
      const absoluteStart = B.tmp();
      B.line(`${absoluteStart} = add ${size} ${start}, ${c.offset}`);
      const absoluteEnd = B.tmp();
      B.line(`${absoluteEnd} = add ${size} ${end}, ${c.offset}`);
      const startNumber = B.tmp();
      B.line(`${startNumber} = sitofp ${size} ${absoluteStart} to double`);
      const endNumber = B.tmp();
      B.line(`${endNumber} = sitofp ${size} ${absoluteEnd} to double`);
      const symbol = substring ? "scr_str_substring" : "scr_str_slice";
      host.declare(`declare ptr @${symbol}(ptr, double, double)`);
      const raw = B.tmp();
      B.line(
        `${raw} = call ptr @${symbol}(ptr ${cursor.base}, double ${startNumber}, double ${endNumber})`,
      );
      return host.own({ name: raw, type: e.type });
    }
    default:
      throw new InternalCompilerError(
        `llvm emitter bug: string cursor read ${e.method} was not proven`,
      );
  }
}

/** The unit of the suffix that `index` names, as the base string's index.
 * NaN is unit 0 (ToIntegerOrInfinity), and a unit outside the suffix is the
 * base's length, where the runtime answers NaN or the empty string — the
 * same answer an out-of-range read of the suffix gives. */
function cursorUnitIndex(host: LlvmEmitterContext, index: string, c: CursorOffsets): string {
  const B = host.B;
  const size = host.sizeType;
  // ToIntegerOrInfinity truncates toward zero, so a bound in (-1, 0) is
  // unit 0 rather than out of range, and NaN is unit 0 as well.
  host.declare("declare double @llvm.trunc.f64(double)");
  const truncated = B.tmp();
  B.line(`${truncated} = call double @llvm.trunc.f64(double ${index})`);
  const nan = B.tmp();
  B.line(`${nan} = fcmp uno double ${truncated}, ${truncated}`);
  const zeroed = B.tmp();
  B.line(`${zeroed} = select i1 ${nan}, double 0.0, double ${truncated}`);
  const negative = B.tmp();
  B.line(`${negative} = fcmp olt double ${zeroed}, 0.0`);
  const past = B.tmp();
  B.line(`${past} = fcmp oge double ${zeroed}, ${c.remainingNumber}`);
  const outside = B.tmp();
  B.line(`${outside} = or i1 ${negative}, ${past}`);
  const absolute = B.tmp();
  B.line(`${absolute} = fadd double ${c.offsetNumber}, ${zeroed}`);
  const lengthNumber = B.tmp();
  B.line(`${lengthNumber} = sitofp ${size} ${c.length} to double`);
  const unit = B.tmp();
  B.line(`${unit} = select i1 ${outside}, double ${lengthNumber}, double ${absolute}`);
  return unit;
}

/** `rest = rest.slice(bound)` as a cursor step: the consumed units grow by
 * the bound normalized against the suffix, and no string is copied. */
export function emitStringCursorAdvance(
  host: LlvmEmitterContext,
  cursor: StringCursor,
  advance: StringCursorAdvance,
): void {
  const B = host.B;
  const size = host.sizeType;
  const c = loadCursor(host, cursor);
  const bound = host.emitExpr(advance.bound);
  const start = emitSliceUnit(host, bound.name, c.remaining, advance.substring);
  const next = B.tmp();
  B.line(`${next} = add ${size} ${c.offset}, ${start}`);
  B.line(`store ${size} ${next}, ptr ${cursor.offset}`);
}
