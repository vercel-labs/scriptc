import { keyedHelperName } from "./stable-names.js";
import {
  isNewTarget,
  lowerNewTarget,
  lowerNewTargetComparison,
  lowerNewTargetName,
} from "./new-target.js";
import { lowerWebAssemblyValue, refuseWebAssemblyUse } from "./builtins/webassembly.js";
import { lowerAwaitedUniformPromiseAll } from "./builtins/promises.js";
import { dynUndefinedExpr, nodeThrowExpr, numLit, strLit, varRef } from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";
/* Expression lowering: the expression dispatch (lowerExpr), literals
 * (array/object/regex/template), operators (binary incl. compound targets,
 * unary, instanceof, caught-typeof tests), union narrowing and unit
 * comparisons, nullish coalescing and optional chains, conditions and
 * ToBoolean/ToString coercion helpers, and field/element reads and writes
 * (FieldTarget). */
import * as ts from "../ts7/adapter.js";
import { checkedPrivateReceiver, localPrivateBrandClass } from "./private-brands.js";
import { staticCondition } from "./static-typeof.js";
import { constituentTypes } from "../ts7/checker.js";
import type { Lowerer } from "./lowerer.js";
import { lowerMaybePromiseAwait, maybePromiseUnionOf } from "./maybe-promise.js";
import { checkedClassUnionAssertion } from "./class-assertions.js";
import {
  BIGINT_T,
  BOOL,
  CAUGHT,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  NULL_T,
  REF_TRUTHY_KINDS,
  REGEX,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  funcOf,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import {
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  cjsExportTargetLiteral,
  isJsSourceFile,
  locOf,
} from "../program.js";
import { npmStaticLexerVisibleNames } from "../npm-static.js";
import {
  type CompoundOp,
  NARROW_FIRST,
  UNSUPPORTED_EXPR,
  sideEffectFreeOptionValue,
  stdlibGlobalNameOf,
} from "./surfaces.js";
import { UNSUPPORTED } from "../../diagnostics/diagnostic.js";
import { lowerHelperReturnCall } from "./containers/iterator-helpers.js";
import {
  lowerSafeIndexRead,
  tryLowerIndexTruthiness,
  tryLowerNumericIndexRead,
} from "./array-values.js";
import { nsMemberIdentOf } from "./lower-namespaces.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { implicitMonoFile } from "./generic-functions.js";
import { lowerTaggedTemplate } from "./lower-calls.js";
import { unitOnlyUnion } from "../type-mapper.js";
import { lowerYield } from "./lower-generators.js";
import { unionWideningTags } from "../../ir/analysis.js";
import { isSafeToDiscard, isSafeToRepeat } from "./expressions/evaluation-safety.js";
import { hasOptionalChainGuard, isOptionalChainTail } from "./expressions/optional-chains.js";
import { classToStringConversion, classUnionToString } from "./class-to-primitive.js";
import { lowerCjsTopLevelThis, lowerRequireCacheElement } from "./lower-node-module.js";
import {
  coerceStringSearchValue,
  defaultAfterUndefined,
  lowerStaticallyUndefinedArgument,
} from "./optional-arguments.js";
import { classSymbolKeyOf } from "./symbol-fields.js";
import { lowerTypeofExpr } from "./expressions/typeof.js";
import { lowerIdentifierExpr } from "./expressions/identifiers.js";
import { lowerFieldCompoundValue, lowerIncDec } from "./expressions/updates.js";
import { lowerTernary } from "./expressions/narrowing.js";
import {
  classFieldTarget,
  lowerPropertyAccessExpr,
  lowerUnionKeyedRead,
} from "./expressions/property-access.js";
import { lowerNullishPair } from "./expressions/binary.js";
import { lowerElementCompoundParts } from "./expressions/element-access.js";
export {
  DEFERRED_READ_MESSAGE,
  abstractPropertyDeclOf,
  builtinFunctionValue,
  builtinGlobalValue,
  fieldGetExpr,
  fieldTarget,
  isMatchSliceType,
  lowerFieldRead,
  lowerGroupsProjection,
  lowerIntrinsicProperty,
  lowerUnionProperty,
  matchResultNamedGroupsOf,
  primitiveConstructorOr,
} from "./expressions/property-access.js";
export {
  lowerAsExpression,
  lowerTernary,
  maybeNarrow,
  runtimeOptionalGuardIds,
  runtimeOptionalTrueIds,
  v8CalleeText,
  withRuntimeOptionalNarrowed,
} from "./expressions/narrowing.js";
export {
  ensureString,
  lowerBinary,
  lowerCompoundValueToTarget,
  lowerElementCompound,
  lowerNativeFunctionAssignment,
  lowerStrictEquality,
  lowerUnitComparison,
} from "./expressions/binary.js";
export { jsHoldsDynObject, lowerArrayLiteral } from "./expressions/array-literals.js";
export {
  lowerElementAccess,
  lowerElementWrite,
  lowerEnvironmentKey,
  lowerRecordKeyRead,
} from "./expressions/element-access.js";
export {
  fieldSetStmt,
  lowerIncDec,
  lowerIncDecTarget,
  lowerPrefixUnary,
} from "./expressions/updates.js";
import { awaitDynThenable, programMayDefineThenables } from "./thenables.js";
import { awaitsChildThenable } from "./handle-properties.js";
export { lowerInstanceOf } from "./expressions/relational.js";

/** An assignable `obj.field` target — a class field, a record field, or a
 * class ACCESSOR property (reads become getter calls, writes setter calls;
 * fieldType is the property's one type). */
export type FieldTarget =
  | { container: "dynamic"; obj: IrExpr; field: string; fieldType: IrType }
  | { container: "errorStackLimit"; obj: IrExpr; field: "stackTraceLimit"; fieldType: IrType }
  | { container: "errorCause"; obj: IrExpr; field: "cause"; fieldType: IrType }
  | { container: "class"; obj: IrExpr; className: string; field: string; fieldType: IrType }
  | { container: "record"; obj: IrExpr; shapeId: string; field: string; fieldType: IrType }
  // An UNDECLARED key of an index-signature shape in dot spelling
  // (`r.openai` on `Record<string, T>`): the same overflow read/write path
  // as the bracket form — fieldType is the index signature's VALUE type
  // (the write-slot type; reads arm it with undefined under
  // noUncheckedIndexedAccess in fieldGetExpr).
  | { container: "recordOvf"; obj: IrExpr; shapeId: string; field: string; fieldType: IrType }
  // A computed key of a record in a read-modify-write (`r[k] += v`,
  // `r[k]++`, `r[k] ??= v`; keyed-field-targets.ts): `keys` lists the
  // declared fields a literal-union key can name, which share fieldType;
  // null keys mean a string key into a pure index-signature record, whose
  // entries fieldType types. `key` is null when the one literal is static.
  | {
      container: "recordKeyed";
      obj: IrExpr;
      shapeId: string;
      field: string;
      keys: readonly string[] | null;
      key: IrExpr | null;
      fieldType: IrType;
      missNaN?: true;
    }
  | { container: "accessor"; obj: IrExpr; className: string; field: string; fieldType: IrType }
  // A RECORD accessor property (an object-literal `get x()`/`set x(v)` —
  // the shape carries %get:/%set: closure slots): reads call the getter
  // closure, writes the setter; fieldType is the property's one value type
  // (getter return = setter param — divergent pairs never map). The slot
  // types ride along so the dispatch needs no shape re-lookup.
  | {
      container: "recordAccessor";
      obj: IrExpr;
      shapeId: string;
      field: string;
      fieldType: IrType;
      getType?: IrType & { kind: "func" };
      setType?: IrType & { kind: "func" };
    };

/** A template piece's RAW text (String.raw's contract: escapes stay
 * characters). 7's client AST ships no rawText at runtime (the typing
 * declares it; the serialized node data omits it), so the raw span comes
 * off the SOURCE: between the piece's delimiters — backticks for the
 * no-substitution form, `\`...${` / `}...${` / `}...\`` for head/middle/
 * tail. 5.9.3's rawText, when a build ever supplies it, wins unchanged. */
export function templateRawTextOf(
  node: ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail,
): string {
  const own = (node as { rawText?: string }).rawText;
  if (own !== undefined) return own;
  const sf = ts.getSourceFileOfNode(node);
  const start = ts.tokenStartOfNode(node);
  const end = node.end;
  const tailTrim =
    node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1;
  return sf.text.slice(start + 1, end - tailTrim);
}

/** Expression lowering recurses once per operand nesting level (plus the
 * recursive locOf/API walks riding each level), so a pathologically deep
 * expression — a ~3000-term left-nested binary chain (the
 * binderBinaryExpressionStress corpus pair) — overflows the JS stack as an
 * ICE. Real programs sit orders of magnitude below this floor; past it, the
 * honest answer is a named fence, not a crash. The threshold leaves ample
 * stack headroom for the fence itself: rendering the diagnostic walks the
 * node's PARENT chain (the remote layer's recursive getSourceFile), which
 * costs roughly one frame per nesting level on top of the lowering's own. */
const LOWER_EXPR_MAX_DEPTH = 200;
let lowerExprDepth = 0;

export function lowerExpr(lowerer: Lowerer, expr: ts.Expression): IrExpr {
  if (lowerExprDepth >= LOWER_EXPR_MAX_DEPTH) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `expressions nested deeper than ${LOWER_EXPR_MAX_DEPTH} levels`,
    );
  }
  lowerExprDepth++;
  try {
    let lowered = lowerExprInner(lowerer, expr);
    const nanCoded = lowerer.nanCodedReads;
    if (nanCoded) {
      if (lowered.type.kind === "f64" && nanCoded.reboxes(expr))
        lowered = reboxNanCoded(lowerer, lowered, locOf(expr));
      else if (lowered.type.kind === "union" && nanCoded.convertsSource(expr))
        lowered = lowerOptionalNumber(lowerer, lowered, locOf(expr));
    }
    if (lowered.type.kind === "void" && (lowerer.typeOf(expr).flags & ts.TypeFlags.Never) !== 0)
      lowerer.neverValued.add(lowered);
    return lowered;
  } finally {
    lowerExprDepth--;
  }
}

/** `number | undefined` from a NaN-coded double whose slot never holds a
 * genuine NaN (nan-coded-reads.ts): NaN is exactly undefined. */
function reboxNanCoded(lowerer: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr {
  const optional = lowerer.withUndefinedArm(F64);
  const stmts: IrStmt[] = [];
  let stable = value;
  if (value.kind !== "varRef") {
    const tmp = lowerer.declareHiddenLocal("%nanCoded", F64);
    stmts.push({ kind: "varDecl", localId: tmp.id, init: value, loc });
    stable = varRef(tmp.id, F64, loc);
  }
  const result: IrExpr = {
    kind: "ternary",
    cond: { kind: "libCall", fn: "num.isNaN", args: [stable], type: BOOL, loc },
    then: lowerer.wrappedUndefined(optional, loc)!,
    else_: lowerer.coerceToExpected(stable, optional),
    type: optional,
    loc,
  };
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: optional, loc };
}

function lowerExprInner(lowerer: Lowerer, expr: ts.Expression): IrExpr {
  const loc = locOf(expr);

  // An optional chain's guarded receiver: already evaluated by the
  // enclosing optChain — read the bind temp instead of re-lowering.
  const chainRecv = lowerer.chainRecvByNode.get(expr);
  if (chainRecv) return { ...chainRecv, loc };

  // --external-types supplies CHECKER truth only. A value rooted in one
  // of those declarations has no runtime implementation in scriptc, so
  // every use fences at its expression instead of accidentally lowering
  // as an ambient ReferenceError or a structural value. This keeps the
  // rest of coverage measurable without overstating the host boundary.
  const externalTypeSpecifier = lowerer.externalTypeSpecifierOf(expr);
  if (externalTypeSpecifier !== null) {
    lowerer.externalHostFence(externalTypeSpecifier, expr);
  }
  // WebAssembly API values lower; every other reached use of the API
  // fences at its expression.
  const webAssemblyValue = lowerWebAssemblyValue(lowerer, expr);
  if (webAssemblyValue !== null) return webAssemblyValue;
  refuseWebAssemblyUse(lowerer, expr);

  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replace(/_/g, ""));
    // Ask 4's representability input: a DECIMAL INTEGER source spelling
    // that does not survive the trip through f64 (parse, format back,
    // compare) rides the literal so the library integer-boundary check
    // can refuse on the author's source text. `expr.text` is the
    // scanner's COOKED value (already the nearest double), so the
    // source spelling comes from the file text; numeric separators are
    // spelling sugar and strip first. Round-tripping literals (every
    // integer within ±(2^53−1)) and non-integer spellings carry
    // nothing, so the IR is unchanged for programs that held their
    // numbers.
    const spelled = ts.getTextOfNode(expr).replace(/_/g, "");
    if (/^\d+$/.test(spelled) && String(Number(spelled)) !== spelled) {
      return { kind: "numLit", value: Number(spelled), spelling: spelled, type: F64, loc };
    }
    return { kind: "numLit", value, type: F64, loc };
  }
  if (ts.isBigIntLiteral(expr)) {
    const spelling = ts.getTextOfNode(expr).replace(/_/g, "").replace(/n$/i, "");
    return {
      kind: "libCall",
      fn: "bigint.parse",
      args: [{ kind: "strLit", value: spelling, type: STRING, loc }],
      type: BIGINT_T,
      loc,
    };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolLit", value: true, type: BOOL, loc };
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolLit", value: false, type: BOOL, loc };
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    // A unit literal: representable only where a union slot's coercion
    // immediately wraps it (coerceToExpected), or against a union in
    // ===/!== (lowerUnitComparison). Anything else fails on its type.
    return { kind: "unitLit", unit: "null", type: NULL_T, loc };
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: "strLit", value: expr.text, type: STRING, loc };
  }
  if (ts.isRegularExpressionLiteral(expr)) return lowerer.lowerRegexLiteral(expr);
  if (ts.isTemplateExpression(expr)) return lowerer.lowerTemplate(expr);
  if (ts.isTaggedTemplateExpression(expr)) {
    // `String.raw` — the ONE lowered tag: the template's RAW text,
    // escapes staying characters (String.raw`C:\System` keeps the
    // backslash; the wslpath idiom). Substitutions splice exactly like
    // an untagged template, just over the raw spans. Every other tag
    // is the general lowering — an interned per-site strings object
    // plus an ordinary call (lowerTaggedTemplate).
    if (
      ts.isPropertyAccessExpression(expr.tag) &&
      lowerer.stdlibGlobalMember(expr.tag, "String") === "raw"
    ) {
      if (ts.isNoSubstitutionTemplateLiteral(expr.template)) {
        return { kind: "strLit", value: templateRawTextOf(expr.template), type: STRING, loc };
      }
      const t = expr.template;
      const pieces: IrExpr[] = [];
      const headRaw = templateRawTextOf(t.head);
      if (headRaw !== "") pieces.push({ kind: "strLit", value: headRaw, type: STRING, loc });
      for (const span of t.templateSpans.nodes) {
        pieces.push(
          lowerer.caughtToString(span.expression) ??
            lowerer.ensureString(lowerer.lowerExpr(span.expression), span.expression),
        );
        const raw = templateRawTextOf(span.literal);
        if (raw !== "") {
          pieces.push({ kind: "strLit", value: raw, type: STRING, loc: locOf(span.literal) });
        }
      }
      if (pieces.length === 0) return { kind: "strLit", value: "", type: STRING, loc };
      return pieces.reduce((acc, p) => ({
        kind: "strConcat",
        left: acc,
        right: p,
        type: STRING,
        loc,
      }));
    }
    return lowerTaggedTemplate(lowerer, expr);
  }
  if (ts.isParenthesizedExpression(expr)) return lowerer.lowerExpr(expr.expression);
  // Type-level wrappers: `satisfies` and `!` erase completely; the runtime
  // value is the inner expression's. `as` erases too UNLESS the inner
  // value is dyn ('unknown') — then the cast is THE dynamic boundary and
  // compiles to a runtime validation (see lowerAsExpression). The one
  // static exception is a record assertion that changes monomorphic
  // shape: it uses the established copy/reshape path so subsequent
  // record reads name the representation the assertion selected.
  // `x!` erases the TYPE but must NARROW the VALUE: tsc types the
  // assertion as the non-nullish type, so a union-typed inner bridges to
  // the asserted arm (`groups.get(k)!.push(v)` — the Map get-or-init
  // idiom). Unlike checker-PROVEN narrowing, `!` is an unchecked
  // assertion, so the extraction is CHECKED: a lying `!` (the value
  // still held undefined/null, or another arm) throws the catchable
  // TypeError — divergence 38's stance, matching the widening-site
  // traps. Sub-union assertions and non-union inners keep their
  // historic erasure (the widening sites re-tag with traps already).
  if (ts.isNonNullExpression(expr)) {
    // An asserted element read forwarded into a slot that holds undefined
    // (see analyzeRuntimeOptionalArrayReads) reads without the bounds trap.
    if (
      lowerer.runtimeOptionalAssertions.has(expr) &&
      ts.isElementAccessExpression(expr.expression)
    ) {
      const probe = lowerAbsenceProbe(lowerer, expr.expression);
      if (probe?.type.kind === "union") return probe;
    }
    // An asserted array element whose value must be the element type reads
    // the element behind a presence test (see checkedElementMember).
    if (ts.isElementAccessExpression(expr.expression)) {
      const member = checkedElementMember(lowerer, expr);
      if (member !== undefined) lowerer.checkedElementReads.set(expr.expression, member);
    }
    const inner = lowerer.lowerExpr(expr.expression);
    if (inner.type.kind === "union") {
      // `!` performs no runtime check: a missing array or typed-array
      // element stays undefined, as for the read without the assertion. A
      // library build keeps it only where its destination can hold it.
      if (
        ts.isElementAccessExpression(expr.expression) &&
        (assertsElementWithoutCheck(lowerer, expr.expression) ||
          assertedElementKeepsUndefined(lowerer, expr))
      )
        return inner;
      // A forwarded assertion whose destination was promoted to hold
      // undefined (see analyzeRuntimeOptionalArrayReads), or an equality
      // operand, keeps the value: `!` performs no runtime check.
      const target = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (
        lowerer.runtimeOptionalAssertions.has(expr) ||
        (target?.kind === "object" && isEqualityOperand(expr))
      )
        return inner;
      const use = runtimeOptionalUseOf(expr);
      if (runtimeOptionalAssertionErases(lowerer, expr, inner, use)) return inner;
      if (target && target.kind !== "union" && !typeEquals(target, inner.type)) {
        const helper = lowerer.narrowedArmHelper(inner.type.unionId, target, loc);
        if (helper) {
          return lowerer.checkedNarrowCall(helper, inner, target, loc);
        }
      }
      return inner;
    }
    return lowerer.maybeNarrow(inner, expr);
  }
  if (ts.isSatisfiesExpression(expr)) {
    return lowerer.lowerExpr(expr.expression);
  }
  if (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) return lowerer.lowerAsExpression(expr);
  if (ts.isVoidExpression(expr)) {
    // `void e` in VALUE position is the undefined value after evaluating
    // e. A side-effect-free operand drops entirely (`void 0` — the
    // classic undefined spelling; the surrounding slot's coercion wraps
    // the unit like any bare `undefined`). Effectful operands compile
    // where the value is DISCARDED — statement position
    // (lowerExprStatement) and void-returning arrow bodies — but here
    // the value is consumed and the effect would need to sequence before
    // it, which no expression shape carries: fence by name.
    if (sideEffectFreeOptionValue(expr.expression)) {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "'void' with an effectful operand in value position (hoist the operand to its own statement — statement-position 'void e' and void-returning arrow bodies compile)",
    );
  }
  if (ts.isTypeOfExpression(expr)) return lowerTypeofExpr(lowerer, expr, loc);
  if (ts.isIdentifier(expr)) return lowerIdentifierExpr(lowerer, expr, loc);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return lowerer.lowerLambda(expr);
  }
  // `class {…}` in expression position: a class definition plus a
  // classRef over it (top-level evaluation positions only — each
  // evaluation mints a distinct class in JS, and the immortal class
  // object is exact exactly when the expression evaluates once).
  if (ts.isClassExpression(expr)) {
    return lowerer.lowerClassExpression(expr);
  }
  // `identity<number>` / `Box<number>` — an INSTANTIATION EXPRESSION (a
  // generic function or class reference with explicit type arguments, in
  // value position): the expression's own checker type is the
  // substituted signature, so it pins the instance like a
  // contextually-typed reference. For a generic CLASS the value is the
  // instantiation's class object (classRef — construction, statics,
  // identity and instanceof through it ride the classval machinery).
  if (ts.isExpressionWithTypeArguments(expr) && ts.isIdentifier(expr.expression)) {
    const gfn = lowerer.genericFnOf(expr.expression);
    if (gfn) return lowerer.lowerGenericFnValue(expr, gfn);
    const clsSym = lowerer.resolveValueSymbol(expr.expression);
    const cls = clsSym ? lowerer.classBySymbol.get(clsSym) : undefined;
    if (cls?.generic) {
      const t = lowerer.typeOf(expr);
      const mapped = lowerer.mapTypeOf(t);
      const instInfo =
        mapped?.kind === "classval" ? lowerer.classes.get(mapped.className) : undefined;
      if (!instInfo) lowerer.badType(expr, t);
      return lowerer.classValueRef(instInfo, expr);
    }
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    // Only arrows can see an enclosing method's `this` (JS lexical-this);
    // `this` in plain nested functions is already a tsc error under
    // noImplicitThis, so the generic scope walk here is preflight-safe.
    const local = lowerer.resolveThis(expr);
    if (local) {
      const value: IrExpr = { kind: "varRef", localId: local.id, type: local.type, loc };
      // `this.#x` in a function-local class's prototype method, whose `this`
      // is the call-site value: the field lives on the native instance of
      // this evaluation (checkedPrivateReceiver).
      const access = expr.parent;
      if (
        local.type.kind === "dyn" &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === expr &&
        ts.isPrivateIdentifier(access.name)
      ) {
        const owner = localPrivateBrandClass(lowerer, access.name);
        if (owner)
          return checkedPrivateReceiver(lowerer, owner.info, owner.decl, access, value, loc);
      }
      const initialized = lowerer.ctx.superInitialized;
      if (initialized)
        return {
          kind: "seqExpr",
          stmts: [
            {
              kind: "if",
              cond: {
                kind: "unary",
                op: "!",
                operand: { kind: "varRef", localId: initialized.id, type: BOOL, loc },
                type: BOOL,
                loc,
              },
              then: [
                {
                  kind: "exprStmt",
                  expr: nodeThrowExpr(
                    5,
                    "",
                    "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
                    DYN,
                    loc,
                  ),
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ],
          result: value,
          type: value.type,
          loc,
        };
      return value;
    }
    // `this` in a plain JS FUNCTION (not a method): the AMBIENT
    // RECEIVER (libCall dyn.this — scr_dyn_this_get). Firing sites bind
    // the emitting handle around each listener call (Node calls
    // listeners with `this` === the server/socket/req/res:
    // `server.listen(0, function() { this.address().port })`), dyn OBJ
    // method dispatch binds the object, and apply/call bind their
    // thisArg — so the wrapper idiom `fn.apply(this, arguments)`
    // (test/common's mustCall) forwards the receiver. With no binding
    // the read answers the strict-mode plain-call undefined, the old
    // constant. TypeScript keeps the fence (noImplicitThis makes it a
    // compile-time story there).
    if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
      // Module scope of a CommonJS file: `this` is module.exports.
      const exportsThis = lowerCjsTopLevelThis(lowerer, expr);
      if (exportsThis) return exportsThis;
      return { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc };
    }
    lowerer.unsupported("SC1080", expr);
  }
  if (expr.kind === ts.SyntaxKind.SuperKeyword) {
    // super(...) and super.method(...) are handled at their call sites;
    // any other super position (field reads, bare references) stays out.
    lowerer.unsupported("SC1090", expr, "'super' outside super() and super.method() calls");
  }
  if (ts.isNewExpression(expr)) return lowerer.lowerNew(expr);
  if (ts.isAwaitExpression(expr)) {
    if (!lowerer.ctx.isAsync) {
      // A tsc-clean occurrence here is outside both an async function
      // and an async module initializer. CommonJS/script files are
      // normally rejected by tsc before lowering; keep the defensive
      // boundary for malformed/upstream ASTs.
      lowerer.unsupported("SC1090", expr, "top-level await (await outside async functions)");
    }
    const uniformAll = lowerAwaitedUniformPromiseAll(lowerer, expr);
    if (uniformAll) return uniformAll;
    const value = lowerer.lowerExpr(expr.expression);
    // A promise-or-absent union (`Promise<T> | undefined` values, calls
    // of `(...) => Promise<void> | void` callbacks): the await handles
    // both arms — the promise arm parks like any await, a unit arm takes
    // exactly one microtask hop (JS: await of a non-thenable) and yields
    // itself. The result is void when the inner is void and the only
    // unit is undefined; otherwise the union of the inner type and the
    // unit arms — what the checker types the await as.
    if (value.type.kind === "union") {
      const def = lowerer.unions.get(value.type.unionId);
      const promiseTag = def ? def.arms.findIndex((a) => a.kind === "promise") : -1;
      if (def && promiseTag >= 0 && def.arms.every((a, i) => i === promiseTag || isUnitType(a))) {
        const promiseArm = def.arms[promiseTag]!;
        const inner = promiseArm.kind === "promise" ? promiseArm.inner : VOID;
        const units = def.arms.filter(isUnitType);
        // A checked-dynamic inner: the whole operand is a dyn value (the
        // promise boxes by reference, the unit as itself), and the dyn
        // await adopts the promise or hops once for the unit.
        if (inner.kind === "dyn" && lowerer.dynConvertible(value.type)) {
          return {
            kind: "libCall",
            fn: "async.awaitDyn",
            args: [lowerer.coerceToExpected(value, DYN)],
            type: DYN,
            loc,
          };
        }
        if (inner.kind === "union" || inner.kind === "dyn") {
          // A union inner would need an arm-wise re-tag into the result

          lowerer.unsupported(
            "SC1090",
            expr,
            `awaiting '${lowerer.fmt(value.type)}' (the promise's inner type has no combined result union — await the promise arm after narrowing instead)`,
          );
        }
        let type: IrType;
        if (inner.kind === "void" && units.every((u) => u.kind === "undefinedT")) {
          type = VOID;
        } else if (inner.kind === "void") {
          // `Promise<void> | null`: the result would mix undefined and
          // null units with no non-unit arm — degenerate; keep it out.
          lowerer.unsupported(
            "SC1090",
            expr,
            `awaiting '${lowerer.fmt(value.type)}' (narrow the null away first)`,
          );
        } else {
          const arms = [inner, ...units];
          arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
          type = { kind: "union", unionId: lowerer.unions.intern(arms) };
        }
        return { kind: "awaitUnionExpr", value, promiseTag, type, loc };
      }
      const maybePromise = maybePromiseUnionOf(lowerer, value.type);
      if (maybePromise) return lowerMaybePromiseAwait(lowerer, expr, value, maybePromise, loc);
    }
    if (value.type.kind !== "promise") {
      // A CHECKED-DYNAMIC operand (`await v` where v rode an untyped
      // binding — a destructured helper's return, a dyn call result):
      // the runtime decides — a dyn promise adopts (rejections
      // re-throw), anything else takes JS's one-hop non-thenable await
      // and answers itself. Thenable adoption stays unmodeled
      // (SEMANTICS.md).
      if (value.type.kind === "dyn") {
        // A program that can define thenables adopts them (thenables.ts).
        if (programMayDefineThenables(lowerer)) return awaitDynThenable(lowerer, value, loc);
        return { kind: "libCall", fn: "async.awaitDyn", args: [value], type: DYN, loc };
      }

      if (awaitsChildThenable(lowerer, expr, value)) {
        return awaitDynThenable(lowerer, lowerer.coerceToExpected(value, DYN), loc);
      }
      // A TYPED non-promise operand (`await 42`, an awaited record):
      // JS awaits non-thenables through exactly one microtask turn and
      // yields the value itself — evaluate the operand, hop, answer it.
      // Void operands (an awaited void call) hop and stay void.
      if (value.type.kind === "void") {
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: value, loc }],
          result: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
          type: VOID,
          loc,
        };
      }
      // A bare-UNIT operand (`await null`, `await undefined` — the
      // async-hooks tests' turn-forcing idiom): same one-hop non-thenable
      // await, but a bare unit has no standalone representation (locals
      // and results may not carry bare unit types) — the value rides the
      // unit-only union, its literal wrapping into the matching arm (the
      // `const x = null` slot rule).
      if (isUnitType(value.type)) {
        const uT = unitOnlyUnion(lowerer.unions);
        const wrapped = lowerer.coerceToExpected(value, uT);
        const vLocal = lowerer.declareHiddenLocal("%awaited", uT);
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: vLocal.id, init: wrapped, loc },
            {
              kind: "exprStmt",
              expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
              loc,
            },
          ],
          result: { kind: "varRef", localId: vLocal.id, type: uT, loc },
          type: uT,
          loc,
        };
      }
      {
        const vLocal = lowerer.declareHiddenLocal("%awaited", value.type);
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: vLocal.id, init: value, loc },
            {
              kind: "exprStmt",
              expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
              loc,
            },
          ],
          result: { kind: "varRef", localId: vLocal.id, type: value.type, loc },
          type: value.type,
          loc,
        };
      }
    }
    return { kind: "awaitExpr", value, type: value.type.inner, loc };
  }
  if (ts.isYieldExpression(expr)) return lowerYield(lowerer, expr);
  if (ts.isPrefixUnaryExpression(expr)) return lowerer.lowerPrefixUnary(expr);
  // `x++` / `x--` in expression position: yields the OLD value.
  if (ts.isPostfixUnaryExpression(expr)) return lowerIncDec(lowerer, expr, false);
  if (ts.isBinaryExpression(expr))
    return lowerNewTargetComparison(lowerer, expr) ?? lowerer.lowerBinary(expr);
  if (ts.isCallExpression(expr)) {
    // `h.return?.()` on a helper object: the method exists, so the
    // optional call is the call.
    const helperReturn = lowerHelperReturnCall(lowerer, expr);
    if (helperReturn) return helperReturn;
    // The tail of an optional chain whose `?.` sits deeper
    // (`x?.trim().toLowerCase()`): the whole tail short-circuits together.
    if (isOptionalChainTail(lowerer, expr)) return lowerer.lowerOptionalChain(expr);
    return lowerer.lowerCall(expr);
  }
  if (ts.isArrayLiteralExpression(expr)) return lowerer.lowerArrayLiteral(expr);
  if (ts.isObjectLiteralExpression(expr)) return lowerer.lowerObjectLiteral(expr);
  if (ts.isElementAccessExpression(expr)) return lowerer.lowerElementAccess(expr);
  if (ts.isConditionalExpression(expr)) return lowerTernary(lowerer, expr);

  if (ts.isPropertyAccessExpression(expr))
    return lowerNewTargetName(lowerer, expr) ?? lowerPropertyAccessExpr(lowerer, expr, loc);

  // Meta-properties, named: `new.target` reflects HOW a function was
  // invoked (compiled functions are never constructors of themselves —
  // no runtime invocation record exists), and `import.meta`/
  // `import.defer` are module-loader surface a native binary does not
  // carry.
  if (isNewTarget(expr)) return lowerNewTarget(lowerer, expr);
  if (ts.isMetaProperty(expr)) {
    const name =
      expr.keywordToken === ts.SyntaxKind.NewKeyword ? "new.target" : `import.${expr.name.text}`;
    lowerer.unsupported(
      "SC1090",
      expr,
      name === "new.target"
        ? "'new.target' (no runtime invocation record exists in compiled code)"
        : `'${name}' (module-loader metadata has no equivalent in a compiled binary)`,
    );
  }

  const entry = UNSUPPORTED_EXPR[expr.kind];
  if (entry)
    lowerer.unsupported(
      entry.code as `SC${number}` & keyof typeof UNSUPPORTED,
      expr,
      entry.feature,
    );
  lowerer.unsupported("SC1090", expr, `syntax '${ts.syntaxKindName(expr.kind)}'`);
}

type RuntimeOptionalUse =
  | {
      kind: "property";
      access: ts.PropertyAccessExpression;
      optional: boolean;
      complex: boolean;
      comma: boolean;
    }
  | {
      kind: "element";
      access: ts.ElementAccessExpression;
      optional: boolean;
      complex: boolean;
      comma: boolean;
    }
  | {
      kind: "call";
      access: ts.CallExpression;
      optional: boolean;
      complex: boolean;
      comma: boolean;
    };

export function runtimeOptionalUseOf(expr: ts.Expression): RuntimeOptionalUse | null {
  let receiver = expr;
  let complex = false;
  let comma = false;
  for (;;) {
    const parent = receiver.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === receiver
    ) {
      receiver = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      parent.right === receiver
    ) {
      comma = true;
      receiver = parent;
      continue;
    }
    if (
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
        (parent.left === receiver || parent.right === receiver)) ||
      (ts.isConditionalExpression(parent) &&
        (parent.condition === receiver ||
          parent.whenTrue === receiver ||
          parent.whenFalse === receiver))
    ) {
      complex = true;
      receiver = parent;
      continue;
    }
    break;
  }
  const access = receiver.parent;
  if (ts.isPropertyAccessExpression(access) && access.expression === receiver) {
    return {
      kind: "property",
      access,
      optional: access.questionDotToken !== undefined,
      complex,
      comma,
    };
  }
  if (ts.isElementAccessExpression(access) && access.expression === receiver) {
    return {
      kind: "element",
      access,
      optional: access.questionDotToken !== undefined,
      complex,
      comma,
    };
  }
  if (ts.isCallExpression(access) && access.expression === receiver) {
    return {
      kind: "call",
      access,
      optional: access.questionDotToken !== undefined,
      complex,
      comma,
    };
  }
  return null;
}

export function runtimeOptionalElementKey(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) return expr.text;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

/** An operand of `===`, `!==`, `==` or `!=` (through parentheses). */
function isEqualityOperand(node: ts.Expression): boolean {
  let outer: ts.Expression = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  return (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  );
}

/** `xs[i]!` of an ordinary array outside a library build whose value must be
 * the element type: no consumer keeps a missing element as undefined (an
 * operator, a forwarded or undefined-admitting destination, an equality, an
 * erased optional use). The read takes the element behind a presence test,
 * whose failure throws the TypeError the checked extraction would: Node's
 * member-read TypeError for a dereferenced element (`xs[i]!.name`, which
 * returns the member's name), the extraction's own otherwise (null).
 * Undefined when the read takes the general path. */
function checkedElementMember(
  lowerer: Lowerer,
  expr: ts.NonNullExpression,
): string | null | undefined {
  if (lowerer.library) return undefined;
  const read = expr.expression;
  if (!ts.isElementAccessExpression(read) || read.questionDotToken) return undefined;
  const receiver = lowerer.mapTypeOf(lowerer.typeOf(read.expression));
  const target = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (
    receiver?.kind !== "array" ||
    !target ||
    target.kind === "union" ||
    !typeEquals(target, receiver.elem) ||
    lowerer.presentElementReads.has(read) ||
    lowerer.runtimeOptionalAssertions.has(expr) ||
    assertsElementWithoutCheck(lowerer, read) ||
    assertedElementKeepsUndefined(lowerer, expr) ||
    isEqualityOperand(expr)
  )
    return undefined;
  const use = runtimeOptionalUseOf(expr);
  if (use?.optional && !use.complex) return undefined;
  const parent = expr.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expr)
    return parent.questionDotToken || !ts.isIdentifier(parent.name) ? undefined : parent.name.text;
  if (
    (ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) &&
    parent.expression === expr
  )
    return undefined;
  return null;
}

/** `xs[i]!` of an array or typed array outside a library build, consumed by
 * an operator that converts undefined as Node does (arithmetic, comparison,
 * equality, bitwise and logical operators, unary operators, `typeof`, a
 * template span) or stored in a fresh object literal's field: the
 * assertion has no runtime effect there, as for the read without it (see `mayBeOptional` in lowerer.ts). Other consumers keep
 * the checked extraction unless the value is forwarded into storage that
 * holds undefined; a dereferenced element (`xs[i]!.length`) throws Node's
 * TypeError through the member-read check. */
function assertsElementWithoutCheck(lowerer: Lowerer, read: ts.ElementAccessExpression): boolean {
  if (lowerer.library) return false;
  const kind = lowerer.mapTypeOf(lowerer.typeOf(read.expression))?.kind;
  if (kind !== "array" && kind !== "bytes") return false;
  let outer: ts.Node = read.parent!;
  while (outer.parent && ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  if (!parent) return false;
  // A compound assignment (`total += xs[i]!`) converts its operand like
  // the operator; a plain `=` stores it.
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken;
  // A fresh object literal's field takes the optional value, as for the
  // read without the assertion.
  if (ts.isPropertyAssignment(parent)) return ts.isObjectLiteralExpression(parent.parent);
  return (
    ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isTemplateSpan(parent)
  );
}

/** Whether `xs[i]!` lands where an absent element's undefined is
 * representable: array storage (a literal element, a push/unshift
 * argument, an element assignment — arrays record the undefined state),
 * an equality operand, or a slot whose contextual type admits undefined.
 * TypeScript's `!` has no runtime effect, so such reads stay optional. */
export function assertedElementKeepsUndefined(
  lowerer: Lowerer,
  node: ts.NonNullExpression,
): boolean {
  let outer: ts.Expression = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  if (ts.isArrayLiteralExpression(parent)) return true;
  // An equality test observes the missing element itself.
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  )
    return true;
  const isArray = (receiver: ts.Expression): boolean =>
    lowerer.checker.isArrayType(lowerer.typeOf(receiver));
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.nodes.includes(outer) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    (parent.expression.name.text === "push" || parent.expression.name.text === "unshift") &&
    isArray(parent.expression.expression)
  )
    return true;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === outer &&
    ts.isElementAccessExpression(parent.left) &&
    isArray(parent.left.expression)
  )
    return true;
  const contextual = lowerer.checker.getContextualType(outer);
  if (!contextual) return false;
  const admits = (type: ts.Type): boolean =>
    (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined)) !== 0;
  return (
    admits(contextual) ||
    ((contextual.flags & ts.TypeFlags.Union) !== 0 && constituentTypes(contextual).some(admits))
  );
}

export function runtimeOptionalAssertionErases(
  lowerer: Lowerer,
  expr: ts.Expression,
  inner: IrExpr,
  use: RuntimeOptionalUse | null,
): boolean {
  if (
    inner.type.kind !== "union" ||
    !use?.optional ||
    use.complex ||
    lowerer.armTag(inner.type.unionId, UNDEFINED_T) < 0
  )
    return false;
  const target = lowerer.mapTypeOf(lowerer.typeOf(expr));
  return (
    !!target && target.kind !== "union" && typeEquals(lowerer.stripUndefinedArm(inner.type), target)
  );
}

/** `a ?? b` — JS-exact nullish coalescing: ONLY null/undefined take the
 * default (0, "", and false do not), and the right side evaluates lazily.
 * On a unit-armed union left this is the `nullish` node (a runtime tag
 * test against the unit arms, docs/ir.md); the two lowered shapes follow
 * the checker's result type — pass-through (`(s: string | undefined) ??
 * t` with t also `string | undefined`) and narrowed (`s ?? "d"` → plain
 * string, the single non-unit arm). A left the checker types non-nullish
 * never takes the right side, so the whole expression folds to the left
 * value — dropping only the never-evaluated default, the same
 * trust-the-checker bet as lowerUnitComparison's static fold. Sub-union
 * results (several non-unit arms) and defaults that change the result
 * type are fenced with narrow-first hints. */
export function lowerNullishCoalesce(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr {
  // `a ?? b ?? c` is a left-nested AST. Lower its spine bottom-up so
  // long dispatch chains do not retain a full expression/binary lowering
  // frame per operand in a native compiler. The pair lowering still
  // decides each result layout and preserves the lazy right operand.
  const parents: ts.BinaryExpression[] = [];
  let first = expr;
  while (
    ts.isBinaryExpression(first.left) &&
    first.left.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    !lowerer.chainRecvByNode.has(first.left)
  ) {
    parents.push(first);
    first = first.left;
  }
  let result = lowerNullishPair(
    lowerer,
    first,
    first === expr ? loc : locOf(first),
    assertedPresenceOperand(lowerer, first.left),
  );
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i]!;
    result = lowerNullishPair(lowerer, parent, parent === expr ? loc : locOf(parent), result);
  }
  return result;
}

/** The left side of `??` (see lowerPresenceOperand). The absence probe
 * reads optional storage beneath erased assertions; a union assertion that
 * narrows a stored class arm still applies its checked class view, so
 * `(node.parent as Sub | undefined) ?? node` sees the asserted arm on both
 * sides of the default. */
function assertedPresenceOperand(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const probe = lowerAbsenceProbe(lowerer, node);
  if (probe === null)
    return runtimeOptionalStorageOperand(lowerer, node) ?? lowerer.lowerExpr(node);
  if (probe.type.kind !== "union" && probe.type.kind !== "object") return probe;
  let outer = node;
  while (ts.isParenthesizedExpression(outer)) outer = outer.expression;
  if (!ts.isAsExpression(outer) && !ts.isTypeAssertion(outer)) return probe;
  const target = lowerer.mapTypeOf(lowerer.checker.getTypeFromTypeNode(outer.type));
  if (target?.kind !== "union" || typeEquals(target, probe.type)) return probe;
  return checkedClassUnionAssertion(lowerer, probe, target, locOf(outer)) ?? probe;
}

/** The undefined-armed slot behind a checked deferred-init field read, or
 * the value itself (Lowerer.deferredFieldSlot). */
export function deferredSlotOr(lowerer: Lowerer, value: IrExpr): IrExpr {
  return lowerer.deferredFieldSlot(value) ?? value;
}

/** Test the original storage before projecting its present value. Both
 * branches are lazy, and an effectful receiver is evaluated exactly once.
 * Keeping the original tags matters when the checker has removed an arm
 * or the default changes the union's layout. */
export function nullishBranches(
  lowerer: Lowerer,
  left: IrExpr,
  leftType: IrType & { kind: "union" },
  arms: readonly IrType[],
  type: IrType,
  loc: SrcLoc,
  absent: () => IrExpr,
  present: (stable: IrExpr) => IrExpr,
): IrExpr {
  const stmts: IrStmt[] = [];
  let stable = left;
  if (!isSafeToRepeat(left)) {
    const local = lowerer.declareHiddenLocal("%nullish", leftType);
    stmts.push({ kind: "varDecl", localId: local.id, init: left, loc });
    stable = varRef(local.id, leftType, loc);
  }
  const unitTags = arms.flatMap((arm, tag) => (isUnitType(arm) ? [tag] : []));
  let test: IrExpr | null = null;
  for (const tag of unitTags) {
    const part: IrExpr = {
      kind: "unionIsTag",
      unionId: leftType.unionId,
      tag,
      negated: false,
      value: stable,
      type: BOOL,
      loc,
    };
    test =
      test === null
        ? part
        : { kind: "logical", op: "||", left: test, right: part, type: BOOL, loc };
  }
  if (test === null) throw new InternalCompilerError("nullish branch requires an absent arm");
  const result: IrExpr = {
    kind: "ternary",
    cond: test,
    then: absent(),
    else_: present(stable),
    type,
    loc,
  };
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type, loc };
}

/** A CONDITION-position expression: the result is consumed as a bool
 * only, so `&&`/`||` descend recursively over ToBoolean'd operands —
 * JS-exact (`ToBoolean(a && b)` ≡ `ToBoolean(a) && ToBoolean(b)`), still
 * short-circuiting, and mixed operand kinds that have no VALUE
 * representation (`u && flag` — a union and a bool) test fine here. */
export function lowerCondition(lowerer: Lowerer, expr: ts.Expression): IrExpr {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  // `if (Object.setPrototypeOf)`: the feature test of transpiled Error
  // subclasses' prototype reset. Node always has it.
  if (
    ts.isPropertyAccessExpression(e) &&
    !e.questionDotToken &&
    e.name.text === "setPrototypeOf" &&
    lowerer.isStdlibGlobal(e.expression, "Object")
  )
    return { kind: "boolLit", value: true, type: BOOL, loc: locOf(e) };
  if (ts.isPropertyAccessExpression(e)) {
    const presence = lowerPromiseThenPresence(lowerer, e, {
      kind: "boolLit",
      value: true,
      type: BOOL,
      loc: locOf(e),
    });
    if (presence !== null) return presence;
    if (isTimerMethodPresence(lowerer, e))
      return { kind: "boolLit", value: true, type: BOOL, loc: locOf(e) };
  }
  // Global detection (`typeof window < "u"`, `typeof self !==
  // "undefined" && …`): a condition whose typeof answers are static
  // folds, so the untaken arm never lowers (static-typeof.ts).
  const folded = staticCondition(lowerer, e);
  if (folded !== null) return { kind: "boolLit", value: folded, type: BOOL, loc: locOf(e) };
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
      const left = lowerer.lowerCondition(e.left);
      if (left.kind === "boolLit" && left.value !== isAnd) return left;
      // The right operand evaluates only when the left already answered
      // (true for &&, false for ||) — aliased-typeof narrows the left
      // PROVES under that polarity hold while it lowers (`type ===
      // 'string' && val.length > 0`, the ms entry shape).
      const runtimeOptionalLocal = isAnd ? runtimeOptionalLocalOf(lowerer, e.left) : null;
      const right = lowerer.narrowingAliases(aliasTypeofNarrows(lowerer, e.left, isAnd), () => {
        if (runtimeOptionalLocal === null) return lowerer.lowerCondition(e.right);
        lowerer.runtimeOptionalLocals.delete(lowerer.runtimeOptionalRootOf(runtimeOptionalLocal));
        try {
          return lowerer.lowerCondition(e.right);
        } finally {
          lowerer.runtimeOptionalLocals.add(lowerer.runtimeOptionalRootOf(runtimeOptionalLocal));
        }
      });
      if (left.kind === "boolLit") return right;
      return {
        kind: "logical",
        op: isAnd ? "&&" : "||",
        left,
        right,
        type: BOOL,
        loc: locOf(expr),
      };
    }
  }
  const value = lowerPresenceOperand(lowerer, expr);
  return (
    tryLowerIndexTruthiness(lowerer, value, expr, locOf(expr)) ?? lowerer.ensureBool(value, expr)
  );
}

/** `typeof (u as any).then` / `if ((u as Promise<T>).then)` over a
 * maybe-promise union `u` (the cast is erasure in JS): a promise arm has
 * the prototype's `then` function, and no data arm is thenable (the type
 * mapper's rule), so the union tag answers. Null for every other shape. */
function maybePromiseThenPresence(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  result: IrExpr,
): IrExpr | null {
  let receiver: ts.Expression = access.expression;
  let cast = false;
  for (;;) {
    if (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    else if (ts.isAsExpression(receiver) || ts.isTypeAssertion(receiver)) {
      receiver = receiver.expression;
      cast = true;
    } else break;
  }
  if (!cast) return null;
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(receiver));
  if (!mapped || !maybePromiseUnionOf(lowerer, mapped)) return null;
  const value = lowerer.lowerExpr(receiver);
  const mp = maybePromiseUnionOf(lowerer, value.type);
  if (!mp) return null;
  const loc = locOf(access);
  const absent: IrExpr =
    result.type.kind === "bool"
      ? { kind: "boolLit", value: false, type: BOOL, loc }
      : { kind: "strLit", value: "undefined", type: STRING, loc };
  return {
    kind: "ternary",
    cond: {
      kind: "unionIsTag",
      unionId: mp.def.id,
      tag: mp.promiseTag,
      negated: false,
      value,
      type: BOOL,
      loc,
    },
    then: result,
    else_: absent,
    type: result.type,
    loc,
  };
}

/** `if (t.unref)` over a Node timer handle: the guard libraries write for
 * runtimes whose timers lack the method (execa's kill timeout). Node's
 * Timeout and Immediate always have it. */
function isTimerMethodPresence(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
  if (access.questionDotToken || !ts.isIdentifier(access.expression)) return false;
  if (!["ref", "unref", "hasRef", "refresh"].includes(access.name.text)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(access.name);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return false;
  const owner = lowerer.typeOf(access.expression).getSymbol();
  return owner !== undefined && ["Timeout", "Immediate"].includes(ts.symbolName(owner));
}

export function lowerPromiseThenPresence(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  result: IrExpr,
): IrExpr | null {
  if (access.name.text !== "then") return null;
  const maybePromise = maybePromiseThenPresence(lowerer, access, result);
  if (maybePromise !== null) return maybePromise;
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  const promiseType =
    mapped?.kind === "promise"
      ? mapped
      : mapped?.kind === "union"
        ? (() => {
            const arms = lowerer.unions.get(mapped.unionId)?.arms ?? [];
            const promises = arms.filter((arm): boolean => arm.kind === "promise");
            const promise = promises[0];
            return promises.length === 1 &&
              promise?.kind === "promise" &&
              arms.every((arm) => arm.kind === "promise" || isUnitType(arm))
              ? promise
              : null;
          })()
        : null;
  if (promiseType === null) return null;
  let receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind === "union" && access.questionDotToken) {
    const arms = lowerer.unions.get(receiver.type.unionId)?.arms ?? [];
    if (arms.every((arm) => arm.kind === "promise" || isUnitType(arm))) {
      return nullishBranches(
        lowerer,
        receiver,
        receiver.type,
        arms,
        result.type,
        locOf(access),
        () =>
          result.type.kind === "bool"
            ? { kind: "boolLit", value: false, type: BOOL, loc: result.loc }
            : { kind: "strLit", value: "undefined", type: STRING, loc: result.loc },
        () => result,
      );
    }
  }
  if (receiver.type.kind === "union") {
    const optional = lowerer.runtimeOptionalPropertyReceiver(
      access.expression,
      receiver,
      promiseType,
      access.name.text,
    );
    if (optional !== null) receiver = optional;
    else {
      const helper = lowerer.narrowedArmHelper(receiver.type.unionId, promiseType, receiver.loc);
      if (helper === null) return null;
      receiver = lowerer.checkedNarrowCall(helper, receiver, promiseType, receiver.loc);
    }
  }
  if (receiver.type.kind === "dyn") {
    // A specialized JS parameter can retain checked storage while JSDoc
    // describes a promise. Probe its actual value, preserving nullish
    // guards and own-property reads on ordinary thenable objects.
    const loc = locOf(access);
    const local = lowerer.declareHiddenLocal("%thenReceiver", DYN);
    const stable = varRef(local.id, DYN, loc);
    const member: IrExpr = {
      kind: "dynKeyGet",
      value: stable,
      key: { kind: "strLit", value: "then", type: STRING, loc },
      ...(access.questionDotToken ? { optional: true as const } : {}),
      type: DYN,
      loc,
    };
    const other: IrExpr =
      result.type.kind === "bool"
        ? { kind: "dynTest", test: "truthy", value: member, type: BOOL, loc }
        : { kind: "libCall", fn: "dyn.typeof", args: [member], type: STRING, loc };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
      result: {
        kind: "ternary",
        cond: { kind: "dynTest", test: "promise", value: stable, type: BOOL, loc },
        then: result,
        else_: other,
        type: result.type,
        loc,
      },
      type: result.type,
      loc,
    };
  }
  if (receiver.type.kind !== "promise") return null;
  if (isSafeToDiscard(receiver)) return result;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: receiver, loc: receiver.loc }],
    result,
    type: result.type,
    loc: result.loc,
  };
}

export function runtimeOptionalLocalOf(lowerer: Lowerer, node: ts.Expression): IrLocal | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return null;
  const local = lowerer.resolveLocal(expr);
  return local && lowerer.runtimeOptionalLocals.has(lowerer.runtimeOptionalRootOf(local))
    ? local
    : null;
}

/** JS ToBoolean: bool passes through; f64/string get a `toBool` wrapper
 * (falsy: 0, -0, NaN, ""); unions get the same wrapper answered by a
 * per-union interned helper (unit arms falsy; scalar/string arms by
 * value; ref arms always truthy). Anything else (void) cannot be
 * tested. */
export function ensureBool(lowerer: Lowerer, e: IrExpr, node: ts.Expression): IrExpr {
  if (e.type.kind === "bool") return e;
  if (e.type.kind === "f64" || e.type.kind === "string") {
    return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
  }
  if (e.type.kind === "bigint") {
    return { kind: "libCall", fn: "bigint.truthy", args: [e], type: BOOL, loc: e.loc };
  }
  if (e.type.kind === "dyn") {
    // ToBoolean over the checked-dynamic tree (`if (pkg)` on a JSON.parse result): every
    // dyn kind has a JS-exact answer — the truthy dynTest reads the kind
    // tag (plus the scalar payload for number/string).
    return { kind: "dynTest", test: "truthy", value: e, type: BOOL, loc: e.loc };
  }

  if (e.type.kind === "union") {
    lowerer.requireTruthyUnion(e.type.unionId, node);
    return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
  }
  if (REF_TRUTHY_KINDS.has(e.type.kind)) {
    // JS objects are ALWAYS truthy ([] and {} included) — the operand
    // still evaluates (side effects), the test is constant.
    return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
  }
  // Bare unit values (undefined/null literals, the capability-probe
  // reads that answer them): ToBoolean is constantly false. Units have
  // no effectful producers, so folding the read away loses nothing.
  if (isUnitType(e.type)) {
    return { kind: "boolLit", value: false, type: BOOL, loc: e.loc };
  }
  lowerer.badType(node, lowerer.typeOf(node));
}

export function requireTruthyUnion(lowerer: Lowerer, unionId: string, node: ts.Expression): void {
  const def = lowerer.unions.get(unionId);
  if (def && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught")) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `union-typed conditions with 'unknown' arms (${NARROW_FIRST})`,
  );
}

export function eqComparableUnion(lowerer: Lowerer, unionId: string): boolean {
  const def = lowerer.unions.get(unionId);
  return !!def && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught");
}

/** Convert an undefined-armed numeric value at an arithmetic use. Ordinary
 * reads preserve their tagged value; JavaScript's ToNumber(undefined) is NaN,
 * so compounds and binary arithmetic use this checked one-time extraction. */
export function lowerOptionalNumber(
  lowerer: Lowerer,
  operand: IrExpr,
  loc: SrcLoc,
  narrowedNode?: ts.Expression,
): IrExpr {
  if (operand.type.kind !== "union" || lowerer.armTag(operand.type.unionId, UNDEFINED_T) < 0)
    return operand;
  const directNumber = lowerer.stripUndefinedArm(operand.type).kind === "f64";
  if (directNumber) {
    const scalarRead = tryLowerNumericIndexRead(lowerer, operand, loc);
    if (scalarRead) return scalarRead;
  }
  const checkerNumber =
    narrowedNode !== undefined && lowerer.mapTypeOf(lowerer.typeOf(narrowedNode))?.kind === "f64";
  if (!directNumber && (!checkerNumber || lowerer.armTag(operand.type.unionId, F64) < 0))
    return operand;
  const undefTag = lowerer.armTag(operand.type.unionId, UNDEFINED_T);
  const valueTag = lowerer.armTag(operand.type.unionId, F64);
  if (undefTag < 0 || valueTag < 0) return operand;
  const checked = directNumber ? null : lowerer.narrowedArmHelper(operand.type.unionId, F64, loc);
  if (!directNumber && !checked) return operand;
  let stable = operand;
  let prefix: IrStmt[] = [];
  if (!isSafeToRepeat(operand)) {
    const tmp = lowerer.declareHiddenLocal("%arith", operand.type);
    stable = varRef(tmp.id, operand.type, loc);
    prefix = [{ kind: "varDecl", localId: tmp.id, init: operand, loc }];
  }
  const value: IrExpr = {
    kind: "ternary",
    cond: {
      kind: "unionIsTag",
      unionId: operand.type.unionId,
      tag: undefTag,
      negated: false,
      value: stable,
      type: BOOL,
      loc,
    },
    then: { kind: "bin", op: "/", left: numLit(0, loc), right: numLit(0, loc), type: F64, loc },
    else_: checked
      ? { kind: "call", callee: checked, args: [stable], type: F64, loc }
      : {
          kind: "unionNarrow",
          unionId: operand.type.unionId,
          tag: valueTag,
          value: stable,
          type: F64,
          loc,
        },
    type: F64,
    loc,
  };
  return prefix.length === 0
    ? value
    : { kind: "seqExpr", stmts: prefix, result: value, type: F64, loc };
}

/** A number argument of a builtin that converts it with ToNumber (Math
 * functions, String.fromCharCode, the global isNaN/isFinite, DataView
 * offsets and values). ToNumber(undefined) is NaN, so a missing value — an
 * out-of-range read, a local or field holding one, or a hole — converts to
 * NaN instead of trusting the checker's number type. */
export function lowerToNumberArgument(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const operand = numberOperand(lowerer, node);
  return operand.convert ? operand.convert(operand.value) : operand.value;
}

/** The ToNumber arguments of one call (the Math functions,
 * String.fromCharCode): Node evaluates every argument before it converts
 * any. When an argument's conversion can run program code (valueOf or
 * toString on a dynamic value) and a later argument follows, the arguments
 * evaluate into temporaries first and convert in order after. `lowerOther`
 * lowers an argument that takes no conversion (a spread's array), or returns
 * null for a ToNumber argument; with temporaries, such an array is copied
 * where it is evaluated, since JavaScript reads a spread's elements then,
 * before a later conversion's valueOf could change them. Returns the
 * temporaries' statements (empty when none are needed) and the converted
 * values. */
export function lowerToNumberArguments(
  lowerer: Lowerer,
  nodes: readonly ts.Expression[],
  lowerOther?: (node: ts.Expression) => IrExpr | null,
): { stmts: IrStmt[]; values: IrExpr[] } {
  const operands = nodes.map((node): NumberOperand => {
    const other = lowerOther?.(node);
    return other
      ? { value: other, convert: null, runsCode: false, spread: true }
      : numberOperand(lowerer, node);
  });
  const late = operands.slice(0, -1).some((operand) => operand.runsCode);
  if (!late) {
    const values = operands.map((o) => (o.convert ? o.convert(o.value) : o.value));
    return { stmts: [], values };
  }
  const stmts: IrStmt[] = [];
  const values = operands.map((operand) => {
    if (operand.value.kind === "numLit") return operand.value;
    const temp = lowerer.declareHiddenLocal("%numberArgument", operand.value.type);
    const loc = operand.value.loc;
    const init: IrExpr =
      operand.spread && operand.value.type.kind === "array"
        ? {
            kind: "arrIntrinsic",
            method: "slice",
            receiver: operand.value,
            args: [numLit(0, loc), numLit(Infinity, loc)],
            type: operand.value.type,
            loc,
          }
        : operand.value;
    stmts.push({ kind: "varDecl", localId: temp.id, init, loc });
    const read = varRef(temp.id, operand.value.type, loc);
    return operand.convert ? operand.convert(read) : read;
  });
  return { stmts, values };
}

/** An argument a ToNumber site lowers: its evaluated value and the
 * conversion that makes it a number (null when the value already is one).
 * `runsCode`: the conversion can call program code. `spread`: the value is
 * a spread's array (lowerToNumberArguments' `lowerOther`). */
interface NumberOperand {
  value: IrExpr;
  convert: ((value: IrExpr) => IrExpr) | null;
  runsCode: boolean;
  spread?: boolean;
}

function numberOperand(lowerer: Lowerer, node: ts.Expression): NumberOperand {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  const loc = locOf(inner);
  const number = (value: IrExpr): NumberOperand => ({ value, convert: null, runsCode: false });
  const dynToNumber = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "dyn.toNumberCoerce",
    args: [value],
    type: F64,
    loc,
  });
  const isOptionalNumber = (value: IrExpr): boolean =>
    value.type.kind === "union" &&
    lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0 &&
    lowerer.stripUndefinedArm(value.type).kind === "f64";
  const optional = ts.isIdentifier(inner)
    ? runtimeOptionalStorageOperand(lowerer, inner)
    : ts.isElementAccessExpression(inner)
      ? lowerAbsenceProbe(lowerer, inner)
      : null;
  if (optional && isOptionalNumber(optional))
    return number(lowerOptionalNumber(lowerer, optional, loc, inner));
  // A conditional with number branches builds each branch as a number;
  // other branches box, and the value converts like any dynamic value.
  if (ts.isConditionalExpression(inner)) {
    const branch = (b: ts.Expression) => lowerer.mapTypeOf(lowerer.typeOf(b))?.kind;
    if (branch(inner.whenTrue) === "f64" && branch(inner.whenFalse) === "f64")
      return number(lowerer.lowerExprExpecting(node, F64));
    return { value: lowerer.lowerExprExpecting(node, DYN), convert: dynToNumber, runsCode: true };
  }
  const value = lowerer.lowerExpr(node);
  if (isOptionalNumber(value)) return number(lowerOptionalNumber(lowerer, value, loc, inner));
  // Other values convert with ToNumber: strings parse as numeric literals,
  // booleans and null are numbers, and checked-dynamic values call
  // valueOf/toString or throw Node's TypeError for a Symbol or BigInt.
  const num = (n: number): IrExpr => ({ kind: "numLit", value: n, type: F64, loc });
  const pure = (convert: (value: IrExpr) => IrExpr): NumberOperand => ({
    value,
    convert,
    runsCode: false,
  });
  switch (value.type.kind) {
    case "string":
      return pure((v) => ({ kind: "libCall", fn: "num.fromString", args: [v], type: F64, loc }));
    case "bool":
      return pure((v) => ({
        kind: "ternary",
        cond: v,
        then: num(1),
        else_: num(0),
        type: F64,
        loc,
      }));
    case "nullT":
      return pure((v) => defaultAfterUndefined(v, num(0)));
    case "undefinedT":
      return pure((v) => defaultAfterUndefined(v, num(NaN)));
    case "dyn":
      return { value, convert: dynToNumber, runsCode: true };
    case "union":
      if (lowerer.dynConvertible(value.type))
        return {
          value: lowerer.coerceToExpected(value, DYN),
          convert: dynToNumber,
          runsCode: true,
        };
      break;
  }
  return number(lowerer.coerceInto(node, value, F64));
}

/** The stored value of an identifier whose storage holds an undefined arm
 * that the checker's type at this use has dropped. An assignment from an
 * unchecked indexed read narrows the declared type even though the value
 * can be absent at runtime, so presence tests (`=== undefined`, `== null`,
 * truthiness, `??`, `typeof`) read the storage tag instead of trusting
 * that narrowing. A guard-proven use answers the same way at runtime. */
export function runtimeOptionalStorageOperand(
  lowerer: Lowerer,
  node: ts.Expression,
): IrExpr | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return null;
  // Only storage that can actually receive an absent value without the
  // checker seeing it qualifies; other declared-optional bindings keep the
  // checker's assignment and guard narrowing.
  const symbol = lowerer.resolveValueSymbol(expr);
  const local = lowerer.resolveLocal(expr);
  const global = local ? undefined : lowerer.globalOf(expr);
  const root = local ? lowerer.runtimeOptionalRootOf(local) : null;
  if (root && lowerer.runtimeOptionalStorageLocals.has(root)) {
    // These locals track guards: a branch that proved presence removes
    // the binding from the active set, and its reads stay narrowed. A
    // captured binding can be reassigned between calls, so a capture
    // never inherits a guard (the identifier read's own rule).
    const captured =
      local!.boxed === true ||
      (!!symbol && lowerer.ctx.captureBySymbol.get(symbol) === local) ||
      root !== local;
    if (!captured && !lowerer.runtimeOptionalLocals.has(root)) return null;
  } else if (
    !(symbol && lowerer.runtimeOptionalAssignedSymbols.has(symbol)) &&
    !(symbol && lowerer.runtimeOptionalBindingTypes.has(symbol)) &&
    !(global && lowerer.isRuntimeOptionalGlobal(global))
  )
    return null;
  const optional = lowerer.runtimeOptionalIdentifierValue(expr);
  if (optional === null) return null;
  const checked = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (
    checked === null ||
    (checked.kind === "union" && lowerer.armTag(checked.unionId, UNDEFINED_T) >= 0)
  )
    return null;
  return optional.value;
}

/** A presence-test operand: an absence-aware element or field read, an
 * identifier's runtime-optional storage, or the ordinary lowering. */
export function lowerPresenceOperand(lowerer: Lowerer, node: ts.Expression): IrExpr {
  // An unassigned deferred-init field observes its undefined slot too.
  return deferredSlotOr(
    lowerer,
    lowerAbsenceProbe(lowerer, node) ??
      runtimeOptionalStorageOperand(lowerer, node) ??
      lowerer.lowerExpr(node),
  );
}

/** A keyed read used only to observe absence (`if (map[k])`, or the left
 * side of `||`/`??`). JavaScript answers undefined for missing record keys
 * and array indices even when noUncheckedIndexedAccess is disabled. Keep
 * that value in an explicit union until the surrounding guard/default has
 * consumed it, including class-field and declared-only reads that otherwise
 * keep their typed storage. Assertions
 * around the read are erased here because this context handles the missing
 * arm instead of consuming it as the asserted type. */
export function lowerAbsenceProbe(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  let expr = node;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertion(expr)
  ) {
    expr = expr.expression;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // Namespace members are bindings, not fields of a runtime namespace
    // object. Their ordinary read already preserves optional storage.
    if (!expr.questionDotToken && nsMemberIdentOf(lowerer, expr)) return null;
    const target = lowerer.fieldTarget(expr);
    if (
      target?.container === "class" &&
      target.fieldType.kind === "union" &&
      lowerer.unions.get(target.fieldType.unionId)?.arms.some(isUnitType)
    ) {
      return lowerer.fieldGetExpr(target, locOf(expr), expr);
    }
    if (target?.container !== "recordOvf") return null;
    // A JS file-scope object-literal global is record-shaped to the
    // checker but stored in the checked-dynamic tree to preserve object
    // identity. Reuse the normal dyn-aware field read; constructing a
    // recordKeyGet here would give the validator a dyn receiver.
    if (target.obj.type.kind === "dyn") {
      return lowerer.fieldGetExpr(target, locOf(expr), expr);
    }
    if (
      target.fieldType.kind === "union" &&
      lowerer.armTag(target.fieldType.unionId, UNDEFINED_T) >= 0
    ) {
      return null;
    }
    const type = lowerer.withUndefinedArmOf(target.fieldType);
    if (!type) return null;
    return {
      kind: "recordKeyGet",
      obj: target.obj,
      shapeId: target.shapeId,
      key: { kind: "strLit", value: target.field, type: STRING, loc: locOf(expr) },
      overflowOnly: true,
      type,
      loc: locOf(expr),
    };
  }
  if (!ts.isElementAccessExpression(expr)) return null;

  const cachedModule = lowerRequireCacheElement(lowerer, expr);
  if (cachedModule) return cachedModule;

  const header = lowerer.lowerHttpHeadersElement(expr);
  if (header) return header;

  const receiverT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (receiverT?.kind === "record") {
    const shape = lowerer.shapes.get(receiverT.shapeId);
    if (shape && !shape.tuple && shape.indexValue && shape.indexValue.kind !== "dyn") {
      return lowerer.lowerRecordKeyRead(expr, receiverT.shapeId, shape, true);
    }
    return null;
  }
  // `m[2]` on a JavaScript `RegExpExecArray | null` that a previous
  // statement ruled non-null without narrowing it (jose's secs()).
  if (
    receiverT?.kind === "union" &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    !expr.questionDotToken &&
    !hasOptionalChainGuard(expr.expression)
  ) {
    const arms = lowerer.unions.get(receiverT.unionId)?.arms ?? [];
    const present = arms.filter((arm) => !isUnitType(arm));
    if (present.length !== 1 || present[0]!.kind !== "array") return null;
    const value = lowerer.lowerExpr(expr.expression);
    const index = lowerer.lowerExpr(expr.argumentExpression);
    if (index.type.kind !== "f64") return null;
    return lowerOptionalArrayIndexRead(lowerer, expr, value, index);
  }
  if (receiverT?.kind !== "array") return null;
  const arr = lowerer.lowerExpr(expr.expression);
  if (arr.type.kind !== "array") return null;
  const index = lowerer.lowerExpr(expr.argumentExpression);
  if (index.type.kind !== "f64") return null;
  return lowerSafeIndexRead(lowerer, arr, index, locOf(expr));
}

/** Can every value a dynamic key can reach (declared fields + the
 * overflow) surface as the read's result type? dyn results need
 * dyn-convertible fields (JSON-safe, with the undefined arm allowed at
 * the top — an optional field's undefined becomes the undefined dyn
 * value, exactly what the missing-key path produces); typed results need
 * each field to be the type itself or one of its arms, and the overflow
 * value to be the type or wrappable into it. */
export function recordKeyResultOk(lowerer: Lowerer, shape: IrRecordShape, type: IrType): boolean {
  const surfaces = (t: IrType): boolean =>
    typeEquals(t, type) ||
    (type.kind === "union" && lowerer.armTag(type.unionId, t) >= 0) ||
    exactUnionWidening(lowerer, t, type) ||
    (type.kind === "dyn" && lowerer.dynConvertible(t));
  if (!shape.fields.every((f) => surfaces(f.type))) return false;
  if (shape.indexValue) {
    if (type.kind === "dyn") return shape.indexValue.kind === "dyn";
    if (!surfaces(shape.indexValue)) return false;
  }
  return true;
}

export function exactUnionWidening(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (from.kind !== "union" || to.kind !== "union") return false;
  const source = lowerer.unions.get(from.unionId);
  const target = lowerer.unions.get(to.unionId);
  return !!source && !!target && unionWideningTags(source.arms, target.arms) !== null;
}

/** `a[i] op= rhs` in statement position: a string array append becomes the
 * canonical `a[i] = a[i] + rhs` store (receiver and index saved first),
 * which the backend appends in place; other forms keep the value path. */
export function lowerElementCompoundStatement(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  op: CompoundOp,
): IrStmt {
  const lowered = lowerElementCompoundParts(lowerer, expr, op, true);
  if (lowered.stmts) return { kind: "block", body: lowered.stmts, loc: locOf(expr) };
  return { kind: "exprStmt", expr: lowered.expr!, loc: locOf(expr) };
}

/** Checked member assignment evaluates the reference before its RHS and
 * yields the original assigned value, including in a chained assignment. */
export function lowerDynMemberAssignment(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  recv: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const target = expr.left as ts.ElementAccessExpression | ts.PropertyAccessExpression;
  const receiver = lowerer.declareHiddenLocal("%setReceiver", DYN);
  const keyValue = ts.isElementAccessExpression(target)
    ? lowerer.lowerExprExpecting(target.argumentExpression, DYN)
    : lowerer.coerceToExpected({ kind: "strLit", value: target.name.text, type: STRING, loc }, DYN);
  const key = lowerer.declareHiddenLocal("%setKey", DYN);
  const raw = lowerer.lowerExpr(expr.right);
  const value: IrExpr =
    raw.type.kind === "void"
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: raw, loc }],
          result: dynUndefinedExpr(loc),
          type: DYN,
          loc,
        }
      : isUnitType(raw.type)
        ? lowerer.coerceInto(expr.right, raw, DYN)
        : raw;
  const assigned = lowerer.declareHiddenLocal("%setValue", value.type);
  const result = varRef(assigned.id, value.type, loc);
  const stored = lowerer.coerceInto(expr.right, result, DYN);
  // Evaluate the reference before the RHS, but defer key coercion until
  // PutValue. Yield the RHS without rereading a setter-backed property.
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiver.id, init: recv, loc },
      { kind: "varDecl", localId: key.id, init: keyValue, loc },
      { kind: "varDecl", localId: assigned.id, init: value, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [varRef(receiver.id, DYN, loc), varRef(key.id, DYN, loc), stored],
          type: VOID,
          loc,
        },
        loc,
      },
    ],
    result,
    type: result.type,
    loc,
  };
}

/** `typeof` of a Node 24 Web-platform constructor global or one of its
 * static methods: "function", decided by name. The read has no effects.
 * Static methods answer by name because after a `typeof
 * globalThis.AbortSignal === "function" &&` guard the checker narrows a
 * fallback-typed receiver to never, hiding the member's declaration. */
export function constructorGlobalTypeof(lowerer: Lowerer, tested: ts.Expression): string | null {
  while (ts.isParenthesizedExpression(tested)) tested = tested.expression;
  const globalName = stdlibGlobalNameOf(lowerer, tested);
  if (globalName !== null && NODE_CONSTRUCTOR_GLOBALS.has(globalName)) return "function";
  if (!ts.isPropertyAccessExpression(tested) || tested.questionDotToken) return null;
  const owner = stdlibGlobalNameOf(lowerer, tested.expression);
  return owner !== null &&
    Object.hasOwn(NODE_CONSTRUCTOR_STATICS, owner) &&
    NODE_CONSTRUCTOR_STATICS[owner]!.includes(tested.name.text)
    ? "function"
    : null;
}

/** Static methods of Node 24's Web-platform constructor globals. */
const NODE_CONSTRUCTOR_STATICS: Readonly<Record<string, readonly string[]>> = {
  AbortSignal: ["abort", "any", "timeout"],
  Response: ["error", "json", "redirect"],
  URL: ["canParse", "createObjectURL", "parse", "revokeObjectURL"],
};

/** Node 24's Web-platform constructor globals: `typeof` answers
 * "function" for each. */
const NODE_CONSTRUCTOR_GLOBALS: ReadonlySet<string> = new Set([
  "AbortController",
  "AbortSignal",
  "Blob",
  "BroadcastChannel",
  "CustomEvent",
  "DOMException",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Headers",
  "MessageChannel",
  "MessageEvent",
  "MessagePort",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WritableStream",
]);

/** An operand of `+` with a string: ToString of ToPrimitive with the
 * default hint, which tries a class instance's valueOf before toString. */
export function concatOperand(lowerer: Lowerer, e: IrExpr, node: ts.Node): IrExpr {
  return (
    classToStringConversion(lowerer, e, "default", node) ??
    classUnionToString(lowerer, e, "default", node) ??
    lowerer.ensureString(e, node)
  );
}

/** `new String(x)` (stdlib provenance, ≤1 argument) in a ToString
 * position: the wrapper's only distinguishers are typeof and identity —
 * neither is observable where the value immediately stringifies — so the
 * span lowers as the argument's own ToString (`new String()` is "").
 * Every other position keeps the wrapper-object constructor fence. */
export function stringWrapperToString(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression)) return null;
  const symbol = lowerer.resolveValueSymbol(e.expression);
  if (symbol === null || ts.symbolName(symbol) !== "String" || !lowerer.isStdlibSymbol(symbol))
    return null;
  const args = e.arguments?.nodes ?? [];
  if (args.length > 1 || args.some(ts.isSpreadElement)) return null;
  if (args.length === 0) return { kind: "strLit", value: "", type: STRING, loc: locOf(e) };
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, args[0]!);
  if (undefinedArg)
    return defaultAfterUndefined(undefinedArg, {
      kind: "strLit",
      value: "undefined",
      type: STRING,
      loc: locOf(e),
    });
  return (
    lowerer.caughtToString(args[0]!) ??
    coerceStringSearchValue(lowerer, lowerer.lowerExpr(args[0]!), args[0]!, locOf(e))
  );
}

export function lowerTemplate(lowerer: Lowerer, expr: ts.TemplateExpression): IrExpr {
  const loc = locOf(expr);
  const pieces: IrExpr[] = [];
  if (expr.head.text !== "") {
    pieces.push({ kind: "strLit", value: expr.head.text, type: STRING, loc });
  }
  for (const span of expr.templateSpans.nodes) {
    pieces.push(
      stringWrapperToString(lowerer, span.expression) ??
        lowerer.caughtToString(span.expression) ??
        lowerer.ensureString(lowerer.lowerExpr(span.expression), span.expression),
    );
    if (span.literal.text !== "") {
      pieces.push({
        kind: "strLit",
        value: span.literal.text,
        type: STRING,
        loc: locOf(span.literal),
      });
    }
  }
  if (pieces.length === 0) return { kind: "strLit", value: "", type: STRING, loc };
  return pieces.reduce((acc, p) => ({ kind: "strConcat", left: acc, right: p, type: STRING, loc }));
}

const BIGINT_COMPOUND = {
  "+": "bigint.add",
  "-": "bigint.sub",
  "*": "bigint.mul",
  "/": "bigint.div",
  "%": "bigint.mod",
  "**": "bigint.pow",
  "&": "bigint.and",
  "|": "bigint.or",
  "^": "bigint.xor",
  "<<": "bigint.shl",
  ">>": "bigint.shr",
} as const;

/** `old op= rhs` over two bigints: the binary operator's libCall. Null
 * for other operand types (and `>>>`, which BigInt does not have). */
export function bigintCompoundValue(
  op: CompoundOp,
  left: IrExpr,
  right: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (left.type.kind !== "bigint" || right.type.kind !== "bigint" || op === ">>>") return null;
  return { kind: "libCall", fn: BIGINT_COMPOUND[op], args: [left, right], type: BIGINT_T, loc };
}

/** The runtime operator of a compound assignment over two checked-dynamic
 * operands (Node's ToPrimitive/ToNumeric order lives in the runtime). */
export function dynCompoundValue(op: CompoundOp, left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr {
  const numeric = ["-", "*", "/", "%", "**"].includes(op);
  return {
    kind: "libCall",
    fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
    args: op === "+" ? [left, right] : [left, right, strLit(op, loc)],
    type: DYN,
    loc,
  };
}

/** An operand type in an SC1043 message: checked-dynamic values (`any`,
 * `unknown`) are "untyped", everything else its quoted type. */
function operandText(lowerer: Lowerer, t: IrType): string {
  return t.kind === "dyn" ? "untyped" : `'${lowerer.fmt(t)}'`;
}

/** SC1043 for a compound assignment whose operand types have no lowering,
 * naming the operator and both types rather than the comparison wording. */
export function compoundUnsupported(
  lowerer: Lowerer,
  node: ts.Node,
  op: CompoundOp,
  target: IrType,
  value: IrType,
): never {
  lowerer.unsupported(
    "SC1043",
    node,
    `compound '${op}=' assignments of ${operandText(lowerer, value)} values to ${operandText(lowerer, target)} targets`,
  );
}

/** SC1043 for an arithmetic, unary or update operator whose operand types
 * have no lowering (comparisons keep the registry wording). */
export function operatorUnsupported(
  lowerer: Lowerer,
  node: ts.Node,
  op: string,
  operands: readonly IrType[],
): never {
  const [first, second] = operands;
  lowerer.unsupported(
    "SC1043",
    node,
    second === undefined
      ? `'${op}' operations on ${operandText(lowerer, first!)} values`
      : `'${op}' operations on ${operandText(lowerer, first!)} and ${operandText(lowerer, second)} values`,
  );
}

/** `typeof e === "lit"` / `typeof e !== "lit"` where e is a catch
 * binding: the runtime kind test over the snapshot's tag. Only the
 * primitive literals narrow ("string"/"number"/"boolean" — exactly what
 * the exception cell can distinguish); "object"/"function"/"undefined"
 * cannot be answered from the payload kinds (a thrown array and a thrown
 * record are both refs) and get the instanceof hint. Null when neither
 * side is a typeof over a catch binding (not this pattern). */
/** The %Error-rooted object type inside a checker type, or null: the
 * direct mapping when it IS one, else the first mappable %Error-rooted
 * constituent of an intersection (`Error & Record<"code", unknown>` —
 * what `err instanceof Error && "code" in err` narrows a catch binding
 * to; the refinement parts are type-level decoration, the VALUE is the
 * error object). */
export function errorRootedObjectOf(lowerer: Lowerer, t: ts.Type): IrType | null {
  const rooted = (m: IrType | null): m is IrType & { kind: "object" } => {
    if (m?.kind !== "object") return false;
    let info = lowerer.classes.get(m.className) ?? null;
    while (info && info.base) info = info.base;
    return info?.def.name === "%Error";
  };
  const direct = lowerer.mapTypeOf(t);
  if (rooted(direct)) return direct;
  if (t.isIntersectionType()) {
    for (const part of ts.constituentTypes(t)) {
      const m = lowerer.mapTypeOf(part);
      if (rooted(m)) return m;
    }
  }
  return null;
}

export function lowerCaughtTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    const local = lowerer.caughtLocalOf(a.expression);
    if (!local) continue;
    if (!ts.isStringLiteral(b)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "'typeof' catch-binding tests against non-literal strings",
      );
    }
    if (b.text === "string" || b.text === "number" || b.text === "boolean" || b.text === "object") {
      return {
        kind: "caughtTest",
        value: { kind: "varRef", localId: local.id, type: CAUGHT, loc },
        test: b.text,
        ...(negated ? { negated: true } : {}),
        type: BOOL,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      b,
      `'typeof' catch-binding tests against "${b.text}" (only "string"/"number"/"boolean"/"object" are supported)`,
    );
  }
  return null;
}

export function typeofAnswer(arm: IrType): string | null {
  switch (arm.kind) {
    case "f64":
      return "number";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "undefinedT":
      return "undefined";
    case "func":
      return "function";
    case "symbol":
      return "symbol";
    case "bigint":
      return "bigint";
    case "nullT":
    case "array":
    case "map":
    case "set":
    case "generator":
    case "regex":
    case "bytes":
    case "url":
    case "searchParams":
    case "stats":
    case "fileHandle":
    case "dir":
    case "spawnRes":
    case "child":
    case "netServer":
    case "netSocket":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "secureCtx":
    case "fsWatcher":
    case "cryptoHash":
    case "cryptoHmac":
    case "childStream":
    case "childWriter":
    case "procStream":
    case "object":
    case "record":
    case "promise":
      return "object";
    default:
      return null;
  }
}

/** ALIASED-TYPEOF narrowing (npm-static JS): the narrows a condition
 * PROVES about typeof-aliased operands when it evaluates to `polarity` —
 * ms's `var type = typeof val; if (type === 'string' && val.length > 0)`
 * shape, which tsc narrows only for CONST aliases. The walk follows the
 * checker's own condition structure: parens, `!`, `&&` under true, `||`
 * under false, and ===/!== leaves against string literals. A leaf
 * qualifies when the alias is a never-reassigned var/let/const local
 * initialized `typeof <param>`, the operand is a never-written
 * identifier PARAMETER of a function containing the test (so `typeof
 * val` is a post-entry constant and the alias can never be stale — the
 * condition itself still lowers as the plain string comparison), the
 * operand's type maps to a union whose arms all have static typeof
 * answers, and EXACTLY ONE arm answers the literal. The result feeds
 * lowerer.narrowingAliases: branch-scoped typeOf overrides, bridged by
 * maybeNarrow's ordinary unionNarrow. */
export function aliasTypeofNarrows(
  lowerer: Lowerer,
  cond: ts.Expression,
  polarity: boolean,
): { sym: ts.Symbol; tsArm: ts.Type }[] {
  const out: { sym: ts.Symbol; tsArm: ts.Type }[] = [];
  const strip = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const walk = (e0: ts.Expression, pol: boolean): void => {
    const e = strip(e0);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      walk(e.operand, !pol);
      return;
    }
    if (!ts.isBinaryExpression(e)) return;
    const k = e.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken && pol) {
      walk(e.left, true);
      walk(e.right, true);
      return;
    }
    if (k === ts.SyntaxKind.BarBarToken && !pol) {
      walk(e.left, false);
      walk(e.right, false);
      return;
    }
    const positive =
      (k === ts.SyntaxKind.EqualsEqualsEqualsToken && pol) ||
      (k === ts.SyntaxKind.ExclamationEqualsEqualsToken && !pol);
    if (!positive) return;
    const leaf = aliasTypeofArmOf(lowerer, e, strip);
    if (leaf) out.push(leaf);
  };
  if (implicitMonoFile(ts.getSourceFileOfNode(cond))) walk(cond, polarity);
  return out;
}

/** Visit both operand orders while keeping the sequence an array of pairs. */
export function operandPairs(expr: ts.BinaryExpression): [ts.Expression, ts.Expression][] {
  return [
    [expr.left, expr.right],
    [expr.right, expr.left],
  ];
}

/** One ===/!== leaf of aliasTypeofNarrows — the qualification battery. */
function aliasTypeofArmOf(
  lowerer: Lowerer,
  e: ts.BinaryExpression,
  strip: (x: ts.Expression) => ts.Expression,
): { sym: ts.Symbol; tsArm: ts.Type } | null {
  for (const [a0, b] of operandPairs(e)) {
    if (!ts.isStringLiteral(b)) continue;
    const a = strip(a0);
    if (!ts.isIdentifier(a)) continue;
    const aliasSym = lowerer.resolveValueSymbol(a);
    const aliasDecl = aliasSym ? aliasSym.valueDeclaration : undefined;
    if (
      !aliasSym ||
      !aliasDecl ||
      !ts.isVariableDeclaration(aliasDecl) ||
      aliasDecl.initializer === undefined
    )
      continue;
    const init = strip(aliasDecl.initializer);
    if (!ts.isTypeOfExpression(init)) continue;
    const opnd = strip(init.expression);
    if (!ts.isIdentifier(opnd)) continue;
    if (!bindingNeverReassigned(lowerer, aliasSym, aliasDecl)) continue;
    const valSym = lowerer.resolveValueSymbol(opnd);
    const valDecl = valSym ? valSym.valueDeclaration : undefined;
    if (!valSym || !valDecl) continue;
    // v1: identifier PARAMETERS only — initialized at function entry,
    // before any alias can capture their typeof.
    if (!ts.isParameter(valDecl) || !ts.isIdentifier(valDecl.name)) continue;
    if (!bindingNeverReassigned(lowerer, valSym, valDecl)) continue;
    const fn = valDecl.parent;
    if (fn === undefined || !(e.pos >= fn.pos && e.end <= fn.end)) continue;
    const valT = lowerer.typeOf(opnd); // override-aware: implicit bindings compose
    const mapped = lowerer.mapTypeOf(valT);
    if (mapped?.kind !== "union") continue;
    const def = lowerer.unions.get(mapped.unionId);
    const answers = def?.arms.map(typeofAnswer);
    if (!def || !answers || !answers.every((s): s is string => s !== null)) continue;
    const tags = answers.flatMap((s, i) => (s === b.text ? [i] : []));
    if (tags.length !== 1) continue;
    const arm = def.arms[tags[0]!]!;
    // The checker-side arm: the union part whose (widened) mapping IS
    // the proven IR arm — what typeOf answers inside the branch.
    const parts = valT.isUnionType() ? ts.constituentTypes(valT) : [valT];
    const tsArm = parts.find((p) => {
      const m = lowerer.mapTypeOf(lowerer.checker.getBaseTypeOfLiteralType(p));
      return m !== null && typeEquals(m, arm);
    });
    if (!tsArm) continue;
    return { sym: valSym, tsArm: lowerer.checker.getBaseTypeOfLiteralType(tsArm) };
  }
  return null;
}

/** The names Node's ES-module loader copies off a CommonJS module that a
 * bundler rewrite spells as accessors (npmStaticLexerVisibleNames), with
 * their getters in that order; empty for every other module. */
function lexerVisibleAccessors(dep: ts.SourceFile): ts.GetAccessorDeclaration[] {
  const names = npmStaticLexerVisibleNames(dep.fileName);
  if (names.length === 0) return [];
  let table: ts.ObjectLiteralExpression | null = null;
  for (const stmt of dep.statements.nodes) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind === "table" && cjsExportDiscardReason(stmt) === null) {
      table = cjsExportTargetLiteral(cjs.expr.right, dep);
    }
  }
  if (table === null) return [];
  const getters = new Map<string, ts.GetAccessorDeclaration>();
  for (const p of table.properties.nodes) {
    if (ts.isGetAccessorDeclaration(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
      getters.set(p.name.text, p);
  }
  return names.flatMap((n) => {
    const g = getters.get(n);
    return g === undefined ? [] : [g];
  });
}

/** The module global holding the value an accessor export had when an
 * ES-module importer first linked its CommonJS module. */
export function cjsAccessorSnapshotOf(
  lowerer: Lowerer,
  getter: ts.GetAccessorDeclaration,
): { id: string; type: IrType } | null {
  const hit = lowerer.cjsAccessorSnapshots.get(getter);
  if (hit !== undefined) return hit;
  if (!lexerVisibleAccessors(ts.getSourceFileOfNode(getter)).includes(getter)) return null;
  const call = cjsAccessorCall(lowerer, getter, locOf(getter));
  if (call === null) return null;
  const at = locOf(getter);
  const snapshot = {
    id: keyedHelperName(lowerer, "%g.cjsSnapshot", `${at.file}:${at.start}:${at.end}`),
    type: call.type,
  };
  lowerer.globalsList.push({
    id: snapshot.id,
    name: "%cjsSnapshot",
    type: call.type,
    mutable: true,
  });
  lowerer.cjsAccessorSnapshots.set(getter, snapshot);
  return snapshot;
}

/** Node's ES-module loader reads every lexer-visible export of a CommonJS
 * module once, when an importer first links it, and the import bindings
 * keep those values. For the accessors a bundler rewrite introduced, the
 * importer's link point runs each getter once, in the lexer's order, and
 * stores the values its bindings read. Empty when the module has none. */
export function cjsAccessorSnapshotStores(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  loc: SrcLoc,
): IrStmt[] {
  const getters = lexerVisibleAccessors(dep);
  if (getters.length === 0) return [];
  let readyId = lowerer.cjsSnapshotReady.get(dep);
  if (readyId === undefined) {
    readyId = keyedHelperName(lowerer, "%g.cjsSnapshotReady", dep.fileName);
    lowerer.globalsList.push({ id: readyId, name: "%cjsSnapshotReady", type: BOOL, mutable: true });
    lowerer.cjsSnapshotReady.set(dep, readyId);
  }
  const stores: IrStmt[] = [
    {
      kind: "assign",
      localId: readyId,
      value: { kind: "boolLit", value: true, type: BOOL, loc },
      loc,
    },
  ];
  for (const getter of getters) {
    const snapshot = cjsAccessorSnapshotOf(lowerer, getter);
    const call = cjsAccessorCall(lowerer, getter, loc);
    if (snapshot === null || call === null) return [];
    stores.push({ kind: "assign", localId: snapshot.id, value: call, loc });
  }
  return [
    {
      kind: "if",
      cond: {
        kind: "unary",
        op: "!",
        operand: { kind: "varRef", localId: readyId, type: BOOL, loc },
        type: BOOL,
        loc,
      },
      then: stores,
      else_: null,
      loc,
    },
  ];
}

/** The interned lifted-getter call both accessor-read paths share. */
export function cjsAccessorCall(
  lowerer: Lowerer,
  getter: ts.GetAccessorDeclaration,
  loc: SrcLoc,
): IrExpr | null {
  let fn = lowerer.cjsAccessorFns.get(getter);
  if (!fn) {
    const closure = lowerer.lowerLambda(getter);
    if (closure.kind !== "closure" || closure.type.kind !== "func") return null; // defensive
    fn = { fnName: closure.fnName, type: closure.type };
    lowerer.cjsAccessorFns.set(getter, fn);
  }
  // Lifted functions carry the closure ABI (an env parameter, even
  // capture-free) — the read calls through a zero-capture closure value,
  // the interned identity every lifted lambda uses.
  const closureVal: IrExpr = {
    kind: "closure",
    fnName: fn.fnName,
    captures: [],
    type: fn.type,
    loc,
  };
  return { kind: "callValue", callee: closureVal, args: [], type: fn.type.ret, loc };
}

/** A read of a catch binding — the caught analog of maybeNarrow. Where
 * tsc's control-flow narrowing has proven a supported test (`instanceof`
 * over a hierarchy class, `typeof` over a primitive), the read bridges
 * with a `caughtNarrow` extraction whose kind backends verify at run time,
 * exactly like unionNarrow. Every OTHER read is the narrowness fence:
 * the binding's payload is a typed exception snapshot, not a dyn, so
 * un-narrowed uses have nothing sound to lower to. */
export function caughtRead(
  lowerer: Lowerer,
  node: ts.Identifier,
  local: IrLocal,
  loc: SrcLoc,
): IrExpr {
  const ref: IrExpr = { kind: "varRef", localId: local.id, type: CAUGHT, loc };
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (
    narrowed &&
    (narrowed.kind === "f64" || narrowed.kind === "bool" || narrowed.kind === "string")
  ) {
    return { kind: "caughtNarrow", value: ref, type: narrowed, loc };
  }
  if (narrowed?.kind === "object") {
    const info = lowerer.classes.get(narrowed.className);
    if (info) {
      const value: IrExpr = { kind: "caughtNarrow", value: ref, type: narrowed, loc };
      if (lowerer.inHierarchy(info)) return value;
      return {
        kind: "ternary",
        cond: {
          kind: "caughtTest",
          value: ref,
          test: "instanceof",
          className: info.def.name,
          type: BOOL,
          loc,
        },
        then: value,
        else_: lowerer.coerceInto(
          node,
          { kind: "caughtToDyn", value: ref, type: DYN, loc },
          narrowed,
        ),
        type: narrowed,
        loc,
      };
    }
  }
  // Unnarrowed reads cross into unknown. The caught-value dispatch pass
  // retains known native class payloads through live identity capsules;
  // other payload kinds use the runtime's ordinary conversion.
  // `catch (e: any)` (or useUnknownInCatchVariables off) reads the same way.
  if (
    narrowed?.kind === "dyn" ||
    (narrowed === null && (lowerer.typeOf(node).flags & ts.TypeFlags.Any) !== 0)
  ) {
    return { kind: "caughtToDyn", value: ref, type: DYN, loc };
  }

  // A binding a user type predicate (or an assertion) narrowed to a
  // structural type (`isErrorLike(e)` → `{ message: string; … }`, an
  // intersection like `TypeError & { code: unknown }`): the thrown value is
  // still whatever was thrown, so it crosses as a checked-dynamic value and
  // each member read validates its own result, as JavaScript reads it.
  const checked = lowerer.typeOf(node);
  if (
    narrowed?.kind === "record" ||
    narrowed?.kind === "union" ||
    (narrowed === null && (checked.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !== 0)
  ) {
    return { kind: "caughtToDyn", value: ref, type: DYN, loc };
  }
  lowerer.unsupported("SC1063", node);
}

/** `String(e)` / `${e}` where e is a catch binding: JS's String() over
 * the exception snapshot (scr_caught_to_string) — the one un-narrowed
 * read with a sound rendering for every payload kind. Intercepts BEFORE
 * lowerExpr like the other caught lowerings (caughtRead would fence).
 * Null when the expression isn't a catch binding. */
export function caughtToString(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const local = lowerer.caughtLocalOf(node);
  if (!local) return null;
  const loc = locOf(node);
  return {
    kind: "toString",
    operand: { kind: "varRef", localId: local.id, type: CAUGHT, loc },
    type: STRING,
    loc,
  };
}

/** The catch-binding local an expression names, or null. The dedicated
 * lowerings (instanceof, typeof tests, rethrow) intercept on this BEFORE
 * lowering the operand — a raw lowerExpr of the identifier would hit
 * caughtRead's fence. */
export function caughtLocalOf(lowerer: Lowerer, node: ts.Expression): IrLocal | null {
  if (!ts.isIdentifier(node)) return null;
  const local = lowerer.resolveLocal(node);
  return local?.type.kind === "caught" ? local : null;
}

/** A regex literal `/ab+c/gi` → regexLit (fresh state per evaluation,
 * shared bytecode per (pattern, flags) pair). The TS parser has already syntax-checked the literal;
 * what remains here is the flag-alphabet fence (d is a
 * declared-valid TS flag outside this slice). Named capture groups
 * `(?<name>...)` and `\k<name>` backreferences compile — libregexp
 * executes them natively, replace templates resolve `$<name>` at
 * runtime, and `.groups` reads desugar at their access sites
 * (matchResultNamedGroupsOf). The engine validates the pattern itself
 * lazily at first use (SEMANTICS.md documents the divergence from
 * Node's parse-time SyntaxError). */
export function lowerRegexLiteral(lowerer: Lowerer, expr: ts.RegularExpressionLiteral): IrExpr {
  const text = expr.text;
  const lastSlash = text.lastIndexOf("/");
  const pattern = text.slice(1, lastSlash);
  const written = text.slice(lastSlash + 1);
  for (const f of written) {
    if (!"gimsuvy".includes(f)) {
      lowerer.unsupported(
        "SC1120",
        expr,
        f === "d" ? "the regex 'd' flag (match indices)" : `the regex '${f}' flag`,
      );
    }
  }
  // `flags`, `toString()` and inspection list the flags in getter order,
  // whatever order the literal spells them in.
  const flags = [..."gimsuvy"].filter((f) => written.includes(f)).join("");
  return { kind: "regexLit", pattern, flags, type: REGEX, loc: locOf(expr) };
}

/** The pattern's named capture groups, in source order: each `(?<name>`
 * with its 1-based capture index (numbered and named groups share the
 * numbering — the index IS the match slice's element position). Null
 * when the scan can't answer confidently (an unterminated construct, a
 * `\u`-escaped group name) — callers fence rather than guess. Duplicate
 * names (ES2025 — valid across alternatives) appear once per
 * declaration; consumers pick the participating occurrence. The scan
 * only needs to track escapes, character classes, and `(` kinds; tsc
 * has already syntax-checked the literal, so a malformed pattern here
 * answers null and the engine's lazy compile reports it. */
export function namedCaptureGroupsOfPattern(
  pattern: string,
): { name: string; index: number }[] | null {
  const groups: { name: string; index: number }[] = [];
  let captureIndex = 0;
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c !== "(") {
      i++;
      continue;
    }
    if (pattern[i + 1] !== "?") {
      captureIndex++;
      i++;
      continue;
    }
    // (?<name> captures; (?<= and (?<! are lookbehinds; every other
    // (?… form — (?:, (?=, (?!, modifier groups (?i: — is non-capturing.
    if (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!") {
      const gt = pattern.indexOf(">", i + 3);
      if (gt < 0) return null;
      const name = pattern.slice(i + 3, gt);
      if (name.includes("\\")) return null; // \u-escaped names: bytecode spells them decoded
      captureIndex++;
      groups.push({ name, index: captureIndex });
      i = gt + 1;
      continue;
    }
    i += 2;
  }
  return groups;
}

/** The statically-known regex PATTERN behind an expression: a regex
 * literal, a const local initialized with one (the crypto.js
 * `const regexp = /(?<m>\d+)/` shape), or `new RegExp("...")` over a
 * string literal (the cooked text IS the pattern). Null when the regex
 * only exists at runtime — .groups consumers fence there. */
export function staticRegexPatternOf(lowerer: Lowerer, e: ts.Expression): string | null {
  let expr = e;
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    break;
  }
  if (ts.isRegularExpressionLiteral(expr)) {
    const text = expr.text;
    return text.slice(1, text.lastIndexOf("/"));
  }
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "RegExp" &&
    lowerer.isStdlibGlobal(expr.expression, "RegExp") &&
    expr.arguments !== undefined &&
    expr.arguments.nodes.length >= 1 &&
    (ts.isStringLiteral(expr.arguments.nodes[0]!) ||
      ts.isNoSubstitutionTemplateLiteral(expr.arguments.nodes[0]!))
  ) {
    return (expr.arguments.nodes[0] as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
  }
  if (ts.isIdentifier(expr)) {
    const init = constInitializerOf(lowerer, expr);
    if (init !== null) return staticRegexPatternOf(lowerer, init);
  }
  return null;
}

/** The initializer behind a CONST identifier binding (a plain
 * VariableDeclaration under a const list) — the one-hop provenance step
 * the regex traces walk. Null for let/var (reassignable), params,
 * destructured bindings, and unresolvable names. */
export function constInitializerOf(lowerer: Lowerer, ident: ts.Identifier): ts.Expression | null {
  const sym = lowerer.resolveValueSymbol(ident);
  const decl = sym ? sym.valueDeclaration : undefined;
  if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined)
    return null;
  if (!ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0)
    return null;
  return decl.initializer;
}

/** Array methods whose result holds rows of the receiver. */
const MATCH_ROW_SUBSET_METHODS = new Set(["filter", "slice", "toReversed", "toSorted"]);

const MATCH_ROW_CALLBACK_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "some",
  "every",
  "flatMap",
]);

/** The regex behind `param` when it is the first parameter of an inline
 * callback whose rows come from a matchAll drain. */
export function matchAllCallbackRegexOf(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
): ts.Expression | null {
  const fn = param.parent;
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.nodes[0] !== param)
    return null;
  // A reassigned parameter can hold a row of another regex.
  if (ts.isIdentifier(param.name)) {
    const sym = lowerer.checker.getSymbolAtLocation(param.name);
    if (sym === undefined || !bindingNeverReassigned(lowerer, sym, param)) return null;
  }
  let site: ts.Node = fn;
  while (ts.isParenthesizedExpression(site.parent)) site = site.parent;
  const call = site.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  if (
    MATCH_ROW_CALLBACK_METHODS.has(method) &&
    call.arguments.nodes[0] === site &&
    lowerer.isStdlibMember(call.expression)
  )
    return matchAllRegexOf(lowerer, call.expression.expression);
  if (
    method === "from" &&
    call.arguments.nodes[1] === site &&
    lowerer.isStdlibGlobal(call.expression.expression, "Array") &&
    call.arguments.nodes[0] !== undefined
  )
    return matchAllRegexOf(lowerer, call.arguments.nodes[0]);
  return null;
}

/** The named groups of the rows `param` receives when it is the first
 * parameter of an inline matchAll callback (matchAllCallbackRegexOf). */
export function matchCallbackParamGroupsOf(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
): { name: string; index: number }[] | null {
  const reExpr = matchAllCallbackRegexOf(lowerer, param);
  const pattern = reExpr === null ? null : staticRegexPatternOf(lowerer, reExpr);
  return pattern === null ? null : namedCaptureGroupsOfPattern(pattern);
}

/** The regex argument of a (possibly const-stored) `s.matchAll(re)`. */
export function matchAllRegexOf(lowerer: Lowerer, e: ts.Expression): ts.Expression | null {
  let expr = e;
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    break;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "matchAll" &&
    expr.arguments.nodes.length === 1 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression))?.kind === "string" &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[0]!))?.kind === "regex"
  ) {
    return expr.arguments.nodes[0]!;
  }
  // The eager-spread spelling: `[...s.matchAll(re)]`.
  if (ts.isArrayLiteralExpression(expr) && expr.elements.nodes.length === 1) {
    const only = expr.elements.nodes[0]!;
    if (ts.isSpreadElement(only)) return matchAllRegexOf(lowerer, only.expression);
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    MATCH_ROW_SUBSET_METHODS.has(expr.expression.name.text) &&
    lowerer.isStdlibMember(expr.expression)
  ) {
    return matchAllRegexOf(lowerer, expr.expression.expression);
  }
  if (ts.isIdentifier(expr)) {
    const init = constInitializerOf(lowerer, expr);
    if (init !== null) return matchAllRegexOf(lowerer, init);
  }
  return null;
}

/** A number-keyed read in JavaScript on an array that may be undefined or
 * null outside an optional chain (`m[1]` on a `RegExpExecArray | null`
 * that an earlier statement ruled non-null without narrowing it): the
 * array arm is an ordinary JavaScript element read, so a hole, a present
 * undefined (a regex group that did not participate) or an invalid index
 * answers undefined, as lowerSafeIndexRead does for a plain array. The
 * unit arms keep the keyed read's answer. The receiver and key evaluate
 * once, in source order. Null when the union is not exactly one array arm
 * beside unit arms; optional-chain tails and TypeScript keep the keyed
 * read. */
export function lowerOptionalArrayIndexRead(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
  value: IrExpr,
  key: IrExpr,
): IrExpr | null {
  if (
    !isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
    expr.questionDotToken ||
    hasOptionalChainGuard(expr.expression)
  )
    return null;
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms) return null;
  const present = arms.filter((arm) => !isUnitType(arm));
  const arm = present[0];
  if (present.length !== 1 || arm?.kind !== "array" || arm.elem.kind === "void") return null;
  const tag = arms.indexOf(arm);
  const loc = locOf(expr);
  const stmts: IrStmt[] = [];
  const stable = (e: IrExpr, name: string): IrExpr => {
    if (e.kind === "varRef" || e.kind === "numLit") return e;
    const local = lowerer.declareHiddenLocal(name, e.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: e, loc });
    return varRef(local.id, e.type, loc);
  };
  if (lowerUnionKeyedRead(lowerer, expr, unionId, value, key, null) === null) return null;
  const recv = stable(value, "%indexReceiver");
  const index = stable(key, "%indexKey");
  const keyed = lowerUnionKeyedRead(lowerer, expr, unionId, recv, index, null)!;
  const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value: recv, type: arm, loc };
  const read = lowerSafeIndexRead(lowerer, narrowed, index, loc);
  if (read === null) return null;
  const result: IrExpr = {
    kind: "ternary",
    cond: { kind: "unionIsTag", unionId, tag, value: recv, negated: false, type: BOOL, loc },
    then: lowerer.coerceToExpected(read, keyed.type),
    else_: keyed,
    type: keyed.type,
    loc,
  };
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: keyed.type, loc };
}

/** A structural assertion can leave the value in its original class
 * representation, including an unchecked array read's undefined arm. Only
 * a single nominal payload has an unambiguous property layout. Validate
 * that payload before dispatching a field or accessor; an absent receiver
 * must never reach the backend as an object pointer. */
export function hasClassPayload(lowerer: Lowerer, type: IrType): boolean {
  return (
    type.kind === "object" ||
    (type.kind === "union" &&
      (lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === "object") ?? false))
  );
}

export function representedClassFieldTarget(
  lowerer: Lowerer,
  receiverNode: ts.Expression,
  fieldName: string,
  value: IrExpr,
): FieldTarget | null {
  const arms =
    value.type.kind === "union"
      ? lowerer.unions.get(value.type.unionId)?.arms.filter((arm) => !isUnitType(arm))
      : [value.type];
  const objectType = arms?.length === 1 ? arms[0] : null;
  return objectType?.kind === "object"
    ? classFieldTarget(lowerer, receiverNode, objectType, fieldName, value)
    : null;
}

/** A STATICALLY-RESOLVABLE unique-symbol key: an identifier whose value
 * resolves (imports included) to a module-level `const k = Symbol(...)`
 * with no description or a literal one. tsc types such a const `unique
 * symbol` — a compile-time identity — so a `this[k]` member is an
 * ordinary hidden field of the static layout, named in Node's inspect
 * spelling (`Symbol(limit)`). Everything else is null and keeps the
 * symbol fences: `symbol`-typed parameters and locals (identity known
 * only at runtime), `Symbol.for(...)` consts (two distinct consts can
 * alias ONE runtime symbol through the global registry — tsc still
 * types them as distinct unique symbols, so static slots would split
 * what JS shares), and computed descriptions (the field name below
 * must BE Node's, for inspect). */
export function uniqueSymbolKeyOf(
  lowerer: Lowerer,
  key: ts.Expression,
): { sym: ts.Symbol; fieldName: string } | null {
  if (!ts.isIdentifier(key)) return null;
  const t = lowerer.typeOf(key);
  // tsgo WIDENS a unique-symbol const's type to plain `symbol` through a
  // CJS require alias (5.9.3 kept `unique symbol` — the finding-5
  // family), so plain symbol passes this early filter too: every
  // correctness-bearing check is the DECLARATION-shape battery below
  // (module-level const initialized by a literal-description Symbol()),
  // which a runtime-identity symbol value can never satisfy.
  if (!(t.flags & (ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.ESSymbol))) return null;
  const sym = lowerer.resolveValueSymbol(key);
  const decl = sym ? sym.valueDeclaration : undefined;
  if (!sym || !decl || !ts.isVariableDeclaration(decl)) return null;
  if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
  // Module level only: a unique-symbol const inside a FUNCTION is a
  // fresh runtime identity per call — one static slot would conflate
  // what JS keeps distinct.
  if (!ts.isVariableStatement(decl.parent?.parent) || !ts.isSourceFile(decl.parent?.parent?.parent))
    return null;
  const init = decl.initializer;
  if (!init || !ts.isCallExpression(init) || init.questionDotToken) return null;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== "Symbol") return null;
  if (!lowerer.isStdlibSymbol(lowerer.checker.getSymbolAtLocation(init.expression))) return null;
  const arg =
    init.arguments.nodes.length === 0
      ? null
      : init.arguments.nodes.length === 1
        ? init.arguments.nodes[0]!
        : undefined;
  if (arg === undefined) return null;
  if (arg !== null && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))
    return null;
  // Symbol() and Symbol('') both print `Symbol()` — Node's toString.
  return { sym, fieldName: `Symbol(${arg?.text ?? ""})` };
}

/** The declared symbol-keyed field (class name / layout field / type)
 * `expr` resolves to, WITHOUT lowering the receiver — the routing test
 * for the wiring sites (statement dispatch must not emit anything when
 * it declines). Null off class receivers, for non-static keys, and for
 * keys no class on the chain declares. */
export function symbolFieldInfo(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): { className: string; field: string; fieldType: IrType } | null {
  if (lowerer.chainBlocked(expr)) return null;
  const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (receiverIr?.kind !== "object") return null;
  const info = lowerer.classes.get(receiverIr.className);
  if (!info) {
    lowerer.flushDeferredClass(receiverIr.className);
    return null;
  }
  const key = classSymbolKeyOf(lowerer, expr.argumentExpression);
  if (!key) return null;
  const field = info.symbolFields?.get(key.identity);
  if (field === undefined) return null;
  const fieldType = info.fields.get(field);
  if (!fieldType) return null;
  return { className: receiverIr.className, field, fieldType };
}

/** `obj[k]` as an assignable field target — the symbol-keyed twin of
 * fieldTarget's class branch (the receiver lowers here, exactly once). */
export function symbolFieldTarget(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): FieldTarget | null {
  const info = symbolFieldInfo(lowerer, expr);
  if (!info) return null;
  const obj = lowerer.lowerExpr(expr.expression);
  return {
    container: "class",
    obj,
    className: info.className,
    field: info.field,
    fieldType: info.fieldType,
  };
}

/** `return Promise.reject(reason)` in an async function: the checker's
 * context is the awaited return type (or its union with PromiseLike), not
 * a promise, but the async function adopts the returned promise, so the
 * promise of its own result type is the honest type. Null elsewhere. */
function asyncReturnPromise(lowerer: Lowerer, call: ts.CallExpression): IrType | null {
  if (lowerer.ctx.isAsync !== true || lowerer.ctx.generator) return null;
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  const returned =
    (ts.isReturnStatement(parent) && parent.expression === node) ||
    (ts.isArrowFunction(parent) && parent.body === node);
  if (!returned) return null;
  const ret = lowerer.ctx.returnType;
  if (ret.kind === "void" || ret.kind === "promise") return null;
  return { kind: "promise", inner: ret };
}

/** `Promise.reject(reason)` on THE Promise global: a pre-rejected
 * promise. The reason is pinned to the Error hierarchy (the executor
 * reject parameter's contract — rejection payloads share the
 * thrown-Error representation, so catch-side instanceof and the
 * uncaught printer keep working) and moves into the rejection slot
 * exactly as an executor's reject() would store it; the result enters
 * the unhandled ledger until something observes it, JS-exact. The
 * checker types the call Promise<never>, so the CONTEXT names the
 * result type (a declared return type, an annotated initializer, an
 * argument slot); without one no representable type exists and the
 * fence says so. Null for other members and non-Promise receivers. */
export function lowerPromiseRejectCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  if (lowerer.stdlibGlobalMember(access, "Promise") !== "reject") return null;
  const loc = locOf(call);
  if (call.arguments.nodes.length !== 1) {
    lowerer.noLowering(
      "Promise.reject with this argument count",
      call,
      "one Error reason is the supported form: Promise.reject(new Error(...))",
    );
  }
  const ctxT = lowerer.checker.getContextualType(call);
  const contextual = ctxT ? lowerer.mapTypeOf(ctxT) : null;
  // A maybe-promise context (`return Promise.reject(e)` from a function
  // returning `T | Promise<T>`) names its one promise arm.
  const maybePromise = contextual ? maybePromiseUnionOf(lowerer, contextual) : null;
  const type = maybePromise
    ? maybePromise.promise
    : (asyncReturnPromise(lowerer, call) ?? contextual);
  const reasonNode = call.arguments.nodes[0]!;
  // A CHECKED-DYNAMIC reason (`Promise.reject(value)` where value rode
  // an untyped binding — the tracingChannel suite's shape): the checked-dynamic tree
  // value IS the rejection payload (the thrown-dyn representation, so
  // identity survives to catch/unhandledRejection observers), and the
  // result is promise<dyn> when no context names a concrete one.
  const reason = lowerer.lowerExpr(reasonNode);
  if (
    reason.type.kind === "dyn" ||
    (lowerer.dynConvertible(reason.type) && reason.type.kind !== "object")
  ) {
    // The result only ever REJECTS, so the inner type is unobservable:
    // adopt the context's promise type when one names it, else the
    // checker's own Promise<never> reading (promise<void> — exactly the
    // Error-reason form below).
    const resultT: IrType = type?.kind === "promise" ? type : { kind: "promise", inner: VOID };
    return {
      kind: "intrinsic",
      name: "promise.reject",
      args: [lowerer.coerceInto(reasonNode, reason, DYN)],
      type: resultT,
      loc,
    };
  }
  // An Error reason with NO context-named promise type (a bare
  // top-level `Promise.reject(new Error())` — the unhandled-rejection
  // suite's shape): the result only ever rejects, so the checker's own
  // Promise<never> reading (promise<void>) is the honest type.
  const resultType: IrType = type?.kind === "promise" ? type : { kind: "promise", inner: VOID };
  if (type?.kind !== "promise" && !errorRootedObjectOf(lowerer, lowerer.typeOf(reasonNode))) {
    lowerer.noLowering(
      "Promise.reject outside a position that names a concrete promise type",
      call,
      "the checker types the call Promise<never> — a declared return type or an " +
        "annotation (const p: Promise<T> = Promise.reject(...)) names the result",
    );
  }
  if (!errorRootedObjectOf(lowerer, lowerer.typeOf(reasonNode))) {
    lowerer.unsupported(
      "SC1090",
      reasonNode,
      `Promise.reject reasons of type '${lowerer.checker.typeToString(lowerer.typeOf(reasonNode))}' ` +
        "(rejection payloads share the thrown-Error representation: pass an Error instance)",
    );
  }
  if (reason.type.kind !== "object") lowerer.badType(reasonNode, lowerer.typeOf(reasonNode));
  return { kind: "intrinsic", name: "promise.reject", args: [reason], type: resultType, loc };
}

/** `Promise.all([...])` where the literal's every entry is the SAME
 * promise type: the checker's tuple overload types the literal
 * [Promise<T>, Promise<T>] — a tuple RECORD, which the array path
 * rejects — but a homogeneous tuple of promises IS a Promise<T>[] in
 * every observable way, so the entries build the array directly and
 * the runtime's countdown combinator runs (the certs read-both-files
 * shape). Result Promise<T[]>; void inners collapse to Promise<void>
 * exactly like the array path. Null otherwise: heterogeneous literals
 * and non-literal arguments keep the array path and its fences. */
export function lowerPromiseAllTupleCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  if (lowerer.stdlibGlobalMember(access, "Promise") !== "all") return null;
  const argNode = call.arguments.nodes.length === 1 ? call.arguments.nodes[0]! : null;
  if (
    !argNode ||
    !ts.isArrayLiteralExpression(argNode) ||
    argNode.elements.nodes.some(ts.isSpreadElement) ||
    argNode.elements.nodes.length === 0
  ) {
    return null;
  }
  // The claim test runs on checker types only (no side effects): every
  // element the same representable promise type.
  const mapped = argNode.elements.nodes.map((el) => lowerer.mapTypeOf(lowerer.typeOf(el)));
  const first = mapped[0];
  if (first?.kind !== "promise") return null;
  if (!mapped.every((m) => m?.kind === "promise" && typeEquals(m.inner, first.inner))) {
    return null;
  }
  const loc = locOf(call);
  const inner = first.inner;
  const entryT: IrType = { kind: "promise", inner };
  const elems = argNode.elements.nodes.map((el) => lowerer.lowerExprExpecting(el, entryT));
  const entries: IrExpr = { kind: "arrayLit", elems, type: arrayOf(entryT), loc };
  const type: IrType =
    inner.kind === "void"
      ? { kind: "promise", inner: VOID }
      : { kind: "promise", inner: arrayOf(inner) };
  return { kind: "intrinsic", name: "promise.all", args: [entries], type, loc };
}

/** `obj.f op= e` (and `obj.f++` with rhs null ≡ 1) — the element spelling
 * `obj[k] op= e` included when k is a declared symbol-keyed field.
 * Save the receiver and old value before the RHS, then write through
 * that same receiver even if the RHS replaces its original binding. */
export function lowerFieldCompound(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  op: CompoundOp,
  rhsNode: ts.Expression | null,
  loc: SrcLoc,
): IrStmt {
  return {
    kind: "exprStmt",
    expr: lowerFieldCompoundValue(lowerer, access, op, rhsNode, loc),
    loc,
  };
}

/** The primitive-constructor closure (`String`/`Number`/`Boolean` as a
 * VALUE): interns one synthesized module function per constructor/ABI and
 * returns the zero-capture closure over it. Typed sources use the mapped
 * `(value: string) => primitive` signature; a recognized JavaScript
 * concise-arrow selector (`() => String`, the picocolors fallback) takes
 * dyn so its ordinary coercion signature survives inference residue, and a
 * boxed constructor value takes dyn too (coerceToExpected). The dyn bodies
 * run what the constructors do for any argument: String() (a symbol's
 * description form included), ToNumber and ToBoolean, with object hooks.
 * Interning makes every reference under one ABI the SAME immortal closure,
 * so `opt.type === String` compares like JS function identity. */
export function primitiveCtorClosure(
  lowerer: Lowerer,
  name: "String" | "Number" | "Boolean" | "BigInt",
  loc: SrcLoc,
  dynamicInput: boolean,
): IrExpr {
  const ret =
    name === "String" ? STRING : name === "Number" ? F64 : name === "BigInt" ? BIGINT_T : BOOL;
  const input = dynamicInput || name === "BigInt" ? DYN : STRING;
  const fnT = funcOf([input], ret);
  const key = `${name}:${dynamicInput ? "dyn" : "string"}`;
  let fnName = lowerer.primitiveCtorFns.get(key);
  if (!fnName) {
    fnName = `%builtin.${name}${dynamicInput ? ".dyn" : ""}`;
    lowerer.primitiveCtorFns.set(key, fnName);
    const v: IrExpr = { kind: "varRef", localId: "v.0", type: input, loc };
    const value: IrExpr = dynamicInput
      ? name === "BigInt"
        ? { kind: "libCall", fn: "dyn.bigintConstructor", args: [v], type: BIGINT_T, loc }
        : name === "String"
          ? { kind: "libCall", fn: "dyn.stringConstructor", args: [v], type: STRING, loc }
          : name === "Number"
            ? { kind: "libCall", fn: "dyn.numberConstructor", args: [v], type: F64, loc }
            : { kind: "dynTest", test: "truthy", value: v, type: BOOL, loc }
      : name === "BigInt"
        ? { kind: "libCall", fn: "dyn.bigintConstructor", args: [v], type: BIGINT_T, loc }
        : name === "String"
          ? v
          : name === "Number"
            ? { kind: "libCall", fn: "num.fromString", args: [v], type: F64, loc }
            : {
                kind: "strEq",
                negated: true,
                left: v,
                right: { kind: "strLit", value: "", type: STRING, loc },
                type: BOOL,
                loc,
              };
    const fn: IrFunction = {
      name: fnName,
      params: [{ localId: "v.0", name: "value", type: input }],
      returnType: ret,
      locals: [{ id: "v.0", name: "value", type: input, mutable: false }],
      body: [{ kind: "return", value, loc }],
      loc,
    };
    lowerer.liftedFns.push(fn);
  }
  return { kind: "closure", fnName, captures: [], type: fnT, loc };
}
