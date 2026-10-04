/* Cheap whole-module may-throw analysis (see computeMayThrow). Pure function
 * of the IR module; the emitter consults the result to place unwind checks. */
import type { IrExpr, IrStmt, IrModule } from "../ir/ir.js";
import { isFfiCallbackParam, MAY_THROW_ARR_METHODS, MAY_THROW_BYTES_METHODS, MAY_THROW_LIB_FNS } from "../ir/ir.js";
import { everyStmtList } from "../ir/traverse.js";
import { hasRetainedFfiCallback } from "./ffi-callbacks.js";

/** Cheap may-throw analysis (cost discipline: functions that transitively
 * CANNOT throw pay for no pending-exception checks). A function may throw
 * iff it contains a `throw`, calls a may-throw function (direct `call` or
 * `new`-invoked constructor), or performs a `callValue` while ANY function
 * a closure is ever made over may throw (the callee of an indirect call is
 * unknown, but it must be a closure target of this whole-program module).
 * Fixpoint over the call graph; runtime traps (array OOB etc.) are aborts,
 * not exceptions, so most intrinsics never contribute. The module evaluator's
 * internal await and throwing library calls are the exceptions: both can
 * surface a catchable rejection/error and seed the fixpoint like a `throw`. */
export function computeMayThrow(mod: IrModule): { fns: Set<string>; indirect: boolean } {
  interface Facts {
    throws: boolean;
    callees: string[];
    callsValue: boolean;
  }
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
  const tdzGlobals = (mod.globals ?? []).filter((g) => g.tdz).map((g) => g.id);
  for (const cls of mod.classes ?? []) {
    constructorClasses.set(`%${cls.name}.constructor`, cls.name);
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  for (const fn of mod.functions) {
    const f: Facts = { throws: false, callees: [], callsValue: false };
    // TDZ reads and non-initializing writes can throw ReferenceError.
    // Capture locals carry the same flag as the declaring binding.
    const tdzIds = new Set([...tdzGlobals, ...fn.locals.filter((l) => l.tdz).map((l) => l.id)]);
    const mutableTdzIds = new Set([...tdzGlobals, ...fn.locals.filter((l) => l.tdz && l.mutable).map((l) => l.id)]);
    // Traverse typed executable nodes without copying the IR into unknown.
    const visit = (rec: IrExpr | IrStmt): boolean => {
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
          if (tdzIds.has(rec.localId)) f.throws = true;
          break;
        case "assign":
          // A declaration is allowed to fill an empty box. Legacy const
          // TDZ stores also initialize; only mutable subsequent stores
          // introduce the new write-side exception edge.
          if (rec.initializes !== true && mutableTdzIds.has(rec.localId)) f.throws = true;
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
        case "fieldIncDec":
          // A checked-dynamic field's ++/-- validates the number out of
          // the box — that dynCheck throws catchably on non-numbers.
          if (rec.fieldDyn === true) f.throws = true;
          break;
        case "dynCall":
        // Prototype dispatch throws the same family (not-a-function,
        // cannot-read, the loud unimplemented fence, callback throws).
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
          // HANDLE receivers can throw the loud unmodeled-property
          // ladder; Proxy get/has traps can throw too.
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
          break;
        case "yieldExpr":
          // A consumer .throw() surfaces at the yield (and .return()'s
          // GENRET sentinel unwinds from here too).
          f.throws = true;
          break;
        case "genResume":
          // A body exception (or the injected .throw payload on a
          // non-suspended generator) propagates into the resumer; the
          // reentrancy TypeError throws here too.
          f.throws = true;
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
            shape && (!shape.indexValue || (shape.indexValue.kind === "dyn" && shape.fields.length > 0))
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
          if (rec.operand.type.kind === "dyn" || rec.operand.type.kind === "union" || rec.operand.type.kind === "caught") f.throws = true;
          break;
        case "jsOp":
        case "jsExit":
        case "jsMarshal":
        case "jsBridgePromise":
          // Island operations bridge engine exceptions into the cell
          // (jsMarshal only on engine-level surprise, but the emitted
          // pending check exists — seed conservatively).
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
          if (
            callbackFfiImports.has(rec.import) ||
            manifestHasRetainedCallback
          ) f.throws = true;
          break;
        case "bytesNew": {
          // The size form (`new Uint8Array(n)`) throws Node's "Invalid
          // typed array length" RangeError on a bad length. Checked
          // inputs can also throw during element conversion.
          const source = rec.source;
          if (source && (source.type?.kind === "f64" || source.type?.kind === "dyn")) f.throws = true;
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
          if (rec.method === "normalize") f.throws = true;
          break;
        case "regexIntrinsic":
          // Keep the conservative exception check for these operations;
          // replaceAll and matchAll without /g throw Node's TypeError.
          if (rec.method === "replaceAll" || rec.method === "split" || rec.method === "matchAll" || rec.method === "matchAllInto") {
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
          if (cls !== undefined) {
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
          f.callsValue = true;
          break;
        case "closure":
          closureTargets.add(rec.fnName);
          break;
      }
      return true;
    };
    everyStmtList(fn.body, { expr: visit, stmt: visit });
    facts.set(fn.name, f);
  }

  // Propagate each newly throwing function along reverse call edges once.
  // Repeated full scans take one pass per level of a caller-first chain.
  const callers = new Map<string, string[]>();
  const indirectCallers: string[] = [];
  const may = new Set<string>();
  const pending: string[] = [];
  const mark = (name: string): void => {
    if (may.has(name)) return;
    may.add(name);
    pending.push(name);
  };
  for (const [name, f] of facts) {
    if (f.throws) mark(name);
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
  if (indirect) for (const name of indirectCallers) mark(name);
  for (let i = 0; i < pending.length; i++) {
    const name = pending[i]!;
    if (!indirect && closureTargets.has(name) && !asyncFns.has(name) && !genFns.has(name)) {
      indirect = true;
      for (const caller of indirectCallers) mark(caller);
    }
    for (const caller of callers.get(name) ?? []) mark(caller);
    let cls = constructorClasses.get(name);
    while (cls !== undefined && !throwingHierarchies.has(cls)) {
      const def = classes.get(cls);
      if (!def) break;
      throwingHierarchies.add(cls);
      const valueCallers = classValueCallers.get(cls);
      if (valueCallers) for (const caller of valueCallers) mark(caller);
      cls = def.base;
    }
  }
  return { fns: may, indirect };
}
