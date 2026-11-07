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
}
void main();
export {};
`),
  ).toEqual([]);
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
function computed(): string {
  return "node:path";
}
async function main(specifier: string): Promise<void> {
  await import(fromArgv);
  await import(reassigned);
  await import(computed());
  await import(\`node:\${process.argv[2]}\`);
  await import(process.env.SCRIPTC_SPEC ?? "node:path");
  await import(process.env.SCRIPTC_SPEC || "node:path");
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
    "(a value read from `process.env`)",
    "(a value read from `process.env`)",
    "(the result of `computed(...)`)",
  ]);
});
