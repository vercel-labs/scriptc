/* Deferred island modules: the decision, the build-time probe and the
 * interface snapshot (scope-B NI-7, DESIGN.md §2.7, §5.4).
 *
 * Lowering emits `nodeIsland.defer(path, "")` for every static import of a
 * module of an island package (lower-node-island.ts); a program module that
 * runs in an island loads eagerly, so the probe never evaluates the
 * program's own source. After lowering, once the build
 * knows the libnode pack the executable will load, finalizeDeferredIslands
 * decides each one:
 *
 *   - the package's `evaluate` setting (`scriptc.packages.<name>`):
 *     "eager" keeps the module eager; "lazy" defers it whatever else its
 *     load does (the user judged the effects benign);
 *   - environment reads: the boot guards record the build-time value of
 *     every environment variable the load read, so a load that read one
 *     not listed in `scriptc.nodeIslands.publicEnv` stays eager, "lazy"
 *     included, and no value of it reaches the executable;
 *   - the probe: one run of the build-time probe host
 *     (runtime src/tools/scr_node_island_probe.c) in a libnode environment
 *     from the same pack, which loads every candidate module under the
 *     load recorder (probe-recorder.ts) and takes the interface snapshot of
 *     each module's value. "auto" (the default) defers a module whose
 *     recorded load threw nothing, had no effects and read no run-time
 *     input other than public env keys and stdio TTY state, which become
 *     boot guards (the determinism argument in probe-recorder.ts). The static
 *     effect gate (effect-gate.ts) is reported alongside, as the tier that
 *     needs no recording;
 *   - per-module mode (NI-7b): when every static island import defers,
 *     none mutates builtin state and no island module loads at a call site,
 *     Node starting evaluates nothing by itself; components of deferred
 *     modules that share files evaluate on first use. Otherwise every
 *     deferred module evaluates when Node starts (in import order);
 *
 * and rewrites the call: a deferred module keeps `nodeIsland.defer` with
 * its snapshot text (format: runtime scr_node_island_boot.c), any other
 * becomes the eager `nodeIsland.require(path)`. Without a pack on the
 * build host there is no probe, and every island stays eager. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBuildCacheRoot } from "../backend/cache-root.js";
import type { IrExpr, IrModule } from "../ir/ir.js";
import { everyStmtList } from "../ir/traverse.js";
import { readProjectConfig } from "../project-config.js";
import { islandBuildHost } from "./host.js";
import { packageDirOf } from "./origin.js";
import { PROBE_RECORDER } from "./probe-recorder.js";

type DeferCall = Extract<IrExpr, { kind: "libCall" }>;

/** The island loads of `mod` whose function is one of `fns`, each once, in
 * module order. Every expression of a module is in a function body. */
function islandLoads(mod: IrModule, fns: readonly string[]): DeferCall[] {
  const found = new Set<DeferCall>();
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      expr: (node) => {
        if (node.kind === "libCall" && fns.includes(node.fn)) found.add(node);
        return true;
      },
      stmt: () => true,
    });
  return [...found];
}

function deferCalls(mod: IrModule): DeferCall[] {
  return islandLoads(mod, ["nodeIsland.defer"]);
}

function pathOf(call: DeferCall): string {
  const arg = call.args[0];
  return arg !== undefined && arg.kind === "strLit" ? arg.value : "";
}

/** The build machine's file of a load's path: a `./` path names a file of
 * the shipped module tree (node-islands/modules.ts), under its root. */
function fileOf(mod: IrModule, path: string): string {
  const tree = mod.nodeIsland?.modules;
  return tree !== undefined && path.startsWith("./") ? join(tree.root, path.slice(2)) : path;
}

function makeEager(call: DeferCall): void {
  (call as { fn: string }).fn = "nodeIsland.require";
  call.args.length = 1;
}

export interface DeferralDecision {
  path: string;
  deferred: boolean;
  reason: string;
}

/** SCRIPTC_NODE_ISLANDS_TRACE=defer at build time prints each decision. */
function traceDecision(d: DeferralDecision): void {
  const t = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  if (t !== undefined && t.includes("defer"))
    process.stderr.write(
      `[node-islands] ${d.deferred ? "defer" : "eager"} ${d.path}${d.reason ? `: ${d.reason}` : ""}\n`,
    );
}

/** Island loads lowering emitted at call sites (`require()`, `import()`). */
function hasDynamicLoads(mod: IrModule): boolean {
  return islandLoads(mod, ["nodeIsland.require", "nodeIsland.import"]).length > 0;
}

export function finalizeDeferredIslands(
  mod: IrModule,
  entryPath: string,
  packDir: string | null,
  probeModules: (packDir: string, modules: string[]) => ProbeOutput | string = runProbe,
): DeferralDecision[] {
  const calls = deferCalls(mod);
  if (calls.length === 0) return [];
  const dynamicLoads = hasDynamicLoads(mod);
  const decisions: DeferralDecision[] = [];
  const decide = (call: DeferCall, deferred: boolean, reason: string): void => {
    const d = { path: fileOf(mod, pathOf(call)), deferred, reason };
    decisions.push(d);
    traceDecision(d);
    if (!deferred) makeEager(call);
  };
  if (packDir === null) {
    for (const c of calls) decide(c, false, "no libnode pack on the build host to probe with");
    return decisions;
  }
  const config = readProjectConfig(entryPath);
  const publicEnv = new Set(config.nodeIslands.publicEnv);
  const candidates: { call: DeferCall; path: string; lazy: boolean; gate: string | null }[] = [];
  for (const call of calls) {
    const path = fileOf(mod, pathOf(call));
    const pkg = packageDirOf(path);
    const evaluate = pkg === null ? "auto" : (config.packages.get(pkg.name)?.evaluate ?? "auto");
    if (evaluate === "eager") {
      decide(call, false, `"evaluate": "eager"`);
      continue;
    }
    // The static gate words the decision where the host has it (host.ts).
    const gate = islandBuildHost().effectGate?.(path);
    candidates.push({
      call,
      path,
      lazy: evaluate === "lazy",
      gate: gate === undefined ? null : gate.ok ? "" : `${gate.reason} in ${gate.file}`,
    });
  }
  let allDeferred = candidates.length === calls.length;
  if (candidates.length === 0) return decisions;
  const probe = probeModules(packDir, [...new Set(candidates.map((c) => c.path))]);
  if (typeof probe === "string") {
    for (const c of candidates) decide(c.call, false, probe);
    return decisions;
  }
  const packGuards = packGuardLines(packDir);
  // The shipped tree's files are the executable's own (the tree is checked
  // against its digests when it opens): only files outside it need guards.
  const tree = mod.nodeIsland?.modules;
  const shipped = new Set(tree?.files.map((f) => join(tree.root, f.path)) ?? []);
  const deferred: { call: DeferCall; result: ProbeResult; why: string }[] = [];
  for (const c of candidates) {
    const result = probe.results.find((r) => r.path === c.path);
    const why = (() => {
      if (result === undefined) return "the probe did not load it";
      if (result.throws !== undefined) return `its evaluation throws: ${result.throws}`;
      if (result.root === undefined) return result.reason ?? "the probe did not load it";
      if (
        tree !== undefined &&
        tree.root.length > 1 &&
        snapshotNames(probe, result.root, tree.root)
      )
        return "its exports hold a path of the build machine";
      const privateEnv = result.env.map(([k]) => k).filter((k) => !publicEnv.has(k));
      if (privateEnv.length > 0)
        return `its load reads the environment variable${privateEnv.length === 1 ? "" : "s"} ${privateEnv.join(", ")}, whose build-time values its boot guards would record (scriptc.nodeIslands.publicEnv lists the ones that may be recorded)`;
      if (c.lazy) return null;
      if (result.effects.length > 0) return `its load has effects: ${result.effects.join(", ")}`;
      if (result.inputs.length > 0) return `its load reads ${result.inputs.join(", ")}`;
      return null;
    })();
    if (why !== null || result === undefined) {
      allDeferred = false;
      decide(c.call, false, why ?? "");
      continue;
    }
    const how = c.lazy
      ? `"evaluate": "lazy"`
      : c.gate === ""
        ? "static gate"
        : c.gate === null
          ? "recorded load is deterministic"
          : `recorded load is deterministic (static gate: ${c.gate})`;
    deferred.push({ call: c.call, result, why: how });
  }
  // Per-module evaluation once Node runs (no materialize-all at start):
  // every static island import is deferred, none mutates builtin state,
  // and the program loads no island module at a call site. Deferred
  // modules whose closures share files form one component, evaluated
  // together in import order.
  const lazyMode =
    allDeferred && !dynamicLoads && deferred.every((d) => d.result.mutations.length === 0);
  const component = new Map<string, number>();
  if (lazyMode) {
    const parent = deferred.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const owner = new Map<string, number>();
    deferred.forEach((d, i) => {
      for (const f of d.result.files) {
        const j = owner.get(f);
        if (j === undefined) owner.set(f, i);
        else parent[find(i)] = find(j);
      }
    });
    deferred.forEach((d, i) => component.set(d.result.path, find(i) + 1));
  }
  for (const d of deferred) {
    const r = d.result;
    const guards = [
      ...packGuards,
      ...fileGuardLines(r.files.filter((f) => !shipped.has(f))),
      ...r.env.map(([k, v]) => `E ${lstr(k)} ${v === null ? "0 0:" : `1 ${lstr(v)}`}`),
      ...r.tty.map(([fd, isTty]) => `T ${fd} ${isTty ? 1 : 0}`),
      ...(lazyMode ? [`M ${component.get(r.path)}`] : []),
    ];
    const text = encodeSnapshot(probe, r.root!, guards, r.volatile.length === 0);
    const arg = d.call.args[1];
    if (arg !== undefined && arg.kind === "strLit") (arg as { value: string }).value = text;
    const notes = [
      d.why,
      ...(r.env.length > 0 ? [`env guards ${r.env.map(([k]) => k).join(",")}`] : []),
      ...(r.volatile.length > 0 ? [`volatile ${r.volatile.join(",")}: no constants`] : []),
      ...(r.mutations.length > 0 ? [`mutates ${r.mutations.join(",")}`] : []),
      lazyMode ? `per-module (component ${component.get(r.path)})` : "evaluated when Node starts",
    ];
    decide(d.call, true, notes.join("; "));
  }
  return decisions;
}

/* ── the snapshot text (scr_node_island_boot.c) ───────────────────────── */

function lstr(s: string): string {
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
}

function guardLine(name: string, file: string): string | null {
  try {
    const st = statSync(file, { bigint: true });
    return `G ${lstr(name)} ${st.size} ${st.mtimeNs}`;
  } catch {
    return null;
  }
}

function packGuardLines(packDir: string): string[] {
  const lines: string[] = [];
  let manifest: { libnode?: string; bridge?: string; files?: Record<string, unknown> } = {};
  try {
    manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
  } catch {
    /* the pack was validated by the build already */
  }
  const names = new Set<string>(Object.keys(manifest.files ?? {}));
  if (manifest.libnode) names.add(manifest.libnode);
  if (manifest.bridge) names.add(manifest.bridge);
  for (const name of [...names].sort()) {
    const line = guardLine(`@${name}`, join(packDir, name));
    if (line !== null) lines.push(line);
  }
  return lines;
}

function fileGuardLines(files: string[]): string[] {
  const lines: string[] = [];
  for (const f of files) {
    const line = guardLine(f, f);
    if (line !== null) lines.push(line);
  }
  return lines;
}

export type ProbeValue =
  | { o: number }
  | { u: 1 }
  | { l: 1 }
  | { b: boolean }
  | { n: string }
  | { s: string }
  | { x: 1 };

export interface ProbeObject {
  f: number;
  p: boolean;
  m: [string, ProbeValue][];
}

export interface ProbeResult {
  path: string;
  root?: number;
  inputs: string[];
  volatile: string[];
  effects: string[];
  mutations: string[];
  env: [string, string | null][];
  tty: [number, boolean][];
  files: string[];
  throws?: string;
  reason?: string;
}

export interface ProbeOutput {
  results: ProbeResult[];
  objects: Record<string, ProbeObject>;
}

function encodeValue(v: ProbeValue): string | null {
  if ("o" in v) return `o${v.o}`;
  if ("u" in v) return "u";
  if ("l" in v) return "l";
  if ("b" in v) return v.b ? "t" : "f";
  if ("n" in v) return `n${v.n}`;
  if ("s" in v) return `s${lstr(v.s)}`;
  return null;
}

/** Whether a string the snapshot holds names a path under `dir`. The
 * probe loads the modules from the build machine, and the program from the
 * module tree it ships, so such a value would not be the one the program
 * sees (a module's own `__dirname`, say). */
function snapshotNames(probe: ProbeOutput, root: number, dir: string): boolean {
  const seen = new Set<number>();
  const visit = (oid: number): boolean => {
    if (seen.has(oid) || probe.objects[oid] === undefined) return false;
    seen.add(oid);
    for (const [, v] of probe.objects[oid]!.m) {
      if ("s" in v && v.s.includes(dir)) return true;
      if ("o" in v && visit(v.o)) return true;
    }
    return false;
  };
  return visit(root);
}

function encodeSnapshot(
  probe: ProbeOutput,
  root: number,
  guards: string[],
  constants: boolean,
): string {
  const lines = [...guards];
  const reached: number[] = [];
  const seen = new Set<number>();
  const visit = (oid: number): void => {
    if (seen.has(oid) || probe.objects[oid] === undefined) return;
    seen.add(oid);
    reached.push(oid);
    for (const [, v] of probe.objects[oid]!.m) if ("o" in v) visit(v.o);
  };
  visit(root);
  for (const oid of reached) {
    const o = probe.objects[oid]!;
    lines.push(`O ${oid} ${o.f} ${o.p ? 1 : 0}`);
  }
  for (const oid of reached) {
    for (const [key, v] of probe.objects[oid]!.m) {
      const enc = encodeValue(v);
      if (enc !== null && (constants || "o" in v)) lines.push(`K ${oid} ${lstr(key)} ${enc}`);
    }
  }
  lines.push(`R ${root}`);
  return lines.join("\n");
}

/* ── the probe ────────────────────────────────────────────────────────── */

/** The bootstrap the probe host starts Node with: the dispatcher the
 * bridge requires, whose `call` runs the recorder (probe-recorder.ts)
 * from `recorder`. */
function probeBootstrap(recorder: string): string {
  return `"use strict";
const noop = () => {};
globalThis.__scriptcNodeIsland = {
  call(id, sync, file, specifier, name, args) {
    try {
      const recorder = require("node:module").createRequire(${JSON.stringify(recorder)})(${JSON.stringify(recorder)});
      return "R" + JSON.stringify(recorder.probe(JSON.parse(args)));
    } catch (e) {
      return "T" + JSON.stringify(String((e && e.stack) || e));
    }
  },
  setTimer: noop, clearTimer: noop, refTimer: noop, refreshTimer: noop,
  setImmediate: noop, clearImmediate: noop, refImmediate: noop,
  nextTick: noop, emit: noop, load: noop, sharedPush: noop,
};
`;
}

/** Whether only the current user can write `path` (and it is theirs). */
function writableByUserOnly(path: string): boolean {
  const info = statSync(path);
  const uid = process.getuid?.();
  return (uid === undefined || info.uid === uid) && (info.mode & 0o022) === 0;
}

/** Where the probe host is built. The build runs it with the compiler's
 * privileges, so it never comes from a directory another user can write:
 * it is kept in the user's build cache when that and the directories below
 * it are the user's own, else built in a fresh private temporary directory
 * the probe removes when it ends. */
export function probeHostDirectory(hash: string): { dir: string; kept: boolean } {
  const root = resolveBuildCacheRoot();
  if (root !== null) {
    const dir = join(root, "node-island-probe", hash);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if ([root, dirname(dir), dir].every(writableByUserOnly)) return { dir, kept: true };
    } catch {
      /* not usable: a temporary directory instead */
    }
  }
  return { dir: mkdtempSync(join(tmpdir(), "scriptc-node-probe-")), kept: false };
}

/** The probe host executable with its bootstrap and recorder, built once
 * per probe source, bridge header and recorder (in the directory
 * probeHostDirectory picks). */
function probeHost(): { exe: string; bootstrap: string; kept: boolean } | string {
  const src = islandBuildHost().runtimeSources();
  if (src === null) return "cannot build the probe host (this installation has no runtime sources)";
  const source = join(src, "tools", "scr_node_island_probe.c");
  const header = join(src, "scr_node_bridge.h");
  if (!existsSync(source) || !existsSync(header))
    return `cannot build the probe host (its sources are not in ${src})`;
  const hash = createHash("sha256")
    .update(readFileSync(source))
    .update(readFileSync(header))
    .update(PROBE_RECORDER)
    .update(probeBootstrap(""))
    .digest("hex")
    .slice(0, 16);
  const { dir, kept } = probeHostDirectory(hash);
  const exe = join(dir, "scr-node-probe");
  const bootstrap = join(dir, "bootstrap.js");
  const recorder = join(dir, "recorder.cjs");
  if (
    kept &&
    existsSync(exe) &&
    existsSync(bootstrap) &&
    existsSync(recorder) &&
    [exe, bootstrap, recorder].every(writableByUserOnly)
  )
    return { exe, bootstrap, kept };
  const tmp = `${exe}.${process.pid}`;
  const errors: string[] = [];
  for (const cc of [process.env["CC"], "clang", "cc"]) {
    if (cc === undefined || cc === "") continue;
    const r = spawnSync(cc, ["-O1", "-I", src, source, "-o", tmp, "-ldl"], { encoding: "utf8" });
    if (r.status === 0) {
      writeFileSync(`${recorder}.${process.pid}`, PROBE_RECORDER, { mode: 0o600 });
      renameSync(`${recorder}.${process.pid}`, recorder);
      writeFileSync(`${bootstrap}.${process.pid}`, probeBootstrap(recorder), { mode: 0o600 });
      renameSync(`${bootstrap}.${process.pid}`, bootstrap);
      renameSync(tmp, exe);
      return { exe, bootstrap, kept };
    }
    errors.push(`${cc}: ${r.error?.message ?? r.stderr.trim().split("\n")[0]}`);
  }
  if (!kept) rmSync(dir, { recursive: true, force: true });
  return `cannot build the probe host (${errors.join("; ")})`;
}

function runProbe(packDir: string, modules: string[]): ProbeOutput | string {
  const host = probeHost();
  if (typeof host === "string") return host;
  const { exe, bootstrap, kept } = host;
  const stem = join(dirname(exe), `run.${process.pid}.${Date.now()}`);
  const input = `${stem}.in.json`;
  const output = `${stem}.out.json`;
  writeFileSync(input, JSON.stringify({ modules }), { mode: 0o600 });
  let out: string;
  try {
    const run = spawnSync(exe, [packDir, bootstrap, input, output], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    });
    if (run.error !== undefined || run.status !== 0)
      return `the probe failed: ${
        (run.stderr ?? "").trim().split("\n")[0] ||
        run.error?.message ||
        (run.signal !== null ? `killed by ${run.signal}` : `exit status ${run.status}`)
      }`;
    out = readFileSync(output, "utf8");
  } catch (e) {
    return `the probe failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    for (const f of kept ? [input, output] : [dirname(exe)]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  if (!out.startsWith("R")) return `the probe threw: ${out.slice(1, 400)}`;
  return JSON.parse(out.slice(1)) as ProbeOutput;
}
