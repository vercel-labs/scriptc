import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-generic-boundaries-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, source);
  try {
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("allows independent function, method and class specializations beyond the recursive budget", async () => {
  const source = `
function identity<T>(value: T): T { return value; }
class Box<T> { value: T; constructor(value: T) { this.value = value; } }
class Factory { static identity<T>(value: T): T { return value; } }
${Array.from(
  { length: 120 },
  (_, index) => `
class Item${index} { value = ${index}; }
const item${index} = new Item${index}();
console.log(identity(item${index}).value, Factory.identity(item${index}).value, new Box(item${index}).value.value);`,
).join("\n")}
`;
  const result = await compileSource(source);
  expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
});

test.each([
  "function grow<T>(value: T): void { grow([value]); } grow(1);",
  "function first<T>(value: T): void { second([value]); } function second<T>(value: T): void { first([value]); } first(1);",
  "class Box<T> { next(): Box<T[]> { return new Box<T[]>(); } } function grow<T>(box: Box<T>): void { grow(box.next()); } grow(new Box<number>());",
  "class Box<T> { grow(): void { new Box<T[]>().grow(); } } new Box<number>().grow();",
])("refuses unbounded fresh demands without an internal compiler error: %s", async (source) => {
  const result = await compileSource(source);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected recursive specialization refusal");
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
  expect(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "SC1090" && diagnostic.message.includes("recursive specializations"),
    ),
  ).toBe(true);
});

test("expanding recursive field layouts fail at the bounded type-mapping boundary", async () => {
  const result = await compileSource(
    "class Box<T> { next: Box<T[]> | undefined = undefined; } console.log(new Box<number>().next);",
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected recursive field refusal");
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
  expect(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "SC2001" && diagnostic.message.includes("Box<T[]>"),
    ),
  ).toBe(true);
});

test("same-key recursive functions and class fields converge", async () => {
  const result = await compileSource(`
class Box<T> { next: Box<T> | undefined = undefined; value: T; constructor(value: T) { this.value = value; } }
function identity<T>(value: T, depth: number): T { return depth > 0 ? identity(value, depth - 1) : value; }
console.log(identity(new Box(7), 3).value);
`);
  expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
});

test("identical declaration errors in separate modules retain both source locations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-module-diagnostics-"));
  try {
    const source =
      "export function value(): number { function local<T>(value:T):T {return value;} return local(1); }\n";
    writeFileSync(join(directory, "first.ts"), source);
    writeFileSync(join(directory, "second.ts"), source);
    writeFileSync(
      join(directory, "main.ts"),
      "import {value as first} from './first.js'; import {value as second} from './second.js'; console.log(first(), second());\n",
    );
    const result = await compile(join(directory, "main.ts"), {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported call diagnostic");
    const files = new Set(result.diagnostics.map((diagnostic) => diagnostic.loc?.file));
    expect(files).toContain(join(directory, "first.ts"));
    expect(files).toContain(join(directory, "second.ts"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
