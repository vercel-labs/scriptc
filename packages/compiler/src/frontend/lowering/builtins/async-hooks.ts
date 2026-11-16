import { isBuiltinClassInstance } from "./receiver-types.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import {
  DYN,
  F64,
  type IrExpr,
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

/** The five callbacks of an inline literal as dyn values, member by member
 * (a method spelling lowers through the lambda path, a property assignment
 * through its initializer, a missing member is undefined); null when the
 * literal holds a spread or accessor, which takes the object form. */
function literalHookCallbacks(lowerer: Lowerer, e: ts.ObjectLiteralExpression): IrExpr[] | null {
  const loc = locOf(e);
  const out: IrExpr[] = [];
  for (const name of HOOK_CALLBACK_NAMES) {
    const prop = e.properties.nodes.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (prop === undefined) {
      out.push(dynUndefinedExpr(loc));
      continue;
    }
    if (ts.isMethodDeclaration(prop)) {
      out.push(boxHookCallback(lowerer, prop, lowerer.lowerLambda(prop, true)));
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      out.push(lowerer.lowerExprExpecting(prop.name as unknown as ts.Expression, DYN));
    } else if (ts.isPropertyAssignment(prop)) {
      out.push(lowerer.lowerExprExpecting(prop.initializer, DYN));
    } else {
      return null;
    }
  }
  return out;
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
  if (bi.member === "createHook" && expr.arguments.nodes.length <= 1) {
    const node = expr.arguments.nodes[0];
    if (node !== undefined) {
      let e = node;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isObjectLiteralExpression(e)) {
        const parts = literalHookCallbacks(lowerer, e);
        if (parts !== null)
          return { kind: "libCall", fn: "ah.createHookParts", args: parts, type: F64, loc };
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
