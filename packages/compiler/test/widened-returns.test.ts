import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lowerModule(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-widened-returns-"));
  try {
    const entry = join(dir, "main.ts");
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

/** Functions that each forward to the previous one along two return
 * branches, above one whose inferred type the checker reduced. */
function forwardingChain(depth: number): string {
  const lines = [
    "export {};",
    "type Short = { status: string };",
    "type Long = { status: string; value: number };",
    "function f0(a: Short, b: Long, n: number) {",
    "  if (n > 5) return b;",
    "  return a;",
    "}",
  ];
  for (let i = 1; i <= depth; i++)
    lines.push(
      `function f${i}(a: Short, b: Long, n: number) {`,
      `  if (n > 1) return f${i - 1}(a, b, n - 1);`,
      `  if (n > 0) return f${i - 1}(a, b, n + 1);`,
      "  return a;",
      "}",
    );
  lines.push(
    `console.log(JSON.stringify(f${depth}({ status: "a" }, { status: "b", value: 1 }, 9)));`,
  );
  return lines.join("\n");
}

test("return widening reads each forwarded callee's type once", { timeout: 60_000 }, async () => {
  // Rescanning the callee along every return branch takes 2^depth scans.
  const mod = await lowerModule(forwardingChain(40));
  const top = mod.functions.find((f) => f.name === "f40");
  expect(top).toBeDefined();
  expect(top!.returnType.kind).toBe("union");
});
