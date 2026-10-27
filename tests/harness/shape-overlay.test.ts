/* The shape overlay (shape-inference/overlay.ts): with SCRIPTC_SHAPE_OVERLAY=1
 * the zod3-boundary npm case compiles zod's JavaScript with analysis-proven JSDoc
 * types, reports what it typed and checks (SC6103), and prints what Node
 * prints; the shapeOverlay: false option (the CLI's --no-shape-overlay)
 * turns it off. */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/zod3-boundary/main.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/shape-overlay");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

async function withOverlay<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env["SCRIPTC_SHAPE_OVERLAY"];
  process.env["SCRIPTC_SHAPE_OVERLAY"] = "1";
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env["SCRIPTC_SHAPE_OVERLAY"];
    else process.env["SCRIPTC_SHAPE_OVERLAY"] = saved;
  }
}

test(
  "the overlay types zod's JavaScript and keeps Node's output",
  { timeout: 900_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await withOverlay(() =>
      compile(entry, { outPath: join(outDir, "on"), outDir, sanitize }),
    );
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const report = (result.warnings ?? []).find((w) => w.code === "SC6103");
    expect(report?.message).toMatch(
      /shape inference typed \d+ declarations in \d+ files? of 1 package \(zod\)/,
    );
    const run = execFileAsync(result.binaryPath, [], { cwd: dirname(entry), encoding: "utf8" });
    run.child.stdin?.end();
    const node = await execFileAsync(process.execPath, [entry], {
      cwd: dirname(entry),
      encoding: "utf8",
    });
    expect((await run).stdout).toBe(node.stdout);
  },
);

test("shapeOverlay: false compiles without the overlay", { timeout: 900_000 }, async () => {
  mkdirSync(outDir, { recursive: true });
  const result = await withOverlay(() =>
    compile(entry, { outPath: join(outDir, "off"), outDir, sanitize, shapeOverlay: false }),
  );
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  expect((result.warnings ?? []).some((w) => w.code === "SC6103")).toBe(false);
});

// shape-facts: results that include the undefined of a fall-through or a bare
// return keep the caller's falsy branch, comment-like text in literals keeps
// its value, and a replaced branch keeps its var declared, also when two
// replaced branches declare the same var.
const factsEntry = join(repoRoot, "tests/fixtures/npm/cases/shape-overlay-facts/main.ts");

test(
  "the overlay keeps undefined results, literal text and hoisted vars",
  { timeout: 900_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await withOverlay(() =>
      compile(factsEntry, { outPath: join(outDir, "facts"), outDir, sanitize }),
    );
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const report = (result.warnings ?? []).find((w) => w.code === "SC6103");
    expect(report?.message).toMatch(/of 1 package \(shape-facts\)/);
    expect(report?.message).toMatch(/replaces 3 branches it proved unreachable/);
    const native = await execFileAsync(result.binaryPath, [], {
      cwd: dirname(factsEntry),
      encoding: "utf8",
    });
    const node = await execFileAsync(process.execPath, [factsEntry], {
      cwd: dirname(factsEntry),
      encoding: "utf8",
    });
    expect(native.stdout).toBe(node.stdout);
  },
);

// `"scriptc": { "packages": { "<name>": { "shapes": false } } }` in the
// project's package.json compiles that package without the overlay.
test(
  "a package with shapes: false compiles without the overlay",
  { timeout: 900_000 },
  async () => {
    const project = join(outDir, "facts-shapeless");
    rmSync(project, { recursive: true, force: true });
    cpSync(dirname(factsEntry), project, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "shape-overlay-facts-case",
        private: true,
        type: "module",
        scriptc: { packages: { "shape-facts": { shapes: false } } },
      }),
    );
    const result = await withOverlay(() =>
      compile(join(project, "main.ts"), {
        outPath: join(outDir, "facts-shapeless-bin"),
        outDir,
        sanitize,
      }),
    );
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect((result.warnings ?? []).some((w) => w.code === "SC6103" || w.code === "SC8004")).toBe(
      false,
    );
  },
);
