import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";

// The Node-hosted compiler evaluates `comptime` callbacks in the evaluator
// process, as the native compiler does. Each of these programs reached the
// compiler's own process, ran outside the budget, or ended the compiler when
// callbacks ran in node:vm.
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-comptime-isolation-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let programs = 0;
async function build(source: string): Promise<{ ir: string; diagnostics: string[] }> {
  const entry = join(dir, `program${programs++}.ts`);
  const outPath = entry + ".ir.json";
  await writeFile(entry, source);
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  return result.ok
    ? { ir: await readFile(outPath, "utf8"), diagnostics: [] }
    : { ir: "", diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`) };
}

const PROBE = "return typeof process === 'object' ? 'reached the host process' : 'no host'";

test("constructor chains end at the evaluator's own Function", async () => {
  for (const callback of [
    `() => { const g: any = globalThis; return String(g.constructor.constructor(${JSON.stringify(PROBE)})()); }`,
    `() => { const F = (() => 1).constructor; const g: any = F("return this")(); return String(g.constructor.constructor(${JSON.stringify(PROBE)})()); }`,
  ]) {
    const { ir, diagnostics } = await build(`const v = comptime(${callback});\nconsole.log(v);\n`);
    expect(diagnostics).toEqual([]);
    expect(ir).toContain("no host");
    expect(ir).not.toContain("reached the host process");
  }
});

test("the compiler never calls or reads a result's own members", async () => {
  const { ir, diagnostics } = await build(`const v = comptime(() => {
  const values: string[] = ["untouched"];
  (values as any).map = function (callback: any) {
    return [callback(String(callback.constructor(${JSON.stringify(PROBE)})()), 0)];
  };
  return values;
});
console.log(v[0]);
`);
  expect(diagnostics).toEqual([]);
  expect(ir).toContain("untouched");
  expect(ir).not.toContain("reached the host process");
});

test("accessors on results and thrown values run inside the budget", async () => {
  const started = Date.now();
  for (const callback of [
    `() => { const o = {} as { n: number }; Object.defineProperty(o, "n", { enumerable: true, get: () => { for (;;) {} } }); return o; }`,
    `(): number => { throw { get message(): string { for (;;) {} } }; }`,
  ]) {
    const { diagnostics } = await build(`const v = comptime(${callback});\nconsole.log(v);\n`);
    expect(diagnostics).toEqual([
      "SC1110: comptime evaluation failed: evaluation exceeded the 2000ms compile-time budget",
    ]);
  }
  expect(Date.now() - started).toBeLessThan(30_000);
});

test("work left for later is a diagnostic, not code that runs in the compiler", async () => {
  for (const [callback, detail] of [
    [
      `() => { Promise.resolve().then(() => { for (;;) {} }); return 1; }`,
      "the callback left promise reactions pending, and they never run at compile time",
    ],
    [
      `() => { Promise.reject(new Error("unhandled")); return 1; }`,
      "the callback left a rejected promise unhandled",
    ],
    [
      `() => { import("node:fs"); return 1; }`,
      "the callback left promise reactions pending, and they never run at compile time",
    ],
  ] as const) {
    const { diagnostics } = await build(`const v = comptime(${callback});\nconsole.log(v);\n`);
    expect(diagnostics).toEqual([`SC1110: comptime evaluation failed: ${detail}`]);
  }
});

test("limits and odd results are diagnostics", async () => {
  for (const [callback, detail] of [
    [
      `(): number => { const all: number[][] = []; for (;;) all.push(new Array<number>(1 << 16).fill(1)); }`,
      "evaluation exceeded the 256 MB compile-time memory limit",
    ],
    [`() => [1, , 3] as number[]`, "expected 'number' at $[1], got undefined"],
    [
      `() => new Array<number>(1000001).fill(3)`,
      "the result has an array of more than 1000000 elements",
    ],
    [`(): number => { throw null; }`, "the callback threw: null"],
  ] as const) {
    const { diagnostics } = await build(`const v = comptime(${callback});\nconsole.log(v);\n`);
    expect(diagnostics).toEqual([`SC1110: comptime evaluation failed: ${detail}`]);
  }
});

test("a file's callbacks evaluate independently of each other", async () => {
  const { ir, diagnostics } =
    await build(`const a = comptime(() => { (globalThis as any).shared = "first"; return "a-" + typeof (globalThis as any).shared; });
const b = comptime(() => "b-" + typeof (globalThis as any).shared);
const c = comptime((): number[] => [1, 2, 3].map((n) => n * n));
console.log(a, b, c.join());
`);
  expect(diagnostics).toEqual([]);
  expect(ir).toContain("a-string");
  expect(ir).toContain("b-undefined");
});
