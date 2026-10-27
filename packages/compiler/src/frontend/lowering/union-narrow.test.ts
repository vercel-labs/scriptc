import { expect, test } from "vitest";
import { BOOL, F64, NULL_T, STRING, UNDEFINED_T, VOID } from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import { buildUnionNarrow } from "./union-narrow.js";

const loc: SrcLoc = { file: "narrow.ts", start: 0, end: 1 };
const union: IrUnionDef = { id: "u", arms: [BOOL, F64, NULL_T, STRING, UNDEFINED_T] };
function branches(fn: IrFunction) {
  return fn.body.flatMap((statement) => (statement.kind === "if" ? [statement] : []));
}

for (const [target, tag] of [
  [BOOL, 0],
  [F64, 1],
  [STRING, 3],
] as [IrType, number][]) {
  test(`extracts only the matching ${target.kind} payload`, () => {
    const fn = buildUnionNarrow("read", union, target, loc, (type) => type.kind)!;
    const cases = branches(fn);
    expect(cases).toHaveLength(5);
    for (let i = 0; i < cases.length; i++) {
      expect(cases[i]!.cond).toMatchObject({ kind: "unionIsTag", unionId: "u", tag: i });
      expect(cases[i]!.then[0]!.kind).toBe(i === tag ? "return" : "throw");
    }
    expect(cases[tag]!.then[0]).toMatchObject({
      kind: "return",
      value: { kind: "unionNarrow", tag, type: target },
    });
    expect(fn.returnType).toEqual(target);
    expect(fn.body.at(-1)).toMatchObject({
      kind: "throw",
      value: { value: "scriptc: internal error: invalid union tag" },
    });
  });
}

for (const target of [NULL_T, UNDEFINED_T, VOID, { kind: "array", elem: STRING } as IrType]) {
  test(`declines unrepresentable extraction to ${target.kind}`, () => {
    expect(buildUnionNarrow("read", union, target, loc, () => "")).toBeNull();
  });
}

test("reference extraction keeps the source payload instead of rebuilding it", () => {
  const target: IrType = { kind: "record", shapeId: "r0" };
  const from: IrUnionDef = { id: "records", arms: [target, UNDEFINED_T] };
  const fn = buildUnionNarrow("record", from, target, loc, () => "record")!;
  expect(branches(fn)[0]!.then[0]).toMatchObject({
    kind: "return",
    value: { kind: "unionNarrow", unionId: "records", tag: 0, type: target },
  });
  expect(fn.locals).toHaveLength(1);
});

test("unit and data traps retain the established error wording", () => {
  const fn = buildUnionNarrow("read", union, STRING, loc, (type) => type.kind)!;
  for (const [tag, name] of [
    [0, "a 'bool' value"],
    [2, "null"],
    [4, "undefined"],
  ] as [number, string][]) {
    const thrown = branches(fn)[tag]!.then[0]!;
    if (thrown.kind !== "throw" || thrown.value.kind !== "libCall")
      throw new Error("expected error allocation");
    expect(thrown.value.type).toEqual({ kind: "object", className: "%TypeError" });
    expect(thrown.value.args[0]).toMatchObject({
      value: `${name} is not representable in the target union (a value narrowed or asserted past it still held it)`,
    });
  }
});

for (const target of [BOOL, F64]) {
  test(`deferred ${target.kind} defaults only undefined`, () => {
    const value: IrExpr =
      target.kind === "bool"
        ? { kind: "boolLit", value: false, type: BOOL, loc }
        : { kind: "numLit", value: Number.NaN, type: F64, loc };
    const fn = buildUnionNarrow("deferred", union, target, loc, () => "payload", value)!;
    const cases = branches(fn);
    expect(cases[4]!.then).toEqual([{ kind: "return", value, loc }]);
    expect(cases[2]!.then[0]!.kind).toBe("throw");
    expect(cases[3]!.then[0]!.kind).toBe("throw");
  });
}

test("rejects default expressions with the wrong representation", () => {
  const boolean: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  expect(buildUnionNarrow("bad", union, F64, loc, () => "", boolean)).toBeNull();
});

test("defaults never bypass reference extraction checks", () => {
  const text: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  expect(buildUnionNarrow("bad", union, STRING, loc, () => "", text)).toBeNull();
});

test("a deferred read requires a real undefined tag", () => {
  const from: IrUnionDef = { id: "u", arms: [BOOL, NULL_T] };
  const value: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  expect(buildUnionNarrow("bad", from, BOOL, loc, () => "", value)).toBeNull();
});

test("a failure message replaces every other tag's TypeError", () => {
  const fn = buildUnionNarrow(
    "call",
    union,
    STRING,
    loc,
    (type) => type.kind,
    null,
    "f is not a function",
  )!;
  const thrown = branches(fn).flatMap((branch) => {
    const statement = branch.then[0]!;
    return statement.kind === "throw" ? [statement.value] : [];
  });
  expect(thrown).toHaveLength(4);
  for (const value of thrown)
    expect(value).toMatchObject({ kind: "libCall", args: [{ value: "f is not a function" }] });
});
