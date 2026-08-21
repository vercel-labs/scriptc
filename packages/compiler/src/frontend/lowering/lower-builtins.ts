/* Builtin-surface lowering: node builtin-module calls (fs, path, os, url,
 * crypto, child_process spawn/spawnSync and child/stats/spawn-result
 * methods), JSON.parse/stringify, process properties/methods and
 * process.env access, and console.log detection. */
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError, dynUndefinedExpr, ladderFenceExpr, nodeThrowExpr, own } from "./lowerer.js";
import { canonicalBuiltinModule, isJsSourceFile, locOf, requireSpecOf } from "../program.js";
import { isRelativeSpecifier } from "../shared.js";
import { probeNodeRequireRefusal } from "../npm.js";
import { isNpmStaticPackage } from "../npm-static.js";
import { trackedReadFile } from "../input-tracker.js";
import { invalidJsonModuleDiag, requiresDynamicImportDiag } from "../../diagnostics/diagnostic.js";
import {
  BuiltinModuleFn,
  builtinModuleFnOf,
  FS_READDIR_DOCUMENTED_OPTIONS,
  FS_WATCH_DOCUMENTED_OPTIONS,
  FS_WRITE_FILE_DOCUMENTED_OPTIONS,
  QS_PARSE_DOCUMENTED_OPTIONS,
  QS_STRINGIFY_DOCUMENTED_OPTIONS,
  READLINE_DOCUMENTED_OPTIONS,
  builtinConstLit,
  fenceOrDropOptionKey,
  isChildSurfaceMember,
} from "./surfaces.js";
import { conditionalSpreadOf, droppableStatic, lowerDynObjectLiteral } from "./lower-exprs.js";
import { HTTP2_CONSTANTS } from "./http2-constants.js";
import { CRYPTO_CIPHERS, CRYPTO_CONSTANTS, CRYPTO_CURVES, CRYPTO_HASHES } from "./crypto-tables.js";
import { timerStyleCallback } from "./lower-calls.js";
import { registerHttpClientFnBinding, voidizedCallback } from "./lower-server.js";
import { BOOL, BYTES_U8, CHILD_T, CHILDSTREAM_T, DYN, F64, FILEHANDLE_T, FSWATCHER_T, PROCSTREAM_T, IrExpr, IrFunction, IrLibFn, IrLocal, IrStmt, IrType, JSVAL, NULL_T, SEARCH_PARAMS_T, SPAWNRES_T, STRING, SrcLoc, UNDEFINED_T, VOID, arrayOf, canBoxFuncIntoDyn, canConvertToDyn, funcOf, isUnitType, typeEquals, typeKey } from "../../ir/nodes.js";

/** Lower an optional builtin argument whose checker type is statically
 * undefined/void. The returned expression exists only to preserve effects;
 * callers replace its value with the API default. */
function lowerStaticallyUndefinedBuiltinArg(L: Lowerer, node: ts.Expression): IrExpr | null {
  const peel = (value: ts.Expression): ts.Expression => {
    let expr = value;
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertion(expr) ||
      ts.isSatisfiesExpression(expr)
    ) {
      expr = expr.expression;
    }
    return expr;
  };
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if ((L.typeOf(expr).flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0) return null;
  expr = peel(expr);
  let sawVoid = false;
  while (ts.isVoidExpression(expr)) {
    sawVoid = true;
    expr = peel(expr.expression);
  }
  return L.lowerExpr(sawVoid ? expr : node);
}

function defaultAfterUndefined(value: IrExpr, dflt: IrExpr): IrExpr {
  if (droppableStatic(value)) return dflt;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
    result: dflt,
    type: dflt.type,
    loc: value.loc,
  };
}

/** Complete an optional builtin argument. Statically undefined spellings
 * preserve their effects and select the default; a runtime unit-armed union
 * uses nullish selection when every non-unit arm is the expected type. */
function lowerBuiltinOptionalDefault(
  L: Lowerer,
  node: ts.Expression,
  expected: IrType,
  dflt: IrExpr,
  nullIsDefault = false,
): IrExpr {
  const undefinedArg = lowerStaticallyUndefinedBuiltinArg(L, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, dflt);
  if (nullIsDefault && (L.typeOf(node).flags & ts.TypeFlags.Null) !== 0) {
    return defaultAfterUndefined(L.lowerExpr(node), dflt);
  }
  const value = L.lowerExpr(node);
  if (value.type.kind === "union") {
    const def = L.unions.get(value.type.unionId);
    const allowed = def?.arms.every(
      (arm) =>
        typeEquals(arm, expected) ||
        arm.kind === "undefinedT" ||
        (nullIsDefault && arm.kind === "nullT"),
    );
    if (allowed && def!.arms.some((arm) => isUnitType(arm))) {
      return { kind: "nullish", left: value, right: dflt, type: expected, loc: value.loc };
    }
  }
  return L.coerceInto(node, value, expected);
}






/** Resolves an identifier to a supported builtin-module IMPORT BINDING:
   * a named import (through its alias, so `import { join as j }` matches)
   * whose declaration is an ImportSpecifier under a supported builtin
   * specifier — "fs"/"node:fs", "path"/"node:path", ... The SPECIFIER is
   * the provenance: user code can only acquire these bindings by importing
   * the module (preflight allowlists exactly these specifiers, and Node
   * itself resolves bare builtin names to the builtin — no npm shadowing),
   * and a same-named local or user function has a different symbol whose
   * declaration is not an import specifier. Returns the CANONICAL module
   * name and the EXPORTED member name (not the local alias). */
  export function builtinImportOf(L: Lowerer, ident: ts.Identifier): { module: string; member: string } | null {
    const symbol = L.checker.getSymbolAtLocation(ident);
    const decl = symbol ? L.checker.declarationsOf(symbol)[0] : undefined;
    if (!decl) return null;
    // The CommonJS twin of the named import: a destructured require
    // binding (`const { readFileSync } = require("fs")`, renames via
    // `{ readFileSync: rf }`) keys the same tables.
    if (ts.isBindingElement(decl) && decl.name !== undefined && ts.isIdentifier(decl.name)) {
      const varDecl = decl.parent.parent;
      if (
        ts.isObjectBindingPattern(decl.parent) &&
        ts.isVariableDeclaration(varDecl) &&
        varDecl.initializer !== undefined
      ) {
        const spec = requireSpecOf(varDecl.initializer);
        const module = spec !== null
          ? canonicalBuiltinModule(spec)
          // The one-hop alias twin: `const crypto = require('crypto');
          // const { createSign } = crypto;` — test/common's idiom. The
          // destructure re-binds module members under local names, so the
          // bindings key the same tables as the direct-require form.
          : builtinNamespaceDestructureModuleOf(L, varDecl);
        if (module === null) return null;
        const member = decl.propertyName && ts.isIdentifier(decl.propertyName)
          ? decl.propertyName.text
          : decl.name.text;
        return { module, member };
      }
      return null;
    }
    // The MEMBER-BINDING CommonJS twin: `const inspect =
    // require("util").inspect` binds ONE exported member under the const's
    // name. The declaration itself is alias plumbing and emits nothing
    // (builtinMemberRequireDecl — lowerVarDecl and collectGlobals both
    // skip it); uses key the same tables as any named import.
    if (
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name) &&
      decl.initializer !== undefined &&
      ts.isPropertyAccessExpression(decl.initializer) &&
      !decl.initializer.questionDotToken
    ) {
      const spec = requireSpecOf(decl.initializer.expression);
      const module = spec !== null ? canonicalBuiltinModule(spec) : null;
      if (module === null) return null;
      return { module, member: decl.initializer.name.text };
    }
    if (!ts.isImportSpecifier(decl) && !ts.isExportSpecifier(decl)) return null;
    if (ts.isImportSpecifier(decl)) {
      const importDecl = decl.parent.parent.parent;
      if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
        return null;
      }
      const module = canonicalBuiltinModule(importDecl.moduleSpecifier.text);
      if (module !== null) return { module, member: decl.propertyName?.text ?? decl.name.text };
    }
    // The RE-EXPORT FACADE hop: a binding acquired through a user module
    // that re-exports a builtin (`import { ok } from "./assert-facade.js"`
    // over `export { ok } from "node:assert"` — the formatter idiom's
    // universal/assert idiom; the namespace-member spelling resolves to
    // the facade's ExportSpecifier the same way). The specifier here is a
    // user module, so provenance comes from the ALIAS CHAIN instead: the
    // checker's ultimate target declaration lives inside the builtin's
    // ambient `declare module "<name>"` in a declaration file — the same
    // home a direct import of the builtin resolves to, so the binding
    // keys the same tables under the builtin's own member name.
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const target = L.checker.getAliasedSymbol(symbol);
      const tdecl = L.checker.declarationsOf(target)[0];
      if (tdecl !== undefined && tdecl.getSourceFile().isDeclarationFile) {
        for (let p: ts.Node | undefined = tdecl.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
          if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name)) {
            const module = canonicalBuiltinModule(p.name.text);
            if (module !== null) return { module, member: target.name };
            break;
          }
        }
      }
    }
    return null;
  }

/** True for `const <name> = require("<builtin>").<member>` — the
   * member-binding require import builtinImportOf resolves. Both
   * declaration walks (lowerVarDecl, collectGlobals) skip these: like a
   * named import, the binding is alias plumbing with no storage — call
   * sites lower through the module tables, value uses fence per site. */
  export function builtinMemberRequireDecl(nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    if (!ts.isIdentifier(nameNode) || !init) return false;
    if (!ts.isPropertyAccessExpression(init) || init.questionDotToken) return false;
    const spec = requireSpecOf(init.expression);
    return spec !== null && canonicalBuiltinModule(spec) !== null;
  }

/** The supported builtin module when `decl` destructures a builtin
   * NAMESPACE binding (`const crypto = require('crypto'); const {
   * createSign, sign: mySign } = crypto;` — test/common/crypto.js's
   * idiom; the `import * as ns` form rides the same resolution). Pure
   * alias plumbing: the bindings key the same tables as named imports
   * (builtinImportOf's alias hop), so no storage and no statement exist —
   * both declaration walks skip by this test. Plain identifier elements
   * and renames only: a rest element needs the namespace VALUE and a
   * default needs a missing-member probe — those keep the existing
   * namespace-as-value fence. The direct-require initializer answers null
   * here (its own arm already resolves it). */
  export function builtinNamespaceDestructureModuleOf(L: Lowerer, decl: ts.VariableDeclaration): string | null {
    if (decl.name === undefined || !ts.isObjectBindingPattern(decl.name) || decl.initializer === undefined) return null;
    // `const { join } = require("node:path")` through a createRequire
    // binding: the call IS the namespace — same table keying.
    let module: string | null = null;
    const init = stripTypeCasts(decl.initializer);
    if (ts.isCallExpression(init)) {
      const cr = createRequireSpecOf(L, init);
      module = cr !== null && cr.spec !== null ? canonicalBuiltinModule(cr.spec) : null;
    } else if (ts.isIdentifier(init)) {
      module = L.builtinNamespaceModuleOf(init);
    }
    if (module === null) return null;
    for (const el of decl.name.elements) {
      if (el.dotDotDotToken || el.initializer !== undefined || el.name === undefined || !ts.isIdentifier(el.name)) return null;
      if (el.propertyName !== undefined && !ts.isIdentifier(el.propertyName)) return null;
    }
    return module;
  }

/* ── node:module — createRequire's static erasure ─────────────────────
 * The config/version-reading pattern real CLIs ship:
 *   import { createRequire } from "node:module";
 *   const require = createRequire(import.meta.url);
 *   const pkg = require("../package.json");
 * A compiled program's module graph is fixed at build time, so the
 * indirection ERASES where the required specifier is a static string
 * literal naming something the compiler already handles: a builtin (the
 * binding is a namespace import in const clothing), a relative .json
 * document (the file bakes and parses like JSON.parse of its text), or
 * an installed npm package (the island's require-condition entry under
 * --dynamic). Dynamic specifiers and other targets fence by name. */

/** Strips the type-only wrappers the require pattern rides in typed
   * code (`require("node:os") as typeof import("node:os")` — the
   * fallback declarations answer `unknown`, so the cast IS the idiom),
   * plus parens, legacy assertions, and non-null suffixes. */
  export function stripTypeCasts(e: ts.Expression): ts.Expression {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) ||
      ts.isTypeAssertion(cur) || ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    }
    return cur;
  }

/** The `createRequire(<base>)` call over the node:module import binding
   * with a supported base — import.meta.url, import.meta.filename, or
   * __filename, every spelling of "this file" — or null. The base never
   * LOWERS (import.meta has no value representation): it only names the
   * file whose directory anchors the returned require's relative
   * resolution, and every supported spelling names the call's own file. */
  export function createRequireBaseCallOf(L: Lowerer, expr: ts.Expression): ts.CallExpression | null {
    const e = stripTypeCasts(expr);
    if (!ts.isCallExpression(e) || e.questionDotToken) return null;
    if (!ts.isIdentifier(e.expression)) return null;
    const bi = builtinImportOf(L, e.expression);
    if (!bi || bi.module !== "module" || bi.member !== "createRequire") return null;
    if (e.arguments.length !== 1) return null;
    const base = stripTypeCasts(e.arguments[0]!);
    if (ts.isIdentifier(base) && base.text === "__filename") return e;
    if (
      ts.isPropertyAccessExpression(base) &&
      !base.questionDotToken &&
      ts.isMetaProperty(base.expression) &&
      base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      (base.name.text === "url" || base.name.text === "filename")
    ) {
      return e;
    }
    return null;
  }

/** True for `const require = createRequire(import.meta.url)` — the
   * binding is compile-time plumbing (each call through it resolves per
   * site) with no storage and no code; both declaration walks skip by
   * this test. A reassignable (let/var) binding never matches — callers
   * gate on constness like the other alias decls. */
  export function createRequireBindingDecl(L: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    if (!ts.isIdentifier(nameNode) || init === undefined) return false;
    return createRequireBaseCallOf(L, init) !== null;
  }

/** The declaring source file when `callee` denotes a createRequire-made
   * require: a CONST binding over createRequire(import.meta.url) (the
   * binding's own file anchors resolution) or the inline
   * `createRequire(import.meta.url)(...)` spelling (the call's file).
   * Null off the pattern, so call chains keep trying. */
  export function createRequireCalleeFileOf(L: Lowerer, callee: ts.Expression): ts.SourceFile | null {
    const e = stripTypeCasts(callee);
    if (ts.isCallExpression(e)) {
      return createRequireBaseCallOf(L, e) !== null ? e.getSourceFile() : null;
    }
    if (!ts.isIdentifier(e)) return null;
    const symbol = L.checker.getSymbolAtLocation(e);
    const decl = symbol ? L.checker.declarationsOf(symbol)[0] : undefined;
    if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
    if (!ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0) return null;
    return createRequireBaseCallOf(L, decl.initializer) !== null ? decl.getSourceFile() : null;
  }

/** The static require of `R("spec")` through a createRequire binding:
   * the literal specifier plus the file anchoring relative resolution.
   * Null when the callee is not a createRequire-made require; a matching
   * callee with a non-literal (or missing) specifier answers spec null,
   * so the call lowering fences by name instead of falling through to
   * the generic call paths. */
  export function createRequireSpecOf(
    L: Lowerer,
    call: ts.CallExpression,
  ): { spec: string | null; baseFile: ts.SourceFile } | null {
    if (call.questionDotToken) return null;
    const baseFile = createRequireCalleeFileOf(L, call.expression);
    if (baseFile === null) return null;
    if (call.arguments.length !== 1) return { spec: null, baseFile };
    const a = call.arguments[0]!;
    return { spec: ts.isStringLiteralLike(a) ? a.text : null, baseFile };
  }

/** True for `const fs = require("node:fs")` through a createRequire
   * binding — a builtin namespace import in const clothing: alias
   * plumbing with no storage (uses resolve through
   * builtinNamespaceModuleOf's createRequire arm); both declaration
   * walks skip by this test. */
  export function createRequireNamespaceDecl(L: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    if (!ts.isIdentifier(nameNode) || init === undefined) return false;
    const call = stripTypeCasts(init);
    if (!ts.isCallExpression(call)) return false;
    const cr = createRequireSpecOf(L, call);
    return cr !== null && cr.spec !== null && canonicalBuiltinModule(cr.spec) !== null;
  }

/** `require("spec")` through a createRequire binding — the erasure per
   * target. Builtins are reached here only OUTSIDE the const-namespace-
   * binding shape (that declaration erases; member uses resolve through
   * the namespace tables) and fence toward it. A relative .json document
   * bakes: the file's text validates as JSON at compile time and the
   * call lowers to json.parse over the baked literal — JSON.parse's
   * checked-dynamic `unknown` stance, and exactly Node's value (require
   * of JSON IS JSON.parse of the file; the per-call re-parse forgoes
   * Node's module-cache identity, unobservable without mutation). A bare
   * specifier NOTHING installed resolves compiles to Node's catchable
   * MODULE_NOT_FOUND throw (the optional-dependency try/require
   * pattern); an installed package loads through the island's
   * require-condition entry under --dynamic (collectCreateRequires
   * embedded it) and reports the requires-dynamic diagnostic in a static
   * build. Null when the callee is not a createRequire require. */
  export function lowerCreateRequireCall(L: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr | null {
    const cr = createRequireSpecOf(L, call);
    if (cr === null) return null;
    if (cr.spec === null) {
      L.noLowering(
        "createRequire's require with this argument shape",
        call,
        "the compiled module graph is fixed at build time — the one lowered form is require(\"<static string literal>\")",
      );
    }
    const spec = cr.spec;
    if (canonicalBuiltinModule(spec) !== null) {
      L.unsupported(
        "SC1090",
        call,
        `module namespace objects as values (bind it first: const m = require("${spec}"), then access members through the binding)`,
      );
    }
    if (spec.startsWith("#")) {
      L.noLowering(
        `createRequire's require of the '${spec}' project import`,
        call,
        "imports-field specifiers have no require lowering yet — import the target statically",
      );
    }
    if (isRelativeSpecifier(spec) || spec.startsWith("/")) {
      if (!spec.endsWith(".json")) {
        L.noLowering(
          `createRequire's require of '${spec}'`,
          call,
          "relative requires lower for .json documents only — a program module is a static import",
        );
      }
      const abs = spec.startsWith("/")
        ? spec
        : resolve(dirname(cr.baseFile.fileName), spec);
      const text = trackedReadFile(abs);
      if (text === null) {
        L.noLowering(
          `createRequire's require of '${spec}' (no file at ${abs})`,
          call,
          "the required document resolves at build time — check the path against the requiring file",
        );
      }
      try {
        JSON.parse(text);
      } catch (e) {
        L.pushDiag(invalidJsonModuleDiag(abs, e instanceof Error ? e.message : String(e), loc));
        throw new PoisonError();
      }
      return {
        kind: "libCall",
        fn: "json.parse",
        args: [{ kind: "strLit", value: text, type: STRING, loc }],
        type: DYN,
        loc,
      };
    }
    // Bare package specifiers. --npm-static opt-ins are program modules —
    // their exports bind through static imports, not a require value.
    const pkgName = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : spec.split("/")[0]!;
    if (isNpmStaticPackage(pkgName)) {
      L.noLowering(
        `createRequire's require of the --npm-static package '${pkgName}'`,
        call,
        "the opted-in package compiles as program modules — import it statically",
      );
    }
    const refusal = probeNodeRequireRefusal(cr.baseFile.fileName, spec);
    if (refusal !== null) {
      // Node's require-site MODULE_NOT_FOUND, catchable — the compiled
      // expression IS that throw (the typed dummy is abandoned by the
      // pending check's unwind).
      return nodeThrowExpr(0, "MODULE_NOT_FOUND", refusal.message, DYN, loc);
    }
    if (!L.dynamic) {
      L.pushDiag(requiresDynamicImportDiag(pkgName, loc));
      throw new PoisonError();
    }
    const res = L.createRequireImports.get(`${cr.baseFile.fileName}\u0000${spec}`);
    if (res === undefined) {
      // Collection never saw the site (a shape this walk and that walk
      // disagree on) — fence rather than mis-embed.
      L.noLowering(`createRequire's require of '${spec}'`, call, undefined);
    }
    if (res === "") throw new PoisonError(); // reported at collection
    // A CJS facade's default IS module.exports (Node's require answer);
    // an ESM-resolved entry answers its namespace (Node's require(esm)).
    const exportName = res.format === "esm" ? "*" : "default";
    return {
      kind: "libCall",
      fn: "island.import",
      args: [
        { kind: "strLit", value: res.entryKey, type: STRING, loc },
        { kind: "strLit", value: exportName, type: STRING, loc },
        { kind: "strLit", value: spec, type: STRING, loc },
      ],
      type: JSVAL,
      loc,
    };
  }

/** The builtin modules whose `constants` object bakes as literals at
   * every access site (the fs.constants precedent, scaled up): http2's
   * full Node v24 table, and crypto's OpenSSL-constant table. The object
   * itself never materializes at runtime. */
  const BUILTIN_CONSTANTS_TABLES: Record<string, { table: Record<string, number | string>; hint: string } | undefined> = {
    http2: {
      table: HTTP2_CONSTANTS,
      hint: "the table bakes Node v24's 240 members as literals — this name is not one of them",
    },
    crypto: {
      table: CRYPTO_CONSTANTS,
      hint: "the table bakes Node v24's crypto.constants members as literals — this name is not one of them",
    },
  };

/** The module whose baked-constants OBJECT `node` denotes, or null — any
   * of the spellings: `http2.constants`/`crypto.constants` through a
   * namespace/require binding, a destructured or member-bound `constants`
   * alias from the module, or `require("http2").constants` inline. The
   * object itself never materializes; each member read bakes as its
   * literal. */
  export function builtinConstantsModuleOf(L: Lowerer, node: ts.Expression): string | null {
    let module: string | null = null;
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
      if (node.name.text !== "constants") return null;
      const bi = L.builtinMemberOf(node);
      if (bi) module = bi.module;
      else {
        const spec = requireSpecOf(node.expression);
        module = spec !== null ? canonicalBuiltinModule(spec) : null;
      }
    } else if (ts.isIdentifier(node)) {
      const bi = builtinImportOf(L, node);
      if (bi !== null && bi.member === "constants") module = bi.module;
    }
    return module !== null && own(BUILTIN_CONSTANTS_TABLES, module) !== undefined ? module : null;
  }

/** `constants.NGHTTP2_CANCEL` / `constants.SSL_OP_NO_TICKET` (any baked-
   * constants spelling) → the literal; unknown members fence by name.
   * Null when the receiver is not a baked constants object (the property
   * chain keeps trying). */
  export function lowerBuiltinConstantsProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    const module = builtinConstantsModuleOf(L, expr.expression);
    if (module === null) return null;
    const entry = BUILTIN_CONSTANTS_TABLES[module]!;
    const value = own(entry.table, expr.name.text);
    if (value === undefined) {
      L.noLowering(`${module}.constants.${expr.name.text}`, expr, entry.hint);
    }
    return builtinConstLit(value, locOf(expr));
  }

/** True for any spelling of node:perf_hooks' `performance` object — the
   * named import binding, a namespace/default-import member, the require
   * twins (all through the shared builtin tables), or the GLOBAL Node
   * exposes without any import (the module export and the global are one
   * value; provenance-checked like console/process, so the bare
   * identifier and the globalThis.performance member both land here and
   * a user's own `performance` binding never does). */
  export function isPerfHooksPerformanceExpr(L: Lowerer, node: ts.Expression): boolean {
    if (L.isStdlibGlobal(node, "performance")) return true;
    if (ts.isIdentifier(node)) {
      const bi = builtinImportOf(L, node);
      return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
    }
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
      const bi = L.builtinMemberOf(node);
      return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
    }
    return false;
  }

/** The node:perf_hooks spoke: `performance.now()` reads the runtime's
   * monotonic clock anchored at process start — Node's timeOrigin for a
   * compiled program, fractional milliseconds — and
   * `performance.now.bind(performance)` (the mockable-clock idiom's
   * getTimestamp) is the same clock as a plain () => number function
   * value. Other members on the performance object fence by name; null
   * for non-perf_hooks callees (the call chain keeps trying). */
  export function lowerPerfHooksCall(L: Lowerer, expr: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    if (access.questionDotToken) return null;
    const loc = locOf(expr);
    if (access.name.text === "now" && isPerfHooksPerformanceExpr(L, access.expression)) {
      if (expr.arguments.length !== 0) {
        L.noLowering("performance.now with arguments", expr, "Node's performance.now takes none");
      }
      return { kind: "libCall", fn: "perf.now", args: [], type: F64, loc };
    }
    if (
      access.name.text === "bind" &&
      ts.isPropertyAccessExpression(access.expression) &&
      !access.expression.questionDotToken &&
      access.expression.name.text === "now" &&
      isPerfHooksPerformanceExpr(L, access.expression.expression)
    ) {
      if (expr.arguments.length !== 1 || !isPerfHooksPerformanceExpr(L, expr.arguments[0]!)) {
        L.noLowering(
          "this performance.now.bind form",
          expr,
          "performance.now.bind(performance) is the lowered function-value spelling",
        );
      }
      return {
        kind: "closure",
        fnName: perfNowFnValueOf(L),
        captures: [],
        type: funcOf([], F64),
        loc,
      };
    }
    if (isPerfHooksPerformanceExpr(L, access.expression)) {
      L.noLowering(
        `perf_hooks performance.${access.name.text}`,
        expr,
        "performance.now() — and its .bind(performance) function value — is the lowered surface",
      );
    }
    return null;
  }

/** The memoized () => number lifted wrapper behind
   * performance.now.bind(performance): a plain function value over the
   * same perf.now libCall. */
  function perfNowFnValueOf(L: Lowerer): string {
    const name = "%perf.now.value";
    if (!L.liftedFns.some((f) => f.name === name)) {
      const loc: SrcLoc = { file: "<builtin>", start: 0, end: 0 };
      L.liftedFns.push({
        name,
        params: [],
        returnType: F64,
        locals: [],
        body: [{ kind: "return", value: { kind: "libCall", fn: "perf.now", args: [], type: F64, loc }, loc }],
        loc,
      });
    }
    return name;
  }

/** True for `const { NGHTTP2_CANCEL, ... } = http2.constants` (and the
   * crypto.constants twin) — a plain object destructure (identifier
   * elements, renames allowed, no rest/defaults/nesting) over a baked
   * constants object whose every name is in its table. The declaration is
   * alias plumbing with no storage (lowerVarDecl and collectGlobals both
   * skip it); each USE reads its baked literal
   * (builtinConstantBindingOf). */
  export function builtinConstantsDestructureDecl(L: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    if (!ts.isObjectBindingPattern(nameNode) || !init) return false;
    const module = builtinConstantsModuleOf(L, init);
    if (module === null) return false;
    const table = BUILTIN_CONSTANTS_TABLES[module]!.table;
    return nameNode.elements.every(
      (el) =>
        !el.dotDotDotToken &&
        el.initializer === undefined &&
        el.name !== undefined &&
        ts.isIdentifier(el.name) &&
        (el.propertyName === undefined || ts.isIdentifier(el.propertyName)) &&
        own(table, ((el.propertyName as ts.Identifier | undefined) ?? (el.name as ts.Identifier)).text) !== undefined,
    );
  }

/** Resolves an identifier bound by a builtinConstantsDestructureDecl to
   * its baked literal value. Null for every other binding. */
  export function builtinConstantBindingOf(L: Lowerer, ident: ts.Identifier): IrExpr | null {
    const symbol = L.checker.getSymbolAtLocation(ident);
    const decl = symbol ? L.checker.declarationsOf(symbol)[0] : undefined;
    if (!decl || !ts.isBindingElement(decl) || decl.dotDotDotToken || decl.initializer) return null;
    if (!ts.isObjectBindingPattern(decl.parent)) return null;
    const varDecl = decl.parent.parent;
    if (!ts.isVariableDeclaration(varDecl) || varDecl.initializer === undefined) return null;
    const module = builtinConstantsModuleOf(L, varDecl.initializer);
    if (module === null) return null;
    const key = decl.propertyName && ts.isIdentifier(decl.propertyName)
      ? decl.propertyName.text
      : decl.name !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : null;
    if (key === null) return null;
    const value = own(BUILTIN_CONSTANTS_TABLES[module]!.table, key);
    if (value === undefined) return null;
    return builtinConstLit(value, locOf(ident));
  }

/** The literal `{ flag: true/false }` options shape: every property a
 * plain assignment with an identifier name from `allowed` and a boolean
 * LITERAL value (nothing to evaluate, so folding it away preserves JS
 * semantics exactly). Null for anything else — spreads, computed keys,
 * non-literal values, unknown flags. */
/** An options object literal split into literal-boolean flags (`allowed` —
 * these change WHICH lowering fires, so they must be spelled true/false)
 * and expression-valued members (`exprKeys` — number options like
 * maxRetries, lowered by the caller as ordinary expressions). Null when
 * any other member appears. */
function literalBoolOptions(
  L: Lowerer,
  node: ts.Expression,
  allowed: string[],
  exprKeys: string[] = [],
): { bools: Record<string, boolean>; exprs: Record<string, ts.Expression> } | null {
  void L;
  if (!ts.isObjectLiteralExpression(node)) return null;
  const bools: Record<string, boolean> = {};
  const exprs: Record<string, ts.Expression> = {};
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return null;
    if (exprKeys.includes(p.name.text)) {
      exprs[p.name.text] = p.initializer;
      continue;
    }
    if (!allowed.includes(p.name.text)) return null;
    if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) bools[p.name.text] = true;
    else if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) bools[p.name.text] = false;
    else return null;
  }
  return { bools, exprs };
}

/** One member of an options object literal: a plain `name: value`
 * assignment, or the shorthand `{ cwd }` — whose value IS the named
 * binding (the identifier lowers like any other read). Null for spreads,
 * computed keys, and accessors, which the callers fence. */
function optionMember(p: ts.ObjectLiteralElementLike): { name: string; value: ts.Expression } | null {
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
    return { name: p.name.text, value: p.initializer };
  }
  if (ts.isShorthandPropertyAssignment(p)) {
    const shName = p.name as ts.Identifier; // shorthand names are identifiers
    return { name: shName.text, value: shName };
  }
  return null;
}

/** One builtin-module function call → its libCall. Completes the call to
   * the table's exact shape: variadicPack functions (path.join/resolve)
   * accept any arity — or ONE spread of a string[] — and pack the
   * arguments into a single array-literal argument; `defaults` complete
   * omitted trailing arguments. fs.readFileSync keeps its historical
   * per-site checks (the encoding must be the literal "utf8"). */
  /** fs._toUnixTimestamp — the (underscore-stable) seconds coercion the
   * utimes family runs on its time arguments: finite numbers pass
   * (negatives answer now/1000, Node's shape), numeric STRINGS coerce
   * through ToNumber's loose-equality gate, everything else throws
   * Node's exact ERR_INVALID_ARG_TYPE. The argument crosses as a dyn
   * value so the runtime renders the Received tail. Null when this is
   * not that call (the table fence stays for other shapes). */
  export function lowerFsToUnixTimestampCall(L: Lowerer, expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    if (bi.module !== "fs" || bi.member !== "_toUnixTimestamp") return null;
    if (expr.arguments.length !== 1 || ts.isSpreadElement(expr.arguments[0]!)) return null;
    const raw = L.lowerExpr(expr.arguments[0]!);
    if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
      const arg: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
      return { kind: "libCall", fn: "fs.toUnixTimestamp", args: [arg], type: F64, loc };
    }
    return null;
  }

  /** The fs validation-ladder spoke (checked-dynamic lane, JS sources
   * only — TypeScript keeps its compile fences): implemented-namespace
   * calls whose misuse Node rejects with typed errors lower to fs.*Chk
   * libCalls that replicate the validation ladder over dyn values and
   * throw Node's exact ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE /
   * ERR_OUT_OF_RANGE — the honest tail (the real operation where one
   * exists, the compiler-rendered SC2020 fence otherwise) runs only
   * after every validation passes, exactly Node's order. Null when this
   * is not a claimed member/shape (the table or fence path stands). */
  export function lowerFsLadderCall(L: Lowerer, expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    if (bi.module !== "fs" && bi.module !== "fs/promises") return null;
    if (!isJsSourceFile(expr.getSourceFile())) return null;
    const args = expr.arguments;
    if (args.some(ts.isSpreadElement)) return null;
    // Every ladder argument crosses as a dyn value; an argument that
    // cannot leaves the historical fence in place.
    const dynArg = (node: ts.Expression | undefined): IrExpr | null => {
      if (!node) return dynUndefinedExpr(loc);
      const raw = L.lowerExpr(node);
      if (raw.type.kind === "dyn") return raw;
      if (raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
        return { kind: "dynFrom", value: raw, type: DYN, loc };
      }
      return null;
    };
    const dynArgs = (nodes: (ts.Expression | undefined)[]): IrExpr[] | null => {
      const out: IrExpr[] = [];
      for (const n of nodes) {
        const v = dynArg(n);
        if (v === null) return null;
        out.push(v);
      }
      return out;
    };
    const resultT = L.mapTypeOf(L.typeOf(expr)) ?? DYN;
    const chk = (fn: IrLibFn, chkArgs: IrExpr[], type: IrType): IrExpr =>
      ({ kind: "libCall", fn, args: chkArgs, type, loc });
    if (bi.module === "fs/promises") {
      if (bi.member !== "lchmod" || args.length !== 2) return null;
      const a = dynArgs([args[0], args[1]]);
      return a && chk("fsp.lchmodChk", a, { kind: "promise", inner: VOID });
    }
    switch (bi.member) {
      case "exists": {
        // The REAL deprecated-API shape: the callback validates
        // synchronously (Node's one throwing arm), invalid paths answer
        // false THROUGH it, and the answer is asynchronous.
        // A provably-non-file `new URL('<literal>')` path (the suite's
        // https://foo probe): Node answers false through the callback
        // synchronously — the checked-dynamic tree has no URL kind, so the path slot
        // carries the unvalidatable token instead (construction of a
        // parseable literal is effect-free; file: URLs keep the fence —
        // they would need the real path conversion).
        let pathNode: ts.Expression | undefined = args[0];
        let pathExpr: IrExpr | null = null;
        if (pathNode && ts.isNewExpression(pathNode) && ts.isIdentifier(pathNode.expression) &&
            pathNode.expression.text === "URL" && L.mapTypeOf(L.typeOf(pathNode))?.kind === "url" &&
            pathNode.arguments?.length === 1 && ts.isStringLiteral(pathNode.arguments[0]!)) {
          let parsed: URL | null = null;
          try {
            parsed = new URL(pathNode.arguments[0]!.text);
          } catch {
            parsed = null;
          }
          if (parsed === null || parsed.protocol === "file:") return null;
          pathExpr = dynUndefinedExpr(loc);
          pathNode = undefined;
        }
        pathExpr ??= dynArg(pathNode);
        const cbExpr = dynArg(args[1]);
        if (pathExpr === null || cbExpr === null) return null;
        return chk("fs.existsChk", [pathExpr, cbExpr], DYN);
      }
      case "mkdtemp": {
        // mkdtemp(prefix[, options], callback) — the callback is the
        // LAST argument (makeCallback runs first, then the prefix).
        const a = dynArgs([args[0], args.length >= 2 ? args[args.length - 1] : undefined]);
        return a && chk("fs.mkdtempChk", [...a, ladderFenceExpr(L, "fs.mkdtemp", expr)], resultT);
      }
      case "mkdtempSync": {
        // The table serves the plain string 1-arg form; the ladder takes
        // every other shape — prefix/encoding validation, then the REAL
        // mkdtemp when the options leave utf8 semantics.
        if (args.length === 1 && L.mapTypeOf(L.typeOf(args[0]!))?.kind === "string") return null;
        if (args.length > 2) return null;
        const a = dynArgs([args[0], args[1]]);
        return a && chk("fs.mkdtempSyncChk", [...a, ladderFenceExpr(L, "fs.mkdtempSync with these options", expr)], STRING);
      }
      case "readFile": {
        // readFile(path[, options], callback): callback, assertEncoding,
        // path — then the async read fences.
        const a = dynArgs([args[0], args.length >= 3 ? args[1] : undefined, args.length >= 2 ? args[args.length - 1] : undefined]);
        return a && chk("fs.readFileChk", [...a, ladderFenceExpr(L, "fs.readFile", expr)], resultT);
      }
      case "opendirSync": {
        const a = dynArgs([args[0], args[1]]);
        return a && chk("fs.opendirChk", [...a, ladderFenceExpr(L, "fs.opendirSync", expr)], resultT);
      }
      case "watchFile": {
        // watchFile(filename[, options], listener): the path first, the
        // listener's function contract second; real watching fences.
        const a = dynArgs([args[0], args.length >= 2 ? args[args.length - 1] : undefined]);
        return a && chk("fs.watchFileChk", [...a, ladderFenceExpr(L, "fs.watchFile", expr)], resultT);
      }
      case "lchmod": {
        // lchmod(path, mode, callback): callback, path, mode — macOS
        // shapes (non-APPLE answers Node's not-a-function TypeError).
        const a = dynArgs([args[0], args[1], args[2]]);
        return a && chk("fs.lchmodChk", [...a, ladderFenceExpr(L, "fs.lchmod", expr)], resultT);
      }
      case "lchmodSync": {
        if (args.length > 2) return null;
        const a = dynArgs([args[0], args[1]]);
        return a && chk("fs.lchmodSyncChk", a, DYN);
      }
      case "read": {
        // read(fd, buffer, offset, length, position, callback) — the
        // positional form's full ladder; options-object forms keep the
        // fence (their misuse arms are not in the target set).
        if (args.length < 4) return null;
        const a = dynArgs([args[0], args[1], args[2], args[3], args.length >= 6 ? args[4] : undefined]);
        return a && chk("fs.readChk", [...a, ladderFenceExpr(L, "fs.read", expr)], resultT);
      }
      case "createReadStream":
      case "createWriteStream": {
        const a = dynArgs([args[0], args[1]]);
        return a && chk("fs.streamOptsChk", [...a, ladderFenceExpr(L, `fs.${bi.member}`, expr)], resultT);
      }
      default:
        return null;
    }
  }

  export function lowerBuiltinModuleCall(L: Lowerer, expr: ts.CallExpression,
    bi: { module: string; member: string },
    fn: BuiltinModuleFn,
    loc: SrcLoc,): IrExpr {
    const name = expr.expression.getText();
    if (bi.module === "child_process" && bi.member === "spawnSync") {
      return L.lowerSpawnSyncCall(expr, loc);
    }
    if (bi.module === "child_process" && bi.member === "spawn") {
      return L.lowerSpawnCall(expr, loc);
    }
    if (bi.module === "fs" && bi.member === "watch") {
      return lowerFsWatchCall(L, expr, loc);
    }
    // fs/promises.open(path[, flags[, mode]]) — string flags and numeric
    // creation mode, with Node's "r"/0o666 defaults. The runtime wraps
    // the descriptor in a shared FileHandle and settles/rejects exactly
    // like the existing fs/promises operations.
    if (bi.module === "fs/promises" && bi.member === "open") {
      if (expr.arguments.length < 1 || expr.arguments.length > 3 || expr.arguments.some(ts.isSpreadElement)) {
        L.noLowering(
          `fs.promises.open with ${expr.arguments.length} arguments`,
          expr,
          "use open(path[, stringFlags[, numericMode]])",
        );
      }
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const defaultFlags = { kind: "strLit", value: "r", type: STRING, loc } satisfies IrExpr;
      const defaultMode = { kind: "numLit", value: 0o666, type: F64, loc } satisfies IrExpr;
      const flags = expr.arguments[1]
        ? lowerBuiltinOptionalDefault(L, expr.arguments[1]!, STRING, defaultFlags)
        : defaultFlags;
      const mode = expr.arguments[2]
        ? lowerBuiltinOptionalDefault(L, expr.arguments[2]!, F64, defaultMode)
        : defaultMode;
      return {
        kind: "libCall",
        fn: "fsp.open",
        args: [path, flags, mode],
        type: { kind: "promise", inner: FILEHANDLE_T },
        loc,
      };
    }
    // fs.rename(oldPath, newPath, callback): the callback is a
    // program-shaped closure (zero parameters are valid; the ordinary
    // form receives NodeJS.ErrnoException | null). Keep it typed here so
    // the backends can emit the same union-building adapter used by
    // dns.lookup instead of losing the Error arm through a dyn boundary.
    if (bi.module === "fs" && bi.member === "rename") {
      if (expr.arguments.length !== 3 || expr.arguments.some(ts.isSpreadElement)) {
        L.noLowering(
          `rename with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
          expr,
          "the supported form is rename(oldPath, newPath, callback)",
        );
      }
      const oldPath = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const newPath = L.lowerExprExpecting(expr.arguments[1]!, STRING);
      let callback = L.lowerExpr(expr.arguments[2]!);
      // JS/checkJs callback values may arrive as checked-dynamic callables.
      // Adapt them to the one error-first slot; the runtime passes a dyn
      // Error on failure and null on success through the emitted thunk.
      if (callback.type.kind === "dyn") {
        callback = {
          kind: "dynCheck",
          value: callback,
          type: funcOf([DYN], VOID),
          loc: locOf(expr.arguments[2]!),
        };
      }
      let callbackOk = callback.type.kind === "func" && callback.type.params.length <= 1;
      if (callbackOk && callback.type.kind === "func" && callback.type.params.length === 1) {
        const param = callback.type.params[0]!;
        if (param.kind === "dyn") {
          callbackOk = true;
        } else if (param.kind === "union") {
          const def = L.unions.get(param.unionId);
          callbackOk = !!def &&
            def.arms.some((a) => a.kind === "nullT") &&
            def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
            def.arms.every((a) =>
              a.kind === "nullT" || a.kind === "undefinedT" ||
              (a.kind === "object" && a.className === "%Error"));
        } else {
          callbackOk = false;
        }
      }
      if (!callbackOk) {
        L.unsupported(
          "SC1090",
          expr.arguments[2]!,
          "fs.rename callbacks must accept at most one Error | null parameter",
        );
      }
      // TypeScript deliberately permits a value-returning function where a
      // void callback is expected; Node ignores that value. Normalize the
      // closure to the runtime's void callback ABI after validating its
      // error-first parameter shape.
      callback = voidizedCallback(L, callback, locOf(expr.arguments[2]!));
      return { kind: "libCall", fn: "fs.renameCb", args: [oldPath, newPath, callback], type: VOID, loc };
    }
    // fs.readSync(fd, buffer, offset, length[, position]) — normalize the
    // current-offset forms to Node/libuv's -1 sentinel so the IR and native
    // ABI stay fixed-width. A real numeric position is a positioned read
    // and therefore must not advance the descriptor. Literal null is the
    // documented current-offset spelling; richer nullable expressions must
    // narrow first so no effectful evaluation is silently discarded.
    if (bi.module === "fs" && bi.member === "readSync") {
      const supported =
        "use readSync(fd, buffer, offset, length[, position]) with a numeric position or literal null; options objects and bigint positions have no lowering";
      if (
        (expr.arguments.length !== 4 && expr.arguments.length !== 5) ||
        expr.arguments.some(ts.isSpreadElement)
      ) {
        L.noLowering(
          `readSync with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
          expr,
          supported,
        );
      }
      const args: IrExpr[] = [
        L.lowerExprExpecting(expr.arguments[0]!, F64),
        L.lowerExprExpecting(expr.arguments[1]!, BYTES_U8),
        L.lowerExprExpecting(expr.arguments[2]!, F64),
        L.lowerExprExpecting(expr.arguments[3]!, F64),
      ];
      const positionNode = expr.arguments[4];
      let positionValueNode = positionNode;
      while (positionValueNode && ts.isParenthesizedExpression(positionValueNode)) {
        positionValueNode = positionValueNode.expression;
      }
      if (positionNode === undefined || positionValueNode!.kind === ts.SyntaxKind.NullKeyword) {
        args.push({ kind: "numLit", value: -1, type: F64, loc });
      } else {
        const positionType = L.mapTypeOf(L.typeOf(positionNode));
        if (positionType?.kind !== "f64") {
          L.noLowering(
            `readSync with a '${positionType ? L.fmt(positionType) : L.checker.typeToString(L.typeOf(positionNode))}' position`,
            positionNode,
            supported,
          );
        }
        args.push(L.lowerExprExpecting(positionNode, F64));
      }
      return { kind: "libCall", fn: "fs.readSync", args, type: F64, loc };
    }
    // fs.writeSync has two static families. Buffer writes use the classic
    // (fd, buffer, offset, length[, position]) shape; string writes accept
    // (fd, string[, position[, "utf8"]]). The runtime uses -1 for the
    // current-offset forms. Node treats a negative, fractional, non-finite,
    // or over-MAX_SAFE numeric write position like null rather than throwing;
    // preserve the value here so the runtime can make that dispatch.
    if (bi.module === "fs" && bi.member === "writeSync") {
      const supported =
        'use writeSync(fd, buffer, offset, length[, position]) or writeSync(fd, string[, position[, "utf8"]]); options objects, bigint positions, and other encodings have no lowering';
      if (expr.arguments.some(ts.isSpreadElement) || expr.arguments.length < 2) {
        L.noLowering(
          `writeSync with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
          expr,
          supported,
        );
      }
      const dataNode = expr.arguments[1]!;
      const dataType = L.mapTypeOf(L.typeOf(dataNode));
      const fd = L.lowerExprExpecting(expr.arguments[0]!, F64);
      const position = (node: ts.Expression | undefined): IrExpr => {
        let valueNode = node;
        while (valueNode && ts.isParenthesizedExpression(valueNode)) valueNode = valueNode.expression;
        if (node === undefined || valueNode!.kind === ts.SyntaxKind.NullKeyword) {
          return { kind: "numLit", value: -1, type: F64, loc };
        }
        const t = L.mapTypeOf(L.typeOf(node));
        if (t?.kind !== "f64") {
          L.noLowering(
            `writeSync with a '${t ? L.fmt(t) : L.checker.typeToString(L.typeOf(node))}' position`,
            node,
            supported,
          );
        }
        return L.lowerExprExpecting(node, F64);
      };
      if (dataType?.kind === "bytes") {
        if (dataType.elem !== "u8") {
          L.noLowering(
            `writeSync of '${L.fmt(dataType)}' data`,
            dataNode,
            "byte writes take Uint8Array/Buffer data",
          );
        }
        if (expr.arguments.length !== 4 && expr.arguments.length !== 5) {
          L.noLowering(
            `writeSync of Buffer data with ${expr.arguments.length} arguments`,
            expr,
            supported,
          );
        }
        return {
          kind: "libCall",
          fn: "fs.writeSync",
          args: [
            fd,
            L.lowerExprExpecting(dataNode, BYTES_U8),
            L.lowerExprExpecting(expr.arguments[2]!, F64),
            L.lowerExprExpecting(expr.arguments[3]!, F64),
            position(expr.arguments[4]),
          ],
          type: F64,
          loc,
        };
      }
      if (dataType?.kind === "string") {
        if (expr.arguments.length > 4) {
          L.noLowering(
            `writeSync of string data with ${expr.arguments.length} arguments`,
            expr,
            supported,
          );
        }
        const encNode = expr.arguments[3];
        let enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
        if (encNode !== undefined) {
          const encType = L.typeOf(encNode);
          if (!encType.isStringLiteralType() || (encType.value !== "utf8" && encType.value !== "utf-8")) {
            L.noLowering(
              "writeSync with a non-utf8 encoding",
              encNode,
              supported,
            );
          }
          // Even though utf8 is the runtime's only encoding, the argument
          // remains an ordinary JS argument: evaluate it in source order so
          // a call/getter whose type is the accepted literal cannot vanish.
          enc = L.lowerExprExpecting(encNode, STRING);
        }
        return {
          kind: "libCall",
          fn: "fs.writeStrSync",
          args: [fd, L.lowerExprExpecting(dataNode, STRING), position(expr.arguments[2]), enc],
          type: F64,
          loc,
        };
      }
      L.noLowering(
        `writeSync of '${dataType ? L.fmt(dataType) : L.checker.typeToString(L.typeOf(dataNode))}' data`,
        dataNode,
        supported,
      );
    }
    if (
      bi.module === "child_process" &&
      (bi.member === "execFileSync" || bi.member === "execSync")
    ) {
      return L.lowerExecSyncCall(expr, bi.member === "execSync", loc);
    }
    if (bi.module === "os" && bi.member === "networkInterfaces") {
      return lowerOsNetworkInterfacesCall(L, expr, loc);
    }
    // fs.readdirSync(path, { withFileTypes: true }) — the Dirent form:
    // routed BEFORE the 1-arg table completion. The options must be an
    // object literal with withFileTypes: true (encoding "utf8"/"utf-8" is
    // accepted as the default it is; recursive and encoding:'buffer'
    // fence), and the call site's mapped type must be the interned Dirent
    // record array (types.ts) — the userInfo verification stance.
    if (bi.module === "fs" && bi.member === "readdirSync" && expr.arguments.length === 2) {
      return lowerFsReaddirTypesCall(L, expr, loc);
    }
    if (bi.module === "os" && bi.member === "userInfo") {
      return lowerOsUserInfoCall(L, expr, loc);
    }
    // node:querystring — parse/stringify are entirely special-cased (the
    // sep/eq/options completions, parse's call-site-shaped dictionary
    // result, stringify's dyn-crossing object argument); decode/encode
    // are Node's own aliases of the pair (`const decode = parse` in the
    // module source) and take the same lowerings. escape/unescape ride
    // the generic table tail below.
    if (bi.module === "querystring") {
      if (bi.member === "parse" || bi.member === "decode") {
        return lowerQuerystringParseCall(L, expr, loc);
      }
      if (bi.member === "stringify" || bi.member === "encode") {
        return lowerQuerystringStringifyCall(L, expr, loc);
      }
    }
    // node:timers/promises — setTimeout([delay]) and setImmediate(): void
    // promises the shared timer heap settles. The omitted delay completes
    // to Node's 1ms floor (scr_timer_coerce_ms clamps anyway; the literal
    // keeps the emitted call self-describing); the resolve-value and
    // options (AbortSignal) forms fence per shape — a promise that
    // ignored its cancellation signal would hold the loop open where
    // Node exits.
    if (bi.module === "timers/promises") {
      const promiseVoid: IrType = { kind: "promise", inner: VOID };
      if (bi.member === "setTimeout") {
        if (expr.arguments.length > 1) {
          L.noLowering(
            "timers/promises setTimeout with a resolve value or options",
            expr.arguments[1]!,
            "the lowered form is setTimeout(delay?) resolving undefined — resolve values and AbortSignal cancellation have no lowering",
          );
        }
        const ms: IrExpr = expr.arguments[0]
          ? L.lowerExprExpecting(expr.arguments[0], F64)
          : { kind: "numLit", value: 1, type: F64, loc };
        return { kind: "libCall", fn: "tp.setTimeout", args: [ms], type: promiseVoid, loc };
      }
      if (bi.member === "setImmediate") {
        if (expr.arguments.length > 0) {
          L.noLowering(
            "timers/promises setImmediate with a resolve value",
            expr.arguments[0]!,
            "the lowered form is setImmediate() resolving undefined",
          );
        }
        return { kind: "libCall", fn: "tp.setImmediate", args: [], type: promiseVoid, loc };
      }
    }
    // node:diagnostics_channel — the module-level pub/sub surface. The
    // subscriber arguments box into the checked-dynamic tree (dyn) so JS harness wrappers
    // (test/common's mustCall — a rest-args function value) and typed
    // closures both cross; publish and the Channel methods lower in
    // lowerDcChannelMethodCall over the f64 channel handle.
    if (bi.module === "diagnostics_channel") {
      if (bi.member === "channel" && expr.arguments.length === 1) {
        const name = dcChannelNameArg(L, expr.arguments[0]!);
        return { kind: "libCall", fn: "dc.channel", args: [name], type: F64, loc };
      }
      if ((bi.member === "subscribe" || bi.member === "unsubscribe") && expr.arguments.length === 2) {
        const name = dcChannelNameArg(L, expr.arguments[0]!);
        const cb = dcSubscriberArg(L, expr.arguments[1]!);
        return bi.member === "subscribe"
          ? { kind: "libCall", fn: "dc.subscribe", args: [name, cb], type: VOID, loc }
          : { kind: "libCall", fn: "dc.unsubscribe", args: [name, cb], type: BOOL, loc };
      }
      if (bi.member === "hasSubscribers" && expr.arguments.length === 1) {
        const name = dcChannelNameArg(L, expr.arguments[0]!);
        return { kind: "libCall", fn: "dc.hasSubscribers", args: [name], type: BOOL, loc };
      }
      // tracingChannel: the string form interns the five tracing:<name>:*
      // channels; the collection form takes an object literal whose five
      // event members are Channel-typed values (Node's TracingChannelCollection).
      if (bi.member === "tracingChannel" && expr.arguments.length === 1) {
        const a = expr.arguments[0]!;
        if (ts.isObjectLiteralExpression(a)) {
          const byEvent = new Map<string, IrExpr>();
          for (const p of a.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) ||
                !(DC_TRACE_EVENTS as readonly string[]).includes(p.name.text)) {
              L.noLowering(
                "tracingChannel with this collection shape",
                p,
                "the supported collection form assigns each of start/end/asyncStart/asyncEnd/error a Channel value inline",
              );
            }
            byEvent.set(p.name.text, L.lowerExprExpecting(p.initializer, F64));
          }
          if (byEvent.size !== 5) {
            L.noLowering(
              "tracingChannel with a partial collection",
              a,
              "the supported collection form names all five event channels",
            );
          }
          return {
            kind: "libCall",
            fn: "dc.tracingChannelOf",
            args: DC_TRACE_EVENTS.map((ev) => byEvent.get(ev)!),
            type: F64,
            loc,
          };
        }
        const name = dcChannelNameArg(L, a);
        return { kind: "libCall", fn: "dc.tracingChannel", args: [name], type: F64, loc };
      }
    }
    // readline.createInterface({ input: process.stdin, output:
    // process.stdout }): exactly that options shape — the runtime reads
    // fd 0 and writes prompts to stdout, so any OTHER stream would be a
    // lie. `terminal` is accepted only as the literal false (the pipe
    // behavior this implements); other members fence by name.
    if (bi.module === "readline" && bi.member === "createInterface") {
      const optsNode = expr.arguments.length === 1 ? expr.arguments[0] : undefined;
      if (!optsNode || !ts.isObjectLiteralExpression(optsNode)) {
        L.noLowering(
          "createInterface with this argument shape",
          expr,
          "the supported form is createInterface({ input: process.stdin, output: process.stdout })",
        );
      }
      let sawInput = false;
      for (const p of optsNode.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
          L.noLowering(
            "createInterface with this options shape",
            p,
            "spreads, computed keys, and shorthand options have no lowering — write each member inline",
          );
        }
        const member = p.name.text;
        const streamOf = (node: ts.Expression): string | null =>
          ts.isPropertyAccessExpression(node) ? L.stdlibGlobalMember(node, "process") : null;
        if (member === "input") {
          if (streamOf(p.initializer) !== "stdin") {
            L.noLowering(
              "createInterface with a non-stdin input",
              p.initializer,
              "process.stdin is the one supported input stream",
            );
          }
          sawInput = true;
        } else if (member === "output") {
          if (streamOf(p.initializer) !== "stdout") {
            L.noLowering(
              "createInterface with a non-stdout output",
              p.initializer,
              "process.stdout is the one supported output stream",
            );
          }
        } else if (member === "terminal") {
          const t = L.typeOf(p.initializer);
          if (!(t.flags & ts.TypeFlags.BooleanLiteral) || L.checker.typeToString(t) !== "false") {
            L.noLowering(
              "createInterface with terminal enabled",
              p.initializer,
              "terminal line editing has no lowering — the pipe behavior is what compiles",
            );
          }
        } else if (member === "crlfDelay") {
          // Infinity states the lowered behavior: the splitter holds a
          // trailing \r until the next chunk decides \r\n vs \r, with no
          // time limit (scr_readline.c) — Node's crlfDelay: Infinity.
          // Finite delays would need a timer the splitter does not have.
          if (!ts.isIdentifier(p.initializer) || p.initializer.text !== "Infinity") {
            L.noLowering(
              "createInterface with a finite crlfDelay",
              p.initializer,
              "the lowered splitter always joins \\r\\n across chunks (Node's crlfDelay: Infinity) — Infinity is the accepted value",
            );
          }
        } else if (member === "completer") {
          L.noLowering(
            "createInterface with a completer",
            p,
            "tab completion needs an interactive terminal — the lowered interface reads piped lines (terminal: false)",
          );
        } else {
          fenceOrDropOptionKey(
            L, p, member, "createInterface", READLINE_DOCUMENTED_OPTIONS,
            "input, output, terminal: false, and crlfDelay: Infinity are the supported options",
          );
          // An undocumented key, dropped like Node drops it.
        }
      }
      if (!sawInput) {
        L.noLowering(
          "createInterface without an input stream",
          optsNode,
          "pass { input: process.stdin, output: process.stdout }",
        );
      }
      return { kind: "libCall", fn: "rl.create", args: [], type: F64, loc };
    }
    // The Buffer forms of fs: readFileSync(path)/readFile(path) with NO
    // encoding read raw bytes (Node returns a Buffer there), and
    // writeFileSync(path, data) with bytes-typed data writes them —
    // routed BEFORE the arity/type completion against the utf8 table
    // entries.
    if (
      bi.module === "fs" &&
      bi.member === "readFileSync" &&
      expr.arguments.length === 1 &&
      L.mapTypeOf(L.typeOf(expr.arguments[0]!))?.kind !== "f64"
    ) {
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      return { kind: "libCall", fn: "fs.readFileSyncBytes", args: [path], type: BYTES_U8, loc };
    }
    if (bi.module === "fs/promises" && bi.member === "readFile" && expr.arguments.length === 1) {
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      return {
        kind: "libCall",
        fn: "fsp.readFileBytes",
        args: [path],
        type: { kind: "promise", inner: BYTES_U8 },
        loc,
      };
    }
    // The readFileSync(fd[, "utf8"]) forms — Node accepts a file
    // descriptor where it accepts a path (the stdin pattern:
    // readFileSync(0, "utf8")). Routed by the ARGUMENT's static type,
    // like fileURLToPath; the encoding keeps the utf8-literal fence.
    if (
      bi.module === "fs" &&
      bi.member === "readFileSync" &&
      expr.arguments.length >= 1 &&
      L.mapTypeOf(L.typeOf(expr.arguments[0]!))?.kind === "f64"
    ) {
      const fd = L.lowerExprExpecting(expr.arguments[0]!, F64);
      if (expr.arguments.length === 1) {
        return { kind: "libCall", fn: "fs.readFdSyncBytes", args: [fd], type: BYTES_U8, loc };
      }
      const encT = L.typeOf(expr.arguments[1]!);
      if (
        expr.arguments.length !== 2 ||
        !(encT.isStringLiteralType() && (encT.value === "utf8" || encT.value === "utf-8"))
      ) {
        L.noLowering(
          `readFileSync(fd) with a non-"utf8" encoding`,
          expr.arguments[1] ?? expr,
          'only utf8 reads are supported: readFileSync(fd, "utf8")',
        );
      }
      const enc = L.lowerExprExpecting(expr.arguments[1]!, STRING);
      return { kind: "libCall", fn: "fs.readFdSync", args: [fd, enc], type: STRING, loc };
    }
    // mkdirSync(p, options): the lowered options form is a literal
    // `{ recursive?: <boolean literal>, mode?: <number> }` — recursive:
    // true routes to Node's recursive algorithm (the mode, when present,
    // applies to every directory the walk creates, like Node's), false/
    // absent is the plain mkdir. The recursive form's return value (the
    // first created directory, `string | undefined` under @types/node)
    // has no lowering — statement position only.
    if (bi.module === "fs" && bi.member === "mkdirSync" && expr.arguments.length === 2) {
      const optsNode = expr.arguments[1]!;
      let recursive = false;
      let modeNode: ts.Expression | null = null;
      let ok = ts.isObjectLiteralExpression(optsNode);
      if (ok) {
        for (const p of (optsNode as ts.ObjectLiteralExpression).properties) {
          const m = optionMember(p);
          if (!m) { ok = false; break; }
          if (m.name === "recursive") {
            if (m.value.kind === ts.SyntaxKind.TrueKeyword) recursive = true;
            else if (m.value.kind === ts.SyntaxKind.FalseKeyword) recursive = false;
            else { ok = false; break; }
          } else if (m.name === "mode") {
            modeNode = m.value;
          } else { ok = false; break; }
        }
      }
      if (!ok) {
        L.noLowering(
          "mkdirSync with an options argument beyond { recursive, mode }",
          optsNode,
          "the recursive flag must be a boolean literal and mode a number; other options have no lowering",
        );
      }
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const mode: IrExpr | null = modeNode ? L.lowerExprExpecting(modeNode, F64) : null;
      if (!recursive) {
        return mode
          ? { kind: "libCall", fn: "fs.mkdirModeSync", args: [path, mode], type: VOID, loc }
          : { kind: "libCall", fn: "fs.mkdirSync", args: [path], type: VOID, loc };
      }
      if (!ts.isExpressionStatement(expr.parent)) {
        L.noLowering(
          "mkdirSync's return value in the recursive form",
          expr,
          "the first-created-directory result has no lowering — call it as a statement",
        );
      }
      return mode
        ? { kind: "libCall", fn: "fs.mkdirRecursiveModeSync", args: [path, mode], type: VOID, loc }
        : { kind: "libCall", fn: "fs.mkdirRecursiveSync", args: [path], type: VOID, loc };
    }
    // fs.promises.mkdir(p, options): the mkdirSync matrix behind settled
    // promises — literal { recursive?: <boolean literal>, mode?: number }.
    // The recursive form's value (`string | undefined`) has no lowering;
    // `await` in statement position is the supported use.
    if (bi.module === "fs/promises" && bi.member === "mkdir" && expr.arguments.length === 2) {
      const optsNode = expr.arguments[1]!;
      let recursive = false;
      let modeNode: ts.Expression | null = null;
      let ok = ts.isObjectLiteralExpression(optsNode);
      if (ok) {
        for (const p of (optsNode as ts.ObjectLiteralExpression).properties) {
          const m = optionMember(p);
          if (!m) { ok = false; break; }
          if (m.name === "recursive") {
            if (m.value.kind === ts.SyntaxKind.TrueKeyword) recursive = true;
            else if (m.value.kind === ts.SyntaxKind.FalseKeyword) recursive = false;
            else { ok = false; break; }
          } else if (m.name === "mode") {
            modeNode = m.value;
          } else { ok = false; break; }
        }
      }
      if (!ok) {
        L.noLowering(
          "fs.promises.mkdir with an options argument beyond { recursive, mode }",
          optsNode,
          "the recursive flag must be a boolean literal and mode a number; other options have no lowering",
        );
      }
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const mode: IrExpr | null = modeNode ? L.lowerExprExpecting(modeNode, F64) : null;
      const type: IrType = { kind: "promise", inner: VOID };
      if (!recursive) {
        return mode
          ? { kind: "libCall", fn: "fsp.mkdirMode", args: [path, mode], type, loc }
          : { kind: "libCall", fn: "fsp.mkdir", args: [path], type, loc };
      }
      return mode
        ? { kind: "libCall", fn: "fsp.mkdirRecursiveMode", args: [path, mode], type, loc }
        : { kind: "libCall", fn: "fsp.mkdirRecursive", args: [path], type, loc };
    }
    // rmSync(p, options): literal { recursive?, force? } booleans — the
    // cleanup shape rmSync(dir, { recursive: true, force: true }) —
    // plus the maxRetries/retryDelay numbers (the tmpdir-harness shape
    // rmSync(p, { maxRetries: 3, recursive: true, force: true })): those
    // lower as ordinary number expressions into the retry libCall, whose
    // runtime implements Node's linear-backoff retry on
    // EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM. The retry-free shape keeps the
    // historical rmOptsSync byte for byte.
    if (bi.module === "fs" && bi.member === "rmSync" && expr.arguments.length === 2) {
      const opts = literalBoolOptions(L, expr.arguments[1]!, ["recursive", "force"], ["maxRetries", "retryDelay"]);
      if (opts === null) {
        L.noLowering(
          "rmSync with an options argument beyond { recursive, force, maxRetries, retryDelay }",
          expr.arguments[1]!,
          "the recursive/force flags must be boolean literals; maxRetries/retryDelay are numbers; other options have no lowering",
        );
      }
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const flag = (v: boolean): IrExpr => ({ kind: "boolLit", value: v, type: BOOL, loc });
      const recursive = flag(opts.bools["recursive"] === true);
      const force = flag(opts.bools["force"] === true);
      if (opts.exprs["maxRetries"] === undefined && opts.exprs["retryDelay"] === undefined) {
        return { kind: "libCall", fn: "fs.rmOptsSync", args: [path, recursive, force], type: VOID, loc };
      }
      // Node's defaults: maxRetries 0, retryDelay 100 (only reached when
      // at least one of the pair is spelled — the plain form above owns
      // the both-omitted case).
      const num = (node: ts.Expression | undefined, dflt: number): IrExpr =>
        node ? L.lowerExprExpecting(node, F64) : { kind: "numLit", value: dflt, type: F64, loc };
      return {
        kind: "libCall",
        fn: "fs.rmRetrySync",
        args: [path, recursive, force, num(opts.exprs["maxRetries"], 0), num(opts.exprs["retryDelay"], 100)],
        type: VOID,
        loc,
      };
    }
    // accessSync(p, mode?): an omitted mode is Node's F_OK (0). The mode
    // is an ordinary number — fs.constants.* reads bake to literals.
    if (bi.module === "fs" && bi.member === "accessSync") {
      if (expr.arguments.length < 1 || expr.arguments.length > 2) {
        L.noLowering(`accessSync with ${expr.arguments.length} arguments`, expr);
      }
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const mode: IrExpr = expr.arguments[1]
        ? L.lowerExprExpecting(expr.arguments[1], F64)
        : { kind: "numLit", value: 0, type: F64, loc };
      return { kind: "libCall", fn: "fs.accessSync", args: [path, mode], type: VOID, loc };
    }
    if (bi.module === "fs" && bi.member === "writeFileSync" && expr.arguments.length === 2) {
      const dataIr = L.mapTypeOf(L.typeOf(expr.arguments[1]!));
      if (dataIr?.kind === "bytes") {
        if (dataIr.elem !== "u8") {
          L.noLowering(
            `writeFileSync of '${L.fmt(dataIr)}' data`,
            expr.arguments[1]!,
            "byte writes take Uint8Array/Buffer data",
          );
        }
        const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
        const data = L.lowerExprExpecting(expr.arguments[1]!, BYTES_U8);
        return { kind: "libCall", fn: "fs.writeFileSyncBytes", args: [path, data], type: VOID, loc };
      }
    }
    // writeFileSync(p, data, options) / fs.promises.writeFile(p, data,
    // options): the lowered options are a literal
    // `{ mode?: <number>, encoding?: "utf8" }` — the mode is open(2)'s
    // O_CREAT argument (creation only; an existing file keeps its
    // permissions, exactly Node), and the encoding may only spell the
    // utf8 the runtime writes anyway. String data only — Buffer options
    // remain outside the static surface.
    const syncWriteOptions = bi.module === "fs" && bi.member === "writeFileSync";
    const promiseWriteOptions = bi.module === "fs/promises" && bi.member === "writeFile";
    if ((syncWriteOptions || promiseWriteOptions) && expr.arguments.length === 3) {
      const optsNode = expr.arguments[2]!;
      const operation = promiseWriteOptions ? "fs.promises.writeFile" : "writeFileSync";
      const plainFn: IrLibFn = promiseWriteOptions ? "fsp.writeFile" : "fs.writeFileSync";
      const modeFn: IrLibFn = promiseWriteOptions ? "fsp.writeFileMode" : "fs.writeFileModeSync";
      const resultType: IrType = promiseWriteOptions ? { kind: "promise", inner: VOID } : VOID;
      type WriteOptionValue = { kind: "effect" | "mode"; value: IrExpr };
      // The runtime needs only `mode`, but every source option value is an
      // ordinary JS expression. Stage path/data and then evaluate the option
      // values in object-literal order before issuing the write; otherwise a
      // call/getter statically typed as the accepted utf8 literal can vanish.
      const finishWrite = (optionValues: WriteOptionValue[]): IrExpr => {
        const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
        const data = L.lowerExprExpecting(expr.arguments[1]!, STRING);
        const pathLocal = L.declareHiddenLocal("%writePath", STRING);
        const dataLocal = L.declareHiddenLocal("%writeData", STRING);
        const ref = (local: IrLocal): IrExpr => ({ kind: "varRef", localId: local.id, type: local.type, loc });
        const stmts: IrStmt[] = [
          { kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc },
          { kind: "varDecl", localId: dataLocal.id, init: data, loc: data.loc },
        ];
        let mode: IrExpr | null = null;
        for (const option of optionValues) {
          if (option.kind === "effect") {
            stmts.push({ kind: "exprStmt", expr: option.value, loc: option.value.loc });
            continue;
          }
          const modeLocal = L.declareHiddenLocal("%writeMode", F64);
          stmts.push({ kind: "varDecl", localId: modeLocal.id, init: option.value, loc: option.value.loc });
          mode = ref(modeLocal);
        }
        const result: IrExpr = {
          kind: "libCall",
          fn: mode ? modeFn : plainFn,
          args: mode ? [ref(pathLocal), ref(dataLocal), mode] : [ref(pathLocal), ref(dataLocal)],
          type: resultType,
          loc,
        };
        return { kind: "seqExpr", stmts, result, type: resultType, loc };
      };
      // The bare-encoding spelling — writeFileSync(p, data, "utf-8") — is
      // the options record's encoding key alone: utf8 is what the runtime
      // writes anyway, so string data takes the plain write. Any OTHER
      // encoding name changes bytes and keeps the fence below.
      {
        const t = L.typeOf(optsNode);
        if (
          t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8") &&
          L.mapTypeOf(L.typeOf(expr.arguments[1]!))?.kind === "string"
        ) {
          return finishWrite([{ kind: "effect", value: L.lowerExprExpecting(optsNode, STRING) }]);
        }
      }
      const optionValues: WriteOptionValue[] = [];
      let ok = ts.isObjectLiteralExpression(optsNode);
      if (ok) {
        for (const p of (optsNode as ts.ObjectLiteralExpression).properties) {
          const m = optionMember(p);
          if (!m) { ok = false; break; }
          if (m.name === "mode") {
            optionValues.push({ kind: "mode", value: L.lowerExprExpecting(m.value, F64) });
          } else if (m.name === "encoding") {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) { ok = false; break; }
            optionValues.push({ kind: "effect", value: L.lowerExprExpecting(m.value, STRING) });
          } else if (m.name === "flag") {
            // Documented, behavior-changing (open(2)'s disposition — 'a'
            // IS appendFileSync), no lowering: fence by name.
            L.noLowering(
              `${operation} with the flag option`,
              p,
              "the write truncates-or-creates (Node's default 'w'); other flags have no lowering",
            );
          } else {
            // The options-record stance: documented keys with no lowering
            // fence by name; undocumented keys drop like Node.
            fenceOrDropOptionKey(
              L, p, m.name, operation, FS_WRITE_FILE_DOCUMENTED_OPTIONS,
              'the supported options are { mode: <number>, encoding: "utf8" }',
            );
          }
        }
      }
      if (!ok || L.mapTypeOf(L.typeOf(expr.arguments[1]!))?.kind !== "string") {
        L.noLowering(
          `${operation} with 3 arguments`,
          optsNode,
          'the supported options are { mode: <number>, encoding: "utf8" } over string data',
        );
      }
      return finishWrite(optionValues);
    }
    // zlib takes Buffers; a string argument (the lib admits it) gets the
    // wrap-it-first hint instead of a generic type mismatch.
    if (bi.module === "zlib" && expr.arguments.length >= 1) {
      const dataIr = L.mapTypeOf(L.typeOf(expr.arguments[0]!));
      if (!(dataIr?.kind === "bytes" && dataIr.elem === "u8")) {
        L.noLowering(
          `${bi.member} of '${dataIr ? L.fmt(dataIr) : L.checker.typeToString(L.typeOf(expr.arguments[0]!))}' data`,
          expr.arguments[0]!,
          `zlib works on Buffers: ${bi.member}(Buffer.from(s, "utf8"))`,
        );
      }
    }
    if (fn.variadicPack) {
      // join(...parts) forwards the array itself; mixing spread and plain
      // arguments (or spreading anything but a string[]) stays out.
      const spread = expr.arguments.find(ts.isSpreadElement);
      if (spread) {
        if (expr.arguments.length === 1) {
          // The whole-array form forwards the operand directly (no copy).
          const packed = L.lowerExprExpecting(spread.expression, arrayOf(STRING));
          return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
        }
        // The MIXED form — resolve(tmpPath, ...paths), test/common's
        // tmpdir.resolve: plain arguments and spread arrays pack into one
        // fresh string[] (arrayLit's spread positions copy element-wise,
        // JS-exact; a dyn spread source rides the validated extraction).
        const elems = expr.arguments.map((a) =>
          ts.isSpreadElement(a)
            ? L.lowerExprExpecting(a.expression, arrayOf(STRING))
            : L.lowerExprExpecting(a, STRING));
        const spreads = expr.arguments.flatMap((a, i) => (ts.isSpreadElement(a) ? [i] : []));
        const packed: IrExpr = { kind: "arrayLit", elems, spreads, type: arrayOf(STRING), loc };
        return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
      }
      const elems = expr.arguments.map((a) => L.lowerExprExpecting(a, STRING));
      const packed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(STRING), loc };
      return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
    }
    if (bi.module === "fs" && bi.member === "readFileSync" &&
        expr.arguments.length >= 1 && expr.arguments.length <= 2 &&
        !expr.arguments.some(ts.isSpreadElement)) {
      // The path-form Buffer read and the runtime-encoding dispatch
      // (test/common fixtures.js's readFixtureKey(name, enc) — BOTH the
      // path and the encoding are untyped JS values there: the path is
      // fixturesPath(...)'s checker-any, so the LOWERED kind decides and
      // a dyn path rides a validated string extraction — Node's
      // non-string paths throw ERR_INVALID_ARG_TYPE where the dynCheck
      // throws its path-annotated TypeError. The fd forms (a number
      // argument) and literal-utf8 reads keep their existing lowerings.
      const pathV = L.lowerExpr(expr.arguments[0]!);
      if (pathV.type.kind === "string" || pathV.type.kind === "dyn") {
        const pathArg: IrExpr = pathV.type.kind === "dyn"
          ? { kind: "dynCheck", value: pathV, type: STRING, loc }
          : pathV;
        if (expr.arguments.length === 1) {
          return { kind: "libCall", fn: "fs.readFileSyncBuf", args: [pathArg], type: BYTES_U8, loc };
        }
        // A runtime encoding value: undefined/null read Buffers, utf8
        // reads a string, real-but-unsupported encodings fence loudly,
        // unknown names throw ERR_UNKNOWN_ENCODING — all at runtime. A
        // non-dyn encoding falls through to the literal-utf8 lowering
        // below (the discarded probe IR never emits).
        const encT = L.typeOf(expr.arguments[1]!);
        if (!(encT.isStringLiteralType() && (encT.value === "utf8" || encT.value === "utf-8"))) {
          const enc = L.lowerExpr(expr.arguments[1]!);
          if (enc.type.kind === "dyn") {
            return { kind: "libCall", fn: "fs.readFileSyncDyn", args: [pathArg, enc], type: DYN, loc };
          }
        }
      }
    }
    const required = fn.params.length - (fn.defaults?.length ?? 0);
    if (expr.arguments.length < required || expr.arguments.length > fn.params.length) {
      L.noLowering(
        `${name} with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
        expr,
        bi.member === "readFileSync" || bi.member === "readFile"
          ? `pass the encoding: ${bi.member}(path, "utf8") — Buffer reads and options objects have no lowering`
          : `the supported form takes ${fn.params.length} argument${fn.params.length === 1 ? "" : "s"} (no options objects)`,
      );
    }
    if (bi.module === "url" && bi.member === "fileURLToPath") {
      // Node accepts a URL value or a URL string — one libFn per receiver
      // form, picked by the argument's static type. Unions (URL |
      // undefined, ...) must narrow first, like everywhere else.
      const argNode = expr.arguments[0]!;
      const arg = L.lowerExpr(argNode);
      if (arg.type.kind === "url") {
        return { kind: "libCall", fn: "url.fileURLToPathUrl", args: [arg], type: STRING, loc };
      }
      if (arg.type.kind === "string") {
        return { kind: "libCall", fn: "url.fileURLToPathStr", args: [arg], type: STRING, loc };
      }
      L.noLowering(
        `fileURLToPath of '${L.fmt(arg.type)}' values`,
        argNode,
        "pass a URL value or a URL string (narrow unions first)",
      );
    }
    if ((bi.module === "fs" && bi.member === "readFileSync") ||
        (bi.module === "fs/promises" && bi.member === "readFile")) {
      // The runtime reads utf8 unconditionally; any other encoding would
      // silently decode wrong, so the ARGUMENT'S TYPE must be the literal
      // "utf8" — or Node's "utf-8" alias, the same decoder (the fallback
      // declaration enforces the pair at typecheck; @types/node accepts
      // every BufferEncoding).
      const enc = L.typeOf(expr.arguments[1]!);
      if (!(enc.isStringLiteralType() && (enc.value === "utf8" || enc.value === "utf-8"))) {
        L.noLowering(
          `${bi.member} with a non-"utf8" encoding`,
          expr.arguments[1]!,
          `only utf8 reads are supported: ${bi.member}(path, "utf8")`,
        );
      }
    }
    const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, fn.params[i]));
    for (let i = args.length; i < fn.params.length; i++) {
      const dflt = fn.defaults![i - required]!;
      args.push({ kind: "strLit", value: dflt, type: STRING, loc });
    }
    return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
  }

/** Reflect.apply(target, thisArg, argsList) where the TARGET is a builtin
   * rest-parameter table fn (path.join / path.resolve — test/common
   * fixtures.js's fixturesPath forwards its rest args exactly this way):
   * the packed libCall over a validated string[] extraction of argsList.
   * The builtins ignore the receiver, so thisArg must be an effect-free
   * spelling (`this`, an identifier, a unit literal) whose dropped
   * evaluation is unobservable; every other Reflect.apply keeps the
   * fence. Null when this isn't a Reflect.apply call. */
  export function lowerReflectApplyCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    if (L.stdlibGlobalMember(access, "Reflect") !== "apply") return null;
    const loc = locOf(call);
    const fenceHint =
      "the lowered form is Reflect.apply(path.join | path.resolve, <effect-free this>, args) — call other functions directly (f(...args))";
    if (call.arguments.length !== 3 || call.arguments.some(ts.isSpreadElement)) {
      L.noLowering("Reflect.apply with this argument shape", call, fenceHint);
    }
    const targetNode = call.arguments[0]!;
    const bi = ts.isPropertyAccessExpression(targetNode) ? L.builtinMemberOf(targetNode) : null;
    const fn = bi ? builtinModuleFnOf(L, bi.module, bi.member) : null;
    if (!fn || fn.variadicPack !== true) {
      L.noLowering(
        `Reflect.apply of '${targetNode.getText()}'`,
        targetNode,
        fenceHint,
      );
    }
    const thisNode = call.arguments[1]!;
    const effectFree =
      thisNode.kind === ts.SyntaxKind.ThisKeyword ||
      ts.isIdentifier(thisNode) ||
      thisNode.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(thisNode) && thisNode.text === "undefined");
    if (!effectFree) {
      L.noLowering(
        "Reflect.apply with a computed thisArg",
        thisNode,
        "the target ignores its receiver, so only effect-free spellings drop honestly (`this`, a binding, null, undefined)",
      );
    }
    const packed = L.lowerExprExpecting(call.arguments[2]!, arrayOf(STRING));
    return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
  }

/** The child-process args list: one string[] value. An omitted list
   * completes to an empty literal (Node's default); an array LITERAL
   * builds element-wise (its contextual type is the optional parameter's
   * `string[] | undefined`, which the generic literal path cannot map —
   * the Set-seed situation exactly); everything else lowers as itself. */
  export function lowerChildArgsArg(L: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
    if (!node) return { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
    if (ts.isArrayLiteralExpression(node) && !node.elements.some(ts.isSpreadElement)) {
      const elems = node.elements.map((el) => L.lowerExprExpecting(el, STRING));
      return { kind: "arrayLit", elems, type: arrayOf(STRING), loc: locOf(node) };
    }
    return L.lowerExprExpecting(node, arrayOf(STRING));
  }

/** The signal names Node's table (and the runtime's twin) resolves —
   * killSignal literals are validated HERE so an unknown name is a
   * compile-time fence instead of Node's runtime ERR_UNKNOWN_SIGNAL. */
  const NODE_SIGNAL_NAMES = new Set([
    "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT",
    "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE",
    "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN",
    "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF",
    "SIGWINCH", "SIGSYS", "SIGIO", "SIGINFO",
  ]);

/** `spawnSync(command, args?, options?)` → one cp.spawnSync /
   * cp.spawnSyncOpts libCall. An omitted args list completes to an empty
   * string[] literal (Node's default). The options argument must be an
   * object LITERAL whose members are drawn from the honestly-implemented
   * set: `encoding` (the "utf8"/"utf-8" literal — the runtime captures
   * utf8 unconditionally, and the option flips @types/node's
   * stdout/stderr to string), `timeout` (ms — killSignal fires at the
   * deadline and the result carries error: ETIMEDOUT + the signal, never
   * a throw: Node's spawnSync shape), `killSignal` (a signal-name
   * literal, validated against Node's table), `stdio` (the "pipe"/
   * "ignore"/"inherit" string form or a 3-tuple of those — non-piped
   * outputs read "" where Node types them null, spawnSync's documented
   * stance), and `windowsHide` (a POSIX no-op, evaluated for side
   * effects). Everything else (shell, cwd, env, input, maxBuffer, ...)
   * fences by name. The bare `{ encoding: "utf8" }` shape keeps its
   * historical cp.spawnSync lowering. */
  export function lowerSpawnSyncCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (expr.arguments.length > 3 || expr.arguments.some(ts.isSpreadElement)) {
      L.noLowering(
        "spawnSync with this argument shape",
        expr,
        "the supported form is spawnSync(command, args?, options?)",
      );
    }
    const cmd = L.lowerExprExpecting(expr.arguments[0]!, STRING);
    const argv = L.lowerChildArgsArg(expr.arguments[1], loc);
    const optsNode = expr.arguments[2];

    const num = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
    let timeout: IrExpr = num(0);
    let killSignal: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
    // stdio modes (scr_child.c's core): stdin 0 = /dev/null ("pipe" with
    // no input and "ignore" both read nothing), 2 = inherit; stdout/
    // stderr 0 = capture, 1 = ignore, 2 = inherit.
    let inMode = 0, outMode = 0, errMode = 0;
    // A RUNTIME stdio string (the defaultRunner idiom: `options?.stdio ??
    // "pipe"`) — accepted when its TYPE proves every arm is a supported
    // literal; the runtime maps the value to the modes at the call.
    let stdioStr: IrExpr | null = null;
    let plain = true; // no behavior-changing option: the historical libCall

    if (optsNode) {
      if (!ts.isObjectLiteralExpression(optsNode)) {
        L.noLowering(
          "spawnSync with a non-literal options argument",
          optsNode,
          "pass the options inline so each member can be checked",
        );
      }
      const applyStdio = (node: ts.Expression): void => {
        const modeOf = (v: string, fd: 0 | 1 | 2): void => {
          if (v === "pipe") return; // the default modes
          if (v === "ignore") {
            if (fd === 1) outMode = 1;
            if (fd === 2) errMode = 1;
            return;
          }
          if (v === "inherit") {
            if (fd === 0) inMode = 2;
            if (fd === 1) outMode = 2;
            if (fd === 2) errMode = 2;
            return;
          }
          L.noLowering(
            `spawnSync with stdio "${v}"`,
            node,
            '"pipe", "ignore", and "inherit" are the supported stdio modes',
          );
        };
        const t = L.typeOf(node);
        if (t.isStringLiteralType()) {
          modeOf(t.value, 0);
          modeOf(t.value, 1);
          modeOf(t.value, 2);
          return;
        }
        if (ts.isArrayLiteralExpression(node) && node.elements.length === 3) {
          node.elements.forEach((el, i) => {
            const et = L.typeOf(el);
            if (!et.isStringLiteralType()) {
              L.noLowering("spawnSync stdio tuple entries beyond string literals", el);
            }
            modeOf(et.value, i as 0 | 1 | 2);
          });
          return;
        }
        // A runtime string whose TYPE pins every possible value to the
        // supported literals — the modes resolve at the call instead.
        const arms: readonly ts.Type[] = t.isUnionType() ? ts.constituentTypes(t) : [t];
        if (
          arms.length > 0 &&
          arms.every(
            (a) =>
              a.isStringLiteralType() &&
              (a.value === "pipe" || a.value === "ignore" || a.value === "inherit"),
          )
        ) {
          stdioStr = L.lowerExprExpecting(node, STRING);
          return;
        }
        L.noLowering(
          "spawnSync with this stdio option",
          node,
          'stdio takes a "pipe"/"ignore"/"inherit" literal (or a value typed as a union of those), or a 3-tuple of literals',
        );
      };
      for (const p of optsNode.properties) {
        const m = optionMember(p);
        if (!m) {
          L.noLowering(
            "spawnSync with this options shape",
            p,
            "spreads and computed keys have no lowering — write each member inline",
          );
        }
        switch (m.name) {
          case "encoding": {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
              L.noLowering(
                "spawnSync with a non-utf8 encoding",
                m.value,
                'outputs are captured as utf8 — pass { encoding: "utf8" }',
              );
            }
            break;
          }
          case "timeout":
            timeout = L.lowerExprExpecting(m.value, F64);
            plain = false;
            break;
          case "killSignal": {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || !NODE_SIGNAL_NAMES.has(t.value)) {
              L.noLowering(
                "spawnSync with this killSignal",
                m.value,
                'a signal-name literal from Node\'s table ("SIGTERM", "SIGKILL", ...) is the supported form',
              );
            }
            killSignal = { kind: "strLit", value: t.value, type: STRING, loc };
            plain = false;
            break;
          }
          case "stdio":
            applyStdio(m.value);
            plain = false;
            break;
          case "windowsHide":
            L.lowerExpr(m.value); // Node no-op on POSIX
            break;
          default:
            L.noLowering(
              `spawnSync option '${m.name}'`,
              p,
              "encoding, timeout, killSignal, stdio, and windowsHide are the supported options",
            );
        }
      }
    }
    if (plain) {
      return { kind: "libCall", fn: "cp.spawnSync", args: [cmd, argv], type: SPAWNRES_T, loc };
    }
    if (stdioStr !== null) {
      return {
        kind: "libCall",
        fn: "cp.spawnSyncStdioStr",
        args: [cmd, argv, timeout, killSignal, stdioStr],
        type: SPAWNRES_T,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "cp.spawnSyncOpts",
      args: [cmd, argv, timeout, killSignal, num(inMode), num(outMode), num(errMode)],
      type: SPAWNRES_T,
      loc,
    };
  }

/** `spawn(command, args?, options)` → one cp.spawn / cp.spawnOpts
   * libCall. The options argument must be an object LITERAL with an
   * EXPLICIT stdio — "ignore" or "inherit" as the scalar, or the 3-tuple
   * whose stdout/stderr slots may also be "pipe" (the child.stdout/
   * child.stderr streams) or number fds; piped STDIN fences, and
   * OMITTING the options means Node's default stdio, "pipe" on all
   * three — fenced too, so a program never silently loses its child's
   * output. The other lowered
   * members: `detached` (a boolean literal, inline or carried by the
   * conditional spread `...(c ? { detached: true } : {})` in either
   * orientation — POSIX_SPAWN_SETSID, the child gets its own session and
   * process group like Node's), `env` (a
   * REPLACEMENT environment, the exec-core pairs machinery), `cwd`, and
   * `windowsHide` (a POSIX no-op). The bare `{ stdio: "ignore" }` shape
   * keeps its historical cp.spawn lowering. */
  export function lowerSpawnCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (expr.arguments.length > 3 || expr.arguments.some(ts.isSpreadElement)) {
      L.noLowering(
        "spawn with this argument shape",
        expr,
        'the supported form is spawn(command, args?, { stdio: "ignore" | "inherit", detached?, env?, cwd? })',
      );
    }
    const cmd = L.lowerExprExpecting(expr.arguments[0]!, STRING);
    const argsNode = expr.arguments.length === 3 ? expr.arguments[1] : undefined;
    const optsNode = expr.arguments[expr.arguments.length - 1];

    const bool = (v: boolean): IrExpr => ({ kind: "boolLit", value: v, type: BOOL, loc });
    const numLit = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
    const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
    // Per-slot stdio modes (scr_child.c: 0 ignore, 1 inherit, 2 fd) and
    // the out/err fd expressions for mode 2 (the daemon-log idiom:
    // stdio: ["ignore", logFd, logFd]).
    let sawStdio = false;
    let inMode = 0, outMode = 0, errMode = 0;
    let outFd: IrExpr = numLit(0);
    let errFd: IrExpr = numLit(0);
    let detached: IrExpr = bool(false);
    let hasEnv: IrExpr = bool(false);
    let envPairs: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
    let cwd: IrExpr = emptyStr;
    let plain = true; // exactly { stdio: "ignore" }: the historical libCall

    const pipeFence = (node: ts.Node): never =>
      L.noLowering(
        'spawn with stdio: "pipe"',
        node,
        'piped STDIN has no lowering — pipe stdout/stderr with the tuple form (stdio: ["ignore", "pipe", "pipe"]), or capture with spawnSync',
      );
    if (optsNode && ts.isObjectLiteralExpression(optsNode) && expr.arguments.length >= 2) {
      for (const p of optsNode.properties) {
        // The conditional-spread idiom `...(isWindows ? {} : { detached:
        // true })` (either orientation): the one carried member supported
        // is `detached` with a boolean literal — the platform-conditional
        // setsid. The condition evaluates at runtime; the empty arm
        // contributes Node's default (false).
        if (ts.isSpreadAssignment(p)) {
          const cs = conditionalSpreadOf(p.expression);
          if (cs !== null && cs !== "unsupported" && cs.props.length === 1 &&
              cs.props[0]!.name.text === "detached" && ts.isPropertyAssignment(cs.props[0]!)) {
            const v = (cs.props[0] as ts.PropertyAssignment).initializer;
            const lit =
              v.kind === ts.SyntaxKind.TrueKeyword ? true :
              v.kind === ts.SyntaxKind.FalseKeyword ? false : null;
            if (lit !== null) {
              const cond = L.lowerCondition(cs.cond);
              detached = {
                kind: "ternary",
                cond,
                then: bool(cs.whenTrue ? lit : false),
                else_: bool(cs.whenTrue ? false : lit),
                type: BOOL,
                loc,
              };
              plain = false;
              continue;
            }
          }
          L.noLowering(
            "spawn with this options spread",
            p,
            "the one supported spread is the conditional `...(c ? { detached: <literal> } : {})` (either orientation) — write other members inline",
          );
        }
        const m = optionMember(p);
        if (!m) {
          L.noLowering(
            "spawn with this options shape",
            p,
            "spreads and computed keys have no lowering — write each member inline",
          );
        }
        switch (m.name) {
          case "stdio": {
            // The 3-tuple form: stdin a "ignore"/"inherit" literal,
            // stdout/stderr each a literal (including "pipe" — the
            // child.stdout/stderr stream slots) OR a number-typed fd (an
            // openSync result — dup2'd into the child, Node's fd slots).
            if (ts.isArrayLiteralExpression(m.value) && m.value.elements.length === 3) {
              const slot = (el: ts.Expression, which: 0 | 1 | 2): void => {
                const t = L.typeOf(el);
                if (t.isStringLiteralType()) {
                  if (t.value === "pipe" && which === 0) pipeFence(el);
                  if (t.value !== "ignore" && t.value !== "inherit" && t.value !== "pipe") {
                    L.noLowering(
                      `spawn with stdio "${t.value}"`,
                      el,
                      '"ignore", "inherit", "pipe" (stdout/stderr), and number fds are the supported stdio slots',
                    );
                  }
                  const mode = t.value === "inherit" ? 1 : t.value === "pipe" ? 3 : 0;
                  if (which === 0) inMode = mode;
                  else if (which === 1) outMode = mode;
                  else errMode = mode;
                  if (t.value === "pipe") plain = false;
                  return;
                }
                if (which === 0) {
                  L.noLowering(
                    "spawn with this stdin slot",
                    el,
                    'stdin takes "ignore" or "inherit" (fd stdin has no lowering)',
                  );
                }
                if (L.mapTypeOf(t)?.kind !== "f64") {
                  L.noLowering(
                    "spawn with this stdio option",
                    el,
                    'each slot is "ignore", "inherit", or a number fd (an openSync result)',
                  );
                }
                const fd = L.lowerExprExpecting(el, F64);
                if (which === 1) { outMode = 2; outFd = fd; }
                else { errMode = 2; errFd = fd; }
              };
              m.value.elements.forEach((el, i) => slot(el, i as 0 | 1 | 2));
              sawStdio = true;
              plain = false;
              break;
            }
            const t = L.typeOf(m.value);
            const v = t.isStringLiteralType() ? t.value : null;
            if (v === "pipe") pipeFence(m.value);
            if (v !== "ignore" && v !== "inherit") {
              L.noLowering(
                "spawn with this stdio option",
                m.value,
                '"ignore" and "inherit" are the supported stdio literals ' +
                  '(or a 3-tuple of those and number fds; "pipe" has no lowering)',
              );
            }
            const mode = v === "inherit" ? 1 : 0;
            inMode = outMode = errMode = mode;
            sawStdio = true;
            if (v !== "ignore") plain = false;
            break;
          }
          case "detached": {
            if (m.value.kind === ts.SyntaxKind.TrueKeyword) {
              detached = bool(true);
              plain = false;
            } else if (m.value.kind === ts.SyntaxKind.FalseKeyword) {
              detached = bool(false);
            } else {
              L.noLowering(
                "spawn with a non-literal detached option",
                m.value,
                "detached must be a boolean literal",
              );
            }
            break;
          }
          case "env":
            hasEnv = bool(true);
            envPairs = L.recordToEnvPairs(m.value);
            plain = false;
            break;
          case "cwd":
            cwd = L.lowerExprExpecting(m.value, STRING);
            plain = false;
            break;
          case "windowsHide":
            L.lowerExpr(m.value); // Node no-op on POSIX
            break;
          default:
            L.noLowering(
              `spawn option '${m.name}'`,
              p,
              "stdio, detached, env, cwd, and windowsHide are the supported options",
            );
        }
      }
    }
    if (!sawStdio) {
      L.noLowering(
        "spawn without { stdio: \"ignore\" }",
        expr,
        'Node\'s default stdio is "pipe" (streams, no lowering) — pass { stdio: "ignore" } or { stdio: "inherit" } explicitly, or capture with spawnSync',
      );
    }
    const argv = L.lowerChildArgsArg(argsNode, loc);
    if (plain) {
      return { kind: "libCall", fn: "cp.spawn", args: [cmd, argv], type: CHILD_T, loc };
    }
    return {
      kind: "libCall",
      fn: "cp.spawnOpts",
      args: [cmd, argv, numLit(inMode), numLit(outMode), numLit(errMode), outFd, errFd, detached, hasEnv, envPairs, cwd],
      type: CHILD_T,
      loc,
    };
  }

/** `execFileSync(file, args?, options?)` / `execSync(command, options?)`
   * → the ONE cp.execSync libCall. execSync wraps the command in
   * `/bin/sh -c` (Node's shell semantics — a single command string, no
   * args array); execFileSync runs the file directly with its args. The
   * options object, when present, must be an object LITERAL whose members
   * are drawn from the honestly-implemented set — `encoding` (must be the
   * "utf8"/"utf-8" literal, like spawnSync — outputs are captured utf8),
   * `cwd`, `env`, `input`, `timeout`, `stdio` (the "pipe"/"ignore"
   * string form or a 3-tuple of those), `maxBuffer` (accepted, not
   * enforced — the capture grows), `killSignal` (accepted only as the
   * SIGTERM default), `windowsHide`/`shell:false` on execFileSync (Node
   * no-ops here). Every other member (a non-default killSignal, shell:true
   * on execFileSync, ...) fences by name. */
  /** Side-effect-free read shapes — identifiers and (optional) property
   * access chains over them (`options?.input`) — the shapes a lowering may
   * evaluate more than once (the readOpt re-read discipline). */
  function isPureReadShape(e: ts.Expression): boolean {
    if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (ts.isPropertyAccessExpression(e)) return isPureReadShape(e.expression);
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return isPureReadShape(e.expression);
    return false;
  }

  export function lowerExecSyncCall(L: Lowerer, expr: ts.CallExpression, shell: boolean, loc: SrcLoc): IrExpr {
    if (expr.arguments.some(ts.isSpreadElement)) {
      L.noLowering(`${shell ? "execSync" : "execFileSync"} with a spread call`, expr);
    }
    const cmd = L.lowerExprExpecting(expr.arguments[0]!, STRING);
    // execSync: /bin/sh -c <command>; execFileSync: file + its args list.
    let argvExpr: IrExpr;
    let optsNode: ts.Expression | undefined;
    if (shell) {
      if (expr.arguments.length > 2) {
        L.noLowering("execSync with this argument shape", expr, "the supported form is execSync(command, options?)");
      }
      argvExpr = {
        kind: "arrayLit",
        elems: [
          { kind: "strLit", value: "-c", type: STRING, loc },
          cmd,
        ],
        type: arrayOf(STRING),
        loc,
      };
      optsNode = expr.arguments[1];
    } else {
      if (expr.arguments.length > 3) {
        L.noLowering("execFileSync with this argument shape", expr, "the supported form is execFileSync(file, args?, options?)");
      }
      argvExpr = L.lowerChildArgsArg(expr.arguments[1], loc);
      optsNode = expr.arguments[2];
    }
    // The shell command itself is /bin/sh; the "command" string rides as
    // the argv[1] the display formatter reads.
    const cmdArg: IrExpr = shell ? { kind: "strLit", value: "/bin/sh", type: STRING, loc } : cmd;

    const bool = (v: boolean): IrExpr => ({ kind: "boolLit", value: v, type: BOOL, loc });
    const num = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
    const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
    const emptyPairs: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };

    // Defaults: no shell input, inherit cwd/env, no timeout, capture
    // stdout (mode 1), capture+echo stderr (mode 0 — Node's inheritStderr).
    // hasInput carries the input option's PRESENCE separately: undefined
    // means the option is absent (no stdin pipe), distinct from "" (pipe
    // empty stdin — immediate EOF), Node's exact reading of the member.
    let input: IrExpr = emptyStr;
    let hasInput: IrExpr = bool(false);
    let cwd: IrExpr = emptyStr;
    let hasEnv: IrExpr = bool(false);
    let envPairs: IrExpr = emptyPairs;
    let timeout: IrExpr = num(0);
    let stdoutMode = 1;
    let stderrMode = 0;
    let stdinInherit = false;
    // A conditional env spread (`...(c ? { env: ... } : {})`): the call
    // itself splits into a ternary of the two env-nesses at the tail.
    let condEnvSpread: { cond: IrExpr; pairs: IrExpr; whenTrue: boolean } | null = null;

    if (optsNode) {
      if (!ts.isObjectLiteralExpression(optsNode)) {
        // A TYPED options VALUE (the interned exec-options record —
        // ExecFileSyncOptionsWithStringEncoding consts and runner params,
        // the windows-ca idiom): members read at RUNTIME. cwd/input/
        // timeout default like the literal path when the field holds
        // undefined; stdio modes compute through an interned helper that
        // validates the runtime strings ("pipe"/"ignore", the same bounds
        // as the literal path — anything else throws a catchable
        // TypeError, as does a non-utf8 runtime encoding: outputs are
        // captured utf8, and silently mislabeling them would be worse).
        const runtime = lowerExecSyncRuntimeOptions(L, expr, shell, optsNode, loc);
        if (runtime) {
          return {
            kind: "libCall",
            fn: "cp.execSync",
            args: [cmdArg, argvExpr, bool(shell), runtime.input, runtime.hasInput, runtime.cwd, bool(false), emptyPairs, runtime.timeout, runtime.stdoutMode, runtime.stderrMode],
            type: STRING,
            loc,
          };
        }
        L.noLowering(
          `${shell ? "execSync" : "execFileSync"} with a non-literal options argument`,
          optsNode,
          "pass the options inline so each member can be checked",
        );
      }
      // stdio member: a single string ("pipe"/"ignore"/"inherit") sets all
      // three, a 3-tuple literal sets each fd. Parsed first so an explicit
      // stderr turns off the echo. "inherit" hands the child the parent's
      // fd (stdout mode 2 / stderr mode 3 / stdin as stdout's bit 4 —
      // scr_runtime.h); nothing captures on an inherited stream, so the
      // call's RESULT is "" where Node answers null (SEMANTICS.md — the
      // mutate-the-terminal spelling discards it).
      const applyStdio = (node: ts.Expression): void => {
        const modeOf = (v: string, fd: 0 | 1 | 2): void => {
          if (v === "pipe") {
            if (fd === 2) stderrMode = 1; // capture, no echo
            return;
          }
          if (v === "ignore") {
            if (fd === 1) stdoutMode = 0;
            if (fd === 2) stderrMode = 2;
            return;
          }
          if (v === "inherit") {
            if (fd === 0) stdinInherit = true;
            if (fd === 1) stdoutMode = 2;
            if (fd === 2) stderrMode = 3;
            return;
          }
          L.noLowering(
            `${shell ? "execSync" : "execFileSync"} with stdio "${v}"`,
            node,
            '"pipe", "ignore", and "inherit" are the supported stdio modes',
          );
        };
        const t = L.typeOf(node);
        if (t.isStringLiteralType()) {
          modeOf(t.value, 0);
          modeOf(t.value, 1);
          modeOf(t.value, 2);
          return;
        }
        if (ts.isArrayLiteralExpression(node) && node.elements.length === 3) {
          node.elements.forEach((el, i) => {
            const et = L.typeOf(el);
            if (!et.isStringLiteralType()) {
              L.noLowering(`${shell ? "execSync" : "execFileSync"} stdio tuple entries beyond string literals`, el);
            }
            modeOf(et.value, i as 0 | 1 | 2);
          });
          return;
        }
        L.noLowering(
          `${shell ? "execSync" : "execFileSync"} with this stdio option`,
          node,
          'stdio takes a "pipe"/"ignore" literal or a 3-tuple of those',
        );
      };

      for (const p of optsNode.properties) {
        // The conditional-spread idiom carrying `env` — the openssl-runner
        // shape: `...(c ? { env: { ...process.env, ...extra } } : {})`
        // (either orientation). The condition evaluates ONCE and picks
        // between two copies of the exec call — one with the env pairs
        // (built lazily in that arm, where tsc's narrowing of the
        // condition holds), one inheriting — exactly the spread's
        // semantics (lowerExecSyncCall's tail builds the ternary).
        if (ts.isSpreadAssignment(p)) {
          const cs = conditionalSpreadOf(p.expression);
          if (cs !== null && cs !== "unsupported" && cs.props.length === 1 &&
              cs.props[0]!.name.text === "env" && ts.isPropertyAssignment(cs.props[0]!)) {
            condEnvSpread = {
              cond: L.lowerCondition(cs.cond),
              pairs: L.recordToEnvPairs((cs.props[0] as ts.PropertyAssignment).initializer),
              whenTrue: cs.whenTrue,
            };
            continue;
          }
          L.noLowering(
            `${shell ? "execSync" : "execFileSync"} with this options spread`,
            p,
            "the one supported spread is the conditional `...(c ? { env: ... } : {})` (either orientation) — write other members inline",
          );
        }
        const m = optionMember(p);
        if (!m) {
          L.noLowering(
            `${shell ? "execSync" : "execFileSync"} with this options shape`,
            p,
            "spreads and computed keys have no lowering — write each member inline",
          );
        }
        const member = m.name;
        switch (member) {
          case "encoding": {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
              L.noLowering(
                `${shell ? "execSync" : "execFileSync"} with a non-utf8 encoding`,
                m.value,
                'outputs are captured as utf8 — pass { encoding: "utf8" }',
              );
            }
            break;
          }
          case "cwd":
            cwd = L.lowerExprExpecting(m.value, STRING);
            break;
          case "input": {
            // string | undefined, Node's exact member semantics: the
            // undefined arm means the option is ABSENT (no stdin pipe),
            // "" pipes EMPTY stdin (the child reads immediate EOF). A
            // union-typed value re-reads for the presence test (the
            // readOpt discipline), so only pure reads qualify — the
            // `options?.input` shape verbatim.
            if (L.typeOf(m.value).flags & ts.TypeFlags.Undefined) {
              // `input: undefined` — Node treats the member as absent.
              break;
            }
            const it = L.mapTypeOf(L.typeOf(m.value));
            const uTag = it?.kind === "union" ? L.armTag(it.unionId, UNDEFINED_T) : -1;
            const sTag = it?.kind === "union" ? L.armTag(it.unionId, STRING) : -1;
            if (it?.kind === "union" && uTag >= 0 && sTag >= 0) {
              if (!isPureReadShape(m.value)) {
                L.noLowering(
                  `${shell ? "execSync" : "execFileSync"} with a computed optional input`,
                  m.value,
                  "the undefined test re-reads the expression — bind the input to a const first",
                );
              }
              const read = L.lowerExpr(m.value);
              hasInput = { kind: "unionIsTag", unionId: it.unionId, tag: uTag, negated: true, value: read, type: BOOL, loc };
              input = {
                kind: "ternary",
                cond: { kind: "unionIsTag", unionId: it.unionId, tag: uTag, negated: false, value: read, type: BOOL, loc },
                then: emptyStr,
                else_: { kind: "unionNarrow", unionId: it.unionId, tag: sTag, value: read, type: STRING, loc },
                type: STRING,
                loc,
              };
              break;
            }
            input = L.lowerExprExpecting(m.value, STRING);
            hasInput = bool(true);
            break;
          }
          case "env": {
            hasEnv = bool(true);
            envPairs = L.recordToEnvPairs(m.value);
            // A later inline env member overrides an earlier conditional
            // spread (JS object-literal order); an earlier member stays
            // the spread's false-arm fallback.
            condEnvSpread = null;
            break;
          }
          case "timeout":
            timeout = L.lowerExprExpecting(m.value, F64);
            break;
          case "stdio":
            applyStdio(m.value);
            break;
          case "maxBuffer":
            // Accepted, not enforced (the capture grows unbounded — no
            // real corpus hits the cap); evaluate for side effects.
            L.lowerExpr(m.value);
            break;
          case "killSignal": {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || t.value !== "SIGTERM") {
              L.noLowering(
                `${shell ? "execSync" : "execFileSync"} with a non-default killSignal`,
                m.value,
                "only the SIGTERM default is implemented for the timeout kill",
              );
            }
            break;
          }
          case "windowsHide":
            L.lowerExpr(m.value); // Node no-op on POSIX
            break;
          case "shell":
            if (shell) {
              L.lowerExpr(m.value);
            } else {
              const t = L.typeOf(m.value);
              if (t.flags & ts.TypeFlags.BooleanLiteral && L.checker.typeToString(t) === "false") {
                // execFileSync's default — a no-op.
              } else {
                L.noLowering(
                  "execFileSync with shell enabled",
                  m.value,
                  "use execSync for shell execution",
                );
              }
            }
            break;
          default:
            L.noLowering(
              `${shell ? "execSync" : "execFileSync"} option '${member}'`,
              p,
              "encoding, cwd, env, input, timeout, stdio, and maxBuffer are the supported options",
            );
        }
      }
    }

    const execCall = (hasE: IrExpr, pairs: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "cp.execSync",
      args: [cmdArg, argvExpr, bool(shell), input, hasInput, cwd, hasE, pairs, timeout, num(stdoutMode + (stdinInherit ? 4 : 0)), num(stderrMode)],
      type: STRING,
      loc,
    });
    if (condEnvSpread !== null) {
      // The conditional env spread: ONE cond evaluation picks between two
      // copies of the call — every other argument expression is shared
      // between the arms and only the taken arm evaluates, so each still
      // runs exactly once; the env pairs build only in their own arm
      // (where the condition's narrowing holds).
      const withEnv = execCall(bool(true), condEnvSpread.pairs);
      const without = execCall(hasEnv, envPairs);
      return {
        kind: "ternary",
        cond: condEnvSpread.cond,
        then: condEnvSpread.whenTrue ? withEnv : without,
        else_: condEnvSpread.whenTrue ? without : withEnv,
        type: STRING,
        loc,
      };
    }
    return execCall(hasEnv, envPairs);
  }

/** The RUNTIME half of the exec-options story: a non-literal options
   * argument whose type mapped to the interned exec-options record
   * (ExecFileSyncOptionsWithStringEncoding). cwd/input/timeout read their
   * fields with the literal path's defaults on the undefined arm; the
   * stdio modes (and the encoding gate) compute through interned helpers
   * over the record. The options expression re-reads per member, so only
   * side-effect-free reads qualify (the `in`-operator fold discipline) —
   * bind computed options to a const first. Null when the shape isn't the
   * exec-options record (the caller keeps its fence). */
  function lowerExecSyncRuntimeOptions(L: Lowerer, expr: ts.CallExpression, shell: boolean,
    optsNode: ts.Expression, loc: SrcLoc,):
    { input: IrExpr; hasInput: IrExpr; cwd: IrExpr; timeout: IrExpr; stdoutMode: IrExpr; stderrMode: IrExpr } | null {
    const opts = L.lowerExpr(optsNode);
    if (opts.type.kind !== "record") return null;
    const shapeId = opts.type.shapeId;
    const shape = L.shapes.get(shapeId);
    const names = shape?.fields.map((f) => f.name).join(",");
    if (names !== "cwd,encoding,input,maxBuffer,stdio,timeout,windowsHide") return null;
    if (opts.kind !== "varRef" && opts.kind !== "recordGet" && opts.kind !== "fieldGet") {
      L.noLowering(
        `${shell ? "execSync" : "execFileSync"} with a computed options argument`,
        optsNode,
        "the member reads re-read the options — bind the object to a const first",
      );
    }
    const fieldType = (name: string): IrType => shape!.fields.find((f) => f.name === name)!.type;
    // field ?? default — the undefined arm takes the literal path's default.
    const readOpt = (name: string, dflt: IrExpr, armT: IrType): IrExpr => {
      const ft = fieldType(name);
      if (ft.kind !== "union") return { kind: "recordGet", obj: opts, shapeId, field: name, type: ft, loc };
      const uTag = L.armTag(ft.unionId, UNDEFINED_T);
      const vTag = L.armTag(ft.unionId, armT);
      const read: IrExpr = { kind: "recordGet", obj: opts, shapeId, field: name, type: ft, loc };
      return {
        kind: "ternary",
        cond: { kind: "unionIsTag", unionId: ft.unionId, tag: uTag, negated: false, value: read, type: BOOL, loc },
        then: dflt,
        else_: { kind: "unionNarrow", unionId: ft.unionId, tag: vTag, value: read, type: armT, loc },
        type: armT,
        loc,
      };
    };
    const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
    const optsT: IrType = { kind: "record", shapeId };
    const modeCall = (fd: 1 | 2): IrExpr => ({
      kind: "call",
      callee: execStdioModeHelper(L, shapeId, fieldType("stdio"), fd, loc),
      args: [opts],
      type: F64,
      loc,
    });
    void optsT;
    // input's PRESENCE rides separately (undefined = the option is absent
    // — no stdin pipe; "" pipes empty stdin): true exactly when the field
    // holds the string arm.
    const inputT = fieldType("input");
    const hasInput: IrExpr =
      inputT.kind === "union"
        ? {
            kind: "unionIsTag",
            unionId: inputT.unionId,
            tag: L.armTag(inputT.unionId, UNDEFINED_T),
            negated: true,
            value: { kind: "recordGet", obj: opts, shapeId, field: "input", type: inputT, loc },
            type: BOOL,
            loc,
          }
        : { kind: "boolLit", value: true, type: BOOL, loc };
    return {
      input: readOpt("input", emptyStr, STRING),
      hasInput,
      cwd: readOpt("cwd", emptyStr, STRING),
      timeout: readOpt("timeout", { kind: "numLit", value: 0, type: F64, loc }, F64),
      stdoutMode: modeCall(1),
      stderrMode: modeCall(2),
    };
  }

/** Interned `%cp.stdioMode.<fd>` — the runtime stdio-mode computation over
   * the exec-options record: undefined stdio keeps the defaults (stdout
   * captured, stderr captured+echoed), a single "pipe"/"ignore" string
   * applies to all three fds, an array reads its fd's entry ("pipe" when
   * the array is short — Node's default per fd). Any other runtime string
   * throws the catchable TypeError the literal path fences at compile
   * time; the fd-1 helper also gates the encoding (utf8/utf-8 only —
   * outputs are captured utf8). */
  function execStdioModeHelper(L: Lowerer, shapeId: string, stdioT: IrType, fd: 1 | 2, loc: SrcLoc): string {
    const key = `cp.stdiomode:${shapeId}:${fd}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%cp.stdioMode.${fd}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const optsT: IrType = { kind: "record", shapeId };
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
    const str = (v: string): IrExpr => ({ kind: "strLit", value: v, type: STRING, loc });
    const strEq = (l: IrExpr, r: string): IrExpr => ({ kind: "strEq", negated: false, left: l, right: str(r), type: BOOL, loc });
    const throwType = (msg: IrExpr): IrStmt => ({
      kind: "throw",
      value: { kind: "libCall", fn: "error.new", args: [msg], type: { kind: "object", className: "%TypeError" }, loc },
      loc,
    });
    const concat = (l: IrExpr, r: IrExpr): IrExpr => ({ kind: "strConcat", left: l, right: r, type: STRING, loc });
    const o = ref("o.0", optsT);
    const locals = [
      { id: "o.0", name: "o", type: optsT, mutable: false },
      { id: "s.0", name: "s", type: STRING, mutable: false },
      { id: "a.0", name: "a", type: arrayOf(STRING), mutable: false },
      { id: "e.0", name: "e", type: STRING, mutable: false },
    ];
    // pipe/ignore → the fd's mode; anything else throws (the literal
    // path's fence, moved to runtime). fd 1: pipe=1 (capture), ignore=0.
    // fd 2: pipe=1 (capture, no echo), ignore=2; the no-stdio default is
    // 1 for stdout and 0 (capture+echo) for stderr.
    const modeStmts = (s: IrExpr): IrStmt[] => [
      { kind: "if", cond: strEq(s, "pipe"), then: [{ kind: "return", value: num(1), loc }], else_: null, loc },
      {
        kind: "if",
        cond: strEq(s, "ignore"),
        then: [{ kind: "return", value: num(fd === 1 ? 0 : 2), loc }],
        else_: null,
        loc,
      },
      throwType(concat(concat(str('execSync stdio "'), s), str('" has no static lowering ("pipe" and "ignore" are the supported modes)'))),
    ];
    const body: IrStmt[] = [];
    if (fd === 1) {
      // The encoding gate rides the first helper call: outputs are
      // captured utf8, and a runtime encoding this lowering would
      // mislabel throws instead.
      body.push({
        kind: "varDecl",
        localId: "e.0",
        init: { kind: "recordGet", obj: o, shapeId, field: "encoding", type: STRING, loc },
        loc,
      });
      body.push({
        kind: "if",
        cond: {
          kind: "logical",
          op: "&&",
          left: { kind: "strEq", negated: true, left: ref("e.0", STRING), right: str("utf8"), type: BOOL, loc },
          right: { kind: "strEq", negated: true, left: ref("e.0", STRING), right: str("utf-8"), type: BOOL, loc },
          type: BOOL,
          loc,
        },
        then: [
          throwType(concat(concat(str('execSync output is captured as utf8 — encoding "'), ref("e.0", STRING)), str('" has no static lowering'))),
        ],
        else_: null,
        loc,
      });
    }
    if (stdioT.kind !== "union") throw new Error("emitter bug: exec-options stdio is not a union");
    const uTag = L.armTag(stdioT.unionId, UNDEFINED_T);
    const sTag = L.armTag(stdioT.unionId, STRING);
    const aTag = L.armTag(stdioT.unionId, arrayOf(STRING));
    const sd: IrExpr = { kind: "recordGet", obj: o, shapeId, field: "stdio", type: stdioT, loc };
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId: stdioT.unionId, tag: uTag, negated: false, value: sd, type: BOOL, loc },
      then: [{ kind: "return", value: num(fd === 1 ? 1 : 0), loc }],
      else_: null,
      loc,
    });
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId: stdioT.unionId, tag: sTag, negated: false, value: sd, type: BOOL, loc },
      then: [
        { kind: "varDecl", localId: "s.0", init: { kind: "unionNarrow", unionId: stdioT.unionId, tag: sTag, value: sd, type: STRING, loc }, loc },
        ...modeStmts(ref("s.0", STRING)),
      ],
      else_: null,
      loc,
    });
    body.push({
      kind: "varDecl",
      localId: "a.0",
      init: { kind: "unionNarrow", unionId: stdioT.unionId, tag: aTag, value: sd, type: arrayOf(STRING), loc },
      loc,
    });
    const aRef = ref("a.0", arrayOf(STRING));
    const lenGt: IrExpr = {
      kind: "bin",
      op: "<",
      left: num(fd),
      right: { kind: "arrIntrinsic", method: "length", receiver: aRef, args: [], type: F64, loc },
      type: BOOL,
      loc,
    };
    body.push({
      kind: "if",
      cond: { kind: "unary", op: "!", operand: lenGt, type: BOOL, loc },
      then: [{ kind: "return", value: num(1), loc }],
      else_: null,
      loc,
    });
    body.push(...modeStmts({ kind: "arrayGet", arr: aRef, index: num(fd), type: STRING, loc }));
    L.liftedFns.push({
      name,
      params: [{ localId: "o.0", name: "o", type: optsT }],
      returnType: F64,
      locals,
      body,
      loc,
    });
    return name;
  }

/** `const execFileAsync = promisify(execFile)` — the ONE lowered
   * util.promisify shape. Returns true (and registers the declared symbol
   * so call sites lower and value uses fence) when `init` is a promisify
   * call over a child_process.execFile import binding; a promisify call
   * over anything else fences HERE with the supported-target hint (the
   * declaration is where the target is visible). False for non-promisify
   * initializers, so the ordinary declaration paths apply. */
  export function isPromisifyCall(L: Lowerer, init: ts.Expression): ts.CallExpression | null {
    let e: ts.Expression = init;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || e.questionDotToken) return null;
    if (!ts.isIdentifier(e.expression)) return null;
    const bi = L.builtinImportOf(e.expression);
    if (!bi || bi.module !== "util" || bi.member !== "promisify") return null;
    return e;
  }

  export function promisifiedExecFileDecl(L: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    if (!init) return false;
    // The OTHER special const-binding form this decl hook serves: the
    // `const requestFn = tls ? https.request : http.request` client
    // ternary (lower-server.ts's registry) — calls through it lower as
    // the runtime-secure http client.
    if (registerHttpClientFnBinding(L, nameNode, init)) return true;
    const e = isPromisifyCall(L, init);
    if (!e) return false;
    const argNode = e.arguments.length === 1 ? e.arguments[0]! : null;
    const target = argNode && ts.isIdentifier(argNode) ? L.builtinImportOf(argNode) : null;
    if (!target || target.module !== "child_process" || target.member !== "execFile") {
      L.noLowering(
        "util.promisify of this target",
        argNode ?? e,
        "child_process.execFile is the one promisifiable target: const execFileAsync = promisify(execFile)",
      );
    }
    const symbol = L.checker.getSymbolAtLocation(nameNode);
    if (symbol) L.promisifiedExecFile.add(symbol);
    return true;
  }

/** A call THROUGH a promisified-execFile binding:
   * `execFileAsync(file, args?, options?)` → one call of the interned
   * %execFileAsync helper — an ASYNC IR function (throw-becomes-rejection
   * for free) that runs the exec core synchronously and returns
   * `{ stdout, stderr }`, exactly Node's promisified execFile behind an
   * already-settled promise (the fs/promises stance, divergence 23).
   * Options are the exec-sync slice minus stdio (the async form always
   * captures both streams, no echo): encoding must spell utf8, cwd/env/
   * timeout lower, maxBuffer/windowsHide are accepted no-ops, killSignal
   * only as its SIGTERM default. Rejections carry Node's async messages
   * ("Command failed: <cmd>\n<stderr>" — the trailing newline is Node's —
   * and "spawn <file> ENOENT" with .code); Node's numeric `.code` on a
   * Command-failed rejection (the exit status) is NOT carried —
   * SEMANTICS.md divergence 50's stance. */
  export function lowerExecFileAsyncCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (expr.arguments.length < 1 || expr.arguments.length > 3 || expr.arguments.some(ts.isSpreadElement)) {
      L.noLowering(
        "the promisified execFile with this argument shape",
        expr,
        "the supported form is execFileAsync(file, args?, options?)",
      );
    }
    const cmd = L.lowerExprExpecting(expr.arguments[0]!, STRING);
    const argv = L.lowerChildArgsArg(expr.arguments[1], loc);
    const optsNode = expr.arguments[2];

    const bool = (v: boolean): IrExpr => ({ kind: "boolLit", value: v, type: BOOL, loc });
    const num = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
    const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
    const helper = execFileAsyncHelper(L, loc);
    const envRecT: IrType = { kind: "record", shapeId: helper.envShapeId };
    const envRec = (has: boolean, pairs: IrExpr): IrExpr => ({
      kind: "recordLit",
      fields: [
        { name: "has", value: bool(has) },
        { name: "pairs", value: pairs },
      ],
      type: envRecT,
      loc,
    });
    const emptyPairs = (): IrExpr => ({ kind: "arrayLit", elems: [], type: arrayOf(STRING), loc });
    let cwd: IrExpr = emptyStr;
    let env: IrExpr = envRec(false, emptyPairs());
    let timeout: IrExpr = num(0);
    if (optsNode) {
      if (!ts.isObjectLiteralExpression(optsNode)) {
        L.noLowering(
          "the promisified execFile with a non-literal options argument",
          optsNode,
          "pass the options inline so each member can be checked",
        );
      }
      for (const p of optsNode.properties) {
        // The conditional-spread idiom carrying `env` — the portless
        // opensslAsync shape: `...(c ? { env: { ...process.env, ...extra
        // } } : {})` (either orientation). The condition evaluates ONCE
        // and picks between the has-env record (whose pairs build lazily
        // in that arm — tsc's narrowing of the condition holds there) and
        // the inherit-parent default, exactly the spread's semantics.
        if (ts.isSpreadAssignment(p)) {
          const cs = conditionalSpreadOf(p.expression);
          if (cs !== null && cs !== "unsupported" && cs.props.length === 1 &&
              cs.props[0]!.name.text === "env" && ts.isPropertyAssignment(cs.props[0]!)) {
            const cond = L.lowerCondition(cs.cond);
            const carried = envRec(true, L.recordToEnvPairs((cs.props[0] as ts.PropertyAssignment).initializer));
            const absent = envRec(false, emptyPairs());
            env = {
              kind: "ternary",
              cond,
              then: cs.whenTrue ? carried : absent,
              else_: cs.whenTrue ? absent : carried,
              type: envRecT,
              loc,
            };
            continue;
          }
          L.noLowering(
            "the promisified execFile with this options spread",
            p,
            "the one supported spread is the conditional `...(c ? { env: ... } : {})` (either orientation) — write other members inline",
          );
        }
        const m = optionMember(p);
        if (!m) {
          L.noLowering(
            "the promisified execFile with this options shape",
            p,
            "spreads and computed keys have no lowering — write each member inline",
          );
        }
        switch (m.name) {
          case "encoding": {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
              L.noLowering(
                "the promisified execFile with a non-utf8 encoding",
                m.value,
                'outputs are captured as utf8 — pass { encoding: "utf8" } (Node\'s own default here)',
              );
            }
            break;
          }
          case "cwd":
            cwd = L.lowerExprExpecting(m.value, STRING);
            break;
          case "env":
            env = envRec(true, L.recordToEnvPairs(m.value));
            break;
          case "timeout":
            timeout = L.lowerExprExpecting(m.value, F64);
            break;
          case "maxBuffer":
            L.lowerExpr(m.value); // accepted, not enforced (divergence 50)
            break;
          case "windowsHide":
            L.lowerExpr(m.value); // Node no-op on POSIX
            break;
          case "killSignal": {
            const t = L.typeOf(m.value);
            if (!t.isStringLiteralType() || t.value !== "SIGTERM") {
              L.noLowering(
                "the promisified execFile with a non-default killSignal",
                m.value,
                "only the SIGTERM default is implemented for the timeout kill",
              );
            }
            break;
          }
          default:
            L.noLowering(
              `the promisified execFile option '${m.name}'`,
              p,
              "encoding, cwd, env, timeout, and maxBuffer are the supported options",
            );
        }
      }
    }
    return {
      kind: "call",
      callee: helper.name,
      args: [cmd, argv, cwd, env, timeout],
      type: { kind: "promise", inner: { kind: "record", shapeId: helper.shapeId } },
      loc,
    };
  }

/** The interned `%execFileAsync` helper behind promisified-execFile
   * calls: an ASYNC IR function (params: cmd, argv, cwd, hasEnv, envPairs,
   * timeoutMs) whose body runs the may-throw cp.execCapture libCall — the
   * async machinery turns a throw into the rejection, Node's promisified
   * behavior — and returns the `{ stdout, stderr }` record built from the
   * capture. One helper per program (the shape is fixed). */
  export function execFileAsyncHelper(L: Lowerer, loc: SrcLoc): { name: string; shapeId: string; envShapeId: string } {
    const shapeId = L.shapes.intern([
      { name: "stderr", type: STRING },
      { name: "stdout", type: STRING },
    ]);
    // The env choice travels as ONE {has, pairs} record so a conditional
    // env spread's condition evaluates exactly once at the call site (has
    // and pairs both derive from it).
    const envShapeId = L.shapes.intern([
      { name: "has", type: BOOL },
      { name: "pairs", type: arrayOf(STRING) },
    ]);
    const key = "execFileAsync";
    const existing = L.widthHelpers.get(key);
    if (existing) return { name: existing, shapeId, envShapeId };
    const name = `%execFileAsync.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const recT: IrType = { kind: "record", shapeId };
    const envRecT: IrType = { kind: "record", shapeId: envShapeId };
    const strArrT = arrayOf(STRING);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "r.0",
        init: {
          kind: "libCall",
          fn: "cp.execCapture",
          args: [
            ref("cmd.0", STRING),
            ref("argv.0", strArrT),
            ref("cwd.0", STRING),
            { kind: "recordGet", obj: ref("env.0", envRecT), shapeId: envShapeId, field: "has", type: BOOL, loc },
            { kind: "recordGet", obj: ref("env.0", envRecT), shapeId: envShapeId, field: "pairs", type: strArrT, loc },
            ref("timeout.0", F64),
          ],
          type: SPAWNRES_T,
          loc,
        },
        loc,
      },
      {
        kind: "return",
        value: {
          kind: "recordLit",
          fields: [
            { name: "stderr", value: { kind: "libCall", fn: "spawnRes.stderr", args: [ref("r.0", SPAWNRES_T)], type: STRING, loc } },
            { name: "stdout", value: { kind: "libCall", fn: "spawnRes.stdout", args: [ref("r.0", SPAWNRES_T)], type: STRING, loc } },
          ],
          type: recT,
          loc,
        },
        loc,
      },
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "cmd.0", name: "cmd", type: STRING },
        { localId: "argv.0", name: "argv", type: strArrT },
        { localId: "cwd.0", name: "cwd", type: STRING },
        { localId: "env.0", name: "env", type: envRecT },
        { localId: "timeout.0", name: "timeout", type: F64 },
      ],
      returnType: recT,
      async: true,
      locals: [
        { id: "cmd.0", name: "cmd", type: STRING, mutable: false },
        { id: "argv.0", name: "argv", type: strArrT, mutable: false },
        { id: "cwd.0", name: "cwd", type: STRING, mutable: false },
        { id: "env.0", name: "env", type: envRecT, mutable: false },
        { id: "timeout.0", name: "timeout", type: F64, mutable: false },
        { id: "r.0", name: "r", type: SPAWNRES_T, mutable: false },
      ],
      body,
      loc,
    });
    return { name, shapeId, envShapeId };
  }

/** An `env` option object → the [k, v, ...] pairs array cp.execSync
   * consumes. The value must be a record (an index-signature ProcessEnv
   * snapshot — `{ ...process.env, X: y }` — or a plain string-map): its
   * string-typed fields and, for index-signature shapes, overflow entries
   * flatten in JS own-key order, undefined-armed values SKIPPED (Node
   * drops undefined env entries). Reuses the interned overflow-keys/read
   * machinery. */
  export function recordToEnvPairs(L: Lowerer, node: ts.Expression): IrExpr {
    const v = L.lowerExpr(node);
    if (v.type.kind !== "record") {
      L.noLowering(
        `an env option of '${L.fmt(v.type)}' values`,
        node,
        "pass a string-keyed object (spread process.env or build a Record<string, string>)",
      );
    }
    const helper = L.envToPairsHelper(v.type.shapeId, locOf(node));
    if (helper === null) {
      L.noLowering(
        `an env option of '${L.fmt(v.type)}' values`,
        node,
        "env fields must be strings (or string | undefined)",
      );
    }
    return { kind: "call", callee: helper, args: [v], type: arrayOf(STRING), loc: locOf(node) };
  }

/** True when `node`'s checker type is readline's Interface (stdlib
   * provenance + the enclosing "readline" ambient module — the name alone
   * is too generic). The interface maps to an f64 handle, so the IR type
   * cannot discriminate it from a plain number. */
  function isReadlineTyped(L: Lowerer, node: ts.Expression): boolean {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym?.name !== "Interface") return false;
    return L.checker.declarationsOf(sym).some((d) => {
      if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
      if (!L.isStdlibFile(d.getSourceFile())) return false;
      let up: ts.Node | undefined = d.parent;
      while (up) {
        if (ts.isModuleDeclaration(up) && ts.isStringLiteral(up.name)) {
          return up.name.text === "readline" || up.name.text === "node:readline";
        }
        up = up.parent;
      }
      return false;
    });
  }

/** Method calls on readline Interface receivers: `rl.question(query, cb)`
   * writes the query to stdout and delivers the next stdin line's text to
   * the callback (one (answer: string) parameter, or none); `rl.close()`
   * fires the 'close' listeners synchronously (Node's inline emit) and
   * releases the loop; `rl.on("close", cb)` registers a zero-arg
   * listener. Everything else the lib declares (on("line"), prompt,
   * setPrompt, ...) fences member-qualified. Null for non-Interface
   * receivers. */
  /** The channel-name argument of the diagnostics_channel surface: a
   * string (dyn names ride the validated extraction — Node's non-string
   * names would throw ERR_INVALID_ARG_TYPE where the dynCheck throws its
   * annotated TypeError; symbol names have no lowering and fence through
   * the coercion's own rejection). */
  function dcChannelNameArg(L: Lowerer, node: ts.Expression): IrExpr {
    return L.lowerExprExpecting(node, STRING);
  }

  /** A diagnostics_channel subscriber as a dyn value: dyn callables pass
   * through (test/common's mustCall wrapper — an untyped JS function
   * value), boxable typed closures ride dynFrom. Identity is preserved
   * either way, so unsubscribe(fn) finds the subscribe(fn) entry. */
  function dcSubscriberArg(L: Lowerer, node: ts.Expression): IrExpr {
    // The stdlib GLOBAL setImmediate as a function value (the Node-suite
    // traceCallback shape): a minted native dyn callable — the identifier
    // has no other first-class story.
    if (ts.isIdentifier(node) && node.text === "setImmediate") {
      const sym = L.checker.getSymbolAtLocation(node);
      const decls = sym ? L.checker.declarationsOf(sym) : [];
      if (decls.length > 0 && decls.every((d) => L.isStdlibFile(d.getSourceFile()))) {
        return { kind: "libCall", fn: "timers.setImmediateFnValue", args: [], type: DYN, loc: locOf(node) };
      }
    }
    const cb = L.lowerExpr(node);
    if (cb.type.kind === "dyn") return cb;
    if (
      cb.type.kind === "func" &&
      canBoxFuncIntoDyn(cb.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
    ) {
      return { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) };
    }
    L.unsupported(
      "SC1090",
      node,
      `channel subscribers of type '${L.fmt(cb.type)}' (subscribers cross as dyn functions — parameters must be dyn-representable)`,
    );
  }

  /** A published message as a dyn value: dyn passes through, everything
   * in the dynFrom domain (JSON-safe data, bytes, %Error, boxable
   * functions, handle kinds) boxes; the rest fences with the domain named. */
  function dcMessageArg(L: Lowerer, node: ts.Expression): IrExpr {
    // An explicit `undefined` argument (tracePromise(fn, ctx, undefined,
    // ...args) — Node's own no-this spelling) is the undefined dyn value,
    // exactly what an omitted slot defaults to.
    if (ts.isIdentifier(node) && node.text === "undefined") {
      return dynUndefinedExpr(locOf(node));
    }
    const msg = L.lowerExpr(node);
    if (msg.type.kind === "dyn") return msg;
    if (canConvertToDyn(msg.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
      return { kind: "dynFrom", value: msg, type: DYN, loc: locOf(node) };
    }
    L.unsupported(
      "SC1090",
      node,
      `publishing '${L.fmt(msg.type)}' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions)`,
    );
  }

  /** True when `node`'s checker type is diagnostics_channel's Channel
   * (stdlib provenance plus the ambient module, the readline.Interface
   * technique — the value itself is an f64 handle, types.ts). */
  function isDcChannelTyped(L: Lowerer, node: ts.Expression): boolean {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym?.name !== "Channel") return false;
    return L.checker.declarationsOf(sym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        L.isStdlibFile(d.getSourceFile()),
    );
  }

  /** Method calls on diagnostics_channel Channel receivers:
   * publish(message), subscribe(fn), unsubscribe(fn) — over the f64
   * channel handle. The rest of the declared surface (bindStore,
   * runStores) fences member-qualified. Null for non-Channel receivers. */
  export function lowerDcChannelMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!isDcChannelTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "publish" && call.arguments.length === 1) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const msg = dcMessageArg(L, call.arguments[0]!);
      return { kind: "libCall", fn: "dc.publish", args: [receiver, msg], type: VOID, loc };
    }
    if ((name === "subscribe" || name === "unsubscribe") && call.arguments.length === 1) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const cb = dcSubscriberArg(L, call.arguments[0]!);
      return name === "subscribe"
        ? { kind: "libCall", fn: "dc.chanSubscribe", args: [receiver, cb], type: VOID, loc }
        : { kind: "libCall", fn: "dc.chanUnsubscribe", args: [receiver, cb], type: BOOL, loc };
    }
    // bindStore(store[, transform]) / unbindStore(store) / runStores(data,
    // fn[, thisArg[, ...args]]): the AsyncLocalStorage integration — the
    // store argument is the ALS f64 handle; the transform crosses as a
    // dyn function (absent = identity, the undefined dyn value); runStores
    // enters the bound stores, publishes inside them, and forwards
    // this/arguments to fn exactly like the trace calls.
    if ((name === "bindStore" || name === "unbindStore") &&
        call.arguments.length >= 1 && call.arguments.length <= (name === "bindStore" ? 2 : 1)) {
      if (!isAlsTyped(L, call.arguments[0]!)) {
        L.noLowering(
          `Channel.${name} with this store argument`,
          call.arguments[0]!,
          "an AsyncLocalStorage instance (node:async_hooks) is the supported store",
        );
      }
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const store = L.lowerExprExpecting(call.arguments[0]!, F64);
      if (name === "unbindStore") {
        return { kind: "libCall", fn: "dc.chanUnbindStore", args: [receiver, store], type: BOOL, loc };
      }
      const transform: IrExpr = call.arguments[1] !== undefined
        ? dcSubscriberArg(L, call.arguments[1]!)
        : dynUndefinedExpr(loc);
      return { kind: "libCall", fn: "dc.chanBindStore", args: [receiver, store, transform], type: VOID, loc };
    }
    if (name === "runStores" && call.arguments.length >= 2) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const data = dcMessageArg(L, call.arguments[0]!);
      const fn = dcSubscriberArg(L, call.arguments[1]!);
      const thisArg: IrExpr = call.arguments[2] !== undefined
        ? dcMessageArg(L, call.arguments[2]!)
        : dynUndefinedExpr(loc);
      const rest = dcTraceArgsArr(L, call.arguments.slice(3), loc);
      return { kind: "libCall", fn: "dc.chanRunStores", args: [receiver, data, fn, thisArg, rest], type: DYN, loc };
    }
    L.noLowering(
      `Channel.${name}`,
      call,
      "publish(message), subscribe(fn), unsubscribe(fn), bindStore/unbindStore/runStores, and the name/hasSubscribers reads are the supported Channel members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

  /** True when `node`'s checker type is async_hooks' AsyncLocalStorage
   * (the Channel detection's shape — the value is an f64 store handle,
   * types.ts). */
  function isAlsTyped(L: Lowerer, node: ts.Expression): boolean {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym?.name !== "AsyncLocalStorage") return false;
    return L.checker.declarationsOf(sym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        L.isStdlibFile(d.getSourceFile()),
    );
  }

  /** Method calls on AsyncLocalStorage receivers: run(store, fn, ...args),
   * exit(fn, ...args), getStore(), enterWith(store), disable() — over the
   * f64 store handle (als.* libCalls; values cross as dyn values). Null
   * for non-ALS receivers. */
  export function lowerAlsMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!isAlsTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "getStore" && call.arguments.length === 0) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      return { kind: "libCall", fn: "als.get", args: [receiver], type: DYN, loc };
    }
    if (name === "run" && call.arguments.length >= 2) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const value = dcMessageArg(L, call.arguments[0]!);
      const fn = dcSubscriberArg(L, call.arguments[1]!);
      const rest = dcTraceArgsArr(L, call.arguments.slice(2), loc);
      return { kind: "libCall", fn: "als.run", args: [receiver, value, fn, rest], type: DYN, loc };
    }
    if (name === "exit" && call.arguments.length >= 1) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const fn = dcSubscriberArg(L, call.arguments[0]!);
      const rest = dcTraceArgsArr(L, call.arguments.slice(1), loc);
      return { kind: "libCall", fn: "als.exitRun", args: [receiver, fn, rest], type: DYN, loc };
    }
    if (name === "enterWith" && call.arguments.length === 1) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const value = dcMessageArg(L, call.arguments[0]!);
      return { kind: "libCall", fn: "als.enterWith", args: [receiver, value], type: VOID, loc };
    }
    if (name === "disable" && call.arguments.length === 0) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      return { kind: "libCall", fn: "als.disable", args: [receiver], type: VOID, loc };
    }
    L.noLowering(
      `AsyncLocalStorage.${name}`,
      call,
      "run(store, fn, ...args), exit(fn, ...args), getStore(), enterWith(store), and disable() are the supported AsyncLocalStorage members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

  /** Property reads on Channel receivers: `.name` (the registration
   * string) and `.hasSubscribers` (the publish guard). Null for
   * non-Channel receivers and other members (the method fence owns them). */
  export function lowerDcChannelProperty(L: Lowerer, access: ts.PropertyAccessExpression): IrExpr | null {
    if (access.questionDotToken) return null;
    const name = access.name.text;
    if (name !== "name" && name !== "hasSubscribers") return null;
    if (!isDcChannelTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(access);
    const receiver = L.lowerExprExpecting(access.expression, F64);
    return name === "name"
      ? { kind: "libCall", fn: "dc.chanName", args: [receiver], type: STRING, loc }
      : { kind: "libCall", fn: "dc.chanHasSubscribers", args: [receiver], type: BOOL, loc };
  }

  /** True when `node`'s checker type is diagnostics_channel's
   * TracingChannel (the Channel detection's shape — the value is an f64
   * handle into the tracing registry, types.ts). */
  function isDcTracingChannelTyped(L: Lowerer, node: ts.Expression): boolean {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym?.name !== "TracingChannel") return false;
    return L.checker.declarationsOf(sym).some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        L.isStdlibFile(d.getSourceFile()),
    );
  }

  const DC_TRACE_EVENTS = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;

  /** A TracingChannel handlers object as a dyn value: dyn passes through;
   * an INLINE object literal of plain event-name properties builds the checked-dynamic tree
   * object member-by-member (each value through the message conversion —
   * closures box by identity, so unsubscribe still matches), covering the
   * `{ start: () => {} }` spelling whose record type (function members)
   * has no whole-value conversion. Everything else rides dcMessageArg. */
  function dcHandlersArg(L: Lowerer, node: ts.Expression): IrExpr {
    let e = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (
      ts.isObjectLiteralExpression(e) &&
      L.mapTypeOf(L.typeOf(e))?.kind === "record" &&
      e.properties.length > 0 &&
      e.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
    ) {
      const loc = locOf(e);
      return {
        kind: "dynObjLit",
        fields: e.properties.map((p) => {
          const pa = p as ts.PropertyAssignment;
          return {
            key: { kind: "strLit", value: (pa.name as ts.Identifier).text, type: STRING, loc: locOf(pa) },
            value: dcMessageArg(L, pa.initializer),
          };
        }),
        type: DYN,
        loc,
      };
    }
    return dcMessageArg(L, node);
  }

  /** A trace-call argument list's tail as ONE dyn array (dynArrLit over
   * per-element conversions). Spread arguments fence — the built array
   * must mirror the call site's argument vector exactly. */
  function dcTraceArgsArr(L: Lowerer, args: readonly ts.Expression[], loc: SrcLoc): IrExpr {
    const elems = args.map((a) => {
      if (ts.isSpreadElement(a)) {
        L.noLowering(
          "trace calls with spread arguments",
          a,
          "write the traced arguments positionally",
        );
      }
      return dcMessageArg(L, a);
    });
    return { kind: "dynArrLit", elems, type: DYN, loc };
  }

  /** Method calls on TracingChannel receivers: subscribe/unsubscribe over
   * a dyn handlers object, traceSync/traceCallback through the runtime's
   * publish choreography (dc.tcTraceSync/dc.tcTraceCallback — fn, context,
   * thisArg, and the argument vector all cross as dyn values; context
   * defaults to a fresh `{}` and thisArg to undefined, Node's defaults),
   * and tracePromise through the reaction-fiber choreography
   * (dc.tcTracePromise — the result is the reaction promise, typed
   * promise<dyn> so .then/.catch chains ride the promise lowerings).
   * Null for non-TracingChannel receivers. */
  export function lowerDcTracingChannelMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!isDcTracingChannelTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if ((name === "subscribe" || name === "unsubscribe") && call.arguments.length === 1) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const handlers = dcHandlersArg(L, call.arguments[0]!);
      return name === "subscribe"
        ? { kind: "libCall", fn: "dc.tcSubscribe", args: [receiver, handlers], type: VOID, loc }
        : { kind: "libCall", fn: "dc.tcUnsubscribe", args: [receiver, handlers], type: BOOL, loc };
    }
    if ((name === "traceSync" || name === "traceCallback" || name === "tracePromise") &&
        call.arguments.length >= 1) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const fn = dcSubscriberArg(L, call.arguments[0]!);
      // traceSync(fn, context?, thisArg?, ...args) /
      // tracePromise(fn, context?, thisArg?, ...args) /
      // traceCallback(fn, position?, context?, thisArg?, ...args)
      const shift = name === "traceCallback" ? 1 : 0;
      const ctxNode = call.arguments[1 + shift];
      const thisNode = call.arguments[2 + shift];
      const ctx: IrExpr = ctxNode !== undefined
        ? dcMessageArg(L, ctxNode)
        : { kind: "dynObjLit", fields: [], type: DYN, loc };
      const thisArg: IrExpr = thisNode !== undefined ? dcMessageArg(L, thisNode) : dynUndefinedExpr(loc);
      const rest = dcTraceArgsArr(L, call.arguments.slice(3 + shift), loc);
      if (name === "traceSync") {
        return { kind: "libCall", fn: "dc.tcTraceSync", args: [receiver, fn, ctx, thisArg, rest], type: DYN, loc };
      }
      if (name === "tracePromise") {
        // The runtime returns the REACTION promise (dyn payload), so the
        // call site's .then/.catch chains ride the promise<dyn> lowerings.
        // A non-promise traced return wraps (PromiseResolve, Node) — on
        // the no-subscriber early exit too, where Node returns it raw
        // (SEMANTICS.md).
        return {
          kind: "libCall",
          fn: "dc.tcTracePromise",
          args: [receiver, fn, ctx, thisArg, rest],
          type: { kind: "promise", inner: DYN },
          loc,
        };
      }
      const pos: IrExpr = call.arguments[1] !== undefined
        ? L.lowerExprExpecting(call.arguments[1]!, F64)
        : { kind: "numLit", value: -1, type: F64, loc };
      return {
        kind: "libCall",
        fn: "dc.tcTraceCallback",
        args: [receiver, fn, pos, ctx, thisArg, rest],
        type: DYN,
        loc,
      };
    }
    L.noLowering(
      `TracingChannel.${name}`,
      call,
      "subscribe(handlers), unsubscribe(handlers), traceSync(fn, ...), traceCallback(fn, ...), tracePromise(fn, ...), and the per-event channel/hasSubscribers reads are the supported TracingChannel members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

  /** Property reads on TracingChannel receivers: the five event channels
   * (`.start` … `.error` — Channel-typed f64 handles the Channel lowerings
   * take over) and `.hasSubscribers` (the five-channel disjunction). Null
   * for other members and non-TracingChannel receivers. */
  export function lowerDcTracingChannelProperty(L: Lowerer, access: ts.PropertyAccessExpression): IrExpr | null {
    if (access.questionDotToken) return null;
    const name = access.name.text;
    const idx = (DC_TRACE_EVENTS as readonly string[]).indexOf(name);
    if (idx < 0 && name !== "hasSubscribers") return null;
    if (!isDcTracingChannelTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(access);
    const receiver = L.lowerExprExpecting(access.expression, F64);
    return idx >= 0
      ? {
          kind: "libCall",
          fn: "dc.tcChannel",
          args: [receiver, { kind: "numLit", value: idx, type: F64, loc }],
          type: F64,
          loc,
        }
      : { kind: "libCall", fn: "dc.tcHasSubscribers", args: [receiver], type: BOOL, loc };
  }

  export function lowerReadlineMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!isReadlineTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "question" && call.arguments.length === 2) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const query = L.lowerExprExpecting(call.arguments[0]!, STRING);
      const cb = L.lowerExpr(call.arguments[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          "question callbacks with more than one parameter or a return value",
        );
      }
      const param = cb.type.params[0];
      if (param !== undefined && param.kind !== "string") {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          `question callbacks whose parameter is not 'string' (got '${L.fmt(param)}')`,
        );
      }
      return { kind: "libCall", fn: "rl.question", args: [receiver, query, cb], type: VOID, loc };
    }
    if (name === "close" && call.arguments.length === 0) {
      const receiver = L.lowerExprExpecting(access.expression, F64);
      return { kind: "libCall", fn: "rl.close", args: [receiver], type: VOID, loc };
    }
    if (name === "on" && call.arguments.length === 2) {
      const evT = L.typeOf(call.arguments[0]!);
      const event = evT.isStringLiteralType() ? evT.value : null;
      if (event !== "close") {
        L.noLowering(
          `readline.Interface.on(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
          call.arguments[0]!,
          '"close" is the supported readline event (question(query, cb) is the line consumer)',
        );
      }
      if (!ts.isExpressionStatement(call.parent)) {
        L.unsupported(
          "SC1090",
          call,
          "chaining readline listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      const receiver = L.lowerExprExpecting(access.expression, F64);
      const cb = L.lowerExpr(call.arguments[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 0) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          "close listeners with parameters or a return value (use ())",
        );
      }
      return { kind: "libCall", fn: "rl.onClose", args: [receiver, cb], type: VOID, loc };
    }
    L.noLowering(
      `readline.Interface.${name}`,
      call,
      'question(query, cb), close(), and on("close", cb) are the supported Interface members',
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** True when `node`'s checker type is the node:string_decoder
   * StringDecoder (stdlib provenance, the isTimeoutTyped technique) — the
   * decoder maps to its one-field pending record, so the IR type alone
   * cannot discriminate it from a user record. */
  function isStringDecoderTyped(L: Lowerer, node: ts.Expression): boolean {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym?.name !== "StringDecoder") return false;
    return L.checker.declarationsOf(sym).some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        L.isStdlibFile(d.getSourceFile()),
    );
  }

/** Method calls on StringDecoder receivers: `d.write(chunk)` decodes the
   * complete prefix of pending+chunk and re-buffers the trailing partial
   * sequence; `d.end()` flushes the buffered partial as its replacement
   * chars — Node's utf8 StringDecoder exactly (SEMANTICS.md), through the
   * interned %strdec helpers over the packed-f64 pending field. end(buf)
   * and the rest of @types/node's surface fence per member. Null for
   * non-decoder receivers. */
  export function lowerStringDecoderMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!isStringDecoderTyped(L, access.expression)) return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "write" && call.arguments.length === 1) {
      const receiver = L.lowerExpr(access.expression);
      if (receiver.type.kind !== "record") L.badType(access.expression, L.typeOf(access.expression));
      const chunk = L.lowerExpr(call.arguments[0]!);
      if (!(chunk.type.kind === "bytes" && chunk.type.elem === "u8")) {
        L.noLowering(
          `StringDecoder.write of '${L.fmt(chunk.type)}' data`,
          call.arguments[0]!,
          "Buffer/Uint8Array chunks decode (narrow unions first)",
        );
      }
      const helper = L.strdecHelper("write", receiver.type.shapeId, loc);
      return { kind: "call", callee: helper, args: [receiver, chunk], type: STRING, loc };
    }
    if (name === "end") {
      if (call.arguments.length !== 0) {
        L.noLowering(
          "StringDecoder.end with a buffer argument",
          call,
          "write the buffer, then end(): d.write(buf) + d.end() is Node's own equivalence",
        );
      }
      const receiver = L.lowerExpr(access.expression);
      if (receiver.type.kind !== "record") L.badType(access.expression, L.typeOf(access.expression));
      const helper = L.strdecHelper("end", receiver.type.shapeId, loc);
      return { kind: "call", callee: helper, args: [receiver], type: STRING, loc };
    }
    L.noLowering(
      `StringDecoder.${name}`,
      call,
      "write(buffer) and end() are the supported StringDecoder members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** The interned %strdec helpers: write(d, chunk) returns the decoded
   * complete prefix and re-buffers the trailing partial into the pending
   * field; end(d) flushes it. Both thread the packed-f64 state through
   * the pure strdec.* libCalls. */
  export function strdecHelper(L: Lowerer, op: "write" | "end", shapeId: string, loc: SrcLoc): string {
    const key = `strdec.${op}`;
    const existing = L.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%strdec.${op}.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const recT: IrType = { kind: "record", shapeId };
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const pendingRead = (): IrExpr => ({
      kind: "recordGet",
      obj: ref("d.0", recT),
      shapeId,
      field: "%pending",
      type: F64,
      loc,
    });
    const encRead = (): IrExpr => ({
      kind: "recordGet",
      obj: ref("d.0", recT),
      shapeId,
      field: "%enc",
      type: STRING,
      loc,
    });
    const params: { localId: string; name: string; type: IrType }[] = [
      { localId: "d.0", name: "d", type: recT },
    ];
    const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
      { id: "d.0", name: "d", type: recT, mutable: false },
      { id: "s.0", name: "s", type: STRING, mutable: false },
    ];
    let body: IrStmt[];
    if (op === "write") {
      params.push({ localId: "chunk.0", name: "chunk", type: BYTES_U8 });
      locals.splice(1, 0, { id: "chunk.0", name: "chunk", type: BYTES_U8, mutable: false });
      body = [
        {
          kind: "varDecl",
          localId: "s.0",
          init: { kind: "libCall", fn: "strdec.write", args: [encRead(), pendingRead(), ref("chunk.0", BYTES_U8)], type: STRING, loc },
          loc,
        },
        {
          kind: "recordSet",
          obj: ref("d.0", recT),
          shapeId,
          field: "%pending",
          value: { kind: "libCall", fn: "strdec.next", args: [encRead(), pendingRead(), ref("chunk.0", BYTES_U8)], type: F64, loc },
          loc,
        },
        { kind: "return", value: ref("s.0", STRING), loc },
      ];
    } else {
      body = [
        {
          kind: "varDecl",
          localId: "s.0",
          init: { kind: "libCall", fn: "strdec.end", args: [encRead(), pendingRead()], type: STRING, loc },
          loc,
        },
        {
          kind: "recordSet",
          obj: ref("d.0", recT),
          shapeId,
          field: "%pending",
          value: { kind: "numLit", value: 0, type: F64, loc },
          loc,
        },
        { kind: "return", value: ref("s.0", STRING), loc },
      ];
    }
    L.liftedFns.push({ name, params, returnType: STRING, locals, body, loc });
    return name;
  }

/** `JSON.parse(text)` / `JSON.stringify(value)`.
   * - parse → a may-throw `libCall` producing a dyn value (the runtime JSON
   *   dyn); malformed input throws a catchable SyntaxError-shaped string.
   *   The divergence override types the one-argument form `unknown`; the
   *   lib's reviver form typechecks (returning `any`) and is fenced here.
   * - stringify → the type-DIRECTED `jsonStringify` node: the lib
   *   signature honestly says `any`, but lowering requires the argument's
   *   STATIC IR type to be JSON-safe — the backend emits a per-type
   *   serializer, never a dynamic walk, so dyn (and closures/class
   *   instances) are rejected here with a specific message. The
   *   `stringify(v, null, space)` pretty-print form compiles when the
   *   replacer is the literal null (or undefined) and the space is a
   *   LITERAL — Node's rules apply at compile time (numbers clamp to 0–10
   *   spaces, strings truncate to 10 code units) and the resolved indent
   *   rides the node to the backend's re-indenter. Function replacers and
   *   non-literal spaces stay fenced.
   * Null when this isn't a JSON member call. */
  export function lowerJsonMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    const member = L.stdlibGlobalMember(access, "JSON");
    if (member === null) return null;
    const loc = locOf(call);
    if (member === "parse" && call.arguments.length !== 1) {
      L.noLowering(
        "JSON.parse with a reviver",
        call,
        "parse to `unknown` and validate with a checked cast ('as T') instead",
      );
    }
    if (member === "parse") {
      const text = L.lowerExprExpecting(call.arguments[0]!, STRING);
      return { kind: "libCall", fn: "json.parse", args: [text], type: DYN, loc };
    }
    if (member === "stringify") {
      const indent = stringifySpaceIndent(L, call);
      const argNode = call.arguments[0]!;
      const value = L.lowerExpr(argNode);
      // An ISLAND value (`JSON.stringify(err)` on a package handle — the
      // island error-inspection idiom): the ENGINE's own JSON.stringify
      // runs, so key order, nesting, toJSON, and getters match Node by
      // construction, and the result converts to a static string through
      // the engine's own ToString — a root the stringify DROPS (undefined,
      // a bare function, a symbol) produces the TEXT "undefined" where
      // Node produces the undefined VALUE, exactly the dyn-root rule
      // (SEMANTICS.md 285: tsc's own lib types the return `string`, so no
      // statically-typed consumer can distinguish them). The compile-time-
      // resolved indent rides as the engine's own space argument.
      if (value.type.kind === "jsval") {
        const json: IrExpr = { kind: "jsOp", op: "globalGet", name: "JSON", args: [], type: JSVAL, loc };
        const args: IrExpr[] = [json, value];
        if (indent !== "") {
          args.push(
            { kind: "jsOp", op: "nullLit", args: [], type: JSVAL, loc },
            { kind: "jsMarshal", value: { kind: "strLit", value: indent, type: STRING, loc }, type: JSVAL, loc },
          );
        }
        const raw: IrExpr = { kind: "jsOp", op: "callMethod", name: "stringify", args, type: JSVAL, loc };
        return { kind: "jsOp", op: "toStr", args: [raw], type: STRING, loc };
      }
      // A dyn ROOT (`JSON.stringify(u)` over unknown / `{}` / `Object` /
      // `object` slots, the JSON.parse round-trip) serializes with the
      // runtime's dyn walker instead of a type-directed serializer — the
      // dyn is JSON-representable by construction (non-JSON values fenced
      // at their conversion INTO the slot). Two edges, both documented:
      // a root the stringify drops (runtime undefined) produces the TEXT
      // "undefined" where Node produces the undefined VALUE (tsc's own lib
      // types the return `string`, so no static consumer can tell), and a
      // runtime handle inside the tree throws (Node would walk its own
      // enumerable props, which the handle does not model).
      if (!L.jsonSafe(value.type) && value.type.kind !== "dyn") {
        // Bare undefined-armed unions get their own wording: Node's
        // stringify of bare undefined is not a string at all — per-type
        // serialization cannot match that exactly, so the fence is
        // deliberate, not a gap. (Undefined-armed RECORD FIELDS pass the
        // fence: the field drops from the output, exactly Node.)
        if (L.bareUndefinedArmedUnion(value.type)) {
          L.unsupported(
            "SC1090",
            argNode,
            `JSON.stringify of '${L.fmt(value.type)}' values ` +
              `(Node's stringify of bare undefined is not a string at all — ` +
              `narrow with '!== undefined' first, model absence with a null arm, ` +
              `or use an optional record field ('{ a?: string }'), which drops ` +
              `from the output like Node's)`,
          );
        }
        L.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify of '${L.fmt(value.type)}' values ` +
            `(only number, string, boolean, records, arrays, unions of those, and 'unknown' stringify)`,
        );
      }
      const node: IrExpr = { kind: "jsonStringify", value, type: STRING, loc };
      if (indent !== "") {
        // The compile-time-resolved indent rides as an extra property (the
        // node shape in ir/nodes.ts is unchanged); the backend re-indents
        // the compact serializer output with Node's gap algorithm.
        (node as { indent?: string }).indent = indent;
      }
      return node;
    }
    return null; // unknown members are tsc errors before lowering
  }

/** The compile-time indent of a `JSON.stringify(v[, replacer[, space]])`
   * call, with Node's space rules applied: a number clamps to 0–10 spaces
   * (ToInteger truncation), a string truncates to its first 10 code units,
   * and null/undefined/0/"" mean compact ("" here). Only literal
   * replacer/space spellings compile — the replacer must be `null` (or
   * `undefined`), the space a numeric/string literal or `null`/`undefined`;
   * everything else keeps the existing fence. */
  function stringifySpaceIndent(L: Lowerer, call: ts.CallExpression): string {
    const fence = (): never =>
      L.noLowering(
        "JSON.stringify with replacer/space parameters",
        call,
        "the serializer is type-directed — shape the value before stringifying",
      );
    if (call.arguments.length <= 1) return "";
    const unwrap = (e: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
    const isUndefined = (e: ts.Expression): boolean =>
      ts.isIdentifier(e) && e.text === "undefined";
    const replacer = unwrap(call.arguments[1]!);
    if (replacer.kind !== ts.SyntaxKind.NullKeyword && !isUndefined(replacer)) fence();
    if (call.arguments.length === 2) return "";
    const space = unwrap(call.arguments[2]!);
    if (space.kind === ts.SyntaxKind.NullKeyword || isUndefined(space)) return "";
    if (ts.isNumericLiteral(space)) {
      const n = Number(space.text.replace(/_/g, ""));
      return " ".repeat(Math.min(10, Math.max(0, Math.trunc(n))));
    }
    // A negative space literal (`-2`) clamps to 0 — compact, like Node.
    if (
      ts.isPrefixUnaryExpression(space) &&
      space.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(unwrap(space.operand))
    ) {
      return "";
    }
    if (ts.isStringLiteral(space) || ts.isNoSubstitutionTemplateLiteral(space)) {
      return space.text.slice(0, 10); // first 10 code units, like Node
    }
    fence();
    throw new Error("unreachable"); // fence() never returns
  }

/** The module specifier when `ident` is an import binding (named,
   * default, or namespace) from a node BUILTIN module with no scriptc
   * support — "child_process", "net", ... — or null. The coverage story's
   * use-site half: preflight fenced the import line; statements using the
   * binding poison with the same module-naming diagnostic. */
  export function fencedBuiltinImportOf(L: Lowerer, ident: ts.Identifier): string | null {
    const symbol = L.checker.getSymbolAtLocation(ident);
    const decl = symbol ? L.checker.declarationsOf(symbol)[0] : undefined;
    if (!decl) return null;
    // The CommonJS twins: `const x = require("net")` and
    // `const { createServer } = require("net")` — the require statement
    // was fenced at preflight; uses of the bindings poison with the same
    // module name.
    {
      const varDecl = ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)
        ? decl.parent.parent
        : decl;
      if (ts.isVariableDeclaration(varDecl) && varDecl.initializer !== undefined) {
        const spec = requireSpecOf(varDecl.initializer);
        if (spec !== null) {
          const isBuiltin = spec.startsWith("node:") || builtinModules.includes(spec);
          return isBuiltin && canonicalBuiltinModule(spec) === null ? spec : null;
        }
      }
    }
    let importDecl: ts.Node;
    if (ts.isImportSpecifier(decl)) importDecl = decl.parent.parent.parent;
    else if (ts.isNamespaceImport(decl)) importDecl = decl.parent.parent;
    else if (ts.isImportClause(decl)) importDecl = decl.parent;
    else return null;
    if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }
    const spec = importDecl.moduleSpecifier.text;
    const isBuiltin = spec.startsWith("node:") || builtinModules.includes(spec);
    if (!isBuiltin || canonicalBuiltinModule(spec) !== null) return null;
    return spec;
  }

/** The composed crypto pattern: `randomBytes(n).toString(enc)` lowers
   * as ONE string-producing libCall — the Buffer between the two calls
   * never exists at runtime. Only literal "hex"/"base64" encodings lower
   * (the runtime implements exactly those); everything else — including a
   * bare randomBytes(n) — fences with the Buffer story. Null when this
   * isn't a toString on a crypto.randomBytes call. */
  export function lowerCryptoComposedCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text === "digest") return lowerHashDigestChain(L, call, access);
    if (access.name.text !== "toString") return null;
    const recv = access.expression;
    if (!ts.isCallExpression(recv) || recv.questionDotToken) return null;
    if (!ts.isIdentifier(recv.expression)) return null;
    const bi = L.builtinImportOf(recv.expression);
    if (!bi || bi.module !== "crypto" || bi.member !== "randomBytes") return null;
    const loc = locOf(call);
    // Only the exact composed shape fuses — one size argument, one literal
    // "hex"/"base64" encoding. Anything else falls through (null): bare
    // randomBytes lowers to a real Buffer through the crypto table, and
    // the .toString rides the ordinary Buffer method lowering.
    if (recv.arguments.length !== 1) return null;
    const encNode = call.arguments[0];
    const encT = encNode ? L.typeOf(encNode) : undefined;
    if (
      call.arguments.length !== 1 ||
      !encT?.isStringLiteralType() ||
      (encT.value !== "hex" && encT.value !== "base64")
    ) {
      return null;
    }
    const size = L.lowerExprExpecting(recv.arguments[0]!, F64);
    const enc = L.lowerExprExpecting(encNode!, STRING);
    return { kind: "libCall", fn: "crypto.randomBytesToString", args: [size, enc], type: STRING, loc };
  }

/** The composed hash chain — `createHash("sha256").update(data).digest("hex")`
   * — fused into ONE libCall: the Hash handle never materializes (no Hash
   * type exists in the value model), exactly the randomBytesToString
   * stance. Both import spellings reach here (the named `createHash(...)`
   * and the namespace `crypto.createHash(...)`). Once the chain is
   * recognized, the narrow forms FENCE with pointed hints instead of
   * falling to the generic member fence: sha256 is the lowered algorithm,
   * one string- or Buffer-typed update, hex digests. Null when the callee
   * isn't this chain at all (other Hash-typed code lands on the ordinary
   * Hash.<member> fences). */
  function lowerHashDigestChain(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    const updateCall = access.expression;
    if (!ts.isCallExpression(updateCall) || updateCall.questionDotToken) return null;
    const updAccess = updateCall.expression;
    if (
      !ts.isPropertyAccessExpression(updAccess) ||
      updAccess.questionDotToken ||
      updAccess.name.text !== "update"
    ) {
      return null;
    }
    const chCall = updAccess.expression;
    if (!ts.isCallExpression(chCall) || chCall.questionDotToken) return null;
    const callee = chCall.expression;
    const bi = ts.isIdentifier(callee)
      ? L.builtinImportOf(callee)
      : ts.isPropertyAccessExpression(callee)
        ? L.builtinMemberOf(callee)
        : null;
    if (!bi || bi.module !== "crypto" || bi.member !== "createHash") return null;
    const loc = locOf(call);
    const algT = chCall.arguments.length === 1 ? L.typeOf(chCall.arguments[0]!) : undefined;
    if (!algT?.isStringLiteralType() || (algT.value !== "sha256" && algT.value !== "sha1")) {
      L.noLowering(
        "createHash with this algorithm",
        chCall,
        'sha256 and sha1 are the lowered algorithms: createHash("sha256") ' +
          "(sha1 exists for the RFC 6455 Sec-WebSocket-Accept hash)",
      );
    }
    if (updateCall.arguments.length !== 1) {
      L.noLowering(
        `Hash.update with ${updateCall.arguments.length} arguments`,
        updateCall,
        "one string or Buffer argument is the lowered update (input encodings have no lowering)",
      );
    }
    const encT = call.arguments.length === 1 ? L.typeOf(call.arguments[0]!) : undefined;
    if (!encT?.isStringLiteralType() || (encT.value !== "hex" && encT.value !== "base64")) {
      L.noLowering(
        "Hash.digest with this encoding",
        call,
        'hex and base64 are the lowered digests: .digest("hex") (the bare Buffer digest has no lowering)',
      );
    }
    // alg and enc are proven literals (fenced above), so lowering them
    // out of source position observes nothing; the data lowers between
    // them in its own source order.
    const alg = L.lowerExprExpecting(chCall.arguments[0]!, STRING);
    // The data picks the runtime entry by its static type, the
    // fileURLToPath convention: strings hash their UTF-8 bytes (Node's
    // default input encoding), Buffers/typed arrays hash their bytes.
    const dataNode = updateCall.arguments[0]!;
    const dataIr = L.mapTypeOf(L.typeOf(dataNode));
    if (dataIr?.kind === "bytes") {
      const data = L.lowerExpr(dataNode);
      const enc = L.lowerExprExpecting(call.arguments[0]!, STRING);
      return { kind: "libCall", fn: "crypto.hashDigestBytes", args: [alg, data, enc], type: STRING, loc };
    }
    if (dataIr?.kind === "string") {
      const data = L.lowerExprExpecting(dataNode, STRING);
      const enc = L.lowerExprExpecting(call.arguments[0]!, STRING);
      return { kind: "libCall", fn: "crypto.hashDigestStr", args: [alg, data, enc], type: STRING, loc };
    }
    L.noLowering(
      `Hash.update of '${dataIr ? L.fmt(dataIr) : L.checker.typeToString(L.typeOf(dataNode))}' values`,
      dataNode,
      "string and Buffer/Uint8Array inputs are the lowered update forms",
    );
  }

/** The node:crypto introspection statics — build-time constants of the
   * compiled runtime, baked at the call site (the http2.constants stance
   * extended to calls): getFips() answers 0 (no FIPS provider can ever
   * load into a compiled binary — Node's own answer for a non-FIPS
   * build), and getCiphers()/getHashes()/getCurves() answer Node v24's
   * name lists as fresh string[] literals. The lists are INTROSPECTION
   * data (Node's contract is "names the provider recognizes"); the
   * operations behind the names keep their per-member fences — a program
   * that probes the list and then constructs a cipher fences at the
   * construction site, never here. Null for other members (the dispatch
   * keeps trying). */
  export function lowerCryptoModuleCall(L: Lowerer, expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    if (bi.module !== "crypto") return null;
    const LISTS: Record<string, readonly string[] | undefined> = {
      getCiphers: CRYPTO_CIPHERS,
      getHashes: CRYPTO_HASHES,
      getCurves: CRYPTO_CURVES,
    };
    const list = own(LISTS, bi.member);
    if (bi.member !== "getFips" && list === undefined) return null;
    if (expr.arguments.length !== 0) {
      L.noLowering(`crypto.${bi.member} with ${expr.arguments.length} arguments`, expr);
    }
    if (bi.member === "getFips") {
      return { kind: "numLit", value: 0, type: F64, loc };
    }
    return {
      kind: "arrayLit",
      elems: list!.map((s): IrExpr => ({ kind: "strLit", value: s, type: STRING, loc })),
      type: arrayOf(STRING),
      loc,
    };
  }

/** Method calls on URL-typed receivers: `u.toString()` is Node's href
   * serialization (the href getter's libCall). Everything else the lib
   * declares fences member-qualified. Null for non-URL receivers. */
  export function lowerUrlMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "url") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    if (name === "toString" && call.arguments.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      return { kind: "libCall", fn: "url.href", args: [receiver], type: STRING, loc: locOf(call) };
    }
    L.noLowering(
      `URL.${name}`,
      call,
      "protocol, pathname, href, and toString() are the supported URL members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** `new URLSearchParams(init?)` — the WHATWG constructor's lowered init
   * shapes: omitted / literal `undefined` (empty list), a string (parsed,
   * one leading '?' strips), another URLSearchParams (snapshot copy — a
   * `u.searchParams` argument included), a string[][] value (pairs;
   * Node's ERR_INVALID_TUPLE TypeError on a non-pair row, thrown by the
   * runtime), and an OBJECT LITERAL (each property appends in source
   * order — folded to a sp.with chain at compile time; keys are the
   * record-literal key forms, values coerce as strings). Tuple-typed pair
   * arrays and unions keep named fences. */
  export function lowerSearchParamsNew(L: Lowerer, expr: ts.NewExpression, loc: SrcLoc): IrExpr {
    const args = expr.arguments ?? [];
    if (args.length > 1) {
      L.noLowering(`new URLSearchParams with ${args.length} arguments`, expr, "one init argument is the WHATWG surface");
    }
    const arg = args[0];
    if (arg === undefined || (ts.isIdentifier(arg) && arg.text === "undefined")) {
      return { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc };
    }
    // The object-literal init: `{ a: "1", b: "2" }` appends pairs in
    // source order — fold to nested sp.with calls over the empty list.
    // Only plain property assignments (tsc's index-signature contextual
    // type already rejects spreads' surprises, but keep the fence tight).
    if (ts.isObjectLiteralExpression(arg)) {
      let acc: IrExpr = { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc };
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || prop.name === undefined) {
          L.unsupported("SC1090", prop, "URLSearchParams record inits with spreads, accessors, or shorthand entries");
        }
        let key: string;
        if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
          key = prop.name.text;
        } else {
          L.unsupported("SC1090", prop.name, "non-literal keys in a URLSearchParams record init");
        }
        const value = L.lowerExprExpecting(prop.initializer, STRING);
        const keyExpr: IrExpr = { kind: "strLit", value: key, type: STRING, loc: locOf(prop.name) };
        acc = { kind: "libCall", fn: "sp.with", args: [acc, keyExpr, value], type: SEARCH_PARAMS_T, loc };
      }
      return acc;
    }
    const init = L.lowerExpr(arg);
    if (init.type.kind === "string") {
      return { kind: "libCall", fn: "sp.parse", args: [init], type: SEARCH_PARAMS_T, loc };
    }
    if (init.type.kind === "searchParams") {
      // Node ITERATES the source list — the copy is a snapshot, not a
      // live alias (mutating the copy never touches the source or its
      // URL).
      return { kind: "libCall", fn: "sp.copy", args: [init], type: SEARCH_PARAMS_T, loc };
    }
    if (init.type.kind === "array" && init.type.elem.kind === "array" && init.type.elem.elem.kind === "string") {
      return { kind: "libCall", fn: "sp.fromPairs", args: [init], type: SEARCH_PARAMS_T, loc };
    }
    if (init.type.kind === "array" && init.type.elem.kind === "record") {
      L.unsupported(
        "SC1090",
        arg,
        "URLSearchParams from tuple-typed pairs (type the pairs as string[][] — the tuple rows have a different layout)",
      );
    }
    L.unsupported(
      "SC1090",
      arg,
      `URLSearchParams from '${L.fmt(init.type)}' inits (a string, a string[][], another URLSearchParams, or an inline { key: value } literal — narrow unions first)`,
    );
  }

/** Method calls on URLSearchParams-typed receivers — the WHATWG list
   * surface over the runtime's decoded pairs. get answers `string | null`
   * (the checker's own union; the runtime's +1-or-NULL builds the arms);
   * has/delete take the value-aware second argument (an explicitly
   * `undefined`-typed second argument means the name-only form, Node's
   * treatment); forEach desugars to a synthesized index loop over the
   * LIVE list (sp.size re-reads every pass — appends mid-walk are
   * visited, deletes shift, the spec's index-based iteration).
   * keys()/values()/entries() lower only in a for-of head (lower-stmts
   * routes them before this table) — stored iterator objects keep the
   * drain fence. Null for non-searchParams receivers. */
  export function lowerSearchParamsMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "searchParams") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    const args = call.arguments;
    // The WHATWG arity ladder: too few arguments throw Node's
    // ERR_MISSING_ARGS before any conversion (the invalid-input probes'
    // `params.get()`). Claimed for effect-free receivers only — the
    // throw replaces the whole call, so an effectful receiver expression
    // keeps the fence below.
    const required: Record<string, [number, string] | undefined> = {
      get: [1, 'The "name" argument must be specified'],
      getAll: [1, 'The "name" argument must be specified'],
      has: [1, 'The "name" argument must be specified'],
      delete: [1, 'The "name" argument must be specified'],
      append: [2, 'The "name" and "value" arguments must be specified'],
      set: [2, 'The "name" and "value" arguments must be specified'],
    };
    const req = own(required, name);
    if (req && args.length < req[0] && ts.isIdentifier(access.expression)) {
      // The present-but-short forms still convert nothing in Node — the
      // arity check runs first; present arguments are identifierish
      // probes ('a') whose evaluation is pure in every suite shape, and
      // effectful ones would land here too (statement-coarsening, the
      // runtimeFence precedent).
      return nodeThrowExpr(1, "ERR_MISSING_ARGS", req[1], L.mapTypeOf(L.typeOf(call)) ?? VOID, loc);
    }
    // One name/value slot, WHATWG USVString rules: statically-string
    // arguments lower directly; a symbol can never convert (V8's
    // TypeError, statically decided); everything else crosses into the
    // dyn and coerces at runtime with the object protocol (a user
    // toString/valueOf runs and its throw propagates).
    const strArg = (i: number): IrExpr => {
      const node = args[i]!;
      const t = L.mapTypeOf(L.typeOf(node));
      if (t?.kind === "string") return L.lowerExprExpecting(node, STRING);
      if (t?.kind === "symbol") {
        return nodeThrowExpr(1, "", "Cannot convert a Symbol value to a string", STRING, loc);
      }
      let v: IrExpr;
      if (ts.isObjectLiteralExpression(node)) {
        // Object literals take the dyn literal path directly (method
        // members box as dyn functions — the typed record fence never
        // applies to the coercion probes).
        v = lowerDynObjectLiteral(L, node);
      } else {
        const raw = L.lowerExpr(node);
        if (raw.type.kind === "dyn") v = raw;
        else if (raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
          v = { kind: "dynFrom", value: raw, type: DYN, loc: raw.loc };
        } else if (raw.type.kind === "record") {
          // A RECORD-represented value that cannot cross into the checked-dynamic tree (a
          // func-carrying shape — the throwing-toString probes): run
          // ToPrimitive's string hint STATICALLY. A zero-parameter
          // toString func member is called (its throw propagates); a
          // string answer is the conversion, and a void/never-typed one
          // (the always-throwing probe shape, or a bare undefined return)
          // stringifies as ToString(undefined). Other shapes keep the
          // fence — honesty over coverage.
          const shape = L.shapes.get(raw.type.shapeId);
          const tsMember = shape?.fields.find((f) => f.name === "toString");
          if (
            shape &&
            tsMember &&
            tsMember.type.kind === "func" &&
            tsMember.type.params.length === 0 &&
            L.dynConvertible(tsMember.type)
          ) {
            // Box just the toString member into a fresh dyn carrier and
            // run the protocol at runtime — the boxed call propagates its
            // throw, string answers convert, and a bare (void) return is
            // ToString(undefined), all through one path.
            const member: IrExpr = { kind: "recordGet", obj: raw, shapeId: raw.type.shapeId, field: "toString", type: tsMember.type, loc };
            v = {
              kind: "dynObjLit",
              fields: [{
                key: { kind: "strLit", value: "toString", type: STRING, loc },
                value: { kind: "dynFrom", value: member, type: DYN, loc },
              }],
              type: DYN,
              loc,
            };
          } else {
            L.noLowering(
              `URLSearchParams.${name} with a '${L.fmt(raw.type)}' argument`,
              node,
              "string arguments are the lowered shape (other values coerce through the checked-dynamic tree — narrow unions first)",
            );
          }
        } else {
          L.noLowering(
            `URLSearchParams.${name} with a '${L.fmt(raw.type)}' argument`,
            node,
            "string arguments are the lowered shape (other values coerce through the checked-dynamic tree — narrow unions first)",
          );
        }
      }
      return { kind: "libCall", fn: "dyn.toStringCoerce", args: [v], type: STRING, loc };
    };
    // has/delete's OPTIONAL value argument: absent, or an explicitly
    // undefined-typed expression (Node treats explicit undefined as the
    // name-only form). A `string | undefined` union has two behaviors in
    // one value — narrow first.
    const optionalValueArg = (): IrExpr | null => {
      if (args.length === 1) return null;
      const t = L.mapTypeOf(L.typeOf(args[1]!));
      if (t?.kind === "undefinedT") return null;
      if (t?.kind === "string") return strArg(1);
      L.unsupported(
        "SC1090",
        args[1]!,
        `URLSearchParams.${name} with a '${L.checker.typeToString(L.typeOf(args[1]!))}' value argument (pass a string, or narrow '| undefined' unions to the two call forms first)`,
      );
    };
    if (name === "get" && args.length === 1) {
      const receiver = L.lowerExpr(access.expression);
      const type: IrType = { kind: "union", unionId: L.unions.intern([STRING, NULL_T]) };
      return { kind: "libCall", fn: "sp.get", args: [receiver, strArg(0)], type, loc };
    }
    if (name === "getAll" && args.length === 1) {
      const receiver = L.lowerExpr(access.expression);
      return { kind: "libCall", fn: "sp.getAll", args: [receiver, strArg(0)], type: arrayOf(STRING), loc };
    }
    if ((name === "append" || name === "set") && args.length === 2) {
      const receiver = L.lowerExpr(access.expression);
      const fn = name === "append" ? "sp.append" : "sp.set";
      return { kind: "libCall", fn, args: [receiver, strArg(0), strArg(1)], type: VOID, loc };
    }
    if (name === "delete" && (args.length === 1 || args.length === 2)) {
      const receiver = L.lowerExpr(access.expression);
      const nameArg = strArg(0);
      const value = optionalValueArg();
      return value === null
        ? { kind: "libCall", fn: "sp.delete", args: [receiver, nameArg], type: VOID, loc }
        : { kind: "libCall", fn: "sp.deleteValue", args: [receiver, nameArg, value], type: VOID, loc };
    }
    if (name === "has" && (args.length === 1 || args.length === 2)) {
      const receiver = L.lowerExpr(access.expression);
      const nameArg = strArg(0);
      const value = optionalValueArg();
      return value === null
        ? { kind: "libCall", fn: "sp.has", args: [receiver, nameArg], type: BOOL, loc }
        : { kind: "libCall", fn: "sp.hasValue", args: [receiver, nameArg, value], type: BOOL, loc };
    }
    if (name === "sort" && args.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      return { kind: "libCall", fn: "sp.sort", args: [receiver], type: VOID, loc };
    }
    if (name === "toString" && args.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      return { kind: "libCall", fn: "sp.toString", args: [receiver], type: STRING, loc };
    }
    if (name === "forEach" && args.length === 1) {
      return lowerSpForEachCall(L, call, access);
    }
    if (name === "keys" || name === "values" || name === "entries") {
      L.unsupported(
        "SC1090",
        call,
        `URLSearchParams iterator objects outside a for-of head (write \`for (const x of sp.${name}())\` directly)`,
      );
    }
    L.noLowering(
      `URLSearchParams.${name}`,
      call,
      "get, getAll, set, append, delete, has, sort, size, toString(), forEach, and for-of iteration are the supported URLSearchParams members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** `sp.forEach(fn)` — a synthesized module function per callback arity
   * (interned), whose body is the LIVE index walk:
   *
   *   for (i = 0; i < sp.size; i++) { v = sp.valAt(i); k = sp.keyAt(i); f(v, k, sp?); }
   *
   * sp.size re-reads every pass — the spec's index-based iteration (Map's
   * forEach precedent, minus the tombstone machinery the pair list
   * doesn't need: deletes compact immediately). The callback receives
   * (value, name, searchParams) like the WHATWG signature; declaring
   * fewer parameters is ordinary TS. */
  function lowerSpForEachCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr {
    const loc = locOf(call);
    const argNode = call.arguments[0]!;
    const fnArg = L.lowerExpr(argNode);
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > 3 ||
      (fnArg.type.params.length >= 1 && fnArg.type.params[0]!.kind !== "string") ||
      (fnArg.type.params.length >= 2 && fnArg.type.params[1]!.kind !== "string") ||
      (fnArg.type.params.length === 3 && fnArg.type.params[2]!.kind !== "searchParams")
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    const receiver = L.lowerExpr(access.expression);
    const arity = fnArg.type.params.length;
    const fnRet = fnArg.type.ret;
    const key = `${arity}:${typeKey(fnRet)}`;
    let helper = L.spHofHelpers.get(key);
    if (!helper) {
      helper = `%sp.forEach.${L.spHofHelpers.size}`;
      L.spHofHelpers.set(key, helper);
      L.liftedFns.push(buildSpForEachFn(helper, arity, fnRet, loc));
    }
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: VOID, loc };
  }

/** The Sp.forEach helper's body (see lowerSpForEachCall). */
  function buildSpForEachFn(name: string, arity: number, fnRet: IrType, loc: SrcLoc): IrFunction {
    const paramTypes: IrType[] =
      arity === 0 ? [] : arity === 1 ? [STRING] : arity === 2 ? [STRING, STRING] : [STRING, STRING, SEARCH_PARAMS_T];
    const fnT = funcOf(paramTypes, fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const sp = (fn: "sp.size" | "sp.keyAt" | "sp.valAt", extra: IrExpr[], type: IrType): IrExpr => ({
      kind: "libCall",
      fn,
      args: [ref("sp.0", SEARCH_PARAMS_T), ...extra],
      type,
      loc,
    });
    const locals: IrLocal[] = [
      { id: "sp.0", name: "sp", type: SEARCH_PARAMS_T, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ];
    const callArgs: IrExpr[] = [];
    const body: IrStmt[] = [];
    if (arity >= 1) {
      locals.push({ id: "v.0", name: "v", type: STRING, mutable: false });
      body.push({ kind: "varDecl", localId: "v.0", init: sp("sp.valAt", [ref("i.0", F64)], STRING), loc });
      callArgs.push(ref("v.0", STRING));
    }
    if (arity >= 2) {
      locals.push({ id: "k.0", name: "k", type: STRING, mutable: false });
      body.push({ kind: "varDecl", localId: "k.0", init: sp("sp.keyAt", [ref("i.0", F64)], STRING), loc });
      callArgs.push(ref("k.0", STRING));
    }
    if (arity === 3) callArgs.push(ref("sp.0", SEARCH_PARAMS_T));
    body.push({
      kind: "exprStmt",
      expr: { kind: "callValue", callee: ref("f.0", fnT), args: callArgs, type: fnRet, loc },
      loc,
    });
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
      cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: sp("sp.size", [], F64), type: BOOL, loc },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
        loc,
      },
      body,
      loc,
    };
    return {
      name,
      params: [
        { localId: "sp.0", name: "sp", type: SEARCH_PARAMS_T },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: VOID,
      locals,
      body: [loop],
      loc,
    };
  }

/** Calls on an fs/promises FileHandle. The promise-returning methods run
 * through the same synchronous descriptor primitives as fs.readSync /
 * writeSync, then settle so failures reject at await. read/write retain
 * the caller's buffer in the Node-shaped result record. */
  export function lowerFileHandleMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "fileHandle") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    const receiver = (): IrExpr => L.lowerExprExpecting(access.expression, FILEHANDLE_T);
    const promise = (inner: IrType): IrType => ({ kind: "promise", inner });
    const bool = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
    const num = (node: ts.Expression | undefined, dflt: number): { value: IrExpr; defaulted: IrExpr } => {
      const defaultValue = { kind: "numLit", value: dflt, type: F64, loc } satisfies IrExpr;
      if (!node) return { value: defaultValue, defaulted: bool(true) };
      const undefinedArg = lowerStaticallyUndefinedBuiltinArg(L, node);
      if (undefinedArg) {
        return { value: defaultAfterUndefined(undefinedArg, defaultValue), defaulted: bool(true) };
      }
      if ((L.typeOf(node).flags & ts.TypeFlags.Null) !== 0) {
        return { value: defaultAfterUndefined(L.lowerExpr(node), defaultValue), defaulted: bool(true) };
      }
      const value = L.lowerExpr(node);
      if (value.type.kind === "union") {
        const def = L.unions.get(value.type.unionId);
        const units = def?.arms.filter(isUnitType) ?? [];
        if (
          units.length > 0 &&
          def?.arms.every((arm) => typeEquals(arm, F64) || isUnitType(arm))
        ) {
          // The normalized number and the separate "length was omitted"
          // bit must observe one evaluation of a runtime optional union.
          // Bind it in the numeric argument; the later bool argument reads
          // the same hidden local (libCall arguments evaluate left-to-right).
          const saved = L.declareHiddenLocal("%fhOptNum", value.type);
          const savedRef = (): IrExpr => ({
            kind: "varRef", localId: saved.id, type: value.type, loc: value.loc,
          });
          let defaulted: IrExpr = {
            kind: "unionIsTag", unionId: value.type.unionId,
            tag: L.armTag(value.type.unionId, units[0]!), negated: false,
            value: savedRef(), type: BOOL, loc: value.loc,
          };
          for (const unit of units.slice(1)) {
            defaulted = {
              kind: "logical", op: "||", left: defaulted,
              right: {
                kind: "unionIsTag", unionId: value.type.unionId,
                tag: L.armTag(value.type.unionId, unit), negated: false,
                value: savedRef(), type: BOOL, loc: value.loc,
              },
              type: BOOL,
              loc: value.loc,
            };
          }
          return {
            value: {
              kind: "seqExpr",
              stmts: [{ kind: "varDecl", localId: saved.id, init: value, loc: value.loc }],
              result: {
                kind: "nullish", left: savedRef(), right: defaultValue,
                type: F64, loc: value.loc,
              },
              type: F64,
              loc: value.loc,
            },
            defaulted,
          };
        }
      }
      return { value: L.coerceInto(node, value, F64), defaulted: bool(false) };
    };
    const utf8 = (node: ts.Expression | undefined): IrExpr => {
      const dflt = { kind: "strLit", value: "utf8", type: STRING, loc } satisfies IrExpr;
      if (!node) return dflt;
      const nodeType = L.typeOf(node);
      const parts: readonly ts.Type[] = nodeType.isUnionType() ? ts.constituentTypes(nodeType) : [nodeType];
      const supported = parts.every(
        (t) =>
          (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0 ||
          (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")),
      );
      if (!supported) {
        L.noLowering(
          `FileHandle.${name} with a non-utf8 encoding`,
          node,
          "only utf8 data is supported",
        );
      }
      return lowerBuiltinOptionalDefault(L, node, STRING, dflt, true);
    };

    if (name === "close" || name === "stat") {
      if (call.arguments.length !== 0) L.noLowering(`FileHandle.${name} with arguments`, call);
      return {
        kind: "libCall",
        fn: name === "close" ? "fileHandle.close" : "fileHandle.stat",
        args: [receiver()],
        type: promise(name === "close" ? VOID : { kind: "stats" }),
        loc,
      };
    }

    if (name === "readFile") {
      if (call.arguments.length > 1) {
        L.noLowering(`FileHandle.readFile with ${call.arguments.length} arguments`, call);
      }
      const type = L.mapTypeOf(L.typeOf(call));
      if (type?.kind !== "promise") L.badType(call, L.typeOf(call));
      const encoding = utf8(call.arguments[0]);
      if (typeEquals(type.inner, BYTES_U8)) {
        return {
          kind: "libCall", fn: "fileHandle.readFileBytes", args: [receiver(), encoding],
          type, loc,
        };
      }
      if (!typeEquals(type.inner, STRING)) L.badType(call, L.typeOf(call));
      return {
        kind: "libCall", fn: "fileHandle.readFile", args: [receiver(), encoding],
        type, loc,
      };
    }

    if (name === "writeFile" || name === "appendFile") {
      if (call.arguments.length < 1 || call.arguments.length > 2) {
        L.noLowering(`FileHandle.${name} with ${call.arguments.length} arguments`, call);
      }
      const dataNode = call.arguments[0]!;
      const dataT = L.mapTypeOf(L.typeOf(dataNode));
      // Evaluate a supplied utf8 encoding even for Buffer data, matching
      // Node's argument order; it does not affect the bytes.
      const encoding = utf8(call.arguments[1]);
      if (dataT?.kind === "string") {
        return {
          kind: "libCall", fn: "fileHandle.writeFile",
          args: [receiver(), L.lowerExprExpecting(dataNode, STRING), encoding],
          type: promise(VOID), loc,
        };
      }
      if (dataT?.kind === "bytes" && dataT.elem === "u8") {
        return {
          kind: "libCall", fn: "fileHandle.writeFileBytes",
          args: [receiver(), L.lowerExprExpecting(dataNode, BYTES_U8), encoding],
          type: promise(VOID), loc,
        };
      }
      L.noLowering(
        `FileHandle.${name} of '${dataT ? L.fmt(dataT) : L.checker.typeToString(L.typeOf(dataNode))}' data`,
        dataNode,
        "string and Uint8Array data are supported",
      );
    }

    if (name === "read") {
      if (call.arguments.length < 1 || call.arguments.length > 4) {
        L.noLowering(
          `FileHandle.read with ${call.arguments.length} arguments`,
          call,
          "use read(buffer[, offset[, length[, position]]])",
        );
      }
      const buffer = L.lowerExprExpecting(call.arguments[0]!, BYTES_U8);
      const type = L.mapTypeOf(L.typeOf(call));
      if (type?.kind !== "promise" || type.inner.kind !== "record") {
        L.badType(call, L.typeOf(call));
      }
      const offset = num(call.arguments[1], 0);
      const length = num(call.arguments[2], -1);
      const position = num(call.arguments[3], -1);
      return {
        kind: "libCall", fn: "fileHandle.read",
        args: [
          receiver(), buffer, offset.value, length.value,
          position.value, length.defaulted,
        ],
        type, loc,
      };
    }

    if (name === "write") {
      if (call.arguments.length < 1 || call.arguments.length > 4) {
        L.noLowering(`FileHandle.write with ${call.arguments.length} arguments`, call);
      }
      const dataNode = call.arguments[0]!;
      const dataT = L.mapTypeOf(L.typeOf(dataNode));
      const type = L.mapTypeOf(L.typeOf(call));
      if (type?.kind !== "promise" || type.inner.kind !== "record") {
        L.badType(call, L.typeOf(call));
      }
      if (dataT?.kind === "bytes" && dataT.elem === "u8") {
        const offset = num(call.arguments[1], 0);
        const length = num(call.arguments[2], -1);
        const position = num(call.arguments[3], -1);
        return {
          kind: "libCall", fn: "fileHandle.writeBytes",
          args: [
            receiver(), L.lowerExprExpecting(dataNode, BYTES_U8),
            offset.value, length.value, position.value,
            length.defaulted,
          ],
          type, loc,
        };
      }
      if (dataT?.kind === "string") {
        if (call.arguments.length > 3) {
          L.noLowering(
            `FileHandle.write(string) with ${call.arguments.length} arguments`,
            call,
            'use write(string[, position[, "utf8"]])',
          );
        }
        const position = num(call.arguments[1], -1);
        return {
          kind: "libCall", fn: "fileHandle.writeStr",
          args: [receiver(), L.lowerExprExpecting(dataNode, STRING), position.value, utf8(call.arguments[2])],
          type, loc,
        };
      }
      L.noLowering(
        `FileHandle.write of '${dataT ? L.fmt(dataT) : L.checker.typeToString(L.typeOf(dataNode))}' data`,
        dataNode,
        "string and Uint8Array data are supported",
      );
    }

    L.noLowering(
      `FileHandle.${name}`,
      call,
      "fd, close(), read(), write(), readFile(), writeFile(), appendFile(), and stat() are the supported FileHandle members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** Method calls on Stats-typed receivers: isFile()/isDirectory()/
   * isSymbolicLink() are pure reads on the stat snapshot (a followed
   * statSync snapshot never answers true to isSymbolicLink — take
   * lstatSync's, Node's own split). Everything else @types/node declares
   * (mtime, mode, ...) fences member-qualified. Null for non-Stats
   * receivers. */
  export function lowerStatsMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "stats") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    if (
      (name === "isFile" || name === "isDirectory" || name === "isSymbolicLink") &&
      call.arguments.length === 0
    ) {
      const receiver = L.lowerExpr(access.expression);
      const fn =
        name === "isFile" ? "stats.isFile"
        : name === "isDirectory" ? "stats.isDirectory"
        : "stats.isSymbolicLink";
      return { kind: "libCall", fn, args: [receiver], type: BOOL, loc: locOf(call) };
    }
    L.noLowering(
      `Stats.${name}`,
      call,
      "isFile(), isDirectory(), isSymbolicLink(), size, blocks, nlink, atimeMs, and mtimeMs are the supported Stats members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** `Atomics.wait(int32Array, idx, expected, timeoutMs)` — the
   * synchronous-sleep idiom (RouteStore's
   * `Atomics.wait(sleepBuffer, 0, 0, ms)`): scriptc has no threads, so
   * nothing can ever notify a waiter and the spec's behavior for every
   * compilable program is exactly "compare, then sleep out the timeout"
   * — "not-equal" when the element differs, a real nanosleep and
   * "timed-out" otherwise ("ok" is unreachable). The timeout argument is
   * REQUIRED: without it Node blocks until a notify that cannot exist
   * here — a certain deadlock, fenced with that explanation. Every other
   * Atomics member (notify has no one to wake; add/load/... — nothing
   * races) fences member-qualified. Null for non-Atomics receivers. */
  export function lowerAtomicsCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    const member = L.stdlibGlobalMember(access, "Atomics");
    if (member === null) return null;
    const loc = locOf(call);
    if (member !== "wait") {
      L.noLowering(
        `Atomics.${member}`,
        call,
        "Atomics.wait(int32Array, idx, expected, timeoutMs) is the supported Atomics surface " +
          "(scriptc has no threads — wait is the synchronous-sleep idiom, and nothing else has anyone to race)",
        L.checker.getSymbolAtLocation(access.name),
      );
    }
    if (call.arguments.length !== 4 || call.arguments.some(ts.isSpreadElement)) {
      L.noLowering(
        `Atomics.wait with ${call.arguments.length} arguments`,
        call,
        "the timeout is required: without it the wait blocks forever — scriptc has no threads, " +
          "so no notify can ever arrive (Atomics.wait(arr, idx, expected, timeoutMs))",
      );
    }
    const arrNode = call.arguments[0]!;
    const arrIr = L.mapTypeOf(L.typeOf(arrNode));
    if (!(arrIr?.kind === "bytes" && arrIr.elem === "i32")) {
      L.noLowering(
        `Atomics.wait over '${L.checker.typeToString(L.typeOf(arrNode))}' values`,
        arrNode,
        "an Int32Array is the supported waitable array",
      );
    }
    const arr = L.lowerExpr(arrNode);
    const idx = L.lowerExprExpecting(call.arguments[1]!, F64);
    const expected = L.lowerExprExpecting(call.arguments[2]!, F64);
    const timeout = L.lowerExprExpecting(call.arguments[3]!, F64);
    return { kind: "libCall", fn: "atomics.wait", args: [arr, idx, expected, timeout], type: STRING, loc };
  }

/** The property-read extensions this spoke owns, tried BEFORE the
   * lower-exprs intrinsic-property fallback (the lowerer's wrapper chains
   * them): the widened numeric Stats snapshot and SpawnSyncReturns.signal
   * (the termination signal's name as the call site's `Signals | null` union
   * — null for a normal exit or spawn failure; a timeout kill reports its
   * killSignal, Node's shape). Null for everything else, so the ordinary
   * chain (and its fences) keeps going. */
  export function lowerBuiltinExtraProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken && !L.chainHandled.has(expr)) return null;
    // decoder.encoding on a StringDecoder-typed receiver: the record's
    // hidden canonical-name field (construction folded the aliases —
    // exactly what Node's normalized `.encoding` answers).
    if (expr.name.text === "encoding" && isStringDecoderTyped(L, expr.expression) && L.isStdlibMember(expr)) {
      const receiver = L.lowerExpr(expr.expression);
      if (receiver.type.kind !== "record") L.badType(expr.expression, L.typeOf(expr.expression));
      return { kind: "recordGet", obj: receiver, shapeId: receiver.type.shapeId, field: "%enc", type: STRING, loc: locOf(expr) };
    }
    const kind = L.mapTypeOf(L.typeOf(expr.expression))?.kind;
    if (kind !== "stats" && kind !== "fileHandle" && kind !== "spawnRes" && kind !== "child") return null;
    if (kind === "child" ? !isChildSurfaceMember(L, expr) : !L.isStdlibMember(expr)) return null;
    const name = expr.name.text;
    const loc = locOf(expr);
    if (kind === "fileHandle") {
      if (name === "fd") {
        const receiver = L.lowerExprExpecting(expr.expression, FILEHANDLE_T);
        return { kind: "libCall", fn: "fileHandle.fd", args: [receiver], type: F64, loc };
      }
      const methods = new Set(["close", "read", "write", "readFile", "writeFile", "appendFile", "stat"]);
      if (methods.has(name)) {
        L.unsupported("SC1090", expr, `FileHandle methods as values (call '${name}' directly)`);
      }
      L.noLowering(
        `FileHandle.${name}`,
        expr,
        "fd, close(), read(), write(), readFile(), writeFile(), appendFile(), and stat() are the supported FileHandle members",
        L.checker.getSymbolAtLocation(expr.name),
      );
    }
    // child.stdout / child.stderr — the piped-output streams: the
    // checker's `Readable | null` (null exactly when the slot was not
    // piped), constructed type-directedly in the backend over the
    // +1-or-NULL runtime pair.
    if (kind === "child" && (name === "stdout" || name === "stderr")) {
      const receiver = L.lowerExpr(expr.expression);
      const type: IrType = {
        kind: "union",
        unionId: L.unions.intern([CHILDSTREAM_T, { kind: "nullT" }]),
      };
      const read: IrExpr = {
        kind: "libCall",
        fn: name === "stdout" ? "child.stdout" : "child.stderr",
        args: [receiver],
        type,
        loc,
      };
      return L.maybeNarrow(read, expr);
    }
    if (kind === "child") return null; // pid/exitCode/killed live in lowerIntrinsicProperty
    if (
      kind === "stats" &&
      (name === "blocks" || name === "nlink" || name === "atimeMs" || name === "mtimeMs")
    ) {
      const receiver = L.lowerExpr(expr.expression);
      const fn = `stats.${name}` as
        | "stats.blocks"
        | "stats.nlink"
        | "stats.atimeMs"
        | "stats.mtimeMs";
      return { kind: "libCall", fn, args: [receiver], type: F64, loc };
    }
    if (kind === "spawnRes" && name === "signal") {
      const receiver = L.lowerExpr(expr.expression);
      const type: IrType = {
        kind: "union",
        unionId: L.unions.intern([STRING, { kind: "nullT" }]),
      };
      const read: IrExpr = { kind: "libCall", fn: "spawnRes.signal", args: [receiver], type, loc };
      return L.maybeNarrow(read, expr);
    }
    return null;
  }

/** Method calls on ChildProcess receivers: `child.on("exit"|"error", cb)`
   * registers a listener with the event loop's child registry. The event
   * name must be one of the two terminal-event LITERALS; the callback
   * takes at most one parameter — `(code: number | null)` for exit (the
   * signal parameter has no lowering), `(err: Error)` for error — or none.
   * `on` is statement-only (Node returns the child for chaining; here the
   * result is void and chaining is fenced). kill(signal?) and unref()
   * lower too (the property reads — pid/exitCode/killed — live in
   * lowerIntrinsicProperty). Everything else @types/node declares on
   * ChildProcess (stdout, once, ...) fences member-qualified. Null for
   * non-child receivers. */
  export function lowerChildMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "child") return null;
    if (!isChildSurfaceMember(L, access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "on" && call.arguments.length === 2) {
      const evT = L.typeOf(call.arguments[0]!);
      const event = evT.isStringLiteralType() ? evT.value : null;
      if (event !== "exit" && event !== "error") {
        L.noLowering(
          `child.on(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
          call.arguments[0]!,
          '"exit" and "error" are the supported child events (as literals)',
        );
      }
      if (!ts.isExpressionStatement(call.parent)) {
        L.unsupported(
          "SC1090",
          call,
          "chaining child.on(...) (the result is void here — register each listener as its own statement)",
        );
      }
      const receiver = L.lowerExpr(access.expression);
      const cb = L.lowerExpr(call.arguments[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > (event === "exit" ? 2 : 1)) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          event === "exit"
            ? "exit listeners with more than two parameters (use (code, signal), (code), or ())"
            : "error listeners with more than one parameter (use (err) or ())",
        );
      }
      if (cb.type.ret.kind !== "void") {
        // `() => 5` IS assignable to a void-returning listener slot; the
        // registry's call ABI is void, so a value-returning closure is
        // fenced instead of silently called wrong.
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          "listeners returning a value (make the callback body a block, or return nothing)",
        );
      }
      const param = cb.type.params[0];
      if (event === "exit") {
        const armsOk =
          param === undefined ||
          (param.kind === "union" &&
            (() => {
              const def = L.unions.get(param.unionId);
              return (
                def?.arms.length === 2 &&
                def.arms[0]!.kind === "f64" &&
                def.arms[1]!.kind === "nullT"
              );
            })());
        if (!armsOk) {
          L.unsupported(
            "SC1090",
            call.arguments[1]!,
            `exit listeners whose parameter is not 'number | null' (got '${L.fmt(param!)}')`,
          );
        }
        // The optional SECOND parameter is Node's signal: the terminating
        // signal's name as `Signals | null` — a string | null union here
        // (the interned adapter builds it at fire time).
        const sigParam = cb.type.params[1];
        const sigOk =
          sigParam === undefined ||
          (sigParam.kind === "union" &&
            (() => {
              const def = L.unions.get(sigParam.unionId);
              return (
                def?.arms.length === 2 &&
                def.arms.some((a) => a.kind === "string") &&
                def.arms.some((a) => a.kind === "nullT")
              );
            })());
        if (!sigOk) {
          L.unsupported(
            "SC1090",
            call.arguments[1]!,
            `exit listeners whose signal parameter is not 'Signals | null' (got '${L.fmt(sigParam!)}')`,
          );
        }
        return { kind: "libCall", fn: "child.onExit", args: [receiver, cb], type: VOID, loc };
      }
      if (param !== undefined && !(param.kind === "object" && param.className === "%Error")) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          `error listeners whose parameter is not 'Error' (got '${L.fmt(param)}')`,
        );
      }
      return { kind: "libCall", fn: "child.onError", args: [receiver, cb], type: VOID, loc };
    }
    // child.kill(signal?) — Node's semantics exactly: the name resolves
    // through Node's signal table (unknown names throw the ERR_UNKNOWN_SIGNAL
    // TypeError), numbers pass through (0 probes), the omitted signal is
    // SIGTERM; true when the signal was sent, false once the child was
    // reaped or never spawned (Node's null-handle answer), and a successful
    // send sets `killed`.
    if (name === "kill") {
      if (call.arguments.length > 1) {
        L.noLowering(`child.kill with ${call.arguments.length} arguments`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const sigNode = call.arguments[0];
      if (!sigNode) {
        const dflt: IrExpr = { kind: "strLit", value: "SIGTERM", type: STRING, loc };
        return { kind: "libCall", fn: "child.kill", args: [receiver, dflt], type: BOOL, loc };
      }
      const sig = L.lowerExpr(sigNode);
      if (sig.type.kind === "f64") {
        return { kind: "libCall", fn: "child.killNum", args: [receiver, sig], type: BOOL, loc };
      }
      if (sig.type.kind === "string") {
        return { kind: "libCall", fn: "child.kill", args: [receiver, sig], type: BOOL, loc };
      }
      L.noLowering(
        `child.kill with a '${L.fmt(sig.type)}' signal`,
        sigNode,
        "pass a signal name string or number (narrow unions first)",
      );
    }
    // child.unref(): drops the child from the event loop's keep-alive set
    // (the process may exit while the child runs — Node's semantics; the
    // child is still reaped while the loop runs for other reasons).
    if (name === "unref" && call.arguments.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      return { kind: "libCall", fn: "child.unref", args: [receiver], type: VOID, loc };
    }
    L.noLowering(
      `ChildProcess.${name}`,
      call,
      "on(\"exit\" | \"error\", cb), pid, exitCode, killed, kill(signal?), and unref() are the supported ChildProcess members",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** Method calls on piped child-output stream receivers (child.stdout /
   * child.stderr — the childStream kind): on/once("data" | "end").
   * 'data' listeners take zero parameters, `(chunk: Buffer)`, or a
   * `Buffer | string`-union chunk (the ngrok appendOutput shape — the
   * runtime only ever fires Buffers; the compiler-emitted adapter wraps
   * the chunk at the union's Buffer arm); 'end' listeners take none.
   * Statement position only (Node returns the stream for chaining; here
   * the result is void). Chained receivers (`child.stdout?.on(...)`)
   * ride the optional-chain re-dispatch (chainBlocked). Everything else
   * @types/node declares on Readable fences member-qualified. Null for
   * non-stream receivers. */
  export function lowerChildStreamMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(call, access)) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "childStream") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if ((name === "on" || name === "once") && call.arguments.length === 2) {
      const evT = L.typeOf(call.arguments[0]!);
      const event = evT.isStringLiteralType() ? evT.value : null;
      if (event !== "data" && event !== "end") {
        L.noLowering(
          `stream.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
          call.arguments[0]!,
          '"data" and "end" are the supported child-stream events (as literals)',
        );
      }
      if (!ts.isExpressionStatement(call.parent)) {
        L.unsupported(
          "SC1090",
          call,
          "chaining stream listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      const receiver = L.lowerExpr(access.expression);
      const cb = L.lowerExpr(call.arguments[1]!);
      const once: IrExpr = { kind: "boolLit", value: name === "once", type: BOOL, loc };
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" ||
          cb.type.params.length > (event === "data" ? 1 : 0)) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          event === "data"
            ? "data listeners with more than one parameter or a return value (use (chunk) or ())"
            : "end listeners with parameters or a return value (use ())",
        );
      }
      if (event === "end") {
        return { kind: "libCall", fn: "stream.onEnd", args: [receiver, cb, once], type: VOID, loc };
      }
      const param = cb.type.params[0];
      const unionOk = (p: IrType): boolean => {
        if (p.kind !== "union") return false;
        const def = L.unions.get(p.unionId);
        return !!def && def.arms.some((a) => a.kind === "bytes" && a.elem === "u8");
      };
      if (param !== undefined && !(param.kind === "bytes" && param.elem === "u8") && !unionOk(param)) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          `data listeners whose parameter is not 'Buffer' (or a Buffer-armed union; got '${L.fmt(param)}')`,
        );
      }
      return { kind: "libCall", fn: "stream.onData", args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `ReadableStream.${name}`,
      call,
      'on/once("data" | "end", cb) are the supported child-stream members',
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** Method calls on first-class process-stream receivers (procStream —
   * a WritableStream-typed value like prefixStream's `output` param):
   * write(data) with one string, dispatched at runtime onto the exact
   * stdout/stderr write paths (the fd IS the value). Everything else
   * @types/node declares on WritableStream fences member-qualified.
   * Null for non-procStream receivers. */
  export function lowerProcStreamMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(call, access)) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "procStream") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "write" && call.arguments.length === 1) {
      const receiver = L.lowerExpr(access.expression);
      const data = L.lowerExpr(call.arguments[0]!);
      if (data.type.kind !== "string") {
        L.noLowering(
          `write of '${L.fmt(data.type)}' data on a stream value`,
          call.arguments[0]!,
          "one string is the supported form here — narrow unions first",
        );
      }
      return { kind: "libCall", fn: "procStream.write", args: [receiver, data], type: BOOL, loc };
    }
    L.noLowering(
      `WritableStream.${name}`,
      call,
      "write(data) with one string is the supported stream-value member",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** `fs.watch(path[, options][, listener])` → the fs.watch libCall
   * (scr_watch.c — kqueue EVFILT_VNODE on the opened path; an unopenable
   * path THROWS Node's fs error synchronously, the polling-fallback catch
   * shape). The listener fires with "rename"/"change" and takes zero
   * parameters or the eventType string — the filename parameter has no
   * lowering (kqueue watches the inode, not the directory entry; you
   * watched one path). The options record follows the options-record
   * stance: persistent: true, recursive: false, and encoding: "utf8"
   * state the lowered behavior and are accepted; persistent: false
   * (a watcher that does NOT hold the loop), recursive: true (kqueue
   * watches one inode), signal, and non-utf8 encodings fence by name;
   * undocumented keys drop like Node. An open watcher keeps the loop
   * alive until watcher.close(). */
  export function lowerFsWatchCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (expr.arguments.length < 1 || expr.arguments.length > 3 || expr.arguments.some(ts.isSpreadElement)) {
      L.noLowering(
        "fs.watch with this argument shape",
        expr,
        "the supported forms are watch(path[, options][, listener])",
      );
    }
    const hasOptions = expr.arguments.length >= 2 && ts.isObjectLiteralExpression(expr.arguments[1]!);
    if (expr.arguments.length === 3 && !hasOptions) {
      L.noLowering(
        "fs.watch with a non-literal options argument",
        expr.arguments[1]!,
        "pass the options as an object literal: watch(path, { recursive?, persistent?, encoding? }, listener)",
      );
    }
    if (hasOptions) {
      for (const prop of (expr.arguments[1] as ts.ObjectLiteralExpression).properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
          L.noLowering(
            "fs.watch options with computed keys or spreads",
            prop,
            "each option must be a plain `name: value` entry with a literal key",
          );
        }
        if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) {
          L.noLowering(
            "fs.watch options with computed keys",
            prop,
            "each option must be a plain `name: value` entry with a literal key",
          );
        }
        const key = prop.name.text;
        const init = ts.isPropertyAssignment(prop) ? prop.initializer : null;
        if (key === "persistent") {
          // true IS the lowering (an open watcher holds the loop) —
          // stating the default is a no-op; false has no lowering.
          if (init !== null && init.kind === ts.SyntaxKind.TrueKeyword) continue;
          L.noLowering(
            "fs.watch with persistent disabled",
            prop,
            "an open watcher keeps the loop alive until close() — that IS the lowering; " +
              "persistent: false (a watcher the process does not wait for) has no lowering",
          );
        }
        if (key === "recursive") {
          if (init !== null && init.kind === ts.SyntaxKind.FalseKeyword) continue;
          L.noLowering(
            "fs.watch with the recursive option",
            prop,
            "recursive watching has no lowering yet — kqueue watches the one opened path; watch each path",
          );
        }
        if (key === "encoding") {
          const enc = init !== null && ts.isStringLiteralLike(init) ? init.text : null;
          if (enc === "utf8" || enc === "utf-8") continue;
          L.noLowering(
            "fs.watch with a non-utf8 encoding",
            prop,
            "the encoding applies to the filename argument, which has no lowering — utf8 (the default) is accepted",
          );
        }
        if (key === "signal") {
          L.noLowering(
            "fs.watch with an abort signal",
            prop,
            "abortable watchers have no lowering — call watcher.close() instead",
          );
        }
        fenceOrDropOptionKey(
          L, prop, key, "fs.watch", FS_WATCH_DOCUMENTED_OPTIONS,
          "persistent: true, recursive: false, and encoding: \"utf8\" are the accepted options",
        );
        // An undocumented key, dropped like Node drops it.
      }
    }
    const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
    const args: IrExpr[] = [path];
    const listenerArg = hasOptions
      ? (expr.arguments.length === 3 ? expr.arguments[2]! : null)
      : (expr.arguments.length === 2 ? expr.arguments[1]! : null);
    if (listenerArg !== null) {
      const cb = L.lowerExpr(listenerArg);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
        L.noLowering(
          "fs.watch with this listener shape",
          listenerArg,
          "the listener takes () or (eventType: string) — the filename parameter has no lowering (you watched one path)",
        );
      }
      const param = cb.type.params[0];
      if (param !== undefined && param.kind !== "string") {
        L.unsupported(
          "SC1090",
          listenerArg,
          `watch listeners whose parameter is not the eventType string (got '${L.fmt(param)}')`,
        );
      }
      args.push(cb);
    }
    return { kind: "libCall", fn: args.length === 2 ? "fs.watchCb" : "fs.watch", args, type: FSWATCHER_T, loc };
  }

/** Method calls on FSWatcher receivers: close() — idempotent, statement
   * position (Node returns void there too). Everything else @types/node
   * declares (ref/unref, the EventEmitter surface) fences member-
   * qualified. Null for non-watcher receivers. */
  export function lowerWatcherMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "fsWatcher") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "close" && call.arguments.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      return { kind: "libCall", fn: "watcher.close", args: [receiver], type: VOID, loc };
    }
    L.noLowering(
      `FSWatcher.${name}`,
      call,
      "close() is the supported FSWatcher member",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** `.code` on an error-hierarchy receiver — NodeJS.ErrnoException's
   * member (the fallback declares the same shape): the runtime Error's
   * code slot as `string | undefined` — the errno name where a throw site
   * stamped one (fs, exec spawn/timeout, process.kill, the spawn 'error'
   * event), undefined everywhere else. Stdlib provenance required (a user
   * class's own `code` field takes the ordinary field paths — its
   * declaration is not stdlib). Reads only: writes keep their fence (no
   * compiled program constructs an errno error). Null for non-error
   * receivers and non-stdlib members, so the chain keeps trying. */
  export function lowerErrorCodeProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    // `?.code` re-dispatches through the optional-chain machinery (the
    // mdns `(r.error as ErrnoException | undefined)?.code` idiom): the
    // chain-handled marker means the receiver already narrowed to the
    // non-unit arm and reads as chainRecv below.
    if (expr.questionDotToken && !L.chainHandled.has(expr)) return null;
    const recvT = L.mapTypeOf(L.typeOf(expr.expression));
    if (recvT?.kind !== "object") return null;
    // %DOMException's OWN read surface first: `code` is the WebIDL legacy
    // NUMBER (never the errno string slot), and `cause` reads the options
    // form's stored value (Node's undefined when absent). Both live in
    // runtime slots beyond the ScrError prefix, reached by dedicated
    // libCalls.
    if (recvT.className === "%DOMException" && L.isStdlibMember(expr)) {
      if (expr.name.text === "code") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "libCall", fn: "error.domCode", args: [receiver], type: F64, loc: locOf(expr) };
      }
      if (expr.name.text === "cause") {
        const receiver = L.lowerExpr(expr.expression);
        return { kind: "libCall", fn: "error.domCause", args: [receiver], type: DYN, loc: locOf(expr) };
      }
    }
    if (expr.name.text !== "code") return null;
    // Error-rooted classes only — builtin or user subclass (both embed the
    // code slot in their layout prefix).
    let info = L.classes.get(recvT.className) ?? null;
    while (info && info.base) info = info.base;
    if (!info || info.def.name !== "%Error") return null;
    if (!L.isStdlibMember(expr)) return null;
    const receiver = L.lowerExpr(expr.expression);
    return {
      kind: "libCall",
      fn: "error.code",
      args: [receiver],
      type: L.envValueType(),
      loc: locOf(expr),
    };
  }

/** `JSON.parse` / `JSON.stringify` referenced without a call: rejected
   * specifically, like process methods as values. Null for non-JSON
   * receivers (the property chain keeps trying other lowerings). */
  export function lowerJsonProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    const member = L.stdlibGlobalMember(expr, "JSON");
    if (member === null) return null;
    L.unsupported("SC1090", expr, `JSON methods as values (call '${member}' directly)`);
  }

/** `constants.X_OK` where `constants` is a named fs import: the access-
   * mode bits bake as number literals (POSIX values — Node's own on the
   * supported hosts). Other fs.constants members (COPYFILE_*, O_*) fence
   * by name. Null for non-fs-constants receivers. */
  export function lowerFsConstantsProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    if (!ts.isIdentifier(expr.expression)) return null;
    const bi = L.builtinImportOf(expr.expression);
    if (!bi || bi.module !== "fs" || bi.member !== "constants") return null;
    const MODES: Record<string, number | undefined> = { F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4 };
    const value = own(MODES, expr.name.text);
    if (value === undefined) {
      L.noLowering(
        `fs.constants.${expr.name.text}`,
        expr,
        "F_OK, R_OK, W_OK, and X_OK are the lowered constants",
      );
    }
    return { kind: "numLit", value, type: F64, loc: locOf(expr) };
  }

/** `process.stdin/stdout/stderr.isTTY` → isatty(3) on the stream's fd
   * (a REAL boolean: Node's non-TTY streams expose `undefined` here — the
   * documented divergence; truthiness tests, the actual usage, agree), and
   * `process.stdout/stderr.columns` → ioctl(TIOCGWINSZ) on the fd, with
   * Node's non-TTY answer intact: the read is `number | undefined` and a
   * non-TTY (or ioctl-refusing) stream yields the undefined arm. The
   * receiver match sees through parens and as-casts to the SYMBOL —
   * `(process.stderr as typeof process.stderr & { columns?: number })
   * .columns` is the wild widening pattern (@types/node declares a plain
   * `number`, so honest code casts the undefined possibility back in), and
   * the cast changes the expression's TYPE, never the value. columns sites
   * whose checker type does NOT admit undefined are fenced with that exact
   * fix instead of lowering to a lie. Null for anything else, so the
   * property chain keeps trying. */
  export function lowerProcessStreamProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    const member = expr.name.text;
    if (member !== "isTTY" && member !== "columns") return null;
    let recv: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isTypeAssertion(recv)) recv = recv.expression;
    if (!ts.isPropertyAccessExpression(recv)) return null;
    const stream = L.stdlibGlobalMember(recv, "process");
    if (stream !== "stdin" && stream !== "stdout" && stream !== "stderr") return null;
    const loc = locOf(expr);
    const fd: IrExpr = {
      kind: "numLit",
      value: stream === "stdin" ? 0 : stream === "stdout" ? 1 : 2,
      type: F64,
      loc,
    };
    if (member === "isTTY") {
      return { kind: "libCall", fn: "process.isTTY", args: [fd], type: BOOL, loc };
    }
    if (stream === "stdin") return null; // no columns on a ReadStream — generic fences apply
    const declared = L.mapTypeOf(L.typeOf(expr));
    const want = L.withUndefinedArm(F64);
    // JS files skip the annotation fence: there is no annotation to fix —
    // the read IS Node's `number | undefined` and lowers to exactly that
    // (commander's `isTTY ? columns : undefined` help-width probes).
    if ((!declared || typeKey(declared) !== typeKey(want)) && !isJsSourceFile(expr.getSourceFile())) {
      L.noLowering(
        `process.${stream}.columns as a plain number`,
        expr,
        "on a non-TTY stream Node's .columns is undefined — type the read to admit it: " +
          `(process.${stream} as typeof process.${stream} & { columns?: number }).columns`,
      );
    }
    return { kind: "libCall", fn: "process.columns", args: [fd], type: want, loc };
  }

/** `process.argv` / `process.platform` / `process.pid` property READS
   * lower to zero-arg libCalls (argv returns +1 on one interned array —
   * identity and mutation semantics match Node's stable process.argv).
   * `process.env` as a WHOLE value lowers to a fresh SNAPSHOT record —
   * `{ [k: string]: string | undefined }` built over environ by the
   * interned %env.snapshot helper: `{ ...process.env }`, Object.keys, and
   * spawn-env flows all snapshot at the read, exactly what Node's own
   * spread does (and nothing in a compiled program mutates environ between
   * a snapshot and its use except process.env writes, which precede the
   * read in source order). Method members referenced without a call are
   * rejected specifically. Null for non-process receivers (the chain keeps
   * trying other property lowerings). */
  export function lowerProcessProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    // process.versions.node — the ONE lowered member of process.versions:
    // there is no Node under the binary, so the honest answer is the
    // runtime's own Node compatibility target (the version whose semantics
    // SEMANTICS.md verifies against — divergence 60, the execPath stance).
    // Other versions members (v8, openssl, ...) name components that do
    // not exist here and fall through to the member fence.
    if (
      (expr.name.text === "node" || expr.name.text === "openssl") &&
      !expr.questionDotToken &&
      ts.isPropertyAccessExpression(expr.expression) &&
      L.stdlibGlobalMember(expr.expression, "process") === "versions"
    ) {
      // versions.openssl answers the compat target's string for the same
      // reason versions.node does: Boolean(versions.openssl) is Node's own
      // "is crypto available" probe, and the crypto module exists here
      // (unsupported members fence per site). SEMANTICS.md documents that
      // the string names the compat target, not a linked library.
      const fn = expr.name.text === "node" ? "process.versionsNode" : "process.versionsOpenssl";
      return { kind: "libCall", fn, args: [], type: STRING, loc: locOf(expr) };
    }
    // The capability-probe members that honestly DON'T EXIST in a
    // compiled binary — each reads undefined (their declared types carry
    // the undefined arm), so feature probes take their documented
    // fallbacks: no OpenSSL/SQLite components (process.versions.openssl/
    // .sqlite), no gyp build config (process.config.variables.* — no ICU,
    // no QUIC — and process.config.target_defaults), no feature flags
    // (process.features.* — no inspector, not a debug build).
    if (!expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
      const container = L.stdlibGlobalMember(expr.expression, "process");
      if (container === "versions" && (expr.name.text === "sqlite" || expr.name.text === "bun" || expr.name.text === "deno")) {
        // versions.bun / versions.deno are the OTHER-runtime probes (a
        // formatter's config loader picks its package.json reader by
        // them): a compiled binary is neither, so both read undefined —
        // exactly Node's own answer.
        return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
      }
      if (container === "features") {
        return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
      }
      if (container === "config" && (expr.name.text === "variables" || expr.name.text === "target_defaults")) {
        // `target_defaults` reads undefined directly. `variables` only
        // appears as the receiver of a member read — that OUTER access is
        // the undefined answer (below); a bare `variables` value fences.
        if (expr.name.text === "target_defaults") {
          return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
        }
      }
      // process.config.variables.<name> — the full chain.
      if (
        ts.isPropertyAccessExpression(expr.expression.expression) &&
        expr.expression.name.text === "variables" &&
        L.stdlibGlobalMember(expr.expression.expression, "process") === "config"
      ) {
        return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
      }
    }
    const member = L.stdlibGlobalMember(expr, "process");
    if (member === null) return null;
    const loc = locOf(expr);
    if (member === "argv") {
      return { kind: "libCall", fn: "process.argv", args: [], type: arrayOf(STRING), loc };
    }
    // process.execArgv: the extra CLI arguments Node itself consumed — a
    // compiled binary consumed none, so the honest answer is a fresh [].
    if (member === "execArgv") {
      return { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
    }
    // process._exiting — the runtime's exit-sequence flag (true while
    // 'exit' listeners run), Node's own undocumented member.
    if (member === "_exiting") {
      return { kind: "libCall", fn: "process.exiting", args: [], type: BOOL, loc };
    }
    if (member === "platform") {
      return { kind: "libCall", fn: "process.platform", args: [], type: STRING, loc };
    }
    // process.arch: the compiled binary's OWN architecture ("arm64",
    // "x64") — the same answer Node gives for its own build on the same
    // machine.
    if (member === "arch") {
      return { kind: "libCall", fn: "process.arch", args: [], type: STRING, loc };
    }
    if (member === "pid") {
      return { kind: "libCall", fn: "process.pid", args: [], type: F64, loc };
    }
    // process.execPath: the compiled binary's own resolved absolute path —
    // the honest answer where Node's is the node executable's (SEMANTICS.md
    // divergence 12, the argv[0]/argv[1] precedent).
    if (member === "execPath") {
      return { kind: "libCall", fn: "process.execPath", args: [], type: STRING, loc };
    }
    if (member === "env") {
      const mapped = L.mapTypeOf(L.typeOf(expr));
      if (mapped?.kind === "record") {
        const helper = L.envSnapshotHelper(mapped.shapeId, loc);
        if (helper !== null) {
          return { kind: "call", callee: helper, args: [], type: mapped, loc };
        }
      }
      L.unsupported(
        "SC1090",
        expr,
        "process.env as a value of this type (read one variable: process.env.NAME or process.env[name])",
      );
    }
    if (member === "exit" || member === "cwd" || member === "getuid" || member === "kill") {
      L.unsupported("SC1090", expr, `process methods as values (call '${member}' directly)`);
    }
    // process.stdout / process.stderr as first-class VALUES (flowing into
    // a `NodeJS.WritableStream` slot — the prefixStream idiom): the
    // procStream scalar, minted as the stream's fd. Member reads
    // (`process.stdout.isTTY`, `.write(...)`) never reach here — their
    // OUTER expressions dispatch first.
    if (member === "stdout" || member === "stderr") {
      return { kind: "numLit", value: member === "stdout" ? 1 : 2, type: PROCSTREAM_T, loc };
    }
    // Other members: type errors under the fallback declarations; with
    // @types/node they typecheck and fall through to stdlibMemberFence
    // (SC2020 naming process.<member>, with the console.log hint for
    // stdout/stderr).
    return null;
  }

/** True iff `node` is THE ambient `process.env` object itself (the
   * receiver of an env read). */
  export function isProcessEnv(L: Lowerer, node: ts.Expression): boolean {
    return ts.isPropertyAccessExpression(node) && L.stdlibGlobalMember(node, "process") === "env";
  }

/** The interned `string | undefined` union — the type every env read
   * produces (withUndefinedArm interns [string, undefined] in canonical
   * order, so the string arm's tag is 0 and the undefined arm's is 1,
   * program-wide). */
  export function envValueType(L: Lowerer): IrType {
    return L.withUndefinedArm(STRING);
  }

/** `os.networkInterfaces()` — getifaddrs(3) behind Node's exact result
   * type. The libCall's type is the CALL SITE's mapped
   * `NodeJS.Dict<NetworkInterfaceInfo[]>`: a pure index-signature record
   * whose value is `Info[] | undefined`, Info the two-record union
   * @types/node declares (IPv4: `scopeid?: number` — the undefined-armed
   * union — and IPv6: `scopeid: number`; family literal types collapse to
   * string in both). The emitter derives every shape/union/tag from that
   * type, so the structure is verified HERE and anything else (an older
   * @types/node, a user alias reshaping the result) fences honestly. Key
   * and row order follow getifaddrs enumeration — Node itself guarantees
   * no order (compare structurally). */
/** `fs.readdirSync(path, { withFileTypes: true })` — Dirent rows: name +
   * parentPath (the path argument as given, Node's own rule) + the hidden
   * %dtype entry kind (libuv's UV_DIRENT encoding; DT_UNKNOWN falls back
   * to lstat, Node's getDirents rule). The options literal is checked
   * member-by-member; the result type must be the interned Dirent record
   * array from types.ts — anything else (encoding: 'buffer', a user alias
   * reshaping Dirent) fences honestly. */
  export function lowerFsReaddirTypesCall(L: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
    const optsNode = call.arguments[1]!;
    if (!ts.isObjectLiteralExpression(optsNode)) {
      L.noLowering(
        "readdirSync with a non-literal options argument",
        optsNode,
        "pass the options inline so each member can be checked: readdirSync(path, { withFileTypes: true })",
      );
    }
    let sawWithFileTypes = false;
    for (const p of optsNode.properties) {
      const m = optionMember(p);
      if (!m) {
        L.noLowering(
          "readdirSync with this options shape",
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      if (m.name === "withFileTypes") {
        const t = L.typeOf(m.value);
        if (!(t.flags & ts.TypeFlags.BooleanLiteral) || L.checker.typeToString(t) !== "true") {
          L.noLowering(
            "readdirSync with a non-literal-true withFileTypes",
            m.value,
            "withFileTypes: true is the Dirent form; omit the options for plain names",
          );
        }
        sawWithFileTypes = true;
      } else if (m.name === "encoding") {
        const t = L.typeOf(m.value);
        if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
          L.noLowering(
            "readdirSync with a non-utf8 encoding",
            m.value,
            "names decode as utf8 (the default); encoding: 'buffer' has no lowering",
          );
        }
      } else {
        // The options-record stance: recursive (a documented knob with
        // no lowering) fences by name; undocumented keys drop like Node.
        fenceOrDropOptionKey(
          L, p, m.name, "readdirSync", FS_READDIR_DOCUMENTED_OPTIONS,
          "withFileTypes: true (and the default encoding) is the supported options surface — recursive listings want an explicit walk",
        );
      }
    }
    if (!sawWithFileTypes) {
      L.noLowering(
        "readdirSync with 2 arguments",
        call,
        "readdirSync(path) lists names; readdirSync(path, { withFileTypes: true }) lists Dirents",
      );
    }
    const fence: () => never = () =>
      L.noLowering(
        "readdirSync(path, { withFileTypes: true }) where the result is not the Dirent array",
        call,
        "{ name, parentPath, isFile(), isDirectory(), isSymbolicLink() } rows are the supported result shape",
      );
    const result = L.mapTypeOf(L.typeOf(call));
    if (result?.kind !== "array" || result.elem.kind !== "record") fence();
    const shape = L.shapes.get(result.elem.shapeId);
    if (
      !shape ||
      shape.tuple ||
      shape.indexValue ||
      shape.fields.length !== 3 ||
      !shape.fields.some((f) => f.name === "%dtype")
    ) {
      fence();
    }
    const path = L.lowerExprExpecting(call.arguments[0]!, STRING);
    return { kind: "libCall", fn: "fs.readdirTypesSync", args: [path], type: result, loc };
  }

/** `d.isFile()` / `d.isDirectory()` / `d.isSymbolicLink()` on a Dirent-
   * typed receiver (the interned record — provenance via the checker's
   * Dirent symbol, the StringDecoder pattern): a read of the hidden
   * %dtype field compared against libuv's UV_DIRENT code. Node's other
   * type probes (isBlockDevice, ...) fence with the supported list. */
  export function lowerDirentMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!L.isStdlibMember(access)) return null;
    const recvSym = L.typeOf(access.expression).getSymbol();
    if (recvSym?.name !== "Dirent") return null;
    const receiver = L.lowerExpr(access.expression);
    if (receiver.type.kind !== "record") return null;
    const shape = L.shapes.get(receiver.type.shapeId);
    if (!shape?.fields.some((f) => f.name === "%dtype")) return null;
    const name = access.name.text;
    const loc = locOf(call);
    // libuv's UV_DIRENT encoding (scr_fs_scandir answers it).
    const code = name === "isFile" ? 1 : name === "isDirectory" ? 2 : name === "isSymbolicLink" ? 3 : -1;
    if (code < 0) {
      L.noLowering(
        `Dirent.${name}`,
        call,
        "name, parentPath, isFile(), isDirectory(), and isSymbolicLink() are the supported Dirent members",
        L.checker.getSymbolAtLocation(access.name),
      );
    }
    if (call.arguments.length !== 0) L.noLowering(`Dirent.${name} with arguments`, call);
    const dtype: IrExpr = {
      kind: "recordGet",
      obj: receiver,
      shapeId: receiver.type.shapeId,
      field: "%dtype",
      type: F64,
      loc,
    };
    return {
      kind: "bin",
      op: "===",
      left: dtype,
      right: { kind: "numLit", value: code, type: F64, loc },
      type: BOOL,
      loc,
    };
  }

/** `os.userInfo()` — the passwd-entry snapshot, Node's uv_os_get_passwd
   * behind the call site's own mapped record shape: username = pw_name,
   * uid/gid = getuid/getgid, shell = pw_shell (as the `string | null`
   * union @types/node declares — POSIX always answers the string arm;
   * null is Node's Windows answer), homedir = pw_dir (the PASSWD home,
   * NOT os.homedir's $HOME-first cascade — Node's own split). The record
   * assembles field-by-field from scalar libCalls in the shape's
   * declaration order; unknown fields and the options argument fence. */
  function lowerOsUserInfoCall(L: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (call.arguments.length !== 0) {
      L.noLowering(
        "userInfo with options",
        call,
        "the zero-argument call is the lowered form (Node's buffer encoding option has no lowering)",
      );
    }
    const fence: () => never = () =>
      L.noLowering(
        "userInfo() where the result is not the UserInfo record",
        call,
        "{ username, uid, gid, shell, homedir } is the supported result shape",
      );
    const result = L.mapTypeOf(L.typeOf(call));
    if (result?.kind !== "record") fence();
    const shape = L.shapes.get(result.shapeId);
    if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0) fence();
    const fields: { name: string; value: IrExpr }[] = [];
    for (const f of shape.fields) {
      if (f.name === "username" && f.type.kind === "string") {
        fields.push({ name: f.name, value: { kind: "libCall", fn: "os.userName", args: [], type: STRING, loc } });
      } else if (f.name === "uid" && f.type.kind === "f64") {
        fields.push({ name: f.name, value: { kind: "libCall", fn: "process.getuid", args: [], type: F64, loc } });
      } else if (f.name === "gid" && f.type.kind === "f64") {
        fields.push({ name: f.name, value: { kind: "libCall", fn: "process.getgid", args: [], type: F64, loc } });
      } else if (f.name === "homedir" && f.type.kind === "string") {
        fields.push({ name: f.name, value: { kind: "libCall", fn: "os.userHomedir", args: [], type: STRING, loc } });
      } else if (f.name === "shell") {
        // `string | null` (the @types/node shape) wraps the always-string
        // POSIX answer into its arm; a plain-string mapping takes it raw.
        const raw: IrExpr = { kind: "libCall", fn: "os.userShell", args: [], type: STRING, loc };
        if (f.type.kind === "string") {
          fields.push({ name: f.name, value: raw });
        } else if (f.type.kind === "union") {
          const tag = L.armTag(f.type.unionId, STRING);
          if (tag < 0) fence();
          fields.push({
            name: f.name,
            value: { kind: "unionWrap", unionId: f.type.unionId, tag, value: raw, type: f.type, loc },
          });
        } else {
          fence();
        }
      } else {
        fence();
      }
    }
    return { kind: "recordLit", fields, type: result, loc };
  }

  /** querystring's sep/eq arguments: an omitted argument, the literal
   * null, and the literal undefined all mean the default (Node's falsy
   * rule — parse(s, null, null, opts) is the canonical maxKeys spelling);
   * a string expression passes through (the runtime applies the same
   * falsy rule to '' at runtime). Everything else fences. */
  function qsSepEqArg(L: Lowerer, node: ts.Expression | undefined, dflt: string,
    what: string, loc: SrcLoc,): IrExpr {
    if (
      !node ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node) && node.text === "undefined")
    ) {
      return { kind: "strLit", value: dflt, type: STRING, loc };
    }
    const v = L.lowerExpr(node);
    if (v.type.kind !== "string") {
      L.noLowering(
        `${what} with a '${L.fmt(v.type)}' separator`,
        node,
        "pass a string, or null/undefined for the default (narrow unions first)",
      );
    }
    return v;
  }

  /** querystring.parse / querystring.decode: the scan runs in the runtime
   * (scr_qs_parse_into fills the result dictionary's overflow map), so the
   * frontend completes sep/eq/maxKeys to Node's defaults and verifies the
   * call site's mapped result IS the ParsedUrlQuery dictionary — a pure
   * index-signature record over `string | string[]` (an undefined arm
   * tolerated: @types/node's Dict) — the networkInterfaces verification
   * stance. The default decoder is the one lowered decoder; a custom
   * decodeURIComponent option fences by name. */
  export function lowerQuerystringParseCall(L: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (call.arguments.length > 4 || call.arguments.some(ts.isSpreadElement)) {
      L.noLowering(`querystring.parse with ${call.arguments.length} arguments`, call);
    }
    const fence: () => never = () =>
      L.noLowering(
        "querystring.parse where the result is not the ParsedUrlQuery dictionary",
        call,
        "the `{ [key: string]: string | string[] }` shape is the supported result",
      );
    const result = L.mapTypeOf(L.typeOf(call));
    if (result?.kind !== "record") fence();
    const dictShape = L.shapes.get(result.shapeId);
    if (!dictShape || dictShape.tuple || dictShape.fields.length > 0 || !dictShape.indexValue) fence();
    const iv = dictShape.indexValue;
    if (iv.kind !== "union") fence();
    const ivDef = L.unions.get(iv.unionId);
    if (!ivDef) fence();
    let sawStr = false;
    let sawArr = false;
    for (const arm of ivDef.arms) {
      if (arm.kind === "string") sawStr = true;
      else if (arm.kind === "array" && arm.elem.kind === "string") sawArr = true;
      // undefined rides @types/node's Dict; the f64 arm is the
      // header-family canonicalization (types.ts interns every
      // `string | string[]`-slotted dictionary as the one canonical
      // header shape, whose slot adds number type-level only — parse
      // never stores one).
      else if (arm.kind !== "undefinedT" && arm.kind !== "f64") fence();
    }
    if (!sawStr || !sawArr) fence();
    const str = call.arguments[0]
      ? L.lowerExprExpecting(call.arguments[0], STRING)
      : L.noLowering("querystring.parse without a query string", call);
    const sep = qsSepEqArg(L, call.arguments[1], "&", "querystring.parse", loc);
    const eq = qsSepEqArg(L, call.arguments[2], "=", "querystring.parse", loc);
    // The options walk: maxKeys lowers (Node's rule — > 0 caps the pair
    // count, 0 and negatives mean unlimited — lives in the runtime, so
    // any number expression works); a custom decodeURIComponent changes
    // every decoded byte and fences by name.
    let maxKeys: IrExpr = { kind: "numLit", value: 1000, type: F64, loc };
    const optsNode = call.arguments[3];
    if (optsNode) {
      if (!ts.isObjectLiteralExpression(optsNode)) {
        L.noLowering(
          "querystring.parse with a non-literal options argument",
          optsNode,
          "the supported form spells the options inline: parse(s, sep, eq, { maxKeys: n })",
        );
      }
      for (const p of optsNode.properties) {
        const m = optionMember(p);
        if (!m) {
          L.noLowering(
            "querystring.parse with this options shape",
            p,
            "spreads and computed keys have no lowering — write each member inline",
          );
        }
        if (m.name === "maxKeys") {
          maxKeys = L.lowerExprExpecting(m.value, F64);
        } else if (m.name === "decodeURIComponent") {
          L.noLowering(
            "querystring.parse with a custom decodeURIComponent",
            p,
            "the default decoder is the lowered surface (strict decodeURIComponent with Node's lenient fallback)",
          );
        } else {
          fenceOrDropOptionKey(
            L, p, m.name, "querystring.parse", QS_PARSE_DOCUMENTED_OPTIONS,
            "maxKeys is the supported option",
          );
        }
      }
    }
    return { kind: "libCall", fn: "qs.parse", args: [str, sep, eq, maxKeys], type: result, loc };
  }

  /** querystring.stringify / querystring.encode: the object crosses as a
   * dyn value (dynFrom — JSON-safe records and, in JS sources, dyn values
   * directly) and Node's encodeStringified rules run in the runtime
   * (scr_qs_stringify), so arrays expand to repeated keys and
   * null/undefined values are empty. The default encoder is the one
   * lowered encoder; a custom encodeURIComponent option fences by name. */
  export function lowerQuerystringStringifyCall(L: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (call.arguments.length > 4 || call.arguments.some(ts.isSpreadElement)) {
      L.noLowering(`querystring.stringify with ${call.arguments.length} arguments`, call);
    }
    const objNode = call.arguments[0];
    // stringify() / stringify(undefined) / stringify(null): Node answers
    // '' for every non-object — the constant folds.
    if (
      !objNode ||
      objNode.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(objNode) && objNode.text === "undefined")
    ) {
      return { kind: "strLit", value: "", type: STRING, loc };
    }
    const objV = L.lowerExpr(objNode);
    let obj: IrExpr;
    if (objV.type.kind === "dyn") {
      obj = objV;
    } else if (objV.type.kind === "record" && L.dynConvertible(objV.type)) {
      obj = { kind: "dynFrom", value: objV, type: DYN, loc };
    } else {
      L.noLowering(
        `querystring.stringify of '${L.fmt(objV.type)}' values`,
        objNode,
        "pass a record of string/number/boolean values (arrays of those expand to repeated keys; null/undefined values serialize empty)",
      );
    }
    const sep = qsSepEqArg(L, call.arguments[1], "&", "querystring.stringify", loc);
    const eq = qsSepEqArg(L, call.arguments[2], "=", "querystring.stringify", loc);
    const optsNode = call.arguments[3];
    if (optsNode) {
      if (!ts.isObjectLiteralExpression(optsNode)) {
        L.noLowering(
          "querystring.stringify with a non-literal options argument",
          optsNode,
          "the supported form spells the options inline (and the only documented option, encodeURIComponent, has no lowering)",
        );
      }
      for (const p of optsNode.properties) {
        const m = optionMember(p);
        if (!m) {
          L.noLowering(
            "querystring.stringify with this options shape",
            p,
            "spreads and computed keys have no lowering — write each member inline",
          );
        }
        if (m.name === "encodeURIComponent") {
          L.noLowering(
            "querystring.stringify with a custom encodeURIComponent",
            p,
            "the default encoder (querystring.escape's component set) is the lowered surface",
          );
        } else {
          fenceOrDropOptionKey(
            L, p, m.name, "querystring.stringify", QS_STRINGIFY_DOCUMENTED_OPTIONS,
            "no stringify options have a lowering",
          );
        }
      }
    }
    return { kind: "libCall", fn: "qs.stringify", args: [obj, sep, eq], type: STRING, loc };
  }

  export function lowerOsNetworkInterfacesCall(L: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
    if (call.arguments.length !== 0) {
      L.noLowering(`networkInterfaces with ${call.arguments.length} arguments`, call, "networkInterfaces() takes no arguments");
    }
    // Annotated as a never-returning const so tsc's control flow narrows
    // through the structural checks below.
    const fence: () => never = () =>
      L.noLowering(
        "networkInterfaces() where the result is not the NetworkInterfaceInfo dictionary",
        call,
        "@types/node's NodeJS.Dict<NetworkInterfaceInfo[]> shape is the supported result",
      );
    const result = L.mapTypeOf(L.typeOf(call));
    if (result?.kind !== "record") fence();
    const dictShape = L.shapes.get(result.shapeId);
    if (!dictShape || dictShape.tuple || dictShape.fields.length > 0 || !dictShape.indexValue) fence();
    const iv = dictShape.indexValue;
    if (iv.kind !== "union") fence();
    const ivDef = L.unions.get(iv.unionId);
    const arrArm = ivDef?.arms.find((a) => a.kind === "array");
    if (!ivDef || ivDef.arms.length !== 2 || arrArm?.kind !== "array" || !ivDef.arms.some((a) => a.kind === "undefinedT")) fence();
    const info = arrArm.elem;
    if (info.kind !== "union") fence();
    const infoDef = L.unions.get(info.unionId);
    if (!infoDef || infoDef.arms.length !== 2) fence();
    // One arm per family, distinguished by scopeid: plain number = IPv6,
    // `number | undefined` = IPv4. Every other field is shared.
    let saw4 = false;
    let saw6 = false;
    for (const arm of infoDef.arms) {
      if (arm.kind !== "record") fence();
      const shape = L.shapes.get(arm.shapeId);
      if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== 7) fence();
      const f = (name: string): IrType | undefined => shape.fields.find((x) => x.name === name)?.type;
      for (const s of ["address", "family", "mac", "netmask"]) {
        if (f(s)?.kind !== "string") fence();
      }
      if (f("internal")?.kind !== "bool") fence();
      const cidr = f("cidr");
      const cidrDef = cidr?.kind === "union" ? L.unions.get(cidr.unionId) : undefined;
      if (
        !cidrDef ||
        cidrDef.arms.length !== 2 ||
        !cidrDef.arms.some((a) => a.kind === "string") ||
        !cidrDef.arms.some((a) => a.kind === "nullT")
      ) {
        fence();
      }
      const scopeid = f("scopeid");
      if (scopeid?.kind === "f64") {
        saw6 = true;
      } else {
        const sDef = scopeid?.kind === "union" ? L.unions.get(scopeid.unionId) : undefined;
        if (
          !sDef ||
          sDef.arms.length !== 2 ||
          !sDef.arms.some((a) => a.kind === "f64") ||
          !sDef.arms.some((a) => a.kind === "undefinedT")
        ) {
          fence();
        }
        saw4 = true;
      }
    }
    if (!saw4 || !saw6) fence();
    return { kind: "libCall", fn: "os.networkInterfaces", args: [], type: result, loc };
  }

/** `process.env.NAME` → the process.envGet intrinsic with a literal key
   * (the element form lands in lowerElementAccess). getenv(3) at runtime:
   * present wraps the string arm, absent yields the interned
   * undefined-arm instance. Null for non-env receivers. */
  export function lowerProcessEnvGet(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    if (!L.isProcessEnv(expr.expression)) return null;
    const loc = locOf(expr);
    const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
    return { kind: "libCall", fn: "process.envGet", args: [key], type: L.envValueType(), loc };
  }

/** `process.exit(code)` / `process.cwd()` → libCall. The fallback
   * declaration makes exit's code required; @types/node declares it
   * optional, and a bare `process.exit()` lowers as exit(0) — exactly
   * Node's behavior when process.exitCode was never set (setting exitCode
   * is fenced like every other unsupported process member, so "never set"
   * always holds in a compiled program). */
  export function lowerProcessMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    // process.stdout.write(s[, encoding][, callback]) and stderr's twin:
    // raw bytes, no newline or formatting. stdout shares console.log's
    // promptly-submitted stream, preserving source order. Node's boolean
    // is a backpressure signal; this synchronous write is constantly true.
    // String encodings are compile-time-known BufferEncoding spellings;
    // byte chunks evaluate but ignore the encoding like Node. Completion
    // callbacks ride the next-tick queue and receive the success `null`.
    // process.stdin.destroy(): a deliberate no-op — no stream machinery
    // exists to tear down, and no other stdin surface observes the
    // destroyed state (SEMANTICS.md documents it).
    if (
      access.name.text === "destroy" &&
      ts.isPropertyAccessExpression(access.expression) &&
      L.stdlibGlobalMember(access.expression, "process") === "stdin"
    ) {
      if (call.arguments.length !== 0) {
        L.noLowering("stdin.destroy with arguments", call);
      }
      return { kind: "libCall", fn: "process.stdinDestroy", args: [], type: VOID, loc: locOf(call) };
    }
    // process.stdin.setRawMode(mode): termios raw mode when stdin IS a
    // TTY (libuv's UV_TTY_MODE_RAW — the flag set Node applies; false
    // restores the entry state). When stdin is NOT a TTY, Node's
    // process.stdin is a Socket with no setRawMode member at all, so the
    // call throws Node's exact catchable TypeError — the portless
    // exit-hook wraps it in try/catch and relies on exactly that. Node
    // returns `this` for chaining; that composition has no lowering, so
    // statement position (or a concise arrow body) is required.
    if (
      access.name.text === "setRawMode" &&
      ts.isPropertyAccessExpression(access.expression) &&
      L.stdlibGlobalMember(access.expression, "process") === "stdin"
    ) {
      const loc = locOf(call);
      if (!ts.isExpressionStatement(call.parent) && !ts.isArrowFunction(call.parent)) {
        L.unsupported(
          "SC1090",
          call,
          "using the result of stdin.setRawMode(...) (the ReadStream chain — call it as its own statement)",
        );
      }
      if (call.arguments.length !== 1) {
        L.noLowering(
          `stdin.setRawMode with ${call.arguments.length} arguments`,
          call,
          "the supported form is setRawMode(mode) with one boolean",
        );
      }
      const mode = L.lowerExpr(call.arguments[0]!);
      if (mode.type.kind !== "bool") {
        L.noLowering(
          `stdin.setRawMode of '${L.fmt(mode.type)}' modes`,
          call.arguments[0]!,
          "the mode is a boolean here — narrow unions first",
        );
      }
      return { kind: "libCall", fn: "process.stdinSetRawMode", args: [mode], type: VOID, loc };
    }
    // process.stdin.on/once("data" | "end" | "error", cb): the piped-stdin
    // event slice. A 'data' listener keeps the event loop alive until EOF
    // (Node's flowing stdin); 'end'/'error' listeners alone do not. `once`
    // auto-removes after the first delivery. Listener shapes are pinned
    // per event — the runtime adapters cover exactly these.
    if (
      (access.name.text === "on" || access.name.text === "once") &&
      ts.isPropertyAccessExpression(access.expression) &&
      L.stdlibGlobalMember(access.expression, "process") === "stdin"
    ) {
      const loc = locOf(call);
      const once = access.name.text === "once";
      if (call.arguments.length !== 2) {
        L.noLowering(`stdin.${access.name.text} with ${call.arguments.length} arguments`, call);
      }
      const evT = L.typeOf(call.arguments[0]!);
      const event = evT.isStringLiteralType() ? evT.value : null;
      if (event !== "data" && event !== "end" && event !== "error") {
        L.noLowering(
          `stdin.${access.name.text}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
          call.arguments[0]!,
          '"data", "end", and "error" are the supported stdin events (as literals)',
        );
      }
      if (!ts.isExpressionStatement(call.parent)) {
        L.unsupported(
          "SC1090",
          call,
          "chaining stdin listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      const cb = L.lowerExpr(call.arguments[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          "stdin listeners with more than one parameter or a return value",
        );
      }
      const param = cb.type.params[0];
      const onceArg: IrExpr = { kind: "boolLit", value: once, type: BOOL, loc };
      if (event === "data") {
        if (param !== undefined && !(param.kind === "bytes" && param.elem === "u8")) {
          L.unsupported(
            "SC1090",
            call.arguments[1]!,
            `data listeners whose parameter is not 'Uint8Array' (got '${L.fmt(param)}')`,
          );
        }
        return { kind: "libCall", fn: "stdin.onData", args: [cb, onceArg], type: VOID, loc };
      }
      if (event === "end") {
        if (param !== undefined) {
          L.unsupported("SC1090", call.arguments[1]!, "end listeners with parameters (use ())");
        }
        return { kind: "libCall", fn: "stdin.onEnd", args: [cb, onceArg], type: VOID, loc };
      }
      if (param !== undefined && !(param.kind === "object" && param.className === "%Error")) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          `error listeners whose parameter is not 'Error' (got '${L.fmt(param)}')`,
        );
      }
      return { kind: "libCall", fn: "stdin.onError", args: [cb, onceArg], type: VOID, loc };
    }
    if (access.name.text === "write" && ts.isPropertyAccessExpression(access.expression)) {
      const stream = L.stdlibGlobalMember(access.expression, "process");
      if (stream === "stdout" || stream === "stderr") {
        const loc = locOf(call);
        const args = call.arguments;
        if (args.length < 1 || args.length > 3 || args.some(ts.isSpreadElement)) {
          L.noLowering(
            `process.${stream}.write with ${args.length} arguments`,
            call,
            "the supported forms are write(data[, encoding][, callback]) with a static BufferEncoding and completion callback",
          );
        }
        const secondNode = args[1];
        const thirdNode = args[2];
        const secondUndefined = secondNode
          ? lowerStaticallyUndefinedBuiltinArg(L, secondNode)
          : null;
        const thirdUndefined = thirdNode
          ? lowerStaticallyUndefinedBuiltinArg(L, thirdNode)
          : null;
        const secondT = secondNode && !secondUndefined ? L.mapTypeOf(L.typeOf(secondNode)) : undefined;
        const callbackNode = args.length === 3 && !thirdUndefined
          ? thirdNode!
          : args.length === 2 && secondT?.kind === "func"
            ? secondNode!
            : undefined;
        const encodingNode =
          (args.length === 3 || (args.length === 2 && callbackNode === undefined)) && !secondUndefined
            ? secondNode!
            : undefined;

        // Node's BufferEncoding aliases normalize before bytes are made.
        // Preserve an effectful literal-typed expression even when its
        // spelling folds (for example a function returning `"binary"`).
        const encoding: IrExpr = ((): IrExpr => {
          const defaultEncoding = { kind: "strLit", value: "utf8", type: STRING, loc } satisfies IrExpr;
          if (secondUndefined) {
            return defaultAfterUndefined(secondUndefined, defaultEncoding);
          }
          if (!encodingNode) {
            return defaultEncoding;
          }
          const aliases: Record<string, string | undefined> = {
            utf8: "utf8", "utf-8": "utf8", hex: "hex", base64: "base64",
            base64url: "base64url", latin1: "latin1", binary: "latin1", ascii: "ascii",
            utf16le: "utf16le", "utf-16le": "utf16le", ucs2: "utf16le", "ucs-2": "utf16le",
          };
          const t = L.typeOf(encodingNode);
          const raw = t.isStringLiteralType() ? t.value : undefined;
          const canonical = raw !== undefined ? own(aliases, raw) : undefined;
          if (canonical === undefined) {
            L.noLowering(
              `process.${stream}.write with this encoding`,
              encodingNode,
              'use a literal "utf8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", or "ucs2" encoding',
            );
          }
          const evaluated = L.lowerExprExpecting(encodingNode, STRING);
          if (canonical === raw) return evaluated;
          const normalized: IrExpr = { kind: "strLit", value: canonical, type: STRING, loc: locOf(encodingNode) };
          return droppableStatic(evaluated)
            ? normalized
            : {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: evaluated, loc: evaluated.loc }],
              result: normalized,
              type: STRING,
              loc: evaluated.loc,
            };
        })();

        let data = L.lowerExpr(args[0]!);
        // A checked-dynamic argument in a JS file takes the validated
        // string exit (the trust-but-verify boundary: commander's
        // `writeOut: (str) => process.stdout.write(str)` — str untyped):
        // a runtime string writes; anything else throws the dynCheck's
        // honest TypeError at the call.
        if (data.type.kind === "dyn" && isJsSourceFile(call.getSourceFile())) {
          data = { kind: "dynCheck", value: data, type: STRING, loc };
        }
        const isBytes = data.type.kind === "bytes" && data.type.elem === "u8";
        if (!isBytes && data.type.kind !== "string") {
          L.noLowering(
            `process.${stream}.write of non-string data`,
            args[0]!,
            "strings and Buffer/Uint8Array values write; narrow unions first",
          );
        }

        let callback: IrExpr | undefined;
        if (callbackNode) {
          callback = L.lowerExpr(callbackNode);
          if (callback.type.kind === "dyn" && isJsSourceFile(call.getSourceFile())) {
            callback = {
              kind: "dynCheck",
              value: callback,
              type: funcOf([DYN], VOID),
              loc: locOf(callbackNode),
            };
          }
          let callbackOk = callback.type.kind === "func" && callback.type.params.length <= 1;
          if (callbackOk && callback.type.kind === "func" && callback.type.params.length === 1) {
            const param = callback.type.params[0]!;
            if (param.kind !== "dyn") {
              const def = param.kind === "union" ? L.unions.get(param.unionId) : undefined;
              callbackOk = !!def &&
                def.arms.some((a) => a.kind === "nullT") &&
                def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
                def.arms.every((a) =>
                  a.kind === "nullT" || a.kind === "undefinedT" ||
                  (a.kind === "object" && a.className === "%Error"));
            }
          }
          if (!callbackOk) {
            L.unsupported(
              "SC1090",
              callbackNode,
              "process output completion callbacks must accept at most one Error | null parameter",
            );
          }
          callback = voidizedCallback(L, callback, locOf(callbackNode));
        }

        // Encoding- or callback-bearing writes use one fixed byte ABI. For
        // strings, Buffer.from's encoder runs after data/encoding evaluation
        // and before the callback expression; only its pure allocation moves
        // earlier than Node's internal write conversion.
        if (callback || args.length > 1 || isBytes) {
          const bytes = isBytes
            ? data
            : { kind: "libCall", fn: "buffer.fromStr", args: [data, encoding], type: BYTES_U8, loc } satisfies IrExpr;
          const defaultRuntimeEncoding = { kind: "strLit", value: "utf8", type: STRING, loc } satisfies IrExpr;
          let runtimeEncoding = isBytes ? encoding : defaultRuntimeEncoding;
          // An explicitly-undefined third argument is still evaluated after
          // data and encoding, even though it schedules no callback. Strings
          // already evaluate encoding while producing `bytes`; byte chunks
          // fold both ignored argument effects into this final ABI slot.
          if (thirdUndefined && !droppableStatic(thirdUndefined)) {
            const effects = isBytes
              ? [encoding, thirdUndefined].filter((effect) => !droppableStatic(effect))
              : [thirdUndefined];
            runtimeEncoding = {
              kind: "seqExpr",
              stmts: effects.map((effect) => ({ kind: "exprStmt", expr: effect, loc: effect.loc })),
              result: defaultRuntimeEncoding,
              type: STRING,
              loc: thirdUndefined.loc,
            };
          }
          if (callback) {
            return {
              kind: "libCall",
              fn: stream === "stdout" ? "process.stdoutWriteBytesCb" : "process.stderrWriteBytesCb",
              args: [bytes, runtimeEncoding, callback],
              type: BOOL,
              loc,
            };
          }
          return {
            kind: "libCall",
            fn: stream === "stdout" ? "process.stdoutWriteBytes" : "process.stderrWriteBytes",
            args: [bytes, runtimeEncoding],
            type: BOOL,
            loc,
          };
        }
        return {
          kind: "libCall",
          fn: stream === "stdout" ? "process.stdoutWrite" : "process.stderrWrite",
          args: [data],
          type: BOOL,
          loc,
        };
      }
    }
    const member = L.stdlibGlobalMember(access, "process");
    if (member === null) return null;
    const loc = locOf(call);
    // process.on/once/off: the CLI event slice — the SIGINT/SIGTERM
    // signal handlers and the 'exit' hook. Signal listeners run as
    // macrotasks at loop turns, replace the default disposition while
    // registered (removing the last restores Ctrl-C death), and never
    // keep the loop alive; 'exit' listeners run synchronously at
    // termination (normal exit, process.exit, the exit-1 paths) with the
    // exit code. `once` auto-removes; `off` removes by identity (bind
    // the listener to a const so both sites see the same value), and
    // `removeListener` IS `off` — Node aliases them.
    const isOff = member === "off" || member === "removeListener";
    if (member === "on" || member === "once" || isOff) {
      if (call.arguments.length !== 2) {
        L.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
      }
      const evT = L.typeOf(call.arguments[0]!);
      const event = evT.isStringLiteralType() ? evT.value : null;
      // own(), not a bare index: the key is a USER-written event name,
      // and `{ SIGINT: 2 }["__proto__"]` answers Object.prototype — an
      // object flowed into a numLit and emitted itself into the C
      // (test-event-emitter-special-event-names.js's process.on).
      const SIGNALS: Record<string, number | undefined> = { SIGINT: 2, SIGTERM: 15 };
      const signo = event !== null ? own(SIGNALS, event) : undefined;
      // 'unhandledRejection': the listener crosses as a dyn function and
      // the completed-checkpoint report dispatches it (reason, promise) per
      // never-observed rejection instead of printing and exiting 1
      // (scr_async.c). `once` auto-removes after one delivery and
      // `off`/`removeListener` remove by closure identity — the warning
      // registry's story. 'rejectionHandled' is the sibling registry:
      // a handler attached after delivery fires it once, synchronously
      // with the promise.
      if (event === "unhandledRejection" || event === "rejectionHandled") {
        if (!ts.isExpressionStatement(call.parent)) {
          L.unsupported(
            "SC1090",
            call,
            "chaining process listener registration (the result is void here — register each listener as its own statement)",
          );
        }
        const cb = dcSubscriberArg(L, call.arguments[1]!);
        const onceArg: IrExpr = { kind: "boolLit", value: member === "once", type: BOOL, loc };
        const fn: IrLibFn = event === "unhandledRejection"
          ? (isOff ? "process.offUnhandledRejection" : "process.onUnhandledRejection")
          : (isOff ? "process.offRejectionHandled" : "process.onRejectionHandled");
        return { kind: "libCall", fn, args: isOff ? [cb] : [cb, onceArg], type: VOID, loc };
      }
      // 'warning': the listener crosses as a dyn function; emitWarning
      // and the runtime deprecation sites dispatch synchronously
      // (SEMANTICS.md). off/removeListener remove by closure identity.
      if (event === "warning" && (member === "on" || isOff)) {
        if (!ts.isExpressionStatement(call.parent)) {
          L.unsupported(
            "SC1090",
            call,
            "chaining process listener registration (the result is void here — register each listener as its own statement)",
          );
        }
        const cb = dcSubscriberArg(L, call.arguments[1]!);
        return {
          kind: "libCall",
          fn: isOff ? "process.offWarning" : "process.onWarning",
          args: [cb],
          type: VOID,
          loc,
        };
      }
      if (signo === undefined && event !== "exit") {
        L.noLowering(
          `process.${member}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
          call.arguments[0]!,
          '"SIGINT", "SIGTERM", "exit", "warning", "unhandledRejection", and "rejectionHandled" are the supported process events (as literals)',
        );
      }
      if (!ts.isExpressionStatement(call.parent)) {
        L.unsupported(
          "SC1090",
          call,
          "chaining process listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      let cb = L.lowerExpr(call.arguments[1]!);
      // The checked-dynamic listener (test/common's `process.on('exit',
      // runCallChecks)` — an implicit-any JS function, func(dyn)=>dyn, or
      // a dyn VALUE that rode an untyped binding): adapt through the dyn
      // function boundary to the registry's exact shape — box (dynFrom)
      // when needed, then dynCheck into (number)=>void / ()=>void. The
      // adapter delivers the exit code as a dyn argument and releases the
      // result; a non-function dyn value throws the catchable TypeError
      // at REGISTRATION (Node's ERR_INVALID_ARG_TYPE moment).
      {
        const target = funcOf(signo !== undefined || event !== "exit" ? [] : [F64], VOID);
        const exact =
          cb.type.kind === "func" &&
          cb.type.ret.kind === "void" &&
          cb.type.params.length <= 1 &&
          (cb.type.params[0] === undefined || cb.type.params[0].kind === "f64");
        if (!exact) {
          if (cb.type.kind === "dyn") {
            cb = { kind: "dynCheck", value: cb, type: target, loc };
          } else if (
            cb.type.kind === "func" &&
            canBoxFuncIntoDyn(cb.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
          ) {
            cb = {
              kind: "dynCheck",
              value: { kind: "dynFrom", value: cb, type: DYN, loc },
              type: target,
              loc,
            };
          }
        }
      }
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          "process listeners with more than one parameter or a return value",
        );
      }
      const param = cb.type.params[0];
      const onceArg: IrExpr = { kind: "boolLit", value: member === "once", type: BOOL, loc };
      if (signo !== undefined) {
        if (param !== undefined) {
          L.unsupported(
            "SC1090",
            call.arguments[1]!,
            "signal listeners with parameters (the signal name argument has no lowering — use ())",
          );
        }
        const sig: IrExpr = { kind: "numLit", value: signo, type: F64, loc };
        if (isOff) {
          return { kind: "libCall", fn: "process.offSignal", args: [sig, cb], type: VOID, loc };
        }
        return { kind: "libCall", fn: "process.onSignal", args: [sig, cb, onceArg], type: VOID, loc };
      }
      if (param !== undefined && param.kind !== "f64") {
        L.unsupported(
          "SC1090",
          call.arguments[1]!,
          `exit listeners whose parameter is not 'number' (got '${L.fmt(param)}')`,
        );
      }
      if (isOff) {
        return { kind: "libCall", fn: "process.offExit", args: [cb], type: VOID, loc };
      }
      return { kind: "libCall", fn: "process.onExit", args: [cb, onceArg], type: VOID, loc };
    }
    // process.emitWarning(...): the argument vector crosses as ONE dyn
    // array and the runtime applies Node's full grammar (string or Error
    // warning; type/ctor/options second; code/ctor third — wrong kinds
    // throw ERR_INVALID_ARG_TYPE). A single SPREAD of a checked-dynamic
    // array passes that array directly (the suite's forEach-spread
    // shape: `.forEach((args) => process.emitWarning(...args))`).
    if (member === "emitWarning") {
      let argsArr: IrExpr | null = null;
      if (call.arguments.length === 1 && ts.isSpreadElement(call.arguments[0]!)) {
        const spread = L.lowerExpr(call.arguments[0]!.expression);
        if (spread.type.kind === "dyn") {
          argsArr = spread;
        } else {
          L.noLowering(
            "process.emitWarning with a typed spread argument",
            call.arguments[0]!,
            "spread an untyped (checked-dynamic) array, or write the arguments positionally",
          );
        }
      } else {
        argsArr = dcTraceArgsArr(L, call.arguments, loc);
      }
      return { kind: "libCall", fn: "process.emitWarning", args: [argsArr], type: VOID, loc };
    }
    if (member === "cwd") {
      return { kind: "libCall", fn: "process.cwd", args: [], type: STRING, loc };
    }
    // process.nextTick(cb, ...args): the user tick queue — callbacks
    // drain before promise jobs at every loop checkpoint (Node's tick-
    // then-microtask order; the station-time divergence for ticks
    // scheduled by station listeners is SEMANTICS.md territory). The
    // callback adapts exactly like setImmediate's: zero-param passes
    // through, boxable parameterized shapes ride the checked-dynamic
    // boundary, trailing call arguments ride the interned dyn thunk.
    if (member === "nextTick") {
      if (call.arguments.length === 0) {
        L.noLowering(
          "process.nextTick with 0 arguments",
          call,
          "the supported form is process.nextTick(callback, ...args)",
        );
      }
      const cb = timerStyleCallback(L, call.arguments, "process.nextTick", loc);
      return { kind: "libCall", fn: "process.nextTick", args: [cb], type: VOID, loc };
    }
    // The process introspection statics — plain reads of the process's
    // own clocks and counters, Node's shapes exactly.
    if (member === "uptime" || member === "availableMemory" || member === "constrainedMemory") {
      if (call.arguments.length !== 0) {
        L.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
      }
      const fn = member === "uptime" ? "process.uptime"
        : member === "availableMemory" ? "process.availableMemory" : "process.constrainedMemory";
      return { kind: "libCall", fn, args: [], type: F64, loc };
    }
    // process.cpuUsage(prev?) / process.threadCpuUsage(prev?) — the
    // {user, system} microsecond records (getrusage / the thread clock).
    // The prev form validates Node-style (prevValue.user then .system,
    // the ERR_INVALID_ARG_VALUE RangeError with the received number) and
    // answers the per-field diffs; the record evaluates ONCE through an
    // interned helper (the X509Certificate precedent). Typed non-record
    // prevs (Node's ERR_INVALID_ARG_TYPE shapes) keep a pointed fence.
    if (member === "cpuUsage" || member === "threadCpuUsage") {
      const prefix = member === "cpuUsage" ? "cpu" : "threadCpu";
      const t = L.mapTypeOf(L.typeOf(call));
      if (t?.kind !== "record") L.badType(call, L.typeOf(call));
      const shape = L.shapes.get(t.shapeId);
      if (!shape || shape.fields.length !== 2 || !shape.fields.every((f) => f.type.kind === "f64")) {
        L.badType(call, L.typeOf(call));
      }
      const sampleField = (name: string): IrExpr => ({
        kind: "libCall",
        fn: (name === "user" ? `process.${prefix}User` : `process.${prefix}System`) as IrLibFn,
        args: [],
        type: F64,
        loc,
      });
      if (call.arguments.length === 0) {
        return {
          kind: "recordLit",
          fields: shape.fields.map((f) => ({ name: f.name, value: sampleField(f.name) })),
          type: t,
          loc,
        };
      }
      if (call.arguments.length !== 1) {
        L.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
      }
      const prev = L.lowerExpr(call.arguments[0]!);
      const prevShape = prev.type.kind === "record" ? L.shapes.get(prev.type.shapeId) : undefined;
      const prevOk =
        prevShape !== undefined &&
        ["user", "system"].every((n) => prevShape.fields.some((f) => f.name === n && f.type.kind === "f64"));
      if (prev.type.kind !== "record" || !prevOk) {
        L.noLowering(
          `process.${member} of a '${L.fmt(prev.type)}' previous value`,
          call.arguments[0]!,
          "the previous value is the record a prior call answered ({ user, system } numbers) — Node's ERR_INVALID_ARG_TYPE shapes have no lowering",
        );
      }
      const prevT = prev.type;
      const key = `${prefix}usage.diff:${prevT.shapeId}:${t.shapeId}`;
      let helper = L.widthHelpers.get(key);
      if (!helper) {
        helper = `%${prefix}usage.diff.${L.widthHelpers.size}`;
        L.widthHelpers.set(key, helper);
        const pRef: IrExpr = { kind: "varRef", localId: "p.0", type: prevT, loc };
        const fieldOf = (name: string): IrExpr => ({
          kind: "recordGet", obj: pRef, shapeId: prevT.shapeId, field: name, type: F64, loc,
        });
        const diffField = (name: string): IrExpr => ({
          kind: "libCall",
          fn: (name === "user" ? `process.${prefix}UserDiff` : `process.${prefix}SystemDiff`) as IrLibFn,
          args: [fieldOf(name)],
          type: F64,
          loc,
        });
        L.liftedFns.push({
          name: helper,
          params: [{ localId: "p.0", name: "p", type: prevT }],
          returnType: t,
          locals: [{ id: "p.0", name: "p", type: prevT, mutable: false }],
          body: [
            // Node validates prevValue.user THEN prevValue.system, before
            // any sampling — the RangeError order the suite pins.
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall", fn: "process.cpuPrevValidate",
                args: [fieldOf("user"), fieldOf("system")], type: VOID, loc,
              },
              loc,
            },
            {
              kind: "return",
              value: {
                kind: "recordLit",
                fields: shape.fields.map((f) => ({ name: f.name, value: diffField(f.name) })),
                type: t,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
      }
      return { kind: "call", callee: helper, args: [prev], type: t, loc };
    }
    // process.resourceUsage() — getrusage's 16 fields in Node's names and
    // units (CPU times in microseconds, maxRSS in kilobytes).
    if (member === "resourceUsage") {
      if (call.arguments.length !== 0) {
        L.noLowering(`process.resourceUsage with ${call.arguments.length} arguments`, call);
      }
      const t = L.mapTypeOf(L.typeOf(call));
      if (t?.kind !== "record") L.badType(call, L.typeOf(call));
      const shape = L.shapes.get(t.shapeId);
      const RUSAGE_FIELDS = [
        "userCPUTime", "systemCPUTime", "maxRSS", "sharedMemorySize",
        "unsharedDataSize", "unsharedStackSize", "minorPageFault",
        "majorPageFault", "swappedOut", "fsRead", "fsWrite", "ipcSent",
        "ipcReceived", "signalsCount", "voluntaryContextSwitches",
        "involuntaryContextSwitches",
      ];
      if (!shape || !shape.fields.every((f) => RUSAGE_FIELDS.includes(f.name) && f.type.kind === "f64")) {
        L.badType(call, L.typeOf(call));
      }
      return {
        kind: "recordLit",
        fields: shape.fields.map((f) => ({
          name: f.name,
          value: {
            kind: "libCall", fn: "process.rusage",
            args: [{ kind: "numLit", value: RUSAGE_FIELDS.indexOf(f.name), type: F64, loc }],
            type: F64, loc,
          } as IrExpr,
        })),
        type: t,
        loc,
      };
    }
    // process.getActiveResourcesInfo() — the loop's own bookkeeping:
    // 'Timeout' per armed timer (a firing, uncleared one included —
    // Node's lifetime) and 'Immediate' per queued, unfired immediate.
    // DIVERGENCE (SEMANTICS.md): resources this runtime does not model
    // as loop handles (TCP wraps, FS requests) are absent from the answer.
    if (member === "getActiveResourcesInfo") {
      if (call.arguments.length !== 0) {
        L.noLowering(`process.getActiveResourcesInfo with ${call.arguments.length} arguments`, call);
      }
      return { kind: "libCall", fn: "process.activeResources", args: [], type: arrayOf(STRING), loc };
    }
    // umask(2): the no-argument form reads without setting (the frontend
    // completes it to the -1 read sentinel); umask(mask) sets and answers
    // the previous mask, Node's shape either way.
    if (member === "umask") {
      if (call.arguments.length > 1) {
        L.noLowering(`process.umask with ${call.arguments.length} arguments`, call);
      }
      const mask: IrExpr =
        call.arguments.length === 1
          ? L.lowerExpr(call.arguments[0]!)
          : { kind: "numLit", value: -1, type: F64, loc };
      if (mask.type.kind !== "f64") {
        L.noLowering("process.umask of non-number masks", call.arguments[0]!);
      }
      return { kind: "libCall", fn: "process.umask", args: [mask], type: F64, loc };
    }
    // chdir(2) — throws Node's fs-shaped error on failure.
    if (member === "chdir") {
      if (call.arguments.length !== 1) {
        L.noLowering(`process.chdir with ${call.arguments.length} arguments`, call);
      }
      const dir = L.lowerExpr(call.arguments[0]!);
      if (dir.type.kind !== "string") {
        L.noLowering("process.chdir of non-string paths", call.arguments[0]!);
      }
      return { kind: "libCall", fn: "process.chdir", args: [dir], type: VOID, loc };
    }
    // getuid(2): POSIX-only target, so the call always answers a number —
    // the plain-f64 result is honest here even though @types/node declares
    // the member optional (that optionality covers Windows). The `?.()`
    // spelling routes here through lowerProcessOptionalMethodCall.
    if (member === "getuid" || member === "getgid") {
      if (call.arguments.length !== 0) {
        L.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
      }
      return { kind: "libCall", fn: member === "getuid" ? "process.getuid" : "process.getgid", args: [], type: F64, loc };
    }
    // process.kill(pid, signal?) — Node's semantics exactly: the signal is
    // a name string (the runtime resolves Node's signal table; unknown
    // names throw the ERR_UNKNOWN_SIGNAL TypeError), a number (0 probes),
    // or omitted (SIGTERM); a non-int32 pid throws Node's
    // ERR_INVALID_ARG_TYPE TypeError text, and kill(2) failures throw
    // Node's `kill ESRCH`/`kill EPERM` Error. The result is Node's
    // constant true.
    if (member === "kill") {
      if (call.arguments.length < 1 || call.arguments.length > 2) {
        L.noLowering(`process.kill with ${call.arguments.length} arguments`, call);
      }
      const pid = L.lowerExprExpecting(call.arguments[0]!, F64);
      const sigNode = call.arguments[1];
      if (!sigNode) {
        const dflt: IrExpr = { kind: "strLit", value: "SIGTERM", type: STRING, loc };
        return { kind: "libCall", fn: "process.kill", args: [pid, dflt], type: BOOL, loc };
      }
      const sig = L.lowerExpr(sigNode);
      if (sig.type.kind === "f64") {
        return { kind: "libCall", fn: "process.killNum", args: [pid, sig], type: BOOL, loc };
      }
      if (sig.type.kind === "string") {
        return { kind: "libCall", fn: "process.kill", args: [pid, sig], type: BOOL, loc };
      }
      L.noLowering(
        `process.kill with a '${L.fmt(sig.type)}' signal`,
        sigNode,
        "pass a signal name string or number (narrow unions first)",
      );
    }
    if (member === "exit") {
      const arg = call.arguments[0];
      const code: IrExpr =
        arg !== undefined
          ? L.lowerExprExpecting(arg, F64)
          : { kind: "numLit", value: 0, type: F64, loc };
      return { kind: "libCall", fn: "process.exit", args: [code], type: VOID, loc };
    }
    return null; // process.argv(...) etc. are tsc errors before lowering
  }

/** The lowered Number statics, by member name. The predicate quartet has
 * static C implementations (JS-exact: the ES2015 statics never coerce, so
 * only f64-typed arguments route through — anything else fences honestly
 * instead of folding to false past possible side effects). */
const NUMBER_STATIC_PREDICATES: Record<string, IrLibFn | undefined> = {
  isFinite: "number.isFinite",
  isNaN: "number.isNaN",
  isInteger: "number.isInteger",
  isSafeInteger: "number.isSafeInteger",
};

/** The Number constants, baked as literals — non-finite ones included
 * (numLits carry NaN and the infinities; both backends spell them). */
const NUMBER_CONSTANTS: Record<string, number | undefined> = {
  MAX_SAFE_INTEGER: 9007199254740991,
  MIN_SAFE_INTEGER: -9007199254740991,
  EPSILON: 2.220446049250313e-16,
  MAX_VALUE: 1.7976931348623157e308,
  MIN_VALUE: 5e-324,
  NaN: NaN,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
};

/** Method calls on THE `Number` global: the predicate statics lower to
   * plain C over f64 arguments; `Number.parseFloat`/`Number.parseInt` ARE
   * the global parsers (the spec aliases them), so they get the same
   * island lowering — engine execution under --dynamic, per-site SC2012
   * without it (parseInt takes an explicit radix, like the global). Null
   * for non-Number receivers. */
  export function lowerNumberStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    const member = L.stdlibGlobalMember(access, "Number");
    if (member === null) return null;
    const loc = locOf(call);
    const fn = own(NUMBER_STATIC_PREDICATES, member);
    if (fn !== undefined) {
      if (call.arguments.length !== 1) {
        L.noLowering(`Number.${member} with ${call.arguments.length} arguments`, call);
      }
      const argNode = call.arguments[0]!;
      const arg = L.lowerExpr(argNode);
      // An ISLAND ('any'-typed) argument evaluates the predicate in the
      // engine — the statics never coerce, so the engine's answer over the
      // real value is JS-exact where a static fence would refuse the
      // editorconfig `(value) => Number.isSafeInteger(value)` shape; the
      // boolean exits validated like every island boolean.
      if (arg.type.kind === "jsval") {
        L.requireDynamicApi(`'Number.${member}'`, call);
        const numberGlobal: IrExpr = { kind: "jsOp", op: "globalGet", name: "Number", args: [], type: JSVAL, loc };
        const raw: IrExpr = { kind: "jsOp", op: "callMethod", name: member, args: [numberGlobal, arg], type: JSVAL, loc };
        return { kind: "jsExit", value: raw, type: BOOL, loc };
      }
      if (arg.type.kind !== "f64") {
        L.noLowering(
          `Number.${member} of '${L.fmt(arg.type)}' values`,
          argNode,
          "the Number statics never coerce — a statically non-number argument is constantly false in JS (narrow unions first, or write the constant)",
        );
      }
      return { kind: "libCall", fn, args: [arg], type: BOOL, loc };
    }
    if (member === "parseFloat" || member === "parseInt") {
      const want = member === "parseFloat" ? 1 : 2;
      if (call.arguments.length !== want) {
        L.noLowering(
          `Number.${member} with ${call.arguments.length} argument${call.arguments.length === 1 ? "" : "s"}`,
          call,
          member === "parseInt" ? "pass an explicit radix: Number.parseInt(s, 10)" : undefined,
        );
      }
      L.requireDynamicApi(`'Number.${member}'`, call);
      const callee: IrExpr = { kind: "jsOp", op: "globalGet", name: member, args: [], type: JSVAL, loc };
      const args = call.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
      const result: IrExpr = { kind: "jsOp", op: "callFn", args: [callee, ...args], type: JSVAL, loc };
      return { kind: "jsExit", value: result, type: F64, loc };
    }
    return null; // other Number statics land on the member fence
  }

const DATE_GETTER_FNS: Readonly<Record<string, IrLibFn>> = {
  getFullYear: "date.getFullYear",
  getUTCFullYear: "date.getUTCFullYear",
  getMonth: "date.getMonth",
  getUTCMonth: "date.getUTCMonth",
  getDate: "date.getDate",
  getUTCDate: "date.getUTCDate",
  getDay: "date.getDay",
  getUTCDay: "date.getUTCDay",
  getHours: "date.getHours",
  getUTCHours: "date.getUTCHours",
  getMinutes: "date.getMinutes",
  getUTCMinutes: "date.getUTCMinutes",
  getSeconds: "date.getSeconds",
  getUTCSeconds: "date.getUTCSeconds",
  getMilliseconds: "date.getMilliseconds",
  getUTCMilliseconds: "date.getUTCMilliseconds",
  getTimezoneOffset: "date.getTimezoneOffset",
};

const DATE_METHOD_HINT =
  "getTime(), valueOf(), toISOString(), the local/UTC calendar getters, and getTimezoneOffset() are supported; Date setters and locale/string formatters have no lowering";

/** The Date slice: statics plus read-only Date values backed by one
   * TimeClip'd millisecond scalar. Construction lives in lowerNew;
   * identity and mutating methods remain fenced. */
  export function lowerDateCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    const loc = locOf(call);
    if (L.stdlibGlobalMember(access, "Date") === "now") {
      if (call.arguments.length !== 0) {
        L.noLowering(`Date.now with ${call.arguments.length} arguments`, call);
      }
      return { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
    }
    // Date.UTC(year[, month[, date[, hours[, minutes[, seconds[, ms]]]]]]):
    // a pure function of its numbers — the runtime's MakeDay/MakeTime/
    // TimeClip. Omitted trailing arguments complete with the spec's
    // defaults (month 0, date 1, time parts 0); tsc pins every present
    // argument to number, so the seven-f64 ABI is exact.
    if (L.stdlibGlobalMember(access, "Date") === "UTC") {
      if (call.arguments.length < 1 || call.arguments.length > 7 ||
          call.arguments.some((a) => ts.isSpreadElement(a))) {
        L.noLowering(`Date.UTC with ${call.arguments.length} arguments`, call);
      }
      const defaults = [0, 0, 1, 0, 0, 0, 0]; // year is always present (arity ≥ 1)
      const args: IrExpr[] = [];
      for (let i = 0; i < 7; i++) {
        const a = call.arguments[i];
        args.push(a !== undefined
          ? L.lowerExprExpecting(a, F64)
          : { kind: "numLit", value: defaults[i]!, type: F64, loc });
      }
      return { kind: "libCall", fn: "date.utc", args, type: F64, loc };
    }
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "date") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    if (call.arguments.length !== 0) {
      L.noLowering(`Date.prototype.${name} with arguments`, call, DATE_METHOD_HINT);
    }
    const receiver = L.lowerExpr(access.expression);
    if (receiver.type.kind !== "date") L.badType(access.expression, L.typeOf(access.expression));
    if (name === "getTime" || name === "valueOf") {
      return {
        kind: "libCall",
        fn: name === "getTime" ? "date.getTime" : "date.valueOf",
        args: [receiver],
        type: F64,
        loc,
      };
    }
    if (name === "toISOString") {
      return { kind: "libCall", fn: "date.toISOStringValue", args: [receiver], type: STRING, loc };
    }
    const fn = DATE_GETTER_FNS[name];
    if (fn !== undefined) {
      return { kind: "libCall", fn, args: [receiver], type: F64, loc };
    }
    L.noLowering(`Date.prototype.${name}`, call, DATE_METHOD_HINT, L.checker.getSymbolAtLocation(access.name));
  }

type TextCodecCtor = {
  cls: "TextDecoder" | "TextEncoder";
  ctor: ts.NewExpression;
};

/* WHATWG label registry → native decoder id. The first 27 ids stay in the
 * same order as scripts/gen-text-decoder-tables.mjs; the remaining ids match
 * scr_bytes.c's compact enum. ISO-8859-8-I shares ISO-8859-8's byte table,
 * and GBK/gb18030 share one decoder (their decoders are identical). */
const TEXT_DECODER_SINGLE_BYTE_NAMES = [
  "ibm866", "iso-8859-2", "iso-8859-3", "iso-8859-4", "iso-8859-5",
  "iso-8859-6", "iso-8859-7", "iso-8859-8", "iso-8859-10", "iso-8859-13",
  "iso-8859-14", "iso-8859-15", "iso-8859-16", "koi8-r", "koi8-u",
  "macintosh", "windows-874", "windows-1250", "windows-1251", "windows-1252",
  "windows-1253", "windows-1254", "windows-1255", "windows-1256", "windows-1257",
  "windows-1258", "x-mac-cyrillic",
] as const;

const TEXT_DECODER_UTF8_LABELS = new Set([
  "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8",
]);

const TEXT_DECODER_LEGACY_LABELS: Record<string, number | undefined> = (() => {
  const labels: Record<string, number> = Object.create(null) as Record<string, number>;
  const add = (encoding: number, names: readonly string[]): void => {
    for (const name of names) labels[name] = encoding;
  };
  const single = (name: typeof TEXT_DECODER_SINGLE_BYTE_NAMES[number], aliases: readonly string[]): void => {
    add(TEXT_DECODER_SINGLE_BYTE_NAMES.indexOf(name), aliases);
  };
  single("ibm866", ["866", "cp866", "csibm866", "ibm866"]);
  single("iso-8859-2", ["csisolatin2", "iso-8859-2", "iso-ir-101", "iso8859-2", "iso88592", "iso_8859-2", "iso_8859-2:1987", "l2", "latin2"]);
  single("iso-8859-3", ["csisolatin3", "iso-8859-3", "iso-ir-109", "iso8859-3", "iso88593", "iso_8859-3", "iso_8859-3:1988", "l3", "latin3"]);
  single("iso-8859-4", ["csisolatin4", "iso-8859-4", "iso-ir-110", "iso8859-4", "iso88594", "iso_8859-4", "iso_8859-4:1988", "l4", "latin4"]);
  single("iso-8859-5", ["csisolatincyrillic", "cyrillic", "iso-8859-5", "iso-ir-144", "iso8859-5", "iso88595", "iso_8859-5", "iso_8859-5:1988"]);
  single("iso-8859-6", ["arabic", "asmo-708", "csiso88596e", "csiso88596i", "csisolatinarabic", "ecma-114", "iso-8859-6", "iso-8859-6-e", "iso-8859-6-i", "iso-ir-127", "iso8859-6", "iso88596", "iso_8859-6", "iso_8859-6:1987"]);
  single("iso-8859-7", ["csisolatingreek", "ecma-118", "elot_928", "greek", "greek8", "iso-8859-7", "iso-ir-126", "iso8859-7", "iso88597", "iso_8859-7", "iso_8859-7:1987", "sun_eu_greek"]);
  single("iso-8859-8", ["csiso88598e", "csiso88598i", "csisolatinhebrew", "hebrew", "iso-8859-8", "iso-8859-8-e", "iso-8859-8-i", "iso-ir-138", "iso8859-8", "iso88598", "iso_8859-8", "iso_8859-8:1988", "logical", "visual"]);
  single("iso-8859-10", ["csisolatin6", "iso-8859-10", "iso-ir-157", "iso8859-10", "iso885910", "l6", "latin6"]);
  single("iso-8859-13", ["iso-8859-13", "iso8859-13", "iso885913"]);
  single("iso-8859-14", ["iso-8859-14", "iso8859-14", "iso885914"]);
  single("iso-8859-15", ["csisolatin9", "iso-8859-15", "iso8859-15", "iso885915", "iso_8859-15", "l9"]);
  single("iso-8859-16", ["iso-8859-16"]);
  single("koi8-r", ["cskoi8r", "koi", "koi8", "koi8-r", "koi8_r"]);
  single("koi8-u", ["koi8-ru", "koi8-u"]);
  single("macintosh", ["csmacintosh", "mac", "macintosh", "x-mac-roman"]);
  single("windows-874", ["dos-874", "iso-8859-11", "iso8859-11", "iso885911", "tis-620", "windows-874"]);
  single("windows-1250", ["cp1250", "windows-1250", "x-cp1250"]);
  single("windows-1251", ["cp1251", "windows-1251", "x-cp1251"]);
  single("windows-1252", ["ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252"]);
  single("windows-1253", ["cp1253", "windows-1253", "x-cp1253"]);
  single("windows-1254", ["cp1254", "csisolatin5", "iso-8859-9", "iso-ir-148", "iso8859-9", "iso88599", "iso_8859-9", "iso_8859-9:1989", "l5", "latin5", "windows-1254", "x-cp1254"]);
  single("windows-1255", ["cp1255", "windows-1255", "x-cp1255"]);
  single("windows-1256", ["cp1256", "windows-1256", "x-cp1256"]);
  single("windows-1257", ["cp1257", "windows-1257", "x-cp1257"]);
  single("windows-1258", ["cp1258", "windows-1258", "x-cp1258"]);
  single("x-mac-cyrillic", ["x-mac-cyrillic", "x-mac-ukrainian"]);

  add(27, ["x-user-defined"]);
  add(28, ["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"]);
  add(29, ["unicodefffe", "utf-16be"]);
  add(30, ["chinese", "csgb2312", "csiso58gb231280", "gb18030", "gb2312", "gb_2312", "gb_2312-80", "gbk", "iso-ir-58", "x-gbk"]);
  add(31, ["big5", "big5-hkscs", "cn-big5", "csbig5", "x-x-big5"]);
  add(32, ["cseucpkdfmtjapanese", "euc-jp", "x-euc-jp"]);
  add(33, ["csiso2022jp", "iso-2022-jp"]);
  add(34, ["csshiftjis", "ms932", "ms_kanji", "shift-jis", "shift_jis", "sjis", "windows-31j", "x-sjis"]);
  add(35, ["cseuckr", "csksc56011987", "euc-kr", "iso-ir-149", "korean", "ks_c_5601-1987", "ks_c_5601-1989", "ksc5601", "ksc_5601", "windows-949"]);
  return labels;
})();

type StaticTextDecoderEncoding = { kind: "utf8" } | { kind: "legacy"; id: number };

/** TextDecoder's get-an-encoding normalization: trim ASCII whitespace and
 * fold ASCII case only (Unicode case folding must not manufacture a label). */
function staticTextDecoderEncoding(label: string): StaticTextDecoderEncoding | null {
  const normalized = label
    .replace(/^[\u0009\u000a\u000c\u000d\u0020]+|[\u0009\u000a\u000c\u000d\u0020]+$/g, "")
    .replace(/[A-Z]/g, (char) => char.toLowerCase());
  if (TEXT_DECODER_UTF8_LABELS.has(normalized)) return { kind: "utf8" };
  const id = own(TEXT_DECODER_LEGACY_LABELS, normalized);
  return id === undefined ? null : { kind: "legacy", id };
}

/** A direct construction of THE stdlib TextEncoder/TextDecoder, through
   * type-only wrappers. Name alone is never enough: a user class with the
   * same spelling keeps the ordinary class lowering. */
  function directTextCodecCtorOf(L: Lowerer, expr: ts.Expression): TextCodecCtor | null {
    const ctor = stripTypeCasts(expr);
    if (!ts.isNewExpression(ctor)) return null;
    const callee = stripTypeCasts(ctor.expression);
    if (!ts.isIdentifier(callee)) return null;
    if (callee.text !== "TextDecoder" && callee.text !== "TextEncoder") return null;
    const sym = L.resolveValueSymbol(callee);
    if (!sym || !L.isStdlibSymbol(sym)) return null;
    if (sym.name !== "TextDecoder" && sym.name !== "TextEncoder") return null;
    return { cls: sym.name, ctor };
  }

/** True when construction itself is effect-free and inside the already
   * lowered codec slice, so a const binding can be erased and calls can
   * resolve back to the initializer. TextDecoder's explicit label must be
   * an actual recognized literal here: accepting an arbitrary expression
   * merely typed as a label would move or repeat its effects when the
   * binding is erased. */
  function erasableTextCodecCtor(info: TextCodecCtor): boolean {
    const args = info.ctor.arguments ?? [];
    if (info.cls === "TextEncoder") return args.length === 0;
    if (args.length === 0) return true;
    if (args.length !== 1) return false;
    const label = stripTypeCasts(args[0]!);
    return ts.isStringLiteralLike(label) && staticTextDecoderEncoding(label.text) !== null;
  }

/** `const encoder = new TextEncoder()` / a statically-labelled TextDecoder twin:
   * compile-time alias plumbing with no runtime object. Calls through the
   * stable binding are recognized by textCodecReceiverOf below; any other
   * reached value use keeps the ordinary SC2020 representation fence. Both
   * declaration walks call this and independently gate on constness. */
  export function textCodecBindingClassOf(
    L: Lowerer,
    nameNode: ts.Node,
    init: ts.Expression | undefined,
  ): TextCodecCtor["cls"] | null {
    if (!ts.isIdentifier(nameNode) || init === undefined) return null;
    const decl = nameNode.parent;
    if (
      !ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent) ||
      !ts.isVariableStatement(decl.parent.parent)
    ) {
      return null;
    }
    const info = directTextCodecCtorOf(L, init);
    return info !== null && erasableTextCodecCtor(info) ? info.cls : null;
  }

  export function textCodecBindingDecl(
    L: Lowerer,
    nameNode: ts.Node,
    init: ts.Expression | undefined,
  ): boolean {
    return textCodecBindingClassOf(L, nameNode, init) !== null;
  }

/** The inline composed receiver, or a const identifier whose initializer
   * is an erasable codec construction in the same execution scope and
   * after that declaration. Following the declaration instead of
   * materializing the value is honest for the supported slice: receiver
   * reads are pure, construction has no effects, and every non-call use
   * fences because there is deliberately no general value lowering. */
  function textCodecReceiverOf(L: Lowerer, expr: ts.Expression): TextCodecCtor | null {
    const direct = directTextCodecCtorOf(L, expr);
    if (direct !== null) return direct;
    const receiver = stripTypeCasts(expr);
    if (!ts.isIdentifier(receiver)) return null;
    const sym = L.resolveValueSymbol(receiver);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (
      !decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined ||
      !ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0 ||
      !textCodecBindingDecl(L, decl.name, decl.initializer)
    ) {
      return null;
    }
    // A closure can run before the const initializes (TDZ), and an
    // imported binding can be observed during a module cycle; both need
    // real runtime storage rather than this deliberately trivial rewrite.
    const executionScope = (node: ts.Node): ts.Node => {
      let child = node;
      for (let cur = node.parent; ; child = cur, cur = cur.parent) {
        if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return cur;
        // An instance field initializer runs when an object is constructed,
        // not when its enclosing class expression evaluates. Treat it like
        // a closure boundary: a later source position does not prove the
        // codec declaration ran (a switch can enter a following case and
        // instantiate the class while the binding is still in its TDZ).
        if (
          ts.isPropertyDeclaration(cur) && cur.initializer === child &&
          (ts.getCombinedModifierFlags(cur) & ts.ModifierFlags.Static) === 0
        ) {
          return cur;
        }
      }
    };
    if (executionScope(receiver) !== executionScope(decl) || receiver.getStart() < decl.end) return null;
    // All switch clauses share one lexical environment, but dispatch can
    // enter a later clause without executing a const in an earlier one.
    // TypeScript normally diagnoses the direct read; an @ts-expect-error
    // can deliberately retain the runtime TDZ shape, so source order alone
    // is not a sufficient proof. A codec declared in a clause is erasable
    // only for uses inside that exact clause's subtree (nested switches are
    // fine; closures and instance initializers already fail executionScope).
    const switchClauseOf = (node: ts.Node): ts.CaseOrDefaultClause | null => {
      for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
        if (ts.isCaseClause(cur) || ts.isDefaultClause(cur)) return cur;
        if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return null;
      }
      return null;
    };
    const declClause = switchClauseOf(decl);
    if (declClause !== null) {
      let insideDeclClause = false;
      for (let cur: ts.Node | undefined = receiver; cur !== undefined; cur = cur.parent) {
        if (cur === declClause) {
          insideDeclClause = true;
          break;
        }
      }
      if (!insideDeclClause) return null;
    }
    return directTextCodecCtorOf(L, decl.initializer);
  }

/** The WHATWG encoder pair, COMPOSED or through an erasable const binding:
   * `new TextDecoder().decode(bytes)`, `new TextEncoder().encode(s)`, and
   * the idiomatic store-then-call equivalents. The codec object never
   * exists (the crypto/Date precedent); bare construction and value uses
   * are fenced with the composed hint. decode is the runtime's WHATWG
   * decode for every recognized static label (with BOM handling for the
   * Unicode encodings); a zero-argument decode() is "" like the spec's.
   * encode IS Buffer.from(s, "utf8") — ScrStr
   * storage is well-formed UTF-8, so the bytes are identical (lone
   * surrogates became U+FFFD at string construction, exactly what the
   * spec's encoder emits). Null when this is neither supported form. */
  export function lowerTextCodecCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    const member = access.name.text;
    if (member !== "decode" && member !== "encode") return null;
    const info = textCodecReceiverOf(L, access.expression);
    if (info === null || !L.isStdlibMember(access)) return null;
    const { cls, ctor: recv } = info;
    if (!(cls === "TextDecoder" && member === "decode") && !(cls === "TextEncoder" && member === "encode")) {
      return null;
    }
    const loc = locOf(call);
    const ctorArgs = recv.arguments ?? [];
    if (cls === "TextDecoder") {
      // The label must be statically known. A literal-typed effectful inline
      // expression is accepted, but its evaluation is sequenced before the
      // decode below; stored decoder aliases admit only actual literals.
      const labelT = ctorArgs.length >= 1 ? L.typeOf(ctorArgs[0]!) : null;
      const encoding = ctorArgs.length === 0
        ? { kind: "utf8" } as const
        : labelT !== null && labelT.isStringLiteralType()
        ? staticTextDecoderEncoding(labelT.value)
        : null;
      if (ctorArgs.length > 1 || encoding === null) {
        L.noLowering(
          "new TextDecoder with runtime-valued options or an unknown label",
          recv,
          "a recognized literal WHATWG label with default options compiles",
        );
      }
      const labelEffect = ctorArgs.length === 1
        ? L.lowerExprExpecting(ctorArgs[0]!, STRING)
        : null;
      const afterLabel = (result: IrExpr): IrExpr =>
        labelEffect === null || labelEffect.kind === "strLit"
          ? result
          : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: labelEffect, loc: labelEffect.loc }],
            result,
            type: result.type,
            loc,
          };
      if (call.arguments.length === 0) {
        // decode() with no input is "" per spec — nothing to evaluate.
        return afterLabel({ kind: "strLit", value: "", type: STRING, loc });
      }
      if (call.arguments.length !== 1) {
        L.noLowering(
          "decode with a stream option",
          call,
          "streaming decode has no lowering — decode whole buffers",
        );
      }
      const argNode = call.arguments[0]!;
      const arg = L.lowerExpr(argNode);
      if (!(arg.type.kind === "bytes" && arg.type.elem === "u8")) {
        L.noLowering(
          `TextDecoder.decode of '${L.fmt(arg.type)}' values`,
          argNode,
          "Uint8Array/Buffer input decodes (ArrayBuffer values have no representation)",
        );
      }
      const decoded: IrExpr = encoding.kind === "utf8"
        ? { kind: "libCall", fn: "text.decode", args: [arg], type: STRING, loc }
        : {
          kind: "libCall",
          fn: "text.decodeLegacy",
          args: [arg, { kind: "numLit", value: encoding.id, type: F64, loc }],
          type: STRING,
          loc,
        };
      return afterLabel(decoded);
    }
    if (ctorArgs.length > 0) {
      L.noLowering("new TextEncoder with arguments", recv);
    }
    if (call.arguments.length !== 1) {
      L.noLowering(
        `TextEncoder.encode with ${call.arguments.length} arguments`,
        call,
        call.arguments.length === 0 ? "pass the string (a zero-argument encode is an empty Uint8Array)" : undefined,
      );
    }
    const s = L.lowerExprExpecting(call.arguments[0]!, STRING);
    const enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
    return { kind: "libCall", fn: "buffer.fromStr", args: [s, enc], type: BYTES_U8, loc };
  }

/** `String.fromCharCode(...codes)` on THE String global: every argument
   * lowers as a number and packs into ONE f64[] array-literal argument
   * (the path.join convention) — or ONE whole-array spread forwards the
   * array itself. Other String statics (fromCodePoint, raw) fall through
   * to the member fence. Null for non-String receivers. */
  export function lowerStringStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    const member = L.stdlibGlobalMember(access, "String");
    if (member !== "fromCharCode" && member !== "raw") return null;
    const loc = locOf(call);
    // String.raw(template, ...substitutions): the template's `raw` member
    // is a string[] read off any record that carries one (the lib's
    // parameter type — an object literal or a TemplateStringsArray-shaped
    // record); each substitution stringifies through the static ToString
    // (numbers/booleans/strings — the toString node; records print
    // "[object Object]" there like JS) and packs into ONE string[]
    // literal, the fromCharCode convention. The runtime interleaves per
    // the spec's loop.
    if (member === "raw") {
      if (call.arguments.length < 1 || call.arguments.some((a) => ts.isSpreadElement(a))) {
        L.noLowering(
          `String.raw with ${call.arguments.length === 0 ? "no template" : "spread substitutions"}`,
          call,
        );
      }
      const tmplNode = call.arguments[0]!;
      const tmpl = L.lowerExpr(tmplNode);
      const rawT = arrayOf(STRING);
      let raw: IrExpr | null = null;
      if (tmpl.type.kind === "record") {
        const shape = L.shapes.get(tmpl.type.shapeId);
        const rawField = shape?.fields.find((f) => f.name === "raw");
        if (rawField && typeEquals(rawField.type, rawT)) {
          raw = { kind: "recordGet", obj: tmpl, shapeId: tmpl.type.shapeId, field: "raw", type: rawT, loc };
        }
      }
      if (raw === null) {
        L.noLowering(
          "String.raw over this template shape",
          tmplNode,
          "the template must carry a string[] `raw` member: String.raw({ raw: [...] }, ...subs)",
        );
      }
      const subs = call.arguments.slice(1).map((a): IrExpr => {
        const v = L.lowerExpr(a);
        if (v.type.kind === "string") return v;
        if (v.type.kind === "f64" || v.type.kind === "bool" || v.type.kind === "record") {
          return { kind: "toString", operand: v, type: STRING, loc };
        }
        L.noLowering(
          `String.raw substitutions of type '${L.fmt(v.type)}'`,
          a,
          "numbers, strings, booleans, and records stringify statically",
        );
      });
      const packedSubs: IrExpr = { kind: "arrayLit", elems: subs, type: rawT, loc };
      return { kind: "libCall", fn: "string.raw", args: [raw, packedSubs], type: STRING, loc };
    }
    const spread = call.arguments.find(ts.isSpreadElement);
    if (spread) {
      if (call.arguments.length !== 1) {
        L.noLowering(
          "String.fromCharCode with a mixed spread call",
          call,
          "spread a whole array (String.fromCharCode(...codes)) or pass plain arguments",
        );
      }
      // A typed-array/Buffer spread (String.fromCharCode(...data.slice(4, 8))
      // — the magic-number ASCII probe) passes the bytes value through; the
      // runtime reads its elements like the packed-array form.
      const spreadT = L.mapTypeOf(L.typeOf(spread.expression));
      if (spreadT?.kind === "bytes") {
        const packed = L.lowerExpr(spread.expression);
        if (packed.type.kind !== "bytes") L.badType(spread.expression, L.typeOf(spread.expression));
        return { kind: "libCall", fn: "string.fromCharCode", args: [packed], type: STRING, loc };
      }
      const packed = L.lowerExprExpecting(spread.expression, arrayOf(F64));
      return { kind: "libCall", fn: "string.fromCharCode", args: [packed], type: STRING, loc };
    }
    const elems = call.arguments.map((a) => L.lowerExprExpecting(a, F64));
    const packed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(F64), loc };
    return { kind: "libCall", fn: "string.fromCharCode", args: [packed], type: STRING, loc };
  }

/** `s.lastIndexOf(needle)` on string receivers — a libCall (scr_lib.c)
   * rather than a strIntrinsic, but the same UTF-16 index semantics as
   * indexOf. The lib's fromIndex parameter has no lowering (Node clamps
   * it with ToIntegerOrInfinity; nothing in the corpus wants it) and
   * fences per site. Null for non-string receivers / other members. */
  export function lowerStringLastIndexOfCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "lastIndexOf") return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "string") return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    if (call.arguments.length !== 1) {
      L.noLowering(
        "lastIndexOf with a fromIndex argument",
        call,
        "the one-argument form lowers",
      );
    }
    const receiver = L.lowerExprExpecting(access.expression, STRING);
    const needle = L.lowerExprExpecting(call.arguments[0]!, STRING);
    return { kind: "libCall", fn: "string.lastIndexOf", args: [receiver, needle], type: F64, loc };
  }

/** `Promise.race([...])` on THE Promise global: the entries lower
   * individually (the array never materializes — promise-element arrays
   * have no representation) into a promise.race intrinsic; the result
   * type is the checker's combined promise, and each entry's inner type
   * must be that inner type, one of its union arms, or a sub-union of it
   * (the backend's interned adapters wrap/re-tag fulfillments; a wider
   * entry would need machinery that doesn't exist and fences).
   * Promise.all/allSettled/any fence with the sequential-await hint;
   * resolve/reject and the rest fall to the member fence. Null for
   * non-Promise receivers. */
  export function lowerPromiseStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    const member = L.stdlibGlobalMember(access, "Promise");
    if (member === null) return null;
    const loc = locOf(call);
    if (member === "race") {
      const argNode = call.arguments.length === 1 ? call.arguments[0]! : null;
      if (
        !argNode ||
        !ts.isArrayLiteralExpression(argNode) ||
        argNode.elements.some(ts.isSpreadElement) ||
        argNode.elements.length === 0
      ) {
        L.noLowering(
          "Promise.race over this argument shape",
          call,
          "a non-empty array LITERAL of promises is the supported form: Promise.race([p, q])",
        );
      }
      const resultT = L.mapTypeOf(L.typeOf(call));
      if (resultT?.kind !== "promise") {
        L.noLowering(
          "Promise.race with this combined result type",
          call,
          "the entries' value types must combine into a representable union",
        );
      }
      const resultArms =
        resultT.inner.kind === "union" ? (L.unions.get(resultT.inner.unionId)?.arms ?? []) : null;
      const compatible = (inner: IrType): boolean => {
        if (typeEquals(inner, resultT.inner)) return true;
        if (!resultArms) return false;
        if (inner.kind === "union") {
          const arms = L.unions.get(inner.unionId)?.arms ?? [];
          return arms.every((a) => resultArms.some((b) => typeEquals(a, b)));
        }
        return resultArms.some((a) => typeEquals(a, inner));
      };
      const entries = argNode.elements.map((el) => {
        const entry = L.lowerExpr(el);
        if (entry.type.kind !== "promise") {
          L.noLowering(
            "Promise.race over non-promise entries",
            el,
            "JS would resolve plain values — wrap them: new Promise((r) => r(v))",
          );
        }
        if (!compatible(entry.type.inner)) {
          L.unsupported(
            "SC1090",
            el,
            `Promise.race entries of inner type '${L.fmt(entry.type.inner)}' under a ` +
              `'${L.fmt(resultT.inner)}' result (every entry must be the result type, one ` +
              `of its arms, or a sub-union of it)`,
          );
        }
        return entry;
      });
      return { kind: "intrinsic", name: "promise.race", args: entries, type: resultT, loc };
    }
    // `Promise.all(ps)` over ONE promise type: the argument is any
    // expression of type Promise<T>[] (promise-element arrays are real —
    // `refs.map(loadAsync)`, an annotated literal) and the result is the
    // checker's Promise<T[]>. Node-exact through the runtime's countdown
    // combinator: the values array is filled per INPUT index regardless of
    // settlement order, the first rejection (in settlement order) wins and
    // later ones count as handled, the empty array resolves immediately,
    // and already-settled entries settle inline. Promise<void> entries
    // collapse to a `Promise<void>` result (a void[] value has no
    // representation; `await Promise.all(voids)` is the supported shape).
    // Heterogeneous ARRAY LITERALS land on the tuple overload
    // (Promise<[A, B]>) and fence here — one promise type is the bound.
    if (member === "all") {
      const argNode = call.arguments.length === 1 ? call.arguments[0]! : null;
      if (!argNode) {
        L.noLowering(
          "Promise.all with this argument shape",
          call,
          "one array of promises is the supported form: Promise.all(ps) with ps: Promise<T>[]",
        );
      }
      // A UNIFORM array literal — `Promise.all([readFile(a), readFile(b)])`
      // where every entry is the SAME Promise<T> (the portless
      // generateHostCertAsync pair): the checker's tuple overload types
      // the literal as [Promise<T>, Promise<T>], but with one shared T
      // the tuple IS an array — the entries lower into a Promise<T>[]
      // and the result is Promise<T[]> (destructuring reads it exactly
      // like the tuple; the elements are the same T either way).
      if (
        ts.isArrayLiteralExpression(argNode) &&
        !argNode.elements.some(ts.isSpreadElement) &&
        argNode.elements.length > 0
      ) {
        const elems = argNode.elements.map((el) => L.lowerExpr(el));
        const first = elems[0]!.type;
        if (
          first.kind === "promise" &&
          elems.every((e) => e.type.kind === "promise" && typeEquals(e.type, first))
        ) {
          const entriesArr: IrExpr = { kind: "arrayLit", elems, type: arrayOf(first), loc };
          const resultT: IrType = {
            kind: "promise",
            inner: first.inner.kind === "void" ? VOID : arrayOf(first.inner),
          };
          return { kind: "intrinsic", name: "promise.all", args: [entriesArr], type: resultT, loc };
        }
        // MIXED entries where some entry is already an ISLAND value (the
        // withPlugins shape: Promise.all([loadBuiltinPlugins(),
        // loadPlugins(plugins)]) with an 'any'-typed loader): the
        // ENGINE's own Promise.all runs — island entries pass through,
        // STATIC promises cross as real engine thenables (the reverse
        // bridge, payload-domain gated), plain values marshal per the
        // boundary — and the combined result stays an island value
        // (awaiting it rides the island→static promise bridge; element
        // reads are the routed keyed ops). All-static tuples keep the
        // typed fence hint below. --dynamic only by construction: jsval
        // entries exist only there.
        if (elems.some((e) => e.type.kind === "jsval")) {
          const diagsBefore = L.diags.length;
          try {
            const marshaled = argNode.elements.map((el, i) => L.jsvalIn(elems[i]!, el));
            return {
              kind: "jsOp",
              op: "callMethod",
              name: "all",
              args: [
                { kind: "jsOp", op: "globalGet", name: "Promise", args: [], type: JSVAL, loc },
                { kind: "jsOp", op: "arrLit", args: marshaled, type: JSVAL, loc },
              ],
              type: JSVAL,
              loc,
            };
          } catch (err) {
            // An entry outside every crossing domain: drop the boundary
            // diagnostics and let the shape fence below name the fix.
            if (!(err instanceof PoisonError)) throw err;
            L.diags.splice(diagsBefore);
          }
        }
        L.noLowering(
          "Promise.all over this argument shape",
          argNode,
          "the entries must share ONE promise type — Promise.all([p, q]) lowers when p and q are the same Promise<T>",
        );
      }
      const entries = L.lowerExpr(argNode);
      // A NON-literal island argument (`Promise.all(plugins.map((p) =>
      // loadPlugin(p)))` — the loadPlugins shape, where the checker
      // spells `any[]`): the ENGINE's own Promise.all runs over the
      // marshaled array (an 'any' value passes through; an `any[]` value
      // lifts per element by reference), the result staying an island
      // value the static side awaits through the island→static bridge.
      if (
        entries.type.kind === "jsval" ||
        (entries.type.kind === "array" && entries.type.elem.kind === "jsval")
      ) {
        const diagsBefore = L.diags.length;
        try {
          const arg = L.jsvalIn(entries, argNode);
          return {
            kind: "jsOp",
            op: "callMethod",
            name: "all",
            args: [{ kind: "jsOp", op: "globalGet", name: "Promise", args: [], type: JSVAL, loc }, arg],
            type: JSVAL,
            loc,
          };
        } catch (err) {
          if (!(err instanceof PoisonError)) throw err;
          L.diags.splice(diagsBefore);
        }
      }
      if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
        // The heterogeneous-literal case: the checker's tuple overload
        // types the literal as a TUPLE of promises (a tuple-flagged record
        // here), or a union-of-promises element survives as the array's
        // elem — either way the fix is one shared promise type, so say
        // that.
        const tupleFields =
          entries.type.kind === "record" ? L.shapes.get(entries.type.shapeId) : undefined;
        const mixedPromises =
          (entries.type.kind === "array" &&
            entries.type.elem.kind === "union" &&
            (L.unions.get(entries.type.elem.unionId)?.arms ?? []).every(
              (a) => a.kind === "promise",
            )) ||
          (tupleFields?.tuple === true &&
            tupleFields.fields.every((f) => f.type.kind === "promise"));
        L.noLowering(
          "Promise.all over this argument shape",
          argNode,
          mixedPromises
            ? "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...]) " +
              "so the result is Promise<T[]>, not a tuple"
            : "an array of promises (Promise<T>[]) is the supported form",
        );
      }
      const inner = entries.type.elem.inner;
      const resultT: IrType | null =
        inner.kind === "void"
          ? { kind: "promise", inner: VOID }
          : L.mapTypeOf(L.typeOf(call));
      if (
        resultT?.kind !== "promise" ||
        (inner.kind !== "void" &&
          (resultT.inner.kind !== "array" || !typeEquals(resultT.inner.elem, inner)))
      ) {
        L.noLowering(
          "Promise.all with this combined result type",
          call,
          "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...]) " +
            "so the result is Promise<T[]>, not a tuple",
        );
      }
      return { kind: "intrinsic", name: "promise.all", args: [entries], type: resultT, loc };
    }
    if (member === "allSettled" || member === "any") {
      L.noLowering(
        `Promise.${member}`,
        call,
        "await each element in a loop (Promise.all compiles over a Promise<T>[] array, " +
          "Promise.race over an array literal)",
      );
    }
    // Promise.withResolvers<T>(): the executor pieces without an
    // executor — a pending promise plus its runtime resolve/reject
    // closures in the `{ promise, resolve, reject }` record. The
    // overrides declaration shapes the record so its fields map exactly
    // (plain-value resolve, Error-pinned reject); the emitter assembles
    // the record from the newPromise machinery.
    if (member === "withResolvers") {
      if (call.arguments.length !== 0) {
        L.noLowering(`Promise.withResolvers with arguments`, call);
      }
      // The type mapper owns the record shape (its withResolvers
      // special-case — the anonymous ambient literal fails the record
      // provenance gate, so the mapper interns the shape manually).
      const resultT = L.mapTypeOf(L.typeOf(call));
      if (resultT?.kind !== "record") {
        L.noLowering(
          "Promise.withResolvers at this type",
          call,
          "the promised value's type must be representable — annotate it: Promise.withResolvers<T>()",
        );
      }
      return { kind: "promiseWithResolvers", type: resultT, loc };
    }
    // Promise.try(f) — call f SYNCHRONOUSLY, fulfill with its plain
    // result, adopt a returned promise, and turn a synchronous throw
    // into a rejection. That is observably `(async () => f())()` —
    // tick-for-tick in Node for plain results (probed), with the
    // promise-returning form riding the async return-adoption machinery
    // (its one-tick residue is SEMANTICS.md 358) — so the lowering IS
    // that wrapper: one interned async helper per callback type. The
    // ...args form fences (close over the values instead).
    if (member === "try") {
      const fNode = call.arguments[0];
      if (call.arguments.length !== 1 || fNode === undefined || ts.isSpreadElement(fNode)) {
        L.noLowering(
          `Promise.try with ${call.arguments.length} arguments`,
          call,
          "the ...args form has no lowering — close over the values: Promise.try(() => f(a, b))",
        );
      }
      const f = L.lowerExpr(fNode);
      if (f.type.kind !== "func" || f.type.params.length !== 0) {
        L.noLowering(
          `Promise.try over a callback of type '${L.checker.typeToString(L.typeOf(fNode))}'`,
          fNode,
          "a zero-parameter function is the supported form",
        );
      }
      const resultT = L.mapTypeOf(L.typeOf(call));
      if (resultT?.kind !== "promise") {
        L.noLowering(
          "Promise.try at this type",
          call,
          "the promised value's type must be representable — annotate it: Promise.try<T>(f)",
        );
      }
      const inner = resultT.inner;
      const ret = f.type.ret;
      // The helper's return must BE the callback's result (fulfillment)
      // or its adopted settlement (promise results) — anything the
      // checker widened past that has no adapter here.
      const settled = ret.kind === "promise" ? ret.inner : ret;
      if (!typeEquals(settled, inner) && !(isUnitType(settled) && inner.kind === "void") && !(settled.kind === "void" && inner.kind === "void")) {
        L.noLowering(
          "Promise.try where the callback's result type differs from the promised type",
          call,
          "annotate both to one T: Promise.try<T>(f) with f returning T or Promise<T>",
        );
      }
      const key = `promise.try:${typeKey(f.type)}`;
      let helper = L.arrHofHelpers.get(key);
      if (!helper) {
        helper = `%promise.try.${L.arrHofHelpers.size}`;
        L.arrHofHelpers.set(key, helper);
        const fRef: IrExpr = { kind: "varRef", localId: "f.0", type: f.type, loc };
        const callF: IrExpr = { kind: "callValue", callee: fRef, args: [], type: ret, loc };
        const body: IrStmt[] = [];
        if (inner.kind === "void") {
          // Void settlements: evaluate (awaiting a promise result) and
          // complete — the async machinery fulfills the void promise.
          const effect: IrExpr =
            ret.kind === "promise" ? { kind: "awaitExpr", value: callF, type: ret.inner, loc } : callF;
          body.push({ kind: "exprStmt", expr: effect, loc });
          body.push({ kind: "return", value: null, loc });
        } else {
          // lowerReturnValue's async rule, mirrored: a promise result
          // awaits (adoption), a plain result returns directly.
          const value: IrExpr =
            ret.kind === "promise" ? { kind: "awaitExpr", value: callF, type: ret.inner, loc } : callF;
          body.push({ kind: "return", value, loc });
        }
        const lifted: IrFunction = {
          name: helper,
          params: [{ localId: "f.0", name: "f", type: f.type }],
          returnType: inner,
          locals: [{ id: "f.0", name: "f", type: f.type, mutable: true }],
          body,
          loc,
          async: true,
        };
        L.liftedFns.push(lifted);
      }
      return { kind: "call", callee: helper, args: [f], type: resultT, loc };
    }
    // Promise.resolve — the already-settled promise. Zero arguments is
    // Promise<void>; a PROMISE argument is returned as-is (the spec's
    // native-promise identity — every scriptc promise is native, so
    // Promise.resolve(p) === p exactly); a plain representable value
    // fulfills a fresh promise immediately. Thenables (a `then`-carrying
    // object would be ADOPTED in JS, not wrapped) and promise-armed
    // unions (wrap-or-identity depends on the runtime arm) fence.
    if (member === "resolve") {
      if (call.arguments.length > 1 || call.arguments.some((a) => ts.isSpreadElement(a))) {
        L.noLowering(`Promise.resolve with ${call.arguments.length} arguments`, call);
      }
      const argNode = call.arguments[0];
      if (argNode !== undefined) {
        const argT = L.typeOf(argNode);
        const argIr = L.mapTypeOf(argT);
        if (argIr?.kind === "promise") {
          const v = L.lowerExpr(argNode);
          if (v.type.kind !== "promise") L.badType(argNode, argT);
          return v;
        }
        if (argIr?.kind === "union" &&
            (L.unions.get(argIr.unionId)?.arms ?? []).some((a) => a.kind === "promise")) {
          L.noLowering(
            "Promise.resolve over a value that may already be a promise",
            argNode,
            "narrow first: a plain value wraps, a promise passes through identically — the union hides which",
          );
        }
        if (argIr?.kind === "record" || argIr?.kind === "object") {
          const thenSym = L.checker.getPropertyOfType(argT, "then");
          if (thenSym !== undefined) {
            L.noLowering(
              "Promise.resolve of a thenable",
              argNode,
              "JS would ADOPT the then method, not wrap the object — await the thenable's settlement explicitly",
            );
          }
        }
      }
      const resultT = L.mapTypeOf(L.typeOf(call));
      if (resultT?.kind !== "promise") {
        L.noLowering(
          "Promise.resolve at this type",
          call,
          "the promised value's type must be representable — annotate it: Promise.resolve<T>(v)",
        );
      }
      if (argNode === undefined) {
        return { kind: "intrinsic", name: "promise.resolve", args: [], type: { kind: "promise", inner: VOID }, loc };
      }
      if (resultT.inner.kind === "void") {
        // Promise.resolve(expr) at a void-promise type: the argument's
        // effects must still run — no statement slot exists here for
        // them, so only effect-free spellings could drop it honestly;
        // fence rather than model that corner.
        L.noLowering("Promise.resolve with an argument at a void-promise type", call);
      }
      if (isUnitType(resultT.inner)) {
        // A unit payload (Promise<undefined>/Promise<null>) has no
        // fulfill adapter — await it as the void promise instead.
        L.noLowering("Promise.resolve at a unit-typed promise", call);
      }
      const value = L.lowerExprExpecting(argNode, resultT.inner);
      return { kind: "intrinsic", name: "promise.resolve", args: [value], type: resultT, loc };
    }
    return null; // reject lands on lowerPromiseRejectCall / the member fence
  }

/** Property READS on THE `Number` global: the finite constants bake as
   * number literals. NaN/POSITIVE_INFINITY/NEGATIVE_INFINITY and method
   * members as values fall through to the member fence. Null for
   * non-Number receivers. */
  export function lowerNumberStaticProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    const member = L.stdlibGlobalMember(expr, "Number");
    if (member === null) return null;
    const value = own(NUMBER_CONSTANTS, member);
    if (value === undefined) return null;
    return { kind: "numLit", value, type: F64, loc: locOf(expr) };
  }

/** True when `node`'s checker type is the timer `Timeout` handle (the
   * fallback's `Timeout` or @types/node's `NodeJS.Timeout`) — provenance,
   * not name, so a user's own `Timeout` never matches. The handle maps to
   * f64, so the method calls below can't tell it from a plain number by IR
   * type alone; this is the discriminator. */
  function isTimerHandleTyped(L: Lowerer, node: ts.Expression, name: "Timeout" | "Immediate"): boolean {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (sym?.name !== name) return false;
    return L.checker.declarationsOf(sym).some(
      (d) => ts.isInterfaceDeclaration(d) && L.isStdlibFile(d.getSourceFile()),
    );
  }
  function isTimeoutTyped(L: Lowerer, node: ts.Expression): boolean {
    return isTimerHandleTyped(L, node, "Timeout");
  }

/** `t.unref()` / `t.ref()` / `t.hasRef()` on a Timeout handle — loop-
   * liveness bookkeeping over the numeric timer id (the handle is f64).
   * unref/ref return the handle for chaining (Node); hasRef returns a
   * bool. `refresh` and the rest of @types/node's Timeout surface fence.
   * Null when the receiver isn't a Timeout handle. */
  export function lowerTimeoutMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    // `t.unref?.()` (the defensive optional CALL — mdns's timer.unref?.())
    // is the plain call: the method always exists on a Timeout handle. A
    // `t?.unref()` receiver guard is real narrowing and stays with the
    // chain machinery.
    if (access.questionDotToken) return null;
    const isTimeout = isTimeoutTyped(L, access.expression);
    const isImmediate = !isTimeout && isTimerHandleTyped(L, access.expression, "Immediate");
    if (!isTimeout && !isImmediate) return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if ((name === "unref" || name === "ref") && call.arguments.length === 0) {
      const handle = L.lowerExprExpecting(access.expression, F64);
      const fn = isImmediate
        ? name === "unref" ? "timers.immediateUnref" : "timers.immediateRef"
        : name === "unref" ? "timers.unref" : "timers.ref";
      // Returns the handle for chaining (`setTimeout(...).unref()` — Node
      // returns the Timeout/Immediate); the libCall yields the f64 back.
      return { kind: "libCall", fn, args: [handle], type: F64, loc };
    }
    if (name === "hasRef" && call.arguments.length === 0) {
      const handle = L.lowerExprExpecting(access.expression, F64);
      const fn = isImmediate ? "timers.immediateHasRef" : "timers.hasRef";
      return { kind: "libCall", fn, args: [handle], type: BOOL, loc };
    }
    if (name === "refresh" && call.arguments.length === 0 && !isImmediate) {
      // Re-arms to now + the original delay; yields the handle back for
      // chaining, like unref/ref.
      const handle = L.lowerExprExpecting(access.expression, F64);
      return { kind: "libCall", fn: "timers.refresh", args: [handle], type: F64, loc };
    }
    L.noLowering(
      `${isImmediate ? "Immediate" : "Timeout"}.${name}`,
      call,
      isImmediate
        ? "unref(), ref(), and hasRef() are the supported Immediate methods"
        : "unref(), ref(), hasRef(), and refresh() are the supported Timeout methods",
      L.checker.getSymbolAtLocation(access.name),
    );
  }

/** `process.getuid?.()` — the optional call of an optional process
   * method. On a POSIX target the member always exists, so the `?.` IS the
   * call (the checker's undefined arm covers Windows, which scriptc does
   * not target) and the honest result is the plain number. Intercepted
   * BEFORE the optional-chain machinery: `process.getuid` has no value
   * lowering for the chain to guard. Null when this isn't that shape. */
  export function lowerProcessOptionalMethodCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
    if (!expr.questionDotToken) return null;
    if (!ts.isPropertyAccessExpression(expr.expression)) return null;
    const member = L.stdlibGlobalMember(expr.expression, "process");
    if (member !== "getuid" && member !== "getgid") return null;
    if (expr.arguments.length !== 0) {
      L.noLowering(`process.${member} with ${expr.arguments.length} arguments`, expr);
    }
    return { kind: "libCall", fn: member === "getuid" ? "process.getuid" : "process.getgid", args: [], type: F64, loc: locOf(expr) };
  }

/** The interned `%env.snapshot` helper behind `process.env` as a VALUE: a
   * fresh `{ [k: string]: string | undefined }` record built over environ —
   * envPairs hands the [k0, v0, k1, v1, ...] strings in environ order and
   * the helper keyed-writes each pair into the record's overflow map (JS
   * own-key order follows insertion, exactly Node's Object.keys order over
   * process.env). The target shape must be a pure index-signature record
   * whose value slot is the `string | undefined` union (what ProcessEnv
   * maps to); anything else answers null and the caller keeps its fence. */
  export function envSnapshotHelper(L: Lowerer, shapeId: string, loc: SrcLoc): string | null {
    const shape = L.shapes.get(shapeId);
    if (!shape || shape.tuple || shape.fields.length > 0 || !shape.indexValue) return null;
    const iv = shape.indexValue;
    if (!typeEquals(iv, L.envValueType())) return null;
    if (iv.kind !== "union") return null;
    const strTag = L.armTag(iv.unionId, STRING);
    if (strTag < 0) return null;
    const key = `env.snapshot:${shapeId}`;
    const existing = L.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%env.snapshot.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const recT: IrType = { kind: "record", shapeId };
    const pairsT = arrayOf(STRING);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const pairAt = (offset: number): IrExpr => ({
      kind: "arrayGet",
      arr: ref("ps.0", pairsT),
      index:
        offset === 0
          ? ref("i.0", F64)
          : { kind: "bin", op: "+", left: ref("i.0", F64), right: num(offset), type: F64, loc },
      type: STRING,
      loc,
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "ps.0",
        init: { kind: "libCall", fn: "process.envPairs", args: [], type: pairsT, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "recordLit", fields: [], type: recT, loc },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: ref("i.0", F64),
          right: { kind: "arrIntrinsic", method: "length", receiver: ref("ps.0", pairsT), args: [], type: F64, loc },
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(2), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "recordKeySet",
            obj: ref("out.0", recT),
            shapeId,
            key: pairAt(0),
            value: { kind: "unionWrap", unionId: iv.unionId, tag: strTag, value: pairAt(1), type: iv, loc },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("out.0", recT), loc },
    ];
    L.liftedFns.push({
      name,
      params: [],
      returnType: recT,
      locals: [
        { id: "ps.0", name: "ps", type: pairsT, mutable: false },
        { id: "out.0", name: "out", type: recT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    });
    return name;
  }

export function isConsoleLog(L: Lowerer, call: ts.CallExpression): boolean {
    return consoleCallMember(L, call) === "log";
  }

/** The console member of a `console.<member>(...)` call, for the lowered
   * set: "log"/"info"/"debug" (stdout — Node's info and debug ARE log
   * under other names), and "error"/"warn" (both stderr — Node's warn IS
   * error under another name; the output is identical). Provenance-checked
   * like every stdlib global. Null for anything else (console.table, a
   * user's own console binding, ...). */
  export function consoleCallMember(
    L: Lowerer,
    call: ts.CallExpression,
  ): "log" | "info" | "debug" | "error" | "warn" | null {
    if (!ts.isPropertyAccessExpression(call.expression)) return null;
    const access = call.expression;
    if (access.questionDotToken || call.questionDotToken) return null;
    const name = access.name.text;
    if (name !== "log" && name !== "info" && name !== "debug" && name !== "error" && name !== "warn") return null;
    return L.isStdlibGlobal(access.expression, "console") ? name : null;
  }
