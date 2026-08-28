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
import { forOfVarTarget } from "./lower-stmts.js";

type GenType = IrType & { kind: "generator" };

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
    // A yield in a body this compiler did not lower as a generator (an
    // async generator's, a comptime callback's) — the blanket fence.
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
  if (expr.expression) {
    value = lowerer.lowerExprExpecting(expr.expression, gen.yieldT);
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
  return { kind: "yieldExpr", value, type, loc };
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
  return { kind: "genResume", mode: name, gen, arg, type: recT, loc };
}

/** Extraction of a suspended resume's yield value out of the result
 * record's V slot, typed back to the yield channel: V IS the channel for
 * dyn (and for a union channel already equal to V); a non-union channel
 * narrows to its arm (sound by construction — done was just tested
 * false, so the slot holds a yield-channel value); a union channel
 * re-tags through the retag helper with the non-channel arms marked
 * trappable (the same proved-away contract, proved here by the desugar's
 * own done test). Null when no extraction exists. */
function extractYieldValue(
  lowerer: Lowerer,
  genT: GenType,
  valueT: IrType,
  read: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  const yt = genT.yieldT;
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
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    lowerer.unsupported(
      "SC1090",
      stmt.initializer,
      "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
    );
  }
  const list = stmt.initializer;
  if ((list.flags & ts.NodeFlags.Using) !== 0) {
    lowerer.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
  }
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
  const decl = list.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) lowerer.unsupported("SC1031", decl.name);
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
    const extracted = extractYieldValue(lowerer, genT, valueT, valueRead, loc);
    if (!extracted) {
      lowerer.unsupported(
        "SC1090",
        stmt.expression,
        `for-of over a generator yielding '${lowerer.fmt(genT.yieldT)}' (no per-element extraction exists — drive it with .next() and narrow r.value)`,
      );
    }
    // `for (var x of gen)`: the mechanics stay on a hidden per-iteration
    // local; the body opens by assigning into the hoisted var binding.
    const varTarget = forOfVarTarget(lowerer, decl);
    const x = varTarget
      ? lowerer.declareHiddenLocal("%vof", genT.yieldT)
      : lowerer.declareLocal(decl.name, decl.name.text, genT.yieldT, isLet);
    const xRef: IrExpr = { kind: "varRef", localId: x.id, type: genT.yieldT, loc };
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
      { kind: "varDecl", localId: x.id, init: extracted, loc },
      ...(varTarget
        ? [{ kind: "assign", localId: varTarget.id, value: lowerer.coerceInto(decl.name, xRef, varTarget.type), loc } satisfies IrStmt]
        : []),
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
    const inner = extractYieldValue(lowerer, dT, valueT, valueRead, loc);
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
