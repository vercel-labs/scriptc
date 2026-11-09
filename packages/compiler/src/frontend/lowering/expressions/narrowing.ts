/* Type narrowing of lowered values, conditional and as-expressions, and runtime-optional receiver reads. */
import { consoleInto, isConsoleObjectRead, isConsoleTyped } from "../coercions/console-records.js";
import { declBoundaryOrigin } from "../../decl-projection.js";
import {
  isWebStreamMemberInJavaScript,
  typeInvolvesWebStream,
} from "../builtins/web-streams-dyn.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, dynFallbackType } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  type IrExpr,
  type IrLocal,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  adoptsAtTypedSlot,
  arrayOf,
  canDynCheckTo,
  isDynTypedRefType,
  isUnitType,
  shapeHasAccessorSlots,
  typeEquals,
  sortArms,
  typeKey,
} from "../../../ir/ir.js";
import { isJsSourceFile, isNodeTypesPath, locOf } from "../../program.js";
import { lowerPartialAssertion, partialAssertionSite } from "../partial-assertions.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { jsBindingHasOpenWrites } from "../lower-stmts.js";
import { conditionRunsNothing, constantCondition } from "../constant-conditions.js";
import { documentedParameter, prototypeAssignedFunction } from "../call-signatures.js";
import { narrowClassUnion, narrowStoredClassValue, structuralNarrowing } from "../class-unions.js";
import { checkedClassAssertion, checkedClassUnionAssertion } from "../class-assertions.js";
import {
  isOptionalProcessStreamProperty,
  isTerminalStreamMember,
  isOptionalProcessVersionsRead,
} from "../builtins/process.js";
import { requestGeneralStreamSurface } from "../general-streams.js";
import { builtRecordResultType } from "../built-record-results.js";
import { dynamicArrayOperand } from "./array-literals.js";
import { isOptionalReadlineCursorRead } from "../builtins/readline.js";
import { literalValues } from "../../literal-values.js";
import { literalUnionArm } from "../../union-discriminants.js";
import { checkedArmExtraction } from "../coercions/unions.js";
import { isSafeToRepeat } from "./evaluation-safety.js";
import {
  assertedOptionalExtension,
  hostedStorageView,
  hostsAll,
  recordViewHosted,
  viewHostedArmTags,
} from "./hosted-narrowing.js";
import { bindingIdentityUse } from "../divergences.js";
import { nodeThrowExpr, strLit, varRef } from "../../../ir/build.js";
import { throwTypeError } from "../primitive-throws.js";
import { InternalCompilerError } from "../../../errors.js";
import {
  hasClassPayload,
  runtimeOptionalAssertionErases,
  runtimeOptionalLocalOf,
  runtimeOptionalUseOf,
} from "../lower-exprs.js";
import { isConstAssertionTypeNode, unitOnlyUnion } from "../../type-mapper.js";
import { assertsGlobalObject, extractionCopiesReference } from "../assertion-identity.js";
import { iterableSlotValue, iterableUnionOf } from "../iterable-values.js";
import { isDeclBoundaryTypeNode } from "../../decl-projection.js";
import { isMessageListenerCall } from "./message-listeners.js";
import {
  assertedProbeAccessOf,
  convertingAssertion,
  deferredMemberReadTarget,
  plainAssignmentTarget,
} from "./asserted-receiver.js";
import { DELETE_NULLISH_RECEIVER } from "./erased-delete.js";

/** `c ? a : b`. An explicit destination constructs each branch at that
 * layout before joining it. Without one, retain the expression's inferred
 * type and the contextual/sibling rules below. */
export function lowerTernary(
  lowerer: Lowerer,
  expr: ts.ConditionalExpression,
  expected?: IrType,
): IrExpr {
  const loc = locOf(expr);
  // `Array.isArray(x) ? x : [x]` over a `T | readonly T[]` union: tsc
  // narrows the TRUE branch to `any[]` (maybeNarrow's isArray bridge
  // rides that) but leaves the FALSE branch wide — a readonly array
  // is not assignable to `any[]`, so the arm never subtracts. The
  // RUNTIME tag test proves the remaining arm exactly, so the false
  // arm's reads of x narrow to the union's one non-array checker
  // constituent (the certs configuredTlds shape). Nested functions
  // stay out (they run later, when the proof is stale — tsc's own
  // invalidation rule).
  const falseArmNarrows: ts.Identifier[] = [];
  let falseArmNarrowType: ts.Type | null = null;
  {
    let c: ts.Expression = expr.condition;
    while (ts.isParenthesizedExpression(c)) c = c.expression;
    if (
      ts.isCallExpression(c) &&
      ts.isPropertyAccessExpression(c.expression) &&
      c.arguments.nodes.length === 1 &&
      ts.isIdentifier(c.arguments.nodes[0]!) &&
      lowerer.stdlibGlobalMember(c.expression, "Array") === "isArray"
    ) {
      const argIdent = c.arguments.nodes[0] as ts.Identifier;
      const sym = lowerer.resolveValueSymbol(argIdent);
      const t = lowerer.checker.getTypeAtLocation(argIdent);
      const constituents = t.isUnionType() ? ts.constituentTypes(t) : [];
      const nonArray = constituents.filter(
        (a) => !lowerer.checker.isArrayType(a) && !lowerer.checker.isTupleType(a),
      );
      const mapped = lowerer.mapTypeOf(t);
      const armCount = mapped?.kind === "union" ? lowerer.arrayValueTags(mapped.unionId).length : 0;
      if (sym && nonArray.length === 1 && armCount === 1) {
        falseArmNarrowType = nonArray[0]!;
        const collect = (n: ts.Node): void => {
          if (ts.isFunctionLike(n)) return;
          if (
            ts.isIdentifier(n) &&
            lowerer.resolveValueSymbol(n) === sym &&
            !lowerer.chainNarrowedType.has(n)
          ) {
            falseArmNarrows.push(n);
          }
          ts.forEachChild(n, collect);
        };
        collect(expr.whenFalse);
      }
    }
  }
  for (const n of falseArmNarrows) lowerer.chainNarrowedType.set(n, falseArmNarrowType!);
  try {
    const cond = lowerer.lowerCondition(expr.condition);
    // A condition the LOWERING proved constant (typeof-dyn against a
    // kind no dyn box can hold — the bigint/symbol/function fold): only
    // the taken arm exists at runtime, so only it lowers — which is
    // exactly what lets a dual-mode arm with no static lowering (bigint
    // literals) sit untaken in compiled JS. A boolLit carries no
    // effects, so dropping the condition read loses nothing.
    if (cond.kind === "boolLit") {
      return lowerer.lowerExprExpecting(cond.value ? expr.whenTrue : expr.whenFalse, expected);
    }
    // A constant condition that runs nothing (constant-conditions.ts)
    // selects its arm the same way: the expression is the selected arm, as
    // if that arm stood alone. One that can throw (a `const` read before
    // its declaration) keeps both arms: a sequence that ran the condition
    // first would be a temporary the two-armed form does not have.
    const constant = constantCondition(lowerer, expr.condition);
    if (constant !== null && conditionRunsNothing(lowerer, expr.condition, cond)) {
      return lowerer.lowerExprExpecting(constant ? expr.whenTrue : expr.whenFalse, expected);
    }
    if (expected) {
      // Construct fresh literals in their actual destination. Joining
      // inferred layouts first can erase the literal discriminator or
      // choose an empty array's uninhabited element representation.
      // Runtime-optional proofs apply only within the selected true arm.
      const then = withRuntimeOptionalNarrowed(
        lowerer,
        runtimeOptionalTrueIds(lowerer, expr.condition),
        () => lowerer.lowerExprExpecting(expr.whenTrue, expected),
      );
      const else_ = lowerer.lowerExprExpecting(expr.whenFalse, expected);
      return { kind: "ternary", cond, then, else_, type: expected, loc };
    }
    const ctxTs = lowerer.checker.getContextualType(expr);
    const ctxMapped = ctxTs ? lowerer.mapTypeOf(ctxTs) : null;
    // Array-literal arms build directly as the slot's array type when
    // the ternary sits under an ARRAY context (tsc accepts each arm
    // covariantly — `[stdin]` types string[] against an
    // (Uint8Array | string)[] slot — but a tagged element representation
    // must be BUILT as the slot's element type, the same rule element
    // expressions follow inside every array literal). And an EMPTY
    // array-literal arm with no usable type of its own (tsc infers
    // `never[]`; no mappable contextual type reaches into the arm — the
    // conditional-spread idiom `[...(c ? [x] : [])]`) adopts the SIBLING
    // arm's array type: the ternary twin of the union-slot rule in
    // lowerArrayLiteral, and just as unambiguous — tsc already typed the
    // whole ternary by the filled arm alone. Both arms empty stays
    // fenced (no element type exists anywhere).
    const ctxArray = ctxMapped?.kind === "array" ? ctxMapped : null;
    const armLiteral = (e: ts.Expression): ts.ArrayLiteralExpression | null => {
      let x = e;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      return ts.isArrayLiteralExpression(x) ? x : null;
    };
    const emptyUntypedArrayArm = (e: ts.Expression): boolean => {
      const lit = armLiteral(e);
      if (!lit || lit.elements.nodes.length !== 0) return false;
      const t = lowerer.checker.getContextualType(lit) ?? lowerer.typeOf(lit);
      if (!lowerer.mapTypeOf(t)) return true;
      // never[] MAPS (the f64 representation for the uninhabited) but
      // carries no element information — an empty literal typed that way
      // still adopts the sibling arm's array type, tsc's own reading.
      if (lowerer.checker.isArrayType(t)) {
        const elem = lowerer.checker.getTypeArguments(t as ts.TypeReference)[0];
        if (elem !== undefined && elem.flags & ts.TypeFlags.Never) return true;
      }
      return false;
    };
    // Inferred signature tables often join a populated argument array
    // with nested empty-array branches. Carry the whole record layout
    // through those branches before constructing their fresh fields.
    const ownJoin = lowerer.mapTypeOf(lowerer.typeOf(expr));
    const ownUnion = ownJoin?.kind === "union" ? ownJoin : null;
    const recordJoin =
      ctxMapped?.kind === "record" ? ctxMapped : ownJoin?.kind === "record" ? ownJoin : undefined;
    const lowerArm = (e: ts.Expression, siblingType?: IrType): IrExpr => {
      let fresh = e;
      while (ts.isParenthesizedExpression(fresh)) fresh = fresh.expression;
      if (recordJoin && ts.isConditionalExpression(fresh))
        return lowerTernary(lowerer, fresh, recordJoin);
      if (recordJoin && ts.isObjectLiteralExpression(fresh)) {
        return lowerer.lowerObjectLiteral(fresh, recordJoin);
      }
      const lit = armLiteral(e);
      if (lit && ctxArray) return lowerer.lowerArrayLiteral(lit, ctxArray);
      // An arm of a conditional whose own value is the checked-dynamic
      // array (`list ? list : []` over an `unknown[]`): the dynamic array.
      if (lit) {
        const dynamic = dynamicArrayOperand(lowerer, lit, expr);
        if (dynamic) return dynamic;
      }
      if (lit && siblingType?.kind === "array") {
        if (emptyUntypedArrayArm(e)) {
          return { kind: "arrayLit", elems: [], type: siblingType, loc: locOf(lit) };
        }
        // A FILLED literal arm whose own element type is a UNION
        // carrying the sibling's element as an arm (`Array.isArray(x) ?
        // x : [x]` — the false arm's x checker-types as the whole union
        // even though the runtime tag proved the non-array arm): build
        // as the sibling's array type — each element coerces into the
        // sibling element or fences on its own.
        const ownT = lowerer.mapTypeOf(lowerer.typeOf(lit));
        if (
          ownT?.kind === "array" &&
          ownT.elem.kind === "union" &&
          siblingType.elem.kind !== "union" &&
          lowerer.armTag(ownT.elem.unionId, siblingType.elem) >= 0
        ) {
          return lowerer.lowerArrayLiteral(lit, siblingType);
        }
        // A FILLED literal arm whose own array type has NO lift into the
        // sibling's (`isWindows ? ['cmd.exe', ['/d']] : ['pwd', []]` —
        // the empty nested literal types never[], whose f64-element
        // representation re-tags into nothing): the generic path could
        // only fence the whole ternary, so build AS the sibling type —
        // each element coerces into the sibling's element slot or fences
        // on its own, and a nested empty literal adopts the slot's array
        // arm (the union-slot rule). tsc already accepted the arm
        // covariantly against the join, so a fitting literal is exactly
        // the value the checker typed.
        if (
          ownT?.kind === "array" &&
          !typeEquals(ownT, siblingType) &&
          lowerer.widthLiftPlan(ownT, siblingType) === null
        ) {
          return lowerer.lowerArrayLiteral(lit, siblingType);
        }
      }
      // A FRESH array-literal arm whose checker join is a UNION that does
      // not already hold its own array type (`c ? [{ type: "text", text }]
      // : replacement.content` joining `Block[]` with `(Image | Text)[]`):
      // build the literal at the union so lowerExprExpecting's union-slot
      // rule picks the complete arm. Nothing aliases a fresh literal, so
      // any complete arm is the checker-accepted value; coercing the bare
      // literal could only refuse when two array arms fit it.
      if (lit && ownUnion) {
        const ownT = lowerer.mapTypeOf(lowerer.typeOf(lit));
        if (ownT?.kind === "array" && lowerer.widthLiftPlan(ownT, ownUnion) === null) {
          return lowerer.lowerExprExpecting(lit, ownUnion);
        }
      }
      return lowerer.lowerExpr(e);
    };
    // An ARRAY arm beside an array LITERAL arm under a destructuring
    // pattern (`const [name, value] = long ? text.split("=", 2) : [text,
    // undefined]`): the pattern's contextual type is a tuple, which the
    // literal could be built as and the array cannot become (its length is
    // a run-time fact, and a pattern reads a missing position as
    // undefined). Both arms are arrays in JavaScript, so the ternary is
    // one: the literal builds as an array whose element joins the array
    // arm's and its own, and the pattern reads positions from it.
    {
      const joined = arrayBesideLiteralUnderTuple(lowerer, expr, ctxMapped, armLiteral);
      if (joined !== null) {
        const arm = (e: ts.Expression): IrExpr => {
          const lit = armLiteral(e);
          return lit
            ? lowerer.lowerArrayLiteral(lit, joined)
            : lowerer.coerceToExpected(lowerer.lowerExpr(e), joined);
        };
        const then = withRuntimeOptionalNarrowed(
          lowerer,
          runtimeOptionalTrueIds(lowerer, expr.condition),
          () => arm(expr.whenTrue),
        );
        const else_ = arm(expr.whenFalse);
        if (typeEquals(then.type, joined) && typeEquals(else_.type, joined))
          return { kind: "ternary", cond, then, else_, type: joined, loc };
      }
    }
    // Lower the filled arm first so an empty arm can adopt its type.
    // When the checker's OWN join for the ternary maps to an ARRAY,
    // literal arms build against it directly (tsc collapses the arms'
    // covariant array types into one — `c ? ['sh', []] : ['cmd', ['/d']]`
    // joins as (string | string[])[] whichever arm nests the empty
    // literal), so neither arm's uninhabited never[] reading decides.
    const ownArrayJoin = (() => {
      const m = lowerer.mapTypeOf(lowerer.typeOf(expr));
      return m?.kind === "array" ? m : null;
    })();
    let thenRaw: IrExpr;
    let elseRaw: IrExpr;
    const runtimeTrueIds = runtimeOptionalTrueIds(lowerer, expr.condition);
    const lowerTrueArm = (): IrExpr =>
      withRuntimeOptionalNarrowed(lowerer, runtimeTrueIds, () =>
        lowerArm(expr.whenTrue, ownArrayJoin ?? undefined),
      );
    if (!ctxArray && emptyUntypedArrayArm(expr.whenTrue) && !emptyUntypedArrayArm(expr.whenFalse)) {
      elseRaw = lowerer.lowerExpr(expr.whenFalse);
      thenRaw = withRuntimeOptionalNarrowed(lowerer, runtimeTrueIds, () =>
        lowerArm(
          expr.whenTrue,
          elseRaw.type.kind === "dyn" && ownArrayJoin ? ownArrayJoin : elseRaw.type,
        ),
      );
    } else {
      thenRaw = lowerTrueArm();
      // A checked-dynamic producer (Object.entries(...).filter(...))
      // can still have a precise checker array type. Empty literal arms
      // must adopt that element layout before the checked array boundary.
      elseRaw = lowerArm(
        expr.whenFalse,
        thenRaw.type.kind === "dyn" && ownArrayJoin ? ownArrayJoin : thenRaw.type,
      );
    }
    // The ternary's IR type is normally the checker's own: it collapses
    // same-kind literal unions ("a" | "b" → string) and forms tagged
    // unions for mixed arms that map (`c ? okRec : errRec`); anything
    // left unmappable gets the type fence (badType) here. A record/union CONTEXTUAL type
    // takes over exactly when the own type can't carry the value —
    // unmappable, or a DIFFERENT union (branch literals omitting
    // DIFFERENT optional subsets make the own type a union of the
    // narrower fresh shapes, and a union-typed slot can sub-union the
    // same way; neither has a runtime re-tag, while tsc guarantees each
    // branch is assignable to the context). A base-CLASS context absorbs
    // the same case: branches producing different subclasses make the
    // own type a class union (`c ? new Dog() : new Bird()` against an
    // Animal slot), while each branch upcasts into the context fine. A
    // collapsed own type must WIN over a wider contextual union
    // (`console.log(c ? "yes" : "no")` stays string against the ambient
    // string | number | boolean parameter), and an 'unknown'/'any'
    // context never absorbs the ternary (`JSON.stringify(c ? 1 : 2)`
    // stays f64-typed). Arms that AGREE on an array type decide it
    // themselves (a context- or sibling-built literal arm can carry a
    // tagged element type the checker's own type doesn't spell).
    const own = lowerer.mapTypeOf(lowerer.typeOf(expr));
    const useCtx =
      (ctxMapped?.kind === "record" ||
        ctxMapped?.kind === "union" ||
        ctxMapped?.kind === "object") &&
      (own === null ||
        (own.kind === "union" &&
          !typeEquals(own, ctxMapped) &&
          !lowerer.inLogicalLeftPosition(expr)));
    // Mixed dyn/unit arms under an unmappable own type (`typeof pkg.name
    // === "string" ? pkg.name : null` — the lowering world types the
    // unknown-receiver read `any`, which a static build cannot hold):
    // dyn represents null and undefined directly, so the ternary stays
    // dyn — a unit arm converts to the dyn unit value (the dynFrom form
    // the index-signature lowerings already use). A FRESH literal arm
    // (`... ? pkg.scripts : {}` — the default-object idiom) converts the
    // same way when it is JSON-safe: nothing else aliases a literal, so
    // the dyn copy is unobservable.
    const dynish = (e: IrExpr): boolean =>
      e.type.kind === "dyn" ||
      e.kind === "unitLit" ||
      ((e.kind === "recordLit" || e.kind === "arrayLit") && lowerer.dynConvertible(e.type));
    const dynJoin =
      own === null &&
      !(useCtx && ctxMapped) &&
      dynish(thenRaw) &&
      dynish(elseRaw) &&
      (thenRaw.type.kind === "dyn" || elseRaw.type.kind === "dyn");
    // A checker-`any` ternary whose lowered arms are STATIC (`rawName ?
    // rawName.replace(...) : null` — the dyn-receiver string machinery
    // answers a static string): the checker's `any` carries no shape,
    // but the arms do — equal arms take their shared type, a unit arm
    // joins the other arm as its null/undefined-armed union. Gated on
    // genuine `any` so every other unmappable keeps its own diagnostic.
    let anyJoin: IrType | null = null;
    if (
      own === null &&
      !dynJoin &&
      !(useCtx && ctxMapped) &&
      (lowerer.typeOf(expr).flags & ts.TypeFlags.Any) !== 0
    ) {
      const a = thenRaw.type;
      const b = elseRaw.type;
      const staticArm = (t: IrType): boolean =>
        t.kind !== "dyn" && t.kind !== "caught" && t.kind !== "void";
      if (staticArm(a) && staticArm(b)) {
        if (typeEquals(a, b)) {
          anyJoin = a;
        } else if (isUnitType(a) !== isUnitType(b)) {
          const unit = isUnitType(a) ? a : b;
          const val = isUnitType(a) ? b : a;
          const arms =
            val.kind === "union" ? (lowerer.unions.get(val.unionId)?.arms ?? null) : [val];
          if (arms && !arms.some((x) => typeEquals(x, unit))) {
            anyJoin = { kind: "union", unionId: lowerer.unions.intern([...arms, unit]) };
          } else if (arms) {
            anyJoin = val; // the unit is already an arm
          }
        }
      }
    }
    // JavaScript function selection preserves the chosen closure's full
    // call ABI. A checker join can erase a rest/arguments pack even though
    // a later call supplies additional observable arguments.
    const callableJoin =
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      thenRaw.type.kind === "func" &&
      elseRaw.type.kind === "func" &&
      !typeEquals(thenRaw.type, elseRaw.type) &&
      lowerer.dynConvertible(thenRaw.type) &&
      lowerer.dynConvertible(elseRaw.type);
    // JavaScript inference can discard an initially-undefined field from
    // a conditional's type even after that field acquired other values.
    // A checked arm must retain its actual representation at the join.
    const checkedJsJoin =
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      (thenRaw.type.kind === "dyn" || elseRaw.type.kind === "dyn") &&
      lowerer.dynConvertible(thenRaw.type) &&
      lowerer.dynConvertible(elseRaw.type);
    let type =
      callableJoin || checkedJsJoin
        ? DYN
        : thenRaw.type.kind === "array" && typeEquals(thenRaw.type, elseRaw.type)
          ? thenRaw.type
          : dynJoin
            ? DYN
            : (anyJoin ?? (useCtx && ctxMapped ? ctxMapped : lowerer.irTypeOf(expr)));
    // A checker type that names only ONE arm while the lowered arms
    // disagree cannot be the join: the checker could not spell the other
    // arm's type (a union of module namespace types does not serialize
    // back, so `c ? import("./a") : import("./b")` reads as the first
    // arm), and coercing the second arm into the first would claim the two
    // namespaces are the same module. Join the arms the lowering actually
    // holds with the union mapping's promise rule instead.
    const namespaceArm = (t: IrType): boolean =>
      t.kind === "promise" && t.inner.kind === "moduleNs";
    if (
      !typeEquals(thenRaw.type, elseRaw.type) &&
      (namespaceArm(thenRaw.type) || namespaceArm(elseRaw.type)) &&
      (typeEquals(type, thenRaw.type) || typeEquals(type, elseRaw.type))
    ) {
      const joined = lowerer.mergePromiseArmTypes([thenRaw.type, elseRaw.type]);
      if (joined !== null) type = joined;
    }
    // An arm the checker types at the join can still hold an absent value
    // at run time (`flag ? empty.a : empty.b`): an unchecked key or element
    // read whose storage carries the undefined arm. The join keeps that
    // arm, so the ternary's result represents the missing value instead of
    // coercing it into the checker's narrower type. The absent-capable
    // origin is part of the test: an arm holding a declared optional that
    // the ternary's own guard proved present (`h.via === undefined ? "-" :
    // h.via`) is not an unchecked read, and its narrowed join stands.
    const admitsUndefined = (t: IrType): boolean =>
      t.kind === "union" && lowerer.armTag(t.unionId, UNDEFINED_T) >= 0;
    if (
      !admitsUndefined(type) &&
      ((lowerer.isRuntimeOptionalOrigin(expr.whenTrue) &&
        lowerer.runtimeOptionalWidening(thenRaw.type, type) !== null) ||
        (lowerer.isRuntimeOptionalOrigin(expr.whenFalse) &&
          lowerer.runtimeOptionalWidening(elseRaw.type, type) !== null))
    ) {
      const widened = lowerer.runtimeOptionalType(type);
      if (admitsUndefined(widened)) type = widened;
    }
    // Each arm flows into the ternary's type through the slot-coercion
    // path: union arms wrap, dyn slots reject the non-dyn arm with
    // SC1101, mismatched record shapes get SC2002; coerceInto is
    // inert when the types already agree.
    const intoDyn = (e: IrExpr): IrExpr =>
      e.type.kind === "dyn" ? e : { kind: "dynFrom", value: e, type: DYN, loc: e.loc };
    const then = dynJoin ? intoDyn(thenRaw) : lowerer.coerceInto(expr.whenTrue, thenRaw, type);
    const else_ = dynJoin ? intoDyn(elseRaw) : lowerer.coerceInto(expr.whenFalse, elseRaw, type);
    if (then.type.kind !== type.kind || else_.type.kind !== type.kind) {
      lowerer.badType(expr, lowerer.typeOf(expr));
    }
    return { kind: "ternary", cond, then, else_, type, loc };
  } finally {
    for (const n of falseArmNarrows) lowerer.chainNarrowedType.delete(n);
  }
}

/** Whether `expr` is the Number/Boolean prototype value a JavaScript
 * source read (jsPrimitivePrototypeValue: dyn.builtinPrototype for Number,
 * wrapper.booleanPrototype for Boolean), or one of its members: the value
 * is the prototype OBJECT, not the wrapper's primitive, so the checker's
 * wrapper type must not extract a scalar from it. */
function isPrimitivePrototypeValue(expr: IrExpr): boolean {
  if (expr.kind === "libCall")
    return expr.fn === "dyn.builtinPrototype" || expr.fn === "wrapper.booleanPrototype";
  return expr.kind === "dynKeyGet" && isPrimitivePrototypeValue(expr.value);
}

/** Whether `expr` is the DataView prototype value a JavaScript source read
 * (dyn.dataViewPrototype), or one of its members: the value is the
 * prototype OBJECT, and the interface's own bytes view is a different
 * representation, so the checker's DataView type must not extract one. */
export function isDataViewPrototypeValue(expr: IrExpr): boolean {
  if (expr.kind === "libCall") return expr.fn === "dyn.dataViewPrototype";
  return expr.kind === "dynKeyGet" && isDataViewPrototypeValue(expr.value);
}

/** Whether `node` reads one of the ES lib interface's three view fields —
 * `buffer`, `byteOffset`, `byteLength` — from a receiver the checker types
 * as `ArrayBufferView`. That interface is the common supertype of every
 * typed array and DataView, so it maps to the checked-dynamic value: its
 * three reads answer from the native view the value holds (its buffer by
 * identity) or from the dynamic tier, exactly as Node reads the property.
 * Extracting them as the declared `number` would throw where Node answers a
 * non-view value. @types/node's `NodeJS.ArrayBufferView` is its own
 * interface with its own mapping, whose reads keep the extraction. */
function isArrayBufferViewFieldRead(lowerer: Lowerer, node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const name = node.name.text;
  if (name !== "buffer" && name !== "byteOffset" && name !== "byteLength") return false;
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(node.expression));
  const symbol = type.getSymbol();
  if (symbol === undefined || ts.symbolName(symbol) !== "ArrayBufferView") return false;
  return (
    symbol.declarations?.some((decl) => {
      const file = ts.getSourceFileOfNode(decl);
      return lowerer.isStdlibFile(file) && !isNodeTypesPath(file.fileName);
    }) ?? false
  );
}

/** Checker-driven union narrowing. tsc's control-flow analysis narrows a
 * union-typed reference at use sites (`if (r.kind === "ok") { ...r... }`
 * types `r` as the ok-arm inside the branch); the IR value is still the
 * tagged union, so the read is bridged with a `unionNarrow` extracting
 * the arm's payload. The extraction relies on tsc having proven the tag;
 * backends verify it once and trap on a mismatch, so a wrong proof stops
 * the program instead of reading another arm. A checker type that maps to
 * the same union (unnarrowed use), to a SUB-union (partial narrowing —
 * unrepresentable without a re-tag), or to nothing (`never` in an
 * exhaustive default) leaves the expression union-typed. */
export function maybeNarrow(lowerer: Lowerer, expr: IrExpr, node: ts.Node): IrExpr {
  if (
    (expr.type.kind === "union" || expr.type.kind === "dyn") &&
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    ts.isPropertyAccessExpression(node)
  ) {
    const symbol = lowerer.checker.getSymbolAtLocation(node.name);
    if (
      symbol &&
      symbol.declarations.some(
        (decl) =>
          ts.isPropertyDeclaration(decl) &&
          !decl.initializer &&
          !decl.type &&
          isJsSourceFile(ts.getSourceFileOfNode(decl)),
      )
    ) {
      // Inference describes later writes, not the initial undefined.
      // A use that requires the inferred type must validate the value.
      return expr.type.kind === "dyn"
        ? expr
        : { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc };
    }
  }
  // A dyn read tsc narrowed to a SCALAR (a typeof test proved the kind):
  // bridge with a VALIDATED extraction — dynCheck, the checked-cast
  // machinery — rather than a trusted one. After the guard the check
  // never fires; a read smuggled past it throws a catchable TypeError
  // instead of misreading the payload (the dyn boundary's usual stance).
  // Object/array narrowings stay dyn-typed and keep their fences.
  if (expr.type.kind === "dyn") {
    // Number.prototype and Boolean.prototype (and their members) are the
    // prototype OBJECTS, though @types/node declares them with the wrapper
    // interface: extracting the wrapper's numeric value would throw.
    if (isPrimitivePrototypeValue(expr)) return expr;
    // DataView.prototype (and its members) is the prototype OBJECT, though
    // @types/node declares the interface: extracting the view would throw.
    if (isDataViewPrototypeValue(expr)) return expr;
    // A value typed `ArrayBufferView` reads its three view fields as the
    // dynamic answer: the interface is the common supertype of every typed
    // array and DataView, so the value is whatever view the program stored
    // (or none — the checker's `number` does not make the property exist),
    // and the dynamic tier answers the read from the native view behind it
    // or the way Node reads the property. A consumer that needs a number
    // checks it itself.
    if (isArrayBufferViewFieldRead(lowerer, node)) return expr;
    // A process.versions entry declared as a string can be absent here.
    if (isOptionalProcessVersionsRead(lowerer, node))
      return lowerer.coerceToExpected(expr, lowerer.withUndefinedArm(STRING));
    // A web stream member in JavaScript (a reader's closed promise, a read
    // result's value) keeps the checked-dynamic value its handle answered.
    if (ts.isPropertyAccessExpression(node) && isWebStreamMemberInJavaScript(lowerer, node))
      return expr;
    if (
      isJsSourceFile(ts.getSourceFileOfNode(node)) &&
      typeInvolvesWebStream(lowerer, lowerer.typeOf(node))
    )
      return expr;
    // An inferred JS member's storage may be deliberately wider than its
    // declaration (prototype-selected buffers, null-initialized scratch
    // objects). Extract at the consuming operation, not at the read.
    if (isJsSourceFile(ts.getSourceFileOfNode(node)) && ts.isPropertyAccessExpression(node)) {
      const receiver = lowerer.mapTypeOf(lowerer.typeOf(node.expression));
      if (receiver?.kind === "object") {
        const info = lowerer.classes.get(receiver.className);
        if (
          info?.fields.get(node.name.text)?.kind === "dyn" ||
          lowerer.findMethodOn(info ?? null, `get:${node.name.text}`)?.sig.ret.kind === "dyn"
        )
          return expr;
      }
      if (receiver?.kind === "classval") {
        const info = lowerer.classes.get(receiver.className);
        if (info && hasRuntimeStatics(info)) return expr;
      }
    }
    if (
      isJsSourceFile(ts.getSourceFileOfNode(node)) &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    ) {
      let receiver = node.expression;
      while (
        ts.isPropertyAccessExpression(receiver) ||
        ts.isElementAccessExpression(receiver) ||
        ts.isParenthesizedExpression(receiver)
      ) {
        if (ts.isPropertyAccessExpression(receiver)) {
          const owner = lowerer.mapTypeOf(lowerer.typeOf(receiver.expression));
          if (
            owner?.kind === "object" &&
            lowerer.classes.get(owner.className)?.fields.get(receiver.name.text)?.kind === "dyn"
          )
            return expr;
        }
        receiver = receiver.expression;
      }
      if (receiver.kind === ts.SyntaxKind.ThisKeyword && lowerer.resolveThis()?.type.kind === "dyn")
        return expr;
      if (ts.isIdentifier(receiver)) {
        const stored = lowerer.peekLocal(receiver)?.type ?? lowerer.globalOf(receiver)?.type;
        if (stored?.kind === "dyn") return expr;
        const symbol = lowerer.resolveValueSymbol(receiver);
        const bound = symbol && lowerer.implicitParamTypes?.get(symbol);
        if (bound && lowerer.mapTypeOf(bound)?.kind === "dyn") return expr;
      }
    }
    if (isJsSourceFile(ts.getSourceFileOfNode(node)) && ts.isIdentifier(node)) {
      const symbol = lowerer.resolveValueSymbol(node);
      if (
        symbol &&
        symbol.declarations.some(
          (decl) =>
            ts.isParameter(decl) &&
            ts.isMethodDeclaration(decl.parent) &&
            lowerer.checkedVirtualJsMethods.has(decl.parent),
        )
      )
        return expr;
      if (
        symbol &&
        symbol.declarations.some(
          (decl) => ts.isParameter(decl) && ts.isConstructorDeclaration(decl.parent),
        )
      )
        return expr;
      // A prototype method in a file TypeScript does not check takes its
      // documented parameters as checked-dynamic values whatever their
      // JSDoc says (paramShape); reads keep the actual value.
      if (
        symbol &&
        !lowerer.checkedJsFile(ts.getSourceFileOfNode(node)) &&
        symbol.declarations.some(
          (decl) =>
            ts.isParameter(decl) &&
            prototypeAssignedFunction(decl.parent) &&
            documentedParameter(decl),
        )
      )
        return expr;
      if (
        symbol &&
        symbol.declarations.some(
          (decl) => ts.isVariableDeclaration(decl) && jsBindingHasOpenWrites(lowerer, decl),
        )
      )
        return expr;
      // A `let c;` binding without a type takes its flow types from what
      // the code assigns, and the checker's types for those values can omit
      // undefined (`c = s[i]` past the end): reads keep the actual value.
      if (
        symbol &&
        symbol.declarations.some(
          (decl) =>
            ts.isVariableDeclaration(decl) &&
            decl.initializer === undefined &&
            decl.type === undefined &&
            ts.isIdentifier(decl.name) &&
            decl.parent?.parent !== undefined &&
            ts.isVariableStatement(decl.parent.parent) &&
            !/@type\b/.test(
              ts
                .getSourceFileOfNode(decl)
                .text.slice(decl.parent?.parent?.pos ?? decl.pos, ts.tokenStartOfNode(decl)),
            ),
        )
      )
        return expr;
      if (
        symbol &&
        symbol.declarations.some(
          (decl) =>
            ts.isParameter(decl) &&
            decl.initializer &&
            !decl.type &&
            !/@(?:param|type)\b/.test(
              ts
                .getSourceFileOfNode(decl)
                .text.slice(decl.parent?.pos ?? decl.pos, ts.tokenStartOfNode(decl)),
            ),
        )
      )
        return expr;
      if (
        symbol &&
        symbol.declarations.some((decl) => {
          if (!ts.isParameter(decl) || decl.type) return false;
          const fn = decl.parent;
          if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return false;
          const assignment = fn.parent;
          return (
            ts.isBinaryExpression(assignment) &&
            assignment.right === fn &&
            ts.isPropertyAccessExpression(assignment.left) &&
            assignment.left.name.text === "write" &&
            lowerer.isStdlibMember(assignment.left)
          );
        })
      )
        return expr;
    }
    // Node's TTY declarations promise booleans/numbers even when a pipe
    // has no such property. Preserve the checked read for JS capability
    // probes instead of treating a declaration as a runtime type guard.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(node)) &&
      ts.isPropertyAccessExpression(node) &&
      ["isTTY", "columns", "rows", "isRaw"].includes(node.name.text) &&
      lowerer.isStdlibMember(node)
    )
      return expr;
    // The same members in TypeScript, read off a stream value that is
    // dynamic (`process.stdin?.isTTY`, `const input = process.stdin;
    // input.isTTY`): the declared boolean or number is the value on a
    // terminal, and off one the property does not exist. The read keeps
    // the undefined arm and validates the kind, as the plain read of a
    // standard stream does (lowerProcessStreamProperty).
    if (ts.isPropertyAccessExpression(node) && isTerminalStreamMember(lowerer, node)) {
      const declared = lowerer.mapTypeOf(lowerer.checker.getNonNullableType(lowerer.typeOf(node)));
      if (declared && (declared.kind === "bool" || declared.kind === "f64"))
        return lowerer.coerceToExpected(expr, lowerer.withUndefinedArm(declared));
    }
    // The live value is authoritative even when checker flow calls it
    // never. Two flows reach here: a null-initialized JS field that later
    // receives an object, and a failed type predicate whose type is
    // `unknown` (`Check(value: unknown): value is Encode` with an
    // unconstrained `Encode`), which subtracts every member of the value
    // and so narrows it to never. Never is not a numeric guard, and no
    // check can produce an uninhabited value.
    if ((lowerer.typeOf(node).flags & ts.TypeFlags.Never) !== 0) return expr;
    const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (
      narrowed &&
      (narrowed.kind === "f64" ||
        narrowed.kind === "bool" ||
        narrowed.kind === "string" ||
        narrowed.kind === "bigint")
    ) {
      return { kind: "dynCheck", value: expr, type: narrowed, loc: expr.loc };
    }
    // An instanceof narrow retains the native view after validating its
    // exact element kind. Buffer also matches Uint8Array.
    if (narrowed?.kind === "bytes" || narrowed?.kind === "url") {
      return { kind: "dynCheck", value: expr, type: narrowed, loc: expr.loc };
    }
    // The same for a URLSearchParams. The operand of an assertion is left
    // to the assertion, which makes the same check.
    if (
      narrowed?.kind === "searchParams" &&
      !(
        node.parent !== undefined &&
        (ts.isAsExpression(node.parent) || ts.isTypeAssertion(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      return { kind: "dynCheck", value: expr, type: narrowed, loc: expr.loc };
    }
    // An `instanceof Error` narrow: the checked-dynamic tree's error encoding rebuilds a
    // fresh %Error (name/message/code from the marker object — a COPY,
    // the unknown boundary's stance; SEMANTICS.md 67), validated like
    // every dyn extraction.
    if (narrowed?.kind === "object" && narrowed.className === "%Error") {
      return { kind: "dynCheck", value: expr, type: narrowed, loc: expr.loc };
    }
    return expr;
  }
  // instanceof narrowing for classes: tsc types this USE as a subclass of
  // the IR value's class (only a dynamic instanceof test narrows a class
  // type), so the read bridges with a static downcast that backends verify
  // at run time, like the union bridge below.
  if (expr.type.kind === "object") {
    const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (narrowed?.kind === "union") {
      const union = narrowClassUnion(lowerer, expr, narrowed);
      if (union) return union;
    }
    if (
      narrowed?.kind === "object" &&
      narrowed.className !== expr.type.className &&
      lowerer.isSubclassOf(narrowed.className, expr.type.className)
    ) {
      const reduced = structuralNarrowing(lowerer, node, expr.type.className, narrowed);
      const union = reduced ? narrowClassUnion(lowerer, expr, reduced) : null;
      if (union) return union;
      if (lowerer.narrowing.untrusted(node, narrowed)) {
        const checked = checkedClassAssertion(lowerer, expr, narrowed, expr.loc);
        if (checked) return checked;
      }
      return { kind: "downcast", value: expr, type: narrowed, loc: expr.loc };
    }
    return expr;
  }
  if (expr.type.kind !== "union") return expr;
  if (ts.isPropertyAccessExpression(node) && isOptionalProcessStreamProperty(lowerer, node))
    return expr;
  if (isOptionalProcessVersionsRead(lowerer, node)) return expr;
  if (ts.isPropertyAccessExpression(node) && isOptionalReadlineCursorRead(lowerer, node))
    return expr;

  // Represented fields and index values can include undefined even when
  // checker inference or lib.d.ts declares strings (RegExp captures).
  // Only a declaration that represents the optional arm can provide a
  // trustworthy flow narrowing; otherwise consumers must check it.
  if (
    (expr.kind === "recordGet" || expr.kind === "recordKeyGet") &&
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  ) {
    // The read itself rules out a null or undefined receiver, which a
    // JavaScript receiver such as `m.groups` still declares.
    const receiver = lowerer.mapTypeOf(
      lowerer.checker.getNonNullableType(lowerer.typeOf(node.expression)),
    );
    const shape = receiver?.kind === "record" ? lowerer.shapes.get(receiver.shapeId) : undefined;
    const declared =
      expr.kind === "recordGet"
        ? shape?.fields.find((field) => field.name === expr.field)?.type
        : shape?.indexValue;
    if (
      lowerer.armTag(expr.type.unionId, UNDEFINED_T) >= 0 &&
      declared &&
      !(declared.kind === "union" && lowerer.armTag(declared.unionId, UNDEFINED_T) >= 0)
    )
      return expr;
    // The same for a field holding a Date's toJSON() result, whose null
    // the declared string does not represent.
    if (
      expr.kind === "recordGet" &&
      lowerer.isRuntimeOptionalField(expr.shapeId, expr.field) &&
      lowerer.armTag(expr.type.unionId, NULL_T) >= 0 &&
      declared &&
      !(declared.kind === "union" && lowerer.armTag(declared.unionId, NULL_T) >= 0)
    )
      return expr;
  }
  if (ts.isIdentifier(node)) {
    const symbol = lowerer.resolveValueSymbol(node);
    if (symbol && lowerer.unstableSwitchBindings.has(symbol)) return expr;
    // A binding initialized by a Date's toJSON() can hold null where the
    // checker says string; consumers check it.
    if (symbol && lowerer.dateJsonBindings.has(symbol)) return expr;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    getterResultHoldsUndeclaredUndefined(lowerer, node, expr)
  )
    return expr;
  const narrowedTs = lowerer.typeOf(node);
  const narrowed = lowerer.mapTypeOf(narrowedTs);
  const unnarrowed = instanceSlotUnnarrowed(lowerer, node, expr, narrowedTs, narrowed);
  if (unnarrowed) return unnarrowed;
  // `Array.isArray(u)` on a union with one readonly array/tuple arm: the
  // lib predicate narrows to `any[]`, possibly intersected with another
  // type. That mapping may be a checked value or a synthetic record, but
  // the tag test proved the union's one array-valued arm, so bridge to it
  // with the same trusted unionNarrow the mapped case below builds.
  if (lowerer.checkerAnyArrayType(narrowedTs)) {
    const def = lowerer.unions.get(expr.type.unionId);
    const arrayTags = lowerer.arrayValueTags(expr.type.unionId);
    if (arrayTags.length === 1) {
      const arm = def!.arms[arrayTags[0]!]!;
      const checked = checkedStaleArm(lowerer, node, expr, arrayTags[0]!, arm);
      if (checked) return checked;
      return {
        kind: "unionNarrow",
        unionId: expr.type.unionId,
        tag: arrayTags[0]!,
        value: expr,
        type: arm,
        loc: expr.loc,
      };
    }
  }
  // A narrowing that refines record arms with an intersection keeps the
  // stored layout: view the value as the stored arms that can hold it.
  if (narrowed?.kind === "union") {
    const hosted = hostedStorageView(lowerer, expr, narrowed, expr.loc);
    if (hosted) return hosted;
  }
  // An optional Iterable narrowed to the iterable union (`xs !== undefined`):
  // re-tag into it, so for-of, spread and the other consumers see the
  // Iterable itself.
  if (
    narrowed?.kind === "union" &&
    narrowed.unionId !== expr.type.unionId &&
    iterableUnionOf(lowerer, narrowed)
  ) {
    const helper = lowerer.narrowedRetagHelper(node, expr.type.unionId, narrowed.unionId, expr.loc);
    if (helper)
      return { kind: "call", callee: helper, args: [expr], type: narrowed, loc: expr.loc };
  }
  // A checker type narrowed to a UNIT arm (the `=== undefined` branch)
  // also stays union-typed: a unit arm has no payload to extract, and
  // nothing useful reads such a value anyway. (Standalone undefined maps
  // to void and standalone null to nothing, so the isUnitType guard is
  // defensive.)
  if (!narrowed || narrowed.kind === "union" || narrowed.kind === "void" || isUnitType(narrowed)) {
    return expr;
  }
  const tag = lowerer.armTag(expr.type.unionId, narrowed);
  if (
    tag < 0 &&
    narrowed.kind === "record" &&
    !lowerer.unions.get(expr.type.unionId)?.discriminant
  ) {
    const hosted = hostedStorageView(lowerer, expr, narrowed, expr.loc);
    if (hosted) return hosted;
  }
  if (tag < 0) {
    // The checker may refine fields inside a discriminated record too.
    // That creates a different mapped shape, but does not change the
    // stored payload layout. A required literal discriminator proves
    // which original arm to read; retain all of that arm's field types.
    const def = lowerer.unions.get(expr.type.unionId);
    if (narrowed.kind === "record" && def?.discriminant) {
      const property = lowerer.checker.getPropertyOfType(narrowedTs, def.discriminant.field);
      if (
        property &&
        !(
          property.flags &
          (ts.SymbolFlags.Optional | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)
        )
      ) {
        const values = literalValues(lowerer.checker.getTypeOfSymbol(property));
        const arm = values && literalUnionArm(def, values, (id) => lowerer.shapes.get(id));
        if (arm) {
          const checked = checkedStaleArm(
            lowerer,
            node,
            expr,
            lowerer.armTag(expr.type.unionId, arm),
            arm,
          );
          if (checked) return checked;
          return {
            kind: "unionNarrow",
            unionId: expr.type.unionId,
            tag: lowerer.armTag(expr.type.unionId, arm),
            value: expr,
            type: arm,
            loc: expr.loc,
          };
        }
      }
    }
    // A base-class arm can narrow to a subclass after instanceof. The
    // payload retains its base-class tag even when the union also has
    // records or other classes. Require one unambiguous containing arm.
    const arms = lowerer.unions.get(expr.type.unionId)?.arms ?? [];
    const valueTag =
      narrowed.kind === "object"
        ? arms.findIndex(
            (arm) =>
              arm.kind === "object" && lowerer.isSubclassOf(narrowed.className, arm.className),
          )
        : -1;
    const valueType = arms[valueTag];
    if (
      narrowed.kind === "object" &&
      valueType?.kind === "object" &&
      arms.every(
        (arm, i) =>
          i === valueTag ||
          arm.kind !== "object" ||
          !lowerer.isSubclassOf(narrowed.className, arm.className),
      ) &&
      lowerer.isSubclassOf(narrowed.className, valueType.className)
    ) {
      const checked = checkedStaleArm(lowerer, node, expr, valueTag, valueType, narrowed);
      if (checked) {
        return checkedClassAssertion(lowerer, checked, narrowed, expr.loc) ?? checked;
      }
      return {
        kind: "downcast",
        value: {
          kind: "unionNarrow",
          unionId: expr.type.unionId,
          tag: valueTag,
          value: expr,
          type: valueType,
          loc: expr.loc,
        },
        type: narrowed,
        loc: expr.loc,
      };
    }
    return expr;
  }
  const checked = checkedStaleArm(lowerer, node, expr, tag, narrowed);
  if (checked) return checked;
  return {
    kind: "unionNarrow",
    unionId: expr.type.unionId,
    tag,
    value: expr,
    type: narrowed,
    loc: expr.loc,
  };
}

/** A binding of a generic instance read where the checker narrowed nothing:
 * the type of the read is the binding's own declared type, and the slot
 * holds a union with that type as one arm among several value arms.
 *
 * The checker types a generic body against its constraints: the variable of
 * `for (const column of columns)` over `columns: T extends
 * ReadonlyArray<Column>` is a `Column`. The instance's slot holds what the
 * instance binds, and a T bound to the elements of constant tables beside
 * `Column` itself holds each table's own layout as an arm. `Column` there
 * is the view every arm satisfies, not the arm a control-flow test chose,
 * so extracting its arm would misread every other one. The value keeps its
 * arms and its consumer reads it as a union (a member every arm stores, or
 * the keyed read where they differ).
 *
 * A null or undefined arm the declared type does not have is still excluded
 * as before: it throws Node's TypeError for the operation consuming the
 * read. Null for every other read, which keeps the checker's narrowing. */
function instanceSlotUnnarrowed(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
  siteTs: ts.Type,
  site: IrType | null,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  if (!instanceSlotReadAtDeclaredType(lowerer, node, unionId, siteTs, site)) return null;
  const from = lowerer.unions.get(unionId)!;
  const values = from.arms.filter((arm) => !isUnitType(arm));
  if (values.length === from.arms.length) return value;
  if (!isSafeToRepeat(value)) return null;
  const subId = lowerer.unions.transform(from, values);
  const units = new Set<number>();
  from.arms.forEach((arm, tag) => {
    if (isUnitType(arm)) units.add(tag);
  });
  const helper = lowerer.unionRetagHelper(unionId, subId, value.loc, units);
  if (!helper) return null;
  const type: IrType = { kind: "union", unionId: subId };
  let result: IrExpr = { kind: "call", callee: helper, args: [value], type, loc: value.loc };
  for (const tag of units) {
    const message = staleReadMessage(node, from.arms[tag]!);
    if (message === null) continue;
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value, type: BOOL, loc: value.loc },
      then: nodeThrowExpr(1, "", message, type, value.loc),
      else_: result,
      type,
      loc: value.loc,
    };
  }
  return result;
}

/** Whether `node` reads a generic instance's binding at the binding's own
 * declared type while the slot `unionId` holds that type, `site`, as one arm
 * among several value arms: the reads instanceSlotUnnarrowed keeps whole.
 * The checker narrowed nothing there, so each of the other value arms still
 * reaches the read. */
export function instanceSlotReadAtDeclaredType(
  lowerer: Lowerer,
  node: ts.Node,
  unionId: string,
  siteTs: ts.Type,
  site: IrType | null,
): boolean {
  if (lowerer.typeParamBindings === null || site === null) return false;
  if (site.kind === "union" || site.kind === "void" || isUnitType(site)) return false;
  if (!ts.isIdentifier(node)) return false;
  const from = lowerer.unions.get(unionId);
  if (!from || lowerer.armTag(unionId, site) < 0) return false;
  const values = from.arms.filter((arm) => !isUnitType(arm));
  if (values.length < 2) return false;
  const symbol = lowerer.resolveValueSymbol(node);
  if (!symbol) return false;
  const declared = lowerer.checker.getTypeOfSymbol(symbol);
  // The declared type itself, or a type variable (`T[number]`) read through
  // its constraint: the whole declared type is assignable to the read's
  // type exactly when that type is no narrower than the constraint.
  // A test that only excluded null or undefined (`part === null ? … :
  // part.id`) chose no value arm either: the comparison is with the
  // declared type's values.
  const variable = (declared.flags & ts.TypeFlags.Instantiable) !== 0;
  const declaredValues = variable ? declared : lowerer.checker.getNonNullableType(declared);
  if (
    declaredValues !== siteTs &&
    !(
      lowerer.checker.isTypeAssignableTo(declaredValues, siteTs) &&
      (variable || lowerer.checker.isTypeAssignableTo(siteTs, declaredValues))
    )
  )
    return false;
  return true;
}

/** The number of value arms the slot `unionId` holds beside `site`. */
function otherValueArms(lowerer: Lowerer, unionId: string, site: IrType): number {
  const arms = lowerer.unions.get(unionId)?.arms ?? [];
  return arms.filter((arm) => !isUnitType(arm) && !typeEquals(arm, site)).length;
}

/** Names (SC6015) a read of a generic instance's binding that came out as
 * the one record its declared type names, `result`, while the slot holds
 * further value arms the checker did not narrow away
 * (instanceSlotReadAtDeclaredType): the extraction throws for each of
 * them. A read that kept its arms has a union type and is not named. */
export function noteStrandedInstanceRead(
  lowerer: Lowerer,
  node: ts.Identifier,
  result: IrType,
): void {
  if (lowerer.typeParamBindings === null || result.kind === "union") return;
  const slot = lowerer.peekLocal(node)?.type;
  if (slot === undefined || slot.kind !== "union") return;
  const siteTs = lowerer.typeOf(node);
  const site = lowerer.mapTypeOf(siteTs);
  if (site === null || !typeEquals(site, result)) return;
  if (!instanceSlotReadAtDeclaredType(lowerer, node, slot.unionId, siteTs, site)) return;
  lowerer.noteStrandedInstanceArm(
    node,
    lowerer.checker.typeToString(siteTs),
    otherValueArms(lowerer, slot.unionId, site),
  );
}

/** The same warning for the parameter `name` of a function literal lowered
 * at its slot's signature: the slot hands it `slot`, and the parameter binds
 * the one record `type` the checker gives it. The checker never narrows a
 * parameter, so each other value arm of the slot still arrives. */
export function noteStrandedInstanceParameter(
  lowerer: Lowerer,
  name: ts.Node,
  slot: IrType,
  type: IrType,
): void {
  if (lowerer.typeParamBindings === null || slot.kind !== "union" || type.kind !== "record") return;
  if (lowerer.armTag(slot.unionId, type) < 0) return;
  const others = otherValueArms(lowerer, slot.unionId, type);
  if (others === 0) return;
  lowerer.noteStrandedInstanceArm(name, lowerer.checker.typeToString(lowerer.typeOf(name)), others);
}

/** The same warning for a value that kept its arms (`value`, read at
 * `node`) and now flows into a slot of the one record its declared type
 * names: the conversion extracts that arm and throws for the others. */
export function noteStrandedInstanceFlow(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrType,
  expected: IrType,
): void {
  if (lowerer.typeParamBindings === null || value.kind !== "union") return;
  let read = node;
  while (ts.isParenthesizedExpression(read)) read = read.expression;
  const siteTs = lowerer.typeOf(read);
  const site = lowerer.mapTypeOf(siteTs);
  if (site === null || !typeEquals(site, expected)) return;
  if (!instanceSlotReadAtDeclaredType(lowerer, read, value.unionId, siteTs, site)) return;
  lowerer.noteStrandedInstanceArm(
    read,
    lowerer.checker.typeToString(siteTs),
    otherValueArms(lowerer, value.unionId, site),
  );
}

/** A getter read whose runtime result can be undefined (an unchecked
 * element read in its body, or in another member of its override family)
 * although its declared type cannot. The checker's type for the read is
 * then no narrowing proof, so the read keeps the getter's result. */
function getterResultHoldsUndeclaredUndefined(
  lowerer: Lowerer,
  node: ts.PropertyAccessExpression,
  expr: IrExpr,
): boolean {
  if (expr.type.kind !== "union" || lowerer.armTag(expr.type.unionId, UNDEFINED_T) < 0)
    return false;
  const getter =
    (expr.kind === "virtualCall" && expr.method.startsWith("get:")) ||
    (expr.kind === "call" && expr.callee.includes(".get:"));
  if (!getter) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(node.name);
  if (!symbol || (symbol.flags & ts.SymbolFlags.GetAccessor) === 0) return false;
  const declared = lowerer.checker.getTypeOfSymbol(symbol);
  const holdsUndefined = (type: ts.Type): boolean =>
    (type.flags &
      (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
    0;
  return !(
    holdsUndefined(declared) ||
    (declared.isUnionType() && ts.constituentTypes(declared).some(holdsUndefined))
  );
}

/** The checked form of maybeNarrow's arm extraction for a narrowing the
 * checker may hold past code that replaced the value (a call clearing the
 * property; see NarrowingStability). Every other arm throws the TypeError
 * Node raises for the operation consuming the read (`Cannot read
 * properties of undefined (reading 'x')`, `o.f is not a function`), or the
 * stranded-value TypeError where Node would carry the value on. Null when
 * the narrowing is provably current. `narrowed` is the checker's type when
 * it refines the arm (a subclass view). */
function checkedStaleArm(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
  tag: number,
  arm: IrType,
  narrowed: IrType = arm,
): IrExpr | null {
  if (value.type.kind !== "union" || tag < 0) return null;
  if (!lowerer.narrowing.untrusted(node, narrowed)) return null;
  const inPlace = checkedArmExtraction(lowerer, value, tag, arm, (found) =>
    staleReadMessage(node, found),
  );
  if (inPlace) return inPlace;
  const helper = lowerer.narrowedArmHelper(value.type.unionId, arm, value.loc);
  return helper ? lowerer.checkedNarrowCall(helper, value, arm, value.loc) : null;
}

/** V8's spelling of a callee in "is not a function": a string-literal
 * element key reads as a property name (`o["a"]` is `o.a`), other keys
 * keep their brackets, parentheses and type syntax disappear (`!`, `as`,
 * `satisfies`, `<T>` assertions), and a call result reads `f(...)`. */
export function v8CalleeText(node: ts.Node): string {
  // Type syntax is type-only: the running JavaScript has no trace of it.
  if (
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertion(node)
  )
    return v8CalleeText(node.expression);
  // A call result prints with its arguments elided.
  if (ts.isCallExpression(node) && !node.questionDotToken)
    return `${v8CalleeText(node.expression)}(...)`;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    const object = v8CalleeText(node.expression);
    return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
      ? `${object}.${key.text}`
      : `${object}[${ts.getTextOfNode(key)}]`;
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken)
    return `${v8CalleeText(node.expression)}.${node.name.text}`;
  return ts.getTextOfNode(node);
}

/** Node's TypeError for the operation consuming `node` when it holds a
 * value of type `found`, or null where Node would not throw. */
export function staleReadMessage(node: ts.Node, found: IrType): string | null {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isCallExpression(parent) && parent.expression === child && !parent.questionDotToken) {
    return found.kind === "func" ? null : `${v8CalleeText(node)} is not a function`;
  }
  const unit = found.kind === "undefinedT" ? "undefined" : found.kind === "nullT" ? "null" : null;
  if (unit === null) return null;
  if (
    !(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) ||
    parent.expression !== child ||
    parent.questionDotToken
  )
    return null;
  let key: string | null = null;
  if (ts.isPropertyAccessExpression(parent)) key = parent.name.text;
  else if (ts.isStringLiteral(parent.argumentExpression)) key = parent.argumentExpression.text;
  else if (ts.isNumericLiteral(parent.argumentExpression))
    key = String(Number(parent.argumentExpression.text));
  // `delete x!.k`: ToObject runs before the key is used, and its TypeError
  // names neither the receiver nor the key.
  let use: ts.Node = parent;
  while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
  if (ts.isDeleteExpression(use.parent)) return DELETE_NULLISH_RECEIVER;
  if (key === null) return null;
  const store = parent.parent;
  return ts.isBinaryExpression(store) &&
    store.left === parent &&
    store.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? `Cannot set properties of ${unit} (setting '${key}')`
    : `Cannot read properties of ${unit} (reading '${key}')`;
}

/** The stored records of a runtime-optional slot whose binding the checker
 * types as ONE record. A generic function iterates its type parameter as
 * the constraint's elements (`T extends readonly R[]` reads an element as
 * `R`), while an instantiation stores its own element records with the
 * hidden hole arm (`A | B | undefined`). Nothing is narrowed there: the
 * read goes through the stored records (`A | B`), as it does for a slot
 * without the hole arm, and the caller reports the hole as Node's
 * member-read TypeError. Null for a receiver the checker narrowed or an
 * assertion renamed: those name a type the storage does not prove. */
function unnarrowedStoredRecords(
  lowerer: Lowerer,
  expr: ts.Identifier,
  narrowedNode: ts.Expression,
  local: IrLocal,
  narrowed: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (narrowedNode !== expr || narrowed.kind !== "record" || local.type.kind !== "union")
    return null;
  // A named member read lowers over the stored records; a keyed read
  // (`x["k"]`) and a call still expect the checker's one record.
  if (runtimeOptionalUseOf(expr)?.kind !== "property") return null;
  // The receiver reads at the binding's declared type: no guard, predicate
  // or assignment narrowed it on the way here.
  const symbol = lowerer.checker.getSymbolAtLocation(expr);
  if (!symbol || lowerer.checker.getTypeOfSymbol(symbol).id !== lowerer.typeOf(expr).id)
    return null;
  const present = lowerer.stripUndefinedArm(local.type);
  if (present.kind !== "union") return null;
  const arms = lowerer.unions.get(present.unionId)?.arms ?? [];
  if (arms.length < 2 || arms.some((arm) => arm.kind !== "record")) return null;
  const hole = lowerer.armTag(local.type.unionId, UNDEFINED_T);
  const helper = lowerer.unionRetagHelper(
    local.type.unionId,
    present.unionId,
    loc,
    new Set([hole]),
  );
  if (!helper) return null;
  return {
    kind: "call",
    callee: helper,
    args: [varRef(local.id, local.type, loc)],
    type: present,
    loc,
  };
}

/** A runtime-optional slot can be assigned while a truthy guard is in
 * force. TypeScript then types a direct member receiver as the plain arm,
 * even though an OOB-safe assignment may have restored undefined. Check
 * that hidden arm and throw the member-read TypeError Node would produce. */
export function runtimeOptionalReceiverRead(
  lowerer: Lowerer,
  expr: ts.Identifier,
  local: IrLocal,
  property: string | null,
  loc: SrcLoc,
): IrExpr {
  if (local.type.kind !== "union") {
    lowerer.runtimeOptionalLocals.delete(local);
    lowerer.runtimeOptionalStorageLocals.delete(local);
    return varRef(local.id, local.type, loc);
  }
  // A non-null/type assertion around the receiver carries the useful
  // checker narrowing on the wrapper rather than on the identifier token
  // itself (`gg!.day`). Follow only erased wrappers; the member/call node
  // still receives the checked extraction built below.
  let narrowedNode: ts.Expression = expr;
  while (
    (ts.isParenthesizedExpression(narrowedNode.parent) ||
      ts.isAssertionExpression(narrowedNode.parent) ||
      ts.isSatisfiesExpression(narrowedNode.parent) ||
      ts.isNonNullExpression(narrowedNode.parent)) &&
    narrowedNode.parent.expression === narrowedNode
  ) {
    narrowedNode = narrowedNode.parent;
  }
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(narrowedNode));
  if (!narrowed || isUnitType(narrowed)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "a runtime-optional capture whose narrowed value type is not representable",
    );
  }
  // An array hole in a slot with more than two arms fails the member
  // access with Node's TypeError before the checked extraction runs.
  const holeGuarded = (extracted: IrExpr): IrExpr => {
    if (local.type.kind !== "union") return extracted;
    const holeTag = lowerer.armTag(local.type.unionId, UNDEFINED_T);
    if (holeTag < 0) return extracted;
    return {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: local.type.unionId,
        tag: holeTag,
        negated: false,
        value: varRef(local.id, local.type, loc),
        type: BOOL,
        loc,
      },
      then: nodeThrowExpr(
        1,
        "",
        runtimeOptionalReceiverMessage(lowerer, expr, property),
        extracted.type,
        loc,
      ),
      else_: extracted,
      type: extracted.type,
      loc,
    };
  };
  if (narrowed.kind === "union") {
    const classView = narrowStoredClassValue(lowerer, varRef(local.id, local.type, loc), narrowed);
    if (classView) return classView;
    // The checker may keep the receiver at the storage union unchanged
    // (`string | undefined` on a JS `.match()` call). There is no
    // sub-union to re-tag: preserve the value for the downstream
    // nullable-receiver lowering, which performs the member-specific
    // checked extraction. Refusing here deferred the whole statement to
    // a runtime fence before that lowering could run.
    if (typeEquals(local.type, narrowed)) {
      return varRef(local.id, local.type, loc);
    }
    // A captured array element can itself be a union of records (for
    // example Circle | Square). The optional storage union has one extra
    // undefined arm; re-tag it to the checker-narrowed value union with a
    // checked trap for that arm, then let union property lowering inspect
    // the surviving record arms.
    const helper = lowerer.narrowedRetagHelper(
      narrowedNode,
      local.type.unionId,
      narrowed.unionId,
      loc,
    );
    if (!helper) {
      // Intersection-refined record arms read through their stored
      // layout (the predicate `r is Route & { path: string }`).
      const hosted = hostedStorageView(lowerer, varRef(local.id, local.type, loc), narrowed, loc);
      if (hosted) return hosted;
      // The checker can also type the receiver WIDER than its storage. In
      // a generic function a member receiver reads as the type parameter's
      // constraint (`T extends A | B | C` reads as `A | B | C`), while an
      // instantiation stores its own type argument (`A | undefined`).
      // Nothing is narrowed there: every stored arm but the hidden
      // undefined is an arm of the checker's union, so the read goes
      // through the storage.
      const stored = lowerer.unions.get(local.type.unionId)?.arms ?? [];
      const hiddenTag = lowerer.armTag(local.type.unionId, UNDEFINED_T);
      const widerView =
        hiddenTag >= 0 &&
        stored.length >= 2 &&
        stored.every((arm, tag) => tag === hiddenTag || lowerer.armTag(narrowed.unionId, arm) >= 0);
      const widened =
        widerView && stored.length > 2
          ? lowerer.unionRetagHelper(
              local.type.unionId,
              narrowed.unionId,
              loc,
              new Set([hiddenTag]),
            )
          : null;
      if (!widerView || (stored.length > 2 && !widened)) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "a runtime-optional capture whose narrowed union is not representable",
        );
      }
      // Several stored arms keep their tags in the checker's union; the
      // undefined arm fails the member access with Node's TypeError. One
      // stored arm takes the two-arm extraction below.
      if (widened) {
        return holeGuarded({
          kind: "call",
          callee: widened,
          args: [varRef(local.id, local.type, loc)],
          type: narrowed,
          loc,
        });
      }
    } else {
      return {
        kind: "call",
        callee: helper,
        args: [varRef(local.id, local.type, loc)],
        type: narrowed,
        loc,
      };
    }
  }
  if (narrowed.kind === "object") {
    const view = checkedClassAssertion(lowerer, varRef(local.id, local.type, loc), narrowed, loc);
    // Preserve the member-specific missing-value error on the two-arm
    // path below; mixed storage also needs to validate its concrete class.
    if (view && (lowerer.unions.get(local.type.unionId)?.arms.length ?? 0) > 2)
      return holeGuarded(view);
  }
  if (narrowed.kind === "record" && lowerer.armTag(local.type.unionId, narrowed) < 0) {
    const hosted = hostedStorageView(lowerer, varRef(local.id, local.type, loc), narrowed, loc);
    if (hosted) return hosted;
  }
  const undefTag = lowerer.armTag(local.type.unionId, UNDEFINED_T);
  const def = lowerer.unions.get(local.type.unionId);
  if (!def || undefTag < 0)
    throw new InternalCompilerError("runtime-optional local is missing its undefined arm");
  if (def.arms.length !== 2) {
    // The checker narrowed nothing where a generic instance's binding reads
    // at its declared type (instanceSlotUnnarrowed): that type is the view
    // every stored arm satisfies, also when it is itself one of the arms.
    // The receiver keeps its value arms, and the hidden arm throws Node's
    // TypeError for this member read or call. An erased wrapper names a
    // type of its own and keeps the checked extraction below.
    if (narrowedNode === expr) {
      const unnarrowed = instanceSlotUnnarrowed(
        lowerer,
        expr,
        varRef(local.id, local.type, loc),
        lowerer.typeOf(expr),
        narrowed,
      );
      if (unnarrowed) return unnarrowed;
    }
    // The checker may narrow a runtime-optional capture to one arm of a
    // value union (`Circle | Square | undefined` -> `Circle`). The
    // two-arm fast path below cannot extract that arm safely: a later
    // array mutation can leave any of the stored tags in the slot. Use
    // the checked helper so every other arm, including undefined, remains
    // a catchable TypeError rather than an unchecked payload read.
    let extraction: { helper: string; target: IrType } | null = null;
    const direct = lowerer.narrowedArmHelper(local.type.unionId, narrowed, loc);
    if (direct) extraction = { helper: direct, target: narrowed };
    else if (narrowedNode !== expr) {
      // An erased wrapper types the WRAPPER, not the capture: `x as T`
      // names T even where the checker's flow type at `x` itself proves
      // one stored arm. Node erases the wrapper and the value keeps its
      // stored layout, which is what the two-arm path reads through
      // (maybeNarrow, below). Take that proved arm here too instead of
      // refusing every capture whose storage has several arms.
      const flow = lowerer.mapTypeOf(lowerer.typeOf(expr));
      const helper =
        flow && !isUnitType(flow) && lowerer.armTag(local.type.unionId, flow) >= 0
          ? lowerer.narrowedArmHelper(local.type.unionId, flow, loc)
          : null;
      if (flow && helper) extraction = { helper, target: flow };
    }
    if (!extraction) {
      const stored = unnarrowedStoredRecords(lowerer, expr, narrowedNode, local, narrowed, loc);
      if (stored) return holeGuarded(stored);
      lowerer.unsupported(
        "SC1090",
        expr,
        "a direct read from a runtime-optional capture with multiple value arms",
      );
    }
    return holeGuarded(
      lowerer.checkedNarrowCall(
        extraction.helper,
        varRef(local.id, local.type, loc),
        extraction.target,
        loc,
      ),
    );
  }
  // A predicate can strengthen a record's fields or narrow a base class
  // to a subclass without changing the slot's stored value arm. Extract
  // that actual arm first: record reads need its original field layout,
  // and class reads apply the ordinary downcast bridge afterward.
  const valueTag = undefTag === 0 ? 1 : 0;
  const valueType = def.arms[valueTag];
  if (!valueType || isUnitType(valueType)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "a runtime-optional receiver without a representable value arm",
    );
  }
  const message = runtimeOptionalReceiverMessage(lowerer, expr, property);
  return lowerer.maybeNarrow(
    {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: local.type.unionId,
        tag: undefTag,
        negated: false,
        value: varRef(local.id, local.type, loc),
        type: BOOL,
        loc,
      },
      then: nodeThrowExpr(1, "", message, valueType, loc),
      else_: {
        kind: "unionNarrow",
        unionId: local.type.unionId,
        tag: valueTag,
        value: varRef(local.id, local.type, loc),
        type: valueType,
        loc,
      },
      type: valueType,
      loc,
    },
    narrowedNode,
  );
}

/** The member access `node` is the receiver of, through the erased
 * wrappers (`x.k`, `x!.k`, `(x as View)["k"]`), with the outermost wrapper
 * (the access's own receiver node). Null when `node` is not a receiver. */
function receiverAccessOf(node: ts.Expression): {
  receiver: ts.Expression;
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression;
} | null {
  let receiver: ts.Expression = node;
  for (;;) {
    const parent: ts.Node | undefined = receiver.parent;
    if (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === receiver
    ) {
      receiver = parent;
      continue;
    }
    break;
  }
  const access = receiver.parent;
  if (
    access === undefined ||
    !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
    access.expression !== receiver
  )
    return null;
  return { receiver, access };
}

/** Node's TypeError message for a member read (`property`) or a call
 * (`property` null) through an undefined runtime-optional receiver. A
 * member `delete` through an erased wrapper (`delete x!.k`,
 * `delete (x as View).k`) runs ToObject on the receiver instead of reading
 * it, and a plain assignment through a converting assertion, which
 * addresses this receiver in place (asserted-receiver.ts), sets the member
 * without reading it. */
function runtimeOptionalReceiverMessage(
  lowerer: Lowerer,
  expr: ts.Identifier,
  property: string | null,
): string {
  if (property === null) return `${expr.text} is not a function`;
  const use = receiverAccessOf(expr);
  if (use !== null) {
    let outer: ts.Node = use.access;
    while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
    if (use.receiver !== expr && ts.isDeleteExpression(outer.parent))
      return DELETE_NULLISH_RECEIVER;
    if (plainAssignmentTarget(use.access) && convertingAssertion(lowerer, use.receiver) !== null)
      return `Cannot set properties of undefined (setting '${property}')`;
  }
  return `Cannot read properties of undefined (reading '${property}')`;
}

export function runtimeOptionalTrueIds(lowerer: Lowerer, node: ts.Expression): IrLocal[] {
  return runtimeOptionalGuardIds(lowerer, node, true);
}

/** Presence proved by one outcome of a boolean guard. Negation flips
 * the outcome; all operands of a true AND or false OR have that outcome.
 * Assignments invalidate a syntactic proof even when checker types hide
 * the undefined produced by an out-of-bounds read. */
export function runtimeOptionalGuardIds(
  lowerer: Lowerer,
  node: ts.Expression,
  truthy: boolean | null,
): IrLocal[] {
  const candidates: IrLocal[] = [];
  const collect = (expr: ts.Expression, outcome: boolean | null): void => {
    if (ts.isParenthesizedExpression(expr)) return collect(expr.expression, outcome);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      return collect(expr.operand, outcome === null ? null : !outcome);
    }
    if (
      ts.isBinaryExpression(expr) &&
      ((outcome === true && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) ||
        (outcome === false && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    ) {
      collect(expr.left, outcome);
      collect(expr.right, outcome);
    } else if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
      // A completed ordinary member read checked its receiver even if
      // the property's value was falsy. Optional chains make no such
      // promise, and calls/captures retain their separate checked ABI.
      const local = runtimeOptionalLocalOf(lowerer, expr.expression);
      if (local !== null) candidates.push(local);
      else if (ts.isPropertyAccessExpression(expr.expression)) collect(expr.expression, outcome);
    } else if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
      expr.operatorToken.kind !== ts.SyntaxKind.BarBarToken &&
      expr.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
      // Both operands of a comparison/arithmetic operator are evaluated.
      // Only member reads prove presence; bare identifiers need truth.
      const member = (operand: ts.Expression): void => {
        while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
        if (ts.isPropertyAccessExpression(operand)) collect(operand, outcome);
      };
      member(expr.left);
      member(expr.right);
      const op = expr.operatorToken.kind;
      const equal =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
      const unequal =
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if ((equal && outcome === false) || (unequal && outcome === true)) {
        const present = (value: ts.Expression, unit: ts.Expression): void => {
          while (ts.isParenthesizedExpression(unit)) unit = unit.expression;
          const excludesUndefined =
            (ts.isIdentifier(unit) &&
              unit.text === "undefined" &&
              (lowerer.typeOf(unit).flags & ts.TypeFlags.Undefined) !== 0) ||
            (unit.kind === ts.SyntaxKind.NullKeyword &&
              (op === ts.SyntaxKind.EqualsEqualsToken ||
                op === ts.SyntaxKind.ExclamationEqualsToken));
          if (excludesUndefined) {
            const local = runtimeOptionalLocalOf(lowerer, value);
            if (local !== null) candidates.push(local);
          }
        };
        present(expr.left, expr.right);
        present(expr.right, expr.left);
      }
    } else if (outcome) {
      const local = runtimeOptionalLocalOf(lowerer, expr);
      if (local !== null) candidates.push(local);
    }
  };
  collect(node, truthy);
  if (candidates.length === 0) return candidates;
  const assigned = new Set<IrLocal>();
  const visit = (part: ts.Node): void => {
    if (ts.isFunctionLike(part)) return;
    let target: ts.Node | null = null;
    if (
      ts.isBinaryExpression(part) &&
      part.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      part.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      target = part.left;
    if (
      (ts.isPrefixUnaryExpression(part) || ts.isPostfixUnaryExpression(part)) &&
      (part.operator === ts.SyntaxKind.PlusPlusToken ||
        part.operator === ts.SyntaxKind.MinusMinusToken)
    )
      target = part.operand;
    if (target !== null) {
      // Destructuring assignments can contain several identifiers.
      const mark = (name: ts.Node): void => {
        if (ts.isIdentifier(name)) {
          const local = lowerer.resolveLocal(name);
          if (local) assigned.add(lowerer.runtimeOptionalRootOf(local));
        }
        ts.forEachChild(name, mark);
      };
      mark(target);
    }
    ts.forEachChild(part, visit);
  };
  visit(node);
  return candidates.filter((local) => !assigned.has(lowerer.runtimeOptionalRootOf(local)));
}

export function withRuntimeOptionalNarrowed<T>(
  lowerer: Lowerer,
  locals: readonly IrLocal[],
  fn: () => T,
): T {
  if (locals.length === 0) return fn();
  for (const local of locals)
    lowerer.runtimeOptionalLocals.delete(lowerer.runtimeOptionalRootOf(local));
  try {
    return fn();
  } finally {
    for (const local of locals)
      lowerer.runtimeOptionalLocals.add(lowerer.runtimeOptionalRootOf(local));
  }
}

/** `x as T`. Non-dyn inner values ordinarily erase; a record assertion
 * changing monomorphic shape rebuilds through the established width-copy
 * path so its represented value agrees with its asserted type.
 * A dyn ('unknown') inner value makes this THE dynamic boundary:
 * - `as unknown` (dyn → dyn) stays erasure;
 * - dyn → a JSON-representable target type T compiles to `dynCheck`, a
 *   runtime validation that builds the typed value or THROWS a catchable
 *   TypeError-flavored error (JS `as` never checks — the headline
 *   documented divergence: a lying cast throws instead of corrupting
 *   memory);
 * - dyn → anything else (closures, class instances, void) is rejected:
 *   those types cannot be found inside a JSON dyn. */
/** A class instance, or a union of class instances and unit arms (a
 * runtime-optional binding such as `const node = stack.pop()!`). */
function classInstanceOrAbsent(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "object") return true;
  if (type.kind !== "union") return false;
  const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
  return (
    arms.some((arm) => arm.kind === "object") &&
    arms.every((arm) => arm.kind === "object" || isUnitType(arm))
  );
}

/** `Object.fromEntries(...) as T` with T a declared record (the generic
 * `transform<T extends Record<string, unknown>>(t: T): T` idiom): the
 * entries build a pure index-signature record, which has no layout in
 * common with T's struct. Node keeps the object itself, with exactly the
 * keys and the order the entries gave it. The result of fromEntries is a
 * fresh object nothing else references, so the checked-dynamic bridge,
 * which keeps keys and their order the same way `JSON.parse(text) as T`
 * does, cannot be told apart from the original object; a value outside
 * T throws the catchable TypeError of every checked cast. The entries'
 * values must be scalars or checked-dynamic values, which the bridge
 * passes by value or by identity; native arrays and records would be
 * copied. Other sources may be aliased, where a rebuilt object would sever
 * mutation, so they keep the exact-shape fence. */
function freshEntriesRecordAssertion(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  inner: IrExpr,
  target: IrType | null,
): IrExpr | null {
  if (inner.type.kind !== "record" || target?.kind !== "record") return null;
  const source = lowerer.shapes.get(inner.type.shapeId);
  const dest = lowerer.shapes.get(target.shapeId);
  if (!source?.indexValue || source.tuple || source.fields.length > 0) return null;
  if (!dest || dest.tuple || dest.indexValue || shapeHasAccessorSlots(dest)) return null;
  // Native arrays and records in the entries would be copied on the way
  // through the checked-dynamic bridge, severing their identity: only
  // slots of scalars or checked-dynamic values pass.
  if (extractionCopiesReference(lowerer, source.indexValue)) return null;
  let operand: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (
    !ts.isCallExpression(operand) ||
    !ts.isPropertyAccessExpression(operand.expression) ||
    operand.expression.name.text !== "fromEntries" ||
    !lowerer.isStdlibGlobal(operand.expression.expression, "Object")
  )
    return null;
  if (!lowerer.dynConvertible(inner.type)) return null;
  if (
    !canDynCheckTo(
      target,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  const loc = locOf(expr);
  return { kind: "dynCheck", value: lowerer.coerceToExpected(inner, DYN), type: target, loc };
}

/** Whether the assertion `expr` initializes a `const` binding whose identity
 * a field copy would change: something writes through the binding, or
 * compares it with `===`/`!==`. Node erases the assertion, so such a binding
 * must reach the value itself; a read-only view answers the same members
 * either way and keeps the copy (`divergences.ts`, `bindingIdentityUse`). */
function assertedBindingUsesIdentity(lowerer: Lowerer, expr: ts.Expression): boolean {
  let node: ts.Node = expr;
  while (
    node.parent !== undefined &&
    (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent))
  )
    node = node.parent;
  const decl = node.parent;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return false;
  return bindingIdentityUse(decl, lowerer.checker);
}

/** `e as T` and the old-style assertion `<T>e` — one node shape (both
 * carry `.type` and `.expression`), one lowering. */
export function lowerAsExpression(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
): IrExpr {
  // `[] as const` — tsgo panics computing the expression's `readonly []`
  // type (the facade's fence answers `any`), but the syntax pins the
  // value exactly: the empty tuple, ridden as the unit-element array
  // (mapType's empty-tuple rule). Lower it directly; enclosing slots
  // coerce like any other empty-array source.
  if (
    ts.isAsExpression(expr) &&
    isConstAssertionTypeNode(expr.type) &&
    ts.isArrayLiteralExpression(expr.expression) &&
    expr.expression.elements.nodes.length === 0
  ) {
    return {
      kind: "arrayLit",
      elems: [],
      type: arrayOf(unitOnlyUnion(lowerer.unions)),
      loc: locOf(expr),
    };
  }
  // A RECORD LITERAL asserted to a wider record type (`{ truncated: true }
  // as TruncationResult`): keep the literal's own layout and let the
  // asserted type view it (partial-assertions.ts). The record-to-record
  // width copy below cannot build a value the literal does not have.
  {
    const partial = partialAssertionSite(lowerer, expr);
    if (partial) return lowerPartialAssertion(lowerer, expr, partial);
  }
  // `e as C` on a CATCH BINDING (`(err as Error).message`): the checked
  // extraction — an instanceof match extracts the payload, anything else
  // throws the catchable TypeError (dynCheck's trust-but-verify stance,
  // extended to exception payloads). Intercepts BEFORE lowerExpr — the
  // raw read would hit caughtRead's narrowness fence.
  const caughtLocal = lowerer.caughtLocalOf(expr.expression);
  if (caughtLocal) {
    const loc = locOf(expr);
    const targetTs = lowerer.checker.getTypeFromTypeNode(expr.type);
    const target = lowerer.mapTypeOf(targetTs);
    if (target?.kind === "object") {
      const info = lowerer.classes.get(target.className);
      if (info && lowerer.inHierarchy(info)) {
        return {
          kind: "caughtCheck",
          value: { kind: "varRef", localId: caughtLocal.id, type: CAUGHT, loc },
          className: target.className,
          type: target,
          loc,
        };
      }
    }
    // Every other assertion takes the ordinary path below over the
    // binding's read (caughtRead): its checked-dynamic value, or the
    // extraction its narrowing proved. A structural assertion then goes
    // through the checked dynamic bridge, which keeps primitive values and
    // native class identity before validating the requested shape; an
    // assertion does not bypass runtime checks.
  }
  // `{ ...message, content } as T`: the program claimed the literal's shape,
  // so a union-valued member converts in a checked context — an arm the
  // asserted target excludes throws the catchable TypeError (a lying
  // assertion) instead of refusing the member (coercions.assertedOperand).
  // Parentheses and non-null assertions name the same literal
  // (`({ ...message, content }) as T`). An inner assertion or `satisfies`
  // carries its own operand context.
  let assertedSource = expr.expression;
  while (ts.isParenthesizedExpression(assertedSource) || ts.isNonNullExpression(assertedSource))
    assertedSource = assertedSource.expression;
  const assertedOperand = assertedSource.kind === ts.SyntaxKind.ObjectLiteralExpression;
  if (assertedOperand) lowerer.coercions.assertedOperand++;
  let inner: IrExpr;
  try {
    inner = lowerer.lowerExpr(expr.expression);
  } finally {
    if (assertedOperand) lowerer.coercions.assertedOperand--;
  }
  const use = runtimeOptionalUseOf(expr);
  if (inner.type.kind === "union" && runtimeOptionalAssertionErases(lowerer, expr, inner, use))
    return inner;
  if (inner.type.kind !== "dyn") {
    const targetTs0 = lowerer.checker.getTypeFromTypeNode(expr.type);
    // A generic body's `return built as Result<T>` names its declared result
    // by a type the checker keeps symbolic: the record the function built
    // takes the instance's result type (built-record-results.ts).
    const target =
      lowerer.mapTypeOf(targetTs0) ?? builtRecordResultType(lowerer, expr, inner, targetTs0);
    // A static assertion ERASES in Node, but the claim it makes still
    // answers to the program: a slot this value reaches that no ordinary
    // conversion covers (SC2002/SC2003) converts it CHECKED instead of
    // refusing (coercions/asserted.ts) — a value outside the claimed shape
    // throws the catchable TypeError, never a silent reinterpretation.
    // Recorded before the branches below so every path carries it, the
    // erasure included.
    const claimable = (type: IrType | null | undefined): type is IrType =>
      type?.kind === "union" ||
      type?.kind === "record" ||
      type?.kind === "array" ||
      // A module namespace is an object the assertion can claim members of
      // (`(await import("./m.mjs")) as Dyn`): the conversion boxes the
      // namespace as the live-read dynamic value an untyped flow builds and
      // checks the claimed shape against it.
      type?.kind === "moduleNs";
    if (claimable(target) && claimable(inner.type)) lowerer.assertedValues.set(inner, target);
    // A PRESENCE PROBE of a member read through the assertion (`typeof
    // (u as R).member`, `(u as R).member !== undefined`): the read answers
    // off the value actually stored, since Node erases the assertion and an
    // arm that does not declare the member answers undefined. The read
    // answers that per arm (assertedMemberRead); an eager extraction of R
    // here would trap first and turn the probe into a TypeError. Defer to
    // the read (asserted-receiver.ts); every real use keeps the extraction.
    {
      const access = assertedProbeAccessOf(expr);
      if (access && deferredMemberReadTarget(lowerer, expr, access, inner) !== null) return inner;
    }
    if (target?.kind === "object") {
      const asserted = checkedClassAssertion(lowerer, inner, target, locOf(expr));
      if (asserted) return asserted;
    }
    // A function asserted to a function type with more parameters: Node
    // erases the assertion, and a call through it hands the function every
    // argument. An erased value keeps its narrower type here, so that call
    // would have nowhere to put them and would drop them. Convert it as a
    // slot of the asserted type does; the adapter keeps the function's
    // identity and looks through a narrower view (function-views.ts).
    if (
      target?.kind === "func" &&
      inner.type.kind === "func" &&
      target.rest !== true &&
      inner.type.rest !== true &&
      target.params.length > inner.type.params.length
    ) {
      const widened = lowerer.coerceToExpected(inner, target);
      if (typeEquals(widened.type, target)) return widened;
    }
    // Unknown-only record views use the checked-dynamic representation.
    // A native record asserted to such a view still denotes the original
    // object. Box a live reference instead of erasing the assertion and
    // handing native storage to a checked-dynamic property operation.
    if (target?.kind === "dyn" && (targetTs0.flags & ts.TypeFlags.Object) !== 0) {
      // A class instance asserted to a class-backed protocol view (a type
      // class instances flow into): the same identity-keeping box an
      // implicit flow into the view uses. A runtime-optional binding of a
      // class (`const node = stack.pop()!`) boxes the same way, and its
      // undefined arm stays undefined, as in Node.
      if (classInstanceOrAbsent(lowerer, inner.type) && lowerer.classImplementedProtocol(targetTs0))
        return lowerer.coerceInto(expr, inner, DYN);
      const sourceShape =
        inner.type.kind === "record" ? lowerer.shapes.get(inner.type.shapeId) : undefined;
      if (
        hasClassPayload(lowerer, inner.type) ||
        (sourceShape && shapeHasAccessorSlots(sourceShape))
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "opaque structural views of classes or accessor records (name the property's concrete type to retain native accessor dispatch)",
        );
      }
      const boxed = lowerer.coerceInto(expr, inner, DYN);
      // Only references box live; a scalar or unit source (`value as
      // unknown as View`) is an ordinary snapshot.
      const seen = new Set<string>();
      const live = (type: IrType): boolean => {
        if (
          type.kind === "record" ||
          type.kind === "array" ||
          type.kind === "bytes" ||
          isDynTypedRefType(type)
        )
          return true;
        if (type.kind !== "union" || seen.has(type.unionId)) return false;
        seen.add(type.unionId);
        return lowerer.unions.get(type.unionId)?.arms.some(live) ?? false;
      };
      return boxed.kind === "dynFrom" && live(boxed.value.type)
        ? { ...boxed, liveRef: true }
        : boxed;
    }
    // Collection assertions are interface views only: their backing
    // value must already have the same native key/element/value layout.
    // Erasing a mock or a different instantiation here would let member
    // lowering interpret a record (or another ABI) as a native handle.
    if (target?.kind === "map" || target?.kind === "set") {
      return lowerer.coerceInto(expr, inner, target);
    }
    // A class-derived interface still names the class's native layout.
    // An assertion must not let a structural mock acquire that layout;
    // unions retain their checked extraction below, and real instances
    // keep the ordinary class narrowing path.
    if (target?.kind === "object" && inner.type.kind !== "object" && inner.type.kind !== "union") {
      return lowerer.coerceInto(expr, inner, target);
    }
    if (
      target?.kind === "object" &&
      inner.type.kind === "object" &&
      !typeEquals(target, inner.type) &&
      !lowerer.isSubclassOf(inner.type.className, target.className) &&
      !lowerer.isSubclassOf(target.className, inner.type.className)
    ) {
      return lowerer.coerceInto(expr, inner, target);
    }
    const rebuilt = freshEntriesRecordAssertion(lowerer, expr, inner, target);
    if (rebuilt) return rebuilt;
    // `job as Job & { startedAt: number }` on a record: the asserted
    // record refines the stored one, so the assertion keeps the object
    // (a width copy would sever writes through the asserted view).
    if (inner.type.kind === "record" && target && hostsAll(lowerer, inner.type, target)) {
      return inner;
    }
    // `tagged as Labeled` on a record: the view names members the value
    // already stores, so the assertion is pure typing (Node keeps the
    // object) and the stored layout answers every read and write of them.
    // Only a view with a member the value does not hold copies. A binding
    // whose identity a copy would change (a write through it, an identity
    // comparison) keeps the storage; a read-only view is equal either way
    // and keeps the copy the width-copy report names.
    if (
      assertedBindingUsesIdentity(lowerer, expr) &&
      inner.type.kind === "record" &&
      target?.kind === "record" &&
      recordViewHosted(lowerer, inner.type.shapeId, target.shapeId)
    ) {
      lowerer.layoutKeptNodes.add(expr);
      return inner;
    }
    // `const { icons } = item as Base & { icons?: unknown }`: the
    // assertion only ADDS optional members to the record the value has,
    // and Node erases it, so the pattern reads the properties off the
    // value itself. The added members have no slot in the stored layout:
    // the read answers them through the layout's kept source
    // (assertedOnlyFieldRead), where a width copy would answer its own
    // absent slot with undefined. The kept source is also why the binding
    // is not reported as a copy (layoutKeptNodes): a write to an added
    // member is refused where it happens (assertedOnlyMemberWrite).
    if (
      inner.type.kind === "record" &&
      target &&
      constSourceUse(expr) &&
      assertedOptionalExtension(lowerer, inner.type, target)
    ) {
      lowerer.layoutKeptNodes.add(expr);
      return inner;
    }
    // Static assertions normally erase, but record layouts are
    // monomorphic: a consumer selected from the asserted shape must see
    // that shape physically. Reuse the ordinary slot coercion so plain
    // widths and index-signature captures share their established copy
    // semantics.
    if (
      inner.type.kind === "record" &&
      target?.kind === "record" &&
      inner.type.shapeId !== target.shapeId
    ) {
      // An index-signature record asserted to a record of its own keys (a
      // `Record<string, V>` filled key by key and cast to `{ k: V }`): the
      // value's own keys stay observable — Node erases the assertion, so
      // JSON and Object.keys see every property the object holds, including
      // the ones the target does not declare. A field copy would drop them.
      // The value keeps its storage, and a read of a target field answers
      // through the source's index signature (the keyed read the bracket
      // spelling takes). The claim still follows the assertion's result, so
      // a slot that needs the target layout converts it there.
      const source = lowerer.shapes.get(inner.type.shapeId);
      const dest = lowerer.shapes.get(target.shapeId);
      if (
        source?.indexValue !== undefined &&
        !source.tuple &&
        dest !== undefined &&
        !dest.tuple &&
        dest.indexValue === undefined
      ) {
        lowerer.layoutKeptNodes.add(expr);
        lowerer.assertedValues.set(inner, target);
        return inner;
      }
      // A pair outside the width family converts checked
      // (assertedConversion): every claimed field validated, the value's
      // own keys kept. The claim follows the value the assertion PRODUCED,
      // not the operand it read — a generic body's operand keeps the
      // caller's layout while its asserted result carries the target's — so
      // later slots check the shape the assertion actually made.
      const converted = lowerer.coerceInto(expr, inner, target);
      if (converted !== inner) lowerer.assertedValues.set(converted, target);
      return converted;
    }
    // `u as Arm` on a UNION value is `u!`'s spelling with a named arm
    // (`req.headers[h] as string`): the CHECKED single-arm extraction —
    // the asserted arm's payload comes out, any other arm throws the
    // catchable TypeError (divergence 38's lying-assertion stance; an
    // erasure would just move the failure to the next typed slot as an
    // opaque union-mismatch fence). Sub-union targets and same-type
    // casts keep the historic erasure.
    if (inner.type.kind === "union") {
      if (target && target.kind !== "union" && !typeEquals(target, inner.type)) {
        // At the declaration-typed boundary the failure names the package
        // declaration the asserted type comes from (decl-origin.ts).
        const outerOrigin = lowerer.coercionFieldOrigin;
        if (isDeclBoundaryTypeNode(expr.type)) {
          try {
            lowerer.coercionFieldOrigin = recordedBoundaryOrigin(lowerer, expr) ?? outerOrigin;
          } catch {
            lowerer.coercionFieldOrigin = outerOrigin;
          }
        }
        let helper: string | null;
        try {
          helper = lowerer.narrowedArmHelper(inner.type.unionId, target, locOf(expr));
        } finally {
          lowerer.coercionFieldOrigin = outerOrigin;
        }
        if (helper) {
          return lowerer.checkedNarrowCall(helper, inner, target, locOf(expr));
        }
      }
      // An intersection refining the stored record arms keeps the value
      // (hosted-narrowing.ts): the stored arms that can hold it.
      if (target && (target.kind === "union" || target.kind === "record")) {
        const hosted = hostedStorageView(lowerer, inner, target, locOf(expr));
        if (hosted) return hosted;
      }
      // A projection of ONE arm (`{ text: string }` over a
      // `TextBlock | ThinkingBlock` value): that arm's own storage carries
      // the view, so the checked extraction returns the arm itself and the
      // binding keeps it — reads and writes through it reach the original
      // object. A view no single arm presents keeps the coercion below, and
      // so does a READ-ONLY binding: Node's read answers undefined for an
      // arm that does not declare the member (`(entry as { when?: number })
      // .when` over `Stamped | Unstamped`), which the coercion reproduces
      // and the checked extraction would not (it traps on the other arm).
      // Only a binding whose identity is observable reaches the arm itself.
      if (target?.kind === "record" && assertedBindingUsesIdentity(lowerer, expr)) {
        const tags = viewHostedArmTags(lowerer, inner.type.unionId, target);
        if (tags !== null && tags.size === 1) {
          const arm = lowerer.unions.get(inner.type.unionId)!.arms[[...tags][0]!]!;
          const helper = lowerer.narrowedArmHelper(inner.type.unionId, arm, locOf(expr));
          if (helper) {
            lowerer.layoutKeptNodes.add(expr);
            return lowerer.checkedNarrowCall(helper, inner, arm, locOf(expr));
          }
        }
      }
    }
    // `node.parent as Sub | undefined`: a union target whose class arm is
    // narrower than the stored class gets the same checked class view as
    // `node.parent as Sub`; the other arms keep their identical tags.
    if (
      target?.kind === "union" &&
      (inner.type.kind === "union" || inner.type.kind === "object") &&
      !typeEquals(target, inner.type)
    ) {
      const asserted = checkedClassUnionAssertion(lowerer, inner, target, locOf(expr));
      if (asserted) return asserted;
    }
    // The erased value still answers to the assertion (the claim recorded
    // above): a slot it cannot reach by an ordinary conversion converts it
    // as asserted (assertedConversion).
    return inner; // erasure, unchanged
  }

  // `value as never` is the escape hatch that makes an unknown value fit
  // any slot (`tagSuccess(value as never)`). No value has type never, so
  // checking against its placeholder layout would reject every value.
  // Erase it instead: the consuming slot applies the same validated
  // extraction an unknown value gets wherever the checker admits it.
  if (expr.type.kind === ts.SyntaxKind.NeverKeyword) return inner;
  const targetTs = lowerer.checker.getTypeFromTypeNode(expr.type);
  const mappedTarget = lowerer.mapTypeOf(targetTs);
  // A generic body's `return built as Result<T>` over a dictionary that
  // keeps checked identity: the object nothing else holds converts into the
  // instance's result type (built-record-results.ts), keys and order kept.
  const built =
    mappedTarget === null ? builtRecordResultType(lowerer, expr, inner, targetTs) : null;
  if (
    built !== null &&
    canDynCheckTo(
      built,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return { kind: "dynCheck", value: inner, type: built, loc: locOf(expr) };
  const target = mappedTarget ?? dynFallbackType(lowerer, expr.type, targetTs);
  if (!target) lowerer.badType(expr.type, targetTs);
  if (target.kind === "dyn") return inner; // `as unknown`: erasure
  // `value as undefined`, `value as void`, and `value as T` in a function
  // instantiated with one of them (a standalone unit type maps to the
  // return-position `void`): the cast checks that the value is undefined
  // and answers it in the slot a unit value lives in.
  if (target.kind === "void") return checkedUndefinedCast(lowerer, expr, inner);
  // The declaration-typed boundary (decl-projection.ts): an identity-
  // preserving checked conversion of a value package code produced.
  if (isDeclBoundaryTypeNode(expr.type)) {
    const adopted = declBoundaryCast(lowerer, inner, target, locOf(expr), expr);
    if (adopted) return adopted;
  }
  // An all-`unknown`-fields record target (`err as { code?: unknown }`
  // — the errno-probing idiom): there is nothing to validate (every
  // field is unknown, exactly what the dyn value already answers) and
  // nothing to build — the cast is pure typing, so it ERASES and the
  // reads ride the dyn keyed read.
  if (target.kind === "record") {
    const shape = lowerer.shapes.get(target.shapeId);
    if (
      shape &&
      !shape.tuple &&
      shape.fields.every((f) => f.type.kind === "dyn") &&
      (!shape.indexValue || shape.indexValue.kind === "dyn")
    ) {
      return inner;
    }
  }
  // The global object: the checked extraction would build a separate
  // value, so the assertion keeps the object and its member operations
  // reach it (assertion-identity.ts).
  if (extractionCopiesReference(lowerer, target) && assertsGlobalObject(lowerer, expr))
    return inner;
  // console asserted to a record of its members (`console as unknown as
  // Logger`): the member-by-name copy its plain flow takes
  // (console-records.ts). The checked conversion reads a property bag,
  // which console is not.
  if (
    isConsoleObjectRead(inner) ||
    (inner.type.kind === "dyn" && isConsoleTyped(lowerer, expr.expression))
  ) {
    const projected = consoleInto(lowerer, inner, target, locOf(expr));
    if (projected) return projected;
  }
  // `value as Iterable<T>`: the value's own iterator, stepped lazily with
  // each element checked against T (the generator arm's adapter).
  const iterable = iterableSlotValue(lowerer, inner, target);
  if (iterable) return iterable;
  if (
    !canDynCheckTo(
      target,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    // `value as NodeJS.ReadableStream`: the general stream classes take
    // the checked cast (general-streams.ts).
    requestGeneralStreamSurface(lowerer, expr);
    lowerer.unsupported(
      "SC1090",
      expr,
      `a checked cast of 'unknown' to '${lowerer.fmt(target)}' ` +
        `(${lowerer.dynCheckBlocker(target) ?? "this target"} is outside the checked conversion's domain)`,
    );
  }
  return checkedDynCast(lowerer, expr, inner, target);
}

/** `value as undefined` over a dynamic value: the checked conversion into
 * the unit slot (the `null | undefined` union every unit value lives in,
 * unitOnlyUnion), which throws the conversion's TypeError for any value
 * that is neither. The slot also holds null, which is not undefined: that
 * one throws here, in the conversion's wording. A boundary cast names the
 * package declaration its type comes from, like every other. */
function checkedUndefinedCast(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  inner: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const unit = unitOnlyUnion(lowerer.unions);
  if (unit.kind !== "union")
    throw new InternalCompilerError("lowerer bug: the unit slot is a union");
  const checked =
    (isDeclBoundaryTypeNode(expr.type)
      ? declBoundaryCast(lowerer, inner, unit, loc, expr)
      : null) ?? checkedDynCast(lowerer, expr, inner, unit);
  const nullTag = lowerer.unions.get(unit.unionId)?.arms.findIndex((arm) => arm.kind === "nullT");
  if (nullTag === undefined || nullTag < 0)
    throw new InternalCompilerError("lowerer bug: the unit slot has no null arm");
  const held = lowerer.declareHiddenLocal("%undefinedCast", unit);
  const heldRef = varRef(held.id, unit, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: held.id, init: checked, loc },
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: unit.unionId,
          tag: nullTag,
          negated: false,
          value: heldRef,
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "exprStmt",
            expr: throwTypeError(strLit("expected undefined at $, got null", loc), VOID, loc),
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ],
    result: heldRef,
    type: unit,
    loc,
  };
}

/** The checked conversion of a dynamic value. A record or array built from
 * a value another holder may still reference keeps one identity with it
 * (adoptingCast); only a source nothing else can hold (freshDynSource)
 * converts outright, which keeps the fused `JSON.parse(text) as T`. */
function checkedDynCast(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  inner: IrExpr,
  target: IrType,
): IrExpr {
  if (
    holdsReference(lowerer, target) &&
    !freshDynSource(lowerer, expr, inner) &&
    !resultOnlyRead(lowerer, expr)
  ) {
    // An index-signature type keeps the keys it does not declare in an
    // overflow map, which a record view does not share (plainShape in
    // record-views.ts): the conversion answers a copy, so a
    // write through the assertion would reach that copy alone and be lost
    // to the record the source still names. The value keeps its dynamic
    // form instead, and every key of the assertion rides the source's own
    // keyed reads and writes.
    if (overflowMapRecord(lowerer, target)) return inner;
    return adoptingCast(lowerer, inner, target, locOf(expr), "dyn.adoptShared");
  }
  return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
}

/** The checked conversion of a dynamic value where a typed slot takes it
 * without an assertion: an annotated binding, an argument, a stored field
 * or element, a returned value. JavaScript keeps one object there, so the
 * record or array built from a value another holder may still reference
 * keeps one identity with it, as the assertion form does (adoptingCast):
 * a write through either name reaches the other, and the typed value boxes
 * back to the object it came from. A value nothing else can hold converts
 * outright. The node stays a `dynCheck` (its `shared` flag asks the backend
 * for the adoption), so every consumer that reads or rebuilds a checked
 * conversion sees the node it always saw; one that rebuilds it without the
 * flag keeps the copy. The flag is set only for a target the backend has a
 * live capsule for and whose adoption loses nothing (adoptsAtTypedSlot):
 * the flag links the adoption unit, so it stands on a conversion only where
 * an adoption is emitted. A target that can hold a record without fields
 * (the empty literal's arm of a union) keeps the copy: that record has no
 * place for its source's properties, which the source's other names still
 * read. */
export function sharedDynConversion(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType,
  loc: SrcLoc,
): IrExpr {
  const adopts = adoptsAtTypedSlot(
    target,
    (id) => lowerer.shapes.get(id),
    (id) => lowerer.unions.get(id),
  );
  if (!adopts || unsharedDynValue(value)) return { kind: "dynCheck", value, type: target, loc };
  return { kind: "dynCheck", value, shared: true, type: target, loc };
}

/** A dynamic value no other holder can reference when it converts: parsed
 * text, a literal built in place, or a typed value boxed for the
 * conversion (a capsule of a native value has nothing to adopt). */
function unsharedDynValue(value: IrExpr): boolean {
  if (value.kind === "libCall") return value.fn === "json.parse";
  if (value.kind === "awaitExpr")
    return value.value.kind === "libCall" && value.value.fn === "fetch.responseJson";
  return value.kind === "dynFrom" || value.kind === "dynObjLit" || value.kind === "dynArrLit";
}

/** Whether `target` keeps undeclared keys in an overflow map, the one
 * record storage a checked conversion cannot share with its source. */
function overflowMapRecord(lowerer: Lowerer, target: IrType): boolean {
  if (target.kind !== "record") return false;
  return lowerer.shapes.get(target.shapeId)?.indexValue !== undefined;
}

/** A cast whose result only serves one read of a primitive member
 * (`(value as T).name`, `(value as T[]).length`): the converted value is
 * never stored, compared, written or called through, and the read yields no
 * reference into it, so whether it is the source itself or a copy cannot be
 * observed. */
function resultOnlyRead(lowerer: Lowerer, expr: ts.AsExpression | ts.TypeAssertion): boolean {
  let node: ts.Node = expr;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const access = node.parent;
  if (
    access === undefined ||
    !(
      (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
      access.expression === node
    )
  )
    return false;
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null;
  const read = lowerer.typeOf(access);
  const parts = read.isUnionType() ? ts.constituentTypes(read) : [read];
  if (!parts.every((part) => (part.flags & primitive) !== 0)) return false;
  let use: ts.Node = access;
  while (use.parent !== undefined && ts.isParenthesizedExpression(use.parent)) use = use.parent;
  const parent = use.parent;
  if (parent === undefined) return true;
  if (ts.isCallExpression(parent) && parent.expression === use) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === use &&
    ts.isAssignmentOperator(parent.operatorToken.kind)
  )
    return false;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return false;
  if (ts.isDeleteExpression(parent)) return false;
  return true;
}

/** A cast operand nothing else can hold: a value this expression creates
 * (`JSON.parse(text)`, `await response.json()`), or a structured clone the
 * runtime delivers once and the program reads at this site only (`workerData`
 * read nowhere else; the parameter of the program's one `"message"`
 * listener, read nowhere else in it). Anything else is adopted. */
function freshDynSource(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  inner: IrExpr,
): boolean {
  if (inner.kind === "libCall" && inner.fn === "json.parse") return true;
  if (
    inner.kind === "awaitExpr" &&
    inner.value.kind === "libCall" &&
    inner.value.fn === "fetch.responseJson"
  )
    return true;
  const facts = lowerer.structuredCloneReads();
  if (inner.kind === "libCall" && inner.fn === "worker.data") return facts.workerData === 1;
  let operand: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (!ts.isIdentifier(operand) || inner.kind !== "varRef" || facts.messageListeners !== 1)
    return false;
  const symbol = lowerer.checker.getSymbolAtLocation(operand);
  const param = symbol?.valueDeclaration;
  if (!param || !ts.isParameter(param) || !ts.isIdentifier(param.name)) return false;
  const fn = param.parent;
  if (
    !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
    fn.parameters.nodes[0] !== param ||
    !isMessageListener(fn)
  )
    return false;
  let reads = 0;
  const name = param.name.text;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== param.name) reads++;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return reads === 1;
}

/** The listener argument of `<x>.on("message", fn)` (also once,
 * addListener, prependListener, prependOnceListener) registered once: at
 * module level, outside any function, class or loop, so one emitter can
 * never hand the same message to two registrations of it. */
function isMessageListener(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments.nodes[1] !== fn) return false;
  if (!isMessageListenerCall(call)) return false;
  for (let p = call.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (
      ts.isFunctionLike(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isClassStaticBlockDeclaration(p) ||
      ts.isForStatement(p) ||
      ts.isForInStatement(p) ||
      ts.isForOfStatement(p) ||
      ts.isWhileStatement(p) ||
      ts.isDoStatement(p)
    )
      return false;
  }
  return true;
}

/** True when a type holds a record or an array somewhere (values whose
 * identity can be observed). */
function holdsReference(lowerer: Lowerer, t: IrType, seen = new Set<string>()): boolean {
  if (t.kind === "record" || t.kind === "array") return true;
  if (t.kind !== "union" || seen.has(t.unionId)) return false;
  seen.add(t.unionId);
  return (
    lowerer.unions.get(t.unionId)?.arms.some((arm) => holdsReference(lowerer, arm, seen)) ?? false
  );
}

/** `(<package expr> as __scriptc_decl_N)`: check the dynamic value against
 * the projected type and build the native value (dynCheck), then adopt:
 * every source object or array that something else still references
 * becomes a live capsule of the value built from it
 * (scr_dyn_decl_adopt), so identity and mutation visibility hold on both
 * sides. Scalar targets are ordinary checked casts. */
/** The origin the projection recorded for a boundary cast (the package
 * declaration its type comes from, decl-projection.ts), found by the
 * cast's position among the file's boundary casts in source order. */
function recordedBoundaryOrigin(lowerer: Lowerer, cast: ts.Node): string | null {
  const sf = ts.getSourceFileOfNode(cast);
  let order = lowerer.boundaryCastOrder.get(sf);
  if (order === undefined) {
    const found = new Map<ts.Node, number>();
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) && isDeclBoundaryTypeNode(node.type)) found.set(node, found.size);
      ts.forEachChild(
        node,
        (child) => {
          visit(child);
          return undefined;
        },
        (list) => {
          for (const child of list.nodes) visit(child);
          return undefined;
        },
      );
    };
    visit(sf);
    order = found;
    lowerer.boundaryCastOrder.set(sf, order);
  }
  const index = order.get(cast);
  return index === undefined ? null : declBoundaryOrigin(sf.fileName, index);
}

function declBoundaryCast(
  lowerer: Lowerer,
  inner: IrExpr,
  target: IrType,
  loc: SrcLoc,
  cast: ts.Node,
): IrExpr | null {
  if (
    !canDynCheckTo(
      target,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    ) &&
    !(target.kind === "union" && lowerer.dynConvertible(target))
  )
    return null;
  // The package call or read the value comes from (decl-origin.ts): a
  // failing check names it and the patch admitting the value.
  let originText: string | null = null;
  try {
    originText = recordedBoundaryOrigin(lowerer, cast);
  } catch {
    originText = null;
  }
  const originId = originText === null ? undefined : lowerer.declOriginIndex(originText);
  if (!holdsReference(lowerer, target)) {
    return {
      kind: "dynCheck",
      value: inner,
      type: target,
      loc,
      ...(originId === undefined ? {} : { origin: originId }),
    };
  }
  return adoptingCast(lowerer, inner, target, loc, "dyn.declAdopt", originId);
}

/** The checked conversion of `inner` to `target` followed by adoption
 * (`dyn.declAdopt` at the boundary, the lenient `dyn.adoptShared`
 * elsewhere): every source object or array that something else still
 * references becomes a live capsule of the native value built from it.
 * `originId` names the package declaration a failing check reports
 * (decl-origin.ts). */
function adoptingCast(
  lowerer: Lowerer,
  inner: IrExpr,
  target: IrType,
  loc: SrcLoc,
  fn: "dyn.declAdopt" | "dyn.adoptShared",
  originId?: number,
): IrExpr {
  const boundary = fn === "dyn.declAdopt";
  const source = lowerer.declareHiddenLocal("%boundarySource", DYN);
  const value = lowerer.declareHiddenLocal("%boundaryValue", target);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: source.id, init: inner, loc },
      {
        kind: "varDecl",
        localId: value.id,
        init: {
          kind: "dynCheck",
          value: varRef(source.id, DYN, loc),
          ...(boundary ? { adopt: true as const } : {}),
          type: target,
          loc,
          ...(originId === undefined ? {} : { origin: originId }),
        },
        loc,
      },
      // Only a plain object or array has nodes to adopt. A source that is
      // already a native value's capsule (the record this cast just handed
      // out, most often) is left alone without boxing the result again.
      {
        kind: "if",
        cond: {
          kind: "libCall",
          fn: "dyn.adoptable",
          args: [varRef(source.id, DYN, loc)],
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn,
              args: [
                varRef(source.id, DYN, loc),
                {
                  kind: "dynFrom",
                  value: varRef(value.id, target, loc),
                  liveRef: true,
                  type: DYN,
                  loc,
                },
              ],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ],
    result: varRef(value.id, target, loc),
    type: target,
    loc,
  };
}

/** Whether this assertion only FEEDS a `const` binding: it is a binding
 * pattern's source (`const { a } = value as T`) or such a declaration's
 * initializer, through parentheses. Node erases the assertion, so both
 * read the members off the value itself; a `let` binding keeps its
 * declared type (later assignments coerce into it). */
function constSourceUse(assertion: ts.Expression): boolean {
  let use: ts.Node = assertion;
  for (;;) {
    const parent = use.parent as ts.Node | undefined;
    if (!parent || !ts.isParenthesizedExpression(parent) || parent.expression !== use) break;
    use = parent;
  }
  const parent = use.parent as ts.Node | undefined;
  if (parent === undefined || !ts.isVariableDeclaration(parent) || parent.initializer !== use) {
    return false;
  }
  const list = parent.parent;
  return (
    list !== undefined &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

/** lowerTernary's array-beside-literal rule: the array type both arms
 * build as when the ternary sits under a tuple context (a destructuring
 * pattern), one arm maps to an array, and the other is a filled array
 * literal without spreads. The element is the join of the array arm's
 * element and the literal's positions; null unless every one of them is a
 * number, string, boolean, undefined or null (joins of other kinds keep
 * the lowerings they have). */
function arrayBesideLiteralUnderTuple(
  lowerer: Lowerer,
  expr: ts.ConditionalExpression,
  context: IrType | null,
  armLiteral: (e: ts.Expression) => ts.ArrayLiteralExpression | null,
): (IrType & { kind: "array" }) | null {
  if (context?.kind !== "record" || lowerer.shapes.get(context.shapeId)?.tuple !== true)
    return null;
  const thenLit = armLiteral(expr.whenTrue);
  const elseLit = armLiteral(expr.whenFalse);
  if ((thenLit === null) === (elseLit === null)) return null;
  const literal = (thenLit ?? elseLit)!;
  if (literal.elements.nodes.length === 0 || literal.elements.nodes.some(ts.isSpreadElement))
    return null;
  const other = lowerer.mapTypeOf(lowerer.typeOf(thenLit ? expr.whenFalse : expr.whenTrue));
  if (other?.kind !== "array") return null;
  const arms = new Map<string, IrType>();
  const add = (t: IrType | null): boolean => {
    if (t === null) return false;
    if (t.kind === "union") {
      return (lowerer.unions.get(t.unionId)?.arms ?? []).every(add);
    }
    const part: IrType = t.kind === "void" ? UNDEFINED_T : t;
    if (part.kind !== "f64" && part.kind !== "string" && part.kind !== "bool" && !isUnitType(part))
      return false;
    arms.set(typeKey(part), part);
    return true;
  };
  if (!add(other.elem)) return null;
  for (const element of literal.elements.nodes) {
    if (!add(lowerer.mapTypeOf(lowerer.typeOf(element)))) return null;
  }
  const parts = [...arms.values()];
  if (parts.every(isUnitType)) return null;
  if (parts.length > 1) sortArms(parts);
  return {
    kind: "array",
    elem: parts.length === 1 ? parts[0]! : { kind: "union", unionId: lowerer.unions.intern(parts) },
  };
}
