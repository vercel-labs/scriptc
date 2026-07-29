/* Module-graph lowering: splitting each source file into its parts, the
 * program-collection pass (signatures, classes, globals — reachability
 * seeds), npm/JSON import collection, per-file %init functions, %main, and
 * the module artifacts (globals, embedded npm tables) the IR module carries. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dirname as dirnamePath, resolve as resolvePath } from "node:path";
import { NpmGraphBuilder, packageNameOfPath, probeNodeImportRefusal, probeNodeRequireRefusal } from "../npm.js";
import { isNpmStaticPackage } from "../npm-static.js";
import { isJsSourceFileName, isRelativeSpecifier } from "../shared.js";
import { canonicalBuiltinModule, cjsExportAssignmentOf, cjsExportDiscardReason, isCjsJsFile, isJsSourceFile, isRequireStatement, locOf, makeCycleAdmission, orderedImportsOf, resolveImport, resolveNpmImport } from "../program.js";
import type { CycleEdge } from "../program.js";
import { invalidJsonModuleDiag, npmEmbedFailedDiag, requiresDynamicImportDiag } from "../../diagnostics/diagnostic.js";
import { BOOL, DYN, IrClassDef, IrExpr, IrFunction, IrGlobal, IrRecordShape, IrStmt, IrUnionDef, JSVAL, RUNTIME_ERROR_CLASSES, STRING, SrcLoc, VOID, arrayOf, canConvertToDyn, isUnitType } from "../../ir/nodes.js";
import { ENTRY_NAME, PoisonError, boundIdentifiersOf, dynFallbackType, dynUndefinedExpr, importCallHandleType, newFnCtx, uncheckedOverloadHandleCall } from "./lowerer.js";
import { builtinMemberRequireDecl, builtinNamespaceDestructureModuleOf, createRequireBindingDecl, createRequireNamespaceDecl, createRequireSpecOf, isPromisifyCall } from "./lower-builtins.js";
import { bindingContextualGenericFnNodeOf, bindingGenericFnAliasInfoOf, bindingGenericFnInfoOf, bindingGenericFnNodeOf, deadUnmappableBinding, implicitLocalFnInfoOf, implicitLocalFnNodeOf, nullishGenericBindingUnitOf } from "./lower-calls.js";
import { isVarDeclared, provenanceElidedConstDecl } from "./lower-stmts.js";
import { streamClassAliasDecl } from "./lower-stream.js";
import { stdlibGlobalAliasDecl } from "./surfaces.js";
import { collectNamespaceStmt, nsPathPrefix, trapDeclRootOf } from "./lower-namespaces.js";
import { collectExpandoMembers } from "./lower-expando.js";
import { isUnitOnlyTsType, unitOnlyUnion } from "../types.js";
import type { ClassInfo } from "./lower-classes.js";
import { decoratorNodesOf, genericIfaceBindingKeepsClass, guaranteedDecorationThrow } from "./lower-classes.js";
import { isMixinFnBinding, mixinResultBindingClassOf } from "./lower-mixins.js";

/** One file's declarations, split for collection and init-body lowering. */
export interface FileParts {
  sf: ts.SourceFile;
  fnDecls: ts.FunctionDeclaration[];
  classDecls: ts.ClassDeclaration[];
  topStmts: ts.Statement[];
}

/** Splits each file into function/class declarations and the top-level
   * statements that form its init body. Node's evaluation order (depth-first
   * postorder, entry last), computed by preflight. Single-file programs
   * (tests, coverage on broken files) may arrive with an empty order — fall
   * back to the entry alone. */
  export function splitFiles(L: Lowerer): FileParts[] {
    const files = L.moduleOrder.length > 0 ? L.moduleOrder : [L.entry];
    return files.map((sf) => {
      const fp: FileParts = { sf, fnDecls: [], classDecls: [], topStmts: [] };
      for (const stmt of sf.statements) {
        if (ts.isFunctionDeclaration(stmt)) fp.fnDecls.push(stmt);
        else if (ts.isClassDeclaration(stmt)) fp.classDecls.push(stmt);
        // Namespaces: ambient/type-only ones are zero-runtime and skip;
        // instantiated bodies FLATTEN into this file's parts (functions/
        // classes hoist under namespace-qualified names, statements join
        // the init body in source order) — lower-namespaces.ts.
        else if (ts.isModuleDeclaration(stmt)) collectNamespaceStmt(L, stmt, fp);
        else if (
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isImportDeclaration(stmt) ||
          // Export lists and re-exports are pure alias plumbing (importers
          // resolve through them to the original declarations); their
          // module EDGES live in preflight/buildInitSteps. Nothing runs.
          ts.isExportDeclaration(stmt)
        ) {
          continue; // type-only / already-resolved module plumbing
        } else fp.topStmts.push(stmt);
      }
      return fp;
    });
  }

/** A source file dynamic `import("<relative>")` can host as a COMPILED
   * module namespace (lowerOwnModuleImport): a non-declaration program file
   * that is not JSON and not CommonJS-flavored (a CJS namespace is built
   * from module.exports through Node's lexer — a different surface with no
   * static story here). Null for everything else. */
  export function dynamicImportProgramTargetOf(
    program: ts.Program,
    sf: ts.SourceFile,
    spec: string,
  ): ts.SourceFile | null {
    if (!isRelativeSpecifier(spec) && !spec.startsWith("/")) return null;
    const dep = resolveImport(program, sf, spec);
    if (!dep || dep.isDeclarationFile) return null;
    if (dep.fileName.endsWith(".json") || dep.fileName.endsWith(".cts")) return null;
    if (isCjsJsFile(dep)) return null;
    return dep;
  }

/** Every distinct program module a file's `import("literal")` sites name
   * (source order, deduped). */
  function dynamicProgramImportsOf(program: ts.Program, sf: ts.SourceFile): ts.SourceFile[] {
    const out: ts.SourceFile[] = [];
    const seen = new Set<ts.SourceFile>();
    ts.walkPreorder(sf, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const dep = dynamicImportProgramTargetOf(program, sf, node.arguments[0].text);
        if (dep && !seen.has(dep)) {
          seen.add(dep);
          out.push(dep);
        }
      }
    });
    return out;
  }

/** --dynamic builds: program modules reachable ONLY through dynamic
   * `import()` join the compiled module graph — appended to `order` (before
   * the entry, which stays last) in depth-first postorder over their own
   * static import edges, exactly like preflight ordered the static graph.
   * NOTHING calls their %init at startup (%main runs only the entry's init,
   * and no static import header names these), so a dynamic-only module
   * still evaluates exactly when Node evaluates it: the import() site's
   * namespace builder calls the guarded init on the engine microtask.
   * Fixpoint: an added module's own import() sites are scanned too. Static
   * cycles inside the added subgraph ride preflight's own admission engine
   * (makeCycleAdmission — preflight only walked the entry's static graph,
   * so it never judged these): benign back edges are Node cache hits the
   * run-once init guards reproduce, and inadmissible ones get preflight's
   * SC1016 with the same narrowed reason via `onCycle`. Idempotent —
   * re-running on an already-extended order adds nothing (both lowering
   * passes share one array). */
  export function appendDynamicImportModules(
    program: ts.Program,
    order: ts.SourceFile[],
    onCycle: (cycle: string, reason: string) => void,
  ): void {
    if (order.length === 0) return; // no preflight order — sites keep their fences
    const state = new Map<ts.SourceFile, "visiting" | "done">();
    for (const sf of order) state.set(sf, "done");
    const added: ts.SourceFile[] = [];
    const stack: string[] = [];
    const staticEdgesOf = (sf: ts.SourceFile): CycleEdge[] =>
      orderedImportsOf(program, sf).flatMap(({ stmt, dep }) =>
        dep !== null && dep !== sf
          ? [{ dep, stmt: stmt as ts.ImportDeclaration | ts.ExportDeclaration }]
          : [],
      );
    const cycleAdmissionReason = makeCycleAdmission(program, staticEdgesOf);
    const visit = (sf: ts.SourceFile): void => {
      if (state.get(sf) !== undefined) return;
      state.set(sf, "visiting");
      stack.push(sf.fileName);
      for (const e of staticEdgesOf(sf)) {
        const s = state.get(e.dep);
        if (s === "done") continue;
        if (s === "visiting") {
          // A back edge: Node answers it from the cache. Same admission
          // question as preflight's static walk, same fence when refused.
          const reason = cycleAdmissionReason(sf, e);
          if (reason !== null) {
            const cycleStart = stack.indexOf(e.dep.fileName);
            onCycle([...stack.slice(cycleStart), e.dep.fileName].join(" → "), reason);
          }
          continue;
        }
        visit(e.dep);
      }
      stack.pop();
      state.set(sf, "done");
      added.push(sf);
    };
    const scanned = new Set<ts.SourceFile>();
    for (;;) {
      const scan = [...order, ...added].filter((sf) => !scanned.has(sf));
      if (scan.length === 0) break;
      for (const sf of scan) {
        scanned.add(sf);
        for (const dep of dynamicProgramImportsOf(program, sf)) visit(dep);
      }
    }
    if (added.length > 0) order.splice(order.length - 1, 0, ...added);
  }

/** Collect pass over the WHOLE program: signatures, class shapes, and
   * file-scope globals visible everywhere → hoisting, mutual recursion, and
   * cross-module references fall out for free. Runs in both passes —
   * signatures are cheap and calls resolve against them; only BODY lowering
   * is reachability-gated. */
  export function collectProgram(L: Lowerer, parts: FileParts[]): void {
    L.collecting = true;
    try {
      for (const fp of parts) for (const decl of fp.classDecls) L.collectClassShape(decl);
      for (const fp of parts) for (const decl of fp.fnDecls) L.collectSignature(decl);
    } finally {
      L.collecting = false;
    }
    // Globals are top-level (always reachable), so their collection reports
    // eagerly — including deferred-class flushes their types trigger. The
    // coverage remainder still needs the registrations but the emit pass
    // already reported the diagnostics; discard the duplicates.
    if (L.remainder) {
      L.diagSink = [];
      try {
        for (const fp of parts) L.collectGlobals(fp.sf, fp.topStmts);
        L.collectNpmImports(parts);
        L.collectJsonImports(parts);
      } finally {
        L.diagSink = null;
      }
    } else {
      for (const fp of parts) L.collectGlobals(fp.sf, fp.topStmts);
      L.collectNpmImports(parts);
      L.collectJsonImports(parts);
    }
  }

/** The npm-import chokepoint, run once per pass during collection (so
   * bodies lowered in ANY pass resolve the bindings). In a static build
   * every value-importing npm import reports the requires-dynamic
   * diagnostic naming the package — the package's shipped JS has exactly
   * one execution home, the embedded engine. Under --dynamic each value
   * binding becomes a jsval GLOBAL, registered by ALIASED symbol (modules
   * importing the same export share one global) and initialized at the
   * top of the importing module's %init by island.import — the engine's
   * module registry caches, so re-imports are lookups, not re-evaluations.
   * The runtime graph (the package entry plus everything it reaches)
   * builds here too; its failures are ordinary diagnostics at the import
   * site. Type-only imports are free either way: the .d.ts is a type
   * surface, not code. */
  export function collectNpmImports(L: Lowerer, parts: FileParts[]): void {
    const builder = L.dynamic ? new NpmGraphBuilder() : null;
    for (const fp of parts) {
      for (const stmt of fp.sf.statements) {
        // NAMED re-exports from npm packages (`export { isUrl } from
        // "url-or-path"` — preflight admitted them): import-plus-export
        // plumbing — the island load registers at this statement's
        // position, and each binding keys the same aliased symbol a
        // direct import would, so consumers' alias chains land on the
        // same storage.
        const reexport =
          ts.isExportDeclaration(stmt) &&
          !stmt.isTypeOnly &&
          stmt.moduleSpecifier !== undefined &&
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          stmt.exportClause !== undefined &&
          ts.isNamedExports(stmt.exportClause) &&
          stmt.exportClause.elements.some((e) => !e.isTypeOnly) &&
          !stmt.moduleSpecifier.text.startsWith("#")
            ? stmt.exportClause
            : null;
        if (reexport === null && (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier))) continue;
        const specNode = ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) ? stmt.moduleSpecifier : undefined;
        if (specNode === undefined || !ts.isStringLiteral(specNode)) continue;
        const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
        if (ts.isImportDeclaration(stmt) && clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
        if (
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          !clause.name &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly)
        ) {
          continue;
        }
        const spec = specNode.text;
        const npm = resolveNpmImport(fp.sf.fileName, spec);
        // --npm-static: an opted-in package that made it through preflight
        // is a PROGRAM-MODULE dependency — its entry sits in the module
        // order, orderedImportsOf answers it for the %init header, and the
        // checker's alias chains bind the imports to its own exports. The
        // island owns nothing here, in static and --dynamic builds alike.
        if (
          npm !== null &&
          isNpmStaticPackage(npm.packageName) &&
          isJsSourceFileName(npm.typesFile) &&
          L.program.getSourceFile(npm.typesFile) !== undefined
        ) {
          continue;
        }
        // A RELATIVE specifier resolving INTO node_modules (the e2e driver
        // shape: `import "../node_modules/vercel/dist/index.js"`) is
        // package code too — tsc pulls the FILE into the program under
        // allowJs, but shipped JS has exactly one execution home, the
        // embedded engine, so it takes the same island path as a bare
        // specifier (previously it lowered to NOTHING: not an npm import,
        // and node_modules files never lower as program modules — the
        // import silently dropped).
        const relPkg =
          npm === null && isRelativeSpecifier(spec)
            ? packageNameOfPath(resolvePath(dirnamePath(fp.sf.fileName), spec))
            : null;
        const relIsJs =
          relPkg !== null && !/\.(ts|tsx|mts|cts)$/.test(spec);
        // A relative import INTO an opted-in --npm-static package is the
        // program-module path too (preflight resolved the file edge).
        if (relIsJs && isNpmStaticPackage(relPkg)) continue;
        if (!npm && !relIsJs) continue;
        // An edge Node's RUNTIME resolution refuses at startup (types
        // resolved, but the exports target ships no JS — the types-only
        // package shape): preflight registered Node's startup crash for
        // it, %main throws before any init runs, and the bindings never
        // link — nothing to embed, no island requirement, in EITHER mode.
        if (npm !== null && probeNodeImportRefusal(fp.sf.fileName, spec) !== null) continue;
        if (!builder) {
          L.pushDiag(requiresDynamicImportDiag(npm?.packageName ?? relPkg!, locOf(stmt)));
          continue;
        }
        const before = builder.errors.length;
        const entryKey = npm
          ? (builder.addImport(fp.sf.fileName, spec), builder.entryOf(fp.sf.fileName, spec))
          : builder.addFileImport(fp.sf.fileName, spec);
        for (const err of builder.errors.slice(before)) {
          L.pushDiag(npmEmbedFailedDiag(err.message, locOf(stmt)));
        }
        if (entryKey === null) continue; // resolution failed — reported above
        const loc = locOf(stmt);
        const byStmt = L.npmInitActions.get(fp.sf) ?? new Map<ts.Statement, IrStmt[]>();
        L.npmInitActions.set(fp.sf, byStmt);
        const actions = byStmt.get(stmt) ?? [];
        byStmt.set(stmt, actions);
        const importExpr = (exportName: string): IrExpr => ({
          kind: "libCall",
          fn: "island.import",
          args: [
            { kind: "strLit", value: entryKey, type: STRING, loc },
            { kind: "strLit", value: exportName, type: STRING, loc },
            // The specifier as WRITTEN — Node's missing-export SyntaxError
            // names it ("The requested module 'x' does not provide an
            // export named 'y'"), and the runtime check reproduces that
            // message exactly (scr_jsval_import).
            { kind: "strLit", value: spec, type: STRING, loc },
            // Static import/export bindings use Node's ESM-loader warning
            // path for syntax-detected typeless workspace modules.
            { kind: "boolLit", value: true, type: BOOL, loc },
          ],
          type: JSVAL,
          loc,
        });
        const bind = (nameNode: ts.Identifier | ts.StringLiteral, exportName: string): void => {
          let symbol = L.checker.getSymbolAtLocation(nameNode);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
            symbol = L.checker.getAliasedSymbol(symbol);
          }
          if (!symbol) return;
          let g = L.globalsBySymbol.get(symbol);
          if (!g) {
            g = {
              id: `%g.npm.${L.globalsList.length}`,
              name: nameNode.text,
              type: JSVAL,
              mutable: false,
            };
            L.globalsBySymbol.set(symbol, g);
            L.globalsList.push(g);
          }
          actions.push({ kind: "assign", localId: g.id, value: importExpr(exportName), loc });
        };
        if (reexport !== null) {
          for (const el of reexport.elements) {
            if (el.isTypeOnly) continue;
            bind(el.name, el.propertyName?.text ?? el.name.text);
          }
          continue;
        }
        if (!clause) {
          // Side-effect import: load for its top-level effects, keep nothing.
          actions.push({ kind: "exprStmt", expr: importExpr("*"), loc });
          continue;
        }
        if (clause.name) bind(clause.name, "default");
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            bind(clause.namedBindings.name, "*");
          } else {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              bind(el.name, el.propertyName?.text ?? el.name.text);
            }
          }
        }
      }
    }
    if (builder) {
      for (const fp of parts) collectDynamicImports(L, builder, fp.sf);
      for (const fp of parts) collectCreateRequires(L, builder, fp.sf);
      const graph = builder.finish();
      if (graph.modules.length > 0) {
        L.npmEmbedded = { modules: graph.modules, edges: graph.edges };
      }
      if (graph.builtins.length > 0) L.npmBuiltins = graph.builtins;
      if (graph.lazyTraps.length > 0) L.npmLazyTraps = graph.lazyTraps;
    }
  }

/** The dynamic-import half of the npm chokepoint (--dynamic only): every
   * `import("literal")` in the file — whatever body it sits in — resolves
   * and embeds AT COLLECTION time, so the per-site lowering later just
   * looks its key up (the emitted tables are assembled once, here; a
   * site lowered in any pass finds its module embedded). Resolution
   * failures and unshimmed builtins are diagnostics HERE, at the import
   * expression, exactly like static npm imports at their statements; the
   * lowering poisons those sites without re-reporting. Non-literal
   * specifiers are skipped — the lowering owns that fence (the module
   * graph is a build-time artifact; there is nothing to embed for a
   * runtime-computed name). */
  function collectDynamicImports(L: Lowerer, builder: NpmGraphBuilder, sf: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const spec = node.arguments[0].text;
        const mapKey = `${sf.fileName}\u0000${spec}`;
        if (!L.dynImports.has(mapKey)) {
          // The program's OWN modules first, by the checker's resolution
          // (tsc already resolved "./helper.js" to helper.ts): a compiled
          // module has no runtime namespace object — the per-site fence
          // says so. Only non-declaration source files count; a sibling
          // .d.mts typing shipped JS is the EMBED case, not this one.
          const modSym = L.checker.getSymbolAtLocation(node.arguments[0]);
          const ownModule = modSym !== undefined && L.checker.declarationsOf(modSym).some(
            (d) => ts.isSourceFile(d) && !d.isDeclarationFile,
          );
          const res = ownModule
            ? ({ kind: "program-module" } as const)
            : builder.addDynamicImport(sf.fileName, spec);
          L.dynImports.set(mapKey, res);
          if (res.kind === "unsupported-builtin") {
            L.pushDiag(
              npmEmbedFailedDiag(
                `'${spec}' is a Node builtin the island does not provide a shim for`,
                locOf(node),
              ),
            );
          } else if (res.kind === "unresolved") {
            L.pushDiag(npmEmbedFailedDiag(res.message, locOf(node)));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

/** The createRequire half of the npm chokepoint (--dynamic only): every
   * `require("bare-literal")` through a createRequire binding — whatever
   * body it sits in — resolves under Node's "require" condition and
   * embeds AT COLLECTION time, so the per-site lowering later just looks
   * its entry up (lowerCreateRequireCall). Builtins, relative documents,
   * "#" specifiers, --npm-static opt-ins, and Node-refused bare names
   * are the lowering's own arms — only resolvable installed packages
   * register here; resolution failures are diagnostics at the call
   * expression, exactly like static npm imports at their statements. */
  function collectCreateRequires(L: Lowerer, builder: NpmGraphBuilder, sf: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const cr = createRequireSpecOf(L, node);
        const spec = cr?.spec ?? null;
        if (
          cr !== null &&
          spec !== null &&
          canonicalBuiltinModule(spec) === null &&
          !isRelativeSpecifier(spec) &&
          !spec.startsWith("/") &&
          !spec.startsWith("#") &&
          probeNodeRequireRefusal(cr.baseFile.fileName, spec) === null
        ) {
          const pkgName = spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0]!;
          const mapKey = `${cr.baseFile.fileName}\u0000${spec}`;
          if (!L.createRequireImports.has(mapKey) && !isNpmStaticPackage(pkgName)) {
            const before = builder.errors.length;
            const entryKey = builder.addRequire(cr.baseFile.fileName, spec);
            for (const err of builder.errors.slice(before)) {
              L.pushDiag(npmEmbedFailedDiag(err.message, locOf(node)));
            }
            L.createRequireImports.set(
              mapKey,
              entryKey === null
                ? ""
                : { entryKey, format: builder.moduleFormatOf(entryKey) ?? "cjs" },
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

/** JSON module default imports (`import pkg from "../package.json"`):
   * the document is DATA known at build time, so the binding bakes into a
   * record global — the checker's structural type for the module (thanks
   * to resolveJsonModule) maps to a record shape, the JSON text parses in
   * the compiler, and comptimeValueToIr turns the value into literal IR
   * assigned in the importing module's %init prelude (evaluation order:
   * imports before the importer's body, like npm bindings). Two importers
   * of the same document share one global (keyed by the ALIASED symbol).
   * Shapes outside the bakeable surface (null-valued fields, mixed
   * arrays, ...) report the standard unsupported-type diagnostic at the
   * import site. Preflight already fenced named/namespace JSON imports
   * and kept .json files out of the module order. */
  export function collectJsonImports(L: Lowerer, parts: FileParts[]): void {
    for (const fp of parts) {
      for (const stmt of fp.sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const clause = stmt.importClause;
        if (!clause?.name || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
        const nameSym = L.checker.getSymbolAtLocation(clause.name);
        if (!nameSym || !(nameSym.flags & ts.SymbolFlags.Alias)) continue;
        const target = L.checker.getAliasedSymbol(nameSym);
        const jsonSf = L.checker.declarationsOf(target)[0]?.getSourceFile();
        if (!jsonSf || !jsonSf.fileName.endsWith(".json")) continue;
        try {
          const tsType = L.typeOf(clause.name);
          const mapped = L.mapTypeOf(tsType);
          if (!mapped || !L.comptimeBakeable(mapped)) {
            L.badType(clause.name, tsType);
          }
          // tsgo tolerates JSON shapes strict JSON.parse rejects (a leading
          // `//` comment — importAttributes11), so no SC0001 guarantees a
          // clean document: a failing parse gates at the import statement
          // (Node refuses to import the module at runtime too).
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonSf.text);
          } catch (e) {
            L.pushDiag(invalidJsonModuleDiag(
              jsonSf.fileName,
              e instanceof Error ? e.message : String(e),
              locOf(stmt),
            ));
            throw new PoisonError();
          }
          const value = L.comptimeValueToIr(parsed, mapped, "$", clause.name);
          let g = L.globalsBySymbol.get(target);
          if (!g) {
            g = {
              id: `%g.json.${L.globalsList.length}`,
              name: clause.name.text,
              type: mapped,
              mutable: false,
            };
            L.globalsBySymbol.set(target, g);
            L.globalsList.push(g);
          }
          const actions = L.jsonInitActions.get(fp.sf) ?? [];
          L.jsonInitActions.set(fp.sf, actions);
          actions.push({ kind: "assign", localId: g.id, value, loc: locOf(stmt) });
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          // diagnostic already recorded; uses of the binding poison too
        }
      }
    }
  }

/** The classes, records, and unions the emitted module carries: exactly
   * what the lowered functions and globals reference, closed transitively
   * over record fields, union arms, class field types, base chains, and
   * WHOLE hierarchies (hierarchy membership decides object layout:
   * dropping an unused subclass must not turn its base into a standalone
   * class at emit time). Registry entries interned while collecting
   * signatures nothing reaches stay out — an unreached type leaves no
   * trace. A referenced class with no registration had its collection
   * deferred: the reference flushes those diagnostics. Methods whose
   * bodies were not lowered leave the def's method list, so vtable slots
   * exist exactly for emitted overrides. */
  export function moduleArtifacts(L: Lowerer, functions: IrFunction[]): {
    classes: IrClassDef[];
    records: IrRecordShape[];
    unions: IrUnionDef[];
  } {
    const classNames = new Set<string>();
    const shapeIds = new Set<string>();
    const unionIds = new Set<string>();
    const pendingClasses: string[] = [];
    const pendingShapes: string[] = [];
    const pendingUnions: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const rec = node as Record<string, unknown>;
      if (typeof rec["className"] === "string" && !classNames.has(rec["className"])) {
        classNames.add(rec["className"]);
        pendingClasses.push(rec["className"]);
      }
      if (typeof rec["shapeId"] === "string" && !shapeIds.has(rec["shapeId"])) {
        shapeIds.add(rec["shapeId"]);
        pendingShapes.push(rec["shapeId"]);
      }
      if (typeof rec["unionId"] === "string" && !unionIds.has(rec["unionId"])) {
        unionIds.add(rec["unionId"]);
        pendingUnions.push(rec["unionId"]);
      }
      for (const key of Object.keys(rec)) {
        if (key !== "loc") visit(rec[key]);
      }
    };
    visit(functions);
    visit(L.globalsList);
    // The builtin error classes ride EVERY module: the runtime's own throws
    // (JSON/dynCheck/regex failures) mint instances of them whether or not
    // user code mentions Error, and the uncaught printer tells Error
    // payloads apart by their preorder interval — which must therefore be
    // part of this program's numbering (backends stamp it into the
    // runtime's vtables at main).
    for (const name of RUNTIME_ERROR_CLASSES.keys()) {
      if (!classNames.has(name)) {
        classNames.add(name);
        pendingClasses.push(name);
      }
    }
    while (
      pendingClasses.length > 0 ||
      pendingShapes.length > 0 ||
      pendingUnions.length > 0
    ) {
      while (pendingShapes.length > 0) {
        // Declared fields AND the index-signature value type: an
        // overflow-valued shape (`{ [key: string]: {script?: string} }`)
        // references its value shape through indexValue alone.
        const shape = L.shapes.get(pendingShapes.pop()!);
        visit(shape?.fields);
        if (shape?.indexValue) visit(shape.indexValue);
      }
      while (pendingUnions.length > 0) visit(L.unions.get(pendingUnions.pop()!)?.arms);
      while (pendingClasses.length > 0) {
        const name = pendingClasses.pop()!;
        const info = L.classes.get(name);
        if (!info) {
          // Referenced by an emitted type but never registered: collection
          // deferred its diagnostics — a reached reference makes them count.
          L.flushDeferredClass(name);
          continue;
        }
        visit(info.def.fields);
        if (info.base) visit([{ className: info.base.def.name }]);
        if (L.inHierarchy(info)) {
          let root = info;
          while (root.base) root = root.base;
          const wholeTree = (c: ClassInfo): void => {
            visit([{ className: c.def.name }]);
            for (const s of c.subclasses) wholeTree(s);
          };
          wholeTree(root);
        }
      }
    }
    const reachable = L.reachable;
    return {
      classes: [...L.classes.values()]
        .map((c) => c.def)
        .filter((def) => classNames.has(def.name))
        .map((def) => {
          // Generic-class instantiations bypass the reachability gate
          // (demand-driven — every member of a demanded instantiation
          // lowers; see lowerClassMembers), so their defs keep every
          // method: the emitted functions all exist. ABSTRACT entries ride
          // the same rule (noteVirtualEdge marks the abstract declarer, so
          // a dispatched slot keeps its declaration; an unreferenced one
          // drops and the root-most CONCRETE declaration owns the slot).
          const methods =
            reachable === null || def.genericOf !== undefined
              ? (def.methods ?? [])
              : (def.methods?.filter((m) => reachable.has(`%${def.name}.${m}`)) ?? []);
          const abstractMethods = def.abstractMethods?.filter((m) => methods.includes(m)) ?? [];
          const rest = { ...def };
          delete rest.methods;
          delete rest.abstractMethods;
          return {
            ...rest,
            ...(methods.length > 0 ? { methods } : {}),
            ...(abstractMethods.length > 0 ? { abstractMethods } : {}),
          };
        }),
      records: L.shapes.shapes.filter((r) => shapeIds.has(r.id)),
      unions: L.unions.unions.filter((u) => unionIds.has(u.id)),
    };
  }

/** Registers every DIRECT top-level `const`/`let` of a file as a module
   * global (stable storage: cross-module live bindings, and functions can
   * reference them without capture). Block-scoped vars inside nested
   * statements keep their different symbols and stay locals. */
  /** JS collection failures defer to runtime fences: the registration's
 * diagnostics move off the build (into L.runtimeFences) — the declaring
 * statement re-fails during init lowering and compiles to the
 * runtimeFence trap there, and every use site cascades to its own trap.
 * TypeScript files keep eager collection reports. */
function deferJsCollectionDiags(L: Lowerer, sf: ts.SourceFile, diagsBefore: number): void {
  if (!isJsSourceFile(sf)) return;
  const captured = L.diags.splice(diagsBefore);
  const ice = captured.filter((d) => d.code === "SC9001");
  if (ice.length > 0) L.diags.push(...ice);
  L.runtimeFences.push(...captured.filter((d) => d.code !== "SC9001"));
}

/** A scalar-literal expression a single-value `module.exports =` can carry
 * without any declaration to alias to: string/number/boolean literals,
 * substitution-free templates, and negated numbers. */
function cjsScalarLiteral(e: ts.Expression): boolean {
  if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  return (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  );
}

/** True when a JS file-scope declaration's initializer provably LOWERS to
 * a checked-dynamic (or unit) value, so a DYN module global can hold it:
 * no initializer, a unit literal, or a checker-`any` call/member/
 * identifier read (any-typed operations lower through the checked-dynamic tree in JS).
 * `new` expressions stay OUT even when checker-any (`new Anon.Sub()` over
 * an expando class member constructs a TYPED instance — corpus 2032), as
 * does everything else (object/array literals have their own rules;
 * typed-but-unmappable initializers keep the %init-local adoption). */
function jsDynHoldableInitializer(L: Lowerer, init: ts.Expression | undefined): boolean {
  if (init === undefined) return true;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e) && e.text === "undefined") return true;
  if (
    (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isIdentifier(e)) &&
    (L.typeOf(e).flags & ts.TypeFlags.Any) !== 0
  ) {
    return true;
  }
  // A CALL whose inferred type has no static mapping and whose residue
  // falls to the checked-dynamic kind (`const exec = common.mustCall(() =>
  // ... exec ...)` — the wrapper's rest-args type is not checker-`any`,
  // but the VALUE lowers through the checked-dynamic tree the same way): registering the
  // dyn global BEFORE the initializer lowers is what lets the callback
  // capture the binding itself — the Node-suite self-referential-const
  // idiom. Non-dyn residues (pure single-signature function types, typed
  // arrays) keep their static stories.
  if (ts.isCallExpression(e)) {
    const t = L.typeOf(e);
    if (L.mapTypeOf(t) === null && dynFallbackType(L, e, t)?.kind === "dyn") return true;
  }
  return false;
}

export function collectGlobals(L: Lowerer, sf: ts.SourceFile, topStmts: ts.Statement[]): void {
    // Segment-tagged so mangled names can't collide across files (user
    // identifiers cannot contain '.'): entry globals "e.<name>", others
    // "m<i>.<name>".
    const rawTag = L.fileTag.get(sf) ?? "";
    const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
    // Expando function members (`foo.bar = 12` anywhere in the file)
    // register their module globals first — reads inside function bodies
    // collected earlier in this pass must resolve them (lower-expando.ts).
    collectExpandoMembers(L, sf);
    for (const stmt of topStmts) {
      // `export default <expr>`: the module's `default` binding is a const
      // module global (registered under the checker's default-export
      // symbol — the symbol a default IMPORT's alias chain terminates at,
      // so importers share the storage). The init body assigns it at the
      // statement's position (lowerDefaultExport) — which IS Node's
      // semantics for expression defaults: the binding snapshots the value
      // once, when the export statement evaluates.
      //
      // ENTITY-NAME defaults (`export default x`, `export default N.a`)
      // are different: the checker binds the default symbol as an ALIAS to
      // the target, and importers resolve straight through to the target's
      // own storage — pure plumbing, like `export { x as default }`. That
      // is honest exactly when the target cannot be reassigned (consts,
      // function/class declarations — reassignment of those is fenced
      // elsewhere): Node's default binding would NOT see a later write
      // (snapshot), the alias-resolved read would (live). MUTABLE targets
      // (`export default someLet` — the visitor-keys pattern
      // reassigns the let, then default-exports it) get SNAPSHOT storage
      // instead: Node's default binding captures the value once, when the
      // export statement runs, so the default registers its own const
      // global keyed by the DEFAULT alias symbol — the `import x = N.y`
      // snapshot precedent. Importer reads stop at it through
      // resolveValueSymbol's default-snapshot walk instead of chasing the
      // alias to the live let.
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const symbol = defaultExportSymbolOf(L, sf);
        if (!symbol) continue;
        if (symbol.flags & ts.SymbolFlags.Alias) {
          const target = L.checker.getAliasedSymbol(symbol);
          const vd = L.checker.valueDeclarationOf(target);
          const mutableVar =
            vd !== undefined &&
            ts.isVariableDeclaration(vd) &&
            !vd.getSourceFile().isDeclarationFile &&
            (ts.getCombinedNodeFlags(vd) & ts.NodeFlags.Const) === 0;
          // Immutable targets: alias plumbing — importers resolve to the
          // target's storage (the alias-resolved read IS the snapshot when
          // nothing can reassign). Mutable targets fall through to the
          // expression-default registration below.
          if (!mutableVar) continue;
        }
        // A default whose expression is a decorated class expression with
        // a PROVABLY-THROWING decoration (the ambient-decorator shape):
        // evaluating the export statement throws before the binding could
        // snapshot anything, so no storage registers — the statement
        // lowering emits the throw itself (lowerDefaultExport), and no
        // importer's read can ever run (the module init unwound).
        {
          let inner: ts.Expression = stmt.expression;
          while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
          if (
            ts.isClassExpression(inner) && !isJsSourceFile(sf) &&
            inner.typeParameters === undefined &&
            (decoratorNodesOf(inner).length > 0 || inner.members.some((m) => decoratorNodesOf(m).length > 0)) &&
            guaranteedDecorationThrow(L, inner) !== null
          ) {
            continue;
          }
        }
        try {
          let tsType = L.typeOf(stmt.expression);
          // tsgo answers `any` at some export-assignment EXPRESSION
          // positions (a bare literal default) — the SYMBOL's type is the
          // declared truth and serves as the fallback.
          if (tsType.flags & ts.TypeFlags.Any) {
            const symType = L.checker.getTypeOfSymbol(symbol);
            if (!(symType.flags & ts.TypeFlags.Any)) tsType = symType;
          }
          let type = L.mapTypeOf(tsType) ?? dynFallbackType(L, stmt.expression, tsType) ?? L.badType(stmt.expression, tsType);
          // `export default undefined` — the unit-only union, like any
          // unit-only binding (`export default null` maps via mapType).
          if (type.kind === "void" && isUnitOnlyTsType(tsType)) {
            type = unitOnlyUnion(L.unions);
          }
          if (type.kind === "void") L.badType(stmt.expression, tsType);
          const g: IrGlobal = { id: `%g.${tag}default`, name: "default", type, mutable: false };
          L.globalsBySymbol.set(symbol, g);
          L.globalsList.push(g);
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          // diagnostic already recorded; lowering the statement poisons too
        }
        continue;
      }
      // CommonJS EXPORT statements (JS files): `exports.f = <expr>` /
      // `module.exports.f = <expr>` register a module global keyed by the
      // export symbol (the symbol importer bindings alias to), assigned by
      // the statement's lowering at its source position — the `export
      // default` machinery's shape. `module.exports = { ... }` registers
      // one for each EXPRESSION-valued property; identifier/shorthand
      // properties are pure alias plumbing (resolveValueSymbol re-resolves
      // importers to the referenced declarations — no storage needed).
      if (isJsSourceFile(sf)) {
        // Statements Node would DISCARD (a replaced export object) never
        // register storage — importer reads must not bind to values Node's
        // importers never see. The statement lowering owns the diagnostic.
        const cjs = cjsExportDiscardReason(stmt) === null ? cjsExportAssignmentOf(stmt) : null;
        const registerExport = (nameNode: ts.Node, name: string, typeNode: ts.Node): void => {
          const diagsBefore = L.diags.length;
          try {
            // tsgo answers no symbol at the attachment site's NAME (no
            // expando synthesis); the module symbol's exports table still
            // names the member — the same identity use sites resolve.
            const symbol = L.checker.getSymbolAtLocation(nameNode) ?? L.cjsModuleExportSymbol(sf, name);
            if (!symbol || L.globalsBySymbol.has(symbol)) return;
            // JS exports whose strict type has no mapping take the
            // checked-dynamic fallback (implicit-any function exports —
            // common/tls's `exports.check = function (certs) {...}` —
            // keep func-ness with dyn pieces; everything else is dyn).
            const strict = L.checker.getTypeOfSymbol(symbol);
            const t = L.mapTypeOf(strict) ?? dynFallbackType(L, nameNode, strict);
            if (!t || t.kind === "void") L.badType(typeNode, strict);
            // `module.exports.Strings = Strings` naming a dyn-HOLDING
            // const (the JS file-scope object-literal identity story): the
            // export ALIASES the const's own dyn global — one storage, one
            // owner, identity by construction (a record-typed second slot
            // would either copy or mismatch the dyn value — that mismatch
            // was an ICE; a second same-named global double-released at
            // teardown). The statement's assign degenerates to a harmless
            // self-assign. Mutable (`let`) sources keep the registration
            // below: Node copies the VALUE at this statement, and separate
            // storage is exactly that copy.
            {
              let rhs: ts.Node = typeNode;
              while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
              if (ts.isIdentifier(rhs)) {
                const vSym = L.checker.getSymbolAtLocation(rhs);
                const vG = vSym && L.globalsBySymbol.get(vSym);
                if (vG?.type.kind === "dyn") {
                  if (!vG.mutable) {
                    L.globalsBySymbol.set(symbol, vG);
                    for (const d of L.checker.declarationsOf(symbol)) L.globalsByDeclNode.set(d, vG);
                    return;
                  }
                  // A mutable (`let`) dyn source: separate DYN storage IS
                  // Node's copy-of-the-reference at this statement (later
                  // reassignments of the let stay invisible through the
                  // export). The id must not collide with the let's own
                  // `%g.<tag><name>` global.
                  const g: IrGlobal = { id: `%g.${tag}%export.${name}`, name, type: DYN, mutable: false };
                  L.globalsBySymbol.set(symbol, g);
                  for (const d of L.checker.declarationsOf(symbol)) L.globalsByDeclNode.set(d, g);
                  L.globalsList.push(g);
                  return;
                }
              }
            }
            const g: IrGlobal = { id: `%g.${tag}${name}`, name, type: t, mutable: false };
            L.globalsBySymbol.set(symbol, g);
            // Importer aliases resolve to a DISTINCT late-bound symbol with
            // the same declaration — key the node too (globalOf's fallback).
            for (const d of L.checker.declarationsOf(symbol)) L.globalsByDeclNode.set(d, g);
            L.globalsList.push(g);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            // diagnostic recorded; the statement lowering poisons too —
            // both defer to the statement's runtime fence in JS files.
            deferJsCollectionDiags(L, sf, diagsBefore);
          }
        };
        if (cjs?.kind === "member" && ts.isIdentifier(cjs.name)) {
          // `exports.C = C` naming a CLASS declaration: alias plumbing —
          // no storage (a class VALUE global would fence for
          // builtin-derived classes); importers re-resolve to the class
          // symbol (cjsMemberExportClassSymbol) and the class registry
          // applies unchanged.
          if (L.cjsMemberExportClassSymbol(cjs.expr) !== null) continue;
          registerExport(cjs.name, cjs.name.text, cjs.value);
          continue;
        }
        // `module.exports = <scalar literal>` — a single-value replacement
        // export with no declaration for requirer aliases to land on: the
        // checker's `export=` symbol declares AT this statement, so the
        // const export global registers keyed by the statement node
        // (globalOf's declaration-node fallback routes requirer reads
        // here). Identifier values register nothing — alias plumbing, like
        // identifier table entries; other value shapes fence in the
        // statement lowering.
        if (cjs?.kind === "table" && !cjs.obj) {
          let rhs = cjs.expr.right;
          while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
          // `module.exports = function (…) {…}` (ms's shape — the whole
          // export IS an anonymous function): a FUNC-typed const export
          // global keyed by the statement node, exactly the scalar
          // plumbing — requirer/default-import aliases resolve to the
          // checker's export= symbol, whose declaration IS this statement
          // (globalOf's node fallback), and calls ride the ordinary
          // func-value paths. The inference types the signature (JSDoc
          // included); unmappable pieces take the JS checked-dynamic
          // fallback like every JS binding.
          const fnValued = ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs);
          if (cjsScalarLiteral(rhs) || fnValued) {
            const diagsBefore = L.diags.length;
            try {
              const strict = L.typeOf(rhs);
              const t = L.mapTypeOf(strict) ?? (fnValued ? dynFallbackType(L, rhs, strict) : null);
              if (t && t.kind !== "void") {
                const g: IrGlobal = { id: `%g.${tag}exports`, name: "exports", type: t, mutable: false };
                L.globalsByDeclNode.set(cjs.expr, g);
                L.globalsList.push(g);
              }
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
              deferJsCollectionDiags(L, sf, diagsBefore);
            }
          }
          continue;
        }
        if (cjs?.kind === "table" && cjs.obj) {
          for (const prop of cjs.obj.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) continue; // alias plumbing
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) continue;
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              registerExport(prop.name, prop.name.text, prop.initializer);
            }
            // other property forms fence in the statement lowering
          }
          continue;
        }
      }
      // `import x = N.y` where the target is a MUTABLE binding: Node's
      // transform emits `var x = N.y` — a SNAPSHOT taken when the alias
      // statement runs — so the alias gets its own const storage, keyed by
      // the alias's PRE-alias symbol (resolveValueSymbol stops at alias
      // symbols with registered storage instead of chasing them to the
      // live target). lowerImportEquals assigns it at the statement's
      // source position. Immutable targets stay pure plumbing (no storage;
      // the alias-resolved read IS the snapshot when nothing can
      // reassign), and the require/type-only forms are handled at the
      // statement lowering.
      if (ts.isImportEqualsDeclaration(stmt)) {
        if (ts.isExternalModuleReference(stmt.moduleReference) || stmt.isTypeOnly) continue;
        const aliasSym = L.checker.getSymbolAtLocation(stmt.name);
        if (!aliasSym || !(aliasSym.flags & ts.SymbolFlags.Alias) || L.globalsBySymbol.has(aliasSym)) continue;
        const target = L.checker.getAliasedSymbol(aliasSym);
        const vd = L.checker.valueDeclarationOf(target);
        const mutableVar =
          vd !== undefined &&
          ts.isVariableDeclaration(vd) &&
          !vd.getSourceFile().isDeclarationFile &&
          (ts.getCombinedNodeFlags(vd) & ts.NodeFlags.Const) === 0;
        if (!mutableVar) continue;
        const diagsBefore = L.diags.length;
        try {
          let type = L.irTypeOf(stmt.name);
          if (type.kind === "void" && isUnitOnlyTsType(L.typeOf(stmt.name))) {
            type = unitOnlyUnion(L.unions);
          }
          if (type.kind === "void") L.badType(stmt.name, L.typeOf(stmt.name));
          const g: IrGlobal = {
            id: `%g.${tag}${nsPathPrefix(stmt)}%alias.${stmt.name.text}%${stmt.getStart()}`,
            name: stmt.name.text,
            type,
            mutable: false,
          };
          L.globalsBySymbol.set(aliasSym, g);
          L.globalsList.push(g);
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          deferJsCollectionDiags(L, sf, diagsBefore);
        }
        continue;
      }
      // `var` at module scope hoists across the WHOLE module body, blocks
      // included: `if (c) { var y = 1; }` at top level is a module-scoped
      // binding other functions in the file read. Non-top-level var
      // statements get their globals from the nested walk (top-level
      // statements continue into the main registration below, which also
      // owns the special forms — requires, aliases, promisify).
      if (!ts.isVariableStatement(stmt)) {
        collectNestedVarGlobals(L, sf, stmt, tag);
        continue;
      }
      // CommonJS require declarations are alias plumbing (preflight owns
      // the module edges; resolveValueSymbol routes reads through to the
      // exporter's declarations): no storage, and the statement lowers to
      // nothing. One registration DOES happen here: `const process =
      // require('node:process')` aliases the global process
      // (stdlibGlobalAliasDecl's require form) so reads through the
      // binding lower via the process surface.
      if (isRequireStatement(stmt)) {
        if (
          ts.isVariableStatement(stmt) &&
          (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
        ) {
          for (const decl of stmt.declarationList.declarations) {
            stdlibGlobalAliasDecl(L, decl.name, decl.initializer);
          }
        }
        continue;
      }
      // `declare const __VERSION__: string` — AMBIENT: no storage exists
      // (a bundler define in the real pipeline; nothing defines it here,
      // exactly like running the source under Node). Reads lower to
      // Node's ReferenceError at the access (lower-exprs), and the
      // statement itself lowers to nothing.
      if (ts.getCombinedModifierFlags(stmt.declarationList.declarations[0]!) & ts.ModifierFlags.Ambient) continue;
      const list = stmt.declarationList;
      if ((list.flags & ts.NodeFlags.Using) !== 0) continue; // fenced at the statement lowering
      const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
      // `var` registers a mutable module global exactly like `let` — the
      // hoisting difference (binding exists from module entry, undefined
      // until assigned) lives in lowerFileInit's entry inits.
      const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
      // Namespace members carry their namespace path in the storage id
      // (`%g.e.A%B.x`), so `namespace A { export const x }` and a
      // top-level `const x` never collide; non-exported members add the
      // declaring block's position (block-local bindings).
      const nsPrefix = nsPathPrefix(stmt, list.declarations[0]);
      for (const decl of list.declarations) {
        // --provenance-sources: an elided pure-annotated dead const in a
        // fetched source module registers no global (the statement
        // lowering emits nothing by the same test — see
        // provenanceElidedConstDecl). Checked FIRST: the mixin/promisify
        // probes below would otherwise claim the call-initializer shape
        // and put its fences on the build.
        if (provenanceElidedConstDecl(L, decl)) continue;
        // The trap/nullish/dead classification probes below resolve
        // symbols INSIDE the initializer, and resolution can fence (the
        // cross-block merged-namespace SC1090, resolveValueSymbol →
        // fenceCrossBlockNsRef): a fence mid-probe means the probe cannot
        // classify the declaration, not that collection dies — the
        // diagnostic is recorded, the binding falls through to ordinary
        // registration, and the statement lowering re-fences at its own
        // site (pushDiag dedupes), exactly the per-probe recovery the
        // alias/generic-fn registrations below already use.
        const classifyDiagsBefore = L.diags.length;
        const classified = (() => {
          try {
            // A TRAP declaration at file scope — the initializer's chain roots
            // at an ambient-undefined name (`declare const t: Type<string>;
            // export const out = t.pipe(...)`): Node throws the root's
            // ReferenceError evaluating the initializer, so no value ever
            // exists and no reference can ever run. No global registers; the
            // binding enters trapBindings (registered HERE, before any body
            // lowers, so hoisted-function references resolve the trap), and
            // the statement lowering emits the throw at its position.
            // Written bindings keep ordinary storage (trapDeclRootOf).
            if (trapDeclRootOf(L, decl) !== null) {
              for (const nameNode of boundIdentifiersOf(decl.name)) {
                const sym = L.checker.getSymbolAtLocation(nameNode);
                if (sym) L.trapBindings.add(sym);
              }
              return true;
            }
            // A NULLISH generic binding at file scope (`export const Mixin:
            // MixinHelperFunc = null as any`): no storage — reads know the
            // value (lower-exprs/lower-calls claim them); the statement
            // lowering emits nothing by the same test.
            if (
              ts.isIdentifier(decl.name) &&
              nullishGenericBindingUnitOf(L, L.checker.getSymbolAtLocation(decl.name) ?? null) !== null
            ) {
              return true;
            }
            // A DEAD unmappable binding at file scope (`var xs2: typeof
            // Array;` — never read anywhere): no global, no statement, no
            // type fence for a value the program never consumes.
            if (
              ts.isIdentifier(decl.name) &&
              deadUnmappableBinding(L, L.checker.getSymbolAtLocation(decl.name) ?? null, decl)
            ) {
              return true;
            }
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            // A probe fenced mid-classification: JS files defer the
            // recorded diagnostics to runtime fences like every other
            // collection failure; TS keeps the eager report (the
            // statement lowering re-fences at its own site — pushDiag
            // dedupes).
            deferJsCollectionDiags(L, sf, classifyDiagsBefore);
          }
          return false;
        })();
        if (classified) continue;
        // `const f = <T>(x: T) => x` at file scope: a generic function
        // value binding — no global exists (the binding is never read;
        // calls and pinned references monomorphize against the
        // initializer like a generic function declaration, registered
        // HERE so hoisted function bodies and cross-module references
        // resolve it). Non-qualifying shapes (reassigned bindings) fence
        // by name; the statement lowering skips (or re-fences — pushDiag
        // dedupes) by the same test.
        {
          const gfnNode = bindingGenericFnNodeOf(decl) ?? bindingContextualGenericFnNodeOf(L, decl);
          if (gfnNode) {
            try {
              bindingGenericFnInfoOf(L, decl, gfnNode);
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
            }
            continue;
          }
        }
        // `const h = id` at file scope — an ALIAS of a generic function:
        // registers the target's info under the alias's symbol (no global
        // exists; the binding is never read). Aliases resolve in
        // declaration order, so a chain (`const h2 = h`) registers link by
        // link; an unresolved target falls through to the ordinary global
        // registration and its fences.
        {
          let aliased = false;
          try {
            aliased = bindingGenericFnAliasInfoOf(L, decl) !== null;
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            aliased = true; // fenced by name — no global either way
          }
          if (aliased) continue;
        }
        // `const f = (x) => ...` at file scope of an npm-static JS file
        // whose params are implicit-any: the implicit-monomorphization
        // twin of the generic binding above — no global exists; calls and
        // value references resolve through genericFnsBySymbol, and the
        // statement lowering skips by the same test.
        {
          const implicitNode = implicitLocalFnNodeOf(L, decl);
          if (implicitNode) {
            implicitLocalFnInfoOf(L, decl, implicitNode);
            continue;
          }
        }
        // `const M = (Base: Ctor) => class extends Base {…}` — a
        // NON-generic mixin function binding (generic ones took the
        // branch above): no global exists — calls instantiate the class
        // inside per site (lower-mixins.ts); the statement lowering skips
        // by the same test.
        if (isMixinFnBinding(L, decl)) continue;
        // `const Thing1 = Tagged(Derived)` — a mixin RESULT binding: the
        // binding provably holds that one call's class object forever
        // (const), so it registers like a class declaration
        // (classBySymbol) HERE — before any body lowers — and every
        // downstream path (new, statics, extends, instanceof, reads)
        // answers directly. No global exists; the statement lowering
        // skips by the same test. A poisoned instantiation reported its
        // own diagnostics — the binding registers nothing and use sites
        // fence per reference.
        if (ts.isIdentifier(decl.name) && decl.initializer !== undefined && isConst) {
          let init: ts.Expression = decl.initializer;
          while (ts.isParenthesizedExpression(init)) init = init.expression;
          if (ts.isCallExpression(init)) {
            const bindSym = L.checker.getSymbolAtLocation(decl.name);
            try {
              if (mixinResultBindingClassOf(L, bindSym)) continue;
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
              continue;
            }
          }
        }
        // `const execFileAsync = promisify(execFile)` at file scope: no
        // global exists (the promisified function value never does) — the
        // symbol registers HERE, before any use site can lower, and the
        // statement lowering skips the declaration by the same check. A
        // bad promisify target reports here (recorded once; the statement
        // lowering poisons too, like every collectGlobals failure).
        if (ts.isIdentifier(decl.name) && decl.initializer && isPromisifyCall(L, decl.initializer)) {
          try {
            L.promisifiedExecFileDecl(decl.name, decl.initializer);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
          continue;
        }
        // `const inspect = require("util").inspect` at file scope: a
        // named import in const clothing (builtinImportOf resolves uses)
        // — no global storage; the statement lowering skips it by the
        // same test.
        if (builtinMemberRequireDecl(decl.name, decl.initializer)) continue;
        // `const require = createRequire(import.meta.url)` at file scope:
        // compile-time plumbing — no global storage; the statement
        // lowering skips it by the same test.
        if (isConst && createRequireBindingDecl(L, decl.name, decl.initializer)) continue;
        // `const fs = require("node:fs")` through that binding at file
        // scope — a namespace import in const clothing, same story.
        if (isConst && createRequireNamespaceDecl(L, decl.name, decl.initializer)) continue;
        // `const { createSign } = crypto` over a builtin NAMESPACE binding
        // at file scope: alias plumbing like the destructured-require form
        // — no storage (the statement lowering skips by the same test).
        if (builtinNamespaceDestructureModuleOf(L, decl) !== null) continue;
        // `const { NGHTTP2_CANCEL } = http2.constants` at file scope: a
        // destructure over the baked constants table — alias plumbing, no
        // global storage (the statement lowering skips it by the same
        // test).
        if (L.builtinConstantsDestructureDecl(decl.name, decl.initializer)) continue;
        // `const Writable = stream.Writable` at file scope: a stream
        // class through the namespace binding — alias plumbing, no
        // global storage (the statement lowering skips it by the same
        // test).
        if (isConst && streamClassAliasDecl(L, decl.name, decl.initializer)) continue;
        // `const process = globalThis.process` at file scope: a stdlib-
        // global snapshot — alias plumbing, no global storage (see
        // stdlibGlobalAliasDecl; the statement lowering skips it by the
        // same test).
        if (isConst && stdlibGlobalAliasDecl(L, decl.name, decl.initializer)) continue;
        // Destructuring declarations register EVERY bound identifier (the
        // desugar in the init function assigns the pre-registered globals,
        // exactly like plain declarations).
        for (const nameNode of boundIdentifiersOf(decl.name)) {
          const diagsBefore = L.diags.length;
          try {
            // A JS file-scope evolving ARRAY (`const mustCallChecks = [];`
            // — test/common's exit-accounting ledger): the strict type
            // (any[]) has no mapping, but the VALUE is the dyn array the
            // literal builds (lowerArrayLiteral's JS fallback) — register
            // a checked-dynamic global so separately-declared function
            // bodies (runCallChecks, _mustCallInner) reach the SAME
            // storage instead of fencing per reference. Identifier
            // declarations only: a destructured array literal binds its
            // pieces, not the array.
            if (
              isJsSourceFile(sf) && !L.mapTypeOf(L.typeOf(nameNode)) &&
              ts.isIdentifier(decl.name) && nameNode === decl.name &&
              decl.initializer !== undefined && ts.isArrayLiteralExpression(decl.initializer)
            ) {
              const symbol = L.checker.getSymbolAtLocation(nameNode);
              if (symbol) {
                const g: IrGlobal = { id: `%g.${tag}${nameNode.text}`, name: nameNode.text, type: DYN, mutable: isLet };
                L.globalsBySymbol.set(symbol, g);
                L.globalsList.push(g);
              }
              continue;
            }
            // A JS file-scope OBJECT LITERAL (`const input = { foo: 'bar' }`
            // — the Node-suite trace-context idiom): JS object identity is
            // the literal's contract — the SAME object flows into untyped
            // callees, gets stamped by them, and is compared back against
            // the binding (assert.strictEqual(found, input)). A static
            // record global would re-box at every dyn crossing and lose
            // that identity, so the binding holds the dyn object itself.
            // Gated to literals that are PURE DATA WRITTEN INLINE — every
            // property a non-computed PropertyAssignment whose value is
            // dyn-representable (unmappable member types are the checked-dynamic tree
            // fallback's own case) — so shorthand aggregates (test/common's
            // export object: alias plumbing importers resolve THROUGH),
            // spreads, accessors, and literals holding unconvertible typed
            // values (a Map member) keep their static/alias stories.
            if (
              isJsSourceFile(sf) &&
              ts.isIdentifier(decl.name) && nameNode === decl.name &&
              decl.initializer !== undefined && ts.isObjectLiteralExpression(decl.initializer) &&
              decl.initializer.properties.every((p) => {
                if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name)) return false;
                const mt = L.mapTypeOf(L.typeOf(p.initializer));
                return mt === null || mt.kind === "dyn" ||
                  canConvertToDyn(mt, (id) => L.shapes.get(id), (id) => L.unions.get(id));
              })
            ) {
              const symbol = L.checker.getSymbolAtLocation(nameNode);
              if (symbol && !L.globalsBySymbol.has(symbol)) {
                const g: IrGlobal = { id: `%g.${tag}${nameNode.text}`, name: nameNode.text, type: DYN, mutable: isLet };
                L.globalsBySymbol.set(symbol, g);
                L.globalsList.push(g);
              }
              continue;
            }
            // A JS file-scope ANY-RESIDUE binding whose VALUE provably
            // lives in the checked-dynamic tree: no initializer (`let catchWarning;` —
            // test/common's warning ledger), a unit initializer (`let
            // localhostIPv4 = null;` — the lazy-cache idiom), or an
            // initializer whose own checker type is `any` (`const handler
            // = common.mustCall(cb)` — a dyn call result). Register a
            // checked-dynamic global (the evolving-array precedent above)
            // so separately-declared functions and getters reach the SAME
            // storage instead of fencing per reference. Typed-but-
            // unmappable initializers (`new Set(...)` — a real Set the
            // decl keeps as an %init local) stay OUT: forcing those into
            // the checked-dynamic tree would trade their working typed representation for
            // fences.
            if (
              isJsSourceFile(sf) && !L.mapTypeOf(L.typeOf(nameNode)) &&
              ts.isIdentifier(decl.name) && nameNode === decl.name &&
              jsDynHoldableInitializer(L, decl.initializer) &&
              dynFallbackType(L, nameNode, L.typeOf(nameNode))?.kind === "dyn"
            ) {
              const symbol = L.checker.getSymbolAtLocation(nameNode);
              if (symbol && !L.globalsBySymbol.has(symbol)) {
                const g: IrGlobal = { id: `%g.${tag}${nsPrefix}${nameNode.text}`, name: nameNode.text, type: DYN, mutable: isLet };
                L.globalsBySymbol.set(symbol, g);
                L.globalsList.push(g);
                // Mutable dyn globals hold the dyn undefined from module
                // entry (the main path's rule below): a closure called
                // above the declaration reads undefined instead of
                // faulting on NULL.
                if (g.mutable) noteVarGlobalEntryInit(L, sf, g);
              }
              continue;
            }
            // A JS file-scope object literal carrying GET accessors whose
            // strict type has no mapping (the doc-printer root-indent
            // shape — a self-referential getter): the literal builds
            // ISLAND-NATIVE (the getter defines through the engine), so
            // the binding holds the HANDLE — a jsval global, so exports
            // and separately-declared functions reach the same engine
            // object.
            if (
              L.dynamic && isJsSourceFile(sf) && !L.mapTypeOf(L.typeOf(nameNode)) &&
              ts.isIdentifier(decl.name) && nameNode === decl.name &&
              decl.initializer !== undefined && ts.isObjectLiteralExpression(decl.initializer) &&
              decl.initializer.properties.some((p) => ts.isGetAccessorDeclaration(p))
            ) {
              const symbol = L.checker.getSymbolAtLocation(nameNode);
              if (symbol && !L.globalsBySymbol.has(symbol)) {
                const g: IrGlobal = { id: `%g.${tag}${nsPrefix}${nameNode.text}`, name: nameNode.text, type: JSVAL, mutable: isLet };
                L.globalsBySymbol.set(symbol, g);
                L.globalsList.push(g);
              }
              continue;
            }
            // JS declarations whose STRICT type has no mapping register no
            // global at all: the declaration lowers as an %init-body LOCAL
            // whose type adopts the initializer's (lowerVarDecl's JS
            // rule — `new Set([...tokens])` becomes a real Set<string>),
            // and closures created in the init body capture it normally.
            // References from separately-declared functions cascade to
            // their own per-site runtime fences.
            if (isJsSourceFile(sf) && !L.mapTypeOf(L.typeOf(nameNode))) continue;
            // `var p1 = import("./m")` at file scope: the global holds the
            // island promise/handle — the import expression's only
            // production — whatever the checker's namespace type mapped to
            // (lowerVarDecl's rule at module scope; the init body assigns
            // it).
            const handleT =
              L.dynamic && ts.isIdentifier(decl.name) && nameNode === decl.name
                ? (importCallHandleType(decl.initializer) ??
                  // An unchecked-overload call result stores the handle,
                  // exactly the local rule (uncheckedOverloadHandleCall).
                  (uncheckedOverloadHandleCall(L, decl.initializer) ? JSVAL : null))
                : null;
            let type = handleT ?? L.irTypeOf(nameNode);
            // An evolving-`any` array's DERIVED file-scope binding under
            // --dynamic (`const kept = fns.filter(...)` where `fns`
            // registered array<jsval> at its `any[]` declaration): the
            // receiver-type-preserving methods answer the receiver's
            // handle-element array, while tsc's evolving-array analysis
            // spells the pushed element type here — the value's element
            // type is the truth, so the global slot takes the handle-
            // element array (lowerVarDecl's adoption, the file-scope
            // face). Annotated declarations keep the validated-boundary
            // fence.
            if (
              L.dynamic && ts.isIdentifier(decl.name) && nameNode === decl.name &&
              decl.type === undefined && decl.initializer !== undefined &&
              type.kind === "array" && type.elem.kind !== "jsval" &&
              handleArrayPreservingCall(L, decl.initializer)
            ) {
              type = arrayOf(JSVAL);
            }
            // `const r: Repo = new MemRepo()` over an all-generic-method
            // interface: the binding keeps the initializer's CLASS
            // representation (the record shape maps empty and the width
            // copy would drop the class the generic-method calls
            // monomorphize against) — see genericIfaceBindingKeepsClass.
            if (
              type.kind === "record" && ts.isIdentifier(decl.name) && nameNode === decl.name &&
              genericIfaceBindingKeepsClass(L, decl, type)
            ) {
              const initT = L.mapTypeOf(L.typeOf(decl.initializer!));
              if (initT?.kind === "object") type = initT;
            }
            // A file-scope PATTERN over an ISLAND-bound source (`export
            // let { toString } = 1;` — the engine reads the wrapper's
            // prototype member): the bound value follows the island
            // property-read rule, so the global slot must too — declared
            // primitives exit eagerly to their static type, everything
            // else stores the HANDLE (a func-typed slot could never take
            // the engine value the desugar assigns).
            if (L.dynamic && !ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
              const srcT = L.mapTypeOf(L.typeOf(decl.initializer));
              const island =
                srcT !== null &&
                (srcT.kind === "jsval" || srcT.kind === "f64" || srcT.kind === "bool" ||
                  srcT.kind === "string" || isUnitType(srcT));
              if (island && type.kind !== "f64" && type.kind !== "bool" && type.kind !== "string") {
                type = JSVAL;
              }
            }
            // File-scope unit-only bindings (`var x: undefined`, `const
            // y: void = undefined`) ride the unit-only union, exactly
            // like function-scope locals (lowerVarDecl's rule).
            if (type.kind === "void" && isUnitOnlyTsType(L.typeOf(nameNode))) {
              type = unitOnlyUnion(L.unions);
            }
            if (type.kind === "void") L.badType(nameNode, L.typeOf(nameNode));
            // A JS file-scope FUNCTION binding whose unannotated return
            // infers a record (`const wrapped = function () { return
            // expectedResult; }`): the closure VALUE lowers with a dyn
            // return (declaredReturnType's record twin — JS object
            // literals are dyn values, and a record return would copy
            // identity away), so the binding's slot must agree or an
            // adapter would re-copy at the assignment.
            if (
              isJsSourceFile(sf) &&
              type.kind === "func" &&
              type.ret.kind === "record" &&
              decl.initializer !== undefined &&
              (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer)) &&
              decl.initializer.type === undefined &&
              type.params.every((pt) => pt.kind === "dyn")
            ) {
              type = { ...type, ret: DYN };
            }
            // A file-scope JS `let x = {}`: the same checked-dynamic rule
            // lowerVarDecl applies to locals — TS's empty-object-literal
            // type admits ANY later non-nullish assignment, so the static
            // empty struct cannot hold the binding's future.
            if (isLet && type.kind === "record" && isJsSourceFile(sf)) {
              const shape = L.shapes.get(type.shapeId);
              if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
            }
            const symbol = L.checker.getSymbolAtLocation(nameNode);
            // Merged `var` redeclarations (`var y = 1; ...; var y = 2;` —
            // one symbol) register exactly one global; later declarations
            // are plain assignments.
            if (!symbol || L.globalsBySymbol.has(symbol)) continue;
            const g: IrGlobal = {
              id: `%g.${tag}${nsPrefix}${nameNode.text}`,
              name: nameNode.text,
              type,
              mutable: isLet,
            };
            L.globalsBySymbol.set(symbol, g);
            L.globalsList.push(g);
            // Mutable checked-dynamic LET globals ride the same entry
            // init: a closure called above the declaration statement
            // reads the dyn undefined instead of faulting on NULL — the
            // dyn face of let's documented pre-declaration window (Node
            // throws the TDZ ReferenceError there).
            if (isVarDeclared(decl) || (g.type.kind === "dyn" && g.mutable)) {
              noteVarGlobalEntryInit(L, sf, g);
            }
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            // diagnostic already recorded; lowering the statement poisons
            // too — and in a JS file BOTH defer to the statement's
            // runtime fence (deferJsCollectionDiags).
            deferJsCollectionDiags(L, sf, diagsBefore);
          }
        }
      }
    }
  }

/** True iff this initializer's VALUE is a jsval-element array from a
   * module global already registered as one (the evolving-`any` binding
   * under --dynamic): the global itself, or a receiver-TYPE-PRESERVING
   * array-method call chain over it (filter/slice/splice/concat — each
   * answers the receiver's own array type). Registration runs in source
   * order, so the root's global — declared above, TDZ-guaranteed — is
   * already in the table. */
  function handleArrayPreservingCall(L: Lowerer, e: ts.Expression): boolean {
    const PRESERVING = new Set(["filter", "slice", "splice", "concat"]);
    let cur = e;
    for (;;) {
      while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
      if (
        ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) &&
        PRESERVING.has(cur.expression.name.text)
      ) {
        cur = cur.expression.expression;
        continue;
      }
      break;
    }
    if (!ts.isIdentifier(cur)) return false;
    const sym = L.checker.getSymbolAtLocation(cur);
    const g = sym ? L.globalsBySymbol.get(sym) : undefined;
    return g?.type.kind === "array" && g.type.elem.kind === "jsval";
  }

/** Registers the entry-init note for a `var` module global: JS hoists
   * module vars to `undefined` at module entry, so an undefined-armed slot
   * must hold the interned undefined arm BEFORE the body runs (a function
   * called above the declaration statement may read it — lowerFileInit
   * emits the assigns right after the run-once guard). Checked-dynamic
   * slots hold the dyn undefined the same way (a NULL dyn is a trap, not
   * a value). Other types need nothing: tsc's flow analysis rejects their
   * direct early reads, and closure reads share let's documented
   * zero/NULL divergence window. */
  function noteVarGlobalEntryInit(L: Lowerer, sf: ts.SourceFile, g: IrGlobal): void {
    // 'any' globals need the entry init exactly like undefined-armed
    // unions: tsc never guards `any` reads, so `var x: any;` is readable
    // before any assignment and its slot must hold its world's undefined
    // — the ENGINE's for jsval (--dynamic), the checked-dynamic tree's for dyn (static) —
    // rather than a C-level NULL (an op or validated exit on NULL is
    // memory-unsafe, not a TypeError).
    if (g.type.kind !== "union" && g.type.kind !== "jsval" && g.type.kind !== "dyn") return;
    const inits = L.varGlobalEntryInits.get(sf) ?? [];
    inits.push(g);
    L.varGlobalEntryInits.set(sf, inits);
  }

/** The nested half of module-scope `var` hoisting: a `var` inside a
   * top-level BLOCK (an if arm, a loop body, a try) is module-scoped in
   * JS — other functions in the file read the same binding — so it must
   * be a module global like its top-level siblings. Walks a top-level
   * statement's insides for var-flagged declaration lists (statement and
   * for/for-in/for-of initializer positions), never descending into
   * function-likes, classes, or static blocks (each hoists to its own
   * scope). Registration mirrors the main path's identifier story:
   * JS-unmappable types register nothing (per-site fences own the
   * references), everything else gets a mutable global. */
  function collectNestedVarGlobals(L: Lowerer, sf: ts.SourceFile, stmt: ts.Statement, tag: string): void {
    const lists: ts.VariableDeclarationList[] = [];
    // Iterative walk (walkPreorder): this sweep sees every non-var top-level
    // statement whole — the binderBinaryExpressionStress bare ~6500-term
    // chain sat within ~50 terms of overflowing the recursive form.
    ts.walkPreorder(stmt, (node) => {
      if (
        ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isClassStaticBlockDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
        ts.isModuleDeclaration(node)
      ) {
        return "skip";
      }
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
        lists.push(node);
        return "skip"; // initializer expressions hold no further statements outside function bodies
      }
      return undefined;
    });
    for (const list of lists) {
      for (const decl of list.declarations) {
        for (const nameNode of boundIdentifiersOf(decl.name)) {
          const diagsBefore = L.diags.length;
          try {
            if (isJsSourceFile(sf) && !L.mapTypeOf(L.typeOf(nameNode))) continue;
            let type = L.irTypeOf(nameNode);
            // Nested-var unit-only bindings take the unit-only union too
            // (the top-level registration's rule).
            if (type.kind === "void" && isUnitOnlyTsType(L.typeOf(nameNode))) {
              type = unitOnlyUnion(L.unions);
            }
            if (type.kind === "void") L.badType(nameNode, L.typeOf(nameNode));
            if (type.kind === "record" && isJsSourceFile(sf)) {
              const shape = L.shapes.get(type.shapeId);
              if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
            }
            const symbol = L.checker.getSymbolAtLocation(nameNode);
            if (!symbol || L.globalsBySymbol.has(symbol)) continue;
            const g: IrGlobal = { id: `%g.${tag}${nameNode.text}`, name: nameNode.text, type, mutable: true };
            L.globalsBySymbol.set(symbol, g);
            L.globalsList.push(g);
            noteVarGlobalEntryInit(L, sf, g);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            deferJsCollectionDiags(L, sf, diagsBefore);
          }
        }
      }
    }
  }

/** The checker's symbol for a module's default export — the symbol a
   * default import of this module aliases to (getAliasedSymbol), so keying
   * the default's global by it makes every importer resolve to the same
   * storage through the ordinary globalOf path. Null for modules without
   * a default export (or non-module files). */
  export function defaultExportSymbolOf(L: Lowerer, sf: ts.SourceFile): ts.Symbol | null {
    const moduleSym = L.checker.getSymbolAtLocation(sf);
    return moduleSym?.getExports().get(ts.InternalSymbolName.Default as ts.__String) ?? null;
  }

/** The declaration symbol of a top-level function/class declaration,
   * covering the one legal NAMELESS form: `export default function () {}` /
   * `export default class {}`. A named declaration answers through its
   * name node; the anonymous default IS the module's `default` export
   * symbol (the binder declares it there), so collection, reachability,
   * and body lowering all key that one identity — which is also what a
   * default import's alias chain resolves to. */
  export function declSymbolOf(
    L: Lowerer,
    decl: ts.FunctionDeclaration | ts.ClassDeclaration,
  ): ts.Symbol | undefined {
    if (decl.name) return L.checker.getSymbolAtLocation(decl.name);
    const isDefault = ts.canHaveModifiers(decl) &&
      ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
    if (!isDefault) return undefined;
    const sym = defaultExportSymbolOf(L, decl.getSourceFile());
    return sym ?? undefined;
  }

/** `export default <expr>` in a module's init body: the first (and only)
   * assignment of the pre-registered `default` global — evaluated at the
   * statement's source position, exactly where Node runs it (Node's
   * expression defaults snapshot exactly once, here). ENTITY-NAME defaults
   * of immutable targets are alias plumbing with no storage of their own:
   * the statement lowers to nothing — importers' alias-resolved reads
   * equal the snapshot. MUTABLE entity-name defaults registered snapshot
   * storage in collection and assign it here like any expression default
   * (the identifier read takes the let's value at this statement's
   * position — Node's snapshot). A NON-alias default whose type had no
   * registration (collection reported the blocker) re-lowers the
   * expression so the expression's OWN diagnostic wins when it has one,
   * then poisons. */
  export function lowerDefaultExport(L: Lowerer, stmt: ts.ExportAssignment): IrStmt | null {
    const symbol = defaultExportSymbolOf(L, stmt.getSourceFile());
    if (symbol && symbol.flags & ts.SymbolFlags.Alias && !L.globalsBySymbol.has(symbol)) return null;
    const g = symbol ? L.globalsBySymbol.get(symbol) : undefined;
    if (!g) {
      // A provably-throwing decorated class expression registered no
      // storage (the registration pass skipped it): the statement IS the
      // throw — lowerClassExpression answers the ambient undefRead.
      {
        let inner: ts.Expression = stmt.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (
          ts.isClassExpression(inner) && !isJsSourceFile(stmt.getSourceFile()) &&
          inner.typeParameters === undefined &&
          (decoratorNodesOf(inner).length > 0 || inner.members.some((m) => decoratorNodesOf(m).length > 0)) &&
          guaranteedDecorationThrow(L, inner) !== null
        ) {
          return { kind: "exprStmt", expr: L.lowerExpr(stmt.expression), loc: locOf(stmt) };
        }
      }
      L.lowerExpr(stmt.expression);
      L.badType(stmt.expression, L.typeOf(stmt.expression));
    }
    const value = L.lowerExprExpecting(stmt.expression, g.type);
    return { kind: "assign", localId: g.id, value, loc: locOf(stmt) };
  }

/** One file's top-level statements as its init function — RUN-ONCE like a
   * Node module body: non-entry inits open with a guard flag test (already
   * ran → return) and set the flag before anything else, so every caller —
   * hoisted import headers, inline require statements, diamonds, cache-hit
   * re-requires — gets Node's module-cache semantics from the same call.
   * After the guard comes the file's HOISTED module-edge header: one
   * guarded %init call per imported user module and the island loads for
   * npm imports, in import order (Node evaluates every imported module
   * before the importer's body — depth-first postorder falls out of the
   * nesting). CommonJS requires are NOT in the header: Node runs them at
   * their statements, so the statement lowering emits their %init calls
   * inline in the body. JSON-import bindings (pure data) load next; then
   * the body. Top-level var statements assign the pre-registered globals
   * instead of declaring locals. */
  export function lowerFileInit(L: Lowerer, sf: ts.SourceFile, stmts: ts.Statement[], name: string): IrFunction {
    L.fnStack.push(newFnCtx(false, null, null, VOID));
    try {
      const loc0: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
      const header: IrStmt[] = [];
      const guardId = L.moduleGuardOf.get(sf);
      if (guardId !== undefined) {
        header.push({
          kind: "if",
          cond: { kind: "varRef", localId: guardId, type: BOOL, loc: loc0 },
          then: [{ kind: "return", value: null, loc: loc0 }],
          else_: null,
          loc: loc0,
        });
        // The flag sets BEFORE the body runs — Node marks the cache entry
        // before evaluating too (moot while cycles are fenced, but the
        // honest order costs nothing).
        header.push({
          kind: "assign",
          localId: guardId,
          value: { kind: "boolLit", value: true, type: BOOL, loc: loc0 },
          loc: loc0,
        });
      }
      for (const { stmt, dep } of orderedImportsOf(L.program, sf)) {
        const npm = L.npmInitActions.get(sf)?.get(stmt);
        if (npm !== undefined && npm.length > 0) {
          header.push(...npm);
        } else if (dep !== null && dep !== sf) {
          // dep === sf is the self-import (the package self-name resolving
          // to the importing module): Node answers it from the module
          // cache mid-evaluation — no re-evaluation, nothing to call (and
          // the ENTRY has no run-once guard, so a self-call would recurse).
          const depInit = L.initNameOf.get(dep);
          if (depInit !== undefined) {
            const loc = locOf(stmt);
            header.push({
              kind: "exprStmt",
              expr: { kind: "call", callee: depInit, args: [], type: VOID, loc },
              loc,
            });
          }
        }
      }
      // Module-scope `var` hoisting: undefined-armed var globals hold the
      // interned undefined from module entry (before any body statement —
      // a function called above the declaration reads `undefined`, exactly
      // Node); checked-dynamic var globals hold the dyn undefined the same
      // way. After the guard: a cache-hit revisit must not reset them.
      for (const g of L.varGlobalEntryInits.get(sf) ?? []) {
        const wrapped = g.type.kind === "dyn" ? dynUndefinedExpr(loc0) : L.unassignedSlotInit(g.type, loc0);
        if (wrapped) {
          header.push({ kind: "assign", localId: g.id, value: wrapped, loc: loc0 });
        }
      }
      const prelude = L.jsonInitActions.get(sf) ?? [];
      // Class STATIC readonly fields, static BLOCKS, and class DECORATORS
      // run at their class statement's source position (splitFiles hoisted
      // the declarations out of `stmts`, so the statements merge back in
      // by position) — exactly when JS evaluates decorators, static
      // initializers, and blocks, so code reading an earlier module
      // binding sees its assigned value.
      const statics = [...L.classes.values()]
        .filter((c) =>
          // Class DECLARATIONS only: expression classes run their static
          // inits through pendingClassExprInits (below) at the statement
          // that evaluates them. MIXIN instantiations join by their CALL
          // SITE's position instead (below) — their inner class node may
          // even live in another file.
          c.decl && ts.isClassDeclaration(c.decl) && !c.mixinInstance && c.decl.getSourceFile() === sf &&
          (c.staticFields.length > 0 || (c.staticBlocks?.length ?? 0) > 0 || c.classDecorators !== undefined))
        .map((c) => ({ pos: c.decl!.getStart(), info: c }));
      // Statics-bearing MIXIN instantiations whose call evaluates in THIS
      // file: their declaration-time code runs when the call does — the
      // top-level statement lower-mixins recorded. Insertion order is
      // demand order (a nested mixin's base instantiates first, a
      // heritage base before its derived class), so the stable sort keeps
      // JS's evaluation order at equal positions.
      for (const c of L.classes.values()) {
        const ms = c.mixinInstance?.statics;
        if (ms && ms.sf === sf) statics.push({ pos: ms.pos, info: c });
      }
      statics.sort((a, b) => a.pos - b.pos);
      const body = [...header, ...prelude];
      let at = 0;
      for (const stmt of stmts) {
        // `<=`: a mixin instantiation's position IS its statement's start
        // — its statics run mid-statement in JS (the call), before
        // anything the statement's lowering emits. Hoisted class
        // declarations never share a kept statement's start, so `<=`
        // changes nothing for them.
        while (at < statics.length && statics[at]!.pos <= stmt.getStart()) {
          body.push(...L.lowerStaticFieldInits(statics[at]!.info));
          at++;
        }
        const stmtIr = L.lowerStmts([stmt]);
        // Class EXPRESSIONS inside this statement queued their static
        // inits while it lowered: they land immediately before it — JS's
        // order for the supported whole-initializer positions.
        body.push(...L.pendingClassExprInits.splice(0), ...stmtIr);
      }
      while (at < statics.length) {
        body.push(...L.lowerStaticFieldInits(statics[at]!.info));
        at++;
      }
      const loc: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
      return { name, params: [], returnType: VOID, locals: L.ctx.locals, body, loc };
    } finally {
      L.fnStack.pop();
    }
  }

/** %main is just the entry's %init call: Node's whole module evaluation
   * order lives in the init functions themselves — each file's hoisted
   * import header runs its dependencies first (depth-first postorder by
   * nesting), CommonJS require statements call dependency inits inline in
   * their bodies, and the run-once guards turn every revisit (diamonds,
   * re-imports, re-requires) into a cache hit. */
  export function buildMain(L: Lowerer): IrFunction {
    const loc: SrcLoc = { file: L.entry.fileName, start: 0, end: 0 };
    const entryInit = L.initNameOf.get(L.entry);
    const body: IrStmt[] =
      entryInit !== undefined
        ? [{ kind: "exprStmt", expr: { kind: "call", callee: entryInit, args: [], type: VOID, loc }, loc }]
        : [];
    // Node's startup refusal (a resolution the graph carries that Node
    // rejects — preflight's Node-order resolution walk — or the module-
    // LINK SyntaxError of a named import of a CommonJS export its lexer
    // cannot detect — cjsNamedImportLinkCheck): the graph is refused
    // before ANY module evaluates, so %main opens with exactly that throw
    // (message and error class both Node's) and the entry init below it
    // never runs. The init still lowers — the program must otherwise
    // compile, exactly like Node parses every module before its
    // fetch/instantiate phases refuse the graph.
    if (L.startupCrash !== null) {
      const crashLoc: SrcLoc = L.startupCrash.loc;
      body.unshift({
        kind: "throw",
        value: {
          kind: "libCall",
          fn: "error.new",
          args: [{ kind: "strLit", value: L.startupCrash.message, type: STRING, loc: crashLoc }],
          type: { kind: "object", className: L.startupCrash.className },
          loc: crashLoc,
        },
        loc: crashLoc,
      });
    }
    return { name: ENTRY_NAME, params: [], returnType: VOID, locals: [], body, loc };
  }
