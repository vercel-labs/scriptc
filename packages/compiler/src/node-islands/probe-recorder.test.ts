import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PROBE_RECORDER } from "./probe-recorder.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-probe-recorder-")));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

interface ProbeResult {
  path: string;
  throws?: string;
  reason?: string;
  root?: number;
  inputs: string[];
}

/** Runs the recorder in a Node process of its own, as the probe host runs
 * it in libnode, over `modules`, with `generated` evaluated under the
 * withholding a build's generated module gets. */
function probe(root: string, modules: string[], generated: string[] = []): ProbeResult[] {
  writeFileSync(join(root, "recorder.cjs"), PROBE_RECORDER);
  writeFileSync(
    join(root, "run.cjs"),
    `const out = require("./recorder.cjs").probe({ modules: ${JSON.stringify(modules)}, generated: ${JSON.stringify(generated)} });\n` +
      `process.stdout.write(JSON.stringify(out.results));\n`,
  );
  const run = spawnSync(process.execPath, [join(root, "run.cjs")], { cwd: root, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as ProbeResult[];
}

// A source file that, when it evaluates, writes `evaluated-<name>` beside itself.
const marker = (name: string): string =>
  `require("fs").writeFileSync(require("path").join(__dirname, "evaluated-${name}"), "");\nmodule.exports = { n: 1 };\n`;

test("the probe evaluates an installed package", () => {
  const root = project({
    "node_modules/pkg/package.json": '{ "name": "pkg" }',
    "node_modules/pkg/index.js": "module.exports = { answer: 42 };\n",
  });
  const [result] = probe(root, [join(root, "node_modules/pkg/index.js")]);
  expect(result!.throws).toBeUndefined();
  expect(result!.root).toBeDefined();
});

test("the probe never evaluates the program's own source", () => {
  const root = project({
    "src/program.js": marker("program"),
    "src/shared.js": marker("shared"),
    "node_modules/reaches/package.json": '{ "name": "reaches" }',
    "node_modules/reaches/index.js": 'module.exports = require("../../src/shared.js");\n',
  });
  const results = probe(root, [
    join(root, "src/program.js"),
    join(root, "node_modules/reaches/index.js"),
  ]);
  expect(results.map((r) => r.throws)).toEqual([
    `the build does not evaluate ${join(root, "src/program.js")}, a file of the program`,
    `the build does not evaluate ${join(root, "src/shared.js")}, a file of the program`,
  ]);
  expect(existsSync(join(root, "src/evaluated-program"))).toBe(false);
  expect(existsSync(join(root, "src/evaluated-shared"))).toBe(false);
});

test("a generated module's open for writing is withheld, not performed", () => {
  const root = project({
    "node_modules/writer/package.json": '{ "name": "writer" }',
    "node_modules/writer/index.js":
      'const fs = require("fs");\nmodule.exports = (p) => { fs.openSync(p, "w"); return "made"; };\n',
  });
  const made = join(root, "made.txt");
  // What the build writes for a closed constant that opens a file through an
  // island package: the call would truncate the file during compilation.
  const generatedFile = join(root, ".scriptc/closed/writer.0.mjs");
  mkdirSync(dirname(generatedFile), { recursive: true });
  writeFileSync(
    generatedFile,
    `import write from ${JSON.stringify(join(root, "node_modules/writer/index.js"))};\n` +
      `export const made = write(${JSON.stringify(made)});\n`,
  );
  const [result] = probe(root, [generatedFile], [generatedFile]);
  expect(result!.throws).toBeUndefined();
  expect(result!.reason).toBe(
    "its evaluation has effects or reads inputs: fs.openSync(), which the build does not perform",
  );
  expect(existsSync(made)).toBe(false);
});

test("a refused read that the package catches stays in the generated module's record", () => {
  const root = project({
    "data.txt": "real",
    "node_modules/reader/package.json": '{ "name": "reader" }',
    "node_modules/reader/index.js":
      'const fs = require("fs");\nmodule.exports = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return "fallback"; } };\n',
  });
  const generatedFile = join(root, ".scriptc/closed/reader.0.mjs");
  mkdirSync(dirname(generatedFile), { recursive: true });
  writeFileSync(
    generatedFile,
    `import read from ${JSON.stringify(join(root, "node_modules/reader/index.js"))};\n` +
      `export const text = read(${JSON.stringify(join(root, "data.txt"))});\n`,
  );
  // The evaluation completes with the package's fallback, which is not what
  // the program computes: the record names the read, so the build does not
  // take the module's value from this evaluation.
  const [result] = probe(root, [generatedFile], [generatedFile]);
  expect(result!.throws).toBeUndefined();
  expect(result!.reason).toBeUndefined();
  expect(result!.inputs.some((input) => input.startsWith("fs.readFileSync() "))).toBe(true);
});

test("a package that catches the refusal does not defer, nor does one that loads it later", () => {
  const root = project({
    "src/config.js": marker("config"),
    "node_modules/catches/package.json": '{ "name": "catches" }',
    "node_modules/catches/index.js":
      'let config;\ntry { config = require("../../src/config.js"); } catch { config = { fallback: true }; }\nmodule.exports = config;\n',
    "node_modules/later/package.json": '{ "name": "later" }',
    "node_modules/later/index.js": 'module.exports = { config: require("catches") };\n',
    "node_modules/clean/package.json": '{ "name": "clean" }',
    "node_modules/clean/index.js": "module.exports = { ok: true };\n",
  });
  const results = probe(root, [
    join(root, "node_modules/catches/index.js"),
    join(root, "node_modules/later/index.js"),
    join(root, "node_modules/clean/index.js"),
  ]);
  const refusal = `the build does not evaluate ${join(root, "src/config.js")}, a file of the program`;
  expect(results.map((r) => r.throws)).toEqual([refusal, refusal, undefined]);
  expect(results.map((r) => r.root === undefined)).toEqual([true, true, false]);
  expect(existsSync(join(root, "src/evaluated-config"))).toBe(false);
});
