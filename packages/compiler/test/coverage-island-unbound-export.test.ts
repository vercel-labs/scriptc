// A package whose exports are defined at run time compiles natively, but a
// program can still read an export it has no binding form for. The refusal
// is at the program's read and is the package's (ScrDiagnostic.exportOf), so
// the growth rule islands the package for it (node-islands/growth.ts). The
// analysis must report the same island: the report used to drop the refusal
// (its site is in the program's own module, which names no package), and a
// program whose only island reason was that read passed both island gates.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { coveragePasses } from "../src/coverage/report.js";
import { analyzeWithFrontend } from "../src/frontend/analysis.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFile(dir: string, path: string, text: string): void {
  const at = join(dir, path);
  mkdirSync(join(at, ".."), { recursive: true });
  writeFileSync(at, text);
}

/** `metrics` exports a function object whose members are assigned over live
 * bindings (`counter` is reassigned after it is exported, `version` is
 * written by the module and by its re-exporter): the module compiles
 * natively, and a read of either member has no native binding form. */
function program(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-coverage-unbound-export-"));
  scratch.push(dir);
  writeFile(
    dir,
    "node_modules/metrics/package.json",
    JSON.stringify({ name: "metrics", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFile(
    dir,
    "node_modules/metrics/index.js",
    '"use strict";\nmodule.exports = require("./lib.js");\nmodule.exports.version = "2.0.0";\n',
  );
  writeFile(
    dir,
    "node_modules/metrics/lib.js",
    '"use strict";\nlet counter = 1;\nexports = module.exports = function metrics() {\n  return "metrics";\n};\nexports.counter = counter;\nexports.version = "1.0.0";\ncounter = 5;\n',
  );
  writeFile(
    dir,
    "node_modules/metrics/index.d.ts",
    "declare function metrics(): string;\ndeclare namespace metrics {\n  const counter: number;\n  const version: string;\n}\nexport = metrics;\n",
  );
  writeFile(
    dir,
    "main.ts",
    'import { counter, version } from "metrics";\n\nconsole.log(counter, version);\n',
  );
  return dir;
}

const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) =>
  runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);

test("an unbound export the growth rule islands is an island in the report", () => {
  const dir = program();
  const result = analyzeWithFrontend(
    join(dir, "main.ts"),
    { nodeIslands: { mode: "auto" } },
    process.platform,
    factory,
  );
  const coverage = result.coverage;
  // The package compiled natively; the only island reason is the program's
  // read of its export, which the analysis itself does not report as a
  // blocker (a build runs the package in an island).
  expect(coverage.npmStatic?.map((e) => [e.package, e.status])).toEqual([["metrics", "static"]]);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.nodeIslands?.islands.map((i) => [i.package, i.class])).toEqual([
    ["metrics", "gap"],
  ]);
  expect(coverage.nodeIslands?.islands[0]!.reason).toContain("the reference to 'counter'");
  // Both island gates fail, as they do for any island the report lists.
  expect(coveragePasses(coverage, "node-islands")).toBe(false);
  expect(coveragePasses(coverage, "island-gaps")).toBe(false);
}, 600_000);
