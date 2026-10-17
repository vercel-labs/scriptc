import type { IrContracts, IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { exprFunctionReference, moduleFunctionReferences } from "./function-references.js";
import { reparseExpr, reparseStmt } from "./serialize.js";
import { everyStmtList, mapExprChildren, mapStmtChildren } from "./traverse.js";

/** Largest body (IR nodes) that is copied per callback target. */
const MAX_FUNCTION_NODES = 300;
/** Copies of one function, its own and those of closures it creates. */
const MAX_COPIES_PER_FUNCTION = 4;
/** Module-wide copied nodes: at least this many, or a quarter of the module. */
const MIN_COPIED_NODES = 6000;
const COPIED_NODE_FRACTION = 0.25;

/** Locals each function writes after declaring them, including bindings a
 * closure it creates writes through its environment (and transitively the
 * closures those create). A parameter or capture absent from its function's
 * set holds the value it entered with for the whole call. */
export function writtenLocals(mod: IrModule): Map<string, Set<string>> {
  return rebindings(mod).written;
}

function rebindings(mod: IrModule): {
  written: Map<string, Set<string>>;
  /** Bindings of each function that a closure it creates writes. */
  closureWritten: Map<string, Set<string>>;
} {
  const written = new Map<string, Set<string>>();
  const closureWritten = new Map<string, Set<string>>();
  const sites: { owner: string; fnName: string; captures: string[] }[] = [];
  for (const fn of mod.functions) {
    const ids = new Set<string>();
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        if (stmt.kind === "assign" || stmt.kind === "forOf") ids.add(stmt.localId);
        if (stmt.kind === "tryCatch" && stmt.catchLocalId !== null) ids.add(stmt.catchLocalId);
        return true;
      },
      expr: (expr) => {
        if (expr.kind === "assignExpr" || expr.kind === "incDec") ids.add(expr.localId);
        if (expr.kind === "closure" && expr.captures.length)
          sites.push({ owner: fn.name, fnName: expr.fnName, captures: expr.captures });
        return true;
      },
    });
    written.set(fn.name, ids);
  }
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  for (let changed = true; changed;) {
    changed = false;
    for (const site of sites) {
      const lifted = functions.get(site.fnName)?.captures;
      const inner = written.get(site.fnName);
      const outer = written.get(site.owner);
      if (!lifted || !inner || !outer) continue;
      site.captures.forEach((id, index) => {
        const capture = lifted[index];
        if (capture && inner.has(capture.localId) && !outer.has(id)) {
          outer.add(id);
          const set = closureWritten.get(site.owner) ?? new Set<string>();
          set.add(id);
          closureWritten.set(site.owner, set);
          changed = true;
        }
      });
    }
  }
  return { written, closureWritten };
}

function countNodes(fn: IrFunction): number {
  let count = 0;
  everyStmtList(fn.body, {
    stmt: () => ++count <= MAX_FUNCTION_NODES,
    expr: () => ++count <= MAX_FUNCTION_NODES,
  });
  return count;
}

interface Candidate {
  fn: IrFunction;
  /** Indexes of callback parameters the body never rebinds. */
  slots: number[];
  nodes: number;
}

/** Copies of callback-taking helpers per known callback target.
 *
 * A helper such as `mapInPlace(values, f)` or `sortBy(items, key)` called
 * from several sites with different callbacks has one body, so each call
 * of `f` inside it stays indirect: the backend's constant-callback analysis
 * (backend/llvm/constant-callbacks.ts) needs every incoming call to agree.
 * Here each direct call whose callback arguments resolve to known functions
 * (a closure literal, a declared function, a single-definition binding, or
 * a parameter of an enclosing copy) calls a copy of the helper made for
 * exactly that tuple of targets; every incoming call of a copy then agrees,
 * and LLVM sees direct calls it can inline.
 *
 * A copy is the original body verbatim under a new name: the same
 * parameters, locals, source name (stack frames), evaluation order,
 * exceptions and ownership. Callers still evaluate and pass the callback
 * value, and the backend still checks its code pointer before entering the
 * known target, so the choice of copy never affects behavior. Inside a
 * copy, calls that forward a specialized callback (recursion, helper
 * chains) call the copy for the same targets, and closures the copy creates
 * over a specialized callback get copies of their own, so a callback
 * captured by an inner arrow (`items.reduce((s, x) => s + key(x), 0)`)
 * resolves as well. The original stays for every other entry (unknown
 * callbacks, function values, exports) and is dropped once nothing can
 * reach it.
 *
 * Code growth is bounded: bodies above MAX_FUNCTION_NODES are never
 * copied, each function gets at most MAX_COPIES_PER_FUNCTION copies, and
 * the module's copied nodes stay within a fixed share of its size. A helper
 * whose direct calls all pass the same targets keeps its single body, which
 * the backend already specializes. */
export function specializeCallbackCalls(
  mod: IrModule,
  symbolName: (name: string) => string = (name) => name,
): IrModule {
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const { written, closureWritten } = rebindings(mod);
  const copies = new Map<string, IrFunction>();
  const candidates = new Map<string, Candidate>();
  let totalNodes = 0;
  for (const fn of mod.functions) {
    const nodes = countNodes(fn);
    totalNodes += nodes;
    if (
      !(fn.ownsPrototype || fn.name.startsWith("%arr.")) ||
      fn.name === mod.entry ||
      fn.async ||
      fn.generator !== undefined ||
      fn.captures !== undefined ||
      fn.classCaptures?.length ||
      fn.fastRead !== undefined ||
      fn.speculativeDispatch ||
      nodes > MAX_FUNCTION_NODES
    )
      continue;
    const rebound = written.get(fn.name)!;
    const slots: number[] = [];
    fn.params.forEach((param, index) => {
      if (param.type.kind === "func" && !rebound.has(param.localId)) slots.push(index);
    });
    if (slots.length) candidates.set(fn.name, { fn, slots, nodes });
  }
  if (!candidates.size) return mod;

  // Function values, exports, entry points and methods: an original
  // reachable this way stays even when every direct call moves to a copy.
  const referenced = new Set<string>(moduleFunctionReferences(mod));
  for (const cls of mod.classes ?? [])
    for (const method of ["constructor", ...(cls.methods ?? [])])
      referenced.add(`%${cls.name}.${method}`);
  // Single definitions of function-typed locals and globals.
  const definitions = new Map<string, Map<string, IrExpr>>();
  const globalIds = new Set(mod.globals?.map((global) => global.id));
  const globalWrites = new Map<string, IrExpr[]>();
  for (const fn of mod.functions) {
    const values = new Map<string, IrExpr[]>();
    const counts = new Map<string, number>();
    const record = (id: string, value: IrExpr | null, weight: number): void => {
      counts.set(id, (counts.get(id) ?? 0) + weight);
      if (value) values.set(id, [...(values.get(id) ?? []), value]);
    };
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        if (stmt.kind === "varDecl") record(stmt.localId, stmt.init, stmt.init ? 1 : 0);
        if (stmt.kind === "assign") {
          if (globalIds.has(stmt.localId))
            globalWrites.set(stmt.localId, [...(globalWrites.get(stmt.localId) ?? []), stmt.value]);
          record(stmt.localId, stmt.value, 1);
        }
        if (stmt.kind === "forOf") record(stmt.localId, null, 2);
        if (stmt.kind === "tryCatch" && stmt.catchLocalId !== null)
          record(stmt.catchLocalId, null, 2);
        return true;
      },
      expr: (expr) => {
        if (expr.kind === "assignExpr" || expr.kind === "incDec") {
          record(expr.localId, null, 2);
          if (globalIds.has(expr.localId)) globalWrites.set(expr.localId, []);
        }
        const name = exprFunctionReference(expr);
        if (name !== undefined) referenced.add(name);
        return true;
      },
    });
    const single = new Map<string, IrExpr>();
    const locals = new Set(fn.locals.map((local) => local.id));
    const shared = closureWritten.get(fn.name);
    for (const [id, list] of values)
      if (
        locals.has(id) &&
        counts.get(id) === 1 &&
        list.length === 1 &&
        list[0]!.kind === "closure" &&
        !shared?.has(id)
      )
        single.set(id, list[0]!);
    definitions.set(fn.name, single);
  }
  const globalDefinitions = new Map<string, IrExpr>();
  for (const global of mod.globals ?? [])
    if (global.type.kind === "func" && !global.mutable) {
      const list = globalWrites.get(global.id);
      if (list?.length === 1 && list[0]!.kind === "closure")
        globalDefinitions.set(global.id, list[0]!);
    }

  /** A callback target: a function a closure value is created over. */
  function target(value: IrExpr): string | null {
    if (value.kind !== "closure" || value.adapts) return null;
    const fn = functions.get(value.fnName) ?? copies.get(value.fnName);
    return fn && !fn.async && fn.generator === undefined ? value.fnName : null;
  }
  function resolve(owner: IrFunction, context: ReadonlyMap<string, string>, value: IrExpr) {
    if (value.kind === "closure") return target(value);
    if (value.kind !== "varRef") return null;
    const known = context.get(value.localId);
    if (known !== undefined) return known;
    const local = definitions.get(owner.name)?.get(value.localId);
    if (local) return target(local);
    const global = globalDefinitions.get(value.localId);
    return global && !owner.locals.some((l) => l.id === value.localId) ? target(global) : null;
  }
  /** Whether a call passes a callback its (copied) caller specializes. */
  function forwardsContext(
    context: ReadonlyMap<string, string>,
    call: IrExpr & { kind: "call" },
    candidate: Candidate,
  ): boolean {
    return candidate.slots.some((index) => {
      const arg = call.args[index];
      return arg?.kind === "varRef" && context.has(arg.localId);
    });
  }
  /** The targets a call passes in its callee's callback slots ("" when
   * none resolves), or null for a call that forwards its own callbacks. */
  function callKey(
    owner: IrFunction,
    context: ReadonlyMap<string, string>,
    call: IrExpr & { kind: "call" },
    candidate: Candidate,
  ): string | null {
    const self =
      context.size === 0 &&
      owner.name === candidate.fn.name &&
      candidate.slots.every((index) => {
        const arg = call.args[index];
        return arg?.kind === "varRef" && arg.localId === owner.params[index]!.localId;
      });
    if (self) return null;
    const targets = candidate.slots.map((index) => {
      const arg = call.args[index];
      return arg ? resolve(owner, context, arg) : null;
    });
    return targets.some((name) => name !== null)
      ? targets.map((name) => name ?? "").join("\0")
      : "";
  }

  // Which originals specialize their direct calls from ordinary bodies:
  // those whose calls pass several target tuples, or one tuple next to
  // unknown callbacks or function-value entries.
  const keysOf = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind !== "call") return true;
        const candidate = candidates.get(expr.callee);
        if (!candidate) return true;
        const key = callKey(fn, new Map(), expr, candidate);
        if (key === "") unknown.add(expr.callee);
        else if (key !== null) {
          const keys = keysOf.get(expr.callee) ?? new Set<string>();
          keys.add(key);
          keysOf.set(expr.callee, keys);
        }
        return true;
      },
    });
  const specialized = new Set<string>();
  for (const [name, keys] of keysOf)
    if (keys.size > 1 || unknown.has(name) || referenced.has(name)) specialized.add(name);
  if (!specialized.size) return mod;

  const names = new Set(mod.functions.map((fn) => symbolName(fn.name)));
  const budget = Math.max(MIN_COPIED_NODES, Math.floor(totalNodes * COPIED_NODE_FRACTION));
  let copiedNodes = 0;
  const perOrigin = new Map<string, number>();
  const memo = new Map<string, string>();
  const pending: {
    fn: IrFunction;
    source: IrFunction;
    context: Map<string, string>;
    lineage: ReadonlySet<string>;
  }[] = [];
  const sourceOf = new Map<string, string>();
  /** The copy of `source` for `key`, made on first use. `lineage` names
   * the sources of the copies whose bodies led here: a copy never makes a
   * new copy of its own source, so recursion that passes a new closure on
   * each level (`f(x, (v) => g(v))` inside `f`) calls the original instead
   * of copying once per level. */
  function copy(
    source: IrFunction,
    context: Map<string, string>,
    key: string,
    lineage: ReadonlySet<string>,
  ): string | null {
    const memoKey = `${source.name}\0${key}`;
    const existing = memo.get(memoKey);
    if (existing !== undefined) return existing;
    if (lineage.has(source.name)) return null;
    const nodes = candidates.get(source.name)?.nodes ?? countNodes(source);
    const count = perOrigin.get(source.name) ?? 0;
    if (
      nodes > MAX_FUNCTION_NODES ||
      count >= MAX_COPIES_PER_FUNCTION ||
      copiedNodes + nodes > budget
    )
      return null;
    perOrigin.set(source.name, count + 1);
    copiedNodes += nodes;
    let name = `${source.name}.cb${count}`;
    while (names.has(symbolName(name))) name += "_";
    names.add(symbolName(name));
    memo.set(memoKey, name);
    sourceOf.set(name, source.name);
    const fn: IrFunction = {
      ...source,
      name,
      params: source.params.map((param) => ({ ...param! })),
      locals: source.locals.map((local) => ({ ...local! })),
    };
    if (source.captures) fn.captures = source.captures.map((c) => ({ ...c! }));
    copies.set(name, fn);
    pending.push({ fn, source, context, lineage: new Set([...lineage, source.name]) });
    return name;
  }

  /** Rewrite `owner`'s body for a copy specialized to `context` (fresh
   * nodes throughout), or in place for the original (empty context). */
  function rewriteBody(
    owner: IrFunction,
    context: Map<string, string>,
    lineage: ReadonlySet<string>,
    fresh: boolean,
  ): IrStmt[] {
    const ownWritten = written.get(owner.name)!;
    const expr = (node: IrExpr): IrExpr => {
      // Nodes with children come back copied; a copy re-reads its leaves.
      let next = mapExprChildren(node, expr, stmt);
      if (fresh && next === node) next = reparseExpr(node);
      if (next.kind === "call") {
        const candidate = candidates.get(next.callee);
        if (
          !candidate ||
          !(specialized.has(next.callee) || forwardsContext(context, next, candidate))
        )
          return next;
        const key = callKey(owner, context, next, candidate);
        if (!key) return next;
        const targets = key.split("\0");
        const calleeContext = new Map<string, string>();
        candidate.slots.forEach((index, i) => {
          if (targets[i]) calleeContext.set(candidate.fn.params[index]!.localId, targets[i]!);
        });
        const name = copy(candidate.fn, calleeContext, key, lineage);
        return name ? { ...next, callee: name } : next;
      }
      if (next.kind === "closure" && context.size && !next.adapts) {
        const lifted = functions.get(next.fnName);
        if (!lifted?.captures || lifted.async || lifted.generator !== undefined) return next;
        const liftedWritten = written.get(lifted.name)!;
        const inner = new Map<string, string>();
        next.captures.forEach((id, index) => {
          const known = context.get(id);
          const capture = lifted.captures![index];
          if (known && capture && !ownWritten.has(id) && !liftedWritten.has(capture.localId))
            inner.set(capture.localId, known);
        });
        if (!inner.size) return next;
        const key = [...inner].map(([id, name]) => `${id}=${name}`).join("\0");
        const name = copy(lifted, inner, key, lineage);
        return name ? { ...next, fnName: name } : next;
      }
      return next;
    };
    const stmt = (node: IrStmt): IrStmt => {
      const next = mapStmtChildren(node, expr, stmt);
      return fresh && next === node ? reparseStmt(node) : next;
    };
    return owner.body.map(stmt);
  }

  const functionsOut = mod.functions.map((fn) => {
    // Most bodies call no specialized original; keep their nodes.
    const untouched = everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => expr.kind !== "call" || !specialized.has(expr.callee),
    });
    return untouched ? fn : { ...fn, body: rewriteBody(fn, new Map(), new Set(), false) };
  });
  for (let i = 0; i < pending.length; i++) {
    const { fn, source, context, lineage } = pending[i]!;
    fn.body = rewriteBody(source, context, lineage, true);
    functionsOut.push(fn);
  }
  if (!copies.size) return mod;

  // Drop originals no remaining code reaches: every direct call moved to a
  // copy and nothing names them as a value.
  const callers = new Map<string, Set<string>>();
  for (const fn of functionsOut)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "call" && specialized.has(expr.callee)) {
          const set = callers.get(expr.callee) ?? new Set<string>();
          set.add(fn.name);
          callers.set(expr.callee, set);
        }
        if (expr.kind === "closure" && specialized.has(expr.fnName)) referenced.add(expr.fnName);
        return true;
      },
    });
  const live = new Set<string>();
  const work: string[] = [];
  for (const fn of functionsOut)
    if (!specialized.has(fn.name) || referenced.has(fn.name)) {
      live.add(fn.name);
      work.push(fn.name);
    }
  const calls = new Map<string, string[]>();
  for (const [callee, set] of callers)
    for (const caller of set) calls.set(caller, [...(calls.get(caller) ?? []), callee]);
  while (work.length) {
    const name = work.pop()!;
    for (const callee of calls.get(name) ?? [])
      if (!live.has(callee)) {
        live.add(callee);
        work.push(callee);
      }
  }
  const out: IrModule = { ...mod, functions: functionsOut.filter((fn) => live.has(fn.name)) };
  if (mod.contracts) out.contracts = copyContracts(mod.contracts, sourceOf);
  return out;
}

/** Contract facts keyed by function name hold for each copy of that body. */
function copyContracts(contracts: IrContracts, sourceOf: ReadonlyMap<string, string>): IrContracts {
  const sources = new Map<string, string[]>();
  for (const [copy, source] of sourceOf) {
    const list = sources.get(source);
    if (list) list.push(copy);
    else sources.set(source, [copy]);
  }
  const keyed = (list: string[]): string[] => {
    const out = [...list];
    for (const entry of list) {
      const split = entry.indexOf("\0");
      const fn = split < 0 ? entry : entry.slice(0, split);
      for (const copy of sources.get(fn) ?? [])
        out.push(split < 0 ? copy : copy + entry.slice(split));
    }
    return out;
  };
  const out: IrContracts = { ...contracts };
  if (contracts.int32Params) out.int32Params = keyed(contracts.int32Params);
  if (contracts.int32Returns) out.int32Returns = keyed(contracts.int32Returns);
  if (contracts.int32Locals) out.int32Locals = keyed(contracts.int32Locals);
  if (contracts.noThrow) out.noThrow = keyed(contracts.noThrow);
  return out;
}
