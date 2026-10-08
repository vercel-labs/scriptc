import { boolLit, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN_HANDLE_KINDS,
  type IrExpr,
  type IrType,
  type SrcLoc,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { unionComparison } from "./union-comparison.js";

const IDENTITY_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "array",
  "map",
  "set",
  "regex",
  "url",
  "object",
  "record",
  "symbol",
  "bytes",
  "promise",
  "func",
  "classval",
  "moduleNs",
]);

function atomicEquality(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  sameValue: boolean,
  loc: SrcLoc,
): IrExpr | null {
  const a = left.type,
    b = right.type;
  if (
    [a.kind, b.kind].some(
      (kind) => kind === "dyn" || kind === "jsval" || kind === "caught" || kind === "void",
    )
  )
    return null;
  if (isUnitType(a) || isUnitType(b)) return boolLit(a.kind === b.kind, loc);
  if (a.kind === "object" && b.kind === "object" && !typeEquals(a, b)) {
    if (lowerer.isSubclassOf(a.className, b.className)) left = lowerer.upcastTo(left, b.className);
    else if (lowerer.isSubclassOf(b.className, a.className))
      right = lowerer.upcastTo(right, a.className);
    else return boolLit(false, loc);
  }
  if (a.kind !== b.kind) {
    // A structural record can represent a class view. A different layout
    // cannot prove that the original JavaScript identities are disjoint.
    if (
      (a.kind === "record" && b.kind === "object") ||
      (a.kind === "object" && b.kind === "record")
    )
      return null;
    return boolLit(false, loc);
  }
  if (a.kind === "string") return { kind: "strEq", left, right, negated: false, type: BOOL, loc };
  if (a.kind === "bigint")
    return { kind: "libCall", fn: "bigint.eq", args: [left, right], type: BOOL, loc };
  if (a.kind === "f64" && sameValue)
    return { kind: "libCall", fn: "num.sameValue", args: [left, right], type: BOOL, loc };
  if (
    a.kind === "f64" ||
    a.kind === "bool" ||
    a.kind === "func" ||
    a.kind === "classval" ||
    a.kind === "moduleNs" ||
    ((IDENTITY_KINDS.has(a.kind) || DYN_HANDLE_KINDS.has(a.kind)) &&
      typeEquals(left.type, right.type))
  )
    return { kind: "bin", op: "===", left, right, type: BOOL, loc };
  return null;
}

/** Related class arms can store the same object under different tags, so
 * comparing a union's tags and payloads alone can miss an identity. */
export function tagEqualityMayMissAlias(lowerer: Lowerer, type: IrType): boolean {
  const arms = type.kind === "union" ? lowerer.unions.get(type.unionId)?.arms : null;
  return (
    arms?.some(
      (arm, index) =>
        arm.kind === "object" &&
        arms
          .slice(index + 1)
          .some(
            (other) =>
              other.kind === "object" &&
              (lowerer.isSubclassOf(arm.className, other.className) ||
                lowerer.isSubclassOf(other.className, arm.className)),
          ),
    ) ?? false
  );
}

/** Strict/SameValue comparison across independently represented unions.
 * Parameters preserve left-to-right evaluation and reuse native payloads;
 * equality must never allocate a width copy or adapt a callback signature. */
export function lowerUnionEquality(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  negated: boolean,
  sameValue: boolean,
  loc: SrcLoc,
): IrExpr | null {
  if (left.type.kind !== "union" && right.type.kind !== "union") return null;
  // Unit comparisons are handled before this path, including their effects.
  if (isUnitType(left.type) || isUnitType(right.type)) return null;
  // Ordinary same-layout unions keep the compact tag comparison.
  if (typeEquals(left.type, right.type) && !tagEqualityMayMissAlias(lowerer, left.type))
    return null;
  // So does a plain operand that is already one of a comparable union's arms.
  const union = left.type.kind === "union" ? left.type : right.type;
  const plain = left.type.kind === "union" ? right.type : left.type;
  if (
    union.kind === "union" &&
    plain.kind !== "union" &&
    !tagEqualityMayMissAlias(lowerer, union) &&
    lowerer.eqComparableUnion(union.unionId) &&
    lowerer.unions.get(union.unionId)?.arms.some((arm) => typeEquals(arm, plain))
  )
    return null;
  const key = `${lowerer.unions.revision}:${typeKey(left.type)}:${typeKey(right.type)}:${sameValue}`;
  let name = lowerer.equalityHelpers.get(key);
  if (!name) {
    const a = varRef("left.0", left.type, loc),
      b = varRef("right.0", right.type, loc);
    const result = unionComparison(
      lowerer,
      a,
      b,
      (x, y) => atomicEquality(lowerer, x, y, sameValue, loc),
      loc,
    );
    if (!result) return null;
    name = `%value.eq.${lowerer.equalityHelpers.size}`;
    lowerer.equalityHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "left.0", name: "left", type: left.type },
        { localId: "right.0", name: "right", type: right.type },
      ],
      locals: [
        { id: "left.0", name: "left", type: left.type, mutable: false },
        { id: "right.0", name: "right", type: right.type, mutable: false },
      ],
      returnType: BOOL,
      body: [{ kind: "return", value: result, loc }],
      loc,
    });
  }
  const result: IrExpr = { kind: "call", callee: name, args: [left, right], type: BOOL, loc };
  return negated ? { kind: "unary", op: "!", operand: result, type: BOOL, loc } : result;
}
