import { expect, test } from "vitest";
import { decodeModuleBinary } from "../ir/codec.js";
import type { IrExpr, IrFunction, IrModule, IrType } from "../ir/ir.js";
import { missingUnitIrReferences, unitModuleSlice } from "./ir.js";

const loc = (file: string) => ({ file, start: 0, end: 1 });

function fn(name: string, file: string, body: IrExpr[], returnType: IrType = { kind: "void" }) {
  return {
    name,
    params: [],
    returnType,
    locals: [],
    body: body.map((expr) => ({ kind: "exprStmt", expr, loc: loc(file) })),
    loc: loc(file),
  } as unknown as IrFunction;
}

test("a unit's slice holds its functions and every entry they name, closed transitively", () => {
  const module = {
    irVersion: 17,
    sourceFile: "",
    entry: "main",
    functions: [
      // The unit's function reads a global, a class whose base is another
      // class, and a record shape.
      fn(
        "%m1.f",
        "/app/node_modules/lib/a.ts",
        [
          { kind: "varRef", localId: "%g.lib.x", type: { kind: "f64" }, loc: loc("a.ts") },
          { kind: "classRef", className: "%m1.A", type: { kind: "f64" }, loc: loc("a.ts") },
        ],
        { kind: "record", shapeId: "r0" },
      ),
      // The app's function names entries the unit must not carry.
      fn("%m2.main", "/app/main.ts", [
        { kind: "varRef", localId: "%g.app.y", type: { kind: "f64" }, loc: loc("main.ts") },
        { kind: "classRef", className: "%m2.B", type: { kind: "f64" }, loc: loc("main.ts") },
      ]),
    ],
    globals: [
      { id: "%g.lib.x", name: "x", type: { kind: "f64" }, mutable: false },
      { id: "%g.lib.flag", name: "flag", type: { kind: "bool" }, mutable: false },
      { id: "%g.app.y", name: "y", type: { kind: "f64" }, mutable: false },
    ],
    classes: [
      {
        name: "%m1.A",
        fields: [],
        base: "%m1.Base",
        baseValueGlobal: "%g.lib.flag",
        loc: loc("/app/node_modules/lib/a.ts"),
      },
      { name: "%m1.Base", fields: [], loc: loc("/app/node_modules/lib/a.ts") },
      { name: "%m2.B", fields: [], loc: loc("/app/main.ts") },
    ],
    records: [{ id: "r0", fields: [{ name: "x", type: { kind: "f64" } }] }],
  } as unknown as IrModule;

  const slice = unitModuleSlice(
    module,
    new Set(["a.ts"]),
    (file) =>
      file.endsWith("/lib/a.ts") ? "a.ts" : file.endsWith("main.ts") ? "main.ts" : undefined,
    new Set(["%m1.A"]),
  );
  expect(slice).not.toBeNull();
  expect(slice!.functions).toEqual(["%m1.f"]);
  expect(slice!.globals).toEqual(["%g.lib.flag", "%g.lib.x"]);
  expect(slice!.classes).toEqual(["%m1.A", "%m1.Base"]);
  expect(slice!.records).toEqual(["r0"]);
  expect(slice!.unions).toEqual([]);
  // The bytes decode with the IR codec, and the decoded slice names nothing
  // it does not hold.
  const back = decodeModuleBinary(Buffer.from(slice!.bytes));
  expect(back.functions.map((entry) => entry.name)).toEqual(["%m1.f"]);
  expect(missingUnitIrReferences(back)).toEqual([]);
});

test("a unit that defines no function has no slice", () => {
  const module = { irVersion: 17, sourceFile: "", entry: "", functions: [] } as unknown as IrModule;
  expect(unitModuleSlice(module, new Set(["a.ts"]), () => "a.ts", new Set())).toBeNull();
});
