/* Cheap whole-module may-throw analysis (see computeMayThrow). Pure function
 * of the IR module; the emitter consults the result to place unwind checks. */
import type { IrArrIntrinsicMethod, IrBytesIntrinsicMethod, IrLibFn, IrModule } from "../../ir/nodes.js";
import { isFfiCallbackParam, MAY_THROW_ARR_METHODS, MAY_THROW_BYTES_METHODS, MAY_THROW_LIB_FNS } from "../../ir/nodes.js";

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
  const manifestHasRetainedCallback = (mod.ffiImports ?? []).some(
    (entry) => entry.params.some(
      (param) => isFfiCallbackParam(param) && param.callback.lifetime === "retained",
    ),
  );
  // Method name → every class's implementation of it (virtualCall callees).
  const methodImpls = new Map<string, string[]>();
  for (const cls of mod.classes ?? []) {
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  for (const fn of mod.functions) {
    const f: Facts = { throws: false, callees: [], callsValue: false };
    // TDZ locals (forward-captured consts): every read tests the box and
    // throws the catchable ReferenceError while it is empty.
    const tdzIds = new Set(fn.locals.filter((l) => l.tdz).map((l) => l.id));
    // The IR is plain JSON: a generic walk keyed on `kind` stays correct as
    // nodes grow fields (types' own `kind`s never collide with these).
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const rec = node as Record<string, unknown>;
      switch (rec["kind"]) {
        case "throw":
        case "rethrow":
        // The deferred JS compile fence throws catchably when executed.
        case "runtimeFence":
          f.throws = true;
          break;
        case "varRef":
          if (tdzIds.size > 0 && tdzIds.has(rec["localId"] as string)) f.throws = true;
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
          if ((rec["type"] as { kind?: string } | undefined)?.kind === "func") {
            sawDynFuncAdapter = true;
          }
          break;
        case "fieldIncDec":
          // A checked-dynamic field's ++/-- validates the number out of
          // the box — that dynCheck throws catchably on non-numbers.
          if (rec["fieldDyn"] === true) f.throws = true;
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
          // The keyed read throws JS's TypeError on an undefined/null
          // receiver (the `?.` form answers undefined instead), and
          // HANDLE receivers can throw the loud unmodeled-property
          // ladder on either form — seed both.
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
          if (rec["name"] === "module.await") f.throws = true;
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
          const shape = (mod.records ?? []).find((r) => r.id === rec["shapeId"]);
          if (
            rec["overflowOnly"] !== true &&
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
          const vt = (rec["value"] as { type?: { kind?: string } }).type?.kind;
          if (vt === "dyn" || vt === "record" || vt === "array" || vt === "union") f.throws = true;
          break;
        }
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
          if (MAY_THROW_LIB_FNS.has(rec["fn"] as IrLibFn)) f.throws = true;
          break;
        case "ffiCall":
          // A native callback may run arbitrary scriptc code. With retained
          // descriptors any manifest binding may pump a previously stored
          // callback, so every FFI call is conservatively a checkpoint.
          if (
            callbackFfiImports.has(rec["import"] as string) ||
            manifestHasRetainedCallback
          ) f.throws = true;
          break;
        case "bytesNew": {
          // The size form (`new Uint8Array(n)`) throws Node's "Invalid
          // typed array length" RangeError on a bad length; copy/array
          // sources never throw.
          const source = rec["source"] as { type?: { kind?: string } } | null;
          if (source && source.type?.kind === "f64") f.throws = true;
          break;
        }
        case "bytesIntrinsic":
          // setFrom and the numeric read/write families throw catchable
          // RangeErrors (Node's bounds discipline); the rest trap or
          // cannot fail.
          if (MAY_THROW_BYTES_METHODS.has(rec["method"] as IrBytesIntrinsicMethod)) {
            f.throws = true;
          }
          break;
        case "arrIntrinsic":
          if (MAY_THROW_ARR_METHODS.has(rec["method"] as IrArrIntrinsicMethod)) {
            f.throws = true;
          }
          break;
        case "regexIntrinsic":
          // replaceAll and matchAll without /g throw Node's TypeError;
          // split throws on a pattern with capture groups — all catchable.
          if (rec["method"] === "replaceAll" || rec["method"] === "split" || rec["method"] === "matchAll" || rec["method"] === "matchAllInto") {
            f.throws = true;
          }
          break;
        case "call": {
          // Calling an ASYNC function never unwinds the caller: a body
          // throw becomes a promise rejection (visible only at await).
          const callee = rec["callee"] as string;
          if (!asyncFns.has(callee) && !genFns.has(callee)) f.callees.push(callee);
          break;
        }
        case "new":
          f.callees.push(`%${rec["className"] as string}.constructor`);
          break;
        case "newValue": {
          // Construction through a class VALUE reaches the static class's
          // constructor or any strict descendant's — a sound (slightly
          // wide) cover is every constructor of the named class's
          // hierarchy; classval flows never leave it.
          const cls = ((rec["callee"] as { type?: { className?: string } }).type)?.className;
          if (cls !== undefined) {
            const descends = (name: string): boolean => {
              for (let c = (mod.classes ?? []).find((k) => k.name === name); c; c = (mod.classes ?? []).find((k) => k.name === c!.base)) {
                if (c.name === cls) return true;
                if (c.base === undefined) break;
              }
              return false;
            };
            for (const k of mod.classes ?? []) {
              if (descends(k.name)) f.callees.push(`%${k.name}.constructor`);
            }
          }
          break;
        }
        case "virtualCall": {
          // The concrete callee is any implementation of this method name
          // on a class — a sound (slightly wide, cross-hierarchy) cover of
          // the override set the dispatch can actually reach.
          const impls = methodImpls.get(rec["method"] as string);
          if (impls) f.callees.push(...impls);
          break;
        }
        case "callValue":
          f.callsValue = true;
          break;
        case "closure":
          closureTargets.add(rec["fnName"] as string);
          break;
      }
      for (const key of Object.keys(rec)) {
        if (key !== "loc" && key !== "type") visit(rec[key]);
      }
    };
    visit(fn.body);
    facts.set(fn.name, f);
  }

  const may = new Set<string>();
  for (const [name, f] of facts) if (f.throws) may.add(name);
  let indirect =
    sawDynFuncAdapter ||
    [...closureTargets].some((t) => may.has(t) && !asyncFns.has(t) && !genFns.has(t));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, f] of facts) {
      if (may.has(name)) continue;
      if ((f.callsValue && indirect) || f.callees.some((c) => may.has(c))) {
        may.add(name);
        changed = true;
      }
    }
    if (!indirect && [...closureTargets].some((t) => may.has(t) && !asyncFns.has(t) && !genFns.has(t))) {
      indirect = true;
      changed = true;
    }
  }
  return { fns: may, indirect };
}
