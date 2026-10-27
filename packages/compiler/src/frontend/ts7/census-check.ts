/* Census TYPE coverage, enforced at build time: every type-position name
 * the frontend census uses (census-ts-members.tsv — the top-40 table and
 * the long tail) must resolve through the adapter, so the phase-2 port
 * never discovers a missing type mid-swap. pnpm build fails here if any
 * name drops out of the adapter's surface.
 *
 * Not present, per the survey's MISSING list and the two-world design:
 * ts.Types (a comment-text census artifact, not an API), the parser and
 * transpile surface kept in TypeScript 5 islands, and the resolution/config
 * helpers replaced by scriptc and the TypeScript 7 host. */

import type * as ts from "./adapter.js";

/* eslint-disable @typescript-eslint/no-unused-vars */
type CensusTypes = [
  ts.Node,
  ts.Expression,
  ts.CallExpression,
  ts.PropertyAccessExpression,
  ts.Symbol,
  ts.Identifier,
  ts.SourceFile,
  ts.Type,
  ts.Statement,
  ts.BinaryExpression,
  ts.ElementAccessExpression,
  ts.TypeReference,
  ts.FunctionDeclaration,
  ts.ObjectLiteralExpression,
  ts.ShorthandPropertyAssignment,
  ts.StringLiteral,
  ts.FunctionExpression,
  ts.ForOfStatement,
  ts.Program,
  ts.NewExpression,
  ts.MethodDeclaration,
  ts.VariableDeclaration,
  ts.ClassDeclaration,
  ts.ArrowFunction,
  ts.PropertyAssignment,
  ts.ParameterDeclaration,
  ts.CompilerOptions,
  ts.BindingElement,
  ts.ArrayLiteralExpression,
  ts.VariableDeclarationList,
  ts.SetAccessorDeclaration,
  ts.ObjectLiteralElementLike,
  ts.GetAccessorDeclaration,
  ts.AccessorDeclaration,
  ts.SwitchStatement,
  ts.PrefixUnaryExpression,
  ts.ObjectType,
  ts.ObjectBindingPattern,
  ts.Diagnostic,
  ts.Block,
  ts.BindingName,
  ts.ArrayBindingPattern,
  ts.VariableStatement,
  ts.TypeChecker,
  ts.TryStatement,
  ts.TemplateExpression,
  ts.SpreadAssignment,
  ts.SignatureDeclaration,
  ts.Signature,
  ts.RegularExpressionLiteral,
  readonly ts.Node[],
  ts.ForStatement,
  ts.ExportAssignment,
  ts.Declaration,
  ts.ConstructorDeclaration,
  ts.AsExpression,
  ts.ArrayBindingElement,
  ts.TupleTypeReference,
  ts.StringLiteralLike,
  ts.SpreadElement,
  ts.PropertyName,
  ts.PostfixUnaryExpression,
  ts.MemberName,
  ts.DeleteExpression,
  ts.ConditionalExpression,
  ts.ComputedPropertyName,
  ts.CaseOrDefaultClause,
  ts.MethodSignature,
  ts.PropertySignatureDeclaration,
];

/* The enum types double as types and values; both positions must resolve. */
type CensusEnumTypes = [
  ts.SyntaxKind,
  ts.TypeFlags,
  ts.NodeFlags,
  ts.SymbolFlags,
  ts.ModifierFlags,
  ts.ObjectFlags,
  ts.ElementFlags,
  ts.InternalSymbolName,
  ts.ModuleKind,
  ts.ModuleResolutionKind,
  ts.ScriptKind,
  ts.ScriptTarget,
  ts.DiagnosticCategory,
];
/* eslint-enable @typescript-eslint/no-unused-vars */
