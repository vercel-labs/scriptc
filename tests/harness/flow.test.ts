/* Flow projects (a package.json `scriptc.flow` setting). Each fixture under
 * tests/fixtures/flow compiles from its Flow sources, and Node runs a copy
 * with the Flow modules' types removed (flow-strip.ts), the project's
 * `constants` defined as globals and its `moduleSubstitutions` applied, as a
 * build of the project for Node would. stdout, stderr and the exit status
 * must match. The other tests pin what Node cannot run: Flow syntax scriptc
 * refuses or cannot parse, fence locations, a recursive generic union whose
 * generic code fences, a Flow entry, a TypeScript file beside a Flow file,
 * JSX, and the lowering of constructor functions and typed `this`. */
import { execFile } from "node:child_process";
import { cpSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import type { IrModule } from "../../packages/compiler/src/ir/ir.js";
import { hasFlowPragma } from "../../packages/compiler/src/frontend/flow/index.js";
import { stripFlowTypes } from "./flow-strip.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const flowRoot = join(repoRoot, "tests/fixtures/flow");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "utf8" });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number" || e.stdout === undefined || e.stderr === undefined) throw err;
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

function comparableStderr(text: string): string {
  return sanitize
    ? text
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("scriptc RC audit skipped:") &&
            !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
        )
        .join("\n")
    : text;
}

interface FlowProject {
  flow?: true | { all?: boolean };
  constants?: Record<string, unknown>;
  moduleSubstitutions?: Record<string, string>;
}

/** The fixture as Node runs it: a copy with the Flow modules' types removed
 * (the modules scriptc treats as Flow: `.js` files outside node_modules with
 * a pragma, or all of them with `"all": true`), substituted modules replaced
 * by their substitutes, and a preload that defines the constants. It does
 * not model a `.ts` file beside a Flow file taking its place, and a copied
 * substitute resolves its own relative imports from the replaced module's
 * directory, so fixtures avoid both. */
function nodeCopy(fixture: string): { entry: string; preload: string } {
  const dir = tempDir(`scriptc-flow-${fixture}-`);
  cpSync(join(flowRoot, fixture), dir, {
    recursive: true,
    filter: (path) => basename(path) !== ".scriptc",
  });
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    scriptc?: FlowProject;
  };
  const project = manifest.scriptc ?? {};
  const all = typeof project.flow === "object" && project.flow.all === true;
  for (const file of globSync("**/*.js", { cwd: dir })) {
    if (file.split(/[\\/]/).includes("node_modules")) continue;
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    if (all || hasFlowPragma(text)) writeFileSync(path, stripFlowTypes(text));
  }
  for (const [from, to] of Object.entries(project.moduleSubstitutions ?? {}))
    cpSync(join(dir, to), join(dir, from));
  const preload = join(dir, "constants.mjs");
  writeFileSync(
    preload,
    Object.entries(project.constants ?? {})
      .map(([name, value]) => `globalThis.${name} = ${JSON.stringify(value)};\n`)
      .join(""),
  );
  return { entry: join(dir, "main.mjs"), preload };
}

async function build(entry: string): Promise<string> {
  const outDir = tempDir("scriptc-flow-build-");
  const result = await compile(entry, { outPath: join(outDir, "program"), outDir, sanitize });
  expect(
    result.ok,
    result.ok ? "" : result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
  ).toBe(true);
  if (!result.ok) throw new Error("build failed");
  return result.binaryPath;
}

const fixtures = globSync("*/package.json", { cwd: flowRoot })
  .map((file) => relative(".", join(file, "..")))
  .sort();

test.each(fixtures)("flow project %s matches Node", async (fixture) => {
  const { entry, preload } = nodeCopy(fixture);
  const reference = await run(process.execPath, ["--import", preload, entry]);
  const actual = await run(await build(join(flowRoot, fixture, "main.mjs")), []);
  actual.stderr = comparableStderr(actual.stderr);
  expect(actual).toEqual(reference);
});

/** A Flow project in a temporary directory: `files` by relative path. */
function project(files: Record<string, string>, scriptc: object = { flow: true }): string {
  const dir = tempDir("scriptc-flow-project-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", scriptc }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

test("a Flow module that does not translate is a diagnostic at its Flow source", async () => {
  const dir = project({
    "status.js": "// @flow\nenum Status {\n  Active,\n}\nexport const active = Status.Active;\n",
    "broken.js": "// @flow\nexport const x: = 1;\n",
    "main.mjs":
      'import { active } from "./status.js";\nimport { x } from "./broken.js";\nconsole.log(active, x);\n',
  });
  const result = await compile(join(dir, "main.mjs"), {
    outPath: join(dir, "program"),
    outDir: dir,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const located = result.diagnostics
    .filter((d) => d.loc.file.endsWith(".js"))
    .map((d) => [d.code, d.message, relative(dir, d.loc.file), d.loc.start])
    .sort();
  expect(located).toEqual([
    ["SC0001", "Flow syntax error: unexpected token in type annotation", "broken.js", 25],
    ["SC1090", "Flow enums are not supported yet", "status.js", 9],
  ]);
});

test("a runtime fence in a Flow module names its Flow source and line", async () => {
  // The function above the fence reads `arguments`, so the translation
  // inserts an overload line before it as well as the header line.
  const dir = project({
    "fence.js":
      "// @flow\nexport function count(a: string): number {\n  return arguments.length;\n}\nexport function probe(): mixed {\n  return ArrayBuffer.prototype;\n}\n",
    "main.mjs":
      'import { probe } from "./fence.js";\ntry {\n  probe();\n} catch (error) {\n  console.log(error.message);\n}\n',
  });
  const { stdout } = await run(await build(join(dir, "main.mjs")), []);
  expect(stdout).toContain(`[SC2020 at ${join(dir, "fence.js")}:6]`);
});

test("a recursive generic union whose mapping fails compiles, and its generic code defers to a runtime fence", async () => {
  // A generic cache node: inside a generic function the union has no static
  // layout. The build succeeds (it once failed with an internal error), the
  // code that does not need the layout runs, and the generic code that does
  // throws the fence where it runs.
  const dir = project({
    "cache.js": `// @flow
type Open<T> = {s: 0, v: void, p: null | Map<string, CacheNode<T>>};
type Done<T> = {s: 1, v: T, p: null | Map<string, CacheNode<T>>};
type CacheNode<T> = Done<T> | Open<T>;

function createCacheNode<T>(): CacheNode<T> {
  return {s: 0, v: undefined, p: null};
}

function child<T>(node: CacheNode<T>, key: string): CacheNode<T> {
  let map: null | Map<string, CacheNode<T>> = node.p;
  if (map === null) map = new Map();
  let next = map.get(key);
  if (next === undefined) {
    next = createCacheNode();
    map.set(key, next);
  }
  return next;
}

export function root(): CacheNode<number> {
  return createCacheNode();
}

export function childOf(node: CacheNode<number>, key: string): CacheNode<number> {
  return child(node, key);
}

export function status(node: {s: number, p: mixed}): string {
  return (node.s === 1 ? 'done' : 'open') + (node.p === null ? ' leaf' : ' branch');
}
`,
    "main.mjs": `import { childOf, root, status } from "./cache.js";
const node = root();
console.log(status(node));
try {
  childOf(node, "a");
} catch (error) {
  console.log(/\\[SC\\d{4} at .*cache\\.js:15\\]$/.test(error.message));
}
`,
  });
  const { stdout, exitCode } = await run(await build(join(dir, "main.mjs")), []);
  expect([stdout, exitCode]).toEqual(["open leaf\ntrue\n", 0]);
});

test("a Flow module can be the program's entry", async () => {
  const dir = project({
    "main.js":
      "// @flow\nfunction double(n: number): number {\n  return n * 2;\n}\nconsole.log(double(21));\n",
  });
  const { stdout } = await run(await build(join(dir, "main.js")), []);
  expect(stdout).toBe("42\n");
});

test("a TypeScript file beside a Flow file takes its place", async () => {
  // The Flow file does not parse, so presenting it would fail the build.
  const dir = project({
    "greeting.js": "// @flow\nexport const greeting: = 'from flow';\n",
    "greeting.ts": 'export const greeting: string = "from typescript";\n',
    "main.mjs": 'import { greeting } from "./greeting.js";\nconsole.log(greeting);\n',
  });
  const { stdout } = await run(await build(join(dir, "main.mjs")), []);
  expect(stdout).toBe("from typescript\n");
});

test("a Flow module with JSX compiles as TSX, generic arrow functions included", async () => {
  const dir = project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, jsx: "react", jsxFactory: "h", module: "esnext" },
    }),
    "page.js": `// @flow
export function h(tag: string, props: mixed, ...children: Array<string>): string {
  return '<' + tag + '>' + children.join('') + '</' + tag + '>';
}

export function page(title: string): string {
  return <p>{title}</p>;
}

export const pick = <T>(value: T): T => value;
`,
    "main.mjs": 'import { page, pick } from "./page.js";\nconsole.log(page("hi"), pick(3));\n',
  });
  const { stdout } = await run(await build(join(dir, "main.mjs")), []);
  expect(stdout).toBe("<p>hi</p> 3\n");
});

async function lowered(entry: string): Promise<IrModule> {
  const outDir = tempDir("scriptc-flow-ir-");
  const outPath = join(outDir, "program.ir.json");
  const result = await compile(entry, { outPath, outDir, outputKind: "ir" });
  expect(result.ok).toBe(true);
  return JSON.parse(readFileSync(outPath, "utf8")) as IrModule;
}

test("only a constructor function the program calls with `new` alone, with a body of field writes, builds a record", async () => {
  const ir = await lowered(join(flowRoot, "constructor-functions", "main.mjs"));
  const factories = ir.functions
    .map((f) => /^%new\.(\w+)/.exec(f.name)?.[1])
    .filter((name) => name !== undefined);
  // Not ReadingPoint (reads `this`), ExtraPoint (a field the record lacks),
  // AliasedPoint (used under another name), MethodPoint (its prototype),
  // EarlyPoint (returns), CountingTag (reads `arguments`) nor LaterPoint
  // (reads a local declared after the read).
  expect(factories.sort()).toEqual(["OptionalPoint", "PlainPoint", "SwappedPoint"]);
});

test("a constructor function that a class extends keeps the object it constructs", async () => {
  // The class definition throws at run time (extending a function is not
  // supported), so only the lowering is compared.
  const dir = project({
    "points.js": `// @flow
type Point = {x: number, y: number};
function ParentPoint(this: $FlowFixMe, x: number, y: number) {
  this.x = x;
  this.y = y;
}
export class ChildPoint extends ParentPoint {}
export function make(): Point {
  const p: Point = new (ParentPoint: any)(1, 2);
  return p;
}
`,
    "main.mjs": 'import { make } from "./points.js";\nconsole.log(make());\n',
  });
  const ir = await lowered(join(dir, "main.mjs"));
  expect(ir.functions.filter((f) => f.name.startsWith("%new.")).map((f) => f.name)).toEqual([]);
});

test("a spread whose type is a union overrides the keys of each arm", async () => {
  const dir = project({
    "shapes.js": `// @flow
type B = {a: string} | {b: boolean};
type C = {a: number, ...B};
export function describe(c: C): string {
  return typeof c.a === "string" ? "string " + c.a : "number " + String(c.a);
}
`,
    "main.mjs": 'import { describe } from "./shapes.js";\nconsole.log(describe({a: "x"}));\n',
  });
  const ir = await lowered(join(dir, "main.mjs"));
  const shape = (shapeId: string): string =>
    (ir.records ?? [])
      .find((r) => r.id === shapeId)!
      .fields.map((f) => `${f.name}:${f.type.kind}`)
      .join(",");
  // The arm that carries `a` takes the spread's type, and the arm that does
  // not keeps the earlier one. Omitting the keys the whole union shares
  // instead leaves `a` both `number` and `string` in the first arm, and the
  // value lowers to a throw at the conversion.
  const arms = (ir.unions ?? [])
    .filter((u) => u.arms.every((a) => a.kind === "record"))
    .map((u) => u.arms.map((a) => (a.kind === "record" ? shape(a.shapeId) : "")).sort());
  expect(arms).toContainEqual(["a:f64,b:bool", "a:string"]);
});

test("an array elision in a Flow module translates", async () => {
  const dir = project({
    "shapes.js": `// @flow
export const xs = [1, , 3];
export const holes = [, ,];
export function pick([a, , b]: Array<number>): number {
  return a + b;
}
`,
    "main.mjs":
      'import { xs, holes, pick } from "./shapes.js";\nconsole.log(xs.length, holes.length, pick([1, 2, 3]));\n',
  });
  const ir = await lowered(join(dir, "main.mjs"));
  expect(ir.functions.some((f) => f.sourceName === "pick")).toBe(true);
});

test("a function with a typed `this` takes it as its first parameter when every use binds the receiver", async () => {
  const ir = await lowered(join(flowRoot, "receivers", "main.mjs"));
  const params = (name: string): string[] =>
    ir.functions.find((f) => f.sourceName === name)!.params.map((p) => `${p.name}:${p.type.kind}`);
  expect(params("finishTask")).toEqual(["this:record", "task:record"]);
  expect(params("noteTask")).toEqual(["this:record", "task:record", "id:f64"]);
  // Exported under another name, so its uses there are not all seen.
  expect(params("markTask")).toEqual(["task:record"]);
});
