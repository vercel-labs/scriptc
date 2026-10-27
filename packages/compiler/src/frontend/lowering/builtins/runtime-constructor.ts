import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { type ClassInfo } from "../lower-classes.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { varRef } from "../../../ir/build.js";
import { BOOL, STRING, type IrExpr, type IrType, type SrcLoc } from "../../../ir/ir.js";

/** `x.constructor` on an instance typed as EventEmitter or a stream class
 * in a TypeScript file: the receiver's runtime ClassInfo, or null. The
 * runtime records each instance's Node class name (EventEmitter, Readable,
 * ReadStream, Gzip, Socket, a program subclass's name), which the
 * lowerings below read with emitter.className. */
export function runtimeConstructorReceiver(
  lowerer: Lowerer,
  expr: ts.Expression,
): { receiver: ts.Expression; info: ClassInfo } | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isPropertyAccessExpression(e) || e.questionDotToken) return null;
  if (e.name.text !== "constructor" || isJsSourceFile(ts.getSourceFileOfNode(e))) return null;
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(e.expression));
  if (mapped?.kind !== "object") return null;
  const info = lowerer.classes.get(mapped.className);
  if (!info?.def.runtime || (!info.builtinEmitter && info.builtinStream === undefined)) return null;
  return { receiver: e.expression, info };
}

/** `x.constructor.name`: the instance's class name. */
export function lowerRuntimeConstructorName(
  lowerer: Lowerer,
  receiver: ts.Expression,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "libCall",
    fn: "emitter.className",
    args: [lowerer.lowerExpr(receiver)],
    type: STRING,
    loc,
  };
}

/** `x.constructor === C` for EventEmitter or a stream class C: true when
 * the instance's own class is C, which needs both the vtable (C's own
 * interval, not a subclass's) and the class name (fs, zlib, crypto, child
 * process and worker streams share the base classes' vtables). */
export function lowerRuntimeConstructorIs(
  lowerer: Lowerer,
  receiver: ts.Expression,
  target: ClassInfo,
  negated: boolean,
  loc: SrcLoc,
): IrExpr {
  const value = lowerer.lowerExpr(receiver);
  const local = lowerer.declareHiddenLocal("%constructorOf", value.type);
  const ref = varRef(local.id, value.type, loc);
  const test = exactClassTest(lowerer, ref, target, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: negated ? { kind: "unary", op: "!", operand: test, type: BOOL, loc } : test,
    type: BOOL,
    loc,
  };
}

/** `x.constructor` as a value: the class object of the instance's own class
 * among EventEmitter and the stream classes, as the receiver's static
 * class's class value. Instances of the other runtime classes (fs, zlib,
 * crypto, child process and worker streams) and of program subclasses
 * report SC1090 at run time. */
export function lowerRuntimeConstructor(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr {
  const loc = locOf(access);
  const resultT: IrType = { kind: "classval", className: info.def.name };
  const value = lowerer.lowerExpr(access.expression);
  const local = lowerer.declareHiddenLocal("%constructorOf", value.type);
  const ref = varRef(local.id, value.type, loc);
  let result: IrExpr = refusalCall(lowerer, resultT, loc);
  for (const candidate of valueClassesUnder(info)) {
    lowerer.defineClassValueConstruct(candidate);
    lowerer.defineClassValueConstruct(info);
    const classRef: IrExpr = {
      kind: "classRef",
      className: candidate.def.name,
      type: { kind: "classval", className: candidate.def.name },
      loc,
    };
    result = {
      kind: "ternary",
      cond: exactClassTest(lowerer, ref, candidate, loc),
      then: candidate === info ? classRef : { kind: "upcast", value: classRef, type: resultT, loc },
      else_: result,
      type: resultT,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result,
    type: resultT,
    loc,
  };
}

/** `info` and its runtime descendants whose values construct. */
function valueClassesUnder(info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  const visit = (c: ClassInfo): void => {
    if (!c.def.runtime) return;
    if (c.valueCtorParams !== undefined) out.push(c);
    for (const s of c.subclasses) visit(s);
  };
  visit(info);
  return out;
}

/** The instance is of class `target` itself: inside its interval, outside
 * each direct subclass's (runtime or program), and named as it. */
function exactClassTest(lowerer: Lowerer, ref: IrExpr, target: ClassInfo, loc: SrcLoc): IrExpr {
  let test: IrExpr = {
    kind: "instanceOf",
    value: ref,
    className: target.def.name,
    type: BOOL,
    loc,
  };
  for (const sub of target.subclasses) {
    test = {
      kind: "logical",
      op: "&&",
      left: test,
      right: {
        kind: "unary",
        op: "!",
        operand: { kind: "instanceOf", value: ref, className: sub.def.name, type: BOOL, loc },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  const name: IrExpr = {
    kind: "strEq",
    negated: false,
    left: { kind: "libCall", fn: "emitter.className", args: [ref], type: STRING, loc },
    right: { kind: "strLit", value: target.def.name.slice(1), type: STRING, loc },
    type: BOOL,
    loc,
  };
  return { kind: "logical", op: "&&", left: test, right: name, type: BOOL, loc };
}

/** The run-time refusal for an instance whose class has no class value. */
function refusalCall(lowerer: Lowerer, type: IrType, loc: SrcLoc): IrExpr {
  const name = `%constructor.refusal:${type.kind === "classval" ? type.className : ""}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: type,
      body: [
        {
          kind: "runtimeFence",
          code: "SC1090",
          message:
            "reading 'constructor' of an fs, zlib, crypto, child process or worker stream, or of an instance of a program subclass of EventEmitter or a stream class, is not supported yet",
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [], type, loc };
}
