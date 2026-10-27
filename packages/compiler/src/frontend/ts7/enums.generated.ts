/* eslint-disable @typescript-eslint/no-duplicate-enum-values -- TypeScript aliases are part of the protocol. */
// Generated from typescript@7.0.2 by scripts/generate-ts7-ast-schema.mjs.
// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.
// Regenerate when changing the TypeScript pin; do not edit by hand.

export enum InternalSymbolName {
    Call = "__call",
    Constructor = "__constructor",
    New = "__new",
    Index = "__index",
    ExportStar = "__export",
    Global = "__global",
    Missing = "__missing",
    Type = "__type",
    Object = "__object",
    JSXAttributes = "__jsxAttributes",
    Class = "__class",
    Function = "__function",
    Computed = "__computed",
    AssignmentDeclaration = "__assignment",
    InstantiationExpression = "__instantiationExpression",
    ImportAttributes = "__importAttributes",
    ExportEquals = "export=",
    Default = "default",
    This = "this",
    ModuleExports = "module.exports"
}

export enum ModifierFlags {
    None = 0,
    Public = 1,
    Private = 2,
    Protected = 4,
    Readonly = 8,
    Override = 16,
    Export = 32,
    Abstract = 64,
    Ambient = 128,
    Static = 256,
    Accessor = 512,
    Async = 1024,
    Default = 2048,
    Const = 4096,
    In = 8192,
    Out = 16384,
    Decorator = 32768,
    Deprecated = 65536,
    JSDocPublic = 8388608,
    JSDocPrivate = 16777216,
    JSDocProtected = 33554432,
    JSDocReadonly = 67108864,
    JSDocOverride = 134217728,
    HasComputedJSDocModifiers = 268435456,
    HasComputedFlags = 536870912,
    SyntacticOrJSDocModifiers = 31,
    SyntacticOnlyModifiers = 65504,
    SyntacticModifiers = 65535,
    JSDocCacheOnlyModifiers = 260046848,
    JSDocOnlyModifiers = 65536,
    NonCacheOnlyModifiers = 131071,
    AccessibilityModifier = 7,
    ParameterPropertyModifier = 31,
    NonPublicAccessibilityModifier = 6,
    TypeScriptModifier = 28895,
    ExportDefault = 2080,
    All = 131071,
    Modifier = 98303,
    JavaScript = 3872
}

export enum NodeFlags {
    None = 0,
    Let = 1,
    Const = 2,
    Using = 4,
    Reparsed = 8,
    Synthesized = 16,
    OptionalChain = 32,
    ExportContext = 64,
    ContainsThis = 128,
    HasImplicitReturn = 256,
    HasExplicitReturn = 512,
    DisallowInContext = 1024,
    YieldContext = 2048,
    DecoratorContext = 4096,
    AwaitContext = 8192,
    DisallowConditionalTypesContext = 16384,
    ThisNodeHasError = 32768,
    JavaScriptFile = 65536,
    ThisNodeOrAnySubNodesHasError = 131072,
    HasAsyncFunctions = 262144,
    PossiblyContainsDynamicImport = 524288,
    PossiblyContainsImportMeta = 1048576,
    HasJSDoc = 2097152,
    JSDoc = 4194304,
    Ambient = 8388608,
    InWithStatement = 16777216,
    JsonFile = 33554432,
    PossiblyContainsDeprecatedTag = 67108864,
    Unreachable = 134217728,
    ReparserTransformedLiteral = 268435456,
    BlockScoped = 7,
    Constant = 6,
    AwaitUsing = 6,
    ReachabilityCheckFlags = 768,
    ReachabilityAndEmitFlags = 262912,
    ContextFlags = 25263104,
    TypeExcludesFlags = 10240,
    PermanentlySetIncrementalFlags = 1572864,
    IdentifierHasExtendedUnicodeEscape = 128,
    IdentifierIsInJSDocNamespace = 262144,
    NestedNamespace = 32
}

export enum ScriptKind {
    Unknown = 0,
    JS = 1,
    JSX = 2,
    TS = 3,
    TSX = 4,
    External = 5,
    JSON = 6,
    Deferred = 7
}

export enum ScriptTarget {
    ES2015 = 2,
    ES2016 = 3,
    ES2017 = 4,
    ES2018 = 5,
    ES2019 = 6,
    ES2020 = 7,
    ES2021 = 8,
    ES2022 = 9,
    ES2023 = 10,
    ES2024 = 11,
    ES2025 = 12,
    ESNext = 99,
    JSON = 100,
    Latest = 99
}

/** Numeric lookup with the SDK's aliases and undefined for unknown values. */
export function scriptTargetName(value: number): string | undefined {
  switch (value) {
    case 2: return "ES2015";
    case 3: return "ES2016";
    case 4: return "ES2017";
    case 5: return "ES2018";
    case 6: return "ES2019";
    case 7: return "ES2020";
    case 8: return "ES2021";
    case 9: return "ES2022";
    case 10: return "ES2023";
    case 11: return "ES2024";
    case 12: return "ES2025";
    case 99: return "Latest";
    case 100: return "JSON";
    default: return undefined;
  }
}

export enum SyntaxKind {
    Unknown = 0,
    EndOfFile = 1,
    SingleLineCommentTrivia = 2,
    MultiLineCommentTrivia = 3,
    NewLineTrivia = 4,
    WhitespaceTrivia = 5,
    ConflictMarkerTrivia = 6,
    NonTextFileMarkerTrivia = 7,
    NumericLiteral = 8,
    BigIntLiteral = 9,
    StringLiteral = 10,
    JsxText = 11,
    JsxTextAllWhiteSpaces = 12,
    RegularExpressionLiteral = 13,
    NoSubstitutionTemplateLiteral = 14,
    TemplateHead = 15,
    TemplateMiddle = 16,
    TemplateTail = 17,
    OpenBraceToken = 18,
    CloseBraceToken = 19,
    OpenParenToken = 20,
    CloseParenToken = 21,
    OpenBracketToken = 22,
    CloseBracketToken = 23,
    DotToken = 24,
    DotDotDotToken = 25,
    SemicolonToken = 26,
    CommaToken = 27,
    QuestionDotToken = 28,
    LessThanToken = 29,
    LessThanSlashToken = 30,
    GreaterThanToken = 31,
    LessThanEqualsToken = 32,
    GreaterThanEqualsToken = 33,
    EqualsEqualsToken = 34,
    ExclamationEqualsToken = 35,
    EqualsEqualsEqualsToken = 36,
    ExclamationEqualsEqualsToken = 37,
    EqualsGreaterThanToken = 38,
    PlusToken = 39,
    MinusToken = 40,
    AsteriskToken = 41,
    AsteriskAsteriskToken = 42,
    SlashToken = 43,
    PercentToken = 44,
    PlusPlusToken = 45,
    MinusMinusToken = 46,
    LessThanLessThanToken = 47,
    GreaterThanGreaterThanToken = 48,
    GreaterThanGreaterThanGreaterThanToken = 49,
    AmpersandToken = 50,
    BarToken = 51,
    CaretToken = 52,
    ExclamationToken = 53,
    TildeToken = 54,
    AmpersandAmpersandToken = 55,
    BarBarToken = 56,
    QuestionToken = 57,
    ColonToken = 58,
    AtToken = 59,
    QuestionQuestionToken = 60,
    BacktickToken = 61,
    HashToken = 62,
    EqualsToken = 63,
    PlusEqualsToken = 64,
    MinusEqualsToken = 65,
    AsteriskEqualsToken = 66,
    AsteriskAsteriskEqualsToken = 67,
    SlashEqualsToken = 68,
    PercentEqualsToken = 69,
    LessThanLessThanEqualsToken = 70,
    GreaterThanGreaterThanEqualsToken = 71,
    GreaterThanGreaterThanGreaterThanEqualsToken = 72,
    AmpersandEqualsToken = 73,
    BarEqualsToken = 74,
    BarBarEqualsToken = 75,
    AmpersandAmpersandEqualsToken = 76,
    QuestionQuestionEqualsToken = 77,
    CaretEqualsToken = 78,
    Identifier = 79,
    PrivateIdentifier = 80,
    JSDocCommentTextToken = 81,
    BreakKeyword = 82,
    CaseKeyword = 83,
    CatchKeyword = 84,
    ClassKeyword = 85,
    ConstKeyword = 86,
    ContinueKeyword = 87,
    DebuggerKeyword = 88,
    DefaultKeyword = 89,
    DeleteKeyword = 90,
    DoKeyword = 91,
    ElseKeyword = 92,
    EnumKeyword = 93,
    ExportKeyword = 94,
    ExtendsKeyword = 95,
    FalseKeyword = 96,
    FinallyKeyword = 97,
    ForKeyword = 98,
    FunctionKeyword = 99,
    IfKeyword = 100,
    ImportKeyword = 101,
    InKeyword = 102,
    InstanceOfKeyword = 103,
    NewKeyword = 104,
    NullKeyword = 105,
    ReturnKeyword = 106,
    SuperKeyword = 107,
    SwitchKeyword = 108,
    ThisKeyword = 109,
    ThrowKeyword = 110,
    TrueKeyword = 111,
    TryKeyword = 112,
    TypeOfKeyword = 113,
    VarKeyword = 114,
    VoidKeyword = 115,
    WhileKeyword = 116,
    WithKeyword = 117,
    ImplementsKeyword = 118,
    InterfaceKeyword = 119,
    LetKeyword = 120,
    PackageKeyword = 121,
    PrivateKeyword = 122,
    ProtectedKeyword = 123,
    PublicKeyword = 124,
    StaticKeyword = 125,
    YieldKeyword = 126,
    AbstractKeyword = 127,
    AccessorKeyword = 128,
    AsKeyword = 129,
    AssertsKeyword = 130,
    AssertKeyword = 131,
    AnyKeyword = 132,
    AsyncKeyword = 133,
    AwaitKeyword = 134,
    BooleanKeyword = 135,
    ConstructorKeyword = 136,
    DeclareKeyword = 137,
    GetKeyword = 138,
    ImmediateKeyword = 139,
    InferKeyword = 140,
    IntrinsicKeyword = 141,
    IsKeyword = 142,
    KeyOfKeyword = 143,
    ModuleKeyword = 144,
    NamespaceKeyword = 145,
    NeverKeyword = 146,
    OutKeyword = 147,
    ReadonlyKeyword = 148,
    RequireKeyword = 149,
    NumberKeyword = 150,
    ObjectKeyword = 151,
    SatisfiesKeyword = 152,
    SetKeyword = 153,
    StringKeyword = 154,
    SymbolKeyword = 155,
    TypeKeyword = 156,
    UndefinedKeyword = 157,
    UniqueKeyword = 158,
    UnknownKeyword = 159,
    UsingKeyword = 160,
    FromKeyword = 161,
    GlobalKeyword = 162,
    BigIntKeyword = 163,
    OverrideKeyword = 164,
    OfKeyword = 165,
    DeferKeyword = 166,
    QualifiedName = 167,
    ComputedPropertyName = 168,
    TypeParameter = 169,
    Parameter = 170,
    Decorator = 171,
    PropertySignature = 172,
    PropertyDeclaration = 173,
    MethodSignature = 174,
    MethodDeclaration = 175,
    ClassStaticBlockDeclaration = 176,
    Constructor = 177,
    GetAccessor = 178,
    SetAccessor = 179,
    CallSignature = 180,
    ConstructSignature = 181,
    IndexSignature = 182,
    TypePredicate = 183,
    TypeReference = 184,
    FunctionType = 185,
    ConstructorType = 186,
    TypeQuery = 187,
    TypeLiteral = 188,
    ArrayType = 189,
    TupleType = 190,
    OptionalType = 191,
    RestType = 192,
    UnionType = 193,
    IntersectionType = 194,
    ConditionalType = 195,
    InferType = 196,
    ParenthesizedType = 197,
    ThisType = 198,
    TypeOperator = 199,
    IndexedAccessType = 200,
    MappedType = 201,
    LiteralType = 202,
    NamedTupleMember = 203,
    TemplateLiteralType = 204,
    TemplateLiteralTypeSpan = 205,
    ImportType = 206,
    ObjectBindingPattern = 207,
    ArrayBindingPattern = 208,
    BindingElement = 209,
    ArrayLiteralExpression = 210,
    ObjectLiteralExpression = 211,
    PropertyAccessExpression = 212,
    ElementAccessExpression = 213,
    CallExpression = 214,
    NewExpression = 215,
    TaggedTemplateExpression = 216,
    TypeAssertionExpression = 217,
    ParenthesizedExpression = 218,
    FunctionExpression = 219,
    ArrowFunction = 220,
    DeleteExpression = 221,
    TypeOfExpression = 222,
    VoidExpression = 223,
    AwaitExpression = 224,
    PrefixUnaryExpression = 225,
    PostfixUnaryExpression = 226,
    BinaryExpression = 227,
    ConditionalExpression = 228,
    TemplateExpression = 229,
    YieldExpression = 230,
    SpreadElement = 231,
    ClassExpression = 232,
    OmittedExpression = 233,
    ExpressionWithTypeArguments = 234,
    AsExpression = 235,
    NonNullExpression = 236,
    MetaProperty = 237,
    SyntheticExpression = 238,
    SatisfiesExpression = 239,
    TemplateSpan = 240,
    SemicolonClassElement = 241,
    Block = 242,
    EmptyStatement = 243,
    VariableStatement = 244,
    ExpressionStatement = 245,
    IfStatement = 246,
    DoStatement = 247,
    WhileStatement = 248,
    ForStatement = 249,
    ForInStatement = 250,
    ForOfStatement = 251,
    ContinueStatement = 252,
    BreakStatement = 253,
    ReturnStatement = 254,
    WithStatement = 255,
    SwitchStatement = 256,
    LabeledStatement = 257,
    ThrowStatement = 258,
    TryStatement = 259,
    DebuggerStatement = 260,
    VariableDeclaration = 261,
    VariableDeclarationList = 262,
    FunctionDeclaration = 263,
    ClassDeclaration = 264,
    InterfaceDeclaration = 265,
    TypeAliasDeclaration = 266,
    EnumDeclaration = 267,
    ModuleDeclaration = 268,
    ModuleBlock = 269,
    CaseBlock = 270,
    NamespaceExportDeclaration = 271,
    ImportEqualsDeclaration = 272,
    ImportDeclaration = 273,
    ImportClause = 274,
    NamespaceImport = 275,
    NamedImports = 276,
    ImportSpecifier = 277,
    ExportAssignment = 278,
    ExportDeclaration = 279,
    NamedExports = 280,
    NamespaceExport = 281,
    ExportSpecifier = 282,
    MissingDeclaration = 283,
    ExternalModuleReference = 284,
    JsxElement = 285,
    JsxSelfClosingElement = 286,
    JsxOpeningElement = 287,
    JsxClosingElement = 288,
    JsxFragment = 289,
    JsxOpeningFragment = 290,
    JsxClosingFragment = 291,
    JsxAttribute = 292,
    JsxAttributes = 293,
    JsxSpreadAttribute = 294,
    JsxExpression = 295,
    JsxNamespacedName = 296,
    CaseClause = 297,
    DefaultClause = 298,
    HeritageClause = 299,
    CatchClause = 300,
    ImportAttributes = 301,
    ImportAttribute = 302,
    PropertyAssignment = 303,
    ShorthandPropertyAssignment = 304,
    SpreadAssignment = 305,
    EnumMember = 306,
    SourceFile = 307,
    JSDocTypeExpression = 308,
    JSDocNameReference = 309,
    JSDocAllType = 310,
    JSDocNullableType = 311,
    JSDocNonNullableType = 312,
    JSDocOptionalType = 313,
    JSDocVariadicType = 314,
    JSDoc = 315,
    JSDocText = 316,
    JSDocTypeLiteral = 317,
    JSDocSignature = 318,
    JSDocLink = 319,
    JSDocLinkCode = 320,
    JSDocLinkPlain = 321,
    JSDocUnknownTag = 322,
    JSDocAugmentsTag = 323,
    JSDocImplementsTag = 324,
    JSDocDeprecatedTag = 325,
    JSDocPublicTag = 326,
    JSDocPrivateTag = 327,
    JSDocProtectedTag = 328,
    JSDocReadonlyTag = 329,
    JSDocOverrideTag = 330,
    JSDocCallbackTag = 331,
    JSDocOverloadTag = 332,
    JSDocParameterTag = 333,
    JSDocReturnTag = 334,
    JSDocThisTag = 335,
    JSDocTypeTag = 336,
    JSDocTemplateTag = 337,
    JSDocTypedefTag = 338,
    JSDocSeeTag = 339,
    JSDocPropertyTag = 340,
    JSDocThrowsTag = 341,
    JSDocSatisfiesTag = 342,
    JSDocImportTag = 343,
    SyntaxList = 344,
    JSTypeAliasDeclaration = 345,
    JSImportDeclaration = 346,
    NotEmittedStatement = 347,
    PartiallyEmittedExpression = 348,
    SyntheticReferenceExpression = 349,
    NotEmittedTypeElement = 350,
    Count = 351,
    FirstAssignment = 63,
    LastAssignment = 78,
    FirstCompoundAssignment = 64,
    LastCompoundAssignment = 78,
    FirstReservedWord = 82,
    LastReservedWord = 117,
    FirstKeyword = 82,
    LastKeyword = 166,
    FirstFutureReservedWord = 118,
    LastFutureReservedWord = 126,
    FirstTypeNode = 183,
    LastTypeNode = 206,
    FirstPunctuation = 18,
    LastPunctuation = 78,
    FirstToken = 0,
    LastToken = 166,
    FirstLiteralToken = 8,
    LastLiteralToken = 14,
    FirstTemplateToken = 14,
    LastTemplateToken = 17,
    FirstBinaryOperator = 29,
    LastBinaryOperator = 78,
    FirstStatement = 244,
    LastStatement = 260,
    FirstNode = 167,
    FirstJSDocNode = 308,
    LastJSDocNode = 343,
    FirstJSDocTagNode = 322,
    LastJSDocTagNode = 343,
    FirstContextualKeyword = 127,
    LastContextualKeyword = 166,
    LastUnaryOperator = 54,
    FirstTriviaToken = 2,
    LastTriviaToken = 6
}

/** Numeric lookup with the SDK's aliases and undefined for unknown values. */
export function syntaxKindName(value: number): string | undefined {
  switch (value) {
    case 0: return "FirstToken";
    case 1: return "EndOfFile";
    case 2: return "FirstTriviaToken";
    case 3: return "MultiLineCommentTrivia";
    case 4: return "NewLineTrivia";
    case 5: return "WhitespaceTrivia";
    case 6: return "LastTriviaToken";
    case 7: return "NonTextFileMarkerTrivia";
    case 8: return "FirstLiteralToken";
    case 9: return "BigIntLiteral";
    case 10: return "StringLiteral";
    case 11: return "JsxText";
    case 12: return "JsxTextAllWhiteSpaces";
    case 13: return "RegularExpressionLiteral";
    case 14: return "FirstTemplateToken";
    case 15: return "TemplateHead";
    case 16: return "TemplateMiddle";
    case 17: return "LastTemplateToken";
    case 18: return "FirstPunctuation";
    case 19: return "CloseBraceToken";
    case 20: return "OpenParenToken";
    case 21: return "CloseParenToken";
    case 22: return "OpenBracketToken";
    case 23: return "CloseBracketToken";
    case 24: return "DotToken";
    case 25: return "DotDotDotToken";
    case 26: return "SemicolonToken";
    case 27: return "CommaToken";
    case 28: return "QuestionDotToken";
    case 29: return "FirstBinaryOperator";
    case 30: return "LessThanSlashToken";
    case 31: return "GreaterThanToken";
    case 32: return "LessThanEqualsToken";
    case 33: return "GreaterThanEqualsToken";
    case 34: return "EqualsEqualsToken";
    case 35: return "ExclamationEqualsToken";
    case 36: return "EqualsEqualsEqualsToken";
    case 37: return "ExclamationEqualsEqualsToken";
    case 38: return "EqualsGreaterThanToken";
    case 39: return "PlusToken";
    case 40: return "MinusToken";
    case 41: return "AsteriskToken";
    case 42: return "AsteriskAsteriskToken";
    case 43: return "SlashToken";
    case 44: return "PercentToken";
    case 45: return "PlusPlusToken";
    case 46: return "MinusMinusToken";
    case 47: return "LessThanLessThanToken";
    case 48: return "GreaterThanGreaterThanToken";
    case 49: return "GreaterThanGreaterThanGreaterThanToken";
    case 50: return "AmpersandToken";
    case 51: return "BarToken";
    case 52: return "CaretToken";
    case 53: return "ExclamationToken";
    case 54: return "LastUnaryOperator";
    case 55: return "AmpersandAmpersandToken";
    case 56: return "BarBarToken";
    case 57: return "QuestionToken";
    case 58: return "ColonToken";
    case 59: return "AtToken";
    case 60: return "QuestionQuestionToken";
    case 61: return "BacktickToken";
    case 62: return "HashToken";
    case 63: return "FirstAssignment";
    case 64: return "FirstCompoundAssignment";
    case 65: return "MinusEqualsToken";
    case 66: return "AsteriskEqualsToken";
    case 67: return "AsteriskAsteriskEqualsToken";
    case 68: return "SlashEqualsToken";
    case 69: return "PercentEqualsToken";
    case 70: return "LessThanLessThanEqualsToken";
    case 71: return "GreaterThanGreaterThanEqualsToken";
    case 72: return "GreaterThanGreaterThanGreaterThanEqualsToken";
    case 73: return "AmpersandEqualsToken";
    case 74: return "BarEqualsToken";
    case 75: return "BarBarEqualsToken";
    case 76: return "AmpersandAmpersandEqualsToken";
    case 77: return "QuestionQuestionEqualsToken";
    case 78: return "LastBinaryOperator";
    case 79: return "Identifier";
    case 80: return "PrivateIdentifier";
    case 81: return "JSDocCommentTextToken";
    case 82: return "FirstKeyword";
    case 83: return "CaseKeyword";
    case 84: return "CatchKeyword";
    case 85: return "ClassKeyword";
    case 86: return "ConstKeyword";
    case 87: return "ContinueKeyword";
    case 88: return "DebuggerKeyword";
    case 89: return "DefaultKeyword";
    case 90: return "DeleteKeyword";
    case 91: return "DoKeyword";
    case 92: return "ElseKeyword";
    case 93: return "EnumKeyword";
    case 94: return "ExportKeyword";
    case 95: return "ExtendsKeyword";
    case 96: return "FalseKeyword";
    case 97: return "FinallyKeyword";
    case 98: return "ForKeyword";
    case 99: return "FunctionKeyword";
    case 100: return "IfKeyword";
    case 101: return "ImportKeyword";
    case 102: return "InKeyword";
    case 103: return "InstanceOfKeyword";
    case 104: return "NewKeyword";
    case 105: return "NullKeyword";
    case 106: return "ReturnKeyword";
    case 107: return "SuperKeyword";
    case 108: return "SwitchKeyword";
    case 109: return "ThisKeyword";
    case 110: return "ThrowKeyword";
    case 111: return "TrueKeyword";
    case 112: return "TryKeyword";
    case 113: return "TypeOfKeyword";
    case 114: return "VarKeyword";
    case 115: return "VoidKeyword";
    case 116: return "WhileKeyword";
    case 117: return "LastReservedWord";
    case 118: return "FirstFutureReservedWord";
    case 119: return "InterfaceKeyword";
    case 120: return "LetKeyword";
    case 121: return "PackageKeyword";
    case 122: return "PrivateKeyword";
    case 123: return "ProtectedKeyword";
    case 124: return "PublicKeyword";
    case 125: return "StaticKeyword";
    case 126: return "LastFutureReservedWord";
    case 127: return "FirstContextualKeyword";
    case 128: return "AccessorKeyword";
    case 129: return "AsKeyword";
    case 130: return "AssertsKeyword";
    case 131: return "AssertKeyword";
    case 132: return "AnyKeyword";
    case 133: return "AsyncKeyword";
    case 134: return "AwaitKeyword";
    case 135: return "BooleanKeyword";
    case 136: return "ConstructorKeyword";
    case 137: return "DeclareKeyword";
    case 138: return "GetKeyword";
    case 139: return "ImmediateKeyword";
    case 140: return "InferKeyword";
    case 141: return "IntrinsicKeyword";
    case 142: return "IsKeyword";
    case 143: return "KeyOfKeyword";
    case 144: return "ModuleKeyword";
    case 145: return "NamespaceKeyword";
    case 146: return "NeverKeyword";
    case 147: return "OutKeyword";
    case 148: return "ReadonlyKeyword";
    case 149: return "RequireKeyword";
    case 150: return "NumberKeyword";
    case 151: return "ObjectKeyword";
    case 152: return "SatisfiesKeyword";
    case 153: return "SetKeyword";
    case 154: return "StringKeyword";
    case 155: return "SymbolKeyword";
    case 156: return "TypeKeyword";
    case 157: return "UndefinedKeyword";
    case 158: return "UniqueKeyword";
    case 159: return "UnknownKeyword";
    case 160: return "UsingKeyword";
    case 161: return "FromKeyword";
    case 162: return "GlobalKeyword";
    case 163: return "BigIntKeyword";
    case 164: return "OverrideKeyword";
    case 165: return "OfKeyword";
    case 166: return "LastContextualKeyword";
    case 167: return "FirstNode";
    case 168: return "ComputedPropertyName";
    case 169: return "TypeParameter";
    case 170: return "Parameter";
    case 171: return "Decorator";
    case 172: return "PropertySignature";
    case 173: return "PropertyDeclaration";
    case 174: return "MethodSignature";
    case 175: return "MethodDeclaration";
    case 176: return "ClassStaticBlockDeclaration";
    case 177: return "Constructor";
    case 178: return "GetAccessor";
    case 179: return "SetAccessor";
    case 180: return "CallSignature";
    case 181: return "ConstructSignature";
    case 182: return "IndexSignature";
    case 183: return "FirstTypeNode";
    case 184: return "TypeReference";
    case 185: return "FunctionType";
    case 186: return "ConstructorType";
    case 187: return "TypeQuery";
    case 188: return "TypeLiteral";
    case 189: return "ArrayType";
    case 190: return "TupleType";
    case 191: return "OptionalType";
    case 192: return "RestType";
    case 193: return "UnionType";
    case 194: return "IntersectionType";
    case 195: return "ConditionalType";
    case 196: return "InferType";
    case 197: return "ParenthesizedType";
    case 198: return "ThisType";
    case 199: return "TypeOperator";
    case 200: return "IndexedAccessType";
    case 201: return "MappedType";
    case 202: return "LiteralType";
    case 203: return "NamedTupleMember";
    case 204: return "TemplateLiteralType";
    case 205: return "TemplateLiteralTypeSpan";
    case 206: return "LastTypeNode";
    case 207: return "ObjectBindingPattern";
    case 208: return "ArrayBindingPattern";
    case 209: return "BindingElement";
    case 210: return "ArrayLiteralExpression";
    case 211: return "ObjectLiteralExpression";
    case 212: return "PropertyAccessExpression";
    case 213: return "ElementAccessExpression";
    case 214: return "CallExpression";
    case 215: return "NewExpression";
    case 216: return "TaggedTemplateExpression";
    case 217: return "TypeAssertionExpression";
    case 218: return "ParenthesizedExpression";
    case 219: return "FunctionExpression";
    case 220: return "ArrowFunction";
    case 221: return "DeleteExpression";
    case 222: return "TypeOfExpression";
    case 223: return "VoidExpression";
    case 224: return "AwaitExpression";
    case 225: return "PrefixUnaryExpression";
    case 226: return "PostfixUnaryExpression";
    case 227: return "BinaryExpression";
    case 228: return "ConditionalExpression";
    case 229: return "TemplateExpression";
    case 230: return "YieldExpression";
    case 231: return "SpreadElement";
    case 232: return "ClassExpression";
    case 233: return "OmittedExpression";
    case 234: return "ExpressionWithTypeArguments";
    case 235: return "AsExpression";
    case 236: return "NonNullExpression";
    case 237: return "MetaProperty";
    case 238: return "SyntheticExpression";
    case 239: return "SatisfiesExpression";
    case 240: return "TemplateSpan";
    case 241: return "SemicolonClassElement";
    case 242: return "Block";
    case 243: return "EmptyStatement";
    case 244: return "FirstStatement";
    case 245: return "ExpressionStatement";
    case 246: return "IfStatement";
    case 247: return "DoStatement";
    case 248: return "WhileStatement";
    case 249: return "ForStatement";
    case 250: return "ForInStatement";
    case 251: return "ForOfStatement";
    case 252: return "ContinueStatement";
    case 253: return "BreakStatement";
    case 254: return "ReturnStatement";
    case 255: return "WithStatement";
    case 256: return "SwitchStatement";
    case 257: return "LabeledStatement";
    case 258: return "ThrowStatement";
    case 259: return "TryStatement";
    case 260: return "LastStatement";
    case 261: return "VariableDeclaration";
    case 262: return "VariableDeclarationList";
    case 263: return "FunctionDeclaration";
    case 264: return "ClassDeclaration";
    case 265: return "InterfaceDeclaration";
    case 266: return "TypeAliasDeclaration";
    case 267: return "EnumDeclaration";
    case 268: return "ModuleDeclaration";
    case 269: return "ModuleBlock";
    case 270: return "CaseBlock";
    case 271: return "NamespaceExportDeclaration";
    case 272: return "ImportEqualsDeclaration";
    case 273: return "ImportDeclaration";
    case 274: return "ImportClause";
    case 275: return "NamespaceImport";
    case 276: return "NamedImports";
    case 277: return "ImportSpecifier";
    case 278: return "ExportAssignment";
    case 279: return "ExportDeclaration";
    case 280: return "NamedExports";
    case 281: return "NamespaceExport";
    case 282: return "ExportSpecifier";
    case 283: return "MissingDeclaration";
    case 284: return "ExternalModuleReference";
    case 285: return "JsxElement";
    case 286: return "JsxSelfClosingElement";
    case 287: return "JsxOpeningElement";
    case 288: return "JsxClosingElement";
    case 289: return "JsxFragment";
    case 290: return "JsxOpeningFragment";
    case 291: return "JsxClosingFragment";
    case 292: return "JsxAttribute";
    case 293: return "JsxAttributes";
    case 294: return "JsxSpreadAttribute";
    case 295: return "JsxExpression";
    case 296: return "JsxNamespacedName";
    case 297: return "CaseClause";
    case 298: return "DefaultClause";
    case 299: return "HeritageClause";
    case 300: return "CatchClause";
    case 301: return "ImportAttributes";
    case 302: return "ImportAttribute";
    case 303: return "PropertyAssignment";
    case 304: return "ShorthandPropertyAssignment";
    case 305: return "SpreadAssignment";
    case 306: return "EnumMember";
    case 307: return "SourceFile";
    case 308: return "FirstJSDocNode";
    case 309: return "JSDocNameReference";
    case 310: return "JSDocAllType";
    case 311: return "JSDocNullableType";
    case 312: return "JSDocNonNullableType";
    case 313: return "JSDocOptionalType";
    case 314: return "JSDocVariadicType";
    case 315: return "JSDoc";
    case 316: return "JSDocText";
    case 317: return "JSDocTypeLiteral";
    case 318: return "JSDocSignature";
    case 319: return "JSDocLink";
    case 320: return "JSDocLinkCode";
    case 321: return "JSDocLinkPlain";
    case 322: return "FirstJSDocTagNode";
    case 323: return "JSDocAugmentsTag";
    case 324: return "JSDocImplementsTag";
    case 325: return "JSDocDeprecatedTag";
    case 326: return "JSDocPublicTag";
    case 327: return "JSDocPrivateTag";
    case 328: return "JSDocProtectedTag";
    case 329: return "JSDocReadonlyTag";
    case 330: return "JSDocOverrideTag";
    case 331: return "JSDocCallbackTag";
    case 332: return "JSDocOverloadTag";
    case 333: return "JSDocParameterTag";
    case 334: return "JSDocReturnTag";
    case 335: return "JSDocThisTag";
    case 336: return "JSDocTypeTag";
    case 337: return "JSDocTemplateTag";
    case 338: return "JSDocTypedefTag";
    case 339: return "JSDocSeeTag";
    case 340: return "JSDocPropertyTag";
    case 341: return "JSDocThrowsTag";
    case 342: return "JSDocSatisfiesTag";
    case 343: return "LastJSDocTagNode";
    case 344: return "SyntaxList";
    case 345: return "JSTypeAliasDeclaration";
    case 346: return "JSImportDeclaration";
    case 347: return "NotEmittedStatement";
    case 348: return "PartiallyEmittedExpression";
    case 349: return "SyntheticReferenceExpression";
    case 350: return "NotEmittedTypeElement";
    case 351: return "Count";
    default: return undefined;
  }
}

export enum TokenFlags {
    None = 0,
    PrecedingLineBreak = 1,
    PrecedingJSDocComment = 2,
    Unterminated = 4,
    ExtendedUnicodeEscape = 8,
    Scientific = 16,
    Octal = 32,
    HexSpecifier = 64,
    BinarySpecifier = 128,
    OctalSpecifier = 256,
    ContainsSeparator = 512,
    UnicodeEscape = 1024,
    ContainsInvalidEscape = 2048,
    HexEscape = 4096,
    ContainsLeadingZero = 8192,
    ContainsInvalidSeparator = 16384,
    PrecedingJSDocLeadingAsterisks = 32768,
    SingleQuote = 65536,
    PrecedingJSDocWithDeprecated = 131072,
    PrecedingJSDocWithSeeOrLink = 262144,
    BinaryOrOctalSpecifier = 384,
    WithSpecifier = 448,
    StringLiteralFlags = 72716,
    NumericLiteralFlags = 25584,
    TemplateLiteralLikeFlags = 7180,
    RegularExpressionLiteralFlags = 4,
    IsInvalid = 26656
}

export enum DiagnosticCategory {
    Warning = 0,
    Error = 1,
    Suggestion = 2,
    Message = 3
}

export enum ElementFlags {
    None = 0,
    Required = 1,
    Optional = 2,
    Rest = 4,
    Variadic = 8,
    Fixed = 3,
    Variable = 12,
    NonRequired = 14,
    NonRest = 11
}

export enum ModuleKind {
    None = 0,
    CommonJS = 1,
    AMD = 2,
    UMD = 3,
    System = 4,
    ES2015 = 5,
    ES2020 = 6,
    ES2022 = 7,
    ESNext = 99,
    Node16 = 100,
    Node18 = 101,
    Node20 = 102,
    NodeNext = 199,
    Preserve = 200
}

/** Numeric lookup with the SDK's aliases and undefined for unknown values. */
export function moduleKindName(value: number): string | undefined {
  switch (value) {
    case 0: return "None";
    case 1: return "CommonJS";
    case 2: return "AMD";
    case 3: return "UMD";
    case 4: return "System";
    case 5: return "ES2015";
    case 6: return "ES2020";
    case 7: return "ES2022";
    case 99: return "ESNext";
    case 100: return "Node16";
    case 101: return "Node18";
    case 102: return "Node20";
    case 199: return "NodeNext";
    case 200: return "Preserve";
    default: return undefined;
  }
}

export enum NodeBuilderFlags {
    None = 0,
    NoTruncation = 1,
    WriteArrayAsGenericType = 2,
    GenerateNamesForShadowedTypeParams = 4,
    UseStructuralFallback = 8,
    ForbidIndexedAccessSymbolReferences = 16,
    WriteTypeArgumentsOfSignature = 32,
    UseFullyQualifiedType = 64,
    UseOnlyExternalAliasing = 128,
    SuppressAnyReturnType = 256,
    WriteTypeParametersInQualifiedName = 512,
    MultilineObjectLiterals = 1024,
    WriteClassExpressionAsTypeLiteral = 2048,
    UseTypeOfFunction = 4096,
    OmitParameterModifiers = 8192,
    UseAliasDefinedOutsideCurrentScope = 16384,
    UseSingleQuotesForStringLiteralType = 268435456,
    NoTypeReduction = 536870912,
    UseInstantiationExpressions = 1073741824,
    OmitThisParameter = 33554432,
    WriteCallStyleSignature = 134217728,
    AllowThisInObjectLiteral = 32768,
    AllowQualifiedNameInPlaceOfIdentifier = 65536,
    AllowAnonymousIdentifier = 131072,
    AllowEmptyUnionOrIntersection = 262144,
    AllowEmptyTuple = 524288,
    AllowUniqueESSymbolType = 1048576,
    AllowEmptyIndexInfoType = 2097152,
    AllowNodeModulesRelativePaths = 67108864,
    IgnoreErrors = 70221824,
    InObjectTypeLiteral = 4194304,
    InTypeAlias = 8388608,
    InInitialEntityName = 16777216
}

export enum ObjectFlags {
    None = 0,
    Class = 1,
    Interface = 2,
    Reference = 4,
    Tuple = 8,
    Anonymous = 16,
    Mapped = 32,
    Instantiated = 64,
    ObjectLiteral = 128,
    EvolvingArray = 256,
    ObjectLiteralPatternWithComputedProperties = 512,
    ReverseMapped = 1024,
    JsxAttributes = 2048,
    JSLiteral = 4096,
    FreshLiteral = 8192,
    ArrayLiteral = 16384,
    PrimitiveUnion = 32768,
    ContainsWideningType = 65536,
    ContainsObjectOrArrayLiteral = 131072,
    NonInferrableType = 262144,
    CouldContainTypeVariablesComputed = 524288,
    CouldContainTypeVariables = 1048576,
    MembersResolved = 2097152,
    ClassOrInterface = 3,
    RequiresWidening = 196608,
    PropagatingFlags = 458752,
    InstantiatedMapped = 96,
    InstantiationExpressionType = 16777216,
    SingleSignatureType = 33554432,
    ObjectTypeKindMask = 50332991,
    ContainsSpread = 4194304,
    ObjectRestType = 8388608,
    IsClassInstanceClone = 67108864,
    IdenticalBaseTypeCalculated = 134217728,
    IdenticalBaseTypeExists = 268435456,
    UnresolvedMembers = 536870912,
    FromTypeNode = 1073741824,
    IsGenericTypeComputed = 4194304,
    IsGenericObjectType = 8388608,
    IsGenericIndexType = 16777216,
    IsGenericType = 25165824,
    ContainsIntersections = 33554432,
    IsUnknownLikeUnionComputed = 67108864,
    IsUnknownLikeUnion = 134217728,
    IsNeverIntersectionComputed = 33554432,
    IsNeverIntersection = 67108864,
    IsConstrainedTypeVariable = 134217728
}

export enum SignatureFlags {
    None = 0,
    HasRestParameter = 1,
    HasLiteralTypes = 2,
    Construct = 4,
    Abstract = 8,
    IsInnerCallChain = 16,
    IsOuterCallChain = 32,
    IsUntypedSignatureInJSFile = 64,
    IsNonInferrable = 128,
    IsSignatureCandidateForOverloadFailure = 256,
    PropagatingFlags = 335,
    CallChainFlags = 48
}

export enum SignatureKind {
    Call = 0,
    Construct = 1
}

export enum SymbolFlags {
    None = 0,
    FunctionScopedVariable = 1,
    BlockScopedVariable = 2,
    Property = 4,
    EnumMember = 8,
    Function = 16,
    Class = 32,
    Interface = 64,
    ConstEnum = 128,
    RegularEnum = 256,
    ValueModule = 512,
    NamespaceModule = 1024,
    TypeLiteral = 2048,
    ObjectLiteral = 4096,
    Method = 8192,
    Constructor = 16384,
    GetAccessor = 32768,
    SetAccessor = 65536,
    Signature = 131072,
    TypeParameter = 262144,
    TypeAlias = 524288,
    ExportValue = 1048576,
    Alias = 2097152,
    Prototype = 4194304,
    ExportStar = 8388608,
    Optional = 16777216,
    Transient = 33554432,
    Assignment = 67108864,
    ModuleExports = 134217728,
    ConstEnumOnlyModule = 268435456,
    ReplaceableByMethod = 536870912,
    GlobalLookup = 1073741824,
    All = 536870912,
    Enum = 384,
    Variable = 3,
    Value = 111551,
    Type = 788968,
    Namespace = 1920,
    Module = 1536,
    Accessor = 98304,
    FunctionScopedVariableExcludes = 111550,
    BlockScopedVariableExcludes = 111551,
    ParameterExcludes = 111551,
    PropertyExcludes = 13243,
    EnumMemberExcludes = 900095,
    FunctionExcludes = 110991,
    ClassExcludes = 899503,
    InterfaceExcludes = 788872,
    RegularEnumExcludes = 899327,
    ConstEnumExcludes = 899967,
    ValueModuleExcludes = 110735,
    NamespaceModuleExcludes = 0,
    MethodExcludes = 103359,
    GetAccessorExcludes = 46011,
    SetAccessorExcludes = 78779,
    AccessorExcludes = 111547,
    TypeParameterExcludes = 526824,
    TypeAliasExcludes = 788968,
    AliasExcludes = 2097152,
    ModuleMember = 2623475,
    ExportHasLocal = 944,
    BlockScoped = 418,
    PropertyOrAccessor = 98308,
    ClassMember = 106500,
    ExportSupportsDefaultModifier = 112,
    ExportDoesNotSupportDefaultModifier = -113,
    Classifiable = 2885600,
    LateBindingContainer = 6256
}

export enum TypeFlags {
    None = 0,
    Any = 1,
    Unknown = 2,
    Undefined = 4,
    Null = 8,
    Void = 16,
    String = 32,
    Number = 64,
    BigInt = 128,
    Boolean = 256,
    ESSymbol = 512,
    StringLiteral = 1024,
    NumberLiteral = 2048,
    BigIntLiteral = 4096,
    BooleanLiteral = 8192,
    UniqueESSymbol = 16384,
    EnumLiteral = 32768,
    Enum = 65536,
    NonPrimitive = 131072,
    Never = 262144,
    TypeParameter = 524288,
    Object = 1048576,
    Index = 2097152,
    TemplateLiteral = 4194304,
    StringMapping = 8388608,
    Substitution = 16777216,
    IndexedAccess = 33554432,
    Conditional = 67108864,
    Union = 134217728,
    Intersection = 268435456,
    Reserved1 = 536870912,
    Reserved2 = 1073741824,
    Reserved3 = -2147483648,
    AnyOrUnknown = 3,
    Nullable = 12,
    Literal = 15360,
    Unit = 97292,
    Freshable = 80896,
    StringOrNumberLiteral = 3072,
    StringOrNumberLiteralOrUnique = 19456,
    DefinitelyFalsy = 15388,
    PossiblyFalsy = 15868,
    Intrinsic = 393983,
    StringLike = 12583968,
    NumberLike = 67648,
    BigIntLike = 4224,
    BooleanLike = 8448,
    EnumLike = 98304,
    ESSymbolLike = 16896,
    VoidLike = 20,
    Primitive = 12713980,
    DefinitelyNonNullable = 13893600,
    DisjointDomains = 12812284,
    UnionOrIntersection = 402653184,
    StructuredType = 403701760,
    TypeVariable = 34078720,
    InstantiableNonPrimitive = 117964800,
    InstantiablePrimitive = 14680064,
    Instantiable = 132644864,
    StructuredOrInstantiable = 536346624,
    ObjectFlagsType = 403963917,
    Simplifiable = 102760448,
    Singleton = 394239,
    Narrowable = 536575971,
    IncludesMask = 416808959,
    IncludesMissingType = 524288,
    IncludesNonWideningType = 2097152,
    IncludesWildcard = 33554432,
    IncludesEmptyObject = 67108864,
    IncludesInstantiable = 16777216,
    IncludesConstrainedTypeVariable = 536870912,
    IncludesError = 1073741824,
    NotPrimitiveUnion = 286523411
}

export enum TypePredicateKind {
    This = 0,
    Identifier = 1,
    AssertsThis = 2,
    AssertsIdentifier = 3
}

export enum ModuleResolutionKind {
    Unknown = 0,
    Classic = 1,
    Node10 = 2,
    Node16 = 3,
    NodeNext = 99,
    Bundler = 100
}

/** Numeric lookup with the SDK's aliases and undefined for unknown values. */
export function moduleResolutionKindName(value: number): string | undefined {
  switch (value) {
    case 0: return "Unknown";
    case 1: return "Classic";
    case 2: return "Node10";
    case 3: return "Node16";
    case 99: return "NodeNext";
    case 100: return "Bundler";
    default: return undefined;
  }
}

export enum ModuleDetectionKind {
    None = 0,
    Auto = 1,
    Legacy = 2,
    Force = 3
}

/** Numeric lookup with the SDK's aliases and undefined for unknown values. */
export function moduleDetectionKindName(value: number): string | undefined {
  switch (value) {
    case 0: return "None";
    case 1: return "Auto";
    case 2: return "Legacy";
    case 3: return "Force";
    default: return undefined;
  }
}

export enum OuterExpressionKinds {
    Parentheses = 1,
    TypeAssertions = 2,
    NonNullAssertions = 4,
    PartiallyEmittedExpressions = 8,
    ExpressionsWithTypeArguments = 16,
    Satisfies = 32,
    ExcludeJSDocTypeAssertion = 64,
    Assignments = 128,
    Comma = 256,
    Assertions = 38,
    All = 63,
    AllExceptAssertionsOrExpressionsWithTypeArguments = 9,
    ExpressionTypePassthrough = 385
}

export enum LanguageVariant {
    Standard = 0,
    JSX = 1
}

export enum JsxEmit {
    None = 0,
    Preserve = 1,
    ReactNative = 2,
    React = 3,
    ReactJSX = 4,
    ReactJSXDev = 5
}

/** Numeric lookup with the SDK's aliases and undefined for unknown values. */
export function jsxEmitName(value: number): string | undefined {
  switch (value) {
    case 0: return "None";
    case 1: return "Preserve";
    case 2: return "ReactNative";
    case 3: return "React";
    case 4: return "ReactJSX";
    case 5: return "ReactJSXDev";
    default: return undefined;
  }
}
