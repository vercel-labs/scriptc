import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrFunction, IrModule } from "../src/ir/ir.js";

async function lower(name: string, source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-key-tables-"));
  try {
    const entry = join(dir, name),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function callees(fn: IrFunction, prefix: string): string[] {
  const found = new Set<string>();
  for (const match of JSON.stringify(fn.body).matchAll(/"callee":"([^"]+)"/g))
    if (match[1]!.startsWith(prefix)) found.add(match[1]!);
  return [...found].sort();
}

/** The key tables the computed dispatch helper of source function `name`
 * calls: one per boxed class. */
function tablesOf(module: IrModule, name: string): string[] {
  const source = module.functions.find((fn) => fn.name.endsWith(`.${name}`) || fn.name === name);
  expect(source, name).toBeDefined();
  const helpers = callees(source!, "%dyn.class.computed.");
  expect(helpers, name).toHaveLength(1);
  const helper = module.functions.find((fn) => fn.name === helpers[0]);
  expect(helper, helpers[0]).toBeDefined();
  return callees(helper!, "%dyn.class.keys.");
}

const keyTables = (module: IrModule): IrFunction[] =>
  module.functions.filter((fn) => fn.name.startsWith("%dyn.class.keys."));

const CLASSES = `
class Point {
  x = 1;
  y = 2;
  get label(): string { return this.x + "," + this.y; }
  norm(): number { return this.x + this.y; }
}
class Row {
  0 = "zero";
  name = "row";
}
`;

test("helpers of one operation share a class's key table", async () => {
  const module = await lower(
    "main.ts",
    `${CLASSES}
function readString(value: any, key: string): unknown { return value[key]; }
function readAny(value: any, key: any): unknown { return value[key]; }
function readOptional(value: any, key: string): unknown { return value?.[key]; }
function readOptionalAny(value: any, key: any): unknown { return value?.[key]; }
function readIndex(value: any, key: number): unknown { return value[key]; }
function readOptionalIndex(value: any, key: number): unknown { return value?.[key]; }
function writeString(value: any, key: string, stored: unknown): void { value[key] = stored; }
function writeAny(value: any, key: any, stored: unknown): void { value[key] = stored; }
function has(value: any, key: any): boolean { return key in value; }
function reflectGet(value: any, key: any): unknown { return Reflect.get(value, key); }
function reflectSet(value: any, key: any, stored: unknown): boolean {
  return Reflect.set(value, key, stored);
}
const values: any[] = [new Point(), new Row()];
for (const value of values) {
  console.log(readString(value, "x"), readAny(value, "x"), readOptional(value, "x"));
  console.log(readOptionalAny(value, "x"), readIndex(value, 0), readOptionalIndex(value, 0));
  writeString(value, "x", 1);
  writeAny(value, "x", 1);
  console.log(has(value, "x"), reflectGet(value, "x"), reflectSet(value, "x", 1));
}
`,
  );
  const read = tablesOf(module, "readString");
  // One table per boxed class.
  expect(read).toHaveLength(2);
  // The key's form and an optional read do not select another table.
  expect(tablesOf(module, "readAny")).toEqual(read);
  expect(tablesOf(module, "readOptional")).toEqual(read);
  expect(tablesOf(module, "readOptionalAny")).toEqual(read);
  // A number looks up only the names a number spells.
  const index = tablesOf(module, "readIndex");
  expect(index).toHaveLength(2);
  expect(index).not.toEqual(read);
  expect(tablesOf(module, "readOptionalIndex")).toEqual(index);
  const write = tablesOf(module, "writeString");
  expect(write).toHaveLength(2);
  expect(tablesOf(module, "writeAny")).toEqual(write);
  // Each operation has its own tables.
  const operations = [
    read,
    index,
    write,
    tablesOf(module, "has"),
    tablesOf(module, "reflectGet"),
    tablesOf(module, "reflectSet"),
  ];
  const distinct = new Set(operations.flat());
  expect(distinct.size).toBe(operations.length * 2);
  expect(
    keyTables(module)
      .map((fn) => fn.name)
      .sort(),
  ).toEqual([...distinct].sort());
  // A table takes the key as a string and the instance, whatever its
  // callers hold.
  for (const table of keyTables(module)) {
    expect(table.params[0]).toMatchObject({ localId: "p.0", type: { kind: "dyn" } });
    expect(table.params[1]).toMatchObject({ type: { kind: "string" } });
    expect(table.params.at(-1)).toMatchObject({ localId: "p.receiver", type: { kind: "object" } });
  }
});

test("strict and sloppy computed writes keep separate key tables", async () => {
  const module = await lower(
    "main.cjs",
    `class Gauge {
  constructor() {
    this.level = 1;
  }
}
/** @param {any} value @param {string} key @param {any} stored */
function sloppyName(value, key, stored) {
  value[key] = stored;
}
function sloppyAny(value, key, stored) {
  value[key] = stored;
}
/** @param {any} value @param {string} key @param {any} stored */
function strictName(value, key, stored) {
  "use strict";
  value[key] = stored;
}
function strictAny(value, key, stored) {
  "use strict";
  value[key] = stored;
}
const gauge = new Gauge();
sloppyName(gauge, "level", 2);
sloppyAny(gauge, "level", 3);
strictName(gauge, "level", 4);
strictAny(gauge, "level", 5);
console.log(gauge.level);
`,
  );
  const sloppy = tablesOf(module, "sloppyName");
  const strict = tablesOf(module, "strictName");
  expect(sloppy).toHaveLength(1);
  expect(strict).toHaveLength(1);
  expect(tablesOf(module, "sloppyAny")).toEqual(sloppy);
  expect(tablesOf(module, "strictAny")).toEqual(strict);
  // A sloppy write is recognized by its source range, and a shared table
  // takes the range of one of its users: the two modes never share one.
  expect(sloppy).not.toEqual(strict);
  const ranges = new Set(module.sloppyDynWrites ?? []);
  const rangeOf = (name: string): string => {
    const { loc } = module.functions.find((fn) => fn.name === name)!;
    return `${loc.file}\0${loc.start}\0${loc.end}`;
  };
  expect(ranges.has(rangeOf(sloppy[0]!))).toBe(true);
  expect(ranges.has(rangeOf(strict[0]!))).toBe(false);
});

test("sites that open the same iteration protocol share one dispatch helper", async () => {
  const module = await lower(
    "main.ts",
    `class Countdown {
  *[Symbol.iterator](): Generator<number> {
    yield 2;
    yield 1;
  }
}
function first(items: any): number {
  let total = 0;
  for (const item of items) total += item;
  return total;
}
function second(collection: any): number {
  let count = 0;
  for (const entry of collection) count += entry > 0 ? 1 : 0;
  return count;
}
console.log(first(new Countdown()), second(new Countdown()));
`,
  );
  const helpers = module.functions.filter((fn) => /^%dyn\.class\.call\.\d+$/.test(fn.name));
  expect(helpers).toHaveLength(1);
  // Each site still names its own iterable in the error it raises.
  expect(helpers[0]!.params.at(-2)).toMatchObject({ type: { kind: "string" } });
  for (const name of ["first", "second"]) {
    const source = module.functions.find((fn) => fn.name.endsWith(`.${name}`) || fn.name === name);
    expect(callees(source!, "%dyn.class.call.")).toEqual([helpers[0]!.name]);
  }
});
