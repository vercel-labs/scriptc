import { expect, test } from "vitest";
import type { IrModule, SrcLoc } from "../../ir/ir.js";
import { invalidIrSourceLoc } from "./invalid-ir-loc.js";

const loc: SrcLoc = { file: "/app/a.js", start: 120, end: 160 };

const mod = {
  sourceFile: "/app/a.js",
  functions: [
    {
      name: "main",
      params: [],
      returnType: { kind: "void" },
      locals: [
        { id: "%destr.0", name: "%destr", type: { kind: "void" }, mutable: false },
        { id: "x", name: "x", type: { kind: "dyn" }, mutable: false },
      ],
      body: [{ kind: "varDecl", localId: "%destr.0", init: null, loc }],
      loc: { file: "/app/a.js", start: 0, end: 1 },
    },
  ],
  entry: "main",
} as unknown as IrModule;

test("the slot an LLVM verifier error quotes names its source construct", () => {
  expect(
    invalidIrSourceLoc(
      mod,
      "invalid_ir: 'void type only allowed for function results', on '%sc_l__x25_destr_0 = alloca void'",
    ),
  ).toEqual(loc);
});

test("a message that quotes no emitted local has no source site", () => {
  expect(invalidIrSourceLoc(mod, "invalid_ir: expected a terminator")).toBeNull();
});

test("a parameter slot names its function", () => {
  expect(invalidIrSourceLoc(mod, "on '%sc_l_x_0'")).toBeNull();
  expect(
    invalidIrSourceLoc(
      {
        ...mod,
        functions: [{ ...mod.functions[0]!, params: [], body: [] }],
      } as unknown as IrModule,
      "on '%sc_l__x25_destr_0'",
    ),
  ).toEqual(mod.functions[0]!.loc);
});

test("a slot id several functions hold names no site", () => {
  const first = mod.functions[0]!;
  const second = {
    ...first,
    name: "other",
    loc: { file: "/app/b.js", start: 5, end: 9 },
    body: [
      {
        kind: "varDecl" as const,
        localId: "%destr.0",
        init: null,
        loc: { file: "/app/b.js", start: 10, end: 20 },
      },
    ],
  };
  expect(
    invalidIrSourceLoc({ ...mod, functions: [first, second] } as unknown as IrModule, "on '%sc_l__x25_destr_0'"),
  ).toBeNull();
});
