import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

function diagnostics(library: string, main: string, extension = "js") {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-inferred-js-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, `library.${extension}`), library);
  writeFileSync(join(directory, "main.ts"), main);
  const load = loadProgram(join(directory, "main.ts"));
  try {
    return checkPreflight(load);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("TypeScript callers can pass arguments to inferred JavaScript functions that read arguments", () => {
  expect(
    diagnostics(
      "export const first = function () { return arguments[0]; };",
      'import { first } from "./library.js"; console.log(first("value"));',
    ),
  ).toEqual([]);
});

test.for([
  'export function first() { return "fixed"; }',
  "export function first() { return function () { return arguments[0]; }; }",
  "/** @type {() => string} */ export const first = function () { return arguments[0]; };",
])("a non-variadic JavaScript signature keeps the TypeScript arity error: %s", (library) => {
  expect(
    diagnostics(library, 'import { first } from "./library.js"; first("value");').some(
      (diagnostic) => diagnostic.message.includes("Expected 0 arguments"),
    ),
  ).toBe(true);
});

test("TypeScript signatures keep their declared arity even when they read arguments", () => {
  expect(
    diagnostics(
      "export function first() { return arguments[0]; }",
      'import { first } from "./library.js"; first("value");',
      "ts",
    ).some((diagnostic) => diagnostic.message.includes("Expected 0 arguments")),
  ).toBe(true);
});

test("a missing required parameter is not a variadic inference mismatch", () => {
  expect(
    diagnostics(
      "/** @param {string} required */ export function first(required) { return arguments[0]; }",
      'import { first } from "./library.js"; first();',
    ).some((diagnostic) => diagnostic.message.includes("Expected 1 arguments")),
  ).toBe(true);
});

test("bare JavaScript fields may read their initial undefined value", () => {
  expect(
    diagnostics(
      "export class State { data; constructor() { console.log(this.data); this.data = 1; } }",
      'import { State } from "./library.js"; new State();',
    ),
  ).toEqual([]);
});

test("annotated fields retain definite-assignment diagnostics", () => {
  expect(
    diagnostics(
      "export class State { data: number; constructor() { console.log(this.data); this.data = 1; } }",
      'import { State } from "./library.js"; new State();',
      "ts",
    ).some((diagnostic) => diagnostic.message.includes("used before being assigned")),
  ).toBe(true);
});

test.for([
  ["throw error;", false],
  ["return;", true],
  ["if (error) throw error;", true],
] as const)("iterator throw body %s retains invalid-result diagnostic: %s", ([body, invalid]) => {
  const result = diagnostics(
    `export class Values {
    next(value) { return { value, done: true }; }
    throw(error) { ${body} }
    [Symbol.iterator]() { return this; }
  }`,
    'import { Values } from "./library.js"; function* values() { yield* new Values(); }',
  );
  expect(result.some((diagnostic) => diagnostic.message.includes("'throw()' method"))).toBe(
    invalid,
  );
});

test("JavaScript async generators may delegate over a runtime async-iterator shape", () => {
  expect(
    diagnostics(
      `export async function* delegated() { yield* { [Symbol.asyncIterator]: 42 }; }
export async function* looped() { for await (const value of { [Symbol.asyncIterator]() { return "text"; } }) console.dir(value); }`,
      'import { delegated, looped } from "./library.js"; delegated(); looped();',
    ),
  ).toEqual([]);
});

test("TypeScript keeps the async-iterator demand", () => {
  expect(
    diagnostics(
      "export async function* delegated() { yield* { [Symbol.asyncIterator]: 42 }; }",
      'import { delegated } from "./library.js"; delegated();',
      "ts",
    ).some((diagnostic) => diagnostic.message.includes("Symbol.asyncIterator")),
  ).toBe(true);
});

test("a JavaScript module keeps three checker opinions to itself", () => {
  const library = `export const comma = (1, 2);
export const arithmetic = null + 1;
export function* generator() {
  const sent = yield 1;
  return sent;
}
`;
  const main =
    'import { arithmetic, comma, generator } from "./library.js"; console.log(comma, arithmetic, generator);';
  expect(diagnostics(library, main)).toEqual([]);
  expect(diagnostics(library, main, "ts").map((diagnostic) => diagnostic.message)).toEqual([
    "Left side of comma operator is unused and has no side effects.",
    "The value 'null' cannot be used here.",
    "'yield' expression implicitly results in an 'any' type because its containing generator lacks a return-type annotation.",
  ]);
});
