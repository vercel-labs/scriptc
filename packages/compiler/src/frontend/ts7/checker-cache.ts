import type { Node, SourceFile } from "./ast-types.js";
import type {
  IndexInfo,
  InterfaceType,
  Signature,
  Symbol as Ts7Symbol,
  Type,
  TypePredicate,
} from "./semantic-types.js";

/** A cached "the checker had no answer". Storing the sentinel instead of
 * undefined lets a hot lookup tell a memo hit from a miss with one get(). */
export const ABSENT: unique symbol = Symbol("absent");
export type Absent = typeof ABSENT;

/** One facade's answers for one immutable semantic project. Strong keys
 * are safe only within this lifetime: project disposal clears every map,
 * including answers for AST objects reused by later snapshots. */
export class CheckerCache {
  private disposed = false;
  readonly typeAtLocation = new Map<Node, Type | Absent>();
  readonly symbolAtLocation = new Map<Node, Ts7Symbol | Absent>();
  readonly contextualType = new Map<Node, Type | Absent>();
  readonly typeFromTypeNode = new Map<Node, Type | undefined>();
  readonly shorthandValueSymbol = new Map<Node, Ts7Symbol | undefined>();
  readonly resolvedSignature = new Map<Node, Signature | Absent>();
  readonly signatureFromDeclaration = new Map<Node, Signature | undefined>();
  readonly typeOfSymbol = new Map<Ts7Symbol, Type | Absent>();
  readonly aliasedSymbol = new Map<Ts7Symbol, Ts7Symbol>();
  readonly immediateAliasedSymbol = new Map<Ts7Symbol, Ts7Symbol | Absent>();
  readonly exportsOfModule = new Map<Ts7Symbol, readonly Ts7Symbol[]>();
  readonly declaredTypeOfSymbol = new Map<Ts7Symbol, Type>();
  readonly baseTypeOfLiteral = new Map<Type, Type>();
  readonly baseTypesOf = new Map<InterfaceType, readonly Type[]>();
  readonly neverTypeAnswer = new Map<Type, boolean>();
  readonly assignableTypes = new Map<Type, Map<Type, boolean>>();
  readonly nonNullableType = new Map<Type, Type | undefined>();
  readonly propertiesOfType = new Map<Type, readonly Ts7Symbol[]>();
  readonly propertyOfType = new Map<Type, Map<string, Ts7Symbol | Absent>>();
  readonly indexInfosOfType = new Map<Type, readonly IndexInfo[]>();
  readonly typeArgumentsOf = new Map<Type, readonly Type[]>();
  readonly arrayTypeAnswer = new Map<Type, boolean>();
  readonly arrayLikeAnswer = new Map<Type, boolean>();
  readonly typeStringOf = new Map<Type, string>();
  readonly awaitedTypeOf = new Map<Type, Type | undefined>();
  readonly returnTypeOf = new Map<Signature, Type | Absent>();
  readonly typePredicateOf = new Map<Signature, TypePredicate | undefined>();
  readonly prefetchedTypes = new Set<SourceFile>();
  readonly prefetchedSymbols = new Set<SourceFile>();
  readonly managedTypes = new Set<SourceFile>();
  readonly managedSymbols = new Set<SourceFile>();
  readonly intrinsics = new Map<string, Type>();
  readonly tupleTypeAnswer = new Map<Type, boolean>();
  readonly callSigsOf = new Map<Type, readonly Signature[]>();
  readonly ctorSigsOf = new Map<Type, readonly Signature[]>();
  readonly constantValueOf = new Map<Node, string | number | undefined>();
  unknownType: Type | null = null;

  ensureActive(): void {
    if (this.disposed) throw new Error("TypeScript checker facade is disposed");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.typeAtLocation.clear();
    this.symbolAtLocation.clear();
    this.contextualType.clear();
    this.typeFromTypeNode.clear();
    this.shorthandValueSymbol.clear();
    this.resolvedSignature.clear();
    this.signatureFromDeclaration.clear();
    this.typeOfSymbol.clear();
    this.aliasedSymbol.clear();
    this.immediateAliasedSymbol.clear();
    this.exportsOfModule.clear();
    this.declaredTypeOfSymbol.clear();
    this.baseTypeOfLiteral.clear();
    this.baseTypesOf.clear();
    this.neverTypeAnswer.clear();
    this.assignableTypes.clear();
    this.nonNullableType.clear();
    this.propertiesOfType.clear();
    this.propertyOfType.clear();
    this.indexInfosOfType.clear();
    this.typeArgumentsOf.clear();
    this.arrayTypeAnswer.clear();
    this.arrayLikeAnswer.clear();
    this.typeStringOf.clear();
    this.awaitedTypeOf.clear();
    this.returnTypeOf.clear();
    this.typePredicateOf.clear();
    this.prefetchedTypes.clear();
    this.prefetchedSymbols.clear();
    this.managedTypes.clear();
    this.managedSymbols.clear();
    this.intrinsics.clear();
    this.tupleTypeAnswer.clear();
    this.callSigsOf.clear();
    this.ctorSigsOf.clear();
    this.constantValueOf.clear();
    this.unknownType = null;
  }
}
