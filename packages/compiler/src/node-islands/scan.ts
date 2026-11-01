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
import { scanModuleFacts, type CjsRead, type NodeIslandMarker } from "./detect.js";
import { stripProblem, type StripProblem } from "./type-strip.js";
import { originOf, packageDirOf, type Origin } from "./origin.js";

export interface ScannedModule {
  file: string;
  origin: Origin;
  /** The npm package directory, for npm modules. */
  packageDir: string | null;
  packageName: string | null;
  markers: NodeIslandMarker[];
  /** Members the module reads through a builtin's CommonJS object (H3.4). */
  cjsReads: CjsRead[];
  /** A user TypeScript module with a `builtin-patch` marker that Node
   * cannot run with type stripping only (H3.5): it stays native. */
  stripProblem: StripProblem | null;
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
  /** Whether loading the importing module loads this package: a static
   * import or re-export, or a top-level require() call outside any condition.
   * A require() inside a function, a loop, a try block or a condition, and a
   * dynamic import(), load it only when that code runs. */
  loads: boolean;
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

/** True when `require` names the CommonJS loader Node provides. A binding the
 * file declares itself (a parameter, a variable, an import) shadows it and
 * loads nothing. */
function isNodeRequire(program: ts.Program, identifier: ts.Identifier): boolean {
  const symbol = program.getTypeChecker().getSymbolAtLocation(identifier);
  return (symbol?.declarations ?? []).every((d) => ts.getSourceFileOfNode(d).isDeclarationFile);
}

/** True when a function expression runs where it is written: it is the callee
 * of a call, parentheses aside. An arrow handed to a call as a callback, or
 * stored in a variable, runs only when something calls it. */
function runsInPlace(fn: ts.Node): boolean {
  let callee: ts.Node = fn;
  while (callee.parent !== undefined && ts.isParenthesizedExpression(callee.parent))
    callee = callee.parent;
  const call = callee.parent;
  return call !== undefined && ts.isCallExpression(call) && call.expression === callee;
}

/** True when a call runs whenever its module evaluates: every node between it
 * and the module's top level is an expression that always evaluates its
 * operands, or a top-level statement. A function body, a condition, a short
 * circuit, a loop or a try block runs the call only when that code runs, so a
 * package it names is not loaded on evaluation. An arrow's expression body is
 * an expression like the ones above, but the arrow itself runs only where
 * something calls it, so an arrow the walk reaches has to be invoked in place
 * for the walk to go on. */
function loadsWithModule(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (node.parent !== undefined) {
    const parent: ts.Node = node.parent;
    if (ts.isSourceFile(parent)) return true;
    if (ts.isConditionalExpression(parent)) return false;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    )
      return false;
    // An arrow's expression body is an expression like the ones below, so
    // without this the walk steps out of a callback into whatever holds it:
    // an arrow that runs only when something calls it loads nothing here.
    if (ts.isArrowFunction(parent) && !runsInPlace(parent)) return false;
    if (
      !ts.isExpression(parent) &&
      !ts.isExpressionStatement(parent) &&
      !ts.isVariableStatement(parent) &&
      !ts.isVariableDeclarationList(parent) &&
      !ts.isExportAssignment(parent)
    )
      return false;
    node = parent;
  }
  return false;
}

/** The literal module specifiers of a file with their sites: top-level
 * import and export declarations, and the require() and import() calls the
 * program's shared module-source scan already collected (no second walk). */
function specifiersOf(
  program: ts.Program,
  sf: ts.SourceFile,
): { spec: string; node: ts.Node; loads: boolean }[] {
  const out: { spec: string; node: ts.Node; loads: boolean }[] = [];
  for (const node of sf.statements.nodes) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // Type-only imports load nothing.
      const typeOnly = ts.isImportDeclaration(node) ? erasedTypeOnlyImport(node) : node.isTypeOnly;
      if (!typeOnly) out.push({ spec: node.moduleSpecifier.text, node, loads: true });
    }
  }
  for (const call of moduleSourceCandidates(program, sf).calls) {
    const arg = call.arguments.nodes[0];
    if (arg === undefined || !ts.isStringLiteralLike(arg)) continue;
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push({ spec: arg.text, node: call, loads: false });
      continue;
    }
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "require") continue;
    const loads = loadsWithModule(call);
    // A top-level require() that a local binding shadows is not a load of the
    // package; one below the top level never proved one anyway.
    if (loads && !isNodeRequire(program, call.expression)) continue;
    out.push({ spec: arg.text, node: call, loads });
  }
  return out;
}

/** The diagnostics of a construct that sloppy-mode Node accepts: the
 * frontend compiles every file under the project's `strict` options (with
 * `alwaysStrict`), so a `with`, an octal literal, or a strict-only reserved
 * word reports here even though the file itself is a CommonJS script that
 * Node runs sloppy. JavaScript grammar errors arrive in the bind pass
 * (TS1101 among them), so both passes filter by this set. They cannot hide
 * a real syntax error: they exist only for code the engine parses in sloppy
 * mode. */
const SLOPPY_LEGAL_CODES: ReadonlySet<number> = new Set([
  1100, // invalid use of a strict-mode reserved word
  1101, // 'with' statements are not allowed in strict mode
  1102, // 'delete' of an identifier in strict mode
  1121, // an octal literal
  1487, // an octal escape sequence
  1210, // a class body's strict-mode restriction
  1212, // a strict-mode reserved word
  1213, // a strict-mode reserved word in a class
  1214, // a strict-mode reserved word in a module
  1215, // invalid use of a strict-mode-only construct in a module
]);

/** Whether the file parses as the sloppy JavaScript the island would run:
 * a file with a genuine syntax or early error cannot run in an island as
 * written (Node refuses it too, at load), so its pre-scan markers must not
 * put it there — a parse-negative test stays the compile refusal it is
 * (decision S5: the markers narrow, never move, the native passes). */
function sloppyParsable(program: ts.Program, sf: ts.SourceFile): boolean {
  try {
    const sloppyLegal = (d: ts.Diagnostic): boolean => SLOPPY_LEGAL_CODES.has(d.code);
    return (
      program.getSyntacticDiagnostics(sf).every(sloppyLegal) &&
      program.getBindDiagnostics(sf).every(sloppyLegal)
    );
  } catch {
    return true;
  }
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
    // A user TypeScript module is scanned only for the builtin-patch marker
    // (H3.2): its other markers are JavaScript semantics, and sloppy
    // parsing is never required of TypeScript.
    const userTs = !js && origin === "user" && !sf.isDeclarationFile && opts.userJs;
    let facts: ReturnType<typeof scanModuleFacts> = { markers: [], cjsReads: [] };
    if ((js && (origin === "npm" || opts.userJs)) || userTs) facts = scanModuleFacts(sf);
    let markers = userTs
      ? facts.markers.filter((marker) => marker.reason === "builtin-patch")
      : facts.markers;
    if (js && markers.length > 0 && !sloppyParsable(program, sf)) markers = [];
    modules.push({
      file: sf.fileName,
      origin,
      packageDir: at === null ? null : at.dir,
      packageName: at === null ? null : at.name,
      markers,
      cjsReads: facts.cjsReads,
      stripProblem: userTs && markers.length > 0 ? stripProblem(program, sf) : null,
      dropped: opts.dropped,
    });
    if (!opts.edges) continue;
    for (const { spec, node, loads } of specifiersOf(program, sf)) {
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
        loads,
        loc: locOfNode(node),
      });
    }
  }
  return { modules, edges };
}
