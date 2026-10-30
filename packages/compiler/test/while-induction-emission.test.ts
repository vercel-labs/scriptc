import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-while-induction-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath,
      outputKind: "llvm",
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The definition holding the function's statements: the borrowed-argument
 * body when there is one, otherwise the function itself. */
function body(ll: string, name: string): string {
  const definition = (prefix: string): number =>
    ll.search(new RegExp(`define [^\\n]*@${prefix}_${name}\\(`));
  const start = definition("sc_bf") >= 0 ? definition("sc_bf") : definition("sc_f");
  expect(start).toBeGreaterThanOrEqual(0);
  return ll.slice(start, ll.indexOf("\n}\n", start));
}

test("a while loop bounded by a byte length keeps its counter and companions in integers", async () => {
  const ll = await emitLlvm(`
function reversed(line: Uint8Array, target: Uint8Array): number {
  const len = line.length;
  let read = 0;
  let written = 0;
  let lines = 0;
  while (read < len) {
    const c = line[len - 1 - read]!;
    read++;
    if (c === 10) {
      if (read === len) break;
      read++;
    }
    target[written] = c;
    written++;
    if (written % 60 === 0) {
      target[written] = 10;
      written++;
      lines++;
    }
  }
  return written + lines;
}
console.log(reversed(new Uint8Array([65, 10, 66]), new Uint8Array(8)));
`);
  const fn = body(ll, "reversed");
  expect(fn).toContain("alloca i64 ; integer read");
  expect(fn).toContain("alloca i64 ; integer written");
  expect(fn).toContain("alloca i64 ; integer lines");
});

test("a companion a nested loop advances, or a counter a continue can skip, stays a double", async () => {
  const ll = await emitLlvm(`
function nested(line: Uint8Array): number {
  let read = 0;
  let total = 0;
  while (read < line.length) {
    read++;
    for (let j = 0; j < 2; j++) total++;
  }
  return total;
}
function skipped(line: Uint8Array): number {
  let read = 0;
  let total = 0;
  while (read < line.length) {
    if (line[read] === 0) continue;
    read++;
    total++;
  }
  return total;
}
console.log(nested(new Uint8Array(3)), skipped(new Uint8Array([1, 2])));
`);
  expect(body(ll, "nested")).not.toContain("; integer total");
  // The counter compared with the length directly is an integer.
  expect(body(ll, "skipped")).toContain("; integer read");
  expect(body(ll, "skipped")).not.toContain("; integer total");
});
