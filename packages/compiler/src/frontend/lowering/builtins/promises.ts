import { keyedHelperName } from "../stable-names.js";
import { checkedPromiseAll, thenReader } from "../checked-promise-all.js";
import { mayResolveThroughThen } from "../promise-resolution.js";
import { promiseResolveThenable, thenableParts } from "../thenables.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { countedFor, varRef } from "../../../ir/build.js";
import { arrayValueStore, optionalElementValue, primitiveElement } from "../array-values.js";
import {
  type MaybePromiseUnion,
  maybePromiseResolve,
  maybePromiseUnionOf,
  nonPromiseArmsAs,
  promiseArmedUnionOf,
  promiseOrUnitUnionOf,
} from "../maybe-promise.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { withoutParentheses } from "../../outer-expressions.js";
import { isConstAssertionTypeNode } from "../../type-mapper.js";
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

/** A payload whose only values are `undefined` and `void` (no `null`). */
function undefinedOnly(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind === "void" || t.kind === "undefinedT") return true;
  if (t.kind !== "union") return false;
  const def = lowerer.unions.get(t.unionId);
  return def !== undefined && def.arms.every((a) => a.kind === "void" || a.kind === "undefinedT");
}

/** A promise-or-unit union entry whose only data arm is `undefined` and
 * whose promise arm carries no value — the `?.` shape `Promise<void> |
 * undefined` (`server.connection?.close()`, `this.opening?.catch(...)`).
 * Node's Promise.all treats the undefined side as an already-fulfilled
 * undefined, so the entry joins a combinator as a promise settled with
 * nothing. Any other union keeps the general path: a `null` arm would
 * fulfill `null`, and a value-carrying arm cannot be read back from a
 * promise widened to `Promise<void>`. */
function armedVoidPromiseOf(
  lowerer: Lowerer,
  t: IrType,
): { unionId: string; tag: number; promise: IrType & { kind: "promise" } } | null {
  if (t.kind !== "union") return null;
  const armed = promiseOrUnitUnionOf(lowerer, t);
  if (!armed) return null;
  if (!undefinedOnly(lowerer, armed.promise.inner)) return null;
  if (armed.def.arms.some((a, i) => i !== armed.promiseTag && a.kind !== "undefinedT")) return null;
  return { unionId: armed.def.id, tag: armed.promiseTag, promise: armed.promise };
}

/** `value` (an `armedVoidPromiseOf` union) as a promise of nothing: the
 * promise arm widened to `Promise<void>`, the undefined arm an
 * already-fulfilled undefined. Reads `value` twice, so the caller stages
 * it in a local first. */
function armedVoidPromiseEntry(
  value: IrExpr,
  armed: { unionId: string; tag: number; promise: IrType & { kind: "promise" } },
  voidPromise: IrType & { kind: "promise" },
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "ternary",
    cond: {
      kind: "unionIsTag",
      unionId: armed.unionId,
      tag: armed.tag,
      negated: false,
      value,
      type: BOOL,
      loc,
    },
    then: {
      kind: "promiseVoidWiden",
      value: {
        kind: "unionNarrow",
        unionId: armed.unionId,
        tag: armed.tag,
        value,
        type: armed.promise,
        loc,
      },
      type: voidPromise,
      loc,
    },
    else_: { kind: "intrinsic", name: "promise.resolve", args: [], type: voidPromise, loc },
    type: voidPromise,
    loc,
  };
}

/** One entry of the tuple form of Promise.all and Promise.allSettled: the
 * lowered value, and the checker's type of the expression it came from
 * (which says whether resolving a promise with it can do anything but
 * fulfil). */
interface TupleEntry {
  value: IrExpr;
  tsType: ts.Type;
}

/** How a promise-armed union entry (`Promise<X> | undefined`, `T |
 * Promise<T>`, `cond ? fetch() : []`) joins the tuple form. Node resolves
 * each entry: the promise arm is adopted, every other arm fulfils as
 * itself. `same` means the promise arm already settles with the position's
 * type F, so the entry is one `Promise<F>` (the other arms in a fresh
 * fulfilled promise). Otherwise the promise arm keeps its own promise, and
 * two already-fulfilled promises after the real entries carry what the
 * builder needs to pick the value: whether the promise arm was taken, and
 * (unless the other arms are a single unit) the other arm's value as F.
 * An already-fulfilled entry joins the combinator's batch of settled
 * entries and adds no turn. */
interface ArmedEntryPlan {
  mp: MaybePromiseUnion;
  same: boolean;
  /** The one unit arm beside the promise arm, when that is all there is. */
  loneUnit: (IrType & { kind: "undefinedT" | "nullT" }) | null;
}

function armedEntryPlan(
  lowerer: Lowerer,
  entry: TupleEntry,
  position: IrType,
): ArmedEntryPlan | null {
  const mp = promiseArmedUnionOf(lowerer, entry.value.type);
  if (!mp) return null;
  // Every arm beside the promise must fulfil as itself.
  const parts = entry.tsType.isUnionType() ? ts.constituentTypes(entry.tsType) : [entry.tsType];
  for (const part of parts) {
    if (lowerer.mapTypeOf(part)?.kind === "promise") continue;
    if (mayResolveThroughThen(lowerer, part)) return null;
  }
  const others = mp.def.arms.filter((_, tag) => tag !== mp.promiseTag);
  const lone = others.length === 1 ? others[0]! : null;
  return {
    mp,
    same: mp.promise.inner.kind !== "void" && typeEquals(mp.promise.inner, position),
    loneUnit: lone !== null && (lone.kind === "undefinedT" || lone.kind === "nullT") ? lone : null,
  };
}

/** The tuple form's plan: the result type, its tuple shape, and for each
 * entry how it joins. Entries are promises, checked-dynamic values (a
 * JavaScript function's result), promise-armed unions, and values whose
 * static type proves they fulfil as themselves (numbers, strings, records
 * without a callable `then`, arrays, ...). Null when the result type or an
 * entry has no typed home here. */
interface TuplePlan {
  /** The type each position fulfils with. */
  positions: readonly IrType[];
  armed: (ArmedEntryPlan | null)[];
  /** Entries that join as checked-dynamic values: a union whose position
   * is `unknown` or `{}` and whose arms may hold a promise or a `then` the
   * static type does not show (`cond ? {} : fetch()`). The value converts
   * once every entry has evaluated and resolves like any checked-dynamic
   * entry. */
  viaDyn: boolean[];
}

function tuplePlan(
  lowerer: Lowerer,
  positions: readonly IrType[],
  entries: readonly TupleEntry[],
): TuplePlan | null {
  if (positions.length !== entries.length) return null;
  const armed: (ArmedEntryPlan | null)[] = [];
  const viaDyn: boolean[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const t = entry.value.type;
    armed.push(null);
    viaDyn.push(false);
    if (t.kind === "promise" || t.kind === "dyn" || armedVoidPromiseOf(lowerer, t) !== null)
      continue;
    if (t.kind === "f64" || t.kind === "string" || t.kind === "bool" || isUnitType(t)) continue;
    if (t.kind === "void") return null;
    const plan = armedEntryPlan(lowerer, entry, positions[i]!);
    if (plan) {
      armed[i] = plan;
      continue;
    }
    // Any other value joins as a fresh fulfilled promise, which is what
    // resolving with it does when it cannot hold a promise or a `then`.
    if (!mayResolveThroughThen(lowerer, entry.tsType)) continue;
    if (positions[i]!.kind !== "dyn" || t.kind !== "union" || !lowerer.dynConvertible(t))
      return null;
    viaDyn[i] = true;
  }
  return { positions, armed, viaDyn };
}

/** The entries of the tuple form as promises of nothing, in input order,
 * followed by the already-fulfilled promises the armed entries need (see
 * ArmedEntryPlan), and the statements that evaluate the entries first when
 * one of them is read more than once or runs code when it is resolved.
 * Null when an armed entry's other arms do not convert to its position. */
function tupleEntryPromises(
  lowerer: Lowerer,
  plan: TuplePlan,
  elems: readonly IrExpr[],
  loc: SrcLoc,
): { entries: IrExpr[]; staged: IrStmt[] } | null {
  const voidPromise: IrType & { kind: "promise" } = { kind: "promise", inner: VOID };
  const dynPromise: IrType = { kind: "promise", inner: DYN };
  const widen = (promise: IrExpr): IrExpr =>
    promise.type.kind === "promise" && promise.type.inner.kind === "void"
      ? promise
      : { kind: "promiseVoidWiden", value: promise, type: voidPromise, loc };
  const fulfilledWith = (value: IrExpr | null): IrExpr =>
    value === null
      ? { kind: "intrinsic", name: "promise.resolve", args: [], type: voidPromise, loc }
      : {
          kind: "intrinsic",
          name: "promise.resolve",
          args: [value],
          type: { kind: "promise", inner: value.type },
          loc,
        };
  // A checked-dynamic entry's PromiseResolve can run a `then` getter, which
  // Node runs after the whole array literal evaluated; a union entry is
  // read by its tag and then again for the arm. With either, every entry
  // evaluates into a hidden local first.
  const staged: IrStmt[] = [];
  const stages = elems.some(
    (e, i) =>
      e.type.kind === "dyn" ||
      plan.armed[i] !== null ||
      plan.viaDyn[i] === true ||
      armedVoidPromiseOf(lowerer, e.type) !== null,
  );
  const values = !stages
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
  const extras: IrExpr[] = [];
  const entries: IrExpr[] = [];
  for (let i = 0; i < values.length; i++) {
    const e = values[i]!;
    const voidArmed = armedVoidPromiseOf(lowerer, e.type);
    if (voidArmed) {
      entries.push(armedVoidPromiseEntry(e, voidArmed, voidPromise, loc));
      continue;
    }
    const armed = plan.armed[i];
    if (armed) {
      const { mp } = armed;
      const position = plan.positions[i]!;
      const taken: IrExpr = {
        kind: "unionIsTag",
        unionId: mp.def.id,
        tag: mp.promiseTag,
        negated: false,
        value: e,
        type: BOOL,
        loc,
      };
      const promiseArm: IrExpr = {
        kind: "unionNarrow",
        unionId: mp.def.id,
        tag: mp.promiseTag,
        value: e,
        type: mp.promise,
        loc,
      };
      const rest =
        armed.loneUnit && !armed.same ? null : nonPromiseArmsAs(lowerer, mp, e, position, loc);
      if (armed.same) {
        if (rest === null) return null;
        entries.push(
          widen({
            kind: "ternary",
            cond: taken,
            then: promiseArm,
            else_: fulfilledWith(rest),
            type: mp.promise,
            loc,
          }),
        );
        continue;
      }
      entries.push({
        kind: "ternary",
        cond: taken,
        then: widen(promiseArm),
        else_: fulfilledWith(null),
        type: voidPromise,
        loc,
      });
      extras.push(widen(fulfilledWith(taken)));
      if (!armed.loneUnit) {
        if (rest === null) return null;
        extras.push({
          kind: "ternary",
          cond: taken,
          then: fulfilledWith(null),
          else_: widen(fulfilledWith(rest)),
          type: voidPromise,
          loc,
        });
      }
      continue;
    }
    let promise: IrExpr;
    if (e.type.kind === "promise") promise = e;
    else if (e.type.kind === "dyn" || plan.viaDyn[i]) {
      const value = lowerer.coerceToExpected(e, DYN);
      if (value.type.kind !== "dyn") return null;
      promise = {
        kind: "libCall",
        fn: "dyn.promiseResolve",
        args: [value, thenReader(lowerer, loc)],
        type: dynPromise,
        loc,
      };
    } else if (isUnitType(e.type)) {
      // A unit entry's value is its type's one value; the promise only
      // takes its place in the combinator.
      const resolved = fulfilledWith(null);
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
    } else promise = fulfilledWith(e);
    entries.push(widen(promise));
  }
  return { entries: [...entries, ...extras], staged };
}

/** The value each position of the tuple form fulfils with, read from the
 * joined entries (`entriesRef`, the array tupleEntryPromises built) at the
 * position's type. Null when a value does not convert to its position. */
function tupleFulfilledValues(
  lowerer: Lowerer,
  plan: TuplePlan,
  elemTypes: readonly IrType[],
  entriesRef: IrExpr,
  loc: SrcLoc,
): IrExpr[] | null {
  const voidPromise: IrType = { kind: "promise", inner: VOID };
  const unit = (t: IrType): IrExpr => ({
    kind: "unitLit",
    unit: t.kind === "nullT" ? "null" : "undefined",
    type: t.kind === "nullT" ? t : UNDEFINED_T,
    loc,
  });
  // The payload of the fulfilled promise in `slot`, at type `inner`.
  const read = (slot: number, inner: IrType): IrExpr =>
    undefinedOnly(lowerer, inner) || isUnitType(inner)
      ? unit(inner)
      : {
          kind: "libCall",
          fn: "promise.fulfilledValue",
          args: [
            {
              kind: "arrayGet",
              arr: entriesRef,
              index: { kind: "numLit", value: slot, type: F64, loc },
              type: voidPromise,
              loc,
            },
          ],
          type: inner,
          loc,
        };
  let extra = elemTypes.length;
  const out: IrExpr[] = [];
  for (let i = 0; i < elemTypes.length; i++) {
    const type = elemTypes[i]!;
    const position = plan.positions[i]!;
    const armed = plan.armed[i];
    let value: IrExpr;
    if (armed?.same) {
      value = read(i, position);
    } else if (armed) {
      const taken = read(extra++, BOOL);
      const other = armed.loneUnit ? unit(armed.loneUnit) : read(extra++, position);
      const whenTaken = lowerer.coerceToExpected(read(i, armed.mp.promise.inner), position);
      const whenNot = lowerer.coerceToExpected(other, position);
      if (!typeEquals(whenTaken.type, position) || !typeEquals(whenNot.type, position)) return null;
      value = {
        kind: "ternary",
        cond: taken,
        then: whenTaken,
        else_: whenNot,
        type: position,
        loc,
      };
    } else if (plan.viaDyn[i]) {
      value = read(i, DYN);
    } else {
      // An armed promise-or-undefined entry of nothing fulfills nothing
      // either way, so its position holds undefined; any other entry reads
      // its payload.
      const voidArmed = armedVoidPromiseOf(lowerer, type);
      const inner = voidArmed !== null ? UNDEFINED_T : type.kind === "promise" ? type.inner : type;
      value = read(i, inner);
    }
    const coerced = lowerer.coerceToExpected(value, position);
    if (armed && !typeEquals(coerced.type, position)) return null;
    out.push(coerced);
  }
  return out;
}

/** The result type of the tuple form where the checker's `Promise<[A, B,
 * C]>` has no mapping as a whole because a position's type has none of its
 * own, while its entry lowered to a checked-dynamic value or to a promise
 * of one: a value whose static type has no mapping is held that way (a
 * function that returns an object of a package nothing has named yet).
 * Promise.all fulfils each position with what its entry settles to, so
 * such a position is checked-dynamic; every position whose type maps keeps
 * the checker's. Refusing the call instead would keep the code the entry
 * reaches from lowering, and with it the `import()` that names the package.
 * Null when the result is not a fixed tuple of the entries, or when a
 * position without a mapping settles with a typed value (the namespace of
 * a builtin module's `import()`, a union, a promise of nothing). */
function settledTupleType(
  lowerer: Lowerer,
  call: ts.CallExpression,
  entries: readonly TupleEntry[],
): IrType | null {
  const { checker } = lowerer;
  const promise = lowerer.typeOf(call);
  if (ts.symbolNameOf(promise.getSymbol()) !== "Promise") return null;
  const result = checker.getTypeArguments(promise as ts.TypeReference)[0];
  if (result === undefined || !checker.isTupleType(result)) return null;
  const positions = checker.getTypeArguments(result as ts.TypeReference);
  if (positions.length !== entries.length) return null;
  const fields: { name: string; type: IrType }[] = [];
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]!;
    let type = (position.flags & ts.TypeFlags.Any) !== 0 ? DYN : lowerer.mapTypeOf(position);
    if (type === null) {
      const entry = entries[i]!.value.type;
      const settled = entry.kind === "promise" ? entry.inner : entry;
      if (settled.kind !== "dyn") return null;
      type = DYN;
    }
    if (type.kind === "void") return null;
    fields.push({ name: String(i), type });
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    kind: "promise",
    inner: { kind: "record", shapeId: lowerer.shapes.intern(fields, true) },
  };
}

/** `Promise.all([p, q, r])` over different entry types: the checker's
 * tuple overload, `Promise<[A, B, C]>`. Each entry becomes a promise in
 * input order (tupleEntryPromises), widened to Promise<void>, a type-only
 * view. The runtime combinator over them gives Node's settlement: the
 * first rejection in settlement order wins and every later one counts as
 * handled. The result settles inside the combinator's own settlement, so
 * it and its awaits land on Node's microtask turns; a fulfillment runs one
 * interned function per entry/result signature that reads the fulfilled
 * entries into the tuple. Entries keep their identity: no value converts
 * through the checked-dynamic tree. */
function lowerTuplePromiseAll(
  lowerer: Lowerer,
  call: ts.CallExpression,
  tupleEntries: readonly TupleEntry[],
  before: readonly IrStmt[] = [],
): IrExpr | null {
  const resultT =
    lowerer.mapTypeOf(lowerer.typeOf(call)) ?? settledTupleType(lowerer, call, tupleEntries);
  if (resultT?.kind !== "promise" || resultT.inner.kind !== "record") return null;
  const tuple = resultT.inner;
  const tupleShape = lowerer.shapes.get(tuple.shapeId);
  if (!tupleShape?.tuple || tupleShape.fields.length !== tupleEntries.length) return null;
  const positions: IrType[] = [];
  for (const field of tupleShape.fields) positions[Number(field.name)] = field.type;
  const plan = tuplePlan(lowerer, positions, tupleEntries);
  if (!plan) return null;
  const elems = tupleEntries.map((entry) => entry.value);
  const loc = locOf(call);
  const entriesT = arrayOf({ kind: "promise", inner: VOID });
  const key = `promise.allTuple:${elems.map((e) => typeKey(e.type)).join(",")}->${typeKey(tuple)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    const values = tupleFulfilledValues(
      lowerer,
      plan,
      elems.map((e) => e.type),
      varRef("entries.0", entriesT, loc),
      loc,
    );
    if (values === null) return null;
    name = keyedHelperName(lowerer, "%promise.allTuple", key);
    lowerer.arrHofHelpers.set(key, name);
    // Shape fields are sorted by name ("10" before "2"); a tuple field's
    // name is its position.
    const fields = tupleShape.fields.map((field) => ({
      name: field.name,
      value: values[Number(field.name)]!,
    }));
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "entries.0", name: "entries", type: entriesT }],
      returnType: tuple,
      locals: [{ id: "entries.0", name: "entries", type: entriesT, mutable: false }],
      body: [{ kind: "return", value: { kind: "recordLit", fields, type: tuple, loc }, loc }],
      loc,
    });
  }
  const joined = tupleEntryPromises(lowerer, plan, elems, loc);
  if (joined === null) return null;
  const all: IrExpr = {
    kind: "libCall",
    fn: "promise.allTuple",
    args: [
      { kind: "arrayLit", elems: joined.entries, type: entriesT, loc },
      { kind: "closure", fnName: name, captures: [], type: funcOf([entriesT], tuple), loc },
    ],
    type: resultT,
    loc,
  };
  const stmts = [...before, ...joined.staged];
  return stmts.length === 0 ? all : { kind: "seqExpr", stmts, result: all, type: resultT, loc };
}

/** The entries of a tuple-typed value handed to Promise.all or
 * Promise.allSettled (`const pair = [a(), b()] as const;
 * Promise.all(pair)`): the value evaluates once into a hidden local
 * (`before`), and each position reads from it at the checker's element
 * type. Null when the value is not a fixed-length tuple. */
function tupleValueEntries(
  lowerer: Lowerer,
  argNode: ts.Expression,
  value: IrExpr,
): { entries: TupleEntry[]; before: IrStmt[] } | null {
  if (value.type.kind !== "record") return null;
  const shape = lowerer.shapes.get(value.type.shapeId);
  const tsType = lowerer.typeOf(argNode);
  if (!shape?.tuple || !lowerer.checker.isTupleType(tsType)) return null;
  const elementTypes = lowerer.checker.getTypeArguments(tsType as ts.TypeReference);
  if (elementTypes.length !== shape.fields.length) return null;
  const loc = locOf(argNode);
  const local = lowerer.declareHiddenLocal("%allTuple", value.type);
  const entries: TupleEntry[] = [];
  for (let i = 0; i < elementTypes.length; i++) {
    const field = shape.fields.find((f) => f.name === String(i));
    if (!field) return null;
    entries.push({
      value: {
        kind: "recordGet",
        obj: varRef(local.id, value.type, loc),
        shapeId: value.type.shapeId,
        field: field.name,
        type: field.type,
        loc,
      },
      tsType: elementTypes[i]!,
    });
  }
  return { entries, before: [{ kind: "varDecl", localId: local.id, init: value, loc }] };
}

/** Whether nothing reads the array a `Promise.all` call fulfills with: the
 * call is a statement of its own, the operand of `void`, awaited as a
 * statement, or the receiver of a `then` whose callback takes no value;
 * `catch` and `finally` pass the array on, so they count when their own
 * result is not read either. Promise<void> entries then keep the
 * combinator that fulfills with nothing. */
export function promiseAllValueUnread(node: ts.Expression): boolean {
  let user: ts.Node = node;
  while (ts.isParenthesizedExpression(user.parent)) user = user.parent;
  const parent = user.parent;
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
  if (ts.isAwaitExpression(parent)) {
    let awaited: ts.Node = parent;
    while (ts.isParenthesizedExpression(awaited.parent)) awaited = awaited.parent;
    return ts.isExpressionStatement(awaited.parent) || ts.isVoidExpression(awaited.parent);
  }
  if (
    !ts.isPropertyAccessExpression(parent) ||
    parent.expression !== user ||
    parent.questionDotToken ||
    !ts.isCallExpression(parent.parent) ||
    parent.parent.expression !== parent
  )
    return false;
  const reaction = parent.parent;
  const member = parent.name.text;
  if (member === "catch" || member === "finally") return promiseAllValueUnread(reaction);
  if (member !== "then") return false;
  const onFulfilled = reaction.arguments.nodes[0];
  if (onFulfilled === undefined) return promiseAllValueUnread(reaction);
  return (
    (ts.isArrowFunction(onFulfilled) || ts.isFunctionExpression(onFulfilled)) &&
    onFulfilled.parameters.nodes.length === 0
  );
}

/** `Promise.all(ps)` over Promise<void> entries whose array is read: the
 * checker's `Promise<void[]>`, an array with one undefined value per entry,
 * as in Node. The combinator joins the entries (promise.allTuple) and its
 * builder makes the array inside the combinator's settlement, so the result
 * settles on Node's turn. Null when the array type has no undefined
 * element to hold. */
function voidPromiseAllValues(
  lowerer: Lowerer,
  entries: IrExpr,
  resultT: IrType | null,
  loc: SrcLoc,
): IrExpr | null {
  const entriesT = entries.type;
  if (
    entriesT.kind !== "array" ||
    entriesT.elem.kind !== "promise" ||
    entriesT.elem.inner.kind !== "void" ||
    resultT?.kind !== "promise" ||
    resultT.inner.kind !== "array"
  )
    return null;
  const outT = resultT.inner;
  const elem = outT.elem;
  if (
    elem.kind !== "undefinedT" &&
    !(elem.kind === "union" && lowerer.armTag(elem.unionId, UNDEFINED_T) >= 0)
  )
    return null;
  const key = `promise.allVoid:${typeKey(outT)}`;
  let builder = lowerer.arrHofHelpers.get(key);
  if (!builder) {
    builder = keyedHelperName(lowerer, "%promise.allVoidValues", key);
    lowerer.arrHofHelpers.set(key, builder);
    const joined = varRef("joined.0", entriesT, loc);
    const out = varRef("out.0", outT, loc);
    const undefinedValue = lowerer.coerceToExpected(
      { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      elem,
    );
    lowerer.liftedFns.push({
      name: builder,
      params: [{ localId: "joined.0", name: "joined", type: entriesT }],
      returnType: outT,
      locals: [
        { id: "joined.0", name: "joined", type: entriesT, mutable: false },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: outT, loc },
          loc,
        },
        countedFor(
          loc,
          { kind: "arrIntrinsic", method: "length", receiver: joined, args: [], type: F64, loc },
          (index) => [arrayValueStore(lowerer, out, index, undefinedValue, elem, loc)],
        ),
        { kind: "return", value: out, loc },
      ],
      loc,
    });
  }
  return {
    kind: "libCall",
    fn: "promise.allTuple",
    args: [
      entries,
      { kind: "closure", fnName: builder, captures: [], type: funcOf([entriesT], outT), loc },
    ],
    type: resultT,
    loc,
  };
}

/** The argument of Promise.all or Promise.allSettled without parentheses
 * and without a const assertion: `[a(), b()] as const` lists the same
 * entries as the literal (the assertion only makes the tuple readonly).
 * Any other assertion names a type and stays. */
function entriesArgument(arg: ts.Expression): ts.Expression {
  const inner = withoutParentheses(arg);
  return ts.isAsExpression(inner) && isConstAssertionTypeNode(inner.type)
    ? withoutParentheses(inner.expression)
    : inner;
}

/** `Promise.allSettled([p, q])` over different entry types, and over a
 * tuple-typed value: the checker's tuple of settled results, one
 * `{ status, value } | { status, reason }` union per position. The
 * entries join as in Promise.all's tuple form (tupleEntryPromises), over
 * the combinator that waits for every entry; when it fulfills, one
 * interned function per entry/result signature asks each entry whether it
 * rejected and builds its record: the fulfilled value at the position's
 * type, or the reason as a checked-dynamic value. The result settles
 * inside the combinator's settlement, on Node's turn. Null for a literal
 * of one promise type (the array form owns it) and when the result or an
 * entry has no typed home here. */
function lowerTupleAllSettled(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
): IrExpr | null {
  const loc = locOf(call);
  let tupleEntries: TupleEntry[];
  let before: IrStmt[] = [];
  if (ts.isArrayLiteralExpression(argNode)) {
    if (argNode.elements.nodes.length === 0 || argNode.elements.nodes.some(ts.isSpreadElement))
      return null;
    // The checker's type first: a literal of one promise type keeps the
    // array form, whose entries are lowered there.
    const mapped = argNode.elements.nodes.map((el) => lowerer.mapTypeOf(lowerer.typeOf(el)));
    const first = mapped[0];
    if (first?.kind === "promise" && mapped.every((t) => t !== null && typeEquals(t, first)))
      return null;
    tupleEntries = argNode.elements.nodes.map((el) => ({
      value: lowerer.lowerExpr(el),
      tsType: lowerer.typeOf(el),
    }));
  } else {
    if (!lowerer.checker.isTupleType(lowerer.typeOf(argNode))) return null;
    const fromTuple = tupleValueEntries(lowerer, argNode, lowerer.lowerExpr(argNode));
    if (!fromTuple) return null;
    tupleEntries = fromTuple.entries;
    before = fromTuple.before;
  }
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (resultT?.kind !== "promise" || resultT.inner.kind !== "record") return null;
  const tuple = resultT.inner;
  const shape = lowerer.shapes.get(tuple.shapeId);
  if (!shape?.tuple || shape.fields.length !== tupleEntries.length) return null;
  // Each position's settled union: its record arm with `value`, its record
  // arm with `reason`.
  const fieldsOf = (arm: IrType) =>
    arm.kind === "record" ? (lowerer.shapes.get(arm.shapeId)?.fields ?? []) : [];
  const settledArms: { union: IrType; fulfilled: IrType; rejected: IrType; valueT: IrType }[] = [];
  for (const field of shape.fields) {
    const arms =
      field.type.kind === "union" ? (lowerer.unions.get(field.type.unionId)?.arms ?? []) : [];
    const fulfilled = arms.find((arm) => fieldsOf(arm).some((f) => f.name === "value"));
    const rejected = arms.find((arm) => fieldsOf(arm).some((f) => f.name === "reason"));
    if (arms.length !== 2 || fulfilled === undefined || rejected === undefined) return null;
    if (fieldsOf(rejected).find((f) => f.name === "reason")!.type.kind !== "dyn") return null;
    settledArms[Number(field.name)] = {
      union: field.type,
      fulfilled,
      rejected,
      valueT: fieldsOf(fulfilled).find((f) => f.name === "value")!.type,
    };
  }
  const elems = tupleEntries.map((entry) => entry.value);
  const plan = tuplePlan(
    lowerer,
    settledArms.map((arm) => arm.valueT),
    tupleEntries,
  );
  if (!plan) return null;
  const voidPromise: IrType = { kind: "promise", inner: VOID };
  const entriesT = arrayOf(voidPromise);
  const key = `promise.allSettledTuple:${elems.map((e) => typeKey(e.type)).join(",")}->${typeKey(tuple)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    const entriesRef = varRef("entries.0", entriesT, loc);
    const values = tupleFulfilledValues(
      lowerer,
      plan,
      elems.map((e) => e.type),
      entriesRef,
      loc,
    );
    if (values === null) return null;
    const records: IrExpr[] = [];
    for (let i = 0; i < elems.length; i++) {
      const arm = settledArms[i]!;
      const entry: IrExpr = {
        kind: "arrayGet",
        arr: entriesRef,
        index: { kind: "numLit", value: i, type: F64, loc },
        type: voidPromise,
        loc,
      };
      const record = (armT: IrType, status: string, payload: string, value: IrExpr): IrExpr => {
        const lit: IrExpr = {
          kind: "recordLit",
          fields: fieldsOf(armT).map((f) => ({
            name: f.name,
            value:
              f.name === payload
                ? value
                : lowerer.coerceToExpected(
                    { kind: "strLit", value: status, type: { kind: "string" }, loc },
                    f.type,
                  ),
          })),
          type: armT,
          loc,
        };
        return lowerer.coerceToExpected(lit, arm.union);
      };
      const whenRejected = record(arm.rejected, "rejected", "reason", {
        kind: "libCall",
        fn: "promise.entryReason",
        args: [entry],
        type: DYN,
        loc,
      });
      const whenFulfilled = record(arm.fulfilled, "fulfilled", "value", values[i]!);
      if (
        !typeEquals(values[i]!.type, arm.valueT) ||
        !typeEquals(whenRejected.type, arm.union) ||
        !typeEquals(whenFulfilled.type, arm.union) ||
        fieldsOf(arm.fulfilled).length !== 2 ||
        fieldsOf(arm.rejected).length !== 2
      )
        return null;
      records.push({
        kind: "ternary",
        cond: { kind: "libCall", fn: "promise.entryRejected", args: [entry], type: BOOL, loc },
        then: whenRejected,
        else_: whenFulfilled,
        type: arm.union,
        loc,
      });
    }
    name = keyedHelperName(lowerer, "%promise.allSettledTuple", key);
    lowerer.arrHofHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "entries.0", name: "entries", type: entriesT }],
      returnType: tuple,
      locals: [{ id: "entries.0", name: "entries", type: entriesT, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "recordLit",
            // Shape fields are sorted by name; a tuple field's name is its
            // position.
            fields: shape.fields.map((f) => ({ name: f.name, value: records[Number(f.name)]! })),
            type: tuple,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  const joined = tupleEntryPromises(lowerer, plan, elems, loc);
  if (joined === null) return null;
  const all: IrExpr = {
    kind: "libCall",
    fn: "promise.allSettledTuple",
    args: [
      { kind: "arrayLit", elems: joined.entries, type: entriesT, loc },
      { kind: "closure", fnName: name, captures: [], type: funcOf([entriesT], tuple), loc },
    ],
    type: resultT,
    loc,
  };
  const stmts = [...before, ...joined.staged];
  return stmts.length === 0 ? all : { kind: "seqExpr", stmts, result: all, type: resultT, loc };
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
      const made = lowered?.[i] ?? lowerer.lowerExpr(el);
      // An entry whose static type has a thenable part joins as the promise
      // PromiseResolve makes of it.
      const entry = promiseResolveThenable(lowerer, el, made, locOf(el)) ?? made;
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
  // fulfill with an array of undefined values, as in Node; where nothing
  // reads the array (`await Promise.all(voids);`) the result is a
  // `Promise<void>` that fulfills with nothing.
  // Heterogeneous ARRAY LITERALS land on the tuple overload
  // (Promise<[A, B]>) and fence here — one promise type is the bound.
  if (member === "all") {
    const onlyArg = call.arguments.nodes.length === 1 ? call.arguments.nodes[0]! : null;
    if (!onlyArg) {
      lowerer.noLowering(
        "Promise.all with this argument shape",
        call,
        "one array of promises is the supported form: Promise.all(ps) with ps: Promise<T>[]",
      );
    }
    const argNode = entriesArgument(onlyArg);
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
        // Promise<void> entries whose values are read: the checker's
        // `void[]` (an annotated binding), or its tuple of undefined values,
        // which the tuple form below makes.
        const readVoid =
          first.inner.kind === "void" &&
          !isJsSourceFile(ts.getSourceFileOfNode(call)) &&
          !promiseAllValueUnread(call);
        if (!readVoid) {
          const resultT: IrType = {
            kind: "promise",
            inner: first.inner.kind === "void" ? VOID : arrayOf(first.inner),
          };
          return { kind: "intrinsic", name: "promise.all", args: [entriesArr], type: resultT, loc };
        }
        // An annotation names the array (`const p: Promise<void[]> = ...`)
        // where the checker's own type for the literal is the tuple.
        const contextual = lowerer.checker.getContextualType(call);
        const values =
          (contextual
            ? voidPromiseAllValues(lowerer, entriesArr, lowerer.mapTypeOf(contextual), loc)
            : null) ??
          voidPromiseAllValues(lowerer, entriesArr, lowerer.mapTypeOf(lowerer.typeOf(call)), loc);
        if (values) return values;
      }

      if (!isJsSourceFile(ts.getSourceFileOfNode(call))) {
        const tuple = lowerTuplePromiseAll(
          lowerer,
          call,
          elems.map((value, i) => ({
            value,
            tsType: lowerer.typeOf(argNode.elements.nodes[i]!),
          })),
        );
        if (tuple) return tuple;
      }
      // A literal whose entries are `Promise<void>` and `Promise<void> |
      // undefined` — the optional-call shape `Promise.all([a.close(),
      // b?.close()])`, where the checker's tuple spelling mixes the armed
      // union with the plain promise. The armed-array path below lowers
      // the same mix; pack the literal into that one element type first.
      const armedLiteral = armedVoidPromiseAllLiteral(lowerer, elems, loc);
      if (armedLiteral) return armedLiteral;
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
        "an entry is a promise, a value whose type shows no `then` (it fulfils as itself), or `cond ? promise : value` — a thenable, a value that may hold a `then` its type does not show, and a spread have no lowering",
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
    // `Promise.all(xs)` over `(Promise<void> | undefined)[]` — the `?.`
    // shape, whose undefined entries a Node Promise.all treats as
    // already-fulfilled undefined values.
    const armedAll = armedVoidPromiseAll(lowerer, entries, loc);
    if (armedAll) return armedAll;
    // A tuple-typed value (`const pair = [a(), b()] as const`): the
    // same entries as the literal, read from the value.
    if (!isJsSourceFile(ts.getSourceFileOfNode(call))) {
      const fromTuple = tupleValueEntries(lowerer, argNode, entries);
      const tuple = fromTuple
        ? lowerTuplePromiseAll(lowerer, call, fromTuple.entries, fromTuple.before)
        : null;
      if (tuple) return tuple;
    }

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
    // Promise<void> entries fulfill with one undefined value each. Where
    // nothing reads that array the combinator fulfills with nothing;
    // everywhere else the result is the checker's Promise<void[]>.
    if (inner.kind === "void" && !promiseAllValueUnread(call)) {
      const values = voidPromiseAllValues(
        lowerer,
        entries,
        lowerer.mapTypeOf(lowerer.typeOf(call)),
        loc,
      );
      if (values) return values;
    }
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
    // Promise<unknown>[] combines into the checker's `unknown[]`, which is
    // one checked-dynamic value: the typed combinator collects the values,
    // and the result's payload widens to it (the promise and its
    // settlement turn stay the combinator's). Promise<any>[] combines into
    // `any[]`, which has no typed layout: the same value.
    if (
      inner.kind === "dyn" &&
      !isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      (resultT === null || (resultT.kind === "promise" && resultT.inner.kind === "dyn"))
    ) {
      const collected: IrType & { kind: "promise" } = { kind: "promise", inner: arrayOf(DYN) };
      const dynResult: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
      if (lowerer.promisePayloadWidens(collected, dynResult)) {
        const widened = lowerer.coerceToExpected(
          { kind: "intrinsic", name: "promise.all", args: [entries], type: collected, loc },
          dynResult,
        );
        if (typeEquals(widened.type, dynResult)) return widened;
      }
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
    if (member === "allSettled") {
      const settled = lowerTupleAllSettled(lowerer, call, entriesArgument(argNode));
      if (settled) return settled;
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
      // A value whose static type has a thenable part (a slot declared
      // PromiseLike<T>, an object of the program with a `then` method):
      // PromiseResolve asks the value. A promise is answered as it is, a
      // thenable is adopted through its `then`.
      {
        const wanted = lowerer.mapTypeOf(lowerer.typeOf(call));
        if (wanted?.kind === "promise" && thenableParts(lowerer, argT, argNode).length > 0) {
          const adopted = promiseResolveThenable(
            lowerer,
            argNode,
            lowerer.lowerExpr(argNode),
            loc,
            wanted,
          );
          if (adopted !== null) return adopted;
        }
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
    // A checked-dynamic argument may itself hold a promise (a TypeScript
    // async callback's result: `Promise.resolve(fn())`): Promise.resolve
    // answers THAT promise — the same object, adopted — and wraps every
    // other value. A TypeScript argument whose static type proves it plain
    // (a string passed where `unknown` is expected) needs no test.
    if (
      value.type.kind === "dyn" &&
      resultT.inner.kind === "dyn" &&
      (isJsSourceFile(ts.getSourceFileOfNode(call)) ||
        mayResolveThroughThen(lowerer, lowerer.typeOf(argNode)))
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
    const elems = argNode.elements.nodes.map((el) => {
      const made = lowerer.lowerExpr(el);
      return promiseResolveThenable(lowerer, el, made, locOf(el)) ?? made;
    });
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

/** The array-LITERAL spelling of `armedVoidPromiseAll`: a literal whose
 * entries are the armed `Promise<void> | undefined` union and/or the plain
 * `Promise<void>` value it contains (`Promise.all([close(), opening?.catch(…)])`)
 * packs into ONE array of the armed union, where the plain promises ride
 * their own arm. Null when any entry is another promise type, so the
 * existing fences keep their message. */
function armedVoidPromiseAllLiteral(lowerer: Lowerer, elems: IrExpr[], loc: SrcLoc): IrExpr | null {
  let armed: ReturnType<typeof armedVoidPromiseOf> = null;
  for (const entry of elems) {
    if (entry.type.kind === "promise" && entry.type.inner.kind === "void") continue;
    const candidate = armedVoidPromiseOf(lowerer, entry.type);
    if (!candidate || candidate.promise.inner.kind !== "void") return null;
    armed ??= candidate;
    if (candidate.unionId !== armed.unionId) return null;
  }
  // No armed entry: the identical-promise path owns that literal.
  if (!armed) return null;
  const unionT: IrType = { kind: "union", unionId: armed.unionId };
  const packed = elems.map((entry) =>
    entry.type.kind === "union" ? entry : lowerer.coerceToExpected(entry, unionT),
  );
  return armedVoidPromiseAll(
    lowerer,
    { kind: "arrayLit", elems: packed, type: arrayOf(unionT), loc },
    loc,
  );
}

/** `Promise.all(ps)` over `(Promise<void> | undefined)[]` — the `?.`
 * shape (`removed.map((s) => s.connection?.close())`), whose undefined
 * entries Node's Promise.all fulfills with undefined rather than skipping
 * or rejecting. Every entry joins the combinator as a promise of nothing:
 * its promise arm widened to `Promise<void>`, its undefined arm an
 * already-fulfilled undefined. The result carries none of them, so it
 * types as `Promise<void>` like an all-void array. */
function armedVoidPromiseAll(lowerer: Lowerer, entries: IrExpr, loc: SrcLoc): IrExpr | null {
  const entriesT = entries.type;
  if (entriesT.kind !== "array") return null;
  const armed = armedVoidPromiseOf(lowerer, entriesT.elem);
  if (!armed) return null;
  const voidPromise: IrType & { kind: "promise" } = { kind: "promise", inner: VOID };
  const joinedT = arrayOf(voidPromise);
  const key = `promise.allArmed:${typeKey(entriesT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%promise.allArmed", key);
    lowerer.arrHofHelpers.set(key, helper);
    const length = (arr: IrExpr): IrExpr => ({
      kind: "arrIntrinsic",
      method: "length",
      receiver: arr,
      args: [],
      type: F64,
      loc,
    });
    const ps = varRef("ps.0", entriesT, loc);
    const joined = varRef("joined.0", joinedT, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "ps.0", name: "ps", type: entriesT }],
      returnType: joinedT,
      locals: [
        { id: "ps.0", name: "ps", type: entriesT, mutable: false },
        { id: "joined.0", name: "joined", type: joinedT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "e.0", name: "e", type: entriesT.elem, mutable: false },
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
            kind: "varDecl",
            localId: "e.0",
            init: { kind: "arrayGet", arr: ps, index, type: entriesT.elem, loc },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: joined,
              args: [
                armedVoidPromiseEntry(varRef("e.0", entriesT.elem, loc), armed, voidPromise, loc),
              ],
              type: F64,
              loc,
            },
            loc,
          },
        ]),
        { kind: "return", value: joined, loc },
      ],
      loc,
    });
  }
  return {
    kind: "intrinsic",
    name: "promise.all",
    args: [{ kind: "call", callee: helper, args: [entries], type: joinedT, loc }],
    type: { kind: "promise", inner: VOID },
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
