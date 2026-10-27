import { numLit } from "../../../ir/build.js";
import {
  BOOL,
  DYN,
  RUNTIME_EMITTER_CLASS,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
} from "../../../ir/ir.js";
import * as ts from "../../ts7/adapter.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import type { ClassInfo } from "../lower-classes.js";
import { classInstanceOf } from "../class-dynamic-dispatch.js";
import { isSafeToDiscard, isSafeToRepeat } from "../expressions/evaluation-safety.js";

/* EventEmitter and the stream classes as untyped constructor values, the
 * bases of JavaScript constructor functions:
 *
 *   function Bus() { EventEmitter.call(this); }
 *   util.inherits(Bus, EventEmitter);
 *
 * A compiled `class Bus extends EventEmitter` gets a native emitter prefix,
 * but `new Bus()` on a constructor function builds an untyped object, so
 * the base is the runtime's dyn constructor (scr_dyn_builtin_class.c): a
 * function whose prototype carries Node's EventEmitter methods over the
 * object's own `_events` table. The stream classes have prototype chains
 * for util.inherits and instanceof; constructing over them refuses where
 * it runs. These values appear only where a constructor function uses its
 * base: util.inherits, `Base.call(this, …)` and `Base.apply(this, …)`,
 * `Base.prototype` and `instanceof Base` on an untyped value. */

/** scr_dyn_builtin_class's kind for a runtime class, or null. */
export function builtinClassKind(className: string): number | null {
  switch (className) {
    case RUNTIME_EMITTER_CLASS:
      return 0;
    case "%Readable":
      return 2;
    case "%Writable":
      return 3;
    case "%Duplex":
      return 4;
    case "%Transform":
      return 5;
    case "%PassThrough":
      return 6;
    default:
      return null;
  }
}

/** The classes by builtin module member. JavaScript sources bind
 * `require("events").EventEmitter` as a module member rather than a class
 * value, and `require("stream")` is the legacy Stream constructor. */
const MODULE_CLASS_KINDS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  events: { EventEmitter: 0, default: 0 },
  stream: { Stream: 1, Readable: 2, Writable: 3, Duplex: 4, Transform: 5, PassThrough: 6 },
};

/** The kind of a builtin module member that is one of those classes. */
export function builtinMemberClassKind(module: string, member: string): number | null {
  return MODULE_CLASS_KINDS[module]?.[member] ?? null;
}

function unparenthesized(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** The kind of a node that names one of those classes: a class value, a
 * builtin module member, or the events and stream modules themselves. */
export function builtinClassKindOf(lowerer: Lowerer, node: ts.Expression): number | null {
  const expr = unparenthesized(node);
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (mapped?.kind === "classval") return builtinClassKind(mapped.className);
  const member = ts.isIdentifier(expr)
    ? lowerer.builtinImportOf(expr)
    : ts.isPropertyAccessExpression(expr)
      ? lowerer.builtinMemberOf(expr)
      : null;
  if (member) return MODULE_CLASS_KINDS[member.module]?.[member.member] ?? null;
  const module = lowerer.builtinNamespaceModuleOf(expr);
  return module === "events" ? 0 : module === "stream" ? 1 : null;
}

/** Whether evaluating the node can be skipped: a binding or a member of
 * one, or of a builtin require. */
function referenceOnly(node: ts.Expression): boolean {
  const expr = unparenthesized(node);
  if (ts.isIdentifier(expr)) return true;
  if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
    const base = unparenthesized(expr.expression);
    return (
      ts.isIdentifier(base) ||
      (ts.isCallExpression(base) &&
        ts.isIdentifier(base.expression) &&
        base.expression.text === "require" &&
        base.arguments.nodes.length === 1 &&
        ts.isStringLiteral(base.arguments.nodes[0]!))
    );
  }
  return false;
}

/** The untyped constructor named by a node, or null when it names none of
 * those classes. */
export function builtinClassDynValueOf(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const kind = builtinClassKindOf(lowerer, node);
  if (kind === null) return null;
  const loc = locOf(node);
  const value = builtinClassValue(kind, loc);
  if (referenceOnly(node)) return value;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(node), loc }],
    result: value,
    type: DYN,
    loc,
  };
}

/** EventEmitter and the legacy Stream are dyn.builtinClass; the stream
 * classes, which carry native stream state for constructor functions, are
 * dyn.builtinStreamClass, so only programs that use them link the stream
 * half. */
export function builtinClassValue(kind: number, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: kind <= 1 ? "dyn.builtinClass" : "dyn.builtinStreamClass",
    args: [numLit(kind, loc)],
    type: DYN,
    loc,
  };
}

/** `Base.call(this, …)` / `Base.apply(this, args)` on one of those class
 * values: Function.prototype.call/apply over the untyped constructor. */
export function lowerBuiltinClassCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return null;
  const method = callee.name.text;
  if (method !== "call" && method !== "apply") return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const receiver = builtinClassDynValueOf(lowerer, callee.expression);
  if (receiver === null) return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv: receiver,
    method,
    calleeName: ts.getTextOfNode(callee),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** `value instanceof Base` for an untyped value. */
export function builtinClassInstanceOf(value: IrExpr, kind: number, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "dyn.builtinInstanceOf",
    args: [value, numLit(kind, loc)],
    type: BOOL,
    loc,
  };
}

/** `value instanceof Base` for an untyped value that may also hold a
 * compiled instance: an object built by a constructor function inherits
 * the untyped constructor's prototype, and an instance of a program class
 * extending Base boxes as a typed reference the class test recognizes.
 * With `callee`, the right-hand side is an untyped value and the class
 * test applies only when it is Base's untyped constructor. */
export function builtinClassInstanceOfAny(
  lowerer: Lowerer,
  value: IrExpr,
  kind: number,
  info: ClassInfo,
  loc: SrcLoc,
  callee?: IrExpr,
): IrExpr {
  const stmts: IrStmt[] = [];
  const once = (expr: IrExpr, name: string, snapshot = false): IrExpr => {
    if (!snapshot && isSafeToRepeat(expr)) return expr;
    const local = lowerer.declareHiddenLocal(name, DYN);
    stmts.push({ kind: "varDecl", localId: local.id, init: expr, loc });
    return { kind: "varRef", localId: local.id, type: DYN, loc };
  };
  // The left operand evaluates first: a variable read keeps its value in
  // a local when the right-hand side can assign the variable.
  const tested = once(value, "%instanceValue", callee !== undefined && !isSafeToDiscard(callee));
  const ctor = callee ? once(callee, "%instanceCallee") : null;
  const compiled = classInstanceOf(lowerer, tested, info, loc);
  const result: IrExpr = {
    kind: "logical",
    op: "||",
    left: ctor
      ? { kind: "libCall", fn: "dyn.functionInstanceOf", args: [tested, ctor], type: BOOL, loc }
      : builtinClassInstanceOf(tested, kind, loc),
    right: ctor
      ? {
          kind: "logical",
          op: "&&",
          left: {
            kind: "dynScalarEq",
            left: ctor,
            right: builtinClassValue(kind, loc),
            type: BOOL,
            loc,
          },
          right: compiled,
          type: BOOL,
          loc,
        }
      : compiled,
    type: BOOL,
    loc,
  };
  return stmts.length ? { kind: "seqExpr", stmts, result, type: BOOL, loc } : result;
}
