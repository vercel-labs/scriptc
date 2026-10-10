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

const relation = `
class Relation {
  private readonly regular = new Int32Array(4);
  assignable(source: number, target: number): boolean {
    if (source === target) return true;
    return this.related(source, target);
  }
  related(inputSource: number, inputTarget: number): boolean {
    const regularSource = this.regular[inputSource];
    const sourceId = regularSource >= 0 ? regularSource : inputSource;
    return this.simple(sourceId, inputTarget);
  }
  simple(sourceId: number, targetId: number): boolean {
    return sourceId === targetId;
  }
}
function probe(a: number, b: number): boolean {
  return a === b;
}
function escaped(a: number): boolean {
  return String(a) === "0";
}
function grab(t: Uint32Array): number {
  return t.length;
}
const relation = new Relation();
const nan = process.argv.length / 0 - process.argv.length / 0;
const ids = [1, nan, 3];
const sources = new Uint32Array(ids.length);
const targets = new Uint32Array(ids.length);
const shorter = new Uint32Array(ids.length - 1);
for (let i = 0; i < ids.length; i++) {
  sources[i] = ids[i]!;
  targets[i] = ids[i]!;
  relation.assignable(ids[i]!, nan);
  probe(ids[i]!, nan);
  escaped(nan);
}
function run(): number {
  const xs = new Uint32Array(ids.length);
  const ys = new Uint32Array(ids.length);
  let hits = 0;
  for (let i = 0; i < xs.length; i++) if (relation.assignable(xs[i], ys[i])) hits++;
  for (let i = 0; i < xs.length; i++) if (probe(xs[i], shorter[i])) hits++;
  const zs = new Uint32Array(ids.length);
  grab(zs);
  for (let i = 0; i < zs.length; i++) if (escaped(zs[i])) hits++;
  return hits;
}
console.log(run(), sources.length, targets.length);
`;

test("proven-present reads and guarded occurrences keep numeric parameters plain", async () => {
  const mod = await lower(relation);
  const f64 = { kind: "f64" };
  // Parallel same-length typed arrays read under `i < xs.length`.
  expect(
    fn(mod, "assignable")
      .params.slice(1)
      .map((p) => p.type),
  ).toEqual([f64, f64]);
  // `regularSource >= 0 ? regularSource : ...` holds a number in its true arm.
  expect(
    fn(mod, "simple")
      .params.slice(1)
      .map((p) => p.type),
  ).toEqual([f64, f64]);
  // `shorter` is not as long as `xs`: its read may be undefined.
  expect(fn(mod, "probe").params[1]!.type.kind).toBe("union");
  // Code holding `zs` could detach its buffer: no proof.
  expect(fn(mod, "escaped").params[0]!.type.kind).toBe("union");
});
