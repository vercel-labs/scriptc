/* The package shims compile the same way wherever scriptc is installed.
 *
 * A native distribution reads its declarations and package shims from the
 * directory its toolchain manifest names (setDeclarationRoot), and an npm
 * install puts that directory under node_modules
 * (node_modules/@scriptc/cli-<platform>/dist/lib/declarations). The shims
 * are scriptc's own program code there too: a rule that treats every file
 * under node_modules as an installed package's must not apply to them.
 * Each case compiles one program twice, with the same declarations copied
 * under a node_modules directory and outside one, and expects the same IR:
 * IR names shim files `scriptc:shims/...` (compilerOwnedFileName), so two
 * installations of one compiler emit identical bytes.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { setDeclarationRoot } from "../src/frontend/dts-paths.js";
import { packageOfFile } from "../src/frontend/lowering/decl-origin.js";

const repoRoot = join(import.meta.dirname, "../../..");
const compilerRoot = join(repoRoot, "packages/compiler");
// The checker names files by their real paths (macOS's tmpdir is a symlink),
// and the declaration root must name them the same way.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-shim-install-path-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The declarations directory a native distribution ships, laid out as
 * scripts/native-cli-assets.mts lays it out, under `root`. */
function declarationsAt(root: string): string {
  const declarations = join(root, "dist/lib/declarations");
  mkdirSync(declarations, { recursive: true });
  for (const name of [
    "scriptc.d.ts",
    "scriptc-overrides.d.ts",
    "scriptc-node-fallback.d.ts",
    "scriptc-dom-exception.d.ts",
  ]) {
    cpSync(join(compilerRoot, "ambient", name), join(declarations, name));
  }
  cpSync(join(compilerRoot, "ambient/node-fallback"), join(declarations, "node-fallback"), {
    recursive: true,
  });
  cpSync(join(compilerRoot, "shims"), join(declarations, "shims"), { recursive: true });
  return declarations;
}

const installed = declarationsAt(join(scratch, "project/node_modules/@scriptc/cli-test"));
const standalone = declarationsAt(join(scratch, "toolchain/cli-test"));

async function irWith(declarations: string, entry: string, label: string): Promise<string> {
  setDeclarationRoot(declarations);
  const outDir = join(scratch, "out", label);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "main.ir.json");
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(
      `${label}:\n` +
        result.diagnostics.map((d) => `${d.loc.file}: ${d.code}: ${d.message}`).join("\n"),
    );
  return readFileSync(outPath, "utf8");
}

/** Names what differs between two IR modules: the first function whose IR
 * differs, or the first other top-level field. */
function firstDifference(installedIr: string, standaloneIr: string): string {
  const inside = JSON.parse(installedIr) as Record<string, unknown>;
  const outside = JSON.parse(standaloneIr) as Record<string, unknown>;
  const functionsOf = (mod: Record<string, unknown>): Map<string, string> =>
    new Map(
      ((mod["functions"] ?? []) as { name: string }[]).map((f) => [f.name, JSON.stringify(f)]),
    );
  const insideFunctions = functionsOf(inside);
  const outsideFunctions = functionsOf(outside);
  for (const [name, ir] of outsideFunctions) {
    if (!insideFunctions.has(name)) return `function ${name} is missing under node_modules`;
    if (insideFunctions.get(name) !== ir) return `function ${name} differs under node_modules`;
  }
  for (const name of insideFunctions.keys())
    if (!outsideFunctions.has(name)) return `function ${name} appears only under node_modules`;
  for (const key of new Set([...Object.keys(inside), ...Object.keys(outside)]))
    if (key !== "functions" && JSON.stringify(inside[key]) !== JSON.stringify(outside[key]))
      return `module field ${key} differs under node_modules`;
  return "the IR text differs";
}

describe("package shims under a node_modules installation", () => {
  test("scriptc's shipped files belong to no installed package", () => {
    setDeclarationRoot(installed);
    for (const file of [
      "shims/undici/v7.ts",
      "scriptc.d.ts",
      "scriptc-node-fallback.d.ts",
      "node-fallback/fs.d.ts",
    ])
      expect(packageOfFile(join(installed, file)), file).toBeNull();
    expect(packageOfFile(join(scratch, "project/node_modules/undici/index.js"))).toEqual({
      name: "undici",
      version: "",
    });
  });

  // undici: the shim's own modules join the program's module order (they
  // were left out, and its classes were "not declared in the program").
  // fs-extra: the same, required from an installed package's JavaScript.
  // chalk 5: the shim compiled either way, but its declarations were
  // reported as an npm package's (`scriptc types patch @scriptc/cli-…`).
  for (const [name, entry] of [
    ["undici 7", "tests/fixtures/npm/cases/undici7/main.ts"],
    ["fs-extra", "tests/corpus/fs-extra-package/main.ts"],
    ["chalk 5", "tests/fixtures/npm/cases/chalk5/main.ts"],
  ] as const) {
    test(`${name} compiles to the same IR`, { timeout: 300_000 }, async () => {
      const program = join(repoRoot, entry);
      const label = name.replace(/\W+/g, "-");
      const outside = await irWith(standalone, program, `${label}-standalone`);
      const inside = await irWith(installed, program, `${label}-installed`);
      if (inside !== outside) expect(firstDifference(inside, outside)).toBe("no difference");
    });
  }
});
