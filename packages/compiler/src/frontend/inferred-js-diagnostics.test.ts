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
    name: "TS2810",
    source: `new Promise((resolve) => resolve()).then((value) => console.log(value));`,
    checkJs: "Expected 1 argument, but got 0",
    ts: "Expected 1 arguments, but got 0",
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

const DISCARDED_VOID_NEGATION = `function register() {
  console.log("registered");
}
!register();`;

test("JavaScript drops the diagnostic of a discarded negation of a void call", () => {
  expect(
    diagnostics(
      DISCARDED_VOID_NEGATION,
      'import * as library from "./library.js"; console.log(library);',
    ),
  ).toEqual([]);
});

test.for(["!!register();", "!!!register();", "!(!((register())));", "((!!(register())));"])(
  "JavaScript drops the diagnostic of a discarded void-negation chain: %s",
  (statement) => {
    expect(
      diagnostics(
        `function register() { console.log("registered"); }\n${statement}`,
        'import * as library from "./library.js"; console.log(library);',
      ),
    ).toEqual([]);
  },
);

test.for(["!!callback();", "!!!callback();", "!(!((callback())));", "((!!(callback())));"])(
  "JavaScript drops the diagnostic of a discarded void-callback chain: %s",
  (statement) => {
    expect(
      diagnostics(
        `/** @param {() => void} callback */\nfunction invoke(callback) { ${statement} }\ninvoke(() => console.log("registered"));`,
        'import * as library from "./library.js"; console.log(library);',
      ),
    ).toEqual([]);
  },
);

test.for([
  "export const ok = !!register();",
  "export const ok = !!!register();",
  'if (!!register()) console.log("used");',
  '!!register() && console.log("used");',
])("a consumed known-undefined void-negation chain remains admitted: %s", (statement) => {
  expect(
    diagnostics(
      `function register() { console.log("registered"); }\n${statement}`,
      'import * as library from "./library.js"; console.log(library);',
    ),
  ).toEqual([]);
});

test.for([
  "return !!callback();",
  "return !!!callback();",
  'if (!!callback()) console.log("used");',
  '!!callback() && console.log("used");',
])("a consumed unproven void-callback chain keeps the named refusal: %s", (statement) => {
  const kept = diagnostics(
    `/** @param {() => void} callback */\nfunction invoke(callback) { ${statement} }\ninvoke(() => console.log("registered"));`,
    'import * as library from "./library.js"; console.log(library);',
  );
  expect(kept.some((d) => d.code === "SC1090" && d.message.includes("truthiness"))).toBe(true);
});

test.for(["!!register();", "!!!register();"])(
  "checked JavaScript and TypeScript keep a discarded void-negation chain diagnostic: %s",
  (statement) => {
    const source = `function register() { console.log("registered"); }\n${statement}`;
    const main = 'import * as library from "./library.js"; console.log(library);';
    expect(
      diagnostics(`// @ts-check\n${source}`, main).some((d) => d.message.includes("truthiness")),
    ).toBe(true);
    expect(
      diagnostics(source, main, "ts").some((d) =>
        d.message.includes("cannot be tested for truthiness"),
      ),
    ).toBe(true);
  },
);

test("a checked JavaScript file keeps the void-negation diagnostic", () => {
  // TS1345 is a `checkedJs: "enforce"` row: a project that asked tsc to check
  // its JavaScript keeps the refusal (named here by the code's triage row).
  const kept = diagnostics(
    `// @ts-check\n${DISCARDED_VOID_NEGATION}`,
    'import * as library from "./library.js"; console.log(library);',
  );
  expect(kept.some((d) => d.message.includes("truthiness"))).toBe(true);
});

test("TypeScript keeps the diagnostic of a discarded negation of a void call", () => {
  const kept = diagnostics(
    DISCARDED_VOID_NEGATION,
    'import * as library from "./library.js"; console.log(library);',
    "ts",
  ).map((d) => d.message);
  expect(kept.some((message) => message.includes("cannot be tested for truthiness"))).toBe(true);
});

test("JavaScript drops the diagnostic of a consumed negation of a void call", () => {
  // The operand evaluates once for its effects and Node's ToBoolean of the
  // value it yields is false, which the ordinary lowering answers.
  expect(
    diagnostics(
      'function register() { console.log("registered"); }\nexport const ok = !register();',
      'import { ok } from "./library.js"; console.log(ok);',
    ),
  ).toEqual([]);
});

test.for([
  // An annotation types the callback `void`, and its body answers 1.
  "/** @type {() => void} */\nconst cb = () => 1;\nexport const ok = cb() ? 'truthy' : 'falsy';",
  "/** @type {() => void} */\nconst cb = () => 1;\nexport const ok = !cb();",
  // A parameter typed `() => void` receives whatever function the caller passes.
  "/** @param {() => void} f */\nfunction run(f) { return f() ? 'yes' : 'no'; }\nexport const ok = run(() => 'x');",
  // A binding a write can replace holds the replacement.
  "let g = function () {};\ng = () => 's';\nexport const ok = g() ? 'yes' : 'no';",
  // A reassignable alias holds whatever was stored last, even when it first
  // held a function that answers undefined.
  "function noop() {}\nlet cb = noop;\ncb = () => 1;\nexport const ok = cb() ? 'yes' : 'no';",
  "const noop = () => {};\nlet cb = noop;\ncb = () => 1;\nexport const ok = cb() ? 'yes' : 'no';",
  "class A { m() {} }\nlet f = new A().m;\nf = () => 1;\nexport const ok = f() ? 'yes' : 'no';",
  // A write, by name, by string key or by reflection, can replace a class
  // method on an instance or on the prototype.
  "class A { m() {} }\nconst a = new A();\na.m = () => 1;\nexport const ok = a.m() ? 'yes' : 'no';",
  "class A { m() {} }\nA.prototype.m = () => 1;\nexport const ok = new A().m() ? 'yes' : 'no';",
  "class A { m() {} }\nconst a = new A();\na['m'] = () => 1;\nexport const ok = !a.m();",
  "class A { m() {} }\nconst a = new A();\nObject.defineProperty(a, 'm', { value: () => 1 });\nexport const ok = a.m() ? 'yes' : 'no';",
  "class A { m() {} }\nObject.assign(A.prototype, { m() { return 1; } });\nexport const ok = new A().m() ? 'yes' : 'no';",
  // A body that returns a value: the checker's `void` comes from the
  // documented result, not from the body.
  "/** @returns {void} */\nfunction lie() { return 5; }\nexport const ok = lie() ? 'yes' : 'no';",
])("a void-typed operand that can hold a value keeps the truthiness refusal: %s", (library) => {
  const result = diagnostics(library, 'import { ok } from "./library.js"; console.log(ok);');
  expect(result.some((d) => d.code === "SC1090" && d.message.includes("truthiness"))).toBe(true);
});

test.for([
  // A member of a plain object the program builds: the object takes
  // checked-dynamic storage, the function the program stored keeps its own
  // return, and the call reads that value as Node does.
  "const o = { m() {} };\no.m = () => 2;\nexport const ok = !o.m();",
  "function noop() {}\nconst o = { cb: noop };\no.cb = () => 1;\nexport const ok = !o.cb();",
  "function noop() {}\nconst o = { d: { f: noop } };\no.d.f = () => 3;\nexport const ok = o.d.f() ? 'yes' : 'no';",
])("a void-typed call through a plain object's member reads the value: %s", (library) => {
  expect(diagnostics(library, 'import { ok } from "./library.js"; console.log(ok);')).toEqual([]);
});

test("JavaScript drops the diagnostic where the void-typed operand is undefined", () => {
  // Each operand is a call of a function whose body returns no value, or a
  // const holding one: Node's ToBoolean of it is false.
  expect(
    diagnostics(
      [
        "function plain() {}",
        "const arrow = () => { plain(); };",
        "class Router { find() {} route(e) { const r = this.find(e); return r ? r : null; } }",
        "const held = plain();",
        "export const ok = [plain() ? 1 : 2, !arrow(), new Router().route({}), held ? 3 : 4];",
      ].join("\n"),
      'import { ok } from "./library.js"; console.log(ok);',
    ),
  ).toEqual([]);
});

test("a checked JavaScript file keeps the consumed void-negation diagnostic", () => {
  // Named here by the code's triage row, as for the discarded negation.
  const kept = diagnostics(
    '// @ts-check\nfunction register() { console.log("registered"); }\nexport const ok = !register();',
    'import { ok } from "./library.js"; console.log(ok);',
  );
  expect(kept.some((d) => d.message.includes("truthiness"))).toBe(true);
});

/* The triage rows' descriptions (tsc-codes.ts, TRIAGE_ROWS) must state what
 * Node does with the construct being refused, so the user can tell an invalid
 * dependency from a missing lowering. These tests read the diagnostics a real
 * preflight produces, not the table's source text. */
function refusal(source: string, extension = "js") {
  const kept = diagnostics(
    source,
    'import * as library from "./library.js"; console.log(library);',
    extension,
  );
  expect(kept).toHaveLength(1);
  const [diagnostic] = kept;
  expect(diagnostic!.code).toBe("SC1090");
  return diagnostic!;
}

test("a class declaration assignment names the mutable outer binding", () => {
  const kept = refusal("class Value {}\nValue = class Replacement {};\nexport { Value };");
  expect(kept.message).toContain("assigning to a class binding");
  expect(kept.hint).toContain("outer binding is mutable");
  expect(kept.hint).toContain("named class expression's inner binding");
  expect(kept.hint).not.toContain("read-only");
});

test("a class declaration's inner assignment names its immutable binding", () => {
  const kept = refusal("export class Value { static reset() { Value = null; } }");
  expect(kept.message).toContain("assigning to a class binding");
  expect(kept.hint).toContain("a class declaration's inner binding");
  expect(kept.hint).toContain("are immutable");
});

test.for([
  "export class Value { [Value = null]() {} }",
  "export const Outer = class Inner { [Inner = null]() {} };",
])("an uninitialized class inner assignment names its ReferenceError: %s", (source) => {
  const kept = diagnostics(
    source,
    'import * as library from "./library.js"; console.log(library);',
  ).find(
    (diagnostic) =>
      diagnostic.code === "SC1090" && diagnostic.message.includes("assigning to a class binding"),
  );
  expect(kept?.code).toBe("SC1090");
  expect(kept?.hint).toContain("once initialized");
  expect(kept?.hint).toContain("ReferenceError before initialization");
});

test("a named class expression's inner binding names the immutable inner binding", () => {
  const kept = refusal(
    "const Outer = class Inner { static reset() { Inner = null; } };\nexport { Outer };",
  );
  expect(kept.message).toContain("assigning to a class binding");
  expect(kept.hint).toContain("named class expression's inner binding");
});

test("a function declaration assignment compiles: the binding is mutable", () => {
  // Node's function declaration is a mutable binding, and the declaration
  // lowers to a checked-dynamic binding the write replaces
  // (rebindable-functions.ts).
  expect(
    diagnostics(
      "function value() { return 1; }\nvalue = () => 2;\nexport { value };",
      'import * as library from "./library.js"; console.log(library);',
    ),
  ).toEqual([]);
});

test("a named function expression's inner binding names the immutable binding", () => {
  const kept = refusal(
    "const outer = function inner() { inner = () => 1; return inner(); };\nexport { outer };",
  );
  expect(kept.message).toContain("assigning to a function binding");
  expect(kept.hint).toContain("named function expression's inner binding");
});

test("a value missing declared properties is not described as a Set argument", () => {
  // TS2739 is an ordinary structural error: the annotation requires three
  // properties and the value supplies one. Nothing here is set-like.
  const kept = refusal(
    '// @ts-check\n/** @type {{ first: string, second: string, third: string }} */\nexport const value = { first: "one" };',
  );
  expect(kept.message).toContain("a value lacking a required property of its declared type");
  expect(kept.hint).toContain("Node checks no declared type");
  expect(`${kept.message} ${kept.hint}`).not.toContain("set-like");
  expect(`${kept.message} ${kept.hint}`).not.toContain("'has'");
});

/* for-in's head is retyped by shipped JavaScript: the key string lands in a
 * binding declared to hold something else, and the right side is walked
 * whatever the checker inferred there. tsc reports TS2405/TS2407 only for a
 * checked JavaScript file (and for TypeScript input); Node assigns the key
 * and enumerates the value. */
const RETYPED_FOR_IN = `const table = { a: 1, b: 2 };
var key = 3;
for (key in table) console.log(typeof key, key);
function create(type, config) {
  var count = arguments.length - 2;
  for (var name in ((count = type.defaultProps), count)) console.log(name, count[name]);
}
export { create };`;

test("an unchecked JavaScript for-in writes the key into a retyped binding", () => {
  expect(
    diagnostics(
      RETYPED_FOR_IN,
      'import { create } from "./library.js"; create(function C() {}, {});',
    ),
  ).toEqual([]);
});

test("a checked JavaScript for-in keeps tsc's head diagnostics", () => {
  const kept = diagnostics(
    `// @ts-check\n${RETYPED_FOR_IN}`,
    'import { create } from "./library.js"; create(function C() {}, {});',
  ).map((diagnostic) => diagnostic.message);
  expect(kept.some((message) => message.includes("left-hand side of a 'for...in'"))).toBe(true);
  expect(kept.some((message) => message.includes("right-hand side of a 'for...in'"))).toBe(true);
});

test("an unchecked JavaScript for-in key keeps the string an array read leaves it to hold", () => {
  // The read may leave the binding undefined, so its collected storage is
  // `number | undefined`; the loop still writes the key string into it.
  const library = `/** @param {number[]} list */
export function first(list) {
  var key = list[0];
  for (key in { a: 1 }) console.log(typeof key, key);
  var out = key;
  return out;
}`;
  expect(
    diagnostics(library, 'import { first } from "./library.js"; console.log(first([]));'),
  ).toEqual([]);
});

test("an unchecked JavaScript JSDoc parameter holds a for-in key string", () => {
  // The annotation types the parameter `number`; the loop writes the key
  // string into it and the function answers it, as Node does.
  const library = `/** @param {number} key */
export function walk(key) {
  for (key in { a: 1 }) console.log(typeof key, key);
  var out = key;
  return out;
}`;
  expect(
    diagnostics(library, 'import { walk } from "./library.js"; console.log(walk(1));'),
  ).toEqual([]);
});

test("a checked JavaScript JSDoc parameter keeps tsc's head diagnostic", () => {
  const library = `// @ts-check
/** @param {number} key */
export function walk(key) {
  for (key in { a: 1 }) console.log(typeof key, key);
  return key;
}`;
  const kept = diagnostics(library, 'import { walk } from "./library.js"; console.log(walk(1));');
  expect(
    kept.some((diagnostic) => diagnostic.message.includes("left-hand side of a 'for...in'")),
  ).toBe(true);
});

test("TypeScript keeps the for-in head diagnostics of the same source", () => {
  const kept = diagnostics(
    RETYPED_FOR_IN,
    'import { create } from "./library.js"; create(function C() {}, {});',
    "ts",
  ).map((diagnostic) => diagnostic.message);
  expect(kept.some((message) => message.includes("left-hand side of a 'for...in'"))).toBe(true);
  expect(kept.some((message) => message.includes("right-hand side of a 'for...in'"))).toBe(true);
});

/* A record-typed binding reassigned to Object.freeze's result of another
 * shape: TypeScript reports the missing properties (TS2739), while the
 * unchecked JavaScript file stores the frozen object the program wrote. */
const FROZEN_REASSIGNMENT = `var apis = { isMounted: ["isMounted"], replaceState: ["replaceState"] };
apis = Object.freeze({ __proto__: null, c: function (size) { return size + 1; } });
export const read = apis.c(2);`;

test("an unchecked JavaScript binding holds a frozen value outside its record type", () => {
  expect(
    diagnostics(FROZEN_REASSIGNMENT, 'import { read } from "./library.js"; console.log(read);'),
  ).toEqual([]);
});

test("a checked JavaScript binding keeps the missing-property diagnostic", () => {
  const kept = diagnostics(
    `// @ts-check\n${FROZEN_REASSIGNMENT}`,
    'import { read } from "./library.js"; console.log(read);',
  );
  expect(kept.some((diagnostic) => diagnostic.code === "SC1090")).toBe(true);
});

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

test("a JavaScript descriptor's get and set are callable with an explicit receiver", () => {
  // `base.get`/`base.set` are possibly undefined functions to the checker, so
  // `.call` rejects the this type (TS2684); JavaScript still binds whatever
  // receiver the call names, and the descriptor's functions run on it.
  expect(
    diagnostics(
      `export class Field {
        #value = "";
        get value() { return this.#value; }
        set value(next) { this.#value = next; }
      }
      export function wrap(el) {
        const base = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        return {
          read() { return base.get.call(el); },
          write(next) { base.set.call(el, next); },
        };
      }`,
      'import { Field, wrap } from "./library.js";\nconst field = new Field();\nwrap(field).write("value");\nconsole.log(field.value);',
    ),
  ).toEqual([]);
});

/* A JavaScript binding an operator reads holds whatever the program last
 * stored, not the shape one assignment gave it: shipped JavaScript reuses one
 * `var` for a record, an array of lines and a count. Node converts the stored
 * value in every operator, so the binding takes checked-dynamic storage and
 * the ordinary arithmetic and comparison lowering applies the conversion. */
const RETYPED_OPERATOR = `var line = { name: "frame" };
var index = { step: 0 };
for (index = 0; index < 3; index++) {}
line = index;
export const answer = [1 <= line, line < 4, line, line--];`;

test("an unchecked JavaScript operator reads the value the binding holds", () => {
  expect(
    diagnostics(
      RETYPED_OPERATOR,
      'import { answer } from "./library.js"; console.log(answer.join());',
    ),
  ).toEqual([]);
});

test("a checked JavaScript operator keeps the checker's operand types", () => {
  const kept = diagnostics(
    `// @ts-check\n${RETYPED_OPERATOR}`,
    'import { answer } from "./library.js"; console.log(answer.join());',
  ).map((diagnostic) => diagnostic.message);
  expect(kept.some((message) => message.includes("Operator '<='"))).toBe(true);
  expect(kept.some((message) => message.includes("arithmetic on an operand"))).toBe(true);
});

test("an operator over a static record operand keeps the refusal", () => {
  // Both operands are values the widening prepass cannot reach: a literal and
  // an object read at the operator itself. Their conversion has no lowering.
  const kept = diagnostics(
    `export const answer = 1 <= { k: 1 };`,
    'import { answer } from "./library.js"; console.log(String(answer));',
  );
  expect(kept.some((diagnostic) => diagnostic.message.includes("Operator '<='"))).toBe(true);
});

test("a hoisted JavaScript var read before its assignment answers undefined", () => {
  expect(
    diagnostics(
      `export function install(flag) {
  var callback;
  if (flag) callback = function () { return "called"; };
  return [callback && callback(), typeof callback];
}`,
      'import { install } from "./library.js"; console.log(install(true).join());',
    ),
  ).toEqual([]);
});

test("a let read above its declaration keeps the temporal-dead-zone refusal", () => {
  const kept = diagnostics(
    `export function read() {
  const first = later;
  let later = 1;
  return first + later;
}`,
    'import { read } from "./library.js"; console.log(read());',
  );
  expect(kept.some((diagnostic) => diagnostic.code === "SC1090")).toBe(true);
});
