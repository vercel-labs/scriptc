import { BOOL, STRING, isUnitType, typeEquals } from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";

/** The TypeError message for a checked extraction that finds `arm`. */
export function unionNarrowFailureMessage(
  arm: IrType,
  formatType: (type: IrType) => string,
): string {
  const what = isUnitType(arm)
    ? arm.kind === "undefinedT"
      ? "undefined"
      : "null"
    : `a '${formatType(arm)}' value`;
  return `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`;
}

/** Build checked extraction from a union's actual storage. Successful reads
 * retain reference payloads through unionNarrow; every other valid tag
 * throws before the payload can be interpreted as the target type.
 *
 * Deferred scalar fields can supply the established undefined default:
 * false for booleans or NaN for numbers. No other tag receives that default,
 * and reference-bearing targets always use checked extraction. */
export function buildUnionNarrow(
  name: string,
  from: IrUnionDef,
  target: IrType,
  loc: SrcLoc,
  formatType: (type: IrType) => string,
  undefinedDefault: IrExpr | null = null,
  /** Converts another arm's payload into the target (a record arm that is
   * a width subtype of a record target), or null to throw. */
  convert: ((tag: number, payload: IrExpr) => IrExpr | null) | null = null,
): IrFunction | null {
  if (isUnitType(target) || target.kind === "void") return null;
  const targetTag = from.arms.findIndex((arm) => typeEquals(arm, target));
  if (targetTag < 0) return null;
  if (undefinedDefault !== null) {
    if (target.kind !== "bool" && target.kind !== "f64") return null;
    if (
      !typeEquals(undefinedDefault.type, target) ||
      !from.arms.some((arm) => arm.kind === "undefinedT")
    )
      return null;
  }
  const inputType: IrType = { kind: "union", unionId: from.id };
  const input: IrExpr = { kind: "varRef", localId: "u.0", type: inputType, loc };
  const body: IrStmt[] = [];
  let converted: IrExpr | null = null;
  for (let tag = 0; tag < from.arms.length; tag++) {
    const arm = from.arms[tag]!;
    let branch: IrStmt[];
    if (tag === targetTag) {
      branch = [
        {
          kind: "return",
          value: { kind: "unionNarrow", unionId: from.id, tag, value: input, type: target, loc },
          loc,
        },
      ];
    } else if (arm.kind === "undefinedT" && undefinedDefault !== null) {
      branch = [{ kind: "return", value: undefinedDefault, loc }];
    } else if (
      convert !== null &&
      !isUnitType(arm) &&
      (converted = convert(tag, {
        kind: "unionNarrow",
        unionId: from.id,
        tag,
        value: input,
        type: arm,
        loc,
      })) !== null
    ) {
      branch = [{ kind: "return", value: converted, loc }];
    } else {
      branch = [
        {
          kind: "throw",
          value: {
            kind: "libCall",
            fn: "error.new",
            args: [
              {
                kind: "strLit",
                value: unionNarrowFailureMessage(arm, formatType),
                type: STRING,
                loc,
              },
            ],
            type: { kind: "object", className: "%TypeError" },
            loc,
          },
          loc,
        },
      ];
    }
    body.push({
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId: from.id,
        tag,
        negated: false,
        value: input,
        type: BOOL,
        loc,
      },
      then: branch,
      else_: null,
      loc,
    });
  }
  body.push({
    kind: "throw",
    value: {
      kind: "strLit",
      value: "scriptc: internal error: invalid union tag",
      type: STRING,
      loc,
    },
    loc,
  });
  return {
    name,
    params: [{ localId: "u.0", name: "u", type: inputType }],
    returnType: target,
    locals: [{ id: "u.0", name: "u", type: inputType, mutable: false }],
    body,
    loc,
  };
}
