import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** The stdlib namespace objects whose members keep a live property table
 * (builtin-namespaces.ts): `Math`, `JSON` and `Reflect`. */
const NAMESPACES: ReadonlySet<string> = new Set(["Math", "JSON", "Reflect"]);

/** Whether a program's writes to a namespace's members stay observable
 * everywhere it reads them.
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
  private spelled: Set<string> | null = null;

  constructor(private readonly lowerer: Lowerer) {}

  setFiles(files: readonly ts.SourceFile[]): void {
    this.files = files;
    this.spelled = null;
  }

  /** Whether a write or delete of a member of `canonical` through the
   * namespace object stays observable where the program reads it. */
  allowsMemberWrites(canonical: string): boolean {
    return !this.spelledMembers().has(canonical);
  }

  /** The namespaces the program spells a member read or call of, in any
   * file. Queried before the program's files are known (an early builtin
   * lookup), every namespace counts as spelled: the fence stays. */
  private spelledMembers(): ReadonlySet<string> {
    if (this.spelled !== null) return this.spelled;
    if (this.files === null) return NAMESPACES;
    const spelled = new Set<string>();
    this.spelled = spelled;
    for (const file of this.files) {
      if (file.isDeclarationFile) continue;
      ts.walkPreorder(file, (node) => {
        if (!ts.isPropertyAccessExpression(node)) return;
        const receiver = node.expression;
        if (!ts.isIdentifier(receiver) || !NAMESPACES.has(receiver.text)) return;
        const name = stdlibGlobalNameOf(this.lowerer, receiver);
        if (name === null || !NAMESPACES.has(name)) return;
        if (!isMemberWriteTarget(node)) spelled.add(name);
      });
    }
    return spelled;
  }
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
