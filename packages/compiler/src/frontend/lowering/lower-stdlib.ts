import { dynUndefinedExpr, nodeThrowExpr } from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";

import * as ts from "../ts7/adapter.js";
import { lowerToNumberArguments } from "./lower-exprs.js";
import type { Lowerer } from "./lowerer.js";
import { isDeclaredInAmbientNamespace } from "../type-mapper.js";
import {
  arrayOf,
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  STRING,
  VOID,
  canConvertToDyn,
  isUnitType,
} from "../../ir/ir.js";
import {
  STDLIB_SURFACE,
  type StdlibFnEntry,
  STATIC_MATH_FNS,
  STATIC_MATH_PROPS,
  stdlibGlobalNameOf,
} from "./surfaces.js";
import {
  unsupportedNativeApiDiag,
  unsupportedPackageValueDiag,
} from "../../diagnostics/diagnostic.js";
import { esmNamedImportLinkCrash, isCjsJsFile, locOf, npmPackageNameOf } from "../program.js";
import { foldedStringKeyOf, lowerDynObjectLiteral } from "./expressions/object-literals.js";
import { noteEventListeners } from "./lower-event-target.js";
import { PoisonError, newFnCtx, own } from "./lowerer.js";
import { node24FetchCompatProfile, staticFetchMembers } from "../../compat/fetch-profile.js";
import { classGeneratorIterable } from "./class-iterables.js";
import { generatorDrain } from "./iterator-adapters.js";

export function refuseUnsupportedApi(
  lowerer: Lowerer,
  feature: string,
  node: ts.Node,
  hint?: string,
): never {
  lowerer.pushDiag(unsupportedNativeApiDiag(feature, locOf(node), hint));
  throw new PoisonError();
}

export function stdlibGlobalFnOf(lowerer: Lowerer, ident: ts.Identifier): StdlibFnEntry | null {
  const entry = own(STDLIB_SURFACE.globals, ident.text);
  if (!entry) return null;
  const symbol = lowerer.resolveValueSymbol(ident);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  return entry;
}

function requestInitLiteralKey(lowerer: Lowerer, prop: ts.ObjectLiteralElementLike): string | null {
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

/** Unwrap assertions and parentheses when checking RequestInit values.
 * Computed runtime keys and non-literal objects are also validated by the
 * native runtime. */
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
  if (lowerer.requestInitPropMutatedSyms) {
    return lowerer.requestInitPropMutatedSyms;
  }
  const symbols = new Set<ts.Symbol>();
  const noteBase = (target: ts.Expression): void => {
    let base = requestInitValueExpr(target);
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
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
  for (const source of lowerer.program.getImplementationSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        noteBase(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))
      ) {
        noteBase(node.operand);
      } else if (ts.isDeleteExpression(node)) {
        noteBase(node.expression);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  lowerer.requestInitPropMutatedSyms = symbols;
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
    return (
      requestInitConstBacked(lowerer, expr.whenTrue, new Set(seen)) &&
      requestInitConstBacked(lowerer, expr.whenFalse, new Set(seen))
    );
  }
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return false;
  if (requestInitPropMutatedSymbols(lowerer).has(symbol)) return false;
  seen.add(symbol);
  const declarations = symbol.declarations.filter(
    (declaration): declaration is ts.VariableDeclaration =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
  );
  return (
    declarations.length > 0 &&
    declarations.every((declaration) =>
      requestInitConstBacked(lowerer, declaration.initializer!, new Set(seen)),
    )
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
    for (let i = expr.properties.nodes.length - 1; i >= 0; i--) {
      const property = expr.properties.nodes[i]!;
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
      } else if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        visit(property.name);
      }
      return true;
    }
    return false;
  }
  if (selector.kind === "index" && ts.isArrayLiteralExpression(expr)) {
    const element = expr.elements.nodes[selector.index];
    if (element === undefined || ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
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
  for (const declaration of symbol.declarations) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      sawDeclaration = true;
      if (
        !visitRequestInitConstSelectedValues(
          lowerer,
          declaration.initializer,
          selector,
          new Set(seen),
          visit,
        )
      ) {
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
      const index = pattern.elements.nodes.indexOf(current);
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
    if (
      !visitRequestInitConstBindingValues(lowerer, nested, selectors.slice(1), new Set(seen), visit)
    ) {
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
  for (const declaration of symbol.declarations) {
    if (ts.isPropertyAssignment(declaration)) {
      fenceRequestInitValueInner(lowerer, declaration.initializer, seen);
    } else if (ts.isShorthandPropertyAssignment(declaration) && ts.isIdentifier(declaration.name)) {
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
  const contextualArms = contextual?.isUnionType()
    ? ts.constituentTypes(contextual)
    : contextual
      ? [contextual]
      : [];
  const rows = node24FetchCompatProfile().inventory.entries.filter(
    (entry) => entry.owner === "RequestInit" && entry.placement === "dictionary",
  );
  const shadowed = new Set<string>();
  const fence = (row: (typeof rows)[number], value: ts.Expression | null, blame: ts.Node): void => {
    if (row.status === "static") return;
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
      `RequestInit option '${row.member}'${" in a static build"}`,
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
  for (let index = init.properties.nodes.length - 1; index >= 0; index--) {
    const prop = init.properties.nodes[index]!;
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
  for (const declaration of symbol.declarations) {
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

function fenceRequestInitValue(lowerer: Lowerer, value: ts.Expression): void {
  fenceRequestInitValueInner(lowerer, value, new Set());
}

export function lowerFetchCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "fetch") return null;
  if (call.questionDotToken) return null;
  const symbol = lowerer.resolveValueSymbol(callee);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  if (call.arguments.nodes.length < 1) return null;
  const loc = locOf(call);
  const initNode = call.arguments.nodes[1];
  if (initNode !== undefined) fenceRequestInitValue(lowerer, initNode);
  {
    const inputNode = call.arguments.nodes[0]!;
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
    for (const argument of call.arguments.nodes.slice(2)) {
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
    // A union input holding a URL arm (`string | URL`) converts through the
    // checked-dynamic input path, which reads the URL's href at the call
    // like the bare-URL arm below; narrowing it to a string would throw on
    // the URL arm.
    const unionWithUrl =
      input.type.kind === "union" &&
      (lowerer.unions.get(input.type.unionId)?.arms.some((arm) => arm.kind === "url") ?? false) &&
      lowerer.dynConvertible(input.type);
    const dynInput: IrExpr | null =
      input.type.kind === "dyn"
        ? inputRef
        : unionWithUrl
          ? { kind: "dynFrom", value: inputRef, type: DYN, loc: locOf(inputNode) }
          : null;
    const url: IrExpr =
      input.type.kind === "url"
        ? {
            kind: "libCall",
            fn: "url.href",
            args: [inputRef],
            type: STRING,
            loc: locOf(inputNode),
          }
        : dynInput !== null
          ? dynInput
          : lowerer.coerceInto(inputNode, inputRef, STRING);
    const answer: IrExpr = {
      kind: "libCall",
      fn: dynInput !== null ? "fetch.input" : "fetch.start",
      args: [url, initRef],
      type: { kind: "promise", inner: DYN },
      loc,
    };
    return { kind: "seqExpr", stmts, result: answer, type: answer.type, loc };
  }
}

/** Static Response.json(): consume the native Response's readable body
 * stream and parse its UTF-8 payload into the ordinary checked-dynamic
 * JSON tree. Syntax and stream failures reject at await like the web API. */
export function lowerStaticResponseCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (
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
    (member !== "json" && member !== "text" && member !== "bytes" && member !== "arrayBuffer") ||
    call.arguments.nodes.length !== 0
  ) {
    return null;
  }
  const recvType = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || ts.symbolName(sym) !== "Response" || !lowerer.isStdlibSymbol(sym)) return null;
  const recv = lowerer.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  return lowerStaticFixedFetchMethodCall(lowerer, call, access, member, recv, [], (receiver) =>
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
          fn: member === "arrayBuffer" ? "fetch.responseArrayBuffer" : "fetch.responseJson",
          args: [receiver],
          type: { kind: "promise", inner: DYN },
          loc: locOf(call),
        },
  );
}

type StaticResponseAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function staticResponseMemberName(lowerer: Lowerer, access: StaticResponseAccess): string | null {
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
  const receiverLocal = lowerer.declareHiddenLocal("%fetchReceiver", receiver.type);
  const keyLocal = lowerer.declareHiddenLocal("%fetchMember", STRING);
  const argumentLocals = argumentValues.map((argument) =>
    lowerer.declareHiddenLocal("%fetchMethodArg", argument.type),
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
    else_: nodeThrowExpr(1, "", `${ts.getTextOfNode(access)} is not a function`, answer.type, loc),
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
      ...argumentValues.map((argument, index): IrStmt => ({
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

function fetchElementMemberNames(lowerer: Lowerer, keyExpr: ts.Expression): string[] | null {
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

function fetchAccessMemberNames(lowerer: Lowerer, access: StaticResponseAccess): string[] | null {
  return ts.isPropertyAccessExpression(access)
    ? [access.name.text]
    : fetchElementMemberNames(lowerer, access.argumentExpression);
}

function fetchInventoryStatus(
  owner: string,
  member: string,
  placement: "static" | "prototype" | "prototype-symbol",
): "static" | "unsupported" | "out-of-scope" | null {
  return (
    node24FetchCompatProfile().inventory.entries.find(
      (entry) => entry.owner === owner && entry.member === member && entry.placement === placement,
    )?.status ?? null
  );
}

function fetchInventoryReason(
  owner: string,
  member: string,
  placement: "static" | "prototype" | "prototype-symbol",
): string | undefined {
  return node24FetchCompatProfile().inventory.entries.find(
    (entry) => entry.owner === owner && entry.member === member && entry.placement === placement,
  )?.reason;
}

/** Constructor-object operations are distinct from Response instance
 * methods. The inventory marks the former unsupported; fence
 * them explicitly so the generic call fallback cannot report SC1090 for
 * Response.json while the other statics report SC2020. */
export function fenceUnsupportedFetchConstructorMember(
  lowerer: Lowerer,
  access: StaticResponseAccess,
): IrExpr | null {
  if (!lowerer.isStdlibGlobal(access.expression, "Response")) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const member = members.find(
    (candidate) => fetchInventoryStatus("Response", candidate, "static") === "unsupported",
  );
  if (member === undefined) return null;
  lowerer.noLowering(
    `Response.${member}`,
    access,
    "Response static constructor-object operations have no compiler lowering",
  );
}

function hasLiveWebMutableArm(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "record" || type.kind === "array" || type.kind === "bytes") {
    return true;
  }
  if (type.kind !== "union") return false;
  return (
    lowerer.unions.get(type.unionId)?.arms.some((arm) => hasLiveWebMutableArm(lowerer, arm)) ??
    false
  );
}

/** Box mutable data for Web API slots that expose the exact JavaScript
 * value again. Ordinary dynFrom remains the documented copy boundary;
 * this capsule is deliberately limited to records/arrays/bytes (including
 * those selected at runtime from a union) that the live materializer can
 * snapshot and commit. */
export function lowerLiveWebValue(lowerer: Lowerer, node: ts.Expression, lowered?: IrExpr): IrExpr {
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
        ((owner === "ReadableStream" || owner === "ReadableStreamDefaultReader") &&
          members.includes("cancel")) ||
        (owner === "AbortController" && members.includes("abort")))) ||
    (index === 1 &&
      owner === "AbortSignal" &&
      members.some((member) => member === "addEventListener" || member === "removeEventListener"))
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
  if (!sym || ts.symbolName(sym) !== "Response" || !lowerer.isStdlibSymbol(sym)) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const status = (member: string) =>
    fetchInventoryStatus(
      "Response",
      member,
      member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
    );

  const projected = staticFetchMembers();
  const supported = (member: string) =>
    use === "call" ? projected.responseCalls.has(member) : projected.responseReads.has(member);
  if (members.every(supported)) return null;
  const member = members.find((candidate) => !supported(candidate))!;
  if (status(member) === "unsupported") {
    lowerer.noLowering(
      `Response.${member}`,
      access,
      fetchInventoryReason("Response", member, "prototype") ??
        "this Response operation has no compiler lowering",
      sym,
    );
  }
  lowerer.noLowering(
    `Response.${member} in a static build`,
    access,
    "the native static Response surface is status/ok/statusText/url/redirected/headers/body/bodyUsed plus json(), text(), bytes(), and arrayBuffer(); other forms are unsupported",
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
  if (!sym || ts.symbolName(sym) !== "Headers" || !lowerer.isStdlibSymbol(sym)) return null;
  const members = fetchAccessMemberNames(lowerer, access);
  if (members === null) return null;
  const status = (member: string) =>
    fetchInventoryStatus(
      "Headers",
      member,
      member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
    );

  const headersCalls = staticFetchMembers().headersCalls;
  if (use === "call" && members.every((member) => headersCalls.has(member))) return null;
  const member = members.find((candidate) => use !== "call" || !headersCalls.has(candidate))!;
  if (status(member) === "unsupported") {
    lowerer.noLowering(
      `Headers.${member}`,
      access,
      "symbol-keyed Headers iteration is unsupported; use forEach()",
      sym,
    );
  }
  lowerer.noLowering(
    `Headers.${member} in a static build`,
    access,
    "the native static Headers surface is append/delete/get/getSetCookie/has/set/forEach; keys()/values()/entries(), symbol-keyed iteration, and construction remain unsupported",
    sym,
  );
}

/** The native AbortController handle dispatches `abort()` directly and
 * exposes `.signal` as data, but it has no first-class function value for
 * the prototype method. Fence method extraction before the checked-dynamic
 * keyed-read fallback can answer `undefined` without a diagnostic. */
export function fenceStaticAbortControllerMemberRead(
  lowerer: Lowerer,
  access: StaticResponseAccess,
): IrExpr | null {
  const symbol = isStdlibFetchInterface(lowerer, access.expression, "AbortController");
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

function isStdlibFetchInterface(lowerer: Lowerer, node: ts.Node, owner: string): ts.Symbol | null {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
    // NodeJS.ReadableStream shares the WHATWG interface's name.
    if (
      symbol !== undefined &&
      ts.symbolName(symbol) === owner &&
      lowerer.isStdlibSymbol(symbol) &&
      !symbol.declarations.some(
        (d) => ts.isInterfaceDeclaration(d) && isDeclaredInAmbientNamespace(d, "NodeJS"),
      )
    )
      return symbol;
  }
  return null;
}

/** The statically represented element channel of a native Web
 * ReadableStream. The stream itself remains an opaque checked-dynamic
 * handle, but its generic argument is the contract reader.read() exits
 * through. Null means this is not the standard-library ReadableStream or
 * its element cannot be represented statically. */
export function staticReadableStreamElementType(
  lowerer: Lowerer,
  node: ts.Expression,
): IrType | null {
  if (!isStdlibFetchInterface(lowerer, node, "ReadableStream")) {
    return null;
  }
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  const [element] = lowerer.checker.getTypeArguments(type as ts.TypeReference);
  return element ? lowerer.mapTypeOf(element) : DYN;
}

function fetchObjectBindingMemberName(lowerer: Lowerer, element: ts.BindingElement): string | null {
  const name =
    element.propertyName ??
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
  const symbol = [type.getSymbol(), type.getAliasSymbol()].find(
    (candidate) =>
      candidate !== undefined &&
      node24FetchCompatProfile().inventory.interfaces.includes(ts.symbolName(candidate)) &&
      lowerer.isStdlibSymbol(candidate),
  );
  return symbol ? { owner: ts.symbolName(symbol), symbol } : null;
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
    const row = node24FetchCompatProfile().inventory.entries.find(
      (entry) =>
        entry.owner === owner &&
        entry.member === member &&
        (entry.placement === "prototype" ||
          entry.placement === "prototype-inherited" ||
          entry.placement === "prototype-symbol"),
    );
    if (!row || row.status === "out-of-scope") continue;

    // Static data properties retain the ordinary checked-dynamic keyed-read
    // lowering. Only a method extraction loses the receiver that its direct
    // call bridge would preserve; non-static rows keep their inventory fence.
    const operation = node24FetchCompatProfile().operations.find(
      (candidate) => candidate.id === row.id,
    );
    if (row.status === "static" && operation?.kind === "property") {
      continue;
    }
    lowerer.noLowering(
      `${owner}.${member}${" through object destructuring in a static build"}`,
      node,
      row.reason ??
        "the direct lowered read/call form has a compiler bridge, but extracting this member as a value does not",
      symbol,
    );
  }
}

export function fenceFetchObjectBinding(lowerer: Lowerer, pattern: ts.ObjectBindingPattern): void {
  fenceFetchObjectMembers(
    lowerer,
    pattern,
    pattern.elements.nodes.flatMap((element) => {
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
    target.properties.nodes.flatMap((property) => {
      const member = fetchObjectAssignmentMemberName(lowerer, property);
      return member === null ? [] : [{ member, node: property }];
    }),
  );
}

/** Iteration syntax invokes Headers[Symbol.iterator] without constructing
 * an element-access node, so the member chokepoint above never sees it.
 * Use the same SC2020 profile row for for-of, array spread, and array destructuring. */
export function fenceStaticHeadersIteration(lowerer: Lowerer, node: ts.Node): void {
  // The initializer is the value being iterated. Asking for the binding
  // pattern's synthesized tuple type can panic in TypeScript serialization.
  const source =
    ts.isArrayBindingPattern(node) &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer
      ? node.parent.initializer
      : node;
  const value = ts.isExpression(source) ? requestInitValueExpr(source) : source;
  const sym = isStdlibFetchInterface(lowerer, value, "Headers");
  if (!sym) return;
  lowerer.noLowering(
    "Headers.[Symbol.iterator] in a static build",
    node,
    "Headers iteration is unsupported; use append/delete/get/getSetCookie/has/set/forEach",
    sym,
  );
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
    call.arguments.nodes.some((argument) => ts.isSpreadElement(argument))
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
    node24FetchCompatProfile().inventory.entries.find(
      (entry) =>
        entry.owner === resolved.owner &&
        entry.member === member &&
        (entry.placement === "prototype" || entry.placement === "prototype-inherited"),
    ),
  );
  if (
    rows.some(
      (row) => row === undefined || row.status === "out-of-scope" || row.status !== "static",
    )
  ) {
    return null;
  }

  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const key = lowerer.lowerExpr(access.argumentExpression);
  if (key.type.kind !== "string") return null;
  const loc = locOf(call);
  const receiverLocal = lowerer.declareHiddenLocal("%fetchReceiver", DYN);
  const keyLocal = lowerer.declareHiddenLocal("%fetchMember", STRING);
  const argumentValues = call.arguments.nodes.map((argument, index) =>
    fetchMethodArgumentIsLive(resolved.owner, members, index)
      ? lowerLiveWebValue(lowerer, argument)
      : lowerer.lowerExprExpecting(argument, DYN),
  );
  const argumentLocals = argumentValues.map((argument) =>
    lowerer.declareHiddenLocal("%fetchMethodArg", argument.type),
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
  const memberReadStmt: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "dynKeyGet",
      value: receiverRef,
      key: keyRef,
      type: DYN,
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
    resolved.owner === "Response" &&
    call.arguments.nodes.length === 0 &&
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
    staticResponsePromise !== null
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
          calleeName: ts.getTextOfNode(access),
          args: argumentRefs,
          type: DYN,
          loc,
        };
  // Literal-string unions share the STRING carrier. A cast can therefore
  // smuggle a different runtime key into this call; validate all arms and
  // throw "is not a function" rather than dispatching every mismatch to the
  // last member.
  const invocationType = staticResponsePromise ?? DYN;
  let result: IrExpr = nodeThrowExpr(
    1,
    "",
    `${ts.getTextOfNode(access)} is not a function`,
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
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: keyLocal.id, init: key, loc },
      memberReadStmt,
      ...argumentValues.map((argument, index): IrStmt => ({
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
  const status = (member: string) =>
    fetchInventoryStatus(
      "ReadableStream",
      member,
      member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
    );

  const projected = staticFetchMembers();
  const supported = (member: string) =>
    use === "call"
      ? projected.readableStreamCalls.has(member)
      : projected.readableStreamReads.has(member);
  if (members.every(supported)) return null;
  const member = members.find((candidate) => !supported(candidate))!;
  if (status(member) === "unsupported") {
    lowerer.noLowering(
      `ReadableStream.${member}`,
      access,
      fetchInventoryReason(
        "ReadableStream",
        member,
        member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype",
      ) ?? "this ReadableStream operation has no compiler lowering",
      sym,
    );
  }
  lowerer.noLowering(
    `ReadableStream.${member} in a static build`,
    access,
    "the native static ReadableStream surface is locked plus cancel() and getReader(); values()/[Symbol.asyncIterator]() compile when consumed directly by for await, while stored iterator handles remain unsupported",
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
  if (call.arguments.nodes.length <= 1) return first;
  const firstLocal = lowerer.declareHiddenLocal("%fetchArg", first.type);
  const firstRef: IrExpr = {
    kind: "varRef",
    localId: firstLocal.id,
    type: first.type,
    loc,
  };
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: firstLocal.id, init: first, loc }];
  for (const argument of call.arguments.nodes.slice(1)) {
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
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    !ts.isIdentifier(call.expression.expression)
  ) {
    return null;
  }
  const root = call.expression.expression;
  const symbol = lowerer.resolveValueSymbol(root);
  if ((!symbol || !lowerer.isStdlibSymbol(symbol)) && !isStreamWebReadableStream(lowerer, root))
    return null;
  const loc = locOf(call);
  if (root.text === "AbortSignal") {
    noteEventListeners(lowerer, loc);
    switch (call.expression.name.text) {
      case "timeout":
        if (call.arguments.nodes[0] && ts.isSpreadElement(call.arguments.nodes[0])) {
          return null;
        }
        return staticCallWithSurplusArgs(
          lowerer,
          call,
          call.arguments.nodes[0]
            ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
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
        if (call.arguments.nodes.length === 0) {
          return {
            kind: "libCall",
            fn: "fetch.abortNow",
            args: [dynUndefinedExpr(loc)],
            type: DYN,
            loc,
          };
        }
        if (ts.isSpreadElement(call.arguments.nodes[0]!)) return null;
        return staticCallWithSurplusArgs(
          lowerer,
          call,
          lowerLiveWebValue(lowerer, call.arguments.nodes[0]!),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortNow",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      case "any":
        if (call.arguments.nodes[0] && ts.isSpreadElement(call.arguments.nodes[0])) {
          return null;
        }
        return staticCallWithSurplusArgs(
          lowerer,
          call,
          call.arguments.nodes[0]
            ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
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
    (!call.arguments.nodes[0] || !ts.isSpreadElement(call.arguments.nodes[0]))
  ) {
    if (!call.arguments.nodes[0]) {
      return {
        kind: "libCall",
        fn: "fetch.streamFrom",
        args: [dynUndefinedExpr(loc)],
        type: DYN,
        loc,
      };
    }
    let source = lowerer.lowerExpr(call.arguments.nodes[0]!);
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
        `ReadableStream.from() over ${lowerer.checker.typeToString(lowerer.typeOf(call.arguments.nodes[0]!))} iterables`,
        call.arguments.nodes[0]!,
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
  // An optional chain (`controller?.abort()`) lowers the call again once it
  // has narrowed the receiver (Lowerer.chainHandled).
  if (
    (call.questionDotToken && !lowerer.chainHandled.has(call)) ||
    call.arguments.nodes.some((argument) => ts.isSpreadElement(argument)) ||
    (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
    (access.questionDotToken && !lowerer.chainHandled.has(access)) ||
    staticResponseMemberName(lowerer, access) !== "abort"
  ) {
    return null;
  }
  const receiverTs = lowerer.checker.getBaseTypeOfLiteralType(
    access.questionDotToken
      ? lowerer.checker.getNonNullableType(lowerer.typeOf(access.expression))
      : lowerer.typeOf(access.expression),
  );
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol === undefined ||
    ts.symbolName(symbol) !== "AbortController" ||
    !symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return null;
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const first = call.arguments.nodes[0]
    ? lowerLiveWebValue(lowerer, call.arguments.nodes[0])
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
      calleeName: ts.getTextOfNode(access),
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
    call.questionDotToken ||
    call.arguments.nodes.length > 1 ||
    (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(lowerer, access);
  if (member !== "enqueue" && member !== "error") return null;
  const receiverTs = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol === undefined ||
    ts.symbolName(symbol) !== "ReadableStreamDefaultController" ||
    !symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return null;
  }
  const recv = lowerer.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const args = [
    call.arguments.nodes[0]
      ? lowerLiveWebValue(lowerer, call.arguments.nodes[0])
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
      calleeName: ts.getTextOfNode(access),
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
    call.questionDotToken ||
    call.arguments.nodes.length > 1 ||
    call.arguments.nodes.some((argument) => ts.isSpreadElement(argument)) ||
    (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
    access.questionDotToken ||
    staticResponseMemberName(lowerer, access) !== "cancel"
  ) {
    return null;
  }
  const resolved = fetchInterfaceInventoryOwner(lowerer, access.expression);
  if (resolved?.owner !== "ReadableStream" && resolved?.owner !== "ReadableStreamDefaultReader") {
    return null;
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const args = [
    call.arguments.nodes[0]
      ? lowerLiveWebValue(lowerer, call.arguments.nodes[0])
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
      calleeName: ts.getTextOfNode(access),
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
    call.questionDotToken ||
    call.arguments.nodes.length < 2 ||
    call.arguments.nodes.some((arg) => ts.isSpreadElement(arg)) ||
    (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(lowerer, access);
  if (member !== "addEventListener" && member !== "removeEventListener") {
    return null;
  }
  const receiverTs = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    ((symbol === undefined || ts.symbolName(symbol) !== "AbortSignal") &&
      (symbol === undefined || ts.symbolName(symbol) !== "EventTarget")) ||
    !symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return null;
  }
  const recv = lowerer.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  const loc = locOf(call);
  noteEventListeners(lowerer, loc);
  const args = call.arguments.nodes.map((arg, index) =>
    index === 1 ? lowerLiveWebValue(lowerer, arg) : lowerer.lowerExprExpecting(arg, DYN),
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
      calleeName: ts.getTextOfNode(access),
      args: argumentRefs,
      type: DYN,
      loc,
    }),
  );
}

/** `new EventTarget()`, `new Event(type, options?)` and `new
 * CustomEvent(type, options?)`: native handles built from the checked
 * argument vector (Node validates it in the constructor). */
export function lowerEventTargetNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const name = stdlibGlobalNameOf(lowerer, expr.expression);
  if (name !== "EventTarget" && name !== "Event" && name !== "CustomEvent") return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  if (name === "EventTarget") noteEventListeners(lowerer, loc);
  const values = args.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN),
  );
  if (name === "EventTarget") {
    const result: IrExpr = { kind: "libCall", fn: "event.targetNew", args: [], type: DYN, loc };
    if (values.length === 0) return result;
    return {
      kind: "seqExpr",
      stmts: values.map((value): IrStmt => ({ kind: "exprStmt", expr: value, loc: value.loc })),
      result,
      type: DYN,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: name === "Event" ? "event.new" : "event.customNew",
    args: [{ kind: "dynArrLit", elems: values, type: DYN, loc }],
    type: DYN,
    loc,
  };
}

export function lowerAbortControllerNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "AbortController") {
    return null;
  }
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some((argument) => ts.isSpreadElement(argument))) return null;
  const loc = locOf(expr);
  noteEventListeners(lowerer, loc);

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

/** An import binding of node:stream/web's ReadableStream, which IS the
 * global class (`import { ReadableStream } from "node:stream/web"`). */
function isStreamWebReadableStream(lowerer: Lowerer, ident: ts.Identifier): boolean {
  return ident.text === "ReadableStream" && lowerer.isStdlibGlobal(ident, "ReadableStream");
}

export function lowerStaticReadableStreamNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "ReadableStream") {
    return null;
  }
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (
    (!symbol || !lowerer.isStdlibSymbol(symbol)) &&
    !isStreamWebReadableStream(lowerer, expr.expression)
  )
    return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 1) return null;
  const loc = locOf(expr);

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

/** `new TransformStream()`: the identity transform, a native handle whose
 * readable side is a native ReadableStream and whose writable side is the
 * runtime's WritableStream. A transformer or queuing strategies have no
 * native lowering yet and keep the SC2020 refusal. */
export function lowerStaticTransformStreamNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (stdlibGlobalNameOf(lowerer, expr.expression) !== "TransformStream") return null;
  if ((expr.arguments?.nodes.length ?? 0) > 0) return null;
  return { kind: "libCall", fn: "fetch.transformNew", args: [], type: DYN, loc: locOf(expr) };
}

/** Native Request and Headers values share the fetch runtime's handles. */
export function lowerFetchWebNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const name = stdlibGlobalNameOf(lowerer, expr.expression);
  if (name !== "Request" && name !== "Headers") return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);

  if (name === "Request" && args[1]) fenceRequestInitValue(lowerer, args[1]);
  const lowered = args.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerLiveWebValue(lowerer, arg),
  );
  return {
    kind: "libCall",
    fn: name === "Request" ? "fetch.requestNew" : "fetch.headersNew",
    args:
      name === "Request"
        ? [lowered[0] ?? dynUndefinedExpr(loc), lowered[1] ?? dynUndefinedExpr(loc)]
        : [lowered[0] ?? dynUndefinedExpr(loc)],
    type: DYN,
    loc,
  };
}

export function lowerResponseNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (stdlibGlobalNameOf(lowerer, expr.expression) !== "Response") return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  return lowerResponseConstruction(lowerer, args, locOf(expr), false);
}

/** Static `Response.json(data, init?)`: the data crosses into the runtime's
 * checked-dynamic JSON serializer (toJSON hooks included) after ResponseInit
 * converts, then the response initializes as the constructor does. */
export function lowerResponseStaticJson(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || access.name.text !== "json") return null;
  if (!lowerer.isStdlibGlobal(access.expression, "Response")) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement) || call.arguments.nodes.length === 0)
    return null;
  return lowerResponseConstruction(lowerer, call.arguments.nodes, locOf(call), true);
}

function lowerResponseConstruction(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  loc: SrcLoc,
  json: boolean,
): IrExpr {
  const toDyn = (node: ts.Expression | undefined, value: IrExpr, what: string): IrExpr => {
    if (node === undefined) return dynUndefinedExpr(loc);
    if (value.type.kind === "dyn") return value;
    if (what === "JSON data") {
      const boxed = lowerer.coerceToExpected(value, DYN);
      if (boxed.type.kind === "dyn") return boxed;
      lowerer.noLowering(
        `Response.json of '${lowerer.fmt(value.type)}' values`,
        node,
        "the data must cross the checked-dynamic boundary (number, string, boolean, null, records, arrays, and 'unknown')",
      );
    }
    /* A user class can satisfy ResponseInit structurally through plain
     * fields. Project just the declared dictionary members into a record,
     * then use the ordinary checked-dynamic copy. objRecordWidthHelper
     * deliberately declines accessors/methods, whose observable reads
     * cannot be moved into the runtime WebIDL conversion phase. */
    if (what === "an init value" && value.type.kind === "object") {
      const sourceType = lowerer.typeOf(node);
      const fields: { name: string; type: IrType }[] = [];
      for (const name of ["headers", "status", "statusText"]) {
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
      if (what === "an init value" && hasLiveWebMutableArm(lowerer, value.type)) {
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
  const body =
    bodyNode === undefined
      ? ({ kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc } satisfies IrExpr)
      : lowerer.lowerExpr(bodyNode);
  const initNode = args[1];
  const init =
    initNode === undefined
      ? ({ kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc } satisfies IrExpr)
      : ts.isObjectLiteralExpression(initNode)
        ? lowerDynObjectLiteral(lowerer, initNode, (node, value) =>
            lowerLiveWebValue(lowerer, node, value),
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
    fn: json ? "fetch.responseJsonStatic" : "fetch.responseNew",
    args: [
      toDyn(bodyNode, bodyRef, json ? "JSON data" : "a body"),
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
    call.questionDotToken ||
    call.arguments.nodes.length !== 0 ||
    (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(lowerer, access);
  if (member !== "read") return null;
  const receiverTs = lowerer.typeOf(access.expression);
  const symbol = receiverTs.getSymbol();
  if (
    symbol === undefined ||
    ts.symbolName(symbol) !== "ReadableStreamDefaultReader" ||
    !symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return null;
  }
  const type = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (type?.kind !== "promise" || type.inner.kind !== "record") {
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

export function lowerDynamicImportCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const arg = call.arguments.nodes[0];
  if (arg === undefined || !ts.isStringLiteralLike(arg)) {
    lowerer.unsupported(
      "SC1090",
      call,
      "dynamic import() of computed specifiers (the module graph resolves at " +
        "build time — the specifier must be a string literal)",
      undefined,
      "dynamic-import",
    );
  }
  if (call.arguments.nodes.length !== 1) {
    lowerer.unsupported("SC1090", call, "dynamic import() with import attributes");
  }
  const res = lowerer.dynImports.get(`${ts.getSourceFileOfNode(call).fileName}\u0000${arg.text}`);
  if (res === undefined) lowerer.refuseUnsupportedApi("'import()'", call);
  if (res.kind === "program-module") {
    return lowerOwnStaticModuleImport(lowerer, call, arg);
  }
  return lowerStaticNamespaceImport(lowerer, call, {
    kind: "moduleNs",
    moduleId: `builtin:${res.module}`,
  });
}

/** The checker-resolved program source behind one literal import(). */
function programImportTarget(lowerer: Lowerer, arg: ts.StringLiteralLike): ts.SourceFile | null {
  const modSym = lowerer.checker.getSymbolAtLocation(arg);
  for (const d of modSym ? modSym.declarations : []) {
    if (ts.isSourceFile(d) && !d.isDeclarationFile) return d;
  }
  return null;
}

/** Static literal import of one compiled ESM module. The async helper's
 * first operation is an await of an already-settled promise: evaluation
 * therefore starts on a microtask, after the importer's synchronous
 * tail, matching import(). Its result is the module's singleton nominal
 * namespace token; member reads resolve separately to live exports. */
function lowerOwnStaticModuleImport(
  lowerer: Lowerer,
  call: ts.CallExpression,
  arg: ts.StringLiteralLike,
): IrExpr {
  const dep = programImportTarget(lowerer, arg);
  if (dep !== null && (dep.fileName.endsWith(".cts") || isCjsJsFile(dep, lowerer.program))) {
    lowerer.unsupported(
      "SC1090",
      call,
      `dynamic import of the program's own CommonJS module '${arg.text}' ` +
        "(its namespace comes from module.exports through Node's CJS lexer, " +
        "which has no compiled story — require it, or import it statically)",
    );
  }
  if (dep === null || lowerer.initNameOf.get(dep) === undefined) {
    lowerer.unsupported(
      "SC1090",
      call,
      `dynamic import of the program's own module '${arg.text}' ` +
        "(this module is not part of the compiled module graph)",
    );
  }
  const ns: IrType & { kind: "moduleNs" } = {
    kind: "moduleNs",
    moduleId: `file:${dep === null ? "" : (lowerer.moduleNamespaceIdOfType(lowerer.typeOf(call))?.replace(/^file:/, "") ?? dep.fileName)}`,
  };
  // The call's type is Promise<typeof import(...)>; prefer the mapper's
  // canonical normalized id when available.
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
  const inner = mapped?.kind === "promise" && mapped.inner.kind === "moduleNs" ? mapped.inner : ns;
  return lowerStaticNamespaceImport(lowerer, call, inner, dep);
}

/** Builds a fresh native promise for a static module namespace. Source
 * modules run/await their guarded initializer after the mandatory hop;
 * builtins only take the hop and resolve their immortal token. */
function lowerStaticNamespaceImport(
  lowerer: Lowerer,
  call: ts.CallExpression,
  ns: IrType & { kind: "moduleNs" },
  dep: ts.SourceFile | null = null,
): IrExpr {
  const loc = locOf(call);
  const resultT: IrType & { kind: "promise" } = { kind: "promise", inner: ns };
  const fnName = lowerer.closureName(loc, "_staticImport");
  const fnType: IrType & { kind: "func" } = { kind: "func", params: [], ret: resultT };
  const fnCtx = newFnCtx(true, null, fnType, ns);
  fnCtx.isAsync = true;
  lowerer.fnStack.push(fnCtx);
  try {
    const hop: IrExpr = {
      kind: "awaitExpr",
      value: {
        kind: "intrinsic",
        name: "promise.resolve",
        args: [],
        type: { kind: "promise", inner: VOID },
        loc,
      },
      type: VOID,
      loc,
    };
    const body: IrStmt[] = [{ kind: "exprStmt", expr: hop, loc }];
    if (dep !== null) appendStaticModuleInit(lowerer, dep, body, loc);
    body.push({
      kind: "return",
      value: { kind: "moduleNsRef", moduleId: ns.moduleId, type: ns, loc },
      loc,
    });
    const ctx = lowerer.ctx;
    lowerer.liftedFns.push({
      name: fnName,
      params: [],
      returnType: ns,
      locals: ctx.locals,
      captures: ctx.captures ?? [],
      body,
      async: true,
      loc,
    });
  } finally {
    lowerer.fnStack.pop();
  }
  return {
    kind: "callValue",
    callee: { kind: "closure", fnName, captures: [], type: fnType, loc },
    args: [],
    type: resultT,
    loc,
  };
}

/** Appends Node's lazy source-module link/evaluation work to a static
 * import helper. This is the native twin of dynNsBuilderOf's prelude. */
function appendStaticModuleInit(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  body: IrStmt[],
  loc: IrExpr["loc"],
): void {
  const linkCrash = esmNamedImportLinkCrash(lowerer.program, dep);
  if (linkCrash !== null) {
    body.push({
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [{ kind: "strLit", value: linkCrash.message, type: STRING, loc }],
        type: { kind: "object", className: linkCrash.className },
        loc,
      },
      loc,
    });
    return;
  }
  const initName = lowerer.initNameOf.get(dep);
  if (initName === undefined)
    throw new InternalCompilerError("lowerer bug: static import target has no init");
  const isAsync = lowerer.asyncInitFiles.has(dep);
  if (dep === lowerer.entry && !isAsync) return;
  const initCall: IrExpr = {
    kind: "call",
    callee: initName,
    args: [],
    type: isAsync ? { kind: "promise", inner: VOID } : VOID,
    loc,
  };
  const cyclePromiseId = lowerer.asyncCyclePromiseOf.get(dep);
  if (isAsync && cyclePromiseId !== undefined) {
    body.push({ kind: "exprStmt", expr: initCall, loc });
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
    return;
  }
  body.push({
    kind: "exprStmt",
    expr: isAsync ? { kind: "awaitExpr", value: initCall, type: VOID, loc } : initCall,
    loc,
  });
}

export function lowerStdlibMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  // Supported native AbortSignal statics are handled before this generic
  // method path. Refuse forms that reach this point without a lowering.
  {
    const sigMember = lowerer.stdlibGlobalMember(access, "AbortSignal");
    if (
      (sigMember === "timeout" || sigMember === "abort" || sigMember === "any") &&
      call.arguments.nodes.every((argument) => !ts.isSpreadElement(argument))
    ) {
      lowerer.refuseUnsupportedApi(`'AbortSignal.${sigMember}'`, call);
    }
  }
  if (
    lowerer.stdlibGlobalMember(access, "ReadableStream") === "from" &&
    call.arguments.nodes.every((argument) => !ts.isSpreadElement(argument))
  ) {
    lowerer.refuseUnsupportedApi("'ReadableStream.from'", call);
  }
  const isMath = lowerer.stdlibGlobalMember(access, "Math") !== null;

  // use their declared arity; min/max and hypot accept their variadic forms.
  const staticMath = isMath ? own(STATIC_MATH_FNS, name) : undefined;
  // A missing element (a hole bound by a loop, a local or field holding a
  // missing read, or the read itself) converts to NaN, ToNumber's answer
  // for undefined, instead of trusting the checker's number type. The
  // arguments are all evaluated before any converts (lowerToNumberArguments).
  const mathArgs = (
    nodes: readonly ts.Expression[],
    lowerOther?: (node: ts.Expression) => IrExpr | null,
  ) => lowerToNumberArguments(lowerer, nodes, lowerOther);
  const afterArguments = (stmts: IrStmt[], result: IrExpr): IrExpr =>
    stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: result.type, loc };
  // Math.hypot, and Math.max/Math.min with a spread among other arguments
  // (`Math.max(...xs, 5)`): the arguments in order, spreads flattened, as
  // one number[] the runtime folds.
  if (
    staticMath &&
    (name === "hypot" ||
      ((name === "max" || name === "min") &&
        call.arguments.nodes.length > 1 &&
        call.arguments.nodes.some(ts.isSpreadElement)))
  ) {
    const { stmts, values: elems } = mathArgs(call.arguments.nodes, (a) =>
      ts.isSpreadElement(a) ? lowerer.lowerExprExpecting(a.expression, arrayOf(F64)) : null,
    );
    const spreads = call.arguments.nodes.flatMap((a, i) => (ts.isSpreadElement(a) ? [i] : []));
    const packed: IrExpr = {
      kind: "arrayLit",
      elems,
      ...(spreads.length > 0 ? { spreads } : {}),
      type: arrayOf(F64),
      loc,
    };
    const fn = name === "max" ? "math.maxArr" : name === "min" ? "math.minArr" : staticMath.fn;
    return afterArguments(stmts, { kind: "libCall", fn, args: [packed], type: F64, loc });
  }
  if (staticMath && call.arguments.nodes.every((a) => !ts.isSpreadElement(a))) {
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
      if (call.arguments.nodes.length === 0) {
        return { kind: "numLit", value: name === "max" ? -Infinity : Infinity, type: F64, loc };
      }
      const { stmts, values: args } = mathArgs(call.arguments.nodes);
      let acc = args[0]!;
      for (let i = 1; i < args.length; i++) {
        acc = { kind: "libCall", fn: staticMath.fn, args: [acc, args[i]!], type: F64, loc };
      }
      return afterArguments(stmts, acc);
    }
    if (call.arguments.nodes.length === staticMath.arity) {
      const { stmts, values: args } = mathArgs(call.arguments.nodes);
      return afterArguments(stmts, { kind: "libCall", fn: staticMath.fn, args, type: F64, loc });
    }
  }
  // `Math.max(...xs)` / `Math.min(...xs)` over a number[]: a STATIC
  // runtime fold (NaN poisons and ±0 follows JS ordering). Mixed
  // spread/positional argument lists pack into one array above.
  if (
    isMath &&
    (name === "max" || name === "min") &&
    call.arguments.nodes.length === 1 &&
    ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    const spread = call.arguments.nodes[0]! as ts.SpreadElement;
    let src = lowerer.lowerExpr(spread.expression);
    // JavaScript array call results retain checked storage so aliases stay
    // shared. This read-only fold can extract the inferred numeric array.
    if (src.type.kind === "dyn") {
      const inferred = lowerer.mapTypeOf(lowerer.typeOf(spread.expression));
      if (inferred?.kind === "array" && inferred.elem.kind === "f64") {
        src = lowerer.coerceInto(spread.expression, src, inferred);
      }
    }
    // A generator, or a class whose [Symbol.iterator] is a generator
    // method, drains into the number[] the fold reads.
    src = classGeneratorIterable(lowerer, src) ?? src;
    if (src.type.kind === "generator") src = generatorDrain(lowerer, src, F64, loc) ?? src;
    // An untyped iterable (`Math.min(...caps.map(f))` in JavaScript): the
    // runtime packs its values and folds their ToNumber like Node. V8 names
    // a null or undefined source by its text, calls as `f(...)`.
    if (src.type.kind === "dyn") {
      const what = ts.isCallExpression(spread.expression)
        ? `${ts.getTextOfNode(spread.expression.expression)}(...)`
        : ts.getTextOfNode(spread.expression);
      return {
        kind: "libCall",
        fn: "dyn.mathFold",
        args: [
          src,
          { kind: "boolLit", value: name === "max", type: BOOL, loc },
          { kind: "strLit", value: what, type: STRING, loc },
        ],
        type: F64,
        loc,
      };
    }
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
  const mathFn = isMath ? own(STDLIB_SURFACE.math.fns, name) : undefined;
  if (mathFn && call.arguments.nodes.length === mathFn.args.length) {
    lowerer.refuseUnsupportedApi(`'Math.${name}'`, call);
  }
  const kind = lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind;
  const entry =
    kind === "f64"
      ? own(STDLIB_SURFACE.number, name)
      : kind === "string"
        ? own(STDLIB_SURFACE.string, name)
        : undefined;
  if (!entry || call.arguments.nodes.length !== entry.args.length) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  lowerer.refuseUnsupportedApi(`'.${name}()' on ${kind === "f64" ? "numbers" : "strings"}`, call);
}

export function lowerMathProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(expr, "Math");
  if (member === null) return null;
  const loc = locOf(expr);
  const value = mathMemberValue(lowerer, member, loc);
  if (value !== null) return value;
  const propType = own(STDLIB_SURFACE.math.props, member);
  if (propType !== undefined) {
    lowerer.refuseUnsupportedApi(`'Math.${member}'`, expr);
  }
  if (
    own(STDLIB_SURFACE.math.fns, member) !== undefined ||
    own(STATIC_MATH_FNS, member) !== undefined
  ) {
    lowerer.unsupported("SC1090", expr, `Math methods as values (call '${member}' directly)`);
  }
  return null; // declared-but-untabled members fall through generically
}

/** The value of the Math member `member`: a constant, or the interned
 * native function value of a Math function. Null for other members. */
export function mathMemberValue(lowerer: Lowerer, member: string, loc: SrcLoc): IrExpr | null {
  const staticValue = own(STATIC_MATH_PROPS, member);
  if (staticValue !== undefined) {
    return { kind: "numLit", value: staticValue, type: F64, loc };
  }
  const native = own(STATIC_MATH_FNS, member);
  if (!native) return null;
  if (member === "min" || member === "max" || member === "hypot")
    return lowerer.lowerNativeCallableValue(
      {
        fn: member === "min" ? "math.minArr" : member === "max" ? "math.maxArr" : "math.hypotArr",
        params: [arrayOf(F64)],
        result: F64,
        valueParams: [{ mode: "rest", type: F64 }],
        valueLength: 2,
      },
      `Math.${member}`,
      loc,
    );
  const params = Array.from({ length: native.arity }, () => F64);
  return lowerer.lowerNativeCallableValue(
    {
      fn: native.fn,
      params,
      result: F64,
      valueParams: params.map((type) => ({ mode: "required", type })),
    },
    `Math.${member}`,
    loc,
  );
}

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

export function npmMemberFence(lowerer: Lowerer, access: ts.PropertyAccessExpression): void {
  const pkg =
    lowerer.npmPackageOf(lowerer.typeOf(access.expression)) ??
    lowerer.npmPackageOfSymbol(lowerer.checker.getSymbolAtLocation(access.name));
  if (!pkg) return;
  lowerer.pushDiag(unsupportedPackageValueDiag(pkg, locOf(access)));
  throw new PoisonError();
}

/** The npm package a SYMBOL is declared by, or null. The symbol half of
 * npmPackageOf, also asked directly for import-alias bindings (whose
 * aliased symbol is the package's export). */
export function npmPackageOfSymbol(lowerer: Lowerer, sym: ts.Symbol | undefined): string | null {
  const decls = sym ? sym.declarations : undefined;
  if (!decls || decls.length === 0) return null;
  if (!decls.every((d) => lowerer.isNpmFile(ts.getSourceFileOfNode(d)))) return null;
  return npmPackageNameOf(ts.getSourceFileOfNode(decls[0]!).fileName);
}
