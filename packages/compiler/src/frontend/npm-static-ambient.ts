/* Declared module types for a typed package's JavaScript subpaths.
 *
 * A package can type a family of subpaths it ships no declaration file for
 * through one ambient block:
 *
 *   declare module "pkg/lib/languages/*" {
 *     export default function(hljs?: HLJSApi): LanguageDetail;
 *   }
 *
 * TypeScript consults the block only while the specifier has no file to
 * resolve to. `--npm-static` puts the JavaScript itself in the program
 * (maxNodeModuleJsDepth), so the module is typed from that source instead —
 * and where the source's JSDoc disagrees with the declaration (highlight.js
 * annotates `php.js` with a REQUIRED `hljs`, its declaration says optional)
 * the program sees the package disagreeing with itself.
 *
 * The runtime body must still be lowered, so the JavaScript stays in the
 * program. This module projects the DECLARED export type onto that
 * JavaScript as a JSDoc annotation: the checker honors it, lowering ignores
 * it, and the body, its statement offsets and its source text are untouched.
 *
 *   module.exports = php;
 *   module.exports = / * @type {(hljs?: HLJSApi) => LanguageDetail} * / (php);
 *
 * Only what can be spelled in the JavaScript's own scope is projected: an
 * `export default function` signature or an `export = <name>` inside a
 * declaration file that is a global script (no top-level imports or
 * exports), whose type names the file itself declares globally. Every other
 * ambient shape keeps the file's own text. */
import { dirname, resolve as resolvePath } from "node:path";
import type { FrontendServices } from "./services.js";
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";
import { trackedReadFile } from "./input-tracker.js";
import { nodeModulesPackageDir } from "./npm-static-shadow-paths.js";

/** Type names a projection may reference without a declaration. */
const SPELLED_TYPES: ReadonlySet<string> = new Set([
  "any",
  "unknown",
  "never",
  "void",
  "undefined",
  "null",
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "this",
  "true",
  "false",
]);

/** One ambient module block that declares a projectable export type. */
interface AmbientBlock {
  /** The declared module name, a `*` pattern included. */
  name: string;
  /** The export type, spelled for a JavaScript JSDoc annotation. */
  type: string;
}

export interface NpmStaticAmbientCoverage {
  /** The declared export type of the module `rel` names (a path relative to
   * the package directory), or null when no block declares it. */
  typeFor: (rel: string) => string | null;
}

/** The names a declaration file's top-level statements declare as globals. */
function globalNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const add = (name: ts.Node | undefined): void => {
    if (name !== undefined && ts.isIdentifier(name)) names.add(name.text);
  };
  for (const stmt of sf.statements.nodes) {
    if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      add(stmt.name);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations.nodes) add(d.name);
    } else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      names.add(stmt.name.text); // a namespace: its members resolve through it
    }
  }
  return names;
}

/** Whether the file is a global script: an ambient block in a MODULE file is
 * an augmentation, and the names its types use are not globals. */
function isGlobalScript(sf: ts.SourceFile): boolean {
  return !sf.statements.nodes.some(
    (stmt) =>
      ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt),
  );
}

/** The type names `nodes` reference, first-identifier form (`A.B` → `A`). */
function referencedNames(nodes: readonly ts.Node[]): Set<string> {
  const names = new Set<string>();
  for (const root of nodes) {
    ts.walkPreorder(root, (n) => {
      if (ts.isTypeReferenceNode(n)) {
        const name = ts.isIdentifier(n.typeName) ? n.typeName.text : firstOfQualified(n.typeName);
        if (name !== null) names.add(name);
      } else if (ts.isTypeQueryNode(n)) {
        const name = ts.isIdentifier(n.exprName) ? n.exprName.text : firstOfQualified(n.exprName);
        if (name !== null) names.add(name);
      } else if (ts.isExpressionWithTypeArguments(n)) {
        const name = ts.isIdentifier(n.expression)
          ? n.expression.text
          : firstOfQualified(n.expression);
        if (name !== null) names.add(name);
      }
      return undefined;
    });
  }
  return names;
}

function firstOfQualified(node: ts.Node): string | null {
  let at: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(at)) return at.text;
    const left = (at as { left?: ts.Node }).left;
    if (left === undefined) return ts.isIdentifier(at) ? at.text : null;
    at = left;
  }
}

/** Whether `node` carries `kind` among its modifiers. */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as { modifiers?: { nodes: readonly ts.Node[] } }).modifiers?.nodes ?? [];
  return modifiers.some((m) => m.kind === kind);
}

/** The declared signatures an ambient block's export spells. `export default
 * function (...) {}` parses as a function declaration with the default
 * modifier. */
interface DeclaredSignature {
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined;
  parameters: ts.NodeArray<ts.ParameterDeclaration>;
  type: ts.Node | undefined;
}

/** The export type one ambient module block declares, or null when the block
 * declares a shape a JSDoc annotation cannot spell. `globals` are the names
 * the declaring file gives the JavaScript's scope: every type name the
 * signature references must be one of them. */
function blockType(
  sf: ts.SourceFile,
  block: ts.ModuleDeclaration,
  globals: ReadonlySet<string>,
): string | null {
  const body = block.body;
  if (body === undefined || !ts.isModuleBlock(body)) return null;
  const text = (n: ts.Node): string => sf.text.slice(tokenStartOfNode(n), n.end);
  for (const stmt of body.statements.nodes) {
    if (ts.isFunctionDeclaration(stmt) && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      const signature = stmt as unknown as DeclaredSignature;
      if (signature.typeParameters !== undefined) return null;
      const typed: ts.Node[] = [...signature.parameters.nodes];
      if (signature.type !== undefined) typed.push(signature.type);
      for (const name of referencedNames(typed))
        if (!SPELLED_TYPES.has(name) && !globals.has(name)) return null;
      const params = signature.parameters.nodes.map(text);
      const ret = signature.type === undefined ? "any" : text(signature.type);
      return `(${params.join(", ")}) => ${ret}`;
    }
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      // `export = hljs` / `export default language`: the value's type.
      const name = stmt.expression.text;
      if (SPELLED_TYPES.has(name) || globals.has(name)) return `typeof ${name}`;
      return null;
    }
  }
  return null;
}

/** The declared export type of the ambient module a package-relative path
 * names. Exact names win over patterns; the longest pattern prefix wins. */
function typeOf(blocks: readonly AmbientBlock[], pkgName: string, rel: string): string | null {
  const candidates = [`${pkgName}/${rel}`, `${pkgName}/${rel.replace(/\.(c|m)?js$/, "")}`];
  let best: { block: AmbientBlock; score: number } | null = null;
  for (const block of blocks) {
    for (const specifier of candidates) {
      if (!block.name.includes("*")) {
        if (block.name === specifier) return block.type;
        continue;
      }
      const star = block.name.indexOf("*");
      const prefix = block.name.slice(0, star);
      const suffix = block.name.slice(star + 1);
      if (
        specifier.length < block.name.length - 1 ||
        !specifier.startsWith(prefix) ||
        !specifier.endsWith(suffix)
      )
        continue;
      if (best === null || prefix.length > best.score) best = { block, score: prefix.length };
    }
  }
  return best?.block.type ?? null;
}

/** The declaration entry a package.json claims, or its index.d.ts. */
function declarationEntryOf(pkgDir: string): string | null {
  try {
    const text = trackedReadFile(`${pkgDir}/package.json`);
    if (text !== null) {
      const doc = JSON.parse(text) as Record<string, unknown>;
      for (const key of ["types", "typings"]) {
        const claim = doc[key];
        if (typeof claim === "string") {
          const resolved = resolvePath(pkgDir, claim);
          if (trackedReadable(resolved)) return resolved;
        }
      }
    }
  } catch {
    /* an unreadable manifest falls through to the index */
  }
  const index = `${pkgDir}/index.d.ts`;
  return trackedReadable(index) ? index : null;
}

function trackedReadable(file: string): boolean {
  return trackedReadFile(file) !== null;
}

/** Every ambient module block of `file` whose export type is projectable. */
function blocksOf(
  services: FrontendServices,
  file: string,
  seen: ReadonlySet<string>,
): AmbientBlock[] {
  if (seen.has(file)) return [];
  const text = trackedReadFile(file);
  if (text === null) return [];
  const sf = services.parse(file, text, "ts");
  const globals = globalNames(sf);
  const blocks: AmbientBlock[] = [];
  for (const stmt of sf.statements.nodes) {
    if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name)) continue;
    const type = blockType(sf, stmt, globals);
    if (type !== null) blocks.push({ name: stmt.name.text, type });
  }
  // The blocks a triple-slash reference pulls in are the same surface.
  const next = new Set([...seen, file]);
  for (const m of text.matchAll(/\/\/\/\s*<reference\s+path="([^"]+)"/g)) {
    const target = resolvePath(dirname(file), m[1]!);
    blocks.push(...blocksOf(services, target, next));
  }
  return blocks;
}

const coverageCache = new Map<string, NpmStaticAmbientCoverage | null>();

/** Forgets the ambient coverage plans of the previous load. */
export function clearNpmStaticAmbientCoverage(): void {
  coverageCache.clear();
}

/** The ambient coverage of the installed package at `pkgDir`, or null.
 * `isVisible` answers whether the declaration entry is part of the program:
 * a type the checker cannot resolve names nothing, so the package keeps the
 * implicit-any surface the flag gives it. */
export function npmStaticAmbientCoverage(
  services: FrontendServices,
  pkgDir: string,
  isVisible: (entry: string) => boolean,
): NpmStaticAmbientCoverage | null {
  const hit = coverageCache.get(pkgDir);
  if (hit !== undefined) return hit;
  let coverage: NpmStaticAmbientCoverage | null = null;
  const entry = declarationEntryOf(pkgDir);
  if (entry !== null && isVisible(entry)) {
    const pkgName = JSON.parse(trackedReadFile(`${pkgDir}/package.json`) ?? "{}") as {
      name?: unknown;
    };
    const name = typeof pkgName.name === "string" ? pkgName.name : null;
    if (name !== null) {
      const sf = services.parse(entry, trackedReadFile(entry) ?? "", "ts");
      if (isGlobalScript(sf)) {
        const blocks = blocksOf(services, entry, new Set());
        if (blocks.length > 0) coverage = { typeFor: (rel) => typeOf(blocks, name, rel) };
      }
    }
  }
  coverageCache.set(pkgDir, coverage);
  return coverage;
}

/** `text` with the declared export type of the module a package-relative
 * path names projected onto its `module.exports = <name>` assignment, or
 * null when there is nothing to project. */
export function ambientProjectedExport(
  services: FrontendServices,
  path: string,
  text: string,
  isVisible: (entry: string) => boolean,
): string | null {
  const pkgDir = nodeModulesPackageDir(path);
  if (pkgDir === null) return null;
  const coverage = npmStaticAmbientCoverage(services, pkgDir, isVisible);
  if (coverage === null) return null;
  const normalized = path.split("\\").join("/");
  const type = coverage.typeFor(normalized.slice(pkgDir.split("\\").join("/").length + 1));
  if (type === null) return null;
  const sf = services.parse(path, text, "js");
  for (const stmt of sf.statements.nodes) {
    if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) continue;
    const assignment = stmt.expression;
    const left = assignment.left;
    if (
      !ts.isPropertyAccessExpression(left) ||
      left.name.text !== "exports" ||
      !ts.isIdentifier(left.expression) ||
      left.expression.text !== "module"
    )
      continue;
    const value = assignment.right;
    if (value === undefined || !ts.isIdentifier(value)) continue;
    const at = tokenStartOfNode(value);
    return `${text.slice(0, at)}/** @type {${type}} */ (${text.slice(at, value.end)})${text.slice(value.end)}`;
  }
  return null;
}
