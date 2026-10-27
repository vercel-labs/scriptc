import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { dispatchesCall, findIntegerClones } from "./integer-clones.js";

const loc = { file: "integer-clones.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const bin = (op: "+" | "-" | "*" | "/" | "<" | "===", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" || op === "===" ? BOOL : F64,
  loc,
});
const call = (callee: string, args: IrExpr[], type: IrType = F64): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const stmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
const ternary = (cond: IrExpr, then: IrExpr, else_: IrExpr): IrExpr => ({
  kind: "ternary",
  cond,
  then,
  else_,
  type: then.type,
  loc,
});
function fn(
  name: string,
  params: string[],
  body: IrStmt[],
  returnType: IrType = F64,
  types: IrType[] = [],
): IrFunction {
  return {
    name,
    params: params.map((id, i) => ({ localId: id, name: id, type: types[i] ?? F64 })),
    locals: params.map((id, i) => ({ id, name: id, type: types[i] ?? F64, mutable: true })),
    returnType,
    body,
    loc,
  };
}

// fib(n) = n < 2 ? n : fib(n - 1) + fib(n - 2)
const fib = fn(
  "fib",
  ["n"],
  [
    ret(
      ternary(
        bin("<", ref("n"), num(2)),
        ref("n"),
        bin(
          "+",
          call("fib", [bin("-", ref("n"), num(1))]),
          call("fib", [bin("-", ref("n"), num(2))]),
        ),
      ),
    ),
  ],
);

function module(): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      fn(
        "main",
        [],
        [
          stmt(call("fib", [num(30)])),
          stmt(call("isEven", [num(7)], BOOL)),
          stmt(call("halves", [num(8)])),
          stmt(call("helped", [num(8)])),
          stmt({ kind: "closure", fnName: "fib", captures: [], type: funcOf([F64], F64), loc }),
        ],
        VOID,
      ),
      fib,
      // Mutual recursion with boolean results.
      fn(
        "isEven",
        ["n"],
        [
          ret(
            ternary(
              bin("===", ref("n"), num(0)),
              { kind: "boolLit", value: true, type: BOOL, loc },
              call("isOdd", [bin("-", ref("n"), num(1))], BOOL),
            ),
          ),
        ],
        BOOL,
      ),
      fn(
        "isOdd",
        ["n"],
        [
          ret(
            ternary(
              bin("===", ref("n"), num(0)),
              { kind: "boolLit", value: false, type: BOOL, loc },
              call("isEven", [bin("-", ref("n"), num(1))], BOOL),
            ),
          ),
        ],
        BOOL,
      ),
      // Division can leave the integers: no clone.
      fn(
        "halves",
        ["n"],
        [
          ret(
            ternary(
              bin("<", ref("n"), num(1)),
              ref("n"),
              call("halves", [bin("/", ref("n"), num(2))]),
            ),
          ),
        ],
      ),
      // A recursive member calling a non-recursive member.
      fn(
        "helped",
        ["n"],
        [
          ret(
            ternary(
              bin("<", ref("n"), num(1)),
              num(0),
              bin("+", call("helper", [ref("n")]), call("helped", [bin("-", ref("n"), num(1))])),
            ),
          ),
        ],
      ),
      fn("helper", ["n"], [ret(bin("*", ref("n"), num(3)))]),
    ],
  };
}

function define(llvm: string, symbol: string): string {
  const escaped = symbol.replace(/\./g, "\\.");
  return new RegExp(`^define internal [^\\n]*@${escaped}\\([^]*?^}`, "m").exec(llvm)![0];
}

test("pure number functions get clones; recursive ones get dispatchers", () => {
  const clones = findIntegerClones(module());
  expect([...clones.members].sort()).toEqual(["fib", "helped", "helper", "isEven", "isOdd"]);
  expect([...clones.dispatched].sort()).toEqual(["fib", "helped", "isEven", "isOdd"]);
  expect(clones.component.get("isEven")).toBe(clones.component.get("isOdd"));
  expect(dispatchesCall(clones, "main", "fib")).toBe(true);
  expect(dispatchesCall(clones, "fib", "fib")).toBe(false);
  expect(dispatchesCall(clones, "isOdd", "isEven")).toBe(false);
  expect(dispatchesCall(clones, "helped", "helper")).toBe(false);
  expect(dispatchesCall(clones, "fib", "isEven")).toBe(true);
});

test("pure functions no recursive member reaches get no clone", () => {
  const mod = module();
  mod.functions.push(fn("double", ["n"], [ret(bin("*", ref("n"), num(2)))]));
  mod.functions[0]!.body.push(stmt(call("double", [num(4)])));
  expect(validateModule(mod)).toEqual([]);
  expect(findIntegerClones(mod).members.has("double")).toBe(false);
  // Without recursion there is nothing to clone.
  const flat: IrModule = { ...mod, functions: [mod.functions[0]!, mod.functions.at(-1)!] };
  flat.functions[0] = fn("main", [], [stmt(call("double", [num(4)]))], VOID);
  expect(findIntegerClones(flat).members.size).toBe(0);
});

test("a call to a non-member disqualifies the caller", () => {
  const mod = module();
  mod.functions.push(fn("usesHalves", ["n"], [ret(bin("+", call("halves", [ref("n")]), num(1)))]));
  expect(findIntegerClones(mod).members.has("usesHalves")).toBe(false);
});

test("non-int32 literals and -0 disqualify a function", () => {
  for (const value of [0.5, -0, 2 ** 31, NaN]) {
    const mod = module();
    mod.functions.push(
      fn(
        "lit",
        ["n"],
        [
          ret(
            ternary(
              bin("<", ref("n"), num(1)),
              num(value),
              call("lit", [bin("-", ref("n"), num(1))]),
            ),
          ),
        ],
      ),
    );
    expect(findIntegerClones(mod).members.has("lit")).toBe(false);
  }
});

test("the clone loops over its accumulating self call and outside callers dispatch", () => {
  const mod = module();
  expect(validateModule(mod)).toEqual([]);
  const llvm = emitLlvmModule(mod);
  const clone = define(llvm, "sc_f_fib.int");
  expect(clone).toContain("define internal { i32, i1 } @sc_f_fib.int(i32 %a0)");
  // One recursive call per level: fib(n - 2) is the loop's next iteration.
  expect(clone.match(/= call \{ i32, i1 \} @sc_f_fib\.int\(/g)).toHaveLength(1);
  // Accumulating iterations lower the virtual stack pointer by a frame.
  expect(clone).toMatch(/sub i64 %t\d+, 32/);
  expect(clone).toMatch(/br label %tail\d+/);
  expect(clone).toContain("call void @scr_stack_overflow()");
  expect(clone).toContain("ret { i32, i1 } { i32 poison, i1 true }");
  expect(clone).not.toContain("double");
  const dispatch = define(llvm, "sc_f_fib.spec");
  expect(dispatch).toContain("call i32 @llvm.fptosi.sat.i32.f64(double %p0)");
  expect(dispatch).toContain("call { i32, i1 } @sc_f_fib.int(i32 %i0)");
  expect(dispatch).toContain("%o = call double @sc_f_fib(double %p0)");
  const main = define(llvm, "sc_f_main");
  expect(main).toContain("@sc_f_fib.spec(");
  expect(main).toContain("call i1 @sc_f_isEven.i32.spec(i32 7)");
  expect(main).not.toContain("@sc_f_halves.spec(");
  // The ordinary body stays the fallback: it calls itself directly.
  expect(define(llvm, "sc_f_fib")).not.toContain(".spec(");
  // The closure keeps the ordinary entry.
  expect(llvm).not.toMatch(/ptr @sc_f_fib\.(spec|int)\b/);
  // Boolean clones forward BAIL from mutual calls: a plain mutual tail call
  // returns the callee's result as is and, like the ordinary body's tail
  // call, carries no virtual stack.
  const even = define(llvm, "sc_f_isEven.int");
  expect(even).toContain("define internal { i32, i1 } @sc_f_isEven.int(i32 %a0)");
  expect(even).toMatch(
    /= tail call \{ i32, i1 \} @sc_f_isOdd\.int\(i32 %t\d+\)\n\s*ret \{ i32, i1 \} %t\d+/,
  );
  expect(even).not.toContain("virtual stack pointer");
  expect(define(llvm, "sc_f_helped.int")).toContain("call { i32, i1 } @sc_f_helper.int(");
  expect(llvm).not.toContain("@sc_f_helper.spec");
});

test("sums the static integer ranges prove skip the overflow check", () => {
  // count(n) = n < 1 ? 0 : 1 + count(n - 1), only ever called with 10:
  // n is within [0, 10], so n - 1 cannot overflow; the accumulated sum is
  // still checked.
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      fn("main", [], [stmt(call("count", [num(10)]))], VOID),
      fn(
        "count",
        ["n"],
        [
          ret(
            ternary(
              bin("<", ref("n"), num(1)),
              num(0),
              bin("+", num(1), call("count", [bin("-", ref("n"), num(1))])),
            ),
          ),
        ],
      ),
    ],
  };
  expect(validateModule(mod)).toEqual([]);
  const clone = define(emitLlvmModule(mod), "sc_f_count.int");
  expect(clone).toMatch(/= sub nsw i32 %t\d+, 1/);
  expect(clone).not.toContain("@llvm.ssub.with.overflow");
  expect(clone).toContain("@llvm.sadd.with.overflow.i32");
  // The accumulating loop is real recursion in the ordinary body.
  expect(clone).toContain("virtual stack pointer");
});

test("debug and library builds emit no clones", () => {
  const debug = emitLlvmModule(module(), {
    debugSources: new Map([[loc.file, "function main() {}"]]),
  });
  expect(debug).not.toContain(".int(");
  expect(debug).not.toContain(".spec(");
});

test("borrowed number arrays: length and element reads qualify", () => {
  const arr: IrType = { kind: "array", elem: F64 };
  const a = ref("a", arr);
  const length: IrExpr = {
    kind: "arrIntrinsic",
    method: "length",
    receiver: a,
    args: [],
    type: F64,
    loc,
  };
  const element: IrExpr = { kind: "arrayGet", arr: a, index: ref("i"), type: F64, loc };
  // sum(a, i) = i < a.length ? a[i] + sum(a, i + 1) : 0
  const sum = fn(
    "sum",
    ["a", "i"],
    [
      ret(
        ternary(
          bin("<", ref("i"), length),
          bin("+", element, call("sum", [a, bin("+", ref("i"), num(1))])),
          num(0),
        ),
      ),
    ],
    F64,
    [arr, F64],
  );
  const mod: IrModule = { irVersion: 17, sourceFile: loc.file, entry: "sum", functions: [sum] };
  expect(findIntegerClones(mod).members.has("sum")).toBe(false);
  expect(findIntegerClones(mod, () => false).members.has("sum")).toBe(false);
  const clones = findIntegerClones(mod, (name, index) => name === "sum" && index === 0);
  expect(clones.dispatched.has("sum")).toBe(true);
  // Arrays of other elements never qualify.
  const strings: IrType = { kind: "array", elem: { kind: "string" } };
  const other = fn("other", ["s"], [ret(num(1))], F64, [strings]);
  const withOther: IrModule = { ...mod, functions: [sum, other] };
  expect(findIntegerClones(withOther, () => true).members.has("other")).toBe(false);
});
