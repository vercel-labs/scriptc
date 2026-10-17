import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import { exprFunctionReference, moduleFunctionReferences } from "../../ir/function-references.js";
import { writtenLocals } from "../../ir/callback-specialization.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";

/** Closed direct-call consumers can devirtualize a callback when every
 * incoming call supplies the same function. Keep its evaluated environment,
 * arguments and ordinary ownership; only the loaded code pointer changes.
 * A call that forwards the consumer's own unchanged parameter (recursion)
 * agrees with the others; a parameter forwarded to another consumer, or
 * captured unchanged by a closure, resolves through the incoming calls of
 * the function that declares it. Escaped, exported, mutually recursive
 * forwarding and unknown targets stay indirect. */
export function findConstantCallbacks(
  mod: IrModule,
  lifetimes: CallLifetimes,
): Map<string, Map<string, string>> {
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const definitions = new Map<string, Map<string, IrExpr>>();
  const indirectCallees = new Map<string, Set<string>>();
  const localIds = new Map(
    mod.functions.map((fn) => [fn.name, new Set(fn.locals.map((local) => local.id))]),
  );
  const globalIds = new Set(
    mod.globals?.filter((global) => global.type.kind === "func").map((global) => global.id),
  );
  const consumers = new Set(
    mod.functions
      .filter(
        (fn) =>
          // Authored declarations, plus the frontend's synthetic array
          // HOF loops (`%arr.<method>.<n>`): those are plain direct-call
          // functions, and a literal callback gets a helper of its own.
          // Generator declarations are entered through their spawn wrapper,
          // which moves the same arguments into the generator's frame.
          (fn.ownsPrototype || fn.name.startsWith("%arr.") || fn.generator !== undefined) &&
          (!fn.async || fn.generator !== undefined) &&
          !fn.captures &&
          !fn.classCaptures &&
          fn.params.some((param) => param.type.kind === "func"),
      )
      .map((fn) => fn.name),
  );
  const globals = new Map<string, IrExpr>();
  const writes = new Set<string>();
  // Parameters and captures each function (or a closure sharing the
  // binding) writes after entry.
  const rebinds = writtenLocals(mod);
  // A function named anywhere but as a direct call's callee can be entered
  // by a generated adapter or the runtime, which a direct-call census cannot
  // specialize: the entry, exports, class helpers and methods here, and
  // closures and retag helpers in the bodies (collected by the walk below).
  const escaped = new Set<string>(moduleFunctionReferences(mod));
  for (const cls of mod.classes ?? [])
    for (const method of ["constructor", ...(cls.methods ?? [])])
      escaped.add(`%${cls.name}.${method}`);
  const incoming = new Map<string, { owner: string; args: IrExpr[] }[]>();
  // Where each lifted function's environment is created, for resolving its
  // immutable captures in the creating scope.
  const closureSites = new Map<string, { owner: string; captures: string[] }[]>();
  // The initializer of each immutable function-typed local declared once:
  // its only write, even when a capture box (not a stable slot) holds it.
  const constDefinitions = new Map<string, Map<string, IrExpr | null>>();
  for (const fn of mod.functions) {
    const defs = new Map<string, IrExpr>();
    const consts = new Map<string, IrExpr | null>();
    const immutable = new Set(
      fn.locals.filter((local) => !local.mutable && local.type.kind === "func").map((l) => l.id),
    );
    const callees = new Set<string>();
    const stable = lifetimes.bindings.get(fn.name);
    // A hoisted function declaration binds its box with `varDecl f null`
    // and fills it with one `assign f = closure`: with no other write, that
    // value is the binding's only definition.
    const hoisted = new Set(
      fn.locals
        .filter((local) => local.mutable && local.type.kind === "func")
        .map((local) => local.id),
    );
    const emptyDecls = new Map<string, number>();
    const assigned = new Map<string, IrExpr[]>();
    const rebound = new Set<string>();
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        if (stmt.kind === "varDecl" && stmt.init?.type.kind === "func" && stable?.has(stmt.localId))
          defs.set(stmt.localId, stmt.init);
        if (stmt.kind === "varDecl" && immutable.has(stmt.localId))
          consts.set(stmt.localId, consts.has(stmt.localId) ? null : stmt.init);
        if (stmt.kind === "varDecl" && hoisted.has(stmt.localId)) {
          if (stmt.init !== null) rebound.add(stmt.localId);
          emptyDecls.set(stmt.localId, (emptyDecls.get(stmt.localId) ?? 0) + 1);
        }
        if (stmt.kind === "assign" && hoisted.has(stmt.localId)) {
          const values = assigned.get(stmt.localId) ?? [];
          values.push(stmt.value);
          assigned.set(stmt.localId, values);
        }
        if (stmt.kind === "forOf" || stmt.kind === "rethrow") rebound.add(stmt.localId);
        if (stmt.kind === "tryCatch" && stmt.catchLocalId !== null) rebound.add(stmt.catchLocalId);
        if (stmt.kind === "assign") {
          if (globalIds.has(stmt.localId)) {
            if (globals.has(stmt.localId)) writes.add(stmt.localId);
            else globals.set(stmt.localId, stmt.value);
          }
        }
        return true;
      },
      expr: (expr) => {
        if (expr.kind === "call" && consumers.has(expr.callee)) {
          const calls = incoming.get(expr.callee) ?? [];
          calls.push({ owner: fn.name, args: expr.args });
          incoming.set(expr.callee, calls);
        }
        if (expr.kind === "callValue" && expr.callee.kind === "varRef")
          callees.add(expr.callee.localId);
        const referenced = exprFunctionReference(expr);
        if (referenced !== undefined) escaped.add(referenced);
        if (expr.kind === "closure") {
          const sites = closureSites.get(expr.fnName) ?? [];
          sites.push({ owner: fn.name, captures: expr.captures });
          closureSites.set(expr.fnName, sites);
        }
        if ((expr.kind === "assignExpr" || expr.kind === "incDec") && globalIds.has(expr.localId))
          writes.add(expr.localId);
        if (expr.kind === "assignExpr" || expr.kind === "incDec") rebound.add(expr.localId);
        return true;
      },
    });
    for (const [id, values] of assigned)
      if (emptyDecls.get(id) === 1 && values.length === 1 && !rebound.has(id))
        consts.set(id, values[0]!);
    definitions.set(fn.name, defs);
    constDefinitions.set(fn.name, consts);
    indirectCallees.set(fn.name, callees);
  }
  for (const id of writes) globals.delete(id);
  const resolve = (
    owner: string | null,
    value: IrExpr,
    seen = new Set<string>(),
  ): string | null => {
    if (value.kind === "closure") {
      const target = functions.get(value.fnName);
      return target && !target.async && !target.generator ? value.fnName : null;
    }
    if (value.kind === "call") {
      // A factory (`compareBy(keys)`, `makeScorer(w)`) whose every return
      // resolves to one function. The emitted direct call still checks the
      // closure's actual code pointer first.
      const factory = functions.get(value.callee);
      const key = `%call:${value.callee}`;
      if (!factory || factory.async || factory.generator || seen.has(key)) return null;
      seen.add(key);
      let target: string | null = null;
      let returns = 0;
      const single = everyStmtList(factory.body, {
        stmt: (stmt) => {
          if (stmt.kind !== "return") return true;
          returns++;
          const next = stmt.value ? resolve(factory.name, stmt.value, seen) : null;
          if (!next || (target !== null && target !== next)) return false;
          target = next;
          return true;
        },
        expr: () => true,
      });
      return single && returns > 0 ? target : null;
    }
    if (value.kind !== "varRef" || seen.has(value.localId)) return null;
    seen.add(value.localId);
    // Resolve a global's initializer in global scope. Its declaring
    // function's local names must never resolve in a later caller.
    if (seen.size > 64) return null;
    if (owner !== null && localIds.get(owner)?.has(value.localId))
      return resolveLocal(owner, value.localId, seen);
    const next = globalIds.has(value.localId) ? globals.get(value.localId) : undefined;
    return next ? resolve(null, next, seen) : null;
  };
  // A local's stable definition, or for an immutable capture the binding it
  // captures at every site that creates this function's environment.
  function resolveLocal(owner: string, id: string, seen: Set<string>): string | null {
    const next = definitions.get(owner)?.get(id);
    if (next) return resolve(owner, next, seen);
    const fn = functions.get(owner);
    const parameter = fn?.params.findIndex((param) => param.localId === id) ?? -1;
    if (fn && parameter >= 0) return parameterTarget(fn, parameter, seen);
    const index = fn?.captures?.findIndex((capture) => capture.localId === id) ?? -1;
    const local = fn?.locals.find((candidate) => candidate.id === id);
    const sites = closureSites.get(owner);
    if (
      index < 0 ||
      !local ||
      (local.mutable && rebinds.get(owner)?.has(id) !== false) ||
      !sites?.length
    )
      return null;
    let target: string | null = null;
    for (const site of sites) {
      const outer = site.captures[index];
      const key = `%capture:${site.owner}:${outer}`;
      if (!outer || seen.has(key) || !localIds.get(site.owner)?.has(outer)) return null;
      seen.add(key);
      const declared = constDefinitions.get(site.owner)?.get(outer);
      const found = declared
        ? resolve(site.owner, declared, seen)
        : resolveLocal(site.owner, outer, seen);
      if (!found || (target !== null && target !== found)) return null;
      target = found;
    }
    return target;
  }
  // The one function every incoming call passes in a consumer's callback
  // parameter that its body never rebinds. Results are cached: helpers
  // forwarding one callback through several calls resolve it once.
  const parameterTargets = new Map<string, string | null>();
  function parameterTarget(fn: IrFunction, index: number, seen: Set<string>): string | null {
    const param = fn.params[index]!;
    const key = `%param:${fn.name}:${index}`;
    const cached = parameterTargets.get(key);
    if (cached !== undefined) return cached;
    if (
      seen.has(key) ||
      param.type.kind !== "func" ||
      !consumers.has(fn.name) ||
      escaped.has(fn.name) ||
      rebinds.get(fn.name)?.has(param.localId) !== false
    )
      return null;
    seen.add(key);
    const calls = incoming.get(fn.name) ?? [];
    let target: string | null = null;
    for (const call of calls) {
      const value = call.args[index];
      if (call.owner === fn.name && value?.kind === "varRef" && value.localId === param.localId)
        continue;
      const next = value ? resolve(call.owner, value, new Set(seen)) : null;
      if (!next || (target && target !== next)) {
        target = null;
        break;
      }
      target = next;
    }
    parameterTargets.set(key, target);
    return target;
  }
  // Global targets are module facts. Resolve them once, and copy only
  // entries actually used as indirect callees in each body. A module-wide
  // global/function cross product would dominate large-source emission.
  const globalTargets = new Map<string, string>();
  for (const [id, value] of globals) {
    const target = resolve(null, value);
    if (target) globalTargets.set(id, target);
  }
  const result = new Map<string, Map<string, string>>();
  for (const fn of mod.functions) {
    const needed = indirectCallees.get(fn.name)!;
    if (!needed.size) continue;
    const targets = new Map<string, string>();
    const params = new Set(fn.params.map((param) => param.localId));
    for (const id of needed) {
      // A parameter called in its own body resolves below, only where the
      // body borrows it.
      if (params.has(id)) continue;
      if (localIds.get(fn.name)?.has(id)) {
        const target = resolveLocal(fn.name, id, new Set());
        if (target) targets.set(id, target);
      } else {
        const target = globalTargets.get(id);
        if (target) targets.set(id, target);
      }
    }
    if (consumers.has(fn.name) && !escaped.has(fn.name)) {
      const calls = incoming.get(fn.name);
      if (calls?.length)
        fn.params.forEach((param, index) => {
          if (
            !needed.has(param.localId) ||
            param.type.kind !== "func" ||
            !(fn.generator !== undefined
              ? lifetimes.generatorParameters.get(fn.name)?.has(param.localId)
              : lifetimes.borrowed.get(fn.name)?.has(index))
          )
            return;
          const target = parameterTarget(fn, index, new Set());
          if (target) targets.set(param.localId, target);
        });
    }
    if (targets.size) result.set(fn.name, targets);
  }
  return result;
}

export { AmbientReceiverReaders, callbackIgnoresReceiver } from "../../ir/receiver-readers.js";
