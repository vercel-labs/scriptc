import * as ts from "../ts7/adapter.js";
import { keyedHelperName, type KeyedNameOwner } from "./stable-names.js";

/** The declaration kinds whose names anchor the positions inside them. */
const ANCHOR_KINDS: ReadonlySet<number> = new Set<number>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

/** The name of `node` when it is a named declaration that anchors the
 * positions of the nodes inside it, or null. */
function anchorName(node: ts.Node): string | null {
  return ts.declarationNameAt(node, node.index, ANCHOR_KINDS);
}

/** The nearest enclosing anchor of `node` (not `node` itself), or its
 * source file. */
function anchorOf(node: ts.Node): ts.Node {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isSourceFile(parent) || anchorName(parent) !== null) return parent;
  }
  return ts.getSourceFileOfNode(node);
}

/** Source positions that stay the same when code outside the enclosing
 * declaration changes. A node's structural position is its file, the chain
 * of enclosing named declarations (each with its kind, its name and its
 * ordinal among the declarations of the same kind and name in its own
 * anchor), and its ordinal among the nodes of its kind whose nearest anchor
 * is the same declaration. Editing another declaration, or code nested in another
 * named declaration of the same anchor, leaves the position unchanged. */
export class StructuralPositions {
  /** Per anchor and key: the indices of the nodes with that key whose
   * nearest anchor it is, in preorder (anchoredNodes). */
  private readonly nodesByKey = new Map<ts.Node, Map<string, number[]>>();
  private readonly paths = new Map<ts.Node, string>();

  /** `fileKey` names a source file in positions (its file name when
   * absent). */
  constructor(private readonly fileKey?: (sf: ts.SourceFile) => string) {}

  /** The ordinal of `node` among the nodes of `anchor` with its key. */
  private ordinalIn(anchor: ts.Node, node: ts.Node, key: string): number {
    let byKey = this.nodesByKey.get(anchor);
    if (byKey === undefined) this.nodesByKey.set(anchor, (byKey = new Map()));
    let indices = byKey.get(key);
    if (indices === undefined) {
      indices = ts.anchoredNodes(anchor, key, ANCHOR_KINDS);
      byKey.set(key, indices);
    }
    // Indices increase in preorder.
    let low = 0;
    let high = indices.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const at = indices[middle]!;
      if (at === node.index) return middle;
      if (at < node.index) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  /** The anchor chain of `anchor` from the file down. */
  private pathOf(anchor: ts.Node): string {
    const cached = this.paths.get(anchor);
    if (cached !== undefined) return cached;
    let path: string;
    if (ts.isSourceFile(anchor)) path = this.fileKey?.(anchor) ?? anchor.fileName;
    else {
      const parent = anchorOf(anchor);
      // The kind keeps declarations of one name apart: a getter and its
      // setter, or a class and the namespace merged with it.
      const key = `${anchor.kind}:${anchorName(anchor)}`;
      path = `${this.pathOf(parent)}/${key}#${this.ordinalIn(parent, anchor, key)}`;
    }
    this.paths.set(anchor, path);
    return path;
  }

  /** The structural position of `node`. */
  of(node: ts.Node): string {
    const anchor = anchorOf(node);
    const name = anchorName(node);
    const key = name === null ? `${node.kind}` : `${node.kind}:${name}`;
    return `${this.pathOf(anchor)}|${key}#${this.ordinalIn(anchor, node, key)}`;
  }
}

/** The owner of structural positions and the names made from them. */
export interface PositionTagOwner extends KeyedNameOwner {
  readonly positions: StructuralPositions;
}

/** A short tag for `node`'s structural position, for names that must stay
 * unique per source node (class expressions, namespace blocks). */
export function positionTag(owner: PositionTagOwner, node: ts.Node): string {
  return keyedHelperName(owner, "", owner.positions.of(node), "");
}
