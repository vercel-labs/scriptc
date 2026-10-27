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
    irVersion: 17,
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
          /^define internal ptr @\S+(?:\.i32)?\(ptr %p\).*; materialize live stream value (.+)$/gm,
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

test("live record capsules bind field hooks in snapshot order", () => {
  const module = sharedGraph(1);
  module.records!.push({
    id: "numbered",
    fields: [
      { name: "0", type: STRING },
      { name: "name", type: STRING },
    ],
  });
  module.unions!.push({
    id: "numberedInput",
    arms: [{ kind: "record", shapeId: "numbered" }, STRING],
  });
  const loc = { file: "live-references.ts", start: 0, end: 0 };
  const type: IrType = { kind: "union", unionId: "numberedInput" };
  module.functions.push({
    name: "boxNumbered",
    params: [{ name: "value", localId: "value", type }],
    returnType: DYN,
    locals: [{ id: "value", name: "value", type, mutable: false }],
    loc,
    body: [
      {
        kind: "return",
        value: {
          kind: "dynFrom",
          value: { kind: "varRef", localId: "value", type, loc },
          liveRef: true,
          type: DYN,
          loc,
        },
        loc,
      },
    ],
  });
  const llvm = emitLlvmModule(module, { pointerBits: 64 });
  const tables = [
    ...llvm.matchAll(
      /^@(\S+)_rops = internal global \{ i64, ptr, ptr, ptr, i8, ptr, ptr, ptr \} \{ i64 (\d+), /gm,
    ),
  ];
  // root and leaf get field hooks; the record with an index-like field name
  // keeps every operation on its snapshot, whose keys sort that name first.
  expect(tables.map((match) => Number(match[2])).sort()).toEqual([2, 3]);
  expect(llvm).toMatch(/; materialize live stream value record:numbered$/m);
  const leafNames = llvm.match(/^@\S+_names = internal constant \[3 x ptr\] \[(.+)\]$/m);
  expect(leafNames).not.toBeNull();
  const binds = llvm.match(/call void @scr_dyn_typed_ref_bind_record\(/g) ?? [];
  expect(binds.length).toBeGreaterThan(0);
  expect(llvm).toMatch(
    /define internal zeroext i1 @\S+_has(?:\.i32)?\(ptr %p, i64 %i\).*; live field presence of record:leaf/,
  );
});

test("class instance capsules bind prototype member names by exact class", () => {
  const loc = { file: "live-references.ts", start: 0, end: 0 };
  const base: IrType = { kind: "object", className: "Base" };
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    classes: [
      { name: "Base", fields: [{ name: "size", type: STRING }], prototypeNames: ["grow"], loc },
      {
        name: "Derived",
        base: "Base",
        fields: [{ name: "size", type: STRING }],
        prototypeNames: ["shrink", "grow"],
        loc,
      },
    ],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "box",
        params: [{ name: "value", localId: "value", type: base }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type: base, mutable: false }],
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "dynFrom",
              value: { kind: "varRef", localId: "value", type: base, loc },
              liveRef: true,
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      },
    ],
  };
  const llvm = emitLlvmModule(module, { pointerBits: 64 });
  const tables = [...llvm.matchAll(/^@(\S+)_cnames = internal constant \[(\d+) x ptr\]/gm)].map(
    (match) => Number(match[2]),
  );
  // Base: constructor, grow. Derived: constructor, shrink, grow (deduplicated).
  expect(tables.sort()).toEqual([2, 3]);
  expect(llvm).toMatch(
    /^define internal ptr @\S+_cexact\(ptr %p\).*; exact class members of Base$/m,
  );
  expect(llvm).toMatch(/call void @scr_dyn_typed_ref_bind_class\(/);
});
