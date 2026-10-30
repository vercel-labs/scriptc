import { matchIntegerPairedForLoop } from "./integer-loops.js";
import { analyzeIntegerRanges, type IntegerRange } from "./integer-ranges.js";
import {
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrParam,
  type IrStmt,
} from "./ir.js";
import { type IrFieldWalker, walkStmtFields } from "./fields.generated.js";
import { everyExprChild, everyStmtChild, mapExprChildren, mapStmtChildren } from "./traverse.js";

type WhileLoop = IrStmt & { kind: "while" };

/** Two-counter while loops run as two-counter for loops.
 *
 *   let lo = a, hi = b;
 *   while (lo < hi) { ...; lo++; hi--; }
 *
 * runs as `for (let l = lo, h = hi; l < h; l++, h--) { ... }`, whose
 * counters the backend stores as integers (matchIntegerPairedForLoop). The
 * loop qualifies when:
 * - its condition compares the two counters (`<`, `<=`, `>` or `>=`);
 * - its body ends with one update of each counter;
 * - no `continue` in the body binds to it (a for loop's `continue` runs the
 *   update, a while loop's skips the body's last statements);
 * - the function mentions neither counter outside the loop, except in one
 *   declaration or as a parameter;
 * - every entry starts from the declared or passed values: a declaration is
 *   an earlier statement of the loop's own statement list, which runs before
 *   each entry, and a loop over a parameter is in no other loop.
 *
 * The for loop's counters are new locals that start from the counters'
 * values on entry, so the declarations stay where they are and nothing
 * between them and the loop moves. The original counters are not read
 * after the loop, so they need no final value. A loop that the paired match
 * would refuse is left as it is. */
export function runPairedWhileLoopsAsFor(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const next = rewriteFunction(fn);
    if (next !== fn) changed = true;
    return next;
  });
  return changed ? { ...mod, functions } : mod;
}

/** The local a statement steps: `x++`, `x--` or `x = ...`. */
function updatedLocal(s: IrStmt): string | null {
  if (s.kind === "assign") return s.localId;
  if (s.kind === "exprStmt" && s.expr.kind === "incDec") return s.expr.localId;
  return null;
}

/** The counters of a loop with the qualifying condition and trailing
 * updates, or null. */
function loopCounters(loop: WhileLoop, locals: ReadonlyMap<string, IrLocal>): string[] | null {
  const cond = loop.cond;
  if (cond.kind !== "bin") return null;
  if (cond.op !== "<" && cond.op !== "<=" && cond.op !== ">" && cond.op !== ">=") return null;
  if (cond.left.kind !== "varRef" || cond.right.kind !== "varRef") return null;
  const counters = [cond.left.localId, cond.right.localId];
  if (counters[0] === counters[1]) return null;
  const n = loop.body.length;
  if (n < 2) return null;
  const updated = [updatedLocal(loop.body[n - 2]!), updatedLocal(loop.body[n - 1]!)];
  if (!counters.every((id) => updated.includes(id))) return null;
  for (const id of counters) {
    const local = locals.get(id);
    if (local?.type.kind !== "f64" || !local.mutable || local.boxed || local.tdz) return null;
  }
  return counters;
}

function isLoop(s: IrStmt): boolean {
  return s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf";
}

/** True when a `continue` in the body binds to the loop: an unlabeled one
 * outside nested loops, or one that names a label of the loop. */
function continuesLoop(loop: WhileLoop): boolean {
  const labels = loop.labels ?? [];
  let depth = 0;
  let found = false;
  const expr = (e: IrExpr): boolean => !found && everyExprChild(e, expr, stmt);
  const stmt = (s: IrStmt): boolean => {
    if (found) return false;
    if (s.kind === "continue") {
      if (s.label === undefined ? depth === 0 : labels.includes(s.label)) found = true;
      return !found;
    }
    const nested = isLoop(s);
    if (nested) depth++;
    const ok = everyStmtChild(s, expr, stmt);
    if (nested) depth--;
    return ok;
  };
  loop.body.every(stmt);
  return found;
}

/** Mentions of each id in `stmts`, in any field but types (a string
 * literal equal to an id counts too, which only refuses more loops). */
function countMentions(
  stmts: readonly IrStmt[],
  ids: ReadonlySet<string>,
  mentions: Map<string, number>,
): void {
  const walker: IrFieldWalker = {
    node: () => {},
    string: (value) => {
      if (ids.has(value)) mentions.set(value, (mentions.get(value) ?? 0) + 1);
    },
  };
  for (const stmt of stmts) walkStmtFields(stmt, walker, true);
}

/** A loop with the qualifying shape, the statements before it in its
 * statement list, and whether it is inside another loop. */
interface Candidate {
  loop: WhileLoop;
  counters: string[];
  before: readonly IrStmt[];
  nested: boolean;
}

function findCandidates(fn: IrFunction, locals: ReadonlyMap<string, IrLocal>): Candidate[] {
  const candidates: Candidate[] = [];
  let depth = 0;
  const list = (body: readonly IrStmt[]): void => {
    body.forEach((s, i) => {
      if (s.kind === "while") {
        const counters = loopCounters(s, locals);
        if (counters !== null && !continuesLoop(s))
          candidates.push({ loop: s, counters, before: body.slice(0, i), nested: depth > 0 });
      }
      visit(s);
    });
  };
  // Statement lists inside expressions are not searched: their loops stay.
  const visit = (s: IrStmt): void => {
    const loop = isLoop(s);
    if (loop) depth++;
    switch (s.kind) {
      case "block":
      case "while":
      case "doWhile":
      case "for":
      case "forOf":
        list(s.body);
        break;
      case "if":
        list(s.then);
        if (s.else_ !== null) list(s.else_);
        break;
      case "switch":
        for (const c of s.cases) list(c.body);
        break;
      case "tryCatch":
        list(s.tryBody);
        if (s.catchBody !== null) list(s.catchBody);
        if (s.finallyBody !== null) list(s.finallyBody);
        break;
      default:
        break;
    }
    if (loop) depth--;
  };
  list(fn.body);
  return candidates;
}

function rewriteFunction(fn: IrFunction): IrFunction {
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const candidates = findCandidates(fn, locals);
  if (candidates.length === 0) return fn;

  const ids = new Set<string>();
  for (const c of candidates) for (const id of c.counters) ids.add(id);
  const total = new Map<string, number>();
  countMentions(fn.body, ids, total);
  const params = new Set(fn.params.map((p) => p.localId));
  // A counter this function reaches through its environment.
  const outer = new Map<string, number>();
  const noteOuter = (param: IrParam): void => {
    for (const value of [param.localId, param.name])
      if (ids.has(value)) outer.set(value, (outer.get(value) ?? 0) + 1);
  };
  for (const param of fn.captures ?? []) noteOuter(param);
  for (const param of fn.classCaptures ?? []) noteOuter(param);

  let ranges: ReadonlyMap<IrExpr, IntegerRange | null> | null = null;
  const used = new Set(fn.locals.map((l) => l.id));
  const added: IrLocal[] = [];
  const rewritten = new Map<WhileLoop, Map<string, string>>();
  for (const { loop, counters, before, nested } of candidates) {
    const inside = new Map<string, number>();
    countMentions([loop], new Set(counters), inside);
    // Each counter's start: its declaration's initializer, or null for a
    // parameter.
    const starts = new Map<string, IrExpr | null>();
    for (const id of counters) {
      if ((outer.get(id) ?? 0) !== 0) break;
      const elsewhere = (total.get(id) ?? 0) - (inside.get(id) ?? 0);
      if (params.has(id)) {
        if (elsewhere === 0 && !nested) starts.set(id, null);
        continue;
      }
      const decl = before.find((s) => s.kind === "varDecl" && s.localId === id);
      if (elsewhere === 1 && decl?.kind === "varDecl" && decl.init !== null)
        starts.set(id, decl.init);
    }
    if (starts.size !== counters.length) continue;
    const renamed = new Map<string, string>();
    const fresh: IrLocal[] = [];
    for (const id of counters) {
      const local = locals.get(id);
      if (local === undefined) break;
      let k = 0;
      while (used.has(`${local.name}.${k}`)) k++;
      const next = `${local.name}.${k}`;
      used.add(next);
      renamed.set(id, next);
      fresh.push({ ...local, id: next });
    }
    if (renamed.size !== counters.length) {
      for (const local of fresh) used.delete(local.id);
      continue;
    }
    const candidate = pairedForLoop(loop, renamed);
    const forLocals = new Map(locals);
    for (const local of fresh) forLocals.set(local.id, local);
    // A start reads its counter on entry, which holds the initializer's
    // value, with that value's range.
    ranges ??= analyzeIntegerRanges(fn);
    const startRanges = new Map<IrExpr, IntegerRange | null>();
    if (candidate.init?.kind === "block")
      for (const decl of candidate.init.body) {
        if (decl.kind !== "varDecl" || decl.init?.kind !== "varRef") continue;
        const init = starts.get(decl.init.localId);
        if (!init) continue;
        const literal =
          init.kind === "numLit" && Number.isSafeInteger(init.value) && !Object.is(init.value, -0);
        startRanges.set(
          decl.init,
          literal ? { min: init.value, max: init.value } : (ranges.get(init) ?? null),
        );
      }
    if (matchIntegerPairedForLoop(candidate, forLocals, startRanges) === null) {
      for (const local of fresh) used.delete(local.id);
      continue;
    }
    rewritten.set(loop, renamed);
    added.push(...fresh);
  }
  if (rewritten.size === 0) return fn;

  const expr = (e: IrExpr): IrExpr => mapExprChildren(e, expr, stmt);
  const stmt = (s: IrStmt): IrStmt => {
    const next = mapStmtChildren(s, expr, stmt);
    const renamed = s.kind === "while" ? rewritten.get(s) : undefined;
    // The body may hold rewritten loops of its own.
    return renamed === undefined ? next : pairedForLoop(next as WhileLoop, renamed);
  };
  return { ...fn, body: fn.body.map(stmt), locals: [...fn.locals, ...added] };
}

/** The for loop over the renamed counters: their starts read the original
 * counters, and the body's two trailing updates become the update. */
function pairedForLoop(
  loop: WhileLoop,
  renamed: ReadonlyMap<string, string>,
): IrStmt & { kind: "for" } {
  // Each copy spreads one node kind.
  const expr = (e: IrExpr): IrExpr => {
    const next = mapExprChildren(e, expr, stmt);
    if (next.kind === "varRef") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    } else if (next.kind === "incDec") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    } else if (next.kind === "assignExpr") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    }
    return next;
  };
  const stmt = (s: IrStmt): IrStmt => {
    const next = mapStmtChildren(s, expr, stmt);
    if (next.kind === "varDecl") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    } else if (next.kind === "assign") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    } else if (next.kind === "forOf") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    } else if (next.kind === "rethrow") {
      const id = renamed.get(next.localId);
      if (id !== undefined) return { ...next, localId: id };
    }
    return next;
  };
  const loc = loop.loc;
  const n = loop.body.length;
  const declarations: IrStmt[] = [];
  for (const [id, next] of renamed)
    declarations.push({
      kind: "varDecl",
      localId: next,
      init: { kind: "varRef", localId: id, type: F64, loc },
      loc,
    });
  const result: IrStmt & { kind: "for" } = {
    kind: "for",
    init: { kind: "block", body: declarations, loc },
    cond: expr(loop.cond),
    update: { kind: "block", body: loop.body.slice(n - 2).map(stmt), loc },
    body: loop.body.slice(0, n - 2).map(stmt),
    loc,
  };
  if (loop.labels !== undefined) result.labels = loop.labels;
  return result;
}
