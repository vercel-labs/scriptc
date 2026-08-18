/* Hand-built IR for:
 *
 *   function fib(n: number): number {
 *     if (n < 2) { return n; }
 *     return fib(n - 1) + fib(n - 2);
 *   }
 *   console.log(fib(10));           // 55
 *
 * Exercises the IR (and later the C emitter) from the consumer side before
 * any frontend exists.
 */
import type { IrExpr, IrModule, SrcLoc } from "../../src/ir/nodes.js";
import { BOOL, F64, VOID } from "../../src/ir/nodes.js";

const loc: SrcLoc = { file: "fib.ts", start: 0, end: 0 };

const n = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });

export const fibModule: IrModule = {
  irVersion: 6,
  sourceFile: "fib.ts",
  entry: "__main",
  functions: [
    {
      name: "fib",
      params: [{ localId: "n.0", name: "n", type: F64 }],
      returnType: F64,
      locals: [{ id: "n.0", name: "n", type: F64, mutable: false }],
      body: [
        {
          kind: "if",
          cond: { kind: "bin", op: "<", left: n("n.0"), right: num(2), type: BOOL, loc },
          then: [{ kind: "return", value: n("n.0"), loc }],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "bin",
            op: "+",
            left: {
              kind: "call",
              callee: "fib",
              args: [{ kind: "bin", op: "-", left: n("n.0"), right: num(1), type: F64, loc }],
              type: F64,
              loc,
            },
            right: {
              kind: "call",
              callee: "fib",
              args: [{ kind: "bin", op: "-", left: n("n.0"), right: num(2), type: F64, loc }],
              type: F64,
              loc,
            },
            type: F64,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
    {
      name: "__main",
      params: [],
      returnType: VOID,
      locals: [],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "intrinsic",
            name: "console.log",
            args: [{ kind: "call", callee: "fib", args: [num(10)], type: F64, loc }],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ],
};
