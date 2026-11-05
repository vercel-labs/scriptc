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
  return lastUseIn(last, localId, derived);
}

/** The binding's read in `last`, the last statement of its extent, whose derived bindings are `derived`. */
function lastUseIn(
  last: IrStmt,
  localId: string,
  derived: ReadonlySet<string>,
): { read: IrExpr; stored: boolean } | null {
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
    } else if (e.kind === "recordLit") {
      if (e.fields.some((f) => isRead(f.value))) state.stored = true;
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
    if (value !== null && !absentExpr(value, derived)) derived.add(s.localId);
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

/**
 * `storedLastUseRead(stmts, -1, localId, true)` for every parameter of one function body, from one walk of the
 * body instead of a walk per binding. With `index` -1 and `rebound`, no binding is excluded as assigned, so a
 * binding is derived when one of its definitions mentions a derived binding (reachability over "definition
 * mentions") and the extent ends at the last statement that mentions one (`absentStmt`). The walk records, for
 * each top-level statement, the bindings it mentions, and for each definition, the bindings its value mentions.
 */
export class BodyLastUses {
  private readonly stmts: readonly IrStmt[];
  /** The bindings each top-level statement mentions, as `absentStmt` reads them. */
  private readonly mentions: Set<string>[] = [];
  /** For each binding, the bindings whose definitions mention it. */
  private readonly definedFrom = new Map<string, string[]>();

  constructor(stmts: readonly IrStmt[]) {
    this.stmts = stmts;
    for (const s of stmts) {
      const mentioned = new Set<string>();
      this.stmt(s, mentioned);
      this.mentions.push(mentioned);
    }
  }

  /** What `storedLastUseRead(stmts, -1, localId, true)` answers. */
  storedRead(localId: string): IrExpr | null {
    const derived = new Set<string>([localId]);
    const queue = [localId];
    while (queue.length > 0) {
      for (const target of this.definedFrom.get(queue.pop()!) ?? [])
        if (!derived.has(target)) {
          derived.add(target);
          queue.push(target);
        }
    }
    let last = -1;
    for (let i = this.mentions.length - 1; i >= 0 && last < 0; i--)
      for (const id of derived)
        if (this.mentions[i]!.has(id)) {
          last = i;
          break;
        }
    if (last < 0) return null;
    const use = lastUseIn(this.stmts[last]!, localId, derived);
    return use !== null && use.stored ? use.read : null;
  }

  /** Adds the bindings `s` mentions to `into`, and records the definitions in it. */
  private stmt(s: IrStmt, into: Set<string>): boolean {
    if (s.kind === "varDecl" || s.kind === "assign") into.add(s.localId);
    if (s.kind === "varDecl" || s.kind === "forOf" || s.kind === "assign") {
      const value = s.kind === "varDecl" ? s.init : s.kind === "assign" ? s.value : s.iterable;
      if (value !== null) this.define(s.localId, value);
    }
    everyStmtChild(
      s,
      (e) => this.expr(e, into),
      (c) => this.stmt(c, into),
    );
    return true;
  }

  private expr(e: IrExpr, into: Set<string>): boolean {
    if (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") into.add(e.localId);
    else if (e.kind === "closure" || e.kind === "classRef")
      for (const id of e.captures ?? []) into.add(id);
    if (e.kind === "assignExpr") this.define(e.localId, e.value);
    everyExprChild(
      e,
      (c) => this.expr(c, into),
      (c) => this.stmt(c, into),
    );
    return true;
  }

  /** A definition of `target` whose value is `value`: every binding the value mentions derives `target`. */
  private define(target: string, value: IrExpr): void {
    const mentioned = new Set<string>();
    mentionsOf(value, mentioned);
    for (const id of mentioned) {
      let targets = this.definedFrom.get(id);
      if (targets === undefined) this.definedFrom.set(id, (targets = []));
      targets.push(target);
    }
  }
}

/** The bindings an expression mentions, as `absentExpr` reads them. */
function mentionsOf(e: IrExpr, into: Set<string>): void {
  const expr = (x: IrExpr): boolean => {
    if (x.kind === "varRef" || x.kind === "assignExpr" || x.kind === "incDec") into.add(x.localId);
    else if (x.kind === "closure" || x.kind === "classRef")
      for (const id of x.captures ?? []) into.add(id);
    everyExprChild(x, expr, stmt);
    return true;
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "varDecl" || s.kind === "assign") into.add(s.localId);
    everyStmtChild(s, expr, stmt);
    return true;
  };
  expr(e);
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
