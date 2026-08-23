import { InternalCompilerError } from "../../errors.js";
/* Expression lowering: the expression dispatch (lowerExpr), literals
 * (array/object/regex/template), operators (binary incl. compound targets,
 * unary, instanceof, caught-typeof tests), union narrowing and unit
 * comparisons, nullish coalescing and optional chains, conditions and
 * ToBoolean/ToString coercion helpers, and field/element reads and writes
 * (FieldTarget). */
import * as ts from "../ts7/adapter.js";
import { dirname, posix } from "node:path";
import type { Lowerer } from "./lowerer.js";
import { wasiGuestPath } from "../../wasi-paths.js";
import { BOOL, CAUGHT, DYN, DYN_HANDLE_KINDS, F64, IrExpr, IrFunction, IrJsOp, IrLocal, IrRecordShape, IrStmt, IrType, JSVAL, NULL_T, REF_TRUTHY_KINDS, REGEX, RUNTIME_ERROR_CLASSES, SEARCH_PARAMS_T, STRING, SrcLoc, UNDEFINED_T, VOID, arrayOf, canAdaptDynFuncTo, canBoxFuncIntoDyn, canDynCheckTo, funcOf, isJsonSafeType, isUnitType, jsOpResultKind, shapeHasAccessorSlots, typeEquals, typeKey, unionFuncSetArmsOk } from "../../ir/nodes.js";
import { cjsClassExprWholeExportOf, cjsExportAssignmentOf, cjsExportDiscardReason, isCjsExportTableLiteral, isCjsJsFile, isJsSourceFile, isModuleExportsAccess, isNodeEsmFile, locOf } from "../program.js";
import { ARRAY_METHODS, builtinConstLit, builtinFenceHintOf, builtinModuleConstOf, builtinModulesArrayLit, builtinModuleFnOf, CompoundOp, ISLAND_SURFACE, isChildSurfaceMember, MAP_METHODS, NARROW_FIRST, SET_METHODS, STR_METHODS, UNSUPPORTED_EXPR, sideEffectFreeOptionValue, stdlibGlobalNameOf } from "./surfaces.js";
import { UNSUPPORTED, blockedBindingUseDiag, recordShapeMismatchDiag, requiresDynamicPackageDiag, unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { PoisonError, dynUndefinedExpr, jsFuncNameOf, neverTaintedJsType, nodeThrowExpr, own } from "./lowerer.js";
import { IndexMergeContributor, lowerIndexMergeHelper, lowerNpmStaticSafeIndexRead, lowerSafeIndexRead, strCharsCall } from "./lower-containers.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { unsupportedModuleFeatureOf } from "../shared.js";
import { fenceEnumObjectValue, lowerEnumAccess } from "./lower-enums.js";
import { ambientNsRootOf, ambientUndefReadType, ambientUndefVarRootOf, ambientUndefinedFnSymbolOf, contextualUndefReadType, fenceEarlyAliasUse, fenceEarlyNsMemberRef, lowerNsIdentifierValue, nsMemberIdentOf, nsUndefRead, nsWritableTarget } from "./lower-namespaces.js";
import { expandoMemberRead, expandoWritableTarget } from "./lower-expando.js";
import { lowerSocketInstanceOf, lowerTlsRootCertificates } from "./lower-server.js";
import { findGenericMethodOn, lowerStaticFieldRead } from "./lower-classes.js";
import { bindingNeverReassigned, implicitMonoFile, lowerTaggedTemplate, nullishGenericBindingUnitOf, objLitGenericFnInfoOf, objLitGenericFnNodeOf, requireObjLitGenericReceiver } from "./lower-calls.js";
import { mixinFnOfCallee } from "./lower-mixins.js";
import { isConstAssertionTypeNode, isGenericCallableMemberType, isParseArgsDynTypeName, underConstAssertion, unitOnlyUnion } from "../types.js";
import { lowerYield } from "./lower-generators.js";
import { lowerStreamProperty, lowerStreamStateProperty, streamSidesOf } from "./lower-stream.js";
import { numLit, varRef } from "../../ir/build.js";

/** An assignable `obj.field` target — a class field, a record field, or a
 * class ACCESSOR property (reads become getter calls, writes setter calls;
 * fieldType is the property's one type). */
export type FieldTarget =
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
  const tailTrim = node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1;
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
 * (`abstract p: number` — a PropertyDeclaration, not an accessor): the
 * named-fence test for reads/writes through abstract-typed receivers. */
export function abstractPropertyDeclOf(L: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  const sym = L.checker.getSymbolAtLocation(expr.name);
  if (!sym) return false;
  return L.checker
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
function isParseArgsDynProperty(L: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  const sym = L.checker.getSymbolAtLocation(expr.name);
  if (!sym) return false;
  return L.checker.declarationsOf(sym).some((d) => {
    if (!L.isStdlibFile(d.getSourceFile())) return false;
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

export function lowerExpr(L: Lowerer, expr: ts.Expression): IrExpr {
    if (lowerExprDepth >= LOWER_EXPR_MAX_DEPTH) {
      L.unsupported("SC1090", expr, `expressions nested deeper than ${LOWER_EXPR_MAX_DEPTH} levels`);
    }
    lowerExprDepth++;
    try {
      return lowerExprInner(L, expr);
    } finally {
      lowerExprDepth--;
    }
  }

function lowerExprInner(L: Lowerer, expr: ts.Expression): IrExpr {
    const loc = locOf(expr);

    // An optional chain's guarded receiver: already evaluated by the
    // enclosing optChain — read the bind temp instead of re-lowering.
    const chainRecv = L.chainRecvByNode.get(expr);
    if (chainRecv) return { ...chainRecv, loc };

    // --external-types supplies CHECKER truth only. A value rooted in one
    // of those declarations has no runtime implementation in scriptc, so
    // every use fences at its expression instead of accidentally lowering
    // as an ambient ReferenceError or a structural value. This keeps the
    // rest of coverage measurable without overstating the host boundary.
    const externalTypeSpecifier = L.externalTypeSpecifierOf(expr);
    if (externalTypeSpecifier !== null) {
      L.externalHostFence(externalTypeSpecifier, expr);
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
    if (ts.isRegularExpressionLiteral(expr)) return L.lowerRegexLiteral(expr);
    if (ts.isTemplateExpression(expr)) return L.lowerTemplate(expr);
    if (ts.isTaggedTemplateExpression(expr)) {
      // `String.raw` — the ONE lowered tag: the template's RAW text,
      // escapes staying characters (String.raw`C:\System` keeps the
      // backslash; the wslpath idiom). Substitutions splice exactly like
      // an untagged template, just over the raw spans. Every other tag
      // is the general lowering — an interned per-site strings object
      // plus an ordinary call (lowerTaggedTemplate).
      if (
        ts.isPropertyAccessExpression(expr.tag) &&
        L.stdlibGlobalMember(expr.tag, "String") === "raw"
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
            L.caughtToString(span.expression) ??
              L.ensureString(L.lowerExpr(span.expression), span.expression),
          );
          const raw = templateRawTextOf(span.literal);
          if (raw !== "") {
            pieces.push({ kind: "strLit", value: raw, type: STRING, loc: locOf(span.literal) });
          }
        }
        if (pieces.length === 0) return { kind: "strLit", value: "", type: STRING, loc };
        return pieces.reduce((acc, p) => ({ kind: "strConcat", left: acc, right: p, type: STRING, loc }));
      }
      return lowerTaggedTemplate(L, expr);
    }
    if (ts.isParenthesizedExpression(expr)) return L.lowerExpr(expr.expression);
    // Type-level wrappers: `satisfies` and `!` erase completely; the runtime
    // value is the inner expression's. `as` erases too UNLESS the inner
    // value is dyn ('unknown') — then the cast is THE dynamic boundary and
    // compiles to a runtime validation (see lowerAsExpression). A cast
    // between non-dyn IR types can't change representation (the inner
    // expression's own lowering/mapType already rejects what doesn't map).
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
      const inner = L.lowerExpr(expr.expression);
      if (inner.type.kind === "union") {
        const use = runtimeOptionalUseOf(expr);
        if (runtimeOptionalAssertionErases(L, expr, inner, use)) return inner;
        const target = L.mapTypeOf(L.typeOf(expr));
        if (target && target.kind !== "union" && !typeEquals(target, inner.type)) {
          const helper = L.narrowedArmHelper(inner.type.unionId, target, loc);
          if (helper) {
            return { kind: "call", callee: helper, args: [inner], type: target, loc };
          }
        }
        return inner;
      }
      return L.maybeNarrow(inner, expr);
    }
    if (ts.isSatisfiesExpression(expr)) {
      return L.lowerExpr(expr.expression);
    }
    if (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) return L.lowerAsExpression(expr);
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
      L.unsupported(
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
        const ctxTs = L.checker.getContextualType(expr);
        const mapped = (ctxTs ? L.mapTypeOf(ctxTs) : null) ?? L.mapTypeOf(L.typeOf(expr));
        if (mapped?.kind !== "jsval") return false;
        // The tsgo readonly-[] panic repair (see lowerArrayLiteral): an
        // EMPTY array literal under a const assertion is the empty tuple —
        // its `any` answer is a panicked query, not an island slot.
        if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0 && underConstAssertion(expr)) {
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
          const bindSym = L.checker.getSymbolAtLocation(expr.parent.name);
          const g = bindSym ? L.globalsBySymbol.get(bindSym) : undefined;
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
          const decls = sym ? L.checker.declarationsOf(sym) : [];
          const projectDeclared =
            decls.length > 0 &&
            decls.every((d) => {
              const sf = d.getSourceFile();
              return !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/");
            });
          if (projectDeclared) {
            const own = L.mapTypeOf(L.typeOf(expr));
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
        const islandMemberFence = (diagsBefore: number, err: unknown, valueNode: ts.Node, getterName: string | null = null): IrExpr | null => {
          if (!(err instanceof PoisonError) || !isJsSourceFile(expr.getSourceFile())) throw err;
          const fence = L.deferToRuntimeFence(diagsBefore, valueNode, {
            kind: "closure",
            name: () => `%fn${L.lambdaCounter++}_islfence`,
            returnType: VOID,
            type: { kind: "func", params: [], ret: VOID },
          });
          if (!fence) throw err;
          if (getterName !== null) {
            getters.push({ name: getterName, fn: L.jsvalIn(fence, valueNode), loc: locOf(valueNode) });
            return null;
          }
          return L.jsvalIn(fence, valueNode);
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
          return L.checker.getCallSignatures(L.typeOf(src)).length > 0;
        };
        const pushProp = (
          name: ts.Identifier | ts.StringLiteral,
          value: IrExpr,
          valueNode: ts.Node,
          into: IrExpr[][],
        ): void => {
          const diagsBefore = L.diags.length;
          let marshaled: IrExpr;
          try {
            marshaled = L.jsvalIn(value, valueNode);
          } catch (err) {
            // A value that LOWERED but cannot cross (a promise, a class
            // instance): func-typed values keep the call-time closure;
            // data-shaped values fence at the read (the getter), unless a
            // conditional spread owns the literal (getters cannot combine).
            const asGetter = value.type.kind !== "func" && spread === null;
            const fence = islandMemberFence(diagsBefore, err, valueNode, asGetter ? name.text : null);
            if (fence === null) return; // registered as a fence getter — no data property
            marshaled = fence;
          }
          for (const args of into) {
            args.push({
              kind: "jsMarshal",
              value: { kind: "strLit", value: name.text, type: STRING, loc: locOf(name) },
              type: JSVAL, loc: locOf(name),
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
                L.unsupported(
                  "SC1090",
                  prop,
                  "a conditional spread mixed with plain spreads in an 'any'-typed object literal",
                );
              }
              const cond = L.lowerCondition(cs.cond);
              if (!pureCondExpr(cond)) {
                L.unsupported(
                  "SC1090",
                  prop,
                  "conditional spreads with effectful conditions in an 'any'-typed object literal (bind the condition to a const first)",
                );
              }
              spread = { cond, whenTrue: cs.whenTrue };
              for (const p of cs.props) {
                const v = ts.isPropertyAssignment(p) ? L.lowerExpr(p.initializer) : L.lowerShorthandValue(p);
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
                L.unsupported(
                  "SC1090",
                  prop,
                  "object spread after explicit properties (or mixed with a conditional spread) in an 'any'-typed object literal — spreads must come first",
                );
              }
              spreadSrcs.push(L.jsvalIn(L.lowerExpr(prop.expression), prop.expression));
              continue;
            }
            L.unsupported(
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
          if (ts.isGetAccessorDeclaration(prop) && prop.body && name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
            L.rejectThisInObjectMethod(prop.body);
            getters.push({ name: name.text, fn: L.jsvalIn(L.lowerLambda(prop), prop), loc: locOf(prop) });
            continue;
          }
          // A member VALUE that cannot lower at all (a generic function
          // referenced as a value — the aggregate's `align`): the same
          // call-time fence deferral pushProp applies to marshal failures.
          let value: IrExpr | null = null;
          const valueDiagsBefore = L.diags.length;
          try {
            value = ts.isPropertyAssignment(prop)
              ? L.lowerExpr(prop.initializer)
              : ts.isShorthandPropertyAssignment(prop)
                ? L.lowerShorthandValue(prop)
                : ts.isMethodDeclaration(prop) && prop.body
                  ? (L.rejectThisInObjectMethod(prop.body), L.lowerLambda(prop))
                  : null;
          } catch (err) {
            const nameText =
              name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
            const asGetter = nameText !== null && spread === null && !funcShapedMember(prop);
            value = islandMemberFence(valueDiagsBefore, err, prop, asGetter ? nameText : null);
            if (value === null) continue; // registered as a fence getter — no data property
          }
          if (value && name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
            pushProp(name, value, prop, [argsWithout, argsWith]);
          } else {
            L.unsupported(
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
                { kind: "jsMarshal", value: { kind: "strLit", value: g.name, type: STRING, loc: g.loc }, type: JSVAL, loc: g.loc },
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
          L.unsupported("SC1090", expr, "get accessors combined with conditional spreads in an 'any'-typed object literal");
        }
        const withLit: IrExpr = { kind: "jsOp", op: "objLit", args: argsWith, type: JSVAL, loc };
        const withoutLit: IrExpr = { kind: "jsOp", op: "objLit", args: argsWithout, type: JSVAL, loc };
        return {
          kind: "ternary",
          cond: spread.cond,
          then: spread.whenTrue ? withLit : withoutLit,
          else_: spread.whenTrue ? withoutLit : withLit,
          type: JSVAL,
          loc,
        };
      }
      const args = expr.elements.map((el) => L.jsvalIn(L.lowerExpr(el), el));
      return { kind: "jsOp", op: "arrLit", args, type: JSVAL, loc };
    }
    if (ts.isTypeOfExpression(expr)) {
      // `typeof queueMicrotask` / `typeof DOMException` on a STDLIB global
      // whose declared type is callable or constructable: folds to
      // "function" BEFORE the operand lowers — the identity-token story
      // (JS files) deliberately represents these values as strings, and
      // the TS-file fence would name a value the program never needs; an
      // identifier read has no side effects to preserve. Node's answer for
      // every function and constructor global is "function" (the harness's
      // `typeof queueMicrotask === 'function'` probes). Shadowing locals
      // have non-stdlib symbols and keep the ordinary path.
      if (ts.isIdentifier(expr.expression)) {
        const sym = L.checker.getSymbolAtLocation(expr.expression);
        if (L.isStdlibSymbol(sym)) {
          const t = L.typeOf(expr.expression);
          if (
            L.checker.getCallSignatures(t).length > 0 ||
            L.checker.getConstructSignatures(t).length > 0
          ) {
            return { kind: "strLit", value: "function", type: STRING, loc };
          }
        }
      }
      // Island values ask the engine; static primitives constant-fold to
      // the JS answer (the operand still evaluates — JS evaluates typeof
      // operands too — but primitives here are side-effect-free varRefs/
      // literals after lowering, so folding away the value is safe only
      // when the operand is trivial; otherwise keep it simple and reject).
      let operand = L.lowerExpr(expr.expression);
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
        f64: "number", string: "string", bool: "boolean", func: "function",
        array: "object", object: "object", record: "object",
        symbol: "symbol",
        map: "object", set: "object", promise: "object", bytes: "object",
        regexp: "object", generator: "object", classval: "function",
        undefinedT: "undefined", nullT: "object",
      };
      const folded = FOLD[operand.type.kind];
      if (folded && droppableStatic(operand)) {
        return { kind: "strLit", value: folded, type: STRING, loc };
      }
      // A union operand: every arm's typeof answer is static, so the value
      // form is a ternary chain over runtime TAG tests (arms grouped by
      // answer; the last group needs no test). The operand rides several
      // tests, so only side-effect-free reads compose — and when every arm
      // agrees the whole expression folds to that one string (dropping only
      // the pure read, the trust-the-checker bet lowerUnitComparison makes).
      if (operand.type.kind === "union" && pureReemittable(operand)) {
        const def = L.unions.get(operand.type.unionId);
        const answers = def?.arms.map(typeofAnswer);
        if (def && answers && answers.every((s): s is string => s !== null)) {
          const groups = new Map<string, number[]>();
          answers.forEach((s, i) => groups.set(s, [...(groups.get(s) ?? []), i]));
          const ordered = [...groups.entries()];
          let result: IrExpr = { kind: "strLit", value: ordered[ordered.length - 1]![0], type: STRING, loc };
          for (const [answer, tags] of ordered.slice(0, -1).reverse()) {
            let test: IrExpr = { kind: "unionIsTag", unionId: operand.type.unionId, tag: tags[0]!, negated: false, value: operand, type: BOOL, loc };
            for (const t of tags.slice(1)) {
              test = { kind: "logical", op: "||", left: test, right: { kind: "unionIsTag", unionId: operand.type.unionId, tag: t, negated: false, value: operand, type: BOOL, loc }, type: BOOL, loc };
            }
            result = { kind: "ternary", cond: test, then: { kind: "strLit", value: answer, type: STRING, loc }, else_: result, type: STRING, loc };
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
      L.unsupported("SC1090", expr, "typeof expressions on statically-typed values");
    }
    if (ts.isIdentifier(expr)) {
      if (L.isSelfReference(expr)) {
        return { kind: "selfRef", type: L.ctx.selfType!, loc };
      }
      // `arguments` in a variadic JS function (the rest-marked form): the
      // synthetic trailing dyn-array param — lambdaSignature marked the
      // type and lowerLambda declared the local.
      if (expr.text === "arguments" && L.ctx.argumentsLocal) {
        return { kind: "varRef", localId: L.ctx.argumentsLocal.id, type: DYN, loc };
      }
      // A `const x = promisify(execFile)` binding as a VALUE: the
      // promisified function never exists at runtime (its calls lower to
      // the interned async-exec helper) — call it directly.
      {
        const sym = L.resolveValueSymbol(expr);
        if (sym && L.promisifiedExecFile.has(sym)) {
          L.unsupported(
            "SC1090",
            expr,
            `a promisified execFile as a value (call '${expr.text}' directly)`,
          );
        }
      }
      // Union-typed bindings read through tsc's control-flow narrowing:
      // when the checker types this USE as a single arm, maybeNarrow
      // bridges the tagged representation with a unionNarrow.
        const local = L.resolveLocal(expr);
        if (local) {
          if (local.type.kind === "caught") return L.caughtRead(expr, local, loc);
          const symbol = L.resolveValueSymbol(expr);
          const runtimeOptionalRoot = L.runtimeOptionalRootOf(local);
          const active = L.runtimeOptionalLocals.has(runtimeOptionalRoot);
          const captured = !!symbol &&
            L.runtimeOptionalStorageLocals.has(runtimeOptionalRoot) &&
            L.ctx.captureBySymbol.get(symbol) === local;
          if (active || captured) {
            const use = runtimeOptionalUseOf(expr);
            if (use?.complex) {
              L.unsupported("SC1090", expr, "a logical or conditional receiver containing a runtime-optional capture");
            }
            if (use?.optional) return { kind: "varRef", localId: local.id, type: local.type, loc };
            if (use?.kind === "property") return runtimeOptionalReceiverRead(L, expr, local, use.access.name.text, loc);
            if (use?.kind === "element") {
              const key = runtimeOptionalElementKey(use.access.argumentExpression);
              if (key === null) {
                L.unsupported("SC1090", use.access, "a computed read from a runtime-optional capture (use a literal key)");
              }
              return runtimeOptionalReceiverRead(L, expr, local, key, loc);
            }
            if (use?.kind === "call") {
              if (use.comma && !use.optional) {
                L.unsupported("SC1090", use.access, "a direct call through a comma-wrapped runtime-optional capture");
              }
              return runtimeOptionalReceiverRead(L, expr, local, null, loc);
            }
            if (active || captured) return { kind: "varRef", localId: local.id, type: local.type, loc };
          }
          return L.maybeNarrow({ kind: "varRef", localId: local.id, type: local.type, loc }, expr);
      }
      // `import x = N.y` aliases resolve transparently through globalOf/
      // fnSigOf below; their source-order guards live here (a no-op for
      // every non-import= binding — see lower-namespaces.ts).
      fenceEarlyAliasUse(L, expr, expr);
      const g = L.globalOf(expr);
      if (g) {
        // A global typed by a class that never REGISTERED (its collection
        // fenced): the initializing assignment never lowered, so the read
        // can only observe garbage — and the emitter would name a struct
        // that does not exist. The blocked-binding cascade names the use;
        // without this the validator's registration check ICEs on the live
        // reference (`@this {T}` inference — signature 07).
        if (L.typeNamesUnregisteredClass(g.type)) {
          L.pushDiag(blockedBindingUseDiag(expr.text, loc));
          throw new PoisonError();
        }
        return L.maybeNarrow({ kind: "varRef", localId: g.id, type: g.type, loc }, expr);
      }
      // `undefined` — tsc's intrinsic global (a local shadowing the name
      // resolved above): a unit literal, exactly like the `null` keyword.
      if (expr.text === "undefined" && L.typeOf(expr).flags & ts.TypeFlags.Undefined) {
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
        L.isStdlibGlobal(expr, expr.text)
      ) {
        const sf = expr.getSourceFile();
        if (isNodeEsmFile(sf)) {
          L.unsupported(
            "SC1090",
            expr,
            `'${expr.text}' in an ES module (Node defines the CJS module globals only in CommonJS modules)`,
          );
        }
        // The WASI runner mounts the host cwd at guest `/` and the host temp
        // directory at `/tmp`. Bake the matching GUEST spelling so resource
        // lookups relative to these CommonJS globals stay inside the exposed
        // capability instead of naming an unreachable host-absolute path.
        const fileName = L.targetPlatform === "wasi"
          ? wasiGuestPath(sf.fileName) ?? sf.fileName.replace(/\\/g, "/")
          : sf.fileName;
        const value = expr.text === "__dirname"
          ? (L.targetPlatform === "wasi" ? posix.dirname(fileName) : dirname(fileName))
          : fileName;
        return { kind: "strLit", value, type: STRING, loc };
      }
      const sig = L.fnSigOf(expr);
      if (sig && L.isTopLevelFnSymbol(expr)) {
        // A declared function used as a value: a zero-capture closure. The
        // backend interns one per function so `f === f` holds (JS identity).
        // The value's type is the completed ABI signature — exact-arity, so
        // optional/default/rest declarations pass the value fence first.
        L.noteEdge(sig.name);
        // dynRest slots stay out of the VALUE type's param list (fn.length
        // semantics); the rest marker carries the trailing dyn-array ABI.
        const funcType: IrType = {
          kind: "func",
          params: sig.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
          ret: sig.returnType,
          ...(sig.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
        };
        L.requireExactArityValue(expr, expr, sig.params, funcType);
        return { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc };
      }
      {
        // A generic function as a VALUE: monomorphized by flow — the
        // reference's pinned concrete signature (contextual type or an
        // instantiation expression) names the instance; unpinned
        // references fence inside (lowerGenericFnValue).
        const gfn = L.genericFnOf(expr);
        if (gfn) return L.lowerGenericFnValue(expr, gfn);
      }
      // A CJS export-table ACCESSOR read (`tmpdir.path`, or a destructured
      // binding aliasing one): the getter is a real function of module
      // scope — its body reads module globals, so it lifts like a lambda
      // (interned per declaration) and every read is a call. Node runs the
      // getter per read; so does this.
      {
        const acc = cjsExportAccessorRead(L, expr);
        if (acc) return acc;
      }
      // A binding destructured from a baked constants object
      // (http2.constants / crypto.constants): the literal — the
      // declaration emitted nothing (builtinConstantsDestructureDecl).
      {
        const h2c = L.builtinConstantBindingOf(expr);
        if (h2c) return h2c;
      }
      // Builtin-module import bindings: constants (path.sep, os.EOL) read
      // as interned string literals; functions have no closure
      // representation (they lower to libCall at call sites only); members
      // with no lowering at all fence with the module-qualified name.
      {
        const bi = L.builtinImportOf(expr);
        if (bi) {
          const c = builtinModuleConstOf(L, bi.module, bi.member);
          if (c !== undefined) return builtinConstLit(c, loc);
          // module.builtinModules — the baked Node v24 list, a fresh
          // string[] per read.
          if (bi.module === "module" && bi.member === "builtinModules") {
            return builtinModulesArrayLit(loc);
          }
          // tls.rootCertificates: a runtime-valued module constant (the
          // cached bundled-CA array) — the one member read that lowers
          // to a libCall instead of a baked literal.
          {
            const roots = lowerTlsRootCertificates(L, bi, loc);
            if (roots) return roots;
          }
          // JavaScript sources: a builtin member taken as a bare VALUE is
          // the same identity-token story as stdlib globals above (the
          // harness adds worker_threads.Worker to its identity Set).
          if (isJsSourceFile(expr.getSourceFile())) {
            return { kind: "strLit", value: `[builtin ${bi.module}.${bi.member}]`, type: STRING, loc };
          }
          if (builtinModuleFnOf(L, bi.module, bi.member)) {
            L.unsupported(
              "SC1090",
              expr,
              `library functions as values (call '${expr.text}' directly)`,
            );
          }
          L.noLowering(
            `${bi.module}.${bi.member}`,
            expr,
            builtinFenceHintOf(bi.module, bi.member),
            L.resolveValueSymbol(expr),
          );
        }
      }
      // A builtin namespace import used as a bare VALUE (`const f = fs`):
      // the namespace object has no representation — members lower at
      // their access sites only. The CommonJS namespace binding
      // (`const lib = require("./lib.js")`) gets the same fence.
      if (L.builtinNamespaceModuleOf(expr) !== null || L.cjsLocalModuleBindingOf(expr)) {
        L.unsupported(
          "SC1090",
          expr,
          `module namespace objects as values (access '${expr.text}' members directly)`,
        );
      }
      if (L.islandGlobalFnOf(expr)) {
        // Island-backed functions have no closure representation (they
        // lower to engine ops at call sites only).
        L.unsupported(
          "SC1090",
          expr,
          `library functions as values (call '${expr.text}' directly)`,
        );
      }
      // npm import bindings in a STATIC build: the binding's value lives
      // in the embedded engine — the per-package requires-dynamic
      // diagnostic, not the generic fallthrough. (Under --dynamic these
      // resolve as jsval globals above.)
      if (!L.dynamic) {
        const pkg = L.npmPackageOfSymbol(L.resolveValueSymbol(expr) ?? undefined);
        if (pkg) {
          L.pushDiag(requiresDynamicPackageDiag(pkg, loc));
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
        const spec = L.fencedBuiltinImportOf(expr);
        if (spec !== null) {
          L.pushDiag(unsupportedDiag("SC1010", loc, unsupportedModuleFeatureOf(spec)));
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
        const sym = L.checker.getSymbolAtLocation(expr);
        if (L.isStdlibSymbol(sym)) {
          return { kind: "numLit", value: expr.text === "NaN" ? NaN : Infinity, type: F64, loc };
        }
      }
      // The primitive constructors as VALUES (`const f = String`, an
      // option table's `type: Boolean` field, `opt.type === Number`): the
      // interned coercion closure — one synthesized module function per
      // constructor per program, so every reference is the SAME zero-
      // capture closure and `===` is JS identity (the type mapping in
      // types.ts pins the one concrete signature `(value: string) =>
      // primitive`; direct calls `String(x)` never reach here — the call
      // lowering intercepts them with the wider static coercions).
      // JavaScript sources keep the identity-token path below.
      if (
        (expr.text === "String" || expr.text === "Number" || expr.text === "Boolean") &&
        !isJsSourceFile(expr.getSourceFile()) &&
        L.isStdlibSymbol(L.checker.getSymbolAtLocation(expr))
      ) {
        return primitiveCtorClosure(L, expr.text, loc);
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
      {
        const sym = L.checker.getSymbolAtLocation(expr);
        if (L.isStdlibSymbol(sym) || expr.text === "globalThis") {
          if (isJsSourceFile(expr.getSourceFile())) {
            const canonical = stdlibGlobalNameOf(L, expr) ?? expr.text;
            return { kind: "strLit", value: `[builtin ${canonical}]`, type: STRING, loc };
          }
          // The families with a WHY: each hint states what makes the
          // surface genuinely non-static (or what to use instead).
          const globalHints: Record<string, string | undefined> = {
            BigInt: "arbitrary-precision integers have no static representation — f64 is the one number type (Number.MAX_SAFE_INTEGER bounds exact integers)",
            Proxy: "property-access metaprogramming has no static lowering (every property read must resolve at compile time)",
            Reflect: "reflective property access has no static lowering — read and call members directly",
            Intl: "locale- and ICU-backed behavior lives outside the static runtime (the localeCompare stance: code-unit order, no collation/locale data) — what lowers: the composed new Intl.NumberFormat(\"en-US\").format(x) and x.toLocaleString(\"en-US\") with default options",
            SharedArrayBuffer: "no shared-memory threads exist in a compiled program — Uint8Array is the byte storage",
            ArrayBuffer: "no free-standing ArrayBuffer value exists — typed arrays own their storage (new Uint8Array(n) allocates; new Uint8Array(new ArrayBuffer(n)) erases the buffer into the view)",
            WeakRef: "deref()-after-collect exposes GC timing — genuinely dynamic; hold a strong reference instead",
            FinalizationRegistry: "finalization callbacks expose GC timing — genuinely dynamic; release resources explicitly instead",
            eval: "runtime code evaluation cannot be compiled ahead of time",
          };
          L.noLowering(expr.text, expr, globalHints[expr.text], sym ?? undefined);
        }
      }
      // An ambient global nothing defines compiles to exactly what Node does
      // at the access: the catchable ReferenceError "<name> is not defined".
      // Stdlib/@types/node ambients never reach here (their chokepoint
      // is above); only user-file declares do.
      {
        const sym = L.resolveValueSymbol(expr);
        const decl = sym ? L.checker.declarationsOf(sym)[0] : undefined;
        if (
          decl !== undefined &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer === undefined &&
          ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient
        ) {
          const declared = L.mapTypeOf(L.typeOf(expr));
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
        if (ambientUndefinedFnSymbolOf(L, expr)) {
          const t = ambientUndefReadType(L, expr);
          if (t) return nsUndefRead(L, expr.text, expr, t);
        }
      }
      // A read of a TRAP binding — a declaration whose own initializer
      // provably threw (module init unwound there), so this reference can
      // never execute: any lowering is sound, and the trap keeps the
      // shape honest. Typed by the use site when it maps, the F64 dummy
      // otherwise (never observed — never even reached).
      {
        const sym = L.resolveValueSymbol(expr);
        if (sym !== null && L.trapBindings.has(sym)) {
          const t = ambientUndefReadType(L, expr) ?? contextualUndefReadType(L, expr) ?? F64;
          return nsUndefRead(L, expr.text, expr, t);
        }
      }
      // A program CLASS NAME as a value: the classRef over the class's
      // immortal class object (member accesses and construction never
      // reach here — their hooks claim the property/new forms first).
      {
        const sym = L.resolveValueSymbol(expr);
        const classInfo = sym ? L.classBySymbol.get(sym) : undefined;
        // A GENERIC class name whose CONTEXTUAL type pins one instantiation
        // (`const B: new (v: string) => Counter<string> = Counter`): the
        // value is that instantiation's class object — the generic-fn
        // pinning rule on the static side. Unpinned references fall
        // through to classValueRef's family fence.
        if (classInfo?.generic) {
          const ctxT = L.checker.getContextualType(expr);
          const mapped = ctxT ? L.mapTypeOf(ctxT) : null;
          const instInfo = mapped?.kind === "classval" ? L.classes.get(mapped.className) : undefined;
          if (instInfo && instInfo.genericInstance?.family === classInfo) {
            return L.classValueRef(instInfo, expr);
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
          return L.classValueRef(classInfo, expr);
        }
        // The enum OBJECT as a value (member reads never reach here — the
        // access hooks fold them): iteration, storage, reverse lookups
        // through variables all land on this pointed fence.
        if (sym) fenceEnumObjectValue(L, expr, sym);
        // A MIXIN function as a first-class value: no runtime function
        // exists — calls instantiate a class per call site
        // (lower-mixins.ts). Generic mixins took the generic-fn value
        // fence above; this names the non-generic spelling.
        if (mixinFnOfCallee(L, expr)) {
          L.unsupported(
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
        const ns = lowerNsIdentifierValue(L, expr);
        if (ns) return ns;
      }
      // Preflight guarantees no unresolved identifiers; anything else here
      // is a blocked declaration's binding (the SC2004 cascade) or a
      // binding form we don't model yet.
      L.rejectUnresolved(expr, `the reference to '${expr.text}' (a binding form with no lowering)`);
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      return L.lowerLambda(expr);
    }
    // `class {…}` in expression position: a class definition plus a
    // classRef over it (top-level evaluation positions only — each
    // evaluation mints a distinct class in JS, and the immortal class
    // object is exact exactly when the expression evaluates once).
    if (ts.isClassExpression(expr)) {
      return L.lowerClassExpression(expr);
    }
    // `identity<number>` / `Box<number>` — an INSTANTIATION EXPRESSION (a
    // generic function or class reference with explicit type arguments, in
    // value position): the expression's own checker type is the
    // substituted signature, so it pins the instance like a
    // contextually-typed reference. For a generic CLASS the value is the
    // instantiation's class object (classRef — construction, statics,
    // identity and instanceof through it ride the classval machinery).
    if (ts.isExpressionWithTypeArguments(expr) && ts.isIdentifier(expr.expression)) {
      const gfn = L.genericFnOf(expr.expression);
      if (gfn) return L.lowerGenericFnValue(expr, gfn);
      const clsSym = L.resolveValueSymbol(expr.expression);
      const cls = clsSym ? L.classBySymbol.get(clsSym) : undefined;
      if (cls?.generic) {
        const t = L.typeOf(expr);
        const mapped = L.mapTypeOf(t);
        const instInfo = mapped?.kind === "classval" ? L.classes.get(mapped.className) : undefined;
        if (!instInfo) L.badType(expr, t);
        return L.classValueRef(instInfo, expr);
      }
    }
    if (expr.kind === ts.SyntaxKind.ThisKeyword) {
      // Only arrows can see an enclosing method's `this` (JS lexical-this);
      // `this` in plain nested functions is already a tsc error under
      // noImplicitThis, so the generic scope walk here is preflight-safe.
      const local = L.resolveThis();
      if (local) return { kind: "varRef", localId: local.id, type: local.type, loc };
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
      L.unsupported("SC1080", expr);
    }
    if (expr.kind === ts.SyntaxKind.SuperKeyword) {
      // super(...) and super.method(...) are handled at their call sites;
      // any other super position (field reads, bare references) stays out.
      L.unsupported("SC1090", expr, "'super' outside super() and super.method() calls");
    }
    if (ts.isNewExpression(expr)) return L.lowerNew(expr);
    if (ts.isAwaitExpression(expr)) {
      if (!L.ctx.isAsync) {
        // A tsc-clean occurrence here is outside both an async function
        // and an async module initializer. CommonJS/script files are
        // normally rejected by tsc before lowering; keep the defensive
        // boundary for malformed/upstream ASTs.
        L.unsupported("SC1090", expr, "top-level await (await outside async functions)");
      }
      const value = L.lowerExpr(expr.expression);
      // A promise-or-absent union (`Promise<T> | undefined` values, calls
      // of `(...) => Promise<void> | void` callbacks): the await handles
      // both arms — the promise arm parks like any await, a unit arm takes
      // exactly one microtask hop (JS: await of a non-thenable) and yields
      // itself. The result is void when the inner is void and the only
      // unit is undefined; otherwise the union of the inner type and the
      // unit arms — what the checker types the await as.
      if (value.type.kind === "union") {
        const def = L.unions.get(value.type.unionId);
        const promiseTag = def ? def.arms.findIndex((a) => a.kind === "promise") : -1;
        if (
          def &&
          promiseTag >= 0 &&
          def.arms.every((a, i) => i === promiseTag || isUnitType(a))
        ) {
          const promiseArm = def.arms[promiseTag]!;
          const inner = promiseArm.kind === "promise" ? promiseArm.inner : VOID;
          const units = def.arms.filter(isUnitType);
          if (inner.kind === "union" || inner.kind === "dyn" || inner.kind === "jsval") {
            // A union inner would need an arm-wise re-tag into the result
            // union; dyn/jsval inners have their own boundary stories.
            L.unsupported(
              "SC1090",
              expr,
              `awaiting '${L.fmt(value.type)}' (the promise's inner type has no combined result union — await the promise arm after narrowing instead)`,
            );
          }
          let type: IrType;
          if (inner.kind === "void" && units.every((u) => u.kind === "undefinedT")) {
            type = VOID;
          } else if (inner.kind === "void") {
            // `Promise<void> | null`: the result would mix undefined and
            // null units with no non-unit arm — degenerate; keep it out.
            L.unsupported(
              "SC1090",
              expr,
              `awaiting '${L.fmt(value.type)}' (narrow the null away first)`,
            );
          } else {
            const arms = [inner, ...units];
            arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
            type = { kind: "union", unionId: L.unions.intern(arms) };
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
          const mapped = L.mapTypeOf(L.typeOf(expr.expression));
          const inner: IrType = mapped?.kind === "promise" && mapped.inner.kind === "void" ? VOID : JSVAL;
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
          const uT = unitOnlyUnion(L.unions);
          const wrapped = L.coerceToExpected(value, uT);
          const vLocal = L.declareHiddenLocal("%awaited", uT);
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
          const vLocal = L.declareHiddenLocal("%awaited", value.type);
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
    if (ts.isYieldExpression(expr)) return lowerYield(L, expr);
    if (ts.isPrefixUnaryExpression(expr)) return L.lowerPrefixUnary(expr);
    // `x++` / `x--` in expression position: yields the OLD value.
    if (ts.isPostfixUnaryExpression(expr)) return lowerIncDec(L, expr, false);
    if (ts.isBinaryExpression(expr)) return L.lowerBinary(expr);
    if (ts.isCallExpression(expr)) {
      // The tail of an optional chain whose `?.` sits deeper
      // (`x?.trim().toLowerCase()`): the whole tail short-circuits with
      // the guard, so it lowers as one chain (dyn/island receivers keep
      // their own undefined-propagating reads — see chainTailClaimed).
      if (chainTailClaimed(L, expr)) return L.lowerOptionalChain(expr);
      return L.lowerCall(expr);
    }
    if (ts.isArrayLiteralExpression(expr)) return L.lowerArrayLiteral(expr);
    if (ts.isObjectLiteralExpression(expr)) return L.lowerObjectLiteral(expr);
    if (ts.isElementAccessExpression(expr)) return L.lowerElementAccess(expr);
    if (ts.isConditionalExpression(expr)) return lowerTernary(L, expr);

    if (ts.isPropertyAccessExpression(expr)) {
      // `super.x`: the base chain's GETTER, called directly (super
      // dispatch is static in JS — never through the dynamic class).
      // super.method() calls are routed at the call site; a bare super
      // property read lands here.
      if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
        return L.lowerSuperAccessorRead(expr);
      }
      // Enum member reads (`E.A`) fold to their compile-time constants —
      // claimed FIRST so no receiver-shaped path (records, islands, the
      // identifier fence on the enum object) sees them. lower-enums.ts.
      {
        const en = lowerEnumAccess(L, expr);
        if (en) return en;
      }
      // `require.main.filename` / `require.main?.filename` — CommonJS
      // entry-module identity: in a compiled binary require.main IS the
      // entry module (never undefined in a CJS graph, so the chain's guard
      // folds away), and its filename is the ENTRY file's real path —
      // Node's exact value when the same tree runs in place, exactly the
      // __filename stance. Checked BEFORE the optional-chain gate: the
      // checker types the chain `string | undefined`, but the value is a
      // compile-time string.
      if (isRequireMainFilename(L, expr)) {
        return { kind: "strLit", value: L.entry.fileName, type: STRING, loc };
      }
      // Optional chaining `a?.b`: the guard lowers here (a tag test around
      // the plain property lowering below); the handled marker keeps this
      // re-entrant dispatch from looping.
      if (expr.questionDotToken && !L.chainHandled.has(expr)) {
        return L.lowerOptionalChain(expr);
      }
      // `a?.b.c` — the tail of a chain whose token sits deeper: the whole
      // tail short-circuits with the guard.
      if (!expr.questionDotToken && chainTailClaimed(L, expr)) {
        return L.lowerOptionalChain(expr);
      }
      // Island receiver: o.x is an engine property read (getProp may throw
      // — reading off null/undefined — bridged catchably like everything
      // at the boundary). `o?.x` arrives here too, through the chain
      // lowering's re-dispatch (a questionDotToken past the gate above is
      // always chain-handled; the receiver reads back as the chain's
      // bound handle).
      if (L.isIslandExpr(expr.expression)) {
        const receiver = L.lowerExpr(expr.expression);
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
        const read: IrExpr = { kind: "jsOp", op: "getProp", name: expr.name.text, args: [receiver], type: JSVAL, loc };
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
          const declared = L.mapTypeOf(L.typeOf(expr));
          if (
            declared &&
            (declared.kind === "f64" || declared.kind === "bool" || declared.kind === "string" ||
              (declared.kind === "bytes" && declared.elem === "u8"))
          ) {
            return { kind: "jsExit", value: read, type: declared, loc };
          }
        }
        return read;
      }
      // `m.groups` on a match result whose regex is statically known:
      // the compile-time record projection over the honest slice (or
      // Node's undefined when the pattern has no named groups) — see
      // lowerMatchGroupsRead.
      {
        const g = lowerMatchGroupsRead(L, expr);
        if (g !== null) return g;
      }
      // `m.index` on a for-of-over-matchAll binding reads the companion-
      // index array at this iteration's cursor — always a number: every
      // drained row matched, so the lib's `.index` is never undefined
      // here (lowerForOfMatchAll).
      if (expr.name.text === "index" && !expr.questionDotToken && ts.isIdentifier(expr.expression)) {
        const sym = L.checker.getSymbolAtLocation(expr.expression);
        const companion = sym !== undefined ? L.matchAllIndexBindings.get(sym) : undefined;
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
        !L.ctx.argumentsLocal &&
        L.typeOf(expr.expression).getSymbol()?.name === "IArguments" &&
        L.isStdlibSymbol(L.typeOf(expr.expression).getSymbol())
      ) {
        let fn: ts.Node | undefined = expr.parent;
        while (
          fn !== undefined &&
          !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn) &&
          !ts.isMethodDeclaration(fn) && !ts.isConstructorDeclaration(fn) &&
          !ts.isGetAccessorDeclaration(fn) && !ts.isSetAccessorDeclaration(fn)
        ) {
          fn = ts.isSourceFile(fn) ? undefined : fn.parent;
        }
        if (fn !== undefined) {
          const fixedArity = (fn as ts.FunctionLikeDeclaration).parameters.every(
            (p) => p.questionToken === undefined && p.initializer === undefined &&
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
          L.unsupported(
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
      if (!expr.questionDotToken && L.cjsLocalModuleBindingOf(expr.expression)) {
        // A binding whose dep is a class-expression WHOLE export
        // (`module.exports = class {…}`): the member surface is the
        // CLASS's — `C.name` folds to NamedEvaluation's answer and own
        // statics read their globals (lowerStaticFieldRead resolves the
        // binding through the expression's own symbol). The plain
        // member-name delegation below would resolve `name` against the
        // stdlib var instead — a wrong VALUE, not a fence. Unknown
        // members fall through to the delegation (expando statics ride
        // their pre-registered export globals).
        const viaClass = lowerStaticFieldRead(L, expr);
        if (viaClass) return viaClass;
        return lowerExpr(L, expr.name);
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
      if (!expr.questionDotToken && isModuleExportsAccess(expr) && isCjsJsFile(expr.getSourceFile())) {
        const whole = cjsClassExprWholeExportOf(expr.getSourceFile());
        if (whole) {
          let inBody = false;
          for (let p: ts.Node = expr.parent; !ts.isSourceFile(p); p = p.parent) {
            if (ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
              inBody = true;
              break;
            }
          }
          if (inBody || expr.getStart() > whole.stmt.getEnd()) {
            return L.classValueRef(L.lowerClassExpressionInfo(whole.classExpr), expr);
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
            !L.resolveLocal(expr.expression) &&
            !L.globalOf(expr.expression));
        const writePos =
          ts.isBinaryExpression(expr.parent) &&
          expr.parent.left === expr &&
          expr.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (!expr.questionDotToken && cjsMemberRecv && !writePos && isCjsJsFile(sf)) {
          const sym =
            L.checker.getSymbolAtLocation(expr.name) ??
            L.cjsModuleExportSymbol(sf, expr.name.text);
          const resolved =
            sym !== undefined && sym.flags & ts.SymbolFlags.Alias
              ? L.checker.getAliasedSymbol(sym)
              : sym;
          const g =
            (sym ? L.globalsBySymbol.get(sym) : undefined) ??
            (resolved ? L.globalsBySymbol.get(resolved) : undefined);
          if (g) return { kind: "varRef", localId: g.id, type: g.type, loc };
        }
      }
      // Namespace-qualified reads (`N.x`, `A.B.C.f`, import= alias
      // chains): the member is a compile-time-known declaration of a
      // lowered namespace block — it resolves exactly like a bare
      // identifier reference (globals, function values, classes), guarded
      // by the namespace source-order fences (lower-namespaces.ts).
      if (!expr.questionDotToken) {
        const nsMember = nsMemberIdentOf(L, expr);
        if (nsMember) {
          const memberSym = L.checker.getSymbolAtLocation(nsMember);
          if (memberSym) fenceEarlyNsMemberRef(L, expr, memberSym);
          return lowerExpr(L, nsMember);
        }
        // Expando function members (`foo.bar` after `foo.bar = 12`): the
        // member's module global (lower-expando.ts), before the ambient-
        // namespace fence — a declare-namespace merge over a real function
        // (`declare namespace Foo { var baz: number }` + `function Foo`)
        // reads its assigned members, not the ambient ReferenceError.
        {
          const ex = expandoMemberRead(L, expr);
          if (ex) return L.maybeNarrow(ex, expr);
        }
        // An AMBIENT namespace receiver (`M.x` where only `declare
        // namespace M` exists): the namespace object never exists at
        // runtime — Node's exact catchable ReferenceError at the access,
        // the ambient `declare const` stance.
        const ambientRoot = ambientNsRootOf(L, expr.expression);
        if (ambientRoot !== null) {
          const t = ambientUndefReadType(L, expr);
          if (t) return nsUndefRead(L, ambientRoot.text, expr, t);
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
        const ex = lowerReplacedExportsRead(L, expr);
        if (ex) return ex;
      }
      // `this.<name>` inside a CJS export-table getter: Node binds the
      // receiver to module.exports — the read is the sibling getter's
      // lifted call.
      {
        const tm = lowerCjsExportTableThisMember(L, expr);
        if (tm) return tm;
      }
      const handled =
        L.lowerProcessEnvGet(expr) ??
        L.lowerServerProperty(expr) ??
        // diagnostics_channel Channel receivers — name/hasSubscribers
        // over the f64 channel handle.
        L.lowerDcChannelProperty(expr) ??
        // TracingChannel receivers — the five event channels and
        // hasSubscribers over the f64 tracing handle.
        L.lowerDcTracingChannelProperty(expr) ??
        L.lowerTestCtxProperty(expr) ??
        L.lowerProcessProperty(expr) ??
        L.lowerProcessStreamProperty(expr) ??
        L.lowerFsConstantsProperty(expr) ??
        // http2.constants.NGHTTP2_CANCEL (any constants-object spelling):
        // the baked-literal table.
        L.lowerBuiltinConstantsProperty(expr) ??
        // Builtin namespace imports (`path.sep`, `os.EOL`,
        // `fs.constants.R_OK` where the root is `import * as ...`): the
        // same constants and per-member fences as named builtin imports.
        L.lowerNamespaceBuiltinProperty(expr) ??
        L.lowerJsonProperty(expr) ??
        L.lowerErrorCodeProperty(expr) ??
        L.lowerNumberStaticProperty(expr) ??
        L.lowerMathProperty(expr) ??
        L.lowerIntrinsicProperty(expr) ??
        // The _readableState/_writableState scalar READS (the suite's
        // asserts) — checked before the generic stream property surface:
        // the inner access maps no type of its own.
        lowerStreamStateProperty(L, expr) ??
        lowerStreamObjectProperty(L, expr) ??
        L.lowerUnionProperty(expr) ??
        L.lowerFieldRead(expr);
      // A union-typed field read narrows like an identifier when the
      // checker has narrowed this use to one arm.
      if (handled) return L.maybeNarrow(handled, expr);
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
        stdlibGlobalNameOf(L, expr.expression) === "globalThis" &&
        isJsSourceFile(expr.getSourceFile())
      ) {
        const canonical = stdlibGlobalNameOf(L, expr);
        if (canonical !== null) {
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
          (L.mapTypeOf(L.typeOf(expr.expression)) === null ||
            // A never-tainted receiver type maps (never rides as f64) but
            // its VALUE lowered checked-dynamic — same dyn read.
            neverTaintedJsType(L, expr.expression, L.typeOf(expr.expression)))) ||
        (expr.name.text === "length" &&
          (L.checkerAnyArray(expr.expression) ||
            (L.checker.isArrayType(L.typeOf(expr.expression)) &&
              L.mapTypeOf(L.typeOf(expr.expression))?.kind === "dyn")))
      ) {
        const recv = L.lowerExpr(expr.expression);
        if (recv.type.kind === "dyn") {
          const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
          const opt = chainGuardedByQuestionDot(expr.expression);
          return L.maybeNarrow(
            { kind: "dynKeyGet", key, ...(opt ? { optional: true as const } : {}), value: recv, type: DYN, loc },
            expr,
          );
        }
      }
      // `f.name` / `f.length` / own properties on a FUNCTION-typed JS
      // value (the mustCall wrapper's function-instance members): read
      // through the dyn box — the closure's own-property table answers
      // first (defineProperties writes land there), then the box's
      // best-effort static name and the declared arity; anything else is
      // the own-property answer, undefined. Function.prototype METHOD
      // names stay fenced (a stored-member undefined would mis-answer
      // `f.call` as a value). JS files only; TS keeps the fence.
      if (
        !["apply", "bind", "call", "toString", "constructor", "prototype", "caller", "arguments"].includes(expr.name.text) &&
        isJsSourceFile(expr.getSourceFile())
      ) {
        const probed = probeLower(L, expr.expression);
        if (
          probed?.type.kind === "func" &&
          canBoxFuncIntoDyn(probed.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
        ) {
          const fnName = jsFuncNameOf(expr.expression);
          const boxed: IrExpr = {
            kind: "dynFrom",
            value: probed,
            type: DYN,
            ...(fnName !== null ? { fnName } : {}),
            loc,
          };
          const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
          return L.maybeNarrow({ kind: "dynKeyGet", key, value: boxed, type: DYN, loc }, expr);
        }
      }
      // A NARROWED IteratorResult receiver (`if (!r.done) r.value` — the
      // checker narrows to IteratorYieldResult/IteratorReturnResult, whose
      // own type cannot map: the shared record shape needs BOTH channels):
      // the receiver's LOWERED record still carries the field, so the read
      // is an ordinary recordGet — maybeNarrow then bridges the union slot
      // to the checker's narrowed arm, exactly like a union field read.
      if (expr.name.text === "done" || expr.name.text === "value") {
        const recvSym = L.typeOf(expr.expression).getSymbol();
        if (
          (recvSym?.name === "IteratorYieldResult" || recvSym?.name === "IteratorReturnResult") &&
          L.checker.declarationsOf(recvSym).some(
            (d) => ts.isInterfaceDeclaration(d) && L.isStdlibFile(d.getSourceFile()),
          )
        ) {
          const recv = L.lowerExpr(expr.expression);
          if (recv.type.kind === "record") {
            const shape = L.shapes.get(recv.type.shapeId);
            const field = shape?.fields.find((f) => f.name === expr.name.text);
            if (field) {
              return L.maybeNarrow(
                { kind: "recordGet", obj: recv, shapeId: recv.type.shapeId, field: field.name, type: field.type, loc },
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
        const ambientRoot = ambientUndefVarRootOf(L, expr);
        if (ambientRoot !== null) {
          const t = ambientUndefReadType(L, expr) ?? contextualUndefReadType(L, expr);
          if (t) return nsUndefRead(L, ambientRoot.text, expr, t);
        }
      }
      // parseArgs results/tokens live in the checked-dynamic tree. A token
      // discriminant check narrows its checker type to one anonymous arm,
      // whose ambient property symbols would otherwise hit SC2020 before
      // the generic dyn receiver path below. Provenance is limited to the
      // node:util parseArgs family; every other stdlib member keeps its
      // ordinary surface fence.
      if (isParseArgsDynProperty(L, expr)) {
        const recv = L.lowerExpr(expr.expression);
        if (recv.type.kind === "dyn") {
          const key: IrExpr = {
            kind: "strLit",
            value: expr.name.text,
            type: STRING,
            loc: locOf(expr.name),
          };
          const opt = chainGuardedByQuestionDot(expr.expression);
          return L.maybeNarrow(
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
        const unit = nullishGenericBindingUnitOf(L, L.resolveValueSymbol(expr.expression));
        if (unit !== null) {
          const t = ambientUndefReadType(L, expr) ?? contextualUndefReadType(L, expr) ?? F64;
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
      L.fenceStaticAbortControllerMemberRead(expr);
      L.fenceStaticResponseMember(expr, "read");
      L.fenceStaticHeadersMember(expr, "read");
      L.fenceStaticReadableStreamMember(expr, "read");
      L.stdlibMemberFence(expr);
      // The npm chokepoint: a member on a package-typed receiver in a
      // static build — attributed to the package, like every other site.
      L.npmMemberFence(expr);
      // A property read rooted at a BLOCKED binding: the declaration
      // carries the real diagnostic — the SC2004 cascade, not a generic
      // "property access" rejection.
      {
        let root: ts.Expression = expr.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && L.isBlockedBinding(L.resolveValueSymbol(root))) {
          L.pushDiag(blockedBindingUseDiag(root.text, loc));
          throw new PoisonError();
        }
      }
      // Nothing claimed the member. Lower the RECEIVER before rejecting:
      // when the receiver itself is the blocker (`(await import(x)).y` —
      // the dynamic import is the unsupported part), ITS diagnostic is the
      // honest one, not a generic recitation about the outer dot. A
      // receiver that lowers cleanly means the MEMBER is the gap — name
      // the property and the receiver's type instead of "property access".
      const recvLowered = L.lowerExpr(expr.expression);
      // A dyn receiver — JSON.parse's `any`, or `unknown` the checker
      // narrowed to `object` — reads through the dyn keyed read: member
      // or undefined (JS's own-property answer), throwing JS's TypeError
      // on undefined/null receivers unless an earlier `?.` guards the
      // chain. Scalar-narrowed occurrences bridge via maybeNarrow's
      // validated dynCheck as usual.
      if (recvLowered.type.kind === "dyn") {
        const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
        const opt = chainGuardedByQuestionDot(expr.expression);
        return L.maybeNarrow(
          { kind: "dynKeyGet", key, ...(opt ? { optional: true as const } : {}), value: recvLowered, type: DYN, loc },
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
        const recvShape = L.shapes.get(recvLowered.type.shapeId);
        const field = recvShape?.fields.find((f) => f.name === expr.name.text);
        if (field) {
          return L.maybeNarrow(
            { kind: "recordGet", obj: recvLowered, shapeId: recvLowered.type.shapeId, field: field.name, type: field.type, loc },
            expr,
          );
        }
        if (recvShape?.indexValue !== undefined && !recvShape.tuple) {
          return L.maybeNarrow(
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
      }
      // An ABSTRACT property through an abstract-typed receiver: the
      // declaration is erased at runtime — Node defines no field for it,
      // each concrete subclass declares its OWN (at its own layout
      // position), so no shared base slot exists to read. Abstract
      // ACCESSORS are the supported spelling: they declare a vtable slot.
      if (recvLowered.type.kind === "object" && abstractPropertyDeclOf(L, expr)) {
        L.unsupported(
          "SC1090",
          expr,
          `reading the abstract property '${expr.name.text}' through a '${L.checker.typeToString(L.typeOf(expr.expression))}'-typed receiver (abstract property declarations are erased at runtime, so no shared slot exists — type the receiver as the concrete class, or declare an abstract getter instead)`,
        );
      }
      L.unsupported(
        "SC1090",
        expr,
        `reading '${expr.name.text}' from a value of type '${L.checker.typeToString(L.typeOf(expr.expression))}'`,
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
      L.unsupported(
        "SC1090",
        expr,
        name === "new.target"
          ? "'new.target' (no runtime invocation record exists in compiled code)"
          : `'${name}' (module-loader metadata has no equivalent in a compiled binary)`,
      );
    }

    const entry = UNSUPPORTED_EXPR[expr.kind];
    if (entry) L.unsupported(entry.code as `SC${number}` & keyof typeof UNSUPPORTED, expr, entry.feature);
    L.unsupported("SC1090", expr, `syntax '${ts.SyntaxKind[expr.kind]}'`);
  }

/** `c ? a : b` — see the inline comments. `expected` plays the contextual
   * array type's role when the caller knows the slot's array type and tsc's
   * API doesn't surface it (a ternary as a SPREAD source — lowerArrayLiteral
   * threads the literal's own type in). */
  function lowerTernary(L: Lowerer, expr: ts.ConditionalExpression,
    expected?: IrType & { kind: "array" },): IrExpr {
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
          L.stdlibGlobalMember(c.expression, "Array") === "isArray"
        ) {
          const argIdent = c.arguments[0] as ts.Identifier;
          const sym = L.resolveValueSymbol(argIdent);
          const t = L.checker.getTypeAtLocation(argIdent);
          const constituents = t.isUnionType() ? ts.constituentTypes(t) : [];
          const nonArray = constituents.filter((a) => !L.checker.isArrayType(a) && !L.checker.isTupleType(a));
          const mapped = L.mapTypeOf(t);
          const armCount = mapped?.kind === "union" ? L.arrayValueTags(mapped.unionId).length : 0;
          if (sym && nonArray.length === 1 && armCount === 1) {
            falseArmNarrowType = nonArray[0]!;
            const collect = (n: ts.Node): void => {
              if (ts.isFunctionLike(n)) return;
              if (ts.isIdentifier(n) && L.resolveValueSymbol(n) === sym && !L.chainNarrowedType.has(n)) {
                falseArmNarrows.push(n);
              }
              n.forEachChild(collect);
            };
            collect(expr.whenFalse);
          }
        }
      }
      for (const n of falseArmNarrows) L.chainNarrowedType.set(n, falseArmNarrowType!);
      try {
      const cond = L.lowerCondition(expr.condition);
      // A condition the LOWERING proved constant (typeof-dyn against a
      // kind no dyn box can hold — the bigint/symbol/function fold): only
      // the taken arm exists at runtime, so only it lowers — which is
      // exactly what lets a dual-mode arm with no static lowering (bigint
      // literals) sit untaken in compiled JS. A boolLit carries no
      // effects, so dropping the condition read loses nothing.
      if (cond.kind === "boolLit") {
        return L.lowerExpr(cond.value ? expr.whenTrue : expr.whenFalse);
      }
      const ctxTs = L.checker.getContextualType(expr);
      const ctxMapped = ctxTs ? L.mapTypeOf(ctxTs) : null;
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
      const ctxArray = expected ?? (ctxMapped?.kind === "array" ? ctxMapped : null);
      const armLiteral = (e: ts.Expression): ts.ArrayLiteralExpression | null => {
        let x = e;
        while (ts.isParenthesizedExpression(x)) x = x.expression;
        return ts.isArrayLiteralExpression(x) ? x : null;
      };
      const emptyUntypedArrayArm = (e: ts.Expression): boolean => {
        const lit = armLiteral(e);
        if (!lit || lit.elements.length !== 0) return false;
        const t = L.checker.getContextualType(lit) ?? L.typeOf(lit);
        if (!L.mapTypeOf(t)) return true;
        // never[] MAPS (the f64 representation for the uninhabited) but
        // carries no element information — an empty literal typed that way
        // still adopts the sibling arm's array type, tsc's own reading.
        if (L.checker.isArrayType(t)) {
          const elem = L.checker.getTypeArguments(t as ts.TypeReference)[0];
          if (elem !== undefined && elem.flags & ts.TypeFlags.Never) return true;
        }
        return false;
      };
      const lowerArm = (e: ts.Expression, siblingType?: IrType): IrExpr => {
        const lit = armLiteral(e);
        if (lit && ctxArray) return L.lowerArrayLiteral(lit, ctxArray);
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
          const ownT = L.mapTypeOf(L.typeOf(lit));
          if (
            ownT?.kind === "array" &&
            ownT.elem.kind === "union" &&
            siblingType.elem.kind !== "union" &&
            L.armTag(ownT.elem.unionId, siblingType.elem) >= 0
          ) {
            return L.lowerArrayLiteral(lit, siblingType);
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
          if (ownT?.kind === "array" && !typeEquals(ownT, siblingType) && L.widthLiftPlan(ownT, siblingType) === null) {
            return L.lowerArrayLiteral(lit, siblingType);
          }
        }
        return L.lowerExpr(e);
      };
      // Lower the filled arm first so an empty arm can adopt its type.
      // When the checker's OWN join for the ternary maps to an ARRAY,
      // literal arms build against it directly (tsc collapses the arms'
      // covariant array types into one — `c ? ['sh', []] : ['cmd', ['/d']]`
      // joins as (string | string[])[] whichever arm nests the empty
      // literal), so neither arm's uninhabited never[] reading decides.
      const ownArrayJoin = (() => {
        const m = L.mapTypeOf(L.typeOf(expr));
        return m?.kind === "array" ? m : null;
      })();
      let thenRaw: IrExpr;
      let elseRaw: IrExpr;
      const runtimeTrueIds = runtimeOptionalTrueIds(L, expr.condition);
      const lowerTrueArm = (): IrExpr => withRuntimeOptionalNarrowed(
        L,
        runtimeTrueIds,
        () => lowerArm(expr.whenTrue, ownArrayJoin ?? undefined),
      );
      if (!ctxArray && emptyUntypedArrayArm(expr.whenTrue) && !emptyUntypedArrayArm(expr.whenFalse)) {
        elseRaw = L.lowerExpr(expr.whenFalse);
        thenRaw = withRuntimeOptionalNarrowed(L, runtimeTrueIds, () => lowerArm(expr.whenTrue, elseRaw.type));
      } else {
        thenRaw = lowerTrueArm();
        elseRaw = lowerArm(expr.whenFalse, thenRaw.type);
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
      const own = L.mapTypeOf(L.typeOf(expr));
      const useCtx =
        (ctxMapped?.kind === "record" || ctxMapped?.kind === "union" || ctxMapped?.kind === "object") &&
        (own === null ||
          (own.kind === "union" && !typeEquals(own, ctxMapped) && !L.inLogicalLeftPosition(expr)));
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
        ((e.kind === "recordLit" || e.kind === "arrayLit") && L.dynConvertible(e.type));
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
        own === null && !dynJoin && !(useCtx && ctxMapped) &&
        (L.typeOf(expr).flags & ts.TypeFlags.Any) !== 0
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
              val.kind === "union" ? (L.unions.get(val.unionId)?.arms ?? null) : [val];
            if (arms && !arms.some((x) => typeEquals(x, unit))) {
              anyJoin = { kind: "union", unionId: L.unions.intern([...arms, unit]) };
            } else if (arms) {
              anyJoin = val; // the unit is already an arm
            }
          }
        }
      }
      const type =
        thenRaw.type.kind === "array" && typeEquals(thenRaw.type, elseRaw.type)
          ? thenRaw.type
          : dynJoin
            ? DYN
            : (anyJoin ??
              (useCtx && ctxMapped
                ? ctxMapped
                : L.irTypeOf(expr)));
      // Each arm flows into the ternary's type through the slot-coercion
      // path: union arms wrap, dyn slots reject the non-dyn arm with
      // SC1101, mismatched record shapes get SC2002; coerceInto is
      // inert when the types already agree.
      const intoDyn = (e: IrExpr): IrExpr =>
        e.type.kind === "dyn" ? e : { kind: "dynFrom", value: e, type: DYN, loc: e.loc };
      const then = dynJoin ? intoDyn(thenRaw) : L.coerceInto(expr.whenTrue, thenRaw, type);
      const else_ = dynJoin ? intoDyn(elseRaw) : L.coerceInto(expr.whenFalse, elseRaw, type);
      if (then.type.kind !== type.kind || else_.type.kind !== type.kind) {
        L.badType(expr, L.typeOf(expr));
      }
      return { kind: "ternary", cond, then, else_, type, loc };
      } finally {
        for (const n of falseArmNarrows) L.chainNarrowedType.delete(n);
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
  export function maybeNarrow(L: Lowerer, expr: IrExpr, node: ts.Node): IrExpr {
    // A dyn read tsc narrowed to a SCALAR (a typeof test proved the kind):
    // bridge with a VALIDATED extraction — dynCheck, the checked-cast
    // machinery — rather than a trusted one. After the guard the check
    // never fires; a read smuggled past it throws a catchable TypeError
    // instead of misreading the payload (the dyn boundary's usual stance).
    // Object/array narrowings stay dyn-typed and keep their fences.
    if (expr.type.kind === "dyn") {
      const narrowed = L.mapTypeOf(L.typeOf(node));
      if (
        narrowed &&
        (narrowed.kind === "f64" || narrowed.kind === "bool" || narrowed.kind === "string")
      ) {
        return { kind: "dynCheck", value: expr, type: narrowed, loc: expr.loc };
      }
      // An `instanceof Uint8Array` narrow: the checked-dynamic tree's bytes kind, extracted
      // with the same validated copy the checked cast uses (a Buffer that
      // crossed in rides the kind too — it IS a Uint8Array in Node).
      if (narrowed?.kind === "bytes" && narrowed.elem === "u8") {
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
      const narrowed = L.mapTypeOf(L.typeOf(node));
      if (
        narrowed?.kind === "object" &&
        narrowed.className !== expr.type.className &&
        L.isSubclassOf(narrowed.className, expr.type.className)
      ) {
        return { kind: "downcast", value: expr, type: narrowed, loc: expr.loc };
      }
      return expr;
    }
    if (expr.type.kind !== "union") return expr;
    const narrowedTs = L.typeOf(node);
    const narrowed = L.mapTypeOf(narrowedTs);
    // `Array.isArray(u)` on a union with one readonly array/tuple arm: the
    // lib predicate narrows to `any[]`, either directly or intersected
    // with the original union. That checker type can map to the island's
    // array-of-handles, nothing, or a synthetic intersection record — but
    // the tag test proved the union's one array-valued arm, so bridge to it
    // with the same trusted unionNarrow the mapped case below builds.
    if (L.checkerAnyArrayType(narrowedTs)) {
      const def = L.unions.get(expr.type.unionId);
      const arrayTags = L.arrayValueTags(expr.type.unionId);
      if (arrayTags.length === 1) {
        const arm = def!.arms[arrayTags[0]!]!;
        return { kind: "unionNarrow", unionId: expr.type.unionId, tag: arrayTags[0]!, value: expr, type: arm, loc: expr.loc };
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
    const tag = L.armTag(expr.type.unionId, narrowed);
    if (tag < 0) return expr;
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
    L: Lowerer,
    expr: ts.Identifier,
    local: IrLocal,
    property: string | null,
    loc: SrcLoc,
  ): IrExpr {
    if (local.type.kind !== "union") throw new InternalCompilerError("runtime-optional local is not union-typed");
    const narrowed = L.mapTypeOf(L.typeOf(expr));
    if (!narrowed || narrowed.kind === "union" || isUnitType(narrowed)) {
      L.unsupported("SC1090", expr, "a runtime-optional capture whose narrowed value type is not representable");
    }
    const valueTag = L.armTag(local.type.unionId, narrowed);
    const undefTag = L.armTag(local.type.unionId, UNDEFINED_T);
    if (valueTag < 0 || undefTag < 0) throw new InternalCompilerError("runtime-optional local is missing its value or undefined arm");
    const def = L.unions.get(local.type.unionId);
    if (!def || def.arms.length !== 2) {
      L.unsupported("SC1090", expr, "a direct read from a runtime-optional capture with multiple value arms");
    }
    const message = property === null
      ? `${expr.text} is not a function`
      : `Cannot read properties of undefined (reading '${property}')`;
    return {
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
      then: nodeThrowExpr(
        1,
        "",
        message,
        narrowed,
        loc,
      ),
      else_: {
        kind: "unionNarrow",
        unionId: local.type.unionId,
        tag: valueTag,
        value: varRef(local.id, local.type, loc),
        type: narrowed,
        loc,
      },
      type: narrowed,
      loc,
    };
  }

  type RuntimeOptionalUse =
    | { kind: "property"; access: ts.PropertyAccessExpression; optional: boolean; complex: boolean; comma: boolean }
    | { kind: "element"; access: ts.ElementAccessExpression; optional: boolean; complex: boolean; comma: boolean }
    | { kind: "call"; access: ts.CallExpression; optional: boolean; complex: boolean; comma: boolean };

  function runtimeOptionalUseOf(expr: ts.Expression): RuntimeOptionalUse | null {
    let receiver = expr;
    let complex = false;
    let comma = false;
    for (;;) {
      const parent = receiver.parent;
      if (
        (ts.isParenthesizedExpression(parent) || ts.isAssertionExpression(parent) ||
          ts.isSatisfiesExpression(parent) ||
          ts.isNonNullExpression(parent)) &&
        parent.expression === receiver
      ) {
        receiver = parent;
        continue;
      }
      if (
        ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.right === receiver
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
          (parent.condition === receiver || parent.whenTrue === receiver || parent.whenFalse === receiver))
      ) {
        complex = true;
        receiver = parent;
        continue;
      }
      break;
    }
    const access = receiver.parent;
    if (ts.isPropertyAccessExpression(access) && access.expression === receiver) {
      return { kind: "property", access, optional: access.questionDotToken !== undefined, complex, comma };
    }
    if (ts.isElementAccessExpression(access) && access.expression === receiver) {
      return { kind: "element", access, optional: access.questionDotToken !== undefined, complex, comma };
    }
    if (ts.isCallExpression(access) && access.expression === receiver) {
      return { kind: "call", access, optional: access.questionDotToken !== undefined, complex, comma };
    }
    return null;
  }

  function runtimeOptionalElementKey(expr: ts.Expression): string | null {
    if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) return expr.text;
    if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    return null;
  }

  function runtimeOptionalAssertionErases(
    L: Lowerer,
    expr: ts.Expression,
    inner: IrExpr,
    use: RuntimeOptionalUse | null,
  ): boolean {
    if (inner.type.kind !== "union" || !use?.optional || use.complex || L.armTag(inner.type.unionId, UNDEFINED_T) < 0) return false;
    const target = L.mapTypeOf(L.typeOf(expr));
    return !!target && target.kind !== "union" && typeEquals(L.stripUndefinedArm(inner.type), target);
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
  export function lowerUnitComparison(L: Lowerer, left: IrExpr,
    right: IrExpr,
    negated: boolean,
    loc: SrcLoc,): IrExpr | null {
    const unit = left.kind === "unitLit" ? left : right.kind === "unitLit" ? right : null;
    if (!unit) return null;
    const other = unit === left ? right : left;
    if (other.kind === "unitLit") {
      // Two unit literals (`undefined === undefined`): statically decided.
      return { kind: "boolLit", value: (other.unit === unit.unit) !== negated, type: BOOL, loc };
    }
    if (other.type.kind === "union") {
      const tag = L.armTag(other.type.unionId, unit.type);
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
        if (droppableStatic(other)) return answer;
        const evalOnce: IrExpr = {
          kind: "unionIsTag", unionId: other.type.unionId, tag: 0, negated: false, value: other, type: BOOL, loc,
        };
        return { kind: "logical", op: negated ? "||" : "&&", left: evalOnce, right: answer, type: BOOL, loc };
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
      const tag = L.armTag(envRead.type.unionId, unit.type);
      if (tag >= 0) {
        return { kind: "unionIsTag", unionId: envRead.type.unionId, tag, negated, value: envRead, type: BOOL, loc };
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
  function lowerLooseNullCompare(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc,): IrExpr | null {
    const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
    const unwrap = (e: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
    const left = unwrap(expr.left);
    const right = unwrap(expr.right);
    const leftIsNull = left.kind === ts.SyntaxKind.NullKeyword;
    if (!leftIsNull && right.kind !== ts.SyntaxKind.NullKeyword) return null;
    const otherNode = leftIsNull ? right : left;
    const other = L.lowerExpr(otherNode);
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
      const def = L.unions.get(ut.unionId);
      if (!def) L.badType(otherNode, L.typeOf(otherNode));
      const tags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
      if (tags.length === 0) {
        // No unit arms: never null-ish (defensive — the fold below).
        return { kind: "boolLit", value: negated, type: BOOL, loc };
      }
      const isTag = (tag: number): IrExpr => ({
        kind: "unionIsTag", unionId: ut.unionId, tag, negated, value: other, type: BOOL, loc,
      });
      if (tags.length === 1) return isTag(tags[0]!);
      // Both null AND undefined arms: tag-in-set as a short-circuit pair
      // (De Morgan for `!=`). The operand IrExpr rides both tests, so the
      // backend emits it per test — restricted to re-emittable pure reads;
      // anything effectful gets its own actionable fence (the generic
      // SC1040 hint would wrongly suggest `== null` as the fix).
      if (!pureReemittable(other)) {
        L.unsupported(
          "SC1090",
          expr,
          `'== null' / '!= null' on a '${L.fmt(ut)}' value that isn't a plain read ` +
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
      const def = L.unions.get(envRead.type.unionId);
      const tag = def ? def.arms.findIndex((a) => isUnitType(a)) : -1;
      if (tag >= 0) {
        return { kind: "unionIsTag", unionId: envRead.type.unionId, tag, negated, value: envRead, type: BOOL, loc };
      }
    }
    // A non-nullable operand (tsc allows the comparison as a guard):
    // `== null` is statically false, `!= null` statically true.
    return { kind: "boolLit", value: negated, type: BOOL, loc };
  }

/** Safe to EMIT twice: plain reads with no side effects — local/global
   * reads and record/class field reads over such (accessor properties
   * lower to getter CALLS, so they never appear as field reads). Used by
   * the two-unit-arm `== null` composition, the union `typeof` forms, and
   * the union-switch desugar, whose operands ride several tests. */
  /** A static expression whose evaluation is unobservable — safe to DROP
   * (typeof's constant fold: JS evaluates the operand, but when nothing in
   * it can throw, call, write, or allocate observably, folding it away
   * changes nothing). Strictly wider than pureReemittable: numeric
   * arithmetic (f64 ops never throw — division by zero is Infinity),
   * string concatenation, logical/ternary composition, and unit/literal
   * leaves compose; anything with a call, an island op, an index read (can
   * trap), or an unknown kind answers false. */
  export function droppableStatic(e: IrExpr): boolean {
    switch (e.kind) {
      case "numLit":
      case "strLit":
      case "boolLit":
      case "unitLit":
        return true;
      case "bin":
        return droppableStatic(e.left) && droppableStatic(e.right);
      case "unary":
        return droppableStatic(e.operand);
      case "logical":
        return droppableStatic(e.left) && droppableStatic(e.right);
      case "ternary":
        return droppableStatic(e.cond) && droppableStatic(e.then) && droppableStatic(e.else_);
      case "strConcat":
        return droppableStatic(e.left) && droppableStatic(e.right);
      case "toBool":
        return droppableStatic(e.operand);
      case "unionIsTag":
        return droppableStatic(e.value);
      case "unionWrap":
        return droppableStatic(e.value);
      // Fresh allocations are unobservable too — only their PIECES can
      // carry effects (a spread re-reads its source: pure; element and
      // field initializers recurse).
      case "arrayLit":
        return e.elems.every(droppableStatic);
      case "recordLit":
        return e.fields.every((f) => droppableStatic(f.value));
      case "recordClone":
        return droppableStatic(e.source) && e.overrides.every((f) => droppableStatic(f.value));
      case "closure":
        return true;
      default:
        return pureReemittable(e);
    }
  }

export function pureReemittable(e: IrExpr): boolean {
    if (e.kind === "varRef") return true;
    if (e.kind === "recordGet" || e.kind === "fieldGet") return pureReemittable(e.obj);
    // The trust-the-checker narrowing bridges over a pure read: extraction
    // and downcast are reads too (the +1 on ref payloads is RC bookkeeping,
    // not an observable effect — each emission owns its own copy).
    if (e.kind === "unionNarrow" || e.kind === "downcast") return pureReemittable(e.value);
    return false;
  }

/** A side-effect-free CONDITION: the ToBoolean/test wrappers lowerCondition
   * builds over pure reads (evaluating one early or twice changes nothing
   * observable). Used by the island-literal conditional spread, whose
   * desugar hoists the condition ahead of the properties. */
  function pureCondExpr(e: IrExpr): boolean {
    if (e.kind === "boolLit") return true;
    if (e.kind === "toBool") return pureReemittable(e.operand);
    if (e.kind === "unionIsTag" || e.kind === "dynTest") return pureReemittable(e.value);
    if (e.kind === "unary" && e.op === "!") return pureCondExpr(e.operand);
    if (e.kind === "logical") return pureCondExpr(e.left) && pureCondExpr(e.right);
    if (e.kind === "jsOp" && (e.op === "truthy" || e.op === "not")) return e.args.every(pureReemittable);
    return pureReemittable(e);
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
  export function lowerNullishCoalesce(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    const left = lowerAbsenceProbe(L, expr.left) ?? L.lowerExpr(expr.left);
    if (left.type.kind === "dyn") {
      // `a ?? b` on a CHECKED-DYNAMIC left: the deciding test is the
      // runtime kind (scr_dyn_is_nullish — UNDEF/NULL take the default;
      // a wrapped island value routes to the engine's test, defensively:
      // the wrap constructor scalar-normalizes engine null/undefined
      // away). Both sides live in the checked-dynamic tree — the right converts through
      // the usual boundary and evaluates lazily in its branch; a default
      // with no dyn representation keeps the fence.
      const right = L.coerceToExpected(L.lowerExpr(expr.right), DYN);
      if (right.type.kind !== "dyn") {
        L.unsupported("SC1100", expr, "nullish coalescing on 'unknown' values against defaults with no dynamic representation");
      }
      return { kind: "nullish", left, right, type: DYN, loc };
    }
    if (left.type.kind === "jsval") {
      // `a ?? b` on an ISLAND value: the engine's own nullish test — the
      // left evaluates once, the right runs lazily in its branch and
      // marshals in (the emitter's jsval nullish arm).
      const right = L.jsvalIn(L.lowerExpr(expr.right), expr.right);
      return { kind: "nullish", left, right, type: JSVAL, loc };
    }
    if (left.type.kind !== "union") return left;
    const def = L.unions.get(left.type.unionId);
    if (!def) L.badType(expr.left, L.typeOf(expr.left));
    if (!def.arms.some(isUnitType)) return left;
    const type = L.irTypeOf(expr);
    const rest = def.arms.filter((a) => !isUnitType(a));
    if (typeEquals(type, left.type) || (rest.length === 1 && typeEquals(type, rest[0]!))) {
      const right = L.lowerExprExpecting(expr.right, type);
      return { kind: "nullish", left, right, type, loc };
    }
    // The RETAGGED shape — the default changes the result union (`s ??
    // null` over `string | undefined` answers `null | string`): every
    // non-unit arm of the left has a home in the result, so an interned
    // helper tests the unit tags and re-wraps the payload per arm. The
    // helper call evaluates the default EAGERLY where JS is lazy, so only
    // effect-free defaults (the literal null/0/"" spellings) qualify —
    // anything effectful keeps the fence.
    if (type.kind === "union") {
      const leftT = left.type;
      const armPairs = rest.map((a) => ({ arm: a, src: L.armTag(leftT.unionId, a), dst: L.armTag(type.unionId, a) }));
      if (armPairs.every((p) => p.src >= 0 && p.dst >= 0)) {
        const right = L.lowerExprExpecting(expr.right, type);
        if (droppableStatic(right)) {
          const helper = nullishRetagHelper(L, leftT, type, loc);
          return { kind: "call", callee: helper, args: [left, right], type, loc };
        }
      }
    }
    L.unsupported(
      "SC1090",
      expr,
      rest.length !== 1
        ? `'??' on '${L.fmt(left.type)}' (the non-nullish result is a sub-union; check a discriminant field first)`
        : `'??' where the default changes the result type (left is '${L.fmt(left.type)}' but the whole expression is '${L.fmt(type)}' — give both sides one type)`,
    );
  }

/** Interned `%nullish.retag.<n>(l, r)` — the retagged `??` (see
   * lowerNullishCoalesce): unit-armed left answers the pre-evaluated
   * default; every other arm narrows out of the left union and wraps into
   * the result union's matching arm. */
  function nullishRetagHelper(L: Lowerer, leftT: IrType & { kind: "union" }, resT: IrType & { kind: "union" }, loc: SrcLoc): string {
    const key = `nullish:${leftT.unionId}:${typeKey(resT)}`;
    const existing = L.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%nullish.retag.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const def = L.unions.get(leftT.unionId)!;

    const l = varRef("l.0", leftT, loc);
    const r = varRef("r.0", resT, loc);
    const body: IrStmt[] = [];
    def.arms.forEach((arm, tag) => {
      if (isUnitType(arm)) return;
      const dst = L.armTag(resT.unionId, arm);
      body.push({
        kind: "if",
        cond: { kind: "unionIsTag", unionId: leftT.unionId, tag, negated: false, value: l, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: {
              kind: "unionWrap",
              unionId: resT.unionId,
              tag: dst,
              value: { kind: "unionNarrow", unionId: leftT.unionId, tag, value: l, type: arm, loc },
              type: resT,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    });
    body.push({ kind: "return", value: r, loc });
    L.liftedFns.push({
      name,
      params: [
        { localId: "l.0", name: "l", type: leftT },
        { localId: "r.0", name: "r", type: resT },
      ],
      returnType: resT,
      locals: [
        { id: "l.0", name: "l", type: leftT, mutable: true },
        { id: "r.0", name: "r", type: resT, mutable: true },
      ],
      body,
      loc,
    });
    return name;
  }

/** One optional-chain STEP: `a?.b`, `a?.m(...)`, `a?.[i]` (the token on
   * the member access) and `f?.()` (the token on the call). The receiver
   * lowers once; when it is a unit-armed union with ONE non-unit arm, the
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
   * (see chainTailDot); sub-union receivers are fenced with rewrite
   * hints. */
  /** The unhandled `?.`-carrying MEMBER step in this node's receiver
   * spine, when the node is the TAIL of an optional chain whose token sits
   * deeper — `x?.trim().toLowerCase()` reads nothing past the guard when x
   * is nullish, so the whole tail must lower inside it. Walks
   * property/element accesses and call steps only (parens and `!` break
   * the chain per the grammar: `(a?.b).c` throws on undefined in JS);
   * the node's OWN token — and a call's immediate callee token — are the
   * plain entries' cases, not tails, and handled markers make the chain
   * lowering's re-dispatch walk past its own step. `f?.()` steps stay out
   * (a call carrying the token has no member step to re-enter — the
   * split-it fence keeps them). */
  function chainTailDot(
    L: Lowerer,
    expr: ts.Expression,
  ): ts.PropertyAccessExpression | ts.ElementAccessExpression | null {
    let cur: ts.Expression = expr;
    for (;;) {
      // An active chain's bound receiver read is a LEAF — its own token
      // was consumed by the chain that bound it.
      if (L.chainRecvByNode.has(cur)) return null;
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
          if (cur === expr || L.chainHandled.has(cur)) {
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
  export function isRequireMainFilename(L: Lowerer, expr: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "filename") return false;
    const main = expr.expression;
    if (!ts.isPropertyAccessExpression(main) || main.name.text !== "main") return false;
    if (!L.isStdlibGlobal(main.expression, "require")) return false;
    return !isNodeEsmFile(expr.getSourceFile());
  }

  /** True when `expr` is the tail of an optional chain the STATIC chain
   * machinery should short-circuit whole: an unhandled deeper `?.` whose
   * guarded receiver lowers as a unit-armed union. Dyn ('unknown') and
   * island ('any') receivers answer their tails through their own
   * undefined-propagating reads and stay out; never-nullish receivers fold
   * at the token's own entry. */
  function chainTailClaimed(L: Lowerer, expr: ts.Expression): boolean {
    const tail = chainTailDot(L, expr);
    if (!tail) return false;
    const recvT = L.mapTypeOf(L.typeOf(tail.expression));
    if (recvT?.kind !== "union") return false;
    const def = L.unions.get(recvT.unionId);
    return !!def && def.arms.some(isUnitType);
  }

  /** True when an EARLIER step of this access chain carries `?.` — JS
   * short-circuits the whole tail (`a?.b.c` reads nothing when a is
   * nullish), so a dyn tail read must answer undefined instead of
   * throwing. Walks the receiver spine only; the argument of the access
   * itself is not part of the guard. */
  function chainGuardedByQuestionDot(expr: ts.Expression): boolean {
    let cur: ts.Expression = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (
        ts.isPropertyAccessExpression(cur) ||
        ts.isElementAccessExpression(cur) ||
        ts.isCallExpression(cur)
      ) {
        if (cur.questionDotToken) return true;
        cur = cur.expression;
        continue;
      }
      return false;
    }
  }

export function lowerOptionalChain(L: Lowerer, expr: ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression,): IrExpr {
    const loc = locOf(expr);
    // The node CARRYING the ?. token and the receiver expression it guards.
    let dotNode: ts.Node;
    let recvNode: ts.Expression;
    if (ts.isCallExpression(expr) && expr.questionDotToken) {
      dotNode = expr; // f?.()
      recvNode = expr.expression;
    } else if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.questionDotToken
    ) {
      dotNode = expr.expression; // a?.m()
      recvNode = expr.expression.expression;
    } else if (
      (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
      expr.questionDotToken
    ) {
      dotNode = expr; // a?.b / a?.[i]
      recvNode = expr.expression;
    } else {
      // TAIL entry: the token sits deeper in the receiver spine and JS
      // short-circuits the WHOLE tail with it (`x?.trim().toLowerCase()`
      // reads nothing when x is nullish). The guarded member step becomes
      // the chain's dot; every step above it lowers inside the guard, its
      // checker type narrowed non-nullish below (the tag test proved it).
      const tail = chainTailDot(L, expr);
      if (!tail) {
        // A `f?.()` step under a member tail, or no token at all (a
        // dispatch bug): short-circuiting those is not modeled.
        L.unsupported(
          "SC1090",
          expr,
          "multi-step optional chains (split them: const v = a?.b; then use v?.c)",
        );
      }
      dotNode = tail;
      recvNode = tail.expression;
    }
    const receiver = L.lowerExpr(recvNode);
    if (receiver.type.kind === "dyn") {
      // `pkg?.name` / `pkg?.scripts?.[k]` on a JSON.parse result: dyn
      // represents undefined directly, so the chain step IS the keyed
      // read with the optional (unit-answers-undefined) policy — no
      // optChain wrapper needed; nested steps compose the same way.
      if (dotNode === expr && ts.isPropertyAccessExpression(expr)) {
        const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
        return L.maybeNarrow({ kind: "dynKeyGet", key, optional: true, value: receiver, type: DYN, loc }, expr);
      }
      if (dotNode === expr && ts.isElementAccessExpression(expr)) {
        const key = L.lowerExpr(expr.argumentExpression);
        if (key.type.kind === "string") {
          return L.maybeNarrow({ kind: "dynKeyGet", key, optional: true, value: receiver, type: DYN, loc }, expr);
        }
        // NUMBER-typed indices (`entries?.[0]`): the property key is
        // ToString(i), exactly JS — the canonical number text answers
        // array indices in the dyn helper, anything else (fractions,
        // negatives, NaN) reads as an absent key.
        if (key.type.kind === "f64") {
          const skey: IrExpr = { kind: "toString", operand: key, type: STRING, loc: key.loc };
          return L.maybeNarrow({ kind: "dynKeyGet", key: skey, optional: true, value: receiver, type: DYN, loc }, expr);
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
        const id = `chain.${L.chainCounter++}`;
        const recvRef: IrExpr = { kind: "chainRecv", id, type: DYN, loc: locOf(recvNode) };
        L.chainRecvByNode.set(recvNode, recvRef);
        L.chainHandled.add(dotNode);
        let body: IrExpr;
        try {
          body = L.lowerExpr(expr);
        } finally {
          L.chainRecvByNode.delete(recvNode);
          L.chainHandled.delete(dotNode);
        }
        if (body.type.kind !== "dyn") {
          if (body.type.kind !== "void" && !L.dynConvertible(body.type)) {
            L.unsupported(
              "SC1100",
              expr,
              `optional METHOD calls on 'unknown' values where the result ('${L.fmt(body.type)}' ` +
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
      L.unsupported("SC1100", expr, "optional chaining on 'unknown' values");
    }
    // An 'any' (island-handle) receiver: the nullish test asks the ENGINE
    // value at runtime — null/undefined short-circuit to the engine's
    // undefined (JS: null receivers yield undefined too), anything else
    // proceeds as the plain island operation with the receiver evaluated
    // once (argument side effects stay lazy, like every optChain). The
    // result is an island value again ('any' in, 'any' out).
    if (receiver.type.kind === "jsval") {
      const id = `chain.${L.chainCounter++}`;
      const recvRef: IrExpr = { kind: "chainRecv", id, type: JSVAL, loc: locOf(recvNode) };
      if (dotNode === expr && ts.isCallExpression(expr)) {
        // `a.b?.(...)` — a MEMBER callee: JS calls it with `this` bound to
        // `a` and short-circuits a nullish member — exactly the engine's
        // own `o.name?.()` (optCallMethod: the RECEIVER is `a`, evaluated
        // once through the chain; a nullish `a` itself short-circuits
        // earlier like any optional chain). Computed members keep a fence.
        if (ts.isPropertyAccessExpression(recvNode) || ts.isElementAccessExpression(recvNode)) {
          if (
            ts.isPropertyAccessExpression(recvNode) &&
            !recvNode.questionDotToken
          ) {
            const obj = L.lowerExpr(recvNode.expression);
            if (obj.type.kind !== "jsval") L.badType(recvNode.expression, L.typeOf(recvNode.expression));
            const args = expr.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
            return { kind: "jsOp", op: "optCallMethod", name: recvNode.name.text, args: [obj, ...args], type: JSVAL, loc };
          }
          L.unsupported(
            "SC1090",
            expr,
            "optional calls of computed 'any' member values (a[k]?.() — bind the member to a const first)",
          );
        }
        const args = expr.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
        const body: IrExpr = { kind: "jsOp", op: "callFn", args: [recvRef, ...args], type: JSVAL, loc };
        return { kind: "optChain", id, receiver, body, type: JSVAL, loc };
      }
      // Member forms (`x?.y`, `x?.y(...)`, `x?.[i]`): re-dispatch the plain
      // island lowering with the receiver node bound to the chain.
      L.chainRecvByNode.set(recvNode, recvRef);
      L.chainHandled.add(dotNode);
      let body: IrExpr;
      try {
        body = L.lowerExpr(expr);
      } finally {
        L.chainRecvByNode.delete(recvNode);
        L.chainHandled.delete(dotNode);
      }
      if (body.type.kind !== "jsval") L.badType(expr, L.typeOf(expr));
      return { kind: "optChain", id, receiver, body, type: JSVAL, loc };
    }
    const def = receiver.type.kind === "union" ? L.unions.get(receiver.type.unionId) : undefined;
    if (!def || !def.arms.some(isUnitType)) {
      // Never nullish: `?.` IS `.` — re-dispatch the plain lowering. The
      // receiver subtree above is discarded (lowering is pure IR
      // construction); the fresh dispatch lowers it again in place. The
      // checker may still SPELL the receiver nullable while the lowering
      // answers the plain value (`process.getuid?.()` is the POSIX
      // number), so narrow the node too — downstream receiver-typed
      // dispatch must agree with the lowered value, not the spelling.
      L.chainHandled.add(dotNode);
      const hadNarrow = L.chainNarrowedType.has(recvNode);
      if (!hadNarrow) {
        L.chainNarrowedType.set(
          recvNode,
          L.checker.getNonNullableType(L.checker.getTypeAtLocation(recvNode)),
        );
      }
      try {
        return L.lowerExpr(expr);
      } finally {
        L.chainHandled.delete(dotNode);
        if (!hadNarrow) L.chainNarrowedType.delete(recvNode);
      }
    }
    const rest = def.arms.filter((a) => !isUnitType(a));
    if (rest.length !== 1) {
      L.unsupported(
        "SC1090",
        expr,
        `'?.' on '${L.fmt(receiver.type)}' (the guarded receiver is a sub-union; check a discriminant field first)`,
      );
    }
    const narrowed = rest[0]!;
    const id = `chain.${L.chainCounter++}`;
    const recvRef: IrExpr = { kind: "chainRecv", id, type: narrowed, loc: locOf(recvNode) };

    // `f?.()`: the callee IS the guarded value — build the indirect call
    // directly (no member dispatch exists to re-enter).
    if (dotNode === expr && ts.isCallExpression(expr)) {
      if (narrowed.kind !== "func") L.badType(recvNode, L.typeOf(recvNode));
      const params = narrowed.params;
      const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
      const body: IrExpr = { kind: "callValue", callee: recvRef, args, type: narrowed.ret, loc };
      return L.finishOptionalChain(expr, id, receiver, body, loc);
    }

    // Member forms: re-dispatch the normal lowering with the receiver node
    // bound to the chain (reads as chainRecv, types as non-nullish).
    const narrowedTs = L.checker.getNonNullableType(L.checker.getTypeAtLocation(recvNode));
    L.chainRecvByNode.set(recvNode, recvRef);
    L.chainNarrowedType.set(recvNode, narrowedTs);
    L.chainHandled.add(dotNode);
    // A TAIL entry's intermediate steps (`x?.trim()` inside
    // `x?.trim().toLowerCase()`) checker-type with the chain's `|
    // undefined` even though inside the guard they are proven non-nullish
    // — narrow each so the downstream method/member dispatch rides the
    // real receiver kind. Only nodes this chain registers are cleaned up.
    const tailSteps: ts.Expression[] = [];
    if (dotNode !== expr && !(ts.isCallExpression(expr) && expr.expression === dotNode)) {
      for (let cur: ts.Expression = expr; cur !== dotNode; ) {
        const next: ts.Expression = ts.isCallExpression(cur)
          ? cur.expression
          : (cur as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
        if (next === dotNode) break;
        if (!L.chainNarrowedType.has(next)) {
          L.chainNarrowedType.set(
            next,
            L.checker.getNonNullableType(L.checker.getTypeAtLocation(next)),
          );
          tailSteps.push(next);
        }
        cur = next;
      }
      if (!L.chainNarrowedType.has(dotNode)) {
        L.chainNarrowedType.set(
          dotNode,
          L.checker.getNonNullableType(L.checker.getTypeAtLocation(dotNode)),
        );
        tailSteps.push(dotNode as ts.Expression);
      }
    }
    let body: IrExpr;
    try {
      body = L.lowerExpr(expr);
    } finally {
      L.chainRecvByNode.delete(recvNode);
      L.chainNarrowedType.delete(recvNode);
      L.chainHandled.delete(dotNode);
      for (const n of tailSteps) L.chainNarrowedType.delete(n);
    }
    return L.finishOptionalChain(expr, id, receiver, body, loc);
  }

/** The optChain node around a lowered chain body: void bodies keep the
   * statement form (`cb?.();` — the checker's `void | undefined` result IS
   * void here); value bodies wrap into the checker's undefined-armed
   * result union. */
  export function finishOptionalChain(L: Lowerer, expr: ts.Expression,
    id: string,
    receiver: IrExpr,
    body: IrExpr,
    loc: SrcLoc,): IrExpr {
    if (body.type.kind === "void") {
      return { kind: "optChain", id, receiver, body, type: VOID, loc };
    }
    // A dyn body (`pricing?.[key]` — an unknown-valued index-signature
    // read) stays dyn: `unknown | undefined` IS unknown, and dyn represents
    // undefined directly (the unit path yields the undefined dyn value).
    if (body.type.kind === "dyn") {
      return { kind: "optChain", id, receiver, body, type: DYN, loc };
    }
    let type = L.irTypeOf(expr);
    const hiddenOptionalResult =
      (type.kind !== "union" || L.armTag(type.unionId, UNDEFINED_T) < 0) &&
      receiver.type.kind === "union" && L.armTag(receiver.type.unionId, UNDEFINED_T) >= 0 &&
      body.type.kind !== "generator" && body.type.kind !== "jsval"
        ? L.withUndefinedArmOf(body.type)
        : null;
    if (hiddenOptionalResult) type = hiddenOptionalResult;
    if (type.kind !== "union" || L.armTag(type.unionId, UNDEFINED_T) < 0) {
      L.unsupported(
        "SC1090",
        expr,
        `'?.' where the result '${L.fmt(type)}' has no undefined arm (narrow the receiver with 'if (x !== undefined)' instead)`,
      );
    }
    const wrapped = L.coerceToExpected(body, type);
    if (!typeEquals(wrapped.type, type)) L.badType(expr, L.typeOf(expr));
    return { kind: "optChain", id, receiver, body: wrapped, type, loc };
  }

/** A CONDITION-position expression: the result is consumed as a bool
   * only, so `&&`/`||` descend recursively over ToBoolean'd operands —
   * JS-exact (`ToBoolean(a && b)` ≡ `ToBoolean(a) && ToBoolean(b)`), still
   * short-circuiting, and mixed operand kinds that have no VALUE
   * representation (`u && flag` — a union and a bool) test fine here. */
  export function lowerCondition(L: Lowerer, expr: ts.Expression): IrExpr {
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
        const left = L.lowerCondition(e.left);
        // The right operand evaluates only when the left already answered
        // (true for &&, false for ||) — aliased-typeof narrows the left
        // PROVES under that polarity hold while it lowers (`type ===
        // 'string' && val.length > 0`, the ms entry shape).
        const runtimeOptionalLocal = isAnd ? runtimeOptionalLocalOf(L, e.left) : null;
        const right = L.narrowingAliases(aliasTypeofNarrows(L, e.left, isAnd), () => {
          if (runtimeOptionalLocal === null) return L.lowerCondition(e.right);
          L.runtimeOptionalLocals.delete(L.runtimeOptionalRootOf(runtimeOptionalLocal));
          try {
            return L.lowerCondition(e.right);
          } finally {
            L.runtimeOptionalLocals.add(L.runtimeOptionalRootOf(runtimeOptionalLocal));
          }
        });
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
    return L.ensureBool(lowerAbsenceProbe(L, expr) ?? L.lowerExpr(expr), expr);
  }

  function runtimeOptionalLocalOf(L: Lowerer, node: ts.Expression): IrLocal | null {
    let expr = node;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (!ts.isIdentifier(expr)) return null;
    const local = L.resolveLocal(expr);
    return local && L.runtimeOptionalLocals.has(L.runtimeOptionalRootOf(local)) ? local : null;
  }

  export function runtimeOptionalTrueIds(L: Lowerer, node: ts.Expression): IrLocal[] {
    let expr = node;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return [...runtimeOptionalTrueIds(L, expr.left), ...runtimeOptionalTrueIds(L, expr.right)];
    }
    const local = runtimeOptionalLocalOf(L, expr);
    return local === null ? [] : [local];
  }

  export function withRuntimeOptionalNarrowed<T>(L: Lowerer, locals: readonly IrLocal[], fn: () => T): T {
    if (locals.length === 0) return fn();
    for (const local of locals) L.runtimeOptionalLocals.delete(L.runtimeOptionalRootOf(local));
    try {
      return fn();
    } finally {
      for (const local of locals) L.runtimeOptionalLocals.add(L.runtimeOptionalRootOf(local));
    }
  }

/** JS ToBoolean: bool passes through; f64/string get a `toBool` wrapper
   * (falsy: 0, -0, NaN, ""); unions get the same wrapper answered by a
   * per-union interned helper (unit arms falsy; scalar/string arms by
   * value; ref arms always truthy). Anything else (void) cannot be
   * tested. */
  export function ensureBool(L: Lowerer, e: IrExpr, node: ts.Expression): IrExpr {
    if (e.type.kind === "bool") return e;
    if (e.type.kind === "f64" || e.type.kind === "string") {
      return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
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
      L.requireTruthyUnion(e.type.unionId, node);
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
    L.badType(node, L.typeOf(node));
  }

/** Truthiness needs a ToBoolean per arm: dyn/caught arms have none (a
   * dynamic ToBoolean over the checked-dynamic tree / the snapshot box) — fence those
   * unions; every other arm kind is answerable (units false, scalars and
   * strings by value, refs true, jsval by the engine). */
  export function requireTruthyUnion(L: Lowerer, unionId: string, node: ts.Expression): void {
    const def = L.unions.get(unionId);
    if (def && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught")) return;
    L.unsupported(
      "SC1090",
      node,
      `union-typed conditions with 'unknown' arms (${NARROW_FIRST})`,
    );
  }

/** Strict equality needs a per-arm comparison: units, scalars, strings,
   * and ref kinds (pointer identity) all have one; dyn/caught arms have no
   * static equality and jsval arms would need the engine's `===` — those
   * unions keep the narrow-first fence. */
  export function eqComparableUnion(L: Lowerer, unionId: string): boolean {
    const def = L.unions.get(unionId);
    return (
      !!def &&
      def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught" && a.kind !== "jsval")
    );
  }

/** Property access on a string or array receiver: `.length` lowers to the
   * matching intrinsic; a bare method reference (`const f = s.slice` — a
   * function value) is rejected with a specific message. Returns null for
   * other receivers (the generic property-access rejection applies). Both
   * the receiver type AND the ambient-file provenance of the member are
   * verified — the name alone proves nothing. */
  export function lowerIntrinsicProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (L.chainBlocked(expr)) return null;
    // A never-tainted JS receiver type lowered checked-dynamic
    // (neverTaintedJsType — `cmd.length` on `const cmd = ['pwd', []]`):
    // stand down so the dyn keyed read below the chain answers, instead
    // of an array libCall over a dyn receiver hitting the boundary fence.
    let kind = neverTaintedJsType(L, expr.expression, L.typeOf(expr.expression))
      ? undefined
      : L.mapTypeOf(L.typeOf(expr.expression))?.kind;
    // A checker-`any[]` receiver (the readonly-array Array.isArray quirk)
    // whose VALUE lowers to a real static array (maybeNarrow's isArray
    // bridge): `.length` and friends ride the array path on the lowered
    // value (re-lowering is pure IR construction).
    if (kind === undefined && L.checkerAnyArray(expr.expression)) {
      const probe = L.lowerExpr(expr.expression);
      if (probe.type.kind === "array") kind = "array";
    }
    if (kind !== "string" && kind !== "array" && kind !== "map" && kind !== "set" && kind !== "f64" && kind !== "date" && kind !== "regex" && kind !== "url" && kind !== "searchParams" && kind !== "stats" && kind !== "spawnRes" && kind !== "child" && kind !== "bytes" && kind !== "symbol") {
      return null;
    }
    // child receivers also admit the user's own child-shaped interface
    // members (the NgrokChildProcess duck rule — see isChildSurfaceMember).
    // The EMPTY tuple `[]` rides the array REPRESENTATION (types.ts), but
    // its `length` member is the tuple's own synthesized property, not
    // Array.prototype's — provenance alone would refuse it. It reads the
    // runtime length (always 0) through the array intrinsic like any other
    // array; non-empty tuples never reach here (they map to records and
    // fold their arity constant on the record path).
    const tupleLengthOnArray =
      kind === "array" &&
      expr.name.text === "length" &&
      L.checker.isTupleType(L.checker.getBaseTypeOfLiteralType(L.typeOf(expr.expression)));
    if (kind === "child" ? !isChildSurfaceMember(L, expr) : !tupleLengthOnArray && !L.isStdlibMember(expr)) return null;
    const name = expr.name.text;
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
        const receiver = L.lowerExpr(expr.expression);
        const type: IrType = { kind: "union", unionId: L.unions.intern([F64, UNDEFINED_T]) };
        return { kind: "libCall", fn: "child.pid", args: [receiver], type, loc };
      }
      if (name === "exitCode") {
        const receiver = L.lowerExpr(expr.expression);
        const type: IrType = { kind: "union", unionId: L.unions.intern([F64, NULL_T]) };
        return { kind: "libCall", fn: "child.exitCode", args: [receiver], type, loc };
      }
      if (name === "killed") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "libCall", fn: "child.killed", args: [receiver], type: BOOL, loc };
      }
      if (name === "on" || name === "kill" || name === "unref") {
        L.unsupported("SC1090", expr, `child methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `ChildProcess.${name}`,
        expr,
        "on(\"exit\" | \"error\", cb), pid, exitCode, killed, kill(signal?), and unref() are the supported ChildProcess members",
        L.checker.getSymbolAtLocation(expr.name),
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
        const receiver = L.lowerExpr(expr.expression);
        const type: IrType = { kind: "union", unionId: L.unions.intern([F64, NULL_T]) };
        const read: IrExpr = { kind: "libCall", fn: "spawnRes.status", args: [receiver], type, loc };
        return L.maybeNarrow(read, expr);
      }
      if (name === "stdout" || name === "stderr") {
        if (L.mapTypeOf(L.typeOf(expr))?.kind !== "string") {
          L.noLowering(
            `spawnSync's ${name} without the "utf8" encoding`,
            expr,
            'Buffer captures are not representable — call spawnSync(cmd, args, { encoding: "utf8" }) so the outputs are strings',
          );
        }
        const receiver = L.lowerExpr(expr.expression);
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
        const receiver = L.lowerExpr(expr.expression);
        const type = L.withUndefinedArmOf({ kind: "object", className: "%Error" });
        if (!type) L.badType(expr, L.typeOf(expr));
        const read: IrExpr = { kind: "libCall", fn: "spawnRes.error", args: [receiver], type, loc };
        return L.maybeNarrow(read, expr);
      }
      L.noLowering(
        `SpawnSyncReturns.${name}`,
        expr,
        "status, stdout, stderr, and error are the supported spawnSync-result members",
        L.checker.getSymbolAtLocation(expr.name),
      );
    }
    if (kind === "stats") {
      if (name === "size") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "libCall", fn: "stats.size", args: [receiver], type: F64, loc: locOf(expr) };
      }
      if (name === "isFile" || name === "isDirectory") {
        L.unsupported("SC1090", expr, `Stats methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `Stats.${name}`,
        expr,
        "isFile(), isDirectory(), isSymbolicLink(), size, blocks, nlink, atimeMs, and mtimeMs are the supported Stats members",
        L.checker.getSymbolAtLocation(expr.name),
      );
    }
    if (kind === "date") {
      const methods = new Set([
        "getTime", "valueOf", "toISOString",
        "getFullYear", "getUTCFullYear", "getMonth", "getUTCMonth",
        "getDate", "getUTCDate", "getDay", "getUTCDay", "getHours",
        "getUTCHours", "getMinutes", "getUTCMinutes", "getSeconds",
        "getUTCSeconds", "getMilliseconds", "getUTCMilliseconds",
        "getTimezoneOffset",
      ]);
      if (methods.has(name)) {
        L.unsupported("SC1090", expr, `Date methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `Date.prototype.${name}`,
        expr,
        "getTime(), valueOf(), toISOString(), the local/UTC calendar getters, and getTimezoneOffset() are supported; Date setters and locale/string formatters have no lowering",
        L.checker.getSymbolAtLocation(expr.name),
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
        const receiver = L.lowerExpr(expr.expression);
        const type: IrType = { kind: "union", unionId: L.unions.intern([STRING, UNDEFINED_T]) };
        return { kind: "libCall", fn: "sym.desc", args: [receiver], type, loc };
      }
      if (name === "toString" || name === "valueOf") {
        L.unsupported("SC1090", expr, `symbol methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `Symbol.prototype.${name}`,
        expr,
        "description and toString() are the supported symbol members",
        L.checker.getSymbolAtLocation(expr.name),
      );
    }
    if (kind === "url") {
      // The supported URL getters. Everything else the lib declares
      // (searchParams, setters-as-reads, ...) fences with the
      // member-qualified name and the supported list. `host` is the WHATWG
      // serialization: lowercased hostname, `:port` appended exactly when
      // a non-default port is present (scr_url_host — Node-exact,
      // opaque-path URLs answer ""); `hostname` is the stored port-less
      // host field verbatim (Node would keep IPv6 brackets here, but the
      // parser rejects IPv6 hosts — documented divergence — so the getter
      // never sees one).
      if (name === "protocol" || name === "pathname" || name === "href" || name === "host" || name === "hostname" || name === "search") {
        const receiver = L.lowerExpr(expr.expression);
        const fn =
          name === "protocol"
            ? "url.protocol"
            : name === "pathname"
              ? "url.pathname"
              : name === "host"
                ? "url.host"
                : name === "hostname"
                  ? "url.hostname"
                  : name === "search"
                    ? "url.search"
                    : "url.href";
        return { kind: "libCall", fn, args: [receiver], type: STRING, loc: locOf(expr) };
      }
      // `u.searchParams`: the LIVE cached view (one identity per URL —
      // mutations through it re-serialize into the URL's query, so href
      // reflects immediately; Node's binding exactly).
      if (name === "searchParams") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "libCall", fn: "url.searchParams", args: [receiver], type: SEARCH_PARAMS_T, loc: locOf(expr) };
      }
      if (name === "toString" || name === "toJSON") {
        L.unsupported("SC1090", expr, `URL methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `URL.${name}`,
        expr,
        "protocol, pathname, href, host, hostname, search, searchParams, and toString() are the supported URL members",
        L.checker.getSymbolAtLocation(expr.name),
      );
    }
    if (kind === "searchParams") {
      const SEARCH_PARAMS_METHODS = new Set(["get", "getAll", "set", "append", "delete", "has", "sort", "toString", "forEach", "keys", "values", "entries"]);
      // The one data property; every method lowers at its CALL
      // (lowerSearchParamsMethodCall) — bare method references fence.
      if (name === "size") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "libCall", fn: "sp.size", args: [receiver], type: F64, loc: locOf(expr) };
      }
      if (SEARCH_PARAMS_METHODS.has(name)) {
        L.unsupported("SC1090", expr, `URLSearchParams methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `URLSearchParams.${name}`,
        expr,
        "get, getAll, set, append, delete, has, sort, size, toString(), forEach, and for-of iteration are the supported URLSearchParams members",
        L.checker.getSymbolAtLocation(expr.name),
      );
    }
    if (kind === "regex") {
      if (name === "source" || name === "flags") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "regexIntrinsic", method: name, receiver, args: [], type: STRING, loc: locOf(expr) };
      }
      if (name === "test") {
        L.unsupported("SC1090", expr, "regex methods as values (call 'test' directly)");
      }
      return null;
    }
    if (kind === "f64") {
      // The only ambient members on numbers are island-backed methods; a
      // bare reference has no value form regardless of --dynamic.
      if (own(ISLAND_SURFACE.number, name) !== undefined) {
        L.unsupported("SC1090", expr, `number methods as values (call '${name}' directly)`);
      }
      return null;
    }
    if (kind === "bytes") {
      const loc = locOf(expr);
      if (name === "length" || name === "byteLength") {
        const receiver = L.lowerExpr(expr.expression);
        // An island handle behind a typed-array .d.ts surface: the engine
        // property read, exiting at the declared number type (the array
        // .length rule). Chain-handled reads stay jsval.
        if (receiver.type.kind === "jsval") {
          const read: IrExpr = { kind: "jsOp", op: "getProp", name, args: [receiver], type: JSVAL, loc };
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
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "bytesIntrinsic", method: "byteOffset", receiver, args: [], type: F64, loc };
      }
      if (name === "buffer") {
        // No ArrayBuffer VALUE exists — `.buffer` compiles only in the
        // one composed position that consumes it, the DataView
        // constructor's first argument (lowerDataViewNew peels it).
        L.unsupported(
          "SC1090",
          expr,
          "'.buffer' outside new DataView(x.buffer, ...) / Buffer.from(x.buffer, ...) " +
            "(no free-standing ArrayBuffer value exists; subarray() answers an aliasing view directly)",
        );
      }
      if (name === "slice" || name === "subarray" || name === "set" || name === "toString") {
        L.unsupported("SC1090", expr, `typed-array methods as values (call '${name}' directly)`);
      }
      return null; // fill, reverse, ... → the SC2020 member fence
    }
    if (kind === "map") {
      if (name === "size") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "mapIntrinsic", method: "size", receiver, args: [], type: F64, loc: locOf(expr) };
      }
      if (MAP_METHODS.has(name) || name === "forEach") {
        L.unsupported("SC1090", expr, `Map methods as values (call '${name}' directly)`);
      }
      return null;
    }
    if (kind === "set") {
      if (name === "size") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "setIntrinsic", method: "size", receiver, args: [], type: F64, loc: locOf(expr) };
      }
      if (SET_METHODS.has(name)) {
        L.unsupported("SC1090", expr, `Set methods as values (call '${name}' directly)`);
      }
      return null;
    }
    if (name === "length") {
      const receiver = L.lowerExpr(expr.expression);
      // An island handle behind an array-typed .d.ts surface
      // (`parts().length` on a declared `string[]` return — arrays never
      // exit eagerly, so the value stays jsval): an engine property read,
      // exiting at the declared number type. Chain-handled reads stay
      // jsval (the island chain's body must be a handle).
      if (receiver.type.kind === "jsval") {
        const read: IrExpr = { kind: "jsOp", op: "getProp", name: "length", args: [receiver], type: JSVAL, loc: locOf(expr) };
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
        ? own(STR_METHODS, name) !== undefined || own(ISLAND_SURFACE.string, name) !== undefined
        : ARRAY_METHODS.has(name)
    ) {
      L.unsupported("SC1090", expr, `${kind} methods as values (call '${name}' directly)`);
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
  export function lowerArrayLiteral(L: Lowerer, expr: ts.ArrayLiteralExpression,
    expected?: (IrType & { kind: "array" }) | (IrType & { kind: "record" }),): IrExpr {
    const loc = locOf(expr);
    const ctxType = L.checker.getContextualType(expr);
    const tsType = ctxType ?? L.typeOf(expr);
    let mapped = expected ?? L.mapTypeOf(tsType);
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
      expected === undefined && neverTaintedJsType(L, expr, L.typeOf(expr));
    if (expected === undefined && neverTaintedJsType(L, expr, tsType)) mapped = null;
    // A union-typed slot (`const x: string[] | number = [..]`) contextually
    // types the literal as the union; build the literal as its OWN type and
    // let the slot's coercion wrap it into the union. An unknown-typed slot
    // (`JSON.stringify([1, 2])`) likewise: build the literal's own type. An
    // UNMAPPABLE context falls back the same way — a destructuring pattern
    // without annotations contextually types its initializer `[any]`, while
    // the literal's own inferred type is the real tuple.
    if (!mapped || mapped.kind === "union" || mapped.kind === "dyn") {
      const ctxUnion = mapped?.kind === "union" ? mapped : null;
      mapped = L.mapTypeOf(L.typeOf(expr));
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
        const def = L.unions.get(ctxUnion.unionId);
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
          mapped === null || mapped.kind === "dyn" ||
          // The checker echoing the context union back as the literal's
          // own type decides nothing either — nor does an island ('any')
          // residue under a STATIC union slot.
          mapped.kind === "union" || mapped.kind === "jsval" ||
          (mapped.kind === "array" && nonUnitElems && L.unitOnlyElem(mapped.elem));
        if (ownUnhelpful) {
          const def = L.unions.get(ctxUnion.unionId);
          const arms = (def?.arms ?? []).filter(
            (a) =>
              (a.kind === "array" && !(nonUnitElems && L.unitOnlyElem(a.elem))) ||
              (a.kind === "record" &&
                !!L.shapes.get(a.shapeId)?.tuple &&
                L.shapes.get(a.shapeId)!.fields.length === expr.elements.length),
          );
          if (arms.length === 1) mapped = arms[0]!;
        }
      }
    }
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
      mapped = arrayOf(unitOnlyUnion(L.unions));
    }
    // A TUPLE-typed slot (`const t: [string, number] = ["a", 1]`): the
    // literal constructs the tuple's record shape — one positional field
    // per element, source order (which IS index order, so evaluation order
    // is JS-exact). tsc has already checked the arity; the recount below
    // backstops `as` smuggling. Spreads have no fixed positions — fenced.
    if (mapped?.kind === "record") {
      const shape = L.shapes.get(mapped.shapeId);
      if (shape?.tuple) {
        const spread = expr.elements.find(ts.isSpreadElement);
        if (spread) {
          L.unsupported(
            "SC1090",
            spread,
            "spread elements in tuple literals (positions must be spelled out)",
          );
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
            L.dynamic &&
            expr.elements.length < shape.fields.length &&
            expr.elements.every((el) => !ts.isOmittedExpression(el))
          ) {
            return {
              kind: "jsOp",
              op: "arrLit",
              args: expr.elements.map((el) => L.jsvalIn(L.lowerExpr(el), el)),
              type: JSVAL,
              loc,
            };
          }
          L.badType(expr, tsType);
        }
        const byName = new Map(shape.fields.map((f) => [f.name, f.type]));
        const fields = expr.elements.map((el, i) => {
          const fieldType = byName.get(String(i));
          if (!fieldType) L.badType(el, L.typeOf(el));
          return { name: String(i), value: L.lowerExprExpecting(el, fieldType) };
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
      if (isJsSourceFile(expr.getSourceFile()) || mapped?.kind === "dyn") {
        const elems = expr.elements.map((el): IrExpr => {
          if (ts.isSpreadElement(el)) {
            L.unsupported("SC1090", el, "spread elements in a dynamic (unknown[]) array literal");
          }
          const v = L.coerceToExpected(L.lowerExpr(el), DYN);
          if (v.type.kind !== "dyn") {
            L.unsupported(
              "SC1101",
              el,
              `holding '${L.fmt(v.type)}' values in a dynamic (unknown[]) array literal`,
            );
          }
          return v;
        });
        return { kind: "dynArrLit", elems, type: DYN, loc };
      }
      L.badType(expr, tsType);
    }
    const type = mapped as IrType & { kind: "array" };
    const spreads: number[] = [];
    const elems = expr.elements.map((el, i) => {
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
        L.fenceStaticHeadersIteration(el.expression);
        let src = L.lowerDynamicHeadersSpread(el.expression, type) ??
          (ts.isConditionalExpression(srcNode)
            ? lowerTernary(L, srcNode, type)
            : L.lowerExpr(el.expression));
        // `[...someSet]`: a same-element Set drains into a fresh array in
        // insertion order (setIntrinsic toArray); the spread machinery
        // then copies like any array source.
        if (src.type.kind === "set" && typeEquals(src.type.elem, type.elem)) {
          src = {
            kind: "setIntrinsic",
            method: "toArray",
            receiver: src,
            args: [],
            type: arrayOf(src.type.elem),
            loc: locOf(el),
          };
        }
        // `[...new SymbolIterator]`: a CLASS ITERABLE drains through its
        // own protocol into a fresh element array (classIteratorDrainCall
        // — an infinite iterator loops forever, exactly Node), and the
        // spread machinery copies like any array source.
        if (src.type.kind === "object") {
          const drained = L.classIteratorDrainCall(src, locOf(el), type.elem);
          if (drained) src = drained;
        }
        // `[...s]` on a STRING spreads its code-point characters (the
        // string iterator's walk — astral chars whole) through the same
        // interned helper as Array.from(s); the result rides the array
        // machinery below like any string[] source.
        if (src.type.kind === "string") {
          src = strCharsCall(L, src, locOf(el));
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
        // A same-family array whose ELEMENT lifts (string[] into a
        // (string | symbol)[] literal — per-element wrap/width copy):
        // the interned width helper reshapes before the spread copies.
        if (src.type.kind === "array" && !typeEquals(src.type, type)) {
          const w = L.widthCoerce(src, type);
          if (w) src = w;
        }
        if (!typeEquals(src.type, type)) {
          L.unsupported(
            "SC1090",
            el,
            `spreading '${L.fmt(src.type)}' into a '${L.fmt(type)}' literal (only a same-element-type array spreads)`,
          );
        }
        spreads.push(i);
        return src;
      }
      // A HOLE (`[,]` — an elision): the slot materializes the undefined
      // arm — reads, length, and JSON answer exactly Node (JSON.stringify
      // prints null for holes AND for undefined elements). Iteration
      // methods do not skip the position the way JS skips holes — the
      // documented sparse-literal divergence.
      if (ts.isOmittedExpression(el)) {
        const hole = type.elem.kind === "union" ? L.wrappedUndefined(type.elem, locOf(el)) : null;
        if (hole) return hole;
        L.unsupported("SC1090", el, "holes in array literals of this element type");
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
          const ownT = L.mapTypeOf(L.checker.getContextualType(x) ?? L.typeOf(x));
          if (ownT === null || L.widthLiftPlan(ownT, type.elem) === null) {
            // An ARRAY-typed slot takes the literal directly; a union slot
            // routes through its single array arm and wraps.
            if (type.elem.kind === "array") {
              return L.lowerArrayLiteral(x, type.elem);
            }
            const def = L.unions.get(type.elem.unionId);
            const arrayArms = def?.arms.filter((a) => a.kind === "array") ?? [];
            if (arrayArms.length === 1) {
              const built = L.lowerArrayLiteral(x, arrayArms[0] as IrType & { kind: "array" });
              return L.coerceInto(el, built, type.elem);
            }
          }
        }
      }
      // Elements flow into the element slot like an assignment: union
      // elements wrap plain arm values (`[1, "a"]` as (number | string)[]),
      // holes reject inside lowerExpr.
      const lowered = L.lowerExprExpecting(el, type.elem);
      if (!typeEquals(lowered.type, type.elem)) L.badType(el, L.typeOf(el));
      return lowered;
    });
    return { kind: "arrayLit", elems, ...(spreads.length > 0 ? { spreads } : {}), type, loc };
  }

/** `{ a: 1, b: "x" }` → recordLit. The record type comes from the
   * contextual type when tsc has one (annotated declarations, arguments,
   * nested literals) and from the literal's own type otherwise — both intern
   * to the same shapeId unless width subtyping is in play (an `as` cast can
   * smuggle a wider/narrower literal past tsc's freshness check), which the
   * exact-shape checks below reject with SC2002. Fields lower IN SOURCE
   * ORDER: JS evaluates property values in source order. */
  /** The dropped-field names of the PromiseSettledResult honest subset
   * (SEMANTICS.md 46): when the literal's target type is (a union
   * containing) the lib's PromiseFulfilledResult / PromiseRejectedResult,
   * the record mapping kept only `status` — `value` and `reason` evaluate
   * for effect and are not stored. Null for every other target. */
  function settledDropNames(L: Lowerer, tsType: ts.Type): Set<string> | null {
    let names: Set<string> | null = null;
    const parts: readonly ts.Type[] = tsType.isUnionType() ? ts.constituentTypes(tsType) : [tsType];
    for (const part of parts) {
      const sym = part.getSymbol();
      if (
        !sym ||
        !L.checker.declarationsOf(sym).some(
          (d) => ts.isInterfaceDeclaration(d) && L.isStdlibFile(d.getSourceFile()),
        )
      ) {
        continue;
      }
      if (sym.name === "PromiseFulfilledResult") (names ??= new Set()).add("value");
      if (sym.name === "PromiseRejectedResult") (names ??= new Set()).add("reason");
    }
    return names;
  }

  /** `{ [KEY]: v }` where KEY is a compile-time-known string or number:
   * the key folds into an ordinary (spelled) property name — the record
   * shape is exactly what tsc computed for the literal (the late-bound
   * name IS the checker's literal type), so the fold is just spelling.
   * PURE key forms only, so skipping the key's evaluation is exact (JS
   * evaluates the key before the value; effectful expressions keep the
   * fence): any side-effect-free expression — identifiers, property
   * chains with no accessor on them (enum members, `other.name` reads),
   * literals, parenthesized/as-wrapped forms, operators over those —
   * whose checker type is ONE string or number literal (or a union whose
   * arms all spell the same name — `E1.x || E2.x` where both are 0).
   * Number keys take JS's canonical spelling (`{ [E.member]: v }` stores
   * "0" — ToPropertyKey), exactly the name tsc late-bound. Templates
   * fold structurally span by span as well (a template of literals whose
   * checker type widened still spells one string). Symbol-typed and
   * runtime-valued keys stay out. */
  function literalComputedKey(L: Lowerer, name: ts.ComputedPropertyName): string | null {
    return foldedStringKeyOf(L, name.expression);
  }

  export function foldedStringKeyOf(L: Lowerer, expr: ts.Expression): string | null {
    if (ts.isParenthesizedExpression(expr)) return foldedStringKeyOf(L, expr.expression);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isTemplateExpression(expr)) {
      // Structural fold first — exact even where the checker widened the
      // template's own type; the general type-directed fold below is the
      // fallback (a template the checker DID type as one literal).
      let out = expr.head.text;
      let folded = true;
      for (const span of expr.templateSpans) {
        const part = foldedStringKeyOf(L, span.expression);
        if (part === null) {
          folded = false;
          break;
        }
        out += part + span.literal.text;
      }
      if (folded) return out;
    }
    // The general fold: a PURE expression whose checker type spells one
    // property name. An as-cast folds by its OWN checker type — that is
    // the name tsc late-bound the property under, so shape and storage
    // stay one name (the standard trust-the-checker bet); a cast that
    // WIDENS to string un-late-binds the property, its type is no literal,
    // and the fence stays.
    if (!pureKeyExpr(L, expr)) return null;
    return literalKeySpellingOf(L.typeOf(expr));
  }

  /** The property-name spelling of a single-literal checker type: string
   * literals directly, number literals in JS's canonical ToString spelling
   * (enum members included — their literal flags carry the value), and
   * unions whose arms all spell the SAME name (`E1.x || E2.x` — two enum
   * literal types, one value). Null for everything else. */
  function literalKeySpellingOf(t: ts.Type): string | null {
    if (t.isStringLiteralType()) return t.value;
    if (t.isNumberLiteralType()) return String(t.value);
    if (t.isUnionType()) {
      let out: string | null = null;
      for (const arm of ts.constituentTypes(t)) {
        const s = arm.isStringLiteralType() ? arm.value : arm.isNumberLiteralType() ? String(arm.value) : null;
        if (s === null || (out !== null && s !== out)) return null;
        out = s;
      }
      return out;
    }
    return null;
  }

  /** True iff evaluating `expr` can have no observable effect, so a fold
   * may skip it: literals, identifier reads, property chains whose every
   * member is a plain field/enum member (an accessor anywhere on the chain
   * is a call), operators and casts over those. Calls, `new`, assignments,
   * and element accesses stay impure. */
  function pureKeyExpr(L: Lowerer, expr: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) return pureKeyExpr(L, expr.expression);
    if (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) return pureKeyExpr(L, expr.expression);
    if (ts.isIdentifier(expr)) return true;
    if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr)) return true;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isPropertyAccessExpression(expr)) {
      const sym = L.checker.getSymbolAtLocation(expr.name);
      if (sym && sym.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) return false;
      return pureKeyExpr(L, expr.expression);
    }
    if (ts.isPrefixUnaryExpression(expr) &&
        (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken ||
         expr.operator === ts.SyntaxKind.ExclamationToken || expr.operator === ts.SyntaxKind.TildeToken)) {
      return pureKeyExpr(L, expr.operand);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      const pureOp =
        op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        (op >= ts.SyntaxKind.LessThanToken && op <= ts.SyntaxKind.CaretToken &&
          op !== ts.SyntaxKind.InstanceOfKeyword && op !== ts.SyntaxKind.InKeyword);
      return pureOp && pureKeyExpr(L, expr.left) && pureKeyExpr(L, expr.right);
    }
    if (ts.isConditionalExpression(expr)) {
      return pureKeyExpr(L, expr.condition) && pureKeyExpr(L, expr.whenTrue) && pureKeyExpr(L, expr.whenFalse);
    }
    if (ts.isTemplateExpression(expr)) return expr.templateSpans.every((s) => pureKeyExpr(L, s.expression));
    return false;
  }

  /** A property's field name: identifier/string-literal keys directly,
   * foldable computed keys through literalComputedKey (the syntax pass
   * fenced everything else). */
  function propNameText(L: Lowerer, name: ts.PropertyName): string {
    if (ts.isComputedPropertyName(name)) {
      const k = literalComputedKey(L, name);
      if (k === null) throw new InternalCompilerError("lowerer bug: unfoldable computed key past the fence");
      return k;
    }
    // Numeric literals name their canonical string key (JS's ToPropertyKey
    // — the same name the checker gives the property symbol).
    if (ts.isNumericLiteral(name)) return String(Number(name.text));
    return (name as ts.Identifier | ts.StringLiteral).text;
  }

/** The runtime-keyed JS object literal (a computed key that doesn't fold):
   * builds a dyn object member-by-member. Keys evaluate before their values,
   * properties in source order — JS's object-literal evaluation exactly.
   * Identifier/string keys are compile-time strings; numeric keys take
   * their canonical number string (`{ 0x10: v }` stores "16" — JS's
   * ToPropertyKey); computed keys evaluate and pass through ToString (the
   * dyn's String() for dyn operands — `{ [field]: v }` where field is a
   * checked-dynamic param). Values convert through the usual dyn boundary
   * (dynFrom's domain, functions box); a value with no dyn representation
   * fences per property. Spreads copy through dyn.assign in source order;
   * accessors stay fenced. */
  export function lowerDynObjectLiteral(
    L: Lowerer,
    expr: ts.ObjectLiteralExpression,
    boxValue?: (node: ts.Expression, value: IrExpr) => IrExpr,
  ): IrExpr {
    const loc = locOf(expr);
    let fields: { key: IrExpr; value: IrExpr }[] = [];
    let acc: IrExpr | null = null;
    const flushFields = (): void => {
      if (fields.length === 0) return;
      const chunk: IrExpr = { kind: "dynObjLit", fields, type: DYN, loc };
      acc = acc === null
        ? chunk
        : { kind: "libCall", fn: "dyn.assign", args: [acc, chunk], type: DYN, loc };
      fields = [];
    };
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        flushFields();
        const raw = L.lowerExpr(prop.expression);
        const source = boxValue
          ? boxValue(prop.expression, raw)
          : L.coerceToExpected(raw, DYN);
        if (source.type.kind !== "dyn") {
          L.unsupported("SC1101", prop.expression, `spreading '${L.fmt(source.type)}' into a checked-dynamic object literal`);
        }
        acc ??= { kind: "dynObjLit", fields: [], type: DYN, loc };
        acc = { kind: "libCall", fn: "dyn.assign", args: [acc, source], type: DYN, loc: locOf(prop) };
        continue;
      }
      if (
        !ts.isPropertyAssignment(prop) &&
        !ts.isShorthandPropertyAssignment(prop) &&
        !ts.isMethodDeclaration(prop)
      ) {
        L.unsupported(
          "SC1090",
          prop,
          "accessors in a runtime-keyed (computed-key) object literal",
        );
      }
      const name = prop.name;
      let key: IrExpr;
      if (ts.isComputedPropertyName(name)) {
        const folded = literalComputedKey(L, name);
        if (folded !== null) {
          key = { kind: "strLit", value: folded, type: STRING, loc: locOf(name) };
        } else {
          let k = L.lowerExpr(name.expression);
          if (k.type.kind === "f64" || k.type.kind === "bool" || k.type.kind === "dyn") {
            k = { kind: "toString", operand: k, type: STRING, loc: locOf(name) };
          }
          if (k.type.kind !== "string") {
            L.unsupported(
              "SC1090",
              name,
              `'${L.fmt(k.type)}'-typed computed property keys (string, number, boolean, and unknown keys stringify)`,
            );
          }
          key = k;
        }
      } else if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        key = { kind: "strLit", value: name.text, type: STRING, loc: locOf(name) };
      } else if (ts.isNumericLiteral(name)) {
        key = { kind: "strLit", value: String(Number(name.text)), type: STRING, loc: locOf(name) };
      } else {
        L.unsupported("SC1090", prop, "non-identifier property names");
      }
      const valueExpr: ts.Node = ts.isMethodDeclaration(prop)
        ? prop
        : ts.isShorthandPropertyAssignment(prop)
          ? (prop.name as ts.Identifier)
          : prop.initializer;
      // Lambda values that fail to lower become trap closures (the
      // per-call fence granularity — fenceClosureProbe) so the object
      // still builds; everything else keeps the per-property fence below.
      let raw: IrExpr;
      const propDiagsBefore = L.diags.length;
      try {
        const lowerValue = (): IrExpr =>
          ts.isMethodDeclaration(prop)
            ? (L.rejectThisInObjectMethod(prop.body ?? prop), L.lowerLambda(prop))
            : L.lowerExpr(valueExpr as ts.Expression);
        raw =
          fenceClosureProbe(L, valueExpr, undefined, lowerValue) ??
          lowerValue();
      } catch (err) {
        // A PURE member read a JS file cannot lower (a namespace object
        // in an export aggregate): the slot takes a boxed fence closure —
        // the diagnostics defer to the runtime-fence ledger, the object
        // builds, and only USING the member stops the run.
        const pureMember = ts.isIdentifier(valueExpr);
        if (!(err instanceof PoisonError) || !pureMember) throw err;
        const fence = L.deferToRuntimeFence(propDiagsBefore, prop, {
          kind: "closure",
          name: () => `%fn${L.lambdaCounter++}_dynfence`,
          returnType: VOID,
          type: { kind: "func", params: [], ret: VOID },
        });
        if (!fence) throw err;
        raw = fence;
      }
      let v = boxValue
        ? boxValue(valueExpr as ts.Expression, raw)
        : L.coerceToExpected(raw, DYN);
      if (v.type.kind !== "dyn") {
        const convDiagsBefore = L.diags.length;
        try {
          L.unsupported(
            "SC1101",
            valueExpr,
            `holding '${L.fmt(v.type)}' values in a runtime-keyed (computed-key) object literal`,
          );
        } catch (err) {
          // A member value the checked-dynamic tree cannot hold — a func whose signature
          // cannot box, an island ('any') handle, a record carrying func
          // fields (the export aggregate's typed utilities and npm-handle
          // members): the same call-time fence deferral as an unlowerable
          // member — the slot takes a boxed fence closure; only USING it
          // stops the run. Probe mode and ICEs keep the poison.
          if (!(err instanceof PoisonError)) throw err;
          const fence = L.deferToRuntimeFence(convDiagsBefore, prop, {
            kind: "closure",
            name: () => `%fn${L.lambdaCounter++}_dynfence`,
            returnType: VOID,
            type: { kind: "func", params: [], ret: VOID },
          });
          if (!fence) throw err;
          v = L.coerceToExpected(fence, DYN);
        }
      }
      fields.push({ key, value: v });
    }
    flushFields();
    return acc ?? { kind: "dynObjLit", fields: [], type: DYN, loc };
  }

/** Spreading a source whose shape carries accessor slots: Node's copy
 * invokes each getter exactly once in insertion order — even for keys a
 * later contributor overrides — while the field-copy desugar assumes pure
 * reads it may drop or reorder. Getter-call counts would silently diverge,
 * so accessor-carrying sources fence by name. */
function fenceAccessorSpreadSource(L: Lowerer, prop: ts.Node, srcShape: IrRecordShape | undefined): void {
  if (srcShape && shapeHasAccessorSlots(srcShape)) {
    L.unsupported(
      "SC1090",
      prop,
      "object spread of sources carrying get/set accessor properties (Node invokes each getter once during the copy — the field-copy desugar cannot model the calls; bind the reads to consts first)",
    );
  }
}

/** The JS trap-closure fallback for FUNCTION-VALUED object properties: a
 * lambda whose body fails to lower inside a JS object literal becomes a
 * closure of the field's exact func type whose body is the runtime fence —
 * the object still BUILDS (commander's `_outputConfiguration` table: the
 * driven writeOut/writeErr entries work; an unloweraable color probe traps
 * only if something CALLS it). The failed lambda's diagnostics move to the
 * runtime-fence inventory, exactly like a fenced JS statement. Null when
 * the fallback does not apply (not a JS file, not a lambda, no func slot)
 * — the caller lowers normally. ICEs (SC9001) never convert. */
function fenceClosureProbe(
  L: Lowerer,
  node: ts.Node,
  slotType: IrType | undefined,
  attempt: () => IrExpr,
): IrExpr | null {
  if (!isJsSourceFile(node.getSourceFile())) return null;
  let inner: ts.Node = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner) && !ts.isMethodDeclaration(inner)) {
    return null;
  }
  // The trap's ABI: the field's func slot when one exists; otherwise (the
  // dyn-object literal path — the value boxes into dyn) the all-dyn
  // signature of the lambda's own arity, which canBoxFuncIntoDyn always
  // admits.
  const fieldType: IrType & { kind: "func" } =
    slotType !== undefined && slotType.kind === "func"
      ? slotType
      : { kind: "func", params: inner.parameters.map(() => DYN), ret: DYN };
  if (slotType !== undefined && slotType.kind !== "func") return null;
  const diagsBefore = L.diags.length;
  try {
    return attempt();
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
    const params = fieldType.params.map((t, i) => ({ localId: `p.${i}`, name: `p${i}`, type: t }));
    const fence = L.deferToRuntimeFence(diagsBefore, node, {
      kind: "closure",
      name: () => `%fence.fn.${L.liftedFns.length}`,
      params,
      returnType: fieldType.ret,
      paramsMutable: true,
      type: fieldType,
      fallback: { code: "SC1090", message: "this function's body has no static lowering" },
      bareMessage: true,
      allowDiagSink: true,
    });
    if (!fence) throw e;
    return fence;
  }
}

/** The union arm an object LITERAL inhabits when its fields must widen
 * PER FIELD into exactly one record arm — the reducer-action pattern
 * (`{ kind: "a", parsed: 1 }` into `{ kind: "a"; parsed: number | null }
 * | { kind: "b" }`). The IR shapes erased the literal types tsc
 * discriminated on, so the probe runs against the contextual union's
 * CHECKER members: every literal field must exist on the member
 * (excess-property freshness — tsc already enforced it), every arm field
 * missing from the literal must be optional-flavored (an undefined-armed
 * union, or a dyn slot — the absent-completion rule), and each present
 * field's LITERAL type must fit the member's field type — literal against
 * literal decides by VALUE (the discriminant), everything else by the
 * widened IR pair under the width-lift relation. Exactly ONE fitting arm
 * answers it; zero or several answer null and the caller keeps its
 * fences. Plain property-assignment/shorthand literals only — spreads,
 * accessors, methods, and unfoldable computed keys keep their own paths. */
function literalUnionArmOf(
  L: Lowerer,
  expr: ts.ObjectLiteralExpression,
  tsType: ts.Type,
  recordArms: (IrType & { kind: "record" })[],
): (IrType & { kind: "record" }) | null {
  if (!tsType.isUnionType()) return null;
  const props: { name: string; node: ts.Expression }[] = [];
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) {
      props.push({ name: propNameText(L, p.name), node: p.initializer });
    } else if (ts.isShorthandPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      props.push({ name: p.name.text, node: p.name });
    } else {
      return null;
    }
  }
  /** litT fits ftT: unions per arm; literal-vs-literal by value; unit
   * types only into their own unit; otherwise the widened IR pair must be
   * equal or width-liftable. */
  const fits = (litT: ts.Type, ftT: ts.Type): boolean => {
    if (ftT.isUnionType()) return ts.constituentTypes(ftT).some((a) => fits(litT, a));
    if (ftT.isStringLiteralType()) return litT.isStringLiteralType() && litT.value === ftT.value;
    if (ftT.isNumberLiteralType()) return litT.isNumberLiteralType() && litT.value === ftT.value;
    if (ftT.flags & ts.TypeFlags.BooleanLiteral) {
      return (litT.flags & ts.TypeFlags.BooleanLiteral) !== 0 && L.checker.typeToString(litT) === L.checker.typeToString(ftT);
    }
    if (ftT.flags & ts.TypeFlags.Null) return (litT.flags & ts.TypeFlags.Null) !== 0;
    if (ftT.flags & ts.TypeFlags.Undefined) return (litT.flags & ts.TypeFlags.Undefined) !== 0;
    if (litT.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return false;
    const li = L.mapTypeOf(L.checker.getBaseTypeOfLiteralType(litT));
    const fi = L.mapTypeOf(ftT);
    if (!li || !fi) return false;
    return typeEquals(li, fi) || L.widthLiftPlan(li, fi) !== null;
  };
  const armShapeIds = new Set(recordArms.map((a) => a.shapeId));
  const candidates = new Set<string>();
  for (const member of ts.constituentTypes(tsType)) {
    const mMapped = L.mapTypeOf(member);
    if (mMapped?.kind !== "record" || !armShapeIds.has(mMapped.shapeId) || candidates.has(mMapped.shapeId)) continue;
    const shape = L.shapes.get(mMapped.shapeId);
    if (!shape || shape.tuple || shape.indexValue) continue;
    // Excess-property freshness: every literal field must exist on the
    // member (tsc rejected the others for a fresh literal).
    if (!props.every((p) => L.checker.getPropertyOfType(member, p.name) !== undefined)) continue;
    // Arm fields the literal leaves unset must be optional-flavored (the
    // absent-completion rule: an undefined-armed union or a dyn slot).
    const names = new Set(props.map((p) => p.name));
    const absentOk = shape.fields.every((f) => {
      if (names.has(f.name)) return true;
      if (f.type.kind === "dyn") return true;
      if (f.type.kind !== "union") return false;
      return L.unions.get(f.type.unionId)?.arms.some((a) => a.kind === "undefinedT") ?? false;
    });
    if (!absentOk) continue;
    const fieldsFit = props.every((p) => {
      const sym = L.checker.getPropertyOfType(member, p.name);
      if (!sym) return false;
      return fits(L.typeOf(p.node), L.checker.getTypeOfSymbol(sym));
    });
    if (fieldsFit) candidates.add(mMapped.shapeId);
  }
  if (candidates.size !== 1) return null;
  const [only] = candidates;
  return recordArms.find((a) => a.shapeId === only) ?? null;
}

/** Extract a literal property key as a string (identifier, string literal,
 * numeric literal, or pure const-folded computed key). Returns null for
 * runtime-computed / symbol keys. Mirrors lower-island's requestInitLiteralKey. */
function jsvalObjectLiteralKey(L: Lowerer, prop: ts.ObjectLiteralElementLike): string | null {
  if (
    !ts.isPropertyAssignment(prop) &&
    !ts.isShorthandPropertyAssignment(prop) &&
    !ts.isMethodDeclaration(prop)
  ) return null;
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) return foldedStringKeyOf(L, name.expression);
  return null;
}

/** Lower a TS-source object literal whose contextual type is JSVAL (e.g. an
 * object literal inside a lambda passed to a JSVAL .then()). Builds a JSVAL
 * island object literal — same strategy as lower-island's
 * lowerIslandObjectLiteral but inlined here to avoid a circular import. */
function lowerJsvalObjectLiteralFromTsSource(L: Lowerer, expr: ts.ObjectLiteralExpression): IrExpr {
  const loc = locOf(expr);
  let args: IrExpr[] = [];
  let acc: IrExpr | null = null;
  const flushFields = (): void => {
    if (args.length === 0) return;
    const chunk: IrExpr = { kind: "jsOp", op: "objLit", args, type: JSVAL, loc };
    acc = acc === null
      ? chunk
      : { kind: "jsOp", op: "objSpread", args: [acc, chunk], type: JSVAL, loc };
    args = [];
  };
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      flushFields();
      const spread = ts.isObjectLiteralExpression(prop.expression)
        ? lowerJsvalObjectLiteralFromTsSource(L, prop.expression)
        : L.jsvalIn(L.lowerExpr(prop.expression), prop.expression);
      acc ??= { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc };
      acc = { kind: "jsOp", op: "objSpread", args: [acc, spread], type: JSVAL, loc: locOf(prop) };
      continue;
    }
    if (
      !ts.isPropertyAssignment(prop) &&
      !ts.isShorthandPropertyAssignment(prop) &&
      !ts.isMethodDeclaration(prop)
    ) {
      L.unsupported("SC1090", prop, "this property form in a JSVAL-typed object literal (use a spelled key with a value or method)");
    }
    const propertyName = jsvalObjectLiteralKey(L, prop);
    if (propertyName === null) {
      L.unsupported("SC1090", prop, "this property key in a JSVAL-typed object literal (use a spelled or pure const-folded key)");
    }
    const nameLoc = locOf(prop.name);
    args.push({
      kind: "jsMarshal",
      value: { kind: "strLit", value: propertyName, type: STRING, loc: nameLoc },
      type: JSVAL, loc: nameLoc,
    });
    const valueNode: ts.Expression | ts.MethodDeclaration =
      ts.isPropertyAssignment(prop)
        ? prop.initializer
        : ts.isShorthandPropertyAssignment(prop)
          ? prop.name as ts.Identifier
          : prop;
    if (ts.isObjectLiteralExpression(valueNode)) {
      args.push(lowerJsvalObjectLiteralFromTsSource(L, valueNode));
    } else if (
      ts.isArrayLiteralExpression(valueNode) &&
      !valueNode.elements.some(ts.isSpreadElement)
    ) {
      const elems = valueNode.elements.map((el) => L.jsvalIn(L.lowerExpr(el), el));
      args.push({ kind: "jsOp", op: "arrLit", args: elems, type: JSVAL, loc: locOf(valueNode) });
    } else {
      const value = ts.isMethodDeclaration(valueNode)
        ? (L.rejectThisInObjectMethod(valueNode.body ?? valueNode), L.lowerLambda(valueNode))
        : L.lowerExpr(valueNode);
      args.push(L.jsvalIn(value, valueNode));
    }
  }
  flushFields();
  return acc ?? { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc };
}

export function lowerObjectLiteral(L: Lowerer, expr: ts.ObjectLiteralExpression): IrExpr {
    const loc = locOf(expr);
    // The RUNTIME-KEYED literal (JS): a computed key that doesn't fold to a
    // compile-time string means the literal's shape is not a compile-time
    // fact — no record shape can hold it. The whole literal builds as a dyn
    // object instead (`{ [field]: criteria, actual: 0, ... }` —
    // test/common's _mustCallInner context), where keys are runtime string
    // values. TypeScript keeps the record world and its fence: this shape
    // only arises in checked-dynamic JS.
    if (
      isJsSourceFile(expr.getSourceFile()) &&
      expr.properties.some(
        (p) => {
          const n = ts.isSpreadAssignment(p) ? undefined : p.name;
          return n !== undefined && ts.isComputedPropertyName(n) && literalComputedKey(L, n) === null;
        },
      )
    ) {
      return lowerDynObjectLiteral(L, expr);
    }
    // Syntax fence FIRST: unsupported member forms get their specific
    // message even when they also make the literal's type unmappable
    // (a getter or a `this`-returning method would otherwise surface as an
    // opaque type fence on the whole literal).
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        // Supported shapes: FULL spreads of known record shapes read as
        // identifiers or other side-effect-free reads, all BEFORE any
        // explicit property (the field-copy desugar reads spread fields
        // first, exactly JS's eager copy order); and CONDITIONAL spreads
        // `...(c ? {k: v} : {})` — the optional-field idiom tsc types as
        // `k?: ...` — which desugar to one conditional field at the
        // spread's own position (any position: they introduce one fresh
        // name, collision-fenced below). Everything else stays fenced.
        const cs = conditionalSpreadOf(prop.expression);
        if (cs === "unsupported" || (cs && cs.props.length !== 1)) {
          L.unsupported(
            "SC1090",
            prop,
            "conditional spreads beyond `...(c ? { field: v } : {})` (exactly one property against an empty arm — spell other shapes as optional fields)",
          );
        }
        // Spread ORDER is fenced in the field-by-field desugar below, not
        // here: the index-signature merge path supports any order (keyed
        // last-write-wins writes), so `{ K: v, ...extra }` into a pure
        // Record shape compiles — the buildServiceEnv pattern.
        continue;
      }
      if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
        // JavaScript CJS-export tables reach reads through the lifted-
        // accessor path (cjsExportAccessorRead) — the literal VALUE
        // narrows to its plain fields below (accessor names are not
        // record storage; SEMANTICS.md documents the enumeration
        // divergence). TypeScript accessors lower into the shape's
        // reserved closure slots (%get:/%set: — see accessorSlotProp);
        // `this` in the body is fenced up front: the closure slot has no
        // receiver (capturing the record under construction would be an
        // RC cycle), and the generic lexical-this walk would silently
        // capture an ENCLOSING method's `this` — the object-method rule.
        if (!isJsSourceFile(expr.getSourceFile())) {
          rejectThisInObjectAccessor(L, prop.body ?? prop);
        }
      }
      // Unfoldable computed keys are NOT fenced here: an index-signature
      // target lowers them as runtime keyed writes (the merge path below);
      // every other target re-fences them after the merge path declined
      // (fenceUnfoldableComputedKeys).
      // Identifier keys, STRING-LITERAL keys (`"content-type": v` —
      // record field names are data, never C identifiers; the mangler
      // encodes what C can't spell), NUMERIC-LITERAL keys in their
      // canonical string spelling (`{ 0: v }` stores "0", `{ 0x10: v }`
      // stores "16" — JS's ToPropertyKey; the checker names the property
      // symbol the same way), and FOLDABLE computed keys (above).
      if (
        !prop.name ||
        !(
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ||
          ts.isNumericLiteral(prop.name) || ts.isComputedPropertyName(prop.name)
        )
      ) {
        L.unsupported("SC1090", prop, "non-identifier property names");
      }
      // Shorthand methods are just closure-valued fields — but their `this`
      // is dynamically bound (typed as the literal by tsc, so noImplicitThis
      // lets it through) and records don't model it; the generic
      // lexical-this walk would silently capture an ENCLOSING method's
      // `this`, so any `this` in the body is rejected up front.
      if (ts.isMethodDeclaration(prop)) L.rejectThisInObjectMethod(prop.body ?? prop);
    }

    let tsType = L.checker.getContextualType(expr) ?? L.typeOf(expr);
    // `lit satisfies T` is TYPE-LEVEL only: the expression's checker type —
    // and therefore the shape every downstream consumer sees — is the
    // literal's OWN type (T still contextually types members, so inferred
    // parameter types flow). Building at T would reshape the value tsc
    // says has the literal's type: `{...} satisfies Movable &
    // Record<string, unknown>` must NOT become an index-signature record.
    // Own type wins whenever it maps to a record; an unmappable own type
    // keeps the contextual fallback (a bare-null field whose satisfies
    // target names the wider slot type).
    {
      let p: ts.Node = expr.parent;
      while (ts.isParenthesizedExpression(p)) p = p.parent;
      if (ts.isSatisfiesExpression(p)) {
        const own = L.typeOf(expr);
        if (L.mapTypeOf(own)?.kind === "record") tsType = own;
      }
    }
    // An async function's return position types the literal
    // `T | PromiseLike<T>` (the lib's await-unwrapping contract). The
    // PromiseLike arm never maps, and the record the return slot actually
    // holds is exactly the checker's awaited type — strip to it BEFORE the
    // own-type fallback below: the awaited contextual type carries the
    // slot's field types (`lanIp: string | null`), which the literal's own
    // type narrows away (a field written as `lanIp: null` types as bare
    // `null`, which maps to nothing on its own).
    if (tsType.isUnionType() && ts.constituentTypes(tsType).some((t) => t.getSymbol()?.name === "PromiseLike")) {
      tsType = L.checker.getAwaitedType(tsType) ?? tsType;
    }
    let mapped = L.mapTypeOf(tsType);
    // An EMPTY-record context under a NON-empty literal (`Object.keys({
    // ...process.env })` — the lib's `{}`-typed parameters admit every
    // object): `{}` carries no shape information, so the literal builds as
    // its OWN type, exactly the unmappable-context fallback below. An
    // empty LITERAL keeps the context (the shapes agree).
    if (mapped?.kind === "record" && expr.properties.length > 0) {
      const ctxShape = L.shapes.get(mapped.shapeId);
      if (ctxShape && ctxShape.fields.length === 0 && !ctxShape.indexValue && !ctxShape.tuple) {
        mapped = L.mapTypeOf(L.typeOf(expr)) ?? mapped;
      }
    }
    // A literal with a property the contextual TYPE ITSELF lacks — only
    // reachable through type assertions and satisfies (fresh-literal
    // excess-property checks reject the direct spelling): the context
    // cannot hold the value, so the literal builds at its OWN type and the
    // slot's width coercion narrows it (divergence 36's copy stance — the
    // extra fields drop in the copy). The probe is against the CHECKER's
    // contextual type, not the mapped shape: a property the contextual
    // type carries but the shape dropped (settled value/reason,
    // generic-callable members) belongs to the drop paths below, and
    // index-signature contexts keep every key (overflow capture).
    if (mapped?.kind === "record" && expr.properties.length > 0) {
      const ctxShape = L.shapes.get(mapped.shapeId);
      if (ctxShape && !ctxShape.indexValue && !ctxShape.tuple) {
        const names = new Set(ctxShape.fields.map((f) => f.name));
        const ctxHasProp = (name: string): boolean => {
          const members = tsType.isUnionType() ? ts.constituentTypes(tsType) : [tsType];
          return members.some((m) => L.checker.getPropertyOfType(m, name) !== undefined);
        };
        const extraOf = (text: string): boolean => !names.has(text) && !ctxHasProp(text);
        const extra = expr.properties.some((p) => {
          if (ts.isSpreadAssignment(p) || !p.name) return false;
          if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return extraOf(p.name.text);
          if (ts.isNumericLiteral(p.name)) return extraOf(String(Number(p.name.text)));
          return false; // computed keys keep their existing paths
        });
        if (extra) mapped = L.mapTypeOf(L.typeOf(expr)) ?? mapped;
      }
    }
    // A union-typed slot (`const r: Res = { kind: "ok", ... }`) contextually
    // types the literal as the WHOLE union; build the literal as its own
    // (arm) shape and let the slot's coercion wrap it into the union. An
    // unknown-typed slot (`JSON.stringify({ a: 1 })`) likewise. An
    // UNMAPPABLE context falls back the same way — the literal's own type
    // is the plain record the slot coerces. A CLASS-INSTANCE context
    // (`const p: Point = { x, y }` — tsc's structural view of data
    // classes) falls back too: the literal builds as its own record and
    // the slot's width coercion constructs through the trivial
    // parameter-property constructor (recordToClassPlan), or fences with
    // the record-shape story.
    // A TS-source object literal with a JSVAL contextual type (e.g. `{ default:
    // m.Widget }` inside a lambda whose parameter `m` comes from a JSVAL-bearing
    // promise like `import("foo.tsx").then((m) => ...)`) — build as an island
    // JSVAL object NOW, before the own-type fallback below can override `mapped`
    // to a record. If we let the own-type fallback run, the record's field types
    // drive property coercion; but the actual lowered values (e.g. `m.Widget`)
    // are JSVAL IR expressions (island property access), causing SC2001 at the
    // field assignment check. Bail out early with the island path instead.
    if (mapped?.kind === "jsval" && !isJsSourceFile(expr.getSourceFile())) {
      return lowerJsvalObjectLiteralFromTsSource(L, expr);
    }
    // A jsval-mapped context reaches here only when lowerExpr's island
    // gate DECLINED it (a project-declared typedef that absorbed to the
    // island through checker-`any` field residue): the literal builds at
    // its own type like every unmappable context.
    if (mapped === null || mapped.kind === "union" || mapped.kind === "dyn" || mapped.kind === "object" || mapped.kind === "jsval") {
      const ctxUnion = mapped?.kind === "union" ? mapped : null;
      mapped = L.mapTypeOf(L.typeOf(expr)) ?? mapped;
      // A literal whose own shape re-tags into NO arm of the contextual
      // union, where the union has exactly ONE record arm: build AS that
      // arm — there is no ambiguity (tsc already checked the literal
      // against the union, and the record arm is the only shape it can
      // inhabit), and the arm's field types drive every property's
      // coercion (`{ env: {...spread...}, onCleanup }` against an
      // optional options param — the env value builds by ITS contextual
      // index-signature type and wraps into the arm's `| undefined`
      // field, where the literal's own inferred width would mismatch).
      // Empty literals (`_env = {}` — the fieldless own shape) and
      // literals against PURE index-signature arms (`{ OPENSSL_CONF:
      // candidate }` — keys become overflow entries) are the same rule's
      // simplest cases. The empty-array-in-union rule, record form.
      if (ctxUnion) {
        const def = L.unions.get(ctxUnion.unionId);
        const recordArms = def?.arms.filter((a) => a.kind === "record") ?? [];
        if (recordArms.length === 1) {
          const armShape = L.shapes.get(recordArms[0]!.shapeId);
          if (
            (mapped?.kind !== "record" || mapped.shapeId !== recordArms[0]!.shapeId) &&
            !armShape?.tuple
          ) {
            mapped = recordArms[0]!;
          }
        } else if (recordArms.length > 1) {
          const ownShapeId = mapped?.kind === "record" ? mapped.shapeId : null;
          // SEVERAL record arms (the reducer-action / discriminated-message
          // pattern): the literal's own inferred shape re-tags into no arm
          // — its field types widened per field (`parsed: 1` against
          // `parsed: number | null`), so the IR-level candidate probe is
          // ambiguous (a narrower arm also admits the literal by dropping
          // fields). The LITERAL types tsc checked carry the discriminant
          // the shapes erased: match the literal's fields against each
          // union member's CHECKER types (literal-vs-literal field pairs
          // decide by value — the `kind: "a"` discriminant), and when
          // exactly ONE member fits, build AS that arm — its field types
          // drive every property's coercion, exactly the single-record-arm
          // rule above. Ambiguous literals keep the SC2003 fence.
          if (ownShapeId === null || !recordArms.some((a) => a.shapeId === ownShapeId)) {
            const arm = literalUnionArmOf(L, expr, tsType, recordArms);
            if (arm) mapped = arm;
          }
        }
      }
    }
    // The CJS EXPORT-TABLE literal in VALUE position (JS): importers reach
    // every member through alias plumbing and accessor lifts — the record
    // VALUE exists for the module's own reads (Object.keys, internal
    // member reads), so it keeps exactly the plain fields whose values
    // lower; accessor entries and members with no value representation
    // (rest-param function types) narrow away. SEMANTICS.md documents the
    // enumeration divergence.
    if (
      isJsSourceFile(expr.getSourceFile()) &&
      (!mapped || expr.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) &&
      isCjsExportTableLiteral(expr)
    ) {
      const fields: { name: string; value: IrExpr }[] = [];
      for (const prop of expr.properties) {
        if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) continue;
        const propName = ts.isSpreadAssignment(prop) ? undefined : prop.name;
        if (!propName || !(ts.isIdentifier(propName) || ts.isStringLiteral(propName))) continue;
        const name = propName.text;
        let v: IrExpr | null = null;
        if (ts.isShorthandPropertyAssignment(prop)) {
          v = probeLower(L, propName as ts.Identifier);
        } else if (ts.isPropertyAssignment(prop)) {
          v = probeLower(L, prop.initializer);
        }
        if (!v || v.type.kind === "void" || v.type.kind === "caught" || v.type.kind === "jsval") continue;
        if (isUnitType(v.type)) continue;
        fields.push({ name, value: v });
      }
      // Canonical (sorted) field order — the shape registry's invariant;
      // the dropped reads are all pure, so reordering loses nothing.
      fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const shapeId = L.shapes.intern(fields.map((f) => ({ name: f.name, type: f.value.type })));
      return { kind: "recordLit", fields, type: { kind: "record", shapeId }, loc };
    }
    // The JS declaration fallback, literal-side (the checked-dynamic tree-array rule's
    // object form): a literal whose shape has no static home — an
    // unmappable contextual type over unmappable own fields (the
    // PropertyDescriptorMap argument of Object.defineProperties, nested
    // descriptor records with `any` values) — builds as a dyn OBJECT:
    // each field converts through the usual dyn boundary, and dynamic
    // consumers ride the keyed-dyn paths. TypeScript keeps the fence.
    if ((!mapped || mapped.kind === "dyn") && isJsSourceFile(expr.getSourceFile())) {
      return lowerDynObjectLiteral(L, expr);
    }
    // A TS-source object literal with a JSVAL contextual type (e.g. `{ default:
    // m.Widget }` inside a lambda passed to a JSVAL .then()) — build it as an
    // island JSVAL object literal so values are jsvalIn-wrapped rather than
    // failing with SC2001 (the contextual type can't be statically shaped).
    if (mapped?.kind === "jsval") {
      return lowerJsvalObjectLiteralFromTsSource(L, expr);
    }
    if (!mapped || mapped.kind !== "record") L.badType(expr, tsType);
    let type = mapped;
    let shape = L.shapes.get(type.shapeId)!;
    // ACCESSOR properties, JS literals only (TS accessors fill the shape's
    // %get:/%set: closure slots below): no record storage exists for them,
    // so the literal's shape NARROWS to its plain fields (reads resolve
    // through the lifted accessors; Object.keys over the value omits
    // accessor names — the documented divergence).
    if (isJsSourceFile(expr.getSourceFile())) {
      const accessorNames = new Set(
        expr.properties
          .filter((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
          .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ""))
          .filter((n) => n !== ""),
      );
      if (accessorNames.size > 0) {
        const narrowed = shape.fields.filter((f) => !accessorNames.has(f.name));
        const narrowedId = L.shapes.intern(
          narrowed.map((f) => ({ name: f.name, type: f.type })),
          false,
          shape.indexValue,
        );
        type = { kind: "record", shapeId: narrowedId };
        shape = L.shapes.get(narrowedId)!;
      }
    }
    const fieldTypes = new Map(shape.fields.map((f) => [f.name, f.type]));
    // The clone probe may lower the leading spread before declining (a
    // static `as` cast can make the checker-visible shape match while its
    // erased IR value keeps a wider shape). Reuse that exact value in the
    // ordinary spread path so lowering still happens once.
    let leadingSpreadLowered: IrExpr | null = null;

    // The overwhelmingly common immutable-update form over a record:
    // `{ ...model, changed, other: value }`. The historic lowering expanded
    // the spread into one recordGet per untouched field at EVERY site, then
    // the backends inlined all of those retains and stores into the caller.
    // A 178-field model updated hundreds of times consequently produced a
    // half-million-line LLVM function. Keep the same evaluation/ownership
    // semantics in one compact IR node: source first, explicit overrides in
    // source order, and one backend clone helper per shape.
    //
    // Stay deliberately narrow. Tuple/index/accessor shapes, conditional or
    // multiple spreads, spread-after-explicit order, and shape-changing width
    // copies retain their existing lowering and diagnostics.
    if (
      !isJsSourceFile(expr.getSourceFile()) &&
      !shape.indexValue &&
      !shape.tuple &&
      !shapeHasAccessorSlots(shape) &&
      expr.properties.length >= 2 &&
      ts.isSpreadAssignment(expr.properties[0]!) &&
      !conditionalSpreadOf(expr.properties[0]!.expression) &&
      expr.properties.slice(1).every(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          p.name !== undefined &&
          (ts.isIdentifier(p.name) ||
            ts.isStringLiteral(p.name) ||
            ts.isNumericLiteral(p.name) ||
            (ts.isComputedPropertyName(p.name) && literalComputedKey(L, p.name) !== null)),
      )
    ) {
      const spread = expr.properties[0]! as ts.SpreadAssignment;
      const props = expr.properties.slice(1) as (
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
      )[];
      const names = props.map((p) => propNameText(L, p.name!));
      const unique = new Set(names);
      const sourceType = L.mapTypeOf(L.typeOf(spread.expression));
      if (
        sourceType?.kind === "record" &&
        sourceType.shapeId === type.shapeId &&
        unique.size === names.length &&
        names.every((name) => fieldTypes.has(name))
      ) {
        const source = L.lowerExpr(spread.expression);
        if (source.type.kind === "record" && source.type.shapeId === type.shapeId) {
          const overrides: { name: string; value: IrExpr }[] = [];
          for (let i = 0; i < props.length; i++) {
            const p = props[i]!;
            const name = names[i]!;
            const fieldType = fieldTypes.get(name)!;
            const valueNode = ts.isPropertyAssignment(p) ? p.initializer : p;
            let value = ts.isPropertyAssignment(p)
              ? L.lowerExpr(p.initializer)
              : L.lowerShorthandValue(p);
            value = L.coerceInto(valueNode, value, fieldType);
            if (!typeEquals(value.type, fieldType)) L.badType(valueNode, L.typeOf(valueNode));
            overrides.push({ name, value });
          }
          return { kind: "recordClone", source, overrides, type, loc };
        }
        leadingSpreadLowered = source;
      }
    }

    // A PURE index-signature target with spreads — `{ ...process.env }`,
    // `{ ...process.env, ...extraEnv }`, `{ ...env, PATH: p }` (the
    // spawn-env pattern): the field-by-field desugar below cannot
    // enumerate runtime overflow keys, so the literal lowers as ONE
    // interned merge-helper call — contributors apply in literal order
    // with keyed writes (JS last-write-wins), sources and values evaluate
    // once each in source order (the call's argument order). A CONDITIONAL
    // spread `...(c ? { k: v } : {})` contributes its one key as a ternary
    // — cond once, v lazily, the empty arm holding the value slot's
    // undefined arm (the explicit-undefined-is-absent stance: JSON and
    // child-env builders drop it, exactly Node's absent key); targets
    // with declared fields keep the historic desugar below.
    const isRuntimeComputedKey = (p: ts.ObjectLiteralElementLike): boolean =>
      !ts.isSpreadAssignment(p) &&
      p.name !== undefined &&
      ts.isComputedPropertyName(p.name) &&
      literalComputedKey(L, p.name) === null;
    if (
      shape.indexValue &&
      shape.fields.length === 0 &&
      !shape.tuple &&
      (expr.properties.some((p) => ts.isSpreadAssignment(p)) || expr.properties.some(isRuntimeComputedKey))
    ) {
      const contributors: IndexMergeContributor[] = [];
      let mergeable = true;
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const cs = conditionalSpreadOf(prop.expression);
          if (cs === "unsupported" || (cs && cs.props.length !== 1)) {
            L.unsupported(
              "SC1090",
              prop,
              "conditional spreads beyond `...(c ? { field: v } : {})` (exactly one property against an empty arm)",
            );
          }
          if (cs) {
            const absent = L.wrappedUndefined(shape.indexValue, locOf(prop));
            if (!absent) {
              L.unsupported(
                "SC1090",
                prop,
                `conditional spreads into '${L.fmt(shape.indexValue)}'-valued index-signature keys (the empty arm needs an undefined arm to hold — write the key in an if statement instead)`,
              );
            }
            const csProp = cs.props[0]!;
            const cond = L.lowerCondition(cs.cond);
            const vNode: ts.Node = ts.isPropertyAssignment(csProp) ? csProp.initializer : csProp;
            const v = L.intoIndexValueSlot(
              ts.isPropertyAssignment(csProp) ? L.lowerExpr(csProp.initializer) : L.lowerShorthandValue(csProp),
              shape.indexValue,
              vNode,
            );
            contributors.push({
              kind: "field",
              name: csProp.name.text,
              value: {
                kind: "ternary",
                cond,
                then: cs.whenTrue ? v : absent,
                else_: cs.whenTrue ? absent : v,
                type: shape.indexValue,
                loc: locOf(prop),
              },
            });
            continue;
          }
          const src = L.lowerExpr(prop.expression);
          if (src.type.kind !== "record") {
            L.unsupported(
              "SC1090",
              prop,
              `object spread of '${L.fmt(src.type)}' sources into an index-signature shape (only index-signature records merge — ${NARROW_FIRST})`,
            );
          }
          fenceAccessorSpreadSource(L, prop, L.shapes.get(src.type.shapeId));
          contributors.push({ kind: "spread", shapeId: src.type.shapeId, value: src });
          continue;
        }
        if (
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
          prop.name &&
          (ts.isIdentifier(prop.name) ||
            ts.isStringLiteral(prop.name) ||
            ts.isNumericLiteral(prop.name) ||
            (ts.isComputedPropertyName(prop.name) && literalComputedKey(L, prop.name) !== null))
        ) {
          const value = ts.isPropertyAssignment(prop)
            ? L.intoIndexValueSlot(L.lowerExpr(prop.initializer), shape.indexValue, prop.initializer)
            : L.intoIndexValueSlot(L.lowerShorthandValue(prop), shape.indexValue, prop);
          contributors.push({ kind: "field", name: propNameText(L, prop.name), value });
          continue;
        }
        // A RUNTIME-keyed property (`{ ...m, ["a" + "b"]: "" }`, `{ [K]:
        // v }` where K is a runtime string): the key evaluates before its
        // value (JS's per-property order — both are helper arguments) and
        // writes through the signature exactly like a spread's keys.
        // Number/boolean/unknown keys stringify (ToPropertyKey).
        if (ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
          let k = L.lowerExpr(prop.name.expression);
          if (k.type.kind === "f64" || k.type.kind === "bool" || k.type.kind === "dyn") {
            k = { kind: "toString", operand: k, type: STRING, loc: locOf(prop.name) };
          }
          if (k.type.kind !== "string") {
            L.unsupported(
              "SC1090",
              prop.name,
              `'${L.fmt(k.type)}'-typed computed property keys (string, number, boolean, and unknown keys stringify)`,
            );
          }
          const value = L.intoIndexValueSlot(L.lowerExpr(prop.initializer), shape.indexValue, prop.initializer);
          contributors.push({ kind: "keyedField", key: k, value });
          continue;
        }
        mergeable = false;
        break;
      }
      if (mergeable) {
        const helper = lowerIndexMergeHelper(L, type.shapeId, contributors, loc);
        if (helper === null) {
          L.unsupported(
            "SC1090",
            expr,
            `object spread into '${L.fmt(type)}' from these source shapes (spread sources must be index-signature records whose value type is, or lifts into, the target's)`,
          );
        }
        return {
          kind: "call",
          callee: helper,
          args: contributors.flatMap((c) => (c.kind === "keyedField" ? [c.key, c.value] : [c.value])),
          type,
          loc,
        };
      }
    }
    // Unfoldable computed keys outside the index-signature merge path:
    // no record shape can hold a runtime-decided name.
    for (const prop of expr.properties) {
      if (isRuntimeComputedKey(prop)) {
        L.unsupported("SC1090", (prop as ts.PropertyAssignment).name, "computed property keys (compile-time-known keys fold — a pure expression whose checker type is one string or number literal: consts, enum members, quoted keys, templates of those — `{ [MARKER]: v }`; runtime string keys write through an index-signature target; symbol keys stay out)");
      }
    }

    // A DECLARED-fields target built ENTIRELY from index-signature spreads —
    // `{ ...Object.fromEntries(...), ...Object.fromEntries(...) }` typed
    // AppConfig (the defaults-merge idiom over runtime-keyed sources): the
    // field-by-field desugar cannot enumerate runtime keys, so the literal
    // lowers as ONE interned merge-helper call — sources evaluate once each
    // in source order (the call's argument order — computed sources
    // included, no re-read), contributors apply in order with per-key
    // dispatch onto the declared fields (JS last-write-wins). Divergence 68
    // has the runtime rules (validated collisions, extra keys dropped).
    if (
      !shape.indexValue &&
      !shape.tuple &&
      shape.fields.length > 0 &&
      expr.properties.length > 0 &&
      expr.properties.every((p) => ts.isSpreadAssignment(p) && !conditionalSpreadOf(p.expression)) &&
      expr.properties.some((p) => {
        const t = L.mapTypeOf(L.typeOf((p as ts.SpreadAssignment).expression));
        return t?.kind === "record" && !!L.shapes.get(t.shapeId)?.indexValue;
      })
    ) {
      return lowerDeclaredSpreadMerge(L, expr, type, shape, loc);
    }

    const shapeMismatch = (node: ts.Node): never => {
      const own = L.mapTypeOf(L.typeOf(expr));
      L.pushDiag(
        recordShapeMismatchDiag(
          L.fmt(type),
          own ? L.fmt(own) : L.checker.typeToString(L.typeOf(expr)),
          locOf(node),
          own?.kind === "record"
            ? (L.describeRecordWidthBlocker(own.shapeId, type.shapeId) ?? undefined)
            : undefined,
        ),
      );
      throw new PoisonError();
    };

    const fields: { name: string; value: IrExpr; overflow?: true; drop?: true }[] = [];
    // Field names introduced by conditional spreads: their ternary carries
    // the spread's whole evaluation (cond once, value lazily), so a LATER
    // contributor overriding one would silently drop that evaluation —
    // collisions fence in both directions.
    const conditionalNames = new Set<string>();
    // Member names DROPPED from the shape (JS deferral — unlowerable pure
    // member reads narrow away; see the catch in the property loop).
    const droppedNames = new Set<string>();
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const cs = conditionalSpreadOf(prop.expression);
        if (cs && cs !== "unsupported") {
          // `...(c ? { k: v } : {})` — ONE conditional field at the
          // spread's own position: cond evaluates exactly once, `v` only
          // when the non-empty arm is taken (ternary arms are lazy), and
          // the empty arm holds the interned undefined arm — exactly the
          // omitted-optional-field representation, which is also why the
          // target field must be optional (tsc types the idiom that way).
          const csProp = cs.props[0]!; // single-prop-checked in the fence pass
          const name = csProp.name.text;
          const fieldType = fieldTypes.get(name);
          if (!fieldType) {
            if (shape.indexValue) {
              L.unsupported(
                "SC1090",
                prop,
                "conditional spreads into index-signature keys (overflow entries model presence — write the key in an if statement instead)",
              );
            }
            throw shapeMismatch(prop);
          }
          const absent = L.wrappedUndefined(fieldType, locOf(prop));
          if (!absent) {
            L.unsupported(
              "SC1090",
              prop,
              `conditional spreads onto the required field '${name}' (the empty arm leaves it undefined — declare the field optional)`,
            );
          }
          if (fields.some((f) => f.name === name)) {
            L.unsupported(
              "SC1090",
              prop,
              `conditional spread of '${name}' over an earlier '${name}' (the desugar keeps one entry per name — restructure so each name has one contributor)`,
            );
          }
          const cond = L.lowerCondition(cs.cond);
          const valueNode = ts.isPropertyAssignment(csProp) ? csProp.initializer : csProp;
          let v = ts.isPropertyAssignment(csProp)
            ? L.lowerExpr(csProp.initializer)
            : L.lowerShorthandValue(csProp);
          v = L.coerceInto(valueNode, v, fieldType);
          if (!typeEquals(v.type, fieldType)) L.badType(valueNode, L.typeOf(valueNode));
          conditionalNames.add(name);
          fields.push({
            name,
            value: {
              kind: "ternary",
              cond,
              then: cs.whenTrue ? v : absent,
              else_: cs.whenTrue ? absent : v,
              type: fieldType,
              loc: locOf(prop),
            },
          });
          continue;
        }
        // `{ ...base, ... }` — field-by-field copy of a known record
        // shape. Every source field must land on the target shape with an
        // equal type (a wider source would silently DROP fields JS keeps —
        // the width fence, same as literals). Later contributors override
        // earlier ones (JS last-write-wins; the reads are side-effect-free,
        // so dropping the earlier read is exact). Identifier sources
        // re-read per field (historic path); any OTHER source must be a
        // re-emittable pure read, sharing one lowered node per field.
        // The desugar's one-entry-per-name list reads spread fields
        // EAGERLY at the spread's position, so an explicit property
        // BEFORE a spread would need JS's overwrite — order-fenced (the
        // index-signature merge path above takes any order).
        if (
          expr.properties
            .slice(0, expr.properties.indexOf(prop))
            .some((p) => !ts.isSpreadAssignment(p))
        ) {
          L.unsupported(
            "SC1090",
            prop,
            "object spread after explicit properties (spreads must come first — a later spread would overwrite them with JS semantics the desugar does not model)",
          );
        }
        let srcNode: ts.Expression = prop.expression;
        while (ts.isParenthesizedExpression(srcNode)) srcNode = srcNode.expression;
        const srcLowered =
          prop === expr.properties[0] && leadingSpreadLowered !== null
            ? leadingSpreadLowered
            : ts.isIdentifier(srcNode)
              ? null
              : L.lowerExpr(srcNode);
        const srcType = srcLowered ? srcLowered.type : L.mapTypeOf(L.typeOf(srcNode));
        // `...options.installConfig` — a spread of `Partial<X> | undefined`
        // (the optional-options merge idiom `{ ...DEFAULTS, ...overrides }`):
        // JS spreads nothing for the unit arm and copies present keys
        // otherwise. Per target field the desugar builds
        // `present ? extracted : earlier` — present tests the source's
        // record tag AND (optional source fields) the field's own value
        // arm; absent keeps the earlier contributor's value (both reads
        // are pure, so the reorder into the ternary is unobservable).
        if (srcType?.kind === "union") {
          const def = L.unions.get(srcType.unionId);
          const recArms = def?.arms.filter((a) => a.kind === "record") ?? [];
          if (
            !def ||
            recArms.length !== 1 ||
            !def.arms.every((a) => a.kind === "record" || isUnitType(a))
          ) {
            L.unsupported(
              "SC1090",
              prop,
              `object spread of '${L.fmt(srcType)}' sources (only known record shapes spread — ${NARROW_FIRST})`,
            );
          }
          if (srcLowered && !pureReemittable(srcLowered)) {
            L.unsupported(
              "SC1090",
              prop,
              "object spread of computed sources (the field copies re-read the source — bind it to a const first)",
            );
          }
          const recArm = recArms[0]! as IrType & { kind: "record" };
          const recTag = def.arms.indexOf(recArm);
          // A checked-dynamic VALUE under the union-mapped checker type
          // (a JS dyn-holding binding): the present/absent desugar tests
          // union tags a dyn box does not carry — fence honestly instead
          // of the validator's ICE.
          const probedSrc = srcLowered ?? probeLower(L, srcNode);
          if (probedSrc?.type.kind === "dyn") {
            L.unsupported(
              "SC1090",
              prop,
              `object spread of a checked-dynamic '${L.fmt(srcType)}' source (${NARROW_FIRST})`,
            );
          }
          const srcShape = L.shapes.get(recArm.shapeId);
          if (!srcShape) throw new InternalCompilerError(`lowerer bug: spread of unknown shape ${recArm.shapeId}`);
          fenceAccessorSpreadSource(L, prop, srcShape);
          if (srcShape.indexValue || shape.indexValue) {
            L.unsupported(
              "SC1090",
              prop,
              "object spread involving index-signature shapes (overflow keys are runtime state — copy the fields you need explicitly)",
            );
          }
          const laterNames = new Set<string>();
          for (const later of expr.properties.slice(expr.properties.indexOf(prop) + 1)) {
            if (ts.isSpreadAssignment(later)) {
              if (conditionalSpreadOf(later.expression)) continue;
              const lt = L.mapTypeOf(L.typeOf(later.expression));
              if (lt?.kind === "record") {
                for (const lf of L.shapes.get(lt.shapeId)?.fields ?? []) laterNames.add(lf.name);
              }
              continue;
            }
            if (
              later.name &&
              (ts.isIdentifier(later.name) ||
                ts.isStringLiteral(later.name) ||
                ts.isNumericLiteral(later.name) ||
                (ts.isComputedPropertyName(later.name) && literalComputedKey(L, later.name) !== null))
            ) {
              laterNames.add(propNameText(L, later.name));
            }
          }
          const srcRef = (): IrExpr => srcLowered ?? L.lowerExpr(srcNode);
          for (const f of srcShape.fields) {
            if (laterNames.has(f.name)) continue;
            const targetType = fieldTypes.get(f.name);
            // No slot on the target shape: the copy DROPS the field
            // (divergence 36's stance, same as the plain-record spread).
            if (!targetType) continue;
            if (conditionalNames.has(f.name)) {
              L.unsupported(
                "SC1090",
                prop,
                `spread of '${f.name}' over an earlier conditional spread (the desugar keeps one entry per name — restructure so each name has one contributor)`,
              );
            }
            const fRead = (): IrExpr => ({
              kind: "recordGet",
              obj: { kind: "unionNarrow", unionId: srcType.unionId, tag: recTag, value: srcRef(), type: recArm, loc: locOf(prop) },
              shapeId: recArm.shapeId,
              field: f.name,
              type: f.type,
              loc: locOf(prop),
            });
            let cond: IrExpr = { kind: "unionIsTag", unionId: srcType.unionId, tag: recTag, negated: false, value: srcRef(), type: BOOL, loc: locOf(prop) };
            let thenVal: IrExpr;
            if (typeEquals(f.type, targetType)) {
              thenVal = fRead();
            } else if (
              f.type.kind === "union" &&
              L.armTag(f.type.unionId, UNDEFINED_T) >= 0 &&
              typeEquals(L.stripUndefinedArm(f.type), targetType)
            ) {
              // Optional source field into a required target slot: present
              // means the source holds the record AND the field its value
              // arm — the spread-override completion, union-source form.
              const ftUndef = L.armTag(f.type.unionId, UNDEFINED_T);
              cond = {
                kind: "logical",
                op: "&&",
                left: cond,
                right: { kind: "unionIsTag", unionId: f.type.unionId, tag: ftUndef, negated: true, value: fRead(), type: BOOL, loc: locOf(prop) },
                type: BOOL,
                loc: locOf(prop),
              };
              const ftDef = L.unions.get(f.type.unionId);
              if (targetType.kind === "union") {
                const retag = L.unionRetagHelper(f.type.unionId, targetType.unionId, locOf(prop));
                if (!retag) {
                  L.pushDiag(recordShapeMismatchDiag(L.fmt(type), L.fmt(recArm), locOf(prop), `spread field '${f.name}': '${L.fmt(f.type)}' cannot re-tag into '${L.fmt(targetType)}' behind the present-test`));
                  throw new PoisonError();
                }
                thenVal = { kind: "call", callee: retag, args: [fRead()], type: targetType, loc: locOf(prop) };
              } else if (ftDef && ftDef.arms.length === 2 && L.armTag(f.type.unionId, targetType) >= 0) {
                thenVal = { kind: "unionNarrow", unionId: f.type.unionId, tag: L.armTag(f.type.unionId, targetType), value: fRead(), type: targetType, loc: locOf(prop) };
              } else {
                L.pushDiag(recordShapeMismatchDiag(L.fmt(type), L.fmt(recArm), locOf(prop), `spread field '${f.name}': '${L.fmt(f.type)}' cannot narrow into '${L.fmt(targetType)}' behind the present-test`));
                throw new PoisonError();
              }
            } else {
              // The width-lift fallback (arm wrap, re-tag, nested
              // reshape) — the same per-field rule the slot coercion
              // applies. Runs AFTER the optional-completion branch: a
              // present-test has its own semantics a re-tag's stranded
              // undefined trap must not shadow.
              const lift = L.widthLiftPlan(f.type, targetType);
              if (!lift) {
                L.pushDiag(recordShapeMismatchDiag(L.fmt(type), L.fmt(recArm), locOf(prop), `spread field '${f.name}': '${L.fmt(f.type)}' does not lift into '${L.fmt(targetType)}'`));
                throw new PoisonError();
              }
              thenVal = L.applyWidthLift(lift, fRead(), targetType, locOf(prop));
            }
            const at = fields.findIndex((x) => x.name === f.name && !x.drop);
            const elseVal = at >= 0 ? fields[at]!.value : L.wrappedUndefined(targetType, locOf(prop));
            if (!elseVal) {
              L.unsupported(
                "SC1090",
                prop,
                `object spread of '${L.fmt(srcType)}' sources where '${f.name}' has no earlier contributor (the absent arm leaves the required field unset — spread defaults first: { ...defaults, ...overrides })`,
              );
            }
            const merged: IrExpr = { kind: "ternary", cond, then: thenVal, else_: elseVal, type: targetType, loc: locOf(prop) };
            if (at >= 0) fields[at] = { name: f.name, value: merged };
            else fields.push({ name: f.name, value: merged });
          }
          continue;
        }
        if (srcType?.kind !== "record") {
          L.unsupported(
            "SC1090",
            prop,
            `object spread of '${srcType ? L.fmt(srcType) : L.checker.typeToString(L.typeOf(srcNode))}' sources (only known record shapes spread — ${NARROW_FIRST})`,
          );
        }
        if (srcLowered && !pureReemittable(srcLowered)) {
          L.unsupported(
            "SC1090",
            prop,
            "object spread of computed sources (the field copies re-read the source — bind it to a const first)",
          );
        }
        const srcShape = L.shapes.get(srcType.shapeId);
        if (!srcShape) throw new InternalCompilerError(`lowerer bug: spread of unknown shape ${srcType.shapeId}`);
        fenceAccessorSpreadSource(L, prop, srcShape);
        // Index-signature shapes carry runtime-keyed overflow entries the
        // field-by-field desugar cannot enumerate — fenced on either side.
        if (srcShape.indexValue || shape.indexValue) {
          L.unsupported(
            "SC1090",
            prop,
            "object spread involving index-signature shapes (overflow keys are runtime state — copy the fields you need explicitly)",
          );
        }
        // Names a LATER contributor unconditionally defines: copying such a
        // source field is dead under JS last-write-wins (and spread reads
        // are side-effect-free), so it neither lowers nor width-checks —
        // the spread-then-override completion `{ ...config, stateDir }`
        // narrows an optional source field into a required target slot
        // exactly like Node does. Conditional spreads don't count (their
        // empty arm defines nothing) — their own collision fences hold.
        const laterNames = new Set<string>();
        for (const later of expr.properties.slice(expr.properties.indexOf(prop) + 1)) {
          if (ts.isSpreadAssignment(later)) {
            if (conditionalSpreadOf(later.expression)) continue;
            const lt = L.mapTypeOf(L.typeOf(later.expression));
            if (lt?.kind === "record") {
              for (const lf of L.shapes.get(lt.shapeId)?.fields ?? []) laterNames.add(lf.name);
            }
            continue;
          }
          if (
            later.name &&
            (ts.isIdentifier(later.name) ||
              ts.isStringLiteral(later.name) ||
              ts.isNumericLiteral(later.name) ||
              (ts.isComputedPropertyName(later.name) && literalComputedKey(L, later.name) !== null))
          ) {
            laterNames.add(propNameText(L, later.name));
          }
        }
        for (const f of srcShape.fields) {
          if (laterNames.has(f.name)) continue;
          const targetType = fieldTypes.get(f.name);
          // A source field with NO slot on the target shape: the copy
          // DROPS it — a spread of a wider record into a narrower literal
          // is width subtyping in spread clothing, divergence 36's stance
          // (Node's object would keep the key); the read is pure, so
          // skipping evaluates nothing.
          if (!targetType) continue;
          const lift = typeEquals(f.type, targetType)
            ? null
            : L.widthLiftPlan(f.type, targetType);
          if (!typeEquals(f.type, targetType) && !lift) {
            // Print the SOURCE shape, not the literal's own type: the
            // checker's own type already has later overrides applied, so
            // it can render identically to the target while the spread
            // source (the thing that actually mismatches) differs — an
            // invisible difference is a diagnostics bug.
            L.pushDiag(recordShapeMismatchDiag(L.fmt(type), L.fmt(srcType), locOf(prop), `spread field '${f.name}': '${L.fmt(f.type)}' does not lift into '${L.fmt(targetType)}'`));
            throw new PoisonError();
          }
          const obj = srcLowered ?? L.lowerExpr(srcNode);
          // A record-mapped CHECKER type whose VALUE lives in the checked-dynamic tree (a
          // JS file-scope object-literal global): read each field from
          // the checked-dynamic tree (dynKeyGet) and VALIDATE it into the source shape's
          // field type (dynCheck) — the checked-dynamic member-read
          // discipline. A missing key answers the dyn undefined, exactly
          // the undefined-armed optional's absent case; a mismatched
          // runtime value throws the catchable TypeError, never a silent
          // wrong copy. Runtime-ADDED keys drop — width subtyping in
          // spread clothing, divergence 36's stance.
          let value: IrExpr;
          if (obj.type.kind === "dyn") {
            if (!canDynCheckTo(f.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
              L.unsupported(
                "SC1100",
                prop,
                `object spread of a checked-dynamic source whose field '${f.name}' ('${L.fmt(f.type)}') cannot validate out of the checked-dynamic tree (copy the fields explicitly)`,
              );
            }
            value = {
              kind: "dynCheck",
              value: {
                kind: "dynKeyGet",
                key: { kind: "strLit", value: f.name, type: STRING, loc: locOf(prop) },
                value: obj,
                type: DYN,
                loc: locOf(prop),
              },
              type: f.type,
              loc: locOf(prop),
            };
          } else {
            value = {
              kind: "recordGet",
              obj,
              shapeId: srcType.shapeId,
              field: f.name,
              type: f.type,
              loc: locOf(prop),
            };
          }
          // A liftable field widens into the target slot (arm wrap,
          // re-tag, nested reshape) — the same per-field rule the slot
          // coercion applies.
          if (lift) value = L.applyWidthLift(lift, value, targetType, locOf(prop));
          if (conditionalNames.has(f.name)) {
            L.unsupported(
              "SC1090",
              prop,
              `spread of '${f.name}' over an earlier conditional spread (the desugar keeps one entry per name — restructure so each name has one contributor)`,
            );
          }
          const at = fields.findIndex((x) => x.name === f.name);
          if (at >= 0) fields[at] = { name: f.name, value };
          else fields.push({ name: f.name, value });
        }
        continue;
      }
      if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
        // JS accessor entries carry no storage (narrowed away above); TS
        // accessors fill the shape's reserved closure slots — the getter
        // body lowers as an ordinary zero-arg closure invoked per property
        // READ, the setter as a one-arg closure invoked per WRITE
        // (fieldGetExpr/fieldSetStmt dispatch on the slots). Creating the
        // closures is side-effect-free, so their position among the data
        // fields' source-order evaluation is unobservable — exactly JS,
        // where accessor definitions evaluate nothing.
        if (isJsSourceFile(expr.getSourceFile())) continue;
        const name = propNameText(L, prop.name); // key-form-checked above
        const slotName = `${ts.isGetAccessorDeclaration(prop) ? "%get" : "%set"}:${name}`;
        const slotT = fieldTypes.get(slotName);
        if (!slotT || slotT.kind !== "func") {
          // The contextual shape stores a DATA value under this name
          // (`const p: { x: number } = { get x() {...} }` — tsc lets a
          // live accessor satisfy a data member): the slot would freeze
          // one getter answer where Node keeps the accessor live.
          if (fieldTypes.has(name)) {
            L.unsupported(
              "SC1090",
              prop,
              `a get/set accessor satisfying the data property '${name}' of '${L.fmt(type)}' (the record slot stores a plain value — Node would keep the accessor live through this type)`,
            );
          }
          throw shapeMismatch(prop);
        }
        const closure = L.coerceInto(prop, L.lowerLambda(prop), slotT);
        if (!typeEquals(closure.type, slotT)) L.badType(prop, L.typeOf(prop));
        fields.push({ name: slotName, value: closure });
        continue;
      }
      const name = propNameText(L, prop.name!); // key-form-checked above
      const fieldType = fieldTypes.get(name);
      // An undeclared name against an index-signature shape is an OVERFLOW
      // entry (tsc typechecked it against the signature's value type);
      // against a plain shape it is the width mismatch it always was —
      // EXCEPT the PromiseSettledResult honest subset's dropped fields
      // (value/reason — SEMANTICS.md 46): those evaluate for effect in
      // their source-order slot and store nothing.
      // A GENERIC-callable member (a generic method `m<T>(x: T) {...}` or a
      // generic arrow/function-expression property): excluded from the
      // record shape (isGenericCallableMemberType — no single closure slot
      // can hold it), so the literal stores nothing for it. Pure
      // function-creating forms skip outright (creating a closure has no
      // side effects; calls resolve statically against this declaration);
      // a computed initializer would need its evaluation kept — fenced.
      if (!fieldType && !ts.isSpreadAssignment(prop)) {
        const memberSym = prop.name && L.checker.getSymbolAtLocation(prop.name);
        const memberT = memberSym ? L.checker.getTypeOfSymbol(memberSym) : undefined;
        if (memberT && isGenericCallableMemberType(memberT, L.checker)) {
          const pureInit = (() => {
            if (ts.isMethodDeclaration(prop)) return true;
            if (ts.isShorthandPropertyAssignment(prop)) return true; // a pure read
            if (!ts.isPropertyAssignment(prop)) return false;
            let init: ts.Expression = prop.initializer;
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            return ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isIdentifier(init);
          })();
          if (!pureInit) {
            L.unsupported(
              "SC1090",
              prop,
              `generic-function-valued properties with computed initializers ('${name}' has no record slot — its evaluation would be dropped; bind the function to a top-level declaration instead)`,
            );
          }
          continue;
        }
      }
      if (!fieldType && !shape.indexValue) {
        if (settledDropNames(L, tsType)?.has(name)) {
          // Identifier and shorthand initializers are effect-free reads —
          // skipped outright. The caught `reason` MUST skip: lowering the
          // read would hit the catch-binding narrowness fence, and the
          // snapshot it names needs no evaluation.
          if (ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.initializer)) {
            const v = L.lowerExpr(prop.initializer);
            // Effect-free lowerings (literals, plain reads) drop at
            // compile time; anything else — the awaited mapper — runs
            // (and may throw into the enclosing catch) with its result
            // released by the statement frame.
            if (
              v.kind !== "unitLit" && v.kind !== "numLit" && v.kind !== "strLit" &&
              v.kind !== "boolLit" && v.kind !== "varRef" && v.kind !== "closure"
            ) {
              fields.push({ name, value: v, drop: true });
            }
          }
          continue;
        }
        throw shapeMismatch(prop);
      }

      let value: IrExpr;
      let valueNode: ts.Node = prop;
      const propDiagsBefore = L.diags.length;
      try {
      if (ts.isPropertyAssignment(prop)) {
        valueNode = prop.initializer;
        // ARRAY-LITERAL initializers route through the expected-type
        // lowering: a union field with one array-family arm builds the
        // literal AS that arm (lowerExprExpecting's IR-directed rule —
        // the option-table `default: [{ value: [] }]` shape), where the
        // bare lowering would take the JS dyn fallback and fence.
        let init: ts.Expression = prop.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        value =
          fenceClosureProbe(L, prop.initializer, fieldType, () => L.lowerExpr(prop.initializer)) ??
          (fieldType !== undefined && ts.isArrayLiteralExpression(init)
            ? L.lowerExprExpecting(prop.initializer, fieldType)
            : L.lowerExpr(prop.initializer));
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        value = L.lowerShorthandValue(prop);
      } else if (ts.isMethodDeclaration(prop)) {
        value =
          fenceClosureProbe(L, prop, fieldType, () => L.lowerLambda(prop)) ?? L.lowerLambda(prop);
      } else {
        L.unsupported("SC1090", prop, `syntax '${ts.SyntaxKind[(prop as ts.Node).kind]}'`);
      }
      } catch (err) {
        // A member VALUE a JS file cannot lower (a namespace object in an
        // export aggregate — the sharedWithCli `errors` member): the
        // member NARROWS AWAY like a CJS export-table accessor entry —
        // the diagnostics defer to the runtime-fence ledger, the shape
        // drops the field, and each READ of it meets its own per-site
        // fence. Pure member forms only (identifier/shorthand reads);
        // TypeScript, probe mode, and ICEs keep the poison.
        const pureMember =
          ts.isShorthandPropertyAssignment(prop) ||
          (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer));
        if (
          !(err instanceof PoisonError) ||
          !pureMember ||
          !isJsSourceFile(expr.getSourceFile()) ||
          L.diagSink !== null ||
          L.diags.length <= propDiagsBefore ||
          L.diags.slice(propDiagsBefore).some((d) => d.code === "SC9001")
        ) {
          throw err;
        }
        L.runtimeFences.push(...L.diags.splice(propDiagsBefore));
        droppedNames.add(name);
        continue;
      }
      if (!fieldType) {
        // Overflow entry: the value flows into the index signature's value
        // slot — dyn slots take a dyn conversion (dynFrom), typed slots the
        // ordinary coercion path. Later duplicates override (map semantics
        // are last-write-wins already; a duplicate literal key is a tsc
        // error anyway).
        const slotted = L.intoIndexValueSlot(value, shape.indexValue!, valueNode);
        fields.push({ name, value: slotted, overflow: true });
        continue;
      }
      value = L.coerceInto(valueNode, value, fieldType); // union-typed fields wrap arm values
      // In a .then() callback on a JSVAL-bearing promise (e.g. import("./foo.tsx")),
      // island values (JSVAL) are allowed in any field — the module resolves to {} at
      // runtime and field values are JSVAL engine handles. coerceInto already passed
      // with inJsvalThenHandler; don't re-check with badType.
      if (!typeEquals(value.type, fieldType) && !L.inJsvalThenHandler) L.badType(valueNode, L.typeOf(valueNode));
      // An explicit property overrides a spread-copied field: JS
      // last-write-wins. The entry moves to the END so explicit property
      // values keep their source-order evaluation among themselves. A
      // conditional-spread entry cannot be overridden (its ternary IS the
      // spread's evaluation; splicing it out would drop that).
      if (conditionalNames.has(name)) {
        L.unsupported(
          "SC1090",
          prop,
          `'${name}' after a conditional spread of the same name (the desugar keeps one entry per name — restructure so each name has one contributor)`,
        );
      }
      const at = fields.findIndex((x) => x.name === name);
      if (at >= 0) fields.splice(at, 1);
      fields.push({ name, value });
    }
    // Optional fields (undefined-armed union slots) may be omitted: the
    // absent field holds the interned undefined arm, exactly like writing
    // `a: undefined` (without exactOptionalPropertyTypes tsc treats the two
    // the same, and only optional fields may be omitted — tsc rejects
    // omission of required fields before lowering, undefined-armed or not).
    // A REQUIRED missing field keeps the shape-mismatch rejection (possible
    // through `as`: the cast smuggles a narrower literal past freshness).
    if (droppedNames.size > 0) {
      const narrowed = shape.fields.filter((f) => !droppedNames.has(f.name));
      const narrowedId = L.shapes.intern(
        narrowed.map((f) => ({ name: f.name, type: f.type })),
        false,
        shape.indexValue,
      );
      type = { kind: "record", shapeId: narrowedId };
      shape = L.shapes.get(narrowedId)!;
    }
    if (fields.filter((f) => !f.overflow).length !== shape.fields.length) {
      const provided = new Set(fields.filter((f) => !f.overflow).map((f) => f.name));
      for (const f of shape.fields) {
        if (provided.has(f.name)) continue;
        // 'unknown' fields complete with the dyn undefined — the absent
        // property reads as undefined in Node, and a dyn slot holds
        // exactly that (the options-record call shape against
        // `{ plugins: unknown, ... }` — a JS caller the checker admits).
        const absent = L.wrappedUndefined(f.type, loc) ?? (f.type.kind === "dyn" ? dynUndefinedExpr(loc) : null);
        if (!absent) throw shapeMismatch(expr); // only optional (undefined-armed) and 'unknown' fields may be omitted
        fields.push({ name: f.name, value: absent });
      }
    }
    return { kind: "recordLit", fields, type, loc };
  }

/** A conditional spread's carrier property: `name: value` or shorthand,
   * with an identifier/string-literal name. */
  export type CondSpreadProp = (ts.PropertyAssignment | ts.ShorthandPropertyAssignment) & { name: ts.Identifier | ts.StringLiteral };

/** Parses the conditional-spread idiom `...(c ? { k: v, ... } : {})`
   * (either orientation). Returns the condition, the non-empty arm's
   * properties, and which arm carries them; "unsupported" for conditional
   * sources OUTSIDE the idiom (both arms non-empty, computed/method
   * members); null when the spread source isn't a conditional at all.
   * Callers slice their own honest subset (the static record path takes
   * exactly one property; the island literal takes any number; spawn's
   * options walk takes a `detached` boolean literal). */
  export function conditionalSpreadOf(expr: ts.Expression):
    | { cond: ts.Expression; props: CondSpreadProp[]; whenTrue: boolean }
    | "unsupported"
    | null {
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isConditionalExpression(e)) return null;
    const unwrap = (a: ts.Expression): ts.Expression => {
      let x = a;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      return x;
    };
    const whenTrue = unwrap(e.whenTrue);
    const whenFalse = unwrap(e.whenFalse);
    if (!ts.isObjectLiteralExpression(whenTrue) || !ts.isObjectLiteralExpression(whenFalse)) {
      return "unsupported";
    }
    const trueCarries = whenFalse.properties.length === 0 && whenTrue.properties.length > 0;
    const falseCarries = whenTrue.properties.length === 0 && whenFalse.properties.length > 0;
    if (!trueCarries && !falseCarries) return "unsupported"; // both empty is tsc-unreachable; both non-empty has no single desugar
    const carrier = trueCarries ? whenTrue : whenFalse;
    const props: CondSpreadProp[] = [];
    for (const p of carrier.properties) {
      if (
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      ) {
        props.push(p as CondSpreadProp);
      } else {
        return "unsupported";
      }
    }
    return { cond: e.condition, props, whenTrue: trueCarries };
  }

/** `{ ...idx, ...idx2 }` typed a DECLARED shape (no index signature) — the
   * defaults-merge idiom over runtime-keyed sources (`{ ...fromEntries(a),
   * ...fromEntries(b) }` typed AppConfig). Lowers to ONE interned helper
   * call: sources evaluate once each as arguments (source order — computed
   * sources included, JS's evaluate-once), the result starts all-undefined
   * (every target field must be optional — the runtime keys decide
   * presence), and each source's keys apply in JS own-key order with a
   * per-key dispatch onto the declared fields: a matching key writes the
   * field — identity when the source's value slot IS the field type, a
   * validated extraction otherwise (a dyn slot dynChecks; a union slot
   * re-tags arm-by-arm, and a value outside the field's arms throws the
   * catchable TypeError — divergence 34's keyed-write stance, where Node's
   * untyped copy would store the lie) — and a key naming NO declared field
   * is DROPPED (the shape cannot represent it; Node keeps it invisibly —
   * divergence 68). Later contributors overwrite earlier ones
   * (last-write-wins). Sources must be PURE index-signature records. */
  function lowerDeclaredSpreadMerge(L: Lowerer, expr: ts.ObjectLiteralExpression,
    type: IrType & { kind: "record" },
    shape: IrRecordShape,
    loc: SrcLoc,): IrExpr {
    interface Src { value: IrExpr; shapeId: string; iv: IrType }
    const srcs: Src[] = [];
    for (const prop of expr.properties) {
      const spread = prop as ts.SpreadAssignment; // caller-checked: all spreads
      const value = L.lowerExpr(spread.expression);
      const srcShape = value.type.kind === "record" ? L.shapes.get(value.type.shapeId) : undefined;
      if (value.type.kind !== "record" || !srcShape?.indexValue || srcShape.tuple || srcShape.fields.length > 0) {
        L.unsupported(
          "SC1090",
          prop,
          `object spread of '${L.fmt(value.type)}' into '${L.fmt(type)}' (only PURE index-signature records — Object.fromEntries results, Record<string, T> values — spread into a declared shape)`,
        );
      }
      srcs.push({ value, shapeId: value.type.shapeId, iv: srcShape.indexValue });
    }
    // Every target field must be optional: absent keys leave the undefined
    // arm, exactly the unset-optional representation.
    for (const f of shape.fields) {
      if (f.type.kind !== "union" || L.armTag(f.type.unionId, UNDEFINED_T) < 0) {
        L.unsupported(
          "SC1090",
          expr,
          `object spread of runtime-keyed sources onto the required field '${f.name}' (the keys decide presence at runtime — declare the field optional or spell it explicitly)`,
        );
      }
    }
    // Per (source value slot → field) conversion, checked up front so the
    // fence fires at the literal, not inside the interned helper.
    const conv = (iv: IrType, f: { name: string; type: IrType }, v: IrExpr): { value: IrExpr } | { stmts: (write: (value: IrExpr) => IrStmt) => IrStmt[] } => {
      if (typeEquals(iv, f.type)) return { value: v };
      if (iv.kind === "dyn") {
        return { value: { kind: "dynCheck", value: v, type: f.type, loc } };
      }
      if (iv.kind === "union" && f.type.kind === "union") {
        const fUnion = f.type;
        const def = L.unions.get(iv.unionId);
        const fDef = L.unions.get(fUnion.unionId);
        if (def && fDef && def.arms.some((a) => L.armTag(fUnion.unionId, a) >= 0)) {
          // Arm-by-arm validated re-tag, inline in the helper: matching
          // arms map by identity (unit arms re-wrap, value arms narrow and
          // wrap); anything else throws the catchable TypeError.
          return {
            stmts: (write) => {
              const chain = (i: number): IrStmt[] => {
                if (i >= def.arms.length) {
                  return [{
                    kind: "throw",
                    value: {
                      kind: "libCall",
                      fn: "error.new",
                      args: [{ kind: "strLit", value: `expected ${L.fmt(fUnion)} at $.${f.name}`, type: STRING, loc }],
                      type: { kind: "object", className: "%TypeError" },
                      loc,
                    },
                    loc,
                  }];
                }
                const arm = def.arms[i]!;
                const toTag = L.armTag(fUnion.unionId, arm);
                if (toTag < 0) return chain(i + 1);
                const extracted: IrExpr = isUnitType(arm)
                  ? { kind: "unionWrap", unionId: fUnion.unionId, tag: toTag, value: { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }, type: fUnion, loc }
                  : { kind: "unionWrap", unionId: fUnion.unionId, tag: toTag, value: { kind: "unionNarrow", unionId: iv.unionId, tag: i, value: v, type: arm, loc }, type: fUnion, loc };
                return [{
                  kind: "if",
                  cond: { kind: "unionIsTag", unionId: iv.unionId, tag: i, negated: false, value: v, type: BOOL, loc },
                  then: [write(extracted)],
                  else_: chain(i + 1),
                  loc,
                }];
              };
              return chain(0);
            },
          };
        }
      }
      L.unsupported(
        "SC1090",
        expr,
        `object spread into '${L.fmt(type)}' where the source's '${L.fmt(iv)}' values cannot reach the '${L.fmt(f.type)}' field '${f.name}' (the value slot must be the field type, 'unknown', or a union covering the field's arms)`,
      );
    };
    const key = `declmerge:${type.shapeId}:${srcs.map((s) => s.shapeId).join(",")}`;
    let helper = L.widthHelpers.get(key);
    if (!helper) {
      helper = `%rec.declmerge.${L.widthHelpers.size}`;

      const outRef = varRef("out.0", type, loc);
      const ksT = arrayOf(STRING);
      const locals: IrLocal[] = [{ id: "out.0", name: "out", type, mutable: false }];
      const params = srcs.map((s, j) => {
        locals.push({ id: `s${j}.0`, name: `s${j}`, type: s.value.type, mutable: true });
        return { localId: `s${j}.0`, name: `s${j}`, type: s.value.type };
      });
      const body: IrStmt[] = [
        {
          kind: "varDecl",
          localId: "out.0",
          init: {
            kind: "recordLit",
            fields: shape.fields.map((f) => ({ name: f.name, value: L.wrappedUndefined(f.type, loc)! })),
            type,
            loc,
          },
          loc,
        },
      ];
      srcs.forEach((s, j) => {
        const sRef = varRef(`s${j}.0`, s.value.type, loc);
        const kRef = varRef(`k${j}.0`, STRING, loc);
        const vRef = varRef(`v${j}.0`, s.iv, loc);
        locals.push(
          { id: `ks${j}.0`, name: `ks${j}`, type: ksT, mutable: false },
          { id: `i${j}.0`, name: `i${j}`, type: F64, mutable: true },
          { id: `k${j}.0`, name: `k${j}`, type: STRING, mutable: false },
          { id: `v${j}.0`, name: `v${j}`, type: s.iv, mutable: false },
        );
        // Per-key dispatch: if (k === "a") { write a } else if ... else drop.
        const dispatch = shape.fields.reduceRight<IrStmt[]>((rest, f) => {
          const write = (value: IrExpr): IrStmt => ({ kind: "recordSet", obj: outRef, shapeId: type.shapeId, field: f.name, value, loc });
          const c = conv(s.iv, f, vRef);
          const thenBody = "value" in c ? [write(c.value)] : c.stmts(write);
          return [{
            kind: "if",
            cond: { kind: "strEq", negated: false, left: kRef, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc },
            then: thenBody,
            else_: rest.length > 0 ? rest : null,
            loc,
          }];
        }, []);
        body.push(
          { kind: "varDecl", localId: `ks${j}.0`, init: { kind: "recordOvfKeys", obj: sRef, shapeId: s.shapeId, type: ksT, loc }, loc },
          {
            kind: "for",
            init: { kind: "varDecl", localId: `i${j}.0`, init: numLit(0, loc), loc },
            cond: { kind: "bin", op: "<", left: varRef(`i${j}.0`, F64, loc), right: { kind: "arrIntrinsic", method: "length", receiver: varRef(`ks${j}.0`, ksT, loc), args: [], type: F64, loc }, type: BOOL, loc },
            update: { kind: "assign", localId: `i${j}.0`, value: { kind: "bin", op: "+", left: varRef(`i${j}.0`, F64, loc), right: numLit(1, loc), type: F64, loc }, loc },
            body: [
              { kind: "varDecl", localId: `k${j}.0`, init: { kind: "arrayGet", arr: varRef(`ks${j}.0`, ksT, loc), index: varRef(`i${j}.0`, F64, loc), type: STRING, loc }, loc },
              { kind: "varDecl", localId: `v${j}.0`, init: { kind: "recordKeyGet", obj: sRef, shapeId: s.shapeId, key: kRef, overflowOnly: true, type: s.iv, loc }, loc },
              ...dispatch,
            ],
            loc,
          },
        );
      });
      body.push({ kind: "return", value: outRef, loc });
      L.liftedFns.push({
        name: helper,
        params,
        returnType: type,
        locals,
        body,
        loc,
      });
      // Registered only after a fence-free build: a conv() fence mid-build
      // must not leave a phantom helper behind for the next literal.
      L.widthHelpers.set(key, helper);
    }
    return { kind: "call", callee: helper, args: srcs.map((s) => s.value), type, loc };
  }

/** The value of a shorthand property (`{ x }`): the binding `x` refers to.
   * The property name's own symbol is the PROPERTY, so resolution goes
   * through getShorthandAssignmentValueSymbol. */
  export function lowerShorthandValue(L: Lowerer, prop: ts.ShorthandPropertyAssignment): IrExpr {
    // 7 types the shorthand's name as PropertyName; it is always an
    // Identifier (the grammar allows nothing else in shorthand position).
    const propName = prop.name as ts.Identifier;
    const loc = locOf(propName);
    const symbol = L.checker.getShorthandAssignmentValueSymbol(prop);
    if (symbol) {
      if (L.ctx.selfSymbol === symbol) {
        return { kind: "selfRef", type: L.ctx.selfType!, loc };
      }
      const local = L.resolveKey(symbol, propName);
      if (local) {
        return L.maybeNarrow({ kind: "varRef", localId: local.id, type: local.type, loc }, propName);
      }
      const resolved = symbol.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(symbol) : symbol;
      L.flushDeferred(resolved);
      const g = L.globalsBySymbol.get(resolved);
      if (g) {
        return L.maybeNarrow({ kind: "varRef", localId: g.id, type: g.type, loc }, propName);
      }
      const sig = L.fnSigsBySymbol.get(resolved);
      const decl = L.checker.declarationsOf(resolved)[0];
      if (
        sig && decl && ts.isFunctionDeclaration(decl) &&
        (ts.isSourceFile(decl.parent) || L.nsBlocks.get(decl.parent) === "flattened")
      ) {
        L.noteEdge(sig.name);
        const funcType: IrType = {
          kind: "func",
          params: sig.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
          ret: sig.returnType,
          ...(sig.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
        };
        L.requireExactArityValue(prop, propName, sig.params, funcType);
        return { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc };
      }
      if (L.genericFnsBySymbol.has(resolved)) {
        L.unsupported(
          "SC1090",
          prop,
          `generic functions as values (call '${propName.text}' directly)`,
        );
      }
    }
    L.rejectUnresolvedSymbol(
      symbol ? (symbol.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(symbol) : symbol) : null,
      propName.text,
      prop,
      `the reference to '${propName.text}' (a binding form with no lowering)`,
    );
  }

/** Rejects any `this` inside an object-literal method body — including in
   * nested arrows, which inherit the method's `this` (nested function
   * expressions reset it, but their bare `this` is already a tsc error
   * under noImplicitThis, so over-rejecting them here changes nothing). */
  export function rejectThisInObjectMethod(L: Lowerer, node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      L.unsupported("SC1090", node, "references to 'this' in object literal methods");
    }
    ts.forEachChild(node, (child) => L.rejectThisInObjectMethod(child));
  }

/** The accessor twin of rejectThisInObjectMethod: a get/set accessor body
   * referencing `this` (`get x() { return this._x }`). The accessor lowers
   * as a closure stored IN the record — passing the record as a receiver
   * would capture the value under construction (an RC cycle), and the
   * generic lexical-this walk would silently bind an ENCLOSING method's
   * `this`; the fence names the fix (capture a binding instead). */
  function rejectThisInObjectAccessor(L: Lowerer, node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      L.unsupported(
        "SC1090",
        node,
        "references to 'this' in object literal get/set accessors (the accessor lowers as a captured closure with no receiver — read a captured binding instead)",
      );
    }
    ts.forEachChild(node, (child) => rejectThisInObjectAccessor(L, child));
  }

/** `a[i]` reads. Only f64 indices into array receivers are modeled; JS
   * string-key element access (`a["length"]`) and string indexing (`s[0]`
   * typechecks against the lib's index signature; use .charAt) stay out. */
  export function lowerElementAccess(L: Lowerer, expr: ts.ElementAccessExpression): IrExpr {
    // `a?.[i]`: the guard lowers as an optional-chain step around the
    // plain element read below.
    if (expr.questionDotToken && !L.chainHandled.has(expr)) {
      return L.lowerOptionalChain(expr);
    }
    // `a?.b[i]` — the tail of a chain whose token sits deeper: the whole
    // tail short-circuits with the guard.
    if (!expr.questionDotToken && chainTailClaimed(L, expr)) {
      return L.lowerOptionalChain(expr);
    }
    // Enum accesses in element clothing — `E["A"]` forward reads and
    // `E[0]` reverse-mapping reads — fold to constants (lower-enums.ts),
    // claimed before any receiver-kind dispatch can see the enum object.
    {
      const en = lowerEnumAccess(L, expr);
      if (en) return en;
    }
    // Native Web handles use the same supported surface for bracket and dot
    // spellings. Fence a statically-known unsupported key before the generic
    // checked-dynamic element-read path can turn it into a runtime missing
    // member.
    L.fenceStaticAbortControllerMemberRead(expr);
    L.fenceStaticResponseMember(expr, "read");
    L.fenceStaticHeadersMember(expr, "read");
    L.fenceStaticReadableStreamMember(expr, "read");
    // `globalThis[<expr>]` — the dynamic global probe (the harness's
    // conditional-globals sweep): a compiled binary's globals are
    // compile-time bindings, not runtime properties, and none of the
    // probed web-platform objects exist here — the honest answer is
    // undefined for every dynamic name (SEMANTICS.md documents the
    // divergence: statically-known globals are not reachable this way;
    // the PROPERTY spelling answers the identity token instead — see
    // lowerPropertyAccess's globalThis rule).
    if (!expr.questionDotToken && stdlibGlobalNameOf(L, expr.expression) === "globalThis") {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
    }
    // `req.headers["x-name"]` — the computed twin of `req.headers.host`
    // (the server spoke owns both; the envGet precedent).
    {
      const header = L.lowerHttpHeadersElement(expr);
      if (header) return L.maybeNarrow(header, expr);
    }
    // `process.env[expr]` — the computed twin of `process.env.NAME`; both
    // lower to the ONE process.envGet intrinsic. The read narrows like any
    // union-typed expression when the checker narrowed this occurrence.
    if (L.isProcessEnv(expr.expression)) {
      const key = L.lowerExpr(expr.argumentExpression);
      if (key.type.kind !== "string") {
        L.unsupported(
          "SC1090",
          expr.argumentExpression,
          "indexing process.env with non-string keys",
        );
      }
      const get: IrExpr = {
        kind: "libCall",
        fn: "process.envGet",
        args: [key],
        type: L.envValueType(),
        loc: locOf(expr),
      };
      return L.maybeNarrow(get, expr);
    }
    // Expando function members in element clothing (`foo[strMem]`,
    // `foo[_private]` where foo is a module-level function/callable const
    // and the key folds or is a unique-symbol const): the member's module
    // global — the dotted read's twin (lower-expando.ts).
    {
      const ex = expandoMemberRead(L, expr);
      if (ex) return L.maybeNarrow(ex, expr);
    }
    // Symbol-keyed property READS (`this[kLimit]`): when the key is a
    // statically-resolvable unique-symbol const declared as a field of the
    // receiver's class (uniqueSymbolKeyOf — the countdown.js idiom), the
    // read IS an ordinary field read of the hidden slot. Every other
    // symbol key stays fenced: record shapes, runtime-identity keys
    // (symbol parameters, Symbol.for consts), and keys no class declares
    // — the layouts are compile-time field lists.
    if (L.mapTypeOf(L.typeOf(expr.argumentExpression))?.kind === "symbol") {
      const target = symbolFieldTarget(L, expr);
      if (target) return L.maybeNarrow(L.fieldGetExpr(target, locOf(expr), expr), expr);
      L.unsupported(
        "SC1090",
        expr,
        "symbol-keyed property access outside class fields keyed by a module-level `const k = Symbol('desc')` (static shapes have no symbol-keyed storage)",
      );
    }
    // A never-tainted JS receiver type (neverTaintedJsType — `cmd[1]` on
    // `const cmd = ['pwd', []]`, whose binding lowered checked-dynamic)
    // dispatches as unmapped so the dyn-receiver branch below reads
    // through the checked-dynamic tree instead of dynChecking into never's f64 residue.
    let receiverIr = neverTaintedJsType(L, expr.expression, L.typeOf(expr.expression))
      ? null
      : L.mapTypeOf(L.typeOf(expr.expression));
    // A readonly tuple union under Array.isArray is checker-typed as an
    // intersection with any[], whose structural mapping is not the tuple
    // shape. maybeNarrow on the receiver uses the runtime tag proof to
    // extract the one array-valued arm; dispatch element access from that
    // lowered representation, like the existing any[] array-method path.
    const checkerArray = L.checkerArrayValue(expr.expression);
    if (checkerArray) receiverIr = checkerArray.type;
    if (receiverIr?.kind === "jsval") {
      // Dispatch follows the RUNTIME world (383(d)): a checker-'any'
      // receiver whose value LOWERED checked-dynamic (`bag.list[0]` where
      // bag.list is a routed keyed read off a wrapped island value) takes
      // the dyn keyed read below — the routed JSVAL arm reads the real
      // engine element; a jsval-lowered receiver keeps the island read.
      const recv = L.lowerExpr(expr.expression);
      if (recv.type.kind !== "dyn") return islandElementRead(L, expr, recv);
      const rawKey = L.lowerExpr(expr.argumentExpression);
      const key: IrExpr | null =
        rawKey.type.kind === "string"
          ? rawKey
          : rawKey.type.kind === "f64"
            ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
            : null;
      if (key) {
        const opt = chainGuardedByQuestionDot(expr.expression);
        return L.maybeNarrow(
          { kind: "dynKeyGet", key, ...(opt ? { optional: true as const } : {}), value: recv, type: DYN, loc: locOf(expr) },
          expr,
        );
      }
    }
    // Typed-array element read `b[i]` — like arrayGet with a scalar
    // result; any invalid index traps (the array discipline; JS would
    // read undefined — divergence 4's policy).
    if (receiverIr?.kind === "bytes") {
      const recv = L.lowerExpr(expr.expression);
      // A typed-array .d.ts surface whose VALUE is an island handle
      // (`data()[0]` on a declared Uint8Array return — call results only
      // exit primitives eagerly): the engine element read, exiting at the
      // declared number type.
      if (recv.type.kind === "jsval") return islandElementRead(L, expr, recv);
      const index = L.lowerExpr(expr.argumentExpression);
      if (index.type.kind !== "f64") {
        L.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
      }
      return { kind: "bytesIntrinsic", method: "get", receiver: recv, args: [index], type: F64, loc: locOf(expr) };
    }
    // Tuple element read `t[0]`: a positional-field read of the tuple's
    // record shape — LITERAL indices only (the checker's per-index types
    // are what make the read honest; a dynamic index over a heterogeneous
    // shape has no single element type). Narrows like any field read.
    if (receiverIr?.kind === "record") {
      const shape = L.shapes.get(receiverIr.shapeId);
      if (shape?.tuple) {
        const obj = L.lowerExpr(expr.expression);
        // A tuple-typed .d.ts surface whose VALUE is an island handle
        // (`pair()[0]` on a declared `[number, string]` return — the
        // anonymous tuple type has no npm symbol, so the checker maps it
        // structurally while the call result stays an engine array): the
        // read rides engine ops, exiting at the declared per-index type
        // like the array path.
        if (obj.type.kind === "jsval") return islandElementRead(L, expr, obj);
        const idx = tupleLiteralIndex(expr.argumentExpression);
        if (idx === null) {
          L.unsupported(
            "SC1090",
            expr.argumentExpression,
            "tuple indexing with a non-literal index (tuples are fixed-shape — use t[0], t[1], ...)",
          );
        }
        const fieldType = shape.fields.find((f) => f.name === String(idx))?.type;
        if (fieldType === undefined) L.badType(expr, L.typeOf(expr)); // OOB smuggled past tsc
        const get: IrExpr = {
          kind: "recordGet",
          obj,
          shapeId: receiverIr.shapeId,
          field: String(idx),
          type: fieldType,
          loc: locOf(expr),
        };
        return L.maybeNarrow(get, expr);
      }
      if (shape && !shape.tuple) {
        // A record-typed .d.ts surface whose VALUE is an island handle
        // (`headers()["x-id"]` on a declared `Record<string, string>`
        // return — the stdlib alias maps structurally while the call
        // result stays an engine object): the read rides engine ops with
        // the declared-value exit, never a recordKeyGet over a jsval.
        const obj = L.lowerExpr(expr.expression);
        if (obj.type.kind === "jsval") return islandElementRead(L, expr, obj);
        return L.lowerRecordKeyRead(expr, receiverIr.shapeId, shape);
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
    if (receiverIr?.kind === "dyn" || receiverIr === null) {
      const obj = L.lowerExpr(expr.expression);
      if (obj.type.kind === "dyn") {
        const rawKey = L.lowerExpr(expr.argumentExpression);
        // Number, bool, and DYN keys stringify (ToPropertyKey) — the
        // dyn-keyed read `catchWarning[warning.name]` where the property
        // chain itself lowered dyn.
        const key: IrExpr | null =
          rawKey.type.kind === "string"
            ? rawKey
            : rawKey.type.kind === "f64" || rawKey.type.kind === "bool" || rawKey.type.kind === "dyn"
              ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
              : null;
        if (key) {
          const opt = chainGuardedByQuestionDot(expr.expression);
          return L.maybeNarrow(
            { kind: "dynKeyGet", key, ...(opt ? { optional: true as const } : {}), value: obj, type: DYN, loc: locOf(expr) },
            expr,
          );
        }
      }
      // A checker-`any` receiver that LOWERS to a static ARRAY
      // (`pm.split("@")[0]` — the dyn-receiver string machinery answers
      // string[]): the element read rides the ordinary array path on the
      // lowered value (invalid indices trap, divergence 4's policy).
      if (obj.type.kind === "array") {
        const index = L.lowerExpr(expr.argumentExpression);
        if (index.type.kind === "f64") {
          return L.maybeNarrow(
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
      const value = L.lowerExpr(expr.expression);
      if (value.type.kind === "union") {
        const key = L.lowerExpr(expr.argumentExpression);
        if (key.type.kind === "string") {
          const lit = ts.isStringLiteral(expr.argumentExpression)
            ? expr.argumentExpression.text
            : null;
          const keyed = lowerUnionKeyedRead(L, expr, value.type.unionId, value, key, lit);
          if (keyed) return L.maybeNarrow(keyed, expr);
        }
        // `u?.split(":")[0]` — a NUMBER index over an undefined-armed
        // array union: the array arm answers its element (invalid indices
        // trap — divergence 4's policy), unit arms answer undefined (the
        // chain's short-circuit value). Every non-unit arm must be the
        // same array type.
        if (key.type.kind === "f64") {
          const def = L.unions.get(value.type.unionId);
          const arrArms = def?.arms.filter((a) => a.kind === "array") ?? [];
          if (
            def &&
            arrArms.length > 0 &&
            def.arms.every((a) => a.kind === "array" || isUnitType(a)) &&
            arrArms.every((a) => typeEquals(a, arrArms[0]!))
          ) {
            const elem = (arrArms[0] as IrType & { kind: "array" }).elem;
            const hasUnit = def.arms.some(isUnitType);
            const t = !hasUnit
              ? elem
              : elem.kind === "union"
                ? L.withUndefinedArmOf(elem)
                : L.withUndefinedArm(elem);
            if (t) {
              return L.maybeNarrow(
                { kind: "unionKeyGet", unionId: value.type.unionId, key, value, type: t, loc: locOf(expr) },
                expr,
              );
            }
          }
        }
      }
    }
    if (receiverIr?.kind !== "array") {
      if (receiverIr?.kind === "string") {
        // `s[i]` with a number index reads a UTF-16 code unit — charAt's
        // exact job (the UTF-16-exact runtime). Without
        // noUncheckedIndexedAccess the checker types the read `string`,
        // and charAt's "" is the only string-typed answer for an
        // out-of-range or fractional index where JS reads `undefined` —
        // SEMANTICS.md documents the divergence; in-range integer reads
        // (the loop pattern) are JS-exact. Under noUncheckedIndexedAccess
        // the read types `string | undefined`, which charAt cannot honor —
        // fenced.
        const index = L.lowerExpr(expr.argumentExpression);
        if (index.type.kind === "f64" && L.mapTypeOf(L.typeOf(expr))?.kind === "string") {
          const recv = L.lowerExpr(expr.expression);
          return { kind: "strIntrinsic", method: "charAt", receiver: recv, args: [index], type: STRING, loc: locOf(expr) };
        }
        L.unsupported(
          "SC1090",
          expr,
          "string indexing with this index/result shape (a number index typed 'string' lowers to charAt; " +
            "use .charAt(i) under noUncheckedIndexedAccess)",
        );
      }
      L.unsupported("SC1090", expr, "element access on non-array values");
    }
    let arr = L.lowerExpr(expr.expression);
    // The checker sees an array but the VALUE is an island handle (an
    // array-typed .d.ts surface: `parts()[0]` on a declared `string[]`
    // return, `issue.path[0]` on a declared member — arrays never exit
    // eagerly, so the call/member read stays jsval): the read rides
    // engine ops with the declared-element exit, never a static arrayGet
    // over a jsval (the validator ICE).
    if (arr.type.kind === "jsval") return islandElementRead(L, expr, arr);
    // The checker sees an array but the VALUE lowered checked-dynamic (a
    // jsdoc-typed default export from a .js module — signature 14): the
    // read rides the dynCheck boundary when the array shape is one the checked-dynamic tree
    // can validate, and fences by name when it is not — an arrayGet over a
    // dyn receiver is never emitted (the validator ICE).
    if (arr.type.kind === "dyn") {
      if (isJsonSafeType(receiverIr, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
        arr = { kind: "dynCheck", value: arr, type: receiverIr, loc: locOf(expr) };
      } else {
        L.unsupported(
          "SC1090",
          expr,
          `element access on checked-dynamic values with '${L.fmt(receiverIr)}' elements`,
        );
      }
    }
    const index = L.lowerExpr(expr.argumentExpression);
    if (index.type.kind !== "f64") {
      L.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
    }
    // The LOWERED receiver's element type wins over the checker's when
    // both are arrays: a spoke result can be more precise than the
    // declared surface (emitter.listeners() answers the event's tuple
    // signature where the .d.ts says Function[], which would flatten the
    // element to a zero-parameter closure).
    const elemT = arr.type.kind === "array" ? arr.type.elem : receiverIr.elem;
    // OOB-SAFE reads over fresh/probe array results. These expressions are
    // commonly used to ask for a first/last match (`filter(...).sort(...)[0]`,
    // `slice(-1)[0]`); an empty result is ordinary undefined, not a bounds
    // failure. Downstream lowering keeps the explicit optional union, so an
    // unchecked consumer still cannot place it into a plain element slot.
    if (arr.type.kind === "array" && isFreshArrayProbe(expr.expression)) {
      const safe = lowerSafeIndexRead(L, arr as IrExpr & { type: { kind: "array" } }, index, locOf(expr));
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
      const safe = lowerNpmStaticSafeIndexRead(L, arr as IrExpr & { type: { kind: "array" } }, index, locOf(expr));
      if (safe) return safe;
    }
    // A union-element read narrows like an identifier when the checker has
    // narrowed THIS occurrence (`if (a[0] !== undefined) use(a[0])` — tsc
    // narrows literal-index element accesses).
    return L.maybeNarrow(
      { kind: "arrayGet", arr, index, type: elemT, loc: locOf(expr) },
      expr,
    );
  }

  function isFreshArrayProbe(node: ts.Expression): boolean {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      (current.expression.name.text === "filter" ||
        current.expression.name.text === "slice" ||
        current.expression.name.text === "sort")
    );
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
  function islandElementRead(L: Lowerer, expr: ts.ElementAccessExpression, obj: IrExpr): IrExpr {
    const loc = locOf(expr);
    const key = L.jsvalIn(L.lowerExpr(expr.argumentExpression), expr.argumentExpression);
    const read: IrExpr = { kind: "jsOp", op: "getIdx", args: [obj, key], type: JSVAL, loc };
    if (!expr.questionDotToken) {
      const declared = L.mapTypeOf(L.typeOf(expr));
      if (
        declared &&
        (declared.kind === "f64" || declared.kind === "bool" || declared.kind === "string" ||
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
    L: Lowerer,
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
    const litKey = recordKeyLiteralText(keyNode) ?? recordKeyTypeLiteralText(L, keyNode);
    // The receiver lowers FIRST (both branches below read it, and JS
    // evaluates the receiver before the key).
    const obj = L.lowerExpr(expr.expression);
    // A record-mapped CHECKER type over a VALUE living in the checked-dynamic tree (a JS
    // file-scope object-literal global): the checked-dynamic keyed read —
    // dynKeyGet against the runtime keys (a missing key answers the checked-dynamic tree
    // undefined, exactly JS); consumers validate (dynCheck) where a
    // static type is required, the member-read discipline.
    if (obj.type.kind === "dyn") {
      let dk =
        litKey !== null
          ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
          : L.lowerExpr(keyNode);
      // Number AND checked-dynamic keys ride the JS-exact formatter —
      // property keys ARE strings (o[k] is o[String(k)] in JS), and a dyn
      // key (agent.sockets[agent.getName(...)]) stringifies the same way.
      if (dk.type.kind === "f64" || dk.type.kind === "dyn") dk = L.ensureString(dk, keyNode);
      if (dk.type.kind !== "string") {
        L.unsupported("SC1090", keyNode, "indexing records with non-string or non-number keys");
      }
      const read: IrExpr = { kind: "dynKeyGet", key: dk, value: obj, type: DYN, loc };
      // Absence probes must keep the checked-dynamic undefined produced by
      // a missing key. The ordinary read narrows to the checker's declared
      // index value (and therefore validates it); ===/!==, ||, and ?? need
      // to observe the missing value instead of throwing during that check.
      return includeUndefined ? read : L.maybeNarrow(read, expr);
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
        return L.maybeNarrow(get, expr);
      }
    }
    let key =
      litKey !== null
        ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
        : L.lowerExpr(keyNode);
    // Runtime NUMBER keys ride the JS-exact formatter (o[n] is o[String(n)]
    // in JS — the number-keyed-signature access path).
    if (key.type.kind === "f64") key = L.ensureString(key, keyNode);
    if (key.type.kind !== "string") {
      L.unsupported("SC1090", keyNode, "indexing records with non-string or non-number keys");
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
      if (includeUndefined || L.program.getCompilerOptions().noUncheckedIndexedAccess) {
        declared = L.withUndefinedArmOf(declared);
        if (!declared) L.badType(expr, L.typeOf(expr));
      }
    } else if (
      shape.fields.length > 0 &&
      shape.fields.every((f) => typeEquals(f.type, shape.fields[0]!.type))
    ) {
      declared = shape.fields[0]!.type;
    }
    if (!declared) {
      L.unsupported(
        "SC1090",
        expr,
        `dynamic keyed reads of '${L.fmt({ kind: "record", shapeId })}' (the declared fields have no one common type)`,
      );
    }
    // A LITERAL key naming no declared field can only hit the overflow:
    // the declared-field surfacing constraint doesn't apply.
    const overflowOnly = litKey !== null && !!shape.indexValue;
    if (!recordKeyResultOk(L, overflowOnly ? { ...shape, fields: [] } : shape, declared)) {
      L.unsupported(
        "SC1090",
        expr,
        `dynamic keyed reads of '${L.fmt({ kind: "record", shapeId })}' as '${L.fmt(declared)}' (every declared field must be readable at that type)`,
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
    return includeUndefined ? read : L.maybeNarrow(read, expr);
  }

  /** A keyed read used only to observe absence (`if (map[k])`, or the left
   * side of `||`/`??`). JavaScript answers undefined for missing record keys
   * and array indices even when noUncheckedIndexedAccess is disabled. Keep
   * that value in an explicit union until the surrounding guard/default has
   * consumed it; ordinary unchecked reads retain the typed trap. Assertions
   * around the read are erased here because this context handles the missing
   * arm instead of consuming it as the asserted type. */
  export function lowerAbsenceProbe(L: Lowerer, node: ts.Expression): IrExpr | null {
    let expr = node;
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) {
      expr = expr.expression;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const target = L.fieldTarget(expr);
      if (target?.container !== "recordOvf") return null;
      // A JS file-scope object-literal global is record-shaped to the
      // checker but stored in the checked-dynamic tree to preserve object
      // identity. Reuse the normal dyn-aware field read; constructing a
      // recordKeyGet here would give the validator a dyn receiver.
      if (target.obj.type.kind === "dyn") {
        return L.fieldGetExpr(target, locOf(expr), expr);
      }
      if (
        target.fieldType.kind === "union" &&
        L.armTag(target.fieldType.unionId, UNDEFINED_T) >= 0
      ) {
        return null;
      }
      const type = L.withUndefinedArmOf(target.fieldType);
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

    const header = L.lowerHttpHeadersElement(expr);
    if (header) return header;

    const receiverT = L.mapTypeOf(L.typeOf(expr.expression));
    if (receiverT?.kind === "record") {
      const shape = L.shapes.get(receiverT.shapeId);
      if (shape && !shape.tuple && shape.indexValue && shape.indexValue.kind !== "dyn") {
        return L.lowerRecordKeyRead(expr, receiverT.shapeId, shape, true);
      }
      return null;
    }
    if (receiverT?.kind !== "array") return null;
    const arr = L.lowerExpr(expr.expression);
    if (arr.type.kind !== "array") return null;
    const index = L.lowerExpr(expr.argumentExpression);
    if (index.type.kind !== "f64") return null;
    return lowerSafeIndexRead(L, arr as IrExpr & { type: { kind: "array" } }, index, locOf(expr));
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
  function recordKeyTypeLiteralText(L: Lowerer, node: ts.Expression): string | null {
    if (!ts.isIdentifier(node)) return null;
    let t: ts.Type = L.typeOf(node);
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const bound = L.typeParamTsResolver(t);
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
  function recordKeyResultOk(L: Lowerer, shape: IrRecordShape, type: IrType): boolean {
    const surfaces = (t: IrType): boolean =>
      typeEquals(t, type) ||
      (type.kind === "union" && L.armTag(type.unionId, t) >= 0) ||
      (type.kind === "dyn" && L.dynConvertible(t));
    if (!shape.fields.every((f) => surfaces(f.type))) return false;
    if (shape.indexValue) {
      if (type.kind === "dyn") return shape.indexValue.kind === "dyn";
      if (!surfaces(shape.indexValue)) return false;
    }
    return true;
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

/** `a[i] = v` in statement position → arraySet (element writes, like local
   * assignment, produce no value in our subset). */
  export function lowerElementWrite(L: Lowerer, expr: ts.BinaryExpression): IrStmt {
    const target = expr.left as ts.ElementAccessExpression;
    // `process.env[key] = v` — the computed twin of the dotted env write:
    // setenv(3), string keys and string values only.
    if (L.isProcessEnv(target.expression) && !target.questionDotToken) {
      const loc = locOf(expr);
      const key = L.lowerExpr(target.argumentExpression);
      if (key.type.kind !== "string") {
        L.unsupported("SC1090", target.argumentExpression, "indexing process.env with non-string keys");
      }
      const value = L.lowerExpr(expr.right);
      if (value.type.kind !== "string") {
        L.unsupported(
          "SC1090",
          expr.right,
          `assigning '${L.fmt(value.type)}' values to process.env (env values are strings — convert first: \`\${v}\`)`,
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
    if (L.mapTypeOf(L.typeOf(target.argumentExpression))?.kind === "symbol") {
      const fieldT = symbolFieldTarget(L, target);
      if (fieldT) {
        const value = L.lowerExprExpecting(expr.right, fieldT.fieldType);
        return L.fieldSetStmt(fieldT, value, locOf(expr), target);
      }
      L.unsupported(
        "SC1090",
        target,
        "symbol-keyed property writes outside class fields keyed by a module-level `const k = Symbol('desc')` (static shapes have no symbol-keyed storage)",
      );
    }
    const receiverIr = L.mapTypeOf(L.typeOf(target.expression));
    if (receiverIr?.kind === "jsval") {
      const obj = L.lowerExpr(target.expression);
      // Dispatch follows the RUNTIME world (383(d)): a checker-'any'
      // receiver whose value LOWERED checked-dynamic takes the dyn keyed
      // write — the routed JSVAL arm lands it on the real engine object.
      if (obj.type.kind === "dyn") {
        const loc = locOf(expr);
        const rawKey = L.lowerExpr(target.argumentExpression);
        const key: IrExpr =
          rawKey.type.kind === "f64" || rawKey.type.kind === "bool" || rawKey.type.kind === "dyn"
            ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
            : rawKey;
        if (key.type.kind !== "string") {
          L.unsupported("SC1090", target.argumentExpression, `'${L.fmt(key.type)}'-typed keys in keyed writes through 'unknown' values`);
        }
        const value = L.coerceToExpected(L.lowerExpr(expr.right), DYN);
        if (value.type.kind !== "dyn") {
          L.unsupported("SC1100", expr.right, `assigning '${L.fmt(value.type)}' values through 'unknown' receivers`);
        }
        return {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
          loc,
        };
      }
      const key = L.jsvalIn(L.lowerExpr(target.argumentExpression), target.argumentExpression);
      const value = L.jsvalIn(L.lowerExpr(expr.right), expr.right);
      const loc = locOf(expr);
      return { kind: "exprStmt", expr: { kind: "jsOp", op: "setIdx", args: [obj, key, value], type: VOID, loc }, loc };
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
      const obj = L.lowerExpr(target.expression);
      if (obj.type.kind === "dyn") {
        const loc = locOf(expr);
        let key = L.lowerExpr(target.argumentExpression);
        if (key.type.kind === "f64") key = L.ensureString(key, target.argumentExpression);
        if (key.type.kind !== "string") {
          L.unsupported("SC1090", target.argumentExpression, "indexing with non-string or non-number keys");
        }
        const value = L.coerceToExpected(L.lowerExpr(expr.right), DYN);
        if (value.type.kind !== "dyn") {
          L.unsupported(
            "SC1101",
            expr.right,
            `storing '${L.fmt(value.type)}' values in a checked-dynamic array (the value cannot convert into the checked-dynamic tree)`,
          );
        }
        return { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc }, loc };
      }
    }
    // Typed-array element write `b[i] = v` — bytesSet: the value is an f64
    // the runtime coerces JS-exactly; invalid indices trap (no appends —
    // typed arrays are fixed-length; JS would ignore the write).
    if (receiverIr?.kind === "bytes") {
      const recv = L.lowerExpr(target.expression);
      // The write twin: a typed-array .d.ts surface whose VALUE is a
      // handle takes the engine keyed write.
      if (recv.type.kind === "jsval") {
        const key = L.jsvalIn(L.lowerExpr(target.argumentExpression), target.argumentExpression);
        const value = L.jsvalIn(L.lowerExpr(expr.right), expr.right);
        const loc = locOf(expr);
        return { kind: "exprStmt", expr: { kind: "jsOp", op: "setIdx", args: [recv, key, value], type: VOID, loc }, loc };
      }
      const index = L.lowerExpr(target.argumentExpression);
      if (index.type.kind !== "f64") {
        L.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
      }
      const value = L.lowerExprExpecting(expr.right, F64);
      return { kind: "bytesSet", arr: recv, index, value, loc: locOf(expr) };
    }
    // Tuple element write `t[0] = v`: a positional-field write (recordSet)
    // — literal indices only, like the read.
    if (receiverIr?.kind === "record") {
      const shape = L.shapes.get(receiverIr.shapeId);
      // A record/tuple-typed .d.ts surface whose VALUE is an island
      // handle: the engine keyed write (the read dispatch's twin), never
      // a recordSet/recordKeySet over a jsval.
      if (shape) {
        const obj = L.lowerExpr(target.expression);
        if (obj.type.kind === "jsval") {
          const key = L.jsvalIn(L.lowerExpr(target.argumentExpression), target.argumentExpression);
          const value = L.jsvalIn(L.lowerExpr(expr.right), expr.right);
          const loc = locOf(expr);
          return { kind: "exprStmt", expr: { kind: "jsOp", op: "setIdx", args: [obj, key, value], type: VOID, loc }, loc };
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
              : L.lowerExpr(target.argumentExpression);
          if (key.type.kind === "f64") key = L.ensureString(key, target.argumentExpression);
          if (key.type.kind !== "string") {
            L.unsupported("SC1090", target.argumentExpression, "indexing records with non-string or non-number keys");
          }
          const value = L.coerceToExpected(L.lowerExpr(expr.right), DYN);
          if (value.type.kind !== "dyn") {
            L.unsupported(
              "SC1101",
              expr.right,
              `storing '${L.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
            );
          }
          return { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc }, loc };
        }
      }
      if (shape?.tuple) {
        const idx = tupleLiteralIndex(target.argumentExpression);
        if (idx === null) {
          L.unsupported(
            "SC1090",
            target.argumentExpression,
            "tuple indexing with a non-literal index (tuples are fixed-shape — use t[0], t[1], ...)",
          );
        }
        const fieldType = shape.fields.find((f) => f.name === String(idx))?.type;
        if (fieldType === undefined) L.badType(target, L.typeOf(target));
        const obj = L.lowerExpr(target.expression);
        const value = L.lowerExprExpecting(expr.right, fieldType);
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
        const litKey = recordKeyLiteralText(target.argumentExpression) ??
          recordKeyTypeLiteralText(L, target.argumentExpression);
        if (litKey !== null) {
          const field = shape.fields.find((f) => f.name === litKey);
          if (field) {
            const obj = L.lowerExpr(target.expression);
            const value = L.lowerExprExpecting(expr.right, field.type);
            return { kind: "recordSet", obj, shapeId: receiverIr.shapeId, field: litKey, value, loc: locOf(expr) };
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
            L.unsupported(
              "SC1090",
              target,
              "dynamic keyed writes to records without an index signature (declared fields of ONE shared type dispatch by key — spell the field name otherwise)",
            );
          }
          const obj = L.lowerExpr(target.expression);
          let key: IrExpr =
            litKey !== null
              ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
              : L.lowerExpr(target.argumentExpression);
          // Runtime number/boolean/dyn keys stringify — ToPropertyKey,
          // exactly the index-signature path's rule.
          if (key.type.kind === "f64") key = L.ensureString(key, target.argumentExpression);
          if (key.type.kind === "bool" || key.type.kind === "dyn") {
            key = { kind: "toString", operand: key, type: STRING, loc: locOf(target.argumentExpression) };
          }
          if (key.type.kind !== "string") {
            L.unsupported("SC1090", target.argumentExpression, "indexing records with non-string or non-number keys");
          }
          const value = L.coerceInto(expr.right, L.lowerExpr(expr.right), common);
          if (!typeEquals(value.type, common)) L.badType(expr.right, L.typeOf(expr.right));
          return { kind: "recordKeySet", obj, shapeId: receiverIr.shapeId, key, value, loc: locOf(expr) };
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
            ? shape.fields.every((f) => L.dynConvertible(f.type))
            : shape.fields.every((f) => typeEquals(f.type, shape.indexValue!)));
        if (!writable) {
          L.unsupported(
            "SC1090",
            target,
            `dynamic keyed writes to '${L.fmt(receiverIr)}' (a declared field's type cannot take the index signature's value at runtime)`,
          );
        }
        const obj = L.lowerExpr(target.expression);
        let key =
          litKey !== null
            ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) } satisfies IrExpr)
            : L.lowerExpr(target.argumentExpression);
        // Runtime NUMBER keys canonicalize through the JS-exact formatter
        // (o[n] = v writes o[String(n)] — the number-keyed-signature path).
        if (key.type.kind === "f64") key = L.ensureString(key, target.argumentExpression);
        if (key.type.kind !== "string") {
          L.unsupported("SC1090", target.argumentExpression, "indexing records with non-string or non-number keys");
        }
        const value = L.intoIndexValueSlot(L.lowerExpr(expr.right), shape.indexValue, expr.right);
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
    if (receiverIr?.kind === "dyn" || receiverIr === null) {
      const obj = receiverIr !== null ? L.lowerExpr(target.expression) : probeLower(L, target.expression);
      if (obj !== null && obj.type.kind === "dyn") {
        const loc = locOf(expr);
        const litKey = recordKeyLiteralText(target.argumentExpression);
        let key: IrExpr =
          litKey !== null
            ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
            : L.lowerExpr(target.argumentExpression);
        if (key.type.kind === "f64") key = L.ensureString(key, target.argumentExpression);
        if (key.type.kind === "bool" || key.type.kind === "dyn") {
          key = { kind: "toString", operand: key, type: STRING, loc: locOf(target.argumentExpression) };
        }
        if (key.type.kind !== "string") {
          L.unsupported("SC1090", target.argumentExpression, "indexing checked-dynamic values with non-string or non-number keys");
        }
        const value = L.coerceToExpected(L.lowerExpr(expr.right), DYN);
        if (value.type.kind !== "dyn") {
          L.unsupported(
            "SC1101",
            expr.right,
            `storing '${L.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
          );
        }
        return { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc }, loc };
      }
    }
    if (receiverIr?.kind !== "array") {
      L.unsupported("SC1090", target, "assignment to non-array elements");
    }
    const arr = L.lowerExpr(target.expression);
    // The write twin of the island element read: an array-typed .d.ts
    // surface whose VALUE is a handle takes the engine keyed write, never
    // a static arraySet over a jsval.
    if (arr.type.kind === "jsval") {
      const key = L.jsvalIn(L.lowerExpr(target.argumentExpression), target.argumentExpression);
      const value = L.jsvalIn(L.lowerExpr(expr.right), expr.right);
      const loc = locOf(expr);
      return { kind: "exprStmt", expr: { kind: "jsOp", op: "setIdx", args: [arr, key, value], type: VOID, loc }, loc };
    }
    const index = L.lowerExpr(target.argumentExpression);
    if (index.type.kind !== "f64") {
      L.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
    }
    // The value flows into the element slot like an assignment: union
    // elements wrap plain arm values.
    const value = L.lowerExprExpecting(expr.right, receiverIr.elem);
    if (!typeEquals(value.type, receiverIr.elem)) {
      L.badType(expr.right, L.typeOf(expr.right));
    }
    return { kind: "arraySet", arr, index, value, loc: locOf(expr) };
  }

export function ensureString(L: Lowerer, e: IrExpr, node: ts.Node): IrExpr {
    if (e.type.kind === "string") return e;
    if (e.type.kind === "dyn") {
      // String(u) / `${u}`: a runtime dispatch over the dyn kind — Node's
      // String() exactly (undefined/null texts, JS number formatting,
      // strings verbatim, arrays via join, objects as "[object Object]").
      return { kind: "toString", operand: e, type: STRING, loc: e.loc };
    }
    if (e.type.kind === "jsval") {
      // String(v) in the engine — JS-exact (and Node-exact in templates).
      return { kind: "jsOp", op: "toStr", args: [e], type: STRING, loc: e.loc };
    }
    if (e.type.kind === "object") {
      // String(err) / `${err}` over the Error hierarchy: Error.prototype
      // .toString — the ONE runtime implementation (overriding it is
      // fenced), "name: message" with the empty-side elisions, exactly
      // Node's String(err), which carries no stack either.
      for (let c = L.classes.get(e.type.className) ?? null; c; c = c.base) {
        if (c.builtinError) {
          return { kind: "libCall", fn: "error.toString", args: [L.upcastTo(e, "%Error")], type: STRING, loc: e.loc };
        }
      }
    }
    if (e.type.kind === "union") {
      // `${u}` — the arm's ToString via a per-union interned helper
      // (sc_us_*), Node-exact per arm kind: unit arms are the known texts
      // "undefined"/"null", string arms pass through, f64/bool arms use the
      // JS-exact formatters. Ref arms (records, arrays, ...) stay fenced:
      // JS would print "[object Object]" and friends — narrow first.
      const def = L.unions.get(e.type.unionId);
      const stringable = def?.arms.every(
        (a) =>
          a.kind === "undefinedT" || a.kind === "nullT" ||
          a.kind === "string" || a.kind === "f64" || a.kind === "bool",
      );
      if (stringable) {
        return { kind: "toString", operand: e, type: STRING, loc: e.loc };
      }
      L.unsupported(
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
      L.unsupported(
        "SC1090",
        node,
        "string conversions of symbol values (template literals throw in JS — call .toString() explicitly)",
      );
    }
    if (isUnitType(e.type)) {
      // `${undefined}` / "" + null: Node prints "undefined"/"null", but
      // these only arise spelled literally — reject rather than special-case.
      L.unsupported(
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
        (L.unions
          .get(elem.unionId)
          ?.arms.every(
            (a) => a.kind === "f64" || a.kind === "string" || a.kind === "bool" || isUnitType(a),
          ) ??
          false);
      if (elem.kind === "f64" || elem.kind === "string" || elem.kind === "bool" || joinableUnion) {
        const sep: IrExpr = { kind: "strLit", value: ",", type: STRING, loc: e.loc };
        return { kind: "arrIntrinsic", method: "join", receiver: e, args: [sep], type: STRING, loc: e.loc };
      }
    }
    if (e.type.kind === "record") {
      // `${obj}` / String(obj): a plain data record has no toString of its
      // own (a func-typed `toString` FIELD would shadow the prototype's —
      // JS would call it, so that shape keeps the fence), and a TUPLE
      // prints its elements like an array (not lowered — fenced) — every
      // other record is Object.prototype.toString's constant.
      const shape = L.shapes.get(e.type.shapeId);
      if (shape && !shape.tuple && !shape.fields.some((f) => f.name === "toString")) {
        return { kind: "toString", operand: e, type: STRING, loc: e.loc };
      }
    }
    if (e.type.kind !== "f64" && e.type.kind !== "bool") L.badType(node, L.typeOf(node));
    return { kind: "toString", operand: e, type: STRING, loc: e.loc };
  }

/** `new String(x)` (stdlib provenance, ≤1 argument) in a ToString
   * position: the wrapper's only distinguishers are typeof and identity —
   * neither is observable where the value immediately stringifies — so the
   * span lowers as the argument's own ToString (`new String()` is "").
   * Every other position keeps the wrapper-object constructor fence. */
  function stringWrapperToString(L: Lowerer, node: ts.Expression): IrExpr | null {
    let e = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression)) return null;
    const symbol = L.resolveValueSymbol(e.expression);
    if (symbol?.name !== "String" || !L.isStdlibSymbol(symbol)) return null;
    const args = e.arguments ?? [];
    if (args.length > 1 || args.some(ts.isSpreadElement)) return null;
    if (args.length === 0) return { kind: "strLit", value: "", type: STRING, loc: locOf(e) };
    return L.caughtToString(args[0]!) ?? L.ensureString(L.lowerExpr(args[0]!), args[0]!);
  }

export function lowerTemplate(L: Lowerer, expr: ts.TemplateExpression): IrExpr {
    const loc = locOf(expr);
    const pieces: IrExpr[] = [];
    if (expr.head.text !== "") {
      pieces.push({ kind: "strLit", value: expr.head.text, type: STRING, loc });
    }
    for (const span of expr.templateSpans) {
      pieces.push(
        stringWrapperToString(L, span.expression) ??
          L.caughtToString(span.expression) ??
          L.ensureString(L.lowerExpr(span.expression), span.expression),
      );
      if (span.literal.text !== "") {
        pieces.push({ kind: "strLit", value: span.literal.text, type: STRING, loc: locOf(span.literal) });
      }
    }
    if (pieces.length === 0) return { kind: "strLit", value: "", type: STRING, loc };
    return pieces.reduce((acc, p) => ({ kind: "strConcat", left: acc, right: p, type: STRING, loc }));
  }

/** `x as T`. Non-dyn inner values keep today's pure-erasure semantics.
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
  export function lowerAsExpression(L: Lowerer, expr: ts.AsExpression | ts.TypeAssertion): IrExpr {
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
      return { kind: "arrayLit", elems: [], type: arrayOf(unitOnlyUnion(L.unions)), loc: locOf(expr) };
    }
    // `e as C` on a CATCH BINDING (`(err as Error).message`): the checked
    // extraction — an instanceof match extracts the payload, anything else
    // throws the catchable TypeError (dynCheck's trust-but-verify stance,
    // extended to exception payloads). Intercepts BEFORE lowerExpr — the
    // raw read would hit caughtRead's narrowness fence.
    const caughtLocal = L.caughtLocalOf(expr.expression);
    if (caughtLocal) {
      const loc = locOf(expr);
      const targetTs = L.checker.getTypeFromTypeNode(expr.type);
      const target = L.mapTypeOf(targetTs);
      if (target?.kind === "object") {
        const info = L.classes.get(target.className);
        if (info && L.inHierarchy(info)) {
          return {
            kind: "caughtCheck",
            value: { kind: "varRef", localId: caughtLocal.id, type: CAUGHT, loc },
            className: target.className,
            type: target,
            loc,
          };
        }
      }
      // Narrowed reads (`err instanceof Error` proven) still pass below;
      // other targets keep the narrowness fence with the checked-cast fix.
      // In a JS FILE the AsExpression is tsgo's spelling of a JSDoc cast
      // (`/** @type {T} */ (e)` — JS has no `as`); 5.9.3 parsed that as a
      // plain parenthesized read, which lowered caught→dyn and met the
      // target through the ordinary checked-cast coercion — so the dyn
      // bridge stays open here exactly for that shape.
      const narrowed = L.mapTypeOf(L.typeOf(expr.expression));
      const bridged =
        narrowed &&
        (narrowed.kind === "f64" || narrowed.kind === "bool" || narrowed.kind === "string" ||
          narrowed.kind === "object" ||
          (narrowed.kind === "dyn" && isJsSourceFile(expr.getSourceFile())));
      if (!bridged) L.unsupported("SC1063", expr);
    }
    const inner = L.lowerExpr(expr.expression);
    const use = runtimeOptionalUseOf(expr);
    if (inner.type.kind === "union" && runtimeOptionalAssertionErases(L, expr, inner, use)) return inner;
    if (inner.type.kind !== "dyn" && inner.type.kind !== "jsval") {
      // A STATIC value cast `as any` is the explicit island entrance.
      const targetTs0 = L.checker.getTypeFromTypeNode(expr.type);
      if (targetTs0.flags & ts.TypeFlags.Any && L.dynamic) {
        return L.jsvalIn(inner, expr.expression);
      }
      // `u as Arm` on a UNION value is `u!`'s spelling with a named arm
      // (`req.headers[h] as string`): the CHECKED single-arm extraction —
      // the asserted arm's payload comes out, any other arm throws the
      // catchable TypeError (divergence 38's lying-assertion stance; an
      // erasure would just move the failure to the next typed slot as an
      // opaque union-mismatch fence). Sub-union targets and same-type
      // casts keep the historic erasure.
      if (inner.type.kind === "union") {
        const target = L.mapTypeOf(targetTs0);
        if (target && target.kind !== "union" && !typeEquals(target, inner.type)) {
          const helper = L.narrowedArmHelper(inner.type.unionId, target, locOf(expr));
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
      const targetTs = L.checker.getTypeFromTypeNode(expr.type);
      if (targetTs.flags & ts.TypeFlags.Any) return inner;
      const target = L.mapTypeOf(targetTs);
      if (!target) L.badType(expr.type, targetTs);
      if (!L.boundarySafe(target)) {
        L.unsupported(
          "SC1090",
          expr,
          `a checked cast of 'any' to '${L.fmt(target)}' ` +
            `(an 'any' value can only be validated against JSON-representable types: ` +
            `number, string, boolean, records, arrays, and unions of those)`,
        );
      }
      return { kind: "jsExit", value: inner, type: target, loc: locOf(expr) };
    }
    const targetTs = L.checker.getTypeFromTypeNode(expr.type);
    const target = L.mapTypeOf(targetTs);
    if (!target) L.badType(expr.type, targetTs);
    if (target.kind === "dyn") return inner; // `as unknown`: erasure
    if (target.kind === "void" || !L.jsonSafe(target)) {
      // Bare undefined-armed targets pass when every OTHER arm is
      // JSON-safe: the checked-dynamic tree holds a first-class undefined value now
      // (index-signature overflow reads produce it for missing keys), and
      // the undefined arm matches exactly it — `p[key] as string |
      // undefined` is the missing-key idiom. Parsed JSON still never
      // contains undefined, so casts over parse results keep failing on
      // non-string values with the usual path-annotated TypeError.
      if (target.kind === "union" && L.dynConvertible(target)) {
        return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
      }
      // Uint8Array targets: the checked-dynamic tree carries a bytes kind now (converted
      // stdin chunks) — the extraction validates the kind and copies out.
      if (target.kind === "bytes" && target.elem === "u8") {
        return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
      }
      // ADAPTABLE function targets (`u as (x: number) => number` — the
      // checked-dynamic function boundary): kind check, then exact unwrap
      // or the per-target adapter shim. Non-adaptable signatures keep the
      // fence below.
      if (
        target.kind === "func" &&
        canAdaptDynFuncTo(target, (id) => L.shapes.get(id), (id) => L.unions.get(id))
      ) {
        return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
      }
      // Runtime HANDLE targets (`u as IncomingMessage` — a boxed handle
      // coming back out of an untyped wrapper): a tag-checked reference
      // unwrap, identity preserved (DYN_HANDLE_KINDS).
      if (DYN_HANDLE_KINDS.has(target.kind)) {
        return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
      }
      // An all-`unknown`-fields record target (`err as { code?: unknown }`
      // — the errno-probing idiom): there is nothing to validate (every
      // field is unknown, exactly what the dyn value already answers) and
      // nothing to build — the cast is pure typing, so it ERASES and the
      // reads ride the dyn keyed read.
      if (target.kind === "record") {
        const shape = L.shapes.get(target.shapeId);
        if (
          shape &&
          !shape.tuple &&
          shape.fields.every((f) => f.type.kind === "dyn") &&
          (!shape.indexValue || shape.indexValue.kind === "dyn")
        ) {
          return inner;
        }
      }
      L.unsupported(
        "SC1090",
        expr,
        `a checked cast of 'unknown' to '${target.kind === "void" ? "void" : L.fmt(target)}' ` +
          `(a dynamic value can only be validated against JSON-representable types: ` +
          `number, string, boolean, records, arrays, and unions of those)`,
      );
    }
    return { kind: "dynCheck", value: inner, type: target, loc: locOf(expr) };
  }

export function lowerPrefixUnary(L: Lowerer, expr: ts.PrefixUnaryExpression): IrExpr {
    const loc = locOf(expr);
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken: {
        const operand = L.lowerExpr(expr.operand);
        if (operand.type.kind === "jsval") {
          return { kind: "jsOp", op: "neg", args: [operand], type: JSVAL, loc };
        }
        if (operand.type.kind !== "f64") L.unsupported("SC1043", expr);
        if (operand.kind === "numLit") return { ...operand, value: -operand.value, loc };
        return { kind: "unary", op: "-", operand, type: F64, loc };
      }
      case ts.SyntaxKind.PlusToken: {
        const operand = L.lowerExpr(expr.operand);
        // Unary + is ToNumber; on an already-number operand it's identity,
        // and a STRING operand runs the runtime's ECMA-exact StringToNumber
        // (num.fromString — Number(aString)'s lowering, scr_string.c).
        if (operand.type.kind === "jsval") {
          return { kind: "jsOp", op: "plus", args: [operand], type: JSVAL, loc };
        }
        if (operand.type.kind === "string") {
          return { kind: "libCall", fn: "num.fromString", args: [operand], type: F64, loc };
        }
        if (operand.type.kind !== "f64") L.unsupported("SC1043", expr);
        return operand;
      }
      case ts.SyntaxKind.ExclamationToken: {
        // `!x` is ToBoolean-then-negate: f64/string operands go through toBool.
        const operand = L.ensureBool(L.lowerExpr(expr.operand), expr.operand);
        return { kind: "unary", op: "!", operand, type: BOOL, loc };
      }
      case ts.SyntaxKind.TildeToken: {
        // `~x`: ToInt32, complement, back to f64 (JS-exact, incl. NaN → -1).
        const operand = L.lowerExpr(expr.operand);
        if (operand.type.kind !== "f64") L.unsupported("SC1043", expr);
        return { kind: "unary", op: "~", operand, type: F64, loc };
      }
      case ts.SyntaxKind.PlusPlusToken:
      case ts.SyntaxKind.MinusMinusToken:
        // `++x` / `--x` in expression position: yields the NEW value.
        return lowerIncDec(L, expr, true);
    }
    L.unsupported("SC1090", expr, `syntax '${ts.SyntaxKind[expr.kind]}'`);
  }

/** `x++`/`x--`/`++x`/`--x` in EXPRESSION position — the incDec node:
   * read, write ±1, yield old (postfix) or new (prefix) value. Receivers
   * are f64 LOCALS or module globals (captured/boxed included — the
   * backend reads/writes through the box); record fields and array
   * elements keep the fence in value position (statement-position `obj.f++`
   * still desugars through the compound-field path). */
  function lowerIncDec(
    L: Lowerer,
    expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
    prefix: boolean,
  ): IrExpr {
    const loc = locOf(expr);
    const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
    if (!ts.isIdentifier(expr.operand)) {
      // CLASS-FIELD receivers (`if (--this.limit === 0)` — countdown.js's
      // dec(); `--this[kLimit]` — its symbol-keyed spelling): a single-
      // evaluation read-modify-write over the instance, yielding old/new
      // like the local form. f64 fields are JS-exact; CHECKED-DYNAMIC
      // fields (implicit-any ctor assignments in JS) take the dyn
      // arithmetic stance — the number validates out (dynCheck's
      // catchable TypeError, never a silent ToNumber; SEMANTICS.md),
      // computes, and boxes back. Array elements, record fields, and
      // accessor-backed names keep the fence.
      if (
        (ts.isPropertyAccessExpression(expr.operand) || ts.isElementAccessExpression(expr.operand)) &&
        !expr.operand.questionDotToken
      ) {
        const target = ts.isPropertyAccessExpression(expr.operand)
          ? L.fieldTarget(expr.operand)
          : symbolFieldTarget(L, expr.operand);
        if (
          target?.container === "class" &&
          !RUNTIME_ERROR_CLASSES.has(target.className) &&
          (target.fieldType.kind === "f64" ||
            (target.fieldType.kind === "dyn" && isJsSourceFile(expr.getSourceFile())))
        ) {
          return {
            kind: "fieldIncDec",
            op,
            prefix,
            obj: target.obj,
            className: target.className,
            field: target.field,
            fieldDyn: target.fieldType.kind === "dyn",
            type: F64,
            loc,
          };
        }
      }
      // Other field/element receivers need a read-modify-write over a
      // computed receiver — statement position has that desugar; value
      // position does not yet. The message names the working forms.
      L.unsupported(
        "SC1045",
        expr,
        "increment/decrement of record fields or elements in expression position",
      );
    }
    const target = L.resolveWritable(expr.operand);
    if (!target) {
      L.rejectUnresolved(expr.operand, `increment/decrement of '${expr.operand.text}' (not a writable local or module global)`);
    }
    if (target.type.kind !== "f64") L.unsupported("SC1043", expr);
    return { kind: "incDec", op, prefix, localId: target.id, type: F64, loc };
  }

/** Whether a lowered statement can live inside a seqExpr — the
 * validator's straight-line set (writes and effect expressions only; the
 * C emission point is mid-expression, so no control flow, no jumps).
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
    case "bytesSet":
      return true;
    case "block":
      return s.body.every(seqExprSafeStmt);
    default:
      return false;
  }
}

export function lowerBinary(L: Lowerer, expr: ts.BinaryExpression): IrExpr {
    const loc = locOf(expr);
    const op = expr.operatorToken.kind;

    if (op === ts.SyntaxKind.EqualsToken || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
      // `x = e` in EXPRESSION position (`while ((idx = s.indexOf("\n")) !== -1)`,
      // `f(x = v)`): evaluate e once, write the binding, yield the assigned
      // value — JS evaluation order. Variable targets only (locals and module
      // globals, captured/boxed included); the RHS coerces into the binding's
      // type exactly like statement position, and the expression's value is
      // the coerced binding-typed value (representation change only — never
      // observably different from JS's raw-RHS yield). Compound operators,
      // property/element targets, and destructuring targets stay fenced.
      if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
        const target = L.resolveWritable(expr.left);
        if (!target) {
          L.rejectUnresolved(expr.left, `assignment to '${expr.left.text}' (not a writable local or module global)`);
        }
        const value = L.lowerExprExpecting(expr.right, target.type);
        const runtimeOptionalRoot = L.runtimeOptionalRootOf(target);
        if (L.runtimeOptionalStorageLocals.has(runtimeOptionalRoot)) L.runtimeOptionalLocals.add(runtimeOptionalRoot);
        return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
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
        const bi = L.builtinMemberOf(expr.left);
        if (bi && bi.module === "events" && bi.member === "defaultMaxListeners") {
          const rhs = L.lowerExpr(expr.right);
          if (rhs.type.kind === "dyn" || rhs.kind === "unitLit" || L.dynConvertible(rhs.type)) {
            const valTmp = L.declareHiddenLocal("%setVal", rhs.type);
            const valRef = (): IrExpr => ({ kind: "varRef", localId: valTmp.id, type: rhs.type, loc });
            const dynVal: IrExpr =
              rhs.type.kind === "dyn" ? valRef() : { kind: "dynFrom", value: valRef(), type: DYN, loc };
            return {
              kind: "seqExpr",
              stmts: [
                { kind: "varDecl", localId: valTmp.id, init: rhs, loc },
                {
                  kind: "exprStmt",
                  expr: {
                    kind: "libCall",
                    fn: "emitter.setDefaultMaxChk",
                    args: [dynVal, { kind: "strLit", value: "defaultMaxListeners", type: STRING, loc }],
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
          expandoWritableTarget(L, expr.left) ??
          (ts.isPropertyAccessExpression(expr.left) ? nsWritableTarget(L, expr.left) : null);
        if (target) {
          const value = L.lowerExprExpecting(expr.right, target.type);
          return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
        }
        // `h.k = v` on an ISLAND receiver in VALUE position: the engine
        // property write (setProp throws the engine's TypeErrors on
        // nullish receivers, bridged catchably), the RHS value threaded
        // through as the expression's value.
        if (ts.isPropertyAccessExpression(expr.left) && !expr.left.questionDotToken && L.isIslandExpr(expr.left.expression)) {
          const recv = L.lowerExpr(expr.left.expression);
          const recvTmp = L.declareHiddenLocal("%setRecv", recv.type);
          const rhsVal = L.lowerExpr(expr.right);
          const valTmp = L.declareHiddenLocal("%setVal", rhsVal.type);
          const valRef = (): IrExpr => ({ kind: "varRef", localId: valTmp.id, type: rhsVal.type, loc });
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
                  args: [{ kind: "varRef", localId: recvTmp.id, type: recv.type, loc }, L.jsvalIn(valRef(), expr.right)],
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
          const recv = probeLower(L, expr.left.expression);
          if (recv && recv.type.kind === "dyn") {
            const recvTmp = L.declareHiddenLocal("%setRecv", DYN);
            const rhsVal = L.lowerExpr(expr.right);
            const valTmp = L.declareHiddenLocal("%setVal", rhsVal.type);
            const valRef = (): IrExpr => ({ kind: "varRef", localId: valTmp.id, type: rhsVal.type, loc });
            const stored = L.coerceToExpected(valRef(), DYN);
            if (stored.type.kind !== "dyn") {
              L.unsupported("SC1101", expr.right, `assigning '${L.fmt(rhsVal.type)}' values into a checked-dynamic member`);
            }
            const key: IrExpr = { kind: "strLit", value: expr.left.name.text, type: STRING, loc: locOf(expr.left.name) };
            return {
              kind: "seqExpr",
              stmts: [
                { kind: "varDecl", localId: recvTmp.id, init: recv, loc },
                { kind: "varDecl", localId: valTmp.id, init: rhsVal, loc },
                {
                  kind: "exprStmt",
                  expr: { kind: "libCall", fn: "dyn.keySet", args: [{ kind: "varRef", localId: recvTmp.id, type: DYN, loc }, key, stored], type: VOID, loc },
                  loc,
                },
              ],
              result: valRef(),
              type: rhsVal.type,
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
        const parts = L.lowerDestructuringAssignParts(expr.left, expr.right, loc);
        return { kind: "seqExpr", stmts: parts.stmts, result: parts.value, type: parts.value.type, loc };
      }
      L.unsupported(
        "SC1090",
        expr,
        op === ts.SyntaxKind.EqualsToken
          ? "assignment to non-variables as an expression (only `x = e` over a variable yields a value; write property/destructuring assignments as statements)"
          : "compound assignment as an expression (write `x op= e` as a statement, or spell out `x = x op e`)",
      );
    }
    if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      const nullTest = lowerLooseNullCompare(L, expr, loc);
      if (nullTest) return nullTest;
      // SAME-KIND loose equality IS strict equality (the spec's ==
      // dispatches to === when both operands share a type): `typeof v ==
      // 'object'`, `n != 0`, `flag == true` all lower exactly. Mixed
      // kinds (where == coerces) keep the fence.
      {
        const negated = op === ts.SyntaxKind.ExclamationEqualsToken;
        const left = L.lowerExpr(expr.left);
        const right = L.lowerExpr(expr.right);
        if (left.type.kind === "string" && right.type.kind === "string") {
          return { kind: "strEq", negated, left, right, type: BOOL, loc };
        }
        if (
          (left.type.kind === "f64" && right.type.kind === "f64") ||
          (left.type.kind === "bool" && right.type.kind === "bool")
        ) {
          return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
        }
      }
      L.unsupported("SC1040", expr);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      if (op === ts.SyntaxKind.BarBarToken) {
        const fallback = lowerAbsenceAwareOrChain(L, expr);
        if (fallback) return fallback;
      }
      // JS value semantics: `a && b` is `toBool(a) ? b : a` — the result is
      // an operand value, so both operands must share one IR kind (which is
      // also what tsc's type says, modulo literal-union collapsing that
      // mapType already handles). Mixed kinds (`n && s`) stay rejected.
      const left = lowerAbsenceProbe(L, expr.left) ?? L.lowerExpr(expr.left);
      const right = L.lowerExpr(expr.right);
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
      if (left.type.kind === "dyn" || right.type.kind === "dyn") {
        // A checked-dynamic operand (`fn.name || '<anonymous>'` —
        // test/common's _mustCallInner): both sides live in the checked-dynamic tree and
        // the deciding test is ToBoolean over the dyn kind
        // (scr_dyn_truthy) — JS value semantics exactly, result dyn. The
        // non-dyn side converts through the usual boundary; a value with
        // no dyn representation keeps the fence.
        const l = L.coerceToExpected(left, DYN);
        const r = L.coerceToExpected(right, DYN);
        if (l.type.kind !== "dyn" || r.type.kind !== "dyn") {
          L.unsupported("SC1100", expr, "logical operators on 'unknown' values");
        }
        return {
          kind: "logical",
          op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
          left: l,
          right: r,
          type: DYN, loc,
        };
      }
      if (left.type.kind === "jsval" || right.type.kind === "jsval") {
        return {
          kind: "logical",
          op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
          left: L.jsvalIn(left, expr.left),
          right: L.jsvalIn(right, expr.right),
          type: JSVAL, loc,
        };
      }
      if (left.type.kind === "union" || right.type.kind === "union") {
        // JS value semantics over a union: the deciding test is the ARM
        // value's ToBoolean (a per-union helper), and the result is the
        // deciding operand. Supported when the checker's type of the whole
        // expression maps to ONE union both operands coerce into (same
        // union passes through; a plain arm wraps — `u || undefined`).
        // Everything else (`u && flag`, whose value would need a wider
        // re-tagged union) stays fenced — in CONDITION position those
        // shapes lower through lowerCondition's bool descent instead.
        const target = L.mapTypeOf(L.typeOf(expr));
        if (target?.kind === "union") {
          // `||` whose left does NOT fit the result union: the checker built
          // that result by DROPPING the left's falsy arms (`process.env.X ||
          // null` is `string | null`, `|| 3000` is `string | number` — the
          // `undefined` is gone from both), so coercing the left eagerly, as
          // the shared shape below does, retags an arm the test is about to
          // rule out and throws where Node yields the default. Single-eval
          // instead: test the left in its OWN union and retag only on the
          // truthy side, where the dropped arms are unreachable. `&&` keeps
          // the eager shape — there the falsy left IS the result, so the
          // checker keeps those arms in the target and they must coerce.
          if (op === ts.SyntaxKind.BarBarToken && left.type.kind === "union" && !typeEquals(left.type, target)) {
            const retag = L.unionRetagHelper(left.type.unionId, target.unionId, loc);
            if (retag) {
              L.requireTruthyUnion(left.type.unionId, expr);
              return {
                kind: "orDefault",
                left,
                right: L.coerceInto(expr.right, right, target),
                retag,
                type: target,
                loc,
              };
            }
          }
          L.requireTruthyUnion(target.unionId, expr);
          return {
            kind: "logical",
            op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
            left: L.coerceInto(expr.left, left, target),
            right: L.coerceInto(expr.right, right, target),
            type: target, loc,
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
        if (
          op === ts.SyntaxKind.BarBarToken &&
          left.type.kind === "union"
        ) {
          const def = L.unions.get(left.type.unionId);
          const rest = def ? def.arms.filter((a) => !isUnitType(a)) : [];
          const funcArmDefault =
            rest[0]?.kind === "func" && (target === null || target.kind === "func");
          if (rest.length === 1 && ((target !== null && typeEquals(target, rest[0]!)) || funcArmDefault)) {
            L.requireTruthyUnion(left.type.unionId, expr);
            const dflt = L.lowerExprExpecting(expr.right, rest[0]!);
            return { kind: "orDefault", left, right: dflt, type: rest[0]!, loc };
          }
        }
        L.unsupported(
          "SC1090",
          expr,
          `logical operators on union-typed values outside conditions (${NARROW_FIRST})`,
        );
      }
      const kind = left.type.kind;
      if (
        kind !== right.type.kind ||
        (kind !== "f64" && kind !== "string" && kind !== "bool")
      ) {
        // Mixed PLAIN operands (`value || null`, `flag || undefined`,
        // `s || 0`): JS value semantics still compile when the checker
        // types the RESULT as one union both operands coerce into — the
        // same lift the union-operand path above takes, arriving here
        // with two plain arm values instead.
        const target = L.mapTypeOf(L.typeOf(expr));
        if (target?.kind === "union") {
          L.requireTruthyUnion(target.unionId, expr);
          return {
            kind: "logical",
            op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
            left: L.coerceInto(expr.left, left, target),
            right: L.coerceInto(expr.right, right, target),
            type: target, loc,
          };
        }
        L.unsupported("SC1042", expr);
      }
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left, right, type: left.type, loc,
      };
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      return L.lowerNullishCoalesce(expr, loc);
    }
    if (op === ts.SyntaxKind.CommaToken) {
      // Comma expression in VALUE position (`r = ({} = a, [] = a)` — the
      // conformance corpus's paired-destructuring idiom): the left operand
      // runs for EFFECT exactly as its statement lowering (JS discards its
      // value), the right operand is the expression's value — a seqExpr.
      // The validator restricts seqExpr statements to straight-line writes
      // (the C emission point is mid-expression), so a left operand whose
      // statement lowering needs real control flow keeps a pointed fence
      // instead of tripping the validator downstream.
      const effect = L.lowerExprStatement(expr.left);
      if (!seqExprSafeStmt(effect)) {
        L.unsupported(
          "SC1090",
          expr.left,
          "comma expressions whose left operand needs control flow (run it as its own statement first)",
        );
      }
      const result = L.lowerExpr(expr.right);
      return { kind: "seqExpr", stmts: [effect], result, type: result.type, loc };
    }
    if (op === ts.SyntaxKind.InstanceOfKeyword) return L.lowerInstanceOf(expr, loc);
    if (op === ts.SyntaxKind.InKeyword) {
      return lowerInExpression(L, expr, loc);
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
        lowerErrorCodeTypeofTest(L, expr, loc) ??
        L.lowerCaughtTypeofTest(expr, loc) ??
        lowerDynTypeofTest(L, expr, loc) ??
        lowerUnionTypeofTest(L, expr, loc);
      if (test) return test;
    }

    const strictEquality = op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const left = strictEquality ? lowerAbsenceProbe(L, expr.left) ?? L.lowerExpr(expr.left) : L.lowerExpr(expr.left);
    const right = strictEquality ? lowerAbsenceProbe(L, expr.right) ?? L.lowerExpr(expr.right) : L.lowerExpr(expr.right);
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
        const other = unit === left ? right : left;
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
        if (
          dynSide.type.kind === "dyn" &&
          (scalarSide.type.kind === "f64" || scalarSide.type.kind === "string" || scalarSide.type.kind === "bool" ||
            // dyn vs dyn (`context.actual !== context.exact` —
            // test/common's exit accounting): the runtime's whole-dyn
            // strict equality — scalars by value, units by kind,
            // reference kinds by node identity (scr_dyn_strict_eq).
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
      // JS `any`-origin operands (the checked-dynamic declaration story):
      // arithmetic and ordering CHECK the dyn side to the static side's
      // scalar kind (dynCheck — a catchable TypeError on mismatch) and
      // compute natively. Node would ToNumber-coerce instead — the honest
      // divergence is loud (a throw), never a silent wrong answer
      // (SEMANTICS.md). tsc rejects these forms on real `unknown`, so only
      // any-typed JS reaches this; when BOTH sides are dyn a number
      // context is the only honest guess for arithmetic — both check.
      if (isJsSourceFile(expr.getSourceFile())) {
        const checkNum = (e: IrExpr): IrExpr =>
          e.type.kind === "dyn" ? { kind: "dynCheck", value: e, type: F64, loc: e.loc } : e;
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
        if ((arith || cmp) && (other.type.kind === "f64" || other.type.kind === "dyn")) {
          const l = checkNum(left);
          const r = checkNum(right);
          if (arith) return { kind: "bin", op: arith, left: l, right: r, type: F64, loc };
          return { kind: "bin", op: cmp!, left: l, right: r, type: BOOL, loc };
        }
        // `+`: number when the OTHER side is a number, string concat when
        // it is a string — the two static homes; dyn+dyn stays a number.
        if (op === ts.SyntaxKind.PlusToken) {
          if (other.type.kind === "f64" || other.type.kind === "dyn") {
            return { kind: "bin", op: "+", left: checkNum(left), right: checkNum(right), type: F64, loc };
          }
          if (other.type.kind === "string") {
            // String-context `+`: JS's answer is String(unknown) — the
            // JS-exact dyn walker (numbers format, arrays join, objects
            // print [object Object], handles the same) — never a checked
            // cast: `'status ' + res.statusCode` concatenates like Node.
            const strOf = (e: IrExpr): IrExpr =>
              e.type.kind === "dyn" ? { kind: "toString", operand: e, type: STRING, loc: e.loc } : e;
            return { kind: "strConcat", left: strOf(left), right: strOf(right), type: STRING, loc };
          }
        }
      }
      // `any`-origin operands (tsc rejects these operator forms on real
      // `unknown`, so in a checker-clean TS program only `any` reaches
      // here): JS's full coercion semantics (ToPrimitive, NaN, string +)
      // live in the engine — the dynamic-family fence, so the island
      // retry lifts the site. Genuine unknown keeps the SC1100 story.
      if (
        (left.type.kind === "dyn" && L.anyOrigin(expr.left)) ||
        (right.type.kind === "dyn" && L.anyOrigin(expr.right))
      ) {
        L.anyOpFence(`the '${ts.tokenToString(op) ?? ts.SyntaxKind[op]}' operator`, expr);
      }
      // tsc allows ===/!== on unknown (arithmetic/comparisons it rejects
      // itself); a dynamic equality would need a dyn walk — validate first.
      L.unsupported("SC1100", expr, "operators on 'unknown' values");
    }
    // Operators over 'any' execute in the island with JS-exact semantics
    // (ToPrimitive, NaN, string +): both operands marshal in, the engine
    // computes. Comparisons come back as static bools; arithmetic stays
    // an island value ('1 as any + "x"' is a string over there).
    if (left.type.kind === "jsval" || right.type.kind === "jsval") {
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
        L.unsupported("SC1090", expr, `operator '${ts.tokenToString(op) ?? ts.SyntaxKind[op]}' on 'any' values`);
      }
      const type = jsOpResultKind(jop) === "bool" ? BOOL : JSVAL;
      return {
        kind: "jsOp", op: jop,
        args: [L.jsvalIn(left, expr.left), L.jsvalIn(right, expr.right)],
        type, loc,
      };
    }
    const bothNum = left.type.kind === "f64" && right.type.kind === "f64";
    const bothStr = left.type.kind === "string" && right.type.kind === "string";

    switch (op) {
      case ts.SyntaxKind.PlusToken:
        if (bothNum) return { kind: "bin", op: "+", left, right, type: F64, loc };
        if (left.type.kind === "string" || right.type.kind === "string") {
          return {
            kind: "strConcat",
            left: L.ensureString(left, expr.left),
            right: L.ensureString(right, expr.right),
            type: STRING, loc,
          };
        }
        L.unsupported("SC1043", expr);
        break;
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.PercentToken:
      case ts.SyntaxKind.AsteriskAsteriskToken: {
        if (!bothNum) L.unsupported("SC1043", expr);
        const binOp = op === ts.SyntaxKind.MinusToken ? "-"
          : op === ts.SyntaxKind.AsteriskToken ? "*"
          : op === ts.SyntaxKind.SlashToken ? "/"
          : op === ts.SyntaxKind.PercentToken ? "%" : "**";
        return { kind: "bin", op: binOp, left, right, type: F64, loc };
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
        if (!bothNum) L.unsupported("SC1043", expr);
        const bitOp = op === ts.SyntaxKind.AmpersandToken ? "&"
          : op === ts.SyntaxKind.BarToken ? "|"
          : op === ts.SyntaxKind.CaretToken ? "^"
          : op === ts.SyntaxKind.LessThanLessThanToken ? "<<"
          : op === ts.SyntaxKind.GreaterThanGreaterThanToken ? ">>" : ">>>";
        return { kind: "bin", op: bitOp, left, right, type: F64, loc };
      }
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: {
        const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if (bothNum) return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
        if (bothStr) return { kind: "strEq", negated, left, right, type: BOOL, loc };
        // bool === bool: a plain value compare (the config-drift checks'
        // `desired.lanMode !== actual.lanMode` shape).
        if (left.type.kind === "bool" && right.type.kind === "bool") {
          return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
        }
        const unitTest = L.lowerUnitComparison(left, right, negated, loc);
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
          const ut = left.type.kind === "union" ? left.type : (right.type as IrType & { kind: "union" });
          const bothUnion = left.type.kind === "union" && right.type.kind === "union";
          const sameUnion = bothUnion && typeEquals(left.type, right.type);
          const plainFunc = left.type.kind === "func" ? left : right.type.kind === "func" ? right : null;
          const unionArms = L.unions.get(ut.unionId)?.arms ?? [];
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
              tag: L.armTag(ut.unionId, funcArm),
              union: left.type.kind === "union" ? left : right,
              func: plainFunc,
              negated,
              type: BOOL,
              loc,
            };
          }
          if ((sameUnion || !bothUnion) && L.eqComparableUnion(ut.unionId)) {
            return {
              kind: "unionEq",
              unionId: ut.unionId,
              negated,
              sameValue: false,
              left: L.coerceInto(expr.left, left, ut),
              right: L.coerceInto(expr.right, right, ut),
              type: BOOL,
              loc,
            };
          }
          L.unsupported(
            "SC1090",
            expr,
            `comparisons of union-typed values (${NARROW_FIRST})`,
          );
        }
        // Arrays, maps, functions, class instances and records compare by
        // reference identity (pointer compare) — JS-exact object equality.
        // Hierarchy-related classes compare after widening the derived side
        // (same pointer either way — prefix layout).
        let idLeft = left;
        let idRight = right;
        if (left.type.kind === "object" && right.type.kind === "object") {
          if (L.isSubclassOf(left.type.className, right.type.className)) {
            idLeft = L.upcastTo(left, right.type.className);
          } else if (L.isSubclassOf(right.type.className, left.type.className)) {
            idRight = L.upcastTo(right, left.type.className);
          }
        }
        // Two function values compare by identity whatever their STATIC
        // signatures (tsc admits the comparison when one side is
        // assignable to the other — a tuple-typed listeners() element
        // against a prefix-declared handler): the pointer answers it.
        if (idLeft.type.kind === "func" && idRight.type.kind === "func") {
          return { kind: "bin", op: negated ? "!==" : "===", left: idLeft, right: idRight, type: BOOL, loc };
        }
        // Two CLASS values compare by identity whatever their static
        // classes — one immortal object per class, one pointer compare
        // (the function-identity rule verbatim; `X === D` through a
        // base-typed slot answers exactly JS).
        if (idLeft.type.kind === "classval" && idRight.type.kind === "classval") {
          return { kind: "bin", op: negated ? "!==" : "===", left: idLeft, right: idRight, type: BOOL, loc };
        }
        if (
          (idLeft.type.kind === "array" ||
            idLeft.type.kind === "map" ||
            idLeft.type.kind === "set" ||
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
          return { kind: "bin", op: negated ? "!==" : "===", left: idLeft, right: idRight, type: BOOL, loc };
        }
        // Runtime HANDLES are objects to === too: one handle per socket/
        // request/response, so pointer identity IS JS's object equality
        // (`c.pause() === c` — Node's chaining assertions). */
        if (DYN_HANDLE_KINDS.has(idLeft.type.kind) && typeEquals(idLeft.type, idRight.type)) {
          return { kind: "bin", op: negated ? "!==" : "===", left: idLeft, right: idRight, type: BOOL, loc };
        }
        L.unsupported("SC1043", expr);
        break;
      }
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken: {
        const cmpOp = op === ts.SyntaxKind.LessThanToken ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken ? "<="
          : op === ts.SyntaxKind.GreaterThanToken ? ">" : ">=";
        if (bothNum) return { kind: "bin", op: cmpOp, left, right, type: BOOL, loc };
        if (bothStr) return { kind: "strCmp", op: cmpOp, left, right, type: BOOL, loc };
        L.unsupported("SC1043", expr);
        break;
      }
      default:
        break;
    }
    L.unsupported("SC1090", expr, `operator '${ts.tokenToString(op) ?? ts.SyntaxKind[op]}'`);
  }

  function lowerAbsenceAwareOrChain(L: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
    const nodes: ts.Expression[] = [];
    const collect = (node: ts.Expression): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ) {
        collect(node.left);
        collect(node.right);
      } else {
        nodes.push(node);
      }
    };
    collect(expr);
    if (nodes.length < 3) return null;
    const lowered = nodes.map((node) => lowerAbsenceProbe(L, node) ?? L.lowerExpr(node));
    if (!lowered.some((value) => value.type.kind === "union" && L.armTag(value.type.unionId, UNDEFINED_T) >= 0)) {
      return null;
    }
    let result = lowered[lowered.length - 1]!;
    for (let i = lowered.length - 2; i >= 0; i--) {
      const left = lowered[i]!;
      const loc = locOf(nodes[i]!);
      if (left.type.kind === "union") {
        const def = L.unions.get(left.type.unionId);
        const nonUnit = def?.arms.filter((arm) => !isUnitType(arm)) ?? [];
        if (nonUnit.length !== 1 || !typeEquals(nonUnit[0]!, result.type)) return null;
        L.requireTruthyUnion(left.type.unionId, expr);
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
  function errorRootedObjectOf(L: Lowerer, t: ts.Type): IrType | null {
    const rooted = (m: IrType | null): m is IrType & { kind: "object" } => {
      if (m?.kind !== "object") return false;
      let info = L.classes.get(m.className) ?? null;
      while (info && info.base) info = info.base;
      return info?.def.name === "%Error";
    };
    const direct = L.mapTypeOf(t);
    if (rooted(direct)) return direct;
    if (t.isIntersectionType()) {
      for (const part of ts.constituentTypes(t)) {
        const m = L.mapTypeOf(part);
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
  function lowerErrorCodeTypeofTest(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    for (const [a, b] of [
      [expr.left, expr.right],
      [expr.right, expr.left],
    ] as const) {
      if (!ts.isTypeOfExpression(a)) continue;
      let prop: ts.Expression = a.expression;
      while (ts.isParenthesizedExpression(prop)) prop = prop.expression;
      if (!ts.isPropertyAccessExpression(prop) || prop.questionDotToken) continue;
      if (prop.name.text !== "code") continue;
      let recv: ts.Expression = prop.expression;
      while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isTypeAssertion(recv)) recv = recv.expression;
      const errT = errorRootedObjectOf(L, L.typeOf(recv));
      if (!errT) continue;
      const caught = L.caughtLocalOf(recv);
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
        receiver = L.lowerExpr(recv);
        if (receiver.type.kind !== "object") continue;
      }
      if (!ts.isStringLiteral(b)) continue;
      if (b.text !== "string" && b.text !== "undefined") continue;
      const codeType = L.envValueType();
      if (codeType.kind !== "union") throw new InternalCompilerError("lowerer bug: error code type is not a union");
      const undefTag = L.armTag(codeType.unionId, UNDEFINED_T);
      const read: IrExpr = { kind: "libCall", fn: "error.code", args: [receiver], type: codeType, loc };
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

  export function lowerCaughtTypeofTest(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    for (const [a, b] of [
      [expr.left, expr.right],
      [expr.right, expr.left],
    ] as const) {
      if (!ts.isTypeOfExpression(a)) continue;
      const local = L.caughtLocalOf(a.expression);
      if (!local) continue;
      if (!ts.isStringLiteral(b)) {
        L.unsupported(
          "SC1090",
          expr,
          "'typeof' catch-binding tests against non-literal strings",
        );
      }
      if (b.text === "string" || b.text === "number" || b.text === "boolean") {
        return {
          kind: "caughtTest",
          value: { kind: "varRef", localId: local.id, type: CAUGHT, loc },
          test: b.text,
          ...(negated ? { negated: true } : {}),
          type: BOOL,
          loc,
        };
      }
      L.unsupported(
        "SC1090",
        b,
        `'typeof' catch-binding tests against "${b.text}" (only "string"/"number"/"boolean" ` +
          `narrow a catch binding; use 'instanceof' for objects)`,
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
      case "f64": return "number";
      case "string": return "string";
      case "bool": return "boolean";
      case "undefinedT": return "undefined";
      case "func": return "function";
      case "symbol": return "symbol";
      case "nullT":
      case "array": case "map": case "set": case "regex": case "bytes":
      case "url": case "searchParams": case "stats": case "fileHandle": case "spawnRes": case "child":
      case "netServer": case "netSocket": case "httpReq": case "httpRes":
      case "httpClientReq": case "secureCtx": case "fsWatcher":
      case "childStream": case "procStream":
      case "object": case "record": case "promise":
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
   * L.narrowingAliases: branch-scoped typeOf overrides, bridged by
   * maybeNarrow's ordinary unionNarrow. */
  export function aliasTypeofNarrows(L: Lowerer, cond: ts.Expression, polarity: boolean): { sym: ts.Symbol; tsArm: ts.Type }[] {
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
      const leaf = aliasTypeofArmOf(L, e, strip);
      if (leaf) out.push(leaf);
    };
    if (implicitMonoFile(cond.getSourceFile())) walk(cond, polarity);
    return out;
  }

/** One ===/!== leaf of aliasTypeofNarrows — the qualification battery. */
  function aliasTypeofArmOf(L: Lowerer, e: ts.BinaryExpression,
    strip: (x: ts.Expression) => ts.Expression,): { sym: ts.Symbol; tsArm: ts.Type } | null {
    for (const [a0, b] of [
      [e.left, e.right],
      [e.right, e.left],
    ] as const) {
      if (!ts.isStringLiteral(b)) continue;
      const a = strip(a0);
      if (!ts.isIdentifier(a)) continue;
      const aliasSym = L.resolveValueSymbol(a);
      const aliasDecl = aliasSym ? L.checker.valueDeclarationOf(aliasSym) : undefined;
      if (!aliasSym || !aliasDecl || !ts.isVariableDeclaration(aliasDecl) || aliasDecl.initializer === undefined) continue;
      const init = strip(aliasDecl.initializer);
      if (!ts.isTypeOfExpression(init)) continue;
      const opnd = strip(init.expression);
      if (!ts.isIdentifier(opnd)) continue;
      if (!bindingNeverReassigned(L, aliasSym, aliasDecl)) continue;
      const valSym = L.resolveValueSymbol(opnd);
      const valDecl = valSym ? L.checker.valueDeclarationOf(valSym) : undefined;
      if (!valSym || !valDecl) continue;
      // v1: identifier PARAMETERS only — initialized at function entry,
      // before any alias can capture their typeof.
      if (!ts.isParameter(valDecl) || !ts.isIdentifier(valDecl.name)) continue;
      if (!bindingNeverReassigned(L, valSym, valDecl)) continue;
      const fn = valDecl.parent;
      if (!(e.pos >= fn.pos && e.end <= fn.end)) continue;
      const valT = L.typeOf(opnd); // override-aware: implicit bindings compose
      const mapped = L.mapTypeOf(valT);
      if (mapped?.kind !== "union") continue;
      const def = L.unions.get(mapped.unionId);
      const answers = def?.arms.map(typeofAnswer);
      if (!def || !answers || !answers.every((s): s is string => s !== null)) continue;
      const tags = answers.flatMap((s, i) => (s === b.text ? [i] : []));
      if (tags.length !== 1) continue;
      const arm = def.arms[tags[0]!]!;
      // The checker-side arm: the union part whose (widened) mapping IS
      // the proven IR arm — what typeOf answers inside the branch.
      const parts = valT.isUnionType() ? ts.constituentTypes(valT) : [valT];
      const tsArm = parts.find((p) => {
        const m = L.mapTypeOf(L.checker.getBaseTypeOfLiteralType(p));
        return m !== null && typeEquals(m, arm);
      });
      if (!tsArm) continue;
      return { sym: valSym, tsArm: L.checker.getBaseTypeOfLiteralType(tsArm) };
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
  function lowerUnionTypeofTest(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    for (const [a, b] of [
      [expr.left, expr.right],
      [expr.right, expr.left],
    ] as const) {
      if (!ts.isTypeOfExpression(a)) continue;
      if (L.mapTypeOf(L.typeOf(a.expression))?.kind !== "union") continue;
      if (!ts.isStringLiteral(b)) continue; // bare-typeof + strEq handles pure operands
      const value = L.lowerExpr(a.expression);
      if (value.type.kind !== "union") continue; // defensive: an already-narrowed use
      const unionId = value.type.unionId;
      const def = L.unions.get(unionId);
      const answers = def?.arms.map(typeofAnswer);
      if (!def || !answers || !answers.every((s): s is string => s !== null)) continue;
      const tags = answers.flatMap((s, i) => (s === b.text ? [i] : []));
      if (tags.length === 0 || tags.length === def.arms.length) {
        if (!pureReemittable(value)) {
          L.unsupported(
            "SC1090",
            expr,
            "statically-decided 'typeof' tests over effectful operands (bind the value to a const first)",
          );
        }
        return { kind: "boolLit", value: (tags.length !== 0) !== negated, type: BOOL, loc };
      }
      const isTag = (tag: number): IrExpr => ({
        kind: "unionIsTag", unionId, tag, negated, value, type: BOOL, loc,
      });
      if (tags.length === 1) return isTag(tags[0]!);
      if (!pureReemittable(value)) {
        L.unsupported(
          "SC1090",
          expr,
          "'typeof' tests matching several union arms over operands that aren't plain reads (bind the value to a const first)",
        );
      }
      // Tag-in-set as a short-circuit chain (De Morgan for `!==`).
      let acc = isTag(tags[0]!);
      for (const t of tags.slice(1)) {
        acc = { kind: "logical", op: negated ? "&&" : "||", left: acc, right: isTag(t), type: BOOL, loc };
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
  function lowerDynTypeofTest(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    for (const [a, b] of [
      [expr.left, expr.right],
      [expr.right, expr.left],
    ] as const) {
      if (!ts.isTypeOfExpression(a)) continue;
      const declared = L.mapTypeOf(L.typeOf(a.expression));
      let value: IrExpr;
      if (declared?.kind === "dyn") {
        value = L.lowerExpr(a.expression);
        if (value.type.kind !== "dyn") continue; // defensive: an already-narrowed use
      } else if (L.caughtLocalOf(a.expression)) {
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
            const obj = probeLower(L, inner);
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
          const probed = probeLower(L, a.expression);
          if (probed?.type.kind !== "dyn") continue;
          value = probed;
        }
      }
      if (!ts.isStringLiteral(b)) {
        L.unsupported(
          "SC1090",
          expr,
          "'typeof' tests on 'unknown' values against non-literal strings",
        );
      }
      if (b.text === "string" || b.text === "number" || b.text === "boolean" || b.text === "undefined") {
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
      // Kinds a dyn box can NEVER hold — no conversion into 'unknown'
      // exists for bigints or symbols (dynFrom's domain is JSON-safe data
      // + bytes + Error + functions), so the test's answer is a
      // compile-time constant: false for ===, true for !==. The capability
      // probes this settles (`typeof ms === 'bigint'` in dual-mode number
      // helpers) then FOLD their impossible arm (lowerTernary), which is
      // what lets the reachable arm compile statically.
      if (b.text === "bigint" || b.text === "symbol") {
        return { kind: "boolLit", value: negated, type: BOOL, loc };
      }
      L.unsupported(
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
  function lowerReplacedExportsRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    const recv = expr.expression;
    if (!ts.isIdentifier(recv) || recv.text !== "exports") return null;
    const sf = expr.getSourceFile();
    if (!isJsSourceFile(sf) || isNodeEsmFile(sf)) return null;
    if (L.peekLocal(recv) || L.globalOf(recv)) return null; // a user binding shadows
    // Write position is the export-assignment machinery's territory.
    if (ts.isBinaryExpression(expr.parent) && expr.parent.left === expr &&
        expr.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
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
  function cjsExportAccessorRead(L: Lowerer, ident: ts.Identifier): IrExpr | null {
    const symbol = L.resolveValueSymbol(ident);
    const getter = symbol ? L.checker.declarationsOf(symbol).find(ts.isGetAccessorDeclaration) : undefined;
    if (!getter) return null;
    if (!ts.isObjectLiteralExpression(getter.parent) || !isCjsExportTableLiteral(getter.parent)) {
      return null;
    }
    return cjsAccessorCall(L, getter, locOf(ident));
  }

/** The interned lifted-getter call both accessor-read paths share. */
  function cjsAccessorCall(L: Lowerer, getter: ts.GetAccessorDeclaration, loc: SrcLoc): IrExpr | null {
    let fn = L.cjsAccessorFns.get(getter);
    if (!fn) {
      const closure = L.lowerLambda(getter);
      if (closure.kind !== "closure" || closure.type.kind !== "func") return null; // defensive
      fn = { fnName: closure.fnName, type: closure.type };
      L.cjsAccessorFns.set(getter, fn);
    }
    // Lifted functions carry the closure ABI (an env parameter, even
    // capture-free) — the read calls through a zero-capture closure value,
    // the interned identity every lifted lambda uses.
    const closureVal: IrExpr = { kind: "closure", fnName: fn.fnName, captures: [], type: fn.type, loc };
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
  function lowerCjsExportTableThisMember(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.expression.kind !== ts.SyntaxKind.ThisKeyword || expr.questionDotToken) return null;
    if (!isJsSourceFile(expr.getSourceFile())) return null;
    // The enclosing accessor, crossing only arrow boundaries (arrows
    // inherit `this`; any other function form rebinds it).
    let n: ts.Node = expr.parent;
    while (n !== undefined && !ts.isGetAccessorDeclaration(n) && !ts.isSetAccessorDeclaration(n)) {
      if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return null;
      if (ts.isSourceFile(n)) return null;
      n = n.parent;
    }
    if (n === undefined || !ts.isObjectLiteralExpression(n.parent) || !isCjsExportTableLiteral(n.parent)) {
      return null;
    }
    const sibling = n.parent.properties.find(
      (p): p is ts.GetAccessorDeclaration =>
        ts.isGetAccessorDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === expr.name.text,
    );
    if (!sibling) return null;
    return cjsAccessorCall(L, sibling, locOf(expr));
  }

/** Lowers an expression, converting a fence (PoisonError) into a null
   * DECLINE — the probing dispatch for shapes where only the lowered
   * value's type can say whether a lowering applies. unsupported() pushes
   * its diagnostic BEFORE throwing, so the probe runs behind a diagnostic
   * sink: a declined probe's diagnostics vanish (the sibling lowerings
   * own the site), a successful probe's flush through afterwards. */
  export function probeLower(L: Lowerer, node: ts.Expression): IrExpr | null {
    const saved = L.diagSink;
    const captured: typeof L.diags = [];
    L.diagSink = captured;
    let result: IrExpr | null;
    try {
      result = L.lowerExpr(node);
    } catch (e) {
      if (e instanceof PoisonError) {
        L.diagSink = saved;
        return null;
      }
      L.diagSink = saved;
      throw e;
    }
    L.diagSink = saved;
    for (const d of captured) L.pushDiag(d);
    return result;
  }

/** A read of a catch binding — the caught analog of maybeNarrow. Where
   * tsc's control-flow narrowing has proven a supported test (`instanceof`
   * over a hierarchy class, `typeof` over a primitive), the read bridges
   * with a kind-unchecked `caughtNarrow` extraction (trust-the-checker,
   * exactly like unionNarrow). Every OTHER read is the narrowness fence:
   * the binding's payload is a typed exception snapshot, not a dyn, so
   * un-narrowed uses have nothing sound to lower to. */
  export function caughtRead(L: Lowerer, node: ts.Identifier, local: IrLocal, loc: SrcLoc): IrExpr {
    const ref: IrExpr = { kind: "varRef", localId: local.id, type: CAUGHT, loc };
    const narrowed = L.mapTypeOf(L.typeOf(node));
    if (
      narrowed &&
      (narrowed.kind === "f64" || narrowed.kind === "bool" || narrowed.kind === "string")
    ) {
      return { kind: "caughtNarrow", value: ref, type: narrowed, loc };
    }
    if (narrowed?.kind === "object") {
      const info = L.classes.get(narrowed.className);
      if (info && L.inHierarchy(info)) {
        return { kind: "caughtNarrow", value: ref, type: narrowed, loc };
      }
    }
    // An UN-narrowed use — the occurrence still types `unknown` — converts
    // to a dyn value (`options.onError?.(error)` — the caught snapshot
    // flowing into an unknown slot): the typed→unknown deep-copy stance
    // extended to exception payloads. Error payloads keep their
    // observability (instanceof Error / .message / String() — the checked-dynamic tree's
    // error encoding); other object payloads are type-erased at runtime and
    // convert to the "[object Object]" approximation — SEMANTICS.md 67.
    if (narrowed?.kind === "dyn") {
      return { kind: "caughtToDyn", value: ref, type: DYN, loc };
    }
    L.unsupported("SC1063", node);
  }

/** `String(e)` / `${e}` where e is a catch binding: JS's String() over
   * the exception snapshot (scr_caught_to_string) — the one un-narrowed
   * read with a sound rendering for every payload kind. Intercepts BEFORE
   * lowerExpr like the other caught lowerings (caughtRead would fence).
   * Null when the expression isn't a catch binding. */
  export function caughtToString(L: Lowerer, node: ts.Expression): IrExpr | null {
    const local = L.caughtLocalOf(node);
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
  export function caughtLocalOf(L: Lowerer, node: ts.Expression): IrLocal | null {
    if (!ts.isIdentifier(node)) return null;
    const local = L.resolveLocal(node);
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
  export function lowerInstanceOf(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    // `x instanceof net.Socket` over a union with a netSocket arm — the
    // h2 compat 'connect' narrowing (lower-server.ts): a union tag test.
    const sockTest = lowerSocketInstanceOf(L, expr, loc);
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
    if (L.isIslandExpr(expr.right) && !L.caughtLocalOf(expr.left)) {
      const left = L.jsvalIn(L.lowerExpr(expr.left), expr.left);
      const right = L.lowerExpr(expr.right);
      return { kind: "jsOp", op: "instanceOf", args: [left, right], type: BOOL, loc };
    }
    const rhsSymbol = ts.isIdentifier(expr.right) ? L.resolveValueSymbol(expr.right) : null;
    // `x instanceof events.EventEmitter` — the namespace-member spelling
    // resolves to the same ambient class as the named import.
    const rhsMemberSymbol = (() => {
      if (!ts.isPropertyAccessExpression(expr.right) || !ts.isIdentifier(expr.right.name)) return null;
      const sym = L.checker.getSymbolAtLocation(expr.right.name);
      return sym && sym.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(sym) : (sym ?? null);
    })();
    // `x instanceof N.C` — the USER-namespace-qualified spelling: the
    // member resolves to the registered program class, with the
    // source-order guard (an init-position test above the class's block
    // would read an uninitialized member in Node).
    const rhsNsClass = (() => {
      if (!ts.isPropertyAccessExpression(expr.right)) return undefined;
      const nsMember = nsMemberIdentOf(L, expr.right);
      if (!nsMember) return undefined;
      const memberSym = L.checker.getSymbolAtLocation(nsMember);
      if (memberSym) fenceEarlyNsMemberRef(L, expr.right, memberSym);
      const classSym = L.resolveValueSymbol(nsMember);
      const nsInfo = classSym ? L.classBySymbol.get(classSym) : undefined;
      // Qualified spellings of a rebindable decorated class (import=
      // alias chains) must not fold against the declaration — the
      // decoration result decides at runtime.
      return nsInfo?.classDecorators?.valueGlobalId !== undefined ? undefined : nsInfo;
    })();
    // A rebindable decorated name as the RHS: the runtime target is the
    // decoration result — fall to the class-VALUE path below, whose
    // instanceOfValue reads the interval off the bound class object.
    const directRhs = rhsSymbol ? L.classBySymbol.get(rhsSymbol) : undefined;
    const target =
      (directRhs?.classDecorators?.valueGlobalId !== undefined ? undefined : directRhs) ??
      rhsNsClass ??
      L.builtinErrorInfoOf(rhsSymbol) ??
      L.builtinEmitterInfoOf(rhsSymbol) ??
      L.builtinEmitterInfoOf(rhsMemberSymbol) ??
      L.builtinStreamInfoOf(rhsSymbol) ??
      L.builtinStreamInfoOf(rhsMemberSymbol) ??
      undefined;
    if (!target) {
      // `u instanceof Uint8Array` on an `unknown` value: the checked-dynamic tree carries a
      // bytes kind — one runtime tag test, and tsc's narrowing types the
      // true branch (reads bridge through maybeNarrow's validated
      // extraction, like the typeof tests). Node's Buffer IS a Uint8Array
      // subclass and rides the same bytes kind, so both worlds answer true
      // for Buffer payloads — Node-exact (the bytes kind's other
      // divergences are SEMANTICS.md 45). Catch bindings stay out (their
      // payload is a typed snapshot, not a dyn).
      if (
        ts.isIdentifier(expr.right) &&
        L.isStdlibGlobal(expr.right, "Uint8Array") &&
        !L.caughtLocalOf(expr.left)
      ) {
        const left = L.lowerExpr(expr.left);
        if (left.type.kind === "dyn") {
          return { kind: "dynTest", test: "bytes", value: left, type: BOOL, loc };
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
        L.isStdlibGlobal(expr.right, "RegExp") &&
        !L.caughtLocalOf(expr.left)
      ) {
        const left = L.lowerExpr(expr.left);
        if (left.type.kind === "union") {
          const def = L.unions.get(left.type.unionId);
          const tag = def ? def.arms.findIndex((a) => a.kind === "regex") : -1;
          if (tag >= 0) {
            return { kind: "unionIsTag", unionId: left.type.unionId, tag, negated: false, value: left, type: BOOL, loc };
          }
        }
        if (left.type.kind === "regex" && left.kind === "varRef" && ts.isIdentifier(expr.left)) {
          return { kind: "boolLit", value: true, type: BOOL, loc };
        }
      }
      // `x instanceof X` where X is a class VALUE (a classval-typed
      // binding): the target is DYNAMIC — a hierarchy target reads its
      // interval from the class object at runtime (instanceOfValue); a
      // STANDALONE target class has exactly one possible runtime value
      // (itself — no descendants can flow into the slot), so the answer
      // folds statically exactly like the named-target folds below.
      const rhsClassval = L.mapTypeOf(L.typeOf(expr.right));
      if (rhsClassval?.kind === "classval" && !L.caughtLocalOf(expr.left)) {
        const targetInfo = L.classes.get(rhsClassval.className);
        if (!targetInfo) {
          // The type world names a class the lowering never registered
          // (a fenced class expression, a deferred declaration): flush
          // its diagnostics and poison the test site, never an ICE.
          L.flushDeferredClass(rhsClassval.className);
          L.unsupported(
            "SC1090",
            expr,
            "'instanceof' against a class value whose class has no lowering (the class declaration itself was rejected — see its own diagnostic)",
          );
        }
        const left = L.lowerExpr(expr.left);
        if (left.type.kind !== "object") {
          L.unsupported(
            "SC1090",
            expr,
            "'instanceof' on values other than class instances (narrow union-typed values first)",
          );
        }
        const lhsInfo = L.classes.get(left.type.className);
        if (!lhsInfo) throw new InternalCompilerError(`lowerer bug: unknown class ${left.type.className}`);
        if (L.inHierarchy(targetInfo) && L.inHierarchy(lhsInfo)) {
          const classValue = L.lowerExpr(expr.right);
          if (classValue.type.kind !== "classval") L.badType(expr.right, L.typeOf(expr.right));
          return { kind: "instanceOfValue", value: left, classValue, type: BOOL, loc };
        }
        // A standalone side: the answer is static (the target slot can
        // only hold the named class; a standalone operand's runtime class
        // IS its static class). Folding discards the operands' evaluation,
        // so only side-effect-free shapes fold — the named-target rule.
        const value =
          left.type.className === targetInfo.def.name ||
          L.isSubclassOf(left.type.className, targetInfo.def.name);
        if (left.kind === "varRef" && (ts.isIdentifier(expr.right) || expr.right.kind === ts.SyntaxKind.ThisKeyword)) {
          return { kind: "boolLit", value, type: BOOL, loc };
        }
        L.unsupported(
          "SC1090",
          expr,
          "statically-decided 'instanceof' on computed operands (bind the values to variables first)",
        );
      }
      L.unsupported(
        "SC1090",
        expr.right,
        "'instanceof' right-hand sides other than classes declared in the program",
      );
    }
    // A catch binding on the left: the runtime test against the class's
    // preorder interval (false for non-hierarchy-object payloads). tsc's
    // narrowing then types the branches; reads bridge through caughtRead.
    const caughtLocal = L.caughtLocalOf(expr.left);
    if (caughtLocal) {
      if (!L.inHierarchy(target)) {
        L.unsupported(
          "SC1090",
          expr,
          `'instanceof' on a catch binding against the standalone class '${target.def.name}' ` +
            `(only classes in extends hierarchies carry the vtable the payload test needs)`,
        );
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
    const left = L.lowerExpr(expr.left);
    // `u instanceof Error` on an `unknown` value: the checked-dynamic tree's error encoding
    // (the shape caughtToDyn builds for Error payloads — the reserved
    // "%error" marker) answers the test, so a caught Error passed through
    // an unknown slot narrows like Node (`error instanceof Error ?
    // error.message : String(error)` — the LAN-monitor handler). ROOT
    // only: the marker cannot honestly answer subclass prototype chains
    // (name strings are user-writable), so `u instanceof TypeError` keeps
    // the fence. Reads past the narrow bridge through maybeNarrow's
    // validated %Error extraction. SEMANTICS.md 67.
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
      L.unsupported(
        "SC1090",
        expr,
        `'instanceof ${target.def.name.replace(/^%/, "")}' on 'unknown' values (only the Error classes answer — test 'instanceof Error' and read '.name')`,
      );
    }
    if (left.type.kind !== "object") {
      L.unsupported(
        "SC1090",
        expr,
        "'instanceof' on values other than class instances (narrow union-typed values first)",
      );
    }
    const lhsInfo = L.classes.get(left.type.className);
    if (!lhsInfo) throw new InternalCompilerError(`lowerer bug: unknown class ${left.type.className}`);
    if (L.inHierarchy(lhsInfo) && L.inHierarchy(target)) {
      return { kind: "instanceOf", value: left, className: target.def.name, type: BOOL, loc };
    }
    const value =
      left.type.className === target.def.name ||
      L.isSubclassOf(left.type.className, target.def.name);
    if (left.kind === "varRef") {
      return { kind: "boolLit", value, type: BOOL, loc };
    }
    L.unsupported(
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
  function lowerPrivateIn(L: Lowerer, expr: ts.BinaryExpression, priv: ts.PrivateIdentifier, loc: SrcLoc): IrExpr {
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
    if (!classDecl) L.unsupported("SC1090", expr, `'${pname} in …' outside a class declaring '${pname}'`);
    if (staticBrand) {
      L.unsupported(
        "SC1090",
        expr,
        `'${pname} in …' brand checks for private STATICS (JS brands the declaring class OBJECT, not instances — compare against the class value directly)`,
      );
    }
    const info =
      L.currentClass?.decl === classDecl
        ? L.currentClass
        : (() => {
            const sym = classDecl.name ? L.checker.getSymbolAtLocation(classDecl.name) : undefined;
            return sym ? L.classBySymbol.get(sym) : undefined;
          })();
    if (!info) {
      L.unsupported(
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
      L.unsupported(
        "SC1090",
        expr,
        `'${pname} in …' inside a generic class (JS shares one brand across every instantiation; these layouts mint one class per instantiation)`,
      );
    }
    const recv = L.lowerExpr(expr.right);
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
      const arms = L.unions.get(unionId)?.arms ?? [];
      const answers: { tag: number; has: boolean }[] = [];
      let staticAnswers = arms.length > 0;
      for (const arm of arms) {
        const tag = L.armTag(unionId, arm);
        if (tag < 0 || arm.kind !== "object" || L.isSubclassOf(declName, arm.className)) {
          staticAnswers = false;
          break;
        }
        answers.push({ tag, has: arm.className === declName || L.isSubclassOf(arm.className, declName) });
      }
      if (staticAnswers) {
        const pureRecv = recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet";
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
            out = { kind: "logical", op: "||", left: out, right: isTag(t.tag, false), type: BOOL, loc };
          }
          return out;
        }
        L.unsupported(
          "SC1090",
          expr,
          `statically-decided '${pname} in …' on computed receivers (bind the value to a variable first)`,
        );
      }
    }
    if (recv.type.kind !== "object") {
      L.unsupported(
        "SC1090",
        expr,
        `'${pname} in …' on '${L.fmt(recv.type)}' receivers (only class-instance receivers — and unions of classes below or beside the declarer — have a static brand answer; narrow first)`,
      );
    }
    const lhsName = recv.type.className;
    const lhsInfo = L.classes.get(lhsName);
    if (!lhsInfo) throw new InternalCompilerError(`lowerer bug: unknown class ${lhsName}`);
    if (L.isSubclassOf(declName, lhsName)) {
      // The narrowing direction: the declarer strictly below the
      // receiver's static class — a strict subclass relation puts both in
      // a hierarchy, so the vtable interval test always exists.
      return { kind: "instanceOf", value: recv, className: declName, type: BOOL, loc };
    }
    const value = lhsName === declName || L.isSubclassOf(lhsName, declName);
    if (recv.kind === "varRef") return { kind: "boolLit", value, type: BOOL, loc };
    L.unsupported(
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
  function lowerInExpression(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    // `#name in obj` — the ergonomic brand check (ES2022) — resolves
    // before any string-key machinery: the left operand is a private
    // NAME, not a value.
    if (ts.isPrivateIdentifier(expr.left)) {
      return lowerPrivateIn(L, expr, expr.left, loc);
    }
    // Compile-time-known STRING keys fold — literals, and the same
    // const/enum-literal and template folding computed property keys get
    // (foldedStringKeyOf); runtime-valued keys keep the fence.
    // NUMERIC literal keys answer on ARRAY receivers: dense arrays hold
    // exactly the indices [0, length), so `3 in xs` is a length test (and
    // a negative/fractional literal is a constant miss — the receiver
    // still evaluates once through its own length read).
    {
      let kNode = expr.left;
      while (ts.isParenthesizedExpression(kNode)) kNode = kNode.expression;
      if (ts.isNumericLiteral(kNode) && L.mapTypeOf(L.typeOf(expr.right))?.kind === "array") {
        const recvArr = L.lowerExpr(expr.right);
        if (recvArr.type.kind === "array") {
          const len: IrExpr = { kind: "arrIntrinsic", method: "length", receiver: recvArr, args: [], type: F64, loc };
          const n = Number(kNode.text);
          if (Number.isInteger(n) && n >= 0) {
            return { kind: "bin", op: "<", left: { kind: "numLit", value: n, type: F64, loc }, right: len, type: BOOL, loc };
          }
          return { kind: "bin", op: "<", left: len, right: { kind: "numLit", value: 0, type: F64, loc }, type: BOOL, loc };
        }
      }
    }
    const key = foldedStringKeyOf(L, expr.left);
    if (key === null) {
      // A RUNTIME string key over an INDEX-SIGNATURE record receiver (the
      // `names.filter((k) => k in config)` idiom): the interned key-
      // presence helper — declared fields answer statically per name
      // (optional slots per value: the undefined arm reads absent, stance
      // 55), then the overflow map's live keys. Other receivers keep the
      // fence: fixed shapes want the literal folds above, and there is no
      // runtime key table to ask.
      const rIn = lowerRuntimeKeyIn(L, expr, loc);
      if (rIn) return rIn;
      // A runtime key over a CHECKED-DYNAMIC receiver (`name in
      // agent.sockets` — both sides computed; the checker may type the
      // receiver as a Dict while the VALUE lives in the checked-dynamic tree, so the
      // LOWERED type decides): the dyn presence answer, with the key
      // stringified like every property key (o[k] is o[String(k)] in JS;
      // `in` shares the coercion).
      {
        const probed = probeLower(L, expr.right);
        if (probed?.type.kind === "dyn") {
          let k = L.lowerExpr(expr.left); // JS order: the key evaluates first
          if (k.type.kind === "f64" || k.type.kind === "string" || k.type.kind === "dyn") {
            k = L.ensureString(k, expr.left);
            const recvD = L.lowerExpr(expr.right);
            if (recvD.type.kind === "dyn") {
              return { kind: "libCall", fn: "dyn.hasKey", args: [recvD, k], type: BOOL, loc };
            }
          }
        }
      }
      L.unsupported(
        "SC1090",
        expr.left,
        "'in' with computed (non-literal) keys (a const whose type is one string literal folds; a string-typed key answers over index-signature record receivers)",
      );
    }
    // A receiver re-read (the static folds below) is safe for plain reads
    // AND for side-effect-free expressions (an object literal of literals
    // — the `"a" in { a: true }` shape).
    const pureRecvNode = sideEffectFreeOptionValue(expr.right);
    if (L.isProcessEnv(expr.right)) {
      // `"NO_COLOR" in process.env`: presence via the one envGet intrinsic —
      // getenv(3) returning non-NULL is Node's `in` on process.env exactly.
      const envType = L.envValueType();
      if (envType.kind !== "union") throw new InternalCompilerError("lowerer bug: env value type is not a union");
      const undefTag = L.armTag(envType.unionId, UNDEFINED_T);
      const read: IrExpr = {
        kind: "libCall",
        fn: "process.envGet",
        args: [{ kind: "strLit", value: key, type: STRING, loc }],
        type: envType,
        loc,
      };
      return { kind: "unionIsTag", unionId: envType.unionId, tag: undefTag, negated: true, value: read, type: BOOL, loc };
    }
    const recv = L.lowerExpr(expr.right);
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
        if ((key === "code" || key === "message" || key === "name") &&
          (recv.kind === "varRef" || recv.kind === "caughtNarrow")) {
          return { kind: "boolLit", value: true, type: BOOL, loc };
        }
      }
      let info = L.classes.get(recv.type.className) ?? null;
      while (info && info.base) info = info.base;
      if (info?.def.name === "%Error") {
        if (key === "code") {
          const codeType = L.envValueType();
          if (codeType.kind !== "union") throw new InternalCompilerError("lowerer bug: error code type is not a union");
          const undefTag = L.armTag(codeType.unionId, UNDEFINED_T);
          const read: IrExpr = { kind: "libCall", fn: "error.code", args: [recv], type: codeType, loc };
          return { kind: "unionIsTag", unionId: codeType.unionId, tag: undefTag, negated: true, value: read, type: BOOL, loc };
        }
        if ((key === "message" || key === "name") && (recv.kind === "varRef" || recv.kind === "caughtNarrow")) {
          return { kind: "boolLit", value: true, type: BOOL, loc };
        }
        L.unsupported(
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
      const arms = L.unions.get(unionId)?.arms ?? [];
      const answers: { tag: number; has: boolean }[] = [];
      let staticAnswers = arms.length > 0;
      for (const arm of arms) {
        const tag = L.armTag(unionId, arm);
        const shape = arm.kind === "record" ? L.shapes.get(arm.shapeId) : undefined;
        if (tag < 0 || !shape || shape.tuple || shape.indexValue) {
          staticAnswers = false;
          break;
        }
        const f = shape.fields.find((x) => x.name === key);
        if (f && f.type.kind === "union" && L.armTag(f.type.unionId, UNDEFINED_T) >= 0) {
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
        const pureRecv = recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet" || pureRecvNode;
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
            out = { kind: "logical", op: "||", left: out, right: isTag(t.tag, false), type: BOOL, loc };
          }
          return out;
        }
        L.unsupported("SC1090", expr, "statically-decided 'in' on computed receivers (bind the value to a variable first)");
      }
    }
    if (recv.type.kind !== "record") {
      L.unsupported(
        "SC1090",
        expr,
        `'in' on '${L.fmt(recv.type)}' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; ${NARROW_FIRST})`,
      );
    }
    const shape = L.shapes.get(recv.type.shapeId);
    if (!shape) throw new InternalCompilerError(`lowerer bug: unknown shape ${recv.type.shapeId}`);
    const field = shape.fields.find((f) => f.name === key);
    if (field) {
      if (field.type.kind === "union" && L.armTag(field.type.unionId, UNDEFINED_T) >= 0) {
        // Optional slot: the key is present iff the arm is not undefined.
        const read: IrExpr = { kind: "recordGet", obj: recv, shapeId: recv.type.shapeId, field: key, type: field.type, loc };
        return { kind: "unionIsTag", unionId: field.type.unionId, tag: L.armTag(field.type.unionId, UNDEFINED_T), negated: true, value: read, type: BOOL, loc };
      }
      // A declared non-optional field always exists on every value of the
      // shape — statically true, but folding may only drop a
      // side-effect-free receiver read.
      if (recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet" || pureRecvNode) {
        return { kind: "boolLit", value: true, type: BOOL, loc };
      }
      L.unsupported("SC1090", expr, "statically-decided 'in' on computed receivers (bind the value to a variable first)");
    }
    // Accessor properties answer `in` as own members (Node: true, getter
    // NOT invoked) — statically true under the same purity discipline as
    // declared non-optional fields.
    if (shape.fields.some((f) => f.name === `%get:${key}` || f.name === `%set:${key}`)) {
      if (recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet" || pureRecvNode) {
        return { kind: "boolLit", value: true, type: BOOL, loc };
      }
      L.unsupported("SC1090", expr, "statically-decided 'in' on computed receivers (bind the value to a variable first)");
    }
    if (shape.indexValue) {
      L.unsupported("SC1090", expr, "'in' over index-signature keys (read the key and test '!== undefined' instead)");
    }
    if (recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet" || pureRecvNode) {
      return { kind: "boolLit", value: false, type: BOOL, loc };
    }
    L.unsupported("SC1090", expr, "statically-decided 'in' on computed receivers (bind the value to a variable first)");
  }

/** The runtime-key `in` (see lowerInExpression): `k in r` where k is a
   * runtime string and r an index-signature record — an interned
   * `%rec.haskey.<n>(k, r)` walks the declared names (a string-equality
   * chain: non-optional fields and accessor slots answer true, optional
   * slots answer their per-value tag test) and then the overflow map's
   * live keys. Null when the pair is outside that shape (the caller keeps
   * its fence). */
  function lowerRuntimeKeyIn(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    if (L.mapTypeOf(L.typeOf(expr.left))?.kind !== "string") return null;
    const recvT = L.mapTypeOf(L.typeOf(expr.right));
    if (recvT?.kind !== "record") return null;
    const shape = L.shapes.get(recvT.shapeId);
    if (!shape?.indexValue || shape.tuple) return null;
    const keyIr = L.lowerExprExpecting(expr.left, STRING);
    const recv = L.lowerExprExpecting(expr.right, recvT);
    const hkey = `haskey:${recvT.shapeId}`;
    let helper = L.widthHelpers.get(hkey);
    if (!helper) {
      helper = `%rec.haskey.${L.widthHelpers.size}`;
      L.widthHelpers.set(hkey, helper);
      const recT: IrType = { kind: "record", shapeId: recvT.shapeId };

      const k = varRef("k.0", STRING, loc);
      const r = varRef("r.0", recT, loc);
      const body: IrStmt[] = [];
      const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
      for (const f of shape.fields) {
        const accessor = f.name.startsWith("%get:") || f.name.startsWith("%set:");
        if (f.name.startsWith("%") && !accessor) continue;
        const name = accessor ? f.name.slice(5) : f.name;
        const eq: IrExpr = { kind: "strEq", negated: false, left: k, right: { kind: "strLit", value: name, type: STRING, loc }, type: BOOL, loc };
        const utag = !accessor && f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
        const answer: IrExpr =
          utag >= 0 && f.type.kind === "union"
            ? {
                kind: "unionIsTag",
                unionId: f.type.unionId,
                tag: utag,
                negated: true,
                value: { kind: "recordGet", obj: r, shapeId: recvT.shapeId, field: f.name, type: f.type, loc },
                type: BOOL,
                loc,
              }
            : { kind: "boolLit", value: true, type: BOOL, loc };
        body.push({ kind: "if", cond: eq, then: [ret(answer)], else_: null, loc });
      }
      const ksT = arrayOf(STRING);
      body.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: r, shapeId: recvT.shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: varRef("i.0", F64, loc),
            right: { kind: "arrIntrinsic", method: "length", receiver: varRef("ks.0", ksT, loc), args: [], type: F64, loc },
            type: BOOL,
            loc,
          },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: varRef("i.0", F64, loc), right: numLit(1, loc), type: F64, loc }, loc },
          body: [
            {
              kind: "if",
              cond: { kind: "strEq", negated: false, left: k, right: { kind: "arrayGet", arr: varRef("ks.0", ksT, loc), index: varRef("i.0", F64, loc), type: STRING, loc }, type: BOOL, loc },
              then: [ret({ kind: "boolLit", value: true, type: BOOL, loc })],
              else_: null,
              loc,
            },
          ],
          loc,
        },
        ret({ kind: "boolLit", value: false, type: BOOL, loc }),
      );
      L.liftedFns.push({
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

/** A regex literal `/ab+c/gi` → regexLit (interned per (pattern, flags)
   * by the backend). The TS parser has already syntax-checked the literal;
   * what remains here is the flag-alphabet fence (d and v are
   * declared-valid TS flags outside this slice). Named capture groups
   * `(?<name>...)` and `\k<name>` backreferences compile — libregexp
   * executes them natively, replace templates resolve `$<name>` at
   * runtime, and `.groups` reads desugar at their access sites
   * (matchResultNamedGroupsOf). The engine validates the pattern itself
   * lazily at first use (SEMANTICS.md documents the divergence from
   * Node's parse-time SyntaxError). */
  export function lowerRegexLiteral(L: Lowerer, expr: ts.RegularExpressionLiteral): IrExpr {
    const text = expr.text;
    const lastSlash = text.lastIndexOf("/");
    const pattern = text.slice(1, lastSlash);
    const flags = text.slice(lastSlash + 1);
    for (const f of flags) {
      if (!"gimsuy".includes(f)) {
        L.unsupported(
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
  function staticRegexPatternOf(L: Lowerer, e: ts.Expression): string | null {
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
      L.isStdlibGlobal(expr.expression, "RegExp") &&
      expr.arguments !== undefined &&
      expr.arguments.length >= 1 &&
      (ts.isStringLiteral(expr.arguments[0]!) || ts.isNoSubstitutionTemplateLiteral(expr.arguments[0]!))
    ) {
      return (expr.arguments[0] as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
    }
    if (ts.isIdentifier(expr)) {
      const init = constInitializerOf(L, expr);
      if (init !== null) return staticRegexPatternOf(L, init);
    }
    return null;
  }

/** The initializer behind a CONST identifier binding (a plain
   * VariableDeclaration under a const list) — the one-hop provenance step
   * the regex traces walk. Null for let/var (reassignable), params,
   * destructured bindings, and unresolvable names. */
  function constInitializerOf(L: Lowerer, ident: ts.Identifier): ts.Expression | null {
    const sym = L.resolveValueSymbol(ident);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
    if (!ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0) return null;
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
  export function matchResultNamedGroupsOf(L: Lowerer, e: ts.Expression): { name: string; index: number }[] | null {
    const reExpr = matchProducerRegexOf(L, e);
    if (reExpr === null) return null;
    const pattern = staticRegexPatternOf(L, reExpr);
    if (pattern === null) return null;
    return namedCaptureGroupsOfPattern(pattern);
  }

/** The regex EXPRESSION whose match produced `e` (see
   * matchResultNamedGroupsOf for the traced shapes). */
  function matchProducerRegexOf(L: Lowerer, e: ts.Expression): ts.Expression | null {
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
    // or its nullable spelling for match — the claim lower-containers
    // makes), so a user method that happens to be named `match` with a
    // regex argument never traces.
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      const name = expr.expression.name.text;
      const recvT = L.mapTypeOf(L.typeOf(expr.expression.expression));
      if (name === "exec" && expr.arguments.length === 1 && recvT?.kind === "regex") {
        return expr.expression.expression;
      }
      if (name === "match" && expr.arguments.length === 1 &&
          (recvT?.kind === "string" || (recvT !== null && recvT !== undefined && nullableStringType(L, recvT))) &&
          L.mapTypeOf(L.typeOf(expr.arguments[0]!))?.kind === "regex") {
        return expr.arguments[0]!;
      }
    }
    // A matchAll ROW by element access: rows[i] with rows tracing to the
    // drain call — or the direct s.matchAll(re)[i] spelling.
    if (ts.isElementAccessExpression(expr)) {
      return matchAllRegexOf(L, expr.expression);
    }
    if (ts.isIdentifier(expr)) {
      // The for-of binding over a matchAll drain: `for (const m of
      // s.matchAll(re))` (or over a stored const rows).
      const sym = L.resolveValueSymbol(expr);
      const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
      if (
        decl !== undefined && ts.isVariableDeclaration(decl) &&
        ts.isVariableDeclarationList(decl.parent) && ts.isForOfStatement(decl.parent.parent)
      ) {
        return matchAllRegexOf(L, decl.parent.parent.expression);
      }
      // A stored const match result: `const m = re.exec(s)`.
      const init = constInitializerOf(L, expr);
      if (init !== null) return matchProducerRegexOf(L, init);
    }
    return null;
  }

/** The regex argument of a (possibly const-stored) `s.matchAll(re)`. */
  function matchAllRegexOf(L: Lowerer, e: ts.Expression): ts.Expression | null {
    let expr = e;
    for (;;) {
      if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
        expr = expr.expression;
        continue;
      }
      break;
    }
    if (
      ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "matchAll" && expr.arguments.length === 1 &&
      L.mapTypeOf(L.typeOf(expr.expression.expression))?.kind === "string" &&
      L.mapTypeOf(L.typeOf(expr.arguments[0]!))?.kind === "regex"
    ) {
      return expr.arguments[0]!;
    }
    // The eager-spread spelling: `[...s.matchAll(re)]`.
    if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 1) {
      const only = expr.elements[0]!;
      if (ts.isSpreadElement(only)) return matchAllRegexOf(L, only.expression);
    }
    if (ts.isIdentifier(expr)) {
      const init = constInitializerOf(L, expr);
      if (init !== null) return matchAllRegexOf(L, init);
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
   *   - every declared name is a key (nonparticipating groups hold "" —
   *     divergence 51's rule, exactly the slice elements they project);
   *   - ES2025 duplicate names (distinct alternatives) project the first
   *     participating occurrence: at most one participates, and a
   *     participating-empty "" falls through to slots that are "" anyway;
   *   - key order is group declaration order (declaredOrder), Node's own.
   * The record has no prototype — Node's groups object is null-prototype,
   * observable only through util.inspect's "[Object: null prototype]"
   * prefix (the Object.groupBy stance, ledgered). Null when the receiver
   * isn't a match slice or the regex isn't traceable — the caller's
   * member fence (with the groups hint) names the gap. */
  function lowerMatchGroupsRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.name.text !== "groups" || expr.questionDotToken !== undefined) return null;
    const loc = locOf(expr);
    const strArr = arrayOf(STRING);
    const recvT = L.mapTypeOf(L.typeOf(expr.expression));
    if (!recvT || !isMatchSliceType(L, recvT) || !L.isStdlibMember(expr)) return null;
    const groups = matchResultNamedGroupsOf(L, expr.expression);
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
    const recv = L.lowerExpr(expr.expression);
    if (!isMatchSliceType(L, recv.type)) return null;
    return lowerGroupsProjection(L, recv, groups, loc);
  }

/** True when the IR type is a string-or-units union — the Dict<string>
   * member spelling (`process.versions.openssl`), match's nullable
   * receiver claim. */
  function nullableStringType(L: Lowerer, t: IrType): boolean {
    if (t.kind !== "union") return false;
    const arms = L.unions.get(t.unionId)?.arms ?? [];
    return arms.some((a) => a.kind === "string") && arms.every((a) => a.kind === "string" || isUnitType(a));
  }

/** True when the IR type is the honest match slice — `string[]`, or a
   * union of it with unit arms only (`string[] | null`). The groups
   * projection's receiver gate, shared with the destructure interception. */
  export function isMatchSliceType(L: Lowerer, t: IrType): boolean {
    if (typeEquals(t, arrayOf(STRING))) return true;
    return t.kind === "union" && matchSliceUnionArms(L, t.unionId) !== null;
  }

/** The union-arm layout of a nullable match slice (`string[] | null`,
   * matchAll's checker spellings with undefined arms included): the
   * string[] arm's tag plus each unit arm's tag and spelling. Null when
   * the union holds anything else. */
  function matchSliceUnionArms(
    L: Lowerer,
    unionId: string,
  ): { arrTag: number; units: { tag: number; unit: "null" | "undefined" }[] } | null {
    const def = L.unions.get(unionId);
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

/** The groups-record projection call: the result is the CHECKER'S OWN
   * shape — `{ [key: string]: string }`, the hybrid index-signature
   * record with no declared fields — holding one OVERFLOW entry per
   * group name in declaration order, so every downstream consumer
   * (recordKeyGet reads, Object.keys, JSON, the `| undefined` union
   * wrap) meets exactly the type tsc reported. One lifted helper per
   * (index list, receiver representation) builds it; see
   * lowerMatchGroupsRead for the semantics the body encodes. */
  export function lowerGroupsProjection(
    L: Lowerer,
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
    const shapeId = L.shapes.intern([], false, STRING);
    const recordT: IrType = { kind: "record", shapeId };
    const recvKey = recv.type.kind === "union" ? recv.type.unionId : "arr";
    const key = `regexgroups:${shapeId}:${groups.map((g) => `${g.name}=${g.index}`).join(",")}:${recvKey}`;
    let helper = L.widthHelpers.get(key);
    if (!helper) {
      helper = `%regex.groups.${L.widthHelpers.size}`;
      L.widthHelpers.set(key, helper);
      const body: IrStmt[] = [];
      const locals: IrLocal[] = [{ id: "m.0", name: "m", type: recv.type, mutable: true }];
      let mRef: IrExpr = { kind: "varRef", localId: "m.0", type: recv.type, loc };
      if (recv.type.kind === "union") {
        // Node's exact TypeError per unit arm, then the checked narrow.
        const arms = matchSliceUnionArms(L, recv.type.unionId)!;
        for (const u of arms.units) {
          body.push({
            kind: "if",
            cond: { kind: "unionIsTag", unionId: recv.type.unionId, tag: u.tag, negated: false, value: mRef, type: BOOL, loc },
            then: [
              {
                kind: "throw",
                value: {
                  kind: "libCall",
                  fn: "error.new",
                  args: [
                    { kind: "strLit", value: `Cannot read properties of ${u.unit} (reading 'groups')`, type: STRING, loc },
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
        const narrowed: IrExpr = { kind: "unionNarrow", unionId: recv.type.unionId, tag: arms.arrTag, value: mRef, type: arrayOf(STRING), loc };
        locals.push({ id: "arr.0", name: "arr", type: arrayOf(STRING), mutable: false });
        body.push({ kind: "varDecl", localId: "arr.0", init: narrowed, loc });
        mRef = { kind: "varRef", localId: "arr.0", type: arrayOf(STRING), loc };
      }

      const elem = (index: number): IrExpr => ({ kind: "arrayGet", arr: mRef, index: numLit(index, loc), type: STRING, loc });
      const values = new Map<string, IrExpr>();
      order.forEach((name, i) => {
        const idxs = indicesByName.get(name)!;
        if (idxs.length === 1) {
          values.set(name, elem(idxs[0]!));
          return;
        }
        // Duplicates: the first non-"" occurrence (at most one
        // participates; all-"" answers "" like any nonparticipating slot).
        const id = `g${i}.0`;
        locals.push({ id, name: `g${i}`, type: STRING, mutable: true });
        body.push({ kind: "varDecl", localId: id, init: elem(idxs[0]!), loc });
        const gRef: IrExpr = { kind: "varRef", localId: id, type: STRING, loc };
        for (const idx of idxs.slice(1)) {
          body.push({
            kind: "if",
            cond: { kind: "strEq", negated: false, left: gRef, right: { kind: "strLit", value: "", type: STRING, loc }, type: BOOL, loc },
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
      L.liftedFns.push({
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

/** Field read `obj.f` on class-instance and record receivers, through the
   * shared FieldTarget union (fieldGet / recordGet). Bound method references
   * on classes are rejected specifically; func-typed record fields are
   * ordinary closure values, so bare references to them work (unlike class
   * methods, which have no bound-value form). */
  export function lowerFieldRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    const target = L.fieldTarget(expr);
    if (target) return L.fieldGetExpr(target, locOf(expr), expr);
    if (expr.questionDotToken) return null;
    let receiverIr = L.mapTypeOf(L.typeOf(expr.expression));
    // The readonly-tuple Array.isArray narrow has no directly mappable
    // checker type (`Result & any[]`), but maybeNarrow extracted the tuple
    // record behind it. Route tuple properties such as `.length` from that
    // lowered value, the element-access bridge's twin.
    const checkerArray = L.checkerArrayValue(expr.expression);
    if (checkerArray?.type.kind === "record") receiverIr = checkerArray.type;
    if (
      receiverIr?.kind === "object" &&
      (L.findMethodOn(L.classes.get(receiverIr.className) ?? null, expr.name.text) ||
        findGenericMethodOn(L, L.classes.get(receiverIr.className) ?? null, expr.name.text))
    ) {
      L.unsupported("SC1090", expr, `bound method references (call '${expr.name.text}' directly)`);
    }
    // An object-literal GENERIC method as a VALUE (`o.m` — the member is
    // excluded from the record shape): the pinned-value rule verbatim when
    // the receiver is the defining literal's own const binding (the value
    // is the pinned instance's closure — no `this` exists); anything else
    // fences by name inside the helpers.
    {
      const propSym = L.checker.getPropertyOfType(L.typeOf(expr.expression), expr.name.text);
      if (
        receiverIr?.kind !== "object" && propSym &&
        isGenericCallableMemberType(L.checker.getTypeOfSymbol(propSym), L.checker) &&
        // CLASS members keep the class-path fences (a poisoned class's own
        // diagnostics, the bound-method fence above).
        !L.checker.declarationsOf(propSym).some(
          (d) => d.parent !== undefined && (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)),
        )
      ) {
        const found = objLitGenericFnNodeOf(L, propSym);
        if (!found) {
          L.unsupported(
            "SC1090",
            expr,
            `the generic method '${expr.name.text}' as a value with no defining object literal (only methods declared with a body in an object literal compile)`,
          );
        }
        requireObjLitGenericReceiver(L, expr, expr.expression, found.literal, expr.name.text);
        return L.lowerGenericFnValue(expr, objLitGenericFnInfoOf(L, expr, expr.name.text, found));
      }
    }
    // Dot access to an UNDECLARED key of an index-signature shape
    // (`bag.count` on `Record<string, number>`): tsc allows it without
    // noPropertyAccessFromIndexSignature, but the bracket spelling is the
    // canonical index-signature form here — point at it.
    if (receiverIr?.kind === "record") {
      const shape = L.shapes.get(receiverIr.shapeId);
      if (shape?.indexValue && !shape.fields.some((f) => f.name === expr.name.text)) {
        L.unsupported(
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
      const shape = L.shapes.get(receiverIr.shapeId);
      if (shape?.tuple) {
        let root: ts.Expression = expr.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (!ts.isIdentifier(root) && root.kind !== ts.SyntaxKind.ThisKeyword) {
          L.unsupported(
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
  export function lowerUnionProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(expr.expression));
    if (receiverIr?.kind !== "union") return null;
    // Lower the receiver FIRST and read its actual IR union: a partially
    // narrowed receiver (checker type = a SUB-union of the binding's union)
    // stays the full union at runtime, and the tag switch must cover the
    // full union's arms.
    const value = L.lowerExpr(expr.expression);
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
      const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
      return { kind: "dynKeyGet", key, value, type: DYN, loc: locOf(expr) };
    }
    if (value.type.kind === "record") {
      const shape = L.shapes.get(value.type.shapeId);
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
      throw new InternalCompilerError("lowerer bug: union-typed receiver lowered to a non-union");
    }
    const def = L.unions.get(value.type.unionId);
    if (!def) throw new InternalCompilerError(`lowerer bug: unknown union ${value.type.unionId}`);
    const field = expr.name.text;
    let common: IrType | null = null;
    for (const arm of def.arms) {
      let ft: IrType | undefined;
      if (arm.kind === "record") {
        ft = L.shapes.get(arm.shapeId)?.fields.find((f) => f.name === field)?.type;
      } else if (arm.kind === "object") {
        ft = L.classes.get(arm.className)?.fields.get(field);
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
    const keyed = lowerUnionKeyedRead(L, expr, value.type.unionId, value, key, field);
    if (keyed) return keyed;
    L.unsupported(
      "SC1090",
      expr,
      `reading '${field}' on a union-typed value (every arm must be an object/record ` +
        `with a same-typed field '${field}'; ` +
        `${NARROW_FIRST})`,
    );
  }

/** The unionDisc generalization: a keyed read on a union receiver whose
   * arms answer DIFFERENT (but joinable) types. Each arm contributes its
   * declared answer — a declared field's type (literal keys), an
   * index-signature arm's value type (plus its declared fields' types for
   * runtime keys, which reach them through the keyed-read helper), and
   * UNDEFINED for unit arms (reachable only through optional-chain tails,
   * where JS short-circuits to undefined; a unit arm the checker narrowed
   * away is simply unreachable). The result type is the JOIN of those
   * answers; every arm's answer must be the join itself or one of its
   * arms (sub-union RE-TAGGING between distinct unions stays fenced).
   * Returns null when any arm cannot answer — the caller owns the fence
   * message. The caller (the property/element dispatch) maybeNarrows. */
  function lowerUnionKeyedRead(L: Lowerer, expr: ts.Expression,
    unionId: string,
    value: IrExpr,
    key: IrExpr,
    literalField: string | null,): IrExpr | null {
    const def = L.unions.get(unionId);
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
        const inner = L.unions.get(t.unionId);
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
      if (arm.kind !== "record") return null;
      const shape = L.shapes.get(arm.shapeId);
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
    // admit (no map/dyn/jsval/generator arms; func arms only beside
    // func/unit siblings — unionFuncSetArmsOk, the validator's rule). A
    // join mixing, say, a func answer with data answers has no union to
    // surface as; the caller owns the fence message.
    if (
      joinArms.length > 1 &&
      (!unionFuncSetArmsOk(joinArms) ||
        joinArms.some((a) => a.kind === "map" || a.kind === "dyn" || a.kind === "jsval" || a.kind === "generator" || a.kind === "caught"))
    ) {
      return null;
    }
    joinArms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    const type: IrType =
      joinArms.length === 1 ? joinArms[0]! : { kind: "union", unionId: L.unions.intern(joinArms) };
    // Pass 2: every arm's answer must SURFACE as the join, and index arms
    // must pass the single-record keyed-read constraints (the helper is
    // shared with recordKeyGet, its missing-key policy included).
    const surfaces = (t: IrType): boolean =>
      typeEquals(t, type) || (type.kind === "union" && L.armTag(type.unionId, t) >= 0);
    for (const arm of def.arms) {
      if (isUnitType(arm)) {
        if (!(type.kind === "union" && L.armTag(type.unionId, UNDEFINED_T) >= 0)) return null;
        continue;
      }
      if (arm.kind !== "record") return null;
      const shape = L.shapes.get(arm.shapeId);
      if (!shape) return null;
      const declared =
        literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
      if (declared) {
        if (!surfaces(declared)) return null;
        continue;
      }
      const ovfShape = literalField !== null && shape.indexValue ? { ...shape, fields: [] } : shape;
      if (!recordKeyResultOk(L, ovfShape, type)) return null;
    }
    return { kind: "unionKeyGet", unionId, key, value, type, loc: locOf(expr) };
  }

/** Recognizes `obj.field` as an assignable field target: receiver is a
   * known class instance OR a record, and the member is a field or (class
   * receivers) a declared accessor property. Returns the pieces of a
   * fieldSet/recordSet/accessor-call (minus value/kind) or null. */
  export function fieldTarget(L: Lowerer, access: ts.PropertyAccessExpression): FieldTarget | null {
    if (L.chainBlocked(access)) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverIr?.kind === "object") {
      const info = L.classes.get(receiverIr.className);
      if (!info) {
        // A receiver typed as a class whose collection deferred: the
        // deferred diagnostics are what explains the miss.
        L.flushDeferredClass(receiverIr.className);
        return null;
      }
      const fieldType = info.fields.get(access.name.text);
      if (fieldType) {
        const obj = L.lowerExpr(access.expression);
        return { container: "class", obj, className: receiverIr.className, field: access.name.text, fieldType };
      }
      // Accessor property: either half declared anywhere on the chain
      // makes the name an accessor target (fields and accessors share a
      // namespace — tsc rejects mixing them, so the halves agree on kind).
      const getF = L.findMethodOn(info, `get:${access.name.text}`);
      const setF = L.findMethodOn(info, `set:${access.name.text}`);
      if (getF || setF) {
        const obj = L.lowerExpr(access.expression);
        return {
          container: "accessor",
          obj,
          className: receiverIr.className,
          field: access.name.text,
          fieldType: getF ? getF.sig.ret : setF!.sig.params[0]!.type,
        };
      }
      return null;
    }
    if (receiverIr?.kind === "record") {
      const shape = L.shapes.get(receiverIr.shapeId);
      const fieldType = shape?.fields.find((f) => f.name === access.name.text)?.type;
      if (fieldType) {
        const obj = L.lowerExpr(access.expression);
        // A checker-record receiver whose VALUE stayed dyn (the erased
        // all-unknown-fields cast — `(err as { code?: unknown }).code`):
        // decline, and the dyn keyed-read fallback answers.
        if (obj.type.kind !== "record") return null;
        return { container: "record", obj, shapeId: receiverIr.shapeId, field: access.name.text, fieldType };
      }
      // A RECORD accessor property: either slot present makes the name an
      // accessor target (get/set share the property namespace — tsc
      // rejects mixing an accessor with a data property, so the halves
      // agree). Reads dispatch the %get: closure, writes the %set: one.
      {
        const getSlot = shape?.fields.find((f) => f.name === `%get:${access.name.text}`)?.type;
        const setSlot = shape?.fields.find((f) => f.name === `%set:${access.name.text}`)?.type;
        if (getSlot?.kind === "func" || setSlot?.kind === "func") {
          const obj = L.lowerExpr(access.expression);
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
      const nameSym = L.checker.getSymbolAtLocation(access.name);
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
          const nameDecls = L.checker.declarationsOf(nameSym);
          if (!nameDecls.length) return false;
          if (!nameDecls.every((d) => ts.isPropertySignature(d))) return false;
          const declared = L.mapTypeOf(L.typeOf(access));
          if (!declared) return false;
          const iv = shape.indexValue!;
          if (typeEquals(declared, iv)) return true;
          if (iv.kind !== "union") return false;
          const ivArms = L.unions.get(iv.unionId)?.arms;
          if (!ivArms) return false;
          const declaredArms =
            declared.kind === "union" ? (L.unions.get(declared.unionId)?.arms ?? [declared]) : [declared];
          return declaredArms.every((a) => ivArms.some((b) => typeEquals(a, b)));
        };
        if (!nameSym || nameSym.name === ts.InternalSymbolName.Index || canonicalized()) {
          const obj = L.lowerExpr(access.expression);
          return { container: "recordOvf", obj, shapeId: receiverIr.shapeId, field: access.name.text, fieldType: shape.indexValue };
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
  export function uniqueSymbolKeyOf(L: Lowerer, key: ts.Expression): { sym: ts.Symbol; fieldName: string } | null {
    if (!ts.isIdentifier(key)) return null;
    const t = L.typeOf(key);
    // tsgo WIDENS a unique-symbol const's type to plain `symbol` through a
    // CJS require alias (5.9.3 kept `unique symbol` — the finding-5
    // family), so plain symbol passes this early filter too: every
    // correctness-bearing check is the DECLARATION-shape battery below
    // (module-level const initialized by a literal-description Symbol()),
    // which a runtime-identity symbol value can never satisfy.
    if (!(t.flags & (ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.ESSymbol))) return null;
    const sym = L.resolveValueSymbol(key);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (!sym || !decl || !ts.isVariableDeclaration(decl)) return null;
    if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
    // Module level only: a unique-symbol const inside a FUNCTION is a
    // fresh runtime identity per call — one static slot would conflate
    // what JS keeps distinct.
    if (!ts.isVariableStatement(decl.parent.parent) || !ts.isSourceFile(decl.parent.parent.parent)) return null;
    const init = decl.initializer;
    if (!init || !ts.isCallExpression(init) || init.questionDotToken) return null;
    if (!ts.isIdentifier(init.expression) || init.expression.text !== "Symbol") return null;
    if (!L.isStdlibSymbol(L.checker.getSymbolAtLocation(init.expression))) return null;
    const arg = init.arguments.length === 0 ? null : init.arguments.length === 1 ? init.arguments[0]! : undefined;
    if (arg === undefined) return null;
    if (arg !== null && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null;
    // Symbol() and Symbol('') both print `Symbol()` — Node's toString.
    return { sym, fieldName: `Symbol(${arg?.text ?? ""})` };
  }

/** The declared symbol-keyed field (class name / layout field / type)
   * `expr` resolves to, WITHOUT lowering the receiver — the routing test
   * for the wiring sites (statement dispatch must not emit anything when
   * it declines). Null off class receivers, for non-static keys, and for
   * keys no class on the chain declares. */
  export function symbolFieldInfo(L: Lowerer, expr: ts.ElementAccessExpression,): { className: string; field: string; fieldType: IrType } | null {
    if (L.chainBlocked(expr)) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(expr.expression));
    if (receiverIr?.kind !== "object") return null;
    const info = L.classes.get(receiverIr.className);
    if (!info) {
      L.flushDeferredClass(receiverIr.className);
      return null;
    }
    const key = uniqueSymbolKeyOf(L, expr.argumentExpression);
    if (!key) return null;
    const field = info.symbolFields?.get(key.sym);
    if (field === undefined) return null;
    const fieldType = info.fields.get(field);
    if (!fieldType) return null;
    return { className: receiverIr.className, field, fieldType };
  }

/** `obj[k]` as an assignable field target — the symbol-keyed twin of
   * fieldTarget's class branch (the receiver lowers here, exactly once). */
  function symbolFieldTarget(L: Lowerer, expr: ts.ElementAccessExpression): FieldTarget | null {
    const info = symbolFieldInfo(L, expr);
    if (!info) return null;
    const obj = L.lowerExpr(expr.expression);
    return { container: "class", obj, className: info.className, field: info.field, fieldType: info.fieldType };
  }

/** The read expression for a field target (fieldGet / recordGet /
   * getter call). `blame` locates the rejection of a setter-only read —
   * tsc-clean (the property types as the setter's param), but Node yields
   * undefined, which these property types cannot represent. */
  export function fieldGetExpr(L: Lowerer, target: FieldTarget, loc: SrcLoc, blame: ts.Node): IrExpr {
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
      const getF = L.findMethodOn(L.classes.get(target.className) ?? null, `get:${target.field}`);
      if (!getF) {
        L.unsupported(
          "SC1090",
          blame,
          `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
        );
      }
      return L.accessorCall(target.className, `get:${target.field}`, target.obj, [], getF.sig.ret, loc);
    }
    // Record accessor properties: the read IS a call of the %get: closure
    // — once per read, side effects and all (JS's evaluation). The
    // setter-only read keeps the class-path fence: the property types as
    // the setter's param where Node yields undefined.
    if (target.container === "recordAccessor") {
      if (!target.getType) {
        L.unsupported(
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
      let t: IrType = target.fieldType;
      if (L.program.getCompilerOptions().noUncheckedIndexedAccess) {
        const armed = L.withUndefinedArmOf(t);
        if (!armed) L.badType(blame, L.typeOf(blame));
        t = armed;
      }
      return {
        kind: "recordKeyGet",
        obj: target.obj,
        shapeId: target.shapeId,
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        overflowOnly: true,
        type: t,
        loc,
      };
    }
    if (target.container === "class") {
      const read: IrExpr = { kind: "fieldGet", obj: target.obj, className: target.className, field: target.field, type: target.fieldType, loc };
      // DEFERRED-INIT fields (`stream!: T` assigned past the constructor's
      // top level — ClassInfo.deferredInitFields): the SLOT is the
      // undefined-armed union; the read CHECKED-extracts the declared type
      // — a genuinely unassigned read throws the catchable TypeError
      // where Node reads an undefined the declared type cannot hold.
      if (
        L.classes.get(target.className)?.deferredInitFields?.has(target.field) === true &&
        target.fieldType.kind === "union"
      ) {
        const inner = L.stripUndefinedArm(target.fieldType);
        const helper = L.deferredReadHelper(target.fieldType.unionId, inner, loc);
        if (helper) return { kind: "call", callee: helper, args: [read], type: inner, loc };
      }
      return read;
    }
    return { kind: "recordGet", obj: target.obj, shapeId: target.shapeId, field: target.field, type: target.fieldType, loc };
  }

/** The write statement for a field target (fieldSet / recordSet / setter
   * call). A write to a getter-only property never gets here in a clean
   * program (tsc's TS2540 is the fence); the rejection is the backstop. */
  export function fieldSetStmt(L: Lowerer, target: FieldTarget, value: IrExpr, loc: SrcLoc, blame: ts.Node): IrStmt {
    // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree:
    // the checked-dynamic keyed write — dyn.keySet (later writes win,
    // insertion order; Node's TypeErrors on non-object receivers), the
    // value converting into the checked-dynamic tree.
    if (
      (target.container === "record" || target.container === "recordOvf") &&
      target.obj.type.kind === "dyn"
    ) {
      const v = L.coerceToExpected(value, DYN);
      if (v.type.kind !== "dyn") {
        L.unsupported(
          "SC1101",
          blame,
          `storing '${L.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
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
      const setF = L.findMethodOn(L.classes.get(target.className) ?? null, `set:${target.field}`);
      if (!setF) L.unsupported("SC1090", blame, `assignment to the getter-only property '${target.field}'`);
      return {
        kind: "exprStmt",
        expr: L.accessorCall(target.className, `set:${target.field}`, target.obj, [value], VOID, loc),
        loc,
      };
    }
    // Record accessor properties: the write calls the %set: closure with
    // the coerced value. A getter-only write never gets here in a clean
    // program (tsc's TS2540); the rejection is the backstop.
    if (target.container === "recordAccessor") {
      if (!target.setType) {
        L.unsupported("SC1090", blame, `assignment to the getter-only property '${target.field}'`);
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
      ? { kind: "fieldSet", obj: target.obj, className: target.className, field: target.field, value, loc }
      : { kind: "recordSet", obj: target.obj, shapeId: target.shapeId, field: target.field, value, loc };
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
  export function lowerPromiseRejectCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    if (L.stdlibGlobalMember(access, "Promise") !== "reject") return null;
    const loc = locOf(call);
    if (call.arguments.length !== 1) {
      L.noLowering(
        "Promise.reject with this argument count",
        call,
        "one Error reason is the supported form: Promise.reject(new Error(...))",
      );
    }
    const ctxT = L.checker.getContextualType(call);
    const type = ctxT ? L.mapTypeOf(ctxT) : null;
    const reasonNode = call.arguments[0]!;
    // A CHECKED-DYNAMIC reason (`Promise.reject(value)` where value rode
    // an untyped binding — the tracingChannel suite's shape): the checked-dynamic tree
    // value IS the rejection payload (the thrown-dyn representation, so
    // identity survives to catch/unhandledRejection observers), and the
    // result is promise<dyn> when no context names a concrete one.
    const reason = L.lowerExpr(reasonNode);
    if (reason.type.kind === "dyn") {
      // The result only ever REJECTS, so the inner type is unobservable:
      // adopt the context's promise type when one names it, else the
      // checker's own Promise<never> reading (promise<void> — exactly the
      // Error-reason form below).
      const resultT: IrType =
        type?.kind === "promise" ? type : { kind: "promise", inner: VOID };
      return { kind: "intrinsic", name: "promise.reject", args: [reason], type: resultT, loc };
    }
    // An Error reason with NO context-named promise type (a bare
    // top-level `Promise.reject(new Error())` — the unhandled-rejection
    // suite's shape): the result only ever rejects, so the checker's own
    // Promise<never> reading (promise<void>) is the honest type.
    const resultType: IrType =
      type?.kind === "promise" ? type : { kind: "promise", inner: VOID };
    if (type?.kind !== "promise" && !errorRootedObjectOf(L, L.typeOf(reasonNode))) {
      L.noLowering(
        "Promise.reject outside a position that names a concrete promise type",
        call,
        "the checker types the call Promise<never> — a declared return type or an " +
          "annotation (const p: Promise<T> = Promise.reject(...)) names the result",
      );
    }
    if (!errorRootedObjectOf(L, L.typeOf(reasonNode))) {
      L.unsupported(
        "SC1090",
        reasonNode,
        `Promise.reject reasons of type '${L.checker.typeToString(L.typeOf(reasonNode))}' ` +
          "(rejection payloads share the thrown-Error representation: pass an Error instance)",
      );
    }
    if (reason.type.kind !== "object") L.badType(reasonNode, L.typeOf(reasonNode));
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
  export function lowerPromiseAllTupleCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    if (L.stdlibGlobalMember(access, "Promise") !== "all") return null;
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
    const mapped = argNode.elements.map((el) => L.mapTypeOf(L.typeOf(el)));
    const first = mapped[0];
    if (first?.kind !== "promise") return null;
    if (!mapped.every((m) => m?.kind === "promise" && typeEquals(m.inner, first.inner))) {
      return null;
    }
    const loc = locOf(call);
    const inner = first.inner;
    const entryT: IrType = { kind: "promise", inner };
    const elems = argNode.elements.map((el) => L.lowerExpr(el));
    const entries: IrExpr = { kind: "arrayLit", elems, type: arrayOf(entryT), loc };
    const type: IrType =
      inner.kind === "void"
        ? { kind: "promise", inner: VOID }
        : { kind: "promise", inner: arrayOf(inner) };
    return { kind: "intrinsic", name: "promise.all", args: [entries], type, loc };
  }

/** `obj.f op= e` (and `obj.f++` with rhs null ≡ 1) — the element spelling
   * `obj[k] op= e` included when k is a declared symbol-keyed field.
   * Restricted to side-effect-free receivers (identifier or `this`)
   * because the desugar evaluates the receiver twice. */
  export function lowerFieldCompound(L: Lowerer, access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    op: CompoundOp,
    rhsNode: ts.Expression | null,
    loc: SrcLoc,): IrStmt {
    if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
      L.unsupported("SC1090", access, "compound assignment through 'super' (read and write separately)");
    }
    if (!ts.isIdentifier(access.expression) && access.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      L.unsupported("SC1090", access, "compound assignment to fields of computed receivers");
    }
    // A CHECKED-DYNAMIC receiver (`context.actual++` — test/common's call
    // accounting; dot spelling only — symbol-keyed element targets are
    // static fields): read the member (dynKeyGet), VALIDATE it as a
    // number (dynCheck — a non-number member throws the catchable
    // TypeError where JS would ToNumber-coerce; loud, never a silent
    // NaN — SEMANTICS.md), combine, write back (dyn.keySet). The
    // receiver is an identifier (checked above), so evaluating it for
    // read and write matches JS's once-evaluation observably.
    if (ts.isPropertyAccessExpression(access)) {
      const probed = probeLower(L, access.expression);
      if (probed?.type.kind === "dyn") {
        const key: IrExpr = { kind: "strLit", value: access.name.text, type: STRING, loc: locOf(access.name) };
        const read: IrExpr = { kind: "dynKeyGet", key, value: probed, type: DYN, loc };
        const cur: IrExpr = { kind: "dynCheck", value: read, type: F64, loc };
        const rhs: IrExpr = rhsNode
          ? L.lowerExpr(rhsNode)
          : { kind: "numLit", value: 1, type: F64, loc };
        if (rhs.type.kind !== "f64") L.unsupported("SC1043", access);
        const value: IrExpr = { kind: "bin", op, left: cur, right: rhs, type: F64, loc };
        const recv2 = L.lowerExpr(access.expression);
        const boxed: IrExpr = { kind: "dynFrom", value, type: DYN, loc };
        return {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.keySet", args: [recv2, { ...key }, boxed], type: VOID, loc },
          loc,
        };
      }
    }
    const targetOf = (): FieldTarget | null =>
      ts.isPropertyAccessExpression(access) ? L.fieldTarget(access) : symbolFieldTarget(L, access);
    const target = targetOf();
    if (!target) L.unsupported("SC1090", access, "compound assignment to unsupported field targets");
    // Through an accessor target this desugars to get, op, set — with the
    // receiver an identifier/this, the observable order matches JS exactly:
    // getter, rhs side effects, setter (verified against Node).
    const read = L.fieldGetExpr(target, locOf(access), access);
    const rhs: IrExpr = rhsNode
      ? L.lowerExpr(rhsNode)
      : { kind: "numLit", value: 1, type: F64, loc };
    let value: IrExpr;
    if (op === "+" && target.fieldType.kind === "string") {
      value = { kind: "strConcat", left: read, right: L.ensureString(rhs, rhsNode ?? access), type: STRING, loc };
    } else if (target.fieldType.kind === "f64" && rhs.type.kind === "f64") {
      value = { kind: "bin", op, left: read, right: rhs, type: F64, loc };
    } else if (
      target.fieldType.kind === "dyn" &&
      isJsSourceFile(access.getSourceFile()) &&
      (op === "+" || op === "-" || op === "*" || op === "/" || op === "%" || op === "**")
    ) {
      // CHECKED-DYNAMIC fields (implicit-any ctor assignments —
      // countdown.js's `this[kLimit]` shape with a plain name) follow the
      // JS dyn-operand binary stance: arithmetic CHECKS the dyn side to
      // number (dynCheck — the catchable TypeError, never a silent
      // ToNumber; SEMANTICS.md) and computes natively; the result boxes
      // back into the field's dyn slot. `+=` with a string RHS is the
      // string-context read: check to string, concat, box back.
      const checkNum = (e: IrExpr): IrExpr =>
        e.type.kind === "dyn" ? { kind: "dynCheck", value: e, type: F64, loc: e.loc } : e;
      if (op === "+" && rhs.type.kind === "string") {
        const concat: IrExpr = {
          kind: "strConcat",
          // String-context read: JS's String(unknown) over the field —
          // the JS-exact dyn walker, never a checked cast.
          left: { kind: "toString", operand: read, type: STRING, loc },
          right: rhs,
          type: STRING,
          loc,
        };
        value = { kind: "dynFrom", value: concat, type: DYN, loc };
      } else if (rhs.type.kind === "f64" || rhs.type.kind === "dyn") {
        const bin: IrExpr = { kind: "bin", op, left: checkNum(read), right: checkNum(rhs), type: F64, loc };
        value = { kind: "dynFrom", value: bin, type: DYN, loc };
      } else {
        L.unsupported("SC1043", access);
      }
    } else {
      L.unsupported("SC1043", access);
    }
    // Second, independent evaluation of the (side-effect-free) receiver.
    const target2 = targetOf()!;
    return L.fieldSetStmt(target2, value, loc, access);
  }

/** Stream-rooted receivers' property surface (readableEnded, destroyed,
 * ...): the receiver's mapped class dispatches into lower-stream.ts.
 * Null off the stream hierarchy or for names the spoke does not own. */
function lowerStreamObjectProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken && !L.chainHandled.has(expr)) return null;
  const recvT = L.mapTypeOf(L.typeOf(expr.expression));
  if (recvT?.kind !== "object") return null;
  const info = L.classes.get(recvT.className);
  if (!info || streamSidesOf(L, info) === null) return null;
  return lowerStreamProperty(L, expr, info);
}

/** The primitive-constructor closure (`String`/`Number`/`Boolean` as a
 * VALUE): interns one synthesized module function per constructor —
 * `%builtin.String` et al. — and returns the zero-capture closure over it.
 * The body IS the string-coercion the type mapping promised
 * (`(value: string) => primitive`): String is identity, Number the ECMA
 * StringToNumber (num.fromString — the same runtime call the direct
 * `Number(s)` lowering emits), Boolean the emptiness test. Interning makes
 * every reference the SAME immortal closure, so `opt.type === String`
 * compares like JS function identity. */
function primitiveCtorClosure(
  L: Lowerer,
  name: "String" | "Number" | "Boolean",
  loc: SrcLoc,
): IrExpr {
  const ret = name === "String" ? STRING : name === "Number" ? F64 : BOOL;
  const fnT = funcOf([STRING], ret);
  let fnName = L.primitiveCtorFns.get(name);
  if (!fnName) {
    fnName = `%builtin.${name}`;
    L.primitiveCtorFns.set(name, fnName);
    const s: IrExpr = { kind: "varRef", localId: "v.0", type: STRING, loc };
    const value: IrExpr =
      name === "String"
        ? s
        : name === "Number"
          ? { kind: "libCall", fn: "num.fromString", args: [s], type: F64, loc }
          : { kind: "strEq", negated: true, left: s, right: { kind: "strLit", value: "", type: STRING, loc }, type: BOOL, loc };
    const fn: IrFunction = {
      name: fnName,
      params: [{ localId: "v.0", name: "value", type: STRING }],
      returnType: ret,
      locals: [{ id: "v.0", name: "value", type: STRING, mutable: false }],
      body: [{ kind: "return", value, loc }],
      loc,
    };
    L.liftedFns.push(fn);
  }
  return { kind: "closure", fnName, captures: [], type: fnT, loc };
}
