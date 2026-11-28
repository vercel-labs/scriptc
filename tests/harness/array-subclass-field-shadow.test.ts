/* An own field with an Array method's name shadows the prototype method on
 * the instance. A compiled function is called through the base-typed
 * dispatch (the corpus program pins that); a field whose value is not a
 * compiled function (an untyped slot) cannot answer with the builtin Array
 * signature's result, so the call is refused by name instead of silently
 * running the builtin. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

test("calling an Array method shadowed by an untyped field refuses", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-field-shadow-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    `
class Shadowed extends Array<number> {
  push: any = (value: number): number => value;
}
const base: number[] = new Shadowed();
console.log(base.push(1));
`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toContain("SC1090");
  expect(result.diagnostics.map((d) => d.message).join("\n")).toContain(
    "calling 'push' on an array where a class that extends Array declares a field named 'push' that is not a compiled function",
  );
});
