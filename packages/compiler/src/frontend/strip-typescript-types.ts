/* module.stripTypeScriptTypes(code) in Node's `strip` mode.
 *
 * Node (amaro, SWC's strip-only) removes the type syntax by replacing it with
 * spaces, so every other byte of the program keeps its position: `const x:
 * number = 1;` answers `const x         = 1;`. This module reproduces that
 * over the compiler's own TS parse: it walks the tree, records the span of
 * each type-only construct, and blanks the span (newlines kept). The syntax
 * Node refuses in strip mode — enums, namespaces, parameter properties — is
 * refused here with Node's code.
 */
import * as ts from "./ts7/adapter.js";
import { parseSourceFile } from "./ts7/source-parser-node.js";

/** Node's error for syntax the strip mode cannot erase. */
export const STRIP_UNSUPPORTED_CODE = "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";

export class StripUnsupportedSyntax extends Error {
  readonly code = STRIP_UNSUPPORTED_CODE;
}

const NEVER_BLANKED = new Set(["\n", "\r"]);

function blank(source: string, spans: readonly (readonly [number, number])[]): string {
  const out = source.split("");
  for (const [start, end] of spans) {
    for (let i = Math.max(0, start); i < Math.min(out.length, end); i++) {
      const ch = out[i]!;
      if (!NEVER_BLANKED.has(ch)) out[i] = " ";
    }
  }
  return out.join("");
}

/** Whether `node` is a parameter property (`constructor(private x: T)`),
 * which Node refuses to strip: Node would have to rewrite the constructor. */
function isParameterProperty(node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.Parameter) return false;
  const modifiers = (node as { modifiers?: { nodes?: readonly ts.Node[] } }).modifiers;
  return (modifiers?.nodes ?? []).some((m) => {
    const kind = m.kind;
    return (
      kind === ts.SyntaxKind.PublicKeyword ||
      kind === ts.SyntaxKind.PrivateKeyword ||
      kind === ts.SyntaxKind.ProtectedKeyword ||
      kind === ts.SyntaxKind.ReadonlyKeyword
    );
  });
}

/** The span of a type annotation: from the anchor token (a name, or the
 * parameter list's closing parenthesis) through the type, so `?`, `:` and the
 * type itself all blank together. */
function annotationSpan(node: ts.Node, source: string): readonly [number, number] | null {
  const type = (node as { type?: ts.Node }).type;
  if (type === undefined || typeof type?.kind !== "number") return null;
  const parameters = (node as { parameters?: { end?: number } }).parameters;
  const name = (node as { name?: { end?: number } }).name;
  if (parameters !== undefined && typeof parameters?.end === "number") {
    // The parameter list's end points at its closing parenthesis.
    const end = source[parameters.end] === ")" ? parameters.end + 1 : parameters.end;
    return [end, type.end!];
  }
  if (name !== undefined && typeof name?.end === "number") return [name.end, type.end!];
  return [type.pos, type.end!];
}

/** Node's strip-mode answer for `source`, or a StripUnsupportedSyntax error. */
export function stripTypeScriptTypesStrip(source: string): string {
  const file = parseSourceFile("strip-typescript-types.ts", source, "ts");
  const spans: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    const kind = node.kind;
    switch (kind) {
      case ts.SyntaxKind.EnumDeclaration:
      case ts.SyntaxKind.ModuleDeclaration:
        throw new StripUnsupportedSyntax(
          kind === ts.SyntaxKind.EnumDeclaration
            ? "TypeScript enum is not supported in strip-only mode"
            : "TypeScript namespace declaration is not supported in strip-only mode",
        );
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
        // The whole declaration blanks, leaving its newline in place.
        spans.push([node.pos, node.end!]);
        return;
      case ts.SyntaxKind.ImportDeclaration: {
        const clause = (node as { importClause?: { isTypeOnly?: boolean } }).importClause;
        if (clause?.isTypeOnly === true) spans.push([node.pos, node.end!]);
        break;
      }
      case ts.SyntaxKind.ExportDeclaration:
        if ((node as { isTypeOnly?: boolean }).isTypeOnly === true)
          spans.push([node.pos, node.end!]);
        break;
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression: {
        const expression = (node as { expression: ts.Node }).expression;
        spans.push([expression.end!, node.end!]);
        break;
      }
      case ts.SyntaxKind.NonNullExpression: {
        // `value!` blanks the assertion, keeping the value.
        const expression = (node as { expression: ts.Node }).expression;
        spans.push([expression.end!, node.end!]);
        break;
      }
      default:
        break;
    }
    if (isParameterProperty(node))
      throw new StripUnsupportedSyntax(
        "TypeScript parameter property is not supported in strip-only mode",
      );
    const annotation = annotationSpan(node, source);
    if (annotation !== null) spans.push([annotation[0], annotation[1]]);
    for (const list of [
      (node as { typeArguments?: { pos?: number; end?: number } }).typeArguments,
      (node as { typeParameters?: { pos?: number; end?: number } }).typeParameters,
    ]) {
      if (list === undefined || typeof list?.pos !== "number" || typeof list?.end !== "number")
        continue;
      // The list's pos/end sit inside its angle brackets: blank them too.
      spans.push([Math.max(0, list.pos - 1), list.end + 1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return blank(source, spans);
}
