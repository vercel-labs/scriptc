import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Census observable slots before choosing native calls. Names are shared
 * conservatively across classes: aliases cannot hide a named replacement. */
export function collectClassMethodMutations(
  lowerer: Lowerer,
  files: readonly ts.SourceFile[],
): void {
  const methods = new Set<string>();
  const arrowFields = new Set<string>();
  const receiverFields = new Set<string>();
  let unknownKey: ts.Node | undefined;
  let numericKey: ts.Node | undefined;
  const markName = (name: string, site: ts.Node, arrow = false): void => {
    if (name === "prototype" || name === "__proto__") unknownKey = site;
    lowerer.prototypeMethodAccesses.set(name, site);
    if (!arrow) receiverFields.add(name);
  };
  const unwrap = (value: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value) ||
      ts.isNonNullExpression(value)
    )
      value = value.expression;
    return value;
  };
  // Plain records and containers have independent native storage. A
  // computed dictionary write cannot replace a class method. Unknown,
  // generic, class and object-typed receivers retain conservative lookup.
  const classReceiver = (value: ts.Expression): boolean => {
    const possible = (type: ts.Type): boolean => {
      if (
        type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.TypeParameter |
          ts.TypeFlags.NonPrimitive)
      )
        return true;
      if (type.isUnionType() || type.isIntersectionType())
        return ts.constituentTypes(type).some(possible);
      const symbol = type.getSymbol();
      if (!symbol) return false;
      return lowerer.checker
        .declarationsOf(symbol)
        .some(
          (decl) =>
            ts.isClassDeclaration(decl) ||
            ts.isClassExpression(decl) ||
            (ts.isInterfaceDeclaration(decl) &&
              decl.name.text === "Object" &&
              lowerer.isStdlibFile(decl.getSourceFile())),
        );
    };
    return possible(lowerer.typeOf(value));
  };
  const markKey = (key: ts.Expression, site: ts.Node): void => {
    key = unwrap(key);
    if (ts.isStringLiteralLike(key)) markName(key.text, site);
    else if (ts.isNumericLiteral(key)) markName(String(Number(key.text)), site);
    else {
      const flags = lowerer.typeOf(key).flags;
      if (flags & ts.TypeFlags.NumberLike) {
        // Defer until every declaration is known. Numeric writes can
        // replace numeric names but not ordinary named callback fields.
        numericKey = site;
      } else if (!(flags & ts.TypeFlags.ESSymbolLike)) unknownKey = site;
    }
  };
  const markFields = (value: ts.Expression, site: ts.Node): void => {
    value = unwrap(value);
    if (!ts.isObjectLiteralExpression(value)) {
      unknownKey = site;
      return;
    }
    for (const field of value.properties) {
      if (ts.isSpreadAssignment(field)) markFields(field.expression, site);
      else if (field.name && (ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)))
        markName(field.name.text, site);
      else if (field.name && ts.isComputedPropertyName(field.name))
        markKey(field.name.expression, site);
    }
  };
  const markTarget = (target: ts.Expression, site: ts.Node, arrow = false): void => {
    target = unwrap(target);
    if (
      (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
      !classReceiver(target.expression)
    )
      return;
    if (ts.isPropertyAccessExpression(target)) markName(target.name.text, site, arrow);
    else if (ts.isElementAccessExpression(target)) markKey(target.argumentExpression, site);
    else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isSpreadElement(element)) markTarget(element.expression, site);
        else if (!ts.isOmittedExpression(element)) markTarget(element, site);
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const field of target.properties) {
        if (ts.isPropertyAssignment(field)) markTarget(field.initializer, site);
        else if (ts.isSpreadAssignment(field)) markTarget(field.expression, site);
      }
    } else if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      markTarget(target.left, site);
  };
  for (const file of files)
    ts.walkPreorder(file, (node) => {
      if (lowerer.dynamic) unknownKey = file;
      if (
        (ts.isPropertyDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)) &&
        ts.isComputedPropertyName(node.name)
      ) {
        markKey(node.name.expression, node);
        if (ts.isMethodDeclaration(node) && ts.isStringLiteralLike(node.name.expression))
          methods.add(node.name.expression.text);
      }

      if (
        (ts.isPropertyDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)) &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteralLike(node.name) ||
          ts.isNumericLiteral(node.name))
      ) {
        if (
          ts.isPropertyDeclaration(node) &&
          node.initializer &&
          ts.isArrowFunction(unwrap(node.initializer))
        )
          arrowFields.add(node.name.text);
        else receiverFields.add(node.name.text);
      }
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteralLike(node.name) ||
          ts.isNumericLiteral(node.name))
      ) {
        if (!ts.isPropertyAssignment(node) || !ts.isArrowFunction(unwrap(node.initializer)))
          receiverFields.add(node.name.text);
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.modifiers?.length)
        receiverFields.add(node.name.text);
      if (
        ts.isMethodDeclaration(node) &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteralLike(node.name) ||
          ts.isNumericLiteral(node.name))
      ) {
        methods.add(node.name.text);
        receiverFields.add(node.name.text);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        markTarget(
          node.left,
          node,
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isArrowFunction(unwrap(node.right)),
        );
      if (ts.isDeleteExpression(node)) markTarget(node.expression, node);
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        markTarget(node.operand, node);
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.kind !== ts.SyntaxKind.MissingDeclaration
      )
        markTarget(node.initializer, node);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const base = unwrap(node.expression);
        const prototype =
          (ts.isPropertyAccessExpression(base) && base.name.text === "prototype") ||
          (ts.isElementAccessExpression(base) &&
            ts.isStringLiteralLike(base.argumentExpression) &&
            base.argumentExpression.text === "prototype");
        if (prototype) {
          if (ts.isPropertyAccessExpression(node)) markName(node.name.text, node);
          else markKey(node.argumentExpression, node);
        }
      }
      // Extracted reflection functions and aliases of Object/Reflect can
      // mutate arbitrary names. Direct calls below retain precise keys.
      if (
        ts.isIdentifier(node) &&
        (lowerer.isStdlibGlobal(node, "Object") || lowerer.isStdlibGlobal(node, "Reflect"))
      ) {
        if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node)
          unknownKey = node;
      }
      if (!ts.isPropertyAccessExpression(node)) return;
      const objectMethod = lowerer.stdlibGlobalMember(node, "Object");
      const reflectMethod = lowerer.stdlibGlobalMember(node, "Reflect");
      if (objectMethod === "setPrototypeOf" || reflectMethod === "setPrototypeOf")
        unknownKey = node;
      const single =
        objectMethod === "defineProperty" ||
        reflectMethod === "defineProperty" ||
        reflectMethod === "set" ||
        reflectMethod === "deleteProperty";
      const multiple = objectMethod === "defineProperties" || objectMethod === "assign";
      if (!single && !multiple) return;
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.expression !== node) {
        unknownKey = node;
        return;
      }
      if (call.arguments[0] && !classReceiver(call.arguments[0])) return;
      if (single && call.arguments[1]) markKey(call.arguments[1], call);
      else if (objectMethod === "defineProperties" && call.arguments[1])
        markFields(call.arguments[1], call);
      else if (objectMethod === "assign")
        for (const source of call.arguments.slice(1)) markFields(source, call);
    });
  if (numericKey) {
    for (const name of [...methods, ...arrowFields]) {
      if (String(Number(name)) === name) markName(name, numericKey);
    }
  }
  if (unknownKey)
    for (const method of methods) lowerer.prototypeMethodAccesses.set(method, unknownKey);
  if (!unknownKey)
    for (const field of arrowFields) {
      if (!receiverFields.has(field)) lowerer.receiverFreeCallbackFields.add(field);
    }
}
