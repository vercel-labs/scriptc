/* Local JavaScript values bind to their implementation, while explicit
 * type edges retain the complete declaration twin. The plan belongs to one
 * load: no runtime file is renamed, copied, or evaluated a second time. */
import { dirname, relative, resolve } from "node:path";
import * as ts from "./ts7/adapter.js";
import { trackedFileExists, trackedReadFile } from "./input-tracker.js";
import {
  isProjectRealmFile,
  projectDtsRuntimeSibling,
  resolveProjectModule,
  resolveProjectTypeModule,
} from "./resolve.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import type { FrontendServices } from "./services.js";
import { tsgoPath } from "./ts7/session-path.js";
import { erasedTypeOnlyImport } from "./type-only-imports.js";

/** Whether the module literal selects a native implementation.
 * A mixed clause still has a runtime edge, even if every named binding
 * carries `type`: retaining its empty clause preserves module evaluation. */
function isNativeValueSpecifier(literal: ts.Node): boolean {
  for (let node = literal.parent; node !== undefined; node = node.parent) {
    if (ts.isImportTypeNode(node) || ts.isJSDocImportTag(node)) return false;
    if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return !node.isTypeOnly;
    if (ts.isImportDeclaration(node)) return !erasedTypeOnlyImport(node);
    // Dynamic-only sidecars keep their existing admission path. A static
    // edge to the same file still selects its single runtime identity.
    if (ts.isCallExpression(node)) return node.expression.kind !== ts.SyntaxKind.ImportKeyword;
    if (ts.isSourceFile(node)) return false;
  }
  return false;
}

function declarationOfRuntime(path: string): string | null {
  for (const extension of [".js", ".mjs", ".cjs"]) {
    if (path.endsWith(extension))
      return path.slice(0, -extension.length) + ".d" + extension.replace("js", "ts");
  }
  return null;
}

function modulePath(from: string, target: string): string {
  const path = relative(dirname(from), target).split("\\").join("/");
  return path.startsWith("./") || path.startsWith("../") ? path : "./" + path;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Include attached JSDoc trees: the ordinary lowering walk deliberately
 * omits them, but their import types are checker inputs too. */
function walkTypeEdges(source: ts.SourceFile, visit: (node: ts.Node) => void): void {
  ts.walkPreorder(source, (node) => {
    visit(node);
    for (const doc of node.jsDoc ?? []) ts.walkPreorder(doc, visit);
  });
}

export class ProjectSidecars {
  private readonly runtimes = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private readonly originals = new Map<string, ts.SourceFile>();

  constructor(private readonly services: FrontendServices) {}

  hides(path: string): boolean {
    return this.runtimes.has(tsgoPath(path));
  }

  runtimeRoots(): string[] {
    return [...this.runtimes.values()];
  }

  /** Root discovery supplies the reachable implementations. Keep this plan
   * before JSX/shape overlays, so every rewrite starts from authored text. */
  update(program: ts.Program, host: ts.Ts7Host): boolean {
    let changed = false;
    const sources = [...program.getImplementationSourceFiles()];
    const visited = new Set(sources.map((source) => tsgoPath(source.fileName)));
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      if (!isProjectRealmFile(source.fileName) || npmStaticPackageOfPath(source.fileName) !== null)
        continue;
      for (const literal of source.imports) {
        if (!ts.isStringLiteralLike(literal) || !isNativeValueSpecifier(literal)) continue;
        const runtime = resolveProjectModule(source.fileName, literal.text);
        if (
          runtime === null ||
          !isProjectRealmFile(runtime) ||
          npmStaticPackageOfPath(runtime) !== null
        ) continue;
        // Discover the finite static closure before rebuilding the checker.
        // A chain of declaration twins must not consume one root-discovery
        // round per module. The owned parser supplies the same import AST.
        if (
          !visited.has(runtime) &&
          /\.[cm]?[jt]sx?$/.test(runtime) &&
          !/\.d\.[cm]?ts$/.test(runtime)
        ) {
          visited.add(runtime);
          let next = this.originals.get(runtime) ?? program.getSourceFile(runtime);
          if (next === undefined) {
            const text = host.sourceText(runtime);
            if (text !== null) {
              const kind = runtime.endsWith("tsx") ? "tsx"
                : runtime.endsWith("jsx") ? "jsx"
                  : /\.[cm]?ts$/.test(runtime) ? "ts" : "js";
              next = this.services.parse(runtime, text, kind);
            }
          }
          if (next !== undefined) {
            sources.push(next);
            if (!this.originals.has(runtime)) this.originals.set(runtime, next);
          }
        }
        const declaration = declarationOfRuntime(runtime);
        if (declaration === null || projectDtsRuntimeSibling(declaration) !== runtime) continue;
        const key = tsgoPath(declaration);
        if (this.runtimes.has(key)) continue;
        this.runtimes.set(key, runtime);
        host.removeVirtualFile(key);
        const suffix = declaration.slice(declaration.lastIndexOf(".d."));
        const stem = declaration.slice(0, -suffix.length);
        let index = 0;
        let alias = stem + ".scriptc-types" + suffix;
        // Never shadow a real authored file, even one outside this graph.
        while (trackedFileExists(alias) || [...this.aliases.values()].includes(alias))
          alias = stem + ".scriptc-types-" + ++index + suffix;
        this.aliases.set(key, alias);
        changed = true;
      }
    }
    if (this.runtimes.size === 0) return false;
    for (const path of program.getSourceFileNames()) {
      const declaration = /\.d\.[cm]?ts$/.test(path);
      if (declaration) {
        if (program.getSourceFileMetadata(path)?.isDefaultLibrary) continue;
      }
      const key = tsgoPath(path);
      if (this.originals.has(key) || [...this.aliases.values()].includes(path)) continue;
      const source = program.getSourceFile(path);
      if (source !== undefined) this.originals.set(key, source);
    }
    for (const path of this.runtimes.keys()) {
      if (this.originals.has(path)) continue;
      const text = trackedReadFile(path);
      if (text === null) throw new Error(`could not read local declaration ${path}`);
      this.originals.set(path, this.services.parse(path, text, "ts"));
    }
    // Unhidden declarations, including foreign packages, retain their
    // identity. Their type edges may still name a selected local twin;
    // rewriting those edges never admits a foreign runtime implementation.
    for (const [path, source] of this.originals) {
      const outputPath = this.aliases.get(path) ?? path;
      const text = this.rewrite(source);
      if (outputPath === path && text === source.text) continue;
      if (host.virtualFileText(outputPath) === text) continue;
      host.addVirtualFile(outputPath, text);
      changed = true;
    }
    if (changed) host.invalidateFileSystem();
    return changed;
  }

  private typeTarget(from: string, specifier: string): string | null {
    const resolved = resolveProjectTypeModule(from, specifier);
    if (resolved === null) return null;
    const declaration = declarationOfRuntime(resolved) ?? resolved;
    this.rememberDeclaration(declaration);
    const alias = this.aliases.get(tsgoPath(declaration));
    return alias === undefined ? null : modulePath(from, alias);
  }

  /** A copy can name declarations the initial checker never reached. The
   * originals walk visits these additions too, closing type dependencies
   * before reconstruction without duplicating unhidden identities. */
  private rememberDeclaration(path: string): void {
    const key = tsgoPath(path);
    if (!/\.d\.[cm]?ts$/.test(key) || this.originals.has(key)) return;
    const text = trackedReadFile(path);
    if (text !== null) this.originals.set(key, this.services.parse(path, text, "ts"));
  }

  private rewrite(source: ts.SourceFile): string {
    const edits: Edit[] = [];
    const literal = (node: ts.Node | undefined): void => {
      if (node === undefined || !ts.isStringLiteralLike(node)) return;
      const target = this.typeTarget(source.fileName, node.text);
      if (target !== null)
        edits.push({
          start: ts.tokenStartOfNode(node),
          end: node.end,
          text: JSON.stringify(target),
        });
    };
    const split = (
      node: ts.ImportDeclaration | ts.ExportDeclaration,
      elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
    ): void => {
      const specifier = node.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
      const target = this.typeTarget(source.fileName, specifier.text);
      const types = elements.filter((element) => element.isTypeOnly);
      if (target === null || types.length === 0) return;
      const kind = ts.isImportDeclaration(node) ? "import" : "export";
      const names = types.map((element) =>
        element.propertyName === undefined
          ? ts.getTextOfNode(element.name)
          : `${ts.getTextOfNode(element.propertyName)} as ${ts.getTextOfNode(element.name)}`,
      );
      const statement = `${kind} type { ${names.join(", ")} } from ${JSON.stringify(target)};`;
      // Remove runs of type specifiers together with exactly one adjoining
      // comma. Runtime specifiers, their spelling and their order survive.
      for (let at = 0; at < elements.length; at++) {
        if (!elements[at]!.isTypeOnly) continue;
        const first = at;
        while (at + 1 < elements.length && elements[at + 1]!.isTypeOnly) at++;
        const start = first === 0 ? ts.tokenStartOfNode(elements[first]!) : elements[first - 1]!.end;
        const clause = ts.isImportDeclaration(node) ? node.importClause!.namedBindings! : node.exportClause!;
        const end = first === 0
          ? at + 1 < elements.length ? ts.tokenStartOfNode(elements[at + 1]!) : clause.end - 1
          : elements[at]!.end;
        // Whitespace preserves line numbers, including clause comments.
        edits.push({ start, end, text: source.text.slice(start, end).replace(/[^\r\n]/g, " ") });
      }
      edits.push({ start: node.end, end: node.end, text: ";" + statement });
    };
    walkTypeEdges(source, (node) => {
      if (ts.isImportDeclaration(node)) {
        if (source.isDeclarationFile || erasedTypeOnlyImport(node)) literal(node.moduleSpecifier);
        else {
          const bindings = node.importClause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings))
            split(node, bindings.elements.nodes);
        }
      } else if (ts.isExportDeclaration(node)) {
        if (source.isDeclarationFile || node.isTypeOnly) literal(node.moduleSpecifier);
        else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause))
          split(node, node.exportClause.elements.nodes);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        literal(node.argument.literal);
      } else if (ts.isJSDocImportTag(node)) {
        literal(node.moduleSpecifier);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        (source.isDeclarationFile || node.isTypeOnly) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        literal(node.moduleReference.expression);
      }
    });
    for (const reference of source.referencedFiles) {
      const path = tsgoPath(resolve(dirname(source.fileName), reference.fileName));
      this.rememberDeclaration(path);
      const target = this.aliases.get(path);
      if (target !== undefined)
        edits.push({ start: reference.pos, end: reference.end, text: modulePath(source.fileName, target) });
    }
    let text = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return text;
  }
}
