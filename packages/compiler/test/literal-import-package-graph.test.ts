import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* A literal `import("pkg")` names its package at build time, so the package
 * joins the compiled module graph as a static import puts it there; the
 * import() site still evaluates it at the call, on the microtask Node
 * evaluates it on. A CommonJS package keeps its old treatment: its
 * import() namespace is the CJS facade, which the build has no compiled
 * story for, so selecting it would turn the island the automatic policy
 * gives it into a refusal. */
const repoRoot = join(import.meta.dirname, "../../..");
const fixtures = join(repoRoot, "tests/fixtures/literal-import-package-graph");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/literal-import-package-graph");

interface IrFunction {
  name: string;
}

interface IrModule {
  functions: IrFunction[];
}

/* The fixture packages are committed test data, not installs: the fixtures'
 * `node_modules` directories must be unignored in .gitignore, or a clean
 * checkout leaves `main.ts` importing a package that is not there. */
test("the fixture packages are committed", () => {
  for (const name of ["esm", "cjs"] as const) {
    const packageDir = join(fixtures, name, "node_modules/lazypkg");
    expect(existsSync(join(packageDir, "index.js")), `${packageDir} is test data`).toBe(true);
    expect(existsSync(join(packageDir, "index.d.ts")), `${packageDir} is test data`).toBe(true);
  }
});

function compileIr(name: "esm" | "cjs") {
  const root = join(fixtures, name);
  return compile(join(root, "main.ts"), {
    outDir: join(outDir, name),
    outPath: join(outDir, name, "main"),
    outputKind: "ir",
    nodeIslands: { mode: "off" },
  });
}

test("a literal import() of an ES module package joins the graph and loads at the call", async () => {
  const result = await compileIr("esm");
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  const ir = JSON.parse(readFileSync(result.artifact.path, "utf8")) as IrModule;
  // The package has its own module initializer (it is compiled), and the
  // entry's startup initializer does not run it: only the import() site's
  // helper does, so the module evaluates when the call runs.
  const inits = ir.functions.filter((f) => f.name.startsWith("%init."));
  const entryInit = inits.find((f) => f.name === "%init.0");
  const packageInit = inits.find((f) => f.name !== "%init.0");
  expect(entryInit).toBeDefined();
  expect(packageInit).toBeDefined();
  const helpers = ir.functions.filter((f) => f.name.includes("_staticImport"));
  expect(helpers.length).toBeGreaterThan(0);
  expect(JSON.stringify(entryInit)).not.toContain(packageInit!.name);
  expect(helpers.some((f) => JSON.stringify(f).includes(packageInit!.name))).toBe(true);
});

test("a literal import() of a CommonJS package keeps the refusal a static import's exports object gets", async () => {
  const result = await compileIr("cjs");
  if (result.ok) throw new Error("expected the CommonJS package's import() to keep its refusal");
  expect(result.diagnostics.map((d) => d.code)).toContain("SC2013");
});
