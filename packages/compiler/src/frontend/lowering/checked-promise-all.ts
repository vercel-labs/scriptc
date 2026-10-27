import { CAUGHT, DYN, funcOf, type IrExpr, type IrType, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { checkedIterableSpread } from "./checked-iterable-spread.js";

const COMBINATOR_LIB_CALLS = {
  all: "dyn.promiseAll",
  allSettled: "dyn.promiseAllSettled",
  any: "dyn.promiseAny",
} as const;

/** `value.then` through the program's own property dispatch, so a class
 * instance's `then` method is visible to the runtime's thenable check. */
export function thenReader(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const name = "%promise.thenOf";
  const type = funcOf([DYN], DYN);
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      returnType: DYN,
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynKeyGet",
            value: varRef("value", DYN, loc),
            key: { kind: "strLit", value: "then", type: { kind: "string" }, loc },
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type, loc },
    type: DYN,
    loc,
  };
}

/** JavaScript builds Promise.all, Promise.allSettled and Promise.any
 * inputs at runtime. Iterator failures reject the result instead of
 * escaping the synchronous call. */
export function checkedPromiseAll(
  lowerer: Lowerer,
  source: IrExpr,
  loc: SrcLoc,
  member: keyof typeof COMBINATOR_LIB_CALLS = "all",
): IrExpr {
  const name = `%promise.${member}.checked`;
  const type: IrType = { kind: "promise", inner: DYN };
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, type);
    lowerer.fnStack.push(context);
    try {
      const entries = checkedIterableSpread(lowerer, varRef("source", DYN, loc), "", loc);
      lowerer.liftedFns.push({
        name,
        params: [{ localId: "source", name: "source", type: DYN }],
        returnType: type,
        locals: [
          { id: "source", name: "source", type: DYN, mutable: false },
          { id: "error", name: "error", type: CAUGHT, mutable: false },
          ...context.locals,
        ],
        body: [
          {
            kind: "tryCatch",
            tryBody: [
              {
                kind: "return",
                value: {
                  kind: "libCall",
                  fn: COMBINATOR_LIB_CALLS[member],
                  args: [entries, thenReader(lowerer, loc)],
                  type,
                  loc,
                },
                loc,
              },
            ],
            catchLocalId: "error",
            catchBody: [
              {
                kind: "return",
                value: {
                  kind: "intrinsic",
                  name: "promise.reject",
                  args: [
                    { kind: "caughtToDyn", value: varRef("error", CAUGHT, loc), type: DYN, loc },
                  ],
                  type,
                  loc,
                },
                loc,
              },
            ],
            finallyBody: null,
            loc,
          },
        ],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return { kind: "call", callee: name, args: [lowerer.coerceToExpected(source, DYN)], type, loc };
}
