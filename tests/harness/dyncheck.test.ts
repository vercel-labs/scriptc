/* Checked-cast FAILURE behavior — scriptc-only, deliberately NOT in the
 * differential corpus.
 *
 * The testing split for the dynamic boundary:
 * - tests/corpus/1000..1007 cover VALID casts differentially (Node and the
 *   native binary agree byte-for-byte — under Node a valid `as` is a no-op).
 * - A LYING cast cannot be tested differentially: Node never checks an `as`
 *   (it silently proceeds on mismatched data), while scriptc THROWS — the
 *   headline documented divergence (SEMANTICS.md). So mismatch programs are
 *   compiled and run here with scriptc ALONE: assert exit code 1 and that
 *   stderr carries the TypeError with the offending PATH.
 * - Exact parse-error message strings are asserted in the runtime C tests
 *   (packages/runtime/test/test_json.c), not here.
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit, turning every failure
 * path (partially-built records/arrays released mid-validation, dyn values
 * unwinding through catch) into a leak/double-free test.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
 * `ext` selects the source lane: "cjs" for the JS lane's per-site checked
 * lowerings (dyn member dispatch exists only there). */
async function compileAndRun(
  name: string,
  source: string,
  ext: "ts" | "cjs" = "ts",
  dynamic = false,
): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .update(dynamic ? "dyn" : "")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `dyncheck-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  // Pinned: the exact TypeError text and path rendering of failed checked
  // casts are C-reference pins; lane identity stays fixed so a diff means
  // the dyn boundary changed, never that the default backend moved.
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
    dynamic,
  });
  if (!result.ok) {
    throw new Error(
      "dyncheck program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

describe(`dynamic-boundary checks (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("promise and codec checked casts reject unrelated values", async () => {
    const r = await compileAndRun(
      "promise-codec-casts",
      `
      const value: unknown = {};
      try { const promise = value as Promise<unknown>; console.log(typeof promise); }
      catch (error) { console.log(error instanceof TypeError); }
      try { const optional = value as Promise<unknown> | undefined; console.log(typeof optional); }
      catch (error) { console.log(error instanceof TypeError); }
      try { const decoder = value as TextDecoder; console.log(decoder.decode()); }
      catch (error) { console.log(error instanceof TypeError); }
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("true\ntrue\ntrue\n");
    expect(r.stderr).toBe("");
  });

  test("typed Promise exits validate fulfillment and preserve rejection", async () => {
    const result = await compileAndRun(
      "promise-exit-payload",
      `
      async function main() {
        const value: unknown = Promise.resolve("wrong");
        try { await (value as Promise<number>); }
        catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
        const rejected: unknown = Promise.reject(new Error("original"));
        try { await (rejected as Promise<number>); }
        catch (error) { console.log((error as Error).message); }
      }
      main();
    `,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("true expected number at $, got string\noriginal\n");
    expect(
      result.stderr
        .split("\n")
        .filter(
          (line) =>
            !sanitize ||
            !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
        )
        .join("\n"),
    ).toBe("");
  });

  test("wrong-typed field throws with the path", async () => {
    const r = await compileAndRun(
      "wrong-type",
      `type Config = { host: string; port: number };
const c = JSON.parse('{"host":"h","port":"eighty"}') as Config;
console.log("unreachable", c.host);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $.port, got string");
  });

  test("schema-directed JSON.parse declines to the checked route with identical errors", async () => {
    // `JSON.parse(text) as T` for plain record/array targets parses in one
    // pass and reruns the checked-dynamic route whenever it declines, so
    // syntax, depth, and checked-cast failures keep their exact messages.
    const r = await compileAndRun(
      "schema-parse-errors",
      `interface Item { sku: string; qty: number }
const deep = "[" + "[".repeat(1000) + "]".repeat(1000) + "]";
const inputs = [
  '[{"sku":"a","qty":1},',
  '[{"sku":"a","qty":01}]',
  '[{"sku":"a\\\\q","qty":1}]',
  '[{"sku":"a","qty":1}] x',
  '[{"sku":"a","x":[1,],"qty":1}]',
  '[{"sku":"a","x":"\\\\u12","qty":1}]',
  deep,
  '[{"sku":"a"}]',
  '[{"sku":"a","qty":1},{"sku":"b","qty":true}]',
  '[{"sku":"a","qty":1,"qty":"x"}]',
  '[{"sku":"a","qty":"x","qty":2}]',
];
for (const text of inputs) {
  let plain = "ok";
  try { JSON.parse(text); } catch (e) { plain = (e as Error).name + ": " + (e as Error).message; }
  let typed = "";
  try { const v = JSON.parse(text) as Item[]; typed = "ok " + v.length + " " + v[0]!.qty; }
  catch (e) { typed = (e as Error).name + ": " + (e as Error).message; }
  console.log(typed, plain === "ok" ? "(plain ok)" : plain === typed ? "(same)" : "(DIFFERENT: " + plain + ")");
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.split("\n")).toEqual([
      "SyntaxError: Unexpected end of JSON input (same)",
      "SyntaxError: Expected ',' or '}' after property value in JSON at position 19 (same)",
      "SyntaxError: Bad escaped character in JSON at position 11 (same)",
      "SyntaxError: Unexpected non-whitespace character after JSON at position 22 (same)",
      'SyntaxError: Unexpected token \']\', ...","x":[1,],"qty":"... is not valid JSON (same)',
      "SyntaxError: Bad Unicode escape in JSON at position 21 (same)",
      "RangeError: Maximum call stack size exceeded (same)",
      "TypeError: expected number at $[0].qty, got undefined (plain ok)",
      "TypeError: expected number at $[1].qty, got boolean (plain ok)",
      "TypeError: expected number at $[0].qty, got string (plain ok)",
      "ok 1 2 (plain ok)",
      "",
    ]);
  });

  test("schema-directed JSON.parse matches the checked route on wrong-typed input", async () => {
    // Pins the fast path against inputs whose shape disagrees with the target:
    // wrong leaf kinds at the top level, in nested records, record arrays and
    // string arrays; null for object and number; missing fields; object vs
    // array at a field and at the root; duplicate keys; truncated JSON; 1e400
    // and a lone surrogate; extra nested members; reordered keys; and an Item[]
    // root. Every line equals the perf/harness (checked-route-only) output.
    const r = await compileAndRun(
      "schema-parse-wrong-types",
      `interface Item { sku: string; qty: number; ok: boolean }
interface Order { id: number; name: string; items: Item[]; tags: string[] }
const cases: string[] = [
  '{"id":1,"name":"a","items":[{"sku":"x","qty":2,"ok":true}],"tags":["t"]}',
  '{"id":"1","name":"a","items":[],"tags":[]}',
  '{"id":1,"name":2,"items":[],"tags":[]}',
  '{"id":1,"name":"a","items":[{"sku":"x","qty":"2","ok":true}],"tags":[]}',
  '{"id":1,"name":"a","items":[{"sku":"x","qty":2}],"tags":[]}',
  '{"id":1,"name":"a","items":[{"sku":"x","qty":2,"ok":1}],"tags":[]}',
  '{"id":1,"name":"a","items":{},"tags":[]}',
  '{"id":1,"name":"a","items":[null],"tags":[]}',
  '{"id":1,"name":"a","items":[],"tags":[1]}',
  '{"id":1,"name":"a","items":[],"tags":[],"extra":{"deep":[1,2,3]}}',
  '{"id":1,"id":2,"name":"a","items":[],"tags":[]}',
  '{"name":"a","items":[],"tags":[]}',
  '{"id":null,"name":"a","items":[],"tags":[]}',
  '[{"id":1}]',
  '{"id":1,"name":"a","items":[],"tags":[]',
  '{"id":1e400,"name":"\\\\ud800","items":[],"tags":[]}',
  '{"tags":[],"items":[],"name":"reordered","id":7}',
];
for (const text of cases) {
  try {
    const o = JSON.parse(text) as Order;
    console.log("ok", o.id, o.name, o.items.length, o.items.map((i) => i.sku + ":" + i.qty + ":" + i.ok).join(","), o.tags.join(","));
  } catch (e) {
    console.log("err", e instanceof Error ? e.name + ": " + e.message : String(e));
  }
}
try {
  const arr = JSON.parse('[{"sku":"a","qty":1,"ok":true},{"sku":"b","qty":"2","ok":false}]') as Item[];
  console.log("ok", arr.length);
} catch (e) {
  console.log("err", e instanceof Error ? e.message : String(e));
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.split("\n")).toEqual([
      "ok 1 a 1 x:2:true t",
      "err TypeError: expected number at $.id, got string",
      "err TypeError: expected string at $.name, got number",
      "err TypeError: expected number at $.items[0].qty, got string",
      "err TypeError: expected boolean at $.items[0].ok, got undefined",
      "err TypeError: expected boolean at $.items[0].ok, got number",
      "err TypeError: expected array at $.items, got object",
      "err TypeError: expected object at $.items[0], got null",
      "err TypeError: expected string at $.tags[0], got number",
      "ok 1 a 0  ",
      "ok 2 a 0  ",
      "err TypeError: expected number at $.id, got undefined",
      "err TypeError: expected number at $.id, got null",
      "err TypeError: expected object at $, got array",
      "err SyntaxError: Unexpected end of JSON input",
      "ok Infinity \uFFFD 0  ",
      "ok 7 reordered 0  ",
      "err expected number at $[1].qty, got string",
      "",
    ]);
  });

  test("missing field throws as undefined", async () => {
    const r = await compileAndRun(
      "missing-field",
      `type Config = { host: string; port: number };
const c = JSON.parse('{"host":"h"}') as Config;
console.log("unreachable", c.port);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $.port, got undefined");
  });

  test("optional field: a PRESENT wrong-typed key throws with the arms named", async () => {
    // (A MISSING key producing the undefined arm is corpus-tested
    // differentially — 1009-json-optional-fields; this covers the failure
    // wording when the key IS there but fits no arm.)
    const r = await compileAndRun(
      "optional-present-wrong",
      `type Cfg = { host: string; port?: number };
const c = JSON.parse('{"host":"h","port":"eighty"}') as Cfg;
console.log("unreachable", c.host);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "Uncaught TypeError: expected number | undefined at $.port, got string",
    );
  });

  test("JSON null matches nothing", async () => {
    const r = await compileAndRun(
      "null-value",
      `const n = JSON.parse("null") as number;
console.log("unreachable", n);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $, got null");
  });

  test("a plain dynamic object cannot acquire a class brand", async () => {
    const r = await compileAndRun(
      "class-brand",
      `class Point {
  x: number = 0;
}
const point = JSON.parse("{}") as Point;
console.log("unreachable", point.x);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected Point at $, got object");
  });

  test("JSON null misses a null-armed union's OTHER arm with the arms named", async () => {
    // (JSON null MATCHING a null arm is corpus-tested differentially —
    // 1008-json-null-arms; this covers the failure wording.)
    const r = await compileAndRun(
      "null-arm-miss",
      `type Rec = { a: string | null };
const x = JSON.parse('{"a": 5}') as Rec;
console.log("unreachable", x.a === null);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected null | string at $.a, got number");
  });

  test("union with no matching arm throws with all arms named", async () => {
    const r = await compileAndRun(
      "union-no-match",
      `type Shape = { kind: "circle"; r: number } | { h: number; kind: "rect"; w: number };
const s = JSON.parse('{"kind":"circle"}') as Shape; // r missing: matches NO arm
console.log("unreachable", s.kind);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected object | object at $, got object");
  });

  test("nested paths point at the offending element", async () => {
    const r = await compileAndRun(
      "nested-path",
      `type Deploy = { server: { host: string; ports: number[] } };
const d = JSON.parse('{"server":{"host":"h","ports":[80,443,"oops"]}}') as Deploy;
console.log("unreachable", d.server.host);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "Uncaught TypeError: expected number at $.server.ports[2], got string",
    );
  });

  test("RECURSIVE shapes validate depth-first: the path names the deep offender", async () => {
    // The named-recursive-shape walker calls itself per level (JSON input
    // is a tree, so the recursion terminates); a failure three knots down
    // still renders the full path.
    const r = await compileAndRun(
      "recursive-path",
      `interface TreeNode { label: string; children: TreeNode[] }
const t = JSON.parse('{"label":"r","children":[{"label":"a","children":[{"label":7,"children":[]}]}]}') as TreeNode;
console.log("unreachable", t.label);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "Uncaught TypeError: expected string at $.children[0].children[0].label, got number",
    );
  });

  test("array where a record is expected names the mismatch at the root", async () => {
    const r = await compileAndRun(
      "root-kind",
      `type Config = { port: number };
const c = JSON.parse("[1,2,3]") as Config;
console.log("unreachable", c.port);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected object at $, got array");
  });

  test("a failed check is CATCHABLE and execution recovers", async () => {
    const r = await compileAndRun(
      "catchable",
      `type Config = { port: number };
function load(raw: string): number {
  try {
    return (JSON.parse(raw) as Config).port;
  } catch {
    return -1;
  }
}
console.log(load('{"port":8080}'), load('{"port":"x"}'), load('{"port":1}'));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("8080 -1 1\n");
    expect(r.stderr).toBe("");
  });

  test("width tolerance really is check-and-extract: extras dropped, no throw", async () => {
    const r = await compileAndRun(
      "width-tolerant",
      `type Slim = { a: number };
const s = JSON.parse('{"a":1,"b":{"huge":[1,2,3]},"c":"ignored"}') as Slim;
console.log(s.a, JSON.stringify(s));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('1 {"a":1}\n');
  });

  test("tuple targets validate arity exactly", async () => {
    const r = await compileAndRun(
      "tuple-arity",
      `const rows = JSON.parse('[["a",1],["b",2,3]]') as [string, number][];
console.log("unreachable", rows.length);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected array of length 2 at $[1], got array");
  });

  test("tuple positions fail with index paths and per-position types", async () => {
    const r = await compileAndRun(
      "tuple-pos",
      `type Span = { range: [number, number] };
const s = JSON.parse('{"range":[0,"nine"]}') as Span;
console.log("unreachable", s.range[0]);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $.range[1], got string");
  });

  test("an object where a tuple is expected names the array shape", async () => {
    const r = await compileAndRun(
      "tuple-kind",
      `const t = JSON.parse('{"0":"a","1":1}') as [string, number];
console.log("unreachable", t[1]);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected array at $, got object");
  });

  test("tuple failure-path RC stress: partial tuples release on unwind", async () => {
    const r = await compileAndRun(
      "tuple-rc-failure",
      `let recovered = 0;
for (let i = 0; i < 100; i = i + 1) {
  try {
    const rows = JSON.parse('[["ok","fine"],["bad",7]]') as [string, string][];
    recovered = recovered - rows.length;
  } catch {
    recovered = recovered + 1;
  }
}
console.log(recovered);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("100\n");
  });

  test("failure-path RC stress: repeated mismatches through catch stay clean", async () => {
    // Meaningful mostly under SCRIPTC_SAN=1 (ASan + RC audit at exit): every
    // iteration builds a partial record/array that must release on unwind.
    const r = await compileAndRun(
      "rc-failure-stress",
      `type Entry = { tags: string[]; v: number };
let recovered = 0;
for (let i = 0; i < 100; i = i + 1) {
  try {
    const e = JSON.parse('{"tags":["a","b",7],"v":1}') as Entry; // tags[2] wrong
    recovered = recovered - e.v;
  } catch {
    recovered = recovered + 1;
  }
  try {
    const e2 = JSON.parse('{"tags":[],"v":"no"}') as Entry; // v wrong, after tags built
    recovered = recovered - e2.v;
  } catch {
    recovered = recovered + 1;
  }
}
console.log(recovered);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("200\n");
  });

  test("index-signature shapes CAPTURE extras — and a wrong-typed extra throws with its key path", async () => {
    // Width tolerance becomes width capture on index-signature shapes: the
    // extras must fit the signature's value type. (The capture SUCCESS
    // path is corpus-tested differentially — 909-records-index-json.)
    const r = await compileAndRun(
      "index-capture-wrong",
      `const bag = JSON.parse('{"a":"1","b":7}') as Record<string, string>;
console.log("unreachable", bag["a"]);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected string at $.b, got number");
  });

  test("a dynamic write colliding with a declared field validates: mismatch throws, field untouched", async () => {
    // JS would store anything under the key; scriptc validates against
    // the declared slot's type instead (SEMANTICS.md divergence) — and the
    // throw is catchable with the field's own type in the message.
    const r = await compileAndRun(
      "index-write-collision",
      `interface P { input?: string; [k: string]: unknown }
const p: P = { input: "1" };
const k = "in" + "put";
try {
  p[k] = 42;
  console.log("unreachable");
} catch (e) {
  if (e instanceof TypeError) console.log("caught:", e.message);
}
console.log("kept:", p.input !== undefined ? p.input : "gone");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("caught: expected string | undefined at $.input, got number\nkept: 1\n");
  });

  test("overflow churn through failed collisions stays clean", async () => {
    // Meaningful mostly under SCRIPTC_SAN=1: every iteration hands ownership
    // of a fresh dyn value to the write helper, which must release it on
    // the validation-failure path.
    const r = await compileAndRun(
      "index-write-rc",
      `interface P { host: string; [k: string]: unknown }
const p: P = { host: "h" };
const k = "ho" + "st";
let recovered = 0;
for (let i = 0; i < 100; i = i + 1) {
  try {
    p[k] = i; // number into the string slot: throws, value released
  } catch {
    recovered = recovered + 1;
  }
  p["ok" + i] = "v" + i; // and a successful overflow insert each round
}
console.log(recovered, p.host);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("100 h\n");
  });

  /* ── the checked-dynamic FUNCTION boundary ─────────────────────────
   * Happy paths (boxing, exact unwrap identity, adaptation, mustCall
   * end-to-end) are corpus-tested differentially (1650-1654). What CANNOT
   * be tested against Node lives here: JS never checks an `as`, and where
   * Node would coerce a mismatched argument, scriptc throws (SEMANTICS.md
   * 117 — loud, never silently wrong). */

  test("casting a non-function dyn value to a function type throws with the kind", async () => {
    const r = await compileAndRun(
      "dynfn-cast-nonfn",
      `const u: unknown = 42;
const f = u as (x: number) => number;
console.log("unreachable", f(1));
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected function at $, got number");
  });

  test("a boxed function's thunk validates arguments per declared param, positionally", async () => {
    const r = await compileAndRun(
      "dynfn-arg-mismatch",
      `function twice(x: number): number { return x * 2; }
const u: unknown = twice;
const s = u as (x: string) => unknown;
s("nope");
console.log("unreachable");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $[0], got string");
  });

  test("a MISSING argument is undefined and fails a required param's check", async () => {
    // JS arity: the thunk fills undefined; a number param can't hold it.
    const r = await compileAndRun(
      "dynfn-missing-arg",
      `function twice(x: number): number { return x * 2; }
const u: unknown = twice;
const zero = u as () => unknown;
zero();
console.log("unreachable");
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $[0], got undefined");
  });

  test("an adapter validates the RESULT into the target's return type", async () => {
    const r = await compileAndRun(
      "dynfn-result-mismatch",
      `function greet(): string { return "hi"; }
const u: unknown = greet;
const asNum = u as () => number;
console.log("unreachable", asNum());
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $, got string");
  });

  test("boundary TypeErrors are catchable and calls keep working after", async () => {
    const r = await compileAndRun(
      "dynfn-recover",
      `function twice(x: number): number { return x * 2; }
const u: unknown = twice;
const bad = u as (x: string) => unknown;
let caught = 0;
for (let i = 0; i < 50; i = i + 1) {
  try {
    bad("no");
  } catch {
    caught = caught + 1;
  }
}
const good = u as (x: number) => number;
console.log(caught, good(21));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("50 42\n");
  });

  test("adapter/box churn stays clean (RC stress across the boundary)", async () => {
    // Meaningful mostly under SCRIPTC_SAN=1: every round boxes a fresh
    // closure, adapts it, calls through, and drops everything.
    const r = await compileAndRun(
      "dynfn-rc",
      `function makeAdder(n: number): (x: number) => number {
  return (x: number) => x + n;
}
let total = 0;
for (let i = 0; i < 100; i = i + 1) {
  const u: unknown = makeAdder(i);
  const f = u as (x: number) => unknown;
  total = total + (f(1) as number);
}
console.log(total);
`,
    );
    expect(r.exitCode).toBe(0);
    // sum of (1 + i) for i in 0..99
    expect(r.stdout).toBe("5050\n");
  });

  test("a lying `any` into a typed slot throws catchably where Node proceeds silently", async () => {
    // The static-any lane's exit stance (the checked cast's rule applied
    // to implicit any→typed flows): Node assigns the mismatched value and
    // carries on; scriptc throws the catchable TypeError. Loud, never a
    // silent wrong answer — the divergence is deliberate and documented.
    const r = await compileAndRun(
      "any-lying-exit",
      `const a: any = "not a number";
try {
  const n: number = a;
  console.log("unreachable", n);
} catch (e) {
  console.log((e as Error).name);
}
console.log("recovered");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("TypeError\nrecovered\n");
  });

  test("a lying cast into a union that cannot represent the value throws the stranded trap catchably", async () => {
    // The stranded-source trap (coerceToExpected): a checker-approved
    // value no union arm can hold — a unit smuggled through `null!` / `as
    // any`, or a scalar cast at a record union — compiles to the
    // catchable TypeError where Node lets the impossible value ride
    // (divergence 38's stance; the Node-exact families live in corpus
    // 2253).
    const r = await compileAndRun(
      "union-stranded-trap",
      `type U = { foo: number } | { bar: string };
try {
  const u: U = null!;
  console.log("unreachable", typeof u);
} catch (e) {
  console.log((e as Error).name, (e as Error).message.includes("not representable in the target union"));
}
try {
  const w: U = 4 as any as U;
  console.log("unreachable", typeof w);
} catch (e) {
  console.log("scalar:", (e as Error).name);
}
console.log("recovered");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("TypeError true\nscalar: TypeError\nrecovered\n");
  });

  test("a unit smuggled into a PLAIN non-nullable slot throws the stranded trap catchably", async () => {
    // The stranded-UNIT trap without a union in sight: `null!` / `null as
    // any as T` into a plain typed slot (string, array, class, function).
    // Node lets the impossible value ride until it is used; the flow
    // throws here instead (divergence 38's stance extended — SEMANTICS.md
    // 335).
    const r = await compileAndRun(
      "plain-stranded-unit-trap",
      `try {
  const s: string = null!;
  console.log("unreachable", s.length);
} catch (e) {
  console.log((e as Error).name, (e as Error).message.includes("not representable in a 'string' slot"));
}
try {
  const a: number[] = undefined!;
  console.log("unreachable", a.length);
} catch (e) {
  console.log("array:", (e as Error).name);
}
try {
  const f: () => number = null!;
  console.log("unreachable", f());
} catch (e) {
  console.log("func:", (e as Error).name);
}
console.log("recovered");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("TypeError true\narray: TypeError\nfunc: TypeError\nrecovered\n");
  });

  test("a checker-approved function mismatch strands per piece: mismatched params compile at the flow, void results trap after the call", async () => {
    // funcCoerceAdapter's stranded dispositions. Param strand: an array
    // literal of arrows collapses to one element signature — the
    // mismatched arm compiles at the FLOW and could only throw if
    // invoked (the collapsed union types the call's parameter 'never', so
    // honest code cannot invoke it — narrowingUnionToUnion's shape).
    // Result strand: a 'never' thrower behind a typed-result slot — the
    // call runs, the throw wins before the stranded-result trap could
    // fire, so the flow is exact.
    const r = await compileAndRun(
      "func-stranded-adapter",
      `const cases = [
  (v: string) => { console.log("s", v.length); },
  (v: number) => { console.log("n", v + 1); },
];
console.log("assigned", cases.length);
function fail(msg: string): never { throw new Error(msg); }
const h: (s: string) => number[] = fail;
try {
  h("boom");
} catch (e) {
  console.log("never:", (e as Error).message);
}
console.log("recovered");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("assigned 2\nnever: boom\nrecovered\n");
  });

  test("a named record retains identity and mutations through an `any` slot", async () => {
    // Checked storage keeps the live native record shared with its source.
    const r = await compileAndRun(
      "any-record-copy",
      `const base = { a: 1 };
const boxed: any = base;
boxed.a = 2;
console.log(base.a, boxed.a);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("2 2\n");
  });

  test("an uninitialized `any` binding is the dyn undefined, not a trap", async () => {
    // The undefined-init rule: dyn slots are never NULL. (Node-agreeing
    // reads are corpus-tested — 2040; this pins the non-trap guarantee on
    // the module-global path with a captured reader.)
    const r = await compileAndRun(
      "any-uninit-global",
      `let cell: any;
function read(): any {
  return cell;
}
console.log(typeof read(), read() === undefined);
cell = 3;
console.log(typeof read(), read() === undefined);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("undefined true\nnumber false\n");
  });
});

describe(`native-handle boundary fences (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  // Handles cross the checked-dynamic boundary as SCR_DYN_HANDLE boxes;
  // the SUCCESS surface is corpus-tested differentially (1795-1798).
  // These pin the honesty ladder — texts Node never prints, because
  // under Node the members exist (the loud fence IS the divergence).

  const serverPreamble = `'use strict';
const http = require('http');
function wrap(fn) {
  return function() {
    return fn.apply(this, arguments);
  };
}
const server = http.createServer();
`;
  const listenAndHit = `
server.listen(0, '127.0.0.1', wrap(function() {
  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, wrap(function(res) {}));
}));
`;

  test("a real-but-unmodeled member on a dyn handle throws the loud ladder", async () => {
    // writeContinue stays unmodeled (cork/uncork/flushHeaders graduated
    // to real dispatches — the ladder's exemplar moves with the surface).
    const r = await compileAndRun(
      "handle-unmodeled-member",
      serverPreamble +
        `server.on('request', wrap(function(req, res) {
  res.writeContinue();
}));
` +
        listenAndHit,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "'ServerResponse.prototype.writeContinue' on a dynamic value is not supported yet",
    );
  });

  test("an expando write on a dyn handle throws the loud ladder (identity would break)", async () => {
    const r = await compileAndRun(
      "handle-expando-write",
      serverPreamble +
        `server.on('request', wrap(function(req, res) {
  req.custom = 1;
}));
` +
        listenAndHit,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "setting 'custom' on a dynamic IncomingMessage is not supported yet",
    );
  });

  test("an unmodeled event registration on a dyn handle throws the loud ladder", async () => {
    const r = await compileAndRun(
      "handle-unmodeled-event",
      serverPreamble +
        `server.on('request', wrap(function(req, res) {
  req.on('nonsense', wrap(function() {}));
}));
` +
        listenAndHit,
      "cjs",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "listening for 'nonsense' on a dynamic IncomingMessage is not supported yet",
    );
  });

  test("a handle-targeted dynCheck failure names the class", async () => {
    const r = await compileAndRun(
      "handle-wrong-target",
      `import type { IncomingMessage } from "node:http";
const u: unknown = "not a request";
const req = u as IncomingMessage;
console.log("unreachable", req.url);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected IncomingMessage at $, got string");
  });

  test("a non-function listener on a dyn handle throws Node's ERR_INVALID_ARG_TYPE", async () => {
    const r = await compileAndRun(
      "handle-bad-listener",
      serverPreamble +
        `server.on('request', wrap(function(req, res) {
  try {
    req.on('data', 5);
  } catch (e) {
    console.log('caught: ' + String(e));
  }
  res.end('done');
  server.close();
}));
` +
        listenAndHit,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      'caught: TypeError [ERR_INVALID_ARG_TYPE]: The "listener" argument must be of type function. Received type number (5)',
    );
  });

  /* ── the jsval→dyn crossing's honesty ladder (SCR_DYN_JSVAL) ────────
   * The armed rows (typeof/truthiness/String()/===, the narrowing tests,
   * the identity round trip; the routed-ops lane's keyed read/write,
   * calls, method dispatch, Object statics, JSON.stringify) are
   * corpus-tested differentially (2578, 2579, 2582-2585, npm
   * jsval-into-dyn). These pin the LOUD fences of every dyn walk still
   * un-armed over an island-held value — the retired fence box answered
   * typeof "function" and .length 0 SILENTLY here; a wrong answer is
   * never acceptable, a named refusal is. All --dynamic. */

  // A JS-lane `any` producer: JSDoc-`any` returns are ISLAND values under
  // --dynamic (a bare record literal would infer a typed record and take
  // the deep-copy path instead; a local initialized FROM an island value
  // also stays island-world by the ratified runtime-world dispatch — the
  // crossing needs a real dyn slot: a param, a literal member, a return).
  const wrapPreamble = `const eng: any = { a: 1, list: [1, 2, 3] };
const u: unknown = eng;
`;

  test("a keyed read on an island-held unknown routes to the engine (the retired .length fence)", async () => {
    const r = await compileAndRun(
      "jsval-key-read",
      `/** @returns {any} */
function mint() { return { a: 1, list: [1, 2, 3] }; }
const eng = mint();
/** @param {object} bag */
function probe(bag) { console.log(bag.list.length, bag.a, bag.missing === undefined); }
probe(eng);
`,
      "cjs",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3 1 true\n");
  });

  test("the collapsed (string | object)[] slot compiles and the element read routes", async () => {
    // Appendix-A repro 4's exit, one lane further along: the union-arm
    // SC2009 fence is RETIRED — `(string | object)[]` maps to the
    // checked-dynamic representation wholesale (every arm dyn-subsumable),
    // the island plugins array WRAPS at the slot (dynFromJsval), and the
    // element read rides the routed keyed-read arm: the engine answers,
    // the scalar normalizes, and typeof prints Node's answer.
    const r = await compileAndRun(
      "jsval-collapsed-union-slot",
      `const eng: any = ["p1", { languages: ["js"] }];
function firstPlugin(ps: (string | object)[]): void {
  console.log(typeof ps[0]);
}
firstPlugin(eng);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("string\n");
  });

  test("a method call on an island-held unknown runs the engine's own prototype", async () => {
    // scr_dyn_invoke's JSVAL arm routes to scr_jsval_call_method — the
    // ENGINE's Array.prototype.slice runs (JS-exact), and the result
    // wraps back for further routed reads.
    const r = await compileAndRun(
      "jsval-method",
      `/** @returns {any} */
function mint() { return [{ languages: ["js"] }]; }
const eng = mint();
/** @param {object} plugins */
function walk(plugins) { return plugins.slice(); }
console.log(\`\${walk(eng).length}\`);
`,
      "cjs",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n");
  });

  test("JSON.stringify of an island-held unknown is the engine's own stringify", async () => {
    const r = await compileAndRun(
      "jsval-stringify",
      wrapPreamble +
        `console.log(JSON.stringify(u));
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"a":1,"list":[1,2,3]}\n');
  });

  test("structuredClone of an island-held unknown fences loudly", async () => {
    const r = await compileAndRun(
      "jsval-clone",
      wrapPreamble +
        `const c = structuredClone(u);
console.log("unreachable", typeof c);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "structuredClone on an island value held in 'unknown' is not supported yet",
    );
  });

  test("Object.keys over an island-held unknown walks the engine object", async () => {
    const r = await compileAndRun(
      "jsval-keys",
      `/** @returns {any} */
function mint() { return { a: 1, b: 2 }; }
const eng = mint();
/** @param {object} bag */
function keys(bag) { return Object.keys(bag); }
console.log(keys(eng).length, keys(eng).join(","));
`,
      "cjs",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("2 a,b\n");
  });

  test("deepStrictEqual over island-held values: identity passes, structure fences", async () => {
    const r = await compileAndRun(
      "jsval-deepeq",
      `import assert from "node:assert";
const eng: any = { a: 1 };
const other: any = { a: 1 };
const u1: unknown = eng;
const u2: unknown = eng;
assert.deepStrictEqual(u1, u2); // the same engine value: honest true
console.log("identity ok");
const u3: unknown = other;
assert.deepStrictEqual(u1, u3); // distinct values: the structural walk fences
console.log("unreachable");
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("identity ok");
    expect(r.stderr).toContain(
      "deepStrictEqual on an island value held in 'unknown' is not supported yet",
    );
  });

  test("util.inspect (console.log) of an island-held unknown fences with the engine typeof", async () => {
    const r = await compileAndRun(
      "jsval-inspect",
      wrapPreamble +
        `console.log(u);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "util.inspect of a composite 'any' value (typeof 'object') is not supported yet",
    );
  });

  test("destructuring and for-of over an island-held unknown drain the engine's own iterator", async () => {
    // The iteration arm (lane dom-jsval-long-tail): dyn.iterPack's JSVAL
    // arm drains the ENGINE's iterator protocol — the wrapped engine
    // array destructures and iterates with Node's answers, and a
    // non-iterable engine value throws V8's for-of spelling instead of
    // the retired island fence.
    const r = await compileAndRun(
      "jsval-iterate",
      `/** @returns {any} */
function mint() { return { list: [10, 20], num: 7 }; }
const eng = mint();
/** @param {object} bag */
function walk(bag) {
  const [first] = bag.list;
  console.log(\`first \${first}\`);
  let sum = 0;
  for (const x of bag.list) sum += x;
  console.log(\`sum \${sum}\`);
  try {
    for (const x of bag.num) console.log(x);
  } catch (err) {
    console.log(\`caught: \${err.message}\`);
  }
}
walk(eng);
`,
      "cjs",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("first 10\nsum 30\ncaught: bag.num is not iterable\n");
  });

  test("a keyed write through an island-held unknown lands on the real engine object", async () => {
    // Aliasing preserved: the island-side reader sees the write made
    // through the wrapped alias (the retired setting-fence row).
    const r = await compileAndRun(
      "jsval-key-write",
      `/** @returns {any} */
function mint() { return { a: 1 }; }
const eng = mint();
/** @param {object} bag */
function poke(bag) { bag.a = 2; bag.fresh = "x"; }
poke(eng);
console.log(\`\${eng.a} \${eng.fresh}\`);
`,
      "cjs",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("2 x\n");
  });

  test("'in' over an island-held unknown fences (never a silent false)", async () => {
    const r = await compileAndRun(
      "jsval-in",
      `/** @returns {any} */
function mint() { return { a: 1 }; }
const eng = mint();
/** @param {object} bag */
function has(bag) { return "a" in bag; }
console.log(has(eng));
`,
      "cjs",
      true,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("'in' on an island value held in 'unknown' is not supported yet");
  });

  test("a wrapped island value RC-balances through catch-and-continue fences", async () => {
    // The fence throws are catchable; the wrapped cell must release
    // cleanly through the unwind (the SAN lane's RC audit is the check).
    // The crossing rides a real dyn PARAM slot — a local initialized from
    // an island value stays island-world by the runtime-world dispatch.
    const r = await compileAndRun(
      "jsval-fence-unwind",
      `const eng: any = { a: 1 };
let caught = 0;
function probe(u: unknown): void {
  try {
    structuredClone(u);
  } catch (e) {
    if (e instanceof Error) caught++;
  }
}
for (let i = 0; i < 100; i++) probe(eng);
console.log("done", caught);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("done 100\n");
  });
});
