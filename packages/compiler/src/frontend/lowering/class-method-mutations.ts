import * as ts from "../ts7/adapter.js";
import { literalValues } from "../literal-values.js";
import { isJsSourceFile } from "../program.js";
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
  const computedWrites: {
    key: ts.Expression | undefined;
    receiver: ts.Expression | undefined;
    site: ts.Node;
  }[] = [];
  const reflection: ts.PropertyAccessExpression[] = [];
  const globals: ts.Identifier[] = [];
  const jsAssignments: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = [];
  const computedMethods: ts.Expression[] = [];
  let unknownKey: ts.Node | undefined;
  let numericKey: ts.Node | undefined;
  let unknownOwnField = false;
  // JavaScript method inference and dynamic class factories keep their
  // existing dispatch contract. The native-call proof applies to typed
  // declarations, while writes in either source language can invalidate it.
  for (const file of files) {
    if (isJsSourceFile(file)) continue;
    ts.walkPreorder(file, (node) => {
      if (
        !ts.isMethodDeclaration(node) ||
        (!ts.isClassDeclaration(node.parent) && !ts.isClassExpression(node.parent))
      )
        return;
      if (
        ts.isIdentifier(node.name) ||
        ts.isStringLiteralLike(node.name) ||
        ts.isNumericLiteral(node.name)
      )
        methods.add(node.name.text);
      else if (ts.isComputedPropertyName(node.name)) computedMethods.push(node.name.expression);
    });
  }
  lowerer.checker.prefetchClassCollection(computedMethods, []);
  for (const key of computedMethods)
    for (const name of literalValues(lowerer.typeOf(key)) ?? []) methods.add(String(name));
  const markName = (name: string, site: ts.Node, arrow = false): void => {
    if (name === "prototype" || name === "__proto__") unknownKey = site;
    if (methods.has(name)) lowerer.prototypeMethodAccesses.set(name, site);
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
  // Structural types can be live views of class instances. A fresh
  // allocation in a constant binding proves that a dictionary write cannot
  // replace a class method without relying on its declared shape.
  const freshReceiver = (value: ts.Expression): boolean => {
    value = unwrap(value);
    if (ts.isIdentifier(value)) {
      const symbol = lowerer.checker.getSymbolAtLocation(value);
      const decl = symbol && lowerer.checker.declarationsOf(symbol)[0];
      if (
        !decl ||
        !ts.isVariableDeclaration(decl) ||
        !ts.isIdentifier(decl.name) ||
        !ts.isVariableDeclarationList(decl.parent) ||
        !(decl.parent.flags & ts.NodeFlags.Const) ||
        !decl.initializer
      )
        return false;
      value = unwrap(decl.initializer);
    }
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return true;
    return (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      lowerer.stdlibGlobalMember(value.expression, "Object") === "create"
    );
  };
  const primitiveDictionary = (value: ts.Expression): boolean => {
    const primitive = (type: ts.Type): boolean =>
      type.isUnionType()
        ? ts.constituentTypes(type).every(primitive)
        : (type.flags &
            (ts.TypeFlags.StringLike |
              ts.TypeFlags.NumberLike |
              ts.TypeFlags.BooleanLike |
              ts.TypeFlags.BigIntLike |
              ts.TypeFlags.Null |
              ts.TypeFlags.Undefined |
              ts.TypeFlags.ESSymbolLike)) !==
          0;
    return lowerer.checker
      .getIndexInfosOfType(lowerer.typeOf(value))
      .some(
        (index) =>
          (index.keyType.flags & ts.TypeFlags.StringLike) !== 0 && primitive(index.valueType),
      );
  };
  const literalLoopKeys = (key: ts.Expression): (string | number)[] | null => {
    if (!ts.isIdentifier(key)) return null;
    const symbol = lowerer.checker.getSymbolAtLocation(key);
    const decl = symbol && lowerer.checker.declarationsOf(symbol)[0];
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
    const loop = list.parent;
    if (!ts.isForOfStatement(loop) || loop.initializer !== list) return null;
    const values = unwrap(loop.expression);
    if (!ts.isArrayLiteralExpression(values)) return null;
    const names: (string | number)[] = [];
    for (const value of values.elements) {
      if (ts.isStringLiteralLike(value)) names.push(value.text);
      else if (ts.isNumericLiteral(value)) names.push(Number(value.text));
      else return null;
    }
    return names;
  };
  const sameBinding = (left: ts.Expression, right: ts.Expression): boolean => {
    left = unwrap(left);
    right = unwrap(right);
    if (!ts.isIdentifier(left) || !ts.isIdentifier(right)) return false;
    const symbol = lowerer.checker.getSymbolAtLocation(left);
    return symbol !== undefined && symbol === lowerer.checker.getSymbolAtLocation(right);
  };
  const preservesExistingMethod = (
    key: ts.Expression,
    receiver: ts.Expression,
    site: ts.Node,
  ): boolean => {
    // An immediately guarded insertion cannot replace a method already
    // present on the receiver or its prototype. Restrict the body to this
    // one write so no intervening statement can change either binding.
    const statement = site.parent;
    if (!ts.isExpressionStatement(statement)) return false;
    const branch = statement.parent;
    if (!ts.isIfStatement(branch) || branch.thenStatement !== statement) return false;
    const test = unwrap(branch.expression);
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken)
      return false;
    const present = unwrap(test.operand);
    return (
      ts.isBinaryExpression(present) &&
      present.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      sameBinding(key, present.left) &&
      sameBinding(receiver, present.right)
    );
  };
  const deletesOwnEnumerableKey = (
    key: ts.Expression,
    receiver: ts.Expression,
    site: ts.Node,
  ): boolean => {
    if (!ts.isDeleteExpression(site) || !ts.isIdentifier(key)) return false;
    const statement = site.parent;
    if (!ts.isExpressionStatement(statement)) return false;
    const loop = statement.parent;
    if (!ts.isForOfStatement(loop) || loop.statement !== statement) return false;
    if (!ts.isVariableDeclarationList(loop.initializer)) return false;
    const decl = loop.initializer.declarations[0];
    if (!decl || !ts.isIdentifier(decl.name) || !sameBinding(key, decl.name)) return false;
    const keys = unwrap(loop.expression);
    return (
      ts.isCallExpression(keys) &&
      ts.isPropertyAccessExpression(keys.expression) &&
      lowerer.stdlibGlobalMember(keys.expression, "Object") === "keys" &&
      keys.arguments.length === 1 &&
      sameBinding(receiver, keys.arguments[0]!)
    );
  };
  const markKey = (key: ts.Expression, site: ts.Node, receiver?: ts.Expression): void => {
    key = unwrap(key);
    if (ts.isStringLiteralLike(key)) markName(key.text, site);
    else if (ts.isNumericLiteral(key)) markName(String(Number(key.text)), site);
    else computedWrites.push({ key, receiver, site });
  };
  const markFields = (value: ts.Expression, site: ts.Node, receiver?: ts.Expression): void => {
    value = unwrap(value);
    if (!ts.isObjectLiteralExpression(value)) {
      computedWrites.push({ key: undefined, receiver, site });
      return;
    }
    for (const field of value.properties) {
      if (ts.isSpreadAssignment(field)) markFields(field.expression, site, receiver);
      else if (field.name && (ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)))
        markName(field.name.text, site);
      else if (field.name && ts.isComputedPropertyName(field.name))
        markKey(field.name.expression, site, receiver);
    }
  };
  const markTarget = (target: ts.Expression, site: ts.Node, arrow = false): void => {
    target = unwrap(target);
    if (ts.isPropertyAccessExpression(target)) markName(target.name.text, site, arrow);
    else if (ts.isElementAccessExpression(target))
      markKey(target.argumentExpression, site, target.expression);
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
        receiverFields.add(node.name.text);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        markTarget(
          node.left,
          node,
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isArrowFunction(unwrap(node.right)),
        );
        if (
          isJsSourceFile(file) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (ts.isPropertyAccessExpression(node.left) ||
            (ts.isElementAccessExpression(node.left) &&
              ts.isStringLiteralLike(node.left.argumentExpression)))
        )
          jsAssignments.push(node.left);
      }
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
          if (ts.isPropertyAccessExpression(node))
            lowerer.prototypeMethodAccesses.set(node.name.text, node);
          else if (ts.isStringLiteralLike(node.argumentExpression))
            lowerer.prototypeMethodAccesses.set(node.argumentExpression.text, node);
          else markKey(node.argumentExpression, node);
        }
      }
      // Extracted reflection functions and aliases of Object/Reflect can
      // mutate arbitrary names. Direct calls below retain precise keys.
      if (ts.isIdentifier(node) && (node.text === "Object" || node.text === "Reflect"))
        globals.push(node);
      if (
        ts.isPropertyAccessExpression(node) &&
        [
          "setPrototypeOf",
          "defineProperty",
          "set",
          "deleteProperty",
          "defineProperties",
          "assign",
        ].includes(node.name.text)
      )
        reflection.push(node);
    });
  // The census crosses deferred bodies. Batch only the binding and key
  // queries it actually needs instead of eagerly querying every identifier.
  lowerer.checker.prefetchClassCollection(
    jsAssignments.flatMap((access) =>
      ts.isElementAccessExpression(access) ? [access.expression] : [],
    ),
    jsAssignments.flatMap((access) => (ts.isPropertyAccessExpression(access) ? [access.name] : [])),
  );
  for (const access of jsAssignments) {
    const name = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : (access.argumentExpression as ts.StringLiteral).text;
    const symbol = ts.isPropertyAccessExpression(access)
      ? lowerer.checker.getSymbolAtLocation(access.name)
      : lowerer.checker.getPropertyOfType(lowerer.typeOf(access.expression), name);
    if (symbol && lowerer.checker.declarationsOf(symbol).some(ts.isMethodDeclaration))
      lowerer.prototypeMethodAccesses.set(name, access);
  }
  lowerer.checker.prefetchSymbolRoots([...globals, ...reflection]);
  for (const node of globals)
    if (
      (lowerer.isStdlibGlobal(node, "Object") || lowerer.isStdlibGlobal(node, "Reflect")) &&
      (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node)
    )
      unknownKey = node;
  for (const node of reflection) {
    const objectMethod = lowerer.stdlibGlobalMember(node, "Object");
    const reflectMethod = lowerer.stdlibGlobalMember(node, "Reflect");
    if (objectMethod === "setPrototypeOf" || reflectMethod === "setPrototypeOf") unknownKey = node;
    const single =
      objectMethod === "defineProperty" ||
      reflectMethod === "defineProperty" ||
      reflectMethod === "set" ||
      reflectMethod === "deleteProperty";
    const multiple = objectMethod === "defineProperties" || objectMethod === "assign";
    if (!single && !multiple) continue;
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.expression !== node) {
      unknownKey = node;
      continue;
    }
    const receiver = call.arguments[0];
    if (single && call.arguments[1]) markKey(call.arguments[1], call, receiver);
    else if (objectMethod === "defineProperties" && call.arguments[1])
      markFields(call.arguments[1], call, receiver);
    else if (objectMethod === "assign")
      for (const source of call.arguments.slice(1)) markFields(source, call, receiver);
  }
  lowerer.checker.prefetchClassCollection(
    computedWrites.flatMap((write) => [
      ...(write.key ? [write.key] : []),
      ...(write.receiver ? [write.receiver] : []),
    ]),
    computedWrites.flatMap((write) => [
      ...(write.key ? [write.key] : []),
      ...(write.receiver ? [write.receiver] : []),
    ]),
  );
  for (const { key, receiver, site } of computedWrites) {
    const type = key ? lowerer.typeOf(key) : undefined;
    const names = type && (literalValues(type) ?? (key ? literalLoopKeys(key) : null));
    if (names) {
      for (const name of names) markName(String(name), site);
      continue;
    }
    if (key && receiver && preservesExistingMethod(key, receiver, site)) continue;
    if (key && receiver && deletesOwnEnumerableKey(key, receiver, site)) {
      // Class methods are non-enumerable prototype properties. Own callback
      // fields remain observable, so this proof does not certify those.
      unknownOwnField = true;
      continue;
    }
    // A primitive-only string index excludes callable method slots. Unlike
    // structural interfaces, it cannot be a live class-method view.
    if (receiver && (freshReceiver(receiver) || primitiveDictionary(receiver))) continue;
    const flags = type?.flags ?? ts.TypeFlags.Unknown;
    if (flags & ts.TypeFlags.NumberLike) {
      // Numeric writes can replace numeric names but not ordinary names.
      numericKey = site;
    } else if (!(flags & ts.TypeFlags.ESSymbolLike)) {
      unknownKey = site;
    }
  }
  if (numericKey) {
    for (const name of [...methods, ...arrowFields]) {
      if (String(Number(name)) === name) markName(name, numericKey);
    }
  }
  if (unknownKey)
    for (const method of methods) lowerer.prototypeMethodAccesses.set(method, unknownKey);
  if (!unknownKey && !unknownOwnField)
    for (const field of arrowFields) {
      if (!receiverFields.has(field)) lowerer.receiverFreeCallbackFields.add(field);
    }
}
