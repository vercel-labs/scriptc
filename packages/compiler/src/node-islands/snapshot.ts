/* Deferred island modules: the decision, the build-time probe and the
 * interface snapshot (scope-B NI-7, DESIGN.md §2.7, §5.4).
 *
 * Lowering emits `nodeIsland.defer(path, "")` for every static import of an
 * island module (lower-node-island.ts). After lowering, once the build
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
 *     of it reaches the executable. A load that read such a value and left
 *     it in shared state (a global, a builtin, the environment) is where a
 *     later load of the same probe can pick it up and export it, so every
 *     candidate the probe reached after such a load stays eager too;
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
 *   - when it evaluates: every deferred module evaluates when Node
 *     starts, in import order, before the operation that needed Node. No
 *     island code other than deferred loads runs before a deferred load,
 *     so the island sees the loads in Node's order. A module does not
 *     wait for its own first use: a call into a module that evaluated
 *     can write island state (a global, a builtin) that a later load
 *     reads, and Node ran that load at its import, before any call;
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
  realpathSync,
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
 * blocks and guarded bodies opened up. */
function flatStatements(stmts: readonly IrStmt[], out: IrStmt[] = []): IrStmt[] {
  for (const s of stmts) {
    if (s.kind === "block") flatStatements(s.body, out);
    else if (s.kind === "tryCatch") {
      flatStatements(s.tryBody, out);
      if (s.finallyBody !== null) flatStatements(s.finallyBody, out);
    } else out.push(s);
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
 * expression is (`typeof require("pkg").name === "function"`). A part of an
 * expression that runs only when a condition holds (the right operand of
 * `&&`, `||` or `??`, an arm of a `?:`, the body of an optional chain) is
 * followed after the loads the walk reaches, in the order it is written: the
 * program may not evaluate it, and ordering it ahead of the loads that do
 * happen would let it take a shared file's effects from them. An
 * initializer that awaits is left there and taken up again after the code
 * that called it, in the order of the awaits, as module evaluation continues
 * with later siblings while one is suspended. Loads the walk does not reach
 * (inside functions, dynamic imports, loops) keep IR order after it.
 *
 * The order is a best guess wherever the program has a choice: the
 * conditional part of an expression is placed last, both branches of a
 * selection where they are written. A run that takes the other way
 * evaluates a file two loads share in the other load, so the decisions do
 * not rest on the order for that (loadReads). */
export function evaluationOrder(mod: IrModule, calls: DeferCall[]): DeferCall[] {
  const functions = new Map<string, IrModule["functions"][number]>();
  for (const fn of mod.functions) if (typeof fn.name === "string") functions.set(fn.name, fn);
  const entered = new Set<string>();
  const reached = new Set<DeferCall>();
  const ordered: DeferCall[] = [];
  const suspended: { stmts: IrStmt[]; at: number }[] = [];
  const conditional: IrExpr[] = [];
  /** Evaluates what the walk follows of `e`; true when it awaits. */
  function evaluate(e: IrExpr): boolean {
    if (e.kind === "libCall" && e.fn === "nodeIsland.defer") {
      if (!reached.has(e)) {
        reached.add(e);
        ordered.push(e);
      }
      return false;
    }
    if (e.kind === "call" && isModuleInit(e.callee)) {
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
    // A part that the program evaluates only when a condition holds is kept
    // for after the loads the walk reaches: it may not run at all, and where
    // it does it cannot be placed ahead of a load that always does.
    if (e.kind === "logical" || e.kind === "nullish" || e.kind === "orDefault") {
      conditional.push(e.right);
      return evaluate(e.left);
    }
    if (e.kind === "ternary") {
      conditional.push(e.then, e.else_);
      return evaluate(e.cond);
    }
    if (e.kind === "optChain") {
      conditional.push(e.body);
      return evaluate(e.receiver);
    }
    // Any other expression: what it holds, in the order it is written. A
    // comparison, a member read, a `typeof`, a call's arguments: an inline
    // require() inside any of them keeps its initializer there.
    return within(e);
  }
  /** Follows the expressions `node` holds (a sequence is the only
   * expression that holds statements); true when one of them awaits. */
  function within(node: object): boolean {
    let awaits = false;
    const fields = node as Record<string, unknown>;
    for (const key in fields) {
      if (key === "loc" || key === "type") continue;
      const value = fields[key];
      for (const part of Array.isArray(value) ? value : [value]) {
        if (part === null || typeof part !== "object") continue;
        if (typeof (part as { kind?: unknown }).kind === "string")
          awaits = evaluate(part as IrExpr) || awaits;
        else awaits = within(part) || awaits;
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
      run(flatStatements(s.then), 0);
      if (s.else_ !== null) run(flatStatements(s.else_), 0);
    }
    return false;
  }
  function run(stmts: IrStmt[], from: number): void {
    for (let i = from; i < stmts.length; i++) {
      const s = stmts[i]!;
      if (s.kind === "return") return;
      if (statement(s)) {
        suspended.push({ stmts, at: i + 1 });
        return;
      }
    }
  }
  function enter(name: string): void {
    if (entered.has(name)) return;
    entered.add(name);
    const fn = functions.get(name);
    if (fn !== undefined) run(flatStatements(fn.body), 0);
  }
  if (typeof mod.entry === "string") enter(mod.entry);
  for (let i = 0; i < suspended.length; i++) run(suspended[i]!.stmts, suspended[i]!.at);
  const resumed = suspended.length;
  for (let i = 0; i < conditional.length; i++) evaluate(conditional[i]!);
  for (let i = resumed; i < suspended.length; i++) run(suspended[i]!.stmts, suspended[i]!.at);
  if (ordered.length === 0) return calls;
  return [...ordered, ...calls.filter((c) => !reached.has(c))];
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

/** The label the load recorder gives a load's write to an environment
 * variable (probe-recorder.ts), in its effects. */
const ENV_WRITE = "a write of process.env.";

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

/** What a module's load depends on from outside the island: its own reads
 * and those of every probed module it shares a file with. */
interface LoadReads {
  env: [string, string | null][];
  tty: [number, boolean][];
  inputs: string[];
  volatile: string[];
  effects: string[];
  /** Variables outside publicEnv that a load of the group read with a
   * value, whatever another load of the group read for the same key. */
  privateEnv: string[];
  /** Variables and stdio descriptors the group's loads read differently:
   * the environment changed between two of them, and no single guard
   * describes both reads. */
  conflicts: string[];
}

/** The reads each probed module's snapshot depends on, and the effects
 * its load answers for. A file that two modules load evaluates once, in the
 * load of whichever reaches it first, and what that evaluation read (an
 * environment variable, the terminal, the clock, another input) or did is
 * in that module's record only. The other module's exports can still hold
 * values computed from it, and in a run that reaches the other module
 * first (the first is written under a condition: `flag && require("a")`,
 * an arm of `?:`, a branch, after an early `return`) the file evaluates,
 * with its effects, in the other module's load. So the modules of a group
 * that shares files carry each other's reads and effects: their guards,
 * and the reasons that keep one of them eager. A module's own come
 * first. */
function loadReads(
  results: ProbeResult[],
  publicEnv: ReadonlySet<string>,
): Map<ProbeResult, LoadReads> {
  const parent = results.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  results.forEach((r, i) => {
    for (const f of r.files) {
      const j = owner.get(f);
      if (j === undefined) owner.set(f, i);
      else parent[find(i)] = find(j);
    }
  });
  const reads = new Map<ProbeResult, LoadReads>();
  results.forEach((r, i) => {
    const group = [r, ...results.filter((other, j) => j !== i && find(j) === find(i))];
    const env = new Map<string, string | null>();
    const tty = new Map<number, boolean>();
    const privateEnv = new Set<string>();
    const conflicts = new Set<string>();
    for (const m of group) {
      for (const [k, v] of m.env) {
        if (v !== null && !publicEnv.has(k)) privateEnv.add(k);
        if (!env.has(k)) env.set(k, v);
        else if (env.get(k) !== v) conflicts.add(`the environment variable ${k}`);
      }
      for (const [fd, isTty] of m.tty) {
        if (!tty.has(fd)) tty.set(fd, isTty);
        else if (tty.get(fd) !== isTty) conflicts.add(`isatty(${fd})`);
      }
    }
    reads.set(r, {
      env: [...env],
      tty: [...tty],
      inputs: [...new Set(group.flatMap((m) => m.inputs))],
      volatile: [...new Set(group.flatMap((m) => m.volatile))],
      effects: [...new Set(group.flatMap((m) => m.effects))],
      privateEnv: [...privateEnv],
      conflicts: [...conflicts],
    });
  });
  return reads;
}

/** The probe's copies of the tree's generated modules (generated.ts), in a
 * fresh private directory: the modules sit nowhere on the build machine,
 * and never in the user's source tree. By the module's place under the
 * tree root. */
function writeProbeCopies(tree: NonNullable<NonNullable<IrModule["nodeIsland"]>["modules"]>): {
  dir: string;
  copies: Map<string, string>;
} {
  // By its real path: the probe tells the build's own modules by the paths
  // Node names them with, and Node resolves links (macOS's temporary
  // directory is under /var, a link to /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-closed-")));
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
    /** The modules among them whose code is the program's own. */
    own: string[],
  ) => ProbeOutput | string = runProbe,
): DeferralDecision[] {
  const calls = evaluationOrder(mod, deferCalls(mod));
  if (calls.length === 0) return [];
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
  // Modules of the program the static gate admits (below).
  const program = new Set<string>();
  /** A module whose code is the program's own: the probe withholds what it
   * would do to the machine, and its snapshot is guarded by the loads the
   * probe evaluated before it. */
  const own = (path: string): boolean => generated.has(path) || program.has(path);
  const candidates: { call: DeferCall; path: string; lazy: boolean; gate: string }[] = [];
  for (const call of calls) {
    const path = fileOf(mod, pathOf(call));
    if (generated.has(path)) {
      candidates.push({ call, path, lazy: false, gate: "" });
      continue;
    }
    const pkg = packageDirOf(path);
    if (pkg === null) {
      // A module of the program that runs in an island. The build evaluates
      // the program's own source only when it can do nothing: the static
      // gate admits the module's top level (declarations and pure
      // expressions), and it loads no other file of the program, whose
      // module the compiled program provides at run time.
      const gate = effectGate(path);
      const others = gate.ok
        ? gate.files.filter((f) => f !== path && packageDirOf(f) === null)
        : [];
      if (!gate.ok)
        decide(
          call,
          false,
          `a module of the program, and its top level is not provably free of effects: ${gate.reason} in ${gate.file}`,
        );
      else if (others.length > 0)
        decide(call, false, `a module of the program that loads another one (${others[0]})`);
      else {
        program.add(path);
        candidates.push({ call, path, lazy: false, gate: "" });
      }
      continue;
    }
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
  if (candidates.length === 0) return decisions;
  // The probe loads a generated module from a copy (writeProbeCopies).
  const scratch = generated.size > 0 && tree !== undefined ? writeProbeCopies(tree) : null;
  const probed = (path: string): string => scratch?.copies.get(path) ?? path;
  // The loads the probe evaluates before each one, as the runtime will
  // count them: the distinct load paths, in the probe's order.
  const before = new Map<string, string>();
  {
    let count = 0;
    let hash = LOADS_HASH_START;
    for (const c of candidates) {
      const load = pathOf(c.call);
      if (before.has(load)) continue;
      before.set(load, `P ${count} ${hash}`);
      count++;
      hash = loadsHash(hash, load);
    }
  }
  let probe: ProbeOutput | string;
  try {
    probe = probeModules(
      packDir,
      [...new Set(candidates.map((c) => probed(c.path)))],
      [...(scratch?.copies.values() ?? []), ...program],
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
  const reads = loadReads(probe.results, publicEnv);
  // The probe loads every candidate in one process, in the order the program
  // evaluates them, so shared state one load writes (a global, a builtin, a
  // prototype, the environment) is there for every load after it. A load
  // that read a private environment value and wrote shared state can leave
  // that value in what a later load exported, in a form the build cannot
  // recognize; the later load's snapshot would then carry it into the
  // executable. The writer is eager with its own reason, and so is every
  // candidate the probe reached after it. A load's own effects that write
  // `process.env` count: a later load reading a public key of it would record
  // the written value.
  // Private: read with a value at build time and not in publicEnv, by the
  // load or by one it shares a file with (loadReads). A variable that was
  // unset has no value to leave anywhere and is guarded as unset.
  const privateKeys = (r: ProbeResult): string[] => reads.get(r)!.privateEnv;
  const inherits = new Map<ProbeResult, string[]>();
  let wrote: string[] | undefined;
  for (const r of probe.results) {
    if (wrote !== undefined) {
      inherits.set(r, wrote);
      continue;
    }
    const keys = privateKeys(r);
    if (
      keys.length > 0 &&
      (r.mutations.length > 0 || r.effects.some((e) => e.startsWith(ENV_WRITE)))
    )
      wrote = keys;
  }
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
      // One that any load of the group read with a value keeps it eager,
      // even where another load of the group saw it unset.
      const { inputs, volatile, effects, privateEnv, conflicts } = reads.get(result)!;
      if (privateEnv.length > 0)
        return `its load reads the environment variable${privateEnv.length === 1 ? "" : "s"} ${privateEnv.join(", ")}, set at build time, whose value${privateEnv.length === 1 ? "" : "s"} its boot guards would record (scriptc.nodeIslands.publicEnv lists the ones that may be recorded)`;
      if (conflicts.length > 0)
        return `the loads that share its files read ${conflicts.join(", ")} with different values`;
      const inherited = inherits.get(result);
      if (inherited !== undefined)
        return `an earlier load read the environment variable${inherited.length === 1 ? "" : "s"} ${inherited.join(", ")} and wrote shared state, so a load probed after it can export ${inherited.length === 1 ? "its build-time value" : "their build-time values"}`;
      if (c.lazy) return null;
      // Its own, or those of a load it shares a file with.
      const whose = (own: string[]): string =>
        own.length > 0 ? "its load" : "a load it shares a file with";
      if (effects.length > 0) return `${whose(result.effects)} has effects: ${effects.join(", ")}`;
      if (inputs.length > 0) return `${whose(result.inputs)} reads ${inputs.join(", ")}`;
      // A snapshot written without constants keeps an object's flags and its
      // object links, and those answer `typeof` without evaluating a module.
      // An export's type can come from the read as its value can, so a load
      // that read the clock or a random source does not let the other loads
      // of its files keep theirs.
      if (volatile.length > 0 && result.volatile.length === 0)
        return `${whose(result.volatile)} reads ${volatile.join(", ")}: its snapshot would keep the build's object flags and object links`;
      return null;
    })();
    if (why !== null || result === undefined) {
      decide(c.call, false, why ?? "");
      continue;
    }
    const how = c.lazy
      ? `"evaluate": "lazy"`
      : own(c.path)
        ? "recorded evaluation is deterministic; guarded by the loads before it"
        : c.gate === ""
          ? "static gate"
          : `recorded load is deterministic (static gate: ${c.gate})`;
    deferred.push({ call: c.call, result, why: how });
  }
  for (const d of deferred) {
    const r = d.result;
    const { env, tty, volatile } = reads.get(r)!;
    const guards = [
      ...packGuards,
      ...fileGuardLines(r.files.filter((f) => !shipped.has(f))),
      ...env.map(([k, v]) => `E ${lstr(k)} ${v === null ? "0 0:" : `1 ${lstr(v)}`}`),
      ...tty.map(([fd, isTty]) => `T ${fd} ${isTty ? 1 : 0}`),
      // The program's own code computes from what earlier island code left
      // behind, so its snapshot holds only in a run that registered, before
      // it, exactly the loads the probe evaluated before it. The runtime
      // compares (scr_node_island_boot.c); otherwise the module evaluates
      // at its position.
      ...(own(fileOf(mod, pathOf(d.call))) ? [before.get(pathOf(d.call))!] : []),
    ];
    const text = encodeSnapshot(probe, r.root!, guards, volatile.length === 0);
    const arg = d.call.args[1];
    if (arg !== undefined && arg.kind === "strLit") (arg as { value: string }).value = text;
    const notes = [
      d.why,
      ...(env.length > 0
        ? [`env guards ${env.map(([k, v]) => (v === null ? `${k} (unset)` : k)).join(",")}`]
        : []),
      ...(volatile.length > 0 ? [`volatile ${volatile.join(",")}: no constants`] : []),
      ...(r.mutations.length > 0 ? [`mutates ${r.mutations.join(",")}`] : []),
      "evaluated when Node starts",
    ];
    decide(d.call, true, notes.join("; "));
  }
  return decisions;
}

/* ── the snapshot text (scr_node_island_boot.c) ───────────────────────── */

/** The hash of the `P` record (FNV-1a, 32 bits) over the load paths
 * registered so far, each followed by a line feed; the runtime keeps the
 * same one (nb_loads_add). */
const LOADS_HASH_START = 2166136261;

function loadsHash(hash: number, load: string): number {
  let h = hash;
  const bytes = Buffer.from(`${load}\n`, "utf8");
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 16777619) >>> 0;
  return h;
}

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

function runProbe(packDir: string, modules: string[], own: string[]): ProbeOutput | string {
  const host = probeHost();
  if (typeof host === "string") return host;
  const { exe, bootstrap, kept } = host;
  const stem = join(dirname(exe), `run.${process.pid}.${Date.now()}`);
  const input = `${stem}.in.json`;
  const output = `${stem}.out.json`;
  writeFileSync(input, JSON.stringify({ modules, own }), { mode: 0o600 });
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
