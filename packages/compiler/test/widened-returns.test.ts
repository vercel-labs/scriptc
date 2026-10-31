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
function forwardingChain(depth: number, recursive = false): string {
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
      ...(recursive ? [`  if (n > 20) return f${i}(a, b, n - 1);`] : []),
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

test(
  "return widening reads each forwarded callee's type once when the callees call themselves",
  { timeout: 60_000 },
  async () => {
    const mod = await lowerModule(forwardingChain(40, true));
    const top = mod.functions.find((f) => f.name === "f40");
    expect(top).toBeDefined();
    expect(top!.returnType.kind).toBe("union");
  },
);

test("a nested function's widened return follows each instance's type arguments", async () => {
  const mod = await lowerModule(
    [
      "export {};",
      "function outer<T>(x: T, n: number) {",
      "  const inner = () => {",
      "    if (n > 0) return { status: x, value: n };",
      "    return { status: x };",
      "  };",
      "  return inner();",
      "}",
      "console.log(JSON.stringify(outer(1, 1)));",
      'console.log(JSON.stringify(outer("s", 1)));',
      "console.log(JSON.stringify(outer(true, 0)));",
    ].join("\n"),
  );
  const shapes = new Map((mod.records ?? []).map((r) => [r.id, r]));
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  // Each closure returns records whose `status` has the type its captured
  // `x` has.
  const closures = mod.functions.filter(
    (f) => f.name.startsWith("%fn.") && !f.name.includes("adapt"),
  );
  expect(closures.length).toBe(3);
  for (const closure of closures) {
    const captured = closure.captures?.find((c) => c.type.kind !== "f64")?.type.kind ?? "f64";
    const ret = closure.returnType;
    expect(ret.kind).toBe("union");
    const arms = ret.kind === "union" ? (unions.get(ret.unionId)?.arms ?? []) : [];
    expect(arms.length).toBe(2);
    for (const arm of arms) {
      expect(arm.kind).toBe("record");
      const status =
        arm.kind === "record"
          ? shapes.get(arm.shapeId)?.fields.find((f) => f.name === "status")
          : undefined;
      expect(status?.type.kind).toBe(captured);
    }
  }
});
