import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "../../ir/node-index.js";

const CLOSURE_KINDS: readonly IrNodeKind[] = ["closure"];

/** The local a node rebinds. Writes through the bound reference, such as a
 * field store or an array push, leave the binding unchanged. Catch bindings
 * and rethrow targets are conservatively treated as rebinding. */
function rebound(node: IrStmt | IrExpr): string | null {
  switch (node.kind) {
    case "varDecl":
    case "assign":
    case "forOf":
    case "rethrow":
    case "assignExpr":
    case "incDec":
      return node.localId;
    case "tryCatch":
      return node.catchLocalId;
    default:
      return null;
  }
}

/** A captured parameter that no code rebinds holds its entry value for the
 * whole call, so every environment may observe a box created when the first
 * closure is built instead of on function entry. Paths that never create a
 * closure then allocate no box. The proof follows each capture into nested
 * function bodies; class environments keep the eager box. */
export class LazyCaptures {
  private readonly stable = new Map<string, Set<string>>();
  private readonly once = new Map<string, Set<string>>();
  private readonly unchangedParameters = new Map<IrFunction, Set<string>>();
  /** Per function, every local rebound there or through nested captures;
   * the second map counts declarations separately (see rebindings). Each
   * body is walked once per map, so the queries stay linear in the IR. */
  private readonly rebound = new Map<IrFunction, Set<string>>();
  private readonly reboundAfterDeclaration = new Map<IrFunction, Set<string>>();
  private readonly pending = new Set<IrFunction>();
  private sites: Map<string, { owner: string; captures: string[] }[]> | null = null;

  constructor(
    private readonly functions: ReadonlyMap<string, IrFunction>,
    /** The module's node index, read instead of walking the bodies it holds. */
    private readonly nodes?: IrNodeIndex,
  ) {}

  /** The captures of closure body `fnName` that hold one value for the
   * closure's whole life: at every creation site the captured binding is
   * a parameter that nothing rebinds (see parameters) or, through nesting,
   * such a capture of the creating closure, and nothing rebinds the
   * capture itself. The environment owns that value whenever the body
   * runs, so the body may read it without a reference of its own. */
  stableCaptures(fnName: string): Set<string> {
    const known = this.stable.get(fnName);
    if (known !== undefined) return known;
    const result = new Set<string>();
    // Capture chains follow lexical nesting and cannot cycle; the empty
    // provisional entry only bounds work on malformed input.
    this.stable.set(fnName, result);
    const fn = this.functions.get(fnName);
    const sites = this.creationSites().get(fnName);
    if (fn?.captures === undefined || fn.async || fn.generator || sites === undefined)
      return result;
    fn.captures.forEach((capture, index) => {
      for (const site of sites) {
        const owner = this.functions.get(site.owner);
        const source = site.captures[index];
        if (owner === undefined || source === undefined) return;
        if (
          !this.parameters(owner).has(source) &&
          !this.declaredOnce(owner).has(source) &&
          !this.stableCaptures(site.owner).has(source)
        )
          return;
      }
      if (this.isUnchanged(fnName, capture.localId)) result.add(capture.localId);
    });
    return result;
  }

  /** Boxed locals of `fn` (not parameters) bound by exactly one
   * declaration that nothing else rebinds, here or in nested bodies. Each
   * declaration fills a fresh box once, before any closure can capture it
   * (TDZ bindings are excluded). */
  private declaredOnce(fn: IrFunction): Set<string> {
    const known = this.once.get(fn.name);
    if (known !== undefined) return known;
    const result = new Set<string>();
    this.once.set(fn.name, result);
    if (fn.async || fn.generator) return result;
    const params = new Set(fn.params.map((p) => p.localId));
    const candidates = new Set(
      fn.locals.filter((l) => l.boxed && !l.tdz && !params.has(l.id)).map((l) => l.id),
    );
    if (candidates.size === 0) return result;
    const declarations = new Map<string, number>();
    const visit = (node: IrStmt | IrExpr): boolean => {
      if (node.kind === "varDecl" && candidates.has(node.localId))
        declarations.set(node.localId, (declarations.get(node.localId) ?? 0) + 1);
      return true;
    };
    everyStmtList(fn.body, { stmt: visit, expr: visit });
    const changed = this.rebindings(fn, candidates, true);
    for (const id of candidates) if (declarations.get(id) === 1 && !changed.has(id)) result.add(id);
    return result;
  }

  private creationSites(): Map<string, { owner: string; captures: string[] }[]> {
    if (this.sites !== null) return this.sites;
    const sites = new Map<string, { owner: string; captures: string[] }[]>();
    const scan = this.nodes?.scan(CLOSURE_KINDS);
    for (const fn of this.functions.values()) {
      eachNodeOfKinds(fn, scan, (node) => {
        if (node.kind === "closure") {
          let list = sites.get(node.fnName);
          if (!list) sites.set(node.fnName, (list = []));
          list.push({ owner: fn.name, captures: node.captures });
        }
      });
    }
    this.sites = sites;
    return sites;
  }

  parameters(fn: IrFunction): ReadonlySet<string> {
    const known = this.unchangedParameters.get(fn);
    if (known !== undefined) return known;
    const result = new Set<string>();
    this.unchangedParameters.set(fn, result);
    if (fn.async || fn.generator) return result;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const param of fn.params) {
      const local = locals.get(param.localId);
      if (local?.boxed && !local.tdz) result.add(param.localId);
    }
    if (result.size === 0) return result;
    for (const id of this.rebindings(fn, result)) result.delete(id);
    return result;
  }

  /** The subset of `ids` rebound in `fn` or in any function that captures
   * one of them, directly or through further nesting. */
  private rebindings(
    fn: IrFunction,
    ids: ReadonlySet<string>,
    declarationsBind = false,
  ): Set<string> {
    const all = this.reboundIn(fn, declarationsBind);
    const changed = new Set<string>();
    for (const id of ids) if (all.has(id)) changed.add(id);
    return changed;
  }

  /** Every local rebound in `fn` or, through the closures it creates, in
   * any function that captures it, directly or through further nesting.
   * With `declarationsBind`, declarations are counted separately. */
  private reboundIn(fn: IrFunction, declarationsBind: boolean): ReadonlySet<string> {
    const memo = declarationsBind ? this.reboundAfterDeclaration : this.rebound;
    const known = memo.get(fn);
    if (known !== undefined) return known;
    const changed = new Set<string>();
    // Capture chains follow lexical nesting and cannot cycle; on malformed
    // input a function reached again while its walk is pending reports
    // every capture as rebound (see isUnchanged).
    if (!declarationsBind) this.pending.add(fn);
    const nested: { target: string; local: string; source: string }[] = [];
    const visit = (node: IrStmt | IrExpr): boolean => {
      const target = declarationsBind && node.kind === "varDecl" ? null : rebound(node);
      if (target !== null) changed.add(target);
      if (node.kind === "classRef") {
        for (const id of node.captures ?? []) changed.add(id);
      } else if (node.kind === "closure") {
        const callee = this.functions.get(node.fnName);
        node.captures.forEach((id, index) => {
          const capture = callee?.captures?.[index];
          if (!capture) changed.add(id);
          else nested.push({ target: node.fnName, local: capture.localId, source: id });
        });
      }
      return true;
    };
    everyStmtList(fn.body, { stmt: visit, expr: visit });
    for (const edge of nested) {
      if (!changed.has(edge.source) && !this.isUnchanged(edge.target, edge.local))
        changed.add(edge.source);
    }
    if (!declarationsBind) this.pending.delete(fn);
    memo.set(fn, changed);
    return changed;
  }

  private isUnchanged(fnName: string, localId: string): boolean {
    const fn = this.functions.get(fnName);
    if (fn === undefined || this.pending.has(fn)) return false;
    return !this.reboundIn(fn, false).has(localId);
  }
}
