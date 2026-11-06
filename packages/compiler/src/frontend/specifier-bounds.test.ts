/* §3.2 of results/designs/island-dynamic-subgraphs/SPEC.md, as a table:
 * which forms a computed import() specifier is bounded from, and the first
 * source that stops the forms it cannot bound. The analysis runs inside the
 * frontend, so the assertion is the diagnostic a build would report — no
 * codegen, no runtime.
 *
 * The Worker-entry slice (wave2 §4.2) shares this bounder, so it is checked
 * the same way: a `new Worker(<computed entry>)` that the bounder clears
 * reports no SC2020, and one whose values name no compiled file keeps the
 * refusal. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let workerSeq = 0;

/** The SC2020 "this Worker entry point" refusals a build of `source`
 * reports; `source` is `main.ts` beside a `worker.ts` entry. */
function workerRefusals(source: string): string[] {
  const program = join(dir, `worker-${workerSeq++}`);
  mkdirSync(program, { recursive: true });
  writeFileSync(join(program, "worker.ts"), WORKER_SOURCE);
  const entry = join(program, "main.ts");
  writeFileSync(entry, source);
  return analyze(entry, { tier: "static-only" })
    .coverage.diagnostics.filter(
      (d) => d.code === "SC2020" && d.message.includes("Worker entry point"),
    )
    .map((d) => `${d.message} (${d.hint})`);
}

const WORKER_SOURCE = `import { parentPort } from "node:worker_threads";

parentPort!.postMessage(1);
`;

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
    "(a value read from `process.env`)",
  ]);
});

test("a computed Worker entry bounds through URL values and local returns", () => {
  expect(
    workerRefusals(`
import { Worker } from "node:worker_threads";

function entryName(typescript: boolean): string {
  return typescript ? "./worker.ts" : "./worker.js";
}

function start(specifier: string): Worker {
  return new Worker(new URL(specifier, import.meta.url), { workerData: 1 });
}

const flag = process.argv.length > 2;
export const worker = start(entryName(flag));
export const direct = new Worker(new URL(entryName(flag), import.meta.url));
`),
  ).toEqual([]);
});

test("a partial bound keeps the bounded arms and the Top residual", () => {
  expect(
    workerRefusals(`
import { Worker } from "node:worker_threads";

interface Options {
  workerUrl?: URL;
}

function defaultWorkerUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

export function launch(options: Options): Worker {
  return new Worker(options.workerUrl ?? defaultWorkerUrl());
}
`),
  ).toEqual([]);
});

test("a Worker entry with no bounded value keeps the refusal", () => {
  expect(
    workerRefusals(`
import { Worker } from "node:worker_threads";

export function launch(specifier: string): Worker {
  return new Worker(specifier);
}

export const fromArgv = new Worker(process.argv[2]!);

// A relative string resolves against the invocation's cwd in Node, so it
// fixes no compiled file: the site stays refused.
void launch;

export const relative = new Worker("./worker.ts");
`).length,
  ).toBe(3);
});
