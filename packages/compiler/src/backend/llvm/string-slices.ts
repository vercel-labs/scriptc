import { type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { F64_INF, f64Lit } from "./common.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

type Slice = IrExpr & { kind: "strIntrinsic" };

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
    B.line(`${number} = uitofp ${host.sizeType} ${length} to double`);
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
