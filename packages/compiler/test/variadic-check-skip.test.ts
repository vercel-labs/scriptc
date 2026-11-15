import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { setCheckVariadicSkip } from "../src/frontend/lowering/variadic-functions.js";

/* The variadic check that runs when lowering ends is skipped for a program
 * that holds no variadic function (variadic-functions.ts, nothingToRefuse).
 * Its check mode walks every such program anyway and fails the lowering when
 * the walk finds something, so each fixture lowers both ways: the result must
 * be the same, and the check mode must not fail. */

/** Typed programs: nothing for the check to refuse. */
const TYPED: Record<string, string> = {
  callbacks: `class Counter {
  private total = 0;
  add(value: number): this { this.total += value; return this; }
  get value(): number { return this.total; }
}
function sum(...values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
const double = (value: number): number => value * 2;
const names = new Map<string, (value: number) => number>([["double", double]]);
const counter = new Counter();
for (const value of [1, 2, 3].map(double).filter((value) => value > 2)) counter.add(value);
setTimeout(() => console.log(counter.value, sum(1, 2, 3), names.get("double")!(4)), 0);
`,
  "typed-rest": `function join(separator: string, ...parts: string[]): string {
  return parts.join(separator);
}
const each: (part: string) => void = (...parts: string[]) => console.log(parts.length);
each("a");
console.log(join("-", "a", "b"));
`,
};

/** Programs that hold a variadic function: the check runs, and refuses
 * some of them. */
const VARIADIC: Record<string, string> = {
  "stored-and-mapped": `const one: (x: number) => number = (...args: unknown[]) => args.length;
console.log([3, 1, 2].map(one));
`,
  "stored-and-called": `const one: (x: number) => number = (...args: unknown[]) => args.length;
console.log(one(1));
`,
  "arguments-reader": `function count(): number {
  return arguments.length;
}
const counted: (...values: unknown[]) => number = count;
console.log(counted(1, 2), [1, 2].map(count));
`,
  "executor": `function settle(...settlers: unknown[]): void {
  console.log(settlers.length);
}
void new Promise<void>(settle);
`,
};

interface Lowered {
  ok: boolean;
  ir: string;
  diagnostics: string[];
}

async function lower(directory: string, entry: string, name: string): Promise<Lowered> {
  const path = join(directory, name);
  const result = await compile(entry, { outDir: directory, outPath: path, outputKind: "ir" });
  const diagnostics = result.ok ? (result.warnings ?? []) : result.diagnostics;
  return {
    ok: result.ok,
    ir: result.ok ? readFileSync(path, "utf8") : "",
    diagnostics: diagnostics.map((d) => `${d.code} ${d.loc.start}-${d.loc.end}: ${d.message}`),
  };
}

async function bothWays(source: string): Promise<{ plain: Lowered; checked: Lowered }> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-variadic-skip-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    // The suites run with the check mode on (vitest.config.ts).
    setCheckVariadicSkip(false);
    try {
      const plain = await lower(directory, entry, "plain.ir");
      setCheckVariadicSkip(true);
      return { plain, checked: await lower(directory, entry, "checked.ir") };
    } finally {
      setCheckVariadicSkip(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, source] of Object.entries(TYPED))
  test(`a typed program lowers the same with the variadic check skipped: ${name}`, async () => {
    const { plain, checked } = await bothWays(source);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.ok).toBe(true);
    expect(checked).toEqual(plain);
  });

for (const [name, source] of Object.entries(VARIADIC))
  test(`a program with a variadic function is checked as before: ${name}`, async () => {
    const { plain, checked } = await bothWays(source);
    expect(checked).toEqual(plain);
  });

test("the variadic fixtures include programs the check refuses", async () => {
  const refused: string[] = [];
  for (const [name, source] of Object.entries(VARIADIC)) {
    const { plain } = await bothWays(source);
    if (plain.diagnostics.some((line) => line.startsWith("SC1090"))) refused.push(name);
  }
  expect(refused).toContain("stored-and-mapped");
});
