import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { setCheckIncremental } from "../src/frontend/lowering/fixpoint-worklist.js";

/** A program that reaches every sub-dispatch the class dispatch fixpoint
 * runs: boxed classes, class values, caught values, generators stepped from
 * untyped values, prototype reads, and a deferred module registry. */
const FIXTURE = `class Point {
  constructor(public x: number, public y: number) {}
  describe(): string { return this.x + "," + this.y; }
}
class Counter {
  value = 0;
  bump(): void { this.value++; }
}
const registry = {
  make(): Point { return new Point(1, 2); },
  label: "registry",
};
function* numbers(limit: number): Generator<number> {
  for (let i = 0; i < limit; i++) yield i;
}
function describe(value: unknown): string {
  if (value instanceof Point) return "point " + value.describe();
  if (typeof value === "object" && value !== null) return (value as Point).describe();
  return String(value);
}
function construct(callee: unknown, value: number): unknown {
  return new (callee as new (value: number) => unknown)(value);
}
function caught(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}
const untyped = (target: any): any => target.describe();
let counter = new Counter();
counter.bump();
const stepped = [...numbers(4)].map((n) => n * 2).reduce((a, b) => a + b, 0);
console.log(describe(new Point(3, 4)), describe(7), stepped, untyped(registry.make()));
console.log(JSON.stringify(counter), construct(class { constructor(public n: number) {} }, 5));
console.log(describe(caught(() => { throw new Point(9, 9); })));
`;

async function lower(directory: string, entry: string, name: string): Promise<string> {
  const path = join(directory, name);
  const result = await compile(entry, { outDir: directory, outPath: path, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(path, "utf8");
}

test("the incremental fixpoints lower the same IR as the full walk", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fixpoint-incremental-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, FIXTURE);
    const incremental = await lower(directory, entry, "incremental.ir");
    setCheckIncremental(true);
    let full: string;
    try {
      // The check mode re-runs every rewrite a worklist settled, so a wrong
      // decision fails the lowering instead of differing here.
      full = await lower(directory, entry, "full.ir");
    } finally {
      setCheckIncremental(false);
    }
    expect(full).toBe(incremental);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
