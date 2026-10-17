import {
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrStrIntrinsicMethod,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { F64_INF, f64Lit, sizeToDouble } from "./common.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

type Slice = IrExpr & { kind: "strIntrinsic" };

function isSlice(value: IrExpr): value is Slice {
  return (
    value.kind === "strIntrinsic" && (value.method === "slice" || value.method === "substring")
  );
}

/** A local used exclusively for scalar indexing needs no copied bytes.
 * Snapshot the receiver and normalized bounds at its initializer, including
 * side effects in the bounds. Escapes, captures, writes, suspension, and all
 * other string consumers keep the ordinary materialized representation. */
export function findScalarStringSlices(
  fn: IrFunction,
  lifetimes: CallLifetimes,
): Map<string, Slice> {
  const slices = new Map<string, Slice>();
  if (fn.async || fn.generator) return slices;
  const bindings = lifetimes.bindings.get(fn.name);
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        bindings?.has(stmt.localId) &&
        stmt.init?.kind === "strIntrinsic" &&
        (stmt.init.method === "slice" || stmt.init.method === "substring")
      )
        slices.set(stmt.localId, stmt.init);
      return true;
    },
  });
  if (slices.size === 0) return slices;
  const invalid = new Set<string>();
  function expr(value: IrExpr): boolean {
    if (
      value.kind === "strIntrinsic" &&
      (value.method === "length" || value.method === "charCodeAt") &&
      value.receiver.kind === "varRef" &&
      slices.has(value.receiver.localId)
    ) {
      value.args.forEach(expr);
      return true;
    }
    if (value.kind === "varRef" && slices.has(value.localId)) invalid.add(value.localId);
    if (value.kind === "closure" || value.kind === "classRef")
      for (const id of value.captures ?? []) invalid.add(id);
    return everyExprChild(value, expr, stmt);
  }
  function stmt(value: IrStmt): boolean {
    return everyStmtChild(value, expr, stmt);
  }
  fn.body.forEach(stmt);
  for (const id of invalid) slices.delete(id);
  return slices;
}

export interface StringSliceSnapshot {
  source: string;
  range: string;
}

/** Own the original string for the complete local scope. A later append
 * cannot mutate it in place, even when the original binding was unique. */
export function emitStringSliceSnapshot(
  host: LlvmEmitterContext,
  slice: Slice,
): StringSliceSnapshot {
  const B = host.B;
  const source = host.emitExpr(slice.receiver);
  const args = slice.args.map((arg) => host.emitExpr(arg));
  const sourceSlot = B.slot(),
    range = B.slot();
  B.entryAllocas.push(
    `${sourceSlot} = alloca ptr`,
    `${range} = alloca { ${host.sizeType}, ${host.sizeType}, i32 }`,
  );
  B.line(`store ptr ${source.name}, ptr ${sourceSlot}`);
  host.declare("declare void @scr_str_slice_range(ptr, double, double, i1 zeroext, ptr)");
  B.line(
    `call void @scr_str_slice_range(ptr ${source.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}, i1 ${slice.method === "substring" ? "true" : "false"}, ptr ${range})`,
  );
  host.moveTemp(source);
  return { source: sourceSlot, range };
}

export function emitStringSliceRead(host: LlvmEmitterContext, value: Slice): LlValue | null {
  if (value.receiver.kind !== "varRef") return null;
  const snapshot = host.stringSlices.get(value.receiver.localId);
  if (!snapshot) return null;
  const B = host.B;
  if (value.method === "length") {
    const pointer = B.tmp(),
      length = B.tmp(),
      number = B.tmp();
    B.line(
      `${pointer} = getelementptr inbounds { ${host.sizeType}, ${host.sizeType}, i32 }, ptr ${snapshot.range}, i32 0, i32 1`,
    );
    B.line(`${length} = load ${host.sizeType}, ptr ${pointer}`);
    B.line(`${number} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${length} to double`);
    return { name: number, type: value.type };
  }
  if (value.method !== "charCodeAt") return null;
  const index = value.args[0] ? host.emitExpr(value.args[0]) : { name: f64Lit(0) };
  const source = B.tmp(),
    result = B.tmp();
  B.line(`${source} = load ptr, ptr ${snapshot.source}`);
  host.declare("declare double @scr_str_slice_char_code_at(ptr, ptr, double)");
  B.line(
    `${result} = call double @scr_str_slice_char_code_at(ptr ${source}, ptr ${snapshot.range}, double ${index.name})`,
  );
  return { name: result, type: value.type };
}

/** Bytes of the stack buffer behind one scratch slice, header included. */
export const SCRATCH_SLICE_BYTES = 96;

/** String methods that read a lent receiver or argument only during their
 * runtime call and never return it. Methods returning a string can return
 * their unchanged receiver, so they stay on the owned path. */
const LENDING_METHODS: ReadonlySet<IrStrIntrinsicMethod> = new Set([
  "length",
  "charCodeAt",
  "indexOf",
  "includes",
  "startsWith",
  "endsWith",
]);

/** Numeric parsers read their text during the call. */
const LENDING_LIB_FNS: ReadonlySet<string> = new Set([
  "num.fromString",
  "num.parseInt",
  "num.parseFloat",
]);

/** Typed string-keyed collection operations: reads probe with the key, and
 * an insertion stores scr_str_scratch_keep's copy (scr_map_append). */
const LENDING_KEY_METHODS: ReadonlySet<string> = new Set(["get", "has", "set", "add", "delete"]);

function stringKeyed(value: IrExpr & { kind: "mapIntrinsic" | "setIntrinsic" }): boolean {
  const receiver = value.receiver.type;
  if (receiver.kind === "map")
    return receiver.key.kind === "string" && receiver.value.kind !== "dyn";
  if (receiver.kind === "set") return receiver.elem.kind === "string";
  return false;
}

/** String parameters, by function and index, that the body reads only in
 * lending positions (findLentStringParameters). */
export type LentStringParameters = ReadonlyMap<string, ReadonlySet<number>>;

/** The operands `value` reads only while it runs, keeping no reference. */
function lentOperands(value: IrExpr, parameters: LentStringParameters): readonly IrExpr[] {
  switch (value.kind) {
    case "strEq":
    case "strCmp":
      return [value.left, value.right];
    case "strIntrinsic":
      return LENDING_METHODS.has(value.method) ? [value.receiver, ...value.args] : [];
    case "libCall":
      return LENDING_LIB_FNS.has(value.fn) ? value.args.slice(0, 1) : [];
    case "mapIntrinsic":
    case "setIntrinsic":
      return LENDING_KEY_METHODS.has(value.method) && stringKeyed(value)
        ? value.args.slice(0, 1)
        : [];
    case "call": {
      const lent = parameters.get(value.callee);
      return lent ? value.args.filter((_, index) => lent.has(index)) : [];
    }
    default:
      return [];
  }
}

interface LendingScan {
  /** Slice operands of lending consumers, excluding any node also reached
   * in an owning position. */
  scratch: Set<IrExpr>;
  /** Candidates read anywhere other than a lending position. */
  invalid: Set<string>;
  /** Direct callees, for the parameter fixpoint. */
  callees: Set<string>;
}

/** One pass over `fn`: which candidate bindings only lending consumers read
 * (a slice initializer of a candidate local is not itself a read), and
 * which slice operands those consumers lend. A switch discriminant is only
 * compared with the case tests. */
function scanLending(
  fn: IrFunction,
  candidates: ReadonlySet<string>,
  initializers: ReadonlyMap<string, Slice>,
  parameters: LentStringParameters,
): LendingScan {
  const scan: LendingScan = { scratch: new Set(), invalid: new Set(), callees: new Set() };
  const owned = new Set<IrExpr>();
  function lent(value: IrExpr): boolean {
    if (value.kind === "varRef" && candidates.has(value.localId)) return true;
    if (!isSlice(value)) return expr(value);
    scan.scratch.add(value);
    return everyExprChild(value, expr, stmt);
  }
  function expr(value: IrExpr): boolean {
    if (isSlice(value)) owned.add(value);
    if (value.kind === "varRef" && candidates.has(value.localId)) scan.invalid.add(value.localId);
    if (value.kind === "closure" || value.kind === "classRef")
      for (const id of value.captures ?? []) scan.invalid.add(id);
    if (value.kind === "call") scan.callees.add(value.callee);
    const operands = lentOperands(value, parameters);
    if (operands.length === 0) return everyExprChild(value, expr, stmt);
    return everyExprChild(
      value,
      (child) => (operands.includes(child) ? lent(child) : expr(child)),
      stmt,
    );
  }
  function stmt(value: IrStmt): boolean {
    // A candidate's single declaration initializes it with its slice.
    if (value.kind === "varDecl" && value.init !== null && initializers.has(value.localId))
      return everyExprChild(value.init, expr, stmt);
    if (value.kind === "switch" && value.disc.type.kind === "string") {
      lent(value.disc);
      for (const entry of value.cases) {
        if (entry.test) expr(entry.test);
        entry.body.forEach(stmt);
      }
      return true;
    }
    return everyStmtChild(value, expr, stmt);
  }
  fn.body.forEach(stmt);
  for (const node of owned) scan.scratch.delete(node);
  return scan;
}

/** String parameters that every body reads only in lending positions,
 * including lent arguments of other such parameters: a caller may pass a
 * scratch slice to them. Start from every borrowed (unchanged) string
 * parameter of a synchronous function and drop violations until nothing changes, so
 * recursion through a lent parameter stays lent. A coroutine can keep its
 * parameters past the caller's frame, so it never lends. */
export function findLentStringParameters(
  functions: ReadonlyMap<string, IrFunction>,
  lifetimes: CallLifetimes,
): Map<string, Set<number>> {
  const lent = new Map<string, Set<number>>();
  for (const fn of functions.values()) {
    if (fn.async || fn.generator) continue;
    // Borrowed parameters are the unchanged ones nothing redeclares.
    const stable = lifetimes.borrowed.get(fn.name);
    const indexes = new Set<number>();
    fn.params.forEach((param, index) => {
      if (param.type.kind === "string" && stable?.has(index)) indexes.add(index);
    });
    if (indexes.size > 0) lent.set(fn.name, indexes);
  }
  const callers = new Map<string, Set<string>>();
  const pending = new Set(lent.keys());
  while (pending.size > 0) {
    const name = pending.values().next().value as string;
    pending.delete(name);
    const indexes = lent.get(name);
    const fn = functions.get(name);
    if (!indexes || !fn) continue;
    const ids = new Set([...indexes].map((index) => fn.params[index]!.localId));
    const scan = scanLending(fn, ids, new Map(), lent);
    for (const callee of scan.callees) {
      let set = callers.get(callee);
      if (!set) callers.set(callee, (set = new Set()));
      set.add(name);
    }
    let changed = false;
    for (const index of [...indexes]) {
      if (!scan.invalid.has(fn.params[index]!.localId)) continue;
      indexes.delete(index);
      changed = true;
    }
    if (!changed) continue;
    if (indexes.size === 0) lent.delete(name);
    const affected = callers.get(name);
    if (affected) for (const caller of affected) if (lent.has(caller)) pending.add(caller);
  }
  return lent;
}

/** Slices whose every reader borrows them are written into a stack buffer
 * instead of a heap allocation (scr_str_slice_scratch): a slice operand of
 * a lending consumer, and the initializer of a stable local read only by
 * lending consumers. The copy is ASCII, bounded, and immortal for retain and
 * release, so it neither pins its source nor needs to be freed; longer or
 * non-ASCII results keep the ordinary owned string. Each site owns its
 * buffer: a site runs again only after its previous value is dead, since
 * nothing can keep it. Coroutine frames do not keep stack buffers across a
 * suspension, so they are left alone. */
export function findScratchStringSlices(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  scalar: ReadonlyMap<string, Slice>,
  parameters: LentStringParameters = new Map(),
): Set<IrExpr> {
  if (fn.async || fn.generator) return new Set();
  const bindings = lifetimes.bindings.get(fn.name);
  const locals = new Map<string, Slice>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        bindings?.has(stmt.localId) &&
        !scalar.has(stmt.localId) &&
        stmt.init !== null &&
        isSlice(stmt.init)
      )
        locals.set(stmt.localId, stmt.init);
      return true;
    },
  });
  const scan = scanLending(fn, new Set(locals.keys()), locals, parameters);
  for (const [id, init] of locals) if (!scan.invalid.has(id)) scan.scratch.add(init);
  return scan.scratch;
}

/** Write a scratch slice into its own stack buffer. The result is owned:
 * releasing the scratch copy does nothing, and a heap fallback is freed. */
export function emitScratchStringSlice(
  host: LlvmEmitterContext,
  slice: Slice,
  receiver: LlValue,
  args: readonly LlValue[],
): LlValue {
  const B = host.B;
  const buffer = B.slot();
  B.entryAllocas.push(`${buffer} = alloca [${SCRATCH_SLICE_BYTES} x i8], align 8`);
  host.declare(
    `declare ptr @scr_str_slice_scratch(ptr, double, double, i1 zeroext, ptr, ${host.sizeType})`,
  );
  const result = B.tmp();
  B.line(
    `${result} = call ptr @scr_str_slice_scratch(ptr ${receiver.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}, i1 ${slice.method === "substring" ? "true" : "false"}, ptr ${buffer}, ${host.sizeType} ${SCRATCH_SLICE_BYTES})`,
  );
  return host.own({ name: result, type: slice.type });
}
