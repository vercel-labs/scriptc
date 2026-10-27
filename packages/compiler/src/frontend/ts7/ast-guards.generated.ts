// Generated from typescript@7.0.2 by scripts/generate-ts7-ast-schema.mjs.
// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.
// Regenerate when changing the TypeScript pin; do not edit by hand.

import type { AbstractKeyword, AccessExpression, AccessorDeclaration, AccessorKeyword, AdditiveOperator, AdditiveOperatorOrHigher, AnyImportSyntax, ArrayBindingElement, ArrayBindingPattern, ArrayDestructuringAssignment, ArrayLiteralExpression, ArrayTypeNode, ArrowFunction, AsExpression, AssertKeyword, AssertionExpression, AssertsKeyword, AssignmentOperator, AssignmentOperatorOrHigher, AssignmentOperatorToken, AsteriskToken, AsyncKeyword, AwaitExpression, AwaitKeyword, BigIntLiteral, BinaryExpression, BinaryOperator, BinaryOperatorToken, BindingElement, BindingName, BindingPattern, BitwiseOperator, BitwiseOperatorOrHigher, Block, BlockOrExpression, BooleanLiteral, BreakOrContinueStatement, BreakStatement, CallExpression, CallLikeExpression, CallOrNewExpression, CallSignatureDeclaration, CaseBlock, CaseClause, CaseKeyword, CatchClause, ClassDeclaration, ClassExpression, ClassLikeDeclaration, ClassStaticBlockDeclaration, ColonToken, CompoundAssignmentOperator, ComputedPropertyName, ConciseBody, ConditionalExpression, ConditionalTypeNode, ConstKeyword, ConstructSignatureDeclaration, ConstructorDeclaration, ConstructorTypeNode, ContinueStatement, DebuggerStatement, DeclarationName, DeclareKeyword, Decorator, DefaultClause, DefaultKeyword, DeleteExpression, DestructuringAssignment, DoStatement, DotDotDotToken, DotToken, ElementAccessExpression, EmptyStatement, EndOfFile, EntityName, EnumDeclaration, EnumMember, EqualityOperator, EqualityOperatorOrHigher, EqualsGreaterThanToken, EqualsToken, ExclamationToken, ExponentiationOperator, ExportAssignment, ExportDeclaration, ExportKeyword, ExportSpecifier, Expression, ExpressionStatement, ExpressionWithTypeArguments, ExternalModuleReference, FalseLiteral, ForInStatement, ForInitializer, ForOfStatement, ForStatement, FunctionBody, FunctionDeclaration, FunctionExpression, FunctionLikeDeclaration, FunctionTypeNode, GetAccessorDeclaration, HeritageClause, Identifier, IfStatement, ImportAttribute, ImportAttributeName, ImportAttributes, ImportClause, ImportClauseOrBindingPattern, ImportDeclaration, ImportEqualsDeclaration, ImportExpression, ImportPhaseModifierSyntaxKind, ImportSpecifier, ImportTypeNode, InKeyword, IndexSignatureDeclaration, IndexedAccessTypeNode, InferTypeNode, InterfaceDeclaration, IntersectionTypeNode, JSDoc, JSDocAllType, JSDocAugmentsTag, JSDocCallbackTag, JSDocComment, JSDocDeprecatedTag, JSDocFullName, JSDocImplementsTag, JSDocImportTag, JSDocLink, JSDocLinkCode, JSDocLinkPlain, JSDocNameReference, JSDocNonNullableType, JSDocNullableType, JSDocOptionalType, JSDocOverloadTag, JSDocOverrideTag, JSDocParameterTag, JSDocPrivateTag, JSDocPropertyTag, JSDocProtectedTag, JSDocPublicTag, JSDocReadonlyTag, JSDocReturnTag, JSDocSatisfiesTag, JSDocSeeTag, JSDocSignature, JSDocTemplateTag, JSDocText, JSDocThisTag, JSDocThrowsTag, JSDocTypeExpression, JSDocTypeLiteral, JSDocTypeTag, JSDocTypedefTag, JSDocUnknownTag, JSDocVariadicType, JsxAttribute, JsxAttributeLike, JsxAttributeName, JsxAttributeValue, JsxAttributes, JsxChild, JsxClosingElement, JsxClosingFragment, JsxElement, JsxExpression, JsxFragment, JsxNamespacedName, JsxOpeningElement, JsxOpeningFragment, JsxOpeningLikeElement, JsxSelfClosingElement, JsxSpreadAttribute, JsxTagNameExpression, JsxText, JsxTokenSyntaxKind, KeywordExpression, KeywordExpressionSyntaxKind, KeywordTypeNode, KeywordTypeSyntaxKind, LabeledStatement, LeftHandSideExpression, LiteralExpression, LiteralLikeNode, LiteralToken, LiteralTypeNode, LogicalOperator, LogicalOperatorOrHigher, LogicalOrCoalescingAssignmentOperator, MappedTypeNode, MemberName, MetaProperty, MethodDeclaration, MethodSignatureDeclaration, MinusToken, MissingDeclaration, Modifier, ModifierLike, ModifierSyntaxKind, ModuleBlock, ModuleBody, ModuleDeclaration, ModuleExportName, ModuleName, ModuleReference, MultiplicativeOperator, MultiplicativeOperatorOrHigher, NamedExportBindings, NamedExports, NamedImportBindings, NamedImports, NamedImportsOrExports, NamedTupleMember, NamespaceExport, NamespaceExportDeclaration, NamespaceImport, NewExpression, NoSubstitutionTemplateLiteral, Node, NonNullExpression, NotEmittedStatement, NotEmittedTypeElement, NullLiteral, NumericLiteral, NumericOrStringLikeLiteral, ObjectBindingPattern, ObjectDestructuringAssignment, ObjectLiteralElementLike, ObjectLiteralExpression, ObjectLiteralLikeNode, ObjectTypeDeclaration, OmittedExpression, OptionalTypeNode, OutKeyword, OverrideKeyword, ParameterDeclaration, ParenthesizedExpression, ParenthesizedTypeNode, PartiallyEmittedExpression, PlusToken, PostfixUnaryExpression, PostfixUnaryOperator, PrefixUnaryExpression, PrefixUnaryOperator, PrivateIdentifier, PrivateKeyword, PropertyAccessExpression, PropertyAssignment, PropertyDeclaration, PropertyName, PropertyNameLiteral, PropertySignatureDeclaration, ProtectedKeyword, PseudoLiteralSyntaxKind, PseudoLiteralToken, PublicKeyword, QualifiedName, QuestionDotToken, QuestionToken, ReadonlyKeyword, RegularExpressionLiteral, RelationalOperator, RelationalOperatorOrHigher, RestTypeNode, ReturnStatement, SatisfiesExpression, SemicolonClassElement, SetAccessorDeclaration, ShiftOperator, ShiftOperatorOrHigher, ShorthandPropertyAssignment, SignatureDeclaration, SourceFile, SpreadAssignment, SpreadElement, Statement, StaticKeyword, StringLiteral, StringLiteralLikeNode, SuperExpression, SwitchStatement, SyntaxList, SyntheticExpression, SyntheticReferenceExpression, TaggedTemplateExpression, TemplateExpression, TemplateHead, TemplateLiteral, TemplateLiteralLikeNode, TemplateLiteralToken, TemplateLiteralTypeNode, TemplateLiteralTypeSpan, TemplateMiddle, TemplateMiddleOrTail, TemplateSpan, TemplateTail, ThisExpression, ThisTypeNode, ThrowStatement, Token, TriviaSyntaxKind, TrueLiteral, TryStatement, TupleTypeNode, TypeAliasDeclaration, TypeAssertion, TypeLiteralNode, TypeNode, TypeOfExpression, TypeOperatorNode, TypeParameterDeclaration, TypePredicateNode, TypePredicateParameterName, TypeQueryNode, TypeReferenceNode, UnaryExpressionBase, UnionOrIntersectionTypeNode, UnionTypeNode, VariableDeclaration, VariableDeclarationList, VariableOrParameterDeclaration, VariableOrPropertyDeclaration, VariableStatement, VoidExpression, WhileStatement, WithStatement, YieldExpression } from "./ast-types.js";
import { SyntaxKind, NodeFlags, ScriptKind, OuterExpressionKinds } from "./enums.js";
import { getSourceFileOfNode } from "./node-functions.js";

export function isToken(node: Node | undefined): node is Token {
    if (node === undefined) return false;
    return isTokenKind(node.kind);
}

export function isIdentifier(node: Node | undefined): node is Identifier {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier;
}

export function isPrivateIdentifier(node: Node | undefined): node is PrivateIdentifier {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PrivateIdentifier;
}

export function isQualifiedName(node: Node | undefined): node is QualifiedName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.QualifiedName;
}

export function isComputedPropertyName(node: Node | undefined): node is ComputedPropertyName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ComputedPropertyName;
}

export function isDecorator(node: Node | undefined): node is Decorator {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Decorator;
}

export function isEmptyStatement(node: Node | undefined): node is EmptyStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.EmptyStatement;
}

export function isIfStatement(node: Node | undefined): node is IfStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.IfStatement;
}

export function isDoStatement(node: Node | undefined): node is DoStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DoStatement;
}

export function isWhileStatement(node: Node | undefined): node is WhileStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.WhileStatement;
}

export function isForStatement(node: Node | undefined): node is ForStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ForStatement;
}

export function isBreakStatement(node: Node | undefined): node is BreakStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BreakStatement;
}

export function isContinueStatement(node: Node | undefined): node is ContinueStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ContinueStatement;
}

export function isReturnStatement(node: Node | undefined): node is ReturnStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ReturnStatement;
}

export function isWithStatement(node: Node | undefined): node is WithStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.WithStatement;
}

export function isSwitchStatement(node: Node | undefined): node is SwitchStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SwitchStatement;
}

export function isCaseBlock(node: Node | undefined): node is CaseBlock {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CaseBlock;
}

export function isThrowStatement(node: Node | undefined): node is ThrowStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ThrowStatement;
}

export function isTryStatement(node: Node | undefined): node is TryStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TryStatement;
}

export function isCatchClause(node: Node | undefined): node is CatchClause {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CatchClause;
}

export function isDebuggerStatement(node: Node | undefined): node is DebuggerStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DebuggerStatement;
}

export function isLabeledStatement(node: Node | undefined): node is LabeledStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.LabeledStatement;
}

export function isExpressionStatement(node: Node | undefined): node is ExpressionStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExpressionStatement;
}

export function isBlock(node: Node | undefined): node is Block {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Block;
}

export function isVariableStatement(node: Node | undefined): node is VariableStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VariableStatement;
}

export function isVariableDeclaration(node: Node | undefined): node is VariableDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VariableDeclaration;
}

export function isVariableDeclarationList(node: Node | undefined): node is VariableDeclarationList {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VariableDeclarationList;
}

export function isParameterDeclaration(node: Node | undefined): node is ParameterDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Parameter;
}

export function isBindingElement(node: Node | undefined): node is BindingElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BindingElement;
}

export function isMissingDeclaration(node: Node | undefined): node is MissingDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.MissingDeclaration;
}

export function isFunctionDeclaration(node: Node | undefined): node is FunctionDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.FunctionDeclaration;
}

export function isClassDeclaration(node: Node | undefined): node is ClassDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ClassDeclaration;
}

export function isClassExpression(node: Node | undefined): node is ClassExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ClassExpression;
}

export function isHeritageClause(node: Node | undefined): node is HeritageClause {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.HeritageClause;
}

export function isInterfaceDeclaration(node: Node | undefined): node is InterfaceDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.InterfaceDeclaration;
}

export function isTypeAliasDeclaration(node: Node | undefined): node is TypeAliasDeclaration {
    if (node === undefined) return false;
    switch (node.kind) {
        case SyntaxKind.TypeAliasDeclaration:
        case SyntaxKind.JSTypeAliasDeclaration:
            return true;
        default:
            return false;
    }
}

export function isEnumMember(node: Node | undefined): node is EnumMember {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.EnumMember;
}

export function isEnumDeclaration(node: Node | undefined): node is EnumDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.EnumDeclaration;
}

export function isModuleBlock(node: Node | undefined): node is ModuleBlock {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ModuleBlock;
}

export function isNotEmittedStatement(node: Node | undefined): node is NotEmittedStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NotEmittedStatement;
}

export function isNotEmittedTypeElement(node: Node | undefined): node is NotEmittedTypeElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NotEmittedTypeElement;
}

export function isImportDeclaration(node: Node | undefined): node is ImportDeclaration {
    if (node === undefined) return false;
    switch (node.kind) {
        case SyntaxKind.ImportDeclaration:
        case SyntaxKind.JSImportDeclaration:
            return true;
        default:
            return false;
    }
}

export function isExternalModuleReference(node: Node | undefined): node is ExternalModuleReference {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExternalModuleReference;
}

export function isNamespaceImport(node: Node | undefined): node is NamespaceImport {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamespaceImport;
}

export function isNamedImports(node: Node | undefined): node is NamedImports {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamedImports;
}

export function isExportAssignment(node: Node | undefined): node is ExportAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExportAssignment;
}

export function isNamespaceExportDeclaration(node: Node | undefined): node is NamespaceExportDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamespaceExportDeclaration;
}

export function isNamespaceExport(node: Node | undefined): node is NamespaceExport {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamespaceExport;
}

export function isNamedExports(node: Node | undefined): node is NamedExports {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamedExports;
}

export function isExportSpecifier(node: Node | undefined): node is ExportSpecifier {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExportSpecifier;
}

export function isCallSignatureDeclaration(node: Node | undefined): node is CallSignatureDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CallSignature;
}

export function isConstructSignatureDeclaration(node: Node | undefined): node is ConstructSignatureDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ConstructSignature;
}

export function isConstructorDeclaration(node: Node | undefined): node is ConstructorDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Constructor;
}

export function isGetAccessorDeclaration(node: Node | undefined): node is GetAccessorDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.GetAccessor;
}

export function isSetAccessorDeclaration(node: Node | undefined): node is SetAccessorDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SetAccessor;
}

export function isIndexSignatureDeclaration(node: Node | undefined): node is IndexSignatureDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.IndexSignature;
}

export function isMethodSignatureDeclaration(node: Node | undefined): node is MethodSignatureDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.MethodSignature;
}

export function isMethodDeclaration(node: Node | undefined): node is MethodDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.MethodDeclaration;
}

export function isPropertySignatureDeclaration(node: Node | undefined): node is PropertySignatureDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PropertySignature;
}

export function isPropertyDeclaration(node: Node | undefined): node is PropertyDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PropertyDeclaration;
}

export function isSemicolonClassElement(node: Node | undefined): node is SemicolonClassElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SemicolonClassElement;
}

export function isClassStaticBlockDeclaration(node: Node | undefined): node is ClassStaticBlockDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ClassStaticBlockDeclaration;
}

export function isOmittedExpression(node: Node | undefined): node is OmittedExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.OmittedExpression;
}

export function isKeywordExpression(node: Node | undefined): node is KeywordExpression {
    if (node === undefined) return false;
    return isKeywordExpressionKind(node.kind);
}

export function isStringLiteral(node: Node | undefined): node is StringLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.StringLiteral;
}

export function isNumericLiteral(node: Node | undefined): node is NumericLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NumericLiteral;
}

export function isBigIntLiteral(node: Node | undefined): node is BigIntLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BigIntLiteral;
}

export function isRegularExpressionLiteral(node: Node | undefined): node is RegularExpressionLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.RegularExpressionLiteral;
}

export function isNoSubstitutionTemplateLiteral(node: Node | undefined): node is NoSubstitutionTemplateLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

export function isBinaryExpression(node: Node | undefined): node is BinaryExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BinaryExpression;
}

export function isPrefixUnaryExpression(node: Node | undefined): node is PrefixUnaryExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PrefixUnaryExpression;
}

export function isPostfixUnaryExpression(node: Node | undefined): node is PostfixUnaryExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PostfixUnaryExpression;
}

export function isYieldExpression(node: Node | undefined): node is YieldExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.YieldExpression;
}

export function isArrowFunction(node: Node | undefined): node is ArrowFunction {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ArrowFunction;
}

export function isFunctionExpression(node: Node | undefined): node is FunctionExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.FunctionExpression;
}

export function isAsExpression(node: Node | undefined): node is AsExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AsExpression;
}

export function isSatisfiesExpression(node: Node | undefined): node is SatisfiesExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SatisfiesExpression;
}

export function isConditionalExpression(node: Node | undefined): node is ConditionalExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ConditionalExpression;
}

export function isPropertyAccessExpression(node: Node | undefined): node is PropertyAccessExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PropertyAccessExpression;
}

export function isElementAccessExpression(node: Node | undefined): node is ElementAccessExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ElementAccessExpression;
}

export function isCallExpression(node: Node | undefined): node is CallExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CallExpression;
}

export function isNewExpression(node: Node | undefined): node is NewExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NewExpression;
}

export function isMetaProperty(node: Node | undefined): node is MetaProperty {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.MetaProperty;
}

export function isNonNullExpression(node: Node | undefined): node is NonNullExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NonNullExpression;
}

export function isSpreadElement(node: Node | undefined): node is SpreadElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SpreadElement;
}

export function isTemplateExpression(node: Node | undefined): node is TemplateExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateExpression;
}

export function isTemplateSpan(node: Node | undefined): node is TemplateSpan {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateSpan;
}

export function isTaggedTemplateExpression(node: Node | undefined): node is TaggedTemplateExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TaggedTemplateExpression;
}

export function isParenthesizedExpression(node: Node | undefined): node is ParenthesizedExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ParenthesizedExpression;
}

export function isArrayLiteralExpression(node: Node | undefined): node is ArrayLiteralExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ArrayLiteralExpression;
}

export function isObjectLiteralExpression(node: Node | undefined): node is ObjectLiteralExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ObjectLiteralExpression;
}

export function isSpreadAssignment(node: Node | undefined): node is SpreadAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SpreadAssignment;
}

export function isPropertyAssignment(node: Node | undefined): node is PropertyAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PropertyAssignment;
}

export function isShorthandPropertyAssignment(node: Node | undefined): node is ShorthandPropertyAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ShorthandPropertyAssignment;
}

export function isDeleteExpression(node: Node | undefined): node is DeleteExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DeleteExpression;
}

export function isTypeOfExpression(node: Node | undefined): node is TypeOfExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeOfExpression;
}

export function isVoidExpression(node: Node | undefined): node is VoidExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VoidExpression;
}

export function isAwaitExpression(node: Node | undefined): node is AwaitExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AwaitExpression;
}

export function isTypeAssertion(node: Node | undefined): node is TypeAssertion {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeAssertionExpression;
}

export function isKeywordTypeNode(node: Node | undefined): node is KeywordTypeNode {
    if (node === undefined) return false;
    return isKeywordTypeKind(node.kind);
}

export function isUnionTypeNode(node: Node | undefined): node is UnionTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.UnionType;
}

export function isIntersectionTypeNode(node: Node | undefined): node is IntersectionTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.IntersectionType;
}

export function isConditionalTypeNode(node: Node | undefined): node is ConditionalTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ConditionalType;
}

export function isTypeOperatorNode(node: Node | undefined): node is TypeOperatorNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeOperator;
}

export function isInferTypeNode(node: Node | undefined): node is InferTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.InferType;
}

export function isArrayTypeNode(node: Node | undefined): node is ArrayTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ArrayType;
}

export function isIndexedAccessTypeNode(node: Node | undefined): node is IndexedAccessTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.IndexedAccessType;
}

export function isTypeReferenceNode(node: Node | undefined): node is TypeReferenceNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeReference;
}

export function isExpressionWithTypeArguments(node: Node | undefined): node is ExpressionWithTypeArguments {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExpressionWithTypeArguments;
}

export function isLiteralTypeNode(node: Node | undefined): node is LiteralTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.LiteralType;
}

export function isThisTypeNode(node: Node | undefined): node is ThisTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ThisType;
}

export function isTypePredicateNode(node: Node | undefined): node is TypePredicateNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypePredicate;
}

export function isImportAttribute(node: Node | undefined): node is ImportAttribute {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportAttribute;
}

export function isImportAttributes(node: Node | undefined): node is ImportAttributes {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportAttributes;
}

export function isTypeQueryNode(node: Node | undefined): node is TypeQueryNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeQuery;
}

export function isMappedTypeNode(node: Node | undefined): node is MappedTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.MappedType;
}

export function isTypeLiteralNode(node: Node | undefined): node is TypeLiteralNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeLiteral;
}

export function isTupleTypeNode(node: Node | undefined): node is TupleTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TupleType;
}

export function isNamedTupleMember(node: Node | undefined): node is NamedTupleMember {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamedTupleMember;
}

export function isOptionalTypeNode(node: Node | undefined): node is OptionalTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.OptionalType;
}

export function isRestTypeNode(node: Node | undefined): node is RestTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.RestType;
}

export function isParenthesizedTypeNode(node: Node | undefined): node is ParenthesizedTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ParenthesizedType;
}

export function isFunctionTypeNode(node: Node | undefined): node is FunctionTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.FunctionType;
}

export function isConstructorTypeNode(node: Node | undefined): node is ConstructorTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ConstructorType;
}

export function isTemplateHead(node: Node | undefined): node is TemplateHead {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateHead;
}

export function isTemplateMiddle(node: Node | undefined): node is TemplateMiddle {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateMiddle;
}

export function isTemplateTail(node: Node | undefined): node is TemplateTail {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateTail;
}

export function isTemplateLiteralTypeNode(node: Node | undefined): node is TemplateLiteralTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateLiteralType;
}

export function isTemplateLiteralTypeSpan(node: Node | undefined): node is TemplateLiteralTypeSpan {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateLiteralTypeSpan;
}

export function isSyntheticExpression(node: Node | undefined): node is SyntheticExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SyntheticExpression;
}

export function isPartiallyEmittedExpression(node: Node | undefined): node is PartiallyEmittedExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PartiallyEmittedExpression;
}

export function isJsxElement(node: Node | undefined): node is JsxElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxElement;
}

export function isJsxAttributes(node: Node | undefined): node is JsxAttributes {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxAttributes;
}

export function isJsxNamespacedName(node: Node | undefined): node is JsxNamespacedName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxNamespacedName;
}

export function isJsxOpeningElement(node: Node | undefined): node is JsxOpeningElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxOpeningElement;
}

export function isJsxSelfClosingElement(node: Node | undefined): node is JsxSelfClosingElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxSelfClosingElement;
}

export function isJsxFragment(node: Node | undefined): node is JsxFragment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxFragment;
}

export function isJsxOpeningFragment(node: Node | undefined): node is JsxOpeningFragment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxOpeningFragment;
}

export function isJsxClosingFragment(node: Node | undefined): node is JsxClosingFragment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxClosingFragment;
}

export function isJsxAttribute(node: Node | undefined): node is JsxAttribute {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxAttribute;
}

export function isJsxSpreadAttribute(node: Node | undefined): node is JsxSpreadAttribute {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxSpreadAttribute;
}

export function isJsxClosingElement(node: Node | undefined): node is JsxClosingElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxClosingElement;
}

export function isJsxExpression(node: Node | undefined): node is JsxExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxExpression;
}

export function isJsxText(node: Node | undefined): node is JsxText {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxText;
}

export function isSyntaxList(node: Node | undefined): node is SyntaxList {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SyntaxList;
}

export function isJSDoc(node: Node | undefined): node is JSDoc {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDoc;
}

export function isJSDocTypeExpression(node: Node | undefined): node is JSDocTypeExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocTypeExpression;
}

export function isJSDocNonNullableType(node: Node | undefined): node is JSDocNonNullableType {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocNonNullableType;
}

export function isJSDocNullableType(node: Node | undefined): node is JSDocNullableType {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocNullableType;
}

export function isJSDocAllType(node: Node | undefined): node is JSDocAllType {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocAllType;
}

export function isJSDocVariadicType(node: Node | undefined): node is JSDocVariadicType {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocVariadicType;
}

export function isJSDocOptionalType(node: Node | undefined): node is JSDocOptionalType {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocOptionalType;
}

export function isJSDocTypeTag(node: Node | undefined): node is JSDocTypeTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocTypeTag;
}

export function isJSDocUnknownTag(node: Node | undefined): node is JSDocUnknownTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocUnknownTag;
}

export function isJSDocTemplateTag(node: Node | undefined): node is JSDocTemplateTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocTemplateTag;
}

export function isJSDocReturnTag(node: Node | undefined): node is JSDocReturnTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocReturnTag;
}

export function isJSDocPublicTag(node: Node | undefined): node is JSDocPublicTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocPublicTag;
}

export function isJSDocPrivateTag(node: Node | undefined): node is JSDocPrivateTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocPrivateTag;
}

export function isJSDocProtectedTag(node: Node | undefined): node is JSDocProtectedTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocProtectedTag;
}

export function isJSDocReadonlyTag(node: Node | undefined): node is JSDocReadonlyTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocReadonlyTag;
}

export function isJSDocOverrideTag(node: Node | undefined): node is JSDocOverrideTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocOverrideTag;
}

export function isJSDocDeprecatedTag(node: Node | undefined): node is JSDocDeprecatedTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocDeprecatedTag;
}

export function isJSDocSeeTag(node: Node | undefined): node is JSDocSeeTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocSeeTag;
}

export function isJSDocImplementsTag(node: Node | undefined): node is JSDocImplementsTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocImplementsTag;
}

export function isJSDocAugmentsTag(node: Node | undefined): node is JSDocAugmentsTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocAugmentsTag;
}

export function isJSDocSatisfiesTag(node: Node | undefined): node is JSDocSatisfiesTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocSatisfiesTag;
}

export function isJSDocThrowsTag(node: Node | undefined): node is JSDocThrowsTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocThrowsTag;
}

export function isJSDocThisTag(node: Node | undefined): node is JSDocThisTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocThisTag;
}

export function isJSDocImportTag(node: Node | undefined): node is JSDocImportTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocImportTag;
}

export function isJSDocCallbackTag(node: Node | undefined): node is JSDocCallbackTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocCallbackTag;
}

export function isJSDocOverloadTag(node: Node | undefined): node is JSDocOverloadTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocOverloadTag;
}

export function isJSDocTypedefTag(node: Node | undefined): node is JSDocTypedefTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocTypedefTag;
}

export function isJSDocSignature(node: Node | undefined): node is JSDocSignature {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocSignature;
}

export function isJSDocNameReference(node: Node | undefined): node is JSDocNameReference {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocNameReference;
}

export function isSourceFile(node: Node | undefined): node is SourceFile {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SourceFile;
}

export function isModuleDeclaration(node: Node | undefined): node is ModuleDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ModuleDeclaration;
}

export function isImportEqualsDeclaration(node: Node | undefined): node is ImportEqualsDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportEqualsDeclaration;
}

export function isExportDeclaration(node: Node | undefined): node is ExportDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExportDeclaration;
}

export function isImportTypeNode(node: Node | undefined): node is ImportTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportType;
}

export function isImportClause(node: Node | undefined): node is ImportClause {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportClause;
}

export function isImportSpecifier(node: Node | undefined): node is ImportSpecifier {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportSpecifier;
}

export function isJSDocText(node: Node | undefined): node is JSDocText {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocText;
}

export function isJSDocLink(node: Node | undefined): node is JSDocLink {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocLink;
}

export function isJSDocLinkPlain(node: Node | undefined): node is JSDocLinkPlain {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocLinkPlain;
}

export function isJSDocLinkCode(node: Node | undefined): node is JSDocLinkCode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocLinkCode;
}

export function isTypeParameterDeclaration(node: Node | undefined): node is TypeParameterDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeParameter;
}

export function isSyntheticReferenceExpression(node: Node | undefined): node is SyntheticReferenceExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SyntheticReferenceExpression;
}

export function isJSDocTypeLiteral(node: Node | undefined): node is JSDocTypeLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocTypeLiteral;
}

export function isForInStatement(node: Node | undefined): node is ForInStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ForInStatement;
}

export function isForOfStatement(node: Node | undefined): node is ForOfStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ForOfStatement;
}

export function isCaseClause(node: Node | undefined): node is CaseClause {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CaseClause;
}

export function isDefaultClause(node: Node | undefined): node is DefaultClause {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DefaultClause;
}

export function isObjectBindingPattern(node: Node | undefined): node is ObjectBindingPattern {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ObjectBindingPattern;
}

export function isArrayBindingPattern(node: Node | undefined): node is ArrayBindingPattern {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ArrayBindingPattern;
}

export function isJSDocParameterTag(node: Node | undefined): node is JSDocParameterTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocParameterTag;
}

export function isJSDocPropertyTag(node: Node | undefined): node is JSDocPropertyTag {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocPropertyTag;
}

export function isAccessExpression(node: Node | undefined): node is AccessExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PropertyAccessExpression || node.kind === SyntaxKind.ElementAccessExpression;
}

export function isDeclarationName(node: Node | undefined): node is DeclarationName {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.Identifier || kind === SyntaxKind.PrivateIdentifier || kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.BigIntLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral || kind === SyntaxKind.ComputedPropertyName || kind === SyntaxKind.ObjectBindingPattern || kind === SyntaxKind.ArrayBindingPattern || kind === SyntaxKind.ElementAccessExpression;
}

export function isModuleName(node: Node | undefined): node is ModuleName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.StringLiteral;
}

export function isModuleExportName(node: Node | undefined): node is ModuleExportName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.StringLiteral;
}

export function isPropertyName(node: Node | undefined): node is PropertyName {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.Identifier || kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral || kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.ComputedPropertyName || kind === SyntaxKind.PrivateIdentifier || kind === SyntaxKind.BigIntLiteral;
}

export function isModuleBody(node: Node | undefined): node is ModuleBody {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ModuleBlock || node.kind === SyntaxKind.ModuleDeclaration;
}

export function isJSDocFullName(node: Node | undefined): node is JSDocFullName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.ModuleDeclaration;
}

export function isModuleReference(node: Node | undefined): node is ModuleReference {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName || node.kind === SyntaxKind.ExternalModuleReference;
}

export function isNamedImportBindings(node: Node | undefined): node is NamedImportBindings {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamespaceImport || node.kind === SyntaxKind.NamedImports;
}

export function isNamedExportBindings(node: Node | undefined): node is NamedExportBindings {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamespaceExport || node.kind === SyntaxKind.NamedExports;
}

export function isMemberName(node: Node | undefined): node is MemberName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier;
}

export function isEntityName(node: Node | undefined): node is EntityName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName;
}

export function isBindingName(node: Node | undefined): node is BindingName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern;
}

export function isModifierLike(node: Node | undefined): node is ModifierLike {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.AbstractKeyword || kind === SyntaxKind.AccessorKeyword || kind === SyntaxKind.AsyncKeyword || kind === SyntaxKind.ConstKeyword || kind === SyntaxKind.DeclareKeyword || kind === SyntaxKind.DefaultKeyword || kind === SyntaxKind.ExportKeyword || kind === SyntaxKind.InKeyword || kind === SyntaxKind.PrivateKeyword || kind === SyntaxKind.ProtectedKeyword || kind === SyntaxKind.PublicKeyword || kind === SyntaxKind.ReadonlyKeyword || kind === SyntaxKind.OutKeyword || kind === SyntaxKind.OverrideKeyword || kind === SyntaxKind.StaticKeyword || kind === SyntaxKind.Decorator;
}

export function isJsxChild(node: Node | undefined): node is JsxChild {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.JsxText || kind === SyntaxKind.JsxExpression || kind === SyntaxKind.JsxElement || kind === SyntaxKind.JsxSelfClosingElement || kind === SyntaxKind.JsxFragment;
}

export function isJsxAttributeLike(node: Node | undefined): node is JsxAttributeLike {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxAttribute || node.kind === SyntaxKind.JsxSpreadAttribute;
}

export function isJsxAttributeName(node: Node | undefined): node is JsxAttributeName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.JsxNamespacedName;
}

export function isJsxAttributeValue(node: Node | undefined): node is JsxAttributeValue {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.StringLiteral || kind === SyntaxKind.JsxExpression || kind === SyntaxKind.JsxElement || kind === SyntaxKind.JsxSelfClosingElement || kind === SyntaxKind.JsxFragment;
}

export function isClassLikeDeclaration(node: Node | undefined): node is ClassLikeDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.ClassExpression;
}

export function isAccessorDeclaration(node: Node | undefined): node is AccessorDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor;
}

export function isLiteralLikeNode(node: Node | undefined): node is LiteralLikeNode {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.BigIntLiteral || kind === SyntaxKind.RegularExpressionLiteral || kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle || kind === SyntaxKind.TemplateTail || kind === SyntaxKind.JsxText;
}

export function isLiteralExpression(node: Node | undefined): node is LiteralExpression {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.BigIntLiteral || kind === SyntaxKind.RegularExpressionLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

export function isUnionOrIntersectionTypeNode(node: Node | undefined): node is UnionOrIntersectionTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.UnionType || node.kind === SyntaxKind.IntersectionType;
}

export function isTemplateLiteralLikeNode(node: Node | undefined): node is TemplateLiteralLikeNode {
    if (node === undefined) return false;
    const kind = node.kind;
    return isPseudoLiteralKind(kind);
}

export function isTemplateMiddleOrTail(node: Node | undefined): node is TemplateMiddleOrTail {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateMiddle || node.kind === SyntaxKind.TemplateTail;
}

export function isTemplateLiteral(node: Node | undefined): node is TemplateLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateExpression || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

export function isTypePredicateParameterName(node: Node | undefined): node is TypePredicateParameterName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.ThisType;
}

export function isImportAttributeName(node: Node | undefined): node is ImportAttributeName {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.StringLiteral;
}

export function isJSDocComment(node: Node | undefined): node is JSDocComment {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.JSDocText || kind === SyntaxKind.JSDocLink || kind === SyntaxKind.JSDocLinkCode || kind === SyntaxKind.JSDocLinkPlain;
}

export function isSignatureDeclaration(node: Node | undefined): node is SignatureDeclaration {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.CallSignature || kind === SyntaxKind.ConstructSignature || kind === SyntaxKind.MethodSignature || kind === SyntaxKind.IndexSignature || kind === SyntaxKind.FunctionType || kind === SyntaxKind.ConstructorType || kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.MethodDeclaration || kind === SyntaxKind.Constructor || kind === SyntaxKind.GetAccessor || kind === SyntaxKind.SetAccessor || kind === SyntaxKind.FunctionExpression || kind === SyntaxKind.ArrowFunction;
}

export function isStringLiteralLikeNode(node: Node | undefined): node is StringLiteralLikeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

export function isNumericOrStringLikeLiteral(node: Node | undefined): node is NumericOrStringLikeLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral || node.kind === SyntaxKind.NumericLiteral;
}

export function isObjectLiteralLikeNode(node: Node | undefined): node is ObjectLiteralLikeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ObjectLiteralExpression || node.kind === SyntaxKind.ObjectBindingPattern;
}

export function isObjectTypeDeclaration(node: Node | undefined): node is ObjectTypeDeclaration {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.ClassDeclaration || kind === SyntaxKind.ClassExpression || kind === SyntaxKind.InterfaceDeclaration || kind === SyntaxKind.TypeLiteral;
}

export function isJsxOpeningLikeElement(node: Node | undefined): node is JsxOpeningLikeElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JsxOpeningElement || node.kind === SyntaxKind.JsxSelfClosingElement;
}

export function isNamedImportsOrExports(node: Node | undefined): node is NamedImportsOrExports {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NamedImports || node.kind === SyntaxKind.NamedExports;
}

export function isBreakOrContinueStatement(node: Node | undefined): node is BreakOrContinueStatement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BreakStatement || node.kind === SyntaxKind.ContinueStatement;
}

export function isCallLikeExpression(node: Node | undefined): node is CallLikeExpression {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.CallExpression || kind === SyntaxKind.NewExpression || kind === SyntaxKind.TaggedTemplateExpression || kind === SyntaxKind.Decorator || kind === SyntaxKind.JsxOpeningElement || kind === SyntaxKind.JsxSelfClosingElement || kind === SyntaxKind.BinaryExpression;
}

export function isFunctionLikeDeclaration(node: Node | undefined): node is FunctionLikeDeclaration {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.MethodDeclaration || kind === SyntaxKind.GetAccessor || kind === SyntaxKind.SetAccessor || kind === SyntaxKind.Constructor || kind === SyntaxKind.FunctionExpression || kind === SyntaxKind.ArrowFunction;
}

export function isVariableOrParameterDeclaration(node: Node | undefined): node is VariableOrParameterDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.Parameter;
}

export function isVariableOrPropertyDeclaration(node: Node | undefined): node is VariableOrPropertyDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.PropertyDeclaration;
}

export function isCallOrNewExpression(node: Node | undefined): node is CallOrNewExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.NewExpression;
}

export function isImportClauseOrBindingPattern(node: Node | undefined): node is ImportClauseOrBindingPattern {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportClause || node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern;
}

export function isAnyImportSyntax(node: Node | undefined): node is AnyImportSyntax {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.JSImportDeclaration || node.kind === SyntaxKind.ImportEqualsDeclaration;
}

export function isArrayBindingElement(node: Node | undefined): node is ArrayBindingElement {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BindingElement || node.kind === SyntaxKind.OmittedExpression;
}

export function isAssertionExpression(node: Node | undefined): node is AssertionExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TypeAssertionExpression || node.kind === SyntaxKind.AsExpression;
}

export function isBooleanLiteral(node: Node | undefined): node is BooleanLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword;
}

export function isDestructuringAssignment(node: Node | undefined): node is DestructuringAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BinaryExpression;
}

export function isLiteralToken(node: Node | undefined): node is LiteralToken {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.BigIntLiteral || kind === SyntaxKind.StringLiteral || kind === SyntaxKind.JsxText || kind === SyntaxKind.RegularExpressionLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

export function isModifier(node: Node | undefined): node is Modifier {
    if (node === undefined) return false;
    const kind = node.kind;
    return isModifierKind(kind);
}

export function isObjectLiteralElementLike(node: Node | undefined): node is ObjectLiteralElementLike {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.PropertyAssignment || kind === SyntaxKind.ShorthandPropertyAssignment || kind === SyntaxKind.SpreadAssignment || kind === SyntaxKind.MethodDeclaration || kind === SyntaxKind.GetAccessor || kind === SyntaxKind.SetAccessor;
}

export function isPropertyNameLiteral(node: Node | undefined): node is PropertyNameLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NumericLiteral;
}

export function isPseudoLiteralToken(node: Node | undefined): node is PseudoLiteralToken {
    if (node === undefined) return false;
    const kind = node.kind;
    return isPseudoLiteralKind(kind);
}

export function isTemplateLiteralToken(node: Node | undefined): node is TemplateLiteralToken {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.NoSubstitutionTemplateLiteral || kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle || kind === SyntaxKind.TemplateTail;
}

export function isArrayDestructuringAssignment(node: Node | undefined): node is ArrayDestructuringAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BinaryExpression;
}

export function isObjectDestructuringAssignment(node: Node | undefined): node is ObjectDestructuringAssignment {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.BinaryExpression;
}

export function isFunctionBody(node: Node | undefined): node is FunctionBody {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Block;
}

export function isTriviaKind(kind: SyntaxKind): kind is TriviaSyntaxKind {
    return kind === SyntaxKind.SingleLineCommentTrivia
        || kind === SyntaxKind.MultiLineCommentTrivia
        || kind === SyntaxKind.NewLineTrivia
        || kind === SyntaxKind.WhitespaceTrivia
        || kind === SyntaxKind.ConflictMarkerTrivia;
}

export function isPseudoLiteralKind(kind: SyntaxKind): kind is PseudoLiteralSyntaxKind {
    return kind === SyntaxKind.TemplateHead
        || kind === SyntaxKind.TemplateMiddle
        || kind === SyntaxKind.TemplateTail;
}

export function isModifierKind(kind: SyntaxKind): kind is ModifierSyntaxKind {
    return kind === SyntaxKind.AbstractKeyword
        || kind === SyntaxKind.AccessorKeyword
        || kind === SyntaxKind.AsyncKeyword
        || kind === SyntaxKind.ConstKeyword
        || kind === SyntaxKind.DeclareKeyword
        || kind === SyntaxKind.DefaultKeyword
        || kind === SyntaxKind.ExportKeyword
        || kind === SyntaxKind.InKeyword
        || kind === SyntaxKind.PrivateKeyword
        || kind === SyntaxKind.ProtectedKeyword
        || kind === SyntaxKind.PublicKeyword
        || kind === SyntaxKind.ReadonlyKeyword
        || kind === SyntaxKind.OutKeyword
        || kind === SyntaxKind.OverrideKeyword
        || kind === SyntaxKind.StaticKeyword;
}

export function isKeywordTypeKind(kind: SyntaxKind): kind is KeywordTypeSyntaxKind {
    return kind === SyntaxKind.AnyKeyword
        || kind === SyntaxKind.BigIntKeyword
        || kind === SyntaxKind.BooleanKeyword
        || kind === SyntaxKind.IntrinsicKeyword
        || kind === SyntaxKind.NeverKeyword
        || kind === SyntaxKind.NumberKeyword
        || kind === SyntaxKind.ObjectKeyword
        || kind === SyntaxKind.StringKeyword
        || kind === SyntaxKind.SymbolKeyword
        || kind === SyntaxKind.UndefinedKeyword
        || kind === SyntaxKind.UnknownKeyword
        || kind === SyntaxKind.VoidKeyword;
}

export function isKeywordExpressionKind(kind: SyntaxKind): kind is KeywordExpressionSyntaxKind {
    return kind === SyntaxKind.NullKeyword
        || kind === SyntaxKind.TrueKeyword
        || kind === SyntaxKind.FalseKeyword
        || kind === SyntaxKind.ThisKeyword
        || kind === SyntaxKind.SuperKeyword
        || kind === SyntaxKind.ImportKeyword;
}

export function isJsxTokenKind(kind: SyntaxKind): kind is JsxTokenSyntaxKind {
    return kind === SyntaxKind.LessThanSlashToken
        || kind === SyntaxKind.EndOfFile
        || kind === SyntaxKind.ConflictMarkerTrivia
        || kind === SyntaxKind.JsxText
        || kind === SyntaxKind.JsxTextAllWhiteSpaces
        || kind === SyntaxKind.OpenBraceToken
        || kind === SyntaxKind.LessThanToken;
}

export function isImportPhaseModifierKind(kind: SyntaxKind): kind is ImportPhaseModifierSyntaxKind {
    return kind === SyntaxKind.TypeKeyword
        || kind === SyntaxKind.DeferKeyword;
}

export function isPostfixUnaryOperator(kind: SyntaxKind): kind is PostfixUnaryOperator {
    return kind === SyntaxKind.PlusPlusToken
        || kind === SyntaxKind.MinusMinusToken;
}

export function isPrefixUnaryOperator(kind: SyntaxKind): kind is PrefixUnaryOperator {
    return kind === SyntaxKind.PlusToken
        || kind === SyntaxKind.MinusToken
        || kind === SyntaxKind.TildeToken
        || kind === SyntaxKind.ExclamationToken
        || kind === SyntaxKind.PlusPlusToken
        || kind === SyntaxKind.MinusMinusToken;
}

export function isAssignmentOperator(kind: SyntaxKind): kind is AssignmentOperator {
    return kind === SyntaxKind.EqualsToken
        || isCompoundAssignmentOperator(kind);
}

export function isBinaryOperator(kind: SyntaxKind): kind is BinaryOperator {
    return isAssignmentOperatorOrHigher(kind)
        || kind === SyntaxKind.CommaToken;
}

export function isExponentiationOperator(kind: SyntaxKind): kind is ExponentiationOperator {
    return kind === SyntaxKind.AsteriskAsteriskToken;
}

export function isMultiplicativeOperator(kind: SyntaxKind): kind is MultiplicativeOperator {
    return kind === SyntaxKind.AsteriskToken
        || kind === SyntaxKind.SlashToken
        || kind === SyntaxKind.PercentToken;
}

export function isMultiplicativeOperatorOrHigher(kind: SyntaxKind): kind is MultiplicativeOperatorOrHigher {
    return isExponentiationOperator(kind)
        || isMultiplicativeOperator(kind);
}

export function isAdditiveOperator(kind: SyntaxKind): kind is AdditiveOperator {
    return kind === SyntaxKind.PlusToken
        || kind === SyntaxKind.MinusToken;
}

export function isAdditiveOperatorOrHigher(kind: SyntaxKind): kind is AdditiveOperatorOrHigher {
    return isMultiplicativeOperatorOrHigher(kind)
        || isAdditiveOperator(kind);
}

export function isShiftOperator(kind: SyntaxKind): kind is ShiftOperator {
    return kind === SyntaxKind.LessThanLessThanToken
        || kind === SyntaxKind.GreaterThanGreaterThanToken
        || kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
}

export function isShiftOperatorOrHigher(kind: SyntaxKind): kind is ShiftOperatorOrHigher {
    return isAdditiveOperatorOrHigher(kind)
        || isShiftOperator(kind);
}

export function isRelationalOperator(kind: SyntaxKind): kind is RelationalOperator {
    return kind === SyntaxKind.LessThanToken
        || kind === SyntaxKind.LessThanEqualsToken
        || kind === SyntaxKind.GreaterThanToken
        || kind === SyntaxKind.GreaterThanEqualsToken
        || kind === SyntaxKind.InstanceOfKeyword
        || kind === SyntaxKind.InKeyword;
}

export function isRelationalOperatorOrHigher(kind: SyntaxKind): kind is RelationalOperatorOrHigher {
    return isShiftOperatorOrHigher(kind)
        || isRelationalOperator(kind);
}

export function isEqualityOperator(kind: SyntaxKind): kind is EqualityOperator {
    return kind === SyntaxKind.EqualsEqualsToken
        || kind === SyntaxKind.EqualsEqualsEqualsToken
        || kind === SyntaxKind.ExclamationEqualsEqualsToken
        || kind === SyntaxKind.ExclamationEqualsToken;
}

export function isEqualityOperatorOrHigher(kind: SyntaxKind): kind is EqualityOperatorOrHigher {
    return isRelationalOperatorOrHigher(kind)
        || isEqualityOperator(kind);
}

export function isBitwiseOperator(kind: SyntaxKind): kind is BitwiseOperator {
    return kind === SyntaxKind.AmpersandToken
        || kind === SyntaxKind.BarToken
        || kind === SyntaxKind.CaretToken;
}

export function isBitwiseOperatorOrHigher(kind: SyntaxKind): kind is BitwiseOperatorOrHigher {
    return isEqualityOperatorOrHigher(kind)
        || isBitwiseOperator(kind);
}

export function isLogicalOperator(kind: SyntaxKind): kind is LogicalOperator {
    return kind === SyntaxKind.AmpersandAmpersandToken
        || kind === SyntaxKind.BarBarToken;
}

export function isLogicalOperatorOrHigher(kind: SyntaxKind): kind is LogicalOperatorOrHigher {
    return isBitwiseOperatorOrHigher(kind)
        || isLogicalOperator(kind);
}

export function isCompoundAssignmentOperator(kind: SyntaxKind): kind is CompoundAssignmentOperator {
    return kind === SyntaxKind.PlusEqualsToken
        || kind === SyntaxKind.MinusEqualsToken
        || kind === SyntaxKind.AsteriskAsteriskEqualsToken
        || kind === SyntaxKind.AsteriskEqualsToken
        || kind === SyntaxKind.SlashEqualsToken
        || kind === SyntaxKind.PercentEqualsToken
        || kind === SyntaxKind.AmpersandEqualsToken
        || kind === SyntaxKind.BarEqualsToken
        || kind === SyntaxKind.CaretEqualsToken
        || kind === SyntaxKind.LessThanLessThanEqualsToken
        || kind === SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
        || kind === SyntaxKind.GreaterThanGreaterThanEqualsToken
        || kind === SyntaxKind.BarBarEqualsToken
        || kind === SyntaxKind.AmpersandAmpersandEqualsToken
        || kind === SyntaxKind.QuestionQuestionEqualsToken;
}

export function isAssignmentOperatorOrHigher(kind: SyntaxKind): kind is AssignmentOperatorOrHigher {
    return kind === SyntaxKind.QuestionQuestionToken
        || isLogicalOperatorOrHigher(kind)
        || isAssignmentOperator(kind);
}

export function isLogicalOrCoalescingAssignmentOperator(kind: SyntaxKind): kind is LogicalOrCoalescingAssignmentOperator {
    return kind === SyntaxKind.AmpersandAmpersandEqualsToken
        || kind === SyntaxKind.BarBarEqualsToken
        || kind === SyntaxKind.QuestionQuestionEqualsToken;
}

export function isLiteralKind(kind: SyntaxKind): boolean {
    return kind >= SyntaxKind.FirstLiteralToken && kind <= SyntaxKind.LastLiteralToken;
}

export function isPunctuationKind(kind: SyntaxKind): boolean {
    return kind >= SyntaxKind.FirstPunctuation && kind <= SyntaxKind.LastPunctuation;
}

export function isKeywordKind(kind: SyntaxKind): boolean {
    return kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword;
}

export function isTokenKind(kind: SyntaxKind): boolean {
    return kind >= SyntaxKind.FirstToken && kind <= SyntaxKind.LastToken;
}

export function isJSDocNodeKind(kind: SyntaxKind): boolean {
    return kind >= SyntaxKind.FirstJSDocNode && kind <= SyntaxKind.LastJSDocNode;
}

export function isEndOfFile(node: Node | undefined): node is EndOfFile {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.EndOfFile;
}

export function isDotToken(node: Node | undefined): node is DotToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DotToken;
}

export function isDotDotDotToken(node: Node | undefined): node is DotDotDotToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DotDotDotToken;
}

export function isQuestionToken(node: Node | undefined): node is QuestionToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.QuestionToken;
}

export function isExclamationToken(node: Node | undefined): node is ExclamationToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExclamationToken;
}

export function isColonToken(node: Node | undefined): node is ColonToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ColonToken;
}

export function isEqualsToken(node: Node | undefined): node is EqualsToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.EqualsToken;
}

export function isAsteriskToken(node: Node | undefined): node is AsteriskToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AsteriskToken;
}

export function isEqualsGreaterThanToken(node: Node | undefined): node is EqualsGreaterThanToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.EqualsGreaterThanToken;
}

export function isPlusToken(node: Node | undefined): node is PlusToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PlusToken;
}

export function isMinusToken(node: Node | undefined): node is MinusToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.MinusToken;
}

export function isQuestionDotToken(node: Node | undefined): node is QuestionDotToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.QuestionDotToken;
}

export function isAssertsKeyword(node: Node | undefined): node is AssertsKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AssertsKeyword;
}

export function isAssertKeyword(node: Node | undefined): node is AssertKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AssertKeyword;
}

export function isAwaitKeyword(node: Node | undefined): node is AwaitKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AwaitKeyword;
}

export function isCaseKeyword(node: Node | undefined): node is CaseKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.CaseKeyword;
}

export function isAbstractKeyword(node: Node | undefined): node is AbstractKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AbstractKeyword;
}

export function isAccessorKeyword(node: Node | undefined): node is AccessorKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AccessorKeyword;
}

export function isAsyncKeyword(node: Node | undefined): node is AsyncKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.AsyncKeyword;
}

export function isConstKeyword(node: Node | undefined): node is ConstKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ConstKeyword;
}

export function isDeclareKeyword(node: Node | undefined): node is DeclareKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DeclareKeyword;
}

export function isDefaultKeyword(node: Node | undefined): node is DefaultKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.DefaultKeyword;
}

export function isExportKeyword(node: Node | undefined): node is ExportKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ExportKeyword;
}

export function isInKeyword(node: Node | undefined): node is InKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.InKeyword;
}

export function isPrivateKeyword(node: Node | undefined): node is PrivateKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PrivateKeyword;
}

export function isProtectedKeyword(node: Node | undefined): node is ProtectedKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ProtectedKeyword;
}

export function isPublicKeyword(node: Node | undefined): node is PublicKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.PublicKeyword;
}

export function isReadonlyKeyword(node: Node | undefined): node is ReadonlyKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ReadonlyKeyword;
}

export function isOutKeyword(node: Node | undefined): node is OutKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.OutKeyword;
}

export function isOverrideKeyword(node: Node | undefined): node is OverrideKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.OverrideKeyword;
}

export function isStaticKeyword(node: Node | undefined): node is StaticKeyword {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.StaticKeyword;
}

export function isBinaryOperatorToken(node: Node | undefined): node is BinaryOperatorToken {
    if (node === undefined) return false;
    return isBinaryOperator(node.kind);
}

export function isAssignmentOperatorToken(node: Node | undefined): node is AssignmentOperatorToken {
    if (node === undefined) return false;
    return isAssignmentOperator(node.kind);
}

export function isNullLiteral(node: Node | undefined): node is NullLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.NullKeyword;
}

export function isTrueLiteral(node: Node | undefined): node is TrueLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TrueKeyword;
}

export function isFalseLiteral(node: Node | undefined): node is FalseLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.FalseKeyword;
}

export function isThisExpression(node: Node | undefined): node is ThisExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ThisKeyword;
}

export function isSuperExpression(node: Node | undefined): node is SuperExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.SuperKeyword;
}

export function isImportExpression(node: Node | undefined): node is ImportExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ImportKeyword;
}
type JSDocNamespaceDeclaration = ModuleDeclaration;
type WrappedExpression = ParenthesizedExpression | TypeAssertion | AsExpression | SatisfiesExpression | ExpressionWithTypeArguments | NonNullExpression | PartiallyEmittedExpression;
type OuterExpression = WrappedExpression;

export function isTypeNode(node: Node | undefined): node is TypeNode {
    if (node === undefined) return false;
    return isTypeNodeKind(node.kind);
}

function isTypeNodeKind(kind: SyntaxKind): boolean {
    return kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode
        || kind === SyntaxKind.AnyKeyword
        || kind === SyntaxKind.UnknownKeyword
        || kind === SyntaxKind.NumberKeyword
        || kind === SyntaxKind.BigIntKeyword
        || kind === SyntaxKind.ObjectKeyword
        || kind === SyntaxKind.BooleanKeyword
        || kind === SyntaxKind.StringKeyword
        || kind === SyntaxKind.SymbolKeyword
        || kind === SyntaxKind.VoidKeyword
        || kind === SyntaxKind.UndefinedKeyword
        || kind === SyntaxKind.NeverKeyword
        || kind === SyntaxKind.IntrinsicKeyword
        || kind === SyntaxKind.ExpressionWithTypeArguments
        || kind === SyntaxKind.JSDocAllType
        || kind === SyntaxKind.JSDocNullableType
        || kind === SyntaxKind.JSDocNonNullableType
        || kind === SyntaxKind.JSDocOptionalType
        || kind === SyntaxKind.JSDocVariadicType
        || kind === SyntaxKind.JSDocTypeExpression
        || kind === SyntaxKind.JSDocTypeLiteral
        || kind === SyntaxKind.JSDocSignature;
}

export function isStatement(node: Node | undefined): node is Statement {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.VariableStatement || kind === SyntaxKind.EmptyStatement
        || kind === SyntaxKind.ExpressionStatement || kind === SyntaxKind.IfStatement
        || kind === SyntaxKind.DoStatement || kind === SyntaxKind.WhileStatement
        || kind === SyntaxKind.ForStatement || kind === SyntaxKind.ForInStatement
        || kind === SyntaxKind.ForOfStatement || kind === SyntaxKind.ContinueStatement
        || kind === SyntaxKind.BreakStatement || kind === SyntaxKind.ReturnStatement
        || kind === SyntaxKind.WithStatement || kind === SyntaxKind.SwitchStatement
        || kind === SyntaxKind.LabeledStatement || kind === SyntaxKind.ThrowStatement
        || kind === SyntaxKind.TryStatement || kind === SyntaxKind.DebuggerStatement
        || kind === SyntaxKind.InterfaceDeclaration || kind === SyntaxKind.TypeAliasDeclaration
        || kind === SyntaxKind.EnumDeclaration || kind === SyntaxKind.ModuleDeclaration
        || kind === SyntaxKind.ImportDeclaration || kind === SyntaxKind.ImportEqualsDeclaration
        || kind === SyntaxKind.ExportDeclaration || kind === SyntaxKind.ExportAssignment
        || kind === SyntaxKind.NamespaceExportDeclaration || kind === SyntaxKind.FunctionDeclaration
        || kind === SyntaxKind.ClassDeclaration || kind === SyntaxKind.MissingDeclaration
        || kind === SyntaxKind.NotEmittedStatement || kind === SyntaxKind.Block;
}

export function isExpression(node: Node | undefined): node is Expression {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.ConditionalExpression || kind === SyntaxKind.YieldExpression
        || kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.BinaryExpression
        || kind === SyntaxKind.SpreadElement || kind === SyntaxKind.AsExpression
        || kind === SyntaxKind.OmittedExpression
        || kind === SyntaxKind.SatisfiesExpression
        || kind === SyntaxKind.PrefixUnaryExpression || kind === SyntaxKind.PostfixUnaryExpression
        || kind === SyntaxKind.DeleteExpression || kind === SyntaxKind.TypeOfExpression
        || kind === SyntaxKind.VoidExpression || kind === SyntaxKind.AwaitExpression
        || kind === SyntaxKind.TypeAssertionExpression
        || kind === SyntaxKind.CallExpression || kind === SyntaxKind.NewExpression
        || kind === SyntaxKind.TaggedTemplateExpression || kind === SyntaxKind.NonNullExpression
        || kind === SyntaxKind.MetaProperty || kind === SyntaxKind.JsxExpression
        || kind === SyntaxKind.PropertyAccessExpression || kind === SyntaxKind.ElementAccessExpression
        || kind === SyntaxKind.FunctionExpression || kind === SyntaxKind.ClassExpression
        || kind === SyntaxKind.ParenthesizedExpression || kind === SyntaxKind.ArrayLiteralExpression
        || kind === SyntaxKind.ObjectLiteralExpression || kind === SyntaxKind.TemplateExpression
        || kind === SyntaxKind.Identifier
        || kind === SyntaxKind.PrivateIdentifier
        || kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.BigIntLiteral
        || kind === SyntaxKind.StringLiteral || kind === SyntaxKind.RegularExpressionLiteral
        || kind === SyntaxKind.NoSubstitutionTemplateLiteral || kind === SyntaxKind.JsxElement
        || kind === SyntaxKind.JsxSelfClosingElement || kind === SyntaxKind.JsxFragment
        || kind === SyntaxKind.NullKeyword || kind === SyntaxKind.TrueKeyword
        || kind === SyntaxKind.FalseKeyword || kind === SyntaxKind.ThisKeyword
        || kind === SyntaxKind.SuperKeyword || kind === SyntaxKind.ImportKeyword
        || kind === SyntaxKind.ExpressionWithTypeArguments;
}

export function isBlockOrExpression(node: Node | undefined): node is BlockOrExpression {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Block || isExpression(node);
}

export function isLeftHandSideExpression(node: Node | undefined): node is LeftHandSideExpression {
    if (node === undefined) return false;
    return isLeftHandSideExpressionKind(skipPartiallyEmittedExpressions(node).kind);
}

export function skipPartiallyEmittedExpressions(node: Node): Node {
    return skipOuterExpressions(node, OuterExpressionKinds.PartiallyEmittedExpressions);
}

function isLeftHandSideExpressionKind(kind: SyntaxKind): boolean {
    switch (kind) {
        case SyntaxKind.PropertyAccessExpression:
        case SyntaxKind.ElementAccessExpression:
        case SyntaxKind.NewExpression:
        case SyntaxKind.CallExpression:
        case SyntaxKind.JsxElement:
        case SyntaxKind.JsxSelfClosingElement:
        case SyntaxKind.JsxFragment:
        case SyntaxKind.TaggedTemplateExpression:
        case SyntaxKind.ArrayLiteralExpression:
        case SyntaxKind.ParenthesizedExpression:
        case SyntaxKind.ObjectLiteralExpression:
        case SyntaxKind.ClassExpression:
        case SyntaxKind.FunctionExpression:
        case SyntaxKind.Identifier:
        case SyntaxKind.PrivateIdentifier: // technically this is only an Expression if it's in a `#field in expr` BinaryExpression
        case SyntaxKind.RegularExpressionLiteral:
        case SyntaxKind.NumericLiteral:
        case SyntaxKind.BigIntLiteral:
        case SyntaxKind.StringLiteral:
        case SyntaxKind.NoSubstitutionTemplateLiteral:
        case SyntaxKind.TemplateExpression:
        case SyntaxKind.FalseKeyword:
        case SyntaxKind.NullKeyword:
        case SyntaxKind.ThisKeyword:
        case SyntaxKind.TrueKeyword:
        case SyntaxKind.SuperKeyword:
        case SyntaxKind.NonNullExpression:
        case SyntaxKind.ExpressionWithTypeArguments:
        case SyntaxKind.MetaProperty:
        case SyntaxKind.ImportKeyword: // technically this is only an Expression if it's in a CallExpression
        case SyntaxKind.MissingDeclaration:
            return true;
        default:
            return false;
    }
}

export function isUnaryExpression(node: Node | undefined): node is UnaryExpressionBase {
    if (node === undefined) return false;
    return isUnaryExpressionKind(skipPartiallyEmittedExpressions(node).kind);
}

function isUnaryExpressionKind(kind: SyntaxKind): boolean {
    switch (kind) {
        case SyntaxKind.PrefixUnaryExpression:
        case SyntaxKind.PostfixUnaryExpression:
        case SyntaxKind.DeleteExpression:
        case SyntaxKind.TypeOfExpression:
        case SyntaxKind.VoidExpression:
        case SyntaxKind.AwaitExpression:
        case SyntaxKind.TypeAssertionExpression:
            return true;
        default:
            return isLeftHandSideExpressionKind(kind);
    }
}

export function isOuterExpression(node: Node | undefined, kinds: OuterExpressionKinds = OuterExpressionKinds.All): node is OuterExpression {
    if (node === undefined) return false;
    switch (node.kind) {
        case SyntaxKind.ParenthesizedExpression:
            if (kinds & OuterExpressionKinds.ExcludeJSDocTypeAssertion && isJSDocTypeAssertion(node)) {
                return false;
            }
            return (kinds & OuterExpressionKinds.Parentheses) !== 0;
        case SyntaxKind.TypeAssertionExpression:
        case SyntaxKind.AsExpression:
            return (kinds & OuterExpressionKinds.TypeAssertions) !== 0;
        case SyntaxKind.SatisfiesExpression:
            return (kinds & (OuterExpressionKinds.ExpressionsWithTypeArguments | OuterExpressionKinds.Satisfies)) !== 0;
        case SyntaxKind.ExpressionWithTypeArguments:
            return (kinds & OuterExpressionKinds.ExpressionsWithTypeArguments) !== 0;
        case SyntaxKind.NonNullExpression:
            return (kinds & OuterExpressionKinds.NonNullAssertions) !== 0;
        case SyntaxKind.PartiallyEmittedExpression:
            return (kinds & OuterExpressionKinds.PartiallyEmittedExpressions) !== 0;
    }
    return false;
}

export function skipOuterExpressions(node: Node, kinds: OuterExpressionKinds = OuterExpressionKinds.All): Node {
    while (isOuterExpression(node, kinds)) {
        node = node.expression;
    }
    return node;
}

function isJSDocTypeAssertion(node: Node | undefined): boolean {
    if (node === undefined) return false;
    const sourceFile = getSourceFileOfNode(node);
    if (sourceFile.scriptKind !== ScriptKind.JS && sourceFile.scriptKind !== ScriptKind.JSX) {
        return false;
    }
    const expression = node.expression;
    if (expression === undefined || expression.kind !== SyntaxKind.AsExpression) {
        return false;
    }
    const asExpression = expression;
    return !!asExpression.type
        && (asExpression.type.flags & NodeFlags.Reparsed) !== 0;
}

export function isBindingPattern(node: Node | undefined): node is BindingPattern {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern;
}

export function isConciseBody(node: Node | undefined): node is ConciseBody {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Block || isExpression(node);
}

export function isForInitializer(node: Node | undefined): node is ForInitializer {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.VariableDeclarationList || isExpression(node);
}

export function isQuestionOrExclamationToken(node: Node | undefined): node is QuestionToken | ExclamationToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.QuestionToken || node.kind === SyntaxKind.ExclamationToken;
}

export function isIdentifierOrThisTypeNode(node: Node | undefined): node is Identifier | ThisTypeNode {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.ThisType;
}

export function isReadonlyKeywordOrPlusOrMinusToken(node: Node | undefined): node is ReadonlyKeyword | PlusToken | MinusToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.ReadonlyKeyword || node.kind === SyntaxKind.PlusToken || node.kind === SyntaxKind.MinusToken;
}

export function isQuestionOrPlusOrMinusToken(node: Node | undefined): node is QuestionToken | PlusToken | MinusToken {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.QuestionToken || node.kind === SyntaxKind.PlusToken || node.kind === SyntaxKind.MinusToken;
}

export function isTemplateMiddleOrTemplateTail(node: Node | undefined): node is TemplateMiddle | TemplateTail {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.TemplateMiddle || node.kind === SyntaxKind.TemplateTail;
}

export function isLiteralTypeLiteral(node: Node | undefined): node is NullLiteral | BooleanLiteral | LiteralExpression | PrefixUnaryExpression {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.NullKeyword || kind === SyntaxKind.TrueKeyword
        || kind === SyntaxKind.FalseKeyword || kind === SyntaxKind.PrefixUnaryExpression
        || isLiteralExpression(node);
}

export function isIdentifierOrJSDocNamespaceDeclaration(node: Node | undefined): node is Identifier | JSDocNamespaceDeclaration {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.ModuleDeclaration;
}

export function isJSDocTypeExpressionOrJSDocTypeLiteral(node: Node | undefined): node is JSDocTypeExpression | JSDocTypeLiteral {
    if (node === undefined) return false;
    return node.kind === SyntaxKind.JSDocTypeExpression || node.kind === SyntaxKind.JSDocTypeLiteral;
}

export function isJsxTagNameExpression(node: Node | undefined): node is JsxTagNameExpression {
    if (node === undefined) return false;
    const kind = node.kind;
    return kind === SyntaxKind.ThisKeyword
        || kind === SyntaxKind.Identifier
        || kind === SyntaxKind.PropertyAccessExpression
        || kind === SyntaxKind.JsxNamespacedName;
}
