/* A generic Array method override dispatches directly from a base-typed
 * call. A program that defines or replaces that method on a class's
 * prototype (here through an any-cast defineProperty) may put another
 * function there, so the call refuses by name instead of running the
 * compiled body. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

test("a base-typed generic override refuses when its prototype is redefined", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-generic-map-proto-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    `
class Sub extends Array<number> {
  map<U>(cb: (value: number, index: number, array: number[]) => U): U[] {
    return super.map(cb);
  }
}
Object.defineProperty(Sub.prototype as any, "map", {
  value: function () { return [42]; },
  writable: true,
  configurable: true,
});
const sub = new Sub();
sub.push(1);
const base: number[] = sub;
console.log(base.map((value) => value).join(","));
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
    "calling 'map' on an array where a class that extends Array's 'map' is read, replaced or defined through its prototype",
  );
});
