import { AstNode } from "../../../packages/compiler/src/frontend/ts7/ast-node.js";
import type { SourceFile } from "../../../packages/compiler/src/frontend/ts7/ast-types.js";
import { CheckerFacade, constituentTypes } from "../../../packages/compiler/src/frontend/ts7/checker.js";
import { SemanticChecker } from "../../../packages/compiler/src/frontend/ts7/semantic-checker.js";
import { SemanticType, symbolName, symbolNameOf } from "../../../packages/compiler/src/frontend/ts7/semantic-model.js";
import { SyntaxKind, TypeFlags } from "../../../packages/compiler/src/frontend/ts7/enums.js";

export function checkerSource(): string {
  return '\nexport type Promised = Promise<number>;\n'
    + 'export type MaybePromised = number | PromiseLike<number>;\n'
    + 'export type DifferentPromises = Promise<number> | Promise<string>;\n'
    + 'export type Impossible = { kind: "left" } & { kind: "right" };\n'
    + 'export type Intersection = { a: number } & { b: string };\n'
    + 'export type PlainNever = never;\n'
    + 'export const contextual: { n: number } = { n: 42 };\n'
    + 'export function deferred(value: number = answer): number { const inside = value + 1; return inside; }\n';
}

function check(value: boolean, message: string): void {
  if (!value) throw new Error(`Checker facade: ${message}`);
}

function declaration(root: SourceFile, name: string): AstNode {
  for (const statement of root.statements.nodes) {
    if (statement.name?.text === name) return statement;
    for (const variable of statement.declarationList?.declarations?.nodes ?? []) {
      if (variable.name?.text === name) return variable;
    }
  }
  throw new Error(`Missing checker fixture declaration ${name}`);
}

function aliasType(facade: CheckerFacade, root: SourceFile, name: string): SemanticType {
  return facade.getTypeFromTypeNode(declaration(root, name).type!);
}

/** The production memoizing facade executes here in both Node and native
 * binaries. Request counts establish warm-cache behavior independently of
 * the cache implementation, and relationships come from the live checker. */
export function checkCheckerFacade(raw: SemanticChecker, root: SourceFile, requests: () => number): CheckerFacade {
  const facade = new CheckerFacade(raw, { project: raw.project, autoPrefetch: false });
  const answer = declaration(root, "answer");
  const answerName = answer.name!;
  const answerType = facade.getTypeAtLocation(answerName);
  const answerSymbol = facade.getSymbolAtLocation(answerName)!;
  const number = facade.getNumberType();
  const string = facade.getStringType();
  const boolean = facade.getBooleanType();
  check(facade.typeToString(answerType) === "42", "literal display");
  check(facade.getBaseTypeOfLiteralType(answerType) === number, "number literal base");
  check(facade.getTypeOfSymbol(answerSymbol) === answerType, "symbol type");
  check(facade.getTypeOfSymbolAtLocation(answerSymbol, answerName) === answerType, "location type");
  check(answerSymbol.declarations[0] === answer, "declaration identity");
  check(answerSymbol.valueDeclaration === answer, "value declaration");
  check(facade.getContextualType(answerName) === undefined, "absent contextual type");
  check(facade.getSymbolAtLocation(root.endOfFileToken) === undefined, "absent symbol");
  check(facade.getUnknownType().flags === TypeFlags.Unknown, "unknown intrinsic");
  check(facade.typeToString(answerType, answerName, 0) === "42", "explicit display flags");

  const emptyString = facade.getTypeAtLocation(declaration(root, "emptyString").name!);
  const huge = facade.getTypeAtLocation(declaration(root, "huge").name!);
  const flag = facade.getTypeAtLocation(declaration(root, "flag").name!);
  check(facade.getBaseTypeOfLiteralType(emptyString) === string, "string literal base");
  check(facade.getBaseTypeOfLiteralType(flag) === boolean, "boolean literal base");
  check(facade.typeToString(facade.getBaseTypeOfLiteralType(huge)) === "bigint", "bigint literal base");

  const box = declaration(root, "Box");
  const boxSymbol = facade.getSymbolAtLocation(box.name!)!;
  const boxType = facade.getDeclaredTypeOfSymbol(boxSymbol);
  check(symbolName(facade.getPropertyOfType(boxType, "value")!) === "value", "property lookup");
  check(facade.getPropertiesOfType(boxType).some((property) => symbolName(property) === "method"), "property list");
  check(facade.getBaseTypes(boxType).length === 0, "empty class bases");
  const child = facade.getDeclaredTypeOfSymbol(facade.getSymbolAtLocation(declaration(root, "Child").name!)!);
  check(facade.getBaseTypes(child)[0] === boxType, "class base identity");
  check(facade.getConstructSignatures(facade.getTypeOfSymbol(boxSymbol)).length === 1, "constructor signatures");
  const identity = declaration(root, "identity");
  const identityType = facade.getTypeAtLocation(identity.name!);
  const signature = facade.getSignatureFromDeclaration(identity)!;
  check(facade.getCallSignatures(identityType)[0] === signature, "call signature identity");
  check(signature.declaration === identity, "signature declaration identity");
  check(facade.typeToString(facade.getReturnTypeOfSignature(signature)) === "T", "generic return type");
  check(facade.getTypePredicateOfSignature(signature) === undefined, "absent predicate");
  const isBox = facade.getSignatureFromDeclaration(declaration(root, "isBox"))!;
  check(facade.getTypePredicateOfSignature(isBox)!.type === boxType, "predicate type identity");
  const call = declaration(root, "called").initializer!;
  const resolved = facade.getResolvedSignature(call)!;
  check(resolved.declaration === identity, "instantiated signature declaration");
  check(facade.typeToString(facade.getReturnTypeOfSignature(resolved)).includes("n: number"), "instantiated return type");

  const ref = declaration(root, "ref").initializer!.properties?.nodes[0]!;
  check(facade.getShorthandAssignmentValueSymbol(ref) === answerSymbol, "shorthand value symbol");
  const renamed = root.statements.nodes.find((statement) => statement.kind === SyntaxKind.ExportDeclaration)!.exportClause!.elements?.nodes[0]!;
  const alias = facade.getSymbolAtLocation(renamed.name!)!;
  check(facade.getAliasedSymbol(alias) === answerSymbol, "export alias");
  const member = declaration(root, "Mode").members?.nodes[0]!;
  check(facade.getConstantValue(member) === 3, "enum constant");
  check(facade.getConstantValue(answer) === undefined, "absent constant");
  const contextual = declaration(root, "contextual").initializer!;
  check(facade.typeToString(facade.getContextualType(contextual)!).includes("n: number"), "contextual object");

  const choice = aliasType(facade, root, "Choice");
  const arms = constituentTypes(choice);
  check(arms.length === 3 && arms.includes(number) && arms.includes(string), "union constituent identity");
  check(constituentTypes(choice) === arms && choice.getTypes() === arms, "shared constituent memo");
  check(facade.getBaseTypeOfLiteralType(choice) === raw.getBaseTypeOfLiteralType(choice), "union literal base");
  check(facade.getNonNullableType(aliasType(facade, root, "Nullable")) === boxType, "non-nullable class");
  const intersection = aliasType(facade, root, "Intersection");
  check(constituentTypes(intersection).length === 2, "intersection constituents");
  check(!facade.isNeverType(intersection) && facade.isNeverType(aliasType(facade, root, "Impossible")), "semantic never");
  check(facade.isNeverType(aliasType(facade, root, "PlainNever")), "intrinsic never");
  check(!facade.isNeverType(number), "primitive never fast path");
  check(facade.isTypeAssignableTo(answerType, number), "assignable literal");
  check(!facade.isTypeAssignableTo(number, answerType), "nonassignable reverse");
  check(facade.isTypeAssignableTo(answerType, answerType), "assignability identity fast path");

  const pair = facade.getTypeAtLocation(declaration(root, "pair").name!);
  const many = facade.getTypeAtLocation(declaration(root, "many").name!);
  check(facade.isTupleType(pair) && facade.isTupleType(pair.getTarget()!), "tuple reference and target");
  check(!facade.isTupleType(number) && !facade.isTupleType(many), "non-tuples");
  check(facade.isArrayType(many) && !facade.isArrayType(pair) && !facade.isArrayType(number), "array classification");
  check(facade.isArrayLikeType(pair) && facade.isArrayLikeType(many), "array-like classification");
  check(facade.getTypeArguments(pair)[0] === number && facade.getTypeArguments(pair)[1] === string, "tuple arguments");
  check(facade.getTypeArguments(number).length === 0, "nonreference arguments");
  const dict = facade.getDeclaredTypeOfSymbol(facade.getSymbolAtLocation(declaration(root, "Dict").name!)!);
  const index = facade.getIndexInfosOfType(dict)[0]!;
  check(index.keyType === string && index.type === number && index.isReadonly, "index signature");
  check(facade.getAwaitedType(aliasType(facade, root, "Promised")) === number, "await promise");
  check(facade.getAwaitedType(aliasType(facade, root, "MaybePromised")) === number, "await collapsed union");
  check(facade.getAwaitedType(aliasType(facade, root, "DifferentPromises")) === undefined, "await distinct union refusal");
  check(facade.getAwaitedType(choice) === choice, "await unchanged union");

  // These include false, undefined, empty arrays, nested assignability
  // maps, and all local fast paths. None should make another RPC request.
  const before = requests();
  for (let pass = 0; pass < 2; pass++) {
    check(facade.getTypeAtLocation(answerName) === answerType, "warm node type");
    check(facade.getSymbolAtLocation(answerName) === answerSymbol, "warm node symbol");
    check(facade.getSymbolAtLocation(root.endOfFileToken) === undefined, "warm absent symbol");
    check(facade.getContextualType(answerName) === undefined, "warm absent context");
    check(facade.getTypeOfSymbol(answerSymbol) === answerType, "warm symbol type");
    check(facade.getDeclaredTypeOfSymbol(boxSymbol) === boxType, "warm declared type");
    check(facade.getAliasedSymbol(alias) === answerSymbol, "warm alias");
    check(answerSymbol.declarations[0] === answer, "warm declarations");
    check(answerSymbol.valueDeclaration === answer, "warm value declaration");
    check(facade.getResolvedSignature(call) === resolved, "warm resolved signature");
    check(facade.getSignatureFromDeclaration(identity) === signature, "warm signature");
    check(signature.declaration === identity, "warm signature declaration");
    check(facade.getTypePredicateOfSignature(signature) === undefined, "warm absent predicate");
    check(facade.getTypePredicateOfSignature(isBox)!.type === boxType, "warm predicate");
    check(facade.getCallSignatures(identityType)[0] === signature, "warm call signatures");
    check(facade.getShorthandAssignmentValueSymbol(ref) === answerSymbol, "warm shorthand");
    check(facade.getConstantValue(member) === 3 && facade.getConstantValue(answer) === undefined, "warm constants");
    check(facade.getBaseTypeOfLiteralType(answerType) === number, "warm base literal");
    check(facade.getBaseTypes(boxType).length === 0 && facade.getBaseTypes(child)[0] === boxType, "warm base types");
    check(facade.getPropertiesOfType(boxType).length > 0, "warm property list");
    check(facade.getIndexInfosOfType(dict)[0] === index, "warm index info identity");
    check(facade.isArrayType(many) && !facade.isArrayType(pair), "warm array answers");
    check(facade.isTupleType(pair) && !facade.isTupleType(many), "warm tuple answers");
    check(facade.isArrayLikeType(pair), "warm array-like answer");
    check(facade.getTypeArguments(pair)[0] === number, "warm arguments");
    check(facade.isTypeAssignableTo(answerType, number) && !facade.isTypeAssignableTo(number, answerType), "warm two-key answers");
    check(facade.typeToString(answerType) === "42", "warm display");
    check(facade.getUnknownType().flags === TypeFlags.Unknown, "warm unknown");
    check(facade.getStringType() === string && facade.getNumberType() === number && facade.getBooleanType() === boolean, "warm intrinsics");
    check(constituentTypes(choice) === arms && facade.getAwaitedType(choice) === choice, "warm constituents and await");
  }
  check(requests() === before, "warm queries avoid RPC");

  // Cover every prefetch entry on a separate facade: warm direct queries
  // above must not mask a broken batch path in the native compiler.
  const batch = new CheckerFacade(raw, { project: raw.project });
  batch.prefetchSourceFileStructures([root, root]);
  batch.prefetchSymbolRoots([identity, identity]);
  batch.prefetchSymbolNodesExact([answerName, answerName]);
  batch.prefetchCollectionTypes([call, call]);
  batch.prefetchClassCollection([box.members?.nodes[0]!.initializer!], [box]);
  batch.prefetchRoots([identity.body!, identity.body!]);
  batch.prefetchSourceFile(root);
  check(batch.getTypeAtLocation(answerName) === answerType && batch.getSymbolAtLocation(answerName) === answerSymbol, "prefetched semantic identity");
  batch.dispose();
  batch.dispose();
  let refused = false;
  try { batch.getTypeAtLocation(answerName); } catch { refused = true; }
  check(refused, "disposed facade refuses warm answers");
  check(facade.getTypeAtLocation(answerName) === answerType, "facade disposal does not dispose its project");
  return facade;
}

export function checkDisposedChecker(facade: CheckerFacade, root: SourceFile): void {
  let refused = 0;
  try { facade.getTypeAtLocation(declaration(root, "answer").name!); } catch { refused++; }
  try { facade.getUnknownType(); } catch { refused++; }
  try { facade.prefetchSourceFile(root); } catch { refused++; }
  check(refused === 3, "project disposal invalidates retained facade");
}
