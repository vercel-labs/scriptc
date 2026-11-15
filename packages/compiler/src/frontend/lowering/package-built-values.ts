/* A member the program names on an object that a package's JavaScript built
 * without it.
 *
 * A package compiled from its JavaScript hands the program the objects its
 * code builds, at the shape that code builds them: `return { sku, qty: 1 }`
 * is a record of `sku` and `qty`. The program is type-checked against the
 * package's declarations, which may promise more (`label?: string`), so a
 * write or a read of such a member passes the check and finds no place for
 * the member in the object: no code of the package creates it.
 *
 * The refusal names that. It does not suggest annotating the binding with
 * the declared type: the annotation converts the object into a separate
 * record of the declared shape, and a write through it would not reach the
 * object the package may still hold. In a Node island the object is Node's
 * own and takes the member. */

import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import type { Lowerer } from "./lowerer.js";

/** The refusal's text for `receiver.member` in TypeScript source when the
 * receiver is an object literal of a compiled package's JavaScript that
 * declares no such member; null for every other receiver. `action` is
 * "writing" or "reading". */
export function packageBuiltWithoutMember(
  lowerer: Lowerer,
  receiver: ts.Expression,
  member: string,
  action: "writing" | "reading",
): string | null {
  if (isJsSourceFile(ts.getSourceFileOfNode(receiver))) return null;
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(receiver));
  const symbol = type.getSymbol();
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return null;
  const declarations = symbol.declarations;
  if (declarations.length === 0) return null;
  let pkg: string | null = null;
  for (const declaration of declarations) {
    const file = ts.getSourceFileOfNode(declaration);
    if (!isJsSourceFile(file)) return null;
    const owner = npmStaticPackageOfPath(file.fileName);
    if (owner === null || (pkg !== null && owner !== pkg)) return null;
    pkg = owner;
  }
  if (pkg === null || lowerer.checker.getPropertyOfType(type, member) !== undefined) return null;
  const built = lowerer.checker.typeToString(type);
  const preposition = action === "writing" ? "on" : "from";
  return (
    `${action} '${member}' ${preposition} an object the JavaScript of package '${pkg}' built without that member ` +
    `(it built '${built}'; the package's types declare '${member}' and its code never creates it, ` +
    `so the compiled object has no place for it: run the package in a Node island with --node-island=${pkg}, ` +
    `where the object is Node's own)`
  );
}
