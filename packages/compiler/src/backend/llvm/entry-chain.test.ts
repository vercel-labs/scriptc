import { expect, test } from "vitest";
import { BOOL, STRING, VOID, type IrFunction, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "entry-chain.ts", start: 0, end: 0 };
const call = (callee: string): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "call", callee, args: [], type: VOID, loc },
  loc,
});
const loop = (body: IrStmt[]): IrStmt => ({
  kind: "while",
  cond: { kind: "boolLit", value: false, type: BOOL, loc },
  body,
  loc,
});
const fn = (name: string, body: IrStmt[], extra: Partial<IrFunction> = {}): IrFunction => ({
  name,
  params: [],
  returnType: VOID,
  locals: [],
  body,
  loc,
  ...extra,
});
/** The entry calls both initializers; the first runs `topLevel` once and
 * `fromLoop` in a loop, the second runs `topLevel` too. */
const module = (): IrModule => ({
  irVersion: 17,
  sourceFile: loc.file,
  entry: "%main",
  functions: [
    fn("%main", [call("%init.0"), call("%init.1")]),
    fn("%init.0", [call("topLevel"), loop([call("fromLoop")]), call("%init.1")]),
    fn("%init.1", [call("topLevel")]),
    fn("topLevel", []),
    fn("fromLoop", []),
    fn("caller", [call("topLevel")]),
  ],
});

/** The emitted call of `symbol`, with its call-site attributes. */
function callOf(llvm: string, symbol: string): string[] {
  return (
    llvm.match(
      new RegExp(`^\\s*(?:%[\\w.]+ = )?(?:call|invoke) [^\\n]*@${symbol}\\([^\\n]*$`, "gm"),
    ) ?? []
  );
}

test("the C main and the entry call each other out of line", () => {
  const llvm = emitLlvmModule(module());
  // `main` to %main.
  expect(callOf(llvm, "sc_f__x25_main")).toHaveLength(1);
  expect(callOf(llvm, "sc_f__x25_main")[0]).toContain("noinline");
  // %main to each of its initializers.
  expect(callOf(llvm, "sc_f__x25_init_0")[0]).toContain("noinline");
  expect(callOf(llvm, "sc_f__x25_init_1")[0]).toContain("noinline");
});

test("the initializers call their top-level code out of line, and keep a loop's call", () => {
  const llvm = emitLlvmModule(module());
  // topLevel: once per initializer (twice here), each out of line.
  const topLevel = callOf(llvm, "sc_f_topLevel");
  // %init.0's call, %init.1's call and `caller`'s call (no attribute).
  expect(topLevel).toHaveLength(3);
  expect(topLevel.filter((line) => line.includes("noinline"))).toHaveLength(2);
  // A call inside a loop keeps LLVM's own inline decision.
  expect(callOf(llvm, "sc_f_fromLoop")[0]).not.toContain("noinline");
});

test("an initializer's dependency initializer is called out of line", () => {
  const llvm = emitLlvmModule(module());
  const initOne = callOf(llvm, "sc_f__x25_init_1");
  // Called by `main` and by %init.0.
  expect(initOne).toHaveLength(2);
  expect(initOne.every((line) => line.includes("noinline"))).toBe(true);
});

test("the attribute survives the invoke form of a may-throw call", () => {
  // Four calls above the throw: further than THROW_LEVELS, so `topLevel`
  // reports its exceptions by unwinding and its callers use `invoke`.
  const llvm = emitLlvmModule(
    {
      ...module(),
      functions: [
        fn("%main", [call("%init.0")]),
        fn("%init.0", [call("topLevel")]),
        fn("topLevel", [call("f3")]),
        fn("f3", [call("f2")]),
        fn("f2", [call("f1")]),
        fn("f1", [call("boom")]),
        fn("boom", [
          {
            kind: "throw",
            value: { kind: "strLit", value: "boom", type: STRING, loc },
            loc,
          },
        ]),
      ],
    },
    { unwindAbi: true, targetTriple: "x86_64-unknown-linux-gnu" },
  );
  const [invoke] = callOf(llvm, "sc_f_topLevel");
  expect(invoke).toContain("invoke void @sc_f_topLevel()");
  expect(invoke).toContain("noinline");
});
