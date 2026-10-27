import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The IR type kind of each named module-level binding. */
async function globalKinds(source: string): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dictionary-views-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    return Object.fromEntries((mod.globals ?? []).map((g) => [g.name, g.type.kind]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const program = (body: string): string => `
const key = String(process.argv.length);
const counts: Record<string, number> = { a: 1 };
counts[key] = 2;
${body}
console.log(JSON.stringify(counts));
`;

test("a record written through a dictionary keeps that dictionary type checked", async () => {
  const kinds = await globalKinds(
    program(`const point: { a: string } = { a: "x" };
const table: Record<string, string> = point;
table[key] = "y";
console.log(JSON.stringify(point));`),
  );
  expect(kinds["table"]).toBe("dyn");
  // Dictionaries of other value types keep their native layout.
  expect(kinds["counts"]).toBe("record");
});

test("a record reaching a dictionary through a {} parameter keeps it checked", async () => {
  const kinds = await globalKinds(
    program(`function stamp(value: {}): void {
  const inner: Record<string, string> = value;
  inner[key] = "y";
}
const point: { a: string } = { a: "x" };
stamp(point);
const other: Record<string, string> = { b: "z" };
console.log(JSON.stringify(point), other["b"]);`),
  );
  expect(kinds["other"]).toBe("dyn");
});

test("dictionaries keep their native layout without a record flowing in", async () => {
  const kinds = await globalKinds(
    program(`const table: Record<string, string> = { a: "x" };
table[key] = "y";
const copy: Record<string, string> = table;
copy[key] = "z";
console.log(JSON.stringify(table));`),
  );
  expect(kinds["table"]).toBe("record");
  expect(kinds["copy"]).toBe("record");
});

test("a record converted to a dictionary that is only read keeps the native layout", async () => {
  const kinds = await globalKinds(
    program(`const point: { a: string } = { a: "x" };
const table: Record<string, string> = point;
console.log(table["a"]);`),
  );
  expect(kinds["table"]).toBe("record");
});

test("a dictionary literal whose methods read this keeps checked identity", async () => {
  const kinds = await globalKinds(
    program(`interface Table { [key: string]: () => number }
const methods: Table = {
  base() { return 2; },
  twice() { return this.base() * 2; },
};
console.log(methods.twice());`),
  );
  expect(kinds["methods"]).toBe("dyn");
});
