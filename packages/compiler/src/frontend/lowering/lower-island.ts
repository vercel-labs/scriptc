import { InternalCompilerError } from "../../errors.js";
/* Island-boundary lowering: jsval marshaling into the island (jsvalIn and
 * its boundary fences), island-expression detection, the island method-call
 * surface (Math and number/string methods under --dynamic), and the npm
 * package boundary fences for node_modules-declared symbols. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, BYTES_U8, DYN, F64, IrExpr, IrStmt, IrType, JSVAL, MAX_ISLAND_CALLBACK_ARITY, STRING, VOID, canConvertToDyn, canMarshalTypedFuncIntoIsland, islandPromisePayloadTag, isUnitType } from "../../ir/ir.js";
import { ISLAND_SURFACE, IslandFnEntry, STATIC_MATH_FNS, STATIC_MATH_PROPS, boundaryIntoIslandMsg } from "./surfaces.js";
import { requiresDynamicApiDiag, requiresDynamicPackageDiag } from "../../diagnostics/diagnostic.js";
import { isCjsJsFile, isJsSourceFile, locOf, npmPackageNameOf } from "../program.js";
import { foldedStringKeyOf, lowerDynObjectLiteral, pureReemittable } from "./lower-exprs.js";
import { PoisonError, dynUndefinedExpr, newFnCtx, nodeThrowExpr, own } from "./lowerer.js";
import {
  NODE24_FETCH_COMPAT_PROFILE,
  STATIC_HEADERS_CALLS,
  STATIC_READABLE_STREAM_CALLS,
  STATIC_READABLE_STREAM_READS,
  STATIC_RESPONSE_CALLS,
  STATIC_RESPONSE_READS,
} from "../../compat/fetch-profile.js";

/** True iff the checker's type for this node maps to jsval ('any') —
   * the island test in front of every engine-op lowering (receivers,
   * callees, assignment targets). ALSO true for an identifier bound to an
   * island-HANDLE local whose declared type says otherwise (`const {
   * readFileSync } = await import("fs")` — the binding's declared
   * function/Buffer type never held the value; the handle is the value's
   * only story), so its uses dispatch to engine ops instead of
   * re-reporting the declared type. The one exclusion is promise-mapped
   * declared types: a package promise held as a handle keeps its existing
   * checker-driven dispatch (the await/.catch bridge lowerings own it). */
  export function isIslandExpr(lowerer: Lowerer, node: ts.Expression): boolean {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (mapped?.kind === "jsval") return true;
    if (mapped?.kind !== "promise" && ts.isIdentifier(node)) {
      const local = lowerer.peekLocal(node);
      if (local?.type.kind === "jsval") return true;
      // File-scope handle bindings (a module global slotted jsval by the
      // island-pattern or unchecked-overload rules) take the same rule as
      // locals: the handle is the value's only story.
      if (!local && lowerer.globalOf(node)?.type.kind === "jsval") return true;
    }
    return false;
  }

/** Marshal a static value into the island (--dynamic): primitives by
   * value, JSON-safe composites as a deep copy (the documented aliasing
   * divergence). Values with no island representation — closures, class
   * instances, promises, un-validated 'unknown' — are rejected with the
   * boundary message. */
  /** The call-time deferral of a FUNC-value island crossing in a JS
   * source: captures the just-recorded diagnostic into the runtime-fence
   * ledger and answers a marshaled host closure that THROWS it when
   * invoked — building the value compiles; only a call through the
   * island stops the run. Null (caller rethrows) outside the JS deferral
   * gate: TypeScript sources, probe mode, ICEs. */
  export function islandFuncValueFence(lowerer: Lowerer, err: unknown, diagsBefore: number, node: ts.Node): IrExpr | null {
    if (!(err instanceof PoisonError) || !isJsSourceFile(node.getSourceFile())) return null;
    const fence = lowerer.deferToRuntimeFence(diagsBefore, node, {
      kind: "closure",
      name: () => `%fn${lowerer.lambdaCounter++}_islfence`,
      returnType: VOID,
      type: { kind: "func", params: [], ret: VOID },
    });
    if (!fence) return null;
    return {
      kind: "jsMarshal",
      value: fence,
      type: JSVAL,
      loc: fence.loc,
    };
  }

  export function jsvalIn(lowerer: Lowerer, e: IrExpr, node: ts.Node): IrExpr {
    if (e.type.kind === "jsval") return e;
    // Bare unit literals (`undefined` / `null` in an 'any' slot): the
    // engine's own units — unit-typed expressions are literals (units have
    // no other producers), so dropping the operand loses nothing.
    if (isUnitType(e.type)) {
      return { kind: "jsOp", op: e.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc: e.loc };
    }
    if (e.type.kind === "dyn") {
      // A CHECKED-DYNAMIC value entering the island: the dyn tree
      // deep-copies into engine values — exactly coerceToExpected's
      // jsval-IN rule (data kinds only; a dyn carrying a boxed
      // function/handle throws the catchable TypeError at runtime).
      return { kind: "jsMarshal", value: e, type: JSVAL, loc: e.loc };
    }
    // Closures cross INTO the island as host functions — THE package
    // callback pattern (`.action((a, b) => ...)`). Unannotated params stay
    // 'any' (contextual typing against package signatures) and pass through
    // as handles; TYPED params convert at call time through the validated-
    // exit machinery (strict primitives, JSON round-trip composites,
    // `T | undefined` taking the undefined arm for an absent argument), so
    // a conversion failure throws back into the island as a TypeError.
    // Anything outside both shapes gets the specific fix, not the generic
    // boundary recitation.
    if (
      e.type.kind === "func" &&
      !canMarshalTypedFuncIntoIsland(e.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
    ) {
      const diagsBefore = lowerer.diags.length;
      try {
        lowerer.unsupported(
          "SC1090",
          node,
          `functions with this signature crossing into dynamically-executed code ` +
            `(a callback passed to a package/'any' API may take 'any' parameters — ` +
            `leave them unannotated so contextual typing keeps them 'any' — or parameters ` +
            `convertible at the boundary (number, string, boolean, JSON-safe ` +
            `records/arrays/unions, 'T | undefined'), and return 'any', void, number, ` +
            `string, boolean, a JSON-safe composite, or a Promise of the primitive kinds${
              e.type.kind === "func" && e.type.params.length > MAX_ISLAND_CALLBACK_ARITY
                ? `; at most ${MAX_ISLAND_CALLBACK_ARITY} parameters`
                : ""
            })`,
        );
      } catch (err) {
        // JS sources defer the crossing like a statement fence, one level
        // deeper: the slot receives a host closure that THROWS the
        // diagnostic when INVOKED (the withPlugins aggregation shape —
        // wrappers built at module init around functions the smoke path
        // never calls). TypeScript and probe mode keep the poison.
        const fence = islandFuncValueFence(lowerer, err, diagsBefore, node);
        if (fence) return fence;
        throw err;
      }
    }
    // A STATIC promise crossing INTO the island: a real engine thenable
    // settled when the scriptc promise settles (the async-callback return
    // bridge, scr_jsval_from_promise) — the loadBuiltinPlugins cache
    // shape and the island Promise.all arm's static entries. Only
    // fulfillments in the bridge's payload domain cross; the rest keep
    // the boundary fence below with the promise type named.
    if (e.type.kind === "promise" && islandPromisePayloadTag(e.type.inner) !== null) {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc: e.loc };
    }
    if (e.type.kind !== "func" && !lowerer.boundarySafe(e.type)) {
      // A RegExp crossing INTO the island (`z.string().regex(/^a+$/)` —
      // the validation-pattern argument): the engine compiles its own
      // from source+flags. A fresh engine RegExp per marshal — identity
      // and lastIndex state do not cross (SEMANTICS.md). Only literal
      // and pure-read spellings lower (the rebuild reads the operand
      // twice); computed regex values keep the boundary fence.
      if (e.type.kind === "regex") {
        const re = islandRegexpOf(e);
        if (re) return re;
      }
      // jsval-BEARING composites (an `any[]` value, a record holding one)
      // have no JSON marshal but an honest per-field/per-element island
      // construction — the same lift the implicit coercion path uses.
      if (lowerer.jsvalLiftable(e.type)) return lowerer.jsvalLiftExpr(e, e.loc);
      lowerer.unsupported("SC1090", node, boundaryIntoIslandMsg(lowerer.fmt(e.type)));
    }
    return { kind: "jsMarshal", value: e, type: JSVAL, loc: e.loc };
  }

/** A static RegExp value as a fresh ENGINE RegExp — `new RegExp(source,
   * flags)` in the island, the pattern TEXT crossing (both worlds compile
   * the ES-spec grammar). Literals rebuild from their own pattern/flags;
   * pure reads (a regex-typed binding) read the source/flags intrinsics —
   * the rebuild emits the operand twice, so effectful producers return
   * null into the caller's boundary fence. */
  export function islandRegexpOf(e: IrExpr): IrExpr | null {
    if (e.type.kind !== "regex") return null;
    const loc = e.loc;
    let src: IrExpr;
    let flags: IrExpr;
    if (e.kind === "regexLit") {
      src = { kind: "strLit", value: e.pattern, type: STRING, loc };
      flags = { kind: "strLit", value: e.flags, type: STRING, loc };
    } else if (pureReemittable(e)) {
      src = { kind: "regexIntrinsic", method: "source", receiver: e, args: [], type: STRING, loc };
      flags = { kind: "regexIntrinsic", method: "flags", receiver: e, args: [], type: STRING, loc };
    } else {
      return null;
    }
    const ctor: IrExpr = { kind: "jsOp", op: "globalGet", name: "RegExp", args: [], type: JSVAL, loc };
    return {
      kind: "jsOp",
      op: "construct",
      args: [
        ctor,
        { kind: "jsMarshal", value: src, type: JSVAL, loc },
        { kind: "jsMarshal", value: flags, type: JSVAL, loc },
      ],
      type: JSVAL,
      loc,
    };
  }

/** The gate on every ISLAND_SURFACE lowering: under --dynamic the caller
   * proceeds to engine ops; without it the use site is a per-site SC2012
   * (poison-recovered, so every site in the program reports — and the
   * coverage report groups them under "runs with --dynamic"). */
  export function requireDynamicApi(lowerer: Lowerer, feature: string, node: ts.Node): void {
    if (lowerer.dynamic) return;
    lowerer.pushDiag(requiresDynamicApiDiag(feature, locOf(node)));
    throw new PoisonError();
  }

/** Resolves an identifier to an island-backed ambient GLOBAL function
   * (parseFloat, isFinite). Provenance, not name: the
   * symbol's declaration must live in the ambient file, so a user function
   * named `parseFloat` never matches. */
  export function islandGlobalFnOf(lowerer: Lowerer, ident: ts.Identifier): IslandFnEntry | null {
    const entry = own(ISLAND_SURFACE.globals, ident.text);
    if (!entry) return null;
    const symbol = lowerer.resolveValueSymbol(ident);
    if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
    return entry;
  }

function requestInitLiteralKey(
  lowerer: Lowerer,
  prop: ts.ObjectLiteralElementLike,
): string | null {
  if (
    !ts.isPropertyAssignment(prop) &&
    !ts.isShorthandPropertyAssignment(prop) &&
    !ts.isMethodDeclaration(prop)
  ) {
    return null;
  }
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) return foldedStringKeyOf(lowerer, name.expression);
  return null;
}

/** Fence declared RequestInit members outside the selected compiler tier.
 * Computed runtime keys and non-literal objects are validated again by the
 * static runtime; source-visible members that neither tier preserves are
 * rejected before the dynamic bridge can silently discard them. */
function requestInitValueExpr(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function requestInitStaticBoolean(lowerer: Lowerer, value: ts.Expression): boolean | null {
  const expr = requestInitValueExpr(value);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  const text = lowerer.checker.typeToString(lowerer.typeOf(expr));
  return text === "true" ? true : text === "false" ? false : null;
}

/** Symbols whose object value is mutated through a property write. A const
 * binding keeps the binding stable, not the object: following its initializer
 * after `init.cache = undefined` would diagnose the stale literal instead of
 * the value fetch actually observes. Built lazily and diagnostic-free. */
function requestInitPropMutatedSymbols(lowerer: Lowerer): Set<ts.Symbol> {
  const holder = lowerer as unknown as {
    requestInitPropMutatedSyms?: Set<ts.Symbol>;
  };
  if (holder.requestInitPropMutatedSyms) {
    return holder.requestInitPropMutatedSyms;
  }
  const symbols = new Set<ts.Symbol>();
  const noteBase = (target: ts.Expression): void => {
    let base = requestInitValueExpr(target);
    while (
      ts.isPropertyAccessExpression(base) ||
      ts.isElementAccessExpression(base)
    ) {
      base = requestInitValueExpr(base.expression);
    }
    if (!ts.isIdentifier(base)) return;
    try {
      const symbol = lowerer.resolveValueSymbol(base);
      if (symbol) symbols.add(symbol);
    } catch {
      /* not a traceable RequestInit candidate */
    }
  };
  for (const source of lowerer.program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) ||
          ts.isElementAccessExpression(node.left))
      ) {
        noteBase(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        (ts.isPropertyAccessExpression(node.operand) ||
          ts.isElementAccessExpression(node.operand))
      ) {
        noteBase(node.operand);
      } else if (ts.isDeleteExpression(node)) {
        noteBase(node.expression);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  holder.requestInitPropMutatedSyms = symbols;
  return symbols;
}

function requestInitConstBacked(
  lowerer: Lowerer,
  value: ts.Expression,
  seen: Set<ts.Symbol>,
): boolean {
  const expr = requestInitValueExpr(value);
  if (ts.isObjectLiteralExpression(expr)) return true;
  if (ts.isConditionalExpression(expr)) {
    const selected = requestInitStaticBoolean(lowerer, expr.condition);
    if (selected !== null) {
      return requestInitConstBacked(
        lowerer,
        selected ? expr.whenTrue : expr.whenFalse,
        new Set(seen),
      );
    }
    return requestInitConstBacked(lowerer, expr.whenTrue, new Set(seen)) &&
      requestInitConstBacked(lowerer, expr.whenFalse, new Set(seen));
  }
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return false;
  if (requestInitPropMutatedSymbols(lowerer).has(symbol)) return false;
  seen.add(symbol);
  const declarations = lowerer.checker.declarationsOf(symbol).filter(
    (declaration): declaration is ts.VariableDeclaration =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
  );
  return declarations.length > 0 && declarations.every((declaration) =>
    requestInitConstBacked(lowerer, declaration.initializer!, new Set(seen))
  );
}

type RequestInitValueSelector =
  | { kind: "property"; key: string }
  | { kind: "index"; index: number };

/** Visit the values selected by one key or index on a const-backed object or
 * array. Property symbols can come from annotations rather than the literal
 * supplying the runtime value, so tracing follows receiver initializers. */
function visitRequestInitConstSelectedValues(
  lowerer: Lowerer,
  value: ts.Expression,
  selector: RequestInitValueSelector,
  seen: Set<ts.Symbol>,
  visit: (value: ts.Expression) => void,
): boolean {
  const expr = requestInitValueExpr(value);
  if (selector.kind === "property" && ts.isObjectLiteralExpression(expr)) {
    // Last contributor wins. A definite later property (including one from
    // a statically traced spread) hides earlier values exactly as it does at
    // runtime; a conditional/missing spread keeps the earlier contributor
    // in the possible-value set.
    for (let i = expr.properties.length - 1; i >= 0; i--) {
      const property = expr.properties[i]!;
      if (ts.isSpreadAssignment(property)) {
        const defines = visitRequestInitConstSelectedValues(
          lowerer,
          property.expression,
          selector,
          new Set(seen),
          visit,
        );
        if (defines) return true;
        continue;
      }
      if (requestInitLiteralKey(lowerer, property) !== selector.key) continue;
      if (ts.isPropertyAssignment(property)) {
        visit(property.initializer);
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        ts.isIdentifier(property.name)
      ) {
        visit(property.name);
      }
      return true;
    }
    return false;
  }
  if (selector.kind === "index" && ts.isArrayLiteralExpression(expr)) {
    const element = expr.elements[selector.index];
    if (
      element === undefined ||
      ts.isOmittedExpression(element) ||
      ts.isSpreadElement(element)
    ) {
      return false;
    }
    visit(element);
    return true;
  }
  if (ts.isConditionalExpression(expr)) {
    const selected = requestInitStaticBoolean(lowerer, expr.condition);
    if (selected !== null) {
      return visitRequestInitConstSelectedValues(
        lowerer,
        selected ? expr.whenTrue : expr.whenFalse,
        selector,
        seen,
        visit,
      );
    }
    const whenTrue = visitRequestInitConstSelectedValues(
      lowerer,
      expr.whenTrue,
      selector,
      new Set(seen),
      visit,
    );
    const whenFalse = visitRequestInitConstSelectedValues(
      lowerer,
      expr.whenFalse,
      selector,
      new Set(seen),
      visit,
    );
    return whenTrue && whenFalse;
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const member = ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : foldedStringKeyOf(lowerer, expr.argumentExpression);
    if (member === null) return false;
    const nested: ts.Expression[] = [];
    const receiverDefines = visitRequestInitConstSelectedValues(
      lowerer,
      expr.expression,
      { kind: "property", key: member },
      new Set(seen),
      (value) => nested.push(value),
    );
    let nestedDefines = nested.length > 0;
    for (const value of nested) {
      if (!visitRequestInitConstSelectedValues(lowerer, value, selector, new Set(seen), visit)) {
        nestedDefines = false;
      }
    }
    return receiverDefines && nestedDefines;
  }
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return false;
  if (requestInitPropMutatedSymbols(lowerer).has(symbol)) return false;
  seen.add(symbol);
  let sawDeclaration = false;
  let defines = true;
  for (const declaration of lowerer.checker.declarationsOf(symbol)) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      sawDeclaration = true;
      if (!visitRequestInitConstSelectedValues(
        lowerer,
        declaration.initializer,
        selector,
        new Set(seen),
        visit,
      )) {
        defines = false;
      }
    }
  }
  return sawDeclaration && defines;
}

type RequestInitBindingSelector =
  | { kind: "property"; key: string }
  | { kind: "index"; index: number };

function requestInitConstBindingSource(
  lowerer: Lowerer,
  declaration: ts.BindingElement,
): { initializer: ts.Expression; selectors: RequestInitBindingSelector[] } | null {
  const selectors: RequestInitBindingSelector[] = [];
  let current = declaration;
  while (true) {
    const pattern = current.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      if (current.dotDotDotToken) return null;
      const key = fetchObjectBindingMemberName(lowerer, current);
      if (key === null) return null;
      selectors.unshift({ kind: "property", key });
    } else if (ts.isArrayBindingPattern(pattern)) {
      if (current.dotDotDotToken) return null;
      const index = pattern.elements.indexOf(current);
      if (index < 0) return null;
      selectors.unshift({ kind: "index", index });
    } else {
      return null;
    }

    const owner = pattern.parent;
    if (ts.isBindingElement(owner)) {
      current = owner;
      continue;
    }
    if (
      !ts.isVariableDeclaration(owner) ||
      owner.initializer === undefined ||
      !ts.isVariableDeclarationList(owner.parent) ||
      (owner.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return null;
    }
    return { initializer: owner.initializer, selectors };
  }
}

function visitRequestInitConstBindingValues(
  lowerer: Lowerer,
  value: ts.Expression,
  selectors: readonly RequestInitBindingSelector[],
  seen: Set<ts.Symbol>,
  visit: (value: ts.Expression) => void,
): boolean {
  const selector = selectors[0];
  if (selector === undefined) {
    visit(value);
    return true;
  }
  let nestedDefines = true;
  const visitNested = (nested: ts.Expression): void => {
    if (!visitRequestInitConstBindingValues(
      lowerer,
      nested,
      selectors.slice(1),
      new Set(seen),
      visit,
    )) {
      nestedDefines = false;
    }
  };
  const defines = visitRequestInitConstSelectedValues(lowerer, value, selector, seen, visitNested);
  return defines && nestedDefines;
}

function fenceRequestInitProperty(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  seen: Set<ts.Symbol>,
): void {
  const key = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : foldedStringKeyOf(lowerer, access.argumentExpression);
  if (key === null) return;
  visitRequestInitConstSelectedValues(
    lowerer,
    access.expression,
    { kind: "property", key },
    new Set(),
    (value) => fenceRequestInitValueInner(lowerer, value, seen),
  );
  if (!requestInitConstBacked(lowerer, access.expression, new Set())) return;
  const symbol = ts.isPropertyAccessExpression(access)
    ? lowerer.checker.getSymbolAtLocation(access.name)
    : lowerer.checker.getPropertyOfType(lowerer.typeOf(access.expression), key);
  if (!symbol || seen.has(symbol)) return;
  seen.add(symbol);
  for (const declaration of lowerer.checker.declarationsOf(symbol)) {
    if (ts.isPropertyAssignment(declaration)) {
      fenceRequestInitValueInner(lowerer, declaration.initializer, seen);
    } else if (
      ts.isShorthandPropertyAssignment(declaration) &&
      ts.isIdentifier(declaration.name)
    ) {
      fenceRequestInitValueInner(lowerer, declaration.name, seen);
    }
  }
}

function fenceRequestInitObject(
  lowerer: Lowerer,
  init: ts.ObjectLiteralExpression,
  seen: Set<ts.Symbol>,
): void {
  const contextual = lowerer.checker.getContextualType(init);
  const contextualArms =
    contextual?.isUnionType() ? ts.constituentTypes(contextual) : contextual ? [contextual] : [];
  const rows = NODE24_FETCH_COMPAT_PROFILE.inventory.entries.filter((entry) =>
    entry.owner === "RequestInit" && entry.placement === "dictionary"
  );
  const shadowed = new Set<string>();
  const fence = (
    row: (typeof rows)[number],
    value: ts.Expression | null,
    blame: ts.Node,
  ): void => {
    if (lowerer.dynamic ? row.status !== "unsupported" : row.status === "static") return;
    if (value !== null) {
      const type = lowerer.typeOf(requestInitValueExpr(value));
      if (
        ts.isVoidExpression(requestInitValueExpr(value)) ||
        (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
      ) {
        return;
      }
    }
    const sym = contextualArms
      .map((arm) => lowerer.checker.getPropertyOfType(arm, row.member))
      .find((member) => member !== undefined);
    lowerer.noLowering(
      `RequestInit option '${row.member}'${lowerer.dynamic ? "" : " in a static build"}`,
      blame,
      row.reason ??
        "the native static RequestInit surface is method, headers, body, duplex, redirect, and signal",
      sym,
    );
  };

  // Object spread is last-write-wins. Walk from the end and trace only the
  // effective contributor for each dictionary member; a definite later
  // `cache: undefined`, for example, suppresses an earlier unsupported
  // cache value just as WebIDL observes at runtime.
  for (let index = init.properties.length - 1; index >= 0; index--) {
    const prop = init.properties[index]!;
    if (ts.isSpreadAssignment(prop)) {
      for (const row of rows) {
        if (shadowed.has(row.member)) continue;
        const defines = visitRequestInitConstSelectedValues(
          lowerer,
          prop.expression,
          { kind: "property", key: row.member },
          new Set(seen),
          (value) => fence(row, value, value),
        );
        if (defines) shadowed.add(row.member);
      }
      continue;
    }
    const key = requestInitLiteralKey(lowerer, prop);
    if (key === null || shadowed.has(key)) continue;
    shadowed.add(key);
    const row = rows.find((entry) => entry.member === key);
    if (!row) continue;
    const value = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)
      ? prop.name
      : null;
    fence(row, value, prop);
  }
}

/** Fence statically knowable RequestInit gaps through the ordinary value
 * plumbing, not only when the fetch argument's AST is itself an object
 * literal. Const aliases and object spreads preserve the same dictionary
 * members, so follow their initializers until the profile can make the
 * decision. Runtime-computed values keep both fetch runtimes' defensive
 * validation because there is no source member to diagnose. */
function fenceRequestInitValueInner(
  lowerer: Lowerer,
  value: ts.Expression,
  seen: Set<ts.Symbol>,
): void {
  const expr = requestInitValueExpr(value);
  if (ts.isObjectLiteralExpression(expr)) {
    fenceRequestInitObject(lowerer, expr, seen);
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    const selected = requestInitStaticBoolean(lowerer, expr.condition);
    if (selected !== null) {
      fenceRequestInitValueInner(lowerer, selected ? expr.whenTrue : expr.whenFalse, seen);
    } else {
      fenceRequestInitValueInner(lowerer, expr.whenTrue, seen);
      fenceRequestInitValueInner(lowerer, expr.whenFalse, seen);
    }
    return;
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    fenceRequestInitProperty(lowerer, expr, seen);
    return;
  }
  if (!ts.isIdentifier(expr)) return;
  // Import bindings point at an ImportSpecifier declaration, not the
  // exported const whose initializer carries the dictionary members.
  // Chase the value alias so local and cross-module const plumbing share
  // the same source-profile fence.
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return;
  if (requestInitPropMutatedSymbols(lowerer).has(symbol)) return;
  seen.add(symbol);
  for (const declaration of lowerer.checker.declarationsOf(symbol)) {
    if (ts.isBindingElement(declaration)) {
      const source = requestInitConstBindingSource(lowerer, declaration);
      if (source !== null) {
        visitRequestInitConstBindingValues(
          lowerer,
          source.initializer,
          source.selectors,
          new Set(seen),
          (bindingValue) => fenceRequestInitValueInner(lowerer, bindingValue, new Set(seen)),
        );
      }
      continue;
    }
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    fenceRequestInitValueInner(lowerer, declaration.initializer, seen);
  }
}

function fenceRequestInitValue(
  lowerer: Lowerer,
  value: ts.Expression,
): void {
  fenceRequestInitValueInner(lowerer, value, new Set());
}

/** USER-code `fetch(url)` / `fetch(url, init)` — the ambient global
   * (provenance, not the name: a user's own `fetch` never matches).
   *
   * The static tier owns URL requests directly: scr_fetch_static runs
   * over the native net/http/tls stack, consumes a checked-dynamic
   * RequestInit object, and returns a promise of an opaque native
   * Response handle. AbortSignal and readable Web Streams are native
   * checked-dynamic handles too, so cancellation and streaming bodies
   * stay engine-free.
   *
   * The engine's own fetch executes (the same one embedded npm code calls —
   * scr_fetch.c over the native net/tls stack): the url marshals in (strings; template
   * results), an init OBJECT LITERAL builds natively in the island through
   * the existing 'any'-contextual literal path (RequestInit maps to jsval,
   * so field values marshal individually and an AbortSignal handle passes
   * straight through), and the engine's promise bridges to a static
   * `promise of jsval` (jsBridgePromise) — `await fetch(...)` parks the
   * fiber like any await and resumes with the Response HANDLE. Member
   * reads/calls on the handle are engine ops; typed extraction happens at
   * the user's narrowing sites through the validated-exit machinery.
   * Null for anything that isn't THE ambient fetch, so lowerCall keeps
   * trying. */
  export function lowerFetchCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
    const callee = call.expression;
    if (!ts.isIdentifier(callee) || callee.text !== "fetch") return null;
    if (call.questionDotToken) return null;
    const symbol = lowerer.resolveValueSymbol(callee);
    if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
    if (call.arguments.length < 1) return null;
    const loc = locOf(call);
    const initNode = call.arguments[1];
    if (initNode !== undefined) fenceRequestInitValue(lowerer, initNode);
    if (!lowerer.dynamic) {
      const inputNode = call.arguments[0]!;
      const input = lowerer.lowerExpr(inputNode);
      let init: IrExpr;
      if (initNode === undefined) {
        init = dynUndefinedExpr(loc);
      } else if (ts.isObjectLiteralExpression(initNode)) {
        init = lowerDynObjectLiteral(lowerer, initNode);
      } else {
        init = lowerer.lowerExprExpecting(initNode, DYN);
      }

      // Calling a WebIDL operation has two distinct phases: JavaScript
      // first evaluates every argument expression, then the callee converts
      // those values. In particular, evaluating RequestInit may mutate a
      // URL object passed as input; its href must not be snapshotted until
      // all argument expressions (including ignored surplus ones) ran.
      const inputLocal = lowerer.declareHiddenLocal("%fetchInput", input.type);
      const initLocal = lowerer.declareHiddenLocal("%fetchInit", init.type);
      const inputRef: IrExpr = {
        kind: "varRef",
        localId: inputLocal.id,
        type: input.type,
        loc: locOf(inputNode),
      };
      const initRef: IrExpr = {
        kind: "varRef",
        localId: initLocal.id,
        type: init.type,
        loc,
      };
      const stmts: IrStmt[] = [
        { kind: "varDecl", localId: inputLocal.id, init: input, loc },
        { kind: "varDecl", localId: initLocal.id, init, loc },
      ];
      for (const argument of call.arguments.slice(2)) {
        if (ts.isSpreadElement(argument)) {
          lowerer.noLowering(
            "spread surplus arguments on static fetch()",
            argument,
            "pass surplus arguments without spread syntax",
          );
        }
        const discarded = ts.isVoidExpression(argument)
          ? lowerer.lowerExpr(argument.expression)
          : lowerer.lowerExpr(argument);
        stmts.push({ kind: "exprStmt", expr: discarded, loc: discarded.loc });
      }
      const url: IrExpr =
        input.type.kind === "url"
          ? {
              kind: "libCall",
              fn: "url.href",
              args: [inputRef],
              type: STRING,
              loc: locOf(inputNode),
            }
          : lowerer.coerceInto(inputNode, inputRef, STRING);
      const answer: IrExpr = {
        kind: "libCall",
        fn: "fetch.start",
        args: [url, initRef],
        type: { kind: "promise", inner: DYN },
        loc,
      };
      return { kind: "seqExpr", stmts, result: answer, type: answer.type, loc };
    }
    const fetchFn: IrExpr = { kind: "jsOp", op: "globalGet", name: "fetch", args: [], type: JSVAL, loc };
    // Init OBJECT LITERALS build natively in the island (the general
    // 'any'-contextual literal path can't claim them: the optional param's
    // contextual type is `RequestInit | undefined`, a union) — field
    // values marshal individually, so an AbortSignal HANDLE passes
    // through and dashed header keys ("content-type") are plain engine
    // property names. Non-literal inits marshal as a whole (JSON-safe
    // records; a signal field inside one fences with the boundary rule).
    const args = call.arguments.map((a) =>
      ts.isObjectLiteralExpression(a) ? lowerIslandObjectLiteral(lowerer, a) : lowerer.jsvalIn(lowerer.lowerExpr(a), a),
    );
    const raw: IrExpr = { kind: "jsOp", op: "callFn", args: [fetchFn, ...args], type: JSVAL, loc };
    return { kind: "jsBridgePromise", value: raw, type: { kind: "promise", inner: JSVAL }, loc };
  }

/** Static Response.json(): consume the native Response's readable body
 * stream and parse its UTF-8 payload into the ordinary checked-dynamic
 * JSON tree. Syntax and stream failures reject at await like the web API. */
export function lowerStaticResponseCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    (!ts.isPropertyAccessExpression(call.expression) &&
      !ts.isElementAccessExpression(call.expression))
  ) {
    return null;
  }
  const access = call.expression;
  const member = staticResponseMemberName(lowerer, access);
  if (
    access.questionDotToken ||
    (member !== "json" &&
      member !== "text" &&
      member !== "bytes" &&
      member !== "arrayBuffer") ||
    call.arguments.length !== 0
  ) {
    return null;
  }
  const recvType = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Response" || !lowerer.isStdlibSymbol(sym)) return null;
  if (member === "arrayBuffer") {
    lowerer.noLowering(
      "Response.arrayBuffer() in a static build",
      call,
      "use Response.bytes() for the native Uint8Array body; free-standing ArrayBuffer values have no static representation",
      sym,
    );
  }
  const recv = lowerer.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  return lowerStaticFixedFetchMethodCall(
    lowerer,
    call,
    access,
    member,
    recv,
    [],
    (receiver) =>
      member === "text" || member === "bytes"
        ? {
            kind: "libCall",
            fn: member === "text" ? "fetch.responseText" : "fetch.responseBytes",
            args: [receiver],
            type: {
              kind: "promise",
              inner: member === "text" ? STRING : BYTES_U8,
            },
            loc: locOf(call),
          }
        : {
            kind: "libCall",
            fn: "fetch.responseJson",
            args: [receiver],
            type: { kind: "promise", inner: DYN },
            loc: locOf(call),
          },
  );
}

type StaticResponseAccess =
  | ts.PropertyAccessExpression
  | ts.ElementAccessExpression;

function staticResponseMemberName(
  lowerer: Lowerer,
  access: StaticResponseAccess,
): string | null {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const members = fetchElementMemberNames(lowerer, access.argumentExpression);
  return members?.length === 1 ? members[0]! : null;
}

/** A singleton computed member is still an evaluated JavaScript expression.
 * The specialized static bridges know the only permitted method name, but
 * must preserve receiver -> key -> arguments order and reject a lying cast
 * whose runtime key is not that name. */
function lowerStaticFixedFetchMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: StaticResponseAccess,
  member: string,
  receiver: IrExpr,
  argumentValues: readonly IrExpr[],
  invoke: (receiver: IrExpr, args: IrExpr[]) => IrExpr,
): IrExpr {
  if (ts.isPropertyAccessExpression(access)) {
    return invoke(receiver, [...argumentValues]);
  }
  const loc = locOf(call);
  const key = lowerer.lowerExprExpecting(access.argumentExpression, STRING);
  const receiverLocal = lowerer.declareHiddenLocal(
    "%fetchReceiver",
    receiver.type,
  );
  const keyLocal = lowerer.declareHiddenLocal("%fetchMember", STRING);
  const argumentLocals = argumentValues.map((argument) =>
    lowerer.declareHiddenLocal("%fetchMethodArg", argument.type)
  );
  const receiverRef: IrExpr = {
    kind: "varRef",
    localId: receiverLocal.id,
    type: receiverLocal.type,
    loc,
  };
  const keyRef: IrExpr = {
    kind: "varRef",
    localId: keyLocal.id,
    type: STRING,
    loc,
  };
  const argumentRefs = argumentLocals.map<IrExpr>((argument) => ({
    kind: "varRef",
    localId: argument.id,
    type: argument.type,
    loc,
  }));
  const answer = invoke(receiverRef, argumentRefs);
  const result: IrExpr = {
    kind: "ternary",
    cond: {
      kind: "strEq",
      negated: false,
      left: keyRef,
      right: { kind: "strLit", value: member, type: STRING, loc },
      type: BOOL,
      loc,
    },
    then: answer,
    else_: nodeThrowExpr(
      1,
      "",
      `${access.getText()} is not a function`,
      answer.type,
      loc,
    ),
    type: answer.type,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: keyLocal.id, init: key, loc },
      // A computed call resolves the property before evaluating arguments.
      // Native Web handles dispatch methods by name rather than storing
      // callable properties, so perform the keyed read for its ordering and
      // nullish-receiver check, then use the fixed native invocation below.
      {
        kind: "exprStmt",
        expr: {
          kind: "dynKeyGet",
          value: receiverRef,
          key: keyRef,
          type: DYN,
          loc,
        },
        loc,
      },
      ...argumentValues.map<IrStmt>((argument, index) => ({
        kind: "varDecl",
        localId: argumentLocals[index]!.id,
        init: argument,
        loc: argument.loc,
      })),
    ],
    result,
    type: answer.type,
    loc,
  };
}

function fetchElementMemberNames(
  lowerer: Lowerer,
  keyExpr: ts.Expression,
): string[] | null {
  if (
    ts.isPropertyAccessExpression(keyExpr) &&
    lowerer.isStdlibGlobal(keyExpr.expression, "Symbol") &&
    (keyExpr.name.text === "iterator" ||
      keyExpr.name.text === "asyncIterator" ||
      keyExpr.name.text === "toStringTag")
  ) {
    return [`[Symbol.${keyExpr.name.text}]`];
  }
  const key = lowerer.typeOf(keyExpr);
  if (key.isStringLiteralType()) return [key.value];
  if (!key.isUnionType()) return null;
  const members: string[] = [];
  for (const arm of ts.constituentTypes(key)) {
    if (!arm.isStringLiteralType()) return null;
    if (!members.includes(arm.value)) members.push(arm.value);
  }
  return members;
}

function fetchAccessMemberNames(
  lowerer: Lowerer,
  access: StaticResponseAccess,
): string[] | null {
  return ts.isPropertyAccessExpression(access)
    ? [access.name.text]
    : fetchElementMemberNames(lowerer, access.argumentExpression);
}

function fetchInventoryStatus(
  owner: string,
  member: string,
  placement: "static" | "prototype" | "prototype-symbol",
): "static" | "dynamic-only" | "unsupported" | "out-of-scope" | null {
  return NODE24_FETCH_COMPAT_PROFILE.inventory.entries.find((entry) =>
    entry.owner === owner &&
    entry.member === member &&
    entry.placement === placement
  )?.status ?? null;
}

function fetchInventoryReason(
  owner: string,
  member: string,
  placement: "static" | "prototype" | "prototype-symbol",
): string | undefined {
  return NODE24_FETCH_COMPAT_PROFILE.inventory.entries.find((entry) =>
    entry.owner === owner &&
    entry.member === member &&
    entry.placement === placement
  )?.reason;
}

/** Constructor-object operations are distinct from Response instance
 * methods. The inventory marks the former unsupported in both tiers; fence
 * them explicitly so the generic call fallback cannot report SC1090 for
 * Response.json while the other statics report SC2020. */
export function fenceUnsupportedFetchConstructorMember(
  lowerer: Lowerer,
  access: StaticResponseAccess,
): IrExpr | null {
  if (!lowerer.isStdlibGlobal(access.expression, "Response")) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const member = members.find((candidate) =>
    fetchInventoryStatus("Response", candidate, "static") === "unsupported"
  );
  if (member === undefined) return null;
  lowerer.noLowering(
    `Response.${member}`,
    access,
    "Response static constructor-object operations have no compiler lowering in either tier",
  );
}

function hasLiveWebMutableArm(lowerer: Lowerer, type: IrType): boolean {
  if (
    type.kind === "record" ||
    type.kind === "array" ||
    type.kind === "bytes"
  ) {
    return true;
  }
  if (type.kind !== "union") return false;
  return lowerer.unions.get(type.unionId)?.arms.some((arm) =>
    hasLiveWebMutableArm(lowerer, arm)
  ) ?? false;
}

/** Box mutable data for Web API slots that expose the exact JavaScript
 * value again. Ordinary dynFrom remains the documented copy boundary;
 * this capsule is deliberately limited to records/arrays/bytes (including
 * those selected at runtime from a union) that the live materializer can
 * snapshot and commit. */
function lowerLiveWebValue(
  lowerer: Lowerer,
  node: ts.Expression,
  lowered?: IrExpr,
): IrExpr {
  const value = lowered ?? lowerer.lowerExpr(node);
  if (
    hasLiveWebMutableArm(lowerer, value.type) &&
    canConvertToDyn(
      value.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return {
      kind: "dynFrom",
      value,
      liveRef: true,
      type: DYN,
      loc: value.loc,
    };
  }
  return lowerer.coerceInto(node, value, DYN);
}

function fetchMethodArgumentIsLive(
  owner: string,
  members: readonly string[],
  index: number,
): boolean {
  return (
    (index === 0 &&
      ((owner === "ReadableStreamDefaultController" &&
        members.some((member) => member === "enqueue" || member === "error")) ||
        ((owner === "ReadableStream" ||
          owner === "ReadableStreamDefaultReader") &&
          members.includes("cancel")) ||
        (owner === "AbortController" && members.includes("abort")))) ||
    (index === 1 &&
      owner === "AbortSignal" &&
      members.some((member) =>
        member === "addEventListener" || member === "removeEventListener"
      ))
  );
}

/** The adopted undici Response declaration is wider than the native static
 * handle. Keep the supported fallback slice on checked-dynamic dispatch, but
 * fence every other declared member before the generic dyn keyed-read/call
 * paths can turn a missing handle operation into a runtime TypeError. */
export function fenceStaticResponseMember(
  lowerer: Lowerer,
  access: StaticResponseAccess,
  use: "read" | "call",
): IrExpr | null {
  const recvType = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Response" || !lowerer.isStdlibSymbol(sym)) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const status = (member: string) => fetchInventoryStatus(
    "Response",
    member,
    member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
  );
  if (lowerer.dynamic && members.every((member) => status(member) !== "unsupported")) {
    return null;
  }
  const supported = (member: string) =>
    use === "call"
      ? STATIC_RESPONSE_CALLS.has(member)
      : STATIC_RESPONSE_READS.has(member);
  if (!lowerer.dynamic && members.every(supported)) return null;
  const member = members.find((candidate) =>
    lowerer.dynamic ? status(candidate) === "unsupported" : !supported(candidate)
  )!;
  if (status(member) === "unsupported") {
    lowerer.noLowering(
      `Response.${member}`,
      access,
      fetchInventoryReason("Response", member, "prototype") ??
        "this Response operation has no compiler lowering in either tier",
      sym,
    );
  }
  lowerer.noLowering(
    `Response.${member} in a static build`,
    access,
    "the native static Response surface is status/ok/statusText/url/redirected/headers/body/bodyUsed plus json(), text(), and bytes(); use --dynamic for the wider Web API",
    sym,
  );
}

/** Response Headers are native checked-dynamic handles. Keep their exact
 * supported method slice aligned with the compatibility census so newly
 * observed Node members cannot fall through to a runtime missing-method
 * error in an engine-free build. */
export function fenceStaticHeadersMember(
  lowerer: Lowerer,
  access: StaticResponseAccess,
  use: "read" | "call",
): IrExpr | null {
  const recvType = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Headers" || !lowerer.isStdlibSymbol(sym)) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const status = (member: string) => fetchInventoryStatus(
    "Headers",
    member,
    member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
  );
  if (lowerer.dynamic && members.every((member) => status(member) !== "unsupported")) {
    return null;
  }
  if (!lowerer.dynamic && use === "call" && members.every((member) => STATIC_HEADERS_CALLS.has(member))) {
    return null;
  }
  const member = members.find((candidate) =>
    lowerer.dynamic
      ? status(candidate) === "unsupported"
      : use !== "call" || !STATIC_HEADERS_CALLS.has(candidate)
  )!;
  if (status(member) === "unsupported") {
    lowerer.noLowering(
      `Headers.${member}`,
      access,
      "symbol-keyed Headers iteration has no compiler lowering in either tier; call entries() with --dynamic instead",
      sym,
    );
  }
  lowerer.noLowering(
    `Headers.${member} in a static build`,
    access,
    "the native static Headers surface is append/delete/get/getSetCookie/has/set/forEach; use keys()/values()/entries() or symbol-keyed iteration with --dynamic, while construction remains unsupported",
    sym,
  );
}

/** The native AbortController handle dispatches `abort()` directly and
 * exposes `.signal` as data, but it has no first-class function value for
 * the prototype method. Fence method extraction before the checked-dynamic
 * keyed-read fallback can silently answer `undefined`. Dynamic builds use
 * the engine's real AbortController object and retain ordinary method reads. */
export function fenceStaticAbortControllerMemberRead(
  lowerer: Lowerer,
  access: StaticResponseAccess,
): IrExpr | null {
  if (lowerer.dynamic) return null;
  const symbol = isStdlibFetchInterface(
    lowerer,
    access.expression,
    "AbortController",
  );
  if (!symbol) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null || !members.includes("abort")) return null;
  lowerer.noLowering(
    "AbortController.abort through method extraction in a static build",
    access,
    "call controller.abort(...) directly; the native AbortController handle does not expose abort as a first-class function value",
    symbol,
  );
}

function isStdlibFetchInterface(
  lowerer: Lowerer,
  node: ts.Node,
  owner: string,
): ts.Symbol | null {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
    if (symbol?.name === owner && lowerer.isStdlibSymbol(symbol)) return symbol;
  }
  return null;
}

function fetchObjectBindingMemberName(
  lowerer: Lowerer,
  element: ts.BindingElement,
): string | null {
  const name = element.propertyName ??
    (element.name !== undefined && ts.isIdentifier(element.name) ? element.name : undefined);
  if (name === undefined) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const members = fetchElementMemberNames(lowerer, name.expression);
    return members?.length === 1 ? members[0]! : null;
  }
  return null;
}

function fetchObjectAssignmentMemberName(
  lowerer: Lowerer,
  property: ts.ObjectLiteralElementLike,
): string | null {
  if (ts.isSpreadAssignment(property)) return null;
  const name = property.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const members = fetchElementMemberNames(lowerer, name.expression);
    return members?.length === 1 ? members[0]! : null;
  }
  return null;
}

function fetchInterfaceInventoryOwner(
  lowerer: Lowerer,
  node: ts.Node,
): { owner: string; symbol: ts.Symbol } | null {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  const symbol = [type.getSymbol(), type.getAliasSymbol()].find((candidate) =>
    candidate !== undefined &&
    NODE24_FETCH_COMPAT_PROFILE.inventory.interfaces.includes(candidate.name) &&
    lowerer.isStdlibSymbol(candidate)
  );
  return symbol ? { owner: symbol.name, symbol } : null;
}

function fenceFetchObjectMembers(
  lowerer: Lowerer,
  ownerNode: ts.Node,
  members: readonly { member: string; node: ts.Node }[],
): void {
  const resolved = fetchInterfaceInventoryOwner(lowerer, ownerNode);
  if (!resolved) return;
  const { owner, symbol } = resolved;
  for (const { member, node } of members) {
    const row = NODE24_FETCH_COMPAT_PROFILE.inventory.entries.find((entry) =>
      entry.owner === owner &&
      entry.member === member &&
      (entry.placement === "prototype" ||
        entry.placement === "prototype-inherited" ||
        entry.placement === "prototype-symbol")
    );
    if (!row || row.status === "out-of-scope") continue;
    if (lowerer.dynamic && row.status !== "unsupported") continue;
    // Static data properties retain the ordinary checked-dynamic keyed-read
    // lowering. Only a method extraction loses the receiver that its direct
    // call bridge would preserve; non-static rows keep their inventory fence.
    const operation = NODE24_FETCH_COMPAT_PROFILE.operations.find(
      (candidate) => candidate.id === row.id,
    );
    if (!lowerer.dynamic && row.status === "static" && operation?.kind === "property") {
      continue;
    }
    lowerer.noLowering(
      `${owner}.${member}${lowerer.dynamic ? "" : " through object destructuring in a static build"}`,
      node,
      row.reason ??
        "the direct lowered read/call form has a compiler bridge, but extracting this member as a value does not",
      symbol,
    );
  }
}

/** Object binding syntax reads members without constructing property-access
 * nodes, so the ordinary Response/Headers/ReadableStream chokepoints never
 * see it. Attribute those reads to the same inventory rows before generic
 * dyn/jsval destructuring either reports SC1031 or admits an unsupported
 * member in the dynamic tier. */
export function fenceFetchObjectBinding(
  lowerer: Lowerer,
  pattern: ts.ObjectBindingPattern,
): void {
  fenceFetchObjectMembers(
    lowerer,
    pattern,
    pattern.elements.flatMap((element) => {
      if (element.dotDotDotToken) return [];
      const member = fetchObjectBindingMemberName(lowerer, element);
      return member === null ? [] : [{ member, node: element }];
    }),
  );
}

/** Assignment-position object destructuring is the same member-read form as
 * a binding pattern, but its source type lives on the right-hand expression
 * instead of the target AST. */
export function fenceFetchObjectAssignment(
  lowerer: Lowerer,
  target: ts.ObjectLiteralExpression,
  source: ts.Expression,
): void {
  fenceFetchObjectMembers(
    lowerer,
    source,
    target.properties.flatMap((property) => {
      const member = fetchObjectAssignmentMemberName(lowerer, property);
      return member === null ? [] : [{ member, node: property }];
    }),
  );
}

/** Iteration syntax invokes Headers[Symbol.iterator] without constructing
 * an element-access node, so the member chokepoint above never sees it.
 * Keep engine-free builds on the same SC2020 profile row for for-of,
 * array spread, and array destructuring. The dynamic tier uses the
 * engine's iterator protocol and is intentionally allowed. */
export function fenceStaticHeadersIteration(
  lowerer: Lowerer,
  node: ts.Node,
): void {
  if (lowerer.dynamic) return;
  const value = ts.isExpression(node) ? requestInitValueExpr(node) : node;
  const sym = isStdlibFetchInterface(lowerer, value, "Headers");
  if (!sym) return;
  lowerer.noLowering(
    "Headers.[Symbol.iterator] in a static build",
    node,
    "Headers iteration requires --dynamic; append/delete/get/getSetCookie/has/set/forEach remain engine-free",
    sym,
  );
}

/** Dynamic element-spelled Headers iteration. Symbol.iterator uses the
 * engine's GetIterator operation. A finite union of keys()/values()/entries()
 * dispatches through fixed-name engine calls after evaluating the receiver
 * and key once, preserving the method receiver and JavaScript evaluation
 * order without trying to represent the union of method values. */
export function lowerDynamicHeadersIteratorCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.ElementAccessExpression,
): IrExpr | null {
  if (
    !lowerer.dynamic ||
    call.questionDotToken ||
    access.questionDotToken ||
    call.arguments.length !== 0 ||
    !isStdlibFetchInterface(lowerer, access.expression, "Headers")
  ) {
    return null;
  }
  const members = fetchElementMemberNames(lowerer, access.argumentExpression);
  if (members === null) return null;
  const symbolIterator = members.length === 1 && members[0] === "[Symbol.iterator]";
  if (
    !symbolIterator &&
    !members.every((member) =>
      member === "keys" || member === "values" || member === "entries"
    )
  ) {
    return null;
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "jsval") return null;
  const loc = locOf(call);
  if (!symbolIterator) {
    const key = lowerer.lowerExpr(access.argumentExpression);
    if (key.type.kind !== "string") return null;
    const recvLocal = lowerer.declareHiddenLocal("%headers", JSVAL);
    const keyLocal = lowerer.declareHiddenLocal("%headersKey", STRING);
    const recvRef: IrExpr = {
      kind: "varRef",
      localId: recvLocal.id,
      type: JSVAL,
      loc,
    };
    const keyRef: IrExpr = {
      kind: "varRef",
      localId: keyLocal.id,
      type: STRING,
      loc,
    };
    const invoke = (member: string): IrExpr => ({
      kind: "jsOp",
      op: "callMethod",
      name: member,
      args: [recvRef],
      type: JSVAL,
      loc,
    });
    // Same-kind literal unions erase to STRING in IR, so a lying assertion
    // can carry a runtime key outside `members`. Validate every arm instead
    // of treating the last member as an unconditional default: substituting
    // another method is silent corruption. The trust-but-verify fallback is
    // the catchable TypeError used by the compiler's other erased casts.
    let result: IrExpr = nodeThrowExpr(
      1,
      "",
      `${access.getText()} is not a function`,
      JSVAL,
      loc,
    );
    for (let i = members.length - 1; i >= 0; i--) {
      const member = members[i]!;
      result = {
        kind: "ternary",
        cond: {
          kind: "strEq",
          negated: false,
          left: keyRef,
          right: { kind: "strLit", value: member, type: STRING, loc },
          type: BOOL,
          loc,
        },
        then: invoke(member),
        else_: result,
        type: JSVAL,
        loc,
      };
    }
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: recvLocal.id, init: receiver, loc },
        { kind: "varDecl", localId: keyLocal.id, init: key, loc },
      ],
      result,
      type: JSVAL,
      loc,
    };
  }
  return {
    kind: "jsOp",
    op: "iterNew",
    args: [receiver],
    type: JSVAL,
    loc,
  };
}

/** Bracket-spelled calls on a profiled fetch/Web-stream handle. A call such
 * as `headers["get"](name)` is still a method reference in JavaScript: the
 * receiver must remain bound. Lower it before the generic callee-as-value
 * path (which correctly fences bare method extraction), evaluating receiver,
 * key, and arguments once in source order. Finite string-literal unions
 * dispatch through fixed-name calls after the key value is captured. */
export function lowerFetchElementMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (
    call.questionDotToken ||
    !ts.isElementAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    call.arguments.some((argument) => ts.isSpreadElement(argument))
  ) {
    return null;
  }
  const access = call.expression;
  const resolved = fetchInterfaceInventoryOwner(lowerer, access.expression);
  if (!resolved) return null;
  const members = fetchElementMemberNames(lowerer, access.argumentExpression);
  if (
    members === null ||
    members.length === 0 ||
    members.some((member) => member.startsWith("[Symbol."))
  ) {
    return null;
  }
  const rows = members.map((member) =>
    NODE24_FETCH_COMPAT_PROFILE.inventory.entries.find((entry) =>
      entry.owner === resolved.owner &&
      entry.member === member &&
      (entry.placement === "prototype" ||
        entry.placement === "prototype-inherited")
    )
  );
  if (
    rows.some((row) =>
      row === undefined ||
      row.status === "out-of-scope" ||
      (lowerer.dynamic ? row.status === "unsupported" : row.status !== "static")
    )
  ) {
    return null;
  }

  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== (lowerer.dynamic ? "jsval" : "dyn")) return null;
  const key = lowerer.lowerExpr(access.argumentExpression);
  if (key.type.kind !== "string") return null;
  const loc = locOf(call);
  const receiverLocal = lowerer.declareHiddenLocal(
    "%fetchReceiver",
    lowerer.dynamic ? JSVAL : DYN,
  );
  const keyLocal = lowerer.declareHiddenLocal("%fetchMember", STRING);
  const calleeLocal = lowerer.dynamic
    ? lowerer.declareHiddenLocal("%fetchMethod", JSVAL)
    : null;
  const argumentValues = call.arguments.map((argument, index) =>
    lowerer.dynamic
      ? lowerer.jsvalIn(lowerer.lowerExpr(argument), argument)
      : fetchMethodArgumentIsLive(
          resolved.owner,
          members,
          index,
        )
        ? lowerLiveWebValue(lowerer, argument)
        : lowerer.lowerExprExpecting(argument, DYN)
  );
  const argumentLocals = argumentValues.map((argument) =>
    lowerer.declareHiddenLocal("%fetchMethodArg", argument.type)
  );
  const receiverRef: IrExpr = {
    kind: "varRef",
    localId: receiverLocal.id,
    type: receiverLocal.type,
    loc,
  };
  const keyRef: IrExpr = {
    kind: "varRef",
    localId: keyLocal.id,
    type: STRING,
    loc,
  };
  const calleeRef: IrExpr | null = calleeLocal === null
    ? null
    : {
        kind: "varRef",
        localId: calleeLocal.id,
        type: JSVAL,
        loc,
      };
  const memberReadStmt: IrStmt = calleeLocal === null
    ? {
        kind: "exprStmt",
        expr: {
          kind: "dynKeyGet",
          value: receiverRef,
          key: keyRef,
          type: DYN,
          loc,
        },
        loc,
      }
    : {
        kind: "varDecl",
        localId: calleeLocal.id,
        init: {
          kind: "jsOp",
          op: "getIdx",
          args: [
            receiverRef,
            { kind: "jsMarshal", value: keyRef, type: JSVAL, loc },
          ],
          type: JSVAL,
          loc,
        },
        loc,
      };
  const argumentRefs = argumentLocals.map<IrExpr>((argument) => ({
    kind: "varRef",
    localId: argument.id,
    type: argument.type,
    loc,
  }));
  const staticResponsePromise: IrType | null =
    !lowerer.dynamic &&
      resolved.owner === "Response" &&
      call.arguments.length === 0 &&
      members.every((member) => member === "text" || member === "bytes")
      ? (() => {
          // The checker spells this call as
          // `Promise<string> | Promise<Uint8Array>`, a promise union that
          // intentionally has no IR representation. At an await site its
          // result is the ordinary representable value union; use that
          // contextual type for the bridge's fulfillment adapter.
          const inner = ts.isAwaitExpression(call.parent)
            ? lowerer.mapTypeOf(lowerer.typeOf(call.parent))
            : null;
          return inner ? { kind: "promise", inner } : null;
        })()
      : null;
  const invoke = (member: string): IrExpr =>
    lowerer.dynamic
      ? {
          kind: "jsOp",
          op: "callFnThis",
          args: [calleeRef!, receiverRef, ...argumentRefs],
          type: JSVAL,
          loc,
        }
      : staticResponsePromise !== null
      ? {
          kind: "libCall",
          fn: member === "text" ? "fetch.responseText" : "fetch.responseBytes",
          args: [receiverRef],
          type: staticResponsePromise,
          loc,
        }
      : {
          kind: "dynInvoke",
          recv: receiverRef,
          method: member,
          calleeName: access.getText(),
          args: argumentRefs,
          type: DYN,
          loc,
        };
  // Literal-string unions share the STRING carrier. A cast can therefore
  // smuggle a different runtime key into this call; validate all arms and
  // fail loudly rather than dispatching every mismatch to the last member.
  const invocationType = staticResponsePromise ?? (lowerer.dynamic ? JSVAL : DYN);
  let result: IrExpr = nodeThrowExpr(
    1,
    "",
    `${access.getText()} is not a function`,
    invocationType,
    loc,
  );
  for (let index = members.length - 1; index >= 0; index--) {
    const member = members[index]!;
    result = {
      kind: "ternary",
      cond: {
        kind: "strEq",
        negated: false,
        left: keyRef,
        right: { kind: "strLit", value: member, type: STRING, loc },
        type: BOOL,
        loc,
      },
      then: invoke(member),
      else_: result,
      type: result.type,
      loc,
    };
  }
  const declared = lowerer.dynamic ? lowerer.mapTypeOf(lowerer.typeOf(call)) : null;
  if (
    declared &&
    (declared.kind === "f64" ||
      declared.kind === "bool" ||
      declared.kind === "string")
  ) {
    result = { kind: "jsExit", value: result, type: declared, loc };
  }
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: keyLocal.id, init: key, loc },
      memberReadStmt,
      ...argumentValues.map<IrStmt>((argument, index) => ({
        kind: "varDecl",
        localId: argumentLocals[index]!.id,
        init: argument,
        loc: argument.loc,
      })),
    ],
    result,
    type: result.type,
    loc,
  };
}

/** `[...headers]` in the dynamic tier: Array.from runs inside the engine
 * over the real Headers iterator, then the resulting pair array exits
 * through the checker's declared array type. For Headers this is the
 * spread algorithm's exact iterable snapshot. */
export function lowerDynamicHeadersSpread(
  lowerer: Lowerer,
  node: ts.Expression,
  type: IrType & { kind: "array" },
): IrExpr | null {
  if (!lowerer.dynamic || !isStdlibFetchInterface(lowerer, requestInitValueExpr(node), "Headers")) {
    return null;
  }
  const receiver = lowerer.lowerExpr(node);
  if (receiver.type.kind !== "jsval") return null;
  const loc = locOf(node);
  const arrayCtor: IrExpr = {
    kind: "jsOp",
    op: "globalGet",
    name: "Array",
    args: [],
    type: JSVAL,
    loc,
  };
  const snapshot: IrExpr = {
    kind: "jsOp",
    op: "callMethod",
    name: "from",
    args: [arrayCtor, receiver],
    type: JSVAL,
    loc,
  };
  return { kind: "jsExit", value: snapshot, type, loc };
}

/** The fallback ambient declaration intentionally exposes only the native
 * stream slice, but @types/node adopts the complete WHATWG ReadableStream
 * interface. Fence that wider surface before its checked-dynamic handle can
 * fall through to a runtime missing-method error. */
export function fenceStaticReadableStreamMember(
  lowerer: Lowerer,
  access: StaticResponseAccess,
  use: "read" | "call",
): IrExpr | null {
  const sym = isStdlibFetchInterface(lowerer, access.expression, "ReadableStream");
  if (!sym) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const status = (member: string) => fetchInventoryStatus(
    "ReadableStream",
    member,
    member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
  );
  if (lowerer.dynamic && members.every((member) => status(member) !== "unsupported")) {
    return null;
  }
  const supported = (member: string) =>
    use === "call"
      ? STATIC_READABLE_STREAM_CALLS.has(member)
      : STATIC_READABLE_STREAM_READS.has(member);
  if (!lowerer.dynamic && members.every(supported)) return null;
  const member = members.find((candidate) =>
    lowerer.dynamic ? status(candidate) === "unsupported" : !supported(candidate)
  )!;
  if (status(member) === "unsupported") {
    lowerer.noLowering(
      `ReadableStream.${member}`,
      access,
      fetchInventoryReason(
        "ReadableStream",
        member,
        member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
      ) ?? "this ReadableStream operation has no compiler lowering in either tier",
      sym,
    );
  }
  lowerer.noLowering(
    `ReadableStream.${member} in a static build`,
    access,
    "the native static ReadableStream surface is locked plus cancel() and getReader(); use a reader directly or --dynamic for the wider Web Streams API",
    sym,
  );
}

/** Static AbortSignal constructors and ReadableStream.from(). These
 * ambient globals have no first-class constructor-object representation;
 * claim the direct calls by declaration provenance before the general
 * member-call path tries to lower the receiver as a value. */
function staticFirstArgWithSurplusArgs(
  lowerer: Lowerer,
  call: ts.CallExpression,
  first: IrExpr,
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.length <= 1) return first;
  const firstLocal = lowerer.declareHiddenLocal("%fetchArg", first.type);
  const firstRef: IrExpr = {
    kind: "varRef",
    localId: firstLocal.id,
    type: first.type,
    loc,
  };
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: firstLocal.id, init: first, loc },
  ];
  for (const argument of call.arguments.slice(1)) {
    if (ts.isSpreadElement(argument)) {
      lowerer.noLowering(
        "spread surplus arguments on the static fetch companion APIs",
        argument,
        "pass surplus arguments without spread syntax",
      );
    }
    // The callee ignores the value, but JavaScript still evaluates every
    // surplus argument in source order. A direct void has the operand's
    // effects and no additional work of its own.
    const discarded = ts.isVoidExpression(argument)
      ? lowerer.lowerExpr(argument.expression)
      : lowerer.lowerExpr(argument);
    stmts.push({ kind: "exprStmt", expr: discarded, loc: discarded.loc });
  }
  return {
    kind: "seqExpr",
    stmts,
    result: firstRef,
    type: first.type,
    loc,
  };
}

function staticCallWithSurplusArgs(
  lowerer: Lowerer,
  call: ts.CallExpression,
  first: IrExpr,
  result: (first: IrExpr) => IrExpr,
): IrExpr {
  return result(staticFirstArgWithSurplusArgs(lowerer, call, first));
}

export function lowerStaticFetchCompanionCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    !ts.isIdentifier(call.expression.expression)
  ) {
    return null;
  }
  const root = call.expression.expression;
  const symbol = lowerer.resolveValueSymbol(root);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const loc = locOf(call);
  if (root.text === "AbortSignal") {
    switch (call.expression.name.text) {
      case "timeout":
        if (call.arguments[0] && ts.isSpreadElement(call.arguments[0])) {
          return null;
        }
        return staticCallWithSurplusArgs(
          lowerer,
          call,
          call.arguments[0]
            ? lowerer.lowerExprExpecting(call.arguments[0], DYN)
            : dynUndefinedExpr(loc),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortTimeout",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      case "abort":
        if (call.arguments.length === 0) {
          return {
            kind: "libCall",
            fn: "fetch.abortNow",
            args: [dynUndefinedExpr(loc)],
            type: DYN,
            loc,
          };
        }
        if (ts.isSpreadElement(call.arguments[0]!)) return null;
        return staticCallWithSurplusArgs(
          lowerer,
          call,
          lowerLiveWebValue(lowerer, call.arguments[0]!),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortNow",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      case "any":
        if (call.arguments[0] && ts.isSpreadElement(call.arguments[0])) {
          return null;
        }
        return staticCallWithSurplusArgs(
          lowerer,
          call,
          call.arguments[0]
            ? lowerer.lowerExprExpecting(call.arguments[0], DYN)
            : dynUndefinedExpr(loc),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortAny",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      default:
        return null;
    }
  }
  if (
    root.text === "ReadableStream" &&
    call.expression.name.text === "from" &&
    (!call.arguments[0] || !ts.isSpreadElement(call.arguments[0]))
  ) {
    if (!call.arguments[0]) {
      return {
        kind: "libCall",
        fn: "fetch.streamFrom",
        args: [dynUndefinedExpr(loc)],
        type: DYN,
        loc,
      };
    }
    let source = lowerer.lowerExpr(call.arguments[0]!);
    // A readonly tuple satisfies the fallback's readonly-array overload,
    // but maps to a monomorphic record in IR. Reuse the ordinary
    // tuple→array width conversion with the resolved generic parameter so
    // `ReadableStream.from([1, 2] as const)` follows every other tuple
    // flowing into a readonly T[] slot.
    if (source.type.kind === "record") {
      const signature = lowerer.checker.getResolvedSignature(call);
      const iterableParam = signature?.getParameters()[0];
      const iterableType = iterableParam
        ? lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(iterableParam))
        : null;
      if (iterableType?.kind === "array") {
        source = lowerer.widthCoerce(source, iterableType) ?? source;
      }
    }
    const preserve =
      source.type.kind === "string" ||
      (source.type.kind === "bytes" && source.type.elem === "u8") ||
      (source.type.kind === "array" &&
        canConvertToDyn(
          source.type.elem,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )) ||
      source.type.kind === "dyn";
    if (!preserve) {
      lowerer.noLowering(
        `ReadableStream.from() over ${lowerer.checker.typeToString(lowerer.typeOf(call.arguments[0]!))} iterables`,
        call.arguments[0]!,
        "arrays, Uint8Array, and strings are supported — spread other synchronous iterables into an array first: [...iterable]",
      );
    }
    return staticCallWithSurplusArgs(lowerer, call, source, (first) => ({
      kind: "libCall",
      fn: "fetch.streamFrom",
      // Arrays and bytes must cross by reference: their iterators read each
      // entry at pull time, so mutations after ReadableStream.from() remain
      // observable just as they are in Node. Other supported iterable
      // shapes retain the checked-dynamic fallback.
      args: [first],
      type: DYN,
      loc,
    }));
  }
  return null;
}

/** `AbortController.abort(reason?)` mutates the native signal shared with
 * `.signal` and fetch. Preserve a mutable reason's identity just like
 * `AbortSignal.abort(reason)`; surplus arguments still evaluate in order and
 * are ignored by the runtime operation. */
export function lowerStaticAbortControllerCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    call.arguments.some((argument) => ts.isSpreadElement(argument)) ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken ||
    staticResponseMemberName(lowerer, access) !== "abort"
  ) {
    return null;
  }
  const receiverTs = lowerer.checker.getBaseTypeOfLiteralType(
    lowerer.typeOf(access.expression),
  );
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol?.name !== "AbortController" ||
    !lowerer.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        lowerer.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const first = call.arguments[0]
    ? lowerLiveWebValue(lowerer, call.arguments[0])
    : dynUndefinedExpr(loc);
  const args = [staticFirstArgWithSurplusArgs(lowerer, call, first)];
  return lowerStaticFixedFetchMethodCall(
    lowerer,
    call,
    access,
    "abort",
    receiver,
    args,
    (receiverRef, argumentRefs) => ({
      kind: "dynInvoke",
      recv: receiverRef,
      method: "abort",
      calleeName: access.getText(),
      args: argumentRefs,
      type: DYN,
      loc,
    }),
  );
}

/** Controller chunks and error reasons are dyn-handle calls, but unlike a
 * general checked-dynamic boundary the Web Streams contract preserves their
 * object identity for the reader/source callbacks that observe them. */
export function lowerStaticReadableStreamControllerCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    call.arguments.length > 1 ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(lowerer, access);
  if (member !== "enqueue" && member !== "error") return null;
  const receiverTs = lowerer.checker.getBaseTypeOfLiteralType(
    lowerer.typeOf(access.expression),
  );
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol?.name !== "ReadableStreamDefaultController" ||
    !lowerer.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        lowerer.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const recv = lowerer.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const args = [
    call.arguments[0]
      ? lowerLiveWebValue(lowerer, call.arguments[0])
      : dynUndefinedExpr(loc),
  ];
  return lowerStaticFixedFetchMethodCall(
    lowerer,
    call,
    access,
    member,
    recv,
    args,
    (receiver, argumentRefs) => ({
      kind: "dynInvoke",
      recv: receiver,
      method: member,
      calleeName: access.getText(),
      args: argumentRefs,
      type: DYN,
      loc,
    }),
  );
}

/** `ReadableStream.cancel(reason)` and default-reader `cancel(reason)` pass
 * the same reason object to the underlying source's cancel callback. Keep a
 * live typed-reference capsule instead of the general dyn boundary's copy. */
export function lowerStaticReadableStreamCancelCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    call.arguments.length > 1 ||
    call.arguments.some((argument) => ts.isSpreadElement(argument)) ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken ||
    staticResponseMemberName(lowerer, access) !== "cancel"
  ) {
    return null;
  }
  const resolved = fetchInterfaceInventoryOwner(lowerer, access.expression);
  if (
    resolved?.owner !== "ReadableStream" &&
    resolved?.owner !== "ReadableStreamDefaultReader"
  ) {
    return null;
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const args = [
    call.arguments[0]
      ? lowerLiveWebValue(lowerer, call.arguments[0])
      : dynUndefinedExpr(loc),
  ];
  return lowerStaticFixedFetchMethodCall(
    lowerer,
    call,
    access,
    "cancel",
    receiver,
    args,
    (receiverRef, argumentRefs) => ({
      kind: "dynInvoke",
      recv: receiverRef,
      method: "cancel",
      calleeName: access.getText(),
      args: argumentRefs,
      type: DYN,
      loc,
    }),
  );
}

/** AbortSignal retains listener object identity for duplicate detection and
 * removeEventListener(). Functions already box by closure identity; mutable
 * record/array/bytes listeners need the same live capsule used by stream
 * chunks so repeated crossings still denote one EventListener object. */
export function lowerStaticAbortSignalListenerCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    call.arguments.length < 2 ||
    call.arguments.some((arg) => ts.isSpreadElement(arg)) ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(lowerer, access);
  if (member !== "addEventListener" && member !== "removeEventListener") {
    return null;
  }
  const receiverTs = lowerer.checker.getBaseTypeOfLiteralType(
    lowerer.typeOf(access.expression),
  );
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol?.name !== "AbortSignal" ||
    !lowerer.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        lowerer.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const recv = lowerer.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const args = call.arguments.map((arg, index) =>
    index === 1
      ? lowerLiveWebValue(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN)
  );
  return lowerStaticFixedFetchMethodCall(
    lowerer,
    call,
    access,
    member,
    recv,
    args,
    (receiver, argumentRefs) => ({
      kind: "dynInvoke",
      recv: receiver,
      method: member,
      calleeName: access.getText(),
      args: argumentRefs,
      type: DYN,
      loc,
    }),
  );
}

/** `new AbortController()`. Static builds create a native controller handle
 * over the same signal state consumed by fetch; dynamic builds construct the
 * island Web object. JavaScript accepts surplus constructor arguments, so
 * both tiers evaluate them even though AbortController ignores their values. */
export function lowerAbortControllerNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "AbortController"
  ) {
    return null;
  }
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const args = expr.arguments ?? [];
  if (args.some((argument) => ts.isSpreadElement(argument))) return null;
  const loc = locOf(expr);
  if (lowerer.dynamic) {
    const ctor: IrExpr = {
      kind: "jsOp",
      op: "globalGet",
      name: "AbortController",
      args: [],
      type: JSVAL,
      loc,
    };
    return {
      kind: "jsOp",
      op: "construct",
      args: [ctor, ...args.map((argument) =>
        lowerer.jsvalIn(lowerer.lowerExpr(argument), argument)
      )],
      type: JSVAL,
      loc,
    };
  }
  const result: IrExpr = {
    kind: "libCall",
    fn: "fetch.abortControllerNew",
    args: [],
    type: DYN,
    loc,
  };
  if (args.length === 0) return result;
  return {
    kind: "seqExpr",
    stmts: args.map((argument): IrStmt => ({
      kind: "exprStmt",
      expr: lowerer.lowerExpr(argument),
      loc: locOf(argument),
    })),
    result,
    type: DYN,
    loc,
  };
}

/** `new ReadableStream(source?)`. Static builds box the source record into
 * the checked-dynamic tree; dynamic builds construct the island's Web
 * stream directly so the returned handle composes with dynamic fetch. */
export function lowerStaticReadableStreamNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "ReadableStream"
  ) {
    return null;
  }
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const args = expr.arguments ?? [];
  if (args.length > 1) return null;
  const loc = locOf(expr);
  if (lowerer.dynamic) {
    const ctor: IrExpr = {
      kind: "jsOp",
      op: "globalGet",
      name: "ReadableStream",
      args: [],
      type: JSVAL,
      loc,
    };
    const source = args[0] === undefined
      ? null
      : ts.isObjectLiteralExpression(args[0])
        ? lowerIslandObjectLiteral(lowerer, args[0])
        : lowerer.jsvalIn(lowerer.lowerExpr(args[0]), args[0]);
    return {
      kind: "jsOp",
      op: "construct",
      args: source === null ? [ctor] : [ctor, source],
      type: JSVAL,
      loc,
    };
  }
  const source =
    args.length === 0
      ? dynUndefinedExpr(loc)
      : ts.isObjectLiteralExpression(args[0]!)
        ? lowerDynObjectLiteral(lowerer, args[0]!)
        : lowerLiveWebValue(lowerer, args[0]!);
  return {
    kind: "libCall",
    fn: "fetch.streamNew",
    args: [source],
    type: DYN,
    loc,
  };
}

/** `new Response(body?, init?)`. Dynamic builds construct the island's
 * Web Response directly. Static builds hand a checked-dynamic BodyInit and
 * ResponseInit snapshot to the native fetch runtime, which returns the same
 * opaque Response handle as fetch(). */
export function lowerResponseNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "Response"
  ) {
    return null;
  }
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const args = expr.arguments ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);

  if (lowerer.dynamic) {
    const ctor: IrExpr = {
      kind: "jsOp",
      op: "globalGet",
      name: "Response",
      args: [],
      type: JSVAL,
      loc,
    };
    const lowered = args.map((arg) =>
      ts.isObjectLiteralExpression(arg)
        ? lowerIslandObjectLiteral(lowerer, arg)
        : lowerer.jsvalIn(lowerer.lowerExpr(arg), arg)
    );
    return {
      kind: "jsOp",
      op: "construct",
      args: [ctor, ...lowered],
      type: JSVAL,
      loc,
    };
  }

  const toDyn = (
    node: ts.Expression | undefined,
    value: IrExpr,
    what: string,
  ): IrExpr => {
    if (node === undefined) return dynUndefinedExpr(loc);
    if (value.type.kind === "dyn") return value;
    /* A user class can satisfy ResponseInit structurally through plain
     * fields. Project just the declared dictionary members into a record,
     * then use the ordinary checked-dynamic copy. objRecordWidthHelper
     * deliberately declines accessors/methods, whose observable reads
     * cannot be moved into the runtime WebIDL conversion phase. */
    if (what === "an init value" && value.type.kind === "object") {
      const sourceType = lowerer.typeOf(node);
      const fields: { name: string; type: IrType }[] = [];
      for (const name of ["headers", "status", "statusText"] as const) {
        const property = lowerer.checker.getPropertyOfType(sourceType, name);
        if (!property) continue;
        const propertyType = lowerer.checker.getTypeOfSymbolAtLocation(property, node);
        const mapped = lowerer.mapTypeOf(propertyType);
        if (!mapped || mapped.kind === "void") {
          lowerer.noLowering(
            `new Response with ${what} of type '${lowerer.fmt(value.type)}'`,
            node,
            `the '${name}' field does not have a checked-dynamic representation`,
          );
        }
        fields.push({ name, type: mapped });
      }
      const recordType: IrType = {
        kind: "record",
        shapeId: lowerer.shapes.intern(
          fields,
          false,
          undefined,
          fields.map((field) => field.name),
        ),
      };
      const projected = lowerer.widthCoerce(value, recordType);
      if (projected && lowerer.dynConvertible(projected.type)) {
        return {
          kind: "dynFrom",
          value: projected,
          liveRef: true,
          type: DYN,
          loc: value.loc,
        };
      }
    }
    if (value.kind === "unitLit" || lowerer.dynConvertible(value.type)) {
      if (
        what === "an init value" &&
        hasLiveWebMutableArm(lowerer, value.type)
      ) {
        return {
          kind: "dynFrom",
          value,
          liveRef: true,
          type: DYN,
          loc: value.loc,
        };
      }
      return {
        kind: "dynFrom",
        value,
        type: DYN,
        loc: value.loc,
      };
    }
    lowerer.noLowering(
      `new Response with ${what} of type '${lowerer.fmt(value.type)}'`,
      node,
      "the static constructor accepts string, Uint8Array, ReadableStream, null, and the declared ResponseInit dictionary",
    );
  };

  const bodyNode = args[0];
  const body = bodyNode === undefined
    ? { kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc } satisfies IrExpr
    : lowerer.lowerExpr(bodyNode);
  const initNode = args[1];
  const init = initNode === undefined
    ? { kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc } satisfies IrExpr
    : ts.isObjectLiteralExpression(initNode)
      ? lowerDynObjectLiteral(
          lowerer,
          initNode,
          (node, value) => lowerLiveWebValue(lowerer, node, value),
        )
      : lowerer.lowerExpr(initNode);

  /* JavaScript evaluates every argument expression before WebIDL starts
   * converting either BodyInit or ResponseInit. Capture the raw values in
   * source order; only the final libCall boxes the body and gives typed init
   * values a live capsule for the runtime's later dictionary reads. This is
   * observable when argument evaluation or BodyInit coercion mutates a
   * Uint8Array body or a typed ResponseInit record. Unit-valued expressions
   * still execute, then contribute the corresponding undefined/null literal. */
  const stmts: IrStmt[] = [];
  const capture = (value: IrExpr, name: string): IrExpr => {
    if (isUnitType(value.type) || value.type.kind === "void") {
      if (value.kind !== "unitLit") {
        stmts.push({ kind: "exprStmt", expr: value, loc: value.loc });
      }
      return value.type.kind === "nullT"
        ? { kind: "unitLit", unit: "null", type: value.type, loc: value.loc }
        : {
            kind: "unitLit",
            unit: "undefined",
            type: { kind: "undefinedT" },
            loc: value.loc,
          };
    }
    const local = lowerer.declareHiddenLocal(name, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return {
      kind: "varRef",
      localId: local.id,
      type: local.type,
      loc: value.loc,
    };
  };
  const bodyRef = capture(body, "%responseBody");
  const initRef = capture(init, "%responseInit");
  for (const argument of args.slice(2)) {
    const discarded = ts.isVoidExpression(argument)
      ? lowerer.lowerExpr(argument.expression)
      : lowerer.lowerExpr(argument);
    stmts.push({ kind: "exprStmt", expr: discarded, loc: discarded.loc });
  }
  const result: IrExpr = {
    kind: "libCall",
    fn: "fetch.responseNew",
    args: [
      toDyn(bodyNode, bodyRef, "a body"),
      toDyn(initNode, initRef, "an init value"),
    ],
    type: DYN,
    loc,
  };
  return { kind: "seqExpr", stmts, result, type: DYN, loc };
}

/** A static default reader's read() exits the native checked-dynamic
 * transport into the checker's concrete chunk type. An exact chunk type
 * preserves ReadableStream.from(array)'s element identity; structural
 * widening keeps the compiler's ordinary copy-based width semantics. */
export function lowerStaticReadableStreamReaderCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    lowerer.dynamic ||
    call.questionDotToken ||
    call.arguments.length !== 0 ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(lowerer, access);
  if (member !== "read") return null;
  const receiverTs = lowerer.typeOf(access.expression);
  const symbol = receiverTs.getSymbol();
  if (
    symbol?.name !== "ReadableStreamDefaultReader" ||
    !lowerer.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        lowerer.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const type = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (
    type?.kind !== "promise" ||
    type.inner.kind !== "record"
  ) {
    return null;
  }
  const receiver = lowerer.lowerExprExpecting(access.expression, DYN);
  return lowerStaticFixedFetchMethodCall(
    lowerer,
    call,
    access,
    "read",
    receiver,
    [],
    (receiverRef) => ({
      kind: "libCall",
      fn: "fetch.readerRead",
      args: [receiverRef],
      type,
      loc: locOf(call),
    }),
  );
}

/** Dynamic `import(spec)` — the island's module system at a USER site.
   * Under --dynamic the call lowers to island.importDyn(key): the engine
   * loads the module (embedded npm graph, a shipped local .js/.mjs the
   * build embedded, or a builtin shim — collectDynamicImports resolved and
   * embedded the specifier at collection time) and answers an ENGINE
   * promise of the namespace object, bridged to a static
   * `Promise<jsval>` (jsBridgePromise, the fetch precedent) — so `await
   * import(x)` parks the fiber and resumes with the namespace HANDLE, and
   * a load/evaluation failure crosses as a catchable rejection, exactly
   * where Node puts it. Specifiers must be string literals: the module
   * graph is a BUILD-time artifact — a runtime-computed name has nothing
   * to embed, and the fence says so. Static builds report the per-site
   * SC2012. Null for anything that isn't `import(...)`. */
  export function lowerDynamicImportCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
    if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    lowerer.requireDynamicApi("'import()'", call);
    const loc = locOf(call);
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isStringLiteralLike(arg)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "dynamic import() of computed specifiers (the module graph embeds at " +
          "build time — the specifier must be a string literal)",
      );
    }
    if (call.arguments.length !== 1) {
      lowerer.unsupported("SC1090", call, "dynamic import() with import attributes");
    }
    const res = lowerer.dynImports.get(`${call.getSourceFile().fileName}\u0000${arg.text}`);
    if (!res) {
      // Collection walks every file before bodies lower, so a missing
      // entry is a lowerer bug, not user error.
      throw new InternalCompilerError(`lowerer bug: unresolved dynamic import '${arg.text}'`);
    }
    if (res.kind === "program-module") {
      return lowerOwnModuleImport(lowerer, call, arg);
    }
    if (res.kind !== "module") {
      throw new PoisonError(); // resolution failed — collection reported it
    }
    const raw: IrExpr = {
      kind: "libCall",
      fn: "island.importDyn",
      args: [{ kind: "strLit", value: res.key, type: STRING, loc }],
      type: JSVAL,
      loc,
    };
    return { kind: "jsBridgePromise", value: raw, type: { kind: "promise", inner: JSVAL }, loc };
  }

/** Dynamic `import()` of one of the program's OWN modules: the compiled
   * module's exports, marshaled into the engine as a namespace object.
   * The site lowers to `Promise.resolve().then(<builder>)` in the engine —
   * the builder is a synthesized compiled function (dynNsBuilderOf) that
   * runs on the engine MICROTASK, calls the target module's run-once %init
   * (Node's evaluation point for a module first reached through import():
   * after the importer's synchronous code, before the .then handlers), and
   * returns the exports object. Node differences (numbered divergences,
   * pinned in island.test.ts): the namespace is a SNAPSHOT taken when the
   * import resolves (Node's is live), a plain engine object (no Module
   * toStringTag, keys still sorted like Node's, each import minting a
   * fresh object where Node caches one), and exports with no island
   * representation (classes, generic functions, un-marshalable
   * signatures) cross as trap functions that throw a pointed TypeError
   * when USED — the namespace still builds, exactly like Node still
   * resolves it. */
  function lowerOwnModuleImport(lowerer: Lowerer, call: ts.CallExpression, arg: ts.StringLiteralLike): IrExpr {
    const loc = locOf(call);
    let dep: ts.SourceFile | null = null;
    const modSym = lowerer.checker.getSymbolAtLocation(arg);
    for (const d of (modSym ? lowerer.checker.declarationsOf(modSym) : [])) {
      if (ts.isSourceFile(d) && !d.isDeclarationFile) {
        dep = d;
        break;
      }
    }
    if (dep !== null && (dep.fileName.endsWith(".cts") || isCjsJsFile(dep))) {
      lowerer.unsupported(
        "SC1090",
        call,
        `dynamic import of the program's own CommonJS module '${arg.text}' ` +
          "(its namespace comes from module.exports through Node's CJS lexer, " +
          "which has no compiled story — require it, or import it statically)",
      );
    }
    const builder = dep !== null ? dynNsBuilderOf(lowerer, dep, loc) : null;
    if (builder === null) {
      lowerer.unsupported(
        "SC1090",
        call,
        `dynamic import of the program's own module '${arg.text}' ` +
          "(this module is not part of the compiled module graph — import it statically)",
      );
    }
    const promiseCtor: IrExpr = { kind: "jsOp", op: "globalGet", name: "Promise", args: [], type: JSVAL, loc };
    const resolved: IrExpr = { kind: "jsOp", op: "callMethod", name: "resolve", args: [promiseCtor], type: JSVAL, loc };
    const builderAsync = dep !== null && lowerer.asyncInitFiles.has(dep);
    const builderFn: IrType & { kind: "func" } = {
      kind: "func",
      params: [],
      ret: builderAsync ? { kind: "promise", inner: JSVAL } : JSVAL,
    };
    const marshaled: IrExpr = {
      kind: "jsMarshal",
      value: { kind: "closure", fnName: builder, captures: [], type: builderFn, loc },
      type: JSVAL,
      loc,
    };
    const chained: IrExpr = { kind: "jsOp", op: "callMethod", name: "then", args: [resolved, marshaled], type: JSVAL, loc };
    return { kind: "jsBridgePromise", value: chained, type: { kind: "promise", inner: JSVAL }, loc };
  }

/** The namespace-BUILDER function for one program module, synthesized on
   * first demand and shared by every import() of that module (deterministic
   * name per file tag, so the discovery and emit passes agree). Body: the
   * module's guarded %init (skipped for the entry — it is running or ran),
   * then `return { <sorted exports> }` as an engine object. Null when the
   * module never joined the compiled graph (no %init exists — an empty
   * preflight order or a cycle the extension refused). */
  function dynNsBuilderOf(lowerer: Lowerer, dep: ts.SourceFile, loc: IrExpr["loc"]): string | null {
    const cached = lowerer.dynNsBuilders.get(dep);
    if (cached !== undefined) return cached;
    const initName = lowerer.initNameOf.get(dep);
    if (initName === undefined) return null;
    const rawTag = lowerer.fileTag.get(dep) ?? "";
    const name = `%dynns.${rawTag === "" ? "e." : rawTag.replace(/^%/, "")}`;
    lowerer.dynNsBuilders.set(dep, name);
    const isAsync = lowerer.asyncInitFiles.has(dep);
    const fnCtx = newFnCtx(true, null, null, JSVAL);
    fnCtx.isAsync = isAsync;
    lowerer.fnStack.push(fnCtx);
    try {
      const body: IrStmt[] = [];
      // A synchronous entry has no run-once guard, so its historical
      // self-import path must not call %init again. An ASYNC entry does
      // have the stronger evaluation-promise cache: awaiting that cached
      // promise is essential for top-level `await import("./self")`,
      // which deadlocks (and ultimately exits 13) in Node rather than
      // exposing a half-evaluated namespace.
      if (dep !== lowerer.entry || isAsync) {
        const call: IrExpr = {
          kind: "call",
          callee: initName,
          args: [],
          type: isAsync ? { kind: "promise", inner: VOID } : VOID,
          loc,
        };
        const cyclePromiseId = lowerer.asyncCyclePromiseOf.get(dep);
        if (isAsync && cyclePromiseId !== undefined) {
          // Starting the REQUESTED member matters for dynamically-only
          // cycles: build-time discovery may have encountered another
          // member first, but Node roots evaluation at the first module
          // actually imported at runtime. The spawn wrapper publishes
          // that outermost promise in the SCC's shared slot after eager
          // recursive spawning returns. Discard the member promise here
          // and await the shared root before exposing any namespace.
          body.push({ kind: "exprStmt", expr: call, loc });
          const promiseT: IrType = { kind: "promise", inner: VOID };
          body.push({
            kind: "exprStmt",
            expr: {
              kind: "awaitExpr",
              value: { kind: "varRef", localId: cyclePromiseId, type: promiseT, loc },
              type: VOID,
              loc,
            },
            loc,
          });
        } else {
          body.push({
            kind: "exprStmt",
            expr: isAsync
              ? { kind: "awaitExpr", value: call, type: VOID, loc }
              : call,
            loc,
          });
        }
      }
      // Node sorts module-namespace keys (code-unit order); tsc erases
      // type-only exports, so only VALUE exports appear.
      const entries: [string, ts.Symbol][] = [];
      const modSym = lowerer.checker.getSymbolAtLocation(dep);
      modSym?.getExports().forEach((sym: ts.Symbol, key: ts.__String) => {
        const n = String(key);
        if (!n.startsWith("__") && n !== "export=") entries.push([n, sym]);
      });
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const args: IrExpr[] = [];
      for (const [exportName, sym] of entries) {
        const value = exportJsvalValue(lowerer, exportName, sym, loc);
        if (value === null) continue;
        args.push(
          { kind: "jsMarshal", value: { kind: "strLit", value: exportName, type: STRING, loc }, type: JSVAL, loc },
          value,
        );
      }
      body.push({ kind: "return", value: { kind: "jsOp", op: "objLit", args, type: JSVAL, loc }, loc });
      const ctx = lowerer.ctx;
      lowerer.liftedFns.push({
        name,
        params: [],
        returnType: JSVAL,
        locals: ctx.locals,
        captures: ctx.captures ?? [],
        body,
        ...(isAsync ? { async: true as const } : {}),
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
    return name;
  }

/** One export's island value for the namespace object — the jsvalIn
   * marshal set (primitives and JSON-safe composites by deep copy, units as
   * the engine's own, marshalable closures as host functions, jsval-bearing
   * composites through the per-field lift), with every UN-marshalable
   * export crossing as a trap function that throws a pointed TypeError when
   * called or constructed — the namespace still builds (Node resolves it;
   * only the USE has no compiled story). Null for exports that do not exist
   * at runtime (type-only). */
  function exportJsvalValue(lowerer: Lowerer, name: string, sym: ts.Symbol, loc: IrExpr["loc"]): IrExpr | null {
    const trap = (what: string): IrExpr =>
      islandTrapFnValue(
        lowerer,
        `the '${name}' export is ${what} of the compiled program, which cannot cross into dynamically-executed code yet`,
        loc,
      );
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      // `export type { x }` / `export { type x }`: erased at runtime.
      for (const d of lowerer.checker.declarationsOf(sym)) {
        if (ts.isExportSpecifier(d)) {
          const exportDecl = d.parent.parent;
          if (d.isTypeOnly || (ts.isExportDeclaration(exportDecl) && exportDecl.isTypeOnly)) return null;
        }
        if (ts.isImportSpecifier(d)) {
          const clause = d.parent.parent;
          if (d.isTypeOnly || (ts.isImportClause(clause) && clause.phaseModifier === ts.SyntaxKind.TypeKeyword)) return null;
        }
      }
      resolved = lowerer.checker.getAliasedSymbol(sym);
    }
    if (!(resolved.flags & ts.SymbolFlags.Value)) return null; // pure type surface
    const g = lowerer.globalsBySymbol.get(resolved);
    if (g) {
      const ref: IrExpr = { kind: "varRef", localId: g.id, type: g.type, loc };
      if (ref.type.kind === "jsval") return ref;
      if (isUnitType(ref.type)) {
        return { kind: "jsOp", op: ref.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc };
      }
      if (ref.type.kind === "func") {
        return canMarshalTypedFuncIntoIsland(ref.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
          ? { kind: "jsMarshal", value: ref, type: JSVAL, loc }
          : trap(`a function value of type '${lowerer.fmt(ref.type)}'`);
      }
      if (lowerer.boundarySafe(ref.type)) return { kind: "jsMarshal", value: ref, type: JSVAL, loc };
      if (lowerer.jsvalLiftable(ref.type)) return lowerer.jsvalLiftExpr(ref, loc);
      return trap(`a value of type '${lowerer.fmt(ref.type)}'`);
    }
    const sig = lowerer.fnSigsBySymbol.get(resolved);
    const decl0 = lowerer.checker.declarationsOf(resolved).find(
      (d) => ts.isFunctionDeclaration(d) && (ts.isSourceFile(d.parent) || lowerer.nsBlocks.get(d.parent) === "flattened"),
    );
    if (sig && decl0) {
      if (!sig.params.every((p) => p.mode === "required")) {
        return trap("a function with optional, default, or rest parameters");
      }
      const funcType: IrType & { kind: "func" } = {
        kind: "func",
        params: sig.params.map((p) => p.type),
        ret: sig.returnType,
      };
      if (!canMarshalTypedFuncIntoIsland(funcType, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) {
        return trap(`a function of type '${lowerer.fmt(funcType)}'`);
      }
      lowerer.noteEdge(sig.name);
      return {
        kind: "jsMarshal",
        value: { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc },
        type: JSVAL,
        loc,
      };
    }
    if (lowerer.genericFnsBySymbol.has(resolved)) return trap("a generic function");
    const flags = resolved.flags;
    if (flags & ts.SymbolFlags.Class) return trap("a class");
    if (flags & ts.SymbolFlags.Enum) return trap("an enum object");
    if (flags & ts.SymbolFlags.ValueModule || flags & ts.SymbolFlags.NamespaceModule) {
      return trap("a namespace object");
    }
    return trap("a binding");
  }

/** An engine value whose any USE throws: `new Function("<throw>")` — a
   * real engine function, so the namespace member reads back fine (Node's
   * namespace holds the value too), property probes answer like a
   * function's, and calling or `new`-ing it runs the body, which throws
   * the pointed TypeError. */
  function islandTrapFnValue(lowerer: Lowerer, message: string, loc: IrExpr["loc"]): IrExpr {
    void lowerer;
    const code = `throw new TypeError(${JSON.stringify(message)})`;
    return {
      kind: "jsOp",
      op: "construct",
      args: [
        { kind: "jsOp", op: "globalGet", name: "Function", args: [], type: JSVAL, loc },
        { kind: "jsMarshal", value: { kind: "strLit", value: code, type: STRING, loc }, type: JSVAL, loc },
      ],
      type: JSVAL,
      loc,
    };
  }

/** An object literal built NATIVELY in the island — one engine object,
   * each field marshaled individually (nested object/array literals
   * recurse, island handles pass straight through, everything else takes
   * the JSON-safe copy-marshal). The same jsOp the 'any'-contextual
   * literal path emits, callable from lowerings that KNOW the literal is
   * island-bound (fetch's init) even when the contextual type is a union
   * the generic path declines. Spelled and pure const-folded computed keys
   * are admitted; engine property names have no identifier restriction. Plain
   * spreads copy through the engine's CopyDataProperties operation in
   * source order, including nested RequestInit/header dictionaries. */
  function lowerIslandObjectLiteral(lowerer: Lowerer, expr: ts.ObjectLiteralExpression): IrExpr {
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
          ? lowerIslandObjectLiteral(lowerer, prop.expression)
          : lowerer.jsvalIn(lowerer.lowerExpr(prop.expression), prop.expression);
        acc ??= { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc };
        acc = { kind: "jsOp", op: "objSpread", args: [acc, spread], type: JSVAL, loc: locOf(prop) };
        continue;
      }
      if (
        !ts.isPropertyAssignment(prop) &&
        !ts.isShorthandPropertyAssignment(prop) &&
        !ts.isMethodDeclaration(prop)
      ) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "this property form in an island-built object literal (use a spelled or pure const-folded key with a value or method)",
        );
      }
      const propertyName = requestInitLiteralKey(lowerer, prop);
      if (propertyName === null) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "this property key in an island-built object literal (use a spelled or pure const-folded key)",
        );
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
        args.push(lowerIslandObjectLiteral(lowerer, valueNode));
      } else if (
        ts.isArrayLiteralExpression(valueNode) &&
        !valueNode.elements.some(ts.isSpreadElement)
      ) {
        const elems = valueNode.elements.map((el) => lowerer.jsvalIn(lowerer.lowerExpr(el), el));
        args.push({ kind: "jsOp", op: "arrLit", args: elems, type: JSVAL, loc: locOf(valueNode) });
      } else {
        const value = ts.isMethodDeclaration(valueNode)
          ? (lowerer.rejectThisInObjectMethod(valueNode.body ?? valueNode), lowerer.lowerLambda(valueNode))
          : lowerer.lowerExpr(valueNode);
        args.push(lowerer.jsvalIn(value, valueNode));
      }
    }
    flushFields();
    return acc ?? { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc };
  }

/** Method calls on the island-backed ambient surface: `Math.<fn>(...)`
   * (the engine's own Math object executes) and the number/string methods
   * the static runtime doesn't implement (`x.toPrecision(2)`,
   * `s.replace("a", "b")`, ...). Each site is self-contained — the receiver
   * and arguments marshal in, the engine executes with JS-exact semantics,
   * and the result exits (validated) to the DECLARED static return type,
   * so no jsval leaks into the program's types. tsc has already checked
   * receiver, arity, and argument types against ambient/scriptc.d.ts; an
   * ambient member missing from ISLAND_SURFACE returns null into the
   * existing generic rejections. */
  export function lowerIslandMethodCall(lowerer: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (lowerer.chainBlocked(access, call)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    const finish = (receiver: IrExpr, entry: IslandFnEntry): IrExpr => {
      const args = call.arguments.map((a) => lowerer.jsvalIn(lowerer.lowerExpr(a), a));
      const result: IrExpr = {
        kind: "jsOp", op: "callMethod", name, args: [receiver, ...args], type: JSVAL, loc,
      };
      return { kind: "jsExit", value: result, type: entry.ret, loc };
    };
    // `AbortSignal.timeout(ms)` / `.abort(reason?)` / `.any(signals)` —
    // the fetch-cancellation ambient: the engine's own AbortSignal mints
    // the signal, which stays a HANDLE (its checker type, AbortSignal,
    // maps to jsval — see ISLAND_AMBIENT_TYPES) so it can ride a
    // RequestInit literal into fetch without a JSON detour. The prelude
    // implements all three statics.
    {
      const sigMember = lowerer.stdlibGlobalMember(access, "AbortSignal");
      if (
        (sigMember === "timeout" || sigMember === "abort" || sigMember === "any") &&
        call.arguments.every((argument) => !ts.isSpreadElement(argument))
      ) {
        lowerer.requireDynamicApi(`'AbortSignal.${sigMember}'`, call);
        const args = call.arguments.map((a) => lowerer.jsvalIn(lowerer.lowerExpr(a), a));
        const signalGlobal: IrExpr = {
          kind: "jsOp", op: "globalGet", name: "AbortSignal", args: [], type: JSVAL, loc,
        };
        return {
          kind: "jsOp", op: "callMethod", name: sigMember,
          args: [signalGlobal, ...args], type: JSVAL, loc,
        };
      }
    }
    if (
      lowerer.stdlibGlobalMember(access, "ReadableStream") === "from" &&
      call.arguments.every((argument) => !ts.isSpreadElement(argument))
    ) {
      lowerer.requireDynamicApi("'ReadableStream.from'", call);
      const streamGlobal: IrExpr = {
        kind: "jsOp",
        op: "globalGet",
        name: "ReadableStream",
        args: [],
        type: JSVAL,
        loc,
      };
      return {
        kind: "jsOp",
        op: "callMethod",
        name: "from",
        args: [
          streamGlobal,
          ...call.arguments.map((argument) =>
            lowerer.jsvalIn(lowerer.lowerExpr(argument), argument)
          ),
        ],
        type: JSVAL,
        loc,
      };
    }
    const isMath = lowerer.stdlibGlobalMember(access, "Math") !== null;
    // The STATIC Math members (floor/min/max/random): one C call IS the
    // JS operation — no island, no --dynamic. Only the tabled arity with
    // plain (non-spread) arguments takes this path; other forms fall
    // through to the spread fold / island / lib fence below.
    const staticMath = isMath ? own(STATIC_MATH_FNS, name) : undefined;
    if (
      staticMath &&
      call.arguments.every((a) => !ts.isSpreadElement(a))
    ) {
      // Math.max/Math.min at ANY plain arity — Node's are variadic. The
      // spec's reduction is a left fold of the same NaN-poisoning
      // ±0-ordered scalar compare the two-arg form lowers to, so n
      // arguments nest n-1 scalar calls (arguments still evaluate left to
      // right, before any compare that involves them). One argument is
      // the value itself (every argument here is number-typed, so the
      // spec's ToNumber is the identity — NaN included), and zero
      // arguments are the fold's seed: -Infinity for max, +Infinity for
      // min, exactly Node.
      if (name === "max" || name === "min") {
        if (call.arguments.length === 0) {
          return { kind: "numLit", value: name === "max" ? -Infinity : Infinity, type: F64, loc };
        }
        const args = call.arguments.map((a) => lowerer.lowerExprExpecting(a, F64));
        let acc = args[0]!;
        for (let i = 1; i < args.length; i++) {
          acc = { kind: "libCall", fn: staticMath.fn, args: [acc, args[i]!], type: F64, loc };
        }
        return acc;
      }
      if (call.arguments.length === staticMath.arity) {
        const args = call.arguments.map((a) => lowerer.lowerExprExpecting(a, F64));
        return { kind: "libCall", fn: staticMath.fn, args, type: F64, loc };
      }
    }
    // `Math.max(...xs)` / `Math.min(...xs)` over a number[]: a STATIC
    // runtime fold (JS-exact: NaN poisons, ±0 order by the JS rules, the
    // empty array yields ∓Infinity like the zero-arg calls) — no island
    // involved, so it works without --dynamic too. Only the exact
    // one-spread form lowers; mixed spread/positional argument lists keep
    // the nest-calls fence.
    if (
      isMath &&
      (name === "max" || name === "min") &&
      call.arguments.length === 1 &&
      ts.isSpreadElement(call.arguments[0]!)
    ) {
      const spread = call.arguments[0]! as ts.SpreadElement;
      const src = lowerer.lowerExpr(spread.expression);
      if (src.type.kind !== "array" || src.type.elem.kind !== "f64") {
        lowerer.unsupported(
          "SC1090",
          spread,
          `spreading '${lowerer.fmt(src.type)}' into Math.${name} (only a number[] spreads)`,
        );
      }
      return {
        kind: "libCall",
        fn: name === "max" ? "math.maxArr" : "math.minArr",
        args: [src],
        type: F64,
        loc,
      };
    }
    const mathFn = isMath ? own(ISLAND_SURFACE.math.fns, name) : undefined;
    if (mathFn && call.arguments.length === mathFn.args.length) {
      lowerer.requireDynamicApi(`'Math.${name}'`, call);
      return finish(
        { kind: "jsOp", op: "globalGet", name: "Math", args: [], type: JSVAL, loc },
        mathFn,
      );
    }
    const kind = lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind;
    const entry =
      kind === "f64"
        ? own(ISLAND_SURFACE.number, name)
        : kind === "string"
          ? own(ISLAND_SURFACE.string, name)
          : undefined;
    if (!entry || call.arguments.length !== entry.args.length) return null;
    if (!lowerer.isStdlibMember(access)) return null;
    lowerer.requireDynamicApi(
      `'.${name}()' on ${kind === "f64" ? "numbers" : "strings"}`,
      call,
    );
    return finish(lowerer.jsvalIn(lowerer.lowerExpr(access.expression), access.expression), entry);
  }

  export function lowerMathProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    const member = lowerer.stdlibGlobalMember(expr, "Math");
    if (member === null) return null;
    const loc = locOf(expr);
    const staticPropValue = own(STATIC_MATH_PROPS, member);
    if (staticPropValue !== undefined) {
      return { kind: "numLit", value: staticPropValue, type: F64, loc };
    }
    const propType = own(ISLAND_SURFACE.math.props, member);
    if (propType !== undefined) {
      lowerer.requireDynamicApi(`'Math.${member}'`, expr);
      const math: IrExpr = { kind: "jsOp", op: "globalGet", name: "Math", args: [], type: JSVAL, loc };
      const read: IrExpr = { kind: "jsOp", op: "getProp", name: member, args: [math], type: JSVAL, loc };
      return { kind: "jsExit", value: read, type: propType, loc };
    }
    if (
      own(ISLAND_SURFACE.math.fns, member) !== undefined ||
      own(STATIC_MATH_FNS, member) !== undefined
    ) {
      lowerer.unsupported("SC1090", expr, `Math methods as values (call '${member}' directly)`);
    }
    return null; // declared-but-untabled members fall through generically
  }

/** The npm package a type is declared by ("commander", "@scope/pkg"),
   * or null when the type isn't package-declared. Union parts are searched
   * too: `string | Command` fails mapping as a whole, but the blame (and
   * the --dynamic attribution) belongs to the package-declared part. */
  export function npmPackageOf(lowerer: Lowerer, type: ts.Type): string | null {
    const pkg = lowerer.npmPackageOfSymbol(type.getAliasSymbol() ?? type.getSymbol());
    if (pkg) return pkg;
    if (type.isUnionType()) {
      for (const part of ts.constituentTypes(type)) {
        const partPkg = lowerer.npmPackageOf(part);
        if (partPkg) return partPkg;
      }
    }
    return null;
  }

/** The npm chokepoint for member reads and method calls in a STATIC
   * build: a receiver whose type (or member whose symbol) a package's
   * .d.ts declares means the operation runs in the embedded engine —
   * attribute the site to the package instead of the generic property/
   * method rejection. No-op under --dynamic (the island paths claimed
   * these) and for non-package receivers, so callers' fallbacks apply. */
  export function npmMemberFence(lowerer: Lowerer, access: ts.PropertyAccessExpression): void {
    if (lowerer.dynamic) return;
    const pkg =
      lowerer.npmPackageOf(lowerer.typeOf(access.expression)) ??
      lowerer.npmPackageOfSymbol(lowerer.checker.getSymbolAtLocation(access.name));
    if (!pkg) return;
    lowerer.pushDiag(requiresDynamicPackageDiag(pkg, locOf(access)));
    throw new PoisonError();
  }

/** The npm package a SYMBOL is declared by, or null. The symbol half of
   * npmPackageOf, also asked directly for import-alias bindings (whose
   * aliased symbol is the package's export). */
  export function npmPackageOfSymbol(lowerer: Lowerer, sym: ts.Symbol | undefined): string | null {
    const decls = sym ? lowerer.checker.declarationsOf(sym) : undefined;
    if (!decls || decls.length === 0) return null;
    if (!decls.every((d) => lowerer.isNpmFile(d.getSourceFile()))) return null;
    return npmPackageNameOf(decls[0]!.getSourceFile().fileName);
  }
