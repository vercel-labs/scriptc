import { CaptureFlow } from "./capture-values.js";
import {
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { everyExprChild, everyStmtChild, mapExprChildren, mapStmtChildren } from "./traverse.js";

/** Closures that capture the binding they are stored in read themselves
 * through `selfRef` instead of through that binding's box.
 *
 * `const visit = (node) => { ... visit(child) ... }` lowers to a closure
 * over the box of `visit`, and the box then holds the closure: a two-object
 * reference cycle that reference counting cannot free. Each closure made
 * this way is buffered as a cycle candidate and reclaimed only when a
 * collector pass walks it. Nested function declarations already read their
 * own name through `selfRef`; this pass gives arrows and function
 * expressions bound to a binding the same form once the IR proves that the
 * binding always holds the closure itself while the closure can run:
 *
 * - every creation site of the closure body stores the new closure, as is,
 *   into a boxed local of the creating function: either the initializer of
 *   that local's only declaration, or the only assignment of a local whose
 *   only declaration is empty and precedes the assignment in the same
 *   statement list (so each box is filled once, and a closure can only run
 *   after the statement that stores it);
 * - nothing else writes the binding, in the creating function or in any
 *   body that shares its box (CaptureFlow.unchanged), and no local class
 *   captures it;
 * - the closure body is synchronous, is not a generator, and does not pass
 *   the binding on to a nested closure (its environment would need a box of
 *   its own, allocated on every call).
 *
 * The capture then disappears from the body and from every creation site,
 * and each read of it becomes `selfRef` (the running closure, retained),
 * which is the same pointer the box would have produced. The creating
 * function keeps its binding; it loses its box when no other closure
 * captures it, except for temporal-dead-zone bindings, whose box still
 * carries the empty state its own reads test. */
export function resolveSelfCaptures(mod: IrModule): IrModule {
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const sites = new Map<string, { owner: string; closure: IrExpr & { kind: "closure" } }[]>();
  /** Closure nodes stored into a local by a qualifying definition, with that
   * local and the number of writes the definition itself makes. */
  const definitions = new Map<IrExpr, { local: string; writes: number }>();
  const declarations = new Map<string, Map<string, number>>();
  for (const fn of mod.functions) {
    const counts = new Map<string, number>();
    declarations.set(fn.name, counts);
    const expr = (e: IrExpr): boolean => {
      if (e.kind === "closure") {
        let list = sites.get(e.fnName);
        if (list === undefined) sites.set(e.fnName, (list = []));
        list.push({ owner: fn.name, closure: e });
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      if (s.kind === "varDecl") counts.set(s.localId, (counts.get(s.localId) ?? 0) + 1);
      return everyStmtChild(s, expr, stmt);
    };
    fn.body.every(stmt);
    for (const list of statementLists(fn.body)) {
      list.forEach((s, i) => {
        if (s.kind !== "varDecl") return;
        if (s.init !== null) {
          if (s.init.kind === "closure") definitions.set(s.init, { local: s.localId, writes: 0 });
          return;
        }
        for (let j = i + 1; j < list.length; j++) {
          const next = list[j]!;
          if (next.kind === "assign" && next.localId === s.localId) {
            if (next.value.kind === "closure")
              definitions.set(next.value, { local: s.localId, writes: 1 });
            return;
          }
        }
      });
    }
  }

  let flow: CaptureFlow | null = null;
  /** Per closure body, the capture index that names its own closure. */
  const resolved = new Map<string, number>();
  for (const fn of mod.functions) {
    const captures = fn.captures;
    if (captures === undefined || captures.length === 0) continue;
    if (fn.async === true || fn.generator !== undefined || fn.classCaptures !== undefined) continue;
    const list = sites.get(fn.name);
    if (list === undefined || list.length === 0) continue;
    const recaptured = capturedIds(fn.body);
    for (let index = 0; index < captures.length; index++) {
      const capture = captures[index]!;
      if (capture.type.kind !== "func" || recaptured.has(capture.localId)) continue;
      const qualifies = list.every(({ owner, closure }) => {
        if (closure.adapts === true || !typeEquals(closure.type, capture.type)) return false;
        const definition = definitions.get(closure);
        const source = closure.captures[index];
        if (definition === undefined || source !== definition.local) return false;
        const creator = functions.get(owner)!;
        const local = creator.locals.find((l) => l.id === source);
        if (local?.boxed !== true || !typeEquals(local.type, closure.type)) return false;
        if (creator.params.some((p) => p.localId === source)) return false;
        if (creator.captures?.some((c) => c.localId === source)) return false;
        if (creator.classCaptures?.some((c) => c.localId === source)) return false;
        if (declarations.get(owner)!.get(source) !== 1) return false;
        // Only unchanged() is asked: the flow reads just the bodies it needs.
        flow ??= new CaptureFlow(mod.functions, false);
        return flow.unchanged(owner, source, definition.writes);
      });
      if (qualifies) {
        resolved.set(fn.name, index);
        break;
      }
    }
  }
  if (resolved.size === 0) return mod;

  // Only the resolved bodies and the functions that create their closures
  // change.
  const touched = new Set(resolved.keys());
  for (const name of resolved.keys()) for (const site of sites.get(name)!) touched.add(site.owner);
  const rewritten = mod.functions.map((fn) => {
    if (!touched.has(fn.name)) return fn;
    const own = resolved.get(fn.name);
    const self = own === undefined ? null : fn.captures![own]!;
    let changed = false;
    const expr = (e: IrExpr): IrExpr => {
      if (self !== null && e.kind === "varRef" && e.localId === self.localId) {
        changed = true;
        return { kind: "selfRef", type: self.type, loc: e.loc };
      }
      if (e.kind === "closure") {
        const drop = resolved.get(e.fnName);
        if (drop !== undefined) {
          changed = true;
          return { ...e, captures: e.captures.filter((_, i) => i !== drop) };
        }
      }
      return mapExprChildren(e, expr, stmt);
    };
    const stmt = (s: IrStmt): IrStmt => mapStmtChildren(s, expr, stmt);
    const body = fn.body.map(stmt);
    if (!changed && self === null) return fn;
    // A binding no environment captures any more needs no box. A dead-zone
    // binding keeps the box that represents its uninitialized state.
    const stillCaptured = capturedIds(body);
    // The callback returns IrLocal explicitly: inferred from both returns,
    // its type would be the unboxed copy's, and the self-hosted compiler
    // would narrow every kept local to that shape, dropping `boxed`.
    const locals = fn.locals
      .filter((local) => self === null || local.id !== self.localId)
      .map((local): IrLocal => {
        if (local.boxed !== true || local.tdz === true || stillCaptured.has(local.id)) return local;
        if (fn.captures?.some((c) => c.localId === local.id)) return local;
        if (fn.classCaptures?.some((c) => c.localId === local.id)) return local;
        if (!wasSource(fn, local.id, resolved)) return local;
        const { boxed: _boxed, ...plain } = local;
        return plain;
      });
    const next: IrFunction = { ...fn, locals, body };
    if (self !== null) next.captures = fn.captures!.filter((_, i) => i !== own);
    return next;
  });
  return { ...mod, functions: rewritten };
}

/** Whether `fn` stored a resolved closure into `id`, the only case in which
 * this pass may unbox a binding (others stay exactly as lowered). */
function wasSource(fn: IrFunction, id: string, resolved: ReadonlyMap<string, number>): boolean {
  let found = false;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "closure") {
      const index = resolved.get(e.fnName);
      if (index !== undefined && e.captures[index] === id) found = true;
    }
    return !found && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  fn.body.every(stmt);
  return found;
}

/** Locals some closure or class created in `body` captures. */
function capturedIds(body: readonly IrStmt[]): Set<string> {
  const ids = new Set<string>();
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "closure" || e.kind === "classRef")
      for (const id of e.captures ?? []) ids.add(id);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  body.every(stmt);
  return ids;
}

/** `body` and every statement list nested in its statements (not the ones
 * inside expressions). Statements of one list run in order, each at most
 * once per execution of the list. */
function statementLists(body: readonly IrStmt[]): (readonly IrStmt[])[] {
  const lists: (readonly IrStmt[])[] = [];
  const visit = (list: readonly IrStmt[]): void => {
    lists.push(list);
    for (const s of list) {
      switch (s.kind) {
        case "block":
        case "while":
        case "doWhile":
        case "for":
        case "forOf":
          visit(s.body);
          break;
        case "if":
          visit(s.then);
          if (s.else_ !== null) visit(s.else_);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        case "tryCatch":
          visit(s.tryBody);
          if (s.catchBody !== null) visit(s.catchBody);
          if (s.finallyBody !== null) visit(s.finallyBody);
          break;
        default:
          break;
      }
    }
  };
  visit(body);
  return lists;
}
