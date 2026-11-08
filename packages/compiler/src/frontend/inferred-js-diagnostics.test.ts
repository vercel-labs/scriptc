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

test.for([
  "class ComputedMethod { [new.target]() { return 1; } }",
  "class ComputedGetter { get [new.target]() { return 1; } }",
  "class ComputedSetter { set [new.target](next) { console.log(next); } }",
  "class ComputedArrow { [(() => new.target)()]() { return 1; } }",
  "class ComputedField { static [new.target] = 1; }",
])("a computed class member name keeps the early 'new.target' SyntaxError: %s", (source) => {
  expect(
    diagnostics(source, 'import "./library.js";').some((diagnostic) =>
      diagnostic.message.includes("new.target"),
    ),
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

test("a checked JavaScript file keeps a typed slot its JSDoc declared", () => {
  // TS2322 is one of the opinion table's `checkedJs: "enforce"` rows: a
  // project that asked tsc to check its JavaScript keeps the error, while
  // the same file unchecked takes the opinion (nothing at runtime checks the
  // annotation Node never reads).
  const main = 'import * as library from "./library.js"; console.log(library);';
  const library = "/** @type {string} */\nexport let box = 1;\n";
  expect(diagnostics(`// @ts-check\n${library}`, main).map((d) => d.message)).toContain(
    "Type 'number' is not assignable to type 'string'.",
  );
  expect(diagnostics(library, main)).toEqual([]);
});

test("a checked JavaScript file still takes the opinions its JSDoc never asked for", () => {
  // TS7006 has no `checkedJs: "enforce"`: checkJs asks tsc to check the
  // JSDoc a file carries, not to invent parameter annotations it does not.
  expect(
    diagnostics(
      "// @ts-check\nexport function add(a, b) { return a + b; }\n",
      'import { add } from "./library.js"; console.log(add(1, 2));',
    ),
  ).toEqual([]);
});

/* The S3/S4 checker-opinion rows (tsc-codes.ts, JS_OPINIONS). Every construct
 * below is legal JavaScript with a defined runtime meaning, so the unchecked
 * JavaScript twin compiles; a checked project keeps tsc's opinion of the same
 * source (D3), and the TypeScript twin keeps it too. A `null` expectation says
 * tsc itself raises nothing for that source in that mode, which is the honest
 * record of where the opinion is JavaScript-only. The differential twin lives
 * in tests/corpus. */
interface CheckerOpinionTwin {
  readonly name: string;
  readonly source: string;
  /** The diagnostic tsc keeps for a `// @ts-check` JavaScript file, or null. */
  readonly checkJs: string | null;
  /** The diagnostic tsc keeps for the same source in a `.ts` file, or null. */
  readonly ts: string | null;
}

const CHECKER_OPINION_TWINS: readonly CheckerOpinionTwin[] = [
  {
    name: "TS2408",
    source: `class Box {
  constructor() { this.v = 0; }
  set value(x) { this.v = x; return x * 2; }
}
console.log((new Box().value = 21));`,
    checkJs: "Setters cannot return a value",
    ts: "Setters cannot return a value",
  },
  {
    name: "TS17013",
    source: `const widget = { read() { return new.target; } };
console.log(widget.read());`,
    checkJs: "new.target",
    ts: "new.target",
  },
  {
    name: "TS2839",
    source: `console.log({} === {});`,
    checkJs: "compares objects by reference",
    ts: "compares objects by reference",
  },
  {
    name: "TS2845",
    source: `console.log(0n === Infinity);`,
    // tsc's checkJs does not compare a bigint with a number in JavaScript; the
    // .ts twin keeps the overlap error, which the row admits only in JS.
    checkJs: null,
    ts: "have no overlap",
  },
  {
    name: "TS4104",
    source: `/** @type {readonly number[]} */
const source = [1, 2, 3];
let target = [0];
target = source;
console.log(target.length);`,
    checkJs: "readonly",
    // The annotation is a comment in TypeScript, so the .ts twin is clean.
    ts: null,
  },
];

for (const { name, source, checkJs, ts } of CHECKER_OPINION_TWINS) {
  const library = 'import * as library from "./library.js"; console.log(library);';

  test(`${name}: the unchecked JavaScript twin compiles`, () => {
    expect(diagnostics(source, library)).toEqual([]);
  });

  test(`${name}: the TypeScript twin keeps tsc's opinion`, () => {
    const kept = diagnostics(source, library, "ts").map((diagnostic) => diagnostic.message);
    if (ts === null) expect(kept).toEqual([]);
    else expect(kept.some((message) => message.includes(ts))).toBe(true);
  });

  test(`${name}: a checked JavaScript twin keeps tsc's opinion`, () => {
    const kept = diagnostics(`// @ts-check\n${source}`, library).map(
      (diagnostic) => diagnostic.message,
    );
    if (checkJs === null) expect(kept).toEqual([]);
    else expect(kept.some((message) => message.includes(checkJs))).toBe(true);
  });
}

test.for(["/\\1/", "/(a)\\2/", "/\\8/", "/(a)\\12/", "/[\\1]/"])(
  "JavaScript admits a regex decimal escape without its group outside Unicode mode: %s",
  (literal) => {
    expect(diagnostics(`export const pattern = ${literal};`, 'import "./library.js";')).toEqual([]);
  },
);

test.for(["/\\1/u", "/\\1/v", "/(a)\\2/u", "/(a)\\2/v", "/[\\1]/u"])(
  "a Unicode-mode regex keeps the missing-group error: %s",
  (literal) => {
    const result = diagnostics(`export const pattern = ${literal};`, 'import "./library.js";');
    expect(result.some((d) => d.code === "SC0001" && d.message.includes("backreference"))).toBe(
      true,
    );
  },
);

test("TypeScript keeps the missing-group error of a non-Unicode regex", () => {
  const result = diagnostics("export const pattern = /\\1/;", 'import "./library.js";', "ts");
  expect(result.some((d) => d.message.includes("backreference"))).toBe(true);
});
