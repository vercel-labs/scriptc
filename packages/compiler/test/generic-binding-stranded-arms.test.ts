import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A generic instance's binding holds each layout the instance binds. A
// statement that takes the value as the one record the constraint names has
// no form for the other layouts and throws for them: the build names it.
async function strandedSites(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-stranded-arms-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    return {
      ok: result.ok,
      errors: result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`),
      sites: (result.ok ? (result.warnings ?? []) : [])
        .filter((d) => d.code === "SC6015")
        .map((d) => `${source.slice(d.loc.start, d.loc.end)}: ${d.message}`),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const TABLES = `type Caster = typeof String | typeof Number | typeof Boolean;
interface Column {
  readonly title: string;
  readonly unit: string | null;
  readonly cast: Caster | ReadonlyArray<Caster>;
  readonly note?: string;
}
interface Sheet {
  readonly name: string;
  readonly columns: ReadonlyArray<Column>;
}
const price = { title: "price", unit: "eur", cast: Number, note: "net" } as const;
const paid = { title: "paid", unit: null, cast: Boolean, note: "settled" } as const;
const tags = { title: "tags", unit: null, cast: [String] } as const;
const ledger = { name: "ledger", columns: [price, paid, tags] } as const;
const archive: Sheet = { name: "archive", columns: [{ title: "owner", unit: null, cast: String }] };
function show(table: Record<string, unknown>): void {
  for (const key of Object.keys(table)) console.log(key, typeof table[key]);
}
`;

const MIXED = "show(casters([...ledger.columns, ...archive.columns]));\n";
const INTERFACE = "show(casters(archive.columns));\n";

const PASSED_ON = `function title(column: Column): string {
  return column.note ? column.title + " (" + column.note + ")" : column.title;
}
function casters<T extends ReadonlyArray<Column>>(columns: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const column of columns) out[title(column)] = column.cast;
  return out;
}
`;

const CALLBACK = `function casters<T extends ReadonlyArray<Column>>(columns: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  columns.forEach((column) => {
    out[column.title] = column.cast;
  });
  return out;
}
`;

const DESTRUCTURED = `function casters<T extends ReadonlyArray<Column>>(columns: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const { title, cast } of columns) out[title] = cast;
  return out;
}
`;

const MEMBER_READS = `function casters<T extends ReadonlyArray<Column>>(columns: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const column of columns) out[column.title] = column.cast;
  return out;
}
`;

const warning = (others: number): string =>
  `this statement throws when it runs with a value of another layout (this generic instance's binding holds ${others} other ${others === 1 ? "layout" : "layouts"} beside 'Column', and the statement takes the value as 'Column'), where it would have completed under Node; a program that never reaches it with such a value runs as it does under Node`;

test("an element passed on as the constraint's record is named at the argument", async () => {
  const result = await strandedSites(TABLES + PASSED_ON + MIXED);
  expect(result.errors).toEqual([]);
  expect(result.sites).toEqual([`column: ${warning(1)}`]);
});

test("a callback parameter bound to the constraint's record is named at the parameter", async () => {
  const result = await strandedSites(TABLES + CALLBACK + MIXED);
  expect(result.errors).toEqual([]);
  expect(result.sites).toEqual([`column: ${warning(1)}`]);
});

test("a destructuring loop head over the binding is named at the pattern", async () => {
  const result = await strandedSites(TABLES + DESTRUCTURED + MIXED);
  expect(result.errors).toEqual([]);
  expect(result.sites).toEqual([`{ title, cast }: ${warning(1)}`]);
});

test("a binding that holds the constraint's record alone is not named", async () => {
  for (const body of [PASSED_ON, CALLBACK, DESTRUCTURED]) {
    const result = await strandedSites(TABLES + body + INTERFACE);
    expect(result.errors).toEqual([]);
    expect(result.sites).toEqual([]);
  }
});

test("member reads from the loop variable keep every layout and are not named", async () => {
  const result = await strandedSites(TABLES + MEMBER_READS + MIXED);
  expect(result.errors).toEqual([]);
  expect(result.sites).toEqual([]);
});
