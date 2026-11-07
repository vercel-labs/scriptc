import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { IrModule } from "../ir/ir.js";
import { PROBE_RECORDER } from "./probe-recorder.js";
import { finalizeDeferredIslands, type ProbeOutput } from "./snapshot.js";

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
  files: string[];
}

/** Runs the recorder in a Node process of its own, as the probe host runs
 * it in libnode, over `modules`, with `generated` evaluated under the
 * withholding a build's generated module gets. */
function probeOutput(
  root: string,
  modules: string[],
  env: Record<string, string> = {},
  generated: string[] = [],
): ProbeOutput {
  writeFileSync(join(root, "recorder.cjs"), PROBE_RECORDER);
  writeFileSync(
    join(root, "run.cjs"),
    `const out = require("./recorder.cjs").probe({ modules: ${JSON.stringify(modules)}, own: ${JSON.stringify(generated)} });\n` +
      `process.stdout.write(JSON.stringify(out));\n`,
  );
  const run = spawnSync(process.execPath, [join(root, "run.cjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as ProbeOutput;
}

function probe(root: string, modules: string[], generated: string[] = []): ProbeResult[] {
  return probeOutput(root, modules, {}, generated).results;
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
  // the program computes: the record names the read and says why the build
  // does not take the module's value from this evaluation.
  const [result] = probe(root, [generatedFile], [generatedFile]);
  expect(result!.throws).toBeUndefined();
  expect(result!.root).toBeUndefined();
  expect(result!.reason).toBe(
    "its evaluation has effects or reads inputs: fs.readFileSync(), which the build does not perform",
  );
  expect(result!.inputs.some((input) => input.startsWith("fs.readFileSync() "))).toBe(true);
});

test("a load's files include the ones Node hands it without resolving", () => {
  // Two entry points of one directory that make the same relative request:
  // Node answers the second from its own cache, past the resolve hook, and
  // the shared file's own require does not run again.
  const root = project({
    "node_modules/kit/package.json": '{ "name": "kit" }',
    "node_modules/kit/deep.js": "module.exports = { n: 1 };\n",
    "node_modules/kit/common.js": 'module.exports = require("./deep.js");\n',
    "node_modules/kit/a.js": 'module.exports = require("./common.js");\n',
    "node_modules/kit/b.js": 'module.exports = require("./common.js");\n',
  });
  const kit = (name: string): string => join(root, "node_modules/kit", name);
  const results = probe(root, [kit("a.js"), kit("b.js")]);
  for (const result of results) {
    expect(result.throws).toBeUndefined();
    expect(result.files).toEqual(expect.arrayContaining([kit("common.js"), kit("deep.js")]));
  }
});

test("a shared dependency's environment reads reach every load that gets its exports", () => {
  const secret = "postgres://admin:hunter2@db.internal/prod";
  const root = project({
    "package.json": '{ "name": "app" }',
    "node_modules/common/package.json": '{ "name": "common" }',
    "node_modules/common/index.js": "module.exports = { token: process.env.PROBE_DB_URL };\n",
    // `middle` re-exports what its dependency read, and both island modules
    // load it: the first evaluates it, the second gets the module cache's.
    "node_modules/middle/package.json": '{ "name": "middle" }',
    "node_modules/middle/index.js": 'module.exports = { token: require("common").token };\n',
    "node_modules/first/package.json": '{ "name": "first" }',
    "node_modules/first/index.js": 'require("middle");\nmodule.exports = { ready: true };\n',
    "node_modules/second/package.json": '{ "name": "second" }',
    "node_modules/second/index.js": 'module.exports = { token: require("middle").token };\n',
  });
  const first = join(root, "node_modules/first/index.js");
  const second = join(root, "node_modules/second/index.js");
  const out = probeOutput(root, [first, second], { PROBE_DB_URL: secret });
  expect(out.results[0]!.env).toEqual([["PROBE_DB_URL", secret]]);
  // The second load runs none of the dependency's code, and what it exports
  // is that load's: the read is part of its record too.
  expect(out.results[1]!.env).toEqual([["PROBE_DB_URL", secret]]);

  const call = (path: string) => ({
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: path },
      { kind: "strLit", value: "" },
    ],
  });
  const calls = [call(first), call(second)];
  const mod = {
    entry: "%main",
    functions: [{ name: "%main", body: calls }],
    globals: [],
  } as unknown as IrModule;
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => out);
  expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
  expect(decisions[1]!.reason).toContain("PROBE_DB_URL");
  expect(JSON.stringify(mod)).not.toContain("hunter2");
  expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
});

test("a module that shares a file another load evaluated answers for what the file read", () => {
  // `common` reads the process arguments when it evaluates. The first load
  // in a run may be `b`, written under a condition, so the probe evaluates
  // `a` first and `common` reads there; `b` then gets the module cache's
  // exports and its own record holds no read. What `b` exports was computed
  // from the build's arguments, values and shape alike, so `b` is no more
  // deferred than `a`, whose own record names the read.
  const root = project({
    "package.json": '{ "name": "app" }',
    "node_modules/kit/package.json": '{ "name": "kit" }',
    "node_modules/kit/common.js": "module.exports = { width: process.argv.length };\n",
    "node_modules/kit/a.js": 'module.exports = { w: require("./common.js").width };\n',
    "node_modules/kit/b.js": 'module.exports = { w: require("./common.js").width };\n',
  });
  const a = join(root, "node_modules/kit/a.js");
  const b = join(root, "node_modules/kit/b.js");
  const out = probeOutput(root, [a, b]);
  expect(out.results[0]!.inputs.length).toBeGreaterThan(0);
  expect(out.results[1]!.inputs).toEqual([]);
  expect(out.results[1]!.files).toContain(join(root, "node_modules/kit/common.js"));

  const call = (path: string) => ({
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: path },
      { kind: "strLit", value: "" },
    ],
  });
  const bLoad = call(b);
  const aLoad = call(a);
  const mod = {
    entry: "%main",
    functions: [
      {
        name: "%main",
        body: [
          {
            kind: "varDecl",
            localId: "v",
            init: {
              kind: "logical",
              op: "&&",
              left: { kind: "varRef", localId: "use" },
              right: bLoad,
            },
          },
          { kind: "assign", localId: "%g.island.0", value: aLoad },
        ],
      },
    ],
    globals: [],
  } as unknown as IrModule;
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => out);
  expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
  expect(decisions.find((d) => d.path === a)!.reason).toContain("its load reads process.argv");
  expect(decisions.find((d) => d.path === b)!.reason).toContain(
    "a load it shares a file with reads process.argv",
  );
  expect(bLoad.fn).toBe("nodeIsland.require");
});

test("a generated module that catches the withheld call does not defer", () => {
  const root = project({
    "node_modules/writer/package.json": '{ "name": "writer" }',
    "node_modules/writer/index.js":
      'const fs = require("fs");\nmodule.exports = (p) => { try { fs.openSync(p, "w"); return "made"; } catch { return "caught"; } };\n',
  });
  const made = join(root, "caught.txt");
  // The island function catches what the build withheld, so the load
  // succeeds with the fallback its catch block returns; that value, and
  // whatever the module would do after it, is not the real call's.
  const generatedFile = join(root, ".scriptc/closed/writer.0.mjs");
  mkdirSync(dirname(generatedFile), { recursive: true });
  writeFileSync(
    generatedFile,
    `import write from ${JSON.stringify(join(root, "node_modules/writer/index.js"))};\n` +
      `export const mode = write(${JSON.stringify(made)});\n`,
  );
  const [result] = probe(root, [generatedFile], [generatedFile]);
  expect(result!.throws).toBeUndefined();
  expect(result!.root).toBeUndefined();
  expect(result!.reason).toBe(
    "its evaluation has effects or reads inputs: fs.openSync(), which the build does not perform",
  );
  expect(existsSync(made)).toBe(false);
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
