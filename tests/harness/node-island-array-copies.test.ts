/* SC6007: a Node island's array of primitives that becomes a native copy
 * without the program saying so. The warning comes from the lowering, so
 * these compile to IR and need no libnode pack. The behaviour of the uses
 * that are not warned about is pinned against Node by the corpus program
 * 8931-node-island-array-crossing. */
import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, renderDiagnostics } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const corpus = join(repoRoot, "tests/corpus/8931-node-island-array-crossing");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-array-copies");

/** The SC6007 warnings of `main` compiled beside the corpus program's
 * island package. */
async function arrayCopyWarnings(name: string, main: string) {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(corpus, "node_modules"), join(dir, "node_modules"), { recursive: true });
  copyFileSync(join(corpus, "package.json"), join(dir, "package.json"));
  copyFileSync(main, join(dir, "main.ts"));
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(dir, "main.ir.json"),
    outDir: dir,
    outputKind: "ir",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const warnings = (result.warnings ?? []).filter((d) => d.code === "SC6007");
  return { dir, warnings, sourceTexts: result.sourceTexts ?? new Map<string, string>() };
}

test("every use that copies an island array without saying so is an SC6007 warning", async () => {
  const { dir, warnings, sourceTexts } = await arrayCopyWarnings(
    "copies",
    join(repoRoot, "tests/fixtures/node-island/array-copies.ts"),
  );
  const rendered = renderDiagnostics(warnings, sourceTexts, { color: false }).replaceAll(
    dir + "/",
    "",
  );
  await expect(rendered).toMatchFileSnapshot("__snapshots__/node-island-array-copies.txt");
}, 300_000);

test("the island's array, a stated copy and an unobservable read are not warned about", async () => {
  const { warnings } = await arrayCopyWarnings("crossing", join(corpus, "main.ts"));
  expect(warnings.map((d) => `${d.loc.start}: ${d.message}`)).toEqual([]);
}, 300_000);
