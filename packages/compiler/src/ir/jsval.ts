/* The jsval pass (two-tier design stage S3): dynamic-tier functions compute
 * with jsval values instead of dyn cells.
 *
 * Lowering builds every dynamic operation over `dyn`, the checked-dynamic
 * cell (ScrDyn), where a number is a heap node: each dyn operator result
 * allocates one. This pass rewrites the operator chains of dynamic-tier
 * functions (ir/tiers.ts) to the `js.*` builtins over `jsval`, the
 * NaN-boxed word whose numbers, booleans, undefined and null are
 * immediates:
 *
 * - every dyn operator (`dyn.add`, `dyn.arithmetic`, `dyn.bitwise`,
 *   `dyn.toNumeric`, `dyn.increment`) becomes its `js.*` twin, whose
 *   operands are rewritten as jsvals too, so a chain `a * b + c` allocates
 *   nothing for its intermediate results;
 * - the operator consumers `dyn.compare` and `dyn.toNumberCoerce` take
 *   jsval operands, a number check `dynCheck<f64>` of an operator result
 *   becomes `js.toF64`, and a truthiness test of one tests the jsval;
 * - a static number or boolean operand (`dynFrom<f64>`) becomes an
 *   immediate (`js.fromF64`), a static string or BigInt the same object
 *   under a tag (`js.fromStr`, `js.fromBigInt`: no cell), and any other dyn
 *   operand a cell under the cell tag (`js.fromDyn`: no copy, identity
 *   kept);
 * - an operator result that flows anywhere else (a property store, a call
 *   argument, a dyn local) is boxed back into a cell (`js.toDyn`), exactly
 *   the allocation the dyn operator made before;
 * - a dynamic function whose only references are direct calls from
 *   dynamic functions returns a jsval, so a number it returns is not boxed
 *   (static callers, function values, exports and class members keep the
 *   dyn ABI);
 * - such a function also takes a jsval for each parameter whose callers
 *   mostly pass operator results or static numbers, unless its own reads
 *   of the parameter by dyn consumers box more often than its callers do;
 * - a dyn local becomes a jsval local when the boxing it saves on writes
 *   of operator results outweighs the boxing its reads by dyn consumers add
 *   (loop depth weights both);
 * - a function that dynamic-tier functions call directly but that is also
 *   reached otherwise (a class member, a function value, a static caller)
 *   gets a jsval entry `%js.<name>` holding its body when one of its
 *   parameters qualifies the same way: the direct calls of dynamic-tier
 *   functions call the entry, and the function itself becomes a wrapper
 *   that keeps the dyn ABI for everyone else;
 * - a closure whose body uses a parameter only as an operand gets a jsval
 *   copy of its body (IrFunction.jsEntry), which the function values boxed
 *   from it enter with jsval arguments from dynCall and dynInvoke sites;
 * - a dyn module global becomes a jsval global by the same measure, summed
 *   over every function, when only dynamic-tier functions reference it.
 *
 * The rewrite changes representation only: every js builtin implements its
 * dyn twin's JS semantics, including ToPrimitive order and error messages
 * (scr_js_value.c delegates every non-number case to the dyn operator).
 * Static functions are never touched (invariant I1). Captures, containers
 * and the parameters of functions reached other than by direct calls still
 * hold cells until the shaped object model and the dynamic call ABI
 * (stages S4 and S5) replace them.
 *
 * Async functions and generators are rewritten like other functions (their
 * suspensions keep jsvals like any pointer) but keep the dyn result ABI. */
import { exprFunctionReference, moduleFunctionReferences } from "./function-references.js";
import {
  DYN,
  JSVAL,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrParam,
  type IrStmt,
} from "./ir.js";
import { JsIcSites } from "./js-ic.js";
import { reparseStmt } from "./serialize.js";
import {
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  mapExprChildren,
  mapStmtChildren,
  transformStmtList,
} from "./traverse.js";

/** dyn operators whose result is a fresh dynamic value, with their jsval
 * twins. Every argument typed dyn is an operand. */
const PRODUCERS: Readonly<Record<string, string>> = {
  "dyn.add": "js.add",
  "dyn.arithmetic": "js.arithmetic",
  "dyn.bitwise": "js.bitwise",
  "dyn.toNumeric": "js.toNumeric",
  "dyn.increment": "js.increment",
};

/** dyn operators with a static result, with their jsval twins. */
const CONSUMERS: Readonly<Record<string, string>> = {
  "dyn.compare": "js.compare",
  "dyn.toNumberCoerce": "js.toNumberCoerce",
};

function isProducerCall(e: IrExpr): boolean {
  return e.kind === "libCall" && Object.hasOwn(PRODUCERS, e.fn);
}

function isConsumerCall(e: IrExpr): boolean {
  return e.kind === "libCall" && Object.hasOwn(CONSUMERS, e.fn);
}

/** The jsval conversion of a static value that crosses without a cell:
 * numbers and booleans as immediates, strings and BigInts as the static
 * tier's own objects under a tag. */
const STATIC_SOURCES: Readonly<Record<string, string>> = {
  f64: "js.fromF64",
  bool: "js.fromBool",
  string: "js.fromStr",
  bigint: "js.fromBigInt",
};

function isImmediateSource(e: IrExpr): boolean {
  return (
    e.kind === "dynFrom" &&
    e.liveRef === undefined &&
    e.fnName === undefined &&
    Object.hasOwn(STATIC_SOURCES, e.value.type.kind)
  );
}

/** Whether a function's operators are rewritten: every dynamic-tier
 * function. Async functions and generators suspend through LLVM coroutines
 * or fibers, which keep jsval temporaries and locals like any pointer. */
export function jsvalEligible(fn: IrFunction): boolean {
  return fn.tier === "dynamic";
}

/** Rewrite every eligible dynamic-tier function of a module in place.
 * Returns the number of functions that now use jsval. */
export function promoteJsvals(mod: IrModule): number {
  const direct = directCallees(mod);
  const results = new Set<string>();
  for (const fn of mod.functions)
    if (direct.has(fn.name) && fn.returnType.kind === "dyn") results.add(fn.name);
  const sites = new JsIcSites(mod);
  const storesJs = (e: IrExpr): boolean =>
    e.kind === "call" && sites.site(e.callee)?.kind === "set";
  const candidates = entryCandidates(mod, direct, sites);
  const params = jsvalParams(mod, direct, candidates, results, sites, storesJs);
  splitEntries(mod, candidates, params, results);
  const jsDynArguments = closureEntries(mod, params, results, storesJs);
  const globals = promotableGlobals(mod, results, params, storesJs, jsDynArguments);
  let count = 0;
  for (const fn of mod.functions)
    if (
      jsvalEligible(fn) &&
      promoteFunction(fn, results, params, storesJs, globals, jsDynArguments)
    )
      count++;
  for (const fn of mod.functions) if (results.has(fn.name)) fn.returnType = JSVAL;
  for (const global of mod.globals ?? []) if (globals.has(global.id)) global.type = JSVAL;
  return count;
}

/** Dynamic-tier functions whose ABI the pass may change, so a number they
 * return or take is not boxed: eligible functions whose every reference is
 * a direct call from a dynamic-tier function (static callers keep their
 * exact code, I1). Function values, library exports, the entry and class
 * members (`%<class>.<member>`, which vtables and the runtime reach by
 * name) keep the dyn ABI. */
function directCallees(mod: IrModule): Set<string> {
  const classPrefixes = (mod.classes ?? []).map((cls) => `%${cls.name}.`);
  const results = new Set<string>();
  for (const fn of mod.functions) {
    // An async function's callers receive a promise and a generator's a
    // generator object: only synchronous functions return their result.
    if (!jsvalEligible(fn) || fn.async !== undefined || fn.generator !== undefined) continue;
    if (fn.name.includes(".") && !fn.name.startsWith("%dyn.")) continue;
    if (classPrefixes.some((prefix) => fn.name.startsWith(prefix))) continue;
    results.add(fn.name);
  }
  if (results.size === 0) return results;
  for (const name of moduleFunctionReferences(mod)) results.delete(name);
  for (const fn of mod.functions) {
    const dynamic = fn.tier === "dynamic";
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "call" && !dynamic) results.delete(e.callee);
        const referenced = exprFunctionReference(e);
        if (referenced !== undefined) results.delete(referenced);
        if (e.kind === "dynFrom" && e.fnName !== undefined) results.delete(e.fnName);
        return true;
      },
      stmt: () => true,
    });
  }
  return results;
}

/** Functions that dynamic-tier functions call directly but that are also
 * reached otherwise, so they keep the dyn ABI: candidates for a jsval
 * entry (splitEntries). Library helpers (`%dyn.*`), inline-cache sites, the
 * entry, closures (`captures`, `selfRef`) and suspending functions are
 * left out. */
function entryCandidates(
  mod: IrModule,
  direct: ReadonlySet<string>,
  sites: JsIcSites,
): Set<string> {
  const called = new Set<string>();
  for (const fn of mod.functions) {
    if (fn.tier !== "dynamic") continue;
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "call") called.add(e.callee);
        return true;
      },
      stmt: () => true,
    });
  }
  const candidates = new Set<string>();
  for (const fn of mod.functions) {
    if (!called.has(fn.name) || direct.has(fn.name) || fn.name === mod.entry) continue;
    if (!jsvalEligible(fn) || fn.async !== undefined || fn.generator !== undefined) continue;
    if (fn.captures !== undefined || fn.classCaptures !== undefined) continue;
    if (fn.speculativeDispatch !== undefined || fn.fastRead !== undefined) continue;
    if (fn.name.startsWith("%dyn.") || sites.site(fn.name) !== null) continue;
    if (!fn.params.some((p) => p.type.kind === "dyn")) continue;
    const plain = everyStmtList(fn.body, { expr: (e) => e.kind !== "selfRef", stmt: () => true });
    if (plain) candidates.add(fn.name);
  }
  return candidates;
}

/** The parameters that take a jsval, by function and position: parameters
 * of direct callees and entry candidates, other than inline-cache sites.
 * A parameter's credit is the share of its arguments, weighted by the
 * callers' loop depth, that the callers compute as jsvals (operator
 * results, jsval results, static numbers and the callers' own jsval
 * parameters): the boxing a call saves. promotableLocals weighs it against
 * the callee's reads of the parameter by dyn consumers.
 *
 * The decision starts from every candidate parameter and drops the ones
 * whose credit no longer pays, until nothing changes, so a parameter that
 * a dispatch helper forwards to a method can qualify in both. */
function jsvalParams(
  mod: IrModule,
  direct: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
  results: ReadonlySet<string>,
  sites: JsIcSites,
  storesJs: (e: IrExpr) => boolean,
): Map<string, boolean[]> {
  const byName = new Map<string, IrFunction>();
  const params = new Map<string, boolean[]>();
  for (const fn of mod.functions) {
    byName.set(fn.name, fn);
    if (!direct.has(fn.name) && !candidates.has(fn.name)) continue;
    if (sites.site(fn.name) !== null) continue;
    const js = fn.params.map((p) => p.type.kind === "dyn");
    if (js.includes(true)) params.set(fn.name, js);
  }
  const returnsJs = (callee: string): boolean =>
    results.has(callee) ||
    (candidates.has(callee) && byName.get(callee)!.returnType.kind === "dyn");
  const producer = (e: IrExpr): boolean =>
    isProducerCall(e) || (e.kind === "call" && returnsJs(e.callee));
  for (let changed = params.size > 0; changed;) {
    changed = false;
    const passed = new Map<string, { total: number[]; js: number[] }>();
    for (const [name, js] of params)
      passed.set(name, { total: js.map(() => 0), js: js.map(() => 0) });
    for (const fn of mod.functions) {
      if (fn.tier !== "dynamic") continue;
      const own = params.get(fn.name);
      const jsLocals = new Set(fn.params.filter((_, i) => own?.[i] === true).map((p) => p.localId));
      const jsArgument = (e: IrExpr): boolean =>
        producer(e) || isImmediateSource(e) || (e.kind === "varRef" && jsLocals.has(e.localId));
      everyWeightedExpr(fn.body, (e, weight) => {
        const counts = e.kind === "call" ? passed.get(e.callee) : undefined;
        if (counts === undefined || e.kind !== "call") return;
        e.args.forEach((arg, i) => {
          if (i >= counts.total.length || arg.type.kind !== "dyn") return;
          counts.total[i]! += weight;
          if (jsArgument(arg)) counts.js[i]! += weight;
        });
      });
    }
    for (const [name, js] of params) {
      const fn = byName.get(name)!;
      const counts = passed.get(name)!;
      const credits = new Map<string, number>();
      fn.params.forEach((p, i) => {
        if (js[i] === true && counts.js[i]! > 0)
          credits.set(p.localId, counts.js[i]! / counts.total[i]!);
      });
      const promoted =
        credits.size === 0
          ? new Set<string>()
          : promotableLocals(fn, producer, returnsJs(name), storesJs, credits, params);
      const next = fn.params.map((p, i) => js[i] === true && promoted.has(p.localId));
      if (next.every((v, i) => v === js[i])) continue;
      changed = true;
      if (next.includes(true)) params.set(name, next);
      else params.delete(name);
    }
  }
  return params;
}

/** Give each entry candidate with a jsval parameter its jsval entry: a new
 * function `%js.<name>` takes the body (its stack frame included), the
 * function keeps its name and dyn ABI as a wrapper that calls the entry,
 * and the direct calls of dynamic-tier functions call the entry instead.
 * Static callers, vtables, function values and the runtime keep reaching
 * the wrapper. The decisions in `params` and `results` move to the
 * entries. */
function splitEntries(
  mod: IrModule,
  candidates: ReadonlySet<string>,
  params: Map<string, boolean[]>,
  results: Set<string>,
): void {
  const entries = new Map<string, string>();
  for (const name of candidates) {
    const js = params.get(name);
    if (js === undefined) continue;
    const entry = `%js.${name}`;
    entries.set(name, entry);
    params.delete(name);
    params.set(entry, js);
  }
  if (entries.size === 0) return;
  const functions: IrFunction[] = [];
  for (const fn of mod.functions) {
    const entryName = entries.get(fn.name);
    if (entryName === undefined) {
      functions.push(fn);
      continue;
    }
    const { ownsPrototype: _ownsPrototype, ...rest } = fn;
    const entry: IrFunction = {
      ...rest,
      name: entryName,
      params: fn.params.map((p) => ({ ...p })),
    };
    if (fn.returnType.kind === "dyn") results.add(entryName);
    const call: IrExpr = {
      kind: "call",
      callee: entryName,
      args: fn.params.map((p) => ({
        kind: "varRef",
        localId: p.localId,
        type: p.type,
        loc: fn.loc,
      })),
      type: fn.returnType,
      loc: fn.loc,
    };
    fn.locals = fn.params.map((p) => ({
      id: p.localId,
      name: p.name,
      type: p.type,
      mutable: false,
    }));
    fn.body =
      fn.returnType.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc: fn.loc }]
        : [{ kind: "return", value: call, loc: fn.loc }];
    delete fn.sourceName;
    functions.push(fn, entry);
  }
  mod.functions = functions;
  const wrappers = new Set(entries.keys());
  const retarget = (e: IrExpr): IrExpr => {
    const entry = e.kind === "call" ? entries.get(e.callee) : undefined;
    return entry === undefined ? e : { ...(e as Extract<IrExpr, { kind: "call" }>), callee: entry };
  };
  for (const fn of mod.functions) {
    if (fn.tier !== "dynamic" || wrappers.has(fn.name)) continue;
    fn.body = transformStmtList(fn.body, { expr: retarget, stmt: (s) => s });
  }
}

/** Give closures a jsval entry for the function values boxed from them:
 * `%js.<name>`, a copy of the body with the same captures whose
 * parameters that the body only uses as operands take jsvals, named by
 * the closure's `jsEntry`. The backend's box builders register the entry
 * on every function value of the closure, and the dynamic tier's dynCall
 * and dynInvoke sites call it with jsval arguments. A closure keeps one
 * body when no parameter qualifies, when a parameter is typed, when its
 * body is not dynamic-tier,
 * when a closure of it reads arguments past its parameters (a
 * rest-marked type), or when it suspends. Returns whether any closure got
 * an entry. */
function closureEntries(
  mod: IrModule,
  params: Map<string, boolean[]>,
  results: Set<string>,
  storesJs: (e: IrExpr) => boolean,
): boolean {
  const boxed = new Set<string>();
  const variadic = new Set<string>();
  for (const fn of mod.functions) {
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "closure") {
          if (e.type.kind === "func" && e.type.rest !== true) boxed.add(e.fnName);
          else variadic.add(e.fnName);
        }
        return true;
      },
      stmt: () => true,
    });
  }
  for (const name of variadic) boxed.delete(name);
  if (boxed.size === 0) return false;
  const producer = (e: IrExpr): boolean =>
    isProducerCall(e) || (e.kind === "call" && results.has(e.callee));
  const functions: IrFunction[] = [];
  let any = false;
  for (const fn of mod.functions) {
    functions.push(fn);
    if (!boxed.has(fn.name) || fn.captures === undefined || fn.classCaptures !== undefined)
      continue;
    if (!jsvalEligible(fn) || fn.async !== undefined || fn.generator !== undefined) continue;
    // The jsval entry passes words: a typed parameter would need the dyn
    // entry's argument checks.
    if (fn.params.some((p) => p.type.kind !== "dyn")) continue;
    // A caller of a function value passes no argument the body could not
    // take as a cell, so a parameter takes a jsval only when no dyn
    // consumer reads it: the half credit loses to any such read.
    const credits = new Map<string, number>();
    for (const p of fn.params) if (p.type.kind === "dyn") credits.set(p.localId, 0.5);
    if (credits.size === 0) continue;
    const jsResult = fn.returnType.kind === "dyn";
    const promoted = promotableLocals(fn, producer, jsResult, storesJs, credits, params, true);
    const js = fn.params.map((p) => credits.has(p.localId) && promoted.has(p.localId));
    if (!js.includes(true)) continue;
    const name = `%js.${fn.name}`;
    const { ownsPrototype: _ownsPrototype, ...rest } = fn;
    functions.push({
      ...rest,
      name,
      params: fn.params.map((p: IrParam): IrParam => ({ ...p })),
      locals: fn.locals.map(copyLocal),
      captures: fn.captures.map((c: IrParam): IrParam => ({ ...c })),
      body: fn.body.map(reparseStmt),
    });
    fn.jsEntry = name;
    params.set(name, js);
    if (jsResult) results.add(name);
    any = true;
  }
  mod.functions = functions;
  return any;
}

/** A local's own copy, for a body copy whose rewrite retypes locals. */
function copyLocal(local: IrLocal): IrLocal {
  const copy: IrLocal = {
    id: local.id,
    name: local.name,
    type: local.type,
    mutable: local.mutable,
  };
  if (local.source !== undefined) copy.source = local.source;
  if (local.boxed !== undefined) copy.boxed = local.boxed;
  if (local.tdz !== undefined) copy.tdz = local.tdz;
  return copy;
}

/** Visit every expression of a body with its loop weight. */
function everyWeightedExpr(body: IrStmt[], visit: (e: IrExpr, weight: number) => void): void {
  const expr = (e: IrExpr, weight: number): void => {
    visit(e, weight);
    everyExprChild(
      e,
      (child) => {
        expr(child, weight);
        return true;
      },
      (child) => {
        stmt(child, weight);
        return true;
      },
    );
  };
  const stmt = (s: IrStmt, weight: number): void => {
    const inner =
      s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf"
        ? Math.min(weight * LOOP_WEIGHT, MAX_WEIGHT)
        : weight;
    everyStmtChild(
      s,
      (child) => {
        expr(child, inner);
        return true;
      },
      (child) => {
        stmt(child, inner);
        return true;
      },
    );
  };
  for (const s of body) stmt(s, 1);
}

/* ── local promotion ─────────────────────────────────────────────────── */

const LOOP_WEIGHT = 8;
const MAX_WEIGHT = 8 ** 6;

interface LocalCost {
  /** Boxing a jsval local saves: writes of operator results (and
   * immediates), weighted by loop depth. */
  saved: number;
  /** Boxing it adds: reads by dyn consumers, weighted the same way. */
  added: number;
}

/** The dyn locals of a function that become jsval locals. `producer`
 * tells which dyn expressions the rewrite computes as jsvals. Parameters
 * are candidates only with a credit (jsvalParams); `jsParams` lists the
 * arguments that calls pass as jsvals, `jsDynArguments` whether dynCall
 * and dynInvoke take jsval arguments (closureEntries), and `jsBindings`
 * the module globals that hold jsvals. */
function promotableLocals(
  fn: IrFunction,
  producer: (e: IrExpr) => boolean,
  jsResult: boolean,
  storesJs: (e: IrExpr) => boolean,
  credits: ReadonlyMap<string, number> = new Map(),
  jsParams: ReadonlyMap<string, readonly boolean[]> = new Map(),
  jsDynArguments = false,
  jsBindings: ReadonlySet<string> = new Set(),
): Set<string> {
  /* One round: `sources` are the bindings taken as jsvals, so a copy of
   * one is a jsval write, and the copy's read of it a jsval use. */
  const round = (sources: ReadonlySet<string>): Set<string> => {
    const candidates = localCandidates(fn, credits);
    if (candidates.size === 0) return new Set();
    const blocked = new Set<string>();
    scanBindingCosts(fn, candidates, blocked, producer, jsResult, storesJs, jsParams, {
      sources,
      jsDynArguments,
    });
    const promoted = new Set<string>();
    // A caller boxes on every call, the callee only on the paths that read
    // the parameter by a dyn consumer: a parameter takes a jsval on a tie.
    for (const [id, cost] of candidates)
      if (
        !blocked.has(id) &&
        (cost.saved > cost.added || (credits.has(id) && cost.saved >= cost.added))
      )
        promoted.add(id);
    return promoted;
  };
  // Each round takes the previous round's promotions as sources, so a copy
  // chain from a promoted local, a credited parameter or a jsval global
  // follows it.
  let sources = new Set([...credits.keys(), ...jsBindings]);
  let promoted = round(sources);
  for (let i = 0; i < 4; i++) {
    const next = new Set([...sources, ...promoted]);
    if (next.size === sources.size) break;
    sources = next;
    promoted = round(sources);
  }
  return promoted;
}

/** The dyn locals of a function that may become jsval locals, parameters
 * with their credit. */
function localCandidates(
  fn: IrFunction,
  credits: ReadonlyMap<string, number>,
): Map<string, LocalCost> {
  const candidates = new Map<string, LocalCost>();
  for (const local of fn.locals) {
    if (local.type.kind === "dyn" && local.boxed === undefined && local.tdz === undefined)
      candidates.set(local.id, { saved: 0, added: 0 });
  }
  for (const p of fn.params) {
    const cost = candidates.get(p.localId);
    const credit = credits.get(p.localId);
    if (cost === undefined || credit === undefined) candidates.delete(p.localId);
    else cost.saved += credit;
  }
  for (const c of fn.captures ?? []) candidates.delete(c.localId);
  for (const c of fn.classCaptures ?? []) candidates.delete(c.localId);
  return candidates;
}

/** The dyn module globals that become jsval globals: those that only
 * dynamic-tier functions reference, by reads and plain writes, and whose
 * saved boxing outweighs the added boxing summed over every function, the
 * same measure as for locals. Libraries keep every global (the host reads
 * exported bindings), and so do bindings with a temporal dead zone. */
function promotableGlobals(
  mod: IrModule,
  results: ReadonlySet<string>,
  jsParams: ReadonlyMap<string, readonly boolean[]>,
  storesJs: (e: IrExpr) => boolean,
  jsDynArguments: boolean,
): Set<string> {
  const candidates = new Map<string, LocalCost>();
  if (mod.lib !== undefined) return new Set();
  for (const global of mod.globals ?? [])
    if (global.type.kind === "dyn" && global.tdz === undefined && global.initFlag === undefined)
      candidates.set(global.id, { saved: 0, added: 0 });
  if (candidates.size === 0) return new Set();
  const blocked = new Set<string>();
  const producer = (e: IrExpr): boolean =>
    isProducerCall(e) || (e.kind === "call" && results.has(e.callee));
  for (const fn of mod.functions) {
    if (!jsvalEligible(fn)) {
      // A static function reads and writes the binding as a cell (I1).
      everyStmtList(fn.body, {
        expr: (e) => {
          if (
            (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") &&
            candidates.has(e.localId)
          )
            blocked.add(e.localId);
          return true;
        },
        stmt: (st) => {
          if ((st.kind === "assign" || st.kind === "forOf") && candidates.has(st.localId))
            blocked.add(st.localId);
          return true;
        },
      });
      continue;
    }
    scanBindingCosts(fn, candidates, blocked, producer, results.has(fn.name), storesJs, jsParams, {
      sources: new Set(),
      jsDynArguments,
    });
  }
  const promoted = new Set<string>();
  for (const [id, cost] of candidates)
    if (!blocked.has(id) && cost.saved > cost.added) promoted.add(id);
  return promoted;
}

/** Adds to `candidates` the boxing a jsval binding saves and adds in `fn`,
 * and to `blocked` the candidates `fn` references other than by reads and
 * plain writes. `sources` are bindings taken as jsvals: writing one to a
 * candidate saves a box, and the copy reads it as a jsval. With
 * `jsDynArguments`, dynCall and dynInvoke take jsval arguments. */
function scanBindingCosts(
  fn: IrFunction,
  candidates: ReadonlyMap<string, LocalCost>,
  blocked: Set<string>,
  producer: (e: IrExpr) => boolean,
  jsResult: boolean,
  storesJs: (e: IrExpr) => boolean,
  jsParams: ReadonlyMap<string, readonly boolean[]>,
  { sources, jsDynArguments }: { sources: ReadonlySet<string>; jsDynArguments: boolean },
): void {
  const write = (id: string, value: IrExpr | null, weight: number): void => {
    const cost = candidates.get(id);
    if (cost === undefined) return;
    if (value === null) {
      // A declared-only dyn binding is an uninitialized trap (ir/build.ts).
      blocked.add(id);
      return;
    }
    if (
      producer(value) ||
      isImmediateSource(value) ||
      (value.kind === "varRef" && sources.has(value.localId))
    )
      cost.saved += weight;
  };
  /* `js`: the expression is an operand the rewrite turns into a jsval. */
  const expr = (e: IrExpr, js: boolean, weight: number): void => {
    switch (e.kind) {
      case "varRef": {
        const cost = candidates.get(e.localId);
        if (cost !== undefined && !js) cost.added += weight;
        return;
      }
      case "assignExpr":
        write(e.localId, e.value, weight);
        expr(e.value, sources.has(e.localId), weight);
        // The assignment's own value is read where it stands.
        if (!js && candidates.has(e.localId)) candidates.get(e.localId)!.added += weight;
        return;
      case "libCall":
        if (isProducerCall(e) || isConsumerCall(e)) {
          for (const arg of e.args) expr(arg, arg.type.kind === "dyn", weight);
          return;
        }
        break;
      case "dynCheck":
        if (e.type.kind === "f64" && e.preserveRefs === undefined) {
          expr(e.value, true, weight);
          return;
        }
        break;
      case "toBool":
        if (e.operand.type.kind === "dyn") {
          expr(e.operand, true, weight);
          return;
        }
        break;
      case "call": {
        // An inline-cache store takes its value as a jsval (S4).
        if (storesJs(e)) {
          expr(e.args[0]!, false, weight);
          expr(e.args[1]!, true, weight);
          return;
        }
        const js = jsParams.get(e.callee);
        if (js !== undefined) {
          e.args.forEach((arg, i) => expr(arg, js[i] === true, weight));
          return;
        }
        break;
      }
      case "dynCall":
      case "dynInvoke": {
        const jsArgs = jsDynArguments && (e.kind === "dynInvoke" || e.spreads === undefined);
        for (const arg of e.args) expr(arg, jsArgs, weight);
        if (e.kind === "dynInvoke") expr(e.recv, false, weight);
        else {
          expr(e.callee, false, weight);
          if (e.receiver !== undefined) expr(e.receiver, false, weight);
        }
        if (e.calleeNameValue !== undefined) expr(e.calleeNameValue, false, weight);
        return;
      }
      default:
        break;
    }
    blockExprReferences(e);
    everyExprChild(
      e,
      (child) => {
        expr(child, false, weight);
        return true;
      },
      (s) => {
        stmt(s, weight);
        return true;
      },
    );
  };
  /** Locals referenced other than by reads and plain writes (increments,
   * loop and catch bindings, rethrows, closure captures) keep dyn. */
  const blockExprReferences = (e: IrExpr): void => {
    if (e.kind === "incDec") blocked.add(e.localId);
    else if (e.kind === "closure") for (const id of e.captures) blocked.add(id);
    else if (e.kind === "classRef") for (const id of e.captures ?? []) blocked.add(id);
  };
  const blockStmtReferences = (s: IrStmt): void => {
    if (s.kind === "forOf" || s.kind === "rethrow") blocked.add(s.localId);
    else if (s.kind === "tryCatch" && s.catchLocalId !== null) blocked.add(s.catchLocalId);
  };
  const stmt = (s: IrStmt, weight: number): void => {
    switch (s.kind) {
      case "exprStmt":
        // A discarded sequence result (a compound assignment statement)
        // is never boxed.
        if (discardedSequence(s.expr)) {
          for (const inner of s.expr.stmts) stmt(inner, weight);
          expr(s.expr.result, true, weight);
          return;
        }
        blockStmtReferences(s);
        expr(s.expr, false, weight);
        return;
      case "return":
        if (s.value !== null) expr(s.value, jsResult && s.value.type.kind === "dyn", weight);
        return;
      case "varDecl":
        write(s.localId, s.init, weight);
        if (s.init !== null) expr(s.init, sources.has(s.localId), weight);
        return;
      case "assign":
        if (s.initializes !== undefined) blocked.add(s.localId);
        write(s.localId, s.value, weight);
        expr(s.value, sources.has(s.localId), weight);
        return;
      case "while":
      case "doWhile":
      case "for":
      case "forOf": {
        blockStmtReferences(s);
        const inner = Math.min(weight * LOOP_WEIGHT, MAX_WEIGHT);
        everyStmtChild(
          s,
          (child) => {
            expr(child, false, inner);
            return true;
          },
          (child) => {
            stmt(child, inner);
            return true;
          },
        );
        return;
      }
      default:
        blockStmtReferences(s);
        everyStmtChild(
          s,
          (child) => {
            expr(child, false, weight);
            return true;
          },
          (child) => {
            stmt(child, weight);
            return true;
          },
        );
    }
  };
  for (const s of fn.body) stmt(s, 1);
}

/** A statement-level sequence whose result nothing reads. */
function discardedSequence(e: IrExpr): e is Extract<IrExpr, { kind: "seqExpr" }> {
  return e.kind === "seqExpr" && e.generatorDelegate === undefined && e.diverges === undefined;
}

/* ── the rewrite ─────────────────────────────────────────────────────── */

function promoteFunction(
  fn: IrFunction,
  results: ReadonlySet<string>,
  params: ReadonlyMap<string, readonly boolean[]>,
  storesJs: (e: IrExpr) => boolean,
  globals: ReadonlySet<string>,
  jsDynArguments: boolean,
): boolean {
  const resultCall = (e: IrExpr): boolean => e.kind === "call" && results.has(e.callee);
  const operatorCall = (e: IrExpr): boolean => isProducerCall(e);
  const ownParams = params.get(fn.name);
  // The function's own jsval parameters are sources for the copies the
  // rewrite makes jsval locals.
  const own = new Map<string, number>();
  fn.params.forEach((p, i) => {
    if (ownParams?.[i] === true) own.set(p.localId, 1);
  });
  const promoted = promotableLocals(
    fn,
    (e) => operatorCall(e) || resultCall(e),
    results.has(fn.name),
    storesJs,
    own,
    params,
    jsDynArguments,
    globals,
  );
  for (const id of globals) promoted.add(id);
  fn.params.forEach((p, i) => {
    if (ownParams?.[i] === true) promoted.add(p.localId);
  });
  const ownResult = results.has(fn.name);
  let changed = ownParams !== undefined;
  const producesJs = (e: IrExpr): boolean =>
    operatorCall(e) ||
    resultCall(e) ||
    ((e.kind === "varRef" || e.kind === "assignExpr") && promoted.has(e.localId));
  const libCall = (fn: string, args: IrExpr[], e: IrExpr, type = JSVAL): IrExpr => ({
    kind: "libCall",
    fn: fn as Extract<IrExpr, { kind: "libCall" }>["fn"],
    args,
    type,
    loc: e.loc,
  });
  /** A call's arguments, as jsvals where the callee takes them so. */
  const callArgs = (e: Extract<IrExpr, { kind: "call" }>): IrExpr[] => {
    const js = params.get(e.callee);
    return e.args.map((arg, i) => (js?.[i] === true ? toJs(arg) : rewrite(arg)));
  };
  /** A dyn-typed expression as a jsval. */
  const toJs = (e: IrExpr): IrExpr => {
    changed = true;
    if (e.kind === "call" && results.has(e.callee)) return { ...e, args: callArgs(e), type: JSVAL };
    if (e.kind === "libCall" && Object.hasOwn(PRODUCERS, e.fn)) {
      return libCall(
        PRODUCERS[e.fn]!,
        e.args.map((arg) => (arg.type.kind === "dyn" ? toJs(arg) : rewrite(arg))),
        e,
      );
    }
    if (isImmediateSource(e) && e.kind === "dynFrom") {
      const value = rewrite(e.value);
      return libCall(STATIC_SOURCES[value.type.kind]!, [value], e);
    }
    if (e.kind === "varRef" && promoted.has(e.localId)) return { ...e, type: JSVAL };
    if (e.kind === "assignExpr" && promoted.has(e.localId))
      return { ...e, value: toJs(e.value), type: JSVAL };
    return libCall("js.fromDyn", [rewrite(e)], e);
  };
  /** Any expression, in a position expecting its own type. */
  const rewrite = (e: IrExpr): IrExpr => {
    if (e.kind === "libCall" && Object.hasOwn(CONSUMERS, e.fn)) {
      changed = true;
      return libCall(
        CONSUMERS[e.fn]!,
        e.args.map((arg) => (arg.type.kind === "dyn" ? toJs(arg) : rewrite(arg))),
        e,
        e.type,
      );
    }
    if (
      e.kind === "dynCheck" &&
      e.type.kind === "f64" &&
      e.preserveRefs === undefined &&
      producesJs(e.value)
    )
      return libCall("js.toF64", [toJs(e.value)], e, e.type);
    if (e.kind === "toBool" && e.operand.type.kind === "dyn" && producesJs(e.operand))
      return { ...e, operand: toJs(e.operand) };
    if (e.type.kind === "dyn" && producesJs(e)) return libCall("js.toDyn", [toJs(e)], e, DYN);
    if (e.kind === "call" && params.has(e.callee)) {
      changed = true;
      return { ...e, args: callArgs(e) };
    }
    // A callee with a jsval entry takes the arguments the rewrite computes
    // as jsvals unboxed; the call boxes them for any other callee.
    if (
      jsDynArguments &&
      (e.kind === "dynInvoke" || (e.kind === "dynCall" && e.spreads === undefined))
    ) {
      const args = e.args.map((arg) =>
        producesJs(arg) || isImmediateSource(arg) ? toJs(arg) : rewrite(arg),
      );
      if (e.kind === "dynInvoke") {
        const invoke = { ...e, recv: rewrite(e.recv), args };
        if (e.calleeNameValue !== undefined) invoke.calleeNameValue = rewrite(e.calleeNameValue);
        return invoke;
      }
      const call = { ...e, callee: rewrite(e.callee), args };
      if (e.receiver !== undefined) call.receiver = rewrite(e.receiver);
      if (e.calleeNameValue !== undefined) call.calleeNameValue = rewrite(e.calleeNameValue);
      return call;
    }
    return mapExprChildren(e, rewrite, rewriteStmt);
  };
  const rewriteStmt = (s: IrStmt): IrStmt => {
    if (s.kind === "return" && ownResult && s.value !== null) return { ...s, value: toJs(s.value) };
    // A discarded result stays a jsval: nothing boxes it.
    if (s.kind === "exprStmt" && producesJs(s.expr)) return { ...s, expr: toJs(s.expr) };
    if (s.kind === "exprStmt" && discardedSequence(s.expr) && producesJs(s.expr.result)) {
      const result = toJs(s.expr.result);
      return {
        ...s,
        expr: { ...s.expr, stmts: s.expr.stmts.map(rewriteStmt), result, type: result.type },
      };
    }
    if (s.kind === "varDecl" && promoted.has(s.localId) && s.init !== null)
      return { ...s, init: toJs(s.init) };
    if (s.kind === "assign" && promoted.has(s.localId)) return { ...s, value: toJs(s.value) };
    return mapStmtChildren(s, rewrite, rewriteStmt);
  };
  const body = fn.body.map(rewriteStmt);
  if (!changed) return false;
  fn.body = body;
  for (const local of fn.locals) if (promoted.has(local.id)) local.type = JSVAL;
  for (const p of fn.params) if (promoted.has(p.localId)) p.type = JSVAL;
  return true;
}
