import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeEquals,
  UNDEFINED_T,
  VOID,
} from "../../ir/ir.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import { typeKey, genResultRecord } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { extractIteratorValue } from "./lower-generators.js";
import { lowerSafeIndexRead } from "./array-values.js";

/** The conversion into an iterator-typed slot (a generator type): a
 * checked-dynamic iterator or a generator with other channel types steps
 * through an interned adapter generator. Null when neither applies. */
export function iteratorSlotAdapter(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType & { kind: "generator" },
): IrExpr | null {
  if (expr.type.kind === "dyn") return dynIteratorAdapter(lowerer, expr, expected);
  if (expr.type.kind === "generator") return generatorRetypeAdapter(lowerer, expr, expected);
  return null;
}

/** `resumed.0 = value` — the adapters' early-exit marker around a yield. */
function setResumed(value: boolean, loc: SrcLoc): IrStmt {
  return {
    kind: "assign",
    localId: "resumed.0",
    value: { kind: "boolLit", value, type: BOOL, loc },
    loc,
  };
}

/** A yield expression's type: a valueless next channel resumes with void. */
function resumeType(nextT: IrType): IrType {
  return nextT.kind === "undefinedT" ? VOID : nextT;
}

/** Convert a stepped value into a channel type. Records and arrays box into
 * checked values by reference, so consumers observe the same objects. */
function intoChannel(lowerer: Lowerer, value: IrExpr, target: IrType): IrExpr | null {
  const coerced = lowerer.coerceToExpected(value, target);
  if (!typeEquals(coerced.type, target)) return null;
  if (
    coerced.kind === "dynFrom" &&
    streamTypedRefEligible(coerced.value.type) &&
    coerced.value.type.kind !== "bytes"
  )
    coerced.liveRef = true;
  return coerced;
}

/** A checked-dynamic iterator (a Map, Set or array iterator, or any other
 * object following the iterator protocol) flowing into a generator-typed
 * slot (`IterableIterator<T>`, `Iterator<T>`, `Generator<T>`). The interned
 * adapter is a generator over the source: each `next()` steps the source
 * once and forwards its value, so iteration stays lazy and observes the
 * collection live, exactly like the source iterator. Values convert into
 * the slot's channel types with the usual checked extraction. Null when
 * the slot is not a synchronous generator with a yielding channel. */
function dynIteratorAdapter(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType & { kind: "generator" },
): IrExpr | null {
  if (expected.async || expected.yieldT.kind === "void") return null;
  const resultType = genResultRecord(
    expected.yieldT,
    expected.retT,
    lowerer.shapes,
    lowerer.unions,
  );
  if (!resultType) return null;
  const loc = expr.loc;
  const key = `iterAdapt:${typeKey(expected)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = `%iter.adapt.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, name);
    const locals: IrLocal[] = [];
    const local = (id: string, type: IrType, mutable = false): IrExpr => {
      locals.push({ id, name: id.slice(0, id.indexOf(".")), type, mutable });
      return varRef(id, type, loc);
    };
    const source = local("source.0", DYN);
    const iterator = local("iterator.0", DYN);
    const next = local("next.0", DYN);
    const step = local("step.0", DYN, true);
    const forwards = expected.nextT.kind === "dyn";
    const sent = forwards ? local("sent.0", DYN, true) : null;
    const get = (value: IrExpr, field: string): IrExpr => ({
      kind: "dynKeyGet",
      value,
      key: { kind: "strLit", value: field, type: STRING, loc },
      type: DYN,
      loc,
    });
    const advance = (args: IrExpr[]): IrExpr => ({
      kind: "libCall",
      fn: "dyn.iteratorResult",
      args: [
        {
          kind: "dynCall",
          callee: next,
          receiver: iterator,
          calleeName: "iterator.next",
          args,
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    });
    const returned =
      expected.retT.kind === "void"
        ? null
        : intoChannel(lowerer, get(step, "value"), expected.retT);
    const yielded = (): IrExpr | null => intoChannel(lowerer, get(step, "value"), expected.yieldT);
    if ((expected.retT.kind !== "void" && !returned) || !yielded()) {
      lowerer.valueHelpers.delete(key);
      return null;
    }
    const finish: IrStmt = { kind: "return", value: returned, loc };
    // One suspension: yield the current value and take the resume value.
    const suspend = (): IrStmt => {
      const resumed: IrExpr = {
        kind: "yieldExpr",
        value: yielded()!,
        type: resumeType(expected.nextT),
        loc,
      };
      return sent
        ? { kind: "assign", localId: "sent.0", value: resumed, loc }
        : { kind: "exprStmt", expr: resumed, loc };
    };
    const resumedFlag = local("resumed.0", BOOL, true);
    const closer = local("closer.0", DYN);
    const stepOnce = (): IrStmt => ({
      kind: "assign",
      localId: "step.0",
      value: advance(sent ? [sent] : []),
      loc,
    });
    // An early exit from a consumer's loop closes the adapter. JS calls the
    // source's own return() then; a source without one (the native Map, Set
    // and array iterators) stays open, so the adapter suspends again on the
    // same value instead of completing, and later steps resume the source.
    const closeOrPark: IrStmt = {
      kind: "if",
      cond: { kind: "unary", op: "!", operand: resumedFlag, type: BOOL, loc },
      then: [
        { kind: "varDecl", localId: "closer.0", init: get(iterator, "return"), loc },
        {
          kind: "if",
          cond: { kind: "dynTest", test: "nullish", value: closer, type: BOOL, loc },
          then: [suspend(), stepOnce(), { kind: "continue", loc }],
          else_: [
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "dyn.iteratorResult",
                args: [
                  {
                    kind: "dynCall",
                    callee: closer,
                    receiver: iterator,
                    calleeName: "iterator.return",
                    args: [],
                    type: DYN,
                    loc,
                  },
                ],
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
      ],
      else_: null,
      loc,
    };
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "iterator.0",
        init: {
          kind: "libCall",
          fn: "dyn.iteratorResult",
          args: [
            {
              kind: "libCall",
              fn: "dyn.iterator",
              args: [source, { kind: "strLit", value: "value is not iterable", type: STRING, loc }],
              type: DYN,
              loc,
            },
          ],
          type: DYN,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "next.0", init: get(iterator, "next"), loc },
      { kind: "varDecl", localId: "step.0", init: advance([]), loc },
      ...(sent
        ? [{ kind: "varDecl" as const, localId: "sent.0", init: dynUndefinedExpr(loc), loc }]
        : []),
      {
        kind: "varDecl",
        localId: "resumed.0",
        init: { kind: "boolLit", value: false, type: BOOL, loc },
        loc,
      },
      {
        kind: "while",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        body: [
          {
            kind: "if",
            cond: { kind: "dynTest", test: "truthy", value: get(step, "done"), type: BOOL, loc },
            then: [finish],
            else_: null,
            loc,
          },
          setResumed(false, loc),
          {
            kind: "tryCatch",
            tryBody: [suspend(), setResumed(true, loc)],
            catchBody: null,
            catchLocalId: null,
            finallyBody: [closeOrPark],
            loc,
          },
          stepOnce(),
        ],
        loc,
      },
    ];
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "source.0", name: "source", type: DYN }],
      returnType: expected.retT,
      locals,
      body,
      generator: { yieldT: expected.yieldT, nextT: expected.nextT, resultType },
      loc,
    });
  }
  return { kind: "call", callee: name, args: [expr], type: expected, loc };
}

/** A generator flowing into a slot with other channel types (a
 * `Generator<number, void, undefined>` returned through an
 * `IterableIterator<number>` annotation). The interned adapter generator
 * resumes the source once per step and converts each value between the
 * channel types, so iteration stays lazy. Null when a channel has no
 * conversion. */
function generatorRetypeAdapter(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType & { kind: "generator" },
): IrExpr | null {
  const from = expr.type;
  if (from.kind !== "generator" || from.async || expected.async) return null;
  if (from.yieldT.kind === "void" || expected.yieldT.kind === "void") return null;
  const fromResult = genResultRecord(from.yieldT, from.retT, lowerer.shapes, lowerer.unions);
  const toResult = genResultRecord(expected.yieldT, expected.retT, lowerer.shapes, lowerer.unions);
  const fromShape = fromResult ? lowerer.shapes.get(fromResult.shapeId) : undefined;
  const valueT = fromShape?.fields.find((field) => field.name === "value")?.type;
  if (!fromResult || !toResult || !valueT) return null;
  const loc = expr.loc;
  const key = `genRetype:${typeKey(from)}:${typeKey(expected)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    const source = varRef("source.0", from, loc);
    const step = varRef("step.0", fromResult, loc);
    const field = (f: "value" | "done", type: IrType): IrExpr => ({
      kind: "recordGet",
      obj: step,
      shapeId: fromResult.shapeId,
      field: f,
      type,
      loc,
    });
    const extracted = extractIteratorValue(
      lowerer,
      from.yieldT,
      valueT,
      field("value", valueT),
      loc,
    );
    const yielded = extracted ? intoChannel(lowerer, extracted, expected.yieldT) : null;
    if (!yielded) return null;
    // The completion value: the source's return value, or undefined.
    let returned: IrExpr | null = null;
    if (expected.retT.kind !== "void") {
      returned =
        from.retT.kind === "void"
          ? intoChannel(
              lowerer,
              { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
              expected.retT,
            )
          : intoChannel(lowerer, field("value", valueT), expected.retT);
      if (!returned) return null;
    }
    // The resume value: forwarded when both sides carry one.
    const forwards = expected.nextT.kind !== "undefinedT" && from.nextT.kind !== "undefinedT";
    const sentRef = varRef("sent.0", expected.nextT, loc);
    const sent = forwards ? intoChannel(lowerer, sentRef, from.nextT) : null;
    if (forwards && !sent) return null;
    if (!forwards && from.nextT.kind !== "undefinedT" && from.nextT.kind !== "dyn") return null;
    const resume = (arg: IrExpr | null): IrExpr => ({
      kind: "genResume",
      mode: "next",
      gen: source,
      arg,
      type: fromResult,
      loc,
    });
    const resumed: IrExpr = {
      kind: "yieldExpr",
      value: yielded,
      type: resumeType(expected.nextT),
      loc,
    };
    name = `%gen.retype.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "source.0", name: "source", type: from }],
      returnType: expected.retT,
      locals: [
        { id: "source.0", name: "source", type: from, mutable: false },
        { id: "step.0", name: "step", type: fromResult, mutable: true },
        ...(forwards ? [{ id: "sent.0", name: "sent", type: expected.nextT, mutable: true }] : []),
        { id: "resumed.0", name: "resumed", type: BOOL, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "step.0", init: resume(null), loc },
        ...(forwards ? [{ kind: "varDecl" as const, localId: "sent.0", init: null, loc }] : []),
        {
          kind: "varDecl",
          localId: "resumed.0",
          init: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        },
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: [
            {
              kind: "if",
              cond: field("done", BOOL),
              then: [{ kind: "return", value: returned, loc }],
              else_: null,
              loc,
            },
            setResumed(false, loc),
            {
              kind: "tryCatch",
              tryBody: [
                forwards
                  ? { kind: "assign", localId: "sent.0", value: resumed, loc }
                  : { kind: "exprStmt", expr: resumed, loc },
                setResumed(true, loc),
              ],
              catchBody: null,
              catchLocalId: null,
              // Closing the adapter early closes the source generator too.
              finallyBody: [
                {
                  kind: "if",
                  cond: {
                    kind: "unary",
                    op: "!",
                    operand: varRef("resumed.0", BOOL, loc),
                    type: BOOL,
                    loc,
                  },
                  then: [
                    {
                      kind: "exprStmt",
                      expr: {
                        kind: "genResume",
                        mode: "return",
                        gen: source,
                        arg: null,
                        type: fromResult,
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
            { kind: "assign", localId: "step.0", value: resume(sent), loc },
          ],
          loc,
        },
      ],
      generator: { yieldT: expected.yieldT, nextT: expected.nextT, resultType: toResult },
      loc,
    });
  }
  return { kind: "call", callee: name, args: [expr], type: expected, loc };
}

/** Drain a synchronous generator into a fresh `elem[]` — the eager
 * consumers of an iterator (`[...it]`, `Array.from(it)`). Each step resumes
 * the generator once and appends its value; completion stops the drain
 * without appending the return value, as in JS. Null when the yielded
 * values cannot be extracted into the element type. */
export function generatorDrain(
  lowerer: Lowerer,
  source: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr | null {
  const gen = source.type;
  if (gen.kind !== "generator" || gen.async || gen.yieldT.kind === "void") return null;
  const resultType = genResultRecord(gen.yieldT, gen.retT, lowerer.shapes, lowerer.unions);
  const shape = resultType ? lowerer.shapes.get(resultType.shapeId) : undefined;
  const valueT = shape?.fields.find((field) => field.name === "value")?.type;
  if (!resultType || !valueT) return null;
  const arrT: IrType = { kind: "array", elem };
  const key = `genDrain:${typeKey(gen)}:${typeKey(elem)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    const genRef = varRef("gen.0", gen, loc);
    const outRef = varRef("out.0", arrT, loc);
    const stepRef = varRef("step.0", resultType, loc);
    const raw = extractIteratorValue(
      lowerer,
      gen.yieldT,
      valueT,
      {
        kind: "recordGet",
        obj: stepRef,
        shapeId: resultType.shapeId,
        field: "value",
        type: valueT,
        loc,
      },
      loc,
    );
    if (!raw) return null;
    const value = lowerer.coerceToExpected(raw, elem);
    if (!typeEquals(value.type, elem)) return null;
    name = `%gen.drain.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "gen.0", name: "gen", type: gen }],
      returnType: arrT,
      locals: [
        { id: "gen.0", name: "gen", type: gen, mutable: false },
        { id: "out.0", name: "out", type: arrT, mutable: false },
        { id: "step.0", name: "step", type: resultType, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: arrT, loc },
          loc,
        },
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: [
            {
              kind: "varDecl",
              localId: "step.0",
              init: {
                kind: "genResume",
                mode: "next",
                gen: genRef,
                arg: null,
                type: resultType,
                loc,
              },
              loc,
            },
            {
              kind: "if",
              cond: {
                kind: "recordGet",
                obj: stepRef,
                shapeId: resultType.shapeId,
                field: "done",
                type: BOOL,
                loc,
              },
              then: [{ kind: "break", loc }],
              else_: null,
              loc,
            },
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: outRef,
                args: [value],
                type: F64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: outRef, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [source], type: arrT, loc };
}

/** `list.values()`, `list.keys()` and `list.entries()` as values: a
 * generator over the live array. Each step compares the index with the
 * current length and reads the current element, so elements appended
 * during iteration are visited and completion is final, as with the
 * native array iterator. `type` is the call's generator type. */
export function lowerArrayIteratorValue(
  lowerer: Lowerer,
  receiver: IrExpr,
  method: "values" | "keys" | "entries",
  type: IrType,
  loc: SrcLoc,
): IrExpr | null {
  const arrT = receiver.type;
  if (arrT.kind !== "array" || type.kind !== "generator") return null;
  const resultType = genResultRecord(type.yieldT, type.retT, lowerer.shapes, lowerer.unions);
  if (!resultType || type.retT.kind !== "void" || type.nextT.kind !== "undefinedT") return null;
  const tuple = type.yieldT.kind === "record" ? lowerer.shapes.get(type.yieldT.shapeId) : undefined;
  if (method === "entries" && (!tuple?.tuple || tuple.fields.length !== 2)) return null;
  const key = `arrIter:${method}:${typeKey(arrT)}:${typeKey(type)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    const list = varRef("list.0", arrT, loc);
    const index = varRef("index.0", F64, loc);
    const element = (): IrExpr | null => {
      const read = lowerSafeIndexRead(lowerer, list, index, loc);
      if (!read) return null;
      const target =
        method === "values" ? type.yieldT : tuple!.fields.find((f) => f.name === "1")!.type;
      const value = lowerer.coerceToExpected(read, target);
      return typeEquals(value.type, target) ? value : null;
    };
    let yielded: IrExpr | null;
    if (method === "keys") yielded = index;
    else if (method === "values") yielded = element();
    else {
      const value = element();
      yielded =
        value === null
          ? null
          : {
              kind: "recordLit",
              fields: [
                { name: "0", value: index },
                { name: "1", value },
              ],
              type: type.yieldT,
              loc,
            };
    }
    if (!yielded || !typeEquals(yielded.type, type.yieldT)) return null;
    name = `%arr.iter.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "list.0", name: "list", type: arrT }],
      returnType: VOID,
      locals: [
        { id: "list.0", name: "list", type: arrT, mutable: false },
        { id: "index.0", name: "index", type: F64, mutable: true },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "index.0",
          init: { kind: "numLit", value: 0, type: F64, loc },
          loc,
        },
        {
          kind: "while",
          cond: {
            kind: "bin",
            op: "<",
            left: index,
            right: {
              kind: "arrIntrinsic",
              method: "length",
              receiver: list,
              args: [],
              type: F64,
              loc,
            },
            type: BOOL,
            loc,
          },
          body: [
            { kind: "exprStmt", expr: { kind: "yieldExpr", value: yielded, type: VOID, loc }, loc },
            {
              kind: "assign",
              localId: "index.0",
              value: {
                kind: "bin",
                op: "+",
                left: index,
                right: { kind: "numLit", value: 1, type: F64, loc },
                type: F64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: null, loc },
      ],
      generator: { yieldT: type.yieldT, nextT: UNDEFINED_T, resultType },
      loc,
    });
  }
  return { kind: "call", callee: name, args: [receiver], type, loc };
}
