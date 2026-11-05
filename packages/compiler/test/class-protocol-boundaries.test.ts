import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("generic protocol dispatch without a concrete body calls the erased method", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-protocol-boundary-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `interface Live { value(): number; identity<T>(value: T): T; }
class Value implements Live {
  value(): number { return 1; }
  identity<T>(value: T): T { return value; }
}
function read(value: Live): number { return value.identity(3); }
console.log(read(new Value()));`,
    );
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an accessor satisfying a declared data member keeps the target live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-accessor-data-member-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `interface Counter { size: number; label: string; }
function makeCounter(): Counter {
  let current = 1;
  return {
    get size(): number { return current; },
    set size(next: number) { current = next; },
    label: "counter",
  };
}
const counter = makeCounter();
counter.size = 10;
console.log(counter.size, counter.label, Object.keys(counter).join(","));`,
    );
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a data property satisfying a declared accessor keeps the target live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-data-accessor-member-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `interface Live { readonly label: string; get size(): number; }
function makeLive(): Live { return { label: "counter", size: 3 }; }
console.log(makeLive().size);`,
    );
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
