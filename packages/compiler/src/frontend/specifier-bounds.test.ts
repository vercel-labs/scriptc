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

/** The specifier-bounding refusals a build of `source` reports: each
 * SC1090's "<why>" with the "at <file>:<line>: " prefix removed, sorted so
 * the assertion does not pin lowering order. */
function refusals(source: string): string[] {
  const entry = join(dir, `program${seq++}.ts`);
  writeFileSync(entry, source);
  return analyze(entry, { tier: "static-only" })
    .coverage.diagnostics.filter(
      (d) => d.code === "SC1090" && d.message.startsWith("dynamic import()"),
    )
    .map((d) => {
      const feature = d.message.replace(/ (?:is|are) not supported yet$/, "");
      const why = /\(at .*?:\d+: ([\s\S]*)\)$/.exec(feature);
      expect(why, d.message).not.toBeNull();
      return `(${why![1]})`;
    })
    .sort();
}

test("every §3.2 form B1 implements bounds to a finite set", () => {
  expect(
    refusals(`
const literal = "node:path";
const template = \`node:path\`;
let neverReassigned = "node:path";
const LEFT = "node:";
const RIGHT = "path";
const name = "path";
const flag = process.argv.length > 2;
const maybe: string | undefined = undefined;
function local(specifier: string): Promise<unknown> {
  return import(specifier);
}
function withDefault(specifier = "node:path"): Promise<unknown> {
  return import(specifier);
}
async function main(): Promise<void> {
  await import("node:path");
  await import(template);
  await import(literal);
  await import(neverReassigned);
  await import(LEFT + RIGHT);
  await import(\`node:\${name}\`);
  await import(flag ? "node:path" : "node:os");
  await import(maybe ?? "node:path");
  await import("" || "node:path");
  await local("node:path");
  await local(flag ? "node:os" : "node:path");
  await withDefault();
}
void main();
export {};
`),
  ).toEqual([]);
});

test("every unbounded form names the first source that stops it", () => {
  expect(
    refusals(`
const fromArgv = process.argv[2] ?? "node:path";
let reassigned = "node:path";
reassigned = "node:os";
export const load = (specifier: string): Promise<unknown> => import(specifier);
export async function run(specifier: string): Promise<void> {
  await import(specifier);
}
function computed(): string {
  return "node:path";
}
async function main(specifier: string): Promise<void> {
  await import(fromArgv);
  await import(reassigned);
  await import(computed());
  await import(\`node:\${process.argv[2]}\`);
}
void load("node:path");
void run("node:path");
void main("node:path");
export {};
`),
  ).toEqual([
    "('reassigned', which is written after its declaration)",
    "(a parameter of the exported function 'load')",
    "(a parameter of the exported function 'run')",
    "(a value read from `process.argv`)",
    "(a value read from `process.argv`)",
    "(the result of `computed(...)`)",
  ]);
});
