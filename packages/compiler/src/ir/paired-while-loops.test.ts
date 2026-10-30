import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { runPairedWhileLoopsAsFor } from "./paired-while-loops.js";

const loc = { file: "paired-while-loops.ts", start: 0, end: 0 };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const array = { kind: "varRef", localId: "a", type: arrayOf(F64), loc } as const;
const element = (index: IrExpr): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "arrayGet", arr: array, index, type: F64, loc },
  loc,
});
const step = (id: string, op: "+" | "-"): IrStmt => ({
  kind: "assign",
  localId: id,
  value: { kind: "bin", op, left: ref(id), right: number(1), type: F64, loc },
  loc,
});
const declare = (id: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId: id, init, loc });
const number_ = (id: string): IrLocal => ({
  id,
  name: id.split(".")[0]!,
  type: F64,
  mutable: true,
});

function whileLoop(
  body: IrStmt[] = [element(ref("lo.0")), element(ref("hi.0"))],
  updates: IrStmt[] = [step("lo.0", "+"), step("hi.0", "-")],
): IrStmt & { kind: "while" } {
  return {
    kind: "while",
    cond: { kind: "bin", op: "<", left: ref("lo.0"), right: ref("hi.0"), type: BOOL, loc },
    body: [...body, ...updates],
    loc,
  };
}

function program(body: IrStmt[], extra: Partial<IrFunction> = {}): IrModule {
  const fn: IrFunction = {
    name: "f",
    params: [{ localId: "n.0", name: "n", type: F64 }],
    returnType: F64,
    locals: [
      number_("n.0"),
      number_("lo.0"),
      number_("hi.0"),
      { id: "a", name: "a", type: arrayOf(F64), mutable: false },
    ],
    body,
    loc,
    ...extra,
  };
  return { functions: [fn], globals: [] } as unknown as IrModule;
}

const rewritten = (mod: IrModule): IrStmt[] => runPairedWhileLoopsAsFor(mod).functions[0]!.body;

test("a two-counter while loop runs as a for loop over new counters", () => {
  const mod = program([declare("lo.0", number(0)), declare("hi.0", ref("n.0")), whileLoop()]);
  const out = runPairedWhileLoopsAsFor(mod).functions[0]!;
  // The declarations stay; the loop's counters are new locals that start
  // from them, and the trailing updates are the for loop's update.
  expect(out.body.slice(0, 2)).toEqual(mod.functions[0]!.body.slice(0, 2));
  expect(out.body[2]).toMatchObject({
    kind: "for",
    init: {
      kind: "block",
      body: [
        { kind: "varDecl", localId: "lo.1", init: { kind: "varRef", localId: "lo.0" } },
        { kind: "varDecl", localId: "hi.1", init: { kind: "varRef", localId: "hi.0" } },
      ],
    },
    cond: { op: "<", left: { localId: "lo.1" }, right: { localId: "hi.1" } },
    update: { kind: "block", body: [{ localId: "lo.1" }, { localId: "hi.1" }] },
    body: [
      { expr: { kind: "arrayGet", index: { localId: "lo.1" } } },
      { expr: { kind: "arrayGet", index: { localId: "hi.1" } } },
    ],
  });
  expect(out.locals.map((l) => l.id)).toEqual(["n.0", "lo.0", "hi.0", "a", "lo.1", "hi.1"]);
});

test("parameters, reversed comparisons, labels and either update order qualify", () => {
  const loop = whileLoop(undefined, [step("hi.0", "-"), step("lo.0", "+")]);
  loop.cond = { kind: "bin", op: ">=", left: ref("hi.0"), right: ref("lo.0"), type: BOOL, loc };
  loop.labels = ["outer"];
  const mod = program([declare("lo.0", number(0)), loop], {
    params: [{ localId: "hi.0", name: "hi", type: F64 }],
  });
  expect(rewritten(mod)[1]).toMatchObject({
    kind: "for",
    labels: ["outer"],
    cond: { op: ">=", left: { localId: "hi.1" }, right: { localId: "lo.1" } },
    update: { body: [{ localId: "hi.1" }, { localId: "lo.1" }] },
  });
});

test("loops the for form would change, or whose counters are used elsewhere, stay", () => {
  const decls = [declare("lo.0", number(0)), declare("hi.0", ref("n.0"))];
  const kept = (body: IrStmt[], extra: Partial<IrFunction> = {}): void => {
    const mod = program(body, extra);
    expect(runPairedWhileLoopsAsFor(mod)).toBe(mod);
  };
  // A continue that binds to the loop skips the trailing updates.
  kept([...decls, whileLoop([{ kind: "continue", loc }, element(ref("lo.0"))])]);
  const labeled = whileLoop([{ kind: "continue", label: "outer", loc }, element(ref("lo.0"))]);
  labeled.labels = ["outer"];
  kept([...decls, labeled]);
  // A counter read after the loop, written before it, or declared twice.
  kept([...decls, whileLoop(), { kind: "return", value: ref("lo.0"), loc }]);
  kept([...decls, step("hi.0", "-"), whileLoop()]);
  kept([...decls, declare("lo.0", number(1)), whileLoop()]);
  // A declaration outside an enclosing loop: a later entry would resume
  // from the values the previous run left.
  kept([
    ...decls,
    {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      body: [whileLoop()],
      loc,
    },
  ]);
  // A parameter counter inside another loop, for the same reason.
  const outerLoop: IrStmt = {
    kind: "while",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    body: [whileLoop()],
    loc,
  };
  kept([outerLoop], {
    params: [
      { localId: "lo.0", name: "lo", type: F64 },
      { localId: "hi.0", name: "hi", type: F64 },
    ],
  });
  // A counter that was never declared, or that this function captures.
  kept([declare("lo.0", number(0)), whileLoop()]);
  kept([...decls, whileLoop()], { captures: [{ localId: "hi.0", name: "hi", type: F64 }] });
  // The body writes a counter, a counter is boxed, or no counter is an index.
  kept([...decls, whileLoop([element(ref("lo.0")), step("hi.0", "-")])]);
  const boxed = program([...decls, whileLoop()]);
  boxed.functions[0]!.locals[2] = { ...number_("hi.0"), boxed: true };
  expect(runPairedWhileLoopsAsFor(boxed)).toBe(boxed);
  kept([...decls, whileLoop([])]);
});

test("a continue in a nested loop keeps the outer loop eligible", () => {
  const inner: IrStmt = {
    kind: "while",
    cond: { kind: "boolLit", value: false, type: BOOL, loc },
    body: [{ kind: "continue", loc }],
    loc,
  };
  // Literal starts have known ranges, so the loop needs no start test and
  // may hold a nested loop.
  const mod = program([
    declare("lo.0", number(0)),
    declare("hi.0", number(9)),
    whileLoop([inner, element(ref("lo.0"))]),
  ]);
  expect(rewritten(mod)[2]).toMatchObject({ kind: "for", body: [{ kind: "while" }, {}] });
  // A start without a known range is tested at run time, on a loop that
  // may not nest another.
  const guarded = program([
    declare("lo.0", number(0)),
    declare("hi.0", ref("n.0")),
    whileLoop([inner, element(ref("lo.0"))]),
  ]);
  expect(runPairedWhileLoopsAsFor(guarded)).toBe(guarded);
});
