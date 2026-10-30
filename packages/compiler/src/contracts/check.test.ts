import { expect, test } from "vitest";
import { checkContracts } from "./check.js";
import { contractLocKey, type ContractAnnotations } from "../frontend/contract-types.js";
import {
  arrayOf,
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";

const loc = { file: "array-contract.ts", start: 0, end: 1 };
const index: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
const ref = (id: string, type: IrType): IrExpr => ({ kind: "varRef", localId: id, type, loc });

function check(type: IrType, body: IrStmt[]) {
  const notes: ContractAnnotations = {
    functions: new Map(),
    bindings: new Map([[contractLocKey(loc), { marker: "Immutable", name: "source", loc }]]),
    fields: new Map(),
    acyclic: [],
    classes: new Map(),
    diagnostics: [],
    count: 1,
  };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [{ localId: "source", name: "source", type }],
        locals: [
          { id: "source", name: "source", type, mutable: false, source: { loc, scope: loc } },
          { id: "holder", name: "holder", type: arrayOf(type), mutable: false },
        ],
        returnType: VOID,
        body,
        loc,
      },
    ],
  };
  return checkContracts(mod, notes, new Map()).diagnostics;
}

test("array property observations preserve Immutable reads and presence", () => {
  const arr = ref("source", arrayOf(F64));
  const expressions: IrExpr[] = [
    { kind: "arrayHasProperty", arr, index, type: BOOL, loc },
    ...(["required", "number", "numberConstructor", "boolean"] as const).map((consume): IrExpr => ({
      kind: "arrayPropertyRead",
      arr,
      index,
      consume,
      type: consume === "boolean" ? BOOL : F64,
      loc,
    })),
  ];
  expect(
    check(
      arr.type,
      expressions.map((expr) => ({ kind: "exprStmt", expr, loc })),
    ),
  ).toEqual([]);
});

test("array property results retain Immutable element provenance through ordinary arrays", () => {
  const type = arrayOf(F64);
  const source = ref("source", type);
  const holder = ref("holder", arrayOf(type));
  const read: IrExpr = {
    kind: "arrayPropertyRead",
    arr: holder,
    index,
    consume: "required",
    type,
    loc,
  };
  const diagnostics = check(type, [
    {
      kind: "varDecl",
      localId: "holder",
      init: { kind: "arrayLit", elems: [source], type: holder.type, loc },
      loc,
    },
    {
      kind: "arraySet",
      arr: read,
      index,
      value: { kind: "numLit", value: 7, type: F64, loc },
      loc,
    },
  ]);
  expect(diagnostics.some((diagnostic) => diagnostic.code === "SC7004")).toBe(true);
  expect(diagnostics.some((diagnostic) => diagnostic.message.includes("unknown"))).toBe(false);
});
