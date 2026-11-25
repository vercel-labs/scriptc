import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The names of every function a call node calls, and every method a
 * checked-dynamic invocation names, anywhere in `value`. */
function calledNames(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) calledNames(item, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  const node = value as { kind?: unknown; callee?: unknown; method?: unknown };
  if (node.kind === "call" && typeof node.callee === "string") found.push(node.callee);
  if (node.kind === "dynInvoke" && typeof node.method === "string")
    found.push(`dyn:${node.method}`);
  for (const child of Object.values(value)) calledNames(child, found);
  return found;
}

const PRELUDE = `
  interface Crate { id: number; label: string }
  const sides: [string, string, string] = ["left", "top", "right"];
  const fixed: readonly [number, number, number] = [4, 5, 6];
  const rows: [Crate[], Crate[]] = [[], [{ id: 1, label: "bolts" }]];
  const words: (string | string[])[] = ["oak", ["elm", "ash"]];
  const levels: (number | number[] | number[][])[] = [1, [2], [[3]]];
  function pick(n: number): Crate[] | string[] {
    return n > 0 ? ["loose"] : [{ id: 2, label: "nuts" }];
  }
  const either = pick(process.argv.length);
  const held: any[] = JSON.parse("[1,2,3]");
  const depth: number = process.argv.length;
`;

async function compileSource(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-array-receivers-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, `${PRELUDE}\nexport function run(): void {\n${body}\n}\nrun();\n`);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics };
    return { ok: true as const, module: deserializeModule(await readFile(outPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The helper families a body's calls reach (`%tuple.reduce.3a91bbab737b`
 * is `%tuple.reduce`) and the methods it invokes on checked-dynamic
 * values (`dyn:reduce`). */
async function familiesOf(body: string): Promise<Set<string>> {
  const result = await compileSource(body);
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return new Set(
    calledNames(result.module.functions).map((name) => name.replace(/\.[0-9a-f]{6,}$/, "")),
  );
}

async function refusalOf(body: string): Promise<string> {
  const result = await compileSource(body);
  if (result.ok) throw new Error("expected a refusal");
  const first = result.diagnostics[0]!;
  return `${first.code}: ${first.message}`;
}

test("a tuple's reduce, reduceRight and forEach read its positions in a helper of their own", async () => {
  const families = await familiesOf(`
    console.log(fixed.reduce((a, b) => a + b, 0), sides.reduceRight((a, b) => a + b));
    sides.forEach((side, index) => console.log(index, side));
  `);
  expect([...families].filter((name) => name.startsWith("%tuple.")).sort()).toEqual([
    "%tuple.forEach",
    "%tuple.reduce",
    "%tuple.reduceRight",
  ]);
  // No copy of the tuple goes through the array helpers.
  expect([...families].filter((name) => name.startsWith("%arr."))).toEqual([]);
});

test("flat over value-or-array elements decides each element by its arm", async () => {
  const mixed = await familiesOf(`console.log(words.flat().length, words.flat(2).length);`);
  expect(mixed.has("%arr.flatValueOrArray")).toBe(true);
  // A tuple of arrays is one level of plain nesting: the array intrinsic.
  const nested = await familiesOf(`console.log(rows.flat().length);`);
  expect(nested.has("%arr.flatValueOrArray")).toBe(false);
});

test("a union of array types runs some, every and findIndex on the arm it holds", async () => {
  const families = await familiesOf(`
    console.log(
      either.some((x) => typeof x === "string"),
      either.every((x) => typeof x === "object"),
      either.findIndex((x) => typeof x === "string"),
    );
  `);
  for (const family of ["%arr.union", "%arr.some", "%arr.every", "%arr.findIndex"])
    expect(families.has(family), family).toBe(true);
});

test("an array held as a checked-dynamic value dispatches its reductions at run time", async () => {
  const families = await familiesOf(`
    console.log(
      held.reduce((a: number, b: number) => a + b, 0),
      held.reduceRight((a: number, b: number) => a + b),
      held.flat(),
      held.flatMap((n: number) => [n]),
      held.findLast((n: number) => n > 1),
      held.findLastIndex((n: number) => n > 1),
    );
  `);
  // (flatMap on such an array has its own lowering, which was there before.)
  for (const method of ["findLast", "findLastIndex", "flat", "reduce", "reduceRight"])
    expect(families.has(`dyn:${method}`), method).toBe(true);
});

test("the forms without an exact reading stay refused by name", async () => {
  expect(
    await refusalOf(`console.log(sides.reduce((acc, s, i, all) => acc + all.length, 0));`),
  ).toMatch(/^SC2020: 'tuple \.reduce callback array parameter'/);
  expect(await refusalOf(`console.log(rows.flat(depth).length);`)).toMatch(
    /^SC2020: 'tuple \.flat with a depth that is not a number literal'/,
  );
  expect(await refusalOf(`console.log(levels.flat().length);`)).toMatch(
    /^SC2020: '\.flat over elements with runtime-dependent array shape'/,
  );
  expect(await refusalOf(`console.log(words.flat(depth).length);`)).toMatch(/^SC2020: '\.flat /);
});
