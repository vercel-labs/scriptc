import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { IrModule } from "../ir/ir.js";
import {
  evaluationOrder,
  finalizeDeferredIslands,
  probeHostDirectory,
  type ProbeOutput,
} from "./snapshot.js";

const saved = { ...process.env };
const made: string[] = [];
afterEach(() => {
  for (const key of ["SCRIPTC_CACHE_DIR", "SCRIPTC_NO_CACHE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-probe-dir-")));
  made.push(dir);
  return dir;
}

function probeDir(hash: string): { dir: string; kept: boolean } {
  const result = probeHostDirectory(hash);
  if (!result.kept) made.push(result.dir);
  return result;
}

describe.skipIf(process.platform === "win32")("the probe host's directory", () => {
  test("is kept in the user's private build cache", () => {
    const cache = scratch();
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(true);
    expect(dir).toBe(join(cache, "node-island-probe", "0123456789abcdef"));
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  test("never comes from a cache another user can write", () => {
    const cache = scratch();
    chmodSync(cache, 0o777);
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(false);
    expect(dir.startsWith(cache)).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
    // A second probe gets its own directory: nothing is reused.
    expect(probeDir("0123456789abcdef").dir).not.toBe(dir);
  });

  test("is a fresh private directory without a build cache", () => {
    process.env["SCRIPTC_NO_CACHE"] = "1";
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

/** A project whose entry imports the island module `dep` (one deferred
 * island load), and a stand-in for the probe whose recorded load of the
 * module read `env` and exported `{ url }`. */
function deferredProject(scriptc: unknown, env: [string, string | null][], url: string) {
  const root = scratch();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scriptc }));
  const file = join(root, "node_modules", "dep", "index.js");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "package.json"), '{ "name": "dep" }');
  writeFileSync(file, "module.exports = { url: process.env.DB_URL };\n");
  const call = {
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: file },
      { kind: "strLit", value: "" },
    ],
  };
  const mod = { functions: [{ body: [call] }], globals: [] } as unknown as IrModule;
  const probe: ProbeOutput = {
    results: [
      {
        path: file,
        root: 1,
        inputs: [],
        volatile: [],
        effects: [],
        mutations: [],
        env,
        tty: [],
        files: [file],
      },
    ],
    objects: { "1": { f: 0, p: false, m: [["url", { s: url }]] } },
  };
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
  return { decisions, call, text: JSON.stringify(mod) };
}

describe("environment boot guards", () => {
  test("a load that read a variable outside publicEnv stays eager and records no value", () => {
    const secret = "postgres://admin:hunter2@db.internal/prod";
    const { decisions, call, text } = deferredProject({}, [["DB_URL", secret]], secret);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.deferred).toBe(false);
    expect(decisions[0]!.reason).toContain("DB_URL");
    expect(call.fn).toBe("nodeIsland.require");
    expect(text).not.toContain("hunter2");
  });

  test('"evaluate": "lazy" does not record a variable outside publicEnv', () => {
    const secret = "sk-live-0123456789";
    const { decisions, text } = deferredProject(
      { packages: { dep: { evaluate: "lazy" } } },
      [["API_KEY", secret]],
      "https://api.example.com",
    );
    expect(decisions[0]!.deferred).toBe(false);
    expect(text).not.toContain(secret);
  });

  test("a load that read only variables unset at build time defers, guarded as unset", () => {
    const { decisions, call, text } = deferredProject(
      {},
      [
        ["NODE_DEBUG", null],
        ["FORCE_COLOR", null],
      ],
      "https://example.com",
    );
    expect(decisions[0]!.deferred).toBe(true);
    expect(decisions[0]!.reason).toContain("env guards NODE_DEBUG (unset),FORCE_COLOR (unset)");
    expect(call.fn).toBe("nodeIsland.defer");
    expect(text).toContain("E 10:NODE_DEBUG 0 0:");
    expect(text).toContain("E 11:FORCE_COLOR 0 0:");
  });

  test("an unset variable does not admit a set one outside publicEnv", () => {
    const secret = "sk-live-0123456789";
    const { decisions, call, text } = deferredProject(
      {},
      [
        ["NODE_DEBUG", null],
        ["API_KEY", secret],
      ],
      "https://api.example.com",
    );
    expect(decisions[0]!.deferred).toBe(false);
    expect(decisions[0]!.reason).toContain("API_KEY");
    expect(decisions[0]!.reason).not.toContain("NODE_DEBUG");
    expect(call.fn).toBe("nodeIsland.require");
    expect(text).not.toContain(secret);
  });

  test("unset and publicEnv variables guard one load together", () => {
    const { decisions, text } = deferredProject(
      { nodeIslands: { publicEnv: ["NODE_ENV"] } },
      [
        ["NODE_ENV", "production"],
        ["NODE_DEBUG", null],
      ],
      "https://example.com",
    );
    expect(decisions[0]!.deferred).toBe(true);
    expect(text).toContain("E 8:NODE_ENV 1 10:production");
    expect(text).toContain("E 10:NODE_DEBUG 0 0:");
  });

  test("a load that read only publicEnv variables defers, guarded by their values", () => {
    const { decisions, call, text } = deferredProject(
      { nodeIslands: { publicEnv: ["NODE_ENV"] } },
      [["NODE_ENV", "production"]],
      "https://example.com",
    );
    expect(decisions[0]!.deferred).toBe(true);
    expect(call.fn).toBe("nodeIsland.defer");
    expect(text).toContain("E 8:NODE_ENV 1 10:production");
  });
});

/** A project whose entry imports the island modules `first` and `second`,
 * which both load `shared/index.js`. The probe loaded `first` first, so
 * what the shared file read is in `first`'s record (`reads`) and `second`'s
 * is empty, though its export `level` was computed from the shared file. */
function sharingProject(reads: Partial<ProbeOutput["results"][number]>) {
  const root = scratch();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
  const shared = join(root, "node_modules", "shared", "index.js");
  const paths = ["first", "second"].map((name) => join(root, "node_modules", name, "index.js"));
  for (const file of [shared, ...paths]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  const calls = paths.map((file) => ({
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: file },
      { kind: "strLit", value: "" },
    ],
  }));
  const mod = { functions: [{ body: calls }], globals: [] } as unknown as IrModule;
  const record = { inputs: [], volatile: [], effects: [], mutations: [], env: [], tty: [] };
  const probe: ProbeOutput = {
    results: [
      { ...record, ...reads, path: paths[0]!, root: 1, files: [paths[0]!, shared] },
      { ...record, path: paths[1]!, root: 2, files: [paths[1]!, shared] },
    ],
    objects: {
      "1": { f: 0, p: false, m: [["level", { s: "info" }]] },
      "2": { f: 0, p: false, m: [["level", { s: "info" }]] },
    },
  };
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
  // A load that stays eager loses its snapshot argument.
  const snapshots = calls.map((call) => (call.args[1] as { value: string } | undefined)?.value);
  return { decisions, calls, snapshots };
}

describe("modules that share a file", () => {
  test("carry the guards of what the shared file read", () => {
    const { decisions, snapshots } = sharingProject({
      env: [["LOG_LEVEL", null]],
      tty: [[1, false]],
    });
    expect(decisions.map((d) => d.deferred)).toEqual([true, true]);
    for (const text of snapshots) {
      expect(text).toMatch(/K \d 5:level s4:info/);
      expect(text).toContain("E 9:LOG_LEVEL 0 0:");
      expect(text).toContain("T 1 0");
    }
  });

  test("stay eager together for a set variable outside publicEnv", () => {
    const { decisions, calls } = sharingProject({ env: [["LOG_LEVEL", "debug"]] });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("LOG_LEVEL");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
  });

  test("stay eager together for an input no guard covers", () => {
    const { decisions } = sharingProject({ inputs: ["process.cwd() (shared/index.js:1:1)"] });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("process.cwd()");
  });

  test("snapshot no constants when the shared file read the clock", () => {
    const { decisions, snapshots } = sharingProject({ volatile: ["Date.now()"] });
    expect(decisions.map((d) => d.deferred)).toEqual([true, true]);
    for (const text of snapshots) expect(text).not.toContain("4:info");
  });
});

describe("the order deferred loads are probed in", () => {
  const defer = (path: string) => ({
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: path },
      { kind: "strLit", value: "" },
    ],
  });
  const load = (call: unknown) => ({ kind: "assign", localId: "%g.island.0", value: call });
  const init = (callee: string) => ({
    kind: "exprStmt",
    expr: { kind: "call", callee, args: [] },
  });
  // The run-once guard of an initializer, `if (ran) return;` (parsed: an
  // object literal with a `then` key reads as a thenable to the linter).
  const guard: unknown = JSON.parse(
    '{"kind":"if","cond":{},"then":[{"kind":"return","value":null}],"else_":null}',
  );
  const paths = (mod: unknown, calls: unknown[]): string[] =>
    evaluationOrder(mod as IrModule, calls as Parameters<typeof evaluationOrder>[1]).map(
      (c) => (c.args[0] as { value: string }).value,
    );

  test("is the program's evaluation order, not the order of the IR's functions", () => {
    // main.ts: import "a"; import "./dep" (which imports "b"); then its body
    // requires "c". The IR lists dep's initializer first.
    const a = defer("a");
    const b = defer("b");
    const c = defer("c");
    const mod = {
      entry: "%main",
      functions: [
        { name: "%init.7", body: [guard, load(b)] },
        { name: "%init.0", body: [load(a), init("%init.7"), { kind: "block", body: [load(c)] }] },
        { name: "%main", body: [init("%init.0")] },
      ],
    };
    expect(paths(mod, [b, a, c])).toEqual(["a", "b", "c"]);
  });

  test("an inline require() is walked through the sequence it lowers to", () => {
    // A top-level `require("./dep")` lowers to seqExpr([%init.1 call], read):
    // the loads inside the required module come where the require is written,
    // ahead of the ones the rest of the initializer reaches.
    const required = defer("required");
    const later = defer("later");
    const require = {
      kind: "seqExpr",
      stmts: [init("%init.1")],
      result: { kind: "varRef", localId: "%g.island.0" },
    };
    const mod = {
      entry: "%main",
      functions: [
        { name: "%init.1", body: [load(required)] },
        { name: "%main", body: [{ kind: "exprStmt", expr: require }, load(later)] },
      ],
    };
    expect(paths(mod, [later, required])).toEqual(["required", "later"]);
  });

  test("an inline require() inside a string comparison is walked at its position", () => {
    // `"x" === require("./a")` keeps the require's sequence inside the
    // comparison's right operand, and `require("./b") < "y"` inside its left
    // one. Both comparisons are evaluated where they are written, so the
    // loads inside the required modules come ahead of the later statement's.
    const requiredA = defer("requiredA");
    const requiredB = defer("requiredB");
    const later = defer("later");
    const requireA = {
      kind: "seqExpr",
      stmts: [init("%init.1")],
      result: { kind: "varRef", localId: "%g.island.0" },
    };
    const requireB = {
      kind: "seqExpr",
      stmts: [init("%init.2")],
      result: { kind: "varRef", localId: "%g.island.1" },
    };
    const mod = {
      entry: "%main",
      functions: [
        { name: "%init.1", body: [load(requiredA)] },
        { name: "%init.2", body: [load(requiredB)] },
        {
          name: "%main",
          body: [
            {
              kind: "varDecl",
              localId: "same",
              init: {
                kind: "strEq",
                negated: false,
                left: { kind: "strLit", value: "x" },
                right: requireA,
              },
            },
            {
              kind: "varDecl",
              localId: "before",
              init: {
                kind: "strCmp",
                op: "lt",
                left: requireB,
                right: { kind: "strLit", value: "y" },
              },
            },
            load(later),
          ],
        },
      ],
    };
    expect(paths(mod, [later, requiredB, requiredA])).toEqual(["requiredA", "requiredB", "later"]);
  });

  test("an initializer that awaits continues after the code that called it", () => {
    // dep awaits between its two loads; the importer starts its next
    // dependency before waiting for either.
    const first = defer("first");
    const second = defer("second");
    const sibling = defer("sibling");
    const own = defer("own");
    const pending = { kind: "awaitExpr", value: { kind: "varRef", localId: "p" } };
    const mod = {
      entry: "%main",
      functions: [
        {
          name: "%init.1",
          body: [load(first), { kind: "exprStmt", expr: pending }, load(second)],
        },
        { name: "%init.2", body: [load(sibling)] },
        {
          name: "%init.0",
          body: [
            { kind: "varDecl", localId: "d1", init: { kind: "call", callee: "%init.1", args: [] } },
            init("%init.2"),
            { kind: "exprStmt", expr: pending },
            load(own),
          ],
        },
        {
          name: "%main",
          body: [
            {
              kind: "exprStmt",
              expr: { kind: "awaitExpr", value: { kind: "call", callee: "%init.0", args: [] } },
            },
          ],
        },
      ],
    };
    expect(paths(mod, [first, second, sibling, own])).toEqual([
      "first",
      "sibling",
      "second",
      "own",
    ]);
  });

  test("a load inside an expression is reached where the expression is", () => {
    // main.js: `const isA = require("a").name === "a";`, then `require("./dep")`
    // (which requires "b"). The first load sits inside a member read inside
    // a comparison inside a sequence expression.
    const a = defer("a");
    const b = defer("b");
    const nested = {
      kind: "bin",
      op: "===",
      left: {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: "m", init: a }],
        result: { kind: "libCall", fn: "nodeIsland.get", args: [{ kind: "varRef", localId: "m" }] },
      },
      right: { kind: "strLit", value: "a" },
    };
    const mod = {
      entry: "%main",
      functions: [
        { name: "%init.3", body: [load(b)] },
        {
          name: "%init.0",
          body: [{ kind: "assign", localId: "%g.isA", value: nested }, init("%init.3")],
        },
        { name: "%main", body: [init("%init.0")] },
      ],
    };
    expect(paths(mod, [b, a])).toEqual(["a", "b"]);
  });

  test("loads the walk does not reach keep the IR's order, after the others", () => {
    const reachedLoad = defer("reached");
    const inFunction = defer("in-function");
    const mod = {
      entry: "%main",
      functions: [
        { name: "helper", body: [load(inFunction)] },
        { name: "%init.0", body: [load(reachedLoad)] },
        { name: "%main", body: [init("%init.0")] },
      ],
    };
    expect(paths(mod, [inFunction, reachedLoad])).toEqual(["reached", "in-function"]);
  });
});

describe("generated island modules (closed-island-init.ts)", () => {
  /** A project whose entry imports the package `dep` and then loads two
   * generated modules: one at a fixed point of the program's start, one
   * inside a function. The probe's stand-in records what it was given and
   * answers a deterministic load for every module. */
  function generatedProject() {
    const root = scratch();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "package.json"), '{ "name": "dep" }');
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "exports.make = () => ({});\n");
    const text = (name: string) =>
      `import dep from "../../node_modules/dep/index.js";\nexport const ${name} = dep.make();\n`;
    const defer = (path: string) => ({
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: path },
        { kind: "strLit", value: "" },
      ],
    });
    const load = (call: unknown) => ({ kind: "assign", localId: "%g.island.0", value: call });
    const dep = defer("./node_modules/dep/index.js");
    const fixed = defer("./.scriptc/closed/main.0000000000.0.mjs");
    const late = defer("./.scriptc/closed/main.0000000000.1.mjs");
    const mod = {
      entry: "%main",
      functions: [
        { name: "helper", body: [load(late)] },
        { name: "%init.0", body: [load(dep), load(fixed)] },
        {
          name: "%main",
          body: [{ kind: "exprStmt", expr: { kind: "call", callee: "%init.0", args: [] } }],
        },
      ],
      globals: [],
      nodeIsland: {
        libnode: "",
        nodeVersion: "",
        modules: {
          root,
          files: [
            {
              path: ".scriptc/closed/main.0000000000.0.mjs",
              size: 0,
              sha256: "",
              generated: text("a"),
            },
            {
              path: ".scriptc/closed/main.0000000000.1.mjs",
              size: 0,
              sha256: "",
              generated: text("b"),
            },
            { path: "node_modules/dep/index.js", size: 0, sha256: "" },
          ],
          links: [],
        },
      },
    } as unknown as IrModule;
    const seen: { modules: string[]; generated: string[]; copy: string } = {
      modules: [],
      generated: [],
      copy: "",
    };
    const decisions = finalizeDeferredIslands(
      mod,
      join(root, "main.ts"),
      root,
      (_pack, modules, generated) => {
        seen.modules = modules;
        seen.generated = generated;
        seen.copy = readFileSync(modules[1]!, "utf8");
        return {
          results: modules.map((path, i) => ({
            path,
            root: i + 1,
            inputs: [],
            volatile: [],
            effects: [],
            mutations: [],
            env: [],
            tty: [],
            files: [path, join(root, "node_modules", "dep", "index.js")],
          })),
          objects: {
            "1": { f: 0, p: false, m: [] },
            "2": { f: 0, p: false, m: [["a", { n: "7" }]] },
          },
        };
      },
    );
    return { root, decisions, seen, dep, fixed, late };
  }

  test("are probed from copies outside the tree, in the program's order", () => {
    const { root, seen } = generatedProject();
    expect(seen.modules).toHaveLength(2);
    expect(seen.modules[0]).toBe(join(root, "node_modules", "dep", "index.js"));
    expect(seen.modules[1]!.startsWith(root)).toBe(false);
    expect(seen.generated).toContain(seen.modules[1]);
    expect(seen.copy).toBe(
      `import dep from ${JSON.stringify(join(root, "node_modules", "dep", "index.js"))};\n` +
        "export const a = dep.make();\n",
    );
    expect(existsSync(seen.modules[1]!)).toBe(false);
  });

  test("defer at a fixed point of the program's start, with no guard for the copy", () => {
    const { decisions, fixed, seen } = generatedProject();
    const decision = decisions.find((d) => d.path.endsWith("main.0000000000.0.mjs"))!;
    expect(decision.deferred).toBe(true);
    expect(decision.reason).toContain("recorded evaluation is deterministic");
    const snapshot = (fixed.args[1] as { value: string }).value;
    expect(snapshot).toContain("K 2 1:a n7");
    expect(snapshot).not.toContain(seen.modules[1]!);
  });

  test("load where they stand when the program can reach them at another point", () => {
    const { decisions, late } = generatedProject();
    const decision = decisions.find((d) => d.path.endsWith("main.0000000000.1.mjs"))!;
    expect(decision.deferred).toBe(false);
    expect(decision.reason).toContain("one fixed point of its start: no static import leads to it");
    expect(late.fn).toBe("nodeIsland.require");
  });

  test("keep the program out of per-module mode", () => {
    const { decisions, dep } = generatedProject();
    expect(decisions.find((d) => d.path.endsWith("index.js"))!.reason).toContain(
      "evaluated when Node starts",
    );
    expect((dep.args[1] as { value: string }).value).not.toMatch(/^M /m);
  });
});
