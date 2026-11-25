/* A statement abandoned over a package the program does not compile names
 * every such package its import() calls load.
 *
 * An `import()` of a package nothing imports statically is refused by name
 * (SC2013), and a build answers the refusal with a Node island and lowers
 * the program again. The refusal abandons its statement, so a statement
 * that loads three such packages used to show one of them per lowering and
 * cost three build rounds. With Node islands off the refusals are the
 * program's errors, which is where these tests read them: one lowering has
 * to name every package of the statement. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyze } from "../src/index.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KITS = ["gauge-kit", "level-kit", "ruler-kit"] as const;

/** The packages one lowering of `source` refuses as outside the compiled
 * module graph, each once, in name order (a later statement that uses a
 * refused import's binding names that package again). */
function refusedPackages(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-uncompiled-imports-"));
  scratch.push(dir);
  for (const name of KITS) {
    const root = join(dir, "node_modules", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js", types: "index.d.ts" }),
    );
    writeFileSync(join(root, "index.js"), `exports.read = (n) => "${name}:" + n;\n`);
    writeFileSync(join(root, "index.d.ts"), "export declare function read(n: number): string;\n");
  }
  writeFileSync(
    join(dir, "own.ts"),
    "export function read(n: number): string {\n  return `own:${n}`;\n}\n",
  );
  writeFileSync(join(dir, "main.ts"), source);
  const result = analyze(join(dir, "main.ts"), { nodeIslands: { mode: "off" } });
  const names = result.coverage.diagnostics
    .filter((d) => d.code === "SC2013")
    .map((d) => /npm package '([^']+)'/.exec(d.message)?.[1] ?? d.message);
  return [...new Set(names)].sort();
}

const inMain = (body: string): string =>
  `async function main(): Promise<void> {\n${body}}\nmain().then(() => console.log("done"));\n`;

test("the entries of one Promise.all are all named by one lowering", () => {
  expect(
    refusedPackages(
      inMain(
        `  const [g, l, r] = await Promise.all([import("gauge-kit"), import("level-kit"), import("ruler-kit")]);\n` +
          `  console.log(g.read(1), l.read(2), r.read(3));\n`,
      ),
    ),
  ).toEqual(["gauge-kit", "level-kit", "ruler-kit"]);
});

test("imports nested in one expression are all named, whichever refusal abandoned the statement", () => {
  expect(
    refusedPackages(
      inMain(
        `  console.log((await import("gauge-kit")).read((await import("level-kit")).read(2).length + (await import("ruler-kit")).read(3).length));\n`,
      ),
    ),
  ).toEqual(["gauge-kit", "level-kit", "ruler-kit"]);
});

test("a condition and the block it guards are one statement", () => {
  expect(
    refusedPackages(
      inMain(
        `  if ((await import("gauge-kit")).read(1).length > 0) {\n` +
          `    const l = await import("level-kit");\n` +
          `    console.log(l.read(2), (await import("ruler-kit")).read(3));\n` +
          `  }\n`,
      ),
    ),
  ).toEqual(["gauge-kit", "level-kit", "ruler-kit"]);
});

test("a function expression written inside the statement lowers with it", () => {
  expect(
    refusedPackages(
      inMain(
        `  const [g, later] = [await import("gauge-kit"), async () => (await import("level-kit")).read(2)];\n` +
          `  console.log(g.read(1), await later());\n`,
      ),
    ),
  ).toEqual(["gauge-kit", "level-kit"]);
});

test("a program module beside a package is not named", () => {
  expect(
    refusedPackages(
      inMain(
        `  const [own, g, again] = await Promise.all([import("./own.ts"), import("gauge-kit"), import("gauge-kit")]);\n` +
          `  console.log(own.read(0), g.read(1), again === g);\n`,
      ),
    ),
  ).toEqual(["gauge-kit"]);
});

test("statements of their own each report their own package", () => {
  expect(
    refusedPackages(
      inMain(
        `  const g = await import("gauge-kit");\n` +
          `  const l = await import("level-kit");\n` +
          `  console.log(g.read(1), l.read(2));\n`,
      ),
    ),
  ).toEqual(["gauge-kit", "level-kit"]);
});

test("a statement without such a refusal names nothing", () => {
  expect(
    refusedPackages(
      inMain(`  const own = await import("./own.ts");\n  console.log(own.read(0));\n`),
    ),
  ).toEqual([]);
});
