import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  isIdentityCollectionKey,
  isSupportedMapKey,
  isSupportedSetElem,
  mapOf,
  setOf,
  type IrExpr,
  type IrModule,
  type IrType,
} from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";
import { IR_VERSION } from "../src/ir/serialize.js";
import { mapKeyAccess, mapKeyKindNum } from "../src/backend/llvm/shapes.js";

const reference: IrType = { kind: "record", shapeId: "key" };
const references: IrType[] = [
  reference,
  { kind: "object", className: "Key" },
  arrayOf(F64),
  { kind: "symbol" },
  { kind: "netServer" },
];
const union: IrType = { kind: "union", unionId: "keys" };

test("checked collection slots refuse snapshot and adapting reference conversions", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-collection-conversion-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
      const promise = Promise.resolve(1);
      const error = new Error("key");
      class CustomError extends Error {}
      const custom = new CustomError("key");
      const map = new Map<unknown, unknown>();
      map.set(promise, 1);
      map.set(1, promise);
      map.set(error, 1);
      map.set(custom, 1);
      const set = new Set<unknown>([promise]);
      set.add(error);
    `,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(6);
    for (const diagnostic of coverage.diagnostics) {
      expect(diagnostic.message).toContain(
        "collection slot conversion requiring an Error snapshot or promise adapter",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(references)("identity key %j uses the reference ABI in LLVM", (type) => {
  expect(isIdentityCollectionKey(type)).toBe(true);
  expect(isSupportedMapKey(type)).toBe(true);
  expect(isSupportedSetElem(type)).toBe(true);
  expect(mapKeyAccess(type)).toBe("ref");
  expect(mapKeyKindNum(type)).toBe(2);
});

test("boxed reference keys select payload identity, not wrapper identity", () => {
  expect(isSupportedMapKey(union, references)).toBe(true);
  expect(isSupportedSetElem(union, references)).toBe(true);
  expect(mapKeyAccess(union)).toBe("ref");
  expect(mapKeyKindNum(union, references)).toBe(3);
});

test("mixed-value unions select value equality while unsupported arms remain fenced", () => {
  expect(isSupportedMapKey(union)).toBe(false);
  expect(isSupportedMapKey(union, [])).toBe(false);
  for (const scalar of [F64, STRING, BOOL, UNDEFINED_T]) {
    expect(isSupportedMapKey(union, [reference, scalar])).toBe(true);
    expect(mapKeyKindNum(union, [reference, scalar])).toBe(7);
    expect(isSupportedSetElem(union, [reference, scalar])).toBe(true);
  }
  for (const unsupported of [{ kind: "regex" } as IrType, mapOf(STRING, F64), setOf(STRING)]) {
    expect(isSupportedMapKey(unsupported)).toBe(false);
  }
});

test("Map value materialization validates the destination key domain", () => {
  const loc = { file: "keys.ts", start: 0, end: 1 };
  for (const value of [F64, mapOf(STRING, F64)]) {
    const receiver: IrExpr = { kind: "mapNew", type: mapOf(STRING, value), loc };
    const expr: IrExpr = {
      kind: "mapIntrinsic",
      method: "valueSet",
      receiver,
      args: [],
      type: setOf(value),
      loc,
    };
    const mod: IrModule = {
      irVersion: IR_VERSION,
      sourceFile: loc.file,
      entry: "main",
      functions: [
        {
          name: "main",
          params: [],
          locals: [],
          returnType: VOID,
          body: [{ kind: "exprStmt", expr, loc }],
          loc,
        },
      ],
    };
    const errors = validateModule(mod);
    if (value.kind === "f64") expect(errors).toEqual([]);
    else
      expect(errors.map((error) => error.message)).toEqual([
        "in main: mapIntrinsic valueSet element kind map (frontend must fence)",
      ]);
  }
});

test("primitive key ABI constants remain stable", () => {
  expect([mapKeyKindNum(F64), mapKeyAccess(F64)]).toEqual([0, "f64"]);
  expect([mapKeyKindNum(STRING), mapKeyAccess(STRING)]).toEqual([1, "str"]);
  expect([mapKeyKindNum(BOOL), mapKeyAccess(BOOL)]).toEqual([6, "bool"]);
  const bigint: IrType = { kind: "bigint" };
  expect([mapKeyKindNum(bigint), mapKeyAccess(bigint)]).toEqual([5, "ref"]);
});

test("unknown keys select value equality separately from reference identity", () => {
  expect(isIdentityCollectionKey(DYN)).toBe(false);
  expect(isSupportedMapKey(DYN)).toBe(true);
  expect(isSupportedSetElem(DYN)).toBe(true);
  expect([mapKeyKindNum(DYN), mapKeyAccess(DYN)]).toEqual([4, "ref"]);
});

test.each(["map", "set"] as const)("validator checks the arms behind a %s key union", (kind) => {
  const loc = { file: "keys.ts", start: 0, end: 1 };
  const type = kind === "map" ? mapOf(union, F64) : setOf(union);
  const expr: IrExpr =
    kind === "map" ? { kind: "mapNew", type, loc } : { kind: "setNew", type, loc };
  const mod: IrModule = {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "key", fields: [{ name: "id", type: F64 }] }],
    unions: [{ id: "keys", arms: [reference, arrayOf(F64)] }],
    functions: [
      {
        name: "main",
        params: [],
        locals: [],
        returnType: VOID,
        body: [{ kind: "exprStmt", expr, loc }],
        loc,
      },
    ],
  };
  expect(validateModule(mod)).toEqual([]);
  mod.unions![0]!.arms = [reference, F64];
  expect(validateModule(mod)).toEqual([]);
  mod.unions![0]!.arms = [reference, { kind: "regex" }];
  expect(
    validateModule(mod).some((error) =>
      error.message.includes(
        kind === "map" ? "mapNew key kind union" : "setNew element kind union",
      ),
    ),
  ).toBe(true);
});
