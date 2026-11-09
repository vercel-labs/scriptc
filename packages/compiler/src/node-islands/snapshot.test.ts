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
  type ProbeValue,
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
 * holds only its own reads (`secondReads`), though its export `level` was
 * computed from the shared file. */
function sharingProject(
  reads: Partial<ProbeOutput["results"][number]>,
  secondReads: Partial<ProbeOutput["results"][number]> = {},
  scriptc: unknown = undefined,
  level = "info",
) {
  const root = scratch();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scriptc }));
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
      { ...record, ...secondReads, path: paths[1]!, root: 2, files: [paths[1]!, shared] },
    ],
    objects: {
      "1": { f: 0, p: false, m: [["level", { s: level }]] },
      "2": { f: 0, p: false, m: [["level", { s: level }]] },
    },
  };
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
  // A load that stays eager loses its snapshot argument.
  const snapshots = calls.map((call) => (call.args[1] as { value: string } | undefined)?.value);
  return { decisions, calls, snapshots, text: JSON.stringify(mod) };
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

  test("stay eager together for a set variable another load saw unset", () => {
    // The shared file read the value; `first` deleted the variable, so
    // `second`'s own read found it unset, while its export holds the value.
    const secret = "sk-build-only-0123456789";
    const { decisions, calls, text } = sharingProject(
      { env: [["API_TOKEN", secret]], effects: ["a delete of process.env.API_TOKEN"] },
      { env: [["API_TOKEN", null]] },
      undefined,
      secret,
    );
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("API_TOKEN");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
    expect(text).not.toContain(secret);
  });

  test("stay eager together for a publicEnv variable the loads read differently", () => {
    const { decisions } = sharingProject(
      { env: [["NODE_ENV", "production"]] },
      { env: [["NODE_ENV", null]] },
      { nodeIslands: { publicEnv: ["NODE_ENV"] } },
    );
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain(
      "read the environment variable NODE_ENV with different values",
    );
  });

  test("stay eager together for an input no guard covers", () => {
    const { decisions } = sharingProject({ inputs: ["process.cwd() (shared/index.js:1:1)"] });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("process.cwd()");
  });

  test("neither snapshots when the shared file read the clock", () => {
    // Until the recorder's rule for ambient reads, the load whose own record
    // named the clock deferred with no constants and only the other stayed
    // eager. That was wrong for the first as well, for three reasons. A load
    // evaluated when Node starts reads the clock after the program's own
    // readings that followed its import, where Node read it before them. A
    // snapshot without constants still keeps the build's object flags and
    // object links, which answer `typeof` and hand out members from the
    // build's reading ("the effects of a file that modules share", below,
    // said so of the other load). And what the load left in shared state is
    // in the constants of the loads probed after it.
    const { decisions, calls, text } = sharingProject({ volatile: ["Date.now()"] });
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
    expect(decisions[0]!.reason).toContain("its load reads Date.now()");
    expect(decisions[1]!.reason).toContain("a load it shares a file with reads Date.now()");
    expect(text).not.toContain("4:info");
  });
});

describe("the effects of a file that modules share", () => {
  /** Two island modules, `first` and `second`, probed in that order; the
   * probe evaluated `common`, a file both load, in `first`'s load, and
   * what that evaluation did and read is in `first`'s record (`record`). */
  function sharing(
    record: Partial<ProbeOutput["results"][number]>,
    shared = true,
    on: "first" | "second" = "first",
  ) {
    const root = scratch();
    writeFileSync(join(root, "package.json"), '{ "name": "app" }');
    const file = (name: string): string => {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
      writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
      return join(dir, "index.js");
    };
    const [first, second, common] = [file("first"), file("second"), file("common")];
    const load = (path: string) => ({
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: path },
        { kind: "strLit", value: "" },
      ],
    });
    const calls = [load(first), load(second)];
    const mod = { functions: [{ body: calls }], globals: [] } as unknown as IrModule;
    const empty = { inputs: [], volatile: [], effects: [], mutations: [], env: [], tty: [] };
    const probe: ProbeOutput = {
      results: [
        {
          ...empty,
          ...(on === "first" ? record : {}),
          path: first,
          root: 1,
          files: [first, common],
        },
        {
          ...empty,
          ...(on === "second" ? record : {}),
          path: second,
          root: 2,
          files: shared ? [second, common] : [second],
        },
      ],
      objects: {
        "1": { f: 0, p: false, m: [["count", { s: "three" }]] },
        "2": { f: 0, p: false, m: [["count", { s: "three" }]] },
      },
    };
    const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
    // An eager load has lost its snapshot argument.
    const snapshots = calls.map((c) => c.args[1]?.value ?? "");
    return { decisions, calls, snapshots };
  }

  test("neither defers when the load that evaluated the file has effects", () => {
    // The probe reached `first` first, so the shared file's output is in
    // its record and `second`'s is empty. A run that skips `first` (it is
    // written under a condition) evaluates the file in `second`'s load.
    const { decisions, calls } = sharing({ effects: ["process.stdout.write()"] });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[0]!.reason).toContain("its load has effects");
    expect(decisions[1]!.reason).toContain("a load it shares a file with has effects");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
  });

  test("it does not matter which of the two the probe reached first", () => {
    // 41f67e22a1's case: the load with effects is probed after the one
    // that shares its file.
    const { decisions } = sharing({ effects: ["process.stdout.write()"] }, true, "second");
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[0]!.reason).toContain("a load it shares a file with has effects");
  });

  test("neither defers when the load that evaluated the file read an input", () => {
    // `second`'s exports can hold what the shared file computed from the
    // input (the arguments, the working directory): not a constant.
    const { decisions } = sharing({ inputs: ["process.argv"] });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("a load it shares a file with reads process.argv");
  });

  test("a load that read the clock does not defer, nor does a module that shares its file", () => {
    // A snapshot written without constants still keeps the object's flags and
    // its object links, and those answer `typeof` without evaluating the
    // module: an export's type can come from the read as its value can. That
    // holds for the load that read the clock as it does for the one that
    // shares its file, and the reader has one more reason: evaluated when
    // Node starts, it would read the clock after the program's own readings
    // that followed its import.
    const { decisions, calls } = sharing({ volatile: ["Date.now()"] });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[0]!.reason).toContain("its load reads Date.now()");
    expect(decisions[0]!.reason).toContain("no run repeats the reading");
    expect(decisions[1]!.reason).toContain("a load it shares a file with reads Date.now()");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);

    // The same when the probe reached the other module first.
    const other = sharing({ volatile: ["Date.now()"] }, true, "second");
    expect(other.decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(other.decisions[0]!.reason).toContain("a load it shares a file with reads Date.now()");
    expect(other.decisions[1]!.reason).toContain("its load reads Date.now()");
    expect(other.calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
  });

  test("a load probed after one that read what no run repeats has no snapshot", () => {
    // The first load drew a random number and evaluates where it is
    // imported. The second shares no file with it, but the probe evaluated
    // it in an island that held the build's draw, and its constants can hold
    // that draw (a package exporting what the first left in a global). No
    // run is answered from such a snapshot: Node is running once the first
    // load has evaluated, and a run that skips the first load fails the
    // second's guard on the loads before it. The snapshot would be dead
    // bytes that differ from one build to the next, so none is written.
    const apart = sharing({ volatile: ["Math.random()"] }, false);
    expect(apart.decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(apart.decisions[0]!.reason).toContain("its load reads Math.random()");
    expect(apart.decisions[1]!.reason).toContain("an earlier load reads Math.random()");
    expect(apart.decisions[1]!.reason).toContain("could hold the build's reading");
    expect(apart.calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
    expect(apart.snapshots.join("")).not.toContain("three");

    // The clock and the process id are such readings too.
    for (const reading of ["Date.now()", "process.pid"]) {
      const next = sharing({ volatile: [reading] }, false);
      expect(next.decisions.map((d) => d.deferred)).toEqual([false, false]);
      expect(next.decisions[1]!.reason).toContain(`an earlier load reads ${reading}`);
    }

    // A load the probe reached before it computed from nothing of the
    // reading: it defers with its constants.
    const before = sharing({ volatile: ["Math.random()"] }, false, "second");
    expect(before.calls.map((c) => c.fn)).toEqual(["nodeIsland.defer", "nodeIsland.require"]);
    expect(before.snapshots[0]).toContain("5:three");
  });

  test("a module that shares nothing with such a load has no snapshot either", () => {
    // The probe evaluated the second load after the first, in an island
    // that holds what the first left there, and no run is answered from
    // its snapshot (the first load never registers).
    for (const record of [{ effects: ["process.stdout.write()"] }, { inputs: ["process.argv"] }]) {
      const apart = sharing(record, false);
      expect(apart.decisions.map((d) => d.deferred)).toEqual([false, false]);
      expect(apart.decisions[1]!.reason).toContain(
        "an earlier load evaluates where it is imported",
      );
      expect(apart.snapshots.join("")).not.toContain("three");
    }
    // A load the probe reached before it defers.
    for (const record of [{ effects: ["process.stdout.write()"] }, { inputs: ["process.argv"] }])
      expect(sharing(record, false, "second").calls.map((c) => c.fn)).toEqual([
        "nodeIsland.defer",
        "nodeIsland.require",
      ]);
  });

  test("modules that share a file whose loads read nothing and do nothing both defer", () => {
    expect(sharing({}).decisions.map((d) => d.deferred)).toEqual([true, true]);
  });
});

/** The `P` record's hash over `loads` (snapshot.ts loadsHash). */
function loadsHash(loads: string[]): number {
  let h = 2166136261;
  for (const load of loads)
    for (const byte of Buffer.from(`${load}\n`, "utf8")) h = Math.imul(h ^ byte, 16777619) >>> 0;
  return h;
}

describe("the loads a snapshot was recorded after", () => {
  /** Island modules of separate packages, loaded in the order given (a name
   * may repeat: the program imports it twice), and the probe's record of
   * each load. The modules share no file; whatever one leaves in the
   * probe's process (a global, a prototype, another module's state) is
   * there for the loads after it, and no record says who read it. */
  function sequence(
    names: string[],
    records: Record<string, Partial<ProbeOutput["results"][number]>> = {},
    scriptc: unknown = {},
  ) {
    const root = scratch();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scriptc }));
    const paths = new Map<string, string>();
    for (const name of new Set(names)) {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
      writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
      paths.set(name, join(dir, "index.js"));
    }
    const calls = names.map((name) => ({
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: paths.get(name)! },
        { kind: "strLit", value: "" },
      ],
    }));
    const mod = { functions: [{ body: calls }], globals: [] } as unknown as IrModule;
    const empty = { inputs: [], volatile: [], effects: [], mutations: [], env: [], tty: [] };
    const distinct = [...paths.keys()];
    const probe: ProbeOutput = {
      results: distinct.map((name, i) => ({
        ...empty,
        path: paths.get(name)!,
        root: i + 1,
        files: [paths.get(name)!],
        ...records[name],
      })),
      objects: Object.fromEntries(
        distinct.map((_, i) => [String(i + 1), { f: 0, p: false, m: [] }]),
      ),
    };
    const seen: string[][] = [];
    const decisions = finalizeDeferredIslands(
      mod,
      join(root, "main.ts"),
      root,
      (_pack, modules) => {
        seen.push(modules);
        return probe;
      },
    );
    const record = (i: number): string | undefined =>
      /^P .*$/m.exec((calls[i]!.args[1] as { value: string }).value)?.[0];
    const before = (...loaded: string[]): string =>
      `P ${loaded.length} ${loadsHash(loaded.map((name) => paths.get(name)!))}`;
    return { decisions, calls, record, before, probed: seen[0]!, paths };
  }

  test("every deferred module names the loads the probe evaluated before it", () => {
    const { decisions, record, before } = sequence(["writer", "reader", "other"]);
    expect(decisions.map((d) => d.deferred)).toEqual([true, true, true]);
    expect(record(0)).toBe(before());
    expect(record(1)).toBe(before("writer"));
    expect(record(2)).toBe(before("writer", "reader"));
  });

  test("whatever the earlier load is recorded to have written, or not", () => {
    // The record does not depend on the probe having noticed a write: a
    // module's private state and a builtin's have no property to compare.
    const noticed = sequence(["writer", "reader"], {
      writer: { mutations: ["globalThis.level"] },
    });
    const unnoticed = sequence(["writer", "reader"]);
    expect(noticed.decisions.map((d) => d.deferred)).toEqual([true, true]);
    expect(noticed.record(1)).toBe(noticed.before("writer"));
    expect(unnoticed.record(1)).toBe(unnoticed.before("writer"));
  });

  test("a load probed after one the build keeps eager has no snapshot", () => {
    // The probe evaluated it, so the later load computed from what it left.
    // A run that performs it has started Node; one that skips it (a branch
    // not taken) has not registered it. No run reads the later snapshot.
    for (const writer of [
      { effects: ["process.on() (writer/index.js:1:9)"], mutations: ["globalThis.level"] },
      { effects: ["process.on() (writer/index.js:1:9)"] },
    ]) {
      const { decisions, calls } = sequence(["writer", "reader", "other"], { writer });
      expect(decisions.map((d) => d.deferred)).toEqual([false, false, false]);
      expect(calls.map((c) => c.fn)).toEqual([
        "nodeIsland.require",
        "nodeIsland.require",
        "nodeIsland.require",
      ]);
      expect(decisions[1]!.reason).toContain("an earlier load evaluates where it is imported");
    }
    // The loads the probe reached before it keep their snapshots.
    const later = sequence(["reader", "writer", "reader"], {
      writer: { effects: ["process.on() (writer/index.js:1:9)"] },
    });
    expect(later.calls.map((c) => c.fn)).toEqual([
      "nodeIsland.defer",
      "nodeIsland.require",
      "nodeIsland.defer",
    ]);
    expect(later.record(0)).toBe(later.before());
    expect(later.record(2)).toBe(later.before());
  });

  test("a module imported twice is probed once and carries one record", () => {
    const { decisions, record, before, probed, paths } = sequence(["writer", "reader", "writer"]);
    expect(decisions.map((d) => d.deferred)).toEqual([true, true, true]);
    expect(probed).toEqual([paths.get("writer"), paths.get("reader")]);
    // Its second import passes because the load is registered already
    // (scr_node_island_boot.c), not because the loads before it match.
    expect(record(0)).toBe(before());
    expect(record(2)).toBe(before());
    expect(record(1)).toBe(before("writer"));
  });

  test('"evaluate": "lazy" defers a module whatever its load does, not whatever came before it', () => {
    const { decisions, record, before } = sequence(
      ["writer", "reader"],
      { reader: { effects: ["process.on() (reader/index.js:1:9)"] } },
      { packages: { reader: { evaluate: "lazy" } } },
    );
    expect(decisions.map((d) => d.deferred)).toEqual([true, true]);
    expect(record(1)).toBe(before("writer"));
  });
});

describe('the keys of a "lazy" load that read an input', () => {
  test("only keys the load's files spell are written", () => {
    const root = scratch();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", scriptc: { packages: { hosts: { evaluate: "lazy" } } } }),
    );
    const dir = join(root, "node_modules", "hosts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "name": "hosts" }');
    const file = join(dir, "index.js");
    writeFileSync(
      file,
      'exports.byHost = { [require("os").hostname()]: { up: true } };\nexports.describe = () => "hosts";\n',
    );
    const call = {
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: file },
        { kind: "strLit", value: "" },
      ],
    };
    const mod = { functions: [{ body: [call] }], globals: [] } as unknown as IrModule;
    const host = "build-host-7c21";
    const probe: ProbeOutput = {
      results: [
        {
          path: file,
          root: 1,
          inputs: ["os.hostname() (hosts/index.js:1:39)"],
          volatile: [],
          effects: [],
          mutations: [],
          env: [],
          tty: [],
          files: [file],
        },
      ],
      objects: {
        "1": {
          f: 0,
          p: false,
          m: [
            ["byHost", { o: 2 }],
            ["describe", { o: 4 }],
          ],
        },
        "2": { f: 0, p: false, m: [[host, { o: 3 }]] },
        "3": { f: 0, p: false, m: [] },
        "4": { f: 1, p: false, m: [] },
      },
    };
    const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
    expect(decisions.map((d) => d.deferred)).toEqual([true]);
    const text = call.args[1]!.value;
    expect(text).toMatch(/^K 1 6:byHost o2$/m);
    expect(text).toMatch(/^K 1 8:describe o4$/m);
    expect(text).not.toContain(host);
    expect(text).not.toMatch(/^O 3 /m);
  });
});

describe("state an earlier load wrote", () => {
  /** Two island modules that share no file, probed in that order, and the
   * probe's records of their loads. `ga` reads a private environment value
   * and writes it to a global; `gb` exports the global's value, so the
   * probe recorded that value in `gb`'s load too. */
  function handoff(
    first: Partial<ProbeOutput["results"][number]>,
    second: Partial<ProbeOutput["results"][number]> = {},
    scriptc: unknown = {},
    secondMembers: [string, ProbeValue][] = [["token", { s: "sk-live-0123456789" }]],
  ) {
    const root = scratch();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scriptc }));
    const file = (name: string): string => {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
      writeFileSync(
        join(dir, "index.js"),
        name === "ga"
          ? "globalThis.token = process.env.TOKEN;\nmodule.exports = { ready() {} };\n"
          : "module.exports = { token: globalThis.token };\n",
      );
      return join(dir, "index.js");
    };
    const [ga, gb] = [file("ga"), file("gb")];
    const load = (path: string) => ({
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: path },
        { kind: "strLit", value: "" },
      ],
    });
    const calls = [load(ga), load(gb)];
    const mod = { functions: [{ body: calls }], globals: [] } as unknown as IrModule;
    const secret = "sk-live-0123456789";
    const empty = { inputs: [], volatile: [], effects: [], mutations: [], env: [], tty: [] };
    const probe: ProbeOutput = {
      results: [
        { ...empty, path: ga, root: 1, files: [ga], ...first },
        { ...empty, path: gb, root: 2, files: [gb], ...second },
      ],
      objects: {
        "1": { f: 0, p: false, m: [["ready", { o: 3 }]] },
        "2": { f: 0, p: false, m: secondMembers },
        "3": { f: 1, p: false, m: [] },
      },
    };
    const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
    const snapshots = calls.map((c) => c.args[1]?.value ?? "");
    return { decisions, calls, snapshots, text: JSON.stringify(mod), secret };
  }
  const toGlobal = { env: [["TOKEN", "sk-live-0123456789"]] as [string, string | null][] };

  test("a later snapshot does not carry what an earlier load read and wrote", () => {
    const { decisions, calls, snapshots, text, secret } = handoff({
      ...toGlobal,
      mutations: ["globalThis.token"],
    });
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    // The reader keeps its own reason; the module after it names the read.
    expect(decisions[0]!.reason).toContain("TOKEN");
    expect(decisions[1]!.reason).toContain("TOKEN");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
    expect(snapshots.join("")).not.toContain(secret);
    expect(text).not.toContain(secret);
  });

  test("a later snapshot does not carry the value when the probe noticed no write", () => {
    // The earlier load can leave the value where the probe compares nothing:
    // a member of `console`, a builtin's private state, an object deeper
    // than the members the probe compares.
    const { decisions, calls, snapshots, text, secret } = handoff(toGlobal);
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("TOKEN");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
    expect(snapshots.join("")).not.toContain(secret);
    expect(text).not.toContain(secret);
  });

  test('a load probed after a "lazy" one that read an input keeps no constants', () => {
    // `ga` is "lazy" and leaves the working directory in a global; `gb`
    // exports the global, and its own record reads nothing.
    const cwd = "/home/builder/project";
    const { decisions, calls, snapshots, text } = handoff(
      { inputs: ["process.cwd() (ga/index.js:1:17)"] },
      {},
      { packages: { ga: { evaluate: "lazy" } } },
      [["cwd", { s: cwd }]],
    );
    expect(decisions.map((d) => d.deferred)).toEqual([true, true]);
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.defer", "nodeIsland.defer"]);
    expect(decisions[1]!.reason).toContain("probed after a load that reads process.cwd()");
    expect(snapshots[1]).toMatch(/^R 2$/m);
    expect(text).not.toContain(cwd);
  });

  test("a variable the earlier load wrote does not reach a later guard", () => {
    // `ga` reads a private variable and writes the value into a variable the
    // project lists as public; `gb` reads that one, so its boot guard would
    // record the private value.
    const { decisions, calls, snapshots, secret } = handoff(
      { ...toGlobal, effects: ["a write of process.env.NODE_ENV"] },
      { env: [["NODE_ENV", "sk-live-0123456789"]] },
      { nodeIslands: { publicEnv: ["NODE_ENV"] } },
      [],
    );
    expect(decisions.map((d) => d.deferred)).toEqual([false, false]);
    expect(decisions[1]!.reason).toContain("TOKEN");
    expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
    expect(snapshots.join("")).not.toContain(secret);
  });
});

describe("a package file a generated module's load evaluated first", () => {
  /** A package `kit` whose `config.js` reads a private environment value,
   * and a module the build wrote for a statement of the program
   * (`kit.use();`), which loads the package's files. The probe evaluates a
   * file in the first load that reaches it, so `config.js`'s read is in the
   * record of whichever of the two the probe loaded first, and the other's
   * record is empty with the file in its list.
   *   "package first": the import of `kit` comes before the statement, as a
   *     program has it.
   *   "generated first": the probe reached the statement's module first.
   *   "package unreached": the import of `kit` sits where the order walk
   *     does not reach, so the probe loads it after the others. */
  function evaluatedFirst(order: "package first" | "generated first" | "package unreached") {
    const root = scratch();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    const dir = join(root, "node_modules", "kit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "name": "kit" }');
    writeFileSync(join(dir, "config.js"), "exports.token = process.env.TOKEN;\n");
    writeFileSync(
      join(dir, "index.js"),
      'const { token } = require("./config.js");\nmodule.exports = { token, use() {} };\n',
    );
    const [index, config] = [join(dir, "index.js"), join(dir, "config.js")];
    const defer = (path: string) => ({
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: path },
        { kind: "strLit", value: "" },
      ],
    });
    const load = (call: unknown) => ({ kind: "assign", localId: "%g.island.0", value: call });
    const loads = {
      kit: "./node_modules/kit/index.js",
      statement: "./.scriptc/closed/main.0000000000.0.mjs",
    };
    const kit = defer(loads.kit);
    const statement = defer(loads.statement);
    const init =
      order === "package first"
        ? [load(kit), load(statement)]
        : order === "generated first"
          ? [load(statement), load(kit)]
          : [load(statement)];
    const mod = {
      entry: "%main",
      functions: [
        ...(order === "package unreached" ? [{ name: "later", body: [load(kit)] }] : []),
        { name: "%init.0", body: init },
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
              path: loads.statement.slice(2),
              size: 0,
              sha256: "",
              generated: 'import kit from "../../node_modules/kit/index.js";\nkit.use();\n',
            },
            { path: "node_modules/kit/index.js", size: 0, sha256: "" },
            { path: "node_modules/kit/config.js", size: 0, sha256: "" },
          ],
          links: [],
        },
      },
    } as unknown as IrModule;
    const secret = "sk-live-0123456789";
    const probed: string[] = [];
    const decisions = finalizeDeferredIslands(
      mod,
      join(root, "main.ts"),
      root,
      (_pack, modules) => {
        probed.push(...modules);
        return {
          results: modules.map((path, i) => ({
            path,
            // The package's value holds the token; the statement's is empty.
            root: path === index ? 1 : 2,
            inputs: [],
            volatile: [],
            effects: [],
            mutations: [],
            // The load the probe reached first evaluated `config.js`.
            env: (i === 0 ? [["TOKEN", secret]] : []) as [string, string | null][],
            tty: [],
            files: [path, index, config],
          })),
          objects: {
            "1": {
              f: 0,
              p: false,
              m: [
                ["token", { s: secret }],
                ["use", { o: 3 }],
              ],
            },
            "2": { f: 0, p: false, m: [] },
            "3": { f: 1, p: false, m: [] },
          },
        };
      },
    );
    const of = (end: string) => decisions.find((d) => d.path.endsWith(end))!;
    return {
      probed: probed.map((path) => (path === index ? "package" : "generated")),
      packageDecision: of("kit/index.js"),
      generatedDecision: of("main.0000000000.0.mjs"),
      calls: [kit, statement],
      text: JSON.stringify(mod),
      secret,
    };
  }

  test.each(["package first", "generated first", "package unreached"] as const)(
    "neither defers and no value is kept (%s)",
    (order) => {
      const { probed, packageDecision, generatedDecision, calls, text, secret } =
        evaluatedFirst(order);
      expect(probed).toEqual(
        order === "package first" ? ["package", "generated"] : ["generated", "package"],
      );
      // The package's snapshot would hold the token, whichever load read it.
      expect(packageDecision.deferred).toBe(false);
      expect(packageDecision.reason).toContain("TOKEN");
      expect(generatedDecision.deferred).toBe(false);
      expect(generatedDecision.reason).toContain("TOKEN");
      expect(calls.map((c) => c.fn)).toEqual(["nodeIsland.require", "nodeIsland.require"]);
      expect(text).not.toContain(secret);
    },
  );
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

  test("only the part of a conditional expression that always runs keeps its position", () => {
    // main.js: `const v = require("a").name && require("b").name;`, then a
    // load the initializer always reaches. Both inline require()s lower to
    // sequences: the left operand is evaluated where it is written, while
    // the right one runs only when the left is truthy. A load that may not
    // happen cannot be ordered ahead of one that does: with a file shared
    // between the two packages, the load that really evaluates it first has
    // to keep its effects, or it is deferred past the native side effects
    // that follow.
    const left = defer("left");
    const right = defer("right");
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
        { name: "%init.1", body: [load(left)] },
        { name: "%init.2", body: [load(right)] },
        {
          name: "%main",
          body: [
            {
              kind: "varDecl",
              localId: "v",
              init: {
                kind: "logical",
                op: "&&",
                left: requireA,
                right: requireB,
              },
            },
            load(later),
          ],
        },
      ],
    };
    expect(paths(mod, [left, right, later])).toEqual(["left", "later", "right"]);
  });

  test("a load in the condition of an if comes before the branch's loads", () => {
    // main.cjs: `if (require("a").flag) { require("b"); }`, then a load the
    // initializer always reaches. The condition always runs, and it runs
    // first: what a's load leaves in shared state (a global, a patched
    // builtin) is there when b loads, so b's snapshot has to be recorded
    // after a's load. Left out of the walk, a was probed after b and after
    // the later load, and b was deferred with what it computed without a.
    const a = defer("a");
    const b = defer("b");
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
    // Parsed, like the guard above: an object literal with a `then` key
    // reads as a thenable to the linter. The statement holds no load itself,
    // only calls of the initializers by name, so a copy serves.
    const cond = JSON.stringify({ kind: "member", object: requireA, name: "flag" });
    const selection = (then: unknown[]): unknown =>
      JSON.parse(`{"kind":"if","cond":${cond},"then":${JSON.stringify(then)},"else_":null}`);
    const program = (then: unknown[]) => ({
      entry: "%main",
      functions: [
        { name: "%init.1", body: [load(a)] },
        { name: "%init.2", body: [load(b)] },
        { name: "%main", body: [selection(then), load(later)] },
      ],
    });
    expect(paths(program([{ kind: "exprStmt", expr: requireB }]), [b, later, a])).toEqual([
      "a",
      "b",
      "later",
    ]);
    // The same when the branch holds no load: the condition's load is still
    // ahead of what follows the statement.
    expect(paths(program([]), [later, a])).toEqual(["a", "later"]);
  });

  describe("what a statement always evaluates keeps its place", () => {
    // main.cjs: one statement that holds `require("a")`, then a load the
    // initializer always reaches. Whatever the statement is, the program
    // evaluates a's load first whenever it evaluates that part at all.
    const a = defer("a");
    const later = defer("later");
    const requireA = {
      kind: "seqExpr",
      stmts: [init("%init.1")],
      result: { kind: "varRef", localId: "%g.island.0" },
    };
    const flag = { kind: "member", object: requireA, name: "flag" };
    const yes = { kind: "boolLit", value: true };
    const use = { kind: "exprStmt", expr: flag };
    const order = (statement: unknown): string[] =>
      paths(
        {
          entry: "%main",
          functions: [
            { name: "%init.1", body: [load(a)] },
            { name: "%init.2", body: [statement] },
            { name: "%main", body: [init("%init.2"), load(later)] },
          ],
        },
        [later, a],
      );

    test.each<[string, unknown]>([
      ["the condition of a while", { kind: "while", cond: flag, body: [] }],
      [
        "the initializer of a for",
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i", init: flag },
          cond: yes,
          update: null,
          body: [],
        },
      ],
      ["the condition of a for", { kind: "for", init: null, cond: flag, update: null, body: [] }],
      ["the first pass of a do body", { kind: "doWhile", body: [use], cond: yes }],
      ["the condition of a do", { kind: "doWhile", body: [], cond: flag }],
      ["the iterable of a for-of", { kind: "forOf", localId: "x", iterable: flag, body: [] }],
      ["the discriminant of a switch", { kind: "switch", disc: flag, cases: [] }],
      [
        "the first test of a switch",
        {
          kind: "switch",
          disc: yes,
          cases: [
            { test: null, body: [] },
            { test: flag, body: [] },
          ],
        },
      ],
      ["the operand of a throw", { kind: "throw", value: flag }],
      ["the operand of a return", { kind: "return", value: flag }],
      [
        "the value of a member write",
        { kind: "fieldSet", object: { kind: "varRef", localId: "o" }, name: "x", value: flag },
      ],
      [
        "a block inside a sequence",
        {
          kind: "exprStmt",
          expr: { kind: "seqExpr", stmts: [{ kind: "block", body: [use] }], result: yes },
        },
      ],
    ])("%s", (_name, statement) => {
      expect(order(statement)).toEqual(["a", "later"]);
    });

    test.each<[string, unknown]>([
      ["the body of a while", { kind: "while", cond: yes, body: [use] }],
      ["the body of a for", { kind: "for", init: null, cond: yes, update: null, body: [use] }],
      ["the update of a for", { kind: "for", init: null, cond: yes, update: use, body: [] }],
      ["the body of a for-of", { kind: "forOf", localId: "x", iterable: yes, body: [use] }],
      [
        "a later test of a switch",
        {
          kind: "switch",
          disc: yes,
          cases: [
            { test: yes, body: [] },
            { test: flag, body: [] },
          ],
        },
      ],
      ["the body of a case", { kind: "switch", disc: yes, cases: [{ test: yes, body: [use] }] }],
    ])("%s may not run, and stays after the loads that do", (_name, statement) => {
      expect(order(statement)).toEqual(["later", "a"]);
    });
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
   * generated modules: one where the entry's own statements reach it, one
   * inside a function. The probe's stand-in records what it was given and
   * answers a deterministic load for every module. */
  function generatedProject(
    options: {
      statement?: boolean;
      volatile?: string[];
      effects?: string[];
      /** Objects of the probe's output that replace the default ones, given
       * the modules the probe was handed and the tree's root. */
      objects?: (modules: string[], root: string) => ProbeOutput["objects"];
      /** A file outside the tree that `dep`'s load evaluated. */
      outside?: string;
    } = {},
  ) {
    const root = scratch();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "package.json"), '{ "name": "dep" }');
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "exports.make = () => ({});\n");
    const text = (name: string) =>
      `import dep from "../../node_modules/dep/index.js";\nexport const ${name} = dep.make();\n`;
    // A statement of the program the island evaluates: no export.
    const statement = `import dep from "../../node_modules/dep/index.js";\ndep.make();\n`;
    const defer = (path: string) => ({
      kind: "libCall",
      fn: "nodeIsland.defer",
      args: [
        { kind: "strLit", value: path },
        { kind: "strLit", value: "" },
      ],
    });
    const load = (call: unknown) => ({ kind: "assign", localId: "%g.island.0", value: call });
    const loads = {
      dep: "./node_modules/dep/index.js",
      first: "./.scriptc/closed/main.0000000000.0.mjs",
      second: "./.scriptc/closed/main.0000000000.1.mjs",
    };
    const dep = defer(loads.dep);
    const first = defer(loads.first);
    const second = defer(loads.second);
    const mod = {
      entry: "%main",
      functions: [
        { name: "helper", body: [load(second)] },
        { name: "%init.0", body: [load(dep), load(first)] },
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
            { path: loads.first.slice(2), size: 0, sha256: "", generated: text("a") },
            {
              path: loads.second.slice(2),
              size: 0,
              sha256: "",
              generated: options.statement === true ? statement : text("b"),
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
            volatile: i === 0 ? [] : (options.volatile ?? []),
            // The second generated module's own.
            effects: i === 2 ? (options.effects ?? []) : [],
            mutations: [],
            env: [],
            tty: [],
            files: [
              path,
              join(root, "node_modules", "dep", "index.js"),
              ...(i === 0 && options.outside !== undefined ? [join(root, options.outside)] : []),
            ],
          })),
          objects: {
            "1": { f: 0, p: false, m: [] },
            "2": { f: 0, p: false, m: [["a", { n: "7" }]] },
            "3": { f: 0, p: false, m: [["b", { n: "8" }]] },
            ...options.objects?.(modules, root),
          },
        };
      },
    );
    const snapshot = (call: { args: unknown[] }): string =>
      (call.args[1] as { value: string }).value;
    return { root, decisions, seen, loads, dep, first, second, snapshot };
  }

  test("are probed from copies outside the tree, in the program's order", () => {
    const { root, seen } = generatedProject();
    expect(seen.modules).toHaveLength(3);
    expect(seen.modules[0]).toBe(join(root, "node_modules", "dep", "index.js"));
    expect(seen.modules[1]!.startsWith(root)).toBe(false);
    expect(seen.modules[1]!.endsWith("main.0000000000.0.mjs")).toBe(true);
    expect(seen.modules[2]!.endsWith("main.0000000000.1.mjs")).toBe(true);
    expect(seen.generated).toEqual([seen.modules[1], seen.modules[2]]);
    expect(seen.copy).toBe(
      `import dep from ${JSON.stringify(join(root, "node_modules", "dep", "index.js"))};\n` +
        "export const a = dep.make();\n",
    );
    expect(existsSync(seen.modules[1]!)).toBe(false);
  });

  test("defer with their constants, and with no guard for the probe's copy", () => {
    const { decisions, first, seen, snapshot } = generatedProject();
    const decision = decisions.find((d) => d.path.endsWith("main.0000000000.0.mjs"))!;
    expect(decision.deferred).toBe(true);
    expect(decision.reason).toContain("recorded evaluation is deterministic");
    expect(snapshot(first)).toContain("K 2 1:a n7");
    expect(snapshot(first)).not.toContain(seen.modules[1]!);
  });

  test("are guarded by the loads the probe evaluated before them", () => {
    const { loads, dep, first, second, snapshot } = generatedProject();
    // The runtime uses a generated module's snapshot only in a run that
    // registered exactly these loads before it, in this order.
    expect(snapshot(first)).toMatch(new RegExp(`^P 1 ${loadsHash([loads.dep])}$`, "m"));
    expect(snapshot(second)).toMatch(
      new RegExp(`^P 2 ${loadsHash([loads.dep, loads.first])}$`, "m"),
    );
    // A package's entry point too: nothing before the first load.
    expect(snapshot(dep)).toMatch(new RegExp(`^P 0 ${loadsHash([])}$`, "m"));
  });

  test("a constant whose value names the probe's copy of its module stays eager", () => {
    // A package that finds its caller from a stack trace: the probe's caller
    // is the copy in a temporary directory of the build machine.
    const { decisions, first, seen } = generatedProject({
      objects: (modules) => ({
        "2": { f: 0, p: false, m: [["a", { s: `file://${modules[1]}:2:18` }]] },
      }),
    });
    const decision = decisions.find((d) => d.path.endsWith("main.0000000000.0.mjs"))!;
    expect(decision.deferred).toBe(false);
    expect(decision.reason).toBe("its exports hold a path of the build machine");
    expect(first.fn).toBe("nodeIsland.require");
    expect(JSON.stringify(first)).not.toContain(seen.modules[1]!);
  });

  test("a module whose member's key names a path of the build machine stays eager", () => {
    const { decisions, dep, root } = generatedProject({
      objects: (_modules, root) => ({
        "1": { f: 0, p: false, m: [[join(root, "node_modules", "dep"), { o: 4 }]] },
        "4": { f: 0, p: false, m: [] },
      }),
    });
    const decision = decisions.find((d) => d.path.endsWith(join("dep", "index.js")))!;
    expect(decision.deferred).toBe(false);
    expect(decision.reason).toBe("its exports hold a path of the build machine");
    expect(dep.fn).toBe("nodeIsland.require");
    expect(JSON.stringify(dep)).not.toContain(root);
  });

  test("a module whose value names a path of the build machine without its root stays eager", () => {
    const { decisions, dep, root } = generatedProject({
      objects: (_modules, root) => ({
        "1": { f: 0, p: false, m: [["dir", { s: join(root, "node_modules", "dep").slice(1) }]] },
      }),
    });
    const decision = decisions.find((d) => d.path.endsWith(join("dep", "index.js")))!;
    expect(decision.reason).toBe("its exports hold a path of the build machine");
    expect(dep.fn).toBe("nodeIsland.require");
    expect(JSON.stringify(dep)).not.toContain(root.slice(1));
  });

  test("a load that evaluated a file the tree does not ship stays eager, with no guard on it", () => {
    // A package another one requires by a computed name is not collected:
    // the executable's island cannot load it, and a guard on the build
    // machine's file would name its path.
    const hidden = join("node_modules", "hidden", "index.js");
    const { decisions, dep, first, root } = generatedProject({ outside: hidden });
    const decision = decisions.find((d) => d.path.endsWith(join("dep", "index.js")))!;
    expect(decision.deferred).toBe(false);
    expect(decision.reason).toBe(
      `its load evaluates ${join(root, hidden)}, which the shipped module tree does not hold`,
    );
    expect(dep.fn).toBe("nodeIsland.require");
    // The loads the probe reached after it have no snapshot either.
    expect(first.fn).toBe("nodeIsland.require");
  });

  test("a statement defers like a constant, with nothing in its snapshot but its guards", () => {
    const { decisions, second, snapshot } = generatedProject({ statement: true });
    const decision = decisions.find((d) => d.path.endsWith("main.0000000000.1.mjs"))!;
    expect(decision.deferred).toBe(true);
    expect(snapshot(second)).toMatch(/^P 2 \d+$/m);
  });

  test("a statement that read the clock stays where it stands, and so does a constant that did", () => {
    // A statement has no value at whose use a late failure could be raised,
    // and a constant's value read late is read after the program's own
    // readings: neither evaluation is the probe's.
    const { decisions } = generatedProject({ statement: true, volatile: ["Date.now()"] });
    const constant = decisions.find((d) => d.path.endsWith("main.0000000000.0.mjs"))!;
    const statement = decisions.find((d) => d.path.endsWith("main.0000000000.1.mjs"))!;
    expect(constant.deferred).toBe(false);
    expect(constant.reason).toContain("its load reads Date.now()");
    expect(statement.deferred).toBe(false);
    expect(statement.reason).toContain("its load reads Date.now()");
    // The package they both name read nothing: its import still waits.
    expect(decisions.find((d) => d.path.endsWith("dep/index.js"))!.deferred).toBe(true);
  });

  test("a generated module's effects are its own: the package it names and its neighbour still wait", () => {
    // The second module prints through the package's function. The
    // package's file evaluated in the package's own import, before it, and
    // did nothing; the first module does not import the second.
    const { decisions } = generatedProject({ effects: ["process.stdout.write()"] });
    const of = (end: string) => decisions.find((d) => d.path.endsWith(end))!;
    expect(of("dep/index.js").deferred).toBe(true);
    expect(of("main.0000000000.0.mjs").deferred).toBe(true);
    expect(of("main.0000000000.1.mjs").deferred).toBe(false);
    expect(of("main.0000000000.1.mjs").reason).toContain("its load has effects");
  });
});
