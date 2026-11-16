/* A relative `.js` specifier resolves to a sibling declaration (`a.d.ts`
 * beside `a.js`) for its types, as tsc resolves it, while the module the
 * build compiles is the JavaScript Node loads. The declaration types the
 * call site; the JavaScript provides the implementation. A declaration
 * beside its implementation is also a file a project's tsconfig `include`
 * loads, so it must stay in the program instead of being hidden.
 *
 * The corpus program sibling-declaration-types runs the same shape under
 * Node and as a compiled binary. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/sibling-declaration");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** A project directory holding `files`, keyed by relative path. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-twin-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

async function build(entry: string, name: string) {
  mkdirSync(outDir, { recursive: true });
  return compile(entry, { outPath: join(outDir, name), outDir, sanitize });
}

function messages(result: Awaited<ReturnType<typeof build>>): string {
  return result.ok ? "" : result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
}

test(
  "a relative .js import is typed by its sibling declaration",
  { timeout: 600_000 },
  async () => {
    const dir = project({
      // The declaration makes `name` optional; the JavaScript's inferred
      // parameter type makes it required.
      "lib.d.ts": "export declare function greet(props: { name?: string }): string;\n",
      "lib.js": 'export function greet({ name }) {\n  return "hi " + name;\n}\n',
      "main.ts":
        'import { greet } from "./lib.js";\n' +
        "console.log(greet({}));\n" +
        'console.log(greet({ name: "ada" }));\n',
    });
    const result = await build(join(dir, "main.ts"), "typed-by-declaration");
    expect(messages(result)).toBe("");
    if (!result.ok) return;
    const { stdout } = await execFileAsync(result.binaryPath, [], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(stdout).toBe("hi undefined\nhi ada\n");
  },
);

test(
  "a call the sibling declaration rejects fails, as tsc rejects it",
  { timeout: 600_000 },
  async () => {
    const dir = project({
      "lib.d.ts": "export declare function add(a: number, b: number): number;\n",
      "lib.js": "export function add(a, b) {\n  return a + b;\n}\n",
      "main.ts": 'import { add } from "./lib.js";\nconsole.log(add("1", 2));\n',
    });
    const result = await build(join(dir, "main.ts"), "declaration-rejects");
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "SC0001: Argument of type 'string' is not assignable to parameter of type 'number'.",
    );
  },
);

test(
  "a declaration beside its implementation stays in a JSX project's program",
  { timeout: 600_000 },
  async () => {
    // The shape a vendored dependency takes: the build copies a package's
    // module beside a declaration bridge that re-exports the package's own
    // declarations, and the project's tsconfig `include` loads both. The
    // bridge is a project file with a `.js` sibling, so a project declaration
    // hidden from the checker would be reported here as a missing file.
    const dir = project({
      "package.json": '{ "type": "module" }\n',
      "tsconfig.json":
        '{\n  "compilerOptions": {\n    "jsx": "react",\n    "jsxFactory": "h",\n' +
        '    "strict": true,\n    "moduleResolution": "bundler",\n' +
        '    "module": "ESNext",\n    "target": "ES2022"\n  }\n}\n',
      "props-types.d.ts": "export declare function Card(props: { title?: string }): string;\n",
      "jsx.d.ts":
        "declare namespace JSX {\n  interface IntrinsicElements {\n    div: { children?: unknown };\n  }\n}\n",
      "deps/d1-props.d.ts": 'export * from "../props-types";\n',
      "deps/d1-props.js": "export function Card({ title }) {\n  return title;\n}\n",
      "app.tsx":
        'import { Card } from "./deps/d1-props.js";\n' +
        "function h(tag: unknown, props: unknown, ..._children: unknown[]): string {\n" +
        '  return typeof tag === "function" ? String((tag as (p: unknown) => unknown)(props)) : String(tag);\n}\n' +
        "console.log(Card({}));\n" +
        "console.log(<div />);\n",
    });
    const result = await build(join(dir, "app.tsx"), "jsx-bridge");
    expect(messages(result)).not.toContain("not found");
    expect(messages(result)).toBe("");
  },
);

test(
  "a vendored CommonJS copy is typed by its .d.cts bridge, JSX props included",
  { timeout: 600_000 },
  async () => {
    // The shape a React + UI SDK app takes: htmlc copies each package module
    // into the build directory and writes a declaration bridge beside it
    // (`d1-card.d.cts` for `d1-card.cjs`, `d2-badge.d.mts` for
    // `d2-badge.mjs`) that re-exports the package's own declarations. A copy
    // typed by its own JavaScript makes every prop required.
    const files = {
      "package.json": '{ "type": "module" }\n',
      "tsconfig.json":
        '{\n  "compilerOptions": {\n    "jsx": "react",\n    "jsxFactory": "h",\n' +
        '    "strict": true,\n    "moduleResolution": "bundler",\n' +
        '    "module": "ESNext",\n    "target": "ES2022"\n  }\n}\n',
      "jsx.d.ts":
        "declare namespace JSX {\n  interface IntrinsicElements {\n    div: { children?: unknown };\n  }\n}\n",
      "card-types.d.ts":
        "export declare function Card(props: { title?: string; children?: unknown }): string;\n",
      "badge-types.d.ts":
        'export declare function Badge(props: { tone?: "info" | "warn" }): string;\n',
      "deps/d1-card.d.cts": 'export * from "../card-types";\n',
      "deps/d1-card.cjs": 'exports.Card = function ({ title }) {\n  return "card " + title;\n};\n',
      "deps/d2-badge.d.mts": 'export * from "../badge-types";\n',
      "deps/d2-badge.mjs": 'export function Badge({ tone }) {\n  return "badge " + tone;\n}\n',
    };
    const app = project({
      ...files,
      "app.tsx":
        'import { Card } from "./deps/d1-card.cjs";\n' +
        'import { Badge } from "./deps/d2-badge.mjs";\n' +
        "function h(tag: unknown, props: unknown, ..._children: unknown[]): string {\n" +
        '  return typeof tag === "function" ? String((tag as (p: unknown) => unknown)(props)) : String(tag);\n}\n' +
        "console.log(Card({}));\n" +
        'console.log(<Card title="t" />);\n' +
        'console.log(<Badge tone="info" />);\n',
    });
    const result = await build(join(app, "app.tsx"), "cjs-mjs-bridge");
    expect(messages(result)).toBe("");
    if (!result.ok) return;
    const { stdout } = await execFileAsync(result.binaryPath, [], {
      cwd: app,
      encoding: "utf8",
    });
    expect(stdout).toBe("card undefined\ncard t\nbadge info\n");

    const bad = project({
      ...files,
      "bad.tsx":
        'import { Badge } from "./deps/d2-badge.mjs";\n' +
        "function h(tag: unknown, props: unknown, ..._children: unknown[]): string {\n" +
        '  return typeof tag === "function" ? String((tag as (p: unknown) => unknown)(props)) : String(tag);\n}\n' +
        'console.log(<Badge tone="loud" />);\n',
    });
    const rejected = await build(join(bad, "bad.tsx"), "cjs-mjs-bridge-rejects");
    expect(rejected.ok).toBe(false);
    expect(messages(rejected)).toContain(
      'SC0001: Type \'"loud"\' is not assignable to type \'"info" | "warn" | undefined\'.',
    );
  },
);
