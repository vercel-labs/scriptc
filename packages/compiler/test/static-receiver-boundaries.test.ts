import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  [
    "constructor reads this",
    "function Make() { console.log(this); return { value: 1 }; } new Make();",
  ],
  [
    "constructor arrow captures this",
    "function Make() { return { read: () => this }; } new Make();",
  ],
  [
    "constructor default reads this",
    "function Make({value = this} = {}) { return { value }; } new Make();",
  ],
  [
    "constructor reads new.target",
    "function Make() { console.log(new.target); return { value: 1 }; } new Make();",
  ],
  [
    "constructor returns a primitive on one branch",
    "function Make(flag) { if (flag) return 1; return { value: 1 }; } new Make(true);",
  ],
  [
    "constructor binding reassigned",
    "function Make() { return { value: 1 }; } Make = function () { return { value: 2 }; }; console.log(new Make().value);",
  ],
] as const)("object-returning constructor retains the fence when %s", (_name, source) => {
  const dir = mkdtempSync("/tmp/scriptc-constructor-boundary-");
  try {
    const entry = join(dir, "main.mjs");
    writeFileSync(entry, source);
    const { coverage } = analyze(entry);
    expect([...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  [
    "detached method",
    "class C { static value = 1; static read(): number { return this.value; } } const read = C.read; console.log(read());",
  ],
  [
    "polymorphic receiver",
    "class C { static read(): string { return this.name; } } class D extends C {} function run(value: typeof C): string { return value.read(); } console.log(run(D));",
  ],
  [
    "inherited private field",
    "class C { static #value = 1; static read(): number { return this.#value; } } class D extends C {} console.log(D.read());",
  ],
  [
    "shadowed private field",
    "class C { static #value = 1; static read(): number { return this.#value; } } class D extends C { static #value = 2; } console.log(D.read());",
  ],
  [
    "inherited private method",
    "class C { static #value(): number { return 1; } static read(): number { return this.#value(); } } class D extends C {} console.log(D.read());",
  ],
  [
    "shadowed private method",
    "class C { static #value(): number { return 1; } static read(): number { return this.#value(); } } class D extends C { static #value(): number { return 2; } } console.log(D.read());",
  ],
  [
    "inherited static write",
    "class C { static value = 1; static write(): void { this.value = 2; } } class D extends C {} D.write();",
  ],
] as const)("receiver specialization preserves the %s boundary", (_name, source) => {
  const dir = mkdtempSync("/tmp/scriptc-static-boundary-");
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const { coverage } = analyze(entry);
    expect(coverage.preflightFailed).toBe(false);
    expect(
      coverage.diagnostics.some((d) => d.code === "SC1090"),
      JSON.stringify(coverage.diagnostics),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
