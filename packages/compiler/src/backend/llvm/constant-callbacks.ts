import { isBorrowSafeMath } from "../../ir/analysis.js";
import type { IrExpr, IrFunction, IrLibFn, IrModule, IrStmt } from "../../ir/ir.js";
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
          // Authored declarations, plus the frontend's synthetic array
          // HOF loops (`%arr.<method>.<n>`): those are plain direct-call
          // functions, and a literal callback gets a helper of its own.
          (fn.ownsPrototype || fn.name.startsWith("%arr.")) &&
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
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        if (stmt.kind === "varDecl" && stmt.init?.type.kind === "func" && stable?.has(stmt.localId))
          defs.set(stmt.localId, stmt.init);
        if (stmt.kind === "varDecl" && immutable.has(stmt.localId))
          consts.set(stmt.localId, consts.has(stmt.localId) ? null : stmt.init);
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
        if (expr.kind === "closure") {
          escaped.add(expr.fnName);
          const sites = closureSites.get(expr.fnName) ?? [];
          sites.push({ owner: fn.name, captures: expr.captures });
          closureSites.set(expr.fnName, sites);
        }
        if ((expr.kind === "assignExpr" || expr.kind === "incDec") && globalIds.has(expr.localId))
          writes.add(expr.localId);
        return true;
      },
    });
    externalReferences(fn.body);
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
    const index = fn?.captures?.findIndex((capture) => capture.localId === id) ?? -1;
    const local = fn?.locals.find((candidate) => candidate.id === id);
    const sites = closureSites.get(owner);
    if (index < 0 || !local || local.mutable || !sites?.length) return null;
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

/** Expression kinds that run no user code of their own and never consult
 * the ambient receiver stack. Calls are admitted here and resolved through
 * the module call graph below; callValue brackets its own receiver. */
const RECEIVER_FREE_EXPRS = new Set<IrExpr["kind"]>([
  "numLit",
  "boolLit",
  "strLit",
  "unitLit",
  "varRef",
  "bin",
  "unary",
  "logical",
  "ternary",
  "seqExpr",
  "incDec",
  "fieldIncDec",
  "assignExpr",
  "toBool",
  "toString",
  "strConcat",
  "strEq",
  "strCmp",
  "nullish",
  "orDefault",
  "unionWrap",
  "unionNarrow",
  "unionIsTag",
  "unionEq",
  "unionDisc",
  "upcast",
  "downcast",
  "instanceOf",
  "fieldGet",
  "recordGet",
  "recordLit",
  "recordClone",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "arrayLit",
  "arrayNewLen",
  "selfRef",
  "closure",
  "callValue",
  "call",
  "new",
  "virtualCall",
  "libCall",
  "arrIntrinsic",
  "strIntrinsic",
  "mapIntrinsic",
  "setIntrinsic",
  "mapNew",
  "setNew",
]);

const RECEIVER_FREE_STMTS = new Set<IrStmt["kind"]>([
  "varDecl",
  "assign",
  "exprStmt",
  "return",
  "if",
  "while",
  "doWhile",
  "for",
  "switch",
  "block",
  "break",
  "continue",
  "fieldSet",
  "recordSet",
  "arraySet",
  "arraySetUndefined",
  "arraySetLength",
  "throw",
  "rethrow",
  "tryCatch",
  // The deferred compile fence throws a fixed catchable Error
  // (scr_throw_error_msg_code).
  "runtimeFence",
]);

/** Runtime library calls beyond scalar Math that only compute or build and
 * park a native error: the f64[] folds behind Math.max/min(...xs),
 * `new Error(message)` (scr_error_new), and the checked-read TypeError
 * (scr_throw_node_coded). */
const RECEIVER_FREE_LIB_FNS = new Set<IrLibFn>([
  "math.maxArr",
  "math.minArr",
  "error.new",
  "error.nodeThrow",
]);

/** Typed container and string operations. Their runtime paths compare and
 * copy values but never call back into compiled code, as long as no
 * operand is a function or a checked/engine value. */
/** Operands of a data intrinsic (receiver first), or null when `e` is not
 * one. A switch over the kinds keeps this inside the self-hosted subset,
 * which has no `in` on IR expression unions. */
function dataIntrinsicOperands(e: IrExpr): IrExpr[] | null {
  switch (e.kind) {
    case "arrIntrinsic":
    case "strIntrinsic":
    case "mapIntrinsic":
    case "setIntrinsic":
      return [e.receiver, ...e.args];
    case "mapNew":
    case "setNew":
      return [];
    default:
      return null;
  }
}

function opaqueOperand(e: IrExpr): boolean {
  const kind = e.type.kind;
  return kind === "func" || kind === "dyn" || kind === "jsval" || kind === "caught";
}

/** The functions that may observe the ambient receiver stack when entered
 * without a fresh binding: the JS `this` read (libCall dyn.this), async and
 * generator creation (which snapshot it), dynamic and engine operations,
 * diagnostics-channel stores, and anything outside the admitted kinds; then
 * every function that can reach one through a direct call, constructor or
 * virtual dispatch (a backward reachability fixpoint, so recursion such as
 * a tree walker's `evaluate` resolves exactly). A known callback outside
 * this set needs no receiver bracket. */
export class AmbientReceiverReaders {
  private readers: Set<string> | null = null;

  constructor(private readonly functions: ReadonlyMap<string, IrFunction>) {}

  ignores(fn: IrFunction): boolean {
    if (fn.async || fn.generator) return false;
    return !this.compute().has(fn.name);
  }

  private compute(): Set<string> {
    if (this.readers) return this.readers;
    const byMethod = new Map<string, string[]>();
    for (const name of this.functions.keys()) {
      const dot = name.lastIndexOf(".");
      if (!name.startsWith("%") || dot < 0) continue;
      const method = name.slice(dot + 1);
      const list = byMethod.get(method) ?? [];
      list.push(name);
      byMethod.set(method, list);
    }
    const readers = new Set<string>();
    const callers = new Map<string, string[]>();
    for (const fn of this.functions.values()) {
      const callees = new Set<string>();
      let reads = fn.async === true || fn.generator !== undefined;
      const edge = (name: string): boolean => {
        if (!this.functions.has(name)) return false;
        callees.add(name);
        return true;
      };
      if (!reads)
        reads = !everyStmtList(fn.body, {
          stmt: (stmt) => RECEIVER_FREE_STMTS.has(stmt.kind),
          expr: (expr) => {
            if (!RECEIVER_FREE_EXPRS.has(expr.kind)) return false;
            switch (expr.kind) {
              case "call":
                return edge(expr.callee);
              case "new":
                return edge(`%${expr.className}.constructor`);
              case "virtualCall": {
                // Any class's override may run: admit only when every
                // same-named method is itself receiver-free.
                const targets = byMethod.get(expr.method) ?? [];
                return targets.length > 0 && targets.every(edge);
              }
              case "libCall":
                return isBorrowSafeMath(expr.fn) || RECEIVER_FREE_LIB_FNS.has(expr.fn);
              case "toString":
                return !opaqueOperand(expr.operand);
              default: {
                const operands = dataIntrinsicOperands(expr);
                return operands === null || !operands.some(opaqueOperand);
              }
            }
          },
        });
      if (reads) readers.add(fn.name);
      for (const callee of callees) {
        const list = callers.get(callee) ?? [];
        list.push(fn.name);
        callers.set(callee, list);
      }
    }
    const work = [...readers];
    while (work.length > 0) {
      for (const caller of callers.get(work.pop()!) ?? []) {
        if (readers.has(caller)) continue;
        readers.add(caller);
        work.push(caller);
      }
    }
    this.readers = readers;
    return readers;
  }
}

/** A known callback that cannot observe ambient this needs no receiver
 * stack bracket. Standalone form of AmbientReceiverReaders over the given
 * functions (by default only the callback itself, so any call stays on the
 * ABI path). */
export function callbackIgnoresReceiver(
  fn: IrFunction,
  functions: ReadonlyMap<string, IrFunction> = new Map([[fn.name, fn]]),
): boolean {
  return new AmbientReceiverReaders(functions).ignores(fn);
}
