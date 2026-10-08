import { nodeThrowExpr, boolLit, countedFor, numLit, strLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrSetIntrinsicMethod,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  funcOf,
  isPrimitiveCollectionKey,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import {
  COLLECTION_ITERATOR_METHODS,
  MAP_METHODS,
  SET_COMBINE_METHODS,
  SET_METHODS,
} from "../surfaces.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { lowerDynDispatchMethodCall } from "../lower-calls.js";
import { typeKey } from "../../type-mapper.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";
import {
  collectionInput,
  collectionDestinationMatches,
  ingestCollection,
  lowerCollectionInput,
} from "../collection-ingestion.js";
import { strCharsCall } from "./array-construction.js";
import { arrayElementRead } from "./array-iteration.js";

/** Ambient Map method calls. `get`/`set`/`has`/`delete`/`clear` lower to
 * mapIntrinsic; `forEach` desugars to a direct call of a synthetic loop
 * function over the iteration primitives (lowerMapForEachCall). Null when
 * this isn't an ambient Map method call. tsc has already checked arity
 * and argument types against ambient/scriptc.d.ts. */
export function lowerMapMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  if (!MAP_METHODS.has(name)) return null;
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  let probedUntyped = false;
  if (receiverIr?.kind !== "map" && isJsSourceFile(access.getSourceFile())) {
    const probed = tryLowerExpression(lowerer, access.expression);
    if (probed?.type.kind === "map") {
      receiverIr = probed.type;
      probedUntyped = true;
    }
  }
  if (receiverIr?.kind !== "map") return null;
  // Collection views can refine has() while retaining its native ABI.
  if (!probedUntyped && !lowerer.isStdlibMember(access) && name !== "has") return null;
  const loc = locOf(call);
  const value = lowerer.lowerExpr(access.expression);
  const receiver =
    lowerer.runtimeOptionalPropertyReceiver(access.expression, value, receiverIr, name) ?? value;
  if (receiver.type.kind !== "map") {
    lowerer.noLowering(
      "chained Map method calls",
      access.expression,
      "the lowered set() produces no value — call each set(k, v) as its own statement",
    );
  }
  // The lib declares a thisArg parameter on forEach; unlowered — fenced.
  if (name === "forEach" && call.arguments.length !== 1) {
    lowerer.noLowering(
      `.forEach with ${call.arguments.length} arguments`,
      call,
      "the thisArg parameter has no lowering — use an arrow function",
    );
  }

  if (name === "get") {
    const k = lowerer.lowerCollectionKey(call.arguments[0]!, receiverIr.key);
    // The checker types the call `V | undefined`, which interns the
    // result union. `undefined` sorts LAST among all possible arm
    // typeKeys, so when V is itself a union its arms keep their tags in
    // the result union — the backend leans on that (docs/ir.md).
    // instanceof on a readonly view can erase the checker's value type
    // to any. Recover that case from native storage; otherwise preserve
    // the contextual return mapping for recursive and generic values.
    const erased = (lowerer.typeOf(call).flags & ts.TypeFlags.Any) !== 0;
    const type =
      receiverIr.value.kind === "dyn"
        ? DYN
        : erased
          ? (lowerer.withUndefinedArmOf(receiverIr.value) ??
            lowerer.withUndefinedArm(receiverIr.value))
          : lowerer.irTypeOf(call);
    if (type.kind !== "union" && type.kind !== "dyn") lowerer.badType(call, lowerer.typeOf(call));
    return { kind: "mapIntrinsic", method: "get", receiver, args: [k], type, loc };
  }
  if (name === "set") {
    const k = lowerer.lowerCollectionKey(call.arguments[0]!, receiverIr.key);
    const v =
      receiverIr.value.kind === "dyn"
        ? lowerer.lowerCollectionKey(call.arguments[1]!, receiverIr.value)
        : lowerer.lowerExprExpecting(call.arguments[1]!, receiverIr.value);
    // A discarded set result needs no second receiver read or identity
    // owner. Keep the ordinary operand order: receiver, key, then value.
    let parent: ts.Node | undefined = call.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (ts.isExpressionStatement(parent)) {
      return { kind: "mapIntrinsic", method: "set", receiver, args: [k, v], type: VOID, loc };
    }
    const slot = lowerer.declareHiddenLocal("%mapSetReceiver", receiver.type);
    const ref = varRef(slot.id, receiver.type, loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: slot.id, init: receiver, loc },
        {
          kind: "exprStmt",
          expr: {
            kind: "mapIntrinsic",
            method: "set",
            receiver: ref,
            args: [k, v],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
      result: ref,
      type: receiver.type,
      loc,
    };
  }
  if (name === "has" || name === "delete") {
    const k = lowerer.lowerCollectionKey(call.arguments[0]!, receiverIr.key);
    return { kind: "mapIntrinsic", method: name, receiver, args: [k], type: BOOL, loc };
  }
  if (name === "clear") {
    return { kind: "mapIntrinsic", method: "clear", receiver, args: [], type: VOID, loc };
  }
  if (COLLECTION_ITERATOR_METHODS.has(name)) {
    return lowerMapIterDrainCall(
      lowerer,
      call,
      receiver,
      receiverIr,
      name as "keys" | "values" | "entries",
    );
  }
  // forEach
  return lowerMapForEachCall(lowerer, call, receiver, receiverIr, probedUntyped);
}

/** Stored collection iterators retain the native collection by reference. The
 * checked-value runtime supplies the live cursor without embedding an engine. */
function lowerCollectionIteratorCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  method: string,
): IrExpr {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access))
    throw new InternalCompilerError("collection iterator requires a member call");
  const boxed = lowerer.coerceInto(access.expression, receiver, DYN);
  const result = lowerDynDispatchMethodCall(lowerer, call, access, boxed, false);
  if (!result) throw new InternalCompilerError(`missing collection iterator dispatch: ${method}`);
  return result;
}

/** `[...m.keys()]` / `[...m.values()]` / `[...m.entries()]` — the iterator
 * methods use an optimized drain as the operand of a spread inside an array
 * literal, where JS drains the iterator on the spot. The call desugars to
 * a direct call of a synthetic drain function whose loop walks the same
 * iteration primitives as the forEach desugar and pushes each live entry
 * into a fresh array — key, value, or `[K, V]` tuple record per method.
 * No user code runs mid-drain (and nothing here mutates the map), so no
 * compaction can shift indices: the enter/exit bracket is unnecessary and
 * the snapshot IS what JS's immediate drain observes. Other contexts keep
 * a live iterator through the native checked-value runtime. */
function lowerMapIterDrainCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  mapT: IrType & { kind: "map" },
  method: "keys" | "values" | "entries",
): IrExpr {
  const loc = locOf(call);
  const inArraySpread =
    ts.isSpreadElement(call.parent) && ts.isArrayLiteralExpression(call.parent.parent);
  if (!inArraySpread) return lowerCollectionIteratorCall(lowerer, call, receiver, method);
  // The pushed element type. For entries the checker's own element type —
  // the [K, V] tuple behind MapIterator<[K, V]> — carries the interned
  // tuple shape the surrounding literal will intern too.
  let elemT: IrType;
  let tupleT: (IrType & { kind: "record" }) | null = null;
  if (method === "keys") elemT = mapT.key;
  else if (method === "values") elemT = mapT.value;
  else {
    const iterT = lowerer.typeOf(call);
    const targ = lowerer.checker.getTypeArguments(iterT as ts.TypeReference)[0];
    const mapped = targ ? lowerer.mapTypeOf(targ) : null;
    const shape = mapped?.kind === "record" ? lowerer.shapes.get(mapped.shapeId) : null;
    if (
      mapped?.kind !== "record" ||
      !shape?.tuple ||
      shape.fields.length !== 2 ||
      !typeEquals(shape.fields.find((f) => f.name === "0")!.type, mapT.key) ||
      !typeEquals(shape.fields.find((f) => f.name === "1")!.type, mapT.value)
    ) {
      lowerer.badType(call, lowerer.typeOf(call)); // defensive: the lib declares [K, V]
    }
    tupleT = mapped as IrType & { kind: "record" }; // narrowed by the check above
    elemT = tupleT!;
  }
  const key = `${method}:${typeKey(mapT.key)}:${typeKey(mapT.value)}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (!helper) {
    helper = `%map.${method}.${lowerer.mapHofHelpers.size}`;
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildMapIterDrainFn(helper, mapT, method, elemT, tupleT, loc));
  }
  return { kind: "call", callee: helper, args: [receiver], type: arrayOf(elemT), loc };
}

/** The drain loop, from existing IR nodes:
 *
 *   out = [];
 *   for (i = 0; i < m.iterCount; i++) {
 *     if (m.iterLive(i)) out.push(<key | value | [key, value]>);
 *   }
 *   return out;
 */
function buildMapIterDrainFn(
  name: string,
  mapT: IrType & { kind: "map" },
  method: "keys" | "values" | "entries",
  elemT: IrType,
  tupleT: (IrType & { kind: "record" }) | null,
  loc: SrcLoc,
): IrFunction {
  const outT = arrayOf(elemT);

  const iter = (
    m: "iterCount" | "iterLive" | "iterKey" | "iterValue",
    args: IrExpr[],
    type: IrType,
  ): IrExpr => ({
    kind: "mapIntrinsic",
    method: m,
    receiver: varRef("m.0", mapT, loc),
    args,
    type,
    loc,
  });
  const keyRead = iter("iterKey", [varRef("i.0", F64, loc)], mapT.key);
  const valRead = iter("iterValue", [varRef("i.0", F64, loc)], mapT.value);
  const pushed: IrExpr =
    method === "keys"
      ? keyRead
      : method === "values"
        ? valRead
        : {
            kind: "recordLit",
            fields: [
              { name: "0", value: keyRead },
              { name: "1", value: valRead },
            ],
            type: tupleT!,
            loc,
          };
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: outT, loc },
      loc,
    },
    countedFor(loc, iter("iterCount", [], F64), () => [
      {
        kind: "if",
        cond: iter("iterLive", [varRef("i.0", F64, loc)], BOOL),
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: varRef("out.0", outT, loc),
              args: [pushed],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ]),
    { kind: "return", value: varRef("out.0", outT, loc), loc },
  ];
  return {
    name,
    params: [{ localId: "m.0", name: "m", type: mapT }],
    returnType: outT,
    locals: [
      { id: "m.0", name: "m", type: mapT, mutable: true },
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ],
    body,
    loc,
  };
}

/** An immediate Map spread observes the same entry order as entries().
 * Each pair is new; its key and value retain their original identities. */
export function mapEntriesArray(lowerer: Lowerer, receiver: IrExpr): IrExpr {
  const mapT = receiver.type;
  if (mapT.kind !== "map") throw new InternalCompilerError("Map entries require a map");
  const tupleT: IrType & { kind: "record" } = {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "0", type: mapT.key },
        { name: "1", type: mapT.value },
      ],
      true,
    ),
  };
  const key = `entries:${typeKey(mapT.key)}:${typeKey(mapT.value)}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (!helper) {
    helper = `%map.entries.${lowerer.mapHofHelpers.size}`;
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(
      buildMapIterDrainFn(helper, mapT, "entries", tupleT, tupleT, receiver.loc),
    );
  }
  return {
    kind: "call",
    callee: helper,
    args: [receiver],
    type: arrayOf(tupleT),
    loc: receiver.loc,
  };
}

/** Snapshot a collection for immediate iteration. Array reads and callback
 * parameters may retain an undefined arm even when the checker spells a
 * bare collection. Observe that arm before touching native storage. */
export function lowerCollectionSpread(
  lowerer: Lowerer,
  source: IrExpr,
  node: ts.Expression,
): IrExpr | null {
  if (source.type.kind === "map") return mapEntriesArray(lowerer, source);
  if (source.type.kind === "set")
    return {
      kind: "setIntrinsic",
      method: "toArray",
      receiver: source,
      args: [],
      type: arrayOf(source.type.elem),
      loc: source.loc,
    };
  if (source.type.kind !== "union") return null;
  const arms = lowerer.unions.get(source.type.unionId)?.arms;
  const tag = arms?.findIndex((arm) => arm.kind === "map" || arm.kind === "set") ?? -1;
  const collection = arms?.[tag];
  if (
    (collection?.kind !== "map" && collection?.kind !== "set") ||
    !arms?.every((arm, index) => index === tag || isUnitType(arm))
  )
    return null;
  const loc = locOf(node);
  const slot = lowerer.declareHiddenLocal("%collectionSpread", source.type);
  const value = varRef(slot.id, source.type, loc);
  const narrowed: IrExpr = {
    kind: "unionNarrow",
    unionId: source.type.unionId,
    tag,
    value,
    type: collection,
    loc,
  };
  const entries: IrExpr =
    collection.kind === "map"
      ? mapEntriesArray(lowerer, narrowed)
      : {
          kind: "setIntrinsic",
          method: "toArray",
          receiver: narrowed,
          args: [],
          type: arrayOf(collection.elem),
          loc,
        };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: source, loc }],
    result: {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: source.type.unionId,
        tag,
        value,
        negated: false,
        type: BOOL,
        loc,
      },
      then: entries,
      else_: nodeThrowExpr(1, "", `${node.getText()} is not iterable`, entries.type, loc),
      type: entries.type,
      loc,
    },
    type: entries.type,
    loc,
  };
}

/** `m.forEach(fn)` desugars to a direct call of a synthetic module
 * function — one per key/value type + callback arity, interned — whose
 * body is an index loop over the map's ITERATION PRIMITIVES: read
 * iterCount fresh every pass (entries appended by the callback are
 * visited), skip tombstones with iterLive (deleted entries are skipped),
 * and bracket the loop with iterEnter/iterExit inside try/finally so the
 * runtime never compacts indices out from under it — even when the
 * callback throws. That is JS's live-iteration contract, Node-verified
 * (SEMANTICS.md). The callback receives (value, key) like JS; declaring
 * fewer parameters — (value) or () — is ordinary TS and supported. */
export function lowerMapForEachCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  mapT: IrType & { kind: "map" },
  bindUntyped = false,
): IrExpr {
  const loc = locOf(call);
  const argNode = call.arguments[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const previousRuntime: { symbol: ts.Symbol; type: IrType | undefined }[] = [];
  const previousImplicit = lowerer.implicitParamTypes;
  let contextualTs: Map<ts.Symbol, ts.Type> | null = null;
  if (bindUntyped && (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode))) {
    const expected = [mapT.value, mapT.key];
    argNode.parameters.slice(0, 2).forEach((param, i) => {
      const type = expected[i];
      if (
        type === undefined ||
        !ts.isIdentifier(param.name) ||
        param.type ||
        param.initializer ||
        param.dotDotDotToken
      )
        return;
      const checkerType = lowerer.checker.getTypeAtLocation(param.name);
      if ((checkerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return;
      const symbol = lowerer.checker.getSymbolAtLocation(param.name);
      if (!symbol) return;
      previousRuntime.push({ symbol, type: lowerer.runtimeOptionalBindingTypes.get(symbol) });
      lowerer.runtimeOptionalBindingTypes.set(symbol, type);
      const primitive =
        type.kind === "string"
          ? lowerer.checker.getStringType()
          : type.kind === "f64"
            ? lowerer.checker.getNumberType()
            : type.kind === "bool"
              ? lowerer.checker.getBooleanType()
              : null;
      if (primitive !== null) {
        contextualTs ??= new Map(previousImplicit ?? []);
        contextualTs.set(symbol, primitive);
      }
    });
  }
  if (contextualTs !== null) lowerer.implicitParamTypes = contextualTs;
  let fnArg: IrExpr;
  try {
    fnArg = lowerer.lowerExpr(argNode);
  } finally {
    lowerer.implicitParamTypes = previousImplicit;
    for (const { symbol, type } of previousRuntime) {
      if (type === undefined) lowerer.runtimeOptionalBindingTypes.delete(symbol);
      else lowerer.runtimeOptionalBindingTypes.set(symbol, type);
    }
  }
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > 2 ||
    (fnArg.type.params.length >= 1 && !typeEquals(fnArg.type.params[0]!, mapT.value)) ||
    (fnArg.type.params.length === 2 && !typeEquals(fnArg.type.params[1]!, mapT.key))
  ) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  // A void-returning contextual type accepts callbacks returning anything
  // (TS void-assignability), so the callback's ACTUAL return type rides
  // the helper signature — the desugared call discards the result like
  // JS's forEach does.
  const arity = fnArg.type.params.length;
  const fnRet = fnArg.type.ret;
  const key = `${typeKey(mapT.key)}:${typeKey(mapT.value)}:${arity}:${typeKey(fnRet)}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (!helper) {
    helper = `%map.forEach.${lowerer.mapHofHelpers.size}`;
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildCollectionForEachFn(helper, mapT, arity, fnRet, loc));
  }
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: VOID, loc };
}

/** Ambient Set method calls — Map's lowering with the value slot gone.
 * `add`/`has`/`delete`/`clear` lower to setIntrinsic; `forEach` desugars
 * like Map's over the shared iteration primitives. Null when this isn't
 * an ambient Set method call. */
export function lowerSetMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  if (!SET_METHODS.has(name) && !SET_COMBINE_METHODS.has(name)) return null;
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  let probedUntyped = false;
  // The identity-Set idiom (JS): the CHECKER type is an unmappable
  // Set<union-of-signatures>, but the VALUE lowered as a real Set of
  // identity tokens (the new-Set probe) — the lowered receiver's type
  // is the honest dispatch key.
  if (receiverIr?.kind !== "set" && isJsSourceFile(access.getSourceFile())) {
    const probed = tryLowerExpression(lowerer, access.expression);
    if (probed?.type.kind === "set") {
      receiverIr = probed.type;
      probedUntyped = true;
    }
  }
  if (receiverIr?.kind !== "set") return null;
  // A collection interface may refine has() into a type predicate.
  // Type mapping checked that view's native ABI; the value check below
  // still rejects structural mocks and assertions over other objects.
  if (!probedUntyped && !lowerer.isStdlibMember(access) && name !== "has") return null;
  const loc = locOf(call);
  const value = lowerer.lowerExpr(access.expression);
  const receiver =
    lowerer.runtimeOptionalPropertyReceiver(access.expression, value, receiverIr, name) ?? value;
  // The lib's `add` returns the Set (chaining typechecks); the lowered
  // add is a void statement — fence chained receivers like Map's set.
  if (receiver.type.kind !== "set") {
    lowerer.noLowering(
      "chained Set method calls",
      access.expression,
      "the lowered add() produces no value — call each add(v) as its own statement",
    );
  }
  if (name === "forEach" && call.arguments.length !== 1) {
    lowerer.noLowering(
      `.forEach with ${call.arguments.length} arguments`,
      call,
      "the thisArg parameter has no lowering — use an arrow function",
    );
  }
  if (COLLECTION_ITERATOR_METHODS.has(name)) {
    return lowerCollectionIteratorCall(lowerer, call, receiver, name);
  }
  if (SET_COMBINE_METHODS.has(name)) {
    return lowerSetCombineCall(lowerer, call, name, receiver, receiverIr);
  }
  if (name === "add") {
    const v = lowerer.lowerCollectionKey(call.arguments[0]!, receiverIr.elem);
    return { kind: "setIntrinsic", method: "add", receiver, args: [v], type: VOID, loc };
  }
  if (name === "has" || name === "delete") {
    const v = lowerer.lowerCollectionKey(call.arguments[0]!, receiverIr.elem);
    return { kind: "setIntrinsic", method: name, receiver, args: [v], type: BOOL, loc };
  }
  if (name === "clear") {
    return { kind: "setIntrinsic", method: "clear", receiver, args: [], type: VOID, loc };
  }
  // forEach
  return lowerer.lowerSetForEachCall(call, receiver, receiverIr);
}

/** `s.forEach(fn)` — Map's desugar shape over the set primitives. JS
 * passes (value, value, set): the second parameter IS the element again,
 * so both one- and two-parameter callbacks receive elem-typed arguments
 * (iterKey read once, passed twice). Same live-iteration bracketing. */
export function lowerSetForEachCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  setT: IrType & { kind: "set" },
): IrExpr {
  const loc = locOf(call);
  const argNode = call.arguments[0];
  if (!argNode) lowerer.unsupported("SC1090", call, "this call form"); // tsc-guarded
  const fnArg = lowerer.lowerExpr(argNode);
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > 2 ||
    !fnArg.type.params.every((p) => typeEquals(p, setT.elem))
  ) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  const arity = fnArg.type.params.length;
  const fnRet = fnArg.type.ret;
  const key = `${typeKey(setT.elem)}:${arity}:${typeKey(fnRet)}`;
  let helper = lowerer.setHofHelpers.get(key);
  if (!helper) {
    helper = `%set.forEach.${lowerer.setHofHelpers.size}`;
    lowerer.setHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildCollectionForEachFn(helper, setT, arity, fnRet, loc));
  }
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: VOID, loc };
}

/** The ES2025 Set composition methods (union/intersection/difference/
 * symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom): one
 * set-like argument, desugared to an interned two-set helper loop. Only
 * a REAL Set argument of the receiver's element type lowers — the
 * desugar substitutes the builtin has/size for the spec's observable
 * calls, which is exact for Sets and wrong for anything else (a Map or
 * a custom { has, size, keys } object fences). */
function lowerSetCombineCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  receiver: IrExpr,
  setT: IrType & { kind: "set" },
): IrExpr {
  const loc = locOf(call);
  const argNode = call.arguments[0];
  if (call.arguments.length !== 1 || argNode === undefined || ts.isSpreadElement(argNode)) {
    lowerer.noLowering(
      `Set.prototype.${name} with ${call.arguments.length} arguments`,
      call,
      "exactly one Set argument is the supported form",
    );
  }
  const other = lowerer.lowerExpr(argNode);
  if (other.type.kind !== "set") {
    lowerer.noLowering(
      `Set.prototype.${name} over a set-like argument of type '${lowerer.checker.typeToString(lowerer.typeOf(argNode))}'`,
      argNode,
      "only a real Set lowers (the argument's has/size must be the builtins) — build one first: new Set(...)",
    );
  }
  if (!typeEquals(other.type.elem, setT.elem)) {
    lowerer.noLowering(
      `Set.prototype.${name} across element types`,
      call,
      "both sides must share ONE element type — annotate the sets to a common Set<T>",
    );
  }
  const predicate = name === "isSubsetOf" || name === "isSupersetOf" || name === "isDisjointFrom";
  const resultT: IrType = predicate ? BOOL : setT;
  const key = `${name}:${typeKey(setT.elem)}`;
  let helper = lowerer.setHofHelpers.get(key);
  if (!helper) {
    helper = `%set.${name}.${lowerer.setHofHelpers.size}`;
    lowerer.setHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildSetCombineFn(helper, name, setT, loc));
  }
  return { kind: "call", callee: helper, args: [receiver, other], type: resultT, loc };
}

/** The two-set helper bodies. No user code runs mid-walk (has/add are
 * the builtins), so the loops skip the live-iteration enter/exit
 * bracketing — nothing can compact the entries underneath them. The
 * spec's iteration orders are kept where observable: union appends the
 * receiver's elements then the argument's; intersection walks the
 * SMALLER side (the result's insertion order follows the walked side,
 * per spec's size branch); difference/symmetricDifference walk
 * receiver-then-argument. The predicates return at the first
 * counterexample.
 *
 *   union(a, b):               r = new Set; for v of a: r.add(v); for v of b: r.add(v); return r
 *   intersection(a, b):        r = new Set; walk the smaller side, keep what the other has
 *   difference(a, b):          r = new Set; for v of a: if (!b.has(v)) r.add(v)
 *   symmetricDifference(a, b): a's not-in-b, then b's not-in-a
 *   isSubsetOf(a, b):          for v of a: if (!b.has(v)) return false; return true
 *   isSupersetOf(a, b):        for v of b: if (!a.has(v)) return false; return true
 *   isDisjointFrom(a, b):      for v of a: if (b.has(v)) return false; return true
 */
function buildSetCombineFn(
  name: string,
  method: string,
  setT: IrType & { kind: "set" },
  loc: SrcLoc,
): IrFunction {
  const elem = setT.elem;
  const predicate =
    method === "isSubsetOf" || method === "isSupersetOf" || method === "isDisjointFrom";

  const setOp = (recv: string, m: IrSetIntrinsicMethod, args: IrExpr[], type: IrType): IrExpr => ({
    kind: "setIntrinsic",
    method: m,
    receiver: varRef(recv, setT, loc),
    args,
    type,
    loc,
  });
  const locals: IrLocal[] = [
    { id: "a.0", name: "a", type: setT, mutable: true },
    { id: "b.0", name: "b", type: setT, mutable: true },
  ];
  let nextLocal = 0;
  /* for (i = 0; i < src.iterCount; i++) if (src.iterLive(i)) { v = src.iterKey(i); <visit(v)> } */
  const loopOver = (src: string, visit: (v: IrExpr) => IrStmt[]): IrStmt => {
    const iId = `i.${nextLocal}`;
    const vId = `v.${nextLocal}`;
    nextLocal += 1;
    locals.push({ id: iId, name: "i", type: F64, mutable: true });
    locals.push({ id: vId, name: "v", type: elem, mutable: false });
    const v = varRef(vId, elem, loc);
    return {
      kind: "for",
      init: { kind: "varDecl", localId: iId, init: numLit(0, loc), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: varRef(iId, F64, loc),
        right: setOp(src, "iterCount", [], F64),
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: iId,
        value: {
          kind: "bin",
          op: "+",
          left: varRef(iId, F64, loc),
          right: numLit(1, loc),
          type: F64,
          loc,
        },
        loc,
      },
      body: [
        {
          kind: "if",
          cond: setOp(src, "iterLive", [varRef(iId, F64, loc)], BOOL),
          then: [
            {
              kind: "varDecl",
              localId: vId,
              init: setOp(src, "iterKey", [varRef(iId, F64, loc)], elem),
              loc,
            },
            ...visit(v),
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    };
  };
  const has = (src: string, v: IrExpr): IrExpr => setOp(src, "has", [v], BOOL);
  const not = (e: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand: e, type: BOOL, loc });
  const addTo = (v: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "setIntrinsic",
      method: "add",
      receiver: varRef("r.0", setT, loc),
      args: [v],
      type: VOID,
      loc,
    },
    loc,
  });
  const addIf = (cond: IrExpr, v: IrExpr): IrStmt[] => [
    { kind: "if", cond, then: [addTo(v)], else_: null, loc },
  ];
  const returnIf = (cond: IrExpr, value: boolean): IrStmt[] => [
    {
      kind: "if",
      cond,
      then: [{ kind: "return", value: boolLit(value, loc), loc }],
      else_: null,
      loc,
    },
  ];
  const body: IrStmt[] = [];
  if (!predicate) {
    locals.push({ id: "r.0", name: "r", type: setT, mutable: false });
    body.push({ kind: "varDecl", localId: "r.0", init: { kind: "setNew", type: setT, loc }, loc });
  }
  switch (method) {
    case "union":
      body.push(loopOver("a.0", (v) => [addTo(v)]));
      body.push(loopOver("b.0", (v) => [addTo(v)]));
      break;
    case "intersection":
      body.push({
        kind: "if",
        cond: {
          kind: "bin",
          op: "<=",
          left: setOp("a.0", "size", [], F64),
          right: setOp("b.0", "size", [], F64),
          type: BOOL,
          loc,
        },
        then: [loopOver("a.0", (v) => addIf(has("b.0", v), v))],
        else_: [loopOver("b.0", (v) => addIf(has("a.0", v), v))],
        loc,
      });
      break;
    case "difference":
      body.push(loopOver("a.0", (v) => addIf(not(has("b.0", v)), v)));
      break;
    case "symmetricDifference":
      body.push(loopOver("a.0", (v) => addIf(not(has("b.0", v)), v)));
      body.push(loopOver("b.0", (v) => addIf(not(has("a.0", v)), v)));
      break;
    case "isSubsetOf":
      body.push(loopOver("a.0", (v) => returnIf(not(has("b.0", v)), false)));
      break;
    case "isSupersetOf":
      body.push(loopOver("b.0", (v) => returnIf(not(has("a.0", v)), false)));
      break;
    case "isDisjointFrom":
      body.push(loopOver("a.0", (v) => returnIf(has("b.0", v), false)));
      break;
    default:
      throw new InternalCompilerError(`lowerer bug: unknown set combine method ${method}`);
  }
  body.push({
    kind: "return",
    value: predicate ? boolLit(true, loc) : varRef("r.0", setT, loc),
    loc,
  });
  return {
    name,
    params: [
      { localId: "a.0", name: "a", type: setT },
      { localId: "b.0", name: "b", type: setT },
    ],
    returnType: predicate ? BOOL : setT,
    locals,
    body,
    loc,
  };
}

/** Consume a Set seed immediately, including optional inherited sets used
 * by compiler tables. Nullish seeds construct empty sets; a lazy fallback
 * consumes its evaluated branch even when it reassigns the source binding. */
export function lowerSetSeedNew(
  lowerer: Lowerer,
  node: ts.Expression,
  setT: IrType & { kind: "set" },
): IrExpr | null {
  if (ts.isSpreadElement(node)) return null;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  const loc = locOf(node);
  const undefinedSeed = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedSeed)
    return defaultAfterUndefined(undefinedSeed, { kind: "setNew", type: setT, loc });
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    const undefinedLeft = lowerStaticallyUndefinedArgument(lowerer, node.left);
    const fallback = node.right;
    if (undefinedLeft) {
      const selected = lowerSetSeedNew(lowerer, fallback, setT);
      return selected ? defaultAfterUndefined(undefinedLeft, selected) : null;
    }
    const source = lowerer.lowerExpr(node.left);
    if (isUnitType(source.type)) {
      const selected = lowerSetSeedNew(lowerer, fallback, setT);
      return selected ? defaultAfterUndefined(source, selected) : null;
    }
    return setFromSeedValue(lowerer, source, setT, () => lowerSetSeedNew(lowerer, fallback, setT));
  }
  if (ts.isConditionalExpression(node)) {
    const yes = lowerSetSeedNew(lowerer, node.whenTrue, setT);
    const no = lowerSetSeedNew(lowerer, node.whenFalse, setT);
    return yes && no
      ? {
          kind: "ternary",
          cond: lowerer.lowerCondition(node.condition),
          then: yes,
          else_: no,
          type: setT,
          loc,
        }
      : null;
  }
  // Constructor contextual types include Iterable<T>, which has no value
  // representation. Build a literal at the actual Set element ABI instead.
  if (ts.isArrayLiteralExpression(node) && !node.elements.some(ts.isSpreadElement)) {
    const elems = node.elements.map((element) => lowerer.lowerCollectionKey(element, setT.elem));
    return {
      kind: "setNew",
      seed: { kind: "arrayLit", elems, type: arrayOf(setT.elem), loc },
      type: setT,
      loc,
    };
  }
  const input = collectionInput(lowerer, node);
  if (input && collectionDestinationMatches(lowerer, input, setT)) {
    const source = lowerCollectionInput(lowerer, input);
    if (source) return ingestCollection(lowerer, input, source, setT, loc);
  }
  const seedType = lowerer.typeOf(node);
  const declared = lowerer.mapTypeOf(seedType);
  const scalar = isPrimitiveCollectionKey(
    setT.elem,
    setT.elem.kind === "union" ? lowerer.unions.get(setT.elem.unionId)?.arms : undefined,
  );
  let source =
    !scalar && (declared?.kind === "array" || declared?.kind === "record")
      ? lowerer.lowerCollectionKey(node, declared)
      : lowerer.lowerExpr(node);
  if (
    declared?.kind === "string" &&
    setT.elem.kind === "string" &&
    (source.type.kind === "dyn" || source.type.kind === "jsval")
  ) {
    source = lowerer.coerceInto(node, source, STRING);
  }
  if (setT.elem.kind === "dyn" && lowerer.dynConvertible(source.type)) {
    return {
      kind: "dynCheck",
      value: {
        kind: "libCall",
        fn: "dyn.nativeSetNew",
        args: [lowerer.coerceInto(node, source, DYN)],
        type: DYN,
        loc,
      },
      type: setT,
      loc,
    };
  }
  if (declared?.kind === "array" && typeEquals(declared.elem, setT.elem)) {
    // Preserve the existing checked scalar-iterable bridge. Reference
    // elements must retain identity and cannot enter via a copying exit.
    if (source.type.kind === "jsval" && lowerer.boundaryExitSafe(arrayOf(setT.elem))) {
      source = { kind: "jsExit", value: source, type: arrayOf(setT.elem), loc };
    }
    if (source.type.kind === "dyn" && scalar) {
      source = lowerer.coerceInto(
        node,
        {
          kind: "libCall",
          fn: "dyn.iterPack",
          args: [source, strLit(node.getText(), loc)],
          type: DYN,
          loc,
        },
        arrayOf(setT.elem),
      );
    }
  }
  return setFromSeedValue(lowerer, source, setT, () => ({ kind: "setNew", type: setT, loc }));
}

function setFromSeedValue(
  lowerer: Lowerer,
  source: IrExpr,
  setT: IrType & { kind: "set" },
  missing: () => IrExpr | null,
): IrExpr | null {
  const loc = source.loc;
  if (isUnitType(source.type)) {
    const empty = missing();
    return empty ? defaultAfterUndefined(source, empty) : null;
  }
  if (source.type.kind === "union") {
    const unionId = source.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms;
    if (!arms) return null;
    const slot = lowerer.declareHiddenLocal("%setSeed", source.type);
    const ref = varRef(slot.id, source.type, loc);
    let result: IrExpr | null = null;
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const arm = arms[tag]!;
      const branch = isUnitType(arm)
        ? missing()
        : setFromSeedValue(
            lowerer,
            {
              kind: "unionNarrow",
              unionId,
              tag,
              value: ref,
              type: arm,
              loc,
            },
            setT,
            missing,
          );
      if (!branch) return null;
      result =
        result === null
          ? branch
          : {
              kind: "ternary",
              cond: {
                kind: "unionIsTag",
                unionId,
                tag,
                value: ref,
                negated: false,
                type: BOOL,
                loc,
              },
              then: branch,
              else_: result,
              type: setT,
              loc,
            };
    }
    return result
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: slot.id, init: source, loc }],
          result,
          type: setT,
          loc,
        }
      : null;
  }
  let seed: IrExpr;
  if (source.type.kind === "set" && typeEquals(source.type, setT)) {
    return { kind: "setIntrinsic", method: "clone", receiver: source, args: [], type: setT, loc };
  } else if (source.type.kind === "string" && setT.elem.kind === "string") {
    seed = strCharsCall(lowerer, source, loc);
  } else if (source.type.kind === "array" && typeEquals(source.type.elem, setT.elem)) {
    seed = source;
  } else if (source.type.kind === "record") {
    const shape = lowerer.shapes.get(source.type.shapeId);
    if (!shape?.tuple || !shape.fields.every((field) => typeEquals(field.type, setT.elem)))
      return null;
    const arrayT: IrType & { kind: "array" } = { kind: "array", elem: setT.elem };
    const helper = lowerer.tupleArrayWidthHelper(source.type.shapeId, arrayT, loc);
    if (!helper) return null;
    seed = { kind: "call", callee: helper, args: [source], type: arrayT, loc };
  } else return null;
  return { kind: "setNew", seed, type: setT, loc };
}

/** Consume supported Map seeds: matching Maps and tuple arrays, plus
 * nullish values that construct an empty Map. Conditional/nullish seeds
 * select one lazy branch without representing a first-class iterable.
 * Copy loops preserve entry order and stored reference identities. */
export function lowerMapSeedNew(
  lowerer: Lowerer,
  argNode: ts.Expression,
  mapT: IrType & { kind: "map" },
): IrExpr | null {
  if (ts.isSpreadElement(argNode)) return null;
  const empty = lowerer.emptyCollectionFor(argNode, mapT);
  if (empty) return empty;
  while (ts.isParenthesizedExpression(argNode)) argNode = argNode.expression;
  // A constructor consumes either iterable branch immediately. It does
  // not need a first-class Map|array representation for `cached ?? []`.
  // Snapshot the left before the lazy fallback can mutate its binding.
  if (
    ts.isBinaryExpression(argNode) &&
    argNode.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    const source = lowerer.lowerExpr(argNode.left);
    if (isUnitType(source.type)) {
      const fallback = lowerMapSeedNew(lowerer, argNode.right, mapT);
      return fallback ? defaultAfterUndefined(source, fallback) : null;
    }
    if (source.type.kind !== "union") return mapFromSeedValue(lowerer, source, mapT);
    const arms = lowerer.unions.get(source.type.unionId)?.arms;
    if (!arms) return null;
    const loc = locOf(argNode);
    const saved = lowerer.declareHiddenLocal("%mapSeed", source.type);
    const ref = varRef(saved.id, source.type, loc);
    let result: IrExpr | null = null;
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const arm = arms[tag]!;
      const branch = isUnitType(arm)
        ? lowerMapSeedNew(lowerer, argNode.right, mapT)
        : mapFromSeedValue(
            lowerer,
            { kind: "unionNarrow", unionId: source.type.unionId, tag, value: ref, type: arm, loc },
            mapT,
          );
      if (!branch) return null;
      result =
        result === null
          ? branch
          : {
              kind: "ternary",
              cond: {
                kind: "unionIsTag",
                unionId: source.type.unionId,
                tag,
                value: ref,
                negated: false,
                type: BOOL,
                loc,
              },
              then: branch,
              else_: result,
              type: mapT,
              loc,
            };
    }
    return result
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: saved.id, init: source, loc }],
          result,
          type: mapT,
          loc,
        }
      : null;
  }
  if (ts.isConditionalExpression(argNode)) {
    const yes = lowerMapSeedNew(lowerer, argNode.whenTrue, mapT);
    const no = lowerMapSeedNew(lowerer, argNode.whenFalse, mapT);
    return yes && no
      ? {
          kind: "ternary",
          cond: lowerer.lowerCondition(argNode.condition),
          then: yes,
          else_: no,
          type: mapT,
          loc: locOf(argNode),
        }
      : null;
  }
  if (ts.isArrayLiteralExpression(argNode)) {
    if (
      isJsSourceFile(argNode.getSourceFile()) &&
      argNode.elements.some((entry) => !ts.isArrayLiteralExpression(entry))
    ) {
      return mapFromSeedValue(lowerer, lowerer.lowerExprExpecting(argNode, DYN), mapT);
    }
    const tuple: IrType & { kind: "record" } = {
      kind: "record",
      shapeId: lowerer.shapes.intern(
        [
          { name: "0", type: mapT.key },
          { name: "1", type: mapT.value },
        ],
        true,
      ),
    };
    return mapFromSeedValue(
      lowerer,
      lowerer.lowerArrayLiteral(argNode, { kind: "array", elem: tuple }),
      mapT,
    );
  }
  const input = collectionInput(lowerer, argNode);
  if (input) {
    if (!collectionDestinationMatches(lowerer, input, mapT)) return null;
    const source = lowerCollectionInput(lowerer, input);
    if (source) return ingestCollection(lowerer, input, source, mapT, locOf(argNode));
  }
  const seed = lowerer.lowerExpr(argNode);
  return mapFromSeedValue(lowerer, seed, mapT);
}

export function mapFromSeedValue(
  lowerer: Lowerer,
  seed: IrExpr,
  mapT: IrType & { kind: "map" },
): IrExpr | null {
  const loc = seed.loc;
  if (isUnitType(seed.type)) {
    return defaultAfterUndefined(seed, { kind: "mapNew", type: mapT, loc });
  }
  if (seed.type.kind === "union") {
    const arms = lowerer.unions.get(seed.type.unionId)?.arms;
    if (!arms) return null;
    const saved = lowerer.declareHiddenLocal("%mapSeed", seed.type);
    const ref = varRef(saved.id, seed.type, loc);
    let result: IrExpr | null = null;
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const arm = arms[tag]!;
      const branch: IrExpr | null = isUnitType(arm)
        ? { kind: "mapNew", type: mapT, loc }
        : mapFromSeedValue(
            lowerer,
            { kind: "unionNarrow", unionId: seed.type.unionId, tag, value: ref, type: arm, loc },
            mapT,
          );
      if (!branch) return null;
      result =
        result === null
          ? branch
          : {
              kind: "ternary",
              cond: {
                kind: "unionIsTag",
                unionId: seed.type.unionId,
                tag,
                value: ref,
                negated: false,
                type: BOOL,
                loc,
              },
              then: branch,
              else_: result,
              type: mapT,
              loc,
            };
    }
    return result
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: saved.id, init: seed, loc }],
          result,
          type: mapT,
          loc,
        }
      : null;
  }
  if (seed.type.kind === "map") {
    if (!typeEquals(seed.type, mapT)) return null;
    return { kind: "mapIntrinsic", method: "clone", receiver: seed, args: [], type: mapT, loc };
  }

  if (
    seed.type.kind === "dyn" ||
    (seed.type.kind === "array" &&
      !(seed.type.elem.kind === "record" && lowerer.shapes.get(seed.type.elem.shapeId)?.tuple))
  ) {
    const key = `checked-seed:${typeKey(mapT)}`;
    let name = lowerer.mapHofHelpers.get(key);
    if (!name) {
      name = `%map.checkedSeed.${lowerer.mapHofHelpers.size}`;
      lowerer.mapHofHelpers.set(key, name);
      const source = varRef("source.0", DYN, loc);
      const entries = varRef("entries.0", DYN, loc);
      const entry = varRef("entry.0", DYN, loc);
      const target = varRef("target.0", mapT, loc);
      const keyValue = varRef("key.0", DYN, loc);
      const itemValue = varRef("value.0", DYN, loc);
      const checked = (value: IrExpr, type: IrType): IrExpr =>
        type.kind === "dyn" ? value : { kind: "dynCheck", value, type, loc };
      lowerer.liftedFns.push({
        name,
        params: [{ localId: "source.0", name: "source", type: DYN }],
        returnType: mapT,
        locals: [
          { id: "source.0", name: "source", type: DYN, mutable: false },
          { id: "entries.0", name: "entries", type: DYN, mutable: false },
          { id: "entry.0", name: "entry", type: DYN, mutable: false },
          { id: "key.0", name: "key", type: DYN, mutable: false },
          { id: "value.0", name: "value", type: DYN, mutable: false },
          { id: "target.0", name: "target", type: mapT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
        ],
        body: [
          { kind: "varDecl", localId: "target.0", init: { kind: "mapNew", type: mapT, loc }, loc },
          {
            kind: "varDecl",
            localId: "entries.0",
            init: { kind: "libCall", fn: "dyn.mapSeedEntries", args: [source], type: DYN, loc },
            loc,
          },
          countedFor(
            loc,
            { kind: "libCall", fn: "dyn.arrLen", args: [entries], type: F64, loc },
            () => [
              {
                kind: "varDecl",
                localId: "entry.0",
                init: {
                  kind: "libCall",
                  fn: "dyn.mapSeedEntry",
                  args: [
                    {
                      kind: "libCall",
                      fn: "dyn.arrAt",
                      args: [entries, varRef("i.0", F64, loc)],
                      type: DYN,
                      loc,
                    },
                  ],
                  type: DYN,
                  loc,
                },
                loc,
              },
              {
                kind: "varDecl",
                localId: "key.0",
                init: { kind: "dynKeyGet", value: entry, key: strLit("0", loc), type: DYN, loc },
                loc,
              },
              {
                kind: "varDecl",
                localId: "value.0",
                init: { kind: "dynKeyGet", value: entry, key: strLit("1", loc), type: DYN, loc },
                loc,
              },
              {
                kind: "exprStmt",
                expr: {
                  kind: "mapIntrinsic",
                  method: "set",
                  receiver: target,
                  args: [checked(keyValue, mapT.key), checked(itemValue, mapT.value)],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ],
          ),
          { kind: "return", value: target, loc },
        ],
        loc,
      });
    }
    const source: IrExpr =
      seed.type.kind === "dyn" ? seed : { kind: "dynFrom", value: seed, type: DYN, loc };
    return { kind: "call", callee: name, args: [source], type: mapT, loc };
  }
  if (seed.type.kind !== "array" || seed.type.elem.kind !== "record") return null;
  const elem = seed.type.elem;
  const shape = lowerer.shapes.get(elem.shapeId);
  if (!shape?.tuple || shape.fields.length !== 2) return null;
  const kT = shape.fields.find((f) => f.name === "0")!.type;
  const vT = shape.fields.find((f) => f.name === "1")!.type;
  if (!typeEquals(kT, mapT.key) || !typeEquals(vT, mapT.value)) return null;
  const key = `seed:${typeKey(mapT.key)}:${typeKey(mapT.value)}:${elem.shapeId}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (!helper) {
    helper = `%map.seed.${lowerer.mapHofHelpers.size}`;
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildMapSeedFn(mapT, helper, seed.type, elem, kT, vT, loc));
  }
  return { kind: "call", callee: helper, args: [seed], type: mapT, loc };
}

/** The seeding loop, from existing IR nodes:
 *
 *   m = new Map();
 *   for (i = 0; i < a.length; i++) { e = a[i]; m.set(e[0], e[1]); }
 *   return m;
 *
 * No user code runs mid-loop (keys/values are plain reads), so the length
 * read's freshness is unobservable — it re-reads anyway, matching the
 * array iterator `new Map(arr)` drains in JS. */
function buildMapSeedFn(
  mapT: IrType & { kind: "map" },
  name: string,
  arrT: IrType & { kind: "array" },
  tupleT: IrType & { kind: "record" },
  kT: IrType,
  vT: IrType,
  loc: SrcLoc,
): IrFunction {
  const e = varRef("e.0", tupleT, loc);
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "m.0", init: { kind: "mapNew", type: mapT, loc }, loc },
    countedFor(
      loc,
      {
        kind: "arrIntrinsic",
        method: "length",
        receiver: varRef("a.0", arrT, loc),
        args: [],
        type: F64,
        loc,
      },
      () => [
        { kind: "varDecl", localId: "e.0", init: arrayElementRead(arrT, tupleT, loc), loc },
        {
          kind: "exprStmt",
          expr: {
            kind: "mapIntrinsic",
            method: "set",
            receiver: varRef("m.0", mapT, loc),
            args: [
              { kind: "recordGet", obj: e, shapeId: tupleT.shapeId, field: "0", type: kT, loc },
              { kind: "recordGet", obj: e, shapeId: tupleT.shapeId, field: "1", type: vT, loc },
            ],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
    ),
    { kind: "return", value: varRef("m.0", mapT, loc), loc },
  ];
  return {
    name,
    params: [{ localId: "a.0", name: "a", type: arrT }],
    returnType: mapT,
    locals: [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "m.0", name: "m", type: mapT, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "e.0", name: "e", type: tupleT, mutable: false },
    ],
    body,
    loc,
  };
}

/** Map and Set forEach share live iteration and exception cleanup. Preserve
 * Map's (value, key) reads and Set's repeated value argument; neither reads
 * an entry that the callback's declared arity does not consume. iterCount is
 * read on every loop condition so appended entries are visited. iterLive
 * skips deletions, and finally restores iteration depth even when a callback
 * throws or recursively iterates the same collection. */
function buildCollectionForEachFn(
  name: string,
  collectionT: IrType & ({ kind: "map" } | { kind: "set" }),
  arity: number,
  fnRet: IrType,
  loc: SrcLoc,
): IrFunction {
  const valueT = collectionT.kind === "map" ? collectionT.value : collectionT.elem;
  const fnT = funcOf(
    collectionT.kind === "map"
      ? arity === 0
        ? []
        : arity === 1
          ? [valueT]
          : [valueT, collectionT.key]
      : Array.from({ length: arity }, () => valueT),
    fnRet,
  );
  const receiver = varRef("m.0", collectionT, loc);
  const index = varRef("i.0", F64, loc);
  const iter = (
    method: "iterCount" | "iterLive" | "iterKey" | "iterEnter" | "iterExit",
    args: IrExpr[],
    type: IrType,
  ): IrExpr =>
    collectionT.kind === "map"
      ? { kind: "mapIntrinsic", method, receiver, args, type, loc }
      : { kind: "setIntrinsic", method, receiver, args, type, loc };
  const locals: IrLocal[] = [
    { id: "m.0", name: "m", type: collectionT, mutable: true },
    { id: "f.0", name: "f", type: fnT, mutable: true },
    { id: "i.0", name: "i", type: F64, mutable: true },
  ];
  const visitBody: IrStmt[] = [];
  const callArgs: IrExpr[] = [];
  if (arity >= 1) {
    locals.push({ id: "v.0", name: "v", type: valueT, mutable: false });
    visitBody.push({
      kind: "varDecl",
      localId: "v.0",
      init:
        collectionT.kind === "map"
          ? {
              kind: "mapIntrinsic",
              method: "iterValue",
              receiver,
              args: [index],
              type: valueT,
              loc,
            }
          : iter("iterKey", [index], valueT),
      loc,
    });
    const valueArity = collectionT.kind === "map" ? 1 : arity;
    for (let i = 0; i < valueArity; i++) callArgs.push(varRef("v.0", valueT, loc));
  }
  if (collectionT.kind === "map" && arity === 2) {
    locals.push({ id: "k.0", name: "k", type: collectionT.key, mutable: false });
    visitBody.push({
      kind: "varDecl",
      localId: "k.0",
      init: iter("iterKey", [index], collectionT.key),
      loc,
    });
    callArgs.push(varRef("k.0", collectionT.key, loc));
  }
  visitBody.push({
    kind: "exprStmt",
    expr: { kind: "callValue", callee: varRef("f.0", fnT, loc), args: callArgs, type: fnRet, loc },
    loc,
  });
  const loop = countedFor(loc, iter("iterCount", [], F64), () => [
    { kind: "if", cond: iter("iterLive", [index], BOOL), then: visitBody, else_: null, loc },
  ]);
  return {
    name,
    params: [
      { localId: "m.0", name: "m", type: collectionT },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: VOID,
    locals,
    body: [
      { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
      {
        kind: "tryCatch",
        tryBody: [loop],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }],
        loc,
      },
    ],
    loc,
  };
}
