import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

interface TupleCall {
  fn: string;
  /** The entries the combinator joins: the real ones, then the
   * already-fulfilled ones a promise-or-value entry adds. */
  entries: number;
}

/** Every call of the tuple forms of Promise.all and Promise.allSettled,
 * with the number of entries it hands to the combinator. */
function tupleCalls(value: unknown, found: TupleCall[] = []): TupleCall[] {
  if (Array.isArray(value)) {
    for (const item of value) tupleCalls(item, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  const node = value as { kind?: unknown; fn?: unknown; args?: unknown };
  if (
    node.kind === "libCall" &&
    (node.fn === "promise.allTuple" || node.fn === "promise.allSettledTuple") &&
    Array.isArray(node.args)
  ) {
    const entries = node.args[0] as { kind?: unknown; elems?: unknown[] };
    found.push({ fn: node.fn, entries: entries.kind === "arrayLit" ? entries.elems!.length : -1 });
  }
  for (const child of Object.values(value)) tupleCalls(child, found);
  return found;
}

const PRELUDE = `
  interface Book { isbn: string; title: string }
  interface Reader { name: string; age: number }
  declare function getBook(): Promise<Book>;
  declare function getReader(): Promise<Reader>;
  declare function getTags(): Promise<string[]>;
  declare const flag: boolean;
`;

async function compileSource(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-promise-tuple-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      `${PRELUDE}\nexport async function run(): Promise<void> {\n${body}\n}\nvoid run();\n`,
    );
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics };
    return { ok: true as const, module: deserializeModule(await readFile(outPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callsOf(body: string): Promise<TupleCall[]> {
  const result = await compileSource(body);
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return tupleCalls(result.module.functions);
}

async function refusalOf(body: string): Promise<string> {
  const result = await compileSource(body);
  if (result.ok) throw new Error("expected a refusal");
  const first = result.diagnostics[0]!;
  return `${first.code}: ${first.message}`;
}

test("a promise-or-undefined entry joins with one flag entry", async () => {
  // The promise arm settles with `Reader`, the position holds `Reader |
  // undefined`: the builder needs to know which arm was taken, and the one
  // unit arm needs no value entry.
  expect(
    await callsOf(`
      const [book, reader] = await Promise.all([getBook(), flag ? getReader() : undefined]);
      console.log(book.title, reader?.name);
    `),
  ).toEqual([{ fn: "promise.allTuple", entries: 3 }]);
});

test("a value-or-promise entry of the position's own type joins as one promise", async () => {
  expect(
    await callsOf(`
      const place: Book = { isbn: "b2", title: "lent" };
      const [book, list] = await Promise.all([flag ? place : getBook(), getTags()]);
      console.log(book.title, list.length);
    `),
  ).toEqual([{ fn: "promise.allTuple", entries: 2 }]);
});

test("a promise beside a value of another type joins with a flag and a value entry", async () => {
  expect(
    await callsOf(`
      const [n, book] = await Promise.all([flag ? getTags() : 7, getBook()]);
      console.log(typeof n, book.title);
    `),
  ).toEqual([{ fn: "promise.allTuple", entries: 4 }]);
});

test("plain values, a const assertion and a tuple variable are the tuple form", async () => {
  expect(
    await callsOf(`
      const place = { shelf: "north" };
      const a = await Promise.all([getBook(), place, [1, 2]]);
      const b = await Promise.all([getBook(), getReader()] as const);
      const trio = [getBook(), getReader(), getTags()] as const;
      const c = await Promise.all(trio);
      console.log(a[1].shelf, b[1].name, c[2].length);
    `),
  ).toEqual([
    { fn: "promise.allTuple", entries: 3 },
    { fn: "promise.allTuple", entries: 2 },
    { fn: "promise.allTuple", entries: 3 },
  ]);
});

test("Promise.allSettled over different promise types is the settled tuple form", async () => {
  expect(
    await callsOf(`
      const [book, reader] = await Promise.allSettled([getBook(), flag ? getReader() : undefined]);
      console.log(book.status, reader.status);
      const pair = [getBook(), getTags()] as const;
      const settled = await Promise.allSettled(pair);
      console.log(settled[0].status);
    `),
  ).toEqual([
    { fn: "promise.allSettledTuple", entries: 3 },
    { fn: "promise.allSettledTuple", entries: 2 },
  ]);
});

test("one promise type keeps the array combinators", async () => {
  expect(
    await callsOf(`
      const [a, b] = await Promise.all([getReader(), getReader()]);
      const [c, d] = await Promise.allSettled([getReader(), getReader()]);
      console.log(a.name, b.name, c.status, d.status);
    `),
  ).toEqual([]);
});

test("the forms the tuple form does not take stay refused by name", async () => {
  // A thenable is adopted through its `then`, which no entry kind models.
  expect(
    await refusalOf(`
      declare const thenable: { then(ok: (v: number) => void): void };
      const [a, b] = await Promise.all([thenable, getBook()]);
      console.log(a, b.title);
    `),
  ).toContain("SC");
  // A class with a subclass that declares `then` may hold one.
  expect(
    await refusalOf(`
      class Box { v = 1; }
      class Later extends Box { then(ok: (v: number) => void): void { ok(this.v); } }
      const box: Box = flag ? new Later() : new Box();
      const [a, b] = await Promise.all([box, getBook()]);
      console.log(a.v, b.title);
    `),
  ).toMatch(/^SC2020: 'Promise\.all over this argument shape'/);
  expect(
    await refusalOf(`
      const pending = new Set<Promise<number>>();
      const values = await Promise.all(pending);
      console.log(values.length);
    `),
  ).toMatch(/^SC2020: 'Promise\.all over this argument shape'/);
  expect(
    await refusalOf(`
      const settled = await Promise.allSettled([]);
      console.log(settled.length);
    `),
  ).toMatch(/^SC2020: 'Promise\.allSettled over this argument shape'/);
});
