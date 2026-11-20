/* Whether any source file of the program imports node:diagnostics_channel.
 * A console output call publishes its arguments on the console.<member>
 * channels only when some code in the program can subscribe to them, and a
 * subscriber can only exist after an import or require of the module. The
 * fact keeps a program that never imports it on the plain console lowering,
 * so the channel machinery and the runtime families it formats through are
 * not linked into it. */
import * as ts from "./ts7/adapter.js";

const MODULES: ReadonlySet<string> = new Set(["diagnostics_channel", "node:diagnostics_channel"]);

function moduleText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  const inner = ts.isStringLiteral(node) ? node : undefined;
  return inner === undefined ? null : inner.text;
}

function importsChannel(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier) && MODULES.has(specifier.text)) {
        found = true;
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(callee) && callee.text === "require";
      if (dynamic || required) {
        const text = moduleText(node.arguments.nodes[0]);
        if (text !== null && MODULES.has(text)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function programImportsDiagnosticsChannel(program: ts.Program): boolean {
  if (program.getSourceFiles().some(importsChannel)) return true;
  // A module imported through the CJS linker that is not in the source
  // files (an npm package's require) cannot subscribe: the compiler treats
  // such a module as its own body, whose own sources are in the program.
  return false;
}
