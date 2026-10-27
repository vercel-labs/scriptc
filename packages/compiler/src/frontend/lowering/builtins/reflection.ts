import { varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { builtinModuleFnOf } from "../surfaces.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  STRING,
  type SrcLoc,
  arrayOf,
  isUnitType,
} from "../../../ir/ir.js";

/** The function value of the Reflect member `member` (ownKeys, on native
 * computed-key reflection), or null for members without one. */
export function reflectMemberValue(lowerer: Lowerer, member: string, loc: SrcLoc): IrExpr | null {
  if (member !== "ownKeys") return null;
  const value = lowerer.lowerNativeCallableValue(
    {
      fn: "dyn.ownKeys",
      params: [DYN],
      result: DYN,
      valueParams: [{ mode: "required", type: DYN }],
    },
    "Reflect.ownKeys",
    loc,
  )!;
  return { kind: "dynFrom", value, fnName: "ownKeys", type: DYN, loc };
}

/** Reflect.ownKeys uses native computed-key reflection. Reflect.apply(target,
 * thisArg, argsList) where the TARGET is a builtin
 * rest-parameter table fn (path.join / path.resolve — test/common
 * fixtures.js's fixturesPath forwards its rest args exactly this way):
 * the packed libCall over a validated string[] extraction of argsList.
 * The builtins ignore the receiver, so thisArg must be an effect-free
 * spelling (`this`, an identifier, a unit literal) whose dropped
 * evaluation is unobservable; every other Reflect.apply keeps the
 * fence. Null when this isn't a supported Reflect call. */
export function lowerReflectCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    !call.questionDotToken &&
    !access.questionDotToken &&
    lowerer.stdlibGlobalMember(access, "Reflect") === "ownKeys" &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    return {
      kind: "libCall",
      fn: "dyn.ownKeys",
      args: [lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN)],
      type: DYN,
      loc: locOf(call),
    };
  }
  if (call.questionDotToken) return null;
  const reflectMember = lowerer.stdlibGlobalMember(access, "Reflect");
  // Reflect.getOwnPropertyDescriptor and Reflect.defineProperty over
  // checked objects (execa's Promise mixin): the Object operations, with
  // defineProperty answering true. A non-object target throws the Object
  // operation's TypeError.
  if (
    (reflectMember === "getOwnPropertyDescriptor" && call.arguments.nodes.length === 2) ||
    (reflectMember === "defineProperty" && call.arguments.nodes.length === 3)
  ) {
    if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
    const loc = locOf(call);
    const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    if (reflectMember === "getOwnPropertyDescriptor")
      return { kind: "libCall", fn: "dyn.getOwnPropertyDescriptor", args, type: DYN, loc };
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.defineProperty", args, type: DYN, loc },
          loc,
        },
      ],
      result: { kind: "boolLit", value: true, type: BOOL, loc },
      type: BOOL,
      loc,
    };
  }
  // Reflect.deleteProperty over a value with a live property table: a
  // checked-dynamic value, or a JavaScript class whose statics are runtime
  // properties of its constructor
  // (`Reflect.deleteProperty(Response, "getResponseState")`).
  if (
    reflectMember === "deleteProperty" &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const loc = locOf(call);
    let target = lowerer.lowerExpr(call.arguments.nodes[0]!);
    const info =
      target.type.kind === "classval" ? lowerer.classes.get(target.type.className) : undefined;
    // A primitive target throws the TypeError, so it boxes as is.
    const primitive =
      isUnitType(target.type) ||
      ["bool", "f64", "string", "bigint", "symbol"].includes(target.type.kind);
    if (
      primitive ||
      (info !== undefined && hasRuntimeStatics(info) && lowerer.dynConvertible(target.type))
    )
      target = lowerer.coerceToExpected(target, DYN);
    if (target.type.kind !== "dyn") return null;
    return {
      kind: "libCall",
      fn: "dyn.reflectDeleteProperty",
      args: [target, lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN)],
      type: BOOL,
      loc,
    };
  }
  if (reflectMember === "get" || reflectMember === "set") {
    const required = reflectMember === "get" ? 2 : 3;
    if (
      call.arguments.nodes.length < required ||
      call.arguments.nodes.length > required + 1 ||
      call.arguments.nodes.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        `Reflect.${reflectMember} with this argument shape`,
        call,
        `use Reflect.${reflectMember}(target, key${reflectMember === "set" ? ", value" : ""}, receiver?)`,
      );
    }
    const loc = locOf(call);
    const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    const target =
      call.arguments.nodes.length === required
        ? lowerer.declareHiddenLocal("%reflectTarget", DYN)
        : null;
    const operation: IrExpr = {
      kind: "libCall",
      fn: reflectMember === "get" ? "dyn.reflectGet" : "dyn.reflectSet",
      args: target
        ? [varRef(target.id, DYN, loc), ...args.slice(1), varRef(target.id, DYN, loc)]
        : args,
      type: reflectMember === "get" ? DYN : BOOL,
      loc,
    };
    return target
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: target.id, init: args[0]!, loc }],
          result: operation,
          type: operation.type,
          loc,
        }
      : operation;
  }
  if (lowerer.stdlibGlobalMember(access, "Reflect") !== "apply") return null;
  const loc = locOf(call);
  const fenceHint =
    "the lowered form is Reflect.apply(path.join | path.resolve, <effect-free this>, args) — call other functions directly (f(...args))";
  if (call.arguments.nodes.length !== 3 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering("Reflect.apply with this argument shape", call, fenceHint);
  }
  const targetNode = call.arguments.nodes[0]!;
  const bi = ts.isPropertyAccessExpression(targetNode) ? lowerer.builtinMemberOf(targetNode) : null;
  const fn = bi ? builtinModuleFnOf(lowerer, bi.module, bi.member) : null;
  if (!fn || fn.variadicPack !== true) {
    const target = lowerer.lowerExprExpecting(targetNode, DYN);
    const receiver = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
    const argumentsList = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, DYN);
    return {
      kind: "libCall",
      fn: "dyn.reflectApply",
      args: [target, receiver, argumentsList],
      type: DYN,
      loc,
    };
  }
  const thisNode = call.arguments.nodes[1]!;
  const effectFree =
    thisNode.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isIdentifier(thisNode) ||
    thisNode.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(thisNode) && thisNode.text === "undefined");
  if (!effectFree) {
    lowerer.noLowering(
      "Reflect.apply with a computed thisArg",
      thisNode,
      "the target ignores its receiver, so only effect-free spellings drop honestly (`this`, a binding, null, undefined)",
    );
  }
  const packed = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, arrayOf(STRING));
  return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
}
