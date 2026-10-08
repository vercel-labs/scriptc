import { isOptionalProcessStreamProperty } from "./builtins/process.js";
import { lowerWorkerMetadata } from "./builtins/workers.js";
import {
  dynUndefinedExpr,
  nodeThrowExpr,
  countedFor,
  numLit,
  strLit,
  varRef,
} from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";
import { SYMBOL_T } from "../../ir/ir.js";
import { literalValues } from "../literal-values.js";
import { literalUnionArm } from "../union-discriminants.js";
/* Expression lowering: the expression dispatch (lowerExpr), literals
 * (array/object/regex/template), operators (binary incl. compound targets,
 * unary, instanceof, caught-typeof tests), union narrowing and unit
 * comparisons, nullish coalescing and optional chains, conditions and
 * ToBoolean/ToString coercion helpers, and field/element reads and writes
 * (FieldTarget). */
import * as ts from "../ts7/adapter.js";
import { dirname } from "node:path";
import * as posix from "node:path/posix";
import type { Lowerer } from "./lowerer.js";
import { checkedClassAssertion } from "./class-assertions.js";
import { narrowClassUnion, narrowStoredClassValue } from "./class-unions.js";
import { lowerUnionFieldWrite } from "./expressions/union-field-write.js";
import { captureContextArguments } from "./function-context.js";
import { OBJECT_CALLABLE_VALUES } from "./surfaces.js";
import { wasiGuestPath } from "../../wasi-paths.js";
import {
  BIGINT_T,
  BYTES_ELEMENT_NAME,
  BOOL,
  CAUGHT,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  type IrBytesElem,
  type IrExpr,
  type IrFunction,
  type IrJsOp,
  type IrLocal,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  JSVAL,
  NULL_T,
  REF_TRUTHY_KINDS,
  REGEX,
  RUNTIME_ERROR_CLASSES,
  SEARCH_PARAMS_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  canAdaptDynFuncTo,
  canDynCheckTo,
  canBoxFuncIntoDyn,
  funcOf,
  isDynTypedRefType,
  isSupportedArrayElem,
  isUnitType,
  jsOpResultKind,
  shapeHasAccessorSlots,
  typeEquals,
  typeKey,
  unionContainerArmsOk,
} from "../../ir/ir.js";
import {
  cjsClassExprWholeExportOf,
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  isCjsExportTableLiteral,
  isCjsJsFile,
  isJsSourceFile,
  isModuleExportsAccess,
  isNodeEsmFile,
  locOf,
} from "../program.js";
import {
  ARRAY_METHODS,
  builtinConstLit,
  builtinFenceHintOf,
  builtinModuleConstOf,
  builtinModulesArrayLit,
  builtinModuleFnOf,
  COMPOUND_ASSIGN_OPS,
  type CompoundOp,
  ISLAND_SURFACE,
  isChildSurfaceMember,
  MAP_METHODS,
  NARROW_FIRST,
  SET_METHODS,
  STRING_INDEX_METHODS,
  STR_METHODS,
  UNSUPPORTED_EXPR,
  sideEffectFreeOptionValue,
  stdlibGlobalNameOf,
} from "./surfaces.js";
import {
  UNSUPPORTED,
  blockedBindingUseDiag,
  requiresDynamicPackageDiag,
  unsupportedDiag,
} from "../../diagnostics/diagnostic.js";
import { PoisonError, dynFallbackType, jsFuncNameOf, neverTaintedJsType, own } from "./lowerer.js";
import { lowerCollectionSpread } from "./containers/collection-methods.js";
import {
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
  lowerSafeIndexRead,
  tryLowerNumericIndexRead,
} from "./array-values.js";
import { strCharsCall } from "./containers/array-construction.js";
import { lowerOptionalStringIndex } from "./string-index.js";
import { tryLowerIndexedComparison } from "./indexed-comparison.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { unsupportedModuleFeatureOf } from "../builtin-modules.js";
import { fenceEnumObjectValue, lowerEnumAccess } from "./lower-enums.js";
import {
  ambientNsRootOf,
  ambientUndefReadType,
  ambientUndefVarRootOf,
  ambientUndefinedFnSymbolOf,
  contextualUndefReadType,
  fenceEarlyAliasUse,
  fenceEarlyNsMemberRef,
  lowerNsIdentifierValue,
  nsMemberIdentOf,
  nsUndefRead,
  nsWritableTarget,
} from "./lower-namespaces.js";
import { expandoMemberRead, expandoWritableTarget } from "./lower-expando.js";
import { lowerSocketInstanceOf, lowerTlsRootCertificates } from "./lower-server.js";
import {
  findGenericMethodOn,
  lowerStaticFieldRead,
  staticFieldWriteTarget,
  storedClassValueType,
} from "./lower-classes.js";
import { hasRuntimeStatics } from "./class-runtime-statics.js";
import { bindingNeverReassigned, nullishGenericBindingUnitOf } from "./binding-analysis.js";
import { funcTypeFromParamShapes } from "./call-signatures.js";
import {
  implicitMonoFile,
  objLitGenericFnInfoOf,
  objLitGenericFnNodeOf,
  requireObjLitGenericReceiver,
} from "./generic-functions.js";
import { lowerTaggedTemplate } from "./lower-calls.js";
import { mixinFnOfCallee } from "./lower-mixins.js";
import {
  isConstAssertionTypeNode,
  isGenericCallableMemberType,
  isParseArgsDynTypeName,
  underConstAssertion,
  unitOnlyUnion,
  withUnitArm,
} from "../type-mapper.js";
import { lowerYield } from "./lower-generators.js";
import { errorPropertyRead, errorPropertyWrite, errorToStringCall } from "./error-methods.js";
import { lowerStreamProperty, lowerStreamStateProperty, streamSidesOf } from "./lower-stream.js";
import { unionWideningTags } from "../../ir/analysis.js";
import {
  isSafeToDiscard,
  isSafeToMoveConditionEarlier,
  isSafeToRepeat,
} from "./expressions/evaluation-safety.js";
import { globalSymbolKey } from "./expressions/global-symbols.js";
import { lowerShortCircuitAssignment } from "./expressions/nullish-assignment.js";
import {
  hasOptionalChainGuard,
  isOptionalChainTail,
  isRequireMainFilename,
} from "./expressions/optional-chains.js";
import { conditionalSpreadOf, foldedStringKeyOf } from "./expressions/object-literals.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import {
  fenceNodeModuleMutation,
  isNodeModuleValue,
  lowerNodeModuleIdentifier,
  lowerNodeModuleProperty,
  lowerRequireCacheElement,
  lowerRequireCacheHas,
  lowerRequireMainProperty,
} from "./lower-node-module.js";
import { lowerAbstractEquality } from "./abstract-equality.js";
import {
  coerceStringSearchValue,
  defaultAfterUndefined,
  lowerStaticallyUndefinedArgument,
} from "./optional-arguments.js";
import { recordTextCodecClass } from "../../ir/ir.js";
import { classSymbolKeyOf } from "./symbol-fields.js";
import { lowerClassMethodValue } from "./class-method-values.js";
import { classInstanceOf } from "./class-dynamic-dispatch.js";
import { lowerGlobalValue } from "./lower-global-value.js";
import { importMetaField, isImportMeta } from "./import-meta.js";
import {
  lowerClassPrototypeData,
  lowerClassPrototypeComputedAssignment,
} from "./class-prototypes.js";
import { isClassCallback } from "./class-callbacks.js";
import {
  builtinPrototypeMethod,
  lowerArrayIsArrayValue,
  lowerCheckedPredicateValue,
  lowerNumberParserValue,
  lowerObjectAssignValue,
  lowerStringCodesValue,
} from "./lower-builtin-values.js";
import { lowerArrayFromValue } from "./containers/array-construction.js";
import { lowerPerfHooksTypeof } from "./builtins/performance.js";
import { lowerUrlAssignment } from "./builtins/url.js";
import { jsBindingHasOpenWrites } from "./lower-stmts.js";
import { checkedClassInstanceOf } from "./class-construction.js";
import { lowerModuleNamespaceElement } from "./module-namespace-elements.js";

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
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const end = node.getEnd();
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

/** True when a property access names an ABSTRACT property declaration
 * (`abstract p: number` — a PropertyDeclaration, not an accessor).
 * These uses need concrete property dispatch because the base has no slot. */
export function abstractPropertyDeclOf(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  const sym = lowerer.checker.getSymbolAtLocation(expr.name);
  if (!sym) return false;
  return lowerer.checker
    .declarationsOf(sym)
    .some(
      (d) =>
        ts.isPropertyDeclaration(d) &&
        ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true,
    );
}

/** A field declared by node:util's parseArgs checked-dynamic type family.
 * Narrowing a ParseArgsToken exposes one anonymous union arm, so its alias
 * identity no longer reaches mapType; declaration ancestry is the stable
 * provenance check. */
function isParseArgsDynProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  const sym = lowerer.checker.getSymbolAtLocation(expr.name);
  if (!sym) return false;
  return lowerer.checker.declarationsOf(sym).some((d) => {
    if (!lowerer.isStdlibFile(d.getSourceFile())) return false;
    let inParseArgsType = false;
    for (let node: ts.Node | undefined = d.parent; node; node = node.parent) {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        isParseArgsDynTypeName(node.name.text)
      ) {
        inParseArgsType = true;
      }
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return inParseArgsType && (node.name.text === "util" || node.name.text === "node:util");
      }
    }
    return false;
  });
}

function isStatFsDynProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  if (
    !["type", "bsize", "blocks", "bfree", "bavail", "files", "ffree", "bigint"].includes(
      expr.name.text,
    )
  )
    return false;
  const symbol = lowerer.checker.getSymbolAtLocation(expr.name);
  return (
    !!symbol &&
    lowerer.checker.declarationsOf(symbol).some((declaration) => {
      if (!lowerer.isStdlibFile(declaration.getSourceFile())) return false;
      const parent = declaration.parent;
      if (!ts.isInterfaceDeclaration(parent)) return false;
      if (
        expr.name.text === "bigint"
          ? parent.name.text !== "StatFsOptions"
          : !["StatsFsBase", "StatsFs", "BigIntStatsFs"].includes(parent.name.text)
      )
        return false;
      for (let node: ts.Node | undefined = parent.parent; node; node = node.parent) {
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
          return node.name.text === "fs" || node.name.text === "node:fs";
      }
      return false;
    })
  );
}

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
    return lowerExprInner(lowerer, expr);
  } finally {
    lowerExprDepth--;
  }
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
    const spelled = expr.getText().replace(/_/g, "");
    if (/^\d+$/.test(spelled) && String(Number(spelled)) !== spelled) {
      return { kind: "numLit", value: Number(spelled), spelling: spelled, type: F64, loc };
    }
    return { kind: "numLit", value, type: F64, loc };
  }
  if (ts.isBigIntLiteral(expr)) {
    const spelling = expr.getText().replace(/_/g, "").replace(/n$/i, "");
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
      for (const span of t.templateSpans) {
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
    const inner = lowerer.lowerExpr(expr.expression);
    if (inner.type.kind === "union") {
      const use = runtimeOptionalUseOf(expr);
      if (runtimeOptionalAssertionErases(lowerer, expr, inner, use)) return inner;
      const target = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (target && target.kind !== "union" && !typeEquals(target, inner.type)) {
        const helper = lowerer.narrowedArmHelper(inner.type.unionId, target, loc);
        if (helper) {
          return { kind: "call", callee: helper, args: [inner], type: target, loc };
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
  // Literals in an `any`-typed slot (the CONTEXTUAL type is what the
  // record/array lowerings would consult) build natively in the island:
  // each value lowers statically and marshals in. An UNMAPPABLE
  // contextual type falls back to the literal's own type, exactly like
  // lowerObjectLiteral's fallback — a package call's options parameter
  // is often an unmappable intersection while the literal's own type
  // absorbs to jsval (a bare-jsval field, an npm-typed member).
  if (
    (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) &&
    (() => {
      const ctxTs = lowerer.checker.getContextualType(expr);
      const mapped =
        (ctxTs ? lowerer.mapTypeOf(ctxTs) : null) ?? lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (mapped?.kind !== "jsval") return false;
      // The tsgo readonly-[] panic repair (see lowerArrayLiteral): an
      // EMPTY array literal under a const assertion is the empty tuple —
      // its `any` answer is a panicked query, not an island slot.
      if (
        ts.isArrayLiteralExpression(expr) &&
        expr.elements.length === 0 &&
        underConstAssertion(expr)
      ) {
        return false;
      }
      // A JS variable INITIALIZER whose BINDING registered as a
      // checked-dynamic module global (the typedef-annotated
      // doc-builder consts whose JSDoc types degraded — DYN slots):
      // the island build could never land (no engine→dyn crossing
      // exists), so the literal takes its own world's path instead —
      // the dyn literal, or a static record the slot converts.
      if (
        isJsSourceFile(expr.getSourceFile()) &&
        ts.isVariableDeclaration(expr.parent) &&
        expr.parent.initializer === expr &&
        ts.isIdentifier(expr.parent.name)
      ) {
        const bindSym = lowerer.checker.getSymbolAtLocation(expr.parent.name);
        const g = bindSym ? lowerer.globalsBySymbol.get(bindSym) : undefined;
        if (g?.type.kind === "dyn") return false;
      }
      // A PROJECT-DECLARED contextual type that only ABSORBED to the
      // island (a doc-builder typedef whose field's JSDoc type
      // reference degraded to checker-`any` — the tsgo multi-file
      // value-as-type residue) is not an npm slot: when the literal's
      // OWN type maps statically, it builds that way — the binding's
      // checked-dynamic slot takes the dyn conversion. Genuinely
      // island slots (npm .d.ts provenance, plain `any`) keep the
      // native build.
      if (ctxTs !== undefined && (ctxTs.flags & ts.TypeFlags.Any) === 0) {
        // Intersection/tuple typedefs (`Line & {readonly soft: true}`)
        // carry provenance on the ALIAS symbol.
        const sym = ctxTs.getSymbol() ?? ctxTs.getAliasSymbol();
        const decls = sym ? lowerer.checker.declarationsOf(sym) : [];
        const projectDeclared =
          decls.length > 0 &&
          decls.every((d) => {
            const sf = d.getSourceFile();
            return !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/");
          });
        if (projectDeclared) {
          // A spread already stored in the island must copy there too.
          // Later overrides can make the literal's own inferred shape
          // appear static without making that source a native record.
          if (
            ts.isObjectLiteralExpression(expr) &&
            expr.properties.some(
              (p) =>
                ts.isSpreadAssignment(p) &&
                lowerer.mapTypeOf(lowerer.typeOf(p.expression))?.kind === "jsval",
            )
          ) {
            return true;
          }
          const own = lowerer.mapTypeOf(lowerer.typeOf(expr));
          if (own?.kind === "record" || own?.kind === "array") return false;
        }
      }
      return true;
    })()
  ) {
    if (ts.isObjectLiteralExpression(expr)) {
      // Two engine literals when a CONDITIONAL spread participates
      // (`{ a, ...(c ? { k: v } : {}) }` — the optional-key idiom): the
      // whole literal becomes `c ? objLit(with) : objLit(without)`. The
      // shared properties' nodes ride BOTH arms (exactly one arm
      // evaluates, so each property still evaluates once); the reorder
      // of `c` before earlier properties is unobservable because the
      // condition must be a side-effect-free read. The spread arm's keys
      // are truly ABSENT when the empty arm is taken — engine-exact
      // (`"k" in o` is false), which the static record path can't say.
      const argsWithout: IrExpr[] = [];
      const argsWith: IrExpr[] = [];
      const getters: { name: string; fn: IrExpr; loc: SrcLoc }[] = [];
      let spread: { cond: IrExpr; whenTrue: boolean } | null = null;
      // A MEMBER a JS file cannot lower or marshal: defer like a
      // statement fence, shaped by what the member IS. A FUNCTION-shaped
      // member (a generic function as a value, a signature with
      // checked-dynamic parameters — the doc-builder public aggregate's
      // degraded pieces) becomes a host closure that THROWS the captured
      // diagnostic when invoked — building the aggregate compiles and
      // only a CALL through the island stops the run. A DATA-shaped
      // member must NOT become a callable (the retired fence box's
      // silent wrong answers: typeof said "function", downstream errors
      // blamed the wrong thing — the withPlugins `plugins:` slot), so it
      // defines through the engine's getter machinery instead: READING
      // the member throws the diagnostic — the honest granularity, since
      // using the value is exactly what cannot be answered. `getterName`
      // null keeps the closure shape (function-shaped members, and the
      // conditional-spread arms where getters cannot combine).
      const islandMemberFence = (
        diagsBefore: number,
        err: PoisonError,
        valueNode: ts.Node,
        getterName: string | null = null,
      ): IrExpr | null => {
        if (!isJsSourceFile(expr.getSourceFile())) throw err;
        const fence = lowerer.deferToRuntimeFence(diagsBefore, valueNode, {
          kind: "closure",
          name: () => `%fn${lowerer.lambdaCounter++}_islfence`,
          returnType: VOID,
          type: { kind: "func", params: [], ret: VOID },
        });
        if (!fence) throw err;
        if (getterName !== null) {
          getters.push({
            name: getterName,
            fn: lowerer.jsvalIn(fence, valueNode),
            loc: locOf(valueNode),
          });
          return null;
        }
        return lowerer.jsvalIn(fence, valueNode);
      };
      // The member's SHAPE decides the fence's granularity: syntactic
      // functions and checker-callable values keep the call-time
      // closure; everything else (call results, awaits, data reads —
      // the withPlugins `plugins:` shape) fences at the READ.
      const funcShapedMember = (p: ts.ObjectLiteralElementLike): boolean => {
        if (ts.isMethodDeclaration(p)) return true;
        const src: ts.Node | null = ts.isPropertyAssignment(p)
          ? p.initializer
          : ts.isShorthandPropertyAssignment(p)
            ? p.name
            : null;
        if (!src || !ts.isExpression(src)) return true; // unknown form: keep the closure shape
        let inner: ts.Expression = src;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return true;
        return lowerer.checker.getCallSignatures(lowerer.typeOf(src)).length > 0;
      };
      const pushProp = (
        name: ts.Identifier | ts.StringLiteral,
        value: IrExpr,
        valueNode: ts.Node,
        into: IrExpr[][],
      ): void => {
        const diagsBefore = lowerer.diags.length;
        let marshaled: IrExpr;
        try {
          marshaled = lowerer.jsvalIn(value, valueNode);
        } catch (err) {
          // A value that LOWERED but cannot cross (a promise, a class
          // instance): func-typed values keep the call-time closure;
          // data-shaped values fence at the read (the getter), unless a
          // conditional spread owns the literal (getters cannot combine).
          if (!(err instanceof PoisonError)) throw err;
          const asGetter = value.type.kind !== "func" && spread === null;
          const fence = islandMemberFence(diagsBefore, err, valueNode, asGetter ? name.text : null);
          if (fence === null) return; // registered as a fence getter — no data property
          marshaled = fence;
        }
        for (const args of into) {
          args.push({
            kind: "jsMarshal",
            value: { kind: "strLit", value: name.text, type: STRING, loc: locOf(name) },
            type: JSVAL,
            loc: locOf(name),
          });
          args.push(marshaled);
        }
      };
      const spreadSrcs: IrExpr[] = [];
      let sawPlainProp = false;
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const cs = conditionalSpreadOf(prop.expression);
          if (cs && cs !== "unsupported" && !spread) {
            if (spreadSrcs.length > 0) {
              lowerer.unsupported(
                "SC1090",
                prop,
                "a conditional spread mixed with plain spreads in an 'any'-typed object literal",
              );
            }
            const cond = lowerer.lowerCondition(cs.cond);
            if (!isSafeToMoveConditionEarlier(cond)) {
              lowerer.unsupported(
                "SC1090",
                prop,
                "conditional spreads with effectful conditions in an 'any'-typed object literal (bind the condition to a const first)",
              );
            }
            spread = { cond, whenTrue: cs.whenTrue };
            for (const p of cs.props) {
              const v = ts.isPropertyAssignment(p)
                ? lowerer.lowerExpr(p.initializer)
                : lowerer.lowerShorthandValue(p);
              pushProp(p.name, v, p, [argsWith]);
            }
            continue;
          }
          // A PLAIN spread (`{ ...options, plugins }` — the withPlugins
          // argument-rebuild shape): the source copies into the fresh
          // engine object through the spec's CopyDataProperties (the
          // objSpread op). Spreads must precede explicit properties
          // (the composition applies explicit keys AFTER the copies —
          // JS's later-wins — which a spread after them would invert);
          // mixing with a conditional spread keeps the fence.
          if (cs === undefined || cs === null) {
            if (sawPlainProp || spread) {
              lowerer.unsupported(
                "SC1090",
                prop,
                "object spread after explicit properties (or mixed with a conditional spread) in an 'any'-typed object literal — spreads must come first",
              );
            }
            spreadSrcs.push(lowerer.jsvalIn(lowerer.lowerExpr(prop.expression), prop.expression));
            continue;
          }
          lowerer.unsupported(
            "SC1090",
            prop,
            "this spread form in an 'any'-typed object literal (one `...(c ? { k: v } : {})` conditional spread is supported — bind other shapes to a const and set keys explicitly)",
          );
        }
        sawPlainProp = true;
        // `name: value`, the shorthand `{ name }` (the value is the
        // identifier itself, resolved through the shorthand VALUE symbol
        // like the static record path), and METHODS — `{ load() {...} }`
        // is a function expression under a shorthand name, marshaled
        // like any closure value (this-uses keep the static path's
        // rejection); everything else keeps the fence. Identifier and
        // string-literal keys — engine property names have no
        // identifier restriction ("content-type").
        const name = prop.name;
        // A GET accessor (`get root() { return ROOT_INDENT; }` — the
        // doc-printer's self-referential root-indent shape): the body
        // lowers as a zero-param closure marshaled into the engine, and
        // the property defines through the engine's own getter
        // machinery AFTER the literal builds (the defineGetter op) —
        // reads through the handle invoke it natively. `this` in the
        // body keeps the object-method rejection; setters stay fenced.
        if (
          ts.isGetAccessorDeclaration(prop) &&
          prop.body &&
          name &&
          (ts.isIdentifier(name) || ts.isStringLiteral(name))
        ) {
          lowerer.rejectThisInObjectMethod(prop.body);
          getters.push({
            name: name.text,
            fn: lowerer.jsvalIn(lowerer.lowerLambda(prop), prop),
            loc: locOf(prop),
          });
          continue;
        }
        // A member VALUE that cannot lower at all (a generic function
        // referenced as a value — the aggregate's `align`): the same
        // call-time fence deferral pushProp applies to marshal failures.
        let value: IrExpr | null = null;
        const valueDiagsBefore = lowerer.diags.length;
        try {
          value = ts.isPropertyAssignment(prop)
            ? lowerer.lowerExpr(prop.initializer)
            : ts.isShorthandPropertyAssignment(prop)
              ? lowerer.lowerShorthandValue(prop)
              : ts.isMethodDeclaration(prop) && prop.body
                ? (lowerer.rejectThisInObjectMethod(prop.body), lowerer.lowerLambda(prop))
                : null;
        } catch (err) {
          if (!(err instanceof PoisonError)) throw err;
          const nameText =
            name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
          const asGetter = nameText !== null && spread === null && !funcShapedMember(prop);
          value = islandMemberFence(valueDiagsBefore, err, prop, asGetter ? nameText : null);
          if (value === null) continue; // registered as a fence getter — no data property
        }
        if (value && name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
          pushProp(name, value, prop, [argsWithout, argsWith]);
        } else {
          lowerer.unsupported(
            "SC1090",
            prop,
            "this property form in an 'any'-typed object literal (only `name: value`, shorthand names, methods, and get accessors are supported)",
          );
        }
      }
      const withGetters = (obj: IrExpr): IrExpr =>
        getters.reduce<IrExpr>(
          (acc, g) => ({
            kind: "jsOp",
            op: "defineGetter",
            args: [
              acc,
              {
                kind: "jsMarshal",
                value: { kind: "strLit", value: g.name, type: STRING, loc: g.loc },
                type: JSVAL,
                loc: g.loc,
              },
              g.fn,
            ],
            type: JSVAL,
            loc: g.loc,
          }),
          obj,
        );
      if (!spread) {
        if (spreadSrcs.length === 0) {
          return withGetters({ kind: "jsOp", op: "objLit", args: argsWithout, type: JSVAL, loc });
        }
        // Plain spreads compose left to right onto a fresh object, the
        // explicit properties merging LAST (JS's later-wins): spread
        // sources evaluate before later property values by nesting
        // order, exactly the source order.
        let acc: IrExpr = { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc };
        for (const src of spreadSrcs) {
          acc = { kind: "jsOp", op: "objSpread", args: [acc, src], type: JSVAL, loc };
        }
        if (argsWithout.length > 0) {
          acc = {
            kind: "jsOp",
            op: "objSpread",
            args: [acc, { kind: "jsOp", op: "objLit", args: argsWithout, type: JSVAL, loc }],
            type: JSVAL,
            loc,
          };
        }
        return withGetters(acc);
      }
      if (getters.length > 0) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "get accessors combined with conditional spreads in an 'any'-typed object literal",
        );
      }
      const withLit: IrExpr = { kind: "jsOp", op: "objLit", args: argsWith, type: JSVAL, loc };
      const withoutLit: IrExpr = {
        kind: "jsOp",
        op: "objLit",
        args: argsWithout,
        type: JSVAL,
        loc,
      };
      return {
        kind: "ternary",
        cond: spread.cond,
        then: spread.whenTrue ? withLit : withoutLit,
        else_: spread.whenTrue ? withoutLit : withLit,
        type: JSVAL,
        loc,
      };
    }
    const args = expr.elements.map((el) => lowerer.jsvalIn(lowerer.lowerExpr(el), el));
    return { kind: "jsOp", op: "arrLit", args, type: JSVAL, loc };
  }
  if (ts.isTypeOfExpression(expr)) {
    if (lowerer.isStdlibGlobal(expr.expression, "process"))
      return { kind: "strLit", value: "object", type: STRING, loc };
    if (lowerer.isStdlibGlobal(expr.expression, "fetch"))
      return { kind: "strLit", value: "function", type: STRING, loc };
    const performance = lowerPerfHooksTypeof(lowerer, expr.expression);
    if (performance) return performance;
    if (isNodeModuleValue(lowerer, expr.expression)) {
      return { kind: "strLit", value: "object", type: STRING, loc };
    }
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const member = expr.expression;
      const prototype = member.expression;
      if (
        STRING_INDEX_METHODS.has(member.name.text) &&
        ts.isPropertyAccessExpression(prototype) &&
        prototype.name.text === "prototype" &&
        ts.isIdentifier(prototype.expression) &&
        lowerer.isStdlibGlobal(prototype.expression, "String") &&
        lowerer.isStdlibMember(member)
      ) {
        return { kind: "strLit", value: "function", type: STRING, loc };
      }
      if (
        member.name.text === "at" &&
        ts.isPropertyAccessExpression(prototype) &&
        prototype.name.text === "prototype" &&
        ts.isIdentifier(prototype.expression) &&
        lowerer.isStdlibGlobal(prototype.expression, "Array") &&
        lowerer.isStdlibMember(member)
      ) {
        return { kind: "strLit", value: "function", type: STRING, loc };
      }
      const presence = lowerPromiseThenPresence(lowerer, expr.expression, {
        kind: "strLit",
        value: "function",
        type: STRING,
        loc,
      });
      if (presence !== null) return presence;
    }
    // `typeof queueMicrotask` / `typeof DOMException` on a STDLIB global
    // whose declared type is callable or constructable: folds to
    // "function" BEFORE the operand lowers — the identity-token story
    // (JS files) deliberately represents these values as strings, and
    // the TS-file fence would name a value the program never needs; an
    // identifier read has no side effects to preserve. Node's answer for
    // every function and constructor global is "function" (the harness's
    // `typeof queueMicrotask === 'function'` probes). Shadowing locals
    // have non-stdlib symbols and keep the ordinary path.
    let tested = expr.expression;
    while (ts.isParenthesizedExpression(tested)) tested = tested.expression;
    if (ts.isIdentifier(tested)) {
      const sym = lowerer.checker.getSymbolAtLocation(tested);
      if (!sym && !lowerer.dynamic) {
        return { kind: "strLit", value: "undefined", type: STRING, loc };
      }
      if (lowerer.isStdlibSymbol(sym)) {
        const t = lowerer.typeOf(expr.expression);
        if (
          lowerer.checker.getCallSignatures(t).length > 0 ||
          lowerer.checker.getConstructSignatures(t).length > 0
        ) {
          return { kind: "strLit", value: "function", type: STRING, loc };
        }
      }
    }
    // A known static result type fixes typeof's answer, but its producer
    // still evaluates: calls, getters, and checked reads can have effects
    // or throw. Only trivial operands may disappear.
    let operand = lowerer.lowerExpr(expr.expression);
    if (operand.type.kind === "jsval") {
      return { kind: "jsOp", op: "typeof", args: [operand], type: STRING, loc };
    }
    // A checker-narrowed dyn read arrives as a VALIDATED extraction
    // (maybeNarrow's dynCheck bridge). typeof needs no extraction — the
    // dyn kind table answers the question directly, and answers it even
    // where the flow type lied (the extraction would throw instead) —
    // so unwrap back to the dyn value and take the dyn.typeof path.
    if (operand.kind === "dynCheck" && operand.value.type.kind === "dyn") {
      operand = operand.value;
    }
    const FOLD: Partial<Record<string, string>> = {
      f64: "number",
      bigint: "bigint",
      string: "string",
      bool: "boolean",
      func: "function",
      array: "object",
      object: "object",
      record: "object",
      symbol: "symbol",
      map: "object",
      set: "object",
      promise: "object",
      bytes: "object",
      regex: "object",
      generator: "object",
      classval: "function",
      moduleNs: "object",
      undefinedT: "undefined",
      nullT: "object",
    };
    const folded = FOLD[operand.type.kind];
    if (folded) {
      const result: IrExpr = { kind: "strLit", value: folded, type: STRING, loc };
      return isSafeToDiscard(operand)
        ? result
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: operand, loc }],
            result,
            type: STRING,
            loc,
          };
    }
    // A union operand: every arm's typeof answer is static, so the value
    // form is a ternary chain over runtime TAG tests (arms grouped by
    // answer; the last group needs no test). The operand rides several
    // tests, so only side-effect-free reads compose — and when every arm
    // agrees the whole expression folds to that one string (dropping only
    // the pure read, the trust-the-checker bet lowerUnitComparison makes).
    if (operand.type.kind === "union" && isSafeToRepeat(operand)) {
      const def = lowerer.unions.get(operand.type.unionId);
      const answers = def?.arms.map(typeofAnswer);
      if (def && answers && answers.every((s): s is string => s !== null)) {
        const groups = new Map<string, number[]>();
        answers.forEach((s, i) => groups.set(s, [...(groups.get(s) ?? []), i]));
        const ordered = [...groups.entries()];
        let result: IrExpr = {
          kind: "strLit",
          value: ordered[ordered.length - 1]![0],
          type: STRING,
          loc,
        };
        for (const [answer, tags] of ordered.slice(0, -1).reverse()) {
          let test: IrExpr = {
            kind: "unionIsTag",
            unionId: operand.type.unionId,
            tag: tags[0]!,
            negated: false,
            value: operand,
            type: BOOL,
            loc,
          };
          for (const t of tags.slice(1)) {
            test = {
              kind: "logical",
              op: "||",
              left: test,
              right: {
                kind: "unionIsTag",
                unionId: operand.type.unionId,
                tag: t,
                negated: false,
                value: operand,
                type: BOOL,
                loc,
              },
              type: BOOL,
              loc,
            };
          }
          result = {
            kind: "ternary",
            cond: test,
            then: { kind: "strLit", value: answer, type: STRING, loc },
            else_: result,
            type: STRING,
            loc,
          };
        }
        return result;
      }
    }
    if (operand.type.kind === "dyn") {
      // Bare typeof on a dyn value: the runtime's kind→string table
      // (null answers "object", boxed closures "function" — JS-exact
      // for every dyn kind; "bigint"/"symbol" have no producers).
      return { kind: "libCall", fn: "dyn.typeof", args: [operand], type: STRING, loc };
    }
    lowerer.unsupported("SC1090", expr, "typeof expressions on statically-typed values");
  }
  if (ts.isIdentifier(expr)) {
    if (lowerer.isStdlibGlobal(expr, "console")) {
      return { kind: "libCall", fn: "console.native", args: [], type: DYN, loc };
    }

    const moduleValue = lowerNodeModuleIdentifier(lowerer, expr);
    if (moduleValue) return moduleValue;
    if (lowerer.isSelfReference(expr)) {
      return { kind: "selfRef", type: lowerer.ctx.selfType!, loc };
    }
    // `arguments` in a variadic JS function (the rest-marked form): the
    // synthetic trailing dyn-array param — lambdaSignature marked the
    // type and lowerLambda declared the local.
    if (expr.text === "arguments") {
      const binding = captureContextArguments(lowerer.fnStack);
      if (binding) return { kind: "varRef", localId: binding.id, type: DYN, loc };
    }
    // A compiler-projected adapter as a VALUE: the adapter has no
    // runtime function object (its calls rewrite directly) — call it
    // through its immutable binding instead.
    {
      const sym = lowerer.resolveValueSymbol(expr);
      const projection = sym ? lowerer.staticCallables.get(sym) : undefined;
      if (
        projection?.kind === "promisified-exec-file" ||
        projection?.kind === "promisified-builtin"
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `a promisified builtin as a value (call '${expr.text}' directly)`,
        );
      }
      if (projection?.kind === "builtin-function") {
        if (!isJsSourceFile(expr.getSourceFile())) {
          const callable = lowerer.lowerBuiltinCallableValue(
            { module: projection.module, member: projection.member },
            loc,
          );
          if (callable) return callable;
        }
        lowerer.unsupported(
          "SC1090",
          expr,
          `a builtin function alias as an escaping value (call '${expr.text}' directly)`,
        );
      }
    }
    // Union-typed bindings read through tsc's control-flow narrowing:
    // when the checker types this USE as a single arm, maybeNarrow
    // bridges the tagged representation with a unionNarrow.
    const local = lowerer.resolveLocal(expr);
    if (local) {
      // A switch can dispatch past a lexical declaration. Keep this
      // previously refused codec form out until switch-scope TDZ boxes
      // model that skipped initialization, including value aliases.
      if (
        local.type.kind === "record" &&
        recordTextCodecClass(lowerer.shapes.get(local.type.shapeId)!) !== null
      ) {
        const symbol = lowerer.resolveValueSymbol(expr);
        const decl = symbol ? lowerer.checker.valueDeclarationOf(symbol) : undefined;
        if (
          decl &&
          ts.isVariableDeclaration(decl) &&
          ts.isVariableDeclarationList(decl.parent) &&
          (decl.parent.flags & ts.NodeFlags.BlockScoped) !== 0 &&
          ts.isVariableStatement(decl.parent.parent)
        ) {
          const clause = decl.parent.parent.parent;
          if (
            (ts.isCaseClause(clause) || ts.isDefaultClause(clause)) &&
            !(expr.getStart() >= clause.getStart() && expr.end <= clause.end)
          ) {
            lowerer.unsupported(
              "SC1090",
              expr,
              "codec bindings read from another switch clause before initialization is proven",
            );
          }
        }
      }
      if (local.type.kind === "caught") return lowerer.caughtRead(expr, local, loc);
      const symbol = lowerer.resolveValueSymbol(expr);
      const runtimeOptionalRoot = lowerer.runtimeOptionalRootOf(local);
      const active = lowerer.runtimeOptionalLocals.has(runtimeOptionalRoot);
      const arithmetic = lowerer.runtimeOptionalArithmeticLocals.has(runtimeOptionalRoot);
      const captured =
        !!symbol &&
        lowerer.runtimeOptionalStorageLocals.has(runtimeOptionalRoot) &&
        (local.boxed === true ||
          lowerer.ctx.captureBySymbol.get(symbol) === local ||
          runtimeOptionalRoot !== local);
      if (arithmetic && !runtimeOptionalUseOf(expr)) {
        return { kind: "varRef", localId: local.id, type: local.type, loc };
      }
      if (active || captured) {
        const use = runtimeOptionalUseOf(expr);
        if (use?.complex) {
          lowerer.unsupported(
            "SC1090",
            expr,
            "a logical or conditional receiver containing a runtime-optional capture",
          );
        }
        if (use?.optional) return { kind: "varRef", localId: local.id, type: local.type, loc };
        if (use?.kind === "property")
          return runtimeOptionalReceiverRead(lowerer, expr, local, use.access.name.text, loc);
        if (use?.kind === "element") {
          const key = runtimeOptionalElementKey(use.access.argumentExpression);
          if (key === null) {
            return varRef(local.id, local.type, loc);
          }
          return runtimeOptionalReceiverRead(lowerer, expr, local, key, loc);
        }
        if (use?.kind === "call") {
          if (use.comma && !use.optional) {
            lowerer.unsupported(
              "SC1090",
              use.access,
              "a direct call through a comma-wrapped runtime-optional capture",
            );
          }
          return runtimeOptionalReceiverRead(lowerer, expr, local, null, loc);
        }
        if (runtimeOptionalObjectWalkerArg(lowerer, expr)) {
          const narrowed = lowerer.mapTypeOf(lowerer.typeOf(expr));
          if (local.type.kind === "union" && narrowed) {
            const helper =
              narrowed.kind === "union"
                ? lowerer.narrowedRetagHelper(expr, local.type.unionId, narrowed.unionId, loc)
                : !isUnitType(narrowed)
                  ? lowerer.narrowedArmHelper(local.type.unionId, narrowed, loc)
                  : null;
            if (helper) {
              return {
                kind: "call",
                callee: helper,
                args: [varRef(local.id, local.type, loc)],
                type: narrowed,
                loc,
              };
            }
          }
        }
        return { kind: "varRef", localId: local.id, type: local.type, loc };
      }
      const narrowed = lowerer.maybeNarrow(
        { kind: "varRef", localId: local.id, type: local.type, loc },
        expr,
      );
      if (
        narrowed.type.kind === "union" &&
        lowerer.runtimeOptionalStorageLocals.has(runtimeOptionalRoot) &&
        lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind === "record"
      ) {
        // A presence guard can be followed by a predicate strengthening
        // the record's fields. Its refined shape is not a stored union
        // arm: extract the original layout before reading a member.
        const use = runtimeOptionalUseOf(expr);
        if (use && !use.complex && !use.optional) {
          if (use.kind === "property")
            return runtimeOptionalReceiverRead(lowerer, expr, local, use.access.name.text, loc);
          if (use.kind === "element") {
            const key = runtimeOptionalElementKey(use.access.argumentExpression);
            if (key !== null) return runtimeOptionalReceiverRead(lowerer, expr, local, key, loc);
          }
        }
      }
      return narrowed;
    }
    // `import x = N.y` aliases resolve transparently through globalOf/
    // fnSigOf below; their source-order guards live here (a no-op for
    // every non-import= binding — see lower-namespaces.ts).
    fenceEarlyAliasUse(lowerer, expr, expr);
    const g = lowerer.globalOf(expr);
    if (g) {
      // A global typed by a class that never REGISTERED (its collection
      // fenced): the initializing assignment never lowered, so the read
      // can only observe garbage — and the emitter would name a struct
      // that does not exist. The blocked-binding cascade names the use;
      // without this the validator's registration check ICEs on the live
      // reference (`@this {T}` inference — signature 07).
      if (lowerer.typeNamesUnregisteredClass(g.type)) {
        lowerer.pushDiag(blockedBindingUseDiag(expr.text, loc));
        throw new PoisonError();
      }
      const ref: IrExpr = { kind: "varRef", localId: g.id, type: g.type, loc };
      if (lowerer.isRuntimeOptionalArithmeticGlobal(g) && !runtimeOptionalUseOf(expr)) {
        return ref;
      }
      const storageHasUndefined =
        g.type.kind === "union" && lowerer.armTag(g.type.unionId, UNDEFINED_T) >= 0;
      if (lowerer.isRuntimeOptionalGlobal(g) || storageHasUndefined) {
        // A checker-narrowed global receiver (`if (tags !== undefined)
        // tags[tags.length] = ...`, or `a ? Object.keys(a) : ...`) is
        // still stored as the runtime optional union. Extract the proven
        // value arm before routing the member/element operation so dynamic
        // keys and builtin record walkers do not see a union receiver.
        const narrowed = lowerer.mapTypeOf(lowerer.typeOf(expr));
        const arithmeticUnion =
          g.type.kind === "union" &&
          lowerer.unions.get(g.type.unionId)?.arms.length === 2 &&
          lowerer.unions.get(g.type.unionId)!.arms.some((a) => a.kind === "f64") &&
          lowerer.unions.get(g.type.unionId)!.arms.some((a) => a.kind === "string");
        if (
          !arithmeticUnion &&
          g.type.kind === "union" &&
          narrowed &&
          narrowed.kind !== "union" &&
          !isUnitType(narrowed) &&
          !(
            narrowed.kind === "record" &&
            recordTextCodecClass(lowerer.shapes.get(narrowed.shapeId)!) !== null
          ) &&
          narrowed.kind !== "f64" &&
          narrowed.kind !== "string" &&
          narrowed.kind !== "bool" &&
          lowerer.armTag(g.type.unionId, narrowed) >= 0
        ) {
          const helper = lowerer.narrowedArmHelper(g.type.unionId, narrowed, loc);
          if (helper) return { kind: "call", callee: helper, args: [ref], type: narrowed, loc };
        }
        const use = runtimeOptionalUseOf(expr);
        // The enclosing logical/conditional expression consumes the union
        // before any member operation runs (`(value ?? fallback).length`).
        // Keep the tagged value intact and let that lazy expression decide
        // its branch; extracting here would evaluate or throw too early.
        if (use?.complex) return ref;
        if (use?.optional) return ref;
        if (use?.kind === "property")
          return runtimeOptionalReceiverRead(lowerer, expr, g, use.access.name.text, loc);
        if (use?.kind === "element") {
          const key = runtimeOptionalElementKey(use.access.argumentExpression);
          if (key === null)
            lowerer.unsupported(
              "SC1090",
              use.access,
              "a computed read from a runtime-optional global (use a literal key)",
            );
          return runtimeOptionalReceiverRead(lowerer, expr, g, key, loc);
        }
        if (use?.kind === "call") return runtimeOptionalReceiverRead(lowerer, expr, g, null, loc);
        return ref;
      }
      return lowerer.maybeNarrow(ref, expr);
    }
    // `undefined` — tsc's intrinsic global (a local shadowing the name
    // resolved above): a unit literal, exactly like the `null` keyword.
    if (expr.text === "undefined" && lowerer.typeOf(expr).flags & ts.TypeFlags.Undefined) {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
    }
    // `__dirname` / `__filename` — the CommonJS module globals: per-
    // MODULE compile-time constants, the containing file's location
    // (Node's exact values when the same tree runs in place; WASI uses
    // the equivalent guest-visible path; locals shadowing the names
    // resolved above). In a file with ESM syntax Node never defines them
    // (ReferenceError) — fence rather than invent a value there.
    if (
      (expr.text === "__dirname" || expr.text === "__filename") &&
      lowerer.isStdlibGlobal(expr, expr.text)
    ) {
      const sf = expr.getSourceFile();
      if (isNodeEsmFile(sf, lowerer.program)) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `'${expr.text}' in an ES module (Node defines the CJS module globals only in CommonJS modules)`,
        );
      }
      // The WASI runner mounts the host cwd at guest `/` and the host temp
      // directory at `/tmp`. Bake the matching GUEST spelling so resource
      // lookups relative to these CommonJS globals stay inside the exposed
      // capability instead of naming an unreachable host-absolute path.
      const fileName = moduleFileName(lowerer, sf);
      const value =
        expr.text === "__dirname"
          ? lowerer.targetPlatform === "wasi"
            ? posix.dirname(fileName)
            : dirname(fileName)
          : fileName;
      return { kind: "strLit", value, type: STRING, loc };
    }
    const sig = lowerer.fnSigOf(expr);
    if (sig && lowerer.isTopLevelFnSymbol(expr)) {
      // A declared function used as a value: a zero-capture closure. The
      // backend interns one per function so `f === f` holds (JS identity).
      // The value's type is the completed ABI signature; optional/default
      // slots and typed rest arrays pass the value fence first.
      lowerer.noteEdge(sig.name);
      // dynRest slots stay out of the VALUE type's param list (fn.length
      // semantics); the rest marker carries the trailing dyn-array ABI.
      const funcType: IrType = funcTypeFromParamShapes(sig.params, sig.returnType);
      lowerer.requireExactArityValue(expr, expr, sig.params, funcType);
      return { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc };
    }
    {
      // A generic function as a VALUE: monomorphized by flow — the
      // reference's pinned concrete signature (contextual type or an
      // instantiation expression) names the instance; unpinned
      // references fence inside (lowerGenericFnValue).
      const gfn = lowerer.genericFnOf(expr);
      if (gfn) return lowerer.lowerGenericFnValue(expr, gfn);
    }
    // A CJS export-table ACCESSOR read (`tmpdir.path`, or a destructured
    // binding aliasing one): the getter is a real function of module
    // scope — its body reads module globals, so it lifts like a lambda
    // (interned per declaration) and every read is a call. Node runs the
    // getter per read; so does this.
    {
      const acc = cjsExportAccessorRead(lowerer, expr);
      if (acc) return acc;
    }
    // A binding destructured from a baked constants object
    // (http2.constants / crypto.constants): the literal — the
    // declaration emitted nothing (builtinConstantsDestructureDecl).
    {
      const h2c = lowerer.builtinConstantBindingOf(expr);
      if (h2c) return h2c;
    }
    // Builtin-module import bindings: constants (path.sep, os.EOL) read
    // as interned string literals; functions have no closure
    // representation (they lower to libCall at call sites only); members
    // with no lowering at all fence with the module-qualified name.
    {
      const bi = lowerer.builtinImportOf(expr);
      if (bi) {
        if (bi.module === "worker_threads") {
          const value = lowerWorkerMetadata(bi.member, loc);
          if (value) return value;
        }
        const c = builtinModuleConstOf(lowerer, bi.module, bi.member);
        if (c !== undefined) return builtinConstLit(c, loc);
        // module.builtinModules — the baked Node v24 list, a fresh
        // string[] per read.
        if (bi.module === "module" && bi.member === "builtinModules") {
          return builtinModulesArrayLit(loc);
        }
        if (bi.module === "http" && bi.member === "METHODS") {
          return { kind: "libCall", fn: "http.methods", args: [], type: arrayOf(STRING), loc };
        }
        if (bi.module === "http" && bi.member === "STATUS_CODES") {
          return { kind: "libCall", fn: "http.statusCodes", args: [], type: DYN, loc };
        }
        // tls.rootCertificates: a runtime-valued module constant (the
        // cached bundled-CA array) — the one member read that lowers
        // to a libCall instead of a baked literal.
        {
          const roots = lowerTlsRootCertificates(lowerer, bi, loc);
          if (roots) return roots;
        }
        {
          const callable = lowerer.lowerBuiltinCallableValue(bi, loc);
          if (callable) return callable;
        }
        // JavaScript sources: an otherwise unsupported builtin VALUE is
        // the same identity-token story as stdlib globals above (the
        // harness adds worker_threads.Worker to its identity Set).
        if (isJsSourceFile(expr.getSourceFile())) {
          return {
            kind: "strLit",
            value: `[builtin ${bi.module}.${bi.member}]`,
            type: STRING,
            loc,
          };
        }
        if (builtinModuleFnOf(lowerer, bi.module, bi.member)) {
          lowerer.unsupported(
            "SC1090",
            expr,
            `library functions as values (call '${expr.text}' directly)`,
          );
        }
        lowerer.noLowering(
          `${bi.module}.${bi.member}`,
          expr,
          builtinFenceHintOf(bi.module, bi.member),
          lowerer.resolveValueSymbol(expr),
        );
      }
    }
    // A builtin namespace import used as a bare VALUE (`const f = fs`):
    // the namespace object has no representation — members lower at
    // their access sites only. The CommonJS namespace binding
    // (`const lib = require("./lib.js")`) gets the same fence.
    const builtinNamespace = lowerer.builtinNamespaceModuleOf(expr);
    if (builtinNamespace !== null) {
      const type: IrType = { kind: "moduleNs", moduleId: `builtin:${builtinNamespace}` };
      return { kind: "moduleNsRef", moduleId: type.moduleId, type, loc };
    }
    if (lowerer.cjsLocalModuleBindingOf(expr)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `module namespace objects as values (access '${expr.text}' members directly)`,
      );
    }
    if (lowerer.islandGlobalFnOf(expr)) {
      // Island-backed functions have no closure representation (they
      // lower to engine ops at call sites only).
      lowerer.unsupported(
        "SC1090",
        expr,
        `library functions as values (call '${expr.text}' directly)`,
      );
    }
    // npm import bindings in a STATIC build: the binding's value lives
    // in the embedded engine — the per-package requires-dynamic
    // diagnostic, not the generic fallthrough. (Under --dynamic these
    // resolve as jsval globals above.)
    if (!lowerer.dynamic) {
      const pkg = lowerer.npmPackageOfSymbol(lowerer.resolveValueSymbol(expr) ?? undefined);
      if (pkg) {
        lowerer.pushDiag(requiresDynamicPackageDiag(pkg, loc));
        throw new PoisonError();
      }
    }
    // Bindings imported from an UNSUPPORTED builtin module: coverage
    // analyzes past import fences, so uses of `spawn` from
    // child_process reach lowering — the use site reports the same
    // "the '<module>' module" diagnostic as the import line, and the
    // report groups them into one blocker. (Builds never get here: the
    // import already failed preflight.)
    {
      const spec = lowerer.fencedBuiltinImportOf(expr);
      if (spec !== null) {
        lowerer.pushDiag(unsupportedDiag("SC1010", loc, unsupportedModuleFeatureOf(spec)));
        throw new PoisonError();
      }
    }
    // The globals `Infinity` and `NaN` (lib-declared, provenance-checked
    // like every stdlib name): non-finite numLits — `-Infinity` arrives
    // through the unary-minus literal fold. Arithmetic, comparisons, and
    // formatting are IEEE-exact in C (String(Infinity) is "Infinity" and
    // String(NaN) is "NaN" in the number formatter; `NaN !== NaN` holds
    // because f64 compares are IEEE compares).
    if (expr.text === "Infinity" || expr.text === "NaN") {
      const sym = lowerer.checker.getSymbolAtLocation(expr);
      if (lowerer.isStdlibSymbol(sym)) {
        return { kind: "numLit", value: expr.text === "NaN" ? NaN : Infinity, type: F64, loc };
      }
    }
    // The primitive constructors as VALUES (`const f = String`, an
    // option table's `type: Boolean` field, `opt.type === Number`): the
    // interned coercion closure — one synthesized module function per
    // constructor per program, so every reference is the SAME zero-
    // capture closure and `===` is JS identity (the type mapping in
    // type-mapper.ts pins the one concrete signature `(value: string) =>
    // primitive`; direct calls `String(x)` never reach here — the call
    // lowering intercepts them with the wider static coercions).
    const jsPrimitiveCtorSelector = isJsSourceFile(expr.getSourceFile());
    const primitiveName = stdlibGlobalNameOf(lowerer, expr);
    if (
      primitiveName === "String" ||
      primitiveName === "Number" ||
      primitiveName === "Boolean" ||
      primitiveName === "BigInt"
    ) {
      return primitiveCtorClosure(lowerer, primitiveName, loc, jsPrimitiveCtorSelector);
    }
    if (lowerer.isStdlibGlobal(expr, "ArrayBuffer"))
      return { kind: "libCall", fn: "arrayBuffer.constructor", args: [], type: DYN, loc };
    if (isJsSourceFile(expr.getSourceFile()) && lowerer.isStdlibGlobal(expr, "Array"))
      return { kind: "libCall", fn: "dyn.arrayConstructor", args: [], type: DYN, loc };
    if (
      Object.values(BYTES_ELEMENT_NAME).includes(expr.text) &&
      lowerer.isStdlibSymbol(lowerer.checker.getSymbolAtLocation(expr))
    ) {
      return {
        kind: "libCall",
        fn: "bytes.constructor",
        args: [{ kind: "strLit", value: expr.text, type: STRING, loc }],
        type: DYN,
        loc,
      };
    }
    if (
      (expr.text === "encodeURIComponent" ||
        expr.text === "encodeURI" ||
        expr.text === "decodeURIComponent" ||
        expr.text === "decodeURI") &&
      lowerer.isStdlibGlobal(expr, expr.text)
    ) {
      const name = `%builtin.${expr.text}`;
      const type = funcOf([DYN], STRING);
      if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
        const value: IrExpr = {
          kind: "libCall",
          fn: "dyn.toStringCoerce",
          args: [varRef("value", DYN, loc)],
          type: STRING,
          loc,
        };
        const fn =
          expr.text === "encodeURIComponent"
            ? "str.encodeUriComponent"
            : expr.text === "encodeURI"
              ? "str.encodeUri"
              : expr.text === "decodeURI"
                ? "str.decodeUri"
                : "str.decodeUriComponent";
        lowerer.liftedFns.push({
          name,
          params: [{ localId: "value", name: "value", type: DYN }],
          locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
          returnType: STRING,
          body: [
            {
              kind: "return",
              value: { kind: "libCall", fn, args: [value], type: STRING, loc },
              loc,
            },
          ],
          loc,
        });
      }
      return { kind: "closure", fnName: name, captures: [], type, loc };
    }
    if (!lowerer.dynamic && lowerer.isStdlibGlobal(expr, "crypto"))
      return { kind: "libCall", fn: "crypto.native", args: [], type: DYN, loc };
    const nativeAlias = stdlibGlobalNameOf(lowerer, expr);
    if (nativeAlias === "Buffer" && expr.text !== "Buffer") {
      return { kind: "strLit", value: "[builtin Buffer]", type: STRING, loc };
    }
    if (!lowerer.dynamic && lowerer.isStdlibGlobal(expr, "fetch")) {
      return { kind: "libCall", fn: "fetch.function", args: [], type: DYN, loc };
    }
    // The lib fence's IDENTIFIER chokepoint: the real standard library
    // resolves names the old minimal ambient world never declared
    // (Symbol, Reflect, Infinity, Date, ...) — and the adopted
    // @types/node resolves its whole global surface (Buffer, fetch,
    // setInterval, URL, ...). Reaching one that no lowering above
    // claimed is SC2020, never an ICE — EXCEPT in JavaScript sources,
    // where a stdlib global taken as a VALUE (never called through this
    // path — call sites lower earlier) becomes an opaque IDENTITY TOKEN:
    // an interned string naming the global. Identity flows (the
    // harness's knownGlobals Set, === comparisons) are exact — one
    // global, one token; what a token cannot do (be called, answer
    // typeof "function") meets per-site fences/divergences, and
    // SEMANTICS.md documents the stance.
    if (!lowerer.dynamic && stdlibGlobalNameOf(lowerer, expr) === "globalThis") {
      return lowerGlobalValue(lowerer, expr);
    }
    {
      const sym = lowerer.checker.getSymbolAtLocation(expr);
      if (lowerer.isStdlibSymbol(sym) || expr.text === "globalThis") {
        if (isJsSourceFile(expr.getSourceFile())) {
          const canonical = stdlibGlobalNameOf(lowerer, expr) ?? expr.text;
          return { kind: "strLit", value: `[builtin ${canonical}]`, type: STRING, loc };
        }
        // In a dynamic TypeScript build, the real global object is the
        // escape hatch for host capabilities without static lowering.
        // Direct globalThis.member uses still take their static surface
        // paths; an explicit `as any` or `: any` can reach engine ops.
        if (lowerer.dynamic && expr.text === "globalThis") {
          return { kind: "jsOp", op: "globalGet", name: "globalThis", args: [], type: JSVAL, loc };
        }
        // The families with a WHY: each hint states what makes the
        // surface genuinely non-static (or what to use instead).
        const globalHints: Record<string, string | undefined> = {
          Proxy:
            "Proxy constructor values have no native lowering; use a direct new Proxy with checked-native plain objects",
          Reflect:
            "reflective property access has no static lowering — read and call members directly",
          Intl: 'native Intl supports default Unicode grapheme segmentation and the composed new Intl.NumberFormat("en-US").format(x); locale negotiation and other ICU-backed operations remain unsupported',
          SharedArrayBuffer: "use direct new SharedArrayBuffer(length) for fixed shared storage",
          ArrayBuffer:
            "ArrayBuffer constructor values have no native lowering; use new ArrayBuffer(length) for fixed-length shared storage",
          WeakRef:
            "deref()-after-collect exposes GC timing — genuinely dynamic; hold a strong reference instead",
          FinalizationRegistry:
            "finalization callbacks expose GC timing — genuinely dynamic; release resources explicitly instead",
          eval: "runtime code evaluation cannot be compiled ahead of time",
        };
        lowerer.noLowering(expr.text, expr, globalHints[expr.text], sym ?? undefined);
      }
    }
    // An ambient global nothing defines compiles to exactly what Node does
    // at the access: the catchable ReferenceError "<name> is not defined".
    // Stdlib/@types/node ambients never reach here (their chokepoint
    // is above); only user-file declares do.
    {
      const sym = lowerer.resolveValueSymbol(expr);
      const decl = sym ? lowerer.checker.declarationsOf(sym)[0] : undefined;
      if (
        decl !== undefined &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer === undefined &&
        ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient
      ) {
        const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
        if (declared && declared.kind !== "void") {
          return {
            kind: "libCall",
            fn: "global.undefRead",
            args: [{ kind: "strLit", value: expr.text, type: STRING, loc }],
            type: declared,
            loc,
          };
        }
      }
    }
    // An ambient `declare function` nothing defines, taken as a VALUE
    // (call sites lower earlier, in lowerCall): the same story as the
    // ambient `declare const` above — Node erases the declaration and
    // the read throws the catchable ReferenceError at the access.
    {
      if (ambientUndefinedFnSymbolOf(lowerer, expr)) {
        const t = ambientUndefReadType(lowerer, expr);
        if (t) return nsUndefRead(lowerer, expr.text, expr, t);
      }
    }
    // A read of a TRAP binding — a declaration whose own initializer
    // provably threw (module init unwound there), so this reference can
    // never execute: any lowering is sound, and the trap keeps the
    // shape honest. Typed by the use site when it maps, the F64 dummy
    // otherwise (never observed — never even reached).
    {
      const sym = lowerer.resolveValueSymbol(expr);
      if (sym !== null && lowerer.trapBindings.has(sym)) {
        const t =
          ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
        return nsUndefRead(lowerer, expr.text, expr, t);
      }
    }
    // A program CLASS NAME as a value: the classRef over the class's
    // immortal class object (member accesses and construction never
    // reach here — their hooks claim the property/new forms first).
    {
      const sym = lowerer.resolveValueSymbol(expr);
      const classInfo = sym ? lowerer.classBySymbol.get(sym) : undefined;
      // A GENERIC class name whose CONTEXTUAL type pins one instantiation
      // (`const B: new (v: string) => Counter<string> = Counter`): the
      // value is that instantiation's class object — the generic-fn
      // pinning rule on the static side. Unpinned references fall
      // through to classValueRef's family fence.
      if (classInfo?.generic) {
        const ctxT = lowerer.checker.getContextualType(expr);
        const mapped = ctxT ? lowerer.mapTypeOf(ctxT) : null;
        const instInfo =
          mapped?.kind === "classval" ? lowerer.classes.get(mapped.className) : undefined;
        if (instInfo && instInfo.genericInstance?.family === classInfo) {
          return lowerer.classValueRef(instInfo, expr);
        }
      }
      if (classInfo) {
        // A decorated name a replacing decorator can REBIND: the value
        // is the decoration result — the mutable classval global %init
        // assigned at the class statement (TC39's name binding), never
        // the declaration's own class object.
        const decoratedGlobal = classInfo.classDecorators?.valueGlobalId;
        if (decoratedGlobal !== undefined) {
          return {
            kind: "varRef",
            localId: decoratedGlobal,
            type: { kind: "classval", className: classInfo.def.name },
            loc,
          };
        }
        return lowerer.classValueRef(classInfo, expr);
      }
      // The enum OBJECT as a value (member reads never reach here — the
      // access hooks fold them): iteration, storage, reverse lookups
      // through variables all land on this pointed fence.
      if (sym) fenceEnumObjectValue(lowerer, expr, sym);
      // A MIXIN function as a first-class value: no runtime function
      // exists — calls instantiate a class per call site
      // (lower-mixins.ts). Generic mixins took the generic-fn value
      // fence above; this names the non-generic spelling.
      if (mixinFnOfCallee(lowerer, expr)) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `the mixin function '${expr.text}' as a value (mixin calls compile per call site — call it directly)`,
        );
      }
    }
    // A NAMESPACE object as a first-class value: members lower at their
    // qualified access sites; the object itself has no runtime
    // representation (ambient namespaces compile to Node's
    // ReferenceError instead — the object never exists at runtime).
    {
      const moduleNs = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (moduleNs?.kind === "moduleNs") {
        return { kind: "moduleNsRef", moduleId: moduleNs.moduleId, type: moduleNs, loc };
      }
      const builtinNs = lowerer.builtinNamespaceModuleOf(expr);
      if (builtinNs !== null) {
        const type: IrType = { kind: "moduleNs", moduleId: `builtin:${builtinNs}` };
        return { kind: "moduleNsRef", moduleId: type.moduleId, type, loc };
      }
      const ns = lowerNsIdentifierValue(lowerer, expr);
      if (ns) return ns;
    }
    // Preflight guarantees no unresolved identifiers; anything else here
    // is a blocked declaration's binding (the SC2004 cascade) or a
    // binding form we don't model yet.
    lowerer.rejectUnresolved(
      expr,
      `the reference to '${expr.text}' (a binding form with no lowering)`,
    );
  }
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
    const local = lowerer.resolveThis();
    if (local) {
      const value: IrExpr = { kind: "varRef", localId: local.id, type: local.type, loc };
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
    if (isJsSourceFile(expr.getSourceFile())) {
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
        if (inner.kind === "union" || inner.kind === "dyn" || inner.kind === "jsval") {
          // A union inner would need an arm-wise re-tag into the result
          // union; dyn/jsval inners have their own boundary stories.
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
    }
    if (value.type.kind !== "promise") {
      // A CHECKED-DYNAMIC operand (`await v` where v rode an untyped
      // binding — a destructured helper's return, a dyn call result):
      // the runtime decides — a dyn promise adopts (rejections
      // re-throw), anything else takes JS's one-hop non-thenable await
      // and answers itself. Thenable adoption stays unmodeled
      // (SEMANTICS.md).
      if (value.type.kind === "dyn") {
        return { kind: "libCall", fn: "async.awaitDyn", args: [value], type: DYN, loc };
      }
      // A jsval whose CHECKER type is a promise is a package-returned
      // promise: the value lives in the engine. Bridge it — a static
      // promise the engine promise settles (fulfillment = the retained
      // handle or void, rejection = the bridged reason) — and await
      // THAT: the fiber parks like any await, resumes with the settled
      // jsval, or re-throws the crossed rejection.
      if (value.type.kind === "jsval") {
        // ANY island value bridges — the runtime's Promise.resolve(v)
        // .then(...) wiring awaits thenables and non-thenables exactly
        // like JS (`await reg.load()` where the checker only knows
        // 'any' must still park on the returned engine promise).
        const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
        const inner: IrType =
          mapped?.kind === "promise" && mapped.inner.kind === "void" ? VOID : JSVAL;
        const bridged: IrExpr = {
          kind: "jsBridgePromise",
          value,
          type: { kind: "promise", inner },
          loc,
        };
        return { kind: "awaitExpr", value: bridged, type: inner, loc };
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
  if (ts.isBinaryExpression(expr)) return lowerer.lowerBinary(expr);
  if (ts.isCallExpression(expr)) {
    // The tail of an optional chain whose `?.` sits deeper
    // (`x?.trim().toLowerCase()`): the whole tail short-circuits with
    // the guard, so it lowers as one chain (dyn/island receivers keep
    // their own undefined-propagating reads — see isOptionalChainTail).
    if (isOptionalChainTail(lowerer, expr)) return lowerer.lowerOptionalChain(expr);
    return lowerer.lowerCall(expr);
  }
  if (ts.isArrayLiteralExpression(expr)) return lowerer.lowerArrayLiteral(expr);
  if (ts.isObjectLiteralExpression(expr)) return lowerer.lowerObjectLiteral(expr);
  if (ts.isElementAccessExpression(expr)) return lowerer.lowerElementAccess(expr);
  if (ts.isConditionalExpression(expr)) return lowerTernary(lowerer, expr);

  if (ts.isPropertyAccessExpression(expr)) {
    // Expando statics may still be absent even when JS inference sees
    // the eventual assignment's scalar type. Preserve the checked value.
    const staticField = lowerStaticFieldRead(lowerer, expr);
    if (staticField) return staticField;
    const prototypeData = lowerClassPrototypeData(lowerer, expr);
    if (prototypeData) return prototypeData;
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "prototype"
    ) {
      const prototype = lowerClassPrototypeData(lowerer, expr.expression);
      if (prototype)
        return {
          kind: "dynKeyGet",
          value: prototype,
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
          type: DYN,
          loc,
        };
    }
    // `super.x`: the base chain's GETTER, called directly (super
    // dispatch is static in JS — never through the dynamic class).
    // super.method() calls are routed at the call site; a bare super
    // property read lands here.
    if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
      return lowerer.lowerSuperAccessorRead(expr);
    }
    // Enum member reads (`E.A`) fold to their compile-time constants —
    // claimed FIRST so no receiver-shaped path (records, islands, the
    // identifier fence on the enum object) sees them. lower-enums.ts.
    {
      const en = lowerEnumAccess(lowerer, expr);
      if (en) return en;
    }
    // `import.meta.<field>` — the file-backed ESM metadata that survives
    // compilation as a constant. Only direct, identifier-named reads are
    // claimed here; the bare meta object, computed access, writes, and
    // unsupported members continue through the generic module-loader fence
    // below. The source file is the module identity, so imported modules
    // receive their own filename/dirname and only the entry receives main.
    const importMeta = importMetaProperty(lowerer, expr);
    if (importMeta) return importMeta;
    // `require.main.filename` / `require.main?.filename` — CommonJS
    // entry-module identity: in a compiled binary require.main IS the
    // entry module (never undefined in a CJS graph, so the chain's guard
    // folds away), and its filename is the ENTRY file's real path —
    // Node's exact value when the same tree runs in place, exactly the
    // __filename stance. Checked BEFORE the optional-chain gate: the
    // checker types the chain `string | undefined`, but the value is a
    // compile-time string.
    if (isRequireMainFilename(lowerer, expr)) {
      return { kind: "strLit", value: lowerer.entry.fileName, type: STRING, loc };
    }
    const requireMain = lowerRequireMainProperty(lowerer, expr);
    if (requireMain) return requireMain;
    const moduleProperty = lowerNodeModuleProperty(lowerer, expr);
    if (moduleProperty) return moduleProperty;
    if (
      stdlibGlobalNameOf(lowerer, expr.expression) === "Symbol" &&
      [
        "iterator",
        "asyncIterator",
        "toStringTag",
        "toPrimitive",
        "hasInstance",
        "isConcatSpreadable",
        "match",
        "matchAll",
        "replace",
        "search",
        "split",
        "species",
        "unscopables",
        "dispose",
        "asyncDispose",
      ].includes(expr.name.text)
    ) {
      return {
        kind: "libCall",
        fn: "sym.wellKnown",
        args: [{ kind: "strLit", value: expr.name.text, type: STRING, loc }],
        type: { kind: "symbol" },
        loc,
      };
    }
    if (!lowerer.dynamic && lowerer.stdlibGlobalMember(expr, "Object") === "freeze") {
      const name = "%builtin.Object.freeze";
      if (!lowerer.liftedFns.some((fn) => fn.name === name))
        lowerer.liftedFns.push({
          name,
          params: [{ localId: "value", name: "value", type: DYN }],
          locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
          returnType: DYN,
          body: [
            {
              kind: "return",
              value: {
                kind: "libCall",
                fn: "dyn.freeze",
                args: [varRef("value", DYN, loc)],
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
      return { kind: "closure", fnName: name, captures: [], type: funcOf([DYN], DYN), loc };
    }
    if (lowerer.stdlibGlobalMember(expr, "globalThis") === "console") {
      return { kind: "libCall", fn: "console.native", args: [], type: DYN, loc };
    }
    if (lowerer.stdlibGlobalMember(expr, "console") !== null) {
      return {
        kind: "dynKeyGet",
        value: { kind: "libCall", fn: "console.native", args: [], type: DYN, loc },
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      };
    }
    // Missing host globals (Bun/Deno capability probes) have no binding
    // in a native program. Declared globals retain their own lowering;
    // arbitrary global-object mutation remains fenced. Preserve a dyn
    // undefined value so stored probes compose with optional calls.
    if (
      !lowerer.dynamic &&
      stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis" &&
      !lowerer.checker.getPropertyOfType(lowerer.typeOf(expr.expression), expr.name.text)
    ) {
      return dynUndefinedExpr(loc);
    }
    if (expr.questionDotToken && expr.name.text === "electron") {
      const processProperty = lowerer.lowerProcessProperty(expr);
      if (processProperty) return processProperty;
    }
    // Optional chaining `a?.b`: the guard lowers here (a tag test around
    // the plain property lowering below); the handled marker keeps this
    // re-entrant dispatch from looping.
    if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) {
      return lowerer.lowerOptionalChain(expr);
    }
    // `a?.b.c` — the tail of a chain whose token sits deeper: the whole
    // tail short-circuits with the guard.
    if (!expr.questionDotToken && isOptionalChainTail(lowerer, expr)) {
      return lowerer.lowerOptionalChain(expr);
    }
    // Known Web handles retain their declared surface even when their
    // storage uses checked values. Apply this before generic reads.
    lowerer.fenceStaticAbortControllerMemberRead(expr);
    lowerer.fenceStaticResponseMember(expr, "read");
    lowerer.fenceStaticHeadersMember(expr, "read");
    lowerer.fenceStaticReadableStreamMember(expr, "read");
    // Island receiver: o.x is an engine property read (getProp may throw
    // — reading off null/undefined — bridged catchably like everything
    // at the boundary). `o?.x` arrives here too, through the chain
    // lowering's re-dispatch (a questionDotToken past the gate above is
    // always chain-handled; the receiver reads back as the chain's
    // bound handle).
    if (lowerer.isIslandExpr(expr.expression)) {
      const receiver = lowerer.lowerExpr(expr.expression);
      // The checker said 'any' but the VALUE lives in the checked-dynamic tree (`this`
      // in a plain JS function — dyn.this — or a checked-dynamic local
      // behind an any-typed spelling): the property read is the checked-dynamic tree's
      // own keyed read, dyn results and dyn chains exactly like every
      // checked-dynamic member access (a nullish receiver throws V8's
      // catchable TypeError, exactly Node). Never a jsOp over a dyn —
      // the two dynamic worlds don't share a value representation.
      if (receiver.type.kind === "dyn") {
        return {
          kind: "dynKeyGet",
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
          value: receiver,
          type: DYN,
          loc,
        };
      }
      const read: IrExpr = {
        kind: "jsOp",
        op: "getProp",
        name: expr.name.text,
        args: [receiver],
        type: JSVAL,
        loc,
      };
      // A member the .d.ts DECLARES as a primitive exits eagerly to that
      // static type (`f.mediaType` on a package handle IS a string):
      // primitives copy by value across the boundary — no aliasing, no
      // cost — and every static consumer (intrinsics, templates,
      // comparisons) works on the result. Trust-but-verify: a lying
      // declaration throws the catchable TypeError instead of smuggling
      // a mistyped handle into string ops. A Uint8Array member exits the
      // same way (`result.audio.uint8Array` — the generated-media
      // payload) as a validated u8 COPY, the boundary's aliasing stance
      // (divergences 44/45; engine Buffers pass — they ARE Uint8Arrays).
      // Other composites stay handles (eager JSON copies would change
      // aliasing), and chain-handled reads stay jsval (the chain's unit
      // path is the engine's undefined — see lowerOptionalChain).
      if (!expr.questionDotToken) {
        const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
        if (
          declared &&
          (declared.kind === "f64" ||
            declared.kind === "bool" ||
            declared.kind === "string" ||
            (declared.kind === "bytes" && declared.elem === "u8"))
        ) {
          return { kind: "jsExit", value: read, type: declared, loc };
        }
      }
      return read;
    }
    // `m.index` on a for-of-over-matchAll binding reads the companion-
    // index array at this iteration's cursor — always a number: every
    // drained row matched, so the lib's `.index` is never undefined
    // here (lowerForOfMatchAll).
    if (expr.name.text === "index" && !expr.questionDotToken && ts.isIdentifier(expr.expression)) {
      const sym = lowerer.checker.getSymbolAtLocation(expr.expression);
      const companion = sym !== undefined ? lowerer.matchAllIndexBindings.get(sym) : undefined;
      if (companion !== undefined) {
        return {
          kind: "arrayGet",
          arr: { kind: "varRef", localId: companion.idxsLocalId, type: arrayOf(F64), loc },
          index: { kind: "varRef", localId: companion.curLocalId, type: F64, loc },
          type: F64,
          loc,
        };
      }
    }
    if ((expr.name.text === "index" || expr.name.text === "input") && !expr.questionDotToken) {
      const represented = tryLowerExpression(lowerer, expr.expression);
      if (
        represented &&
        isMatchSliceType(lowerer, represented.type) &&
        (lowerer.isStdlibMember(expr) || isJsSourceFile(expr.getSourceFile()))
      ) {
        const recv = represented;
        const read: IrExpr = {
          kind: "dynKeyGet",
          value: lowerer.coerceToExpected(recv, DYN),
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
          type: DYN,
          loc,
        };
        return lowerer.maybeNarrow(read, expr);
      }
    }
    // `m.groups` on a match result whose regex is statically known:
    // the compile-time record projection over the honest slice (or
    // Node's undefined when the pattern has no named groups) — see
    // lowerMatchGroupsRead.
    {
      const g = lowerMatchGroupsRead(lowerer, expr);
      if (g !== null) return g;
    }
    // `arguments.length` in a TYPED function whose signature is
    // FIXED-ARITY (no optional/default/rest parameters): tsc enforces
    // exact arity at every call site and call/apply/bind indirection is
    // fenced, so the actual count IS the declared count — a compile-time
    // constant. Arrows don't bind `arguments` (the walk skips them,
    // exactly JS's scoping); variable-arity signatures keep the fence
    // (the count would need a hidden argc). The JS-source variadic
    // `arguments` object (dynRest) was claimed at identifier lowering.
    if (
      expr.name.text === "length" &&
      !expr.questionDotToken &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "arguments" &&
      !lowerer.ctx.argumentsLocal &&
      lowerer.typeOf(expr.expression).getSymbol()?.name === "IArguments" &&
      lowerer.isStdlibSymbol(lowerer.typeOf(expr.expression).getSymbol())
    ) {
      let fn: ts.Node | undefined = expr.parent;
      while (
        fn !== undefined &&
        !ts.isFunctionDeclaration(fn) &&
        !ts.isFunctionExpression(fn) &&
        !ts.isMethodDeclaration(fn) &&
        !ts.isConstructorDeclaration(fn) &&
        !ts.isGetAccessorDeclaration(fn) &&
        !ts.isSetAccessorDeclaration(fn)
      ) {
        fn = ts.isSourceFile(fn) ? undefined : fn.parent;
      }
      if (fn !== undefined) {
        const fixedArity = (fn as ts.FunctionLikeDeclaration).parameters.every(
          (p) =>
            p.questionToken === undefined &&
            p.initializer === undefined &&
            p.dotDotDotToken === undefined,
        );
        if (fixedArity) {
          return {
            kind: "numLit",
            value: (fn as ts.FunctionLikeDeclaration).parameters.length,
            type: F64,
            loc,
          };
        }
        lowerer.unsupported(
          "SC1090",
          expr,
          "'arguments.length' in functions with optional, default, or rest parameters (the count varies per call — a fixed-arity signature folds to a constant)",
        );
      }
    }
    // CommonJS namespace binding (`const lib = require("./lib.js")`):
    // `lib.member` IS the member — the export table is alias plumbing,
    // so the NAME resolves exactly like a bare identifier reference
    // (resolveValueSymbol lands on the exporter's declaration and every
    // existing path — globals, function values, classes — applies).
    if (!expr.questionDotToken && lowerer.cjsLocalModuleBindingOf(expr.expression)) {
      // A binding whose dep is a class-expression WHOLE export
      // (`module.exports = class {…}`): the member surface is the
      // CLASS's — `C.name` folds to NamedEvaluation's answer and own
      // statics read their globals (lowerStaticFieldRead resolves the
      // binding through the expression's own symbol). The plain
      // member-name delegation below would resolve `name` against the
      // stdlib var instead — a wrong VALUE, not a fence. Unknown
      // members fall through to the delegation (expando statics ride
      // their pre-registered export globals).
      const viaClass = lowerStaticFieldRead(lowerer, expr);
      if (viaClass) return viaClass;
      return lowerExpr(lowerer, expr.name);
    }
    // `module.exports` READ in a CommonJS file whose whole export IS a
    // class expression (`module.exports = class …{}`): the read answers
    // the class VALUE — `new module.exports()` inside the module is the
    // requirer's `new C()` spelled locally. Top-level reads ABOVE the
    // assignment fall through to their existing fences (Node still
    // answers the original export object there); function bodies
    // resolve unconditionally — they run after the module evaluated,
    // the same approximation identifier exports already make. Every
    // other module.exports read keeps its existing story.
    if (
      !expr.questionDotToken &&
      isModuleExportsAccess(expr) &&
      isCjsJsFile(expr.getSourceFile(), lowerer.program)
    ) {
      const whole = cjsClassExprWholeExportOf(expr.getSourceFile());
      if (whole) {
        let inBody = false;
        for (
          let p: ts.Node | undefined = expr.parent;
          p !== undefined && !ts.isSourceFile(p);
          p = p.parent
        ) {
          if (ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
            inBody = true;
            break;
          }
        }
        if (inBody || expr.getStart() > whole.stmt.getEnd()) {
          return lowerer.classValueRef(lowerer.lowerClassExpressionInfo(whole.classExpr), expr);
        }
      }
    }
    // `module.exports.Sub` / `exports.Sub` READ in the same module: an
    // EXPRESSION-valued member rides its pre-registered export global —
    // exactly what requirers see through `require('./x').Sub`, and the
    // global IS the storage every `exports.Sub =` statement assigns, so
    // the read is Node's live member. Identifier-valued members have no
    // global (pure alias plumbing) and fall through unchanged; write
    // positions belong to the export-assignment machinery.
    {
      const sf = expr.getSourceFile();
      const cjsMemberRecv =
        isModuleExportsAccess(expr.expression) ||
        (ts.isIdentifier(expr.expression) &&
          expr.expression.text === "exports" &&
          !lowerer.resolveLocal(expr.expression) &&
          !lowerer.globalOf(expr.expression));
      const writePos =
        ts.isBinaryExpression(expr.parent) &&
        expr.parent.left === expr &&
        expr.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (
        !expr.questionDotToken &&
        cjsMemberRecv &&
        !writePos &&
        isCjsJsFile(sf, lowerer.program)
      ) {
        const sym =
          lowerer.checker.getSymbolAtLocation(expr.name) ??
          lowerer.cjsModuleExportSymbol(sf, expr.name.text);
        const resolved =
          sym !== undefined && sym.flags & ts.SymbolFlags.Alias
            ? lowerer.checker.getAliasedSymbol(sym)
            : sym;
        const g =
          (sym ? lowerer.globalsBySymbol.get(sym) : undefined) ??
          (resolved ? lowerer.globalsBySymbol.get(resolved) : undefined);
        if (g) return { kind: "varRef", localId: g.id, type: g.type, loc };
      }
    }
    // Namespace-qualified reads (`N.x`, `A.B.C.f`, import= alias
    // chains): the member is a compile-time-known declaration of a
    // lowered namespace block — it resolves exactly like a bare
    // identifier reference (globals, function values, classes), guarded
    // by the namespace source-order fences (lower-namespaces.ts).
    if (!expr.questionDotToken) {
      const nsMember = nsMemberIdentOf(lowerer, expr);
      if (nsMember) {
        const memberSym = lowerer.checker.getSymbolAtLocation(nsMember);
        if (memberSym) fenceEarlyNsMemberRef(lowerer, expr, memberSym);
        return lowerExpr(lowerer, nsMember);
      }
      // Expando function members (`foo.bar` after `foo.bar = 12`): the
      // member's module global (lower-expando.ts), before the ambient-
      // namespace fence — a declare-namespace merge over a real function
      // (`declare namespace Foo { var baz: number }` + `function Foo`)
      // reads its assigned members, not the ambient ReferenceError.
      {
        const ex = expandoMemberRead(lowerer, expr);
        if (ex) return lowerer.maybeNarrow(ex, expr);
      }
      // An AMBIENT namespace receiver (`M.x` where only `declare
      // namespace M` exists): the namespace object never exists at
      // runtime — Node's exact catchable ReferenceError at the access,
      // the ambient `declare const` stance.
      const ambientRoot = ambientNsRootOf(lowerer, expr.expression);
      if (ambientRoot !== null) {
        const t = ambientUndefReadType(lowerer, expr);
        if (t) return nsUndefRead(lowerer, ambientRoot.text, expr, t);
      }
    }
    // `exports.<name>` READS in a module whose export object was
    // REPLACED (`module.exports = ...`): `exports` still references the
    // ORIGINAL object — Node's aliasing rule — so when nothing ever
    // attached this name to it (`exports.<name> =` nowhere in the
    // file), the honest answer is undefined. tsc types the read off the
    // REPLACEMENT (its CJS model is identity-blind), which is exactly
    // the silent divergence this lowering closes. Reads in modules with
    // real `exports.<name> =` attachments keep their fences.
    {
      const ex = lowerReplacedExportsRead(lowerer, expr);
      if (ex) return ex;
    }
    // `this.<name>` inside a CJS export-table getter: Node binds the
    // receiver to module.exports — the read is the sibling getter's
    // lifted call.
    {
      const tm = lowerCjsExportTableThisMember(lowerer, expr);
      if (tm) return tm;
    }
    const handled =
      lowerer.lowerProcessEnvGet(expr) ??
      lowerer.lowerServerProperty(expr) ??
      // diagnostics_channel Channel receivers — name/hasSubscribers
      // over the f64 channel handle.
      lowerer.lowerDiagnosticsChannelProperty(expr) ??
      // TracingChannel receivers — the five event channels and
      // hasSubscribers over the f64 tracing handle.
      lowerer.lowerTracingChannelProperty(expr) ??
      lowerer.lowerTestCtxProperty(expr) ??
      lowerer.lowerProcessProperty(expr) ??
      lowerer.lowerProcessStreamProperty(expr) ??
      lowerer.lowerFsConstantsProperty(expr) ??
      // http2.constants.NGHTTP2_CANCEL (any constants-object spelling):
      // the baked-literal table.
      lowerer.lowerBuiltinConstantsProperty(expr) ??
      // Builtin namespace imports (`path.sep`, `os.EOL`,
      // `fs.constants.R_OK` where the root is `import * as ...`): the
      // same constants and per-member fences as named builtin imports.
      lowerer.lowerNamespaceBuiltinProperty(expr) ??
      lowerer.lowerJsonProperty(expr) ??
      lowerer.lowerErrorCodeProperty(expr) ??
      lowerer.lowerNumberStaticProperty(expr) ??
      lowerer.lowerMathProperty(expr) ??
      lowerer.lowerIntrinsicProperty(expr) ??
      // The _readableState/_writableState scalar READS (the suite's
      // asserts) — checked before the generic stream property surface:
      // the inner access maps no type of its own.
      lowerStreamStateProperty(lowerer, expr) ??
      lowerStreamObjectProperty(lowerer, expr) ??
      lowerer.lowerUnionProperty(expr) ??
      lowerer.lowerFieldRead(expr);
    // A union-typed field read narrows like an identifier when the
    // checker has narrowed this use to one arm.
    if (handled) {
      if (
        handled.type.kind === "union" &&
        lowerer.armTag(handled.type.unionId, UNDEFINED_T) >= 0 &&
        handled.kind === "recordGet" &&
        lowerer.isRuntimeOptionalField(handled.shapeId, handled.field)
      )
        return handled;
      return lowerer.maybeNarrow(handled, expr);
    }
    // `globalThis.<name>` that no lowering above claimed
    // (globalThis.crypto, globalThis.SubtleCrypto, globalThis.localStorage
    // — the harness's capability-conditional knownGlobals adds): the
    // PROPERTY spelling of the identifier chokepoint's JS rule — a stdlib
    // global taken as a VALUE in a JavaScript source is the same opaque
    // IDENTITY TOKEN the bare spelling answers (`globalThis.crypto` IS
    // `crypto` — one global, one token, or identity flows through Sets
    // and === would disagree between the two spellings). TypeScript
    // sources keep the SC2020 member fence below, like the bare form.
    if (
      !expr.questionDotToken &&
      stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis" &&
      isJsSourceFile(expr.getSourceFile())
    ) {
      const canonical = stdlibGlobalNameOf(lowerer, expr);
      if (canonical !== null) {
        if (!lowerer.dynamic && canonical === "globalThis") return lowerGlobalValue(lowerer, expr);
        if (!lowerer.dynamic && canonical === "ArrayBuffer")
          return { kind: "libCall", fn: "arrayBuffer.constructor", args: [], type: DYN, loc };
        if (!lowerer.dynamic && canonical === "fetch")
          return { kind: "libCall", fn: "fetch.function", args: [], type: DYN, loc };
        if (!lowerer.dynamic && Object.values(BYTES_ELEMENT_NAME).includes(canonical))
          return {
            kind: "libCall",
            fn: "bytes.constructor",
            args: [{ kind: "strLit", value: canonical, type: STRING, loc }],
            type: DYN,
            loc,
          };
        return { kind: "strLit", value: `[builtin ${canonical}]`, type: STRING, loc };
      }
    }
    // A JS receiver whose CHECKER type has no mapping (`mustCallChecks
    // .length` where the binding is an evolving any[] living as a
    // checked-dynamic global): the stdlib member fence below would blame
    // the unmappable checker type (`any[].length`), but the VALUE is a
    // dyn node — lower the receiver first and read through the dyn keyed
    // read (ARR answers length; everything else JS's own-property
    // answer). Mapped receivers keep the fence-first order: their
    // members' gaps are real surface gaps ([1,2].entries), not
    // representation artifacts. `.length` on a receiver whose checker
    // ARRAY type lowers to the checked-dynamic representation —
    // `unknown[]`, the collapsed `(string | object)[]`, and the `any[]`
    // an Array.isArray guard narrows a collapsed union to — is the checked-dynamic tree
    // array's OWN length (a keyed read the ARR kind answers exactly),
    // never an `Array.prototype` surface gap; both source languages.
    // Prototype-method VALUE reads (`ps.map` unparenthesized) keep the
    // fence-first order: a stored-member undefined would mis-answer
    // them, and calls dispatch through the dyn method machinery
    // instead.
    if (
      (isJsSourceFile(expr.getSourceFile()) &&
        (lowerer.mapTypeOf(lowerer.typeOf(expr.expression)) === null ||
          (lowerer.typeOf(expr.expression).flags & ts.TypeFlags.Never) !== 0 ||
          // A never-tainted receiver type maps (never rides as f64) but
          // its VALUE lowered checked-dynamic — same dyn read.
          neverTaintedJsType(lowerer, expr.expression, lowerer.typeOf(expr.expression)))) ||
      (expr.name.text === "length" &&
        (lowerer.checkerAnyArray(expr.expression) ||
          (lowerer.checker.isArrayType(lowerer.typeOf(expr.expression)) &&
            lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "dyn")))
    ) {
      const recv = lowerer.lowerExpr(expr.expression);
      if (recv.type.kind === "dyn") {
        const key: IrExpr = {
          kind: "strLit",
          value: expr.name.text,
          type: STRING,
          loc: locOf(expr.name),
        };
        const opt = hasOptionalChainGuard(expr.expression);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            key,
            ...(opt ? { optional: true as const } : {}),
            value: recv,
            type: DYN,
            loc,
          },
          expr,
        );
      }
      if (
        expr.name.text === "length" &&
        (recv.type.kind === "array" || recv.type.kind === "string")
      ) {
        return recv.type.kind === "array"
          ? { kind: "arrIntrinsic", method: "length", receiver: recv, args: [], type: F64, loc }
          : { kind: "strIntrinsic", method: "length", receiver: recv, args: [], type: F64, loc };
      }
    }
    if (isJsSourceFile(expr.getSourceFile()) && expr.name.text === "constructor") {
      const receiver = tryLowerExpression(lowerer, expr.expression);
      if (
        receiver?.type.kind === "dyn" ||
        (receiver?.type.kind === "object" &&
          !lowerer.classes.get(receiver.type.className)?.fields.has("constructor"))
      ) {
        return {
          kind: "dynKeyGet",
          value: lowerer.coerceToExpected(receiver, DYN),
          key: { kind: "strLit", value: "constructor", type: STRING, loc },
          type: DYN,
          loc,
        };
      }
    }
    // `f.name` / `f.length` / own properties on a FUNCTION-typed JS
    // value (the mustCall wrapper's function-instance members): read
    // through the dyn box — the closure's own-property table answers
    // first (defineProperties writes land there), then the box's
    // best-effort static name and the declared arity; anything else is
    // the own-property answer, undefined. Function.prototype METHOD
    // names stay fenced (a stored-member undefined would mis-answer
    // `f.call` as a value). Static callable values keep the existing TS fence; checked callable
    // storage can expose its own name and length in both source languages.
    if (
      !["apply", "bind", "call", "toString", "caller", "arguments"].includes(expr.name.text) &&
      (isJsSourceFile(expr.getSourceFile()) ||
        expr.name.text === "name" ||
        expr.name.text === "length" ||
        expr.name.text === "constructor")
    ) {
      const probed = tryLowerExpression(lowerer, expr.expression);
      // Inferred callable returns can use checked storage even when the
      // checker still describes a function. Read its actual dyn value;
      // the ambient Function member must not hide its own properties.
      const receiverType = lowerer.typeOf(expr.expression);
      const receiverSymbol = receiverType.getSymbol();
      const checkedFunction =
        lowerer.checker.getCallSignatures(receiverType).length > 0 ||
        (receiverSymbol?.name === "Function" && lowerer.isStdlibSymbol(receiverSymbol));
      if (probed?.type.kind === "dyn" && checkedFunction) {
        const key: IrExpr = {
          kind: "strLit",
          value: expr.name.text,
          type: STRING,
          loc: locOf(expr.name),
        };
        const opt = hasOptionalChainGuard(expr.expression);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            key,
            value: probed,
            ...(opt ? { optional: true as const } : {}),
            type: DYN,
            loc,
          },
          expr,
        );
      }
      if (
        (isJsSourceFile(expr.getSourceFile()) || expr.name.text === "constructor") &&
        probed?.type.kind === "func" &&
        canBoxFuncIntoDyn(
          probed.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        const fnName = jsFuncNameOf(expr.expression);
        const boxed: IrExpr = {
          kind: "dynFrom",
          value: probed,
          type: DYN,
          ...(fnName !== null ? { fnName } : {}),
          loc,
        };
        const key: IrExpr = {
          kind: "strLit",
          value: expr.name.text,
          type: STRING,
          loc: locOf(expr.name),
        };
        return lowerer.maybeNarrow({ kind: "dynKeyGet", key, value: boxed, type: DYN, loc }, expr);
      }
    }
    // A NARROWED IteratorResult receiver (`if (!r.done) r.value` — the
    // checker narrows to IteratorYieldResult/IteratorReturnResult, whose
    // own type cannot map: the shared record shape needs BOTH channels):
    // the receiver's LOWERED record still carries the field, so the read
    // is an ordinary recordGet — maybeNarrow then bridges the union slot
    // to the checker's narrowed arm, exactly like a union field read.
    if (expr.name.text === "done" || expr.name.text === "value") {
      const receiverType = lowerer.typeOf(expr.expression);
      const recvSym =
        receiverType.getAliasSymbol()?.name === "IteratorResult"
          ? receiverType.getAliasSymbol()
          : receiverType.getSymbol();
      if (
        (recvSym?.name === "IteratorResult" ||
          recvSym?.name === "IteratorYieldResult" ||
          recvSym?.name === "IteratorReturnResult") &&
        lowerer.checker
          .declarationsOf(recvSym)
          .some(
            (d) =>
              (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) &&
              lowerer.isStdlibFile(d.getSourceFile()),
          )
      ) {
        const recv = lowerer.lowerExpr(expr.expression);
        if (recv.type.kind === "dyn")
          return lowerer.maybeNarrow(
            {
              kind: "dynKeyGet",
              value: recv,
              key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
              type: DYN,
              loc,
            },
            expr,
          );
        if (recv.type.kind === "record") {
          const shape = lowerer.shapes.get(recv.type.shapeId);
          const field = shape?.fields.find((f) => f.name === expr.name.text);
          if (field) {
            return lowerer.maybeNarrow(
              {
                kind: "recordGet",
                obj: recv,
                shapeId: recv.type.shapeId,
                field: field.name,
                type: field.type,
                loc,
              },
              expr,
            );
          }
        }
      }
    }
    // A chain rooted at an initializer-less ambient `declare const/var`
    // whose declared type has NO mapping (mappable roots compose through
    // the bare-read undefRead and never reach here): Node throws the
    // catchable ReferenceError at the ROOT read before any member
    // matters, so the whole access lowers to that throw — typed by the
    // use site, or by the context it flows into (the throw never
    // returns, so the dummy is never observed).
    {
      const ambientRoot = ambientUndefVarRootOf(lowerer, expr);
      if (ambientRoot !== null) {
        const t = ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr);
        if (t) return nsUndefRead(lowerer, ambientRoot.text, expr, t);
      }
    }
    // Checked-dynamic stdlib results retain ambient property symbols,
    // including parseArgs tokens narrowed to anonymous union arms. Only
    // members owned by these implemented families bypass the stdlib fence.
    const segmentDataSymbol = lowerer.typeOf(expr.expression).getSymbol();
    const segmentDataProperty =
      segmentDataSymbol?.name === "SegmentData" &&
      lowerer.isStdlibSymbol(segmentDataSymbol) &&
      ["segment", "index", "input", "isWordLike"].includes(expr.name.text);
    if (
      isParseArgsDynProperty(lowerer, expr) ||
      isStatFsDynProperty(lowerer, expr) ||
      segmentDataProperty
    ) {
      const recv = lowerer.lowerExpr(expr.expression);
      if (recv.type.kind === "dyn") {
        const key: IrExpr = {
          kind: "strLit",
          value: expr.name.text,
          type: STRING,
          loc: locOf(expr.name),
        };
        const opt = hasOptionalChainGuard(expr.expression);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            key,
            ...(opt ? { optional: true as const } : {}),
            value: recv,
            type: DYN,
            loc,
          },
          expr,
        );
      }
    }
    // A member read through a NULLISH generic binding (`const i: I<A &
    // B> = null as any; const _i: I<A> = i.something` — the receiver
    // provably holds null/undefined forever): the read throws Node's
    // exact TypeError at the access.
    if (ts.isIdentifier(expr.expression) && expr.questionDotToken === undefined) {
      const unit = nullishGenericBindingUnitOf(
        lowerer,
        lowerer.resolveValueSymbol(expr.expression),
      );
      if (unit !== null) {
        const t =
          ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
        return nodeThrowExpr(
          1,
          "",
          `Cannot read properties of ${unit} (reading '${expr.name.text}')`,
          t,
          loc,
        );
      }
    }
    // The lib fence's PROPERTY chokepoint: a stdlib-declared member that
    // no lowering above claimed ([1,2].entries, Math.SQRT2, Promise.all,
    // re.exec as a value, ...) reports SC2020 here.
    lowerer.stdlibMemberFence(expr);
    // The npm chokepoint: a member on a package-typed receiver in a
    // static build — attributed to the package, like every other site.
    lowerer.npmMemberFence(expr);
    // A property read rooted at a BLOCKED binding: the declaration
    // carries the real diagnostic — the SC2004 cascade, not a generic
    // "property access" rejection.
    {
      let root: ts.Expression = expr.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root) && lowerer.isBlockedBinding(lowerer.resolveValueSymbol(root))) {
        lowerer.pushDiag(blockedBindingUseDiag(root.text, loc));
        throw new PoisonError();
      }
    }
    // Nothing claimed the member. Lower the RECEIVER before rejecting:
    // when the receiver itself is the blocker (`(await import(x)).y` —
    // the dynamic import is the unsupported part), ITS diagnostic is the
    // honest one, not a generic recitation about the outer dot. A
    // receiver that lowers cleanly means the MEMBER is the gap — name
    // the property and the receiver's type instead of "property access".
    const recvLowered = lowerer.lowerExpr(expr.expression);
    // A dyn receiver — JSON.parse's `any`, or `unknown` the checker
    // narrowed to `object` — reads through the dyn keyed read: member
    // or undefined (JS's own-property answer), throwing JS's TypeError
    // on undefined/null receivers unless an earlier `?.` guards the
    // chain. Scalar-narrowed occurrences bridge via maybeNarrow's
    // validated dynCheck as usual.
    if (
      recvLowered.type.kind === "dyn" ||
      (isJsSourceFile(expr.getSourceFile()) &&
        (["f64", "bool", "bigint", "string", "symbol"].includes(recvLowered.type.kind) ||
          (recvLowered.type.kind === "union" && lowerer.dynConvertible(recvLowered.type))))
    ) {
      const key: IrExpr = {
        kind: "strLit",
        value: expr.name.text,
        type: STRING,
        loc: locOf(expr.name),
      };
      const opt = hasOptionalChainGuard(expr.expression);
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          key,
          ...(opt ? { optional: true as const } : {}),
          value: lowerer.coerceToExpected(recvLowered, DYN),
          type: DYN,
          loc,
        },
        expr,
      );
    }
    // The lowered receiver is a RECORD the checker spelled wider —
    // `s.match(re).groups.key` in a JS file: the checker says
    // `{ [key: string]: string } | undefined`, but the groups
    // projection already answered the record arm (its null trap
    // included). Declared fields read directly; an index-signature
    // shape serves undeclared keys through the overflow read, exactly
    // the dot-access rule on checker-spelled hybrids.
    if (recvLowered.type.kind === "record") {
      const recvShape = lowerer.shapes.get(recvLowered.type.shapeId);
      const field = recvShape?.fields.find((f) => f.name === expr.name.text);
      if (field) {
        return lowerer.maybeNarrow(
          {
            kind: "recordGet",
            obj: recvLowered,
            shapeId: recvLowered.type.shapeId,
            field: field.name,
            type: field.type,
            loc,
          },
          expr,
        );
      }
      if (recvShape?.indexValue !== undefined && !recvShape.tuple) {
        return lowerer.maybeNarrow(
          {
            kind: "recordKeyGet",
            obj: recvLowered,
            shapeId: recvLowered.type.shapeId,
            key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
            overflowOnly: true,
            type: recvShape.indexValue,
            loc,
          },
          expr,
        );
      }
      // An inferred package-JS call specializes a parameter to the
      // caller's own record shape. Optional option names omitted by that
      // caller read undefined; the missing field is not a failed type
      // assertion. Known prototype members were handled/fenced above.
      if (
        recvShape &&
        !recvShape.tuple &&
        lowerer.implicitParamTypes !== null &&
        isJsSourceFile(expr.getSourceFile()) &&
        npmStaticPackageOfPath(expr.getSourceFile().fileName) !== null
      ) {
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: recvLowered, loc }],
          result: dynUndefinedExpr(loc),
          type: DYN,
          loc,
        };
      }
    }
    // An ABSTRACT property through an abstract-typed receiver: the
    // declaration is erased at runtime — Node defines no field for it,
    // each concrete subclass declares its OWN (at its own layout
    // position), so no shared base slot exists to read. Abstract
    // ACCESSORS are the supported spelling: they declare a vtable slot.
    if (recvLowered.type.kind === "object" && abstractPropertyDeclOf(lowerer, expr)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `reading the abstract property '${expr.name.text}' through a '${lowerer.checker.typeToString(lowerer.typeOf(expr.expression))}'-typed receiver (abstract property declarations are erased at runtime, so no shared slot exists — type the receiver as the concrete class, or declare an abstract getter instead)`,
      );
    }
    // Array reads may add an undefined arm even when the checker still
    // reports a class. Its property bag must remain reachable, while
    // an absent element takes the normal checked-value TypeError.
    const nativeReceiver = lowerer.stripUndefinedArm(recvLowered.type);
    if (ts.isPrivateIdentifier(expr.name) && recvLowered.type.kind === "object") {
      const field = lowerer.classes.get(recvLowered.type.className)?.fields.get(expr.name.text);
      if (field)
        return {
          kind: "fieldGet",
          obj: recvLowered,
          className: recvLowered.type.className,
          field: expr.name.text,
          type: field,
          loc,
        };
    }
    if (nativeReceiver.kind === "object" && nativeReceiver.className === "%Error") {
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          value: lowerer.coerceToExpected(recvLowered, DYN),
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
          type: DYN,
          loc,
        },
        expr,
      );
    }
    if (isDynTypedRefType(nativeReceiver)) {
      const info = lowerer.classes.get(nativeReceiver.className);
      if (
        info &&
        !info.def.runtime &&
        !info.builtinError &&
        !info.builtinEmitter &&
        !info.builtinStream
      ) {
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            value: lowerer.coerceToExpected(recvLowered, DYN),
            key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
            type: DYN,
            loc,
          },
          expr,
        );
      }
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `reading '${expr.name.text}' from a value of type '${lowerer.checker.typeToString(lowerer.typeOf(expr.expression))}'`,
    );
  }

  // Meta-properties, named: `new.target` reflects HOW a function was
  // invoked (compiled functions are never constructors of themselves —
  // no runtime invocation record exists), and `import.meta`/
  // `import.defer` are module-loader surface a native binary does not
  // carry.
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

function moduleFileName(lowerer: Lowerer, sf: ts.SourceFile): string {
  return lowerer.targetPlatform === "wasi"
    ? (wasiGuestPath(sf.fileName) ?? sf.fileName.replace(/\\/g, "/"))
    : sf.fileName;
}

function importMetaProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  return isImportMeta(expr.expression) ? importMetaField(lowerer, expr, expr.name.text) : null;
}

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
      c.arguments.length === 1 &&
      ts.isIdentifier(c.arguments[0]!) &&
      lowerer.stdlibGlobalMember(c.expression, "Array") === "isArray"
    ) {
      const argIdent = c.arguments[0] as ts.Identifier;
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
          n.forEachChild(collect);
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
      if (!lit || lit.elements.length !== 0) return false;
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
      return lowerer.lowerExpr(e);
    };
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
        t.kind !== "dyn" && t.kind !== "caught" && t.kind !== "jsval" && t.kind !== "void";
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
      isJsSourceFile(expr.getSourceFile()) &&
      thenRaw.type.kind === "func" &&
      elseRaw.type.kind === "func" &&
      !typeEquals(thenRaw.type, elseRaw.type) &&
      lowerer.dynConvertible(thenRaw.type) &&
      lowerer.dynConvertible(elseRaw.type);
    // JavaScript inference can discard an initially-undefined field from
    // a conditional's type even after that field acquired other values.
    // A checked arm must retain its actual representation at the join.
    const checkedJsJoin =
      isJsSourceFile(expr.getSourceFile()) &&
      (thenRaw.type.kind === "dyn" || elseRaw.type.kind === "dyn") &&
      lowerer.dynConvertible(thenRaw.type) &&
      lowerer.dynConvertible(elseRaw.type);
    const type =
      callableJoin || checkedJsJoin
        ? DYN
        : thenRaw.type.kind === "array" && typeEquals(thenRaw.type, elseRaw.type)
          ? thenRaw.type
          : dynJoin
            ? DYN
            : (anyJoin ?? (useCtx && ctxMapped ? ctxMapped : lowerer.irTypeOf(expr)));
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

/** Checker-driven union narrowing. tsc's control-flow analysis narrows a
 * union-typed reference at use sites (`if (r.kind === "ok") { ...r... }`
 * types `r` as the ok-arm inside the branch); the IR value is still the
 * tagged union, so the read is bridged with a `unionNarrow` extracting
 * the arm's payload. The extraction is tag-UNCHECKED at runtime —
 * soundness rests entirely on tsc having proven the tag (the project's
 * trust-the-checker thesis; see docs/ir.md). A checker type that maps to
 * the same union (unnarrowed use), to a SUB-union (partial narrowing —
 * unrepresentable without a re-tag), or to nothing (`never` in an
 * exhaustive default) leaves the expression union-typed. */
export function maybeNarrow(lowerer: Lowerer, expr: IrExpr, node: ts.Node): IrExpr {
  if (
    (expr.type.kind === "union" || expr.type.kind === "dyn") &&
    isJsSourceFile(node.getSourceFile()) &&
    ts.isPropertyAccessExpression(node)
  ) {
    const symbol = lowerer.checker.getSymbolAtLocation(node.name);
    if (
      symbol &&
      lowerer.checker
        .declarationsOf(symbol)
        .some(
          (decl) =>
            ts.isPropertyDeclaration(decl) &&
            !decl.initializer &&
            !decl.type &&
            isJsSourceFile(decl.getSourceFile()),
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
    // An inferred JS member's storage may be deliberately wider than its
    // declaration (prototype-selected buffers, null-initialized scratch
    // objects). Extract at the consuming operation, not at the read.
    if (isJsSourceFile(node.getSourceFile()) && ts.isPropertyAccessExpression(node)) {
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
      isJsSourceFile(node.getSourceFile()) &&
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
    if (isJsSourceFile(node.getSourceFile()) && ts.isIdentifier(node)) {
      const symbol = lowerer.resolveValueSymbol(node);
      if (
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .some(
            (decl) =>
              ts.isParameter(decl) &&
              ts.isMethodDeclaration(decl.parent) &&
              lowerer.checkedVirtualJsMethods.has(decl.parent),
          )
      )
        return expr;
      if (
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .some((decl) => ts.isParameter(decl) && ts.isConstructorDeclaration(decl.parent))
      )
        return expr;
      if (
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .some((decl) => ts.isVariableDeclaration(decl) && jsBindingHasOpenWrites(lowerer, decl))
      )
        return expr;
      if (
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .some(
            (decl) =>
              ts.isParameter(decl) &&
              decl.initializer &&
              !decl.type &&
              !/@(?:param|type)\b/.test(
                decl.getSourceFile().text.slice(decl.parent?.pos ?? decl.pos, decl.getStart()),
              ),
          )
      )
        return expr;
      if (
        symbol &&
        lowerer.checker.declarationsOf(symbol).some((decl) => {
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
      isJsSourceFile(node.getSourceFile()) &&
      ts.isPropertyAccessExpression(node) &&
      ["isTTY", "columns", "rows"].includes(node.name.text) &&
      lowerer.isStdlibMember(node)
    )
      return expr;
    // A null-initialized JS field can later receive an object even when
    // checker flow calls its non-null branch never. The live checked
    // value remains authoritative; never is not a numeric guard.
    if (
      isJsSourceFile(node.getSourceFile()) &&
      (lowerer.typeOf(node).flags & ts.TypeFlags.Never) !== 0
    )
      return expr;
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
  // type), so the read bridges with an unchecked static downcast — the
  // same trust-the-checker contract as the union bridge below.
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
      return { kind: "downcast", value: expr, type: narrowed, loc: expr.loc };
    }
    return expr;
  }
  if (expr.type.kind !== "union") return expr;
  if (ts.isPropertyAccessExpression(node) && isOptionalProcessStreamProperty(lowerer, node))
    return expr;

  // Represented fields and index values can include undefined even when
  // checker inference or lib.d.ts declares strings (RegExp captures).
  // Only a declaration that represents the optional arm can provide a
  // trustworthy flow narrowing; otherwise consumers must check it.
  if (
    (expr.kind === "recordGet" || expr.kind === "recordKeyGet") &&
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  ) {
    const receiver = lowerer.mapTypeOf(lowerer.typeOf(node.expression));
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
  }
  if (ts.isIdentifier(node)) {
    const symbol = lowerer.resolveValueSymbol(node);
    if (symbol && lowerer.unstableSwitchBindings.has(symbol)) return expr;
  }
  const narrowedTs = lowerer.typeOf(node);
  const narrowed = lowerer.mapTypeOf(narrowedTs);
  // `Array.isArray(u)` on a union with one readonly array/tuple arm: the
  // lib predicate narrows to `any[]`, either directly or intersected
  // with the original union. That checker type can map to the island's
  // array-of-handles, nothing, or a synthetic intersection record — but
  // the tag test proved the union's one array-valued arm, so bridge to it
  // with the same trusted unionNarrow the mapped case below builds.
  if (lowerer.checkerAnyArrayType(narrowedTs)) {
    const def = lowerer.unions.get(expr.type.unionId);
    const arrayTags = lowerer.arrayValueTags(expr.type.unionId);
    if (arrayTags.length === 1) {
      const arm = def!.arms[arrayTags[0]!]!;
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
  // A checker type narrowed to a UNIT arm (the `=== undefined` branch)
  // also stays union-typed: a unit arm has no payload to extract, and
  // nothing useful reads such a value anyway. (Standalone undefined maps
  // to void and standalone null to nothing, so the isUnitType guard is
  // defensive.)
  if (!narrowed || narrowed.kind === "union" || narrowed.kind === "void" || isUnitType(narrowed)) {
    return expr;
  }
  const tag = lowerer.armTag(expr.type.unionId, narrowed);
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
  return {
    kind: "unionNarrow",
    unionId: expr.type.unionId,
    tag,
    value: expr,
    type: narrowed,
    loc: expr.loc,
  };
}

/** A runtime-optional slot can be assigned while a truthy guard is in
 * force. TypeScript then types a direct member receiver as the plain arm,
 * even though an OOB-safe assignment may have restored undefined. Check
 * that hidden arm and throw the member-read TypeError Node would produce. */
function runtimeOptionalReceiverRead(
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
      lowerer.unsupported(
        "SC1090",
        expr,
        "a runtime-optional capture whose narrowed union is not representable",
      );
    }
    return {
      kind: "call",
      callee: helper,
      args: [varRef(local.id, local.type, loc)],
      type: narrowed,
      loc,
    };
  }
  const undefTag = lowerer.armTag(local.type.unionId, UNDEFINED_T);
  const def = lowerer.unions.get(local.type.unionId);
  if (!def || undefTag < 0)
    throw new InternalCompilerError("runtime-optional local is missing its undefined arm");
  if (def.arms.length !== 2) {
    // The checker may narrow a runtime-optional capture to one arm of a
    // value union (`Circle | Square | undefined` -> `Circle`). The
    // two-arm fast path below cannot extract that arm safely: a later
    // array mutation can leave any of the stored tags in the slot. Use
    // the checked helper so every other arm, including undefined, remains
    // a catchable TypeError rather than an unchecked payload read.
    const helper = lowerer.narrowedArmHelper(local.type.unionId, narrowed, loc);
    if (!helper) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "a direct read from a runtime-optional capture with multiple value arms",
      );
    }
    return {
      kind: "call",
      callee: helper,
      args: [varRef(local.id, local.type, loc)],
      type: narrowed,
      loc,
    };
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
  const message =
    property === null
      ? `${expr.text} is not a function`
      : `Cannot read properties of undefined (reading '${property}')`;
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

function runtimeOptionalUseOf(expr: ts.Expression): RuntimeOptionalUse | null {
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

/** Object.keys/Object.entries require an object receiver, but their first
 * argument is not syntactically a member receiver. Recognize that one
 * standard-library position so a runtime-optional loop element can be
 * checked against the checker-narrowed record arm before builtin lowering. */
function runtimeOptionalObjectWalkerArg(lowerer: Lowerer, expr: ts.Expression): boolean {
  let arg = expr;
  while (
    (ts.isParenthesizedExpression(arg.parent) ||
      ts.isAssertionExpression(arg.parent) ||
      ts.isSatisfiesExpression(arg.parent) ||
      ts.isNonNullExpression(arg.parent)) &&
    arg.parent.expression === arg
  ) {
    arg = arg.parent;
  }
  const call = arg.parent;
  if (
    !ts.isCallExpression(call) ||
    call.arguments[0] !== arg ||
    !ts.isPropertyAccessExpression(call.expression)
  )
    return false;
  const access = call.expression;
  return (
    (access.name.text === "keys" || access.name.text === "entries") &&
    lowerer.isStdlibMember(access)
  );
}

function runtimeOptionalElementKey(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) return expr.text;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

function runtimeOptionalAssertionErases(
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

/** `v === undefined` / `v !== null` — the narrowing tests for unit-armed
 * unions. A union operand compared with a unit literal lowers to a
 * runtime TAG test (unionIsTag); afterwards tsc's control-flow narrowing
 * types the branches and reads bridge through maybeNarrow as usual. When
 * the checker already narrowed the non-literal side PAST the union
 * (`w = 5; if (w !== null)`), the comparison is statically decided and
 * folds to a bool literal — that drops only a side-effect-free read
 * (flow narrowing applies to references, never to calls), and soundness
 * is the same trust-the-checker bet unionNarrow already makes. Null when
 * neither side is a unit literal (not a unit comparison). */
export function lowerUnitComparison(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  negated: boolean,
  loc: SrcLoc,
): IrExpr | null {
  const unit = left.kind === "unitLit" ? left : right.kind === "unitLit" ? right : null;
  if (!unit) return null;
  const other = unit === left ? right : left;
  if (other.kind === "unitLit") {
    // Two unit literals (`undefined === undefined`): statically decided.
    return { kind: "boolLit", value: (other.unit === unit.unit) !== negated, type: BOOL, loc };
  }
  if (other.type.kind === "union") {
    const tag = lowerer.armTag(other.type.unionId, unit.type);
    if (tag < 0) {
      // A union WITHOUT that unit arm: legal TS (`miss === null` on a
      // `number | undefined` — null/undefined guard comparisons are
      // permitted against nullable-adjacent types), and === never
      // coerces, so the answer is the constant `negated`. The literal
      // must NOT flow into the union representation (the unionEq
      // fallback would coerce it through the stranded-arm trap and
      // throw where Node answers false). JS still evaluates the
      // operand, so a non-droppable one (`xs.find(f) === null` — the
      // callback's effects are observable) rides one throwaway tag
      // test; droppable reads fold to the bare literal.
      const answer: IrExpr = { kind: "boolLit", value: negated, type: BOOL, loc };
      if (isSafeToDiscard(other)) return answer;
      const evalOnce: IrExpr = {
        kind: "unionIsTag",
        unionId: other.type.unionId,
        tag: 0,
        negated: false,
        value: other,
        type: BOOL,
        loc,
      };
      return {
        kind: "logical",
        op: negated ? "||" : "&&",
        left: evalOnce,
        right: answer,
        type: BOOL,
        loc,
      };
    }
    return {
      kind: "unionIsTag",
      unionId: other.type.unionId,
      tag,
      negated,
      value: other,
      type: BOOL,
      loc,
    };
  }
  // A process.env read tsc narrowed past its union (an earlier write to
  // the same key): the environment is VOLATILE — `delete process.env.K`
  // undoes the write the narrowing rode on — so folding would bake a
  // stale answer. Compare the fresh read's union tag instead.
  const envRead = volatileEnvRead(other);
  if (envRead && envRead.type.kind === "union") {
    const tag = lowerer.armTag(envRead.type.unionId, unit.type);
    if (tag >= 0) {
      return {
        kind: "unionIsTag",
        unionId: envRead.type.unionId,
        tag,
        negated,
        value: envRead,
        type: BOOL,
        loc,
      };
    }
  }
  // A VOID-typed operand (`foo() === undefined` where foo's declared
  // return is undefined/void — the mapping folds both to void): JS
  // yields undefined from such a call, so the compare is TRUE-when-equal
  // — the opposite of the never-holds-units fold below — and the IR has
  // no value (nor a sequence form to keep the call's effects). Fall
  // through to the caller's comparison fence instead of folding a lie.
  if (other.type.kind === "void") return null;
  // Non-union operand: it can never hold undefined/null at runtime (the
  // checker narrowed it to a concrete arm), so `=== unit` is false and
  // `!== unit` is true.
  return { kind: "boolLit", value: negated, type: BOOL, loc };
}

/** The union-typed process.envGet read inside a checker-narrowed operand,
 * or null — the volatility escape above (and lowerLooseNullCompare's). */
function volatileEnvRead(e: IrExpr): IrExpr | null {
  if (e.kind === "libCall" && e.fn === "process.envGet") return e;
  if (e.kind === "unionNarrow" && e.value.kind === "libCall" && e.value.fn === "process.envGet") {
    return e.value;
  }
  return null;
}

/** `x == null` / `x != null` — JS's idiomatic null-OR-undefined test, the
 * ONE loose comparison with static semantics: `== null` matches exactly
 * null and undefined (0, "", and false do not). Requires a syntactic
 * null LITERAL on either side; the other operand's unit arms become a
 * runtime tag test — one `unionIsTag` when the union has a single unit
 * arm, a short-circuit pair over both tags otherwise (that shape re-emits
 * the operand, so only side-effect-free reads compose; anything else
 * keeps the fence). A unit-literal operand folds (null and undefined are
 * mutually loose-equal), and a non-nullable operand folds statically —
 * the same trust-the-checker bet as lowerUnitComparison. Null (fence)
 * when this isn't a null-literal comparison or the operand has no
 * lowering here (dyn/jsval/void). */
function lowerLooseNullCompare(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
  const left = unwrap(expr.left);
  const right = unwrap(expr.right);
  const leftIsNull = left.kind === ts.SyntaxKind.NullKeyword;
  if (!leftIsNull && right.kind !== ts.SyntaxKind.NullKeyword) return null;
  const otherNode = leftIsNull ? right : left;
  const other = lowerer.lowerExpr(otherNode);
  if (isUnitType(other.type)) {
    // `null == null`, `undefined == null`: units are mutually loose-equal.
    return { kind: "boolLit", value: !negated, type: BOOL, loc };
  }
  if (other.type.kind === "dyn") {
    // `v != null` on unknown: one dyn kind test covers both units.
    return {
      kind: "dynTest",
      test: "nullish",
      ...(negated ? { negated: true as const } : {}),
      value: other,
      type: BOOL,
      loc,
    };
  }
  if (other.type.kind === "union") {
    const ut = other.type;
    const def = lowerer.unions.get(ut.unionId);
    if (!def) lowerer.badType(otherNode, lowerer.typeOf(otherNode));
    const tags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
    if (tags.length === 0) {
      // No unit arms: never null-ish (defensive — the fold below).
      return { kind: "boolLit", value: negated, type: BOOL, loc };
    }
    const isTag = (tag: number): IrExpr => ({
      kind: "unionIsTag",
      unionId: ut.unionId,
      tag,
      negated,
      value: other,
      type: BOOL,
      loc,
    });
    if (tags.length === 1) return isTag(tags[0]!);
    // Both null AND undefined arms: tag-in-set as a short-circuit pair
    // (De Morgan for `!=`). The operand IrExpr rides both tests, so the
    // backend emits it per test — restricted to re-emittable pure reads;
    // anything effectful gets its own actionable fence (the generic
    // SC1040 hint would wrongly suggest `== null` as the fix).
    if (!isSafeToRepeat(other)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `'== null' / '!= null' on a '${lowerer.fmt(ut)}' value that isn't a plain read ` +
          `(both unit arms need the operand twice — bind it to a const first)`,
      );
    }
    return {
      kind: "logical",
      op: negated ? "&&" : "||",
      left: isTag(tags[0]!),
      right: isTag(tags[1]!),
      type: BOOL,
      loc,
    };
  }
  if (other.type.kind === "jsval" || other.type.kind === "void") {
    return null; // no static tag to test — keep the fence
  }
  // The env-volatility escape (see lowerUnitComparison): a narrowed
  // process.env read compares its FRESH union tag instead of folding.
  const envRead = volatileEnvRead(other);
  if (envRead && envRead.type.kind === "union") {
    const def = lowerer.unions.get(envRead.type.unionId);
    const tag = def ? def.arms.findIndex((a) => isUnitType(a)) : -1;
    if (tag >= 0) {
      return {
        kind: "unionIsTag",
        unionId: envRead.type.unionId,
        tag,
        negated,
        value: envRead,
        type: BOOL,
        loc,
      };
    }
  }
  // A non-nullable operand (tsc allows the comparison as a guard):
  // `== null` is statically false, `!= null` statically true.
  return { kind: "boolLit", value: negated, type: BOOL, loc };
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
    lowerAbsenceProbe(lowerer, first.left) ?? lowerer.lowerExpr(first.left),
  );
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i]!;
    result = lowerNullishPair(lowerer, parent, parent === expr ? loc : locOf(parent), result);
  }
  return result;
}

function lowerNullishPair(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
  left: IrExpr,
): IrExpr {
  if (left.type.kind === "dyn") {
    // `a ?? b` on a CHECKED-DYNAMIC left: the deciding test is the
    // runtime kind (scr_dyn_is_nullish — UNDEF/NULL take the default;
    // a wrapped island value routes to the engine's test, defensively:
    // the wrap constructor scalar-normalizes engine null/undefined
    // away). Both sides live in the checked-dynamic tree — the right converts through
    // the usual boundary and evaluates lazily in its branch; a default
    // with no dyn representation keeps the fence.
    const right = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
    if (right.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1100",
        expr,
        "nullish coalescing on 'unknown' values against defaults with no dynamic representation",
      );
    }
    return { kind: "nullish", left, right, type: DYN, loc };
  }
  if (left.type.kind === "jsval") {
    // `a ?? b` on an ISLAND value: the engine's own nullish test — the
    // left evaluates once, the right runs lazily in its branch and
    // marshals in (the emitter's jsval nullish arm).
    const right = lowerer.jsvalIn(lowerer.lowerExpr(expr.right), expr.right);
    return { kind: "nullish", left, right, type: JSVAL, loc };
  }
  if (left.type.kind !== "union") return left;
  const def = lowerer.unions.get(left.type.unionId);
  if (!def) lowerer.badType(expr.left, lowerer.typeOf(expr.left));
  if (!def.arms.some(isUnitType)) return left;
  const rest = def.arms.filter((a) => !isUnitType(a));
  // `optionalMap ?? new Map()` carries its element contract on the left;
  // the empty fallback may use it without constructing a Map<any, any>
  // arm that has no first-class union representation.
  const fresh = rest.length === 1 ? lowerer.emptyCollectionFor(expr.right, rest[0]!) : null;
  if (fresh) return { kind: "nullish", left, right: fresh, type: fresh.type, loc };
  let type = lowerer.irTypeOf(expr);
  // A runtime-optional read can reach the default even when declarations
  // call the left side present. Preserve a differently typed primitive
  // fallback rather than checking it against that incomplete result type.
  const rightType = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
  const primitive = (t: IrType): boolean =>
    t.kind === "f64" || t.kind === "string" || t.kind === "bool";
  if (
    rightType &&
    primitive(type) &&
    primitive(rightType) &&
    !typeEquals(type, rightType) &&
    rest.every(primitive)
  ) {
    const arms = [...rest];
    if (!arms.some((arm) => typeEquals(arm, rightType))) arms.push(rightType);
    arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    type = { kind: "union", unionId: lowerer.unions.intern(arms) };
    lowerer.runtimeOptionalArithmeticTypes.set(expr, type);
  }
  if (type.kind === "dyn" && lowerer.dynConvertible(left.type)) {
    return {
      kind: "nullish",
      left: lowerer.coerceToExpected(left, DYN),
      right: lowerer.lowerExprExpecting(expr.right, DYN),
      type: DYN,
      loc,
    };
  }
  if (typeEquals(type, left.type) || (rest.length === 1 && typeEquals(type, rest[0]!))) {
    const right = lowerer.lowerExprExpecting(expr.right, type);
    return { kind: "nullish", left, right, type, loc };
  }
  if (type.kind !== "union" && rest.length > 1 && rest.some((arm) => typeEquals(arm, type))) {
    const helper = lowerer.narrowedArmHelper(left.type.unionId, type, loc);
    if (helper !== null) {
      return nullishBranches(
        lowerer,
        left,
        left.type,
        def.arms,
        type,
        loc,
        () => lowerer.lowerExprExpecting(expr.right, type),
        (stable) => ({ kind: "call", callee: helper, args: [stable], type, loc }),
      );
    }
  }
  // A default may change the union or widen its records. Test the
  // original tag before coercing: converting the whole left first can
  // lose nullish arms, and evaluating the default eagerly loses laziness.
  if (type.kind === "union") {
    const retag =
      lowerer.unionRetagHelper(left.type.unionId, type.unionId, loc) ??
      lowerer.narrowedRetagHelper(expr.left, left.type.unionId, type.unionId, loc);
    if (retag !== null) {
      // Narrowing may exclude a record/class arm while storage retains
      // it. The checked retag traps that impossible arm, but only AFTER
      // the original nullish test: null/undefined must reach the lazy
      // default even when neither is representable in the result.
      return nullishBranches(
        lowerer,
        left,
        left.type,
        def.arms,
        type,
        loc,
        () => lowerer.lowerExprExpecting(expr.right, type),
        (stable) => ({ kind: "call", callee: retag, args: [stable], type, loc }),
      );
    }
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    rest.length !== 1
      ? `'??' on '${lowerer.fmt(left.type)}' (the non-nullish result is a sub-union; check a discriminant field first)`
      : `'??' where the default changes the result type (left is '${lowerer.fmt(left.type)}' but the whole expression is '${lowerer.fmt(type)}' — give both sides one type)`,
  );
}

/** Test the original storage before projecting its present value. Both
 * branches are lazy, and an effectful receiver is evaluated exactly once.
 * Keeping the original tags matters when the checker has removed an arm
 * or the default changes the union's layout. */
function nullishBranches(
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
  if (ts.isPropertyAccessExpression(e)) {
    const presence = lowerPromiseThenPresence(lowerer, e, {
      kind: "boolLit",
      value: true,
      type: BOOL,
      loc: locOf(e),
    });
    if (presence !== null) return presence;
  }
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
  return lowerer.ensureBool(lowerAbsenceProbe(lowerer, expr) ?? lowerer.lowerExpr(expr), expr);
}

function lowerPromiseThenPresence(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  result: IrExpr,
): IrExpr | null {
  if (access.name.text !== "then") return null;
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
      receiver = {
        kind: "call",
        callee: helper,
        args: [receiver],
        type: promiseType,
        loc: receiver.loc,
      };
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

function runtimeOptionalLocalOf(lowerer: Lowerer, node: ts.Expression): IrLocal | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return null;
  const local = lowerer.resolveLocal(expr);
  return local && lowerer.runtimeOptionalLocals.has(lowerer.runtimeOptionalRootOf(local))
    ? local
    : null;
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
  if (e.type.kind === "jsval") {
    // ToBoolean of an island value — the engine answers (never throws).
    return { kind: "jsOp", op: "truthy", args: [e], type: BOOL, loc: e.loc };
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

/** Truthiness needs a ToBoolean per arm: dyn/caught arms have none (a
 * dynamic ToBoolean over the checked-dynamic tree / the snapshot box) — fence those
 * unions; every other arm kind is answerable (units false, scalars and
 * strings by value, refs true, jsval by the engine). */
export function requireTruthyUnion(lowerer: Lowerer, unionId: string, node: ts.Expression): void {
  const def = lowerer.unions.get(unionId);
  if (def && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught")) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `union-typed conditions with 'unknown' arms (${NARROW_FIRST})`,
  );
}

/** Strict equality needs a per-arm comparison: units, scalars, strings,
 * and ref kinds (pointer identity) all have one; dyn/caught arms have no
 * static equality and jsval arms would need the engine's `===` — those
 * unions keep the narrow-first fence. */
export function eqComparableUnion(lowerer: Lowerer, unionId: string): boolean {
  const def = lowerer.unions.get(unionId);
  return (
    !!def && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught" && a.kind !== "jsval")
  );
}

/** Property access on a string or array receiver: `.length` lowers to the
 * matching intrinsic; a bare method reference (`const f = s.slice` — a
 * function value) is rejected with a specific message. Returns null for
 * other receivers (the generic property-access rejection applies). Both
 * the receiver type AND the ambient-file provenance of the member are
 * verified — the name alone proves nothing. */
export function lowerIntrinsicProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  for (const name of ["String", "Number", "Boolean", "BigInt"] as (
    | "String"
    | "Number"
    | "Boolean"
    | "BigInt"
  )[]) {
    if (!lowerer.chainBlocked(expr) && lowerer.isStdlibGlobal(expr, name)) {
      return primitiveCtorClosure(lowerer, name, locOf(expr), isJsSourceFile(expr.getSourceFile()));
    }
  }
  if (lowerer.stdlibGlobalMember(expr, "Reflect") === "ownKeys") {
    const value = lowerer.lowerNativeCallableValue(
      {
        fn: "dyn.ownKeys",
        params: [DYN],
        result: DYN,
        valueParams: [{ mode: "required", type: DYN }],
      },
      "Reflect.ownKeys",
      locOf(expr),
    )!;
    return { kind: "dynFrom", value, fnName: "ownKeys", type: DYN, loc: locOf(expr) };
  }
  if (lowerer.chainBlocked(expr)) return null;
  const builtinPrototype = builtinPrototypeMethod(lowerer, expr);
  if (builtinPrototype)
    return {
      kind: "libCall",
      fn: "dyn.builtinMethod",
      args: [
        { kind: "strLit", value: builtinPrototype, type: STRING, loc: locOf(expr) },
        { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
      ],
      type: DYN,
      loc: locOf(expr),
    };
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "Array") === "prototype"
  ) {
    return {
      kind: "dynKeyGet",
      value: {
        kind: "libCall",
        fn: "dyn.arrayPrototype",
        args: [],
        type: DYN,
        loc: locOf(expr.expression),
      },
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
      type: DYN,
      loc: locOf(expr),
    };
  }
  if (
    expr.name.text === "apply" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "Function") === "prototype"
  )
    return { kind: "libCall", fn: "dyn.functionApply", args: [], type: DYN, loc: locOf(expr) };
  if (lowerer.stdlibGlobalMember(expr, "Array") === "prototype")
    return { kind: "libCall", fn: "dyn.arrayPrototype", args: [], type: DYN, loc: locOf(expr) };
  if (lowerer.stdlibGlobalMember(expr, "Object") === "prototype")
    return { kind: "libCall", fn: "dyn.objectPrototype", args: [], type: DYN, loc: locOf(expr) };
  if (lowerer.stdlibGlobalMember(expr, "Array") === "isArray")
    return lowerArrayIsArrayValue(lowerer, locOf(expr));
  if (lowerer.stdlibGlobalMember(expr, "Array") === "from")
    return lowerArrayFromValue(lowerer, locOf(expr));
  const stringMember = lowerer.stdlibGlobalMember(expr, "String");
  if (stringMember === "fromCharCode" || stringMember === "fromCodePoint")
    return lowerStringCodesValue(lowerer, stringMember, locOf(expr));
  const numberMember = lowerer.stdlibGlobalMember(expr, "Number");
  if (numberMember === "parseInt" || numberMember === "parseFloat")
    return lowerNumberParserValue(lowerer, numberMember, locOf(expr));
  if (lowerer.stdlibGlobalMember(expr, "Buffer") === "isBuffer")
    return lowerCheckedPredicateValue(lowerer, "Buffer.isBuffer", "buffer", locOf(expr));
  if (lowerer.stdlibGlobalMember(expr, "Date") === "now")
    return lowerer.lowerNativeCallableValue(
      {
        fn: "date.now",
        params: [],
        result: F64,
        valueParams: [],
      },
      "Date.now",
      locOf(expr),
    );
  if (stdlibGlobalNameOf(lowerer, expr.expression) === "Object") {
    if (expr.name.text === "assign") return lowerObjectAssignValue(lowerer, locOf(expr));
    const fn = own(OBJECT_CALLABLE_VALUES, expr.name.text);
    if (fn) return lowerer.lowerNativeCallableValue(fn, `Object.${expr.name.text}`, locOf(expr));
  }
  // A never-tainted JS receiver type lowered checked-dynamic
  // (neverTaintedJsType — `cmd.length` on `const cmd = ['pwd', []]`):
  // stand down so the dyn keyed read below the chain answers, instead
  // of an array libCall over a dyn receiver hitting the boundary fence.
  let kind = neverTaintedJsType(lowerer, expr.expression, lowerer.typeOf(expr.expression))
    ? undefined
    : lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind;
  // A checker-`any[]` receiver (the readonly-array Array.isArray quirk)
  // whose VALUE lowers to a real static array (maybeNarrow's isArray
  // bridge): `.length` and friends ride the array path on the lowered
  // value (re-lowering is pure IR construction).
  if (kind === undefined && lowerer.checkerAnyArray(expr.expression)) {
    const probe = lowerer.lowerExpr(expr.expression);
    if (probe.type.kind === "array") kind = "array";
  }
  if (
    kind !== "string" &&
    kind !== "array" &&
    kind !== "map" &&
    kind !== "set" &&
    kind !== "f64" &&
    kind !== "date" &&
    kind !== "regex" &&
    kind !== "url" &&
    kind !== "searchParams" &&
    kind !== "stats" &&
    kind !== "spawnRes" &&
    kind !== "child" &&
    kind !== "bytes" &&
    kind !== "symbol"
  ) {
    return null;
  }
  // child receivers also admit the user's own child-shaped interface
  // members (the NgrokChildProcess duck rule — see isChildSurfaceMember).
  // The EMPTY tuple `[]` rides the array REPRESENTATION (type-mapper.ts), but
  // its `length` member is the tuple's own synthesized property, not
  // Array.prototype's — provenance alone would refuse it. It reads the
  // runtime length (always 0) through the array intrinsic like any other
  // array; non-empty tuples never reach here (they map to records and
  // fold their arity constant on the record path).
  const tupleLengthOnArray =
    kind === "array" &&
    expr.name.text === "length" &&
    lowerer.checker.isTupleType(
      lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(expr.expression)),
    );
  if (
    kind === "child"
      ? !isChildSurfaceMember(lowerer, expr)
      : !tupleLengthOnArray && !lowerer.isStdlibMember(expr)
  )
    return null;
  const name = expr.name.text;
  if (kind === "array" && name === "constructor" && isJsSourceFile(expr.getSourceFile())) {
    const receiver = lowerer.lowerExpr(expr.expression);
    if (receiver.type.kind === "dyn")
      return {
        kind: "dynKeyGet",
        value: receiver,
        key: { kind: "strLit", value: name, type: STRING, loc: locOf(expr) },
        type: DYN,
        loc: locOf(expr),
      };
    const result: IrExpr = {
      kind: "libCall",
      fn: "dyn.arrayConstructor",
      args: [],
      type: DYN,
      loc: locOf(expr),
    };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: receiver, loc: locOf(expr) }],
      result,
      type: DYN,
      loc: locOf(expr),
    };
  }
  const strictReceiver = (expected: IrType): IrExpr => {
    const value = lowerer.lowerExpr(expr.expression);
    if (value.type.kind === "dyn") {
      if (isJsSourceFile(expr.getSourceFile()) && name === "length") return value;
      return lowerer.coerceInto(expr.expression, value, expected);
    }
    return lowerer.runtimeOptionalPropertyReceiver(expr.expression, value, expected, name) ?? value;
  };
  if (kind === "child") {
    const loc = locOf(expr);
    // The lifecycle reads, Node's exact shapes (SEMANTICS.md pins the
    // matrix): pid is `number | undefined` (undefined = spawn failure),
    // exitCode `number | null` (null while running and after a signal
    // death; -errno once a spawn failure settled), killed the
    // sent-a-signal flag. The unions build type-directedly in the
    // backend (the spawnRes.status pattern); a checker-narrowed read
    // extracts through maybeNarrow like any union member.
    if (name === "pid") {
      const receiver = lowerer.lowerExpr(expr.expression);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, UNDEFINED_T]) };
      return { kind: "libCall", fn: "child.pid", args: [receiver], type, loc };
    }
    if (name === "exitCode") {
      const receiver = lowerer.lowerExpr(expr.expression);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, NULL_T]) };
      return { kind: "libCall", fn: "child.exitCode", args: [receiver], type, loc };
    }
    if (name === "killed") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return { kind: "libCall", fn: "child.killed", args: [receiver], type: BOOL, loc };
    }
    if (name === "on" || name === "once" || name === "kill" || name === "unref") {
      lowerer.unsupported("SC1090", expr, `child methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `ChildProcess.${name}`,
      expr,
      'on/once("exit" | "close" | "error", cb), pid, exitCode, killed, kill(signal?), and unref() are the supported ChildProcess members',
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "spawnRes") {
    // The spawnSync-result reads. status is the interned `number | null`
    // union (null = signal death or spawn failure); stdout/stderr are
    // the captured utf8 strings — under @types/node WITHOUT the
    // {encoding: "utf8"} options argument the checker types them Buffer,
    // which is re-fenced here (the call site already said so).
    const loc = locOf(expr);
    if (name === "status") {
      // Always the interned `number | null` union; a checker-NARROWED
      // read (`missing.status === null ? ... : ${missing.status}`)
      // bridges through maybeNarrow like any union read.
      const receiver = lowerer.lowerExpr(expr.expression);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, NULL_T]) };
      const read: IrExpr = { kind: "libCall", fn: "spawnRes.status", args: [receiver], type, loc };
      return lowerer.maybeNarrow(read, expr);
    }
    if (name === "stdout" || name === "stderr") {
      if (lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind !== "string") {
        lowerer.noLowering(
          `spawnSync's ${name} without the "utf8" encoding`,
          expr,
          'Buffer captures are not representable — call spawnSync(cmd, args, { encoding: "utf8" }) so the outputs are strings',
        );
      }
      const receiver = lowerer.lowerExpr(expr.expression);
      const fn = name === "stdout" ? "spawnRes.stdout" : "spawnRes.stderr";
      return { kind: "libCall", fn, args: [receiver], type: STRING, loc };
    }
    if (name === "error") {
      // Node's spawn-failure carrier: `Error | undefined` — a fresh
      // %Error ("spawnSync <file> ENOENT", `code` stamped) when the
      // spawn itself failed, the undefined arm otherwise. The libCall
      // always carries the interned union (the declared `error?: Error`),
      // and a checker-NARROWED read (`if (r.error) r.error.message`)
      // bridges through maybeNarrow like any union read.
      const receiver = lowerer.lowerExpr(expr.expression);
      const type = lowerer.withUndefinedArmOf({ kind: "object", className: "%Error" });
      if (!type) lowerer.badType(expr, lowerer.typeOf(expr));
      const read: IrExpr = { kind: "libCall", fn: "spawnRes.error", args: [receiver], type, loc };
      return lowerer.maybeNarrow(read, expr);
    }
    lowerer.noLowering(
      `SpawnSyncReturns.${name}`,
      expr,
      "status, stdout, stderr, and error are the supported spawnSync-result members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "stats") {
    if (name === "size") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return { kind: "libCall", fn: "stats.size", args: [receiver], type: F64, loc: locOf(expr) };
    }
    if (name === "isFile" || name === "isDirectory") {
      lowerer.unsupported("SC1090", expr, `Stats methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Stats.${name}`,
      expr,
      "isFile(), isDirectory(), isSymbolicLink(), dev, ino, size, blocks, nlink, atimeMs, mtimeMs, and ctimeMs are the supported Stats members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "date") {
    const methods = new Set([
      "getTime",
      "valueOf",
      "toISOString",
      "getFullYear",
      "getUTCFullYear",
      "getMonth",
      "getUTCMonth",
      "getDate",
      "getUTCDate",
      "getDay",
      "getUTCDay",
      "getHours",
      "getUTCHours",
      "getMinutes",
      "getUTCMinutes",
      "getSeconds",
      "getUTCSeconds",
      "getMilliseconds",
      "getUTCMilliseconds",
      "getTimezoneOffset",
    ]);
    if (methods.has(name)) {
      lowerer.unsupported("SC1090", expr, `Date methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Date.prototype.${name}`,
      expr,
      "getTime(), valueOf(), toISOString(), the local/UTC calendar getters, and getTimezoneOffset() are supported; Date setters and locale/string formatters have no lowering",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "symbol") {
    const loc = locOf(expr);
    // `.description`: the checker's `string | undefined` — undefined
    // exactly for the description-less Symbol()/Symbol(undefined) forms
    // (Symbol("") answers the EMPTY STRING arm, like Node). The interned
    // union builds in the backend from the runtime's +1-or-NULL answer
    // (the child.stdout pattern); a checker-narrowed read extracts
    // through maybeNarrow like any union member.
    if (name === "description") {
      const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), SYMBOL_T);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, UNDEFINED_T]) };
      return { kind: "libCall", fn: "sym.desc", args: [receiver], type, loc };
    }
    if (name === "toString" || name === "valueOf") {
      lowerer.unsupported("SC1090", expr, `symbol methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Symbol.prototype.${name}`,
      expr,
      "description and toString() are the supported symbol members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "url") {
    // The supported URL getters. Everything else the lib declares
    // (searchParams, setters-as-reads, ...) fences with the
    // member-qualified name and the supported list. `host` is the WHATWG
    // serialization: lowercased hostname, `:port` appended exactly when
    // a non-default port is present (scr_url_host — Node-exact,
    // opaque-path URLs answer ""); `hostname` is the stored port-less
    // host field verbatim, including IPv6 brackets.
    if (
      name === "protocol" ||
      name === "origin" ||
      name === "username" ||
      name === "password" ||
      name === "pathname" ||
      name === "href" ||
      name === "host" ||
      name === "hostname" ||
      name === "port" ||
      name === "search" ||
      name === "hash"
    ) {
      const receiver = lowerer.lowerExpr(expr.expression);
      const fn =
        name === "protocol"
          ? "url.protocol"
          : name === "origin"
            ? "url.origin"
            : name === "username"
              ? "url.username"
              : name === "password"
                ? "url.password"
                : name === "pathname"
                  ? "url.pathname"
                  : name === "host"
                    ? "url.host"
                    : name === "hostname"
                      ? "url.hostname"
                      : name === "port"
                        ? "url.port"
                        : name === "search"
                          ? "url.search"
                          : name === "hash"
                            ? "url.hash"
                            : "url.href";
      return { kind: "libCall", fn, args: [receiver], type: STRING, loc: locOf(expr) };
    }
    // `u.searchParams`: the LIVE cached view (one identity per URL —
    // mutations through it re-serialize into the URL's query, so href
    // reflects immediately; Node's binding exactly).
    if (name === "searchParams") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return {
        kind: "libCall",
        fn: "url.searchParams",
        args: [receiver],
        type: SEARCH_PARAMS_T,
        loc: locOf(expr),
      };
    }
    if (name === "toString" || name === "toJSON") {
      lowerer.unsupported("SC1090", expr, `URL methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `URL.${name}`,
      expr,
      "protocol, origin, username, password, pathname, href, host, hostname, port, search, hash, searchParams, and toString() are the supported URL members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "searchParams") {
    const SEARCH_PARAMS_METHODS = new Set([
      "get",
      "getAll",
      "set",
      "append",
      "delete",
      "has",
      "sort",
      "toString",
      "forEach",
      "keys",
      "values",
      "entries",
    ]);
    // The one data property; every method lowers at its CALL
    // (lowerSearchParamsMethodCall) — bare method references fence.
    if (name === "size") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return { kind: "libCall", fn: "sp.size", args: [receiver], type: F64, loc: locOf(expr) };
    }
    if (SEARCH_PARAMS_METHODS.has(name)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `URLSearchParams methods as values (call '${name}' directly)`,
      );
    }
    lowerer.noLowering(
      `URLSearchParams.${name}`,
      expr,
      "get, getAll, set, append, delete, has, sort, size, toString(), forEach, and for-of iteration are the supported URLSearchParams members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "regex") {
    if (name === "lastIndex") {
      return {
        kind: "regexIntrinsic",
        method: "lastIndex",
        receiver: strictReceiver({ kind: "regex" }),
        args: [],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (name === "source" || name === "flags") {
      const receiver = strictReceiver({ kind: "regex" });
      return {
        kind: "regexIntrinsic",
        method: name,
        receiver,
        args: [],
        type: STRING,
        loc: locOf(expr),
      };
    }
    if (name === "test") {
      lowerer.unsupported("SC1090", expr, "regex methods as values (call 'test' directly)");
    }
    return null;
  }
  if (kind === "f64") {
    // The only ambient members on numbers are island-backed methods; a
    // bare reference has no value form regardless of --dynamic.
    if (own(ISLAND_SURFACE.number, name) !== undefined) {
      lowerer.unsupported("SC1090", expr, `number methods as values (call '${name}' directly)`);
    }
    return null;
  }
  if (kind === "bytes") {
    const loc = locOf(expr);
    if (name === "constructor") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceInto(expr.expression, receiver, DYN),
        key: { kind: "strLit", value: name, type: STRING, loc },
        type: DYN,
        loc,
      };
    }
    if (name === "length" || name === "byteLength") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      let receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      if (receiver.type.kind === "dyn")
        return {
          kind: "dynCheck",
          value: {
            kind: "dynKeyGet",
            value: receiver,
            key: { kind: "strLit", value: name, type: STRING, loc: locOf(expr) },
            type: DYN,
            loc: locOf(expr),
          },
          type: F64,
          loc: locOf(expr),
        };
      if (
        receiver.type.kind === "union" &&
        lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0
      ) {
        const present = lowerer.stripUndefinedArm(receiver.type);
        const helper =
          present.kind === "bytes"
            ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(expr.expression))
            : null;
        receiver = helper
          ? {
              kind: "call",
              callee: helper,
              args: [receiver],
              type: present,
              loc: locOf(expr.expression),
            }
          : lowerer.maybeNarrow(receiver, expr.expression);
      }
      // An island handle behind a typed-array .d.ts surface: the engine
      // property read, exiting at the declared number type (the array
      // .length rule). Chain-handled reads stay jsval.
      if (receiver.type.kind === "jsval") {
        const read: IrExpr = {
          kind: "jsOp",
          op: "getProp",
          name,
          args: [receiver],
          type: JSVAL,
          loc,
        };
        if (expr.questionDotToken) return read;
        return { kind: "jsExit", value: read, type: F64, loc };
      }
      return { kind: "bytesIntrinsic", method: name, receiver, args: [], type: F64, loc };
    }
    if (name === "byteOffset") {
      // 0 for owners (scriptc typed arrays own their whole storage —
      // SEMANTICS.md notes the divergence from Node's Buffer pooling),
      // the view's real offset for a DataView. A runtime read, so the
      // receiver's evaluation is never discarded.
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return { kind: "bytesIntrinsic", method: "byteOffset", receiver, args: [], type: F64, loc };
    }
    if (name === "buffer") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return { kind: "bytesIntrinsic", method: "buffer", receiver, args: [], type: DYN, loc };
    }
    if (name === "slice" || name === "subarray" || name === "set" || name === "toString") {
      lowerer.unsupported(
        "SC1090",
        expr,
        `typed-array methods as values (call '${name}' directly)`,
      );
    }
    return null; // fill, reverse, ... → the SC2020 member fence
  }
  if (kind === "map") {
    if (name === "size") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "map" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return {
        kind: "mapIntrinsic",
        method: "size",
        receiver,
        args: [],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (MAP_METHODS.has(name) || name === "forEach") {
      lowerer.unsupported("SC1090", expr, `Map methods as values (call '${name}' directly)`);
    }
    return null;
  }
  if (kind === "set") {
    if (name === "size") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "set" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return {
        kind: "setIntrinsic",
        method: "size",
        receiver,
        args: [],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (SET_METHODS.has(name)) {
      lowerer.unsupported("SC1090", expr, `Set methods as values (call '${name}' directly)`);
    }
    return null;
  }
  if (name === "length") {
    const expected =
      kind === "string" ? STRING : lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
    let receiver = lowerer.lowerExpr(expr.expression);
    if (
      receiver.type.kind !== "dyn" &&
      expected &&
      (expected.kind === "string" || expected.kind === "array")
    ) {
      receiver =
        lowerer.runtimeOptionalPropertyReceiver(expr.expression, receiver, expected, name) ??
        receiver;
    }
    if (
      receiver.type.kind === "union" &&
      lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0 &&
      kind === "array"
    ) {
      const present = lowerer.stripUndefinedArm(receiver.type);
      const helper =
        present.kind === "array"
          ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(expr.expression))
          : null;
      receiver = helper
        ? {
            kind: "call",
            callee: helper,
            args: [receiver],
            type: present,
            loc: locOf(expr.expression),
          }
        : lowerer.maybeNarrow(receiver, expr.expression);
    }
    // An island handle behind an array-typed .d.ts surface
    // (`parts().length` on a declared `string[]` return — arrays never
    // exit eagerly, so the value stays jsval): an engine property read,
    // exiting at the declared number type. Chain-handled reads stay
    // jsval (the island chain's body must be a handle).
    if (receiver.type.kind === "jsval") {
      const read: IrExpr = {
        kind: "jsOp",
        op: "getProp",
        name: "length",
        args: [receiver],
        type: JSVAL,
        loc: locOf(expr),
      };
      if (expr.questionDotToken) return read;
      return { kind: "jsExit", value: read, type: F64, loc: locOf(expr) };
    }
    // A CHECKED-DYNAMIC value behind an array-typed checker spelling
    // (`Object.keys(u).length` — the dyn walk answers a dyn array while
    // tsc spells string[]): the runtime-world dispatch — a dyn keyed
    // read validated into the declared number (a lying length throws
    // the catchable TypeError, the dynCheck stance).
    if (receiver.type.kind === "dyn") {
      const read: IrExpr = {
        kind: "dynKeyGet",
        key: { kind: "strLit", value: "length", type: STRING, loc: locOf(expr) },
        ...(expr.questionDotToken ? { optional: true as const } : {}),
        value: receiver,
        type: DYN,
        loc: locOf(expr),
      };
      if (expr.questionDotToken) return read;
      return { kind: "dynCheck", value: read, type: F64, loc: locOf(expr) };
    }
    return kind === "string"
      ? { kind: "strIntrinsic", method: "length", receiver, args: [], type: F64, loc: locOf(expr) }
      : { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc: locOf(expr) };
  }
  if (
    kind === "string"
      ? own(STR_METHODS, name) !== undefined ||
        STRING_INDEX_METHODS.has(name) ||
        own(ISLAND_SURFACE.string, name) !== undefined
      : ARRAY_METHODS.has(name)
  ) {
    lowerer.unsupported("SC1090", expr, `${kind} methods as values (call '${name}' directly)`);
  }
  return null;
}

/** `[a, b, c]`. The element type comes from the contextual type when tsc
 * has one (`const a: number[] = []`, arguments, nested literals) and from
 * the literal's own inferred type otherwise. A bare `[]` with no context
 * is `never[]` — unmappable, rejected with the component fence (SC2009). `expected` overrides
 * the contextual lookup where the caller knows the slot's array type and
 * tsc's API doesn't surface it (ternary arms under an array context —
 * tsc accepts the arm covariantly, but a tagged element representation
 * must be BUILT as the slot's element type). */
export function lowerArrayLiteral(
  lowerer: Lowerer,
  expr: ts.ArrayLiteralExpression,
  expected?: (IrType & { kind: "array" }) | (IrType & { kind: "record" }),
): IrExpr {
  const loc = locOf(expr);
  const ctxType = lowerer.checker.getContextualType(expr);
  // `as const satisfies readonly T[]` checks against an array but keeps
  // the literal's inferred tuple type. Build that shape; an actual array
  // destination can use the ordinary tuple-to-array coercion afterward.
  const tsType = underConstAssertion(expr)
    ? lowerer.typeOf(expr)
    : (ctxType ?? lowerer.typeOf(expr));
  let mapped = expected ?? lowerer.mapTypeOf(tsType);
  // Inferred JavaScript arrays can contain unrelated constructors with
  // structurally equal checker types. Their native class ABIs still differ.
  if (
    !expected &&
    isJsSourceFile(expr.getSourceFile()) &&
    mapped?.kind === "array" &&
    mapped.elem.kind === "classval"
  )
    mapped = DYN;
  // An inferred destructuring pattern supplies a contextual [any, ...]
  // tuple. Its positions do not erase the literal's inferred element
  // types; explicit destinations already arrive through expected.
  if (
    expected === undefined &&
    ctxType &&
    lowerer.checker.isTupleType(ctxType) &&
    lowerer.checker
      .getTypeArguments(ctxType as ts.TypeReference)
      .some((type) => (type.flags & ts.TypeFlags.Any) !== 0)
  ) {
    const inferred = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (
      inferred?.kind === "array" ||
      (inferred?.kind === "record" && lowerer.shapes.get(inferred.shapeId)?.tuple)
    )
      mapped = inferred;
  }
  // A JS literal whose OWN inferred type is never-tainted
  // (neverTaintedJsType — the evolving `const gb = []`, the mixed
  // command tuple `['pwd', []]`) carries no element information: route
  // it to the checked-dynamic tree fallback below rather than letting never's f64
  // representation build a static number array (a later dyn push would
  // throw "expected number at $, got string"; the tuple's union arm
  // would re-tag as number[] and fence). A REAL slot still wins:
  // `expected`, a contextual array/tuple, or a contextual union's
  // single array arm all provide element information first.
  // (The contextual lookup can answer the binding's own tainted
  // inference back — `const cmd = ['pwd', []]` — so the slot test is a
  // taint test on whichever type mapped, not a presence test.)
  const neverTaintedOwnJs =
    expected === undefined && neverTaintedJsType(lowerer, expr, lowerer.typeOf(expr));
  if (expected === undefined && neverTaintedJsType(lowerer, expr, tsType)) mapped = null;
  // A union-typed slot (`const x: string[] | number = [..]`) contextually
  // types the literal as the union; build the literal as its OWN type and
  // let the slot's coercion wrap it into the union. An unknown-typed slot
  // (`JSON.stringify([1, 2])`) likewise: build the literal's own type. An
  // UNMAPPABLE context falls back the same way — a destructuring pattern
  // without annotations contextually types its initializer `[any]`, while
  // the literal's own inferred type is the real tuple.
  if (!mapped || mapped.kind === "union" || mapped.kind === "dyn") {
    const ctxUnion = mapped?.kind === "union" ? mapped : null;
    mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // The never-tainted own type carries no element information here
    // either (the JS story above) — only a contextual union's single
    // array arm below may still supply a static home.
    if (neverTaintedOwnJs) mapped = null;
    // An EMPTY literal in a union slot (`const t: string[] | undefined =
    // []`, the `[]` default argument against `string[] | undefined`) has
    // no useful own type — tsc infers `never[]`, whose f64-element
    // mapping is a representation for the uninhabited, not the slot's
    // arm. When the contextual union has exactly ONE array arm there is
    // no ambiguity: build the literal as that arm and let the slot's
    // coercion wrap it. Two array arms would need tsc's own best-fit
    // choice — none arises in practice; the fence stands.
    if (ctxUnion && expr.elements.length === 0) {
      const def = lowerer.unions.get(ctxUnion.unionId);
      const arrayArms = def?.arms.filter((a) => a.kind === "array") ?? [];
      if (arrayArms.length === 1) mapped = arrayArms[0]!;
    }
    // A NON-EMPTY literal whose own type has no static home (the JS dyn
    // fallback — a null/dyn mapping, or an inference that degraded to a
    // unit-only-element array over non-unit elements) under a union
    // with exactly ONE array-family arm — an array, or an
    // arity-matching tuple (the option-table `default: [{ value: [] }]`
    // shape): build AS that arm, exactly the empty-literal rule above;
    // the slot's coercion wraps it.
    if (ctxUnion && expr.elements.length > 0) {
      // A unit-only-element array (`(null | undefined)[]`) cannot hold
      // non-unit elements — neither as the literal's own mapping nor as
      // a competing union arm.
      const nonUnitElems = expr.elements.some(
        (el) =>
          !ts.isOmittedExpression(el) &&
          el.kind !== ts.SyntaxKind.NullKeyword &&
          !(ts.isIdentifier(el) && el.text === "undefined"),
      );
      const ownUnhelpful =
        mapped === null ||
        mapped.kind === "dyn" ||
        // The checker echoing the context union back as the literal's
        // own type decides nothing either — nor does an island ('any')
        // residue under a STATIC union slot.
        mapped.kind === "union" ||
        mapped.kind === "jsval" ||
        (mapped.kind === "array" && nonUnitElems && lowerer.unitOnlyElem(mapped.elem));
      if (ownUnhelpful) {
        const def = lowerer.unions.get(ctxUnion.unionId);
        const arms = (def?.arms ?? []).filter(
          (a) =>
            (a.kind === "array" && !(nonUnitElems && lowerer.unitOnlyElem(a.elem))) ||
            (a.kind === "record" &&
              !!lowerer.shapes.get(a.shapeId)?.tuple &&
              lowerer.shapes.get(a.shapeId)!.fields.length === expr.elements.length),
        );
        if (arms.length === 1) mapped = arms[0]!;
      }
    }
  }
  // An array literal inside an npm-static implicit-any instance can
  // inherit the checker's poisoned any[] context even after the
  // active binding gives every element one concrete lowering. Recover a
  // static array only when every spelled element lowers to the same
  // supported type. An explicit checked-dynamic destination still owns
  // the later slot coercion; heterogeneous literals, holes, and spreads
  // keep the checked-dynamic fallback below.
  if (
    lowerer.implicitParamTypes !== null &&
    npmStaticPackageOfPath(expr.getSourceFile().fileName) !== null &&
    (mapped === null ||
      mapped.kind === "dyn" ||
      (mapped.kind === "array" && mapped.elem.kind === "dyn")) &&
    expr.elements.length > 0 &&
    expr.elements.every(
      (element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element),
    )
  ) {
    const elements = expr.elements.map((element) => tryLowerExpression(lowerer, element));
    const first = elements[0];
    if (
      first !== undefined &&
      first !== null &&
      isSupportedArrayElem(first.type) &&
      elements.every((element) => element !== null && typeEquals(element.type, first.type))
    ) {
      mapped = arrayOf(first.type);
    }
  }
  if (!expected && isJsSourceFile(expr.getSourceFile()) && mapped?.kind === "array") {
    const elem = mapped.elem;
    const arms = elem.kind === "union" ? lowerer.unions.get(elem.unionId)?.arms : [elem];
    if (arms?.length && arms.every((arm) => arm.kind === "classval")) mapped = DYN;
  }
  if (
    !expected &&
    isJsSourceFile(expr.getSourceFile()) &&
    expr.elements.some(
      (element) =>
        ts.isSpreadElement(element) &&
        tryLowerExpression(lowerer, element.expression)?.type.kind === "dyn",
    )
  )
    mapped = DYN;
  // An EMPTY literal under a CONST ASSERTION whose type queries panicked
  // (tsgo's readonly-[] TupleType conversion — the facade answers `any`,
  // which maps to nothing statically and to an island value under
  // --dynamic): the value is provably the empty tuple; ride the
  // unit-element array, mapType's own `[] as const` rule.
  if (
    (mapped === null || mapped.kind === "jsval") &&
    expr.elements.length === 0 &&
    (tsType.flags & ts.TypeFlags.Any) !== 0 &&
    underConstAssertion(expr)
  ) {
    mapped = arrayOf(unitOnlyUnion(lowerer.unions));
  }
  // Heterogeneous JavaScript object arrays must retain each literal's
  // real keys. A structural union can otherwise drop descriptor fields.
  if (
    !expected &&
    isJsSourceFile(expr.getSourceFile()) &&
    mapped?.kind === "array" &&
    mapped.elem.kind === "union" &&
    expr.elements.some(ts.isObjectLiteralExpression)
  )
    mapped = DYN;

  // A TUPLE-typed slot (`const t: [string, number] = ["a", 1]`): the
  // literal constructs the tuple's record shape — one positional field
  // per element, source order (which IS index order, so evaluation order
  // is JS-exact). tsc has already checked the arity; the recount below
  // backstops `as` smuggling. Fixed tuple spreads have known positions.
  if (mapped?.kind === "record") {
    const shape = lowerer.shapes.get(mapped.shapeId);
    if (shape?.tuple) {
      const spread = expr.elements.find(ts.isSpreadElement);
      if (spread) {
        return lowerTupleSpreadLiteral(lowerer, expr, mapped, shape);
      }
      if (expr.elements.length !== shape.fields.length) {
        // tsc padded an UNDER-LENGTH literal against an optional-element
        // tuple context (`options || []` with `options?: [string?,
        // number?]` — the instantiated type spells every position, the
        // literal spells fewer): no fixed shape holds it, but the
        // engine's real arrays do — under --dynamic the literal builds
        // island-native with its ACTUAL elements, length exact. Static
        // builds keep the type fence (badType's dynamic probe tells the
        // --dynamic story).
        if (
          lowerer.dynamic &&
          expr.elements.length < shape.fields.length &&
          expr.elements.every((el) => !ts.isOmittedExpression(el))
        ) {
          return {
            kind: "jsOp",
            op: "arrLit",
            args: expr.elements.map((el) => lowerer.jsvalIn(lowerer.lowerExpr(el), el)),
            type: JSVAL,
            loc,
          };
        }
        lowerer.badType(expr, tsType);
      }
      const byName = new Map(shape.fields.map((f) => [f.name, f.type]));
      const fields = expr.elements.map((el, i) => {
        const fieldType = byName.get(String(i));
        if (!fieldType) lowerer.badType(el, lowerer.typeOf(el));
        return { name: String(i), value: lowerer.lowerExprExpecting(el, fieldType) };
      });
      return { kind: "recordLit", fields, type: mapped, loc };
    }
  }
  if (!mapped || mapped.kind !== "array") {
    // The JS declaration fallback, literal-side: an element type with no
    // static home (a string | string[] mixed command tuple, an evolving
    // []) builds as a dyn ARRAY — one dyn value whose elements each
    // convert through the usual boundary (dynFrom's JSON-safe domain);
    // an element that cannot convert fences per element. length/index
    // reads and dynamic consumers ride the keyed-dyn paths. TS literals
    // take the same build when the slot ITSELF is checked-dynamic — an
    // `unknown[]` annotation or a collapsed `(string | object)[]` maps
    // to DYN wholesale now (mapType's dyn-element array rule), so the
    // literal IS the dyn array.
    if (
      isJsSourceFile(expr.getSourceFile()) ||
      mapped?.kind === "dyn" ||
      lowerer.checkerAnyArray(expr)
    ) {
      if (expr.elements.some(ts.isSpreadElement)) {
        // Native collection drains return vectors of retained dyn
        // elements. Reuse the ordinary spread builder, then expose the
        // resulting array through the established unknown[] representation.
        const vector = lowerArrayLiteral(lowerer, expr, arrayOf(DYN) as IrType & { kind: "array" });
        return lowerer.coerceInto(expr, vector, DYN);
      }
      const elems = expr.elements.map((el): IrExpr => {
        if (ts.isSpreadElement(el)) {
          lowerer.unsupported(
            "SC1090",
            el,
            "spread elements in a dynamic (unknown[]) array literal",
          );
        }
        const v = lowerer.coerceToExpected(lowerer.lowerExpr(el), DYN);
        if (v.type.kind !== "dyn") {
          lowerer.unsupported(
            "SC1101",
            el,
            `holding '${lowerer.fmt(v.type)}' values in a dynamic (unknown[]) array literal`,
          );
        }
        return v;
      });
      return { kind: "dynArrLit", elems, type: DYN, loc };
    }
    lowerer.badType(expr, tsType);
  }
  const type = mapped as IrType & { kind: "array" };
  // Keep the array payload type fixed. Optional reads are stored through
  // arrayValueStore, which records UNDEFINED in the state byte while the
  // payload remains number/string/etc.; widening the array element here
  // would force boxed union storage and change aliases.
  const spreads: number[] = [];
  const holes = new Set<number>();
  const runtimeOptionalElements = new Set<number>();
  let needsStateBuild = false;
  for (let i = 0; i < expr.elements.length; i++) {
    const candidate = expr.elements[i]!;
    if (ts.isSpreadElement(candidate) || ts.isOmittedExpression(candidate)) continue;
    const probe = tryLowerExpression(lowerer, candidate);
    if (probe && lowerer.runtimeOptionalWidening(probe.type, type.elem) !== null) {
      runtimeOptionalElements.add(i);
      needsStateBuild = true;
    }
  }
  const elems: IrExpr[] = expr.elements.map((el, i): IrExpr => {
    if (ts.isSpreadElement(el)) {
      // `[...xs, b]`: xs must be an array of the literal's own element
      // type — its elements copy in at construction (a fresh array,
      // JS-exact). Iterables that aren't arrays (strings, Sets, Maps)
      // and mismatched element types stay fenced. A TERNARY source gets
      // the literal's own type as its expected type (the conditional-
      // spread idiom — tsc surfaces no contextual type through spreads,
      // and the arm literals must BUILD as this element type).
      let srcNode: ts.Expression = el.expression;
      while (ts.isParenthesizedExpression(srcNode)) srcNode = srcNode.expression;
      lowerer.fenceStaticHeadersIteration(el.expression);
      let src =
        lowerer.lowerDynamicHeadersSpread(el.expression, type) ??
        (ts.isConditionalExpression(srcNode)
          ? lowerTernary(lowerer, srcNode, type)
          : lowerer.lowerExpr(el.expression));
      src = lowerCollectionSpread(lowerer, src, el.expression) ?? src;
      // `[...new SymbolIterator]`: a CLASS ITERABLE drains through its
      // own protocol into a fresh element array (classIteratorDrainCall
      // — an infinite iterator loops forever, exactly Node), and the
      // spread machinery copies like any array source.
      if (src.type.kind === "object") {
        const drained = lowerer.classIteratorDrainCall(src, locOf(el), type.elem);
        if (drained) src = drained;
      }
      // `[...s]` on a STRING spreads its code-point characters (the
      // string iterator's walk — astral chars whole) through the same
      // interned helper as Array.from(s); the result rides the array
      // machinery below like any string[] source.
      if (src.type.kind === "string") {
        src = strCharsCall(lowerer, src, locOf(el));
      }
      // `[...typedArray]`: represented typed arrays are dense numeric
      // iterables, so drain their elements into the fresh number[] that
      // the surrounding array literal will copy. In particular this is
      // the Uint8Array-to-Array bridge (`[...u8]`), with element values
      // read rather than backing bytes for the wider typed-array kinds.
      if (src.type.kind === "bytes") {
        src = {
          kind: "bytesIntrinsic",
          method: "toArray",
          receiver: src,
          args: [],
          type: arrayOf(F64),
          loc: locOf(el),
        };
      }
      // A native checked iterable can supply scalar elements even when
      // the checker inferred a typed array from its producer. Drain once
      // and validate the elements before the ordinary spread copy.
      if (
        src.type.kind === "dyn" &&
        (type.elem.kind === "dyn" ||
          type.elem.kind === "f64" ||
          type.elem.kind === "string" ||
          type.elem.kind === "bool")
      ) {
        src = lowerer.coerceInto(el.expression, checkedIteratorPack(lowerer, src, locOf(el)), type);
      }
      // A same-family array whose ELEMENT lifts (string[] into a
      // (string | symbol)[] literal — per-element wrap/width copy):
      // the interned width helper reshapes before the spread copies.
      if (src.type.kind === "array" && !typeEquals(src.type, type)) {
        const w = lowerer.widthCoerce(src, type);
        if (w) src = w;
      }
      if (!typeEquals(src.type, type)) {
        lowerer.unsupported(
          "SC1090",
          el,
          `spreading '${lowerer.fmt(src.type)}' into a '${lowerer.fmt(type)}' literal (only a same-element-type array spreads)`,
        );
      }
      spreads.push(i);
      return src;
    }
    // A HOLE (`[,]` — an elision) remains absent. Ordinary reads still
    // answer undefined, while presence-sensitive methods and concat keep
    // the hole. The state-building path below advances length without
    // writing a value into this slot.
    if (ts.isOmittedExpression(el)) {
      needsStateBuild = true;
      holes.add(i);
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(el) };
    }
    // An ARRAY-LITERAL element under a UNION element slot whose own type
    // has no lift into the slot builds against the union's single array
    // arm instead (`['pwd', []]` as (string | string[])[] — tsc pushes no
    // contextual type through the unannotated chain, so the empty nested
    // literal types never[], whose f64-element representation re-tags
    // into nothing). One array arm is unambiguous — the union-slot rule's
    // stance; several keep the fence.
    if (type.elem.kind === "union" || type.elem.kind === "array") {
      let x: ts.Expression = el;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isArrayLiteralExpression(x)) {
        const ownT = lowerer.mapTypeOf(lowerer.checker.getContextualType(x) ?? lowerer.typeOf(x));
        if (ownT === null || lowerer.widthLiftPlan(ownT, type.elem) === null) {
          // An ARRAY-typed slot takes the literal directly; a union slot
          // routes through its single array arm and wraps.
          if (type.elem.kind === "array") {
            return lowerer.lowerArrayLiteral(x, type.elem);
          }
          const def = lowerer.unions.get(type.elem.unionId);
          const arrayArms = def?.arms.filter((a) => a.kind === "array") ?? [];
          if (arrayArms.length === 1) {
            const built = lowerer.lowerArrayLiteral(x, arrayArms[0] as IrType & { kind: "array" });
            return lowerer.coerceInto(el, built, type.elem);
          }
        }
      }
    }
    // Elements flow into the element slot like an assignment: union
    // elements wrap plain arm values (`[1, "a"]` as (number | string)[]),
    // holes reject inside lowerExpr.
    let lowered: IrExpr;
    const directOptionalCandidate =
      runtimeOptionalElements.has(i) ||
      ts.isElementAccessExpression(el) ||
      (ts.isCallExpression(el) &&
        ts.isPropertyAccessExpression(el.expression) &&
        (el.expression.name.text === "pop" || el.expression.name.text === "shift"));
    if (directOptionalCandidate) {
      const raw = lowerer.lowerExpr(el);
      if (!typeEquals(raw.type, type.elem)) {
        needsStateBuild = true;
        return raw;
      }
      lowered = raw;
    } else {
      lowered = lowerer.lowerExprExpecting(el, type.elem);
    }
    if (!typeEquals(lowered.type, type.elem)) lowerer.badType(el, lowerer.typeOf(el));
    return lowered;
  });
  if (!needsStateBuild) {
    return { kind: "arrayLit", elems, ...(spreads.length > 0 ? { spreads } : {}), type, loc };
  }
  const out = lowerer.declareHiddenLocal("%arrayLit", type);
  const outRef = varRef(out.id, type, loc);
  const body: IrStmt[] = [
    { kind: "varDecl", localId: out.id, init: { kind: "arrayLit", elems: [], type, loc }, loc },
  ];
  const spreadSet = new Set(spreads);
  const currentLength = (): IrExpr => ({
    kind: "arrIntrinsic",
    method: "length",
    receiver: outRef,
    args: [],
    type: F64,
    loc,
  });
  const nextLength = (): IrExpr => ({
    kind: "bin",
    op: "+",
    left: currentLength(),
    right: { kind: "numLit", value: 1, type: F64, loc },
    type: F64,
    loc,
  });
  for (let i = 0; i < elems.length; i++) {
    const el = elems[i]!;
    if (spreadSet.has(i)) {
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "pushSpread",
          receiver: outRef,
          args: [el],
          type: F64,
          loc,
        },
        loc,
      });
      continue;
    }
    if (holes.has(i)) {
      body.push({ kind: "arraySetLength", arr: outRef, length: nextLength(), loc });
      continue;
    }
    let value = el;
    if (!typeEquals(value.type, type.elem)) {
      const temp = lowerer.declareHiddenLocal("%arrayValue", value.type);
      body.push({ kind: "varDecl", localId: temp.id, init: value, loc });
      value = varRef(temp.id, temp.type, loc);
    }
    body.push(arrayValueStore(lowerer, outRef, currentLength(), value, type.elem, loc));
  }
  return {
    kind: "seqExpr",
    stmts: body,
    result: outRef,
    type,
    loc,
  };
}

/** Build a fixed tuple from positional elements and fixed tuple spreads.
 * Capture each value in source order: deferring the reads until recordLit
 * would observe a later element's mutations of the spread source. */
function lowerTupleSpreadLiteral(
  lowerer: Lowerer,
  expr: ts.ArrayLiteralExpression,
  type: IrType & { kind: "record" },
  shape: IrRecordShape,
): IrExpr {
  const loc = locOf(expr);
  const byName = new Map(shape.fields.map((field) => [field.name, field.type]));
  const stmts: IrStmt[] = [];
  const fields: { name: string; value: IrExpr }[] = [];
  const append = (node: ts.Expression, value: IrExpr): void => {
    const name = String(fields.length);
    const expected = byName.get(name);
    if (!expected) lowerer.badType(expr, lowerer.typeOf(expr));
    const coerced = lowerer.coerceInto(node, value, expected);
    const temp = lowerer.declareHiddenLocal("%tupleElement", expected);
    const at = locOf(node);
    stmts.push({ kind: "varDecl", localId: temp.id, init: coerced, loc: at });
    fields.push({ name, value: varRef(temp.id, expected, at) });
  };
  for (const element of expr.elements) {
    if (!ts.isSpreadElement(element)) {
      const expected = byName.get(String(fields.length));
      if (!expected) lowerer.badType(element, lowerer.typeOf(element));
      append(element, lowerer.lowerExprExpecting(element, expected));
      continue;
    }
    const source = lowerer.lowerExpr(element.expression);
    const sourceShape =
      source.type.kind === "record" ? lowerer.shapes.get(source.type.shapeId) : undefined;
    if (!sourceShape?.tuple) {
      // Empty tuples use a zero-length array representation. Preserve a
      // producing call's effects even though there are no positions to copy.
      const sourceTs = lowerer.typeOf(element.expression);
      if (
        source.type.kind === "array" &&
        lowerer.checker.isTupleType(sourceTs) &&
        lowerer.checker.getTypeArguments(sourceTs as ts.TypeReference).length === 0
      ) {
        stmts.push({ kind: "exprStmt", expr: source, loc: locOf(element) });
        continue;
      }
      lowerer.unsupported(
        "SC1090",
        element,
        "spreading a variable-length value into a fixed tuple literal",
      );
    }
    const temp = lowerer.declareHiddenLocal("%tupleSpread", source.type);
    const at = locOf(element);
    stmts.push({ kind: "varDecl", localId: temp.id, init: source, loc: at });
    const receiver = varRef(temp.id, source.type, at);
    const positions = [...sourceShape.fields].sort((a, b) => Number(a.name) - Number(b.name));
    for (const field of positions) {
      append(element.expression, {
        kind: "recordGet",
        obj: receiver,
        shapeId: sourceShape.id,
        field: field.name,
        type: field.type,
        loc: at,
      });
    }
  }
  if (fields.length !== shape.fields.length) lowerer.badType(expr, lowerer.typeOf(expr));
  return { kind: "seqExpr", stmts, result: { kind: "recordLit", fields, type, loc }, type, loc };
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

/** `a[i]` reads. Only f64 indices into array receivers are modeled; JS
 * string-key element access (`a["length"]`) and string indexing (`s[0]`
 * typechecks against the lib's index signature; use .charAt) stay out. */
export function lowerElementAccess(lowerer: Lowerer, expr: ts.ElementAccessExpression): IrExpr {
  if (isImportMeta(expr.expression)) {
    const name = lowerer.foldedStringKeyOf(expr.argumentExpression);
    if (name === null)
      lowerer.unsupported(
        "SC1090",
        expr,
        "import.meta with a runtime-computed key (use a statically-known metadata field)",
      );
    return importMetaField(lowerer, expr, name);
  }

  // `a?.[i]`: the guard lowers as an optional-chain step around the
  // plain element read below.
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) {
    return lowerer.lowerOptionalChain(expr);
  }
  // `a?.b[i]` — the tail of a chain whose token sits deeper: the whole
  // tail short-circuits with the guard.
  if (!expr.questionDotToken && isOptionalChainTail(lowerer, expr)) {
    return lowerer.lowerOptionalChain(expr);
  }
  // Enum accesses in element clothing — `E["A"]` forward reads and
  // `E[0]` reverse-mapping reads — fold to constants (lower-enums.ts),
  // claimed before any receiver-kind dispatch can see the enum object.
  {
    const en = lowerEnumAccess(lowerer, expr);
    if (en) return en;
  }
  const cachedModule = lowerRequireCacheElement(lowerer, expr);
  if (cachedModule) return cachedModule;
  const namespaceElement = lowerModuleNamespaceElement(lowerer, expr);
  if (namespaceElement) return namespaceElement;
  // Native Web handles use the same supported surface for bracket and dot
  // spellings. Fence a statically-known unsupported key before the generic
  // checked-dynamic element-read path can turn it into a runtime missing
  // member.
  lowerer.fenceStaticAbortControllerMemberRead(expr);
  lowerer.fenceStaticResponseMember(expr, "read");
  lowerer.fenceStaticHeadersMember(expr, "read");
  lowerer.fenceStaticReadableStreamMember(expr, "read");
  // Computed global reads share the stored global object's custom
  // properties. Symbol keys retain their identity-indexed store.
  if (!expr.questionDotToken && stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis") {
    const symbol = globalSymbolKey(lowerer, expr.expression, expr.argumentExpression);
    if (symbol)
      return {
        kind: "libCall",
        fn: "dyn.globalSymbolGet",
        args: [symbol],
        type: DYN,
        loc: locOf(expr),
      };
    const key = lowerer.lowerExpr(expr.argumentExpression);
    const name: IrExpr =
      key.type.kind === "string"
        ? key
        : {
            kind: "libCall",
            fn: "dyn.toStringCoerce",
            args: [lowerer.coerceInto(expr.argumentExpression, key, DYN)],
            type: STRING,
            loc: locOf(expr),
          };
    return {
      kind: "dynKeyGet",
      value: lowerGlobalValue(lowerer, expr.expression),
      key: name,
      type: DYN,
      loc: locOf(expr),
    };
  }
  // `req.headers["x-name"]` — the computed twin of `req.headers.host`
  // (the server spoke owns both; the envGet precedent).
  {
    const header = lowerer.lowerHttpHeadersElement(expr);
    if (header) return lowerer.maybeNarrow(header, expr);
  }
  // `process.env[expr]` — the computed twin of `process.env.NAME`; both
  // lower to the ONE process.envGet intrinsic. The read narrows like any
  // union-typed expression when the checker narrowed this occurrence.
  if (lowerer.isProcessEnv(expr.expression)) {
    const key = lowerEnvironmentKey(lowerer, expr.argumentExpression);
    if (key.type.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        expr.argumentExpression,
        "indexing process.env with non-string keys",
      );
    }
    const get: IrExpr = {
      kind: "libCall",
      fn: "process.envGet",
      args: [key],
      type: lowerer.envValueType(),
      loc: locOf(expr),
    };
    return lowerer.maybeNarrow(get, expr);
  }
  // Expando function members in element clothing (`foo[strMem]`,
  // `foo[_private]` where foo is a module-level function/callable const
  // and the key folds or is a unique-symbol const): the member's module
  // global — the dotted read's twin (lower-expando.ts).
  {
    const ex = expandoMemberRead(lowerer, expr);
    if (ex) return lowerer.maybeNarrow(ex, expr);
  }
  // Symbol-keyed property READS (`this[kLimit]`): when the key is a
  // statically-resolvable symbol declared as a field of the receiver's
  // class (classSymbolKeyOf — the countdown.js/OpenTUI idioms), the
  // read IS an ordinary field read of the hidden slot. Every other
  // symbol key stays fenced: record shapes, runtime-identity keys
  // (symbol parameters, reassigned bindings), and keys no class declares
  // — the layouts are compile-time field lists.
  if (lowerer.mapTypeOf(lowerer.typeOf(expr.argumentExpression))?.kind === "symbol") {
    const target = symbolFieldTarget(lowerer, expr);
    if (target) return lowerer.maybeNarrow(lowerer.fieldGetExpr(target, locOf(expr), expr), expr);
    let receiver = lowerer.lowerExpr(expr.expression);
    const classInfo =
      receiver.type.kind === "classval" ? lowerer.classes.get(receiver.type.className) : undefined;
    if (
      receiver.type.kind === "func" ||
      receiver.type.kind === "generator" ||
      ((receiver.type.kind === "array" ||
        receiver.type.kind === "string" ||
        receiver.type.kind === "bytes") &&
        lowerer.dynConvertible(receiver.type)) ||
      (receiver.type.kind === "object" && lowerer.dynConvertible(receiver.type)) ||
      isDynTypedRefType(receiver.type) ||
      (classInfo && (classInfo.callableBase || hasRuntimeStatics(classInfo))) ||
      ((receiver.type.kind === "map" || receiver.type.kind === "set") &&
        lowerer.dynConvertible(receiver.type))
    ) {
      const fnName = jsFuncNameOf(expr.expression);
      receiver = {
        kind: "dynFrom",
        value: receiver,
        type: DYN,
        loc: locOf(expr),
        ...(fnName !== null ? { fnName } : {}),
      };
    }
    if (receiver.type.kind === "dyn") {
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      return lowerer.maybeNarrow(
        { kind: "dynKeyGet", value: receiver, key, type: DYN, loc: locOf(expr) },
        expr,
      );
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "symbol-keyed property access outside class fields keyed by a stable module-level literal Symbol()/Symbol.for() (other static shapes have no symbol-keyed storage)",
    );
  }
  // A never-tainted JS receiver type (neverTaintedJsType — `cmd[1]` on
  // `const cmd = ['pwd', []]`, whose binding lowered checked-dynamic)
  // dispatches as unmapped so the dyn-receiver branch below reads
  // through the checked-dynamic tree instead of dynChecking into never's f64 residue.
  let receiverIr = neverTaintedJsType(lowerer, expr.expression, lowerer.typeOf(expr.expression))
    ? null
    : lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (isJsSourceFile(expr.getSourceFile())) {
    const receiver = tryLowerExpression(lowerer, expr.expression);
    if (receiver?.type.kind === "dyn") {
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      const optional = hasOptionalChainGuard(expr.expression);
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          value: receiver,
          key,
          ...(optional ? { optional: true as const } : {}),
          type: DYN,
          loc: locOf(expr),
        },
        expr,
      );
    }
    if (receiver?.type.kind === "func" && lowerer.dynConvertible(receiver.type)) {
      const loc = locOf(expr);
      const fnName = jsFuncNameOf(expr.expression);
      const boxed: IrExpr = {
        kind: "dynFrom",
        value: receiver,
        type: DYN,
        loc,
        ...(fnName !== null ? { fnName } : {}),
      };
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      return lowerer.maybeNarrow({ kind: "dynKeyGet", key, value: boxed, type: DYN, loc }, expr);
    }
    if (receiver?.type.kind === "array" || receiver?.type.kind === "bytes")
      receiverIr = receiver.type;
    if (receiver?.type.kind === "union") {
      const present = lowerer.stripUndefinedArm(receiver.type);
      if (present.kind === "array" || present.kind === "bytes") receiverIr = present;
    }
  }
  // A readonly tuple union under Array.isArray is checker-typed as an
  // intersection with any[], whose structural mapping is not the tuple
  // shape. maybeNarrow on the receiver uses the runtime tag proof to
  // extract the one array-valued arm; dispatch element access from that
  // lowered representation, like the existing any[] array-method path.
  const checkerArray = lowerer.checkerArrayValue(expr.expression);
  if (checkerArray) receiverIr = checkerArray.type;
  if (receiverIr?.kind === "object") {
    const key =
      recordKeyLiteralText(expr.argumentExpression) ??
      recordKeyTypeLiteralText(lowerer, expr.argumentExpression);
    if (key !== null) {
      const target = classFieldTarget(lowerer, expr.expression, receiverIr, key);
      if (target) return lowerer.maybeNarrow(lowerer.fieldGetExpr(target, locOf(expr), expr), expr);
    }
    if (receiverIr.className === "%Error" || isDynTypedRefType(receiverIr)) {
      const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), DYN);
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      return lowerer.maybeNarrow(
        { kind: "dynKeyGet", value: receiver, key, type: DYN, loc: locOf(expr) },
        expr,
      );
    }
  }
  if (receiverIr?.kind === "jsval") {
    // Dispatch follows the RUNTIME world (383(d)): a checker-'any'
    // receiver whose value LOWERED checked-dynamic (`bag.list[0]` where
    // bag.list is a routed keyed read off a wrapped island value) takes
    // the dyn keyed read below — the routed JSVAL arm reads the real
    // engine element; a jsval-lowered receiver keeps the island read.
    const recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind !== "dyn") return islandElementRead(lowerer, expr, recv);
    const rawKey = lowerer.lowerExpr(expr.argumentExpression);
    const key: IrExpr | null =
      rawKey.type.kind === "string"
        ? rawKey
        : rawKey.type.kind === "f64"
          ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
          : null;
    if (key) {
      const opt = hasOptionalChainGuard(expr.expression);
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          key,
          ...(opt ? { optional: true as const } : {}),
          value: recv,
          type: DYN,
          loc: locOf(expr),
        },
        expr,
      );
    }
  }
  // Typed-array element read `b[i]` — like arrayGet with a scalar
  // result; any invalid index traps (the array discipline; JS would
  // read undefined — divergence 4's policy).
  if (receiverIr?.kind === "bytes") {
    let recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind === "dyn") recv = lowerer.coerceInto(expr.expression, recv, receiverIr);
    if (recv.type.kind === "union" && lowerer.armTag(recv.type.unionId, UNDEFINED_T) >= 0) {
      const present = lowerer.stripUndefinedArm(recv.type);
      const helper =
        present.kind === "bytes"
          ? lowerer.narrowedArmHelper(recv.type.unionId, present, locOf(expr.expression))
          : null;
      recv = helper
        ? { kind: "call", callee: helper, args: [recv], type: present, loc: locOf(expr.expression) }
        : lowerer.maybeNarrow(recv, expr.expression);
    }
    // A typed-array .d.ts surface whose VALUE is an island handle
    // (`data()[0]` on a declared Uint8Array return — call results only
    // exit primitives eagerly): the engine element read, exiting at the
    // declared number type.
    if (recv.type.kind === "jsval") return islandElementRead(lowerer, expr, recv);
    const index = lowerOptionalNumber(
      lowerer,
      lowerer.lowerExpr(expr.argumentExpression),
      locOf(expr.argumentExpression),
      expr.argumentExpression,
    );
    if (isJsSourceFile(expr.getSourceFile()) && recv.type.kind === "bytes") {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceInto(expr.expression, recv, DYN),
        key:
          index.type.kind === "f64"
            ? { kind: "toString", operand: index, type: STRING, loc: locOf(expr) }
            : index,
        type: DYN,
        loc: locOf(expr),
      };
    }
    if (index.type.kind === "dyn" && recv.type.kind === "bytes") {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceInto(expr.expression, recv, DYN),
        key: index,
        type: DYN,
        loc: locOf(expr),
      };
    }
    if (index.type.kind !== "f64") {
      lowerer.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
    }
    return {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: recv,
      args: [index],
      type: F64,
      loc: locOf(expr),
    };
  }
  // Tuple element read `t[0]`: a positional-field read of the tuple's
  // record shape — LITERAL indices only (the checker's per-index types
  // are what make the read honest; a dynamic index over a heterogeneous
  // shape has no single element type). Narrows like any field read.
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    if (shape?.tuple) {
      let obj = lowerer.lowerExpr(expr.expression);
      // A tuple-typed .d.ts surface whose VALUE is an island handle
      // (`pair()[0]` on a declared `[number, string]` return — the
      // anonymous tuple type has no npm symbol, so the checker maps it
      // structurally while the call result stays an engine array): the
      // read rides engine ops, exiting at the declared per-index type
      // like the array path.
      if (obj.type.kind === "jsval") return islandElementRead(lowerer, expr, obj);
      if (obj.type.kind === "dyn") {
        // Object.entries over a checked value stores each pair in the
        // dynamic tree even when the checker names a tuple type.
        const key = lowerRecordPropertyKey(
          lowerer,
          lowerer.lowerExpr(expr.argumentExpression),
          expr.argumentExpression,
        );
        const optional = hasOptionalChainGuard(expr.expression);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            value: obj,
            key,
            ...(optional ? { optional: true as const } : {}),
            type: DYN,
            loc: locOf(expr),
          },
          expr,
        );
      }
      if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, UNDEFINED_T) >= 0) {
        // The checker sees the outer `arrays[i]` as a tuple when
        // noUncheckedIndexedAccess is disabled, but the lowered read is
        // still tuple | undefined. A nested tuple field must validate the
        // outer tag before recordGet; an unchecked unionNarrow would let a
        // missing outer element reach the record backend as a bad pointer.
        const present = lowerer.stripUndefinedArm(obj.type);
        const helper =
          present.kind === "record"
            ? lowerer.narrowedArmHelper(obj.type.unionId, present, locOf(expr.expression))
            : null;
        obj = helper
          ? {
              kind: "call",
              callee: helper,
              args: [obj],
              type: present,
              loc: locOf(expr.expression),
            }
          : lowerer.maybeNarrow(obj, expr.expression);
      }
      const idx = tupleLiteralIndex(expr.argumentExpression);
      if (idx === null) {
        lowerer.unsupported(
          "SC1090",
          expr.argumentExpression,
          "tuple indexing with a non-literal index (tuples are fixed-shape — use t[0], t[1], ...)",
        );
      }
      const shapeId = obj.type.kind === "record" ? obj.type.shapeId : receiverIr.shapeId;
      const actualShape = lowerer.shapes.get(shapeId) ?? shape;
      const fieldType = actualShape.fields.find((f) => f.name === String(idx))?.type;
      if (fieldType === undefined) lowerer.badType(expr, lowerer.typeOf(expr)); // OOB smuggled past tsc
      const get: IrExpr = {
        kind: "recordGet",
        obj,
        shapeId,
        field: String(idx),
        type: fieldType,
        loc: locOf(expr),
      };
      return lowerer.isRuntimeOptionalField(shapeId, String(idx))
        ? get
        : lowerer.maybeNarrow(get, expr);
    }
    if (shape && !shape.tuple) {
      // A record-typed .d.ts surface whose VALUE is an island handle
      // (`headers()["x-id"]` on a declared `Record<string, string>`
      // return — the stdlib alias maps structurally while the call
      // result stays an engine object): the read rides engine ops with
      // the declared-value exit, never a recordKeyGet over a jsval.
      const obj = lowerer.lowerExpr(expr.expression);
      if (obj.type.kind === "jsval") return islandElementRead(lowerer, expr, obj);
      return lowerer.lowerRecordKeyRead(expr, receiverIr.shapeId, shape);
    }
  }
  // `pkg["k"]` / `scripts[name]` / `scopeMatch[1]` on a dyn receiver (a
  // JSON.parse result): the dyn keyed read, exactly the dot form.
  // NUMBER-typed indices convert through ToString first — JS property
  // keys are strings, and the canonical number text answers array
  // indices in the helper (fractions, negatives, and NaN read as
  // absent keys, exactly JS). An UNMAPPABLE checker type takes the
  // same path when the receiver LOWERS dyn
  // (`pkg.workspaces.packages["0"]` — the lowering world types the
  // unknown-rooted chain `any`); a non-dyn lowering falls through to
  // the fences below (re-lowering is pure IR construction).
  if (receiverIr?.kind === "dyn" || receiverIr?.kind === "union" || receiverIr === null) {
    const obj = lowerer.lowerExpr(expr.expression);
    // A generic mapped type can stay unresolved at this body use even
    // though its instantiated parameter has a concrete record ABI.
    // Dispatch from that stored shape, as the array fallback below does.
    if (receiverIr === null && obj.type.kind === "record") {
      const shape = lowerer.shapes.get(obj.type.shapeId);
      const index = tupleLiteralIndex(expr.argumentExpression);
      const field =
        shape?.tuple && index !== null
          ? shape.fields.find((field) => field.name === String(index))
          : null;
      if (field)
        return lowerer.maybeNarrow(
          {
            kind: "recordGet",
            obj,
            shapeId: obj.type.shapeId,
            field: field.name,
            type: field.type,
            loc: locOf(expr),
          },
          expr,
        );
      if (shape && !shape.tuple) {
        return lowerer.lowerRecordKeyRead(expr, obj.type.shapeId, shape);
      }
    }
    if (
      obj.type.kind === "dyn" ||
      (obj.type.kind === "object" && obj.type.className === "%Error") ||
      isDynTypedRefType(obj.type)
    ) {
      const rawKey = lowerer.lowerExpr(expr.argumentExpression);
      // Number, bool, and DYN keys stringify (ToPropertyKey) — the
      // dyn-keyed read `catchWarning[warning.name]` where the property
      // chain itself lowered dyn.
      const key =
        rawKey.type.kind === "dyn" ||
        rawKey.type.kind === "symbol" ||
        (rawKey.type.kind === "union" && lowerer.dynConvertible(rawKey.type))
          ? lowerer.coerceToExpected(rawKey, DYN)
          : lowerRecordPropertyKey(lowerer, rawKey, expr.argumentExpression);
      if (key.type.kind === "string" || key.type.kind === "dyn") {
        const opt = hasOptionalChainGuard(expr.expression);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            key,
            ...(opt ? { optional: true as const } : {}),
            value: lowerer.coerceToExpected(obj, DYN),
            type: DYN,
            loc: locOf(expr),
          },
          expr,
        );
      }
    }
    // A checker-`any` receiver that LOWERS to a static ARRAY
    // (`pm.split("@")[0]` — the dyn-receiver string machinery answers
    // string[]): the element read rides the ordinary array path on the
    // lowered value (invalid indices trap, divergence 4's policy).
    if (obj.type.kind === "array") {
      const index = lowerer.lowerExpr(expr.argumentExpression);
      if (index.type.kind === "f64") {
        const safe = lowerSafeIndexRead(lowerer, obj, index, locOf(expr));
        if (safe) return safe;
        return lowerer.maybeNarrow(
          { kind: "arrayGet", arr: obj, index, type: obj.type.elem, loc: locOf(expr) },
          expr,
        );
      }
    }
  }
  // `env[key]` on a UNION of record shapes (`ProcessEnv | Record<string,
  // string>` — the env-bag parameter pattern): the per-arm keyed read,
  // joined exactly like the dot form (lowerUnionProperty's keyed path).
  if (receiverIr?.kind === "union") {
    const value = lowerer.lowerExpr(expr.expression);
    if (value.type.kind === "union") {
      const key = lowerer.lowerExpr(expr.argumentExpression);
      if (key.type.kind === "f64") {
        const def = lowerer.unions.get(value.type.unionId);
        const presentArms = def?.arms.filter((arm) => !isUnitType(arm)) ?? [];
        if (presentArms.length === 1 && presentArms[0]?.kind === "string") {
          const property = runtimeOptionalElementKey(expr.argumentExpression);
          const receiver =
            property === null
              ? null
              : lowerer.runtimeOptionalPropertyReceiver(expr.expression, value, STRING, property);
          if (receiver !== null) {
            return {
              kind: "strIntrinsic",
              method: "charAt",
              receiver,
              args: [key],
              type: STRING,
              loc: locOf(expr),
            };
          }
        }
      }
      if (key.type.kind === "string" || key.type.kind === "f64") {
        const lit = ts.isStringLiteral(expr.argumentExpression)
          ? expr.argumentExpression.text
          : null;
        const keyed = lowerUnionKeyedRead(lowerer, expr, value.type.unionId, value, key, lit);
        if (keyed) return lowerer.maybeNarrow(keyed, expr);
      }
    }
  }
  if (receiverIr?.kind !== "array") {
    {
      const receiver = tryLowerExpression(lowerer, expr.expression);
      if (
        receiver?.type.kind === "dyn" ||
        (receiver &&
          isJsSourceFile(expr.getSourceFile()) &&
          (receiver.type.kind === "union" || receiver.type.kind === "bytes") &&
          lowerer.dynConvertible(receiver.type))
      ) {
        const key = lowerRecordPropertyKey(
          lowerer,
          lowerer.lowerExpr(expr.argumentExpression),
          expr.argumentExpression,
        );
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            value: lowerer.coerceInto(expr.expression, receiver, DYN),
            key,
            type: DYN,
            loc: locOf(expr),
          },
          expr,
        );
      }
      if (
        receiver?.type.kind === "func" &&
        canBoxFuncIntoDyn(
          receiver.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        const key = lowerRecordPropertyKey(
          lowerer,
          lowerer.lowerExpr(expr.argumentExpression),
          expr.argumentExpression,
        );
        if (key.type.kind === "string") {
          const boxed: IrExpr = {
            kind: "dynFrom",
            value: receiver,
            type: DYN,
            loc: locOf(expr.expression),
          };
          return lowerer.maybeNarrow(
            { kind: "dynKeyGet", key, value: boxed, type: DYN, loc: locOf(expr) },
            expr,
          );
        }
      }
    }
    if (receiverIr?.kind === "string") {
      // An indexed string property is absent for non-integer and missing
      // indexes. charAt has different coercion and out-of-range semantics.
      const recv = lowerer.lowerExpr(expr.expression);
      const index = lowerOptionalNumber(
        lowerer,
        lowerer.lowerExpr(expr.argumentExpression),
        locOf(expr.argumentExpression),
        expr.argumentExpression,
      );
      if (index.type.kind === "f64" && recv.type.kind === "string") {
        return lowerOptionalStringIndex(
          lowerer,
          recv,
          index,
          lowerer.withUndefinedArm(STRING),
          locOf(expr),
        );
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "string indexing with this index/result shape (expected a number index and a string or string | undefined result)",
      );
    }
    lowerer.unsupported("SC1090", expr, "element access on non-array values");
  }
  let arr = lowerer.lowerExpr(expr.expression);
  const runtimeOptionalSource = lowerer.runtimeOptionalSourceValue(expr.expression, arr);
  if (
    runtimeOptionalSource?.kind === "varRef" &&
    runtimeOptionalSource.type.kind === "union" &&
    arr.type.kind === "array"
  ) {
    // lowerer.lowerElementAccess has already recognized a captured
    // array | undefined receiver and supplied its checked extraction as
    // the expression override. Rebuild that check here so a missing
    // receiver throws the member-access error Node exposes, rather than
    // the generic target-union narrowing error. The stored receiver is a
    // varRef, so both the tag test and extraction read the same value
    // without repeating an effect.
    const stored = runtimeOptionalSource;
    if (stored.type.kind !== "union")
      throw new InternalCompilerError("runtime-optional array source lost its union storage");
    const unionId = stored.type.unionId;
    const undefTag = lowerer.armTag(unionId, UNDEFINED_T);
    const valueTag = lowerer.armTag(unionId, arr.type);
    const property = runtimeOptionalElementKey(expr.argumentExpression);
    if (undefTag >= 0 && valueTag >= 0 && property !== null) {
      arr = {
        kind: "ternary",
        cond: {
          kind: "unionIsTag",
          unionId,
          tag: undefTag,
          negated: false,
          value: stored,
          type: BOOL,
          loc: locOf(expr.expression),
        },
        then: nodeThrowExpr(
          1,
          "",
          `Cannot read properties of undefined (reading '${property}')`,
          arr.type,
          locOf(expr.expression),
        ),
        else_: {
          kind: "unionNarrow",
          unionId,
          tag: valueTag,
          value: stored,
          type: arr.type,
          loc: locOf(expr.expression),
        },
        type: arr.type,
        loc: locOf(expr.expression),
      };
    }
  }
  if (
    arr.type.kind === "union" &&
    lowerer.armTag(arr.type.unionId, UNDEFINED_T) >= 0 &&
    receiverIr.kind === "array"
  ) {
    // As with tuple receivers above, an unchecked outer read can be
    // undefined even when the checker reports an array. Extract the
    // present array arm with a runtime tag check before arrayGet or the
    // safe indexed-read helper runs.
    const present = lowerer.stripUndefinedArm(arr.type);
    const helper =
      present.kind === "array"
        ? lowerer.narrowedArmHelper(arr.type.unionId, present, locOf(expr.expression))
        : null;
    arr = helper
      ? { kind: "call", callee: helper, args: [arr], type: present, loc: locOf(expr.expression) }
      : lowerer.maybeNarrow(arr, expr.expression);
  }
  // The checker sees an array but the VALUE is an island handle (an
  // array-typed .d.ts surface: `parts()[0]` on a declared `string[]`
  // return, `issue.path[0]` on a declared member — arrays never exit
  // eagerly, so the call/member read stays jsval): the read rides
  // engine ops with the declared-element exit, never a static arrayGet
  // over a jsval (the validator ICE).
  if (arr.type.kind === "jsval") return islandElementRead(lowerer, expr, arr);
  // The checker sees an array but the VALUE lowered checked-dynamic (a
  // jsdoc-typed default export from a .js module — signature 14): the
  // read rides the dynCheck boundary when the array shape is one the checked-dynamic tree
  // can validate, and fences by name when it is not — an arrayGet over a
  // dyn receiver is never emitted (the validator ICE).
  if (arr.type.kind === "dyn") {
    if (
      canDynCheckTo(
        receiverIr,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      arr = { kind: "dynCheck", value: arr, type: receiverIr, loc: locOf(expr) };
    } else {
      lowerer.unsupported(
        "SC1090",
        expr,
        `element access on checked-dynamic values with '${lowerer.fmt(receiverIr)}' elements`,
      );
    }
  }
  // Array reads can themselves supply an index. A missing numeric value
  // is undefined, whose property lookup misses just like NaN; keep that
  // value instead of rejecting a checker-number index with optional IR.
  const index = lowerOptionalNumber(
    lowerer,
    lowerer.lowerExpr(expr.argumentExpression),
    locOf(expr.argumentExpression),
    expr.argumentExpression,
  );
  if (
    arr.type.kind === "array" &&
    (index.type.kind === "dyn" ||
      (isJsSourceFile(expr.getSourceFile()) &&
        index.type.kind !== "f64" &&
        lowerer.dynConvertible(index.type)))
  ) {
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(arr, DYN),
      key: index,
      type: DYN,
      loc: locOf(expr),
    };
  }
  if (index.type.kind !== "f64") {
    lowerer.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
  }
  // The LOWERED receiver's element type wins over the checker's when
  // both are arrays: a spoke result can be more precise than the
  // declared surface (emitter.listeners() answers the event's tuple
  // signature where the .d.ts says Function[], which would flatten the
  // element to a zero-parameter closure).
  const elemT = arr.type.kind === "array" ? arr.type.elem : receiverIr.elem;
  // Every ordinary array read is a JavaScript property read: an invalid
  // index answers undefined, even when the checker was built without
  // noUncheckedIndexedAccess. Keep the explicit optional union in the IR
  // so it can flow through templates, locals, calls, returns, operators,
  // and narrowing. The helper performs one length/proof check and then
  // uses the dense getter for the proven-present path, so this does not
  // change the storage representation or the low-level getter itself.
  if (arr.type.kind === "array") {
    // A non-null assertion is the explicit proven-present form. Preserve
    // the dense getter's established bounds trap here; turning `xs[i]!`
    // into an optional union would change library ABI checks and the
    // existing catchable RangeError contract for an out-of-bounds assert.
    const provenPresent = ts.isNonNullExpression(expr.parent) && expr.parent.expression === expr;
    if (provenPresent) {
      return lowerer.maybeNarrow(
        { kind: "arrayGet", arr, index, type: elemT, loc: locOf(expr) },
        expr,
      );
    }
    const safe = lowerSafeIndexRead(lowerer, arr, index, locOf(expr));
    if (safe) return safe;
  }
  // --npm-static package files retain the original slice-specific route
  // for compatibility with package-source inference.
  if (
    arr.type.kind === "array" &&
    arr.kind === "arrIntrinsic" &&
    arr.method === "slice" &&
    npmStaticPackageOfPath(expr.getSourceFile().fileName) !== null
  ) {
    const safe = lowerSafeIndexRead(lowerer, arr, index, locOf(expr));
    if (safe) return safe;
  }
  // A union-element read narrows like an identifier when the checker has
  // narrowed THIS occurrence (`if (a[0] !== undefined) use(a[0])` — tsc
  // narrows literal-index element accesses).
  return lowerer.maybeNarrow({ kind: "arrayGet", arr, index, type: elemT, loc: locOf(expr) }, expr);
}

/** `o[k]` where the RECEIVER is an island value — a jsval-mapped checker
 * type, or an array/tuple-typed .d.ts surface whose lowered value is a
 * handle. The key marshals in (any JS key kind — the engine does its
 * own ToPropertyKey) and the result stays island, EXCEPT when the
 * checker declares the element a primitive (`parts()[0]` on a declared
 * `string[]`): those exit eagerly to the static type, exactly the
 * island property-read rule (trust-but-verify — a lying declaration
 * throws the catchable TypeError; tsc puts the `| undefined` of a
 * short-circuiting chain on the OUTERMOST expression, so chain tails
 * never map primitive here). Chain-handled reads (`v?.[0]`) stay jsval
 * — the chain's unit path is the engine's undefined. */
function islandElementRead(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
  obj: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const key = lowerer.jsvalIn(lowerer.lowerExpr(expr.argumentExpression), expr.argumentExpression);
  const read: IrExpr = { kind: "jsOp", op: "getIdx", args: [obj, key], type: JSVAL, loc };
  if (!expr.questionDotToken) {
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (
      declared &&
      (declared.kind === "f64" ||
        declared.kind === "bool" ||
        declared.kind === "string" ||
        (declared.kind === "bytes" && declared.elem === "u8"))
    ) {
      return { kind: "jsExit", value: read, type: declared, loc };
    }
  }
  return read;
}

/** `r[k]` over a (non-tuple) record shape. A LITERAL key naming a declared
 * field is the bracket spelling of field access (the ONLY spelling tsc
 * permits for signature-declared fields under
 * noPropertyAccessFromIndexSignature) — an ordinary recordGet. Everything
 * else is a runtime-keyed read (recordKeyGet): declared fields answer
 * first via an emitted string-switch, index-signature shapes fall through
 * to the overflow map. The result type is the CHECKER's for the access —
 * the index signature's value type (dyn for `unknown`), or its
 * undefined-armed union under noUncheckedIndexedAccess. Every declared
 * field must be able to SURFACE as that type (equal, an arm of it, or —
 * for dyn results — JSON-safe for the dyn conversion); shapes mixing in
 * fields outside that stay fenced. Declared-only shapes support reads
 * whose key type proves membership (tsc's keyof check): all fields must
 * share the result type, and a smuggled miss traps. */
export function lowerRecordKeyRead(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
  shapeId: string,
  shape: IrRecordShape,
  includeUndefined = false,
): IrExpr {
  const loc = locOf(expr);
  const keyNode = expr.argumentExpression;
  // Literal declared keys are plain field reads (narrowing included).
  // NUMERIC literals are their canonical string spelling — JS object keys
  // ARE strings (`r[1]` reads `r["1"]`), so `b[1]` hits a declared field
  // named "1" (a mapped type over a numeric enum) exactly like `b["1"]`.
  // A key IDENTIFIER whose type proves one literal (a literal-typed
  // const, a keyof-constrained type parameter bound to a literal inside
  // a generic instance) is the same static read — identifier evaluation
  // is pure, so skipping it matches JS exactly.
  const litKey = recordKeyLiteralText(keyNode) ?? recordKeyTypeLiteralText(lowerer, keyNode);
  // The receiver lowers FIRST (both branches below read it, and JS
  // evaluates the receiver before the key).
  const obj = lowerer.lowerExpr(expr.expression);
  // A record-mapped CHECKER type over a VALUE living in the checked-dynamic tree (a JS
  // file-scope object-literal global): the checked-dynamic keyed read —
  // dynKeyGet against the runtime keys (a missing key answers the checked-dynamic tree
  // undefined, exactly JS); consumers validate (dynCheck) where a
  // static type is required, the member-read discipline.
  if (obj.type.kind === "dyn") {
    let dk =
      litKey !== null
        ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
        : lowerer.lowerExpr(keyNode);
    // Number AND checked-dynamic keys ride the JS-exact formatter —
    // property keys ARE strings (o[k] is o[String(k)] in JS), and a dyn
    // key (agent.sockets[agent.getName(...)]) stringifies the same way.
    if (dk.type.kind === "union" && lowerer.dynConvertible(dk.type))
      dk = lowerer.coerceToExpected(dk, DYN);
    if (dk.type.kind !== "symbol" && dk.type.kind !== "dyn")
      dk = lowerRecordPropertyKey(lowerer, dk, keyNode);
    if (dk.type.kind !== "string" && dk.type.kind !== "symbol" && dk.type.kind !== "dyn") {
      lowerer.unsupported("SC1090", keyNode, "indexing records with non-string or non-number keys");
    }
    const read: IrExpr = { kind: "dynKeyGet", key: dk, value: obj, type: DYN, loc };
    // Absence probes must keep the checked-dynamic undefined produced by
    // a missing key. The ordinary read narrows to the checker's declared
    // index value (and therefore validates it); ===/!==, ||, and ?? need
    // to observe the missing value instead of throwing during that check.
    return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
  }
  if (litKey !== null) {
    const nominal = representedClassFieldTarget(lowerer, expr.expression, litKey, obj);
    if (nominal) {
      const read = lowerer.fieldGetExpr(nominal, loc, expr);
      return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
    }
  }
  if (hasClassPayload(lowerer, obj.type)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "computed property reads through structural views of class instances (use a declared literal key)",
    );
  }
  // Predicates can strengthen optional fields without changing the
  // receiver's stored layout. Use that layout for bracket reads just as
  // fieldTarget does for the corresponding dot reads.
  if (obj.type.kind === "record") {
    const actualShape = lowerer.shapes.get(obj.type.shapeId);
    if (!actualShape)
      throw new InternalCompilerError("record receiver is missing its stored shape");
    shapeId = obj.type.shapeId;
    shape = actualShape;
  }
  if (litKey !== null) {
    const field = shape.fields.find((f) => f.name === litKey);
    if (field) {
      const get: IrExpr = {
        kind: "recordGet",
        obj,
        shapeId,
        field: field.name,
        type: field.type,
        loc,
      };
      return lowerer.maybeNarrow(get, expr);
    }
  }
  let key =
    litKey !== null
      ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
      : lowerer.lowerExpr(keyNode);
  // Optional string/number keys need ToPropertyKey, not a boxed copy of
  // the receiver. Keep record reads on their native storage so nested
  // references retain identity across index-signature reads.
  if (
    key.type.kind === "union" &&
    !lowerer.unions
      .get(key.type.unionId)
      ?.arms.some((arm) => arm.kind === "symbol" || arm.kind === "dyn")
  ) {
    key = lowerRecordPropertyKey(lowerer, key, keyNode);
  }
  if (
    (key.type.kind === "symbol" || key.type.kind === "dyn" || key.type.kind === "union") &&
    lowerer.dynConvertible(key.type) &&
    lowerer.dynConvertible(obj.type)
  ) {
    const read: IrExpr = {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(obj, DYN),
      key: lowerer.coerceToExpected(key, DYN),
      type: DYN,
      loc,
    };
    return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
  }
  // Runtime NUMBER keys ride the JS-exact formatter (o[n] is o[String(n)]
  // in JS — the number-keyed-signature access path).
  key = lowerRecordPropertyKey(lowerer, key, keyNode);
  if (key.type.kind !== "string") {
    lowerer.unsupported("SC1090", keyNode, "indexing records with non-string or non-number keys");
  }
  if (shape.fields.length === 0 && shape.indexValue === undefined) {
    const result = dynUndefinedExpr(loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "exprStmt", expr: obj, loc },
        { kind: "exprStmt", expr: key, loc },
      ],
      result,
      type: DYN,
      loc,
    };
  }
  // The DECLARED result type of the access — the index signature's value
  // type (armed with undefined under noUncheckedIndexedAccess), or the
  // declared fields' one common type on signature-free shapes (tsc's
  // keyof check proved membership; a smuggled miss traps). The checker
  // may have NARROWED this occurrence (assignment CFA on literal keys) —
  // maybeNarrow bridges to the narrowed arm exactly like a field read.
  let declared: IrType | null = null;
  if (shape.indexValue) {
    declared = shape.indexValue;
    if (
      declared.kind !== "dyn" &&
      (includeUndefined || lowerer.program.getCompilerOptions().noUncheckedIndexedAccess)
    ) {
      declared = lowerer.withUndefinedArmOf(declared);
      if (!declared) lowerer.badType(expr, lowerer.typeOf(expr));
    }
  } else if (
    shape.fields.length > 0 &&
    shape.fields.every((f) => typeEquals(f.type, shape.fields[0]!.type))
  ) {
    declared = shape.fields[0]!.type;
  }
  if (!declared && isJsSourceFile(expr.getSourceFile()) && recordKeyResultOk(lowerer, shape, DYN))
    declared = DYN;
  if (!declared) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `dynamic keyed reads of '${lowerer.fmt({ kind: "record", shapeId })}' (the declared fields have no one common type)`,
    );
  }
  // A LITERAL key naming no declared field can only hit the overflow:
  // the declared-field surfacing constraint doesn't apply.
  const overflowOnly = litKey !== null && !!shape.indexValue;
  if (!recordKeyResultOk(lowerer, overflowOnly ? { ...shape, fields: [] } : shape, declared)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `dynamic keyed reads of '${lowerer.fmt({ kind: "record", shapeId })}' as '${lowerer.fmt(declared)}' (every declared field must be readable at that type)`,
    );
  }
  const read: IrExpr = {
    kind: "recordKeyGet",
    obj,
    shapeId,
    key,
    ...(overflowOnly ? { overflowOnly: true as const } : {}),
    type: declared,
    loc,
  };
  return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
}

/** ToPropertyKey for represented record keys. Missing array-derived string
 * values remain real undefined values, whose JavaScript property spelling
 * is the string "undefined". */
function lowerRecordPropertyKey(lowerer: Lowerer, key: IrExpr, node: ts.Expression): IrExpr {
  if (key.type.kind === "union" && lowerer.dynConvertible(key.type)) {
    return {
      kind: "libCall",
      fn: "dyn.toStringCoerce",
      args: [lowerer.coerceInto(node, key, DYN)],
      type: STRING,
      loc: key.loc,
    };
  }
  if (
    key.type.kind === "f64" ||
    key.type.kind === "bool" ||
    key.type.kind === "dyn" ||
    lowerer.runtimeOptionalWidening(key.type, STRING) !== null
  ) {
    return lowerer.ensureString(key, node);
  }
  return key;
}

/** A keyed read used only to observe absence (`if (map[k])`, or the left
 * side of `||`/`??`). JavaScript answers undefined for missing record keys
 * and array indices even when noUncheckedIndexedAccess is disabled. Keep
 * that value in an explicit union until the surrounding guard/default has
 * consumed it; ordinary unchecked reads retain the typed trap. Assertions
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
  if (receiverT?.kind !== "array") return null;
  const arr = lowerer.lowerExpr(expr.expression);
  if (arr.type.kind !== "array") return null;
  const index = lowerer.lowerExpr(expr.argumentExpression);
  if (index.type.kind !== "f64") return null;
  return lowerSafeIndexRead(lowerer, arr, index, locOf(expr));
}

/** The compile-time string spelling of a record key literal: a string
 * literal's text, or a NON-NEGATIVE numeric literal's canonical JS
 * spelling (`1` → "1", `1e21` → "1e+21" — String(Number(text)), which is
 * exactly the key JS derives; negative/computed keys stay runtime
 * expressions and canonicalize through ensureString instead). Null for
 * everything else. */
function recordKeyLiteralText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  return null;
}

/** The compile-time key an IDENTIFIER's TYPE proves: a key variable whose
 * (narrowed) type is one string/number literal — `const k: "a" = …; o[k]`,
 * and the generic-body form where k's type is a keyof-constrained
 * parameter bound to a literal (`pick(o, "a")`'s instance reads `o[k]`
 * with K = "a", resolved through typeParamTsBindings). Identifier reads
 * are pure, so the static field read may skip evaluating the key exactly
 * like a syntactic literal. Null anywhere the type keeps more than one
 * key. */
function recordKeyTypeLiteralText(lowerer: Lowerer, node: ts.Expression): string | null {
  if (!ts.isIdentifier(node)) return null;
  let t: ts.Type = lowerer.typeOf(node);
  if (t.flags & ts.TypeFlags.TypeParameter) {
    const bound = lowerer.typeParamTsResolver(t);
    if (!bound) return null;
    t = bound;
  }
  if (t.isStringLiteralType()) return t.value;
  if (t.isNumberLiteralType()) {
    const n = t.value;
    return Number.isFinite(n) && n >= 0 ? String(n) : null;
  }
  return null;
}

/** Can every value a dynamic key can reach (declared fields + the
 * overflow) surface as the read's result type? dyn results need
 * dyn-convertible fields (JSON-safe, with the undefined arm allowed at
 * the top — an optional field's undefined becomes the undefined dyn
 * value, exactly what the missing-key path produces); typed results need
 * each field to be the type itself or one of its arms, and the overflow
 * value to be the type or wrappable into it. */
function recordKeyResultOk(lowerer: Lowerer, shape: IrRecordShape, type: IrType): boolean {
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

function exactUnionWidening(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (from.kind !== "union" || to.kind !== "union") return false;
  const source = lowerer.unions.get(from.unionId);
  const target = lowerer.unions.get(to.unionId);
  return !!source && !!target && unionWideningTags(source.arms, target.arms) !== null;
}

/** The literal index of a tuple access, or null when the expression isn't
 * a non-negative integer literal (parentheses tolerated — tsc's own
 * literal-index typing accepts them). */
function tupleLiteralIndex(node: ts.Expression): number | null {
  let e: ts.Expression = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isNumericLiteral(e)) return null;
  const n = Number(e.text);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `a[i] op= rhs` over native arrays and byte views. A compound assignment
 * evaluates the receiver and index, reads the old element, evaluates rhs,
 * then writes. Capture each stage so a call in the index or rhs cannot
 * change the target or the value used by the operator. The expression yields
 * the computed value before a typed array or Buffer coerces it for storage. */
export function lowerElementCompound(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  op: CompoundOp,
): IrExpr {
  const target = expr.left as ts.ElementAccessExpression;
  fenceNodeModuleMutation(lowerer, target, "assignment");
  const loc = locOf(expr);
  const checked = lowerer.lowerExpr(target.expression);
  if (checked?.type.kind === "dyn" && isJsSourceFile(expr.getSourceFile())) {
    const stmts: IrStmt[] = [];
    const save = (value: IrExpr, name: string): IrExpr => {
      const local = lowerer.declareHiddenLocal(name, value.type);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      return varRef(local.id, value.type, loc);
    };
    const receiver = save(checked, "%compoundReceiver");
    const key = save(lowerer.lowerExprExpecting(target.argumentExpression, DYN), "%compoundKey");
    const old = save({ kind: "dynKeyGet", value: receiver, key, type: DYN, loc }, "%compoundOld");
    const rhs = lowerer.lowerExprExpecting(expr.right, DYN);
    const numeric = ["-", "*", "/", "%", "**"].includes(op);
    const value = save(
      {
        kind: "libCall",
        fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
        args: op === "+" ? [old, rhs] : [old, rhs, strLit(op, loc)],
        type: DYN,
        loc,
      },
      "%compoundResult",
    );
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySetComputed",
        args: [receiver, key, value],
        type: VOID,
        loc,
      },
      loc,
    });
    return { kind: "seqExpr", stmts, result: value, type: DYN, loc };
  }
  const receiverType =
    checked.type.kind === "array" || checked.type.kind === "bytes"
      ? checked.type
      : lowerer.mapTypeOf(lowerer.typeOf(target.expression));
  if (receiverType?.kind !== "array" && receiverType?.kind !== "bytes") {
    lowerer.unsupported("SC1090", target, "compound assignment to non-array elements");
  }
  let receiver = checked;
  if (receiver.type.kind === "union" && lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0) {
    const present = lowerer.stripUndefinedArm(receiver.type);
    const helper =
      present.kind === receiverType.kind
        ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(target.expression))
        : null;
    if (helper)
      receiver = {
        kind: "call",
        callee: helper,
        args: [receiver],
        type: present,
        loc: locOf(target.expression),
      };
  }
  if (receiver.type.kind !== receiverType.kind) {
    lowerer.unsupported(
      "SC1090",
      target.expression,
      "compound assignment through a non-native array or byte view",
    );
  }
  const index = lowerer.lowerExpr(target.argumentExpression);
  if (index.type.kind !== "f64")
    lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
  const receiverLocal = lowerer.declareHiddenLocal("%compoundArray", receiver.type);
  const indexLocal = lowerer.declareHiddenLocal("%compoundIndex", F64);
  const receiverRef = (): IrExpr => varRef(receiverLocal.id, receiver.type, loc);
  const indexRef = (): IrExpr => varRef(indexLocal.id, F64, loc);
  const oldValue: IrExpr =
    receiver.type.kind === "array"
      ? arrayValueRead(lowerer, receiverRef(), indexRef(), receiver.type.elem, locOf(target))
      : {
          kind: "bytesIntrinsic",
          method: "get",
          receiver: receiverRef(),
          args: [indexRef()],
          type: F64,
          loc: locOf(target),
        };
  const oldLocal = lowerer.declareHiddenLocal("%compoundOld", oldValue.type);
  const oldRef = (): IrExpr => varRef(oldLocal.id, oldValue.type, loc);
  const rhs = lowerer.lowerExpr(expr.right);
  const numericRhs =
    rhs.type.kind === "dyn" &&
    isJsSourceFile(expr.getSourceFile()) &&
    receiver.type.kind === "bytes"
      ? { kind: "libCall" as const, fn: "dyn.toNumberCoerce" as const, args: [rhs], type: F64, loc }
      : lowerOptionalNumber(lowerer, rhs, loc);
  const elementType = receiver.type.kind === "array" ? receiver.type.elem : F64;
  const valueType =
    elementType.kind === "union" && lowerer.armTag(elementType.unionId, UNDEFINED_T) >= 0
      ? lowerer.stripUndefinedArm(elementType)
      : elementType;
  let computed: IrExpr;
  if (op === "+" && valueType.kind === "string") {
    computed = {
      kind: "strConcat",
      left: lowerer.ensureString(oldRef(), target),
      right: lowerer.ensureString(rhs, expr.right),
      type: STRING,
      loc,
    };
  } else if (valueType.kind === "f64" && numericRhs.type.kind === "f64") {
    computed = {
      kind: "bin",
      op,
      left: lowerOptionalNumber(lowerer, oldRef(), loc),
      right: numericRhs,
      type: F64,
      loc,
    };
  } else if (valueType.kind === "dyn" && isJsSourceFile(expr.getSourceFile())) {
    const left = lowerer.coerceToExpected(oldRef(), DYN),
      right = lowerer.coerceToExpected(rhs, DYN);
    const numeric = ["-", "*", "/", "%", "**"].includes(op);
    computed = {
      kind: "libCall",
      fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
      args: op === "+" ? [left, right] : [left, right, strLit(op, loc)],
      type: DYN,
      loc,
    };
  } else {
    lowerer.unsupported("SC1043", expr);
  }
  const resultLocal = lowerer.declareHiddenLocal("%compoundResult", computed.type);
  const resultRef = (): IrExpr => varRef(resultLocal.id, computed.type, loc);
  const write: IrStmt =
    receiver.type.kind === "array"
      ? arrayValueStore(lowerer, receiverRef(), indexRef(), resultRef(), receiver.type.elem, loc)
      : { kind: "bytesSet", arr: receiverRef(), index: indexRef(), value: resultRef(), loc };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: indexLocal.id, init: index, loc },
      { kind: "varDecl", localId: oldLocal.id, init: oldValue, loc },
      { kind: "varDecl", localId: resultLocal.id, init: computed, loc },
      write,
    ],
    result: resultRef(),
    type: computed.type,
    loc,
  };
}

/** Checked member assignment evaluates the reference before its RHS and
 * yields the original assigned value, including in a chained assignment. */
function lowerDynMemberAssignment(
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

/** JavaScript callable members live on the closure, so aliases and chained
 * writes share the same storage as Object.defineProperties. */
export function lowerNativeFunctionAssignment(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const target = expr.left;
  if (
    !isJsSourceFile(expr.getSourceFile()) ||
    (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) ||
    target.questionDotToken
  )
    return null;
  // Checked constructors share the callable's live property descriptors.
  const classType = storedClassValueType(lowerer, target.expression);
  const staticClass =
    classType?.kind === "classval" ? lowerer.classes.get(classType.className) : undefined;
  if (staticClass && hasRuntimeStatics(staticClass)) {
    return lowerDynMemberAssignment(
      lowerer,
      expr,
      lowerer.lowerExprExpecting(target.expression, DYN),
    );
  }
  // Other class statics and prototype tables have their own paths.
  // Probing them as ordinary functions could materialize unused methods.
  if (
    lowerer.exactClassOfReceiver(target.expression) ||
    (ts.isPropertyAccessExpression(target.expression) &&
      target.expression.name.text === "prototype" &&
      lowerer.exactClassOfReceiver(target.expression.expression))
  )
    return null;
  const receiver = tryLowerExpression(lowerer, target.expression);
  if (
    receiver?.type.kind !== "func" ||
    !canBoxFuncIntoDyn(
      receiver.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  fenceNodeModuleMutation(lowerer, target, "assignment");
  const fnName = jsFuncNameOf(target.expression);
  const boxed: IrExpr = {
    kind: "dynFrom",
    value: receiver,
    type: DYN,
    loc: locOf(target.expression),
    ...(fnName !== null ? { fnName } : {}),
  };
  return lowerDynMemberAssignment(lowerer, expr, boxed);
}

export function lowerElementWrite(lowerer: Lowerer, expr: ts.BinaryExpression): IrStmt {
  const prototype = lowerClassPrototypeComputedAssignment(lowerer, expr);
  if (prototype) return { kind: "exprStmt", expr: prototype, loc: locOf(expr) };
  const target = expr.left as ts.ElementAccessExpression;
  fenceNodeModuleMutation(lowerer, target, "assignment");
  const globalKey = globalSymbolKey(lowerer, target.expression, target.argumentExpression);
  if (globalKey) {
    const value = lowerer.lowerExprExpecting(expr.right, DYN);
    const loc = locOf(expr);
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.globalSymbolSet",
        args: [globalKey, value],
        type: VOID,
        loc,
      },
      loc,
    };
  }
  // `process.env[key] = v` — the computed twin of the dotted env write:
  // setenv(3), string keys and string values only.
  if (lowerer.isProcessEnv(target.expression) && !target.questionDotToken) {
    const loc = locOf(expr);
    const key = lowerEnvironmentKey(lowerer, target.argumentExpression);
    if (key.type.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        target.argumentExpression,
        "indexing process.env with non-string keys",
      );
    }
    const value = lowerer.lowerExpr(expr.right);
    if (value.type.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        expr.right,
        `assigning '${lowerer.fmt(value.type)}' values to process.env (env values are strings — convert first: \`\${v}\`)`,
      );
    }
    return {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "process.envSet", args: [key, value], type: VOID, loc },
      loc,
    };
  }
  // Symbol-keyed property WRITES (`this[kLimit] = v`): the read path's
  // twin — a statically-resolvable unique-symbol key declared on the
  // receiver's class writes the hidden field slot; everything else keeps
  // the fence (static shapes have no symbol-keyed storage).
  if (lowerer.mapTypeOf(lowerer.typeOf(target.argumentExpression))?.kind === "symbol") {
    const fieldT = symbolFieldTarget(lowerer, target);
    if (fieldT) {
      const value = lowerer.lowerExprExpecting(expr.right, fieldT.fieldType);
      return lowerer.fieldSetStmt(fieldT, value, locOf(expr), target);
    }
    const receiver = lowerer.lowerExpr(target.expression);
    if (receiver.type.kind === "dyn")
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(lowerer, expr, receiver),
        loc: locOf(expr),
      };
    if (
      isJsSourceFile(expr.getSourceFile()) &&
      receiver.type.kind === "object" &&
      lowerer.dynConvertible(receiver.type)
    ) {
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(lowerer, expr, lowerer.coerceToExpected(receiver, DYN)),
        loc: locOf(expr),
      };
    }
    lowerer.unsupported(
      "SC1090",
      target,
      "symbol-keyed property writes outside class fields keyed by a stable module-level literal Symbol()/Symbol.for() (other static shapes have no symbol-keyed storage)",
    );
  }
  const checkedReceiver = tryLowerExpression(lowerer, target.expression);
  if (checkedReceiver?.type.kind === "dyn") {
    return {
      kind: "exprStmt",
      expr: lowerDynMemberAssignment(lowerer, expr, checkedReceiver),
      loc: locOf(expr),
    };
  }
  if (checkedReceiver?.type.kind === "object" && isJsSourceFile(expr.getSourceFile())) {
    const info = lowerer.classes.get(checkedReceiver.type.className);
    const key =
      recordKeyLiteralText(target.argumentExpression) ??
      recordKeyTypeLiteralText(lowerer, target.argumentExpression);
    if (info && key !== null && isClassCallback(lowerer, info, key)) {
      const receiver = lowerer.coerceInto(target.expression, checkedReceiver, DYN);
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(lowerer, expr, receiver),
        loc: locOf(expr),
      };
    }
  }
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(target.expression));
  if (isJsSourceFile(expr.getSourceFile()) && checkedReceiver) {
    const represented =
      checkedReceiver.type.kind === "union"
        ? lowerer.stripUndefinedArm(checkedReceiver.type)
        : checkedReceiver.type;
    if (represented.kind === "array" || represented.kind === "bytes") receiverIr = represented;
  }
  if (receiverIr === null || receiverIr.kind === "dyn") {
    const receiver = tryLowerExpression(lowerer, target.expression);
    if (receiver?.type.kind === "array") receiverIr = receiver.type;
  }
  if (receiverIr?.kind === "jsval") {
    const obj = lowerer.lowerExpr(target.expression);
    // Dispatch follows the RUNTIME world (383(d)): a checker-'any'
    // receiver whose value LOWERED checked-dynamic takes the dyn keyed
    // write — the routed JSVAL arm lands it on the real engine object.
    if (obj.type.kind === "dyn") {
      const loc = locOf(expr);
      const rawKey = lowerer.lowerExpr(target.argumentExpression);
      const key: IrExpr =
        rawKey.type.kind === "f64" || rawKey.type.kind === "bool" || rawKey.type.kind === "dyn"
          ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
          : rawKey;
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          `'${lowerer.fmt(key.type)}'-typed keys in keyed writes through 'unknown' values`,
        );
      }
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
      if (value.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1100",
          expr.right,
          `assigning '${lowerer.fmt(value.type)}' values through 'unknown' receivers`,
        );
      }
      return {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
        loc,
      };
    }
    const key = lowerer.jsvalIn(
      lowerer.lowerExpr(target.argumentExpression),
      target.argumentExpression,
    );
    const value = lowerer.jsvalIn(lowerer.lowerExpr(expr.right), expr.right);
    const loc = locOf(expr);
    return {
      kind: "exprStmt",
      expr: { kind: "jsOp", op: "setIdx", args: [obj, key, value], type: VOID, loc },
      loc,
    };
  }
  // A checked-dynamic receiver TYPE (`unknown[]` and the collapsed
  // `(string | object)[]` map to DYN wholesale now): the dyn keyed
  // write — dyn.keySet. Number keys canonicalize through the JS-exact
  // formatter; ARR receivers take canonical index keys as element
  // set/extend (undefined-hole padding, JS's length growth exactly),
  // OBJ receivers set the member, and the runtime throws Node's
  // TypeErrors on every other kind. Values convert into the checked-dynamic tree;
  // unconvertible ones fence per site (the dynFrom stance).
  if (receiverIr?.kind === "dyn") {
    const obj = lowerer.lowerExpr(target.expression);
    if (obj.type.kind === "dyn") {
      const loc = locOf(expr);
      const key = lowerRecordPropertyKey(
        lowerer,
        lowerer.lowerExpr(target.argumentExpression),
        target.argumentExpression,
      );
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "indexing with non-string or non-number keys",
        );
      }
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
      if (value.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1101",
          expr.right,
          `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic array (the value cannot convert into the checked-dynamic tree)`,
        );
      }
      return {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
        loc,
      };
    }
  }
  if (receiverIr?.kind === "object" || receiverIr?.kind === "record") {
    const key =
      recordKeyLiteralText(target.argumentExpression) ??
      recordKeyTypeLiteralText(lowerer, target.argumentExpression);
    if (key !== null) {
      const receiver = lowerer.lowerExpr(target.expression);
      const field = representedClassFieldTarget(lowerer, target.expression, key, receiver);
      if (field) {
        const value = lowerer.lowerExprExpecting(expr.right, field.fieldType);
        return lowerer.fieldSetStmt(field, value, locOf(expr), target);
      }
      if (hasClassPayload(lowerer, receiver.type)) {
        if (receiver.type.kind === "object" && receiver.type.className === "%Error") {
          return {
            kind: "exprStmt",
            expr: lowerDynMemberAssignment(
              lowerer,
              expr,
              lowerer.coerceInto(target.expression, receiver, DYN),
            ),
            loc: locOf(expr),
          };
        }
        lowerer.unsupported(
          "SC1090",
          target,
          "writing undeclared properties through structural views of class instances",
        );
      }
    }
  }
  // Typed-array element write `b[i] = v` — bytesSet: the value is an f64
  // the runtime coerces JS-exactly; invalid indices are ignored.
  if (receiverIr?.kind === "bytes") {
    const recv = lowerer.lowerExpr(target.expression);
    // The write twin: a typed-array .d.ts surface whose VALUE is a
    // handle takes the engine keyed write.
    if (recv.type.kind === "jsval") {
      const key = lowerer.jsvalIn(
        lowerer.lowerExpr(target.argumentExpression),
        target.argumentExpression,
      );
      const value = lowerer.jsvalIn(lowerer.lowerExpr(expr.right), expr.right);
      const loc = locOf(expr);
      return {
        kind: "exprStmt",
        expr: { kind: "jsOp", op: "setIdx", args: [recv, key, value], type: VOID, loc },
        loc,
      };
    }
    const index = lowerer.lowerExpr(target.argumentExpression);
    if (index.type.kind === "dyn" && recv.type.kind === "bytes") {
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(
          lowerer,
          expr,
          lowerer.coerceInto(target.expression, recv, DYN),
        ),
        loc: locOf(expr),
      };
    }
    if (index.type.kind !== "f64") {
      lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
    }
    const value = lowerer.lowerExprExpecting(expr.right, F64);
    return { kind: "bytesSet", arr: recv, index, value, loc: locOf(expr) };
  }
  // Tuple element write `t[0] = v`: a positional-field write (recordSet)
  // — literal indices only, like the read.
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    // A record/tuple-typed .d.ts surface whose VALUE is an island
    // handle: the engine keyed write (the read dispatch's twin), never
    // a recordSet/recordKeySet over a jsval.
    if (shape) {
      const obj = lowerer.lowerExpr(target.expression);
      if (hasClassPayload(lowerer, obj.type)) {
        lowerer.unsupported(
          "SC1090",
          target,
          "computed property writes through structural views of class instances (use a declared literal key)",
        );
      }
      if (obj.type.kind === "jsval") {
        const key = lowerer.jsvalIn(
          lowerer.lowerExpr(target.argumentExpression),
          target.argumentExpression,
        );
        const value = lowerer.jsvalIn(lowerer.lowerExpr(expr.right), expr.right);
        const loc = locOf(expr);
        return {
          kind: "exprStmt",
          expr: { kind: "jsOp", op: "setIdx", args: [obj, key, value], type: VOID, loc },
          loc,
        };
      }
      // A record-mapped CHECKER type over a VALUE living in the checked-dynamic tree (a
      // JS file-scope object-literal global): the checked-dynamic keyed
      // write — dyn.keySet (later writes win, insertion order; Node's
      // TypeErrors on non-object receivers), the value converting into
      // the checked-dynamic tree. Literal and runtime keys alike: the checked-dynamic tree's key set is
      // open, so no declared-field collision analysis applies.
      if (obj.type.kind === "dyn") {
        const loc = locOf(expr);
        const litKey = recordKeyLiteralText(target.argumentExpression);
        let key: IrExpr =
          litKey !== null
            ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
            : lowerer.lowerExpr(target.argumentExpression);
        key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
        if (key.type.kind !== "string") {
          lowerer.unsupported(
            "SC1090",
            target.argumentExpression,
            "indexing records with non-string or non-number keys",
          );
        }
        const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
        if (value.type.kind !== "dyn") {
          lowerer.unsupported(
            "SC1101",
            expr.right,
            `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
          );
        }
        return {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
          loc,
        };
      }
    }
    if (shape?.tuple) {
      const idx = tupleLiteralIndex(target.argumentExpression);
      if (idx === null) {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "tuple indexing with a non-literal index (tuples are fixed-shape — use t[0], t[1], ...)",
        );
      }
      const fieldType = shape.fields.find((f) => f.name === String(idx))?.type;
      if (fieldType === undefined) lowerer.badType(target, lowerer.typeOf(target));
      const obj = lowerer.lowerExpr(target.expression);
      const value = lowerer.lowerExprExpecting(expr.right, fieldType);
      return {
        kind: "recordSet",
        obj,
        shapeId: receiverIr.shapeId,
        field: String(idx),
        value,
        loc: locOf(expr),
      };
    }
    // Dynamic keyed write `r[k] = v` — index-signature shapes only (a
    // declared-only shape's writable key set is closed; spell the field).
    // A LITERAL declared key is the bracket spelling of a field write.
    // Values flow into the index-value slot (dyn slots convert, typed
    // slots coerce); declared-key collisions at runtime validate against
    // the field's type through the emitted helper (a mismatch throws the
    // catchable TypeError — SEMANTICS.md).
    if (shape && !shape.tuple) {
      // Literal keys — string literals AND numeric literals in their
      // canonical string spelling (`b[1] = v` writes field/key "1", JS's
      // own key derivation) — name declared fields directly. A key
      // IDENTIFIER whose TYPE proves one literal (a literal-typed const,
      // a keyof-constrained type parameter bound to a literal inside a
      // generic instance — `set(o, "a", v)`'s body writing `o[k] = v`)
      // is the same static field write.
      const litKey =
        recordKeyLiteralText(target.argumentExpression) ??
        recordKeyTypeLiteralText(lowerer, target.argumentExpression);
      if (litKey !== null) {
        const field = shape.fields.find((f) => f.name === litKey);
        if (field) {
          const obj = lowerer.lowerExpr(target.expression);
          const value = lowerer.lowerExprExpecting(expr.right, field.type);
          return {
            kind: "recordSet",
            obj,
            shapeId: receiverIr.shapeId,
            field: litKey,
            value,
            loc: locOf(expr),
          };
        }
      }
      if (!shape.indexValue) {
        // A SIGNATURE-FREE shape whose declared fields share ONE type
        // writes through the same per-shape dispatch (the mockable-clock
        // module shape: `mocked[functionality] = implementation` over a
        // table of same-signature closures). A key naming no declared
        // field throws the catchable TypeError — JS would ADD the
        // property, which a monomorphic struct cannot (the SEMANTICS.md
        // keyed-write-miss divergence). Mixed-type and accessor-carrying
        // shapes keep the fence.
        const common =
          shape.fields.length > 0 &&
          !shapeHasAccessorSlots(shape) &&
          shape.fields.every((f) => typeEquals(f.type, shape.fields[0]!.type))
            ? shape.fields[0]!.type
            : null;
        if (!common) {
          lowerer.unsupported(
            "SC1090",
            target,
            "dynamic keyed writes to records without an index signature (declared fields of ONE shared type dispatch by key — spell the field name otherwise)",
          );
        }
        const obj = lowerer.lowerExpr(target.expression);
        let key: IrExpr =
          litKey !== null
            ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
            : lowerer.lowerExpr(target.argumentExpression);
        // Runtime number/boolean/dyn keys stringify — ToPropertyKey,
        // exactly the index-signature path's rule.
        key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
        if (key.type.kind !== "string") {
          lowerer.unsupported(
            "SC1090",
            target.argumentExpression,
            "indexing records with non-string or non-number keys",
          );
        }
        const value = lowerer.coerceInto(expr.right, lowerer.lowerExpr(expr.right), common);
        if (!typeEquals(value.type, common))
          lowerer.badType(expr.right, lowerer.typeOf(expr.right));
        return {
          kind: "recordKeySet",
          obj,
          shapeId: receiverIr.shapeId,
          key,
          value,
          loc: locOf(expr),
        };
      }
      // A LITERAL key naming no declared field is a pure overflow insert
      // — no collision to validate. Runtime keys must be able to collide
      // with every declared field: dyn slots validate through the
      // dynCheck walker (fields must be dyn-convertible — the same
      // convertibility the read needs); typed slots write through
      // directly, so every field must BE the index-value type.
      const overflowOnly = litKey !== null;
      const writable =
        overflowOnly ||
        (shape.indexValue.kind === "dyn"
          ? shape.fields.every((f) => lowerer.dynConvertible(f.type))
          : shape.fields.every((f) => typeEquals(f.type, shape.indexValue!)));
      if (!writable) {
        lowerer.unsupported(
          "SC1090",
          target,
          `dynamic keyed writes to '${lowerer.fmt(receiverIr)}' (a declared field's type cannot take the index signature's value at runtime)`,
        );
      }
      const obj = lowerer.lowerExpr(target.expression);
      let key =
        litKey !== null
          ? ({
              kind: "strLit",
              value: litKey,
              type: STRING,
              loc: locOf(target.argumentExpression),
            } satisfies IrExpr)
          : lowerer.lowerExpr(target.argumentExpression);
      // Runtime NUMBER keys canonicalize through the JS-exact formatter
      // (o[n] = v writes o[String(n)] — the number-keyed-signature path).
      key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "indexing records with non-string or non-number keys",
        );
      }
      const value = lowerer.intoIndexValueSlot(
        lowerer.lowerExpr(expr.right),
        shape.indexValue,
        expr.right,
      );
      return {
        kind: "recordKeySet",
        obj,
        shapeId: receiverIr.shapeId,
        key,
        value,
        ...(overflowOnly ? { overflowOnly: true as const } : {}),
        loc: locOf(expr),
      };
    }
  }
  // Keyed write `d[k] = v` on a CHECKED-DYNAMIC receiver (a JS `any`
  // dictionary — the Object.create(null) memo-table idiom writes
  // `result[key] = value`): dyn.keySet, exactly the record-mapped dyn
  // arm above — later writes win in insertion order, number keys
  // canonicalize through the JS-exact formatter (ToPropertyKey's string
  // side), index keys on dyn arrays set/extend elements, and non-object
  // receivers throw Node's TypeErrors at runtime. An UNMAPPED checker
  // type (static `any` — mapTypeOf answers null without --dynamic)
  // probes the receiver's own lowered world: a dyn value takes the same
  // write, anything else falls through to the fences.
  if (receiverIr?.kind === "dyn" || receiverIr?.kind === "object" || receiverIr === null) {
    const obj =
      receiverIr !== null
        ? lowerer.lowerExpr(target.expression)
        : tryLowerExpression(lowerer, target.expression);
    if (
      obj !== null &&
      (obj.type.kind === "dyn" ||
        (obj.type.kind === "object" && obj.type.className === "%Error") ||
        isDynTypedRefType(obj.type))
    ) {
      const loc = locOf(expr);
      const litKey = recordKeyLiteralText(target.argumentExpression);
      let key: IrExpr =
        litKey !== null
          ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
          : lowerer.lowerExpr(target.argumentExpression);
      key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "indexing checked-dynamic values with non-string or non-number keys",
        );
      }
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
      if (value.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1101",
          expr.right,
          `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
        );
      }
      return {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySet",
          args: [lowerer.coerceToExpected(obj, DYN), key, value],
          type: VOID,
          loc,
        },
        loc,
      };
    }
  }
  if (receiverIr?.kind !== "array") {
    lowerer.unsupported("SC1090", target, "assignment to non-array elements");
  }
  let arr = lowerer.lowerExpr(target.expression);
  // The write twin of the island element read: an array-typed .d.ts
  // surface whose VALUE is a handle takes the engine keyed write, never
  // a static arraySet over a jsval.
  if (arr.type.kind === "jsval") {
    const key = lowerer.jsvalIn(
      lowerer.lowerExpr(target.argumentExpression),
      target.argumentExpression,
    );
    const value = lowerer.jsvalIn(lowerer.lowerExpr(expr.right), expr.right);
    const loc = locOf(expr);
    return {
      kind: "exprStmt",
      expr: { kind: "jsOp", op: "setIdx", args: [arr, key, value], type: VOID, loc },
      loc,
    };
  }
  if (
    arr.type.kind === "union" &&
    lowerer.armTag(arr.type.unionId, UNDEFINED_T) >= 0 &&
    receiverIr.kind === "array"
  ) {
    const present = lowerer.stripUndefinedArm(arr.type);
    const helper =
      present.kind === "array"
        ? lowerer.narrowedArmHelper(arr.type.unionId, present, locOf(target.expression))
        : null;
    if (helper) {
      arr = {
        kind: "call",
        callee: helper,
        args: [arr],
        type: present,
        loc: locOf(target.expression),
      };
    }
  }
  if (arr.type.kind !== "array") {
    lowerer.unsupported(
      "SC1090",
      target.expression,
      "assignment through a possibly missing nested array receiver",
    );
  }
  const index = lowerOptionalNumber(
    lowerer,
    lowerer.lowerExpr(target.argumentExpression),
    locOf(target.argumentExpression),
    target.argumentExpression,
  );
  if (index.type.kind === "dyn" && lowerer.dynConvertible(arr.type)) {
    return {
      kind: "exprStmt",
      expr: lowerDynMemberAssignment(
        lowerer,
        expr,
        lowerer.coerceInto(target.expression, arr, DYN),
      ),
      loc: locOf(expr),
    };
  }
  if (index.type.kind !== "f64") {
    lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
  }
  // Optional array reads carry the source array's payload type plus an
  // undefined arm. arrayValueStore turns that arm into the runtime's
  // UNDEFINED state while keeping number[]/string[] payload storage scalar.
  let literal = expr.right;
  while (ts.isParenthesizedExpression(literal) || ts.isSatisfiesExpression(literal))
    literal = literal.expression;
  const value =
    ts.isObjectLiteralExpression(literal) || ts.isArrayLiteralExpression(literal)
      ? lowerer.lowerExprExpecting(literal, arr.type.elem)
      : lowerer.lowerExpr(expr.right);
  // Validate the payload before emitting a native store. A dormant JS
  // method can contradict its JSDoc element type; retain its call-time
  // refusal instead of leaving invalid IR in a newly reachable method.
  const expected =
    value.type.kind === "undefinedT" ||
    (value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0)
      ? arrayValueType(lowerer, arr.type.elem)
      : arr.type.elem;
  return arrayValueStore(
    lowerer,
    arr,
    index,
    lowerer.coerceInto(expr.right, value, expected),
    arr.type.elem,
    locOf(expr),
  );
}

/** Environment property names use ToPrimitive with the string hint, so
 * checked objects must execute their own conversion hooks. */
export function lowerEnvironmentKey(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const key = lowerer.lowerExpr(node);
  if (key.type.kind === "dyn")
    return { kind: "libCall", fn: "dyn.toStringCoerce", args: [key], type: STRING, loc: key.loc };
  return lowerRecordPropertyKey(lowerer, key, node);
}

export function ensureString(lowerer: Lowerer, e: IrExpr, node: ts.Node): IrExpr {
  if (e.type.kind === "string") return e;
  if (e.type.kind === "url")
    return { kind: "libCall", fn: "url.href", args: [e], type: STRING, loc: e.loc };
  if (e.type.kind === "regex") {
    return {
      kind: "regexIntrinsic",
      method: "toString",
      receiver: e,
      args: [],
      type: STRING,
      loc: e.loc,
    };
  }
  if (e.type.kind === "bigint") {
    return {
      kind: "libCall",
      fn: "bigint.toString",
      args: [e, { kind: "numLit", value: 10, type: F64, loc: e.loc }],
      type: STRING,
      loc: e.loc,
    };
  }
  if (e.type.kind === "dyn") {
    // String(u) / `${u}`: a runtime dispatch over the dyn kind — Node's
    // String() exactly (undefined/null texts, JS number formatting,
    // strings verbatim, arrays via join, objects as "[object Object]").
    return { kind: "toString", operand: e, type: STRING, loc: e.loc };
  }
  if (e.type.kind === "bytes") {
    // Preserve the runtime brand: typed arrays join numeric elements,
    // while a Buffer stored in a Uint8Array slot decodes its bytes.
    const boxed: IrExpr = { kind: "dynFrom", value: e, type: DYN, loc: e.loc };
    return { kind: "toString", operand: boxed, type: STRING, loc: e.loc };
  }
  if (e.type.kind === "jsval") {
    // String(v) in the engine — JS-exact (and Node-exact in templates).
    return { kind: "jsOp", op: "toStr", args: [e], type: STRING, loc: e.loc };
  }
  if (e.type.kind === "object") {
    // String(err) / `${err}` uses the same dispatch as err.toString().
    for (let c = lowerer.classes.get(e.type.className) ?? null; c; c = c.base) {
      if (c.builtinError) {
        return errorToStringCall(lowerer, e);
      }
    }
  }
  if (e.type.kind === "union") {
    // `${u}` — the arm's ToString via a per-union interned helper
    // (sc_us_*), Node-exact per arm kind: unit arms are the known texts
    // "undefined"/"null", string arms pass through, f64/bool arms use the
    // JS-exact formatters. Ref arms (records, arrays, ...) stay fenced:
    // JS would print "[object Object]" and friends — narrow first.
    const def = lowerer.unions.get(e.type.unionId);
    const stringable = def?.arms.every(
      (a) =>
        a.kind === "undefinedT" ||
        a.kind === "nullT" ||
        a.kind === "string" ||
        a.kind === "f64" ||
        a.kind === "bigint" ||
        a.kind === "bool",
    );
    if (stringable) {
      return { kind: "toString", operand: e, type: STRING, loc: e.loc };
    }
    // Runtime-optional locals can retain their stored union after the
    // checker has narrowed this use to a primitive arm. Validate that
    // arm before converting it; an unguarded object arm stays fenced.
    const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (
      narrowed &&
      (narrowed.kind === "string" ||
        narrowed.kind === "f64" ||
        narrowed.kind === "bool" ||
        narrowed.kind === "bigint")
    ) {
      const helper = lowerer.narrowedArmHelper(e.type.unionId, narrowed, e.loc);
      if (helper) {
        return ensureString(
          lowerer,
          { kind: "call", callee: helper, args: [e], type: narrowed, loc: e.loc },
          node,
        );
      }
    }
    if (
      narrowed?.kind === "union" &&
      !typeEquals(narrowed, e.type) &&
      lowerer.unions
        .get(narrowed.unionId)
        ?.arms.every(
          (arm) =>
            isUnitType(arm) ||
            arm.kind === "string" ||
            arm.kind === "f64" ||
            arm.kind === "bool" ||
            arm.kind === "bigint",
        )
    ) {
      const helper = lowerer.narrowedRetagHelper(node, e.type.unionId, narrowed.unionId, e.loc);
      if (helper)
        return ensureString(
          lowerer,
          { kind: "call", callee: helper, args: [e], type: narrowed, loc: e.loc },
          node,
        );
    }
    lowerer.unsupported(
      "SC1090",
      node,
      `string conversions of unions with object arms (${NARROW_FIRST})`,
    );
  }
  if (e.type.kind === "symbol") {
    // JS splits here: `${sym}` and concatenation THROW a TypeError,
    // String(sym) answers "Symbol(desc)". One shared lowering cannot
    // honor both — fence with the sanctioned spelling instead of
    // guessing the context.
    lowerer.unsupported(
      "SC1090",
      node,
      "string conversions of symbol values (template literals throw in JS — call .toString() explicitly)",
    );
  }
  if (isUnitType(e.type)) {
    if (e.kind === "unitLit") {
      return { kind: "strLit", value: e.unit, type: STRING, loc: e.loc };
    }
    // Keep sequencing and branch effects even though the final unit's
    // spelling is constant. Never turn an unknown producer into a literal.
    if (e.kind === "seqExpr") {
      return { ...e, result: lowerer.ensureString(e.result, node), type: STRING };
    }
    if (e.kind === "ternary") {
      return {
        ...e,
        then: lowerer.ensureString(e.then, node),
        else_: lowerer.ensureString(e.else_, node),
        type: STRING,
      };
    }
    lowerer.unsupported(
      "SC1090",
      node,
      `string conversions of '${e.type.kind === "undefinedT" ? "undefined" : "null"}' values`,
    );
  }
  if (e.type.kind === "array") {
    // `${[1,2,3]}` / String(arr): Array.prototype.toString IS join(",")
    // — the SAME intrinsic the .join() lowering emits, fenced to the
    // same element kinds (f64/string/bool, unions of those with unit
    // arms printing empty). Nested arrays would need JS's recursive
    // dispatch — the join fence already tells that story.
    const elem = e.type.elem;
    const joinableUnion =
      elem.kind === "union" &&
      (lowerer.unions
        .get(elem.unionId)
        ?.arms.every(
          (a) => a.kind === "f64" || a.kind === "string" || a.kind === "bool" || isUnitType(a),
        ) ??
        false);
    if (elem.kind === "f64" || elem.kind === "string" || elem.kind === "bool" || joinableUnion) {
      const sep: IrExpr = { kind: "strLit", value: ",", type: STRING, loc: e.loc };
      return {
        kind: "arrIntrinsic",
        method: "join",
        receiver: e,
        args: [sep],
        type: STRING,
        loc: e.loc,
      };
    }
  }
  if (e.type.kind === "record") {
    // `${obj}` / String(obj): a plain data record has no toString of its
    // own (a func-typed `toString` FIELD would shadow the prototype's —
    // JS would call it, so that shape keeps the fence), and a TUPLE
    // prints its elements like an array (not lowered — fenced) — every
    // other record is Object.prototype.toString's constant.
    const shape = lowerer.shapes.get(e.type.shapeId);
    if (shape && !shape.tuple && !shape.fields.some((f) => f.name === "toString")) {
      return { kind: "toString", operand: e, type: STRING, loc: e.loc };
    }
  }
  if (e.type.kind !== "f64" && e.type.kind !== "bool") lowerer.badType(node, lowerer.typeOf(node));
  return { kind: "toString", operand: e, type: STRING, loc: e.loc };
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
  if (symbol?.name !== "String" || !lowerer.isStdlibSymbol(symbol)) return null;
  const args = e.arguments ?? [];
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
  for (const span of expr.templateSpans) {
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
    expr.expression.elements.length === 0
  ) {
    return {
      kind: "arrayLit",
      elems: [],
      type: arrayOf(unitOnlyUnion(lowerer.unions)),
      loc: locOf(expr),
    };
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
    // Structural assertions use the ordinary checked dynamic bridge. It
    // retains primitive values and native class identity before validating
    // the requested shape; an assertion does not bypass runtime checks.
    const narrowed = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
    const bridged =
      narrowed &&
      (narrowed.kind === "f64" ||
        narrowed.kind === "bool" ||
        narrowed.kind === "string" ||
        narrowed.kind === "object" ||
        narrowed.kind === "dyn");
    if (!bridged) lowerer.unsupported("SC1063", expr);
  }
  const inner = lowerer.lowerExpr(expr.expression);
  const use = runtimeOptionalUseOf(expr);
  if (inner.type.kind === "union" && runtimeOptionalAssertionErases(lowerer, expr, inner, use))
    return inner;
  if (inner.type.kind !== "dyn" && inner.type.kind !== "jsval") {
    // A STATIC value cast `as any` is the explicit island entrance.
    const targetTs0 = lowerer.checker.getTypeFromTypeNode(expr.type);
    if (targetTs0.flags & ts.TypeFlags.Any && lowerer.dynamic) {
      return lowerer.jsvalIn(inner, expr.expression);
    }
    const target = lowerer.mapTypeOf(targetTs0);
    if (target?.kind === "object") {
      const asserted = checkedClassAssertion(lowerer, inner, target, locOf(expr));
      if (asserted) return asserted;
    }
    // Unknown-only record views use the checked-dynamic representation.
    // A native record asserted to such a view still denotes the original
    // object. Box a live reference instead of erasing the assertion and
    // handing native storage to a checked-dynamic property operation.
    if (target?.kind === "dyn" && (targetTs0.flags & ts.TypeFlags.Object) !== 0) {
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
      return boxed.kind === "dynFrom" ? { ...boxed, liveRef: true } : boxed;
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
    // Static assertions normally erase, but record layouts are
    // monomorphic: a consumer selected from the asserted shape must see
    // that shape physically. Reuse the ordinary slot coercion so plain
    // widths and index-signature captures share their established copy
    // semantics (and unsupported pairs report SC2002 at this assertion).
    if (
      inner.type.kind === "record" &&
      target?.kind === "record" &&
      inner.type.shapeId !== target.shapeId
    ) {
      return lowerer.coerceInto(expr, inner, target);
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
        const helper = lowerer.narrowedArmHelper(inner.type.unionId, target, locOf(expr));
        if (helper) {
          return { kind: "call", callee: helper, args: [inner], type: target, loc: locOf(expr) };
        }
      }
    }
    return inner; // erasure, unchanged
  }
  if (inner.type.kind === "jsval") {
    // The island exit. `as any` on an island value is erasure; a static
    // target compiles to a VALIDATED extraction (strict primitives; the
    // JSON round-trip + dynCheck walker for composites) that throws a
    // catchable TypeError on mismatch — same trust-but-verify rule as
    // the dyn boundary. Targets with no extraction are rejected.
    const targetTs = lowerer.checker.getTypeFromTypeNode(expr.type);
    if (targetTs.flags & ts.TypeFlags.Any) return inner;
    const target = lowerer.mapTypeOf(targetTs);
    if (!target) lowerer.badType(expr.type, targetTs);
    if (!lowerer.boundarySafe(target)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `a checked cast of 'any' to '${lowerer.fmt(target)}' ` +
          `(an 'any' value can only be validated against JSON-representable types: ` +
          `number, string, boolean, records, arrays, and unions of those)`,
      );
    }
    return { kind: "jsExit", value: inner, type: target, loc: locOf(expr) };
  }
  const targetTs = lowerer.checker.getTypeFromTypeNode(expr.type);
  const target = lowerer.mapTypeOf(targetTs) ?? dynFallbackType(lowerer, expr.type, targetTs);
  if (!target) lowerer.badType(expr.type, targetTs);
  if (target.kind === "dyn") return inner; // `as unknown`: erasure
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
  if (
    target.kind === "void" ||
    !canDynCheckTo(
      target,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    // Bare undefined-armed targets pass when every OTHER arm is
    // JSON-safe: the checked-dynamic tree holds a first-class undefined value now
    // (index-signature overflow reads produce it for missing keys), and
    // the undefined arm matches exactly it — `p[key] as string |
    // undefined` is the missing-key idiom. Parsed JSON still never
    // contains undefined, so casts over parse results keep failing on
    // non-string values with the usual path-annotated TypeError.
    if (target.kind === "union" && lowerer.dynConvertible(target)) {
      return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
    }
    // Uint8Array targets: the checked-dynamic tree carries a bytes kind now (converted
    // stdin chunks) — the extraction validates the kind and copies out.
    if (target.kind === "bytes" && target.elem === "u8") {
      return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
    }
    // Class instances round-trip only through compiler-owned typed
    // references. Plain JSON objects fail the runtime class-brand check;
    // exact capsules unwrap the original object by identity.
    if (isDynTypedRefType(target)) {
      return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
    }
    // ADAPTABLE function targets (`u as (x: number) => number` — the
    // checked-dynamic function boundary): kind check, then exact unwrap
    // or the per-target adapter shim. Non-adaptable signatures keep the
    // fence below.
    if (
      target.kind === "func" &&
      canAdaptDynFuncTo(
        target,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
    }
    // Runtime HANDLE targets (`u as IncomingMessage` — a boxed handle
    // coming back out of an untyped wrapper): a tag-checked reference
    // unwrap, identity preserved (DYN_HANDLE_KINDS).
    if (DYN_HANDLE_KINDS.has(target.kind)) {
      return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `a checked cast of 'unknown' to '${target.kind === "void" ? "void" : lowerer.fmt(target)}' ` +
        `(a dynamic value can only be validated against JSON-representable types: ` +
        `number, string, boolean, records, arrays, and unions of those)`,
    );
  }
  return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
}

export function lowerPrefixUnary(lowerer: Lowerer, expr: ts.PrefixUnaryExpression): IrExpr {
  const loc = locOf(expr);
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const raw = lowerer.lowerExpr(expr.operand);
      if (raw.type.kind === "jsval") {
        return { kind: "jsOp", op: "neg", args: [raw], type: JSVAL, loc };
      }
      if (raw.type.kind === "bigint") {
        return { kind: "libCall", fn: "bigint.neg", args: [raw], type: BIGINT_T, loc };
      }
      // Match the checked numeric boundary used by JS binary arithmetic.
      const operand =
        raw.type.kind === "dyn" && isJsSourceFile(expr.getSourceFile())
          ? { kind: "dynCheck" as const, value: raw, type: F64, loc }
          : lowerOptionalNumber(lowerer, raw, loc, expr.operand);
      if (operand.type.kind !== "f64") lowerer.unsupported("SC1043", expr);
      if (operand.kind === "numLit") return { ...operand, value: -operand.value, loc };
      return { kind: "unary", op: "-", operand, type: F64, loc };
    }
    case ts.SyntaxKind.PlusToken: {
      const raw = lowerer.lowerExpr(expr.operand);
      if (raw.type.kind === "dyn") {
        return { kind: "libCall", fn: "dyn.toNumberCoerce", args: [raw], type: F64, loc };
      }
      // Unary + is ToNumber; on an already-number operand it's identity,
      // and a STRING operand runs the runtime's ECMA-exact StringToNumber
      // (num.fromString — Number(aString)'s lowering, scr_string.c).
      if (raw.type.kind === "jsval") {
        return { kind: "jsOp", op: "plus", args: [raw], type: JSVAL, loc };
      }
      if (raw.type.kind === "string") {
        return { kind: "libCall", fn: "num.fromString", args: [raw], type: F64, loc };
      }
      const operand = lowerOptionalNumber(lowerer, raw, loc, expr.operand);
      if (operand.type.kind !== "f64") lowerer.unsupported("SC1043", expr);
      return operand;
    }
    case ts.SyntaxKind.ExclamationToken: {
      // `!x` is ToBoolean-then-negate: f64/string operands go through toBool.
      const operand = lowerer.ensureBool(lowerer.lowerExpr(expr.operand), expr.operand);
      return { kind: "unary", op: "!", operand, type: BOOL, loc };
    }
    case ts.SyntaxKind.TildeToken: {
      // `~x`: ToInt32, complement, back to f64 (JS-exact, incl. NaN → -1).
      const raw = lowerer.lowerExpr(expr.operand);
      if (raw.type.kind === "bigint") {
        return { kind: "libCall", fn: "bigint.not", args: [raw], type: BIGINT_T, loc };
      }
      if (raw.type.kind === "dyn")
        return {
          kind: "libCall",
          fn: "dyn.bitwise",
          args: [raw, dynUndefinedExpr(loc), { kind: "strLit", value: "~", type: STRING, loc }],
          type: DYN,
          loc,
        };
      // A checked-dynamic value retains enough JavaScript structure to
      // run exact ToNumber, including the object valueOf/toString
      // protocol. This is the static `any`/JS-lane answer for idioms
      // such as `while (~index)`, where inference may have widened an
      // otherwise numeric slot to the checked-dynamic tree.
      const operand = lowerOptionalNumber(lowerer, raw, loc, expr.operand);
      if (operand.type.kind !== "f64") lowerer.unsupported("SC1043", expr);
      return { kind: "unary", op: "~", operand, type: F64, loc };
    }
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
      // `++x` / `--x` in expression position: yields the NEW value.
      return lowerIncDec(lowerer, expr, true);
  }
  lowerer.unsupported("SC1090", expr, `syntax '${ts.syntaxKindName(expr.kind)}'`);
}

/** Member updates evaluate the reference once, convert its old value with
 * ToNumeric, store the new value, then yield the old or new numeric value. */
export function lowerIncDec(
  lowerer: Lowerer,
  expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  prefix: boolean,
): IrExpr {
  const loc = locOf(expr);
  const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
  if (!ts.isIdentifier(expr.operand)) {
    const access = expr.operand;
    if (
      (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
      access.questionDotToken
    ) {
      lowerer.unsupported("SC1045", expr, "increment/decrement of this target");
    }
    fenceNodeModuleMutation(lowerer, access, "assignment");
    if (ts.isPropertyAccessExpression(access)) {
      const target =
        staticFieldWriteTarget(lowerer, access) ??
        expandoWritableTarget(lowerer, access) ??
        nsWritableTarget(lowerer, access);
      if (target) {
        return lowerIncDecTarget(lowerer, expr, target, prefix);
      }
    }
    const stmts: IrStmt[] = [];
    const save = (value: IrExpr, name: string): IrExpr => {
      const local = lowerer.declareHiddenLocal(name, value.type);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      return varRef(local.id, value.type, loc);
    };
    const finish = (read: IrExpr, write: (value: IrExpr) => IrStmt): IrExpr => {
      const old = save(
        read.type.kind === "f64"
          ? read
          : {
              kind: "libCall",
              fn: "dyn.toNumeric",
              args: [lowerer.coerceInto(access, read, DYN)],
              type: DYN,
              loc,
            },
        "%incrementOld",
      );
      const next = save(
        old.type.kind === "f64"
          ? {
              kind: "bin",
              op,
              left: old,
              right: { kind: "numLit", value: 1, type: F64, loc },
              type: F64,
              loc,
            }
          : {
              kind: "libCall",
              fn: "dyn.increment",
              args: [old, { kind: "boolLit", value: op === "+", type: BOOL, loc }],
              type: DYN,
              loc,
            },
        "%incrementNext",
      );
      stmts.push(write(next));
      const result = prefix ? next : old;
      return { kind: "seqExpr", stmts, result, type: result.type, loc };
    };
    const raw = lowerer.lowerExpr(access.expression);
    // Keep native array/byte storage: boxing a native array can create a
    // checked view, which is not a substitute for updating its slot.
    if (
      ts.isElementAccessExpression(access) &&
      (raw.type.kind === "array" || raw.type.kind === "bytes")
    ) {
      const receiver = save(raw, "%incrementArray");
      const rawIndex = lowerer.lowerExpr(access.argumentExpression);
      const index = save(
        rawIndex.type.kind === "dyn" && isJsSourceFile(expr.getSourceFile())
          ? { kind: "libCall", fn: "dyn.toNumberCoerce", args: [rawIndex], type: F64, loc }
          : rawIndex,
        "%incrementIndex",
      );
      if (index.type.kind !== "f64")
        lowerer.unsupported("SC1090", access, "incrementing non-number array keys");
      const type = raw.type;
      const read: IrExpr =
        type.kind === "array"
          ? arrayValueRead(lowerer, receiver, index, type.elem, loc)
          : { kind: "bytesIntrinsic", method: "get", receiver, args: [index], type: F64, loc };
      return finish(read, (value) =>
        type.kind === "array"
          ? arrayValueStore(
              lowerer,
              receiver,
              index,
              lowerer.coerceInto(access, value, type.elem),
              type.elem,
              loc,
            )
          : {
              kind: "bytesSet",
              arr: receiver,
              index,
              value: lowerer.coerceInto(access, value, F64),
              loc,
            },
      );
    }
    if (isJsSourceFile(expr.getSourceFile()) && raw.type.kind === "dyn") {
      const receiver = save(raw, "%incrementReceiver");
      const key = save(
        ts.isElementAccessExpression(access)
          ? lowerer.lowerExprExpecting(access.argumentExpression, DYN)
          : lowerer.coerceInto(
              access,
              { kind: "strLit", value: access.name.text, type: STRING, loc },
              DYN,
            ),
        "%incrementKey",
      );
      return finish({ kind: "dynKeyGet", value: receiver, key, type: DYN, loc }, (value) => ({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [receiver, key, lowerer.coerceInto(access, value, DYN)],
          type: VOID,
          loc,
        },
        loc,
      }));
    }
    const target = ts.isPropertyAccessExpression(access)
      ? lowerer.fieldTarget(access)
      : symbolFieldTarget(lowerer, access);
    if (target && lowerer.dynConvertible(target.fieldType)) {
      target.obj = save(target.obj, "%incrementReceiver");
      return finish(lowerer.fieldGetExpr(target, loc, access), (value) =>
        lowerer.fieldSetStmt(
          target,
          lowerer.coerceInto(access, value, target.fieldType),
          loc,
          access,
        ),
      );
    }
    if (isJsSourceFile(expr.getSourceFile()) && lowerer.dynConvertible(raw.type)) {
      const receiver = save(lowerer.coerceInto(access.expression, raw, DYN), "%incrementReceiver");
      const key = save(
        ts.isElementAccessExpression(access)
          ? lowerer.lowerExprExpecting(access.argumentExpression, DYN)
          : lowerer.coerceInto(
              access,
              { kind: "strLit", value: access.name.text, type: STRING, loc },
              DYN,
            ),
        "%incrementKey",
      );
      return finish({ kind: "dynKeyGet", value: receiver, key, type: DYN, loc }, (value) => ({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [receiver, key, lowerer.coerceInto(access, value, DYN)],
          type: VOID,
          loc,
        },
        loc,
      }));
    }
    lowerer.unsupported("SC1045", expr, "increment/decrement of this member target");
  }
  const target = lowerer.resolveWritable(expr.operand);
  if (!target) {
    lowerer.rejectUnresolved(
      expr.operand,
      `increment/decrement of '${expr.operand.text}' (not a writable local or module global)`,
    );
  }
  return lowerIncDecTarget(lowerer, expr, target, prefix);
}

/** Numeric updates read the represented slot once and write the computed
 * value back in that same representation. In particular, an unchecked
 * indexed initializer can leave undefined in an otherwise numeric binding. */
export function lowerIncDecTarget(
  lowerer: Lowerer,
  expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  target: { id: string; type: IrType },
  prefix: boolean,
): IrExpr {
  const loc = locOf(expr);
  const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
  if (target.type.kind === "dyn") {
    const old = lowerer.declareHiddenLocal("%numericOld", DYN);
    const next = lowerer.declareHiddenLocal("%numericNext", DYN);
    const read = varRef(target.id, target.type, loc);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: old.id,
          init: { kind: "libCall", fn: "dyn.toNumeric", args: [read], type: DYN, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: next.id,
          init: {
            kind: "libCall",
            fn: "dyn.increment",
            args: [
              varRef(old.id, DYN, loc),
              { kind: "boolLit", value: op === "+", type: BOOL, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
        { kind: "assign", localId: target.id, value: varRef(next.id, DYN, loc), loc },
      ],
      result: varRef(prefix ? next.id : old.id, DYN, loc),
      type: DYN,
      loc,
    };
  }
  if (target.type.kind === "union") {
    const read = lowerOptionalNumber(
      lowerer,
      varRef(target.id, target.type, loc),
      loc,
      expr.operand,
    );
    if (read.type.kind === "f64") {
      const old = lowerer.declareHiddenLocal("%numericOld", F64);
      const next = lowerer.declareHiddenLocal("%numericNext", F64);
      const result = varRef(prefix ? next.id : old.id, F64, loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: old.id, init: read, loc },
          {
            kind: "varDecl",
            localId: next.id,
            init: {
              kind: "bin",
              op,
              left: varRef(old.id, F64, loc),
              right: numLit(1, loc),
              type: F64,
              loc,
            },
            loc,
          },
          {
            kind: "assign",
            localId: target.id,
            value: lowerer.coerceInto(expr.operand, varRef(next.id, F64, loc), target.type),
            loc,
          },
        ],
        result,
        type: F64,
        loc,
      };
    }
  }
  if (target.type.kind !== "f64") lowerer.unsupported("SC1043", expr);
  return { kind: "incDec", op, prefix, localId: target.id, type: F64, loc };
}

/** Whether a lowered statement can live inside a seqExpr. These statements
 * do not leave the expression through a jump; the native emitters can place
 * their writes and local state branches before evaluating the final result.
 * Blocks check their bodies recursively. */
function seqExprSafeStmt(s: IrStmt): boolean {
  switch (s.kind) {
    case "varDecl":
    case "assign":
    case "exprStmt":
    case "fieldSet":
    case "recordSet":
    case "recordKeySet":
    case "arraySet":
    case "arraySetLength":
    case "bytesSet":
    case "arraySetUndefined":
    case "arrayDelete":
      return true;
    case "if":
      return s.then.every(seqExprSafeStmt) && (s.else_?.every(seqExprSafeStmt) ?? true);
    case "block":
      return s.body.every(seqExprSafeStmt);
    default:
      return false;
  }
}

/** Run one supported `any` binary operation in the island. Checked-dynamic
 * operands marshal in only after lowerBinary's identity-preserving native
 * cases have had their chance (notably dyn strict equality). */
function lowerAnyBinaryInIsland(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  left: IrExpr,
  right: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const op = expr.operatorToken.kind;
  const JS_BIN: Partial<Record<ts.SyntaxKind, IrJsOp>> = {
    [ts.SyntaxKind.PlusToken]: "add",
    [ts.SyntaxKind.MinusToken]: "sub",
    [ts.SyntaxKind.AsteriskToken]: "mul",
    [ts.SyntaxKind.SlashToken]: "div",
    [ts.SyntaxKind.PercentToken]: "mod",
    [ts.SyntaxKind.AsteriskAsteriskToken]: "pow",
    [ts.SyntaxKind.LessThanToken]: "lt",
    [ts.SyntaxKind.LessThanEqualsToken]: "le",
    [ts.SyntaxKind.GreaterThanToken]: "gt",
    [ts.SyntaxKind.GreaterThanEqualsToken]: "ge",
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: "eq",
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "neq",
  };
  const jop = JS_BIN[op];
  if (jop === undefined) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `operator '${ts.tokenToString(op) ?? ts.syntaxKindName(op)}' on 'any' values`,
    );
  }
  const type = jsOpResultKind(jop) === "bool" ? BOOL : JSVAL;
  return {
    kind: "jsOp",
    op: jop,
    args: [lowerer.jsvalIn(left, expr.left), lowerer.jsvalIn(right, expr.right)],
    type,
    loc,
  };
}

export function lowerCompoundValueToTarget(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  compound: CompoundOp,
  target: { id: string; type: IrType },
): IrExpr {
  const loc = locOf(expr);
  const read: IrExpr = {
    kind: "varRef",
    localId: target.id,
    type: target.type,
    loc: locOf(expr.left),
  };
  const rhs = lowerer.lowerExpr(expr.right);
  const numericRead = lowerOptionalNumber(lowerer, read, loc);
  const numericRhs = lowerOptionalNumber(lowerer, rhs, loc);
  if (target.type.kind === "jsval" || rhs.type.kind === "jsval") {
    const JS_COMPOUND: Record<string, IrJsOp> = {
      "+": "add",
      "-": "sub",
      "*": "mul",
      "/": "div",
      "%": "mod",
      "**": "pow",
    };
    const jop = JS_COMPOUND[compound];
    if (jop === undefined) lowerer.unsupported("SC1043", expr);
    const wrapped: IrExpr = {
      kind: "jsOp",
      op: jop,
      args: [lowerer.jsvalIn(read, expr.left), lowerer.jsvalIn(rhs, expr.right)],
      type: JSVAL,
      loc,
    };
    return lowerer.coerceInto(expr, wrapped, target.type);
  }
  if (
    compound === "+" &&
    (target.type.kind === "string" ||
      (target.type.kind === "union" &&
        lowerer.stripUndefinedArm(target.type).kind === "string" &&
        rhs.type.kind === "string"))
  ) {
    return lowerer.coerceInto(
      expr,
      {
        kind: "strConcat",
        left: lowerer.ensureString(read, expr.left),
        right: lowerer.ensureString(rhs, expr.right),
        type: STRING,
        loc,
      },
      target.type,
    );
  }
  if (numericRead.type.kind === "f64" && numericRhs.type.kind === "f64") {
    return lowerer.coerceInto(
      expr,
      { kind: "bin", op: compound, left: numericRead, right: numericRhs, type: F64, loc },
      target.type,
    );
  }
  if (
    (target.type.kind === "dyn" || rhs.type.kind === "dyn") &&
    isJsSourceFile(expr.getSourceFile())
  ) {
    const left = lowerer.coerceInto(expr.left, read, DYN);
    const right = lowerer.coerceInto(expr.right, rhs, DYN);
    const numeric = ["-", "*", "/", "%", "**"].includes(compound);
    const computed: IrExpr = {
      kind: "libCall",
      fn: compound === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
      args:
        compound === "+"
          ? [left, right]
          : [left, right, { kind: "strLit", value: compound, type: STRING, loc }],
      type: DYN,
      loc,
    };
    return lowerer.coerceInto(expr, computed, target.type);
  }
  lowerer.unsupported("SC1043", expr);
}

export function lowerBinary(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr {
  const loc = locOf(expr);
  const op = expr.operatorToken.kind;

  const cacheHas = lowerRequireCacheHas(lowerer, expr);
  if (cacheHas) return cacheHas;

  if (
    op === ts.SyntaxKind.EqualsToken ||
    (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)
  ) {
    const urlWrite = lowerUrlAssignment(lowerer, expr);
    if (urlWrite) return urlWrite;
    if (op === ts.SyntaxKind.EqualsToken) {
      const prototypeWrite = lowerClassPrototypeComputedAssignment(lowerer, expr);
      if (prototypeWrite) return prototypeWrite;
      const callableWrite = lowerNativeFunctionAssignment(lowerer, expr);
      if (callableWrite) return callableWrite;
    }
    if (
      op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken
    ) {
      return lowerShortCircuitAssignment(lowerer, expr);
    }
    if (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) {
      fenceNodeModuleMutation(lowerer, expr.left, "assignment");
    }
    // `x = e` in EXPRESSION position (`while ((idx = s.indexOf("\n")) !== -1)`,
    // `f(x = v)`): evaluate e once, write the binding, yield the assigned
    // value — JS evaluation order. Variable targets only (locals and module
    // globals, captured/boxed included); the RHS coerces into the binding's
    // type exactly like statement position, and the expression's value is
    // the coerced binding-typed value (representation change only — never
    // observably different from JS's raw-RHS yield). Indexed compounds
    // use a sequenced read/modify/write; other member targets and
    // destructuring targets stay fenced.
    if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
      const target = lowerer.resolveWritable(expr.left);
      if (!target) {
        lowerer.rejectUnresolved(
          expr.left,
          `assignment to '${expr.left.text}' (not a writable local or module global)`,
        );
      }
      const value = lowerer.lowerExprExpecting(expr.right, target.type);
      const runtimeOptionalRoot = lowerer.runtimeOptionalRootOf(target);
      if (lowerer.runtimeOptionalStorageLocals.has(runtimeOptionalRoot))
        lowerer.runtimeOptionalLocals.add(runtimeOptionalRoot);
      return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
    }
    const indexedCompound = COMPOUND_ASSIGN_OPS[op];
    if (indexedCompound !== undefined && ts.isElementAccessExpression(expr.left)) {
      if (symbolFieldInfo(lowerer, expr.left))
        return lowerFieldCompoundValue(lowerer, expr.left, indexedCompound, expr.right, loc);
      return lowerElementCompound(lowerer, expr, indexedCompound);
    }
    if (indexedCompound !== undefined && ts.isIdentifier(expr.left)) {
      const target = lowerer.resolveWritable(expr.left);
      if (!target) {
        lowerer.rejectUnresolved(expr.left, "assignment to an unresolved variable");
      }
      const value = lowerCompoundValueToTarget(lowerer, expr, indexedCompound, target);
      return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
    }
    if (
      indexedCompound !== undefined &&
      (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) &&
      !(ts.isPropertyAccessExpression(expr.left) && expr.left.questionDotToken)
    ) {
      const target =
        expandoWritableTarget(lowerer, expr.left) ??
        (ts.isPropertyAccessExpression(expr.left) ? nsWritableTarget(lowerer, expr.left) : null);
      if (target) {
        const value = lowerCompoundValueToTarget(lowerer, expr, indexedCompound, target);
        return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
      }
      return lowerFieldCompoundValue(lowerer, expr.left, indexedCompound, expr.right, loc);
    }
    // `events.defaultMaxListeners = v` — the module-property write
    // Node validates (validateNumber(n, 'defaultMaxListeners', 0)):
    // the value crosses into the checked-dynamic tree and the runtime ladder throws
    // ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE with Node's exact slot
    // name; valid numbers apply. The expression's value is the RHS
    // (JS's assignment yield).
    if (
      op === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      !expr.left.questionDotToken &&
      expr.left.name.text === "defaultMaxListeners"
    ) {
      const bi = lowerer.builtinMemberOf(expr.left);
      if (bi && bi.module === "events" && bi.member === "defaultMaxListeners") {
        const rhs = lowerer.lowerExpr(expr.right);
        if (rhs.type.kind === "dyn" || rhs.kind === "unitLit" || lowerer.dynConvertible(rhs.type)) {
          const valTmp = lowerer.declareHiddenLocal("%setVal", rhs.type);
          const valRef = (): IrExpr => ({
            kind: "varRef",
            localId: valTmp.id,
            type: rhs.type,
            loc,
          });
          const dynVal: IrExpr =
            rhs.type.kind === "dyn"
              ? valRef()
              : { kind: "dynFrom", value: valRef(), type: DYN, loc };
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: valTmp.id, init: rhs, loc },
              {
                kind: "exprStmt",
                expr: {
                  kind: "libCall",
                  fn: "emitter.setDefaultMaxChk",
                  args: [
                    dynVal,
                    { kind: "strLit", value: "defaultMaxListeners", type: STRING, loc },
                  ],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ],
            result: valRef(),
            type: rhs.type,
            loc,
          };
        }
      }
    }
    // Member targets whose storage IS a module global — namespace
    // members (`N.x`) and expando function members (`Foo.baz`): the
    // same assignExpr, since the "member" is a variable.
    if (
      op === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) &&
      !(ts.isPropertyAccessExpression(expr.left) && expr.left.questionDotToken)
    ) {
      const target =
        expandoWritableTarget(lowerer, expr.left) ??
        (ts.isPropertyAccessExpression(expr.left) ? nsWritableTarget(lowerer, expr.left) : null);
      if (target) {
        const value = lowerer.lowerExprExpecting(expr.right, target.type);
        return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
      }
      // Bundled numeric enums use e[e["name"] = value] = "name".
      // Capture the receiver and key before the RHS. PutValue coerces the
      // key afterward, then yields the RHS without rereading the property.
      if (ts.isElementAccessExpression(expr.left) && !expr.left.questionDotToken) {
        const recv = tryLowerExpression(lowerer, expr.left.expression);
        if (
          recv &&
          (recv.type.kind === "dyn" ||
            (recv.type.kind === "array" &&
              isJsSourceFile(expr.getSourceFile()) &&
              lowerer.dynConvertible(recv.type)))
        ) {
          return lowerDynMemberAssignment(
            lowerer,
            expr,
            lowerer.coerceInto(expr.left.expression, recv, DYN),
          );
        }
        if (recv?.type.kind === "array" || recv?.type.kind === "bytes") {
          const receiver = lowerer.declareHiddenLocal("%setArray", recv.type);
          const index = lowerer.lowerExpr(expr.left.argumentExpression);
          if (index.type.kind !== "f64")
            lowerer.unsupported(
              "SC1090",
              expr.left.argumentExpression,
              "indexing with non-number keys",
            );
          const key = lowerer.declareHiddenLocal("%setIndex", F64);
          const raw = lowerer.lowerExpr(expr.right);
          const value = lowerer.declareHiddenLocal("%setValue", raw.type);
          const result = varRef(value.id, raw.type, loc);
          const arr = varRef(receiver.id, recv.type, loc);
          const idx = varRef(key.id, F64, loc);
          const write: IrStmt =
            recv.type.kind === "array"
              ? arrayValueStore(lowerer, arr, idx, result, recv.type.elem, loc)
              : {
                  kind: "bytesSet",
                  arr,
                  index: idx,
                  value: lowerer.coerceInto(expr.right, result, F64),
                  loc,
                };
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: receiver.id, init: recv, loc },
              { kind: "varDecl", localId: key.id, init: index, loc },
              { kind: "varDecl", localId: value.id, init: raw, loc },
              write,
            ],
            result,
            type: result.type,
            loc,
          };
        }
      }
      // `h.k = v` on an ISLAND receiver in VALUE position: the engine
      // property write (setProp throws the engine's TypeErrors on
      // nullish receivers, bridged catchably), the RHS value threaded
      // through as the expression's value.
      if (
        ts.isPropertyAccessExpression(expr.left) &&
        !expr.left.questionDotToken &&
        lowerer.isIslandExpr(expr.left.expression)
      ) {
        const recv = lowerer.lowerExpr(expr.left.expression);
        const recvTmp = lowerer.declareHiddenLocal("%setRecv", recv.type);
        const rhsVal = lowerer.lowerExpr(expr.right);
        const valTmp = lowerer.declareHiddenLocal("%setVal", rhsVal.type);
        const valRef = (): IrExpr => ({
          kind: "varRef",
          localId: valTmp.id,
          type: rhsVal.type,
          loc,
        });
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: recvTmp.id, init: recv, loc },
            { kind: "varDecl", localId: valTmp.id, init: rhsVal, loc },
            {
              kind: "exprStmt",
              expr: {
                kind: "jsOp",
                op: "setProp",
                name: expr.left.name.text,
                args: [
                  { kind: "varRef", localId: recvTmp.id, type: recv.type, loc },
                  lowerer.jsvalIn(valRef(), expr.right),
                ],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          result: valRef(),
          type: rhsVal.type,
          loc,
        };
      }
      // `h.k = v` on a CHECKED-DYNAMIC receiver in VALUE position
      // (`var _ = module.exports = foo`): receiver first, then RHS
      // (JS's reference-before-value order), the keyed write, and the
      // RHS value is the expression's value — its OWN type, so the
      // consumer sees exactly what the checker typed.
      if (ts.isPropertyAccessExpression(expr.left) && !expr.left.questionDotToken) {
        const recv = tryLowerExpression(lowerer, expr.left.expression);
        if (recv && recv.type.kind === "dyn") return lowerDynMemberAssignment(lowerer, expr, recv);
        const unionWrite = lowerUnionFieldWrite(lowerer, expr.left, expr.right);
        if (unionWrite) return unionWrite;
        const field = lowerer.fieldTarget(expr.left);
        if (field) {
          const recvTmp = lowerer.declareHiddenLocal("%setReceiver", field.obj.type);
          const receiver = field.obj;
          field.obj = varRef(recvTmp.id, receiver.type, loc);
          const value = lowerer.lowerExprExpecting(expr.right, field.fieldType);
          const valTmp = lowerer.declareHiddenLocal("%setValue", value.type);
          const result = varRef(valTmp.id, value.type, loc);
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: recvTmp.id, init: receiver, loc },
              { kind: "varDecl", localId: valTmp.id, init: value, loc },
              lowerer.fieldSetStmt(field, result, loc, expr.left),
            ],
            result,
            type: result.type,
            loc,
          };
        }
      }
    }
    // Destructuring assignment in VALUE position (`(() => [i] = [i+1])()`,
    // `({} = {x} = a)`, `var d = ([] = src)`): the statement machinery's
    // parts under a seqExpr — the expression's value is the RHS value
    // (JS's GetValue of the right reference), which is exactly the
    // parts' hidden temp.
    if (
      op === ts.SyntaxKind.EqualsToken &&
      (ts.isObjectLiteralExpression(expr.left) || ts.isArrayLiteralExpression(expr.left))
    ) {
      const parts = lowerer.lowerDestructuringAssignParts(expr.left, expr.right, loc);
      return {
        kind: "seqExpr",
        stmts: parts.stmts,
        result: parts.value,
        type: parts.value.type,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      op === ts.SyntaxKind.EqualsToken
        ? "assignment to non-variables as an expression (only `x = e` over a variable yields a value; write property/destructuring assignments as statements)"
        : "compound assignment as an expression (write `x op= e` as a statement, or spell out `x = x op e`)",
    );
  }
  if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
    const nullTest = lowerLooseNullCompare(lowerer, expr, loc);
    if (nullTest) return nullTest;
    const loose = lowerAbstractEquality(
      lowerer,
      lowerer.lowerExpr(expr.left),
      lowerer.lowerExpr(expr.right),
      op === ts.SyntaxKind.ExclamationEqualsToken,
      loc,
    );
    if (loose) return loose;
    lowerer.unsupported(
      "SC1040",
      expr,
      undefined,
      "object-to-primitive loose equality can call user-defined valueOf/toString methods — compare explicit primitive conversions instead",
    );
  }
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    return lowerLogicalChain(lowerer, expr);
  }
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return lowerer.lowerNullishCoalesce(expr, loc);
  }
  if (op === ts.SyntaxKind.CommaToken) {
    // Comma expression in VALUE position (`r = ({} = a, [] = a)` — the
    // conformance corpus's paired-destructuring idiom): the left operand
    // runs for EFFECT exactly as its statement lowering (JS discards its
    // value), the right operand is the expression's value — a seqExpr.
    // The validator restricts seqExpr statements to straight-line writes
    // (the lowering point is mid-expression), so a left operand whose
    // statement lowering needs real control flow keeps a pointed fence
    // instead of tripping the validator downstream.
    const effect = lowerer.lowerExprStatement(expr.left);
    if (!seqExprSafeStmt(effect)) {
      lowerer.unsupported(
        "SC1090",
        expr.left,
        "comma expressions whose left operand needs control flow (run it as its own statement first)",
      );
    }
    const result = lowerer.lowerExpr(expr.right);
    return { kind: "seqExpr", stmts: [effect], result, type: result.type, loc };
  }
  if (op === ts.SyntaxKind.InstanceOfKeyword) return lowerer.lowerInstanceOf(expr, loc);
  if (op === ts.SyntaxKind.InKeyword) {
    return lowerInExpression(lowerer, expr, loc);
  }
  // `typeof e === "string"` on a catch binding or an `unknown` value: a
  // runtime kind test — intercepted BEFORE the operands lower (a raw
  // read of the binding is the narrowness fence, and bare `typeof e`
  // has no lowering).
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    const test =
      lowerErrorCodeTypeofTest(lowerer, expr, loc) ??
      lowerer.lowerCaughtTypeofTest(expr, loc) ??
      lowerDynTypeofTest(lowerer, expr, loc) ??
      lowerUnionTypeofTest(lowerer, expr, loc);
    if (test) return test;
  }

  const strictEquality =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  let left = strictEquality
    ? (lowerAbsenceProbe(lowerer, expr.left) ?? lowerer.lowerExpr(expr.left))
    : lowerer.lowerExpr(expr.left);
  let right = strictEquality
    ? (lowerAbsenceProbe(lowerer, expr.right) ?? lowerer.lowerExpr(expr.right))
    : lowerer.lowerExpr(expr.right);
  if (strictEquality && (left.type.kind === "caught" || right.type.kind === "caught")) {
    if (left.type.kind === "caught")
      left = { kind: "caughtToDyn", value: left, type: DYN, loc: left.loc };
    if (right.type.kind === "caught")
      right = { kind: "caughtToDyn", value: right, type: DYN, loc: right.loc };
  }
  if (left.type.kind === "dyn" || right.type.kind === "dyn") {
    // The narrowing unit comparisons ARE answerable on unknown: `v ===
    // undefined` / `v !== null` test the dyn node's kind directly, and
    // tsc's control flow narrows the branches (reads then bridge through
    // maybeNarrow's validated extraction).
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const unit = left.kind === "unitLit" ? left : right.kind === "unitLit" ? right : null;
      const other = left.kind === "unitLit" ? right : left;
      if (unit && other.type.kind === "dyn") {
        return {
          kind: "dynTest",
          test: unit.unit,
          ...(negated ? { negated: true as const } : {}),
          value: other,
          type: BOOL,
          loc,
        };
      }
      // dyn vs SCALAR strict equality (`value !== ""`, `u === 5` — the
      // normalizePricing filter): a guarded kind test + payload compare,
      // JS-exact (strict equality never coerces; a non-matching dyn kind
      // answers false). dyn vs dyn keeps the fence below.
      const dynSide = left.type.kind === "dyn" ? left : right;
      const scalarSide = dynSide === left ? right : left;
      const reference = scalarSide.type;
      if (
        (reference.kind === "object" ||
          reference.kind === "record" ||
          reference.kind === "array" ||
          reference.kind === "bytes" ||
          reference.kind === "func" ||
          reference.kind === "classval" ||
          reference.kind === "regex" ||
          reference.kind === "url" ||
          reference.kind === "bigint" ||
          reference.kind === "symbol" ||
          reference.kind === "map" ||
          reference.kind === "set" ||
          reference.kind === "union" ||
          DYN_HANDLE_KINDS.has(reference.kind)) &&
        lowerer.dynConvertible(reference)
      ) {
        const boxed: IrExpr = {
          kind: "dynFrom",
          value: scalarSide,
          type: DYN,
          loc: scalarSide.loc,
          ...(reference.kind === "record" ||
          reference.kind === "array" ||
          reference.kind === "bytes"
            ? { liveRef: true as const }
            : {}),
        };
        return {
          kind: "dynScalarEq",
          left: scalarSide === left ? boxed : left,
          right: scalarSide === right ? boxed : right,
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
      if (
        dynSide.type.kind === "dyn" &&
        (scalarSide.type.kind === "f64" ||
          scalarSide.type.kind === "string" ||
          scalarSide.type.kind === "bool" ||
          // dyn vs dyn (`context.actual !== context.exact` —
          // test/common's exit accounting): the runtime's whole-dyn
          // strict equality — scalars by value, units by kind,
          // reference kinds by identity (scr_dyn_strict_eq).
          scalarSide.type.kind === "dyn")
      ) {
        return {
          kind: "dynScalarEq",
          left,
          right,
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
    }
    const bitwise: Partial<Record<ts.SyntaxKind, string>> = {
      [ts.SyntaxKind.AmpersandToken]: "&",
      [ts.SyntaxKind.BarToken]: "|",
      [ts.SyntaxKind.CaretToken]: "^",
      [ts.SyntaxKind.LessThanLessThanToken]: "<<",
      [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>",
      [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: ">>>",
    };
    if (bitwise[op]) {
      const l = lowerer.coerceToExpected(left, DYN);
      const r = lowerer.coerceToExpected(right, DYN);
      if (l.type.kind === "dyn" && r.type.kind === "dyn") {
        const value: IrExpr = {
          kind: "libCall",
          fn: "dyn.bitwise",
          args: [l, r, { kind: "strLit", value: bitwise[op]!, type: STRING, loc }],
          type: DYN,
          loc,
        };
        return left.type.kind === "f64" || right.type.kind === "f64"
          ? { kind: "dynCheck", value, type: F64, loc }
          : value;
      }
    }
    // Numeric operators dispatch on ToNumeric's actual Number/BigInt
    // result, including values flowing through native callable properties.
    if (
      isJsSourceFile(expr.getSourceFile()) ||
      op === ts.SyntaxKind.PlusToken ||
      [
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
      ].includes(op) ||
      [
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
      ].includes(op)
    ) {
      const other = left.type.kind === "dyn" ? right : left;
      const NUM_BIN: Partial<Record<ts.SyntaxKind, "-" | "*" | "/" | "%" | "**">> = {
        [ts.SyntaxKind.MinusToken]: "-",
        [ts.SyntaxKind.AsteriskToken]: "*",
        [ts.SyntaxKind.SlashToken]: "/",
        [ts.SyntaxKind.PercentToken]: "%",
        [ts.SyntaxKind.AsteriskAsteriskToken]: "**",
      };
      const NUM_CMP: Partial<Record<ts.SyntaxKind, "<" | "<=" | ">" | ">=">> = {
        [ts.SyntaxKind.LessThanToken]: "<",
        [ts.SyntaxKind.LessThanEqualsToken]: "<=",
        [ts.SyntaxKind.GreaterThanToken]: ">",
        [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
      };
      const arith = NUM_BIN[op];
      const cmp = NUM_CMP[op];
      if (arith) {
        const l = lowerer.coerceToExpected(left, DYN);
        const r = lowerer.coerceToExpected(right, DYN);
        if (l.type.kind === "dyn" && r.type.kind === "dyn") {
          const value: IrExpr = {
            kind: "libCall",
            fn: "dyn.arithmetic",
            args: [l, r, { kind: "strLit", value: arith, type: STRING, loc }],
            type: DYN,
            loc,
          };
          const numeric =
            left.type.kind === "bigint" || right.type.kind === "bigint"
              ? BIGINT_T
              : left.type.kind === "f64" || right.type.kind === "f64"
                ? F64
                : null;
          return numeric ? { kind: "dynCheck", value, type: numeric, loc } : value;
        }
      }
      if (cmp && lowerer.dynConvertible(left.type) && lowerer.dynConvertible(right.type)) {
        return {
          kind: "libCall",
          fn: "dyn.compare",
          args: [
            lowerer.coerceToExpected(left, DYN),
            lowerer.coerceToExpected(right, DYN),
            { kind: "strLit", value: cmp, type: STRING, loc },
          ],
          type: BOOL,
          loc,
        };
      }
      // Untyped addition chooses concatenation or numeric addition only
      // after both operands have undergone ToPrimitive at runtime.
      if (op === ts.SyntaxKind.PlusToken) {
        const l = lowerer.coerceToExpected(left, DYN);
        const r = lowerer.coerceToExpected(right, DYN);
        if (l.type.kind === "dyn" && r.type.kind === "dyn") {
          const value: IrExpr = { kind: "libCall", fn: "dyn.add", args: [l, r], type: DYN, loc };
          // A statically known string operand guarantees a string result.
          return other.type.kind === "string"
            ? { kind: "dynCheck", value, type: STRING, loc }
            : value;
        }
      }
    }
    // `any`-origin operands (tsc rejects these operator forms on real
    // `unknown`, so in a checker-clean TS program only `any` reaches
    // here): JS's full coercion semantics (ToPrimitive, NaN, string +)
    // live in the engine — the dynamic-family fence, so the island
    // retry lifts the site. Genuine unknown keeps the SC1100 story.
    if (
      (left.type.kind === "dyn" && lowerer.anyOrigin(expr.left)) ||
      (right.type.kind === "dyn" && lowerer.anyOrigin(expr.right))
    ) {
      // `JSON.parse` and other checked-dynamic producers deliberately
      // remain dyn when assigned to an `any` local: eagerly converting
      // the binding would deep-copy its data and sever aliases. At an
      // operator the dynamic build can cross only the operands and let
      // the engine apply JS's exact coercion semantics. Static builds
      // retain the SC2011 promise that --dynamic lifts this site.
      if (lowerer.dynamic) return lowerAnyBinaryInIsland(lowerer, expr, left, right, loc);
      lowerer.anyOpFence(`the '${ts.tokenToString(op) ?? ts.syntaxKindName(op)}' operator`, expr);
    }
    // tsc allows ===/!== on unknown (arithmetic/comparisons it rejects
    // itself); a dynamic equality would need a dyn walk — validate first.
    lowerer.unsupported("SC1100", expr, "operators on 'unknown' values");
  }
  // Operators over 'any' execute in the island with JS-exact semantics
  // (ToPrimitive, NaN, string +): both operands marshal in, the engine
  // computes. Comparisons come back as static bools; arithmetic stays
  // an island value ('1 as any + "x"' is a string over there).
  if (left.type.kind === "jsval" || right.type.kind === "jsval") {
    return lowerAnyBinaryInIsland(lowerer, expr, left, right, loc);
  }
  if (left.type.kind === "bigint" && right.type.kind === "bigint") {
    const binary: Partial<
      Record<
        ts.SyntaxKind,
        | "bigint.add"
        | "bigint.sub"
        | "bigint.mul"
        | "bigint.div"
        | "bigint.mod"
        | "bigint.pow"
        | "bigint.and"
        | "bigint.or"
        | "bigint.xor"
        | "bigint.shl"
        | "bigint.shr"
      >
    > = {
      [ts.SyntaxKind.PlusToken]: "bigint.add",
      [ts.SyntaxKind.MinusToken]: "bigint.sub",
      [ts.SyntaxKind.AsteriskToken]: "bigint.mul",
      [ts.SyntaxKind.SlashToken]: "bigint.div",
      [ts.SyntaxKind.PercentToken]: "bigint.mod",
      [ts.SyntaxKind.AsteriskAsteriskToken]: "bigint.pow",
      [ts.SyntaxKind.AmpersandToken]: "bigint.and",
      [ts.SyntaxKind.BarToken]: "bigint.or",
      [ts.SyntaxKind.CaretToken]: "bigint.xor",
      [ts.SyntaxKind.LessThanLessThanToken]: "bigint.shl",
      [ts.SyntaxKind.GreaterThanGreaterThanToken]: "bigint.shr",
    };
    const fn = binary[op];
    if (fn) return { kind: "libCall", fn, args: [left, right], type: BIGINT_T, loc };
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const equal: IrExpr = {
        kind: "libCall",
        fn: "bigint.eq",
        args: [left, right],
        type: BOOL,
        loc,
      };
      return op === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ? { kind: "unary", op: "!", operand: equal, type: BOOL, loc }
        : equal;
    }
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken
    ) {
      const cmp: IrExpr = {
        kind: "libCall",
        fn: "bigint.cmp",
        args: [left, right],
        type: F64,
        loc,
      };
      const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
      const cmpOp =
        op === ts.SyntaxKind.LessThanToken
          ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "<="
            : op === ts.SyntaxKind.GreaterThanToken
              ? ">"
              : ">=";
      return { kind: "bin", op: cmpOp, left: cmp, right: zero, type: BOOL, loc };
    }
  }
  if (
    (left.type.kind === "bigint" && right.type.kind === "f64") ||
    (left.type.kind === "f64" && right.type.kind === "bigint")
  ) {
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken
    ) {
      const big = left.type.kind === "bigint" ? left : right;
      const num = left.type.kind === "f64" ? left : right;
      const cmp: IrExpr = {
        kind: "libCall",
        fn: "bigint.cmpNumber",
        args: [big, num],
        type: F64,
        loc,
      };
      const cmpLocal = lowerer.declareHiddenLocal("%bigcmp", F64);
      const cmpRef: IrExpr = { kind: "varRef", localId: cmpLocal.id, type: F64, loc };
      const unordered: IrExpr = {
        kind: "bin",
        op: "===",
        left: cmpRef,
        right: { kind: "numLit", value: 2, type: F64, loc },
        type: BOOL,
        loc,
      };
      const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
      const leftBig = left.type.kind === "bigint";
      const cmpOp = leftBig
        ? op === ts.SyntaxKind.LessThanToken
          ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "<="
            : op === ts.SyntaxKind.GreaterThanToken
              ? ">"
              : ">="
        : op === ts.SyntaxKind.LessThanToken
          ? ">"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? ">="
            : op === ts.SyntaxKind.GreaterThanToken
              ? "<"
              : "<=";
      const result: IrExpr = {
        kind: "logical",
        op: "&&",
        left: { kind: "unary", op: "!", operand: unordered, type: BOOL, loc },
        right: { kind: "bin", op: cmpOp, left: cmpRef, right: zero, type: BOOL, loc },
        type: BOOL,
        loc,
      };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: cmpLocal.id, init: cmp, loc }],
        result,
        type: BOOL,
        loc,
      };
    }
  }
  // An unchecked array read keeps its undefined arm in the IR even when
  // the checker typed the binding as `string`. An optional string is not
  // itself a string operand for `+`: `undefined + 1` and
  // `undefined + undefined` are NaN, while a present string concatenates.
  // Keep this predicate exact so a nullable string does not silently take
  // the string path either.
  const optionalStringType = (type: IrType): boolean => {
    if (type.kind !== "union") return false;
    const arms = lowerer.unions.get(type.unionId)?.arms;
    return (
      !!arms &&
      arms.length === 2 &&
      arms.some((arm) => arm.kind === "string") &&
      arms.some((arm) => arm.kind === "undefinedT")
    );
  };
  const arithmeticNumber = (operand: IrExpr, node: ts.Expression): IrExpr =>
    lowerOptionalNumber(lowerer, operand, loc, node);
  const arithmeticLeft = strictEquality ? left : arithmeticNumber(left, expr.left);
  const arithmeticRight = strictEquality ? right : arithmeticNumber(right, expr.right);
  const plainBothNum = left.type.kind === "f64" && right.type.kind === "f64";
  const bothNum = arithmeticLeft.type.kind === "f64" && arithmeticRight.type.kind === "f64";
  const bothStr = left.type.kind === "string" && right.type.kind === "string";

  const lowerOptionalStringPlus = (): IrExpr | null => {
    const leftOptional = optionalStringType(left.type);
    const rightOptional = optionalStringType(right.type);
    if (!leftOptional && !rightOptional) return null;
    const allowed = (type: IrType): boolean =>
      type.kind === "f64" || type.kind === "string" || optionalStringType(type);
    if (!allowed(left.type) || !allowed(right.type)) return null;

    // The tag tests and the chosen concatenation branch must see the same
    // operand values. This matters for `take()[0] + 1` and for two reads
    // with observable getters/calls.
    const prefix: IrStmt[] = [];
    const stable = (operand: IrExpr): IrExpr => {
      if (isSafeToRepeat(operand) || isSafeToDiscard(operand)) return operand;
      const tmp = lowerer.declareHiddenLocal("%plus", operand.type);
      prefix.push({ kind: "varDecl", localId: tmp.id, init: operand, loc });
      return varRef(tmp.id, operand.type, loc);
    };
    const stableLeft = stable(left);
    const stableRight = stable(right);
    const leftString = lowerer.ensureString(stableLeft, expr.left);
    const rightString = lowerer.ensureString(stableRight, expr.right);
    const concat: IrExpr = {
      kind: "strConcat",
      left: leftString,
      right: rightString,
      type: STRING,
      loc,
    };
    const nan: IrExpr = {
      kind: "bin",
      op: "/",
      left: numLit(0, loc),
      right: numLit(0, loc),
      type: F64,
      loc,
    };
    const resultT: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, STRING]) };
    lowerer.runtimeOptionalArithmeticTypes.set(expr, resultT);
    const numberTag = lowerer.armTag(resultT.unionId, F64);
    const stringTag = lowerer.armTag(resultT.unionId, STRING);
    if (numberTag < 0 || stringTag < 0)
      throw new InternalCompilerError("lowerer bug: optional string plus result union");
    const number = (): IrExpr => ({
      kind: "unionWrap",
      unionId: resultT.unionId,
      tag: numberTag,
      value: nan,
      type: resultT,
      loc,
    });
    const string = (): IrExpr => ({
      kind: "unionWrap",
      unionId: resultT.unionId,
      tag: stringTag,
      value: concat,
      type: resultT,
      loc,
    });
    const undefinedTest = (operand: IrExpr): IrExpr => ({
      kind: "unionIsTag",
      unionId: operand.type.kind === "union" ? operand.type.unionId : "",
      tag: operand.type.kind === "union" ? lowerer.armTag(operand.type.unionId, UNDEFINED_T) : -1,
      negated: false,
      value: operand,
      type: BOOL,
      loc,
    });
    let result: IrExpr;
    if (leftOptional && rightOptional) {
      const rightMissing = undefinedTest(stableRight);
      const bothMissing: IrExpr = {
        kind: "ternary",
        cond: rightMissing,
        then: number(),
        else_: string(),
        type: resultT,
        loc,
      };
      result = {
        kind: "ternary",
        cond: undefinedTest(stableLeft),
        then: bothMissing,
        else_: string(),
        type: resultT,
        loc,
      };
    } else if (leftOptional) {
      result = {
        kind: "ternary",
        cond: undefinedTest(stableLeft),
        then: number(),
        else_: string(),
        type: resultT,
        loc,
      };
    } else {
      result = {
        kind: "ternary",
        cond: undefinedTest(stableRight),
        then: number(),
        else_: string(),
        type: resultT,
        loc,
      };
    }
    return prefix.length === 0
      ? result
      : { kind: "seqExpr", stmts: prefix, result, type: resultT, loc };
  };

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      if (bothNum)
        return {
          kind: "bin",
          op: "+",
          left: arithmeticLeft,
          right: arithmeticRight,
          type: F64,
          loc,
        };
      if (left.type.kind === "string" || right.type.kind === "string") {
        return {
          kind: "strConcat",
          left: lowerer.ensureString(left, expr.left),
          right: lowerer.ensureString(right, expr.right),
          type: STRING,
          loc,
        };
      }
      const optionalStringPlus = lowerOptionalStringPlus();
      if (optionalStringPlus) return optionalStringPlus;
      {
        const primitive = (type: IrType): boolean =>
          type.kind === "f64" ||
          type.kind === "string" ||
          type.kind === "bool" ||
          isUnitType(type) ||
          (type.kind === "union" &&
            (lowerer.unions.get(type.unionId)?.arms.every(primitive) ?? false));
        if (
          (left.type.kind === "union" || right.type.kind === "union") &&
          primitive(left.type) &&
          primitive(right.type)
        ) {
          lowerer.runtimeOptionalArithmeticTypes.set(expr, DYN);
          return {
            kind: "libCall",
            fn: "dyn.add",
            args: [lowerer.coerceToExpected(left, DYN), lowerer.coerceToExpected(right, DYN)],
            type: DYN,
            loc,
          };
        }
      }
      lowerer.unsupported("SC1043", expr);
      break;
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      if (!bothNum) lowerer.unsupported("SC1043", expr);
      const binOp =
        op === ts.SyntaxKind.MinusToken
          ? "-"
          : op === ts.SyntaxKind.AsteriskToken
            ? "*"
            : op === ts.SyntaxKind.SlashToken
              ? "/"
              : op === ts.SyntaxKind.PercentToken
                ? "%"
                : "**";
      return {
        kind: "bin",
        op: binOp,
        left: arithmeticLeft,
        right: arithmeticRight,
        type: F64,
        loc,
      };
    }
    // The bitwise six, JS-exact: operands through ToInt32/ToUint32
    // (NaN/±Infinity → 0, truncate, wrap mod 2^32), the operation in
    // 32-bit space (shift counts masked to 5 bits), the result back to
    // f64 — `>>>` as Uint32, the rest as Int32 (runtime scr_bit_*).
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: {
      if (!bothNum) lowerer.unsupported("SC1043", expr);
      const bitOp =
        op === ts.SyntaxKind.AmpersandToken
          ? "&"
          : op === ts.SyntaxKind.BarToken
            ? "|"
            : op === ts.SyntaxKind.CaretToken
              ? "^"
              : op === ts.SyntaxKind.LessThanLessThanToken
                ? "<<"
                : op === ts.SyntaxKind.GreaterThanGreaterThanToken
                  ? ">>"
                  : ">>>";
      return {
        kind: "bin",
        op: bitOp,
        left: arithmeticLeft,
        right: arithmeticRight,
        type: F64,
        loc,
      };
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: {
      const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const indexed = tryLowerIndexedComparison(lowerer, left, right, negated, loc);
      if (indexed) return indexed;
      if (plainBothNum)
        return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
      if (bothStr) {
        if (left.kind === "strLit" && right.kind === "strLit")
          return {
            kind: "boolLit",
            value: (left.value === right.value) !== negated,
            type: BOOL,
            loc,
          };
        return { kind: "strEq", negated, left, right, type: BOOL, loc };
      }
      // bool === bool: a plain value compare (the config-drift checks'
      // `desired.lanMode !== actual.lanMode` shape).
      if (left.type.kind === "bool" && right.type.kind === "bool") {
        return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
      }
      const unitTest = lowerer.lowerUnitComparison(left, right, negated, loc);
      if (unitTest) return unitTest;
      if (left.type.kind === "union" || right.type.kind === "union") {
        // JS strict equality of the ARM values, per union tag (a
        // per-union helper): equal tags compare payloads (f64 ==, string
        // bytes, bool ==, ref-arm POINTER identity), different tags are
        // never equal. Two shapes lower: same union on both sides, and
        // union vs plain arm value (`u === "text"` where the checker
        // didn't narrow) — the plain side wraps into the union, which
        // preserves payload identity. Different unions (tsc admits
        // partially-overlapping ones) still need narrowing first.
        const ut =
          left.type.kind === "union" ? left.type : (right.type as IrType & { kind: "union" });
        const bothUnion = left.type.kind === "union" && right.type.kind === "union";
        const sameUnion = bothUnion && typeEquals(left.type, right.type);
        const plainFunc =
          left.type.kind === "func" ? left : right.type.kind === "func" ? right : null;
        const unionArms = lowerer.unions.get(ut.unionId)?.arms ?? [];
        const funcArm = unionArms.find((arm) => arm.kind === "func");
        // `listeners()` reports original prefix callbacks, but the
        // checker views an indexed result as function | undefined. For
        // identity comparison, retain the original closure pointer rather
        // than adapting it to the tuple signature.
        if (
          !bothUnion &&
          plainFunc !== null &&
          funcArm?.kind === "func" &&
          unionArms.filter((arm) => arm.kind === "func").length === 1 &&
          unionArms.some(isUnitType)
        ) {
          return {
            kind: "unionFuncEq",
            unionId: ut.unionId,
            tag: lowerer.armTag(ut.unionId, funcArm),
            union: left.type.kind === "union" ? left : right,
            func: plainFunc,
            negated,
            type: BOOL,
            loc,
          };
        }
        if ((sameUnion || !bothUnion) && lowerer.eqComparableUnion(ut.unionId)) {
          return {
            kind: "unionEq",
            unionId: ut.unionId,
            negated,
            sameValue: false,
            left: lowerer.coerceInto(expr.left, left, ut),
            right: lowerer.coerceInto(expr.right, right, ut),
            type: BOOL,
            loc,
          };
        }
        if (left.type.kind === "union" && right.type.kind === "union") {
          const leftDef = lowerer.unions.get(left.type.unionId);
          const rightDef = lowerer.unions.get(right.type.unionId);
          if (leftDef && rightDef) {
            const leftValues = leftDef.arms.filter((arm) => !isUnitType(arm));
            const rightValues = rightDef.arms.filter((arm) => !isUnitType(arm));
            const sameValueArms =
              leftValues.length === rightValues.length &&
              leftValues.every((arm) =>
                rightValues.some((candidate) => typeEquals(candidate, arm)),
              );
            if (sameValueArms) {
              const arms = [...leftDef.arms];
              for (const arm of rightDef.arms) {
                if (!arms.some((candidate) => typeEquals(candidate, arm))) arms.push(arm);
              }
              arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
              const common: IrType & { kind: "union" } = {
                kind: "union",
                unionId: lowerer.unions.intern(arms),
              };
              return {
                kind: "unionEq",
                unionId: common.unionId,
                negated,
                sameValue: false,
                left: lowerer.coerceInto(expr.left, left, common),
                right: lowerer.coerceInto(expr.right, right, common),
                type: BOOL,
                loc,
              };
            }
          }
        }
        lowerer.unsupported("SC1090", expr, `comparisons of union-typed values (${NARROW_FIRST})`);
      }
      // Arrays, maps, functions, class instances and records compare by
      // reference identity (pointer compare) — JS-exact object equality.
      // Hierarchy-related classes compare after widening the derived side
      // (same pointer either way — prefix layout).
      let idLeft = left;
      let idRight = right;
      if (left.type.kind === "object" && right.type.kind === "object") {
        if (lowerer.isSubclassOf(left.type.className, right.type.className)) {
          idLeft = lowerer.upcastTo(left, right.type.className);
        } else if (lowerer.isSubclassOf(right.type.className, left.type.className)) {
          idRight = lowerer.upcastTo(right, left.type.className);
        }
      }
      // Two function values compare by identity whatever their STATIC
      // signatures (tsc admits the comparison when one side is
      // assignable to the other — a tuple-typed listeners() element
      // against a prefix-declared handler): the pointer answers it.
      if (idLeft.type.kind === "func" && idRight.type.kind === "func") {
        return {
          kind: "bin",
          op: negated ? "!==" : "===",
          left: idLeft,
          right: idRight,
          type: BOOL,
          loc,
        };
      }
      // Two CLASS values compare by identity whatever their static
      // classes — one immortal object per class, one pointer compare
      // (the function-identity rule verbatim; `X === D` through a
      // base-typed slot answers exactly JS).
      if (idLeft.type.kind === "classval" && idRight.type.kind === "classval") {
        return {
          kind: "bin",
          op: negated ? "!==" : "===",
          left: idLeft,
          right: idRight,
          type: BOOL,
          loc,
        };
      }
      if (idLeft.type.kind === "moduleNs" && idRight.type.kind === "moduleNs") {
        return {
          kind: "bin",
          op: negated ? "!==" : "===",
          left: idLeft,
          right: idRight,
          type: BOOL,
          loc,
        };
      }
      if (
        (idLeft.type.kind === "array" ||
          idLeft.type.kind === "map" ||
          idLeft.type.kind === "set" ||
          idLeft.type.kind === "regex" ||
          idLeft.type.kind === "url" ||
          idLeft.type.kind === "object" ||
          idLeft.type.kind === "record" ||
          // Symbols ARE identity: `Symbol('a') === Symbol('a')` is false,
          // a symbol equals exactly itself, and Symbol.for's interned
          // values compare equal across call sites — all one pointer
          // compare, JS's spec without approximation.
          idLeft.type.kind === "symbol" ||
          // Typed arrays / Buffers ARE objects to ===: pointer identity
          // (buf === buf.swap16() — the in-place mutators return this).
          idLeft.type.kind === "bytes" ||
          idLeft.type.kind === "promise") &&
        typeEquals(idLeft.type, idRight.type)
      ) {
        return {
          kind: "bin",
          op: negated ? "!==" : "===",
          left: idLeft,
          right: idRight,
          type: BOOL,
          loc,
        };
      }
      // Runtime HANDLES are objects to === too: one handle per socket/
      // request/response, so pointer identity IS JS's object equality
      // (`c.pause() === c` — Node's chaining assertions). */
      if (DYN_HANDLE_KINDS.has(idLeft.type.kind) && typeEquals(idLeft.type, idRight.type)) {
        return {
          kind: "bin",
          op: negated ? "!==" : "===",
          left: idLeft,
          right: idRight,
          type: BOOL,
          loc,
        };
      }
      if (lowerer.dynConvertible(idLeft.type) && lowerer.dynConvertible(idRight.type)) {
        return {
          kind: "dynScalarEq",
          left: lowerer.coerceToExpected(idLeft, DYN),
          right: lowerer.coerceToExpected(idRight, DYN),
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
      lowerer.unsupported("SC1043", expr);
      break;
    }
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken: {
      const cmpOp =
        op === ts.SyntaxKind.LessThanToken
          ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "<="
            : op === ts.SyntaxKind.GreaterThanToken
              ? ">"
              : ">=";
      if (bothNum)
        return {
          kind: "bin",
          op: cmpOp,
          left: arithmeticLeft,
          right: arithmeticRight,
          type: BOOL,
          loc,
        };
      if (bothStr) return { kind: "strCmp", op: cmpOp, left, right, type: BOOL, loc };
      if (lowerer.dynConvertible(left.type) && lowerer.dynConvertible(right.type)) {
        return {
          kind: "libCall",
          fn: "dyn.compare",
          args: [
            lowerer.coerceToExpected(left, DYN),
            lowerer.coerceToExpected(right, DYN),
            { kind: "strLit", value: cmpOp, type: STRING, loc },
          ],
          type: BOOL,
          loc,
        };
      }
      lowerer.unsupported("SC1043", expr);
      break;
    }
    default:
      break;
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    `operator '${ts.tokenToString(op) ?? ts.syntaxKindName(op)}'`,
  );
}

function lowerLogicalChain(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr {
  // Logical chains have a left-nested AST. Keep the native stack bounded
  // while retaining each pair's checker type and lazy operand evaluation.
  const parents: ts.BinaryExpression[] = [];
  let current = expr;
  let result: IrExpr;
  while (true) {
    if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const fallback = lowerAbsenceAwareOrChain(lowerer, current);
      if (fallback !== null) {
        result = fallback;
        break;
      }
    }
    const left = current.left;
    if (
      ts.isBinaryExpression(left) &&
      (left.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        left.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      !lowerer.chainRecvByNode.has(left)
    ) {
      parents.push(current);
      current = left;
      continue;
    }
    result = lowerLogicalPair(
      lowerer,
      current,
      lowerAbsenceProbe(lowerer, left) ?? lowerer.lowerExpr(left),
    );
    break;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    result = lowerLogicalPair(lowerer, parents[i]!, result);
  }
  return result;
}

function lowerLogicalPair(lowerer: Lowerer, expr: ts.BinaryExpression, left: IrExpr): IrExpr {
  const op = expr.operatorToken.kind;
  const loc = locOf(expr);
  // Preserve short-circuiting during lowering too: an unreachable member
  // on a specialized value must not poison the surrounding JS statement.
  if (left.kind === "boolLit") {
    const takeRight = op === ts.SyntaxKind.AmpersandAmpersandToken ? left.value : !left.value;
    return takeRight ? lowerer.lowerExpr(expr.right) : left;
  }
  if (left.kind === "unitLit" && op === ts.SyntaxKind.AmpersandAmpersandToken) return left;
  if (op === ts.SyntaxKind.BarBarToken && REF_TRUTHY_KINDS.has(left.type.kind)) return left;
  const right = lowerer.lowerExpr(expr.right);
  // A LITERAL-unit left operand (a compile-time undefined/null — the
  // capability-probe members: `process.features.inspector ||
  // !flag.startsWith('--inspect')` reads undefined in a compiled
  // binary): statically falsy, so the operator folds JS-exactly —
  // `unit || X` IS X, `unit && X` IS the unit (X's side effects never
  // run in JS either; the lowered right is simply dropped). Literal
  // units only — computed unit-typed values keep the fences below.
  if (left.kind === "unitLit") {
    return op === ts.SyntaxKind.BarBarToken ? right : left;
  }
  // JS objects and symbols are always truthy. In `ref || fallback`
  // the fallback is therefore unreachable and the result is the
  // already-evaluated left value — the browser-fallback idiom used by
  // packages for `process.argv || []` and `process.env || {}`. The
  // operand itself remains in the IR, preserving reads/calls that
  // produce the reference; only the unreachable right lowering drops.
  if (op === ts.SyntaxKind.BarBarToken && REF_TRUTHY_KINDS.has(left.type.kind)) {
    return left;
  }
  if (left.type.kind === "dyn" || right.type.kind === "dyn") {
    // A checked-dynamic operand (`fn.name || '<anonymous>'` —
    // test/common's _mustCallInner): both sides live in the checked-dynamic tree and
    // the deciding test is ToBoolean over the dyn kind
    // (scr_dyn_truthy) — JS value semantics exactly, result dyn. The
    // non-dyn side converts through the usual boundary; a value with
    // no dyn representation keeps the fence.
    const l = lowerer.coerceToExpected(left, DYN);
    const r = lowerer.coerceToExpected(right, DYN);
    if (l.type.kind !== "dyn" || r.type.kind !== "dyn") {
      lowerer.unsupported("SC1100", expr, "logical operators on 'unknown' values");
    }
    return {
      kind: "logical",
      op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
      left: l,
      right: r,
      type: DYN,
      loc,
    };
  }
  if (left.type.kind === "jsval" || right.type.kind === "jsval") {
    return {
      kind: "logical",
      op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
      left: lowerer.jsvalIn(left, expr.left),
      right: lowerer.jsvalIn(right, expr.right),
      type: JSVAL,
      loc,
    };
  }
  if (
    isJsSourceFile(expr.getSourceFile()) &&
    op === ts.SyntaxKind.AmpersandAmpersandToken &&
    left.type.kind === "union" &&
    lowerer.unions.get(left.type.unionId)?.arms.some((arm) => arm.kind === "bool") &&
    !typeEquals(left.type, right.type) &&
    lowerer.dynConvertible(left.type) &&
    lowerer.dynConvertible(right.type)
  ) {
    return {
      kind: "logical",
      op: "&&",
      left: lowerer.coerceToExpected(left, DYN),
      right: lowerer.coerceToExpected(right, DYN),
      type: DYN,
      loc,
    };
  }
  if (left.type.kind === "union" || right.type.kind === "union") {
    // Test the deciding operand in its own representation. The result
    // contains only the values that can survive short-circuit evaluation.
    let target = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // Index reads can be absent without noUncheckedIndexedAccess. Their
    // explicit nullish fallback still runs, even if the checker discarded it.
    if (target !== null) {
      const returned = [
        right.type,
        ...(op === ts.SyntaxKind.AmpersandAmpersandToken ? [left.type] : []),
      ];
      for (const type of returned) {
        const arms =
          type.kind === "union" ? (lowerer.unions.get(type.unionId)?.arms ?? []) : [type];
        for (const arm of arms) {
          if (arm.kind === "undefinedT" && !isUnitType(target))
            target = lowerer.runtimeOptionalType(target);
          if (arm.kind === "nullT")
            target = withUnitArm(target, arm.kind, lowerer.unions) ?? target;
        }
      }
    }
    // A broad-JSDoc npm-static body can leave the CHECKER result `any`
    // even after declaration-backed specialization has recovered both
    // operands (`helpOption && args.find(...)` in commander). When the
    // left consists only of always-truthy references and falsy units,
    // the static result is exactly the right operand plus those units.
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken &&
      target === null &&
      lowerer.implicitParamTypes !== null &&
      npmStaticPackageOfPath(expr.getSourceFile().fileName) !== null &&
      (lowerer.typeOf(expr).flags & ts.TypeFlags.Any) !== 0 &&
      left.type.kind === "union"
    ) {
      const leftArms = lowerer.unions.get(left.type.unionId)?.arms;
      const rightArms =
        right.type.kind === "union" ? lowerer.unions.get(right.type.unionId)?.arms : [right.type];
      const rightIsStatic =
        rightArms?.every(
          (arm) =>
            arm.kind !== "dyn" &&
            arm.kind !== "caught" &&
            arm.kind !== "jsval" &&
            arm.kind !== "void",
        ) ?? false;
      if (
        leftArms &&
        rightArms &&
        rightIsStatic &&
        leftArms.some(isUnitType) &&
        leftArms.every((arm) => isUnitType(arm) || REF_TRUTHY_KINDS.has(arm.kind))
      ) {
        const byKey = new Map<string, IrType>();
        for (const arm of [...rightArms, ...leftArms.filter(isUnitType)]) {
          byKey.set(typeKey(arm), arm);
        }
        const arms = [...byKey.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
        if (arms.length > 1) {
          const source =
            right.type.kind === "union" ? lowerer.unions.get(right.type.unionId) : undefined;
          target = {
            kind: "union",
            unionId: source ? lowerer.unions.transform(source, arms) : lowerer.unions.intern(arms),
          };
        }
      }
    }
    if (target?.kind === "union") {
      // `&&` whose left does NOT fit the result union: the checker
      // built that result by DROPPING left arms which are always
      // truthy (`Option | undefined && string | undefined` answers
      // `string | undefined`, not `Option | string | undefined`).
      // Evaluate the left once, test it in its own union, and retag it
      // only on the falsy path. Any stranded reference arms are
      // unreachable there because every JS object is truthy.
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken &&
        left.type.kind === "union" &&
        !typeEquals(left.type, target)
      ) {
        const def = lowerer.unions.get(left.type.unionId);
        const trappable = new Set<number>();
        def?.arms.forEach((arm, tag) => {
          if (lowerer.armTag(target.unionId, arm) < 0 && REF_TRUTHY_KINDS.has(arm.kind)) {
            trappable.add(tag);
          }
        });
        const retag =
          trappable.size === 0
            ? null
            : lowerer.unionRetagHelper(left.type.unionId, target.unionId, loc, trappable);
        if (retag) {
          lowerer.requireTruthyUnion(left.type.unionId, expr);
          const stmts: IrStmt[] = [];
          let stable: IrExpr = left;
          if (!isSafeToRepeat(left)) {
            const local = lowerer.declareHiddenLocal("%and", left.type);
            stmts.push({ kind: "varDecl", localId: local.id, init: left, loc });
            stable = varRef(local.id, left.type, loc);
          }
          const result: IrExpr = {
            kind: "ternary",
            cond: lowerer.ensureBool(stable, expr.left),
            then: lowerer.coerceInto(expr.right, right, target),
            else_: { kind: "call", callee: retag, args: [stable], type: target, loc },
            type: target,
            loc,
          };
          return stmts.length === 0
            ? result
            : { kind: "seqExpr", stmts, result, type: target, loc };
        }
      }
      // `||` whose left does NOT fit the result union: the checker built
      // that result by DROPPING the left's falsy arms (`process.env.X ||
      // null` is `string | null`, `|| 3000` is `string | number` — the
      // `undefined` is gone from both), so coercing the left eagerly, as
      // the shared shape below does, retags an arm the test is about to
      // rule out and throws where Node yields the default. Single-eval
      // instead: test the left in its OWN union and retag only on the
      // truthy side, where the dropped arms are unreachable.
      if (
        op === ts.SyntaxKind.BarBarToken &&
        left.type.kind === "union" &&
        !typeEquals(left.type, target)
      ) {
        const retag = lowerer.unionRetagHelper(left.type.unionId, target.unionId, loc);
        if (retag) {
          lowerer.requireTruthyUnion(left.type.unionId, expr);
          return {
            kind: "orDefault",
            left,
            right: lowerer.coerceInto(expr.right, right, target),
            retag,
            type: target,
            loc,
          };
        }
      }
      lowerer.requireTruthyUnion(target.unionId, expr);
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, target),
        right: lowerer.coerceInto(expr.right, right, target),
        type: target,
        loc,
      };
    }
    // `u || d` NARROWED by the default: the checker types the result
    // as u's single non-unit arm (`marker() || "default"`) — evaluate
    // u once, truthy extracts the arm, falsy takes d lazily (the
    // orDefault node, nullish's truthiness sibling). An UNMAPPABLE
    // checker result takes the same rule (`options.runner ||
    // defaultRunner` — tsc's union of two structurally-compatible
    // function types has no representation, while the left's one
    // non-unit arm is the only representable answer): the default
    // must coerce into the arm or fence on its own.
    if (op === ts.SyntaxKind.BarBarToken && left.type.kind === "union") {
      const def = lowerer.unions.get(left.type.unionId);
      const rest = def ? def.arms.filter((a) => !isUnitType(a)) : [];
      const funcArmDefault =
        rest[0]?.kind === "func" && (target === null || target.kind === "func");
      if (
        rest.length === 1 &&
        ((target !== null && typeEquals(target, rest[0]!)) || funcArmDefault)
      ) {
        lowerer.requireTruthyUnion(left.type.unionId, expr);
        const dflt = lowerer.lowerExprExpecting(expr.right, rest[0]!);
        return { kind: "orDefault", left, right: dflt, type: rest[0]!, loc };
      }
    }
    // JavaScript defaults can join differently inferred object layouts.
    // When both operands have native checked representations, preserve
    // the deciding value and short-circuit evaluation in that domain.
    if (
      isJsSourceFile(expr.getSourceFile()) &&
      lowerer.dynConvertible(left.type) &&
      lowerer.dynConvertible(right.type)
    ) {
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, DYN),
        right: lowerer.coerceInto(expr.right, right, DYN),
        type: DYN,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `logical operators on union-typed values outside conditions (${NARROW_FIRST})`,
    );
  }
  const kind = left.type.kind;
  if (kind !== right.type.kind || (kind !== "f64" && kind !== "string" && kind !== "bool")) {
    // Mixed PLAIN operands (`value || null`, `flag || undefined`,
    // `s || 0`): JS value semantics still compile when the checker
    // types the RESULT as one union both operands coerce into — the
    // same lift the union-operand path above takes, arriving here
    // with two plain arm values instead.
    const target = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (target?.kind === "union") {
      lowerer.requireTruthyUnion(target.unionId, expr);
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, target),
        right: lowerer.coerceInto(expr.right, right, target),
        type: target,
        loc,
      };
    }
    lowerer.unsupported("SC1042", expr);
  }
  return {
    kind: "logical",
    op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
    left,
    right,
    type: left.type,
    loc,
  };
}

function lowerAbsenceAwareOrChain(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const nodes: ts.Expression[] = [];
  const pending: ts.Expression[] = [expr];
  while (pending.length !== 0) {
    const node = pending.pop()!;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      pending.push(node.right, node.left);
    } else {
      nodes.push(node);
    }
  }
  if (nodes.length < 3) return null;
  const lowered = nodes.map((node) => lowerAbsenceProbe(lowerer, node) ?? lowerer.lowerExpr(node));
  if (
    !lowered.some(
      (value) =>
        value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0,
    )
  ) {
    return null;
  }
  let result = lowered[lowered.length - 1]!;
  for (let i = lowered.length - 2; i >= 0; i--) {
    const left = lowered[i]!;
    const loc = locOf(nodes[i]!);
    if (left.type.kind === "union") {
      const def = lowerer.unions.get(left.type.unionId);
      const nonUnit = def?.arms.filter((arm) => !isUnitType(arm)) ?? [];
      if (nonUnit.length !== 1 || !typeEquals(nonUnit[0]!, result.type)) return null;
      lowerer.requireTruthyUnion(left.type.unionId, expr);
      result = { kind: "orDefault", left, right: result, type: result.type, loc };
      continue;
    }
    if (!typeEquals(left.type, result.type)) return null;
    result = { kind: "logical", op: "||", left, right: result, type: result.type, loc };
  }
  return result;
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
function errorRootedObjectOf(lowerer: Lowerer, t: ts.Type): IrType | null {
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

/** `typeof e.code === "string"` / `"undefined"` (and the `!==` forms)
 * where e — through parens and as-casts — is a catch binding or a value
 * of %Error-rooted type: the runtime error's code slot is a string
 * exactly when present, so the typeof test IS the presence test (the
 * isErrnoException predicate's third conjunct,
 * `typeof (err as Record<string, unknown>).code === "string"`). The
 * as-cast changes the expression's TYPE, never the value — peeled like
 * lowerProcessStreamProperty's receiver match. Null for every other
 * shape, so the sibling typeof lowerings keep trying. */
function lowerErrorCodeTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    let prop: ts.Expression = a.expression;
    while (ts.isParenthesizedExpression(prop)) prop = prop.expression;
    if (!ts.isPropertyAccessExpression(prop) || prop.questionDotToken) continue;
    if (prop.name.text !== "code") continue;
    let recv: ts.Expression = prop.expression;
    while (
      ts.isParenthesizedExpression(recv) ||
      ts.isAsExpression(recv) ||
      ts.isTypeAssertion(recv)
    )
      recv = recv.expression;
    const errT = errorRootedObjectOf(lowerer, lowerer.typeOf(recv));
    if (!errT) continue;
    const caught = lowerer.caughtLocalOf(recv);
    let receiver: IrExpr;
    if (caught) {
      // The checker proved the Error narrowing (errT above), so the
      // trusted extraction is sound — caughtRead itself would fence on
      // the intersection spelling.
      receiver = {
        kind: "caughtNarrow",
        value: { kind: "varRef", localId: caught.id, type: CAUGHT, loc },
        type: errT,
        loc,
      };
    } else {
      receiver = lowerer.lowerExpr(recv);
      if (receiver.type.kind !== "object") continue;
    }
    if (!ts.isStringLiteral(b)) continue;
    if (b.text !== "string" && b.text !== "undefined") continue;
    const codeType = lowerer.envValueType();
    if (codeType.kind !== "union")
      throw new InternalCompilerError("lowerer bug: error code type is not a union");
    const undefTag = lowerer.armTag(codeType.unionId, UNDEFINED_T);
    const read: IrExpr = {
      kind: "libCall",
      fn: "error.code",
      args: [receiver],
      type: codeType,
      loc,
    };
    // typeof === "string" ⇔ the code slot is present (NOT the undefined
    // arm); === "undefined" ⇔ absent. `!==` flips either.
    const isNotUndef = b.text === "string" ? !negated : negated;
    return {
      kind: "unionIsTag",
      unionId: codeType.unionId,
      tag: undefTag,
      ...(isNotUndef ? { negated: true as const } : {}),
      value: read,
      type: BOOL,
      loc,
    };
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

/** The static `typeof` answer for a union ARM's IR type, or null when the
 * arm has no fixed answer. Unit arms are known (`typeof undefined` is
 * "undefined", `typeof null` is "object" — JS's oldest wart, preserved
 * exactly); every ref kind is a JS object ("object"), func arms would be
 * "function" (unions never carry them — defensive), and the jsval/dyn/
 * caught/void/union kinds cannot appear as arms. */
function typeofAnswer(arm: IrType): string | null {
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
    case "regex":
    case "bytes":
    case "url":
    case "searchParams":
    case "stats":
    case "fileHandle":
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
  if (implicitMonoFile(cond.getSourceFile())) walk(cond, polarity);
  return out;
}

/** Visit both operand orders while keeping the sequence an array of pairs. */
function operandPairs(expr: ts.BinaryExpression): [ts.Expression, ts.Expression][] {
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
    const aliasDecl = aliasSym ? lowerer.checker.valueDeclarationOf(aliasSym) : undefined;
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
    const valDecl = valSym ? lowerer.checker.valueDeclarationOf(valSym) : undefined;
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

/** `typeof v === "lit"` / `typeof v !== "lit"` where v is UNION-typed: the
 * arms whose static typeof answer equals the literal form a tag set, and
 * the test is a runtime tag test — one `unionIsTag` for a single matching
 * arm (the operand embeds once, so even effectful operands compose), a
 * short-circuit chain for several (pure reads only — the operand rides
 * every test, exactly the `== null` composition rule). When every arm
 * answers the same way the comparison is statically decided and folds to
 * a bool literal — dropping only a side-effect-free read, the same
 * trust-the-checker bet as lowerUnitComparison. tsc's control-flow
 * narrowing then types the branches, and reads bridge through
 * maybeNarrow's unionNarrow as usual. Null when neither side is a typeof
 * over a union-typed operand or the literal side isn't a literal (the
 * bare-typeof value form then composes with strEq for pure operands). */
function lowerUnionTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    if (lowerer.mapTypeOf(lowerer.typeOf(a.expression))?.kind !== "union") continue;
    if (!ts.isStringLiteral(b)) continue; // bare-typeof + strEq handles pure operands
    const value = lowerer.lowerExpr(a.expression);
    if (value.type.kind !== "union") continue; // defensive: an already-narrowed use
    const unionId = value.type.unionId;
    const def = lowerer.unions.get(unionId);
    const answers = def?.arms.map(typeofAnswer);
    if (!def || !answers || !answers.every((s): s is string => s !== null)) continue;
    const tags = answers.flatMap((s, i) => (s === b.text ? [i] : []));
    if (tags.length === 0 || tags.length === def.arms.length) {
      if (!isSafeToRepeat(value)) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "statically-decided 'typeof' tests over effectful operands (bind the value to a const first)",
        );
      }
      return { kind: "boolLit", value: (tags.length !== 0) !== negated, type: BOOL, loc };
    }
    const isTag = (tag: number): IrExpr => ({
      kind: "unionIsTag",
      unionId,
      tag,
      negated,
      value,
      type: BOOL,
      loc,
    });
    if (tags.length === 1) return isTag(tags[0]!);
    if (!isSafeToRepeat(value)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "'typeof' tests matching several union arms over operands that aren't plain reads (bind the value to a const first)",
      );
    }
    // Tag-in-set as a short-circuit chain (De Morgan for `!==`).
    let acc = isTag(tags[0]!);
    for (const t of tags.slice(1)) {
      acc = {
        kind: "logical",
        op: negated ? "&&" : "||",
        left: acc,
        right: isTag(t),
        type: BOOL,
        loc,
      };
    }
    return acc;
  }
  return null;
}

/** `typeof v === "lit"` / `typeof v !== "lit"` where v is `unknown`-typed
 * (dyn): the runtime kind test over the dyn node's tag. Only the kinds a
 * later read can bridge narrow ("string"/"number"/"boolean") plus
 * "undefined" (no payload to read); "object"/"function" tests keep the
 * fence — an object-narrowed `unknown` read has no lowering anyway (a
 * checked cast `v as T` is the supported extraction). Null when neither
 * side is a typeof over a dyn-typed operand (not this pattern). */
function lowerDynTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    if (lowerer.isStdlibGlobal(a.expression, "fetch")) continue;
    // Non-literal comparisons use the ordinary typeof string value,
    // preserving both operands' evaluation order without a narrowing test.
    if (!ts.isStringLiteral(b)) continue;
    const declared = lowerer.mapTypeOf(lowerer.typeOf(a.expression));
    let value: IrExpr;
    if (declared?.kind === "dyn") {
      value = lowerer.lowerExpr(a.expression);
      if (value.type.kind !== "dyn") continue; // defensive: an already-narrowed use
    } else if (lowerer.caughtLocalOf(a.expression)) {
      continue; // the caught lowering's territory (it ran first and declined)
    } else {
      // `typeof (value as T).field === "string"` — the raw-object
      // validation idiom (routes.ts's isValidRoute): the `as` is erasure
      // in JS, so the READ is the dyn KEYED read of the un-cast value —
      // a missing key answers undefined and the guard goes false,
      // Node-exact — never the checked cast (validating T here would
      // throw on exactly the values the guard exists to reject).
      const unparen = (e: ts.Expression): ts.Expression => {
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        return e;
      };
      let keyed: IrExpr | null = null;
      const pn = unparen(a.expression);
      if (ts.isPropertyAccessExpression(pn) && !pn.questionDotToken && ts.isIdentifier(pn.name)) {
        const recv = unparen(pn.expression);
        if (ts.isAsExpression(recv) || ts.isTypeAssertion(recv)) {
          const inner = unparen(recv.expression);
          const obj = tryLowerExpression(lowerer, inner);
          if (obj?.type.kind === "dyn") {
            keyed = {
              kind: "dynKeyGet",
              key: { kind: "strLit", value: pn.name.text, type: STRING, loc },
              value: obj,
              type: DYN,
              loc,
            };
          }
        }
      }
      if (keyed) {
        value = keyed;
      } else {
        // A narrowing residue of `unknown`: a `!== undefined` (or truthy)
        // guard ahead of the typeof test spells the operand `{}`/`{} |
        // null` — no useful static mapping, but the READ is still the dyn
        // value (`if (obj.name !== undefined) { if (typeof obj.name !==
        // "string") ... }`, the validateConfig idiom). Probe the lowering
        // and claim exactly the dyn results; anything else keeps its
        // sibling lowerings and fences untouched.
        const probed = tryLowerExpression(lowerer, a.expression);
        if (probed?.type.kind !== "dyn") continue;
        value = probed;
      }
    }
    if (
      b.text === "string" ||
      b.text === "number" ||
      b.text === "boolean" ||
      b.text === "undefined" ||
      b.text === "bigint" ||
      b.text === "symbol"
    ) {
      return {
        kind: "dynTest",
        test: b.text,
        ...(negated ? { negated: true as const } : {}),
        value,
        type: BOOL,
        loc,
      };
    }
    // `typeof v === "object"`: the dyn answers exactly (object, array,
    // bytes, and null kinds — JS's oldest wart preserved). tsc narrows
    // the branch to `object | null`; reads past the narrow take the
    // checked-cast path per site.
    if (b.text === "object") {
      return {
        kind: "dynTest",
        test: "object",
        ...(negated ? { negated: true as const } : {}),
        value,
        type: BOOL,
        loc,
      };
    }
    // `typeof v === "function"`: a REAL runtime test since the checked-dynamic tree's
    // function kind exists (boxed closures — the mustCall guard
    // `if (typeof fn !== 'function') throw` answers honestly).
    if (b.text === "function") {
      return {
        kind: "dynTest",
        test: "function",
        ...(negated ? { negated: true as const } : {}),
        value,
        type: BOOL,
        loc,
      };
    }
    // Native checked values do not yet carry symbols.
    if (b.text === "symbol") {
      return { kind: "boolLit", value: negated, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      b,
      `'typeof' tests against "${b.text}" on 'unknown' values (only "string"/"number"/` +
        `"boolean"/"undefined"/"object" narrow; use a checked cast — 'v as T' — to extract)`,
    );
  }
  return null;
}

/** `exports.<name>` in a JS module whose `module.exports =` REPLACED the
 * export object, with no `exports.<name> =` attachment anywhere in the
 * file: the read observes the ORIGINAL (empty-here) exports object, so
 * the honest value is undefined (Node's object identity exactly; tsc's
 * CJS model types the read off the replacement — identity-blind). Null
 * everywhere else: no replacement, a real attachment of this name, a
 * shadowing binding named `exports`, or write position. */
function lowerReplacedExportsRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const recv = expr.expression;
  if (!ts.isIdentifier(recv) || recv.text !== "exports") return null;
  const sf = expr.getSourceFile();
  if (!isJsSourceFile(sf) || isNodeEsmFile(sf, lowerer.program)) return null;
  if (lowerer.peekLocal(recv) || lowerer.globalOf(recv)) return null; // a user binding shadows
  // Write position is the export-assignment machinery's territory.
  if (
    ts.isBinaryExpression(expr.parent) &&
    expr.parent.left === expr &&
    expr.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  let replaced = false;
  for (const stmt of sf.statements) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (!cjs) continue;
    if (cjs.kind === "table" && cjsExportDiscardReason(stmt) === null) replaced = true;
    if (cjs.kind === "member" && ts.isIdentifier(cjs.name) && cjs.name.text === expr.name.text) {
      return null; // a real attachment of this name exists somewhere
    }
  }
  if (!replaced) return null;
  return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
}

/** A read that resolves to a CJS export-table ACCESSOR property
 * (`module.exports = { get path() {...}, set path(v) {...} }`): the
 * getter lifts as a module-level function (module globals need no
 * captures) — interned per declaration so every read site calls ONE
 * function — and the read IS the call, Node's per-read evaluation
 * exactly. Null when the identifier doesn't resolve to such a property
 * (or it has no getter: a setter-only read answers undefined in Node —
 * rare enough to keep fenced). */
function cjsExportAccessorRead(lowerer: Lowerer, ident: ts.Identifier): IrExpr | null {
  const symbol = lowerer.resolveValueSymbol(ident);
  const getter = symbol
    ? lowerer.checker.declarationsOf(symbol).find(ts.isGetAccessorDeclaration)
    : undefined;
  if (!getter) return null;
  if (!ts.isObjectLiteralExpression(getter.parent) || !isCjsExportTableLiteral(getter.parent)) {
    return null;
  }
  return cjsAccessorCall(lowerer, getter, locOf(ident));
}

/** The interned lifted-getter call both accessor-read paths share. */
function cjsAccessorCall(
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

/** `this.<name>` INSIDE a CJS export-table accessor (test/common's
 * `get localhostIPv4() { if (this.inFreeBSDJail) ... }`): Node binds the
 * getter's receiver to module.exports, so the read is the SIBLING table
 * property — a sibling GETTER's lifted call (per-read evaluation, like
 * any accessor read). Only arrows inherit the binding (a nested function
 * expression's `this` is its own). Null everywhere else — non-getter
 * siblings and absent names keep their per-site fences (none of the
 * probed suite shapes read them). */
function lowerCjsExportTableThisMember(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.expression.kind !== ts.SyntaxKind.ThisKeyword || expr.questionDotToken) return null;
  if (!isJsSourceFile(expr.getSourceFile())) return null;
  // The enclosing accessor, crossing only arrow boundaries (arrows
  // inherit `this`; any other function form rebinds it).
  let n: ts.Node | undefined = expr.parent;
  while (n !== undefined && !ts.isGetAccessorDeclaration(n) && !ts.isSetAccessorDeclaration(n)) {
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return null;
    if (ts.isSourceFile(n)) return null;
    n = n.parent;
  }
  if (
    n === undefined ||
    !ts.isObjectLiteralExpression(n.parent) ||
    !isCjsExportTableLiteral(n.parent)
  ) {
    return null;
  }
  const sibling = n.parent.properties.find(
    (p): p is ts.GetAccessorDeclaration =>
      ts.isGetAccessorDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === expr.name.text,
  );
  if (!sibling) return null;
  return cjsAccessorCall(lowerer, sibling, locOf(expr));
}

/** A read of a catch binding — the caught analog of maybeNarrow. Where
 * tsc's control-flow narrowing has proven a supported test (`instanceof`
 * over a hierarchy class, `typeof` over a primitive), the read bridges
 * with a kind-unchecked `caughtNarrow` extraction (trust-the-checker,
 * exactly like unionNarrow). Every OTHER read is the narrowness fence:
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
  if (narrowed?.kind === "dyn") {
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

/** `x instanceof C` for a program-declared class C. When x's static
 * class and C are both in extends-hierarchies the test is dynamic — the
 * O(1) preorder-interval check against the vtable (`instanceOf` node).
 * Everything else is decided by the static class graph alone and folds
 * to the honest constant: `x instanceof C` is always true when x's
 * static class IS C or descends from it, and always false when the
 * classes are unrelated (a standalone class has no other relatives).
 * Folding is limited to side-effect-free operands — dropping a computed
 * operand would skip its effects, so those are rejected instead. */
export function lowerInstanceOf(lowerer: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
  // `x instanceof net.Socket` over a union with a netSocket arm — the
  // h2 compat 'connect' narrowing (lower-server.ts): a union tag test.
  const sockTest = lowerSocketInstanceOf(lowerer, expr, loc);
  if (sockTest !== null) return sockTest;
  // An ISLAND class as the RHS (`v instanceof Boom` on a package-
  // exported class — the safeParse-style error narrowing): the spec's
  // InstanceofOperator runs in the engine (Symbol.hasInstance included;
  // a non-object RHS throws the engine's own TypeError, catchably).
  // The LHS marshals in — island handles pass through, static
  // primitives answer false exactly like the spec's non-object rule,
  // and unmarshalable statics (class instances, catch bindings — the
  // payload is a name/message snapshot, never the engine object) keep
  // jsvalIn's honest fences.
  if (lowerer.isIslandExpr(expr.right) && !lowerer.caughtLocalOf(expr.left)) {
    const left = lowerer.jsvalIn(lowerer.lowerExpr(expr.left), expr.left);
    const right = lowerer.lowerExpr(expr.right);
    return { kind: "jsOp", op: "instanceOf", args: [left, right], type: BOOL, loc };
  }
  if (
    !lowerer.dynamic &&
    (lowerer.isStdlibGlobal(expr.right, "Set") || lowerer.isStdlibGlobal(expr.right, "Map"))
  ) {
    const collection = lowerer.isStdlibGlobal(expr.right, "Map") ? "map" : "set";
    const value = lowerer.lowerExpr(expr.left);
    if (value.type.kind === "union") {
      const union = lowerer.unions.get(value.type.unionId);
      if (union) {
        const local = lowerer.declareHiddenLocal("%collectionTest", value.type);
        const reference = varRef(local.id, value.type, loc);
        let result: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
        union.arms.forEach((arm, tag) => {
          if (arm.kind !== collection) return;
          const test: IrExpr = {
            kind: "unionIsTag",
            unionId: union.id,
            value: reference,
            tag,
            negated: false,
            type: BOOL,
            loc,
          };
          result =
            result.kind === "boolLit"
              ? test
              : { kind: "logical", op: "||", left: result, right: test, type: BOOL, loc };
        });
        return {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
          result,
          type: BOOL,
          loc,
        };
      }
    }
    if (value.type.kind === "dyn")
      return {
        kind: "libCall",
        fn: collection === "map" ? "dyn.nativeMapIs" : "dyn.nativeSetIs",
        args: [value],
        type: BOOL,
        loc,
      };
    if (value.type.kind === collection)
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: value, loc }],
        result: { kind: "boolLit", value: true, type: BOOL, loc },
        type: BOOL,
        loc,
      };
    return {
      kind: "libCall",
      fn: collection === "map" ? "dyn.nativeMapIs" : "dyn.nativeSetIs",
      args: [lowerer.coerceInto(expr.left, value, DYN)],
      type: BOOL,
      loc,
    };
  }
  if (
    lowerer.isStdlibGlobal(expr.right, "WeakMap") ||
    lowerer.isStdlibGlobal(expr.right, "WeakSet")
  ) {
    if (lowerer.dynamic) {
      const value = lowerer.jsvalIn(lowerer.lowerExpr(expr.left), expr.left);
      const ctor: IrExpr = {
        kind: "jsOp",
        op: "globalGet",
        name: lowerer.isStdlibGlobal(expr.right, "WeakMap") ? "WeakMap" : "WeakSet",
        args: [],
        type: JSVAL,
        loc,
      };
      return { kind: "jsOp", op: "instanceOf", args: [value, ctor], type: BOOL, loc };
    }
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return {
      kind: "libCall",
      fn: lowerer.isStdlibGlobal(expr.right, "WeakMap") ? "weakMap.is" : "weakSet.is",
      args: [value],
      type: BOOL,
      loc,
    };
  }
  const rhsBuiltin = ts.isIdentifier(expr.right)
    ? lowerer.builtinImportOf(expr.right)
    : ts.isPropertyAccessExpression(expr.right)
      ? lowerer.builtinMemberOf(expr.right)
      : null;
  if (
    lowerer.isStdlibGlobal(expr.right, "URL") ||
    (rhsBuiltin?.module === "url" && rhsBuiltin.member === "URL")
  ) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "dyn.nativeUrlIs", args: [value], type: BOOL, loc };
  }
  if (lowerer.isStdlibGlobal(expr.right, "DataView")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "dyn.dataViewIs", args: [value], type: BOOL, loc };
  }
  if (lowerer.isStdlibGlobal(expr.right, "SharedArrayBuffer")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "sharedArrayBuffer.is", args: [value], type: BOOL, loc };
  }
  if (lowerer.isStdlibGlobal(expr.right, "ArrayBuffer")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "arrayBuffer.is", args: [value], type: BOOL, loc };
  }
  const rhsSymbol = ts.isIdentifier(expr.right) ? lowerer.resolveValueSymbol(expr.right) : null;
  // `x instanceof events.EventEmitter` — the namespace-member spelling
  // resolves to the same ambient class as the named import.
  const rhsMemberSymbol = (() => {
    if (!ts.isPropertyAccessExpression(expr.right) || !ts.isIdentifier(expr.right.name))
      return null;
    const sym = lowerer.checker.getSymbolAtLocation(expr.right.name);
    return sym && sym.flags & ts.SymbolFlags.Alias
      ? lowerer.checker.getAliasedSymbol(sym)
      : (sym ?? null);
  })();
  // `x instanceof N.C` — the USER-namespace-qualified spelling: the
  // member resolves to the registered program class, with the
  // source-order guard (an init-position test above the class's block
  // would read an uninitialized member in Node).
  const rhsNsClass = (() => {
    if (!ts.isPropertyAccessExpression(expr.right)) return undefined;
    const nsMember = nsMemberIdentOf(lowerer, expr.right);
    if (!nsMember) return undefined;
    const memberSym = lowerer.checker.getSymbolAtLocation(nsMember);
    if (memberSym) fenceEarlyNsMemberRef(lowerer, expr.right, memberSym);
    const classSym = lowerer.resolveValueSymbol(nsMember);
    const nsInfo = classSym ? lowerer.classBySymbol.get(classSym) : undefined;
    // Qualified spellings of a rebindable decorated class (import=
    // alias chains) must not fold against the declaration — the
    // decoration result decides at runtime.
    return nsInfo?.classDecorators?.valueGlobalId !== undefined ? undefined : nsInfo;
  })();
  // A rebindable decorated name as the RHS: the runtime target is the
  // decoration result — fall to the class-VALUE path below, whose
  // instanceOfValue reads the interval off the bound class object.
  const directRhs = rhsSymbol ? lowerer.classBySymbol.get(rhsSymbol) : undefined;
  const target =
    (directRhs?.localClass || directRhs?.classDecorators?.valueGlobalId !== undefined
      ? undefined
      : directRhs) ??
    rhsNsClass ??
    lowerer.builtinErrorInfoOf(rhsSymbol) ??
    lowerer.builtinErrorInfoOf(rhsMemberSymbol) ??
    lowerer.builtinEmitterInfoOf(rhsSymbol) ??
    lowerer.builtinEmitterInfoOf(rhsMemberSymbol) ??
    lowerer.builtinStreamInfoOf(rhsSymbol) ??
    lowerer.builtinStreamInfoOf(rhsMemberSymbol) ??
    undefined;
  if (!target) {
    const date = lowerer.isStdlibGlobal(expr.right, "Date");
    const url = lowerer.isStdlibGlobal(expr.right, "URL");
    if ((date || url) && !lowerer.caughtLocalOf(expr.left)) {
      const value = lowerer.lowerExpr(expr.left);
      if (value.type.kind === "dyn")
        return {
          kind: "libCall",
          fn: date ? "dyn.nativeDateIs" : "dyn.nativeUrlIs",
          args: [value],
          type: BOOL,
          loc,
        };
      if (value.type.kind === "union")
        return {
          kind: "libCall",
          fn: date ? "dyn.nativeDateIs" : "dyn.nativeUrlIs",
          args: [lowerer.coerceInto(expr.left, value, DYN)],
          type: BOOL,
          loc,
        };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: value, loc }],
        result: {
          kind: "boolLit",
          value: value.type.kind === (date ? "date" : "url"),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    const webBrand = ["Request", "Response", "Headers"].find((name) =>
      lowerer.isStdlibGlobal(expr.right, name),
    );
    if (webBrand)
      return {
        kind: "libCall",
        fn: "fetch.webIs",
        args: [
          lowerer.lowerExprExpecting(expr.left, DYN),
          { kind: "strLit", value: webBrand, type: STRING, loc },
        ],
        type: BOOL,
        loc,
      };
    if (lowerer.isStdlibGlobal(expr.right, "ReadableStream")) {
      const value = lowerer.lowerExprExpecting(expr.left, DYN);
      return { kind: "libCall", fn: "fetch.streamIs", args: [value], type: BOOL, loc };
    }
    // Unknown storage retains each numeric typed array's exact native brand.
    if (!lowerer.caughtLocalOf(expr.left)) {
      const elem = (Object.keys(BYTES_ELEMENT_NAME) as IrBytesElem[]).find((kind) =>
        lowerer.isStdlibGlobal(expr.right, BYTES_ELEMENT_NAME[kind]),
      );
      if (elem !== undefined) {
        const left = lowerer.lowerExpr(expr.left);
        if (left.type.kind === "dyn") {
          return { kind: "dynTest", test: "bytes", bytesElem: elem, value: left, type: BOOL, loc };
        }
        return {
          kind: "dynTest",
          test: "bytes",
          bytesElem: elem,
          value: lowerer.coerceInto(expr.left, left, DYN),
          type: BOOL,
          loc,
        };
      }
    }
    // `x instanceof RegExp` over a union with a regex arm (the
    // skip-utility `string | RegExp` dispatch): a union tag test — the
    // socket-narrowing shape; the checker types the branches and
    // maybeNarrow bridges the reads. A plain regex-typed LHS folds
    // true; the fold keeps the operand-purity rule of the class folds
    // (identifier reads only).
    if (
      ts.isIdentifier(expr.right) &&
      lowerer.isStdlibGlobal(expr.right, "RegExp") &&
      !lowerer.caughtLocalOf(expr.left)
    ) {
      const left = lowerer.lowerExpr(expr.left);
      if (left.type.kind === "dyn")
        return { kind: "libCall", fn: "dyn.nativeRegexIs", args: [left], type: BOOL, loc };
      if (left.type.kind === "union") {
        const def = lowerer.unions.get(left.type.unionId);
        const tag = def ? def.arms.findIndex((a) => a.kind === "regex") : -1;
        if (tag >= 0) {
          return {
            kind: "unionIsTag",
            unionId: left.type.unionId,
            tag,
            negated: false,
            value: left,
            type: BOOL,
            loc,
          };
        }
      }
      return {
        kind: "libCall",
        fn: "dyn.nativeRegexIs",
        args: [lowerer.coerceInto(expr.left, left, DYN)],
        type: BOOL,
        loc,
      };
    }
    // `x instanceof X` where X is a class VALUE (a classval-typed
    // binding): the target is DYNAMIC — a hierarchy target reads its
    // interval from the class object at runtime (instanceOfValue); a
    // STANDALONE target class has exactly one possible runtime value
    // (itself — no descendants can flow into the slot), so the answer
    // folds statically exactly like the named-target folds below.
    const rhsClassval = storedClassValueType(lowerer, expr.right);
    if (rhsClassval?.kind === "classval" && !lowerer.caughtLocalOf(expr.left)) {
      const targetInfo = lowerer.classes.get(rhsClassval.className);
      if (!targetInfo) {
        // The type world names a class the lowering never registered
        // (a fenced class expression, a deferred declaration): flush
        // its diagnostics and poison the test site, never an ICE.
        lowerer.flushDeferredClass(rhsClassval.className);
        lowerer.unsupported(
          "SC1090",
          expr,
          "'instanceof' against a class value whose class has no lowering (the class declaration itself was rejected — see its own diagnostic)",
        );
      }
      const left = lowerer.lowerExpr(expr.left);
      if (left.type.kind === "dyn") {
        const classValue = lowerer.lowerExpr(expr.right);
        return classInstanceOf(lowerer, left, targetInfo, loc, classValue);
      }
      if (left.type.kind !== "object") {
        lowerer.unsupported(
          "SC1090",
          expr,
          "'instanceof' on values other than class instances (narrow union-typed values first)",
        );
      }
      const lhsInfo = lowerer.classes.get(left.type.className);
      if (!lhsInfo)
        throw new InternalCompilerError(`lowerer bug: unknown class ${left.type.className}`);
      if (
        (lowerer.inHierarchy(targetInfo) && lowerer.inHierarchy(lhsInfo)) ||
        (targetInfo.localClass !== undefined && lhsInfo.localClass !== undefined)
      ) {
        const classValue = lowerer.lowerExpr(expr.right);
        if (classValue.type.kind !== "classval")
          lowerer.badType(expr.right, lowerer.typeOf(expr.right));
        return { kind: "instanceOfValue", value: left, classValue, type: BOOL, loc };
      }
      // A standalone side: the answer is static (the target slot can
      // only hold the named class; a standalone operand's runtime class
      // IS its static class). Folding discards the operands' evaluation,
      // so only side-effect-free shapes fold — the named-target rule.
      const value =
        left.type.className === targetInfo.def.name ||
        lowerer.isSubclassOf(left.type.className, targetInfo.def.name);
      if (
        left.kind === "varRef" &&
        (ts.isIdentifier(expr.right) || expr.right.kind === ts.SyntaxKind.ThisKeyword)
      ) {
        return { kind: "boolLit", value, type: BOOL, loc };
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "statically-decided 'instanceof' on computed operands (bind the values to variables first)",
      );
    }
    const constructor = tryLowerExpression(lowerer, expr.right);
    if (constructor?.type.kind === "dyn" && isJsSourceFile(expr.getSourceFile())) {
      const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
      return checkedClassInstanceOf(lowerer, value, constructor, loc);
    }
    lowerer.unsupported(
      "SC1090",
      expr.right,
      "'instanceof' right-hand sides other than classes declared in the program",
    );
  }
  // A catch binding on the left: the runtime test against the class's
  // preorder interval (false for non-hierarchy-object payloads). tsc's
  // narrowing then types the branches; reads bridge through caughtRead.
  const caughtLocal = lowerer.caughtLocalOf(expr.left);
  if (caughtLocal) {
    if (!lowerer.inHierarchy(target)) {
      const value = varRef(caughtLocal.id, CAUGHT, loc);
      return {
        kind: "ternary",
        cond: {
          kind: "caughtTest",
          value,
          test: "instanceof",
          className: target.def.name,
          type: BOOL,
          loc,
        },
        then: { kind: "boolLit", value: true, type: BOOL, loc },
        else_: classInstanceOf(
          lowerer,
          { kind: "caughtToDyn", value, type: DYN, loc },
          target,
          loc,
        ),
        type: BOOL,
        loc,
      };
    }
    return {
      kind: "caughtTest",
      value: { kind: "varRef", localId: caughtLocal.id, type: CAUGHT, loc },
      test: "instanceof",
      className: target.def.name,
      type: BOOL,
      loc,
    };
  }
  const left = lowerer.lowerExpr(expr.left);
  // `u instanceof Error` on an `unknown` value: the checked-dynamic tree's error encoding
  // (the shape caughtToDyn builds for Error payloads — the reserved
  // "%error" marker) answers the test, so a caught Error passed through
  // an unknown slot narrows like Node (`error instanceof Error ?
  // error.message : String(error)` — the LAN-monitor handler). ROOT
  // only: the marker cannot honestly answer subclass prototype chains
  // (name strings are user-writable), so `u instanceof TypeError` keeps
  // the fence. Reads past the narrow bridge through maybeNarrow's
  // validated %Error extraction. SEMANTICS.md 67.
  if (
    left.type.kind === "dyn" &&
    !target.def.runtime &&
    !target.builtinError &&
    !target.builtinEmitter &&
    !target.builtinStream &&
    !target.localClass
  ) {
    return classInstanceOf(lowerer, left, target, loc);
  }
  if (left.type.kind === "dyn" && target.def.name === "%Error") {
    return { kind: "dynTest", test: "error", value: left, type: BOOL, loc };
  }
  // `u instanceof TypeError` (and the other BUILTIN error classes) on a
  // dyn value: the from_error cache holds the checked-dynamic tree↔error identity edge,
  // so the runtime resolves the encoding back to its error and asks the
  // vtable's stamped interval — exact for every error that crossed the
  // boundary (a hand-built {%error} literal answers false: subclass
  // identity is unknowable there). User subclasses keep the fence.
  if (left.type.kind === "dyn" && RUNTIME_ERROR_CLASSES.has(target.def.name)) {
    const rec = RUNTIME_ERROR_CLASSES.get(target.def.name)!;
    return {
      kind: "libCall",
      fn: "dyn.errInstanceof",
      args: [left, { kind: "numLit", value: rec.kind, type: F64, loc }],
      type: BOOL,
      loc,
    };
  }
  if (left.type.kind === "dyn") {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'instanceof ${target.def.name.replace(/^%/, "")}' on 'unknown' values (only the Error classes answer — test 'instanceof Error' and read '.name')`,
    );
  }
  if (left.type.kind === "union") {
    const unionId = left.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms;
    // Ordinary records and scalar values do not carry a class prototype.
    // Dynamic/opaque runtime objects keep their existing instanceof fences.
    if (
      arms?.every(
        (arm) =>
          arm.kind === "object" ||
          arm.kind === "record" ||
          arm.kind === "f64" ||
          arm.kind === "string" ||
          arm.kind === "bool" ||
          arm.kind === "bigint" ||
          arm.kind === "symbol" ||
          isUnitType(arm),
      )
    ) {
      const key = `instanceof.union:${unionId}:${target.def.name}`;
      let helper = lowerer.valueHelpers.get(key);
      if (!helper) {
        helper = `%instanceof.union.${lowerer.valueHelpers.size}`;
        lowerer.valueHelpers.set(key, helper);
        const value: IrExpr = { kind: "varRef", localId: "value.0", type: left.type, loc };
        const body: IrStmt[] = [];
        arms.forEach((arm, tag) => {
          if (arm.kind !== "object") return;
          const lhsInfo = lowerer.classes.get(arm.className);
          if (!lhsInfo)
            throw new InternalCompilerError(`lowerer bug: unknown class ${arm.className}`);
          const result: IrExpr =
            lowerer.inHierarchy(lhsInfo) && lowerer.inHierarchy(target)
              ? {
                  kind: "instanceOf",
                  value: { kind: "unionNarrow", unionId, tag, value, type: arm, loc },
                  className: target.def.name,
                  type: BOOL,
                  loc,
                }
              : {
                  kind: "boolLit",
                  value:
                    arm.className === target.def.name ||
                    lowerer.isSubclassOf(arm.className, target.def.name),
                  type: BOOL,
                  loc,
                };
          body.push({
            kind: "if",
            cond: { kind: "unionIsTag", unionId, tag, negated: false, value, type: BOOL, loc },
            then: [{ kind: "return", value: result, loc }],
            else_: null,
            loc,
          });
        });
        body.push({
          kind: "return",
          value: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        });
        lowerer.liftedFns.push({
          name: helper,
          params: [{ localId: "value.0", name: "value", type: left.type }],
          returnType: BOOL,
          locals: [{ id: "value.0", name: "value", type: left.type, mutable: false }],
          body,
          loc,
        });
      }
      return { kind: "call", callee: helper, args: [left], type: BOOL, loc };
    }
  }
  if (left.type.kind !== "object") {
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: left, loc }],
      result: { kind: "boolLit", value: false, type: BOOL, loc },
      type: BOOL,
      loc,
    };
  }
  const lhsInfo = lowerer.classes.get(left.type.className);
  if (!lhsInfo)
    throw new InternalCompilerError(`lowerer bug: unknown class ${left.type.className}`);
  if (lowerer.inHierarchy(lhsInfo) && lowerer.inHierarchy(target)) {
    return { kind: "instanceOf", value: left, className: target.def.name, type: BOOL, loc };
  }
  const value =
    left.type.className === target.def.name ||
    lowerer.isSubclassOf(left.type.className, target.def.name);
  if (left.kind === "varRef") {
    return { kind: "boolLit", value, type: BOOL, loc };
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "statically-decided 'instanceof' on computed operands (bind the value to a variable first)",
  );
}

/** `#name in obj` — the ergonomic brand check. In this closed world a
 * brand is held by exactly the instances of the declaring class
 * (subclasses included — construction always runs the declaring class's
 * own initializers), so the test IS `obj instanceof <declaring class>`:
 * statically decided when the receiver's class sits at/below the
 * declarer (true) or in a disjoint subtree (false) — both folds under
 * the instanceof purity rule — and a runtime interval test when the
 * declarer sits strictly BELOW the receiver's static class (the
 * narrowing use; tsc types the true branch at the class, and reads
 * bridge through maybeNarrow's downcast exactly like instanceof). tsc
 * confines the spelling to the declaring class's body and rejects
 * primitive/unknown receivers, so Node's in-operator TypeError is
 * unreachable in compilable programs. Timing residue: JS installs
 * brands DURING construction, so a check reachable from a base
 * constructor can observe false mid-construction where this answers
 * true (SEMANTICS.md). */
function lowerPrivateIn(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  priv: ts.PrivateIdentifier,
  loc: SrcLoc,
): IrExpr {
  const pname = priv.text;
  // The declaring class: the nearest enclosing class declaring the name
  // (JS scoping — an inner class's spelling shadows an outer one's).
  let classDecl: ts.ClassLikeDeclaration | null = null;
  let staticBrand = false;
  for (let n: ts.Node | undefined = priv.parent; n; n = n.parent) {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const owner = n.members.find((m) => {
        const name = (m as { name?: ts.PropertyName }).name;
        return name !== undefined && ts.isPrivateIdentifier(name) && name.text === pname;
      });
      if (owner) {
        classDecl = n;
        staticBrand =
          ts.canHaveModifiers(owner) &&
          ts.getModifiers(owner)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
        break;
      }
    }
  }
  // tsc rejects the spelling outside a declaring class body; defensive.
  if (!classDecl)
    lowerer.unsupported("SC1090", expr, `'${pname} in …' outside a class declaring '${pname}'`);
  if (staticBrand) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' brand checks for private STATICS (JS brands the declaring class OBJECT, not instances — compare against the class value directly)`,
    );
  }
  const info =
    lowerer.currentClass?.decl === classDecl
      ? lowerer.currentClass
      : (() => {
          const sym = classDecl.name
            ? lowerer.checker.getSymbolAtLocation(classDecl.name)
            : undefined;
          return sym ? lowerer.classBySymbol.get(sym) : undefined;
        })();
  if (!info) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' where the declaring class has no lowering (see the class declaration's own diagnostic)`,
    );
  }
  // A GENERIC family: JS has ONE runtime class and ONE brand for every
  // instantiation, while these layouts mint one class per instantiation
  // — a cross-instantiation check would answer false where Node says
  // true, so the family fences rather than silently splitting the brand.
  if (info.generic || info.genericInstance) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' inside a generic class (JS shares one brand across every instantiation; these layouts mint one class per instantiation)`,
    );
  }
  const recv = lowerer.lowerExpr(expr.right);
  const declName = info.def.name;
  // A UNION of class instances (`o: Counter | Helper` — the
  // discriminating use): every object arm answers membership STATICALLY
  // (at/below the declarer → true, disjoint subtree → false), so the
  // whole test collapses to runtime TAG tests — the record-shape 'in'
  // discrimination, brand form. An arm ABOVE the declarer answers per
  // VALUE (its slot can hold branded and unbranded instances), and
  // non-object arms have no brand story — both fence.
  if (recv.type.kind === "union") {
    const unionId = recv.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms ?? [];
    const answers: { tag: number; has: boolean }[] = [];
    let staticAnswers = arms.length > 0;
    for (const arm of arms) {
      const tag = lowerer.armTag(unionId, arm);
      if (tag < 0 || arm.kind !== "object" || lowerer.isSubclassOf(declName, arm.className)) {
        staticAnswers = false;
        break;
      }
      answers.push({
        tag,
        has: arm.className === declName || lowerer.isSubclassOf(arm.className, declName),
      });
    }
    if (staticAnswers) {
      const pureRecv =
        recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet";
      const isTag = (tag: number, negated: boolean): IrExpr => ({
        kind: "unionIsTag",
        unionId,
        tag,
        negated,
        value: recv,
        type: BOOL,
        loc,
      });
      const trues = answers.filter((a) => a.has);
      if (trues.length === answers.length || trues.length === 0) {
        const ans = trues.length !== 0;
        if (pureRecv) return { kind: "boolLit", value: ans, type: BOOL, loc };
        // Constant either way, receiver still evaluates once: one tag
        // test whose branches agree (the record-'in' rule verbatim).
        return {
          kind: "ternary",
          cond: isTag(answers[0]!.tag, false),
          then: { kind: "boolLit", value: ans, type: BOOL, loc },
          else_: { kind: "boolLit", value: ans, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      if (trues.length === 1) return isTag(trues[0]!.tag, false);
      const falses = answers.filter((a) => !a.has);
      if (falses.length === 1) return isTag(falses[0]!.tag, true);
      if (pureRecv) {
        let out: IrExpr = isTag(trues[0]!.tag, false);
        for (const t of trues.slice(1)) {
          out = {
            kind: "logical",
            op: "||",
            left: out,
            right: isTag(t.tag, false),
            type: BOOL,
            loc,
          };
        }
        return out;
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `statically-decided '${pname} in …' on computed receivers (bind the value to a variable first)`,
      );
    }
  }
  if (recv.type.kind !== "object") {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' on '${lowerer.fmt(recv.type)}' receivers (only class-instance receivers — and unions of classes below or beside the declarer — have a static brand answer; narrow first)`,
    );
  }
  const lhsName = recv.type.className;
  const lhsInfo = lowerer.classes.get(lhsName);
  if (!lhsInfo) throw new InternalCompilerError(`lowerer bug: unknown class ${lhsName}`);
  if (lowerer.isSubclassOf(declName, lhsName)) {
    // The narrowing direction: the declarer strictly below the
    // receiver's static class — a strict subclass relation puts both in
    // a hierarchy, so the vtable interval test always exists.
    return { kind: "instanceOf", value: recv, className: declName, type: BOOL, loc };
  }
  const value = lhsName === declName || lowerer.isSubclassOf(lhsName, declName);
  if (recv.kind === "varRef") return { kind: "boolLit", value, type: BOOL, loc };
  lowerer.unsupported(
    "SC1090",
    expr,
    `statically-decided '${pname} in …' on computed operands (bind the value to a variable first)`,
  );
}

/** `"key" in v` — the key-presence test. Three lowered receivers:
 * process.env (getenv(3) presence — Node-exact, an empty value still
 * counts as present), and monomorphic record shapes, where the answer is
 * type-directed: a declared non-optional field is a compile-time `true`,
 * a missing field (no index signature) a compile-time `false` — both
 * folds limited to side-effect-free receivers, the lowerInstanceOf rule —
 * and an OPTIONAL field (undefined-armed union) is a runtime tag test on
 * the slot: present iff the arm is not undefined. That last case is the
 * representation's honest answer — a field explicitly assigned
 * `undefined` reads as absent (`"a" in {a: undefined}` is true in JS,
 * false here; SEMANTICS.md 55). Union receivers (the `in`-narrowing
 * idiom over multiple shapes), index-signature keys, class instances,
 * and dyn/unknown stay fenced. Keys are literal strings — a computed key
 * over a shape would need the runtime key table. */
function lowerInExpression(lowerer: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
  if (
    lowerer.isStdlibGlobal(expr.right, "process") &&
    lowerer.foldedStringKeyOf(expr.left) === "hrtime"
  ) {
    return { kind: "boolLit", value: true, type: BOOL, loc };
  }
  const globalKey = globalSymbolKey(lowerer, expr.right, expr.left);
  if (globalKey)
    return { kind: "libCall", fn: "dyn.globalSymbolHas", args: [globalKey], type: BOOL, loc };
  // `#name in obj` — the ergonomic brand check (ES2022) — resolves
  // before any string-key machinery: the left operand is a private
  // NAME, not a value.
  if (ts.isPrivateIdentifier(expr.left)) {
    return lowerPrivateIn(lowerer, expr, expr.left, loc);
  }
  // Compile-time-known STRING keys fold — literals, and the same
  // const/enum-literal and template folding computed property keys get
  // (foldedStringKeyOf); runtime-valued keys keep the fence.
  // NUMERIC literal keys answer on ARRAY receivers through the shared
  // presence query. Arrays retain holes independently from length, and
  // noncanonical numeric keys live in their ordinary-property table, so
  // a length comparison is not an honest `in` answer.
  {
    let kNode = expr.left;
    while (ts.isParenthesizedExpression(kNode)) kNode = kNode.expression;
    if (
      ts.isNumericLiteral(kNode) &&
      lowerer.mapTypeOf(lowerer.typeOf(expr.right))?.kind === "array"
    ) {
      const recvArr = lowerer.lowerExpr(expr.right);
      if (recvArr.type.kind === "array") {
        const n = Number(kNode.text);
        return {
          kind: "arrayHas",
          arr: recvArr,
          index: { kind: "numLit", value: n, type: F64, loc },
          type: BOOL,
          loc,
        };
      }
    }
  }
  const key = foldedStringKeyOf(lowerer, expr.left);
  if (key === null) {
    // A RUNTIME string key over an INDEX-SIGNATURE record receiver (the
    // `names.filter((k) => k in config)` idiom): the interned key-
    // presence helper — declared fields answer statically per name
    // (optional slots per value: the undefined arm reads absent, stance
    // 55), then the overflow map's live keys. Other receivers keep the
    // fence: fixed shapes want the literal folds above, and there is no
    // runtime key table to ask.
    const rIn = lowerRuntimeKeyIn(lowerer, expr, loc);
    if (rIn) return rIn;
    // A runtime key over a CHECKED-DYNAMIC receiver (`name in
    // agent.sockets` — both sides computed; the checker may type the
    // receiver as a Dict while the VALUE lives in the checked-dynamic tree, so the
    // LOWERED type decides): the dyn presence answer, with the key
    // stringified like every property key (o[k] is o[String(k)] in JS;
    // `in` shares the coercion).
    {
      const probed = tryLowerExpression(lowerer, expr.right);
      if (probed && lowerer.dynConvertible(probed.type)) {
        const k = lowerer.lowerExpr(expr.left); // JS order: the key evaluates first
        if (lowerer.dynConvertible(k.type)) {
          const boxed = lowerer.coerceToExpected(k, DYN);
          const keyLocal = lowerer.declareHiddenLocal("%inKey", DYN);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: keyLocal.id, init: boxed, loc }],
            result: {
              kind: "libCall",
              fn: "dyn.hasKeyComputed",
              args: [
                lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN),
                varRef(keyLocal.id, DYN, loc),
              ],
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          };
        }
      }
    }
    lowerer.unsupported(
      "SC1090",
      expr.left,
      "'in' with computed (non-literal) keys (a const whose type is one string literal folds; a string-typed key answers over index-signature record receivers)",
    );
  }
  // A receiver re-read (the static folds below) is safe for plain reads
  // AND for side-effect-free expressions (an object literal of literals
  // — the `"a" in { a: true }` shape).
  const pureRecvNode = sideEffectFreeOptionValue(expr.right);
  if (lowerer.isProcessEnv(expr.right)) {
    // `"NO_COLOR" in process.env`: presence via the one envGet intrinsic —
    // getenv(3) returning non-NULL is Node's `in` on process.env exactly.
    const envType = lowerer.envValueType();
    if (envType.kind !== "union")
      throw new InternalCompilerError("lowerer bug: env value type is not a union");
    const undefTag = lowerer.armTag(envType.unionId, UNDEFINED_T);
    const read: IrExpr = {
      kind: "libCall",
      fn: "process.envGet",
      args: [{ kind: "strLit", value: key, type: STRING, loc }],
      type: envType,
      loc,
    };
    return {
      kind: "unionIsTag",
      unionId: envType.unionId,
      tag: undefTag,
      negated: true,
      value: read,
      type: BOOL,
      loc,
    };
  }
  let recv = lowerer.lowerExpr(expr.right);
  const classInfo =
    recv.type.kind === "classval" ? lowerer.classes.get(recv.type.className) : undefined;
  if (
    (classInfo && (classInfo.callableBase || hasRuntimeStatics(classInfo))) ||
    (isJsSourceFile(expr.getSourceFile()) &&
      recv.type.kind === "func" &&
      lowerer.dynConvertible(recv.type))
  ) {
    recv = lowerer.coerceToExpected(recv, DYN);
  }
  const siteType = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
  if (
    recv.type.kind === "union" &&
    siteType?.kind === "union" &&
    !typeEquals(recv.type, siteType)
  ) {
    const helper = lowerer.narrowedRetagHelper(
      expr.right,
      recv.type.unionId,
      siteType.unionId,
      loc,
    );
    if (helper) recv = { kind: "call", callee: helper, args: [recv], type: siteType, loc };
  }
  // Error-rooted receivers (builtin or user subclass — the isErrnoException
  // predicate's `err instanceof Error && "code" in err` shape): `code`
  // answers from the runtime error's code slot (stamped by fs/system/
  // event/spawn errors, absent on plain constructions — exactly Node's
  // own-property answer), and the always-declared members fold true.
  // Everything else fences: the runtime object carries no other dynamic
  // properties to ask (`stack` would be a lie — Node has one, we don't).
  if (recv.type.kind === "object") {
    // %DOMException first: `'cause' in e` answers the options form's
    // own-property record (the runtime slot), and code/name/message are
    // always present.
    if (recv.type.className === "%DOMException") {
      if (key === "cause") {
        return { kind: "libCall", fn: "error.domHasCause", args: [recv], type: BOOL, loc };
      }
      if (
        (key === "code" || key === "message" || key === "name") &&
        (recv.kind === "varRef" || recv.kind === "caughtNarrow")
      ) {
        return { kind: "boolLit", value: true, type: BOOL, loc };
      }
    }
    let info = lowerer.classes.get(recv.type.className) ?? null;
    while (info && info.base) info = info.base;
    if (info?.def.name === "%Error") {
      if (key === "cause") {
        return { kind: "libCall", fn: "error.hasCause", args: [recv], type: BOOL, loc };
      }
      if (key === "code") {
        const codeType = lowerer.envValueType();
        if (codeType.kind !== "union")
          throw new InternalCompilerError("lowerer bug: error code type is not a union");
        const undefTag = lowerer.armTag(codeType.unionId, UNDEFINED_T);
        const read: IrExpr = {
          kind: "libCall",
          fn: "error.code",
          args: [recv],
          type: codeType,
          loc,
        };
        return {
          kind: "unionIsTag",
          unionId: codeType.unionId,
          tag: undefTag,
          negated: true,
          value: read,
          type: BOOL,
          loc,
        };
      }
      if (
        (key === "message" || key === "name") &&
        (recv.kind === "varRef" || recv.kind === "caughtNarrow")
      ) {
        return { kind: "boolLit", value: true, type: BOOL, loc };
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `'in' with the key '${key}' on Error receivers (code answers from the error's code slot; message and name are always present)`,
      );
    }
  }
  // A dyn receiver (`"portless" in pkg` after the `typeof pkg ===
  // "object"` guard): own-member presence on the checked-dynamic tree — tsc admits `in`
  // only on object-typed operands, so unit receivers are unreachable.
  if (recv.type.kind === "dyn") {
    return { kind: "dynHasKey", key, value: recv, type: BOOL, loc };
  }
  // `"k" in u` over a UNION whose arms are FIXED record shapes: every
  // arm answers membership STATICALLY (a declared non-optional field is
  // always present, an undeclared name never is), so the whole test
  // collapses to runtime TAG tests — tsc's own narrowing then types the
  // branches (the discriminating-`in` idiom). Optional (undefined-armed)
  // fields and tuple/index-signature arms answer per VALUE, not per arm
  // — those unions keep the fence below.
  if (recv.type.kind === "union") {
    const unionId = recv.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms ?? [];
    const answers: { tag: number; has: boolean }[] = [];
    let staticAnswers = arms.length > 0;
    for (const arm of arms) {
      const tag = lowerer.armTag(unionId, arm);
      const shape = arm.kind === "record" ? lowerer.shapes.get(arm.shapeId) : undefined;
      if (tag < 0 || !shape || shape.tuple || shape.indexValue) {
        staticAnswers = false;
        break;
      }
      const f = shape.fields.find((x) => x.name === key);
      if (f && f.type.kind === "union" && lowerer.armTag(f.type.unionId, UNDEFINED_T) >= 0) {
        staticAnswers = false; // an optional slot: presence is per-value
        break;
      }
      // Accessor properties are own properties to `in` (Node answers
      // true without invoking the getter) — either slot present makes
      // the name a member.
      const acc = shape.fields.some((x) => x.name === `%get:${key}` || x.name === `%set:${key}`);
      answers.push({ tag, has: f !== undefined || acc });
    }
    if (staticAnswers) {
      const pureRecv =
        recv.kind === "varRef" ||
        recv.kind === "recordGet" ||
        recv.kind === "fieldGet" ||
        pureRecvNode;
      const isTag = (tag: number, negated: boolean): IrExpr => ({
        kind: "unionIsTag",
        unionId,
        tag,
        negated,
        value: recv,
        type: BOOL,
        loc,
      });
      const trues = answers.filter((a) => a.has);
      if (trues.length === answers.length || trues.length === 0) {
        // Constant either way — but JS still EVALUATES the operand (it
        // may throw: an ambient-const read is a ReferenceError). Pure
        // reads fold; anything else rides one tag test whose branches
        // agree, evaluating the receiver exactly once.
        const ans = trues.length !== 0;
        if (pureRecv) return { kind: "boolLit", value: ans, type: BOOL, loc };
        return {
          kind: "ternary",
          cond: isTag(answers[0]!.tag, false),
          then: { kind: "boolLit", value: ans, type: BOOL, loc },
          else_: { kind: "boolLit", value: ans, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      // One deciding arm (either polarity): a single tag test, receiver
      // evaluated once — no purity requirement.
      if (trues.length === 1) return isTag(trues[0]!.tag, false);
      const falses = answers.filter((a) => !a.has);
      if (falses.length === 1) return isTag(falses[0]!.tag, true);
      // Several arms on each side: the OR chain re-reads the receiver,
      // so only side-effect-free reads qualify.
      if (pureRecv) {
        let out: IrExpr = isTag(trues[0]!.tag, false);
        for (const t of trues.slice(1)) {
          out = {
            kind: "logical",
            op: "||",
            left: out,
            right: isTag(t.tag, false),
            type: BOOL,
            loc,
          };
        }
        return out;
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "statically-decided 'in' on computed receivers (bind the value to a variable first)",
      );
    }
  }
  if (recv.type.kind !== "record") {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'in' on '${lowerer.fmt(recv.type)}' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; ${NARROW_FIRST})`,
    );
  }
  const shape = lowerer.shapes.get(recv.type.shapeId);
  if (!shape) throw new InternalCompilerError(`lowerer bug: unknown shape ${recv.type.shapeId}`);
  const field = shape.fields.find((f) => f.name === key);
  if (field) {
    if (field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0) {
      // Optional slot: the key is present iff the arm is not undefined.
      const read: IrExpr = {
        kind: "recordGet",
        obj: recv,
        shapeId: recv.type.shapeId,
        field: key,
        type: field.type,
        loc,
      };
      return {
        kind: "unionIsTag",
        unionId: field.type.unionId,
        tag: lowerer.armTag(field.type.unionId, UNDEFINED_T),
        negated: true,
        value: read,
        type: BOOL,
        loc,
      };
    }
    // A declared non-optional field always exists on every value of the
    // shape — statically true, but folding may only drop a
    // side-effect-free receiver read.
    if (
      recv.kind === "varRef" ||
      recv.kind === "recordGet" ||
      recv.kind === "fieldGet" ||
      pureRecvNode
    ) {
      return { kind: "boolLit", value: true, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "statically-decided 'in' on computed receivers (bind the value to a variable first)",
    );
  }
  // Accessor properties answer `in` as own members (Node: true, getter
  // NOT invoked) — statically true under the same purity discipline as
  // declared non-optional fields.
  if (shape.fields.some((f) => f.name === `%get:${key}` || f.name === `%set:${key}`)) {
    if (
      recv.kind === "varRef" ||
      recv.kind === "recordGet" ||
      recv.kind === "fieldGet" ||
      pureRecvNode
    ) {
      return { kind: "boolLit", value: true, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "statically-decided 'in' on computed receivers (bind the value to a variable first)",
    );
  }
  if (shape.indexValue) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "'in' over index-signature keys (read the key and test '!== undefined' instead)",
    );
  }
  if (
    recv.kind === "varRef" ||
    recv.kind === "recordGet" ||
    recv.kind === "fieldGet" ||
    pureRecvNode
  ) {
    return { kind: "boolLit", value: false, type: BOOL, loc };
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "statically-decided 'in' on computed receivers (bind the value to a variable first)",
  );
}

/** The runtime-key `in` (see lowerInExpression): `k in r` where k is a
 * runtime string and r an index-signature record — an interned
 * `%rec.haskey.<n>(k, r)` walks the declared names (a string-equality
 * chain: non-optional fields and accessor slots answer true, optional
 * slots answer their per-value tag test) and then the overflow map's
 * live keys. Null when the pair is outside that shape (the caller keeps
 * its fence). */
function lowerRuntimeKeyIn(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(expr.left))?.kind !== "string") return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
  if (recvT?.kind !== "record") return null;
  const shape = lowerer.shapes.get(recvT.shapeId);
  if (!shape?.indexValue || shape.tuple) return null;
  const keyIr = lowerer.lowerExprExpecting(expr.left, STRING);
  const recv = lowerer.lowerExprExpecting(expr.right, recvT);
  const hkey = `haskey:${recvT.shapeId}`;
  let helper = lowerer.valueHelpers.get(hkey);
  if (!helper) {
    helper = `%rec.haskey.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(hkey, helper);
    const recT: IrType = { kind: "record", shapeId: recvT.shapeId };

    const k = varRef("k.0", STRING, loc);
    const r = varRef("r.0", recT, loc);
    const body: IrStmt[] = [];
    const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
    for (const f of shape.fields) {
      const accessor = f.name.startsWith("%get:") || f.name.startsWith("%set:");
      if (f.name.startsWith("%") && !accessor) continue;
      const name = accessor ? f.name.slice(5) : f.name;
      const eq: IrExpr = {
        kind: "strEq",
        negated: false,
        left: k,
        right: { kind: "strLit", value: name, type: STRING, loc },
        type: BOOL,
        loc,
      };
      const utag =
        !accessor && f.type.kind === "union" ? lowerer.armTag(f.type.unionId, UNDEFINED_T) : -1;
      const answer: IrExpr =
        utag >= 0 && f.type.kind === "union"
          ? {
              kind: "unionIsTag",
              unionId: f.type.unionId,
              tag: utag,
              negated: true,
              value: {
                kind: "recordGet",
                obj: r,
                shapeId: recvT.shapeId,
                field: f.name,
                type: f.type,
                loc,
              },
              type: BOOL,
              loc,
            }
          : { kind: "boolLit", value: true, type: BOOL, loc };
      body.push({ kind: "if", cond: eq, then: [ret(answer)], else_: null, loc });
    }
    const ksT = arrayOf(STRING);
    body.push(
      {
        kind: "varDecl",
        localId: "ks.0",
        init: { kind: "recordOvfKeys", obj: r, shapeId: recvT.shapeId, type: ksT, loc },
        loc,
      },
      countedFor(
        loc,
        {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("ks.0", ksT, loc),
          args: [],
          type: F64,
          loc,
        },
        () => [
          {
            kind: "if",
            cond: {
              kind: "strEq",
              negated: false,
              left: k,
              right: {
                kind: "arrayGet",
                arr: varRef("ks.0", ksT, loc),
                index: varRef("i.0", F64, loc),
                type: STRING,
                loc,
              },
              type: BOOL,
              loc,
            },
            then: [ret({ kind: "boolLit", value: true, type: BOOL, loc })],
            else_: null,
            loc,
          },
        ],
      ),
      ret({ kind: "boolLit", value: false, type: BOOL, loc }),
    );
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "k.0", name: "k", type: STRING },
        { localId: "r.0", name: "r", type: recT },
      ],
      returnType: BOOL,
      locals: [
        { id: "k.0", name: "k", type: STRING, mutable: true },
        { id: "r.0", name: "r", type: recT, mutable: true },
        { id: "ks.0", name: "ks", type: ksT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [keyIr, recv], type: BOOL, loc };
}

/** A regex literal `/ab+c/gi` → regexLit (fresh state per evaluation,
 * shared bytecode per (pattern, flags) pair). The TS parser has already syntax-checked the literal;
 * what remains here is the flag-alphabet fence (d and v are
 * declared-valid TS flags outside this slice). Named capture groups
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
  const flags = text.slice(lastSlash + 1);
  for (const f of flags) {
    if (!"gimsuy".includes(f)) {
      lowerer.unsupported(
        "SC1120",
        expr,
        f === "d"
          ? "the regex 'd' flag (match indices)"
          : f === "v"
            ? "the regex 'v' flag (unicode sets)"
            : `the regex '${f}' flag`,
      );
    }
  }
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
function namedCaptureGroupsOfPattern(pattern: string): { name: string; index: number }[] | null {
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
function staticRegexPatternOf(lowerer: Lowerer, e: ts.Expression): string | null {
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
    expr.arguments.length >= 1 &&
    (ts.isStringLiteral(expr.arguments[0]!) ||
      ts.isNoSubstitutionTemplateLiteral(expr.arguments[0]!))
  ) {
    return (expr.arguments[0] as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
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
function constInitializerOf(lowerer: Lowerer, ident: ts.Identifier): ts.Expression | null {
  const sym = lowerer.resolveValueSymbol(ident);
  const decl = sym ? lowerer.checker.valueDeclarationOf(sym) : undefined;
  if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined)
    return null;
  if (!ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0)
    return null;
  return decl.initializer;
}

/** The named-group table of the regex that PRODUCED a match-result
 * expression — the `.groups` desugar's provenance question. Traces
 * (through parens, `!`, and const bindings):
 *   - `re.exec(s)` / `s.match(re)`   → re's static pattern
 *   - a matchAll ROW: `rows[i]`, the for-of binding over a direct
 *     `s.matchAll(re)` or a stored const drain → re's static pattern
 * Answers null when the producing regex isn't statically known (the
 * caller keeps its fence), or the groups list (possibly empty — a
 * traced regex WITHOUT named groups is the Node-undefined case). */
export function matchResultNamedGroupsOf(
  lowerer: Lowerer,
  e: ts.Expression,
): { name: string; index: number }[] | null {
  let producer = e;
  while (ts.isParenthesizedExpression(producer) || ts.isNonNullExpression(producer))
    producer = producer.expression;
  if (ts.isIdentifier(producer)) {
    const init = constInitializerOf(lowerer, producer);
    if (init !== null) return matchResultNamedGroupsOf(lowerer, init);
  }
  const reExpr = matchProducerRegexOf(lowerer, e);
  if (reExpr === null) return null;
  if (
    ts.isCallExpression(producer) &&
    ts.isPropertyAccessExpression(producer.expression) &&
    producer.expression.name.text === "match"
  ) {
    const flags = staticRegexFlagsOf(lowerer, reExpr);
    if (flags === null) return null;
    // Global String.match returns whole matches without a groups
    // property, even when the pattern contains named captures.
    if (flags.includes("g")) return [];
  }
  const pattern = staticRegexPatternOf(lowerer, reExpr);
  if (pattern === null) return null;
  return namedCaptureGroupsOfPattern(pattern);
}

function staticRegexFlagsOf(lowerer: Lowerer, node: ts.Expression): string | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  if (ts.isRegularExpressionLiteral(expr)) return expr.text.slice(expr.text.lastIndexOf("/") + 1);
  if (ts.isIdentifier(expr)) {
    const init = constInitializerOf(lowerer, expr);
    return init !== null ? staticRegexFlagsOf(lowerer, init) : null;
  }
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    lowerer.isStdlibGlobal(expr.expression, "RegExp")
  ) {
    const flags = expr.arguments?.[1];
    if (!flags) return "";
    if (ts.isStringLiteral(flags) || ts.isNoSubstitutionTemplateLiteral(flags)) return flags.text;
  }
  return null;
}

/** The regex EXPRESSION whose match produced `e` (see
 * matchResultNamedGroupsOf for the traced shapes). */
function matchProducerRegexOf(lowerer: Lowerer, e: ts.Expression): ts.Expression | null {
  let expr = e;
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    break;
  }
  // The direct producers: re.exec(s) / s.match(re) — the receiver's
  // mapped type pins the STDLIB operation (a regex for exec, a string
  // or its nullable spelling for match — the claim string-and-regexp
  // makes), so a user method that happens to be named `match` with a
  // regex argument never traces.
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const name = expr.expression.name.text;
    const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression));
    if (name === "exec" && expr.arguments.length === 1 && recvT?.kind === "regex") {
      return expr.expression.expression;
    }
    if (
      name === "match" &&
      expr.arguments.length === 1 &&
      (recvT?.kind === "string" ||
        (recvT !== null && recvT !== undefined && nullableStringType(lowerer, recvT))) &&
      lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[0]!))?.kind === "regex"
    ) {
      return expr.arguments[0]!;
    }
  }
  // A matchAll ROW by element access: rows[i] with rows tracing to the
  // drain call — or the direct s.matchAll(re)[i] spelling.
  if (ts.isElementAccessExpression(expr)) {
    return matchAllRegexOf(lowerer, expr.expression);
  }
  if (ts.isIdentifier(expr)) {
    // The for-of binding over a matchAll drain: `for (const m of
    // s.matchAll(re))` (or over a stored const rows).
    const sym = lowerer.resolveValueSymbol(expr);
    const decl = sym ? lowerer.checker.valueDeclarationOf(sym) : undefined;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      ts.isVariableDeclarationList(decl.parent) &&
      ts.isForOfStatement(decl.parent.parent)
    ) {
      return matchAllRegexOf(lowerer, decl.parent.parent.expression);
    }
    // A stored const match result: `const m = re.exec(s)`.
    const init = constInitializerOf(lowerer, expr);
    if (init !== null) return matchProducerRegexOf(lowerer, init);
  }
  return null;
}

/** The regex argument of a (possibly const-stored) `s.matchAll(re)`. */
function matchAllRegexOf(lowerer: Lowerer, e: ts.Expression): ts.Expression | null {
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
    expr.arguments.length === 1 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression))?.kind === "string" &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[0]!))?.kind === "regex"
  ) {
    return expr.arguments[0]!;
  }
  // The eager-spread spelling: `[...s.matchAll(re)]`.
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 1) {
    const only = expr.elements[0]!;
    if (ts.isSpreadElement(only)) return matchAllRegexOf(lowerer, only.expression);
  }
  if (ts.isIdentifier(expr)) {
    const init = constInitializerOf(lowerer, expr);
    if (init !== null) return matchAllRegexOf(lowerer, init);
  }
  return null;
}

/** `m.groups` on a match result whose producing regex is statically
 * known: the honest slice already HOLDS every named group's value at
 * its capture index, so the groups object is a compile-time record
 * projection — `{ year: m[1], month: m[2] }` — built by one interned
 * helper per (shape, index list, receiver type). Node's exact shape
 * decisions:
 *   - no named groups → `undefined` (the identifier-receiver shapes —
 *     a call receiver would lose its own null trap, so those keep the
 *     member fence);
 *   - a nullable receiver (the JS `s.match(re).groups` idiom) throws
 *     Node's exact TypeError on the unit arms;
 *   - every declared name is a key (nonparticipating groups hold undefined,
 *     exactly the slice elements they project);
 *   - ES2025 duplicate names (distinct alternatives) project the first
 *     participating occurrence, including a participating empty string;
 *   - key order is group declaration order (declaredOrder), Node's own.
 * The record has no prototype — Node's groups object is null-prototype,
 * observable only through util.inspect's "[Object: null prototype]"
 * prefix (the Object.groupBy stance, ledgered). Null when the receiver
 * isn't a match slice or the regex isn't traceable — the caller's
 * member fence (with the groups hint) names the gap. */
function lowerMatchGroupsRead(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.name.text !== "groups" || expr.questionDotToken !== undefined) return null;
  const loc = locOf(expr);
  const strArr = arrayOf(STRING);
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (!recvT || !isMatchSliceType(lowerer, recvT) || !lowerer.isStdlibMember(expr)) return null;
  const groups = matchResultNamedGroupsOf(lowerer, expr.expression);
  if (groups === null) return null;
  if (groups.length === 0) {
    // Node: a match result of a group-less regex answers undefined —
    // the unit literal, exactly the `undefined` identifier's lowering.
    // Identifier receivers only (evaluation-free): a CALL receiver's
    // exec/match must still run and null-trap, which a folded unit
    // cannot carry — those keep the fence.
    let r: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r)) r = r.expression;
    if (ts.isIdentifier(r) && typeEquals(recvT, strArr)) {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
    }
    return null;
  }
  const recv = lowerer.lowerExpr(expr.expression);
  if (!isMatchSliceType(lowerer, recv.type)) return null;
  return lowerGroupsProjection(lowerer, recv, groups, loc);
}

/** True when the IR type is a string-or-units union — the Dict<string>
 * member spelling (`process.versions.openssl`), match's nullable
 * receiver claim. */
function nullableStringType(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "union") return false;
  const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
  return (
    arms.some((a) => a.kind === "string") && arms.every((a) => a.kind === "string" || isUnitType(a))
  );
}

/** True when the IR type is the honest match slice — `string[]`, or a
 * union of it with unit arms only (`string[] | null`). The groups
 * projection's receiver gate, shared with the destructure interception. */
export function isMatchSliceType(lowerer: Lowerer, t: IrType): boolean {
  if (typeEquals(t, arrayOf(STRING))) return true;
  return t.kind === "union" && matchSliceUnionArms(lowerer, t.unionId) !== null;
}

/** The union-arm layout of a nullable match slice (`string[] | null`,
 * matchAll's checker spellings with undefined arms included): the
 * string[] arm's tag plus each unit arm's tag and spelling. Null when
 * the union holds anything else. */
function matchSliceUnionArms(
  lowerer: Lowerer,
  unionId: string,
): { arrTag: number; units: { tag: number; unit: "null" | "undefined" }[] } | null {
  const def = lowerer.unions.get(unionId);
  if (!def) return null;
  const strArr = arrayOf(STRING);
  const arrTag = def.arms.findIndex((a) => typeEquals(a, strArr));
  if (arrTag < 0) return null;
  const units: { tag: number; unit: "null" | "undefined" }[] = [];
  for (let i = 0; i < def.arms.length; i++) {
    if (i === arrTag) continue;
    const a = def.arms[i]!;
    if (!isUnitType(a)) return null;
    units.push({ tag: i, unit: a.kind === "nullT" ? "null" : "undefined" });
  }
  return { arrTag, units };
}

/** The groups-record projection holds string | undefined values, including
 * an own overflow entry for every nonparticipating capture. One lifted helper per
 * (index list, receiver representation) builds it; see
 * lowerMatchGroupsRead for the semantics the body encodes. */
export function lowerGroupsProjection(
  lowerer: Lowerer,
  recv: IrExpr,
  groups: { name: string; index: number }[],
  loc: SrcLoc,
): IrExpr {
  // Name → its capture indices, in declaration order (duplicates keep
  // every occurrence — the projection picks the participating one).
  const order: string[] = [];
  const indicesByName = new Map<string, number[]>();
  for (const g of groups) {
    const got = indicesByName.get(g.name);
    if (got) {
      got.push(g.index);
    } else {
      indicesByName.set(g.name, [g.index]);
      order.push(g.name);
    }
  }
  const valueType = arrayValueType(lowerer, STRING);
  const shapeId = lowerer.shapes.intern([], false, valueType);
  const recordT: IrType = { kind: "record", shapeId };
  const recvKey = recv.type.kind === "union" ? recv.type.unionId : "arr";
  const key = `regexgroups:${shapeId}:${groups.map((g) => `${g.name}=${g.index}`).join(",")}:${recvKey}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = `%regex.groups.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, helper);
    const body: IrStmt[] = [];
    const locals: IrLocal[] = [{ id: "m.0", name: "m", type: recv.type, mutable: true }];
    let mRef: IrExpr = { kind: "varRef", localId: "m.0", type: recv.type, loc };
    if (recv.type.kind === "union") {
      // Node's exact TypeError per unit arm, then the checked narrow.
      const arms = matchSliceUnionArms(lowerer, recv.type.unionId)!;
      for (const u of arms.units) {
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: recv.type.unionId,
            tag: u.tag,
            negated: false,
            value: mRef,
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "throw",
              value: {
                kind: "libCall",
                fn: "error.new",
                args: [
                  {
                    kind: "strLit",
                    value: `Cannot read properties of ${u.unit} (reading 'groups')`,
                    type: STRING,
                    loc,
                  },
                ],
                type: { kind: "object", className: "%TypeError" },
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        });
      }
      const narrowed: IrExpr = {
        kind: "unionNarrow",
        unionId: recv.type.unionId,
        tag: arms.arrTag,
        value: mRef,
        type: arrayOf(STRING),
        loc,
      };
      locals.push({ id: "arr.0", name: "arr", type: arrayOf(STRING), mutable: false });
      body.push({ kind: "varDecl", localId: "arr.0", init: narrowed, loc });
      mRef = { kind: "varRef", localId: "arr.0", type: arrayOf(STRING), loc };
    }

    const elem = (index: number): IrExpr =>
      arrayValueRead(lowerer, mRef, numLit(index, loc), STRING, loc);
    const values = new Map<string, IrExpr>();
    order.forEach((name, i) => {
      const idxs = indicesByName.get(name)!;
      if (idxs.length === 1) {
        values.set(name, elem(idxs[0]!));
        return;
      }
      // Duplicates: the first participating occurrence. Empty strings
      // participate; undefined means this alternative did not match.
      const id = `g${i}.0`;
      locals.push({ id, name: `g${i}`, type: valueType, mutable: true });
      body.push({ kind: "varDecl", localId: id, init: elem(idxs[0]!), loc });
      const gRef: IrExpr = { kind: "varRef", localId: id, type: valueType, loc };
      for (const idx of idxs.slice(1)) {
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: valueType.kind === "union" ? valueType.unionId : "",
            tag: valueType.kind === "union" ? lowerer.armTag(valueType.unionId, UNDEFINED_T) : -1,
            negated: false,
            value: gRef,
            type: BOOL,
            loc,
          },
          then: [{ kind: "assign", localId: id, value: elem(idx), loc }],
          else_: null,
          loc,
        });
      }
      values.set(name, gRef);
    });
    body.push({
      kind: "return",
      value: {
        kind: "recordLit",
        fields: order.map((name) => ({ name, value: values.get(name)!, overflow: true as const })),
        type: recordT,
        loc,
      },
      loc,
    });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "m.0", name: "m", type: recv.type }],
      returnType: recordT,
      locals,
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [recv], type: recordT, loc };
}

/** Field reads use the shared FieldTarget union. Native method reads select
 * an interned unbound callable; invocation supplies its receiver separately. */
export function lowerFieldRead(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  // A checked receiver already owns its property table. An ambient
  // generic method signature must not divert its value into native
  // object-literal specialization (Array.prototype.map is one example).
  if (ts.isIdentifier(expr.expression)) {
    const stored = lowerer.peekLocal(expr.expression) ?? lowerer.globalOf(expr.expression);
    if (stored?.type.kind === "dyn") {
      const value = lowerer.lowerExpr(expr.expression);
      if (value.type.kind === "dyn")
        return {
          kind: "dynKeyGet",
          value,
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
          ...(expr.questionDotToken || hasOptionalChainGuard(expr.expression)
            ? { optional: true as const }
            : {}),
          type: DYN,
          loc: locOf(expr),
        };
    }
  }
  const target = lowerer.fieldTarget(expr);
  if (target) return lowerer.fieldGetExpr(target, locOf(expr), expr);
  if (expr.questionDotToken) return null;
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  // The readonly-tuple Array.isArray narrow has no directly mappable
  // checker type (`Result & any[]`), but maybeNarrow extracted the tuple
  // record behind it. Route tuple properties such as `.length` from that
  // lowered value, the element-access bridge's twin.
  const checkerArray = lowerer.checkerArrayValue(expr.expression);
  if (checkerArray?.type.kind === "record") receiverIr = checkerArray.type;
  if (
    receiverIr?.kind === "object" &&
    (lowerer.findMethodOn(lowerer.classes.get(receiverIr.className) ?? null, expr.name.text) ||
      findGenericMethodOn(
        lowerer,
        lowerer.classes.get(receiverIr.className) ?? null,
        expr.name.text,
      ))
  ) {
    const info = lowerer.classes.get(receiverIr.className);
    if (info) return lowerClassMethodValue(lowerer, expr, info);
  }
  // An object-literal GENERIC method as a VALUE (`o.m` — the member is
  // excluded from the record shape): the pinned-value rule verbatim when
  // the receiver is the defining literal's own const binding (the value
  // is the pinned instance's closure — no `this` exists); anything else
  // fences by name inside the helpers.
  {
    const propSym = lowerer.checker.getPropertyOfType(
      lowerer.typeOf(expr.expression),
      expr.name.text,
    );
    if (
      receiverIr?.kind !== "object" &&
      propSym &&
      isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(propSym), lowerer.checker) &&
      // CLASS members keep the class-path fences (a poisoned class's own
      // diagnostics, the bound-method fence above).
      !lowerer.checker
        .declarationsOf(propSym)
        .some(
          (d) =>
            d.parent !== undefined &&
            (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)),
        )
    ) {
      const found = objLitGenericFnNodeOf(lowerer, propSym);
      if (!found) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `the generic method '${expr.name.text}' as a value with no defining object literal (only methods declared with a body in an object literal compile)`,
        );
      }
      requireObjLitGenericReceiver(lowerer, expr, expr.expression, found.literal, expr.name.text);
      return lowerer.lowerGenericFnValue(
        expr,
        objLitGenericFnInfoOf(lowerer, expr, expr.name.text, found),
      );
    }
  }
  // Dot access to an UNDECLARED key of an index-signature shape
  // (`bag.count` on `Record<string, number>`): tsc allows it without
  // noPropertyAccessFromIndexSignature, but the bracket spelling is the
  // canonical index-signature form here — point at it.
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    if (shape?.indexValue && !shape.fields.some((f) => f.name === expr.name.text)) {
      const actual = tryLowerExpression(lowerer, expr.expression);
      if (actual?.type.kind === "dyn")
        return {
          kind: "dynKeyGet",
          value: actual,
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
          type: DYN,
          loc: locOf(expr),
        };
      if (actual?.type.kind === "record") {
        const field = lowerer.shapes
          .get(actual.type.shapeId)
          ?.fields.find((field) => field.name === expr.name.text);
        if (field)
          return {
            kind: "recordGet",
            obj: actual,
            shapeId: actual.type.shapeId,
            field: field.name,
            type: field.type,
            loc: locOf(expr),
          };
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `dot access to index-signature keys (spell it r["${expr.name.text}"] — brackets are the index-signature form)`,
      );
    }
  }
  // `t.length` on a tuple: the arity CONSTANT (tuples are fixed-shape —
  // the checker types it as the literal arity too). Folding discards the
  // receiver's evaluation, so only side-effect-free receivers fold;
  // anything else (a call result) binds to a const first.
  if (receiverIr?.kind === "record" && expr.name.text === "length") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    if (shape?.tuple) {
      let root: ts.Expression = expr.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (!ts.isIdentifier(root) && root.kind !== ts.SyntaxKind.ThisKeyword) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "'.length' of a computed tuple expression (the arity is a constant — bind the tuple to a const first)",
        );
      }
      return { kind: "numLit", value: shape.fields.length, type: F64, loc: locOf(expr) };
    }
  }
  return null;
}

/** Shared-field read `r.f` on a UNION receiver: supported exactly when
 * every arm is a record/class possessing the field with ONE shared IR
 * type — the discriminant pattern (`r.kind`, primitive) and the
 * shared-payload pattern (`spec.config` where every ServiceSpec arm
 * carries the same record). Lowers to `unionDisc` (the backend switches
 * on the runtime tag and reads the field from the concrete arm), which
 * composes with existing strEq/bin/switch nodes, so `r.kind === "ok"`
 * and `switch (r.kind)` work without dedicated test nodes. Anything else
 * on a union receiver is rejected specifically (narrow first). */
export function lowerUnionProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(expr)) return null;
  const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (receiverIr?.kind !== "union") return null;
  // Lower the receiver first: its runtime value can still carry the full
  // binding union even when the checker has removed several variants.
  let value = lowerer.lowerExpr(expr.expression);
  // A guard can remove several variants without selecting one record.
  // Materialize that sub-union before looking for common fields; arms
  // ruled out by the guard must not veto a field shared by the survivors.
  if (value.type.kind === "union" && !typeEquals(value.type, receiverIr)) {
    const helper = lowerer.narrowedRetagHelper(
      expr.expression,
      value.type.unionId,
      receiverIr.unionId,
      locOf(expr),
    );
    if (helper)
      value = { kind: "call", callee: helper, args: [value], type: receiverIr, loc: locOf(expr) };
  }
  // A checker-union receiver whose VALUE lowered to a plain RECORD (the
  // merged-signature fiction — `runner(cmd, args)` where runner joined
  // a structural runner type with spawnSync's, and the local adopted
  // the record arm): read the record field directly, the dyn-receiver
  // fallback's discipline.
  // A checker-union receiver whose VALUE lowered checked-dynamic (a
  // never-tainted JS chain — `cmd[1].length` on `const cmd = ['pwd',
  // []]`, where the element read stayed a dyn node): read through the
  // dyn keyed read like the unmappable-receiver path below the chain.
  if (value.type.kind === "dyn") {
    const key: IrExpr = {
      kind: "strLit",
      value: expr.name.text,
      type: STRING,
      loc: locOf(expr.name),
    };
    return { kind: "dynKeyGet", key, value, type: DYN, loc: locOf(expr) };
  }
  if (value.type.kind === "record") {
    const shape = lowerer.shapes.get(value.type.shapeId);
    const f = shape?.fields.find((x) => x.name === expr.name.text);
    if (f) {
      return {
        kind: "recordGet",
        obj: value,
        shapeId: value.type.shapeId,
        field: f.name,
        type: f.type,
        loc: locOf(expr),
      };
    }
    return null;
  }
  if (value.type.kind !== "union") {
    lowerer.unsupported(
      "SC1090",
      expr,
      "shared property access without a represented union receiver",
    );
  }
  const def = lowerer.unions.get(value.type.unionId);
  if (!def) throw new InternalCompilerError(`lowerer bug: unknown union ${value.type.unionId}`);
  const field = expr.name.text;
  if (field === "length") {
    const presentArms = def.arms.filter((arm) => !isUnitType(arm));
    const present = presentArms.length === 1 ? presentArms[0]! : null;
    if (present?.kind === "string" || present?.kind === "array") {
      const receiver = lowerer.runtimeOptionalPropertyReceiver(
        expr.expression,
        value,
        present,
        field,
      );
      if (receiver !== null) {
        return present.kind === "string"
          ? {
              kind: "strIntrinsic",
              method: "length",
              receiver,
              args: [],
              type: F64,
              loc: locOf(expr),
            }
          : {
              kind: "arrIntrinsic",
              method: "length",
              receiver,
              args: [],
              type: F64,
              loc: locOf(expr),
            };
      }
    }
  }
  const nonUnitArms = def.arms.filter((arm) => !isUnitType(arm));
  if (nonUnitArms.length === 1 && nonUnitArms[0]?.kind === "object") {
    const objectType = nonUnitArms[0];
    const fieldType = lowerer.classes.get(objectType.className)?.fields.get(field);
    if (fieldType !== undefined) {
      let receiver = lowerer.runtimeOptionalPropertyReceiver(
        expr.expression,
        value,
        objectType,
        field,
      );
      if (receiver === null) {
        const helper = lowerer.narrowedArmHelper(
          value.type.unionId,
          objectType,
          locOf(expr.expression),
        );
        if (helper !== null)
          receiver = {
            kind: "call",
            callee: helper,
            args: [value],
            type: objectType,
            loc: locOf(expr.expression),
          };
      }
      if (receiver !== null) {
        return {
          kind: "fieldGet",
          obj: receiver,
          className: objectType.className,
          field,
          type: fieldType,
          loc: locOf(expr),
        };
      }
    }
  }
  let common: IrType | null = null;
  for (const arm of def.arms) {
    let ft: IrType | undefined;
    if (arm.kind === "record") {
      ft = lowerer.shapes.get(arm.shapeId)?.fields.find((f) => f.name === field)?.type;
    } else if (arm.kind === "object") {
      ft = lowerer.classes.get(arm.className)?.fields.get(field);
    }
    if (!ft || ft.kind === "void" || isUnitType(ft) || (common && !typeEquals(common, ft))) {
      common = null;
      break;
    }
    common = ft;
  }
  if (common) {
    return {
      kind: "unionDisc",
      unionId: value.type.unionId,
      field,
      value,
      type: common,
      loc: locOf(expr),
    };
  }
  // The arms answer DIFFERENT types (or through index signatures / unit
  // arms): the JOIN path — `env.PORTLESS_PORT` on `ProcessEnv |
  // Record<string, string>`, the tail read of `loaded?.config.script`.
  const key: IrExpr = { kind: "strLit", value: field, type: STRING, loc: locOf(expr.name) };
  const keyed = lowerUnionKeyedRead(lowerer, expr, value.type.unionId, value, key, field);
  if (keyed) return keyed;
  // JavaScript overloads commonly inspect a class brand on a scalar-or-
  // instance argument (e.g. Matrix4.makeTranslation). Preserve primitive
  // missing-property semantics and dispatch class data through its native
  // capsule instead of demanding a field shared by every union arm.
  if (isJsSourceFile(expr.getSourceFile()) && lowerer.dynConvertible(value.type)) {
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(value, DYN),
      key,
      ...(hasOptionalChainGuard(expr.expression) ? { optional: true as const } : {}),
      type: DYN,
      loc: locOf(expr),
    };
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    `reading '${field}' on a union-typed value (every arm must be an object/record ` +
      `with a same-typed field '${field}'; ` +
      `${NARROW_FIRST})`,
  );
}

/** The unionDisc generalization: a keyed read on a union receiver whose
 * arms answer DIFFERENT (but joinable) types. Each arm contributes its
 * declared answer — an array element's type (number keys), a declared field's type (literal keys), an
 * index-signature arm's value type (plus its declared fields' types for
 * runtime keys, which reach them through the keyed-read helper), and
 * UNDEFINED for unit arms (reachable only through optional-chain tails,
 * where JS short-circuits to undefined; a unit arm the checker narrowed
 * away is simply unreachable). The result type is the JOIN of those
 * answers; every arm's answer must be the join itself, one of its
 * arms, or a sub-union whose payload representations are unchanged.
 * Array reads retain the ordinary invalid-index trap policy.
 * Returns null when any arm cannot answer — the caller owns the fence
 * message. The caller (the property/element dispatch) maybeNarrows. */
function lowerUnionKeyedRead(
  lowerer: Lowerer,
  expr: ts.Expression,
  unionId: string,
  value: IrExpr,
  key: IrExpr,
  literalField: string | null,
): IrExpr | null {
  const def = lowerer.unions.get(unionId);
  if (!def) return null;
  // Pass 1: per-arm declared answers, joined into the result type.
  const joinArms: IrType[] = [];
  const seen = new Set<string>();
  const push = (t: IrType): void => {
    const k = typeKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      joinArms.push(t);
    }
  };
  const pushAnswer = (t: IrType): boolean => {
    if (t.kind === "void") return false;
    if (t.kind === "union") {
      const inner = lowerer.unions.get(t.unionId);
      if (!inner) return false;
      for (const a of inner.arms) push(a);
      return true;
    }
    push(t);
    return true;
  };
  for (const arm of def.arms) {
    if (isUnitType(arm)) {
      push(UNDEFINED_T);
      continue;
    }
    if (key.type.kind === "f64") {
      if (arm.kind !== "array" || !pushAnswer(arm.elem)) return null;
      continue;
    }
    if (arm.kind !== "record") return null;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple) return null;
    const declared =
      literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
    if (declared) {
      if (!pushAnswer(declared)) return null;
      continue;
    }
    // Runtime keys can reach the declared fields through the keyed-read
    // helper's string switch — every one joins.
    if (literalField === null) {
      for (const f of shape.fields) if (!pushAnswer(f.type)) return null;
    }
    if (!shape.indexValue) {
      if (literalField === null && shape.fields.length > 0) continue;
      return null;
    }
    if (!pushAnswer(shape.indexValue)) return null;
  }
  if (joinArms.length === 0) return null;
  // The join must be a BUILDABLE union: arm kinds the union invariants
  // admit (no dyn/jsval/generator arms; containers only beside unit
  // siblings). The caller owns the diagnostic for a refused join.
  if (
    joinArms.length > 1 &&
    (!unionContainerArmsOk(joinArms) ||
      joinArms.some(
        (a) =>
          a.kind === "dyn" || a.kind === "jsval" || a.kind === "generator" || a.kind === "caught",
      ))
  ) {
    return null;
  }
  joinArms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  const type: IrType =
    joinArms.length === 1
      ? joinArms[0]!
      : { kind: "union", unionId: lowerer.unions.intern(joinArms) };
  // Pass 2: every arm's answer must SURFACE as the join, and index arms
  // must pass the single-record keyed-read constraints (the helper is
  // shared with recordKeyGet, its missing-key policy included).
  const surfaces = (t: IrType): boolean =>
    typeEquals(t, type) ||
    (type.kind === "union" && lowerer.armTag(type.unionId, t) >= 0) ||
    exactUnionWidening(lowerer, t, type);
  for (const arm of def.arms) {
    if (isUnitType(arm)) {
      if (!(type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0)) return null;
      continue;
    }
    if (key.type.kind === "f64") {
      if (arm.kind !== "array" || !surfaces(arm.elem)) return null;
      continue;
    }
    if (arm.kind !== "record") return null;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape) return null;
    const declared =
      literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
    if (declared) {
      if (!surfaces(declared)) return null;
      continue;
    }
    const ovfShape: IrRecordShape =
      literalField !== null && shape.indexValue ? { ...shape, fields: [] } : shape;
    if (!recordKeyResultOk(lowerer, ovfShape, type)) return null;
  }
  return { kind: "unionKeyGet", unionId, key, value, type, loc: locOf(expr) };
}

/** A structural TypeScript view does not change a nominal object's layout
 * or accessor dispatch. Resolve the property from the represented class;
 * the optional checker view must not turn its getter into a record read. */
function classFieldTarget(
  lowerer: Lowerer,
  receiverNode: ts.Expression,
  receiverType: IrType & { kind: "object" },
  fieldName: string,
  saved?: IrExpr,
): FieldTarget | null {
  const represented = saved ?? lowerer.lowerExpr(receiverNode);
  if (
    represented.type.kind === "dyn" &&
    isJsSourceFile(receiverNode.getSourceFile()) &&
    !fieldName.startsWith("#")
  ) {
    return { container: "dynamic", obj: represented, field: fieldName, fieldType: DYN };
  }
  const info = lowerer.classes.get(receiverType.className);
  if (!info) {
    // A receiver typed as a class whose collection deferred: the
    // deferred diagnostics are what explains the miss.
    lowerer.flushDeferredClass(receiverType.className);
    return null;
  }
  const fieldType = info.fields.get(fieldName);
  const lowerObjectReceiver = (): IrExpr => {
    let obj = represented;
    if (obj.type.kind === "union") {
      const helper = lowerer.narrowedArmHelper(obj.type.unionId, receiverType, locOf(receiverNode));
      obj = helper
        ? {
            kind: "call",
            callee: helper,
            args: [obj],
            type: receiverType,
            loc: locOf(receiverNode),
          }
        : lowerer.maybeNarrow(obj, receiverNode);
    }
    return lowerer.coerceInto(receiverNode, obj, receiverType);
  };
  if (fieldName === "cause" && receiverType.className !== "%DOMException") {
    let root = info;
    while (root.base) root = root.base;
    if (root.def.name === "%Error") {
      return {
        container: "errorCause",
        obj: lowerObjectReceiver(),
        field: "cause",
        fieldType: DYN,
      };
    }
  }
  if (fieldType) {
    const obj = lowerObjectReceiver();
    if (
      isJsSourceFile(receiverNode.getSourceFile()) &&
      !fieldName.startsWith("#") &&
      [...lowerer.classes.values()].some(
        (candidate) =>
          lowerer.isSubclassOf(candidate.def.name, receiverType.className) &&
          (candidate.methods.has(`get:${fieldName}`) || candidate.methods.has(`set:${fieldName}`)),
      )
    ) {
      return {
        container: "dynamic",
        obj: lowerer.coerceToExpected(obj, DYN),
        field: fieldName,
        fieldType: DYN,
      };
    }
    return {
      container: "class",
      obj,
      className: receiverType.className,
      field: fieldName,
      fieldType,
    };
  }
  // Accessor property: either half declared anywhere on the chain
  // makes the name an accessor target (fields and accessors share a
  // namespace — tsc rejects mixing them, so the halves agree on kind).
  const getF = lowerer.findMethodOn(info, `get:${fieldName}`);
  const setF = lowerer.findMethodOn(info, `set:${fieldName}`);
  if (getF || setF) {
    const obj = lowerObjectReceiver();
    return {
      container: "accessor",
      obj,
      className: receiverType.className,
      field: fieldName,
      fieldType: getF ? getF.sig.ret : setF!.sig.params[0]!.type,
    };
  }
  if (info.decl && isJsSourceFile(info.decl.getSourceFile())) {
    const property = lowerer.checker.getPropertyOfType(
      lowerer.checker.getTypeAtLocation(receiverNode),
      fieldName,
    );
    if (
      property &&
      lowerer.checker
        .declarationsOf(property)
        .some(
          (declaration) =>
            ts.isPropertyAccessExpression(declaration) ||
            ts.isBinaryExpression(declaration) ||
            ts.isElementAccessExpression(declaration),
        )
    ) {
      return {
        container: "dynamic",
        obj: lowerer.coerceToExpected(lowerObjectReceiver(), DYN),
        field: fieldName,
        fieldType: DYN,
      };
    }
  }
  return null;
}

/** A structural assertion can leave the value in its original class
 * representation, including an unchecked array read's undefined arm. Only
 * a single nominal payload has an unambiguous property layout. Validate
 * that payload before dispatching a field or accessor; an absent receiver
 * must never reach the backend as an object pointer. */
function hasClassPayload(lowerer: Lowerer, type: IrType): boolean {
  return (
    type.kind === "object" ||
    (type.kind === "union" &&
      (lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === "object") ?? false))
  );
}

function representedClassFieldTarget(
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

/** Recognizes `obj.field` as an assignable field target: receiver is a
 * known class instance OR a record, and the member is a field or (class
 * receivers) a declared accessor property. Returns the pieces of a
 * fieldSet/recordSet/accessor-call (minus value/kind) or null. */
export function fieldTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): FieldTarget | null {
  if (lowerer.cjsLocalModuleBindingOf(access.expression)) return null;
  if (lowerer.chainBlocked(access)) return null;
  if (
    access.name.text === "stackTraceLimit" &&
    lowerer.isStdlibGlobal(access.expression, "Error")
  ) {
    return {
      container: "errorStackLimit",
      obj: { kind: "numLit", value: 0, type: F64, loc: locOf(access) },
      field: "stackTraceLimit",
      fieldType: F64,
    };
  }
  const stored = ts.isIdentifier(access.expression)
    ? (lowerer.peekLocal(access.expression)?.type ?? lowerer.globalOf(access.expression)?.type)
    : undefined;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  // Structural record views retain their storage layout, while a nominal
  // subclass guard proves a more specific layout of the same object.
  const receiverIr =
    stored?.kind === "record"
      ? stored
      : stored?.kind === "object" &&
          !(
            narrowed?.kind === "object" &&
            lowerer.isSubclassOf(narrowed.className, stored.className)
          )
        ? stored
        : narrowed;
  if (receiverIr?.kind === "object") {
    const target = classFieldTarget(lowerer, access.expression, receiverIr, access.name.text);
    if (target) return target;
    // Abstract properties declare no base storage. Resolve the concrete
    // instance's live field or accessor through the existing class bridge;
    // inventing a shared field offset would misread subclass layouts.
    if (abstractPropertyDeclOf(lowerer, access)) {
      return {
        container: "dynamic",
        obj: lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), DYN),
        field: access.name.text,
        fieldType: lowerer.irTypeOf(access),
      };
    }
    return null;
  }
  if (receiverIr?.kind === "union" && hasClassPayload(lowerer, receiverIr)) {
    return representedClassFieldTarget(
      lowerer,
      access.expression,
      access.name.text,
      lowerer.lowerExpr(access.expression),
    );
  }
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    const fieldType = shape?.fields.find((f) => f.name === access.name.text)?.type;
    if (fieldType) {
      let obj = lowerer.lowerExpr(access.expression);
      const nominal = representedClassFieldTarget(
        lowerer,
        access.expression,
        access.name.text,
        obj,
      );
      if (nominal) return nominal;
      // A checker-record receiver whose VALUE stayed dyn (the erased
      // all-unknown-fields cast — `(err as { code?: unknown }).code`):
      // decline, and the dyn keyed-read fallback answers.
      if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, UNDEFINED_T) >= 0) {
        // A nested property read such as `rows[i].value` has the same
        // unchecked outer array-read issue as tuple indexing. Validate
        // the record arm before fieldGet/recordGet so a missing outer
        // value raises a catchable TypeError rather than reaching the
        // backend with a union receiver.
        const present = lowerer.stripUndefinedArm(obj.type);
        const helper =
          present.kind === "record"
            ? lowerer.narrowedArmHelper(obj.type.unionId, present, locOf(access.expression))
            : null;
        obj = helper
          ? {
              kind: "call",
              callee: helper,
              args: [obj],
              type: present,
              loc: locOf(access.expression),
            }
          : lowerer.maybeNarrow(obj, access.expression);
      }
      if (obj.type.kind !== "record") return null;
      const actualShape = lowerer.shapes.get(obj.type.shapeId);
      const actualField = actualShape?.fields.find((f) => f.name === access.name.text);
      return {
        container: "record",
        obj,
        shapeId: obj.type.shapeId,
        field: access.name.text,
        fieldType: actualField?.type ?? fieldType,
      };
    }
    // A RECORD accessor property: either slot present makes the name an
    // accessor target (get/set share the property namespace — tsc
    // rejects mixing an accessor with a data property, so the halves
    // agree). Reads dispatch the %get: closure, writes the %set: one.
    {
      const getSlot = shape?.fields.find((f) => f.name === `%get:${access.name.text}`)?.type;
      const setSlot = shape?.fields.find((f) => f.name === `%set:${access.name.text}`)?.type;
      if (getSlot?.kind === "func" || setSlot?.kind === "func") {
        const obj = lowerer.lowerExpr(access.expression);
        if (obj.type.kind !== "record") return null; // dyn-valued receiver: the keyed fallback answers
        const getType = getSlot?.kind === "func" ? getSlot : undefined;
        const setType = setSlot?.kind === "func" ? setSlot : undefined;
        return {
          container: "recordAccessor",
          obj,
          shapeId: receiverIr.shapeId,
          field: access.name.text,
          fieldType: getType ? getType.ret : setType!.params[0]!,
          ...(getType ? { getType } : {}),
          ...(setType ? { setType } : {}),
        };
      }
    }
    // Dot access to an UNDECLARED key of an index-signature shape: tsc
    // types it through the signature — the access resolves to NO property
    // symbol (mapped types like Record<string, T>) or to the signature's
    // own `__index` symbol (interface-declared signatures). A real member
    // symbol means a lib member like `toString` — not an index access;
    // those keep their fences below. It IS the bracket access in dot
    // spelling — the same overflow path.
    const nameSym = lowerer.checker.getSymbolAtLocation(access.name);
    if (shape?.indexValue && !shape.tuple) {
      // A member the shape CANONICALIZATION dropped into the overflow
      // (the header family: @types declares `host?: string` on
      // IncomingHttpHeaders while the canonical shape is a pure index
      // record) is the bracket access in dot spelling too: a PROPERTY
      // declaration whose own type fits within the index value. METHOD
      // members (`toString` — the lib's inherited surface) keep their
      // fences: JS finds the prototype function, never an overflow miss.
      const canonicalized = (): boolean => {
        if (!nameSym) return false;
        const nameDecls = lowerer.checker.declarationsOf(nameSym);
        if (!nameDecls.length) return false;
        if (!nameDecls.every((d) => ts.isPropertySignature(d))) return false;
        const declared = lowerer.mapTypeOf(lowerer.typeOf(access));
        if (!declared) return false;
        const iv = shape.indexValue!;
        if (typeEquals(declared, iv)) return true;
        if (iv.kind !== "union") return false;
        const ivArms = lowerer.unions.get(iv.unionId)?.arms;
        if (!ivArms) return false;
        const declaredArms =
          declared.kind === "union"
            ? (lowerer.unions.get(declared.unionId)?.arms ?? [declared])
            : [declared];
        return declaredArms.every((a) => ivArms.some((b) => typeEquals(a, b)));
      };
      if (!nameSym || nameSym.name === ts.InternalSymbolName.Index || canonicalized()) {
        let obj = lowerer.lowerExpr(access.expression);
        if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, UNDEFINED_T) >= 0) {
          const present = lowerer.stripUndefinedArm(obj.type);
          obj =
            present.kind === "record"
              ? (lowerer.runtimeOptionalPropertyReceiver(
                  access.expression,
                  obj,
                  present,
                  access.name.text,
                ) ?? obj)
              : lowerer.maybeNarrow(obj, access.expression);
        }
        if (obj.type.kind !== "record") return null;
        const actualShape = lowerer.shapes.get(obj.type.shapeId);
        if (!actualShape?.indexValue) return null;
        return {
          container: "recordOvf",
          obj,
          shapeId: obj.type.shapeId,
          field: access.name.text,
          fieldType: actualShape.indexValue,
        };
      }
    }
    return null;
  }
  return null;
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
  const decl = sym ? lowerer.checker.valueDeclarationOf(sym) : undefined;
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
    init.arguments.length === 0
      ? null
      : init.arguments.length === 1
        ? init.arguments[0]!
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
function symbolFieldTarget(lowerer: Lowerer, expr: ts.ElementAccessExpression): FieldTarget | null {
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

/** The read expression for a field target (fieldGet / recordGet /
 * getter call). `blame` locates the rejection of a setter-only read —
 * tsc-clean (the property types as the setter's param), but Node yields
 * undefined, which these property types cannot represent. */
export function fieldGetExpr(
  lowerer: Lowerer,
  target: FieldTarget,
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr {
  if (target.container === "dynamic")
    return lowerer.coerceInto(
      blame,
      {
        kind: "dynKeyGet",
        value: target.obj,
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        type: DYN,
        loc,
      },
      target.fieldType,
    );
  if (
    target.container === "class" &&
    (target.field === "message" || target.field === "name") &&
    (target.className === "%Error" || lowerer.isSubclassOf(target.className, "%Error"))
  )
    return errorPropertyRead(lowerer, target.obj, target.field);
  if (target.container === "errorStackLimit") {
    return { kind: "libCall", fn: "error.stackLimitGet", args: [], type: F64, loc };
  }
  if (target.container === "errorCause") {
    return { kind: "libCall", fn: "error.cause", args: [target.obj], type: DYN, loc };
  }
  // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree
  // (a JS file-scope object-literal global): the checked-dynamic keyed
  // read — dynKeyGet (a missing key answers the dyn undefined, exactly
  // JS); consumers validate (dynCheck) where a static type is required.
  if (
    (target.container === "record" || target.container === "recordOvf") &&
    target.obj.type.kind === "dyn"
  ) {
    return {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: target.field, type: STRING, loc },
      value: target.obj,
      type: DYN,
      loc,
    };
  }
  if (target.container === "accessor") {
    const getF = lowerer.findMethodOn(
      lowerer.classes.get(target.className) ?? null,
      `get:${target.field}`,
    );
    if (!getF) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
      );
    }
    if (
      !target.field.startsWith("#") &&
      isJsSourceFile(blame.getSourceFile()) &&
      lowerer.dynConvertible(getF.sig.ret)
    ) {
      const value: IrExpr = {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(target.obj, DYN),
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        type: DYN,
        loc,
      };
      return lowerer.coerceToExpected(value, getF.sig.ret);
    }
    return lowerer.accessorCall(
      target.className,
      `get:${target.field}`,
      target.obj,
      [],
      getF.sig.ret,
      loc,
    );
  }
  // Record accessor properties: the read IS a call of the %get: closure
  // — once per read, side effects and all (JS's evaluation). The
  // setter-only read keeps the class-path fence: the property types as
  // the setter's param where Node yields undefined.
  if (target.container === "recordAccessor") {
    if (!target.getType) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
      );
    }
    const closure: IrExpr = {
      kind: "recordGet",
      obj: target.obj,
      shapeId: target.shapeId,
      field: `%get:${target.field}`,
      type: target.getType,
      loc,
    };
    return { kind: "callValue", callee: closure, args: [], type: target.getType.ret, loc };
  }
  // Overflow dot reads: exactly the bracket read with a literal key —
  // recordKeyGet, overflowOnly (the name declares no field by
  // construction), typed as the index value armed with undefined under
  // noUncheckedIndexedAccess (mirroring lowerRecordKeyRead).
  if (target.container === "recordOvf") {
    let obj = target.obj;
    if (obj.type.kind === "union" && ts.isPropertyAccessExpression(blame)) {
      const present = lowerer.stripUndefinedArm(obj.type);
      if (present.kind === "record") {
        obj =
          lowerer.runtimeOptionalPropertyReceiver(blame.expression, obj, present, target.field) ??
          obj;
      }
    }
    if (obj.type.kind !== "record") {
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading '${target.field}' on a non-record receiver (narrow first)`,
      );
    }
    const shape = lowerer.shapes.get(obj.type.shapeId);
    if (!shape?.indexValue)
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading '${target.field}' on a record without an index signature`,
      );
    let t: IrType = shape.indexValue;
    if (lowerer.program.getCompilerOptions().noUncheckedIndexedAccess) {
      const armed = lowerer.withUndefinedArmOf(t);
      if (!armed) lowerer.badType(blame, lowerer.typeOf(blame));
      t = armed;
    }
    return {
      kind: "recordKeyGet",
      obj,
      shapeId: obj.type.shapeId,
      key: { kind: "strLit", value: target.field, type: STRING, loc },
      overflowOnly: true,
      type: t,
      loc,
    };
  }
  if (target.container === "class") {
    const read: IrExpr = {
      kind: "fieldGet",
      obj: target.obj,
      className: target.className,
      field: target.field,
      type: target.fieldType,
      loc,
    };
    // DEFERRED-INIT fields (`stream!: T` assigned past the constructor's
    // top level — ClassInfo.deferredInitFields): the SLOT is the
    // undefined-armed union; the read CHECKED-extracts the declared type
    // — a genuinely unassigned read throws the catchable TypeError
    // where Node reads an undefined the declared type cannot hold.
    if (
      lowerer.classes.get(target.className)?.deferredInitFields?.has(target.field) === true &&
      target.fieldType.kind === "union"
    ) {
      const inner = lowerer.stripUndefinedArm(target.fieldType);
      const helper = lowerer.deferredReadHelper(target.fieldType.unionId, inner, loc);
      if (helper) return { kind: "call", callee: helper, args: [read], type: inner, loc };
    }
    return read;
  }
  return {
    kind: "recordGet",
    obj: target.obj,
    shapeId: target.shapeId,
    field: target.field,
    type: target.fieldType,
    loc,
  };
}

/** The write statement for a field target (fieldSet / recordSet / setter
 * call). A write to a getter-only property never gets here in a clean
 * program (tsc's TS2540 is the fence); the rejection is the backstop. */
export function fieldSetStmt(
  lowerer: Lowerer,
  target: FieldTarget,
  value: IrExpr,
  loc: SrcLoc,
  blame: ts.Node,
): IrStmt {
  if (target.container === "dynamic")
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [
          target.obj,
          { kind: "strLit", value: target.field, type: STRING, loc },
          lowerer.coerceToExpected(value, DYN),
        ],
        type: VOID,
        loc,
      },
      loc,
    };
  if (
    target.container === "class" &&
    (target.field === "message" || target.field === "name") &&
    (target.className === "%Error" || lowerer.isSubclassOf(target.className, "%Error"))
  )
    return errorPropertyWrite(lowerer, target.obj, value, target.field);
  if (target.container === "errorStackLimit") {
    return {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "error.stackLimitSet", args: [value], type: VOID, loc },
      loc,
    };
  }
  if (target.container === "errorCause") {
    return {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "error.setCause", args: [target.obj, value], type: VOID, loc },
      loc,
    };
  }
  // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree:
  // the checked-dynamic keyed write — dyn.keySet (later writes win,
  // insertion order; Node's TypeErrors on non-object receivers), the
  // value converting into the checked-dynamic tree.
  if (
    (target.container === "record" || target.container === "recordOvf") &&
    target.obj.type.kind === "dyn"
  ) {
    const v = lowerer.coerceToExpected(value, DYN);
    if (v.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1101",
        blame,
        `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
      );
    }
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [target.obj, { kind: "strLit", value: target.field, type: STRING, loc }, v],
        type: VOID,
        loc,
      },
      loc,
    };
  }
  if (target.container === "accessor") {
    const setF = lowerer.findMethodOn(
      lowerer.classes.get(target.className) ?? null,
      `set:${target.field}`,
    );
    if (!setF)
      lowerer.unsupported(
        "SC1090",
        blame,
        `assignment to the getter-only property '${target.field}'`,
      );
    return {
      kind: "exprStmt",
      expr: lowerer.accessorCall(
        target.className,
        `set:${target.field}`,
        target.obj,
        [value],
        VOID,
        loc,
      ),
      loc,
    };
  }
  // Record accessor properties: the write calls the %set: closure with
  // the coerced value. A getter-only write never gets here in a clean
  // program (tsc's TS2540); the rejection is the backstop.
  if (target.container === "recordAccessor") {
    if (!target.setType) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `assignment to the getter-only property '${target.field}'`,
      );
    }
    const closure: IrExpr = {
      kind: "recordGet",
      obj: target.obj,
      shapeId: target.shapeId,
      field: `%set:${target.field}`,
      type: target.setType,
      loc,
    };
    return {
      kind: "exprStmt",
      expr: { kind: "callValue", callee: closure, args: [value], type: VOID, loc },
      loc,
    };
  }
  // Overflow dot writes: the bracket write with a literal key — a pure
  // overflow insert (recordKeySet, overflowOnly: the name declares no
  // field, so no declared collision exists to validate). The value was
  // coerced into the index-value slot type by the caller.
  if (target.container === "recordOvf") {
    return {
      kind: "recordKeySet",
      obj: target.obj,
      shapeId: target.shapeId,
      key: { kind: "strLit", value: target.field, type: STRING, loc },
      value,
      overflowOnly: true,
      loc,
    };
  }
  return target.container === "class"
    ? {
        kind: "fieldSet",
        obj: target.obj,
        className: target.className,
        field: target.field,
        value,
        loc,
      }
    : {
        kind: "recordSet",
        obj: target.obj,
        shapeId: target.shapeId,
        field: target.field,
        value,
        loc,
      };
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
  if (call.arguments.length !== 1) {
    lowerer.noLowering(
      "Promise.reject with this argument count",
      call,
      "one Error reason is the supported form: Promise.reject(new Error(...))",
    );
  }
  const ctxT = lowerer.checker.getContextualType(call);
  const type = ctxT ? lowerer.mapTypeOf(ctxT) : null;
  const reasonNode = call.arguments[0]!;
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
  const argNode = call.arguments.length === 1 ? call.arguments[0]! : null;
  if (
    !argNode ||
    !ts.isArrayLiteralExpression(argNode) ||
    argNode.elements.some(ts.isSpreadElement) ||
    argNode.elements.length === 0
  ) {
    return null;
  }
  // The claim test runs on checker types only (no side effects): every
  // element the same representable promise type.
  const mapped = argNode.elements.map((el) => lowerer.mapTypeOf(lowerer.typeOf(el)));
  const first = mapped[0];
  if (first?.kind !== "promise") return null;
  if (!mapped.every((m) => m?.kind === "promise" && typeEquals(m.inner, first.inner))) {
    return null;
  }
  const loc = locOf(call);
  const inner = first.inner;
  const entryT: IrType = { kind: "promise", inner };
  const elems = argNode.elements.map((el) => lowerer.lowerExprExpecting(el, entryT));
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

function lowerFieldCompoundValue(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  op: CompoundOp,
  rhsNode: ts.Expression | null,
  loc: SrcLoc,
): IrExpr {
  if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
    lowerer.unsupported(
      "SC1090",
      access,
      "compound assignment through 'super' (read and write separately)",
    );
  }
  const body: IrStmt[] = [];
  const save = (value: IrExpr, name: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, value.type);
    body.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return varRef(local.id, value.type, value.loc);
  };
  // A CHECKED-DYNAMIC receiver (`context.actual++` — test/common's call
  // accounting; dot spelling only — symbol-keyed element targets are
  // static fields): read the member (dynKeyGet), VALIDATE it as a
  // number (dynCheck — a non-number member throws the catchable
  // TypeError where JS would ToNumber-coerce; loud, never a silent
  // NaN — SEMANTICS.md), combine, write back (dyn.keySet). The
  // receiver and member read are saved before evaluating the RHS.
  if (ts.isPropertyAccessExpression(access)) {
    let probed = tryLowerExpression(lowerer, access.expression);
    const staticClass =
      probed?.type.kind === "classval" ? lowerer.classes.get(probed.type.className) : undefined;
    if (probed && staticClass && hasRuntimeStatics(staticClass))
      probed = lowerer.coerceToExpected(probed, DYN);
    if (probed?.type.kind === "dyn") {
      const receiver = save(probed, "%compoundReceiver");
      const key: IrExpr = {
        kind: "strLit",
        value: access.name.text,
        type: STRING,
        loc: locOf(access.name),
      };
      const read = save(
        { kind: "dynKeyGet", key, value: receiver, type: DYN, loc },
        "%compoundOld",
      );
      const cur: IrExpr = { kind: "dynCheck", value: read, type: F64, loc };
      const rhs = save(
        rhsNode ? lowerer.lowerExpr(rhsNode) : { kind: "numLit", value: 1, type: F64, loc },
        "%compoundRhs",
      );
      if (isJsSourceFile(access.getSourceFile()) && lowerer.dynConvertible(rhs.type)) {
        const numeric = ["-", "*", "/", "%", "**"].includes(op);
        const right = lowerer.coerceToExpected(rhs, DYN);
        const value = save(
          {
            kind: "libCall",
            fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
            args:
              op === "+"
                ? [read, right]
                : [read, right, { kind: "strLit", value: op, type: STRING, loc }],
            type: DYN,
            loc,
          },
          "%compoundResult",
        );
        body.push({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [receiver, key, value],
            type: VOID,
            loc,
          },
          loc,
        });
        return { kind: "seqExpr", stmts: body, result: value, type: DYN, loc };
      }
      const numericRhs: IrExpr =
        rhs.type.kind === "dyn"
          ? { kind: "dynCheck", value: rhs, type: F64, loc: rhs.loc }
          : lowerOptionalNumber(lowerer, rhs, loc);
      if (numericRhs.type.kind !== "f64") lowerer.unsupported("SC1043", access);
      const value = save(
        { kind: "bin", op, left: cur, right: numericRhs, type: F64, loc },
        "%compoundResult",
      );
      const boxed: IrExpr = { kind: "dynFrom", value, type: DYN, loc };
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySet",
          args: [receiver, { ...key }, boxed],
          type: VOID,
          loc,
        },
        loc,
      });
      return { kind: "seqExpr", stmts: body, result: value, type: value.type, loc };
    }
  }
  const targetOf = (): FieldTarget | null =>
    ts.isPropertyAccessExpression(access)
      ? lowerer.fieldTarget(access)
      : symbolFieldTarget(lowerer, access);
  const target = targetOf();
  if (!target)
    lowerer.unsupported("SC1090", access, "compound assignment to unsupported field targets");
  target.obj = save(target.obj, "%compoundReceiver");
  // Accessors observe getter, RHS side effects, then setter, all through
  // the saved receiver.
  const read = save(lowerer.fieldGetExpr(target, locOf(access), access), "%compoundOld");
  const rhs = save(
    rhsNode ? lowerer.lowerExpr(rhsNode) : { kind: "numLit", value: 1, type: F64, loc },
    "%compoundRhs",
  );
  const numericRhs: IrExpr =
    rhs.type.kind === "dyn" && isJsSourceFile(access.getSourceFile())
      ? { kind: "dynCheck", value: rhs, type: F64, loc: rhs.loc }
      : lowerOptionalNumber(lowerer, rhs, loc);
  let value: IrExpr;
  const numericRead = lowerOptionalNumber(lowerer, read, loc, access);
  if (op === "+" && read.type.kind === "string") {
    value = {
      kind: "strConcat",
      left: read,
      right: lowerer.ensureString(rhs, rhsNode ?? access),
      type: STRING,
      loc,
    };
  } else if (numericRead.type.kind === "f64" && numericRhs.type.kind === "f64") {
    value = { kind: "bin", op, left: numericRead, right: numericRhs, type: F64, loc };
  } else if (target.fieldType.kind === "dyn" && isJsSourceFile(access.getSourceFile())) {
    const numeric = ["-", "*", "/", "%", "**"].includes(op);
    const left = lowerer.coerceToExpected(read, DYN);
    const right = lowerer.coerceToExpected(rhs, DYN);
    value = {
      kind: "libCall",
      fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
      args:
        op === "+"
          ? [left, right]
          : [left, right, { kind: "strLit", value: op, type: STRING, loc }],
      type: DYN,
      loc,
    };
  } else {
    lowerer.unsupported("SC1043", access);
  }
  const result = save(value, "%compoundResult");
  body.push(
    lowerer.fieldSetStmt(target, lowerer.coerceInto(access, result, target.fieldType), loc, access),
  );
  return { kind: "seqExpr", stmts: body, result, type: result.type, loc };
}

/** Stream-rooted receivers' property surface (readableEnded, destroyed,
 * ...): the receiver's mapped class dispatches into lower-stream.ts.
 * Null off the stream hierarchy or for names the spoke does not own. */
function lowerStreamObjectProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (recvT?.kind !== "object") return null;
  const info = lowerer.classes.get(recvT.className);
  if (!info || streamSidesOf(lowerer, info) === null) return null;
  return lowerStreamProperty(lowerer, expr, info);
}

/** The primitive-constructor closure (`String`/`Number`/`Boolean` as a
 * VALUE): interns one synthesized module function per constructor/ABI and
 * returns the zero-capture closure over it. Typed sources use the mapped
 * `(value: string) => primitive` signature; a recognized JavaScript
 * concise-arrow selector (`() => String`, the picocolors fallback) takes
 * dyn so its ordinary coercion signature survives inference residue. The
 * dyn bodies run exact ToString/ToNumber/ToBoolean, including object hooks.
 * Interning makes every reference under one ABI the SAME immortal closure,
 * so `opt.type === String` compares like JS function identity. */
function primitiveCtorClosure(
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
          ? { kind: "libCall", fn: "dyn.toStringCoerce", args: [v], type: STRING, loc }
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

/** Drain using checked dispatch so native class and generator iterators keep their methods. */
function checkedIteratorPack(lowerer: Lowerer, source: IrExpr, loc: SrcLoc): IrExpr {
  const name = "%iterator.pack.checked";
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const ref = (id: string): IrExpr => ({ kind: "varRef", localId: id, type: DYN, loc });
    const property = (key: string): IrExpr => ({
      kind: "dynKeyGet",
      value: ref("step"),
      key: { kind: "strLit", value: key, type: STRING, loc },
      type: DYN,
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "source", name: "source", type: DYN }],
      returnType: DYN,
      locals: ["source", "iterator", "step", "result"].map((id) => ({
        id,
        name: id,
        type: DYN,
        mutable: id !== "source",
      })),
      body: [
        {
          kind: "varDecl",
          localId: "iterator",
          init: {
            kind: "libCall",
            fn: "dyn.iterator",
            args: [ref("source"), { kind: "strLit", value: "value", type: STRING, loc }],
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: "result",
          init: { kind: "dynArrLit", elems: [], type: DYN, loc },
          loc,
        },
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: [
            {
              kind: "varDecl",
              localId: "step",
              init: {
                kind: "dynInvoke",
                recv: ref("iterator"),
                method: "next",
                calleeName: "iterator.next",
                args: [],
                type: DYN,
                loc,
              },
              loc,
            },
            {
              kind: "if",
              cond: { kind: "dynTest", test: "truthy", value: property("done"), type: BOOL, loc },
              then: [{ kind: "return", value: ref("result"), loc }],
              else_: null,
              loc,
            },
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "dyn.packPush",
                args: [ref("result"), property("value")],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: ref("result"), loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [source], type: DYN, loc };
}
