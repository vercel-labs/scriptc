/* A call chain whose innermost link cannot be lowered is refused once, not
 * once per way of reading each receiver. Lowering a call probes its receiver
 * (tryLowerExpression) and a later form lowers the receiver again, which
 * doubled the work at every link; a refused probe is now remembered while
 * the expression that asked is being lowered (Lowerer.refusedProbes). What
 * still multiplies (links that do lower) is bounded by an attempt budget
 * that ends in a named fence. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { analyze } from "../src/index.js";
import { setLowerExprAttemptsFloor } from "../src/frontend/lowering/lower-exprs.js";

let directory: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-lowering-attempts-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** `links` calls through a record member, each on the result of the last,
 * on a root imported by name from a JSON module (a refused import). */
function refusedChain(links: number): string {
  let chain = "(start as unknown as Builder)";
  for (let i = 0; i < links; i++) chain += `\n  .step(${i})`;
  return `import { start } from "./data.json";
interface Builder { step(n: number): Builder; done(): number }
const result = ${chain}
  .done();
console.log(result);
`;
}

/** `links` array methods, each taking an arrow function. */
function arrayChain(links: number): string {
  let chain = "[1, 2, 3]";
  for (let i = 0; i < links; i++)
    chain += i % 2 === 0 ? `\n  .map((n) => n + ${i})` : `\n  .filter((n) => n !== ${i})`;
  return `const result = ${chain}\n  .length;\nconsole.log(result);\n`;
}

/** An array literal nested `levels` deep. */
function nestedLiteral(levels: number): string {
  let literal = "[1]";
  for (let i = 0; i < levels; i++) literal = `[${literal}]`;
  return `const result = ${literal};\nconsole.log(result.length);\n`;
}

function codes(name: string, source: string): string[] {
  const dir = join(directory, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "data.json"), '{ "start": 1 }\n');
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  const { coverage } = analyze(entry, {});
  return coverage.diagnostics.map((d) => `${d.code}: ${d.message}`);
}

test("a 40-link chain on a refused import is refused inside a budget doubling exhausts at 16 links", () => {
  // Doubling per link needs 2^40 lowerings; one refusal per link needs a
  // few thousand. The budget turns a regression into a named failure here
  // instead of a test that never ends.
  const previous = setLowerExprAttemptsFloor(50_000);
  try {
    const found = codes("refused-chain", refusedChain(40));
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((d) => d.includes("lowering attempts"))).toBe(false);
  } finally {
    setLowerExprAttemptsFloor(previous);
  }
}, 60_000);

test("a statement past its attempt budget is refused by name", () => {
  // An array literal lowers each element twice (once to find the element
  // type, once for it), so one nested 18 deep takes half a million
  // lowerings. The statement has 22 nodes, so its budget is the per-node
  // one (2,000 each) once the floor is out of the way.
  const previous = setLowerExprAttemptsFloor(20_000);
  try {
    const found = codes("nested-literal", nestedLiteral(18));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain("SC1090");
    expect(found[0]).toMatch(/statements that take more than \d+ lowering attempts/);
  } finally {
    setLowerExprAttemptsFloor(previous);
  }
}, 60_000);

test("the same statement inside its budget compiles", () => {
  expect(codes("nested-literal-short", nestedLiteral(4))).toEqual([]);
}, 60_000);

test("an array chain that used to pass the budget compiles", () => {
  // Three lowerings per link was 3^14 for this chain; its receivers are
  // lowered once now (Lowerer.dispatchedReceiver).
  const previous = setLowerExprAttemptsFloor(20_000);
  try {
    expect(codes("array-chain", arrayChain(14))).toEqual([]);
  } finally {
    setLowerExprAttemptsFloor(previous);
  }
}, 60_000);
