import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("generic protocol dispatch without a concrete body fails during compilation", async () => {
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
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected generic protocol diagnostic");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SC1090",
          message: expect.stringContaining("runtime class must be provable"),
        }),
      ]),
    );
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
