import { exprFunctionReference, moduleFunctionReferences } from "./function-references.js";
import { F64, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";

type SwitchCase = Extract<IrStmt, { kind: "switch" }>["cases"][number];
import { reparseExpr } from "./serialize.js";
import {
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  mapExprChildren,
  mapStmtChildren,
  transformExpr,
  transformStmt,
  transformStmtList,
  type IrTransform,
} from "./traverse.js";

/** Number arrays the backend may store as int32 slots.
 *
 * A candidate is a `number[]` binding that only compiled element
 * operations reach: a local of a synchronous function, a module global, or
 * a parameter. Every write of a local or a global stores a fresh array (an
 * array literal, or `new Array(n).fill(v)`); a parameter is never written.
 * Every read of a candidate is the receiver of an element read, write,
 * state test, `length`, `push` or `pop` (a discarded `pop` included), the
 * array of an element-reader helper call, or the argument of a direct call
 * whose parameter at that position is a candidate itself. A parameter is a
 * candidate only when its function is reached by direct calls alone and
 * every call passes a candidate there, so every binding that can hold one
 * of these arrays is a candidate: the array never reaches a runtime
 * function that reads its slots, a library call, a closure, a return or
 * untyped code.
 *
 * Candidates are only proposed here. The int32 slot analysis
 * (int32-slots.ts) keeps the ones whose every stored element is a proven
 * int32 (never -0), assuming the candidates' own elements are int32s, at
 * a fixpoint, and the LLVM backend stores those as SCR_ELEM_I32. It keeps
 * the ones whose stores are exact integers but not all proven int32s as
 * int32 arrays with checked stores: SCR_ELEM_I32 until a store that is not
 * an int32 widens them to doubles in place. Their element-reader helper
 * calls are inlined first (rewriteCandidates), so no shared helper ever
 * receives an int32 array. */

/** The candidate key of the binding `localId` as `fnName` reads it:
 * `function\0local` for a local or parameter, `\0global` for a module
 * global (`%g.` ids), which every function reads alike. */
export function int32ArrayKey(fnName: string, localId: string): string {
  return localId.startsWith("%g.") ? `\0${localId}` : `${fnName}\0${localId}`;
}

/** The int32 element slot (int32-slots.ts) of a candidate key. */
export function int32ArraySlot(key: string): string {
  return key.startsWith("\0") ? `g:${key.slice(1)}` : `l:${key}`;
}

/** Array methods a candidate may be the receiver of: the runtime paths
 * behind them read and write int32 slots through the double-valued slot
 * accessors. */
export const INT32_ARRAY_METHODS: ReadonlySet<string> = new Set([
  "length",
  "push",
  "pop",
  "getNumber",
]);

/** An element-reader helper (`%arr.idxOr.*`): `(a, i) => a's state at i is
 * a value ? the element : undefined`, as one returned ternary. */
export function isElementReader(fn: IrFunction): boolean {
  if (fn.params.length !== 2 || fn.body.length !== 1) return false;
  const [array, index] = fn.params;
  const ret = fn.body[0]!;
  if (array!.type.kind !== "array" || array!.type.elem.kind !== "f64") return false;
  if (index!.type.kind !== "f64" || ret.kind !== "return" || ret.value?.kind !== "ternary")
    return false;
  const isParam = (e: IrExpr, id: string): boolean => e.kind === "varRef" && e.localId === id;
  const { cond, then, else_ } = ret.value;
  return (
    cond.kind === "bin" &&
    cond.op === "===" &&
    cond.left.kind === "arrayState" &&
    isParam(cond.left.arr, array!.localId) &&
    isParam(cond.left.index, index!.localId) &&
    cond.right.kind === "numLit" &&
    cond.right.value === 1 &&
    then.kind === "unionWrap" &&
    then.value.kind === "arrayGet" &&
    isParam(then.value.arr, array!.localId) &&
    isParam(then.value.index, index!.localId) &&
    else_.kind === "unionWrap" &&
    else_.value.kind === "unitLit"
  );
}

/** `new Array(n).fill(v)` as lowering spells it: `fill` over a sequence
 * that declares a temporary empty array, sets its length and yields it. */
function fillAllocation(e: IrExpr): (IrExpr & { kind: "arrIntrinsic" }) | null {
  if (e.kind !== "arrIntrinsic" || e.method !== "fill" || e.receiver.kind !== "seqExpr")
    return null;
  const seq = e.receiver;
  const [decl, length] = seq.stmts;
  if (
    seq.stmts.length !== 2 ||
    decl?.kind !== "varDecl" ||
    decl.init?.kind !== "arrayLit" ||
    decl.init.elems.length !== 0 ||
    length?.kind !== "arraySetLength" ||
    length.arr.kind !== "varRef" ||
    length.arr.localId !== decl.localId ||
    seq.result.kind !== "varRef" ||
    seq.result.localId !== decl.localId
  )
    return null;
  return e;
}

/** Fill-form arrays shorter than this hold doubles even when they are int32
 * arrays with checked stores: their doubles fit a typical 32 KiB L1 data
 * cache, so 4-byte slots save no memory traffic. */
export const CHECKED_INT32_MIN_LENGTH = 4096;

/** The length `n` of `new Array(n).fill(v)`, or null for any other
 * allocation. */
export function fillAllocationLength(e: IrExpr): IrExpr | null {
  const fill = fillAllocation(e);
  if (!fill || fill.receiver.kind !== "seqExpr") return null;
  const set = fill.receiver.stmts[1]!;
  return set.kind === "arraySetLength" ? set.length : null;
}

/** A number expression whose evaluation has no effect: locals, literals and
 * arithmetic. */
function isPureLength(e: IrExpr): boolean {
  if (e.type.kind !== "f64") return false;
  switch (e.kind) {
    case "numLit":
    case "varRef":
      return true;
    case "bin":
      return e.left.type.kind === "f64" && isPureLength(e.left) && isPureLength(e.right);
    case "unary":
      return isPureLength(e.operand);
    default:
      return false;
  }
}

/** Whether the candidate `id` of `fn` may hold int32 slots with checked
 * stores: every array it is assigned is the fill form, with a length that
 * may reach CHECKED_INT32_MIN_LENGTH and evaluates without effects (the
 * backend evaluates it once more to pick the new array's kind). */
export function checkableInt32Allocations(fn: IrFunction, id: string): boolean {
  let ok = true;
  everyStmtList(fn.body, {
    stmt: (s) => {
      if ((s.kind === "varDecl" || s.kind === "assign") && s.localId === id) {
        const value = s.kind === "varDecl" ? s.init : s.value;
        const length = value ? fillAllocationLength(value) : null;
        if (
          length === null ||
          !isPureLength(length) ||
          (length.kind === "numLit" && length.value < CHECKED_INT32_MIN_LENGTH)
        )
          ok = false;
      }
      return ok;
    },
    expr: () => ok,
  });
  return ok;
}

/** A fresh number array: a literal without spreads, or the fill form. */
export function int32ArrayAllocation(e: IrExpr): boolean {
  return (e.kind === "arrayLit" && (e.spreads?.length ?? 0) === 0) || fillAllocation(e) !== null;
}

/** The array literal a candidate's allocation builds (the literal itself,
 * or the fill form's temporary's), and the fill form's temporary. */
export function allocatedLiteral(
  e: IrExpr,
): { literal: IrExpr & { kind: "arrayLit" }; temporary: string | null } | null {
  if (e.kind === "arrayLit") return { literal: e, temporary: null };
  const fill = fillAllocation(e);
  if (!fill || fill.receiver.kind !== "seqExpr") return null;
  const decl = fill.receiver.stmts[0]!;
  return decl.kind === "varDecl" && decl.init?.kind === "arrayLit"
    ? { literal: decl.init, temporary: decl.localId }
    : null;
}

/** `xs.pop()` whose value is unused, as lowering spells it: a sequence
 * that binds the array to a hidden local, then only reads that local's
 * length and truncates it with pop stores. Returns the hidden local and the
 * array read it binds. */
function discardedPop(e: IrExpr): { local: string; array: IrExpr & { kind: "varRef" } } | null {
  if (e.kind !== "seqExpr") return null;
  const [bind, ...rest] = e.stmts;
  if (bind?.kind !== "varDecl" || bind.init?.kind !== "varRef") return null;
  const local = bind.localId;
  const isLocal = (x: IrExpr): boolean => x.kind === "varRef" && x.localId === local;
  const expr = (x: IrExpr): boolean => {
    if (x.kind === "arrIntrinsic" && x.method === "length" && isLocal(x.receiver)) return true;
    return !isLocal(x) && everyExprChild(x, expr, stmt);
  };
  const stmt = (x: IrStmt): boolean => {
    if (x.kind === "arraySetLength" && x.pop === true && isLocal(x.arr)) return expr(x.length);
    return (
      !((x.kind === "varDecl" || x.kind === "assign") && x.localId === local) &&
      everyStmtChild(x, expr, stmt)
    );
  };
  return rest.every(stmt) && expr(e.result) ? { local, array: bind.init } : null;
}

/** Whether evaluating `e` may assign the local `id`. */
function writesLocal(e: IrExpr, id: string): boolean {
  const expr = (x: IrExpr): boolean =>
    !(x.kind === "assignExpr" && x.localId === id) && everyExprChild(x, expr, stmt);
  const stmt = (x: IrStmt): boolean =>
    !((x.kind === "varDecl" || x.kind === "assign") && x.localId === id) &&
    everyStmtChild(x, expr, stmt);
  return !expr(e);
}

/** Expression kinds an index can be built from without running any code. */
const PURE_INDEX_KINDS: ReadonlySet<string> = new Set([
  "varRef",
  "numLit",
  "boolLit",
  "bin",
  "unary",
  "ternary",
  "logical",
  "arrayGet",
  "arrayState",
]);

/** Whether evaluating an index runs no code (no call, accessor or
 * conversion): plain reads, literals and their operators only. */
function pureIndex(e: IrExpr): boolean {
  return PURE_INDEX_KINDS.has(e.kind) && everyExprChild(e, pureIndex, () => false);
}

/** The parameters and globals a module's functions share as candidates,
 * still assumed to qualify. */
export interface SharedCandidates {
  /** Candidate parameters, as `function\0local` keys. */
  params: ReadonlySet<string>;
  /** Candidate globals, as `%g.` ids. */
  globals: ReadonlySet<string>;
  /** Whether the parameter at `index` of `callee` is a candidate. */
  paramAt: (callee: string, index: number) => boolean;
}

const NO_SHARED: SharedCandidates = {
  params: new Set(),
  globals: new Set(),
  paramAt: () => false,
};

/** The candidates of `fn` (see the module comment): its own locals, its
 * parameters in `shared.params`, and the globals of `shared.globals` that
 * it reads only in candidate positions. `written` receives the globals it
 * assigns fresh arrays. */
export function int32ArrayCandidates(
  fn: IrFunction,
  readers: ReadonlySet<string>,
  shared: SharedCandidates = NO_SHARED,
  written: Set<string> = new Set(),
): Set<string> {
  const result = new Set<string>();
  if (fn.async || fn.generator) {
    // Globals read here leave the candidates.
    for (const id of shared.globals) result.add(id);
    everyStmtList(fn.body, {
      expr: (e) => {
        if ((e.kind === "varRef" || e.kind === "assignExpr") && result.has(e.localId))
          result.delete(e.localId);
        return true;
      },
      stmt: (s) => {
        if ((s.kind === "varDecl" || s.kind === "assign") && result.has(s.localId))
          result.delete(s.localId);
        return true;
      },
    });
    return result;
  }
  const captured = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const params = new Set(fn.params.map((p) => p.localId));
  for (const local of fn.locals)
    if (
      local.type.kind === "array" &&
      local.type.elem.kind === "f64" &&
      !local.boxed &&
      !local.tdz &&
      !captured.has(local.id) &&
      (!params.has(local.id) || shared.params.has(`${fn.name}\0${local.id}`))
    )
      result.add(local.id);
  for (const id of shared.globals) result.add(id);
  if (result.size === 0) return result;
  const allocated = new Set<string>();
  // A receiver position: the candidate is read there without escaping.
  const receiver = (e: IrExpr): void => {
    if (e.kind !== "varRef") expr(e);
  };
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
        result.delete(e.localId);
        return true;
      case "assignExpr":
        result.delete(e.localId);
        break;
      case "arrayGet":
      case "arrayState":
      case "arrayHas":
        receiver(e.arr);
        expr(e.index);
        return true;
      case "arrIntrinsic":
        if (!INT32_ARRAY_METHODS.has(e.method)) break;
        receiver(e.receiver);
        e.args.forEach(expr);
        return true;
      case "seqExpr": {
        // The pop's hidden local is the array itself; every use of it is a
        // length read or a pop store.
        const pop = discardedPop(e);
        if (!pop) break;
        e.stmts.slice(1).every(stmt);
        expr(e.result);
        return true;
      }
      case "call": {
        if (readers.has(e.callee) && e.args.length === 2) {
          const [array, index] = e.args;
          // Inlining evaluates the index before the array read: an index
          // that rebinds the array keeps it out, and so does one that can run
          // code when the array is a module global (a call can reassign it).
          if (
            array!.kind === "varRef" &&
            (writesLocal(index!, array!.localId) ||
              (array!.localId.startsWith("%g.") && !pureIndex(index!)))
          )
            result.delete(array!.localId);
          receiver(array!);
          expr(index!);
          return true;
        }
        // An argument at a candidate parameter position passes the array
        // to another candidate binding (moduleInt32ArrayCandidates checks
        // every such call).
        e.args.forEach((arg, index) => {
          if (shared.paramAt(e.callee, index)) receiver(arg);
          else expr(arg);
        });
        return true;
      }
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "varDecl":
      case "assign": {
        const value = s.kind === "varDecl" ? s.init : s.value;
        if (params.has(s.localId)) result.delete(s.localId);
        else if (value && int32ArrayAllocation(value)) allocated.add(s.localId);
        else if (value) result.delete(s.localId);
        if (value) expr(value);
        return true;
      }
      case "arraySet":
        receiver(s.arr);
        expr(s.index);
        expr(s.value);
        return true;
      case "arraySetUndefined":
        // Stores a present undefined: a state, and a cleared (+0) slot.
        receiver(s.arr);
        expr(s.index);
        return true;
      case "forOf":
        result.delete(s.localId);
        break;
      case "tryCatch":
        if (s.catchLocalId) result.delete(s.catchLocalId);
        break;
    }
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  for (const id of result) {
    if (shared.globals.has(id)) {
      if (allocated.has(id)) written.add(id);
    } else if (!params.has(id) && !allocated.has(id)) result.delete(id);
  }
  return result;
}

/** The members of `ids` (none when absent) that are in `live`. */
function liveIn(ids: ReadonlySet<string> | undefined, live: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  if (ids) for (const id of ids) if (live.has(id)) result.add(id);
  return result;
}

/** The candidates of every function of `mod` that has any, only those
 * whose keys are in `keep` when given. Parameters and globals are shared:
 * starting from every one that may qualify, each pass drops the ones a
 * function reads outside candidate positions, the parameters some call
 * passes anything but a candidate, and the globals never assigned a fresh
 * array, until a pass drops nothing. Functions in `redirected` keep their
 * parameters: some of their calls reach another function. */
export function moduleInt32ArrayCandidates(
  mod: IrModule,
  readers: ReadonlySet<string>,
  keep: ReadonlySet<string> | null = null,
  redirected: ReadonlySet<string> = new Set(),
): Map<string, Set<string>> {
  const kept = (key: string): boolean => keep === null || keep.has(key);
  const arrayParams = new Map<string, number[]>();
  for (const fn of mod.functions) {
    // Class methods, constructors and runtime helpers (`%` names) keep
    // their parameters.
    if (fn.name.startsWith("%") || fn.async || fn.generator || redirected.has(fn.name)) continue;
    const indexes: number[] = [];
    fn.params.forEach((p, i) => {
      if (p.type.kind === "array" && p.type.elem.kind === "f64") indexes.push(i);
    });
    if (indexes.length > 0) arrayParams.set(fn.name, indexes);
  }
  let globals = new Set<string>();
  for (const g of mod.globals ?? [])
    if (
      g.type.kind === "array" &&
      g.type.elem.kind === "f64" &&
      g.initFlag === undefined &&
      kept(`\0${g.id}`)
    )
      globals.add(g.id);
  const result = new Map<string, Set<string>>();
  if (arrayParams.size === 0 && globals.size === 0) {
    for (const fn of mod.functions) {
      const candidates = int32ArrayCandidates(fn, readers);
      for (const id of candidates) if (!kept(`${fn.name}\0${id}`)) candidates.delete(id);
      if (candidates.size > 0) result.set(fn.name, candidates);
    }
    return result;
  }
  // One walk: the functions reached other than by direct calls, the direct
  // calls of functions with number[] parameters, the globals each function
  // reads or writes, and whether a module namespace object exists (its
  // member reads can reach any global by name).
  const reached = new Set(moduleFunctionReferences(mod));
  const calls: { caller: string; call: IrExpr & { kind: "call" } }[] = [];
  const globalsIn = new Map<string, Set<string>>();
  let namespaces = false;
  for (const fn of mod.functions) {
    const used = new Set<string>();
    const note = (id: string): void => {
      if (globals.has(id)) used.add(id);
    };
    everyStmtList(fn.body, {
      expr: (e) => {
        const name = exprFunctionReference(e);
        if (name !== undefined) reached.add(name);
        if (e.kind === "moduleNsRef") namespaces = true;
        if (e.kind === "call" && arrayParams.has(e.callee))
          calls.push({ caller: fn.name, call: e });
        if (e.kind === "varRef" || e.kind === "assignExpr") note(e.localId);
        return true;
      },
      stmt: (s) => {
        if (s.kind === "varDecl" || s.kind === "assign") note(s.localId);
        return true;
      },
    });
    if (used.size > 0) globalsIn.set(fn.name, used);
  }
  if (namespaces) {
    globals = new Set();
    globalsIn.clear();
  }
  const paramIds = new Map<string, string[]>();
  let params = new Set<string>();
  for (const fn of mod.functions) {
    const indexes = arrayParams.get(fn.name);
    if (!indexes || reached.has(fn.name)) continue;
    paramIds.set(
      fn.name,
      fn.params.map((p) => p.localId),
    );
    for (const i of indexes) {
      const key = `${fn.name}\0${fn.params[i]!.localId}`;
      if (kept(key)) params.add(key);
    }
  }
  for (;;) {
    const current = params;
    const written = new Set<string>();
    const liveGlobals = new Set(globals);
    result.clear();
    for (const fn of mod.functions) {
      const shared: SharedCandidates = {
        params: current,
        globals: liveIn(globalsIn.get(fn.name), globals),
        paramAt: (callee, index) => {
          const id = paramIds.get(callee)?.[index];
          return id !== undefined && current.has(`${callee}\0${id}`);
        },
      };
      const candidates = int32ArrayCandidates(fn, readers, shared, written);
      for (const id of shared.globals) if (!candidates.has(id)) liveGlobals.delete(id);
      for (const id of candidates)
        if (!shared.globals.has(id) && !kept(`${fn.name}\0${id}`)) candidates.delete(id);
      if (candidates.size > 0) result.set(fn.name, candidates);
    }
    for (const id of liveGlobals) if (!written.has(id)) liveGlobals.delete(id);
    const live = new Set(
      [...current].filter((key) => {
        const cut = key.indexOf("\0");
        return result.get(key.slice(0, cut))?.has(key.slice(cut + 1)) === true;
      }),
    );
    // A parameter needs a candidate at that position of every call; a call
    // with fewer arguments passes undefined.
    for (const { caller, call } of calls) {
      const ids = paramIds.get(call.callee);
      if (!ids) continue;
      ids.forEach((id, i) => {
        const key = `${call.callee}\0${id}`;
        if (!live.has(key)) return;
        const arg = call.args[i];
        const ok =
          arg?.kind === "varRef" &&
          (arg.localId.startsWith("%g.")
            ? liveGlobals.has(arg.localId)
            : result.get(caller)?.has(arg.localId) === true);
        if (!ok) live.delete(key);
      });
    }
    if (live.size === current.size && liveGlobals.size === globals.size) break;
    params = live;
    globals = liveGlobals;
  }
  return result;
}

/** The candidates one array can reach together: a direct call's argument
 * and the parameter it binds hold the same array, so their element facts
 * stand or fall together. `group` maps each of `keys` to its group's keys
 * (itself alone for most), and `globalReaders` each candidate global's
 * key to the functions that read or write it. */
export function int32ArrayGroups(
  mod: IrModule,
  keys: ReadonlySet<string>,
): { group: Map<string, string[]>; globalReaders: Map<string, Set<string>> } {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let r = key;
    while (parent.has(r)) r = parent.get(r)!;
    if (r !== key) parent.set(key, r);
    return r;
  };
  const globalReaders = new Map<string, Set<string>>();
  const params = new Map(mod.functions.map((fn) => [fn.name, fn.params]));
  const paramKeys = new Set(
    mod.functions.flatMap((fn) => fn.params.map((p) => `${fn.name}\0${p.localId}`)),
  );
  if ([...keys].some((key) => key.startsWith("\0") || paramKeys.has(key))) {
    for (const fn of mod.functions) {
      const touch = (id: string): void => {
        const key = int32ArrayKey(fn.name, id);
        if (!key.startsWith("\0") || !keys.has(key)) return;
        const set = globalReaders.get(key) ?? new Set<string>();
        set.add(fn.name);
        globalReaders.set(key, set);
      };
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "varRef" || e.kind === "assignExpr") touch(e.localId);
          if (e.kind === "call")
            e.args.forEach((arg, i) => {
              const param = params.get(e.callee)?.[i];
              if (arg.kind !== "varRef" || !param) return;
              const a = int32ArrayKey(fn.name, arg.localId),
                p = `${e.callee}\0${param.localId}`;
              if (!keys.has(a) || !keys.has(p)) return;
              const ra = root(a),
                rp = root(p);
              if (ra !== rp) parent.set(ra, rp);
            });
          return true;
        },
        stmt: (s) => {
          if (s.kind === "varDecl" || s.kind === "assign") touch(s.localId);
          return true;
        },
      });
    }
  }
  const members = new Map<string, string[]>();
  for (const key of keys) {
    const r = root(key);
    const list = members.get(r);
    if (list) list.push(key);
    else members.set(r, [key]);
  }
  const group = new Map<string, string[]>();
  for (const key of keys) group.set(key, members.get(root(key))!);
  return { group, globalReaders };
}

/** The element values stored into each candidate: element writes, pushed
 * values, literal elements and fill values. */
export function int32ArrayStores(
  fn: IrFunction,
  candidates: ReadonlySet<string>,
): Map<string, IrExpr[]> {
  const stores = new Map<string, IrExpr[]>();
  const add = (id: string, value: IrExpr): void => {
    const list = stores.get(id);
    if (list) list.push(value);
    else stores.set(id, [value]);
  };
  const target = (e: IrExpr): string | null =>
    e.kind === "varRef" && candidates.has(e.localId) ? e.localId : null;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "arrIntrinsic" && e.method === "push") {
      const id = target(e.receiver);
      if (id !== null) for (const arg of e.args) add(id, arg);
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if ((s.kind === "varDecl" || s.kind === "assign") && candidates.has(s.localId)) {
      const value = s.kind === "varDecl" ? s.init : s.value;
      if (value?.kind === "arrayLit") for (const el of value.elems) add(s.localId, el);
      else if (value) {
        const fill = fillAllocation(value);
        if (fill) add(s.localId, fill.args[0]!);
      }
    }
    if (s.kind === "arraySet") {
      const id = target(s.arr);
      if (id !== null) add(id, s.value);
    }
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  return stores;
}

const REPEATED_INDEX_OPS = new Set(["+", "-", "*", "&", "|", "^", "<<", ">>", ">>>"]);

/** An index the inlined read may evaluate at each of its uses: a plain read,
 * a literal, or integer arithmetic over them. Repeating it keeps the forms
 * the backend derives from its operands at every use, such as the exact i64
 * of an int32 product, where a bound local holds only the double. */
function repeatableIndex(e: IrExpr): boolean {
  if (e.kind === "varRef" || e.kind === "numLit") return true;
  if (e.kind === "unary") return e.op === "-" && repeatableIndex(e.operand);
  return (
    e.kind === "bin" &&
    REPEATED_INDEX_OPS.has(e.op) &&
    repeatableIndex(e.left) &&
    repeatableIndex(e.right)
  );
}

/** Rewrite a function's candidates for the backend. A discarded pop uses
 * the candidate in place of its hidden local. An element-reader helper call
 * whose array is a candidate is inlined: the helper's returned ternary, with
 * the candidate for its array and the index for its index, so the read means
 * the same. An index that is not repeatable (repeatableIndex) is bound to a
 * fresh local first: in its own declaration just before the statement when
 * the call is the whole value of a declaration or assignment (the form
 * lowering gives `a[i]!`, and the one the backend reads without a box),
 * otherwise in a sequence around the ternary. Selection keeps out indexes
 * that write the array, so evaluating the index before the array read is
 * unobservable. */
function rewriteCandidates(
  fn: IrFunction,
  candidates: ReadonlySet<string>,
  readers: ReadonlyMap<string, IrFunction>,
): IrFunction {
  const locals = [...fn.locals];
  let fresh = 0;
  const bind = (index: IrExpr): { decl: IrStmt; ref: IrExpr } => {
    const id = `%int32.read.${fresh++}`;
    locals.push({ id, name: id, type: F64, mutable: false });
    return {
      decl: { kind: "varDecl", localId: id, init: index, loc: index.loc },
      ref: { kind: "varRef", localId: id, type: F64, loc: index.loc },
    };
  };
  const readerCall = (e: IrExpr | null): (IrExpr & { kind: "call" }) | null =>
    e?.kind === "call" &&
    e.args.length === 2 &&
    readers.has(e.callee) &&
    e.args[0]!.kind === "varRef" &&
    candidates.has(e.args[0]!.localId)
      ? e
      : null;
  // The statements of a list, with complex read indexes declared first.
  const hoist = (list: IrStmt[]): IrStmt[] =>
    list.flatMap((s): IrStmt[] => {
      if (s.kind !== "varDecl" && s.kind !== "assign") return [s];
      const value = s.kind === "varDecl" ? s.init : s.value;
      const call = readerCall(value);
      if (!call || repeatableIndex(call.args[1]!)) return [s];
      const { decl, ref } = bind(call.args[1]!);
      const read: IrExpr = { ...call, args: [call.args[0]!, ref] };
      if (s.kind === "varDecl") return [decl, { ...s, init: read }];
      return [decl, { ...s, value: read }];
    });
  const hoistCase = (c: SwitchCase): SwitchCase => ({ ...c, body: hoist(c.body) });
  const lists = (s: IrStmt): IrStmt => {
    switch (s.kind) {
      case "if":
        return { ...s, then: hoist(s.then), else_: s.else_ === null ? null : hoist(s.else_) };
      case "block":
        return { ...s, body: hoist(s.body) };
      case "while":
        return { ...s, body: hoist(s.body) };
      case "doWhile":
        return { ...s, body: hoist(s.body) };
      case "for":
        return { ...s, body: hoist(s.body) };
      case "forOf":
        return { ...s, body: hoist(s.body) };
      case "switch":
        return { ...s, cases: s.cases.map((c) => hoistCase(c)) };
      case "tryCatch":
        return {
          ...s,
          tryBody: hoist(s.tryBody),
          catchBody: s.catchBody === null ? null : hoist(s.catchBody),
          finallyBody: s.finallyBody === null ? null : hoist(s.finallyBody),
        };
    }
    return s;
  };
  // Hidden pop locals replaced by their candidate array.
  const popLocals = new Set<string>();
  const rewrite = (e: IrExpr): IrExpr => {
    const pop = discardedPop(e);
    if (e.kind === "seqExpr" && pop && candidates.has(pop.array.localId)) {
      popLocals.add(pop.local);
      const array = pop.array;
      const substitute: IrTransform = {
        expr: (x) =>
          x.kind === "varRef" && x.localId === pop.local ? { ...array, loc: x.loc } : x,
        stmt: (x) => x,
      };
      return {
        ...e,
        stmts: e.stmts.slice(1).map((x) => transformStmt(x, substitute)),
        result: transformExpr(e.result, substitute),
      };
    }
    const call = readerCall(e);
    if (!call) {
      if (e.kind === "seqExpr") return { ...e, stmts: hoist(e.stmts) };
      return e;
    }
    const helper = readers.get(call.callee)!;
    const array = call.args[0]!;
    const [arrayParam, indexParam] = helper.params;
    const ret = helper.body[0]!;
    if (ret.kind !== "return" || !ret.value) return e;
    let index = call.args[1]!;
    const stmts: IrStmt[] = [];
    if (!repeatableIndex(index)) {
      const { decl, ref } = bind(index);
      stmts.push(decl);
      index = ref;
    }
    const operand = index;
    // The arguments' copies are not searched again: an index may read a
    // local that has the id of one of the helper's parameters.
    const substituteExpr = (x: IrExpr): IrExpr => {
      if (x.kind !== "varRef") return mapExprChildren(x, substituteExpr, substituteStmt);
      if (x.localId === arrayParam!.localId) return reparseExpr(array);
      if (x.localId === indexParam!.localId) return reparseExpr(operand);
      return x;
    };
    const substituteStmt = (x: IrStmt): IrStmt =>
      mapStmtChildren(x, substituteExpr, substituteStmt);
    const body = substituteExpr(reparseExpr(ret.value));
    // The ternary is a fresh copy (reparseExpr): it takes the call's location.
    const typed = body;
    typed.loc = e.loc;
    return stmts.length === 0
      ? typed
      : { kind: "seqExpr", stmts, result: typed, type: typed.type, loc: e.loc };
  };
  const body = transformStmtList(hoist(fn.body), { expr: rewrite, stmt: lists });
  if (fresh === 0 && popLocals.size === 0) return { ...fn, body };
  return { ...fn, body, locals: locals.filter((local) => !popLocals.has(local.id)) };
}

/** A module marked for its int32 array candidates: the candidates of
 * each function (int32ArrayCandidates) and the element readers the marking
 * inlines. */
interface Int32ArrayMarking {
  readonly mod: IrModule;
  readonly readers: ReadonlyMap<string, IrFunction>;
  readonly candidates: ReadonlyMap<string, ReadonlySet<string>>;
}

/** markInt32ArrayCandidates with the candidates it marked; null when it
 * marks none. */
function markCandidates(
  mod: IrModule,
  keep: ReadonlySet<string> | null,
  redirected: ReadonlySet<string>,
): Int32ArrayMarking | null {
  if (mod.lib !== undefined) return null;
  const readers = new Map<string, IrFunction>();
  for (const fn of mod.functions) if (isElementReader(fn)) readers.set(fn.name, fn);
  const all = moduleInt32ArrayCandidates(mod, new Set(readers.keys()), keep, redirected);
  if (all.size === 0) return null;
  const keys = new Set<string>();
  const functions = mod.functions.map((fn) => {
    const candidates = all.get(fn.name);
    if (!candidates) return fn;
    for (const id of candidates) keys.add(int32ArrayKey(fn.name, id));
    return rewriteCandidates(fn, candidates, readers);
  });
  return {
    mod: { ...mod, functions, int32ArrayCandidates: [...keys] },
    readers,
    candidates: all,
  };
}

/** Propose the module's int32 array candidates (int32ArrayKey keys in
 * `int32ArrayCandidates`), only those in `keep` when given, and rewrite
 * their functions. */
export function markInt32ArrayCandidates(
  mod: IrModule,
  keep: ReadonlySet<string> | null = null,
  redirected: ReadonlySet<string> = new Set(),
): IrModule {
  return markCandidates(mod, keep, redirected)?.mod ?? mod;
}

/** Revises a function of a module marked for int32 array candidates when
 * some of them drop: the function marked for its candidates outside
 * `dropped` (int32ArrayKey keys), which is the unmarked function when none
 * is left. */
export type Int32ArrayRevision = (fnName: string, dropped: ReadonlySet<string>) => IrFunction;

/** What a proof of a marked module (selectInt32Arrays' `prove`) keeps. */
export interface Int32ArrayProof {
  /** The candidates it keeps. */
  readonly kept: ReadonlySet<string>;
  /** The functions of the module it proved, in module order, when it
   * revised some through the Int32ArrayRevision it was given; otherwise
   * null, for the marked module's own. */
  readonly functions: readonly IrFunction[] | null;
}

/** The module the backend emits: rewritten for exactly the candidates the
 * int32 slot analysis (`prove`) keeps, so a module without int32 arrays is
 * `mod` itself. `redirected` names the functions some of whose calls the
 * backend emits as calls of another function (a result-slot entry): their
 * parameters keep doubles.
 *
 * The proof of the marked module gets an Int32ArrayRevision: as candidates
 * drop, it revises their functions and goes on proving the revised module,
 * so one analysis ends with the module marked for the candidates it keeps.
 * That module is the answer when marking for those candidates again proposes
 * exactly them, in the functions the proof revised. A proof that cannot
 * follow a revision answers null; then each round marks the module, proves
 * it without revisions, and marks again without the dropped candidates,
 * until a round keeps every candidate it marks (four rounds at most). */
export function selectInt32Arrays(
  mod: IrModule,
  prove: (marked: IrModule, revise: Int32ArrayRevision | null) => Int32ArrayProof | null,
  redirected: (mod: IrModule) => ReadonlySet<string> = () => new Set(),
): IrModule {
  const others = redirected(mod);
  const marking = markCandidates(mod, null, others);
  if (marking === null) return mod;
  const original = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const markedFunctions = new Map(marking.mod.functions.map((fn) => [fn.name, fn]));
  // Each function's latest revision and the candidates it is marked for.
  const revisions = new Map<string, { fn: IrFunction; ids: ReadonlySet<string> }>();
  const revise: Int32ArrayRevision = (fnName, dropped) => {
    const candidates = marking.candidates.get(fnName) ?? new Set<string>();
    const ids = new Set<string>();
    for (const id of candidates) if (!dropped.has(int32ArrayKey(fnName, id))) ids.add(id);
    const latest = revisions.get(fnName);
    if (latest !== undefined && latest.ids.size === ids.size) return latest.fn;
    if (latest === undefined && ids.size === candidates.size) return markedFunctions.get(fnName)!;
    const fn =
      ids.size === 0
        ? original.get(fnName)!
        : rewriteCandidates(original.get(fnName)!, ids, marking.readers);
    revisions.set(fnName, { fn, ids });
    return fn;
  };
  const proof = prove(marking.mod, revise);
  const proposed = marking.mod.int32ArrayCandidates ?? [];
  let keep: ReadonlySet<string> | null = null;
  let round = 0;
  if (proof !== null && proof.functions === null) {
    // The marked module itself was proved: the first round.
    if (proposed.every((key) => proof.kept.has(key))) return marking.mod;
    keep = new Set(proposed.filter((key) => proof.kept.has(key)));
    round = 1;
  } else if (proof !== null) {
    const settled = settleRevisions(mod, marking, proof, revisions, others);
    if (settled !== null) return settled;
  }
  for (; round < 4; round++) {
    const marked = markInt32ArrayCandidates(mod, keep, others);
    if (marked === mod) return mod;
    const kept = prove(marked, null)!.kept;
    const roundProposed = marked.int32ArrayCandidates ?? [];
    if (roundProposed.every((key) => kept.has(key))) return marked;
    keep = new Set(roundProposed.filter((key) => kept.has(key)));
  }
  return mod;
}

/** The module marked for the candidates a revising proof kept, built from
 * the functions it proved: null unless marking `mod` for those candidates
 * proposes, in each function, exactly the candidates its proved function is
 * marked for. `mod` itself when it proposes none. */
function settleRevisions(
  mod: IrModule,
  marking: Int32ArrayMarking,
  proof: Int32ArrayProof,
  revisions: ReadonlyMap<string, { fn: IrFunction; ids: ReadonlySet<string> }>,
  redirected: ReadonlySet<string>,
): IrModule | null {
  const kept = proof.kept;
  const functions = proof.functions!;
  if (functions.length !== mod.functions.length) return null;
  const all = moduleInt32ArrayCandidates(
    mod,
    new Set(marking.readers.keys()),
    new Set([...(marking.mod.int32ArrayCandidates ?? [])].filter((key) => kept.has(key))),
    redirected,
  );
  const keys = new Set<string>();
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = mod.functions[i]!;
    const proved = functions[i]!;
    const candidates = all.get(fn.name);
    const revision = revisions.get(fn.name);
    const marked = revision?.ids ?? marking.candidates.get(fn.name) ?? new Set<string>();
    if ((candidates?.size ?? 0) !== marked.size) return null;
    if (candidates !== undefined)
      for (const id of candidates) {
        if (!marked.has(id)) return null;
        keys.add(int32ArrayKey(fn.name, id));
      }
    const expected =
      revision?.fn ?? (marking.candidates.has(fn.name) ? marking.mod.functions[i]! : fn);
    if (proved !== expected) return null;
  }
  if (all.size === 0) return mod;
  return { ...mod, functions: [...functions], int32ArrayCandidates: [...keys] };
}
