import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The `record.sourceNote` libCalls of the module, with the IR text. */
async function sourceNotes(source: string): Promise<{ notes: number; ir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-width-keys-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ir = await readFile(outPath, "utf8");
    const mod = deserializeModule(ir);
    let notes = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; fn?: unknown };
      if (node.kind === "libCall" && node.fn === "record.sourceNote") notes++;
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return { notes, ir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const WIDE = `type Narrow = { a: number; b: number };
type Wide = { a: number; b: number; c: number };
function narrow(w: Wide): Narrow {
  return { ...w };
}
`;

test("an unobserved width spread keeps the static copy", async () => {
  const { notes, ir } = await sourceNotes(
    `${WIDE}const n = narrow({ a: 1, b: 2, c: 3 });
console.log(String(n.a + n.b));
export {};
`,
  );
  expect(notes).toBe(0);
  expect(ir).not.toContain("%widthKeys");
  expect(ir).not.toContain("dyn.assign");
});

test("an observed width spread keeps the copy's own keys", async () => {
  const { notes, ir } = await sourceNotes(
    `${WIDE}console.log(JSON.stringify(narrow({ a: 1, b: 2, c: 3 })));
export {};
`,
  );
  expect(notes).toBe(1);
  expect(ir).toContain("%widthKeys");
});

test("an observation through a container counts", async () => {
  const { notes } = await sourceNotes(
    `${WIDE}const all: Narrow[] = [narrow({ a: 1, b: 2, c: 3 })];
console.log(all);
export {};
`,
  );
  expect(notes).toBe(1);
});

test("a for-in without kept record sources answers the static walk", async () => {
  const { ir } = await sourceNotes(
    `type Narrow = { a: number; b?: string };
const r: Narrow = { a: 1 };
const keys: string[] = [];
for (const k in r) keys.push(k);
console.log(keys.join(","));
export {};
`,
  );
  expect(ir).not.toContain("record.sourceHas");
});

test("a for-in answers through a kept source once the program keeps a width spread", async () => {
  const { ir } = await sourceNotes(
    `type Narrow = { a: number; b?: string };
type Wide = { a: number; b?: string; extra: string };
function narrow(w: Wide): Narrow {
  return { ...w };
}
const r = JSON.parse('{"a":1}') as Narrow;
const keys: string[] = [];
for (const k in r) keys.push(k);
console.log(keys.join(","), JSON.stringify(narrow({ a: 1, extra: "x" })));
export {};
`,
  );
  expect(ir).toContain("record.sourceHas");
});

test("a for-in over another shape stays static when a width spread is kept elsewhere", async () => {
  // `r` is a literal: an Other built by a checked conversion answers for-in
  // through its own kept source (record-links.ts).
  const { ir } = await sourceNotes(
    `type Narrow = { a: number; b?: string };
type Other = { x: number; y?: string };
type Wide = { a: number; b?: string; extra: string };
function narrow(w: Wide): Narrow {
  return { ...w };
}
const r: Other = { x: 1 };
const keys: string[] = [];
for (const k in r) keys.push(k);
console.log(keys.join(","), JSON.stringify(narrow({ a: 1, extra: "x" })));
export {};
`,
  );
  expect(ir).not.toContain("record.sourceHas");
});

test("a same-shape copy of a shape no conversion builds stays the static copy", async () => {
  const { notes, ir } = await sourceNotes(
    `type Narrow = { a: number; b?: string };
function copy(r: Narrow): Narrow {
  return { ...r };
}
const k: Narrow = { a: 1 };
console.log(JSON.stringify(copy(k)));
export {};
`,
  );
  expect(notes).toBe(0);
  expect(ir).not.toContain("%widthKeys");
});

test("a same-shape spread of a kept record copies its own keys", async () => {
  const { notes, ir } = await sourceNotes(
    `type Narrow = { a: number; b?: string };
const r = JSON.parse('{"a":1}') as Narrow;
const copy: Narrow = { ...r };
console.log(JSON.stringify(copy));
export {};
`,
  );
  expect(notes).toBe(1);
  expect(ir).toContain("%widthKeys");
});

test("a top-level record scope stays byte-identical without kept sources", async () => {
  const { notes } = await sourceNotes(
    `type Narrow = { a: number; b?: string };
const r: Narrow = { a: 1 };
const copy: Narrow = { ...r, b: "x" };
console.log(JSON.stringify(copy));
export {};
`,
  );
  expect(notes).toBe(0);
});

test("a clone of a checked record keeps its keys without a kept width spread", async () => {
  const { notes } = await sourceNotes(
    `type R = { a: number };
const r = JSON.parse('{"a":1,"extra":2}') as R;
console.log(JSON.stringify({ ...r, a: 5 }));
export {};
`,
  );
  expect(notes).toBe(1);
});

test("a width spread observed only through a later spread keeps its keys", async () => {
  const { notes } = await sourceNotes(
    `${WIDE}const n = narrow({ a: 1, b: 2, c: 3 });
console.log(JSON.stringify({ ...n, d: 4 }));
export {};
`,
  );
  expect(notes).toBe(2);
});

test("a width spread observed only by presence tests keeps its keys", async () => {
  const { notes } = await sourceNotes(
    `${WIDE}const n = narrow({ a: 1, b: 2, c: 3 });
console.log(String("c" in n), String(Object.hasOwn(n, "c")));
export {};
`,
  );
  expect(notes).toBe(1);
});

test("a same-shape spread of a nested checked record copies its own keys", async () => {
  const { notes } = await sourceNotes(
    `type Inner = { v: number };
type Outer = { inner: Inner };
const o = JSON.parse('{"inner":{"v":1,"x":2}}') as Outer;
const copy: Inner = { ...o.inner };
console.log(JSON.stringify(copy));
export {};
`,
  );
  expect(notes).toBe(1);
});
