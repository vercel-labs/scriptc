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

test("a JavaScript module keeps the setter opinion to itself", () => {
  const library = `export class Store {
  constructor() {
    this.stored = 0;
  }
  set value(next) {
    this.stored = next;
  }
  get value() {
    return this.stored;
  }
}
export const bag = {
  set only(next) {
    console.log(next);
  },
};
`;
  const main =
    'import { Store, bag } from "./library.js"; const store = new Store(); store.value = 2; bag.only = 3; console.log(store.value);';
  // A JavaScript setter's parameter is whatever the caller passes, and the
  // lowering gives it checked-dynamic storage and dynamic reads; the
  // checker's "implicitly any" opinion belongs to TypeScript input, where an
  // annotation is a promise.
  expect(diagnostics(library, main)).toEqual([]);
  expect(diagnostics(library, main, "ts").map((diagnostic) => diagnostic.message)).toContain(
    "Property 'only' implicitly has type 'any', because its set accessor lacks a parameter type annotation.",
  );
});

test.for([
  [
    "2704",
    'export const box = {};\nObject.defineProperty(box, "flag", { value: 1, configurable: true });\nexport function drop() { delete box.flag; }',
  ],
  ["2464", "export const box = {};\nexport function keyed() { return { [box]: 1 }; }"],
  ["2365", "export function joined() { return true + 1; }"],
  ["2689", "export class Derived extends AsyncIterator {}"],
  ["1166", 'export class Field { ["a" + "b"] = 1; }'],
  [
    "7032",
    "export class Hidden { set #slot(next) { console.log(next); } run(value) { this.#slot = value; } }",
  ],
] as const)("a JavaScript module keeps the TS%s opinion it cannot lower", ([, library]) => {
  // These codes stay refused: each names a program the lowerer cannot build
  // exactly (a delete of a builtin's own property, a class element's computed
  // key, an operator on operands it cannot convert, a class over a stdlib
  // base, a class field with no stable key), so the relaxation must not
  // admit them. The base is the async iterator interface: `extends Iterator`
  // is a program the lowering builds, so it no longer carries an opinion to
  // keep. The invalid assignment-target pair (2364 `f() += g()`,
  // 2357 `f()++`) stays refused the same way: Node calls `f`, then throws.
  expect(
    diagnostics(library, 'import * as library from "./library.js"; console.log(library);').length,
  ).toBeGreaterThan(0);
});
