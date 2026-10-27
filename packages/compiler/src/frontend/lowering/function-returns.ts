import { iterableGeneratorArm } from "./iterable-values.js";
import { mapAsyncGeneratorAnnotation } from "../type-mapper.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  DYN,
  type IrStmt,
  type IrType,
  type SrcLoc,
  VOID,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import { PoisonError, dynFallbackType } from "./lowerer.js";
import { functionCanReturnUndefined } from "../function-completion.js";
import { jsBindingAppendsOnly, jsBindingHasOpenWrites } from "./lower-stmts.js";
import type { FnCtx } from "./function-context.js";
import { constituentTypes } from "../ts7/checker.js";
import { returnsGuessedOverloadValue } from "./overload-choice.js";

/** Keep the conservative completion rule shared by return construction
 * and inference. Nested control flow may still make completion unreachable. */
function bodyMayFallThrough(body: readonly IrStmt[]): boolean {
  const last = body[body.length - 1];
  return (
    !last ||
    (last.kind !== "return" &&
      last.kind !== "throw" &&
      last.kind !== "rethrow" &&
      last.kind !== "runtimeFence")
  );
}

/** The BODY-facing return type of a (possibly async) function: an async
 * body's `return v` fulfills its promise with v, so the body returns the
 * promise's INNER type while call sites keep Promise<T>. The declared
 * type of an async function is always a promise (collectSignature /
 * lowerLambda reject anything else before calling this). */
export function bodyReturnType(lowerer: Lowerer, isAsync: boolean, declared: IrType): IrType {
  return isAsync && declared.kind === "promise" ? declared.inner : declared;
}

/** A union-returning body may complete WITHOUT returning — JS yields
 * undefined then (`(): string | undefined => { if (c) return "x"; }`), so
 * an undefined-armed union return gets a trailing `return <undefined
 * arm>` appended unless the body's last statement already returns or
 * throws (deeper always-returning control flow keeps the appended return
 * as dead code — harmless).
 *
 * Every OTHER non-void body gets a trailing UNREACHABLE trap instead:
 * tsc's reachability can prove completions the validator's conservative
 * alwaysReturns cannot (an exhaustive `switch (typeof x)` with a return
 * in every case — signature 16), and those bodies end without a terminal
 * statement of their own. The trap satisfies the must-return rule as the
 * dead code it is; it can only fire if the checker's proof was violated,
 * which would be a lowering bug — hence the please-report wording. */
export function appendImplicitUndefinedReturn(
  lowerer: Lowerer,
  body: IrStmt[],
  bodyReturn: IrType,
  loc: SrcLoc,
): void {
  if (bodyReturn.kind === "void") return;
  if (!bodyMayFallThrough(body)) return;
  // An async generator that falls off its end completes without awaiting
  // anything: its request settles as the body returns, where `return x`
  // takes a turn to await x.
  let settled = false;
  if (lowerer.ctx.isAsync === true && lowerer.ctx.generator) settled = true;
  // A DYN body that can complete without returning (a JS function whose
  // guarded return may not run — mustSucceed's `if (typeof fn ===
  // 'function') return fn.apply(...)`): JS completes with undefined —
  // the undefined dyn value.
  if (bodyReturn.kind === "dyn") {
    body.push({
      kind: "return",
      value: dynUndefinedExpr(loc),
      ...(settled ? { awaited: true as const } : {}),
      loc,
    });
    return;
  }
  if (bodyReturn.kind === "union") {
    const value = lowerer.wrappedUndefined(bodyReturn, loc);
    if (value) {
      body.push({ kind: "return", value, ...(settled ? { awaited: true as const } : {}), loc });
      return;
    }
    // no undefined arm: the trap below stands in, exactly like non-unions
  }
  body.push({
    kind: "runtimeFence",
    code: "SC9002",
    message:
      "unreachable: a non-void function completed without returning " +
      "(the checker proved every path returns) — please report this",
    loc,
  });
}

/** Whether the source explicitly documents a return contract. */
export function hasExplicitJsDocReturn(decl: ts.SignatureDeclaration): boolean {
  const sourceFile = ts.getSourceFileOfNode(decl);
  return /@returns?\b/.test(sourceFile.text.slice(decl.pos, ts.tokenStartOfNode(decl)));
}

export function promiseCarriesDyn(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "promise") return type.inner.kind === "dyn";
  return (
    type.kind === "union" &&
    (lowerer.unions.get(type.unionId)?.arms.some((arm) => promiseCarriesDyn(lowerer, arm)) ?? false)
  );
}

export function producesConstructor(lowerer: Lowerer, type: ts.Type): boolean {
  let result: ts.Type | undefined = type;
  for (let depth = 0; result && depth < 8; depth++) {
    if (lowerer.checker.getConstructSignatures(result).length > 0) return true;
    const signatures = lowerer.checker.getCallSignatures(result);
    result =
      signatures.length === 1
        ? lowerer.checker.getReturnTypeOfSignature(signatures[0]!)
        : undefined;
  }
  return false;
}

/** Whether a return of `decl` itself (not of a nested function) is a bare
 * read of a JavaScript variable whose writes the checker does not
 * constrain. A string that is only appended to stays a string. */
function returnsOpenJsBinding(lowerer: Lowerer, decl: ts.SignatureDeclaration): boolean {
  let open = false;
  const opens = (value: ts.Expression | undefined): boolean => {
    while (value && ts.isParenthesizedExpression(value)) value = value.expression;
    if (!value || !ts.isIdentifier(value)) return false;
    const binding = lowerer.resolveValueSymbol(value)?.valueDeclaration;
    return (
      binding !== undefined &&
      ts.isVariableDeclaration(binding) &&
      jsBindingHasOpenWrites(lowerer, binding) &&
      !jsBindingAppendsOnly(lowerer, binding)
    );
  };
  const scan = (node: ts.Node): void => {
    if (open || (node !== decl && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && opens(node.expression)) open = true;
    ts.forEachChild(node, scan);
  };
  if (ts.isArrowFunction(decl) && decl.body && !ts.isBlock(decl.body)) open = opens(decl.body);
  else scan(decl);
  return open;
}

/** Map a declaration's return contract while retaining JavaScript
 * inference fallbacks. Diagnostics preserve the caller's blame node. */
export function declaredReturnType(
  lowerer: Lowerer,
  decl: ts.SignatureDeclaration,
  blame: ts.Node,
): IrType {
  if (isJsSourceFile(ts.getSourceFileOfNode(decl)) && ts.isGetAccessorDeclaration(decl)) return DYN;
  const sig = lowerer.checker.getSignatureFromDeclaration(decl);
  if (!sig) lowerer.unsupported("SC1090", decl, "this function form");
  const retTsType = lowerer.checker.getReturnTypeOfSignature(sig);
  // An inferred null/undefined return in JS can read a mutable checked-value
  // field. Keep the actual value instead of restricting it to the initializer.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    (retTsType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0
  )
    return DYN;
  // A body that always throws infers `never` — as a RETURN type that is
  // void with a stronger guarantee (`() => never` is assignable to
  // `() => void`), and throw-only callbacks are ordinary code
  // (`.action(() => { throw ... })`). `never` VALUES stay unmapped.
  if (retTsType.flags & ts.TypeFlags.Never) return VOID;
  // A JS generator whose result the checker cannot infer (mutually
  // recursive methods returning `yield*` of each other, as in yaml's
  // Parser) has the return type `any`: a generator over untyped values.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    decl.asteriskToken &&
    retTsType.flags & ts.TypeFlags.Any
  )
    return {
      kind: "generator",
      ...(decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        ? { async: true as const }
        : {}),
      yieldT: DYN,
      retT: DYN,
      nextT: DYN,
    };
  let mappedReturn = lowerer.mapTypeOf(retTsType);
  if (mappedReturn !== null)
    mappedReturn = widenReducedReturn(lowerer, decl, retTsType, mappedReturn);
  // A generator declared to return Iterable<T> returns a generator over T.
  if (mappedReturn && decl.asteriskToken)
    mappedReturn = iterableGeneratorArm(lowerer, mappedReturn);
  if (
    mappedReturn === null &&
    decl.asteriskToken &&
    decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    mappedReturn = mapAsyncGeneratorAnnotation(retTsType, lowerer.typeCtx);
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !decl.asteriskToken &&
    mappedReturn?.kind !== "promise"
  ) {
    const fallback = dynFallbackType(lowerer, decl, retTsType);
    return fallback?.kind === "promise" ? fallback : { kind: "promise", inner: DYN };
  }
  if (
    mappedReturn &&
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    functionCanReturnUndefined(decl)
  )
    mappedReturn = lowerer.withUndefinedArmOf(mappedReturn) ?? mappedReturn;
  // A generic-class method body that can return an indexed read that
  // misses returns undefined there, whatever the declared result says.
  if (mappedReturn && lowerer.runtimeOptionalGenericReturns.has(decl))
    mappedReturn =
      mappedReturn.kind === "promise"
        ? { kind: "promise", inner: lowerer.runtimeOptionalType(mappedReturn.inner) }
        : lowerer.runtimeOptionalType(mappedReturn);
  if (isJsSourceFile(ts.getSourceFileOfNode(decl)) && mappedReturn?.kind === "void") {
    let returnsValue = false;
    const scan = (node: ts.Node): void => {
      if (node !== decl && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) returnsValue = true;
      ts.forEachChild(node, scan);
    };
    scan(decl);
    if (returnsValue) return DYN;
  }
  if (isJsSourceFile(ts.getSourceFileOfNode(decl)) && mappedReturn?.kind === "array") return DYN;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !decl.type &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn?.kind === "record"
  )
    return DYN;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !decl.type &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn?.kind === "date"
  )
    return DYN;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !decl.type &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn?.kind === "union" &&
    lowerer.unions.get(mappedReturn.unionId)?.arms.some((arm) => arm.kind === "func")
  )
    return DYN;
  // A JS function returning a local that holds whatever its writes store
  // (jsBindingHasOpenWrites): the inferred result is the initializer's
  // type, which the returned value need not have.
  // An async function's promise fulfills with that value.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !decl.type &&
    !decl.asteriskToken &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn !== null &&
    mappedReturn.kind !== "dyn" &&
    !(mappedReturn.kind === "promise" && mappedReturn.inner.kind === "dyn") &&
    returnsOpenJsBinding(lowerer, decl)
  )
    return decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ? { kind: "promise", inner: DYN }
      : DYN;
  // A JS function returning a value whose type rests on an undecided
  // overload (guessedOverloadValue): the inferred result is the first
  // overload's, which the returned value need not have.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !decl.type &&
    !decl.asteriskToken &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn !== null &&
    mappedReturn.kind !== "dyn" &&
    !(mappedReturn.kind === "promise" && mappedReturn.inner.kind === "dyn") &&
    returnsGuessedOverloadValue(lowerer, decl)
  )
    return decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ? { kind: "promise", inner: DYN }
      : DYN;
  // JS inference assigns Number to arithmetic over any, although the
  // runtime operands can both be BigInts. Preserve that native result.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !decl.type &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn?.kind === "f64"
  ) {
    let numericAnyReturn = false;
    const numeric = new Set([
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
      ts.SyntaxKind.AsteriskAsteriskToken,
    ]);
    const check = (node: ts.Node): void => {
      if (node !== decl && ts.isFunctionLike(node)) return;
      const value = ts.isReturnStatement(node)
        ? node.expression
        : node === decl && ts.isArrowFunction(decl) && !ts.isBlock(decl.body)
          ? decl.body
          : undefined;
      if (
        value &&
        ts.isBinaryExpression(value) &&
        numeric.has(value.operatorToken.kind) &&
        [value.left, value.right].some(
          (operand) =>
            (lowerer.typeOf(operand).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
        )
      )
        numericAnyReturn = true;
      ts.forEachChild(node, check);
    };
    check(decl);
    if (numericAnyReturn) return DYN;
  }
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    !hasExplicitJsDocReturn(decl) &&
    mappedReturn !== null &&
    promiseCarriesDyn(lowerer, mappedReturn) &&
    !decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    decl.parameters.nodes.some((param) => {
      const mapped = lowerer.mapTypeOf(lowerer.typeOf(param.name));
      return mapped === null || mapped.kind === "dyn";
    })
  ) {
    return DYN;
  }
  // A JS function whose UNANNOTATED return infers a FUNCTION type
  // (test/common's mustCall — tsc infers `() => any` from the wrapper
  // it returns): the inferred arity is the wrapper's spelling, not a
  // contract — JS callers call the result however they like, and a
  // static func slot would force an arity-narrowing adapter that DROPS
  // arguments. Function-valued results stay checked-dynamic (dyn): the
  // value rides its own box, calls go through the boxed thunk (JS
  // arity), and typed slots re-check with dynCheck as usual.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    decl.type === undefined &&
    lowerer.mapTypeOf(retTsType)?.kind === "func"
  ) {
    return DYN;
  }
  // The RECORD twin (the tracing suite's traced closures — `function ()
  // { return expectedResult; }` infers `{ foo: string }`): JS object
  // literals are checked-dynamic VALUES, so a record-typed return would
  // copy the dyn value into a struct at the return and copy it back out
  // at any dyn boundary — identity lost twice (found.result !==
  // expectedResult where Node passes the object through). The inferred
  // shape is inference, not a contract: the return stays checked-
  // dynamic, and typed consumers re-check with dynCheck as usual.
  // GATED to the untyped-wrapper shape — every parameter itself
  // checked-dynamic (or none): a lambda with RECORD-typed parameters
  // (a reduce reducer over a typed array) legitimately returns its
  // parameters' records and keeps the static type.
  // Native-only members (such as Int32Array layout offsets) cannot cross
  // that boundary; their factories keep the native record ABI.
  const asyncReturn =
    decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    mappedReturn?.kind === "promise";
  const recordReturn =
    asyncReturn && mappedReturn?.kind === "promise" ? mappedReturn.inner : mappedReturn;
  const recordArms =
    recordReturn?.kind === "union"
      ? lowerer.unions.get(recordReturn.unionId)?.arms
      : recordReturn
        ? [recordReturn]
        : undefined;
  const inferredRecordReturn =
    recordArms?.some((arm) => arm.kind === "record" || arm.kind === "object") &&
    recordArms.every(
      (arm) =>
        isUnitType(arm) ||
        arm.kind === "record" ||
        (arm.kind === "object" && !hasExplicitJsDocReturn(decl)),
    );
  if (
    isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    decl.type === undefined &&
    recordReturn !== null &&
    recordReturn !== undefined &&
    inferredRecordReturn &&
    lowerer.dynConvertible(recordReturn) &&
    decl.parameters.nodes.every((p) => {
      const mt = lowerer.mapTypeOf(lowerer.typeOf(p));
      return mt === null || mt.kind === "dyn";
    })
  ) {
    return asyncReturn ? { kind: "promise", inner: DYN } : DYN;
  }
  const returnType = mappedReturn;
  if (!returnType) {
    // JS inference residue (an `any` return, an unmappable union): the
    // checked-dynamic fallback, exactly the declaration story in
    // irTypeOf — callers' typed slots re-check with dynCheck.
    const js = dynFallbackType(lowerer, decl, retTsType);
    if (js) return js;
    fenceGenericSignatureResult(lowerer, blame, retTsType);
    lowerer.badType(blame, retTsType);
  }
  return returnType;
}

/** A RESULT position whose type is itself a generic signature (`const
 * satisfies = <T>() => <N extends T>(n: N) => n` — the call's result
 * keeps type parameters): the returned value is a fresh generic value
 * per call, the pinned/unpinned rule applies at the result, and nothing
 * here can pin it — the value would also need the producing call's
 * frame, which module-function instances cannot capture. Named fence
 * instead of the generic supported-types recitation; a no-op for every
 * other unmappable type (the caller's badType reports those). */
export function fenceGenericSignatureResult(lowerer: Lowerer, blame: ts.Node, t: ts.Type): void {
  const parts = t.isUnionType() ? ts.constituentTypes(t) : [t];
  if (
    !parts.some((p) =>
      lowerer.checker.getCallSignatures(p).some((s) => s.getTypeParameters().length > 0),
    )
  ) {
    return;
  }
  lowerer.unsupported(
    "SC1090",
    blame,
    `results that are themselves generic functions ('${lowerer.checker.typeToString(t)}' keeps its type parameters — no call-site instantiation pins them, and the returned value would need the producing call's frame; restructure to one generic function taking all arguments)`,
  );
}

/** The return-inference post-pass of an implicit-any instance: unify the
 * recorded return statements' value types into the instance's settled
 * return type, then wrap each return to it — arm values wrap into the
 * union, dyn-convertible values ride dynFrom, and a value that cannot
 * ride the settled type converts ITS return statement into the standard
 * per-statement runtime fence (JS sources defer fences to runtime).
 *
 * The settled type: the one distinct value type when every return
 * agrees; `T | undefined` when a bare `return;` or possible fallthrough
 * adds JS's undefined; DYN when returns disagree (the checked-dynamic
 * result slot — today's shape). Same-key recursion PINNED the fallback
 * type mid-lowering (callers already hold it), so a pinned instance
 * keeps it and the wrap pass coerces every return to the pin. Callers
 * store the settled type on their full instance; this narrower view
 * can be a structural copy in native builds. */
export function resolveInferredReturn(
  lowerer: Lowerer,
  inst: { returnType: IrType; returnPinned?: boolean },
  infer: NonNullable<FnCtx["inferReturn"]>,
  body: IrStmt[],
  decl: ts.Node,
): IrType {
  // The conservative completion test appendImplicitUndefinedReturn uses:
  // a body whose last statement isn't a terminator may complete without
  // returning — JS answers undefined.
  const sawBare =
    bodyMayFallThrough(body) ||
    infer.entries.some(
      (e) => e.stmt.kind === "return" && (e.stmt.value === null || e.stmt.value === undefined),
    );
  let final: IrType;
  if (inst.returnPinned) {
    final = inst.returnType;
  } else {
    const distinct: IrType[] = [];
    for (const e of infer.entries) {
      if (e.stmt.kind !== "return" || e.stmt.value === null || e.stmt.value === undefined) continue;
      const type = e.stmt.value.type;
      if (!distinct.some((t) => typeEquals(t, type))) distinct.push(type);
    }
    if (distinct.length === 0) {
      final = DYN; // no valued return: JS completes with undefined — the dyn undefined, today's slot
    } else if (distinct.length === 1) {
      const t = distinct[0]!;
      final = isUnitType(t)
        ? DYN
        : !sawBare
          ? t
          : t.kind === "dyn"
            ? DYN
            : (lowerer.withUndefinedArmOf(t) ?? DYN);
    } else {
      final = DYN; // disagreeing returns: the checked-dynamic join
    }
  }
  // The wrap pass: settle every recorded return onto `final`, in place.
  // Write through the stored union arm: optional-field widening on a
  // local alias can otherwise introduce a record copy in native builds.
  for (const e of infer.entries) {
    if (e.stmt.kind !== "return") continue;
    const diagsBefore = lowerer.diags.length;
    try {
      if (e.stmt.value === null || e.stmt.value === undefined) {
        if (final.kind === "dyn") e.stmt.value = dynUndefinedExpr(e.stmt.loc);
        else if (final.kind === "union") {
          const wrapped = lowerer.wrappedUndefined(final, e.stmt.loc);
          if (!wrapped) {
            lowerer.unsupported(
              "SC1090",
              e.node ?? decl,
              `bare 'return' in a function whose inferred return type is '${lowerer.fmt(final)}'`,
            );
          }
          e.stmt.value = wrapped;
        }
        // void final: bare return stands as-is
      } else if (!typeEquals(e.stmt.value.type, final)) {
        e.stmt.value = lowerer.coerceInto(e.node ?? decl, e.stmt.value, final);
      }
    } catch (err) {
      if (!(err instanceof PoisonError)) throw err;
      // The per-return fence: this value cannot ride the settled type —
      // executing THIS return throws the recorded reason (the JS
      // per-statement deferral, applied to one return of an instance).
      const captured = lowerer.diags.splice(diagsBefore);
      const ice = captured.filter((d) => d.code === "SC9001");
      if (ice.length > 0) lowerer.diags.push(...ice);
      lowerer.runtimeFences.push(...captured.filter((d) => d.code !== "SC9001"));
      const first = captured.find((d) => d.code !== "SC9001");
      // Property writes, not literal element writes: the class method
      // census reads `x["kind"] = …` as a possible write to every method
      // named `kind`, which would make those methods dynamic in native builds.
      const mutable = e.stmt as unknown as Record<string, unknown>;
      delete mutable.value;
      mutable.kind = "runtimeFence";
      mutable.code = first?.code ?? "SC1090";
      mutable.message = first
        ? `${first.message} [${first.code}]`
        : "this return value has no lowering onto the instance's settled return type [SC1090]";
    }
  }
  return final;
}

/** The declaration's real Block body. tsgo's remote child indexing can hand
 * back a jsdoc node as `.body` — a JS `function f() {...}` annotated
 * `@type {() => undefined}` answers the jsdoc FUNCTION TYPE node (the
 * 09-lower-stmts-undefined crash signature) while the actual Block sits
 * elsewhere in the children — so recover it by kind, never by slot. Null
 * when the declaration truly has no block. */
export function blockBodyOf(decl: ts.FunctionLikeDeclaration): ts.Block | null {
  const body = decl.body;
  if (body === undefined) return null;
  if (ts.isBlock(body)) return body;
  return ts.forEachChild(decl, (c) => (ts.isBlock(c) ? c : undefined)) ?? null;
}

const widening = new Set<ts.Node>();
/** How many times widenReducedReturn answered a declaration it was still
 * widening with its unwidened type. A result computed while that happened
 * may lack arms, so it is not kept. */
let wideningCuts = 0;

/** An inferred return type is the checker's SUBTYPE-REDUCED union of the
 * returned values' types: `return aborted` (`{ status }`) beside `return
 * { status, value }` infers just `{ status }`, because the second is a
 * subtype of the first. Records have fixed layouts, so that type cannot
 * hold the second value: the return would drop `value` or fail the union
 * wrap. A function whose return type is inferred therefore returns the
 * union of the record types it actually returns. Declared return types keep
 * their meaning. */
function widenReducedReturn(
  lowerer: Lowerer,
  decl: ts.SignatureDeclaration,
  retTsType: ts.Type,
  mapped: IrType,
): IrType {
  if (decl.type !== undefined || hasExplicitJsDocReturn(decl)) return mapped;
  const body = (decl as { body?: ts.Node }).body;
  if (body === undefined || decl.asteriskToken !== undefined) return mapped;
  if (decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return mapped;
  // A function expression with a contextual signature returns that
  // signature's type; only free-standing inference is widened.
  if (
    (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
    lowerer.checker.getContextualType(decl) !== undefined
  )
    return mapped;
  const arms =
    mapped.kind === "union" ? (lowerer.unions.get(mapped.unionId)?.arms ?? []) : [mapped];
  const recordArms = arms.filter((a) => a.kind === "record");
  if (recordArms.length === 0) return mapped;
  if (widening.has(decl)) {
    wideningCuts++;
    return mapped;
  }
  // Functions that forward to the same callees along several return
  // branches read each callee's widened type once. A nested function
  // lowered under other type-parameter bindings maps its returns again.
  const known = lowerer.coercions.widenedReturnTypes.get(decl)?.get(retTsType);
  const erasing = lowerer.erasingDepth > 0;
  if (
    known !== undefined &&
    known.bindings === lowerer.typeParamBindings &&
    known.tsBindings === lowerer.typeParamTsBindings &&
    known.implicit === lowerer.implicitParamTypes &&
    known.erasing === erasing
  )
    return known.type;
  const cutsBefore = wideningCuts;
  const widened = widenReturnArms(lowerer, decl, retTsType, mapped, arms, recordArms);
  if (wideningCuts === cutsBefore) {
    let byType = lowerer.coercions.widenedReturnTypes.get(decl);
    if (byType === undefined) lowerer.coercions.widenedReturnTypes.set(decl, (byType = new Map()));
    byType.set(retTsType, {
      type: widened,
      bindings: lowerer.typeParamBindings,
      tsBindings: lowerer.typeParamTsBindings,
      implicit: lowerer.implicitParamTypes,
      erasing,
    });
  }
  return widened;
}

/** widenReducedReturn's scan of the returned values, for a declaration not
 * already being widened. */
function widenReturnArms(
  lowerer: Lowerer,
  decl: ts.SignatureDeclaration,
  retTsType: ts.Type,
  mapped: IrType,
  arms: readonly IrType[],
  recordArms: readonly IrType[],
): IrType {
  const body = (decl as { body?: ts.Node }).body!;
  const checkerArms = new Set<ts.Type>(
    retTsType.flags & ts.TypeFlags.Union ? constituentTypes(retTsType) : [retTsType],
  );
  const fieldsOf = (t: IrType): readonly string[] | null => {
    if (t.kind !== "record") return null;
    const shape = lowerer.shapes.get(t.shapeId);
    return shape === undefined || shape.tuple || shape.indexValue !== undefined
      ? null
      : shape.fields.map((f) => f.name);
  };
  const narrower = (part: IrType): boolean => {
    const own = fieldsOf(part);
    if (own === null || arms.some((a) => typeKey(a) === typeKey(part))) return false;
    return recordArms.some((arm) => {
      const fields = fieldsOf(arm);
      return fields !== null && fields.length < own.length && fields.every((f) => own.includes(f));
    });
  };
  const extra = new Map<string, IrType>();
  const returned = (expr: ts.Expression): void => {
    // A call of another inferred function returns ITS widened type.
    const callee = ts.isCallExpression(expr)
      ? lowerer.checker.getResolvedSignature(expr)?.declaration
      : undefined;
    if (
      callee !== undefined &&
      ts.isFunctionLike(callee) &&
      (callee as { body?: ts.Node }).body !== undefined &&
      callee.type === undefined
    ) {
      // A call of the function itself returns its own type, whose arms
      // add nothing. Reading it would cut the widening and keep this
      // result from being reused.
      if (callee === decl) return;
      let t: IrType | null = null;
      widening.add(decl);
      try {
        t = declaredReturnType(lowerer, callee, expr);
      } catch {
        t = null;
      } finally {
        widening.delete(decl);
      }
      if (t === null) return;
      const parts = t.kind === "union" ? (lowerer.unions.get(t.unionId)?.arms ?? []) : [t];
      for (const part of parts) if (narrower(part)) extra.set(typeKey(part), part);
      return;
    }
    // Only a value type the checker's reduction dropped from the inferred
    // union is a candidate; a constituent of the inferred type is already
    // represented by it.
    const valueType = lowerer.typeOf(expr);
    const valueArms =
      valueType.flags & ts.TypeFlags.Union ? constituentTypes(valueType) : [valueType];
    for (const part of valueArms) {
      if (checkerArms.has(part) || !(part.flags & ts.TypeFlags.Object)) continue;
      if (!lowerer.checker.isTypeAssignableTo(part, retTsType)) continue;
      const t = lowerer.mapTypeOf(part);
      if (t !== null && narrower(t)) extra.set(typeKey(t), t);
    }
  };
  const scan = (node: ts.Node): void => {
    if (node !== decl && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) returned(node.expression);
    ts.forEachChild(node, scan);
  };
  if (ts.isArrowFunction(decl) && !ts.isBlock(body)) returned(body as ts.Expression);
  else scan(body);
  if (extra.size === 0) return mapped;
  const joined = new Map<string, IrType>();
  for (const a of [...arms, ...extra.values()]) joined.set(typeKey(a), a);
  const sorted = [...joined.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  const unionId = lowerer.unions.intern(sorted);
  lowerer.coercions.widenedReturns.add(unionId);
  return { kind: "union", unionId };
}

/** Whether `wide` is a widened inferred return that holds `narrow`'s arms plus records that are width
 * subtypes of `narrow`'s record arms: the shape a subtype-reduced inferred
 * type takes next to the values it was inferred from. */
export function widensReducedRecords(lowerer: Lowerer, narrow: IrType, wide: IrType): boolean {
  if (wide.kind !== "union" || typeKey(narrow) === typeKey(wide)) return false;
  if (!lowerer.coercions.widenedReturns.has(wide.unionId)) return false;
  const narrowArms =
    narrow.kind === "union" ? (lowerer.unions.get(narrow.unionId)?.arms ?? []) : [narrow];
  const wideArms = lowerer.unions.get(wide.unionId)?.arms ?? [];
  const keys = new Set(wideArms.map(typeKey));
  if (!narrowArms.every((a) => keys.has(typeKey(a)))) return false;
  const fieldsOf = (t: IrType): readonly string[] | null => {
    if (t.kind !== "record") return null;
    const shape = lowerer.shapes.get(t.shapeId);
    return shape === undefined || shape.tuple || shape.indexValue !== undefined
      ? null
      : shape.fields.map((f) => f.name);
  };
  const narrowKeys = new Set(narrowArms.map(typeKey));
  const extras = wideArms.filter((a) => !narrowKeys.has(typeKey(a)));
  return (
    extras.length > 0 &&
    extras.every((extra) => {
      const own = fieldsOf(extra);
      return (
        own !== null &&
        narrowArms.some((arm) => {
          const f = fieldsOf(arm);
          return f !== null && f.length < own.length && f.every((x) => own.includes(x));
        })
      );
    })
  );
}
