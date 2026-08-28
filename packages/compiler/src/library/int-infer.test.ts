/* The ask-4 reference corpus (§3 of the reference package), ported to
 * scriptc's IR as hand-built modules — the fast pin on the inference
 * itself (domain, transfer semantics, branch refinement, widening). The
 * same sixteen programs run end-to-end through compileLibrary as
 * library-mode fixtures in tests/harness/library-int.test.ts; this file
 * is the millisecond-scale twin that points at the analysis when the two
 * disagree.
 *
 * The corpus convention maps onto scriptc as declared integer PARAMETER
 * slots: `send(x)` is a call whose callee's first parameter the config
 * declares i64 (slot path Msg.count), `sendU64(x)` u64 (Msg.id). */
import { describe, expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrNumBinOp, IrStmt } from "../ir/ir.js";
import {
  checkLibraryIntegerSlots,
  type IntSlotConfig,
  type IntVerdict,
  SAFE_MAX,
  SAFE_MIN,
} from "./int-infer.js";

const loc = { file: "corpus.ts", start: 0, end: 0 };
const F64 = { kind: "f64" } as const;
const STRING = { kind: "string" } as const;
const BOOL = { kind: "bool" } as const;
const VOID = { kind: "void" } as const;
const MODEL = { kind: "record", shapeId: "model-shape" } as const;
const MODEL_CLASS = { kind: "object", className: "Model" } as const;
const OPTIONAL_NUMBER = { kind: "union", unionId: "optional-number" } as const;
const RESIZE_MSG = { kind: "union", unionId: "resize-msg" } as const;
const RESIZED = { kind: "record", shapeId: "resized-shape" } as const;
const NOOP = { kind: "record", shapeId: "noop-shape" } as const;

const num = (value: number, spelling?: string): IrExpr =>
  spelling === undefined
    ? { kind: "numLit", value, type: F64, loc }
    : { kind: "numLit", value, spelling, type: F64, loc };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const bin = (op: IrNumBinOp, left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin", op, left, right, type: op === "<" || op === "<=" || op === ">" || op === ">=" || op === "===" || op === "!==" ? BOOL : F64, loc,
});
const and = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "logical", op: "&&", left, right, type: BOOL, loc });
const math = (fn: string, ...args: IrExpr[]): IrExpr => ({ kind: "libCall", fn: `math.${fn}`, args, type: F64, loc } as IrExpr);
const send = (value: IrExpr, callee = "send"): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "call", callee, args: [value], type: VOID, loc },
  loc,
});
const decl = (localId: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId, init, loc });
const assign = (localId: string, value: IrExpr): IrStmt => ({ kind: "assign", localId, value, loc });
const iff = (cond: IrExpr, then: IrStmt[]): IrStmt => ({ kind: "if", cond, then, else_: null, loc });
const forLoop = (init: IrStmt, cond: IrExpr, update: IrStmt, body: IrStmt[]): IrStmt => ({
  kind: "for", init, cond, update, body, loc,
});

const sink = (name: string): IrFunction => ({
  name,
  params: [{ localId: "x.0", name: "x", type: F64 }],
  returnType: VOID,
  locals: [{ id: "x.0", name: "x", type: F64, mutable: true }],
  body: [],
  loc,
});

/** A module holding the case function plus the two declared sinks. */
function caseModule(params: string[], locals: string[], body: IrStmt[]): IrModule {
  return {
    irVersion: 6,
    sourceFile: "corpus.ts",
    functions: [
      sink("send"),
      sink("sendU64"),
      {
        name: "case",
        params: params.map((p) => ({ localId: `${p}.0`, name: p, type: F64 })),
        returnType: VOID,
        locals: [...params, ...locals].map((p) => ({ id: `${p}.0`, name: p, type: F64, mutable: true })),
        body,
        loc,
      },
    ],
    entry: "case",
  };
}

const CFG: IntSlotConfig = {
  fns: new Map([
    ["send", { fnName: "send", params: ["i64"], paramPaths: ["Msg.count"], ret: null, retPath: null, paramSeeds: [null] }],
    ["sendU64", { fnName: "sendU64", params: ["u64"], paramPaths: ["Msg.id"], ret: null, retPath: null, paramSeeds: [null] }],
  ]),
  records: new Map(),
};

function verdicts(mod: IrModule): IntVerdict[] {
  return checkLibraryIntegerSlots(mod, CFG);
}

function only(mod: IrModule): IntVerdict {
  const vs = verdicts(mod);
  expect(vs.length).toBe(1);
  return vs[0]!;
}

const recordRef = (name = "m"): IrExpr => ({ kind: "varRef", localId: `${name}.0`, type: MODEL, loc });
const countRead = (name = "m"): IrExpr => ({
  kind: "recordGet",
  obj: recordRef(name),
  shapeId: MODEL.shapeId,
  field: "count",
  type: F64,
  loc,
});
const labelRead = (name = "m"): IrExpr => ({
  kind: "recordGet",
  obj: recordRef(name),
  shapeId: MODEL.shapeId,
  field: "label",
  type: STRING,
  loc,
});
const countWrite = (value: IrExpr, name = "m"): IrStmt => ({
  kind: "recordSet",
  obj: recordRef(name),
  shapeId: MODEL.shapeId,
  field: "count",
  value,
  loc,
});

const RECORD_CFG: IntSlotConfig = {
  fns: new Map(),
  records: new Map([
    [MODEL.shapeId, new Map([["count", { cls: "i64", paths: ["Model.count"] }]])],
  ]),
};

function recordCase(body: IrStmt[], names = ["m"], extraFns: IrFunction[] = []): IrModule {
  return {
    irVersion: 6,
    sourceFile: "fields.ts",
    functions: [
      ...extraFns,
      {
        name: "case",
        params: names.map((name) => ({ localId: `${name}.0`, name, type: MODEL })),
        returnType: VOID,
        locals: names.map((name) => ({ id: `${name}.0`, name, type: MODEL, mutable: true })),
        body,
        loc,
      },
    ],
    entry: "case",
  };
}

function onlyRecord(body: IrStmt[], names = ["m"], extraFns: IrFunction[] = []): IntVerdict {
  const vs = checkLibraryIntegerSlots(recordCase(body, names, extraFns), RECORD_CFG);
  expect(vs.length).toBe(1);
  return vs[0]!;
}

function onlyOrdinaryRecord(body: IrStmt[], extraFns: IrFunction[] = []): IntVerdict {
  const vs = checkLibraryIntegerSlots(recordCase(body, ["m"], [sink("send"), ...extraFns]), CFG);
  expect(vs.length).toBe(1);
  return vs[0]!;
}

const classRef = (): IrExpr => ({ kind: "varRef", localId: "m.0", type: MODEL_CLASS, loc });
const classCountRead = (): IrExpr => ({
  kind: "fieldGet",
  obj: classRef(),
  className: MODEL_CLASS.className,
  field: "count",
  type: F64,
  loc,
});

function onlyOrdinaryClass(body: IrStmt[]): IntVerdict {
  const mod: IrModule = {
    irVersion: 6,
    sourceFile: "class-fields.ts",
    functions: [
      sink("send"),
      {
        name: "case",
        params: [{ localId: "m.0", name: "m", type: MODEL_CLASS }],
        returnType: VOID,
        locals: [{ id: "m.0", name: "m", type: MODEL_CLASS, mutable: true }],
        body,
        loc,
      },
    ],
    entry: "case",
  };
  const vs = checkLibraryIntegerSlots(mod, CFG);
  expect(vs.length).toBe(1);
  return vs[0]!;
}

const noopFn = (name: string, returnsBool = false): IrFunction => ({
  name,
  params: [],
  returnType: returnsBool ? BOOL : VOID,
  locals: [],
  body: returnsBool ? [{ kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }] : [],
  loc,
});

describe("the ask-4 conformance corpus over scriptc IR", () => {
  test("1. max-safe-integer-exact — PROVE, crossing value 9007199254740991", () => {
    const v = only(caseModule([], [], [send(bin("-", bin("**", num(2), num(53)), num(1)))]));
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(9007199254740991);
    expect(v.provenHi).toBe(9007199254740991);
  });

  test("2. literal-not-representable — REFUSE on the SPELLING, not the rounded value", () => {
    // The frontend threads the source spelling exactly when it does not
    // round-trip; the value the program held is the nearest double.
    const v = only(caseModule([], [], [send(num(9007199254740992, "9007199254740993"))]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("representability");
    expect(v.detail).toContain("9007199254740993");
    expect(v.detail).toContain("9007199254740992");
  });

  test("3. proven-range-overflow — REFUSE, range (2^60 past the provable bound)", () => {
    const v = only(
      caseModule(["a"], ["t"], [
        iff(and(bin(">=", ref("a.0"), num(0)), bin("<=", ref("a.0"), num(2 ** 30))), [
          decl("t.0", math("trunc", ref("a.0"))),
          send(bin("*", ref("t.0"), ref("t.0"))),
        ]),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("4. negative-zero-crosses-as-zero — PROVE, crossing value 0", () => {
    const v = only(caseModule([], [], [send(num(-0))]));
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(Object.is(v.provenLo, 0) && !Object.is(v.provenLo, -0)).toBe(true);
  });

  test("5. times-half-unprovable — REFUSE, wholeness (range and NaN already proven)", () => {
    const v = only(
      caseModule(["a"], ["t"], [
        iff(and(bin(">=", ref("a.0"), num(0)), bin("<=", ref("a.0"), num(1000))), [
          decl("t.0", bin("*", ref("a.0"), num(0.5))),
          send(ref("t.0")),
        ]),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
    expect(v.detail).toContain("non-integers"); // fractional, NOT the NaN wording
  });

  test("6. times-half-with-trunc — PROVE, crossing range [0, 500]", () => {
    const v = only(
      caseModule(["a"], ["t"], [
        iff(and(bin(">=", ref("a.0"), num(0)), bin("<=", ref("a.0"), num(1000))), [
          decl("t.0", bin("*", ref("a.0"), num(0.5))),
          send(math("trunc", ref("t.0"))),
        ]),
      ]),
    );
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(500);
  });

  test("7. bounded-counter-loop — PROVE precisely [0, 9] (the anti-trigger-happiness gate)", () => {
    const v = only(
      caseModule([], ["n"], [
        forLoop(decl("n.0", num(0)), bin("<", ref("n.0"), num(10)), assign("n.0", bin("+", ref("n.0"), num(1))), [
          send(ref("n.0")),
        ]),
      ]),
    );
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(9); // exact — a widened bound here is a failed port
  });

  test("8. division-non-integer — REFUSE, wholeness", () => {
    const v = only(caseModule([], [], [send(bin("/", num(7), num(2)))]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
  });

  test("9. remainder-negative-dividend — PROVE, crossing value -1 (JS sign rule)", () => {
    const v = only(caseModule([], [], [send(bin("%", num(-7), num(3)))]));
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(-1);
    expect(v.provenHi).toBe(-1);
  });

  test("10. bitwise-or-int32 — PROVE int32 range whatever the input (ToInt32 contract)", () => {
    const v = only(caseModule(["a"], [], [send(bin("|", ref("a.0"), num(0)))]));
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(-(2 ** 31));
    expect(v.provenHi).toBe(2 ** 31 - 1);
  });

  test("11. unsigned-shift-u64 — PROVE, uint32 fits a u64 slot", () => {
    const v = only(caseModule(["a"], [], [send(bin(">>>", ref("a.0"), num(0)), "sendU64")]));
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(2 ** 32 - 1);
  });

  test("12. u64-negative-proven-range — REFUSE, range (negatives cannot enter u64)", () => {
    const v = only(
      caseModule(["a"], ["t"], [
        iff(and(bin(">=", ref("a.0"), num(-100)), bin("<=", ref("a.0"), num(100))), [
          decl("t.0", math("trunc", ref("a.0"))),
          send(ref("t.0"), "sendU64"),
        ]),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
    expect(v.detail).toContain("non-negative");
  });

  test("13. conditional-range-refinement — PROVE, crossing range [2, 6]", () => {
    const v = only(
      caseModule(["a"], [], [
        iff(and(bin(">=", ref("a.0"), num(2)), bin("<=", ref("a.0"), num(6))), [
          send(math("round", ref("a.0"))),
        ]),
      ]),
    );
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(2);
    expect(v.provenHi).toBe(6);
  });

  test("14. data-dependent-loop-bound — REFUSE, range ([0, ∞) is unprovable)", () => {
    const v = only(
      caseModule(["m"], ["n"], [
        forLoop(decl("n.0", num(0)), bin("<", ref("n.0"), ref("m.0")), assign("n.0", bin("+", ref("n.0"), num(1))), [
          send(ref("n.0")),
        ]),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("15. nan-reaches-slot — REFUSE, wholeness (0/0 is NaN)", () => {
    const v = only(caseModule([], [], [send(bin("/", num(0), num(0)))]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
    expect(v.detail).toContain("NaN");
  });

  test("16. infinity-reaches-slot — REFUSE, range (1/0 is Infinity)", () => {
    const v = only(caseModule([], [], [send(bin("/", num(1), num(0)))]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
    expect(v.detail).toContain("Infinity");
  });
});

describe("the domain's edges beyond the corpus", () => {
  test("a declared i64 parameter seeds whole-in-safe-range inside its own function", () => {
    // send's own body forwards its parameter to sendU64: the i64 seed is
    // whole and in ±(2^53−1), but may be negative — the u64 slot refuses
    // on range, proving the seed is neither TOP nor blindly trusted.
    const mod = caseModule([], [], []);
    (mod.functions[0]!.body as IrStmt[]).push(send(ref("x.0"), "sendU64"));
    const vs = checkLibraryIntegerSlots(mod, CFG);
    expect(vs.length).toBe(1);
    expect(vs[0]!.outcome).toBe("refuse");
    expect(vs[0]!.obligation).toBe("range");
    expect(vs[0]!.detail).toContain(`[${SAFE_MIN}, ${SAFE_MAX}]`);
  });

  test("a matching unit tag makes an optional return vacuous", () => {
    const x: IrExpr = { kind: "varRef", localId: "x.0", type: OPTIONAL_NUMBER, loc };
    const one: IrExpr = {
      kind: "unionWrap",
      unionId: OPTIONAL_NUMBER.unionId,
      tag: 0,
      value: num(1),
      type: OPTIONAL_NUMBER,
      loc,
    };
    const mod: IrModule = {
      irVersion: 6,
      sourceFile: "optional.ts",
      functions: [{
        name: "normalize",
        params: [{ localId: "x.0", name: "x", type: OPTIONAL_NUMBER }],
        returnType: OPTIONAL_NUMBER,
        locals: [{ id: "x.0", name: "x", type: OPTIONAL_NUMBER, mutable: true }],
        body: [
          {
            kind: "if",
            cond: {
              kind: "unionIsTag",
              unionId: OPTIONAL_NUMBER.unionId,
              tag: 1,
              negated: false,
              value: x,
              type: BOOL,
              loc,
            },
            then: [{ kind: "return", value: x, loc }],
            else_: null,
            loc,
          },
          { kind: "return", value: one, loc },
        ],
        loc,
      }],
      unions: [{
        id: OPTIONAL_NUMBER.unionId,
        arms: [F64, { kind: "nullT" }],
      }],
      entry: "normalize",
    };
    const cfg: IntSlotConfig = {
      fns: new Map([[
        "normalize",
        {
          fnName: "normalize",
          params: [null],
          paramPaths: [null],
          ret: "u64",
          retPath: "helpers.normalize.return",
          paramSeeds: [null],
        },
      ]]),
      records: new Map(),
    };
    const vs = checkLibraryIntegerSlots(mod, cfg);
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.outcome === "prove")).toBe(true);
    expect(Number.isNaN(vs[0]!.provenLo)).toBe(true);
    expect(vs[1]!.provenLo).toBe(1);
  });

  test("a guard that only excludes NaN still refuses on the unbounded range", () => {
    // if (a === a) send(a) — NaN excluded, but the interval stays ±∞.
    const v = only(caseModule(["a"], [], [iff(bin("===", ref("a.0"), ref("a.0")), [send(ref("a.0"))])]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test.each([
    ["<", 6],
    ["<=", 5],
    [">", 4],
    [">=", 5],
  ] as const)("a failed %s comparison preserves NaN", (op, bound) => {
    // x is either the whole number 5 or NaN. The numeric member satisfies
    // every comparison in this table, so only NaN reaches the false edge.
    // Treating that edge as the negated ordered comparison would incorrectly
    // make it vacuous and prove the integer crossing.
    const v = only(
      caseModule(["a"], ["x"], [
        decl("x.0", num(5)),
        iff(bin("===", ref("a.0"), num(0)), [assign("x.0", bin("/", num(0), num(0)))]),
        iff(bin(op, ref("x.0"), num(bound)), [{ kind: "return", value: null, loc }]),
        send(ref("x.0")),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
    expect(v.detail).toContain("NaN");
  });

  test.each([
    ["<", 1],
    ["<=", 1],
    [">", 0],
    [">=", 0],
  ] as const)("a failed %s comparison does not narrow through a NaN right operand", (op, numericY) => {
    // x is always the non-integer 0.5. The numeric member of y makes the
    // comparison true, but NaN makes it false without constraining x.
    const v = only(
      caseModule(["a"], ["x", "y"], [
        decl("x.0", num(0.5)),
        decl("y.0", num(numericY)),
        iff(bin("===", ref("a.0"), num(0)), [assign("y.0", bin("/", num(0), num(0)))]),
        iff(bin(op, ref("x.0"), ref("y.0")), [{ kind: "return", value: null, loc }]),
        send(ref("x.0")),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
  });

  test.each([
    ["<", 0],
    ["<=", 0],
    [">", 1],
    [">=", 1],
  ] as const)("a failed %s comparison does not narrow through a NaN left operand", (op, numericY) => {
    // The symmetric case: y may be NaN, so a failed comparison cannot
    // constrain the non-integer x on the right-hand side.
    const v = only(
      caseModule(["a"], ["x", "y"], [
        decl("x.0", num(0.5)),
        decl("y.0", num(numericY)),
        iff(bin("===", ref("a.0"), num(0)), [assign("y.0", bin("/", num(0), num(0)))]),
        iff(bin(op, ref("y.0"), ref("x.0")), [{ kind: "return", value: null, loc }]),
        send(ref("x.0")),
      ]),
    );
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
  });

  test("a failed !== comparison clears NaN and proves equality", () => {
    // The true edge consumes the NaN alternative; falling through proves
    // x === 5, so the integer crossing is exact and NaN-free.
    const v = only(
      caseModule(["a"], ["x"], [
        decl("x.0", num(5)),
        iff(bin("===", ref("a.0"), num(0)), [assign("x.0", bin("/", num(0), num(0)))]),
        iff(bin("!==", ref("x.0"), num(5)), [{ kind: "return", value: null, loc }]),
        send(ref("x.0")),
      ]),
    );
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(5);
    expect(v.provenHi).toBe(5);
  });

  test("the arithmetic twin of the representability case refuses on RANGE", () => {
    // 2^53 + 1 computed arithmetically: no spelling, whole, but past the
    // provable bound — the failed obligation is range, never
    // representability (a computed value is not the author's literal).
    const v = only(caseModule([], [], [send(bin("+", bin("**", num(2), num(53)), num(1)))]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("a while-loop spelling of the counter proves the same exact bound", () => {
    const v = only(
      caseModule([], ["n"], [
        decl("n.0", num(0)),
        { kind: "while", cond: bin("<", ref("n.0"), num(10)), body: [send(ref("n.0")), assign("n.0", bin("+", ref("n.0"), num(1)))], loc },
      ]),
    );
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(9);
  });

  test("break carries its refined state out of the loop", () => {
    // for (;;) { if (n >= 5) break; send(n); n = n + 1 } send(n)
    const v = verdicts(
      caseModule([], ["n"], [
        decl("n.0", num(0)),
        {
          kind: "for", init: null, cond: null, update: null, loc,
          body: [
            iff(bin(">=", ref("n.0"), num(5)), [{ kind: "break", loc }]),
            send(ref("n.0")),
            assign("n.0", bin("+", ref("n.0"), num(1))),
          ],
        },
        send(ref("n.0")),
      ]),
    );
    expect(v.length).toBe(2);
    expect(v[0]!.outcome).toBe("prove"); // inside: [0, 4] — the fall-through edge's refinement
    expect(v[0]!.provenLo).toBe(0);
    expect(v[0]!.provenHi).toBe(4);
    // After the break: the header widened (no condition bounds it), so the
    // break edge proves [5, 2^31−1] — lo refined exactly, hi at the
    // widening threshold, still comfortably inside the slot.
    expect(v[1]!.outcome).toBe("prove");
    expect(v[1]!.provenLo).toBe(5);
    expect(v[1]!.provenHi).toBe(2 ** 31 - 1);
  });

  test("Math.min/max propagate NaN from any argument, as JS does", () => {
    const v = only(caseModule(["a"], [], [send(math("min", math("trunc", ref("a.0")), num(0)))]));
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
    expect(v.detail).toContain("NaN");
  });
});

describe("straight-line ordinary-field refinement", () => {
  test("ordered comparisons refine a repeated record field into Math.trunc", () => {
    const v = onlyOrdinaryRecord([
      iff(and(bin(">=", countRead(), num(0)), bin("<=", countRead(), num(100))), [
        send(math("trunc", countRead())),
      ]),
    ]);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(100);
  });

  test("an unrelated string !== conjunct preserves the numeric field facts", () => {
    const labelIsNotSkip: IrExpr = {
      kind: "strEq",
      negated: true,
      left: labelRead(),
      right: { kind: "strLit", value: "skip", type: STRING, loc },
      type: BOOL,
      loc,
    };
    const range = and(bin(">=", countRead(), num(0)), bin("<=", countRead(), num(100)));
    const v = onlyOrdinaryRecord([
      iff(and(labelIsNotSkip, range), [send(math("trunc", countRead()))]),
    ]);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(100);
  });

  test("a union discriminant conjunct preserves narrowed payload-field facts", () => {
    const msgRef = (): IrExpr => ({ kind: "varRef", localId: "msg.0", type: RESIZE_MSG, loc });
    const widthRead = (): IrExpr => ({
      kind: "recordGet",
      obj: {
        kind: "unionNarrow",
        unionId: RESIZE_MSG.unionId,
        tag: 1,
        value: msgRef(),
        type: RESIZED,
        loc,
      },
      shapeId: RESIZED.shapeId,
      field: "w",
      type: F64,
      loc,
    });
    const isResized: IrExpr = {
      kind: "strEq",
      negated: false,
      left: {
        kind: "unionDisc",
        unionId: RESIZE_MSG.unionId,
        field: "kind",
        value: msgRef(),
        type: STRING,
        loc,
      },
      right: { kind: "strLit", value: "resized", type: STRING, loc },
      type: BOOL,
      loc,
    };
    const mod = recordCase([
      iff(and(isResized, and(bin(">=", widthRead(), num(0)), bin("<=", widthRead(), num(65535)))), [
        send(math("trunc", widthRead())),
      ]),
    ], ["msg"], [sink("send")]);
    mod.functions[1]!.params[0]!.type = RESIZE_MSG;
    mod.functions[1]!.locals[0]!.type = RESIZE_MSG;
    mod.unions = [{ id: RESIZE_MSG.unionId, arms: [NOOP, RESIZED] }];

    const v = only(mod);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(65535);
  });

  test("a union discriminant read preserves an existing field fact", () => {
    const msgRef = (): IrExpr => ({ kind: "varRef", localId: "msg.0", type: RESIZE_MSG, loc });
    const isResized: IrExpr = {
      kind: "strEq",
      negated: false,
      left: {
        kind: "unionDisc",
        unionId: RESIZE_MSG.unionId,
        field: "kind",
        value: msgRef(),
        type: STRING,
        loc,
      },
      right: { kind: "strLit", value: "resized", type: STRING, loc },
      type: BOOL,
      loc,
    };
    const mod = recordCase([
      iff(bin(">=", countRead(), num(0)), [
        iff(and(isResized, bin("<=", countRead(), num(100))), [
          send(math("trunc", countRead()), "sendU64"),
        ]),
      ]),
    ], ["m", "msg"], [sink("sendU64")]);
    mod.functions[1]!.params[1]!.type = RESIZE_MSG;
    mod.functions[1]!.locals[1]!.type = RESIZE_MSG;
    mod.unions = [{ id: RESIZE_MSG.unionId, arms: [NOOP, RESIZED] }];

    const v = only(mod);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(100);
  });

  test("ordered comparisons refine a repeated class field into Math.trunc", () => {
    const v = onlyOrdinaryClass([
      iff(and(bin(">=", classCountRead(), num(0)), bin("<=", classCountRead(), num(100))), [
        send(math("trunc", classCountRead())),
      ]),
    ]);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(0);
    expect(v.provenHi).toBe(100);
  });

  test("a call between an ordinary-field guard and use kills the proof", () => {
    const call: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "call", callee: "touch", args: [], type: VOID, loc },
      loc,
    };
    const v = onlyOrdinaryRecord([
      iff(and(bin(">=", countRead(), num(0)), bin("<=", countRead(), num(100))), [
        call,
        send(math("trunc", countRead())),
      ]),
    ], [noopFn("touch")]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
    expect(v.detail).toContain("NaN");
  });

  test("a heap write between an ordinary-field guard and use kills the proof", () => {
    const otherWrite: IrStmt = {
      kind: "recordSet",
      obj: recordRef(),
      shapeId: MODEL.shapeId,
      field: "other",
      value: num(0),
      loc,
    };
    const v = onlyOrdinaryRecord([
      iff(and(bin(">=", countRead(), num(0)), bin("<=", countRead(), num(100))), [
        otherWrite,
        send(math("trunc", countRead())),
      ]),
    ]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("wholeness");
    expect(v.detail).toContain("NaN");
  });
});

describe("straight-line declared-field refinement", () => {
  test("recordClone checks explicit integer-slot overrides", () => {
    const clone: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "recordClone",
        source: recordRef(),
        overrides: [{ name: "count", value: math("trunc", num(42)) }],
        type: MODEL,
        loc,
      },
      loc,
    };
    const v = onlyRecord([clone]);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(42);
    expect(v.provenHi).toBe(42);
  });

  test("an if guard refines the repeated field read through its boundary write", () => {
    const v = onlyRecord([
      iff(bin("<", countRead(), num(1000)), [
        countWrite(bin("+", countRead(), num(1))),
      ]),
    ]);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(SAFE_MIN + 1);
    expect(v.provenHi).toBe(1000);
  });

  test("a ternary condition shares the field refinement path", () => {
    const value: IrExpr = {
      kind: "ternary",
      cond: bin("<", countRead(), num(1000)),
      then: bin("+", countRead(), num(1)),
      else_: num(0),
      type: F64,
      loc,
    };
    const v = onlyRecord([countWrite(value)]);
    expect(v.outcome).toBe("prove");
    expect(v.provenLo).toBe(SAFE_MIN + 1);
    expect(v.provenHi).toBe(1000);
  });

  test("an early-return guard carries its sole reachable edge", () => {
    const v = onlyRecord([
      iff(bin(">=", countRead(), num(1000)), [{ kind: "return", value: null, loc }]),
      countWrite(bin("+", countRead(), num(1))),
    ]);
    expect(v.outcome).toBe("prove");
    expect(v.provenHi).toBe(1000);
  });

  test("the boundary check precedes the call's path kill", () => {
    const sendCount: IrFunction = {
      name: "sendCount",
      params: [{ localId: "x.0", name: "x", type: F64 }],
      returnType: VOID,
      locals: [{ id: "x.0", name: "x", type: F64, mutable: true }],
      body: [],
      loc,
    };
    const cfg: IntSlotConfig = {
      fns: new Map([
        ["sendCount", {
          fnName: "sendCount",
          params: ["i64"],
          paramPaths: ["exports.sendCount.params[0]"],
          ret: null,
          retPath: null,
          paramSeeds: [null],
        }],
      ]),
      records: RECORD_CFG.records,
    };
    const call: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "call",
        callee: "sendCount",
        args: [bin("+", countRead(), num(1))],
        type: VOID,
        loc,
      },
      loc,
    };
    const vs = checkLibraryIntegerSlots(
      recordCase([iff(bin("<", countRead(), num(1000)), [call])], ["m"], [sendCount]),
      cfg,
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]!.outcome).toBe("prove");
    expect(vs[0]!.provenHi).toBe(1000);
  });

  test("a call between guard and use restores the declared seed", () => {
    const call: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "call", callee: "touch", args: [], type: VOID, loc },
      loc,
    };
    const v = onlyRecord([
      iff(bin("<", countRead(), num(1000)), [
        call,
        countWrite(bin("+", countRead(), num(1))),
      ]),
    ], ["m"], [noopFn("touch")]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("a heap write between guard and use kills possible aliases", () => {
    const otherWrite: IrStmt = {
      kind: "recordSet",
      obj: recordRef(),
      shapeId: MODEL.shapeId,
      field: "other",
      value: num(0),
      loc,
    };
    const v = onlyRecord([
      iff(bin("<", countRead(), num(1000)), [
        otherWrite,
        countWrite(bin("+", countRead(), num(1))),
      ]),
    ]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("rebinding the receiver kills its path without alias analysis", () => {
    const v = onlyRecord([
      iff(bin("<", countRead(), num(1000)), [
        { kind: "assign", localId: "m.0", value: recordRef("other"), loc },
        countWrite(bin("+", countRead(), num(1))),
      ]),
    ], ["m", "other"]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("a suspension between guard and use kills the path", () => {
    const suspend: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "awaitExpr",
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        type: VOID,
        loc,
      },
      loc,
    };
    const v = onlyRecord([
      iff(bin("<", countRead(), num(1000)), [
        suspend,
        countWrite(bin("+", countRead(), num(1))),
      ]),
    ]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });

  test("a later call in a compound guard cannot resurrect a stale path", () => {
    const cond: IrExpr = {
      kind: "logical",
      op: "&&",
      left: bin("<", countRead(), num(1000)),
      right: { kind: "call", callee: "touch", args: [], type: BOOL, loc },
      type: BOOL,
      loc,
    };
    const v = onlyRecord([
      iff(cond, [countWrite(bin("+", countRead(), num(1)))]),
    ], ["m"], [noopFn("touch", true)]);
    expect(v.outcome).toBe("refuse");
    expect(v.obligation).toBe("range");
  });
});
