import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

/** Lower one program to IR; a fence answers its diagnostic codes instead. */
async function lower(
  source: string,
): Promise<{ ok: true; module: IrModule } | { ok: false; codes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-iterable-union-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false, codes: result.diagnostics.map((d) => d.code) };
    return { ok: true, module: deserializeModule(await readFile(outPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every IR node kind present in the module, as a set. */
function nodeKinds(module: IrModule): Set<string> {
  const kinds = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as { kind?: unknown };
    if (typeof node.kind === "string") kinds.add(node.kind);
    for (const child of Object.values(value)) visit(child);
  };
  visit(module.functions);
  return kinds;
}

test("a for-of over an iterable beside never[] walks the iterable on its tag", async () => {
  const result = await lower(`
function setTotal(registry: Map<string, Set<string>>, key: string): number {
  let total = 0;
  for (const name of registry.get(key) ?? []) total += name.length;
  return total;
}
function mapTotal(registry: Map<string, Map<string, number>>, key: string): number {
  let total = 0;
  for (const [name, value] of registry.get(key) ?? []) total += name.length + value;
  return total;
}
function stringTotal(registry: Map<string, string>, key: string): number {
  let total = 0;
  for (const ch of registry.get(key) ?? []) total += ch.length;
  return total;
}
console.log(setTotal(new Map(), "k"), mapTotal(new Map(), "k"), stringTotal(new Map(), "k"));
export {};
`);
  if (!result.ok) throw new Error(`fenced: ${result.codes.join(", ")}`);
  expect(validateModule(result.module)).toEqual([]);
  const kinds = nodeKinds(result.module);
  // The loop is guarded by the arm's tag; the empty-array arm yields nothing.
  expect(kinds.has("unionIsTag")).toBe(true);
  expect(kinds.has("unionNarrow")).toBe(true);
});

test("a for-of over never[] beside an effectful receiver evaluates it once", async () => {
  const result = await lower(`
function registry(): Map<string, Set<string>> | undefined {
  return new Map();
}
function total(): number {
  let sum = 0;
  for (const name of registry() ?? []) sum += name.length;
  return sum;
}
console.log(total());
export {};
`);
  if (!result.ok) throw new Error(`fenced: ${result.codes.join(", ")}`);
  expect(validateModule(result.module)).toEqual([]);
  // The tag test and the walk share ONE evaluation: the receiver is a call,
  // not a plain read, so it lands in a hidden local both reads use.
  let calls = 0;
  const count = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) count(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as { kind?: unknown; callee?: unknown };
    if (node.kind === "call" && node.callee === "registry") calls++;
    for (const child of Object.values(value)) count(child);
  };
  count(result.module.functions);
  expect(calls).toBe(1);
});

test("a union of two inhabited iterables still has no common iteration", async () => {
  const result = await lower(`
function total(registry: Map<string, Set<string> | string[]>, key: string): number {
  let sum = 0;
  for (const item of registry.get(key) ?? []) sum += item.length;
  return sum;
}
console.log(total(new Map(), "k"));
export {};
`);
  // Both arms can hold values, and the two walks yield at different element
  // kinds through different protocols: the union keeps its fence.
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.codes).toEqual(["SC2001"]);
});
