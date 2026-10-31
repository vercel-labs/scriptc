import type { IrExpr, IrFunction, IrGlobal, IrModule, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "./node-index.js";

/** The nodes findInitializerBindings reads: binding uses and captures. */
const USE_KINDS: readonly IrNodeKind[] = [
  "varRef",
  "assignExpr",
  "incDec",
  "closure",
  "assign",
  "varDecl",
  "forOf",
  "tryCatch",
];

/** A failed CommonJS initializer resets its guard only after the body has
 * unwound, then immediately rethrows. Activations cannot overlap, but a
 * later require can observe values left by the failed activation. */
function retryingInitializer(fn: IrFunction): Extract<IrStmt, { kind: "tryCatch" }> | null {
  const set = fn.body[1],
    region = fn.body[2];
  if (
    fn.body.length !== 3 ||
    set?.kind !== "assign" ||
    region?.kind !== "tryCatch" ||
    region.finallyBody !== null ||
    region.catchLocalId === null ||
    !region.catchBody
  )
    return null;
  const body = region.catchBody;
  if (body.length !== 2 && body.length !== 3) return null;
  if (body.length === 3) {
    const fail = body[0]!;
    if (fail.kind !== "exprStmt" || fail.expr.kind !== "libCall" || fail.expr.fn !== "module.fail")
      return null;
  }
  const reset = body[body.length - 2]!,
    rethrow = body[body.length - 1]!;
  return reset.kind === "assign" &&
    reset.localId === set.localId &&
    reset.value.kind === "boolLit" &&
    !reset.value.value &&
    rethrow.kind === "rethrow" &&
    rethrow.localId === region.catchLocalId
    ? region
    : null;
}

/** Globals private to a guarded, synchronous initializer have local numeric
 * dataflow: no other function can replace their slots, and reentrant module
 * evaluation returns before reaching them. Keep the actual global storage
 * and lifetime; these facts are only inputs to numeric and extent analysis. */
export function findInitializerBindings(
  mod: IrModule,
  nodes?: IrNodeIndex,
): ReadonlyMap<string, IrGlobal[]> {
  const result = new Map<string, IrGlobal[]>();
  // Embedders can reset library state between entries. Async initialization
  // and lifted captures also remain outside this synchronous proof.
  if (mod.lib || !mod.globals?.length) return result;
  const globals = new Map(mod.globals.map((g) => [g.id, g]));
  const owners = new Map<string, string | null>();
  const writes = new Map<string, number>();
  const excluded = new Set<string>();
  for (const cls of mod.classes ?? []) {
    for (const capture of cls.localCaptures ?? []) excluded.add(capture.localId);
  }
  const scan = nodes?.scan(USE_KINDS);
  for (const fn of mod.functions) {
    for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])])
      excluded.add(capture.localId);
    const use = (id: string, write: boolean): void => {
      if (!globals.has(id)) return;
      const owner = owners.get(id);
      owners.set(id, owner === undefined || owner === fn.name ? fn.name : null);
      if (write) writes.set(id, (writes.get(id) ?? 0) + 1);
    };
    eachNodeOfKinds(fn, scan, (node) => {
      if (node.kind === "varRef") use(node.localId, false);
      else if (node.kind === "assignExpr" || node.kind === "incDec") use(node.localId, true);
      else if (node.kind === "closure") for (const id of node.captures) excluded.add(id);
      else if (node.kind === "assign" || node.kind === "varDecl" || node.kind === "forOf")
        use(node.localId, true);
      else if (node.kind === "tryCatch" && node.catchLocalId) excluded.add(node.catchLocalId);
    });
  }
  const guarded = new Set<string>();
  for (const fn of mod.functions) {
    if (fn.async || fn.generator) continue;
    const check = fn.body[0],
      set = fn.body[1];
    if (
      check?.kind !== "if" ||
      check.cond.kind !== "varRef" ||
      check.else_ !== null ||
      check.then.length !== 1 ||
      check.then[0]?.kind !== "return" ||
      check.then[0].value !== null ||
      set?.kind !== "assign" ||
      set.localId !== check.cond.localId ||
      set.value.kind !== "boolLit" ||
      !set.value.value
    )
      continue;
    const guard = globals.get(set.localId);
    if (
      guard?.type.kind !== "bool" ||
      guard.tdz ||
      excluded.has(guard.id) ||
      owners.get(guard.id) !== fn.name ||
      (writes.get(guard.id) !== 1 && !(writes.get(guard.id) === 2 && retryingInitializer(fn)))
    )
      continue;
    guarded.add(fn.name);
  }
  for (const global of mod.globals) {
    const owner = owners.get(global.id);
    if (
      !owner ||
      !guarded.has(owner) ||
      excluded.has(global.id) ||
      global.tdz ||
      (global.type.kind !== "f64" && global.type.kind !== "bytes")
    )
      continue;
    const bindings = result.get(owner);
    if (bindings) bindings.push(global);
    else result.set(owner, [global]);
  }
  return result;
}

/** The candidates for local storage: number bindings whose slots the
 * initializer could keep in a local of its own. No other code reads or
 * writes them (that is what makes them initializer bindings), and the
 * guard prevents overlapping activations. A retrying initializer must also
 * overwrite the binding before every read in each activation; otherwise the
 * failed activation's value must survive in the global. Import-cycle bindings
 * keep their externally checked initialization flag and global storage. */
export function initializerLocalCandidates(
  fn: IrFunction,
  bindings: readonly IrGlobal[],
): IrGlobal[] {
  const candidates = bindings.filter((g) => g.type.kind === "f64" && g.initFlag === undefined);
  const retry = retryingInitializer(fn);
  if (!retry || !candidates.length) return candidates;
  const initialized = new Set<string>();
  const incomingReads = new Set<string>();
  const readExpr = (e: IrExpr): boolean => {
    if ((e.kind === "varRef" || e.kind === "incDec") && !initialized.has(e.localId))
      incomingReads.add(e.localId);
    return everyExprChild(e, readExpr, readStmt);
  };
  const readStmt = (s: IrStmt): boolean => everyStmtChild(s, readExpr, readStmt);
  const body = (stmts: readonly IrStmt[]): void => {
    for (const s of stmts) {
      if (s.kind === "block" && !s.labels?.length) body(s.body);
      else if (s.kind === "assign") {
        // The RHS can read the previous value or throw before the store.
        readExpr(s.value);
        initialized.add(s.localId);
      } else {
        // Branches, loops and exception regions may skip their writes.
        // Scan all their reads without crediting a nested store.
        readStmt(s);
      }
    }
  };
  body(retry.tryBody);
  // An exception can reach the outer catch before any initializer store.
  initialized.clear();
  for (const s of retry.catchBody!) readStmt(s);
  return candidates.filter((g) => !incomingReads.has(g.id));
}

/** An analysis view that lists bindings as plain locals: their writes, not
 * an incoming value, decide their storage (see initializerLocalCandidates). */
export function withInitializerLocals(fn: IrFunction, bindings: readonly IrGlobal[]): IrFunction {
  if (!bindings.length) return fn;
  return { ...fn, locals: [...fn.locals, ...bindings] };
}

/** Bindings some loop writes only on a path its iteration may skip: inside
 * an `if` or `switch` arm, a conditional expression arm or a short-circuit
 * operand of that loop's body. Kept in a register, such an update becomes a
 * select that every iteration waits on; kept in memory, only the taken path
 * pays. Writes directly in a nested loop's body count against that loop. */
export function conditionalLoopWrites(body: readonly IrStmt[]): Set<string> {
  const out = new Set<string>();
  // `conditional` is only meaningful inside a loop.
  const expr = (e: IrExpr, inLoop: boolean, conditional: boolean): void => {
    if ((e.kind === "assignExpr" || e.kind === "incDec") && inLoop && conditional)
      out.add(e.localId);
    const branches =
      e.kind === "ternary" ||
      e.kind === "logical" ||
      e.kind === "nullish" ||
      e.kind === "orDefault";
    let first = true;
    everyExprChild(
      e,
      (child) => {
        // The condition / left operand always runs; the rest may not.
        expr(child, inLoop, conditional || (branches && !first));
        first = false;
        return true;
      },
      (s) => (stmt(s, inLoop, conditional), true),
    );
  };
  const list = (stmts: readonly IrStmt[], inLoop: boolean, conditional: boolean): void => {
    for (const s of stmts) stmt(s, inLoop, conditional);
  };
  const stmt = (s: IrStmt, inLoop: boolean, conditional: boolean): void => {
    switch (s.kind) {
      case "assign":
        if (inLoop && conditional) out.add(s.localId);
        expr(s.value, inLoop, conditional);
        return;
      case "if":
        expr(s.cond, inLoop, conditional);
        list(s.then, inLoop, true);
        if (s.else_) list(s.else_, inLoop, true);
        return;
      case "switch":
        expr(s.disc, inLoop, conditional);
        for (const c of s.cases) {
          if (c.test) expr(c.test, inLoop, true);
          list(c.body, inLoop, true);
        }
        return;
      case "while":
      case "doWhile":
        expr(s.cond, true, false);
        list(s.body, true, false);
        return;
      case "for":
        if (s.init) stmt(s.init, inLoop, conditional);
        if (s.cond) expr(s.cond, true, false);
        if (s.update) stmt(s.update, true, false);
        list(s.body, true, false);
        return;
      case "forOf":
        expr(s.iterable, inLoop, conditional);
        list(s.body, true, false);
        return;
      default:
        everyStmtChild(
          s,
          (e) => (expr(e, inLoop, conditional), true),
          (child) => (stmt(child, inLoop, conditional), true),
        );
    }
  };
  list(body, false, false);
  return out;
}

/** An analysis view only: parameters seed numeric-view initialization, not
 * integer ranges. Code generation still uses the original ABI and globals. */
export function withInitializerBindings(fn: IrFunction, bindings: readonly IrGlobal[]): IrFunction {
  if (!bindings.length) return fn;
  const view: IrFunction = {
    name: fn.name,
    loc: fn.loc,
    returnType: fn.returnType,
    body: fn.body,
    locals: [...fn.locals, ...bindings],
    params: [...fn.params, ...bindings.map((g) => ({ localId: g.id, name: g.name, type: g.type }))],
  };
  if (fn.captures) view.captures = fn.captures;
  if (fn.classCaptures) view.classCaptures = fn.classCaptures;
  if (fn.async) view.async = true;
  if (fn.generator) view.generator = fn.generator;
  return view;
}
