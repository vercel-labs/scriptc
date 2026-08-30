import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function checkRecordReadReceivers(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) checkRecordReadReceivers(item, seen);
    return;
  }
  const node = value as {
    kind?: unknown;
    obj?: { type?: { kind?: unknown; shapeId?: unknown } };
    shapeId?: unknown;
  };
  if (node.kind === "recordGet" || node.kind === "recordKeyGet") {
    expect(node.obj?.type).toEqual({ kind: "record", shapeId: node.shapeId });
  }
  for (const child of Object.values(value)) checkRecordReadReceivers(child, seen);
}

test("inline static record assertions reshape reads to the asserted representation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inline-record-assertion-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  const outPath = join(outDir, "main.ir.json");
  await writeFile(
    entry,
    [
      'const rec = { a: 1, b: "two" };',
      'console.log((rec as Record<string, unknown>)["a"]);',
      "const wide = { a: 3, b: 4 };",
      "console.log((wide as { a: number }).a, (wide as { a: number })[\"a\"]);",
      "",
    ].join("\n"),
  );

  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
  }

  const module = deserializeModule(await readFile(outPath, "utf8"));
  expect(validateModule(module)).toEqual([]);
  expect(module.functions.some((fn) => fn.name.startsWith("%rec.capture."))).toBe(true);
  checkRecordReadReceivers(module);
});
