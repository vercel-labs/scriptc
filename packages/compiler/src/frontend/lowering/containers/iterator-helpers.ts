import { keyedHelperName } from "../stable-names.js";
import { boolLit, numLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  type IrMapIntrinsicMethod,
  type IrSetIntrinsicMethod,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import { genResultRecord, typeKey } from "../../type-mapper.js";
import { concatStrings, throwTypeError } from "./dynamic-receivers.js";
import {
  type GenType,
  generatorLoopBinding,
  resultRecordOf,
  genStep,
  genValue,
  stepDrivable,
} from "../lower-generators.js";
import { classGeneratorIterable, iteratesThroughGenerator } from "../class-iterables.js";
import { exitBeforeReturns } from "./for-of.js";
import {
  iteratorSlotAdapter,
  lowerArrayIteratorValue,
  lowerBytesIteratorValue,
  lowerCollectionIteratorValue,
  lowerStringIteratorValue,
} from "../iterator-adapters.js";
import { lowerArrayCallback } from "./callback-arguments.js";

/* ── iterator helpers (ES2025) ─────────────────────────────────────────── */

/** The lowered iterator-helper chains: `arr.values()` (the array
 * iterator) through any run of map/filter/take/drop/flatMap into a
 * consuming terminal (toArray/forEach/reduce/some/every/find), FUSED
 * into one per-element loop — which IS the helpers' lazy pull order:
 * each source element flows through every stage before the next is
 * touched, take closes the pipeline without pulling upstream again
 * (budget checked before delivery), and short-circuit terminals stop
 * the walk at their hit. Stage callbacks take (value) or (value,
 * counter) — counters count each stage's own input stream, per spec.
 * take/drop budgets validate eagerly AT THE CALL (Node's RangeError,
 * raw value in the message) through an interned checker call inserted
 * at the argument's evaluation position. The source array is iterated
 * LIVE by index against a re-read length, exactly the array iterator's
 * contract. Chains over generators and other iterator objects lower in
 * lowerGeneratorHelperCall. Null when the callee isn't a terminal over
 * such a chain. */
export function lowerIteratorHelperCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const terminal = access.name.text;
  if (!ITER_TERMINALS.has(terminal)) return null;
  // Walk receiver: stage* ← values()/entries() ← array-typed source
  // (entries seeds the chain with [index, element] pairs — the
  // checker's own tuple type).
  const stages: StageNode[] = [];
  let cur: ts.Expression = access.expression;
  let source: ts.Expression | null = null;
  let srcProj: "values" | "entries" = "values";
  for (;;) {
    if (!ts.isCallExpression(cur) || !ts.isPropertyAccessExpression(cur.expression)) return null;
    if (cur.questionDotToken || cur.expression.questionDotToken) return null;
    const name = cur.expression.name.text;
    if ((name === "values" || name === "entries") && cur.arguments.nodes.length === 0) {
      const recvIr = lowerer.mapTypeOf(lowerer.typeOf(cur.expression.expression));
      if (recvIr?.kind !== "array") return null;
      if (!lowerer.isStdlibMember(cur.expression)) return null;
      source = cur.expression.expression;
      srcProj = name;
      break;
    }
    if (
      !ITER_STAGES.has(name) ||
      cur.arguments.nodes.length !== 1 ||
      ts.isSpreadElement(cur.arguments.nodes[0]!)
    )
      return null;
    stages.push({ name, argNode: cur.arguments.nodes[0]!, access: cur.expression });
    cur = cur.expression.expression;
  }
  stages.reverse(); // source order
  for (const s of stages) {
    if (!lowerer.isStdlibMember(s.access)) return null;
  }
  if (!lowerer.isStdlibMember(access)) return null;
  // Lower everything in SOURCE ORDER (the chain's own evaluation
  // order): the source array, each stage argument, the terminal's.
  const items = lowerer.lowerExpr(source);
  if (items.type.kind !== "array") return null;
  // The entries() seed: the interned [number, T] tuple — the same shape
  // the checker's own [number, T] maps to, so stage callbacks typed
  // against the lib's pairs intern equal.
  const elem: IrType =
    srcProj === "entries" ? entryPairType(lowerer, items.type.elem) : items.type.elem;
  return lowerFusedChain(
    lowerer,
    call,
    terminal,
    stages,
    { kind: "array", type: items.type, proj: srcProj },
    items,
    elem,
  );
}

/** Iterator-helper calls whose receiver is an iterator object: a
 * generator, a stored array iterator, a helper result (IteratorObject),
 * an `Iterator<T>` value, or a Map/Set iterator (adapted into a
 * generator over the live collection).
 *
 * - A terminal (toArray/forEach/reduce/some/every/find) fuses the chain
 *   of helper stages before it into one loop over the source generator,
 *   with the helpers' pull order and closing: the source is closed (its
 *   `return()` runs) when take's budget is spent, a short-circuit
 *   terminal hits, or a callback throws, and is not closed when it is
 *   exhausted or its own `next()` throws.
 * - A stage (map/filter/take/drop/flatMap) outside such a chain builds
 *   an iterator helper object: a generator over its source that pulls
 *   lazily, closes the source on early exit, and closes it on a
 *   `return()` before the first `next()` (`closesSource`).
 *
 * Budgets and callbacks validate at the call, as in Node. Null when the
 * call is not such a helper call. */
export function lowerGeneratorHelperCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const name = access.name.text;
  const isTerminal = ITER_TERMINALS.has(name);
  if (!isTerminal && !ITER_STAGES.has(name)) return null;
  if (!isHelperReceiver(lowerer, access.expression)) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  if (!isTerminal) {
    const argNode = call.arguments.nodes[0];
    if (call.arguments.nodes.length !== 1 || argNode === undefined || ts.isSpreadElement(argNode)) {
      lowerer.noLowering(`.${name} with ${call.arguments.nodes.length} arguments`, call);
    }
    // A stage on m.keys()/values()/entries() (or a Set's) walks the
    // collection inside the helper's own generator.
    const collection = collectionIteratorCall(lowerer, access.expression);
    if (collection !== null) {
      const coll = lowerer.lowerExpr(collection.receiver);
      if (coll.type.kind !== "map" && coll.type.kind !== "set")
        lowerer.badType(collection.receiver, lowerer.typeOf(collection.receiver));
      const source: ChainSource = { kind: "collection", type: coll.type, proj: collection.proj };
      const elem = collectionSeed(lowerer, source);
      const { stage, out } = lowerStage(lowerer, { name, argNode, access }, elem, loc);
      return lowerHelperObject(lowerer, call, coll, source, elem, stage, out, loc);
    }
    const src = lowerHelperSource(lowerer, access.expression);
    if (name !== "take" && name !== "drop") {
      const { stage, out } = lowerStage(lowerer, { name, argNode, access }, src.elem, loc);
      return lowerHelperObject(
        lowerer,
        call,
        src.gen,
        { kind: "generator", type: src.gen.type, elem: src.elem },
        src.elem,
        stage,
        out,
        loc,
      );
    }
    // The budget check closes the source, so the source is bound first.
    const bound = bindSource(lowerer, src.gen, loc);
    const { stage, out } = lowerStage(lowerer, { name, argNode, access }, src.elem, loc, bound.ref);
    const helper = lowerHelperObject(
      lowerer,
      call,
      bound.ref,
      { kind: "generator", type: src.gen.type, elem: src.elem },
      src.elem,
      stage,
      out,
      loc,
    );
    return { kind: "seqExpr", stmts: [bound.decl], result: helper, type: helper.type, loc };
  }
  // The stages before the terminal, back to the first receiver that is
  // not itself a helper stage.
  const stages: StageNode[] = [];
  let cur: ts.Expression = access.expression;
  while (isStageCall(lowerer, cur)) {
    const stageAccess = cur.expression as ts.PropertyAccessExpression;
    stages.push({
      name: stageAccess.name.text,
      argNode: cur.arguments.nodes[0]!,
      access: stageAccess,
    });
    cur = stageAccess.expression;
  }
  stages.reverse(); // source order
  // A chain from m.keys()/values()/entries() (or a Set's) walks the
  // collection itself, live, as for-of does.
  const collection = collectionIteratorCall(lowerer, cur);
  if (collection !== null) {
    const items = lowerer.lowerExpr(collection.receiver);
    if (items.type.kind !== "map" && items.type.kind !== "set")
      lowerer.badType(collection.receiver, lowerer.typeOf(collection.receiver));
    const source: ChainSource = { kind: "collection", type: items.type, proj: collection.proj };
    return lowerFusedChain(
      lowerer,
      call,
      name,
      stages,
      source,
      items,
      collectionSeed(lowerer, source),
    );
  }
  // Iterator.from(arr) walks the array by index.
  const arrayRoot = arrayIteratorCall(lowerer, cur);
  if (arrayRoot !== null) {
    const items = lowerer.lowerExpr(arrayRoot.receiver);
    if (items.type.kind !== "array")
      lowerer.badType(arrayRoot.receiver, lowerer.typeOf(arrayRoot.receiver));
    const elem =
      arrayRoot.proj === "entries" ? entryPairType(lowerer, items.type.elem) : items.type.elem;
    return lowerFusedChain(
      lowerer,
      call,
      name,
      stages,
      { kind: "array", type: items.type, proj: arrayRoot.proj },
      items,
      elem,
    );
  }
  const src = lowerHelperSource(lowerer, cur);
  return lowerFusedChain(
    lowerer,
    call,
    name,
    stages,
    { kind: "generator", type: src.gen.type, elem: src.elem },
    src.gen,
    src.elem,
  );
}

/** `h.return!()` or `h.return?.()` on a helper object. The lib declares
 * return() as optional on iterator objects, and a helper object always
 * has one, so both spellings are the call: the helper completes and closes
 * its source, and the result is `{ value: undefined, done: true }`. The
 * receiver must be provably a helper object — a helper stage call, or a
 * const binding initialized with one — since other iterator objects (the
 * array, string, Map and Set iterators) have no return(). Null otherwise,
 * and for the plain `h.return()` spelling (lowerGenMethodCall's). */
export function lowerHelperReturnCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  let callee: ts.Expression = call.expression;
  const nonNull = ts.isNonNullExpression(callee);
  if (nonNull) callee = (callee as ts.NonNullExpression).expression;
  if (!nonNull && call.questionDotToken === undefined) return null;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return null;
  if (callee.name.text !== "return" || call.arguments.nodes.length !== 0) return null;
  if (!isHelperObject(lowerer, callee.expression) || !lowerer.isStdlibMember(callee)) return null;
  const callT = lowerer.mapTypeOf(lowerer.typeOf(call));
  const gen = lowerer.lowerExpr(callee.expression);
  if (gen.type.kind !== "generator" || gen.type.async) return null;
  const loc = locOf(call);
  const recT = resultRecordOf(lowerer, gen.type);
  const resume: IrExpr = { kind: "genResume", mode: "return", gen, arg: null, type: recT, loc };
  // `?.` types the call `IteratorResult | undefined`, which has no mapping
  // as a whole; the result is never undefined, so it is the record itself.
  if (callT === null || typeEquals(callT, recT)) return resume;
  const result = lowerer.coerceToExpected(resume, callT);
  if (!typeEquals(result.type, callT)) lowerer.badType(call, lowerer.typeOf(call));
  return result;
}

/** Whether `expr` is a helper stage call, or a const binding initialized
 * with one. */
function isHelperObject(lowerer: Lowerer, expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (isStageCall(lowerer, expr)) return true;
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  const decl = symbol ? symbol.valueDeclaration : undefined;
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  return isStageCall(lowerer, init);
}

/** `Iterator.from(value)` over a typed built-in iterable: the value's own
 * iterator, which already inherits from Iterator.prototype, so Node returns
 * it rather than a wrapper. A generator (including a helper object or an
 * array iterator) is itself; an array, string or typed array gives its
 * values iterator; a Set its values and a Map its entries, as a generator
 * over the live collection; a class instance whose `[Symbol.iterator]` is
 * a generator method gives the generator it returns. The result converts
 * into the call's IteratorObject type. Null for other arguments (objects
 * with their own next method, untyped values), which keep the Iterator
 * fence. */
export function lowerIteratorFromCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "from" || call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
  if (ts.isSpreadElement(argNode)) return null;
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  const argT = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  if (resultT?.kind !== "generator" || resultT.async || argT === null) return null;
  const iterableKinds = ["generator", "array", "string", "bytes", "set", "map"];
  const classIterable = iteratesThroughGenerator(lowerer, argT);
  if (!classIterable && !iterableKinds.includes(argT.kind)) return null;
  if (argT.kind === "generator" && argT.async) return null;
  const loc = locOf(call);
  const value = lowerer.lowerExpr(argNode);
  const own = (yieldT: IrType): GenType => ({
    kind: "generator",
    yieldT,
    retT: VOID,
    nextT: UNDEFINED_T,
  });
  let iterator: IrExpr | null = null;
  const t = value.type;
  if (t.kind === "generator") iterator = value;
  else if (classIterable) iterator = classGeneratorIterable(lowerer, value);
  else if (t.kind === "array")
    iterator = lowerArrayIteratorValue(lowerer, value, "values", own(t.elem), loc);
  else if (t.kind === "string")
    iterator = lowerStringIteratorValue(lowerer, value, own(STRING), loc);
  else if (t.kind === "bytes")
    iterator = lowerBytesIteratorValue(lowerer, value, "values", own(F64), loc);
  else if (t.kind === "set" || t.kind === "map") {
    const elem = t.kind === "set" ? t.elem : entryPairTypeOf(lowerer, t.key, t.value);
    iterator = lowerCollectionIteratorValue(
      lowerer,
      value,
      t.kind === "set" ? "values" : "entries",
      own(elem),
      loc,
    );
  }
  if (iterator === null) lowerer.badType(argNode, lowerer.typeOf(argNode));
  const result = lowerer.coerceToExpected(iterator, resultT);
  if (!typeEquals(result.type, resultT)) lowerer.badType(call, lowerer.typeOf(call));
  return result;
}

/** The interned [K, V] pair a Map's entries yield. */
function entryPairTypeOf(lowerer: Lowerer, keyT: IrType, valueT: IrType): IrType {
  return {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "0", type: keyT },
        { name: "1", type: valueT },
      ],
      true,
    ),
  };
}

const ITER_STAGES = new Set(["map", "filter", "take", "drop", "flatMap"]);
const ITER_TERMINALS = new Set(["toArray", "forEach", "reduce", "some", "every", "find"]);
/** Native iterators that ride checked runtime values and adapt into
 * generators for the helpers. */
const ADAPTED_ITERATOR_TYPES = new Set(["MapIterator", "SetIterator"]);

/** `for (x of <chain>)` where the head is a run of map/filter/take/drop
 * stages over an array iterator, a Map or Set iterator, or a generator:
 * one loop over the source with the stages nested in it and the loop body
 * innermost, instead of a helper object per stage. The pull order and the
 * closing are the helpers': `break`, `return` and throws from the body
 * close a generator source (run its `return()`), and take closes it on
 * the pass after its last delivery. Chains with flatMap keep the helper
 * objects (a `break` there leaves an inner loop). Null when the head is
 * not such a chain. */
export function lowerForOfHelperChain(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  labels: string[] | undefined,
): IrStmt | null {
  if (stmt.awaitModifier) return null;
  if (
    ts.isVariableDeclarationList(stmt.initializer) &&
    (stmt.initializer.flags & ts.NodeFlags.Using) !== 0
  )
    return null;
  let head: ts.Expression = stmt.expression;
  while (ts.isParenthesizedExpression(head)) head = head.expression;
  const stages: StageNode[] = [];
  let cur: ts.Expression = head;
  while (isStageCall(lowerer, cur)) {
    const stageAccess = cur.expression as ts.PropertyAccessExpression;
    if (stageAccess.name.text === "flatMap") return null;
    stages.push({
      name: stageAccess.name.text,
      argNode: cur.arguments.nodes[0]!,
      access: stageAccess,
    });
    cur = stageAccess.expression;
  }
  if (stages.length === 0) return null;
  stages.reverse(); // source order
  const arrayRoot = arrayIteratorCall(lowerer, cur);
  const collection = arrayRoot === null ? collectionIteratorCall(lowerer, cur) : null;
  if (arrayRoot === null && collection === null) {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(cur));
    if (mapped?.kind !== "generator" || !stepDrivable(mapped)) return null;
  }
  const loc = locOf(stmt);
  lowerer.scopes.push(new Map());
  try {
    const frame = new HostFrame(lowerer, loc);
    let items: IrExpr;
    let source: ChainSource;
    let elem: IrType;
    if (arrayRoot !== null) {
      items = lowerer.lowerExpr(arrayRoot.receiver);
      if (items.type.kind !== "array")
        lowerer.badType(arrayRoot.receiver, lowerer.typeOf(arrayRoot.receiver));
      source = { kind: "array", type: items.type, proj: arrayRoot.proj };
      elem =
        arrayRoot.proj === "entries" ? entryPairType(lowerer, items.type.elem) : items.type.elem;
    } else if (collection !== null) {
      items = lowerer.lowerExpr(collection.receiver);
      if (items.type.kind !== "map" && items.type.kind !== "set")
        lowerer.badType(collection.receiver, lowerer.typeOf(collection.receiver));
      source = { kind: "collection", type: items.type, proj: collection.proj };
      elem = collectionSeed(lowerer, source);
    } else {
      const src = lowerHelperSource(lowerer, cur);
      items = src.gen;
      source = { kind: "generator", type: src.gen.type, elem: src.elem };
      elem = src.elem;
    }
    const itemsId = frame.local("items", items.type, false);
    const out: IrStmt[] = [{ kind: "varDecl", localId: itemsId, init: items, loc }];
    // Stage arguments evaluate in chain order, before the first pull.
    const slots: StageSlot[] = [];
    for (const s of stages) {
      const { stage, out: next } = lowerStage(
        lowerer,
        s,
        elem,
        loc,
        source.kind === "generator"
          ? (varRef(itemsId, source.type, loc) as IrExpr & { type: GenType })
          : null,
      );
      const arg = "budget" in stage ? stage.budget : stage.fn;
      const argId = frame.local("budget" in stage ? "n" : "f", arg.type, false);
      out.push({ kind: "varDecl", localId: argId, init: arg, loc });
      slots.push(stageSlot(frame, stage, argId));
      elem = next;
    }
    const doneId = frame.local("done", BOOL, true);
    out.push(...stagePrologue(slots, doneId, loc));
    // Each delivered value lands in a hidden local the loop binding reads.
    const valueId = frame.local("hv", elem, false);
    const binds = generatorLoopBinding(lowerer, stmt, varRef(valueId, elem, loc), elem);
    let body = lowerer.inCtl(
      "loop",
      () => lowerer.lowerScopedBlock(stmt.statement),
      source.kind === "collection" ? undefined : labels,
    );
    if (source.kind === "collection") {
      // A return from the body ends the live walk first, as for-of does.
      const t = source.type;
      body = exitBeforeReturns(body, () => ({
        kind: "exprStmt",
        expr:
          t.kind === "map"
            ? {
                kind: "mapIntrinsic",
                method: "iterExit",
                receiver: varRef(itemsId, t, loc),
                args: [],
                type: VOID,
                loc,
              }
            : {
                kind: "setIntrinsic",
                method: "iterExit",
                receiver: varRef(itemsId, t, loc),
                args: [],
                type: VOID,
                loc,
              },
        loc,
      }));
    }
    const emit = foldStages(
      lowerer,
      frame,
      slots,
      (value) => [{ kind: "varDecl", localId: valueId, init: value, loc }, ...binds, ...body],
      doneId,
      loc,
    );
    out.push(
      ...sourceLoop(
        lowerer,
        frame,
        itemsId,
        source,
        doneId,
        emit,
        loc,
        source.kind === "collection" ? undefined : labels,
      ),
    );
    return { kind: "block", body: out, loc };
  } finally {
    lowerer.scopes.pop();
  }
}

/** The argument of an `Iterator.from(x)` call, or null. As a chain's root,
 * the call is the argument's own iterator, so the chain can walk the
 * argument directly. */
function iteratorFromArgument(lowerer: Lowerer, expr: ts.Expression): ts.Expression | null {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;
  if (
    expr.questionDotToken ||
    expr.expression.questionDotToken ||
    expr.arguments.nodes.length !== 1
  )
    return null;
  const arg = expr.arguments.nodes[0]!;
  if (ts.isSpreadElement(arg) || expr.expression.name.text !== "from") return null;
  if (!lowerer.isStdlibGlobal(expr.expression.expression, "Iterator")) return null;
  return lowerer.isStdlibMember(expr.expression) ? arg : null;
}

/** `arr.values()`, `arr.entries()` or `Iterator.from(arr)` on an array value,
 * as the root of a helper chain. */
function arrayIteratorCall(
  lowerer: Lowerer,
  expr: ts.Expression,
): { receiver: ts.Expression; proj: "values" | "entries" } | null {
  const fromArg = iteratorFromArgument(lowerer, expr);
  if (fromArg !== null)
    return lowerer.mapTypeOf(lowerer.typeOf(fromArg))?.kind === "array"
      ? { receiver: fromArg, proj: "values" }
      : null;
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;
  if (
    expr.questionDotToken ||
    expr.expression.questionDotToken ||
    expr.arguments.nodes.length !== 0
  )
    return null;
  const proj = expr.expression.name.text;
  if (proj !== "values" && proj !== "entries") return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression))?.kind !== "array") return null;
  if (!lowerer.isStdlibMember(expr.expression)) return null;
  return { receiver: expr.expression.expression, proj };
}

/** One helper stage call in a chain, in source order. */
interface StageNode {
  name: string;
  argNode: ts.Expression;
  access: ts.PropertyAccessExpression;
}

/** A lowered stage: its callback, or its validated budget. */
type StageIr =
  | {
      kind: "map" | "filter" | "flatMap";
      fn: IrExpr & { type: IrType & { kind: "func" } };
    }
  | { kind: "take" | "drop"; budget: IrExpr };

/** Where a fused chain's elements come from: a live array (by index), or
 * a synchronous generator driven like for-of. */
type ChainSource =
  | { kind: "array"; type: IrType & { kind: "array" }; proj: "values" | "entries" }
  | { kind: "generator"; type: GenType; elem: IrType }
  | {
      kind: "collection";
      type: (IrType & { kind: "map" }) | (IrType & { kind: "set" });
      proj: "keys" | "values" | "entries";
    };

/** `m.keys()`, `m.values()` or `m.entries()` (or a Set's) on a Map or
 * Set value, as the root of a helper chain. */
function collectionIteratorCall(
  lowerer: Lowerer,
  expr: ts.Expression,
): { receiver: ts.Expression; proj: "keys" | "values" | "entries" } | null {
  // Iterator.from(set) is the Set's values iterator, Iterator.from(map) the
  // Map's entries iterator.
  const fromArg = iteratorFromArgument(lowerer, expr);
  if (fromArg !== null) {
    const kind = lowerer.mapTypeOf(lowerer.typeOf(fromArg))?.kind;
    return kind === "set"
      ? { receiver: fromArg, proj: "values" }
      : kind === "map"
        ? { receiver: fromArg, proj: "entries" }
        : null;
  }
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;
  if (
    expr.questionDotToken ||
    expr.expression.questionDotToken ||
    expr.arguments.nodes.length !== 0
  )
    return null;
  const proj = expr.expression.name.text;
  if (proj !== "keys" && proj !== "values" && proj !== "entries") return null;
  const kind = lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression))?.kind;
  if (kind !== "map" && kind !== "set") return null;
  if (!lowerer.isStdlibMember(expr.expression)) return null;
  return { receiver: expr.expression.expression, proj };
}

/** The element a collection chain starts from: a key (a Set's element),
 * a Map's value, or the interned [key, value] pair (a Set's [v, v]). */
function collectionSeed(lowerer: Lowerer, source: ChainSource & { kind: "collection" }): IrType {
  const t = source.type;
  const keyT = t.kind === "map" ? t.key : t.elem;
  if (source.proj === "keys" || (t.kind === "set" && source.proj === "values")) return keyT;
  if (source.proj === "values") return (t as IrType & { kind: "map" }).value;
  return {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "0", type: keyT },
        { name: "1", type: t.kind === "map" ? t.value : keyT },
      ],
      true,
    ),
  };
}

/** The interned [number, T] pair an array's entries() yields. */
function entryPairType(lowerer: Lowerer, elem: IrType): IrType {
  return {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "0", type: F64 },
        { name: "1", type: elem },
      ],
      true,
    ),
  };
}

/** Whether `expr` is an iterator object the helpers lower over: a
 * synchronous generator-typed value, or a Map/Set iterator. */
function isHelperReceiver(lowerer: Lowerer, expr: ts.Expression): boolean {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (mapped?.kind === "generator") return mapped.async !== true;
  const symbol = lowerer.typeOf(expr).getSymbol();
  return (
    mapped?.kind === "dyn" &&
    symbol !== undefined &&
    ADAPTED_ITERATOR_TYPES.has(ts.symbolName(symbol)) &&
    lowerer.isStdlibSymbol(symbol)
  );
}

/** Whether `expr` is a stage call (`src.map(f)`) on a helper receiver. */
function isStageCall(lowerer: Lowerer, expr: ts.Expression): expr is ts.CallExpression {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
  if (expr.questionDotToken || expr.expression.questionDotToken) return false;
  if (!ITER_STAGES.has(expr.expression.name.text)) return false;
  if (expr.arguments.nodes.length !== 1 || ts.isSpreadElement(expr.arguments.nodes[0]!))
    return false;
  return (
    isHelperReceiver(lowerer, expr.expression.expression) && lowerer.isStdlibMember(expr.expression)
  );
}

/** The source of a helper call as a synchronous generator — the receiver
 * itself, or a Map/Set iterator adapted into a generator over the live
 * collection — and its element type. A generator whose yield channel is
 * checked-dynamic beside a declared element type (`Generator<P>` boxes a
 * record yield next to its `any` return channel) has each value converted
 * to the declared type as it is pulled. */
function lowerHelperSource(
  lowerer: Lowerer,
  expr: ts.Expression,
): { gen: IrExpr & { type: GenType }; elem: IrType } {
  // Iterator.from(gen) is the generator itself; the call's IteratorObject
  // type would add an adapter generator over it.
  const fromArg = iteratorFromArgument(lowerer, expr);
  if (fromArg !== null && lowerer.mapTypeOf(lowerer.typeOf(fromArg))?.kind === "generator")
    return lowerHelperSource(lowerer, fromArg);
  const tsType = lowerer.typeOf(expr);
  const mapped = lowerer.mapTypeOf(tsType);
  const arg = lowerer.checker.getTypeArguments(tsType as ts.TypeReference)[0];
  if (mapped?.kind === "generator") {
    const gen = lowerer.lowerExpr(expr);
    if (gen.type.kind !== "generator" || gen.type.async) lowerer.badType(expr, tsType);
    const genT = gen.type;
    const declared = genT.yieldT.kind === "dyn" && arg ? lowerer.mapTypeOf(arg) : null;
    const elem =
      declared !== null &&
      declared.kind !== "dyn" &&
      declared.kind !== "void" &&
      !isUnitType(declared)
        ? declared
        : genT.yieldT;
    return { gen: gen as IrExpr & { type: GenType }, elem };
  }
  const yieldT = arg ? lowerer.mapTypeOf(arg) : null;
  if (
    !yieldT ||
    yieldT.kind === "void" ||
    !genResultRecord(yieldT, VOID, lowerer.shapes, lowerer.unions)
  )
    lowerer.badType(expr, tsType);
  const target: GenType = { kind: "generator", yieldT, retT: VOID, nextT: UNDEFINED_T };
  // m.keys()/values()/entries() (or a Set's) on a typed collection: a
  // generator over the collection with typed reads.
  const collection = collectionIteratorCall(lowerer, expr);
  if (collection !== null) {
    const coll = lowerer.lowerExpr(collection.receiver);
    const walk = lowerCollectionIteratorValue(lowerer, coll, collection.proj, target, locOf(expr));
    if (walk !== null) return { gen: walk as IrExpr & { type: GenType }, elem: yieldT };
  }
  const adapted = iteratorSlotAdapter(lowerer, lowerer.lowerExpr(expr), target);
  if (adapted === null || adapted.type.kind !== "generator") lowerer.badType(expr, tsType);
  return { gen: adapted as IrExpr & { type: GenType }, elem: yieldT };
}

/** Lower one stage's argument against its input element type: the
 * callback (value) or (value, counter), or the take/drop budget with
 * Node's eager RangeError check at the argument's position. `out` is
 * the stage's output element type. */
function lowerStage(
  lowerer: Lowerer,
  s: StageNode,
  elem: IrType,
  loc: SrcLoc,
  source: (IrExpr & { type: GenType }) | null = null,
): { stage: StageIr; out: IrType } {
  if (s.name === "take" || s.name === "drop") {
    const n = lowerer.lowerExpr(s.argNode);
    if (n.type.kind !== "f64") lowerer.badType(s.argNode, lowerer.typeOf(s.argNode));
    // Node validates at the take()/drop() call — the checked budget
    // rides an interned helper call AT this argument position. A
    // generator source is closed before the RangeError, as Node closes
    // the iterator the helper was called on.
    return {
      stage: {
        kind: s.name,
        budget: {
          kind: "call",
          callee: internBudgetChecker(lowerer, loc, source?.type ?? null),
          args: source === null ? [n] : [n, source],
          type: F64,
          loc,
        },
      },
      out: elem,
    };
  }
  // A flatMap callback returns its own array or generator type (an
  // unannotated JavaScript arrow would otherwise return checked values).
  let expectedReturn: IrType | undefined;
  if (s.name === "flatMap") {
    const sig = lowerer.checker.getCallSignatures(lowerer.typeOf(s.argNode))[0];
    const ret = sig ? lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(sig)) : null;
    if (ret?.kind === "array" || ret?.kind === "generator") expectedReturn = ret;
  }
  // Unannotated JavaScript parameters bind the element type.
  const f = lowerArrayCallback(
    lowerer,
    s.argNode,
    [elem],
    UNDEFINED_T,
    false,
    expectedReturn,
  ).fnArg;
  if (
    f.type.kind !== "func" ||
    f.type.params.length > 2 ||
    (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
    (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64")
  ) {
    lowerer.badType(s.argNode, lowerer.typeOf(s.argNode));
  }
  const fn = f as IrExpr & { type: IrType & { kind: "func" } };
  if (s.name === "map") return { stage: { kind: "map", fn }, out: fn.type.ret };
  if (s.name === "filter") {
    if (fn.type.ret.kind !== "bool") lowerer.badType(s.argNode, lowerer.typeOf(s.argNode));
    return { stage: { kind: "filter", fn }, out: elem };
  }
  const ret = fn.type.ret;
  if (ret.kind === "array") return { stage: { kind: "flatMap", fn }, out: ret.elem };
  if (ret.kind === "generator" && ret.async !== true && stepDrivable(ret))
    return { stage: { kind: "flatMap", fn }, out: ret.yieldT };
  // A Set flattens its values and a Map its entries, walked live. A string
  // is rejected at run time with Node's TypeError (strings are not
  // iterator objects).
  if (ret.kind === "set") return { stage: { kind: "flatMap", fn }, out: ret.elem };
  if (ret.kind === "map")
    return { stage: { kind: "flatMap", fn }, out: entryPairTypeOf(lowerer, ret.key, ret.value) };
  if (ret.kind === "string") return { stage: { kind: "flatMap", fn }, out: STRING };
  lowerer.noLowering(
    `.flatMap over a callback returning '${lowerer.fmt(ret)}'`,
    s.argNode,
    "callbacks returning an array, a generator, a Set or a Map are the supported forms",
  );
}

/** The terminal's arguments and result type over elements of `elem`. */
function lowerTerminal(
  lowerer: Lowerer,
  call: ts.CallExpression,
  terminal: string,
  elem: IrType,
): { termArgs: IrExpr[]; resultT: IrType } {
  const termArgs: IrExpr[] = [];
  if (terminal === "toArray") {
    if (call.arguments.nodes.length !== 0)
      lowerer.noLowering(`.toArray with ${call.arguments.nodes.length} arguments`, call);
    return { termArgs, resultT: arrayOf(elem) };
  }
  if (
    terminal === "forEach" ||
    terminal === "some" ||
    terminal === "every" ||
    terminal === "find"
  ) {
    const argNode = call.arguments.nodes[0];
    if (call.arguments.nodes.length !== 1 || argNode === undefined || ts.isSpreadElement(argNode)) {
      lowerer.noLowering(`.${terminal} with ${call.arguments.nodes.length} arguments`, call);
    }
    const f = lowerArrayCallback(lowerer, argNode, [elem], UNDEFINED_T).fnArg;
    if (
      f.type.kind !== "func" ||
      f.type.params.length > 2 ||
      (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
      (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64") ||
      (terminal !== "forEach" && f.type.ret.kind !== "bool")
    ) {
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    }
    termArgs.push(f);
    return {
      termArgs,
      resultT:
        terminal === "forEach" ? VOID : terminal === "find" ? lowerer.withUndefinedArm(elem) : BOOL,
    };
  }
  // reduce(f[, initial])
  const fNode = call.arguments.nodes[0];
  if (
    call.arguments.nodes.length < 1 ||
    call.arguments.nodes.length > 2 ||
    fNode === undefined ||
    call.arguments.nodes.some((a) => ts.isSpreadElement(a))
  ) {
    lowerer.noLowering(`.reduce with ${call.arguments.nodes.length} arguments`, call);
  }
  // The accumulator binds the checker's result type.
  const accLead = lowerer.mapTypeOf(lowerer.typeOf(call)) ?? elem;
  const f = lowerArrayCallback(lowerer, fNode, [accLead, elem], UNDEFINED_T).fnArg;
  if (
    f.type.kind !== "func" ||
    f.type.params.length < 2 ||
    f.type.params.length > 3 ||
    !typeEquals(f.type.params[1]!, elem) ||
    (f.type.params.length === 3 && f.type.params[2]!.kind !== "f64") ||
    !typeEquals(f.type.params[0]!, f.type.ret)
  ) {
    lowerer.badType(fNode, lowerer.typeOf(fNode));
  }
  const accT = (f.type as IrType & { kind: "func" }).ret;
  if (call.arguments.nodes.length === 1 && !typeEquals(accT, elem)) {
    lowerer.noLowering(
      ".reduce without an initial value where the accumulator's type differs from the elements'",
      call,
      "pass the initial value: .reduce(f, init)",
    );
  }
  termArgs.push(f);
  if (call.arguments.nodes[1] !== undefined)
    termArgs.push(lowerer.lowerExprExpecting(call.arguments.nodes[1], accT));
  return { termArgs, resultT: accT };
}

/** A terminal over a chain of stages from `source`: one interned fused
 * function, called with the source, each stage's budget or callback and
 * the terminal's arguments (lowered in that, the chain's own, order). */
function lowerFusedChain(
  lowerer: Lowerer,
  call: ts.CallExpression,
  terminal: string,
  stages: StageNode[],
  source: ChainSource,
  items: IrExpr,
  seed: IrType,
): IrExpr {
  const loc = locOf(call);
  if (source.kind === "generator" && !stepDrivable(source.type)) {
    lowerer.noLowering(
      `.${terminal} over an iterator yielding '${lowerer.fmt(source.type.yieldT)}'`,
      call,
      "helpers over iterators of numbers, booleans, strings, arrays, records and class instances are the supported forms",
    );
  }
  // A take/drop budget check closes a generator source, so the source is
  // bound before the stage arguments.
  const bound =
    source.kind === "generator" && stages.some((s) => s.name === "take" || s.name === "drop")
      ? bindSource(lowerer, items as IrExpr & { type: GenType }, loc)
      : null;
  if (bound !== null) items = bound.ref;
  let elem = seed;
  const stageIrs: StageIr[] = [];
  for (const s of stages) {
    const lowered = lowerStage(lowerer, s, elem, loc, bound?.ref ?? null);
    stageIrs.push(lowered.stage);
    elem = lowered.out;
  }
  const { termArgs, resultT } = lowerTerminal(lowerer, call, terminal, elem);
  // The checker's own result type must agree (annotation drift fences).
  const checkerT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (terminal !== "forEach" && (checkerT === null || !typeEquals(checkerT, resultT))) {
    lowerer.noLowering(
      `.${terminal} at this result type`,
      call,
      "the chain's element and result types must be representable — annotate the callbacks' types",
    );
  }
  const stageKeys = stageIrs.map((s) =>
    "budget" in s ? s.kind : `${s.kind}:${typeKey(s.fn.type)}`,
  );
  const srcKey =
    source.kind === "generator"
      ? `${typeKey(source.type)}:${typeKey(source.elem)}`
      : `${source.proj}:${typeKey(source.type)}`;
  const key = `iter:${srcKey}:${stageKeys.join(",")}:${terminal}:${termArgs.map((a) => typeKey(a.type)).join(",")}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%iter.${terminal}`, key);
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push(
      buildIterChainFn(
        lowerer,
        helper,
        source,
        stageIrs,
        terminal,
        termArgs.map((a) => a.type),
        resultT,
        loc,
      ),
    );
  }
  const budgetOrFn = stageIrs.map((s): IrExpr => ("budget" in s ? s.budget : s.fn));
  const fused: IrExpr = {
    kind: "call",
    callee: helper,
    args: [items, ...budgetOrFn, ...termArgs],
    type: resultT,
    loc,
  };
  return bound === null
    ? fused
    : { kind: "seqExpr", stmts: [bound.decl], result: fused, type: resultT, loc };
}

/** An iterator helper object for one stage over `src`: an interned
 * generator `%iter.<stage>.N(src, f | n)` typed as the call's checker
 * type (IteratorObject<out>). */
function lowerHelperObject(
  lowerer: Lowerer,
  call: ts.CallExpression,
  src: IrExpr,
  source: (ChainSource & { kind: "generator" }) | (ChainSource & { kind: "collection" }),
  srcElem: IrType,
  stage: StageIr,
  out: IrType,
  loc: SrcLoc,
): IrExpr {
  const outT = lowerer.mapTypeOf(lowerer.typeOf(call));
  const resultType =
    outT?.kind === "generator"
      ? genResultRecord(outT.yieldT, outT.retT, lowerer.shapes, lowerer.unions)
      : null;
  if (
    outT?.kind !== "generator" ||
    outT.async === true ||
    !typeEquals(outT.yieldT, out) ||
    outT.retT.kind !== "void" ||
    resultType === null
  ) {
    lowerer.noLowering(
      `.${stage.kind} at this result type`,
      call,
      "the helper's element type must be representable — annotate the callback's types",
    );
  }
  if (source.kind === "generator" && !stepDrivable(source.type)) {
    lowerer.noLowering(
      `.${stage.kind} over an iterator yielding '${lowerer.fmt(source.type.yieldT)}'`,
      call,
      "helpers over iterators of numbers, booleans, strings, arrays, records and class instances are the supported forms",
    );
  }
  const arg = "budget" in stage ? stage.budget : stage.fn;
  const srcKey =
    source.kind === "collection" ? `${source.proj}:${typeKey(source.type)}` : typeKey(source.type);
  const key = `iterHelper:${stage.kind}:${srcKey}:${typeKey(srcElem)}:${typeKey(arg.type)}:${typeKey(outT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, `%iter.${stage.kind}`, key);
    lowerer.arrHofHelpers.set(key, name);
    lowerer.liftedFns.push(
      buildHelperGenFn(lowerer, name, source, srcElem, stage, arg.type, outT, resultType, loc),
    );
  }
  return { kind: "call", callee: name, args: [src, arg], type: outT, loc };
}

/** The eager take/drop budget check, interned once per program:
 *
 *   %iter.budget(v) { if (v !== v || trunc(v) < 0) throw RangeError(`${v} must be positive`); return trunc(v) }
 *
 * Node's exact behavior: NaN and negative INTEGER budgets throw (the
 * message carries the RAW argument — take(-1.5) says "-1.5"), -0.5
 * truncates to 0 and passes, Infinity passes through. */
function internBudgetChecker(lowerer: Lowerer, loc: SrcLoc, srcT: GenType | null): string {
  const key = srcT === null ? "iter:budget" : `iter:budget:close:${typeKey(srcT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name !== undefined) return name;
  name = srcT === null ? "%iter.budget" : keyedHelperName(lowerer, "%iter.budget.close", key);
  lowerer.arrHofHelpers.set(key, name);
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: F64, loc });

  // trunc without an Infinity-poisoned fmod: values at or past 2^53 are
  // already integers (Infinity included), so only smaller ones truncate.
  const t = (): IrExpr => ({
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "<",
      left: v(),
      right: numLit(9007199254740992, loc),
      type: BOOL,
      loc,
    },
    then: {
      kind: "bin",
      op: "-",
      left: v(),
      right: { kind: "bin", op: "%", left: v(), right: numLit(1, loc), type: F64, loc },
      type: F64,
      loc,
    },
    else_: v(),
    type: F64,
    loc,
  });
  const bad: IrExpr = {
    kind: "logical",
    op: "||",
    left: { kind: "bin", op: "!==", left: v(), right: v(), type: BOOL, loc },
    right: { kind: "bin", op: "<", left: t(), right: numLit(0, loc), type: BOOL, loc },
    type: BOOL,
    loc,
  };
  const throwStmt: IrStmt = {
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [
        concatStrings(
          [
            { kind: "toString", operand: v(), type: STRING, loc },
            { kind: "strLit", value: " must be positive", type: STRING, loc },
          ],
          loc,
        ),
      ],
      type: { kind: "object", className: "%RangeError" },
      loc,
    },
    loc,
  };
  // The source closes first; an error from its return() is dropped, so
  // the RangeError is what propagates.
  const closeSource: IrStmt[] =
    srcT === null
      ? []
      : [
          {
            kind: "tryCatch",
            tryBody: [
              {
                kind: "exprStmt",
                expr: {
                  kind: "genResume",
                  mode: "close",
                  gen: varRef("src.0", srcT, loc),
                  arg: null,
                  type: VOID,
                  loc,
                },
                loc,
              },
            ],
            catchBody: [],
            catchLocalId: "exc.0",
            finallyBody: null,
            loc,
          },
        ];
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "v.0", name: "v", type: F64 },
      ...(srcT === null ? [] : [{ localId: "src.0", name: "src", type: srcT }]),
    ],
    returnType: F64,
    locals: [
      { id: "v.0", name: "v", type: F64, mutable: true },
      ...(srcT === null
        ? []
        : [
            { id: "src.0", name: "src", type: srcT, mutable: false },
            { id: "exc.0", name: "exc", type: CAUGHT, mutable: false },
          ]),
    ],
    body: [
      { kind: "if", cond: bad, then: [...closeSource, throwStmt], else_: null, loc },
      { kind: "return", value: t(), loc },
    ],
    loc,
  });
  return name;
}

/** A hidden local holding `gen`, and its declaration. */
function bindSource(
  lowerer: Lowerer,
  gen: IrExpr & { type: GenType },
  loc: SrcLoc,
): { ref: IrExpr & { type: GenType }; decl: IrStmt } {
  const local = lowerer.declareHiddenLocal("%helperSource", gen.type);
  return {
    ref: varRef(local.id, gen.type, loc) as IrExpr & { type: GenType },
    decl: { kind: "varDecl", localId: local.id, init: gen, loc },
  };
}

/** Where chain code allocates its locals: a lifted helper function's own
 * frame, or hidden locals of the function being lowered (a fused for-of). */
abstract class ChainFrame {
  abstract local(base: string, type: IrType, mutable: boolean): string;
  /** `id = id + 1` over a number local. */
  abstract bump(id: string): IrStmt;
}

/** `id = id + 1` over a number local. */
function bumpLocal(id: string, loc: SrcLoc): IrStmt {
  return {
    kind: "assign",
    localId: id,
    value: {
      kind: "bin",
      op: "+",
      left: varRef(id, F64, loc),
      right: numLit(1, loc),
      type: F64,
      loc,
    },
    loc,
  };
}

/** Hidden locals of the function being lowered. */
class HostFrame extends ChainFrame {
  constructor(
    private readonly lowerer: Lowerer,
    private readonly loc: SrcLoc,
  ) {
    super();
  }
  local(base: string, type: IrType, mutable: boolean): string {
    const local = this.lowerer.declareHiddenLocal(`%${base}`, type);
    local.mutable = mutable;
    return local.id;
  }
  bump(id: string): IrStmt {
    return bumpLocal(id, this.loc);
  }
}

/** The locals and parameters of a lifted helper function under
 * construction. */
export class LiftedFrame extends ChainFrame {
  readonly locals: IrLocal[] = [];
  readonly params: IrParam[] = [];
  private n = 0;
  constructor(private readonly loc: SrcLoc) {
    super();
  }
  local(base: string, type: IrType, mutable: boolean): string {
    const id = `${base}.${this.n++}`;
    this.locals.push({ id, name: base, type, mutable });
    return id;
  }
  param(base: string, type: IrType): string {
    const id = `${base}.${this.n++}`;
    this.locals.push({ id, name: base, type, mutable: true });
    this.params.push({ localId: id, name: base, type });
    return id;
  }
  bump(id: string): IrStmt {
    return bumpLocal(id, this.loc);
  }
}

/** Statements that drive the synchronous generator in local `genId` the
 * way for-of does. Each pass runs `pre` (which may `break`), steps the
 * generator, binds the yielded value and runs `body` over it (`continue`
 * moves to the next pass). Leaving the loop while the generator is
 * unfinished closes it: a `break` in `pre` or `body`, a throw from the
 * body, or a `return()` at a yield inside it. Exhaustion and a throwing
 * step leave it unclosed, as in Node. The generator counts as unfinished
 * before the first step, so a `pre` that breaks at once (take(0)) closes
 * a source it never pulled. `genT` must be stepDrivable. */
export function driveGenerator(
  lowerer: Lowerer,
  frame: ChainFrame,
  genId: string,
  genT: GenType,
  elemT: IrType,
  pre: IrStmt[],
  body: (value: IrExpr) => IrStmt[],
  loc: SrcLoc,
  labels?: string[],
): IrStmt[] {
  const g = (): IrExpr & { type: GenType } =>
    varRef(genId, genT, loc) as IrExpr & { type: GenType };
  const openId = frame.local("open", BOOL, true);
  const setOpen = (value: boolean): IrStmt => ({
    kind: "assign",
    localId: openId,
    value: boolLit(value, loc),
    loc,
  });
  const vId = frame.local("gv", genT.yieldT, false);
  // A checked-dynamic yield converts once into the element type.
  const converted = typeEquals(elemT, genT.yieldT)
    ? null
    : lowerer.coerceToExpected(varRef(vId, genT.yieldT, loc), elemT);
  if (converted !== null && !typeEquals(converted.type, elemT))
    throw new InternalCompilerError("lowerer bug: helper source element has no conversion");
  const eId = converted === null ? vId : frame.local("ev", elemT, false);
  return [
    { kind: "varDecl", localId: openId, init: boolLit(true, loc), loc },
    {
      kind: "tryCatch",
      tryBody: [
        {
          kind: "while",
          cond: boolLit(true, loc),
          body: [
            ...pre,
            setOpen(false),
            {
              kind: "if",
              cond: genStep(g(), loc),
              then: [{ kind: "break", loc }],
              else_: null,
              loc,
            },
            setOpen(true),
            { kind: "varDecl", localId: vId, init: genValue(g(), loc), loc },
            ...(converted === null
              ? []
              : [{ kind: "varDecl" as const, localId: eId, init: converted, loc }]),
            ...body(varRef(eId, elemT, loc)),
          ],
          ...(labels && { labels }),
          loc,
        },
      ],
      catchBody: null,
      catchLocalId: null,
      // After a throw, an error from closing the source is dropped.
      dropFinallyErrors: true,
      finallyBody: [
        {
          kind: "if",
          cond: varRef(openId, BOOL, loc),
          then: [
            {
              kind: "exprStmt",
              expr: { kind: "genResume", mode: "close", gen: g(), arg: null, type: VOID, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    },
  ];
}

/** Statements that walk the Map or Set in local `collId` from inside a
 * helper's generator: each pass runs `pre` (which may `break`), takes the
 * next live entry index from the runtime's native iterator, which keeps
 * the walk live and ends it when exhausted or released, and runs `body`
 * over the projected element read with the typed intrinsics. */
function driveCollectionNative(
  lowerer: Lowerer,
  frame: ChainFrame,
  collId: string,
  source: ChainSource & { kind: "collection" },
  pre: IrStmt[],
  body: (value: IrExpr) => IrStmt[],
  loc: SrcLoc,
): IrStmt[] {
  const t = source.type;
  const coll = (): IrExpr => varRef(collId, t, loc);
  const nativeId = frame.local("native", DYN, false);
  const iId = frame.local("i", F64, false);
  const read = (method: "iterKey" | "iterValue", type: IrType): IrExpr =>
    t.kind === "map"
      ? { kind: "mapIntrinsic", method, receiver: coll(), args: [varRef(iId, F64, loc)], type, loc }
      : {
          kind: "setIntrinsic",
          method: "iterKey",
          receiver: coll(),
          args: [varRef(iId, F64, loc)],
          type,
          loc,
        };
  const keyT = t.kind === "map" ? t.key : t.elem;
  const valueT = t.kind === "map" ? t.value : t.elem;
  const seedT = collectionSeed(lowerer, source);
  const seed: IrExpr =
    source.proj === "entries"
      ? {
          kind: "recordLit",
          fields: [
            { name: "0", value: read("iterKey", keyT) },
            { name: "1", value: read("iterValue", valueT) },
          ],
          type: seedT,
          loc,
        }
      : source.proj === "values" && t.kind === "map"
        ? read("iterValue", valueT)
        : read("iterKey", keyT);
  const vId = frame.local("v", seedT, false);
  return [
    {
      kind: "varDecl",
      localId: nativeId,
      init: {
        kind: "dynInvoke",
        recv: lowerer.coerceToExpected(coll(), DYN),
        method: "values",
        calleeName: t.kind === "map" ? "map.values" : "set.values",
        args: [],
        type: DYN,
        loc,
      },
      loc,
    },
    {
      kind: "while",
      cond: boolLit(true, loc),
      body: [
        ...pre,
        {
          kind: "varDecl",
          localId: iId,
          init: {
            kind: "libCall",
            fn: "dyn.collectionIteratorIndex",
            args: [varRef(nativeId, DYN, loc)],
            type: F64,
            loc,
          },
          loc,
        },
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "<",
            left: varRef(iId, F64, loc),
            right: numLit(0, loc),
            type: BOOL,
            loc,
          },
          then: [{ kind: "break", loc }],
          else_: null,
          loc,
        },
        { kind: "varDecl", localId: vId, init: seed, loc },
        ...body(varRef(vId, seedT, loc)),
      ],
      loc,
    },
  ];
}

/** `for (j = 0; j < arr.length && !stop; j++) body(arr[j])` over a live
 * array local (the array iterator's per-step length read). */
function walkArray(
  frame: ChainFrame,
  arrId: string,
  arrT: IrType & { kind: "array" },
  stop: IrExpr | null,
  body: (value: IrExpr) => IrStmt[],
  loc: SrcLoc,
): IrStmt {
  const jId = frame.local("j", F64, true);
  const wId = frame.local("w", arrT.elem, false);
  const inBounds: IrExpr = {
    kind: "bin",
    op: "<",
    left: varRef(jId, F64, loc),
    right: {
      kind: "arrIntrinsic",
      method: "length",
      receiver: varRef(arrId, arrT, loc),
      args: [],
      type: F64,
      loc,
    },
    type: BOOL,
    loc,
  };
  return {
    kind: "for",
    init: { kind: "varDecl", localId: jId, init: numLit(0, loc), loc },
    cond:
      stop === null
        ? inBounds
        : {
            kind: "logical",
            op: "&&",
            left: inBounds,
            right: { kind: "unary", op: "!", operand: stop, type: BOOL, loc },
            type: BOOL,
            loc,
          },
    update: frame.bump(jId),
    body: [
      {
        kind: "varDecl",
        localId: wId,
        init: {
          kind: "arrayGet",
          arr: varRef(arrId, arrT, loc),
          index: varRef(jId, F64, loc),
          type: arrT.elem,
          loc,
        },
        loc,
      },
      ...body(varRef(wId, arrT.elem, loc)),
    ],
    loc,
  };
}

/** The live walk over the Map or Set in local `collId` that for-of does:
 * iterEnter, then each live index from iterStart below the current
 * iterCount until `stop`, then iterExit on every exit (a throw exits
 * before rethrowing). The body sees the projected element. */
function walkCollection(
  lowerer: Lowerer,
  frame: ChainFrame,
  collId: string,
  source: ChainSource & { kind: "collection" },
  stop: IrExpr,
  body: (value: IrExpr) => IrStmt[],
  loc: SrcLoc,
  labels?: string[],
): IrStmt[] {
  const t = source.type;
  const iId = frame.local("i", F64, true);
  const iter = (method: string, args: IrExpr[], type: IrType): IrExpr =>
    t.kind === "map"
      ? {
          kind: "mapIntrinsic",
          method: method as IrMapIntrinsicMethod,
          receiver: varRef(collId, t, loc),
          args,
          type,
          loc,
        }
      : {
          kind: "setIntrinsic",
          method: method as IrSetIntrinsicMethod,
          receiver: varRef(collId, t, loc),
          args,
          type,
          loc,
        };
  const keyT = t.kind === "map" ? t.key : t.elem;
  const keyRead = (): IrExpr => iter("iterKey", [varRef(iId, F64, loc)], keyT);
  const valRead = (): IrExpr =>
    t.kind === "map" ? iter("iterValue", [varRef(iId, F64, loc)], t.value) : keyRead();
  const seedT = collectionSeed(lowerer, source);
  const seed: IrExpr =
    source.proj === "entries"
      ? {
          kind: "recordLit",
          fields: [
            { name: "0", value: keyRead() },
            { name: "1", value: valRead() },
          ],
          type: seedT,
          loc,
        }
      : source.proj === "values" && t.kind === "map"
        ? valRead()
        : keyRead();
  const vId = frame.local("v", seedT, false);
  const exit = (): IrStmt => ({ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc });
  const caughtId = frame.local("exc", CAUGHT, false);
  const loop: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: iId, init: iter("iterStart", [], F64), loc },
    cond: {
      kind: "logical",
      op: "&&",
      left: {
        kind: "bin",
        op: "<",
        left: varRef(iId, F64, loc),
        right: iter("iterCount", [], F64),
        type: BOOL,
        loc,
      },
      right: { kind: "unary", op: "!", operand: stop, type: BOOL, loc },
      type: BOOL,
      loc,
    },
    update: frame.bump(iId),
    body: [
      {
        kind: "if",
        cond: iter("iterLive", [varRef(iId, F64, loc)], BOOL),
        then: [
          { kind: "varDecl", localId: vId, init: seed, loc },
          ...body(varRef(vId, seedT, loc)),
        ],
        else_: null,
        loc,
      },
    ],
    ...(labels && { labels }),
    loc,
  };
  return [
    { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
    {
      kind: "tryCatch",
      tryBody: [loop],
      catchBody: [exit(), { kind: "rethrow", localId: caughtId, loc }],
      catchLocalId: caughtId,
      finallyBody: null,
      loc,
    },
    exit(),
  ];
}

/** A flatMap stage's inner walk over the callback's result in local
 * `innerId`: an array by index, a Set's values or a Map's entries walked
 * live, or a generator driven (and closed on early exit) like the source.
 * A string result throws Node's TypeError. `stop` ends the walk early. */
function walkInner(
  lowerer: Lowerer,
  frame: ChainFrame,
  innerId: string,
  innerT: IrType,
  stop: IrExpr | null,
  body: (value: IrExpr) => IrStmt[],
  loc: SrcLoc,
): IrStmt[] {
  if (innerT.kind === "array") return [walkArray(frame, innerId, innerT, stop, body, loc)];
  if (innerT.kind === "set" || innerT.kind === "map") {
    const source: ChainSource = {
      kind: "collection",
      type: innerT,
      proj: innerT.kind === "set" ? "values" : "entries",
    };
    return walkCollection(lowerer, frame, innerId, source, stop ?? boolLit(false, loc), body, loc);
  }
  if (innerT.kind === "string") {
    return [
      throwTypeError(
        {
          kind: "strLit",
          value: "Iterator.prototype.flatMap called on non-object",
          type: STRING,
          loc,
        },
        loc,
      ),
    ];
  }
  if (innerT.kind !== "generator")
    throw new InternalCompilerError("lowerer bug: flatMap over a non-iterable result");
  const pre: IrStmt[] =
    stop === null
      ? []
      : [{ kind: "if", cond: stop, then: [{ kind: "break", loc }], else_: null, loc }];
  return driveGenerator(lowerer, frame, innerId, innerT, innerT.yieldT, pre, body, loc);
}

/** A stage inside fused chain code: the local holding its budget or
 * callback, and its counter when the callback reads one (take/drop count
 * in theirs). */
interface StageSlot {
  kind: string;
  argId: string;
  fnT?: (IrType & { kind: "func" }) | undefined;
  cntId?: string | undefined;
}

/** A stage callback call with (value) or (value, counter), as declared. */
function callStage(
  fnT: IrType & { kind: "func" },
  fnId: string,
  value: IrExpr,
  cntId: string | undefined,
  loc: SrcLoc,
): IrExpr {
  const args: IrExpr[] = [];
  if (fnT.params.length >= 1) args.push(value);
  if (cntId !== undefined && fnT.params.length >= 2) args.push(varRef(cntId, F64, loc));
  return { kind: "callValue", callee: varRef(fnId, fnT, loc), args, type: fnT.ret, loc };
}

/** The slot for `stage` whose budget or callback is in local `argId`. */
function stageSlot(frame: ChainFrame, stage: StageIr, argId: string): StageSlot {
  if ("budget" in stage) {
    return {
      kind: stage.kind,
      argId,
      cntId: frame.local(stage.kind === "take" ? "taken" : "dropped", F64, true),
    };
  }
  const fnT = stage.fn.type;
  return {
    kind: stage.kind,
    argId,
    fnT,
    cntId: fnT.params.length === 2 ? frame.local("c", F64, true) : undefined,
  };
}

/** The declarations fused chain code starts with: the `done` flag —
 * already true when a take budget is zero, so nothing pulls — and each
 * stage counter at zero. */
function stagePrologue(slots: StageSlot[], doneId: string, loc: SrcLoc): IrStmt[] {
  let doneInit: IrExpr = boolLit(false, loc);
  for (const s of slots) {
    if (s.kind !== "take") continue;
    const isZero: IrExpr = {
      kind: "bin",
      op: "===",
      left: varRef(s.argId, F64, loc),
      right: numLit(0, loc),
      type: BOOL,
      loc,
    };
    doneInit =
      doneInit.kind === "boolLit"
        ? isZero
        : { kind: "logical", op: "||", left: doneInit, right: isZero, type: BOOL, loc };
  }
  const out: IrStmt[] = [{ kind: "varDecl", localId: doneId, init: doneInit, loc }];
  for (const s of slots) {
    if (s.cntId !== undefined)
      out.push({ kind: "varDecl", localId: s.cntId, init: numLit(0, loc), loc });
  }
  return out;
}

/** The per-element code of a chain: each stage nested in source order
 * around `last` (the terminal's statements, or a for-of body), folded
 * from the end outward. filter and drop skip with `continue`; take spends
 * its budget before delivery and sets `done`, so the nth element flows on
 * and nothing pulls after it (every pass tests done); flatMap walks its
 * callback's array or generator in an inner loop that also tests done. */
function foldStages(
  lowerer: Lowerer,
  frame: ChainFrame,
  slots: StageSlot[],
  last: (value: IrExpr) => IrStmt[],
  doneId: string,
  loc: SrcLoc,
): (value: IrExpr) => IrStmt[] {
  const done = (): IrExpr => varRef(doneId, BOOL, loc);
  const setDone: IrStmt = { kind: "assign", localId: doneId, value: boolLit(true, loc), loc };
  let emit = last;
  for (let si = slots.length - 1; si >= 0; si--) {
    const s = slots[si]!;
    const inner = emit;
    if (s.kind === "map") {
      emit = (value) => {
        const vId = frame.local("m", s.fnT!.ret, false);
        return [
          {
            kind: "varDecl",
            localId: vId,
            init: callStage(s.fnT!, s.argId, value, s.cntId, loc),
            loc,
          },
          ...(s.cntId !== undefined ? [frame.bump(s.cntId)] : []),
          ...inner(varRef(vId, s.fnT!.ret, loc)),
        ];
      };
    } else if (s.kind === "filter") {
      emit = (value) => {
        const okId = frame.local("ok", BOOL, false);
        return [
          {
            kind: "varDecl",
            localId: okId,
            init: callStage(s.fnT!, s.argId, value, s.cntId, loc),
            loc,
          },
          ...(s.cntId !== undefined ? [frame.bump(s.cntId)] : []),
          {
            kind: "if",
            cond: { kind: "unary", op: "!", operand: varRef(okId, BOOL, loc), type: BOOL, loc },
            then: [{ kind: "continue", loc }],
            else_: null,
            loc,
          },
          ...inner(value),
        ];
      };
    } else if (s.kind === "drop") {
      emit = (value) => [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "<",
            left: varRef(s.cntId!, F64, loc),
            right: varRef(s.argId, F64, loc),
            type: BOOL,
            loc,
          },
          then: [frame.bump(s.cntId!), { kind: "continue", loc }],
          else_: null,
          loc,
        },
        ...inner(value),
      ];
    } else if (s.kind === "take") {
      emit = (value) => [
        frame.bump(s.cntId!),
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: ">=",
            left: varRef(s.cntId!, F64, loc),
            right: varRef(s.argId, F64, loc),
            type: BOOL,
            loc,
          },
          then: [setDone],
          else_: null,
          loc,
        },
        ...inner(value),
      ];
    } else {
      // A take before this stage sets `done` as it delivers its last
      // value, which still flattens in full: the inner walk runs with the
      // flag clear, and keeps it set afterwards.
      const afterTake = slots.slice(0, si).some((slot) => slot.kind === "take");
      emit = (value) => {
        const innerT = s.fnT!.ret;
        const innerId = frame.local("fm", innerT, false);
        const heldId = afterTake ? frame.local("held", BOOL, false) : undefined;
        const walk = walkInner(lowerer, frame, innerId, innerT, done(), inner, loc);
        return [
          {
            kind: "varDecl",
            localId: innerId,
            init: callStage(s.fnT!, s.argId, value, s.cntId, loc),
            loc,
          },
          ...(s.cntId !== undefined ? [frame.bump(s.cntId)] : []),
          ...(heldId === undefined
            ? walk
            : [
                { kind: "varDecl", localId: heldId, init: done(), loc } as IrStmt,
                { kind: "assign", localId: doneId, value: boolLit(false, loc), loc } as IrStmt,
                ...walk,
                {
                  kind: "assign",
                  localId: doneId,
                  value: {
                    kind: "logical",
                    op: "||",
                    left: varRef(heldId, BOOL, loc),
                    right: done(),
                    type: BOOL,
                    loc,
                  },
                  loc,
                } as IrStmt,
              ]),
        ];
      };
    }
  }
  return emit;
}

/** The loop over a chain's source in local `itemsId`, running `emit` per
 * element until `done`: a live array (length re-read per pass), a Map or
 * Set walked live, or a generator driven like for-of (closed when the
 * loop leaves it unfinished). `labels` name the loop for a fused for-of
 * body's labeled jumps. */
function sourceLoop(
  lowerer: Lowerer,
  frame: ChainFrame,
  itemsId: string,
  source: ChainSource,
  doneId: string,
  emit: (value: IrExpr) => IrStmt[],
  loc: SrcLoc,
  labels?: string[],
): IrStmt[] {
  const done = (): IrExpr => varRef(doneId, BOOL, loc);
  if (source.kind === "collection")
    return walkCollection(lowerer, frame, itemsId, source, done(), emit, loc, labels);
  if (source.kind === "generator") {
    return driveGenerator(
      lowerer,
      frame,
      itemsId,
      source.type,
      source.elem,
      [{ kind: "if", cond: done(), then: [{ kind: "break", loc }], else_: null, loc }],
      emit,
      loc,
      labels,
    );
  }
  const itemsT = source.type;
  const seedT = source.proj === "entries" ? entryPairType(lowerer, itemsT.elem) : itemsT.elem;
  const iId = frame.local("i", F64, true);
  const vId = frame.local("v", seedT, false);
  const elemRead = (): IrExpr => ({
    kind: "arrayGet",
    arr: varRef(itemsId, itemsT, loc),
    index: varRef(iId, F64, loc),
    type: itemsT.elem,
    loc,
  });
  const seedInit: IrExpr =
    source.proj === "entries"
      ? {
          kind: "recordLit",
          fields: [
            { name: "0", value: varRef(iId, F64, loc) },
            { name: "1", value: elemRead() },
          ],
          type: seedT,
          loc,
        }
      : elemRead();
  return [
    {
      kind: "for",
      init: { kind: "varDecl", localId: iId, init: numLit(0, loc), loc },
      cond: {
        kind: "logical",
        op: "&&",
        left: {
          kind: "bin",
          op: "<",
          left: varRef(iId, F64, loc),
          right: {
            kind: "arrIntrinsic",
            method: "length",
            receiver: varRef(itemsId, itemsT, loc),
            args: [],
            type: F64,
            loc,
          },
          type: BOOL,
          loc,
        },
        right: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
        type: BOOL,
        loc,
      },
      update: frame.bump(iId),
      body: [
        { kind: "varDecl", localId: vId, init: seedInit, loc },
        ...emit(varRef(vId, seedT, loc)),
      ],
      ...(labels && { labels }),
      loc,
    },
  ];
}

/** The fused chain function: the source, each stage's budget or callback
 * and the terminal's arguments as parameters; one loop over the source
 * with the stages nested in it and the terminal's statements innermost.
 * A zero take budget marks done before the first pass: Node pulls nothing
 * through a take(0), and closes a generator source. */
function buildIterChainFn(
  lowerer: Lowerer,
  name: string,
  source: ChainSource,
  stages: StageIr[],
  terminal: string,
  termArgTs: IrType[],
  resultT: IrType,
  loc: SrcLoc,
): IrFunction {
  const frame = new LiftedFrame(loc);
  const itemsId = frame.param("items", source.type);
  const doneId = frame.local("done", BOOL, true);
  const setDone: IrStmt = { kind: "assign", localId: doneId, value: boolLit(true, loc), loc };
  // Parameters in call order: per-stage budget/callback, then terminal's.
  const slots = stages.map((s) =>
    stageSlot(frame, s, frame.param("budget" in s ? "n" : "f", "budget" in s ? F64 : s.fn.type)),
  );
  const termIds = termArgTs.map((t, i) => frame.param(i === 0 ? "tf" : "init", t));
  const termFnT =
    termArgTs[0]?.kind === "func" ? (termArgTs[0] as IrType & { kind: "func" }) : null;
  const termCntId =
    (terminal === "reduce" && termFnT !== null && termFnT.params.length === 3) ||
    (terminal !== "reduce" &&
      terminal !== "toArray" &&
      termFnT !== null &&
      termFnT.params.length === 2) ||
    terminal === "reduce"
      ? frame.local("k", F64, true)
      : undefined;
  // Terminal state.
  const preLoop: IrStmt[] = [];
  const postLoop: IrStmt[] = [];
  let outId = "";
  let accId = "";
  let hasAccId = "";
  let resId = "";
  if (terminal === "toArray") {
    outId = frame.local("out", resultT, false);
    preLoop.push({
      kind: "varDecl",
      localId: outId,
      init: { kind: "arrayLit", elems: [], type: resultT, loc },
      loc,
    });
    postLoop.push({ kind: "return", value: varRef(outId, resultT, loc), loc });
  } else if (terminal === "some" || terminal === "every") {
    resId = frame.local("res", BOOL, true);
    preLoop.push({
      kind: "varDecl",
      localId: resId,
      init: boolLit(terminal === "every", loc),
      loc,
    });
    postLoop.push({ kind: "return", value: varRef(resId, BOOL, loc), loc });
  } else if (terminal === "find") {
    resId = frame.local("res", resultT, true);
    const undef = lowerer.wrappedUndefined(resultT, loc);
    if (undef === null)
      throw new InternalCompilerError("lowerer bug: find result union lacks undefined");
    preLoop.push({ kind: "varDecl", localId: resId, init: undef, loc });
    postLoop.push({ kind: "return", value: varRef(resId, resultT, loc), loc });
  } else if (terminal === "reduce") {
    accId = frame.local("acc", resultT, true);
    if (termIds.length === 2) {
      preLoop.push({
        kind: "varDecl",
        localId: accId,
        init: varRef(termIds[1]!, resultT, loc),
        loc,
      });
    } else {
      hasAccId = frame.local("hasAcc", BOOL, true);
      preLoop.push({ kind: "varDecl", localId: hasAccId, init: boolLit(false, loc), loc });
      postLoop.push({
        kind: "if",
        cond: { kind: "unary", op: "!", operand: varRef(hasAccId, BOOL, loc), type: BOOL, loc },
        then: [
          throwTypeError(
            {
              kind: "strLit",
              value: "Reduce of a done iterator with no initial value",
              type: STRING,
              loc,
            },
            loc,
          ),
        ],
        else_: null,
        loc,
      });
    }
    postLoop.push({ kind: "return", value: varRef(accId, resultT, loc), loc });
  } else {
    postLoop.push({ kind: "return", value: null, loc });
  }
  if (termCntId !== undefined)
    preLoop.push({ kind: "varDecl", localId: termCntId, init: numLit(0, loc), loc });
  preLoop.unshift(...stagePrologue(slots, doneId, loc));
  // The terminal's per-element statements over `value`.
  const terminalBody = (value: IrExpr): IrStmt[] => {
    const out: IrStmt[] = [];
    if (terminal === "toArray") {
      out.push({
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "push",
          receiver: varRef(outId, resultT, loc),
          args: [value],
          type: F64,
          loc,
        },
        loc,
      });
    } else if (terminal === "forEach") {
      out.push({
        kind: "exprStmt",
        expr: callStage(termFnT!, termIds[0]!, value, termCntId, loc),
        loc,
      });
    } else if (terminal === "some" || terminal === "every") {
      const hit = callStage(termFnT!, termIds[0]!, value, termCntId, loc);
      const cond: IrExpr =
        terminal === "some" ? hit : { kind: "unary", op: "!", operand: hit, type: BOOL, loc };
      out.push({
        kind: "if",
        cond,
        then: [
          { kind: "assign", localId: resId, value: boolLit(terminal === "some", loc), loc },
          setDone,
        ],
        else_: null,
        loc,
      });
    } else if (terminal === "find") {
      const undefTag = resultT.kind === "union" ? lowerer.armTag(resultT.unionId, UNDEFINED_T) : -1;
      const valueTag = resultT.kind === "union" ? (undefTag === 0 ? 1 : 0) : -1;
      if (resultT.kind !== "union" || valueTag < 0)
        throw new InternalCompilerError(
          "lowerer bug: find result is not the undefined-armed union",
        );
      out.push({
        kind: "if",
        cond: callStage(termFnT!, termIds[0]!, value, termCntId, loc),
        then: [
          {
            kind: "assign",
            localId: resId,
            value: {
              kind: "unionWrap",
              unionId: resultT.unionId,
              tag: valueTag,
              value,
              type: resultT,
              loc,
            },
            loc,
          },
          setDone,
        ],
        else_: null,
        loc,
      });
    } else {
      // reduce
      const reducer = (): IrExpr => {
        const args: IrExpr[] = [varRef(accId, resultT, loc), value];
        if (termFnT!.params.length === 3) args.push(varRef(termCntId!, F64, loc));
        return {
          kind: "callValue",
          callee: varRef(termIds[0]!, termFnT!, loc),
          args,
          type: resultT,
          loc,
        };
      };
      if (hasAccId !== "") {
        out.push({
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(hasAccId, BOOL, loc), type: BOOL, loc },
          then: [
            { kind: "assign", localId: accId, value, loc },
            { kind: "assign", localId: hasAccId, value: boolLit(true, loc), loc },
          ],
          else_: [{ kind: "assign", localId: accId, value: reducer(), loc }],
          loc,
        });
      } else {
        out.push({ kind: "assign", localId: accId, value: reducer(), loc });
      }
    }
    if (termCntId !== undefined) out.push(frame.bump(termCntId));
    return out;
  };
  const emit = foldStages(lowerer, frame, slots, terminalBody, doneId, loc);
  return {
    name,
    params: frame.params,
    returnType: resultT,
    locals: frame.locals,
    body: [
      ...preLoop,
      ...sourceLoop(lowerer, frame, itemsId, source, doneId, emit, loc),
      ...postLoop,
    ],
    loc,
  };
}

/** An iterator helper object's generator for one stage over `src`:
 *
 *   map:     for (v of src) yield f(v, c++)
 *   filter:  for (v of src) if (f(v, c++)) yield v
 *   take:    for (;;) { if (rem === 0) { close src; return } rem--; pull; yield v }
 *   drop:    for (v of src) { if (dropped < n) { dropped++; continue } yield v }
 *   flatMap: for (v of src) for (w of f(v, c++)) yield w
 *
 * The source drive closes `src` on every early exit, including a
 * `return()` at one of the yields; `closesSource` closes it on a
 * `return()` before the first `next()`. */
function buildHelperGenFn(
  lowerer: Lowerer,
  name: string,
  source: (ChainSource & { kind: "generator" }) | (ChainSource & { kind: "collection" }),
  srcElem: IrType,
  stage: StageIr,
  argT: IrType,
  outT: GenType,
  resultType: IrType & { kind: "record" },
  loc: SrcLoc,
): IrFunction {
  const frame = new LiftedFrame(loc);
  const srcId = frame.param("src", source.type);
  const argId = frame.param(stage.kind === "take" || stage.kind === "drop" ? "n" : "f", argT);
  const drive = (pre: IrStmt[], each: (value: IrExpr) => IrStmt[], at: SrcLoc): IrStmt[] =>
    source.kind === "generator"
      ? driveGenerator(lowerer, frame, srcId, source.type, srcElem, pre, each, at)
      : driveCollectionNative(lowerer, frame, srcId, source, pre, each, at);
  const yieldOf = (value: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "yieldExpr",
      value,
      type: outT.nextT.kind === "undefinedT" ? VOID : outT.nextT,
      loc,
    },
    loc,
  });
  const fnT = argT.kind === "func" ? argT : null;
  const counted = fnT !== null && fnT.params.length === 2;
  const cntId = counted ? frame.local("c", F64, true) : null;
  const callF = (value: IrExpr): IrExpr => {
    const args: IrExpr[] = [];
    if (fnT!.params.length >= 1) args.push(value);
    if (cntId !== null) args.push(varRef(cntId, F64, loc));
    return { kind: "callValue", callee: varRef(argId, fnT!, loc), args, type: fnT!.ret, loc };
  };
  const body: IrStmt[] = [];
  if (cntId !== null) body.push({ kind: "varDecl", localId: cntId, init: numLit(0, loc), loc });
  const bumpCount = (): IrStmt[] => (cntId !== null ? [frame.bump(cntId)] : []);
  const n = (): IrExpr => varRef(argId, F64, loc);
  if (stage.kind === "map") {
    body.push(
      ...drive(
        [],
        (value) => {
          const mId = frame.local("m", fnT!.ret, false);
          return [
            { kind: "varDecl", localId: mId, init: callF(value), loc },
            ...bumpCount(),
            yieldOf(varRef(mId, fnT!.ret, loc)),
          ];
        },
        loc,
      ),
    );
  } else if (stage.kind === "filter") {
    body.push(
      ...drive(
        [],
        (value) => {
          const okId = frame.local("ok", BOOL, false);
          return [
            { kind: "varDecl", localId: okId, init: callF(value), loc },
            ...bumpCount(),
            { kind: "if", cond: varRef(okId, BOOL, loc), then: [yieldOf(value)], else_: null, loc },
          ];
        },
        loc,
      ),
    );
  } else if (stage.kind === "take") {
    // The budget is spent before each pull; a spent budget closes the
    // source on the next pass instead of pulling.
    const pre: IrStmt[] = [
      {
        kind: "if",
        cond: { kind: "bin", op: "===", left: n(), right: numLit(0, loc), type: BOOL, loc },
        then: [{ kind: "break", loc }],
        else_: null,
        loc,
      },
      {
        kind: "assign",
        localId: argId,
        value: { kind: "bin", op: "-", left: n(), right: numLit(1, loc), type: F64, loc },
        loc,
      },
    ];
    body.push(...drive(pre, (value) => [yieldOf(value)], loc));
  } else if (stage.kind === "drop") {
    const droppedId = frame.local("dropped", F64, true);
    body.push({ kind: "varDecl", localId: droppedId, init: numLit(0, loc), loc });
    body.push(
      ...drive(
        [],
        (value) => [
          {
            kind: "if",
            cond: {
              kind: "bin",
              op: "<",
              left: varRef(droppedId, F64, loc),
              right: n(),
              type: BOOL,
              loc,
            },
            then: [frame.bump(droppedId), { kind: "continue", loc }],
            else_: null,
            loc,
          },
          yieldOf(value),
        ],
        loc,
      ),
    );
  } else {
    body.push(
      ...drive(
        [],
        (value) => {
          const innerT = fnT!.ret;
          const innerId = frame.local("fm", innerT, false);
          return [
            { kind: "varDecl", localId: innerId, init: callF(value), loc },
            ...bumpCount(),
            ...walkInner(lowerer, frame, innerId, innerT, null, (w) => [yieldOf(w)], loc),
          ];
        },
        loc,
      ),
    );
  }
  body.push({ kind: "return", value: null, loc });
  return {
    name,
    params: frame.params,
    returnType: VOID,
    locals: frame.locals,
    body,
    generator: {
      yieldT: outT.yieldT,
      nextT: outT.nextT,
      resultType,
      tag: "Iterator Helper",
      // A native Map or Set iterator has no return() to call.
      ...(source.kind === "generator" ? { closesSource: true as const } : {}),
    },
    loc,
  };
}
