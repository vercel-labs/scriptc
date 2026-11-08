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
