/* A package may declare that all of its published files have no module
 * evaluation side effects. For opted-in static npm packages, that promise
 * lets an unused `export * as name from "./module.js"` edge disappear just
 * as it does in a bundler. Keep the decision per tsgo program: preflight,
 * the link checks, and emitted module init headers must see one graph. */

import * as ts from "./ts7/adapter.js";
import { dirname, join, relative, resolve } from "node:path";
import { nearestPackageType, resolveBareModule } from "./resolve.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { trackedReadFile } from "./input-tracker.js";
import { npmPackageNameOf } from "./workspace-registry.js";
import { typeOnlyNamedImport } from "./type-only-imports.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";

export function isPrunedNpmReexport(program: ts.Program, stmt: ts.ExportDeclaration): boolean {
  return program.analysis.prunedNpmReexports.has(stmt);
}

type PackageJson = Record<string, unknown> | null;

/** Parsed package.json files by path, kept for one plan: every purity check
 * reads the metadata of its file's package again. */
type PackageJsonCache = Map<string, PackageJson>;

function packageJson(path: string, cache: PackageJsonCache): PackageJson {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const json = readPackageJson(path);
  cache.set(path, json);
  return json;
}

function readPackageJson(path: string): PackageJson {
  const source = trackedReadFile(path);
  if (source === null) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** sideEffects patterns use package-relative POSIX paths. A pattern with no
 * slash matches a basename at any depth, as in bundler package metadata. */
function sideEffectPattern(pattern: string): RegExp {
  // Unrecognized glob syntax must retain the module rather than
  // treating a possible side-effect match as a literal path.
  if (/[[\]\\!@+()]/.test(pattern)) throw new Error("unsupported sideEffects glob");
  pattern = pattern.replace(/^\.\//, "");
  if (!pattern.includes("/")) pattern = "**/" + pattern;
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        source += "(?:.*/)?";
        i++;
      } else source += ".*";
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") source += "(?:";
    else if (ch === "}") source += ")";
    else if (ch === ",") source += "|";
    else source += ch.replace(/[\\^$+?.()|[\]]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

/** A nested format scope such as dist/esm/package.json is not the package's
 * published metadata. Stay inside the resolved package while finding its
 * named root, including pnpm's realpath and workspace-linked installs. */
function packageRootJsonPath(
  fromFile: string,
  packageName: string,
  cache: PackageJsonCache,
): string | null {
  let dir = dirname(resolve(fromFile));
  let root: string | null = null;
  while (npmPackageNameOf(dir.replaceAll("\\", "/")) === packageName) {
    const path = join(dir, "package.json");
    if (packageJson(path, cache)?.["name"] === packageName) root = path;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

// An external package's executable sources may not be in this program.
// Preserve the conservative whole-dependency promise in that case.
function pureExternalPackage(
  path: string,
  cache: PackageJsonCache,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(path)) return true;
  const json = packageJson(path, cache);
  const value = json?.["sideEffects"];
  if (json === null || !(value === false || (Array.isArray(value) && value.length === 0)))
    return false;
  visiting.add(path);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = json[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      const resolved = resolveBareModule(path, name, "js-only");
      const root = resolved === null ? null : packageRootJsonPath(resolved.typesFile, name, cache);
      if (root === null || !pureExternalPackage(root, cache, visiting)) return false;
    }
  }
  return true;
}

type Demand = Set<string> | null; // null requests the entire namespace

/** One module edge of a package file, resolved once per plan. */
interface ModuleEdge {
  spec: string;
  dep: ts.SourceFile | null;
}

/** A file's runtime module edges: its import declarations with the names
 * they request (null: the whole module), its `export … from` declarations,
 * and its `import()` and `require()` calls with one string argument. */
interface ModuleEdges {
  imports: (ModuleEdge & { names: readonly string[] | null })[];
  reexports: (ModuleEdge & { stmt: ts.ExportDeclaration })[];
  calls: ModuleEdge[];
}

/** Package files outside the demanded module graph are absent from the
 * executable program. All ordinary project files retain their preflight
 * behavior, including files not imported by the entry. */
export function planNpmStaticReexports(
  program: ts.Program,
  entry: ts.SourceFile,
  files: readonly ts.SourceFile[],
  extraRoots: readonly string[],
  resolveEdge: (
    from: ts.SourceFile,
    spec: string,
    resolutionKind?: "import" | "require",
  ) => ts.SourceFile | null,
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

  // The demand walk visits a file again whenever another of its names is
  // requested, and every purity check walks the files it reaches: both read
  // these edges instead of resolving the file's syntax each time.
  const edgeMemo = new Map<ts.SourceFile, ModuleEdges>();
  const edgesOf = (sf: ts.SourceFile): ModuleEdges => {
    const cached = edgeMemo.get(sf);
    if (cached !== undefined) return cached;
    const edges: ModuleEdges = { imports: [], reexports: [], calls: [] };
    for (const stmt of sf.statements.nodes) {
      if (ts.isImportDeclaration(stmt)) {
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const clause = stmt.importClause;
        if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
        const spec = stmt.moduleSpecifier.text;
        let names: string[] | null = null;
        if (
          clause !== undefined &&
          (clause.namedBindings === undefined ||
            !(
              ts.isNamespaceImport(clause.namedBindings) ||
              (ts.isNamedImports(clause.namedBindings) &&
                clause.namedBindings.elements.nodes.length === 0)
            )) &&
          // `import { type A }` still loads the module, like `import {}`.
          !typeOnlyNamedImport(stmt)
        ) {
          names = [];
          if (clause.name !== undefined) names.push("default");
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements.nodes) {
              if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
            }
          }
        }
        edges.imports.push({ spec, dep: resolveEdge(sf, spec), names });
      } else if (ts.isExportDeclaration(stmt)) {
        // `export { type A } from` still loads the module under Node's
        // type stripping; only `export type … from` erases.
        if (
          stmt.isTypeOnly ||
          stmt.moduleSpecifier === undefined ||
          !ts.isStringLiteral(stmt.moduleSpecifier)
        )
          continue;
        const spec = stmt.moduleSpecifier.text;
        edges.reexports.push({ spec, dep: resolveEdge(sf, spec), stmt });
      }
    }
    for (const node of moduleSourceCandidates(program, sf).calls) {
      if (node.arguments.nodes.length !== 1) continue;
      const arg = node.arguments.nodes[0];
      if (arg === undefined || !ts.isStringLiteralLike(arg)) continue;
      const kind =
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "import"
          : ts.isIdentifier(node.expression) && node.expression.text === "require"
            ? "require"
            : null;
      if (kind !== null) edges.calls.push({ spec: arg.text, dep: resolveEdge(sf, arg.text, kind) });
    }
    edgeMemo.set(sf, edges);
    return edges;
  };

  for (const sf of files) {
    if (npmStaticPackageOfPath(sf.fileName) === null) request(sf, null);
  }
  request(entry, null);
  for (const path of extraRoots) request(program.getSourceFile(path) ?? null, null);

  const pureMemo = new Map<ts.SourceFile, boolean>();
  const packageJsons: PackageJsonCache = new Map();
  const filePure = (sf: ts.SourceFile): boolean => {
    const pkg = npmPackageNameOf(sf.fileName) ?? npmStaticPackageOfPath(sf.fileName);
    const path = pkg === null ? null : packageRootJsonPath(sf.fileName, pkg, packageJsons);
    const json = path === null ? null : packageJson(path, packageJsons);
    const value = json?.["sideEffects"];
    if (value === false) return true;
    if (
      !Array.isArray(value) ||
      !value.every((pattern) => typeof pattern === "string") ||
      path === null
    )
      return false;
    const name = relative(dirname(path), sf.fileName).replaceAll("\\", "/");
    try {
      return !value.some((pattern: string) => sideEffectPattern(pattern).test(name));
    } catch {
      return false;
    }
  };
  // An edge this program does not resolve: the conservative
  // whole-dependency promise of the external package it names.
  const externalPure = (sf: ts.SourceFile, spec: string): boolean => {
    const resolved = resolveBareModule(sf.fileName, spec, "js-only");
    const pkg = resolved === null ? null : npmPackageNameOf(resolved.typesFile);
    const root =
      pkg === null || resolved === null
        ? null
        : packageRootJsonPath(resolved.typesFile, pkg, packageJsons);
    return root !== null && pureExternalPackage(root, packageJsons);
  };
  // Check the actual imported closure: metadata for one file never vouches
  // for its side-effectful descendants, even across a package or a cycle.
  // A file is pure when every file it reaches is. The walk finds the
  // strongly connected components of the module graph (Tarjan): a finished
  // component is pure as a whole. On the first impure file the walk stops,
  // and every file still on its stack reaches that file, so each is impure.
  const order = new Map<ts.SourceFile, number>();
  const stack: ts.SourceFile[] = [];
  /** The lowest order the file's walk reaches (Infinity for a finished
   * component), or -1 once it reaches an impure file. */
  const visit = (sf: ts.SourceFile): number => {
    const known = pureMemo.get(sf);
    if (known !== undefined) return known ? Infinity : -1;
    const seen = order.get(sf);
    if (seen !== undefined) return seen;
    if (!filePure(sf)) {
      pureMemo.set(sf, false);
      return -1;
    }
    const own = order.size;
    order.set(sf, own);
    stack.push(sf);
    let low = own;
    const edges = edgesOf(sf);
    for (const list of [edges.imports, edges.reexports, edges.calls]) {
      for (const edge of list) {
        const reached =
          edge.dep !== null ? visit(edge.dep) : externalPure(sf, edge.spec) ? low : -1;
        if (reached < 0) return -1;
        if (reached < low) low = reached;
      }
    }
    if (low === own) {
      for (;;) {
        const member = stack.pop()!;
        order.delete(member);
        pureMemo.set(member, true);
        if (member === sf) break;
      }
    }
    return low;
  };
  const pureModuleTree = (root: ts.SourceFile): boolean => {
    if (visit(root) >= 0) return true;
    for (const sf of stack) pureMemo.set(sf, false);
    stack.length = 0;
    order.clear();
    return false;
  };
  const canPrune = (
    sf: ts.SourceFile,
    stmt: ts.ExportDeclaration,
    dep: ts.SourceFile | null,
  ): boolean => {
    if (dep === null || stmt.exportClause === undefined || !ts.isNamespaceExport(stmt.exportClause))
      return false;
    const pkg = npmStaticPackageOfPath(sf.fileName);
    if (pkg === null || npmStaticPackageOfPath(dep.fileName) !== pkg) return false;
    if (nearestPackageType(sf.fileName) !== "module") return false;
    if (!pureModuleTree(dep)) return false;
    const names = demanded.get(sf);
    return names !== undefined && names !== null && !names.has(stmt.exportClause.name.text);
  };

  // A file is queued again only when its demand grows. Its imports and
  // calls request the same modules every time; only a namespace re-export
  // the new demand names stops being prunable.
  const walked = new Set<ts.SourceFile>();
  while (queue.length > 0) {
    const sf = queue.shift()!;
    const edges = edgesOf(sf);
    const first = !walked.has(sf);
    walked.add(sf);
    if (first) {
      for (const edge of edges.imports) {
        if (edge.names === null) request(edge.dep, null);
        else for (const name of edge.names) request(edge.dep, name);
      }
    }
    for (const edge of edges.reexports) {
      if (canPrune(sf, edge.stmt, edge.dep)) continue;
      request(edge.dep, null);
    }
    if (first) for (const edge of edges.calls) request(edge.dep, null);
  }

  const pruned = new Set<ts.ExportDeclaration>();
  for (const sf of demanded.keys()) {
    for (const edge of edgesOf(sf).reexports)
      if (canPrune(sf, edge.stmt, edge.dep)) pruned.add(edge.stmt);
  }
  program.analysis.prunedNpmReexports.clear();
  for (const stmt of pruned) program.analysis.prunedNpmReexports.add(stmt);
  return files.filter((sf) => npmStaticPackageOfPath(sf.fileName) === null || demanded.has(sf));
}
