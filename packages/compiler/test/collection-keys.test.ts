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
  // Collections are one object each for their whole life: a Map, a Set and
  // a typed array key compare by pointer identity too.
  mapOf(STRING, F64),
  setOf(STRING),
  { kind: "bytes", elem: "u8" },
];
const union: IrType = { kind: "union", unionId: "keys" };

test("checked collection slots refuse snapshot conversions and take a promise", () => {
  // An Error crosses as a snapshot of its fields, which is no live
  // reference. A promise crosses as an adapter that shares its identity,
  // which a checked collection hashes and compares (scr_dyn_identity).
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
    expect(coverage.diagnostics).toHaveLength(3);
    for (const diagnostic of coverage.diagnostics) {
      expect(diagnostic.message).toContain(
        "collection slot conversion requiring an Error snapshot",
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

test("a promise is a reference key: Set<Promise<T>> compares by identity", () => {
  // A promise is one object for its whole life and the runtime's
  // scr_promise_{retain,release,trace}_v adapters serve it as a Map value
  // already, so it joins the identity-key ABI.
  const promise: IrType = { kind: "promise", inner: VOID };
  expect(isIdentityCollectionKey(promise)).toBe(true);
  expect(isSupportedMapKey(promise)).toBe(true);
  expect(isSupportedSetElem(promise)).toBe(true);
  expect(mapKeyAccess(promise)).toBe("ref");
  // SCR_MAP_KEY_PROMISE: identity through the cell its adapter boxes share.
  expect(mapKeyKindNum(promise)).toBe(11);

  const dir = mkdtempSync(join(tmpdir(), "scriptc-promise-set-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
      async function main(): Promise<void> {
        const pending = new Set<Promise<void>>();
        const work = Promise.resolve();
        pending.add(work);
        pending.add(work);
        if (pending.has(work)) pending.delete(work);
        await Promise.all([...pending]);
        for (const member of pending) await member;
      }
      main();
    `,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.diagnostics).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Map, a Set and a typed array key by identity, not contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-collection-keys-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
      const counts = new Map([["a", 1]]);
      const names = new Set(["a"]);
      const bytes = new Uint8Array([1, 2]);
      const sets = new Set<Set<string>>([names, new Set(["a"])]);
      const maps = new Set<Map<string, number>>([counts]);
      const buffers = new Set<Uint8Array>([bytes]);
      sets.add(names);
      maps.add(counts);
      buffers.add(bytes);
      console.log(sets.size, maps.size, buffers.size);
      console.log(sets.has(names), maps.has(counts), buffers.has(bytes));
      maps.delete(counts);
      maps.add(counts);
      const byMap = new Map<Map<string, number>, number>([[counts, 1]]);
      byMap.set(new Map([["a", 1]]), 2);
      console.log(byMap.size, byMap.get(counts));
      const bySet = new Set<[Set<string>, Uint8Array]>([[names, bytes]]);
      const seeded = new Map(bySet);
      console.log(seeded.size, seeded.get(names) === bytes);
    `,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.diagnostics).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a constructor seed cast from a dynamic value is an array conversion, not a key copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-collection-seed-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
      const rows: unknown = [{ k: "a" }];
      const set = new Set(rows as { k: string }[]);
      const viaName = rows as { k: string }[];
      const same = new Set(viaName);
      console.log(set.size, same.size, set.has(viaName[0]!));
    `,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.diagnostics).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key assertion is still refused: a copied key is not the object", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-collection-key-assertion-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
      const row: unknown = { k: "a" };
      const set = new Set<{ k: string }>();
      set.add(row as { k: string });
      console.log(set.size);
    `,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining(
        "collection key assertion requiring a structural copy or dynamic conversion",
      ),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a promise arm keys a union through the cell its adapter boxes share", () => {
  const promise: IrType = { kind: "promise", inner: F64 };
  expect(isIdentityCollectionKey(promise)).toBe(true);
  // SCR_MAP_KEY_UNION_VALUE: the promise arm is compared through its identity
  // cell, which the payload pointer does not carry, so the union cannot use
  // payload identity.
  expect(mapKeyKindNum(union, [promise, UNDEFINED_T])).toBe(7);
  expect(mapKeyKindNum(union, [promise, STRING])).toBe(7);
  expect(mapKeyKindNum(union, [reference, promise])).toBe(7);
  expect(isSupportedMapKey(union, [promise, STRING])).toBe(true);
  expect(isSupportedSetElem(union, [promise, UNDEFINED_T])).toBe(true);
});

test("boxed reference keys select payload identity, not wrapper identity", () => {
  expect(isSupportedMapKey(union, references)).toBe(true);
  expect(isSupportedSetElem(union, references)).toBe(true);
  expect(mapKeyAccess(union)).toBe("ref");
  expect(mapKeyKindNum(union, references)).toBe(3);
});

test("function keys compare identity roots, beside the other arms of a union", () => {
  const fn: IrType = { kind: "func", params: [F64], ret: F64 };
  expect(isIdentityCollectionKey(fn)).toBe(true);
  expect([mapKeyKindNum(fn), mapKeyAccess(fn)]).toEqual([10, "ref"]);
  // SCR_MAP_KEY_UNION_VALUE: the function arm keys as a closure (10).
  expect(mapKeyKindNum(union, [fn, UNDEFINED_T])).toBe(7);
  expect(mapKeyKindNum(union, [reference, fn])).toBe(7);
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
  for (const unsupported of [
    { kind: "regex" } as IrType,
    { kind: "url" } as IrType,
    { kind: "generator", yieldT: F64, retT: VOID, nextT: UNDEFINED_T } as IrType,
  ]) {
    expect(isSupportedMapKey(unsupported)).toBe(false);
  }
});

test("Map value materialization validates the destination key domain", () => {
  const loc = { file: "keys.ts", start: 0, end: 1 };
  const run = (value: IrType): string[] => {
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
    return validateModule(mod).map((error) => error.message);
  };
  // A set of scalars or of another collection stores its values in the key
  // slot: both are supported elements now.
  expect(run(F64)).toEqual([]);
  expect(run(mapOf(STRING, F64))).toEqual([]);
  // A child handle is a Map value but no Set element (nothing compares it by
  // identity), so the domain fence names it.
  expect(run({ kind: "child" })).toEqual([
    "in main: mapIntrinsic valueSet element kind child (frontend must fence)",
  ]);
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
