import { isNavigatorGlobal } from "../builtins/navigator.js";
import { isSafeToDiscard } from "./evaluation-safety.js";
import { completeFuncValueArgs } from "../call-arguments.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { DYN, STRING, UNDEFINED_T, VOID, isUnitType, typeEquals } from "../../../ir/ir.js";
import type { IrExpr, IrStmt, SrcLoc } from "../../../ir/ir.js";
import { isNodeEsmFile, locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { constituentTypes } from "../../ts7/checker.js";

/** One optional-chain STEP: `a?.b`, `a?.m(...)`, `a?.[i]` (the token on
 * the member access) and `f?.()` (the token on the call). The receiver
 * lowers once; when it is a unit-armed union, the
 * member/call lowers exactly as its non-optional spelling would — the
 * receiver node reads back as the chain's bound narrowed value
 * (chainRecv) and types as its non-nullish type — and the whole thing
 * becomes an optChain node: tag test, undefined on the unit path (JS:
 * null receivers still yield undefined), the body lazily otherwise,
 * argument side effects included. A receiver the checker types
 * never-nullish makes `?.` behave exactly like `.` — the guard folds
 * away and the plain lowering is the value (trust-the-checker, like
 * ??'s fold). Multi-step TAILS (`a?.b.c`, `x?.trim().toLowerCase()`)
 * short-circuit whole: the guarded member step is the chain's dot and
 * every later step lowers inside the guard, checker-narrowed non-nullish
 * (see chainTailDot). Multiple present variants keep their tag until the
 * guarded body retags them to the non-nullish receiver type. */
/** The unhandled `?.`-carrying MEMBER step in this node's receiver
 * spine, when the node is the TAIL of an optional chain whose token sits
 * deeper — `x?.trim().toLowerCase()` reads nothing past the guard when x
 * is nullish, so the whole tail must lower inside it. Walks
 * property/element accesses and call steps only (parens and `!` break
 * the chain per the grammar: `(a?.b).c` throws on undefined in JS, while
 * an unparenthesized `a?.b!.c` stays one chain, as TypeScript emits it);
 * the node's OWN token — and a call's immediate callee token — are the
 * plain entries' cases, not tails, and handled markers make the chain
 * lowering's re-dispatch walk past its own step. `f?.()` steps stay out
 * (a call carrying the token has no member step to re-enter — the
 * split-it fence keeps them). */
function chainTailDot(
  lowerer: Lowerer,
  expr: ts.Expression,
): ts.PropertyAccessExpression | ts.ElementAccessExpression | null {
  let cur: ts.Expression = expr;
  for (;;) {
    // An active chain's bound receiver read is a LEAF — its own token
    // was consumed by the chain that bound it.
    if (lowerer.chainRecvByNode.has(cur)) return null;
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      // `f?.()` steps route through their own entry (or are being
      // handled); a deeper token under one is that chain's business.
      if (cur.questionDotToken) return null;
      cur = cur.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      if (cur.questionDotToken) {
        // The node's own token and a call's immediate callee token are
        // the plain entries' cases; a handled one is mid-re-dispatch
        // (its receiver read, further down, ends the walk). The walk
        // NEVER continues past an unhandled deeper token: that guard is
        // where this tail's chain enters — anything below it belongs to
        // the receiver's own (nested) chain.
        if (cur === expr || lowerer.chainHandled.has(cur)) {
          cur = cur.expression;
          continue;
        }
        if (ts.isCallExpression(expr) && expr.expression === cur) return null;
        return cur;
      }
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

/** True when `expr` is `require.main.filename` (either dot optional) on
 * the AMBIENT CommonJS require — the entry-module identity read. The
 * value is the ENTRY file's path, a compile-time constant like
 * __filename; ESM files stay out (Node never defines require there —
 * the ambient symbol would not resolve anyway). Shared by the property
 * lowering (the fold) and lowerStringMethodCall's receiver gate (the
 * checker types the chain `string | undefined`, but the folded receiver
 * IS a string). */
export function isRequireMainFilename(lowerer: Lowerer, expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "filename") return false;
  const main = expr.expression;
  if (!ts.isPropertyAccessExpression(main) || main.name.text !== "main") return false;
  if (!lowerer.isStdlibGlobal(main.expression, "require")) return false;
  return !isNodeEsmFile(ts.getSourceFileOfNode(expr), lowerer.program);
}

export function isOptionalChainTail(lowerer: Lowerer, expr: ts.Expression): boolean {
  const tail = chainTailDot(lowerer, expr);
  if (!tail) return false;
  const recvTs = lowerer.typeOf(tail.expression);
  // An `any` receiver short-circuits the whole tail too: `a?.b.c` reads
  // `.c` normally once `a` is present.
  if (recvTs.flags & ts.TypeFlags.Any) return true;
  const recvT = lowerer.mapTypeOf(recvTs);
  if (recvT?.kind === "dyn") return true;
  if (recvT?.kind === "union") {
    const def = lowerer.unions.get(recvT.unionId);
    if (def?.arms.some(isUnitType)) return true;
  }
  // The checker calls the receiver present, but an unchecked read (`a[0]`
  // past the end, a missing index-signature key) can still lower to an
  // undefined-armed value, and `a[0]?.b.c` must then short-circuit `.c`
  // too. The chain lowering inspects the lowered receiver: a present value
  // re-dispatches the plain lowering, so only genuinely optional receivers
  // change shape.
  return lowerer.isRuntimeOptionalOrigin(tail.expression);
}

/** True when an EARLIER step of this access chain carries `?.` — JS
 * short-circuits the whole tail (`a?.b.c` reads nothing when a is
 * nullish), so a dyn tail read must answer undefined instead of
 * throwing. Walks the receiver spine only; the argument of the access
 * itself is not part of the guard. Parentheses end the chain
 * (`(a?.b).c` reads `.c` from undefined); `!` does not. */
export function hasOptionalChainGuard(expr: ts.Expression, lowerer?: Lowerer): boolean {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur) ||
      ts.isCallExpression(cur)
    ) {
      // Inside an optional chain's guarded body (dynamic reads pass the
      // lowerer), the enclosing optChain already short-circuits on the
      // consumed token, so the steps above it read normally: `a?.b.c`
      // throws when `a.b` is undefined.
      if (cur.questionDotToken) return lowerer === undefined || !lowerer.chainHandled.has(cur);
      cur = cur.expression;
      continue;
    }
    return false;
  }
}

/** `recv.m` where `m` is a required method the standard library declares
 * and `recv` itself is a non-optional, never-nullish typed receiver. */
function alwaysPresentStdlibMethod(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return false;
  if (hasOptionalChainGuard(node.expression)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(node.name);
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Method) || symbol.flags & ts.SymbolFlags.Optional)
    return false;
  if (!lowerer.isStdlibSymbol(symbol)) return false;
  const nullable =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void;
  const receiverType = lowerer.checker.getTypeAtLocation(node.expression);
  const calleeType = lowerer.checker.getTypeAtLocation(node);
  const parts = (type: ts.Type): readonly ts.Type[] =>
    type.flags & ts.TypeFlags.Union ? constituentTypes(type) : [type];
  return (
    parts(receiverType).every((part) => !(part.flags & nullable)) &&
    parts(calleeType).every((part) => !(part.flags & nullable))
  );
}

export function lowerOptionalChain(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression,
): IrExpr {
  const loc = locOf(expr);
  // The node CARRYING the ?. token and the receiver expression it guards.
  let dotNode: ts.Node;
  let recvNode: ts.Expression;
  if (ts.isCallExpression(expr) && expr.questionDotToken && !lowerer.chainHandled.has(expr)) {
    dotNode = expr; // f?.()
    recvNode = expr.expression;
  } else if (
    ts.isCallExpression(expr) &&
    (ts.isPropertyAccessExpression(expr.expression) ||
      ts.isElementAccessExpression(expr.expression)) &&
    expr.expression.questionDotToken &&
    !lowerer.chainHandled.has(expr.expression)
  ) {
    dotNode = expr.expression; // a?.m()
    recvNode = expr.expression.expression;
  } else if (
    (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
    expr.questionDotToken &&
    !lowerer.chainHandled.has(expr)
  ) {
    dotNode = expr; // a?.b / a?.[i]
    recvNode = expr.expression;
  } else {
    // TAIL entry: the token sits deeper in the receiver spine and JS
    // short-circuits the WHOLE tail with it (`x?.trim().toLowerCase()`
    // reads nothing when x is nullish). The guarded member step becomes
    // the chain's dot; every step above it lowers inside the guard, its
    // checker type narrowed non-nullish below (the tag test proved it).
    const tail = chainTailDot(lowerer, expr);
    if (!tail) {
      // A `f?.()` step under a member tail, or no token at all (a
      // dispatch bug): short-circuiting those is not modeled.
      lowerer.unsupported(
        "SC1090",
        expr,
        "multi-step optional chains (split them: const v = a?.b; then use v?.c)",
      );
    }
    dotNode = tail;
    recvNode = tail.expression;
  }
  // `h.getSetCookie?.()`: a required standard-library METHOD on a
  // never-nullish receiver always exists, so `?.()` is the plain call.
  // Native handle methods have no first-class value to guard; when the
  // method read itself has no lowering, re-dispatch the plain call (which
  // reports its own diagnostics) instead of failing on the value read.
  // `navigator?.userAgent`: Node's navigator global is never nullish and
  // has no value form, so the guarded step is the plain member read.
  if (isNavigatorGlobal(lowerer, recvNode)) {
    lowerer.chainHandled.add(dotNode);
    try {
      return lowerer.lowerExpr(expr);
    } finally {
      lowerer.chainHandled.delete(dotNode);
    }
  }
  let loweredReceiver: IrExpr | null;
  if (dotNode === expr && alwaysPresentStdlibMethod(lowerer, recvNode)) {
    loweredReceiver = tryLowerExpression(lowerer, recvNode);
    if (loweredReceiver === null) {
      lowerer.chainHandled.add(dotNode);
      try {
        return lowerer.lowerExpr(expr);
      } finally {
        lowerer.chainHandled.delete(dotNode);
      }
    }
  } else {
    loweredReceiver = lowerer.lowerExpr(recvNode);
  }
  const receiver = lowerer.runtimeOptionalSourceValue(recvNode, loweredReceiver) ?? loweredReceiver;
  if (receiver.type.kind === "dyn") {
    if (dotNode === expr && ts.isCallExpression(expr)) {
      const id = lowerer.closureName(loc, "", "chain");
      const callee: IrExpr = { kind: "chainRecv", id, type: DYN, loc };
      const stmts: IrStmt[] = [];
      let guarded = receiver;
      let thisValue: IrExpr | undefined;
      // Member calls retain their receiver, evaluated before the guarded
      // property read and only once, including effectful computed keys.
      if (ts.isPropertyAccessExpression(recvNode) || ts.isElementAccessExpression(recvNode)) {
        const object = lowerer.lowerExpr(recvNode.expression);
        const local = lowerer.declareHiddenLocal("%optionalThis", object.type);
        const reference: IrExpr = { kind: "varRef", localId: local.id, type: object.type, loc };
        stmts.push({ kind: "varDecl", localId: local.id, init: object, loc });
        thisValue = lowerer.coerceInto(recvNode.expression, reference, DYN);
        const previous = lowerer.chainRecvByNode.get(recvNode.expression);
        lowerer.chainRecvByNode.set(recvNode.expression, reference);
        try {
          guarded = lowerer.lowerExpr(recvNode);
        } finally {
          if (previous) lowerer.chainRecvByNode.set(recvNode.expression, previous);
          else lowerer.chainRecvByNode.delete(recvNode.expression);
        }
      }
      const spreads: { arg: number; what: string }[] = [];
      const args = expr.arguments.nodes.map((arg, index) => {
        if (!ts.isSpreadElement(arg)) return lowerer.lowerExprExpecting(arg, DYN);
        spreads.push({ arg: index, what: ts.getTextOfNode(arg.expression) });
        return lowerer.lowerExprExpecting(arg.expression, DYN);
      });
      const body: IrExpr = {
        kind: "dynCall",
        callee,
        ...(thisValue ? { receiver: thisValue } : {}),
        calleeName: ts.getTextOfNode(recvNode),
        args,
        ...(spreads.length ? { spreads } : {}),
        type: DYN,
        loc,
      };
      const result: IrExpr = { kind: "optChain", id, receiver: guarded, body, type: DYN, loc };
      return stmts.length ? { kind: "seqExpr", stmts, result, type: DYN, loc } : result;
    }
    // `pkg?.name` / `pkg?.scripts?.[k]` on a JSON.parse result: dyn
    // represents undefined directly, so the chain step IS the keyed
    // read with the optional (unit-answers-undefined) policy — no
    // optChain wrapper needed; nested steps compose the same way.
    if (dotNode === expr && ts.isPropertyAccessExpression(expr)) {
      const key: IrExpr = {
        kind: "strLit",
        value: expr.name.text,
        type: STRING,
        loc: locOf(expr.name),
      };
      return lowerer.maybeNarrow(
        { kind: "dynKeyGet", key, optional: true, value: receiver, type: DYN, loc },
        expr,
      );
    }
    if (dotNode === expr && ts.isElementAccessExpression(expr)) {
      const id = lowerer.closureName(loc, "", "chain");
      const reference: IrExpr = { kind: "chainRecv", id, type: DYN, loc };
      lowerer.chainRecvByNode.set(recvNode, reference);
      lowerer.chainHandled.add(dotNode);
      try {
        const body = lowerer.lowerExpr(expr);
        return {
          kind: "optChain",
          id,
          receiver,
          body: lowerer.coerceToExpected(body, DYN),
          type: DYN,
          loc,
        };
      } finally {
        lowerer.chainRecvByNode.delete(recvNode);
        lowerer.chainHandled.delete(dotNode);
      }
    }
    // The METHOD-call step (`rawName?.match(re)` on a dyn value): a
    // nullish receiver short-circuits to the undefined dyn singleton
    // (dyn represents undefined directly); anything else runs the
    // VALIDATED dynamic dispatch — the same one the truthy-guarded
    // spelling (`v ? v.match(...) : null`) compiles to, Node-shaped
    // TypeError on a kind mismatch included. The dispatch's static
    // result converts back into the checked-dynamic tree (the chain's checker type is
    // the error-any world's `any`, so dyn IS its representation).
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(dotNode) &&
      dotNode === expr.expression
    ) {
      const m = dotNode.name.text;
      const id = lowerer.closureName(loc, "", "chain");
      const recvRef: IrExpr = { kind: "chainRecv", id, type: DYN, loc: locOf(recvNode) };
      lowerer.chainRecvByNode.set(recvNode, recvRef);
      lowerer.chainHandled.add(dotNode);
      let body: IrExpr;
      try {
        body = lowerer.lowerExpr(expr);
      } finally {
        lowerer.chainRecvByNode.delete(recvNode);
        lowerer.chainHandled.delete(dotNode);
      }
      if (body.type.kind !== "dyn") {
        if (body.type.kind !== "void" && !lowerer.dynConvertible(body.type)) {
          lowerer.unsupported(
            "SC1100",
            expr,
            `optional METHOD calls on 'unknown' values where the result ('${lowerer.fmt(body.type)}' ` +
              `from '.${m}(...)') has no dynamic representation`,
          );
        }
        if (body.type.kind === "void") {
          return { kind: "optChain", id, receiver, body, type: VOID, loc };
        }
        body = { kind: "dynFrom", value: body, type: DYN, loc };
      }
      return { kind: "optChain", id, receiver, body, type: DYN, loc };
    }
    const id = lowerer.closureName(loc, "", "chain");
    const reference: IrExpr = { kind: "chainRecv", id, type: DYN, loc };
    lowerer.chainRecvByNode.set(recvNode, reference);
    lowerer.chainHandled.add(dotNode);
    try {
      const body = lowerer.lowerExpr(expr);
      if (body.type.kind === "void")
        return { kind: "optChain", id, receiver, body, type: VOID, loc };
      return {
        kind: "optChain",
        id,
        receiver,
        body: lowerer.coerceToExpected(body, DYN),
        type: DYN,
        loc,
      };
    } finally {
      lowerer.chainRecvByNode.delete(recvNode);
      lowerer.chainHandled.delete(dotNode);
    }
  }

  const def =
    receiver.type.kind === "union" ? lowerer.unions.get(receiver.type.unionId) : undefined;
  if (!def || !def.arms.some(isUnitType)) {
    // Never nullish: `?.` IS `.` — re-dispatch the plain lowering. The
    // receiver subtree above is discarded (lowering is pure IR
    // construction); the fresh dispatch lowers it again in place. The
    // checker may still SPELL the receiver nullable while the lowering
    // answers the plain value (`process.getuid?.()` is the POSIX
    // number), so narrow the node too — downstream receiver-typed
    // dispatch must agree with the lowered value, not the spelling.
    lowerer.chainHandled.add(dotNode);
    const hadNarrow = lowerer.chainNarrowedType.has(recvNode);
    if (!hadNarrow) {
      lowerer.chainNarrowedType.set(
        recvNode,
        lowerer.checker.getNonNullableType(lowerer.checker.getTypeAtLocation(recvNode)),
      );
    }
    try {
      return lowerer.lowerExpr(expr);
    } finally {
      lowerer.chainHandled.delete(dotNode);
      if (!hadNarrow) lowerer.chainNarrowedType.delete(recvNode);
    }
  }
  const rest = def.arms.filter((a) => !isUnitType(a));
  if (rest.length === 0) {
    const result = dynUndefinedExpr(loc);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: receiver, loc }],
      result,
      type: DYN,
      loc,
    };
  }
  const narrowed =
    rest.length === 1
      ? rest[0]!
      : { kind: "union" as const, unionId: lowerer.unions.transform(def, rest) };
  const id = lowerer.closureName(loc, "", "chain");
  // A single present arm binds its payload. Multiple present arms bind
  // the original tagged value, then retag inside the guarded body. The
  // nullish arms never enter that body, and each record keeps its identity.
  let recvRef: IrExpr = {
    kind: "chainRecv",
    id,
    type: rest.length === 1 ? narrowed : receiver.type,
    loc: locOf(recvNode),
  };
  if (narrowed.kind === "union" && receiver.type.kind === "union") {
    recvRef = lowerer.coerceInto(recvNode, recvRef, narrowed);
  }

  // `f?.()`: the callee IS the guarded value — build the indirect call
  // directly (no member dispatch exists to re-enter).
  if (dotNode === expr && ts.isCallExpression(expr)) {
    if (narrowed.kind !== "func") lowerer.badType(recvNode, lowerer.typeOf(recvNode));
    const params = narrowed.params;
    // Forwarded fixed tuples (`f?.(...args)`) complete into the slots.
    if (expr.arguments.nodes.some(ts.isSpreadElement)) {
      const completed = completeFuncValueArgs(lowerer, expr, narrowed, loc);
      const call: IrExpr = {
        kind: "callValue",
        callee: recvRef,
        args: completed,
        type: narrowed.ret,
        loc,
      };
      return lowerer.finishOptionalChain(expr, id, receiver, call, loc);
    }
    const args = expr.arguments.nodes.map((a, i) => lowerer.lowerExprExpecting(a, params[i]));
    // Effect-free surplus arguments (a dropped `void` slot) are ignored.
    while (narrowed.rest !== true && args.length > params.length && isSafeToDiscard(args.at(-1)!))
      args.pop();
    const body: IrExpr = { kind: "callValue", callee: recvRef, args, type: narrowed.ret, loc };
    return lowerer.finishOptionalChain(expr, id, receiver, body, loc);
  }

  // Member forms: re-dispatch the normal lowering with the receiver node
  // bound to the chain (reads as chainRecv, types as non-nullish).
  const narrowedTs = lowerer.checker.getNonNullableType(
    lowerer.checker.getTypeAtLocation(recvNode),
  );
  lowerer.chainRecvByNode.set(recvNode, recvRef);
  lowerer.chainNarrowedType.set(recvNode, narrowedTs);
  lowerer.chainHandled.add(dotNode);
  // A TAIL entry's intermediate steps (`x?.trim()` inside
  // `x?.trim().toLowerCase()`) checker-type with the chain's `|
  // undefined` even though inside the guard they are proven non-nullish
  // — narrow each so the downstream method/member dispatch rides the
  // real receiver kind. Only nodes this chain registers are cleaned up.
  const tailSteps: ts.Expression[] = [];
  if (dotNode !== expr && !(ts.isCallExpression(expr) && expr.expression === dotNode)) {
    for (let cur: ts.Expression = expr; cur !== dotNode;) {
      const next: ts.Expression = ts.isCallExpression(cur)
        ? cur.expression
        : (cur as ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.NonNullExpression)
            .expression;
      if (next === dotNode) break;
      if (!lowerer.chainNarrowedType.has(next)) {
        lowerer.chainNarrowedType.set(
          next,
          lowerer.checker.getNonNullableType(lowerer.checker.getTypeAtLocation(next)),
        );
        tailSteps.push(next);
      }
      cur = next;
    }
    if (!lowerer.chainNarrowedType.has(dotNode)) {
      lowerer.chainNarrowedType.set(
        dotNode,
        lowerer.checker.getNonNullableType(lowerer.checker.getTypeAtLocation(dotNode)),
      );
      tailSteps.push(dotNode as ts.Expression);
    }
  }
  let body: IrExpr;
  try {
    body = lowerer.lowerExpr(expr);
  } finally {
    lowerer.chainRecvByNode.delete(recvNode);
    lowerer.chainNarrowedType.delete(recvNode);
    lowerer.chainHandled.delete(dotNode);
    for (const n of tailSteps) lowerer.chainNarrowedType.delete(n);
  }
  return lowerer.finishOptionalChain(expr, id, receiver, body, loc);
}

/** The optChain node around a lowered chain body: void bodies keep the
 * statement form (`cb?.();` — the checker's `void | undefined` result IS
 * void here); value bodies wrap into the checker's undefined-armed
 * result union. */
export function finishOptionalChain(
  lowerer: Lowerer,
  expr: ts.Expression,
  id: string,
  receiver: IrExpr,
  body: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (body.type.kind === "void") {
    return { kind: "optChain", id, receiver, body, type: VOID, loc };
  }
  // A dyn body (`pricing?.[key]` — an unknown-valued index-signature
  // read) stays dyn: `unknown | undefined` IS unknown, and dyn represents
  // undefined directly (the unit path yields the undefined dyn value).
  if (body.type.kind === "dyn") {
    return { kind: "optChain", id, receiver, body, type: DYN, loc };
  }
  let type = lowerer.irTypeOf(expr);
  // The checker can call a receiver present that holds a nullish value at
  // runtime (runtime-optional reads; a stale narrowing restored to its
  // declared type). Either nullish arm short-circuits to undefined.
  const hiddenOptionalResult =
    (type.kind !== "union" || lowerer.armTag(type.unionId, UNDEFINED_T) < 0) &&
    receiver.type.kind === "union" &&
    (lowerer.unions.get(receiver.type.unionId)?.arms.some(isUnitType) ?? false) &&
    body.type.kind !== "generator"
      ? lowerer.withUndefinedArmOf(body.type)
      : null;
  if (hiddenOptionalResult) type = hiddenOptionalResult;
  if (type.kind !== "union" || lowerer.armTag(type.unionId, UNDEFINED_T) < 0) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'?.' where the result '${lowerer.fmt(type)}' has no undefined arm (narrow the receiver with 'if (x !== undefined)' instead)`,
    );
  }
  const wrapped = lowerer.coerceToExpected(body, type);
  if (!typeEquals(wrapped.type, type)) lowerer.badType(expr, lowerer.typeOf(expr));
  return { kind: "optChain", id, receiver, body: wrapped, type, loc };
}
