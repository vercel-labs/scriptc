import { keyedHelperName } from "./stable-names.js";
import * as ts from "../ts7/adapter.js";
import { InternalCompilerError } from "../../errors.js";
import { typeKey } from "../type-mapper.js";
import { boolLit, countedFor, numLit, strLit, varRef } from "../../ir/build.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  VOID,
  typeEquals,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { arrayValueStore } from "./array-values.js";
import { iteratorCanStep, iteratorValue } from "./iterator-consumption.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";

type Collection = IrType & { kind: "map" | "set" };
type Destination = IrType & { kind: "array" | "map" | "set" };
type Selection = "keys" | "values" | "entries";
export interface CollectionInput {
  source: ts.Expression;
  element: IrType;
  collection: Collection | null;
  selection: Selection;
  access?: ts.PropertyAccessExpression;
}

function entryType(lowerer: Lowerer, key: IrType, value: IrType): IrType {
  return {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "0", type: key },
        { name: "1", type: value },
      ],
      true,
    ),
  };
}

/** Only builtin collection views can bypass iterator dispatch. Stored
 * cursors keep the protocol path, including overridden next/return methods. */
export function collectionInput(
  lowerer: Lowerer,
  expression: ts.Expression,
): CollectionInput | null {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (
    ts.isCallExpression(expression) &&
    !expression.questionDotToken &&
    expression.arguments.nodes.length === 0 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    !expression.expression.questionDotToken
  ) {
    const access = expression.expression;
    const selection = access.name.text;
    if (
      (selection === "keys" || selection === "values" || selection === "entries") &&
      lowerer.isStdlibMember(access)
    ) {
      const collection = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
      if (collection?.kind === "map" || collection?.kind === "set") {
        const key = collection.kind === "map" ? collection.key : collection.elem;
        const value = collection.kind === "map" ? collection.value : collection.elem;
        const element =
          selection === "entries"
            ? entryType(lowerer, key, value)
            : selection === "keys"
              ? key
              : value;
        return { source: access.expression, element, collection, selection, access };
      }
    }
  }
  const type = lowerer.typeOf(expression);
  const mapped = lowerer.mapTypeOf(type);
  if (mapped?.kind === "map")
    return {
      source: expression,
      collection: mapped,
      selection: "entries",
      element: entryType(lowerer, mapped.key, mapped.value),
    };
  if (mapped?.kind === "set")
    return { source: expression, collection: mapped, selection: "values", element: mapped.elem };
  const symbol = type.getSymbol();
  if (
    !symbol ||
    (ts.symbolName(symbol) !== "MapIterator" && ts.symbolName(symbol) !== "SetIterator") ||
    !lowerer.isStdlibSymbol(symbol)
  )
    return null;
  const argument = lowerer.checker.getTypeArguments(type as ts.TypeReference)[0];
  const element = argument ? lowerer.mapTypeOf(argument) : null;
  return element ? { source: expression, element, collection: null, selection: "values" } : null;
}

export function collectionDestinationMatches(
  lowerer: Lowerer,
  input: CollectionInput,
  destination: Destination,
): boolean {
  if (destination.kind !== "map") return typeEquals(input.element, destination.elem);
  const shape = input.element.kind === "record" ? lowerer.shapes.get(input.element.shapeId) : null;
  const key = shape?.fields.find((field) => field.name === "0");
  const value = shape?.fields.find((field) => field.name === "1");
  return (
    !!shape?.tuple &&
    shape.fields.length === 2 &&
    !!key &&
    !!value &&
    typeEquals(key.type, destination.key) &&
    typeEquals(value.type, destination.value)
  );
}

export function lowerCollectionInput(lowerer: Lowerer, input: CollectionInput): IrExpr | null {
  const value = lowerer.lowerExpr(input.source);
  if (!input.collection) return value.type.kind === "dyn" ? value : null;
  const source = input.access
    ? (lowerer.runtimeOptionalPropertyReceiver(
        input.source,
        value,
        input.collection,
        input.selection,
      ) ?? value)
    : value;
  return typeEquals(source.type, input.collection) ? source : null;
}

/** Consume directly into the final storage. Native inputs use live slot
 * traversal; stored cursors acquire next once and retain protocol behavior.
 * Both paths retain element identity and clean up on callback exceptions. */
export function ingestCollection(
  lowerer: Lowerer,
  input: CollectionInput,
  source: IrExpr,
  destination: Destination,
  loc: SrcLoc,
  mapper?: IrExpr & { type: IrType & { kind: "func" } },
): IrExpr {
  if (
    !mapper &&
    input.collection &&
    destination.kind === "map" &&
    input.selection === "entries" &&
    typeEquals(input.collection, destination)
  ) {
    return {
      kind: "mapIntrinsic",
      method: "clone",
      receiver: source,
      args: [],
      type: destination,
      loc,
    };
  }
  if (!mapper && input.collection && destination.kind === "set" && input.selection !== "entries") {
    return input.collection.kind === "set"
      ? {
          kind: "setIntrinsic",
          method: "clone",
          receiver: source,
          args: [],
          type: destination,
          loc,
        }
      : {
          kind: "mapIntrinsic",
          method: input.selection === "keys" ? "keySet" : "valueSet",
          receiver: source,
          args: [],
          type: destination,
          loc,
        };
  }
  if (
    !mapper &&
    destination.kind === "array" &&
    input.collection?.kind === "set" &&
    input.selection !== "entries"
  ) {
    return {
      kind: "setIntrinsic",
      method: "toArray",
      receiver: source,
      args: [],
      type: destination,
      loc,
    };
  }
  const key = `ingest:${input.collection ? typeKey(input.collection) + ":" + input.selection : "cursor:" + typeKey(input.element)}:${typeKey(destination)}:${mapper ? typeKey(mapper.type) : "copy"}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%collection.ingest", key);
    lowerer.arrHofHelpers.set(key, name);
    const context = newFnCtx(false, null, null, destination);
    lowerer.fnStack.push(context);
    try {
      const params = [
        { localId: "source.0", name: "source", type: source.type },
        ...(mapper ? [{ localId: "mapper.0", name: "mapper", type: mapper.type }] : []),
      ];
      const locals: IrLocal[] = params.map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      }));
      const out = varRef("out.0", destination, loc);
      const index = varRef("index.0", F64, loc);
      locals.push(
        { id: "out.0", name: "out", type: destination, mutable: false },
        { id: "index.0", name: "index", type: F64, mutable: true },
      );
      const init: IrExpr =
        destination.kind === "array"
          ? { kind: "arrayLit", elems: [], type: destination, loc }
          : destination.kind === "map"
            ? { kind: "mapNew", type: destination, loc }
            : { kind: "setNew", type: destination, loc };
      const append = (value: IrExpr): IrStmt[] => {
        const inputLocal = mapper ? lowerer.declareHiddenLocal("%mappedValue", value.type) : null;
        const prefix: IrStmt[] = inputLocal
          ? [{ kind: "varDecl", localId: inputLocal.id, init: value, loc }]
          : [];
        const item: IrExpr = mapper
          ? {
              kind: "callValue",
              callee: varRef("mapper.0", mapper.type, loc),
              args: [varRef(inputLocal!.id, value.type, loc), index].slice(
                0,
                mapper.type.params.length,
              ),
              type: mapper.type.ret,
              loc,
            }
          : value;
        let store: IrStmt;
        if (destination.kind === "array")
          store = arrayValueStore(lowerer, out, index, item, destination.elem, loc);
        else if (destination.kind === "set")
          store = {
            kind: "exprStmt",
            expr: {
              kind: "setIntrinsic",
              method: "add",
              receiver: out,
              args: [item],
              type: VOID,
              loc,
            },
            loc,
          };
        else {
          if (item.type.kind === "dyn")
            return dynMapEntryStore(lowerer, out, item, destination, loc);
          if (item.type.kind !== "record")
            throw new InternalCompilerError("collection Map seed requires a tuple");
          const shapeId = item.type.shapeId;
          const local = lowerer.declareHiddenLocal("%entry", item.type);
          const entry = varRef(local.id, item.type, loc);
          return [
            { kind: "varDecl", localId: local.id, init: item, loc },
            {
              kind: "exprStmt",
              expr: {
                kind: "mapIntrinsic",
                method: "set",
                receiver: out,
                args: [
                  {
                    kind: "recordGet",
                    obj: entry,
                    shapeId,
                    field: "0",
                    type: destination.key,
                    loc,
                  },
                  {
                    kind: "recordGet",
                    obj: entry,
                    shapeId,
                    field: "1",
                    type: destination.value,
                    loc,
                  },
                ],
                type: VOID,
                loc,
              },
              loc,
            },
          ];
        }
        return [
          ...prefix,
          store,
          {
            kind: "assign",
            localId: "index.0",
            value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc },
            loc,
          },
        ];
      };
      const sourceRef = varRef("source.0", source.type, loc);
      const consumption = input.collection
        ? nativeConsumption(lowerer, input, sourceRef, destination, out, append, locals, loc)
        : cursorConsumption(
            lowerer,
            sourceRef,
            destination.kind === "map" ? DYN : input.element,
            append,
            destination.kind !== "array",
            loc,
          );
      lowerer.liftedFns.push({
        name,
        params,
        returnType: destination,
        locals: [...locals, ...context.locals],
        body: [
          { kind: "varDecl", localId: "out.0", init, loc },
          { kind: "varDecl", localId: "index.0", init: numLit(0, loc), loc },
          ...consumption,
          { kind: "return", value: out, loc },
        ],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return {
    kind: "call",
    callee: name,
    args: [source, ...(mapper ? [mapper] : [])],
    type: destination,
    loc,
  };
}

/** The `Map` seeding step for one checked-dynamic entry value. Node requires
 * an entry OBJECT (`dyn.mapSeedEntry` throws its TypeError for a primitive),
 * then reads "0" and "1" and converts both through the checked conversion.
 * The entry wrapper never becomes a value of its own. */
function dynMapEntryStore(
  lowerer: Lowerer,
  out: IrExpr,
  item: IrExpr,
  destination: IrType & { kind: "map" },
  loc: SrcLoc,
): IrStmt[] {
  const pair = lowerer.declareHiddenLocal("%entry", DYN);
  const key = lowerer.declareHiddenLocal("%entryKey", DYN);
  const value = lowerer.declareHiddenLocal("%entryValue", DYN);
  const member = (field: string): IrExpr => ({
    kind: "dynKeyGet",
    value: varRef(pair.id, DYN, loc),
    key: strLit(field, loc),
    type: DYN,
    loc,
  });
  const checked = (id: string, type: IrType): IrExpr =>
    type.kind === "dyn"
      ? varRef(id, DYN, loc)
      : { kind: "dynCheck", value: varRef(id, DYN, loc), preserveRefs: true, type, loc };
  return [
    {
      kind: "varDecl",
      localId: pair.id,
      init: { kind: "libCall", fn: "dyn.mapSeedEntry", args: [item], type: DYN, loc },
      loc,
    },
    { kind: "varDecl", localId: key.id, init: member("0"), loc },
    { kind: "varDecl", localId: value.id, init: member("1"), loc },
    {
      kind: "exprStmt",
      expr: {
        kind: "mapIntrinsic",
        method: "set",
        receiver: out,
        args: [checked(key.id, destination.key), checked(value.id, destination.value)],
        type: VOID,
        loc,
      },
      loc,
    },
  ];
}

/** `new Set<T>(source)` / `new Map<K, V>(source)` over a checked-dynamic
 * value: acquire the dynamic iterator once and add every value into native
 * storage, converting each Set element (and each Map entry's key and value)
 * through the checked conversion. Node's constructor rules apply: a nullish
 * source makes empty storage, a non-iterable throws V8's TypeError, a
 * non-object Map entry throws its entry TypeError, and a conversion failure
 * throws. Nothing is drained first, so an infinite iterator behaves as it
 * does in Node. */
export function dynCollectionSeed(
  lowerer: Lowerer,
  source: IrExpr,
  destination: Collection,
  loc: SrcLoc,
): IrExpr {
  const key = `dynSeed:${typeKey(destination)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%collection.dynSeed", key);
    lowerer.arrHofHelpers.set(key, name);
    const context = newFnCtx(false, null, null, destination);
    lowerer.fnStack.push(context);
    try {
      const params = [{ localId: "source.0", name: "source", type: DYN }];
      const sourceRef = varRef("source.0", DYN, loc);
      const out = lowerer.declareHiddenLocal("%dynSeedStorage", destination);
      const outRef = varRef(out.id, destination, loc);
      const empty: IrExpr =
        destination.kind === "map"
          ? { kind: "mapNew", type: destination, loc }
          : { kind: "setNew", type: destination, loc };
      const append =
        destination.kind === "set"
          ? (value: IrExpr): IrStmt[] => [
              {
                kind: "exprStmt",
                expr: {
                  kind: "setIntrinsic",
                  method: "add",
                  receiver: outRef,
                  args: [value],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ]
          : (value: IrExpr): IrStmt[] => dynMapEntryStore(lowerer, outRef, value, destination, loc);
      const consumption = cursorConsumption(
        lowerer,
        sourceRef,
        destination.kind === "map" ? DYN : destination.elem,
        append,
        true,
        loc,
        "",
      );
      lowerer.liftedFns.push({
        name,
        params,
        returnType: destination,
        locals: [{ id: "source.0", name: "source", type: DYN, mutable: false }, ...context.locals],
        body: [
          { kind: "varDecl", localId: out.id, init: empty, loc },
          {
            kind: "if",
            cond: { kind: "dynTest", test: "nullish", value: sourceRef, type: BOOL, loc },
            then: [{ kind: "return", value: outRef, loc }],
            else_: null,
            loc,
          },
          ...consumption,
          { kind: "return", value: outRef, loc },
        ],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return { kind: "call", callee: name, args: [source], type: destination, loc };
}

function nativeConsumption(
  lowerer: Lowerer,
  input: CollectionInput,
  source: IrExpr,
  destination: Destination,
  out: IrExpr,
  append: (value: IrExpr) => IrStmt[],
  locals: IrLocal[],
  loc: SrcLoc,
): IrStmt[] {
  const collection = input.collection!;
  const iter = (
    method: "iterCount" | "iterLive" | "iterKey" | "iterValue" | "iterEnter" | "iterExit",
    type: IrType,
  ): IrExpr => {
    const args =
      method === "iterKey" || method === "iterValue" || method === "iterLive"
        ? [varRef("i.0", F64, loc)]
        : [];
    if (collection.kind === "map")
      return { kind: "mapIntrinsic", method, receiver: source, args, type, loc };
    if (method === "iterValue")
      throw new InternalCompilerError("Set iteration has no separate value slot");
    return { kind: "setIntrinsic", method, receiver: source, args, type, loc };
  };
  const key = iter("iterKey", collection.kind === "map" ? collection.key : collection.elem);
  const value = collection.kind === "map" ? iter("iterValue", collection.value) : key;
  let visit: IrStmt[];
  if (destination.kind === "map" && input.selection === "entries" && collection.kind === "map") {
    // Consume entry fields directly instead of allocating a tuple that the
    // constructor immediately destructures and discards.
    visit = [
      {
        kind: "exprStmt",
        expr: {
          kind: "mapIntrinsic",
          method: "set",
          receiver: out,
          args: [key, value],
          type: VOID,
          loc,
        },
        loc,
      },
    ];
  } else if (input.selection === "entries") {
    const first = lowerer.declareHiddenLocal("%entryKey", key.type);
    const keyValue = varRef(first.id, key.type, loc);
    const pair: IrExpr = {
      kind: "recordLit",
      fields: [
        { name: "0", value: keyValue },
        { name: "1", value: collection.kind === "set" ? keyValue : value },
      ],
      type: input.element,
      loc,
    };
    visit = [{ kind: "varDecl", localId: first.id, init: key, loc }, ...append(pair)];
  } else visit = append(input.selection === "keys" ? key : value);
  locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
  return [
    { kind: "exprStmt", expr: iter("iterEnter", VOID), loc },
    {
      kind: "tryCatch",
      catchLocalId: null,
      catchBody: null,
      tryBody: [
        countedFor(loc, iter("iterCount", F64), () => [
          { kind: "if", cond: iter("iterLive", BOOL), then: visit, else_: null, loc },
        ]),
      ],
      finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", VOID), loc }],
      loc,
    },
  ];
}

function cursorConsumption(
  lowerer: Lowerer,
  source: IrExpr,
  element: IrType,
  append: (value: IrExpr) => IrStmt[],
  requireIterable: boolean,
  loc: SrcLoc,
  /** The TypeError text for a non-iterable source; the empty string uses
   * V8's runtime kind wording (the collection constructors' message). */
  iterableSpell = "Value is not iterable",
): IrStmt[] {
  const iterator = lowerer.declareHiddenLocal("%iterator", DYN);
  const next = lowerer.declareHiddenLocal("%next", DYN);
  const fast = lowerer.declareHiddenLocal("%nativeIterator", BOOL);
  const raw = lowerer.declareHiddenLocal("%iteratorValue", DYN);
  const done = lowerer.declareHiddenLocal("%done", BOOL);
  done.mutable = true;
  const get = (value: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet",
    value,
    key: strLit(key, loc),
    type: DYN,
    loc,
  });
  const cursor = varRef(iterator.id, DYN, loc);
  const value: IrExpr =
    element.kind === "dyn"
      ? varRef(raw.id, DYN, loc)
      : {
          kind: "dynCheck",
          value: varRef(raw.id, DYN, loc),
          type: element,
          preserveRefs: true,
          loc,
        };
  let body = append(value);
  {
    const error = lowerer.declareHiddenLocal("%iterationError", CAUGHT);
    const close = lowerer.declareHiddenLocal("%return", DYN);
    body = [
      {
        kind: "tryCatch",
        tryBody: body,
        catchLocalId: error.id,
        finallyBody: null,
        catchBody: [
          {
            kind: "tryCatch",
            catchLocalId: null,
            catchBody: [],
            finallyBody: null,
            tryBody: [
              { kind: "varDecl", localId: close.id, init: get(cursor, "return"), loc },
              {
                kind: "if",
                cond: {
                  kind: "dynTest",
                  test: "function",
                  value: varRef(close.id, DYN, loc),
                  type: BOOL,
                  loc,
                },
                then: [
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "dynCall",
                      callee: varRef(close.id, DYN, loc),
                      receiver: cursor,
                      calleeName: "iterator.return",
                      args: [],
                      type: DYN,
                      loc,
                    },
                    loc,
                  },
                ],
                else_: null,
                loc,
              },
            ],
            loc,
          },
          { kind: "rethrow", localId: error.id, loc },
        ],
        loc,
      },
    ];
  }
  return [
    {
      kind: "varDecl",
      localId: iterator.id,
      init: {
        kind: "libCall",
        fn: "dyn.iteratorResult",
        args: [
          {
            kind: "libCall",
            fn: requireIterable ? "dyn.iterator" : "dyn.arrayFromIterator",
            args: requireIterable ? [source, strLit(iterableSpell, loc)] : [source],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      },
      loc,
    },
    { kind: "varDecl", localId: next.id, init: get(cursor, "next"), loc },
    {
      kind: "varDecl",
      localId: fast.id,
      init: iteratorCanStep(cursor, varRef(next.id, DYN, loc), loc),
      loc,
    },
    { kind: "varDecl", localId: done.id, init: boolLit(false, loc), loc },
    {
      kind: "while",
      cond: { kind: "unary", op: "!", operand: varRef(done.id, BOOL, loc), type: BOOL, loc },
      body: [
        {
          kind: "varDecl",
          localId: raw.id,
          init: iteratorValue(
            lowerer,
            cursor,
            varRef(next.id, DYN, loc),
            varRef(fast.id, BOOL, loc),
            done,
            loc,
            "iterator.next",
          ),
          loc,
        },
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(done.id, BOOL, loc), type: BOOL, loc },
          then: [...body],
          else_: null,
          loc,
        },
      ],
      loc,
    },
  ];
}
