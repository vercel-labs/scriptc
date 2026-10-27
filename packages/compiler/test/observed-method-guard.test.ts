import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type IrRecord = Record<string, unknown>;

function recordsOf(value: unknown, out: IrRecord[] = []): IrRecord[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) recordsOf(item, out);
    return out;
  }
  const record = value as IrRecord;
  out.push(record);
  for (const child of Object.values(record)) recordsOf(child, out);
  return out;
}

// An untyped computed write puts every method name in the census, so typed
// calls read the observable slot. While the slot holds the declared method,
// the call is the native method call, not a dynamic call of the slot.
test("typed calls of an observed method call it natively while its slot is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-observed-guard-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  const outPath = join(outDir, "main.ir.json");
  await writeFile(
    join(dir, "untyped.js"),
    "export function put(target, key, value) { target[key] = value; }\n",
  );
  await writeFile(
    entry,
    [
      'import { put } from "./untyped.js";',
      "class Repo {",
      "  items: number[] = [];",
      "  total(): number { let s = 0; for (const n of this.items) s += n; return s; }",
      "}",
      "const repo = new Repo();",
      "repo.items.push(1, 2);",
      "put({}, String(Math.random()), 1);",
      "export function sum(r: Repo): number { return r.total(); }",
      "console.log(sum(repo));",
      "",
    ].join("\n"),
  );
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const module = deserializeModule(await readFile(outPath, "utf8"));
  expect(validateModule(module)).toEqual([]);
  const sum = module.functions.find((fn) => fn.name.endsWith("sum"));
  expect(sum).toBeDefined();
  const records = recordsOf(sum);
  const guards = records.filter(
    (record) =>
      record.kind === "ternary" &&
      (record.cond as IrRecord | undefined)?.kind === "libCall" &&
      (record.cond as IrRecord).fn === "dyn.sameValue",
  );
  expect(guards).toHaveLength(1);
  const then = guards[0]!.then as IrRecord;
  expect(then.kind).toBe("call");
  expect(String(then.callee)).toMatch(/Repo\.total$/);
  expect(module.globals?.some((global) => global.name === "Repo.prototype.total.original")).toBe(
    true,
  );
});

// A spread argument keeps the dynamic call, which drains the spread through
// the iterator's current `next` (a replacement included).
test("typed calls of an observed method with a spread argument keep the dynamic call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-observed-guard-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  const outPath = join(outDir, "main.ir.json");
  await writeFile(
    join(dir, "untyped.js"),
    "export function put(target, key, value) { target[key] = value; }\n",
  );
  await writeFile(
    entry,
    [
      'import { put } from "./untyped.js";',
      "class Bag {",
      "  sum(...values: number[]): number { let s = 0; for (const n of values) s += n; return s; }",
      "}",
      "const bag = new Bag();",
      "put({}, String(Math.random()), 1);",
      "export function spread(b: Bag, values: number[]): number { return b.sum(...values); }",
      "console.log(spread(bag, [1, 2]));",
      "",
    ].join("\n"),
  );
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const module = deserializeModule(await readFile(outPath, "utf8"));
  expect(validateModule(module)).toEqual([]);
  const spread = module.functions.find((fn) => fn.name.endsWith("spread"));
  expect(spread).toBeDefined();
  const guards = recordsOf(spread).filter(
    (record) =>
      record.kind === "ternary" &&
      (record.cond as IrRecord | undefined)?.kind === "libCall" &&
      (record.cond as IrRecord).fn === "dyn.sameValue",
  );
  expect(guards).toHaveLength(0);
});
