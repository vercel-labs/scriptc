/* Requires of polyfill packages that ARE a Node builtin on Node 24
 * (builtin-package-aliases.ts) compile as the builtin expression, at the
 * require's position. Two spellings reach here:
 *
 * - an installed package: `require("isarray")` (or a subpath such as
 *   `require("readable-stream/transform")`) in an opted-in package's file,
 *   matched against the version installed where Node's resolution from
 *   that file would find it;
 * - a bundled __commonJS chunk whose path key names the package and its
 *   version (npm-static-bundled-chunks.ts): each `require_x()` call.
 *
 * For a module whose export carries another object's members
 * (readable-stream's entry is stream.Readable with Stream's classes copied
 * onto it), the replacement depends on how the result is used: member reads
 * of the carried names read the builtin module's members, value uses read
 * the class itself, and a mixture keeps the package's own JavaScript. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";
import {
  aliasReplacement,
  applyEdits,
  countDeclarations,
  unparen,
  type Edit,
} from "./npm-static-bundled-chunks.js";
import { BUILTIN_ALIAS_PACKAGES, type BuiltinAlias } from "./builtin-package-aliases.js";
import { packageNameOfSpecifier } from "./workspace-registry.js";

/** True when the text may require an aliased package (a cheap probe). */
export function mayRequireBuiltinAlias(source: string): boolean {
  if (!source.includes("require(")) return false;
  for (const name of BUILTIN_ALIAS_PACKAGES) if (source.includes(name)) return true;
  return false;
}

/** The module text with each `require("<aliased package>[/subpath]")`
 * respelled as its builtin, or null when none is. `aliasFor` answers the
 * alias for a specifier as resolved from this file. */
export function rewriteBuiltinAliasRequires(
  sf: ts.SourceFile,
  aliasFor: (specifier: string) => BuiltinAlias | null,
): string | null {
  const edits: Edit[] = [];
  const declared = countDeclarations(sf, "require") > 0;
  if (declared) return null;
  ts.walkPreorder(sf, (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    if (
      !ts.isCallExpression(n) ||
      !ts.isIdentifier(n.expression) ||
      n.expression.text !== "require" ||
      n.arguments.nodes.length !== 1
    )
      return undefined;
    const arg = unparen(n.arguments.nodes[0]!);
    if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return undefined;
    const spec = arg.text;
    if (!BUILTIN_ALIAS_PACKAGES.has(packageNameOfSpecifier(spec))) return undefined;
    const alias = aliasFor(spec);
    if (alias === null) return undefined;
    const text = aliasReplacement(n, alias);
    if (text !== null) edits.push({ start: tokenStartOfNode(n), end: n.end, text });
    return undefined;
  });
  if (edits.length === 0) return null;
  return applyEdits(sf.text, 0, sf.text.length, edits);
}
