import * as ts from "../ts7/adapter.js";
import { literalValues } from "../literal-values.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Members every function value has (Function.prototype and
 * Object.prototype, plus own `length`/`name`/`prototype`). */
const FUNCTION_MEMBER_NAMES = new Set([
  "apply",
  "arguments",
  "bind",
  "call",
  "caller",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "length",
  "name",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

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
  const propertyWrites: { target: ts.PropertyAccessExpression; site: ts.Node }[] = [];
  const reflection: ts.PropertyAccessExpression[] = [];
  const globals: ts.Identifier[] = [];
  const jsAssignments: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = [];
  const computedMethods: ts.Expression[] = [];
  const typedClasses: (ts.ClassDeclaration | ts.ClassExpression)[] = [];
  let unknownKey: ts.Node | undefined;
  let numericKey: ts.Node | undefined;
  let unknownOwnField = false;
  // JavaScript method inference and dynamic class factories keep their
  // existing dispatch contract. The native-call proof applies to typed
  // declarations, while writes in either source language can invalidate it.
  for (const file of files) {
    if (isJsSourceFile(file)) continue;
    ts.walkPreorder(file, (node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) typedClasses.push(node);
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
  // Whether no function value can inhabit `type`. Primitives qualify, and so
  // do non-callable object types a function is not assignable to: one that
  // requires a property functions lack, or a weak (all-optional) type that
  // shares no property with functions (TypeScript's weak-type rule rejects
  // callable sources too).
  const functionFree = (type: ts.Type): boolean => {
    if (type.isUnionType()) return ts.constituentTypes(type).every(functionFree);
    if (
      (type.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.Null |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.ESSymbolLike)) !==
      0
    )
      return true;
    if (
      !(type.flags & ts.TypeFlags.Object) ||
      lowerer.checker.getCallSignatures(type).length > 0 ||
      lowerer.checker.getConstructSignatures(type).length > 0
    )
      return false;
    const properties = lowerer.checker.getPropertiesOfType(type);
    if (properties.length === 0) return false;
    const required = properties.filter(
      (property) => (property.flags & ts.SymbolFlags.Optional) === 0,
    );
    if (required.some((property) => !FUNCTION_MEMBER_NAMES.has(property.name))) return true;
    return (
      required.length === 0 &&
      properties.every((property) => !FUNCTION_MEMBER_NAMES.has(property.name))
    );
  };
  // A string index whose values cannot be functions excludes callable
  // method slots. Class instances have no implicit index signature, so such
  // a dictionary is only a class view when the class declares that index
  // signature, and then every method must be assignable to its value type.
  const functionFreeDictionary = (value: ts.Expression): boolean =>
    lowerer.checker
      .getIndexInfosOfType(lowerer.typeOf(value))
      .some(
        (index) =>
          (index.keyType.flags & ts.TypeFlags.StringLike) !== 0 && functionFree(index.valueType),
      );
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
    if (ts.isPropertyAccessExpression(target)) {
      const name = target.name.text;
      // A named write to a method name is judged by the written property's
      // type once types are prefetched (see propertyWrites below).
      if (methods.has(name) && name !== "prototype" && name !== "__proto__") {
        if (!arrow) receiverFields.add(name);
        propertyWrites.push({ target, site });
      } else markName(name, site, arrow);
    } else if (ts.isElementAccessExpression(target))
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
  // Instance types of the typed classes that have method `name` (declared or
  // inherited), or null when one of them cannot be judged by assignability:
  // a generic class (an instantiation may fit where the declaration does not)
  // or an anonymous class with a base or its own such method.
  const ownerTypes = new Map<string, ts.Type[] | null>();
  const methodOwners = (name: string): ts.Type[] | null => {
    const cached = ownerTypes.get(name);
    if (cached !== undefined) return cached;
    let owners: ts.Type[] | null = [];
    for (const cls of typedClasses) {
      const symbol = cls.name ? lowerer.checker.getSymbolAtLocation(cls.name) : undefined;
      if (!symbol) {
        const declares = cls.members.some(
          (member) =>
            ts.isMethodDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.name.text === name,
        );
        if (declares || cls.heritageClauses !== undefined) owners = null;
        if (owners === null) break;
        continue;
      }
      const type = lowerer.checker.getDeclaredTypeOfSymbol(symbol);
      const property = lowerer.checker.getPropertyOfType(type, name);
      if (!property || !lowerer.checker.declarationsOf(property).some(ts.isMethodDeclaration))
        continue;
      if (cls.typeParameters !== undefined && cls.typeParameters.length > 0) {
        owners = null;
        break;
      }
      owners.push(type);
    }
    ownerTypes.set(name, owners);
    return owners;
  };
  // The type a write's receiver can hold: `this` in an instance member of a
  // class is an instance of that class (or a subclass); `this` elsewhere,
  // other type parameters, `any` and `unknown` answer null.
  const receiverType = (receiver: ts.Expression): ts.Type | null => {
    receiver = unwrap(receiver);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      let member: ts.Node = receiver;
      while (
        member.parent &&
        !ts.isClassDeclaration(member.parent) &&
        !ts.isClassExpression(member.parent)
      ) {
        if (ts.isFunctionDeclaration(member) || ts.isFunctionExpression(member)) return null;
        member = member.parent;
      }
      const cls = member.parent;
      if (!cls || !(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) || !cls.name)
        return null;
      if (ts.isConstructorDeclaration(member)) {
        // The constructor's `this` is the instance.
      } else if (
        ts.isMethodDeclaration(member) ||
        ts.isPropertyDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
          return null;
      } else return null;
      const symbol = lowerer.checker.getSymbolAtLocation(cls.name);
      return symbol ? lowerer.checker.getDeclaredTypeOfSymbol(symbol) : null;
    }
    const type = lowerer.typeOf(receiver);
    if (type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      return null;
    return type;
  };
  // A function-typed write shadows a method only on an object that has the
  // method: an instance of a class with method `name` that the receiver's
  // type admits. Without one (a callback field of an unrelated class that
  // happens to share the name), the write leaves every method in place.
  const methodOwnerCanInhabit = (receiver: ts.Expression, name: string): boolean => {
    const owners = methodOwners(name);
    const type = receiverType(receiver);
    if (owners === null || type === null) return true;
    return owners.some((owner) => lowerer.checker.isTypeAssignableTo(owner, type));
  };
  // A named write can replace a method only when the written property can
  // hold a function: a class instance seen through the receiver's type must
  // have its method assignable to that property's type. Data fields (an AST
  // node, a string, a JSON record) cannot shadow a same-named method of an
  // unrelated class, so they stay out of the observed-slot census.
  lowerer.checker.prefetchClassCollection(
    propertyWrites.map((write) => write.target),
    [],
  );
  for (const { target, site } of propertyWrites) {
    const name = target.name.text;
    if (lowerer.prototypeMethodAccesses.has(name) || functionFree(lowerer.typeOf(target))) continue;
    if (!methodOwnerCanInhabit(target.expression, name)) continue;
    lowerer.prototypeMethodAccesses.set(name, site);
  }
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
    // A string index whose values cannot be functions excludes callable
    // method slots. Unlike structural interfaces, it cannot be a live
    // class-method view.
    if (receiver && (freshReceiver(receiver) || functionFreeDictionary(receiver))) continue;
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
