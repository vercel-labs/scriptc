import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { InternalCompilerError } from "../src/errors.js";
import { Lowerer, lowerToIr, type LowerResult } from "../src/frontend/lowering/lowerer.js";
import { loadProgram } from "../src/frontend/program-node.js";
import * as ts from "../src/frontend/ts7/adapter.js";

// A compiler crash (a broken invariant, a panic inside the checker) is the
// compiler's own failure, and its diagnostic has to name the source the
// compiler was working on. These tests inject both kinds at a chosen
// expression and pin where the diagnostic lands.

const TWO_STATEMENTS = `function area(width: number, height: number): number {
  return width * height + 1;
}
function ratio(width: number, height: number): number {
  const scaled = width / height;
  return scaled;
}
console.log(area(2, 3), ratio(6, 3));
`;

// The panicking operand sits in a function nothing calls.
const UNREACHED = `const names: string[] = ["a"];
const fallback = "none";
function unreached(index: number): string {
  return names[index] ?? fallback;
}
console.log(names.length);
`;

// The same function, called.
const REACHED = `${UNREACHED}console.log(unreached(3));
`;

let directory: string;
const loads: ReturnType<typeof loadProgram>[] = [];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-crash-site-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const load of loads) load.dispose();
  rmSync(directory, { recursive: true, force: true });
});

function load(name: string, source: string): ReturnType<typeof loadProgram> {
  const file = join(directory, name);
  writeFileSync(file, source);
  const loaded = loadProgram(file);
  loads.push(loaded);
  return loaded;
}

function lower(loaded: ReturnType<typeof loadProgram>): LowerResult {
  return lowerToIr(loaded.program, loaded.entry, loaded.moduleOrder, {
    frontendServices: loaded.services,
  });
}

/** The diagnostics of one code as "line:column message", sorted and without repeats. */
function sites(result: LowerResult, code: string, source: string): string[] {
  const rows = result.diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => {
      const before = source.slice(0, diagnostic.loc.start);
      const line = before.split("\n").length;
      const column = before.length - before.lastIndexOf("\n");
      return `${line}:${column} ${source.slice(diagnostic.loc.start, diagnostic.loc.end)}`;
    });
  return [...new Set(rows)].sort();
}

test("an internal compiler error is reported at the innermost expression, and the build goes on", () => {
  const loaded = load("two-statements.ts", TWO_STATEMENTS);
  const lowerBinary = Lowerer.prototype.lowerBinary;
  vi.spyOn(Lowerer.prototype, "lowerBinary").mockImplementation(function (this: Lowerer, expr) {
    const text = ts.getTextOfNode(expr);
    if (text === "width * height" || text === "width / height")
      throw new InternalCompilerError(`test: broken invariant at ${text}`);
    return lowerBinary.call(this, expr);
  });
  const result = lower(loaded);
  expect(result.module).toBeNull();
  // Both statements report: the first crash did not end the lowering.
  expect(sites(result, "SC9001", TWO_STATEMENTS)).toEqual([
    "2:10 width * height",
    "5:18 width / height",
  ]);
  const messages = result.diagnostics
    .filter((diagnostic) => diagnostic.code === "SC9001")
    .map((diagnostic) => diagnostic.message);
  expect(messages).toContain(
    "internal compiler error: test: broken invariant at width * height — please report this",
  );
});

test("a checker panic in code nothing reaches does not end the build", () => {
  const loaded = load("unreached.ts", UNREACHED);
  const checker = loaded.program.getTypeChecker();
  const getTypeAtLocation = checker.getTypeAtLocation.bind(checker);
  let panics = 0;
  vi.spyOn(checker, "getTypeAtLocation").mockImplementation((node) => {
    if (isFallbackOperand(node)) {
      panics++;
      throw new Error("panic: test: no type for this node");
    }
    return getTypeAtLocation(node);
  });
  const result = lower(loaded);
  expect(result.diagnostics).toEqual([]);
  expect(result.module).not.toBeNull();
  // The whole-program analyses did ask about the node.
  expect(panics).toBeGreaterThan(0);
});

test("the same panic in code that runs is reported at the expression that asked", () => {
  const loaded = load("reached.ts", REACHED);
  const checker = loaded.program.getTypeChecker();
  const getTypeAtLocation = checker.getTypeAtLocation.bind(checker);
  vi.spyOn(checker, "getTypeAtLocation").mockImplementation((node) => {
    if (isFallbackOperand(node)) throw new Error("panic: test: no type for this node");
    return getTypeAtLocation(node);
  });
  const result = lower(loaded);
  expect(result.module).toBeNull();
  const reported = sites(result, "SC0004", REACHED);
  expect(reported.length).toBeGreaterThan(0);
  // Every report is inside the statement that reads the operand, never at
  // the top of the entry file.
  for (const site of reported) expect(site.startsWith("4:")).toBe(true);
});

/** The right operand of the `??` in the fixtures. */
function isFallbackOperand(node: ts.Node): boolean {
  return (
    ts.isIdentifier(node) &&
    node.text === "fallback" &&
    node.parent !== undefined &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.right === node
  );
}
