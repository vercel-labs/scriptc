import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each(["Child.count++", "++Child.count", "Child.count--", "--Child.count"])(
  "refuses inherited static updates: %s",
  (update) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-static-update-"));
    try {
      const entry = join(dir, "main.cjs");
      writeFileSync(
        entry,
        `class Base { static count = 1; } class Child extends Base {} console.log(${update}); ${update};`,
      );
      const { coverage } = analyze(entry);
      const diagnostics = [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])];
      expect(
        diagnostics.filter(
          (d) => d.code === "SC1090" && d.message.includes("assigning the inherited static"),
        ).length,
      ).toBe(2);
      expect(coverage.stats.statementsIsland).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("refuses updates to readonly static fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-static-readonly-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      "class C { static readonly count = 1; }\n// @ts-expect-error Exercise the compiler backstop too.\nconsole.log(C.count++);\n",
    );
    const { coverage } = analyze(entry);
    expect(
      [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].some(
        (d) => d.code === "SC1090" && d.message.includes("readonly static"),
      ),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("covariant returns do not allow narrower method parameter storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-override-parameter-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
class Item { value = 1; }
class DetailedItem extends Item { extra = 2; }
class Base { copy(value: Item): Item { return value; } }
class Child extends Base {
  copy(value: DetailedItem): DetailedItem { console.log(value.extra); return value; }
}
const receiver: Base = new Child();
console.log(receiver.copy(new Item()).value);
`,
    );
    const { coverage } = analyze(entry);
    expect(
      coverage.diagnostics.some(
        (d) => d.code === "SC1090" && d.message.includes("different signature"),
      ),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
