import { expect, test } from "vitest";
import { BOOL, F64, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { matchConstantChoice } from "./constant-choices.js";

const loc = { file: "choices.ts", start: 0, end: 0 };
const bytes = { kind: "bytes", elem: "u8" } as const;
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrExpr["type"] = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const is = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op: "===",
  left,
  right,
  type: BOOL,
  loc,
});
const store = (value: IrExpr, index: IrExpr = ref("i"), arr = "a"): IrStmt => ({
  kind: "bytesSet",
  arr: ref(arr, bytes),
  index,
  value,
  loc,
});
const branch = (cond: IrExpr, then: IrStmt[], else_: IrStmt[] | null): IrStmt => ({
  kind: "if",
  cond,
  then,
  else_,
  loc,
});
/** `if (x === c0) a[i] = r0; else if ... else a[i] = fallback`. */
function chain(cases: [number, number][], fallback: IrStmt[] | null, subject = "x"): IrStmt {
  let rest = fallback;
  for (let k = cases.length - 1; k >= 0; k--) {
    const [value, result] = cases[k]!;
    rest = [branch(is(ref(subject), num(value)), [store(num(result))], rest)];
  }
  return rest![0]!;
}

test("a chain of literal stores to one element is a constant choice", () => {
  const choice = matchConstantChoice(
    chain(
      [
        [97, 0],
        [116, 1],
        [99, 2],
      ],
      [store(num(3))],
    ),
  );
  expect(choice?.cases).toEqual([
    { value: 97, result: 0 },
    { value: 116, result: 1 },
    { value: 99, result: 2 },
  ]);
  expect(choice?.fallback).toBe(3);
  expect(choice?.stores).toHaveLength(4);
});

test("a literal on the left, -0 and a repeated value keep strict equality's first arm", () => {
  const first: IrStmt = branch(
    is(num(-0), ref("x")),
    [store(num(5))],
    [
      chain(
        [
          [1, 6],
          [0, 7],
          [2, 8],
        ],
        [store(num(9))],
      ),
    ],
  );
  expect(matchConstantChoice(first)?.cases).toEqual([
    { value: 0, result: 5 },
    { value: 1, result: 6 },
    { value: 2, result: 8 },
  ]);
});

test("chains that are not one choice of literals keep their arms", () => {
  const three: [number, number][] = [
    [1, 10],
    [2, 20],
    [3, 30],
  ];
  // Two values, no final else, a fraction, or cases spanning more than 256 values.
  expect(matchConstantChoice(chain(three.slice(0, 2), [store(num(0))]))).toBeNull();
  expect(matchConstantChoice(chain(three, null))).toBeNull();
  expect(matchConstantChoice(chain([...three, [1.5, 40]], [store(num(0))]))).toBeNull();
  expect(matchConstantChoice(chain([...three, [256, 40]], [store(num(0))]))).not.toBeNull();
  expect(matchConstantChoice(chain([...three, [257, 40]], [store(num(0))]))).toBeNull();
  // A final else that is not a literal, or that stores elsewhere.
  expect(matchConstantChoice(chain(three, [store(ref("y"))]))).toBeNull();
  expect(matchConstantChoice(chain(three, [store(num(0), ref("j"))]))).toBeNull();
  expect(matchConstantChoice(chain(three, [store(num(0), ref("i"), "b")]))).toBeNull();
  // An arm with a second statement.
  expect(matchConstantChoice(chain(three, [store(num(0)), store(num(1))]))).toBeNull();
  // A second subject.
  const mixed = branch(is(ref("y"), num(0)), [store(num(1))], [chain(three, [store(num(0))])]);
  expect(matchConstantChoice(mixed)).toBeNull();
});
