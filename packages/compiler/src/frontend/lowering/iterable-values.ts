/* `Iterable<T>` values. The type maps to the iterable union
 * (type-mapper.ts iterableUnionType): an array, Set, Map or string keeps
 * its own arm, so the value stays the same multi-pass object (identity,
 * inspection and typeof are the source's own), and every iterator — a
 * generator, an array, Map or Set iterator, a checked-dynamic iterator —
 * enters the generator arm, single-pass as in JavaScript.
 *
 * Consumers open an iterator over the current arm the way for-of's
 * GetIterator does: an array, Set, Map or string arm starts a fresh live
 * walk (the sources' own iterator helpers), the generator arm is itself.
 * for-of gives the array arm its own array loop, so iterating an Iterable
 * that holds an array runs at array-loop speed. */
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { varRef, numLit } from "../../ir/build.js";
import {
  BOOL,
  F64,
  iterableArmsElem,
  typeEquals,
  type IrExpr,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { typeKey } from "../type-mapper.js";
import { keyedHelperName } from "./stable-names.js";
import { PoisonError, type Lowerer } from "./lowerer.js";
import { noLoweringDiag, unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { generatorLoopBinding, lowerForOfGenerator, type GenType } from "./lower-generators.js";
import {
  iteratorSlotAdapter,
  lowerArrayIteratorValue,
  lowerCollectionIteratorValue,
  lowerStringIteratorValue,
} from "./iterator-adapters.js";
import { arrayValueRead, arrayValueType } from "./array-values.js";

/** An iterable union and the tags of its arms. */
export interface IterableUnion {
  unionId: string;
  type: IrType & { kind: "union" };
  elem: IrType;
  arms: readonly IrType[];
  /** The generator arm: a sync generator over `elem`. */
  gen: GenType;
}

/** The iterable union `t` names, or null. */
export function iterableUnionOf(lowerer: Lowerer, t: IrType): IterableUnion | null {
  const info = iterableSlotUnionOf(lowerer, t);
  // An optional Iterable (`Iterable<T> | undefined`) is consumed only once
  // narrowed to the iterable union itself.
  if (info === null || info.arms.some((arm) => arm.kind === "undefinedT" || arm.kind === "nullT"))
    return null;
  return info;
}

/** The iterable union `t` names, also an optional or nullable one
 * (`Iterable<T> | undefined`, whose unit arms sit beside the iterable
 * arms), or null. */
function iterableSlotUnionOf(lowerer: Lowerer, t: IrType): IterableUnion | null {
  if (t.kind !== "union") return null;
  const arms = lowerer.unions.get(t.unionId)?.arms;
  if (!arms) return null;
  const elem = iterableArmsElem(arms);
  if (elem === null) return null;
  const gen = arms.find((arm) => arm.kind === "generator") as GenType;
  return { unionId: t.unionId, type: t, elem, arms, gen };
}

/** The generator arm of an iterable union (what a generator function
 * declared to return Iterable<T> returns), or `t` itself. */
export function iterableGeneratorArm(lowerer: Lowerer, t: IrType): IrType {
  return iterableUnionOf(lowerer, t)?.gen ?? t;
}

/** A value flowing into an iterable-typed slot, optional or nullable
 * ones included: a source arm wraps as itself; a generator over other
 * channel types or a checked-dynamic iterator (a Map or Set iterator)
 * adapts into the generator arm. Null when neither applies, leaving the
 * ordinary conversion fences to refuse other sources (class iterables,
 * typed arrays, other element types). */
export function iterableSlotValue(lowerer: Lowerer, expr: IrExpr, expected: IrType): IrExpr | null {
  const info = iterableSlotUnionOf(lowerer, expected);
  if (info === null || expr.type.kind === "union") return null;
  const wrap = (value: IrExpr): IrExpr => ({
    kind: "unionWrap",
    unionId: info.unionId,
    tag: lowerer.armTag(info.unionId, value.type),
    value,
    type: info.type,
    loc: expr.loc,
  });
  if (lowerer.armTag(info.unionId, expr.type) >= 0) return wrap(expr);
  if (expr.type.kind === "generator" || expr.type.kind === "dyn") {
    const adapted = iteratorSlotAdapter(lowerer, expr, info.gen);
    if (adapted && typeEquals(adapted.type, info.gen)) return wrap(adapted);
  }
  // Class instances (their own [Symbol.iterator]) and typed arrays have no
  // arm: refuse them here, by name.
  if (expr.type.kind === "object" || expr.type.kind === "bytes") {
    lowerer.pushDiag(
      unsupportedDiag(
        "SC1090",
        expr.loc,
        `an Iterable<${lowerer.fmt(info.elem)}> holding a '${lowerer.fmt(expr.type)}' (an Iterable value holds an array, Set, Map, string, or iterator)`,
      ),
    );
    throw new PoisonError();
  }
  return null;
}

/** GetIterator on an iterable union value: an interned helper answering a
 * generator over the current arm — a fresh live walk of an array, Set, Map
 * or string, or the generator arm itself. */
export function iterableGenerator(lowerer: Lowerer, value: IrExpr, info: IterableUnion): IrExpr {
  const loc = value.loc;
  const key = `iterableOf:${typeKey(info.type)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    const u = varRef("u.0", info.type, loc);
    const body: IrStmt[] = [];
    let genTag = -1;
    info.arms.forEach((arm, tag) => {
      if (arm.kind === "generator") {
        genTag = tag;
        return;
      }
      const narrowed: IrExpr = {
        kind: "unionNarrow",
        unionId: info.unionId,
        tag,
        value: u,
        type: arm,
        loc,
      };
      const walk =
        arm.kind === "array"
          ? lowerArrayIteratorValue(lowerer, narrowed, "values", info.gen, loc)
          : arm.kind === "set"
            ? lowerCollectionIteratorValue(lowerer, narrowed, "values", info.gen, loc)
            : arm.kind === "map"
              ? lowerCollectionIteratorValue(lowerer, narrowed, "entries", info.gen, loc)
              : arm.kind === "string"
                ? lowerStringIteratorValue(lowerer, narrowed, info.gen, loc)
                : null;
      if (walk === null || !typeEquals(walk.type, info.gen)) {
        lowerer.pushDiag(
          noLoweringDiag(
            `iterating an Iterable<${lowerer.fmt(info.elem)}> that holds a ${arm.kind}`,
            loc,
          ),
        );
        throw new PoisonError();
      }
      body.push({
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: info.unionId,
          tag,
          negated: false,
          value: u,
          type: BOOL,
          loc,
        },
        then: [{ kind: "return", value: walk, loc }],
        else_: null,
        loc,
      });
    });
    body.push({
      kind: "return",
      value: {
        kind: "unionNarrow",
        unionId: info.unionId,
        tag: genTag,
        value: u,
        type: info.gen,
        loc,
      },
      loc,
    });
    name = keyedHelperName(lowerer, "%iterable.of", key);
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: info.type }],
      returnType: info.gen,
      locals: [{ id: "u.0", name: "u", type: info.type, mutable: false }],
      body,
      loc,
    });
  }
  return { kind: "call", callee: name, args: [value], type: info.gen, loc };
}

/** Whether a loop body declares a class (a class has one lowering per
 * declaration, so its body cannot lower twice). */
function declaresClass(body: ts.Statement): boolean {
  let found = false;
  ts.walkPreorder(body, (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** `for (x of iterable)` over an iterable union:
 *
 *   { const %src = <iterable>;
 *     if (%src is the array arm) {
 *       const %arr = <array arm>;
 *       for (let %cur = 0; %cur < %arr.length; %cur++) { const x = %arr[%cur]; <body> }
 *     } else {
 *       for (const x of GetIterator(%src)) <body>     // the generator for-of
 *     }
 *   }
 *
 * The array arm walks exactly like an array for-of (live length, the
 * backend's dense-array loop forms), so an Iterable holding an array
 * iterates at array speed; every other arm drives its iterator with the
 * generator for-of's IteratorClose rules. The body lowers once for each
 * loop; a body that declares a class lowers only once, in the generator
 * for-of over every arm. */
export function lowerForOfIterable(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr,
  info: IterableUnion,
  labels?: string[],
): IrStmt {
  const loc = locOf(stmt);
  const generatorLoop = (source: IrExpr): IrStmt =>
    lowerForOfGenerator(
      lowerer,
      stmt,
      iterableGenerator(lowerer, source, info) as IrExpr & { type: GenType },
      labels,
    );
  const arrayTag = info.arms.findIndex((arm) => arm.kind === "array");
  // A union without an array arm (`Set<T> | Generator<T>`) has only the
  // generator loop.
  if (stmt.awaitModifier || declaresClass(stmt.statement) || arrayTag < 0)
    return generatorLoop(iterable);
  const arrT = info.arms[arrayTag]!;
  lowerer.scopes.push(new Map());
  try {
    const src = lowerer.declareHiddenLocal("%iterableSource", info.type);
    const srcRef = (): IrExpr => varRef(src.id, info.type, loc);
    const arr = lowerer.declareHiddenLocal("%arrayIterator", arrT);
    const cursor = lowerer.declareHiddenLocal("%arrayCursor", F64);
    cursor.mutable = true;
    const arrRef = varRef(arr.id, arrT, loc);
    const curRef = varRef(cursor.id, F64, loc);
    // The element: a hole reads undefined, which an undefined-armed T
    // holds; for other element types the read traps, as typed reads do.
    const element: IrExpr = typeEquals(arrayValueType(lowerer, info.elem), info.elem)
      ? arrayValueRead(lowerer, arrRef, curRef, info.elem, loc)
      : { kind: "arrayGet", arr: arrRef, index: curRef, type: info.elem, loc };
    const arrayLoop = ((): IrStmt => {
      lowerer.scopes.push(new Map());
      try {
        const binding = generatorLoopBinding(lowerer, stmt, element, info.elem);
        const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement), labels);
        return {
          kind: "for",
          init: { kind: "varDecl", localId: cursor.id, init: numLit(0, loc), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: curRef,
            right: {
              kind: "arrIntrinsic",
              method: "length",
              receiver: arrRef,
              args: [],
              type: F64,
              loc,
            },
            type: BOOL,
            loc,
          },
          update: {
            kind: "assign",
            localId: cursor.id,
            value: { kind: "bin", op: "+", left: curRef, right: numLit(1, loc), type: F64, loc },
            loc,
          },
          body: [...binding, ...body],
          ...(labels && { labels }),
          loc,
        };
      } finally {
        lowerer.scopes.pop();
      }
    })();
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: src.id, init: iterable, loc },
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: info.unionId,
            tag: arrayTag,
            negated: false,
            value: srcRef(),
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "varDecl",
              localId: arr.id,
              init: {
                kind: "unionNarrow",
                unionId: info.unionId,
                tag: arrayTag,
                value: srcRef(),
                type: arrT,
                loc,
              },
              loc,
            },
            arrayLoop,
          ],
          else_: [generatorLoop(srcRef())],
          loc,
        },
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}
