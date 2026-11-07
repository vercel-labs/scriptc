/* Where a failed checked conversion goes.
 *
 * A checked conversion (`dynCheck`) throws a TypeError when a value does
 * not have the type the program gives it; under Node.js nothing is checked
 * and the value flows on. When that TypeError arrives at a handler that
 * neither reads it nor throws, the failure leaves no trace: the program
 * takes the handler's path where Node.js continues with the value. `try {
 * return JSON.parse(line) as Entry } catch { return null }` means "skip a
 * malformed line", and natively it also skips every well-formed line that
 * lacks a member `Entry` declares.
 *
 * This scan reads the final function bodies and answers, for each
 * conversion, whether its failure can end that way. Nothing reads the
 * syntax tree, so the handler's spelling does not matter.
 *
 * Within a function the failure meets the enclosing `try` statements from
 * the inside out:
 *
 * - a `catch` whose body refers to the caught value (reads it, passes it
 *   on, tests it, or creates a function that does) has seen it: the
 *   failure is the program's from there, and the scan stops;
 * - a `catch` that never refers to it and can complete (fall out of its
 *   body, `return`, `break`, `continue`) swallows it;
 * - a `catch` that never refers to it and always throws replaces it with
 *   another error, which goes on outwards;
 * - a `finally` that leaves by `return`, `break` or `continue` discards
 *   whatever was thrown, and swallows it;
 * - past the outermost `try`, it leaves the function.
 *
 * A failure that leaves a function arrives where the function was called.
 * Three such paths are followed, each a fact of the lowered program:
 *
 * - a direct call of a named function: one level. The conversions that
 *   leave `decode` are swallowed by the handler around `decode(text)`. A
 *   conversion two calls away is not reported (LIMIT);
 * - a function literal called or awaited where it is written
 *   (`(async () => …)()`), at no level: its body is part of the site;
 * - a parameter: a function that awaits or calls one of its parameters
 *   hands that parameter's failures to its own handlers, or to its caller.
 *   This is how promise chains read. `p.catch(() => null)` lowers to a
 *   function `try { return await p } catch { return null }` called with
 *   the receiver, and `p.then(f)` to one that awaits `p` and calls `f`; a
 *   program's own `attempt(() => …)` helper has the same shape and is
 *   treated the same way. The argument is followed where it is a call, a
 *   function literal, or a parameter of the calling function.
 *
 * An async function's failures reject its promise, so they reach a handler
 * only where the call is awaited inside the `try`. A promise returned
 * without `await` settles after the function left its handlers
 * (`awaitExpr.adopt`): its rejection goes to the caller. Generators run
 * their bodies when they are iterated and are not followed.
 *
 * What is not followed, so a conversion there is never reported: a function
 * held in a variable or a member, a method call the lowering dispatches at
 * run time, a callback handed to code that decides when to run it, and a
 * rejection handler that is not a function literal (the handler receives
 * the error, which counts as reading it). Neither is a helper the lowering
 * shares between sites (Lowerer.shareHelper: dynamic member reads, retags,
 * narrowing helpers): its conversions serve every site that calls it and
 * have no source position of their own, only the earliest caller's, so a
 * warning there would name a place that has nothing to do with the
 * handler. The scan answers "can be
 * swallowed", for a path the lowered program contains; it does not say the
 * path is taken. */
import type { IrExpr, IrFunction, IrStmt, SrcLoc } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/** How many direct calls of named functions lie between a reported
 * conversion and the handler that swallows it, at most. One: the handler's
 * author sees the callee's name in the guarded code. Each further level
 * multiplies the sites (a handler around a program's main function would
 * name most conversions of the program) and weakens what a site has to do
 * with the handler's intent. */
export const SWALLOW_CALL_LEVELS = 1;

/** The handler a failure ends in. */
export interface SwallowingHandler {
  /** A `catch` that ignores the error, a `finally` that leaves, or a
   * promise's rejection handler that ignores the reason: the `catch` of the
   * function a `.catch(…)` lowers to, told apart by being written where
   * that function is called. */
  kind: "catch" | "finally" | "rejection";
  /** The `try` statement; the `.catch(…)` call for a rejection handler. */
  loc: SrcLoc;
}

/** A conversion whose failure can end in a handler that ignores it. */
export interface SwallowedConversion {
  handler: SwallowingHandler;
  /** The direct call of a named function the failure travels through,
   * when the conversion is in that function. */
  through?: SrcLoc;
  /** The direct calls of named functions on the way (0 or 1). */
  level: number;
}

/** Something whose failure arrives at one point of a function. */
type Source =
  | { kind: "conversion"; node: IrExpr }
  /** What leaves `fn` arrives here: a call of a synchronous function, or
   * the await of an async function's call. `inPlace`: `fn` is a function
   * literal written at the site. */
  | { kind: "call"; fn: IrFunction; args: readonly IrExpr[]; loc: SrcLoc; inPlace: boolean }
  /** The await of the function's parameter `index`. */
  | { kind: "awaitParameter"; index: number }
  /** A call of the function's parameter `index`; `awaited` when the result
   * is awaited there, which is where an async function's failures arrive. */
  | { kind: "callParameter"; index: number; awaited: boolean };

type Fate = SwallowingHandler | "seen" | "leaves";

interface Summary {
  /** The sources whose failure leaves the function. */
  out: Source[];
  /** The sources whose failure one of the function's handlers swallows. */
  swallowed: { source: Source; handler: SwallowingHandler }[];
}

/** The arguments of a call being followed, the function they are written
 * in, and that function's own arguments where they are known. */
interface Binding {
  args: readonly IrExpr[];
  fn: IrFunction;
  outer: Binding | null;
}

/** True when control can leave `body` by a jump: a `return`, or a `break`
 * or `continue` whose target is outside `body`. `labels` are the labels of
 * the statements of `body` the walk is inside. */
function jumpsOut(
  body: readonly IrStmt[],
  loops = 0,
  breakables = 0,
  labels: readonly string[] = [],
): boolean {
  for (const s of body) {
    switch (s.kind) {
      case "return":
        return true;
      case "break":
        if (s.label === undefined ? breakables === 0 : !labels.includes(s.label)) return true;
        break;
      case "continue":
        if (s.label === undefined ? loops === 0 : !labels.includes(s.label)) return true;
        break;
      case "block":
        if (jumpsOut(s.body, loops, breakables, withLabels(labels, s.labels))) return true;
        break;
      case "if":
        if (jumpsOut(s.then, loops, breakables, labels)) return true;
        if (s.else_ !== null && jumpsOut(s.else_, loops, breakables, labels)) return true;
        break;
      case "while":
      case "doWhile":
      case "for":
      case "forOf":
        if (jumpsOut(s.body, loops + 1, breakables + 1, withLabels(labels, s.labels))) return true;
        break;
      case "switch": {
        const inner = withLabels(labels, s.labels);
        for (const c of s.cases) if (jumpsOut(c.body, loops, breakables + 1, inner)) return true;
        break;
      }
      case "tryCatch":
        if (jumpsOut(s.tryBody, loops, breakables, labels)) return true;
        if (s.catchBody !== null && jumpsOut(s.catchBody, loops, breakables, labels)) return true;
        if (s.finallyBody !== null && jumpsOut(s.finallyBody, loops, breakables, labels))
          return true;
        break;
      default:
        break;
    }
  }
  return false;
}

function withLabels(
  labels: readonly string[],
  own: readonly string[] | undefined,
): readonly string[] {
  return own === undefined || own.length === 0 ? labels : [...labels, ...own];
}

/** True when control can run off the end of `body`. A loop and a `switch`
 * are taken to complete. */
function fallsThrough(body: readonly IrStmt[]): boolean {
  for (const s of body) {
    switch (s.kind) {
      case "throw":
      case "rethrow":
      // A deferred refusal throws when it is reached.
      case "runtimeFence":
      case "return":
      case "break":
      case "continue":
        return false;
      case "block":
        if (!fallsThrough(s.body)) return false;
        break;
      case "if":
        if (s.else_ !== null && !fallsThrough(s.then) && !fallsThrough(s.else_)) return false;
        break;
      case "tryCatch":
        if (s.finallyBody !== null && !fallsThrough(s.finallyBody)) return false;
        if (!fallsThrough(s.tryBody) && (s.catchBody === null || !fallsThrough(s.catchBody)))
          return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/** True when a handler's body can end without throwing: the failure it
 * caught is then gone. */
export function handlerCompletes(body: readonly IrStmt[]): boolean {
  return fallsThrough(body) || jumpsOut(body);
}

/** True when `body` refers to the local `id`: reads it, or creates a
 * function that captures it. */
export function refersToLocal(body: readonly IrStmt[], id: string | null): boolean {
  if (id === null) return false;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "varRef") {
      if (e.localId === id) return false;
    } else if (e.kind === "closure") {
      if (e.captures.includes(id)) return false;
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  return !body.every(stmt);
}

/** The conversion a build emits a throwing check for. An exact capsule
 * check never throws, and a check of an inferred fact reports a compiler
 * bug of its own. */
function throwingConversion(e: IrExpr): boolean {
  return e.kind === "dynCheck" && e.exact !== true && e.inferredSite === undefined;
}

/** One function's sources and where each one's failure goes. */
class FunctionScan {
  readonly summary: Summary = { out: [], swallowed: [] };
  private fate: Fate = "leaves";
  private readonly parameters = new Map<string, number>();
  /** The locals the function stores to after their declaration; computed
   * when a parameter is first awaited or called. */
  private reassigned: Set<string> | null = null;

  constructor(
    private readonly fn: IrFunction,
    private readonly functions: ReadonlyMap<string, IrFunction>,
  ) {
    fn.params.forEach((p, i) => this.parameters.set(p.localId, i));
  }

  run(): Summary {
    this.fn.body.every(this.stmt);
    return this.summary;
  }

  private note(source: Source, fate: Fate): void {
    if (fate === "seen") return;
    if (fate === "leaves") this.summary.out.push(source);
    else this.summary.swallowed.push({ source, handler: fate });
  }

  /** The index of the parameter `e` reads, unless the function stores to
   * it again: it then holds something else. */
  private parameterOf(e: IrExpr): number | undefined {
    if (e.kind !== "varRef") return undefined;
    const index = this.parameters.get(e.localId);
    if (index === undefined) return undefined;
    if (this.reassigned === null) {
      const reassigned = new Set<string>();
      const expr = (x: IrExpr): boolean => {
        if (x.kind === "assignExpr") reassigned.add(x.localId);
        return everyExprChild(x, expr, stmt);
      };
      const stmt = (x: IrStmt): boolean => {
        if (x.kind === "assign") reassigned.add(x.localId);
        return everyStmtChild(x, expr, stmt);
      };
      this.fn.body.every(stmt);
      this.reassigned = reassigned;
    }
    return this.reassigned.has(e.localId) ? undefined : index;
  }

  /** The function a call expression runs, when the lowered program names
   * it: a direct call, or a function literal called where it is written. */
  private callee(e: IrExpr): { fn: IrFunction; args: readonly IrExpr[]; inPlace: boolean } | null {
    if (e.kind === "call") {
      const fn = this.functions.get(e.callee);
      return fn === undefined ? null : { fn, args: e.args, inPlace: false };
    }
    if (e.kind === "callValue" && e.callee.kind === "closure") {
      const fn = this.functions.get(e.callee.fnName);
      return fn === undefined ? null : { fn, args: e.args, inPlace: true };
    }
    return null;
  }

  /** What rejects the promise `value`, awaited where failures go to `fate`. */
  private awaited(value: IrExpr, fate: Fate): void {
    const parameter = this.parameterOf(value);
    if (parameter !== undefined) {
      this.note({ kind: "awaitParameter", index: parameter }, fate);
      return;
    }
    if (value.kind === "callValue") {
      const called = this.parameterOf(value.callee);
      if (called !== undefined) {
        this.note({ kind: "callParameter", index: called, awaited: true }, fate);
        return;
      }
    }
    const target = this.callee(value);
    if (target !== null && target.fn.async === true && target.fn.generator === undefined)
      this.note({ kind: "call", ...target, loc: value.loc }, fate);
  }

  private readonly expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "dynCheck":
        if (throwingConversion(e)) this.note({ kind: "conversion", node: e }, this.fate);
        break;
      case "call":
      case "callValue": {
        const target = this.callee(e);
        if (target !== null) {
          // A synchronous function throws where it is called.
          if (target.fn.async !== true && target.fn.generator === undefined)
            this.note({ kind: "call", ...target, loc: e.loc }, this.fate);
        } else if (e.kind === "callValue") {
          const called = this.parameterOf(e.callee);
          if (called !== undefined)
            this.note({ kind: "callParameter", index: called, awaited: false }, this.fate);
        }
        break;
      }
      case "awaitExpr":
        // A promise the function returns settles after its handlers.
        this.awaited(e.value, e.adopt === true ? "leaves" : this.fate);
        break;
      case "awaitUnionExpr":
        this.awaited(e.value, this.fate);
        break;
      default:
        break;
    }
    return everyExprChild(e, this.expr, this.stmt);
  };

  private readonly stmt = (s: IrStmt): boolean => {
    if (s.kind !== "tryCatch") return everyStmtChild(s, this.expr, this.stmt);
    const outer = this.fate;
    // Past the handler: a `finally` that leaves discards the error.
    const pastHandler: Fate =
      s.finallyBody !== null && jumpsOut(s.finallyBody) ? { kind: "finally", loc: s.loc } : outer;
    if (s.catchBody === null) this.fate = pastHandler;
    else if (refersToLocal(s.catchBody, s.catchLocalId)) this.fate = "seen";
    else if (handlerCompletes(s.catchBody)) this.fate = { kind: "catch", loc: s.loc };
    else this.fate = pastHandler;
    s.tryBody.every(this.stmt);
    if (s.catchBody !== null) {
      this.fate = pastHandler;
      s.catchBody.every(this.stmt);
    }
    if (s.finallyBody !== null) {
      this.fate = outer;
      s.finallyBody.every(this.stmt);
    }
    this.fate = outer;
    return true;
  };
}

/** A function literal among the forms an argument takes. */
function literalFunction(e: IrExpr): (IrExpr & { kind: "closure" }) | null {
  if (e.kind === "closure") return e;
  if (e.kind === "dynFrom" && e.value.kind === "closure") return e.value;
  return null;
}

/** Every conversion of `functions` whose failure can end in a handler that
 * ignores it, with the first such handler found: the one a failure meets
 * with the fewest calls on the way. `shared` names the helpers the
 * lowering shares between sites, which are not followed. `levels` is
 * SWALLOW_CALL_LEVELS except in a census. */
export function swallowedConversions(
  functions: readonly IrFunction[],
  shared: ReadonlySet<string>,
  levels: number = SWALLOW_CALL_LEVELS,
): Map<IrExpr, SwallowedConversion> {
  const found = new Map<IrExpr, SwallowedConversion>();
  // A call the scan cannot name a function for is not followed, so leaving
  // the shared helpers out of the table is what excludes them.
  const byName = new Map<string, IrFunction>();
  for (const fn of functions) if (!shared.has(fn.name)) byName.set(fn.name, fn);
  const summaries = new Map<IrFunction, Summary>();
  const summaryOf = (fn: IrFunction): Summary => {
    let summary = summaries.get(fn);
    if (summary === undefined) {
      summary = new FunctionScan(fn, byName).run();
      summaries.set(fn, summary);
    }
    return summary;
  };

  const active = new Set<IrFunction>();
  /** The source a promise-valued argument stands for, in the function
   * `binding.fn` it is written in. */
  const promiseSource = (value: IrExpr, binding: Binding): Source | null => {
    if (value.kind === "varRef") {
      const index = binding.fn.params.findIndex((p) => p.localId === value.localId);
      return index < 0 ? null : { kind: "awaitParameter", index };
    }
    let fn: IrFunction | undefined;
    let inPlace = false;
    if (value.kind === "call") fn = byName.get(value.callee);
    else if (value.kind === "callValue" && value.callee.kind === "closure") {
      fn = byName.get(value.callee.fnName);
      inPlace = true;
    } else return null;
    if (fn === undefined || fn.async !== true || fn.generator !== undefined) return null;
    return { kind: "call", fn, args: value.args, loc: value.loc, inPlace };
  };
  const follow = (
    source: Source,
    handler: SwallowingHandler,
    through: SrcLoc | undefined,
    level: number,
    binding: Binding | null,
    /** The function `source` is a source of. */
    owner: IrFunction,
  ): void => {
    switch (source.kind) {
      case "conversion": {
        const known = found.get(source.node);
        if (known === undefined || level < known.level)
          found.set(source.node, { handler, level, ...(through !== undefined ? { through } : {}) });
        return;
      }
      case "call": {
        const next = source.inPlace ? level : level + 1;
        if (next > levels || active.has(source.fn)) return;
        active.add(source.fn);
        const inner: Binding = { args: source.args, fn: owner, outer: binding };
        const via = through ?? (source.inPlace ? undefined : source.loc);
        for (const leaving of summaryOf(source.fn).out)
          follow(leaving, handler, via, next, inner, source.fn);
        active.delete(source.fn);
        return;
      }
      case "awaitParameter": {
        const arg = binding?.args[source.index];
        if (binding === null || arg === undefined) return;
        const stands = promiseSource(arg, binding);
        if (stands !== null) follow(stands, handler, through, level, binding.outer, binding.fn);
        return;
      }
      case "callParameter": {
        const arg = binding?.args[source.index];
        if (binding === null || arg === undefined) return;
        const literal = literalFunction(arg);
        const fn = literal === null ? undefined : byName.get(literal.fnName);
        if (fn === undefined || fn.generator !== undefined) return;
        // A synchronous function throws into the call; an async one
        // rejects a promise, which arrives where the result is awaited.
        if ((fn.async === true) !== source.awaited) return;
        follow(
          { kind: "call", fn, args: [], loc: arg.loc, inPlace: true },
          handler,
          through,
          level,
          binding.outer,
          binding.fn,
        );
        return;
      }
    }
  };

  // What each function's own handlers swallow. A source that names a
  // parameter waits for the function's call sites.
  const parameterSwallowers = new Map<string, IrFunction>();
  for (const fn of functions) {
    if (shared.has(fn.name)) continue;
    for (const { source, handler } of summaryOf(fn).swallowed) {
      if (source.kind === "awaitParameter" || source.kind === "callParameter")
        parameterSwallowers.set(fn.name, fn);
      else follow(source, handler, undefined, 0, null, fn);
    }
  }
  if (parameterSwallowers.size === 0) return found;
  // The call sites of the functions that swallow what a parameter throws.
  for (const caller of functions) {
    const site = (e: IrExpr): boolean => {
      const name =
        e.kind === "call"
          ? e.callee
          : e.kind === "callValue" && e.callee.kind === "closure"
            ? e.callee.fnName
            : undefined;
      const fn = name === undefined ? undefined : parameterSwallowers.get(name);
      if (fn !== undefined && (e.kind === "call" || e.kind === "callValue")) {
        const binding: Binding = { args: e.args, fn: caller, outer: null };
        for (const { source, handler } of summaryOf(fn).swallowed) {
          if (source.kind !== "awaitParameter" && source.kind !== "callParameter") continue;
          // A handler written where its function is called is the handler
          // of a promise chain: the function is the lowering's.
          const written =
            handler.kind === "catch" &&
            handler.loc.file === e.loc.file &&
            handler.loc.start === e.loc.start &&
            handler.loc.end === e.loc.end;
          follow(
            source,
            written ? { kind: "rejection", loc: handler.loc } : handler,
            undefined,
            0,
            binding,
            fn,
          );
        }
      }
      return everyExprChild(e, site, stmt);
    };
    const stmt = (s: IrStmt): boolean => everyStmtChild(s, site, stmt);
    caller.body.every(stmt);
  }
  return found;
}
