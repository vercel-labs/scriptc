import { AstFile, AstNode } from "../../../packages/compiler/src/frontend/ts7/ast-node.js";
import { AstKind } from "../../../packages/compiler/src/frontend/ts7/ast-schema.generated.js";
import { SemanticChecker } from "../../../packages/compiler/src/frontend/ts7/semantic-checker.js";
import { SemanticSignature, SemanticSnapshot, SemanticSymbol, SemanticType, symbolName, symbolNameOf } from "../../../packages/compiler/src/frontend/ts7/semantic-model.js";
import type { __String } from "../../../packages/compiler/src/frontend/ts7/ast-types.js";
import { SemanticSignatureKind, SemanticSymbolFlags, SemanticTypeFlags } from "../../../packages/compiler/src/frontend/ts7/semantic-schema.generated.js";

export function semanticSource(): string {
  return '\nexport type Choice = string | number | null;\n'
    + 'export type Pair<T> = readonly [T, string];\n'
    + 'export const pair: Pair<number> = [1, "a"];\n'
    + 'export interface Dict { readonly [key: string]: number; }\n'
    + 'export interface Generic<T> { item: T; }\n'
    + 'export type GenericAlias = Generic<number>;\n'
    + 'export class Child extends Box {}\n'
    + '/** Keep the input.\n * @param value input value\n */\n'
    + 'export function identity<T extends { n: number }>(value: T): T { return value; }\n'
    + 'export const called = identity({ n: 1 });\n'
    + 'export function isBox(value: unknown): value is Box { return value instanceof Box; }\n'
    + 'export function withThis(this: Box, ...items: number[]): number { return items.length; }\n'
    + 'export const huge = -123456789012345678901234567890n;\n'
    + 'export const flag = false;\n'
    + 'export const emptyString = "";\n'
    + 'export const ref = { answer };\n'
    + 'export { answer as renamed };\n'
    + 'export enum Mode { Ready = 3 }\n'
    + 'export const enumValue = Mode.Ready;\n'
    + 'export type Nullable = Box | undefined;\n'
    + 'export type Conditional<T> = T extends string ? number : boolean;\n'
    + 'export type Indexed<T extends Generic<number>> = T["item"];\n'
    + 'export type Keys<T> = keyof T;\n'
    + 'export type Template<T extends string> = `prefix${T}suffix`;\n'
    + 'export type Mapped<T extends string> = Uppercase<T>;\n';
}

function check(value: boolean, message: string): void {
  if (!value) throw new Error(`Semantic client: ${message}`);
}

function declaration(root: AstNode, name: string): AstNode {
  for (const statement of root.statements?.nodes ?? []) {
    if (statement.name?.text === name) return statement;
    for (const variable of statement.declarationList?.declarations?.nodes ?? []) {
      if (variable.name?.text === name) return variable;
    }
  }
  throw new Error(`Missing semantic fixture declaration ${name}`);
}

function typeAt(checker: SemanticChecker, node: AstNode): SemanticType {
  const type = checker.getTypeAtLocation(node);
  if (type === undefined) throw new Error("Missing semantic fixture type");
  return type;
}

function symbolAt(checker: SemanticChecker, node: AstNode): SemanticSymbol {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) throw new Error("Missing semantic fixture symbol");
  return symbol;
}

function signatureAt(checker: SemanticChecker, node: AstNode): SemanticSignature {
  const signature = checker.getSignatureFromDeclaration(node);
  if (signature === undefined) throw new Error("Missing semantic fixture signature");
  return signature;
}

/** This runs both in Node and in native LLVM executables. Each fact
 * checks relationships within the live native parser/checker's response;
 * server-assigned numeric handles never become hard-coded test answers. */
export function checkSemanticModel(snapshot: SemanticSnapshot, checker: SemanticChecker, file: AstFile): void {
  const root = file.root;
  const answer = declaration(root, "answer");
  const answerName = answer.name!;
  const answerSymbol = symbolAt(checker, answerName);
  const answerType = typeAt(checker, answerName);
  const missing = root.endOfFileToken!;
  const nodeTypes = checker.getTypeAtLocation([answerName, missing, answerName]);
  const nodeSymbols = checker.getSymbolAtLocation([answerName, missing, answerName]);
  check(nodeTypes[0] === answerType && nodeTypes[2] === answerType, "batched type identity/order");
  check(nodeSymbols[0] === answerSymbol && nodeSymbols[2] === answerSymbol && nodeSymbols[1] === undefined, "batched symbol null/identity/order");
  check(checker.getTypeOfSymbol(answerSymbol) === answerType, "symbol type identity");
  check(checker.getTypeOfSymbol([answerSymbol, answerSymbol])[1] === answerType, "batch symbol types");
  check(checker.getTypeOfSymbolAtLocation(answerSymbol, answerName) === answerType, "location-dependent symbol type");
  check(answerSymbol.valueDeclarationHandle?.resolve() === answer && answerSymbol.declarationHandles[0]!.resolve() === answer, "default declaration resolution");
  check(answerSymbol.declarationHandles[0]!.resolve(checker.project) === answer, "explicit declaration project");
  check(checker.getTypeAtPosition(root.fileName, [answerName.getStart(), answerName.getStart()])[1] === answerType, "position type batch");
  check(checker.getSymbolAtPosition(root.fileName, [answerName.getStart(), answerName.getStart()])[1] === answerSymbol, "position symbol batch");
  check(checker.getResolvedSymbol(answerName)!.getExportSymbol() === answerSymbol, "resolved local/export symbol identity");
  check(checker.resolveName("answer", SemanticSymbolFlags.Value, { document: root.fileName, position: answerName.getStart() }) === answerSymbol, "position name resolution");
  check(checker.resolveName("scriptcMissing", SemanticSymbolFlags.Value, answerName) === undefined, "missing name");

  const intrinsicNumber = checker.getNumberType();
  const intrinsicString = checker.getStringType();
  check(checker.getBaseTypeOfLiteralType(answerType) === intrinsicNumber, "literal base type");
  check(answerType.getFreshType()!.getRegularType() === answerType.getRegularType(), "fresh/regular literal identity");
  const huge = typeAt(checker, declaration(root, "huge").name!);
  check(huge.isBigIntLiteralType() && huge.value === -123456789012345678901234567890n, "arbitrary precision bigint response");
  check(typeAt(checker, declaration(root, "flag").name!).value === false, "false literal response");
  check(typeAt(checker, declaration(root, "emptyString").name!).value === "", "empty string literal response");
  const intrinsics = [checker.getAnyType(), intrinsicString, intrinsicNumber, checker.getVoidType(), checker.getUndefinedType(), checker.getNullType(), checker.getNeverType(), checker.getUnknownType(), checker.getBigIntType(), checker.getESSymbolType()];
  for (const type of intrinsics) check(type.isIntrinsicType() && !type.isErrorType() && type.intrinsicName !== undefined, "intrinsic metadata");
  const boolean = checker.getBooleanType();
  check(boolean.isUnionType() && boolean.getTypes()!.every((type) => type.isBooleanLiteralType()), "boolean literal union");
  check(checker.isTypeAssignableTo(answerType, intrinsicNumber) && !checker.isTypeAssignableTo(intrinsicNumber, answerType), "assignability");
  check(checker.getWidenedType(answerType) !== undefined && checker.getApparentType(intrinsicString)!.isObjectType(), "widened and apparent types");
  check(checker.getBaseConstraintOfType(answerType) === undefined, "absent base constraint");

  const choice = typeAt(checker, declaration(root, "Choice").type!);
  check(choice.isUnionType() && !choice.isIntersectionType() && choice.getTypes()!.length === 3, "union constituents");
  check(choice.getTypes()!.some((type) => type === intrinsicString) && choice.getTypes()!.some((type) => type === intrinsicNumber), "constituent identity");
  const pair = typeAt(checker, declaration(root, "pair").name!);
  check(pair.isTypeReference() && checker.isTupleType(pair) && !checker.isArrayType(pair), "tuple reference classification");
  const pairTarget = pair.getTarget()!;
  check(pairTarget.isTupleType() && pairTarget.fixedLength === 2 && pairTarget.readonly === true && pairTarget.elementFlags!.length === 2, "tuple target metadata");
  check(checker.getTypeArguments(pair)[0] === intrinsicNumber && checker.getTypeArguments(pair)[1] === intrinsicString, "tuple argument identities");
  check(symbolName(pair.getAliasSymbol()!) === "Pair" && pair.getAliasTypeArguments()[0] === intrinsicNumber, "alias metadata");

  const box = declaration(root, "Box");
  const boxSymbol = symbolAt(checker, box.name!);
  const boxType = checker.getDeclaredTypeOfSymbol(boxSymbol);
  check(boxType.isClassOrInterface() && boxType.getSymbol() === boxSymbol, "declared class type");
  // The checker instantiates a transient property symbol for a class type;
  // the binder's member symbol is distinct but refers to the same AST node.
  const boundMember = boxSymbol.getMembers().get("value" as __String)!;
  const checkedMember = checker.getPropertyOfType(boxType, "value")!;
  check(boundMember !== checkedMember && boundMember.declarationHandles[0]!.resolve() === checkedMember.declarationHandles[0]!.resolve(), "bound and instantiated member declarations");
  check(boxSymbol.getMembers() === boxSymbol.getMembers() && boxSymbol.getExports() === boxSymbol.getExports(), "symbol table cache");
  check(boxType.getBaseTypes()!.length === 0 && checker.getBaseTypes(boxType).length === 0, "empty base types");
  const child = checker.getDeclaredTypeOfSymbol(symbolAt(checker, declaration(root, "Child").name!));
  check(child.getBaseTypes()![0] === boxType && checker.getBaseTypes(child)[0] === boxType, "base type request identity");
  check(checker.getPropertiesOfType(boxType).some((symbol) => symbolName(symbol) === "method"), "property query");
  check(checker.getPropertyOfType(boxType, "missing") === undefined, "absent property");
  const nullable = typeAt(checker, declaration(root, "Nullable").type!);
  check(checker.getNonNullableType(nullable) === boxType, "non-nullable type");
  const dict = checker.getDeclaredTypeOfSymbol(symbolAt(checker, declaration(root, "Dict").name!));
  const index = checker.getIndexInfosOfType(dict)[0]!;
  check(index.keyType === intrinsicString && index.type === intrinsicNumber && index.isReadonly, "index signature types");
  check(index.declaration === declaration(root, "Dict").members?.nodes[0], "index signature declaration");
  const generic = checker.getDeclaredTypeOfSymbol(symbolAt(checker, declaration(root, "Generic").name!));
  const genericParameter = generic.getTypeParameters()[0]!;
  check(genericParameter.isTypeParameter() && generic.getLocalTypeParameters()[0] === genericParameter && generic.getOuterTypeParameters().length === 0, "interface type parameters");
  const genericAlias = typeAt(checker, declaration(root, "GenericAlias").type!);
  check(genericAlias.getTarget() === generic && checker.getTypeArguments(genericAlias)[0] === intrinsicNumber, "generic target");

  const identity = declaration(root, "identity");
  const identitySymbol = symbolAt(checker, identity.name!);
  const signature = signatureAt(checker, identity);
  const signatureTypes = signature.getTypeParameters();
  check(signatureTypes.length === 1 && signatureTypes[0]!.isTypeParameter(), "signature type parameters");
  check(symbolName(signature.getParameters()[0]!) === "value" && signature.getParameters()[0]!.declarationHandles[0]!.resolve() === identity.parameters?.nodes[0], "signature parameters");
  check(signature.declarationHandle!.resolve() === identity, "signature declaration");
  check(checker.getReturnTypeOfSignature(signature) === signatureTypes[0], "generic return identity");
  check(checker.getParameterType(signature, 0) === signatureTypes[0], "parameter type query");
  const constraint = checker.getConstraintOfTypeParameter(signatureTypes[0]!)!;
  check(checker.getPropertyOfType(constraint, "n") !== undefined && checker.getBaseConstraintOfType(signatureTypes[0]!) === constraint, "generic constraints");
  check(checker.getSignaturesOfType(typeAt(checker, identity.name!), SemanticSignatureKind.Call)[0] === signature, "signature registry identity");
  const resolved = checker.getResolvedSignature(declaration(root, "called").initializer!)!;
  check(resolved.getTarget() === signature && resolved.getTypeParameters().length === 0, "instantiated signature target");
  const ctor = checker.getSignaturesOfType(checker.getTypeOfSymbol(boxSymbol)!, SemanticSignatureKind.Construct)[0]!;
  check(ctor.isConstruct && !ctor.isAbstract && checker.getReturnTypeOfSignature(ctor) === boxType, "construct signature");
  const thisSignature = signatureAt(checker, declaration(root, "withThis"));
  check(thisSignature.hasRestParameter && !thisSignature.isConstruct && symbolName(thisSignature.getThisParameter()!) === "this", "signature this/rest flags");
  check(checker.getRestTypeOfSignature(thisSignature) === intrinsicNumber && checker.isArrayLikeType(pair), "array predicates and rest element type");
  const predicate = checker.getTypePredicateOfSignature(signatureAt(checker, declaration(root, "isBox")))!;
  check(predicate.type === boxType && predicate.parameterIndex === 0 && predicate.parameterName === "value", "type predicate");
  check(checker.getTypePredicateOfSignature(signature) === undefined, "absent predicate");
  check(identitySymbol.getJsDocTags(checker).some((tag) => tag.name === "param"), "JSDoc tags");
  check(identitySymbol.getDocumentationComment(checker).includes("Keep the input"), "JSDoc documentation");

  const moduleSymbol = symbolAt(checker, root);
  const exports = moduleSymbol.getExports();
  const renamed = exports.get("renamed" as __String)!;
  check(checker.getAliasedSymbol(renamed) === answerSymbol && checker.getImmediateAliasedSymbol(renamed) === answerSymbol, "symbol alias targets");
  check(checker.getMemberInModuleExports(moduleSymbol, "answer") === answerSymbol, "module export lookup");
  check(checker.getExportsOfModule(moduleSymbol).some((symbol) => symbol === answerSymbol), "module exports identity");
  check(answerSymbol.getExportSymbol() === answerSymbol && answerSymbol.getParent() === moduleSymbol, "symbol parent/export handles");
  check(!checker.isUnknownSymbol(answerSymbol) && !checker.isUndefinedSymbol(answerSymbol) && !checker.isArgumentsSymbol(answerSymbol), "well-known symbol exclusion");
  const undefinedSymbol = checker.resolveName("undefined", SemanticSymbolFlags.Value, answerName)!;
  check(checker.isUndefinedSymbol(undefinedSymbol), "well-known undefined symbol");
  const shorthand = declaration(root, "ref").initializer!.properties?.nodes[0]!;
  check(checker.getShorthandAssignmentValueSymbol(shorthand) === answerSymbol, "shorthand symbol");
  const exportSpecifier = renamed.declarationHandles[0]!.resolve()!;
  check(checker.getExportSpecifierLocalTargetSymbol(exportSpecifier) === answerSymbol, "export specifier symbol");
  check(checker.getConstantValue(declaration(root, "Mode").members?.nodes[0]!) === 3, "enum constant");
  check(checker.getConstantValue(answerName) === undefined, "missing constant");
  check(checker.getContextualType(declaration(root, "pair").initializer!) === pair, "contextual tuple type");
  check(checker.getTypeFromTypeNode(declaration(root, "Choice").type!) === choice, "type-node query identity");
  check(!checker.isContextSensitive(answerName), "context sensitivity query");

  const conditional = typeAt(checker, declaration(root, "Conditional").type!);
  check(conditional.isConditionalType() && conditional.getCheckType()!.isTypeParameter() && conditional.getExtendsType() === intrinsicString, "conditional metadata");
  check(conditional.getTrueType() === intrinsicNumber && conditional.getFalseType() === checker.getBooleanType(), "conditional lazy branches");
  const indexed = typeAt(checker, declaration(root, "Indexed").type!);
  check(indexed.isIndexedAccessType() && indexed.getObjectType()!.isTypeParameter() && indexed.getIndexType()!.value === "item", "indexed access type");
  const keys = typeAt(checker, declaration(root, "Keys").type!);
  check(keys.isIndexType() && keys.getTarget()!.isTypeParameter(), "index type target");
  const template = typeAt(checker, declaration(root, "Template").type!);
  check(template.isTemplateLiteralType() && template.texts!.join("|") === "prefix|suffix" && template.getTypes()![0]!.isTypeParameter(), "template literal type metadata");
  const mapped = typeAt(checker, declaration(root, "Mapped").type!);
  check(mapped.isStringMappingType() && mapped.getTarget()!.isTypeParameter(), "string mapping type");
  check(checker.typeToTypeNode(intrinsicNumber, answer)!.kind === AstKind.NumberKeyword, "binary type node");
  const syntheticType = checker.typeToTypeNode(boxType, box)!;
  check(syntheticType.kind === AstKind.TypeReference, "binary class type node");
  check(syntheticType.typeName!.text === "Box", "synthetic type child");
  check(syntheticType.typeName!.parent === syntheticType, "synthetic type parent identity");
  check(syntheticType.file.node(1) === syntheticType, "synthetic root identity");
  const syntheticSignature = checker.signatureToSignatureDeclaration(signature, AstKind.FunctionType, identity)!;
  check(syntheticSignature.kind === AstKind.FunctionType, "binary signature node");
  check(syntheticSignature.parameters?.nodes.length === 1 && syntheticSignature.parameters?.nodes[0]!.name!.text === "value", "synthetic signature children");
  let syntheticRefusals = 0;
  try { syntheticType.getSourceFile(); } catch { syntheticRefusals++; }
  try { syntheticSignature.file.sourceFile; } catch { syntheticRefusals++; }
  check(syntheticRefusals === 2, "fragments cannot claim source-file views");
  const references = checker.getReferencesToSymbolInFile(root.fileName, answerSymbol);
  check(references.length > 0 && references.every((handle) => handle.resolve() !== undefined), "reference node handles");
  check(checker.getReferencedSymbolsForNode(root, answerName.getStart()).length === 0, "empty referenced-symbol query");
  const usages = checker.getSignatureUsage(identity);
  check(usages.length === 1 && usages[0]!.name.resolve()!.text === "identity" && usages[0]!.call!.resolve() === declaration(root, "called").initializer, "signature usage handles");
  const completions = checker.getCompletionsAtPosition(root.fileName, root.text!.indexOf("Mode.Ready") + 5, { includeSymbol: true })!;
  const ready = completions.entries.find((entry) => entry.name === "Ready")!;
  check(ready.symbol === symbolAt(checker, declaration(root, "Mode").members?.nodes[0]!.name!), "completion symbol identity");
  check(checker.getCompletionsAtPosition(root.fileName, answerName.getStart()) === undefined, "absent completions");
  check(answerType.flags === SemanticTypeFlags.NumberLiteral, "literal flags pin");
  check(checkSemanticRefinements(answerType) === "number:43", "native number literal refinement");
  check(checkSemanticRefinements(typeAt(checker, declaration(root, "emptyString").name!)) === "string:", "native string literal refinement");
  check(checkSemanticRefinements(huge) === "bigint:-123456789012345678901234567889", "native bigint literal refinement");
  check(checkSemanticRefinements(typeAt(checker, declaration(root, "flag").name!)) === "boolean:no", "native boolean literal refinement");
  check(checkSemanticRefinements(intrinsicString) === "intrinsic:STRING", "native intrinsic refinement");
  check(checkSemanticRefinements(pair).startsWith("object:"), "native object flags refinement");

  // Disposed object graphs must not fetch a replacement under recycled ids.
  snapshot.dispose();
  snapshot.dispose();
  let refused = false;
  try { answerType.getRegularType(); } catch { refused = true; }
  check(refused, "type access after disposal");
  refused = false;
  try { answerSymbol.declarationHandles[0]!.resolve(); } catch { refused = true; }
  check(refused, "declaration access after disposal");
}

/** Exercise the concrete client through its own predicates. Field reads
 * retain the original tagged layout while the views retain object identity. */
export function checkSemanticRefinements(type: SemanticType): string {
  if (type.isStringLiteralType()) return "string:" + type.value.toUpperCase();
  if (type.isNumberLiteralType()) return "number:" + (type.value + 1);
  if (type.isBigIntLiteralType()) return "bigint:" + (type.value + 1n).toString();
  if (type.isBooleanLiteralType()) return "boolean:" + (type.value ? "yes" : "no");
  if (type.isObjectType()) return "object:" + type.objectFlags.toString();
  if (type.isIntrinsicType()) return "intrinsic:" + type.intrinsicName.toUpperCase();
  return "other";
}
