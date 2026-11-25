import { BOOL, DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { lowerCheckedArrayFrom } from "./containers/array-construction.js";

/** Spread consumes the iterator protocol, including native class methods. */
export function checkedIterableSpread(
  lowerer: Lowerer,
  source: IrExpr,
  spelling: string,
  loc: SrcLoc,
): IrExpr {
  const name = "%spread.iterable";
  if (lowerer.liftedFnNamed(name) === undefined) {
    const context = newFnCtx(false, null, null, DYN);
    lowerer.fnStack.push(context);
    try {
      const params = [
        { localId: "source", name: "source", type: DYN },
        { localId: "spelling", name: "spelling", type: STRING },
      ];
      const sourceValue = varRef("source", DYN, loc);
      const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
      const nullishMessage = (value: string): IrExpr => ({
        kind: "strConcat",
        left: varRef("spelling", STRING, loc),
        right: text(` is not iterable (cannot read property ${value})`),
        type: STRING,
        loc,
      });
      const message: IrExpr = {
        kind: "ternary",
        cond: { kind: "dynTest", test: "null", value: sourceValue, type: BOOL, loc },
        then: nullishMessage("null"),
        else_: {
          kind: "ternary",
          cond: { kind: "dynTest", test: "undefined", value: sourceValue, type: BOOL, loc },
          then: nullishMessage("undefined"),
          else_: text("Spread syntax requires ...iterable[Symbol.iterator] to be a function"),
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      };
      const result = lowerCheckedArrayFrom(
        lowerer,
        sourceValue,
        loc,
        undefined,
        undefined,
        false,
        message,
      );
      lowerer.liftedFns.push({
        name,
        params,
        returnType: DYN,
        locals: [
          ...params.map((param) => ({
            id: param.localId,
            name: param.name,
            type: param.type,
            mutable: false,
          })),
          ...context.locals,
        ],
        body: [{ kind: "return", value: result, loc }],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return {
    kind: "call",
    callee: name,
    args: [
      lowerer.coerceToExpected(source, DYN),
      { kind: "strLit", value: spelling, type: STRING, loc },
    ],
    type: DYN,
    loc,
  };
}
