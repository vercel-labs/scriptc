import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-narrow-guards-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The trap call guarding narrowings of `kind`, after its message constant. */
function guardCount(llvm: string, message: string): number {
  const constant = [...llvm.matchAll(/^(@[\w.]+) = [^\n]*c"([^"]*)"/gm)].find(([, , text]) =>
    text!.startsWith(message),
  );
  if (constant === undefined) return 0;
  return llvm.split(`call void @scr_trap(ptr ${constant[1]})`).length - 1;
}

test("typeof narrowing verifies the union tag before reading the payload", async () => {
  const llvm = await emitLlvm(`
function width(v: string | number): number {
  if (typeof v === "string") return v.length;
  return v;
}
console.log(width("abc") + width(4));
`);
  expect(guardCount(llvm, "scriptc: a narrowed value does not")).toBeGreaterThan(0);
});

/** The tag compares that feed narrowing guards, as `eq K` / `ne K`. */
function guardCompares(llvm: string): string[] {
  const compares: string[] = [];
  for (const fn of llvm.split("\ndefine ")) {
    for (const [, expected, ok] of fn.matchAll(
      /(%[\w.]+) = call i1 @llvm\.expect\.i1\(i1 (%[\w.]+), i1 true\)/g,
    )) {
      if (!fn.includes(`br i1 ${expected}, label %narrow.ok`)) continue;
      const def = new RegExp(`^\\s*${ok} = icmp (eq|ne) i32 %[\\w.]+, (\\d+)$`, "m").exec(fn);
      if (def) compares.push(`${def[1]} ${def[2]}`);
    }
  }
  return compares;
}

test("two-arm union guards test the other arm; wider unions test the arm", async () => {
  const two = await emitLlvm(`
function width(v: string | number): number {
  if (typeof v === "string") return v.length;
  return v;
}
console.log(width("abc") + width(4));
`);
  const twoCompares = guardCompares(two);
  expect(twoCompares.length).toBeGreaterThan(0);
  expect(twoCompares.every((c) => c.startsWith("ne "))).toBe(true);
  const three = await emitLlvm(`
function width(v: string | number | boolean): number {
  if (typeof v === "string") return v.length;
  if (typeof v === "number") return v;
  return v ? 1 : 0;
}
console.log(width("abc") + width(4) + width(true));
`);
  const threeCompares = guardCompares(three);
  expect(threeCompares.length).toBeGreaterThan(0);
  expect(threeCompares.every((c) => c.startsWith("eq "))).toBe(true);
});

test("instanceof narrowing verifies the downcast class interval", async () => {
  const llvm = await emitLlvm(`
class Base { id = 1; }
class Child extends Base { values = [2, 4]; }
function count(value: Base): number {
  if (value instanceof Child) return value.values.length;
  return value.id;
}
console.log(count(new Child()), count(new Base()));
`);
  expect(guardCount(llvm, "scriptc: a narrowed object is not")).toBeGreaterThan(0);
});

test("catch-binding narrowing verifies the caught kind and class", async () => {
  const llvm = await emitLlvm(`
class Failure extends Error { code = 7; }
function run(which: number): string {
  try {
    if (which === 0) throw "text";
    throw new Failure("bad");
  } catch (e) {
    if (typeof e === "string") return e;
    if (e instanceof Failure) return String(e.code);
    return "other";
  }
}
console.log(run(0), run(1));
`);
  expect(guardCount(llvm, "scriptc: a narrowed catch binding")).toBeGreaterThan(1);
});

test("programs without narrowings carry no guards", async () => {
  const llvm = await emitLlvm(`
let total = 0;
for (let i = 0; i < 10; i++) total += i;
console.log(total);
`);
  expect(llvm).not.toContain("scriptc: a narrowed");
});
