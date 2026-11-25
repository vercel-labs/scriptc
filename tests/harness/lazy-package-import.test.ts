/* A literal `import("<package>")` of a package that no static import names.
 * The selection of what to compile judges static imports only, so such a
 * package is never compiled. The call reports what a static import of an
 * uncompiled package reports, and that refusal names the package. Under the
 * automatic policy the package then runs in a Node island (corpus 9537 runs
 * that against Node); with islands off the refusal is the build's error. */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const program = join(import.meta.dirname, "../corpus/9537-lazy-package-import-island");
const copies: string[] = [];
afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

test("with islands off, the build error names the lazily imported package", async () => {
  const copy = mkdtempSync(join(tmpdir(), "scriptc-lazy-package-"));
  copies.push(copy);
  cpSync(program, copy, { recursive: true });
  const result = await compile(join(copy, "main.ts"), {
    outPath: join(copy, "main"),
    outDir: copy,
    nodeIslands: { mode: "off" },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const reported = result.diagnostics.map((d) => `${d.code} ${d.message}`);
  expect(reported).toContain(
    "SC2013 cannot compile npm package 'ledger-format' statically: its implementation is not part of the compiled module graph",
  );
  expect(result.diagnostics.map((d) => d.code)).not.toContain("SC2012");
}, 120_000);
