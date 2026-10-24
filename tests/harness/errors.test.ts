/* Error-object behavior Node cannot oracle — scriptc-only.
 *
 * The differential corpus (1300–1306) covers everything observable in
 * lockstep with Node: construction/fields/toString, subclasses, typed-catch
 * narrowing, async rejections, runtime failures caught as instances. What
 * lives here is the uncaught STDERR contract: Node prints a source excerpt
 * and a stack trace (and its display shows the CONSTRUCTOR's name where it
 * differs from .name); scriptc prints one `Uncaught <toString>` line —
 * SEMANTICS.md divergence 11. These pins keep that line's shape exact.
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit like every harness lane.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Compiles an inline program and runs the binary, tolerating nonzero exit.
 * `ext` picks the frontend lane — "cjs" for JS-only shapes (deferred
 * fences that tsc's arity families would reject in TS). `extraFiles`
 * materialize beside the entry (multi-module shapes: the CJS link-error
 * pins import sibling .cjs modules). */
async function compileAndRun(
  name: string,
  source: string,
  ext = "ts",
  extraFiles: Record<string, string> = {},
): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(JSON.stringify(extraFiles))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  // Multi-module programs live OUTSIDE node_modules: the cache dir sits
  // under it, where the resolver classifies sibling modules as npm files
  // (correctly — for real packages) and the relative import stops
  // resolving into the program.
  const outDir =
    Object.keys(extraFiles).length > 0
      ? join(tmpdir(), `scriptc-errors-${key}`)
      : join(cacheDir, `errors-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  for (const [extraName, text] of Object.entries(extraFiles)) {
    writeFileSync(join(outDir, extraName), text);
  }
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "errors program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr: stripAsanFiberWarning(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return {
      stdout: e.stdout ?? "",
      stderr: stripAsanFiberWarning(e.stderr ?? ""),
      exitCode: e.code,
    };
  }
}

/** Linux ASan prints a once-per-process warning to stderr the first time a
 * fiber swapcontext()s (the interceptor has no off switch; Apple's ASan
 * never intercepts ucontext, so the macOS lanes never see it). Sanitizer
 * diagnostic noise, never program output — dropped before any stderr
 * expectation, the RC-audit-skip-notice pattern from differential.test.ts. */
function stripAsanFiberWarning(s: string): string {
  return s.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

describe(`uncaught error objects (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("an uncaught builtin error prints Uncaught name: message", async () => {
    const r = await compileAndRun(
      "uncaught-builtin",
      `console.log("before");
throw new TypeError("boom");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toBe("Uncaught TypeError: boom\n");
  });

  test("a subclass prints its name PROPERTY — 'Error' when never assigned", async () => {
    // Node's uncaught display would show the constructor name (PlainSub)
    // even though .name is "Error"; we print the property — divergence 11.
    const r = await compileAndRun(
      "uncaught-subclass",
      `class PlainSub extends Error {}
throw new PlainSub("unnamed sub");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("Uncaught Error: unnamed sub\n");
  });

  test("toString's empty-half rules shape the line", async () => {
    const empty = await compileAndRun("uncaught-empty", `throw new Error();\n`);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toBe("Uncaught Error\n");

    const nameless = await compileAndRun(
      "uncaught-nameless",
      `const e = new Error("just the message");
e.name = "";
throw e;
`,
    );
    expect(nameless.exitCode).toBe(1);
    expect(nameless.stderr).toBe("Uncaught just the message\n");
  });

  test("an uncaught checked-dynamic primitive prints its value, like Node", async () => {
    // Node prints the thrown primitive itself (after its source excerpt);
    // the value must never be lost behind a placeholder.
    const text = await compileAndRun(
      "uncaught-unknown-string",
      `console.log("before");
const v: unknown = process.argv.length > 99 ? 0 : "plain";
throw v;
`,
    );
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toBe("before\n");
    expect(text.stderr).toBe("Uncaught plain\n");

    const num = await compileAndRun(
      "uncaught-unknown-number",
      `const v: unknown = process.argv.length > 99 ? "x" : 42;
throw v;
`,
    );
    expect(num.exitCode).toBe(1);
    expect(num.stderr).toBe("Uncaught 42\n");
  });

  test("an unhandled ERROR rejection renders name: message too", async () => {
    const r = await compileAndRun(
      "unhandled-error-rejection",
      `async function fail(): Promise<void> {
  throw new RangeError("nobody awaits this");
}
fail();
console.log("sync done");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("sync done\n");
    expect(r.stderr).toBe("Unhandled promise rejection: RangeError: nobody awaits this\n");
  });
});

// `x as Sub` on a class value is a CHECKED downcast, and `x!` / `u as Arm`
// on a union value is a checked extraction: a stored value outside the
// target throws a catchable TypeError where Node's erasure would let the
// value flow on. The type and message are scriptc's contract (corpus 4432
// pins the Node-observable part: the failure is a TypeError raised before
// any later read). Plain operands are tested inline at the use and call
// operands through the interned helper; both must fail identically.
describe("checked class downcasts and extractions", () => {
  test("failed downcasts throw the TypeError naming the target class", async () => {
    const r = await compileAndRun(
      "checked-downcast-messages",
      `class Base {
  kind = 0;
}
class Sub extends Base {
  text = "sub";
}
class Other {
  tag = "other";
}
function direct(b: Base): string {
  return (b as Sub).text;
}
function optional(b: Base | undefined): string {
  return (b as Sub).text;
}
function mixed(v: Base | Other): string {
  return (v as Sub).text;
}
function make(b: Base | undefined): Base | undefined {
  return b;
}
function called(b: Base | undefined): string {
  return (make(b) as Sub).text;
}
function asserted(b: Base | undefined): number {
  return b!.kind;
}
function assertedCall(b: Base | undefined): number {
  return make(b)!.kind;
}
const runs: Array<() => unknown> = [
  () => direct(new Sub()),
  () => direct(new Base()),
  () => optional(undefined),
  () => optional(new Base()),
  () => mixed(new Other()),
  () => called(new Base()),
  () => called(undefined),
  () => asserted(new Base()),
  () => asserted(undefined),
  () => assertedCall(undefined),
];
for (const run of runs) {
  try {
    console.log("ok", run());
  } catch (e) {
    console.log(e instanceof TypeError, String(e));
  }
}
direct(new Base());
`,
    );
    expect(r.stdout).toBe(
      [
        "ok sub",
        "true TypeError: Value is not an instance of 'Sub'",
        "true TypeError: Value is not an instance of 'Sub'",
        "true TypeError: Value is not an instance of 'Sub'",
        "true TypeError: Value is not an instance of 'Sub'",
        "true TypeError: Value is not an instance of 'Sub'",
        "true TypeError: Value is not an instance of 'Sub'",
        "ok 0",
        "true TypeError: undefined is not representable in the target union (a value narrowed or asserted past it still held it)",
        "true TypeError: undefined is not representable in the target union (a value narrowed or asserted past it still held it)",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toBe("Uncaught TypeError: Value is not an instance of 'Sub'\n");
    expect(r.exitCode).toBe(1);
  });
});

// `e as C` on a catch binding is a CHECKED cast: a payload outside C's
// hierarchy throws a catchable TypeError where Node's erasure would read
// undefined off the value — dynCheck's documented trust-but-verify stance
// extended to exception payloads. This is exactly the case that cannot be
// a differential test; pinned so the divergence stays deliberate.
describe("checked catch-binding casts", () => {
  test("a mismatched `as Error` throws the catchable TypeError", async () => {
    const r = await compileAndRun(
      "caught-check-mismatch",
      `try {
  throw "stringy";
} catch (err) {
  try {
    console.log((err as Error).message);
  } catch (inner) {
    if (inner instanceof TypeError) console.log("checked:", inner.message);
  }
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("checked: caught value is not an instance of Error (checked cast)\n");
    expect(r.stderr).toBe("");
  });

  test("an uncaught mismatch propagates as the TypeError", async () => {
    const r = await compileAndRun(
      "caught-check-uncaught",
      `try {
  throw 42;
} catch (err) {
  console.log((err as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(
      "Uncaught TypeError: caught value is not an instance of Error (checked cast)\n",
    );
  });

  test("a typed-array write through an undefined index is a named runtime fence", async () => {
    // Node stores an ordinary property named "undefined" on the typed
    // array, which a compiled typed array cannot hold; defined indexes
    // before it store as usual.
    const r = await compileAndRun(
      "typed-array-undefined-index",
      `const holey: number[] = [1];
holey[3] = 3;
const cells = new Float64Array(4);
for (const i of holey) cells[i] = 9;
console.log(cells.join(","));
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: typed array properties named 'undefined' \(an element index that is undefined\) are not supported yet \[SC1090 at .*typed-array-undefined-index\.ts:4\]\n$/,
    );
  });

  test("a split require closing a CommonJS cycle keeps the const form's SC1016", async () => {
    // Node answers the closing require with the dependency's partial exports
    // ({ fromA: 1 } at this point), which the static export model cannot
    // represent. Preflight treats the split assignment like `const a =
    // require("./a.cjs")`, so the cycle keeps that form's SC1016 instead of
    // reading uninitialized export storage. A cycle whose reads are all deferred
    // compiles (tests/corpus/split-cjs-require-cycle).
    const r = compileAndRun(
      "split-require-cycle",
      `require("./a.cjs");
`,
      "cjs",
      {
        "a.cjs": `exports.fromA = 1;
const b = require("./b.cjs");
exports.fromB = b.fromB;
`,
        "b.cjs": `exports.fromB = 2;
var a;
a = require("./a.cjs");
console.log(a.fromA, a.fromB);
`,
      },
    );
    await expect(r).rejects.toThrow(
      /SC1016: circular imports \(.*a\.cjs → .*b\.cjs → .*a\.cjs; the cycle closes through a require\(\) edge/,
    );
  });

  test("an EFFECTFUL surplus argument is a named deferred fence (JS lane)", async () => {
    // Effect-free surplus args drop at compile time, JS-exact (corpus
    // 1760 — the test-string-decoder writeSequences shape). An effectful
    // one has no evaluation slot in the completed call, so instead of
    // skipping it without a diagnostic the build defers a named SC1090 to the
    // call site. JS-only: tsc's arity errors gate the TS lane.
    const r = await compileAndRun(
      "surplus-args-effectful",
      `'use strict';
function two(a, b) {
  return a + b;
}
function effectful() {
  console.log('side effect JS would run');
  return 0;
}
console.log(two(1, 2, effectful()));
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: surplus arguments with side effects .* are not supported yet \[SC1090 at .*surplus-args-effectful\.cjs:9\]\n$/,
    );
  });

  test.each([
    {
      label: "Array.from",
      name: "array-from-length-elements",
      source: `const arr = Array.from({ length: 2 }, () => new Date(0));`,
    },
    {
      label: "flatMap",
      name: "flatmap-elements",
      source: `const arr = [1].flatMap(() => new Date(0));`,
    },
    {
      label: "tuple map",
      name: "tuple-map-elements",
      source: `/** @type {[number]} */
const tuple = [1];
const arr = tuple.map(() => new Date(0));`,
    },
  ])("$label preserves checked callback results (JS lane)", async ({ name, source }) => {
    const program = source + "\nconsole.log(arr.length, arr[0].getTime());\n";
    const r = await compileAndRun(name, program, "js");
    const reference = await execFileAsync(process.execPath, ["--eval", program], {
      encoding: "utf8",
    });
    expect(r).toEqual({ stdout: reference.stdout, stderr: reference.stderr, exitCode: 0 });
  });

  test.each([
    ["an argument", "make(Upper, { objectMode: true });"],
    ["a spread argument", "spread(Upper, [{ objectMode: true }]);"],
  ])(
    "%s through an untyped factory to an inherited stream constructor is a named deferred fence (JS lane)",
    async (_, call) => {
      // The constructor a ctor-less stream subclass inherits takes no
      // arguments here; typed construction refuses them at compile time,
      // and construction from untyped code refuses them at run time
      // instead of constructing without them.
      const r = await compileAndRun(
        `inherited-stream-ctor-${call.startsWith("make") ? "args" : "spread"}`,
        `'use strict';
const { Transform } = require('node:stream');
class Upper extends Transform {}
function make(F, options) { return new F(options); }
function bare(F) { return new F(); }
function spread(F, args) { return new F(...args); }
console.log('bare', bare(Upper) instanceof Upper, spread(Upper, []) instanceof Upper);
${call}
`,
        "cjs",
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("bare true true\n");
      expect(r.stderr).toMatch(
        /^Uncaught Error: new Upper with arguments through an inherited stream constructor .* is not supported yet \[SC1090 at .*inherited-stream-ctor-\w+\.cjs:3\]\n$/,
      );
    },
  );

  test("extending a property-assigned class ABOVE its assignment is a named deferred fence (JS lane)", async () => {
    // The property-assigned class-expression family (corpus 2032/2033
    // pins what lowers): `exports.O = class extends exports.I {}` with
    // the base assigned BELOW would extend undefined in Node (TypeError
    // at the derived statement) — the source-order guard defers a named
    // fence instead of pinning a base that doesn't exist yet.
    const r = await compileAndRun(
      "extends-above-assignment",
      `'use strict';
exports.O = class extends exports.I {};
exports.I = class {};
console.log('unreached');
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: extending 'exports\.I' above the statement that assigns it .* \[SC1090 at .*extends-above-assignment\.cjs:2\]\n$/,
    );
  });

  test("a REASSIGNED property-assigned class stays fenced instead of extending the wrong base (JS lane)", async () => {
    // Two `exports.I = class …` assignments make the binding dynamic (the
    // runtime base is whichever ran last). The second assignment's
    // class-value flow fence fires first (nominal classval slots), and the
    // extends resolver refuses to pin either class — the program fences
    // instead of extending the first assignment's class.
    const r = await compileAndRun(
      "extends-reassigned-property",
      `'use strict';
exports.I = class { a() { return 1; } };
exports.I = class { a() { return 2; } };
exports.O = class extends exports.I {};
console.log(new exports.O().a());
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: .* \[SC1090 at .*extends-reassigned-property\.cjs:\d+\]\n$/,
    );
  });

  test("a non-callable constructor field shadows its method and throws at the call (JS lane)", async () => {
    const r = await compileAndRun(
      "leaf-shadowing-class-defers",
      `'use strict';
console.log("before");
class X {
  constructor() {
    this.m = "not callable";
  }
  m() {
    console.log("method");
  }
}
const x = new X();
x.m();
console.log("unreachable");
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toBe("Uncaught TypeError: x.m is not a function\n");
  });

  test("a callable constructor field shadows an inherited method (JS lane)", async () => {
    const r = await compileAndRun(
      "derived-shadowing-class-defers",
      `'use strict';
console.log("before");
class A {
  foo() {
    return 4;
  }
}
class B extends A {
  constructor() {
    super();
    this.foo = () => 3;
  }
}
const i = new B();
console.log(i.foo());
`,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("before\n3\n");
    expect(r.stderr).toBe("");
  });

  test("destructuring a SURFACED builtin global's member is a named fence at the pattern (JS lane)", async () => {
    // `const { max } = Math` would detach a member whose lowering is
    // keyed to its receiver (Math.max) — the pattern fences by member
    // and global name instead of binding a token whose calls fail late.
    // Corpus 2558 pins the OPAQUE globals, where members DO bind tokens.
    const r = await compileAndRun(
      "destructure-surfaced-global",
      `'use strict';
const { max } = Math;
console.log(max(1, 2));
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: destructuring the member 'max' of the builtin global 'Math' \(a detached member loses its receiver-keyed lowering — call it through the global\) is not supported yet \[SC1031 at .*destructure-surfaced-global\.cjs:2\]\n$/,
    );
  });

  test("an OPAQUE global's destructured member binds a token; uses fence lazily per site (JS lane)", async () => {
    // The node-suite webcrypto prologue: `const { subtle } =
    // globalThis.crypto` binds the member identity token, so the program
    // RUNS past the destructure (the eager pattern fence used to kill it
    // at that line) and each use meets its own named fence.
    const r = await compileAndRun(
      "destructure-opaque-global",
      `'use strict';
const { subtle } = globalThis.crypto;
console.log('bound', !!subtle);
subtle.digest('SHA-256');
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("bound true\n");
    expect(r.stderr).toMatch(/^Uncaught TypeError: subtle\.digest is not a function\n$/);
  });

  test("a 7000-level expression is a named deferred fence, not a stack overflow (JS lane)", async () => {
    // The binderBinaryExpressionStress depth: an AST deep enough that the
    // PREFLIGHT walks (the checker facade's prefetch sweep, the require
    // scans) used to overflow the JS stack as a RangeError ICE before the
    // expression lowering's 200-level SC1090 fence could fire. Every
    // whole-file walk is iterative now (walkPreorder), so the JS lane
    // compiles and defers the named fence to the statement — the TS lane's
    // compile-time twin is the deep-nesting-preflight diagnostics fixture.
    // Parens carry the depth (a real 6500-term chain spends minutes in
    // per-node type queries; the walk that used to crash is shape-blind).
    const r = await compileAndRun(
      "deep-nesting-chain",
      `'use strict';
let x = ${"(".repeat(7000)}1${")".repeat(7000)};
console.log('after');
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: expressions nested deeper than 200 levels are not supported yet \[SC1090 at .*deep-nesting-chain\.cjs:2\]\n$/,
    );
  });

  test("process.on with a prototype-member event name fences by NAME", async () => {
    // '__proto__' used to fall into the compiler's own signal table —
    // `{ SIGINT: 2 }["__proto__"]` answered Object.prototype, which rode
    // a numLit into the C as `[object Object]` (invalid C, cc.js death).
    // The own() lookup makes it what every other unsupported process
    // event is: a named deferred fence. Corpus 1761 pins the EMITTER
    // side, where these names work and match Node byte-exactly.
    const r = await compileAndRun(
      "process-on-proto",
      `'use strict';
process.on('__proto__', () => {});
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: 'process\.on\("__proto__", \.\.\.\)' is part of the standard library types but has no scriptc lowering yet \[SC2020 at .*process-on-proto\.cjs:2\]\n$/,
    );
  });
});

// Node's CJS named-import LINK error: a named import of an export the CJS
// lexer cannot detect kills the graph before ANY module evaluates, and
// scriptc compiles the program to exactly that startup throw. The corpus
// (1613/1616/1618/1619) pins stdout+exit differentially; what lives here
// is the MESSAGE — Node's exact SyntaxError text, both flavors, hint
// construction included — which the exit-1 stdout-only contract cannot see.
describe("CJS named-import link SyntaxError messages", () => {
  test("an entry-level import gets Node's CommonJS hint form, ` as ` rewritten", async () => {
    const r = await compileAndRun(
      "cjs-link-flavored",
      `import { a as z, vis } from './table.cjs';
console.log('never runs', z, vis);
`,
      "mjs",
      { "table.cjs": "'use strict';\nconst v = 5;\nmodule.exports = { vis: v, a: 7 };\n" },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: Named export 'a' not found. The requested module './table.cjs' is a CommonJS module, which may not support all module.exports as named exports.\n" +
        "CommonJS modules can always be imported via the default export, for example using:\n" +
        "\n" +
        "import pkg from './table.cjs';\n" +
        "const { a: z, vis } = pkg;\n" +
        "\n",
    );
  });

  test("a failure below the entry keeps V8's generic wording", async () => {
    // module_job.js rewrites the message only when the failing specifier
    // is one of the ROOT module's own requests — mid.mjs's is not.
    const r = await compileAndRun(
      "cjs-link-generic",
      `import { a } from './mid.mjs';
console.log('never runs', a);
`,
      "mjs",
      {
        "mid.mjs": "export { a } from './table.cjs';\n",
        "table.cjs": "'use strict';\nmodule.exports = { a: 7 };\n",
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './table.cjs' does not provide an export named 'a'\n",
    );
  });
});

// Node's strip-only TypeScript loader keeps ordinary named imports in the
// ESM request graph. If the requested declaration is type-only, Node refuses
// during linking even though the TypeScript checker accepts the import. The
// corpus pins stdout and exit; these assertions pin scriptc's exact uncaught
// SyntaxError message and the local-name ordering used to choose the first
// failure.
describe("native ESM type-import link SyntaxError messages", () => {
  test("an unqualified interface import fails before any module evaluates", async () => {
    const r = await compileAndRun(
      "esm-type-link",
      `import { value, Shape as MissingShape } from './types.ts';
console.log('never runs', value);
`,
      "ts",
      {
        "types.ts": `export interface Shape { value: number }
export const value = 7;
console.log('types evaluated');
`,
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './types.ts' does not provide an export named 'Shape'\n",
    );
  });

  test("a child re-export failure wins before the parent import is linked", async () => {
    const r = await compileAndRun(
      "esm-type-link-reexport",
      `import { Zed as zed, Aa as aaa, value } from './middle.ts';
console.log('never runs', value);
`,
      "ts",
      {
        "middle.ts": `export { Shape as Zed, Other as Aa, value } from './types.ts';
console.log('middle evaluated');
`,
        "types.ts": `export interface Shape { value: number }
export type Other = string;
export const value = 9;
console.log('types evaluated');
`,
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './types.ts' does not provide an export named 'Shape'\n",
    );
  });

  test("direct imports choose the first missing binding by local name", async () => {
    const r = await compileAndRun(
      "esm-type-link-order",
      `import { Shape as zed, Other as aaa } from './types.ts';
console.log('never runs');
`,
      "ts",
      {
        "types.ts": `export interface Shape { value: number }
export type Other = string;
`,
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './types.ts' does not provide an export named 'Other'\n",
    );
  });

  test("native compilation retains the ESM link failure", async () => {
    const r = await compileAndRun(
      "esm-type-link-dynamic",
      `// @dynamic
import { Shape as MissingShape } from './types.ts';
console.log('never runs');
`,
      "ts",
      { "types.ts": "export interface Shape { value: number }\nconsole.log('types evaluated');\n" },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './types.ts' does not provide an export named 'Shape'\n",
    );
  });

  test("default interface exports satisfy Node's strip-only default link", async () => {
    const r = await compileAndRun(
      "esm-default-interface-link",
      `import DefaultShape from './types.ts';
type LocalShape = DefaultShape;
console.log('ok');
`,
      "ts",
      { "types.ts": "export default interface DefaultShape { value: number }\n" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok\n");
    expect(r.stderr).toBe("");
  });

  test("explicit module packages do not expose default-interface placeholders", async () => {
    const r = await compileAndRun(
      "esm-default-interface-explicit-module",
      `import DefaultShape from './types.ts';
type LocalShape = DefaultShape;
console.log('never runs');
`,
      "ts",
      {
        "package.json": `{ "type": "module" }\n`,
        "types.ts": "export default interface DefaultShape { value: number }\n",
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './types.ts' does not provide an export named 'default'\n",
    );
  });

  test("typeless packages preserve default-interface placeholders through re-exports", async () => {
    const r = await compileAndRun(
      "esm-default-interface-reexport",
      `import DefaultShape from './reexport.ts';
type LocalShape = DefaultShape;
console.log('ok');
`,
      "ts",
      {
        "reexport.ts": `export { default } from './types.ts';\n`,
        "types.ts": "export default interface DefaultShape { value: number }\n",
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok\n");
    expect(r.stderr).toBe("");
  });

  test("a child native-ESM failure wins over a later parent CJS failure", async () => {
    const r = await compileAndRun(
      "esm-type-link-before-cjs",
      `import './middle.ts';
import { missing } from './table.cjs';
console.log('never runs', missing);
`,
      "ts",
      {
        "middle.ts": `import { Shape } from './types.ts';
console.log('middle never runs');
`,
        "types.ts": "export interface Shape { value: number }\nconsole.log('types evaluated');\n",
        "table.cjs": "module.exports = { missing: 7 };\n",
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Uncaught SyntaxError: The requested module './types.ts' does not provide an export named 'Shape'\n",
    );
  });
});

describe("checked-dynamic boundary behavior (scriptc-only)", () => {
  test("a checked argument into a call through 'unknown' matches Node", async () => {
    // `this` in a plain JS function is the checked-dynamic ambient
    // receiver; a member CALL through it with an 'any'-typed argument

    // 383(d)'s "one unbridgeable mix"). The crossing exists now
    // (dynFromJsval, SEMANTICS 394): the argument wraps by reference, the
    // statement compiles for real, and the unbound-`this` member read
    // throws Node's OWN TypeError — the divergence this pin used to own
    // is retired.
    const r = await compileAndRun(
      "checked-arg-dyn-call",
      `// @dynamic
'use strict';
function register(item) {
  try {
    this.registry(item);
    return "unreachable";
  } catch (e) {
    return "caught: " + e.message;
  }
}
console.log(\`\${register(7)}\`);
`,
      "mjs",
      { "tsconfig.json": '{"compilerOptions":{"strict":true,"noImplicitAny":false}}\n' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("caught: Cannot read properties of undefined (reading 'registry')\n");
    expect(r.stderr).toBe("");
  });
});

// A cipher name Node lists in crypto.getCiphers() but the runtime does not
// implement throws a coded SC2020 error naming the cipher when the name is
// computed; literal names are refused at compile time (node-types-fenced).
describe("unimplemented cipher names", () => {
  test("a computed cipher name throws SC2020 naming the cipher", async () => {
    const r = await compileAndRun(
      "cipher-computed-name",
      `import { createCipheriv } from "node:crypto";
const mode = ["o", "c", "b"].join("");
try {
  createCipheriv("aes-128-" + mode, Buffer.alloc(16), Buffer.alloc(12));
} catch (error) {
  const e = error as Error & { code?: string };
  console.log(e.name, e.code, e.message);
}
try {
  createCipheriv("aes-128-" + mode.slice(1), Buffer.alloc(16), Buffer.alloc(12));
} catch (error) {
  const e = error as Error & { code?: string };
  console.log(e.name, e.code, e.message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Error SC2020 The cipher 'aes-128-ocb' has no native implementation; the supported ciphers are " +
        "aes-128, aes-192 and aes-256 in cbc, ctr, gcm, ccm, ecb, cfb, cfb8, cfb1 and ofb modes and their " +
        "wrap, wrap-pad, wrap-inv and wrap-pad-inv key wraps, des-ede3 in cbc, ecb, cfb, cfb8, cfb1 and " +
        "ofb modes, des-ede in cbc, ecb, cfb and ofb modes, chacha20 and chacha20-poly1305\n" +
        "Error ERR_CRYPTO_UNKNOWN_CIPHER Unknown cipher\n",
    );
    expect(r.stderr).toBe("");
  });
});

// getCipherInfo's result is Node's info object; CipherInfo declares nid as
// required, and Node reports the SIV ciphers without one.
describe("getCipherInfo through CipherInfo", () => {
  test("a typed read of a missing nid throws a TypeError", async () => {
    const r = await compileAndRun(
      "cipher-info-no-nid",
      `import { getCipherInfo } from "node:crypto";
const siv = getCipherInfo("aes-128-siv")!;
console.log(JSON.stringify(siv), getCipherInfo("aes-128-gcm")?.nid);
try {
  const nid: number = siv.nid;
  console.log(nid);
} catch (error) {
  const e = error as Error;
  console.log(e.name, e.message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      '{"mode":"siv","name":"aes-128-siv","blockSize":1,"keyLength":32} 895\n' +
        "TypeError expected number at $, got undefined\n",
    );
    expect(r.stderr).toBe("");
  });
});

// new tls.TLSSocket reads a runtime options record: the client mode, whose
// handshake Node never starts, and members without a lowering throw the
// fence, as do sockets it cannot take over (a second wrap, and
// tls.connect({ socket }) over a socket that is still dialing).
describe("tls.TLSSocket runtime fences", () => {
  test("client mode, unlowered members and sockets that cannot be taken over throw", async () => {
    const r = await compileAndRun(
      "tls-socket-fences",
      `import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
const certs = "tests/fixtures/server/certs";
const cert = readFileSync(\`\${certs}/localhost.pem\`);
const key = readFileSync(\`\${certs}/localhost-key.pem\`);
function report(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no error");
  } catch (error) {
    console.log(label, (error as Error).message);
  }
}
const client: Record<string, unknown> = { cert, key };
const session: Record<string, unknown> = { isServer: true, cert, key, session: Buffer.alloc(1) };
const server: Record<string, unknown> = { isServer: true, cert, key };
const listener = net.createServer((raw) => {
  report("client mode", () => new tls.TLSSocket(raw, client));
  report("session", () => new tls.TLSSocket(raw, session));
  const wrapped = new tls.TLSSocket(raw, server);
  report("twice", () => new tls.TLSSocket(raw, server));
  wrapped.destroy();
  listener.close();
});
listener.listen(0, () => {
  const c = net.connect((listener.address() as net.AddressInfo).port, "localhost");
  report("dialing", () => tls.connect({ socket: c }));
  c.on("error", () => {});
});
`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "dialing tls.connect over a socket that is not connected, or is already wrapped, is not supported yet\n" +
        "client mode new tls.TLSSocket option 'isServer' has no static lowering — Node starts no handshake for a client-mode TLSSocket; tls.connect({ socket }) runs the client handshake over an open socket\n" +
        "session new tls.TLSSocket option 'session' has no static lowering — isServer, cert, key, secureContext, ALPNProtocols, minVersion and maxVersion are the implemented members\n" +
        "twice new tls.TLSSocket over a socket that is not connected, or is already wrapped, is not supported yet\n",
    );
  });
});

// With a secureContext, the TLSSocket's own options still apply: a truthy
// requestCert (which lowers with cert and key, whose ca the runtime reads)
// and SNICallback throw the fence instead of being dropped.
describe("tls.TLSSocket socket options beside a secureContext", () => {
  test("requestCert and SNICallback throw the fence", async () => {
    const r = await compileAndRun(
      "tls-socket-context-fences",
      `import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
const certs = "tests/fixtures/server/certs";
const cert = readFileSync(\`\${certs}/localhost.pem\`);
const key = readFileSync(\`\${certs}/localhost-key.pem\`);
const context = tls.createSecureContext({ cert, key });
function report(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no error");
  } catch (error) {
    console.log(label, (error as Error).message);
  }
}
const listener = net.createServer((raw) => {
  report("requestCert", () => new tls.TLSSocket(raw, { isServer: true, secureContext: context, requestCert: true, rejectUnauthorized: true }));
  report("SNICallback", () => new tls.TLSSocket(raw, { isServer: true, secureContext: context, SNICallback: (name: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => cb(null, context) }));
  report("requestCert false", () => new tls.TLSSocket(raw, { isServer: true, secureContext: context, requestCert: false, rejectUnauthorized: true }).destroy());
  listener.close();
});
listener.listen(0, () => {
  const c = net.connect((listener.address() as net.AddressInfo).port, "localhost");
  c.on("error", () => {});
  c.on("close", () => console.log("client closed"));
});
`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "requestCert new tls.TLSSocket option 'requestCert' has no static lowering — requestCert lowers with cert and key options, not beside a secureContext\n" +
        "SNICallback new tls.TLSSocket option 'SNICallback' has no static lowering — isServer, cert, key, secureContext, ALPNProtocols, minVersion and maxVersion are the implemented members\n" +
        "requestCert false no error\n" +
        "client closed\n",
    );
  });
});

// A client certificate lowers as a cert and key pair; one without the
// other throws the fence before any connection is made.
describe("client certificates without both cert and key", () => {
  test("tls.connect and https.request throw the fence", async () => {
    const r = await compileAndRun(
      "tls-client-certificate-fences",
      `import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
const certs = "tests/fixtures/server/certs";
const cert = readFileSync(\`\${certs}/client.pem\`);
const key = readFileSync(\`\${certs}/client-key.pem\`);
function report(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no error");
  } catch (error) {
    console.log(label, (error as Error).message);
  }
}
report("connect cert only", () => tls.connect({ port: 1, host: "127.0.0.1", cert }));
report("connect key only", () => tls.connect({ port: 1, host: "127.0.0.1", key }));
report("request key only", () => https.request({ host: "127.0.0.1", port: 1, path: "/", key }));
`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "connect cert only tls.connect option 'cert' has no static lowering — a client certificate lowers with both cert and key\n" +
        "connect key only tls.connect option 'key' has no static lowering — a client certificate lowers with both cert and key\n" +
        "request key only https.request option 'key' has no static lowering — a client certificate lowers with both cert and key\n",
    );
  });
});

// server.addContext and setSecureContext answer on tls and https servers;
// a plain net server, a servername Node's RegExp would read as groups or
// alternation, and one outside ASCII throw the fence. A handshake failure
// whose OpenSSL reason the runtime does not know reaches 'tlsClientError'
// as a coded SC2020 error.
describe("tls.Server contexts and client errors without a lowering", () => {
  test("addContext and setSecureContext fences, and an unknown handshake failure", async () => {
    const r = await compileAndRun(
      "tls-server-context-fences",
      `import { readFileSync } from "node:fs";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";
const certs = "tests/fixtures/server/certs";
const cert = readFileSync(\`\${certs}/localhost.pem\`);
const key = readFileSync(\`\${certs}/localhost-key.pem\`);
function report(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no error");
  } catch (error) {
    console.log(label, (error as Error).message);
  }
}
const plain = net.createServer() as unknown as tls.Server;
report("net addContext", () => plain.addContext("a.test", { cert, key }));
report("net setSecureContext", () => plain.setSecureContext({ cert, key }));
const server = tls.createServer({ cert, key });
report("alternation", () => server.addContext("a.test|b.test", { cert, key }));
report("group", () => server.addContext("(a).test", { cert, key }));
report("non-ASCII", () => server.addContext("\u00e9.test", { cert, key }));
server.on("tlsClientError", (err: Error) => console.log("tlsClientError", (err as NodeJS.ErrnoException).code, err.message));
server.listen(0, "127.0.0.1", () => {
  const raw = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    raw.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]));
  });
  raw.on("data", () => {});
  raw.on("close", () => server.close());
});
`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "net addContext server.addContext on a server that is not a tls or https server is not supported yet\n" +
        "net setSecureContext server.setSecureContext on a server that is not a tls or https server is not supported yet\n" +
        "alternation server.addContext option 'servername' has no static lowering — a servername with regular-expression groups or alternation has no lowering\n" +
        "group server.addContext option 'servername' has no static lowering — a servername with regular-expression groups or alternation has no lowering\n" +
        "non-ASCII server.addContext option 'servername' has no static lowering — a servername outside ASCII has no lowering\n" +
        "tlsClientError SC2020 a TLS handshake failure (mbedTLS error -0x7300) without the reason OpenSSL gives is not supported yet\n",
    );
  });
});

// A curve Node lists in crypto.getCurves() but the runtime does not
// implement throws a coded SC2020 error naming the curve when the name is
// computed; literal names are refused at compile time (node-types-fenced).
describe("unimplemented ECDH curves", () => {
  test("a computed curve name throws SC2020 naming the curve", async () => {
    const r = await compileAndRun(
      "ecdh-computed-curve",
      `import { createECDH, ECDH } from "node:crypto";
const size = ["1", "6", "3"].join("");
function report(error: unknown): void {
  const e = error as Error & { code?: string };
  console.log(e.name, e.code, e.message);
}
try {
  createECDH("sect" + size + "k1");
} catch (error) {
  report(error);
}
try {
  ECDH.convertKey(Buffer.from([0]), "sect" + size + "k1");
} catch (error) {
  report(error);
}
try {
  createECDH("sect" + size + "x1");
} catch (error) {
  report(error);
}
`,
    );
    expect(r.exitCode).toBe(0);
    const supported =
      "has no native implementation; the supported curves are prime192v1, secp224r1, prime256v1, " +
      "secp384r1, secp521r1, secp192k1, secp224k1, secp256k1, brainpoolP256r1, brainpoolP384r1 and " +
      "brainpoolP512r1";
    expect(r.stdout).toBe(
      `Error SC2020 The curve 'sect163k1' ${supported}\n` +
        `Error SC2020 The curve 'sect163k1' ${supported}\n` +
        "TypeError ERR_CRYPTO_INVALID_CURVE Invalid EC curve name\n",
    );
    expect(r.stderr).toBe("");
  });

  test("ECDH property reads and writes throw SC2020", async () => {
    const r = await compileAndRun(
      "ecdh-properties",
      `const crypto = require("node:crypto");
const ecdh = crypto.createECDH("prime256v1");
for (const run of [() => ecdh.getPublicKey.name, () => { ecdh.custom = 1; }]) {
  try {
    run();
  } catch (e) {
    console.log(e.name, e.code);
  }
}
`,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("Error SC2020\nError SC2020\n");
  });
});

// DiffieHellman primes past mbedTLS's 8192-bit limit throw a coded SC2020
// error, as do property reads other than verifyError, property writes, and
// Object.prototype method calls on an untyped DiffieHellman.
describe("DiffieHellman runtime refusals", () => {
  test("primes longer than 8192 bits throw SC2020", async () => {
    const r = await compileAndRun(
      "dh-long-prime",
      `import { createDiffieHellman } from "node:crypto";
const prime = Buffer.alloc(1025, 0xff);
for (const run of [() => createDiffieHellman(prime), () => createDiffieHellman(8193)]) {
  try {
    run();
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
}
console.log(createDiffieHellman(Buffer.alloc(1024, 0xff)).verifyError);
`,
    );
    expect(r.exitCode).toBe(0);
    const message = "DiffieHellman primes longer than 8192 bits have no native implementation";
    expect(r.stdout).toBe(`Error SC2020 ${message}\nError SC2020 ${message}\n1\n`);
    expect(r.stderr).toBe("");
  });

  test("DiffieHellman property reads, writes and Object.prototype calls throw SC2020", async () => {
    const r = await compileAndRun(
      "dh-properties",
      `const crypto = require("node:crypto");
const dh = crypto.getDiffieHellman("modp1");
console.log(dh.verifyError);
for (const run of [() => dh.getPrime.name, () => { dh.verifyError = 1; }, () => dh.hasOwnProperty("verifyError")]) {
  try {
    run();
  } catch (e) {
    console.log(e.name, e.code);
  }
}
`,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("0\nError SC2020\nError SC2020\nError SC2020\n");
  });
});

// Node formats an unknown output encoding with %s, which prints a
// function's source text and calls a toString the encoding's class
// defines. The cipher runtime has neither, so both throw a coded SC2020
// error.
describe("cipher output encodings that print through source text or a class toString", () => {
  test("update() and final() throw SC2020", async () => {
    const r = await compileAndRun(
      "cipher-encoding-class-to-string",
      `import { createCipheriv } from "node:crypto";
class Encoding {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  toString(): string {
    return this.name;
  }
}
const instance: any = new Encoding("nope");
const fn: any = () => "nope";
try {
  createCipheriv("aes-128-ctr", Buffer.alloc(16), Buffer.alloc(16)).final(instance);
} catch (error) {
  const e = error as Error & { code?: string };
  console.log(e.name, e.code, e.message);
}
try {
  createCipheriv("aes-128-ctr", Buffer.alloc(16), Buffer.alloc(16)).update("abc", "utf8", fn);
} catch (error) {
  const e = error as Error & { code?: string };
  console.log(e.name, e.code, e.message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    const message =
      "Error SC2020 An output encoding that is a function or an instance of a class defining toString has no lowering; " +
      "pass the encoding name as a string\n";
    expect(r.stdout).toBe(message + message);
    expect(r.stderr).toBe("");
  });
});

// getCipherInfo reads keyLength and ivLength through getters, which a
// class instance's accessors are not visible to from the runtime, so a
// class that defines either throws a coded SC2020 error.
describe("getCipherInfo options whose class defines keyLength or ivLength", () => {
  test("throw SC2020 after the argument checks", async () => {
    const r = await compileAndRun(
      "cipher-info-class-options",
      `import { getCipherInfo } from "node:crypto";
class Options {
  get keyLength(): number {
    return 17;
  }
}
const options: any = new Options();
const names: any[] = ["aes-128-cbc", 1.5];
for (const name of names) {
  try {
    getCipherInfo(name, options);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Error SC2020 getCipherInfo options whose class defines keyLength or ivLength have no lowering; " +
        "pass an object with those properties\n" +
        'RangeError ERR_OUT_OF_RANGE The value of "nameOrNid" is out of range. It must be an integer. Received 1.5\n',
    );
    expect(r.stderr).toBe("");
  });
});

// After a Hash's stream flushes its digest, Node copies the finished
// OpenSSL context, whose later updates and digests fail with OpenSSL
// error-queue codes. That copy throws a coded SC2020 error.
describe("copy() of a Hash whose stream has flushed", () => {
  test("throws SC2020", async () => {
    const r = await compileAndRun(
      "hash-stream-copy-after-flush",
      `import { createHash } from "node:crypto";
const hash = createHash("sha256");
hash.resume();
hash.on("finish", () => {
  try {
    hash.copy();
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
});
hash.end("abc");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Error SC2020 copy() of a Hash whose stream has flushed its digest has no lowering\n",
    );
    expect(r.stderr).toBe("");
  });
});

// A Hash or Hmac lets go of its stream once the stream is destroyed, so
// listeners that capture the value do not keep it alive. Using the value
// as a stream again throws a coded SC2020 error; Node keeps the destroyed
// stream.
describe("stream use of a Hash after its stream closed", () => {
  test("throws SC2020", async () => {
    const r = await compileAndRun(
      "hash-stream-after-close",
      `import { createHash } from "node:crypto";
const hash = createHash("sha256");
hash.resume();
hash.on("close", () => {
  try {
    hash.on("data", () => {});
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
  console.log("digest", hash.digest("hex").slice(0, 8));
});
hash.end("abc");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Error SC2020 Stream use of a Hash or Hmac after its stream closed has no lowering\n" +
        "digest ba7816bf\n",
    );
    expect(r.stderr).toBe("");
  });
});

// A Hash or Hmac held in an 'unknown' slot answers update(), digest() and
// Hash's copy(). Its other members throw a coded SC2020 error, and so do
// those methods called with another receiver.
describe("Hash and Hmac members through 'unknown'", () => {
  test("throw SC2020 other than update, digest and copy", async () => {
    const r = await compileAndRun(
      "hash-unknown-members",
      `const crypto = require("node:crypto");
function attempt(value, run) {
  try {
    run(value);
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}
const hash = [crypto.createHash("sha256")][0];
attempt(hash, (h) => h.on("data", () => {}));
attempt(hash, (h) => h.readable);
attempt([crypto.createHmac("sha256", "k")][0], (m) => m.write("x"));
attempt(hash, (h) => h.digest.call({}));
console.log(hash.update("abc").digest("hex").slice(0, 8));
`,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Error SC2020 Hash members other than update(), digest() and copy() have no lowering on an 'unknown' value; cast the value to Hash first\n".repeat(
        2,
      ) +
        "Error SC2020 Hmac members other than update() and digest() have no lowering on an 'unknown' value; cast the value to Hmac first\n" +
        "Error SC2020 Hash and Hmac methods called with a receiver other than their own Hash or Hmac have no lowering\n" +
        "ba7816bf\n",
    );
    expect(r.stderr).toBe("");
  });
});

// Node 24.22 skips the chacha20-poly1305 tag check when neither
// setAuthTag() nor authTagLength was used, and returns unverified
// plaintext. scriptc keeps Node 24.15's behavior: final() fails.
describe("chacha20-poly1305 decryption without a tag", () => {
  test("final() fails instead of returning unverified plaintext", async () => {
    const r = await compileAndRun(
      "cipher-chacha-no-tag",
      `import { createCipheriv, createDecipheriv } from "node:crypto";
const key = Buffer.alloc(32, 1);
const iv = Buffer.alloc(12, 2);
const cipher = createCipheriv("chacha20-poly1305", key, iv);
const ciphertext = Buffer.concat([cipher.update("secret"), cipher.final()]);
for (const input of [ciphertext, Buffer.from("forged data"), Buffer.alloc(0)]) {
  const decipher = createDecipheriv("chacha20-poly1305", key, iv);
  const text = decipher.update(input);
  try {
    decipher.final();
    console.log("accepted", text.toString("hex"));
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(e.name, e.code, e.message);
  }
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Error undefined Unsupported state or unable to authenticate data\n".repeat(3),
    );
    expect(r.stderr).toBe("");
  });
});

// Function expressions the frontend lowers speculatively (the receiver of
// `.call`/`.apply`, a computed class base) keep their refused statements as
// runtime fences. They used to vanish: the capture buffer held the refusal,
// the candidate was kept, and the statement was simply missing from it.
describe("refused statements in speculatively lowered JavaScript functions", () => {
  test.each([
    [
      "speculative-call-this",
      `(function () {
  var root = this;
  console.log("before");
  process.on("__proto__", () => root);
  console.log("after");
}).call(this);
`,
      "before\n",
      4,
    ],
    [
      "speculative-apply",
      `(function () {
  console.log("before");
  process.on("__proto__", () => {});
}).apply(null, []);
`,
      "before\n",
      3,
    ],
    [
      "speculative-class-base",
      `class Base {}
class Derived extends (function () {
  console.log("before");
  process.on("__proto__", () => {});
  return Base;
})() {}
console.log(typeof Derived);
`,
      "before\n",
      4,
    ],
  ] as const)("%s", async (name, source, stdout, line) => {
    const r = await compileAndRun(name, source, "cjs");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe(stdout);
    expect(r.stderr).toMatch(
      new RegExp(
        `^Uncaught Error: 'process\\.on\\("__proto__", \\.\\.\\.\\)' is part of the standard library types but has no scriptc lowering yet \\[SC2020 at .*${name}\\.cjs:${line}\\]\\n$`,
      ),
    );
  });
});

describe("constructors returning objects (JS lane)", () => {
  test("a returned plain object is a named deferred fence", async () => {
    // Node's `new Box(2)` answers `{ size: 99 }`; a Box instance cannot
    // hold that object, so the return refuses instead of answering `this`.
    const r = await compileAndRun(
      "constructor-returns-object",
      `'use strict';
class Box {
  constructor(size) {
    this.size = size;
    if (size > 1) return { size: 99 };
  }
}
console.log(new Box(1).size);
console.log(new Box(2));
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("1\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: returning an object other than an instance of the class from a constructor \(Node's 'new Box\(\)' answers the returned object, .*\) is not supported yet \[SC1090 at .*constructor-returns-object\.cjs:5\]\n$/,
    );
  });

  test("an untyped returned value fences only when it holds a foreign object", async () => {
    // Primitive results answer the constructed instance, as in Node; an
    // object that is not a Wrap instance refuses.
    const r = await compileAndRun(
      "constructor-returns-untyped",
      `'use strict';
class Wrap {
  constructor(value) {
    this.value = value;
    return value;
  }
}
console.log(new Wrap(1).value, new Wrap('s').value, new Wrap(null).value);
const w = new Wrap(0);
console.log(new Wrap(w) === w);
console.log(new Wrap({ a: 1 }));
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("1 s null\ntrue\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: returning an object other than an instance of the class from a constructor .* is not supported yet \[SC1090 at .*constructor-returns-untyped\.cjs:5\]\n$/,
    );
  });
});

describe("module exports that read this, called through the module binding (JS lane)", () => {
  test("a require binding's member call is a named deferred fence", async () => {
    // Node passes the exports object as `this` to `m.hello()`; the direct
    // call has none to pass, so it refuses instead of reading another one.
    const r = await compileAndRun(
      "require-member-this",
      `'use strict';
const m = require('./lib.cjs');
console.log(m.plain(21));
console.log(m.hello());
`,
      "cjs",
      {
        "lib.cjs": `'use strict';
exports.name = 'lib';
exports.hello = function () { return 'hi from ' + this.name; };
exports.plain = function (x) { return x * 2; };
`,
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("42\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: calling a module export that reads 'this' through its module binding \('hello': .*\) is not supported yet \[SC1090 at .*require-member-this\.cjs:4\]\n$/,
    );
  });

  test("a namespace import's member call is a named deferred fence", async () => {
    const r = await compileAndRun(
      "namespace-member-this",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.who());
`,
      "mjs",
      {
        "lib.mjs": `export function who() { return typeof this; }
export function plain(x) { return x + 1; }
`,
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("2\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: calling a module export that reads 'this' through its module binding \('who': .*\) is not supported yet \[SC1090 at .*namespace-member-this\.mjs:3\]\n$/,
    );
  });

  test("a namespace import's export that passes this on with apply or call compiles", async () => {
    // Effect 4's provideService: `dual(...).apply(this, arguments)` hands the
    // receiver to a function that `dual` returns, which reads it only to
    // pass it on to an arrow, as here.
    const r = await compileAndRun(
      "namespace-member-forwards-this",
      `import * as ns from './lib.mjs';
export const added = ns.provide(1, 2, 3);
console.log(added, ns.sum(3, 4));
`,
      "mjs",
      {
        "lib.mjs": `const dual = function (arity, body) {
  switch (arity) {
    case 2:
      return function (a, b) { return arguments.length >= 2 ? body(a, b) : (self) => body(self, a); };
    default:
      return function () { return body.apply(this, arguments); };
  }
};
export const provide = function () { return dual(3, (a, b, c) => a + b + c).apply(this, arguments); };
const twice = function (a, b) { return (a + b) * 2; };
export const sum = function (a, b) { return twice.call(this, a, b); };
`,
      },
    );
    expect(r).toEqual({ stdout: "6 14\n", stderr: "", exitCode: 0 });
  });

  test("a require binding's export that passes this on with apply compiles", async () => {
    const r = await compileAndRun(
      "require-member-forwards-this",
      `'use strict';
const m = require('./lib.cjs');
console.log(m.scale(5));
`,
      "cjs",
      {
        "lib.cjs": `'use strict';
const triple = function (x) { return x * 3; };
exports.scale = function () { return triple.apply(this, arguments); };
`,
      },
    );
    expect(r).toEqual({ stdout: "15\n", stderr: "", exitCode: 0 });
  });

  test.each([
    [
      "a namespace import's export that passes this on to a function that reads it",
      "namespace-member-forwards-to-reader",
      "mjs",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.viaCall('?'));
`,
      {
        "lib.mjs": `export const tag = 'ns';
function read(suffix) { return this.tag + suffix; }
export function viaCall(suffix) { return read.call(this, suffix); }
export function plain(x) { return x + 1; }
`,
      },
      "2\n",
      "viaCall",
      3,
    ],
    [
      "a namespace import's export that passes this on through a factory to a function that reads it",
      "namespace-member-forwards-through-factory",
      "mjs",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.viaDual('?'));
`,
      {
        "lib.mjs": `export const tag = 'ns';
const dual = function (arity, body) {
  switch (arity) {
    case 2:
      return function (a, b) { return arguments.length >= 2 ? body(a, b) : (self) => body(self, a); };
    default:
      return function () { return body.apply(this, arguments); };
  }
};
export const viaDual = function () { return dual(9, function (s) { return this.tag + s; }).apply(this, arguments); };
export function plain(x) { return x + 1; }
`,
      },
      "2\n",
      "viaDual",
      3,
    ],
    [
      "a namespace import's export that passes this on through a factory that reassigns its parameter",
      "namespace-member-forwards-reassigned",
      "mjs",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.viaWrap('?'));
`,
      {
        "lib.mjs": `export const tag = 'ns';
const wrap = function (body) {
  body = function (s) { return this.tag + s; };
  return function () { return body.apply(this, arguments); };
};
export const viaWrap = function () { return wrap((s) => s).apply(this, arguments); };
export function plain(x) { return x + 1; }
`,
      },
      "2\n",
      "viaWrap",
      3,
    ],
    [
      "a namespace import's export that passes this on through a factory that replaces its parameter as a destructuring",
      "namespace-member-forwards-destructured",
      "mjs",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.viaWrap('?'));
`,
      {
        "lib.mjs": `export const tag = 'ns';
const wrap = function (body) {
  [body] = [function (s) { return this.tag + s; }];
  return function () { return body.apply(this, arguments); };
};
export const viaWrap = function () { return wrap((s) => s).apply(this, arguments); };
export function plain(x) { return x + 1; }
`,
      },
      "2\n",
      "viaWrap",
      3,
    ],
    [
      "a namespace import's export that passes this on through a factory that replaces its parameter as a object destructuring",
      "namespace-member-forwards-object-destructured",
      "mjs",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.viaWrap('?'));
`,
      {
        "lib.mjs": `export const tag = 'ns';
const wrap = function (body) {
  ({ body } = { body: function (s) { return this.tag + s; } });
  return function () { return body.apply(this, arguments); };
};
export const viaWrap = function () { return wrap((s) => s).apply(this, arguments); };
export function plain(x) { return x + 1; }
`,
      },
      "2\n",
      "viaWrap",
      3,
    ],
    [
      "a namespace import's export that passes this on through a factory that replaces its parameter as a for-of target",
      "namespace-member-forwards-for-of",
      "mjs",
      `import * as ns from './lib.mjs';
console.log(ns.plain(1));
console.log(ns.viaWrap('?'));
`,
      {
        "lib.mjs": `export const tag = 'ns';
const wrap = function (body) {
  for (body of [function (s) { return this.tag + s; }]);
  return function () { return body.apply(this, arguments); };
};
export const viaWrap = function () { return wrap((s) => s).apply(this, arguments); };
export function plain(x) { return x + 1; }
`,
      },
      "2\n",
      "viaWrap",
      3,
    ],
    [
      "a require binding's export that passes this on to a function that reads it",
      "require-member-forwards-to-reader",
      "cjs",
      `'use strict';
const m = require('./lib.cjs');
console.log(m.plain(21));
console.log(m.viaApply('!'));
`,
      {
        "lib.cjs": `'use strict';
exports.name = 'lib';
const read = function (suffix) { return this.name + suffix; };
exports.viaApply = function () { return read.apply(this, arguments); };
exports.plain = function (x) { return x * 2; };
`,
      },
      "42\n",
      "viaApply",
      4,
    ],
  ] as const)(
    "%s is a named deferred fence",
    async (_, name, ext, source, files, stdout, member, line) => {
      // Node passes the module object on to `read`, which reads it; the
      // direct call has none to pass.
      const r = await compileAndRun(name, source, ext, files);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe(stdout);
      expect(r.stderr).toMatch(
        new RegExp(
          `^Uncaught Error: calling a module export that reads 'this' through its module binding \\('${member}': .*\\) is not supported yet \\[SC1090 at .*${name}\\.${ext}:${line}\\]\\n$`,
        ),
      );
    },
  );

  test("an export that also reads this beside passing it on is a named deferred fence", async () => {
    const r = await compileAndRun(
      "namespace-member-forwards-and-reads-this",
      `import * as ns from './lib.mjs';
console.log(ns.tag('x'));
`,
      "mjs",
      {
        "lib.mjs": `const join = function (a, b) { return a + ':' + b; };
export function tag(x) { return join.call(this, x, typeof this); }
`,
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: calling a module export that reads 'this' through its module binding \('tag': .*\) is not supported yet \[SC1090 at .*namespace-member-forwards-and-reads-this\.mjs:2\]\n$/,
    );
  });
});

// CommonJS forms around the module's exports that keep a refusal name the
// construct itself (they used to report an unlowerable `require` value, a
// "binding form with no lowering", or the ES-module `module` message).
describe("CommonJS export-object and inline require refusals", () => {
  test.each([
    [
      "exports-as-argument",
      `exports.x = 1;
function keys(o) {
  return Object.keys(o);
}
console.log("before");
console.log(keys(exports));
`,
      {},
      "before\n",
      6,
      "'exports' as a value other than a member access, comparison, typeof or truthiness test \\(the compiled exports are a static table, not an object: read exports\\.<name>\\)",
    ],
    [
      "exports-rebinding",
      `console.log("before");
exports = function hash(x) {
  return x;
};
exports.extra = 1;
`,
      {},
      "before\n",
      2,
      "rebinding 'exports' without module\\.exports \\(exports = value\\)",
    ],
    [
      "require-computed",
      `const name = "./lib.cjs";
console.log("before");
console.log(require(name).x);
`,
      { "lib.cjs": "exports.x = 1;\n" },
      "before\n",
      3,
      "require\\(\\) with a computed specifier",
    ],
    [
      "exports-call-reads-this",
      `exports.timeouts = function (n) {
  return this.scale * n;
};
exports.scale = 2;
console.log("before");
console.log(exports.timeouts(3));
`,
      {},
      "before\n",
      6,
      "calling 'exports\\.timeouts' through the module's exports object when the function may read 'this'",
    ],
    [
      "require-table-as-value",
      `function count(o) {
  return Object.keys(o).length;
}
console.log("before");
console.log(count(require("./lib.cjs")));
`,
      { "lib.cjs": "exports.x = 1;\n" },
      "before\n",
      5,
      "the exports object of '\\./lib\\.cjs' as a value",
    ],
  ] as const)("%s", async (name, source, extra, stdout, line, message) => {
    const r = await compileAndRun(name, source, "cjs", extra);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe(stdout);
    expect(r.stderr).toMatch(
      new RegExp(`^Uncaught Error: ${message}.*\\[SC1090 at .*${name}\\.cjs:${line}\\]\\n$`),
    );
  });
});

describe("builtin constructor values (JS lane)", () => {
  test("members without a lowering stay refused instead of reading undefined", async () => {
    // Builtin constructors read as interned function values that model only
    // name, length and constructor. Every other static member or prototype
    // read (direct, bracketed, through an alias or globalThis), and
    // reflection on or redefinition of their members, must stay a located
    // SC2020/SC1090 refusal, never an undefined or otherwise wrong value.
    // `key in Ctor` answers from the constructor's fixed keys.
    // Test262 lost 769 refusals to undefined reads before this was pinned.
    const reads = [
      ["Map.prototype", "Map.prototype"],
      ["Date.prototype", "Date.prototype"],
      ["RegExp.prototype", "RegExp.prototype"],
      ["Set.prototype", "Set.prototype"],
      ["WeakMap.prototype", "WeakMap.prototype"],
      ["WeakSet.prototype", "WeakSet.prototype"],
      ["Date.prototype.getYear", "Date.prototype.getYear"],
      ["Map.prototype.constructor", "Map.prototype.constructor"],
      ["Object.isFrozen", "Object.isFrozen"],
      [
        "getOwnPropertyDescriptor(Map.prototype)",
        'Object.getOwnPropertyDescriptor(Map.prototype, "size")',
      ],
      ["isExtensible(Date.prototype)", "Object.isExtensible(Date.prototype)"],
      ["Map['prototype']", 'Map["prototype"]'],
      ["globalThis.Map.prototype", "globalThis.Map.prototype"],
      ["Map alias prototype", "MapAlias.prototype"],
      ["Date alias prototype", "DateAlias.prototype"],
      ["Object alias isFrozen", "ObjectAlias.isFrozen"],
      ["Object.hasOwn(Object)", 'Object.hasOwn(Object, "hasOwn")'],
      ["getOwnPropertyNames(Date)", "Object.getOwnPropertyNames(Date)"],
      ["defineProperty(Promise)", 'Object.defineProperty(Promise, "resolve", { value: 1 })'],
      ["hasOwnProperty.call(Map)", 'Object.prototype.hasOwnProperty.call(Map, "groupBy")'],
    ] as const;
    const source = `"use strict";
const MapAlias = Map;
const DateAlias = Date;
const { Object: ObjectAlias } = globalThis;
function report(label, e) {
  const m = /\\[(SC\\d{4}) at [^\\]]*:(\\d+)\\]$/.exec(e.message);
  console.log(label, m ? "refused " + m[1] + " line " + m[2] : "threw " + e.message);
}
${reads.map(([label, read]) => `try { const value = ${read}; console.log(${JSON.stringify(label)}, "read", typeof value); } catch (e) { report(${JSON.stringify(label)}, e); }`).join("\n")}
console.log(Date.length, RegExp.length, Promise.length, Object.length, Map.length, Set.length);
console.log(Date.name, Map.name, Map.constructor === Function, Object.constructor === Function);
const promisePrototype = Promise.prototype;
console.log(typeof promisePrototype, typeof promisePrototype.then, promisePrototype.constructor === Promise);
console.log("prototype" in Map, "groupBy" in Map, "captureStackTrace" in Error, "nope" in Map);
`;
    const r = await compileAndRun("builtin-constructor-members", source, "cjs");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.slice(0, reads.length)).toEqual(
      reads.map(([label], i) =>
        expect.stringMatching(
          new RegExp(
            `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} refused SC(2020|1090) line ${i + 9}$`,
          ),
        ),
      ),
    );
    // Promise.prototype reads as an object holding the runtime's methods,
    // and `in` on a builtin constructor answers from its fixed keys.
    expect(lines.slice(reads.length)).toEqual([
      "7 2 1 1 0 0",
      "Date Map true true",
      "object function true",
      "true true true false",
    ]);
  });
});

// WebCrypto's native slice is crypto.subtle's secret-key methods and its
// ECDSA, Ed25519 and RSA algorithms. Algorithms Node recognizes outside
// that slice reject with a coded SC2020
// Error instead of a Node-shaped success, and a JavaScript call of a
// method outside it meets its named fence when it runs.
// Node's own rejections (unknown names, bad usages) are corpus-pinned
// (6292, 6294); these refusals have no Node twin, so they live here.
describe("WebCrypto refusals (JS lane)", () => {
  test("recognized algorithms outside the lowered ones reject with SC2020", async () => {
    const r = await compileAndRun(
      "webcrypto-unsupported-algorithms",
      `const bytes = new TextEncoder().encode("secret");
async function attempt(label, run) {
  try {
    await run();
    console.log(label, "resolved");
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}
const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
await attempt("ed448", () => crypto.subtle.sign({ name: "Ed448" }, key, bytes));
await attempt("ecdsa with an hmac key", () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes));
await attempt("sha3", () => crypto.subtle.digest("SHA3-256", bytes));
await attempt("sha3 hmac", () =>
  crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA3-256" }, false, ["sign"]),
);
const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt"]);
await attempt("aes-ocb", () => crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(12) }, aes, bytes));
await attempt("ecdh bits", () => crypto.subtle.deriveBits({ name: "ECDH" }, key, 256));
await attempt("rsa-oaep wrap", () => crypto.subtle.wrapKey("raw", key, key, { name: "RSA-OAEP" }));
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const kw = await crypto.subtle.generateKey({ name: "AES-KW", length: 128 }, false, ["wrapKey", "unwrapKey"]);
await attempt("wrap an ecdsa key", () => crypto.subtle.wrapKey("spki", pair.publicKey, kw, "AES-KW"));
await attempt("wrap with an ecdsa key", () => crypto.subtle.wrapKey("raw", aes, pair.privateKey, "AES-KW"));
await attempt("unwrap an ecdsa key", () =>
  crypto.subtle.unwrapKey("spki", new Uint8Array(24), kw, "AES-KW", { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]),
);
`,
      "mjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "ed448 Error SC2020 crypto.subtle.sign with the Ed448 algorithm is not supported yet\n" +
        "ecdsa with an hmac key InvalidAccessError 15 Key algorithm mismatch\n" +
        "sha3 Error SC2020 crypto.subtle.digest with the SHA3-256 algorithm is not supported yet\n" +
        "sha3 hmac Error SC2020 crypto.subtle.importKey with the SHA3-256 algorithm is not supported yet\n" +
        "aes-ocb Error SC2020 crypto.subtle.encrypt with the AES-OCB algorithm is not supported yet\n" +
        "ecdh bits Error SC2020 crypto.subtle.deriveBits with the ECDH algorithm is not supported yet\n" +
        "rsa-oaep wrap Error SC2020 crypto.subtle.wrapKey with the RSA-OAEP algorithm is not supported yet\n" +
        "wrap an ecdsa key Error SC2020 crypto.subtle.wrapKey with an ECDSA, Ed25519 or RSA key is not supported yet\n" +
        "wrap with an ecdsa key InvalidAccessError 15 Key algorithm mismatch\n" +
        "unwrap an ecdsa key Error SC2020 crypto.subtle.unwrapKey with the ECDSA algorithm is not supported yet\n",
    );
  });

  test("a method outside the slice is a named fence where it runs", async () => {
    const r = await compileAndRun(
      "webcrypto-get-public-key",
      `console.log("before");
const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
await crypto.subtle.getPublicKey(key, ["verify"]);
`,
      "mjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: 'crypto\.subtle\.getPublicKey' is part of the standard library types but has no scriptc lowering yet.*\n$/,
    );
  });
});

// The Ed25519 arithmetic (scr_ed25519.c) links only into programs whose
// string literals name Ed25519. Without it, an Ed25519 public key still
// imports and exports, while private-key parsing, signing and verification
// reject with a coded SC2020 Error where Node answers; there is no Node
// twin, so this lives here. The corpus (7080, 7081) pins the linked path.
describe("Ed25519 without the Ed25519 unit (JS lane)", () => {
  test("a program that never names Ed25519 refuses its arithmetic with SC2020", async () => {
    const r = await compileAndRun(
      "ed25519-unit-not-linked",
      `import * as c from "node:crypto";
const spki = Buffer.from("302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const pkcs8 = Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const pub = c.createPublicKey({ key: spki, format: "der", type: "spki" });
console.log(pub.asymmetricKeyType, pub.export({ format: "jwk" }).x);
async function attempt(label, run) {
  try {
    await run();
    console.log(label, "resolved");
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}
await attempt("pkcs8", () => c.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
await attempt("verify", () => c.verify(null, Buffer.from("x"), pub, Buffer.alloc(64)));
// ECDSA links the WebCrypto key unit; the Ed25519 name is built at run time.
const ecdsa = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
console.log(ecdsa.privateKey.type);
const name = ["Ed", "25519"].join("");
await attempt("generateKey", () => crypto.subtle.generateKey(name, false, ["sign", "verify"]));
await attempt("importKey", () => crypto.subtle.importKey("pkcs8", pkcs8, name, false, ["sign"]));
const raw = await crypto.subtle.importKey("raw", spki.subarray(12), name, false, ["verify"]);
await attempt("subtle verify", () => crypto.subtle.verify(name, raw, new Uint8Array(64), new Uint8Array(1)));
`,
      "mjs",
    );
    const refusal =
      "Error SC2020 Ed25519 keys are supported when a string literal in the program names 'ed25519'";
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "ed25519 11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo\n" +
        `pkcs8 ${refusal}\n` +
        `verify ${refusal}\n` +
        "private\n" +
        `generateKey ${refusal}\n` +
        `importKey ${refusal}\n` +
        `subtle verify ${refusal}\n`,
    );
  });
});

// An X509Certificate's Ed25519 key needs the same unit: without it the
// certificate's public key, issuer and names still read, while verify
// rejects with the coded SC2020 Error. 7091 pins the linked path.
describe("X509Certificate Ed25519 keys without the Ed25519 unit", () => {
  test("verify refuses with SC2020 in a program that never names Ed25519", async () => {
    const r = await compileAndRun(
      "x509-ed25519-unit-not-linked",
      `import { X509Certificate } from "node:crypto";
const cert = new X509Certificate("-----BEGIN CERTIFICATE-----\\nMIIBljCCAUigAwIBAgIUNFuRt3zKS19UAUMdLWewqHrGBigwBQYDK2VwMC8xFDAS\\nBgNVBAoMC0V4YW1wbGUgT3JnMRcwFQYDVQQDDA5lZC5leGFtcGxlLm5ldDAgFw0y\\nNjEwMjIxMDEwMTJaGA8yMTI2MDkyODEwMTAxMlowLzEUMBIGA1UECgwLRXhhbXBs\\nZSBPcmcxFzAVBgNVBAMMDmVkLmV4YW1wbGUubmV0MCowBQYDK2VwAyEAOCSLKkel\\nkOH/5aqUwI3PNJVUUNyhgu2s19LFC254fNCjdDByMB0GA1UdDgQWBBR+50zUcqL8\\n739jh6/rEYojULDmlTAfBgNVHSMEGDAWgBR+50zUcqL8739jh6/rEYojULDmlTAP\\nBgNVHRMBAf8EBTADAQH/MB8GA1UdEQQYMBaCDmVkLmV4YW1wbGUubmV0hwTAAAIH\\nMAUGAytlcANBAC/c0Bi0SVUnHCg/1pn7MaCgVivSHuoISi2SCq/0EnLefRdgsIir\\n0QxjVnxeuKN2Y1yfEO/R1W8Nwovo1l2M1gQ=\\n-----END CERTIFICATE-----\\n");
console.log(cert.publicKey.asymmetricKeyType?.length, cert.checkIssued(cert), cert.checkHost("ed.example.net"));
try {
  console.log(cert.verify(cert.publicKey));
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.name, err.code, err.message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "7 true ed.example.net\n" +
        "Error SC2020 Ed25519 keys are supported when a string literal in the program names 'ed25519'\n",
    );
  });
});

// A TLS socket held in an untyped JavaScript value has no lowering for its
// certificate accessors (they link the X.509 unit, which a dynamic call
// cannot ask for), so the call throws the fence; a socket whose type is
// known runs them (corpus 7095, 7096).
describe("tlsSocket.getPeerCertificate on a dynamic value (JS lane)", () => {
  test("throws the fence", async () => {
    const r = await compileAndRun(
      "tls-peer-certificate-dynamic",
      `import * as tls from "node:tls";
import { readFileSync } from "node:fs";
const certs = "tests/fixtures/server/certs";
const server = tls.createServer({ cert: readFileSync(\`\${certs}/localhost.pem\`), key: readFileSync(\`\${certs}/localhost-key.pem\`) }, (s) => s.end());
function peer(socket) {
  try {
    return socket.getPeerCertificate().subject.CN;
  } catch (e) {
    return e.message;
  }
}
server.listen(0, () => {
  const c = tls.connect({ port: server.address().port, ca: readFileSync(\`\${certs}/ca.pem\`), servername: "localhost" }, () => {
    console.log(peer(c));
    c.destroy();
    server.close();
  });
});
`,
      "mjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "'TLSSocket.prototype.getPeerCertificate' on a dynamic value is not supported yet\n",
    );
  });
});

describe("inspecting error subclasses with properties created at run time (JS lane)", () => {
  test("an instance whose constructor created a property is a named fence", async () => {
    // Node prints `[Conditional [Error]: m] { extra: 'x' }`. The property
    // lives in the instance's property bag, which the error rendering does
    // not read, so the instance refuses instead of printing a partial
    // object. One without such a property prints as Node prints it.
    const r = await compileAndRun(
      "error-subclass-runtime-properties",
      `import * as util from "node:util";
class Conditional extends Error {
  constructor(message, extra) {
    super(message);
    if (extra) this.extra = extra;
  }
}
const plain = new Conditional("plain");
plain.stack = "";
console.log(util.inspect(plain));
const extra = new Conditional("extra", "x");
extra.stack = "";
console.log(util.inspect(extra));
`,
      "mjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("[Conditional [Error]: plain]\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: inspecting a 'Conditional' error with properties created at run time is not supported yet \[SC2020[^\]]*\]\n$/,
    );
  });
});

describe("elements on Array.prototype", () => {
  // Holes of native arrays read undefined without consulting
  // Array.prototype, so storing an element there refuses instead of
  // letting later hole reads diverge from Node. Named members stay
  // writable.
  test("an index write is a named fence (TS lane)", async () => {
    const r = await compileAndRun(
      "array-prototype-element-ts",
      `const proto = Array.prototype as unknown as Record<string, unknown>;
proto.label = "named";
console.log(proto.label);
(Array.prototype as unknown as Record<number, unknown>)[1] = "proto";
console.log("unreachable");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("named\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: Elements on Array\.prototype are not supported yet \[SC2020[^\]]*\]\n$/,
    );
  });

  test("an index write and a mutating method are named fences (JS lane)", async () => {
    const write = await compileAndRun(
      "array-prototype-element-js",
      `Array.prototype[0] = "proto";
console.log("unreachable");
`,
      "cjs",
    );
    expect(write.exitCode).toBe(1);
    expect(write.stdout).toBe("");
    expect(write.stderr).toMatch(
      /^Uncaught Error: Elements on Array\.prototype are not supported yet \[SC2020[^\]]*\]\n$/,
    );
    const push = await compileAndRun(
      "array-prototype-push-js",
      `Array.prototype.push("proto");
console.log("unreachable");
`,
      "cjs",
    );
    expect(push.exitCode).toBe(1);
    expect(push.stdout).toBe("");
    expect(push.stderr).toMatch(
      /^Uncaught Error: Elements on Array\.prototype are not supported yet \[SC2020[^\]]*\]\n$/,
    );
  });
});

describe("numeric properties of native arrays", () => {
  // A native array keeps its numeric properties ("-1", "1.5") in a property
  // table that holds values without attributes, so defining one with a
  // descriptor refuses instead of dropping the attributes.
  test("Object.defineProperty on a numeric key is a named fence", async () => {
    const r = await compileAndRun(
      "array-numeric-define-property",
      `const words: string[] = ["a"];
words[-1] = "x";
console.log(words[-1]);
Object.defineProperty(words as unknown as Record<string, unknown>, "-3", { value: "kept" });
console.log("unreachable");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("x\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: Object\.defineProperty on a numeric property of a native array is not supported yet\n$/,
    );
  });

  test("a number key that is not an array index takes the same fence", async () => {
    const r = await compileAndRun(
      "array-numeric-define-property-number",
      `const words: string[] = ["a"];
for (const key of [-3, 1.5]) {
  try {
    Object.defineProperty(words as unknown as Record<number, unknown>, key, { value: "kept" });
  } catch (e) {
    console.log((e as Error).message);
  }
}
console.log(words.length);
`,
    );
    const fence =
      "Object.defineProperty on a numeric property of a native array is not supported yet\n";
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${fence}${fence}1\n`);
  });
});

// The Buffer function read as a value models Node's statics; the forms it
// cannot answer as Node does throw SC2020: calling or constructing it
// through the value (Node reports DEP0005 by the caller's location), its
// prototype as a whole, copyBytesFrom and of, and Buffer.prototype members
// that are inherited, symbol-keyed or called on other receivers.
describe("Buffer value refusals", () => {
  test("unmodeled Buffer value forms throw SC2020", async () => {
    const r = await compileAndRun(
      "buffer-value-refusals",
      `const pass = (value) => value;
const Stored = pass(require("buffer").Buffer);
const runs = [
  () => Stored("x"),
  () => new Stored(2),
  () => Stored.prototype,
  () => Stored.copyBytesFrom(new Uint8Array(2)),
  () => Stored.of(1),
  () => Buffer.prototype.map,
  () => Buffer.prototype[Symbol.iterator],
  () => Buffer.prototype.readUInt8.call(new Uint8Array(2), 0),
];
for (const run of runs) {
  try {
    run();
    console.log("ran");
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}
`,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "Error SC2020 Calling or constructing Buffer through a stored Buffer value is not supported yet",
        "Error SC2020 Calling or constructing Buffer through a stored Buffer value is not supported yet",
        "Error SC2020 Buffer.prototype through a stored Buffer value is not supported yet",
        "Error SC2020 Buffer.copyBytesFrom through a stored Buffer value is not supported yet",
        "Error SC2020 Buffer.of through a stored Buffer value is not supported yet",
        "Error SC2020 Buffer.prototype.map is not supported yet",
        "Error SC2020 Buffer.prototype members keyed by symbols are not supported yet",
        "Error SC2020 Buffer.prototype.readUInt8 on a receiver that is not a Buffer is not supported yet",
        "",
      ].join("\n"),
    );
  });
});
