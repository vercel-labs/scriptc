/* Deferred island modules: the decision, the build-time probe and the
 * interface snapshot (scope-B NI-7, DESIGN.md §2.7, §5.4).
 *
 * Lowering emits `nodeIsland.defer(path, "")` for every static import of an
 * island module (lower-node-island.ts). After lowering, once the build
 * knows the libnode pack the executable will load, finalizeDeferredIslands
 * decides each one:
 *
 *   - the package's `evaluate` setting (`scriptc.packages.<name>`):
 *     "eager" keeps the module eager; "lazy" defers it whatever its load
 *     does (the user judged the effects benign);
 *   - the probe: one run of the build-time probe host
 *     (runtime src/tools/scr_node_island_probe.c) in a libnode environment
 *     from the same pack, which loads every candidate module under the
 *     load recorder (probe-recorder.ts) and takes the interface snapshot of
 *     each module's value. "auto" (the default) defers a module whose
 *     recorded load threw nothing, had no effects and read no run-time
 *     input other than env keys and stdio TTY state, which become boot
 *     guards (the determinism argument in probe-recorder.ts). The static
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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IrExpr, IrModule } from "../ir/ir.js";
import { readProjectConfig } from "../project-config.js";
import { effectGate } from "./effect-gate.js";
import { packageDirOf } from "./origin.js";
import { PROBE_RECORDER } from "./probe-recorder.js";

type DeferCall = Extract<IrExpr, { kind: "libCall" }>;

function deferCalls(mod: IrModule): DeferCall[] {
  const found: DeferCall[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (o["kind"] === "libCall" && o["fn"] === "nodeIsland.defer") found.push(o as DeferCall);
    for (const k in o) if (k !== "loc" && k !== "type") walk(o[k]);
  };
  walk(mod.functions);
  walk(mod.globals);
  return found;
}

function pathOf(call: DeferCall): string {
  const arg = call.args[0];
  return arg !== undefined && arg.kind === "strLit" ? arg.value : "";
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
  let found = false;
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (found || v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (
      o["kind"] === "libCall" &&
      (o["fn"] === "nodeIsland.require" || o["fn"] === "nodeIsland.import")
    )
      found = true;
    for (const k in o) if (k !== "loc" && k !== "type") walk(o[k]);
  };
  walk(mod.functions);
  walk(mod.globals);
  return found;
}

export function finalizeDeferredIslands(
  mod: IrModule,
  entryPath: string,
  packDir: string | null,
): DeferralDecision[] {
  const calls = deferCalls(mod);
  if (calls.length === 0) return [];
  const dynamicLoads = hasDynamicLoads(mod);
  const decisions: DeferralDecision[] = [];
  const decide = (call: DeferCall, deferred: boolean, reason: string): void => {
    const d = { path: pathOf(call), deferred, reason };
    decisions.push(d);
    traceDecision(d);
    if (!deferred) makeEager(call);
  };
  if (packDir === null) {
    for (const c of calls) decide(c, false, "no libnode pack on the build host to probe with");
    return decisions;
  }
  const config = readProjectConfig(entryPath);
  const candidates: { call: DeferCall; path: string; lazy: boolean; gate: string }[] = [];
  for (const call of calls) {
    const path = pathOf(call);
    const pkg = packageDirOf(path);
    const evaluate = pkg === null ? "auto" : (config.packages.get(pkg.name)?.evaluate ?? "auto");
    if (evaluate === "eager") {
      decide(call, false, `"evaluate": "eager"`);
      continue;
    }
    const gate = effectGate(path);
    candidates.push({
      call,
      path,
      lazy: evaluate === "lazy",
      gate: gate.ok ? "" : `${gate.reason} in ${gate.file}`,
    });
  }
  let allDeferred = candidates.length === calls.length;
  if (candidates.length === 0) return decisions;
  const probe = runProbe(packDir, [...new Set(candidates.map((c) => c.path))]);
  if (typeof probe === "string") {
    for (const c of candidates) decide(c.call, false, probe);
    return decisions;
  }
  const packGuards = packGuardLines(packDir);
  const deferred: { call: DeferCall; result: ProbeResult; why: string }[] = [];
  for (const c of candidates) {
    const result = probe.results.find((r) => r.path === c.path);
    const why = (() => {
      if (result === undefined) return "the probe did not load it";
      if (result.throws !== undefined) return `its evaluation throws: ${result.throws}`;
      if (result.root === undefined) return result.reason ?? "the probe did not load it";
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
      ...fileGuardLines(r.files),
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

type ProbeValue =
  | { o: number }
  | { u: 1 }
  | { l: 1 }
  | { b: boolean }
  | { n: string }
  | { s: string }
  | { x: 1 };

interface ProbeObject {
  f: number;
  p: boolean;
  m: [string, ProbeValue][];
}

interface ProbeResult {
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

interface ProbeOutput {
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

function runtimeSrc(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@scriptc/runtime/package.json")), "src");
}

/** The probe host executable with its bootstrap and recorder, built once
 * per probe source, bridge header and recorder (cached under the
 * temporary directory). */
function probeHost(): string | string[] {
  const src = runtimeSrc();
  const source = join(src, "tools", "scr_node_island_probe.c");
  const header = join(src, "scr_node_bridge.h");
  const hash = createHash("sha256")
    .update(readFileSync(source))
    .update(readFileSync(header))
    .update(PROBE_RECORDER)
    .update(probeBootstrap(""))
    .digest("hex")
    .slice(0, 16);
  const dir = join(tmpdir(), `scriptc-node-probe-${process.getuid?.() ?? 0}`, hash);
  const exe = join(dir, "scr-node-probe");
  const bootstrap = join(dir, "bootstrap.js");
  const recorder = join(dir, "recorder.cjs");
  if (existsSync(exe) && existsSync(bootstrap) && existsSync(recorder)) return [exe, bootstrap];
  mkdirSync(dir, { recursive: true });
  const tmp = `${exe}.${process.pid}`;
  const errors: string[] = [];
  for (const cc of [process.env["CC"], "clang", "cc"]) {
    if (cc === undefined || cc === "") continue;
    const r = spawnSync(cc, ["-O1", "-I", src, source, "-o", tmp, "-ldl"], { encoding: "utf8" });
    if (r.status === 0) {
      writeFileSync(`${recorder}.${process.pid}`, PROBE_RECORDER);
      renameSync(`${recorder}.${process.pid}`, recorder);
      writeFileSync(`${bootstrap}.${process.pid}`, probeBootstrap(recorder));
      renameSync(`${bootstrap}.${process.pid}`, bootstrap);
      renameSync(tmp, exe);
      return [exe, bootstrap];
    }
    errors.push(`${cc}: ${r.error?.message ?? r.stderr.trim().split("\n")[0]}`);
  }
  return `cannot build the probe host (${errors.join("; ")})`;
}

function runProbe(packDir: string, modules: string[]): ProbeOutput | string {
  const host = probeHost();
  if (typeof host === "string") return host;
  const [exe, bootstrap] = host as [string, string];
  const stem = join(dirname(exe), `run.${process.pid}.${Date.now()}`);
  const input = `${stem}.in.json`;
  const output = `${stem}.out.json`;
  writeFileSync(input, JSON.stringify({ modules }));
  let out: string;
  try {
    execFileSync(exe, [packDir, bootstrap, input, output], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    });
    out = readFileSync(output, "utf8");
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    return `the probe failed: ${
      String(err.stderr ?? "")
        .trim()
        .split("\n")[0] || err.message
    }`;
  } finally {
    for (const f of [input, output]) {
      try {
        rmSync(f);
      } catch {
        /* best effort */
      }
    }
  }
  if (!out.startsWith("R")) return `the probe threw: ${out.slice(1, 400)}`;
  return JSON.parse(out.slice(1)) as ProbeOutput;
}
