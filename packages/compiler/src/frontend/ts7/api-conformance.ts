/* Compile-time checks that scriptc's AST and semantic objects have the shapes
 * of tsc-ts/api's interfaces. The frontend keeps its own types, whose nodes
 * extend the AstNode class, because native code reads class fields directly
 * and reads through a structural interface dynamically. This module only
 * declares types and emits nothing. */

import type * as api from "tsc-ts/api";
import type { AstNode, AstNodeList } from "./ast-node.js";
import type * as ast from "./ast-types.js";

type Conforms<T extends U, U> = [T, U];

/* Members where tsgo's wire, which the RPC model reads, differs from tsc-ts:
 * - SourceFile.externalModuleIndicator is `true` where moduleDetection makes a
 *   file a module without an import or export.
 * - JSDocTypeLiteral.jsdocPropertyTags is one tag.
 * - SyntaxList.children is a node list.
 * - SyntheticExpression's isSpread and type are factory fields that a parsed
 *   tree never has. */
type Without<T, K extends PropertyKey> = Omit<T, K>;

export interface AstConformance {
  Node: Conforms<AstNode, api.Node>;
  NodeList: Conforms<AstNodeList, api.NodeList>;
  SourceFile: Conforms<
    Without<ast.SourceFile, "externalModuleIndicator">,
    Without<api.SourceFile, "externalModuleIndicator">
  >;
  ArrayBindingPattern: Conforms<ast.ArrayBindingPattern, api.ArrayBindingPattern>;
  ArrayLiteralExpression: Conforms<ast.ArrayLiteralExpression, api.ArrayLiteralExpression>;
  ArrayTypeNode: Conforms<ast.ArrayTypeNode, api.ArrayTypeNode>;
  ArrowFunction: Conforms<ast.ArrowFunction, api.ArrowFunction>;
  AsExpression: Conforms<ast.AsExpression, api.AsExpression>;
  AwaitExpression: Conforms<ast.AwaitExpression, api.AwaitExpression>;
  BigIntLiteral: Conforms<ast.BigIntLiteral, api.BigIntLiteral>;
  BinaryExpression: Conforms<ast.BinaryExpression, api.BinaryExpression>;
  BindingElement: Conforms<ast.BindingElement, api.BindingElement>;
  Block: Conforms<ast.Block, api.Block>;
  BodyBase: Conforms<ast.BodyBase, api.BodyBase>;
  BreakStatement: Conforms<ast.BreakStatement, api.BreakStatement>;
  CallExpression: Conforms<ast.CallExpression, api.CallExpression>;
  CallSignatureDeclaration: Conforms<ast.CallSignatureDeclaration, api.CallSignatureDeclaration>;
  CaseBlock: Conforms<ast.CaseBlock, api.CaseBlock>;
  CaseClause: Conforms<ast.CaseClause, api.CaseClause>;
  CatchClause: Conforms<ast.CatchClause, api.CatchClause>;
  ClassDeclaration: Conforms<ast.ClassDeclaration, api.ClassDeclaration>;
  ClassElementBase: Conforms<ast.ClassElementBase, api.ClassElementBase>;
  ClassExpression: Conforms<ast.ClassExpression, api.ClassExpression>;
  ClassLikeBase: Conforms<ast.ClassLikeBase, api.ClassLikeBase>;
  ClassStaticBlockDeclaration: Conforms<
    ast.ClassStaticBlockDeclaration,
    api.ClassStaticBlockDeclaration
  >;
  ComputedPropertyName: Conforms<ast.ComputedPropertyName, api.ComputedPropertyName>;
  ConditionalExpression: Conforms<ast.ConditionalExpression, api.ConditionalExpression>;
  ConditionalTypeNode: Conforms<ast.ConditionalTypeNode, api.ConditionalTypeNode>;
  ConstructSignatureDeclaration: Conforms<
    ast.ConstructSignatureDeclaration,
    api.ConstructSignatureDeclaration
  >;
  ConstructorDeclaration: Conforms<ast.ConstructorDeclaration, api.ConstructorDeclaration>;
  ConstructorTypeNode: Conforms<ast.ConstructorTypeNode, api.ConstructorTypeNode>;
  ContinueStatement: Conforms<ast.ContinueStatement, api.ContinueStatement>;
  DebuggerStatement: Conforms<ast.DebuggerStatement, api.DebuggerStatement>;
  DeclarationBase: Conforms<ast.DeclarationBase, api.DeclarationBase>;
  Decorator: Conforms<ast.Decorator, api.Decorator>;
  DefaultClause: Conforms<ast.DefaultClause, api.DefaultClause>;
  DeleteExpression: Conforms<ast.DeleteExpression, api.DeleteExpression>;
  DoStatement: Conforms<ast.DoStatement, api.DoStatement>;
  ElementAccessExpression: Conforms<ast.ElementAccessExpression, api.ElementAccessExpression>;
  EmptyStatement: Conforms<ast.EmptyStatement, api.EmptyStatement>;
  EnumDeclaration: Conforms<ast.EnumDeclaration, api.EnumDeclaration>;
  EnumMember: Conforms<ast.EnumMember, api.EnumMember>;
  ExportAssignment: Conforms<ast.ExportAssignment, api.ExportAssignment>;
  ExportDeclaration: Conforms<ast.ExportDeclaration, api.ExportDeclaration>;
  ExportSpecifier: Conforms<ast.ExportSpecifier, api.ExportSpecifier>;
  ExpressionBase: Conforms<ast.ExpressionBase, api.ExpressionBase>;
  ExpressionStatement: Conforms<ast.ExpressionStatement, api.ExpressionStatement>;
  ExpressionWithTypeArguments: Conforms<
    ast.ExpressionWithTypeArguments,
    api.ExpressionWithTypeArguments
  >;
  ExternalModuleReference: Conforms<ast.ExternalModuleReference, api.ExternalModuleReference>;
  ForInStatement: Conforms<ast.ForInStatement, api.ForInStatement>;
  ForOfStatement: Conforms<ast.ForOfStatement, api.ForOfStatement>;
  ForStatement: Conforms<ast.ForStatement, api.ForStatement>;
  FunctionDeclaration: Conforms<ast.FunctionDeclaration, api.FunctionDeclaration>;
  FunctionExpression: Conforms<ast.FunctionExpression, api.FunctionExpression>;
  FunctionLikeBase: Conforms<ast.FunctionLikeBase, api.FunctionLikeBase>;
  FunctionLikeWithBodyBase: Conforms<ast.FunctionLikeWithBodyBase, api.FunctionLikeWithBodyBase>;
  FunctionTypeNode: Conforms<ast.FunctionTypeNode, api.FunctionTypeNode>;
  GetAccessorDeclaration: Conforms<ast.GetAccessorDeclaration, api.GetAccessorDeclaration>;
  HeritageClause: Conforms<ast.HeritageClause, api.HeritageClause>;
  Identifier: Conforms<ast.Identifier, api.Identifier>;
  IfStatement: Conforms<ast.IfStatement, api.IfStatement>;
  ImportAttribute: Conforms<ast.ImportAttribute, api.ImportAttribute>;
  ImportAttributes: Conforms<ast.ImportAttributes, api.ImportAttributes>;
  ImportClause: Conforms<ast.ImportClause, api.ImportClause>;
  ImportDeclaration: Conforms<ast.ImportDeclaration, api.ImportDeclaration>;
  ImportEqualsDeclaration: Conforms<ast.ImportEqualsDeclaration, api.ImportEqualsDeclaration>;
  ImportSpecifier: Conforms<ast.ImportSpecifier, api.ImportSpecifier>;
  ImportTypeNode: Conforms<ast.ImportTypeNode, api.ImportTypeNode>;
  IndexSignatureDeclaration: Conforms<ast.IndexSignatureDeclaration, api.IndexSignatureDeclaration>;
  IndexedAccessTypeNode: Conforms<ast.IndexedAccessTypeNode, api.IndexedAccessTypeNode>;
  InferTypeNode: Conforms<ast.InferTypeNode, api.InferTypeNode>;
  InterfaceDeclaration: Conforms<ast.InterfaceDeclaration, api.InterfaceDeclaration>;
  IntersectionTypeNode: Conforms<ast.IntersectionTypeNode, api.IntersectionTypeNode>;
  IterationStatementBase: Conforms<ast.IterationStatementBase, api.IterationStatementBase>;
  JSDoc: Conforms<ast.JSDoc, api.JSDoc>;
  JSDocAllType: Conforms<ast.JSDocAllType, api.JSDocAllType>;
  JSDocAugmentsTag: Conforms<ast.JSDocAugmentsTag, api.JSDocAugmentsTag>;
  JSDocCallbackTag: Conforms<ast.JSDocCallbackTag, api.JSDocCallbackTag>;
  JSDocCommentBase: Conforms<ast.JSDocCommentBase, api.JSDocCommentBase>;
  JSDocDeprecatedTag: Conforms<ast.JSDocDeprecatedTag, api.JSDocDeprecatedTag>;
  JSDocImplementsTag: Conforms<ast.JSDocImplementsTag, api.JSDocImplementsTag>;
  JSDocImportTag: Conforms<ast.JSDocImportTag, api.JSDocImportTag>;
  JSDocLink: Conforms<ast.JSDocLink, api.JSDocLink>;
  JSDocLinkCode: Conforms<ast.JSDocLinkCode, api.JSDocLinkCode>;
  JSDocLinkPlain: Conforms<ast.JSDocLinkPlain, api.JSDocLinkPlain>;
  JSDocNameReference: Conforms<ast.JSDocNameReference, api.JSDocNameReference>;
  JSDocNonNullableType: Conforms<ast.JSDocNonNullableType, api.JSDocNonNullableType>;
  JSDocNullableType: Conforms<ast.JSDocNullableType, api.JSDocNullableType>;
  JSDocOptionalType: Conforms<ast.JSDocOptionalType, api.JSDocOptionalType>;
  JSDocOverloadTag: Conforms<ast.JSDocOverloadTag, api.JSDocOverloadTag>;
  JSDocOverrideTag: Conforms<ast.JSDocOverrideTag, api.JSDocOverrideTag>;
  JSDocParameterTag: Conforms<ast.JSDocParameterTag, api.JSDocParameterTag>;
  JSDocPrivateTag: Conforms<ast.JSDocPrivateTag, api.JSDocPrivateTag>;
  JSDocPropertyTag: Conforms<ast.JSDocPropertyTag, api.JSDocPropertyTag>;
  JSDocProtectedTag: Conforms<ast.JSDocProtectedTag, api.JSDocProtectedTag>;
  JSDocPublicTag: Conforms<ast.JSDocPublicTag, api.JSDocPublicTag>;
  JSDocReadonlyTag: Conforms<ast.JSDocReadonlyTag, api.JSDocReadonlyTag>;
  JSDocReturnTag: Conforms<ast.JSDocReturnTag, api.JSDocReturnTag>;
  JSDocSatisfiesTag: Conforms<ast.JSDocSatisfiesTag, api.JSDocSatisfiesTag>;
  JSDocSeeTag: Conforms<ast.JSDocSeeTag, api.JSDocSeeTag>;
  JSDocSignature: Conforms<ast.JSDocSignature, api.JSDocSignature>;
  JSDocTagBase: Conforms<ast.JSDocTagBase, api.JSDocTagBase>;
  JSDocTemplateTag: Conforms<ast.JSDocTemplateTag, api.JSDocTemplateTag>;
  JSDocText: Conforms<ast.JSDocText, api.JSDocText>;
  JSDocThisTag: Conforms<ast.JSDocThisTag, api.JSDocThisTag>;
  JSDocThrowsTag: Conforms<ast.JSDocThrowsTag, api.JSDocThrowsTag>;
  JSDocTypeBase: Conforms<ast.JSDocTypeBase, api.JSDocTypeBase>;
  JSDocTypeExpression: Conforms<ast.JSDocTypeExpression, api.JSDocTypeExpression>;
  JSDocTypeLiteral: Conforms<
    Without<ast.JSDocTypeLiteral, "jsdocPropertyTags">,
    Without<api.JSDocTypeLiteral, "jsdocPropertyTags">
  >;
  JSDocTypeTag: Conforms<ast.JSDocTypeTag, api.JSDocTypeTag>;
  JSDocTypedefTag: Conforms<ast.JSDocTypedefTag, api.JSDocTypedefTag>;
  JSDocUnknownTag: Conforms<ast.JSDocUnknownTag, api.JSDocUnknownTag>;
  JSDocVariadicType: Conforms<ast.JSDocVariadicType, api.JSDocVariadicType>;
  JsxAttribute: Conforms<ast.JsxAttribute, api.JsxAttribute>;
  JsxAttributes: Conforms<ast.JsxAttributes, api.JsxAttributes>;
  JsxClosingElement: Conforms<ast.JsxClosingElement, api.JsxClosingElement>;
  JsxClosingFragment: Conforms<ast.JsxClosingFragment, api.JsxClosingFragment>;
  JsxElement: Conforms<ast.JsxElement, api.JsxElement>;
  JsxExpression: Conforms<ast.JsxExpression, api.JsxExpression>;
  JsxFragment: Conforms<ast.JsxFragment, api.JsxFragment>;
  JsxNamespacedName: Conforms<ast.JsxNamespacedName, api.JsxNamespacedName>;
  JsxOpeningElement: Conforms<ast.JsxOpeningElement, api.JsxOpeningElement>;
  JsxOpeningFragment: Conforms<ast.JsxOpeningFragment, api.JsxOpeningFragment>;
  JsxSelfClosingElement: Conforms<ast.JsxSelfClosingElement, api.JsxSelfClosingElement>;
  JsxSpreadAttribute: Conforms<ast.JsxSpreadAttribute, api.JsxSpreadAttribute>;
  JsxText: Conforms<ast.JsxText, api.JsxText>;
  KeywordExpression: Conforms<ast.KeywordExpression, api.KeywordExpression>;
  KeywordTypeNode: Conforms<ast.KeywordTypeNode, api.KeywordTypeNode>;
  LabeledStatement: Conforms<ast.LabeledStatement, api.LabeledStatement>;
  LeftHandSideExpressionBase: Conforms<
    ast.LeftHandSideExpressionBase,
    api.LeftHandSideExpressionBase
  >;
  LiteralExpressionBase: Conforms<ast.LiteralExpressionBase, api.LiteralExpressionBase>;
  LiteralLikeNodeBase: Conforms<ast.LiteralLikeNodeBase, api.LiteralLikeNodeBase>;
  LiteralTypeNode: Conforms<ast.LiteralTypeNode, api.LiteralTypeNode>;
  MappedTypeNode: Conforms<ast.MappedTypeNode, api.MappedTypeNode>;
  MemberExpressionBase: Conforms<ast.MemberExpressionBase, api.MemberExpressionBase>;
  MetaProperty: Conforms<ast.MetaProperty, api.MetaProperty>;
  MethodDeclaration: Conforms<ast.MethodDeclaration, api.MethodDeclaration>;
  MethodSignatureDeclaration: Conforms<
    ast.MethodSignatureDeclaration,
    api.MethodSignatureDeclaration
  >;
  MissingDeclaration: Conforms<ast.MissingDeclaration, api.MissingDeclaration>;
  ModifiersBase: Conforms<ast.ModifiersBase, api.ModifiersBase>;
  ModuleBlock: Conforms<ast.ModuleBlock, api.ModuleBlock>;
  ModuleDeclaration: Conforms<ast.ModuleDeclaration, api.ModuleDeclaration>;
  NamedExports: Conforms<ast.NamedExports, api.NamedExports>;
  NamedImports: Conforms<ast.NamedImports, api.NamedImports>;
  NamedMemberBase: Conforms<ast.NamedMemberBase, api.NamedMemberBase>;
  NamedTupleMember: Conforms<ast.NamedTupleMember, api.NamedTupleMember>;
  NamespaceExport: Conforms<ast.NamespaceExport, api.NamespaceExport>;
  NamespaceExportDeclaration: Conforms<
    ast.NamespaceExportDeclaration,
    api.NamespaceExportDeclaration
  >;
  NamespaceImport: Conforms<ast.NamespaceImport, api.NamespaceImport>;
  NewExpression: Conforms<ast.NewExpression, api.NewExpression>;
  NoSubstitutionTemplateLiteral: Conforms<
    ast.NoSubstitutionTemplateLiteral,
    api.NoSubstitutionTemplateLiteral
  >;
  NodeBase: Conforms<ast.NodeBase, api.NodeBase>;
  NodeWithTypeArgumentsBase: Conforms<ast.NodeWithTypeArgumentsBase, api.NodeWithTypeArgumentsBase>;
  NonNullExpression: Conforms<ast.NonNullExpression, api.NonNullExpression>;
  NotEmittedStatement: Conforms<ast.NotEmittedStatement, api.NotEmittedStatement>;
  NotEmittedTypeElement: Conforms<ast.NotEmittedTypeElement, api.NotEmittedTypeElement>;
  NumericLiteral: Conforms<ast.NumericLiteral, api.NumericLiteral>;
  ObjectBindingPattern: Conforms<ast.ObjectBindingPattern, api.ObjectBindingPattern>;
  ObjectLiteralElementBase: Conforms<ast.ObjectLiteralElementBase, api.ObjectLiteralElementBase>;
  ObjectLiteralExpression: Conforms<ast.ObjectLiteralExpression, api.ObjectLiteralExpression>;
  OmittedExpression: Conforms<ast.OmittedExpression, api.OmittedExpression>;
  OptionalTypeNode: Conforms<ast.OptionalTypeNode, api.OptionalTypeNode>;
  ParameterDeclaration: Conforms<ast.ParameterDeclaration, api.ParameterDeclaration>;
  ParenthesizedExpression: Conforms<ast.ParenthesizedExpression, api.ParenthesizedExpression>;
  ParenthesizedTypeNode: Conforms<ast.ParenthesizedTypeNode, api.ParenthesizedTypeNode>;
  PartiallyEmittedExpression: Conforms<
    ast.PartiallyEmittedExpression,
    api.PartiallyEmittedExpression
  >;
  PostfixUnaryExpression: Conforms<ast.PostfixUnaryExpression, api.PostfixUnaryExpression>;
  PrefixUnaryExpression: Conforms<ast.PrefixUnaryExpression, api.PrefixUnaryExpression>;
  PrimaryExpressionBase: Conforms<ast.PrimaryExpressionBase, api.PrimaryExpressionBase>;
  PrivateIdentifier: Conforms<ast.PrivateIdentifier, api.PrivateIdentifier>;
  PropertyAccessExpression: Conforms<ast.PropertyAccessExpression, api.PropertyAccessExpression>;
  PropertyAssignment: Conforms<ast.PropertyAssignment, api.PropertyAssignment>;
  PropertyDeclaration: Conforms<ast.PropertyDeclaration, api.PropertyDeclaration>;
  PropertySignatureDeclaration: Conforms<
    ast.PropertySignatureDeclaration,
    api.PropertySignatureDeclaration
  >;
  QualifiedName: Conforms<ast.QualifiedName, api.QualifiedName>;
  RegularExpressionLiteral: Conforms<ast.RegularExpressionLiteral, api.RegularExpressionLiteral>;
  RestTypeNode: Conforms<ast.RestTypeNode, api.RestTypeNode>;
  ReturnStatement: Conforms<ast.ReturnStatement, api.ReturnStatement>;
  SatisfiesExpression: Conforms<ast.SatisfiesExpression, api.SatisfiesExpression>;
  SemicolonClassElement: Conforms<ast.SemicolonClassElement, api.SemicolonClassElement>;
  SetAccessorDeclaration: Conforms<ast.SetAccessorDeclaration, api.SetAccessorDeclaration>;
  ShorthandPropertyAssignment: Conforms<
    ast.ShorthandPropertyAssignment,
    api.ShorthandPropertyAssignment
  >;
  SpreadAssignment: Conforms<ast.SpreadAssignment, api.SpreadAssignment>;
  SpreadElement: Conforms<ast.SpreadElement, api.SpreadElement>;
  StatementBase: Conforms<ast.StatementBase, api.StatementBase>;
  StringLiteral: Conforms<ast.StringLiteral, api.StringLiteral>;
  SwitchStatement: Conforms<ast.SwitchStatement, api.SwitchStatement>;
  SyntaxList: Conforms<Without<ast.SyntaxList, "children">, Without<api.SyntaxList, "children">>;
  SyntheticExpression: Conforms<
    Without<ast.SyntheticExpression, "isSpread" | "type">,
    Without<api.SyntheticExpression, "isSpread" | "type">
  >;
  SyntheticReferenceExpression: Conforms<
    ast.SyntheticReferenceExpression,
    api.SyntheticReferenceExpression
  >;
  TaggedTemplateExpression: Conforms<ast.TaggedTemplateExpression, api.TaggedTemplateExpression>;
  TemplateExpression: Conforms<ast.TemplateExpression, api.TemplateExpression>;
  TemplateHead: Conforms<ast.TemplateHead, api.TemplateHead>;
  TemplateLiteralLikeNodeBase: Conforms<
    ast.TemplateLiteralLikeNodeBase,
    api.TemplateLiteralLikeNodeBase
  >;
  TemplateLiteralTypeNode: Conforms<ast.TemplateLiteralTypeNode, api.TemplateLiteralTypeNode>;
  TemplateLiteralTypeSpan: Conforms<ast.TemplateLiteralTypeSpan, api.TemplateLiteralTypeSpan>;
  TemplateMiddle: Conforms<ast.TemplateMiddle, api.TemplateMiddle>;
  TemplateSpan: Conforms<ast.TemplateSpan, api.TemplateSpan>;
  TemplateTail: Conforms<ast.TemplateTail, api.TemplateTail>;
  ThisTypeNode: Conforms<ast.ThisTypeNode, api.ThisTypeNode>;
  ThrowStatement: Conforms<ast.ThrowStatement, api.ThrowStatement>;
  Token: Conforms<ast.Token, api.Token>;
  TryStatement: Conforms<ast.TryStatement, api.TryStatement>;
  TupleTypeNode: Conforms<ast.TupleTypeNode, api.TupleTypeNode>;
  TypeAliasDeclaration: Conforms<ast.TypeAliasDeclaration, api.TypeAliasDeclaration>;
  TypeAssertion: Conforms<ast.TypeAssertion, api.TypeAssertion>;
  TypeElementBase: Conforms<ast.TypeElementBase, api.TypeElementBase>;
  TypeLiteralNode: Conforms<ast.TypeLiteralNode, api.TypeLiteralNode>;
  TypeNodeBase: Conforms<ast.TypeNodeBase, api.TypeNodeBase>;
  TypeOfExpression: Conforms<ast.TypeOfExpression, api.TypeOfExpression>;
  TypeOperatorNode: Conforms<ast.TypeOperatorNode, api.TypeOperatorNode>;
  TypeParameterDeclaration: Conforms<ast.TypeParameterDeclaration, api.TypeParameterDeclaration>;
  TypePredicateNode: Conforms<ast.TypePredicateNode, api.TypePredicateNode>;
  TypeQueryNode: Conforms<ast.TypeQueryNode, api.TypeQueryNode>;
  TypeReferenceNode: Conforms<ast.TypeReferenceNode, api.TypeReferenceNode>;
  UnaryExpressionBase: Conforms<ast.UnaryExpressionBase, api.UnaryExpressionBase>;
  UnionOrIntersectionTypeNodeBase: Conforms<
    ast.UnionOrIntersectionTypeNodeBase,
    api.UnionOrIntersectionTypeNodeBase
  >;
  UnionTypeNode: Conforms<ast.UnionTypeNode, api.UnionTypeNode>;
  UpdateExpressionBase: Conforms<ast.UpdateExpressionBase, api.UpdateExpressionBase>;
  VariableDeclaration: Conforms<ast.VariableDeclaration, api.VariableDeclaration>;
  VariableDeclarationList: Conforms<ast.VariableDeclarationList, api.VariableDeclarationList>;
  VariableStatement: Conforms<ast.VariableStatement, api.VariableStatement>;
  VoidExpression: Conforms<ast.VoidExpression, api.VoidExpression>;
  WhileStatement: Conforms<ast.WhileStatement, api.WhileStatement>;
  WithStatement: Conforms<ast.WithStatement, api.WithStatement>;
  YieldExpression: Conforms<ast.YieldExpression, api.YieldExpression>;
}
