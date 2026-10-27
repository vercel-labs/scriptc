import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function refusals(file: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-local-class-private-"));
  try {
    const entry = join(dir, file);
    writeFileSync(entry, source);
    const { coverage } = analyze(entry);
    return [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].map((d) => d.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Function-local JavaScript classes compile private fields used only on
// `this` when the class is a named declaration: each evaluation's prototype
// methods check the receiver's evaluation against that binding. Private
// methods and accessors, class expressions, private names on other objects,
// and TypeScript classes keep the refusal.
test.each([
  [
    "a private method",
    "main.js",
    "function make() { class Box { #read() { return 1; } read() { return this.#read(); } } return new Box(); } console.log(make().read());",
  ],
  [
    "a private accessor",
    "main.js",
    "function make() { class Box { get #value() { return 1; } read() { return this.#value; } } return new Box(); } console.log(make().read());",
  ],
  [
    "a class expression",
    "main.js",
    "function make() { const Box = class { #value = 1; read() { return this.#value; } }; return new Box(); } console.log(make().read());",
  ],
  [
    "a private name on another object",
    "main.js",
    "function make() { class Box { #value = 1; has(other) { return #value in other; } } return new Box(); } console.log(make().has({}));",
  ],
  [
    "a TypeScript class",
    "main.ts",
    "function make() { class Box { #value = 1; read(): number { return this.#value; } } return new Box(); } console.log(make().read());",
  ],
] as const)("function-local private names keep the refusal with %s", (_name, file, source) => {
  expect(refusals(file, source)).toContainEqual(
    expect.stringContaining("function-local classes with private brands"),
  );
});

test("function-local private fields used on this compile", () => {
  expect(
    refusals(
      "main.js",
      "function make() { class Box { #value = 1; read() { return this.#value; } has() { return #value in this; } } return new Box(); } const box = make(); console.log(box.read(), box.has());",
    ),
  ).toEqual([]);
});
