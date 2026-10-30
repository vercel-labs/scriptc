import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  VOID,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { helperLoc, strLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { hasStaticThis } from "./static-this.js";
import type { Lowerer } from "./lowerer.js";
import { lowerClassStaticRead, lowerStaticMethodCall, type ClassInfo } from "./lower-classes.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { lowerCallThroughValue } from "./lower-calls.js";

/** How a static private name is used: a field read or write, or a method
 * (or accessor) read or call. V8 words each failure differently. */
export type StaticPrivateUse = "read" | "write" | "method";

/** The declaration-level class whose body declares `priv` as a STATIC
 * member (the nearest enclosing class declaring the name, as JavaScript
 * scoping resolves it). Null for an instance private, a function-local or
 * generic class, or a class that was not collected. */
export function staticPrivateOwner(lowerer: Lowerer, priv: ts.PrivateIdentifier): ClassInfo | null {
  for (let node: ts.Node | undefined = priv.parent; node; node = node.parent) {
    if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) continue;
    const member = node.members.nodes.find((candidate) => {
      const name = (candidate as { name?: ts.PropertyName }).name;
      return name !== undefined && ts.isPrivateIdentifier(name) && name.text === priv.text;
    });
    if (!member) continue;
    const isStatic =
      ts.canHaveModifiers(member) &&
      ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
    if (!isStatic) return null;
    for (const info of lowerer.classes.values()) {
      if (info.decl !== node) continue;
      if (info.localClass || info.generic || info.genericInstance) return null;
      return info;
    }
    return null;
  }
  return null;
}

/** V8's TypeError text for a static private `name` of `info` used on a
 * receiver that is not the declaring class object. */
function brandMessage(info: ClassInfo, use: StaticPrivateUse, name: string): string {
  if (use === "read")
    return `Cannot read private member ${name} from an object whose class did not declare it`;
  if (use === "write")
    return `Cannot write private member ${name} to an object whose class did not declare it`;
  // V8 names the class by its own identifier; an anonymous class
  // expression prints ".".
  return `Receiver must be class ${info.decl?.name?.text ?? "."}`;
}

/** The brand check of a static private: JavaScript installs static private
 * elements on the declaring class object alone, so the receiver must BE
 * that object (a subclass, an object inheriting from it, or a primitive
 * throws). An expression statement calling the lifted helper
 * `%private.static.<use>:<class>:<#name>(value: dyn): void`, which throws
 * V8's TypeError; `value` is the checked-dynamic receiver. */
export function staticPrivateBrandCheck(
  lowerer: Lowerer,
  info: ClassInfo,
  use: StaticPrivateUse,
  name: string,
  value: IrExpr,
  loc: SrcLoc,
): IrStmt {
  const helper = `%private.static.${use}:${info.def.name}:${name}`;
  if (!lowerer.valueHelpers.has(helper)) {
    const at = helperLoc(loc);
    const param = varRef("value.0", DYN, at);
    const classValue = lowerer.coerceToExpected(lowerer.classValueRef(info, info.decl!), DYN);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: DYN }],
      returnType: VOID,
      locals: [{ id: "value.0", name: "value", type: DYN, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "dynScalarEq",
            left: param,
            right: classValue,
            negated: true,
            type: BOOL,
            loc: at,
          },
          then: [
            {
              kind: "throw",
              value: {
                kind: "libCall",
                fn: "error.new",
                args: [strLit(brandMessage(info, use, name), at)],
                type: { kind: "object", className: "%TypeError" },
                loc: at,
              },
              loc: at,
            },
          ],
          else_: null,
          loc: at,
        },
      ],
      loc: at,
    });
    lowerer.valueHelpers.set(helper, helper);
  }
  return {
    kind: "exprStmt",
    expr: { kind: "call", callee: helper, args: [value], type: VOID, loc },
    loc,
  };
}

/** A static private the native storage does not hold (an accessor, a
 * field without an initializer): a loud refusal, never a string-keyed
 * read of the class object. */
function unsupportedStaticPrivate(lowerer: Lowerer, node: ts.Node, name: string): never {
  return lowerer.unsupported(
    "SC1090",
    node,
    `the private static '${name}' in this form on a class whose constructor carries runtime statics`,
  );
}

/** The checked-dynamic value `expr` lowers to, or null. */
function checkedDynamicReceiver(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const probed = tryLowerExpression(lowerer, node);
  if (!probed) return null;
  if (
    probed.type.kind !== "dyn" &&
    !(probed.kind === "dynCheck" && probed.value.type.kind === "dyn")
  )
    return null;
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "dyn") return value;
  return value.kind === "dynCheck" ? value.value : null;
}

/** `R.#x` / `R.#m` read, where `#x` is a static private of a
 * declaration-level class and `R` is a checked-dynamic value (`this` in a
 * static accessor or method that the constructor object carries): the
 * brand check, then the member's native storage. Null for other reads,
 * which keep their paths (the class's own name reads storage directly). */
export function lowerStaticPrivateRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (!ts.isPrivateIdentifier(expr.name) || expr.questionDotToken) return null;
  const info = staticPrivateOwner(lowerer, expr.name);
  if (!info || !info.runtimeStatics) return null;
  if (lowerer.exactClassOfReceiver(expr.expression) === info) return null;
  const value = checkedDynamicReceiver(lowerer, expr.expression);
  if (!value) return null;
  const name = expr.name.text;
  const found = lowerer.findStaticOn(info, name);
  if (!found) unsupportedStaticPrivate(lowerer, expr, name);
  const read = lowerClassStaticRead(lowerer, info, name, expr.expression, expr);
  if (!read) return null;
  return {
    kind: "seqExpr",
    stmts: [
      staticPrivateBrandCheck(lowerer, info, found.field ? "read" : "method", name, value, loc),
    ],
    result: read,
    type: read.type,
    loc,
  };
}

/** `R.#m(args)` for a static private method on a checked-dynamic receiver:
 * the brand check, then the call with `this` known to be the declaring
 * class. A receiver other than `this` reaches only methods that do not
 * read `this`; the others keep a loud refusal. */
export function lowerStaticPrivateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!ts.isPrivateIdentifier(access.name) || access.questionDotToken) return null;
  const info = staticPrivateOwner(lowerer, access.name);
  if (!info || !info.runtimeStatics) return null;
  if (lowerer.exactClassOfReceiver(access.expression) === info) return null;
  const name = access.name.text;
  const found = lowerer.findStaticOn(info, name);
  if (!found) unsupportedStaticPrivate(lowerer, call, name);
  const value = checkedDynamicReceiver(lowerer, access.expression);
  if (!value) return null;
  const loc = locOf(call);
  if (found.field !== undefined)
    return lowerStaticPrivateFieldCall(lowerer, call, info, name, found.field, value);
  const brand = staticPrivateBrandCheck(lowerer, info, "method", name, value, loc);
  let result: IrExpr | null;
  if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
    // After the check `this` IS the class: lower the call against a
    // class-valued `this`, the exact-receiver static path.
    const classType: IrType = { kind: "classval", className: info.def.name };
    const local = lowerer.declareHiddenLocal("%staticPrivateThis", classType);
    const previous = lowerer.ctx.thisLocal;
    lowerer.ctx.thisLocal = local;
    try {
      result = lowerStaticMethodCall(lowerer, call, access);
    } finally {
      lowerer.ctx.thisLocal = previous;
    }
    if (!result) return null;
    return {
      kind: "seqExpr",
      stmts: [
        brand,
        {
          kind: "varDecl",
          localId: local.id,
          init: lowerer.coerceToExpected(lowerer.classValueRef(info, info.decl!), classType),
          loc,
        },
      ],
      result,
      type: result.type,
      loc,
    };
  }
  if (found.method.member.body && hasStaticThis(found.method.member)) {
    lowerer.unsupported(
      "SC1090",
      call,
      `calling the private static '${name}' through a value other than 'this' when the method reads 'this'`,
    );
  }
  const fnName = `%${found.declarer.def.name}.static:${name}`;
  lowerer.noteEdge(fnName);
  const args = lowerer.completeArgs(call.arguments.nodes, found.method.params, loc, call);
  return {
    kind: "seqExpr",
    stmts: [brand],
    result: { kind: "call", callee: fnName, args, type: found.method.ret, loc },
    type: found.method.ret,
    loc,
  };
}

/** `R.#f(args)` for a function-valued static private field on a
 * checked-dynamic receiver: the receiver, the brand check (PrivateGet's),
 * then a call through the field's value with `this` bound to the receiver,
 * as JavaScript calls a private field's function. The call takes the
 * ordinary call-through-value lanes, so rest parameters, typed rests and
 * checked-dynamic values receive every argument. */
function lowerStaticPrivateFieldCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  info: ClassInfo,
  name: string,
  field: ClassInfo["staticFields"][number],
  value: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const receiver = lowerer.declareHiddenLocal("%staticPrivateReceiver", DYN);
  const lowered = lowerCallThroughValue(
    lowerer,
    call,
    varRef(field.globalId, field.type, loc),
    loc,
  );
  if (lowered.kind !== "callValue" && lowered.kind !== "dynCall") {
    return lowerer.unsupported(
      "SC1090",
      call,
      `this call of the private static field '${name}' (spread arguments)`,
    );
  }
  const result: IrExpr = { ...lowered, receiver: varRef(receiver.id, DYN, loc) };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiver.id, init: value, loc },
      staticPrivateBrandCheck(lowerer, info, "read", name, varRef(receiver.id, DYN, loc), loc),
    ],
    result,
    type: result.type,
    loc,
  };
}

/** `R.#x = v` for a static private field on a checked-dynamic receiver:
 * the receiver, then the value, then the brand check (PrivateSet checks
 * after the right side runs), then the native global. */
export function lowerStaticPrivateAssignment(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const target = expr.left;
  if (
    expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(target) ||
    !ts.isPrivateIdentifier(target.name)
  )
    return null;
  const info = staticPrivateOwner(lowerer, target.name);
  if (!info || !info.runtimeStatics) return null;
  if (lowerer.exactClassOfReceiver(target.expression) === info) return null;
  const name = target.name.text;
  const found = lowerer.findStaticOn(info, name);
  if (!found?.field) unsupportedStaticPrivate(lowerer, expr, name);
  const value = checkedDynamicReceiver(lowerer, target.expression);
  if (!value) return null;
  const loc = locOf(expr);
  const receiver = lowerer.declareHiddenLocal("%staticPrivateReceiver", DYN);
  const assigned = lowerer.declareHiddenLocal("%staticPrivateValue", found.field.type);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiver.id, init: value, loc },
      {
        kind: "varDecl",
        localId: assigned.id,
        init: lowerer.lowerExprExpecting(expr.right, found.field.type),
        loc,
      },
      staticPrivateBrandCheck(lowerer, info, "write", name, varRef(receiver.id, DYN, loc), loc),
      {
        kind: "assign",
        localId: found.field.globalId,
        value: varRef(assigned.id, found.field.type, loc),
        loc,
      },
    ],
    result: varRef(assigned.id, found.field.type, loc),
    type: found.field.type,
    loc,
  };
}

/** The update target of `R.#x++`, `--R.#x` or `R.#x op= v` for a static
 * private field on a checked-dynamic receiver: the brand check, which runs
 * where PrivateGet reads the old value (before the right side), and the
 * field's native global. The write after it needs no second check: the
 * receiver already passed. Null for other targets. */
export function staticPrivateUpdateTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): { brand: IrStmt; target: { id: string; type: IrType } } | null {
  if (!ts.isPrivateIdentifier(access.name) || access.questionDotToken) return null;
  const info = staticPrivateOwner(lowerer, access.name);
  if (!info || !info.runtimeStatics) return null;
  if (lowerer.exactClassOfReceiver(access.expression) === info) return null;
  const name = access.name.text;
  const found = lowerer.findStaticOn(info, name);
  if (!found?.field) unsupportedStaticPrivate(lowerer, access, name);
  const value = checkedDynamicReceiver(lowerer, access.expression);
  if (!value) return null;
  return {
    brand: staticPrivateBrandCheck(lowerer, info, "read", name, value, locOf(access)),
    target: { id: found.field.globalId, type: found.field.type },
  };
}
