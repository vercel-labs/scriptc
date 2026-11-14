/* Name and property reads that declaration-time code emitted ahead of them
 * cannot be observed by (class-statics-position.ts InertRead).
 *
 * A class's static initializers and static blocks lower at the top-level
 * statement whose evaluation is the class's own. When the class is built in
 * an argument position, JavaScript evaluates the callee and the earlier
 * arguments first, so the emitted code may run ahead of them only when they
 * run no code and read nothing that code could write. A read qualifies when:
 *
 * - it is a name whose binding nothing in the program writes after its
 *   declaration, read after the declaration in the same file. A module's own
 *   bindings are written only in their file (imports are read-only); a
 *   global (a script file's top level, or an ambient declaration) may be
 *   written from any file, by name or as a property of the global object,
 *   so every program file is scanned;
 * - or it is a property read `a.b` of such a name whose property is a data
 *   member the read's own declarations pin: a member of the object literal
 *   that initializes `a`, a static member of the class `a` names, or a
 *   standard-library member of a standard-library global. A member a type
 *   or interface declares is not one: the value behind it may define the
 *   member as an accessor, or be a proxy, and the read would run code. The
 *   program must also never write the member: by name on any receiver; by
 *   a computed key whose type may be its name, on a receiver the read's
 *   receiver could be; or through Object.assign, Object.defineProperty,
 *   Object.defineProperties, Object.setPrototypeOf, Reflect.set,
 *   Reflect.defineProperty, Reflect.deleteProperty, Reflect.setPrototypeOf,
 *   __defineGetter__ or __defineSetter__ on such a receiver.
 *
 * Anything else (a call, an element access, a deeper property chain, a read
 * through `any`) is not inert. */
import * as ts from "../ts7/adapter.js";
import { bindingNeverReassigned, fileWritesBinding } from "../binding-writes.js";
import { literalValues } from "../literal-values.js";
import { withoutParentheses, withoutParenthesesAssertionsNonNull } from "../outer-expressions.js";
import type { InertRead } from "../class-statics-position.js";
import type { Lowerer } from "./lowerer.js";

/** The InertRead the statics position walk takes, over `lowerer`. */
export function inertReadOf(lowerer: Lowerer): InertRead {
  return (expression) => inertRead(lowerer, expression);
}

function inertRead(lowerer: Lowerer, expression: ts.Expression): boolean {
  const e = withoutParentheses(expression);
  if (ts.isIdentifier(e)) return bindingNeverWritten(lowerer, e);
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.name)) return false;
  const receiver = withoutParentheses(e.expression);
  if (!ts.isIdentifier(receiver) || !bindingNeverWritten(lowerer, receiver)) return false;
  if (!pinnedDataMember(lowerer, receiver, e.name)) return false;
  return !propertyMayBeWritten(lowerer, e.name.text, lowerer.typeOf(receiver));
}

function bindingNeverWritten(lowerer: Lowerer, ident: ts.Identifier): boolean {
  const symbol = lowerer.resolveValueSymbol(ident);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations[0];
  if (!symbol || !declaration) return false;
  const home = ts.getSourceFileOfNode(declaration);
  // A read ahead of a `let`, `const` or `class` declaration in its own file
  // throws, and the statics emitted ahead of the read would run first.
  if (
    home === ts.getSourceFileOfNode(ident) &&
    ident.getStart(home) < declaration.getStart(home) &&
    !ts.isFunctionDeclaration(declaration)
  )
    return false;
  if (!home.isDeclarationFile && ts.isExternalModule(home))
    return bindingNeverReassigned(lowerer.bindingScope(), symbol, declaration);
  const name = ts.symbolName(symbol);
  const resolve = (id: ts.Identifier): ts.Symbol | null | undefined =>
    lowerer.resolveValueSymbol(id);
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (file.isDeclarationFile || !lowerer.facts.maySpellIdentifier(file, name)) continue;
    if (fileWritesBinding(symbol, file, resolve)) return false;
  }
  // `globalThis.name = …` writes a global of the program as well. A
  // standard-library global is never replaced in a compiled program
  // (surfaces.ts stdlibGlobalAliasNameOf).
  return lowerer.isStdlibSymbol(symbol) || !propertyMayBeWritten(lowerer, name, undefined);
}

/** Whether `name` read off `receiver` is a data member the declarations
 * of the read itself pin (see the module comment). */
function pinnedDataMember(lowerer: Lowerer, receiver: ts.Identifier, name: ts.Identifier): boolean {
  const member = lowerer.checker.getSymbolAtLocation(name);
  if (member === undefined || member.declarations.length === 0) return false;
  const declarations = member.declarations;
  if (declarations.every((d) => lowerer.isStdlibFile(ts.getSourceFileOfNode(d))))
    return lowerer.isStdlibGlobal(receiver, receiver.text);
  const binding = lowerer.resolveValueSymbol(receiver);
  const holder = binding?.valueDeclaration ?? binding?.declarations[0];
  if (!holder) return false;
  if (ts.isVariableDeclaration(holder)) {
    const list = holder.parent;
    if (!holder.initializer || !ts.isVariableDeclarationList(list)) return false;
    const value = withoutParentheses(holder.initializer);
    if (ts.isObjectLiteralExpression(value))
      return declarations.every(
        (d) =>
          d.parent === value &&
          (ts.isPropertyAssignment(d) ||
            ts.isShorthandPropertyAssignment(d) ||
            ts.isMethodDeclaration(d)),
      );
    if (!ts.isClassExpression(value)) return false;
    return staticDataMembersOf(value, declarations);
  }
  return ts.isClassDeclaration(holder) && staticDataMembersOf(holder, declarations);
}

function staticDataMembersOf(
  cls: ts.ClassDeclaration | ts.ClassExpression,
  declarations: readonly ts.Node[],
): boolean {
  return declarations.every(
    (d) =>
      d.parent === cls &&
      (ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d)) &&
      (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Static) !== 0,
  );
}

/** The Object and Reflect members that write a property of their first
 * argument: by the key their second argument holds, or (Object.assign,
 * Object.defineProperties) by the properties of their later arguments, or
 * (setPrototypeOf) every inherited one. */
const KEYED_WRITERS = new Set(["defineProperty", "set", "deleteProperty"]);
const SPREAD_WRITERS = new Set(["assign", "defineProperties"]);
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);
const REFLECT_WRITERS = new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"]);
const LEGACY_DEFINERS = new Set(["__defineGetter__", "__defineSetter__"]);

/** Whether a program file may write the property `name` of a value of type
 * `readType` (any value when undefined): see the module comment for the
 * writes that count. */
function propertyMayBeWritten(
  lowerer: Lowerer,
  name: string,
  readType: ts.Type | undefined,
): boolean {
  const checker = lowerer.checker;
  // Whether a value of `readType` may be the value a write through
  // `receiver` changes: unless the receiver's type is one the read's
  // receiver is not assignable to.
  const mayAlias = (receiver: ts.Expression | undefined): boolean => {
    if (receiver === undefined || readType === undefined) return true;
    const type = lowerer.typeOf(receiver);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
      return true;
    return checker.isTypeAssignableTo(readType, type);
  };
  const keyMayBeName = (key: ts.Expression | undefined): boolean => {
    if (key === undefined) return true;
    const value = withoutParenthesesAssertionsNonNull(key);
    if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value))
      return String(ts.isNumericLiteral(value) ? Number(value.text) : value.text) === name;
    const type = lowerer.typeOf(key);
    const literals = literalValues(type);
    if (literals !== null) return literals.some((literal) => String(literal) === name);
    const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
    return !parts.every(
      (part) =>
        (part.flags & ts.TypeFlags.ESSymbolLike) !== 0 ||
        ((part.flags & ts.TypeFlags.NumberLike) !== 0 && name !== "NaN" && name !== "Infinity"),
    );
  };
  // Whether a source of Object.assign or a descriptor map of
  // Object.defineProperties may hold a property spelled `name`.
  const mayCarryName = (source: ts.Expression): boolean => {
    if (ts.isSpreadElement(source)) return true;
    const type = lowerer.typeOf(source);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
      return true;
    return (
      checker.getPropertyOfType(type, name) !== undefined ||
      checker.getIndexInfosOfType(type).length > 0
    );
  };
  let written = false;
  const writesTarget = (target: ts.Expression): boolean => {
    const t = withoutParenthesesAssertionsNonNull(target);
    if (ts.isPropertyAccessExpression(t))
      return t.name.text === name || (t.name.text === "__proto__" && mayAlias(t.expression));
    if (ts.isElementAccessExpression(t))
      return keyMayBeName(t.argumentExpression) && mayAlias(t.expression);
    return false;
  };
  const scanPattern = (n: ts.Node): void => {
    if (written) return;
    if (ts.isExpression(n) && writesTarget(n)) written = true;
    else ts.forEachChild(n, scanPattern);
  };
  // A reflective writer reached any other way than as a direct call
  // (`const define = Object.defineProperty`, `.call`) may write anything.
  const reflectiveWriter = (access: ts.PropertyAccessExpression): string | null => {
    const name = access.name.text;
    if (!OBJECT_WRITERS.has(name) && !REFLECT_WRITERS.has(name)) return null;
    const object = lowerer.stdlibGlobalMember(access, "Object");
    if (object !== null && OBJECT_WRITERS.has(object)) return object;
    const reflect = lowerer.stdlibGlobalMember(access, "Reflect");
    return reflect !== null && REFLECT_WRITERS.has(reflect) ? reflect : null;
  };
  const reflectiveCallWrites = (call: ts.CallExpression, writer: string): boolean => {
    const [target, ...rest] = call.arguments.nodes;
    if (target === undefined || ts.isSpreadElement(target) || mayAlias(target)) {
      if (KEYED_WRITERS.has(writer)) return keyMayBeName(rest[0]);
      if (SPREAD_WRITERS.has(writer)) return rest.some(mayCarryName);
      return true;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (written) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = withoutParentheses(n.left);
      if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target))
        scanPattern(target);
      else if (writesTarget(target)) written = true;
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      writesTarget(n.operand)
    )
      written = true;
    else if (ts.isDeleteExpression(n) && writesTarget(n.expression)) written = true;
    else if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer)
    )
      scanPattern(n.initializer);
    else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
      const writer = reflectiveWriter(n);
      const call = n.parent;
      if (writer !== null) {
        if (!ts.isCallExpression(call) || call.expression !== n) written = true;
        else if (reflectiveCallWrites(call, writer)) written = true;
      } else if (LEGACY_DEFINERS.has(n.name.text)) {
        if (!ts.isCallExpression(call) || call.expression !== n) written = true;
        else if (keyMayBeName(call.arguments.nodes[0]) && mayAlias(n.expression)) written = true;
      }
    }
    if (!written) ts.forEachChild(n, visit);
  };
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (file.isDeclarationFile) continue;
    ts.forEachChild(file, visit);
    if (written) return true;
  }
  return false;
}
