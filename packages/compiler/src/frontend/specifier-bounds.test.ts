/* §3.2 of results/designs/island-dynamic-subgraphs/SPEC.md, as a table:
 * which forms a computed import() specifier is bounded from, and the first
 * source that stops the forms it cannot bound. The analysis runs inside the
 * frontend, so the assertion is the diagnostic a build would report — no
 * codegen, no runtime. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { analyze } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "scriptc-specifier-bounds-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;

/** Every SC1090 a build of `source` reports, minus the " is not supported
 * yet" suffix the message renderer appends. A bound form must report NONE of
 * them: a refusal for a different reason (a bounded value whose target does
 * not resolve) has to fail the test, not slip through a filter. */
function features(source: string): string[] {
  const entry = join(dir, `program${seq++}.ts`);
  writeFileSync(entry, source);
  return analyze(entry, { tier: "static-only" })
    .coverage.diagnostics.filter((d) => d.code === "SC1090")
    .map((d) => d.message.replace(/ (?:is|are) not supported yet$/, ""));
}

/** The "<why>" of each specifier-bounding refusal, with the "at <file>:<line>:
 * " prefix removed, sorted so the assertion does not pin lowering order. */
function unboundedWhys(source: string): string[] {
  return features(source)
    .filter((feature) => feature.startsWith("dynamic import()"))
    .map((feature) => {
      const why = /\(at .*?:\d+: ([\s\S]*)\)$/.exec(feature);
      expect(why, feature).not.toBeNull();
      return `(${why![1]})`;
    })
    .sort();
}

test("every §3.2 form B1 implements bounds to a finite set", () => {
  expect(
    features(`
const literal = "node:path";
const template = \`node:path\`;
let neverReassigned = "node:path";
const LEFT = "node:";
const RIGHT = "path";
const name = "path";
const flag = process.argv.length > 2;
const maybe = "node:path" as string | undefined;
function local(specifier: string): Promise<unknown> {
  return import(specifier);
}
function withDefault(specifier = "node:path"): Promise<unknown> {
  return import(specifier);
}
function computed(): string {
  return "node:path";
}
async function main(): Promise<void> {
  await import("node:path");
  await import(template);
  await import(literal);
  await import(neverReassigned);
  await import(LEFT + RIGHT);
  await import(\`node:\${name}\`);
  await import(flag ? "node:path" : "node:os");
  await import(maybe ?? "node:os");
  await import(maybe || "node:path");
  await local("node:path");
  await local(flag ? "node:os" : "node:path");
  await withDefault();
  await import(computed());
}
void main();
export {};
`),
  ).toEqual([]);
});

test("the whitelisted String methods fold a bounded receiver and arguments", () => {
  expect(
    features(`
const NAME = "PATH";
const spaced = " node:os ".trim();
async function main(): Promise<void> {
  await import("node:" + NAME.toLowerCase());
  await import("NODE:PATH".toUpperCase().toLowerCase());
  await import("node:PATH".replace("PATH", "path"));
  await import("node:pa_th".replaceAll("_", ""));
  await import("node_os".replace(/node_/, "node:"));
  await import(spaced);
  await import("node:os-extra".slice(0, 7));
  await import("node:os-extra".slice(0, -6));
  await import("node:".concat("os"));
  await import("node:".concat(NAME.toLowerCase()));
}
void main();
export {};
`),
  ).toEqual([]);
});

test("a String call the fold cannot evaluate names the source that stops it", () => {
  expect(
    unboundedWhys(`
const pad = process.env.SCRIPTC_PAD ?? "0";
async function main(): Promise<void> {
  await import("node:path".padEnd(9));
  await import("node:path".slice(process.argv.length));
  await import("node:path".replace(process.env.SCRIPTC_SPEC ?? "p", "x"));
  await import("node:path".concat(pad));
}
void main();
export {};
`),
  ).toEqual([
    "(a value read from `process.env`)",
    "(the result of `padEnd(...)`)",
    "(the result of `replace(...)`)",
    "(the result of `slice(...)`)",
  ]);
});

test("every unbounded form names the first source that stops it", () => {
  expect(
    unboundedWhys(`
const fromArgv = process.argv[2] ?? "node:path";
let reassigned = "node:path";
reassigned = "node:os";
export const load = (specifier: string): Promise<unknown> => import(specifier);
export async function run(specifier: string): Promise<void> {
  await import(specifier);
}
function computedUnbounded(): string {
  return process.env.SCRIPTC_SPEC!;
}
function exportedByClause(specifier: string): Promise<unknown> {
  return import(specifier);
}
export { exportedByClause };
function overwritten(specifier: string): Promise<unknown> {
  specifier = "node:os";
  return import(specifier);
}
function viaShorthand(specifier: string): Promise<unknown> {
  return import(specifier);
}
const table = { viaShorthand };
async function main(specifier: string): Promise<void> {
  await import(fromArgv);
  await import(reassigned);
  await import(computedUnbounded());
  await import(\`node:\${process.argv[2]}\`);
  await import(process.env.SCRIPTC_SPEC ?? "node:path");
  await import(process.env.SCRIPTC_SPEC || "node:path");
}
void load("node:path");
void run("node:path");
void main("node:path");
void exportedByClause("node:path");
void overwritten("node:path");
void viaShorthand("node:path");
void table.viaShorthand("node:os");
`),
  ).toEqual([
    "('reassigned', which is written after its declaration)",
    "('specifier', a parameter written in its function)",
    "(a parameter of the exported function 'exportedByClause')",
    "(a parameter of the exported function 'load')",
    "(a parameter of the exported function 'run')",
    "(a value read from `process.argv`)",
    "(a value read from `process.argv`)",
    "(a value read from `process.env`)",
    "(a value read from `process.env`)",
    "(a value read from `process.env`)",
    "(the function value 'viaShorthand', which is used other than as a direct call)",
  ]);
});

test("a concatenation's cap counts distinct values, and a spread argument is unbounded", () => {
  // 17 x 17 pairs with repeats: 273 distinct strings, over the cap. The
  // first 258 pairs hold only 243 of them, so a product cut short at a raw
  // pair count looked finite and lacked the rest.
  expect(
    unboundedWhys(`
const pick = process.argv.length * 8;
const head = pick === 0 ? "" : pick === 1 ? "a" : pick === 2 ? "aa" : pick === 3 ? "aaa" : pick === 4 ? "aaaa" : pick === 5 ? "aaaaa" : pick === 6 ? "aaaaaa" : pick === 7 ? "aaaaaaa" : pick === 8 ? "aaaaaaaa" : pick === 9 ? "aaaaaaaaa" : pick === 10 ? "aaaaaaaaaa" : pick === 11 ? "aaaaaaaaaaa" : pick === 12 ? "aaaaaaaaaaaa" : pick === 13 ? "aaaaaaaaaaaaa" : pick === 14 ? "aaaaaaaaaaaaaa" : pick === 15 ? "aaaaaaaaaaaaaaa" : "aaaaaaaaaaaaaaaa";
const tail = pick === 0 ? "" : pick === 1 ? "a" : pick === 2 ? "x0" : pick === 3 ? "x1" : pick === 4 ? "x2" : pick === 5 ? "x3" : pick === 6 ? "x4" : pick === 7 ? "x5" : pick === 8 ? "x6" : pick === 9 ? "x7" : pick === 10 ? "x8" : pick === 11 ? "x9" : pick === 12 ? "x10" : pick === 13 ? "x11" : pick === 14 ? "x12" : pick === 15 ? "x13" : "x14";
await import(head + tail);
export {};
`),
  ).toEqual(["(more than 256 possible values)"]);
  // A spread supplies any number of values: the parameter's value is not the
  // argument at its index, nor its default.
  expect(
    unboundedWhys(`
async function load(tag: string, spec: string = "node:os"): Promise<unknown> {
  return [tag, await import(spec)];
}
async function first(spec: string, tag: string): Promise<unknown> {
  return [tag, await import(spec)];
}
const pair: [string, string] = ["tag", "node:path"];
const rest: [string] = ["tag"];
void load(...pair);
void first("node:path", ...rest);
export {};
`),
  ).toEqual(["(a call of 'load' that spreads its arguments)"]);
});
