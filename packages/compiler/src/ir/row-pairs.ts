import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import {
  everyExpr,
  everyExprChild,
  everyStmtList,
  mapExprChildren,
  transformStmtList,
} from "./traverse.js";
import { PRODUCT_COUNTER_BOUND } from "./integer-loops.js";

/** Inner-loop expressions above this many nodes keep the loop as written. */
const MAX_TERM_NODES = 64;

/** The largest bound a paired nest runs with. Counters below
 * PRODUCT_COUNTER_BOUND keep products of their sums exact, so the nest's
 * counted loops take integer counters without a run-time guard (and its
 * copy of the body). */
const SMALL_BOUND = PRODUCT_COUNTER_BOUND - 1;

/** The number operators a term may use: they run no other code and cannot
 * throw. */
const PURE_BINARY = new Set<string>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
]);

/** A loop nest that sums one term per row:
 *
 *   for (let i = start; i < end; i++) {
 *     let t = <literal>;
 *     for (let j = from; j < to; j++) t = t + <term>;
 *     out[i] = t;
 *   }
 */
interface RowSum {
  row: string;
  start: IrExpr;
  end: IrExpr;
  sum: string;
  init: IrExpr & { kind: "numLit" };
  inner: IrStmt & { kind: "for" };
  column: string;
  term: IrExpr;
  out: IrExpr & { kind: "varRef" };
  /** The typed arrays the term reads. */
  reads: (IrExpr & { kind: "varRef" })[];
}

function isRef(e: IrExpr | null | undefined, id: string): boolean {
  return e?.kind === "varRef" && e.localId === id;
}

/** `id = id + 1`, or `id++` as a statement. */
function unitStep(update: IrStmt | null, id: string): boolean {
  if (update?.kind === "exprStmt")
    return update.expr.kind === "incDec" && update.expr.localId === id && update.expr.op === "+";
  return (
    update?.kind === "assign" &&
    update.localId === id &&
    update.value.kind === "bin" &&
    update.value.op === "+" &&
    isRef(update.value.left, id) &&
    update.value.right.kind === "numLit" &&
    update.value.right.value === 1
  );
}

/** A plain number local: unboxed and outside the temporal dead zone. */
function plainNumber(locals: ReadonlyMap<string, IrLocal>, id: string): boolean {
  const local = locals.get(id);
  return local !== undefined && local.type.kind === "f64" && !local.boxed && !local.tdz;
}

function readsLocal(e: IrExpr, id: string): boolean {
  return !everyExpr(e, { stmt: () => true, expr: (x) => !isRef(x, id) });
}

/** The row-sum shape of a `for` statement, or null. Bounds and receivers
 * must be literals or locals the nest never writes. */
function matchRowSum(
  s: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
): RowSum | null {
  if (s.labels?.length || s.init?.kind !== "varDecl" || !s.init.init) return null;
  const row = s.init.localId;
  if (!plainNumber(locals, row) || !unitStep(s.update, row)) return null;
  const cond = s.cond;
  if (cond?.kind !== "bin" || cond.op !== "<" || !isRef(cond.left, row)) return null;
  const start = s.init.init,
    end = cond.right;
  if (s.body.length !== 3) return null;
  const [decl, inner, store] = s.body as [IrStmt, IrStmt, IrStmt];
  if (decl.kind !== "varDecl" || decl.init?.kind !== "numLit") return null;
  const sum = decl.localId;
  if (!plainNumber(locals, sum)) return null;
  if (inner.kind !== "for" || inner.labels?.length) return null;
  if (inner.init?.kind !== "varDecl" || !inner.init.init) return null;
  const column = inner.init.localId;
  if (!plainNumber(locals, column) || !unitStep(inner.update, column)) return null;
  const innerCond = inner.cond;
  if (innerCond?.kind !== "bin" || innerCond.op !== "<" || !isRef(innerCond.left, column))
    return null;
  if (inner.body.length !== 1) return null;
  const add = inner.body[0]!;
  if (
    add.kind !== "assign" ||
    add.localId !== sum ||
    add.value.kind !== "bin" ||
    add.value.op !== "+" ||
    !isRef(add.value.left, sum)
  )
    return null;
  const term = add.value.right;
  if (
    store.kind !== "bytesSet" ||
    store.arr.kind !== "varRef" ||
    store.arr.type.kind !== "bytes" ||
    !isRef(store.index, row) ||
    !isRef(store.value, sum)
  )
    return null;
  const out = store.arr;
  // Values the nest reads but never writes: the row counter, the column
  // counter and the sum are its only writes.
  const written = new Set([row, sum, column]);
  // A typed array's length is fixed, so a stable receiver's length is
  // stable too.
  const stable = (e: IrExpr): boolean =>
    e.kind === "numLit" ||
    (e.kind === "varRef" &&
      !written.has(e.localId) &&
      locals.get(e.localId) !== undefined &&
      !locals.get(e.localId)!.boxed &&
      !locals.get(e.localId)!.tdz) ||
    (e.kind === "bytesIntrinsic" &&
      e.method === "length" &&
      e.args.length === 0 &&
      e.receiver.kind === "varRef" &&
      e.receiver.type.kind === "bytes" &&
      stable(e.receiver));
  if (!stable(start) || !stable(end) || !stable(out)) return null;
  if (!stable(inner.init.init) || !stable(innerCond.right)) return null;
  const reads: (IrExpr & { kind: "varRef" })[] = [];
  let nodes = 0;
  const pure = (e: IrExpr): boolean => {
    if (++nodes > MAX_TERM_NODES) return false;
    switch (e.kind) {
      case "numLit":
        return e.type.kind === "f64";
      case "varRef":
        return e.type.kind === "f64" && (e.localId === row || e.localId === column || stable(e));
      case "bin":
        return e.type.kind === "f64" && PURE_BINARY.has(e.op) && pure(e.left) && pure(e.right);
      case "unary":
        return e.type.kind === "f64" && (e.op === "-" || e.op === "~") && pure(e.operand);
      case "bytesIntrinsic":
        if (stable(e)) return true;
        if (
          e.method !== "get" ||
          e.args.length !== 1 ||
          e.receiver.kind !== "varRef" ||
          e.receiver.type.kind !== "bytes" ||
          !stable(e.receiver)
        )
          return false;
        reads.push(e.receiver);
        return pure(e.args[0]!);
      default:
        return false;
    }
  };
  if (!pure(term) || readsLocal(term, sum)) return null;
  return { row, start, end, sum, init: decl.init, inner, column, term, out, reads };
}

/** A fresh copy of `e` with `substitute` applied to its local reads and
 * `replace` to the nodes it answers for. */
function copy(
  e: IrExpr,
  substitute: (ref: IrExpr & { kind: "varRef" }) => IrExpr,
  replace: (node: IrExpr) => IrExpr | null = () => null,
): IrExpr {
  const replaced = replace(e);
  if (replaced !== null) return replaced;
  if (e.kind === "varRef") return substitute(e);
  return mapExprChildren(
    { ...e },
    (child) => copy(child, substitute, replace),
    (stmt) => stmt,
  );
}

const bin = (
  op: "+" | "-" | "/" | "&" | "|",
  left: IrExpr,
  right: IrExpr,
  loc: IrExpr["loc"],
): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: F64,
  loc,
});

/** Runs the row sums of `match` two rows per pass when the test holds and
 * as written otherwise. Each pass takes two columns per step, then the
 * last column when their count is odd. */
function pairRows(
  s: IrStmt & { kind: "for" },
  match: RowSum,
  fresh: (name: string) => string,
  done: Set<IrStmt>,
): IrStmt {
  const loc = s.loc;
  const ref = (id: string): IrExpr => ({ kind: "varRef", localId: id, type: F64, loc });
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const again = (e: IrExpr): IrExpr => copy(e, (r) => ({ ...r }));
  const row = fresh("row"),
    sum = fresh("sum"),
    next = fresh("next"),
    column = fresh("column");
  // Element reads that do not depend on the row are read once per column
  // and shared by both rows.
  const sharedReads: IrExpr[] = [];
  const collect = (e: IrExpr): boolean => {
    if (e.kind === "bytesIntrinsic" && e.method === "get" && !readsLocal(e, match.row)) {
      sharedReads.push(e);
      return true;
    }
    return everyExprChild(e, collect, () => true);
  };
  collect(match.term);
  /** Both rows' additions at the column `columnAt()`: its shared element
   * reads, then each row's sum. The second row's term reads `row + 1`, and
   * the second column's `column + 1`, so their counter sums stay visible to
   * the counted-loop analysis. */
  const step = (columnAt: () => IrExpr): IrStmt[] => {
    const at = (r: IrExpr & { kind: "varRef" }): IrExpr =>
      r.localId === match.column ? columnAt() : { ...r };
    const shared = new Map<IrExpr, string>();
    const elements: IrStmt[] = sharedReads.map((read) => {
      const id = fresh("element");
      shared.set(read, id);
      return { kind: "varDecl", localId: id, init: copy(read, at), loc };
    });
    const termAt = (rowExpr: () => IrExpr): IrExpr =>
      copy(
        match.term,
        (r) => (r.localId === match.row ? rowExpr() : at(r)),
        (node) => {
          const id = shared.get(node);
          return id === undefined ? null : { kind: "varRef", localId: id, type: node.type, loc };
        },
      );
    return [
      ...elements,
      {
        kind: "assign",
        localId: sum,
        value: bin(
          "+",
          ref(sum),
          termAt(() => ref(row)),
          loc,
        ),
        loc,
      },
      {
        kind: "assign",
        localId: next,
        value: bin(
          "+",
          ref(next),
          termAt(() => bin("+", ref(row), num(1), loc)),
          loc,
        ),
        loc,
      },
    ];
  };
  const innerCond = match.inner.cond as IrExpr & { kind: "bin" };
  const columnStart = (match.inner.init as IrStmt & { kind: "varDecl" }).init!;
  // The bounds, as the paired nest reads them (see `small` below).
  const low = fresh("low"),
    high = fresh("high"),
    first = fresh("first"),
    last = fresh("last");
  const bounds: IrStmt[] = (
    [
      [low, match.start],
      [high, match.end],
      [first, columnStart],
      [last, innerCond.right],
    ] as const
  ).map(([id, bound]) => ({
    kind: "varDecl",
    localId: id,
    init: bin("&", again(bound), num(SMALL_BOUND), loc),
    loc,
  }));
  const pairs: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: row, init: ref(low), loc },
    cond: {
      kind: "bin",
      op: "<",
      left: ref(row),
      right: bin("-", ref(high), num(1), loc),
      type: BOOL,
      loc,
    },
    update: { kind: "assign", localId: row, value: bin("+", ref(row), num(2), loc), loc },
    body: [
      { kind: "varDecl", localId: sum, init: { ...match.init }, loc },
      { kind: "varDecl", localId: next, init: { ...match.init }, loc },
      // Both column bounds are int32, so `column < to - 1` is
      // `column + 1 < to`. Each row adds its columns in order.
      {
        kind: "for",
        init: { kind: "varDecl", localId: column, init: ref(first), loc },
        cond: {
          ...innerCond,
          left: ref(column),
          right: bin("-", ref(last), num(1), loc),
        },
        update: { kind: "assign", localId: column, value: bin("+", ref(column), num(2), loc), loc },
        body: [...step(() => ref(column)), ...step(() => bin("+", ref(column), num(1), loc))],
        loc,
      },
      // An odd column count leaves the last column, `to - 1`.
      {
        kind: "if",
        cond: {
          kind: "logical",
          op: "&&",
          left: { ...innerCond, left: ref(first), right: ref(last) },
          right: {
            kind: "bin",
            op: "===",
            left: bin("&", bin("-", ref(last), ref(first), loc), num(1), loc),
            right: num(1),
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        then: step(() => bin("-", ref(last), num(1), loc)),
        else_: null,
        loc,
      },
      { kind: "bytesSet", arr: { ...match.out }, index: ref(row), value: ref(sum), loc },
      {
        kind: "bytesSet",
        arr: { ...match.out },
        index: bin("+", ref(row), num(1), loc),
        value: ref(next),
        loc,
      },
    ],
    loc,
  };
  // Every bound is an integer in [0, SMALL_BOUND] and not -0, so `row <
  // end - 1` is `row + 1 < end` (and the same for the columns), and the
  // masks in `bounds` leave the bounds unchanged while proving both
  // counters' ranges.
  // The nest has at least two rows. The column bounds' tests and the
  // overlap tests run only then, so they never read an array the program
  // assigns only when there are rows. Rows are
  // independent when the written array shares no byte with an array the
  // term reads; an array that is not there answers false.
  const int32 = (e: IrExpr): IrExpr => ({
    kind: "bin",
    op: "===",
    left: bin("|", again(e), num(0), loc),
    right: again(e),
    type: BOOL,
    loc,
  });
  const compare = (op: "<=" | ">=", e: IrExpr, value: number): IrExpr => ({
    kind: "bin",
    op,
    left: again(e),
    right: num(value),
    type: BOOL,
    loc,
  });
  // `1 / e > 0` holds for +0 and every positive bound, but not for -0:
  // masking would turn a -0 start into +0, which a term can tell apart.
  const small = (e: IrExpr): IrExpr[] => [
    int32(e),
    { kind: "bin", op: ">", left: bin("/", num(1), again(e), loc), right: num(0), type: BOOL, loc },
    compare("<=", e, SMALL_BOUND),
  ];
  const tests: IrExpr[] = [
    ...small(match.start),
    ...small(match.end),
    {
      kind: "bin",
      op: "<",
      left: bin("+", again(match.start), num(1), loc),
      right: again(match.end),
      type: BOOL,
      loc,
    },
    ...small(columnStart),
    ...small(innerCond.right),
    ...match.reads.map((read): IrExpr => ({
      kind: "libCall",
      fn: "bytes.disjoint",
      args: [{ ...match.out }, { ...read }],
      type: BOOL,
      loc,
    })),
  ];
  const test = tests.reduce((left, right) => ({
    kind: "logical",
    op: "&&",
    left,
    right,
    type: BOOL,
    loc,
  }));
  // The loop as written then runs the rows the pairs left: the last one when
  // the count is odd (from `end - ((end - start) & 1)`), or all of them when
  // the test failed. It is the nest's only other copy.
  const go = fresh("go"),
    from = fresh("from");
  const paired: IrExpr = { kind: "bin", op: "===", left: ref(go), right: num(1), type: BOOL, loc };
  const rest: IrStmt = {
    ...s,
    init: { kind: "varDecl", localId: match.row, init: ref(from), loc },
  };
  done.add(rest);
  return {
    kind: "block",
    body: [
      {
        kind: "varDecl",
        localId: go,
        init: { kind: "ternary", cond: test, then: num(1), else_: num(0), type: F64, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: from,
        init: {
          kind: "ternary",
          cond: paired,
          then: bin(
            "-",
            again(match.end),
            bin("&", bin("-", again(match.end), again(match.start), loc), num(1), loc),
            loc,
          ),
          else_: again(match.start),
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "if", cond: { ...paired }, then: [...bounds, pairs], else_: null, loc },
      rest,
    ],
    loc,
  };
}

/** Runs loop nests that sum one term per row (spectral-norm's `au`) two rows
 * per pass.
 *
 * Each row's sum keeps its order of additions, so every sum has the bits
 * the nest computes as written: the second row's term is the same
 * expression of `row + 1`. The term only reads numbers, the counters and
 * typed-array elements, so it runs no other code and cannot throw. The
 * nest runs paired when both row bounds are int32 (so `row < end - 1` is
 * `row + 1 < end`), there are at least two rows, and the array the rows
 * store into shares no byte with any array the term reads, so no row reads
 * another row's result. An odd row count runs its last row as written.
 * Otherwise the nest runs as written. Two independent sums take turns in
 * the inner loop, so neither waits on the other's addition.
 *
 * The inner loop takes two columns per step, each row adding the first
 * column's term and then the second's, and the last column on its own
 * when the count is odd, so the additions keep their order. Both column
 * bounds must also be int32 (so `column < to - 1` is `column + 1 < to`).
 * Neighboring rows and columns share counter sums (`row + 1 + column` and
 * `row + (column + 1)`), and the step's divisions have no dependence
 * between them. */
export function pairRowSums(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator) return fn;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    // Most bodies hold no row sum: find one before copying the body.
    let found = false;
    everyStmtList(fn.body, {
      expr: () => !found,
      stmt: (s) => {
        if (s.kind === "for" && matchRowSum(s, locals) !== null) found = true;
        return !found;
      },
    });
    if (!found) return fn;
    const added: IrLocal[] = [];
    const ids = new Set(fn.locals.map((local) => local.id));
    const fresh = (name: string): string => {
      let id = `%pair.${name}.${ids.size}`;
      while (ids.has(id)) id += "_";
      ids.add(id);
      added.push({ id, name: `%pair.${name}`, type: F64, mutable: true });
      return id;
    };
    const paired = new Set<IrStmt>();
    const body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (s) => {
        if (s.kind !== "for" || paired.has(s)) return s;
        const match = matchRowSum(s, locals);
        if (match === null) return s;
        paired.add(s);
        return pairRows(s, match, fresh, paired);
      },
    });
    if (added.length === 0) return fn;
    changed = true;
    return { ...fn, locals: [...fn.locals, ...added], body };
  });
  return changed ? { ...mod, functions } : mod;
}
