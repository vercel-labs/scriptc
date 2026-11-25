// Generated from typescript@7.1.0-beta, with response shapes from typescript@7.0.2, by scripts/generate-ts7-ast-schema.mjs.
// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.
// Regenerate when changing the TypeScript pin; do not edit by hand.

export const SemanticTypeFlags = {
  None: 0,
  Any: 1,
  Unknown: 2,
  Undefined: 4,
  Null: 8,
  Void: 16,
  String: 32,
  Number: 64,
  BigInt: 128,
  Boolean: 256,
  ESSymbol: 512,
  StringLiteral: 1024,
  NumberLiteral: 2048,
  BigIntLiteral: 4096,
  BooleanLiteral: 8192,
  UniqueESSymbol: 16384,
  EnumLiteral: 32768,
  Enum: 65536,
  NonPrimitive: 131072,
  Never: 262144,
  TypeParameter: 524288,
  Object: 1048576,
  Index: 2097152,
  TemplateLiteral: 4194304,
  StringMapping: 8388608,
  Substitution: 16777216,
  IndexedAccess: 33554432,
  Conditional: 67108864,
  Union: 134217728,
  Intersection: 268435456,
  Reserved1: 536870912,
  Reserved2: 1073741824,
  Reserved3: -2147483648,
  AnyOrUnknown: 3,
  Nullable: 12,
  Literal: 15360,
  Unit: 97292,
  Freshable: 80896,
  StringOrNumberLiteral: 3072,
  StringOrNumberLiteralOrUnique: 19456,
  DefinitelyFalsy: 15388,
  PossiblyFalsy: 15868,
  Intrinsic: 393983,
  StringLike: 12583968,
  NumberLike: 67648,
  BigIntLike: 4224,
  BooleanLike: 8448,
  EnumLike: 98304,
  ESSymbolLike: 16896,
  VoidLike: 20,
  Primitive: 12713980,
  DefinitelyNonNullable: 13893600,
  DisjointDomains: 12812284,
  UnionOrIntersection: 402653184,
  StructuredType: 403701760,
  TypeVariable: 34078720,
  InstantiableNonPrimitive: 117964800,
  InstantiablePrimitive: 14680064,
  Instantiable: 132644864,
  StructuredOrInstantiable: 536346624,
  ObjectFlagsType: 403963917,
  Simplifiable: 102760448,
  Singleton: 394239,
  Narrowable: 536575971,
  IncludesMask: 416808959,
  IncludesMissingType: 524288,
  IncludesNonWideningType: 2097152,
  IncludesWildcard: 33554432,
  IncludesEmptyObject: 67108864,
  IncludesInstantiable: 16777216,
  IncludesConstrainedTypeVariable: 536870912,
  IncludesError: 1073741824,
  NotPrimitiveUnion: 286523411,
} as const;

export const SemanticObjectFlags = {
  None: 0,
  Class: 1,
  Interface: 2,
  Reference: 4,
  Tuple: 8,
  Anonymous: 16,
  Mapped: 32,
  Instantiated: 64,
  ObjectLiteral: 128,
  EvolvingArray: 256,
  ObjectLiteralPatternWithComputedProperties: 512,
  ReverseMapped: 1024,
  JsxAttributes: 2048,
  JSLiteral: 4096,
  FreshLiteral: 8192,
  ArrayLiteral: 16384,
  PrimitiveUnion: 32768,
  ContainsWideningType: 65536,
  ContainsObjectOrArrayLiteral: 131072,
  NonInferrableType: 262144,
  CouldContainTypeVariablesComputed: 524288,
  CouldContainTypeVariables: 1048576,
  MembersResolved: 2097152,
  ClassOrInterface: 3,
  RequiresWidening: 196608,
  PropagatingFlags: 458752,
  InstantiatedMapped: 96,
  InstantiationExpressionType: 16777216,
  SingleSignatureType: 33554432,
  ObjectTypeKindMask: 50332991,
  ContainsSpread: 4194304,
  ObjectRestType: 8388608,
  IsClassInstanceClone: 67108864,
  IdenticalBaseTypeCalculated: 134217728,
  IdenticalBaseTypeExists: 268435456,
  FromTypeNode: 536870912,
  IsGenericTypeComputed: 4194304,
  IsGenericObjectType: 8388608,
  IsGenericIndexType: 16777216,
  IsGenericType: 25165824,
  ContainsIntersections: 33554432,
  IsUnknownLikeUnionComputed: 67108864,
  IsUnknownLikeUnion: 134217728,
  IsUniformEnumComputed: 268435456,
  IsUniformEnum: 536870912,
  IsNeverIntersectionComputed: 33554432,
  IsNeverIntersection: 67108864,
  IsConstrainedTypeVariable: 134217728,
} as const;

export const SemanticSymbolFlags = {
  None: 0,
  FunctionScopedVariable: 1,
  BlockScopedVariable: 2,
  Property: 4,
  EnumMember: 8,
  Function: 16,
  Class: 32,
  Interface: 64,
  ConstEnum: 128,
  RegularEnum: 256,
  ValueModule: 512,
  NamespaceModule: 1024,
  TypeLiteral: 2048,
  ObjectLiteral: 4096,
  Method: 8192,
  Constructor: 16384,
  GetAccessor: 32768,
  SetAccessor: 65536,
  Signature: 131072,
  TypeParameter: 262144,
  TypeAlias: 524288,
  ExportValue: 1048576,
  Alias: 2097152,
  Prototype: 4194304,
  ExportStar: 8388608,
  Optional: 16777216,
  Transient: 33554432,
  Assignment: 67108864,
  ModuleExports: 134217728,
  ConstEnumOnlyModule: 268435456,
  ReplaceableByMethod: 536870912,
  GlobalLookup: 1073741824,
  All: 1073741823,
  Enum: 384,
  Variable: 3,
  Value: 111551,
  Type: 788968,
  Namespace: 1920,
  Module: 1536,
  Accessor: 98304,
  FunctionScopedVariableExcludes: 111550,
  BlockScopedVariableExcludes: 111551,
  ParameterExcludes: 111551,
  PropertyExcludes: 13243,
  EnumMemberExcludes: 900095,
  FunctionExcludes: 110991,
  ClassExcludes: 899503,
  InterfaceExcludes: 788872,
  RegularEnumExcludes: 899327,
  ConstEnumExcludes: 899967,
  ValueModuleExcludes: 110735,
  NamespaceModuleExcludes: 0,
  MethodExcludes: 103359,
  GetAccessorExcludes: 46011,
  SetAccessorExcludes: 78779,
  AccessorExcludes: 111547,
  TypeParameterExcludes: 526824,
  TypeAliasExcludes: 788968,
  AliasExcludes: 2097152,
  ModuleMember: 2623475,
  ExportHasLocal: 944,
  BlockScoped: 418,
  PropertyOrAccessor: 98308,
  ClassMember: 106500,
  ExportSupportsDefaultModifier: 112,
  ExportDoesNotSupportDefaultModifier: -113,
  LateBindingContainer: 6256,
} as const;

export const SemanticSignatureFlags = {
  None: 0,
  HasRestParameter: 1,
  HasLiteralTypes: 2,
  Construct: 4,
  Abstract: 8,
  IsInnerCallChain: 16,
  IsOuterCallChain: 32,
  IsUntypedSignatureInJSFile: 64,
  IsNonInferrable: 128,
  IsSignatureCandidateForOverloadFailure: 256,
  PropagatingFlags: 335,
  CallChainFlags: 48,
} as const;

export const SemanticSignatureKind = {
  Call: 0,
  Construct: 1,
} as const;

export const SemanticTypePredicateKind = {
  This: 0,
  Identifier: 1,
  AssertsThis: 2,
  AssertsIdentifier: 3,
} as const;

export interface SemanticSymbolData {
    id: number;
    /**
     * The project the symbol was first observed in. Used as the default project for
     * follow-up lookups that need a project context (e.g. members/exports), since symbols
     * are shared snapshot-wide and such lookups can vary by project.
     */
    project: string;
    name: string;
    flags: number;
    checkFlags: number;
    declarations?: string[];
    valueDeclaration?: string;
    parent?: number;
    exportSymbol?: number;
}

export interface SemanticTypeData {
    id: number;
    flags: number;
    objectFlags?: number;
    /** Literal value. BigInt literals are encoded as a decimal string (e.g. "-123") since JSON cannot represent bigint. Absent values are serialized as null. */
    value?: string | number | boolean | null;
    freshType?: number;
    regularType?: number;
    target?: number;
    typeParameters?: number[];
    outerTypeParameters?: number[];
    localTypeParameters?: number[];
    elementFlags?: number[];
    fixedLength?: number;
    readonly?: boolean;
    objectType?: number;
    indexType?: number;
    checkType?: number;
    extendsType?: number;
    baseType?: number;
    substConstraint?: number;
    texts?: string[];
    intrinsicName?: string;
    isThisType?: boolean;
    aliasTypeArguments?: number[];
    aliasSymbol?: number;
    symbol?: number;
}

export interface SemanticSignatureData {
    id: number;
    flags: number;
    declaration?: string;
    typeParameters?: number[];
    parameters?: number[];
    thisParameter?: number;
    target?: number;
}

export interface SemanticTypePredicateData {
    kind: number;
    parameterIndex: number;
    parameterName?: string;
    type?: SemanticTypeData;
}

export interface SemanticIndexInfoData {
    keyType: SemanticTypeData;
    valueType: SemanticTypeData;
    isReadonly?: boolean;
    declaration?: string;
}
