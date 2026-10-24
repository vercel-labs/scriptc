/* The program-level half of the detector: which modules a program loads,
 * the pre-scan markers in each, and the package import edges the island
 * closure needs. The frontend calls it on its final program (and on the
 * program that still held a package the drop-and-reload loop removed). */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import * as ts from "../frontend/ts7/adapter.js";
import { canonicalBuiltinModule, npmBuiltinAliasOf } from "../frontend/builtin-modules.js";
import { erasedTypeOnlyImport } from "../frontend/type-only-imports.js";
import { isShimmedImport } from "../frontend/package-shims.js";
import { resolveBareModule } from "../frontend/resolve.js";
import { isJsSourceFileName } from "../frontend/tsc-codes.js";
import { isRelativeSpecifier, packageNameOfSpecifier } from "../frontend/workspace-registry.js";
import { moduleSourceCandidates } from "../frontend/module-source-candidates.js";
import { scanModule, type NodeIslandMarker } from "./detect.js";
import { originOf, packageDirOf, type Origin } from "./origin.js";

export interface ScannedModule {
  file: string;
  origin: Origin;
  /** The npm package directory, for npm modules. */
  packageDir: string | null;
  packageName: string | null;
  markers: NodeIslandMarker[];
  /** True for a module of a package the drop-and-reload loop removed. */
  dropped: boolean;
}

/** One import of an npm package. */
export interface PackageEdge {
  /** The importing package's directory; null for user code. */
  fromDir: string | null;
  fromFile: string;
  /** The imported package's name. */
  to: string;
  /** Its directory when the import resolves to installed JavaScript. */
  toDir: string | null;
  /** Served by a registry shim, a builtin alias, or marked unloaded. */
  shim: boolean;
  loc: SrcLoc;
}

/** How the drop-and-reload loop refused a package. */
export type RefusalKind = "preflight" | "offender" | "degrade" | "typecheck" | "external";

export interface RefusalRecord {
  package: string;
  kind: RefusalKind;
  /** The package-anchored preflight diagnostic, for kind "preflight". */
  diag: ScrDiagnostic | null;
}

export interface NodeIslandScan {
  modules: ScannedModule[];
  edges: PackageEdge[];
  refusals: RefusalRecord[];
}

export function emptyScan(): NodeIslandScan {
  return { modules: [], edges: [], refusals: [] };
}

function locOfNode(node: ts.Node): SrcLoc {
  const sf = ts.getSourceFileOfNode(node);
  return { file: sf.fileName, start: ts.tokenStartOfNode(node), end: node.end };
}

/** The literal module specifiers of a file with their sites: top-level
 * import and export declarations, and the require() and import() calls the
 * program's shared module-source scan already collected (no second walk). */
function specifiersOf(program: ts.Program, sf: ts.SourceFile): { spec: string; node: ts.Node }[] {
  const out: { spec: string; node: ts.Node }[] = [];
  for (const node of sf.statements.nodes) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // Type-only imports load nothing.
      const typeOnly = ts.isImportDeclaration(node) ? erasedTypeOnlyImport(node) : node.isTypeOnly;
      if (!typeOnly) out.push({ spec: node.moduleSpecifier.text, node });
    }
  }
  for (const call of moduleSourceCandidates(program, sf).calls) {
    const arg = call.arguments.nodes[0];
    if (
      arg !== undefined &&
      ts.isStringLiteralLike(arg) &&
      (call.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(call.expression) && call.expression.text === "require"))
    )
      out.push({ spec: arg.text, node: call });
  }
  return out;
}

/** Scans `files`: markers for npm JavaScript (and for user JavaScript when
 * `userJs`), and package edges for every file when `edges` (a program with
 * no npm package has none to find). */
export function scanFiles(
  program: ts.Program,
  files: readonly ts.SourceFile[],
  opts: { userJs: boolean; dropped: boolean; edges: boolean },
): { modules: ScannedModule[]; edges: PackageEdge[] } {
  const modules: ScannedModule[] = [];
  const edges: PackageEdge[] = [];
  const seen = new Set<string>();
  for (const sf of files) {
    if (seen.has(sf.fileName)) continue;
    seen.add(sf.fileName);
    const origin = originOf(sf.fileName);
    if (origin === "builtin" || origin === "shim") continue;
    const at = origin === "npm" ? packageDirOf(sf.fileName) : null;
    const js = isJsSourceFileName(sf.fileName);
    const markers = js && (origin === "npm" || opts.userJs) ? scanModule(sf) : [];
    modules.push({
      file: sf.fileName,
      origin,
      packageDir: at === null ? null : at.dir,
      packageName: at === null ? null : at.name,
      markers,
      dropped: opts.dropped,
    });
    if (!opts.edges) continue;
    for (const { spec, node } of specifiersOf(program, sf)) {
      if (isRelativeSpecifier(spec) || spec.startsWith("/") || spec.startsWith("#")) continue;
      // scriptc's own packages lower at their use sites.
      if (spec.startsWith("@scriptc/")) continue;
      const alias = npmBuiltinAliasOf(spec);
      if (alias === null && (spec.startsWith("node:") || canonicalBuiltinModule(spec) !== null))
        continue;
      const name = packageNameOfSpecifier(spec);
      const shim = alias !== null || isShimmedImport(sf.fileName, spec);
      let toDir: string | null = null;
      if (!shim) {
        const resolved = resolveBareModule(sf.fileName, spec, "js-only");
        if (resolved !== null) {
          const target = packageDirOf(resolved.typesFile);
          // A workspace package compiled from source is user code.
          if (target === null) continue;
          toDir = target.dir;
        }
      }
      edges.push({
        fromDir: at === null ? null : at.dir,
        fromFile: sf.fileName,
        to: name,
        toDir,
        shim,
        loc: locOfNode(node),
      });
    }
  }
  return { modules, edges };
}
