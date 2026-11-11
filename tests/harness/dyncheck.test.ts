/* Checked-cast FAILURE behavior — scriptc-only, deliberately NOT in the
 * differential corpus.
 *
 * The testing split for the dynamic boundary:
 * - tests/corpus/1000..1007 cover VALID casts differentially (Node and the
 *   native binary produce identical output — under Node a valid `as` is a no-op).
 * - A LYING cast cannot be tested differentially: Node never checks an `as`
 *   (it proceeds on mismatched data without an error), while scriptc THROWS — the
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
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

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
 * lowerings (dyn member dispatch exists only there). `files` adds sibling
 * modules (a JavaScript module and its declaration sidecar) next to the
 * entry, so a lying declaration can be exercised without a lying cast. */
async function compileAndRun(
  name: string,
  source: string,
  ext: "ts" | "cjs" = "ts",
  compareNode = false,
  files: Record<string, string> = {},
): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(JSON.stringify(files))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `dyncheck-${key}`);
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(outDir, name)), { recursive: true });
    writeFileSync(join(outDir, name), text);
  }
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
  });
  if (!result.ok) {
    throw new Error(
      "dyncheck program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const run = async (executable: string, args: string[]): Promise<RunResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, { encoding: "utf8" });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof e.code !== "number") throw err;
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
    }
  };
  const actual = await run(result.binaryPath, []);
  if (compareNode) {
    const expected = await run(
      process.execPath,
      ext === "ts" ? ["--input-type=module-typescript", "--eval", source] : [file],
    );
    const stderr = sanitize
      ? actual.stderr.replace(
          /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
          "",
        )
      : actual.stderr;
    expect({ ...actual, stderr }).toEqual(expected);
  }
  return actual;
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

  test("an Extract member pattern assertion checks the member the literal selects", async () => {
    const r = await compileAndRun(
      "extract-member-pattern-assertion",
      `
      type Circle = { kind: "circle"; radius: number };
      type Square = { kind: "square"; side: number };
      type Shape = Circle | Square;
      function pick<K extends Shape["kind"]>(shape: Shape, kind: K): string {
        const picked = shape as Extract<Shape, { kind: K }>;
        return JSON.stringify(picked);
      }
      console.log(pick({ kind: "circle", radius: 1 }, "circle"));
      try { console.log(pick({ kind: "square", side: 2 }, "circle")); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      '{"kind":"circle","radius":1}\n' +
        "true a '{ kind: string; side: number }' value is not representable in the target union (a value narrowed or asserted past it still held it)\n",
    );
    expect(r.stderr).toBe("");
  });

  test("a value routed by a partial discriminant is checked into the arm it names", async () => {
    const r = await compileAndRun(
      "partial-discriminant-route",
      `
      type Reply =
        | { op: "open"; ok: true; data: { handle: number } }
        | { op: "close"; ok: true }
        | { op: "list"; ok: true; data: { names: string[] } }
        | { op: string; ok: false; error: string };
      const done = <T extends "open" | "close" | "list">(op: T, data: object): Reply => ({ op, ok: true, data }) as Reply;
      console.log(JSON.stringify(done("open", { handle: 1 })));
      try { console.log(JSON.stringify(done("list", { handle: 1 }))); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
      try { console.log(JSON.stringify(done("other" as "open", {}))); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      '{"op":"open","ok":true,"data":{"handle":1}}\n' +
        "true expected array at $.names, got undefined\n" +
        "true invalid 'op' discriminant in record conversion\n",
    );
    expect(r.stderr).toBe("");
  });

  test("a record beside undefined asserted to a subtype checks the value", async () => {
    const r = await compileAndRun(
      "asserted-subtype-beside-undefined",
      `
      interface Reply { handled?: boolean }
      interface Routed extends Reply { handled: true; origin: { x: number } }
      function produce(n: number): Reply | undefined { return n === 0 ? undefined : { handled: n > 1 }; }
      function read(n: number): string {
        const result = produce(n);
        try { const routed = result as Routed; return "routed " + routed.origin.x; }
        catch (error) { return (error instanceof TypeError) + " " + (error as Error).message; }
      }
      console.log(read(0));
      console.log(read(2));
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "true undefined is not representable in the target union (a value narrowed or asserted past it still held it)\n" +
        "true expected object at $.origin, got undefined\n",
    );
    expect(r.stderr).toBe("");
  });

  test("joining an untyped array refuses an instance whose class defines toString", async () => {
    // Node runs the class's toString for each element. The walk over an
    // untyped array cannot call a compiled method, and "[object Object]"
    // would be a wrong answer, so the conversion throws by name.
    const r = await compileAndRun(
      "untyped-join-class-to-string",
      `
      class Named { toString(): string { return "x"; } }
      class Sub extends Named {}
      class Plain { a = 1; }
      const attempt = (label: string, go: () => unknown): void => {
        try { console.log(label, go()); }
        catch (error) { console.log(label, (error as Error).name, (error as Error).message); }
      };
      const named: unknown[] = [new Named(), "a"];
      const sub: unknown[] = ["a", new Sub()];
      const nested: unknown[] = [1, [new Named()]];
      const plain: unknown[] = [new Plain(), "a", null, undefined, 1];
      const one: unknown = new Named();
      attempt("join", () => named.join("+"));
      attempt("String", () => String(named));
      attempt("template", () => \`\${named}\`);
      attempt("inherited", () => sub.join("+"));
      attempt("nested", () => nested.join("+"));
      attempt("plain", () => plain.join("+"));
      attempt("direct", () => String(one));
    `,
    );
    const refusal =
      "Error String conversion of a class instance whose class defines toString has no lowering where the value is untyped; convert the instance where its class is known";
    expect(r.stdout).toBe(
      [
        `join ${refusal}`,
        `String ${refusal}`,
        `template ${refusal}`,
        `inherited ${refusal}`,
        `nested ${refusal}`,
        "plain [object Object]+a+++1",
        "direct x",
        "",
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("an untyped RegExp with properties of its own keeps the inspector's refusal", async () => {
    // Node prints the added properties after the pattern (`/b+/i { extra: 1 }`).
    // The untyped inspector prints a RegExp's pattern and flags only, so one
    // the program gave properties of its own is refused by name instead of
    // printed without them; a RegExp without any prints.
    const r = await compileAndRun(
      "untyped-regexp-own-properties",
      `
      const attempt = (label, go) => {
        try { go(); } catch (e) { console.log(label, "threw", e.message); }
      };
      const withProps = /b+/i;
      withProps.extra = 1;
      class Box { constructor(v) { this.v = v; } }
      const plain = JSON.parse("[]");
      plain.push(/a+/g, [/c/]);
      attempt("plain", () => console.log(plain));
      attempt("set", () => console.log(new Set([withProps])));
      attempt("class field", () => console.log(new Box(withProps)));
      attempt("plain set", () => console.log(new Set([/d/])));
    `,
      "cjs",
    );
    expect(r.stdout).toBe(
      [
        "[ /a+/g, [ /c/ ] ]",
        "set threw util.inspect of a dynamic RegExp is not supported yet",
        "class field threw util.inspect of a dynamic RegExp is not supported yet",
        "Set(1) { /d/ }",
        "",
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("assertions narrowing record members or union arms check the value", async () => {
    const r = await compileAndRun(
      "narrowing-record-assertions",
      `
      interface AlphaOpts { fast?: boolean }
      interface Item<K extends string> { id: string; kind: K; opts?: K extends "alpha" ? AlphaOpts : never }
      const items: Item<"alpha" | "gamma">[] = [{ id: "g1", kind: "gamma" }, { id: "a1", kind: "alpha", opts: { fast: true } }];
      try { const all = items as Item<"gamma">[]; console.log(all.length); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
      try { const one = items[1]! as Item<"gamma">; console.log(one.id); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
      interface S { stream: () => string }
      function keys(u: S | { a?: S }): string[] { const m = u as Partial<Record<string, S>>; return Object.keys(m); }
      try { console.log(keys({ a: { stream: () => "a" } }).join()); console.log(keys({ stream: () => "s" })); }
      catch (error) { console.log(error instanceof TypeError); }
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "true expected null | undefined at $[1].opts, got object\n" +
        "true expected null | undefined at $.opts, got object\n" +
        "a\ntrue\n",
    );
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

  test("a boxed native value cast to another layout is copied (decision D3)", async () => {
    // Node's `as` is a no-op, so these writes would show through every
    // holder. scriptc copies a boxed native value into a cast's different
    // layout for now (the object model's decision D3: copy, throw, or
    // share storage); the copy keeps one identity per boxed value.
    const r = await compileAndRun(
      "native-layout-casts",
      `type Point = { x: number; y: number };
const dict: Record<string, number> = { x: 1, y: 2 };
const v: unknown = dict;
const p = v as Point;
p.x = 5;
console.log(dict.x, p.x, (v as Point) === p);
const nums: number[] = [1, 2];
const u: unknown = nums;
console.log((u as number[]) === nums);
const wide = u as (number | string)[];
wide.push("s");
console.log(nums.length, wide.length);
console.log(JSON.stringify({ ...(v as Record<string, number>) }));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(["1 5 true", "true", "2 3", '{"x":1,"y":2}', ""].join("\n"));
    expect(r.stderr).toBe("");
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

  test("a getter-backed field the conversion copies still checks its type", async () => {
    // The view answers an accessor-backed member through its getter, and
    // the value it returns goes through the typed boundary's check like any
    // other: the accessor is how the field is read, not an exemption.
    const r = await compileAndRun(
      "getter-boundary-mismatch",
      `interface Counted { readonly count: number }
class Tally {
  private items: string[];
  constructor(items: string[]) { this.items = items; }
  get count(): string { return String(this.items.length); }
}
try {
  const counted = new Tally(["a", "b"]) as unknown as Counted;
  console.log("unreachable", counted.count);
} catch (error) {
  console.log("caught", (error as Error).name, (error as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("caught TypeError expected number at $, got string\n");
  });

  test("a record cast from unknown to a dictionary throws at its mismatched read", async () => {
    // An element of an `unknown[]` keeps the record's identity, as an
    // `unknown` binding does: the write lands, and only the read of a
    // field the dictionary's value type does not admit throws.
    const r = await compileAndRun(
      "dictionary-view-mismatch",
      `type Stats = { hits: number; name: string };
const stats: Stats[] = [{ hits: 1, name: "a" }, { hits: 1, name: "b" }];
function attempt(label: string, view: Record<string, number>): void {
  view["hits"] = view["hits"]! + 1;
  try {
    console.log(label, view["name"]);
  } catch (error) {
    console.log(label, (error as Error).name, (error as Error).message);
  }
}
const mapped: unknown[] = stats.map((s) => s as unknown);
attempt("mapped", mapped[0] as Record<string, number>);
const listed: unknown[] = [stats[1]];
attempt("listed", listed[0] as Record<string, number>);
console.log(stats[0]!.hits, stats[1]!.hits);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "mapped TypeError expected number at $, got string",
        "listed TypeError expected number at $, got string",
        "2 2",
        "",
      ].join("\n"),
    );
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
      "SyntaxError: Unexpected number in JSON at position 19 (line 1 column 20) (same)",
      "SyntaxError: Bad escaped character in JSON at position 11 (line 1 column 12) (same)",
      "SyntaxError: Unexpected non-whitespace character after JSON at position 22 (line 1 column 23) (same)",
      'SyntaxError: Unexpected token \']\', ..."a","x":[1,],"qty":1}"... is not valid JSON (same)',
      "SyntaxError: Bad Unicode escape in JSON at position 21 (line 1 column 22) (same)",
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
      "err SyntaxError: Expected ',' or '}' after property value in JSON at position 39 (line 1 column 40)",
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

  test("optional record member: the failure names the deepest path inside it", async () => {
    // `Partial<T>` makes every member an `X | undefined` union. A present
    // object that fails X used to report only the union's own path
    // ("expected object | undefined at $.order, got object"); the record
    // arm's builder now reports where inside it the value fails.
    const r = await compileAndRun(
      "optional-record-deep",
      `interface Order {
  owner: { id: string; plan: { tier: string } };
  total: number;
}
interface Envelope { order: Order; tags?: string[] }
const texts = [
  '{"order":{"owner":{"id":"u1"},"total":3}}',
  '{"order":{"owner":{"id":7,"plan":{"tier":"pro"}},"total":3}}',
  '{"order":{"owner":{"id":"u1","plan":{"tier":"pro"}},"total":3},"tags":["a",2]}',
  '{"order":5}',
];
for (const text of texts) {
  try {
    const e = JSON.parse(text) as Partial<Envelope>;
    console.log("ok", e.order?.owner.id);
  } catch (err) {
    if (err instanceof TypeError) console.log(err.message);
  }
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "expected object at $.order.owner.plan, got undefined",
        "expected string at $.order.owner.id, got number",
        "expected string at $.tags[1], got number",
        "expected object | undefined at $.order, got number",
        "",
      ].join("\n"),
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

  test("a union read by its discriminant fails with every arm named, as arm-by-arm tests do", async () => {
    // Five record arms with six literals, plus string and number arms: the
    // check reads `kind` once and tests only the arm it names and the
    // arms that are not records.
    const r = await compileAndRun(
      "union-discriminant-dispatch",
      `type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; text: string }
  | { kind: "neg"; operand: Expr }
  | { kind: "add" | "mul"; left: Expr; right: Expr }
  | { items: Expr[]; kind: "list" }
  | string
  | number;
const inputs = [
  '{"kind":"num"}',
  '{"kind":"nope","value":1}',
  '{"kind":7,"value":1}',
  '{"value":1}',
  '{"kind":"neg","operand":{"kind":"add","left":{"kind":"num","value":1},"right":{"kind":"str","text":5}}}',
  'true',
  '{"items":["a",3,{"kind":"mul","left":"x","right":2}],"kind":"list"}',
];
for (const input of inputs) {
  try {
    console.log(JSON.stringify(JSON.parse(input) as Expr));
  } catch (error) {
    console.log((error as Error).message);
  }
}
`,
    );
    const any = "number | object | object | object | object | object | string";
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        `expected ${any} at $, got object`,
        `expected ${any} at $, got object`,
        `expected ${any} at $, got object`,
        `expected ${any} at $, got object`,
        `expected ${any} at $, got object`,
        `expected ${any} at $, got boolean`,
        '{"items":["a",3,{"kind":"mul","left":"x","right":2}],"kind":"list"}',
        "",
      ].join("\n"),
    );
  });

  test("a getter that changes the discriminant during an arm's check continues with the later arms", async () => {
    // Each getter sets `kind` and fails its arm's check: to a later arm's
    // literal (that arm matches), to an earlier arm's literal (arm-by-arm
    // tests do not go back), and to a literal no arm holds.
    const r = await compileAndRun(
      "union-discriminant-getter",
      `type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "rect"; height: number; width: number }
  | { kind: "tri"; a: number; b: number; c: number };
const flip = (value: any, to: string): string => {
  value.kind = to;
  return "none";
};
const later: any = { kind: "circle", get radius() { return flip(later, "square"); }, side: 3 };
const earlier: any = { kind: "square", radius: 2, get side() { return flip(earlier, "circle"); } };
const unknown: any = { kind: "square", get side() { return flip(unknown, "hexagon"); } };
const inputs = [later, earlier, unknown];
for (const input of inputs) {
  try {
    const shape = input as Shape;
    console.log("matched", shape.kind);
  } catch (error) {
    console.log((error as Error).message);
  }
}
`,
    );
    const any = "object | object | object | object";
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "matched square",
        `expected ${any} at $, got object`,
        `expected ${any} at $, got object`,
        "",
      ].join("\n"),
    );
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

  test("nested unions: a failure inside a matched arm names the union that holds it", async () => {
    // A union's builder converts the arm that matched; the unions nested in
    // it pick their arms by literal or by the kind of value only one arm
    // takes. A value that fails anywhere below fails its outermost union,
    // whose arms the message names.
    const r = await compileAndRun(
      "deep-discriminated",
      `type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; text: string }
  | { kind: "add"; left: Expr; right: Expr }
  | { kind: "call"; callee: string; args: Expr[] }
  | { kind: "neg"; operand: Expr }
  | { kind: "opt"; inner: Expr | undefined; label?: string };
type Stmt =
  | { kind: "expr"; expr: Expr }
  | { kind: "ret"; value: Expr | null }
  | { kind: "block"; body: Stmt[] };
type Fn = { name: string; body: Stmt[] };

function attempt(label: string, text: string, as: "expr" | "stmt" | "fn" | "list"): void {
  try {
    if (as === "expr") {
      const e = JSON.parse(text) as Expr;
      console.log(label, "ok", e.kind);
    } else if (as === "stmt") {
      const s = JSON.parse(text) as Stmt;
      console.log(label, "ok", s.kind);
    } else if (as === "fn") {
      const f = JSON.parse(text) as Fn;
      console.log(label, "ok", f.name, f.body.length);
    } else {
      const l = JSON.parse(text) as Expr[];
      console.log(label, "ok", l.length);
    }
  } catch (e) {
    console.log(label, "error", (e as Error).message);
  }
}

const deep = (leaf: string, depth: number): string => {
  let s = leaf;
  for (let i = 0; i < depth; i++) s = \`{"kind":"neg","operand":\${s}}\`;
  return s;
};
attempt("valid", deep('{"kind":"num","value":1}', 20), "expr");
attempt("deep wrong field", deep('{"kind":"num","value":"x"}', 5), "expr");
attempt("deep unknown kind", deep('{"kind":"nope","value":1}', 5), "expr");
attempt("deep string node", deep('"text"', 5), "expr");
attempt("deep missing field", deep('{"kind":"add","left":{"kind":"num","value":1}}', 4), "expr");
attempt("deep array arg", deep('{"kind":"call","callee":"f","args":[{"kind":"num","value":1},{"kind":"str","text":2}]}', 3), "expr");
attempt("optional inner", deep('{"kind":"opt","inner":{"kind":"num","value":true}}', 3), "expr");
attempt("optional label", deep('{"kind":"opt","inner":{"kind":"num","value":1},"label":3}', 3), "expr");
attempt("stmt deep", '{"kind":"block","body":[{"kind":"expr","expr":' + deep('{"kind":"num","value":null}', 3) + '}]}', "stmt");
attempt("ret null", '{"kind":"ret","value":null}', "stmt");
attempt("fn deep", '{"name":"f","body":[{"kind":"ret","value":' + deep('{"kind":"str","text":5}', 4) + '}]}', "fn");
attempt("list element", '[{"kind":"num","value":1},' + deep('{"kind":"num"}', 2) + "]", "list");
attempt("kind not string", deep('{"kind":3,"value":1}', 2), "expr");
attempt("valid list", '[' + deep('{"kind":"num","value":1}', 3) + ',{"kind":"str","text":"t"}]', "list");

type Box = { value: number; child?: Box; rest: Box[] | null };
function box(label: string, text: string): void {
  try {
    const b = JSON.parse(text) as Box;
    console.log(label, "ok", b.value);
  } catch (e) {
    console.log(label, "error", (e as Error).message);
  }
}
box("box valid", '{"value":1,"rest":null,"child":{"value":2,"rest":[{"value":3,"rest":null}]}}');
box("box deep child", '{"value":1,"rest":null,"child":{"value":2,"rest":null,"child":{"value":"x","rest":null}}}');
box("box deep rest", '{"value":1,"rest":[{"value":2,"rest":[{"value":3,"rest":[1]}]}]}');
box("box child array", '{"value":1,"rest":null,"child":[]}');
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "valid ok neg",
      "deep wrong field error expected object | object | object | object | object | object at $, got object",
      "deep unknown kind error expected object | object | object | object | object | object at $, got object",
      "deep string node error expected object | object | object | object | object | object at $, got object",
      "deep missing field error expected object | object | object | object | object | object at $, got object",
      "deep array arg error expected object | object | object | object | object | object at $, got object",
      "optional inner error expected object | object | object | object | object | object at $, got object",
      "optional label error expected object | object | object | object | object | object at $, got object",
      "stmt deep error expected object | object | object at $, got object",
      "ret null ok ret",
      "fn deep error expected object | object | object at $.body[0], got object",
      "list element error expected object | object | object | object | object | object at $[1], got object",
      "kind not string error expected object | object | object | object | object | object at $, got object",
      "valid list ok 2",
      "box valid ok 1",
      "box deep child error expected number at $.child.child.value, got string",
      "box deep rest error expected object at $.rest[0].rest[0].rest[0], got number",
      "box child array error expected object | undefined at $.child, got array",
    ]);
  });

  test("nested unions: a value a getter returns while building is matched in full", async () => {
    // The getter answers a valid node while the arm matches and a wrong one
    // while it builds. The builder matches the second answer in full, so the
    // failure names the union that holds it, as without the arm's match.
    const r = await compileAndRun(
      "deep-discriminated-getter",
      `type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; text: string }
  | { kind: "neg"; operand: Expr }
  | { kind: "add"; left: Expr; right: Expr };
const v = JSON.parse('{"kind":"neg"}') as unknown;
let calls = 0;
Object.defineProperty(v, "operand", {
  enumerable: true,
  get() {
    calls++;
    return calls === 1 ? JSON.parse('{"kind":"num","value":1}') : JSON.parse('{"kind":"num","value":"x"}');
  },
});
try {
  const e = v as Expr;
  console.log("ok", JSON.stringify(e));
} catch (err) {
  console.log((err as Error).message);
}
console.log("getter calls", calls);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "expected object | object | object | object at $.operand, got object",
      "getter calls 2",
    ]);
  });

  test("nested unions: a getter's value in a non-recursive union's build is matched in full", async () => {
    // A union without recursion builds without a visit session. The getter
    // still runs user code during the trusted build, so the nested union
    // matches its second answer in full, and the failure names that union.
    const r = await compileAndRun(
      "flat-discriminated-getter",
      `type Inner = { tag: "x"; n: number } | { tag: "y"; s: string };
type Outer = { kind: "a"; inner: Inner } | { kind: "b"; other: number };
const v = JSON.parse('{"kind":"a"}') as unknown;
let calls = 0;
Object.defineProperty(v, "inner", {
  enumerable: true,
  get() {
    calls++;
    return calls === 1 ? JSON.parse('{"tag":"x","n":1}') : JSON.parse('{"tag":"x","n":"bad"}');
  },
});
try {
  const o = v as Outer;
  console.log("ok", JSON.stringify(o));
} catch (err) {
  console.log((err as Error).message);
}
console.log("getter calls", calls);
const plain = JSON.parse('{"kind":"a","inner":{"tag":"y","s":"z"}}') as Outer;
console.log(JSON.stringify(plain));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "expected object | object at $.inner, got object",
      "getter calls 2",
      '{"kind":"a","inner":{"tag":"y","s":"z"}}',
    ]);
  });

  test("nested unions: a getter that converts a recursive union keeps a non-recursive build untrusted", async () => {
    // The getter converts a recursive union, which opens and ends a visit
    // session of its own, before it answers. The outer build still matches
    // the getter's second answer in full, and the failure names that union.
    const r = await compileAndRun(
      "flat-discriminated-getter-session",
      `type Tree = { kind: "leaf"; n: number } | { kind: "node"; left: Tree; right: Tree };
type Inner = { tag: "x"; n: number } | { tag: "y"; s: string };
type Outer = { kind: "a"; inner: Inner } | { kind: "b"; other: number };
const v = JSON.parse('{"kind":"a"}') as unknown;
let calls = 0;
let leaves = 0;
Object.defineProperty(v, "inner", {
  enumerable: true,
  get() {
    calls++;
    const t = JSON.parse('{"kind":"node","left":{"kind":"leaf","n":1},"right":{"kind":"leaf","n":2}}') as Tree;
    if (t.kind === "node") leaves += 2;
    return calls === 1 ? JSON.parse('{"tag":"x","n":1}') : JSON.parse('{"tag":"x","n":"bad"}');
  },
});
try {
  const o = v as Outer;
  console.log("ok", JSON.stringify(o));
} catch (err) {
  console.log((err as Error).message);
}
console.log("getter calls", calls, "leaves", leaves);
const plain = JSON.parse('{"kind":"a","inner":{"tag":"y","s":"z"}}') as Outer;
console.log(JSON.stringify(plain));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "expected object | object at $.inner, got object",
      "getter calls 2 leaves 4",
      '{"kind":"a","inner":{"tag":"y","s":"z"}}',
    ]);
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

  test("width tolerance checks declared fields and keeps the extras, no throw", async () => {
    // Extras are not validated against anything, and the record keeps them
    // beside its declared fields for serialization (Node's output).
    const r = await compileAndRun(
      "width-tolerant",
      `type Slim = { a: number };
const s = JSON.parse('{"a":1,"b":{"huge":[1,2,3]},"c":"kept"}') as Slim;
console.log(s.a, JSON.stringify(s));
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('1 {"a":1,"b":{"huge":[1,2,3]},"c":"kept"}\n');
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
   * 117 — it throws instead of returning a wrong result). */

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

  test("a TYPED-REST target adapts the boxed function and checks each argument", async () => {
    // The cast's domain includes rest-parameter signatures: the adapter packs
    // the call's trailing arguments and the source thunk checks every one
    // against its own parameter type. Node calls the source function with
    // whatever arrived (here numbers into string params) and prints "1,2".
    const r = await compileAndRun(
      "dynfn-rest-arg-mismatch",
      `function asDyn(value: unknown): unknown { return value; }
const src = asDyn((...values: string[]) => values.join(","));
const f = src as (...values: number[]) => string;
console.log(f(1, 2));
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected string at $[0], got number");
  });

  test("a look-alike object cannot acquire the boxed native result's kind", async () => {
    // A native result type with a boxed form unwraps the BOX only: the object
    // is a different kind. Node erases the cast and reads status 0.
    const r = await compileAndRun(
      "dyn-spawnres-lookalike",
      `import type { SpawnSyncReturns } from "node:child_process";
function asDyn(value: unknown): unknown { return value; }
const lookalike = asDyn({ status: 0, signal: null, stdout: "x", stderr: "", pid: 1, output: [] });
const result = lookalike as SpawnSyncReturns;
console.log(result.status);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Uncaught TypeError: expected SpawnSyncReturns at $, got object");
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

  test("a lying `any` into a typed slot throws catchably where Node proceeds without an error", async () => {
    // The static-any lane's exit stance (the checked cast's rule applied
    // to implicit any→typed flows): Node assigns the mismatched value and
    // carries on; scriptc throws the catchable TypeError instead of
    // returning a wrong result — the divergence is deliberate and documented.
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

  test("a union spread merge's checked-dynamic object refuses a single-arm reinterpretation catchably", async () => {
    // Where the per-arm distribution cannot pick one arm, a spread merge
    // over union sources builds the object Node builds — the checked-
    // dynamic copy — and the union's checked conversion validates it at
    // every typed slot. Node keeps the merged keys through a narrower
    // `as`; scriptc refuses to reinterpret them silently and throws the
    // catchable TypeError instead. That makes this path scriptc-only:
    // corpus union-spread-merge.ts pins the accepting paths differentially.
    const r = await compileAndRun(
      "union-spread-merge-dyn",
      `interface OpenAiCompat { supportsStore?: boolean }
interface AnthropicCompat { supportsLongCacheRetention?: boolean }
type Compat = OpenAiCompat | AnthropicCompat;
function mergeCompat(base: Compat, override: Compat): Compat {
  return { ...base, ...override } as Compat;
}
const merged = mergeCompat({ supportsStore: true }, { supportsLongCacheRetention: true });
console.log(JSON.stringify(merged));
try {
  const single = merged as OpenAiCompat;
  console.log("unreachable", JSON.stringify(single));
} catch (e) {
  console.log((e as Error).name, (e as Error).message.includes("not representable in the target union"));
}
console.log("recovered");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      '{"supportsStore":true,"supportsLongCacheRetention":true}\nTypeError true\nrecovered\n',
    );
    expect(r.stderr).toBe("");
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

  test("a non-null assertion on a null object result throws at the assertion, even when the binding is never read", async () => {
    // Node lets the null ride until a member read; the compiled program
    // throws the stranded TypeError where `!` extracts the object.
    const r = await compileAndRun(
      "asserted-null-object-result",
      `interface Info {
  name: string;
  base: Info | null;
  callable: boolean;
}
function baseOf(info: Info): Info | null {
  return info.base;
}
function describe(info: Info): string {
  const base = baseOf(info)!;
  if (info.callable) return info.name + ": callable base";
  return info.name + " extends " + base.name;
}
const root: Info = { name: "Root", base: null, callable: false };
console.log(describe({ name: "Child", base: root, callable: false }));
try {
  console.log("unreachable", describe({ name: "Wrapped", base: null, callable: true }));
} catch (e) {
  console.log((e as Error).name, (e as Error).message.includes("not representable in the target union"));
}
console.log("recovered");
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("Child extends Root\nTypeError true\nrecovered\n");
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

  test("a cast to an interface a declaration file declares is checked like one the program declares", async () => {
    // A type has no implementation: an interface from a declarations-only
    // package, from the project's own declaration file or from an ambient
    // module types records the program builds, so untyped data asserted to
    // it goes through the same checked conversion as for an interface in a
    // `.ts` file. Node never checks an `as`; these throw.
    const declared = "interface Book {\n  isbn: string;\n  title: string;\n  year?: number;\n}\n";
    const exported = "export " + declared;
    const body = `
function scan(text: string): string {
  try {
    const book = JSON.parse(text) as Book;
    return "read " + typeof book.isbn + " " + book.title;
  } catch (error) {
    return (error as Error).name + ": " + (error as Error).message;
  }
}
function tally(text: string): string {
  try {
    return String((JSON.parse(text) as Book[]).length);
  } catch (error) {
    return (error as Error).name + ": " + (error as Error).message;
  }
}
console.log(scan('{"isbn":7,"title":"Tides"}'));
console.log(scan('{"isbn":"0-1"}'));
console.log(scan("[1,2]"));
console.log(scan('{"isbn":"0-1","title":"Moss"}'));
console.log(tally('[{"isbn":"0-2","title":"Kelp"},{"isbn":"0-3"}]'));
console.log(tally('[{"isbn":"0-2","title":"Kelp"},{"isbn":"0-3","title":"Ferns","year":1961}]'));
`;
    const expected = [
      "TypeError: expected string at $.isbn, got number",
      "TypeError: expected string at $.title, got undefined",
      "TypeError: expected object at $, got array",
      "read string Moss",
      "TypeError: expected string at $[1].title, got undefined",
      "2",
      "",
    ].join("\n");
    const variants: [string, string, Record<string, string>][] = [
      ["declared-cast-program", declared + body, {}],
      [
        "declared-cast-package",
        `import type { Book } from "shelf-types";\n` + body,
        {
          "node_modules/shelf-types/package.json":
            '{ "version": "0.4.1", "name": "shelf-types", "main": "./shelf.d.ts", "types": "./shelf.d.ts" }\n',
          "node_modules/shelf-types/shelf.d.ts": exported,
        },
      ],
      [
        "declared-cast-file",
        `import type { Book } from "./types.js";\n` + body,
        { "types.d.ts": exported },
      ],
      [
        "declared-cast-ambient",
        `/// <reference path="./shims.d.ts" />\nimport type { Book } from "ambient-types";\n` +
          body,
        { "shims.d.ts": `declare module "ambient-types" {\n${exported}}\n` },
      ],
      [
        "declared-cast-global",
        `/// <reference path="./globals.d.ts" />\n` + body,
        { "globals.d.ts": declared },
      ],
    ];
    for (const [name, source, files] of variants) {
      const r = await compileAndRun(name, source, "ts", false, files);
      expect([name, r.exitCode, r.stdout, r.stderr]).toEqual([name, 0, expected, ""]);
    }
  });

  test("an untyped value returned where the result is declared undefined is checked", async () => {
    // Node hands the caller the value (5, null); a result declared
    // `undefined` has no representation for it, so the return throws.
    const r = await compileAndRun(
      "undefined-result-returns",
      `
      function five(): any { return JSON.parse("5"); }
      function nothing(): any { return JSON.parse("null"); }
      const flag: boolean = process.argv.length < 99;
      type Nothing = undefined;
      function declared(): undefined { return five(); }
      function aliased(): Nothing { return five(); }
      function ofNull(): undefined { return nothing(); }
      function conditional(): undefined { return flag ? five() : undefined; }
      const concise = (): undefined => five();
      const conciseConditional = (): undefined => (flag ? five() : undefined);
      let effects = 0;
      const effect = (): void => { effects++; };
      const conciseVoidArm = (): undefined => (flag ? five() : void effect());
      const conciseVoidTaken = (): undefined => (flag ? void effect() : five());
      const castNumber = (): undefined => 5 as any;
      const castNull = (): undefined => null as any;
      const castUndefined = (): undefined => undefined as any;
      function returnsCastNumber(): undefined { return 5 as any; }
      function returnsCastUndefined(): undefined { return undefined as any; }
      class Holder {
        method(): undefined { return five(); }
        static make(): undefined { return five(); }
      }
      const run = (label: string, f: () => unknown): void => {
        try { console.log(label, f()); }
        catch (error) { console.log(label, (error as Error).name, (error as Error).message); }
      };
      run("declared", () => declared());
      run("aliased", () => aliased());
      run("null", () => ofNull());
      run("conditional", () => conditional());
      run("concise", () => concise());
      run("conciseConditional", () => conciseConditional());
      run("conciseVoidArm", () => conciseVoidArm());
      run("conciseVoidTaken", () => conciseVoidTaken());
      console.log("effects", effects);
      run("castNumber", () => castNumber());
      run("castNull", () => castNull());
      run("castUndefined", () => castUndefined());
      run("returnsCastNumber", () => returnsCastNumber());
      run("returnsCastUndefined", () => returnsCastUndefined());
      run("method", () => new Holder().method());
      run("static", () => Holder.make());
      declared();
    `,
    );
    const message =
      "TypeError a value other than undefined is not representable in a result declared 'undefined' (an untyped value returned it)";
    expect(r.stdout).toBe(
      [
        ...["declared", "aliased", "null", "conditional", "concise", "conciseConditional"].map(
          (label) => `${label} ${message}`,
        ),
        `conciseVoidArm ${message}`,
        "conciseVoidTaken undefined",
        "effects 1",
        `castNumber ${message}`,
        `castNull ${message}`,
        "castUndefined undefined",
        `returnsCastNumber ${message}`,
        "returnsCastUndefined undefined",
        ...["method", "static"].map((label) => `${label} ${message}`),
        "",
      ].join("\n"),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("a value other than undefined is not representable");
  });

  test("a wider default behind an element read stops by name where the element is absent", async () => {
    // `rows[at] ?? wide`: the checker types the read present and so the
    // whole expression as the element; past the end Node answers `wide`
    // itself, which the element's type cannot hold and a copy would not be.
    // The present side answers the element (corpus
    // nullish-absent-read-wider-default-present); the absent side evaluates
    // the default and throws a TypeError that names the form, and the build
    // reports both sites.
    const source = `
      const counts: number[][] = [[1, 2]];
      const anything: (number | string)[] = [7, 8];
      let asked = 0;
      function spare(): (number | string)[] { asked++; return anything; }
      function pick(at: number): number { return (counts[at] ?? anything).length; }
      function lazy(at: number): number { return (counts[at] || spare()).length; }
      console.log(pick(0), lazy(0), asked);
      try { console.log(pick(3)); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
      try { console.log(lazy(3)); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message, asked); }
      console.log(pick(5));
    `;
    const r = await compileAndRun("absent-read-wider-default", source);
    const message = (op: string): string =>
      `the default of '${op}' has a wider type ('(number | string)[]') than the left side ('number[]'), and the left side was absent although its type holds no undefined: the default would be copied to reach the left side's type, where JavaScript answers the default itself (give both sides one type)`;
    expect(r.stdout).toBe(
      ["2 2 0", `true ${message("??")}`, `true ${message("||")} 1`, ""].join("\n"),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`TypeError: ${message("??")}`);

    const file = join(cacheDir, "dyncheck-absent-read-wider-default.ts");
    writeFileSync(file, source);
    const warnings = (analyze(file).coverage.divergences ?? []).filter((d) => d.code === "SC6001");
    expect(warnings.map((d) => d.message)).toEqual([
      "the left side of this default can be absent at run time although its type 'number[]' holds no undefined, and the default has the wider type '(number | string)[]', which reaches the left side's type only as a copy (a conversion to another layout builds a new object), while under Node the result is the default itself: where the left side is absent the program stops here with a TypeError instead of answering a copy",
      "the left side of this default can be absent at run time although its type 'number[]' holds no undefined, and the default has the wider type '(number | string)[]', which reaches the left side's type only as a copy (a conversion to another layout builds a new object), while under Node the result is the default itself: where the left side is absent the program stops here with a TypeError instead of answering a copy",
    ]);
  });
});

describe(`native-handle boundary fences (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  // Handles cross the checked-dynamic boundary as SCR_DYN_HANDLE boxes;
  // the SUCCESS surface is corpus-tested differentially (1795-1798).
  // These pin the honesty ladder — texts Node never prints, because
  // under Node the members exist (the 'not supported yet' Error IS the divergence).

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

  test("a real-but-unmodeled member on a dyn handle throws the 'not supported yet' Error", async () => {
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

  test("an expando write on a dyn handle throws the 'not supported yet' Error (identity would break)", async () => {
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

  test("an unmodeled event registration on a dyn handle throws the 'not supported yet' Error", async () => {
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

  // Exercise native checked-value slots through parameters and aliases.
  const wrapPreamble = `const value: any = { a: 1, list: [1, 2, 3] };
const u: unknown = value;
`;

  test("a keyed read on a native checked value preserves property lookup", async () => {
    const r = await compileAndRun(
      "checked-key-read",
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
    // Every union arm fits the checked-value representation.
    const r = await compileAndRun(
      "checked-collapsed-union-slot",
      `const value: any = ["p1", { languages: ["js"] }];
function firstPlugin(ps: (string | object)[]): void {
  console.log(typeof ps[0]);
}
firstPlugin(value);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("string\n");
  });

  test("a method call on a native checked value uses Array.prototype", async () => {
    const r = await compileAndRun(
      "checked-method",
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

  test("JSON.stringify serializes a native checked value", async () => {
    const r = await compileAndRun(
      "checked-stringify",
      wrapPreamble +
        `console.log(JSON.stringify(u));
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"a":1,"list":[1,2,3]}\n');
  });

  test("structuredClone copies a native checked value", async () => {
    const r = await compileAndRun(
      "checked-clone",
      wrapPreamble +
        `const c = structuredClone(u);
console.log(JSON.stringify(c), c === u);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"a":1,"list":[1,2,3]} false\n');
  });

  test("Object.keys walks a native checked value", async () => {
    const r = await compileAndRun(
      "checked-keys",
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

  test("deepStrictEqual compares native checked values by identity and structure", async () => {
    const r = await compileAndRun(
      "checked-deepeq",
      `import assert from "node:assert";
const value: any = { a: 1 };
const other: any = { a: 1 };
const u1: unknown = value;
const u2: unknown = value;
assert.deepStrictEqual(u1, u2);
console.log("identity ok");
const u3: unknown = other;
assert.deepStrictEqual(u1, u3);
console.log("structure ok");
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("identity ok\nstructure ok\n");
  });

  test("util.inspect formats a native checked value", async () => {
    const r = await compileAndRun(
      "checked-inspect",
      wrapPreamble +
        `console.log(u);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("{ a: 1, list: [ 1, 2, 3 ] }\n");
  });

  test("destructuring and for-of iterate native checked values", async () => {
    const r = await compileAndRun(
      "checked-iterate",
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

  test("a keyed write through a native checked value updates its alias", async () => {
    const r = await compileAndRun(
      "checked-key-write",
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

  test("'in' checks native checked-value properties", async () => {
    const r = await compileAndRun(
      "checked-in",
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
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("true\n");
  });

  test("compound assignment of an untyped string into a number throws like the expanded form", async () => {
    // Node turns `n += "x"` into the string "1x"; a `number` local cannot
    // hold it, so the compound form takes the same checked conversion as
    // `n = n + value` and leaves the local unchanged.
    const r = await compileAndRun(
      "compound-any-string",
      `const d: any = JSON.parse('{"s":"x"}');
let expanded: number = 1;
try { expanded = expanded + d.s; } catch (e) { console.log("expanded", (e as Error).message, expanded); }
let compound: number = 1;
try { compound += d.s; } catch (e) { console.log("compound", (e as Error).message, compound); }
const field = { n: 1 };
try { field.n += d.s; } catch (e) { console.log("field", (e as Error).message, field.n); }
const items: number[] = [1];
try { items[0] += d.s; } catch (e) { console.log("element", (e as Error).message, items[0]); }
let uncaught: number = 1;
uncaught += d.s;
console.log("unreachable", uncaught);
`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe(
      [
        "expanded expected number at $, got string 1",
        "compound expected number at $, got string 1",
        "field expected number at $, got string 1",
        "element expected number at $, got string 1",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toContain("Uncaught TypeError: expected number at $, got string");
  });

  test("Object.values over undeclared source keys checks them into the static result", async () => {
    // The record keeps the parsed object's undeclared keys, so Object.values
    // answers all four values in source order; the static `number[]` result
    // cannot hold the string, so the conversion throws instead of dropping it.
    const r = await compileAndRun(
      "record-source-values",
      `const rows: { score: number }[] = JSON.parse('[{"id":1,"score":2},{"id":0,"name":"n","score":3}]');
console.log(Object.values(rows[0]!).join(","), Object.entries(rows[0]!).length);
try { console.log(Object.values(rows[1]!)); } catch (e) { console.log((e as Error).message); }
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1,2 2\nexpected number at $[1], got string\n");
  });

  test("a checked value RC-balances through catch-and-continue", async () => {
    // The sanitizer lane audits releases while checked values unwind.
    const r = await compileAndRun(
      "checked-fence-unwind",
      `const value: any = { a: 1 };
let caught = 0;
function probe(u: unknown): void {
  try {
    const copy = structuredClone(u);
    if (copy !== u) throw new Error("unwind");
  } catch (e) {
    if (e instanceof Error) caught++;
  }
}
for (let i = 0; i < 100; i++) probe(value);
console.log("done", caught);
`,
      "ts",
      true,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("done 100\n");
  });

  test("an inspection refusal throws before console.log writes", async () => {
    // A promise reached through `unknown` has no dynamic rendering; the
    // refusal must stop the call, not print a partial line and continue.
    const r = await compileAndRun(
      "inspect-refusal-unwind",
      `import { inspect } from "node:util";
const p: unknown = Promise.resolve(3);
function attempt(label: string, f: () => void): void {
  try {
    f();
    console.log(label, "returned");
  } catch (e) {
    console.log(label, (e as Error).message);
  }
}
attempt("log", () => console.log("x", p));
attempt("inspect", () => console.log(inspect(p).length));
attempt("record", () => console.log({ a: p }));
attempt("array", () => console.log([p]));
console.log("before");
console.log(p);
console.log("after");
`,
    );
    const refusal = "util.inspect of a promise value is not supported yet";
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe(
      ["log", "inspect", "record", "array"].map((l) => `${l} ${refusal}\n`).join("") + "before\n",
    );
    expect(r.stderr).toContain(`Uncaught Error: ${refusal}`);
  });

  test("a refusal in a record's kept source properties closes the inspector's frames", async () => {
    // A record converted from an object with undeclared properties renders
    // them through its checked view; a refusal there, inside an enclosing
    // record or array, must not leave that render's frames open.
    const r = await compileAndRun(
      "inspect-refusal-kept-source",
      `import { inspect } from "node:util";
type P = { a: number };
const src = JSON.parse('{"a":1}');
src.p = Promise.resolve(3);
const r: P = src;
function attempt(label: string, f: () => void): void {
  try {
    f();
    console.log(label, "returned");
  } catch (e) {
    console.log(label, (e as Error).message);
  }
}
attempt("record", () => console.log(inspect({ outer: r, n: [1, 2] })));
console.log(inspect({ b: [1, { c: 2 }], long: "x".repeat(70) }));
attempt("array", () => console.log(inspect([r, r])));
console.log([3, 4], { d: 5 });
`,
    );
    const refusal = "util.inspect of a promise value is not supported yet";
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      `record ${refusal}\n` +
        `{\n  b: [ 1, { c: 2 } ],\n  long: '${"x".repeat(70)}'\n}\n` +
        `array ${refusal}\n` +
        "[ 3, 4 ] { d: 5 }\n",
    );
  });

  test("accessors reached through unknown render as Node's accessor tags", async () => {
    const r = await compileAndRun(
      "inspect-accessor-tags",
      `import { format } from "node:util";
const o: unknown = JSON.parse('{"x":1}');
Object.defineProperty(o, "g", { get: () => 2, enumerable: true });
Object.defineProperty(o, "h", { get: () => 3, enumerable: false });
Object.defineProperty(o, "gs", { get: () => 4, set: (_v: number) => {}, enumerable: false });
Object.defineProperty(o, "s", { set: (_v: number) => {}, enumerable: true });
console.log(o);
console.log(format("%o", o));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "{ x: 1, g: [Getter], s: [Setter] }",
        "{",
        "  x: 1,",
        "  g: [Getter],",
        "  [h]: [Getter],",
        "  [gs]: [Getter/Setter],",
        "  s: [Setter]",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("a refused inspection leaves later renders at the default layout", async () => {
    // The refusal's Error skips the call site's layout restore and the
    // render's own exits; later renders must not keep the custom layout,
    // the indentation, showHidden or open frames of the abandoned one.
    const r = await compileAndRun(
      "inspect-refusal-state",
      `import { format, inspect } from "node:util";
const p: unknown = Promise.resolve(1);
const rec: unknown = { a: [1], b: p };
try {
  inspect({ a: [1, 2, 3, 4, 5, 6, 7, 8], b: p }, { breakLength: 20 });
} catch {}
try {
  format("%o", rec);
} catch {}
const long: unknown = JSON.parse(JSON.stringify(Array.from({ length: 12 }, (_, i) => "item" + i)));
console.log(long);
console.log(format("%O", [1]));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "[",
        "  'item0',  'item1',",
        "  'item2',  'item3',",
        "  'item4',  'item5',",
        "  'item6',  'item7',",
        "  'item8',  'item9',",
        "  'item10', 'item11'",
        "]",
        "[ 1 ]",
        "",
      ].join("\n"),
    );
  });

  test("inspecting a compiled class with static fields through unknown refuses", async () => {
    // Node prints `[class S] { count: 3 }`; the class object does not
    // carry compiled static fields, so the inspector refuses rather than
    // print `[class S]`. A class without static fields still prints.
    const r = await compileAndRun(
      "inspect-class-statics",
      `class Plain {}
class S extends Plain {
  static count = 3;
}
const plain: unknown = Plain;
const s: unknown = S;
console.log(plain);
try {
  console.log(s);
} catch (e) {
  console.log((e as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "[class Plain]\nutil.inspect of a class with static fields through unknown is not supported yet\n",
    );
  });

  test("%o refuses the dynamic kinds whose hidden entries have no rendering", async () => {
    // Node's showHidden adds a function's length/name/prototype and an
    // error's enumerable properties; %o throws the 'not supported yet'
    // Error for them instead of printing without them. A typed array's
    // byte fields do render; a SharedArrayBuffer's own accessors do not.
    const r = await compileAndRun(
      "format-o-hidden-refusals",
      `import { format } from "node:util";
function f(): void {}
const sab = new SharedArrayBuffer(1);
const values: [string, unknown][] = [["fn", f], ["err", new Error("e")], ["u8", new Uint8Array(1)], ["arr", [1]], ["sab", sab], ["sabView", new Uint8Array(sab)]];
for (const [label, value] of values) {
  try {
    console.log(label, format("%o", value));
  } catch (e) {
    console.log(label, (e as Error).message);
  }
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "fn util.format %o of function values is not supported yet",
        "err util.format %o of Error values is not supported yet",
        "u8 Uint8Array(1) [",
        "  0,",
        "  [BYTES_PER_ELEMENT]: 1,",
        "  [length]: 1,",
        "  [byteLength]: 1,",
        "  [byteOffset]: 0,",
        "  [buffer]: ArrayBuffer { [byteLength]: 1 }",
        "]",
        "arr [ 1, [length]: 1 ]",
        "sab util.format %o of SharedArrayBuffer values is not supported yet",
        "sabView util.format %o of SharedArrayBuffer values is not supported yet",
        "",
      ].join("\n"),
    );
  });

  test("console.dir renders showHidden through the checked-dynamic walk and refuses the kinds it has no hidden view of", async () => {
    // dir is inspect with customInspect: false, so the hidden entries come
    // from the walk's showHidden state; the kinds without a hidden view
    // keep their refusal, naming console.dir.
    const r = await compileAndRun(
      "console-dir-show-hidden",
      `const arr: any = [1, 2];
arr.extra = 3;
Object.defineProperty(arr, "hidden", { value: 4, enumerable: false });
console.dir(arr, { showHidden: true });
console.dir(arr);
function f(): void {}
try {
  console.dir(f, { showHidden: true });
} catch (e) {
  console.log((e as Error).message);
}
const sab = new SharedArrayBuffer(1);
try {
  console.dir(new Uint8Array(sab), { showHidden: true });
} catch (e) {
  console.log((e as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "[ 1, 2, [length]: 2, extra: 3, [hidden]: 4 ]",
        "[ 1, 2, extra: 3 ]",
        "console.dir with showHidden of function values is not supported yet",
        "console.dir with showHidden of SharedArrayBuffer values is not supported yet",
        "",
      ].join("\n"),
    );
  });

  test("showHidden refuses the renders that would expose a SharedArrayBuffer's byte accessors", async () => {
    // Node lists a SharedArrayBuffer's own byteLength, maxByteLength and
    // growable accessors and its toStringTag symbol under showHidden, which
    // this inspector does not model: the render throws SC2020 instead of
    // printing without them, for a view's [buffer] as much as the buffer
    // itself. Without showHidden the buffer and its views print.
    const r = await compileAndRun(
      "inspect-shared-array-buffer-hidden",
      `import { inspect } from "node:util";
const sab = new SharedArrayBuffer(4);
const renders: [string, () => string][] = [
  ["sab", () => inspect(sab, { showHidden: true })],
  ["view", () => inspect(new Uint8Array(sab, 1, 2), { showHidden: true })],
  ["dataView", () => inspect(new DataView(sab, 1, 2), { showHidden: true })],
];
for (const [label, render] of renders) {
  try {
    console.log(label, render());
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(label, err.code, err.message);
  }
}
console.log(inspect(sab));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "sab SC2020 util.inspect with showHidden of SharedArrayBuffer values is not supported yet",
        "view SC2020 util.inspect with showHidden of SharedArrayBuffer values is not supported yet",
        "dataView SC2020 util.inspect with showHidden of SharedArrayBuffer values is not supported yet",
        "SharedArrayBuffer { [Uint8Contents]: <00 00 00 00>, [byteLength]: 4 }",
        "",
      ].join("\n"),
    );
  });

  test("collection seeds from a dynamic iterable convert every element through the checked boundary", async () => {
    // `new Set(x)` / `new Map(x)` over a checked-dynamic source seed the
    // declared collection by iterating with the dynamic iterator protocol and
    // converting each element (and each Map key and value) through the existing
    // checked conversion. A lying view — a marked accessor whose data members
    // are typed Set<string> / Map<string, number> but hold JSON arrays — makes
    // the conversion fail where Node, which never checks, copies silently: the
    // documented checked-dynamic divergence. The seed stops at the first bad
    // element and the TypeError is catchable.
    const r = await compileAndRun(
      "collection-dyn-seed-checked",
      `interface State {
  readonly label: string;
  readonly pending: Set<string>;
  readonly table: Map<string, number>;
}
function create(): State {
  return {
    get label(): string {
      return "agent";
    },
    pending: JSON.parse("[1,2]"),
    table: JSON.parse("[[1,2]]"),
  };
}
class Owner {
  private m: State = create();
  get state(): State {
    return this.m;
  }
}
const owner = new Owner();
try {
  const copy = new Set(owner.state.pending);
  console.log("set-ok", copy.size);
} catch (error) {
  console.log("set-threw", (error as Error).name, (error as Error).message);
}
try {
  const table = new Map(owner.state.table);
  console.log("map-ok", table.size);
} catch (error) {
  console.log("map-threw", (error as Error).name, (error as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "set-threw TypeError expected string at $, got number",
        "map-threw TypeError expected string at $, got number",
        "",
      ].join("\n"),
    );
  });

  test("a function reached through a narrower slot refuses an argument its parameter cannot hold", async () => {
    // The checker admits both steps: a function with an optional parameter
    // into a slot without it, and that slot into one whose extra parameter
    // has another type. Node hands the function the value its type
    // excludes. The wide slot's value is built from the function, so the
    // mismatch is the function's own: invoking the slot throws, and a
    // function that has no such parameter still ignores the argument.
    const r = await compileAndRun(
      "function-view-stranded",
      `
      function fixed(a: string, digits?: number): string { return a + (digits === undefined ? "" : (1).toFixed(digits)); }
      function plain(a: string): string { return a + "!"; }
      function narrowOf(f: (a: string) => string): (a: string) => string { return f; }
      function widen(f: (a: string) => string): (a: string, b: string) => string { return f; }
      console.log(widen(narrowOf(plain))("x", "y"), narrowOf(fixed)("x"));
      try { console.log(widen(narrowOf(fixed))("x", "y")); }
      catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "x! x",
        "true a '(string, number | undefined) => string' function invoked through a '(string, string) => string' slot (the parameter types cannot convert — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toBe("");
  });

  test("an untyped call reaches the function behind a slot; the slot's type and the function's own still check", async () => {
    // A function that passed through a typed slot is checked against what
    // it declares. Three claims remain the program's and still throw where
    // Node proceeds: a call through the slot's type, the parameter type the
    // function itself declares, and a function whose parameter type the
    // slot gave it.
    const r = await compileAndRun(
      "untyped-call-through-slot-claims",
      `
      interface Payload { diff: string; path: string }
      type Show = (payload: Payload) => string;
      function loose(payload: any): string { return "loose " + JSON.stringify(payload); }
      function narrow(payload: { diff: string }): string { return "narrow " + payload.diff; }
      const viaLoose: { show: Show } = { show: loose };
      const viaNarrow: { show: Show } = { show: narrow };
      const viaSlot: { show: Show } = { show: (payload) => "typed " + payload.diff };
      const empty: any = {};
      const attempt = (label: string, call: () => string): void => {
        try { console.log(label, call()); }
        catch (error) { console.log(label, error instanceof TypeError, (error as Error).message); }
      };
      // No claim on either side: the function runs.
      const looseWide: (payload: any) => string = viaLoose.show;
      const looseAny: any = viaLoose.show;
      attempt("wider type:", () => looseWide(empty));
      attempt("any:", () => looseAny(empty));
      // The call through the slot's type.
      attempt("slot type, asserted:", () => viaLoose.show(empty as Payload));
      attempt("slot type, any argument:", () => viaLoose.show(empty));
      // The function's own parameter type.
      const narrowWide: (payload: any) => string = viaNarrow.show;
      const narrowAny: any = viaNarrow.show;
      attempt("own type, wider type:", () => narrowWide(empty));
      attempt("own type, any:", () => narrowAny(empty));
      attempt("own type, admitted:", () => narrowWide({ diff: "d" }));
      // The function typed by the slot.
      const slotWide: (payload: any) => string = viaSlot.show;
      attempt("typed by the slot:", () => slotWide(empty));
    `,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "wider type: loose {}",
        "any: loose {}",
        "slot type, asserted: true expected string at $.diff, got undefined",
        "slot type, any argument: true expected string at $.diff, got undefined",
        "own type, wider type: true expected string at $.diff, got undefined",
        "own type, any: true expected string at $[0].diff, got undefined",
        "own type, admitted: narrow d",
        "typed by the slot: true expected string at $.diff, got undefined",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toBe("");
  });

  test("an untyped Map or Set converts to a typed collection type only when every entry conforms, and stays one collection", async () => {
    // The conforming conversions are differential (corpus
    // untyped-collection-typed-slot.ts). Here: what throws where Node, which
    // checks nothing, runs. A non-conforming entry names its position in
    // iteration order, then 0 for a key and 1 for a value; the collection is
    // left as it was. A converted collection has ONE typed layout: another
    // typed collection type and a non-conforming write through the untyped
    // side are refused by name, never answered with a copy.
    const r = await compileAndRun(
      "untyped-collection-typed-slot-failures",
      `function invoke(callee: unknown, argument: unknown): unknown {
  if (typeof callee === "function") return callee(argument);
  return undefined;
}
function attempt(label: string, body: () => unknown): void {
  try {
    console.log(label + ": " + String(body()));
  } catch (error) {
    console.log(label + ": " + (error instanceof TypeError) + " " + (error as Error).message);
  }
}
function total(counts: Map<string, number>): number {
  let sum = 0;
  for (const [, count] of counts) sum += count;
  return sum;
}
function size(names: Set<string>): number {
  return names.size;
}
function loose(counts: Map<string, unknown>): number {
  return counts.size;
}
interface Booking {
  guest: string;
  nights: number;
}
function nights(byRoom: Map<string, Booking>): number {
  let sum = 0;
  for (const [, booking] of byRoom) sum += booking.nights;
  return sum;
}
const badValue = new Map<unknown, unknown>([["a", 1], ["b", "two"]]);
attempt("value", () => invoke(total, badValue));
const hidden: unknown = badValue;
attempt("value, cast", () => total(hidden as Map<string, number>));
attempt("still untyped", () => badValue.size + " " + String(badValue.get("b")));
const badKey = new Map<unknown, unknown>([["a", 1], [2, 2]]);
attempt("key", () => invoke(total, badKey));
const badMember = new Set<unknown>(["a", 2]);
attempt("member", () => invoke(size, badMember));
attempt("not a collection", () => invoke(total, { size: 0 }));
attempt("a set for a map", () => invoke(total, new Set<unknown>(["a"])));
const good = new Map<unknown, unknown>([["a", 1]]);
attempt("first typed view", () => invoke(total, good));
attempt("another typed layout", () => invoke(loose, good));
attempt("non-conforming write through the untyped side", () => good.set("b", "two").size);
attempt("conforming write through the untyped side", () => good.set("b", 2).size);
attempt("typed view again", () => invoke(total, good));
const bornTyped = new Map<string, number | string>([["a", 1]]);
attempt("born with another layout", () => invoke(total, bornTyped));
const held: unknown = JSON.parse('{"guest":"eve","nights":2}');
const sharing = new Map<unknown, unknown>([["r1", held]]);
attempt("an entry something else holds", () => invoke(nights, sharing));
const pruned = new Map<unknown, unknown>([["a", 1], ["b", 2], ["c", 3]]);
pruned.delete("a");
attempt("first view while iterated past a removed entry", () => {
  let out = "";
  for (const [key] of pruned) out += String(key) + String(invoke(total, pruned));
  return out;
});
attempt("first view after that loop", () => invoke(total, pruned));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "value: true expected number at $[0][1][1], got string",
        "value, cast: true expected number at $[1][1], got string",
        "still untyped: 2 two",
        "key: true expected string at $[0][1][0], got number",
        "member: true expected string at $[0][1], got number",
        "not a collection: true expected map<string,f64> at $[0], got object",
        "a set for a map: true expected map<string,f64> at $[0], got Set",
        "first typed view: 1",
        "another typed layout: true expected map<string,dyn> at $[0], got Map",
        "non-conforming write through the untyped side: true expected number at $, got string",
        "conforming write through the untyped side: 2",
        "typed view again: 3",
        "born with another layout: true expected map<string,f64> at $[0], got Map",
        "an entry something else holds: true expected object that nothing else references (a typed Map takes its entries without copying them) at $[0][0][1], got object",
        "first view while iterated past a removed entry: true expected map<string,f64> at $[0], got Map",
        "first view after that loop: 5",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toBe("");
  });

  test("an entry of an untyped Map or Set converts only when nothing else holds what it holds, and the collection must not change while it is checked", async () => {
    // A typed collection takes its entries without copying them: a plain
    // object or array converts to a typed value, so one that the program
    // still reaches another way, at any depth of an entry, would become
    // two objects. Node, which converts nothing, runs these; here they
    // throw by name with the path of the held value. So does a collection
    // that a getter of an entry writes to while the entries are checked.
    const r = await compileAndRun(
      "untyped-collection-typed-slot-held-members",
      `function invoke(callee: unknown, argument: unknown): unknown {
  if (typeof callee === "function") return callee(argument);
  return undefined;
}
function attempt(label: string, body: () => unknown): void {
  try {
    console.log(label + ": " + String(body()));
  } catch (error) {
    console.log(label + ": " + (error instanceof TypeError) + " " + (error as Error).message);
  }
}
interface Stay {
  room: number;
  guests: string[];
}
interface Pair {
  first: Stay;
  second: Stay;
}
function rooms(byGuest: Map<string, Stay>): number {
  let sum = 0;
  for (const [, stay] of byGuest) sum += stay.room;
  return sum;
}
function listed(all: Set<Stay[]>): number {
  return all.size;
}
function paired(all: Map<string, Pair>): number {
  return all.size;
}
function stayWith(guests: unknown): unknown {
  const stay: any = JSON.parse('{"room":4}');
  stay.guests = guests;
  return stay;
}
function listOf(stay: unknown): unknown {
  const list: any = JSON.parse("[null]");
  list[0] = stay;
  return list;
}
function twice(): unknown {
  const pair: any = JSON.parse("{}");
  pair.first = JSON.parse('{"room":2,"guests":[]}');
  pair.second = pair.first;
  return pair;
}
attempt("members of its own", () => invoke(rooms, new Map<unknown, unknown>([["ada", stayWith(JSON.parse('["bo"]'))]])));
const guests: unknown = JSON.parse('["ada"]');
attempt("a member something else holds", () => invoke(rooms, new Map<unknown, unknown>([["ada", stayWith(guests)]])));
const kept: unknown = JSON.parse('{"room":2,"guests":[]}');
attempt("an element something else holds", () => invoke(listed, new Set<unknown>([listOf(kept)])));
attempt("one object under two members", () => invoke(paired, new Map<unknown, unknown>([["p", twice()]])));
const changing = new Map<unknown, unknown>();
let acted = false;
function watched(): unknown {
  const stay: any = JSON.parse('{"guests":[]}');
  Object.defineProperty(stay, "room", {
    enumerable: true,
    get: () => {
      if (!acted) {
        acted = true;
        changing.set("ada", JSON.parse('{"room":9,"guests":[]}'));
      }
      return 1;
    },
  });
  return stay;
}
changing.set("ada", JSON.parse('{"room":4,"guests":[]}'));
changing.set("bo", watched());
attempt("an entry written while the entries are checked", () => invoke(rooms, changing));
attempt("the same collection afterwards", () => invoke(rooms, changing));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "members of its own: 4",
        "a member something else holds: true expected array that nothing else references (a typed Map or Set takes its entries without copying them) at $[0][0][1].guests, got array",
        "an element something else holds: true expected object that nothing else references (a typed Map or Set takes its entries without copying them) at $[0][0][0], got object",
        "one object under two members: true expected object that nothing else references (a typed Map or Set takes its entries without copying them) at $[0][0][1].first, got object",
        "an entry written while the entries are checked: true expected Map whose entries stay as they are while they are checked at $[0], got Map",
        "the same collection afterwards: 10",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toBe("");
  });
});
