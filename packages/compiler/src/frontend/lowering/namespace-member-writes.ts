import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** The stdlib namespace objects whose members keep a live property table
 * (builtin-namespaces.ts): `Math`, `JSON` and `Reflect`. */
const NAMESPACES: ReadonlySet<string> = new Set(["Math", "JSON", "Reflect"]);

/** Whether a program names a namespace object and never spells a read of
 * its members: only then does its property table stay live.
 *
 * The namespace object holds its members in a live property table, so a
 * write or `delete` that reaches the object (`verifyProperty(Math, "abs",
 * ...)` writes through `Math[name]`, `Math[key] = ...`) can land on it. A
 * *spelled* member read (`Math.abs`, `Math.abs(x)`) keeps its static
 * lowering — the interned function value, which a replacement of the
 * object's member does not change — so it would answer the original after
 * the member changed. A program with any such read or call therefore keeps
 * its members fenced: the write throws the named SC1090 fence instead of the
 * read silently lying. The writes themselves (`Math.abs = ...`,
 * `delete Math.abs`) and element accesses already go through the object, so
 * they don't disqualify. */
export class NamespaceMemberWrites {
  private files: readonly ts.SourceFile[] | null = null;
  private scan: NamespaceScan | null = null;

  constructor(private readonly lowerer: Lowerer) {}

  setFiles(files: readonly ts.SourceFile[]): void {
    this.files = files;
    this.scan = null;
  }

  /** Whether a write or delete of a member of `canonical` through the
   * namespace object stays observable where the program reads it. The
   * program must name the namespace itself: one a generated helper only
   * materializes keeps the fence, so its IR does not change. */
  allowsMemberWrites(canonical: string): boolean {
    const scan = this.scanFiles();
    return scan.named.has(canonical) && !scan.spelled.has(canonical);
  }

  /** What the program's files say about each namespace. Queried before the
   * program's files are known (an early builtin lookup), no namespace is
   * named: the fence stays. */
  private scanFiles(): NamespaceScan {
    if (this.scan !== null) return this.scan;
    const scan: NamespaceScan = { named: new Set(), spelled: new Set() };
    this.scan = scan;
    if (this.files === null) return scan;
    for (const file of this.files) {
      if (file.isDeclarationFile) continue;
      ts.walkPreorder(file, (node) => {
        if (ts.isIdentifier(node) && NAMESPACES.has(node.text)) {
          const name = stdlibGlobalNameOf(this.lowerer, node);
          if (name !== null && NAMESPACES.has(name)) scan.named.add(name);
          return;
        }
        if (!ts.isPropertyAccessExpression(node)) return;
        const receiver = node.expression;
        if (!ts.isIdentifier(receiver) || !NAMESPACES.has(receiver.text)) return;
        const name = stdlibGlobalNameOf(this.lowerer, receiver);
        if (name === null || !NAMESPACES.has(name)) return;
        if (!isMemberWriteTarget(node)) scan.spelled.add(name);
      });
    }
    return scan;
  }
}

/** The namespaces the program names, and the ones it spells a member read or
 * call of. */
interface NamespaceScan {
  named: Set<string>;
  spelled: Set<string>;
}

/** Whether the property access `node` only writes or deletes the member
 * (`N.x = v`, `delete N.x`), which reaches the namespace object like an
 * element access does. A read or call of `N.x` — including a compound
 * assignment's read and an increment — does not. */
export function isMemberWriteTarget(node: ts.PropertyAccessExpression): boolean {
  let outer: ts.Node = node;
  while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent))
    outer = outer.parent;
  const parent: ts.Node | undefined = outer.parent;
  if (parent === undefined) return false;
  if (ts.isDeleteExpression(parent)) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === outer &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}
