import { expect, test } from "vitest";
import { STRING, VOID, type IrExpr, type IrModule } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { stringParts } from "./string-construction.js";

const loc = { file: "construction.ts", start: 0, end: 1 };
const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
const concat = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "strConcat",
  left,
  right,
  type: STRING,
  loc,
});

function module(value: IrExpr): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", loc, params: [], locals: [], returnType: VOID, body: [] },
      {
        name: "assemble",
        loc,
        params: [{ name: "value", localId: "value", type: STRING }],
        locals: [{ id: "value", name: "value", type: STRING, mutable: true }],
        returnType: STRING,
        body: [{ kind: "return", value, loc }],
      },
    ],
  };
}

test("concat grouping bounds each stack vector and preserves leaf order", () => {
  const leaves = Array.from({ length: 100 }, (_, i) => text(String(i)));
  for (const tree of [
    leaves.reduce(concat),
    leaves.reduceRight((right, left) => concat(left, right)),
  ]) {
    const seen: IrExpr[] = [];
    const walk = (value: IrExpr): void => {
      if (value.kind !== "strConcat") {
        seen.push(value);
        return;
      }
      const parts = stringParts(value);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.length).toBeLessThanOrEqual(16);
      for (const part of parts) walk(part);
    };
    walk(tree);
    expect(seen).toEqual(leaves);
  }
});

test.each([32, 64] as const)("concat uses a borrowed stack vector with %i-bit size_t", (bits) => {
  const mod = module(concat(concat(text("<"), ref("value")), text(">")));
  expect(validateModule(mod)).toEqual([]);
  const ir = emitLlvmModule(mod, { pointerBits: bits });
  const body = /^define internal [^\n]*@sc_bf_assemble\([^]*?^}/m.exec(ir)![0];
  expect(body).toContain("alloca [3 x ptr]");
  expect(body).toMatch(new RegExp(`call ptr @scr_str_concat_parts\\(ptr %[^,]+, i${bits} 3\\)`));
  expect(body).not.toContain("@scr_str_retain_v");
  expect(body).not.toContain("@scr_str_release");
});

test("later writes preserve an owned snapshot of earlier string parts", () => {
  const changed: IrExpr = {
    kind: "assignExpr",
    localId: "value",
    value: text("new"),
    type: STRING,
    loc,
  };
  const mod = module(concat(concat(ref("value"), changed), ref("value")));
  expect(validateModule(mod)).toEqual([]);
  const body = /^define internal [^\n]*@sc_f_assemble\([^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const retain = body.indexOf("@scr_str_retain_v");
  const release = body.indexOf("@scr_str_release");
  const assemble = body.indexOf("@scr_str_concat_parts");
  expect(retain).toBeGreaterThanOrEqual(0);
  expect(retain).toBeLessThan(release);
  expect(release).toBeLessThan(assemble);
  expect(body.slice(assemble)).toContain("@scr_str_release");
});

test("two-part concatenation keeps the existing append path", () => {
  const ir = emitLlvmModule(module(concat(ref("value"), text("suffix"))));
  expect(ir).toContain("call ptr @scr_str_concat(");
  expect(ir).not.toContain("@scr_str_concat_parts");
});
