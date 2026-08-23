/* The npm RUNTIME graph: what --dynamic builds embed.
 *
 * Types come from the package's shipped .d.ts (program.ts resolves those
 * through TypeScript itself); the CODE that runs is the package's shipped
 * JS, resolved HERE at build time with Node's own resolution algorithm —
 * for every (importer, specifier) pair, node_modules directories are
 * probed from the importing FILE upward to the filesystem root, symlinks
 * are resolved with realpath (pnpm/bun virtual stores are symlink farms —
 * a package's dependencies live next to its REAL location, not its link),
 * package.json "exports" maps are honored (import/require conditions,
 * subpath patterns with '*'), with main/module fallbacks and extension/
 * directory-index resolution for the rest. The internal module graph
 * (the package's own relative imports/requires plus its dependencies')
 * is scanned with a real TypeScript parse collecting every module edge —
 * import/export declarations (including `export * as ns from`, which
 * ts.preProcessFile silently drops), dynamic import() of string literals,
 * and CommonJS require() calls — never a regex.
 *
 * Every reached module's SOURCE is embedded into the emitted C as a static
 * string keyed by its REALPATH — one physical module embeds once, however
 * many symlink aliases reach it; scr_island.c serves the engine's module
 * loader (and a CommonJS require shim) from that map, so binaries never
 * read node_modules at runtime. Each CommonJS module additionally embeds a
 * synthesized ESM FACADE — default plus the named exports lexed from its
 * source with the compiler's quirk-faithful port of Node's vendored CJS
 * lexer (cjs-lexer.ts, the merve port program.ts also answers with) — so
 * ES modules inside the graph named-import CJS files exactly like under
 * Node, including the failures: a name Node's lexer cannot see is absent
 * from the facade and the embedded import fails at engine link time just
 * as Node's instantiate would.
 * Node builtins are NOT embedded: the island
 * ships shims for the set CLIs actually drive — the pure-JS tier (util,
 * assert, buffer, string_decoder, querystring, punycode, console, timers,
 * readline, async_hooks' two classes, events, module, tty) and the host
 * bridges riding the same C implementations the static lowerings use
 * (fs + fs/promises, path both families, url's WHATWG parser and file
 * converters, crypto's hashing/random slice, zlib, process, os) — the
 * worker_threads tier stays unshimmed (SHIMMED_BUILTINS is
 * the source of truth).
 *
 * EDGE-KIND SEMANTICS match Node's per kind, TRANSITIVELY. A STATIC
 * import/export edge in an eagerly-reached module is EAGER — Node links the
 * whole static graph before anything evaluates — so a static edge that
 * reaches an unshimmed builtin or does not resolve is a build-time
 * diagnostic naming the builtin/specifier, the requiring package, and the
 * dependency chain that reached it. A require() or dynamic import() edge is
 * LAZY — Node fails require at the CALL and import() at evaluation — and so
 * is EVERY edge of a module only reachable through lazy edges: Node links
 * that whole subgraph at the boundary call (a CLI's launcher shim
 * import()s its real CLI, so the CLI graph's own static imports fail at
 * that import(), never sooner). A blocked lazy edge embeds a runtime trap
 * instead of failing the build:
 * an unshimmed builtin keeps the island's own lazy throw (the edge embeds
 * pointing at the "node:x" key the shim table refuses at the call), an
 * unresolvable require() gets Node's MODULE_NOT_FOUND shape from the
 * island's require shim (message carrying the live Require stack, code,
 * requireStack — NO edge embeds; the shim owns the throw), and an
 * unresolvable import() embeds a throwing ESM stub with Node's
 * ERR_MODULE_NOT_FOUND shape (the addDynamicImport
 * ERR_UNKNOWN_FILE_EXTENSION stub's pattern). Blocked-but-lazy edges stay in
 * the build-time inventory (builtins/lazyTraps) so the coverage report says
 * exactly what the binary cannot reach. esbuild-published bundles route
 * external requires through a `__require` helper; its literal call sites
 * collect as require edges too, so esbuild dists get the same honest
 * build-time inventory. A specifier that RESOLVES to a .node native addon
 * embeds a throwing ERR_DLOPEN_FAILED stub instead of the addon's machine
 * code (the island has no process.dlopen; napi binding packages require()
 * their .node lazily next to a fallback, so the stub is the "addon
 * missing" path they already handle) — those keep an inventory row too
 * (lazyTraps, native: true).
 *
 * CONDITION SETS come from the CALL FORM, never the importer's format —
 * Node resolves import/export declarations and import() with
 * ["node","import"] and require() with ["node","require"] — so a DUAL
 * package (smol-toml's shape: "exports" whose "import" and "require"
 * conditions name different files) embeds BOTH entries, each behind its
 * own kind-tagged edge; the island's module loader looks edges up with
 * the import kind, its require shim with the require kind (the dual-
 * package hazard included: the two entries are distinct module
 * instances, exactly Node). And a require edge ATTRIBUTES to the module
 * whose scope defines the require function being called: esbuild's
 * `__require` lives in a shared chunk whose banner createRequire it
 * closed over, so a call site in ANOTHER chunk resolves — at build time
 * here and at runtime in Node — from the DEFINING chunk, and the edge
 * lives under its key (requireHelperOriginOf follows the import and
 * re-export hops).
 */
import { dirname, extname, join, resolve } from "node:path";
import ts from "typescript5";
import { cjsLexedExportsOf } from "./cjs-lexer.js";
import { trackedDirectoryExists, trackedFileExists, trackedReadFile, trackedRealpath } from "./input-tracker.js";
import { resolveExports } from "./resolve.js";

const NODE_IMPORT_CONDITIONS = new Set(["import", "node", "default"]);
const NODE_REQUIRE_CONDITIONS = new Set(["require", "node", "default"]);

function nodeExportConditions(mode: "import" | "require"): ReadonlySet<string> {
  return mode === "import" ? NODE_IMPORT_CONDITIONS : NODE_REQUIRE_CONDITIONS;
}

export type EmbeddedFormat = "esm" | "cjs" | "json";

export interface EmbeddedModule {
  /** The resolved REAL path (symlinks followed) — the loader's cache key. */
  key: string;
  source: string;
  format: EmbeddedFormat;
  /** The parsed source reaches Node's global fetch binding. This is a
   * semantic capability fact, unlike the old whole-source word scan: comments,
   * strings, property names, and locally-bound `fetch` identifiers do not set
   * it. The IR/link gates consume this bit without reparsing embedded text. */
  usesFetch?: true;
  /** CommonJS only: the synthesized ESM facade the island's module loader
   * evaluates when an ES module imports this file — default plus the LEXED
   * named exports (cjsEsmFacadeSource). ESM sources compile natively and
   * JSON keeps the loader's default-only wrapper, so both leave this
   * unset. */
  esm?: string;
}

/* Node synthesizes named exports for CommonJS modules imported from ESM by
 * LEXING the CJS source at link time: `exports.x =` / `module.exports.x =`
 * assignments, `module.exports = {…}` object literals including esbuild's
 * dead `0 && (module.exports = {…})` annotation,
 * `Object.defineProperty(exports, "x", …)`, `module.exports = require(…)`
 * re-export forwarding, and the tsc/babel star-copy patterns. scriptc
 * holds every embedded CJS source at BUILD time, so the same detection
 * runs here through cjs-lexer.ts — the compiler's probed port of merve,
 * Node v24.15.0's vendored lexer. The npm package cjs-module-lexer is NOT
 * that lexer anymore and disagrees with it (a phantom "get" export for
 * `{ get a() {…} }` tables, missed `k: require(…)` value reexports), so
 * the port is the single source of truth for program CJS files and
 * embedded npm modules alike. */

/** The ESM facade for an embedded CommonJS module, matching Node's interop
 * exactly (verified against Node 24): `default` IS module.exports;
 * "module.exports" is a named alias for it (Node ships that export name);
 * every lexed name binds the exports object's OWN property when one exists
 * at facade evaluation (getters read once — a snapshot, like Node's
 * loop over the lexed set) and stays undefined otherwise (a lexed-but-
 * never-assigned name is a live binding of undefined, not an error;
 * inherited properties do NOT leak through, hence the hasOwnProperty
 * guard). Export names that aren't identifiers ("dash-name") use string
 * ModuleExportNames — every name does, uniformly; the locals are e0, e1, …
 * temps. */
function cjsEsmFacadeSource(key: string, names: readonly string[]): string {
  const uniq = [...new Set(names)].filter((n) => n !== "default" && n !== "module.exports");
  const parts = [
    `const m=globalThis.__scr_require(${JSON.stringify(key)});`,
    `export default m;`,
  ];
  if (uniq.length > 0) parts.push(`const H=Object.prototype.hasOwnProperty;`);
  const bound = uniq.map((n, i) => {
    const name = JSON.stringify(n);
    parts.push(`let e${i};if(H.call(m,${name}))e${i}=m[${name}];`);
    return `,e${i} as ${name}`;
  });
  parts.push(`export{m as "module.exports"${bound.join("")}};`);
  return parts.join("\n");
}

export interface EmbeddedEdge {
  /** Importer's key. */
  from: string;
  /** The specifier as written in the importer's source. */
  specifier: string;
  /** Resolved target: an embedded module's key, or a "node:*" builtin. */
  to: string;
  /** Which call forms this resolution serves — Node picks the "exports"
   * condition set from the EDGE KIND, not the importer's format, so one
   * (from, specifier) can name TWO targets: a dual package's "import"
   * condition for import/import() sites and its "require" condition for
   * require() sites. "any" (relative files, builtins, edges whose kinds
   * agree) answers both lookups. */
  kind: "any" | "import" | "require";
}

/** What a dynamic import() specifier resolves to at build time. */
export type DynamicImportResolution =
  /** An embedded module's key or a shimmed builtin's "node:x" key —
   * island.importDyn loads it through the engine's module system. */
  | { kind: "module"; key: string }
  /** A Node builtin the island ships no shim for — a build diagnostic,
   * exactly like a static import of it. */
  | { kind: "unsupported-builtin"; builtin: string }
  /** The specifier resolves into the compiled program's own TypeScript —
   * fenced at the site (static imports are the way in). */
  | { kind: "program-module" }
  /** No resolution — a build diagnostic, like static imports. */
  | { kind: "unresolved"; message: string };

export interface NpmGraphError {
  /** Human-readable failure ("package 'x' requires 'node:stream', which
   * the island does not provide"). The caller attaches the import site. */
  message: string;
}

/** One Node builtin the embedded graph imports — the coverage report's
 * honesty about what the island must (or cannot) provide. */
export interface NpmBuiltinUse {
  /** Canonical "node:x" key. */
  builtin: string;
  /** Whether the island ships a shim for it. */
  shimmed: boolean;
  /** Unshimmed AND only require()/import() edges reach it: the build
   * embeds the island's lazy throw at the call instead of failing —
   * Node's laziness for those edge kinds (Node itself would LOAD the
   * builtin; the trap is the island's honest refusal at the only point
   * Node would have loaded it). Always false when shimmed or when any
   * static import reaches it (static keeps the eager build error). */
  lazy: boolean;
  /** The packages whose embedded code imports it (sorted). */
  packages: string[];
}

/** One unresolvable specifier reached ONLY by require()/dynamic import()
 * edges: the build embeds a runtime trap with Node's call-time error shape
 * (MODULE_NOT_FOUND for require, ERR_MODULE_NOT_FOUND for import()) instead
 * of failing — the coverage report lists these beside the builtins so the
 * build output stays honest about what the binary cannot reach. */
export interface NpmLazyTrap {
  /** The specifier as written at the call site. */
  specifier: string;
  /** The call forms that reach it (sorted, require first). "import" is a
   * STATIC import inside a lazily-reached module — Node links that whole
   * subgraph at the require()/import() boundary that reaches it, so the
   * failure surfaces there, at the call. */
  via: ("require" | "import()" | "import")[];
  /** The packages whose embedded code holds the call sites (sorted). */
  packages: string[];
  /** The specifier RESOLVED — to a native .node addon the island cannot
   * dlopen. The build embeds a throwing stub (Node's ERR_DLOPEN_FAILED
   * code) instead of the addon's raw bytes; the require/import() throws
   * at the call. Unset for the unresolvable rows above. */
  native?: boolean;
}

export interface NpmRuntimeGraph {
  modules: EmbeddedModule[];
  edges: EmbeddedEdge[];
  /** (importing file dir + specifier) → the package's runtime entry key. */
  entryOf: (fromFile: string, specifier: string) => string | null;
  /** Every Node builtin the embedded graph imports, shimmed or not. */
  builtins: NpmBuiltinUse[];
  /** Unresolvable lazily-reached specifiers embedded as runtime traps. */
  lazyTraps: NpmLazyTrap[];
  errors: NpmGraphError[];
}

/** Embedded modules whose executable syntax reads Node's global fetch.
 *
 * The npm graph already owns every source string, so bind them together in a
 * no-lib TypeScript program once and ask the checker whether a `fetch`
 * identifier resolves locally. With no ambient library, an unresolved read is
 * exactly the engine global; declarations/imports/parameters retain symbols.
 * `globalThis.fetch` and `global.fetch` are recognized explicitly when their
 * receiver is likewise unshadowed, including const aliases of those global
 * objects. Parsing is recovery-capable, matching the module-specifier sweep's
 * treatment of shipped JavaScript. */
export function embeddedModulesUsingGlobalFetch(
  modules: readonly EmbeddedModule[],
): ReadonlySet<string> {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const mod of modules) {
    if (mod.format === "json") continue;
    sourceFiles.set(
      mod.key,
      ts.createSourceFile(mod.key, mod.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
    );
  }
  if (sourceFiles.size === 0) return new Set();

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const canonical = (fileName: string): string => {
    const normalized = fileName.replace(/\\/g, "/");
    return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
  };
  const byCanonical = new Map(
    [...sourceFiles].map(([fileName, sourceFile]) => [canonical(fileName), sourceFile] as const),
  );
  const originalKeyByCanonical = new Map(
    [...sourceFiles.keys()].map((fileName) => [canonical(fileName), fileName] as const),
  );
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => byCanonical.get(canonical(fileName)),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (fileName) => byCanonical.has(canonical(fileName)),
    readFile: (fileName) => byCanonical.get(canonical(fileName))?.text,
    getCanonicalFileName: canonical,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    directoryExists: () => true,
    realpath: (fileName) => fileName,
  };
  const program = ts.createProgram({ rootNames: [...sourceFiles.keys()], options, host });
  const checker = program.getTypeChecker();
  const found = new Set<string>();

  const unwrapParentheses = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };

  const unboundGlobalObject = (candidate: ts.Expression): boolean => {
    const node = unwrapParentheses(candidate);
    if (
      !ts.isIdentifier(node) ||
      (node.text !== "globalThis" && node.text !== "global")
    ) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node);
    // TypeScript synthesizes a declaration-less globalThis symbol even in a
    // no-lib program. A source shadow (parameter/local/import) always carries
    // at least one declaration; the Node `global` alias remains unresolved.
    return (
      symbol === undefined ||
      symbol.declarations === undefined ||
      symbol.declarations.length === 0
    );
  };

  const globalObjectExpression = (
    candidate: ts.Expression,
    aliases: ReadonlySet<ts.Symbol>,
  ): boolean => {
    const node = unwrapParentheses(candidate);
    if (unboundGlobalObject(node)) return true;
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol === undefined) return false;
      if (aliases.has(symbol)) return true;
      return (
        (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
        aliases.has(checker.getAliasedSymbol(symbol))
      );
    }
    if (ts.isConditionalExpression(node)) {
      return (
        globalObjectExpression(node.whenTrue, aliases) ||
        globalObjectExpression(node.whenFalse, aliases)
      );
    }
    if (ts.isBinaryExpression(node)) {
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
        case ts.SyntaxKind.AmpersandAmpersandToken:
          // A platform selector can yield either operand. Treat either
          // global-object arm as capability provenance; over-linking a
          // dead arm is safer than silently omitting fetch at runtime.
          return (
            globalObjectExpression(node.left, aliases) ||
            globalObjectExpression(node.right, aliases)
          );
        case ts.SyntaxKind.CommaToken:
          return globalObjectExpression(node.right, aliases);
      }
    }
    return false;
  };

  const staticPropertyName = (name: ts.PropertyName | ts.BindingName): string | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (
      ts.isComputedPropertyName(name) &&
      ts.isStringLiteralLike(name.expression)
    ) {
      return name.expression.text;
    }
    return null;
  };

  /** `const { fetch } = globalThis` binds a local identifier, so the
   * checker quite correctly resolves every later `fetch` read to that local.
   * The capability read happens at the binding pattern itself. The same is
   * true for aliases, computed literal keys, and defaulted parameters. */
  const bindingReadsGlobalFetch = (
    node: ts.BindingElement,
    aliases: ReadonlySet<ts.Symbol>,
  ): boolean => {
    const pattern = node.parent;
    if (!ts.isObjectBindingPattern(pattern)) return false;
    const key = node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : null);
    if (key === null || staticPropertyName(key) !== "fetch") return false;

    const owner = pattern.parent;
    if (
      (ts.isVariableDeclaration(owner) || ts.isParameter(owner) || ts.isBindingElement(owner)) &&
      owner.name === pattern &&
      owner.initializer !== undefined
    ) {
      return globalObjectExpression(owner.initializer, aliases);
    }
    return false;
  };

  /** Assignment destructuring is represented as an object-literal-shaped
   * assignment target rather than an ObjectBindingPattern. */
  const assignmentReadsGlobalFetch = (
    node: ts.BinaryExpression,
    aliases: ReadonlySet<ts.Symbol>,
  ): boolean => {
    if (
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !globalObjectExpression(node.right, aliases)
    ) {
      return false;
    }
    const target = unwrapParentheses(node.left);
    if (!ts.isObjectLiteralExpression(target)) return false;
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "fetch";
      return ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "fetch";
    });
  };

  const bareIdentifierRead = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    // Binding-element names and aliases are declarations/property keys; the
    // global-object destructuring case is handled explicitly above.
    if (ts.isBindingElement(parent)) return false;
    if (
      (ts.isLabeledStatement(parent) ||
        ts.isBreakStatement(parent) ||
        ts.isContinueStatement(parent)) &&
      parent.label === node
    ) {
      return false;
    }
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    // Imported/exported names are module member names or declarations,
    // never reads of Node's global binding. This matters when the custom
    // no-lib program cannot resolve the referenced package and therefore
    // has no checker symbol for an ImportSpecifier.propertyName.
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;

    // Named declarations and object/class property names are not reads.
    // A shorthand property is the exception: `{ fetch }` evaluates the
    // identifier and therefore needs the global when it is unbound.
    const namedParent = parent as ts.Node & { name?: ts.Node };
    if (namedParent.name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
    return true;
  };

  const bareIdentifierIsUnbound = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    // The binder gives `{ fetch }` a symbol for the PROPERTY it creates;
    // the value-side symbol is the one that answers whether the shorthand
    // reads a local binding or Node's global.
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      return checker.getShorthandAssignmentValueSymbol(parent) === undefined;
    }
    return checker.getSymbolAtLocation(node) === undefined;
  };

  for (const sourceFile of program.getSourceFiles()) {
    // Package bootstraps commonly snapshot or select the global object before
    // reading capabilities (`const root = globalThis || global; root.fetch`).
    // Resolve alias chains by symbol, so a same-named parameter/local in
    // another scope cannot inherit the classification. Mutable declarations
    // are conservative: a global initializer means some executable path can
    // retain that value. Iterate to a fixed point so declaration order does
    // not matter.
    const globalObjectAliases = new Set<ts.Symbol>();
    let addedAlias = true;
    while (addedAlias) {
      addedAlias = false;
      const collectAliases = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          globalObjectExpression(node.initializer, globalObjectAliases)
        ) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol !== undefined && !globalObjectAliases.has(symbol)) {
            globalObjectAliases.add(symbol);
            addedAlias = true;
          }
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(sourceFile);
    }

    let usesFetch = false;
    const visit = (node: ts.Node): void => {
      if (usesFetch) return;
      if (
        (ts.isBindingElement(node) && bindingReadsGlobalFetch(node, globalObjectAliases)) ||
        (ts.isBinaryExpression(node) && assignmentReadsGlobalFetch(node, globalObjectAliases))
      ) {
        usesFetch = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "fetch" &&
        globalObjectExpression(node.expression, globalObjectAliases)
      ) {
        usesFetch = true;
        return;
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "fetch" &&
        globalObjectExpression(node.expression, globalObjectAliases)
      ) {
        usesFetch = true;
        return;
      }
      if (ts.isIdentifier(node) && node.text === "fetch") {
        // Every real bare read has no symbol in this no-lib program unless
        // source syntax binds it. Syntactic names without symbols (labels,
        // destructuring keys) are filtered separately.
        if (bareIdentifierRead(node) && bareIdentifierIsUnbound(node)) {
          usesFetch = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const originalKey = originalKeyByCanonical.get(canonical(sourceFile.fileName));
    if (usesFetch && originalKey !== undefined) found.add(originalKey);
  }
  return found;
}

/** Builtins the island provides shims for (scr_island.c). Both spellings
 * resolve to the canonical "node:" key. Subpath forms ("fs/promises") are
 * NOT shimmed unless listed here explicitly. */
const SHIMMED_BUILTINS = new Set([
  "events", "path", "process", "fs", "child_process", "os",
  "diagnostics_channel", "module", "url", "tty", "util", "util/types",
  "buffer", "string_decoder", "crypto", "stream", "stream/promises",
  "stream/consumers", "stream/web", "fs/promises", "async_hooks",
  "readline", "path/posix", "path/win32", "assert", "assert/strict",
  "punycode", "querystring", "constants", "console", "timers",
  "timers/promises", "zlib",
  // The deprecated legacy module, kept loadable because @sentry/node (the
  // a crash reporter) requires it at load on every path while
  // only driving it on Node < 14.
  "domain",
  // Loadable with Node's surface, answers fenced AT THE CALL (through the
  // callback/promise, dns's error channel): proxy-agent's pac-resolver
  // requires dns whenever proxy env vars exist and only calls lookup when
  // a PAC proxy resolves.
  "dns",
  // The main-thread worker_threads surface (real in-process MessageChannel
  // ports, Worker fences at construction) and perf_hooks' performance —
  // undici requires both UNGUARDED at load.
  "worker_threads", "perf_hooks",
  // The socket tier (scr_net_island.c + the bootstrap's shims): http/https
  // are working CLIENTS over the socket units; net/tls load and fence
  // their socket surfaces loudly at the call (isIP and friends are real).
  "http", "https", "net", "tls",
  // Loadable with Node's surface: startupSnapshot answers for real (never
  // a snapshot build; the mutators throw Node's ERR_NOT_BUILDING_SNAPSHOT),
  // heap statistics are inert-but-typed, and the V8 serialization format
  // fences at the call. Prettier's bundled error helpers call
  // startupSnapshot.isBuildingSnapshot() on every CLI start.
  "v8",
]);

/** Node builtins importable WITHOUT the "node:" prefix — used to tell
 * "missing builtin shim" apart from "missing package" for bare specifiers.
 * ("node:"-prefixed specifiers are always builtins: the prefix cannot name
 * an npm package.) */
const KNOWN_BUILTINS = new Set([
  ...SHIMMED_BUILTINS,
  "assert", "async_hooks", "buffer", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "http",
  "https", "http2", "inspector", "module", "net", "os", "perf_hooks",
  "punycode", "querystring", "readline", "repl", "stream",
  "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** One specifier's call-site kinds within a module — the edge-kind record
 * the walk's per-kind semantics act on. A specifier can appear under
 * several forms in one file; any STATIC occurrence makes the edge eager
 * (Node refuses the whole static graph at link time regardless of what the
 * lazy sites would have done). */
interface SpecifierUse {
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
}

/** moduleSpecifiersOf's full answer: the per-specifier call-site kinds
 * plus where the file's `__require` binding comes from, when it is not
 * its own. */
interface ModuleSpecifiers {
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
 * ts.preProcessFile silently drops — zod v4 re-exports its util namespace
 * that way), dynamic import("literal"), and require("literal") /
 * __require("literal") (esbuild's external-require helper — collecting its
 * literal call sites gives bundled dists an honest build-time inventory).
 * A real parse, never a regex. */
function moduleSpecifiersOf(source: string, fileName: string): ModuleSpecifiers {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const uses: SpecifierUse[] = [];
  const bySpec = new Map<string, SpecifierUse>();
  let requireHelperImport: string | null = null;
  let requireHelperReexport: string | null = null;
  /** Uses with `__require(…)` sites — attributed local vs helper AFTER the
   * walk, once the (hoisted) import declarations have all been seen. */
  const viaHelperIdent = new Set<SpecifierUse>();
  const push = (spec: string, kind: "static" | "requireLocal" | "dynamicImport" | null): SpecifierUse => {
    let use = bySpec.get(spec);
    if (!use) {
      use = {
        specifier: spec,
        static: false,
        require: false,
        requireLocal: false,
        requireViaHelper: false,
        dynamicImport: false,
      };
      bySpec.set(spec, use);
      uses.push(use);
    }
    if (kind !== null) use[kind] = true;
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
        n.importClause.namedBindings.elements.some((el) => el.name.text === "__require")
      ) {
        requireHelperImport = n.moduleSpecifier.text;
      }
      if (
        ts.isExportDeclaration(n) &&
        n.exportClause !== undefined &&
        ts.isNamedExports(n.exportClause) &&
        n.exportClause.elements.some((el) => (el.propertyName ?? el.name).text === "__require")
      ) {
        requireHelperReexport = n.moduleSpecifier.text;
      }
    } else if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg)
      ) {
        push(arg.text, "dynamicImport");
      } else if (
        ts.isIdentifier(n.expression) &&
        (n.expression.text === "require" || n.expression.text === "__require") &&
        n.arguments.length === 1 &&
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
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const use of viaHelperIdent) {
    if (requireHelperImport !== null) use.requireViaHelper = true;
    else use.requireLocal = true;
  }
  for (const use of uses) use.require = use.requireLocal || use.requireViaHelper;
  return { uses, requireHelperImport, requireHelperReexport };
}

function builtinKeyOf(specifier: string): string | null {
  if (specifier.startsWith("node:")) return specifier; // forced builtin
  const root = specifier.split("/")[0]!; // fs/promises → fs
  if (!KNOWN_BUILTINS.has(root)) return null;
  return `node:${specifier}`;
}

interface Host {
  readFile: (path: string) => string | null;
  isFile: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  /** fs.realpathSync semantics; returns the input when resolution fails. */
  realpath: (path: string) => string;
}

const realHost: Host = {
  readFile: (path) => {
    return trackedReadFile(path);
  },
  isFile: (path) => trackedFileExists(path),
  isDirectory: (path) => trackedDirectoryExists(path),
  realpath: (path) => trackedRealpath(path) ?? path,
};

interface PkgJson {
  name?: string;
  main?: string;
  module?: string;
  type?: string;
  exports?: unknown;
}

/** Package name from a specifier ("@scope/pkg/sub" → "@scope/pkg"). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Package name from a PATH into node_modules ("…/node_modules/@s/p/d/x.js"
 * → "@s/p"), for diagnostics/chains when the entry is a file, not a bare
 * specifier. Null when the path holds no node_modules segment. */
export function packageNameOfPath(path: string): string | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const rest = norm.slice(idx + "/node_modules/".length);
  return rest === "" ? null : packageNameOf(rest);
}

/** A bare-specifier import edge Node's ESM resolution REFUSES, with Node's
 * exact error message and code — or null (resolvable, or a shape this
 * probe stays conservative about). The three refusal shapes it answers,
 * per Node's PACKAGE_RESOLVE with the ["import","node","default"]
 * condition set:
 *   - nothing installed: no node_modules/<name> from the importer up to
 *     the filesystem root (and no matching self-scope) — ERR_MODULE_NOT_FOUND
 *     ("Cannot find package ...");
 *   - an "exports" map that refuses the subpath (unmatched, or matched to
 *     a null target) — ERR_PACKAGE_PATH_NOT_EXPORTED. Node's self-reference
 *     rule participates: a nearest package scope whose "name" matches makes
 *     that scope's "exports" the FINAL answer (no node_modules fallback);
 *   - a matched exports target whose exact file does not exist —
 *     ERR_MODULE_NOT_FOUND ("Cannot find module '<abs>' ..."). Exports
 *     targets resolve to exact files in Node's ESM — no extension guessing.
 * Everything else (no "exports": legacy main/index resolution with its
 * leniencies; directory-shaped targets; unreadable package.json) answers
 * null — the caller keeps its existing story. Callers exclude builtins and
 * project-internal (#alias/self-name) resolutions BEFORE probing. */
export interface NodeImportRefusal {
  message: string;
  code: "ERR_MODULE_NOT_FOUND" | "ERR_PACKAGE_PATH_NOT_EXPORTED";
  /** file:// url of the missing resolved target, when the refusal has one
   * (Node's ERR_MODULE_NOT_FOUND carries it for resolved-but-missing). */
  url?: string;
}

export function probeNodeImportRefusal(
  fromFile: string,
  specifier: string,
  host: Host = realHost,
): NodeImportRefusal | null {
  if (specifier.startsWith("#") || specifier.startsWith("node:")) return null;
  const name = packageNameOf(specifier);
  const parts = specifier.split("/");
  const subparts = specifier.startsWith("@") ? parts.slice(2) : parts.slice(1);
  const subpath = subparts.length > 0 ? `./${subparts.join("/")}` : ".";
  const importer = resolve(fromFile);
  const pkgJsonAt = (dir: string): PkgJson | null => {
    const text = host.readFile(join(dir, "package.json"));
    if (text === null) return null;
    try {
      return JSON.parse(text) as PkgJson;
    } catch {
      return null;
    }
  };
  // The final answer within one package scope (self or node_modules):
  // Node's PACKAGE_EXPORTS_RESOLVE outcome for the subpath.
  const withinScope = (pkgDir: string, pkg: PkgJson): NodeImportRefusal | null => {
    if (pkg.exports === undefined) return null; // legacy resolution — conservative
    const target = resolveExports(pkg.exports, subpath, NODE_IMPORT_CONDITIONS);
    if (target === null) {
      return {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
        message:
          subpath === "."
            ? `No "exports" main defined in ${join(pkgDir, "package.json")} imported from ${importer}`
            : `Package subpath '${subpath}' is not defined by "exports" in ${join(pkgDir, "package.json")} imported from ${importer}`,
      };
    }
    const file = join(pkgDir, target);
    if (host.isFile(file)) return null;
    if (host.isDirectory(file)) return null; // ERR_UNSUPPORTED_DIR_IMPORT territory — conservative
    return {
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find module '${file}' imported from ${importer}`,
      url: `file://${file}`,
    };
  };
  // Node's PACKAGE_SELF_RESOLVE first: the nearest package scope above the
  // importer whose "name" matches AND that carries "exports" answers —
  // finally (its refusals do NOT fall back to node_modules).
  for (let dir = dirname(importer); ; ) {
    const pkg = pkgJsonAt(dir);
    if (pkg) {
      if (pkg.name === name && pkg.exports !== undefined) return withinScope(dir, pkg);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (let dir = dirname(importer); ; ) {
    const linkDir = join(dir, "node_modules", name);
    if (host.isDirectory(linkDir)) {
      const pkgDir = host.realpath(linkDir);
      const pkg = pkgJsonAt(pkgDir);
      if (pkg === null) return null; // unreadable manifest — conservative
      return withinScope(pkgDir, pkg);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return {
        code: "ERR_MODULE_NOT_FOUND",
        message: `Cannot find package '${name}' imported from ${importer}`,
      };
    }
    dir = parent;
  }
}

/** A bare-specifier `require()` edge Node's CJS resolution REFUSES because
 * NOTHING INSTALLED resolves it: no node_modules/<name> from the requiring
 * file up to the filesystem root, and no self-scope whose "name" matches.
 * Answers Node's exact require-site Error message (MODULE_NOT_FOUND's
 * "Cannot find module '<spec>'" with the one-entry require stack — the
 * message property really carries both lines). Everything else — installed
 * packages (whatever their exports say), builtins, relative and "#"
 * specifiers — answers null: the callers' existing stories stand. Unlike
 * the ESM startup-crash channel (SEMANTICS.md 287), this refusal is a
 * RUNTIME throw at the require site, catchable — the optional-dependency
 * try/require pattern depends on exactly that. */
export function probeNodeRequireRefusal(
  fromFile: string,
  specifier: string,
  host: Host = realHost,
): { message: string } | null {
  if (
    specifier.startsWith("./") || specifier.startsWith("../") ||
    specifier.startsWith("/") || specifier.startsWith("#") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  const name = packageNameOf(specifier);
  const importer = resolve(fromFile);
  for (let dir = dirname(importer); ; ) {
    // A self-scope whose "name" matches: Node's require honors package
    // self-reference — conservative null (resolvable or its own story).
    const pkgText = host.readFile(join(dir, "package.json"));
    if (pkgText !== null) {
      try {
        if ((JSON.parse(pkgText) as PkgJson).name === name) return null;
      } catch {
        return null; // unreadable manifest — conservative
      }
    }
    if (host.isDirectory(join(dir, "node_modules", name))) return null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    message: `Cannot find module '${specifier}'\nRequire stack:\n- ${importer}`,
  };
}

export class NpmGraphBuilder {
  private readonly modules = new Map<string, EmbeddedModule>();
  private readonly edges: EmbeddedEdge[] = [];
  private readonly edgeSeen = new Set<string>();
  private readonly entries = new Map<string, string>(); // fromDir\0spec → key
  readonly errors: NpmGraphError[] = [];
  private readonly pkgJsonCache = new Map<string, PkgJson | null>();
  /** Modules whose format the RESOLUTION decided (the "module" field names
   * ESM sources regardless of the package's "type"). */
  private readonly formatOverrides = new Map<string, EmbeddedFormat>();
  /** Canonical "node:x" → packages whose code imports it. */
  private readonly builtinsSeen = new Map<string, Set<string>>();
  /** Canonical "node:x" keys some STATIC import reaches — those keep the
   * eager build error, so their builtins never mark lazy. */
  private readonly builtinsEager = new Set<string>();
  /** Unresolvable (or native-addon) lazily-reached specifiers → merged
   * call forms/packages. */
  private readonly lazyTrapsSeen = new Map<
    string,
    { via: Set<"require" | "import()" | "import">; packages: Set<string>; native: boolean }
  >();
  /** Synthetic keys for embedded import()-not-found stubs. */
  private importTrapCount = 0;
  /** moduleSpecifiersOf per module key — sweepEdges parses each module
   * once; the `__require` attribution chain re-reads helper chunks
   * through this cache. */
  private readonly specifiersCache = new Map<string, ModuleSpecifiers | null>();

  constructor(private readonly host: Host = realHost) {}

  /** Registers one user-level npm import and walks everything it reaches.
   * Idempotent per (importing dir, specifier). */
  addImport(fromFile: string, specifier: string): void {
    this.resolveEntry(fromFile, specifier, false);
  }

  /** Registers one user-level RELATIVE import whose target lives inside
   * node_modules — the e2e driver shape (`import "../node_modules/vercel/
   * dist/index.js"`): tsc resolves the FILE into the program, but shipped
   * package code has exactly one execution home, the embedded engine.
   * Resolves with Node's file rules, embeds the reached graph EAGERLY (a
   * static import links at the root), and answers the runtime entry key.
   * Idempotent per (importing dir, specifier). */
  addFileImport(fromFile: string, specifier: string): string | null {
    const cacheKey = this.entryKeyFor(fromFile, specifier);
    const cached = this.entries.get(cacheKey);
    if (cached !== undefined) {
      if (cached !== "") this.walk(cached, [packageNameOfPath(cached) ?? cached], false);
      return cached === "" ? null : cached;
    }
    const abs = resolve(dirname(resolve(fromFile)), specifier);
    const file = this.resolveFile(abs);
    if (file === null) {
      this.errors.push({ message: `cannot resolve '${specifier}' from ${fromFile}` });
      this.entries.set(cacheKey, "");
      return null;
    }
    const key = this.host.realpath(file);
    this.entries.set(cacheKey, key);
    this.walk(key, [packageNameOfPath(key) ?? key], false);
    return key;
  }

  /** Registers one user-level dynamic `import(specifier)` and embeds what
   * it reaches, returning the build-time classification the lowering acts
   * on. Bare package specifiers take the same path as static imports;
   * builtins map to their island shim keys ("fs" → "node:fs") or report
   * the missing shim; RELATIVE specifiers — the shape static imports never
   * see, because tsc compiles those — resolve against the importing FILE
   * with Node's file/extension/directory rules and embed the reached JS
   * graph. A relative target that is TypeScript is the program's own
   * module (fenced at the site: static imports are the way in), and one
   * with an extension no loader executes (.wasm, .node, ...) embeds a stub
   * whose EVALUATION throws Node's exact ERR_UNKNOWN_FILE_EXTENSION
   * TypeError — the build succeeds and the import() rejects at runtime,
   * which is precisely what Node does. */
  addDynamicImport(fromFile: string, specifier: string): DynamicImportResolution {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      const abs = specifier.startsWith("/")
        ? specifier
        : resolve(dirname(resolve(fromFile)), specifier);
      const file = this.resolveFile(abs);
      if (!file) {
        return {
          kind: "unresolved",
          message: `cannot resolve '${specifier}' from ${fromFile}`,
        };
      }
      const key = this.host.realpath(file);
      if (/\.(ts|tsx|mts|cts)$/.test(key)) return { kind: "program-module" };
      const ext = extname(key);
      if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs" && ext !== ".json") {
        if (!this.modules.has(key)) {
          const msg = `Unknown file extension "${ext}" for ${key}`;
          this.modules.set(key, {
            key,
            source:
              `throw Object.assign(new TypeError(${JSON.stringify(msg)}),` +
              `{code:"ERR_UNKNOWN_FILE_EXTENSION"});\n`,
            format: "esm",
          });
        }
        return { kind: "module", key };
      }
      // The reached subgraph sits behind THIS import() — a lazy boundary:
      // blocked edges inside it (static ones included) trap at runtime,
      // where Node fails the import()'s link.
      this.walk(key, [specifier], true);
      return { kind: "module", key };
    }
    const builtin = builtinKeyOf(specifier);
    if (builtin) {
      if (!SHIMMED_BUILTINS.has(builtin.slice(5))) {
        return { kind: "unsupported-builtin", builtin };
      }
      return { kind: "module", key: builtin };
    }
    const errorsBefore = this.errors.length;
    const key = this.resolveEntry(fromFile, specifier, true);
    if (key === null) {
      // A refusal NODE ITSELF would answer at runtime — the package isn't
      // installed, its exports refuse the subpath, or the matched target
      // file doesn't exist — is not a build error: Node evaluates the
      // import() and REJECTS it with exactly this error (the program may
      // never even call it). Embed the throwing stub with Node's message
      // and code, exactly like the ERR_UNKNOWN_FILE_EXTENSION stub above;
      // the resolveEntry error text it superseded comes off the list.
      // Failures that are NOT Node-shaped refusals (unreadable manifests,
      // deep-graph embed problems) stay build errors.
      const refusal = probeNodeImportRefusal(fromFile, specifier, this.host);
      if (refusal !== null) {
        this.errors.length = errorsBefore;
        return { kind: "module", key: this.refusalTrap(refusal) };
      }
      return {
        kind: "unresolved",
        message:
          this.errors[this.errors.length - 1]?.message ??
          `cannot resolve '${specifier}' from ${fromFile}`,
      };
    }
    return { kind: "module", key };
  }

  /** Embeds (once per distinct refusal) the ESM stub whose EVALUATION
   * throws a probed Node refusal — the import() rejects at runtime with
   * Node's exact message and code, the build succeeds. */
  private refusalTrap(refusal: NodeImportRefusal): string {
    const key = `scr:import-trap:${this.importTrapCount++}`;
    const props =
      `{code:${JSON.stringify(refusal.code)}` +
      (refusal.url === undefined ? `}` : `,url:${JSON.stringify(refusal.url)}}`);
    this.modules.set(key, {
      key,
      source: `throw Object.assign(new Error(${JSON.stringify(refusal.message)}),${props});\n`,
      format: "esm",
    });
    return key;
  }

  /** The runtime entry key a previously-added import resolved to. */
  entryOf(fromFile: string, specifier: string): string | null {
    const key = this.entries.get(this.entryKeyFor(fromFile, specifier));
    return key === undefined || key === "" ? null : key;
  }

  /** Registers one user-level createRequire(...) require and walks what
   * it reaches, answering the runtime entry key — resolveEntry's twin
   * under Node's "require" condition (a dual package embeds its CJS arm,
   * exactly what Node's createRequire loads). The cache key carries the
   * mode so a file both importing and requiring one specifier keeps two
   * entries, like the graph's own kind-split edges. */
  addRequire(fromFile: string, specifier: string): string | null {
    const cacheKey = `require\u0000${this.entryKeyFor(fromFile, specifier)}`;
    const cached = this.entries.get(cacheKey);
    if (cached !== undefined) {
      if (cached !== "") this.walk(cached, [packageNameOf(specifier)], false);
      return cached === "" ? null : cached;
    }
    const key = this.resolvePackage(dirname(resolve(fromFile)), specifier, "require", {
      importer: resolve(fromFile),
      chain: [],
    });
    this.entries.set(cacheKey, key ?? "");
    if (key) this.walk(key, [packageNameOf(specifier)], false);
    return key;
  }

  /** The embedded format of a resolved module key ("cjs"/"esm"/"json") —
   * the require lowering picks its export name by it (a CJS facade's
   * default IS module.exports; an ESM entry answers its namespace, the
   * require(esm) shape). */
  moduleFormatOf(key: string): EmbeddedFormat | null {
    return this.modules.get(key)?.format ?? null;
  }

  private entryKeyFor(fromFile: string, specifier: string): string {
    return `${dirname(resolve(fromFile))}\u0000${specifier}`;
  }

  private resolveEntry(fromFile: string, specifier: string, lazy: boolean): string | null {
    const cacheKey = this.entryKeyFor(fromFile, specifier);
    const cached = this.entries.get(cacheKey);
    if (cached !== undefined) {
      // A static import of an entry first reached through import():
      // re-walk eagerly so the subgraph promotes (Node links it now).
      if (cached !== "" && !lazy) this.walk(cached, [packageNameOf(specifier)], false);
      return cached === "" ? null : cached;
    }
    // User-level entries prefer the ESM ("import") condition — the engine
    // loads real ES modules natively; CJS-only packages fall back to the
    // require shim.
    const key = this.resolvePackage(dirname(resolve(fromFile)), specifier, "import", {
      importer: resolve(fromFile),
      chain: [],
    });
    this.entries.set(cacheKey, key ?? "");
    if (key) this.walk(key, [packageNameOf(specifier)], lazy);
    return key;
  }

  /** The cjs-lexer.ts pass over every embedded CommonJS module: lex the
   * export names exactly as Node's vendored lexer would, follow the
   * re-export forms (`module.exports = require(…)`, table spreads/values,
   * the tsc/babel star patterns) through the ALREADY-RESOLVED edges
   * (builtin and unresolved targets are skipped; a require cycle
   * contributes what is known when re-entered, like Node's seen-set), then
   * synthesize each module's ESM facade. */
  private synthesizeCjsFacades(): void {
    const target = new Map<string, string>();
    // Following a CJS re-export IS a require: when a dual package embeds
    // kind-split edges, the "require" one names the module whose exports
    // Node's lexer chain would read.
    for (const e of this.edges) {
      const k = `${e.from}\u0000${e.specifier}`;
      if (e.kind === "require" || !target.has(k)) target.set(k, e.to);
    }
    const memo = new Map<string, Set<string>>();
    const namesOf = (key: string): Set<string> => {
      let names = memo.get(key);
      if (names) return names;
      memo.set(key, (names = new Set()));
      const mod = this.modules.get(key);
      if (!mod || mod.format !== "cjs") return names;
      const lexed = cjsLexedExportsOf(mod.source, key);
      for (const n of lexed.exports) names.add(n);
      for (const spec of lexed.reexports) {
        const to = target.get(`${key}\u0000${spec}`);
        if (to !== undefined && !to.startsWith("node:")) {
          for (const n of namesOf(to)) names.add(n);
        }
      }
      return names;
    };
    for (const mod of this.modules.values()) {
      if (mod.format === "cjs" && mod.esm === undefined) {
        mod.esm = cjsEsmFacadeSource(mod.key, [...namesOf(mod.key)]);
      }
    }
  }

  finish(): NpmRuntimeGraph {
    this.synthesizeCjsFacades();
    for (const key of embeddedModulesUsingGlobalFetch([...this.modules.values()])) {
      const mod = this.modules.get(key);
      if (mod !== undefined) mod.usesFetch = true;
    }
    return {
      modules: [...this.modules.values()],
      edges: this.edges,
      entryOf: (fromFile, specifier) => {
        const key = this.entries.get(this.entryKeyFor(fromFile, specifier));
        return key === undefined || key === "" ? null : key;
      },
      builtins: [...this.builtinsSeen.entries()]
        .map(([builtin, packages]) => {
          const shimmed = SHIMMED_BUILTINS.has(builtin.slice(5));
          return {
            builtin,
            shimmed,
            lazy: !shimmed && !this.builtinsEager.has(builtin),
            packages: [...packages].sort(),
          };
        })
        .sort((a, b) => a.builtin.localeCompare(b.builtin)),
      lazyTraps: [...this.lazyTrapsSeen.entries()]
        .map(([specifier, t]) => ({
          specifier,
          via: (["require", "import()", "import"] as const).filter((v) => t.via.has(v)),
          packages: [...t.packages].sort(),
          ...(t.native ? { native: true } : {}),
        }))
        .sort((a, b) => a.specifier.localeCompare(b.specifier)),
      errors: this.errors,
    };
  }

  /* ── lazy runtime traps (require()/import() edges Node fails at the
   * call — the build embeds the failure instead of refusing) ─────────── */

  /** Records one unresolvable lazily-reached specifier for the build-time
   * inventory (the coverage report's lazy-trap rows). `via` carries only
   * the call forms whose OWN resolution failed — with per-kind condition
   * resolution, one form of a specifier can fail while another succeeds. */
  private noteLazyTrap(
    spec: string,
    via: { require: boolean; dynamicImport: boolean; static: boolean },
    pkgName: string,
    moduleLazy: boolean,
    native = false,
  ): void {
    let t = this.lazyTrapsSeen.get(spec);
    if (!t) this.lazyTrapsSeen.set(spec, (t = { via: new Set(), packages: new Set(), native }));
    if (via.require) t.via.add("require");
    if (via.dynamicImport) t.via.add("import()");
    if (via.static && moduleLazy) t.via.add("import");
    t.packages.add(pkgName);
  }

  /** Embeds the throwing ESM stub for an unresolvable dynamic import()
   * edge — Node's exact ERR_MODULE_NOT_FOUND shape at evaluation: bare
   * specifiers say `Cannot find package 'x' imported from <file>`,
   * relative ones resolve against the importer first and say `Cannot find
   * module '<abs>' imported from <file>` carrying the file:// url, which
   * is what Node's ESM resolver rejects with. Returns the stub's key (the
   * edge target). require() never reaches these: unresolvable require
   * edges embed NO edge and the island's require shim throws Node's
   * MODULE_NOT_FOUND at the call, with the LIVE require stack. */
  private importNotFoundTrap(from: string, spec: string): string {
    const key = `scr:import-trap:${this.importTrapCount++}`;
    let msg: string;
    let url: string | null = null;
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
      const abs = spec.startsWith("/") ? spec : resolve(dirname(from), spec);
      msg = `Cannot find module '${abs}' imported from ${from}`;
      url = `file://${abs}`;
    } else {
      msg = `Cannot find package '${packageNameOf(spec)}' imported from ${from}`;
    }
    const props =
      `{code:"ERR_MODULE_NOT_FOUND"` + (url === null ? `}` : `,url:${JSON.stringify(url)}}`);
    this.modules.set(key, {
      key,
      source: `throw Object.assign(new Error(${JSON.stringify(msg)}),${props});\n`,
      format: "esm",
    });
    return key;
  }

  /** The throwing stub embedded for a resolved .node native addon: Node's
   * ERR_DLOPEN_FAILED code (what a broken dlopen throws) with the island's
   * honest message. Evaluation throws — at the require() call, at a
   * facade-mediated import, at import() — and the CJS cache keeps no entry
   * for a throwing module, so every retry throws again, like Node. */
  static nativeAddonStub(key: string): string {
    const msg =
      `Cannot load native addon '${key}': scriptc binaries cannot load .node addons ` +
      `(the island has no process.dlopen)`;
    return `throw Object.assign(new Error(${JSON.stringify(msg)}),{code:"ERR_DLOPEN_FAILED"});\n`;
  }

  /* ── resolution ─────────────────────────────────────────────────── */

  private pkgJsonOf(dir: string): PkgJson | null {
    let cached = this.pkgJsonCache.get(dir);
    if (cached === undefined) {
      const text = this.host.readFile(join(dir, "package.json"));
      cached = text === null ? null : (JSON.parse(text) as PkgJson);
      this.pkgJsonCache.set(dir, cached);
    }
    return cached;
  }

  /** The nearest package.json "type" above `file` — the .js format rule.
   * Resolution-time overrides (the "module" field) win. */
  private formatOf(file: string): EmbeddedFormat {
    const override = this.formatOverrides.get(file);
    if (override) return override;
    if (file.endsWith(".mjs")) return "esm";
    if (file.endsWith(".cjs")) return "cjs";
    if (file.endsWith(".json")) return "json";
    for (let dir = dirname(file); ; ) {
      const pkg = this.pkgJsonOf(dir);
      if (pkg) return pkg.type === "module" ? "esm" : "cjs";
      const parent = dirname(dir);
      if (parent === dir) return "cjs";
      dir = parent;
    }
  }

  /** Node-style file resolution: exact file, extension candidates
   * (commander requires './suggestSimilar'; ".node" is in Node's require
   * probe list — the resolved addon embeds as a throwing dlopen stub),
   * then directory resolution (the directory's package.json "main", else
   * its index files). */
  private resolveFile(path: string, depth = 0): string | null {
    if (depth > 8) return null; // a "main" cycle — refuse quietly
    if (this.host.isFile(path)) return path;
    for (const ext of [".js", ".json", ".mjs", ".cjs", ".node"]) {
      if (this.host.isFile(path + ext)) return path + ext;
    }
    if (this.host.isDirectory(path)) {
      const dir = this.host.realpath(path);
      const main = this.pkgJsonOf(dir)?.main;
      if (typeof main === "string" && main !== "") {
        const viaMain = this.resolveFile(join(dir, main), depth + 1);
        if (viaMain) return viaMain;
      }
      for (const idx of ["index.js", "index.json", "index.mjs", "index.cjs", "index.node"]) {
        const p = join(path, idx);
        if (this.host.isFile(p)) return p;
      }
    }
    return null;
  }

  /** "a → b → c" — the package chain from the user's import to the point
   * of failure, for diagnostics. */
  private static chainOf(chain: readonly string[], last?: string): string {
    const full = last === undefined ? chain : [...chain, last];
    return full.join(" → ");
  }

  /** Locates node_modules/<name> by walking up from `fromDir` to the
   * filesystem ROOT (dependencies hoist arbitrarily far in workspace
   * layouts), following symlinks with realpath (pnpm/bun virtual stores),
   * then resolves the runtime entry: package.json "exports" with the
   * given condition (strict — an exports map that doesn't match is an
   * error, like Node's ERR_PACKAGE_PATH_NOT_EXPORTED), else the "module"/
   * "main" fallbacks. Returns the realpath'd entry key. */
  private resolvePackage(
    fromDir: string,
    specifier: string,
    mode: "import" | "require",
    ctx: { importer: string; chain: readonly string[] },
  ): string | null {
    const name = packageNameOf(specifier);
    const parts = specifier.split("/");
    const subparts = specifier.startsWith("@") ? parts.slice(2) : parts.slice(1);
    const subpath = subparts.length > 0 ? `./${subparts.join("/")}` : ".";
    const chain = NpmGraphBuilder.chainOf(ctx.chain, name);
    // Node's PACKAGE_SELF_RESOLVE runs BEFORE any node_modules lookup: the
    // nearest package scope above the importing module whose "name" equals
    // the specifier's package name AND that carries "exports" answers the
    // specifier through its OWN exports map — finally (a refusal there
    // never falls back to node_modules). Common in packages whose internal
    // modules import the package by its published name (benign self-
    // reference cycles); without this rule the up-walk only finds the
    // package when it happens to sit under a node_modules/<name> path.
    for (let dir = fromDir; ; ) {
      const selfPkg = this.pkgJsonOf(dir);
      if (selfPkg) {
        if (selfPkg.name === name && selfPkg.exports !== undefined) {
          const fromExports = resolveExports(selfPkg.exports, subpath, nodeExportConditions(mode));
          if (fromExports === null) {
            this.errors.push({
              message:
                `package '${name}' does not export '${subpath}' in its package.json "exports"` +
                ` (self-reference; imported from ${ctx.importer}; dependency chain: ${chain})`,
            });
            return null;
          }
          const resolved = this.resolveFile(join(dir, fromExports));
          if (!resolved) {
            this.errors.push({
              message:
                `package '${name}' resolves its ${subpath === "." ? "entry" : `'${subpath}'`} to '${fromExports}', which does not exist` +
                ` (self-reference; imported from ${ctx.importer}; dependency chain: ${chain})`,
            });
            return null;
          }
          return this.host.realpath(resolved);
        }
        break; // nearest scope decides self-reference — matching or not
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (let dir = fromDir; ; ) {
      const linkDir = join(dir, "node_modules", name);
      const pkgDir = this.host.isDirectory(linkDir) ? this.host.realpath(linkDir) : null;
      const pkg = pkgDir !== null ? this.pkgJsonOf(pkgDir) : null;
      if (pkgDir !== null && pkg !== null) {
        let target: string;
        let forceEsm = false;
        if (pkg.exports !== undefined) {
          const fromExports = resolveExports(pkg.exports, subpath, nodeExportConditions(mode));
          if (fromExports === null) {
            this.errors.push({
              message:
                `package '${name}' does not export '${subpath}' in its package.json "exports"` +
                ` (imported from ${ctx.importer}; dependency chain: ${chain})`,
            });
            return null;
          }
          target = fromExports;
        } else if (subpath !== ".") {
          target = subpath;
        } else if (mode === "import" && typeof pkg.module === "string" && pkg.module !== "") {
          // No "exports": the "module" field names the ESM build (a
          // bundler convention Node itself ignores; embedding prefers the
          // real ES module over require-shimming the CJS "main").
          target = pkg.module;
          forceEsm = true;
        } else {
          target = pkg.main && pkg.main !== "" ? pkg.main : "index.js";
        }
        const resolved = this.resolveFile(join(pkgDir, target));
        if (!resolved) {
          this.errors.push({
            message:
              `package '${name}' resolves its ${subpath === "." ? "entry" : `'${subpath}'`} to '${target}', which does not exist` +
              ` (imported from ${ctx.importer}; dependency chain: ${chain})`,
          });
          return null;
        }
        const key = this.host.realpath(resolved);
        if (forceEsm && !key.endsWith(".mjs") && !key.endsWith(".cjs") && !key.endsWith(".json")) {
          this.formatOverrides.set(key, "esm");
        }
        return key;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        this.errors.push({
          message:
            `cannot find package '${name}' in any node_modules from ${fromDir} up to the root` +
            ` (imported from ${ctx.importer}${ctx.chain.length > 0 ? `; dependency chain: ${chain}` : ""})`,
        });
        return null;
      }
      dir = parent;
    }
  }

  /* ── the walk ─────────────────────────────────────────────────── */

  /** Modules reached ONLY through lazy edges so far. Node has not linked
   * these at the root: the whole subgraph behind a require()/import()
   * boundary links AT THE CALL, so every blocked edge inside it — static
   * imports included — fails there at runtime, never at build time. A
   * later STATIC path promotes the module to eager: its edges re-sweep so
   * blocked static ones become build errors, exactly the graph Node would
   * refuse at link. */
  private readonly lazilyReached = new Set<string>();

  /** Embeds `key` and everything it reaches. `chain` is the package path
   * from the user's import to this module's package — diagnostics name it
   * so a failure five dependencies deep is attributable. `lazy` is the
   * REACHABILITY mode: true when every path from the user's import to this
   * module crosses a require()/dynamic-import() edge. */
  private walk(key: string, chain: readonly string[], lazy: boolean): void {
    const existing = this.modules.get(key);
    if (existing) {
      if (!lazy && this.lazilyReached.has(key)) {
        // Promotion: a static path reached a module first seen behind a
        // lazy boundary — Node links it at the root now, so its edge
        // sweep re-runs eagerly (pushes dedupe through edgeSeen).
        this.lazilyReached.delete(key);
        if (existing.format !== "json") {
          this.sweepEdges(key, existing.source, chain, false);
        }
      }
      return;
    }
    if (key.endsWith(".node")) {
      // A native addon: Node process.dlopen()s it; the island has no
      // dlopen, so the resolved edge embeds a throwing CJS STUB (Node's
      // ERR_DLOPEN_FAILED code) instead of megabytes of machine code the
      // engine could never execute — rolldown/oxc-style binding packages
      // require() their .node next to a wasm/js fallback, so the stub is
      // exactly the "addon missing" path those packages already handle.
      // The require sites are lazy by construction (an eager static
      // import of a .node would refuse under Node too), so the throw
      // lands at the call, the only point Node would have dlopen'd.
      this.modules.set(key, { key, source: NpmGraphBuilder.nativeAddonStub(key), format: "cjs" });
      return;
    }
    const source = this.host.readFile(key);
    if (source === null) {
      this.errors.push({
        message: `cannot read embedded module '${key}' (dependency chain: ${NpmGraphBuilder.chainOf(chain)})`,
      });
      return;
    }
    const format = this.formatOf(key);
    this.modules.set(key, { key, source, format });
    if (lazy) this.lazilyReached.add(key);
    if (format === "json") return;
    this.sweepEdges(key, source, chain, lazy);
  }

  /** moduleSpecifiersOf through the per-module cache (each module parses
   * once even across promotion re-sweeps, and the `__require` attribution
   * chain re-reads helper chunks it never sweeps itself). */
  private specifiersOf(key: string, source?: string): ModuleSpecifiers | null {
    let cached = this.specifiersCache.get(key);
    if (cached === undefined) {
      const text = source ?? this.host.readFile(key);
      cached = text === null ? null : moduleSpecifiersOf(text, key);
      this.specifiersCache.set(key, cached);
    }
    return cached;
  }

  /** The module whose scope DEFINES the `__require` helper that `key`'s
   * call sites invoke, or null when it is key's own (or unresolvable).
   * esbuild splits the helper into a shared chunk that every other chunk
   * imports; the helper closed over THAT chunk's banner require
   * (createRequire(import.meta.url)), so Node resolves its calls from the
   * DEFINING chunk — and the island's require shim looks the edge up
   * under that key at the call. Follows import → re-export hops through
   * intermediate chunks, bounded. */
  private requireHelperOriginOf(key: string): string | null {
    let cur = key;
    for (let hops = 0; hops < 8; hops++) {
      const specs = this.specifiersOf(cur);
      const next =
        specs === null
          ? null
          : cur === key
            ? specs.requireHelperImport
            : (specs.requireHelperImport ?? specs.requireHelperReexport);
      if (next === null) break;
      let target: string | null = null;
      if (next.startsWith("./") || next.startsWith("../")) {
        const file = this.resolveFile(resolve(dirname(cur), next));
        target = file === null ? null : this.host.realpath(file);
      } else if (builtinKeyOf(next) === null) {
        const errorsBefore = this.errors.length;
        target = this.resolvePackage(dirname(cur), next, "import", { importer: cur, chain: [] });
        if (target === null) this.errors.length = errorsBefore;
      }
      if (target === null) break;
      cur = target;
    }
    return cur === key ? null : cur;
  }

  /** One module's edge sweep. Per-edge semantics match Node's: an edge is
   * EAGER only when the module itself is eagerly reached AND the site is a
   * static import/export declaration — Node's link-time surface, where a
   * blocked edge fails the BUILD. Everything else is LAZY — Node fails
   * require at the CALL and import() at evaluation, and a subgraph behind
   * either boundary (its static edges included) links at that call — so a
   * blocked lazy edge embeds a runtime trap and the build succeeds: a
   * program that never executes the call runs fine under Node too. */
  private sweepEdges(key: string, source: string, chain: readonly string[], lazy: boolean): void {
    const pkgName = chain[chain.length - 1] ?? key;
    const pushEdge = (from: string, spec: string, to: string, kind: EmbeddedEdge["kind"]): void => {
      const edgeKey = `${from}\u0000${spec}\u0000${kind}`;
      if (this.edgeSeen.has(edgeKey)) return;
      this.edgeSeen.add(edgeKey);
      this.edges.push({ from, specifier: spec, to, kind });
    };
    for (const use of this.specifiersOf(key, source)?.uses ?? []) {
      const spec = use.specifier;
      const eager = !lazy && use.static;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        // A relative file: no conditions apply, so every call form shares
        // one "any" edge. A blocked lazy one embeds the import trap only
        // for import()/static-in-lazy sites — require-reached specs embed
        // NO edge and the island's require shim throws Node's
        // MODULE_NOT_FOUND with the live require stack at the call.
        const file = this.resolveFile(resolve(dirname(key), spec));
        const to = file === null ? null : this.host.realpath(file);
        if (!to) {
          if (eager) {
            this.errors.push({
              message:
                `package '${pkgName}' cannot resolve '${spec}' from ${key}` +
                ` (dependency chain: ${NpmGraphBuilder.chainOf(chain)})`,
            });
          } else {
            this.noteLazyTrap(spec, use, pkgName, lazy);
            if (use.dynamicImport || (lazy && use.static)) {
              pushEdge(key, spec, this.importNotFoundTrap(key, spec), "import");
            }
          }
          continue;
        }
        // A resolved .node addon embeds as a throwing dlopen stub (see
        // walk) — the inventory row keeps the coverage report honest
        // about what the binary cannot reach.
        if (to.endsWith(".node")) this.noteLazyTrap(spec, use, pkgName, lazy, true);
        pushEdge(key, spec, to, "any");
        this.walk(to, chain, lazy || !use.static);
        continue;
      }
      const builtin = builtinKeyOf(spec);
      if (builtin) {
        let seen = this.builtinsSeen.get(builtin);
        if (!seen) this.builtinsSeen.set(builtin, (seen = new Set()));
        seen.add(pkgName);
        if (eager) this.builtinsEager.add(builtin);
        if (eager && !SHIMMED_BUILTINS.has(builtin.slice(5))) {
          this.errors.push({
            message:
              `package '${pkgName}' requires '${spec}', a Node builtin the island does not provide ` +
              `(available: ${[...SHIMMED_BUILTINS].map((b) => `node:${b}`).join(", ")}; ` +
              `imported from ${key}; dependency chain: ${NpmGraphBuilder.chainOf(chain)})`,
          });
          continue;
        }
        // The edge embeds pointing at the "node:x" key (for an unshimmed
        // builtin reached lazily, the island's require shim — "the island
        // does not provide the 'node:x' builtin" — or module loader
        // throws at the CALL, the only point Node would have loaded the
        // module either). Builtin resolution is location-independent
        // under Node, but the EDGE isn't: a call through the imported
        // `__require` helper asks from the DEFINING chunk's key at
        // runtime, so the edge registers there too (sentry's
        // `__require("domain")` sites live in one chunk, the helper in
        // another).
        pushEdge(key, spec, builtin, "any");
        if (use.requireViaHelper) {
          const origin = this.requireHelperOriginOf(key);
          if (origin !== null) pushEdge(origin, spec, builtin, "require");
        }
        continue;
      }
      // A bare dependency package: Node picks the "exports" condition set
      // from the EDGE KIND, never from the importer's format — import/
      // export declarations and import() resolve with ["node","import"],
      // require() with ["node","require"] — so a dual package legitimately
      // embeds TWO targets for one specifier, each behind its own
      // kind-tagged edge (the island's module loader asks with the import
      // kind, its require shim with the require kind).
      const depName = packageNameOf(spec);
      const nextChain = depName === pkgName ? chain : [...chain, depName];
      if (use.require) {
        // require edges attribute to the module whose scope DEFINES the
        // require function being called: a direct require() is this file's
        // own (its banner createRequire), but an esbuild `__require`
        // imported from a shared chunk closed over THAT chunk's require,
        // so Node resolves from the defining chunk — and the island's
        // require shim looks the edge up under its key at the call.
        const froms = new Set<string>();
        if (use.requireLocal) froms.add(key);
        if (use.requireViaHelper) froms.add(this.requireHelperOriginOf(key) ?? key);
        for (const from of froms) {
          const errorsBefore = this.errors.length;
          const to = this.resolvePackage(dirname(from), spec, "require", {
            importer: from,
            chain,
          });
          if (to === null) {
            // require failures are ALWAYS lazy — no edge embeds; the
            // island's require shim throws Node's MODULE_NOT_FOUND with
            // the live require stack at the call.
            this.errors.length = errorsBefore;
            this.noteLazyTrap(
              spec,
              { require: true, dynamicImport: false, static: false },
              pkgName,
              lazy,
            );
            continue;
          }
          // A package whose entry IS a .node addon (napi per-platform
          // binding packages: "main" names the addon) embeds the dlopen
          // stub — inventory row like the relative-specifier shape.
          if (to.endsWith(".node")) {
            this.noteLazyTrap(
              spec,
              { require: true, dynamicImport: false, static: false },
              pkgName,
              lazy,
              true,
            );
          }
          pushEdge(from, spec, to, "require");
          this.walk(to, nextChain, true);
        }
      }
      if (use.static || use.dynamicImport) {
        const errorsBefore = this.errors.length;
        const to = this.resolvePackage(dirname(key), spec, "import", { importer: key, chain });
        if (to === null) {
          if (!eager) {
            // Roll the resolver's diagnostics back off the build — the
            // blocked edge is lazy, so the failure belongs to the runtime
            // trap (and the coverage inventory), not the error list. The
            // trap is an ESM stub with Node's ERR_MODULE_NOT_FOUND shape,
            // behind an import-kind edge the require shim never matches.
            this.errors.length = errorsBefore;
            this.noteLazyTrap(
              spec,
              { require: false, dynamicImport: use.dynamicImport, static: use.static },
              pkgName,
              lazy,
            );
            if (use.dynamicImport || (lazy && use.static)) {
              pushEdge(key, spec, this.importNotFoundTrap(key, spec), "import");
            }
          }
          continue; // eager: error already recorded
        }
        if (to.endsWith(".node")) {
          this.noteLazyTrap(
            spec,
            { require: false, dynamicImport: use.dynamicImport, static: use.static },
            pkgName,
            lazy,
            true,
          );
        }
        pushEdge(key, spec, to, "import");
        this.walk(to, nextChain, lazy || !use.static);
      }
    }
  }
}
