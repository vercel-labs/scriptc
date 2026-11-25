import { isBuiltinClassInstance } from "./receiver-types.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import {
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
  canBoxFuncIntoDyn,
  canConvertToDyn,
} from "../../../ir/ir.js";

/** The createHook callbacks object as a checked-dynamic value. The record
 * conversion boxes its function members by identity (the variable form the
 * Node docs use); undefined and null pass through so the runtime raises
 * Node's destructuring TypeError for them. */
function lowerHookCallbacks(lowerer: Lowerer, node: ts.Expression): IrExpr {
  // Lower the literal with its own record type and convert that value: the
  // record conversion boxes function members as the checked-dynamic
  // functions the hook registry calls (the variable form the Node docs use
  // goes through the same conversion).
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "dyn") return value;
  return lowerer.coerceInto(node, value, DYN);
}

const HOOK_CALLBACK_NAMES = ["init", "before", "after", "destroy", "promiseResolve"] as const;

/** The five callbacks of an inline literal, evaluated in SOURCE order and
 * passed in slot order. Null when the literal holds anything the member-by-
 * member form cannot evaluate faithfully — a spread, a computed or quoted
 * key, an accessor, or a duplicate name (Node's destructuring reads the last
 * one) — which takes the object form instead.
 *
 * Node evaluates the literal's members in source order before createHook
 * reads them, so every member's initializer is lowered into its own hidden
 * local in that order (members the hook does not use included, for their
 * side effects); the five slots then read the locals. */
function literalHookCallbacks(
  lowerer: Lowerer,
  e: ts.ObjectLiteralExpression,
): { stmts: IrStmt[]; args: IrExpr[] } | null {
  const loc = locOf(e);
  const slots = new Map<string, string>(); /* callback name → hidden local */
  const named = new Set<string>();
  const stmts: IrStmt[] = [];
  for (const prop of e.properties.nodes) {
    if (!ts.isIdentifier(prop.name)) return null; /* spread, computed, quoted, accessor */
    const name = prop.name.text;
    if (named.has(name)) return null; /* a later duplicate would win in Node */
    named.add(name);
    let value: IrExpr;
    if (ts.isMethodDeclaration(prop)) {
      value = boxHookCallback(lowerer, prop, lowerer.lowerLambda(prop, true));
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      value = lowerer.lowerExprExpecting(prop.name as unknown as ts.Expression, DYN);
    } else if (ts.isPropertyAssignment(prop)) {
      value = lowerer.lowerExprExpecting(prop.initializer, DYN);
    } else {
      return null;
    }
    const local = lowerer.declareHiddenLocal(`%hook_${name}`, DYN);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: locOf(prop) });
    if ((HOOK_CALLBACK_NAMES as readonly string[]).includes(name)) slots.set(name, local.id);
  }
  const args: IrExpr[] = HOOK_CALLBACK_NAMES.map((name) => {
    const localId = slots.get(name);
    return localId === undefined
      ? dynUndefinedExpr(loc)
      : { kind: "varRef", localId, type: DYN, loc };
  });
  return { stmts, args };
}

/** A lowered method value as a checked-dynamic function. */
function boxHookCallback(lowerer: Lowerer, node: ts.Node, value: IrExpr): IrExpr {
  if (value.type.kind === "dyn") return value;
  if (
    value.type.kind === "func" &&
    canBoxFuncIntoDyn(
      value.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { kind: "dynFrom", value, type: DYN, loc: value.loc };
  }
  if (
    canConvertToDyn(
      value.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { kind: "dynFrom", value, type: DYN, loc: value.loc };
  }
  lowerer.unsupported(
    "SC1090",
    node,
    `async_hooks callbacks of type '${lowerer.fmt(value.type)}' (a callback crosses as a dyn function)`,
  );
}

/** node:async_hooks — createHook(callbacks), executionAsyncId() and
 * triggerAsyncId(). The callbacks object crosses as a dyn value, so the
 * runtime applies Node's own checks (its destructuring TypeError for
 * undefined or null and ERR_ASYNC_CALLBACK for a non-function member), and
 * the AsyncHook it answers is an f64 handle whose enable()/disable() lower
 * through lowerAsyncHooksMethodCall. */
export function lowerAsyncHooksCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.member === "executionAsyncId")
    return { kind: "libCall", fn: "ah.executionId", args: [], type: F64, loc };
  if (bi.member === "triggerAsyncId")
    return { kind: "libCall", fn: "ah.triggerId", args: [], type: F64, loc };
  if (bi.member === "executionAsyncResource")
    return { kind: "libCall", fn: "ah.executionResource", args: [], type: DYN, loc };
  if (bi.member === "createHook" && expr.arguments.nodes.length <= 1) {
    const node = expr.arguments.nodes[0];
    if (node !== undefined) {
      let e = node;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isObjectLiteralExpression(e)) {
        const parts = literalHookCallbacks(lowerer, e);
        if (parts !== null) {
          const call: IrExpr = {
            kind: "libCall",
            fn: "ah.createHookParts",
            args: parts.args,
            type: F64,
            loc,
          };
          if (parts.stmts.length === 0) return call;
          return { kind: "seqExpr", stmts: parts.stmts, result: call, type: F64, loc };
        }
      }
    }
    const callbacks =
      node !== undefined ? lowerHookCallbacks(lowerer, node) : dynUndefinedExpr(loc);
    return { kind: "libCall", fn: "ah.createHook", args: [callbacks], type: F64, loc };
  }
  return null;
}

/** Method calls on AsyncHook receivers: enable() and disable() over the
 * f64 hook handle; each answers the hook (`this`), as Node's do. */
export function lowerAsyncHooksMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "AsyncHook")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  if ((name === "enable" || name === "disable") && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    return {
      kind: "libCall",
      fn: name === "enable" ? "ah.enable" : "ah.disable",
      args: [receiver],
      type: F64,
      loc: locOf(call),
    };
  }
  lowerer.noLowering(
    `AsyncHook.${name}`,
    call,
    "enable() and disable() are the supported AsyncHook members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}
