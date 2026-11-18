import { expect, test } from "vitest";
import { BOOL, DYN, type IrExpr, type IrFunction, type IrType } from "../../ir/ir.js";
import { FunctionCensus } from "./function-census.js";
import type { Lowerer } from "./lowerer.js";
import { returnDispatchReceivers } from "./receiver-returns.js";

const loc = { file: "fluent.js", start: 0, end: 1 };
const SELF: IrType = { kind: "object", className: "Builder" };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

/** `step() { return this; }`: every path returns the receiver boxed at its
 * exact class. */
function fluentMethod(): IrFunction {
  return {
    name: "%Builder.step",
    params: [{ localId: "this", name: "this", type: SELF }],
    locals: [],
    returnType: DYN,
    loc,
    body: [
      {
        kind: "return",
        value: {
          kind: "call",
          callee: "%dyn.class.boxExact:Builder",
          args: [ref("this", SELF)],
          type: DYN,
          loc,
        },
        loc,
      },
    ],
  };
}

/** A class dispatch helper whose one branch calls the method on its
 * receiver and returns the result. It holds no expression statement. */
function dispatchHelper(): IrFunction {
  return {
    name: "%dyn.class.call.0",
    params: [{ localId: "receiver", name: "receiver", type: DYN }],
    locals: [],
    returnType: DYN,
    loc,
    body: [
      {
        kind: "if",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: {
              kind: "call",
              callee: "%Builder.step",
              args: [{ kind: "dynCheck", value: ref("receiver", DYN), type: SELF, loc }],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
      { kind: "return", value: ref("receiver", DYN), loc },
    ],
  };
}

test("a dispatch helper rewritten in place is scanned again", () => {
  const helper = dispatchHelper();
  const functions = [fluentMethod(), helper];
  // An earlier finish pass asked about the helper, so its census is held.
  const census = new FunctionCensus();
  expect(census.hasStmt(helper, "exprStmt")).toBe(false);
  expect(census.hasExpr(helper, "dynCheck")).toBe(true);
  const body = helper.body;

  // The boxExact form never consults the lowerer.
  returnDispatchReceivers({} as Lowerer, functions, census);

  // The branch now calls the copy that returns nothing and answers the
  // receiver, inside the same statement list.
  expect(helper.body).toBe(body);
  expect(functions.map((fn) => fn.name)).toContain("%dyn.class.receiver:Builder.step");
  const branch = helper.body[0] as Extract<IrFunction["body"][number], { kind: "if" }>;
  expect(branch.then.map((stmt) => stmt.kind)).toEqual(["exprStmt", "return"]);
  // The census the later finish passes read agrees with the new body. A
  // kept census would answer false here, and a build with
  // SCRIPTC_CHECK_FUNCTION_CENSUS=1 would stop with an internal error.
  expect(census.hasStmt(helper, "exprStmt")).toBe(true);
});
