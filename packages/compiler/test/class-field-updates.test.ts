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

test("a narrower method parameter is checked at the slot, never stored unchecked", () => {
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
    // The override compiles: its slot checks the argument into the declared
    // subclass and throws for the base instance before the body could read
    // a field it does not have (override-parameter-narrowing.ts; the run is
    // pinned in tests/harness/override-parameter-narrowing.test.ts).
    const { coverage } = analyze(entry);
    expect(
      [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].filter(
        (d) => d.code === "SC1090",
      ),
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
