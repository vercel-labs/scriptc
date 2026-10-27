/* The own-property copy loop of a dynamic-tier function:
 *
 *   const dst = {};
 *   ...
 *   for (k in src) if (hasOwn(src, k) && k !== "a" && ...) dst[k] = src[k];
 *
 * (React's createElement copies a config into fresh props this way). The
 * loop's lowering reads each key through the class-dispatch helpers; the
 * runtime copies an ordinary object in one pass instead, through shape
 * transitions. The loop stays as written behind it, for every source the
 * runtime declines (scr_js_copy_own_except), with `dst` untouched.
 *
 * Preconditions, so the one pass is the loop's whole effect: `dst` is a
 * local holding a fresh empty literal that nothing reads or writes before
 * the loop, and no loop repeats the copy without re-creating it; `k` holds
 * no value anyone reads after the loop (later reads follow a for-in head
 * that writes it).
 *
 * When `src` is a parameter the function never reads after the copy, the
 * parameter becomes owned and the copy adopts: a caller's fresh literal
 * arrives as the only reference, and the runtime moves its entries into
 * `dst` instead of copying them (scr_js_adopt_own_except). Element reads of
 * `arguments` past the parameter's position don't count as reads of it. */
import {
  BOOL,
  DYN,
  STRING,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { everyExprChild, everyStmtChild, transformStmtList } from "./traverse.js";

interface Copy {
  src: string;
  dst: string;
  key: string;
  excluded: string[];
}

function isVar(e: IrExpr | null | undefined, id?: string): e is IrExpr & { kind: "varRef" } {
  return e?.kind === "varRef" && (id === undefined || e.localId === id);
}

/** `hasOwn(src, k) && k !== "a" && ...`, as its excluded names. */
function copyCondition(e: IrExpr, src: string, key: string): string[] | null {
  if (e.kind === "logical" && e.op === "&&") {
    const left = copyCondition(e.left, src, key);
    const right = e.right;
    if (
      left === null ||
      right.kind !== "strEq" ||
      right.negated !== true ||
      !isVar(right.left, key) ||
      right.right.kind !== "strLit"
    )
      return null;
    return [...left, right.right.value];
  }
  if (e.kind !== "seqExpr" || e.stmts.length !== 2) return null;
  const [receiver, name] = e.stmts;
  const call = e.result;
  if (
    receiver?.kind !== "varDecl" ||
    !isVar(receiver.init, src) ||
    name?.kind !== "varDecl" ||
    !isVar(name.init, key) ||
    call.kind !== "libCall" ||
    call.fn !== "dyn.hasOwn" ||
    !isVar(call.args[0], receiver.localId) ||
    !isVar(call.args[1], name.localId)
  )
    return null;
  return [];
}

/** `dst[k] = js.toDyn(read(src, k))` through the class-dispatch helpers. */
function copyStore(s: IrStmt | undefined, src: string, key: string): string | null {
  if (s?.kind !== "exprStmt" || s.expr.kind !== "seqExpr" || s.expr.stmts.length !== 4) return null;
  const [receiver, name, value, store] = s.expr.stmts;
  if (receiver?.kind !== "varDecl" || !isVar(receiver.init) || name?.kind !== "varDecl" || !isVar(name.init, key))
    return null;
  const read = value?.kind === "varDecl" ? value.init : null;
  const inner = read?.kind === "libCall" && read.fn === "js.toDyn" ? read.args[0] : read;
  if (
    inner?.kind !== "call" ||
    !inner.callee.startsWith("%dyn.class.computed.") ||
    !isVar(inner.args[0], src) ||
    !(isVar(inner.args[1], key) || (inner.args[1]?.kind === "dynFrom" && isVar(inner.args[1].value, key)))
  )
    return null;
  if (
    store?.kind !== "exprStmt" ||
    store.expr.kind !== "call" ||
    !store.expr.callee.startsWith("%dyn.class.computed.") ||
    !isVar(store.expr.args[0], receiver.localId) ||
    !isVar(store.expr.args[1], name.localId) ||
    !isVar(store.expr.args[2], (value as IrStmt & { kind: "varDecl" }).localId)
  )
    return null;
  return receiver.init.localId;
}

/** The copy a for-in block performs, or null. */
function matchCopy(block: IrStmt): Copy | null {
  if (block.kind !== "block" || block.body.length !== 3) return null;
  const [input, stable, loop] = block.body;
  if (input?.kind !== "varDecl" || !isVar(input.init)) return null;
  const src = input.init.localId;
  if (
    stable?.kind !== "varDecl" ||
    stable.init?.kind !== "libCall" ||
    stable.init.fn !== "dyn.forInStable" ||
    !isVar(stable.init.args[0], input.localId)
  )
    return null;
  if (
    loop?.kind !== "forOf" ||
    loop.iterable.kind !== "call" ||
    loop.iterable.callee !== "%dyn.class.forInKeyStrings" ||
    !isVar(loop.iterable.args[0], input.localId) ||
    loop.body.length !== 1
  )
    return null;
  const present = loop.body[0]!;
  if (present.kind !== "if" || present.else_ !== null || present.then.length !== 2) return null;
  const [assign, guard] = present.then;
  if (assign?.kind !== "assign" || !isVar(assign.value, loop.localId)) return null;
  const key = assign.localId;
  if (guard?.kind !== "if" || guard.else_ !== null || guard.then.length !== 1) return null;
  const excluded = copyCondition(guard.cond, src, key);
  const dst = excluded === null ? null : copyStore(guard.then[0], src, key);
  if (excluded === null || excluded.length === 0 || dst === null || dst === src) return null;
  return { src, dst, key, excluded };
}

/** Whether `e` (or a statement) references local `id`. */
function references(node: IrExpr | IrStmt, id: string, isStmt: boolean): boolean {
  let found = false;
  const expr = (e: IrExpr): boolean => {
    if (found) return false;
    if ((e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") && e.localId === id) found = true;
    if ((e.kind === "closure" || e.kind === "classRef") && e.captures?.includes(id)) found = true;
    return !found && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (found) return false;
    if ((s.kind === "varDecl" || s.kind === "assign" || s.kind === "forOf") && s.localId === id) found = true;
    return !found && everyStmtChild(s, expr, stmt);
  };
  if (isStmt) stmt(node as IrStmt);
  else expr(node as IrExpr);
  return found;
}

/** Whether the function satisfies a copy's preconditions around `target`
 * (the loop's block). */
function admissible(fn: IrFunction, target: IrStmt, copy: Copy): boolean {
  const local = fn.locals.find((l) => l.id === copy.dst);
  if (!local || local.mutable || local.boxed) return false;
  // Pre-order walk: `dst`'s declaration (a fresh empty literal), then no
  // use of `dst` until the loop, with every loop around the copy also
  // around the declaration.
  let declared = false;
  let declLoops = -1;
  let ok = true;
  let reached = false;
  const loops: IrStmt[] = [];
  // Reads of `k` outside the copy must follow a for-in head that writes it.
  const keyWrittenBy: IrStmt[] = [];
  const visit = (s: IrStmt): void => {
    if (!ok) return;
    if (s === target) {
      reached = true;
      if (!declared || loops.length !== declLoops) ok = false;
      return;
    }
    if (s.kind === "varDecl" && s.localId === copy.dst) {
      if (declared || s.init?.kind !== "dynObjLit" || (s.init.fields ?? []).length !== 0) ok = false;
      declared = true;
      declLoops = loops.length;
      return;
    }
    if (!reached && references(s, copy.dst, true) && !isContainer(s)) ok = false;
    const loop = s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf";
    if (loop) loops.push(s);
    const headWrites =
      s.kind === "forOf" && s.body[0]?.kind === "if" && s.body[0].then[0]?.kind === "assign"
        ? s.body[0].then[0].localId === copy.key
        : false;
    if (headWrites) keyWrittenBy.push(s);
    if (!isContainer(s) && keyWrittenBy.length === 0) {
      // A leaf statement: any read of `k` needs a writing head around it.
      // Its declaration and assignments write it; their values may not read it.
      const write = (s.kind === "varDecl" || s.kind === "assign") && s.localId === copy.key;
      const value = s.kind === "varDecl" ? s.init : s.kind === "assign" ? s.value : null;
      if (write ? value !== null && references(value, copy.key, false) : references(s, copy.key, true)) ok = false;
    }
    everyStmtChild(s, (e) => {
      if (keyWrittenBy.length === 0 && references(e, copy.key, false)) ok = false;
      if (!reached && references(e, copy.dst, false)) ok = false;
      return true;
    }, (child) => {
      visit(child);
      return true;
    });
    if (headWrites) keyWrittenBy.pop();
    if (loop) loops.pop();
  };
  fn.body.forEach(visit);
  return ok && reached;
}

/** Locals that only ever hold a non-negative integer: declared with one,
 * and only ever incremented by one. */
function nonNegativeCounters(fn: IrFunction): Set<string> {
  const candidates = new Set<string>();
  const refused = new Set<string>();
  const integer = (e: IrExpr | null | undefined): boolean =>
    e?.kind === "numLit" && Number.isInteger(e.value) && e.value >= 0;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr") refused.add(e.localId);
    if (e.kind === "incDec" && e.op === "-") refused.add(e.localId);
    if ((e.kind === "closure" || e.kind === "classRef") && e.captures) for (const id of e.captures) refused.add(id);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "varDecl") (integer(s.init) ? candidates : refused).add(s.localId);
    if (s.kind === "forOf") refused.add(s.localId);
    if (
      s.kind === "assign" &&
      !(
        s.value.kind === "bin" &&
        s.value.op === "+" &&
        isVar(s.value.left, s.localId) &&
        integer(s.value.right)
      )
    )
      refused.add(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.forEach(stmt);
  for (const p of fn.params) refused.add(p.localId);
  return new Set([...candidates].filter((id) => !refused.has(id)));
}

/** Whether anything in `fn` writes local `id`. */
function writes(fn: IrFunction, id: string): boolean {
  let found = false;
  const expr = (e: IrExpr): boolean => {
    if ((e.kind === "assignExpr" || e.kind === "incDec") && e.localId === id) found = true;
    return !found && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if ((s.kind === "varDecl" || s.kind === "assign" || s.kind === "forOf") && s.localId === id) found = true;
    return !found && everyStmtChild(s, expr, stmt);
  };
  fn.body.forEach(stmt);
  return found;
}

/** `arguments[i + c]` (or `arguments[c]`, or a presence probe) through a
 * computed helper, materializing the arguments array, at an index past
 * `position`: the materialization is the helper's receiver, or a sequence
 * around the helper reading the array it stores
 * (hoistCallArgumentSequences). */
function readsArgumentsPast(e: IrExpr, position: number, counters: Set<string>): boolean {
  if (e.kind === "seqExpr" && e.result.kind === "call" && e.result.args.length === 2) {
    const [array, ...rest] = e.result.args;
    return (
      isVar(array) &&
      readsArgumentsPast(
        { ...e.result, args: [{ ...e, result: array }, ...rest] },
        position,
        counters,
      )
    );
  }
  if (e.kind !== "call" || !e.callee.startsWith("%dyn.class.computed.") || e.args.length !== 2) return false;
  const [array, index] = e.args as [IrExpr, IrExpr];
  const past = (c: IrExpr): boolean => c.kind === "numLit" && Number.isInteger(c.value) && c.value > position;
  const safeIndex =
    past(index) ||
    (index.kind === "bin" &&
      index.op === "+" &&
      index.left.kind === "varRef" &&
      counters.has(index.left.localId) &&
      past(index.right));
  if (!safeIndex || array.kind !== "seqExpr" || array.stmts.length !== 1) return false;
  const [assign] = array.stmts;
  return (
    assign?.kind === "assign" &&
    isVar(array.result, assign.localId) &&
    assign.value.kind === "libCall" &&
    assign.value.fn === "dyn.argumentsFrom" &&
    isVar(assign.value.args[0], assign.localId)
  );
}

/** The parameter position of `src` when the copy can adopt its entries:
 * `src` is a parameter nothing captures, the copy runs at most once per
 * call (no loop around it), and nothing reads `src` after it. */
function adoptableSource(fn: IrFunction, target: IrStmt, copy: Copy): number | null {
  if (fn.async || fn.generator || fn.captures) return null;
  const position = fn.params.findIndex((p) => p.localId === copy.src);
  const local = fn.locals.find((l) => l.id === copy.src);
  if (position < 0 || !local || local.boxed || writes(fn, copy.src)) return null;
  const counters = nonNegativeCounters(fn);
  let reached = false;
  let ok = true;
  let loops = 0;
  const expr = (e: IrExpr): boolean => {
    if (!ok) return false;
    if ((e.kind === "closure" || e.kind === "classRef") && e.captures?.includes(copy.src)) ok = false;
    if (reached && readsArgumentsPast(e, position, counters)) return true;
    if (reached && e.kind === "varRef" && e.localId === copy.src) ok = false;
    return ok && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (!ok) return false;
    if (s === target) {
      if (loops > 0) ok = false;
      reached = true;
      return ok;
    }
    const loop = s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf";
    if (loop) loops++;
    everyStmtChild(s, expr, stmt);
    if (loop) loops--;
    return ok;
  };
  fn.body.forEach(stmt);
  return ok && reached ? position : null;
}

/** Statements whose children the walk visits itself. */
function isContainer(s: IrStmt): boolean {
  switch (s.kind) {
    case "block":
    case "if":
    case "while":
    case "doWhile":
    case "for":
    case "forOf":
    case "switch":
    case "tryCatch":
      return true;
    default:
      return false;
  }
}

export function copyOwnPropertyLoops(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.tier !== "dynamic") return fn;
    let edits = 0;
    const done = new Set<IrStmt>();
    const owned = new Set<number>();
    const body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (s) => {
        if (done.has(s)) return s;
        const copy = matchCopy(s);
        if (!copy || !admissible(fn, s, copy)) return s;
        done.add(s);
        edits++;
        const adopt = adoptableSource(fn, s, copy);
        if (adopt !== null) owned.add(adopt);
        const loc = s.loc;
        // The names, NUL-separated: one immortal literal.
        const excluded: IrExpr = { kind: "strLit", value: copy.excluded.join("\u0000"), type: STRING, loc };
        return {
          kind: "if",
          cond: {
            kind: "unary",
            op: "!",
            operand: {
              kind: "libCall",
              fn: adopt !== null ? "dyn.adoptOwnExcept" : "dyn.copyOwnExcept",
              args: [
                { kind: "varRef", localId: copy.dst, type: DYN, loc },
                { kind: "varRef", localId: copy.src, type: DYN, loc },
                excluded,
              ],
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          },
          then: [s],
          else_: null,
          loc,
        };
      },
    });
    if (edits === 0) return fn;
    changed = true;
    const params = fn.params.map((p, i) => (owned.has(i) ? { ...p, owned: true as const } : p));
    return { ...fn, params, body };
  });
  return changed ? { ...mod, functions } : mod;
}
