/* Array literals. */
import { indexedUnionArms, lowerIndexedUnionToArray } from "../indexed-unions.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, neverTaintedJsType } from "../lowerer.js";
import { notIterableSpelling } from "../iterable-spelling.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  isSupportedArrayElem,
  typeEquals,
} from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { underConstAssertion, unitOnlyUnion } from "../../type-mapper.js";
import { dateJsonType, isDateJsonSource } from "../builtins/dates.js";
import { npmStaticPackageOfPath } from "../../npm-static.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { maybePromiseUnionOf } from "../maybe-promise.js";
import { lowerTernary } from "./narrowing.js";
import { lowerCollectionSpread } from "../containers/collection-methods.js";
import { strCharsCall } from "../containers/array-construction.js";
import { generatorDrain } from "../iterator-adapters.js";
import { isSearchParamsIterable } from "../builtins/url.js";
import { varRef } from "../../../ir/build.js";
import { arrayValueStore } from "../array-values.js";
import { classGeneratorIterable } from "../class-iterables.js";

/** JavaScript: whether `expr` is or holds an existing checked-dynamic
 * object — a binding stored as a dyn value whose checker type is an
 * object, or an array or object literal with such an element. Building
 * the enclosing literal with a static element type would copy it. */
export function jsHoldsDynObject(lowerer: Lowerer, expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) {
    const stored = lowerer.peekLocal(expr)?.type ?? lowerer.globalOf(expr)?.type;
    return stored?.kind === "dyn" && (lowerer.typeOf(expr).flags & ts.TypeFlags.Object) !== 0;
  }
  if (ts.isArrayLiteralExpression(expr))
    return expr.elements.nodes.some(
      (element) => !ts.isSpreadElement(element) && jsHoldsDynObject(lowerer, element),
    );
  if (ts.isObjectLiteralExpression(expr))
    return expr.properties.nodes.some(
      (property) =>
        (ts.isPropertyAssignment(property) && jsHoldsDynObject(lowerer, property.initializer)) ||
        (ts.isShorthandPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          jsHoldsDynObject(lowerer, property.name)),
    );
  return false;
}

/** The literal is the source of an array destructuring: an assignment's
 * right side or a declaration's initializer under an array pattern. */
function isPatternSource(expr: ts.ArrayLiteralExpression): boolean {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent))
    return (
      parent.right === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isArrayLiteralExpression(parent.left)
    );
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isArrayBindingPattern(parent.name)
  );
}

/** An empty TypeScript literal whose own type is `never[]`: tsc's type for
 * `[]` with no contextual array type (`return []` in an async function,
 * whose contextual type is `string[] | PromiseLike<string[]>`; `{ files: [] }`).
 * It holds no element, as the empty tuple does, so it builds as the
 * unit-only element array, and an array slot receives it through the
 * checked empty-array lift. never's f64 element mapping would make it a
 * `number[]`, which no `string[]` slot accepts. */
function emptyNeverLiteral(lowerer: Lowerer, expr: ts.ArrayLiteralExpression): boolean {
  if (expr.elements.nodes.length > 0 || isJsSourceFile(ts.getSourceFileOfNode(expr))) return false;
  const own = lowerer.typeOf(expr);
  return (
    lowerer.checker.isArrayType(own) &&
    (lowerer.checker.getTypeArguments(own as ts.TypeReference)[0]!.flags & ts.TypeFlags.Never) !== 0
  );
}

/** The literal's own type is assignable to a non-array member of its
 * contextual union and to none of its array members. */
function fitsOnlyNonArrayArm(
  lowerer: Lowerer,
  expr: ts.ArrayLiteralExpression,
  ctxType: ts.Type | undefined,
): boolean {
  if (ctxType === undefined || !ctxType.isUnionType()) return false;
  const own = lowerer.typeOf(expr);
  let array = false;
  let other = false;
  for (const part of ts.constituentTypes(ctxType)) {
    if (!lowerer.checker.isTypeAssignableTo(own, part)) continue;
    if (lowerer.checker.isArrayType(part)) array = true;
    else other = true;
  }
  return other && !array;
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
  if (expected === undefined && ctxType === undefined && emptyNeverLiteral(lowerer, expr))
    mapped = arrayOf(unitOnlyUnion(lowerer.unions));
  // Inferred JavaScript arrays can contain unrelated constructors with
  // structurally equal checker types. Their native class ABIs still differ.
  if (
    !expected &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
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
  // A destructuring pattern's implied type ends in a rest element
  // (`[h, ...t] = [1, 2, 3]` supplies `[number, ...number[]]`), which maps
  // to an array. The literal keeps its own fixed tuple layout, read by
  // position like any tuple source.
  if (
    expected === undefined &&
    ctxType &&
    isPatternSource(expr) &&
    lowerer.checker.isTupleType(ctxType) &&
    (
      (ctxType as ts.TupleTypeReference).getTarget() as ts.TupleType | undefined
    )?.elementFlags?.some((flag) => (flag & ts.ElementFlags.Rest) !== 0)
  ) {
    const own = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (own?.kind === "record" && lowerer.shapes.get(own.shapeId)?.tuple) mapped = own;
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
    const ctxUnmapped = mapped === null;
    mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // The never-tainted own type carries no element information here
    // either (the JS story above) — only a contextual union's single
    // array arm below may still supply a static home.
    if (neverTaintedOwnJs) mapped = null;
    if (ctxUnmapped && emptyNeverLiteral(lowerer, expr))
      mapped = arrayOf(unitOnlyUnion(lowerer.unions));
    // An EMPTY literal in a union slot (`const t: string[] | undefined =
    // []`, the `[]` default argument against `string[] | undefined`) has
    // no useful own type — tsc infers `never[]`, whose f64-element
    // mapping is a representation for the uninhabited, not the slot's
    // arm. When the contextual union has exactly ONE array arm there is
    // no ambiguity: build the literal as that arm and let the slot's
    // coercion wrap it. Two array arms would need tsc's own best-fit
    // choice — none arises in practice; the fence stands.
    if (ctxUnion && expr.elements.nodes.length === 0) {
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
    if (ctxUnion && expr.elements.nodes.length > 0) {
      // A unit-only-element array (`(null | undefined)[]`) cannot hold
      // non-unit elements — neither as the literal's own mapping nor as
      // a competing union arm.
      const nonUnitElems = expr.elements.nodes.some(
        (el) =>
          !ts.isOmittedExpression(el) &&
          el.kind !== ts.SyntaxKind.NullKeyword &&
          !(ts.isIdentifier(el) && el.text === "undefined"),
      );
      const ownUnhelpful =
        mapped === null ||
        mapped.kind === "dyn" ||
        // The checker may echo the context union rather than infer this literal.
        mapped.kind === "union" ||
        (mapped.kind === "array" && nonUnitElems && lowerer.unitOnlyElem(mapped.elem));
      if (ownUnhelpful) {
        const def = lowerer.unions.get(ctxUnion.unionId);
        const arms = (def?.arms ?? []).filter(
          (a) =>
            (a.kind === "array" && !(nonUnitElems && lowerer.unitOnlyElem(a.elem))) ||
            (a.kind === "record" &&
              !!lowerer.shapes.get(a.shapeId)?.tuple &&
              lowerer.shapes.get(a.shapeId)!.fields.length === expr.elements.nodes.length),
        );
        if (arms.length === 1) mapped = arms[0]!;
      }
    }
    // A NON-EMPTY literal whose own type is an array, under a union with
    // exactly one array arm and no tuple arm (`[1, { n: true }]` in a
    // `Json[]` arm of a recursive `Json`): the checker types each element
    // from the arm, so its object literals lower as the arm's elements,
    // and the literal's own element type (`number | { n: boolean }`)
    // cannot hold them. Build it as the arm; its value only flows into the
    // union slot. A literal that only a non-array arm accepts keeps its
    // own type: `[3, 4, 5]` in `string[] | { length: number; [i: number]:
    // number }` fits the record arm, not `string[]`.
    if (
      ctxUnion &&
      expr.elements.nodes.length > 0 &&
      mapped?.kind === "array" &&
      !fitsOnlyNonArrayArm(lowerer, expr, ctxType)
    ) {
      const def = lowerer.unions.get(ctxUnion.unionId);
      const arrayArms = def?.arms.filter((a) => a.kind === "array") ?? [];
      const tupleArms =
        def?.arms.filter((a) => a.kind === "record" && !!lowerer.shapes.get(a.shapeId)?.tuple) ??
        [];
      if (arrayArms.length === 1 && tupleArms.length === 0) mapped = arrayArms[0]!;
    }
  }
  // A Date's toJSON() element keeps its null in a literal with no declared
  // destination: the lib types say string.
  if (
    !expected &&
    mapped?.kind === "array" &&
    mapped.elem.kind === "string" &&
    expr.elements.nodes.some((element) => isDateJsonSource(lowerer, element))
  )
    mapped = { kind: "array", elem: dateJsonType(lowerer) };
  // An array literal inside an npm-static implicit-any instance can
  // inherit the checker's poisoned any[] context even after the
  // active binding gives every element one concrete lowering. Recover a
  // static array only when every spelled element lowers to the same
  // supported type. An explicit checked-dynamic destination still owns
  // the later slot coercion; heterogeneous literals, holes, and spreads
  // keep the checked-dynamic fallback below.
  if (
    lowerer.implicitParamTypes !== null &&
    npmStaticPackageOfPath(ts.getSourceFileOfNode(expr).fileName) !== null &&
    (mapped === null ||
      mapped.kind === "dyn" ||
      (mapped.kind === "array" && mapped.elem.kind === "dyn")) &&
    expr.elements.nodes.length > 0 &&
    expr.elements.nodes.every(
      (element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element),
    )
  ) {
    const elements = expr.elements.nodes.map((element) => tryLowerExpression(lowerer, element));
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
  if (!expected && isJsSourceFile(ts.getSourceFileOfNode(expr)) && mapped?.kind === "array") {
    const elem = mapped.elem;
    const arms = elem.kind === "union" ? lowerer.unions.get(elem.unionId)?.arms : [elem];
    if (arms?.length && arms.every((arm) => arm.kind === "classval")) mapped = DYN;
    // Inferred JavaScript literals mixing promises and plain values
    // (`[Promise.resolve(1), 2]`) keep the checked-dynamic array: their
    // consumers (Readable.from, Promise.all over iterators) inspect each
    // element at run time.
    if (maybePromiseUnionOf(lowerer, elem)) mapped = DYN;
  }
  if (
    !expected &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    expr.elements.nodes.some(
      (element) =>
        ts.isSpreadElement(element) &&
        tryLowerExpression(lowerer, element.expression)?.type.kind === "dyn",
    )
  )
    mapped = DYN;
  // An element that is an existing checked-dynamic object (a file-scope
  // object literal binding, or a literal holding one) keeps its identity
  // only in a checked-dynamic array: a static element type would copy it.
  if (
    !expected &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    mapped?.kind !== "dyn" &&
    expr.elements.nodes.some(
      (element) => !ts.isSpreadElement(element) && jsHoldsDynObject(lowerer, element),
    )
  )
    mapped = DYN;
  // An EMPTY literal under a CONST ASSERTION whose type queries panicked
  // (tsgo's readonly-[] TupleType conversion) uses a unit-element array,
  // mapType's own `[] as const` rule.
  if (
    mapped === null &&
    expr.elements.nodes.length === 0 &&
    (tsType.flags & ts.TypeFlags.Any) !== 0 &&
    underConstAssertion(expr)
  ) {
    mapped = arrayOf(unitOnlyUnion(lowerer.unions));
  }
  // Heterogeneous JavaScript object arrays must retain each literal's
  // real keys. A structural union can otherwise drop descriptor fields.
  if (
    !expected &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    mapped?.kind === "array" &&
    mapped.elem.kind === "union" &&
    expr.elements.nodes.some(ts.isObjectLiteralExpression)
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
      const spread = expr.elements.nodes.find(ts.isSpreadElement);
      if (spread) {
        return lowerTupleSpreadLiteral(lowerer, expr, mapped, shape);
      }
      if (expr.elements.nodes.length !== shape.fields.length) {
        // tsc padded an UNDER-LENGTH literal against an optional-element
        // tuple context (`options || []` with `options?: [string?,
        // number?]` — the instantiated type spells every position, the
        // literal spells fewer): no fixed shape holds it.
        lowerer.badType(expr, tsType);
      }
      const byName = new Map(shape.fields.map((f) => [f.name, f.type]));
      const fields = expr.elements.nodes.map((el, i) => {
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
      isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
      mapped?.kind === "dyn" ||
      lowerer.checkerAnyArray(expr)
    ) {
      if (expr.elements.nodes.some(ts.isSpreadElement)) {
        // Native collection drains return vectors of retained dyn
        // elements. Reuse the ordinary spread builder, then expose the
        // resulting array through the established unknown[] representation.
        const vector = lowerArrayLiteral(lowerer, expr, arrayOf(DYN) as IrType & { kind: "array" });
        return lowerer.coerceInto(expr, vector, DYN);
      }
      const elems = expr.elements.nodes.map((el): IrExpr => {
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
  let type = mapped as IrType & { kind: "array" };
  // An inferred array of records takes the layout of an element literal
  // whose fields widened for missing-element reads; the other elements
  // build that layout directly. An explicit destination keeps its own.
  if (!expected && type.elem.kind === "record") {
    let variant: IrType | null = null;
    for (const candidate of expr.elements.nodes) {
      let x: ts.Expression = candidate;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (!ts.isObjectLiteralExpression(x)) continue;
      const probe = tryLowerExpression(lowerer, x);
      if (!probe || !lowerer.isRuntimeOptionalRecordVariant(probe.type, type.elem)) continue;
      if (variant !== null && !typeEquals(variant, probe.type)) {
        variant = null;
        break;
      }
      variant = probe.type;
    }
    if (variant !== null) type = arrayOf(variant) as IrType & { kind: "array" };
  }
  // Keep the array payload type fixed. Optional reads are stored through
  // arrayValueStore, which records UNDEFINED in the state byte while the
  // payload remains number/string/etc.; widening the array element here
  // would force boxed union storage and change aliases.
  const spreads: number[] = [];
  const holes = new Set<number>();
  const runtimeOptionalElements = new Set<number>();
  let needsStateBuild = false;
  for (let i = 0; i < expr.elements.nodes.length; i++) {
    const candidate = expr.elements.nodes[i]!;
    if (ts.isSpreadElement(candidate) || ts.isOmittedExpression(candidate)) continue;
    const probe = tryLowerExpression(lowerer, candidate);
    if (probe && lowerer.runtimeOptionalWidening(probe.type, type.elem) !== null) {
      runtimeOptionalElements.add(i);
      needsStateBuild = true;
    }
  }
  const elems: IrExpr[] = expr.elements.nodes.map((el, i): IrExpr => {
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
      let src = ts.isConditionalExpression(srcNode)
        ? lowerTernary(lowerer, srcNode, type)
        : lowerer.lowerExpr(el.expression);
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
      // A union of typed arrays and number arrays (indexed-unions.ts):
      // each arm's elements as a number[].
      const indexedArms = indexedUnionArms(lowerer, src.type);
      if (indexedArms) src = lowerIndexedUnionToArray(lowerer, src, indexedArms, locOf(el));
      // `[...obj]` over a class whose [Symbol.iterator] is a generator
      // method spreads the generator that method returns.
      src = classGeneratorIterable(lowerer, src) ?? src;
      // `[...it]` over a generator (or an iterator adapted into one):
      // drain it once, in order, into a fresh element array.
      if (src.type.kind === "generator") {
        const drained = generatorDrain(lowerer, src, type.elem, locOf(el));
        if (drained) src = drained;
      }
      // `[...sp]` and `[...sp.entries()]` over a URLSearchParams: its
      // checked-dynamic view iterates the live pair list, and the drained
      // [name, value] pairs convert to the literal's tuple elements.
      const searchParamsSource = isSearchParamsIterable(lowerer, el.expression);
      if (src.type.kind === "searchParams") src = lowerer.coerceInto(el.expression, src, DYN);
      // A native checked iterable can supply scalar elements even when
      // the checker inferred a typed array from its producer. Drain once
      // and validate the elements before the ordinary spread copy.
      if (
        src.type.kind === "dyn" &&
        (type.elem.kind === "dyn" ||
          type.elem.kind === "f64" ||
          type.elem.kind === "string" ||
          type.elem.kind === "bool" ||
          searchParamsSource)
      ) {
        src = lowerer.coerceInto(
          el.expression,
          checkedIteratorPack(lowerer, src, notIterableSpelling(el.expression), locOf(el)),
          type,
        );
      }
      // A same-family array whose ELEMENT lifts (string[] into a
      // (string | symbol)[] literal — per-element wrap/width copy):
      // the interned width helper reshapes before the spread copies.
      // A fixed TUPLE (`[...FILES]` with FILES typed `[string, string,
      // string]`) spreads its positions in order: the width helper copies
      // the tuple's fields into an array of the literal's element type.
      if (
        (src.type.kind === "array" ||
          (src.type.kind === "record" && lowerer.shapes.get(src.type.shapeId)?.tuple === true)) &&
        !typeEquals(src.type, type)
      ) {
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
  // Dense capacity for the elements the statements below store.
  const capacity = Math.min(elems.length - spreads.length, 1024);
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: out.id,
      init: {
        kind: "arrayLit",
        elems: [],
        ...(capacity > 0 ? { capacity } : {}),
        type,
        loc,
      },
      loc,
    },
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
  for (const element of expr.elements.nodes) {
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

/** Drain using checked dispatch so native class and generator iterators keep their methods.
 * `spell` is the TypeError message for a source that is not iterable
 * (notIterableSpelling). */
function checkedIteratorPack(lowerer: Lowerer, source: IrExpr, spell: string, loc: SrcLoc): IrExpr {
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
      params: [
        { localId: "source", name: "source", type: DYN },
        { localId: "spell", name: "spell", type: STRING },
      ],
      returnType: DYN,
      locals: [
        ...["source", "iterator", "step", "result"].map((id) => ({
          id,
          name: id,
          type: DYN,
          mutable: id !== "source",
        })),
        { id: "spell", name: "spell", type: STRING, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "iterator",
          init: {
            kind: "libCall",
            fn: "dyn.iterator",
            args: [ref("source"), { kind: "varRef", localId: "spell", type: STRING, loc }],
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
  return {
    kind: "call",
    callee: name,
    args: [source, { kind: "strLit", value: spell, type: STRING, loc }],
    type: DYN,
    loc,
  };
}
