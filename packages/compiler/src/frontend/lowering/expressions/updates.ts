/* Increment, decrement and prefix unary operators, and compound field updates. */
import {
  indexedUnionArms,
  lowerIndexedUnionNumberRead,
  lowerIndexedUnionWrite,
} from "../indexed-unions.js";
import * as ts from "../../ts7/adapter.js";
import {
  lowerOptionalIndex,
  splitUndefinedIndex,
  undefinedTypedArrayKeyFence,
} from "../undefined-index.js";
import { isStrictCode } from "../strict-mode.js";
import { isPrivateWriteReceiver } from "../private-brands.js";
import type { Lowerer } from "../lowerer.js";
import {
  type FieldTarget,
  bigintCompoundValue,
  compoundUnsupported,
  concatOperand,
  deferredSlotOr,
  dynCompoundValue,
  lowerOptionalNumber,
  operatorUnsupported,
  runtimeOptionalStorageOperand,
  symbolFieldTarget,
} from "../lower-exprs.js";
import {
  BIGINT_T,
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  isUnitType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
} from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { classToNumberConversion } from "../class-to-primitive.js";
import { lowerPrimitiveUnionNumber } from "../lower-calls.js";
import { dynUndefinedExpr, nodeThrowExpr, numLit, varRef } from "../../../ir/build.js";
import { fenceNodeModuleMutation } from "../lower-node-module.js";
import { staticFieldWriteTarget } from "../lower-classes.js";
import { expandoWritableTarget } from "../lower-expando.js";
import { nsWritableTarget } from "../lower-namespaces.js";
import { arrayNumberRead, arrayValueRead, arrayValueStore } from "../array-values.js";
import { isSafeToRepeat } from "./evaluation-safety.js";
import { errorPropertyWrite } from "../error-methods.js";
import type { CompoundOp } from "../surfaces.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { declareContextLocal } from "../function-context.js";
import { keyedFieldTarget, keyedFieldWrite, saveKeyedFieldKey } from "./keyed-field-targets.js";

/** Read-modify-write updates read the member first: an unassigned
 * deferred-init receiver throws Node's member-read TypeError. */
function checkDeferredMemberReceiver(
  lowerer: Lowerer,
  target: FieldTarget,
  access: ts.Expression,
): void {
  if (
    target.container !== "class" ||
    !ts.isPropertyAccessExpression(access) ||
    target.obj.type.kind !== "object" ||
    lowerer.deferredFieldSlot(target.obj) === null
  )
    return;
  target.obj =
    lowerer.runtimeOptionalPropertyReceiver(
      access.expression,
      target.obj,
      target.obj.type,
      target.field,
    ) ?? target.obj;
}

/** Whether evaluating `expr` cannot store anything or run other code:
 * reads, arithmetic, tests and checked extractions (which at most throw). */
function writeFree(expr: IrExpr): boolean {
  switch (expr.kind) {
    case "numLit":
    case "strLit":
    case "boolLit":
    case "unitLit":
    case "varRef":
      return true;
    case "fieldGet":
    case "recordGet":
      return writeFree(expr.obj);
    case "bin":
    case "logical":
      return writeFree(expr.left) && writeFree(expr.right);
    case "unary":
    case "toBool":
      return writeFree(expr.operand);
    case "ternary":
      return writeFree(expr.cond) && writeFree(expr.then) && writeFree(expr.else_);
    case "unionIsTag":
    case "unionNarrow":
    case "unionWrap":
      return writeFree(expr.value);
    case "libCall":
      return expr.fn === "error.nodeThrow";
    default:
      return false;
  }
}

/** A union unary `+`/`-` converts with the runtime's ToNumber: one with an
 * arm other than numbers and units (`string | undefined`). Number and unit
 * unions keep their native lowering. */
function coercedUnion(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind !== "union" || !lowerer.dynConvertible(type)) return false;
  const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
  return arms.some((arm) => arm.kind !== "f64" && !isUnitType(arm));
}

/** ToNumber of a Date: its time value (valueOf, the number hint). */
function dateTimeValue(date: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "date.valueOf", args: [date], type: F64, loc };
}

/** ToNumber of a boolean: 1 for true, 0 for false. */
function booleanToNumber(value: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "ternary",
    cond: value,
    then: { kind: "numLit", value: 1, type: F64, loc },
    else_: { kind: "numLit", value: 0, type: F64, loc },
    type: F64,
    loc,
  };
}

export function lowerPrefixUnary(lowerer: Lowerer, expr: ts.PrefixUnaryExpression): IrExpr {
  const loc = locOf(expr);
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const raw = lowerer.lowerExpr(expr.operand);

      if (raw.type.kind === "bigint") {
        return { kind: "libCall", fn: "bigint.neg", args: [raw], type: BIGINT_T, loc };
      }
      // Match the checked numeric boundary used by JS binary arithmetic.
      const operand =
        raw.type.kind === "bool"
          ? booleanToNumber(raw, loc)
          : raw.type.kind === "date"
            ? dateTimeValue(raw, loc)
            : coercedUnion(lowerer, raw.type)
              ? ({
                  kind: "libCall",
                  fn: "dyn.toNumberCoerce",
                  args: [{ kind: "dynFrom", value: raw, type: DYN, loc }],
                  type: F64,
                  loc,
                } satisfies IrExpr)
              : raw.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(expr))
                ? ({
                    kind: "libCall",
                    fn: "dyn.toNumberCoerce",
                    args: [raw],
                    type: F64,
                    loc,
                  } satisfies IrExpr)
                : lowerOptionalNumber(lowerer, raw, loc, expr.operand);
      if (operand.type.kind !== "f64") operatorUnsupported(lowerer, expr, "-", [raw.type]);
      if (operand.kind === "numLit") return { ...operand, value: -operand.value, loc };
      return { kind: "unary", op: "-", operand, type: F64, loc };
    }
    case ts.SyntaxKind.PlusToken: {
      const raw = lowerer.lowerExpr(expr.operand);
      if (raw.type.kind === "dyn") {
        return { kind: "libCall", fn: "dyn.toNumberCoerce", args: [raw], type: F64, loc };
      }
      // A union of primitives (`+match[1]` over `string | undefined`): ToNumber
      // over the boxed value, as for a checked-dynamic operand.
      if (coercedUnion(lowerer, raw.type)) {
        const boxed: IrExpr = { kind: "dynFrom", value: raw, type: DYN, loc };
        return { kind: "libCall", fn: "dyn.toNumberCoerce", args: [boxed], type: F64, loc };
      }
      // Unary + is ToNumber; on an already-number operand it's identity,
      // and a STRING operand runs the runtime's ECMA-exact StringToNumber
      // (num.fromString — Number(aString)'s lowering, scr_string.c).

      if (raw.type.kind === "string") {
        return { kind: "libCall", fn: "num.fromString", args: [raw], type: F64, loc };
      }
      if (raw.type.kind === "bool") return booleanToNumber(raw, loc);
      // A Date's number hint answers its time value.
      if (raw.type.kind === "date") return dateTimeValue(raw, loc);
      const classNumber = classToNumberConversion(lowerer, raw, expr.operand, "unary plus");
      if (classNumber) return classNumber;
      const operand = lowerOptionalNumber(lowerer, raw, loc, expr.operand);
      if (operand.type.kind === "f64") return operand;
      // `+process.argv[2]`: a `string | undefined` (or other primitive
      // union) converts as Number(value) does.
      const unionNumber = lowerPrimitiveUnionNumber(lowerer, raw, expr.operand, loc);
      if (unionNumber) return unionNumber;
      operatorUnsupported(lowerer, expr, "+", [raw.type]);
    }
    case ts.SyntaxKind.ExclamationToken: {
      // `!runtimeBuffer` over an alias of the Buffer global: Node always
      // defines Buffer (the condition twin is lowerCondition's).
      if (lowerer.isStdlibGlobal(expr.operand, "Buffer"))
        return { kind: "boolLit", value: false, type: BOOL, loc };
      // `!x` is ToBoolean-then-negate: f64/string operands go through toBool.
      const operand = lowerer.ensureBool(
        deferredSlotOr(
          lowerer,
          runtimeOptionalStorageOperand(lowerer, expr.operand) ?? lowerer.lowerExpr(expr.operand),
        ),
        expr.operand,
      );
      return { kind: "unary", op: "!", operand, type: BOOL, loc };
    }
    case ts.SyntaxKind.TildeToken: {
      // `~x`: ToInt32, complement, back to f64 (JS-exact, incl. NaN → -1).
      const raw = lowerer.lowerExpr(expr.operand);
      if (raw.type.kind === "bigint") {
        return { kind: "libCall", fn: "bigint.not", args: [raw], type: BIGINT_T, loc };
      }
      if (raw.type.kind === "dyn")
        return {
          kind: "libCall",
          fn: "dyn.bitwise",
          args: [raw, dynUndefinedExpr(loc), { kind: "strLit", value: "~", type: STRING, loc }],
          type: DYN,
          loc,
        };
      // A checked-dynamic value retains enough JavaScript structure to
      // run exact ToNumber, including the object valueOf/toString
      // protocol. This is the static `any`/JS-lane answer for idioms
      // such as `while (~index)`, where inference may have widened an
      // otherwise numeric slot to the checked-dynamic tree.
      const operand = lowerOptionalNumber(lowerer, raw, loc, expr.operand);
      if (operand.type.kind !== "f64") operatorUnsupported(lowerer, expr, "~", [raw.type]);
      return { kind: "unary", op: "~", operand, type: F64, loc };
    }
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
      // `++x` / `--x` in expression position: yields the NEW value.
      return lowerIncDec(lowerer, expr, true);
  }
  lowerer.unsupported("SC1090", expr, `syntax '${ts.syntaxKindName(expr.kind)}'`);
}

/** Member updates evaluate the reference once, convert its old value with
 * ToNumeric, store the new value, then yield the old or new numeric value. */
export function lowerIncDec(
  lowerer: Lowerer,
  expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  prefix: boolean,
): IrExpr {
  const loc = locOf(expr);
  const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
  if (!ts.isIdentifier(expr.operand)) {
    const access = expr.operand;
    if (
      (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
      access.questionDotToken
    ) {
      lowerer.unsupported("SC1045", expr, "increment/decrement of this target");
    }
    fenceNodeModuleMutation(lowerer, access, "assignment");
    if (ts.isPropertyAccessExpression(access)) {
      const target =
        staticFieldWriteTarget(lowerer, access) ??
        expandoWritableTarget(lowerer, access) ??
        nsWritableTarget(lowerer, access);
      if (target) {
        return lowerIncDecTarget(lowerer, expr, target, prefix);
      }
    }
    const stmts: IrStmt[] = [];
    const save = (value: IrExpr, name: string): IrExpr => {
      const local = lowerer.declareHiddenLocal(name, value.type);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      return varRef(local.id, value.type, loc);
    };
    const finish = (read: IrExpr, write: (value: IrExpr) => IrStmt): IrExpr => {
      if (read.type.kind === "bigint") {
        const old = save(read, "%incrementOld");
        const next = save(bigintStep(op, old, loc), "%incrementNext");
        stmts.push(write(next));
        const result = prefix ? next : old;
        return { kind: "seqExpr", stmts, result, type: result.type, loc };
      }
      const old = save(
        read.type.kind === "f64"
          ? read
          : {
              kind: "libCall",
              fn: "dyn.toNumeric",
              args: [lowerer.coerceInto(access, read, DYN)],
              type: DYN,
              loc,
            },
        "%incrementOld",
      );
      const next = save(
        old.type.kind === "f64"
          ? {
              kind: "bin",
              op,
              left: old,
              right: { kind: "numLit", value: 1, type: F64, loc },
              type: F64,
              loc,
            }
          : {
              kind: "libCall",
              fn: "dyn.increment",
              args: [old, { kind: "boolLit", value: op === "+", type: BOOL, loc }],
              type: DYN,
              loc,
            },
        "%incrementNext",
      );
      stmts.push(write(next));
      const result = prefix ? next : old;
      return { kind: "seqExpr", stmts, result, type: result.type, loc };
    };
    const raw = lowerer.lowerExpr(access.expression);
    // Keep native array/byte storage: boxing a native array can create a
    // checked view, which is not a substitute for updating its slot.
    if (
      ts.isElementAccessExpression(access) &&
      (raw.type.kind === "array" || raw.type.kind === "bytes")
    ) {
      const receiver = save(raw, "%incrementArray");
      // An undefined index names the "undefined" property
      // (undefined-index.ts), which a typed array cannot hold.
      const loweredIndex = lowerer.lowerExpr(access.argumentExpression);
      const split =
        raw.type.kind === "bytes"
          ? splitUndefinedIndex(
              lowerer,
              loweredIndex,
              access.argumentExpression,
              locOf(access.argumentExpression),
            )
          : null;
      if (split) stmts.push(...split.stmts);
      const rawIndex =
        split?.index ??
        lowerOptionalIndex(
          lowerer,
          loweredIndex,
          locOf(access.argumentExpression),
          access.argumentExpression,
        );
      const index = save(
        rawIndex.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(expr))
          ? { kind: "libCall", fn: "dyn.toNumberCoerce", args: [rawIndex], type: F64, loc }
          : rawIndex,
        "%incrementIndex",
      );
      if (index.type.kind !== "f64")
        lowerer.unsupported("SC1090", access, "incrementing non-number array keys");
      const type = raw.type;
      const read: IrExpr =
        type.kind === "array"
          ? type.elem.kind === "f64"
            ? arrayNumberRead(receiver, index, loc)
            : arrayValueRead(lowerer, receiver, index, type.elem, loc)
          : {
              kind: "bytesIntrinsic",
              method: "get",
              receiver,
              args: [index],
              type: F64,
              loc,
              invalidNaN: true,
            };
      const store = (value: IrExpr): IrStmt =>
        type.kind === "array"
          ? arrayValueStore(
              lowerer,
              receiver,
              index,
              lowerer.coerceInto(access, value, type.elem),
              type.elem,
              loc,
            )
          : {
              kind: "bytesSet",
              arr: receiver,
              index,
              value: lowerer.coerceInto(access, value, F64),
              loc,
            };
      if (!split) return finish(read, store);
      return finish(read, (value) => ({
        kind: "if",
        cond: split.isUndefined,
        then: [undefinedTypedArrayKeyFence(lowerer, access, loc)],
        else_: [store(value)],
        loc,
      }));
    }
    // A union of typed arrays and number arrays (indexed-unions.ts): the
    // element read as a number and the union's element write.
    const indexedArms = indexedUnionArms(lowerer, raw.type);
    if (
      ts.isElementAccessExpression(access) &&
      indexedArms &&
      !isJsSourceFile(ts.getSourceFileOfNode(expr))
    ) {
      const receiver = save(raw, "%incrementArray");
      const index = save(
        lowerOptionalIndex(
          lowerer,
          lowerer.lowerExpr(access.argumentExpression),
          locOf(access.argumentExpression),
          access.argumentExpression,
        ),
        "%incrementIndex",
      );
      if (index.type.kind !== "f64")
        lowerer.unsupported("SC1090", access, "incrementing non-number array keys");
      return finish(
        lowerIndexedUnionNumberRead(lowerer, receiver, indexedArms, index, loc),
        (value) =>
          lowerIndexedUnionWrite(
            lowerer,
            receiver,
            indexedArms,
            index,
            lowerer.coerceInto(access, value, F64),
            loc,
          ),
      );
    }
    // A TS member statically typed number on a checked-dynamic receiver (a
    // class-backed protocol view): the expanded form `o.v = o.v + 1`, its
    // read checked into number like any other read of the member.
    const checkedNumber =
      !isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      raw.type.kind === "dyn" &&
      lowerer.mapTypeOf(lowerer.typeOf(access))?.kind === "f64";
    // A private name is the field of its class (fieldTarget).
    const privateName =
      ts.isPropertyAccessExpression(access) && ts.isPrivateIdentifier(access.name);
    if (
      (isJsSourceFile(ts.getSourceFileOfNode(expr)) || checkedNumber) &&
      raw.type.kind === "dyn" &&
      !privateName
    ) {
      const receiver = save(raw, "%incrementReceiver");
      const key = save(
        ts.isElementAccessExpression(access)
          ? lowerer.lowerExprExpecting(access.argumentExpression, DYN)
          : lowerer.coerceInto(
              access,
              { kind: "strLit", value: access.name.text, type: STRING, loc },
              DYN,
            ),
        "%incrementKey",
      );
      const read: IrExpr = { kind: "dynKeyGet", value: receiver, key, type: DYN, loc };
      return finish(checkedNumber ? lowerer.coerceInto(access, read, F64) : read, (value) => ({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [receiver, key, lowerer.coerceInto(access, value, DYN)],
          type: VOID,
          loc,
        },
        loc,
      }));
    }
    const target = ts.isPropertyAccessExpression(access)
      ? lowerer.fieldTarget(access)
      : (symbolFieldTarget(lowerer, access) ?? keyedFieldTarget(lowerer, access, true));
    if (target && lowerer.dynConvertible(target.fieldType)) {
      checkDeferredMemberReceiver(lowerer, target, access);
      target.obj = save(target.obj, "%incrementReceiver");
      saveKeyedFieldKey(target, save);
      return finish(lowerer.fieldGetExpr(target, loc, access), (value) =>
        lowerer.fieldSetStmt(
          target,
          lowerer.coerceInto(access, value, target.fieldType),
          loc,
          access,
        ),
      );
    }
    if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && lowerer.dynConvertible(raw.type)) {
      const receiver = save(lowerer.coerceInto(access.expression, raw, DYN), "%incrementReceiver");
      const key = save(
        ts.isElementAccessExpression(access)
          ? lowerer.lowerExprExpecting(access.argumentExpression, DYN)
          : lowerer.coerceInto(
              access,
              { kind: "strLit", value: access.name.text, type: STRING, loc },
              DYN,
            ),
        "%incrementKey",
      );
      return finish({ kind: "dynKeyGet", value: receiver, key, type: DYN, loc }, (value) => ({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [receiver, key, lowerer.coerceInto(access, value, DYN)],
          type: VOID,
          loc,
        },
        loc,
      }));
    }
    lowerer.unsupported("SC1045", expr, "increment/decrement of this member target");
  }
  const target = lowerer.resolveWritable(expr.operand);
  if (!target) {
    lowerer.rejectUnresolved(
      expr.operand,
      `increment/decrement of '${expr.operand.text}' (not a writable local or module global)`,
    );
  }
  return lowerIncDecTarget(lowerer, expr, target, prefix);
}

/** Numeric updates read the represented slot once and write the computed
 * value back in that same representation. In particular, an unchecked
 * indexed initializer can leave undefined in an otherwise numeric binding. */
export function lowerIncDecTarget(
  lowerer: Lowerer,
  expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  target: { id: string; type: IrType },
  prefix: boolean,
): IrExpr {
  const loc = locOf(expr);
  const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
  if (target.type.kind === "dyn") {
    const old = lowerer.declareHiddenLocal("%numericOld", DYN);
    const next = lowerer.declareHiddenLocal("%numericNext", DYN);
    const read = varRef(target.id, target.type, loc);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: old.id,
          init: { kind: "libCall", fn: "dyn.toNumeric", args: [read], type: DYN, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: next.id,
          init: {
            kind: "libCall",
            fn: "dyn.increment",
            args: [
              varRef(old.id, DYN, loc),
              { kind: "boolLit", value: op === "+", type: BOOL, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
        { kind: "assign", localId: target.id, value: varRef(next.id, DYN, loc), loc },
      ],
      result: varRef(prefix ? next.id : old.id, DYN, loc),
      type: DYN,
      loc,
    };
  }
  if (target.type.kind === "union") {
    const read = lowerOptionalNumber(
      lowerer,
      varRef(target.id, target.type, loc),
      loc,
      expr.operand,
    );
    if (read.type.kind === "f64") {
      const old = lowerer.declareHiddenLocal("%numericOld", F64);
      const next = lowerer.declareHiddenLocal("%numericNext", F64);
      const result = varRef(prefix ? next.id : old.id, F64, loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: old.id, init: read, loc },
          {
            kind: "varDecl",
            localId: next.id,
            init: {
              kind: "bin",
              op,
              left: varRef(old.id, F64, loc),
              right: numLit(1, loc),
              type: F64,
              loc,
            },
            loc,
          },
          {
            kind: "assign",
            localId: target.id,
            value: lowerer.coerceInto(expr.operand, varRef(next.id, F64, loc), target.type),
            loc,
          },
        ],
        result,
        type: F64,
        loc,
      };
    }
  }
  if (target.type.kind === "bigint") {
    const old = lowerer.declareHiddenLocal("%bigintOld", BIGINT_T);
    const next = lowerer.declareHiddenLocal("%bigintNext", BIGINT_T);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: old.id, init: varRef(target.id, BIGINT_T, loc), loc },
        {
          kind: "varDecl",
          localId: next.id,
          init: bigintStep(op, varRef(old.id, BIGINT_T, loc), loc),
          loc,
        },
        { kind: "assign", localId: target.id, value: varRef(next.id, BIGINT_T, loc), loc },
      ],
      result: varRef(prefix ? next.id : old.id, BIGINT_T, loc),
      type: BIGINT_T,
      loc,
    };
  }
  if (target.type.kind !== "f64")
    operatorUnsupported(lowerer, expr, op === "+" ? "++" : "--", [target.type]);
  return { kind: "incDec", op, prefix, localId: target.id, type: F64, loc };
}

/** `++`/`--` on a bigint value: old ± 1n. */
function bigintStep(op: "+" | "-", old: IrExpr, loc: SrcLoc): IrExpr {
  const one: IrExpr = {
    kind: "libCall",
    fn: "bigint.parse",
    args: [{ kind: "strLit", value: "1", type: STRING, loc }],
    type: BIGINT_T,
    loc,
  };
  return {
    kind: "libCall",
    fn: op === "+" ? "bigint.add" : "bigint.sub",
    args: [old, one],
    type: BIGINT_T,
    loc,
  };
}

/** The write statement for a field target (fieldSet / recordSet / setter
 * call). A write to a getter-only property never gets here in a clean
 * program (tsc's TS2540 is the fence); the rejection is the backstop. */
export function fieldSetStmt(
  lowerer: Lowerer,
  target: FieldTarget,
  value: IrExpr,
  loc: SrcLoc,
  blame: ts.Node,
): IrStmt {
  // A write through a brand-checked receiver (checkedPrivateReceiver): the
  // value evaluates first, then the brand check throws, as in Node.
  if (isPrivateWriteReceiver(target.obj) && value.kind !== "varRef") {
    const stored = lowerer.declareHiddenLocal("%privateWriteValue", value.type);
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: stored.id, init: value, loc },
        fieldSetStmt(lowerer, target, varRef(stored.id, stored.type, loc), loc, blame),
      ],
      loc,
    };
  }
  // A member write through an unassigned deferred-init field: the value
  // still evaluates first, then the write throws Node's TypeError.
  const deferredSlot =
    target.container === "class" &&
    !(
      (target.field === "message" || target.field === "name") &&
      (target.className === "%Error" || lowerer.isSubclassOf(target.className, "%Error"))
    )
      ? lowerer.deferredFieldSlot(target.obj)
      : null;
  if (target.container === "class" && deferredSlot?.type.kind === "union") {
    const unionId = deferredSlot.type.unionId;
    const undefTag = lowerer.armTag(unionId, UNDEFINED_T);
    const presentTag = lowerer.armTag(unionId, target.obj.type);
    if (undefTag >= 0 && presentTag >= 0) {
      // A value that cannot write anything leaves the field unchanged, so
      // the field is read after it (no snapshot of the slot).
      const late = isSafeToRepeat(deferredSlot) && writeFree(value);
      const receiver = late
        ? null
        : lowerer.declareHiddenLocal("%deferredWriteObject", deferredSlot.type);
      const stored = lowerer.declareHiddenLocal("%deferredWriteValue", value.type);
      const receiverRef = receiver ? varRef(receiver.id, receiver.type, loc) : deferredSlot;
      const result = varRef(stored.id, stored.type, loc);
      const write: IrStmt = {
        kind: "fieldSet",
        obj: {
          kind: "unionNarrow",
          unionId,
          tag: presentTag,
          value: receiverRef,
          type: target.obj.type,
          loc,
        },
        className: target.className,
        field: target.field,
        value: result,
        loc,
      };
      return {
        kind: "exprStmt",
        expr: {
          kind: "seqExpr",
          stmts: [
            ...(receiver
              ? [{ kind: "varDecl" as const, localId: receiver.id, init: deferredSlot, loc }]
              : []),
            { kind: "varDecl", localId: stored.id, init: value, loc },
          ],
          result: {
            kind: "ternary",
            cond: {
              kind: "unionIsTag",
              unionId,
              tag: undefTag,
              value: receiverRef,
              negated: false,
              type: BOOL,
              loc,
            },
            then: nodeThrowExpr(
              1,
              "",
              `Cannot set properties of undefined (setting '${target.field}')`,
              result.type,
              loc,
            ),
            else_: { kind: "seqExpr", stmts: [write], result, type: result.type, loc },
            type: result.type,
            loc,
          },
          type: result.type,
          loc,
        },
        loc,
      };
    }
  }
  if (target.container === "recordKeyed") return keyedFieldWrite(lowerer, target, value, loc);
  if (target.container === "dynamic")
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [
          target.obj,
          { kind: "strLit", value: target.field, type: STRING, loc },
          lowerer.coerceToExpected(value, DYN),
        ],
        type: VOID,
        loc,
      },
      loc,
    };
  if (
    target.container === "class" &&
    (target.field === "message" || target.field === "name") &&
    (target.className === "%Error" || lowerer.isSubclassOf(target.className, "%Error"))
  )
    return errorPropertyWrite(lowerer, target.obj, value, target.field);
  if (target.container === "errorStackLimit") {
    return {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "error.stackLimitSet", args: [value], type: VOID, loc },
      loc,
    };
  }
  if (target.container === "errorCause") {
    return {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "error.setCause", args: [target.obj, value], type: VOID, loc },
      loc,
    };
  }
  // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree:
  // the checked-dynamic keyed write — dyn.keySet (later writes win,
  // insertion order; Node's TypeErrors on non-object receivers), the
  // value converting into the checked-dynamic tree.
  if (
    (target.container === "record" || target.container === "recordOvf") &&
    target.obj.type.kind === "dyn"
  ) {
    const v = lowerer.coerceToExpected(value, DYN);
    if (v.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1101",
        blame,
        `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
      );
    }
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [target.obj, { kind: "strLit", value: target.field, type: STRING, loc }, v],
        type: VOID,
        loc,
      },
      loc,
    };
  }
  if (target.container === "accessor") {
    const setF = lowerer.findMethodOn(
      lowerer.classes.get(target.className) ?? null,
      `set:${target.field}`,
    );
    if (!setF)
      lowerer.unsupported(
        "SC1090",
        blame,
        `assignment to the getter-only property '${target.field}'`,
      );
    return {
      kind: "exprStmt",
      expr: lowerer.accessorCall(
        target.className,
        `set:${target.field}`,
        target.obj,
        [value],
        VOID,
        loc,
      ),
      loc,
    };
  }
  // Record accessor properties: the write calls the %set: closure with
  // the coerced value. A getter-only write never gets here in a clean
  // program (tsc's TS2540); the rejection is the backstop.
  if (target.container === "recordAccessor") {
    if (!target.setType) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `assignment to the getter-only property '${target.field}'`,
      );
    }
    const closure: IrExpr = {
      kind: "recordGet",
      obj: target.obj,
      shapeId: target.shapeId,
      field: `%set:${target.field}`,
      type: target.setType,
      loc,
    };
    return {
      kind: "exprStmt",
      expr: { kind: "callValue", callee: closure, args: [value], type: VOID, loc },
      loc,
    };
  }
  // Overflow dot writes: the bracket write with a literal key — a pure
  // overflow insert (recordKeySet, overflowOnly: the name declares no
  // field, so no declared collision exists to validate). The value was
  // coerced into the index-value slot type by the caller.
  if (target.container === "recordOvf") {
    return {
      kind: "recordKeySet",
      obj: target.obj,
      shapeId: target.shapeId,
      key: { kind: "strLit", value: target.field, type: STRING, loc },
      value,
      overflowOnly: true,
      loc,
    };
  }
  return target.container === "class"
    ? {
        kind: "fieldSet",
        obj: target.obj,
        className: target.className,
        field: target.field,
        value,
        ...(isStrictCode(blame) ? {} : { sloppy: true as const }),
        loc,
      }
    : {
        kind: "recordSet",
        obj: target.obj,
        shapeId: target.shapeId,
        field: target.field,
        value,
        loc,
      };
}

export function lowerFieldCompoundValue(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  op: CompoundOp,
  rhsNode: ts.Expression | null,
  loc: SrcLoc,
): IrExpr {
  if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
    lowerer.unsupported(
      "SC1090",
      access,
      "compound assignment through 'super' (read and write separately)",
    );
  }
  const body: IrStmt[] = [];
  const save = (value: IrExpr, name: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, value.type);
    body.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return varRef(local.id, value.type, value.loc);
  };
  // A CHECKED-DYNAMIC receiver (`context.actual++` — test/common's call
  // accounting; dot spelling only — symbol-keyed element targets are
  // static fields): read the member (dynKeyGet), VALIDATE it as a
  // number (dynCheck — a non-number member throws the catchable
  // TypeError where JS would ToNumber-coerce; it throws instead of
  // producing NaN — SEMANTICS.md), combine, write back (dyn.keySet). The
  // receiver and member read are saved before evaluating the RHS.
  if (ts.isPropertyAccessExpression(access)) {
    let probed = tryLowerExpression(lowerer, access.expression);
    const staticClass =
      probed?.type.kind === "classval" ? lowerer.classes.get(probed.type.className) : undefined;
    if (probed && staticClass && hasRuntimeStatics(staticClass))
      probed = lowerer.coerceToExpected(probed, DYN);
    // A private name is the field of its class (fieldTarget).
    if (probed?.type.kind === "dyn" && !ts.isPrivateIdentifier(access.name)) {
      const receiver = save(probed, "%compoundReceiver");
      const key: IrExpr = {
        kind: "strLit",
        value: access.name.text,
        type: STRING,
        loc: locOf(access.name),
      };
      const read = save(
        { kind: "dynKeyGet", key, value: receiver, type: DYN, loc },
        "%compoundOld",
      );
      const cur: IrExpr = { kind: "dynCheck", value: read, type: F64, loc };
      const rhs = save(
        rhsNode ? lowerer.lowerExpr(rhsNode) : { kind: "numLit", value: 1, type: F64, loc },
        "%compoundRhs",
      );
      if (isJsSourceFile(ts.getSourceFileOfNode(access)) && lowerer.dynConvertible(rhs.type)) {
        const numeric = ["-", "*", "/", "%", "**"].includes(op);
        const right = lowerer.coerceToExpected(rhs, DYN);
        const value = save(
          {
            kind: "libCall",
            fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
            args:
              op === "+"
                ? [read, right]
                : [read, right, { kind: "strLit", value: op, type: STRING, loc }],
            type: DYN,
            loc,
          },
          "%compoundResult",
        );
        body.push({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [receiver, key, value],
            type: VOID,
            loc,
          },
          loc,
        });
        return { kind: "seqExpr", stmts: body, result: value, type: DYN, loc };
      }
      const numericRhs: IrExpr =
        rhs.type.kind === "dyn"
          ? { kind: "dynCheck", value: rhs, type: F64, loc: rhs.loc }
          : lowerOptionalNumber(lowerer, rhs, loc);
      if (numericRhs.type.kind !== "f64")
        compoundUnsupported(lowerer, access, op, F64, numericRhs.type);
      const value = save(
        { kind: "bin", op, left: cur, right: numericRhs, type: F64, loc },
        "%compoundResult",
      );
      const boxed: IrExpr = { kind: "dynFrom", value, type: DYN, loc };
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySet",
          args: [receiver, { ...key }, boxed],
          type: VOID,
          loc,
        },
        loc,
      });
      return { kind: "seqExpr", stmts: body, result: value, type: value.type, loc };
    }
  }
  const targetOf = (): FieldTarget | null =>
    ts.isPropertyAccessExpression(access)
      ? lowerer.fieldTarget(access)
      : (symbolFieldTarget(lowerer, access) ?? keyedFieldTarget(lowerer, access, true));
  const target = targetOf();
  if (!target)
    lowerer.unsupported("SC1090", access, "compound assignment to unsupported field targets");
  checkDeferredMemberReceiver(lowerer, target, access);
  target.obj = save(target.obj, "%compoundReceiver");
  saveKeyedFieldKey(target, save);
  // Accessors observe getter, RHS side effects, then setter, all through
  // the saved receiver.
  const fieldRead = lowerer.fieldGetExpr(target, locOf(access), access);
  // `+=` on a stored string field reads it into a mutable local, so the
  // concat below can append to that local in place.
  const storedString =
    op === "+" &&
    fieldRead.type.kind === "string" &&
    target.fieldType.kind === "string" &&
    (target.container === "class" || target.container === "record");
  let read: IrExpr;
  if (storedString) {
    const old = declareContextLocal(
      lowerer.ctx,
      "%compoundOld",
      STRING,
      true,
      undefined,
      undefined,
    );
    body.push({ kind: "varDecl", localId: old.id, init: fieldRead, loc: fieldRead.loc });
    read = varRef(old.id, STRING, fieldRead.loc);
  } else {
    read = save(fieldRead, "%compoundOld");
  }
  const rhs = save(
    rhsNode ? lowerer.lowerExpr(rhsNode) : { kind: "numLit", value: 1, type: F64, loc },
    "%compoundRhs",
  );
  const numericRhs: IrExpr =
    rhs.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(access))
      ? { kind: "dynCheck", value: rhs, type: F64, loc: rhs.loc }
      : lowerOptionalNumber(lowerer, rhs, loc);
  let value: IrExpr;
  let appended: IrExpr | null = null;
  const numericRead = lowerOptionalNumber(lowerer, read, loc, access);
  const bigintValue = rhsNode ? bigintCompoundValue(op, read, rhs, loc) : null;
  if (op === "+" && read.type.kind === "string") {
    appended = concatOperand(lowerer, rhs, rhsNode ?? access);
    value = { kind: "strConcat", left: read, right: appended, type: STRING, loc };
  } else if (numericRead.type.kind === "f64" && numericRhs.type.kind === "f64") {
    value = { kind: "bin", op, left: numericRead, right: numericRhs, type: F64, loc };
  } else if (bigintValue) {
    value = bigintValue;
  } else if (
    (target.fieldType.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(access))) ||
    // An untyped right operand: the expanded `o.f = o.f op rhs`; the field
    // write below checks the result into the declared field type.
    (rhs.type.kind === "dyn" &&
      lowerer.dynConvertible(read.type) &&
      lowerer.dynConvertible(target.fieldType))
  ) {
    value = dynCompoundValue(
      op,
      lowerer.coerceToExpected(read, DYN),
      lowerer.coerceToExpected(rhs, DYN),
      loc,
    );
  } else {
    compoundUnsupported(lowerer, access, op, read.type, rhs.type);
  }
  if (storedString && rhs.type.kind === "string" && read.kind === "varRef" && appended !== null) {
    // The field gives up its value before the concat (no code runs in
    // between: both operands are already strings), and the concat is the
    // self-append `old = old + rhs`, which hands the local's reference to
    // the runtime: the old string is then uniquely owned unless something
    // else holds it, and is appended to in place. Repeated `this.text += s`
    // is linear rather than a copy per append.
    const oldId = read.localId;
    const oldLoc = read.loc;
    const oldRef = (): IrExpr => varRef(oldId, STRING, oldLoc);
    const concat: IrExpr = {
      kind: "strConcat",
      left: oldRef(),
      right: appended,
      type: STRING,
      loc,
    };
    body.push(
      lowerer.fieldSetStmt(target, { kind: "strLit", value: "", type: STRING, loc }, loc, access),
      { kind: "assign", localId: oldId, value: concat, loc },
      lowerer.fieldSetStmt(target, oldRef(), loc, access),
    );
    return { kind: "seqExpr", stmts: body, result: oldRef(), type: STRING, loc };
  }
  const result = save(value, "%compoundResult");
  body.push(
    lowerer.fieldSetStmt(target, lowerer.coerceInto(access, result, target.fieldType), loc, access),
  );
  return { kind: "seqExpr", stmts: body, result, type: result.type, loc };
}
