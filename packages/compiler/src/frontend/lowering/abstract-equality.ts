import { unionComparison } from "./union-comparison.js";
import { InternalCompilerError } from "../../errors.js";
import {
  BOOL,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { boolLit, numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/**
 * The engine-free part of ECMAScript Abstract Equality Comparison.
 *
 * Every primitive pair is exact, including StringToNumber,
 * StringToBigInt, Boolean-to-number recursion, and BigInt/Number's
 * mathematical comparison. Object-to-primitive coercion stays outside
 * this helper: user-defined valueOf/toString methods can execute arbitrary
 * JavaScript, so a static build must keep that form fenced. Object pairs
 * with one exact representation compare by identity, as == and === agree
 * there.
 */

const IDENTITY_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "array",
  "bytes",
  "map",
  "set",
  "object",
  "record",
  "promise",
  "symbol",
  "classval",
  "moduleNs",
]);

const PRIMITIVE_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "f64",
  "string",
  "bool",
  "bigint",
  "symbol",
]);

function supportsPair(lowerer: Lowerer, left: IrType, right: IrType): boolean {
  if (left.kind === "union") {
    const def = lowerer.unions.get(left.unionId);
    return def !== undefined && def.arms.every((arm) => supportsPair(lowerer, arm, right));
  }
  if (right.kind === "union") {
    const def = lowerer.unions.get(right.unionId);
    return def !== undefined && def.arms.every((arm) => supportsPair(lowerer, left, arm));
  }
  if (isUnitType(left) || isUnitType(right)) {
    const other = isUnitType(left) ? right : left;
    return (
      other.kind !== "dyn" &&
      other.kind !== "jsval" &&
      other.kind !== "caught" &&
      other.kind !== "void"
    );
  }

  if (PRIMITIVE_KINDS.has(left.kind) && PRIMITIVE_KINDS.has(right.kind)) return true;

  if (left.kind === "func" && right.kind === "func") return true;
  if (IDENTITY_KINDS.has(left.kind) && typeEquals(left, right)) return true;
  if (DYN_HANDLE_KINDS.has(left.kind) && typeEquals(left, right)) return true;

  if (left.kind === "object" && right.kind === "object") {
    return (
      lowerer.isSubclassOf(left.className, right.className) ||
      lowerer.isSubclassOf(right.className, left.className)
    );
  }
  return false;
}

function boolAsNumber(value: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "ternary",
    cond: value,
    then: numLit(1, loc),
    else_: numLit(0, loc),
    type: F64,
    loc,
  };
}

function numericEq(left: IrExpr, right: IrExpr, nanEqualsNan: boolean, loc: SrcLoc): IrExpr {
  const ordinary: IrExpr = { kind: "bin", op: "===", left, right, type: BOOL, loc };
  if (!nanEqualsNan) return ordinary;
  return {
    kind: "logical",
    op: "||",
    left: ordinary,
    right: {
      kind: "logical",
      op: "&&",
      left: { kind: "libCall", fn: "num.isNaN", args: [left], type: BOOL, loc },
      right: { kind: "libCall", fn: "num.isNaN", args: [right], type: BOOL, loc },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}

function primitivePair(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  nanEqualsNan: boolean,
  loc: SrcLoc,
): IrExpr {
  if (isUnitType(left.type) || isUnitType(right.type)) {
    return boolLit(isUnitType(left.type) && isUnitType(right.type), loc);
  }

  if (left.type.kind === "object" && right.type.kind === "object") {
    if (typeEquals(left.type, right.type)) {
      return { kind: "bin", op: "===", left, right, type: BOOL, loc };
    }
    if (lowerer.isSubclassOf(left.type.className, right.type.className)) {
      return {
        kind: "bin",
        op: "===",
        left: lowerer.upcastTo(left, right.type.className),
        right,
        type: BOOL,
        loc,
      };
    }
    if (lowerer.isSubclassOf(right.type.className, left.type.className)) {
      return {
        kind: "bin",
        op: "===",
        left,
        right: lowerer.upcastTo(right, left.type.className),
        type: BOOL,
        loc,
      };
    }
  }

  if (left.type.kind === right.type.kind) {
    switch (left.type.kind) {
      case "f64":
        return numericEq(left, right, nanEqualsNan, loc);
      case "string":
        return { kind: "strEq", negated: false, left, right, type: BOOL, loc };
      case "bool":
        return { kind: "bin", op: "===", left, right, type: BOOL, loc };
      case "bigint":
        return { kind: "libCall", fn: "bigint.eq", args: [left, right], type: BOOL, loc };
      case "symbol":
      case "array":
      case "bytes":
      case "map":
      case "set":
      case "record":
      case "promise":
      case "classval":
      case "moduleNs":
        return { kind: "bin", op: "===", left, right, type: BOOL, loc };
      default:
        break;
    }
  }

  if (left.type.kind === "func" && right.type.kind === "func") {
    return { kind: "bin", op: "===", left, right, type: BOOL, loc };
  }
  if (DYN_HANDLE_KINDS.has(left.type.kind) && typeEquals(left.type, right.type)) {
    return { kind: "bin", op: "===", left, right, type: BOOL, loc };
  }
  // Boolean first recurses as ToNumber(boolean), per ECMA-262 7.2.13.
  if (left.type.kind === "bool")
    return primitivePair(lowerer, boolAsNumber(left, loc), right, nanEqualsNan, loc);
  if (right.type.kind === "bool")
    return primitivePair(lowerer, left, boolAsNumber(right, loc), nanEqualsNan, loc);

  // Symbols never equal a different primitive type. Object/symbol would
  // require ToPrimitive and was rejected by supportsPair.
  if (left.type.kind === "symbol" || right.type.kind === "symbol") return boolLit(false, loc);

  if (left.type.kind === "f64" && right.type.kind === "string") {
    const parsed: IrExpr = { kind: "libCall", fn: "num.fromString", args: [right], type: F64, loc };
    return numericEq(left, parsed, false, loc);
  }
  if (left.type.kind === "string" && right.type.kind === "f64") {
    const parsed: IrExpr = { kind: "libCall", fn: "num.fromString", args: [left], type: F64, loc };
    return numericEq(parsed, right, false, loc);
  }
  if (left.type.kind === "bigint" && right.type.kind === "string") {
    return { kind: "libCall", fn: "bigint.eqString", args: [left, right], type: BOOL, loc };
  }
  if (left.type.kind === "string" && right.type.kind === "bigint") {
    return { kind: "libCall", fn: "bigint.eqString", args: [right, left], type: BOOL, loc };
  }
  if (left.type.kind === "bigint" && right.type.kind === "f64") {
    const cmp: IrExpr = {
      kind: "libCall",
      fn: "bigint.cmpNumber",
      args: [left, right],
      type: F64,
      loc,
    };
    return { kind: "bin", op: "===", left: cmp, right: numLit(0, loc), type: BOOL, loc };
  }
  if (left.type.kind === "f64" && right.type.kind === "bigint") {
    const cmp: IrExpr = {
      kind: "libCall",
      fn: "bigint.cmpNumber",
      args: [right, left],
      type: F64,
      loc,
    };
    return { kind: "bin", op: "===", left: cmp, right: numLit(0, loc), type: BOOL, loc };
  }

  throw new InternalCompilerError(
    `abstract equality reached an unplanned pair ${left.type.kind}/${right.type.kind}`,
  );
}

function pairExpr(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  nanEqualsNan: boolean,
  loc: SrcLoc,
): IrExpr {
  const result = unionComparison(
    lowerer,
    left,
    right,
    (a, b) => primitivePair(lowerer, a, b, nanEqualsNan, loc),
    loc,
  );
  if (!result) throw new InternalCompilerError("abstract equality over an unknown union");
  return result;
}

export function abstractEqualitySupported(lowerer: Lowerer, left: IrType, right: IrType): boolean {
  return supportsPair(lowerer, left, right);
}

export function abstractEqualityExpr(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  loc: SrcLoc,
  nanEqualsNan = false,
): IrExpr {
  if (!supportsPair(lowerer, left.type, right.type)) {
    throw new InternalCompilerError(
      `abstract equality expression built for unsupported ${left.type.kind}/${right.type.kind} pair`,
    );
  }
  return pairExpr(lowerer, left, right, nanEqualsNan, loc);
}

/** Evaluate both operands once, left-to-right, then compare their stable values. */
export function lowerAbstractEquality(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  negated: boolean,
  loc: SrcLoc,
): IrExpr | null {
  if (
    (left.type.kind === "dyn" || right.type.kind === "dyn") &&
    lowerer.dynConvertible(left.type) &&
    lowerer.dynConvertible(right.type)
  ) {
    const result: IrExpr = {
      kind: "libCall",
      fn: "dyn.abstractEq",
      args: [lowerer.coerceToExpected(left, DYN), lowerer.coerceToExpected(right, DYN)],
      type: BOOL,
      loc,
    };
    return negated ? { kind: "unary", op: "!", operand: result, type: BOOL, loc } : result;
  }
  if (!supportsPair(lowerer, left.type, right.type)) return null;
  if (left.kind === "strLit" && right.kind === "strLit") {
    return { kind: "boolLit", value: (left.value === right.value) !== negated, type: BOOL, loc };
  }
  const stmts: IrStmt[] = [];
  const stable = (value: IrExpr, name: string): IrExpr => {
    if (isUnitType(value.type)) {
      if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
      return {
        kind: "unitLit",
        unit: value.type.kind === "nullT" ? "null" : "undefined",
        type: value.type,
        loc,
      };
    }
    const local = lowerer.declareHiddenLocal(name, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return varRef(local.id, value.type, loc);
  };
  const a = stable(left, "%looseA");
  const b = stable(right, "%looseB");
  let result = pairExpr(lowerer, a, b, false, loc);
  if (negated) result = { kind: "unary", op: "!", operand: result, type: BOOL, loc };
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: BOOL, loc };
}
