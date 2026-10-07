import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";

/** Closed direct-call consumers can devirtualize a callback when every
 * incoming call supplies the same function. Keep its evaluated environment,
 * arguments and ordinary ownership; only the loaded code pointer changes.
 * Escaped, exported, recursive forwarding and unknown targets stay indirect. */
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
          fn.ownsPrototype &&
          !fn.async &&
          !fn.generator &&
          !fn.captures &&
          !fn.classCaptures &&
          fn.params.some((param) => param.type.kind === "func"),
      )
      .map((fn) => fn.name),
  );
  const globals = new Map<string, IrExpr>();
  const writes = new Set<string>();
  const escaped = new Set<string>([
    mod.entry,
    ...(mod.lib?.exports.map((entry) => entry.fnName) ?? []),
  ]);
  for (const cls of mod.classes ?? [])
    for (const method of ["constructor", ...(cls.methods ?? [])])
      escaped.add(`%${cls.name}.${method}`);
  // Metadata and non-call expression references can expose an entry to a
  // generated adapter or runtime callback. A direct-call census cannot
  // specialize those entries. Conservatively reject every such reference,
  // including future metadata that names a function.
  function externalReferences(value: unknown): void {
    if (typeof value === "string") {
      if (functions.has(value)) escaped.add(value);
    } else if (Array.isArray(value)) value.forEach(externalReferences);
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      for (const key in object) {
        if (object["kind"] === "call" && key === "callee") continue;
        externalReferences(object[key]);
      }
    }
  }
  const { functions: _functions, ...metadata } = mod;
  externalReferences(metadata);
  const incoming = new Map<string, { owner: string; args: IrExpr[] }[]>();
  for (const fn of mod.functions) {
    const defs = new Map<string, IrExpr>();
    const callees = new Set<string>();
    const stable = lifetimes.bindings.get(fn.name);
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        if (stmt.kind === "varDecl" && stmt.init?.type.kind === "func" && stable?.has(stmt.localId))
          defs.set(stmt.localId, stmt.init);
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
        if (expr.kind === "closure") escaped.add(expr.fnName);
        if ((expr.kind === "assignExpr" || expr.kind === "incDec") && globalIds.has(expr.localId))
          writes.add(expr.localId);
        return true;
      },
    });
    externalReferences(fn.body);
    definitions.set(fn.name, defs);
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
    if (value.kind !== "varRef" || seen.has(value.localId)) return null;
    seen.add(value.localId);
    // Resolve a global's initializer in global scope. Its declaring
    // function's local names must never resolve in a later caller.
    if (seen.size > 64) return null;
    if (owner !== null && localIds.get(owner)?.has(value.localId)) {
      const next = definitions.get(owner)?.get(value.localId);
      return next ? resolve(owner, next, seen) : null;
    }
    const next = globalIds.has(value.localId) ? globals.get(value.localId) : undefined;
    return next ? resolve(null, next, seen) : null;
  };
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
    for (const id of needed) {
      if (localIds.get(fn.name)?.has(id)) {
        const value = definitions.get(fn.name)?.get(id);
        const target = value ? resolve(fn.name, value) : null;
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
            !lifetimes.borrowed.get(fn.name)?.has(index)
          )
            return;
          let target: string | null = null;
          for (const call of calls) {
            const value = call.args[index];
            const next = value ? resolve(call.owner, value) : null;
            if (!next || (target && target !== next)) {
              target = null;
              break;
            }
            target = next;
          }
          if (target) targets.set(param.localId, target);
        });
    }
    if (targets.size) result.set(fn.name, targets);
  }
  return result;
}

/** A known callback that cannot observe ambient this needs no receiver
 * stack bracket. Follow direct calls conservatively; unknown indirect calls
 * and all runtime operations except scalar arithmetic stay on the ABI path. */
export function callbackIgnoresReceiver(fn: IrFunction): boolean {
  if (fn.async || fn.generator) return false;
  return everyStmtList(fn.body, {
    stmt: (stmt) => {
      switch (stmt.kind) {
        case "varDecl":
        case "assign":
        case "exprStmt":
        case "return":
        case "if":
        case "while":
        case "doWhile":
        case "for":
        case "switch":
        case "block":
        case "break":
        case "continue":
          return true;
        default:
          return false;
      }
    },
    expr: (expr) => {
      switch (expr.kind) {
        case "numLit":
        case "boolLit":
        case "strLit":
        case "unitLit":
        case "varRef":
        case "bin":
        case "unary":
        case "logical":
        case "ternary":
        case "seqExpr":
        case "incDec":
        case "assignExpr":
        case "toBool":
          return true;
        default:
          return false;
      }
    },
  });
}
