/* Cheap whole-module may-throw analysis (see computeMayThrow). Pure function
 * of the IR module; the emitter consults the result to place unwind checks. */
import type { IrExpr, IrStmt, IrModule, IrType, SrcLoc } from "../ir/ir.js";
import { isFfiCallbackParam, MAY_THROW_ARR_METHODS, MAY_THROW_BYTES_METHODS } from "../ir/ir.js";
import { MAY_THROW_LIB_FNS } from "../ir/builtin-effects.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";
import { eachNodeOfKinds, type IrNodeIndex } from "../ir/node-index.js";
import { hasRetainedFfiCallback } from "./ffi-callbacks.js";
import { computePublishedTypes, writesPublished } from "./publication.js";

/** Why a function may throw (computeMayThrow's `explain` option): its own
 * throwing operation, or the first call edge to a function that may throw. */
export type MayThrowReason =
  | { kind: "seed"; what: string; loc: SrcLoc | null }
  | { kind: "call"; callee: string; loc: SrcLoc | null }
  | { kind: "indirect"; target: string; loc: SrcLoc | null };

/** Cheap may-throw analysis (cost discipline: functions that transitively
 * CANNOT throw pay for no pending-exception checks). A function may throw
 * iff it contains a `throw`, calls a may-throw function (direct `call` or
 * `new`-invoked constructor), or performs a `callValue` while ANY function
 * a closure is ever made over may throw (the callee of an indirect call is
 * unknown, but it must be a closure target of this whole-program module).
 * Fixpoint over the call graph; runtime traps (array OOB etc.) are aborts,
 * not exceptions, so most intrinsics never contribute. The module evaluator's
 * internal await and throwing library calls are the exceptions: both can
 * surface a catchable rejection/error and seed the fixpoint like a `throw`.
 *
 * Handlers discharge what they handle: a throwing operation or call inside
 * a `try` with a `catch`, or inside a `try`/`catch` whose `finally` never
 * completes normally (it returns, breaks or continues, which discards the
 * pending exception), cannot propagate out of that statement, so it adds no
 * seed and no call edge. The `catch` and `finally` bodies themselves are
 * analyzed like any other code, which keeps rethrows exact. Worker programs
 * and generator bodies keep the conservative answer: a termination request
 * and a generator's `.return()` unwind through `catch`. */
export function computeMayThrow(
  mod: IrModule,
  options: {
    /** Native stack checks: true for the functions that check on entry (one
     * per call cycle, see stackCheckedFunctions); "everyCycleMember" for a
     * model in which every function on a cycle checks, which answers a
     * superset that does not depend on that choice. */
    stackChecks?: boolean | "everyCycleMember";
    explain?: boolean;
    /** computePublishedTypes(mod), when the caller already has it. */
    published?: ReturnType<typeof computePublishedTypes>;
    /** The module's node index, read instead of walking the bodies. */
    nodes?: IrNodeIndex;
  } = {},
): {
  fns: Set<string>;
  /** With `explain`: the reason each may-throw function was marked. */
  why?: Map<string, MayThrowReason>;
  indirect: boolean;
  /** Worker programs: the functions that poll for termination on entry. */
  workerEntryPolls?: Set<string>;
  /** With `stackChecks`: the functions that check the native stack guard on
   * entry (and may therefore throw the stack-overflow RangeError). */
  stackChecks?: Set<string>;
} {
  const terminations = mod.workers === true ? workerTerminationPolls(mod, options.nodes) : null;
  const stackGraph =
    options.stackChecks === undefined || options.stackChecks === false
      ? null
      : stackCheckGraph(mod, options.nodes);
  const stackChecks =
    stackGraph === null
      ? null
      : options.stackChecks === "everyCycleMember"
        ? stackGraph.cyclic
        : cycleGuards(stackGraph);
  // Stores that can reach a published object throw the frozen TypeError.
  const published =
    options.published !== undefined ? options.published : computePublishedTypes(mod);
  interface Facts {
    throws: boolean;
    callees: string[];
    callsValue: boolean;
    /** With `explain`: the first throwing operation, the first site of each
     * callee, and the first indirect call. */
    seed?: MayThrowReason;
    calleeLocs?: Map<string, SrcLoc>;
    callValueLoc?: SrcLoc;
  }
  const explain = options.explain === true;
  const facts = new Map<string, Facts>();
  const closureTargets = new Set<string>();
  // FUNC-targeted dynChecks synthesize adapter closures outside the IR's
  // closure table; any callValue may then reach a throwing body.
  let sawDynFuncAdapter = false;
  const asyncFns = new Set(mod.functions.filter((fn) => fn.async).map((fn) => fn.name));
  // Generator functions follow the async exclusion: CALLING one only
  // allocates the suspended fiber (nothing runs, nothing can throw) — a
  // body throw surfaces at genResume, which seeds unconditionally below.
  const genFns = new Set(mod.functions.filter((fn) => fn.generator).map((fn) => fn.name));
  const callbackFfiImports = new Set(
    (mod.ffiImports ?? [])
      .filter((entry) => entry.params.some(isFfiCallbackParam))
      .map((entry) => entry.name),
  );
  const manifestHasRetainedCallback = hasRetainedFfiCallback(mod.ffiImports ?? []);
  // Method name → every class's implementation of it (virtualCall callees).
  const methodImpls = new Map<string, string[]>();
  const classes = new Map((mod.classes ?? []).map((cls) => [cls.name, cls]));
  const constructorClasses = new Map<string, string>();
  const classValueCallers = new Map<string, Set<string>>();
  const tdzGlobals = new Set((mod.globals ?? []).filter((g) => g.tdz).map((g) => g.id));
  for (const cls of mod.classes ?? []) {
    constructorClasses.set(`%${cls.name}.constructor`, cls.name);
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  // Termination requests unwind through every handler of a worker program.
  const handlersCatchAll = mod.workers !== true;
  for (const fn of mod.functions) {
    const f: Facts = { throws: false, callees: [], callsValue: false };
    // Inside a region whose exceptions a handler of this function takes:
    // nothing seeds and no call edge can carry an exception out.
    let guarded = 0;
    const handlers = handlersCatchAll && !fn.generator;
    if (explain) f.calleeLocs = new Map();
    // TDZ reads and non-initializing writes can throw ReferenceError.
    // Capture locals carry the same flag as the declaring binding.
    // Every TDZ global counts for both reads and writes; the module's set is
    // shared by every function.
    const tdzLocals = new Set(fn.locals.filter((l) => l.tdz).map((l) => l.id));
    const mutableTdzLocals = new Set(fn.locals.filter((l) => l.tdz && l.mutable).map((l) => l.id));
    // Traverse typed executable nodes without copying the IR into unknown.
    const visit = (rec: IrExpr | IrStmt): boolean => {
      const threw = f.throws;
      const callees = f.callees.length;
      if (published !== null && writesPublished(published, rec)) f.throws = true;
      switch (rec.kind) {
        case "throw":
        case "rethrow":
        // The deferred JS compile fence throws catchably when executed.
        case "runtimeFence":
          f.throws = true;
          break;
        case "varRef":
        case "incDec":
        case "assignExpr":
          if (tdzGlobals.has(rec.localId) || tdzLocals.has(rec.localId)) f.throws = true;
          break;
        case "assign":
          // A declaration is allowed to fill an empty box. Legacy const
          // TDZ stores also initialize; only mutable subsequent stores
          // introduce the new write-side exception edge.
          if (
            rec.initializes !== true &&
            (tdzGlobals.has(rec.localId) || mutableTdzLocals.has(rec.localId))
          )
            f.throws = true;
          break;
        case "dynCheck":
        case "caughtCheck":
          // A checked cast throws (catchably) on validation failure —
          // seeds the fixpoint exactly like a `throw` statement. A
          // FUNC-targeted dynCheck can also mint an ADAPTER closure whose
          // body throws (argument/result validation inside a later
          // callValue) — those adapters are emitter-synthesized, invisible
          // to closureTargets, so they force the indirect answer below.
          f.throws = true;
          if (rec.type.kind === "func") {
            sawDynFuncAdapter = true;
          }
          break;
        case "mapIntrinsic":
        case "setIntrinsic": {
          const receiver = rec.receiver.type;
          const generic =
            receiver.kind === "map"
              ? receiver.key.kind === "dyn" && receiver.value.kind === "dyn"
              : receiver.kind === "set" && receiver.elem.kind === "dyn";
          if (generic && ["get", "set", "add", "has", "delete"].includes(rec.method))
            f.throws = true;
          break;
        }
        case "fieldIncDec":
          // A checked-dynamic field's ++/-- validates the number out of
          // the box — that dynCheck throws catchably on non-numbers.
          if (rec.fieldDyn === true) f.throws = true;
          break;
        case "dynCall":
        // Prototype dispatch throws the same family (not-a-function,
        // cannot-read, the "not supported yet" Error, callback throws).
        case "dynInvoke":
          // Calling a dyn value throws catchably: the not-a-function
          // TypeError, the boxed thunk's per-argument checks, and
          // whatever the boxed closure itself throws all surface here.
          f.throws = true;
          break;
        case "dynKeyGet":
        case "dynHasKey":
          // The keyed read throws JS's TypeError on an undefined/null
          // receiver (the `?.` form answers undefined instead), and
          // HANDLE receivers can throw the unmodeled-property
          // "not supported yet" Error; Proxy get/has traps can throw too.
          f.throws = true;
          break;
        case "dynDestrCheck":
        case "dynIterN":
          // Destructuring guards throw V8's TypeErrors on nullish /
          // non-iterable sources.
          f.throws = true;
          break;
        case "awaitExpr":
        case "awaitUnionExpr":
          // Awaiting a rejected promise re-throws into the awaiter.
          f.throws = true;
          break;
        case "intrinsic":
          // Module dependency evaluation has await's rejection behavior,
          // while deliberately avoiding await's extra settled-promise turn.
          if (rec.name === "module.await") f.throws = true;
          // A cycle binding read before its declaration ran (TDZ).
          if (rec.name === "module.tdzCheck") f.throws = true;
          // publish() throws on an unpublishable dyn value.
          if (rec.name === "threads.publish") f.throws = true;
          // An InternTable array key longer than a table accepts.
          if (
            (rec.name === "itable.find" || rec.name === "itable.insert") &&
            rec.args[1]?.type.kind === "array"
          )
            f.throws = true;
          break;
        case "yieldExpr":
          // A consumer .throw() surfaces at the yield (and .return()'s
          // GENRET sentinel unwinds from here too).
          f.throws = true;
          break;
        case "genResume":
          // A body exception (or the injected .throw payload on a
          // non-suspended generator) propagates into the resumer; the
          // reentrancy TypeError throws here too. Taking the yielded value
          // after a step only moves it out.
          if (rec.mode !== "value") f.throws = true;
          break;
        case "recordKeySet": {
          // A dynamic-keyed write can collide with a DECLARED field, where
          // a dyn value validates against the field's type (dynCheck) —
          // that path throws the catchable TypeError. A SIGNATURE-FREE
          // shape's write throws on a key MISS (scr_record_key_miss).
          // Overflow shapes with typed value slots never do.
          const shape = (mod.records ?? []).find((r) => r.id === rec.shapeId);
          if (
            rec.overflowOnly !== true &&
            shape &&
            (!shape.indexValue || (shape.indexValue.kind === "dyn" && shape.fields.length > 0))
          ) {
            f.throws = true;
          }
          break;
        }
        case "jsonStringify": {
          // Composite roots can throw: dyn (a runtime handle inside the
          // dyn), and record/array/union roots whose types are recursive
          // (the circular-structure TypeError). Kind-level conservatism —
          // the emitters place the pending check only for cycle-capable
          // types, and a never-taken caller-side check costs one flag
          // read.
          const vt = rec.value.type.kind;
          if (vt === "dyn" || vt === "record" || vt === "array" || vt === "union") f.throws = true;
          break;
        }
        case "toString":
          if (
            rec.operand.type.kind === "dyn" ||
            rec.operand.type.kind === "union" ||
            rec.operand.type.kind === "caught"
          )
            f.throws = true;
          break;
        case "libCall":
          // The may-throw seed hook: throwing library calls (fs.*,
          // json.parse) count exactly like a `throw` statement.
          if (MAY_THROW_LIB_FNS.has(rec.fn)) f.throws = true;
          break;
        case "ffiCall":
          // A native callback may run arbitrary scriptc code. With retained
          // descriptors any manifest binding may pump a previously stored
          // callback, so every FFI call is conservatively a checkpoint.
          if (mod.workers || callbackFfiImports.has(rec.import) || manifestHasRetainedCallback)
            f.throws = true;
          break;
        case "bytesNew": {
          // The size form (`new Uint8Array(n)`) throws Node's "Invalid
          // typed array length" RangeError on a bad length. Checked
          // inputs can also throw during element conversion.
          const source = rec.source;
          if (source && (source.type?.kind === "f64" || source.type?.kind === "dyn"))
            f.throws = true;
          break;
        }
        case "bytesIntrinsic":
          // setFrom and the numeric read/write families throw catchable
          // RangeErrors (Node's bounds discipline); the rest trap or
          // cannot fail.
          if (MAY_THROW_BYTES_METHODS.has(rec.method)) {
            f.throws = true;
          }
          break;
        case "arrIntrinsic":
          if (MAY_THROW_ARR_METHODS.has(rec.method)) {
            f.throws = true;
          }
          break;
        case "arraySetLength":
          f.throws = true;
          break;
        case "strIntrinsic":
          if (rec.method === "normalize" || rec.method === "repeat") f.throws = true;
          break;
        case "regexIntrinsic":
          // Keep the conservative exception check for these operations;
          // replaceAll and matchAll without /g throw Node's TypeError.
          if (
            rec.method === "replaceAll" ||
            rec.method === "split" ||
            rec.method === "matchAll" ||
            rec.method === "matchAllCaptures" ||
            rec.method === "matchAllInto" ||
            rec.method === "matchAllCapturesInto"
          ) {
            f.throws = true;
          }
          break;
        case "call": {
          // Calling an ASYNC function never unwinds the caller: a body
          // throw becomes a promise rejection (visible only at await).
          const callee = rec.callee;
          if (!asyncFns.has(callee) && !genFns.has(callee)) f.callees.push(callee);
          break;
        }
        case "new":
          f.callees.push(`%${rec.className}.constructor`);
          break;
        case "newValue": {
          // Construction through a class VALUE reaches the static class's
          // constructor or any strict descendant's — a sound (slightly
          // wide) cover is every constructor of the named class's
          // hierarchy; classval flows never leave it.
          const cls = rec.callee.type.kind === "classval" ? rec.callee.type.className : undefined;
          if (cls !== undefined && guarded === 0) {
            let list = classValueCallers.get(cls);
            if (!list) classValueCallers.set(cls, (list = new Set()));
            list.add(fn.name);
          }
          break;
        }
        case "virtualCall": {
          // The concrete callee is any implementation of this method name
          // on a class — a sound (slightly wide, cross-hierarchy) cover of
          // the override set the dispatch can actually reach.
          const impls = methodImpls.get(rec.method);
          if (impls) f.callees.push(...impls);
          break;
        }
        case "callValue":
          if (guarded > 0) break;
          f.callsValue = true;
          if (explain) f.callValueLoc ??= rec.loc;
          break;
        case "closure":
          closureTargets.add(rec.fnName);
          break;
      }
      if (guarded > 0) {
        // A handler of this function takes the exception.
        f.throws = threw;
        f.callees.length = callees;
        return true;
      }
      if (explain) {
        if (!threw && f.throws)
          f.seed = { kind: "seed", what: describeThrowingNode(rec), loc: rec.loc };
        for (let i = callees; i < f.callees.length; i++)
          if (!f.calleeLocs!.has(f.callees[i]!)) f.calleeLocs!.set(f.callees[i]!, rec.loc);
        if (rec.kind === "newValue" && !f.calleeLocs!.has("\0classValue"))
          f.calleeLocs!.set("\0classValue", rec.loc);
      }
      return true;
    };
    const walkExpr = (node: IrExpr): boolean =>
      visit(node) && everyExprChild(node, walkExpr, walkStmt);
    // Unreachable statements cannot throw, such as the frontend's trap after
    // a body that returns from both its try and its catch.
    const dead = unreachableStatements(fn.body);
    const walkStmt = (node: IrStmt): boolean => {
      if (dead.has(node)) return true;
      if (node.kind !== "tryCatch" || !handlers)
        return visit(node) && everyStmtChild(node, walkExpr, walkStmt);
      visit(node);
      // The catch takes everything the try body raises. A finally that
      // never completes normally discards whatever the try body or the
      // catch left pending; one that can complete normally re-raises it.
      const discards = node.finallyBody !== null && !completesNormally(node.finallyBody);
      const guardTry = node.catchBody !== null || discards;
      if (guardTry) guarded++;
      node.tryBody.every(walkStmt);
      if (guardTry) guarded--;
      if (discards) guarded++;
      node.catchBody?.every(walkStmt);
      if (discards) guarded--;
      node.finallyBody?.every(walkStmt);
      return true;
    };
    fn.body.every(walkStmt);
    // A worker can be terminated at any of its polls: the noncatchable
    // stop unwinds like an exception from every function that polls.
    if (terminations?.polls.has(fn.name)) {
      if (explain && !f.throws)
        f.seed = { kind: "seed", what: "polls for worker termination", loc: fn.loc };
      f.throws = true;
    }
    // A stack-overflow check throws Node's RangeError from the entry.
    if (stackChecks?.has(fn.name)) {
      if (explain && !f.throws)
        f.seed = {
          kind: "seed",
          what: "can recurse (directly or through callbacks), so the stack guard may throw RangeError",
          loc: fn.loc,
        };
      f.throws = true;
    }
    facts.set(fn.name, f);
  }

  // Propagate each newly throwing function along reverse call edges once.
  // Repeated full scans take one pass per level of a caller-first chain.
  const callers = new Map<string, string[]>();
  const indirectCallers: string[] = [];
  const may = new Set<string>();
  const pending: string[] = [];
  const why = explain ? new Map<string, MayThrowReason>() : null;
  const mark = (name: string, reason?: MayThrowReason): void => {
    if (may.has(name)) return;
    may.add(name);
    pending.push(name);
    if (why !== null && reason !== undefined) why.set(name, reason);
  };
  const callEdge = (caller: string, callee: string): MayThrowReason | undefined =>
    why === null
      ? undefined
      : { kind: "call", callee, loc: facts.get(caller)?.calleeLocs?.get(callee) ?? null };
  const indirectEdge = (caller: string, target: string): MayThrowReason | undefined =>
    why === null
      ? undefined
      : { kind: "indirect", target, loc: facts.get(caller)?.callValueLoc ?? null };
  for (const [name, f] of facts) {
    if (f.throws) mark(name, f.seed);
    if (f.callsValue) indirectCallers.push(name);
    for (const callee of new Set(f.callees)) {
      let list = callers.get(callee);
      if (!list) callers.set(callee, (list = []));
      list.push(name);
    }
  }
  // A throwing constructor makes construction through its class value and
  // every ancestor's class value potentially throwing. Keep this hierarchy
  // summary separate from constructor functions: a throwing descendant must
  // not make direct `new Base()` or a sibling's constructor throw. Each class
  // is reached at most once, without materializing every descendant edge.
  const throwingHierarchies = new Set<string>();
  let indirect = sawDynFuncAdapter;
  if (indirect) for (const name of indirectCallers) mark(name, indirectEdge(name, ""));
  for (let i = 0; i < pending.length; i++) {
    const name = pending[i]!;
    if (!indirect && closureTargets.has(name) && !asyncFns.has(name) && !genFns.has(name)) {
      indirect = true;
      for (const caller of indirectCallers) mark(caller, indirectEdge(caller, name));
    }
    for (const caller of callers.get(name) ?? []) mark(caller, callEdge(caller, name));
    let cls = constructorClasses.get(name);
    while (cls !== undefined && !throwingHierarchies.has(cls)) {
      const def = classes.get(cls);
      if (!def) break;
      throwingHierarchies.add(cls);
      const valueCallers = classValueCallers.get(cls);
      if (valueCallers)
        for (const caller of valueCallers)
          mark(
            caller,
            why === null
              ? undefined
              : {
                  kind: "call",
                  callee: name,
                  loc: facts.get(caller)?.calleeLocs?.get("\0classValue") ?? null,
                },
          );
      cls = def.base;
    }
  }
  return {
    fns: may,
    ...(why !== null ? { why } : {}),
    indirect,
    ...(terminations
      ? { workerEntryPolls: entryPolls(mod, terminations.entry, stackGraph?.cyclic ?? null, may) }
      : {}),
    ...(stackChecks ? { stackChecks } : {}),
  };
}

/** Whether control can reach the end of a statement list. Conservative:
 * false only when some statement certainly completes abruptly: `return`,
 * `throw`, `break` or `continue` (which leave the list), an `if` whose
 * branches both do, a `try` whose body and `catch` (or `finally`) do, a
 * `switch` with a `default` whose last case does and that no `break`
 * leaves, or a `while (true)`/`for (;;)` loop that no `break` leaves. */
export function completesNormally(stmts: readonly IrStmt[]): boolean {
  return completion().list(stmts);
}

function completion(): {
  list: (stmts: readonly IrStmt[]) => boolean;
  statement: (s: IrStmt) => boolean;
} {
  const memo = new Map<IrStmt, boolean>();
  const list = (stmts: readonly IrStmt[]): boolean => stmts.every(statement);
  const statement = (s: IrStmt): boolean => {
    let known = memo.get(s);
    if (known === undefined) {
      known = compute(s);
      memo.set(s, known);
    }
    return known;
  };
  const compute = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "return":
      case "throw":
      case "rethrow":
      case "runtimeFence":
      case "break":
      case "continue":
        return false;
      case "if":
        return list(s.then) || list(s.else_ ?? []);
      case "block":
        return list(s.body) || breaksTo(s.body, s.labels ?? [], false);
      case "tryCatch":
        return (
          (list(s.tryBody) || (s.catchBody !== null && list(s.catchBody))) &&
          (s.finallyBody === null || list(s.finallyBody))
        );
      case "switch": {
        const last = s.cases[s.cases.length - 1];
        return (
          last === undefined ||
          !s.cases.some((c) => c.test === null) ||
          list(last.body) ||
          s.cases.some((c) => breaksTo(c.body, s.labels ?? [], true))
        );
      }
      case "while":
      case "doWhile":
      case "for": {
        const forever = s.cond === null || (s.cond.kind === "boolLit" && s.cond.value === true);
        return !forever || breaksTo(s.body, s.labels ?? [], true);
      }
      default:
        return true;
    }
  };
  return { list, statement };
}

/** Whether a `break` in the statements leaves the construct that owns
 * them: one naming its labels, or (for loops and switches, `unlabeled`)
 * an unlabeled `break` that no nested loop or switch captures first. */
function breaksTo(
  stmts: readonly IrStmt[],
  labels: readonly string[],
  unlabeled: boolean,
): boolean {
  const walk = (s: IrStmt, captured: boolean): boolean => {
    switch (s.kind) {
      case "break":
        return s.label === undefined ? unlabeled && !captured : labels.includes(s.label);
      case "if":
        return (
          s.then.some((c) => walk(c, captured)) || (s.else_ ?? []).some((c) => walk(c, captured))
        );
      case "block":
        return s.body.some((c) => walk(c, captured));
      case "tryCatch":
        return [s.tryBody, s.catchBody ?? [], s.finallyBody ?? []].some((body) =>
          body.some((c) => walk(c, captured)),
        );
      case "switch":
        return s.cases.some((c) => c.body.some((inner) => walk(inner, true)));
      case "while":
      case "doWhile":
      case "for":
      case "forOf":
        return s.body.some((c) => walk(c, true));
      default:
        return false;
    }
  };
  return stmts.some((s) => walk(s, false));
}

/** Statements no execution reaches: those after a statement that cannot
 * complete normally in the same statement list. */
export function unreachableStatements(body: readonly IrStmt[]): Set<IrStmt> {
  const dead = new Set<IrStmt>();
  const { statement } = completion();
  const list = (stmts: readonly IrStmt[]): void => {
    let live = true;
    for (const s of stmts) {
      if (!live) {
        dead.add(s);
        continue;
      }
      for (const inner of nestedLists(s)) list(inner);
      if (!statement(s)) live = false;
    }
  };
  list(body);
  return dead;
}

function nestedLists(s: IrStmt): readonly (readonly IrStmt[])[] {
  switch (s.kind) {
    case "if":
      return s.else_ === null ? [s.then] : [s.then, s.else_];
    case "block":
    case "while":
    case "doWhile":
    case "for":
    case "forOf":
      return [s.body];
    case "switch":
      return s.cases.map((c) => c.body);
    case "tryCatch":
      return [s.tryBody, s.catchBody ?? [], s.finallyBody ?? []];
    default:
      return [];
  }
}

/** Error constructors by runtime error kind (SCR_ERR_* in scr_runtime.h). */
const ERROR_KIND_NAMES: readonly string[] = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "DOMException",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AssertionError",
  "SuppressedError",
];

/** A short description of a node that seeds the may-throw fixpoint. */
function describeThrowingNode(rec: IrExpr | IrStmt): string {
  switch (rec.kind) {
    case "throw":
      return "throw statement";
    case "rethrow":
      return "rethrow";
    case "runtimeFence":
      return "deferred compile fence";
    case "varRef":
    case "incDec":
    case "assignExpr":
    case "assign":
      return "binding accessed before initialization (ReferenceError)";
    case "dynCheck":
    case "caughtCheck":
      return "checked cast of a dynamic value (TypeError)";
    case "dynCall":
    case "dynInvoke":
      return "call through a dynamic value";
    case "dynKeyGet":
    case "dynHasKey":
      return "property access on a dynamic value (undefined or null receiver)";
    case "dynDestrCheck":
    case "dynIterN":
      return "destructuring a dynamic value";
    case "awaitExpr":
    case "awaitUnionExpr":
      return "await (a rejected promise throws)";
    case "yieldExpr":
    case "genResume":
      return "generator resumption";
    case "libCall": {
      // Compiler-resolved Node throws: name the error and its message.
      if (rec.fn === "error.nodeThrow" || rec.fn === "error.new") {
        const nodeThrow = rec.fn === "error.nodeThrow";
        const kind = rec.args[0];
        const message = nodeThrow ? rec.args[2] : rec.args[0];
        const name = nodeThrow
          ? kind?.kind === "numLit"
            ? (ERROR_KIND_NAMES[kind.value] ?? "Error")
            : "Error"
          : rec.type.kind === "object"
            ? rec.type.className.replace(/^%/, "")
            : "Error";
        return message?.kind === "strLit" ? `throws ${name}: ${message.value}` : `throws ${name}`;
      }
      return `library call ${rec.fn}`;
    }
    case "intrinsic":
      return `intrinsic ${rec.name}`;
    case "strIntrinsic":
    case "regexIntrinsic":
    case "arrIntrinsic":
    case "bytesIntrinsic":
    case "mapIntrinsic":
    case "setIntrinsic":
      return `${rec.kind} ${rec.method}`;
    case "arraySetLength":
      return "array length assignment (RangeError)";
    case "jsonStringify":
      return "JSON.stringify of a possibly circular value (TypeError)";
    case "toString":
      return "string conversion of a dynamic value";
    case "fieldSet":
    case "recordSet":
      return "write into a possibly published object (TypeError)";
    default:
      return rec.kind;
  }
}

/** The termination polls a worker program places on function entry. A
 * synchronous function on a call cycle that may throw needs none: every
 * caller tests the pending state after the call, and a descent that never
 * returns passes a stack-checked function of each cycle again and again
 * (stackCheckedFunctions) and ends at its guard, whose RangeError unwinds
 * through those tests. An outstanding terminate request keeps the alert word
 * nonzero, so the first test that runs afterwards (a post-call test, a loop
 * poll or the unwinding) stops the thread; dropping the entry poll only
 * delays the stop by bounded work, which Node's asynchronous terminate
 * allows. The entry poll's slow path rejoins the body, so every polled
 * function kept its arguments live across a call. */
function entryPolls(
  mod: IrModule,
  entry: Set<string>,
  cyclic: Set<string> | null,
  may: Set<string>,
): Set<string> {
  if (cyclic === null) return entry;
  // Calling an async or generator function never tests the caller's pending
  // state, and the module entry has no caller: those keep their polls.
  const keep = new Set(
    mod.functions.filter((fn) => fn.async || fn.generator !== undefined).map((fn) => fn.name),
  );
  keep.add(mod.entry);
  return new Set(
    [...entry].filter((name) => keep.has(name) || !cyclic.has(name) || !may.has(name)),
  );
}

/** Statement and expression kinds that cannot reenter scriptc code except
 * through the direct call edges recorded below (`call`, `new`,
 * `virtualCall`), and cannot block in the runtime. Everything else, such as
 * indirect calls, callbacks, awaits, dynamic operations and library calls, is
 * treated as unbounded. */
const BOUNDED_KINDS: ReadonlySet<string> = new Set([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  "return",
  "throw",
  "rethrow",
  "tryCatch",
  "switch",
  "break",
  "continue",
  "while",
  "doWhile",
  "for",
  "forOf",
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "varRef",
  "assignExpr",
  "incDec",
  "bin",
  "unary",
  "logical",
  "ternary",
  "strCmp",
  "strEq",
  "strConcat",
  "strIntrinsic",
  "call",
  "new",
  "virtualCall",
  "fieldGet",
  "fieldSet",
  "fieldIncDec",
  "fieldAbsent",
  "arrayGet",
  "arraySet",
  "arrayHas",
  "arrayLit",
  "arrayNewLen",
  "arrayDelete",
  "arraySetUndefined",
  "arrayState",
  "dynFrom",
  "recordGet",
  "recordSet",
  "recordHas",
  "recordLit",
  "mapIntrinsic",
  "setIntrinsic",
  "upcast",
  "downcast",
  "toBool",
  "seqExpr",
  "nullish",
  "orDefault",
  "optChain",
  "chainRecv",
  "selfRef",
  "unionWrap",
  "unionRetype",
  "unionNarrow",
  "unionDisc",
  "unionIsTag",
  "unionEq",
  "instanceOf",
  "closure",
  "classRef",
  // Throw-only and storage-only operations: they run no script code and
  // cannot block (truncation and stores release values, which runs no
  // script code either).
  "runtimeFence",
  "arraySetLength",
  "bytesSet",
  "caughtTest",
  "caughtNarrow",
]);

/** Typed-array reads that run no script code. */
const BOUNDED_BYTES_METHODS: ReadonlySet<string> = new Set([
  "get",
  "length",
  "subarray",
  "sortNumeric",
]);

/** Array methods that can call back into scriptc code (a comparator, or
 * element string conversion). */
const UNBOUNDED_ARR_METHODS: ReadonlySet<string> = new Set(["sortValues", "sortDense", "join"]);

function primitiveArgument(arg: IrExpr): boolean {
  const kind = arg.type.kind;
  return kind === "string" || kind === "f64" || kind === "bool";
}

function primitiveDynArgument(arg: IrExpr): boolean {
  if (arg.kind !== "dynFrom") return false;
  const kind = arg.value.type.kind;
  return kind === "string" || kind === "f64" || kind === "bool" || kind === "undefinedT";
}

function staticContainer(type: IrType): boolean {
  return type.kind === "array" || type.kind === "set" || type.kind === "bytes";
}

function boundedNode(rec: IrExpr | IrStmt): boolean {
  if (BOUNDED_KINDS.has(rec.kind)) return true;
  switch (rec.kind) {
    case "arrIntrinsic":
      return !UNBOUNDED_ARR_METHODS.has(rec.method);
    case "libCall":
      // A compiler-resolved Node error with literal arguments: it only throws.
      if (rec.fn === "error.new" || rec.fn === "error.nodeThrow") return true;
      // `new Error(message, options)` stays bounded while its message cannot
      // reach a user toString and no options object is passed.
      if (rec.fn === "error.newOptions") return rec.args.every(primitiveDynArgument);
      // String and number library calls over primitives cannot reach a user
      // callback or conversion.
      if (rec.fn.startsWith("string.") || rec.fn.startsWith("num."))
        return rec.args.every(primitiveArgument);
      return rec.fn.startsWith("math.");
    case "intrinsic":
      // A module binding read before its declaration ran only throws.
      return rec.name === "module.tdzCheck";
    case "bytesIntrinsic":
      return BOUNDED_BYTES_METHODS.has(rec.method);
    case "toString": {
      const operand = rec.operand.type.kind;
      return operand === "f64" || operand === "bool" || operand === "string";
    }
    // Allocations: literal entries are visited on their own, and a static
    // seed or source is a finite container walk (a dynamic iterable could
    // run a user iterator).
    case "mapNew":
      return true;
    case "setNew":
      return rec.seed === undefined || staticContainer(rec.seed.type);
    case "bytesNew":
      return rec.source === null || staticContainer(rec.source.type);
    default:
      return false;
  }
}

/** Where a worker program must poll for termination so that every unbounded
 * execution observes it promptly: every loop polls on entry and then in
 * bounded batches, and a function polls on entry unless it is bounded. A
 * function is bounded when all of its operations are listed above and it is
 * not part of a direct call cycle; then every execution of it either
 * finishes after finitely many steps or reaches a polling callee. `polls`
 * names the functions that poll (and therefore may unwind with the
 * termination sentinel); `entry` the subset that polls on entry. */
/** The kinds call-graph census below can skip: boundedNode answers true
 * for them, and the census reads nothing else from them. */
const CENSUS_SKIPPED_KINDS: ReadonlySet<string> = new Set(
  [...BOUNDED_KINDS].filter(
    (kind) =>
      !["while", "doWhile", "for", "forOf", "call", "new", "virtualCall", "closure"].includes(kind),
  ),
);

export function workerTerminationPolls(
  mod: IrModule,
  nodes?: IrNodeIndex,
): {
  entry: Set<string>;
  polls: Set<string>;
} {
  const methodImpls = new Map<string, string[]>();
  for (const cls of mod.classes ?? []) {
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  const names = new Set(mod.functions.map((fn) => fn.name));
  const edges = new Map<string, string[]>();
  const entry = new Set<string>();
  const polls = new Set<string>();
  const scan = nodes?.scanExcept(CENSUS_SKIPPED_KINDS);
  for (const fn of mod.functions) {
    const out: string[] = [];
    let bounded = fn.async !== true && fn.generator === undefined && fn.name !== mod.entry;
    let loops = false;
    const visit = (rec: IrExpr | IrStmt): void => {
      if (!boundedNode(rec)) bounded = false;
      switch (rec.kind) {
        case "while":
        case "doWhile":
        case "for":
        case "forOf":
          loops = true;
          break;
        case "call":
          out.push(rec.callee);
          break;
        case "new":
          out.push(`%${rec.className}.constructor`);
          break;
        case "virtualCall":
          out.push(...(methodImpls.get(rec.method) ?? []));
          break;
      }
    };
    eachNodeOfKinds(fn, scan, visit);
    edges.set(
      fn.name,
      out.filter((callee) => names.has(callee)),
    );
    if (!bounded) entry.add(fn.name);
    if (loops) polls.add(fn.name);
  }
  for (const name of cyclicFunctions(edges)) entry.add(name);
  for (const name of entry) polls.add(name);
  return { entry, polls };
}

/** The call graph that bounds recursion, and the functions on its cycles:
 * the ones that can take part in unbounded recursion. Direct edges are
 * calls, constructions and virtual dispatch. A function containing any
 * operation that can reenter scriptc code other than through those edges
 * (an indirect call, a callback-taking or dynamic operation, a library call;
 * see boundedNode) also reaches every function that such an operation can
 * invoke: closure targets and class members, behind one shared `reentry`
 * node. */
interface StackCheckGraph {
  edges: Map<string, string[]>;
  cyclic: Set<string>;
}

const REENTRY = "\0reentry";

/** The functions that check the native stack guard on entry: one function
 * of every cycle of the call graph (stackCheckGraph), which bounds every
 * unbounded recursion, since its frames repeat the cycle's guarded function
 * again and again. Non-recursive functions, including leaf callbacks, stay
 * check-free. See cycleGuards for the choice. */
export function stackCheckedFunctions(mod: IrModule, nodes?: IrNodeIndex): Set<string> {
  return cycleGuards(stackCheckGraph(mod, nodes));
}

function stackCheckGraph(mod: IrModule, nodes?: IrNodeIndex): StackCheckGraph {
  const methodImpls = new Map<string, string[]>();
  const memberPrefixes = new Set<string>();
  for (const cls of mod.classes ?? []) {
    memberPrefixes.add(`%${cls.name}.`);
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  const names = new Set(mod.functions.map((fn) => fn.name));
  const edges = new Map<string, string[]>();
  const targets = new Set<string>();
  const scan = nodes?.scanExcept(CENSUS_SKIPPED_KINDS);
  for (const fn of mod.functions) {
    const dot = fn.name.indexOf(".");
    if (dot > 0 && memberPrefixes.has(fn.name.slice(0, dot + 1))) targets.add(fn.name);
    const out: string[] = [];
    let reenters = false;
    const visit = (rec: IrExpr | IrStmt): void => {
      if (!boundedNode(rec)) reenters = true;
      switch (rec.kind) {
        case "call":
          out.push(rec.callee);
          break;
        case "new":
          out.push(`%${rec.className}.constructor`);
          break;
        case "virtualCall":
          out.push(...(methodImpls.get(rec.method) ?? []));
          break;
        case "closure":
          targets.add(rec.fnName);
          break;
      }
    };
    eachNodeOfKinds(fn, scan, visit);
    const callees = out.filter((callee) => names.has(callee));
    if (reenters) callees.push(REENTRY);
    edges.set(fn.name, callees);
  }
  edges.set(
    REENTRY,
    [...targets].filter((name) => names.has(name)),
  );
  const cyclic = cyclicFunctions(edges);
  cyclic.delete(REENTRY);
  return { edges, cyclic };
}

/** The longest run of calls between unchecked functions of a cycle that
 * cycleGuards allows; deeper runs get a check. Acyclic call chains below a
 * check are as deep as the program makes them already, so this keeps the
 * stack used between two checks of the same order. */
const MAX_UNCHECKED_CYCLE_RUN = 32;

/** A small set of functions that meets every cycle of the stack-check graph
 * (a feedback vertex set), chosen greedily: functions that cannot lie on a
 * remaining cycle (no caller or no callee left among the candidates) drop
 * out, a function that calls itself is chosen, and otherwise the function
 * with the most caller-callee pairs, the one that breaks the most cycles,
 * is chosen and removed; ties go to the earlier function. The reentry node
 * is not a function and is never chosen. A last pass in topological order
 * of the unchosen cycle functions adds a check where a run of them would
 * exceed MAX_UNCHECKED_CYCLE_RUN calls. */
function cycleGuards(graph: StackCheckGraph): Set<string> {
  const { edges, cyclic } = graph;
  const chosen = new Set<string>();
  if (cyclic.size === 0) return chosen;
  const order = new Map<string, number>();
  const callees = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();
  const candidates = [...[...edges.keys()].filter((name) => cyclic.has(name)), REENTRY];
  for (const name of candidates) {
    order.set(name, order.size);
    callees.set(name, new Set());
    callers.set(name, new Set());
  }
  for (const name of candidates)
    for (const callee of edges.get(name) ?? [])
      if (callees.has(callee)) {
        callees.get(name)!.add(callee);
        callers.get(callee)!.add(name);
      }
  // Max-heap of [score, order, name]; an entry is stale once its function
  // is gone or its score changed, and is skipped when popped.
  const heap: [number, number, string][] = [];
  const score = (name: string): number =>
    name === REENTRY ? -1 : callers.get(name)!.size * callees.get(name)!.size;
  const above = (x: [number, number, string], y: [number, number, string]): boolean =>
    x[0] > y[0] || (x[0] === y[0] && x[1] < y[1]);
  const push = (name: string): void => {
    heap.push([score(name), order.get(name)!, name]);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!above(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  };
  const pop = (): [number, number, string] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        let best = i;
        for (const child of [2 * i + 1, 2 * i + 2])
          if (child < heap.length && above(heap[child]!, heap[best]!)) best = child;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best]!, heap[i]!];
        i = best;
      }
    }
    return top;
  };
  const doomed: string[] = [];
  const remove = (name: string): void => {
    const out = callees.get(name)!;
    const into = callers.get(name)!;
    callees.delete(name);
    callers.delete(name);
    for (const callee of out)
      if (callee !== name) {
        const set = callers.get(callee)!;
        set.delete(name);
        if (set.size === 0) doomed.push(callee);
        else push(callee);
      }
    for (const caller of into)
      if (caller !== name) {
        const set = callees.get(caller)!;
        set.delete(name);
        if (set.size === 0) doomed.push(caller);
        else push(caller);
      }
  };
  // Removes the functions that can no longer lie on a cycle, transitively.
  const settle = (): void => {
    while (doomed.length > 0) {
      const name = doomed.pop()!;
      if (callees.has(name)) remove(name);
    }
  };
  for (const name of candidates) {
    if (callees.get(name)!.size === 0 || callers.get(name)!.size === 0) doomed.push(name);
    else push(name);
  }
  settle();
  for (const name of candidates)
    if (callees.get(name)?.has(name) === true) {
      chosen.add(name);
      remove(name);
      settle();
    }
  while (heap.length > 0) {
    const [entryScore, , name] = pop();
    if (!callees.has(name) || entryScore !== score(name) || name === REENTRY) continue;
    chosen.add(name);
    remove(name);
    settle();
  }
  // Bound the runs of unchecked cycle functions (acyclic once the chosen
  // ones are removed; the reentry node takes no frame): the longest run
  // ending at each function, in topological order, and a check where it
  // would grow too long.
  const unchecked = candidates.filter((name) => !chosen.has(name));
  const pending = new Map<string, number>(unchecked.map((name) => [name, 0]));
  for (const name of unchecked)
    for (const callee of new Set(edges.get(name)))
      if (pending.has(callee)) pending.set(callee, pending.get(callee)! + 1);
  const run = new Map<string, number>();
  const ready = unchecked.filter((name) => pending.get(name) === 0);
  for (let i = 0; i < ready.length; i++) {
    const name = ready[i]!;
    let depth = (run.get(name) ?? 0) + (name === REENTRY ? 0 : 1);
    if (depth > MAX_UNCHECKED_CYCLE_RUN && name !== REENTRY) {
      chosen.add(name);
      depth = 0;
    }
    for (const callee of new Set(edges.get(name))) {
      if (!pending.has(callee)) continue;
      run.set(callee, Math.max(run.get(callee) ?? 0, depth));
      const left = pending.get(callee)! - 1;
      pending.set(callee, left);
      if (left === 0) ready.push(callee);
    }
  }
  return chosen;
}

/** Functions on a cycle of the call graph (Tarjan's strongly connected
 * components, iterative so deep call chains cannot exhaust the stack). */
function cyclicFunctions(edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  let next = 0;
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: { name: string; edge: number }[] = [{ name: root, edge: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const callees = edges.get(frame.name) ?? [];
      if (frame.edge < callees.length) {
        const callee = callees[frame.edge++]!;
        if (callee === frame.name) cyclic.add(callee);
        if (!index.has(callee)) {
          index.set(callee, next);
          low.set(callee, next++);
          stack.push(callee);
          onStack.add(callee);
          work.push({ name: callee, edge: 0 });
        } else if (onStack.has(callee)) {
          low.set(frame.name, Math.min(low.get(frame.name)!, index.get(callee)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.name, Math.min(low.get(parent.name)!, low.get(frame.name)!));
      if (low.get(frame.name) !== index.get(frame.name)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.name);
      if (component.length > 1) for (const name of component) cyclic.add(name);
    }
  }
  return cyclic;
}
