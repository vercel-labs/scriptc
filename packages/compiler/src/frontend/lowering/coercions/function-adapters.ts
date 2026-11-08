import { keyedHelperName } from "../stable-names.js";
import { dynUndefinedExpr, nodeThrowExpr } from "../../../ir/build.js";
import { buildFunctionAdapter } from "./builders.js";
import { InternalCompilerError } from "../../../errors.js";
import type { IrExpr, IrParam, IrStmt, IrType, SrcLoc } from "../../../ir/ir.js";
import {
  BOOL,
  canAdaptDynFuncTo,
  canBoxFuncIntoDyn,
  canDynCheckTo,
  DYN,
  F64,
  isUnitType,
  STRING,
  typeEquals,
  UNDEFINED_T,
} from "../../../ir/ir.js";
import { typeKey } from "../../type-mapper.js";
import { buildUnionNarrow } from "../union-narrow.js";
import { newFnCtx } from "../function-context.js";
import type { Lowerer } from "../lowerer.js";
import { omittedArgFor } from "../call-arguments.js";
import { maybePromiseUnionOf } from "../maybe-promise.js";

/** Wrap a zero-argument function whose array result needs an element
 * conversion. Each invocation creates a fresh converted array; the factory
 * creates a fresh closure capturing the original function. */
export function funcReturnWidthAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  if (fromT.params.length !== 0 || toT.params.length !== 0) return null;
  if (fromT.ret.kind !== "array" || toT.ret.kind !== "array") return null;
  const mapper = lowerer.arrayWidthHelper(fromT.ret, toT.ret, loc);
  if (!mapper) return null;
  const key = `fn:${typeKey(fromT.ret.elem)}:${typeKey(toT.ret.elem)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fn.width", key);
  lowerer.valueHelpers.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  // The returned closure's body: call the captured original, width-map.
  lowerer.liftedFns.push(
    ...buildFunctionAdapter(
      name,
      fromT,
      toT,
      [],
      [],
      [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: mapper,
            args: [
              {
                kind: "callValue",
                callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
                receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
                args: [],
                type: fromT.ret,
                loc,
              },
            ],
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    ),
  );
  return name;
}

/** Probe mechanical value conversions without creating helpers.
 * Trap-only conversions are excluded: they cannot justify an adapter that
 * promises to accept the destination signature. */
export function coercibleValue(lowerer: Lowerer, src: IrType, dst: IrType): boolean {
  if (typeEquals(src, dst)) return true;
  if (src.kind === "object" && dst.kind === "object")
    return lowerer.isSubclassOf(src.className, dst.className);

  if (dst.kind === "dyn") return src.kind !== "dyn" && lowerer.dynConvertible(src);
  if (src.kind === "dyn") {
    // The checked-dynamic function boundary's OUT direction joins the
    // mechanical set: a dyn result landing in an adaptable func slot
    // takes dynCheck's per-target shim (coerceToExpected's funcOk rule
    // — the production/development function-choice ternary shape).
    return (
      lowerer.jsonSafe(dst) ||
      (dst.kind === "func" &&
        canAdaptDynFuncTo(
          dst,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        ))
    );
  }
  if (dst.kind === "union") {
    if (src.kind === "union") return lowerer.unionRetagMappable(src.unionId, dst.unionId);
    if (src.kind === "void") return lowerer.armTag(dst.unionId, UNDEFINED_T) >= 0;
    if (src.kind === "promise") {
      // A maybe-promise union's promise arm accepts payload widening.
      const mp = maybePromiseUnionOf(lowerer, dst);
      if (mp) return lowerer.promisePayloadWidens(src, mp.promise);
    }
    return !isUnitType(src) && lowerer.armTag(dst.unionId, src) >= 0;
  }
  if (src.kind === "union") {
    return !isUnitType(dst) && dst.kind !== "void" && lowerer.armTag(src.unionId, dst) >= 0;
  }
  return false;
}

/** Whether an omitted parameter position completes with the native
 * undefined value: a checked-dynamic slot takes undefined as-is, and an
 * undefined-armed union (`x?: T`, `x: T = e`) is the completed ABI
 * spelling. */
export function omittableTrailingParam(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "dyn" || typeEquals(type, UNDEFINED_T)) return true;
  return type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0;
}

/** Whether all parameters and the result adapt without a trap-only path.
 * Rest signatures are excluded, except a typed-rest source in a slot with
 * fixed parameters (the rest packing adapter) and a checked-dynamic
 * variadic source (variadicBoundaryFits); extra destination
 * parameters are ignored. A source with MORE parameters than the slot is
 * clean when every extra trailing one is omittable — the adapter passes
 * that absent value explicitly (funcCoerceAdapter's omittedParams), the
 * same way a call through the slot would. A parameter the slot coercion
 * converts through a STRUCTURAL width counts (cleanParamPair), which
 * recurses through a nested function type: a callback parameter of the
 * value taking a narrower record where the slot's takes its `unknown` view
 * converts the argument the same way a top-level call does. The result side
 * likewise accepts what funcCoerceAdapter converts (cleanResult), including
 * a promise whose payload widens. */
export function cleanFuncAdaptable(
  lowerer: Lowerer,
  src: IrType & { kind: "func" },
  dst: IrType & { kind: "func" },
): boolean {
  if (restPackingAdapterFits(lowerer, src, dst)) return true;
  if (variadicBoundaryFits(lowerer, src, dst)) return true;
  if (src.rest === true || dst.rest === true) return false;
  // In checked mode (a method field's adapter, WidthLift funcAdaptChecked)
  // the width conversions below include checked retags.
  // Recursive function types (`type Handler = (h: Handler) => void`) reach
  // the same pair again one parameter down: assume it converts, the same
  // coinductive answer recordWidthPlan gives its own back-edges.
  const key = `funcClean:${typeKey(src)}:${typeKey(dst)}`;
  if (lowerer.coercions.planning.has(key)) return true;
  lowerer.coercions.planning.add(key);
  try {
    for (let i = dst.params.length; i < src.params.length; i++) {
      if (!omittableTrailingParam(lowerer, src.params[i]!)) return false;
    }
    for (let i = 0; i < src.params.length && i < dst.params.length; i++) {
      if (!cleanParamPair(lowerer, dst.params[i]!, src.params[i]!)) return false;
    }
    return cleanResult(lowerer, src.ret, dst.ret);
  } finally {
    lowerer.coercions.planning.delete(key);
  }
}

/** Whether the slot's coercion converts the value's RESULT without a
 * trap-only path: the dispositions funcCoerceAdapter's result side accepts
 * (a void slot drops the value; coercibleValue; a structural width, which
 * includes the promise payload widening and a nested function adaptation;
 * the void-into-unknown drop). */
function cleanResult(lowerer: Lowerer, actual: IrType, expected: IrType): boolean {
  if (expected.kind === "void") return true;
  if (lowerer.coercibleValue(actual, expected)) return true;
  if (actual.kind === "void" && expected.kind === "dyn") return true;
  return lowerer.widthLiftPlan(actual, expected) !== null;
}

/** Whether the slot's argument type `actual` converts into the function's
 * parameter type `expected` without a trap-only path: the pieces
 * funcCoerceAdapter's parameter loop converts (coercibleValue, the record
 * width conversion — which also selects a width-liftable arm of a union
 * destination, the required-narrower-argument shape — the partial
 * checked-dynamic extraction, and the union arm preservation). */
function cleanParamPair(lowerer: Lowerer, actual: IrType, expected: IrType): boolean {
  if (lowerer.coercibleValue(actual, expected)) return true;
  if (lowerer.widthLiftPlan(actual, expected) !== null) return true;
  if (actual.kind === "union" && expected.kind === "dyn")
    return (
      lowerer.unions.get(actual.unionId)?.arms.some((arm) => lowerer.dynConvertible(arm)) ?? false
    );
  if (actual.kind === "union" && expected.kind === "union") {
    const target = lowerer.unions.get(expected.unionId);
    return (
      target !== undefined && target.arms.every((arm) => lowerer.armTag(actual.unionId, arm) >= 0)
    );
  }
  return false;
}

/** Whether a function VALUE of `src` may inhabit a `dst` slot: the slot's
 * coercion (funcCoerceAdapter) forwards its arguments, converts them, and
 * converts the result — with no trap-only (stranded) path. This is
 * cleanFuncAdaptable extended to the source-with-MORE-parameters shape: a
 * value carrying extra trailing parameters whose completed ABI holds
 * undefined (a `(id, params, signal, onUpdate, ctx?: Ctx)` lambda in a
 * four-parameter slot). A call through the slot never passes them, so the
 * coercion forwards undefined — JavaScript's surplus-argument rule. */
export function funcSlotAdaptable(
  lowerer: Lowerer,
  src: IrType & { kind: "func" },
  dst: IrType & { kind: "func" },
  loc: SrcLoc,
): boolean {
  if (restPackingAdapterFits(lowerer, src, dst)) return true;
  if (variadicBoundaryFits(lowerer, src, dst)) return true;
  if (src.rest === true || dst.rest === true) return false;
  for (let i = dst.params.length; i < src.params.length; i++) {
    const param = src.params[i]!;
    if (omittedArgFor(lowerer, param, loc) === null && !typeEquals(param, UNDEFINED_T))
      return false;
  }
  for (let i = 0; i < src.params.length && i < dst.params.length; i++) {
    if (!cleanParamPair(lowerer, dst.params[i]!, src.params[i]!)) return false;
  }
  if (dst.ret.kind === "void") return true;
  if (lowerer.coercibleValue(src.ret, dst.ret)) return true;
  // The result conversions funcCoerceAdapter performs without stranding: a
  // Promise whose payload widens (`Promise<string>` into `Promise<string |
  // undefined>`) and a record the slot's result is a structural width of.
  if (
    src.ret.kind === "promise" &&
    dst.ret.kind === "promise" &&
    lowerer.promisePayloadWidens(src.ret, dst.ret)
  )
    return true;
  if (lowerer.widthLiftPlan(src.ret, dst.ret)) return true;
  return src.ret.kind === "void" && dst.ret.kind === "dyn";
}

/** THE RULE for calling a variadic function through a fixed parameter list.
 *
 * A function that takes its arguments through a rest parameter, or reads
 * `arguments`, observes every argument its caller passes: how many, and
 * each one. The adapter below (variadicBoundaryAdapter) calls it with the
 * parameters of the slot it is stored in. That is exact only where those
 * parameters are the whole list the caller passes under JavaScript
 * semantics:
 *
 * - A slot the program declares (a typed binding, parameter, result, field,
 *   member or element, or a value a declaration types) is called with its
 *   declared parameters and nothing else, so the adapter is exact there.
 * - A slot the compiler made is not such a slot. A library method's loop
 *   passes its callback the parameters the callback names, which is fewer
 *   than the arguments JavaScript passes it (`xs.map(f)` passes three; the
 *   helper's slot for a callback that names none is `() => T`). A variadic
 *   function adapted to that slot would receive none of them, silently.
 *
 * So the adapter is taken only while a slot-directed conversion is in
 * progress whose destination the checker types as that slot
 * (Lowerer.callListDeclared, set by coerceInto), or where the caller states
 * that its slot is a declared one (Lowerer.withDeclaredCallList). Every
 * other conversion, the ones lowering makes for its own helper slots
 * included, answers as it did before the adapter existed: the function
 * keeps its variadic type, and the site refuses it by name or hands it
 * every argument through the checked-dynamic call. This predicate is the
 * one place that decides; funcCoerceAdapter, cleanFuncAdaptable and
 * funcSlotAdaptable all ask it.
 *
 * Two checks over the finished IR complete the rule
 * (variadic-functions.ts): a variadic function that reaches a native call
 * of fixed arity unadapted is refused there by name, and a store is
 * refused when the program hands a function of the slot's type to a caller
 * that passes more than the type names.
 *
 * Two slots need neither condition, because the adapter is exact in them
 * for every caller a slot can have (exactVariadicSlot): a slot of the
 * function's own calling convention, where the caller's argument list
 * passes through, and a slot with fixed parameters for a function that
 * asks its argument list only whether an argument was passed at all (a
 * primitive constructor held as a value). Their adapters carry another
 * name prefix, so the store check does not count them.
 *
 * Why a checked-dynamic variadic function (`(...args) => R`, the hidden
 * argument-array ABI) cannot serve a declared slot of another signature, or
 * null when it can. Such a value has no native call form: every call of it,
 * a direct one included, boxes the function and applies it to a runtime
 * argument list. A slot of another signature therefore holds an adapter
 * that makes that same boxed call with the slot's arguments
 * (variadicBoundaryAdapter), under the checked function boundary's domain:
 * the function boxes, the slot's parameters convert to untyped values, and
 * its result is `void`, untyped, or checked from an untyped value.
 *
 * "count": the adapter passes one argument per fixed parameter of the slot,
 * and a variadic function observes how many it receives. A call through a
 * slot whose last fixed parameter is optional completes the omitted
 * argument with undefined, where the JavaScript call passes nothing. A
 * function type does not record which parameters are optional, so a last
 * fixed parameter that can hold the completed undefined (omittableTrailingParam)
 * blocks. "domain": a parameter or result type does not cross the
 * boundary. */
export function variadicBoundaryBlocker(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
): "count" | "domain" | null {
  const shape = (id: string) => lowerer.shapes.get(id);
  const union = (id: string) => lowerer.unions.get(id);
  if (!canBoxFuncIntoDyn(fromT, shape, union) || !canAdaptDynFuncTo(toT, shape, union))
    return "domain";
  // An all-arguments slot hands over every argument its caller passed, and
  // an exact slot does not depend on how many the caller passes.
  if (toT.argumentsAll === true || exactVariadicSlot(fromT, toT)) return null;
  const fixed = toT.restAbi === "typed" ? toT.params.slice(0, -1) : toT.params;
  const last = fixed.at(-1);
  return last !== undefined && omittableTrailingParam(lowerer, last) ? "count" : null;
}

/** Whether the slot `toT` is one in which the adapter of the
 * checked-dynamic variadic function type `fromT` is exact for every caller
 * the slot can have, whoever declared the slot and wherever its content is
 * handed on:
 *
 * - A slot of the function's own calling convention (`String` into the
 *   joined function of `typeof String | typeof Number`, whose result is
 *   wider): the caller's argument list passes through as it is. A function
 *   that gives the argumentsPresence guarantee is never made from one that
 *   does not.
 * - A slot with fixed parameters, for a function that asks its argument
 *   list only whether an argument was passed at all (argumentsPresence: the
 *   primitive constructors; `String` into `(value: string, name: string) =>
 *   unknown`). The slot supplies every parameter the function declares, so
 *   a call through the slot that passes its first argument, and a call by a
 *   caller that passes more than the slot lists (an array method's loop
 *   passes its callback the parameters the callback's type names, where
 *   JavaScript passes three), both show the function what the JavaScript
 *   call shows it. A call that omits the first argument passes nothing
 *   (`String()` is ""), and a function type does not record which
 *   parameters are optional: a first parameter that can hold the completed
 *   undefined (omittableTrailingParam) holds the same value for an omitted
 *   argument and for `undefined`. The adapter cannot tell which it was, so
 *   it throws a TypeError for that one value and serves every other
 *   (variadicBoundaryAdapter). A slot whose first parameter is only ever
 *   undefined is not exact, and neither is a slot with no parameter: a
 *   later caller that passes an argument would be answered as a call with
 *   none, so that slot is served under THE RULE's two conditions. */
export function exactVariadicSlot(
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
): boolean {
  if (toT.rest === true)
    return (
      toT.restAbi === undefined &&
      toT.argumentsAll === fromT.argumentsAll &&
      (toT.argumentsPresence !== true || fromT.argumentsPresence === true) &&
      toT.params.length === fromT.params.length
    );
  if (fromT.argumentsPresence !== true || toT.params.length < fromT.params.length) return false;
  const first = toT.params[0];
  return first !== undefined && !typeEquals(first, UNDEFINED_T);
}

/** Whether a checked-dynamic variadic function value converts into a slot
 * of another signature: the slot is exact for every caller
 * (exactVariadicSlot), or its parameters are the whole list its callers
 * pass (THE RULE above); and nothing blocks the adapter
 * (variadicBoundaryBlocker). */
export function variadicBoundaryFits(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
): boolean {
  if (fromT.rest !== true || fromT.restAbi !== undefined || typeEquals(fromT, toT)) return false;
  if (!exactVariadicSlot(fromT, toT) && !lowerer.callListDeclared()) return false;
  return variadicBoundaryBlocker(lowerer, fromT, toT) === null;
}

/** The name prefix of every variadic adapter whose store is exact only
 * under THE RULE, by which variadic-functions.ts finds the stores once
 * lowering ends. */
export const VARIADIC_ADAPTER_PREFIX = "%fn.variadic";

/** The name prefix of a variadic adapter in an exact slot
 * (exactVariadicSlot): no caller of such a store can see a difference, so
 * the store check does not look for it. */
export const EXACT_VARIADIC_ADAPTER_PREFIX = "%fn.exact";

/** What the adapter throws when an exact slot with fixed parameters, whose
 * first parameter can be omitted, is called with undefined there. */
export const OMITTED_OR_UNDEFINED_ARGUMENT_MESSAGE =
  "a constructor held as a function whose first parameter can be omitted was called without that argument or with undefined, and the function type cannot tell the two apart";

/** The adapter for variadicBoundaryFits: call the boxed function with the
 * slot's arguments as its argument list, under the receiver the slot was
 * called with. The factory takes the function already boxed (adaptedFunction
 * boxes it where the value is stored), which makes the closure a checked
 * adapter: made untyped again it is the original function, so untyped code
 * calls that with every argument it passes, and `===` and searches see the
 * one function. Each argument becomes an untyped value through the slot
 * conversion (coerceToExpected), which keeps an array's or a record's
 * identity, so a write the function makes reaches the caller's object as
 * it does in a direct call; the backend's own adapter from an untyped
 * function to a typed signature copies them instead. A rest slot's array
 * spreads into the list, so the function sees every argument the caller
 * passed. The result is dropped for a `void` slot and checked into any
 * other result type; a promise keeps its identity. In an exact slot with
 * fixed parameters whose first parameter can be omitted, a call that
 * leaves it undefined throws: it is an omitted argument or `undefined`,
 * which the function answers differently (exactVariadicSlot). */
function variadicBoundaryAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string {
  const exact = exactVariadicSlot(fromT, toT);
  const key = `${exact ? "fnexact" : "fnvariadic"}:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(
    lowerer,
    exact ? EXACT_VARIADIC_ADAPTER_PREFIX : VARIADIC_ADAPTER_PREFIX,
    key,
  );
  lowerer.coercions.retags.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = toT.params.map((type, i) => ({
    localId: `a.${i}`,
    name: `a${i}`,
    type,
  }));
  // A checked-dynamic variadic slot hides one trailing argument array; an
  // all-arguments slot keeps every argument there, the named ones included.
  const hiddenRest = toT.rest === true && toT.restAbi === undefined;
  if (hiddenRest) params.push({ localId: "rest.0", name: "args", type: DYN });
  const passed = hiddenRest && toT.argumentsAll === true ? params.slice(-1) : params;
  const context = newFnCtx(false, null, null, toT.ret);
  let body: IrStmt[];
  lowerer.fnStack.push(context);
  try {
    const args = passed.map((param) => {
      const converted = lowerer.coerceToExpected(
        { kind: "varRef", localId: param.localId, type: param.type, loc },
        DYN,
      );
      if (converted.type.kind !== "dyn")
        throw new InternalCompilerError(
          "lowerer bug: probed variadic adapter argument stopped boxing",
        );
      return converted;
    });
    const call: IrExpr = {
      kind: "dynCall",
      callee: { kind: "varRef", localId: "f.0", type: DYN, loc },
      receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
      calleeName: "value",
      args,
      ...(toT.rest === true ? { spreads: [{ arg: args.length - 1, what: "arguments" }] } : {}),
      type: DYN,
      loc,
    };
    if (toT.ret.kind === "void") {
      body = [
        { kind: "exprStmt", expr: call, loc },
        { kind: "return", value: null, loc },
      ];
    } else {
      const result = lowerer.coerceToExpected(call, toT.ret);
      if (!typeEquals(result.type, toT.ret))
        throw new InternalCompilerError(
          "lowerer bug: probed variadic adapter result stopped checking",
        );
      body = [{ kind: "return", value: result, loc }];
    }
    const first = toT.params[0];
    if (
      exact &&
      toT.rest !== true &&
      first !== undefined &&
      omittableTrailingParam(lowerer, first)
    ) {
      const value: IrExpr = { kind: "varRef", localId: "a.0", type: first, loc };
      const undefinedThere: IrExpr =
        first.kind === "union"
          ? {
              kind: "unionIsTag",
              unionId: first.unionId,
              tag: lowerer.armTag(first.unionId, UNDEFINED_T),
              negated: false,
              value,
              type: BOOL,
              loc,
            }
          : { kind: "dynTest", test: "undefined", value, type: BOOL, loc };
      body.unshift({
        kind: "if",
        cond: undefinedThere,
        then: [
          {
            kind: "exprStmt",
            expr: nodeThrowExpr(1, "", OMITTED_OR_UNDEFINED_ARGUMENT_MESSAGE, F64, loc),
            loc,
          },
        ],
        else_: null,
        loc,
      });
    }
  } finally {
    lowerer.fnStack.pop();
  }
  lowerer.liftedFns.push(
    ...buildFunctionAdapter(name, { kind: "dyn" }, toT, params, context.locals, body, loc),
  );
  return name;
}

/** The function `value` adapted to the slot type `type` by the adapter
 * funcCoerceAdapter answered: the adapter's factory applied to the value,
 * boxed first for the variadic adapter, which calls the boxed function. */
export function adaptedFunction(adapter: string, value: IrExpr, type: IrType, loc: SrcLoc): IrExpr {
  const original: IrExpr =
    adapter.startsWith(`${VARIADIC_ADAPTER_PREFIX}.`) ||
    adapter.startsWith(`${EXACT_VARIADIC_ADAPTER_PREFIX}.`)
      ? { kind: "dynFrom", value, type: DYN, loc }
      : value;
  return { kind: "call", callee: adapter, args: [original], type, loc };
}

/** Whether a typed-rest function (`(...m: T[]) => R`) can serve a slot
 * with fixed parameters (`(m: T) => void`): the slot's parameters convert
 * to the function's fixed parameters, then to the rest element type. */
export function restPackingAdapterFits(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
): boolean {
  if (fromT.rest !== true || fromT.restAbi !== "typed" || toT.rest === true) return false;
  const fixed = fromT.params.length - 1;
  const restT = fromT.params[fixed];
  if (restT?.kind !== "array" || toT.params.length < fixed) return false;
  for (let i = 0; i < toT.params.length; i++) {
    if (!lowerer.coercibleValue(toT.params[i]!, i < fixed ? fromT.params[i]! : restT.elem))
      return false;
  }
  return toT.ret.kind === "void" || lowerer.coercibleValue(fromT.ret, toT.ret);
}

/** The adapter for restPackingAdapterFits: forwards the fixed arguments and
 * packs the remaining ones into the rest array, as a JavaScript call of the
 * function with those arguments does. */
function restPackingAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string {
  const key = `fnrestadapt:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fn.adapt", key);
  lowerer.coercions.retags.set(key, name);
  lowerer.coercions.signatureAdapters.set(name, "");
  lowerer.freshClosureAdapters.add(name);
  const fixed = fromT.params.length - 1;
  const restT = fromT.params[fixed] as IrType & { kind: "array" };
  const params: IrParam[] = toT.params.map((t, i) => ({
    localId: `a.${i}`,
    name: `a${i}`,
    type: t,
  }));
  const arg = (i: number, want: IrType): IrExpr =>
    lowerer.coerceToExpected(
      { kind: "varRef", localId: `a.${i}`, type: toT.params[i]!, loc },
      want,
    );
  const args: IrExpr[] = [];
  for (let i = 0; i < fixed; i++) args.push(arg(i, fromT.params[i]!));
  const packed: IrExpr[] = [];
  for (let i = fixed; i < toT.params.length; i++) packed.push(arg(i, restT.elem));
  args.push({ kind: "arrayLit", elems: packed, type: restT, loc });
  const call: IrExpr = {
    kind: "callValue",
    callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
    receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
    args,
    type: fromT.ret,
    loc,
  };
  const body: IrStmt[] =
    toT.ret.kind === "void"
      ? [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ]
      : [{ kind: "return", value: lowerer.coerceToExpected(call, toT.ret), loc }];
  lowerer.liftedFns.push(...buildFunctionAdapter(name, fromT, toT, params, [], body, loc));
  return name;
}

/** Adapt a fixed-parameter function to a checked-dynamic rest signature
 * without fixed parameters (`() => {}` into mock.fn()'s `(...args: any[])
 * => undefined`): the adapter receives the hidden argument array and
 * passes its element i as parameter i, undefined when the caller passed
 * fewer arguments, as JS does. Null unless every parameter is
 * checked-dynamic, which holds a missing argument as undefined, and the
 * result is discarded or converts. */
function funcIntoDynRestAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  if (fromT.rest === true || fromT.params.some((p) => p.kind !== "dyn")) return null;
  if (toT.ret.kind !== "void" && !lowerer.coercibleValue(fromT.ret, toT.ret)) return null;
  const key = `fnadapt:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fn.adapt", key);
  lowerer.coercions.retags.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = [{ localId: "rest.0", name: "args", type: DYN }];
  const call: IrExpr = {
    kind: "callValue",
    callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
    receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
    args: fromT.params.map((_, i): IrExpr => ({
      kind: "dynKeyGet",
      value: { kind: "varRef", localId: "rest.0", type: DYN, loc },
      key: { kind: "strLit", value: String(i), type: STRING, loc },
      type: DYN,
      loc,
    })),
    type: fromT.ret,
    loc,
  };
  let body: IrStmt[];
  if (toT.ret.kind === "void") {
    body = [
      { kind: "exprStmt", expr: call, loc },
      { kind: "return", value: null, loc },
    ];
  } else {
    const result = lowerer.coerceToExpected(call, toT.ret);
    if (!typeEquals(result.type, toT.ret))
      throw new InternalCompilerError("lowerer bug: probed fn-adapter return stopped coercing");
    body = [{ kind: "return", value: result, loc }];
  }
  lowerer.liftedFns.push(...buildFunctionAdapter(name, fromT, toT, params, [], body, loc));
  return name;
}

/** The sort comparator's result adapter: JavaScript reads a comparator's
 * result with ToNumber, so a comparator whose result may be `undefined`
 * still orders — the unit arm completes as NaN, which makes every `< 0`
 * and `> 0` comparison false and leaves the pair in place, exactly as Node
 * does. TS infers that union for a JavaScript function that falls off its
 * end (`if (a < b) return -1; if (a > b) return 1`), the shape semver's
 * `rcompare` has. The adapter calls the source and narrows the result to
 * its number arm with the NaN default; null unless the result is exactly
 * the number arm plus `undefined`. */
export function sortComparatorResultAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  if (fromT.rest === true || fromT.ret.kind !== "union") return null;
  const from = lowerer.unions.get(fromT.ret.unionId);
  if (from === undefined) return null;
  // Any other arm is not a number the sort could compare, and keeps its
  // existing (refused) treatment.
  if (
    !from.arms.some((arm) => typeEquals(arm, F64)) ||
    !from.arms.every((arm) => typeEquals(arm, F64) || arm.kind === "undefinedT")
  )
    return null;
  const key = `sortnum:${typeKey(fromT)}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fn.sortnum", key);
  const narrowName = keyedHelperName(lowerer, "%sort.num", key);
  const narrow = buildUnionNarrow(narrowName, from, F64, loc, (type) => lowerer.fmt(type), {
    kind: "numLit",
    value: NaN,
    type: F64,
    loc,
  });
  if (narrow === null) return null;
  lowerer.liftedFns.push(narrow);
  lowerer.coercions.retags.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = fromT.params.map((type, i) => ({
    localId: `a.${i}`,
    name: `a${i}`,
    type,
  }));
  const call: IrExpr = {
    kind: "callValue",
    callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
    receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
    args: params.map((p): IrExpr => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
    type: fromT.ret,
    loc,
  };
  const body: IrStmt[] = [
    {
      kind: "return",
      value: { kind: "call", callee: narrowName, args: [call], type: F64, loc },
      loc,
    },
  ];
  const toT: IrType & { kind: "func" } = { kind: "func", params: fromT.params, ret: F64 };
  lowerer.liftedFns.push(...buildFunctionAdapter(name, fromT, toT, params, [], body, loc));
  return name;
}

/** Adapt a function value to a destination signature, forwarding and
 * converting its arguments and result. Unsupported parameter/result pairs
 * produce checked traps when called. Rest signatures are refused, except a
 * typed-rest source in a slot with fixed parameters, which the rest
 * packing adapter serves, a checked-dynamic variadic source, which is
 * called boxed with the slot's arguments (variadicBoundaryAdapter), and a
 * fixed-parameter function into a checked-dynamic rest signature without
 * fixed parameters (funcIntoDynRestAdapter). */
export function funcCoerceAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  if (restPackingAdapterFits(lowerer, fromT, toT))
    return restPackingAdapter(lowerer, fromT, toT, loc);
  if (variadicBoundaryFits(lowerer, fromT, toT))
    return variadicBoundaryAdapter(lowerer, fromT, toT, loc);
  if (toT.rest === true && toT.restAbi === undefined && toT.params.length === 0)
    return funcIntoDynRestAdapter(lowerer, fromT, toT, loc);
  if (fromT.rest === true || toT.rest === true) return null;
  // A source with MORE parameters than the slot: the checker admits it only
  // when every extra trailing parameter is optional, so a call through the
  // slot hands them undefined (JavaScript ignores surplus arguments). Pass
  // that absent value explicitly. A pair whose extra parameter cannot hold
  // undefined stays refused.
  const omittedParams = new Map<number, IrExpr>();
  for (let i = toT.params.length; i < fromT.params.length; i++) {
    const param = fromT.params[i]!;
    const absent =
      omittedArgFor(lowerer, param, loc) ??
      (typeEquals(param, UNDEFINED_T)
        ? ({ kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc } as IrExpr)
        : null);
    if (!absent) return null;
    omittedParams.set(i, absent);
  }
  // Piece dispositions beyond coercibleValue, all CHECKER-APPROVED
  // function compatibilities (bivariant method params under the suite's
  // non-strict settings, `() => never` throwers displayed as void by
  // the type mapping, void functions into unknown/any-returning slots):
  // - strandParams: some parameter cannot convert — the assignment
  //   compiles, INVOKING the slot throws the stranded TypeError (a
  //   never-called mismatched callback is exact; divergence 38's stance
  //   extended to calls).

  // - voidRet "dyn": return native undefined after the call's effects.
  // - voidRet "strand": a void result where the slot promises a typed
  //   value — the call runs (a `never` thrower never comes back, so the
  //   trap is unreachable there), then the stranded TypeError.
  let strandParams = false;
  const narrowedParams = new Map<number, ReadonlySet<number>>();
  const partialDynParams = new Map<number, IrType>();
  for (let i = 0; i < toT.params.length && i < fromT.params.length; i++) {
    const actual = toT.params[i]!;
    const expected = fromT.params[i]!;
    if (lowerer.coercibleValue(actual, expected)) continue;
    // A record argument the parameter's shape is a structural width of
    // (members missing from the argument are optional there): the
    // record width conversion.
    if (lowerer.widthLiftPlan(actual, expected)) continue;
    if (actual.kind === "union" && expected.kind === "dyn") {
      const arms =
        lowerer.unions.get(actual.unionId)?.arms.filter((arm) => lowerer.dynConvertible(arm)) ?? [];
      if (arms.length > 0) {
        partialDynParams.set(
          i,
          arms.length === 1 ? arms[0]! : { kind: "union", unionId: lowerer.unions.intern(arms) },
        );
        continue;
      }
    }
    // A stored native builtin can have a narrower supported overload
    // than its public declaration. Preserve every supported union arm
    // and reject only an invocation carrying an unsupported arm. This
    // is the union counterpart of the checked single-arm extraction.
    if (actual.kind === "union" && expected.kind === "union") {
      const source = lowerer.unions.get(actual.unionId);
      const target = lowerer.unions.get(expected.unionId);
      if (
        source &&
        target &&
        target.arms.every((arm) => lowerer.armTag(actual.unionId, arm) >= 0)
      ) {
        narrowedParams.set(
          i,
          new Set(
            source.arms.flatMap((arm, tag) =>
              lowerer.armTag(expected.unionId, arm) < 0 ? [tag] : [],
            ),
          ),
        );
        continue;
      }
    }
    if (cleanParamPair(lowerer, actual, expected)) continue;
    strandParams = true;
  }
  let voidRet: "dyn" | "strand" | null = null;
  let strandRet = false;
  if (toT.ret.kind !== "void" && !lowerer.coercibleValue(fromT.ret, toT.ret)) {
    if (fromT.ret.kind !== "void") {
      // A RESULT that cannot convert — the strandParams stance, result
      // side (the production/development function-choice ternary: the
      // untaken arm's result shape never lands in the slot's): the
      // assignment compiles, INVOKING the slot runs the function and
      // throws the stranded TypeError where its result would convert.
      strandRet = true;
    } else {
      voidRet = toT.ret.kind === "dyn" ? "dyn" : "strand";
    }
  }
  // An untyped result (a generic wrapper's `any` handed back `as F`) takes
  // the checked-dynamic extraction to the slot's result: a record checks
  // its shape, a Promise keeps its identity and checks its payload when it
  // settles.
  const checkedRet =
    strandRet &&
    fromT.ret.kind === "dyn" &&
    canDynCheckTo(
      toT.ret,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    );
  if (checkedRet) strandRet = false;
  // A Promise result whose payload widens into the slot's (a record with
  // extra, optional or nested members, `Promise<Narrow>` into
  // `Promise<Wide>`): the result keeps its identity and converts its
  // payload when it settles (coerceToExpected's boxed-settlement rule).
  if (
    strandRet &&
    fromT.ret.kind === "promise" &&
    toT.ret.kind === "promise" &&
    lowerer.promisePayloadWidens(fromT.ret, toT.ret)
  )
    strandRet = false;
  // A record result the slot's result is a structural width of.
  if (strandRet && lowerer.widthLiftPlan(fromT.ret, toT.ret)) strandRet = false;
  const checked = lowerer.coercions.checkedRetags > 0;
  const key = `fnadapt:${typeKey(fromT)}:${typeKey(toT)}${checked ? ":checked" : ""}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fn.adapt", key);
  lowerer.coercions.retags.set(key, name);
  lowerer.coercions.signatureAdapters.set(name, checked ? "checked" : "");
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = toT.params.map((t, i) => ({
    localId: `a.${i}`,
    name: `a${i}`,
    type: t,
  }));
  const strandThrow = (why: string): IrStmt => ({
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [{ kind: "strLit", value: why, type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  });
  // The body lowers in the adapter's own function context: conversions
  // that need scratch locals (a union of record results lifted into one
  // record slot) declare them in the adapter, not in the function that
  // asked for it.
  const context = newFnCtx(false, null, null, toT.ret);
  let body: IrStmt[];
  lowerer.fnStack.push(context);
  try {
    if (strandParams) {
      body = [
        strandThrow(
          `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the parameter types cannot convert — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
        ),
      ];
    } else {
      const args = fromT.params.map((pt, i) => {
        const omitted = omittedParams.get(i);
        if (omitted) return omitted;
        const aRef: IrExpr = { kind: "varRef", localId: `a.${i}`, type: toT.params[i]!, loc };
        const partial = partialDynParams.get(i);
        if (partial && aRef.type.kind === "union") {
          const source = lowerer.unions.get(aRef.type.unionId)!;
          const supported =
            partial.kind === "union" ? lowerer.unions.get(partial.unionId)!.arms : [partial];
          const rejected = new Set(
            source.arms.flatMap((arm, tag) =>
              supported.some((accepted) => typeEquals(accepted, arm)) ? [] : [tag],
            ),
          );
          const narrow =
            partial.kind === "union"
              ? lowerer.unionRetagHelper(aRef.type.unionId, partial.unionId, loc, rejected)
              : lowerer.narrowedArmHelper(aRef.type.unionId, partial, loc);
          if (!narrow)
            throw new InternalCompilerError(
              "lowerer bug: partial callable parameter stopped narrowing",
            );
          return lowerer.coerceToExpected(
            { kind: "call", callee: narrow, args: [aRef], type: partial, loc },
            pt,
          );
        }
        const narrowed = narrowedParams.get(i);
        const helper =
          narrowed && aRef.type.kind === "union" && pt.kind === "union"
            ? lowerer.unionRetagHelper(aRef.type.unionId, pt.unionId, loc, narrowed)
            : null;
        const converted: IrExpr = helper
          ? { kind: "call", callee: helper, args: [aRef], type: pt, loc }
          : lowerer.coerceToExpected(aRef, pt);
        if (!typeEquals(converted.type, pt))
          throw new InternalCompilerError("lowerer bug: probed fn-adapter param stopped coercing");
        return converted;
      });
      const call: IrExpr = {
        kind: "callValue",
        callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
        receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
        args,
        type: fromT.ret,
        loc,
      };
      if (toT.ret.kind === "void") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ];
      } else if (voidRet === "dyn") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: dynUndefinedExpr(loc), loc },
        ];
      } else if (voidRet === "strand") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          strandThrow(
            `a void result where the '${lowerer.fmt(toT)}' slot promises '${lowerer.fmt(toT.ret)}' (a thrower typed 'never' never reaches this; a genuinely void function has no result to hand over)`,
          ),
        ];
      } else if (strandRet) {
        body = [
          { kind: "exprStmt", expr: call, loc },
          strandThrow(
            `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the result cannot convert to '${lowerer.fmt(toT.ret)}' — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
          ),
        ];
      } else if (checkedRet) {
        body = [
          { kind: "return", value: { kind: "dynCheck", value: call, type: toT.ret, loc }, loc },
        ];
      } else {
        const result = lowerer.coerceToExpected(call, toT.ret);
        if (!typeEquals(result.type, toT.ret))
          throw new InternalCompilerError("lowerer bug: probed fn-adapter return stopped coercing");
        body = [{ kind: "return", value: result, loc }];
      }
    }
  } finally {
    lowerer.fnStack.pop();
  }
  lowerer.liftedFns.push(
    ...buildFunctionAdapter(name, fromT, toT, params, context.locals, body, loc),
  );
  return name;
}

/** The adapter for a pair the general adapter has no conversion for
 * (funcCoerceAdapter answers null): a view of the slot's type that throws
 * the stranded TypeError when it is invoked. function-views.ts builds it
 * where a function reaches a slot through a narrower one and the wider
 * slot's arguments cannot be the function's (a rest parameter of another
 * element type): JavaScript would hand the function a value its types
 * exclude, and no native value represents that. */
export function strandedFuncAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string {
  const key = `fnstrand:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fn.adapt", key);
  lowerer.coercions.retags.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = toT.params.map((t, i) => ({
    localId: `a.${i}`,
    name: `a${i}`,
    type: t,
  }));
  const body: IrStmt[] = [
    {
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [
          {
            kind: "strLit",
            value: `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the parameter types cannot convert — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
            type: STRING,
            loc,
          },
        ],
        type: { kind: "object", className: "%TypeError" },
        loc,
      },
      loc,
    },
  ];
  lowerer.liftedFns.push(...buildFunctionAdapter(name, fromT, toT, params, [], body, loc));
  return name;
}

/** The spawnSync-runner VALUE adapter's plan — a function returning the
 * opaque spawnRes flowing into a slot whose signature returns the
 * STRUCTURAL result record tsc accepted (`defaultRunner` into a
 * `CommandRunner` param: `{ status: number | null; stdout?: string;
 * stderr?: string; error?: Error }`). Parameters must agree pairwise;
 * each target field must be one of the spawnRes reads (status, stdout,
 * stderr, error) at its exact lowered type — string fields optionally
 * undefined-armed. Null when the pair isn't this shape. Pure: callers
 * probe before interning. */
export function spawnResFnAdapterPlan(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
): { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] | null {
  if (!Array.isArray(fromT.params) || !Array.isArray(toT.params)) return null; // defensive: degenerate func types
  if (fromT.params.length !== toT.params.length) return null;
  if (!fromT.params.every((p, i) => typeEquals(p, toT.params[i]!))) return null;
  if (fromT.ret.kind !== "spawnRes" || toT.ret.kind !== "record") return null;
  const shape = lowerer.shapes.get(toT.ret.shapeId);
  if (!shape || shape.tuple || shape.indexValue) return null;
  const statusT: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([F64, { kind: "nullT" }]),
  };
  const errorT: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([{ kind: "object", className: "%Error" }, UNDEFINED_T]),
  };
  const strOptT: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, UNDEFINED_T]) };
  const plan: { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] = [];
  for (const f of shape.fields) {
    if (f.name === "status" && typeEquals(f.type, statusT)) {
      plan.push({
        field: f.name,
        build: (r, loc) => ({
          kind: "libCall",
          fn: "spawnRes.status",
          args: [r],
          type: statusT,
          loc,
        }),
      });
      continue;
    }
    if (
      (f.name === "stdout" || f.name === "stderr") &&
      (typeEquals(f.type, strOptT) || f.type.kind === "string")
    ) {
      const fn = f.name === "stdout" ? ("spawnRes.stdout" as const) : ("spawnRes.stderr" as const);
      const strTag = lowerer.armTag(strOptT.kind === "union" ? strOptT.unionId : "", STRING);
      plan.push({
        field: f.name,
        build: (r, loc) => {
          const read: IrExpr = { kind: "libCall", fn, args: [r], type: STRING, loc };
          return f.type.kind === "string"
            ? read
            : {
                kind: "unionWrap",
                unionId: (f.type as IrType & { kind: "union" }).unionId,
                tag: strTag,
                value: read,
                type: f.type,
                loc,
              };
        },
      });
      continue;
    }
    if (f.name === "error" && typeEquals(f.type, errorT)) {
      plan.push({
        field: f.name,
        build: (r, loc) => ({
          kind: "libCall",
          fn: "spawnRes.error",
          args: [r],
          type: errorT,
          loc,
        }),
      });
      continue;
    }
    return null;
  }
  return plan;
}

/** Interned `%fnval.spawnres.<n>(f)` — the runner-value adapter: a
 * fresh closure of the TARGET signature forwarding its arguments to the
 * captured function and converting the opaque spawnRes result into the
 * target's structural record (one eager read per declared field —
 * spawnResFnAdapterPlan's set). Divergence caveat: stdout/stderr read
 * as the captured text ("" when nothing was captured, e.g. stdio
 * "inherit") where Node stores null. */
export function spawnResFnAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  const plan = lowerer.spawnResFnAdapterPlan(fromT, toT);
  if (!plan) return null;
  if (toT.ret.kind !== "record") return null;
  const key = `fnspawn:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%fnval.spawnres", key);
  lowerer.valueHelpers.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = toT.params.map((p, i) => ({
    localId: `p${i}.0`,
    name: `p${i}`,
    type: p,
  }));
  const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: fromT.ret, loc };
  lowerer.liftedFns.push(
    ...buildFunctionAdapter(
      name,
      fromT,
      toT,
      params,
      [{ id: "r.0", name: "r", type: fromT.ret, mutable: false }],
      [
        {
          kind: "varDecl",
          localId: "r.0",
          init: {
            kind: "callValue",
            callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
            receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
            args: params.map((p): IrExpr => ({
              kind: "varRef",
              localId: p.localId,
              type: p.type,
              loc,
            })),
            type: fromT.ret,
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: plan.map((entry) => ({ name: entry.field, value: entry.build(rRef, loc) })),
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    ),
  );
  return name;
}
