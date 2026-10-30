import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { everyStmtList, transformStmtList } from "./traverse.js";

/** The most iterations of an outer loop that run jammed. */
const MAX_COPIES = 8;

/** The most statement and expression nodes of one outer iteration: every
 * copy duplicates it. */
const MAX_BODY_NODES = 160;

/** Binary operators of numbers and booleans that run no other code and
 * cannot throw. */
const PURE_BINARY = new Set<string>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "<",
  "<=",
  ">",
  ">=",
  "===",
  "!==",
]);

const PURE_UNARY = new Set<string>(["-", "+", "~", "!"]);

interface Jam {
  counter: string;
  /** The counter's value on each iteration. */
  values: number[];
  pre: IrStmt[];
  inner: IrStmt & { kind: "for" };
  post: IrStmt[];
  /** The accumulator the inner loop's exits test, and its full value. */
  acc: string;
  full: number;
}

function isRef(e: IrExpr | null | undefined, id: string): boolean {
  return e?.kind === "varRef" && e.localId === id;
}

function intLit(e: IrExpr | null | undefined): number | null {
  return e?.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0)
    ? e.value
    : null;
}

/** `id = id + step` with a positive integer literal step. */
function constantStep(update: IrStmt | null, id: string): number | null {
  if (
    update?.kind !== "assign" ||
    update.localId !== id ||
    update.value.kind !== "bin" ||
    update.value.op !== "+" ||
    !isRef(update.value.left, id)
  )
    return null;
  const step = intLit(update.value.right);
  return step !== null && step > 0 ? step : null;
}

/** A number or boolean expression that runs no other code and cannot throw:
 * literals, reads of locals and module bindings, arithmetic, comparisons
 * and typed-array element reads that answer NaN out of range. */
function pureExpr(e: IrExpr, locals: ReadonlyMap<string, IrLocal>): boolean {
  if (e.type.kind !== "f64" && e.type.kind !== "bool") return false;
  switch (e.kind) {
    case "numLit":
    case "boolLit":
      return true;
    case "varRef": {
      const local = locals.get(e.localId);
      if (local) return !local.boxed && !local.tdz;
      return e.localId.startsWith("%g.");
    }
    case "bin":
      return PURE_BINARY.has(e.op) && pureExpr(e.left, locals) && pureExpr(e.right, locals);
    case "unary":
      return PURE_UNARY.has(e.op) && pureExpr(e.operand, locals);
    case "bytesIntrinsic":
      return (
        e.method === "get" &&
        e.invalidNaN === true &&
        e.receiver.kind === "varRef" &&
        e.args.length === 1 &&
        pureExpr(e.args[0]!, locals)
      );
    default:
      return false;
  }
}

/** A local written by `s` (a declaration or assignment), or null. */
function writtenLocal(s: IrStmt): string | null {
  return s.kind === "varDecl" || s.kind === "assign" ? s.localId : null;
}

/** Straight-line declarations and assignments of pure values. */
function pureStatements(list: readonly IrStmt[], locals: ReadonlyMap<string, IrLocal>): boolean {
  return list.every(
    (s) =>
      (s.kind === "varDecl" && s.init !== null && pureExpr(s.init, locals)) ||
      (s.kind === "assign" && locals.has(s.localId) && pureExpr(s.value, locals)),
  );
}

/** The bits `C` of `id = id | C`, with `C` a non-negative int32 literal, or
 * null. */
function orBits(s: IrStmt): number | null {
  if (
    s.kind !== "assign" ||
    s.value.kind !== "bin" ||
    s.value.op !== "|" ||
    !isRef(s.value.left, s.localId)
  )
    return null;
  const bits = intLit(s.value.right);
  return bits !== null && bits >= 0 && bits <= 0x7fffffff ? bits : null;
}

/** The statements of the inner loop's body: pure declarations and
 * assignments, `if` statements over them, `acc = acc | C`, and
 * `if (acc === full) break` (collected into `breaks`). */
function innerStatements(
  list: readonly IrStmt[],
  locals: ReadonlyMap<string, IrLocal>,
  acc: { id: string | null; bits: number; breaks: number[] },
): boolean {
  return list.every((s) => {
    if (s.kind === "if") {
      // `if (acc === full) break`
      if (
        s.then.length === 1 &&
        s.then[0]!.kind === "break" &&
        s.then[0]!.label === undefined &&
        (s.else_ === null || s.else_.length === 0) &&
        s.cond.kind === "bin" &&
        s.cond.op === "===" &&
        s.cond.left.kind === "varRef" &&
        intLit(s.cond.right) !== null
      ) {
        if (acc.id !== null && acc.id !== s.cond.left.localId) return false;
        acc.id = s.cond.left.localId;
        acc.breaks.push(intLit(s.cond.right)!);
        return true;
      }
      return (
        pureExpr(s.cond, locals) &&
        innerStatements(s.then, locals, acc) &&
        innerStatements(s.else_ ?? [], locals, acc)
      );
    }
    const bits = orBits(s);
    if (s.kind === "assign" && bits !== null) {
      if (acc.id !== null && acc.id !== s.localId) return false;
      acc.id = s.localId;
      acc.bits |= bits;
      return true;
    }
    return pureStatements([s], locals);
  });
}

function countNodes(list: readonly IrStmt[]): number {
  let n = 0;
  everyStmtList(list as IrStmt[], {
    expr: () => ++n <= MAX_BODY_NODES,
    stmt: () => ++n <= MAX_BODY_NODES,
  });
  return n;
}

/** Reads of local `id` anywhere in `list`. */
function reads(list: readonly IrStmt[], id: string): boolean {
  return !everyStmtList(list as IrStmt[], { expr: (e) => !isRef(e, id), stmt: () => true });
}

/** Locals written anywhere in `list`. */
function writes(list: readonly IrStmt[]): Set<string> {
  const out = new Set<string>();
  everyStmtList(list as IrStmt[], {
    expr: () => true,
    stmt: (s) => {
      const id = writtenLocal(s);
      if (id !== null) out.add(id);
      return true;
    },
  });
  return out;
}

/** Locals declared anywhere in `list`. */
function declared(list: readonly IrStmt[]): Set<string> {
  const out = new Set<string>();
  everyStmtList(list as IrStmt[], {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "varDecl") out.add(s.localId);
      return true;
    },
  });
  return out;
}

/** The jam of `loop`, or null. */
function matchJam(
  loop: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
): Jam | null {
  if (loop.labels?.length || loop.init?.kind !== "varDecl") return null;
  const counter = loop.init.localId;
  const local = locals.get(counter);
  if (local?.type.kind !== "f64" || local.boxed || local.tdz) return null;
  const start = intLit(loop.init.init);
  const step = constantStep(loop.update, counter);
  const cond = loop.cond;
  if (
    start === null ||
    step === null ||
    cond?.kind !== "bin" ||
    cond.op !== "<" ||
    !isRef(cond.left, counter)
  )
    return null;
  const end = intLit(cond.right);
  if (end === null) return null;
  const values: number[] = [];
  for (let v = start; v < end && values.length <= MAX_COPIES; v += step) values.push(v);
  if (values.length < 2 || values.length > MAX_COPIES) return null;
  // One inner loop, with straight-line code before and after it.
  const at = loop.body.findIndex((s) => s.kind === "for");
  if (at < 0) return null;
  const inner = loop.body[at] as IrStmt & { kind: "for" };
  const pre = loop.body.slice(0, at),
    post = loop.body.slice(at + 1);
  if (!pureStatements(pre, locals) || !pureStatements(post, locals)) return null;
  if (countNodes(loop.body) > MAX_BODY_NODES) return null;
  if (inner.labels?.length || inner.init?.kind !== "varDecl") return null;
  const j = inner.init.localId;
  const jLocal = locals.get(j);
  if (jLocal?.type.kind !== "f64" || jLocal.boxed || jLocal.tdz) return null;
  if (inner.init.init === null || !pureExpr(inner.init.init, locals)) return null;
  if (inner.cond === null || !pureExpr(inner.cond, locals) || constantStep(inner.update, j) !== 1)
    return null;
  const acc = { id: null as string | null, bits: 0, breaks: [] as number[] };
  if (!innerStatements(inner.body, locals, acc) || acc.id === null) return null;
  const full = acc.bits;
  // Every exit tests the accumulator against the value every OR leaves
  // unchanged once it is reached.
  if (acc.breaks.length === 0 || acc.breaks.some((value) => value !== full)) return null;
  const accId = acc.id;
  // The accumulator starts at a literal in `pre`, and the inner loop changes
  // it only by its ORs.
  const accDecl = pre.find((s) => s.kind === "varDecl" && s.localId === accId);
  if (accDecl?.kind !== "varDecl" || intLit(accDecl.init) === null) return null;
  const onlyOrs = everyStmtList(inner.body, {
    expr: () => true,
    stmt: (s) => writtenLocal(s) !== accId || orBits(s) !== null,
  });
  if (!onlyOrs) return null;
  // Every copy shares the inner counter: only the inner loop's update writes
  // it.
  if (writes(inner.body).has(j)) return null;
  // The counter, the inner bound and every value the inner loop reads from
  // outside the iteration are the same for every copy: only `pre` and the
  // counter vary.
  const own = declared([...pre, inner]);
  own.delete(counter);
  const innerWrites = writes([inner]);
  innerWrites.delete(j);
  for (const id of innerWrites) if (!own.has(id) && id !== accId) return null;
  if (writes([inner]).has(counter) || writes(pre).has(counter) || writes(post).has(counter))
    return null;
  // Copies run `pre` and the inner loop of later iterations before `post`
  // of earlier ones: `pre` and the inner loop must not read what `post`
  // writes, and `pre` writes only its own declarations.
  const postWrites = writes(post);
  for (const id of postWrites) if (reads([...pre, inner], id) || own.has(id)) return null;
  for (const id of writes(pre)) if (!own.has(id)) return null;
  // After the inner loop, iterations past a copy's exit are dead: `post`
  // reads no value the inner loop writes besides the accumulator.
  for (const id of innerWrites) if (id !== accId && reads(post, id)) return null;
  // The copies share the inner loop's start and bound: they read neither the
  // counter nor a local of the iteration.
  const controls: IrStmt[] = [
    { kind: "exprStmt", expr: inner.init.init, loc: inner.loc },
    { kind: "exprStmt", expr: inner.cond, loc: inner.loc },
  ];
  if (reads(controls, counter)) return null;
  for (const id of own) if (id !== j && reads(controls, id)) return null;
  return { counter, values, pre, inner, post, acc: accId, full };
}

/** Runs the iterations of a short constant-count loop together when its body
 * is an inner loop that exits once an accumulator reaches the value its ORs
 * saturate at (mandelbrot's pairs of pixels per output byte):
 *
 *   for (let i = 0; i < 8; i += 2) {
 *     <pre: pure declarations, including `let b = 0`>
 *     for (let j = 0; j < M; j++) {
 *       <pure arithmetic>; if (c) { b |= 2; if (b === 3) break; } ...
 *     }
 *     <post: pure assignments reading b>
 *   }
 *
 * becomes every iteration's `pre` (with `i` a literal), one inner loop
 * running every iteration's body in turn that exits when every accumulator
 * is full, and every iteration's `post` in order. Once an accumulator is
 * full its ORs leave it full, so the iterations a copy runs past its own
 * exit leave its accumulator as its own loop left it, and every other value
 * they compute is dead: the bodies only compute numbers, read typed-array
 * elements that answer NaN out of range, and write their own locals. `pre`
 * and the inner loop read nothing `post` writes, so running later `pre`s
 * and inner loops first changes no value. Independent iterations then
 * overlap their dependence chains.
 *
 * For the same reason the jammed loop may run past the iteration where every
 * accumulator is full: when the inner loop starts at an int32 literal, it
 * tests that every fourth iteration (`j & 3` is 3), and it keeps the inner
 * loop's own bound. The copies' statements alternate,
 * and each local's copies are added next to each other, so the vectorizer
 * packs one copy per lane. */
export function jamSaturatingLoops(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator) return fn;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    let found = false;
    everyStmtList(fn.body, {
      expr: () => !found,
      stmt: (s) => {
        if (s.kind === "for" && matchJam(s, locals) !== null) found = true;
        return !found;
      },
    });
    if (!found) return fn;
    const added: IrLocal[] = [];
    const ids = new Set(fn.locals.map((local) => local.id));
    const fresh = (of: IrLocal, copy: number): string => {
      let id = `%jam.${copy}.${of.id}`;
      while (ids.has(id)) id += "_";
      ids.add(id);
      const { source: _source, ...rest } = of;
      added.push({ ...rest, id, name: `%jam.${of.name}` });
      return id;
    };
    const body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (s) => {
        if (s.kind !== "for") return s;
        const jam = matchJam(s, locals);
        return jam === null ? s : emitJam(jam, locals, fresh);
      },
    });
    changed = true;
    return { ...fn, locals: [...fn.locals, ...added], body };
  });
  return changed ? { ...mod, functions } : mod;
}

function emitJam(
  jam: Jam,
  locals: ReadonlyMap<string, IrLocal>,
  fresh: (of: IrLocal, copy: number) => string,
): IrStmt {
  const { inner, pre, post, values, counter } = jam;
  const loc = inner.loc;
  const own = declared([...pre, ...inner.body]);
  const init = inner.init as IrStmt & { kind: "varDecl" };
  const j = init.localId;
  own.delete(j);
  // Each local's copies are added next to each other: the vectorizer pairs
  // neighboring values of the loop's header, so one copy per lane.
  const renames = values.map(() => new Map<string, string>());
  for (const id of own)
    for (const [copy, rename] of renames.entries()) rename.set(id, fresh(locals.get(id)!, copy));
  const copies = values.map((value, copy) => {
    const rename = renames[copy]!;
    const rewrite = (list: readonly IrStmt[]): IrStmt[] =>
      transformStmtList(list as IrStmt[], {
        expr: (e) => {
          if (e.kind !== "varRef") return e;
          if (e.localId === counter) return { kind: "numLit", value, type: F64, loc: e.loc };
          const to = rename.get(e.localId);
          return to === undefined ? e : { ...e, localId: to };
        },
        stmt: (s) => {
          if (s.kind === "varDecl" || s.kind === "assign") {
            const to = rename.get(s.localId);
            if (to !== undefined) return { ...s, localId: to };
          }
          return s;
        },
      });
    // The copy's exits become the shared test at the end of the iteration.
    const withoutBreaks = (list: readonly IrStmt[]): IrStmt[] =>
      list.flatMap((s): IrStmt[] => {
        if (s.kind !== "if") return [s];
        if (s.then.length === 1 && s.then[0]!.kind === "break") return [];
        return [
          { ...s, then: withoutBreaks(s.then), else_: s.else_ ? withoutBreaks(s.else_) : null },
        ];
      });
    return {
      pre: rewrite(pre),
      body: rewrite(withoutBreaks(inner.body)),
      post: rewrite(post),
      acc: rename.get(jam.acc)!,
    };
  });
  let allFull: IrExpr | null = null;
  for (const copy of copies) {
    const full: IrExpr = {
      kind: "bin",
      op: "===",
      left: { kind: "varRef", localId: copy.acc, type: F64, loc },
      right: { kind: "numLit", value: jam.full, type: F64, loc },
      type: BOOL,
      loc,
    };
    allFull =
      allFull === null
        ? full
        : { kind: "logical", op: "&&", left: allFull, right: full, type: BOOL, loc };
  }
  const three: IrExpr = { kind: "numLit", value: 3, type: F64, loc };
  const counter3: IrExpr = {
    kind: "bin",
    op: "&",
    left: { kind: "varRef", localId: j, type: F64, loc },
    right: three,
    type: F64,
    loc,
  };
  // `(j & 3) === 3`
  const fourth: IrExpr = { kind: "bin", op: "===", left: counter3, right: three, type: BOOL, loc };
  // `j` reaches a value whose low bits are 3 within four iterations when it
  // starts at an int32 literal: it then takes consecutive integer values,
  // which stay exact for more than 2^52 iterations. From another start (NaN,
  // an infinity, a value where `j + 1` is `j`), the exit is tested every
  // iteration.
  const start = intLit(init.init);
  const everyFourth = start !== null && start >= -0x80000000 && start <= 0x7fffffff;
  const jammed: IrStmt = {
    ...inner,
    body: [
      // The copies take turns statement by statement.
      ...copies[0]!.body.flatMap((_, k) => copies.map((copy) => copy.body[k]!)),
      {
        kind: "if",
        cond: everyFourth
          ? { kind: "logical", op: "&&", left: fourth, right: allFull!, type: BOOL, loc }
          : allFull!,
        then: [{ kind: "break", loc }],
        else_: null,
        loc,
      },
    ],
  };
  return {
    kind: "block",
    body: [...copies.flatMap((copy) => copy.pre), jammed, ...copies.flatMap((copy) => copy.post)],
    loc,
  };
}
