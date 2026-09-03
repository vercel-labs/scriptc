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
  // `// @dynamic` on the entry's FIRST line embeds the island engine —
  // for runtime-fence shapes only mixed dynamic graphs can spell (the
  // diagnostics suite's directive, applied to the run-and-observe lane).
  const dynamic = /^\/\/ @dynamic\s*$/.test(source.split("\n", 1)[0] ?? "");
  // Pinned: the uncaught-STDERR line shape (SEMANTICS.md divergence 11) is
  // pinned against the C reference; the LLVM lane's uncaught epilogue is
  // llvm-differential's parity job, not this suite's.
  const result = await compile(file, { outPath: join(outDir, name), outDir, sanitize, backend: "c", dynamic });
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
    return { stdout: e.stdout ?? "", stderr: stripAsanFiberWarning(e.stderr ?? ""), exitCode: e.code };
  }
}

/** Linux ASan prints a once-per-process warning to stderr the first time a
 * fiber swapcontext()s (the interceptor has no off switch; Apple's ASan
 * never intercepts ucontext, so the macOS lanes never see it). Sanitizer
 * diagnostic noise, never program output — dropped before any stderr
 * expectation, the RC-audit-skip-notice pattern from differential.test.ts. */
function stripAsanFiberWarning(s: string): string {
  return s.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm, "");
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

  test("an EFFECTFUL surplus argument is a named deferred fence (JS lane)", async () => {
    // Effect-free surplus args drop at compile time, JS-exact (corpus
    // 1760 — the test-string-decoder writeSequences shape). An effectful
    // one has no evaluation slot in the completed call, so instead of
    // silently not running it the build defers a named SC1090 to the
    // call site. JS-only: tsc's arity errors gate the TS lane.
    const r = await compileAndRun(
      "surplus-args-effectful",
      `'use strict';
function two(a, b) {
  return a + b;
}
function loud() {
  console.log('side effect JS would run');
  return 0;
}
console.log(two(1, 2, loud()));
`,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: surplus arguments with side effects .* are not supported yet \[SC1090 at .*surplus-args-effectful\.cjs:9\]\n$/,
    );
  });

  test("Array.from fences an unsupported callback result before emission (JS lane)", async () => {
    // Callback-driven producers learn their result element from the
    // lowered callback, bypassing mapType's ordinary T[] gate. An empty
    // Set in JS maps to dyn here; the frontend must replace the statement
    // with the normal JS runtime fence, never send dyn[] to either emitter.
    const r = await compileAndRun(
      "array-from-length-elements",
      `const arr = Array.from({ length: 2 }, () => new Set());
console.log(arr.length);
`,
      "js",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /^Uncaught Error: 'Array\.from\(\{ length \}, mapper\)' with a callback returning 'unknown'-typed values .* \[SC1090 at .*array-from-length-elements\.js:1\]\n$/,
    );
  });

  test.each([
    {
      label: "flatMap",
      name: "flatmap-elements",
      producer: "'.flatMap()'",
      result: "'Set<number>' values \\(arrays of this element kind have no representation — store the values individually\\)",
      line: 1,
      source: `const arr = [1].flatMap(() => new Set([1]));
console.log(arr.length);
`,
    },
    {
      label: "tuple map",
      name: "tuple-map-elements",
      producer: "'.map()'",
      result: "'unknown'-typed values \\(the result array has no static element type — annotate the callback's return\\)",
      line: 3,
      source: `/** @type {[number]} */
const tuple = [1];
const arr = tuple.map(() => new Set());
console.log(arr.length);
`,
    },
  ])("$label fences an unsupported callback result before emission (JS lane)", async ({ name, producer, result, line, source }) => {
    // Both paths construct the ordinary map helper from the lowered
    // callback return type. They must share Array.from/.map's frontend
    // fence rather than leave the validator to report an internal error.
    const r = await compileAndRun(name, source, "js");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    const quotedProducer = producer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(r.stderr).toMatch(
      new RegExp(
        `^Uncaught Error: ${quotedProducer} with a callback returning ${result} are not supported yet \\[SC1090 at .*${name}\\.js:${line}\\]\\n$`,
      ),
    );
  });

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

  test("a REASSIGNED property-assigned class stays fenced, never a silently wrong base (JS lane)", async () => {
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
    expect(r.stderr).toMatch(/^Uncaught Error: .* \[SC1090 at .*extends-reassigned-property\.cjs:\d+\]\n$/);
  });

  test("a LEAF class whose collection fenced defers to its statement (JS lane)", async () => {
    // The JS deferral's leaf edge: a class nothing extends keeps the
    // runtime-fence story even when its shape has no lowering
    // (constructor-assigned field shadowing its own method) — the build
    // succeeds, statements before the class statement run, and the class
    // statement throws the recorded fence. Only the EXTENDS edge reports
    // at compile time (diagnostics js-extends-poisoned-base pins that).
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
    expect(r.stderr).toMatch(
      /^Uncaught Error: constructor-assigned fields shadowing methods are not supported yet \[SC1090 at .*leaf-shadowing-class-defers\.cjs:5\]\n$/,
    );
  });

  test("a DERIVED class of a clean base keeps the deferral when only the derived is poisoned (JS lane)", async () => {
    // The other side of the extends-edge rule: the derived class's OWN
    // fence (a constructor-assigned field shadowing an INHERITED method)
    // stays deferred — the base collected fine, so the eager
    // poisoned-base report has nothing to flush, and the derived class
    // statement is the runtime fence exactly like a leaf.
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
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toMatch(
      /^Uncaught Error: constructor-assigned fields shadowing methods are not supported yet \[SC1090 at .*derived-shadowing-class-defers\.cjs:11\]\n$/,
    );
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
    expect(r.stderr).toMatch(
      /^Uncaught Error: method calls like 'subtle\.digest' is not supported yet \[SC1090 at .*destructure-opaque-global\.cjs:4\]\n$/,
    );
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

  test("dynamic islands retain the native ESM link failure", async () => {
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

describe("checked-dynamic/island boundary fences (scriptc-only)", () => {
  test("an island-typed argument into a call through 'unknown' runs Node-exactly (the retired SC1101 fence)", async () => {
    // `this` in a plain JS function is the checked-dynamic ambient
    // receiver; a member CALL through it with an 'any'-typed argument
    // used to fence at compile (no jsval→dyn crossing existed — SEMANTICS
    // 383(d)'s "one unbridgeable mix"). The crossing exists now
    // (dynFromJsval, SEMANTICS 394): the argument wraps by reference, the
    // statement compiles for real, and the unbound-`this` member read
    // throws Node's OWN TypeError — the divergence this pin used to own
    // is retired.
    const r = await compileAndRun(
      "island-arg-dyn-call",
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
