// Generated from typescript@7.1.0-beta by scripts/generate-ts7-ast-schema.mjs.
// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.
// Regenerate when changing the TypeScript pin; do not edit by hand.

export const HEADER_OFFSET_BINDER_DATA = 60;
export const HEADER_OFFSET_EXTENDED_DATA = 32;
export const HEADER_OFFSET_HASH_HI0 = 12;
export const HEADER_OFFSET_HASH_HI1 = 16;
export const HEADER_OFFSET_HASH_LO0 = 4;
export const HEADER_OFFSET_HASH_LO1 = 8;
export const HEADER_OFFSET_METADATA = 0;
export const HEADER_OFFSET_NODES = 40;
export const HEADER_OFFSET_PARSE_OPTIONS = 20;
export const HEADER_OFFSET_SOURCE_FILE_ID = 44;
export const HEADER_OFFSET_SOURCE_FILE_LEASE = 52;
export const HEADER_OFFSET_STRING_TABLE = 28;
export const HEADER_OFFSET_STRING_TABLE_OFFSETS = 24;
export const HEADER_OFFSET_STRUCTURED_DATA = 36;
export const HEADER_SIZE = 64;
export const KIND_NODE_LIST = 4294967295;
export const NODE_DATA_TYPE_CHILDREN = 0;
export const NODE_DATA_TYPE_EXTENDED = 2147483648;
export const NODE_DATA_TYPE_STRING = 1073741824;
export const NODE_EXTENDED_DATA_MASK = 16777215;
export const NODE_LEN = 28;
export const NODE_OFFSET_DATA = 20;
export const NODE_OFFSET_END = 8;
export const NODE_OFFSET_FLAGS = 24;
export const NODE_OFFSET_KIND = 0;
export const NODE_OFFSET_NEXT = 12;
export const NODE_OFFSET_PARENT = 16;
export const NODE_OFFSET_POS = 4;
export const NODE_STRING_INDEX_MASK = 16777215;
export const PROTOCOL_VERSION = 9;

export const AstKind = {
  Unknown: 0,
  EndOfFile: 1,
  SingleLineCommentTrivia: 2,
  MultiLineCommentTrivia: 3,
  NewLineTrivia: 4,
  WhitespaceTrivia: 5,
  ConflictMarkerTrivia: 6,
  NonTextFileMarkerTrivia: 7,
  NumericLiteral: 8,
  BigIntLiteral: 9,
  StringLiteral: 10,
  JsxText: 11,
  JsxTextAllWhiteSpaces: 12,
  RegularExpressionLiteral: 13,
  NoSubstitutionTemplateLiteral: 14,
  TemplateHead: 15,
  TemplateMiddle: 16,
  TemplateTail: 17,
  OpenBraceToken: 18,
  CloseBraceToken: 19,
  OpenParenToken: 20,
  CloseParenToken: 21,
  OpenBracketToken: 22,
  CloseBracketToken: 23,
  DotToken: 24,
  DotDotDotToken: 25,
  SemicolonToken: 26,
  CommaToken: 27,
  QuestionDotToken: 28,
  LessThanToken: 29,
  LessThanSlashToken: 30,
  GreaterThanToken: 31,
  LessThanEqualsToken: 32,
  GreaterThanEqualsToken: 33,
  EqualsEqualsToken: 34,
  ExclamationEqualsToken: 35,
  EqualsEqualsEqualsToken: 36,
  ExclamationEqualsEqualsToken: 37,
  EqualsGreaterThanToken: 38,
  PlusToken: 39,
  MinusToken: 40,
  AsteriskToken: 41,
  AsteriskAsteriskToken: 42,
  SlashToken: 43,
  PercentToken: 44,
  PlusPlusToken: 45,
  MinusMinusToken: 46,
  LessThanLessThanToken: 47,
  GreaterThanGreaterThanToken: 48,
  GreaterThanGreaterThanGreaterThanToken: 49,
  AmpersandToken: 50,
  BarToken: 51,
  CaretToken: 52,
  ExclamationToken: 53,
  TildeToken: 54,
  AmpersandAmpersandToken: 55,
  BarBarToken: 56,
  QuestionToken: 57,
  ColonToken: 58,
  AtToken: 59,
  QuestionQuestionToken: 60,
  BacktickToken: 61,
  HashToken: 62,
  EqualsToken: 63,
  PlusEqualsToken: 64,
  MinusEqualsToken: 65,
  AsteriskEqualsToken: 66,
  AsteriskAsteriskEqualsToken: 67,
  SlashEqualsToken: 68,
  PercentEqualsToken: 69,
  LessThanLessThanEqualsToken: 70,
  GreaterThanGreaterThanEqualsToken: 71,
  GreaterThanGreaterThanGreaterThanEqualsToken: 72,
  AmpersandEqualsToken: 73,
  BarEqualsToken: 74,
  BarBarEqualsToken: 75,
  AmpersandAmpersandEqualsToken: 76,
  QuestionQuestionEqualsToken: 77,
  CaretEqualsToken: 78,
  Identifier: 79,
  PrivateIdentifier: 80,
  JSDocCommentTextToken: 81,
  BreakKeyword: 82,
  CaseKeyword: 83,
  CatchKeyword: 84,
  ClassKeyword: 85,
  ConstKeyword: 86,
  ContinueKeyword: 87,
  DebuggerKeyword: 88,
  DefaultKeyword: 89,
  DeleteKeyword: 90,
  DoKeyword: 91,
  ElseKeyword: 92,
  EnumKeyword: 93,
  ExportKeyword: 94,
  ExtendsKeyword: 95,
  FalseKeyword: 96,
  FinallyKeyword: 97,
  ForKeyword: 98,
  FunctionKeyword: 99,
  IfKeyword: 100,
  ImportKeyword: 101,
  InKeyword: 102,
  InstanceOfKeyword: 103,
  NewKeyword: 104,
  NullKeyword: 105,
  ReturnKeyword: 106,
  SuperKeyword: 107,
  SwitchKeyword: 108,
  ThisKeyword: 109,
  ThrowKeyword: 110,
  TrueKeyword: 111,
  TryKeyword: 112,
  TypeOfKeyword: 113,
  VarKeyword: 114,
  VoidKeyword: 115,
  WhileKeyword: 116,
  WithKeyword: 117,
  ImplementsKeyword: 118,
  InterfaceKeyword: 119,
  LetKeyword: 120,
  PackageKeyword: 121,
  PrivateKeyword: 122,
  ProtectedKeyword: 123,
  PublicKeyword: 124,
  StaticKeyword: 125,
  YieldKeyword: 126,
  AbstractKeyword: 127,
  AccessorKeyword: 128,
  AsKeyword: 129,
  AssertsKeyword: 130,
  AssertKeyword: 131,
  AnyKeyword: 132,
  AsyncKeyword: 133,
  AwaitKeyword: 134,
  BooleanKeyword: 135,
  ConstructorKeyword: 136,
  DeclareKeyword: 137,
  GetKeyword: 138,
  ImmediateKeyword: 139,
  InferKeyword: 140,
  IntrinsicKeyword: 141,
  IsKeyword: 142,
  KeyOfKeyword: 143,
  ModuleKeyword: 144,
  NamespaceKeyword: 145,
  NeverKeyword: 146,
  OutKeyword: 147,
  ReadonlyKeyword: 148,
  RequireKeyword: 149,
  NumberKeyword: 150,
  ObjectKeyword: 151,
  SatisfiesKeyword: 152,
  SetKeyword: 153,
  StringKeyword: 154,
  SymbolKeyword: 155,
  TypeKeyword: 156,
  UndefinedKeyword: 157,
  UniqueKeyword: 158,
  UnknownKeyword: 159,
  UsingKeyword: 160,
  FromKeyword: 161,
  GlobalKeyword: 162,
  BigIntKeyword: 163,
  OverrideKeyword: 164,
  OfKeyword: 165,
  DeferKeyword: 166,
  SourceKeyword: 167,
  QualifiedName: 168,
  ComputedPropertyName: 169,
  TypeParameter: 170,
  Parameter: 171,
  Decorator: 172,
  PropertySignature: 173,
  PropertyDeclaration: 174,
  MethodSignature: 175,
  MethodDeclaration: 176,
  ClassStaticBlockDeclaration: 177,
  Constructor: 178,
  GetAccessor: 179,
  SetAccessor: 180,
  CallSignature: 181,
  ConstructSignature: 182,
  IndexSignature: 183,
  TypePredicate: 184,
  TypeReference: 185,
  FunctionType: 186,
  ConstructorType: 187,
  TypeQuery: 188,
  TypeLiteral: 189,
  ArrayType: 190,
  TupleType: 191,
  OptionalType: 192,
  RestType: 193,
  UnionType: 194,
  IntersectionType: 195,
  ConditionalType: 196,
  InferType: 197,
  ParenthesizedType: 198,
  ThisType: 199,
  TypeOperator: 200,
  IndexedAccessType: 201,
  MappedType: 202,
  LiteralType: 203,
  NamedTupleMember: 204,
  TemplateLiteralType: 205,
  TemplateLiteralTypeSpan: 206,
  ImportType: 207,
  ObjectBindingPattern: 208,
  ArrayBindingPattern: 209,
  BindingElement: 210,
  ArrayLiteralExpression: 211,
  ObjectLiteralExpression: 212,
  PropertyAccessExpression: 213,
  ElementAccessExpression: 214,
  CallExpression: 215,
  NewExpression: 216,
  TaggedTemplateExpression: 217,
  TypeAssertionExpression: 218,
  ParenthesizedExpression: 219,
  FunctionExpression: 220,
  ArrowFunction: 221,
  DeleteExpression: 222,
  TypeOfExpression: 223,
  VoidExpression: 224,
  AwaitExpression: 225,
  PrefixUnaryExpression: 226,
  PostfixUnaryExpression: 227,
  BinaryExpression: 228,
  ConditionalExpression: 229,
  TemplateExpression: 230,
  YieldExpression: 231,
  SpreadElement: 232,
  ClassExpression: 233,
  OmittedExpression: 234,
  ExpressionWithTypeArguments: 235,
  AsExpression: 236,
  NonNullExpression: 237,
  MetaProperty: 238,
  SyntheticExpression: 239,
  SatisfiesExpression: 240,
  TemplateSpan: 241,
  SemicolonClassElement: 242,
  Block: 243,
  EmptyStatement: 244,
  VariableStatement: 245,
  ExpressionStatement: 246,
  IfStatement: 247,
  DoStatement: 248,
  WhileStatement: 249,
  ForStatement: 250,
  ForInStatement: 251,
  ForOfStatement: 252,
  ContinueStatement: 253,
  BreakStatement: 254,
  ReturnStatement: 255,
  WithStatement: 256,
  SwitchStatement: 257,
  LabeledStatement: 258,
  ThrowStatement: 259,
  TryStatement: 260,
  DebuggerStatement: 261,
  VariableDeclaration: 262,
  VariableDeclarationList: 263,
  FunctionDeclaration: 264,
  ClassDeclaration: 265,
  InterfaceDeclaration: 266,
  TypeAliasDeclaration: 267,
  EnumDeclaration: 268,
  ModuleDeclaration: 269,
  ModuleBlock: 270,
  CaseBlock: 271,
  NamespaceExportDeclaration: 272,
  ImportEqualsDeclaration: 273,
  ImportDeclaration: 274,
  ImportClause: 275,
  NamespaceImport: 276,
  NamedImports: 277,
  ImportSpecifier: 278,
  ExportAssignment: 279,
  ExportDeclaration: 280,
  NamedExports: 281,
  NamespaceExport: 282,
  ExportSpecifier: 283,
  MissingDeclaration: 284,
  ExternalModuleReference: 285,
  JsxElement: 286,
  JsxSelfClosingElement: 287,
  JsxOpeningElement: 288,
  JsxClosingElement: 289,
  JsxFragment: 290,
  JsxOpeningFragment: 291,
  JsxClosingFragment: 292,
  JsxAttribute: 293,
  JsxAttributes: 294,
  JsxSpreadAttribute: 295,
  JsxExpression: 296,
  JsxNamespacedName: 297,
  CaseClause: 298,
  DefaultClause: 299,
  HeritageClause: 300,
  CatchClause: 301,
  ImportAttributes: 302,
  ImportAttribute: 303,
  PropertyAssignment: 304,
  ShorthandPropertyAssignment: 305,
  SpreadAssignment: 306,
  EnumMember: 307,
  SourceFile: 308,
  JSDocTypeExpression: 309,
  JSDocNameReference: 310,
  JSDocAllType: 311,
  JSDocNullableType: 312,
  JSDocNonNullableType: 313,
  JSDocOptionalType: 314,
  JSDocVariadicType: 315,
  JSDoc: 316,
  JSDocText: 317,
  JSDocTypeLiteral: 318,
  JSDocSignature: 319,
  JSDocLink: 320,
  JSDocLinkCode: 321,
  JSDocLinkPlain: 322,
  JSDocUnknownTag: 323,
  JSDocAugmentsTag: 324,
  JSDocImplementsTag: 325,
  JSDocDeprecatedTag: 326,
  JSDocPublicTag: 327,
  JSDocPrivateTag: 328,
  JSDocProtectedTag: 329,
  JSDocReadonlyTag: 330,
  JSDocOverrideTag: 331,
  JSDocCallbackTag: 332,
  JSDocOverloadTag: 333,
  JSDocParameterTag: 334,
  JSDocReturnTag: 335,
  JSDocThisTag: 336,
  JSDocTypeTag: 337,
  JSDocTemplateTag: 338,
  JSDocTypedefTag: 339,
  JSDocSeeTag: 340,
  JSDocPropertyTag: 341,
  JSDocThrowsTag: 342,
  JSDocSatisfiesTag: 343,
  JSDocImportTag: 344,
  SyntaxList: 345,
  JSTypeAliasDeclaration: 346,
  JSImportDeclaration: 347,
  NotEmittedStatement: 348,
  PartiallyEmittedExpression: 349,
  SyntheticReferenceExpression: 350,
  NotEmittedTypeElement: 351,
  Count: 352,
  FirstAssignment: 63,
  LastAssignment: 78,
  FirstCompoundAssignment: 64,
  LastCompoundAssignment: 78,
  FirstReservedWord: 82,
  LastReservedWord: 117,
  FirstKeyword: 82,
  LastKeyword: 167,
  FirstFutureReservedWord: 118,
  LastFutureReservedWord: 126,
  FirstTypeNode: 184,
  LastTypeNode: 207,
  FirstPunctuation: 18,
  LastPunctuation: 78,
  FirstToken: 0,
  LastToken: 167,
  FirstLiteralToken: 8,
  LastLiteralToken: 14,
  FirstTemplateToken: 14,
  LastTemplateToken: 17,
  FirstBinaryOperator: 29,
  LastBinaryOperator: 78,
  FirstStatement: 245,
  LastStatement: 261,
  FirstNode: 168,
  FirstJSDocNode: 309,
  LastJSDocNode: 344,
  FirstJSDocTagNode: 323,
  LastJSDocTagNode: 344,
  FirstContextualKeyword: 127,
  LastContextualKeyword: 167,
  LastUnaryOperator: 54,
  FirstTriviaToken: 2,
  LastTriviaToken: 6,
} as const;

export const AstNodeFlags = {
  None: 0,
  Let: 1,
  Const: 2,
  Using: 4,
  Reparsed: 8,
  Synthesized: 16,
  OptionalChain: 32,
  ExportContext: 64,
  ContainsThis: 128,
  HasImplicitReturn: 256,
  HasExplicitReturn: 512,
  DisallowInContext: 1024,
  YieldContext: 2048,
  DecoratorContext: 4096,
  AwaitContext: 8192,
  DisallowConditionalTypesContext: 16384,
  ThisNodeHasError: 32768,
  JavaScriptFile: 65536,
  ThisNodeOrAnySubNodesHasError: 131072,
  HasAsyncFunctions: 262144,
  PossiblyContainsDynamicImport: 524288,
  PossiblyContainsImportMeta: 1048576,
  HasJSDoc: 2097152,
  JSDoc: 4194304,
  Ambient: 8388608,
  InWithStatement: 16777216,
  JsonFile: 33554432,
  PossiblyContainsDeprecatedTag: 67108864,
  Unreachable: 134217728,
  ReparserTransformedLiteral: 268435456,
  BlockScoped: 7,
  Constant: 6,
  AwaitUsing: 6,
  ReachabilityCheckFlags: 768,
  ReachabilityAndEmitFlags: 262912,
  ContextFlags: 25263104,
  TypeExcludesFlags: 10240,
  PermanentlySetIncrementalFlags: 1572864,
  IdentifierHasExtendedUnicodeEscape: 128,
  IdentifierIsInJSDocNamespace: 262144,
  NestedNamespace: 32,
} as const;

export const AstModifierFlags = {
  None: 0,
  Public: 1,
  Private: 2,
  Protected: 4,
  Readonly: 8,
  Override: 16,
  Export: 32,
  Abstract: 64,
  Ambient: 128,
  Static: 256,
  Accessor: 512,
  Async: 1024,
  Default: 2048,
  Const: 4096,
  In: 8192,
  Out: 16384,
  Decorator: 32768,
  Deprecated: 65536,
  JSDocPublic: 8388608,
  JSDocPrivate: 16777216,
  JSDocProtected: 33554432,
  JSDocReadonly: 67108864,
  JSDocOverride: 134217728,
  HasComputedJSDocModifiers: 268435456,
  HasComputedFlags: 536870912,
  SyntacticOrJSDocModifiers: 31,
  SyntacticOnlyModifiers: 65504,
  SyntacticModifiers: 65535,
  JSDocCacheOnlyModifiers: 260046848,
  JSDocOnlyModifiers: 65536,
  NonCacheOnlyModifiers: 131071,
  AccessibilityModifier: 7,
  ParameterPropertyModifier: 31,
  NonPublicAccessibilityModifier: 6,
  TypeScriptModifier: 28895,
  ExportDefault: 2080,
  All: 131071,
  Modifier: 98303,
  JavaScript: 3872,
} as const;

/** Child properties in the exact order encoded by tsgo. */
export function astChildNames(kind: number): string {
  switch (kind) {
    case 168: return "left,right"; // FirstNode
    case 169: return "expression"; // ComputedPropertyName
    case 170: return "modifiers,name,constraint,expression,defaultType"; // TypeParameter
    case 171: return "modifiers,dotDotDotToken,name,questionToken,type,initializer"; // Parameter
    case 172: return "expression"; // Decorator
    case 173: return "modifiers,name,postfixToken,type,initializer"; // PropertySignature
    case 174: return "modifiers,name,postfixToken,type,initializer"; // PropertyDeclaration
    case 175: return "modifiers,name,postfixToken,typeParameters,parameters,type"; // MethodSignature
    case 176: return "modifiers,asteriskToken,name,postfixToken,typeParameters,parameters,type,body"; // MethodDeclaration
    case 177: return "modifiers,body"; // ClassStaticBlockDeclaration
    case 178: return "modifiers,typeParameters,parameters,type,body"; // Constructor
    case 179: return "modifiers,name,typeParameters,parameters,type,body"; // GetAccessor
    case 180: return "modifiers,name,typeParameters,parameters,type,body"; // SetAccessor
    case 181: return "typeParameters,parameters,type"; // CallSignature
    case 182: return "typeParameters,parameters,type"; // ConstructSignature
    case 183: return "modifiers,parameters,type"; // IndexSignature
    case 184: return "assertsModifier,parameterName,type"; // FirstTypeNode
    case 185: return "typeName,typeArguments"; // TypeReference
    case 186: return "typeParameters,parameters,type"; // FunctionType
    case 187: return "modifiers,typeParameters,parameters,type"; // ConstructorType
    case 188: return "exprName,typeArguments"; // TypeQuery
    case 189: return "members"; // TypeLiteral
    case 190: return "elementType"; // ArrayType
    case 191: return "elements"; // TupleType
    case 192: return "type"; // OptionalType
    case 193: return "type"; // RestType
    case 194: return "types"; // UnionType
    case 195: return "types"; // IntersectionType
    case 196: return "checkType,extendsType,trueType,falseType"; // ConditionalType
    case 197: return "typeParameter"; // InferType
    case 198: return "type"; // ParenthesizedType
    case 200: return "type"; // TypeOperator
    case 201: return "objectType,indexType"; // IndexedAccessType
    case 202: return "readonlyToken,typeParameter,nameType,questionToken,type,members"; // MappedType
    case 203: return "literal"; // LiteralType
    case 204: return "dotDotDotToken,name,questionToken,type"; // NamedTupleMember
    case 205: return "head,templateSpans"; // TemplateLiteralType
    case 206: return "type,literal"; // TemplateLiteralTypeSpan
    case 207: return "argument,attributes,qualifier,typeArguments"; // LastTypeNode
    case 208: return "elements"; // ObjectBindingPattern
    case 209: return "elements"; // ArrayBindingPattern
    case 210: return "dotDotDotToken,propertyName,name,initializer"; // BindingElement
    case 211: return "elements"; // ArrayLiteralExpression
    case 212: return "properties"; // ObjectLiteralExpression
    case 213: return "expression,questionDotToken,name"; // PropertyAccessExpression
    case 214: return "expression,questionDotToken,argumentExpression"; // ElementAccessExpression
    case 215: return "expression,questionDotToken,typeArguments,arguments"; // CallExpression
    case 216: return "expression,typeArguments,arguments"; // NewExpression
    case 217: return "tag,questionDotToken,typeArguments,template"; // TaggedTemplateExpression
    case 218: return "type,expression"; // TypeAssertionExpression
    case 219: return "expression"; // ParenthesizedExpression
    case 220: return "modifiers,asteriskToken,name,typeParameters,parameters,type,body"; // FunctionExpression
    case 221: return "modifiers,typeParameters,parameters,type,equalsGreaterThanToken,body"; // ArrowFunction
    case 222: return "expression"; // DeleteExpression
    case 223: return "expression"; // TypeOfExpression
    case 224: return "expression"; // VoidExpression
    case 225: return "expression"; // AwaitExpression
    case 226: return "operand"; // PrefixUnaryExpression
    case 227: return "operand"; // PostfixUnaryExpression
    case 228: return "modifiers,left,type,operatorToken,right"; // BinaryExpression
    case 229: return "condition,questionToken,whenTrue,colonToken,whenFalse"; // ConditionalExpression
    case 230: return "head,templateSpans"; // TemplateExpression
    case 231: return "asteriskToken,expression"; // YieldExpression
    case 232: return "expression"; // SpreadElement
    case 233: return "modifiers,name,typeParameters,heritageClauses,members"; // ClassExpression
    case 235: return "expression,typeArguments"; // ExpressionWithTypeArguments
    case 236: return "expression,type"; // AsExpression
    case 237: return "expression"; // NonNullExpression
    case 238: return "name"; // MetaProperty
    case 239: return "tupleNameSource"; // SyntheticExpression
    case 240: return "expression,type"; // SatisfiesExpression
    case 241: return "expression,literal"; // TemplateSpan
    case 243: return "statements"; // Block
    case 245: return "modifiers,declarationList"; // FirstStatement
    case 246: return "expression"; // ExpressionStatement
    case 247: return "expression,thenStatement,elseStatement"; // IfStatement
    case 248: return "statement,expression"; // DoStatement
    case 249: return "expression,statement"; // WhileStatement
    case 250: return "initializer,condition,incrementor,statement"; // ForStatement
    case 251: return "awaitModifier,initializer,expression,statement"; // ForInStatement
    case 252: return "awaitModifier,initializer,expression,statement"; // ForOfStatement
    case 253: return "label"; // ContinueStatement
    case 254: return "label"; // BreakStatement
    case 255: return "expression"; // ReturnStatement
    case 256: return "expression,statement"; // WithStatement
    case 257: return "expression,caseBlock"; // SwitchStatement
    case 258: return "label,statement"; // LabeledStatement
    case 259: return "expression"; // ThrowStatement
    case 260: return "tryBlock,catchClause,finallyBlock"; // TryStatement
    case 262: return "name,exclamationToken,type,initializer"; // VariableDeclaration
    case 263: return "declarations"; // VariableDeclarationList
    case 264: return "modifiers,asteriskToken,name,typeParameters,parameters,type,body"; // FunctionDeclaration
    case 265: return "modifiers,name,typeParameters,heritageClauses,members"; // ClassDeclaration
    case 266: return "modifiers,name,typeParameters,heritageClauses,members"; // InterfaceDeclaration
    case 267: return "modifiers,name,typeParameters,type"; // TypeAliasDeclaration
    case 268: return "modifiers,name,members"; // EnumDeclaration
    case 269: return "modifiers,name,attributes,body"; // ModuleDeclaration
    case 270: return "statements"; // ModuleBlock
    case 271: return "clauses"; // CaseBlock
    case 272: return "modifiers,name"; // NamespaceExportDeclaration
    case 273: return "modifiers,name,moduleReference"; // ImportEqualsDeclaration
    case 274: return "modifiers,importClause,moduleSpecifier,attributes"; // ImportDeclaration
    case 275: return "name,namedBindings"; // ImportClause
    case 276: return "name"; // NamespaceImport
    case 277: return "elements"; // NamedImports
    case 278: return "propertyName,name"; // ImportSpecifier
    case 279: return "modifiers,type,expression"; // ExportAssignment
    case 280: return "modifiers,exportClause,moduleSpecifier,attributes"; // ExportDeclaration
    case 281: return "elements"; // NamedExports
    case 282: return "name"; // NamespaceExport
    case 283: return "propertyName,name"; // ExportSpecifier
    case 284: return "modifiers"; // MissingDeclaration
    case 285: return "expression"; // ExternalModuleReference
    case 286: return "openingElement,children,closingElement"; // JsxElement
    case 287: return "tagName,typeArguments,attributes"; // JsxSelfClosingElement
    case 288: return "tagName,typeArguments,attributes"; // JsxOpeningElement
    case 289: return "tagName"; // JsxClosingElement
    case 290: return "openingFragment,children,closingFragment"; // JsxFragment
    case 293: return "name,initializer"; // JsxAttribute
    case 294: return "properties"; // JsxAttributes
    case 295: return "expression"; // JsxSpreadAttribute
    case 296: return "dotDotDotToken,expression"; // JsxExpression
    case 297: return "namespace,name"; // JsxNamespacedName
    case 298: return "expression,statements"; // CaseClause
    case 299: return "expression,statements"; // DefaultClause
    case 300: return "types"; // HeritageClause
    case 301: return "variableDeclaration,block"; // CatchClause
    case 302: return "attributes"; // ImportAttributes
    case 303: return "name,value"; // ImportAttribute
    case 304: return "modifiers,name,postfixToken,type,initializer"; // PropertyAssignment
    case 305: return "modifiers,name,postfixToken,type,equalsToken,objectAssignmentInitializer"; // ShorthandPropertyAssignment
    case 306: return "expression"; // SpreadAssignment
    case 307: return "name,initializer"; // EnumMember
    case 308: return "statements,endOfFileToken"; // SourceFile
    case 309: return "type"; // FirstJSDocNode
    case 310: return "name"; // JSDocNameReference
    case 312: return "type"; // JSDocNullableType
    case 313: return "type"; // JSDocNonNullableType
    case 314: return "type"; // JSDocOptionalType
    case 315: return "type"; // JSDocVariadicType
    case 316: return "comment,tags"; // JSDoc
    case 318: return "jsdocPropertyTags"; // JSDocTypeLiteral
    case 319: return "typeParameters,parameters,type"; // JSDocSignature
    case 320: return "name"; // JSDocLink
    case 321: return "name"; // JSDocLinkCode
    case 322: return "name"; // JSDocLinkPlain
    case 323: return "tagName,comment"; // FirstJSDocTagNode
    case 324: return "tagName,className,comment"; // JSDocAugmentsTag
    case 325: return "tagName,className,comment"; // JSDocImplementsTag
    case 326: return "tagName,comment"; // JSDocDeprecatedTag
    case 327: return "tagName,comment"; // JSDocPublicTag
    case 328: return "tagName,comment"; // JSDocPrivateTag
    case 329: return "tagName,comment"; // JSDocProtectedTag
    case 330: return "tagName,comment"; // JSDocReadonlyTag
    case 331: return "tagName,comment"; // JSDocOverrideTag
    case 332: return "tagName,typeExpression,name,comment"; // JSDocCallbackTag
    case 333: return "tagName,typeExpression,comment"; // JSDocOverloadTag
    case 334: return "tagName,name,typeExpression,comment"; // JSDocParameterTag
    case 335: return "tagName,typeExpression,comment"; // JSDocReturnTag
    case 336: return "tagName,typeExpression,comment"; // JSDocThisTag
    case 337: return "tagName,typeExpression,comment"; // JSDocTypeTag
    case 338: return "tagName,constraint,typeParameters,comment"; // JSDocTemplateTag
    case 339: return "tagName,typeExpression,name,comment"; // JSDocTypedefTag
    case 340: return "tagName,nameExpression,comment"; // JSDocSeeTag
    case 341: return "tagName,name,typeExpression,comment"; // JSDocPropertyTag
    case 342: return "tagName,typeExpression,comment"; // JSDocThrowsTag
    case 343: return "tagName,typeExpression,comment"; // JSDocSatisfiesTag
    case 344: return "tagName,importClause,moduleSpecifier,attributes,comment"; // LastJSDocTagNode
    case 345: return "children"; // SyntaxList
    case 346: return "modifiers,name,typeParameters,type"; // JSTypeAliasDeclaration
    case 347: return "modifiers,importClause,moduleSpecifier,attributes"; // JSImportDeclaration
    case 349: return "expression"; // PartiallyEmittedExpression
    case 350: return "expression,thisArg"; // SyntheticReferenceExpression
    default: return "";
  }
}

/** Wire slot for a child property, or -1 when the kind has no such child. */
export function astChildOrder(kind: number, name: string): number {
  switch (kind) {
    case 168: // FirstNode
      switch (name) {
        case "left": return 0;
        case "right": return 1;
        default: return -1;
      }
    case 169: // ComputedPropertyName
    case 172: // Decorator
    case 219: // ParenthesizedExpression
    case 222: // DeleteExpression
    case 223: // TypeOfExpression
    case 224: // VoidExpression
    case 225: // AwaitExpression
    case 232: // SpreadElement
    case 237: // NonNullExpression
    case 246: // ExpressionStatement
    case 255: // ReturnStatement
    case 259: // ThrowStatement
    case 285: // ExternalModuleReference
    case 295: // JsxSpreadAttribute
    case 306: // SpreadAssignment
    case 349: // PartiallyEmittedExpression
      switch (name) {
        case "expression": return 0;
        default: return -1;
      }
    case 170: // TypeParameter
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "constraint": return 2;
        case "expression": return 3;
        case "defaultType": return 4;
        default: return -1;
      }
    case 171: // Parameter
      switch (name) {
        case "modifiers": return 0;
        case "dotDotDotToken": return 1;
        case "name": return 2;
        case "questionToken": return 3;
        case "type": return 4;
        case "initializer": return 5;
        default: return -1;
      }
    case 173: // PropertySignature
    case 174: // PropertyDeclaration
    case 304: // PropertyAssignment
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "postfixToken": return 2;
        case "type": return 3;
        case "initializer": return 4;
        default: return -1;
      }
    case 175: // MethodSignature
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "postfixToken": return 2;
        case "typeParameters": return 3;
        case "parameters": return 4;
        case "type": return 5;
        default: return -1;
      }
    case 176: // MethodDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "asteriskToken": return 1;
        case "name": return 2;
        case "postfixToken": return 3;
        case "typeParameters": return 4;
        case "parameters": return 5;
        case "type": return 6;
        case "body": return 7;
        default: return -1;
      }
    case 177: // ClassStaticBlockDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "body": return 1;
        default: return -1;
      }
    case 178: // Constructor
      switch (name) {
        case "modifiers": return 0;
        case "typeParameters": return 1;
        case "parameters": return 2;
        case "type": return 3;
        case "body": return 4;
        default: return -1;
      }
    case 179: // GetAccessor
    case 180: // SetAccessor
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "typeParameters": return 2;
        case "parameters": return 3;
        case "type": return 4;
        case "body": return 5;
        default: return -1;
      }
    case 181: // CallSignature
    case 182: // ConstructSignature
    case 186: // FunctionType
    case 319: // JSDocSignature
      switch (name) {
        case "typeParameters": return 0;
        case "parameters": return 1;
        case "type": return 2;
        default: return -1;
      }
    case 183: // IndexSignature
      switch (name) {
        case "modifiers": return 0;
        case "parameters": return 1;
        case "type": return 2;
        default: return -1;
      }
    case 184: // FirstTypeNode
      switch (name) {
        case "assertsModifier": return 0;
        case "parameterName": return 1;
        case "type": return 2;
        default: return -1;
      }
    case 185: // TypeReference
      switch (name) {
        case "typeName": return 0;
        case "typeArguments": return 1;
        default: return -1;
      }
    case 187: // ConstructorType
      switch (name) {
        case "modifiers": return 0;
        case "typeParameters": return 1;
        case "parameters": return 2;
        case "type": return 3;
        default: return -1;
      }
    case 188: // TypeQuery
      switch (name) {
        case "exprName": return 0;
        case "typeArguments": return 1;
        default: return -1;
      }
    case 189: // TypeLiteral
      switch (name) {
        case "members": return 0;
        default: return -1;
      }
    case 190: // ArrayType
      switch (name) {
        case "elementType": return 0;
        default: return -1;
      }
    case 191: // TupleType
    case 208: // ObjectBindingPattern
    case 209: // ArrayBindingPattern
    case 211: // ArrayLiteralExpression
    case 277: // NamedImports
    case 281: // NamedExports
      switch (name) {
        case "elements": return 0;
        default: return -1;
      }
    case 192: // OptionalType
    case 193: // RestType
    case 198: // ParenthesizedType
    case 200: // TypeOperator
    case 309: // FirstJSDocNode
    case 312: // JSDocNullableType
    case 313: // JSDocNonNullableType
    case 314: // JSDocOptionalType
    case 315: // JSDocVariadicType
      switch (name) {
        case "type": return 0;
        default: return -1;
      }
    case 194: // UnionType
    case 195: // IntersectionType
    case 300: // HeritageClause
      switch (name) {
        case "types": return 0;
        default: return -1;
      }
    case 196: // ConditionalType
      switch (name) {
        case "checkType": return 0;
        case "extendsType": return 1;
        case "trueType": return 2;
        case "falseType": return 3;
        default: return -1;
      }
    case 197: // InferType
      switch (name) {
        case "typeParameter": return 0;
        default: return -1;
      }
    case 201: // IndexedAccessType
      switch (name) {
        case "objectType": return 0;
        case "indexType": return 1;
        default: return -1;
      }
    case 202: // MappedType
      switch (name) {
        case "readonlyToken": return 0;
        case "typeParameter": return 1;
        case "nameType": return 2;
        case "questionToken": return 3;
        case "type": return 4;
        case "members": return 5;
        default: return -1;
      }
    case 203: // LiteralType
      switch (name) {
        case "literal": return 0;
        default: return -1;
      }
    case 204: // NamedTupleMember
      switch (name) {
        case "dotDotDotToken": return 0;
        case "name": return 1;
        case "questionToken": return 2;
        case "type": return 3;
        default: return -1;
      }
    case 205: // TemplateLiteralType
    case 230: // TemplateExpression
      switch (name) {
        case "head": return 0;
        case "templateSpans": return 1;
        default: return -1;
      }
    case 206: // TemplateLiteralTypeSpan
      switch (name) {
        case "type": return 0;
        case "literal": return 1;
        default: return -1;
      }
    case 207: // LastTypeNode
      switch (name) {
        case "argument": return 0;
        case "attributes": return 1;
        case "qualifier": return 2;
        case "typeArguments": return 3;
        default: return -1;
      }
    case 210: // BindingElement
      switch (name) {
        case "dotDotDotToken": return 0;
        case "propertyName": return 1;
        case "name": return 2;
        case "initializer": return 3;
        default: return -1;
      }
    case 212: // ObjectLiteralExpression
    case 294: // JsxAttributes
      switch (name) {
        case "properties": return 0;
        default: return -1;
      }
    case 213: // PropertyAccessExpression
      switch (name) {
        case "expression": return 0;
        case "questionDotToken": return 1;
        case "name": return 2;
        default: return -1;
      }
    case 214: // ElementAccessExpression
      switch (name) {
        case "expression": return 0;
        case "questionDotToken": return 1;
        case "argumentExpression": return 2;
        default: return -1;
      }
    case 215: // CallExpression
      switch (name) {
        case "expression": return 0;
        case "questionDotToken": return 1;
        case "typeArguments": return 2;
        case "arguments": return 3;
        default: return -1;
      }
    case 216: // NewExpression
      switch (name) {
        case "expression": return 0;
        case "typeArguments": return 1;
        case "arguments": return 2;
        default: return -1;
      }
    case 217: // TaggedTemplateExpression
      switch (name) {
        case "tag": return 0;
        case "questionDotToken": return 1;
        case "typeArguments": return 2;
        case "template": return 3;
        default: return -1;
      }
    case 218: // TypeAssertionExpression
      switch (name) {
        case "type": return 0;
        case "expression": return 1;
        default: return -1;
      }
    case 220: // FunctionExpression
    case 264: // FunctionDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "asteriskToken": return 1;
        case "name": return 2;
        case "typeParameters": return 3;
        case "parameters": return 4;
        case "type": return 5;
        case "body": return 6;
        default: return -1;
      }
    case 221: // ArrowFunction
      switch (name) {
        case "modifiers": return 0;
        case "typeParameters": return 1;
        case "parameters": return 2;
        case "type": return 3;
        case "equalsGreaterThanToken": return 4;
        case "body": return 5;
        default: return -1;
      }
    case 226: // PrefixUnaryExpression
    case 227: // PostfixUnaryExpression
      switch (name) {
        case "operand": return 0;
        default: return -1;
      }
    case 228: // BinaryExpression
      switch (name) {
        case "modifiers": return 0;
        case "left": return 1;
        case "type": return 2;
        case "operatorToken": return 3;
        case "right": return 4;
        default: return -1;
      }
    case 229: // ConditionalExpression
      switch (name) {
        case "condition": return 0;
        case "questionToken": return 1;
        case "whenTrue": return 2;
        case "colonToken": return 3;
        case "whenFalse": return 4;
        default: return -1;
      }
    case 231: // YieldExpression
      switch (name) {
        case "asteriskToken": return 0;
        case "expression": return 1;
        default: return -1;
      }
    case 233: // ClassExpression
    case 265: // ClassDeclaration
    case 266: // InterfaceDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "typeParameters": return 2;
        case "heritageClauses": return 3;
        case "members": return 4;
        default: return -1;
      }
    case 235: // ExpressionWithTypeArguments
      switch (name) {
        case "expression": return 0;
        case "typeArguments": return 1;
        default: return -1;
      }
    case 236: // AsExpression
    case 240: // SatisfiesExpression
      switch (name) {
        case "expression": return 0;
        case "type": return 1;
        default: return -1;
      }
    case 238: // MetaProperty
    case 276: // NamespaceImport
    case 282: // NamespaceExport
    case 310: // JSDocNameReference
    case 320: // JSDocLink
    case 321: // JSDocLinkCode
    case 322: // JSDocLinkPlain
      switch (name) {
        case "name": return 0;
        default: return -1;
      }
    case 239: // SyntheticExpression
      switch (name) {
        case "tupleNameSource": return 0;
        default: return -1;
      }
    case 241: // TemplateSpan
      switch (name) {
        case "expression": return 0;
        case "literal": return 1;
        default: return -1;
      }
    case 243: // Block
    case 270: // ModuleBlock
      switch (name) {
        case "statements": return 0;
        default: return -1;
      }
    case 245: // FirstStatement
      switch (name) {
        case "modifiers": return 0;
        case "declarationList": return 1;
        default: return -1;
      }
    case 247: // IfStatement
      switch (name) {
        case "expression": return 0;
        case "thenStatement": return 1;
        case "elseStatement": return 2;
        default: return -1;
      }
    case 248: // DoStatement
      switch (name) {
        case "statement": return 0;
        case "expression": return 1;
        default: return -1;
      }
    case 249: // WhileStatement
    case 256: // WithStatement
      switch (name) {
        case "expression": return 0;
        case "statement": return 1;
        default: return -1;
      }
    case 250: // ForStatement
      switch (name) {
        case "initializer": return 0;
        case "condition": return 1;
        case "incrementor": return 2;
        case "statement": return 3;
        default: return -1;
      }
    case 251: // ForInStatement
    case 252: // ForOfStatement
      switch (name) {
        case "awaitModifier": return 0;
        case "initializer": return 1;
        case "expression": return 2;
        case "statement": return 3;
        default: return -1;
      }
    case 253: // ContinueStatement
    case 254: // BreakStatement
      switch (name) {
        case "label": return 0;
        default: return -1;
      }
    case 257: // SwitchStatement
      switch (name) {
        case "expression": return 0;
        case "caseBlock": return 1;
        default: return -1;
      }
    case 258: // LabeledStatement
      switch (name) {
        case "label": return 0;
        case "statement": return 1;
        default: return -1;
      }
    case 260: // TryStatement
      switch (name) {
        case "tryBlock": return 0;
        case "catchClause": return 1;
        case "finallyBlock": return 2;
        default: return -1;
      }
    case 262: // VariableDeclaration
      switch (name) {
        case "name": return 0;
        case "exclamationToken": return 1;
        case "type": return 2;
        case "initializer": return 3;
        default: return -1;
      }
    case 263: // VariableDeclarationList
      switch (name) {
        case "declarations": return 0;
        default: return -1;
      }
    case 267: // TypeAliasDeclaration
    case 346: // JSTypeAliasDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "typeParameters": return 2;
        case "type": return 3;
        default: return -1;
      }
    case 268: // EnumDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "members": return 2;
        default: return -1;
      }
    case 269: // ModuleDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "attributes": return 2;
        case "body": return 3;
        default: return -1;
      }
    case 271: // CaseBlock
      switch (name) {
        case "clauses": return 0;
        default: return -1;
      }
    case 272: // NamespaceExportDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        default: return -1;
      }
    case 273: // ImportEqualsDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "moduleReference": return 2;
        default: return -1;
      }
    case 274: // ImportDeclaration
    case 347: // JSImportDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "importClause": return 1;
        case "moduleSpecifier": return 2;
        case "attributes": return 3;
        default: return -1;
      }
    case 275: // ImportClause
      switch (name) {
        case "name": return 0;
        case "namedBindings": return 1;
        default: return -1;
      }
    case 278: // ImportSpecifier
    case 283: // ExportSpecifier
      switch (name) {
        case "propertyName": return 0;
        case "name": return 1;
        default: return -1;
      }
    case 279: // ExportAssignment
      switch (name) {
        case "modifiers": return 0;
        case "type": return 1;
        case "expression": return 2;
        default: return -1;
      }
    case 280: // ExportDeclaration
      switch (name) {
        case "modifiers": return 0;
        case "exportClause": return 1;
        case "moduleSpecifier": return 2;
        case "attributes": return 3;
        default: return -1;
      }
    case 284: // MissingDeclaration
      switch (name) {
        case "modifiers": return 0;
        default: return -1;
      }
    case 286: // JsxElement
      switch (name) {
        case "openingElement": return 0;
        case "children": return 1;
        case "closingElement": return 2;
        default: return -1;
      }
    case 287: // JsxSelfClosingElement
    case 288: // JsxOpeningElement
      switch (name) {
        case "tagName": return 0;
        case "typeArguments": return 1;
        case "attributes": return 2;
        default: return -1;
      }
    case 289: // JsxClosingElement
      switch (name) {
        case "tagName": return 0;
        default: return -1;
      }
    case 290: // JsxFragment
      switch (name) {
        case "openingFragment": return 0;
        case "children": return 1;
        case "closingFragment": return 2;
        default: return -1;
      }
    case 293: // JsxAttribute
    case 307: // EnumMember
      switch (name) {
        case "name": return 0;
        case "initializer": return 1;
        default: return -1;
      }
    case 296: // JsxExpression
      switch (name) {
        case "dotDotDotToken": return 0;
        case "expression": return 1;
        default: return -1;
      }
    case 297: // JsxNamespacedName
      switch (name) {
        case "namespace": return 0;
        case "name": return 1;
        default: return -1;
      }
    case 298: // CaseClause
    case 299: // DefaultClause
      switch (name) {
        case "expression": return 0;
        case "statements": return 1;
        default: return -1;
      }
    case 301: // CatchClause
      switch (name) {
        case "variableDeclaration": return 0;
        case "block": return 1;
        default: return -1;
      }
    case 302: // ImportAttributes
      switch (name) {
        case "attributes": return 0;
        default: return -1;
      }
    case 303: // ImportAttribute
      switch (name) {
        case "name": return 0;
        case "value": return 1;
        default: return -1;
      }
    case 305: // ShorthandPropertyAssignment
      switch (name) {
        case "modifiers": return 0;
        case "name": return 1;
        case "postfixToken": return 2;
        case "type": return 3;
        case "equalsToken": return 4;
        case "objectAssignmentInitializer": return 5;
        default: return -1;
      }
    case 308: // SourceFile
      switch (name) {
        case "statements": return 0;
        case "endOfFileToken": return 1;
        default: return -1;
      }
    case 316: // JSDoc
      switch (name) {
        case "comment": return 0;
        case "tags": return 1;
        default: return -1;
      }
    case 318: // JSDocTypeLiteral
      switch (name) {
        case "jsdocPropertyTags": return 0;
        default: return -1;
      }
    case 323: // FirstJSDocTagNode
    case 326: // JSDocDeprecatedTag
    case 327: // JSDocPublicTag
    case 328: // JSDocPrivateTag
    case 329: // JSDocProtectedTag
    case 330: // JSDocReadonlyTag
    case 331: // JSDocOverrideTag
      switch (name) {
        case "tagName": return 0;
        case "comment": return 1;
        default: return -1;
      }
    case 324: // JSDocAugmentsTag
    case 325: // JSDocImplementsTag
      switch (name) {
        case "tagName": return 0;
        case "className": return 1;
        case "comment": return 2;
        default: return -1;
      }
    case 332: // JSDocCallbackTag
    case 339: // JSDocTypedefTag
      switch (name) {
        case "tagName": return 0;
        case "typeExpression": return 1;
        case "name": return 2;
        case "comment": return 3;
        default: return -1;
      }
    case 333: // JSDocOverloadTag
    case 335: // JSDocReturnTag
    case 336: // JSDocThisTag
    case 337: // JSDocTypeTag
    case 342: // JSDocThrowsTag
    case 343: // JSDocSatisfiesTag
      switch (name) {
        case "tagName": return 0;
        case "typeExpression": return 1;
        case "comment": return 2;
        default: return -1;
      }
    case 334: // JSDocParameterTag
    case 341: // JSDocPropertyTag
      switch (name) {
        case "tagName": return 0;
        case "name": return 1;
        case "typeExpression": return 2;
        case "comment": return 3;
        default: return -1;
      }
    case 338: // JSDocTemplateTag
      switch (name) {
        case "tagName": return 0;
        case "constraint": return 1;
        case "typeParameters": return 2;
        case "comment": return 3;
        default: return -1;
      }
    case 340: // JSDocSeeTag
      switch (name) {
        case "tagName": return 0;
        case "nameExpression": return 1;
        case "comment": return 2;
        default: return -1;
      }
    case 344: // LastJSDocTagNode
      switch (name) {
        case "tagName": return 0;
        case "importClause": return 1;
        case "moduleSpecifier": return 2;
        case "attributes": return 3;
        case "comment": return 4;
        default: return -1;
      }
    case 345: // SyntaxList
      switch (name) {
        case "children": return 0;
        default: return -1;
      }
    case 350: // SyntheticReferenceExpression
      switch (name) {
        case "expression": return 0;
        case "thisArg": return 1;
        default: return -1;
      }
    default: return -1;
  }
}
