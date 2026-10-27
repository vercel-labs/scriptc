/* node:v8 — importable, with one lowered member. Packages require it at
 * top level and touch it on optional paths (dd-trace's runtime metrics),
 * so the module itself is not refused. getHeapStatistics answers
 * allocator-derived figures in Node's shape and field order, in the
 * spirit of process.memoryUsage(): approximate values, not V8 heap
 * figures (a compiled binary embeds no V8 engine). Every other member
 * fences at its use with the by-design reason (builtinFenceHintOf). */
import { keyedHelperName } from "../stable-names.js";
import { numLit } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { F64, type IrExpr, type SrcLoc, VOID } from "../../../ir/ir.js";

/** v8.getHeapStatistics()'s fields, in Node's order. */
const HEAP_STATISTICS_FIELDS = [
  "total_heap_size",
  "total_heap_size_executable",
  "total_physical_size",
  "total_available_size",
  "used_heap_size",
  "heap_size_limit",
  "malloced_memory",
  "peak_malloced_memory",
  "does_zap_garbage",
  "number_of_native_contexts",
  "number_of_detached_contexts",
  "total_global_handles_size",
  "used_global_handles_size",
  "external_memory",
];

/** `v8.getHeapStatistics()`: one memoryUsage sample (the runtime heap's
 * total and used bytes), with the machine's memory as the heap limit (the
 * runtime heap has no fixed ceiling) and the available size the limit
 * minus used bytes. V8-only figures (executable code space, malloced
 * memory, global handles, external memory, zapping) read 0, and one
 * native context exists. The record is the call site's interned HeapInfo
 * shape, built by a shared helper per shape. */
export function lowerV8HeapStatisticsCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(`v8.getHeapStatistics with ${call.arguments.nodes.length} arguments`, call);
  }
  const t = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (t?.kind !== "record") lowerer.badType(call, lowerer.typeOf(call));
  const shape = lowerer.shapes.get(t.shapeId);
  if (
    !shape ||
    !shape.fields.every((f) => HEAP_STATISTICS_FIELDS.includes(f.name) && f.type.kind === "f64")
  ) {
    lowerer.badType(call, lowerer.typeOf(call));
  }
  const key = `v8.getHeapStatistics:${t.shapeId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%v8.getHeapStatistics", key);
    lowerer.valueHelpers.set(key, helper);
    const sample = (index: number): IrExpr => ({
      kind: "libCall",
      fn: "process.memoryUsageField",
      args: [numLit(index, loc)],
      type: F64,
      loc,
    });
    const limit = (): IrExpr => ({ kind: "libCall", fn: "os.totalmem", args: [], type: F64, loc });
    const value = (name: string): IrExpr => {
      switch (name) {
        case "total_heap_size":
        case "total_physical_size":
          return sample(1);
        case "used_heap_size":
          return sample(2);
        case "heap_size_limit":
          return limit();
        case "total_available_size":
          return { kind: "bin", op: "-", left: limit(), right: sample(2), type: F64, loc };
        case "number_of_native_contexts":
          return numLit(1, loc);
        default:
          return numLit(0, loc);
      }
    };
    lowerer.liftedFns.push({
      name: helper,
      params: [],
      returnType: t,
      locals: [],
      body: [
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "process.memoryUsageTake", args: [], type: VOID, loc },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: shape.fields.map((f) => ({ name: f.name, value: value(f.name) })),
            type: t,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [], type: t, loc };
}
