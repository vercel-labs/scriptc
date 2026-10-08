import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  checkPreflight,
  cycleEarlyBindings,
  isNodeEsmFile,
  loadProgram,
  makeCycleAdmission,
  moduleEarlyBindings,
  type CycleEdge,
} from "./program-node.js";
import * as ts from "./ts7/ast.js";
import { AstNode } from "./ts7/ast-node.js";
import { SemanticChecker } from "./ts7/semantic-checker.js";

test("program-root discovery does not fetch types for unrelated string calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-root-queries-"));
  const entry = join(dir, "main.ts");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(
    entry,
    'function label(text: string) { return text; } console.log(label("ready"));\n',
  );
  const types = vi.spyOn(SemanticChecker.prototype, "getTypeOfSymbol");
  const load = loadProgram(entry);
  try {
    expect(types).not.toHaveBeenCalled();
    expect(checkPreflight(load)).toEqual([]);
  } finally {
    types.mockRestore();
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguous module classification bounds ancestor work on deep expressions", () => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-module-depth-"),
  );
  const entry = join(directory, "main.js");
  const depth = 1_000;
  writeFileSync(join(directory, "package.json"), "{}");
  writeFileSync(entry, Array.from({ length: depth }, () => "1").join(" + ") + ";\n");
  const load = loadProgram(entry);
  try {
    const parents = vi.spyOn(AstNode.prototype, "parent", "get");
    try {
      expect(isNodeEsmFile(load.entry)).toBe(false);
      expect(parents.mock.calls.length).toBeLessThan(depth * 4);
    } finally {
      parents.mockRestore();
    }
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

function requireOrderDiagnostics(source: string, dependency = "exports.value = 'ready';\n") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-require-order-"));
  const entry = join(dir, "main.cjs");
  writeFileSync(entry, source);
  writeFileSync(join(dir, "dep.cjs"), dependency);
  const load = loadProgram(entry);
  try {
    return checkPreflight(load);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test.for(["exports.read = read;", "module.exports.renamed = read;", "module.exports = read;"])(
  "a hoisted function export before require is safe: %s",
  (publish) => {
    expect(
      requireOrderDiagnostics(`
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
${publish}
const dep = require('./dep.cjs');
function read() { return helper(); }
function helper() { return dep.value; }
`),
    ).toEqual([]);
  },
);

test.for([
  "exports.a = exports.b = void 0;",
  "exports.a = undefined; exports.b = 'literal'; exports.c = 1;",
  "exports.first = exports.second = read;",
])("literal and chained export prologues do not invoke functions: %s", (prefix) => {
  expect(
    requireOrderDiagnostics(`
Object.defineProperty(exports, '__esModule', { value: true });
${prefix}
exports.read = read;
const dep = require('./dep.cjs');
function read() { return dep.value; }
`),
  ).toEqual([]);
});

test.for([
  ["direct call", "read();"],
  ["transitive call", "helper(); function helper() { return read(); }"],
  ["callback escape", "[1].map(read);"],
  ["export call", "exports.read();"],
  ["export alias call", "const alias = exports; alias.read();"],
  ["computed export name", "exports[read()] = read;"],
  ["export initializer call", "exports.value = read();"],
  ["class static initializer", "class Early { static value = read(); }"],
  [
    "extra descriptor effect",
    "Object.defineProperty(exports, '__esModule', { value: true, enumerable: read() });",
  ],
  ["void initializer call", "exports.value = void read();"],
  ["prototype mutation", "exports.__proto__ = read;"],
  [
    "read-only marker",
    "Object.defineProperty(exports, '__esModule', { value: true }); exports.__esModule = read;",
  ],
  ["replacement export property", "module.exports = read; module.exports.name = read;"],
  ["non-export assignment chain", "const box = {}; exports.alias = box.read = read;"],
])("require still refuses an early read through %s", ([, early]) => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
${early}
const dep = require('./dep.cjs');
function read() { return dep.value; }
`);
  expect(
    diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'dep'")),
  ).toBe(true);
});

test("publishing a require binding itself still reads it before initialization", () => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
const { read } = require('./dep.cjs');
`);
  expect(
    diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'read'")),
  ).toBe(true);
});

test.for([
  "var Object = null; Object.defineProperty(exports, '__esModule', { value: true }); exports.read = read;",
  "var exports = null; exports.read = read;",
  "var module = null; module.exports = read;",
])("source bindings cannot masquerade as a CommonJS prologue: %s", (prefix) => {
  const diagnostics = requireOrderDiagnostics(`
${prefix}
const dep = require('./dep.cjs');
function read() { return dep.value; }
`);
  expect(
    diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'dep'")),
  ).toBe(true);
});

test("an earlier declarator can call an export before the require initializes", () => {
  const diagnostics = requireOrderDiagnostics(`
exports.read = read;
const before = read(), dep = require('./dep.cjs');
function read() { return dep.value; }
`);
  expect(
    diagnostics.some((diag) => diag.code === "SC1013" && diag.message.includes("binding 'dep'")),
  ).toBe(true);
});

test("a later declarator can call an export after the require initializes", () => {
  expect(
    requireOrderDiagnostics(`
exports.read = read;
const dep = require('./dep.cjs'), after = read();
function read() { return dep.value; }
`),
  ).toEqual([]);
});

test("function publication does not admit CommonJS cycles", () => {
  const diagnostics = requireOrderDiagnostics(
    `
exports.read = read;
const dep = require('./dep.cjs');
function read() { return dep.value; }
`,
    "const main = require('./main.cjs'); exports.value = main.read();\n",
  );
  expect(diagnostics.some((diag) => diag.code === "SC1016")).toBe(true);
});

test.for([
  ["export function read() { return first + alias; }", null],
  ["export { first, alias }; export function read() { return 1; }", null],
  ["type Value = typeof alias; export function read(first: number = 1) { return first; }", null],
  ["class Box { value = alias; } export function read(value = first) { return value; }", null],
  // Top-level reads during the cycle are admitted by the exact
  // initialization rule (the lowering checks them); shapes without an
  // initialization state keep the fence.
  ["const value = alias; export function read() { return value; }", null],
  ["class Box { static value = first; } export function read() { return 1; }", null],
  ["class Box { [alias] = 1; } export function read() { return 1; }", null],
  [
    'import * as whole from "./main.ts"; const value = whole.first; export function read() { return value; }',
    "the namespace import 'whole'",
  ],
  ["export default first + 1; export function read() { return 1; }", "default export expression"],
])("cycle binding indexes preserve initialization safety: %s", ([body, refused]) => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-cycle-bindings-"),
  );
  const entry = join(directory, "main.ts");
  writeFileSync(
    entry,
    'import { read } from "./peer.ts"; export const first = 1; export const second = 2; export function run() { return read(); }',
  );
  writeFileSync(
    join(directory, "peer.ts"),
    'import { first, second as alias } from "./main.ts";\n' + body,
  );
  const load = loadProgram(entry);
  try {
    const cycles = checkPreflight(load).filter((diagnostic) => diagnostic.code === "SC1016");
    if (refused === null) expect(cycles).toEqual([]);
    else {
      expect(cycles.length).toBeGreaterThan(0);
      for (const cycle of cycles) expect(cycle.message).toContain(refused);
    }
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated cycle edges reuse a file's binding index", () => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-cycle-index-"),
  );
  const entry = join(directory, "main.ts");
  writeFileSync(
    entry,
    'import { read } from "./peer.ts"; export const first = 1; export const second = 2; export function run() { return read(); }',
  );
  writeFileSync(
    join(directory, "peer.ts"),
    'import { first } from "./main.ts"; import { second } from "./main.ts"; export function read() { return first + second; }',
  );
  const load = loadProgram(entry);
  try {
    const main = load.entry;
    const peer = load.program.getSourceFile(join(directory, "peer.ts"))!;
    const mainImports = main.statements.filter(ts.isImportDeclaration);
    const peerImports = peer.statements.filter(ts.isImportDeclaration);
    const edges = new Map<ts.SourceFile, CycleEdge[]>([
      [main, mainImports.map((stmt) => ({ dep: peer, stmt }))],
      [peer, peerImports.map((stmt) => ({ dep: main, stmt }))],
    ]);
    const admit = makeCycleAdmission(load.program, (file) => edges.get(file) ?? []);
    const walk = vi.spyOn(peer, "appendChildIndices");
    try {
      expect(admit(peer, edges.get(peer)![0]!)).toBeNull();
      expect(walk).toHaveBeenCalled();
      // A later binding must inspect its indexed references without
      // another full-file walk.
      walk.mockClear();
      expect(admit(peer, edges.get(peer)![1]!)).toBeNull();
      expect(walk).not.toHaveBeenCalled();
    } finally {
      walk.mockRestore();
    }
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.for([
  [
    // A shared instance built by a user constructor: the reads of it in
    // the partner's function can run early; the class cannot.
    {
      "main.ts": 'import { shared } from "./a.ts"; console.log(shared.n);',
      "a.ts":
        'import { f } from "./b.ts"; export class C { n = 1; } export const shared = new C(); console.log(f());',
      "b.ts": 'import { shared } from "./a.ts"; export function f(): number { return shared.n; }',
    },
    ["shared"],
  ],
  [
    // The partner's top level reads the importer's const before it ran.
    {
      "main.ts": 'import { a } from "./a.ts"; console.log(a);',
      "a.ts": 'import { b } from "./b.ts"; export const a: number = b + 1;',
      "b.ts": 'import { a } from "./a.ts"; export const b: number = a + 1;',
    },
    ["a"],
  ],
  [
    // Declarations complete before any user code runs: nothing to check.
    {
      "main.ts": 'import { start } from "./a.ts"; console.log(start());',
      "a.ts":
        'import { hop } from "./b.ts"; export const limit = 3; export function start(): number { return hop(limit); } console.log(start());',
      "b.ts":
        'import { limit } from "./a.ts"; export function hop(n: number): number { return n + limit; }',
    },
    [],
  ],
] as const)("cycle bindings read before initialization: %j", ([files, early]) => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-cycle-early-"),
  );
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const load = loadProgram(join(directory, "main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    const found = cycleEarlyBindings(load.program, load.entry, load.moduleOrder, true);
    expect(found.map((binding) => binding.name.text).sort()).toEqual([...early]);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.for([
  // A hoisted function called before the declaration reads it.
  ["report(); let level = 1; function report() { console.log(level); }", ["level"]],
  // The declaration's own initializer reaches the read.
  ["const total = sum(); function sum(): number { return base + 1; } const base = 2;", ["base"]],
  // An arrow handed to a callee may run before the declaration.
  [
    "[1].forEach(() => show()); const label = 'x'; function show() { console.log(label); }",
    ["label"],
  ],
  // Calls after the declaration, stored callables and timer callbacks are not early.
  ["let level = 1; report(); function report() { console.log(level); }", []],
  [
    "const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2)); console.log(fib(5));",
    [],
  ],
  ["const item = { read() { return item.size; }, size: 2 }; console.log(item.read());", []],
  ["setTimeout(() => console.log(late), 0); const late = 'later';", []],
  ["let a = 1, b = () => a + 1, c = b(); console.log(c);", []],
] as const)("module bindings read before initialization: %s", ([source, early]) => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-module-early-"),
  );
  writeFileSync(join(directory, "main.ts"), `${source}\nexport {};\n`);
  const load = loadProgram(join(directory, "main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    const found = moduleEarlyBindings(load.program, load.moduleOrder);
    expect(found.map((binding) => binding.name.text).sort()).toEqual([...early]);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
