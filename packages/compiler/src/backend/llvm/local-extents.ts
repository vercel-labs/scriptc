import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/** The only read of an owned binding in the last statement of its extent,
 * when that read can take over the binding's reference: the statement reads
 * the binding exactly once, outside any loop or try statement nested in it,
 * assigns it nowhere and mentions no binding derived from it (such a
 * borrowed alias could depend on the moved reference). After the read no
 * statement observes the binding again, so the slot can be cleared instead
 * of retaining the value (scope releases tolerate NULL).
 *
 * The binding is declared at `stmts[index]`, or before the list starts when
 * `index` is -1 (a parameter and its function body). Callers exclude boxed
 * bindings and must also check that the read node occurs once in the
 * function: lowering may share one varRef node between several reads.
 * `rebound` also counts rebound locals as derived (walk locals can borrow
 * from a parameter while rebinding). */
export function lastUseRead(
  stmts: readonly IrStmt[],
  index: number,
  localId: string,
  rebound = false,
): IrExpr | null {
  return lastUse(stmts, index, localId, rebound)?.read ?? null;
}

/** Stores that keep a moved value: the read is the stored value of a field,
 * record or element store, a record literal field, or a pushed element. */
export function storedLastUseRead(
  stmts: readonly IrStmt[],
  index: number,
  localId: string,
  rebound = false,
): IrExpr | null {
  const use = lastUse(stmts, index, localId, rebound);
  return use !== null && use.stored ? use.read : null;
}

function lastUse(
  stmts: readonly IrStmt[],
  index: number,
  localId: string,
  rebound: boolean,
): { read: IrExpr; stored: boolean } | null {
  const { extent, derived } = extentOf(stmts, index, localId, rebound);
  const last = extent[extent.length - 1];
  if (last === undefined) return null;
  const state: { read: IrExpr | null; stored: boolean; ok: boolean } = {
    read: null,
    stored: false,
    ok: true,
  };
  const isRead = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === localId;
  const stmt = (s: IrStmt): boolean => {
    if (!state.ok) return false;
    if ((s.kind === "varDecl" || s.kind === "assign") && derived.has(s.localId)) {
      state.ok = false;
      return false;
    }
    if (
      s.kind === "for" ||
      s.kind === "forOf" ||
      s.kind === "while" ||
      s.kind === "doWhile" ||
      s.kind === "tryCatch"
    ) {
      if (!absentStmt(s, derived)) state.ok = false;
      return state.ok;
    }
    if (
      (s.kind === "fieldSet" || s.kind === "recordSet" || s.kind === "arraySet") &&
      isRead(s.value)
    )
      state.stored = true;
    return everyStmtChild(s, expr, stmt);
  };
  const expr = (e: IrExpr): boolean => {
    if (!state.ok) return false;
    if (isRead(e)) {
      if (state.read !== null) state.ok = false;
      else state.read = e;
      return state.ok;
    }
    if (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") {
      if (derived.has(e.localId)) state.ok = false;
    } else if (e.kind === "closure" || e.kind === "classRef") {
      for (const id of e.captures ?? []) if (derived.has(id)) state.ok = false;
    } else if (e.kind === "recordLit" && e.fields.some((f) => isRead(f.value))) {
      // The literal takes the binding's reference, and the record keeps it
      // alive while the other fields build and after: they may read
      // bindings derived from it, but not the binding again.
      state.stored = true;
      for (const f of e.fields) {
        if (isRead(f.value)) {
          if (state.read !== null) state.ok = false;
          else state.read = f.value;
        } else if (!absentExpr(f.value, new Set([localId]))) {
          state.ok = false;
        }
      }
      return state.ok;
    } else if (e.kind === "arrIntrinsic" && e.method === "push") {
      if (e.args.some(isRead)) state.stored = true;
    }
    if (!state.ok) return false;
    return everyExprChild(e, expr, stmt);
  };
  stmt(last);
  return state.ok && state.read !== null ? { read: state.read, stored: state.stored } : null;
}

/** The statements of a block during which a binding declared at
 * `stmts[index]` can still be observed: from the declaration through the
 * last later statement that mentions the binding or any binding derived
 * from it. A binding is derived when its declaration (or loop binding)
 * mentions the binding or another derived one: a borrowed projection of a
 * borrowed binding (`const b = a.f`) stays valid only while the first
 * binding's own source keeps its value. Closure captures count as
 * mentions. */
function extentOf(
  stmts: readonly IrStmt[],
  index: number,
  localId: string,
  rebound: boolean,
): { extent: IrStmt[]; derived: ReadonlySet<string> } {
  const rest = stmts.slice(index + 1);
  const derived = new Set<string>([localId]);
  const assigned = new Set<string>();
  if (!rebound) for (const s of rest) collectAssignedStmt(s, assigned);
  // Declarations of other bindings that mention the derived set join it;
  // repeat until nothing is added (loops can declare backwards).
  for (;;) {
    const before = derived.size;
    for (const s of rest) collectDerivedStmt(s, derived, assigned);
    if (derived.size === before) break;
  }
  let last = -1;
  for (let i = 0; i < rest.length; i++) if (!absentStmt(rest[i]!, derived)) last = i;
  return { extent: rest.slice(0, last + 1), derived };
}

/** Only bindings that are never assigned can hold a borrowed pointer
 * derived from another local: an assigned local owns its value (walk
 * locals root only at parameters, which own nothing to move). */
function collectDerivedStmt(
  s: IrStmt,
  derived: Set<string>,
  assigned: ReadonlySet<string>,
): boolean {
  if (
    (s.kind === "varDecl" || s.kind === "forOf" || s.kind === "assign") &&
    !derived.has(s.localId) &&
    !assigned.has(s.localId)
  ) {
    const value = s.kind === "varDecl" ? s.init : s.kind === "assign" ? s.value : s.iterable;
    // A fresh literal holds references of its own, never an alias.
    if (value !== null && !freshLiteral(value) && !absentExpr(value, derived)) derived.add(s.localId);
  }
  return everyStmtChild(
    s,
    (e) => collectDerivedExpr(e, derived, assigned),
    (c) => collectDerivedStmt(c, derived, assigned),
  );
}

function collectDerivedExpr(
  e: IrExpr,
  derived: Set<string>,
  assigned: ReadonlySet<string>,
): boolean {
  if (e.kind === "assignExpr" && !derived.has(e.localId) && !assigned.has(e.localId)) {
    if (!absentExpr(e.value, derived)) derived.add(e.localId);
  }
  return everyExprChild(
    e,
    (c) => collectDerivedExpr(c, derived, assigned),
    (s) => collectDerivedStmt(s, derived, assigned),
  );
}

function collectAssignedStmt(s: IrStmt, assigned: Set<string>): boolean {
  if (s.kind === "assign") assigned.add(s.localId);
  return everyStmtChild(
    s,
    (e) => collectAssignedExpr(e, assigned),
    (c) => collectAssignedStmt(c, assigned),
  );
}

function collectAssignedExpr(e: IrExpr, assigned: Set<string>): boolean {
  if (e.kind === "assignExpr" || e.kind === "incDec") assigned.add(e.localId);
  return everyExprChild(
    e,
    (c) => collectAssignedExpr(c, assigned),
    (s) => collectAssignedStmt(s, assigned),
  );
}

function freshLiteral(e: IrExpr): boolean {
  return e.kind === "recordLit" || e.kind === "dynObjLit" || e.kind === "dynArrLit" || e.kind === "arrayLit";
}

/** True while no node of the tree mentions a derived binding. */
function absentExpr(e: IrExpr, derived: ReadonlySet<string>): boolean {
  if (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") {
    if (derived.has(e.localId)) return false;
  } else if (e.kind === "closure" || e.kind === "classRef") {
    for (const id of e.captures ?? []) if (derived.has(id)) return false;
  }
  return everyExprChild(
    e,
    (c) => absentExpr(c, derived),
    (s) => absentStmt(s, derived),
  );
}

function absentStmt(s: IrStmt, derived: ReadonlySet<string>): boolean {
  if ((s.kind === "varDecl" || s.kind === "assign") && derived.has(s.localId)) return false;
  return everyStmtChild(
    s,
    (e) => absentExpr(e, derived),
    (c) => absentStmt(c, derived),
  );
}
