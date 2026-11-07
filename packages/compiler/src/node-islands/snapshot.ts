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
 *   - environment reads: the boot guards record every environment
 *     variable the load read. One that was unset at build time is recorded
 *     as unset (`E <key> 0`): the executable learns that the variable was
 *     absent, never a value, and a run that sets it loads the module at
 *     its import. One that had a value is recorded with it, which only
 *     `scriptc.nodeIslands.publicEnv` allows: a load that read a set
 *     variable not listed there stays eager, "lazy" included, and no value
 *     of it reaches the executable;
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
import { execFileSync, spawnSync } from "node:child_process";
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveBuildCacheRoot } from "../backend/cache-root.js";
import type { IrExpr, IrModule, IrStmt } from "../ir/ir.js";
import { readProjectConfig } from "../project-config.js";
import { effectGate } from "./effect-gate.js";
import { probeCopy } from "./generated.js";
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

/** A module initializer (`%init.<n>`, lowerFileInit). */
function isModuleInit(name: string): boolean {
  return name.startsWith("%init");
}

/** A statement list as the statements control passes through in order:
 * blocks nothing breaks out of opened up. */
function flatStatements(stmts: readonly IrStmt[], out: IrStmt[] = []): IrStmt[] {
  for (const s of stmts) {
    if (s.kind === "block" && s.labels === undefined) flatStatements(s.body, out);
    else out.push(s);
  }
  return out;
}

/** The deferred loads in the order the program reaches them while its
 * modules evaluate, then the rest in IR order.
 *
 * The probe loads every candidate in one process, so the order is part of
 * what it records: a file two candidates share evaluates in the load of
 * whichever comes first, with its effects, inputs and environment reads,
 * and the other's record of it is empty; and "a later island module's load
 * changes its exports" compares against the modules loaded before. Both
 * are only true of the program when the probe loads the modules in the
 * program's order. IR order is not that order: a module's initializer
 * comes after those of the modules it imports, so an importer's first
 * island import would be probed after the island imports of its later
 * dependencies.
 *
 * The walk follows the entry: each initializer's statements in order, into
 * another module's initializer where it is called (`%init.<n>`, once, as
 * the run-once guard has it), and through a sequence (`seqExpr`): an inline
 * require() lowers to the required module's %init ahead of its export read,
 * both at the require's position. Any other expression is followed through
 * what it holds, in the order it is written, so a load is reached where its
 * expression is (`typeof require("pkg").name === "function"`). An
 * initializer that awaits is left there and taken up again after the code
 * that called it, in the order of the awaits, as module evaluation continues
 * with later siblings while one is suspended. Loads the walk does not reach
 * (inside functions, dynamic imports, loops) keep IR order after it. */
export function evaluationOrder(mod: IrModule, calls: DeferCall[]): DeferCall[] {
  const { ordered } = evaluationWalk(mod);
  if (ordered.length === 0) return calls;
  const reached = new Set(ordered);
  return [...ordered, ...calls.filter((c) => !reached.has(c))];
}

/** Whether `node` awaits anywhere inside. */
function awaitsWithin(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(awaitsWithin);
  const o = node as Record<string, unknown>;
  if (o["kind"] === "awaitExpr" || o["kind"] === "awaitUnionExpr") return true;
  if (o["kind"] === "intrinsic" && o["name"] === "module.await") return true;
  for (const k in o) if (k !== "loc" && k !== "type" && awaitsWithin(o[k])) return true;
  return false;
}

/** The walk of evaluationOrder: the loads it reaches, in order, and the
 * ones among them the program reaches at one fixed point of its start, the
 * same in every run (`fixed`): before anything awaited, outside every
 * condition, in a module initializer that only the walk's own calls run.
 * An initializer something else can call (a dynamic import, a `require`
 * inside a function), or that such an initializer calls, may run earlier
 * than the walk has it. */
function evaluationWalk(mod: IrModule): {
  ordered: DeferCall[];
  fixed: Set<DeferCall>;
  /** Why a load the walk reached is not in `fixed`. */
  moving: Map<DeferCall, string>;
} {
  const functions = new Map<string, IrModule["functions"][number]>();
  for (const fn of mod.functions) if (typeof fn.name === "string") functions.set(fn.name, fn);
  const entered = new Set<string>();
  const reached = new Set<DeferCall>();
  const ordered: DeferCall[] = [];
  const suspended: { stmts: IrStmt[]; at: number; within: string; async: boolean }[] = [];
  /** Per reached load: its initializer, and whether the walk came to it
   * unconditionally and before any await. */
  const sites = new Map<DeferCall, { within: string; conditional: boolean; late: boolean }>();
  /** The initializer calls the walk evaluated, per initializer. */
  const followed = new Map<string, number>();
  let within = "";
  /** Whether the function being walked is async: any of its statements
   * may await, also where the walk does not look (awaitsWithin). */
  let inAsync = false;
  let conditions = 0;
  let awaited = false;
  /** Evaluates what the walk follows of `e`; true when it awaits. */
  function evaluate(e: IrExpr): boolean {
    if (e.kind === "libCall" && e.fn === "nodeIsland.defer") {
      if (!reached.has(e)) {
        reached.add(e);
        ordered.push(e);
        sites.set(e, { within, conditional: conditions > 0, late: awaited });
      }
      return false;
    }
    if (e.kind === "call" && isModuleInit(e.callee)) {
      followed.set(e.callee, (followed.get(e.callee) ?? 0) + 1);
      enter(e.callee);
      return false;
    }
    if (e.kind === "seqExpr") {
      // An inline require() lowers to the required module's %init ahead of
      // the export read, both where the require is written.
      for (const s of e.stmts) if (statement(s)) return true;
      return evaluate(e.result);
    }
    if (e.kind === "awaitExpr") {
      evaluate(e.value);
      return true;
    }
    if (e.kind === "intrinsic" && e.name === "module.await") {
      for (const arg of e.args) evaluate(arg);
      return true;
    }
    // Any other expression: what it holds, in the order it is written. A
    // comparison, a member read, a `typeof`, a call's arguments: an inline
    // require() inside any of them keeps its initializer there. An
    // expression may evaluate only some of what it holds (`a ? b : c`,
    // `a && b`), so a load inside one is not at a fixed point.
    conditions++;
    const awaits = inside(e);
    conditions--;
    return awaits;
  }
  /** Follows the expressions `node` holds (a sequence is the only
   * expression that holds statements); true when one of them awaits. */
  function inside(node: object): boolean {
    let awaits = false;
    const fields = node as Record<string, unknown>;
    for (const key in fields) {
      if (key === "loc" || key === "type") continue;
      const value = fields[key];
      for (const part of Array.isArray(value) ? value : [value]) {
        if (part === null || typeof part !== "object") continue;
        if (typeof (part as { kind?: unknown }).kind === "string") awaits = evaluate(part as IrExpr) || awaits;
        else awaits = inside(part) || awaits;
      }
    }
    return awaits;
  }
  /** Evaluates what the walk follows of `s`; true when it awaits. */
  function statement(s: IrStmt): boolean {
    if (s.kind === "exprStmt") return evaluate(s.expr);
    if (s.kind === "assign") return evaluate(s.value);
    if (s.kind === "varDecl") return s.init !== null && evaluate(s.init);
    if (s.kind === "if") {
      // The run-once guard returns on a revisit; a fork or worker root is
      // one branch of a selection.
      conditions++;
      run(flatStatements(s.then), 0);
      if (s.else_ !== null) run(flatStatements(s.else_), 0);
      conditions--;
    } else if (s.kind === "tryCatch") {
      // A guarded body whose handler throws again (a module's own
      // evaluation record) is passed through like a block; under any
      // other handler a statement may be skipped while later ones run.
      const passes = s.catchBody === null || s.catchBody.at(-1)?.kind === "rethrow";
      if (!passes) conditions++;
      run(flatStatements(s.tryBody), 0);
      if (!passes) conditions--;
      if (s.finallyBody !== null) run(flatStatements(s.finallyBody), 0);
    } else if (s.kind === "block") {
      conditions++;
      run(flatStatements(s.body), 0);
      conditions--;
    }
    return false;
  }
  function run(stmts: IrStmt[], from: number): void {
    for (let i = from; i < stmts.length; i++) {
      const s = stmts[i]!;
      if (s.kind === "return") return;
      let awaits = statement(s);
      if (!awaits && inAsync && awaitsWithin(s)) awaits = true;
      if (awaits) {
        suspended.push({ stmts, at: i + 1, within, async: inAsync });
        awaited = true;
        return;
      }
    }
  }
  function enter(name: string): void {
    if (entered.has(name)) return;
    entered.add(name);
    const fn = functions.get(name);
    if (fn === undefined) return;
    const outer = within;
    const outerAsync = inAsync;
    within = name;
    inAsync = fn.async === true;
    run(flatStatements(fn.body), 0);
    within = outer;
    inAsync = outerAsync;
  }
  if (typeof mod.entry === "string") enter(mod.entry);
  for (let i = 0; i < suspended.length; i++) {
    within = suspended[i]!.within;
    inAsync = suspended[i]!.async;
    run(suspended[i]!.stmts, suspended[i]!.at);
  }
  const fixed = new Set<DeferCall>();
  const moving = new Map<DeferCall, string>();
  if (ordered.length === 0) return { ordered, fixed, moving };
  // Every mention of an initializer in the program, per initializer, and
  // the initializers each function mentions.
  const mentions = new Map<string, number>();
  const callees = new Map<string, Set<string>>();
  const seen = new Set<object>();
  let scanning = "";
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      if (isModuleInit(v) && functions.has(v)) {
        mentions.set(v, (mentions.get(v) ?? 0) + 1);
        callees.get(scanning)?.add(v);
      }
      return;
    }
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const k in o) if (k !== "loc" && k !== "type") scan(o[k]);
  };
  for (const fn of mod.functions) {
    scanning = typeof fn.name === "string" ? fn.name : "";
    callees.set(scanning, new Set());
    const fields = fn as unknown as Record<string, unknown>;
    for (const k in fields) if (k !== "name" && k !== "loc") scan(fields[k]);
  }
  // Initializers that can run where the walk does not have them, and the
  // ones they call.
  const early = new Set<string>();
  const queue: string[] = [];
  for (const [name, count] of mentions) if (count !== (followed.get(name) ?? 0)) queue.push(name);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (early.has(name)) continue;
    early.add(name);
    for (const callee of callees.get(name) ?? []) queue.push(callee);
  }
  for (const [call, site] of sites) {
    if (site.late) moving.set(call, "the program reaches it after an await");
    else if (site.conditional) moving.set(call, "the program reaches it under a condition");
    else if (early.has(site.within))
      moving.set(
        call,
        "its module can also be loaded outside the static import graph (a dynamic import, or a require inside a function)",
      );
    else fixed.add(call);
  }
  return { ordered, fixed, moving };
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

/** The probe's copies of the tree's generated modules (generated.ts), in a
 * fresh private directory: the modules sit nowhere on the build machine,
 * and never in the user's source tree. By the module's place under the
 * tree root. */
function writeProbeCopies(tree: NonNullable<NonNullable<IrModule["nodeIsland"]>["modules"]>): {
  dir: string;
  copies: Map<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-closed-"));
  const copies = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const file of tree.files) {
    if (file.generated === undefined) continue;
    const place = join(tree.root, ...file.path.split("/"));
    copies.set(place, join(dir, basename(file.path)));
    texts.set(place, file.generated);
  }
  for (const [place, text] of texts)
    writeFileSync(
      copies.get(place)!,
      probeCopy(text, place, (other) => copies.get(other)),
      { mode: 0o600 },
    );
  return { dir, copies };
}

export function finalizeDeferredIslands(
  mod: IrModule,
  entryPath: string,
  packDir: string | null,
  probeModules: (
    packDir: string,
    modules: string[],
    generated: string[],
  ) => ProbeOutput | string = runProbe,
): DeferralDecision[] {
  const found = deferCalls(mod);
  if (found.length === 0) return [];
  const walk = evaluationWalk(mod);
  const reached = new Set(walk.ordered);
  const calls =
    walk.ordered.length === 0 ? found : [...walk.ordered, ...found.filter((c) => !reached.has(c))];
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
  const tree = mod.nodeIsland?.modules;
  // Modules the build wrote (generated.ts), by their place under the tree
  // root: the constants of the program whose initializers the island
  // evaluates.
  const generated = new Set<string>();
  for (const file of tree?.files ?? [])
    if (file.generated !== undefined) generated.add(join(tree!.root, ...file.path.split("/")));
  const candidates: { call: DeferCall; path: string; lazy: boolean; gate: string }[] = [];
  for (const call of calls) {
    const path = fileOf(mod, pathOf(call));
    if (generated.has(path)) {
      // A generated module computes from what earlier island code left
      // behind, so its snapshot holds only where the program reaches it at
      // the point of its start the probe evaluated it at (evaluationWalk).
      // Anywhere else it evaluates at its position, and the probe leaves it
      // out, so that no later module is probed after it.
      if (walk.fixed.has(call)) candidates.push({ call, path, lazy: false, gate: "" });
      else
        decide(
          call,
          false,
          `the program does not reach it at one fixed point of its start: ${walk.moving.get(call) ?? "no static import leads to it"}`,
        );
      continue;
    }
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
  // The probe loads a generated module from a copy (writeProbeCopies).
  const scratch = generated.size > 0 && tree !== undefined ? writeProbeCopies(tree) : null;
  const probed = (path: string): string => scratch?.copies.get(path) ?? path;
  let probe: ProbeOutput | string;
  try {
    probe = probeModules(
      packDir,
      [...new Set(candidates.map((c) => probed(c.path)))],
      scratch === null ? [] : [...scratch.copies.values()],
    );
  } finally {
    if (scratch !== null) rmSync(scratch.dir, { recursive: true, force: true });
  }
  if (typeof probe === "string") {
    for (const c of candidates) decide(c.call, false, probe);
    return decisions;
  }
  const packGuards = packGuardLines(packDir);
  // The shipped tree's files are the executable's own (the tree is checked
  // against its digests when it opens): only files outside it need guards.
  // The probe's copy of a generated module stands for the tree's file.
  const shipped = new Set(tree?.files.map((f) => join(tree.root, f.path)) ?? []);
  for (const copy of scratch?.copies.values() ?? []) shipped.add(copy);
  const deferred: { call: DeferCall; result: ProbeResult; why: string }[] = [];
  for (const c of candidates) {
    const result = probe.results.find((r) => r.path === probed(c.path));
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
      // A variable that was unset is guarded as unset: no value to record.
      const privateEnv = result.env
        .filter(([k, v]) => v !== null && !publicEnv.has(k))
        .map(([k]) => k);
      if (privateEnv.length > 0)
        return `its load reads the environment variable${privateEnv.length === 1 ? "" : "s"} ${privateEnv.join(", ")}, set at build time, whose value${privateEnv.length === 1 ? "" : "s"} its boot guards would record (scriptc.nodeIslands.publicEnv lists the ones that may be recorded)`;
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
      : generated.has(c.path)
        ? "recorded evaluation is deterministic"
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
  //
  // Not with generated modules: in this mode a module stays deferred
  // while Node runs and its snapshot answers until it evaluates, but a
  // generated module computes from island state that the program's calls
  // since then have changed (`registry.add(x)` before `const n =
  // registry.count()`). Evaluated when Node starts, a load that Node's
  // start precedes evaluates at its position instead.
  const lazyMode =
    allDeferred &&
    !dynamicLoads &&
    generated.size === 0 &&
    deferred.every((d) => d.result.mutations.length === 0);
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
      ...(r.env.length > 0
        ? [`env guards ${r.env.map(([k, v]) => (v === null ? `${k} (unset)` : k)).join(",")}`]
        : []),
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

function runtimeSrc(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@scriptc/runtime/package.json")), "src");
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

function runProbe(packDir: string, modules: string[], generated: string[]): ProbeOutput | string {
  const host = probeHost();
  if (typeof host === "string") return host;
  const { exe, bootstrap, kept } = host;
  const stem = join(dirname(exe), `run.${process.pid}.${Date.now()}`);
  const input = `${stem}.in.json`;
  const output = `${stem}.out.json`;
  writeFileSync(input, JSON.stringify({ modules, generated }), { mode: 0o600 });
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
