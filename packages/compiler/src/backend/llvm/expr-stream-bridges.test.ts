import { expect, test } from "vitest";
import {
  DYN,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

function sharedGraph(roots: number): IrModule {
  const loc = { file: "live-references.ts", start: 0, end: 0 };
  const leaf: IrType = { kind: "record", shapeId: "leaf" };
  const root: IrType = { kind: "record", shapeId: "root" };
  const next: IrType = { kind: "union", unionId: "next" };
  const inputs: (IrType & { kind: "union" })[] = Array.from({ length: roots }, (_, index) => ({
    kind: "union",
    unionId: `input${index}`,
  }));
  return {
    irVersion: 14,
    sourceFile: loc.file,
    entry: "main",
    records: [
      {
        id: "leaf",
        fields: [
          { name: "name", type: STRING },
          { name: "next", type: next },
          { name: "children", type: { kind: "array", elem: leaf } },
        ],
      },
      {
        id: "root",
        fields: [
          { name: "first", type: leaf },
          { name: "second", type: leaf },
        ],
      },
    ],
    unions: [
      { id: "next", arms: [leaf, UNDEFINED_T] },
      ...inputs.map((type) => ({
        id: type.unionId,
        arms: [root, leaf, STRING],
      })),
    ],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      ...inputs.map((type, index): IrFunction => ({
        name: `box${index}`,
        params: [{ name: "value", localId: "value", type }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type, mutable: false }],
        loc,
        body: [
          {
            kind: "return" as const,
            value: {
              kind: "dynFrom" as const,
              value: { kind: "varRef" as const, localId: "value", type, loc },
              liveRef: true,
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      })),
    ],
  };
}

test("overlapping union roots share the recursive materialization graph", () => {
  for (const pointerBits of [32, 64] as const) {
    for (const roots of [2, 32]) {
      const llvm = emitLlvmModule(sharedGraph(roots), { pointerBits });
      const materializers = [
        ...llvm.matchAll(
          /^define internal ptr @\S+\(ptr %p\).*; materialize live stream value (.+)$/gm,
        ),
      ];
      // One record root, one recursive leaf, and its array, independent of
      // how many enclosing union arms reach the shared graph.
      expect(materializers).toHaveLength(3);
      expect(new Set(materializers.map((match) => match[1])).size).toBe(3);
      expect(llvm.match(/; materialize live union value /g)).toHaveLength(roots + 1);
      const symbols = [...llvm.matchAll(/^define .*? @(\S+)\(/gm)].map((match) => match[1]);
      expect(new Set(symbols).size).toBe(symbols.length);
    }
  }
});

test("converter registries belong to one emitted module", () => {
  const original = sharedGraph(2);
  const first = emitLlvmModule(original);
  const changed = sharedGraph(2);
  changed.records![0]!.fields.push({ name: "extra", type: STRING });
  const second = emitLlvmModule(changed);
  expect(second).not.toBe(first);
  expect(emitLlvmModule(original)).toBe(first);
});
