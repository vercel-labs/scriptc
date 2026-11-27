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
  readonly code: string;
  constructor(message: string, code: string = STRIP_UNSUPPORTED_CODE) {
    super(message);
    this.code = code;
  }
}

/** Node's pre-strip validation error for an `override` member whose class
 * does not extend another class. */
const OVERRIDE_WITHOUT_BASE =
  "This member cannot have an 'override' modifier because its containing class does not extend another class.";

function modifiersOf(node: ts.Node): readonly ts.Node[] {
  return (node as { modifiers?: { nodes?: readonly ts.Node[] } }).modifiers?.nodes ?? [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node).some((modifier) => modifier.kind === kind);
}

/** Whether a class declaration/expression extends a base class. */
function extendsBaseClass(node: ts.Node): boolean {
  const clauses = (node as { heritageClauses?: { nodes?: readonly ts.Node[] } }).heritageClauses
    ?.nodes;
  return (clauses ?? []).some(
    (clause) =>
      clause.kind === ts.SyntaxKind.HeritageClause &&
      (clause as { token?: number }).token === ts.SyntaxKind.ExtendsKeyword,
  );
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
      case ts.SyntaxKind.ModuleDeclaration: {
        // A `declare` declaration carries no runtime code and erases whole;
        // one without it is a runtime construct strip mode cannot rewrite.
        if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
          spans.push([node.getStart(), node.end!]);
          return;
        }
        throw new StripUnsupportedSyntax(
          kind === ts.SyntaxKind.EnumDeclaration
            ? "TypeScript enum is not supported in strip-only mode"
            : "TypeScript namespace declaration is not supported in strip-only mode",
        );
      }
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
        // The whole declaration blanks, keeping its leading comments and its
        // newline (getStart skips trivia).
        spans.push([node.getStart(), node.end!]);
        return;
      case ts.SyntaxKind.TypeAssertionExpression:
        // `<T>expr`: Node refuses the angle-bracket form.
        throw new StripUnsupportedSyntax(
          "The angle-bracket syntax for type assertions, `<T>expr`, is not supported in type strip mode. Instead, use the 'as' syntax: `expr as T`.",
        );
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.ExportSpecifier: {
        // `import { type A, b }`: the type-only specifier blanks with its
        // comma; the rest of the clause stays.
        if ((node as { isTypeOnly?: boolean }).isTypeOnly !== true) break;
        const start = node.getStart();
        let end = node.end!;
        while (source[end] === "," || source[end] === " ") end += 1;
        spans.push([start, end]);
        break;
      }
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
    const classMember = modifiersOf(node);
    for (const modifier of classMember) {
      switch (modifier.kind) {
        case ts.SyntaxKind.PublicKeyword:
        case ts.SyntaxKind.PrivateKeyword:
        case ts.SyntaxKind.ProtectedKeyword:
        case ts.SyntaxKind.ReadonlyKeyword:
          // Accessibility and storage modifiers change only the type
          // surface; `static` stays (it is runtime).
          spans.push([modifier.getStart(), modifier.end!]);
          break;
        case ts.SyntaxKind.DeclareKeyword:
          // `declare x: T` on a class member is type-only: the whole member
          // erases, as it does in Node.
          spans.push([node.getStart(), node.end!]);
          break;
        case ts.SyntaxKind.OverrideKeyword:
          if (node.parent === undefined || !extendsBaseClass(node.parent))
            throw new StripUnsupportedSyntax(
              OVERRIDE_WITHOUT_BASE,
              "ERR_INVALID_TYPESCRIPT_SYNTAX",
            );
          spans.push([modifier.getStart(), modifier.end!]);
          break;
        case ts.SyntaxKind.AbstractKeyword:
          // On a class the keyword erases; on a member the whole member does.
          if (
            node.kind === ts.SyntaxKind.ClassDeclaration ||
            node.kind === ts.SyntaxKind.ClassExpression
          )
            spans.push([modifier.getStart(), modifier.end!]);
          else spans.push([node.getStart(), node.end!]);
          break;
        default:
          break;
      }
    }
    // `implements A, B` is type-only.
    const clauses = (node as { heritageClauses?: { nodes?: readonly ts.Node[] } }).heritageClauses
      ?.nodes;
    for (const clause of clauses ?? []) {
      if ((clause as { token?: number }).token === ts.SyntaxKind.ImplementsKeyword)
        spans.push([clause.getStart(), clause.end!]);
    }
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
