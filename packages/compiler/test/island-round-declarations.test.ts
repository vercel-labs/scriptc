// A round asks its retry decision once, early: when every declaration is
// collected and every module's top-level code is lowered, before the first
// function unit (LowerOptions.stopAfterDeclarations). When that prefix
// already names islands the round ends there, and the function bodies are
// lowered once, by the round that runs with those islands, instead of once
// in each.
//
// What the prefix reports is a subset of what the whole pass reports, and
// the rules only add islands for what they are shown, so the early decision
// names nothing the whole pass would not; the round after it asks every
// rule again. These tests compile fixtures through prepareExecutableModule
// both ways and require the same build: the same islands, warnings and
// serialized IR, or the same diagnostics, with one whole lowering fewer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareExecutableModule } from "../src/executable/prepare.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { serializeModule } from "../src/ir/serialize.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writePackage(dir: string, name: string, js: string, types: string): void {
  const at = join(dir, "node_modules", name);
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(join(at, "index.js"), js);
  writeFileSync(join(at, "index.d.ts"), types);
}

/** A package whose class shape refuses natively: the refusal is reported
 * when the class is collected, before any function body lowers. */
function shaped(dir: string): void {
  writePackage(
    dir,
    "shaped",
    `"use strict";
class Later extends Promise {}
exports.Later = Later;
exports.wait = (value) => new Later((resolve) => resolve(value * 2));
`,
    `export declare class Later<T> extends Promise<T> {}
export declare function wait(value: number): Later<number>;
`,
  );
}

/** A package that compiles with a runtime fence in its top-level module
 * code: only the fence rule islands it. */
function fenced(dir: string): void {
  writePackage(
    dir,
    "surefence",
    `"use strict";
var stop = process.exit;
exports.kind = function () { return typeof stop; };
`,
    "export declare function kind(): string;\n",
  );
}

function program(source: string, packages: ((dir: string) => void)[]): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-declarations-"));
  scratch.push(dir);
  writeFileSync(join(dir, "main.ts"), source);
  for (const write of packages) write(dir);
  return dir;
}

interface Built {
  ok: boolean;
  diagnostics: unknown;
  islands: string[] | null;
  warnings: string[] | null;
  ir: string | null;
  /** The island sets the reloads ran with, in order. */
  rounds: string[][];
  /** The lowering passes, in order: each whole pass of the reachable emit,
   * and each pass that ended after its declarations. */
  passes: string[];
}

function build(dir: string, decideFromDeclarations: boolean): Built {
  const rounds: string[][] = [];
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages !== undefined) rounds.push([...options.islandPackages].sort());
    return runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
  };
  const previous = process.env["SCRIPTC_TIMING"];
  const stderr = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.env["SCRIPTC_TIMING"] = "1";
  let result: ReturnType<typeof prepareExecutableModule>;
  try {
    result = prepareExecutableModule(
      join(dir, "main.ts"),
      { outPath: join(dir, "main"), outDir: dir },
      null,
      process.platform,
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { decideFromDeclarations },
    );
  } finally {
    process.stderr.write = stderr;
    if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
    else process.env["SCRIPTC_TIMING"] = previous;
  }
  const passes = lines
    .filter((line) => line.startsWith("scriptc lowering "))
    .map((line) => (JSON.parse(line.slice("scriptc lowering ".length)) as { phase: string }).phase)
    .filter((phase) => phase === "reachable-emit" || phase === "stop-after-declarations");
  const relocated = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).split(dir).join("<dir>"));
  return {
    ok: result.ok,
    diagnostics: result.ok ? [] : relocated(result.diagnostics),
    islands: result.ok ? (result.islands?.packages ?? []) : null,
    warnings: result.ok ? result.warnings.map((w) => `${w.code} ${w.message}`) : null,
    ir: result.ok ? serializeModule(result.mod).split(dir).join("<dir>") : null,
    rounds,
    passes,
  };
}

/** Everything a build produced, without how it got there. */
function outcome(built: Built): Omit<Built, "rounds" | "passes"> {
  const { rounds: _rounds, passes: _passes, ...rest } = built;
  return rest;
}

test("a refusal found while collecting declarations ends the round before any function body", () => {
  const dir = program(
    `import { wait } from "shaped";

function double(n: number): number {
  return n * 2;
}
void wait(double(3)).then((value) => console.log("waited", value));
`,
    [shaped],
  );
  const early = build(dir, true);
  const late = build(dir, false);
  expect(early.ok).toBe(true);
  expect(early.islands).toEqual(["shaped"]);
  // The same build either way.
  expect(outcome(early)).toEqual(outcome(late));
  expect(early.rounds).toEqual(late.rounds);
  // Deciding after the whole lowering lowers the program twice; deciding
  // from the declarations lowers it once.
  expect(late.passes).toEqual(["reachable-emit", "reachable-emit"]);
  expect(early.passes).toEqual(["stop-after-declarations", "reachable-emit"]);
}, 600_000);

test("a program that fails in its own declarations takes the fenced packages with it, as the whole pass does", () => {
  const dir = program(
    `import { wait } from "shaped";
import { kind } from "surefence";

class Mine extends Promise<number> {}
const mine = new Mine((resolve) => resolve(1));
function double(n: number): number {
  return n * 2;
}
void wait(double(3)).then((value) => console.log("waited", value, kind(), mine instanceof Promise));
`,
    [shaped, fenced],
  );
  const early = build(dir, true);
  const late = build(dir, false);
  expect(early.ok).toBe(false);
  expect(outcome(early)).toEqual(outcome(late));
  // Both decide the two islands in one round: the refusal names `shaped`,
  // and the program fails either way, so `surefence`'s island is final.
  expect(late.rounds).toEqual([["shaped", "surefence"]]);
  expect(early.rounds).toEqual([["shaped", "surefence"]]);
  expect(late.passes).toEqual(["reachable-emit", "reachable-emit"]);
  expect(early.passes).toEqual(["stop-after-declarations", "reachable-emit"]);
}, 600_000);

test("a program that fails only in a function body still decides its declared islands early", () => {
  const dir = program(
    `import { wait } from "shaped";

function later(): Promise<number> {
  class Inner extends Promise<number> {}
  return new Inner((resolve) => resolve(4));
}
void wait(3).then((value) => later().then((more) => console.log("waited", value, more)));
`,
    [shaped],
  );
  const early = build(dir, true);
  const late = build(dir, false);
  expect(early.ok).toBe(false);
  expect(outcome(early)).toEqual(outcome(late));
  expect(early.rounds).toEqual(late.rounds);
  expect(early.passes).toEqual(["stop-after-declarations", "reachable-emit"]);
  expect(late.passes).toEqual(["reachable-emit", "reachable-emit"]);
}, 600_000);

test("a prefix that reports nothing decides nothing", () => {
  // Only a fence: the declarations and module-level code report no refusal,
  // so the round runs to its end and the fence rule decides as before.
  const dir = program(
    `import { kind } from "surefence";

function shout(text: string): string {
  return text.toUpperCase();
}
console.log(shout(kind()));
`,
    [fenced],
  );
  const early = build(dir, true);
  const late = build(dir, false);
  expect(early.ok).toBe(true);
  expect(early.islands).toEqual(["surefence"]);
  expect(outcome(early)).toEqual(outcome(late));
  expect(early.rounds).toEqual(late.rounds);
  expect(early.passes).toEqual(late.passes);
  expect(early.passes).not.toContain("stop-after-declarations");
}, 600_000);
