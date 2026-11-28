/* `emitDecoratorMetadata` design-type serialization.
 *
 * TypeScript's legacy emit appends `__metadata(key, value)` entries to a
 * decorated declaration's decorator array, after the member decorators and
 * the `__param` entries:
 *
 *   __decorate([
 *     dec, __param(0, pdec),
 *     __metadata("design:type", Function),
 *     __metadata("design:paramtypes", [Dep, String]),
 *     __metadata("design:returntype", void 0)
 *   ], C.prototype, "m", null);
 *
 * `__metadata(k, v)` is `Reflect.metadata(k, v)` when the global carries the
 * function (the reflect-metadata polyfill) and undefined otherwise, which
 * the helper's falsy check skips. Reverse application therefore runs the
 * metadata decorators first.
 *
 * The serialization below follows tsc's createRuntimeTypeSerializer
 * (transformers/ts.ts): design:type is the declared type annotation (Object
 * when there is none), paramtypes is the parameter list's annotations with a
 * rest parameter narrowed to its element type, returntype is a method's
 * annotation (Promise for an unannotated async method, void 0 otherwise).
 * A type serializes to a global constructor token (String, Number, Boolean,
 * Array, Function, Object, Promise, Symbol, BigInt or a runtime class such
 * as Date), to the class value a type names, to `void 0`, or to Object:
 *
 *   - void, undefined, never, null: `void 0`;
 *   - function and constructor types: Function; array and tuple types: Array;
 *   - a predicate type: Boolean (void 0 for `asserts`);
 *   - literal types: Number, String, Boolean by the literal's kind;
 *   - enums: Number for a numeric enum, String for a string enum, Object for
 *     a mixed one;
 *   - interfaces, type aliases, type parameters, `any`, `unknown`, `object`,
 *     intersections and type literals: Object;
 *   - a union or conditional type: the constituents' serialization when they
 *     all agree (ignoring never, and null/undefined under a project that
 *     turns strictNullChecks off), else Object;
 *   - a type reference to a class or other value: that value. The reference
 *     is evaluated where tsc evaluates it — at the class statement, before
 *     the decorators apply — so a later declaration throws its ReferenceError
 *     there, exactly as the `__metadata("design:type", Dep)` call does.
 *
 * Whether a file emits metadata is its tsconfig's `emitDecoratorMetadata`
 * with `experimentalDecorators`: TypeWorldDifferences.decoratorMetadataFiles. */

import * as ts from "../ts7/adapter.js";
import { DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { dynUndefinedExpr, nodeThrowExpr, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { builtinGlobalValue } from "./expressions/property-access.js";
import { builtinNamespaceValue } from "./builtin-namespaces.js";
import { jsSpecialGlobalValue } from "./global-values.js";
import { classValueRef, type ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

/** Whether the file holding `node` is compiled with `emitDecoratorMetadata`. */
export function wantsDecoratorMetadata(lowerer: Lowerer, node: ts.Node): boolean {
  return lowerer.decoratorMetadataFiles?.has(ts.getSourceFileOfNode(node).fileName) === true;
}

/** The design-type value of one serialization, before it is materialized:
 * `void 0`, a named global constructor or class (`String`, `Date`, `Dep`),
 * a compiled class value, or an ambient declaration's value expression. Two
 * unions agree when their keys agree, which is tsc's
 * equateSerializedTypeNodes for the expression shapes this emit produces. */
type MetaToken =
  | { k: "void" }
  | { k: "global"; name: string }
  | { k: "class"; info: ClassInfo; blame: ts.Node; spelled: string }
  | { k: "entity"; node: ts.EntityName };

function tokenKey(token: MetaToken): string {
  switch (token.k) {
    case "void":
      return "void 0";
    case "global":
      return token.name;
    case "class":
      // tsc compares the emitted entity name's text, so an alias spelling
      // differs from the class's own name (`Dep | D` is Object).
      return token.spelled;
    case "entity":
      return entityNameText(token.node);
  }
}

function entityNameText(node: ts.EntityName): string {
  return ts.isIdentifier(node) ? node.text : `${entityNameText(node.left)}.${node.right.text}`;
}

const OBJ: MetaToken = { k: "global", name: "Object" };
const VOID: MetaToken = { k: "void" };

/** Global constructors a design type may name directly, with the value the
 * program's own read of the name produces. Includes the runtime's interned
 * constructors and the primitive constructors' typed closures. */
function globalTokenForName(name: string): MetaToken | null {
  switch (name) {
    case "String":
    case "Number":
    case "Boolean":
    case "Array":
    case "ReadonlyArray":
    case "Function":
    case "Object":
    case "Promise":
    case "Symbol":
    case "BigInt":
      return { k: "global", name: name === "ReadonlyArray" ? "Array" : name };
    default:
      return null;
  }
}

/** The value a named global constructor or class serializes to. */
function materializeGlobal(lowerer: Lowerer, name: string, loc: SrcLoc): IrExpr {
  const direct = builtinGlobalValue(name, loc);
  if (direct !== null) return lowerer.coerceToExpected(direct, DYN);
  const special = jsSpecialGlobalValue(lowerer, name, loc, false);
  if (special !== null) return lowerer.coerceToExpected(special, DYN);
  return dynUndefinedExpr(loc);
}

function skipParens(node: ts.TypeNode): ts.TypeNode {
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  return node;
}

function identifierName(node: ts.TypeNode): string | null {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) ? node.typeName.text : null;
}

function typeToken(lowerer: Lowerer, node: ts.TypeNode | undefined, container: ts.Node): MetaToken {
  if (node === undefined) return OBJ;
  node = skipParens(node);
  switch (node.kind) {
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NeverKeyword:
      return VOID;
    case ts.SyntaxKind.FunctionType:
    case ts.SyntaxKind.ConstructorType:
      return { k: "global", name: "Function" };
    case ts.SyntaxKind.ArrayType:
    case ts.SyntaxKind.TupleType:
      return { k: "global", name: "Array" };
    case ts.SyntaxKind.TypePredicate:
      return (node as ts.TypePredicateNode).assertsModifier !== undefined
        ? VOID
        : { k: "global", name: "Boolean" };
    case ts.SyntaxKind.BooleanKeyword:
      return { k: "global", name: "Boolean" };
    case ts.SyntaxKind.TemplateLiteralType:
    case ts.SyntaxKind.StringKeyword:
      return { k: "global", name: "String" };
    case ts.SyntaxKind.NumberKeyword:
      return { k: "global", name: "Number" };
    case ts.SyntaxKind.ObjectKeyword:
      return OBJ;
    case ts.SyntaxKind.BigIntKeyword:
      return { k: "global", name: "BigInt" };
    case ts.SyntaxKind.SymbolKeyword:
      return { k: "global", name: "Symbol" };
    case ts.SyntaxKind.LiteralType:
      return literalToken((node as ts.LiteralTypeNode).literal);
    case ts.SyntaxKind.TypeReference:
      return typeReferenceToken(lowerer, node as ts.TypeReferenceNode, container);
    case ts.SyntaxKind.IntersectionType:
      return unionToken(lowerer, (node as ts.IntersectionTypeNode).types.nodes, true, container);
    case ts.SyntaxKind.UnionType:
      return unionToken(lowerer, (node as ts.UnionTypeNode).types.nodes, false, container);
    case ts.SyntaxKind.ConditionalType: {
      const conditional = node as ts.ConditionalTypeNode;
      return unionToken(lowerer, [conditional.trueType, conditional.falseType], false, container);
    }
    case ts.SyntaxKind.TypeOperator:
      // Only `readonly T` keeps the operand; `keyof` and `unique` are Object.
      return (node as ts.TypeOperatorNode).operator === ts.SyntaxKind.ReadonlyKeyword
        ? typeToken(lowerer, (node as ts.TypeOperatorNode).type, container)
        : OBJ;
    default:
      // Type queries, indexed accesses, mapped types, type literals, `any`,
      // `unknown`, `this`, import types: Object.
      return OBJ;
  }
}

function literalToken(literal: ts.LiteralTypeNode["literal"]): MetaToken {
  switch (literal.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return { k: "global", name: "String" };
    case ts.SyntaxKind.NumericLiteral:
      return { k: "global", name: "Number" };
    case ts.SyntaxKind.BigIntLiteral:
      return { k: "global", name: "BigInt" };
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
      return { k: "global", name: "Boolean" };
    case ts.SyntaxKind.PrefixUnaryExpression:
      return literalToken(
        (literal as ts.PrefixUnaryExpression).operand as ts.LiteralTypeNode["literal"],
      );
    default:
      // A null literal type.
      return VOID;
  }
}

/** tsc's serializeUnionOrIntersectionConstituents: every constituent
 * serializes alike or the answer is Object; `any` answers Object at once,
 * `unknown` answers Object in a union and is skipped in an intersection,
 * `never` is skipped in a union and answers `void 0` in an intersection. */
function unionToken(
  lowerer: Lowerer,
  types: readonly ts.TypeNode[],
  isIntersection: boolean,
  container: ts.Node,
): MetaToken {
  let result: MetaToken | undefined;
  for (const raw of types) {
    const node = skipParens(raw);
    if (node.kind === ts.SyntaxKind.NeverKeyword) {
      if (isIntersection) return VOID;
      continue;
    }
    if (node.kind === ts.SyntaxKind.UnknownKeyword) {
      if (!isIntersection) return OBJ;
      continue;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) return OBJ;
    const token = typeToken(lowerer, node, container);
    if (token.k === "global" && token.name === "Object") return token;
    if (result === undefined) result = token;
    else if (tokenKey(result) !== tokenKey(token)) return OBJ;
  }
  return result ?? VOID;
}

function typeReferenceToken(
  lowerer: Lowerer,
  node: ts.TypeReferenceNode,
  container: ts.Node,
): MetaToken {
  const name = node.typeName;
  const setSymbol = lowerer.checker.getSymbolAtLocation(name);
  const symbol =
    setSymbol !== undefined && (setSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? lowerer.checker.getAliasedSymbol(setSymbol)
      : setSymbol;
  if (setSymbol !== undefined) {
    const info = lowerer.classBySymbol.get(symbol ?? setSymbol);
    if (info !== undefined && info.decl !== null)
      return { k: "class", info, blame: container, spelled: entityNameText(name) };
  }
  const text = ts.isIdentifier(name) ? name.text : undefined;
  if (text !== undefined) {
    const global = globalTokenForName(text);
    if (global !== null) return global;
  }
  if (symbol !== undefined) {
    const flags = symbol.flags;
    if ((flags & ts.SymbolFlags.TypeParameter) !== 0) return OBJ;
    if ((flags & ts.SymbolFlags.Enum) !== 0) return enumToken(lowerer, symbol);
    if ((flags & ts.SymbolFlags.Interface) !== 0 && (flags & ts.SymbolFlags.Value) === 0)
      return OBJ;
    if ((flags & ts.SymbolFlags.TypeAlias) !== 0) return OBJ;
    // A class value the program did not compile: an ambient declaration's
    // name is read where tsc reads it. A type-only import has no value
    // binding at run time; tsc's resolver serializes that one as Function.
    if ((flags & (ts.SymbolFlags.Class | ts.SymbolFlags.ValueModule)) !== 0)
      return { k: "entity", node: name };
    if ((flags & ts.SymbolFlags.Value) !== 0) return { k: "entity", node: name };
  }
  return OBJ;
}

/** A numeric enum serializes as Number, a string enum as String, a mixed one
 * as Object (the type's literal constituents decide). */
function enumToken(lowerer: Lowerer, symbol: ts.Symbol): MetaToken {
  const type = lowerer.checker.getDeclaredTypeOfSymbol(symbol);
  let numeric = 0;
  let string = 0;
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    if ((part.flags & ts.TypeFlags.NumberLiteral) !== 0) numeric++;
    else if ((part.flags & ts.TypeFlags.StringLiteral) !== 0) string++;
    else return OBJ;
  }
  if (numeric > 0 && string === 0) return { k: "global", name: "Number" };
  if (string > 0 && numeric === 0) return { k: "global", name: "String" };
  return OBJ;
}

/** Whether the class's declaration statement follows the decorated class in
 * the same module: the decoration event runs before it, so reading the value
 * throws the temporal-dead-zone ReferenceError. */
function declaredAfterDecoration(token: Extract<MetaToken, { k: "class" }>): boolean {
  const declaration = token.info.decl;
  if (declaration === null) return false;
  if (ts.getSourceFileOfNode(declaration) !== ts.getSourceFileOfNode(token.blame)) return false;
  if (declaration.parent === undefined || !ts.isSourceFile(declaration.parent)) return false;
  return declaration.getStart() > token.blame.getStart();
}

function materialize(lowerer: Lowerer, token: MetaToken, loc: SrcLoc): IrExpr {
  switch (token.k) {
    case "void":
      return dynUndefinedExpr(loc);
    case "global":
      return materializeGlobal(lowerer, token.name, loc);
    case "class":
      // tsc's `__metadata("design:type", Dep)` evaluates the class value
      // where the decoration array is built. A same-module class whose
      // statement has not run yet is in its temporal dead zone then, so
      // the read throws Node's ReferenceError (TypeScript does not flag
      // this synthesized reference, only the run-time error exists).
      if (declaredAfterDecoration(token))
        return nodeThrowExpr(
          5,
          "",
          `Cannot access '${token.spelled}' before initialization`,
          DYN,
          loc,
        );
      return lowerer.coerceToExpected(classValueRef(lowerer, token.info, token.blame), DYN);
    case "entity": {
      if (!ts.isIdentifier(token.node)) return materializeGlobal(lowerer, "Object", loc);
      const value = lowerer.lowerExpr(token.node);
      return value.type.kind === "dyn" ? value : lowerer.coerceToExpected(value, DYN);
    }
  }
}

/** A rest parameter's element type (tsc's getRestParameterElementType): the
 * element of `T[]`, the argument of `Array<T>`/`ReadonlyArray<T>`, else
 * undefined (which serializes to Object). */
function restElementType(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (type === undefined) return undefined;
  if (ts.isArrayTypeNode(type)) return type.elementType;
  if (ts.isTypeReferenceNode(type)) {
    const name = identifierName(type);
    if (name === "Array" || name === "ReadonlyArray") return type.typeArguments?.nodes[0];
  }
  return undefined;
}

function serializeParameter(
  lowerer: Lowerer,
  parameter: ts.ParameterDeclaration,
  container: ts.Node,
): MetaToken {
  if (parameter.dotDotDotToken !== undefined)
    return typeToken(lowerer, restElementType(parameter.type), container);
  return typeToken(lowerer, parameter.type, container);
}

/** The parameters a decorated declaration's design:paramtypes covers: a
 * class's first constructor with a body; a getter's setter partner's
 * parameters (tsc's getParametersOfDecoratedDeclaration); else the
 * declaration's own. A `this` parameter is not serialized. */
function parameterTokens(
  lowerer: Lowerer,
  node: ts.ClassElement,
  container: ts.ClassLikeDeclaration,
): MetaToken[] {
  let parameters: readonly ts.ParameterDeclaration[] = [];
  if (ts.isConstructorDeclaration(node) || ts.isMethodDeclaration(node)) {
    parameters = node.parameters.nodes;
  } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const pair = accessorPair(container, node);
    parameters =
      pair.setter?.parameters.nodes ??
      (ts.isSetAccessorDeclaration(node) ? node.parameters.nodes : []);
  }
  const tokens: MetaToken[] = [];
  for (const parameter of parameters) {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === "this") continue;
    tokens.push(serializeParameter(lowerer, parameter, container));
  }
  return tokens;
}

/** The getter and setter declarations of one accessor pair. */
function accessorPair(
  container: ts.ClassLikeDeclaration,
  node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): { getter: ts.GetAccessorDeclaration | null; setter: ts.SetAccessorDeclaration | null } {
  const name = node.name.getText();
  let getter: ts.GetAccessorDeclaration | null = null;
  let setter: ts.SetAccessorDeclaration | null = null;
  for (const member of container.members.nodes) {
    if (member === node) continue;
    if (member.name?.getText() !== name) continue;
    if (ts.isGetAccessorDeclaration(member)) getter = member;
    else if (ts.isSetAccessorDeclaration(member)) setter = member;
  }
  return { getter, setter };
}

/** The design:type value of an accessor pair (tsc's getAccessorTypeNode):
 * the setter's parameter type when there is a setter, else the getter's
 * return type. */
function accessorTypeToken(
  lowerer: Lowerer,
  node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  container: ts.ClassLikeDeclaration,
): MetaToken {
  const pair = accessorPair(container, node);
  const ownSetter = ts.isSetAccessorDeclaration(node) ? node : pair.setter;
  const ownGetter = ts.isGetAccessorDeclaration(node) ? node : pair.getter;
  if (ownSetter !== null) return typeToken(lowerer, ownSetter.parameters.nodes[0]?.type, container);
  return typeToken(lowerer, ownGetter?.type, container);
}

function isAsync(node: ts.Node): boolean {
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

/** The `__metadata(...)` decorator values of one decorated member, in tsc's
 * array order: design:type, design:paramtypes, design:returntype (a method
 * only; accessors get type and paramtypes). */
export function declarationMetadata(
  lowerer: Lowerer,
  node: ts.ClassElement,
  container: ts.ClassLikeDeclaration,
): IrExpr[] {
  const loc = locOf(node);
  const entries: IrExpr[] = [];
  const paramTypes = (): IrExpr => ({
    kind: "arrayLit",
    elems: parameterTokens(lowerer, node, container).map((token) =>
      materialize(lowerer, token, loc),
    ),
    type: { kind: "array", elem: DYN },
    loc,
  });
  if (ts.isPropertyDeclaration(node)) {
    entries.push(
      metadataDecoratorValue(
        lowerer,
        "design:type",
        materialize(lowerer, typeToken(lowerer, node.type, container), loc),
        loc,
      ),
    );
    return entries;
  }
  if (ts.isMethodDeclaration(node)) {
    entries.push(
      metadataDecoratorValue(
        lowerer,
        "design:type",
        materializeGlobal(lowerer, "Function", loc),
        loc,
      ),
    );
    entries.push(metadataDecoratorValue(lowerer, "design:paramtypes", paramTypes(), loc));
    const ret =
      node.type !== undefined
        ? materialize(lowerer, typeToken(lowerer, node.type, container), loc)
        : isAsync(node)
          ? materializeGlobal(lowerer, "Promise", loc)
          : dynUndefinedExpr(loc);
    entries.push(metadataDecoratorValue(lowerer, "design:returntype", ret, loc));
    return entries;
  }
  // Get/set accessors: design:type and the setter's parameter list, no
  // design:returntype (tsc's shouldAddReturnTypeMetadata is methods-only).
  entries.push(
    metadataDecoratorValue(
      lowerer,
      "design:type",
      materialize(
        lowerer,
        accessorTypeToken(
          lowerer,
          node as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
          container,
        ),
        loc,
      ),
      loc,
    ),
  );
  entries.push(metadataDecoratorValue(lowerer, "design:paramtypes", paramTypes(), loc));
  return entries;
}

/** `design:paramtypes` for a decorated class: the first constructor with a
 * body's parameters. tsc emits no class metadata when there is none. */
export function classMetadata(lowerer: Lowerer, decl: ts.ClassLikeDeclaration): IrExpr[] {
  const constructor = decl.members.nodes.find(
    (member): member is ts.ConstructorDeclaration =>
      ts.isConstructorDeclaration(member) && member.body !== undefined,
  );
  if (constructor === undefined) return [];
  const loc = locOf(decl);
  const tokens = parameterTokens(lowerer, constructor, decl);
  const value: IrExpr = {
    kind: "arrayLit",
    elems: tokens.map((token) => materialize(lowerer, token, loc)),
    type: { kind: "array", elem: DYN },
    loc,
  };
  return [metadataDecoratorValue(lowerer, "design:paramtypes", value, loc)];
}

/** One `__metadata(key, value)` decorator value: the value argument is
 * evaluated first (tsc passes it to the helper), then the program's
 * `Reflect.metadata` when it has one. Undefined when the program never
 * loaded a metadata polyfill, so the decoration array skips it. */
export function metadataDecoratorValue(
  lowerer: Lowerer,
  key: string,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr {
  // A paramtypes value is an array literal; the helper takes it as an
  // ordinary value, so it crosses into the checked-dynamic tree here.
  value = lowerer.coerceToExpected(value, DYN);
  const valueLocal = lowerer.declareHiddenLocal("metaval", DYN);
  const fnLocal = lowerer.declareHiddenLocal("metadatafn", DYN);
  const namespace = builtinNamespaceValue(lowerer, "Reflect", loc);
  if (namespace === null) {
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: valueLocal.id, init: value, loc }],
      result: dynUndefinedExpr(loc),
      type: DYN,
      loc,
    };
  }
  const call: IrExpr = {
    kind: "dynCall",
    callee: varRef(fnLocal.id, DYN, loc),
    calleeName: "Reflect.metadata",
    args: [
      lowerer.coerceToExpected({ kind: "strLit", value: key, type: STRING, loc }, DYN),
      varRef(valueLocal.id, DYN, loc),
    ],
    type: DYN,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: valueLocal.id, init: value, loc },
      {
        kind: "varDecl",
        localId: fnLocal.id,
        init: {
          kind: "dynKeyGet",
          value: namespace,
          key: { kind: "strLit", value: "metadata", type: STRING, loc },
          type: DYN,
          loc,
        },
        loc,
      },
    ],
    // `Reflect.metadata && Reflect.metadata(k, v)`: a program without the
    // polyfill contributes undefined (the helper's typeof guard).
    result: {
      kind: "logical",
      op: "&&",
      left: varRef(fnLocal.id, DYN, loc),
      right: call,
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}
