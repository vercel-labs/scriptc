/* @types/node beside the bundled Node declarations, with no tsconfig.
 *
 * Without a tsconfig scriptc types Node from its bundled declarations
 * (ambient/scriptc-node-fallback.d.ts). A project that also installs
 * @types/node, and imports a package whose declarations reference it,
 * loads both sets: the two declare the same globals (`BufferEncoding`,
 * `performance`, the `assert` namespace, ...), and a program that uses the
 * package's class reported them as duplicate identifiers (issue #3413,
 * clipanion@4.0.0-rc.4). A project tsconfig avoided it only because the
 * project's Node types then replaced the bundled ones.
 *
 * The checker never owns declaration internals: an installed package's
 * declarations are checked by its own tsconfig, and scriptc forces
 * skipLibCheck for every program. This test builds such a project — no
 * tsconfig, @types/node installed, a dependency whose nested declaration
 * file references Node and exports a class — and requires a clean build.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile } from "../src/index.js";

const repoRoot = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-node-types-no-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("@types/node and the bundled Node declarations do not collide without a tsconfig", async () => {
  cpSync(join(repoRoot, "node_modules/@types/node"), join(scratch, "node_modules/@types/node"), {
    recursive: true,
    dereference: true,
  });
  const dependency = join(scratch, "node_modules/reference-node");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "reference-node",
      version: "1.0.0",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  writeFileSync(join(dependency, "index.js"), "exports.Cli = class Cli {};\n");
  writeFileSync(join(dependency, "index.d.ts"), 'export { Cli } from "./cli.js";\n');
  // The reference sits in a nested declaration file, as clipanion's does.
  writeFileSync(
    join(dependency, "cli.d.ts"),
    '/// <reference types="node" />\nexport declare class Cli {\n  readonly args: string[];\n}\n',
  );
  const entry = join(scratch, "main.ts");
  writeFileSync(
    entry,
    'import { readFileSync } from "node:fs";\nimport { Cli } from "reference-node";\nconsole.log(new Cli().args, readFileSync("package.json", "utf8"));\n',
  );
  const result = await compile(entry, {
    outDir: scratch,
    outPath: join(scratch, "main.ir.json"),
    outputKind: "ir",
  });
  expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
});
