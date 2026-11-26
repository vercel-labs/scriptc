/* Conversion registration for the untyped path (classToStringRegistrations,
 * lower-modules.ts) names each class's compiled conversion method. Only a
 * class whose instances can exist has a lowered method (the constructor edge
 * reaches it), so registering an exported class value nobody constructs
 * produced SC9001 "missing method function" on a four-line program. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedLlvm(name: string, source: string): Promise<string> {
  const outDir = join(cacheDir, `class-conversion-${name}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.artifact.path, "utf8");
}

test("an exported class whose conversion nothing calls still compiles", async () => {
  const llvm = await emittedLlvm(
    "unused-tostring",
    `export class U {
  toString(): string {
    return 'u';
  }
}
`,
  );
  // No instance can exist, so nothing registers a conversion for it.
  expect(llvm).not.toContain("scr_dyn_register_class_to_string");
});

test("a constructed class still registers its conversion", async () => {
  const llvm = await emittedLlvm(
    "used-tostring",
    `class U {
  toString(): string {
    return 'u';
  }
}
export const u = new U();
`,
  );
  expect(llvm).toContain("scr_dyn_register_class_to_string");
});
