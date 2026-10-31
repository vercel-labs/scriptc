import * as ts from "./ts7/adapter.js";

/** An element of a heritage clause. TypeScript 7.0 parses every element as
 * an ExpressionWithTypeArguments. TypeScript 7.1 parses the elements of an
 * interface's `extends` and a class's `implements` as TypeReference nodes,
 * whose names are entity names (an Identifier or a QualifiedName); a class's
 * `extends` element stays an ExpressionWithTypeArguments. */
export type HeritageElement = ts.ExpressionWithTypeArguments | ts.TypeReferenceNode;

/** Whether `node` is a TypeReference that is a heritage clause element. */
export function isHeritageTypeReference(node: ts.Node): node is ts.TypeReferenceNode {
  return (
    ts.isTypeReferenceNode(node) && node.parent !== undefined && ts.isHeritageClause(node.parent)
  );
}

/** Whether `node` is a heritage clause element in either form. */
export function isHeritageElement(node: ts.Node): node is HeritageElement {
  return ts.isExpressionWithTypeArguments(node) || isHeritageTypeReference(node);
}

/** The name or expression a heritage clause element refers to: its
 * expression (an ExpressionWithTypeArguments) or its type name (a
 * TypeReference). */
export function heritageElementTarget(element: ts.Node): ts.Expression | ts.EntityName {
  if (ts.isTypeReferenceNode(element)) return element.typeName;
  return (element as ts.ExpressionWithTypeArguments).expression;
}
