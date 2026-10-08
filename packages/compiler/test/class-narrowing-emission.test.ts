import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("subclass guards retain native field access through base-class slots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-narrowing-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(
      entry,
      `
class Base { id = 1; }
class Child extends Base { values = [2, 4]; }
function count(value: Base): number {
  if (value instanceof Child) return value.values.length + value["id"];
  return 0;
}
console.log(count(new Child()), count(new Base()));
`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath,
      outputKind: "llvm",
      dynamic: false,
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const llvm = await readFile(outPath, "utf8");
    expect(llvm).toMatch(/getelementptr inbounds %sc_o_Child/);
    expect(llvm).not.toMatch(/call[^\n]*@scr_dyn_(?:obj_get|new_obj|typed_ref|key_get)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
