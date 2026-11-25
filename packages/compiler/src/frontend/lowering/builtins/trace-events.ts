import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import { DYN, type IrExpr, type SrcLoc, canConvertToDyn } from "../../../ir/ir.js";

/** node:trace_events — createTracing(options) and getEnabledCategories().
 * The options object crosses as a checked-dynamic value, so the runtime
 * applies Node's own checks (the object, the categories array, its string
 * members, at least one category) and answers the Tracing handle; the
 * handle's member reads and enable()/disable() calls ride the checked-
 * dynamic tree (type-mapper.ts maps Tracing to the checked-dynamic value),
 * which is why no member lowering is needed here. */
export function lowerTraceEventsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.member === "createTracing") {
    const node = expr.arguments.nodes[0];
    if (node === undefined) {
      // An omitted options object is the undefined value: Node's own
      // "must be of type object" check answers it at run time.
      return {
        kind: "libCall",
        fn: "te.createTracing",
        args: [dynUndefinedExpr(loc)],
        type: DYN,
        loc,
      };
    }
    if (ts.isSpreadElement(node))
      lowerer.noLowering("trace_events.createTracing with spread arguments", node);
    const value = lowerer.lowerExpr(node);
    if (value.type.kind === "dyn")
      return { kind: "libCall", fn: "te.createTracing", args: [value], type: DYN, loc };
    if (
      canConvertToDyn(
        value.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      return {
        kind: "libCall",
        fn: "te.createTracing",
        args: [{ kind: "dynFrom", value, type: DYN, loc: locOf(node) }],
        type: DYN,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      node,
      `trace_events.createTracing options of type '${lowerer.fmt(value.type)}' (the options object crosses as a dyn value)`,
    );
  }
  if (bi.member === "getEnabledCategories" && expr.arguments.nodes.length === 0) {
    return { kind: "libCall", fn: "te.getEnabledCategories", args: [], type: DYN, loc };
  }
  return null;
}
