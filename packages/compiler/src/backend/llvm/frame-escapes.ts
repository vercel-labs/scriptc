/* Frame escapes (stack-objects.ts): the locals whose value provably dies
 * before their function returns, so that an object bound to one can live in
 * the frame.
 *
 * A local stays in the frame when every use of its value does: field and
 * element reads and writes through it (storing into it is fine), length and
 * search operations, identity comparisons, a statement that discards it, and
 * passing it to a parameter that itself stays in its callee's frame
 * (region-ir.ts keepsInFrame). A value that a conditional, a union wrap or
 * narrow, a cast or a sequence passes on takes that expression's fate. A
 * `const` binding of the value in the same function shares the local's fate:
 * it is declared inside the local's scope, so it cannot outlive it.
 *
 * A closure that captures the local keeps it in the frame when the closure
 * itself stays in the frame (it is only invoked, or passed to a parameter
 * that stays in its callee's frame) and its body keeps the captured binding
 * in the frame. The binding's box then never outlives the frame either.
 *
 * Everything else escapes: returning or throwing it, storing the value
 * itself anywhere (a field, an element, a collection, a module global or
 * another binding by assignment), capturing it in a closure that escapes or
 * in a local class, converting it, and every call whose target is not a
 * known function with a proven parameter.
 *
 * Parameter and capture facts are solved optimistically, like
 * CallLifetimes: every reference parameter stays in its callee's frame, and
 * every captured binding in its closure's, until a use proves otherwise.
 * They are solved on demand: a query explores only the facts its answer
 * depends on (a parameter's fact depends on the calls its own value reaches),
 * and each function's body is walked once into a summary of those uses.
 * Async functions, generators and module code have no facts, since their
 * frames can outlive a call or are the program's own. */
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import {
  isExpr,
  indexOfNode,
  keepsInFrame,
  same,
  refType,
  transparent,
  type Node,
} from "./region-ir.js";

export interface FrameEscapes {
  /** The reference locals of `fn` whose value never leaves its frame:
   * never assigned after its declaration, captured only by closures that
   * keep it in the frame, and every use keeping it in the frame. */
  locals(fn: IrFunction): ReadonlySet<string>;
  /** Whether argument `index` of a call of `callee` stays in the callee's
   * frame. */
  parameterStays(callee: string, index: number): boolean;
}

function suspends(fn: IrFunction): boolean {
  return fn.async === true || fn.generator !== undefined || /^%(init\.\d+|main)$/.test(fn.name);
}

/** A use whose fate a fact decides: argument `index` of a call of `fn`
 * (`index` >= 0), or a binding `id` that a closure of lifted function `fn`
 * captures. */
interface FactUse {
  fn: string;
  index: number;
  id: string;
}

/** What one walk of a function's body finds, by value group: a `const`
 * binding of a value shares its fate, and a closure that of the locals it
 * captures. */
interface Summary {
  /** The representative of each grouped value. */
  root: Map<string, string>;
  /** Groups that escape whatever the facts say. */
  escaping: Set<string>;
  /** Per group, the uses whose facts decide it. */
  uses: Map<string, FactUse[]>;
}

const NO_USES: readonly FactUse[] = [];
const NO_PARAMETERS: ReadonlyMap<string, Set<number>> = new Map();

/** Walks `fn` once. */
function summarize(fn: IrFunction): Summary {
  const escapes = new Set<string>();
  const facts: { id: string; use: FactUse }[] = [];
  const own = new Set(fn.locals.map((l) => l.id));
  const group = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (group.has(root)) root = group.get(root)!;
    return root;
  };
  const unite = (a: string, b: string): void => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) group.set(ra, rb);
  };
  const declared = new Map<string, number>();
  // Captured bindings that a closure node of this function captures.
  const closureCaptured = new Set<string>();
  let closures = 0;
  const parents: Node[] = [];
  /** The fate of the value `node` produces: shared with the binding a
   * `const` declaration gives it, kept by its consumer, decided by a
   * parameter fact, or escaping. */
  const fate = (node: Node, id: string): void => {
    let value: Node = node;
    let at = parents.length - 1;
    while (at >= 0 && transparent(value, parents[at])) value = parents[at--]!;
    const parent = at >= 0 ? parents[at] : undefined;
    if (
      parent?.kind === "varDecl" &&
      parent.init !== null &&
      same(parent.init, value) &&
      own.has(parent.localId) &&
      parent.localId !== id
    )
      unite(id, parent.localId);
    else if (parent?.kind === "call") {
      const index = indexOfNode(parent.args, value);
      if (index >= 0) facts.push({ id, use: { fn: parent.callee, index, id: "" } });
      else escapes.add(id);
    } else if (!keepsInFrame(value, parent, NO_PARAMETERS)) escapes.add(id);
  };
  const walk = (node: Node): void => {
    if (node.kind === "varDecl") declared.set(node.localId, (declared.get(node.localId) ?? 0) + 1);
    if (node.kind === "assign" || node.kind === "assignExpr" || node.kind === "incDec")
      escapes.add(node.localId);
    if (node.kind === "classRef") for (const id of node.captures ?? []) escapes.add(id);
    if (node.kind === "closure") {
      const closure = `%closure.${closures++}`;
      fate(node, closure);
      for (const id of node.captures ?? []) {
        closureCaptured.add(id);
        unite(id, closure);
        facts.push({ id, use: { fn: node.fnName, index: -1, id } });
      }
    }
    if (node.kind === "varRef") {
      fate(node, node.localId);
      return;
    }
    parents.push(node);
    if (isExpr(node)) everyExprChild(node, visitExpr, visitStmt);
    else everyStmtChild(node, visitExpr, visitStmt);
    parents.pop();
  };
  const visitExpr = (child: IrExpr): boolean => {
    walk(child);
    return true;
  };
  const visitStmt = (child: IrStmt): boolean => {
    walk(child);
    return true;
  };
  for (const stmt of fn.body) walk(stmt);
  const lifted = new Set((fn.captures ?? []).map((c) => c.localId));
  for (const local of fn.locals) {
    if (local.boxed === true && !lifted.has(local.id) && !closureCaptured.has(local.id))
      escapes.add(local.id);
    if ((declared.get(local.id) ?? 0) > 1) escapes.add(local.id);
  }
  const root = new Map<string, string>();
  for (const id of group.keys()) root.set(id, find(id));
  const rootOf = (id: string): string => root.get(id) ?? id;
  const escaping = new Set<string>();
  for (const id of escapes) escaping.add(rootOf(id));
  const uses = new Map<string, FactUse[]>();
  for (const { id, use } of facts) {
    const r = rootOf(id);
    if (escaping.has(r)) continue;
    let list = uses.get(r);
    if (!list) uses.set(r, (list = []));
    list.push(use);
  }
  return { root, escaping, uses };
}

export function analyzeFrameEscapes(mod: IrModule): FrameEscapes {
  const fns = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const summaries = new Map<string, Summary>();
  const summaryOf = (fn: IrFunction): Summary => {
    let summary = summaries.get(fn.name);
    if (summary === undefined) {
      summary = summarize(fn);
      summaries.set(fn.name, summary);
    }
    return summary;
  };
  /** A fact's key, the binding in its function that it is about, or null
   * when the fact is false from the start. */
  const subject = (use: FactUse): { key: string; fn: IrFunction; id: string } | null => {
    const fn = fns.get(use.fn);
    if (fn === undefined || suspends(fn)) return null;
    if (use.index >= 0) {
      const param = fn.params[use.index];
      if (param === undefined || !refType(param.type)) return null;
      return { key: `${use.fn}#${use.index}`, fn, id: param.localId };
    }
    if (!(fn.captures ?? []).some((c) => c.localId === use.id)) return null;
    return { key: `${use.fn}@${use.id}`, fn, id: use.id };
  };
  const solved = new Map<string, boolean>();
  /** The facts `uses` decide, solved over the facts they depend on that are
   * not solved yet: a greatest fixpoint on that part of the graph. */
  const solve = (uses: readonly FactUse[]): void => {
    const pending = new Map<string, { ok: boolean; deps: string[] }>();
    const stack: FactUse[] = [...uses];
    while (stack.length > 0) {
      const use = stack.pop()!;
      const s = subject(use);
      if (s === null || solved.has(s.key) || pending.has(s.key)) continue;
      const summary = summaryOf(s.fn);
      const r = summary.root.get(s.id) ?? s.id;
      const node = { ok: !summary.escaping.has(r), deps: [] as string[] };
      pending.set(s.key, node);
      if (!node.ok) continue;
      for (const dep of summary.uses.get(r) ?? NO_USES) {
        const d = subject(dep);
        if (d === null) {
          node.ok = false;
          break;
        }
        node.deps.push(d.key);
        stack.push(dep);
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const node of pending.values())
        if (node.ok && node.deps.some((d) => !(solved.get(d) ?? pending.get(d)!.ok))) {
          node.ok = false;
          changed = true;
        }
    }
    for (const [key, node] of pending) solved.set(key, node.ok);
  };
  /** Whether every use in `uses` keeps its value in the frame. */
  const allStay = (uses: readonly FactUse[]): boolean => {
    solve(uses);
    for (const use of uses) {
      const s = subject(use);
      if (s === null || solved.get(s.key) !== true) return false;
    }
    return true;
  };
  const locals = new Map<string, ReadonlySet<string>>();
  return {
    parameterStays(callee: string, index: number): boolean {
      return allStay([{ fn: callee, index, id: "" }]);
    },
    locals(fn: IrFunction): ReadonlySet<string> {
      let kept = locals.get(fn.name);
      if (kept === undefined) {
        const set = new Set<string>();
        if (!suspends(fn)) {
          const summary = summaryOf(fn);
          for (const local of fn.locals) {
            if (!refType(local.type)) continue;
            const r = summary.root.get(local.id) ?? local.id;
            if (!summary.escaping.has(r) && allStay(summary.uses.get(r) ?? NO_USES))
              set.add(local.id);
          }
        }
        locals.set(fn.name, (kept = set));
      }
      return kept;
    },
  };
}
