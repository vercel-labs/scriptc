// An object literal's `name: []` has no element type of its own (`never[]`).
// It is one array under every name, so it is typed where it is written, by
// the typed slots its value reaches, and no slot converts it afterwards: the
// lowered module holds no array conversion helper for it. Where nothing can
// decide one type, the use is refused by name (SC2015) instead of copied.
// The run-time behaviour is pinned against Node by
// tests/corpus/empty-array-one-identity.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

async function lowered(source: string): Promise<{ text: string; diagnostics: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-empty-array-places-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { text: "", diagnostics: result.diagnostics.map((d) => d.code) };
    const text = await readFile(outPath, "utf8");
    expect(validateModule(deserializeModule(text) as never)).toEqual([]);
    return { text, diagnostics: [] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The conversion helpers that build a new array or record. */
const COPY_HELPER = /%(arr\.width|arr\.empty|rec\.width|rec\.capture|tup\.arr)\b/;

test("a field read at a typed slot is the field's own array", async () => {
  const { text, diagnostics } = await lowered(`
const o = { files: [] };
function addTo(list: string[], value: string): void {
  list.push(value);
}
addTo(o.files, "x");
const f: string[] = o.files;
f.push("y");
console.log(o.files.length);
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});

test("a record stored and returned at its declared type is one record", async () => {
  const { text, diagnostics } = await lowered(`
interface Info {
  names: string[];
  count: number;
}
const table = new Map<string, Info>();
function infoFor(key: string): Info {
  const created = { names: [], count: 0 };
  table.set(key, created);
  return created;
}
infoFor("a").names.push("x");
console.log(table.get("a")!.names.length);
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});

test("a callback's result typed by the array it fills is built at that type", async () => {
  const { text, diagnostics } = await lowered(`
interface Row {
  name: string;
  tags: string[];
}
const rows: Row[] = ["a", "b"].map((name) => ({ name, tags: [] }));
rows[0]!.tags.push("t");
console.log(rows.length);
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});

test("an untyped binding of the field is an alias, not a number array", async () => {
  const { text, diagnostics } = await lowered(`
const o = { files: [] };
const alias = o.files;
const list = () => o.files;
console.log(alias === o.files, list() === o.files);
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});

test("one array used at two element types is refused by name", async () => {
  const { diagnostics } = await lowered(`
const o = { files: [] };
const names: string[] = o.files;
const sizes: number[] = o.files;
console.log(names.length, sizes.length);
`);
  expect(diagnostics).toContain("SC2015");
});

test("an empty table passed for a type parameter is the parameter's own array", async () => {
  const { text, diagnostics } = await lowered(`
interface Stop {
  town: string;
  minutes: number;
}
interface Route {
  line: string;
  stops: readonly Stop[];
}
function total<T extends ReadonlyArray<Stop>>(stops: T): number {
  let sum = stops.length;
  for (const stop of stops) sum += stop.minutes;
  return sum;
}
function describe(route: Route): number {
  return route.stops.length;
}
const depot = { line: "depot", stops: [] } as const;
const spare = { line: "spare", stops: [] };
console.log(total(depot.stops), describe(depot), total(spare.stops));
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});

test("a conditional over an empty table holds the table at its decided type", async () => {
  const { text, diagnostics } = await lowered(`
function size(names: readonly string[]): number {
  return names.length;
}
const empty = { names: [] } as const;
const other: readonly string[] = ["a"];
const picked = process.argv.length > 99 ? other : empty.names;
console.log(size(picked), size(empty.names));
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});

test("a spread of an empty table adds nothing to a literal of another element type", async () => {
  const { text, diagnostics } = await lowered(`
const empty = { names: [] } as const;
const more: string[] = [...empty.names, "a"];
console.log(more.length, empty.names.length);
`);
  expect(diagnostics).toEqual([]);
  expect(text).toMatch(/%arr\.nospread\b/);
});

test("one table passed for two type parameters of different elements stays the array of nothing", async () => {
  const { text, diagnostics } = await lowered(`
function towns<T extends readonly string[]>(names: T): number {
  return names.length;
}
function times<T extends readonly number[]>(minutes: T): number {
  return minutes.length;
}
const NOTHING = [] as const;
console.log(towns(NOTHING), times(NOTHING));
`);
  expect(diagnostics).toEqual([]);
  expect(text).not.toMatch(COPY_HELPER);
});
