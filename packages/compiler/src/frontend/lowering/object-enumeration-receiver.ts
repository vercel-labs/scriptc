import { keyedHelperName } from "./stable-names.js";
import {
  BOOL,
  STRING,
  type IrExpr,
  type IrType,
  type SrcLoc,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** Array/property reads retain a missing-value arm even when the checker
 * promises a record. Object enumeration must check it before reading fields. */
export function objectEnumerationReceiver(
  lowerer: Lowerer,
  receiver: IrExpr,
  expected: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  if (receiver.type.kind !== "union") return receiver;
  const source = receiver.type;
  const arms = lowerer.unions.get(source.unionId)?.arms;
  const tag = lowerer.armTag(source.unionId, expected);
  if (tag < 0 || !arms?.every((arm) => isUnitType(arm) || typeEquals(arm, expected)))
    return receiver;
  const key = `obj.receiver:${source.unionId}:${expected.shapeId}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%obj.receiver", key);
    lowerer.arrHofHelpers.set(key, name);
    const value = varRef("value.0", source, loc);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value.0", name: "value", type: source }],
      returnType: expected,
      locals: [{ id: "value.0", name: "value", type: source, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: source.unionId,
            tag,
            value,
            negated: false,
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "return",
              value: {
                kind: "unionNarrow",
                unionId: source.unionId,
                tag,
                value,
                type: expected,
                loc,
              },
              loc,
            },
          ],
          else_: [
            {
              kind: "throw",
              value: {
                kind: "libCall",
                fn: "error.new",
                args: [
                  {
                    kind: "strLit",
                    value: "Cannot convert undefined or null to object",
                    type: STRING,
                    loc,
                  },
                ],
                type: { kind: "object", className: "%TypeError" },
                loc,
              },
              loc,
            },
          ],
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [receiver], type: expected, loc };
}
