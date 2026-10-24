import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../index.js";
import { holdCharLocalsAsUnits } from "./char-unit-locals.js";
import type { IrFunction, IrModule } from "./ir.js";
import { everyStmtList } from "./traverse.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-char-units-"));
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

const fn = (mod: IrModule, name: string): IrFunction => mod.functions.find((f) => f.name === name)!;

/** The kinds of the function's string tests and string intrinsics. */
function reads(f: IrFunction): string[] {
  const out: string[] = [];
  everyStmtList(f.body, {
    stmt: () => true,
    expr: (e) => {
      if (e.kind === "strEq" || e.kind === "strCmp") out.push(e.kind);
      if (e.kind === "strIntrinsic") out.push(e.method);
      return true;
    },
  });
  return out;
}

test("a character local used only in one-unit tests holds its code unit", async () => {
  const mod = holdCharLocalsAsUnits(
    await lower(`
function classify(s: string, i: number): number {
  const c = s.charAt(i);
  let n = 0;
  if (c === " ") n += 1;
  if (c !== "\\t") n += 2;
  if ("a" <= c && c <= "z") n += 4;
  if (c < "0" || c > "9") n += 8;
  switch (c) {
    case "5":
      n += 16;
      break;
    default:
      n += 32;
  }
  return n;
}
console.log(classify("a b", 1), classify("x", 0), classify("7", 0), classify("5", 0), classify("", 3));
`),
  );
  const classify = fn(mod, "classify");
  expect(reads(classify)).toEqual(["charCodeAt"]);
  expect(classify.locals.find((l) => l.name === "c")!.type).toEqual({ kind: "f64" });
});

test("a character local with any other use stays a string", async () => {
  const before = await lower(`
function escapes(s: string, i: number): string {
  const c = s.charAt(i);
  return c === " " ? "space" : c;
}
function rebound(s: string, i: number): boolean {
  let c = s.charAt(i);
  if (c === " ") c = s.charAt(i + 1);
  return c === "x";
}
function wide(s: string, i: number): boolean {
  const c = s.charAt(i);
  return c === "ab" || c < "b";
}
function against(s: string, t: string, i: number): boolean {
  const c = s.charAt(i);
  return c < t;
}
function captured(s: string, i: number): () => boolean {
  const c = s.charAt(i);
  return () => c === "y";
}
console.log(escapes("a b", 1), rebound("  x", 0), wide("ab", 0), against("a", "b", 0), captured("y", 0)());
`);
  const after = holdCharLocalsAsUnits(before);
  for (const name of ["escapes", "rebound", "wide", "against", "captured"]) {
    expect(fn(before, name)).toBeDefined();
    expect(fn(after, name)).toBe(fn(before, name));
  }
});

test("charAt tests in place compare charCodeAt", async () => {
  const mod = holdCharLocalsAsUnits(
    await lower(`
function tests(s: string, i: number): number {
  let n = 0;
  if (s.charAt(i) === " ") n += 1;
  if ("a" <= s.charAt(i) && s.charAt(i) < "n") n += 2;
  if (s.charAt(i) === "ab") n += 4;
  return n;
}
console.log(tests("a b", 1), tests("abc", 0), tests("", 2));
`),
  );
  // The two-unit literal keeps its string comparison.
  expect(reads(fn(mod, "tests"))).toEqual([
    "charCodeAt",
    "charCodeAt",
    "charCodeAt",
    "strEq",
    "charAt",
  ]);
});
