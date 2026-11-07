import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-links-order-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const PROGRAM = (declared: string): string => `function through<T>(value: T): T {
  return value;
}
interface Options {
  [key: string]: string;
}
interface Narrow {
  options: Options;
  id: string;
}
${declared}
const items: Narrow[] = through([{ id: "a", options: { k: "v" }, extra: 2 }]);
console.log(JSON.stringify(items[0]), other.id);
`;

// A converted record's reflective views list its source's keys in the
// source's order. The record composed for them has the source's fields with
// the copy's type for \`options\`; when the program declares a type with
// exactly those fields in another order, that type's values keep their own
// order, so the conversion is refused instead of enumerating in it.
test("a composed record that would take another type's key order is refused", async () => {
  const result = await compileSource(
    PROGRAM(`interface Other {
  options: Options;
  extra: number;
  id: string;
}
const other: Other = { options: {}, extra: 1, id: "o" };`),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).not.toContain("SC9001");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "SC1090",
        message: expect.stringContaining("properties in another order"),
      }),
    ]),
  );
});

// The same program compiles when the other type lists the keys as the
// literal writes them, and when no such type exists.
test("a composed record whose key order agrees compiles", async () => {
  const same = await compileSource(
    PROGRAM(`interface Other {
  id: string;
  options: Options;
  extra: number;
}
const other: Other = { id: "o", options: {}, extra: 1 };`),
  );
  expect(same.ok, JSON.stringify(same.ok ? [] : same.diagnostics)).toBe(true);
  const none = await compileSource(PROGRAM(`const other = { id: "o" };`));
  expect(none.ok, JSON.stringify(none.ok ? [] : none.diagnostics)).toBe(true);
});
