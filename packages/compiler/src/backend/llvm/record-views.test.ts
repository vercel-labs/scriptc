import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrModule } from "../../ir/ir.js";
import { computeTraced } from "../cycle-analysis.js";
import { planRecordViews } from "./record-views.js";

/** The views planned for `source`'s module, as target field names → source
 * field names (each list sorted). */
async function plannedViews(source: string): Promise<Map<string, string[]>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-views-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod: IrModule = deserializeModule(await readFile(outPath, "utf8"));
    const traced = computeTraced(mod).shapes;
    const views = planRecordViews(mod, {
      traced: (id) => traced.has(`record:${id}`),
      excluded: () => false,
    });
    const names = new Map(
      (mod.records ?? []).map((shape) => [shape.id, shape.fields.map((f) => f.name).join(",")]),
    );
    return new Map(
      [...views.targets].map((target) => [
        names.get(target)!,
        views.sources(target).map((id) => names.get(id)!),
      ]),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const conversions = `
const o: unknown = wide;
const v = o as AC;
v.a = 2;
console.log(wide.a, v.a, o === v);
`;

test("a checked conversion of a live record capsule into a record type it covers plans a view", async () => {
  const views = await plannedViews(`
type Wide = { a: number; b: string; c: boolean };
type AC = { a: number; c: boolean };
const wide: Wide = { a: 1, b: "x", c: true };
${conversions}`);
  expect(views).toEqual(new Map([["a,c", ["a,b,c"]]]));
});

test("a source whose fields can hold the target type keeps the copy", async () => {
  // A view stored in its own source would be a cycle through the view's
  // capsule reference, which the cycle analysis does not see.
  const views = await plannedViews(`
type AC = { a: number; c: boolean };
type Holder = { items: AC[] };
type Wide = { a: number; b: string; c: boolean; self: AC | undefined; holder: Holder };
const wide: Wide = { a: 1, b: "x", c: true, self: undefined, holder: { items: [] } };
${conversions}
wide.self = v;
wide.holder.items.push(v);`);
  expect(views).toEqual(new Map());
});

test("a source that holds the target type through a class instance keeps the copy", async () => {
  const views = await plannedViews(`
type AC = { a: number; c: boolean };
class Base { note = 0; }
class Keeper extends Base { kept: AC | undefined = undefined; }
type Wide = { a: number; b: string; c: boolean; keeper: Base };
const wide: Wide = { a: 1, b: "x", c: true, keeper: new Keeper() };
${conversions}`);
  expect(views).toEqual(new Map());
});

test("a source that holds itself still views a type it cannot hold", async () => {
  const views = await plannedViews(`
type Tree = { a: number; b: string; c: boolean; children: Tree[] };
type AC = { a: number; c: boolean };
const wide: Tree = { a: 1, b: "x", c: true, children: [] };
wide.children.push({ a: 2, b: "y", c: false, children: [] });
${conversions}`);
  expect(views).toEqual(new Map([["a,c", ["a,b,c,children"]]]));
});

test("of two sources that can hold each other's views, one keeps the copy", async () => {
  // Each source only holds the other's target type, but a view of that type
  // names the other source, so the two views could form a cycle. Without
  // Parent's view, Kid holds only a copy and its own view is safe.
  const views = await plannedViews(`
type PView = { id: number; name: string };
type KView = { id: number; tag: string };
type Parent = { id: number; name: string; kids: KView[] };
type Kid = { id: number; tag: string; parent: PView | undefined };
const parent: Parent = { id: 1, name: "p", kids: [] };
const kid: Kid = { id: 2, tag: "k", parent: undefined };
const p: unknown = parent;
const k: unknown = kid;
kid.parent = p as PView;
parent.kids.push(k as KView);
console.log(parent.kids.length, kid.parent === p);`);
  expect(views).toEqual(new Map([["id,tag", ["id,parent,tag"]]]));
});

test("a source with a function field keeps the copy", async () => {
  // A function can capture anything, the view included.
  const views = await plannedViews(`
type AC = { a: number; c: boolean };
type Wide = { a: number; b: string; c: boolean; f: () => number };
const wide: Wide = { a: 1, b: "x", c: true, f: () => 1 };
${conversions}`);
  expect(views).toEqual(new Map());
});

test("a source that may be frozen keeps the copy", async () => {
  // Writes through a view take the target type's stores, which have no
  // frozen-write guard.
  const views = await plannedViews(`
type Wide = { a: number; b: string; c: boolean };
type AC = { a: number; c: boolean };
const wide: Wide = { a: 1, b: "x", c: true };
${conversions}
Object.freeze(wide);`);
  expect(views).toEqual(new Map());
});
