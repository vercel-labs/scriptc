import { isRefCounted, type IrExpr, type IrFunction, type IrLocal } from "../../ir/ir.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "../../ir/node-index.js";

/** What the emitter knows about a projection's storage. */
export interface WalkBorrowHost {
  /** The local holds one plain reference pointer (instances, records,
   * arrays, strings, nullable-pointer unions). Tagged union boxes, closures
   * and dynamic values keep ownership. */
  pointerLocal(local: IrLocal): boolean;
  /** emitReadReceiver yields this expression's pointer without acquiring a
   * reference (class casts, nullable wraps, plain field reads, checked
   * ternaries). */
  borrowsWithoutOwning(e: IrExpr): boolean;
  /** The callee returns a borrowed walk of its arguments (findWalkBorrows'
   * returnsWalk); a call to it with walk arguments is itself a walk. */
  borrowedReturn?(callee: string): boolean;
  /** Parameters that may become candidates; once calling conventions are
   * fixed, only borrowed parameters qualify. Defaults to every parameter. */
  parameterAllowed?(localId: string): boolean;
  /** For bodies that may write the heap: whether a walk only reads
   * locations the whole body never writes, given the current candidates
   * (whose own rebinding releases nothing). Absent: the body preserves
   * every edge. */
  unwritten?(value: IrExpr, candidates: ReadonlySet<string>): boolean;
  /** The module's node index, read instead of walking the body. */
  nodes?: IrNodeIndex;
}

/** The node kinds analyzeWalks reads from a body. */
const WALK_KINDS: readonly IrNodeKind[] = [
  "varDecl",
  "assign",
  "forOf",
  "rethrow",
  "tryCatch",
  "return",
  "assignExpr",
  "incDec",
  "closure",
  "classRef",
];

export interface WalkFacts {
  locals: ReadonlySet<string>;
  /** Every return yields a walk (or a throw), so the body can return its
   * pointer without a reference: no try statement, at least one return. */
  returnsWalk: boolean;
}

/** Locals (including rebound parameters) that may hold borrowed pointers
 * for their whole lifetime: every definition (declaration or statement
 * assignment) is a projection of an unwritten parameter or of another such
 * local, for example the parent walk `let p = node.parent; while (p.parent)
 * p = p.parent;`. A rebound parameter in the result keeps the borrowed
 * calling convention.
 *
 * Soundness rests on the whole body preserving heap edges (the caller
 * passes only functions in ReferenceEffects.functions, or supplies
 * `unwritten` to admit only walks over locations the body never writes;
 * the argument below then applies to those locations): neither the body
 * nor anything it calls removes a field, element or global reference, so
 * every object reachable from a parameter at entry stays reachable (and
 * alive) until the function returns. Such a local therefore needs no
 * retain on definition, no release on rebinding and none at scope exit.
 * Whole-value uses (returns, stores, owned arguments) still retain their
 * own copies when they read the binding. Other locals may be rebound
 * freely: they never root a walk, so releasing their old values cannot free
 * an object the walk reaches. */
export function findWalkBorrows(fn: IrFunction, host: WalkBorrowHost): ReadonlySet<string> {
  return analyzeWalks(fn, host).locals;
}

export function analyzeWalks(fn: IrFunction, host: WalkBorrowHost): WalkFacts {
  const result = new Set<string>();
  if (fn.async || fn.generator || fn.captures || fn.classCaptures)
    return { locals: result, returnsWalk: false };
  const returns: (IrExpr | null)[] = [];
  let guarded = false;
  const params = new Set(fn.params.map((param) => param.localId));
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const definitions = new Map<string, (IrExpr | null)[]>();
  // Locals written in any other way (expression assignments, loop and catch
  // bindings, captures) keep the ordinary owned representation.
  const excluded = new Set<string>();
  const define = (id: string, value: IrExpr | null): void => {
    let list = definitions.get(id);
    if (!list) definitions.set(id, (list = []));
    list.push(value);
  };
  eachNodeOfKinds(fn, host.nodes?.scan(WALK_KINDS), (node) => {
    switch (node.kind) {
      case "varDecl":
        define(node.localId, node.init);
        break;
      case "assign":
        define(node.localId, node.value);
        break;
      case "forOf":
        excluded.add(node.localId);
        break;
      case "rethrow":
        excluded.add(node.localId);
        break;
      case "tryCatch":
        guarded = true;
        if (node.catchLocalId !== null) excluded.add(node.catchLocalId);
        break;
      case "return":
        returns.push(node.value);
        break;
      case "assignExpr":
      case "incDec":
        excluded.add(node.localId);
        break;
      case "closure":
      case "classRef":
        for (const id of node.captures ?? []) excluded.add(id);
        break;
    }
  });
  const plain = (id: string): boolean => {
    const local = locals.get(id);
    return (
      !!local &&
      !local.boxed &&
      !local.tdz &&
      !excluded.has(id) &&
      host.pointerLocal(local) &&
      (!params.has(id) || host.parameterAllowed?.(id) !== false)
    );
  };
  // Parameters are roots only while no definition rebinds them. A
  // parameter rebound by statement assignments alone (`t = t.regular`) is a
  // candidate like any local: its incoming value is the caller's borrow.
  const roots = new Set([...params].filter((id) => !definitions.has(id) && plain(id)));
  const candidates = new Set<string>();
  for (const [id, values] of definitions) {
    if (!plain(id)) continue;
    if (params.has(id) && values.some((value) => value === null)) continue;
    candidates.add(id);
  }
  // A walk projects roots or candidates through reads that never acquire a
  // reference. Drop candidates until every definition is such a walk.
  const walk = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
        return roots.has(e.localId) || candidates.has(e.localId);
      case "fieldGet":
      case "recordGet":
        return host.borrowsWithoutOwning(e) && walk(e.obj);
      // A required element of a walked array (the read still traps when the
      // element is missing).
      case "arrayGet":
        return host.borrowsWithoutOwning(e) && walk(e.arr);
      case "unionNarrow":
      case "downcast":
      case "upcast":
        return host.borrowsWithoutOwning(e) && walk(e.value);
      case "unionWrap":
        if (!host.borrowsWithoutOwning(e)) return false;
        return e.value.kind === "unitLit" || walk(e.value);
      // Each arm is itself a walk (or a throw), which emitReadReceiver reads
      // without owning.
      case "ternary":
        return host.borrowsWithoutOwning(e) && walkOrThrow(e.then) && walkOrThrow(e.else_);
      // A borrowed result is reachable from walk arguments.
      case "call":
        return (
          host.borrowedReturn?.(e.callee) === true &&
          host.borrowsWithoutOwning(e) &&
          e.args.every((arg) => !isRefCounted(arg.type) || walk(arg))
        );
      default:
        return false;
    }
  };
  const isThrow = (e: IrExpr): boolean => e.kind === "libCall" && e.fn === "error.nodeThrow";
  const walkOrThrow = (e: IrExpr): boolean => isThrow(e) || walk(e);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of candidates) {
      if (
        definitions
          .get(id)!
          .every(
            (value) =>
              value === null || (walk(value) && host.unwritten?.(value, candidates) !== false),
          )
      )
        continue;
      candidates.delete(id);
      changed = true;
    }
  }
  for (const id of candidates) result.add(id);
  const returnsWalk =
    !guarded &&
    returns.length > 0 &&
    returns.every(
      (value) =>
        value !== null &&
        walkOrThrow(value) &&
        (isThrow(value) || host.unwritten?.(value, candidates) !== false),
    );
  return { locals: result, returnsWalk };
}
