import { expect, test } from "vitest";
import { BOOL, DYN, STRING, type IrExpr, type IrModule } from "../ir/ir.js";
import { evaluateLibraryFences, resolveLibraryFences } from "./fence-eval.js";

const loc = { file: "util-types.ts", start: 0, end: 1 };
function program(member: string): IrModule {
  const call: IrExpr = {
    kind: "libCall",
    fn: "util.typeIs",
    args: [
      { kind: "varRef", localId: "value", type: DYN, loc },
      { kind: "strLit", value: member, type: STRING, loc },
    ],
    type: BOOL,
    loc,
  };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "probe",
    functions: [
      {
        name: "probe",
        params: [{ localId: "value", name: "value", type: DYN }],
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        returnType: BOOL,
        body: [{ kind: "return", value: call, loc }],
        loc,
      },
    ],
  };
}

test("util.types fences distinguish predicates sharing the native brand helper", () => {
  const resolved = resolveLibraryFences([
    { id: "node-builtin.util.types.isMap", path: "determinism.fences[0]" },
  ]);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const profile = { name: "brands", teachings: {}, fences: resolved.fences };
  expect(evaluateLibraryFences(program("isMap"), profile).map((diag) => diag.code)).toEqual([
    "SC4008",
  ]);
  expect(evaluateLibraryFences(program("isTypedArray"), profile)).toEqual([]);
});
