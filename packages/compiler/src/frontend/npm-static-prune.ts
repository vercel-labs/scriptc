/* A package may declare that all of its published files have no module
 * evaluation side effects. For opted-in static npm packages, that promise
 * lets an unused `export * as name from "./module.js"` edge disappear just
 * as it does in a bundler. Keep the decision per tsgo program: preflight,
 * the link checks, and emitted module init headers must see one graph. */

import * as ts from "./ts7/adapter.js";
import { dirname, join, resolve } from "node:path";
import { nearestPackageType, resolveBareModule } from "./resolve.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { trackedReadFile } from "./input-tracker.js";
import { npmPackageNameOf } from "./workspace-registry.js";

const prunedByProgram = new WeakMap<ts.Program, ReadonlySet<ts.ExportDeclaration>>();

export function isPrunedNpmReexport(program: ts.Program, stmt: ts.ExportDeclaration): boolean {
  return prunedByProgram.get(program)?.has(stmt) ?? false;
}

function packageJson(path: string): Record<string, unknown> | null {
  const source = trackedReadFile(path);
  if (source === null) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function noSideEffects(value: unknown): boolean {
  return value === false || (Array.isArray(value) && value.length === 0);
}

/** A nested format scope such as dist/esm/package.json is not the package's
 * published metadata. Stay inside the resolved package while finding its
 * named root, including pnpm's realpath and workspace-linked installs. */
function packageRootJsonPath(fromFile: string, packageName: string): string | null {
  let dir = dirname(resolve(fromFile));
  let root: string | null = null;
  while (npmPackageNameOf(dir.replaceAll("\\", "/")) === packageName) {
    const path = join(dir, "package.json");
    if (packageJson(path)?.["name"] === packageName) root = path;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

/** A package's own sideEffects declaration cannot cover imports of a
 * dependency that runs at module init. Require the whole declared runtime
 * dependency tree to make the same promise before removing an edge. A cycle
 * back-edge is provisionally pure, but its result cannot be cached for a
 * descendant until all dependencies of the ancestor have been checked. */
type PackagePurity = { pure: boolean; provisional: boolean };

function purePackageTree(
  path: string,
  memo: Map<string, boolean>,
  visiting: Set<string>,
): PackagePurity {
  const cached = memo.get(path);
  if (cached !== undefined) return { pure: cached, provisional: false };
  if (visiting.has(path)) return { pure: true, provisional: true };
  const json = packageJson(path);
  if (json === null || !noSideEffects(json["sideEffects"])) {
    memo.set(path, false);
    return { pure: false, provisional: false };
  }
  visiting.add(path);
  let pure = true;
  let provisional = false;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = json[field];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies as Record<string, unknown>)) {
      const resolved = resolveBareModule(path, name, "js-only");
      const depPath = resolved === null ? null : packageRootJsonPath(resolved.typesFile, name);
      const dep = depPath === null ? { pure: false, provisional: false } : purePackageTree(depPath, memo, visiting);
      if (!dep.pure) {
        pure = false;
        break;
      }
      provisional ||= dep.provisional;
    }
    if (!pure) break;
  }
  visiting.delete(path);
  // False is final. A true result is final only when it did not borrow an
  // ancestor's optimistic back-edge, or when the entire traversal is done.
  if (!pure || !provisional || visiting.size === 0) memo.set(path, pure);
  return { pure, provisional };
}

type Demand = Set<string> | null; // null requests the entire namespace

/** Package files outside the demanded module graph are absent from the
 * executable program. All ordinary project files retain their preflight
 * behavior, including files not imported by the entry. */
export function planNpmStaticReexports(
  program: ts.Program,
  entry: ts.SourceFile,
  files: readonly ts.SourceFile[],
  extraRoots: readonly string[],
  resolveEdge: (from: ts.SourceFile, spec: string) => ts.SourceFile | null,
): ts.SourceFile[] {
  const available = new Set(files);
  const demanded = new Map<ts.SourceFile, Demand>();
  const queue: ts.SourceFile[] = [];
  const request = (sf: ts.SourceFile | null, name: string | null): void => {
    if (sf === null || !available.has(sf)) return;
    if (npmStaticPackageOfPath(sf.fileName) === null) name = null;
    const previous = demanded.get(sf);
    if (previous === null) return;
    if (previous === undefined) {
      demanded.set(sf, name === null ? null : new Set([name]));
      queue.push(sf);
    } else if (name === null) {
      demanded.set(sf, null);
      queue.push(sf);
    } else if (!previous.has(name)) {
      previous.add(name);
      queue.push(sf);
    }
  };

  for (const sf of files) {
    if (npmStaticPackageOfPath(sf.fileName) === null) request(sf, null);
  }
  request(entry, null);
  for (const path of extraRoots) request(program.getSourceFile(path) ?? null, null);

  const pureMemo = new Map<string, boolean>();
  const canPrune = (sf: ts.SourceFile, stmt: ts.ExportDeclaration, dep: ts.SourceFile | null): boolean => {
    if (dep === null || stmt.exportClause === undefined || !ts.isNamespaceExport(stmt.exportClause)) return false;
    const pkg = npmStaticPackageOfPath(sf.fileName);
    if (pkg === null || npmStaticPackageOfPath(dep.fileName) !== pkg) return false;
    const pkgPath = packageRootJsonPath(sf.fileName, pkg);
    if (pkgPath === null) return false;
    if (nearestPackageType(sf.fileName) !== "module") return false;
    if (!purePackageTree(pkgPath, pureMemo, new Set()).pure) return false;
    const names = demanded.get(sf);
    return names !== undefined && names !== null && !names.has(stmt.exportClause.name.text);
  };

  while (queue.length > 0) {
    const sf = queue.shift()!;
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const clause = stmt.importClause;
        if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
        const dep = resolveEdge(sf, stmt.moduleSpecifier.text);
        if (
          clause === undefined ||
          (clause.namedBindings !== undefined && (
            ts.isNamespaceImport(clause.namedBindings) ||
            ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length === 0
          ))
        ) {
          request(dep, null);
        } else {
          if (clause.name !== undefined) request(dep, "default");
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              if (!element.isTypeOnly) request(dep, (element.propertyName ?? element.name).text);
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt)) {
        if (
          stmt.isTypeOnly ||
          (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause) &&
            stmt.exportClause.elements.length > 0 && stmt.exportClause.elements.every((element) => element.isTypeOnly)) ||
          stmt.moduleSpecifier === undefined || !ts.isStringLiteral(stmt.moduleSpecifier)
        ) continue;
        const dep = resolveEdge(sf, stmt.moduleSpecifier.text);
        if (canPrune(sf, stmt, dep)) continue;
        request(dep, null);
      }
    }
    ts.walkPreorder(sf, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isStringLiteralLike(arg)) return undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === "require") {
        request(resolveEdge(sf, arg.text), null);
      }
      return undefined;
    });
  }

  const pruned = new Set<ts.ExportDeclaration>();
  for (const sf of demanded.keys()) {
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier === undefined || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (canPrune(sf, stmt, resolveEdge(sf, stmt.moduleSpecifier.text))) pruned.add(stmt);
    }
  }
  prunedByProgram.set(program, pruned);
  return files.filter((sf) => npmStaticPackageOfPath(sf.fileName) === null || demanded.has(sf));
}
