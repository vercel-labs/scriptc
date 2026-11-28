import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  ["assignment", 'let key = Symbol.for("x"); key = Symbol.for("y"); class C { [key] = true; }'],
  [
    "shorthand assignment",
    'var key = Symbol.for("x"); ({ key } = { key: Symbol.for("y") }); class C { [key] = true; }',
  ],
  [
    "array assignment",
    'var key = Symbol.for("x"); [key] = [Symbol.for("y")]; class C { [key] = true; }',
  ],
  [
    "redeclaration",
    'var key = Symbol.for("x"); var key = Symbol.for("y"); class C { [key] = true; }',
  ],
  ["early class key", 'class C { [key] = true; } var key = Symbol.for("x");'],
  [
    "early hoisted call",
    'read(); var key = Symbol.for("x"); function read() { return key; } class C { [key] = true; }',
  ],
  [
    "early shorthand call",
    'const callbacks = { read }; callbacks.read(); var key = Symbol.for("x"); function read() { return key; } class C { [key] = true; }',
  ],
  [
    "for-of assignment",
    'var key = Symbol.for("x"); for (key of [Symbol.for("y")]) {} class C { [key] = true; }',
  ],
  [
    "runtime registry name",
    'function text() { return "x"; } const key = Symbol.for(text()); class C { [key] = true; }',
  ],
  ["local symbol", 'class C { constructor() { const key = Symbol("x"); this[key] = true; } }'],
])("refuses symbol fields with %s", (_name, source) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-symbol-fields-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(entry, source + "\nnew C();\n");
    const { coverage } = analyze(entry);
    const diagnostics = [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])];
    expect(
      diagnostics.some(
        (d) => d.code === "SC1090" && /symbol|computed class fields/i.test(d.message),
      ),
      JSON.stringify(coverage, null, 2),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a symbol getter read through a class value a subclass overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-symbol-fields-"));
  try {
    // A `typeof Base` parameter can hold `Deny`: the runtime class decides
    // which getter answers, so an exact-class read would ignore the override.
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `const gate = Symbol();
class Base { static get [gate](): boolean { return true; } }
class Deny extends Base { static get [gate](): boolean { return false; } }
function check(ctor: typeof Base): boolean { return ctor[gate]; }
console.log(check(Base), check(Deny));\n`,
    );
    const { coverage } = analyze(entry);
    const diagnostics = [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])];
    expect(
      diagnostics.some((d) => d.code === "SC1090" && /class value/.test(d.message)),
      JSON.stringify(coverage, null, 2),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  [
    "constant registry name",
    'const text = "x"; const key = Symbol.for(text); class C { [key] = true; }',
  ],
  ["uninitialized JavaScript field", 'const key = Symbol.for("x"); class C { [key]; }'],
  [
    // Two distinct symbols may share one description: the slot names carry
    // the declaring binding, so the fields stay two slots, exactly as the
    // two keys are two symbols at run time.
    "distinct symbols sharing a description",
    'const key = Symbol("x"); const other = Symbol.for("x"); class C { [key] = true; [other] = false; }',
  ],
])("accepts symbol fields with %s", (_name, source) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-symbol-fields-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(entry, source + "\nnew C();\n");
    const { coverage } = analyze(entry);
    expect(coverage.preflightFailed).toBe(false);
    expect([...coverage.diagnostics, ...(coverage.runtimeFences ?? [])]).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["rest declaration", "const { name, ...copy } = value; console.log(copy);"],
  ["rest assignment", "let copy = {}; let name; ({ name, ...copy } = value); console.log(copy);"],
  ["Object.assign", "const copy = Object.assign({}, value); console.log(copy);"],
  [
    "Object.assign with several sources",
    "const copy = Object.assign({}, value, { extra: 1 }); console.log(copy);",
  ],
  [
    "Object.assign with spread sources",
    "const copy = Object.assign({}, ...[value]); console.log(copy);",
  ],
])("refuses %s copies of symbol fields", (_name, copy) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-symbol-copy-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(
      entry,
      `const key = Symbol.for("x"); class Base { [key] = true; name = "base"; } class C extends Base {} const value = new C(); ${copy}`,
    );
    const { coverage } = analyze(entry);
    const diagnostics = [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])];
    expect(
      diagnostics.some((d) =>
        /rest bindings|copying class instances|object spread/.test(d.message),
      ),
      JSON.stringify(coverage, null, 2),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["spread", "const copy = { ...value }; console.log(copy[key]);"],
  [
    "computed-key spread",
    'let name = "extra"; const copy = { [name]: 1, ...value }; console.log(copy[key]);',
  ],
])("accepts %s copies of symbol fields", (_name, copy) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-symbol-copy-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(
      entry,
      `const key = Symbol.for("x"); class Base { [key] = true; name = "base"; } class C extends Base {} const value = new C(); ${copy}`,
    );
    const { coverage } = analyze(entry);
    expect(coverage.preflightFailed).toBe(false);
    expect([...coverage.diagnostics, ...(coverage.runtimeFences ?? [])]).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
