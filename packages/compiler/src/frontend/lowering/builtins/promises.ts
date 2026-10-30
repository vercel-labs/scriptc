import { keyedHelperName } from "../stable-names.js";
import { checkedPromiseAll, thenReader } from "../checked-promise-all.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { countedFor, varRef } from "../../../ir/build.js";
import { arrayValueStore, optionalElementValue, primitiveElement } from "../array-values.js";
import {
  maybePromiseResolve,
  maybePromiseUnionOf,
  promiseOrUnitUnionOf,
} from "../maybe-promise.js";
import { isJsSourceFile, locOf } from "../../program.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  funcOf,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";

/** `Promise.all([p, q, r])` over DIFFERENT promise types — the checker's
 * tuple overload, `Promise<[A, B, C]>`: the result type and tuple shape,
 * or null when the result type or an entry has no typed home here.
 * Entries are promises, checked-dynamic values (a JavaScript function's
 * result) and plain numbers, strings, booleans and unit values, which are
 * never thenable. */
function tuplePromiseAllShape(
  lowerer: Lowerer,
  call: ts.CallExpression,
  elems: readonly IrExpr[],
): { resultT: IrType & { kind: "promise" }; tuple: IrType & { kind: "record" } } | null {
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (resultT?.kind !== "promise" || resultT.inner.kind !== "record") return null;
  const shape = lowerer.shapes.get(resultT.inner.shapeId);
  if (!shape?.tuple || shape.fields.length !== elems.length) return null;
  const plainValue = (t: IrType): boolean =>
    t.kind === "f64" || t.kind === "string" || t.kind === "bool" || isUnitType(t);
  // A checked-dynamic entry (a JavaScript function's result) may hold a
  // promise or a plain value at run time; it joins through its promise view.
  const settles = (t: IrType): boolean => t.kind === "promise" || t.kind === "dyn";
  if (!elems.some((e) => settles(e.type))) return null;
  if (!elems.every((e) => settles(e.type) || plainValue(e.type))) return null;
  return { resultT, tuple: resultT.inner };
}

/** `Promise.all([p, q, r])` over different promise types. Each entry
 * becomes a promise in input order (a plain value through Promise.resolve,
 * a checked-dynamic one through its PromiseResolve view: the promise it
 * holds, a promise that adopts a thenable, or a promise fulfilled with the
 * value), widened to Promise<void>, a type-only view. The runtime
 * combinator over them gives Node's settlement: the first rejection in
 * settlement order wins and every later one counts as handled. The
 * result settles inside the combinator's own settlement, so it and its
 * awaits land on Node's microtask turns; a fulfillment runs one interned
 * function per entry/result signature that reads the fulfilled entries
 * into the tuple. Entries keep their identity: no value converts through
 * the checked-dynamic tree. */
function lowerTuplePromiseAll(
  lowerer: Lowerer,
  call: ts.CallExpression,
  elems: IrExpr[],
): IrExpr | null {
  const plan = tuplePromiseAllShape(lowerer, call, elems);
  if (!plan) return null;
  const { resultT, tuple } = plan;
  const loc = locOf(call);
  const voidPromise: IrType & { kind: "promise" } = { kind: "promise", inner: VOID };
  const entriesT = arrayOf(voidPromise);
  const dynPromise: IrType = { kind: "promise", inner: DYN };
  // A checked-dynamic entry's PromiseResolve can run a `then` getter, which
  // Node runs after the whole array literal evaluated. With such an entry,
  // every entry evaluates into a hidden local first.
  const staged: IrStmt[] = [];
  const values = !elems.some((e) => e.type.kind === "dyn")
    ? elems
    : elems.map((e): IrExpr => {
        if (e.kind === "unitLit") return e;
        if (isUnitType(e.type)) {
          staged.push({ kind: "exprStmt", expr: e, loc });
          return {
            kind: "unitLit",
            unit: e.type.kind === "nullT" ? "null" : "undefined",
            type: e.type,
            loc,
          };
        }
        const local = lowerer.declareHiddenLocal("%allValue", e.type);
        staged.push({ kind: "varDecl", localId: local.id, init: e, loc });
        return varRef(local.id, e.type, loc);
      });
  const entries = values.map((e): IrExpr => {
    let promise: IrExpr;
    if (e.type.kind === "promise") promise = e;
    else if (e.type.kind === "dyn")
      promise = {
        kind: "libCall",
        fn: "dyn.promiseResolve",
        args: [e, thenReader(lowerer, loc)],
        type: dynPromise,
        loc,
      };
    else if (isUnitType(e.type)) {
      // A unit entry's value is its type's one value; the promise only
      // takes its place in the combinator.
      const resolved: IrExpr = {
        kind: "intrinsic",
        name: "promise.resolve",
        args: [],
        type: voidPromise,
        loc,
      };
      promise =
        e.kind === "unitLit"
          ? resolved
          : {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: e, loc }],
              result: resolved,
              type: voidPromise,
              loc,
            };
    } else
      promise = {
        kind: "intrinsic",
        name: "promise.resolve",
        args: [e],
        type: { kind: "promise", inner: e.type },
        loc,
      };
    return promise.type.kind === "promise" && promise.type.inner.kind === "void"
      ? promise
      : { kind: "promiseVoidWiden", value: promise, type: voidPromise, loc };
  });
  const key = `${elems.map((e) => typeKey(e.type)).join(",")}->${typeKey(tuple)}`;
  let name = lowerer.arrHofHelpers.get(`promise.allTuple:${key}`);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%promise.allTuple", `promise.allTuple:${key}`);
    lowerer.arrHofHelpers.set(`promise.allTuple:${key}`, name);
    const shape = lowerer.shapes.get(tuple.shapeId)!;
    const entriesRef = varRef("entries.0", entriesT, loc);
    // Shape fields are sorted by name ("10" before "2"); a tuple field's
    // name is its position.
    const fields = shape.fields.map((field) => {
      const i = Number(field.name);
      const type = elems[i]!.type;
      const inner = type.kind === "promise" ? type.inner : type;
      const value: IrExpr =
        inner.kind === "void"
          ? { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }
          : isUnitType(inner)
            ? {
                kind: "unitLit",
                unit: inner.kind === "nullT" ? "null" : "undefined",
                type: inner,
                loc,
              }
            : {
                kind: "libCall",
                fn: "promise.fulfilledValue",
                args: [
                  {
                    kind: "arrayGet",
                    arr: entriesRef,
                    index: { kind: "numLit", value: i, type: F64, loc },
                    type: voidPromise,
                    loc,
                  },
                ],
                type: inner,
                loc,
              };
      return { name: field.name, value: lowerer.coerceToExpected(value, field.type) };
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "entries.0", name: "entries", type: entriesT }],
      returnType: tuple,
      locals: [{ id: "entries.0", name: "entries", type: entriesT, mutable: false }],
      body: [{ kind: "return", value: { kind: "recordLit", fields, type: tuple, loc }, loc }],
      loc,
    });
  }
  const all: IrExpr = {
    kind: "libCall",
    fn: "promise.allTuple",
    args: [
      { kind: "arrayLit", elems: entries, type: entriesT, loc },
      { kind: "closure", fnName: name, captures: [], type: funcOf([entriesT], tuple), loc },
    ],
    type: resultT,
    loc,
  };
  return staged.length === 0
    ? all
    : { kind: "seqExpr", stmts: staged, result: all, type: resultT, loc };
}

/** `Promise.race([...])` on THE Promise global: the entries lower
 * individually (the array never materializes — promise-element arrays
 * have no representation) into a promise.race intrinsic; the result
 * type is the checker's combined promise, and each entry's inner type
 * must be that inner type, one of its union arms, or a sub-union of it
 * (the backend's interned adapters wrap/re-tag fulfillments; a wider
 * entry would need machinery that doesn't exist and fences). A
 * Promise<never> entry fits any result, and an entry whose payload widens
 * into the result's converts. When the checker's combined type has no
 * representation, the result takes the type the entries that can fulfill
 * share, or 'unknown'.
 * Promise.all/allSettled/any fence with the sequential-await hint;
 * resolve/reject and the rest fall to the member fence. Null for
 * non-Promise receivers. */
export function lowerPromiseStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "Promise");
  if (member === null) return null;
  const loc = locOf(call);
  if (member === "race") {
    const argNode = call.arguments.nodes.length === 1 ? call.arguments.nodes[0]! : null;
    if (
      !argNode ||
      !ts.isArrayLiteralExpression(argNode) ||
      argNode.elements.nodes.some(ts.isSpreadElement) ||
      argNode.elements.nodes.length === 0
    ) {
      lowerer.noLowering(
        "Promise.race over this argument shape",
        call,
        "a non-empty array LITERAL of promises is the supported form: Promise.race([p, q])",
      );
    }
    // A Promise<never> entry (the deadline idiom: `new Promise<never>((_,
    // reject) => setTimeout(reject, ms))`) can only reject, so it races
    // under any result type; its inner type maps to void.
    const neverEntry = (el: ts.Expression): boolean => {
      const t = lowerer.typeOf(el);
      const arg =
        ts.symbolNameOf(t.getSymbol()) === "Promise"
          ? lowerer.checker.getTypeArguments(t as ts.TypeReference)[0]
          : undefined;
      return arg !== undefined && (arg.flags & ts.TypeFlags.Never) !== 0;
    };
    const elements = argNode.elements.nodes;
    let combined = lowerer.mapTypeOf(lowerer.typeOf(call));
    let lowered: IrExpr[] | null = null;
    if (combined?.kind !== "promise") {
      // The checker's combined type has no representation (an 'any'
      // element array such as events.once's any[], or 'void | any[]'): the
      // result takes the one type the entries that can fulfill share, or
      // else 'unknown' when each of them widens into it.
      lowered = elements.map((el) => lowerer.lowerExpr(el));
      const fulfilling = lowered.filter((_, i) => !neverEntry(elements[i]!));
      const first = fulfilling[0]?.type;
      const dynResult: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
      if (first?.kind === "promise" && fulfilling.every((e) => typeEquals(e.type, first))) {
        combined = first;
      } else if (
        fulfilling.length > 0 &&
        fulfilling.every(
          (e) => e.type.kind === "promise" && lowerer.promisePayloadWidens(e.type, dynResult),
        )
      ) {
        combined = dynResult;
      } else {
        lowerer.noLowering(
          "Promise.race with this combined result type",
          call,
          "the entries' value types must combine into a representable union",
        );
      }
    }
    const resultT = combined;
    const resultArms =
      resultT.inner.kind === "union"
        ? (lowerer.unions.get(resultT.inner.unionId)?.arms ?? [])
        : null;
    const compatible = (inner: IrType): boolean => {
      if (typeEquals(inner, resultT.inner)) return true;
      if (!resultArms) return false;
      // A Promise<void> entry fulfills with undefined, which the result
      // holds when the checker folded `void` into its undefined arm.
      if (inner.kind === "void") return resultArms.some((a) => a.kind === "undefinedT");
      if (inner.kind === "union") {
        const arms = lowerer.unions.get(inner.unionId)?.arms ?? [];
        return arms.every((a) => resultArms.some((b) => typeEquals(a, b)));
      }
      return resultArms.some((a) => typeEquals(a, inner));
    };
    const entries = elements.map((el, i) => {
      const entry = lowered?.[i] ?? lowerer.lowerExpr(el);
      if (entry.type.kind !== "promise") {
        lowerer.noLowering(
          "Promise.race over non-promise entries",
          el,
          "JS would resolve plain values — wrap them: new Promise((r) => r(v))",
        );
      }
      if (!compatible(entry.type.inner) && !(entry.type.inner.kind === "void" && neverEntry(el))) {
        // A payload that widens into the result's (into 'unknown', or a
        // checked conversion) keeps its promise and settlement turn.
        if (lowerer.promisePayloadWidens(entry.type, resultT))
          return lowerer.coerceToExpected(entry, resultT);
        lowerer.unsupported(
          "SC1090",
          el,
          `Promise.race entries of inner type '${lowerer.fmt(entry.type.inner)}' under a ` +
            `'${lowerer.fmt(resultT.inner)}' result (every entry must be the result type, one ` +
            `of its arms, or a sub-union of it)`,
        );
      }
      return entry;
    });
    return { kind: "intrinsic", name: "promise.race", args: entries, type: resultT, loc };
  }
  // `Promise.all(ps)` over ONE promise type: the argument is any
  // expression of type Promise<T>[] (promise-element arrays are real —
  // `refs.map(loadAsync)`, an annotated literal) and the result is the
  // checker's Promise<T[]>. Node-exact through the runtime's countdown
  // combinator: the values array is filled per INPUT index regardless of
  // settlement order, the first rejection (in settlement order) wins and
  // later ones count as handled, the empty array resolves immediately,
  // and already-settled entries settle inline. Promise<void> entries
  // collapse to a `Promise<void>` result (a void[] value has no
  // representation; `await Promise.all(voids)` is the supported shape).
  // Heterogeneous ARRAY LITERALS land on the tuple overload
  // (Promise<[A, B]>) and fence here — one promise type is the bound.
  if (member === "all") {
    const argNode = call.arguments.nodes.length === 1 ? call.arguments.nodes[0]! : null;
    if (!argNode) {
      lowerer.noLowering(
        "Promise.all with this argument shape",
        call,
        "one array of promises is the supported form: Promise.all(ps) with ps: Promise<T>[]",
      );
    }
    // A UNIFORM array literal — `Promise.all([readFile(a), readFile(b)])`
    // where every entry is the SAME Promise<T> (the portless
    // generateHostCertAsync pair): the checker's tuple overload types
    // the literal as [Promise<T>, Promise<T>], but with one shared T
    // the tuple IS an array — the entries lower into a Promise<T>[]
    // and the result is Promise<T[]> (destructuring reads it exactly
    // like the tuple; the elements are the same T either way).
    if (
      ts.isArrayLiteralExpression(argNode) &&
      !argNode.elements.nodes.some(ts.isSpreadElement) &&
      argNode.elements.nodes.length > 0
    ) {
      const elems = argNode.elements.nodes.map((el) => lowerer.lowerExpr(el));
      const first = elems[0]!.type;
      if (
        first.kind === "promise" &&
        elems.every((e) => e.type.kind === "promise" && typeEquals(e.type, first))
      ) {
        const entriesArr: IrExpr = { kind: "arrayLit", elems, type: arrayOf(first), loc };
        const resultT: IrType = {
          kind: "promise",
          inner: first.inner.kind === "void" ? VOID : arrayOf(first.inner),
        };
        return { kind: "intrinsic", name: "promise.all", args: [entriesArr], type: resultT, loc };
      }

      if (!isJsSourceFile(ts.getSourceFileOfNode(call))) {
        const tuple = lowerTuplePromiseAll(lowerer, call, elems);
        if (tuple) return tuple;
      }
      if (
        isJsSourceFile(ts.getSourceFileOfNode(call)) &&
        elems.every((entry) => lowerer.dynConvertible(entry.type))
      ) {
        return checkedPromiseAll(
          lowerer,
          {
            kind: "arrayLit",
            elems: elems.map((entry) => lowerer.coerceToExpected(entry, DYN)),
            type: arrayOf(DYN),
            loc,
          },
          loc,
        );
      }
      lowerer.noLowering(
        "Promise.all over this argument shape",
        argNode,
        "the entries must share ONE promise type — Promise.all([p, q]) lowers when p and q are the same Promise<T>",
      );
    }
    const entries = lowerer.lowerExpr(argNode);
    if (entries.type.kind === "dyn") return checkedPromiseAll(lowerer, entries, loc);
    // An 'any'-typed argument that holds a typed value (`const xs: any =
    // []`): the combinator reads it as the runtime value it is.
    if (
      (lowerer.typeOf(argNode).flags & ts.TypeFlags.Any) !== 0 &&
      lowerer.dynConvertible(entries.type)
    )
      return checkedPromiseAll(lowerer, lowerer.coerceToExpected(entries, DYN), loc);

    // loadPlugin(p)))` — the loadPlugins shape, where the checker
    // spells `any[]`): the ENGINE's own Promise.all runs over the
    // marshaled array (an 'any' value passes through; an `any[]` value

    if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
      // The heterogeneous-literal case: the checker's tuple overload
      // types the literal as a TUPLE of promises (a tuple-flagged record
      // here), or a union-of-promises element survives as the array's
      // elem — either way the fix is one shared promise type, so say
      // that.
      const tupleFields =
        entries.type.kind === "record" ? lowerer.shapes.get(entries.type.shapeId) : undefined;
      const mixedPromises =
        (entries.type.kind === "array" &&
          entries.type.elem.kind === "union" &&
          (lowerer.unions.get(entries.type.elem.unionId)?.arms ?? []).every(
            (a) => a.kind === "promise",
          )) ||
        (tupleFields?.tuple === true && tupleFields.fields.every((f) => f.type.kind === "promise"));
      lowerer.noLowering(
        "Promise.all over this argument shape",
        argNode,
        mixedPromises
          ? "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...]) " +
              "so the result is Promise<T[]>, not a tuple"
          : "an array of promises (Promise<T>[]) is the supported form",
      );
    }
    const inner = entries.type.elem.inner;
    const resultT: IrType | null =
      inner.kind === "void"
        ? { kind: "promise", inner: VOID }
        : lowerer.mapTypeOf(lowerer.typeOf(call));
    // An unannotated JavaScript parameter (`Promise.all(items)` in a
    // package's .js file) types the call as Promise<any[]>, which has no
    // typed layout: the engine's Promise.all runs over the entries as
    // checked-dynamic values, as it does for an array literal there.
    if (
      resultT === null &&
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      lowerer.dynConvertible(entries.type)
    ) {
      return checkedPromiseAll(lowerer, lowerer.coerceToExpected(entries, DYN), loc);
    }
    // Promise<T | undefined>[] combines into a `(T | undefined)[]`, which
    // stores T elements (primitiveElement): collect the values, then copy
    // them in with their present undefined values.
    if (
      resultT?.kind === "promise" &&
      resultT.inner.kind === "array" &&
      primitiveElement(resultT.inner.elem) &&
      optionalElementValue(
        lowerer,
        { kind: "unitLit", unit: "undefined", type: inner, loc },
        resultT.inner.elem,
      )
    ) {
      const joined = optionalPromiseAll(
        lowerer,
        entries,
        inner,
        resultT as IrType & { kind: "promise" },
        loc,
      );
      if (joined) return joined;
    }
    if (
      resultT?.kind !== "promise" ||
      (inner.kind !== "void" &&
        (resultT.inner.kind !== "array" || !typeEquals(resultT.inner.elem, inner)))
    ) {
      lowerer.noLowering(
        "Promise.all with this combined result type",
        call,
        "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...]) " +
          "so the result is Promise<T[]>, not a tuple",
      );
    }
    return { kind: "intrinsic", name: "promise.all", args: [entries], type: resultT, loc };
  }
  if (member === "allSettled" || member === "any") {
    const argNode = call.arguments.nodes.length === 1 ? call.arguments.nodes[0]! : null;
    if (!argNode || ts.isSpreadElement(argNode)) {
      lowerer.noLowering(
        `Promise.${member} with this argument shape`,
        call,
        `one iterable of promises is the supported form: Promise.${member}(ps)`,
      );
    }
    if (isJsSourceFile(ts.getSourceFileOfNode(call))) {
      // JavaScript entries are checked-dynamic: any iterable, thenables
      // and plain values included, exactly like Promise.all.
      if (
        ts.isArrayLiteralExpression(argNode) &&
        !argNode.elements.nodes.some(ts.isSpreadElement)
      ) {
        const elems = argNode.elements.nodes.map((el) => lowerer.lowerExpr(el));
        if (elems.every((entry) => lowerer.dynConvertible(entry.type))) {
          const entries: IrExpr = {
            kind: "arrayLit",
            elems: elems.map((entry) => lowerer.coerceToExpected(entry, DYN)),
            type: arrayOf(DYN),
            loc,
          };
          return checkedPromiseAll(lowerer, entries, loc, member);
        }
      } else {
        const entries = lowerer.lowerExpr(argNode);
        // A typed promise array keeps its typed lowering.
        if (entries.type.kind === "array" && entries.type.elem.kind === "promise")
          return lowerTypedSettledCombinator(lowerer, call, argNode, member, entries);
        if (entries.type.kind === "dyn" || lowerer.dynConvertible(entries.type))
          return checkedPromiseAll(lowerer, entries, loc, member);
      }
      lowerer.noLowering(
        `Promise.${member} over this argument shape`,
        argNode,
        "the entries must be representable as checked-dynamic values",
      );
    }
    return lowerTypedSettledCombinator(lowerer, call, argNode, member);
  }
  // Promise.withResolvers<T>(): the executor pieces without an
  // executor — a pending promise plus its runtime resolve/reject
  // closures in the `{ promise, resolve, reject }` record. The
  // overrides declaration shapes the record so its fields map exactly
  // (plain-value resolve, Error-pinned reject); the emitter assembles
  // the record from the newPromise machinery.
  if (member === "withResolvers") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`Promise.withResolvers with arguments`, call);
    }
    // The type mapper owns the record shape (its withResolvers
    // special-case — the anonymous ambient literal fails the record
    // provenance gate, so the mapper interns the shape manually).
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "record") {
      lowerer.noLowering(
        "Promise.withResolvers at this type",
        call,
        "the promised value's type must be representable — annotate it: Promise.withResolvers<T>()",
      );
    }
    return { kind: "promiseWithResolvers", type: resultT, loc };
  }
  // Promise.try(f) — call f SYNCHRONOUSLY, fulfill with its plain
  // result, adopt a returned promise, and turn a synchronous throw
  // into a rejection. That is observably `(async () => f())()` —
  // tick-for-tick in Node for plain results (probed), with the
  // promise-returning form riding the async return-adoption machinery
  // (its one-tick residue is SEMANTICS.md 358) — so the lowering IS
  // that wrapper: one interned async helper per callback and argument
  // types. `Promise.try(f, ...args)` evaluates the arguments at the call
  // and passes them to f, which still runs synchronously.
  if (member === "try") {
    const fNode = call.arguments.nodes[0];
    const argNodes = call.arguments.nodes.slice(1);
    if (fNode === undefined || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `Promise.try with ${call.arguments.nodes.length === 0 ? "no" : "spread"} arguments`,
        call,
        "pass the callback and its arguments directly: Promise.try(f, a, b)",
      );
    }
    const f = lowerer.lowerExpr(fNode);
    // Arguments past the callback's parameters are evaluated and dropped;
    // only an arrow function, which has no `arguments`, can ignore them.
    if (
      f.type.kind !== "func" ||
      f.type.params.length > argNodes.length ||
      (f.type.params.length < argNodes.length && !ts.isArrowFunction(fNode))
    ) {
      lowerer.noLowering(
        `Promise.try over a callback of type '${lowerer.checker.typeToString(lowerer.typeOf(fNode))}' with ${argNodes.length} argument${argNodes.length === 1 ? "" : "s"}`,
        fNode,
        "pass one argument per callback parameter: Promise.try((a, b) => a + b, 1, 2)",
      );
    }
    const fnT = f.type;
    const args = argNodes.map((node, i) =>
      i < fnT.params.length
        ? lowerer.lowerExprExpecting(node, fnT.params[i]!)
        : lowerer.lowerExpr(node),
    );
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "promise") {
      lowerer.noLowering(
        "Promise.try at this type",
        call,
        "the promised value's type must be representable — annotate it: Promise.try<T>(f)",
      );
    }
    const inner = resultT.inner;
    const ret = f.type.ret;
    // The helper's return must BE the callback's result (fulfillment)
    // or its adopted settlement (promise results) — anything the
    // checker widened past that has no adapter here.
    const settled = ret.kind === "promise" ? ret.inner : ret;
    if (
      !typeEquals(settled, inner) &&
      !(isUnitType(settled) && inner.kind === "void") &&
      !(settled.kind === "void" && inner.kind === "void")
    ) {
      lowerer.noLowering(
        "Promise.try where the callback's result type differs from the promised type",
        call,
        "annotate both to one T: Promise.try<T>(f) with f returning T or Promise<T>",
      );
    }
    const key = `promise.try:${typeKey(f.type)}:${args.map((a) => typeKey(a.type)).join(",")}`;
    let helper = lowerer.arrHofHelpers.get(key);
    if (!helper) {
      helper = keyedHelperName(lowerer, "%promise.try", key);
      lowerer.arrHofHelpers.set(key, helper);
      const fRef: IrExpr = { kind: "varRef", localId: "f.0", type: f.type, loc };
      const argLocals = args.map((a, i) => ({ id: `a${i}.0`, name: `a${i}`, type: a.type }));
      const callF: IrExpr = {
        kind: "callValue",
        callee: fRef,
        args: argLocals
          .slice(0, fnT.params.length)
          .map((a) => ({ kind: "varRef" as const, localId: a.id, type: a.type, loc })),
        type: ret,
        loc,
      };
      // Adopt a promise result before either returning its value or completing void.
      const value: IrExpr =
        ret.kind === "promise" ? { kind: "awaitExpr", value: callF, type: ret.inner, loc } : callF;
      const body: IrStmt[] =
        inner.kind === "void"
          ? [
              { kind: "exprStmt", expr: value, loc },
              { kind: "return", value: null, loc },
            ]
          : [{ kind: "return", value, loc }];
      const lifted: IrFunction = {
        name: helper,
        params: [
          { localId: "f.0", name: "f", type: f.type },
          ...argLocals.map((a) => ({ localId: a.id, name: a.name, type: a.type })),
        ],
        returnType: inner,
        locals: [
          { id: "f.0", name: "f", type: f.type, mutable: true },
          ...argLocals.map((a) => ({ ...a, mutable: true })),
        ],
        body,
        loc,
        async: true,
      };
      lowerer.liftedFns.push(lifted);
    }
    return { kind: "call", callee: helper, args: [f, ...args], type: resultT, loc };
  }
  // Promise.resolve — the already-settled promise. Zero arguments is
  // Promise<void>; a PROMISE argument is returned as-is (the spec's
  // native-promise identity — every scriptc promise is native, so
  // Promise.resolve(p) === p exactly); a plain representable value
  // fulfills a fresh promise immediately. Thenables (a `then`-carrying
  // object would be ADOPTED in JS, not wrapped) and promise-armed
  // unions (wrap-or-identity depends on the runtime arm) fence.
  if (member === "resolve") {
    if (
      call.arguments.nodes.length > 1 ||
      call.arguments.nodes.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(`Promise.resolve with ${call.arguments.nodes.length} arguments`, call);
    }
    const argNode = call.arguments.nodes[0];
    if (argNode !== undefined) {
      const argT = lowerer.typeOf(argNode);
      const argIr = lowerer.mapTypeOf(argT);
      if (argIr?.kind === "promise") {
        const v = lowerer.lowerExpr(argNode);
        if (v.type.kind !== "promise") lowerer.badType(argNode, argT);
        return v;
      }
      // A promise-or-unit union (`Promise<void> | void`,
      // `Promise<T> | undefined`) resolves exactly like a maybe-promise
      // one: Node adopts a promise operand and fulfills every other value
      // as itself (a nullish arm fulfills undefined).
      const maybePromise = argIr
        ? (maybePromiseUnionOf(lowerer, argIr) ?? promiseOrUnitUnionOf(lowerer, argIr))
        : null;
      if (maybePromise) {
        const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
        const v = lowerer.lowerExpr(argNode);
        const mp = maybePromiseUnionOf(lowerer, v.type) ?? promiseOrUnitUnionOf(lowerer, v.type);
        const resolved =
          resultT?.kind === "promise" && mp
            ? maybePromiseResolve(lowerer, v, mp, resultT, loc)
            : null;
        if (resolved) return resolved;
        lowerer.noLowering(
          `Promise.resolve over '${lowerer.fmt(v.type)}' at this result type`,
          argNode,
          "the promise arm passes through identically, so it must already be the result's promise type",
        );
      }
      if (
        argIr?.kind === "union" &&
        (lowerer.unions.get(argIr.unionId)?.arms ?? []).some((a) => a.kind === "promise")
      ) {
        lowerer.noLowering(
          "Promise.resolve over a value that may already be a promise",
          argNode,
          "narrow first: a plain value wraps, a promise passes through identically — the union hides which",
        );
      }
      if (argIr?.kind === "record" || argIr?.kind === "object") {
        const thenSym = lowerer.checker.getPropertyOfType(argT, "then");
        if (thenSym !== undefined) {
          lowerer.noLowering(
            "Promise.resolve of a thenable",
            argNode,
            "JS would ADOPT the then method, not wrap the object — await the thenable's settlement explicitly",
          );
        }
      }
    }
    let resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    // A maybe-promise context (`return Promise.resolve(v)` from a function
    // returning `Promise<R | void> | R | void`) names its promise arm: the
    // fresh promise takes that payload type directly.
    if (argNode !== undefined && resultT?.kind === "promise") {
      const ctxT = lowerer.checker.getContextualType(call);
      const contextual = ctxT?.isUnionType() ? lowerer.mapTypeOf(ctxT) : null;
      const mp = contextual ? maybePromiseUnionOf(lowerer, contextual) : null;
      if (mp && !typeEquals(mp.promise, resultT) && mp.promise.inner.kind !== "void")
        resultT = mp.promise;
    }
    if (resultT?.kind !== "promise") {
      lowerer.noLowering(
        "Promise.resolve at this type",
        call,
        "the promised value's type must be representable — annotate it: Promise.resolve<T>(v)",
      );
    }
    if (argNode === undefined) {
      return {
        kind: "intrinsic",
        name: "promise.resolve",
        args: [],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    if (resultT.inner.kind === "void") {
      return {
        kind: "seqExpr",
        stmts: [lowerer.lowerExprStatement(argNode)],
        result: { kind: "intrinsic", name: "promise.resolve", args: [], type: resultT, loc },
        type: resultT,
        loc,
      };
    }
    if (isUnitType(resultT.inner)) {
      // A unit payload (Promise<undefined>/Promise<null>) has no
      // fulfill adapter — await it as the void promise instead.
      lowerer.noLowering("Promise.resolve at a unit-typed promise", call);
    }
    const value = lowerer.lowerExprExpecting(argNode, resultT.inner);
    // In JavaScript, a checked-dynamic argument may itself hold a promise
    // (a TypeScript async callback's result: `Promise.resolve(fn())`):
    // Promise.resolve answers THAT promise — the same object, adopted —
    // and wraps every other value.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      value.type.kind === "dyn" &&
      resultT.inner.kind === "dyn"
    ) {
      const local = lowerer.declareHiddenLocal("%resolveValue", DYN);
      const ref: IrExpr = { kind: "varRef", localId: local.id, type: DYN, loc };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
        result: {
          kind: "ternary",
          cond: { kind: "dynTest", test: "promise", value: ref, type: BOOL, loc },
          then: { kind: "dynCheck", value: ref, type: resultT, loc },
          else_: { kind: "intrinsic", name: "promise.resolve", args: [ref], type: resultT, loc },
          type: resultT,
          loc,
        },
        type: resultT,
        loc,
      };
    }
    return { kind: "intrinsic", name: "promise.resolve", args: [value], type: resultT, loc };
  }
  return null; // reject lands on lowerPromiseRejectCall / the member fence
}

/** The entries of a typed Promise.allSettled / Promise.any: ONE promise
 * type, as an expression of type Promise<T>[] or a uniform array literal
 * (the Promise.all bound — a heterogeneous literal is a tuple). */
function typedPromiseEntries(
  lowerer: Lowerer,
  argNode: ts.Expression,
  member: string,
  lowered: IrExpr | undefined,
): IrExpr {
  const loc = locOf(argNode);
  let entries: IrExpr;
  if (lowered) {
    entries = lowered;
  } else if (
    ts.isArrayLiteralExpression(argNode) &&
    !argNode.elements.nodes.some(ts.isSpreadElement) &&
    argNode.elements.nodes.length > 0
  ) {
    const elems = argNode.elements.nodes.map((el) => lowerer.lowerExpr(el));
    const first = elems[0]!.type;
    if (
      first.kind !== "promise" ||
      !elems.every((e) => e.type.kind === "promise" && typeEquals(e.type, first))
    ) {
      lowerer.noLowering(
        `Promise.${member} over this argument shape`,
        argNode,
        `the entries must share ONE promise type — Promise.${member}([p, q]) lowers when p and q are the same Promise<T>`,
      );
    }
    entries = { kind: "arrayLit", elems, type: arrayOf(first), loc };
  } else {
    entries = lowerer.lowerExpr(argNode);
  }
  if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
    lowerer.noLowering(
      `Promise.${member} over this argument shape`,
      argNode,
      "an array of promises (Promise<T>[]) is the supported form",
    );
  }
  return entries;
}

/** allSettled's result type. A uniform array literal lands on the tuple
 * overload ({ [P in keyof T]: PromiseSettledResult<...> }), whose
 * elements share one type: the result is that element's array. */
function settledResultType(lowerer: Lowerer, call: ts.CallExpression): IrType | null {
  const callT = lowerer.typeOf(call);
  const awaited = lowerer.checker.getTypeArguments(callT as ts.TypeReference)[0];
  if (awaited && lowerer.checker.isTupleType(awaited)) {
    const elems = lowerer.checker.getTypeArguments(awaited as ts.TypeReference);
    const elem = elems[0] ? lowerer.mapTypeOf(elems[0]) : null;
    if (!elem || !elems.every((e) => typeEquals(lowerer.mapTypeOf(e) ?? VOID, elem))) return null;
    return { kind: "promise", inner: arrayOf(elem) };
  }
  return lowerer.mapTypeOf(callT);
}

/** `Promise.allSettled(ps)` / `Promise.any(ps)` over ONE promise type:
 * the runtime countdown combinator Promise.all rides, with Node's
 * per-entry reaction jobs. allSettled's result is the checker's
 * Promise<PromiseSettledResult<T>[]> — the { status, value } / { status,
 * reason } record union; any's is the entries' own Promise<T>. */
function lowerTypedSettledCombinator(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  member: "allSettled" | "any",
  lowered?: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const entries = typedPromiseEntries(lowerer, argNode, member, lowered);
  const entryT = entries.type.kind === "array" ? entries.type.elem : VOID;
  if (entryT.kind !== "promise")
    throw new InternalCompilerError("typedPromiseEntries admits only promise arrays");
  if (member === "any") {
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "promise" || !typeEquals(resultT, entryT)) {
      lowerer.noLowering(
        "Promise.any with this combined result type",
        call,
        "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...])",
      );
    }
    return { kind: "intrinsic", name: "promise.any", args: [entries], type: entryT, loc };
  }
  const resultT = settledResultType(lowerer, call);
  const valueT = entryT.inner.kind === "void" ? DYN : entryT.inner;
  const arms =
    resultT?.kind === "promise" &&
    resultT.inner.kind === "array" &&
    resultT.inner.elem.kind === "union"
      ? (lowerer.unions.get(resultT.inner.elem.unionId)?.arms ?? [])
      : [];
  const fieldsOf = (arm: IrType) =>
    arm.kind === "record" ? (lowerer.shapes.get(arm.shapeId)?.fields ?? []) : [];
  const fulfilled = arms.find((arm) => fieldsOf(arm).some((f) => f.name === "value"));
  if (
    resultT?.kind !== "promise" ||
    arms.length !== 2 ||
    fulfilled === undefined ||
    !typeEquals(fieldsOf(fulfilled).find((f) => f.name === "value")!.type, valueT)
  ) {
    lowerer.noLowering(
      "Promise.allSettled with this combined result type",
      call,
      "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...])",
    );
  }
  return { kind: "intrinsic", name: "promise.allSettled", args: [entries], type: resultT, loc };
}

/** `const pair = await Promise.all([p, q])` where every entry is the same
 * Promise<T> and the binding's type is the checker's tuple `[T, T]`: the
 * uniform entries settle through one runtime combinator into a T[] (the
 * same combinator and turn as the array form), and the binding receives
 * the tuple of its elements. Null for every other await. */
export function lowerAwaitedUniformPromiseAll(
  lowerer: Lowerer,
  expr: ts.AwaitExpression,
): IrExpr | null {
  let operand: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (
    !ts.isCallExpression(operand) ||
    operand.questionDotToken ||
    !ts.isPropertyAccessExpression(operand.expression) ||
    operand.arguments.nodes.length !== 1 ||
    isJsSourceFile(ts.getSourceFileOfNode(expr))
  )
    return null;
  const argNode = operand.arguments.nodes[0]!;
  if (
    !ts.isArrayLiteralExpression(argNode) ||
    argNode.elements.nodes.length === 0 ||
    argNode.elements.nodes.some(ts.isSpreadElement)
  )
    return null;
  let user: ts.Node = expr;
  while (ts.isParenthesizedExpression(user.parent)) user = user.parent;
  const decl = user.parent;
  if (!ts.isVariableDeclaration(decl) || decl.initializer !== user || !ts.isIdentifier(decl.name))
    return null;
  if (lowerer.stdlibGlobalMember(operand.expression, "Promise") !== "all") return null;
  const tuple = lowerer.mapTypeOf(lowerer.typeOf(decl.name));
  if (tuple?.kind !== "record") return null;
  const shape = lowerer.shapes.get(tuple.shapeId);
  if (!shape?.tuple || shape.fields.length !== argNode.elements.nodes.length) return null;
  const elems = argNode.elements.nodes.map((el) => lowerer.lowerExpr(el));
  const first = elems[0]!.type;
  if (
    first.kind !== "promise" ||
    first.inner.kind === "void" ||
    !elems.every((e) => typeEquals(e.type, first)) ||
    !shape.fields.every((f) => typeEquals(f.type, first.inner))
  )
    return null;
  const loc = locOf(expr);
  const values = arrayOf(first.inner);
  const local = lowerer.declareHiddenLocal("%allValues", values);
  const all: IrExpr = {
    kind: "intrinsic",
    name: "promise.all",
    args: [{ kind: "arrayLit", elems, type: arrayOf(first), loc }],
    type: { kind: "promise", inner: values },
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: local.id,
        init: { kind: "awaitExpr", value: all, type: values, loc },
        loc,
      },
    ],
    // Shape fields are sorted by name; a tuple field's name is its position.
    result: {
      kind: "recordLit",
      fields: shape.fields.map((f) => ({
        name: f.name,
        value: {
          kind: "arrayGet",
          arr: varRef(local.id, values, loc),
          index: { kind: "numLit", value: Number(f.name), type: F64, loc },
          type: f.type,
          loc,
        },
      })),
      type: tuple,
      loc,
    },
    type: tuple,
    loc,
  };
}

/** `Promise.all(ps)` over `Promise<T | undefined>[]` for a number, string or
 * boolean T, whose result is a `(T | undefined)[]` (stored as T elements).
 * The combinator joins the entries (promise.allTuple), and its builder
 * reads each fulfilled entry into the result with its present undefined,
 * inside the combinator's settlement, so the result settles on Node's
 * turn. Entries of another type keep the general combinator. */
function optionalPromiseAll(
  lowerer: Lowerer,
  entries: IrExpr,
  inner: IrType,
  resultT: IrType & { kind: "promise" },
  loc: SrcLoc,
): IrExpr | null {
  const entriesT = entries.type;
  if (entriesT.kind !== "array" || entriesT.elem.kind !== "promise") return null;
  if (!typeEquals(entriesT.elem.inner, inner)) return null;
  const outT = resultT.inner as IrType & { kind: "array" };
  const voidPromise: IrType & { kind: "promise" } = { kind: "promise", inner: VOID };
  const joinedT = arrayOf(voidPromise);
  const key = `promise.allOptional:${typeKey(entriesT)}:${typeKey(outT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%promise.allOptional", key);
    lowerer.arrHofHelpers.set(key, helper);
    const builder = keyedHelperName(lowerer, "%promise.allOptionalValues", key);
    const length = (arr: IrExpr): IrExpr => ({
      kind: "arrIntrinsic",
      method: "length",
      receiver: arr,
      args: [],
      type: F64,
      loc,
    });
    const joined = varRef("joined.0", joinedT, loc);
    const out = varRef("out.0", outT, loc);
    lowerer.liftedFns.push({
      name: builder,
      params: [{ localId: "joined.0", name: "joined", type: joinedT }],
      returnType: outT,
      locals: [
        { id: "joined.0", name: "joined", type: joinedT, mutable: false },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "v.0", name: "v", type: inner, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: outT, loc },
          loc,
        },
        countedFor(loc, length(joined), (index) => [
          {
            kind: "varDecl",
            localId: "v.0",
            init: {
              kind: "libCall",
              fn: "promise.fulfilledValue",
              args: [{ kind: "arrayGet", arr: joined, index, type: voidPromise, loc }],
              type: inner,
              loc,
            },
            loc,
          },
          arrayValueStore(lowerer, out, index, varRef("v.0", inner, loc), outT.elem, loc),
        ]),
        { kind: "return", value: out, loc },
      ],
      loc,
    });
    const ps = varRef("ps.0", entriesT, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "ps.0", name: "ps", type: entriesT }],
      returnType: resultT,
      locals: [
        { id: "ps.0", name: "ps", type: entriesT, mutable: false },
        { id: "joined.0", name: "joined", type: joinedT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "joined.0",
          init: { kind: "arrayLit", elems: [], type: joinedT, loc },
          loc,
        },
        countedFor(loc, length(ps), (index) => [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: joined,
              args: [
                {
                  kind: "promiseVoidWiden",
                  value: { kind: "arrayGet", arr: ps, index, type: entriesT.elem, loc },
                  type: voidPromise,
                  loc,
                },
              ],
              type: F64,
              loc,
            },
            loc,
          },
        ]),
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "promise.allTuple",
            args: [
              joined,
              {
                kind: "closure",
                fnName: builder,
                captures: [],
                type: funcOf([joinedT], outT),
                loc,
              },
            ],
            type: resultT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [entries], type: resultT, loc };
}
