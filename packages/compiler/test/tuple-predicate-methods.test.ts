import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-tuple-predicates-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, source);
  try {
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each(["filter", "find", "findIndex", "some"])(
  "tuple .%s keeps callback identity and thisArg boundaries explicit",
  async (method) => {
    for (const [invocation, code] of [
      [`${method}((value, index, array) => array[index] === value)`, "SC2020"],
      [`${method}(() => true, {})`, "SC2020"],
      [`${method}(() => {})`, "SC1090"],
    ]) {
      const result = await compileSource(
        `const tuple = [1, 2] as const; console.log(tuple.${invocation});`,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected tuple predicate refusal");
      expect(
        result.diagnostics.some((diagnostic) => diagnostic.code === code),
        JSON.stringify(result.diagnostics),
      ).toBe(true);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
    }
  },
);

test.each(["filter", "find"])(
  "tuple .%s rejects asserted narrowing even after an inferred helper was cached",
  async (method) => {
    const result = await compileSource(`
const tuple: [number, string] = [1, "two"];
console.log(tuple.${method}(value => typeof value === "string"));
console.log(tuple.${method}((value): value is string => true));
`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected asserted narrowing refusal");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC1090")).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
  },
);
