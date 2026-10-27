import * as ts from "./ts7/syntax.js";

/** One specifier's call-site kinds within a module — the edge-kind record
 * the walk's per-kind semantics act on. A specifier can appear under
 * several forms in one file; any STATIC occurrence makes the edge eager
 * (Node refuses the whole static graph at link time regardless of what the
 * lazy sites would have done). */
export interface SpecifierUse {
  specifier: string;
  /** import/export declaration — eager, link-time. */
  static: boolean;
  /** require("x") — or an esbuild bundle's `__require("x")` helper call,
   * the shape published dists route external requires through — call-time.
   * The union of the two attribution flags below. */
  require: boolean;
  /** require sites whose require function lives in THIS file's scope: a
   * direct `require(…)` call (the chunk banner's createRequire), or a
   * `__require(…)` call when the helper is defined locally. */
  requireLocal: boolean;
  /** `__require(…)` sites whose helper is an IMPORTED binding — esbuild
   * splits it into a shared chunk, so the closed-over require was created
   * with THAT chunk's import.meta.url and Node resolves from there. The
   * edge must attribute to the defining chunk or the runtime lookup
   * misses. */
  requireViaHelper: boolean;
  /** import("x") — evaluation-time. */
  dynamicImport: boolean;

  importMetaResolve: boolean;
}

/** moduleSpecifiersOf's full answer: the per-specifier call-site kinds
 * plus where the file's `__require` binding comes from, when it is not
 * its own. */
export interface ModuleSpecifiers {
  uses: SpecifierUse[];
  /** The specifier `__require` is IMPORTED from (`import { __require }
   * from "./chunk-X.js"` — esbuild's shared-helper chunk shape), else
   * null (locally defined or absent). */
  requireHelperImport: string | null;
  /** The specifier `__require` is re-EXPORTED from (`export { __require }
   * from "./x"`) — the chain hop for bundles routing the helper through
   * an intermediate chunk. */
  requireHelperReexport: string | null;
}

/** Every module specifier `source` can load at runtime, in encounter
 * order with its call-site kinds merged per specifier: import/export
 * declarations (INCLUDING `export * as ns from "x"`, which
 * ts.preProcessFile omits — zod v4 re-exports its util namespace
 * that way), dynamic import("literal"), and require("literal") /
 * module.require("literal") / __require("literal") (esbuild's external-require helper — collecting its
 * literal call sites gives bundled dists an honest build-time inventory).
 * A real parse, never a regex. */
export function moduleSpecifiersOfFile(sf: ts.SourceFile): ModuleSpecifiers {
  const uses: SpecifierUse[] = [];
  const bySpec = new Map<string, SpecifierUse>();
  let requireHelperImport: string | null = null;
  let requireHelperReexport: string | null = null;
  /** Uses with `__require(…)` sites — attributed local vs helper AFTER the
   * walk, once the (hoisted) import declarations have all been seen. */
  const viaHelperIdent = new Set<SpecifierUse>();
  const push = (
    spec: string,
    kind: "static" | "requireLocal" | "dynamicImport" | null,
  ): SpecifierUse => {
    let use = bySpec.get(spec);
    if (!use) {
      use = {
        specifier: spec,
        static: false,
        require: false,
        requireLocal: false,
        requireViaHelper: false,
        dynamicImport: false,
        importMetaResolve: false,
      };
      bySpec.set(spec, use);
      uses.push(use);
    }
    if (kind === "static") use.static = true;
    else if (kind === "requireLocal") use.requireLocal = true;
    else if (kind === "dynamicImport") use.dynamicImport = true;
    return use;
  };
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      push(n.moduleSpecifier.text, "static");
      if (
        ts.isImportDeclaration(n) &&
        n.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(n.importClause.namedBindings) &&
        n.importClause.namedBindings.elements.nodes.some((el) => el.name.text === "__require")
      ) {
        requireHelperImport = n.moduleSpecifier.text;
      }
      if (
        ts.isExportDeclaration(n) &&
        n.exportClause !== undefined &&
        ts.isNamedExports(n.exportClause) &&
        n.exportClause.elements.nodes.some(
          (el) => (el.propertyName ?? el.name).text === "__require",
        )
      ) {
        requireHelperReexport = n.moduleSpecifier.text;
      }
    } else if (ts.isCallExpression(n)) {
      const arg = n.arguments.nodes[0];
      if (
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg)
      ) {
        push(arg.text, "dynamicImport");
      } else if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "resolve" &&
        ts.isMetaProperty(n.expression.expression) &&
        n.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        n.arguments.nodes.length >= 1 &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg)
      ) {
        push(arg.text, null).importMetaResolve = true;
      } else if (
        ((ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "require") ||
          (ts.isElementAccessExpression(n.expression) &&
            n.expression.argumentExpression !== undefined &&
            ts.isStringLiteralLike(n.expression.argumentExpression) &&
            n.expression.argumentExpression.text === "require")) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === "module" &&
        n.arguments.nodes.length === 1 &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg)
      ) {
        push(arg.text, "requireLocal");
      } else if (
        ts.isIdentifier(n.expression) &&
        (n.expression.text === "require" || n.expression.text === "__require") &&
        n.arguments.nodes.length === 1 &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg)
      ) {
        if (n.expression.text === "__require") {
          // local vs imported-helper attribution is decided after the walk
          viaHelperIdent.add(push(arg.text, null));
        } else {
          push(arg.text, "requireLocal");
        }
      }
    }
  };
  ts.walkPreorder(sf, (node) => {
    visit(node);
  });
  for (const use of viaHelperIdent) {
    if (requireHelperImport !== null) use.requireViaHelper = true;
    else use.requireLocal = true;
  }
  for (const use of uses) use.require = use.requireLocal || use.requireViaHelper;
  return { uses, requireHelperImport, requireHelperReexport };
}

export function sourceImportsOfFile(sf: ts.SourceFile): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(n)
        ? (n.importClause?.isTypeOnly ?? false)
        : n.isTypeOnly;
      out.push({ spec: n.moduleSpecifier.text, typeOnly });
    } else if (ts.isCallExpression(n)) {
      const arg = n.arguments.nodes[0];
      if (
        arg !== undefined &&
        ts.isStringLiteralLike(arg) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) &&
            n.expression.text === "require" &&
            n.arguments.nodes.length === 1))
      ) {
        out.push({ spec: arg.text, typeOnly: false });
      }
    }
  };
  ts.walkPreorder(sf, (node) => {
    visit(node);
  });
  return out;
}
