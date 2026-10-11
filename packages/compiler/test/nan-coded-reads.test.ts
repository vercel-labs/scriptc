import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrFunction, IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-nan-coded-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fn(mod: IrModule, name: string): IrFunction {
  const found = mod.functions.find((f) => f.name === name || f.name.endsWith(`.${name}`));
  if (!found)
    throw new Error(`no function ${name}: ${mod.functions.map((f) => f.name).join(", ")}`);
  return found;
}

function calls(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as { kind?: string; callee?: string; fn?: string };
    if (n.kind === "call" && n.callee) out.push(n.callee);
    if (n.kind === "libCall" && n.fn) out.push(n.fn);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return out;
}

const scanner = `
class Cursor {
  pos = 0;
  readonly chars: Uint16Array;
  readonly end: number;
  constructor(chars: Uint16Array) {
    this.chars = chars;
    this.end = chars.length;
  }
  char(): number {
    return this.pos < this.end ? this.chars[this.pos] : -1;
  }
}
function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9;
}
function sameAt(a: Uint16Array, b: Uint16Array, i: number): boolean {
  return a[i] === b[i];
}
function show(chars: Uint16Array, i: number): string {
  return String(chars[i]);
}
const chars = new Uint16Array([32, 97]);
const cursor = new Cursor(chars);
let spaces = 0;
for (; cursor.pos <= cursor.end; cursor.pos++) if (isSpace(cursor.char())) spaces++;
console.log(spaces, sameAt(chars, chars, 9), show(chars, 9));
`;

test("reads whose consumers treat undefined like NaN lower to plain numbers", async () => {
  const mod = await lower(scanner);
  expect(fn(mod, "isSpace").params[0]!.type).toEqual({ kind: "f64" });
  expect(fn(mod, "char").returnType).toEqual({ kind: "f64" });
  expect(calls(fn(mod, "char").body).some((c) => c.startsWith("%bytes.idxOr"))).toBe(false);
  // Two missing elements are equal: the equality also tests for two NaNs.
  const same = calls(fn(mod, "sameAt").body);
  expect(same.some((c) => c.startsWith("%bytes.idxOr"))).toBe(false);
  expect(same).toContain("num.isNaN");
  // String() observes undefined: the ordinary optional read remains.
  expect(calls(fn(mod, "show").body).some((c) => c.startsWith("%bytes.idxOr"))).toBe(true);
});
