import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrFunction } from "../src/ir/ir.js";

/** Every `dynCheck` over a `dynFrom` inside a retag helper: the checked
 * payload widening of a promise (the settled value validates against the
 * slot's promise payload). */
function promisePayloadConversions(functions: IrFunction[]): number {
  let found = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as { kind?: unknown; type?: unknown; value?: unknown };
    if (
      node.kind === "dynCheck" &&
      (node.type as { kind?: unknown }).kind === "promise" &&
      (node.value as { kind?: unknown } | undefined)?.kind === "dynFrom"
    )
      found++;
    for (const child of Object.values(value)) visit(child);
  };
  visit(functions);
  return found;
}

async function compileSource(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-promise-union-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics };
    return { ok: true as const, module: deserializeModule(await readFile(outPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a promise arm widens its payload in a union conversion", async () => {
  const result = await compileSource(`
    function settle(flag: boolean): Promise<void> | undefined {
      return flag ? Promise.resolve() : undefined;
    }
    const widened: Promise<unknown> | undefined = settle(true);
    console.log(widened === undefined);
    export {};
    `);
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const retag = result.module.functions.filter((fn) => fn.name.startsWith("%union.retag."));
  expect(retag).toHaveLength(1);
  // The promise arm's payload converts through the checked-dynamic box; the
  // undefined arm copies.
  expect(promisePayloadConversions(retag)).toBe(1);
});

test("an equal promise arm stays a plain copy", async () => {
  const result = await compileSource(`
    function load(flag: boolean): Promise<unknown> | undefined {
      return flag ? Promise.resolve() : undefined;
    }
    const same: Promise<unknown> | number | undefined = load(true);
    console.log(same === undefined);
    export {};
    `);
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const retag = result.module.functions.filter((fn) => fn.name.startsWith("%union.retag."));
  expect(retag).toHaveLength(1);
  expect(promisePayloadConversions(retag)).toBe(0);
});

test("two destination promise arms keep the conversion fence", async () => {
  const result = await compileSource(`
    function settle(flag: boolean): Promise<void> | undefined {
      return flag ? Promise.resolve() : undefined;
    }
    const ambiguous: Promise<unknown> | Promise<string> | undefined = settle(true);
    console.log(ambiguous === undefined);
    export {};
    `);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toContain("SC2003");
});
