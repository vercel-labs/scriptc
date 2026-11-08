import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule, IrType } from "../src/ir/ir.js";

// A JavaScript `let` declared without a value takes the type of the values
// written to it.

async function lowerJs(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-evolving-let-"));
  try {
    const entry = join(dir, "main.cjs");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function localType(mod: IrModule, fnName: string, local: string): IrType | undefined {
  const fn = mod.functions.find((f) => f.name === fnName);
  return fn?.locals.find((l) => l.name === local)?.type;
}

test("a let written only by for-in heads holds strings", async () => {
  const mod = await lowerJs(
    [
      "function keys(object) {",
      "  let name;",
      "  const kept = [];",
      '  for (name in object) if (name !== "skip") kept.push(name.toUpperCase());',
      "  for (name in { extra: 1 }) kept.push(name);",
      '  return kept.join(",");',
      "}",
      "console.log(keys({ a: 1, skip: 2 }));",
    ].join("\n"),
  );
  expect(localType(mod, "keys", "name")).toEqual({ kind: "string" });
});
