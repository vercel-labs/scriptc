/* scriptc installed under a project's node_modules.
 *
 * The native CLI's declarations and package shims live in its own package
 * (`@scriptc/cli-<platform>/lib/declarations`). When the CLI is a project
 * dependency, that path runs through node_modules — and the frontend's
 * path-shaped question "is this an installed package's file?" must still
 * answer no for the files scriptc itself ships: the ambient declarations,
 * the node-fallback modules, and the package shims are compiler-owned
 * program code wherever scriptc is installed.
 *
 * Reading them as package code skipped the shims' own module walk in
 * preflight and attributed their declarations to `@scriptc/cli-<platform>`;
 * programs using the shimmed fs-extra and undici failed to compile
 * (issue #3482). This test builds both programs against the shipped files
 * copied into a node_modules install layout, and requires the IR the same
 * program emits against a neutral copy of the same declarations: the
 * install's absolute path must not reach the output.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { setDeclarationRoot } from "../src/frontend/dts-paths.js";
import { packageOfFile } from "../src/frontend/lowering/decl-origin.js";

const repoRoot = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-install-layout-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The declaration directory a native distribution ships
 * (scripts/native-cli-assets.mts): the ambient files, the node-fallback
 * modules, and the package shims. */
function copyDeclarations(destination: string): string {
  mkdirSync(destination, { recursive: true });
  for (const name of [
    "scriptc.d.ts",
    "scriptc-overrides.d.ts",
    "scriptc-node-fallback.d.ts",
    "scriptc-dom-exception.d.ts",
  ])
    cpSync(join(repoRoot, "packages/compiler/ambient", name), join(destination, name));
  cpSync(
    join(repoRoot, "packages/compiler/ambient/node-fallback"),
    join(destination, "node-fallback"),
    { recursive: true },
  );
  cpSync(join(repoRoot, "packages/compiler/shims"), join(destination, "shims"), {
    recursive: true,
  });
  return destination;
}

const installed = copyDeclarations(
  join(scratch, "node_modules/@scriptc/cli-linux-x64-gnu/lib/declarations"),
);
const neutral = copyDeclarations(join(scratch, "declarations"));

/** The npm fixture cases whose programs run through a package shim. */
const fixtures = ["fs-extra-package", "undici7", "chalk5"].map((name) => {
  const source = join(
    repoRoot,
    name === "fs-extra-package" ? `tests/corpus/${name}` : `tests/fixtures/npm/cases/${name}`,
  );
  const installedProject = join(scratch, `${name}-installed`);
  const neutralProject = join(scratch, `${name}-neutral`);
  cpSync(source, installedProject, { recursive: true });
  cpSync(source, neutralProject, { recursive: true });
  return { name, installedProject, neutralProject };
});

async function ir(project: string, declarations: string): Promise<string> {
  const entry = join(project, "main.ts");
  const outPath = join(project, "main.ir.json");
  setDeclarationRoot(declarations);
  const result = await compile(entry, { outDir: project, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
  // The module names its source file; the two copies have different
  // directories, so the program's own path stands for itself.
  return readFileSync(outPath, "utf8").split(project).join("<project>");
}

test("shipped declarations compile the package shims from a node_modules install", async () => {
  for (const { installedProject, neutralProject } of fixtures)
    expect(await ir(installedProject, installed)).toBe(await ir(neutralProject, neutral));
});

test("the install layout does not make scriptc's own files an installed package", () => {
  setDeclarationRoot(installed);
  expect(packageOfFile(join(installed, "scriptc.d.ts"))).toBeNull();
  expect(packageOfFile(join(installed, "node-fallback", "fs.d.ts"))).toBeNull();
  expect(packageOfFile(join(installed, "shims", "undici", "v7.ts"))).toBeNull();
  // A package installed beside scriptc still belongs to itself.
  expect(
    packageOfFile(join(scratch, "undici7-installed/node_modules/undici/index.d.ts"))?.name,
  ).toBe("undici");
});
