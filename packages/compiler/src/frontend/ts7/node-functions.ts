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

/* Reads of a source file's raw text that say what they take from it
 * (SourceTextObserver). A read of `sourceFile.text` itself counts as a read
 * of all of it. */
export {
  FULL_SPAN,
  LEADING_SPAN,
  TOKEN_SPAN,
  UP_TO_TOKEN_SPAN,
  carriedSourceText,
  sourceTextIncludes,
  sourceTextMatches,
  sourceTextRange,
  sourceTextRangeIncludes,
  sourceTextRangeMatches,
  sourceTextRewritten,
} from "./ast-node.js";
export type { SourceTextBlank, SourceTextSpan } from "./ast-node.js";
