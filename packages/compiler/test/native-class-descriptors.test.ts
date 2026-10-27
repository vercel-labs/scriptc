import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function fixture(source: string) {
  const dir = mkdtempSync("/tmp/scriptc-class-descriptors-");
  const entry = join(dir, "main.js");
  writeFileSync(entry, source);
  return { dir, entry };
}

test.each([
  "Object.defineProperty(value, 'x', {get() { return 2; }});",
  "Object.defineProperties(value, {x: {value: 2}});",
])("keeps unsafe native descriptor changes fenced: %s", (operation) => {
  const { dir, entry } = fixture(
    `class Value { constructor() { this.x = 1; } } const value = new Value(); ${operation}`,
  );
  try {
    const { coverage } = analyze(entry, {});
    expect(
      [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].some(
        (d) => d.code === "SC2020" && d.message.includes("Object.define"),
      ),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data descriptor changes on native fields match Node", async () => {
  const { dir, entry } = fixture(`
class Value { constructor() { this.x = 1; } }
const value = new Value();
Object.defineProperty(value, 'x', { value: 2, writable: false });
console.log(value.x, JSON.stringify(Object.getOwnPropertyDescriptor(value, 'x')));
value.x = 3;
console.log(value.x, Object.keys(value));
`);
  try {
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const run = spawnSync(result.binaryPath, { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect(oracle.status).toBe(0);
    expect({
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    }).toEqual({
      status: oracle.status,
      signal: oracle.signal,
      stdout: oracle.stdout,
      stderr: oracle.stderr,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JS overrides with different return types match Node", async () => {
  const { dir, entry } = fixture(`
class Base { copy(value = 1) { return value; } }
class Child extends Base {
  /** @returns {string} */
  // @ts-expect-error JavaScript permits a different return type at runtime.
  copy(value) { console.log('child'); return String(value); }
}
const child = new Child();
console.log(child.copy(2), typeof child.copy(3));
console.log(new Base().copy());
`);
  try {
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const run = spawnSync(result.binaryPath, { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect(oracle.status).toBe(0);
    expect({
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    }).toEqual({
      status: oracle.status,
      signal: oracle.signal,
      stdout: oracle.stdout,
      stderr: oracle.stderr,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaced instance constructors preserve argument evaluation and match Node", async () => {
  const { dir, entry } = fixture(`
function argument() { console.log('argument'); return 2; }
class Value {
  constructor(x = 1) { this.x = x; }
  clone() { return new this.constructor(argument()); }
}
function replace(value) { value.constructor = Value; }
const value = new Value();
replace(value);
console.log(value.clone().x);
`);
  try {
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const run = spawnSync(result.binaryPath, { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect(oracle.status).toBe(0);
    expect({
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    }).toEqual({
      status: oracle.status,
      signal: oracle.signal,
      stdout: oracle.stdout,
      stderr: oracle.stderr,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derived constructor boundaries preserve initialization and refuse repeated super", async () => {
  const { dir, entry } = fixture(`
class Base { constructor(value) { this.value = value; } }
class Before extends Base { constructor() {
// @ts-expect-error Exercise the runtime initialization guard.
this.value; super(1); } }
class Missing extends Base { constructor(flag) { if (flag) super(1); } }
class Repeated extends Base { constructor() { super(1); super(2); } }
try { new Before(); } catch (error) { console.log(error instanceof ReferenceError); }
try { new Missing(false); } catch (error) { console.log(error instanceof ReferenceError); }
try { new Repeated(); } catch (error) { console.log(error.code === 'SC2020'); }
`);
  try {
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "llvm",
      optimization: "dev",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const execution = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(execution.status).toBe(0);
    expect(execution.stdout).toBe("true\ntrue\ntrue\n");
    expect(execution.stderr).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
