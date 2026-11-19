/** Select the first frontend shared by build and coverage. Installed package
 * declarations may resolve a use outside a partial shim's native surface. */
import type { NodeIslandPolicy } from "../node-islands/policy.js";
import * as ts from "./ts7/adapter.js";
import type { LoadResult } from "./program.js";
import { isJsSourceFileName } from "./tsc-codes.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";
import { hasPartialShim, isPackageShimFile, partialShimEntries } from "./package-shims.js";
import type { Frontend } from "./pipeline.js";

// Missing members, type-only re-exports used as values, and literal index access.
const MEMBER_DIAGNOSTICS = new Set([1362, 2305, 2339, 2551, 2614, 2724, 7053]);

function fallbackSites(fe: Frontend): Set<string> {
  const sites = new Set<string>();
  for (const d of fe.preflight) {
    if (d.code === "SC0001") sites.add(`${d.loc.file}\0${d.loc.start}`);
  }
  for (const site of fe.admittedOpinions ?? []) {
    if (MEMBER_DIAGNOSTICS.has(site.code)) sites.add(`${site.file}\0${site.pos}`);
  }
  return sites;
}

const SHIM_READ_KINDS = new Set([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.BinaryExpression,
]);

/** The checker can omit JS diagnostics for a real value read, notably in
 * unchecked JS and bracket accesses. Compare the two modules' value exports
 * and resolve the receiver so an unrelated object's keys cannot select an island. */
export function usesInstalledShimValue(load: LoadResult, name: string): boolean {
  const program = load.program;
  const checker = program.getTypeChecker();
  for (const sf of new Set([load.entry, ...load.moduleOrder])) {
    if (
      isPackageShimFile(sf.fileName) ||
      !ts.sourceTextIncludes(sf, name) ||
      !moduleSourceCandidates(program, sf).specifiers.includes(name)
    )
      continue;
    const paths = partialShimEntries(sf.fileName, name);
    if (paths === null) continue;
    const native = program.getSourceFile(paths.runtime);
    const installed = program.getSourceFile(paths.declarations);
    if (native === undefined || installed === undefined) continue;
    const nativeModule = checker.getSymbolAtLocation(native);
    const module = checker.getSymbolAtLocation(installed);
    if (nativeModule === undefined || module === undefined) continue;
    const nativeNames = new Set(checker.getExportsOfModule(nativeModule).map(ts.symbolName));
    const extra = new Set<string>();
    for (const member of checker.getExportsOfModule(module)) {
      const key = ts.symbolName(member);
      if (nativeNames.has(key)) continue;
      const value = member.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(member) : member;
      if (value.flags & ts.SymbolFlags.Value) extra.add(key);
    }
    const defaultExport = nativeModule.getExports().get(ts.escapedSymbolName("default"));
    const defaultModule =
      defaultExport && defaultExport.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(defaultExport)
        : undefined;
    const namespaceFiles = new Set([installed.fileName]);
    for (const decl of defaultModule?.declarations ?? []) {
      if (ts.isSourceFile(decl)) namespaceFiles.add(decl.fileName);
    }
    const isPackageObject = (receiver: ts.Expression) =>
      checker
        .getTypeAtLocation(receiver)
        .getSymbol()
        ?.declarations.some((decl) => ts.isSourceFile(decl) && namespaceFiles.has(decl.fileName)) ??
      false;
    let found = false;
    ts.walkPreorder(
      sf,
      (node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === name &&
          node.importClause &&
          !node.importClause.isTypeOnly &&
          isJsSourceFileName(sf.fileName)
        ) {
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            found = bindings.elements.nodes.some((e) => extra.has((e.propertyName ?? e.name).text));
        } else if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === name &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          isJsSourceFileName(sf.fileName)
        ) {
          found = node.exportClause.elements.nodes.some((e) =>
            extra.has((e.propertyName ?? e.name).text),
          );
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer
        ) {
          found =
            node.name.elements.nodes.some((e) => {
              const key = e.propertyName ?? e.name;
              return (
                !e.dotDotDotToken &&
                (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
                extra.has(key.text)
              );
            }) && isPackageObject(node.initializer);
        } else {
          let key: string;
          let receiver: ts.Expression;
          if (ts.isPropertyAccessExpression(node)) {
            key = node.name.text;
            receiver = node.expression;
          } else if (
            ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression)
          ) {
            key = node.argumentExpression.text;
            receiver = node.expression;
          } else if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
            ts.isStringLiteralLike(node.left)
          ) {
            key = node.left.text;
            receiver = node.right;
          } else return undefined;
          found = extra.has(key) && isPackageObject(receiver);
        }
        return found ? "stop" : undefined;
      },
      SHIM_READ_KINDS,
    );
    if (found) return true;
  }
  return false;
}

export function loadWithShimFallback(
  policy: NodeIslandPolicy,
  load: (islandShims: ReadonlySet<string>) => Frontend,
): Frontend {
  let selected = new Set([...policy.forcedNode.keys()].filter(hasPartialShim));
  let fe = load(selected);
  if (policy.mode !== "auto") return fe;

  for (const name of fe.loadedIslandShims?.() ?? []) {
    if (policy.forcedNative.has(name) || selected.has(name)) continue;
    const linked = fe.usesInstalledShimValue?.(name) === true;
    const sites = fallbackSites(fe);
    if (!linked && sites.size === 0) continue;
    fe.dispose();
    const trial = new Set([...selected, name]);
    fe = load(trial);
    const remaining = fallbackSites(fe);
    if (linked || [...sites].some((site) => !remaining.has(site))) {
      selected = trial;
    } else {
      fe.dispose();
      fe = load(selected);
    }
  }
  const scan = fe.nodeIslandScan;
  const automatic = [...selected].filter((name) => !policy.forcedNode.has(name));
  if (scan === undefined || automatic.length === 0) return fe;
  return {
    ...fe,
    nodeIslandScan(options) {
      const result = scan(options);
      return {
        ...result,
        shimFallbacks: automatic.filter((name) =>
          result.edges.some((e) => !e.shim && e.to === name),
        ),
      };
    },
  };
}
