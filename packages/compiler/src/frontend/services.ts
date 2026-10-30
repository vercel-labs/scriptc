import { Ts7SourceParser, type Ts7SourceKind } from "./ts7/source-parser.js";
import { Ts7Host, type Ts7ApiFactory, type Ts7HostOptions } from "./ts7/program-host.js";
import { lowerEsmInitsWithParser, rewriteBundlerCjsWithParser } from "./npm-static-rewrite-host.js";
import { isBundlerCjsCandidate } from "./npm-static-rewrite-syntax.js";
import { normalizeCjsFunctionExports } from "./npm-static-cjs-exports-alias.js";
import {
  mayBundleChunks,
  splitBundledChunks,
  type BundledChunkSplit,
} from "./npm-static-bundled-chunks.js";
import {
  mayRequireBuiltinAlias,
  rewriteBuiltinAliasRequires,
} from "./npm-static-builtin-aliases.js";
import { mayHoldUmdWrapper, unwrapUmdFactory } from "./npm-static-umd.js";
import { mayHoldEnumIife, rewriteEnumIifes } from "./npm-static-enum-iife.js";
import {
  mayHoldNamespaceDefault,
  rewriteNamespaceDefaults,
} from "./npm-static-namespace-defaults.js";
import { mayHoldTscBuiltinImport, unwrapTscBuiltinImports } from "./npm-static-tsc-helpers.js";
import { builtinPackageAliasFor } from "./package-shims.js";
import * as syntax from "./npm-static-declaration-syntax.js";
import { normalizeCjsExportsVar } from "./npm-static-cjs-exports-var.js";
import type { SourceFile } from "./ts7/ast-types.js";

/** Whether the source can contain `word` as a keyword or identifier: it
 * holds the word itself or a Unicode escape that might spell it. */
function spells(source: string, word: string): boolean {
  return source.includes(word) || source.includes("\\u");
}

/** Evaluate an isolated, self-contained TypeScript callback under a finite
 * budget. Hosts supply execution; shared lowering owns capture checks and
 * verifies the returned value before baking it into the program. */
export type ComptimeEvaluator = (source: string, timeoutMs: number) => unknown;

/** A Node host keeps its process-specific resolver settings and hooks. Native
 * clients use the filesystem resolver when no host adapter is supplied. */
export interface RuntimeModuleResolver {
  resolve: (fromFile: string, specifier: string, paths: readonly string[] | undefined) => string;
  lookupPaths: (fromFile: string, specifier: string) => readonly string[] | null;
}

/** Own the syntax and semantic services for a compiler client. The supplied
 * connection factory and optional evaluator provide host operations;
 * parsing, projection and filesystem resolution share their implementation
 * across native and Node clients. Program hosts belong to their callers. */
export class FrontendServices {
  private parser: Ts7SourceParser | undefined;
  private closed = false;

  constructor(
    private readonly createApi: Ts7ApiFactory,
    private readonly cwd = process.cwd(),
    private readonly comptimeEvaluator: ComptimeEvaluator | undefined = undefined,
    readonly runtimeModuleResolver: RuntimeModuleResolver | undefined = undefined,
  ) {}

  private ensureOpen(): void {
    if (this.closed) throw new Error("frontend services are closed");
  }
  private sourceParser(): Ts7SourceParser {
    this.ensureOpen();
    // Called as a plain function: the instance is not its receiver.
    const createApi = this.createApi;
    return (this.parser ??= new Ts7SourceParser(
      // The parser reads no libraries, so it gains nothing from the shared
      // checker server, and leaves it to the program's checker.
      (options) => createApi({ ...options, collectTiming: false, shared: false }),
      this.cwd,
    ));
  }
  parse(path: string, source: string, kind: Ts7SourceKind): SourceFile {
    return this.sourceParser().parse(path, source, kind);
  }
  evaluateComptime(source: string, timeoutMs: number): unknown {
    this.ensureOpen();
    const evaluate = this.comptimeEvaluator;
    if (evaluate === undefined)
      throw new Error("this compiler host does not provide compile-time evaluation");
    return evaluate(source, timeoutMs);
  }
  createProgramHost(options?: Ts7HostOptions): Ts7Host {
    this.ensureOpen();
    return new Ts7Host(this.createApi, { ...options, cwd: options?.cwd ?? this.cwd });
  }
  rewriteCjs(
    source: string,
    path: string,
    liveExportTable?: (path: string) => void,
    lexerVisibleNames?: (path: string, names: readonly string[]) => void,
  ): string | { degrade: string } | null {
    this.ensureOpen();
    if (!isBundlerCjsCandidate(source)) return null;
    return rewriteBundlerCjsWithParser(
      this.sourceParser(),
      source,
      path,
      liveExportTable,
      lexerVisibleNames,
    );
  }
  /** A CommonJS bundle's __commonJS chunks as their own modules (null: no
   * chunks; a degrade reason: chunks the recognizer cannot move). */
  splitCjsChunks(source: string, path: string): BundledChunkSplit | { degrade: string } | null {
    this.ensureOpen();
    if (!mayBundleChunks(source)) return null;
    return splitBundledChunks(this.parse(path, source, "js"), path);
  }
  /** A CommonJS bundle's lazily initialized ES modules (__esm) lowered to
   * run-once closures (null: none; a degrade reason: shapes the rewrite
   * cannot lower). */
  lowerEsmInits(source: string, path: string): string | { degrade: string } | null {
    this.ensureOpen();
    if (!source.includes("__esm")) return null;
    return lowerEsmInitsWithParser(this.sourceParser(), source, path);
  }
  /** A CommonJS module whose export object is one of its functions, with
   * its member accesses respelled through that function (null: none). */
  cjsFunctionExports(source: string, path: string): string | null {
    this.ensureOpen();
    if (!source.includes("module.exports")) return null;
    return normalizeCjsFunctionExports(this.parse(path, source, "js"));
  }
  /** A package module with tsc's interop bindings of builtin modules
   * unwrapped to plain requires (null: none). */
  tscBuiltinImports(source: string, path: string): string | null {
    this.ensureOpen();
    if (!mayHoldTscBuiltinImport(source)) return null;
    return unwrapTscBuiltinImports(this.parse(path, source, "js"));
  }
  /** A package module written as TypeScript's UMD wrapper with its
   * factory body at the top level (null: not one). */
  umdFactory(source: string, path: string): string | null {
    this.ensureOpen();
    if (!mayHoldUmdWrapper(source)) return null;
    return unwrapUmdFactory(this.parse(path, source, "js"));
  }
  /** A package module with its literal-valued TypeScript enum IIFEs
   * respelled as object literals (null: none). */
  enumIifes(source: string, path: string): string | null {
    this.ensureOpen();
    if (!mayHoldEnumIife(source)) return null;
    return rewriteEnumIifes(this.parse(path, source, "js"));
  }
  /** A package module with its guarded namespace declarations
   * (`var ns = ns || {}`) respelled as plain ones (null: none). */
  namespaceDefaults(source: string, path: string): string | null {
    this.ensureOpen();
    if (!mayHoldNamespaceDefault(source)) return null;
    return rewriteNamespaceDefaults(this.parse(path, source, "js"));
  }
  /** A package module with its requires of builtin-aliased polyfill
   * packages respelled as the builtins (null: none). */
  builtinAliasRequires(source: string, path: string): string | null {
    this.ensureOpen();
    if (!mayRequireBuiltinAlias(source)) return null;
    return rewriteBuiltinAliasRequires(this.parse(path, source, "js"), (specifier) =>
      builtinPackageAliasFor(path, specifier),
    );
  }
  /** A CommonJS module that names its export object through a variable
   * (`var ip = exports`), its member accesses respelled through `exports`
   * (null: none). */
  cjsExportsVar(source: string, path: string): string | null {
    this.ensureOpen();
    if (!source.includes("exports")) return null;
    return normalizeCjsExportsVar(this.parse(path, source, "js"));
  }
  nullableClassFields(path: string, source: string): syntax.NpmStaticOverloadRewrite | null {
    // Rewrites `null`-initialized fields of class declarations.
    if (!spells(source, "class") || !spells(source, "null")) return null;
    return syntax.applyNpmStaticNullableClassFields(this.parse(path, source, "js"), source);
  }
  jsDocNamepaths(path: string, source: string): string | null {
    // A namepath segment joined by `#` or `~` (applyNpmStaticJsDocNamepaths).
    if (!/[$\w][#~][$A-Z_a-z]/.test(source)) return null;
    return syntax.applyNpmStaticJsDocNamepaths(this.parse(path, source, "js"), source);
  }
  findReturnWidening(path: string, source: string): syntax.NpmStaticOverloadRewrite | null {
    // Widens `find` calls returned by methods of class declarations.
    if (!spells(source, "class") || !spells(source, "find")) return null;
    return syntax.applyNpmStaticFindReturnWidening(this.parse(path, source, "js"), source);
  }
  declarationProperties(
    path: string,
    source: string,
    declarations: syntax.NpmStaticDeclarationProperties,
  ): syntax.NpmStaticOverloadRewrite | null {
    this.ensureOpen();
    if (declarations.size === 0) return null;
    return syntax.applyNpmStaticDeclarationProperties(
      this.parse(path, source, "js"),
      source,
      declarations,
    );
  }
  declarationOverloads(
    path: string,
    source: string,
    declarations: syntax.NpmStaticDeclarationOverloads,
  ): syntax.NpmStaticOverloadRewrite | null {
    this.ensureOpen();
    if (declarations.size === 0) return null;
    return syntax.applyNpmStaticDeclarationOverloads(
      this.parse(path, source, "js"),
      source,
      declarations,
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const parser = this.parser;
    this.parser = undefined;
    parser?.close();
  }
}
