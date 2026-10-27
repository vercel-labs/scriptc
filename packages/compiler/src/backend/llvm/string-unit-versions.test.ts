import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrModule, IrStmt } from "../../ir/ir.js";
import { unitSafeFunctions, unitSafeLoop } from "./string-unit-versions.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-unit-versions-"));
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

const loopOf = (mod: IrModule, name: string): IrStmt & { kind: "for" } =>
  mod.functions.find((f) => f.name === name)!.body.find((s) => s.kind === "for") as IrStmt & {
    kind: "for";
  };

test("loops over a string's units call only functions that read no string", async () => {
  const mod = await lower(`
function lower(c: number): boolean {
  return c >= 97 && c <= 122;
}
function word(c: number): boolean {
  return lower(c) || (c >= 48 && c <= 57) || Math.abs(c - 200) < 50;
}
function codeOf(t: string, i: number): number {
  return t.charCodeAt(i);
}
function viaCodeOf(t: string): number {
  return codeOf(t, 0);
}
function words(s: string): number {
  let n = 0;
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (word(s.charCodeAt(i))) n++;
    else starts.push(i);
  }
  return n + starts.length;
}
function pairs(s: string, t: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) + codeOf(t, i);
  return n;
}
function both(s: string, t: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) + t.charCodeAt(i);
  return n;
}
function concatenates(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 32) out += "-";
  return out;
}
console.log(words("ab c"), pairs("ab", "cd"), both("ab", "cd"), concatenates("a b"), viaCodeOf("x"));
`);
  const safe = unitSafeFunctions(mod);
  expect(safe.has("lower")).toBe(true);
  expect(safe.has("word")).toBe(true);
  // A string read, directly or through a call, makes a function unsafe.
  expect(safe.has("codeOf")).toBe(false);
  expect(safe.has("viaCodeOf")).toBe(false);

  const param = (fn: string, index = 0): string =>
    mod.functions.find((f) => f.name === fn)!.params[index]!.localId;
  // A unit-safe loop answers its receiver's length reads: here the
  // condition's `s.length`.
  const lengths = unitSafeLoop(loopOf(mod, "words"), param("words"), safe);
  expect(lengths?.size).toBe(1);
  expect([...lengths!].every((e) => e.kind === "strIntrinsic" && e.method === "length")).toBe(true);
  expect(unitSafeLoop(loopOf(mod, "pairs"), param("pairs"), safe)).toBeNull();
  expect(unitSafeLoop(loopOf(mod, "both"), param("both"), safe)).toBeNull();
  expect(unitSafeLoop(loopOf(mod, "concatenates"), param("concatenates"), safe)).toBeNull();
});

test("loops that sort with a comparator or copy an untyped source get no units copy", async () => {
  // Either can run program code that indexes other strings, which evicts
  // the receiver's units while the loop reads them.
  const mod = await lower(`
function sorts(s: string, values: Float64Array, compare: (a: number, b: number) => number): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += s.charCodeAt(i);
    if (i === 3) values.sort(compare);
  }
  return n;
}
function copies(s: string, values: Float64Array, source: any): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += s.charCodeAt(i);
    if (i === 3) values.set(source);
  }
  return n;
}
function sortsNumbers(s: string, values: Float64Array): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += s.charCodeAt(i);
    if (i === 3) values.sort();
  }
  return n;
}
const values = new Float64Array([2, 1]);
console.log(sorts("abcdef", values, (a, b) => a - b), copies("abcdef", values, [4, 3]), sortsNumbers("abcdef", values));
`);
  const safe = unitSafeFunctions(mod);
  const param = (fn: string): string =>
    mod.functions.find((f) => f.name === fn)!.params[0]!.localId;
  expect(unitSafeLoop(loopOf(mod, "sorts"), param("sorts"), safe)).toBeNull();
  expect(unitSafeLoop(loopOf(mod, "copies"), param("copies"), safe)).toBeNull();
  // A numeric sort calls no program code.
  expect(unitSafeLoop(loopOf(mod, "sortsNumbers"), param("sortsNumbers"), safe)).not.toBeNull();
});
