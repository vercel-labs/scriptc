/* Search METHOD calls on a UNION receiver: `u.includes(v)` and
 * `u.indexOf(v)` where the value holds either a string or an array
 * (`string | string[]`, a header value Node types that way).
 *
 * JavaScript reads the property off the value it holds and calls it, so
 * each arm runs its own method: a string searches for a substring, an array
 * searches for an element. Neither arm can be picked statically, and the
 * dynamic call tier cannot run a primitive's own methods, so the call
 * lowers as a dispatch on the arm the value holds — the receiver is
 * evaluated once, each arm reads the member on its own narrowed value, and
 * the answers (both `boolean` for `includes`, both `number` for `indexOf`)
 * join in a ternary. This mirrors unionArmsLength's in-place reads.
 *
 * Supported forms: one argument, no spread, no optional chain, every arm a
 * string or an array whose element type the needle's own lowered type
 * equals (the array search helper's fast path; other needle shapes and the
 * optional `fromIndex` keep the member fence). A union with a unit arm is
 * left to the fence: the nullish receiver throws Node's TypeError before
 * the member read, which this dispatch does not reproduce. */

import { BOOL, F64, type IrExpr, type IrStmt, isUnitType, typeEquals } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { lowerStringMethodCall } from "./containers/string-and-regexp.js";
import type { Lowerer } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";

const UNION_SEARCH_METHODS = new Set(["includes", "indexOf"]);

export function lowerUnionSearchMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken || call.questionDotToken) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const method = access.name.text;
  if (!UNION_SEARCH_METHODS.has(method)) return null;
  const arrayMethod = method as "includes" | "indexOf";
  // The two-argument form (`includes(needle, position)`) has no shared
  // array-side form here yet; the single-argument search is the reported
  // shape and the one both arms lower today.
  if (call.arguments.nodes.length !== 1) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const declared = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (declared?.kind !== "union") return null;
  const declaredArms = lowerer.unions.get(declared.unionId)?.arms ?? [];
  if (declaredArms.length < 2) return null;
  if (declaredArms.some((arm) => isUnitType(arm))) return null;
  if (!declaredArms.every((arm) => arm.kind === "string" || arm.kind === "array")) return null;
  // A union of strings alone is an ordinary string search the string
  // lowering already handles; only a mixed string/array union needs the
  // dispatch.
  if (!declaredArms.some((arm) => arm.kind === "string")) return null;
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "union") return null;
  const unionId = receiver.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (arms === undefined) return null;
  if (arms.some((arm) => isUnitType(arm))) return null;
  if (!arms.every((arm) => arm.kind === "string" || arm.kind === "array")) return null;

  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  let ref: IrExpr = receiver;
  if (receiver.kind !== "varRef") {
    const local = lowerer.declareHiddenLocal("%unionSearch", receiver.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: receiver, loc });
    ref = varRef(local.id, receiver.type, loc);
  }
  const narrowed = (tag: number): IrExpr => ({
    kind: "unionNarrow",
    unionId,
    tag,
    value: ref,
    type: arms[tag]!,
    loc,
  });
  const armCall = (tag: number): IrExpr | null => {
    const arm = arms[tag]!;
    if (arm.kind === "string")
      return lowerStringMethodCall(lowerer, call, access, () => narrowed(tag));
    // An array arm: the search helper's fast path, which takes a needle of
    // the array's own element type. A union element type, a bigint or a
    // promise element keeps the fence: their searches compare differently.
    if (arm.kind !== "array") return null;
    const elem = arm.elem;
    if (elem.kind === "union" || elem.kind === "bigint" || elem.kind === "promise") return null;
    const needle = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (!typeEquals(needle.type, elem)) return null;
    return {
      kind: "arrIntrinsic",
      method: arrayMethod,
      receiver: narrowed(tag),
      args: [needle],
      type: method === "includes" ? BOOL : F64,
      loc,
    };
  };
  const results: IrExpr[] = [];
  for (let tag = 0; tag < arms.length; tag++) {
    const result = armCall(tag);
    if (result === null) return null;
    results.push(result);
  }
  let value = results[results.length - 1]!;
  for (let tag = arms.length - 2; tag >= 0; tag--) {
    value = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: ref, type: BOOL, loc },
      then: results[tag]!,
      else_: value,
      type: value.type,
      loc,
    };
  }
  return stmts.length === 0
    ? value
    : { kind: "seqExpr", stmts, result: value, type: value.type, loc };
}
