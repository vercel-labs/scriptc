import { expect, test } from "vitest";
import type { IrClassDef, IrType, IrUnionDef } from "../../ir/ir.js";
import { NullableRefFields } from "./nullable-fields.js";

const loc = { file: "nullable.ts", start: 0, end: 0 };
const node: IrType = { kind: "object", className: "Node" };
const union = (id: string): IrType => ({ kind: "union", unionId: id });
const unions = new Map<string, IrUnionDef>(
  (
    [
      ["orNull", [{ kind: "nullT" }, node]],
      ["orUndefined", [node, { kind: "undefinedT" }]],
      ["both", [{ kind: "nullT" }, { kind: "undefinedT" }, node]],
      ["orNumber", [node, { kind: "f64" }]],
      ["runtimeArm", [{ kind: "nullT" }, { kind: "object", className: "%Error" }]],
      ["recordArm", [{ kind: "nullT" }, { kind: "record", shapeId: "r" }]],
    ] as [string, IrType[]][]
  ).map(([id, arms]) => [id, { id, arms } as IrUnionDef]),
);
const cls = (name: string, fields: [string, IrType][], runtime = false): IrClassDef =>
  ({
    name,
    loc,
    fields: fields.map(([fieldName, type]) => ({ name: fieldName, type })),
    ...(runtime ? { runtime: true } : {}),
  }) as unknown as IrClassDef;

test("only one unit arm plus one emitted class arm uses pointer storage", () => {
  const fields = new NullableRefFields(
    [
      cls("Node", [
        ["next", union("orNull")],
        ["prev", union("orUndefined")],
        ["both", union("both")],
        ["num", union("orNumber")],
        ["err", union("runtimeArm")],
        ["rec", union("recordArm")],
        ["plain", node],
        ["%hidden", union("orNull")],
      ]),
      cls("%Error", [["next", union("orNull")]], true),
    ],
    unions,
  );
  expect(fields.get("Node", "next")).toEqual({
    unionId: "orNull",
    refTag: 1,
    unitTag: 0,
    arm: node,
  });
  expect(fields.get("Node", "prev")).toMatchObject({ refTag: 0, unitTag: 1 });
  for (const field of ["both", "num", "err", "rec", "plain", "%hidden", "missing"])
    expect(fields.get("Node", field)).toBeNull();
  // Runtime classes keep their C layouts.
  expect(fields.get("%Error", "next")).toBeNull();
  expect(fields.storageType("Node", "next", union("orNull"))).toEqual(node);
  expect(fields.storageType("Node", "num", union("orNumber"))).toEqual(union("orNumber"));
});
