/* Position and text functions over nodes, with tsc-ts/api's names. The
 * frontend calls these rather than node methods, so that its node types can
 * be tsc-ts/api's interfaces, which have no methods. Today every node is an
 * AstNode, and each function forwards to the AstNode method. */

import type { AstNode } from "./ast-node.js";
import type { Node, SourceFile } from "./ast-types.js";

/** The start of the node's first token, after its leading trivia, and before
 * its JSDoc comments when `includeJSDoc` is true. */
export function tokenStartOfNode(node: Node, includeJSDoc = false): number {
  return (node as AstNode).getStart(undefined, includeJSDoc);
}

/** The node's text from its first token to its end. */
export function getTextOfNode(node: Node): string {
  return (node as AstNode).getText();
}

/** The source file that contains the node. */
export function getSourceFileOfNode(node: Node): SourceFile {
  return (node as AstNode).getSourceFile();
}
