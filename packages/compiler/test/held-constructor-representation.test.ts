import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-held-constructors-"));
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
      dynamicSlots: (result.ok ? (result.warnings ?? []) : [])
        .filter((d) => d.code === "SC6104")
        .map((d) => d.message),
      // SC6015: the statements that compile to a throw.
      throwing: (result.ok ? (result.warnings ?? []) : [])
        .filter((d) => d.code === "SC6015")
        .map((d) => d.message),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const SHELF = `type Reader = typeof String | typeof Number | typeof Boolean;
const shelf: Record<string, Reader> = { title: String, pages: Number, lent: Boolean };
`;

// Calls, identity and names are what the function form of a held constructor
// serves: the table stays a typed record of one function type.
test("a table of constructors that is called and compared keeps its typed form", async () => {
  const result = await compileSource(`${SHELF}for (const key of Object.keys(shelf)) {
  const read = shelf[key];
  console.log(key, read.name, read === Boolean, String(read("7")));
}
`);
  expect(result.errors).toEqual([]);
  expect(result.dynamicSlots).toEqual([]);
});

// Printing a typed record of functions is refused by the typed tier. The
// program is lowered again with its constructors untyped, where the table
// is a record of untyped values and prints, and that pass stands.
test("a consumer the typed form refuses holds the table untyped instead", async () => {
  const result = await compileSource(`${SHELF}console.log(shelf, JSON.stringify(shelf));
`);
  expect(result.errors).toEqual([]);
});

// A refusal elsewhere in the program is not the table's: nothing is compared
// and the table's typed form reports no dynamic slot beside the error.
test("a refusal that involves no held constructor leaves the table typed", async () => {
  const result = await compileSource(`${SHELF}function widen(): number {
  const marks = [1, 2];
  (marks as any).label = 1;
  return marks.length;
}
console.log(shelf.title === String, widen());
`);
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("assignment to non-variables");
});

// One constructor held alone takes the same path as a table of several.
test("a single held constructor handed to a consumer the typed form refuses", async () => {
  const result = await compileSource(`const read: typeof Number = Number;
console.log("name" in read, Object.keys(read).length, read("4") + 1);
`);
  expect(result.errors).toEqual([]);
});

// A statement whose refusal waits for it to run, or that hands a held
// constructor to an operation the runtime refuses, is named by the build:
// a TypeScript program is otherwise told at build time what does not compile.
test("the build names each statement that throws when it runs", async () => {
  const result = await compileSource(`import { format } from "node:util";
${SHELF}function pick(reader: Reader): Reader {
  return reader;
}
const held = pick(String);
function seldom(): void {
  const wrapped = new held("4");
  const shown = format("%o", held);
  const parent = Object.getPrototypeOf(held);
  console.log(typeof wrapped, shown, parent === null);
}
if (process.argv.length > 9) seldom();
console.log(held("7"), shelf.pages === Number, format("%s", held.name));
`);
  expect(result.errors).toEqual([]);
  expect(result.throwing).toHaveLength(3);
  expect(result.throwing[0]).toContain("SC1090: 'new' through a held String, Number, Boolean");
  expect(result.throwing[1]).toContain("util.format %o of function values");
  expect(result.throwing[2]).toContain("Object.getPrototypeOf of a held built-in constructor");
});

// The prototype of a held constructor is refused by name, whether the value
// is read from a member or from a binding; the constructor's own name is
// not a held value.
test("the prototype of a constructor held in a binding is refused at build time", async () => {
  const result = await compileSource(`${SHELF}function pick(reader: Reader): Reader {
  return reader;
}
const held = pick(String);
console.log(held.prototype === String.prototype);
`);
  expect(result.ok).toBe(false);
  expect(result.errors.join("\\n")).toContain("prototype");
});
