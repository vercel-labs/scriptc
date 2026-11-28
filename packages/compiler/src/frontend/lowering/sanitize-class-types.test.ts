import { expect, test } from "vitest";
import { F64, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { sanitizeUnregisteredClassTypes } from "./sanitize-class-types.js";

test("fenced instance slots are erased throughout signatures, storage and nested expressions", () => {
  const loc = { file: "classes.js", start: 0, end: 1 };
  const missing: IrType = { kind: "object", className: "Fenced" };
  const kept: IrType = { kind: "object", className: "Registered" };
  const constructor: IrType = { kind: "classval", className: "Fenced" };
  const composite: IrType = {
    kind: "func",
    rest: true,
    restAbi: "typed",
    argumentsAll: true,
    params: [
      { kind: "array", elem: missing },
      { kind: "set", elem: missing },
      { kind: "map", key: missing, value: { kind: "promise", inner: missing } },
    ],
    ret: { kind: "generator", async: true, yieldT: missing, retT: missing, nextT: missing },
  };
  const ref = (type: IrType): IrExpr => ({ kind: "varRef", localId: "x", type, loc });
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    globals: [{ id: "g", name: "g", type: composite, mutable: false }],
    classes: [
      {
        name: "Registered",
        fields: [{ name: "value", type: missing }],
        localCaptures: [{ localId: "x", name: "x", type: missing }],
        loc,
      },
    ],
    records: [
      {
        id: "r",
        fields: [
          { name: "value", type: missing },
          { name: "next", type: { kind: "union", unionId: "u" } },
        ],
        indexValue: missing,
      },
    ],
    unions: [{ id: "u", arms: [missing, { kind: "record", shapeId: "r" }, kept, constructor] }],
    functions: [
      {
        name: "main",
        returnType: missing,
        loc,
        params: [{ localId: "x", name: "x", type: missing }],
        locals: [{ id: "x", name: "x", type: missing, mutable: false }],
        captures: [{ localId: "y", name: "y", type: missing }],
        classCaptures: [{ localId: "z", name: "z", type: missing, slot: 3 }],
        generator: {
          yieldT: missing,
          nextT: missing,
          resultType: { kind: "record", shapeId: "r" },
        },
        body: [
          {
            kind: "if",
            cond: ref(kept),
            else_: null,
            loc,
            then: [
              {
                kind: "exprStmt",
                loc,
                expr: {
                  kind: "seqExpr",
                  type: missing,
                  loc,
                  stmts: [{ kind: "exprStmt", expr: ref(composite), loc }],
                  result: {
                    kind: "new",
                    className: "Fenced",
                    args: [ref(missing)],
                    type: missing,
                    loc,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
  // An independent structural oracle checks every nested slot and leaves
  // class-value types and node-level names intact, even on invalid nodes.
  const expected: unknown = JSON.parse(
    JSON.stringify(module, (_key, value: unknown) => {
      const type = value as { kind?: string; className?: string } | null;
      return type?.kind === "object" && type.className === "Fenced" ? F64 : value;
    }),
  );
  sanitizeUnregisteredClassTypes(module, (name) => name === "Registered");
  expect(module).toEqual(expected);
  expect(module.functions[0]!.params[0]!.type).toBe(F64);
  expect(module.unions![0]!.arms[2]).toBe(kept);
  expect(module.unions![0]!.arms[3]).toBe(constructor);
  expect(missing).toEqual({ kind: "object", className: "Fenced" });
  sanitizeUnregisteredClassTypes(module, (name) => name === "Registered");
  expect(module).toEqual(expected);
});

test("modules without optional tables and registered class types retain their structure", () => {
  const loc = { file: "registered.ts", start: 0, end: 1 };
  const type: IrType = { kind: "object", className: "Registered" };
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        returnType: type,
        params: [],
        locals: [],
        body: [],
        loc,
      },
    ],
  };
  const before = structuredClone(module);
  sanitizeUnregisteredClassTypes(module, () => true);
  expect(module).toEqual(before);
  expect(module.functions[0]!.returnType).toBe(type);
});

test("equal arms left by erasing unregistered classes collapse, and the tags that survive move with them", () => {
  const loc = { file: "classes.js", start: 0, end: 1 };
  const first: IrType = { kind: "object", className: "GatewayAuthError" };
  const second: IrType = { kind: "object", className: "GatewayRateLimitError" };
  const record: IrType = { kind: "record", shapeId: "r" };
  const unionRef: IrType = { kind: "union", unionId: "u" };
  const narrow: IrExpr = {
    kind: "unionNarrow",
    unionId: "u",
    tag: 2,
    value: { kind: "varRef", localId: "x", type: unionRef, loc },
    type: record,
    loc,
  };
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    unions: [{ id: "u", arms: [first, second, record] }],
    functions: [
      {
        name: "main",
        returnType: unionRef,
        params: [],
        locals: [{ id: "x", name: "x", type: unionRef, mutable: false }],
        body: [{ kind: "exprStmt", expr: narrow, loc }],
        loc,
      },
    ],
  };
  sanitizeUnregisteredClassTypes(module, () => false);
  // Both class arms are f64 now, so the second one is the first: the
  // record arm that was tag 2 is tag 1.
  expect(module.unions![0]!.arms.map((arm) => arm.kind)).toEqual(["f64", "record"]);
  expect(narrow.kind === "unionNarrow" && narrow.tag).toBe(1);
});

test("a union of nothing but unregistered classes keeps a definition every reference can use", () => {
  const loc = { file: "classes.js", start: 0, end: 1 };
  const arms: IrType[] = [
    { kind: "object", className: "GatewayAuthError" },
    { kind: "object", className: "GatewayRateLimitError" },
  ];
  const unionRef: IrType = { kind: "union", unionId: "u" };
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    unions: [{ id: "u", arms }],
    functions: [{ name: "main", returnType: unionRef, params: [], locals: [], body: [], loc }],
  };
  sanitizeUnregisteredClassTypes(module, () => false);
  // No value of such a union can exist, so its single type plus an
  // undefined arm is the whole domain; the reference stays intact.
  expect(module.unions![0]!.arms).toEqual([F64, { kind: "undefinedT" }]);
  expect(module.functions[0]!.returnType).toBe(unionRef);
});
