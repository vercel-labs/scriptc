import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { DYN } from "../../ir/ir.js";
import type { IrExpr, IrModule } from "../../ir/ir.js";
import { computeTraced } from "../cycle-analysis.js";
import { everyStmtList } from "../../ir/traverse.js";
import { emitLlvmModule } from "./emitter.js";
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

/** `source`'s module shaped the way the frontend lowers a partial
 * assertion (C2): the checked cast of the source record literal carries
 * `partialView` over a `dynFrom{liveRef}` of that literal. */
async function partialModule(
  source: string,
  sourceFields: string,
  targetFields: string,
): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-views-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod: IrModule = deserializeModule(await readFile(outPath, "utf8"));
    const idOf = (fields: string): string =>
      (mod.records ?? []).find((shape) => shape.fields.map((f) => f.name).join(",") === fields)!.id;
    const exprs: IrExpr[] = [];
    for (const fn of mod.functions)
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (e) => {
          exprs.push(e);
          return true;
        },
      });
    const lit = exprs.find(
      (e) =>
        e.kind === "recordLit" && e.type.kind === "record" && e.type.shapeId === idOf(sourceFields),
    );
    const check = exprs.find(
      (e) =>
        e.kind === "dynCheck" && e.type.kind === "record" && e.type.shapeId === idOf(targetFields),
    );
    if (!lit || !check || check.kind !== "dynCheck") throw new Error("shapes not found");
    check.partialView = true;
    check.value = { kind: "dynFrom", liveRef: true, value: lit, type: DYN, loc: check.loc };
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a partial assertion plans a partial view with an absent-field sentinel", async () => {
  const mod = await partialModule(
    `
type Wide = { a: number; b: string };
type Narrow = { a: number; z: boolean };
const wide: Wide = { a: 1, b: "x" };
const o: unknown = wide;
const v = o as Narrow;
console.log(v.a);
`,
    "a,b",
    "a,z",
  );
  const idOf = (fields: string): string =>
    (mod.records ?? []).find((shape) => shape.fields.map((f) => f.name).join(",") === fields)!.id;
  const target = idOf("a,z");
  const source = idOf("a,b");
  const views = planRecordViews(mod, { traced: () => false, excluded: () => false });
  expect(views.targets.has(target)).toBe(true);
  expect(views.sources(target)).toEqual([source]);
  expect(views.partial(target, source)).toBe(true);
  expect(views.partialTargets.has(target)).toBe(true);
  expect(views.partialMissing(target, "z")).toBe(true);
  expect(views.partialMissing(target, "a")).toBe(false);
  // The offset table marks the target field the source does not declare
  // with the all-ones sentinel.
  const llvm = emitLlvmModule(mod);
  expect(llvm).toMatch(/@sc_rv_\d+_0 = internal constant \[2 x i64\] \[i64 ptrtoint .*, i64 -1\]/);
});

test("a full source keeps an ordinary view, not a partial one", async () => {
  const mod = await partialModule(
    `
type Wide = { a: number; b: string };
type Narrow = { a: number };
const wide: Wide = { a: 1, b: "x" };
const o: unknown = wide;
const v = o as Narrow;
console.log(v.a);
`,
    "a,b",
    "a",
  );
  const idOf = (fields: string): string =>
    (mod.records ?? []).find((shape) => shape.fields.map((f) => f.name).join(",") === fields)!.id;
  const views = planRecordViews(mod, { traced: () => false, excluded: () => false });
  expect(views.sources(idOf("a"))).toEqual([idOf("a,b")]);
  expect(views.partial(idOf("a"), idOf("a,b"))).toBe(false);
  expect(views.partialTargets.size).toBe(0);
});

/** The reasons planRecordViews declines the partial assertions of `source`. */
async function declinedReasons(source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-views-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod: IrModule = deserializeModule(await readFile(outPath, "utf8"));
    const traced = computeTraced(mod).shapes;
    return planRecordViews(mod, {
      traced: (id) => traced.has(`record:${id}`),
      excluded: () => false,
    }).declinedPartials.map((site) => site.reason);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a partial assertion whose type gets a view is not declined", async () => {
  expect(
    await declinedReasons(`
type Point = { x: number; y: number };
const p = {} as Point;
p.x = 1;
p.y = 2;
console.log(p.x + p.y);
`),
  ).toEqual([]);
});

test("a partial assertion to a type the program freezes gets a view whose mark the table reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-views-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
type Point = { x: number; y: number };
const p = {} as Point;
p.x = 1;
p.y = 2;
const fixed: Point = { x: 0, y: 0 };
console.log(p.x + p.y, Object.isFrozen(Object.freeze(fixed)));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod: IrModule = deserializeModule(await readFile(outPath, "utf8"));
    const point = (mod.records ?? []).find(
      (shape) => shape.fields.map((f) => f.name).join(",") === "x,y",
    )!;
    const literal = (mod.records ?? []).find((shape) => shape.fields.length === 0)!;
    // The asserted type and the literal's own type are freezable together:
    // the object is frozen through either name.
    expect(point.freezable).toBe(true);
    expect(literal.freezable).toBe(true);
    const views = planRecordViews(mod, { traced: () => false, excluded: () => false });
    expect(views.declinedPartials).toEqual([]);
    expect(views.partial(point.id, literal.id)).toBe(true);
    expect([...views.marked]).toEqual([point.id]);
    // A marked value asks the record-source table whether it is a view, and
    // the unit that answers is linked for this program only.
    const llvm = emitLlvmModule(mod);
    // (Optimized builds test the mark inline and ask for the slot; this
    // emission makes the field address one call.)
    expect(llvm).toMatch(/@scr_record_marked_(slot|field)\(/);
    expect(llvm).toContain("@scr_record_marked_frozen(");
    expect(llvm).toContain("@scr_dyn_record_view_kept(");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a view target no value of which is frozen keeps the unmarked test", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-views-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
type Point = { x: number; y: number };
const p = {} as Point;
p.x = 1;
p.y = 2;
console.log(p.x + p.y, Object.isFrozen(p));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod: IrModule = deserializeModule(await readFile(outPath, "utf8"));
    const views = planRecordViews(mod, { traced: () => false, excluded: () => false });
    expect(views.partialTargets.size).toBe(1);
    expect(views.marked.size).toBe(0);
    expect(emitLlvmModule(mod)).not.toContain("@scr_record_marked_");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a partial literal that holds a function is declined as possibly cyclic", async () => {
  expect(
    await declinedReasons(`
type Handler = { run: () => number; label: string };
const h = { run: () => 41 } as Handler;
h.label = "h";
console.log(h.run(), h.label);
`),
  ).toEqual(["cyclic"]);
});

test("a declined partial assertion whose missing fields all admit undefined is not reported", async () => {
  // The ordinary checked conversion reads undefined into an untyped field.
  expect(
    await declinedReasons(`
type Loose = { run: () => string; payload: unknown };
const made = { run: () => "t" } as Loose;
console.log(made.run());
`),
  ).toEqual([]);
});
