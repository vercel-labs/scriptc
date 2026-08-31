/* Island engine behavior that is scriptc-only by nature — deliberately NOT
 * in the differential corpus:
 *
 * - Exception TEXT crossing the boundary: the bridge renders an island
 *   exception as String(e) ("TypeError: boom") and throws it as a catchable
 *   scriptc string. Node's engine (V8) words some messages differently, so
 *   message content is asserted here against OUR bridge, never against Node
 *   (island VALUE results stay differential — tests/corpus/1100..).
 * - Stack-overflow containment on fibers: async bodies run on ucontext
 *   fibers (256KB; 1MB under ASan — frames inflate); the island re-anchors
 *   the engine's stack check on every entry. Unbounded recursion in an
 *   island eval must surface as a catchable RangeError — a crash here
 *   means the re-anchor regressed.
 * - The static/dynamic fence: --dynamic must not change emitted C, and a
 *   static binary must stay in its size class (the ~620KB engine must never
 *   leak into default builds).
 *
 * SCRIPTC_SAN=1 builds the programs with ASan + the RC audit; the island's
 * counting allocator asserts zero live engine allocations at teardown.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const platformTest = process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ? test.skip : test;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BuildResult {
  binaryPath: string;
  cPath: string;
}

/** Compiles an inline program (island tests default to --dynamic). */
async function build(
  name: string,
  source: string,
  opts: { dynamic?: boolean; sanitize?: boolean } = {},
): Promise<BuildResult> {
  const dynamic = opts.dynamic ?? true;
  const san = opts.sanitize ?? sanitize;
  const key = createHash("sha256")
    .update(source)
    .update(san ? "san" : "plain")
    .update(dynamic ? "dyn" : "")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `island-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize: san,
    dynamic,
    // Pinned: the static/dynamic fence and the size classes below are
    // assertions ON the emitted C and the C-lane binary — this suite
    // measures the C backend's artifact by design.
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "island program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return { binaryPath: result.binaryPath, cPath: result.cPath };
}

/** Linux ASan prints a once-per-process warning to stderr the first time a
 * fiber swapcontext()s (the interceptor has no off switch; Apple's ASan
 * never intercepts ucontext, so the macOS lanes never see it). Sanitizer
 * diagnostic noise, never program output — dropped before any stderr
 * expectation, the RC-audit-skip-notice pattern from differential.test.ts. */
const stripAsanFiberWarning = (s: string): string =>
  s.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm, "");

/** build() + run, tolerating nonzero exit. */
async function compileAndRun(
  name: string,
  source: string,
  opts: { dynamic?: boolean } = {},
): Promise<RunResult> {
  const { binaryPath } = await build(name, source, opts);
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr: stripAsanFiberWarning(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: stripAsanFiberWarning(e.stderr ?? ""), exitCode: e.code };
  }
}

describe(`island engine (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("island throw is caught by static try/catch and execution recovers", async () => {
    const r = await compileAndRun(
      "catchable",
      `function attempt(code: string): string {
  try {
    return __island_eval(code);
  } catch {
    return "recovered";
  }
}
console.log(attempt("1 + 1"), attempt("throw new TypeError('boom')"), attempt("'still ok'"));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("2 recovered still ok\n");
    expect(r.stderr).toBe("");
  });

  test("uncaught island exception prints the bridge's String(e) message", async () => {
    const r = await compileAndRun(
      "uncaught",
      `console.log("before");
const x = __island_eval("(function () { throw new TypeError('boom') })()");
console.log("unreachable", x);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toContain("Uncaught TypeError: boom");
  });

  test("thrown non-Error island values stringify through the bridge", async () => {
    const r = await compileAndRun(
      "throw-value",
      `const x = __island_eval("throw 'plain string reason'");
console.log("unreachable", x);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught plain string reason");
  });

  test("island Error instances cross out as real error objects", async () => {
    // Engine Errors arrive as ScrError instances: the builtin vtable is
    // picked by NAME (instanceof TypeError narrows engine TypeErrors),
    // custom names ride an Error-rooted instance, and non-Error throws
    // keep the string payload — never wrongly an Error.
    const r = await compileAndRun(
      "error-crossing-out",
      `try {
  __island_eval("throw new TypeError('island boom')");
} catch (e) {
  if (e instanceof TypeError) {
    console.log("typed", e.name, e.message);
  }
}
try {
  __island_eval("class Weird extends Error { constructor(m) { super(m); this.name = 'Weird'; } } throw new Weird('custom')");
} catch (e) {
  if (e instanceof Error && !(e instanceof TypeError)) {
    console.log("custom", e.name, e.message, e.toString());
  }
}
try {
  __island_eval("throw 'plain reason'");
} catch (e) {
  if (typeof e === "string") console.log("string payload", e);
  if (e instanceof Error) console.log("wrongly an Error");
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "typed TypeError island boom\ncustom Weird custom Weird: custom\nstring payload plain reason\n",
    );
    expect(r.stderr).toBe("");
  });

  test("island syntax errors arrive as catchable errors, not crashes", async () => {
    const r = await compileAndRun(
      "syntax",
      `let ok = "no";
try {
  const x = __island_eval("this is ( not JS");
  console.log("unreachable", x);
} catch {
  ok = "caught";
}
console.log(ok);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("caught\n");
  });

  test("deep island recursion on a fiber is a catchable RangeError, not a crash", async () => {
    // Async bodies run on fixed-size ucontext fibers; without the
    // per-entry JS_UpdateStackTop re-anchor this SIGBUSes instead of
    // throwing.
    const r = await compileAndRun(
      "fiber-overflow",
      `async function deep(): Promise<string> {
  try {
    return __island_eval("function r(n) { return r(n + 1); } r(0)");
  } catch {
    return "caught overflow on fiber";
  }
}
async function main(): Promise<void> {
  console.log(await deep());
  console.log(__island_eval("'engine still ' + 'usable'"));
  console.log(await deep());
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "caught overflow on fiber\nengine still usable\ncaught overflow on fiber\n",
    );
    expect(r.stderr).toBe("");
  });

  test("overflow NAME is the engine's RangeError (island-side catch)", async () => {
    const r = await compileAndRun(
      "overflow-name",
      `async function name(): Promise<string> {
  return __island_eval("function r(n) { return r(n + 1); } try { r(0); 'no-overflow' } catch (e) { e.name }");
}
async function main(): Promise<void> {
  console.log(await name());
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("RangeError\n");
  });

  test("a never-observed island rejection reports at its checkpoint and exits 1", async () => {
    // The island's JS_SetHostPromiseRejectionTracker ledger joins the
    // static promise ledger's report — same line shape ("Unhandled promise
    // rejection: <String(reason)>", an Error reason rendering name:
    // message), same exit code 1. scriptc-only: Node's stderr for this
    // wears ERR_UNHANDLED_REJECTION clothing; the LINE is ours to pin.
    // The async main gives the program a loop turn (a program with no
    // async/timers/embedded modules never runs the loop, and its island
    // promise machinery is dormant anyway).
    const r = await compileAndRun(
      "island-unhandled-rejection",
      `async function main(): Promise<void> {
  console.log(__island_eval("Promise.reject(new TypeError('island boom')); 'armed'"));
}
main();
`,
    );
    expect(r.stdout).toBe("armed\n");
    expect(r.stderr).toBe("Unhandled promise rejection: TypeError: island boom\n");
    expect(r.exitCode).toBe(1);
  });

  test("a non-Error island rejection reason prints through String()", async () => {
    const r = await compileAndRun(
      "island-unhandled-primitive",
      `async function main(): Promise<void> {
  console.log(__island_eval("Promise.reject('plain reason'); 'armed'"));
}
main();
`,
    );
    expect(r.stdout).toBe("armed\n");
    expect(r.stderr).toBe("Unhandled promise rejection: plain reason\n");
    expect(r.exitCode).toBe(1);
  });

  test("an island rejection observed at rejection time never reports", async () => {
    const r = await compileAndRun(
      "island-rejection-observed",
      `async function main(): Promise<void> {
  console.log(__island_eval("Promise.reject(new Error('seen')).catch((e) => {}); 'ok'"));
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok\n");
    expect(r.stderr).toBe("");
  });

  test("an island rejection handled LATER is rescinded, not reported", async () => {
    // The tracker signals both directions: the rejection enters the ledger
    // when it happens, and attaching a handler afterwards (a later
    // microtask) removes it — Node's rejectionHandled rescission. The
    // second eval runs BEFORE the loop drains engine jobs, proving the
    // catch really attached later.
    const r = await compileAndRun(
      "island-rejection-rescinded",
      `async function main(): Promise<void> {
  console.log(
    __island_eval(
      "globalThis.p = Promise.reject(new Error('late catch'));" +
        "Promise.resolve().then(() => { globalThis.p.catch(() => { globalThis.caught = true; }); });" +
        "'armed'",
    ),
  );
  console.log(__island_eval("globalThis.caught === undefined ? 'not yet' : 'too early'"));
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("armed\nnot yet\n");
    expect(r.stderr).toBe("");
  });

  test("the static ledger keeps one voice when both worlds have survivors", async () => {
    // Only ONE line reports (the static ledger's), exit stays 1 — the
    // island ledger frees silently when the static side already spoke.
    const r = await compileAndRun(
      "island-and-static-rejections",
      `async function fail(): Promise<void> {
  throw new RangeError("static first");
}
fail();
console.log(__island_eval("Promise.reject(new TypeError('island second')); 'armed'"));
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("armed\n");
    expect(r.stderr).toBe("Unhandled promise rejection: RangeError: static first\n");
  });

  test("--dynamic does not change emitted C for island-free programs", async () => {
    const source = `function greet(who: string): string {
  return "hello " + who;
}
console.log(greet("world"), 6 * 7);
`;
    // Same program name in two cache dirs: the C is identical modulo the
    // hashed cache-dir path embedded in source-location comments.
    const [stat, dyn] = await Promise.all([
      build("same-c", source, { dynamic: false }),
      build("same-c", source, { dynamic: true }),
    ]);
    const body = (r: BuildResult) =>
      readFileSync(r.cPath, "utf8").replaceAll(dirname(r.cPath), "OUTDIR");
    expect(body(dyn)).toBe(body(stat));
  });

  platformTest("static hello-world stays in its size class; island use pays the engine", async () => {
    // The engine must NEVER leak into static builds: a default-built
    // hello-world stays in the platform's compact class, while entering an
    // island carries the embedded engine. An island-FREE --dynamic binary
    // stays small too because the linker dead-strips the unreferenced archive.
    // Measured on plain (non-ASan) builds in both lanes.
    const [stat, dyn] = await Promise.all([
      build("size-static", `console.log("hello", "world");\n`, {
        dynamic: false,
        sanitize: false,
      }),
      build("size-dynamic", `console.log(__island_eval("'hello ' + 'world'"));\n`, {
        dynamic: true,
        sanitize: false,
      }),
    ]);
    const staticSize = statSync(stat.binaryPath).size;
    const dynamicSize = statSync(dyn.binaryPath).size;
    // The class is toolchain-specific and page-granular. The canonical
    // Ubuntu 24.04/clang Sandbox measures 423,488 bytes after the sparse
    // UTF-16 string index added its always-linked cache/allocator path;
    // current Mach-O toolchains measure about 434KB. Each bound leaves
    // roughly one native page of growth while staying far below the >1MB
    // jump measured when the engine is linked.
    expect(staticSize).toBeLessThan(process.platform === "linux" ? 440_000 : 450_000);
    expect(dynamicSize).toBeGreaterThan(500_000);
  });

  /* ── the `any` boundary (validated exits) ─────────────────────────────
   * Node never checks an `as`, so LYING casts cannot be differential:
   * scriptc throws a catchable TypeError (the same trust-but-verify rule
   * as the dyn boundary — SEMANTICS.md documents both under the headline
   * divergence). Valid casts live in the corpus (760–764). */

  test("a lying primitive exit throws a catchable TypeError naming both types", async () => {
    const r = await compileAndRun(
      "any-lying-primitive",
      `const s: any = "abc";
try {
  const n = s as number;
  console.log("unreachable", n);
} catch {
  console.log("caught");
}
const direct = s as number;
console.log("unreachable", direct);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("caught\n");
    expect(r.stderr).toContain("TypeError: expected number, got string");
  });

  test("a composite exit inherits dynCheck's path-annotated failures", async () => {
    const r = await compileAndRun(
      "any-lying-record",
      `const o: any = { a: 1, b: 2 };
const r = o as { a: number; b: string };
console.log("unreachable", r.b);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("TypeError");
    expect(r.stderr).toContain("$.b"); // the dynCheck walker's path
  });

  test("an implicit exit at a typed slot validates exactly like an explicit cast", async () => {
    const r = await compileAndRun(
      "any-implicit-exit",
      `function takes(n: number): number {
  return n + 1;
}
const good: any = 41;
console.log(takes(good));
const bad: any = "not a number";
try {
  console.log(takes(bad));
} catch {
  console.log("implicit exit caught");
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("42\nimplicit exit caught\n");
  });

  test("island values survive the RC audit through churn and try/catch unwinds", async () => {
    const r = await compileAndRun(
      "any-churn-unwind",
      `let recovered = 0;
for (let i = 0; i < 300; i = i + 1) {
  const v: any = { n: i, s: \`x\${i}\` };
  try {
    const bad = v as { n: number; s: number }; // s is a string: throws
    console.log("unreachable", bad.n);
  } catch {
    recovered = recovered + 1;
  }
}
console.log(recovered);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("300\n");
    expect(r.stderr).toBe("");
  });

  /* ── the island-backed ambient surface (Math, methods, globals) ───────
   * Value results are differential (corpus 1110–1116); what lives here is
   * behavior Node cannot oracle: the `.at()` undefined-refusal divergence
   * and the fiber re-anchor for surface calls inside async bodies. */

  test("out-of-range .at() throws a catchable TypeError instead of returning undefined", async () => {
    // `at` is declared returning `string` (undefined is unrepresentable);
    // out of range the engine yields undefined and the validated exit
    // refuses it — strictly, catchably — where Node would hand back
    // undefined. The documented divergence, pinned.
    const r = await compileAndRun(
      "at-out-of-range",
      `const s = "abc";
try {
  console.log("in range", s.at(1), s.at(-1));
  const c = s.at(99);
  console.log("unreachable", c);
} catch {
  console.log("caught");
}
const direct = s.at(-4);
console.log("unreachable", direct);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("in range b c\ncaught\n");
    expect(r.stderr).toContain("TypeError: expected string, got undefined");
  });

  test("island-backed calls re-anchor the engine on fibers (Math after await)", async () => {
    const r = await compileAndRun(
      "math-on-fiber",
      `async function calc(n: number): Promise<number> {
  await new Promise<void>((resolve) => resolve());
  return Math.sqrt(n) + Math.floor(1.9);
}
async function main(): Promise<void> {
  console.log(await calc(144));
  console.log((await calc(2.25)).toFixed(1));
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("13\n2.5\n");
    expect(r.stderr).toBe("");
  });

  test("composites cross the boundary as deep copies (the documented aliasing divergence)", async () => {
    // In Node `const d: any = point` aliases; scriptc deep-copies at the
    // boundary (SEMANTICS.md). This is exactly the case that cannot be a
    // differential test — pinned here so the divergence stays deliberate.
    const r = await compileAndRun(
      "any-copy-divergence",
      `const point = { x: 1.5 };
const d: any = point;
d.x = d.x * 2;
console.log(\`\${d.x}\`, point.x);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3 1.5\n"); // Node would print "3 3"
  });

  test("typed arrays cross as copies too — island writes stay island-side", async () => {
    // The bytes sibling of the composite copy divergence: Node would alias.
    const r = await compileAndRun(
      "bytes-copy-divergence",
      `const b = new Uint8Array([10, 20]);
const h: any = b;
h[0] = 99;
console.log(\`\${h[0]}\`, b[0]);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("99 10\n"); // Node would print "99 99"
  });

  test("the island URL reads every component off the static parser; the base form resolves", async () => {
    // The marshal installs the island URL class (no engine URL exists):
    // ALL components read off the SAME WHATWG parser's normalized answers
    // (host/port/search/hash/username/password/origin derived from the
    // parse — the shim burn-down widened the once-minimal class); writes
    // stay refused. The (input, base) form RESOLVES relative inputs (dot
    // segments removed, an own-scheme input ignores the base — Node's
    // answers exactly); protocol-relative inputs keep a narrow fence.
    const r = await compileAndRun(
      "island-url-fences",
      `const box: any = { u: new URL("https://x.dev/a/b?q=1#f") };
console.log(\`\${box.u.href}\`, \`\${box.u.protocol}\`, \`\${box.u.pathname}\`, \`\${box.u}\`);
console.log(\`\${box.u.host}\`, \`\${box.u.origin}\`, \`\${box.u.search}\`, \`\${box.u.hash}\`, \`\${box.u.port === "" ? "no-port" : box.u.port}\`);
const ctor: any = box.u.constructor;
const fresh: any = new ctor("https://y.dev/z");
console.log(\`\${fresh.href}\`);
const rel: any = new ctor("child", "https://y.dev/base/");
console.log(\`\${rel.href}\`);
const dots: any = new ctor("../up.wasm", "https://y.dev/a/b/c.mjs");
console.log(\`\${dots.href}\`);
const abs: any = new ctor("https://other.dev/q", "https://y.dev/base/");
console.log(\`\${abs.href}\`);
const filey: any = new ctor("openh264.wasm", "file:///tmp/pkg/openh264.mjs");
console.log(\`\${filey.href}\`);
try {
  const pr: any = new ctor("//host/p", "https://y.dev/base/");
  console.log(\`\${pr.href}\`);
} catch (e) {
  console.log("protocol-relative fenced");
}
try {
  const bad: any = new ctor("not a url at all");
  console.log(\`\${bad.href}\`);
} catch (e) {
  console.log("invalid input throws");
}
`,
    );
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("https://x.dev/a/b?q=1#f https: /a/b https://x.dev/a/b?q=1#f");
    expect(lines[1]).toBe("x.dev https://x.dev ?q=1 #f no-port");
    expect(lines[2]).toBe("https://y.dev/z");
    expect(lines[3]).toBe("https://y.dev/base/child");
    expect(lines[4]).toBe("https://y.dev/a/up.wasm");
    expect(lines[5]).toBe("https://other.dev/q");
    expect(lines[6]).toBe("file:///tmp/pkg/openh264.wasm");
    expect(lines[7]).toBe("protocol-relative fenced");
    expect(lines[8]).toBe("invalid input throws");
  });

  /* ── dynamic import of the program's OWN modules ──────────────────────
   * Value results and evaluation order are differential (corpus
   * 2050–2052); what lives here is the deliberately scriptc-only half:
   * exports with no island representation cross as TRAP functions (Node's
   * namespace holds the real class — divergence 700), and the namespace
   * is a SNAPSHOT taken when the import resolves where Node's bindings
   * are live (divergence 701). */

  test("a class export crosses the dynamic-import namespace as a pointed trap", async () => {
    const r = await compileAndRun(
      "dynns-class-trap",
      `export class C {
  n(): number { return 1; }
}
async function main(): Promise<void> {
  const ns: any = await import("./dynns-class-trap.ts");
  console.log(typeof ns.C); // a function, like Node's namespace slot
  try {
    const c = new ns.C();
    console.log("unreachable");
  } catch (e) {
    console.log(String(e));
  }
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "function\n" +
        "TypeError: the 'C' export is a class of the compiled program, which cannot cross into dynamically-executed code yet\n",
    );
    expect(r.stderr).toBe("");
  });

  test("the dynamic-import namespace is a snapshot, not Node's live bindings", async () => {
    const r = await compileAndRun(
      "dynns-snapshot",
      `export var counter = 0;
export function bump(): void { counter = counter + 1; }
async function main(): Promise<void> {
  const ns = await import("./dynns-snapshot.ts");
  bump();
  // Node's namespace would answer 1 (live binding); the snapshot taken
  // when the import resolved answers 0 — divergence 701.
  console.log(ns.counter, counter);
}
main();
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("0 1\n");
    expect(r.stderr).toBe("");
  });
});
