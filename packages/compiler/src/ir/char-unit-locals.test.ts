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

/** The union and dynamic comparisons left in the function. */
function unionTests(f: IrFunction): string[] {
  const out: string[] = [];
  everyStmtList(f.body, {
    stmt: () => true,
    expr: (e) => {
      if (e.kind === "unionEq" || e.kind === "unionIsTag") out.push(e.kind);
      if (e.kind === "libCall" && e.fn === "js.compare") out.push(e.fn);
      if (e.kind === "strIntrinsic") out.push(e.method);
      return true;
    },
  });
  return out;
}

test("optional character reads compare their code unit", async () => {
  const mod = holdCharLocalsAsUnits(
    await lower(`
function scan(src: string, pos: number): number {
  let n = 0;
  if (src[pos] === " ") n += 1;
  if (src[pos] !== "x") n += 2;
  if (src[pos] < "a" || "z" <= src[pos]) n += 4;
  if (src[pos + 1] === "=") n += 8;
  const c = src[pos];
  if (c === undefined) n += 16;
  if (c !== undefined && c > "m") n += 32;
  switch (c) {
    case "q":
      n += 64;
      break;
    case "r":
      n += 128;
  }
  return n;
}
console.log(scan("a b", 1), scan("q", 0), scan("ab", 5), scan("r=", 0.5));
`),
  );
  const scan = fn(mod, "scan");
  // Only charCodeAt reads remain: no union tests, dynamic compares, charAt
  // or length reads.
  expect(new Set(unionTests(scan))).toEqual(new Set(["charCodeAt"]));
  expect(scan.locals.find((l) => l.name === "c")!.type).toEqual({ kind: "f64" });
});

test("optional character reads with other uses stay reads", async () => {
  const before = await lower(`
function kept(src: string, pos: number): string {
  const c = src[pos];
  if (c === " ") return "space";
  return c ?? "end";
}
function longer(src: string, pos: number): boolean {
  return src[pos] === "ab";
}
function twice(src: string, pos: number): boolean {
  return src[pos * 2] === undefined;
}
console.log(kept("a b", 1), kept("ab", 0), kept("", 3), longer("ab", 0), twice("ab", 1));
`);
  const after = holdCharLocalsAsUnits(before);
  for (const name of ["kept", "longer", "twice"]) {
    expect(fn(before, name)).toBeDefined();
    expect(unionTests(fn(after, name))).toEqual(unionTests(fn(before, name)));
  }
  // The local's own test still reads it as a union.
  expect(unionTests(fn(after, "kept"))).toContain("unionEq");
});
