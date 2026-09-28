import { InternalCompilerError } from "../../errors.js";
/* Generator lowering: yield / yield* expressions, the consumer surface
 * (.next/.return/.throw → genResume), and the for-of-over-generator
 * desugar. The design: a generator body is an ordinary
 * compiled function on a fiber created suspended; the consumer resumes it
 * synchronously and every resume answers the interned IteratorResult
 * record genResultRecord builds — one shape per channel pair, shared with
 * mapType's IteratorResult alias mapping so unannotated `const r =
 * g.next()` binds and reads flow. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, DYN, IrExpr, IrStmt, IrType, SrcLoc, UNDEFINED_T, VOID, isUnitType, typeEquals } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { genResultRecord } from "../type-mapper.js";
import { forOfVarTarget, lowerDestructuringAssign } from "./lower-stmts.js";

export type GenType = IrType & { kind: "generator" };

/** The interned IteratorResult record of a generator type (never null for
 * a MAPPED generator — mapType required it to intern). */
function resultRecordOf(lowerer: Lowerer, genT: GenType): IrType & { kind: "record" } {
  const rec = genResultRecord(genT.yieldT, genT.retT, lowerer.shapes, lowerer.unions);
  if (!rec) throw new InternalCompilerError("lowerer bug: mapped generator without a result record");
  return rec;
}

/** The undefined value coerced into a yield/return channel — `yield;`,
 * `.return()`'s absent argument evaluated as a value. Null when the
 * channel cannot hold undefined. */
function channelUndefined(lowerer: Lowerer, channel: IrType, loc: SrcLoc): IrExpr | null {
  if (channel.kind === "dyn") {
    return {
      kind: "dynFrom",
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: DYN,
      loc,
    };
  }
  if (channel.kind === "union") return lowerer.wrappedUndefined(channel, loc);
  return null;
}

/** `yield e` / `yield;` — only inside a generator body the signature
 * collection accepted (lowerer.ctx.generator carries the channels). `yield*`
 * lowers in STATEMENT position only (lowerYieldStarStatement — the value
 * of a delegation needs the whole forwarding loop in expression position,
 * which has no lowering yet). */
export function lowerYield(lowerer: Lowerer, expr: ts.YieldExpression): IrExpr {
  const loc = locOf(expr);
  const gen = lowerer.ctx.generator;
  if (!gen) {
    // A yield in a body this compiler did not lower as a generator (for
    // example a comptime callback) — the blanket fence.
    lowerer.unsupported("SC1071", expr);
  }
  if (expr.asteriskToken) {
    lowerer.unsupported(
      "SC1071",
      expr,
      "the value of 'yield*' (statement-position delegation compiles: 'yield* inner();' — bind the delegate's return value through its .next() protocol instead)",
    );
  }
  let value: IrExpr;
  let awaited = false;
  if (expr.expression) {
    const raw = lowerer.lowerExpr(expr.expression);
    if (lowerer.ctx.isAsync && raw.type.kind === "promise") {
      const awaitedValue: IrExpr = { kind: "awaitExpr", value: raw, type: raw.type.inner, loc: raw.loc };
      value = lowerer.coerceInto(expr.expression, awaitedValue, gen.yieldT);
      // AsyncGeneratorYield itself awaits its operand. The explicit IR
      // await above performs that one required hop; the runtime must settle
      // in the same continuation instead of inserting another.
      awaited = true;
    } else {
      value = lowerer.coerceInto(expr.expression, raw, gen.yieldT);
    }
  } else {
    const u = channelUndefined(lowerer, gen.yieldT, loc);
    if (!u) {
      lowerer.unsupported(
        "SC1071",
        expr,
        `a bare 'yield;' on a '${lowerer.fmt(gen.yieldT)}' yield channel (it would yield undefined — yield a value)`,
      );
    }
    value = u;
  }
  // An undefined next-channel means the resumed value is always undefined:
  // the expression is void (statement position; the checker types reads of
  // it undefined, whose uses fence downstream).
  const type = gen.nextT.kind === "undefinedT" ? VOID : gen.nextT;
  return { kind: "yieldExpr", value, ...(awaited ? { awaited: true as const } : {}), type, loc };
}

/** `g.next(v)` / `g.return(v)` / `g.throw(e)` on a generator-typed
 * receiver → genResume. Null when this is not that call (the dispatch
 * chain moves on). */
export function lowerGenMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  if (name !== "next" && name !== "return" && name !== "throw") return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "generator") return null;
  if (call.arguments.some(ts.isSpreadElement)) {
    lowerer.unsupported("SC1090", call, "spread arguments");
  }
  const loc = locOf(call);
  const gen = lowerer.lowerExpr(access.expression);
  if (gen.type.kind !== "generator") return null;
  const genT = gen.type;
  const recT = resultRecordOf(lowerer, genT);
  const resultT: IrType = genT.async ? { kind: "promise", inner: recT } : recT;
  const argNode = call.arguments[0];
  let arg: IrExpr | null = null;
  if (name === "next") {
    if (argNode === undefined) {
      if (genT.nextT.kind !== "undefinedT" && genT.nextT.kind !== "dyn") {
        lowerer.unsupported(
          "SC1071",
          call,
          `a valueless .next() on a '${lowerer.fmt(genT.nextT)}' next channel (it would deliver undefined into a typed yield — pass .next(value))`,
        );
      }
      arg = null; // the runtime sends undefined
    } else if (genT.nextT.kind === "undefinedT") {
      // `.next(undefined)` on a valueless channel: the literal is a no-op;
      // anything effectful has no evaluate-then-drop slot here.
      const lowered = lowerer.lowerExpr(argNode);
      if (lowered.kind !== "unitLit") {
        lowerer.unsupported(
          "SC1071",
          call,
          ".next(value) on a generator that never reads resumed values (call .next() with no argument)",
        );
      }
      arg = null;
    } else {
      arg = lowerer.lowerExprExpecting(argNode, genT.nextT);
    }
  } else if (name === "return") {
    if (argNode === undefined) {
      arg = null; // undefined done-value
    } else if (genT.retT.kind === "void") {
      lowerer.unsupported(
        "SC1071",
        call,
        ".return(value) on a generator whose return type carries no value (call .return() with no argument)",
      );
    } else {
      arg = lowerer.lowerExprExpecting(argNode, genT.retT);
    }
  } else {
    if (argNode === undefined) {
      lowerer.unsupported(
        "SC1071",
        call,
        ".throw() with no argument (Node would throw undefined into the generator — pass the error)",
      );
    }
    arg = lowerer.lowerExpr(argNode);
    if (arg.type.kind === "date") {
      lowerer.unsupported(
        "SC1090",
        argNode,
        ".throw() with a Date value (the exception channel cannot preserve Date's object kind; throw an Error or primitive instead)",
      );
    }
    if (
      arg.type.kind === "void" ||
      arg.type.kind === "dyn" ||
      arg.type.kind === "caught" ||
      isUnitType(arg.type)
    ) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `.throw() of a '${lowerer.fmt(arg.type)}' value (throw numbers, strings, booleans, or Error instances)`,
      );
    }
  }
  return { kind: "genResume", mode: name, gen, arg, type: resultT, loc };
}

/** Extraction of a suspended resume's yield value out of the result
 * record's V slot, typed back to the yield channel: V IS the channel for
 * dyn (and for a union channel already equal to V); a non-union channel
 * narrows to its arm (sound by construction — done was just tested
 * false, so the slot holds a yield-channel value); a union channel
 * re-tags through the retag helper with the non-channel arms marked
 * trappable (the same proved-away contract, proved here by the desugar's
 * own done test). Null when no extraction exists. */
export function extractIteratorValue(
  lowerer: Lowerer,
  yieldT: IrType,
  valueT: IrType,
  read: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  const yt = yieldT;
  if (valueT.kind === "dyn") return read; // the dyn channel: V IS the value
  if (valueT.kind !== "union") return null;
  if (typeEquals(valueT, yt)) return read;
  if (yt.kind !== "union") {
    const tag = lowerer.armTag(valueT.unionId, yt);
    if (tag < 0) return null;
    return { kind: "unionNarrow", unionId: valueT.unionId, tag, value: read, type: yt, loc };
  }
  const vDef = lowerer.unions.get(valueT.unionId);
  if (!vDef) return null;
  const trappable = new Set<number>();
  vDef.arms.forEach((arm, i) => {
    if (lowerer.armTag(yt.unionId, arm) < 0) trappable.add(i);
  });
  const helper = lowerer.unionRetagHelper(valueT.unionId, yt.unionId, loc, trappable);
  if (!helper) return null;
  return { kind: "call", callee: helper, args: [read], type: yt, loc };
}

function generatorLoopBinding(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  value: IrExpr,
  valueType: IrType,
): IrStmt[] {
  const loc = locOf(stmt.initializer);
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    let target: ts.Node = stmt.initializer;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) {
      const writable = lowerer.resolveWritable(target);
      if (!writable) lowerer.rejectUnresolved(target, "assignment to an unresolved loop binding");
      return [{
        kind: "assign",
        localId: writable.id,
        value: lowerer.coerceInto(target, value, writable.type),
        loc,
      }];
    }
    if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
      const temp = lowerer.declareHiddenLocal("%genValue", valueType);
      const ref: IrExpr = { kind: "varRef", localId: temp.id, type: valueType, loc };
      return [
        { kind: "varDecl", localId: temp.id, init: value, loc },
        lowerDestructuringAssign(lowerer, target, ref, target, loc),
      ];
    }
    lowerer.unsupported("SC1090", stmt.initializer, "for-of assignment to this target");
  }
  const list = stmt.initializer;
  const decl = list.declarations[0]!;
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
  if (ts.isIdentifier(decl.name)) {
    const varTarget = forOfVarTarget(lowerer, decl);
    const bound = varTarget
      ? lowerer.declareHiddenLocal("%genValue", valueType)
      : lowerer.declareLocal(decl.name, decl.name.text, valueType, isLet);
    const out: IrStmt[] = [{ kind: "varDecl", localId: bound.id, init: value, loc }];
    if (varTarget) {
      out.push({
        kind: "assign",
        localId: varTarget.id,
        value: lowerer.coerceInto(decl.name, { kind: "varRef", localId: bound.id, type: valueType, loc }, varTarget.type),
        loc,
      });
    }
    return out;
  }
  if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
    const temp = lowerer.declareHiddenLocal("%genValue", valueType);
    const out: IrStmt[] = [{ kind: "varDecl", localId: temp.id, init: value, loc }];
    lowerer.lowerBindingPattern(
      decl.name,
      () => ({ kind: "varRef", localId: temp.id, type: valueType, loc }),
      valueType,
      isLet,
      out,
    );
    return out;
  }
  lowerer.unsupported("SC1031", decl.name);
}

/** `for (const x of gen)` — the desugared drive:
 *
 *   { const %gof = <iterable>; let %gdone = false;
 *     while (true) {
 *       const %gr = %gof.next();            // genResume
 *       if (%gr.done) { %gdone = true; break; }
 *       const x = <extract %gr.value>;
 *       <body>
 *     }
 *     if (!%gdone) %gof.return();           // IteratorClose
 *   }
 *
 * `break` exits the while and lands on the close check (probed: break
 * closes the generator — finallys run, the return value is discarded);
 * `continue` stays in the loop; exhaustion skips the close. A consumer
 * `return`/`throw` abandoning the loop does NOT close (numbered
 * divergence — the desugar cannot ride a finally, whose regions reject
 * the loop's own break). */
export function lowerForOfGenerator(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr & { type: GenType },
  labels?: string[],
): IrStmt {
  if (iterable.type.async) {
    lowerer.unsupported("SC1070", stmt.expression, "synchronous for-of over an async generator (use 'for await')");
  }
  if (ts.isVariableDeclarationList(stmt.initializer) && (stmt.initializer.flags & ts.NodeFlags.Using) !== 0) {
    lowerer.unsupported("SC1090", stmt.initializer, "'using' declarations (dispose-at-scope-exit semantics)");
  }
  const genT = iterable.type;
  if (genT.yieldT.kind === "void") {
    lowerer.unsupported(
      "SC1090",
      stmt.expression,
      "for-of over a generator that never yields (its element type is never)",
    );
  }
  if (genT.nextT.kind !== "undefinedT" && genT.nextT.kind !== "dyn") {
    lowerer.unsupported(
      "SC1090",
      stmt.expression,
      `for-of over a generator whose yields expect .next(value) ('${lowerer.fmt(genT.nextT)}' — drive it with .next() calls instead)`,
    );
  }
  const loc = locOf(stmt);
  const recT = resultRecordOf(lowerer, genT);
  const shape = lowerer.shapes.get(recT.shapeId)!;
  const valueT = shape.fields.find((f) => f.name === "value")!.type;
  lowerer.scopes.push(new Map());
  try {
    const g = lowerer.declareHiddenLocal("%gof", genT);
    const done = lowerer.declareHiddenLocal("%gdone", BOOL);
    done.mutable = true;
    const r = lowerer.declareHiddenLocal("%gres", recT);
    const gRef = (): IrExpr => ({ kind: "varRef", localId: g.id, type: genT, loc });
    const rRef = (): IrExpr => ({ kind: "varRef", localId: r.id, type: recT, loc });
    const valueRead: IrExpr = { kind: "recordGet", obj: rRef(), shapeId: recT.shapeId, field: "value", type: valueT, loc };
    const extracted = extractIteratorValue(lowerer, genT.yieldT, valueT, valueRead, loc);
    if (!extracted) {
      lowerer.unsupported(
        "SC1090",
        stmt.expression,
        `for-of over a generator yielding '${lowerer.fmt(genT.yieldT)}' (no per-element extraction exists — drive it with .next() and narrow r.value)`,
      );
    }
    const head: IrStmt[] = [
      {
        kind: "varDecl",
        localId: r.id,
        init: { kind: "genResume", mode: "next", gen: gRef(), arg: null, type: recT, loc },
        loc,
      },
      {
        kind: "if",
        cond: {
          kind: "recordGet",
          obj: rRef(),
          shapeId: recT.shapeId,
          field: "done",
          type: BOOL,
          loc,
        },
        then: [
          { kind: "assign", localId: done.id, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
          { kind: "break", loc },
        ],
        else_: null,
        loc,
      },
      ...generatorLoopBinding(lowerer, stmt, extracted, genT.yieldT),
    ];
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement), labels);
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: g.id, init: iterable, loc },
        { kind: "varDecl", localId: done.id, init: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: [...head, ...body],
          ...(labels && { labels }),
          loc,
        },
        // IteratorClose: an early exit (break) closes the generator —
        // finallys run; the .return() result record is dropped.
        {
          kind: "if",
          cond: {
            kind: "unary",
            op: "!",
            operand: { kind: "varRef", localId: done.id, type: BOOL, loc },
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "exprStmt",
              expr: { kind: "genResume", mode: "return", gen: gRef(), arg: null, type: recT, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

/** `for await (const x of asyncGen)` — the async sibling of
 * lowerForOfGenerator. Each resume produces Promise<IteratorResult>, so
 * the loop awaits it before testing done and extracting the typed value.
 * Early break awaits `.return()` to run the generator's finally blocks. */
export function lowerForAwaitGenerator(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr & { type: GenType },
  labels?: string[],
): IrStmt {
  if (!iterable.type.async) {
    lowerer.unsupported("SC1070", stmt.expression, "for-await over this synchronous generator");
  }
  if (!lowerer.ctx.isAsync) {
    lowerer.unsupported("SC1090", stmt, "top-level 'for await' (await outside async functions)");
  }
  if (ts.isVariableDeclarationList(stmt.initializer) && (stmt.initializer.flags & ts.NodeFlags.Using) !== 0) {
    lowerer.unsupported("SC1090", stmt.initializer, "'await using' loop bindings over async generators");
  }
  const genT = iterable.type;
  if (genT.yieldT.kind === "void") {
    lowerer.unsupported("SC1090", stmt.expression, "for-await over an async generator that never yields");
  }
  if (genT.nextT.kind !== "undefinedT" && genT.nextT.kind !== "dyn") {
    lowerer.unsupported(
      "SC1090",
      stmt.expression,
      `for-await over an async generator whose yields expect .next(value) ('${lowerer.fmt(genT.nextT)}' — drive it with .next() calls instead)`,
    );
  }
  const loc = locOf(stmt);
  const recT = resultRecordOf(lowerer, genT);
  const promiseT: IrType = { kind: "promise", inner: recT };
  const shape = lowerer.shapes.get(recT.shapeId)!;
  const valueT = shape.fields.find((f) => f.name === "value")!.type;
  lowerer.scopes.push(new Map());
  try {
    const g = lowerer.declareHiddenLocal("%fag", genT);
    const done = lowerer.declareHiddenLocal("%fagdone", BOOL);
    done.mutable = true;
    const p = lowerer.declareHiddenLocal("%fagpromise", promiseT);
    const r = lowerer.declareHiddenLocal("%fagresult", recT);
    const gRef = (): IrExpr => ({ kind: "varRef", localId: g.id, type: genT, loc });
    const rRef = (): IrExpr => ({ kind: "varRef", localId: r.id, type: recT, loc });
    const valueRead: IrExpr = { kind: "recordGet", obj: rRef(), shapeId: recT.shapeId, field: "value", type: valueT, loc };
    const extracted = extractIteratorValue(lowerer, genT.yieldT, valueT, valueRead, loc);
    if (!extracted) {
      lowerer.unsupported(
        "SC1090",
        stmt.expression,
        `for-await over an async generator yielding '${lowerer.fmt(genT.yieldT)}' (no per-element extraction exists)`,
      );
    }
    const head: IrStmt[] = [
      {
        kind: "varDecl",
        localId: p.id,
        init: { kind: "genResume", mode: "next", gen: gRef(), arg: null, type: promiseT, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: r.id,
        init: {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: p.id, type: promiseT, loc },
          type: recT,
          loc,
        },
        loc,
      },
      {
        kind: "if",
        cond: { kind: "recordGet", obj: rRef(), shapeId: recT.shapeId, field: "done", type: BOOL, loc },
        then: [
          { kind: "assign", localId: done.id, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
          { kind: "break", loc },
        ],
        else_: null,
        loc,
      },
      ...generatorLoopBinding(lowerer, stmt, extracted, genT.yieldT),
    ];
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement), labels);
    const closePromise: IrExpr = { kind: "genResume", mode: "return", gen: gRef(), arg: null, type: promiseT, loc };
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: g.id, init: iterable, loc },
        { kind: "varDecl", localId: done.id, init: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: [...head, ...body],
          ...(labels && { labels }),
          loc,
        },
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: { kind: "varRef", localId: done.id, type: BOOL, loc }, type: BOOL, loc },
          then: [
            {
              kind: "exprStmt",
              expr: { kind: "awaitExpr", value: closePromise, type: recT, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

/** Statement-position `yield* e;` — the forwarding loop:
 *
 *   { const %dele = <e>; let %dr = %dele.next();
 *     while (!%dr.done) { %dr = %dele.next(<yield %dr.value>); } }
 *
 * The inner yield value re-yields out of the OUTER generator (coerced
 * across the channels); the consumer's `.next(v)` argument forwards into
 * the delegate; the delegate's return value is this statement's dropped
 * result. Consumer `.return()`/`.throw()` while suspended here unwinds
 * the OUTER generator without forwarding to the delegate (numbered
 * divergence). Null when this is not a yield* statement. */
export function lowerYieldStarStatement(lowerer: Lowerer, expr: ts.Expression): IrStmt | null {
  if (!ts.isYieldExpression(expr) || expr.asteriskToken === undefined) return null;
  const gen = lowerer.ctx.generator;
  if (!gen) lowerer.unsupported("SC1071", expr);
  if (lowerer.ctx.isAsync) {
    lowerer.unsupported(
      "SC1071",
      expr,
      "'yield*' in async generators (use 'for await' and yield each value explicitly)",
    );
  }
  if (!expr.expression) lowerer.unsupported("SC1071", expr, "'yield*' with no operand");
  const loc = locOf(expr);
  const delegate = lowerer.lowerExpr(expr.expression);
  if (delegate.type.kind !== "generator") {
    lowerer.unsupported(
      "SC1071",
      expr,
      `'yield*' over '${lowerer.fmt(delegate.type)}' (only generator delegates have a lowering — spell out the loop for other iterables)`,
    );
  }
  const dT = delegate.type;
  if (dT.nextT.kind !== "undefinedT" && dT.nextT.kind !== "dyn" && !typeEquals(dT.nextT, gen.nextT)) {
    lowerer.unsupported(
      "SC1071",
      expr,
      `'yield*' into a '${lowerer.fmt(dT.nextT)}' next channel from a '${gen.nextT.kind === "undefinedT" ? "undefined" : lowerer.fmt(gen.nextT)}' one (the consumer's .next(v) cannot forward across these channels)`,
    );
  }
  const recT = resultRecordOf(lowerer, dT);
  const shape = lowerer.shapes.get(recT.shapeId)!;
  const valueT = shape.fields.find((f) => f.name === "value")!.type;
  lowerer.scopes.push(new Map());
  try {
    const d = lowerer.declareHiddenLocal("%dele", dT);
    const r = lowerer.declareHiddenLocal("%dres", recT);
    r.mutable = true;
    const dRef = (): IrExpr => ({ kind: "varRef", localId: d.id, type: dT, loc });
    const rRef = (): IrExpr => ({ kind: "varRef", localId: r.id, type: recT, loc });
    const valueRead: IrExpr = { kind: "recordGet", obj: rRef(), shapeId: recT.shapeId, field: "value", type: valueT, loc };
    const inner = extractIteratorValue(lowerer, dT.yieldT, valueT, valueRead, loc);
    if (!inner) {
      lowerer.unsupported(
        "SC1071",
        expr,
        `'yield*' over a generator yielding '${lowerer.fmt(dT.yieldT)}' (no per-element extraction exists)`,
      );
    }
    // The re-yield: the delegate's value coerced into the outer yield
    // channel; the resumed value (outer nextT) forwards into the
    // delegate's next slot (or drops on an undefined channel).
    const reYield: IrExpr = {
      kind: "yieldExpr",
      value: typeEquals(dT.yieldT, gen.yieldT) && typeEquals(inner.type, gen.yieldT)
        ? inner
        : lowerer.coerceInto(expr.expression!, inner, gen.yieldT),
      type: gen.nextT.kind === "undefinedT" ? VOID : gen.nextT,
      loc,
    };
    let forwarded: IrExpr | null;
    if (dT.nextT.kind === "undefinedT") {
      forwarded = null; // reYield still evaluates as the arg? no — see below
    } else if (reYield.type.kind === "void") {
      forwarded = null;
    } else if (dT.nextT.kind === "dyn" && reYield.type.kind !== "dyn") {
      forwarded = { kind: "dynFrom", value: reYield, type: DYN, loc };
    } else {
      forwarded = reYield;
    }
    const resumeArg: IrExpr | null = forwarded;
    // When the yield's value cannot ride the resume argument (undefined
    // channels), it must still EXECUTE before the delegate resumes: the
    // loop body becomes [exprStmt(yield), assign(next)].
    const loopBody: IrStmt[] =
      resumeArg === null
        ? [
            { kind: "exprStmt", expr: reYield, loc } satisfies IrStmt,
            {
              kind: "assign",
              localId: r.id,
              value: { kind: "genResume", mode: "next", gen: dRef(), arg: null, type: recT, loc },
              loc,
            },
          ]
        : [
            {
              kind: "assign",
              localId: r.id,
              value: { kind: "genResume", mode: "next", gen: dRef(), arg: resumeArg, type: recT, loc },
              loc,
            },
          ];
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: d.id, init: delegate, loc },
        {
          kind: "varDecl",
          localId: r.id,
          init: { kind: "genResume", mode: "next", gen: dRef(), arg: null, type: recT, loc },
          loc,
        },
        {
          kind: "while",
          cond: {
            kind: "unary",
            op: "!",
            operand: { kind: "recordGet", obj: rRef(), shapeId: recT.shapeId, field: "done", type: BOOL, loc },
            type: BOOL,
            loc,
          },
          body: loopBody,
          loc,
        },
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}
