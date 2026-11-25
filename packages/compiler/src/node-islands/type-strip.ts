/* Node runs TypeScript by erasing types in place ("strip" mode: process.
 * features.typescript === "strip" in the embedded libnode). It refuses
 * syntax that needs a transform (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) and it
 * resolves relative imports only with their written extension, so a module
 * that needs either cannot run in a Node island as written (H3.5). The
 * checks are syntactic except the ones for a binding that names only a
 * type without saying so, which need the checker: Node erases only what is
 * written as a type, so it keeps a plain `import T`, `import { T }`,
 * `export { T }` or `export default T` of a type and fails when it loads
 * the module (the binding does not exist) or runs it (the name is not
 * defined). */
import type { SrcLoc } from "../ir/ir.js";
import * as ts from "../frontend/ts7/adapter.js";

export interface StripProblem {
  /** The construct, as a short phrase for the SC8006 message. */
  construct: string;
  loc: SrcLoc;
}

/** Extensions Node's type-stripping loader resolves for a relative
 * specifier. Node requires one for an ES module specifier, written in
 * full. */
const RESOLVED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];

function locOf(node: ts.Node): SrcLoc {
  return {
    file: ts.getSourceFileOfNode(node).fileName,
    start: ts.tokenStartOfNode(node),
    end: node.end,
  };
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

function hasResolvedExtension(spec: string): boolean {
  const clean = spec.replace(/[?#].*$/, "");
  return RESOLVED_EXTENSIONS.some((extension) => clean.endsWith(extension));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return node.modifiers?.nodes.some((modifier) => modifier.kind === kind) ?? false;
}

/** Whether a namespace/module declaration has runtime values (anything
 * besides types and other ambient declarations). */
function namespaceHasValues(body: ts.Node | undefined): boolean {
  if (body === undefined) return false;
  if (ts.isModuleDeclaration(body)) return true;
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.nodes.some((statement) => !isTypeOnlyStatement(statement));
}

function isTypeOnlyStatement(statement: ts.Node): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (ts.isModuleDeclaration(statement)) return !namespaceHasValues(statement.body);
  return false;
}

/** Whether the name an import or export binding introduces (or the name an
 * `export default` names) has a value meaning, following alias symbols;
 * null when the checker does not resolve it. */
function namesValue(checker: ts.TypeChecker, name: ts.Node): boolean | null {
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol === undefined) return null;
  const seen = new Set<ts.Symbol>();
  while ((symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return (symbol.flags & ts.SymbolFlags.Value) !== 0;
}

/** The first construct in `sf` that Node cannot run with type stripping
 * only, or null. Only called for a user TypeScript module the pre-scan
 * marked as patching a builtin, so the walk costs nothing elsewhere. */
export function stripProblem(program: ts.Program, sf: ts.SourceFile): StripProblem | null {
  let checker: ts.TypeChecker | null = null;
  let found: StripProblem | null = null;
  ts.walkPreorder(sf, (node) => {
    if (found !== null) return "stop";
    const report = (construct: string): void => {
      found = { construct, loc: locOf(node) };
    };
    if (ts.isEnumDeclaration(node)) {
      if (!hasModifier(node, ts.SyntaxKind.DeclareKeyword)) report("an 'enum' declaration");
      return undefined;
    }
    if (ts.isModuleDeclaration(node)) {
      if (!hasModifier(node, ts.SyntaxKind.DeclareKeyword) && namespaceHasValues(node.body))
        report("a 'namespace' declaration with values");
      return undefined;
    }
    if (ts.isConstructorDeclaration(node)) {
      for (const parameter of node.parameters.nodes) {
        if (
          parameter.modifiers?.nodes.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.PublicKeyword ||
              modifier.kind === ts.SyntaxKind.PrivateKeyword ||
              modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
              modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
          ) === true
        ) {
          report("a constructor parameter property");
          return undefined;
        }
      }
      return undefined;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      report("an 'import = require()' declaration");
      return undefined;
    }
    if (ts.isExportAssignment(node) && node.isExportEquals === true) {
      report("an 'export =' assignment");
      return undefined;
    }
    if (
      node.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.Decorator) === true
    ) {
      report("a decorator");
      return undefined;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      report("JSX");
      return undefined;
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      // `import type` is erased whole, so Node never resolves its specifier.
      if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return undefined;
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (spec !== null && isRelativeSpecifier(spec) && !hasResolvedExtension(spec)) {
        report(`the relative import '${spec}' without a file extension`);
        return undefined;
      }
      if (clause === undefined) return undefined;
      // The default binding is as much a value import as a named one.
      const defaultName = clause.name;
      if (defaultName !== undefined) {
        checker ??= program.getTypeChecker();
        if (namesValue(checker, defaultName) === false) {
          found = {
            construct: `the default import of '${defaultName.text}', which is only a type (use \`import type\`)`,
            loc: locOf(defaultName),
          };
          return "stop";
        }
      }
      if (clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings))
        return undefined;
      checker ??= program.getTypeChecker();
      for (const element of clause.namedBindings.elements.nodes) {
        if (element.isTypeOnly) continue;
        if (namesValue(checker, element.name) === false) {
          found = {
            construct: `the import of '${element.name.text}', which is only a type (use \`import type\`)`,
            loc: locOf(element),
          };
          return "stop";
        }
      }
      return undefined;
    }
    if (ts.isExportAssignment(node)) {
      // `export default T` of an interface or a type alias: TypeScript's own
      // emit drops the statement, Node keeps it and T is not defined.
      if (ts.isIdentifier(node.expression)) {
        checker ??= program.getTypeChecker();
        if (namesValue(checker, node.expression) === false)
          report(
            `the default export of '${node.expression.text}', which is only a type (use \`export type { ${node.expression.text} as default }\`)`,
          );
      }
      return undefined;
    }
    if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      // `export type { T } from` and `export type * from` are erased whole.
      if (
        !node.isTypeOnly &&
        specifier !== undefined &&
        ts.isStringLiteral(specifier) &&
        isRelativeSpecifier(specifier.text) &&
        !hasResolvedExtension(specifier.text)
      ) {
        report(`the relative export from '${specifier.text}' without a file extension`);
        return undefined;
      }
      // `export { T }` and `export { T } from` of a type, without `type`.
      const exported = node.exportClause;
      if (node.isTypeOnly || exported === undefined || !ts.isNamedExports(exported))
        return undefined;
      for (const element of exported.elements.nodes) {
        if (element.isTypeOnly) continue;
        checker ??= program.getTypeChecker();
        if (namesValue(checker, element.name) === false) {
          found = {
            construct: `the export of '${element.name.text}', which is only a type (use \`export type\`)`,
            loc: locOf(element),
          };
          return "stop";
        }
      }
      return undefined;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.nodes.length > 0
    ) {
      const argument = node.arguments.nodes[0];
      if (
        argument !== undefined &&
        ts.isStringLiteral(argument) &&
        isRelativeSpecifier(argument.text) &&
        !hasResolvedExtension(argument.text)
      )
        report(`the relative import() of '${argument.text}' without a file extension`);
    }
    return undefined;
  });
  return found;
}
