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
 *     load does (the user judged the effects benign, and what the load read
 *     of the machine: its snapshot then holds no constants);
 *   - environment reads: the boot guards record every environment
 *     variable the load read. One that was unset at build time is recorded
 *     as unset (`E <key> 0`): the executable learns that the variable was
 *     absent, never a value, and a run that sets it loads the module at
 *     its import. One that had a value is recorded with it, which only
 *     `scriptc.nodeIslands.publicEnv` allows: a load that read a set
 *     variable not listed there stays eager, "lazy" included, and no value
 *     of it reaches the executable. Such a load can leave the value in
 *     shared state (a global, a builtin, a module both use), where a later
 *     load of the same probe can pick it up and export it, so every
 *     candidate the probe reached after a load that stays eager stays eager
 *     too (no run is answered from its snapshot, below);
 *   - the probe: one run of the build-time probe host
 *     (runtime src/tools/scr_node_island_probe.c) in a libnode environment
 *     from the same pack, which loads every candidate module under the
 *     load recorder (probe-recorder.ts) and takes the interface snapshot of
 *     each module's value. "auto" (the default) defers a module whose
 *     recorded load threw nothing, had no effects and read nothing of the
 *     machine or the moment other than public env keys and stdio TTY state,
 *     which become boot guards (the determinism argument in
 *     probe-recorder.ts). A load that read anything else stays eager: an
 *     input no guard covers (the arguments, the working directory, a time
 *     zone not named by TZ), a reading no run repeats (a clock, a random
 *     number, the process id), or a source the recorder does not classify,
 *     which the trace names with the place that read it. The static effect
 *     gate (effect-gate.ts) is reported alongside, as the tier that needs no
 *     recording;
 *   - when it evaluates: every deferred module evaluates when Node
 *     starts, in import order, before the operation that needed Node. No
 *     island code other than deferred loads runs before a deferred load,
 *     so the island sees the loads in Node's order. A module does not
 *     wait for its own first use: a call into a module that evaluated
 *     can write island state (a global, a builtin) that a later load
 *     reads, and Node ran that load at its import, before any call;
 *   - what its snapshot is true of: the probe loads every candidate in one
 *     process, each once, in one order, and a load computes from whatever
 *     the loads before it left in that process: a global, a prototype,
 *     `process`, the exports or the private state of a module both use, the
 *     module registry. The build cannot list what a load read of that, nor
 *     everything a load wrote (a builtin's private state has no property to
 *     compare), so it proves nothing about either. A snapshot instead says
 *     which loads the probe had evaluated before it (`P`), and answers only
 *     in a run that registered exactly those deferred loads, in that order,
 *     before the module's import, with Node not started: there the island
 *     would be in the state the probe's process was in. Any other run (a
 *     branch not taken, an operand evaluated that the probe placed later, a
 *     candidate before it that stayed eager) evaluates the module at its
 *     import, as Node does. The order the probe takes (evaluationOrder)
 *     therefore decides how often a run can use the snapshots, never what
 *     the program computes;
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
import { basename, dirname, join, sep } from "node:path";
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
 * (inside functions, dynamic imports, the bodies of loops and of a switch)
 * keep IR order after it.
 *
 * The order is a best guess wherever the program has a choice: the
 * conditional part of an expression is placed last, both branches of a
 * selection where they are written. What a statement always evaluates is
 * not a choice and keeps its place: the condition of a selection or of a
 * loop, a `for`'s initializer, the first pass of a `do` body, the
 * discriminant and first test of a switch, the operands of a write, a
 * `throw` or a `return`. A run that takes the other way registers other
 * loads before a module than the probe evaluated before it, and that
 * module evaluates at its import instead of answering from its snapshot
 * (the `P` guard every snapshot carries). The guess costs such a run its
 * deferral from that load on, and nothing else. */
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
      // The condition always runs, so a load written in it keeps its place:
      // ahead of the branches' loads and of every load after the statement
      // (`if (require("a").flag) { require("b"); }` evaluates a first, and
      // what a's load left in shared state is there for b's). Left out, it
      // was reached by nothing and probed after all the others.
      const awaits = evaluate(s.cond);
      // The run-once guard returns on a revisit; a fork or worker root is
      // one branch of a selection.
      run(flatStatements(s.then), 0);
      if (s.else_ !== null) run(flatStatements(s.else_), 0);
      return awaits;
    }
    // A loop or a switch: the part that runs whether or not a body does.
    // The bodies, a `for`'s update and the later tests of a switch may not
    // run, and stay with the loads the walk does not reach.
    if (s.kind === "while") return evaluate(s.cond);
    if (s.kind === "forOf") return evaluate(s.iterable);
    if (s.kind === "for") {
      const awaits = s.init !== null && statement(s.init);
      return (s.cond !== null && evaluate(s.cond)) || awaits;
    }
    if (s.kind === "doWhile") {
      // The body's first pass always runs, then the condition.
      run(flatStatements(s.body), 0);
      return evaluate(s.cond);
    }
    if (s.kind === "switch") {
      // The discriminant, then the first test: a later test is evaluated
      // only when the ones before it miss.
      const awaits = evaluate(s.disc);
      const first = s.cases.find((c) => c.test !== null);
      return (first !== undefined && evaluate(first.test!)) || awaits;
    }
    // A block or a guarded body the caller did not open up (inside a
    // sequence): its statements, where they are written.
    if (s.kind === "block" || s.kind === "tryCatch") {
      run(flatStatements([s]), 0);
      return false;
    }
    // Any other statement holds no statements: a write, a throw. Its
    // operands, in the order they are written.
    return within(s);
  }
  function run(stmts: IrStmt[], from: number): void {
    for (let i = from; i < stmts.length; i++) {
      const s = stmts[i]!;
      if (s.kind === "return") {
        if (s.value !== null) evaluate(s.value);
        return;
      }
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
 * first.
 *
 * A module the build wrote for the program (`generated`: a constant or a
 * statement the island evaluates, by the path the probe loaded it from)
 * loads the files of the packages it names. A file it got from an earlier
 * load evaluated in that load, so what the generated module read or did
 * there is its own body's: it carries the reads and effects of the loads
 * whose files it loads and of the generated modules it imports (its value
 * can come from theirs), and gives its own to the generated modules that
 * import it, not to those earlier loads. A statement of the program that
 * prints through a package's function has effects, and the package's
 * import, which evaluated the package's files quietly, still waits.
 *
 * A file that no earlier load lists evaluated in the generated module's
 * own load (`results` is in the probe's order): the package's import comes
 * later in the probe's order, or only a call of the generated module
 * reaches the file. What the file read is then in the generated module's
 * record, and every other load of that file shares it both ways, as two
 * packages do. */
function loadReads(
  results: ProbeResult[],
  publicEnv: ReadonlySet<string>,
  generated: ReadonlySet<string> = new Set(),
): Map<ProbeResult, LoadReads> {
  const parent = results.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  /** The first load, in the probe's order, that lists each file: the load
   * the file evaluated in. */
  const owner = new Map<string, number>();
  results.forEach((r, i) => {
    const own = generated.has(r.path);
    for (const f of r.files) {
      const j = owner.get(f);
      if (j === undefined) owner.set(f, i);
      else if (!own) parent[find(i)] = find(j);
    }
  });
  /** Adds to `seen` the loads whose reads and effects load `i` answers
   * for: the loads it shares a file with, and for a generated module the
   * loads that evaluated the files it loads, with theirs. */
  const collect = (i: number, seen: Set<number>): void => {
    results.forEach((_, j) => {
      if (find(j) === find(i)) seen.add(j);
    });
    if (!generated.has(results[i]!.path)) return;
    for (const f of results[i]!.files) {
      const from = owner.get(f);
      if (from === undefined || seen.has(from)) continue;
      seen.add(from);
      collect(from, seen);
    }
  };
  const reads = new Map<ProbeResult, LoadReads>();
  results.forEach((r, i) => {
    // A module's own come first.
    const seen = new Set([i]);
    collect(i, seen);
    const group = [...seen].map((j) => results[j]!);
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
  // evaluates, and its statements the island evaluates.
  const generated = new Set<string>();
  for (const file of tree?.files ?? []) {
    if (file.generated === undefined) continue;
    generated.add(join(tree!.root, ...file.path.split("/")));
  }
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
  const reads = loadReads(probe.results, publicEnv, new Set(scratch?.copies.values() ?? []));
  const deferred: { call: DeferCall; result: ProbeResult; at: number; why: string }[] = [];
  // The build machine's directories a snapshot must not name
  // (snapshotNames): the tree's root, and the probe's copies of the
  // generated modules.
  const buildDirs = [
    ...(tree !== undefined && tree.root.length > 1 ? [tree.root] : []),
    ...(scratch !== null ? [scratch.dir] : []),
  ];
  // The first probed load that evaluates where it is imported, by its place
  // in the probe's order, and what the loads the probe reached after it are
  // told. The probe loads every candidate in one process, so what that load
  // left in shared state (a global, a builtin's state, a module both use),
  // whatever it read included (an environment variable set at build time, a
  // clock), is there for every load after it, and their constants can hold
  // it in a form the build cannot recognize. No run is answered from such a
  // snapshot: Node is running once the earlier load evaluates, and a run
  // that skips the earlier load fails the snapshot's guard on the loads
  // before it (the load never registers). So the snapshot is not written,
  // and the executable holds nothing the build computed after that load:
  // two builds of one program are the same bytes.
  let earlier: { at: number; why: string } | undefined;
  const earlierReason = (r: ProbeResult): string => {
    const { volatile, privateEnv } = reads.get(r)!;
    const s = privateEnv.length === 1 ? "" : "s";
    if (volatile.length > 0)
      return `an earlier load reads ${volatile.join(", ")} and evaluates where it is imported, so Node is running before this load, and a snapshot of it could hold the build's reading`;
    if (privateEnv.length > 0)
      return `an earlier load reads the environment variable${s} ${privateEnv.join(", ")}, set at build time, and evaluates where it is imported, so Node is running before this load, and a snapshot of it could hold the build-time value${s}`;
    return "an earlier load evaluates where it is imported, so Node is running before this load, and a snapshot of it could hold what that load left in the island";
  };
  for (const c of candidates) {
    const result = probe.results.find((r) => r.path === probed(c.path));
    const at = result === undefined ? -1 : probe.results.indexOf(result);
    const why = (() => {
      if (result === undefined) return "the probe did not load it";
      if (result.throws !== undefined) return `its evaluation throws: ${result.throws}`;
      if (result.root === undefined) return result.reason ?? "the probe did not load it";
      if (snapshotNames(probe, result.root, buildDirs))
        return "its exports hold a path of the build machine";
      // A file the probe evaluated that the shipped tree does not hold (a
      // package another one requires by a computed name). The executable's
      // island loads only the tree's files, so a run evaluates the module
      // where it is imported and fails to load that file there; a snapshot
      // would answer only where a guard on the build machine's file holds.
      const outside = tree === undefined ? undefined : result.files.find((f) => !shipped.has(f));
      if (outside !== undefined)
        return `its load evaluates ${outside}, which the shipped module tree does not hold`;
      // A variable that was unset is guarded as unset: no value to record.
      // One that any load of the group read with a value keeps it eager,
      // even where another load of the group saw it unset.
      const { inputs, volatile, effects, privateEnv, conflicts } = reads.get(result)!;
      if (privateEnv.length > 0)
        return `its load reads the environment variable${privateEnv.length === 1 ? "" : "s"} ${privateEnv.join(", ")}, set at build time, whose value${privateEnv.length === 1 ? "" : "s"} its boot guards would record (scriptc.nodeIslands.publicEnv lists the ones that may be recorded)`;
      if (conflicts.length > 0)
        return `the loads that share its files read ${conflicts.join(", ")} with different values`;
      // The load's own reasons come first; this one holds for "lazy" too.
      const after = earlier !== undefined && at > earlier.at ? earlier.why : null;
      if (c.lazy) return after;
      // Its own, or those of a load it shares a file with.
      const whose = (own: string[]): string =>
        own.length > 0 ? "its load" : "a load it shares a file with";
      if (effects.length > 0) return `${whose(result.effects)} has effects: ${effects.join(", ")}`;
      if (inputs.length > 0) return `${whose(result.inputs)} reads ${inputs.join(", ")}`;
      // A reading no run repeats (a clock, a random number, the process id)
      // has no boot guard, and leaving the constants out of the snapshot is
      // not enough to wait with the load. A clock read late comes after the
      // program's own readings that followed the import. A snapshot without
      // constants still keeps an object's flags and its object links, which
      // answer `typeof` and hand out members without evaluating a module, and
      // which members are objects can come from the reading as a value can.
      // And what the load left in shared state from the build's reading is in
      // the constants of the loads probed after it. So the load, and every
      // load that shares a file with it, evaluates where it is imported.
      if (volatile.length > 0)
        return `${whose(result.volatile)} reads ${volatile.join(", ")}: no run repeats the reading, and a load evaluated later would take it after the program's own`;
      return after;
    })();
    if (why !== null || result === undefined) {
      decide(c.call, false, why ?? "");
      if (earlier === undefined && result !== undefined)
        earlier = { at, why: earlierReason(result) };
      continue;
    }
    const how = c.lazy
      ? `"evaluate": "lazy"`
      : own(c.path)
        ? "recorded evaluation is deterministic; guarded by the loads before it"
        : c.gate === ""
          ? "static gate"
          : `recorded load is deterministic (static gate: ${c.gate})`;
    deferred.push({ call: c.call, result, at, why: how });
  }
  // The first deferred load that read something no guard covers (only
  // "lazy" defers one), and what it read. The loads the probe reached after
  // it computed from an island that held the build's reading, and can export
  // it (a package that exports what the lazy one left in a global): their
  // snapshots keep no constants either.
  const unguarded = deferred
    .map(({ result, at }) => {
      const { inputs, volatile } = reads.get(result)!;
      return { at, read: [...inputs, ...volatile] };
    })
    .find(({ read }) => read.length > 0);
  // Whether a file the probe evaluated spells `key`: a snapshot without
  // constants writes only such keys (encodeSnapshot), so the executable
  // holds no key the shipped files do not hold already. The files are read
  // the first time a snapshot needs them.
  let sources: string[] | undefined;
  const spelled = (key: string): boolean => {
    sources ??= [
      ...[...new Set(probe.results.flatMap((r) => r.files))].flatMap((file) => {
        try {
          return [readFileSync(file, "utf8")];
        } catch {
          return [];
        }
      }),
      // The probe's copies are gone: the tree holds their text.
      ...(tree?.files.flatMap((file) => (file.generated === undefined ? [] : [file.generated])) ??
        []),
    ];
    return sources.some((text) => text.includes(key));
  };
  for (const d of deferred) {
    const r = d.result;
    const { env, tty, volatile, inputs } = reads.get(r)!;
    const late = unguarded !== undefined && d.at > unguarded.at;
    const guards = [
      ...packGuards,
      ...fileGuardLines(r.files.filter((f) => !shipped.has(f))),
      ...env.map(([k, v]) => `E ${lstr(k)} ${v === null ? "0 0:" : `1 ${lstr(v)}`}`),
      ...tty.map(([fd, isTty]) => `T ${fd} ${isTty ? 1 : 0}`),
      // A load computes from what the loads before it left in the island (a
      // global, a prototype, a module both use), and so does the program's
      // own code. The snapshot holds only in a run that registered, before
      // it, exactly the loads the probe evaluated before it. The runtime
      // compares (scr_node_island_boot.c); otherwise the module evaluates
      // at its position.
      before.get(pathOf(d.call))!,
    ];
    // Only "lazy" defers a load that read something no guard covers: the
    // build's reading stays out of the executable.
    const text = encodeSnapshot(
      probe,
      r.root!,
      guards,
      volatile.length === 0 && inputs.length === 0 && !late,
      spelled,
    );
    const arg = d.call.args[1];
    if (arg !== undefined && arg.kind === "strLit") (arg as { value: string }).value = text;
    const notes = [
      d.why,
      ...(env.length > 0
        ? [`env guards ${env.map(([k, v]) => (v === null ? `${k} (unset)` : k)).join(",")}`]
        : []),
      ...(volatile.length > 0 ? [`volatile ${volatile.join(",")}: no constants`] : []),
      ...(inputs.length > 0 ? [`reads ${inputs.join(",")}: no constants`] : []),
      ...(late ? [`probed after a load that reads ${unguarded.read.join(",")}: no constants`] : []),
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
  /** Sources the recorder has a rule for and cannot observe in this Node
   * (members Node makes not configurable). A load whose files name one is
   * recorded as having read it. */
  untrappable?: string[];
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

/** Whether a string the snapshot holds, as a value or as a member's key,
 * names a path of the build machine: one under one of `dirs` (with or
 * without its leading separator), or one of the directories above it. The
 * probe loads the modules from the build machine (a generated module from
 * a copy in a temporary directory), and the program from the module tree
 * it ships, so such a string would not be the one the program sees (a
 * module's own `__dirname`, say, or the file of a caller found from a
 * stack trace). The directories above come to a
 * module as the loader's lookup paths (`module.paths`,
 * `require.resolve.paths()`: `<above>/node_modules`), and from its own
 * path arithmetic; a string that only mentions a top-level directory
 * (`/tmp/...`) is not taken for one. */
function snapshotNames(probe: ProbeOutput, root: number, dirs: readonly string[]): boolean {
  const tests = dirs.map((dir) => {
    const above: string[] = [];
    for (let d = dirname(dir); d !== dirname(d); d = dirname(d)) above.push(d);
    const deep = above.filter((d) => d.split(/[\\/]/).filter((part) => part !== "").length >= 2);
    // The path without its root (`path.relative("/", __dirname)`).
    const rootless = dir.replace(/^(?:[A-Za-z]:)?[\\/]+/, "");
    return (s: string): boolean =>
      s.includes(dir) ||
      (rootless.includes(sep) && s.includes(rootless)) ||
      above.some((d) => s.includes(join(d, "node_modules"))) ||
      deep.some((d) => s === d || s.startsWith(join(d, "x").slice(0, -1)));
  });
  const names = (s: string): boolean => tests.some((test) => test(s));
  const seen = new Set<number>();
  const visit = (oid: number): boolean => {
    if (seen.has(oid) || probe.objects[oid] === undefined) return false;
    seen.add(oid);
    for (const [key, v] of probe.objects[oid]!.m) {
      if (names(key)) return true;
      if ("s" in v && names(v.s)) return true;
      if ("o" in v && visit(v.o)) return true;
    }
    return false;
  };
  return visit(root);
}

/** The snapshot text of the value `root`. Without `constants` (a load that
 * read something no guard covers), only object members are written, and
 * only those whose key `spelled` admits: a key can come from the build's
 * reading as a value can (`{ [os.hostname()]: {...} }`). A member left out
 * is read from Node. */
function encodeSnapshot(
  probe: ProbeOutput,
  root: number,
  guards: string[],
  constants: boolean,
  spelled: (key: string) => boolean,
): string {
  const lines = [...guards];
  const reached: number[] = [];
  const seen = new Set<number>();
  const members = (oid: number): [string, ProbeValue][] =>
    constants ? probe.objects[oid]!.m : probe.objects[oid]!.m.filter(([key]) => spelled(key));
  const visit = (oid: number): void => {
    if (seen.has(oid) || probe.objects[oid] === undefined) return;
    seen.add(oid);
    reached.push(oid);
    for (const [, v] of members(oid)) if ("o" in v) visit(v.o);
  };
  visit(root);
  for (const oid of reached) {
    const o = probe.objects[oid]!;
    lines.push(`O ${oid} ${o.f} ${o.p ? 1 : 0}`);
  }
  for (const oid of reached) {
    for (const [key, v] of members(oid)) {
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
