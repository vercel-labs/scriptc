// Generated from typescript@7.0.2 by scripts/generate-ts7-ast-schema.mjs.
// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.
// Regenerate when changing the TypeScript pin; do not edit by hand.

import type { AstNode } from "./ast-node.js";
import type { JsxTagNamePropertyAccess, ModifierArray, NodeArray } from "./ast-types.js";
import { SyntaxKind, NodeFlags, ModifierFlags, TokenFlags } from "./enums.js";
type Node = AstNode;

export type TriviaSyntaxKind = SyntaxKind.SingleLineCommentTrivia | SyntaxKind.MultiLineCommentTrivia | SyntaxKind.NewLineTrivia | SyntaxKind.WhitespaceTrivia | SyntaxKind.ConflictMarkerTrivia;

export type LiteralSyntaxKind = SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.StringLiteral | SyntaxKind.JsxText | SyntaxKind.JsxTextAllWhiteSpaces | SyntaxKind.RegularExpressionLiteral | SyntaxKind.NoSubstitutionTemplateLiteral;

export type PseudoLiteralSyntaxKind = SyntaxKind.TemplateHead | SyntaxKind.TemplateMiddle | SyntaxKind.TemplateTail;

export type PunctuationSyntaxKind = SyntaxKind.OpenBraceToken | SyntaxKind.CloseBraceToken | SyntaxKind.OpenParenToken | SyntaxKind.CloseParenToken | SyntaxKind.OpenBracketToken | SyntaxKind.CloseBracketToken | SyntaxKind.DotToken | SyntaxKind.DotDotDotToken | SyntaxKind.SemicolonToken | SyntaxKind.CommaToken | SyntaxKind.QuestionDotToken | SyntaxKind.LessThanToken | SyntaxKind.LessThanSlashToken | SyntaxKind.GreaterThanToken | SyntaxKind.LessThanEqualsToken | SyntaxKind.GreaterThanEqualsToken | SyntaxKind.EqualsEqualsToken | SyntaxKind.ExclamationEqualsToken | SyntaxKind.EqualsEqualsEqualsToken | SyntaxKind.ExclamationEqualsEqualsToken | SyntaxKind.EqualsGreaterThanToken | SyntaxKind.PlusToken | SyntaxKind.MinusToken | SyntaxKind.AsteriskToken | SyntaxKind.AsteriskAsteriskToken | SyntaxKind.SlashToken | SyntaxKind.PercentToken | SyntaxKind.PlusPlusToken | SyntaxKind.MinusMinusToken | SyntaxKind.LessThanLessThanToken | SyntaxKind.GreaterThanGreaterThanToken | SyntaxKind.GreaterThanGreaterThanGreaterThanToken | SyntaxKind.AmpersandToken | SyntaxKind.BarToken | SyntaxKind.CaretToken | SyntaxKind.ExclamationToken | SyntaxKind.TildeToken | SyntaxKind.AmpersandAmpersandToken | SyntaxKind.BarBarToken | SyntaxKind.QuestionToken | SyntaxKind.ColonToken | SyntaxKind.AtToken | SyntaxKind.QuestionQuestionToken | SyntaxKind.BacktickToken | SyntaxKind.HashToken | SyntaxKind.EqualsToken | SyntaxKind.PlusEqualsToken | SyntaxKind.MinusEqualsToken | SyntaxKind.AsteriskEqualsToken | SyntaxKind.AsteriskAsteriskEqualsToken | SyntaxKind.SlashEqualsToken | SyntaxKind.PercentEqualsToken | SyntaxKind.LessThanLessThanEqualsToken | SyntaxKind.GreaterThanGreaterThanEqualsToken | SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken | SyntaxKind.AmpersandEqualsToken | SyntaxKind.BarEqualsToken | SyntaxKind.BarBarEqualsToken | SyntaxKind.AmpersandAmpersandEqualsToken | SyntaxKind.QuestionQuestionEqualsToken | SyntaxKind.CaretEqualsToken;

export type KeywordSyntaxKind = SyntaxKind.BreakKeyword | SyntaxKind.CaseKeyword | SyntaxKind.CatchKeyword | SyntaxKind.ClassKeyword | SyntaxKind.ConstKeyword | SyntaxKind.ContinueKeyword | SyntaxKind.DebuggerKeyword | SyntaxKind.DefaultKeyword | SyntaxKind.DeleteKeyword | SyntaxKind.DoKeyword | SyntaxKind.ElseKeyword | SyntaxKind.EnumKeyword | SyntaxKind.ExportKeyword | SyntaxKind.ExtendsKeyword | SyntaxKind.FalseKeyword | SyntaxKind.FinallyKeyword | SyntaxKind.ForKeyword | SyntaxKind.FunctionKeyword | SyntaxKind.IfKeyword | SyntaxKind.ImportKeyword | SyntaxKind.InKeyword | SyntaxKind.InstanceOfKeyword | SyntaxKind.NewKeyword | SyntaxKind.NullKeyword | SyntaxKind.ReturnKeyword | SyntaxKind.SuperKeyword | SyntaxKind.SwitchKeyword | SyntaxKind.ThisKeyword | SyntaxKind.ThrowKeyword | SyntaxKind.TrueKeyword | SyntaxKind.TryKeyword | SyntaxKind.TypeOfKeyword | SyntaxKind.VarKeyword | SyntaxKind.VoidKeyword | SyntaxKind.WhileKeyword | SyntaxKind.WithKeyword | SyntaxKind.ImplementsKeyword | SyntaxKind.InterfaceKeyword | SyntaxKind.LetKeyword | SyntaxKind.PackageKeyword | SyntaxKind.PrivateKeyword | SyntaxKind.ProtectedKeyword | SyntaxKind.PublicKeyword | SyntaxKind.StaticKeyword | SyntaxKind.YieldKeyword | SyntaxKind.AbstractKeyword | SyntaxKind.AccessorKeyword | SyntaxKind.AsKeyword | SyntaxKind.AssertsKeyword | SyntaxKind.AssertKeyword | SyntaxKind.AnyKeyword | SyntaxKind.AsyncKeyword | SyntaxKind.AwaitKeyword | SyntaxKind.BooleanKeyword | SyntaxKind.ConstructorKeyword | SyntaxKind.DeclareKeyword | SyntaxKind.GetKeyword | SyntaxKind.ImmediateKeyword | SyntaxKind.InferKeyword | SyntaxKind.IntrinsicKeyword | SyntaxKind.IsKeyword | SyntaxKind.KeyOfKeyword | SyntaxKind.ModuleKeyword | SyntaxKind.NamespaceKeyword | SyntaxKind.NeverKeyword | SyntaxKind.OutKeyword | SyntaxKind.ReadonlyKeyword | SyntaxKind.RequireKeyword | SyntaxKind.NumberKeyword | SyntaxKind.ObjectKeyword | SyntaxKind.SatisfiesKeyword | SyntaxKind.SetKeyword | SyntaxKind.StringKeyword | SyntaxKind.SymbolKeyword | SyntaxKind.TypeKeyword | SyntaxKind.UndefinedKeyword | SyntaxKind.UniqueKeyword | SyntaxKind.UnknownKeyword | SyntaxKind.UsingKeyword | SyntaxKind.FromKeyword | SyntaxKind.GlobalKeyword | SyntaxKind.BigIntKeyword | SyntaxKind.OverrideKeyword | SyntaxKind.OfKeyword | SyntaxKind.DeferKeyword;

export type ModifierSyntaxKind = SyntaxKind.AbstractKeyword | SyntaxKind.AccessorKeyword | SyntaxKind.AsyncKeyword | SyntaxKind.ConstKeyword | SyntaxKind.DeclareKeyword | SyntaxKind.DefaultKeyword | SyntaxKind.ExportKeyword | SyntaxKind.InKeyword | SyntaxKind.PrivateKeyword | SyntaxKind.ProtectedKeyword | SyntaxKind.PublicKeyword | SyntaxKind.ReadonlyKeyword | SyntaxKind.OutKeyword | SyntaxKind.OverrideKeyword | SyntaxKind.StaticKeyword;

export type KeywordTypeSyntaxKind = SyntaxKind.AnyKeyword | SyntaxKind.BigIntKeyword | SyntaxKind.BooleanKeyword | SyntaxKind.IntrinsicKeyword | SyntaxKind.NeverKeyword | SyntaxKind.NumberKeyword | SyntaxKind.ObjectKeyword | SyntaxKind.StringKeyword | SyntaxKind.SymbolKeyword | SyntaxKind.UndefinedKeyword | SyntaxKind.UnknownKeyword | SyntaxKind.VoidKeyword;

export type KeywordExpressionSyntaxKind = SyntaxKind.NullKeyword | SyntaxKind.TrueKeyword | SyntaxKind.FalseKeyword | SyntaxKind.ThisKeyword | SyntaxKind.SuperKeyword | SyntaxKind.ImportKeyword;

export type TokenSyntaxKind = SyntaxKind.Unknown | SyntaxKind.EndOfFile | SyntaxKind.SingleLineCommentTrivia | SyntaxKind.MultiLineCommentTrivia | SyntaxKind.NewLineTrivia | SyntaxKind.WhitespaceTrivia | SyntaxKind.ConflictMarkerTrivia | SyntaxKind.NonTextFileMarkerTrivia | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.StringLiteral | SyntaxKind.JsxText | SyntaxKind.JsxTextAllWhiteSpaces | SyntaxKind.RegularExpressionLiteral | SyntaxKind.NoSubstitutionTemplateLiteral | SyntaxKind.TemplateHead | SyntaxKind.TemplateMiddle | SyntaxKind.TemplateTail | SyntaxKind.OpenBraceToken | SyntaxKind.CloseBraceToken | SyntaxKind.OpenParenToken | SyntaxKind.CloseParenToken | SyntaxKind.OpenBracketToken | SyntaxKind.CloseBracketToken | SyntaxKind.DotToken | SyntaxKind.DotDotDotToken | SyntaxKind.SemicolonToken | SyntaxKind.CommaToken | SyntaxKind.QuestionDotToken | SyntaxKind.LessThanToken | SyntaxKind.LessThanSlashToken | SyntaxKind.GreaterThanToken | SyntaxKind.LessThanEqualsToken | SyntaxKind.GreaterThanEqualsToken | SyntaxKind.EqualsEqualsToken | SyntaxKind.ExclamationEqualsToken | SyntaxKind.EqualsEqualsEqualsToken | SyntaxKind.ExclamationEqualsEqualsToken | SyntaxKind.EqualsGreaterThanToken | SyntaxKind.PlusToken | SyntaxKind.MinusToken | SyntaxKind.AsteriskToken | SyntaxKind.AsteriskAsteriskToken | SyntaxKind.SlashToken | SyntaxKind.PercentToken | SyntaxKind.PlusPlusToken | SyntaxKind.MinusMinusToken | SyntaxKind.LessThanLessThanToken | SyntaxKind.GreaterThanGreaterThanToken | SyntaxKind.GreaterThanGreaterThanGreaterThanToken | SyntaxKind.AmpersandToken | SyntaxKind.BarToken | SyntaxKind.CaretToken | SyntaxKind.ExclamationToken | SyntaxKind.TildeToken | SyntaxKind.AmpersandAmpersandToken | SyntaxKind.BarBarToken | SyntaxKind.QuestionToken | SyntaxKind.ColonToken | SyntaxKind.AtToken | SyntaxKind.QuestionQuestionToken | SyntaxKind.BacktickToken | SyntaxKind.HashToken | SyntaxKind.EqualsToken | SyntaxKind.PlusEqualsToken | SyntaxKind.MinusEqualsToken | SyntaxKind.AsteriskEqualsToken | SyntaxKind.AsteriskAsteriskEqualsToken | SyntaxKind.SlashEqualsToken | SyntaxKind.PercentEqualsToken | SyntaxKind.LessThanLessThanEqualsToken | SyntaxKind.GreaterThanGreaterThanEqualsToken | SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken | SyntaxKind.AmpersandEqualsToken | SyntaxKind.BarEqualsToken | SyntaxKind.BarBarEqualsToken | SyntaxKind.AmpersandAmpersandEqualsToken | SyntaxKind.QuestionQuestionEqualsToken | SyntaxKind.CaretEqualsToken | SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.JSDocCommentTextToken | SyntaxKind.BreakKeyword | SyntaxKind.CaseKeyword | SyntaxKind.CatchKeyword | SyntaxKind.ClassKeyword | SyntaxKind.ConstKeyword | SyntaxKind.ContinueKeyword | SyntaxKind.DebuggerKeyword | SyntaxKind.DefaultKeyword | SyntaxKind.DeleteKeyword | SyntaxKind.DoKeyword | SyntaxKind.ElseKeyword | SyntaxKind.EnumKeyword | SyntaxKind.ExportKeyword | SyntaxKind.ExtendsKeyword | SyntaxKind.FalseKeyword | SyntaxKind.FinallyKeyword | SyntaxKind.ForKeyword | SyntaxKind.FunctionKeyword | SyntaxKind.IfKeyword | SyntaxKind.ImportKeyword | SyntaxKind.InKeyword | SyntaxKind.InstanceOfKeyword | SyntaxKind.NewKeyword | SyntaxKind.NullKeyword | SyntaxKind.ReturnKeyword | SyntaxKind.SuperKeyword | SyntaxKind.SwitchKeyword | SyntaxKind.ThisKeyword | SyntaxKind.ThrowKeyword | SyntaxKind.TrueKeyword | SyntaxKind.TryKeyword | SyntaxKind.TypeOfKeyword | SyntaxKind.VarKeyword | SyntaxKind.VoidKeyword | SyntaxKind.WhileKeyword | SyntaxKind.WithKeyword | SyntaxKind.ImplementsKeyword | SyntaxKind.InterfaceKeyword | SyntaxKind.LetKeyword | SyntaxKind.PackageKeyword | SyntaxKind.PrivateKeyword | SyntaxKind.ProtectedKeyword | SyntaxKind.PublicKeyword | SyntaxKind.StaticKeyword | SyntaxKind.YieldKeyword | SyntaxKind.AbstractKeyword | SyntaxKind.AccessorKeyword | SyntaxKind.AsKeyword | SyntaxKind.AssertsKeyword | SyntaxKind.AssertKeyword | SyntaxKind.AnyKeyword | SyntaxKind.AsyncKeyword | SyntaxKind.AwaitKeyword | SyntaxKind.BooleanKeyword | SyntaxKind.ConstructorKeyword | SyntaxKind.DeclareKeyword | SyntaxKind.GetKeyword | SyntaxKind.ImmediateKeyword | SyntaxKind.InferKeyword | SyntaxKind.IntrinsicKeyword | SyntaxKind.IsKeyword | SyntaxKind.KeyOfKeyword | SyntaxKind.ModuleKeyword | SyntaxKind.NamespaceKeyword | SyntaxKind.NeverKeyword | SyntaxKind.OutKeyword | SyntaxKind.ReadonlyKeyword | SyntaxKind.RequireKeyword | SyntaxKind.NumberKeyword | SyntaxKind.ObjectKeyword | SyntaxKind.SatisfiesKeyword | SyntaxKind.SetKeyword | SyntaxKind.StringKeyword | SyntaxKind.SymbolKeyword | SyntaxKind.TypeKeyword | SyntaxKind.UndefinedKeyword | SyntaxKind.UniqueKeyword | SyntaxKind.UnknownKeyword | SyntaxKind.UsingKeyword | SyntaxKind.FromKeyword | SyntaxKind.GlobalKeyword | SyntaxKind.BigIntKeyword | SyntaxKind.OverrideKeyword | SyntaxKind.OfKeyword | SyntaxKind.DeferKeyword;

export type JsxTokenSyntaxKind = SyntaxKind.LessThanSlashToken | SyntaxKind.EndOfFile | SyntaxKind.ConflictMarkerTrivia | SyntaxKind.JsxText | SyntaxKind.JsxTextAllWhiteSpaces | SyntaxKind.OpenBraceToken | SyntaxKind.LessThanToken;

export type JSDocNodeSyntaxKind = SyntaxKind.JSDocTypeExpression | SyntaxKind.JSDocNameReference | SyntaxKind.JSDocAllType | SyntaxKind.JSDocNullableType | SyntaxKind.JSDocNonNullableType | SyntaxKind.JSDocOptionalType | SyntaxKind.JSDocVariadicType | SyntaxKind.JSDoc | SyntaxKind.JSDocText | SyntaxKind.JSDocTypeLiteral | SyntaxKind.JSDocSignature | SyntaxKind.JSDocLink | SyntaxKind.JSDocLinkCode | SyntaxKind.JSDocLinkPlain | SyntaxKind.JSDocUnknownTag | SyntaxKind.JSDocAugmentsTag | SyntaxKind.JSDocImplementsTag | SyntaxKind.JSDocDeprecatedTag | SyntaxKind.JSDocPublicTag | SyntaxKind.JSDocPrivateTag | SyntaxKind.JSDocProtectedTag | SyntaxKind.JSDocReadonlyTag | SyntaxKind.JSDocOverrideTag | SyntaxKind.JSDocCallbackTag | SyntaxKind.JSDocOverloadTag | SyntaxKind.JSDocParameterTag | SyntaxKind.JSDocReturnTag | SyntaxKind.JSDocThisTag | SyntaxKind.JSDocTypeTag | SyntaxKind.JSDocTemplateTag | SyntaxKind.JSDocTypedefTag | SyntaxKind.JSDocSeeTag | SyntaxKind.JSDocPropertyTag | SyntaxKind.JSDocThrowsTag | SyntaxKind.JSDocSatisfiesTag | SyntaxKind.JSDocImportTag;

export type ImportPhaseModifierSyntaxKind = SyntaxKind.TypeKeyword | SyntaxKind.DeferKeyword;

export type PostfixUnaryOperator = SyntaxKind.PlusPlusToken | SyntaxKind.MinusMinusToken;

export type PrefixUnaryOperator = SyntaxKind.PlusToken | SyntaxKind.MinusToken | SyntaxKind.TildeToken | SyntaxKind.ExclamationToken | SyntaxKind.PlusPlusToken | SyntaxKind.MinusMinusToken;

export type AssignmentOperator = SyntaxKind.EqualsToken | CompoundAssignmentOperator;

export type BinaryOperator = AssignmentOperatorOrHigher | SyntaxKind.CommaToken;

export type ExponentiationOperator = SyntaxKind.AsteriskAsteriskToken;

export type MultiplicativeOperator = SyntaxKind.AsteriskToken | SyntaxKind.SlashToken | SyntaxKind.PercentToken;

export type MultiplicativeOperatorOrHigher = ExponentiationOperator | MultiplicativeOperator;

export type AdditiveOperator = SyntaxKind.PlusToken | SyntaxKind.MinusToken;

export type AdditiveOperatorOrHigher = MultiplicativeOperatorOrHigher | AdditiveOperator;

export type ShiftOperator = SyntaxKind.LessThanLessThanToken | SyntaxKind.GreaterThanGreaterThanToken | SyntaxKind.GreaterThanGreaterThanGreaterThanToken;

export type ShiftOperatorOrHigher = AdditiveOperatorOrHigher | ShiftOperator;

export type RelationalOperator = SyntaxKind.LessThanToken | SyntaxKind.LessThanEqualsToken | SyntaxKind.GreaterThanToken | SyntaxKind.GreaterThanEqualsToken | SyntaxKind.InstanceOfKeyword | SyntaxKind.InKeyword;

export type RelationalOperatorOrHigher = ShiftOperatorOrHigher | RelationalOperator;

export type EqualityOperator = SyntaxKind.EqualsEqualsToken | SyntaxKind.EqualsEqualsEqualsToken | SyntaxKind.ExclamationEqualsEqualsToken | SyntaxKind.ExclamationEqualsToken;

export type EqualityOperatorOrHigher = RelationalOperatorOrHigher | EqualityOperator;

export type BitwiseOperator = SyntaxKind.AmpersandToken | SyntaxKind.BarToken | SyntaxKind.CaretToken;

export type BitwiseOperatorOrHigher = EqualityOperatorOrHigher | BitwiseOperator;

export type LogicalOperator = SyntaxKind.AmpersandAmpersandToken | SyntaxKind.BarBarToken;

export type LogicalOperatorOrHigher = BitwiseOperatorOrHigher | LogicalOperator;

export type CompoundAssignmentOperator = SyntaxKind.PlusEqualsToken | SyntaxKind.MinusEqualsToken | SyntaxKind.AsteriskAsteriskEqualsToken | SyntaxKind.AsteriskEqualsToken | SyntaxKind.SlashEqualsToken | SyntaxKind.PercentEqualsToken | SyntaxKind.AmpersandEqualsToken | SyntaxKind.BarEqualsToken | SyntaxKind.CaretEqualsToken | SyntaxKind.LessThanLessThanEqualsToken | SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken | SyntaxKind.GreaterThanGreaterThanEqualsToken | SyntaxKind.BarBarEqualsToken | SyntaxKind.AmpersandAmpersandEqualsToken | SyntaxKind.QuestionQuestionEqualsToken;

export type AssignmentOperatorOrHigher = SyntaxKind.QuestionQuestionToken | LogicalOperatorOrHigher | AssignmentOperator;

export type LogicalOrCoalescingAssignmentOperator = SyntaxKind.AmpersandAmpersandEqualsToken | SyntaxKind.BarBarEqualsToken | SyntaxKind.QuestionQuestionEqualsToken;

export interface NodeBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: TokenSyntaxKind | SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.QualifiedName | SyntaxKind.ComputedPropertyName | SyntaxKind.Decorator | SyntaxKind.EmptyStatement | SyntaxKind.IfStatement | SyntaxKind.DoStatement | SyntaxKind.WhileStatement | SyntaxKind.ForStatement | SyntaxKind.BreakStatement | SyntaxKind.ContinueStatement | SyntaxKind.ReturnStatement | SyntaxKind.WithStatement | SyntaxKind.SwitchStatement | SyntaxKind.CaseBlock | SyntaxKind.ThrowStatement | SyntaxKind.TryStatement | SyntaxKind.CatchClause | SyntaxKind.DebuggerStatement | SyntaxKind.LabeledStatement | SyntaxKind.ExpressionStatement | SyntaxKind.Block | SyntaxKind.VariableStatement | SyntaxKind.VariableDeclaration | SyntaxKind.VariableDeclarationList | SyntaxKind.Parameter | SyntaxKind.BindingElement | SyntaxKind.MissingDeclaration | SyntaxKind.FunctionDeclaration | SyntaxKind.ClassDeclaration | SyntaxKind.ClassExpression | SyntaxKind.HeritageClause | SyntaxKind.InterfaceDeclaration | SyntaxKind.TypeAliasDeclaration | SyntaxKind.EnumMember | SyntaxKind.EnumDeclaration | SyntaxKind.ModuleBlock | SyntaxKind.NotEmittedStatement | SyntaxKind.NotEmittedTypeElement | SyntaxKind.ImportDeclaration | SyntaxKind.ExternalModuleReference | SyntaxKind.NamespaceImport | SyntaxKind.NamedImports | SyntaxKind.ExportAssignment | SyntaxKind.NamespaceExportDeclaration | SyntaxKind.NamespaceExport | SyntaxKind.NamedExports | SyntaxKind.ExportSpecifier | SyntaxKind.CallSignature | SyntaxKind.ConstructSignature | SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.IndexSignature | SyntaxKind.MethodSignature | SyntaxKind.MethodDeclaration | SyntaxKind.PropertySignature | SyntaxKind.PropertyDeclaration | SyntaxKind.SemicolonClassElement | SyntaxKind.ClassStaticBlockDeclaration | SyntaxKind.OmittedExpression | KeywordExpressionSyntaxKind | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.NoSubstitutionTemplateLiteral | SyntaxKind.BinaryExpression | SyntaxKind.PrefixUnaryExpression | SyntaxKind.PostfixUnaryExpression | SyntaxKind.YieldExpression | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression | SyntaxKind.AsExpression | SyntaxKind.SatisfiesExpression | SyntaxKind.ConditionalExpression | SyntaxKind.PropertyAccessExpression | SyntaxKind.ElementAccessExpression | SyntaxKind.CallExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.NonNullExpression | SyntaxKind.SpreadElement | SyntaxKind.TemplateExpression | SyntaxKind.TemplateSpan | SyntaxKind.TaggedTemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.SpreadAssignment | SyntaxKind.PropertyAssignment | SyntaxKind.ShorthandPropertyAssignment | SyntaxKind.DeleteExpression | SyntaxKind.TypeOfExpression | SyntaxKind.VoidExpression | SyntaxKind.AwaitExpression | SyntaxKind.TypeAssertionExpression | KeywordTypeSyntaxKind | SyntaxKind.UnionType | SyntaxKind.IntersectionType | SyntaxKind.ConditionalType | SyntaxKind.TypeOperator | SyntaxKind.InferType | SyntaxKind.ArrayType | SyntaxKind.IndexedAccessType | SyntaxKind.TypeReference | SyntaxKind.ExpressionWithTypeArguments | SyntaxKind.LiteralType | SyntaxKind.ThisType | SyntaxKind.TypePredicate | SyntaxKind.ImportAttribute | SyntaxKind.ImportAttributes | SyntaxKind.TypeQuery | SyntaxKind.MappedType | SyntaxKind.TypeLiteral | SyntaxKind.TupleType | SyntaxKind.NamedTupleMember | SyntaxKind.OptionalType | SyntaxKind.RestType | SyntaxKind.ParenthesizedType | SyntaxKind.FunctionType | SyntaxKind.ConstructorType | SyntaxKind.TemplateHead | SyntaxKind.TemplateMiddle | SyntaxKind.TemplateTail | SyntaxKind.TemplateLiteralType | SyntaxKind.TemplateLiteralTypeSpan | SyntaxKind.SyntheticExpression | SyntaxKind.PartiallyEmittedExpression | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxNamespacedName | SyntaxKind.JsxOpeningElement | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment | SyntaxKind.JsxOpeningFragment | SyntaxKind.JsxClosingFragment | SyntaxKind.JsxAttribute | SyntaxKind.JsxSpreadAttribute | SyntaxKind.JsxClosingElement | SyntaxKind.JsxExpression | SyntaxKind.JsxText | SyntaxKind.SyntaxList | SyntaxKind.JSDoc | SyntaxKind.JSDocTypeExpression | SyntaxKind.JSDocNonNullableType | SyntaxKind.JSDocNullableType | SyntaxKind.JSDocAllType | SyntaxKind.JSDocVariadicType | SyntaxKind.JSDocOptionalType | SyntaxKind.JSDocTypeTag | SyntaxKind.JSDocUnknownTag | SyntaxKind.JSDocTemplateTag | SyntaxKind.JSDocReturnTag | SyntaxKind.JSDocPublicTag | SyntaxKind.JSDocPrivateTag | SyntaxKind.JSDocProtectedTag | SyntaxKind.JSDocReadonlyTag | SyntaxKind.JSDocOverrideTag | SyntaxKind.JSDocDeprecatedTag | SyntaxKind.JSDocSeeTag | SyntaxKind.JSDocImplementsTag | SyntaxKind.JSDocAugmentsTag | SyntaxKind.JSDocSatisfiesTag | SyntaxKind.JSDocThrowsTag | SyntaxKind.JSDocThisTag | SyntaxKind.JSDocImportTag | SyntaxKind.JSDocCallbackTag | SyntaxKind.JSDocOverloadTag | SyntaxKind.JSDocTypedefTag | SyntaxKind.JSDocSignature | SyntaxKind.JSDocNameReference | SyntaxKind.ModuleDeclaration | SyntaxKind.ImportEqualsDeclaration | SyntaxKind.ExportDeclaration | SyntaxKind.ImportType | SyntaxKind.ImportClause | SyntaxKind.ImportSpecifier | SyntaxKind.JSDocText | SyntaxKind.JSDocLink | SyntaxKind.JSDocLinkPlain | SyntaxKind.JSDocLinkCode | SyntaxKind.TypeParameter | SyntaxKind.SyntheticReferenceExpression | SyntaxKind.JSDocTypeLiteral | SyntaxKind.ForInStatement | SyntaxKind.ForOfStatement | SyntaxKind.CaseClause | SyntaxKind.DefaultClause | SyntaxKind.ObjectBindingPattern | SyntaxKind.ArrayBindingPattern | SyntaxKind.JSDocParameterTag | SyntaxKind.JSDocPropertyTag;
}

export interface StatementBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.EmptyStatement | SyntaxKind.IfStatement | SyntaxKind.DoStatement | SyntaxKind.WhileStatement | SyntaxKind.ForStatement | SyntaxKind.BreakStatement | SyntaxKind.ContinueStatement | SyntaxKind.ReturnStatement | SyntaxKind.WithStatement | SyntaxKind.SwitchStatement | SyntaxKind.ThrowStatement | SyntaxKind.TryStatement | SyntaxKind.DebuggerStatement | SyntaxKind.LabeledStatement | SyntaxKind.ExpressionStatement | SyntaxKind.Block | SyntaxKind.VariableStatement | SyntaxKind.MissingDeclaration | SyntaxKind.FunctionDeclaration | SyntaxKind.ClassDeclaration | SyntaxKind.InterfaceDeclaration | SyntaxKind.TypeAliasDeclaration | SyntaxKind.EnumDeclaration | SyntaxKind.ModuleBlock | SyntaxKind.NotEmittedStatement | SyntaxKind.ImportDeclaration | SyntaxKind.ExportAssignment | SyntaxKind.NamespaceExportDeclaration | SyntaxKind.ModuleDeclaration | SyntaxKind.ImportEqualsDeclaration | SyntaxKind.ExportDeclaration | SyntaxKind.ForInStatement | SyntaxKind.ForOfStatement;
}

export interface IterationStatementBase extends Node {
  readonly flags: NodeFlags;
  readonly statement: Statement;
  readonly kind: SyntaxKind.DoStatement | SyntaxKind.WhileStatement | SyntaxKind.ForStatement;
}

export interface ExpressionBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.ClassExpression | SyntaxKind.OmittedExpression | KeywordExpressionSyntaxKind | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.NoSubstitutionTemplateLiteral | SyntaxKind.BinaryExpression | SyntaxKind.PrefixUnaryExpression | SyntaxKind.PostfixUnaryExpression | SyntaxKind.YieldExpression | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression | SyntaxKind.AsExpression | SyntaxKind.SatisfiesExpression | SyntaxKind.ConditionalExpression | SyntaxKind.PropertyAccessExpression | SyntaxKind.ElementAccessExpression | SyntaxKind.CallExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.NonNullExpression | SyntaxKind.SpreadElement | SyntaxKind.TemplateExpression | SyntaxKind.TaggedTemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.DeleteExpression | SyntaxKind.TypeOfExpression | SyntaxKind.VoidExpression | SyntaxKind.AwaitExpression | SyntaxKind.TypeAssertionExpression | SyntaxKind.ExpressionWithTypeArguments | SyntaxKind.SyntheticExpression | SyntaxKind.PartiallyEmittedExpression | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxNamespacedName | SyntaxKind.JsxOpeningElement | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment | SyntaxKind.JsxOpeningFragment | SyntaxKind.JsxClosingFragment | SyntaxKind.JsxExpression | SyntaxKind.JsxText | SyntaxKind.SyntheticReferenceExpression;
}

export interface UnaryExpressionBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.ClassExpression | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.PrefixUnaryExpression | SyntaxKind.PostfixUnaryExpression | SyntaxKind.FunctionExpression | SyntaxKind.PropertyAccessExpression | SyntaxKind.ElementAccessExpression | SyntaxKind.CallExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.NonNullExpression | SyntaxKind.TemplateExpression | SyntaxKind.TaggedTemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.DeleteExpression | SyntaxKind.TypeOfExpression | SyntaxKind.VoidExpression | SyntaxKind.AwaitExpression | SyntaxKind.TypeAssertionExpression | SyntaxKind.ExpressionWithTypeArguments | SyntaxKind.PartiallyEmittedExpression | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment;
}

export interface UpdateExpressionBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.ClassExpression | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.PrefixUnaryExpression | SyntaxKind.PostfixUnaryExpression | SyntaxKind.FunctionExpression | SyntaxKind.PropertyAccessExpression | SyntaxKind.ElementAccessExpression | SyntaxKind.CallExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.NonNullExpression | SyntaxKind.TemplateExpression | SyntaxKind.TaggedTemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.ExpressionWithTypeArguments | SyntaxKind.PartiallyEmittedExpression | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment;
}

export interface LeftHandSideExpressionBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.ClassExpression | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.FunctionExpression | SyntaxKind.PropertyAccessExpression | SyntaxKind.ElementAccessExpression | SyntaxKind.CallExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.NonNullExpression | SyntaxKind.TemplateExpression | SyntaxKind.TaggedTemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.ExpressionWithTypeArguments | SyntaxKind.PartiallyEmittedExpression | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment;
}

export interface MemberExpressionBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.ClassExpression | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.FunctionExpression | SyntaxKind.PropertyAccessExpression | SyntaxKind.ElementAccessExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.TemplateExpression | SyntaxKind.TaggedTemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.ExpressionWithTypeArguments | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment;
}

export interface PrimaryExpressionBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier | SyntaxKind.ClassExpression | SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.FunctionExpression | SyntaxKind.NewExpression | SyntaxKind.MetaProperty | SyntaxKind.TemplateExpression | SyntaxKind.ParenthesizedExpression | SyntaxKind.ArrayLiteralExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.JsxElement | SyntaxKind.JsxAttributes | SyntaxKind.JsxSelfClosingElement | SyntaxKind.JsxFragment;
}

export interface TypeNodeBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: KeywordTypeSyntaxKind | SyntaxKind.UnionType | SyntaxKind.IntersectionType | SyntaxKind.ConditionalType | SyntaxKind.TypeOperator | SyntaxKind.InferType | SyntaxKind.ArrayType | SyntaxKind.IndexedAccessType | SyntaxKind.TypeReference | SyntaxKind.LiteralType | SyntaxKind.ThisType | SyntaxKind.TypePredicate | SyntaxKind.TypeQuery | SyntaxKind.MappedType | SyntaxKind.TypeLiteral | SyntaxKind.TupleType | SyntaxKind.NamedTupleMember | SyntaxKind.OptionalType | SyntaxKind.RestType | SyntaxKind.ParenthesizedType | SyntaxKind.FunctionType | SyntaxKind.ConstructorType | SyntaxKind.TemplateLiteralType | SyntaxKind.TemplateLiteralTypeSpan | SyntaxKind.JSDocTypeExpression | SyntaxKind.JSDocNonNullableType | SyntaxKind.JSDocNullableType | SyntaxKind.JSDocAllType | SyntaxKind.JSDocVariadicType | SyntaxKind.JSDocOptionalType | SyntaxKind.JSDocSignature | SyntaxKind.JSDocNameReference | SyntaxKind.ImportType | SyntaxKind.JSDocTypeLiteral;
}

export interface NodeWithTypeArgumentsBase extends Node {
  readonly flags: NodeFlags;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly kind: SyntaxKind.TypeReference | SyntaxKind.TypeQuery | SyntaxKind.ImportType;
}

export interface JSDocTypeBase extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocNonNullableType | SyntaxKind.JSDocNullableType | SyntaxKind.JSDocAllType | SyntaxKind.JSDocVariadicType | SyntaxKind.JSDocOptionalType | SyntaxKind.JSDocSignature | SyntaxKind.JSDocTypeLiteral;
}

export interface DeclarationBase extends Node {
  readonly kind: SyntaxKind.VariableDeclaration | SyntaxKind.Parameter | SyntaxKind.BindingElement | SyntaxKind.MissingDeclaration | SyntaxKind.FunctionDeclaration | SyntaxKind.ClassDeclaration | SyntaxKind.ClassExpression | SyntaxKind.InterfaceDeclaration | SyntaxKind.TypeAliasDeclaration | SyntaxKind.EnumMember | SyntaxKind.EnumDeclaration | SyntaxKind.ImportDeclaration | SyntaxKind.NamespaceImport | SyntaxKind.ExportAssignment | SyntaxKind.NamespaceExportDeclaration | SyntaxKind.NamespaceExport | SyntaxKind.ExportSpecifier | SyntaxKind.CallSignature | SyntaxKind.ConstructSignature | SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.IndexSignature | SyntaxKind.MethodSignature | SyntaxKind.MethodDeclaration | SyntaxKind.PropertySignature | SyntaxKind.PropertyDeclaration | SyntaxKind.SemicolonClassElement | SyntaxKind.ClassStaticBlockDeclaration | SyntaxKind.NoSubstitutionTemplateLiteral | SyntaxKind.BinaryExpression | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression | SyntaxKind.CallExpression | SyntaxKind.ObjectLiteralExpression | SyntaxKind.SpreadAssignment | SyntaxKind.PropertyAssignment | SyntaxKind.ShorthandPropertyAssignment | SyntaxKind.MappedType | SyntaxKind.TypeLiteral | SyntaxKind.NamedTupleMember | SyntaxKind.FunctionType | SyntaxKind.ConstructorType | SyntaxKind.JsxAttributes | SyntaxKind.JsxAttribute | SyntaxKind.JSDocSignature | SyntaxKind.ModuleDeclaration | SyntaxKind.ImportEqualsDeclaration | SyntaxKind.ExportDeclaration | SyntaxKind.ImportClause | SyntaxKind.ImportSpecifier | SyntaxKind.TypeParameter | SyntaxKind.JSDocTypeLiteral;
}

export interface ModifiersBase extends Node {
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.VariableStatement | SyntaxKind.Parameter | SyntaxKind.MissingDeclaration | SyntaxKind.FunctionDeclaration | SyntaxKind.ClassDeclaration | SyntaxKind.ClassExpression | SyntaxKind.InterfaceDeclaration | SyntaxKind.TypeAliasDeclaration | SyntaxKind.EnumMember | SyntaxKind.EnumDeclaration | SyntaxKind.ImportDeclaration | SyntaxKind.ExportAssignment | SyntaxKind.NamespaceExportDeclaration | SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.IndexSignature | SyntaxKind.MethodSignature | SyntaxKind.MethodDeclaration | SyntaxKind.PropertySignature | SyntaxKind.PropertyDeclaration | SyntaxKind.ClassStaticBlockDeclaration | SyntaxKind.BinaryExpression | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression | SyntaxKind.PropertyAssignment | SyntaxKind.ShorthandPropertyAssignment | SyntaxKind.FunctionType | SyntaxKind.ConstructorType | SyntaxKind.ModuleDeclaration | SyntaxKind.ImportEqualsDeclaration | SyntaxKind.ExportDeclaration | SyntaxKind.TypeParameter;
}

export interface FunctionLikeBase extends Node {
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.FunctionDeclaration | SyntaxKind.CallSignature | SyntaxKind.ConstructSignature | SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.IndexSignature | SyntaxKind.MethodSignature | SyntaxKind.MethodDeclaration | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression | SyntaxKind.FunctionType | SyntaxKind.ConstructorType | SyntaxKind.JSDocSignature;
}

export interface BodyBase extends Node {
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: NodeBody | undefined;
  readonly kind: SyntaxKind.FunctionDeclaration | SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.MethodDeclaration | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression | SyntaxKind.ModuleDeclaration;
}

export interface FunctionLikeWithBodyBase extends Node {
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: BlockOrExpression | undefined;
  readonly kind: SyntaxKind.FunctionDeclaration | SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.MethodDeclaration | SyntaxKind.ArrowFunction | SyntaxKind.FunctionExpression;
}

export interface ClassLikeBase extends Node {
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: Identifier | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly heritageClauses: NodeArray<HeritageClause> | undefined;
  readonly members: NodeArray<ClassElement>;
  readonly kind: SyntaxKind.ClassDeclaration | SyntaxKind.ClassExpression;
}

export interface LiteralLikeNodeBase extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly kind: SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral | SyntaxKind.NoSubstitutionTemplateLiteral | SyntaxKind.TemplateHead | SyntaxKind.TemplateMiddle | SyntaxKind.TemplateTail | SyntaxKind.JsxText;
}

export interface LiteralExpressionBase extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.StringLiteral | SyntaxKind.NumericLiteral | SyntaxKind.BigIntLiteral | SyntaxKind.RegularExpressionLiteral;
}

export interface TemplateLiteralLikeNodeBase extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly rawText: string;
  readonly templateFlags: TokenFlags;
  readonly kind: SyntaxKind.NoSubstitutionTemplateLiteral | SyntaxKind.TemplateHead | SyntaxKind.TemplateMiddle | SyntaxKind.TemplateTail;
}

export interface TypeElementBase extends Node {
  readonly kind: SyntaxKind.NotEmittedTypeElement | SyntaxKind.CallSignature | SyntaxKind.ConstructSignature | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.IndexSignature | SyntaxKind.MethodSignature | SyntaxKind.PropertySignature;
}

export interface ClassElementBase extends Node {
  readonly kind: SyntaxKind.Constructor | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.IndexSignature | SyntaxKind.MethodDeclaration | SyntaxKind.PropertyDeclaration | SyntaxKind.SemicolonClassElement | SyntaxKind.ClassStaticBlockDeclaration;
}

export interface NamedMemberBase extends Node {
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly kind: SyntaxKind.EnumMember | SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.MethodSignature | SyntaxKind.MethodDeclaration | SyntaxKind.PropertySignature | SyntaxKind.PropertyDeclaration | SyntaxKind.PropertyAssignment | SyntaxKind.ShorthandPropertyAssignment;
}

export interface ObjectLiteralElementBase extends Node {
  readonly kind: SyntaxKind.GetAccessor | SyntaxKind.SetAccessor | SyntaxKind.MethodDeclaration | SyntaxKind.SpreadAssignment | SyntaxKind.PropertyAssignment | SyntaxKind.ShorthandPropertyAssignment | SyntaxKind.JsxSpreadAttribute;
}

export interface UnionOrIntersectionTypeNodeBase extends Node {
  readonly flags: NodeFlags;
  readonly types: NodeArray<TypeNode>;
  readonly kind: SyntaxKind.UnionType | SyntaxKind.IntersectionType;
}

export interface JSDocTagBase extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocTypeTag | SyntaxKind.JSDocUnknownTag | SyntaxKind.JSDocTemplateTag | SyntaxKind.JSDocReturnTag | SyntaxKind.JSDocPublicTag | SyntaxKind.JSDocPrivateTag | SyntaxKind.JSDocProtectedTag | SyntaxKind.JSDocReadonlyTag | SyntaxKind.JSDocOverrideTag | SyntaxKind.JSDocDeprecatedTag | SyntaxKind.JSDocSeeTag | SyntaxKind.JSDocImplementsTag | SyntaxKind.JSDocAugmentsTag | SyntaxKind.JSDocSatisfiesTag | SyntaxKind.JSDocThrowsTag | SyntaxKind.JSDocThisTag | SyntaxKind.JSDocImportTag | SyntaxKind.JSDocCallbackTag | SyntaxKind.JSDocOverloadTag | SyntaxKind.JSDocTypedefTag | SyntaxKind.JSDocParameterTag | SyntaxKind.JSDocPropertyTag;
}

export interface JSDocCommentBase extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly kind: SyntaxKind.JSDocText | SyntaxKind.JSDocLink | SyntaxKind.JSDocLinkPlain | SyntaxKind.JSDocLinkCode;
}

export interface Token<TKind extends TokenSyntaxKind = TokenSyntaxKind> extends Node {
  readonly flags: NodeFlags;
  readonly kind: TKind;
}

export interface Identifier extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Identifier;
  readonly text: string;
}

export interface PrivateIdentifier extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.PrivateIdentifier;
  readonly text: string;
}

export interface QualifiedName extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.QualifiedName;
  readonly left: EntityName;
  readonly right: Identifier;
}

export interface ComputedPropertyName extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ComputedPropertyName;
  readonly expression: Expression;
}

export interface Decorator extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Decorator;
  readonly expression: LeftHandSideExpression;
}

export interface EmptyStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.EmptyStatement;
}

export interface IfStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.IfStatement;
  readonly expression: Expression;
  readonly thenStatement: Statement;
  readonly elseStatement: Statement | undefined;
}

export interface DoStatement extends Node {
  readonly flags: NodeFlags;
  readonly statement: Statement;
  readonly kind: SyntaxKind.DoStatement;
  readonly expression: Expression;
}

export interface WhileStatement extends Node {
  readonly flags: NodeFlags;
  readonly statement: Statement;
  readonly kind: SyntaxKind.WhileStatement;
  readonly expression: Expression;
}

export interface ForStatement extends Node {
  readonly flags: NodeFlags;
  readonly statement: Statement;
  readonly kind: SyntaxKind.ForStatement;
  readonly initializer: ForInitializer | undefined;
  readonly condition: Expression | undefined;
  readonly incrementor: Expression | undefined;
}

export interface BreakStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.BreakStatement;
  readonly label: Identifier | undefined;
}

export interface ContinueStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ContinueStatement;
  readonly label: Identifier | undefined;
}

export interface ReturnStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ReturnStatement;
  readonly expression: Expression | undefined;
}

export interface WithStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.WithStatement;
  readonly expression: Expression;
  readonly statement: Statement;
}

export interface SwitchStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SwitchStatement;
  readonly expression: Expression;
  readonly caseBlock: CaseBlock;
}

export interface CaseBlock extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.CaseBlock;
  readonly clauses: NodeArray<CaseOrDefaultClause>;
}

export interface ThrowStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ThrowStatement;
  readonly expression: Expression;
}

export interface TryStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TryStatement;
  readonly tryBlock: Block;
  readonly catchClause: CatchClause | undefined;
  readonly finallyBlock: Block | undefined;
}

export interface CatchClause extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.CatchClause;
  readonly variableDeclaration: VariableDeclaration | undefined;
  readonly block: Block;
}

export interface DebuggerStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.DebuggerStatement;
}

export interface LabeledStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.LabeledStatement;
  readonly label: Identifier;
  readonly statement: Statement;
}

export interface ExpressionStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ExpressionStatement;
  readonly expression: Expression;
}

export interface Block extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.Block;
  readonly statements: NodeArray<Statement>;
  readonly multiLine: boolean;
}

export interface VariableStatement extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.VariableStatement;
  readonly declarationList: VariableDeclarationList;
}

export interface VariableDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.VariableDeclaration;
  readonly name: BindingName;
  readonly exclamationToken: ExclamationToken | undefined;
  readonly type: TypeNode | undefined;
  readonly initializer: Expression | undefined;
}

export interface VariableDeclarationList extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.VariableDeclarationList;
  readonly declarations: NodeArray<VariableDeclaration>;
}

export interface ParameterDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.Parameter;
  readonly dotDotDotToken: DotDotDotToken | undefined;
  readonly name: BindingName;
  readonly questionToken: QuestionToken | undefined;
  readonly type: TypeNode | undefined;
  readonly initializer: Expression | undefined;
}

export interface BindingElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.BindingElement;
  readonly dotDotDotToken: DotDotDotToken | undefined;
  readonly propertyName: PropertyName | undefined;
  readonly name: BindingName | undefined;
  readonly initializer: Expression | undefined;
}

export interface MissingDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.MissingDeclaration;
}

export interface FunctionDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: FunctionBody | undefined;
  readonly kind: SyntaxKind.FunctionDeclaration;
  readonly name: Identifier | undefined;
}

export interface ClassDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: Identifier | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly heritageClauses: NodeArray<HeritageClause> | undefined;
  readonly members: NodeArray<ClassElement>;
  readonly kind: SyntaxKind.ClassDeclaration;
}

export interface ClassExpression extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: Identifier | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly heritageClauses: NodeArray<HeritageClause> | undefined;
  readonly members: NodeArray<ClassElement>;
  readonly kind: SyntaxKind.ClassExpression;
}

export interface HeritageClause extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.HeritageClause;
  readonly token: SyntaxKind.ExtendsKeyword | SyntaxKind.ImplementsKeyword;
  readonly types: NodeArray<ExpressionWithTypeArguments>;
}

export interface InterfaceDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.InterfaceDeclaration;
  readonly name: Identifier;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly heritageClauses: NodeArray<HeritageClause> | undefined;
  readonly members: NodeArray<TypeElement>;
}

export interface TypeAliasDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.TypeAliasDeclaration;
  readonly name: Identifier;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly type: TypeNode;
}

export interface EnumMember extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly kind: SyntaxKind.EnumMember;
  readonly initializer: Expression | undefined;
}

export interface EnumDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.EnumDeclaration;
  readonly name: Identifier;
  readonly members: NodeArray<EnumMember>;
}

export interface ModuleBlock extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ModuleBlock;
  readonly statements: NodeArray<Statement>;
}

export interface NotEmittedStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NotEmittedStatement;
}

export interface NotEmittedTypeElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NotEmittedTypeElement;
}

export interface ImportDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.ImportDeclaration;
  readonly importClause: ImportClause | undefined;
  readonly moduleSpecifier: Expression;
  readonly attributes: ImportAttributes | undefined;
}

export interface ExternalModuleReference extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ExternalModuleReference;
  readonly expression: Expression;
}

export interface NamespaceImport extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NamespaceImport;
  readonly name: Identifier;
}

export interface NamedImports extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NamedImports;
  readonly elements: NodeArray<ImportSpecifier>;
}

export interface ExportAssignment extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.ExportAssignment;
  readonly isExportEquals: boolean;
  readonly type: TypeNode;
  readonly expression: Expression;
}

export interface NamespaceExportDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.NamespaceExportDeclaration;
  readonly name: Identifier;
}

export interface NamespaceExport extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NamespaceExport;
  readonly name: ModuleExportName;
}

export interface NamedExports extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NamedExports;
  readonly elements: NodeArray<ExportSpecifier>;
}

export interface ExportSpecifier extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ExportSpecifier;
  readonly isTypeOnly: boolean;
  readonly propertyName: ModuleExportName | undefined;
  readonly name: ModuleExportName;
}

export interface CallSignatureDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.CallSignature;
}

export interface ConstructSignatureDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.ConstructSignature;
}

export interface ConstructorDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: FunctionBody | undefined;
  readonly kind: SyntaxKind.Constructor;
}

export interface GetAccessorDeclaration extends Node {
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: FunctionBody | undefined;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.GetAccessor;
}

export interface SetAccessorDeclaration extends Node {
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: FunctionBody | undefined;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SetAccessor;
}

export interface IndexSignatureDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode;
  readonly kind: SyntaxKind.IndexSignature;
}

export interface MethodSignatureDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.MethodSignature;
}

export interface MethodDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: FunctionBody | undefined;
  readonly kind: SyntaxKind.MethodDeclaration;
}

export interface PropertySignatureDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly kind: SyntaxKind.PropertySignature;
  readonly type: TypeNode;
  readonly initializer: Expression;
}

export interface PropertyDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly kind: SyntaxKind.PropertyDeclaration;
  readonly type: TypeNode | undefined;
  readonly initializer: Expression | undefined;
}

export interface SemicolonClassElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SemicolonClassElement;
}

export interface ClassStaticBlockDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.ClassStaticBlockDeclaration;
  readonly body: Block;
}

export interface OmittedExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.OmittedExpression;
}

export interface KeywordExpression<TKind extends KeywordExpressionSyntaxKind = KeywordExpressionSyntaxKind> extends Node {
  readonly flags: NodeFlags;
  readonly kind: TKind;
}

export interface StringLiteral extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.StringLiteral;
}

export interface NumericLiteral extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NumericLiteral;
}

export interface BigIntLiteral extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.BigIntLiteral;
}

export interface RegularExpressionLiteral extends Node {
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.RegularExpressionLiteral;
}

export interface NoSubstitutionTemplateLiteral extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly rawText: string;
  readonly templateFlags: TokenFlags;
  readonly kind: SyntaxKind.NoSubstitutionTemplateLiteral;
}

export interface BinaryExpression extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.BinaryExpression;
  readonly left: Expression;
  readonly type: TypeNode | undefined;
  readonly operatorToken: BinaryOperatorToken;
  readonly right: Expression;
}

export interface PrefixUnaryExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.PrefixUnaryExpression;
  readonly operator: SyntaxKind.PlusToken | SyntaxKind.MinusToken | SyntaxKind.TildeToken | SyntaxKind.ExclamationToken | SyntaxKind.PlusPlusToken | SyntaxKind.MinusMinusToken;
  readonly operand: Expression;
}

export interface PostfixUnaryExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.PostfixUnaryExpression;
  readonly operand: Expression;
  readonly operator: SyntaxKind.PlusPlusToken | SyntaxKind.MinusMinusToken;
}

export interface YieldExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.YieldExpression;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly expression: Expression | undefined;
}

export interface ArrowFunction extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: ConciseBody;
  readonly kind: SyntaxKind.ArrowFunction;
  readonly equalsGreaterThanToken: EqualsGreaterThanToken;
}

export interface FunctionExpression extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: FunctionBody;
  readonly kind: SyntaxKind.FunctionExpression;
  readonly name: Identifier | undefined;
}

export interface AsExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.AsExpression;
  readonly expression: Expression;
  readonly type: TypeNode;
}

export interface SatisfiesExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SatisfiesExpression;
  readonly expression: Expression;
  readonly type: TypeNode;
}

export interface ConditionalExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ConditionalExpression;
  readonly condition: Expression;
  readonly questionToken: QuestionToken;
  readonly whenTrue: Expression;
  readonly colonToken: ColonToken;
  readonly whenFalse: Expression;
}

export interface PropertyAccessExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.PropertyAccessExpression;
  readonly expression: Expression;
  readonly questionDotToken: QuestionDotToken | undefined;
  readonly name: MemberName;
}

export interface ElementAccessExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ElementAccessExpression;
  readonly expression: Expression;
  readonly questionDotToken: QuestionDotToken | undefined;
  readonly argumentExpression: Expression;
}

export interface CallExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.CallExpression;
  readonly expression: Expression;
  readonly questionDotToken: QuestionDotToken | undefined;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly arguments: NodeArray<Expression>;
}

export interface NewExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NewExpression;
  readonly expression: Expression;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly arguments: NodeArray<Expression> | undefined;
}

export interface MetaProperty extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.MetaProperty;
  readonly keywordToken: SyntaxKind.ImportKeyword | SyntaxKind.NewKeyword;
  readonly name: Identifier;
}

export interface NonNullExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NonNullExpression;
  readonly expression: Expression;
}

export interface SpreadElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SpreadElement;
  readonly expression: Expression;
}

export interface TemplateExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TemplateExpression;
  readonly head: TemplateHead;
  readonly templateSpans: NodeArray<TemplateSpan>;
}

export interface TemplateSpan extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TemplateSpan;
  readonly expression: Expression;
  readonly literal: TemplateMiddleOrTail;
}

export interface TaggedTemplateExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TaggedTemplateExpression;
  readonly tag: Expression;
  readonly questionDotToken: QuestionDotToken;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly template: TemplateLiteral;
}

export interface ParenthesizedExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ParenthesizedExpression;
  readonly expression: Expression;
}

export interface ArrayLiteralExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ArrayLiteralExpression;
  readonly elements: NodeArray<Expression>;
  readonly multiLine: boolean;
}

export interface ObjectLiteralExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ObjectLiteralExpression;
  readonly properties: NodeArray<ObjectLiteralElementLike>;
  readonly multiLine: boolean;
}

export interface SpreadAssignment extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SpreadAssignment;
  readonly expression: Expression;
}

export interface PropertyAssignment extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly kind: SyntaxKind.PropertyAssignment;
  readonly type: TypeNode;
  readonly initializer: Expression;
}

export interface ShorthandPropertyAssignment extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly name: PropertyName;
  readonly postfixToken: QuestionToken | ExclamationToken | undefined;
  readonly kind: SyntaxKind.ShorthandPropertyAssignment;
  readonly type: TypeNode;
  readonly equalsToken: EqualsToken | undefined;
  readonly objectAssignmentInitializer: Expression | undefined;
}

export interface DeleteExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.DeleteExpression;
  readonly expression: Expression;
}

export interface TypeOfExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TypeOfExpression;
  readonly expression: Expression;
}

export interface VoidExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.VoidExpression;
  readonly expression: Expression;
}

export interface AwaitExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.AwaitExpression;
  readonly expression: Expression;
}

export interface TypeAssertion extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TypeAssertionExpression;
  readonly type: TypeNode;
  readonly expression: Expression;
}

export interface KeywordTypeNode<TKind extends KeywordTypeSyntaxKind = KeywordTypeSyntaxKind> extends Node {
  readonly flags: NodeFlags;
  readonly kind: TKind;
}

export interface UnionTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly types: NodeArray<TypeNode>;
  readonly kind: SyntaxKind.UnionType;
}

export interface IntersectionTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly types: NodeArray<TypeNode>;
  readonly kind: SyntaxKind.IntersectionType;
}

export interface ConditionalTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ConditionalType;
  readonly checkType: TypeNode;
  readonly extendsType: TypeNode;
  readonly trueType: TypeNode;
  readonly falseType: TypeNode;
}

export interface TypeOperatorNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TypeOperator;
  readonly operator: SyntaxKind.KeyOfKeyword | SyntaxKind.ReadonlyKeyword | SyntaxKind.UniqueKeyword;
  readonly type: TypeNode;
}

export interface InferTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.InferType;
  readonly typeParameter: TypeParameterDeclaration;
}

export interface ArrayTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ArrayType;
  readonly elementType: TypeNode;
}

export interface IndexedAccessTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.IndexedAccessType;
  readonly objectType: TypeNode;
  readonly indexType: TypeNode;
}

export interface TypeReferenceNode extends Node {
  readonly flags: NodeFlags;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly kind: SyntaxKind.TypeReference;
  readonly typeName: EntityName;
}

export interface ExpressionWithTypeArguments extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ExpressionWithTypeArguments;
  readonly expression: Expression;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
}

export interface LiteralTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.LiteralType;
  readonly literal: Node;
}

export interface ThisTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ThisType;
}

export interface TypePredicateNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TypePredicate;
  readonly assertsModifier: AssertsKeyword | undefined;
  readonly parameterName: TypePredicateParameterName;
  readonly type: TypeNode | undefined;
}

export interface ImportAttribute extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ImportAttribute;
  readonly name: ImportAttributeName;
  readonly value: Expression;
}

export interface ImportAttributes extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ImportAttributes;
  readonly token: SyntaxKind.WithKeyword | SyntaxKind.AssertKeyword;
  readonly attributes: NodeArray<ImportAttribute>;
  readonly multiLine: boolean;
}

export interface TypeQueryNode extends Node {
  readonly flags: NodeFlags;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly kind: SyntaxKind.TypeQuery;
  readonly exprName: EntityName;
}

export interface MappedTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.MappedType;
  readonly readonlyToken: ReadonlyKeyword | PlusToken | MinusToken | undefined;
  readonly typeParameter: TypeParameterDeclaration;
  readonly nameType: TypeNode | undefined;
  readonly questionToken: QuestionToken | PlusToken | MinusToken | undefined;
  readonly type: TypeNode | undefined;
  readonly members: NodeArray<TypeElement> | undefined;
}

export interface TypeLiteralNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TypeLiteral;
  readonly members: NodeArray<TypeElement>;
}

export interface TupleTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TupleType;
  readonly elements: NodeArray<TypeNode>;
}

export interface NamedTupleMember extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.NamedTupleMember;
  readonly dotDotDotToken: DotDotDotToken | undefined;
  readonly name: Identifier;
  readonly questionToken: QuestionToken | undefined;
  readonly type: TypeNode;
}

export interface OptionalTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.OptionalType;
  readonly type: TypeNode;
}

export interface RestTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.RestType;
  readonly type: TypeNode;
}

export interface ParenthesizedTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ParenthesizedType;
  readonly type: TypeNode;
}

export interface FunctionTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.FunctionType;
}

export interface ConstructorTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.ConstructorType;
}

export interface TemplateHead extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly rawText: string;
  readonly templateFlags: TokenFlags;
  readonly kind: SyntaxKind.TemplateHead;
}

export interface TemplateMiddle extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly rawText: string;
  readonly templateFlags: TokenFlags;
  readonly kind: SyntaxKind.TemplateMiddle;
}

export interface TemplateTail extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly rawText: string;
  readonly templateFlags: TokenFlags;
  readonly kind: SyntaxKind.TemplateTail;
}

export interface TemplateLiteralTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TemplateLiteralType;
  readonly head: TemplateHead;
  readonly templateSpans: NodeArray<TemplateLiteralTypeSpan>;
}

export interface TemplateLiteralTypeSpan extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.TemplateLiteralTypeSpan;
  readonly type: TypeNode;
  readonly literal: TemplateMiddleOrTail;
}

export interface SyntheticExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SyntheticExpression;
  readonly tupleNameSource: Node | undefined;
}

export interface PartiallyEmittedExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.PartiallyEmittedExpression;
  readonly expression: Expression;
}

export interface JsxElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxElement;
  readonly openingElement: JsxOpeningElement;
  readonly children: NodeArray<JsxChild>;
  readonly closingElement: JsxClosingElement;
}

export interface JsxAttributes extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxAttributes;
  readonly properties: NodeArray<JsxAttributeLike>;
}

export interface JsxNamespacedName extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxNamespacedName;
  readonly namespace: Identifier;
  readonly name: Identifier;
}

export interface JsxOpeningElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxOpeningElement;
  readonly tagName: JsxTagNameExpression;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly attributes: JsxAttributes;
}

export interface JsxSelfClosingElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxSelfClosingElement;
  readonly tagName: JsxTagNameExpression;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly attributes: JsxAttributes;
}

export interface JsxFragment extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxFragment;
  readonly openingFragment: JsxOpeningFragment;
  readonly children: NodeArray<JsxChild>;
  readonly closingFragment: JsxClosingFragment;
}

export interface JsxOpeningFragment extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxOpeningFragment;
}

export interface JsxClosingFragment extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxClosingFragment;
}

export interface JsxAttribute extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxAttribute;
  readonly name: JsxAttributeName;
  readonly initializer: JsxAttributeValue | undefined;
}

export interface JsxSpreadAttribute extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxSpreadAttribute;
  readonly expression: Expression;
}

export interface JsxClosingElement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxClosingElement;
  readonly tagName: JsxTagNameExpression;
}

export interface JsxExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JsxExpression;
  readonly dotDotDotToken: DotDotDotToken | undefined;
  readonly expression: Expression | undefined;
}

export interface JsxText extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly tokenFlags: TokenFlags;
  readonly kind: SyntaxKind.JsxText;
  readonly containsOnlyTriviaWhiteSpaces: boolean;
}

export interface SyntaxList extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SyntaxList;
  readonly children: NodeArray<Node>;
}

export interface JSDoc extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDoc;
  readonly comment: NodeArray<JSDocComment>;
  readonly tags: NodeArray<JSDocTag> | undefined;
}

export interface JSDocTypeExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocTypeExpression;
  readonly type: TypeNode;
}

export interface JSDocNonNullableType extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocNonNullableType;
  readonly type: TypeNode;
}

export interface JSDocNullableType extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocNullableType;
  readonly type: TypeNode;
}

export interface JSDocAllType extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocAllType;
}

export interface JSDocVariadicType extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocVariadicType;
  readonly type: TypeNode;
}

export interface JSDocOptionalType extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocOptionalType;
  readonly type: TypeNode;
}

export interface JSDocTypeTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocTypeTag;
  readonly typeExpression: Node;
}

export interface JSDocUnknownTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocUnknownTag;
}

export interface JSDocTemplateTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocTemplateTag;
  readonly constraint: Node;
  readonly typeParameters: NodeArray<TypeParameterDeclaration>;
}

export interface JSDocReturnTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocReturnTag;
  readonly typeExpression: TypeNode | undefined;
}

export interface JSDocPublicTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocPublicTag;
}

export interface JSDocPrivateTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocPrivateTag;
}

export interface JSDocProtectedTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocProtectedTag;
}

export interface JSDocReadonlyTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocReadonlyTag;
}

export interface JSDocOverrideTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocOverrideTag;
}

export interface JSDocDeprecatedTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocDeprecatedTag;
}

export interface JSDocSeeTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocSeeTag;
  readonly nameExpression: TypeNode;
}

export interface JSDocImplementsTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocImplementsTag;
  readonly className: ExpressionWithTypeArguments;
}

export interface JSDocAugmentsTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocAugmentsTag;
  readonly className: ExpressionWithTypeArguments;
}

export interface JSDocSatisfiesTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocSatisfiesTag;
  readonly typeExpression: TypeNode;
}

export interface JSDocThrowsTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocThrowsTag;
  readonly typeExpression: TypeNode | undefined;
}

export interface JSDocThisTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocThisTag;
  readonly typeExpression: TypeNode;
}

export interface JSDocImportTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocImportTag;
  readonly importClause: ImportClause | undefined;
  readonly moduleSpecifier: Expression;
  readonly attributes: ImportAttributes | undefined;
}

export interface JSDocCallbackTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocCallbackTag;
  readonly typeExpression: TypeNode;
  readonly name: JSDocFullName | undefined;
}

export interface JSDocOverloadTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocOverloadTag;
  readonly typeExpression: TypeNode;
}

export interface JSDocTypedefTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocTypedefTag;
  readonly typeExpression: Node | undefined;
  readonly name: JSDocFullName | undefined;
}

export interface JSDocSignature extends Node {
  readonly flags: NodeFlags;
  readonly typeParameters: NodeArray<TypeParameterDeclaration> | undefined;
  readonly parameters: NodeArray<ParameterDeclaration>;
  readonly type: TypeNode | undefined;
  readonly kind: SyntaxKind.JSDocSignature;
}

export interface JSDocNameReference extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocNameReference;
  readonly name: EntityName;
}

export interface ModuleDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly asteriskToken: AsteriskToken | undefined;
  readonly body: ModuleBody | undefined;
  readonly kind: SyntaxKind.ModuleDeclaration;
  readonly keyword: SyntaxKind.ModuleKeyword | SyntaxKind.NamespaceKeyword;
  readonly name: ModuleName;
}

export interface ImportEqualsDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.ImportEqualsDeclaration;
  readonly isTypeOnly: boolean;
  readonly name: Identifier;
  readonly moduleReference: ModuleReference;
}

export interface ExportDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.ExportDeclaration;
  readonly isTypeOnly: boolean;
  readonly exportClause: NamedExportBindings | undefined;
  readonly moduleSpecifier: Expression | undefined;
  readonly attributes: ImportAttributes | undefined;
}

export interface ImportTypeNode extends Node {
  readonly flags: NodeFlags;
  readonly typeArguments: NodeArray<TypeNode> | undefined;
  readonly kind: SyntaxKind.ImportType;
  readonly isTypeOf: boolean;
  readonly argument: TypeNode;
  readonly attributes: ImportAttributes | undefined;
  readonly qualifier: EntityName | undefined;
}

export interface ImportClause extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ImportClause;
  readonly phaseModifier: ImportPhaseModifierSyntaxKind | undefined;
  readonly name: Identifier | undefined;
  readonly namedBindings: NamedImportBindings | undefined;
}

export interface ImportSpecifier extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ImportSpecifier;
  readonly isTypeOnly: boolean;
  readonly propertyName: ModuleExportName | undefined;
  readonly name: Identifier;
}

export interface JSDocText extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly kind: SyntaxKind.JSDocText;
}

export interface JSDocLink extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly kind: SyntaxKind.JSDocLink;
  readonly name: EntityName | undefined;
}

export interface JSDocLinkPlain extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly kind: SyntaxKind.JSDocLinkPlain;
  readonly name: EntityName | undefined;
}

export interface JSDocLinkCode extends Node {
  readonly flags: NodeFlags;
  readonly text: string;
  readonly kind: SyntaxKind.JSDocLinkCode;
  readonly name: EntityName | undefined;
}

export interface TypeParameterDeclaration extends Node {
  readonly flags: NodeFlags;
  readonly modifiers: ModifierArray<ModifierLike> | undefined;
  readonly modifierFlags: ModifierFlags;
  readonly kind: SyntaxKind.TypeParameter;
  readonly name: Identifier;
  readonly constraint: TypeNode | undefined;
  readonly expression: Expression | undefined;
  readonly defaultType: TypeNode | undefined;
}

export interface SyntheticReferenceExpression extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.SyntheticReferenceExpression;
  readonly expression: Expression;
  readonly thisArg: Expression;
}

export interface JSDocTypeLiteral extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.JSDocTypeLiteral;
  readonly jsdocPropertyTags: JSDocPropertyTag | undefined;
  readonly isArrayType: boolean;
}

export type Expression = ExpressionBase;

export type Statement = StatementBase;

export type TypeNode = TypeNodeBase | ExpressionWithTypeArguments;

export type BlockOrExpression = Block | Expression;

export type NodeBody = Block | Expression | ModuleBlock | ModuleDeclaration;

export type AccessExpression = PropertyAccessExpression | ElementAccessExpression;

export type DeclarationName = Identifier | PrivateIdentifier | StringLiteral | NumericLiteral | BigIntLiteral | NoSubstitutionTemplateLiteral | ComputedPropertyName | BindingPattern | ElementAccessExpression;

export type ModuleName = Identifier | StringLiteral;

export type ModuleExportName = Identifier | StringLiteral;

export type PropertyName = Identifier | StringLiteral | NoSubstitutionTemplateLiteral | NumericLiteral | ComputedPropertyName | PrivateIdentifier | BigIntLiteral;

export type ModuleBody = ModuleBlock | ModuleDeclaration;

export type JSDocFullName = Identifier | ModuleDeclaration;

export type ForInitializer = Expression | MissingDeclaration | VariableDeclarationList;

export type ModuleReference = Identifier | QualifiedName | ExternalModuleReference;

export type NamedImportBindings = NamespaceImport | NamedImports;

export type NamedExportBindings = NamespaceExport | NamedExports;

export type MemberName = Identifier | PrivateIdentifier;

export type EntityName = Identifier | QualifiedName;

export type BindingName = Identifier | BindingPattern;

export type ModifierLike = Modifier | Decorator;

export type JsxChild = JsxText | JsxExpression | JsxElement | JsxSelfClosingElement | JsxFragment;

export type JsxAttributeLike = JsxAttribute | JsxSpreadAttribute;

export type JsxAttributeName = Identifier | JsxNamespacedName;

export type JsxAttributeValue = StringLiteral | JsxExpression | JsxElement | JsxSelfClosingElement | JsxFragment;

export type JsxTagNameExpression = Identifier | ThisExpression | JsxTagNamePropertyAccess | JsxNamespacedName;

export type ClassLikeDeclaration = ClassDeclaration | ClassExpression;

export type AccessorDeclaration = GetAccessorDeclaration | SetAccessorDeclaration;

export type LiteralLikeNode = StringLiteral | NumericLiteral | BigIntLiteral | RegularExpressionLiteral | TemplateLiteralLikeNode | JsxText;

export type LiteralExpression = StringLiteral | NumericLiteral | BigIntLiteral | RegularExpressionLiteral | NoSubstitutionTemplateLiteral;

export type UnionOrIntersectionTypeNode = UnionTypeNode | IntersectionTypeNode;

export type TemplateLiteralLikeNode = TemplateHead | TemplateMiddle | TemplateTail;

export type TemplateMiddleOrTail = TemplateMiddle | TemplateTail;

export type TemplateLiteral = TemplateExpression | NoSubstitutionTemplateLiteral;

export type TypePredicateParameterName = Identifier | ThisTypeNode;

export type ImportAttributeName = Identifier | StringLiteral;

export type LeftHandSideExpression = LeftHandSideExpressionBase;

export type JSDocComment = JSDocText | JSDocLink | JSDocLinkCode | JSDocLinkPlain;

export type SignatureDeclaration = CallSignatureDeclaration | ConstructSignatureDeclaration | MethodSignatureDeclaration | IndexSignatureDeclaration | FunctionTypeNode | ConstructorTypeNode | FunctionDeclaration | MethodDeclaration | ConstructorDeclaration | AccessorDeclaration | FunctionExpression | ArrowFunction;

export type StringLiteralLikeNode = StringLiteral | NoSubstitutionTemplateLiteral;

export type NumericOrStringLikeLiteral = StringLiteralLikeNode | NumericLiteral;

export type ObjectLiteralLikeNode = ObjectLiteralExpression | ObjectBindingPattern;

export type ObjectTypeDeclaration = ClassLikeDeclaration | InterfaceDeclaration | TypeLiteralNode;

export type JsxOpeningLikeElement = JsxOpeningElement | JsxSelfClosingElement;

export type NamedImportsOrExports = NamedImports | NamedExports;

export type BreakOrContinueStatement = BreakStatement | ContinueStatement;

export type CallLikeExpression = CallExpression | NewExpression | TaggedTemplateExpression | Decorator | JsxOpeningLikeElement | BinaryExpression;

export type FunctionLikeDeclaration = FunctionDeclaration | MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration | ConstructorDeclaration | FunctionExpression | ArrowFunction;

export type VariableOrParameterDeclaration = VariableDeclaration | ParameterDeclaration;

export type VariableOrPropertyDeclaration = VariableDeclaration | PropertyDeclaration;

export type CallOrNewExpression = CallExpression | NewExpression;

export type ImportClauseOrBindingPattern = ImportClause | BindingPattern;

export type AnyImportSyntax = ImportDeclaration | ImportEqualsDeclaration;

export type Declaration = DeclarationBase;

export type ClassElement = ClassElementBase;

export type TypeElement = TypeElementBase;

export type ObjectLiteralElement = ObjectLiteralElementBase;

export type JSDocTag = JSDocTagBase;

export type ArrayBindingElement = BindingElement | OmittedExpression;

export type AssertionExpression = TypeAssertion | AsExpression;

export type BooleanLiteral = TrueLiteral | FalseLiteral;

export type ConciseBody = Block | Expression;

export type DestructuringAssignment = ObjectDestructuringAssignment | ArrayDestructuringAssignment;

export type LiteralToken = NumericLiteral | BigIntLiteral | StringLiteral | JsxText | RegularExpressionLiteral | NoSubstitutionTemplateLiteral;

export type Modifier = AbstractKeyword | AccessorKeyword | AsyncKeyword | ConstKeyword | DeclareKeyword | DefaultKeyword | ExportKeyword | InKeyword | PrivateKeyword | ProtectedKeyword | PublicKeyword | ReadonlyKeyword | OutKeyword | OverrideKeyword | StaticKeyword;

export type ObjectLiteralElementLike = PropertyAssignment | ShorthandPropertyAssignment | SpreadAssignment | MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration;

export type PropertyNameLiteral = Identifier | StringLiteral | NumericLiteral;

export type PseudoLiteralToken = TemplateHead | TemplateMiddle | TemplateTail;

export type TemplateLiteralToken = NoSubstitutionTemplateLiteral | PseudoLiteralToken;

export type ArrayDestructuringAssignment = BinaryExpression;

export type ObjectDestructuringAssignment = BinaryExpression;

export type FunctionBody = Block;

export type IncrementExpression = UpdateExpressionBase;

export interface ForInStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ForInStatement;
  readonly awaitModifier: AwaitKeyword | undefined;
  readonly initializer: ForInitializer;
  readonly expression: Expression;
  readonly statement: Statement;
}

export interface ForOfStatement extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ForOfStatement;
  readonly awaitModifier: AwaitKeyword | undefined;
  readonly initializer: ForInitializer;
  readonly expression: Expression;
  readonly statement: Statement;
}

export interface CaseClause extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.CaseClause;
  readonly expression: Expression;
  readonly statements: NodeArray<Statement>;
}

export interface DefaultClause extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.DefaultClause;
  readonly expression: undefined;
  readonly statements: NodeArray<Statement>;
}

export interface ObjectBindingPattern extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ObjectBindingPattern;
  readonly elements: NodeArray<BindingElement>;
}

export interface ArrayBindingPattern extends Node {
  readonly flags: NodeFlags;
  readonly kind: SyntaxKind.ArrayBindingPattern;
  readonly elements: NodeArray<BindingElement>;
}

export interface JSDocParameterTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocParameterTag;
  readonly name: EntityName;
  readonly isBracketed: boolean;
  readonly typeExpression: TypeNode | undefined;
  readonly isNameFirst: boolean;
}

export interface JSDocPropertyTag extends Node {
  readonly flags: NodeFlags;
  readonly tagName: Identifier;
  readonly comment: NodeArray<JSDocComment> | undefined;
  readonly kind: SyntaxKind.JSDocPropertyTag;
  readonly name: EntityName;
  readonly isBracketed: boolean;
  readonly typeExpression: TypeNode | undefined;
  readonly isNameFirst: boolean;
}

export type ForInOrOfStatement = ForInStatement | ForOfStatement;

export type CaseOrDefaultClause = CaseClause | DefaultClause;

export type BindingPattern = ObjectBindingPattern | ArrayBindingPattern;

export type JSDocParameterOrPropertyTag = JSDocParameterTag | JSDocPropertyTag;

export type EndOfFile = Token<SyntaxKind.EndOfFile>;

export type DotToken = Token<SyntaxKind.DotToken>;

export type DotDotDotToken = Token<SyntaxKind.DotDotDotToken>;

export type QuestionToken = Token<SyntaxKind.QuestionToken>;

export type ExclamationToken = Token<SyntaxKind.ExclamationToken>;

export type ColonToken = Token<SyntaxKind.ColonToken>;

export type EqualsToken = Token<SyntaxKind.EqualsToken>;

export type AsteriskToken = Token<SyntaxKind.AsteriskToken>;

export type EqualsGreaterThanToken = Token<SyntaxKind.EqualsGreaterThanToken>;

export type PlusToken = Token<SyntaxKind.PlusToken>;

export type MinusToken = Token<SyntaxKind.MinusToken>;

export type QuestionDotToken = Token<SyntaxKind.QuestionDotToken>;

export type AssertsKeyword = Token<SyntaxKind.AssertsKeyword>;

export type AssertKeyword = Token<SyntaxKind.AssertKeyword>;

export type AwaitKeyword = Token<SyntaxKind.AwaitKeyword>;

export type CaseKeyword = Token<SyntaxKind.CaseKeyword>;

export type AbstractKeyword = Token<SyntaxKind.AbstractKeyword>;

export type AccessorKeyword = Token<SyntaxKind.AccessorKeyword>;

export type AsyncKeyword = Token<SyntaxKind.AsyncKeyword>;

export type ConstKeyword = Token<SyntaxKind.ConstKeyword>;

export type DeclareKeyword = Token<SyntaxKind.DeclareKeyword>;

export type DefaultKeyword = Token<SyntaxKind.DefaultKeyword>;

export type ExportKeyword = Token<SyntaxKind.ExportKeyword>;

export type InKeyword = Token<SyntaxKind.InKeyword>;

export type PrivateKeyword = Token<SyntaxKind.PrivateKeyword>;

export type ProtectedKeyword = Token<SyntaxKind.ProtectedKeyword>;

export type PublicKeyword = Token<SyntaxKind.PublicKeyword>;

export type ReadonlyKeyword = Token<SyntaxKind.ReadonlyKeyword>;

export type OutKeyword = Token<SyntaxKind.OutKeyword>;

export type OverrideKeyword = Token<SyntaxKind.OverrideKeyword>;

export type StaticKeyword = Token<SyntaxKind.StaticKeyword>;

export type BinaryOperatorToken = Token<BinaryOperator>;

export type AssignmentOperatorToken = Token<AssignmentOperator>;

export type NullLiteral = KeywordExpression<SyntaxKind.NullKeyword>;

export type TrueLiteral = KeywordExpression<SyntaxKind.TrueKeyword>;

export type FalseLiteral = KeywordExpression<SyntaxKind.FalseKeyword>;

export type ThisExpression = KeywordExpression<SyntaxKind.ThisKeyword>;

export type SuperExpression = KeywordExpression<SyntaxKind.SuperKeyword>;

export type ImportExpression = KeywordExpression<SyntaxKind.ImportKeyword>;

export type StatementList = NodeArray<Statement>;

export type CaseClausesList = NodeArray<CaseOrDefaultClause>;

export type VariableDeclarationNodeList = NodeArray<VariableDeclaration>;

export type BindingElementList = NodeArray<BindingElement>;

export type TypeParameterList = NodeArray<TypeParameterDeclaration>;

export type ParameterList = NodeArray<ParameterDeclaration>;

export type HeritageClauseList = NodeArray<HeritageClause>;

export type ClassElementList = NodeArray<ClassElement>;

export type TypeElementList = NodeArray<TypeElement>;

export type ExpressionWithTypeArgumentsList = NodeArray<ExpressionWithTypeArguments>;

export type EnumMemberList = NodeArray<EnumMember>;

export type ImportSpecifierList = NodeArray<ImportSpecifier>;

export type ExportSpecifierList = NodeArray<ExportSpecifier>;

export type TypeArgumentList = NodeArray<TypeNode>;

export type ArgumentList = NodeArray<Expression>;

export type TemplateSpanList = NodeArray<TemplateSpan>;

export type ElementList = NodeArray<Expression>;

export type PropertyDefinitionList = NodeArray<ObjectLiteralElement>;

export type TypeList = NodeArray<TypeNode>;

export type ImportAttributeList = NodeArray<ImportAttribute>;

export type TemplateLiteralTypeSpanList = NodeArray<TemplateLiteralTypeSpan>;

export type JsxChildList = NodeArray<JsxChild>;

export type JsxAttributeList = NodeArray<JsxAttributeLike>;
