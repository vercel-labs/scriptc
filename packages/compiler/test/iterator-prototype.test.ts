import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The serialized IR of one entry file. */
async function lowerToIr(source: string, file: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-iterator-prototype-"));
  try {
    const entry = join(dir, file);
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const usesIteratorUnit = (ir: string): boolean => /"fn":"iterator\./.test(ir);

test("Iterator.prototype read as a value in JavaScript is the live prototype", async () => {
  const ir = await lowerToIr(
    `const m = Iterator.prototype.map;\nconsole.log(typeof m);\n`,
    "main.js",
  );
  expect(ir).toContain(`"fn":"iterator.prototype"`);
});

test("a typed helper chain over a generator does not reach the iterator unit", async () => {
  const ir = await lowerToIr(
    `function* g() { yield 1; }\nconsole.log(g().map((x) => x + 1).toArray());\n`,
    "main.js",
  );
  expect(usesIteratorUnit(ir)).toBe(false);
});

test("TypeScript's typed Iterator.from keeps its static lowering", async () => {
  const ir = await lowerToIr(`console.log(Iterator.from([1, 2]).toArray());\n`, "main.ts");
  expect(usesIteratorUnit(ir)).toBe(false);
});

test("a JavaScript class extending Iterator inherits the live prototype", async () => {
  const ir = await lowerToIr(
    `class C extends Iterator { next() { return { done: true, value: undefined }; } }\nconsole.log(new C().toArray().length);\n`,
    "main.js",
  );
  expect(ir).toContain(`"fn":"iterator.prototype"`);
});
