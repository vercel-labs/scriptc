import * as ts from "../../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { unitOnlyUnion } from "../../type-mapper.js";
import { varRef } from "../../../ir/build.js";
import { nativeRecordIntegrityEligible } from "../../../ir/native-integrity.js";
import { classNativeIntegrityEligible } from "../lower-classes.js";
import { everyStmtList } from "../../../ir/traverse.js";
import { noLoweringDiag } from "../../../diagnostics/diagnostic.js";
import {
  BOOL,
  DYN,
  UNDEFINED_T,
  VOID,
  isUnitType,
  funcOf,
  type SrcLoc,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";

const OPERATIONS = {
  freeze: "dyn.freeze",
  seal: "dyn.seal",
  preventExtensions: "dyn.preventExtensions",
  isFrozen: "dyn.isFrozen",
  isSealed: "dyn.isSealed",
  isExtensible: "dyn.isExtensible",
} as const;

export type ObjectIntegrityMember = keyof typeof OPERATIONS;

export function isObjectIntegrityMember(member: string | null): member is ObjectIntegrityMember {
  return member !== null && Object.hasOwn(OPERATIONS, member);
}

/** Local subclasses can appear after an earlier call lowered. Revalidate
 * against the settled bag owner so a late symbol family gets the frontend
 * refusal, never an unsupported intrinsic handed to the backend. */
export function validateObjectIntegrityOwners(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): void {
  for (const fn of functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind !== "intrinsic" || !expr.name.startsWith("native.")) return true;
        const member = expr.name.slice("native.".length),
          receiver = expr.args[0]?.type;
        if (
          isObjectIntegrityMember(member) &&
          receiver?.kind === "object" &&
          !lowerer.classes.get(receiver.className)?.def.nativePropertyBagHelper
        )
          lowerer.pushDiag(
            noLoweringDiag(
              `Object.${member} of '${lowerer.fmt(receiver)}'`,
              expr.loc,
              "this native value has no admitted integrity owner",
            ),
          );
        return true;
      },
    });
}

/** Resolve immutable provenance without erasing the lexical binding. Forward
 * captures and imports need the projection before their declaration lowers. */
export function objectIntegrityAliasOf(
  lowerer: Lowerer,
  ident: ts.Identifier,
  seen = new Set<ts.Symbol>(),
): ObjectIntegrityMember | null {
  const symbol = lowerer.resolveValueSymbol(ident);
  if (!symbol || seen.has(symbol)) return null;
  const known = lowerer.staticCallables.get(symbol);
  if (known?.kind === "object-integrity") return known.member;
  seen.add(symbol);
  const decl = lowerer.checker.valueDeclarationOf(symbol);
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    !decl.initializer ||
    !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) ||
    lowerer.checker.getCallSignatures(lowerer.typeOf(decl.name)).length === 0
  )
    return null;
  let init = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  const member = ts.isPropertyAccessExpression(init)
    ? lowerer.stdlibGlobalMember(init, "Object")
    : ts.isIdentifier(init)
      ? objectIntegrityAliasOf(lowerer, init, seen)
      : null;
  if (!isObjectIntegrityMember(member)) return null;
  lowerer.staticCallables.set(symbol, { kind: "object-integrity", member });
  return member;
}

export function objectIntegrityCallableType(member: ObjectIntegrityMember): IrType {
  return funcOf([DYN], member.startsWith("is") ? BOOL : DYN);
}

/** Share the lowering's proven callable provenance with the identity census;
 * no expression executes while storage types are being collected. */
export function objectIntegrityIdentitySource(
  lowerer: Lowerer,
  call: ts.CallExpression,
): ts.Expression | undefined {
  // The census visits unreachable calls too. Like ownsFfiCall, probe
  // provenance without flushing deferred diagnostics or namespace fences.
  const wasCollecting = lowerer.collecting;
  lowerer.collecting = true;
  try {
    const callee = call.expression;
    const member = ts.isPropertyAccessExpression(callee)
      ? lowerer.stdlibGlobalMember(callee, "Object")
      : ts.isIdentifier(callee)
        ? objectIntegrityAliasOf(lowerer, callee)
        : null;
    return member === "freeze" || member === "seal" || member === "preventExtensions"
      ? call.arguments[0]
      : undefined;
  } finally {
    lowerer.collecting = wasCollecting;
  }
}

function objectIntegrityCallableValue(
  lowerer: Lowerer,
  member: ObjectIntegrityMember,
  loc: SrcLoc,
): IrExpr {
  // These private bindings carry initialization/identity. Escaping values
  // still require explicit admission in OBJECT_CALLABLE_VALUES.
  return lowerer.lowerNativeCallableValue(
    {
      fn: OPERATIONS[member],
      params: [DYN],
      result: member.startsWith("is") ? BOOL : DYN,
      valueParams: [{ mode: "required", type: DYN }],
    },
    `Object.${member}`,
    loc,
  )!;
}

export function objectIntegrityAliasRead(lowerer: Lowerer, ident: ts.Identifier): IrExpr {
  const binding = lowerer.resolveLocal(ident) ?? lowerer.globalOf(ident);
  if (!binding)
    lowerer.noLowering("an Object integrity alias outside its initialized scope", ident);
  const loc = locOf(ident);
  const read = lowerer.declareHiddenLocal("%integrity.callable", binding.type);
  // Type-based folds such as typeof may discard a bare varRef. The
  // initialization statement keeps the binding's mandatory TDZ read.
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: read.id, init: varRef(binding.id, binding.type, loc), loc },
    ],
    result: varRef(read.id, binding.type, loc),
    type: binding.type,
    loc,
  };
}

export function lowerObjectIntegrityAliasDecl(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  member: ObjectIntegrityMember,
): IrStmt {
  if (!ts.isIdentifier(decl.name))
    lowerer.noLowering("destructured Object integrity aliases", decl);
  const loc = locOf(decl);
  let source = decl.initializer!;
  while (ts.isParenthesizedExpression(source)) source = source.expression;
  const init = ts.isIdentifier(source)
    ? objectIntegrityAliasRead(lowerer, source)
    : objectIntegrityCallableValue(lowerer, member, loc);
  const global = lowerer.globalOf(decl.name);
  if (global) return { kind: "assign", localId: global.id, value: init, initializes: true, loc };
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name)!;
  const pre = lowerer.ctx.tdzPredeclared.get(symbol);
  if (pre) {
    lowerer.ctx.tdzPredeclared.delete(symbol);
    return { kind: "assign", localId: pre.id, value: init, initializes: true, loc };
  }
  const local = lowerer.declareLocal(decl.name, decl.name.text, init.type, false);
  return { kind: "varDecl", localId: local.id, init, loc };
}

/** Direct calls and immutable aliases keep the native operand's type and
 * identity. Argument effects precede boxing: creating a live view can
 * promote properties and must not run before later argument callbacks. */
export function lowerObjectIntegrityCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: ObjectIntegrityMember,
): IrExpr {
  if (call.arguments.some(ts.isSpreadElement))
    lowerer.noLowering(`Object.${member} with spread arguments`, call);
  const loc = locOf(call);
  const argNode = call.arguments[0];
  let inner = argNode;
  while (inner && (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner)))
    inner = inner.expression;
  let value: IrExpr = !argNode
    ? { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }
    : member === "freeze" &&
        isJsSourceFile(call.getSourceFile()) &&
        inner &&
        (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner))
      ? lowerer.lowerExprExpecting(argNode, DYN)
      : lowerer.lowerExpr(argNode);
  const predicate = member === "isFrozen" || member === "isSealed" || member === "isExtensible";
  const primitive = (type: IrType): boolean =>
    isUnitType(type) || ["void", "string", "f64", "bool", "symbol", "bigint"].includes(type.kind);
  const allPrimitive =
    primitive(value.type) ||
    (value.type.kind === "union" &&
      (lowerer.unions.get(value.type.unionId)?.arms.every(primitive) ?? false));
  if (
    allPrimitive &&
    !predicate &&
    value.type.kind !== "void" &&
    call.arguments.length <= 1 &&
    !ts.isIdentifier(call.expression)
  )
    return value;
  // Bare units have no storage representation. Use the same union as
  // ordinary null/undefined bindings, preserving a void producer's effects.
  if (isUnitType(value.type) || value.type.kind === "void")
    value = lowerer.coerceToExpected(value, unitOnlyUnion(lowerer.unions));
  const slot = lowerer.declareHiddenLocal("%integrity.target", value.type);
  const saved = varRef(slot.id, value.type, loc);
  const stmts: IrStmt[] = [];
  // Reading the callable precedes arguments, including TDZ checks. The
  // runtime binding stays observable even though the call is specialized.
  if (ts.isIdentifier(call.expression))
    stmts.push({ kind: "exprStmt", expr: objectIntegrityAliasRead(lowerer, call.expression), loc });
  stmts.push({ kind: "varDecl", localId: slot.id, init: value, loc });
  for (const extra of call.arguments.slice(1)) {
    const expr = lowerer.lowerExpr(extra);
    if (expr.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr, loc: expr.loc });
  }
  let result: IrExpr;
  if (allPrimitive) {
    result = predicate
      ? { kind: "boolLit", value: member !== "isExtensible", type: BOOL, loc }
      : saved;
  } else {
    const shape = value.type.kind === "record" ? lowerer.shapes.get(value.type.shapeId) : null;
    const cls = value.type.kind === "object" ? lowerer.classes.get(value.type.className) : null;
    let operation: IrExpr;
    if (
      (shape && nativeRecordIntegrityEligible(shape)) ||
      (cls && classNativeIntegrityEligible(cls))
    ) {
      operation = {
        kind: "intrinsic",
        name: `native.${member}`,
        args: [saved],
        type: predicate ? BOOL : VOID,
        loc,
      };
    } else {
      const checked =
        value.type.kind === "dyn"
          ? saved
          : value.type.kind === "array" || member === "isFrozen"
            ? lowerer.coerceToExpected(saved, DYN)
            : saved;
      if (checked.type.kind !== "dyn")
        lowerer.noLowering(
          `Object.${member} of '${lowerer.fmt(value.type)}'`,
          call,
          "this native value has no admitted integrity owner",
        );
      operation = {
        kind: "libCall",
        fn: OPERATIONS[member],
        args: [checked],
        type: predicate ? BOOL : DYN,
        loc,
      };
    }
    if (predicate) result = operation;
    else {
      // Dynamic mutators return a retained capsule; discard it while the
      // saved typed receiver preserves the call's original return identity.
      stmts.push({ kind: "exprStmt", expr: operation, loc });
      result = saved;
    }
  }
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}
