/* THE program lifecycle: load → preflight — tsconfig adoption, the tsc
 * gate with its project-world second chance, the import/export form
 * fences, CommonJS require discipline, and the module evaluation order —
 * on the native TypeScript compiler (one spawned tsgo server behind
 * Ts7Host, through the ts7/ adapter) with scriptc's OWN resolver
 * (resolve.ts) standing in for ts.resolveModuleName /
 * ts.resolveTypeReferenceDirective, which typescript@7.0.2 no longer
 * ships.
 *
 * HISTORY. This began as a deliberately MECHANICAL PORT of the
 * typescript@5.9.3 checkPreflight (the adapter's design: swap the ts
 * import, keep every spelling), shipped alongside it for phases 2-3 with
 * the order-parity suite holding both lanes to identical diagnostics and
 * module order over the whole corpus. The phase-4 flip deleted the 5.9.3
 * pipeline; its recorded verdicts live on as the canary baselines
 * (test/ts7/baselines/order-parity.json), and the rationale prose the old
 * program.ts carried was folded in here where behavior demands it.
 *
 * Differences from the retired 5.9.3 lane, each deliberate and each
 * pinned by the canary baselines:
 *  - Module resolution is resolve.ts (answer-parity proven by its suite).
 *  - Diagnostics carry pos/end and flat text + messageChain; toPassthrough
 *    renders through the adapter's flattenDiagnosticMessageText, whose
 *    output shape matches 5.9.3's flattener byte for byte.
 *  - Finding 5 (tsgo models CommonJS strictly): TS2309 joins the JS-file
 *    relaxation here — 5.9.3 never fires it on JS CJS files, tsgo does on
 *    the table-then-member pattern. The EXPORT-IDENTITY fences do not live
 *    in tsc codes at all: cjsExportDiscardReason (lowering) names every
 *    genuinely discarded export, so relaxing the checker's stricter
 *    modeling loses nothing.
 *  - isNodeEsmFile: 5.9.3 under bundler sets impliedNodeFormat ONLY for
 *    .mjs/.cjs-family files (probed) and falls back to syntactic module
 *    detection for .js/.ts; 7's client SourceFile has no impliedNodeFormat,
 *    so this lane spells exactly that observed behavior: extensions first,
 *    then externalModuleIndicator.
 *  - Malformed tsconfig.json: tsgo's parseConfigFile swallows JSONC syntax
 *    errors (recovers to empty options) where 5.9.3 reported a passthrough
 *    diagnostic, so this lane validates the config's JSONC syntax itself
 *    (jsoncSyntaxError) and fails preflight like 5.9.3 does — with
 *    JSON.parse's wording rather than tsc's, the one message-text delta on
 *    that path (no snapshot pins it). */

import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import * as ts from "./ts7/adapter.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import {
  strictNullChecksFloorDiag,
  tscPassthroughDiag,
  unsupportedDiag,
} from "../diagnostics/diagnostic.js";
import { isNodeModulesPath, nearestPkgJsonPath, projectDtsRuntimeSibling, resolveBareModule, resolvePathsAlias, resolveProjectImport, resolveRelativeModule, resolveTypeDirective, setProjectRealm, setTsconfigPaths } from "./resolve.js";
import { probeNodeImportRefusal, probeNodeRequireRefusal } from "./npm.js";
import { isNpmStaticPackage, npmStaticActive, npmStaticFsShadow, npmStaticPackageOfPath, reportNpmStaticOffender, setNpmStaticPackages } from "./npm-static.js";
import { provenanceEntryFor, provenancePaths } from "./provenance-registry.js";
import { cjsLexerVisibleNames } from "./cjs-lexer.js";
import {
  ADOPTED_OPTIONS,
  ambientDtsPath,
  builtinDefaultImportModule,
  canonicalBuiltinModule,
  clearWorkspacePackages,
  fallbackDtsPath,
  isJsSourceFileName,
  isNodeTypesPath,
  isRelativeSpecifier,
  isWorkspacePackageName,
  JS_ANY_OPERATOR_CODES,
  JS_RELAXED_TSC_CODES,
  overridesDtsPath,
  registerWorkspacePackage,
  SUPPORTED_NODE_MODULES,
  unsupportedModuleFeatureOf,
  workspacePackageOfPath,
} from "./shared.js";

const BASE_OPTIONS: ts.Ts7CompilerOptions = {
  strict: true,
};

const FORCED_OPTIONS: ts.Ts7CompilerOptions = {
  target: ts.ScriptTarget.ESNext as number,
  module: ts.ModuleKind.ESNext as number,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2025.d.ts"],
  types: [],
  allowImportingTsExtensions: true,
  allowJs: true,
  checkJs: true,
  resolveJsonModule: true,
  noEmit: true,
};

/** JSONC syntax validation for a tsconfig text: tsgo's parseConfigFile
 * RECOVERS silently over syntax errors (probed: a hard-broken file answers
 * empty options, no diagnostic), where 5.9.3's readConfigFile reported the
 * first parse error — a preflight-visible difference (broken config: fail
 * loudly, never adopt silently). tsconfig's grammar is JSON plus comments
 * and trailing commas, so stripping exactly those and handing the rest to
 * JSON.parse decides validity without either TypeScript's parser. The
 * MESSAGE is JSON.parse's, not 5.9.3's ("'}' expected.") — the one
 * remaining wording delta on this path, unpinned by any snapshot. */
function jsoncSyntaxError(text: string): string | null {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const from = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(from, i + 1);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    out += ch;
  }
  // Trailing commas: `,` followed only by whitespace before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  if (out.trim() === "") return null; // an empty config file is legal
  try {
    JSON.parse(out);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The project's tsconfig adoption in the 7 world: tsgo's own config parser
 * (extends chains resolved server-side), the ADOPTED_OPTIONS subset taken,
 * the rest forced, the strictNullChecks floor enforced. */
function adoptProjectConfig7(
  host: ts.Ts7Host,
  entryPath: string,
): { configFile: string | null; options: ts.Ts7CompilerOptions; diags: ScrDiagnostic[] } {
  const configFile = ts.findConfigFile(dirname(entryPath), ts.sys.fileExists) ?? null;
  if (!configFile) {
    return { configFile, options: { ...BASE_OPTIONS, ...FORCED_OPTIONS }, diags: [] };
  }
  const diags: ScrDiagnostic[] = [];
  const syntaxError = jsoncSyntaxError(ts.sys.readFile(configFile) ?? "");
  if (syntaxError !== null) {
    diags.push(tscPassthroughDiag(syntaxError, { file: configFile, start: 0, end: 0 }));
    return { configFile, options: { ...BASE_OPTIONS, ...FORCED_OPTIONS }, diags };
  }
  const parsed = host.parseConfigFile(configFile);
  const adopted: Record<string, unknown> = {};
  for (const key of ADOPTED_OPTIONS) {
    const value = parsed.options[key];
    if (value !== undefined) adopted[key] = value;
  }
  const nullChecks = adopted["strictNullChecks"] ?? adopted["strict"] ?? false;
  if (nullChecks !== true) {
    diags.push(strictNullChecksFloorDiag(configFile));
    adopted["strictNullChecks"] = true;
  }
  return { configFile, options: { ...BASE_OPTIONS, ...adopted, ...FORCED_OPTIONS }, diags };
}

/** The target project's @types/node, resolved with the OWN resolver's
 * type-directive lookup anchored at the ENTRY (typeRoots-free — exactly the
 * secondary lookup 5.9.3 ran with typeRoots emptied). */
function resolveNodeTypes7(entryPath: string): string | null {
  const file = resolveTypeDirective("node", entryPath);
  return file !== null && isNodeTypesPath(file) ? file : null;
}

export interface LoadResult {
  program: ts.Program;
  entry: ts.SourceFile;
  /** User source files in Node's evaluation order: depth-first postorder
   * of the import graph from the entry, each module once. The entry is
   * last. Empty until checkPreflight runs (and empty when preflight fails
   * structurally). */
  moduleOrder: ts.SourceFile[];
  /** Node's startup refusal, when the graph carries an import edge Node
   * rejects before ANY module evaluates — a RESOLUTION refusal (a bare
   * specifier nothing installed resolves, an exports/imports map that
   * refuses the subpath or names a missing file, an invalid "#"
   * specifier: fetch/resolve phase, ERR_MODULE_NOT_FOUND and friends) or
   * the module-LINK SyntaxError (a named import of a CommonJS export
   * Node's lexer cannot detect: instantiate phase). Either way Node
   * refuses the whole program before evaluation, so the lowering compiles
   * the program to exactly that startup crash (buildMain); resolution
   * refusals win over the link SyntaxError because Node's fetch phase
   * runs first. Null when the graph resolves and links clean. Set by
   * checkPreflight. */
  startupCrash?: StartupCrash | null;
  configDiags: ScrDiagnostic[];
  projectWorld: () => ts.Program;
}

/** See LoadResult.startupCrash: Node's exact error message, the IR error
 * class that carries it (a RUNTIME_ERROR_CLASSES name — %Error for the
 * resolver's ERR_MODULE_NOT_FOUND family, %TypeError for invalid-specifier
 * refusals, %SyntaxError for the CJS link check), and the source position
 * of the refused edge. */
export interface StartupCrash {
  message: string;
  className: "%Error" | "%TypeError" | "%SyntaxError";
  loc: { file: string; start: number; end: number };
}

function loadProgram7(host: ts.Ts7Host, entryPath: string): LoadResult & { disposeAll: () => void } {
  const config = adoptProjectConfig7(host, entryPath);
  const nodeTypes = config.configFile ? resolveNodeTypes7(entryPath) : null;
  // skipLibCheck is FORCED with @types/node in the program: checking a
  // third-party lib's internals against OUR lib choice (es2025, no dyn) is
  // not scriptc's fence and drowns real diagnostics in hundreds of
  // .d.ts-internal errors. Fence discipline never depended on it: the
  // lowerer checks provenance and forms at every use site.
  let options: ts.Ts7CompilerOptions = nodeTypes ? { ...config.options, skipLibCheck: true } : { ...config.options };
  // Adopt tsconfig "paths" for scriptc's own resolver (resolve.ts) —
  // lowering uses them to resolve aliased import specifiers.
  const userPaths = (options as Record<string, unknown>).paths as Record<string, string[]> | undefined;
  setTsconfigPaths(userPaths ?? null);
  // --npm-static: opted-in packages' shipped JS must be TYPE-INCLUDED (not
  // just resolved) — without maxNodeModuleJsDepth, node_modules JS types as
  // an implicit-any module (TS7016) and nothing infers. Only flagged
  // compiles pay this; flagless builds keep the exact historical options.
  if (npmStaticActive()) options.maxNodeModuleJsDepth = 4;
  // --provenance-sources: the registered entries become tsconfig "paths"
  // so tsgo's OWN resolution of the bare specifiers lands on the same
  // source files the preflight resolver answers — the checker types the
  // driver against the package's real TypeScript, not its shipped .d.ts.
  const provenance = provenancePaths();
  if (provenance !== null) {
    options = userPaths !== null ? { ...options, paths: { ...userPaths, ...provenance } } : { ...options, paths: provenance };
  }
  const coreRoots = [entryPath, ambientDtsPath(), nodeTypes ?? fallbackDtsPath()];
  const program = ts.createProgram([...coreRoots, overridesDtsPath()], options, host);
  const entry = program.getSourceFile(entryPath);
  if (!entry) throw new Error(`could not load ${entryPath}`);
  let projectWorld: ts.Program | null = null;
  return {
    program,
    entry,
    moduleOrder: [],
    configDiags: config.diags,
    projectWorld: () => (projectWorld ??= ts.createProgram(coreRoots, options, host)),
    disposeAll: () => {
      projectWorld?.dispose();
      program.dispose();
    },
  };
}

/** The pipeline surface: ONE tsgo program serves preflight AND the
 * lowering. The caller runs checkPreflight, hands program/entry/
 * moduleOrder straight to lowerToIr, and MUST dispose() when done — the
 * spawned tsgo server must not outlive the compile. */
export function loadProgram(
  entryPath: string,
  opts?: {
    /** --npm-static: package names whose shipped JS compiles as program
     * modules this load (npm-static.ts owns the doctrine). Every load
     * RESETS the module state, so flagless loads always start clean. */
    npmStatic?: Iterable<string>;
  },
): LoadResult & { dispose: () => void } {
  // Absolute from the start: tsgo's world is absolute-path-keyed (the CLI
  // resolves before calling; this covers direct API callers too).
  entryPath = resolve(entryPath);
  setNpmStaticPackages(opts?.npmStatic ?? []);
  // Workspace-package registrations reset per load (same discipline as the
  // npm-static set), then the opted-in names are probed UP FRONT: a
  // workspace-linked opt-in resolves to files whose realpaths carry no
  // node_modules segment, and the tsgo host's fs shadow must already
  // recognize those directories while the PROGRAM is created (hiding the
  // package's declaration twins along its internal relative edges).
  // Non-opted workspace packages register lazily as preflight's own
  // resolver discovers their import edges.
  clearWorkspacePackages();
  for (const pkg of opts?.npmStatic ?? []) {
    const probe = resolveBareModule(entryPath, pkg);
    if (probe?.workspaceDir !== undefined) registerWorkspacePackage(probe.packageName, probe.workspaceDir);
  }
  // Declaration-twin hiding is scoped to the entry's own package realm
  // (see projectDtsRuntimeSibling) — set before the host exists so the
  // program never sees an out-of-realm twin hidden.
  setProjectRealm(entryPath);
  // Two fs shadows compose: --npm-static's per-package hiding, and the
  // always-on project declaration-TWIN hiding (a .d.ts beside runtime JS
  // outside node_modules — the classic typed-JS-library entry — must not exist for
  // the checker, so its resolution lands on the JS Node actually loads;
  // resolve.ts answers the same sibling for scriptc's own edges).
  const npmShadow = npmStaticFsShadow();
  const fsShadow = {
    readFile: (path: string) => npmShadow?.readFile(path),
    hideFile: (path: string) =>
      (npmShadow?.hideFile(path) ?? false) || projectDtsRuntimeSibling(path) !== null,
  };
  const host = new ts.Ts7Host({ cwd: dirname(entryPath), fsShadow });
  const load = loadProgram7(host, entryPath);
  return {
    ...load,
    dispose: () => {
      load.disposeAll();
      host.close();
    },
  };
}

/** tsc diagnostics (syntax + types), the supported-import fence, and the
 * module evaluation order: fills load.moduleOrder (the SourceFiles
 * themselves — the lowering consumes them directly) and returns the
 * preflight diagnostics. The lowerer runs only on programs that pass. */
export function checkPreflight(load: LoadResult): ScrDiagnostic[] {
  const { diags, moduleOrder, startupCrash } = preflight7(load);
  load.moduleOrder = moduleOrder;
  load.startupCrash = startupCrash;
  return diags;
}

/* Finding 5: tsgo's strict CommonJS modeling fires checker codes on JS
 * shapes 5.9.3 accepted, and the real hazards those shapes carry are fenced
 * by scriptc's OWN analysis, never by these codes — so for JS FILES ONLY
 * they join the relaxation (TS sources keep the full gate; the order-parity
 * harness holds both lanes to identical verdicts, so a case where 5.9.3
 * itself raises one of these on a JS file would fail there, not slip by):
 *  - TS2309 ("export assignment with other exported elements") on the
 *    table-then-member pattern — cjsExportDiscardReason names every export
 *    Node actually discards.
 *  - TS2323 ("cannot redeclare exported variable") on symbol-keyed expando
 *    assignments in CJS classes (`this[kSym] = v` under `module.exports =
 *    Class`) — 5.9.3 synthesized expando symbols, tsgo trips its
 *    redeclaration check instead (the corpus's countdown fixture). */
const TS7_JS_RELAXED_EXTRA: ReadonlySet<number> = new Set([2309, 2323]);

function suppressedJsStrictness7(d: ts.Diagnostic): boolean {
  const file = d.fileName;
  if (!file || !isJsSourceFileName(file)) return false;
  if (JS_RELAXED_TSC_CODES.has(d.code) || TS7_JS_RELAXED_EXTRA.has(d.code)) return true;
  // The 8xxx range is TypeScript's JSDoc-specific diagnostic family
  // (malformed tags, signature/tag mismatches): comment semantics with no
  // runtime meaning in a JS file.
  if (d.code >= 8000 && d.code <= 8999) return true;
  if (JS_ANY_OPERATOR_CODES.has(d.code)) {
    return ts.flattenDiagnosticMessageText(d, "\n").includes("'any'");
  }
  return false;
}

/** The specifier of a `require("...")` call: the callee is the bare
 * identifier `require` and the single argument a string literal. The one
 * recognizer preflight edges, global collection, and statement lowering
 * share — anything require-shaped it does NOT match (computed specifiers,
 * extra arguments) is not a module edge and fences at its use site. */
function requireSpecOf7(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require") return null;
  if (node.arguments.length !== 1) return null;
  const arg = node.arguments[0]!;
  return ts.isStringLiteral(arg) ? arg.text : null;
}

/** True for statements that are CommonJS require IMPORTS at a module's top
 * level: `const x = require("s")` / `const { a, b } = require("s")`
 * (every declarator a require), and the bare side-effect `require("s");`.
 * These lower to NOTHING — the bindings are alias plumbing (tsc models
 * them as import aliases) and the module edge lives in the order walk. */
function isRequireStatement7(stmt: ts.Statement): boolean {
  if (ts.isExpressionStatement(stmt)) return requireSpecOf7(stmt.expression) !== null;
  if (!ts.isVariableStatement(stmt)) return false;
  const decls = stmt.declarationList.declarations;
  return decls.length > 0 && decls.every((d) => d.initializer !== undefined && requireSpecOf7(d.initializer) !== null);
}

/** The require() occurrences of one top-level statement: the declaration
 * forms and the bare side-effect call. Empty for everything else. */
function requiresOf7(
  stmt: ts.Statement,
): { spec: string; node: ts.Node; decl: ts.VariableDeclaration | null }[] {
  if (ts.isExpressionStatement(stmt)) {
    const spec = requireSpecOf7(stmt.expression);
    return spec !== null ? [{ spec, node: stmt.expression, decl: null }] : [];
  }
  if (!ts.isVariableStatement(stmt)) return [];
  const out: { spec: string; node: ts.Node; decl: ts.VariableDeclaration | null }[] = [];
  for (const decl of stmt.declarationList.declarations) {
    const spec = decl.initializer !== undefined ? requireSpecOf7(decl.initializer) : null;
    if (spec !== null) out.push({ spec, node: decl, decl });
  }
  return out;
}

/** True for top-level statements that cannot run user code: directives,
 * empty statements, hoisted declarations, require statements themselves,
 * and literal-initialized variables. A require preceded ONLY by these can
 * never have its bindings observed early — nothing above it executes. */
function purePrefixStmt7(s: ts.Statement): boolean {
  if (ts.isEmptyStatement(s) || ts.isFunctionDeclaration(s)) return true;
  if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) return true; // directive
  if (isRequireStatement7(s)) return true;
  if (ts.isVariableStatement(s)) {
    return s.declarationList.declarations.every(
      (d) =>
        d.initializer === undefined ||
        requireSpecOf7(d.initializer) !== null ||
        ts.isStringLiteralLike(d.initializer) ||
        ts.isNumericLiteral(d.initializer) ||
        d.initializer.kind === ts.SyntaxKind.TrueKeyword ||
        d.initializer.kind === ts.SyntaxKind.FalseKeyword ||
        d.initializer.kind === ts.SyntaxKind.NullKeyword,
    );
  }
  return false;
}

/** Can code that runs BEFORE the require statement at index `k` reach one
 * of the require's bindings? Node initializes them AT the require (TDZ —
 * earlier access is a ReferenceError), but the lowering aliases reads
 * through to the exporter's storage with no TDZ state, so a reachable
 * early read would silently diverge. Conservative reachability: earlier
 * statements' whole subtrees (arrows and function expressions included)
 * read the binding directly, or reference a hoisted function/class whose
 * body (transitively through other hoisted declarations) reads it — a
 * referenced function value may be invoked immediately by whatever takes
 * it. Asynchronously-scheduled callbacks run after the whole module body,
 * hence after the require: never an early read. Returns the first
 * reachable binding's name, or null when position is provably free.
 * (The CheckerFacade memoizes symbol queries, and 7's client dedupes
 * symbol identity by server handle, so the Map-keyed-by-Symbol discipline
 * carries over from the 5.9.3 original unchanged.) */
function requireTdzRisk7(
  program: ts.Program,
  sf: ts.SourceFile,
  k: number,
  decl: ts.VariableDeclaration,
): string | null {
  const checker = program.getTypeChecker();
  const bound: ts.Identifier[] = [];
  if (ts.isIdentifier(decl.name)) bound.push(decl.name);
  else if (ts.isObjectBindingPattern(decl.name)) {
    for (const el of decl.name.elements) if (el.name !== undefined && ts.isIdentifier(el.name)) bound.push(el.name);
  }
  const bindings = new Map<ts.Symbol, string>();
  for (const id of bound) {
    const sym = checker.getSymbolAtLocation(id);
    if (sym) bindings.set(sym, id.text);
  }
  if (bindings.size === 0) return null;
  const stmts = sf.statements;
  const hoisted = new Map<ts.Symbol, ts.Statement>();
  for (const s of stmts) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) {
      const sym = checker.getSymbolAtLocation(s.name);
      if (sym) hoisted.set(sym, s);
    }
  }
  let hit: string | null = null;
  const scanned = new Set<ts.Statement>();
  const work: ts.Statement[] = [];
  const scan = (root: ts.Node): void => {
    // Iterative walk (walkPreorder): a statement's subtree can be
    // pathologically deep (the binderBinaryExpressionStress chains), and
    // this scan must survive it so the nesting fence can answer later.
    ts.walkPreorder(root, (n) => {
      if (ts.isIdentifier(n)) {
        const sym = checker.getSymbolAtLocation(n);
        if (sym) {
          const name = bindings.get(sym);
          if (name !== undefined) {
            hit = name;
            return "stop";
          }
          const target = hoisted.get(sym);
          if (target && !scanned.has(target)) {
            scanned.add(target);
            work.push(target);
          }
        }
      }
      return undefined;
    });
  };
  for (let i = 0; i < k && hit === null; i++) {
    const s = stmts[i]!;
    if (ts.isFunctionDeclaration(s)) continue;
    scan(s);
  }
  while (hit === null && work.length > 0) {
    scan(work.pop()!);
  }
  return hit;
}

/** Bare `require("...")` EXPRESSION STATEMENTS anywhere below the top
 * level of a file — inside top-level ifs/blocks/loops and inside function
 * bodies (the lazy-require idiom). No bindings, pure side-effect loads. */
function nestedBareRequiresOf7(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  // Iterative walk (walkPreorder): this sweep sees every JS file whole,
  // including pathologically deep expression chains that must live to be
  // fenced by name, not crash a recursive visit.
  ts.walkPreorder(sf, (n) => {
    if (
      ts.isExpressionStatement(n) &&
      !ts.isSourceFile(n.parent) &&
      ts.isCallExpression(n.expression) &&
      requireSpecOf7(n.expression) !== null
    ) {
      out.push(n.expression);
    }
  });
  return out;
}

/** True when Node would treat this file as an ES MODULE (never defining
 * require/__dirname there): .mjs always, .cjs never, and .js/.ts by
 * syntactic module detection — spelled to 5.9.3's OBSERVED bundler-mode
 * behavior (it set impliedNodeFormat only for the mjs/cjs families; 7's
 * client SourceFile has no impliedNodeFormat at all). */
function isNodeEsmFile7(sf: ts.SourceFile): boolean {
  if (sf.fileName.endsWith(".cjs") || sf.fileName.endsWith(".cts")) return false;
  if (sf.fileName.endsWith(".mjs") || sf.fileName.endsWith(".mts")) return true;
  return ts.isExternalModule(sf);
}

/** A JavaScript source file Node treats as CommonJS (not an ES module):
 * ESM namespace/default machinery must not claim it — its export surface
 * is module.exports, read through the CJS interop paths and their own
 * fences. */
function isCjsJsFile7(sf: ts.SourceFile): boolean {
  return isJsSourceFileName(sf.fileName) && !isNodeEsmFile7(sf);
}

/** The exported spelling of isCjsJsFile7 (the lowering's gate for
 * module.exports surfaces — `ts.isExternalModule` is NOT the CJS test:
 * tsgo marks CJS files with export assignments as external modules). */
export function isCjsJsFile(sf: ts.SourceFile): boolean {
  return isCjsJsFile7(sf);
}

/** The self-import TDZ fences: for `import { x } from "<self>"` (default
 * and namespace forms included), any TOP-LEVEL reference lexically above
 * the aliased declaration observes Node's temporal dead zone — the direct
 * spelling of the same read is tsc's own TS2448, which the import
 * indirection dodges, so preflight restores the bar with SC1030. Function
 * aliases hoist (initialized at link — readable anywhere); references
 * inside function-like bodies follow the direct spelling's existing
 * policy (tsc accepts those too) and are not fenced here. Namespace
 * bindings fence per MEMBER access (`self.x` above x's declaration);
 * the bare namespace binding itself is never TDZ. */
function selfImportTdzFences7(
  program: ts.Program,
  sf: ts.SourceFile,
  clause: ts.ImportClause,
  diags: ScrDiagnostic[],
): void {
  const checker = program.getTypeChecker();
  const insideFunction = (node: ts.Node): boolean => {
    for (let p = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isFunctionLike(p)) return true;
    }
    return false;
  };
  // The aliased declaration's TDZ horizon: the position after which reads
  // are initialized. Hoisted functions have none.
  const tdzEndOf = (aliased: ts.Symbol): number | null => {
    const d = checker.valueDeclarationOf(aliased) ?? checker.declarationsOf(aliased)[0];
    if (d === undefined || d.getSourceFile() !== sf) return null;
    if (ts.isFunctionDeclaration(d)) return null;
    return d.getEnd();
  };
  const fence = (ref: ts.Identifier, name: string): void => {
    diags.push(
      unsupportedDiag(
        "SC1030",
        { file: sf.fileName, start: ref.getStart(sf), end: ref.getEnd() },
        `the self-import binding '${name}' read above its declaration (the import aliases this module's OWN binding — Node initializes it when the declaration executes, so this read throws ReferenceError; move the read below the declaration)`,
      ),
    );
  };
  const checkNamed = (bindingName: ts.Identifier): void => {
    const sym = checker.getSymbolAtLocation(bindingName);
    if (sym === undefined || !(sym.flags & ts.SymbolFlags.Alias)) return;
    const end = tdzEndOf(checker.getAliasedSymbol(sym));
    if (end === null) return;
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== bindingName &&
        node.text === bindingName.text &&
        node.getStart(sf) < end &&
        !insideFunction(node) &&
        checker.getSymbolAtLocation(node) === sym
      ) {
        fence(node, bindingName.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  if (clause.name !== undefined) checkNamed(clause.name);
  if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
    for (const el of clause.namedBindings.elements) {
      if (!el.isTypeOnly) checkNamed(el.name);
    }
  }
  if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
    const nsName = clause.namedBindings.name;
    const nsSym = checker.getSymbolAtLocation(nsName);
    if (nsSym === undefined) return;
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === nsName.text &&
        ts.isIdentifier(node.name) &&
        !insideFunction(node) &&
        checker.getSymbolAtLocation(node.expression) === nsSym
      ) {
        const memberSym = checker.getSymbolAtLocation(node.name);
        if (memberSym !== undefined) {
          const end = tdzEndOf(memberSym);
          if (end !== null && node.getStart(sf) < end) fence(node.expression, `${nsName.text}.${node.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

/** True when every reference to the namespace-import binding `nsName`
 * (outside its own declaration) is exactly a bare expression statement's
 * expression — the shape whose lowering is Node's no-op. A self-import's
 * references all live in the importing file, so one file-local scan
 * answers completely. */
function nsBindingUsesAreBareStatements7(
  program: ts.Program,
  sf: ts.SourceFile,
  nsName: ts.Identifier,
): boolean {
  const checker = program.getTypeChecker();
  const bindingSym = checker.getSymbolAtLocation(nsName);
  if (bindingSym === undefined) return false;
  let bareOnly = true;
  const visit = (node: ts.Node): void => {
    if (!bareOnly) return;
    if (
      ts.isIdentifier(node) &&
      node !== nsName &&
      node.text === nsName.text &&
      checker.getSymbolAtLocation(node) === bindingSym
    ) {
      if (!(node.parent !== undefined && ts.isExpressionStatement(node.parent) && node.parent.expression === node)) {
        bareOnly = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bareOnly;
}

/* ── benign-cycle admission ──────────────────────────────────────────────
 * Node runs legal ESM cycles all over the ecosystem: the revisited module
 * is a cache hit, and the only hazard is a READ of a binding before its
 * declaration executed (TDZ ReferenceError for let/const/class, a stale
 * `undefined` for var) — runtime evaluation-order semantics the static
 * story does not model, so cycles where such a read is REACHABLE keep the
 * SC1016 fence. A cycle is admitted when partial initialization is
 * provably unobservable — the DECLARATION-ONLY INIT WINDOW rule:
 *
 *  1. Every module of the cycle cluster (the strongly-connected component
 *     — any member may be mid-initialization while another's top level
 *     runs, and every module that can even NAME a cluster binding during
 *     the window is itself in the cluster) is an ES module whose top
 *     level is INERT: declarations and expressions that cannot call into
 *     user code (nonInertTopLevel7).
 *  2. Every use of each binding the cycle-closing statement imports sits
 *     in a DEFERRED position — inside a function body, a parameter
 *     default, or an instance-field initializer (inDeferredPosition7).
 *
 * Together: cluster bindings are read only from function bodies, and no
 * top level in the window can call a function, so the first possible read
 * happens after every member initialized — the guarded %init calls then
 * reproduce Node's cache-hit order exactly, and Node's TDZ/stale-slot
 * outcomes are unreachable. */

/** A module edge, carrying what cycle admission needs when it turns out
 * to close one. `stmt` is the importing/re-exporting statement; absent
 * for require() edges, which are never admitted (their CJS home fails the
 * cluster check anyway). */
export interface CycleEdge {
  dep: ts.SourceFile;
  stmt?: ts.ImportDeclaration | ts.ExportDeclaration;
}

/** True when the reference at `node` can only evaluate AFTER the module
 * graph finished initializing: inside a function-like BODY, inside a
 * parameter (default initializers evaluate at call time), or inside an
 * INSTANCE field initializer (runs at construction, and no admitted top
 * level constructs). Static field initializers, static blocks, heritage
 * clauses, computed names, and decorators all run at the class statement
 * itself — not deferred. */
function inDeferredPosition7(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let p: ts.Node | undefined = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (p.kind === ts.SyntaxKind.Decorator) return false;
    if (ts.isClassStaticBlockDeclaration(p)) return false;
    if (ts.isFunctionLike(p)) {
      if ((p as { body?: ts.Node }).body === child) return true;
      if (ts.isParameter(child)) return true;
    }
    if (
      ts.isPropertyDeclaration(p) &&
      p.initializer === child &&
      (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Static) === 0
    ) {
      return true;
    }
    child = p;
  }
  return false;
}

/** True for identifiers in pure TYPE positions (annotations, `typeof`
 * queries, interface/alias bodies) — erased at runtime, never a read. A
 * CLASS `extends` heritage expression is the one TypeNode-shaped position
 * that IS a runtime read. */
function inTypePosition7(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isTypeNode(p)) {
      const heritage = p.parent;
      const isClassExtends =
        p.kind === ts.SyntaxKind.ExpressionWithTypeArguments &&
        heritage !== undefined &&
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent));
      if (!isClassExtends) return true;
    }
    if (ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
  }
  return false;
}

/** The first top-level construct of `sf` that could execute USER code
 * during a cycle's init window, or null when the module's top level is
 * declaration-only ("inert"). The expression whitelist is deliberately
 * conservative — anything that could CALL user code (directly, through a
 * callback-invoking builtin, a getter, an iterator, or an implicit
 * coercion of a user object) disqualifies the module's cycles. */
function nonInertTopLevel7(program: ts.Program, sf: ts.SourceFile): ts.Node | null {
  const checker = program.getTypeChecker();
  const PRIM =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never;
  /** Coercion-safe: the expression's type is primitive in every arm, so
   * ToString/ToNumber/ToPrimitive can never reach a user valueOf. */
  const primitiveTyped = (e: ts.Expression): boolean => {
    const t = checker.getTypeAtLocation(e);
    const parts = t.isUnionType() ? t.getTypes() : [t];
    return parts.every((p) => (p.flags & PRIM) !== 0);
  };
  /** The identifier's symbol lives entirely in declaration files — a
   * global builtin (process, WeakSet, Object, …) whose property reads and
   * calls are runtime-implemented, never user code. */
  const dtsRooted = (e: ts.Expression): boolean => {
    let root: ts.Expression = e;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
    if (ts.isMetaProperty(root)) return true; // import.meta
    if (!ts.isIdentifier(root)) return false;
    let sym = checker.getSymbolAtLocation(root);
    if (sym === undefined) return false;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decls = checker.declarationsOf(sym);
    return decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
  };
  const hasDecorator = (n: ts.Node): boolean =>
    ((n as { modifiers?: readonly ts.Node[] }).modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.Decorator);
  /** No function-like node anywhere in the subtree — arguments to builtin
   * calls must not smuggle a callback the builtin could invoke. */
  const containsFunctionLike = (n: ts.Node): boolean => {
    let found = false;
    ts.walkPreorder(n, (c) => {
      if (ts.isFunctionLike(c) || ts.isClassExpression(c) || ts.isClassDeclaration(c)) {
        found = true;
        return "stop";
      }
      return undefined;
    });
    return found;
  };
  const inertClass = (c: ts.ClassLikeDeclaration): ts.Node | null => {
    if (hasDecorator(c)) return c;
    for (const h of c.heritageClauses ?? []) {
      if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const t of h.types) if (!inert(t.expression)) return t.expression;
    }
    for (const m of c.members) {
      if (ts.isClassStaticBlockDeclaration(m)) return m;
      if (hasDecorator(m)) return m;
      const memberName = (m as { name?: ts.PropertyName }).name;
      if (memberName !== undefined && ts.isComputedPropertyName(memberName)) {
        if (!inert(memberName.expression) || !primitiveTyped(memberName.expression)) return memberName;
      }
      if (
        ts.isPropertyDeclaration(m) &&
        (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0 &&
        m.initializer !== undefined &&
        !inert(m.initializer)
      ) {
        return m.initializer;
      }
    }
    return null;
  };
  const COERCING_FREE = new Set<number>([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.CommaToken,
    ts.SyntaxKind.InstanceOfKeyword,
  ]);
  const inert = (e: ts.Expression): boolean => {
    if (
      ts.isStringLiteral(e) ||
      ts.isNumericLiteral(e) ||
      ts.isBigIntLiteral(e) ||
      ts.isRegularExpressionLiteral(e) ||
      ts.isNoSubstitutionTemplateLiteral(e) ||
      e.kind === ts.SyntaxKind.TrueKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword ||
      e.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(e) ||
      ts.isMetaProperty(e) ||
      ts.isArrowFunction(e) ||
      ts.isFunctionExpression(e)
    ) {
      return true;
    }
    if (ts.isClassExpression(e)) return inertClass(e) === null;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
      return inert(e.expression);
    }
    if (ts.isPropertyAccessExpression(e)) return dtsRooted(e);
    if (ts.isElementAccessExpression(e)) {
      return dtsRooted(e) && inert(e.argumentExpression) && primitiveTyped(e.argumentExpression);
    }
    if (ts.isTemplateExpression(e)) {
      return e.templateSpans.every((s) => inert(s.expression) && primitiveTyped(s.expression));
    }
    if (ts.isVoidExpression(e) || ts.isTypeOfExpression(e)) return inert(e.expression);
    if (ts.isPrefixUnaryExpression(e)) {
      if (e.operator === ts.SyntaxKind.ExclamationToken) return inert(e.operand);
      if (
        e.operator === ts.SyntaxKind.PlusToken ||
        e.operator === ts.SyntaxKind.MinusToken ||
        e.operator === ts.SyntaxKind.TildeToken
      ) {
        return inert(e.operand) && primitiveTyped(e.operand);
      }
      return false;
    }
    if (ts.isBinaryExpression(e)) {
      if (!inert(e.left) || !inert(e.right)) return false;
      if (COERCING_FREE.has(e.operatorToken.kind)) return true;
      return primitiveTyped(e.left) && primitiveTyped(e.right);
    }
    if (ts.isConditionalExpression(e)) return inert(e.condition) && inert(e.whenTrue) && inert(e.whenFalse);
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((el) => !ts.isSpreadElement(el) && inert(el));
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.every((p) => {
        if (ts.isShorthandPropertyAssignment(p)) return true;
        if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name)) return false;
        return inert(p.initializer);
      });
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      if (!dtsRooted(e.expression) || !ts.isIdentifier(chainRoot7(e.expression))) return false;
      const args = e.arguments ?? [];
      // A CALLABLE argument is admissible when it is itself dts-rooted:
      // a builtin-owned function value (the `promisify(fs.readFile)`
      // at every cycle member's top level) is runtime-implemented — even
      // if the builtin callee invokes it, no user code runs and no
      // cluster binding is observable. Function literals and user
      // callables keep the refusal.
      return args.every(
        (a) =>
          inert(a) &&
          !containsFunctionLike(a) &&
          (checker.getCallSignatures(checker.getTypeAtLocation(a)).length === 0 || dtsRooted(a)),
      );
    }
    return false;
  };
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEmptyStatement(stmt) ||
      (ts.getCombinedModifierFlags(stmt as unknown as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0
    ) {
      continue;
    }
    if (ts.isEnumDeclaration(stmt)) {
      const bad = stmt.members.find((m) => m.initializer !== undefined && !inert(m.initializer));
      if (bad !== undefined) return bad;
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      const bad = inertClass(stmt);
      if (bad !== null) return bad;
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) return d.name; // patterns can invoke getters/iterators
        if (d.initializer !== undefined && !inert(d.initializer)) return d.initializer;
      }
      continue;
    }
    if (ts.isExpressionStatement(stmt)) {
      if (!inert(stmt.expression)) return stmt;
      continue;
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (!inert(stmt.expression)) return stmt;
      continue;
    }
    return stmt;
  }
  return null;
}

/** The head of a property/element-access chain. */
function chainRoot7(e: ts.Expression): ts.Expression {
  let root: ts.Expression = e;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
  return root;
}

/** The first use of a binding this cycle-closing import introduces that
 * sits OUTSIDE a deferred position (a read there can observe the
 * partially-initialized exporter), or null when every use defers.
 * Re-export statements bind nothing locally — always null: the alias is
 * link-time plumbing, never an evaluation-time read. Export specifiers
 * of an imported binding are the same alias story, not reads. */
function backEdgeUseOffence7(
  program: ts.Program,
  sf: ts.SourceFile,
  stmt: ts.ImportDeclaration | ts.ExportDeclaration,
): { name: string; node: ts.Node } | null {
  if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined) return null;
  const checker = program.getTypeChecker();
  const clause = stmt.importClause;
  const bindingNames: ts.Identifier[] = [];
  if (clause.name !== undefined) bindingNames.push(clause.name);
  if (clause.namedBindings !== undefined) {
    if (ts.isNamespaceImport(clause.namedBindings)) bindingNames.push(clause.namedBindings.name);
    else for (const el of clause.namedBindings.elements) if (!el.isTypeOnly) bindingNames.push(el.name);
  }
  for (const bindingName of bindingNames) {
    const sym = checker.getSymbolAtLocation(bindingName);
    if (sym === undefined) continue;
    let offence: { name: string; node: ts.Node } | null = null;
    const visit = (node: ts.Node): void => {
      if (offence !== null || ts.isImportDeclaration(node)) return;
      if (
        ts.isIdentifier(node) &&
        node.text === bindingName.text &&
        !(node.parent !== undefined && ts.isExportSpecifier(node.parent)) &&
        checker.getSymbolAtLocation(node) === sym &&
        !inTypePosition7(node) &&
        !inDeferredPosition7(node)
      ) {
        offence = { name: bindingName.text, node };
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (offence !== null) return offence;
  }
  return null;
}

/** The benign-cycle admission engine over one import graph, shared by
 * preflight's static-module walk and the --dynamic subgraph walk
 * (appendDynamicImportModules). Given a BACK edge (importer → e.dep with
 * e.dep already mid-initialization in a depth-first walk), answers null
 * to ADMIT the cycle — the guarded %init calls reproduce Node's cache-hit
 * order and nothing can observe the partial initialization — or the
 * human-readable reason it keeps the SC1016 fence. Two admission chances:
 *  - the CHEAP PER-EDGE rule: the closing statement binds nothing (a
 *    side-effect import) or binds only namespace objects whose every use
 *    is a bare expression statement — no read crosses the edge at all;
 *  - the DECLARATION-ONLY INIT WINDOW rule (the admission block above):
 *    every cluster member is an ES module with an inert top level, and
 *    the closing edge's bindings are used only in deferred positions.
 * Tarjan SCCs (lazy, rooted at each queried importer) and cluster
 * verdicts are memoized across calls, so `edgesOf` must answer the same
 * edges for the same file every time. */
export function makeCycleAdmission(
  program: ts.Program,
  edgesOf: (sf: ts.SourceFile) => readonly CycleEdge[],
): (importer: ts.SourceFile, e: CycleEdge) => string | null {
  // Tarjan over the same edges the order walk uses (self-edges skipped —
  // Node's self-reference rule makes those benign before admission is
  // ever asked). State persists across lazily-added roots: a later
  // strongconnect over an unvisited root composes with earlier runs
  // exactly like the classic all-roots loop.
  const sccOf = new Map<ts.SourceFile, ts.SourceFile[]>();
  const index = new Map<ts.SourceFile, number>();
  const low = new Map<ts.SourceFile, number>();
  const onStack = new Set<ts.SourceFile>();
  const tstack: ts.SourceFile[] = [];
  let next = 0;
  const strongconnect = (v: ts.SourceFile): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    tstack.push(v);
    onStack.add(v);
    for (const e of edgesOf(v)) {
      const w = e.dep;
      if (w === v) continue;
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: ts.SourceFile[] = [];
      for (;;) {
        const w = tstack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      for (const w of comp) sccOf.set(w, comp);
    }
  };
  const lineOf = (node: ts.Node): string => {
    const nsf = node.getSourceFile();
    return `${nsf.fileName}:${ts.getLineAndCharacterOfPosition(nsf, node.getStart(nsf)).line + 1}`;
  };
  // Cluster verdict memo (keyed by the component array identity): the
  // reason the cluster's cycles stay fenced, or null when its every
  // member passes the inert-top-level bar.
  const sccVerdict = new Map<ts.SourceFile[], string | null>();
  return (importer: ts.SourceFile, e: CycleEdge): string | null => {
    if (e.stmt === undefined) return "the cycle closes through a require() edge";
    // Cheap per-edge admission: nothing readable binds through the edge.
    if (ts.isImportDeclaration(e.stmt)) {
      const clause = e.stmt.importClause;
      if (
        clause === undefined ||
        (clause.name === undefined &&
          (clause.namedBindings === undefined ||
            (ts.isNamespaceImport(clause.namedBindings) &&
              nsBindingUsesAreBareStatements7(program, importer, clause.namedBindings.name))))
      ) {
        return null;
      }
    }
    if (!index.has(importer)) strongconnect(importer);
    const comp = sccOf.get(e.dep);
    if (comp === undefined || comp.length < 2 || !comp.includes(importer)) {
      return "the cycle's module cluster could not be analyzed";
    }
    if (!sccVerdict.has(comp)) {
      let reason: string | null = null;
      for (const m of comp) {
        if (isCjsJsFile7(m)) {
          reason = `${m.fileName} is a CommonJS module — admission covers ES-module cycles only`;
          break;
        }
        const off = nonInertTopLevel7(program, m);
        if (off !== null) {
          reason = `top-level code at ${lineOf(off)} can run user code during the cycle's init window — only declaration-only module bodies are admitted`;
          break;
        }
      }
      sccVerdict.set(comp, reason);
    }
    const clusterReason = sccVerdict.get(comp)!;
    if (clusterReason !== null) return clusterReason;
    const use = backEdgeUseOffence7(program, importer, e.stmt);
    if (use !== null) {
      return `the cycle-crossing binding '${use.name}' is read at ${lineOf(use.node)}, outside any function body — a read during the init window observes the partially-initialized module (Node's TDZ ReferenceError / stale var), which is not modeled`;
    }
    return null;
  };
}

/** Resolves an import specifier from `from` to a source file of the
 * program, or null (unresolvable / outside the program). Exported (as
 * resolveImport) for the lowering: CommonJS require statements lower to
 * guarded %init calls of exactly the module preflight resolved here. */
function resolveImport7(program: ts.Program, from: ts.SourceFile, specifier: string): ts.SourceFile | null {
  // tsconfig "paths" aliases take precedence over relative and bare resolution.
  const pathsResolved = resolvePathsAlias(from.fileName, specifier);
  if (pathsResolved !== null) return program.getSourceFile(pathsResolved) ?? null;
  const resolved = resolveRelativeModule(from.fileName, specifier);
  if (resolved === null) return null;
  return program.getSourceFile(resolved) ?? null;
}

/** An import that resolves into node_modules: the package's shipped .d.ts
 * is the type surface, and the package's shipped JS runs in the dynamic
 * island under --dynamic. Resolution rides the own resolver (resolve.ts).
 * Null for relative and node: specifiers, and for anything that doesn't
 * resolve into node_modules. */
function resolveNpmImport7(
  fromFileName: string,
  specifier: string,
): { packageName: string; version?: string; typesFile: string } | null {
  if (isRelativeSpecifier(specifier) || specifier.startsWith("node:")) {
    return null;
  }
  // --provenance-sources: a registered specifier is NOT an npm import —
  // its attested source compiles as program modules (resolveProjectImport
  // answers the entry), so no island embed and no .d.ts type surface.
  if (provenanceEntryFor(specifier) !== null) return null;
  const resolved = resolveBareModule(fromFileName, specifier);
  if (!resolved) return null;
  if (!isNodeModulesPath(resolved.typesFile)) {
    // A workspace-linked package (the node_modules entry is a symlink into
    // the project — every monorepo tool's internal-package install): Node
    // resolves and runs it exactly like any installed package, so it IS an
    // npm import; the realpath'd answer escaping node_modules must not
    // refuse the edge. Registered so path-keyed package attribution
    // (shared.ts) recognizes the package's real files. Anything else
    // whose answer left node_modules stays refused.
    if (resolved.workspaceDir === undefined) return null;
    registerWorkspacePackage(resolved.packageName, resolved.workspaceDir);
  }
  return {
    packageName: resolved.packageName,
    ...(resolved.version !== undefined ? { version: resolved.version } : {}),
    typesFile: resolved.typesFile,
  };
}

function locOf7(node: ts.Node): { file: string; start: number; end: number } {
  const sf = node.getSourceFile();
  return { file: sf.fileName, start: node.getStart(sf), end: node.getEnd() };
}

/** The PROGRAM source file an opted-in --npm-static package's resolved
 * entry maps to, or null with the package marked an offender (resolution
 * still answering declarations, or the file missing from the type-checked
 * program — a path-identity mismatch between the two resolvers). */
function npmStaticProgramDep(
  program: ts.Program,
  packageName: string,
  resolvedFile: string,
): ts.SourceFile | null {
  if (!isJsSourceFileName(resolvedFile)) {
    reportNpmStaticOffender(
      packageName,
      `its import resolves to '${resolvedFile}', not to runtime JavaScript`,
    );
    return null;
  }
  let dep = program.getSourceFile(resolvedFile) ?? null;
  if (dep === null) {
    // A workspace-linked package shipping its .ts SOURCE beside the
    // compiled .js: the checker's resolution preferred the source (it
    // outranks the sibling .js under bundler resolution), so the program
    // holds the .ts twin at the same stem — the same module, in its
    // richer spelling.
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      dep = program.getSourceFile(resolvedFile.replace(/\.(js|mjs|cjs)$/, ext)) ?? null;
      if (dep !== null) break;
    }
  }
  if (dep === null) {
    reportNpmStaticOffender(
      packageName,
      `its entry '${resolvedFile}' did not join the type-checked program`,
    );
    return null;
  }
  return dep;
}

/** `const process = require('node:process')` (identifier binding) and the
 * bare side-effect `require('node:process')`: Node's process module IS
 * the global process object, so the binding is a stdlib-global alias
 * (surfaces.ts registers it; reads lower through the process surface) and
 * the bare load is a no-op. These forms are exempt from the SC1010
 * builtin fence; every other shape (destructuring, subpath) keeps it. */
function processModuleAliasRequire7(spec: string, decl: ts.VariableDeclaration | null): boolean {
  if (spec !== "process" && spec !== "node:process") return false;
  return decl === null || ts.isIdentifier(decl.name);
}

/** The whole TS7-lane lifecycle for one entry: spawn (or share) a tsgo
 * host, build the lowering-world program, run the ported preflight, and
 * dispose EVERYTHING before returning — the CLI process must exit promptly,
 * so no snapshot or tsgo child outlives the call. */
export function checkPreflightTs7(
  entryPath: string,
  sharedHost?: ts.Ts7Host,
): { diags: ScrDiagnostic[]; moduleOrder: string[] } {
  const host = sharedHost ?? new ts.Ts7Host({ cwd: dirname(entryPath) });
  try {
    const load = loadProgram7(host, entryPath);
    try {
      const { diags, moduleOrder } = preflight7(load);
      return { diags, moduleOrder: moduleOrder.map((sf) => sf.fileName) };
    } finally {
      load.disposeAll();
    }
  } finally {
    if (!sharedHost) host.close();
  }
}

function preflight7(load: LoadResult): {
  diags: ScrDiagnostic[];
  moduleOrder: ts.SourceFile[];
  startupCrash: StartupCrash | null;
} {
  const { program, entry } = load;
  const diags: ScrDiagnostic[] = [...load.configDiags];

  // Workspace-linked packages register BEFORE the tsc gate. Their files
  // live at realpaths OUTSIDE node_modules (the monorepo-tool symlink
  // shape), so nothing path-shaped marks them as npm surface — yet their
  // shipped JS is the identical foreign-tsconfig story as node_modules JS
  // (the island executes it under --dynamic; the author's own build
  // checked it, the program's author cannot fix it). The lazy
  // registration inside the import-fence walk below runs AFTER errorsOf,
  // too late for the gate, so one pass over the program's import edges
  // registers them up front: every bare specifier any program file loads —
  // import/export declarations, dynamic import("literal") (tsgo chases
  // those into the program too; a CLI reaches its workspace sibling exactly
  // that way), require("literal") — resolved with the own resolver,
  // workspace answers recorded.
  {
    const supportedBuiltins = new Set<string>(SUPPORTED_NODE_MODULES);
    const probed = new Set<string>();
    const probe = (fromFile: string, spec: string): void => {
      if (
        isRelativeSpecifier(spec) ||
        spec.startsWith("#") ||
        spec.startsWith("node:") ||
        supportedBuiltins.has(spec)
      ) {
        return;
      }
      const key = `${dirname(fromFile)} ${spec}`;
      if (probed.has(key)) return;
      probed.add(key);
      const r = resolveBareModule(fromFile, spec);
      if (r !== null && r.workspaceDir !== undefined) registerWorkspacePackage(r.packageName, r.workspaceDir);
    };
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || sf.fileName.endsWith(".json")) continue;
      ts.walkPreorder(sf, (n) => {
        if (
          (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
          n.moduleSpecifier !== undefined &&
          ts.isStringLiteral(n.moduleSpecifier)
        ) {
          probe(sf.fileName, n.moduleSpecifier.text);
          return "skip";
        }
        if (ts.isCallExpression(n)) {
          const arg = n.arguments[0];
          const isImportCall = n.expression.kind === ts.SyntaxKind.ImportKeyword;
          const isRequireCall = ts.isIdentifier(n.expression) && n.expression.text === "require";
          if ((isImportCall || isRequireCall) && arg !== undefined && ts.isStringLiteralLike(arg)) {
            probe(sf.fileName, arg.text);
          }
        }
        return undefined;
      });
    }
  }

  const toPassthrough = (d: ts.Diagnostic): ScrDiagnostic => {
    const message = ts.flattenDiagnosticMessageText(d, "\n");
    // File-less (global/options) diagnostics anchor at the entry with a
    // zero span, exactly like the 5.9.3 lane's `d.start ?? 0` fallback.
    const file = d.fileName ?? entry.fileName;
    const start = d.fileName !== undefined ? d.pos : 0;
    const end = d.fileName !== undefined ? d.end : 0;
    return tscPassthroughDiag(message, { file, start, end });
  };
  /* TS7 checker change (not finding 5, same discipline): tsgo types a
   * NAMESPACE import as the spec's non-callable module namespace object
   * even when the module is declared with the callable `export =` shape —
   * 5.9.3 bound the callable value directly, so `import * as a from
   * "node:assert"; a(x)` typechecked there and draws TS2349 here. Those
   * callable module objects are scriptc's OWN declared surface, and calls
   * through the namespace binding are fenced per site by the lowering (the
   * assert-fences fixture pins the wording), so tsgo's extra TS2349 on
   * exactly those callees — an identifier that is a namespace-import
   * binding of a supported builtin module — is suppressed to the 5.9.3
   * verdict. Nothing else rides this: any other non-callable call keeps
   * tsc's voice in both lanes. */
  const builtinNamespaceNames = new Map<string, Set<string>>();
  const namespaceCalleeSuppressed = (p: ts.Program, d: ts.Diagnostic): boolean => {
    if (d.code !== 2349 || d.fileName === undefined) return false;
    let names = builtinNamespaceNames.get(d.fileName);
    if (!names) {
      names = new Set();
      builtinNamespaceNames.set(d.fileName, names);
      const sf = p.getSourceFile(d.fileName);
      for (const stmt of sf?.statements ?? []) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        if (canonicalBuiltinModule(stmt.moduleSpecifier.text) === null) continue;
        const bindings = stmt.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      }
    }
    if (names.size === 0) return false;
    const sf = p.getSourceFile(d.fileName);
    return sf !== undefined && names.has(sf.text.slice(d.pos, d.end));
  };
  /* --npm-static: checker errors INSIDE an opted-in package's files never
   * gate the build — the package's author checked that JS under a foreign
   * tsconfig (their own lib choices, their own strictness), the program's
   * author cannot fix it, and the JS design already names where inference
   * gaps land: the per-statement runtime fences (trust-but-verify — a
   * statement the checker could not prove compiles to its honest trap,
   * never to a silent guess). scriptc's OWN SC1xxx fences in those files
   * still count — preflight structure problems mark the package an
   * offender and it falls back to the island. */
  const npmStaticFileSuppressed = (d: ts.Diagnostic): boolean =>
    d.fileName !== undefined && npmStaticPackageOfPath(d.fileName) !== null;
  /* The same doctrine for node_modules JS the opt-in never NAMED:
   * maxNodeModuleJsDepth (set only on --npm-static loads) admits ANY
   * node_modules JavaScript the checker's resolution touches — e.g. an
   * ambient `declare module "punycode"` in @types/node now loses to an
   * INSTALLED punycode package's JS, which checkJs then checks. Those
   * files' errors are the identical foreign-tsconfig story (third-party
   * shipped JS the program's author cannot fix), they were invisible to
   * every flagless compile (depth 0 keeps node_modules JS out of the
   * program), and the packages themselves still island — so their checker
   * errors never gate a build. */
  /* WORKSPACE-LINKED shipped JS is the same story at a different path: the
   * package's files realpath OUTSIDE node_modules (so depth-0 exclusion
   * never saw them and allowJs+checkJs pulls them straight into the
   * program), but they are npm surface all the same — the island executes
   * them, the program's author cannot fix them (a workspace package shipping
   * an ncc bundle with dozens of checker errors). Registered up front (the
   * pass above), suppressed here unless --npm-static opted them into being
   * program modules. */
  const islandJsFile = (file: string): boolean =>
    isJsSourceFileName(file) &&
    npmStaticPackageOfPath(file) === null &&
    (isNodeModulesPath(file) || workspacePackageOfPath(file) !== null);
  const nodeModulesJsSuppressed = (d: ts.Diagnostic): boolean =>
    d.fileName !== undefined && islandJsFile(d.fileName);
  /* JSDoc TYPE positions in JS files are documentation Node never reads:
   * a name-resolution failure THERE (2304/2552 — the pattern's utilities.js
   * spells a mapped type over a @template name it never declared) types
   * as the error-any and the per-site fences apply, same stance as the
   * strictness families above. A 2300 duplicate-identifier PAIR formed by
   * a @typedef and a same-named class/function is the same story — the
   * typedef half sits inside the comment, and the code half is suppressed
   * exactly when its partner (same file, same name) was comment-side, so
   * a REAL duplicate declaration (both halves in code — Node's own
   * SyntaxError) keeps tsc's voice. */
  const insideBlockComment = (text: string, pos: number): boolean => {
    const open = text.lastIndexOf("/*", pos);
    if (open < 0) return false;
    const close = text.indexOf("*/", open + 2);
    return close === -1 || close >= pos;
  };
  const jsdocTypeSuppressed = (p: ts.Program, d: ts.Diagnostic, commentDup: Set<string>): boolean => {
    if (d.fileName === undefined || !isJsSourceFileName(d.fileName)) return false;
    if (d.code !== 2304 && d.code !== 2552 && d.code !== 2300 && d.code !== 1003) return false;
    if (d.pos === undefined) return false;
    const sf = p.getSourceFile(d.fileName);
    if (!sf) return false;
    if (insideBlockComment(sf.text, d.pos)) return true;
    return d.code === 2300 && commentDup.has(`${d.fileName}:${sf.text.slice(d.pos, d.end)}`);
  };
  /* A workspace member installed by COPY ships its JS inside node_modules,
   * where depth-0 exclusion keeps it out of the checker's program — an
   * UNTYPED member then types as an implicit-any module (TS7016) at every
   * import site. The symlinked install of the same tree never sees this
   * (the realpath escapes node_modules and allowJs types the member from
   * its JS), and the package is the program author's own workspace code
   * with the island as its execution home — "install @types" is not
   * actionable — so the copied shape must not gate either: a 7016 whose
   * specifier names a REGISTERED workspace package (the eager
   * registration pass above runs first) is suppressed, and the import
   * takes the same per-site island story as any untyped npm package. */
  const workspaceImplicitAnySuppressed = (p: ts.Program, d: ts.Diagnostic): boolean => {
    if (d.code !== 7016 || d.fileName === undefined || d.pos === undefined || d.end === undefined) return false;
    const sf = p.getSourceFile(d.fileName);
    if (!sf) return false;
    const spec = sf.text.slice(d.pos, d.end).replace(/^['"]|['"]$/g, "");
    const prefix = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    return isWorkspacePackageName(prefix);
  };
  const errorsOf = (p: ts.Program): ts.Diagnostic[] => {
    const all = ts.getPreEmitDiagnostics(p);
    // First pass: every comment-side 2300's (file, name) — the partners
    // the second pass forgives.
    const commentDup = new Set<string>();
    for (const d of all) {
      if (d.code !== 2300 || d.fileName === undefined || d.pos === undefined || d.end === undefined) continue;
      if (!isJsSourceFileName(d.fileName)) continue;
      const sf = p.getSourceFile(d.fileName);
      if (sf && insideBlockComment(sf.text, d.pos)) commentDup.add(`${d.fileName}:${sf.text.slice(d.pos, d.end)}`);
    }
    return all.filter(
      (d) =>
        d.category === ts.DiagnosticCategory.Error &&
        !suppressedJsStrictness7(d) &&
        !npmStaticFileSuppressed(d) &&
        !nodeModulesJsSuppressed(d) &&
        !namespaceCalleeSuppressed(p, d) &&
        !workspaceImplicitAnySuppressed(p, d) &&
        !jsdocTypeSuppressed(p, d, commentDup),
    );
  };

  // The tsc gate, with a second chance: the LOWERING world's checker
  // includes the divergence overrides (JSON.parse(): unknown, the Promise
  // executor shape, ...), which are TIGHTER than the standard lib — a
  // project that typechecks clean under its own tsc can still error here
  // (any-typed JSON.parse results, most commonly). Those errors are OURS,
  // not the project's, so they must not fail preflight: when the lowering
  // world has errors, the PROJECT world (same program without the override
  // declarations) is built and consulted. Clean there → preflight passes
  // and the override-affected sites meet the lowerer's honest fences
  // instead (the SC1100 checked-cast family). Dirty there → the project-
  // world errors are the ones reported: they are reproducible with the
  // project's own tsc, which is what "fix type errors first" asks for.
  const tscErrors = errorsOf(program);
  if (tscErrors.length > 0) {
    for (const d of errorsOf(load.projectWorld())) diags.push(toPassthrough(d));
  }

  const ambient = ambientDtsPath();
  // node_modules JS that no --npm-static opt-in claims is NOT program
  // source even when maxNodeModuleJsDepth pulled it into the checker's
  // program (see nodeModulesJsSuppressed above): its execution home is the
  // island, so preflight's statement walks skip it — no import fences, no
  // module edges, no statement counts from files the lowering never lowers.
  const userFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        sf.fileName !== ambient &&
        !sf.isDeclarationFile &&
        !sf.fileName.endsWith(".json") &&
        (!isNodeModulesPath(sf.fileName) || npmStaticPackageOfPath(sf.fileName) !== null) &&
        // Workspace-linked shipped JS (see islandJsFile): its execution
        // home is the island exactly like node_modules JS, so no import
        // fences, no module edges, no statement counts from it. Its .ts
        // files (a workspace package imported bare AND reached relatively)
        // stay program source — only the island-bound JS steps out.
        !islandJsFile(sf.fileName),
    );

  const ambientModules = new Set<string>(SUPPORTED_NODE_MODULES);

  // Ambient `declare module "name"` declarations anywhere in the program —
  // exact names and `*` patterns — so the import fence can say "type
  // surface only, no runtime module" instead of the generic package story.
  // Computed lazily: the scan only runs when a bare-import fence is about
  // to fire.
  let ambientModuleDecls: { names: Set<string>; patterns: string[] } | null = null;
  const ambientDeclared = (spec: string): boolean => {
    if (ambientModuleDecls === null) {
      ambientModuleDecls = { names: new Set(), patterns: [] };
      for (const f of program.getSourceFiles()) {
        for (const s of f.statements) {
          if (!ts.isModuleDeclaration(s) || !ts.isStringLiteral(s.name)) continue;
          const name = s.name.text;
          if (name.includes("*")) ambientModuleDecls.patterns.push(name);
          else ambientModuleDecls.names.add(name);
        }
      }
    }
    if (ambientModuleDecls.names.has(spec)) return true;
    return ambientModuleDecls.patterns.some((p) => {
      const star = p.indexOf("*");
      return (
        spec.length >= p.length - 1 &&
        spec.startsWith(p.slice(0, star)) &&
        spec.endsWith(p.slice(star + 1))
      );
    });
  };

  // Module edges. An edge that closes a cycle is judged by the shared
  // admission engine (makeCycleAdmission): admissible when nothing can
  // OBSERVE the partially-initialized module through it — the importing
  // statement binds nothing (side-effect import) or binds only NAMESPACE
  // objects (initialized at link, never TDZ) whose every use is a bare
  // expression statement (the no-op lowering; no member is ever read),
  // or the cycle passes the declaration-only init window analysis (the
  // benign-cycle admission block above). Node evaluates such cycles
  // benignly (the revisited module is a cache hit, and no binding read
  // can hit TDZ or a stale slot), so the guarded %init calls reproduce
  // its order exactly. Cycles that fail both keep the SC1016 fence,
  // because a read through them mid-cycle observes TDZ (let/const) or
  // undefined (var) in Node — runtime evaluation-order semantics the
  // static story does not model.
  const edges = new Map<ts.SourceFile, CycleEdge[]>();
  // Import edges Node's RESOLUTION refuses before any module evaluates —
  // recorded in source order per file (interleaved with the resolved deps
  // via `pos`) so the Node-order walk below can answer which refusal Node
  // reports first. Each carries a fallback fence: a refusal in a module
  // the entry never reaches contributes no startup crash (Node never
  // resolves it), so it keeps today's compile-time diagnostic instead.
  interface RefusalCandidate {
    crash: StartupCrash;
    fallback: ScrDiagnostic;
    pos: number;
  }
  const refusals = new Map<ts.SourceFile, RefusalCandidate[]>();
  const depPositions = new Map<ts.SourceFile, { dep: ts.SourceFile; pos: number }[]>();
  for (const sf of userFiles) {
    const deps: CycleEdge[] = [];
    edges.set(sf, deps);
    refusals.set(sf, []);
    depPositions.set(sf, []);
    for (const stmt of sf.statements) {
      if (ts.isImportEqualsDeclaration(stmt)) {
        // The ENTITY form (`import a = A`, `import x = N.y`) is namespace
        // alias plumbing — the lowerer resolves references through it and
        // fences what it cannot honor (lower-namespaces.ts). Only the
        // require form is a module edge, and its RUNTIME form stays fenced
        // (under the forced ESNext module world tsc itself rejects it, so
        // only nested/namespace-internal sites can reach the lowering's
        // fence); `import type x = require(...)` is pure type surface and
        // lowers to nothing.
        if (ts.isExternalModuleReference(stmt.moduleReference) && !stmt.isTypeOnly) {
          diags.push(unsupportedDiag("SC1013", locOf7(stmt), "import = require(...) assignments"));
        }
        continue;
      }
      if (ts.isExportAssignment(stmt)) {
        if (stmt.isExportEquals) {
          diags.push(unsupportedDiag("SC1012", locOf7(stmt), "export = assignments"));
        }
        continue;
      }
      if (ts.isExportDeclaration(stmt)) {
        if (stmt.isTypeOnly || erasedTypeOnlyReexport(stmt)) continue;
        if (!stmt.moduleSpecifier) continue;
        const fromSpec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
        if (!isRelativeSpecifier(fromSpec)) {
          // NAMED re-exports from a SUPPORTED builtin pass (`export { ok }
          // from "node:assert"` — a universal re-export facade facade): the
          // statement binds nothing locally and evaluates nothing (builtins
          // have no %init), and importers' references chase the alias to
          // the builtin's own declarations exactly as if they imported the
          // builtin directly — per-member support stays the lowering's
          // per-site business. Star and namespace re-exports and package
          // specifiers keep the fence.
          if (
            canonicalBuiltinModule(fromSpec) !== null &&
            stmt.exportClause !== undefined &&
            ts.isNamedExports(stmt.exportClause)
          ) {
            continue;
          }
          // NAMED re-exports from an INSTALLED npm package (`export
          // { isUrl } from "url-or-path"` — the pattern's universal facade,
          // `export { visitorKeys as default } from "@glimmer/syntax"`):
          // import-plus-export plumbing. collectNpmImports registers the
          // island load at this statement's position in the exporter's
          // init and keys each binding by the same aliased symbol a
          // direct import would, so consumer reads resolve identically
          // through the alias chain. Star re-exports and unresolvable
          // specifiers keep the fence (no member list to bind / nothing
          // installed to load).
          if (
            stmt.exportClause !== undefined &&
            ts.isNamedExports(stmt.exportClause) &&
            !fromSpec.startsWith("#") &&
            resolveNpmImport7(sf.fileName, fromSpec) !== null
          ) {
            continue;
          }
          diags.push(unsupportedDiag("SC1014", locOf7(stmt), "re-exports from packages or builtin modules"));
          continue;
        }
        const reDep = resolveImport7(program, sf, fromSpec);
        // `export * as ns from "./m"` re-exports the module NAMESPACE
        // object under a name: importers' `x.ns.member` reads resolve
        // statically through the same alias machinery as `import * as ns`
        // (moduleNsSymbolOf follows the chain to the module symbol), so a
        // RESOLVED user module lowers; everything else keeps the fence —
        // there is no namespace object to materialize.
        if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
          if (reDep === null || reDep.fileName.endsWith(".json") || isCjsJsFile7(reDep)) {
            diags.push(unsupportedDiag("SC1013", locOf7(stmt), "namespace re-exports (export * as ns) of this module form"));
            continue;
          }
        }
        if (reDep && !reDep.fileName.endsWith(".json")) {
          deps.push({ dep: reDep, stmt });
          depPositions.get(sf)!.push({ dep: reDep, pos: stmt.getStart(sf) });
        }
        continue;
      }
      if (!ts.isImportDeclaration(stmt)) continue;
      if (erasedTypeOnlyImport(stmt)) continue;

      // Import-like nodes whose specifier the parse could not shape into a
      // string literal — the jsdoc `/** @import x = require(...) */`
      // materialization and `import defer type * as ns` both arrive here
      // with no specifier text. Neither is a runtime module edge (both are
      // type-only forms), and where the form is malformed TS the SC0001
      // passthrough above already names it — never a crash here.
      const specNode: ts.Expression | undefined = stmt.moduleSpecifier;
      if (specNode === undefined || !ts.isStringLiteral(specNode)) continue;
      const spec = specNode.text;
      const isRelative = isRelativeSpecifier(spec);
      const isBare = !isRelative && !ambientModules.has(spec);
      // --npm-static: an opted-in package importing node:module admits
      // for PROGRAM code (per-member fences, divergence 370) but marks
      // the PACKAGE an offender — createRequire's static story covers
      // only literal-specifier requires, and bundler banners (esbuild's
      // __createRequire(import.meta.url) prologue) feed the returned
      // require COMPUTED specifiers at module INIT, so a static compile
      // would fence at load where the island runs the package as shipped.
      if (canonicalBuiltinModule(spec) === "module") {
        const pkg = npmStaticPackageOfPath(sf.fileName);
        if (pkg !== null) {
          reportNpmStaticOffender(pkg, "it imports node:module (bundler banners drive createRequire's require with computed specifiers; the island serves the package)");
        }
      }
      // An import edge Node's own resolution refuses BEFORE any module
      // evaluates: recorded as a startup-crash candidate (the Node-order
      // walk below picks the first one Node would report; the program
      // compiles to exactly that crash — buildMain) with a compile-fence
      // fallback for candidates the entry never reaches. The bindings of a
      // refused edge never link, so every clause fence below is skipped —
      // their uses meet the lowering's own fences if the code demands
      // values from them.
      const refuse = (
        message: string,
        className: StartupCrash["className"],
        fallbackFeature: string,
      ): void => {
        refusals.get(sf)!.push({
          crash: { message, className, loc: locOf7(stmt) },
          fallback: unsupportedDiag("SC1010", locOf7(stmt), fallbackFeature),
          pos: stmt.getStart(sf),
        });
      };
      // "#" specifiers can never name an npm package — they are the
      // imports-field family, resolved below.
      const npm = isBare && !spec.startsWith("#") ? resolveNpmImport7(sf.fileName, spec) : null;
      if (npm && isNodeTypesPath(npm.typesFile)) {
        diags.push(unsupportedDiag("SC1010", locOf7(stmt), unsupportedModuleFeatureOf(spec)));
        continue;
      }
      // --npm-static: an opted-in package's import is a PROGRAM-MODULE
      // edge — its resolution (types stripped) answered the shipped JS,
      // which allowJs + maxNodeModuleJsDepth pulled into the program, so
      // the entry joins the module order like any user module and the
      // clause fences below apply to it as to program JS. A miss (the
      // resolution still answers declarations, or the file never joined
      // the program) marks the package an OFFENDER: the frontend's
      // fallback loop rebuilds without it and the import islands as ever.
      let npmStaticDep: ts.SourceFile | null = null;
      if (npm !== null) {
        if (isNpmStaticPackage(npm.packageName)) {
          npmStaticDep = npmStaticProgramDep(program, npm.packageName, npm.typesFile);
          if (npmStaticDep === null) continue;
        } else {
          // Types resolved, but Node's RUNTIME resolution can still refuse
          // the edge (a types-only package whose exports target ships no JS,
          // most commonly): that program is Node's startup crash, not an
          // island candidate — there is nothing to execute anywhere.
          const refusal = probeNodeImportRefusal(sf.fileName, spec);
          if (refusal !== null) {
            refuse(refusal.message, "%Error", `the '${spec}' package (its runtime resolution fails: ${refusal.message})`);
          }
          continue;
        }
      }
      // PROJECT imports: package.json-mediated specifiers that resolve to
      // the program's own sources — `#alias` (the imports field) and
      // self-name references (the nearest package.json's name through its
      // exports). A source answer is an ordinary user-module edge, exactly
      // like a relative import (the checker resolved the bindings the same
      // way); a refused resolution is Node's startup crash with Node's
      // exact message; what keeps a compile fence: the unsupported
      // builtin and the types-only resolution (Node-hostable or ambiguous
      // — scriptc's own limitations, named as such).
      let projDep: ts.SourceFile | null = null;
      if (isBare && npmStaticDep === null) {
        const resolved = resolveProjectImport(sf.fileName, spec);
        projDep = resolved !== null ? (program.getSourceFile(resolved) ?? null) : null;
        if (projDep !== null && projDep.isDeclarationFile) {
          diags.push(
            unsupportedDiag(
              "SC1010",
              locOf7(stmt),
              `the '${spec}' import (it resolves only to type declarations — there is no runtime implementation to compile)`,
            ),
          );
          continue;
        }
        if (projDep === null) {
          const nodeBuiltin = spec.startsWith("node:") || nodeBuiltinNames.has(spec);
          if (nodeBuiltin) {
            diags.push(unsupportedDiag("SC1010", locOf7(stmt), unsupportedModuleFeatureOf(spec)));
            continue;
          }
          if (spec === "#") {
            refuse(
              `Invalid module "#" is not a valid internal imports specifier name imported from ${sf.fileName}`,
              "%TypeError",
              `the '#' import (Node rejects the bare '#' specifier as invalid)`,
            );
            continue;
          }
          if (spec.startsWith("#")) {
            const pkgJson = nearestPkgJsonPath(sf.fileName);
            refuse(
              `Package import specifier "${spec}" is not defined${pkgJson !== null ? ` in package ${pkgJson}` : ""} imported from ${sf.fileName}`,
              "%TypeError",
              `the '${spec}' import (no package.json imports-field entry maps it)`,
            );
            continue;
          }
          const refusal = probeNodeImportRefusal(sf.fileName, spec);
          if (refusal !== null) {
            const ambientNote = ambientDeclared(spec)
              ? `the '${spec}' module (it exists only as an ambient 'declare module' type surface — there is no runtime module to import)`
              : `the '${spec}' package (nothing installed resolves it)`;
            refuse(refusal.message, "%Error", ambientNote);
            continue;
          }
          // Runtime-resolvable (or a shape the probe stays conservative
          // about) with no compilable types answer: scriptc's fence.
          diags.push(
            unsupportedDiag(
              "SC1010",
              locOf7(stmt),
              ambientDeclared(spec)
                ? `the '${spec}' module (it exists only as an ambient 'declare module' type surface — there is no runtime module to import)`
                : `the '${spec}' package (nothing installed resolves it)`,
            ),
          );
          continue;
        }
      }
      const clause = stmt.importClause;
      const dep = isRelative ? resolveImport7(program, sf, spec) : (npmStaticDep ?? projDep);
      const isJson = dep !== null && dep.fileName.endsWith(".json");
      // SELF-imports: the bindings alias this module's OWN declarations,
      // so a TOP-LEVEL read lexically above the aliased declaration is
      // Node's TDZ ReferenceError at runtime (exactly what tsc's TS2448
      // refuses for the DIRECT spelling — imports are exempt from that
      // check, so the fence restores the same bar). Hoisted function
      // aliases initialize at link and read fine anywhere; reads inside
      // function bodies keep the direct spelling's existing policy.
      if (dep === sf && clause !== undefined) {
        selfImportTdzFences7(program, sf, clause, diags);
      }
      if (clause) {
        // Default imports of SUPPORTED builtins pass where the spelling is
        // legal: Node's default export of a CJS builtin IS the module
        // object, so the binding exposes exactly the namespace-import
        // surface and the lowering keys the same tables
        // (builtinNamespaceModuleOf's default-import twin). JS sources
        // always (Node never asks for interop flags); TS sources when the
        // adopted interop knobs made the checker accept the spelling
        // (the `import os from 'os'` spelling under esModuleInterop — the
        // program TYPECHECKED, so the form is the project's own legal
        // dialect). A TS project without interop flags keeps the fence:
        // the SC1012 wording beats the raw TS1259 at the same site. The
        // callable module objects (assert, events, test) stay allowed
        // everywhere.
        const opts = program.getCompilerOptions() as {
          esModuleInterop?: boolean;
          allowSyntheticDefaultImports?: boolean;
        };
        const interopOn = opts.esModuleInterop === true || opts.allowSyntheticDefaultImports === true;
        const defaultOk =
          builtinDefaultImportModule(spec) !== null ||
          ((isJsSourceFileName(sf.fileName) || interopOn) && canonicalBuiltinModule(spec) !== null);
        if (clause.name && !isJson && dep === null && !defaultOk) {
          diags.push(unsupportedDiag("SC1012", locOf7(clause.name)));
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && isJson) {
          diags.push(
            unsupportedDiag(
              "SC1012",
              locOf7(clause.namedBindings),
              "named imports from JSON modules",
            ),
          );
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          // `import * as ns from "./m"` of a RESOLVED user module lowers:
          // ns.member accesses resolve statically through the checker to
          // the exporter's own registrations (lower-namespaces.ts's
          // module-namespace paths); the ns OBJECT as a first-class value
          // fences per site. What keeps a fence here: JSON modules (their
          // namespace object has no static story — default imports bake
          // the data), CommonJS JS modules (Node builds their namespace
          // from its lexer's static analysis, a different surface),
          // and unresolved specifiers. Supported builtins pass through as
          // before (their namespace members are the declared surface).
          if (isJson) {
            diags.push(unsupportedDiag("SC1013", locOf7(clause.namedBindings), "namespace imports of JSON modules"));
          } else if (dep !== null && isCjsJsFile7(dep)) {
            // A CJS namespace binding whose every use is a bare expression
            // statement (`cjs;` — the corpus's "the import linked"
            // assertion) carries no surface question: the statement lowers
            // to Node's no-op, the module still evaluates through its
            // ordinary init edge, and no member is ever read through the
            // lexer facade (self-imports of a CJS module included — the
            // partially-built exports are never observed). Any OTHER use
            // keeps the fence.
            if (!nsBindingUsesAreBareStatements7(program, sf, clause.namedBindings.name)) {
              diags.push(unsupportedDiag("SC1013", locOf7(clause.namedBindings), "namespace imports of CommonJS modules"));
            }
          } else if (dep === null && !(!isRelative && ambientModules.has(spec))) {
            diags.push(unsupportedDiag("SC1013", locOf7(clause.namedBindings)));
          }
        }
      }
      if (dep && !isJson) {
        deps.push({ dep, stmt });
        depPositions.get(sf)!.push({ dep, pos: stmt.getStart(sf) });
      }
    }
    if (isJsSourceFileName(sf.fileName)) {
      const stmts = sf.statements;
      let firstRunnable = -1;
      stmts.forEach((s, i) => {
        if (firstRunnable < 0 && !purePrefixStmt7(s)) firstRunnable = i;
      });
      for (let k = 0; k < stmts.length; k++) {
        const stmt = stmts[k]!;
        for (const req of requiresOf7(stmt)) {
          const loc = { file: sf.fileName, start: req.node.getStart(sf), end: req.node.getEnd() };
          if (isNodeEsmFile7(sf)) {
            diags.push(
              unsupportedDiag("SC1013", loc, "require() in an ES module (Node throws ReferenceError — use import)"),
            );
            continue;
          }
          if (req.decl && ts.isArrayBindingPattern(req.decl.name)) {
            diags.push(unsupportedDiag("SC1012", loc, "array-destructuring require() bindings"));
            continue;
          }
          if (req.decl && ts.isObjectBindingPattern(req.decl.name)) {
            const bad = req.decl.name.elements.find(
              (e) => e.name === undefined || !ts.isIdentifier(e.name) || e.initializer !== undefined || e.dotDotDotToken !== undefined,
            );
            if (bad) {
              diags.push(
                unsupportedDiag("SC1012", loc, "require() destructuring with defaults, rest, or nested patterns"),
              );
              continue;
            }
          }
          const isRelative = isRelativeSpecifier(req.spec);
          let dep: ts.SourceFile | null = null;
          if (!isRelative) {
            // --npm-static: a require() of an OPTED-IN package is a
            // program-module edge exactly like the import-declaration
            // form above (bundle dists require their workspace siblings —
            // the same resolution, the same offender discipline on a
            // miss).
            const npmReq = !req.spec.startsWith("#") ? resolveNpmImport7(sf.fileName, req.spec) : null;
            if (npmReq !== null && isNpmStaticPackage(npmReq.packageName)) {
              dep = npmStaticProgramDep(program, npmReq.packageName, npmReq.typesFile);
              if (dep === null) continue; // offender recorded — the fallback loop reloads
            } else {
              if (
                canonicalBuiltinModule(req.spec) === null &&
                !processModuleAliasRequire7(req.spec, req.decl)
              ) {
                // A binding-less require of a package NOTHING resolves:
                // Node throws MODULE_NOT_FOUND at the require site — the
                // lowering compiles exactly that catchable throw (the
                // optional-dependency try/require pattern), so no fence.
                // Binding forms keep the fence: their downstream reads
                // would need the module that never loads.
                if (req.decl !== null || probeNodeRequireRefusal(sf.fileName, req.spec) === null) {
                  diags.push(unsupportedDiag("SC1010", loc, unsupportedModuleFeatureOf(req.spec)));
                }
              }
              continue;
            }
          } else {
            dep = resolveImport7(program, sf, req.spec);
          }
          if (dep && dep.fileName.endsWith(".json")) {
            diags.push(unsupportedDiag("SC1012", loc, "require() of JSON modules"));
            continue;
          }
          const tdzName =
            firstRunnable >= 0 && firstRunnable < k && req.decl
              ? requireTdzRisk7(program, sf, k, req.decl)
              : null;
          if (tdzName !== null) {
            diags.push(
              unsupportedDiag(
                "SC1013",
                loc,
                `require() below code that can reach its binding '${tdzName}' (Node initializes the binding AT the require and throws ReferenceError on any earlier access, which is not modeled — move the require above the code that can run first)`,
              ),
            );
            continue;
          }
          if (dep) deps.push({ dep });
        }
      }
      if (!ts.isExternalModule(sf)) {
        for (const call of nestedBareRequiresOf7(sf)) {
          const spec = requireSpecOf7(call)!;
          const loc = { file: sf.fileName, start: call.getStart(sf), end: call.getEnd() };
          if (!isRelativeSpecifier(spec)) {
            // --npm-static: opted-in packages ride the program-module edge
            // (the statement-level require branch above).
            const npmReq = !spec.startsWith("#") ? resolveNpmImport7(sf.fileName, spec) : null;
            if (npmReq !== null && isNpmStaticPackage(npmReq.packageName)) {
              const nDep = npmStaticProgramDep(program, npmReq.packageName, npmReq.typesFile);
              if (nDep !== null) deps.push({ dep: nDep });
              continue;
            }
            if (canonicalBuiltinModule(spec) === null && !processModuleAliasRequire7(spec, null)) {
              // Binding-less by construction — same require-site throw
              // channel as the statement-level form above.
              if (probeNodeRequireRefusal(sf.fileName, spec) === null) {
                diags.push(unsupportedDiag("SC1010", loc, unsupportedModuleFeatureOf(spec)));
              }
            }
            continue;
          }
          const dep = resolveImport7(program, sf, spec);
          if (dep && dep.fileName.endsWith(".json")) {
            diags.push(unsupportedDiag("SC1012", loc, "require() of JSON modules"));
            continue;
          }
          if (dep) deps.push({ dep });
        }
      }
    }
  }

  // Node's evaluation order: depth-first postorder from the entry, each
  // module once, back-edges answered from the cache (a module already
  // evaluating is skipped) — which the guarded %init calls reproduce
  // exactly. Cycles are admitted only where Node's partially-initialized
  // semantics are UNOBSERVABLE (JS's partial-initialization is otherwise a
  // silent-misbehavior trap, so SC1016 stays for the rest):
  //  - a DIRECT SELF-IMPORT (the package self-name reference resolving to
  //    the importing module itself — Node's self-reference rule): the
  //    imported bindings alias the module's OWN top-level bindings with
  //    identical timing, evaluation happens once — always benign;
  //  - a back edge the shared admission engine (makeCycleAdmission)
  //    clears: the cheap per-edge rule (nothing binds, or only namespace
  //    objects bound to bare-statement uses — no read can hit TDZ or a
  //    stale slot) or the DECLARATION-ONLY INIT WINDOW analysis (the
  //    benign-cycle admission block: every module of the cycle's
  //    strongly-connected component has an inert top level and the
  //    closing edge's bindings are used only in deferred positions, so no
  //    read can execute before every member initialized).
  const cycleAdmissionReason = makeCycleAdmission(program, (sf) => edges.get(sf) ?? []);
  const order: ts.SourceFile[] = [];
  const state = new Map<ts.SourceFile, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (sf: ts.SourceFile): void => {
    state.set(sf, "visiting");
    stack.push(sf.fileName);
    for (const e of edges.get(sf) ?? []) {
      if (e.dep === sf) continue; // self-import: a Node cache hit, not a cycle
      const s = state.get(e.dep);
      if (s === "done") continue;
      if (s === "visiting") {
        // A back-edge: Node answers it from the cache (the module is
        // already evaluating) — benign exactly when nothing can observe
        // the partial initialization through this edge's bindings, by the
        // cheap per-edge rule or the declaration-only init window rule.
        const reason = cycleAdmissionReason(sf, e);
        if (reason !== null) {
          const cycleStart = stack.indexOf(e.dep.fileName);
          const cycle = [...stack.slice(cycleStart), e.dep.fileName].join(" → ");
          diags.push(
            unsupportedDiag(
              "SC1016",
              { file: e.dep.fileName, start: 0, end: 0 },
              `circular imports (${cycle}; ${reason})`,
            ),
          );
        }
        continue;
      }
      visit(e.dep);
    }
    stack.pop();
    state.set(sf, "done");
    order.push(sf);
  };
  visit(entry);

  // The startup crash Node's RESOLUTION phase reports: modules resolve
  // their request specifiers in source order, children linking depth-first
  // as each resolves (ModuleJob.syncLink) — a preorder walk over the
  // resolved edges, statement-interleaved, so the first refusal found here
  // is the one Node reports. Refusal candidates in modules the entry never
  // reaches keep their compile-fence fallback instead (Node never resolves
  // them). A found resolution crash wins over the CJS link check below:
  // Node's fetch/resolve phase runs before instantiate.
  let resolveCrash: StartupCrash | null = null;
  {
    const seen = new Set<ts.SourceFile>();
    const walk = (sf: ts.SourceFile): StartupCrash | null => {
      if (seen.has(sf)) return null;
      seen.add(sf);
      const steps: { pos: number; dep?: ts.SourceFile; crash?: StartupCrash }[] = [
        ...(depPositions.get(sf) ?? []),
        ...(refusals.get(sf) ?? []).map((r) => ({ pos: r.pos, crash: r.crash })),
      ].sort((a, b) => a.pos - b.pos);
      for (const step of steps) {
        if (step.crash !== undefined) return step.crash;
        if (step.dep !== undefined && step.dep !== sf) {
          const hit = walk(step.dep);
          if (hit !== null) return hit;
        }
      }
      return null;
    };
    resolveCrash = walk(entry);
    // The crash channel engages only for programs that OTHERWISE pass
    // preflight: when any other diagnostic already fails the build, every
    // refusal keeps its compile-fence fallback instead — the report names
    // each import's story rather than silently dropping edges whose crash
    // will never compile. (No reachable refusal → same: fallbacks only.)
    if (resolveCrash === null || diags.length > 0) {
      resolveCrash = null;
      for (const cands of refusals.values()) {
        for (const c of cands) diags.push(c.fallback);
      }
    }
  }

  const linkCrash = resolveCrash !== null ? null : cjsNamedImportLinkCheck(program, entry, order, diags);

  return { diags, moduleOrder: order, startupCrash: resolveCrash ?? linkCrash };
}

/* ── the CJS named-import link check ─────────────────────────────────────
 * Node builds a CommonJS module's ESM facade from its LEXER (cjs-lexer.ts
 * mirrors it), never from execution — so a named import the checker binds
 * happily can still fail Node's instantiate phase with a SyntaxError,
 * thrown before ANY module in the graph evaluates. The checker's word is
 * NOT Node's word exactly here, and shipping the checker's answer is the
 * silent-divergence trap (`module.exports = { a: 7 }` served `a` where
 * Node refuses the program). This walk asks Node's question at compile
 * time, in Node's exact ORDER, and answers with Node's exact message. */

interface BadCjsImport {
  /** The export name requested from the CJS module. */
  exportName: string;
  /** The import specifier as written. */
  spec: string;
  /** The failing name token (`a` in `import { a }` / `export { a } from`,
   * the PROPERTY name in the aliased forms). */
  nameNode: ts.Node;
  sf: ts.SourceFile;
}

/** Walks the entry's ESM instantiate graph exactly as V8 does — children
 * in request order, each module's own imports checked AFTER its children
 * (postorder), regular imports sorted by LOCAL name (code units), then
 * `export ... from` re-exports in source order — and answers the first
 * named import of a lexer-INVISIBLE CommonJS export as Node's link-time
 * SyntaxError (the caller compiles the program to that startup crash).
 * ESM modules OUTSIDE the instantiate graph (reached only through
 * require() of an ES module from CommonJS) instantiate mid-evaluation in
 * Node, where the SyntaxError interleaves with output already produced —
 * not modeled: those get a pointed fence instead. */
function cjsNamedImportLinkCheck(
  program: ts.Program,
  entry: ts.SourceFile,
  moduleOrder: ts.SourceFile[],
  diags: ScrDiagnostic[],
): StartupCrash | null {
  const lexMemo = new Map<ts.SourceFile, Set<string>>();
  const isRelative = isRelativeSpecifier;
  // Relative specifiers resolve as ever; PROJECT imports (#alias/self-name
  // — the same package.json-mediated edges preflight admits) join them so
  // a named import THROUGH one of a CommonJS module keeps Node's lexer
  // check. Builtin/npm targets contribute nothing here — except opted-in
  // --npm-static packages, whose CJS entries face Node's lexer exactly
  // like program CJS files (their JS IS the program now).
  const resolveEdge = (from: ts.SourceFile, spec: string): ts.SourceFile | null => {
    const pathsResolved = resolvePathsAlias(from.fileName, spec);
    if (pathsResolved !== null) return program.getSourceFile(pathsResolved) ?? null;
    if (isRelative(spec)) return resolveImport7(program, from, spec);
    const npmStatic = npmStaticDepSf7(program, from, spec);
    if (npmStatic !== null) return npmStatic;
    const p = resolveProjectImport(from.fileName, spec);
    return p !== null ? (program.getSourceFile(p) ?? null) : null;
  };
  // Reexport targets union in only when they resolve to CommonJS program
  // files (Node's cjsPreparseModuleExports rule).
  const resolveCjsDep = (from: ts.SourceFile, spec: string): ts.SourceFile | null => {
    const dep = resolveEdge(from, spec);
    return dep !== null && isCjsJsFile7(dep) ? dep : null;
  };
  const visible = (dep: ts.SourceFile, name: string): boolean =>
    // `default` is the module.exports binding itself — always provided.
    // (cjs-lexer.ts lexes SOURCE TEXT — only strings cross into the
    // typescript5 island; the SourceFile is just the memo/resolve handle.)
    name === "default" || cjsLexerVisibleNames(dep, (d) => d.text, resolveCjsDep, lexMemo).has(name);

  /** The statement's resolved LOCAL CommonJS dependency, when it is an
   * import/re-export from one. */
  const cjsDepOf = (sf: ts.SourceFile, spec: string): ts.SourceFile | null => {
    const dep = resolveEdge(sf, spec);
    return dep !== null && isCjsJsFile7(dep) ? dep : null;
  };

  /** The first lexer-invisible CJS name request of ONE module, in V8's
   * check order: all regular named imports sorted by local binding name,
   * then `export { x } from` elements in source order. */
  const firstInvisibleOf = (sf: ts.SourceFile): BadCjsImport | null => {
    const entries: { local: string; exportName: string; nameNode: ts.Node; spec: string; dep: ts.SourceFile }[] = [];
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || stmt.moduleSpecifier === undefined || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const clause = stmt.importClause;
      if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      const spec = stmt.moduleSpecifier.text;
      const dep = cjsDepOf(sf, spec);
      if (dep === null) continue;
      for (const e of clause.namedBindings.elements) {
        if (e.isTypeOnly) continue;
        const nameNode = e.propertyName ?? e.name;
        entries.push({ local: e.name.text, exportName: nameNode.text, nameNode, spec, dep });
      }
    }
    entries.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
    for (const e of entries) {
      if (!visible(e.dep, e.exportName)) return { exportName: e.exportName, spec: e.spec, nameNode: e.nameNode, sf };
    }
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
      if (stmt.moduleSpecifier === undefined || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      const spec = stmt.moduleSpecifier.text;
      const dep = cjsDepOf(sf, spec);
      if (dep === null) continue;
      for (const e of stmt.exportClause.elements) {
        if (e.isTypeOnly) continue;
        const nameNode = e.propertyName ?? e.name;
        if (!visible(dep, nameNode.text)) return { exportName: nameNode.text, spec, nameNode, sf };
      }
    }
    return null;
  };

  // The instantiate graph: from an ESM entry, every import/re-export
  // request in source order, recursing into ESM dependencies only (CJS
  // and JSON modules are leaves — their own requires never join V8's
  // linking). A CommonJS ENTRY has no instantiate phase at all.
  const visited = new Set<ts.SourceFile>();
  const dfs = (sf: ts.SourceFile): BadCjsImport | null => {
    if (visited.has(sf)) return null;
    visited.add(sf);
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) && !(ts.isExportDeclaration(stmt) && !stmt.isTypeOnly)) continue;
      if (ts.isImportDeclaration(stmt) && stmt.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      const specNode = stmt.moduleSpecifier;
      if (specNode === undefined || !ts.isStringLiteral(specNode)) continue;
      const spec = specNode.text;
      const dep = resolveEdge(sf, spec);
      if (dep === null || dep.fileName.endsWith(".json") || !isNodeEsmFile7(dep)) continue;
      const bad = dfs(dep);
      if (bad !== null) return bad;
    }
    return firstInvisibleOf(sf);
  };
  const bad = isNodeEsmFile7(entry) ? dfs(entry) : null;

  // ESM modules only require() reaches: same invisibility, but Node's
  // SyntaxError fires mid-evaluation at the require — a pointed fence
  // instead of a mismodeled crash position.
  for (const sf of moduleOrder) {
    if (!isNodeEsmFile7(sf) || visited.has(sf)) continue;
    const b = firstInvisibleOf(sf);
    if (b !== null) {
      diags.push(
        unsupportedDiag(
          "SC1013",
          locOf7(b.nameNode),
          `a named import of a CommonJS export Node's lexer cannot detect, reached through require() of an ES module (Node throws its SyntaxError mid-evaluation at that require; import the CommonJS module's default and read members off it instead)`,
        ),
      );
    }
  }
  if (bad === null) return null;

  // Node's message: V8's generic missing-export SyntaxError, rewritten to
  // the CommonJS hint form only when the failing SPECIFIER STRING is also
  // one of the ENTRY module's own requests and the entry's resolution of
  // it is CommonJS (module_job.js consults the ROOT job's moduleRequests/
  // commonJsDeps — a deep module's failure keeps the generic wording).
  let flavored = false;
  for (const stmt of entry.statements) {
    if (!ts.isImportDeclaration(stmt) && !(ts.isExportDeclaration(stmt) && !stmt.isTypeOnly)) continue;
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    const specNode = stmt.moduleSpecifier;
    if (specNode === undefined || !ts.isStringLiteral(specNode) || specNode.text !== bad.spec) continue;
    if (cjsDepOf(entry, bad.spec) !== null) {
      flavored = true;
      break;
    }
  }
  const loc = locOf7(bad.nameNode);
  if (!flavored) {
    return { message: `The requested module '${bad.spec}' does not provide an export named '${bad.exportName}'`, className: "%SyntaxError", loc };
  }
  // The destructuring hint: Node regexes the failing name's SOURCE LINE
  // for its brace group (greedy, first `{` to last `}` on the line) and
  // swaps ` as ` for `: ` — reproduced byte for byte, quirks included
  // (multi-line import statements simply lose the hint).
  const text = bad.sf.text;
  const pos = bad.nameNode.getStart(bad.sf);
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = text.indexOf("\n", pos);
  let line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  const braces = /{.*}/.exec(line);
  const destructuring = braces === null ? null : braces[0].replace(/\s+as\s+/g, ": ");
  return {
    message:
      `Named export '${bad.exportName}' not found. The requested module '${bad.spec}' is a CommonJS module, which may not support all module.exports as named exports.\n` +
      "CommonJS modules can always be imported via the default export, for example using:\n\n" +
      `import pkg from '${bad.spec}';\n` +
      (destructuring !== null ? `const ${destructuring} = pkg;\n` : ""),
    className: "%SyntaxError",
    loc,
  };
}

/* node's builtin-module name list, for the SC1010 wording decision ("the
 * 'fs' module" vs the generic package message) — shared verbatim with the
 * retired 5.9.3 lane's builtinModules use. */
const nodeBuiltinNames: ReadonlySet<string> = new Set(builtinModules);

/* ── the lowering-facing surface ─────────────────────────────────────────
 * A family of world-typed helpers the LOWERING imports (require
 * recognizers, the CJS export-identity analysis, ordered imports,
 * resolution, locations), exported under the names the 5.9.3 program.ts
 * established (the phase-2 port kept every spelling); the world-neutral
 * helpers re-export from shared.ts. */

export {
  ambientDtsPath,
  builtinDefaultImportModule,
  canonicalBuiltinModule,
  fallbackDtsPath,
  isNodeTypesPath,
  npmPackageNameOf,
  overridesDtsPath,
  SUPPORTED_BUILTIN_MODULES,
  workspacePackageOfPath,
} from "./shared.js";

export {
  requireSpecOf7 as requireSpecOf,
  isRequireStatement7 as isRequireStatement,
  requiresOf7 as requiresOf,
  isNodeEsmFile7 as isNodeEsmFile,
  resolveImport7 as resolveImport,
  resolveNpmImport7 as resolveNpmImport,
  locOf7 as locOf,
};

/** True for JavaScript source files (.js/.mjs/.cjs) — the files whose
 * types come entirely from inference (checkJs + JSDoc) and whose classes
 * declare fields by constructor assignment. */
export function isJsSourceFile(sf: ts.SourceFile): boolean {
  return isJsSourceFileName(sf.fileName);
}

/** `import type …` declarations and named clauses whose every element is
 * `type`-qualified are ERASED by tsc at emit — Node's module graph has no
 * edge there, so module order, cycle detection, init calls, and the
 * startup-refusal probe must not count them either (zod v4's core modules
 * are "cyclic" only through `import type * as ns` namespaces — 27 phantom
 * SC1016 sites against 1 real value-level cycle; and a type-only import
 * of a module Node cannot resolve is NOT a startup crash — Node never
 * resolves it). Originated as the provenance-sources pilot's flag-gated
 * prototype (SCRIPTC_TYPE_ONLY_EDGES), promoted to always-on with the
 * full-suite differential green. Side-effect imports (no clause) stay
 * real edges. */
function erasedTypeOnlyImport(stmt: ts.ImportDeclaration): boolean {
  const clause = stmt.importClause;
  if (clause === undefined) return false; // side-effect import: a real edge
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  return (
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((e) => e.isTypeOnly)
  );
}

/** The re-export twin: `export { type X } from "./m"` with every element
 * `type`-qualified erases at emit exactly like `export type { X } from`
 * (which stmt.isTypeOnly already covers) — no module edge. */
function erasedTypeOnlyReexport(stmt: ts.ExportDeclaration): boolean {
  return (
    stmt.exportClause !== undefined &&
    ts.isNamedExports(stmt.exportClause) &&
    stmt.exportClause.elements.length > 0 &&
    stmt.exportClause.elements.every((e) => e.isTypeOnly)
  );
}

/** A file's import declarations — and value re-exports with a specifier
 * (`export { x } from "./y.js"`, `export * from "./y.js"`), which Node
 * evaluates exactly like imports — in SOURCE ORDER, each with its resolved
 * user-module dependency (null for npm/builtin/JSON specifiers — those are
 * not module-order edges). The per-file %init header (lowerFileInit) uses
 * this to interleave island imports with user-module init calls exactly
 * where Node would evaluate them. CommonJS require statements are
 * deliberately NOT here: Node evaluates a require AT ITS STATEMENT, inline
 * in the module body, so the statement lowering emits their guarded %init
 * calls in place instead of hoisting them. */
export function orderedImportsOf(
  program: ts.Program,
  sf: ts.SourceFile,
): { stmt: ts.Statement; dep: ts.SourceFile | null }[] {
  const out: { stmt: ts.Statement; dep: ts.SourceFile | null }[] = [];
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && (stmt.isTypeOnly || erasedTypeOnlyReexport(stmt) || !stmt.moduleSpecifier)) continue;
    if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) continue;
    if (ts.isImportDeclaration(stmt) && erasedTypeOnlyImport(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    // tsconfig "paths" aliases take precedence over all resolution strategies.
    const pathsAlias = resolvePathsAlias(sf.fileName, spec);
    if (pathsAlias !== null) {
      const dep = program.getSourceFile(pathsAlias) ?? null;
      out.push({ stmt, dep });
      continue;
    }
    const isRelative = isRelativeSpecifier(spec);
    // Relative edges as ever; PROJECT imports (#alias/self-name — the
    // package.json-mediated specifiers preflight admits as user-module
    // edges) resolve to the same dep so the importer's %init header calls
    // theirs. Builtin and npm bare specifiers stay null (resolveProjectImport
    // answers only inside the project) — EXCEPT opted-in --npm-static
    // packages, whose entries are program modules the header must init.
    const dep = isRelative
      ? resolveImport7(program, sf, spec)
      : (npmStaticDepSf7(program, sf, spec) ?? resolveProjectImportSf7(program, sf, spec));
    const isJson = dep !== null && dep.fileName.endsWith(".json");
    out.push({ stmt, dep: isJson ? null : dep });
  }
  return out;
}

/** The program source file a bare specifier reaches when it names an
 * opted-in --npm-static package (the shipped-JS entry preflight admitted
 * as a module edge), else null. No offender reporting here — preflight
 * already classified the import; this is the lookup the module-order and
 * lowering paths share. */
export function npmStaticDepSf7(program: ts.Program, sf: ts.SourceFile, spec: string): ts.SourceFile | null {
  if (!npmStaticActive() || isRelativeSpecifier(spec)) return null;
  if (spec.startsWith("node:") || spec.startsWith("#")) return null;
  const npm = resolveNpmImport7(sf.fileName, spec);
  if (npm === null || !isNpmStaticPackage(npm.packageName)) return null;
  if (!isJsSourceFileName(npm.typesFile)) return null;
  return program.getSourceFile(npm.typesFile) ?? null;
}

/** resolveProjectImport lifted to SourceFile answers: the program's file
 * for a `#alias`/self-name resolution, or null (unresolved, or resolved
 * outside the program — declaration files included; callers that admit
 * d.ts answers probe resolveProjectImport directly). */
function resolveProjectImportSf7(
  program: ts.Program,
  sf: ts.SourceFile,
  spec: string,
): ts.SourceFile | null {
  if (spec.startsWith("node:")) return null;
  const p = resolveProjectImport(sf.fileName, spec);
  if (p === null) return null;
  const dep = program.getSourceFile(p) ?? null;
  return dep !== null && !dep.isDeclarationFile ? dep : null;
}

/** True when `expr` is the `module.exports` property access. */
export function isModuleExportsAccess(expr: ts.Expression): expr is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(expr) &&
    !expr.questionDotToken &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "module" &&
    expr.name.text === "exports"
  );
}

/** Classifies a statement as a CommonJS EXPORT assignment:
 *   - table:  `module.exports = { ... }` — the whole export table at once
 *             (obj is null when the RHS is not an object literal — the
 *             recognized-but-unsupported form, fenced by the caller);
 *   - member: `exports.f = <expr>` / `module.exports.f = <expr>`.
 * Null for everything else. Callers gate on top-level position in a JS
 * module file — these forms anywhere else keep their generic fences. */
export function cjsExportAssignmentOf(stmt: ts.Statement):
  | { kind: "table"; obj: ts.ObjectLiteralExpression | null; expr: ts.BinaryExpression }
  | { kind: "member"; name: ts.MemberName; value: ts.Expression; expr: ts.BinaryExpression }
  | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  const e = stmt.expression;
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  if (isModuleExportsAccess(e.left)) {
    return { kind: "table", obj: ts.isObjectLiteralExpression(e.right) ? e.right : null, expr: e };
  }
  if (ts.isPropertyAccessExpression(e.left) && !e.left.questionDotToken) {
    const recv = e.left.expression;
    const isExports = ts.isIdentifier(recv) && recv.text === "exports";
    if (isExports || isModuleExportsAccess(recv)) {
      return { kind: "member", name: e.left.name, value: e.right, expr: e };
    }
  }
  return null;
}

/** Why Node would DISCARD this CommonJS export statement, or null when it
 * survives (Node's export-object identity rules — checker-free, pure
 * AST): `module.exports = {...}` REPLACES the export object, so members
 * attached before it (either spelling), any earlier table, and
 * `exports.f =` after it (exports still references the replaced object)
 * are never seen by importers. Lowering fences these instead of shipping
 * the checker's everything-is-live answer — the checker/runtime split is
 * exactly the silent-divergence trap. */
export function cjsExportDiscardReason(stmt: ts.Statement): string | null {
  const sf = stmt.parent;
  if (!ts.isSourceFile(sf)) return null;
  const mine = cjsExportAssignmentOf(stmt);
  if (!mine) return null;
  const stmts = sf.statements;
  let lastTable = -1;
  for (let i = 0; i < stmts.length; i++) {
    if (cjsExportAssignmentOf(stmts[i]!)?.kind === "table") lastTable = i;
  }
  if (lastTable < 0) return null;
  const myIdx = stmts.indexOf(stmt as never);
  if (mine.kind === "table") {
    return myIdx < lastTable
      ? "multiple 'module.exports =' assignments (Node keeps only the last one — this table is discarded)"
      : null;
  }
  if (myIdx < lastTable) {
    return "export members attached before a 'module.exports =' assignment (Node replaces the export object — importers never see this member; attach it to module.exports AFTER the table)";
  }
  const left = mine.expr.left as ts.PropertyAccessExpression;
  return ts.isIdentifier(left.expression) && left.expression.text === "exports"
    ? "'exports.f =' after a 'module.exports =' assignment ('exports' still references the replaced object — Node discards this member; write module.exports.f instead)"
    : null;
}

/** The object literal a `module.exports = <expr>` statement's RHS
 * RESOLVES to (syntactically): the literal itself; `new Proxy(target,
 * handler)` — Node programs export identity-forwarding proxies over a
 * table, and the TARGET is the table (traps cannot run in a compiled
 * program: every member access is statically resolved against the
 * target's own type); or an identifier naming a top-level const whose
 * initializer is the literal. Null for everything else. */
export function cjsExportTargetLiteral(e: ts.Expression, sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isObjectLiteralExpression(e)) return e;
  if (
    ts.isNewExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "Proxy" &&
    (e.arguments?.length ?? 0) >= 1
  ) {
    return cjsExportTargetLiteral(e.arguments![0]!, sf);
  }
  if (ts.isIdentifier(e)) {
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const d of stmt.declarationList.declarations) {
        if (d.name !== undefined && ts.isIdentifier(d.name) && d.name.text === e.text && d.initializer) {
          let init: ts.Expression = d.initializer;
          while (ts.isParenthesizedExpression(init)) init = init.expression;
          return ts.isObjectLiteralExpression(init) ? init : null;
        }
      }
    }
  }
  return null;
}

/** The class expression a JS module's WHOLE export is (`module.exports =
 * class …{}`): the kept (last) top-level `module.exports =` statement's
 * paren-unwrapped RHS when it is a class expression, together with the
 * statement it sits in (in-file `module.exports` reads gate on source
 * order against it). Null when the kept export is anything else. */
export function cjsClassExprWholeExportOf(
  sf: ts.SourceFile,
): { classExpr: ts.ClassExpression; stmt: ts.Statement } | null {
  let last: { classExpr: ts.ClassExpression; stmt: ts.Statement } | null = null;
  for (const stmt of sf.statements) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (!cjs || cjs.kind !== "table") continue;
    let rhs: ts.Expression = cjs.expr.right;
    while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
    // Any LATER table replaces the export object — a non-class one takes
    // the class answer back off the table.
    last = ts.isClassExpression(rhs) ? { classExpr: rhs, stmt } : null;
  }
  return last;
}

/** True when `obj` is the effective export-table literal of a JS module:
 * the object literal of a top-level `module.exports = { ... }` statement
 * directly, OR the RESOLVED TARGET of the module's kept `module.exports =`
 * statement (the identifier/Proxy forms — see cjsExportTargetLiteral).
 * The gate for the CJS export-property alias re-resolution
 * (resolveValueSymbol) and the accessor-read lift. */
export function isCjsExportTableLiteral(obj: ts.ObjectLiteralExpression): boolean {
  const assign = obj.parent;
  if (
    ts.isBinaryExpression(assign) &&
    assign.right === obj &&
    isModuleExportsAccess(assign.left) &&
    ts.isExpressionStatement(assign.parent) &&
    ts.isSourceFile(assign.parent.parent)
  ) {
    return isJsSourceFile(assign.parent.parent);
  }
  const decl = obj.parent;
  if (!ts.isVariableDeclaration(decl) || decl.initializer !== obj) return false;
  const sf = obj.getSourceFile();
  if (!isJsSourceFile(sf)) return false;
  for (const stmt of sf.statements) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind === "table" && cjsExportDiscardReason(stmt) === null) {
      return cjsExportTargetLiteral(cjs.expr.right, sf) === obj;
    }
  }
  return false;
}
