import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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

test("a global an earlier load wrote from the environment does not reach a later snapshot", () => {
  // `ga` publishes an environment-derived global and exports only a function;
  // `gb` shares no file with it and exports the global's value, so the probe
  // hands the value to `gb`'s load through shared state alone.
  const secret = "sk-live-0123456789";
  const root = project({
    "package.json": '{ "name": "app" }',
    "node_modules/ga/package.json": '{ "name": "ga" }',
    "node_modules/ga/index.js":
      "globalThis.token = process.env.PROBE_TOKEN;\nmodule.exports = { ready() {} };\n",
    "node_modules/gb/package.json": '{ "name": "gb" }',
    "node_modules/gb/index.js": "module.exports = { token: globalThis.token };\n",
  });
  const ga = join(root, "node_modules/ga/index.js");
  const gb = join(root, "node_modules/gb/index.js");
  const out = probeOutput(root, [ga, gb], { PROBE_TOKEN: secret });
  expect(out.results[0]!.env).toEqual([["PROBE_TOKEN", secret]]);
  expect(out.results[0]!.mutations).toContain("globalThis.token");
  // The second load read no variable of its own, and its value is the one the
  // first wrote there.
  expect(out.results[1]!.env).toEqual([]);
  expect(JSON.stringify(out.objects[out.results[1]!.root!])).toContain(secret);

  const call = (path: string) => ({
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: path },
      { kind: "strLit", value: "" },
    ],
  });
  const calls = [call(ga), call(gb)];
  const mod = {
    entry: "%main",
    functions: [{ name: "%main", body: calls }],
    globals: [],
  } as unknown as IrModule;
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => out);
  expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
  expect(decisions[1]!.reason).toContain("PROBE_TOKEN");
  expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
  expect(JSON.stringify(mod)).not.toContain(secret);
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

/* ── what a load reads of the machine and the moment ──────────────────────
 * The recorder is a list of what it knows to be safe: every source below is
 * deterministic (a constant of the snapshot), guarded (an environment
 * variable or a terminal state the executable compares at the import), an
 * input or a volatile reading (the load stays eager), or not classified
 * (eager, named). One package per source, `module.exports = { v: <source> }`
 * or an ES module that exports `v`, all loaded by one run of the recorder. */

type Load = ProbeOutput["results"][number];

interface Recorded {
  of: (name: string) => Load;
  /** The constant the snapshot holds for the package's `v`. */
  value: (name: string) => unknown;
  untrappable: string[];
  /** What the process was like after the recorder undid its wrappers. */
  after: { tz: string | null; native: boolean; stdout: boolean };
}

function recordSources(
  sources: { [name: string]: string },
  env: { [key: string]: string | undefined } = {},
): Recorded {
  const files: { [path: string]: string } = { "package.json": '{ "name": "app" }' };
  const modules: string[] = [];
  for (const [name, source] of Object.entries(sources)) {
    const module = /^(import|export) /m.test(source);
    files[`node_modules/${name}/package.json`] = JSON.stringify(
      module ? { name, type: "module", main: "index.js" } : { name, main: "index.js" },
    );
    files[`node_modules/${name}/index.js`] = module
      ? source
      : `module.exports = { v: ${source} };\n`;
    modules.push(`node_modules/${name}/index.js`);
  }
  const root = project(files);
  writeFileSync(join(root, "recorder.cjs"), PROBE_RECORDER);
  writeFileSync(
    join(root, "run.cjs"),
    // A global the host set, which no list of the recorder's has.
    `globalThis.hostThing = 1;\n` +
      `const out = require("./recorder.cjs").probe({ modules: ${JSON.stringify(modules.map((m) => join(root, m)))}, own: [] });\n` +
      `const after = { tz: process.env.TZ === undefined ? null : process.env.TZ, ` +
      `native: /native code/.test(Function.prototype.toString.call(Date.prototype.getHours)) && /native code/.test(Function.prototype.toString.call(Date)), ` +
      `stdout: Object.getOwnPropertyDescriptor(process, "stdout").get !== undefined && typeof process.stdout.write === "function" };\n` +
      `process.stdout.write(JSON.stringify({ out, after }));\n`,
  );
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["TZ", "LC_ALL", "LC_MESSAGES", "LANG", "NODE_DEBUG", "LRI_UNSET"])
    delete environment[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  const run = spawnSync(process.execPath, [join(root, "run.cjs")], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  expect(run.status, run.stderr).toBe(0);
  const { out, after } = JSON.parse(run.stdout) as { out: ProbeOutput; after: Recorded["after"] };
  const of = (name: string): Load => {
    const record = out.results.find((r) => r.path === join(root, "node_modules", name, "index.js"));
    expect(record, name).toBeDefined();
    return record!;
  };
  return {
    of,
    value: (name) => {
      const record = of(name);
      expect(record.throws, name).toBeUndefined();
      const member = out.objects[String(record.root)]!.m.find(([key]) => key === "v");
      expect(member, name).toBeDefined();
      const v = member![1];
      return "s" in v ? v.s : "n" in v ? Number(v.n) : "b" in v ? v.b : v;
    },
    untrappable: out.untrappable ?? [],
    after,
  };
}

/** A load that read nothing a run could answer differently. */
function expectDeterministic(record: Load, name: string): void {
  expect(record.throws, name).toBeUndefined();
  expect(
    {
      inputs: record.inputs,
      volatile: record.volatile,
      effects: record.effects,
      env: record.env,
      tty: record.tty,
    },
    name,
  ).toEqual({ inputs: [], volatile: [], effects: [], env: [], tty: [] });
}

/** What a read of the default locale records: on Linux the three variables
 * ICU takes it from, as guards; elsewhere an input. */
function expectLocale(record: Load, name: string): void {
  expect(record.throws, name).toBeUndefined();
  expect(record.volatile, name).toEqual([]);
  if (process.platform === "linux") {
    expect(record.env, name).toEqual([
      ["LC_ALL", null],
      ["LC_MESSAGES", null],
      ["LANG", null],
    ]);
    expect(record.inputs, name).toEqual([]);
  } else {
    expect(record.inputs.join("\n"), name).toContain("the default locale");
  }
}

describe("what a load reads of the machine and the moment", () => {
  test("the language, the pack's constants and explicit locales and zones are deterministic", () => {
    const T0 = 1577836800000;
    const sources = {
      pure: `[JSON.stringify({ a: [1] }), Math.max(1, 2), new Map([[1, 2]]).size, new URL("https://a/b?c=1").searchParams.get("c"), structuredClone({ a: 1 }).a, Buffer.from("ab").toString("hex"), typeof fetch, typeof WebAssembly.Module, typeof Headers].join(" ")`,
      pack: `[process.platform === require("os").platform(), typeof process.versions.v8, process.release.name, process.arch === process.config.variables.target_arch, process.features.inspector].join(" ")`,
      "date-number": `new Date(${T0}).toISOString() + " " + new Date(${T0}).getUTCHours() + " " + JSON.stringify(new Date(${T0})) + " " + new Date(new Date(${T0})).getTime()`,
      "date-is-a-date": `[new Date(0) instanceof Date, new Date(0).constructor === Date, Object.getPrototypeOf(new Date(0)) === Date.prototype, new (class extends Date {})(0) instanceof Date, typeof Date.now, Date.UTC(2020, 0, 1), Date.name, Date.length].join(" ")`,
      "date-parse-zoned": `[Date.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-01"), Date.parse("2020-01-01T02:00:00+02:00"), new Date("Wed, 01 Jan 2020 00:00:00 GMT").getTime()].join(" ")`,
      "explicit-locale": `[new Intl.NumberFormat("en-US").format(1234.5), (1234.5).toLocaleString("de-DE"), "a".localeCompare("b", "en"), "i".toLocaleUpperCase("en"), new Intl.Collator("de").compare("a", "b"), new Intl.Locale("de-DE").language, Intl.NumberFormat.supportedLocalesOf(["de"]).length].join(" ")`,
      "explicit-zone": `new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric" }).format(new Date(${T0})) + " " + new Date(${T0}).toLocaleString("en-US", { timeZone: "UTC" })`,
      "no-call": `[typeof performance === "object" && typeof performance.now === "function", typeof Intl.DateTimeFormat, typeof Date.now, typeof Math.random, typeof process.hrtime, typeof crypto.randomUUID].join(" ")`,
      "core-modules": `[require("os").EOL.length, require("os").constants.signals.SIGINT, require("worker_threads").isMainThread, require("http").STATUS_CODES[404], require("net").isIP("127.0.0.1"), require("util").inspect({ a: 1 }), require("path").join("a", "b"), require("fs").constants.O_RDONLY, require("crypto").createHash("sha1").update("x").digest("hex").length, require("events").defaultMaxListeners].join(" ")`,
      classes: `[typeof require("net").Socket, typeof require("fs").ReadStream, typeof require("http").Agent, typeof new (require("http").Agent)().destroy, typeof class extends require("events") {}, typeof new (require("async_hooks").AsyncLocalStorage)().run].join(" ")`,
      "stream-descriptor": `process.stdout.fd + process.stderr.fd`,
      // Node's Headers, Request and Response mark themselves uncloneable
      // through worker_threads when they are made: no effect of the load.
      "web-objects": `[new Headers({ a: "b" }).get("a"), new Request("http://localhost/x").method, new Response().status, typeof new FormData().append].join(" ")`,
      "esm-platform": `import { platform } from "node:process";\nexport const v = platform.length > 0;\n`,
      "esm-default": `import process from "node:process";\nimport os from "node:os";\nexport const v = process.platform === os.platform();\n`,
      "esm-worker": `import { isMainThread } from "node:worker_threads";\nexport const v = isMainThread;\n`,
    };
    const recorded = recordSources(sources);
    for (const name of Object.keys(sources)) expectDeterministic(recorded.of(name), name);
    // The values are the constants of the snapshot. The Date the load sees
    // is the real one (it once made instances with an empty prototype, and
    // every load that made a Date threw in the probe and stayed eager).
    expect(recorded.value("date-number")).toBe(
      `2020-01-01T00:00:00.000Z 0 "2020-01-01T00:00:00.000Z" ${T0}`,
    );
    expect(recorded.value("date-is-a-date")).toBe(
      "true true true true function 1577836800000 Date 7",
    );
    expect(recorded.value("date-parse-zoned")).toBe(`${T0} ${T0} ${T0} ${T0}`);
    expect(recorded.value("explicit-zone")).toBe("12 AM 1/1/2020, 12:00:00 AM");
    expect(recorded.value("esm-worker")).toBe(true);
    expect(recorded.value("web-objects")).toBe("b GET 200 function");
  });

  test("an environment variable behind a builtin is a guard", () => {
    const recorded = recordSources(
      {
        env: `process.env.LRI_UNSET === undefined`,
        homedir: `require("os").homedir()`,
        debuglog: `require("util").debuglog("lri").enabled`,
        "zone-set": `new Date(2020, 0, 1).getTime() + new Date(0).getHours() + Date.parse("2020-01-01T00:00:00")`,
        "zone-set-intl": `Intl.DateTimeFormat("en-US").resolvedOptions().timeZone`,
      },
      { TZ: "Asia/Tokyo", HOME: "/home/lri" },
    );
    expect(recorded.of("env").env).toEqual([["LRI_UNSET", null]]);
    expect(recorded.of("homedir").env).toEqual([["HOME", "/home/lri"]]);
    expect(recorded.of("debuglog").env).toEqual([["NODE_DEBUG", null]]);
    // A time zone that TZ names is that variable's value.
    for (const name of ["zone-set", "zone-set-intl"]) {
      expect(recorded.of(name).env, name).toEqual([["TZ", "Asia/Tokyo"]]);
      expect(recorded.of(name).inputs, name).toEqual([]);
    }
    expect(recorded.value("zone-set-intl")).toBe("Asia/Tokyo");
    // Asking the parser in two zones left TZ as it was.
    expect(recorded.after.tz).toBe("Asia/Tokyo");
  });

  test("the default locale is the three variables ICU takes it from", () => {
    const sources = {
      number: `(1234.5).toLocaleString()`,
      bigint: `(1234567n).toLocaleString()`,
      array: `[1234.5, 1].toLocaleString()`,
      compare: `["b", "a"].sort(function (x, y) { return x.localeCompare(y); }).join("")`,
      upper: `"i".toLocaleUpperCase() + "I".toLocaleLowerCase()`,
      collator: `new Intl.Collator().compare("a", "b")`,
      "number-format": `Intl.NumberFormat().resolvedOptions().locale`,
      "empty-list": `new Intl.PluralRules([]).select(1)`,
      unsupported: `new Intl.ListFormat("tlh").format(["a", "b"])`,
      "relative-time": `new Intl.RelativeTimeFormat().format(-1, "day")`,
      "display-names": `new Intl.DisplayNames(undefined, { type: "region" }).of("DE")`,
      segmenter: `new Intl.Segmenter().resolvedOptions().locale`,
      "date-locale": `new Date(0).toLocaleString(undefined, { timeZone: "UTC" })`,
      navigator: `navigator.language + navigator.languages.length`,
      "by-constructor": `new (new Intl.Collator("en").constructor)().compare("a", "b")`,
      esm: `export const v = (1234.5).toLocaleString();\n`,
    };
    const recorded = recordSources(sources);
    for (const name of Object.keys(sources)) expectLocale(recorded.of(name), name);
  });

  test("whether a standard stream is a terminal is a guard, and so are the members only a terminal's has", () => {
    const sources: { [name: string]: [string, number] } = {
      istty: [`process.stdout.isTTY === true`, 1],
      isatty: [`require("tty").isatty(2)`, 2],
      columns: [`process.stdout.columns === undefined`, 1],
      rows: [`process.stderr.rows === undefined`, 2],
      "color-depth": [`typeof process.stdout.getColorDepth`, 1],
      "has-colors": [`process.stderr.hasColors ? process.stderr.hasColors() : false`, 2],
      "window-size": [`process.stdout.getWindowSize ? process.stdout.getWindowSize()[0] : 0`, 1],
      "is-raw": [`process.stdin.isRaw === undefined`, 0],
      in: [`"getColorDepth" in process.stdout`, 1],
      "style-text": [`require("util").styleText("red", "x")`, 1],
    };
    const recorded = recordSources(
      Object.fromEntries(Object.entries(sources).map(([name, [source]]) => [name, source])),
      { FORCE_COLOR: undefined, NO_COLOR: undefined, NODE_DISABLE_COLORS: undefined },
    );
    for (const [name, [, fd]] of Object.entries(sources)) {
      const record = recorded.of(name);
      expect(record.throws, name).toBeUndefined();
      expect(record.tty, name).toEqual([[fd, false]]);
      expect([record.inputs, record.volatile, record.effects], name).toEqual([[], [], []]);
    }
    // The stream of a test run is a pipe: its answers are a pipe's.
    expect(recorded.value("color-depth")).toBe("undefined");
    expect(recorded.value("columns")).toBe(true);
  });

  test("a setting no guard covers is an input, named with the place that read it", () => {
    const sources: { [name: string]: [string, string] } = {
      argv: [`process.argv.length`, "process.argv ("],
      cwd: [`process.cwd()`, "process.cwd() ("],
      resolve: [`require("path").resolve("x")`, "process.cwd() ("],
      hostname: [`require("os").hostname()`, "os.hostname() ("],
      hardware: [`navigator.hardwareConcurrency`, "navigator.hardwareConcurrency ("],
      "zone-default": [
        `Intl.DateTimeFormat("en-US").resolvedOptions().timeZone`,
        "the time zone of the machine (TZ is unset) (",
      ],
      "zone-parse": [`Date.parse("2020-01-01T00:00:00")`, "the time zone of the machine"],
      "zone-parse-legacy": [`new Date("Jan 1, 2020").getTime()`, "the time zone of the machine"],
      "zone-fields": [`new Date(2020, 0, 1).getTime()`, "the time zone of the machine"],
      "zone-hours": [`new Date(0).getHours()`, "the time zone of the machine"],
      "zone-set-hours": [
        `(function () { var d = new Date(0); d.setHours(0); return d.getTime(); })()`,
        "the time zone of the machine",
      ],
      "zone-string": [`"" + new Date(0)`, "the time zone of the machine"],
      "zone-offset": [`new Date(0).getTimezoneOffset()`, "the time zone of the machine"],
      "zone-locale-date": [
        `new Date(0).toLocaleDateString("en-US")`,
        "the time zone of the machine",
      ],
      "zone-by-constructor": [
        `new (new Date(0).constructor)(2020, 0, 1).getTime()`,
        "the time zone of the machine",
      ],
      "zone-reflect": [
        `Reflect.construct(Date, [2020, 0, 1]).getTime()`,
        "the time zone of the machine",
      ],
      "zone-eval": [`(0, eval)("new Date(2020, 0, 1).getTime()")`, "the time zone of the machine"],
      "esm-hostname": [
        `import { hostname } from "node:os";\nexport const v = hostname();\n`,
        "os.hostname() (",
      ],
      "esm-argv": [
        `import { argv } from "node:process";\nexport const v = argv.length;\n`,
        "process.argv (an import by name in ",
      ],
    };
    const recorded = recordSources(
      Object.fromEntries(Object.entries(sources).map(([name, [source]]) => [name, source])),
    );
    for (const [name, [, expected]] of Object.entries(sources)) {
      const record = recorded.of(name);
      expect(record.throws, name).toBeUndefined();
      expect(record.inputs.join("\n"), name).toContain(expected);
      expect(record.inputs.join("\n"), name).toContain(`node_modules/${name}/index.js`);
    }
    expect(recorded.after.tz).toBeNull();
  });

  test("a reading no run repeats is volatile: the clocks, random numbers, the process id, meters", () => {
    const sources: { [name: string]: [string, string] } = {
      "date-now": [`Date.now()`, "Date.now() ("],
      "new-date": [`new Date().getTime()`, "new Date() ("],
      "date-call": [`Date()`, "Date() ("],
      "performance-now": [`performance.now()`, "performance.now() ("],
      "perf-hooks": [`require("perf_hooks").performance.now()`, "performance.now() ("],
      "time-origin": [`performance.timeOrigin`, "performance.timeOrigin ("],
      mark: [`performance.mark("lri").startTime`, "performance.mark() ("],
      hrtime: [`process.hrtime.bigint() > 0n`, "process.hrtime.bigint() ("],
      uptime: [`process.uptime()`, "process.uptime() ("],
      rss: [`process.memoryUsage.rss()`, "process.memoryUsage.rss() ("],
      pid: [`process.pid`, "process.pid ("],
      random: [`Math.random()`, "Math.random() ("],
      "web-random": [`crypto.randomUUID()`, "crypto.randomUUID() ("],
      "web-random-values": [
        `crypto.getRandomValues(new Uint8Array(4)).length`,
        "crypto.getRandomValues() (",
      ],
      file: [`new File([], "x").lastModified`, "new File() (its lastModified) ("],
      event: [`new Event("x").timeStamp`, "new Event() (its timeStamp) ("],
      "format-now": [
        `new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format()`,
        "Intl.DateTimeFormat#format() of the current time (",
      ],
      "console-time": [`(console.time("lri"), 1)`, "console.time() ("],
      "esm-pid": [
        `import { pid } from "node:process";\nexport const v = pid;\n`,
        "process.pid (an import by name in ",
      ],
      // Node fills the namespace of a builtin once: the second ES module
      // that imports the member by name must be recorded as the first is.
      "esm-pid-again": [
        `import { pid as id } from "node:process";\nexport const v = id;\n`,
        "process.pid (an import by name in ",
      ],
    };
    const recorded = recordSources(
      Object.fromEntries(Object.entries(sources).map(([name, [source]]) => [name, source])),
    );
    for (const [name, [, expected]] of Object.entries(sources)) {
      const record = recorded.of(name);
      expect(record.throws, name).toBeUndefined();
      expect(record.volatile.join("\n"), name).toContain(expected);
    }
  });

  test("a timer Node sets for the load by another way than the globals is an effect", () => {
    const recorded = recordSources({
      "abort-timeout": `AbortSignal.timeout(5).aborted`,
      "timers-promises": `typeof require("timers/promises").setTimeout(1)`,
      "set-and-cleared": `(clearTimeout(setTimeout(function () {}, 5)), 1)`,
    });
    expect(recorded.of("abort-timeout").effects.join("\n")).toContain("a timer (");
    expect(recorded.of("timers-promises").effects.join("\n")).toContain(
      "timers/promises.setTimeout() (",
    );
    // A timer the load set through the global and cleared leaves nothing.
    expectDeterministic(recorded.of("set-and-cleared"), "set-and-cleared");
  });

  test("a source on no list keeps the load eager, named", () => {
    const not = ", which the recorder does not classify";
    const sources: { [name: string]: [string, string] } = {
      "host-global": [`typeof hostThing`, `globalThis.hostThing${not} (`],
      report: [`typeof process.report`, `process.report${not} (`],
      "new-builtin": [`typeof require("domain").create`, `the builtin module domain${not} (`],
      "by-name": [`typeof process.getBuiltinModule("node:sea")`, `the builtin module sea${not} (`],
      "module-data": [`require("cluster").isPrimary`, `cluster.isPrimary${not} (`],
      "stream-member": [`process.stdout.constructor.name`, `process.stdout.constructor${not} (`],
      "stream-kind": [
        `process.stdout instanceof require("tty").WriteStream`,
        `what kind of stream process.stdout is${not} (`,
      ],
      "stream-keys": [
        `Object.keys(process.stderr).length`,
        `what kind of stream process.stderr is${not} (`,
      ],
      "console-stream": [`console._stdout === undefined`, `console._stdout${not} (`],
      "esm-namespace": [
        `import * as p from "node:process";\nexport const v = p.platform;\n`,
        "process.argv (an import by name in ",
      ],
      "esm-stream": [
        `import { stdout } from "node:process";\nexport const v = stdout.isTTY === true;\n`,
        `process.stdout imported by name${not} (`,
      ],
      // Node makes these two members not configurable: the recorder cannot
      // see a read, and takes a file that names one to have read it.
      argv0: [
        `process.argv0`,
        "process.argv0, which the recorder cannot observe and the load's files name",
      ],
      fips: [
        `require("crypto").fips`,
        "crypto.fips, which the recorder cannot observe and the load's files name",
      ],
    };
    const recorded = recordSources(
      Object.fromEntries(Object.entries(sources).map(([name, [source]]) => [name, source])),
    );
    for (const [name, [, expected]] of Object.entries(sources)) {
      const record = recorded.of(name);
      expect(record.inputs.join("\n"), name).toContain(expected);
    }
    // Every other member of process, of the globals and of the listed core
    // modules in this Node has a rule or is on an allowlist. A Node release
    // that adds one the recorder cannot observe shows here.
    expect(recorded.untrappable).toEqual(["process.argv0", "crypto.fips"]);
    // A word in a file is not a read of the member.
    const mention = recordSources({
      mention: `["fips", "argv0"].length + (function (o) { return o.fipsMode + o.useFips; })({ fipsMode: 1, useFips: 2 })`,
    });
    expectDeterministic(mention.of("mention"), "mention");
  });

  test("an argument is read without running the load's code, and one only that code can answer is an input", () => {
    // Each source counts how often its accessor, trap or conversion ran, or
    // answers differently the second time. The recorder classifies the call
    // before it runs: reading the argument there would run the load's code
    // once more than Node does, and the load's result, which the snapshot
    // would hold, would not be Node's.
    const opaque: { [name: string]: string } = {
      "zone-getter": `(function () { var n = 0; var f = new Intl.DateTimeFormat("en-US", { get timeZone() { n++; return n === 1 ? "Asia/Tokyo" : "UTC"; } }); return f.resolvedOptions().timeZone + " " + n; })()`,
      "zone-getter-date": `(function () { var n = 0; var text = new Date(0).toLocaleTimeString("en-US", { get timeZone() { n++; return n === 1 ? "Asia/Tokyo" : "UTC"; } }); return text + " " + n; })()`,
      "zone-proxy": `(function () { var gets = 0; var f = new Intl.DateTimeFormat("en-US", new Proxy({ timeZone: "UTC" }, { get: function (t, k) { if (k === "timeZone") gets++; return t[k]; } })); return f.resolvedOptions().timeZone + " " + gets; })()`,
      "locale-conversion": `(function () { var n = 0; var tag = { toString: function () { n++; return n === 1 ? "de-DE" : "en-US"; } }; return (1234.5).toLocaleString([tag]) + " " + n; })()`,
      "locale-element-getter": `(function () { var n = 0; var list = ["sv"]; Object.defineProperty(list, 0, { get: function () { n++; return n === 1 ? "sv" : "en"; } }); return "\u00e4".localeCompare("z", list) + " " + n; })()`,
      "locale-array-like": `(function () { var n = 0; var list = { get length() { n++; return 1; }, 0: "de-DE" }; return new Intl.NumberFormat(list).resolvedOptions().locale + " " + n; })()`,
      "file-getter": `(function () { var n = 0; var f = new File([], "a", { get lastModified() { n++; return 5; } }); return f.lastModified + " " + n; })()`,
    };
    // The member the recorder would read is plain data, and the load's code
    // removes or replaces it while the call reads what comes before it.
    const shifting: { [name: string]: string } = {
      "zone-removed-by-getter": `new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", get hour12() { delete this.timeZone; return false; } }).resolvedOptions().timeZone`,
      "zone-removed-by-conversion": `(function () { var o = { timeZone: "Asia/Tokyo" }; o.calendar = { toString: function () { delete o.timeZone; return "gregory"; } }; return new Intl.DateTimeFormat("en-US", o).resolvedOptions().timeZone; })()`,
      "zone-removed-date": `(function () { var o = { timeZone: "Asia/Tokyo", get hour12() { delete this.timeZone; return false; } }; return new Date(0).toLocaleTimeString("en-US", o); })()`,
      "zone-inherited-getter": `(function () { var o = Object.create({ get hourCycle() { delete o.timeZone; return "h23"; } }); o.timeZone = "Asia/Tokyo"; return new Intl.DateTimeFormat("en-US", o).resolvedOptions().timeZone; })()`,
      "locales-emptied-by-compared": `(function () { var list = ["de-DE"]; return "\u00e4".localeCompare({ toString: function () { list.length = 0; return "z"; } }, list); })()`,
      "locales-emptied-by-receiver": `(function () { var list = ["tr"]; return String.prototype.toLocaleUpperCase.call({ toString: function () { list.length = 0; return "i"; } }, list); })()`,
      "file-option-removed": `(function () { var o = { lastModified: 5, get type() { delete this.lastModified; return "text/plain"; } }; return typeof new File([], "a", o).lastModified; })()`,
    };
    // Arguments the engine answers by itself stay what they were: constants.
    const plain: { [name: string]: string } = {
      "zone-data": `new Intl.DateTimeFormat(["en-US"], { timeZone: "UTC" }).resolvedOptions().timeZone`,
      "zone-inherited": `new Intl.DateTimeFormat("en-US", Object.create({ timeZone: "UTC" })).resolvedOptions().timeZone`,
      "locale-object": `(1234.5).toLocaleString(new Intl.Locale("de-DE"))`,
      "locale-objects": `"\u00e4".localeCompare("z", [new Intl.Locale("sv"), "en"])`,
    };
    const underNode = (source: string): unknown => {
      const run = spawnSync(process.execPath, ["-p", `JSON.stringify(${source})`], {
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      return JSON.parse(run.stdout) as unknown;
    };
    const recorded = recordSources({ ...opaque, ...shifting, ...plain });
    for (const [name, source] of Object.entries(opaque)) {
      const record = recorded.of(name);
      expect(recorded.value(name), name).toEqual(underNode(source));
      expect(record.inputs.join("\n"), name).toContain(
        "that only the load's own code can answer (an accessor, a proxy or a conversion)",
      );
      expect(record.inputs.join("\n"), name).toContain(`node_modules/${name}/index.js`);
    }
    for (const name of Object.keys(shifting)) {
      const record = recorded.of(name);
      expect(record.throws, name).toBeUndefined();
      expect(record.inputs.join("\n"), name).toContain(
        "that only the load's own code can answer (an accessor, a proxy or a conversion)",
      );
    }
    for (const [name, source] of Object.entries(plain)) {
      expect(recorded.value(name), name).toEqual(underNode(source));
      expectDeterministic(recorded.of(name), name);
    }
  });

  test("a key the load generates, a signature and the command line are not constants", () => {
    // Each of these answered from the build when its function was listed
    // among those that compute from their arguments: an executable would
    // have carried the build's private key, or the build's command line.
    const sources: { [name: string]: [string, string] } = {
      "ecdh-key": [
        `require("crypto").createECDH("prime256v1").generateKeys("hex")`,
        "crypto.createECDH() (",
      ],
      "group-key": [
        `require("crypto").getDiffieHellman("modp14").generateKeys("hex")`,
        "crypto.getDiffieHellman() (",
      ],
      "ecdh-class": [
        `new (require("crypto").ECDH)("prime256v1").generateKeys("hex")`,
        "crypto.ECDH() (",
      ],
      signer: [`typeof require("crypto").createSign("SHA256").sign`, "crypto.createSign() ("],
    };
    const inputSources: { [name: string]: [string, string] } = {
      "parse-args": [
        `require("util").parseArgs({ options: { verbose: { type: "boolean" } }, strict: false }).values.verbose === true`,
        "util.parseArgs() (",
      ],
      "cache-dir": [
        `require("module").getCompileCacheDir() === undefined`,
        "module.getCompileCacheDir() (",
      ],
      "file-iterated": [
        `(function () { var o = { lastModified: 5 }; var parts = ["a"]; parts[Symbol.iterator] = function* () { delete o.lastModified; yield "a"; }; return typeof new File(parts, "a", o).lastModified; })()`,
        "an argument of new File() that only the load's own code can answer",
      ],
    };
    const recorded = recordSources(
      Object.fromEntries(
        Object.entries({ ...sources, ...inputSources }).map(([name, [source]]) => [name, source]),
      ),
    );
    for (const [name, [, expected]] of Object.entries(sources)) {
      const record = recorded.of(name);
      expect(record.throws, name).toBeUndefined();
      expect(record.volatile.join("\n"), name).toContain(expected);
    }
    for (const [name, [, expected]] of Object.entries(inputSources)) {
      const record = recorded.of(name);
      expect(record.throws, name).toBeUndefined();
      expect(record.inputs.join("\n"), name).toContain(expected);
    }
  });

  test("the recorder leaves the process as it found it", () => {
    const recorded = recordSources({ any: `new Date(2020, 0, 1).getHours() + Date.now()` });
    expect(recorded.after).toEqual({ tz: null, native: true, stdout: true });
  });
});
