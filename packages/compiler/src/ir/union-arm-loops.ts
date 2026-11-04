import {
  BOOL,
  isUnitType,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
  type IrUnionDef,
} from "./ir.js";
import { lacksKinds, type IrNodeIndex, type IrNodeKind } from "./node-index.js";
import {
  everyStmtList,
  mapExprChildren,
  mapStmtChildren,
  transformStmt,
  type IrTransform,
} from "./traverse.js";

/** Union arm loops.
 *
 * A loop that indexes a union of typed-array classes dispatches every
 * element: `xs[i]` lowers to a tag test per element and a payload
 * extraction per element, so the loop keeps a bounds branch and a tag branch
 * and cannot vectorize. The bound proof and the loop versions want a
 * `varRef` of the arm's own type as the receiver, which a narrowed union arm
 * is not.
 *
 * This pass binds the arm once, before the loop: the loop is copied per arm
 * behind one tag test, each copy reached through a local bound to the
 * narrowed arm, and inside a copy the dispatch on that same value is folded
 * away — its tag tests become constants and the narrowed reads become reads
 * of the bound local. The bound proofs then see `b.length` and `b[i]`, the
 * loop takes one integer counter with no per-element check, and the tag chain
 * runs once per arm per entry instead of once per element.
 *
 * A loop qualifies when:
 * - it narrows a union of at least two payload-carrying arms (no unit arm:
 *   `unionNarrow` has no payload to bind there);
 * - it indexes an element through a narrowed arm of a plain local (`varRef`)
 *   of the union's type, which is the value it is versioned for: a loop that
 *   narrows several values takes the one it narrows most, and a loop that only
 *   narrows (a `typeof` probe, say) is left alone;
 * - that local is never assigned in the function and not declared inside the
 *   loop, so the tag it holds cannot change while the loop runs (a boxed or
 *   TDZ local is excluded: its writes happen elsewhere);
 * - the copies stay small (the arm count times the loop's node count is under
 *   MAX_VERSION_COST, and one function's versions together stay under
 *   MAX_FUNCTION_COST). A larger loop keeps today's per-element dispatch.
 *
 * `nodes`, an index of `mod`, lets the pass skip the functions that hold no
 * `unionNarrow` at all. */
const NARROW_KINDS: readonly IrNodeKind[] = ["unionNarrow"];

/** The nodes the copies of one versioned loop may hold, all arms together. */
const MAX_VERSION_COST = 480;

/** The nodes one function's versions may add together: nested loops over
 * different unions multiply, and their copies must not grow without bound. */
const MAX_FUNCTION_COST = 2000;

/** The most arms one loop is versioned for. */
const MAX_ARMS = 4;

type LoopStmt = IrStmt & { kind: "for" | "while" | "doWhile" };

export function versionUnionArmLoops(mod: IrModule, nodes?: IrNodeIndex): IrModule {
  if ((mod.unions?.length ?? 0) === 0) return mod;
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  const scan = nodes?.scan(NARROW_KINDS);
  let changed = false;
  const functions = mod.functions.map((fn) => {
    if (lacksKinds(fn, scan)) return fn;
    const next = rewriteFunction(fn, unions);
    if (next !== fn) changed = true;
    return next;
  });
  return changed ? { ...mod, functions } : mod;
}

/** The locals a function writes (not declares) and the narrows it holds. */
interface Facts {
  written: Set<string>;
  narrows: number;
}

function functionFacts(fn: IrFunction): Facts {
  const written = new Set<string>();
  let narrows = 0;
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "unionNarrow") narrows++;
      else if (e.kind === "assignExpr" || e.kind === "incDec") written.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "assign" || s.kind === "forOf") written.add(s.localId);
      return true;
    },
  });
  return { written, narrows };
}

function isLoop(s: IrStmt): s is LoopStmt {
  return s.kind === "for" || s.kind === "while" || s.kind === "doWhile";
}

/** One narrowing dispatch on the loop's source value. */
interface Source {
  id: string;
  unionId: string;
  /** Narrowed reads of this value in the loop. */
  count: number;
  /** The loop indexes an element through a narrowed arm of this value. */
  indexed: boolean;
}

/** The receiver of an element access, when `e` is one. */
function elementReceiver(e: IrExpr | IrStmt): IrExpr | null {
  switch (e.kind) {
    case "bytesIntrinsic":
      return e.method === "get" ? e.receiver : null;
    case "arrIntrinsic":
      return e.receiver;
    case "bytesSet":
    case "arrayGet":
    case "arraySet":
    case "arrayHas":
    case "arrayState":
      return e.arr;
    default:
      return null;
  }
}

/** The source value whose arms the loop indexes, or null when it indexes
 * none: the pass exists for element access per arm, and versioning a loop
 * that only narrows (string/number probes, say) would duplicate code with
 * nothing to gain. */
function loopSource(loop: LoopStmt): Source | null {
  const sources = new Map<string, Source>();
  const source = (id: string, unionId: string): Source => {
    let entry = sources.get(id);
    if (entry === undefined) sources.set(id, (entry = { id, unionId, count: 0, indexed: false }));
    else if (entry.unionId !== unionId) entry.count = -1;
    return entry;
  };
  const access = (e: IrExpr | IrStmt): void => {
    const receiver = elementReceiver(e);
    if (receiver === null || receiver.kind !== "unionNarrow" || receiver.value.kind !== "varRef")
      return;
    source(receiver.value.localId, receiver.unionId).indexed = true;
  };
  everyStmtList([loop], {
    expr: (e) => {
      access(e);
      if (e.kind === "unionNarrow" && e.value.kind === "varRef")
        source(e.value.localId, e.unionId).count++;
      return true;
    },
    stmt: (s) => {
      access(s);
      return true;
    },
  });
  let best: Source | null = null;
  for (const entry of sources.values())
    if (entry.count > 0 && entry.indexed && (best === null || entry.count > best.count))
      best = entry;
  return best;
}

/** The locals the loop declares, which may not be bound before it. */
function loopDeclarations(loop: LoopStmt): Set<string> {
  const declared = new Set<string>();
  everyStmtList([loop], {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "varDecl") declared.add(s.localId);
      return true;
    },
  });
  return declared;
}

function nodeCount(loop: LoopStmt): number {
  let count = 0;
  everyStmtList([loop], {
    expr: () => {
      count++;
      return true;
    },
    stmt: () => {
      count++;
      return true;
    },
  });
  return count;
}

interface Context {
  unions: ReadonlyMap<string, IrUnionDef>;
  locals: ReadonlyMap<string, IrLocal>;
  written: ReadonlySet<string>;
  used: Set<string>;
  added: IrLocal[];
  sequence: number;
  /** The nodes this function's versions may still add (MAX_FUNCTION_COST). */
  budget: number;
  /** Rewrites one statement, versioning the loops in it that are not
   * versioned yet (the copies of a versioned loop hold their own nested
   * loops, which a different arm may index). */
  rewrite: (s: IrStmt) => IrStmt;
}

function rewriteFunction(fn: IrFunction, unions: ReadonlyMap<string, IrUnionDef>): IrFunction {
  const facts = functionFacts(fn);
  if (facts.narrows === 0) return fn;
  let changed = false;
  const context: Context = {
    unions,
    locals: new Map(fn.locals.map((l) => [l.id, l])),
    written: facts.written,
    used: new Set(fn.locals.map((l) => l.id)),
    added: [],
    sequence: 0,
    budget: MAX_FUNCTION_COST,
    rewrite: (s) => rewrite(s),
  };
  const rewrite = (s: IrStmt): IrStmt => {
    if (isLoop(s)) {
      const versioned = versionLoop(s, context);
      if (versioned !== null) {
        changed = true;
        return versioned;
      }
    }
    return mapStmtChildren(s, identityExpr, rewrite);
  };
  const body = fn.body.map(rewrite);
  if (!changed) return fn;
  return { ...fn, body, locals: [...fn.locals, ...context.added] };
}

function identityExpr(e: IrExpr): IrExpr {
  return e;
}

/** The loop behind one tag test per arm, or null when it does not qualify. */
function versionLoop(loop: LoopStmt, context: Context): IrStmt | null {
  const source = loopSource(loop);
  if (source === null) return null;
  const local = context.locals.get(source.id);
  if (local === undefined || local.boxed === true || local.tdz === true) return null;
  if (context.written.has(source.id)) return null;
  if (local.type.kind !== "union" || local.type.unionId !== source.unionId) return null;
  const union = context.unions.get(source.unionId);
  if (union === undefined) return null;
  const arms = union.arms;
  if (arms.length < 2 || arms.length > MAX_ARMS) return null;
  if (!arms.some((arm) => arm.kind === "bytes")) return null;
  for (const arm of arms) if (isUnitType(arm)) return null;
  if (loopDeclarations(loop).has(source.id)) return null;
  const copies = nodeCount(loop) * arms.length;
  if (copies > MAX_VERSION_COST || copies > context.budget) return null;
  // Nested loops in the copies draw on the same budget as they are versioned.
  context.budget -= copies;

  const loc = loop.loc;
  const bindingType = local.type;
  const sourceRef = (): IrExpr => ({ kind: "varRef", localId: source.id, type: bindingType, loc });
  const declarations: IrStmt[] = [];
  const bodies: IrStmt[][] = [];
  for (let tag = 0; tag < arms.length; tag++) {
    const arm = arms[tag]!;
    const id = freshId(`${local.name}.arm`, context);
    context.added.push({ id, name: local.name, type: arm, mutable: false });
    declarations.push({
      kind: "varDecl",
      localId: id,
      init: {
        kind: "unionNarrow",
        unionId: union.id,
        tag,
        value: sourceRef(),
        type: arm,
        loc,
      },
      loc,
    });
    const copy = transformStmt(loop, clone);
    // The copy's own dispatch on the bound value is folded away, so its
    // nested loops can only qualify on another value.
    const specialized = specialize([copy], union.id, source.id, tag, id).map((s) =>
      mapStmtChildren(s, identityExpr, context.rewrite),
    );
    bodies.push(specialized);
  }

  // The last arm needs no test: the preceding tests rule out every other tag
  // and the bound narrow verifies the arm it binds (narrow-guards.ts).
  let chain: IrStmt[] = [declarations[arms.length - 1]!, ...bodies[arms.length - 1]!];
  for (let tag = arms.length - 2; tag >= 0; tag--)
    chain = [
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: union.id,
          tag,
          negated: false,
          value: sourceRef(),
          type: BOOL,
          loc,
        },
        then: [declarations[tag]!, ...bodies[tag]!],
        else_: chain,
        loc,
      },
    ];
  const first: IrStmt | undefined = chain[0];
  return first ?? null;
}

/** A fresh local id for a binding of `base`, unique in the function. */
function freshId(base: string, context: Context): string {
  let id = `${base}${context.sequence++}`;
  while (context.used.has(id)) id = `${base}${context.sequence++}`;
  context.used.add(id);
  return id;
}

/** Every node of a copied subtree as a distinct object: the backend keys
 * facts by node identity, and the copies must not share them. */
const clone: IrTransform = { expr: (e) => ({ ...e }), stmt: (s) => ({ ...s }) };

/** The copy of one arm: its dispatch on the bound value folded away. */
function specialize(
  stmts: IrStmt[],
  unionId: string,
  sourceId: string,
  tag: number,
  bindingId: string,
): IrStmt[] {
  const expr = (e: IrExpr): IrExpr => {
    const next = mapExprChildren(e, expr, stmt);
    if (next.kind === "unionNarrow") {
      if (
        next.unionId === unionId &&
        next.tag === tag &&
        next.value.kind === "varRef" &&
        next.value.localId === sourceId
      )
        return { kind: "varRef", localId: bindingId, type: next.type, loc: next.loc };
      return next;
    }
    if (
      next.kind === "unionIsTag" &&
      next.unionId === unionId &&
      next.value.kind === "varRef" &&
      next.value.localId === sourceId
    ) {
      const equal = next.tag === tag;
      return { kind: "boolLit", value: next.negated ? !equal : equal, type: BOOL, loc: next.loc };
    }
    return next;
  };
  const stmt = (s: IrStmt): IrStmt => mapStmtChildren(s, expr, stmt);
  const specialized = stmts.map((s) => stmt(s));
  return specialized.map((s) => foldConstants(s));
}

/** Fold the constant tag tests a specialization left behind: a ternary (or a
 * short-circuit, a `!`, a `toBool`) over a boolean literal takes the branch
 * the literal selects, so the arm's own length and element reads reach the
 * bound proofs as themselves rather than through a dispatch shape. */
function foldConstants(s: IrStmt): IrStmt {
  const expr = (e: IrExpr): IrExpr => fold(mapExprChildren(e, expr, stmt));
  const stmt = (s: IrStmt): IrStmt => {
    const next = mapStmtChildren(s, expr, stmt);
    if (next.kind !== "if") return next;
    const cond = boolConstant(next.cond);
    // The branch the arm rules out holds the other arms' dispatch, including
    // their narrowed reads and trap edges: it cannot run, so it leaves the
    // function rather than staying as an unreachable copy.
    if (cond === null) return next;
    return { kind: "block", body: cond ? next.then : (next.else_ ?? []), loc: next.loc };
  };
  return stmt(s);
}

function fold(e: IrExpr): IrExpr {
  switch (e.kind) {
    case "ternary": {
      const cond = boolConstant(e.cond);
      return cond === null ? e : cond ? e.then : e.else_;
    }
    case "logical": {
      const left = boolConstant(e.left);
      if (left === null || e.type.kind !== "bool") return e;
      if (e.op === "&&") return left ? e.right : e.left;
      return left ? e.left : e.right;
    }
    case "unary": {
      const operand = boolConstant(e.operand);
      if (operand === null || e.op !== "!") return e;
      return { kind: "boolLit", value: !operand, type: BOOL, loc: e.loc };
    }
    case "toBool": {
      const operand = boolConstant(e.operand);
      return operand === null ? e : e.operand;
    }
    default:
      return e;
  }
}

function boolConstant(e: IrExpr): boolean | null {
  if (e.kind === "boolLit") return e.value;
  if (e.kind === "unary" && e.op === "!") {
    const operand = boolConstant(e.operand);
    return operand === null ? null : !operand;
  }
  return null;
}
