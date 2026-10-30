import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { dynUndefinedExpr, numLit } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr, type IrLibFn } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:util's MIMEType and MIMEParams are native checked-dynamic handles
 * (scr_mime.c): both types map to dyn, their getters and setters are
 * handle property reads and writes, their methods dispatch through the
 * handle, and these helpers lower the uses a dyn value cannot answer by
 * itself (construction, MIMEType.parse and instanceof). */

type MimeClass = "MIMEType" | "MIMEParams";

/** The MIMEType or MIMEParams class in any node:util spelling. */
export function mimeClassOf(lowerer: Lowerer, node: ts.Expression): MimeClass | null {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  if (builtin?.module !== "util") return null;
  return builtin.member === "MIMEType" || builtin.member === "MIMEParams" ? builtin.member : null;
}

/** The class of a stdlib MIMEType- or MIMEParams-typed value. */
function mimeValueClass(lowerer: Lowerer, node: ts.Expression): MimeClass | null {
  const type = lowerer.typeOf(node);
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  if (!sym) return null;
  const name = ts.symbolName(sym);
  if (name !== "MIMEType" && name !== "MIMEParams") return null;
  return lowerer.isStdlibSymbol(sym) ? name : null;
}

/** The call of `fn` over the first `count` arguments, as checked-dynamic
 * values (missing ones as undefined). Every argument evaluates in order
 * before the call, as in JavaScript: with surplus arguments, the used ones
 * are held in hidden locals while the others evaluate. */
function mimeCall(
  lowerer: Lowerer,
  fn: IrLibFn,
  nodes: readonly ts.Expression[],
  count: number,
  loc: ReturnType<typeof locOf>,
): IrExpr {
  const values = nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  if (values.length <= count) {
    const args = [...values];
    while (args.length < count) args.push(dynUndefinedExpr(loc));
    return { kind: "libCall", fn, args, type: DYN, loc };
  }
  const locals = values.slice(0, count).map((value) => ({
    value,
    local: lowerer.declareHiddenLocal("%mimeArg", DYN),
  }));
  return {
    kind: "seqExpr",
    stmts: [
      ...locals.map(({ value, local }) => ({
        kind: "varDecl" as const,
        localId: local.id,
        init: value,
        loc,
      })),
      ...values.slice(count).map((arg) => ({ kind: "exprStmt" as const, expr: arg, loc: arg.loc })),
    ],
    result: {
      kind: "libCall",
      fn,
      args: locals.map(({ local }): IrExpr => ({
        kind: "varRef",
        localId: local.id,
        type: DYN,
        loc,
      })),
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** `new MIMEType(string[, noThrow])` and `new MIMEParams()`. */
export function lowerMimeNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const cls = mimeClassOf(lowerer, expr.expression);
  if (cls === null) return null;
  const nodes = expr.arguments?.nodes ?? [];
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const fn: IrLibFn = cls === "MIMEType" ? "mime.typeNew" : "mime.paramsNew";
  return mimeCall(lowerer, fn, nodes, cls === "MIMEType" ? 2 : 0, loc);
}

const INSTANCE_METHODS: Record<MimeClass, ReadonlySet<string>> = {
  MIMEType: new Set(["toString", "toJSON"]),
  MIMEParams: new Set([
    "get",
    "has",
    "set",
    "delete",
    "entries",
    "keys",
    "values",
    "toString",
    "toJSON",
  ]),
};

/** MIMEType.parse(), and the instance methods, which the handle answers
 * as methods, so they dispatch through dynInvoke rather than as a member
 * read and a call. */
export function lowerMimeCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "parse" && mimeClassOf(lowerer, access.expression) === "MIMEType") {
    return mimeCall(lowerer, "mime.typeParse", call.arguments.nodes, 1, loc);
  }
  const cls = mimeValueClass(lowerer, access.expression);
  if (cls === null || !INSTANCE_METHODS[cls].has(name)) return null;
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: name,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** Reports SC2020 when `access` reads a static member of MIMEType or
 * MIMEParams (`MIMEType.prototype`, `MIMEType.name`); null otherwise.
 * JavaScript sources hold either class as an identity token, which has no
 * members, so the read would answer undefined. MIMEType.parse calls lower
 * in lowerMimeCall and never reach the member read. */
export function fenceMimeStaticRead(lowerer: Lowerer, access: ts.PropertyAccessExpression): null {
  const cls = mimeClassOf(lowerer, access.expression);
  if (cls !== null) lowerer.noLowering(`util.${cls}.${access.name.text}`, access);
  return null;
}

/** `v instanceof MIMEType` / `v instanceof MIMEParams`. */
export function lowerMimeInstanceof(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const cls = mimeClassOf(lowerer, expr.right);
  if (cls === null) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "mime.is",
    args: [value, numLit(cls === "MIMEType" ? 0 : 1, loc)],
    type: BOOL,
    loc,
  };
}

/** `params`, `params.keys()`, `params.values()` or `params.entries()` over a
 * MIMEParams: its checked-dynamic view iterates the live entry list, like
 * URLSearchParams (isSearchParamsIterable). */
export function isMimeParamsIterable(lowerer: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (mimeValueClass(lowerer, node) === "MIMEParams") return true;
  if (
    !ts.isCallExpression(node) ||
    node.arguments.nodes.length !== 0 ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return false;
  const name = node.expression.name.text;
  return (
    (name === "keys" || name === "values" || name === "entries") &&
    mimeValueClass(lowerer, node.expression.expression) === "MIMEParams"
  );
}
