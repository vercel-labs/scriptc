/** Frontend names over the concrete native client. No SDK object or
 * structural cast participates in the production checker boundary. The
 * names follow tsc-ts/api's. */
export type {
  SemanticType as Type,
  SemanticType as UnionOrIntersectionType,
  SemanticType as UnionType,
  SemanticType as IntersectionType,
  SemanticType as FreshableType,
  SemanticType as InterfaceType,
  SemanticType as TypeReference,
  SemanticTupleType as TupleType,
  // A reference carries its element flags on the target, not necessarily on
  // itself. Claiming a tuple shape here makes a native presence test constant.
  SemanticType as TupleTypeReference,
  SemanticLiteralType as LiteralType,
  SemanticStringLiteralType as StringLiteralType,
  SemanticNumberLiteralType as NumberLiteralType,
  SemanticBigIntLiteralType as BigIntLiteralType,
  SemanticBooleanLiteralType as BooleanLiteralType,
  SemanticIntrinsicType as IntrinsicType,
  SemanticObjectType as ObjectType,
  SemanticTypeParameter as TypeParameter,
  SemanticType as IndexType,
  SemanticType as IndexedAccessType,
  SemanticType as ConditionalType,
  SemanticType as SubstitutionType,
  SemanticTemplateLiteralType as TemplateLiteralType,
  SemanticType as StringMappingType,
  SemanticSignature as Signature,
  SemanticSymbol as Symbol,
} from "./semantic-model.js";
export { escapedSymbolName, symbolName, symbolNameOf } from "./semantic-model.js";
export type {
  SemanticIndexInfo as IndexInfo,
  SemanticTypePredicate as TypePredicate,
} from "./semantic-checker.js";
export type { Ts7CompilerOptionsData as CompilerOptions } from "./session-schema.generated.js";
export type { Ts7Diagnostic as Diagnostic } from "./diagnostic.js";
export type { Ts7SourceMetadata as SourceFileMetadata } from "./session-schema.generated.js";
