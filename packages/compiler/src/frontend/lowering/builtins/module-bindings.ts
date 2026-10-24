import { builtinModules } from "node:module";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import {
  canonicalBuiltinModule,
  isCreateRequireBinding7,
  npmStaticDepSf7,
  requireSpecOf,
  resolveImport,
} from "../../program.js";
import { stripTypeCasts } from "./arguments.js";

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
export function builtinImportOf(
  lowerer: Lowerer,
  ident: ts.Identifier,
): { module: string; member: string } | null {
  const binding = builtinModuleBindingOf(lowerer, ident);
  // node:stream/web's exports ARE the web stream globals: its bindings
  // lower through the globals' own paths (stdlibGlobalNameOf resolves the
  // alias to the same name), not through module-member tables.
  return binding?.module === "stream/web" ? null : binding;
}

function builtinModuleBindingOf(
  lowerer: Lowerer,
  ident: ts.Identifier,
): { module: string; member: string } | null {
  const symbol =
    ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident
      ? lowerer.checker.getShorthandAssignmentValueSymbol(ident.parent)
      : lowerer.checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (!decl) return null;
  // The CommonJS twin of the named import: a destructured require
  // binding (`const { readFileSync } = require("fs")`, renames via
  // `{ readFileSync: rf }`) keys the same tables.
  if (ts.isBindingElement(decl) && decl.name !== undefined && ts.isIdentifier(decl.name)) {
    // A NESTED pattern names a member of a sub-module (`const { types: {
    // isPromise } } = require("util")`): util.types IS the util/types
    // module object, so each level composes the module name.
    const path: string[] = [];
    let pattern: ts.Node | undefined = decl.parent;
    let varDecl = pattern?.parent;
    while (
      pattern !== undefined &&
      ts.isObjectBindingPattern(pattern) &&
      varDecl !== undefined &&
      ts.isBindingElement(varDecl)
    ) {
      const key = varDecl.propertyName;
      if (varDecl.initializer !== undefined || key === undefined || !ts.isIdentifier(key)) {
        return null;
      }
      path.unshift(key.text);
      pattern = varDecl.parent;
      varDecl = pattern?.parent;
    }
    if (
      pattern !== undefined &&
      ts.isObjectBindingPattern(pattern) &&
      varDecl !== undefined &&
      ts.isVariableDeclaration(varDecl) &&
      varDecl.initializer !== undefined
    ) {
      const spec = requireSpecOf(varDecl.initializer);
      let module =
        spec !== null
          ? canonicalBuiltinModule(spec)
          : path.length > 0
            ? null
            : // The one-hop alias twin: `const crypto = require('crypto');
              // const { createSign } = crypto;` — test/common's idiom. The
              // destructure re-binds module members under local names, so the
              // bindings key the same tables as the direct-require form.
              builtinNamespaceDestructureModuleOf(lowerer, varDecl);
      for (const key of path) {
        if (module === null) break;
        module = canonicalBuiltinModule(`${module}/${key}`);
      }
      if (module === null) return null;
      const member =
        decl.propertyName && ts.isIdentifier(decl.propertyName)
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
    const importDecl = decl.parent?.parent?.parent;
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
    const target = lowerer.checker.getAliasedSymbol(symbol);
    const tdecl = target.declarations[0];
    if (tdecl !== undefined && ts.getSourceFileOfNode(tdecl).isDeclarationFile) {
      for (
        let p: ts.Node | undefined = tdecl.parent;
        p !== undefined && !ts.isSourceFile(p);
        p = p.parent
      ) {
        if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name)) {
          const module = canonicalBuiltinModule(p.name.text);
          if (module !== null) return { module, member: ts.symbolName(target) };
          break;
        }
      }
    }
  }
  return null;
}

/** The ES module binding kind of `ident`: "namespace" for a namespace
 * import (`import * as events from "node:events"`), "named" for a named
 * import (`import { defaultMaxListeners } from "node:events"`, also through
 * a re-exporting module), null otherwise. Namespace members and named
 * imports of a builtin read its ES module namespace, which holds copies of
 * the module's exports (module.syncBuiltinESMExports refreshes them), where
 * default imports and CommonJS bindings read the module object itself. */
export function esmImportBindingKind(
  lowerer: Lowerer,
  ident: ts.Identifier,
): "namespace" | "named" | null {
  const symbol = lowerer.checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined) return null;
  if (ts.isNamespaceImport(decl)) return "namespace";
  return ts.isImportSpecifier(decl) ? "named" : null;
}

/** True for `const <name> = require("<builtin>").<member>` — the
 * member-binding require import builtinImportOf resolves. Both
 * declaration walks (lowerVarDecl, collectGlobals) skip these: like a
 * named import, the binding is alias plumbing with no storage — call
 * sites lower through the module tables, value uses fence per site. */
export function builtinMemberRequireDecl(
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
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
export function builtinNamespaceDestructureModuleOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): string | null {
  if (
    decl.name === undefined ||
    !ts.isObjectBindingPattern(decl.name) ||
    decl.initializer === undefined
  )
    return null;
  // `const { join } = require("node:path")` through a createRequire
  // binding: the call IS the namespace — same table keying.
  let module: string | null = null;
  const init = stripTypeCasts(decl.initializer);
  if (ts.isCallExpression(init)) {
    const cr = createRequireSpecOf(lowerer, init);
    module = cr !== null && cr.spec !== null ? canonicalBuiltinModule(cr.spec) : null;
  } else if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
    // `const { open } = fs.promises` / `= require("fs").promises`: a member
    // that is itself a supported module.
    module = lowerer.builtinNamespaceModuleOf(init);
  }
  if (module === null) return null;
  for (const el of decl.name.elements.nodes) {
    if (
      el.dotDotDotToken ||
      el.initializer !== undefined ||
      el.name === undefined ||
      !ts.isIdentifier(el.name)
    )
      return null;
    if (el.propertyName !== undefined && !ts.isIdentifier(el.propertyName)) return null;
  }
  return module;
}

/** The `createRequire(<base>)` call over the node:module import binding
 * with a supported base — import.meta.url, import.meta.filename, or
 * __filename, every spelling of "this file" — or null. The base never
 * LOWERS (import.meta has no value representation): it only names the
 * file whose directory anchors the returned require's relative
 * resolution, and every supported spelling names the call's own file. */
function createRequireBaseCallOf(lowerer: Lowerer, expr: ts.Expression): ts.CallExpression | null {
  const e = stripTypeCasts(expr);
  if (!ts.isCallExpression(e) || e.questionDotToken) return null;
  if (!ts.isIdentifier(e.expression)) return null;
  const bi = builtinImportOf(lowerer, e.expression);
  if (!bi || bi.module !== "module" || bi.member !== "createRequire") return null;
  if (e.arguments.nodes.length !== 1) return null;
  const base = stripTypeCasts(e.arguments.nodes[0]!);
  if (ts.isIdentifier(base) && lowerer.isStdlibGlobal(base, "__filename")) return e;
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
 * this test. Top-level let/var bindings also qualify when preflight's
 * shared proof rules out writes, escapes, and use before initialization. */
export function createRequireBindingDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (
    !ts.isIdentifier(nameNode) ||
    init === undefined ||
    createRequireBaseCallOf(lowerer, init) === null
  )
    return false;
  // Preserve const loaders acquired through CommonJS member/destructure
  // aliases, which builtinImportOf also recognizes. Mutable syntax uses
  // preflight's narrower import provenance and whole-file stability proof.
  const decl = nameNode.parent;
  if (
    ts.isVariableDeclaration(decl) &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  )
    return true;
  return isCreateRequireBinding7(lowerer.program, nameNode);
}

/** The declaring source file when `callee` denotes a createRequire-made
 * require: a stable binding over createRequire(import.meta.url) (the
 * binding's own file anchors resolution) or the inline
 * `createRequire(import.meta.url)(...)` spelling (the call's file).
 * Null off the pattern, so call chains keep trying. */
export function createRequireCalleeFileOf(
  lowerer: Lowerer,
  callee: ts.Expression,
): ts.SourceFile | null {
  const e = stripTypeCasts(callee);
  if (ts.isCallExpression(e)) {
    return createRequireBaseCallOf(lowerer, e) !== null ? ts.getSourceFileOfNode(e) : null;
  }
  if (!ts.isIdentifier(e)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(e);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
  return createRequireBindingDecl(lowerer, decl.name, decl.initializer)
    ? ts.getSourceFileOfNode(decl)
    : null;
}

/** The static require of `R("spec")` through a createRequire binding:
 * the literal specifier plus the file anchoring relative resolution.
 * Null when the callee is not a createRequire-made require; a matching
 * callee with a non-literal (or missing) specifier answers spec null,
 * so the call lowering fences by name instead of falling through to
 * the generic call paths. */
export function createRequireSpecOf(
  lowerer: Lowerer,
  call: ts.CallExpression,
): { spec: string | null; baseFile: ts.SourceFile } | null {
  if (call.questionDotToken) return null;
  const baseFile = createRequireCalleeFileOf(lowerer, call.expression);
  if (baseFile === null) return null;
  if (call.arguments.nodes.length !== 1) return { spec: null, baseFile };
  const a = call.arguments.nodes[0]!;
  return { spec: ts.isStringLiteralLike(a) ? a.text : null, baseFile };
}

/** node:ffi is a checked native module value, so its require binding needs
 * storage even when the createRequire loader is named `require`. */
export function isNativeFfiRequire(lowerer: Lowerer, expr: ts.Expression | undefined): boolean {
  if (expr === undefined) return false;
  const call = stripTypeCasts(expr);
  return ts.isCallExpression(call) && createRequireSpecOf(lowerer, call)?.spec === "node:ffi";
}

/** True for `const fs = require("node:fs")` through a createRequire
 * binding — a builtin namespace import in const clothing: alias
 * plumbing with no storage (uses resolve through
 * builtinNamespaceModuleOf's createRequire arm); both declaration
 * walks skip by this test. */
export function createRequireNamespaceDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isIdentifier(nameNode) || init === undefined) return false;
  const call = stripTypeCasts(init);
  if (!ts.isCallExpression(call)) return false;
  const cr = createRequireSpecOf(lowerer, call);
  return cr !== null && cr.spec !== null && canonicalBuiltinModule(cr.spec) !== null;
}

/** A statically compiled program module reached through a canonical
 * createRequire binding. This is the ESM twin of an ordinary CommonJS
 * require edge: the same project resolver, require-condition npm-static
 * entry, module initializer, and export registrations own the target. */
export function createRequireProgramModuleOf(
  lowerer: Lowerer,
  expr: ts.Expression | undefined,
): { spec: string; baseFile: ts.SourceFile; dep: ts.SourceFile } | null {
  if (expr === undefined) return null;
  const call = stripTypeCasts(expr);
  if (!ts.isCallExpression(call)) return null;
  const cr = createRequireSpecOf(lowerer, call);
  if (cr === null || cr.spec === null || canonicalBuiltinModule(cr.spec) !== null) return null;
  const dep =
    resolveImport(lowerer.program, cr.baseFile, cr.spec, "require") ??
    npmStaticDepSf7(lowerer.program, cr.baseFile, cr.spec, "require");
  if (dep === null || dep.fileName.endsWith(".json")) return null;
  return { spec: cr.spec, baseFile: cr.baseFile, dep };
}

/** True for a const identifier whose initializer is a createRequire call
 * reaching a compiled program module. The binding is namespace/value
 * alias plumbing; its declaration emits only the dependency's run-once
 * initializer at the source position. */
export function createRequireProgramModuleDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (createRequireProgramModuleOf(lowerer, init) === null) return false;
  if (ts.isIdentifier(nameNode)) return true;
  if (!ts.isObjectBindingPattern(nameNode)) return false;
  return nameNode.elements.nodes.every(
    (element) =>
      element.name !== undefined &&
      element.dotDotDotToken === undefined &&
      element.initializer === undefined &&
      ts.isIdentifier(element.name) &&
      (element.propertyName === undefined ||
        ts.isIdentifier(element.propertyName) ||
        ts.isStringLiteralLike(element.propertyName)),
  );
}

/** The module specifier when `ident` is an import binding (named,
 * default, or namespace) from a node BUILTIN module with no scriptc
 * support — "child_process", "net", ... — or null. The coverage story's
 * use-site half: preflight fenced the import line; statements using the
 * binding poison with the same module-naming diagnostic. */
export function fencedBuiltinImportOf(lowerer: Lowerer, ident: ts.Identifier): string | null {
  const symbol = lowerer.checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (!decl) return null;
  // The CommonJS twins: `const x = require("net")` and
  // `const { createServer } = require("net")` — the require statement
  // was fenced at preflight; uses of the bindings poison with the same
  // module name.
  {
    const varDecl =
      ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)
        ? decl.parent.parent
        : decl;
    if (ts.isVariableDeclaration(varDecl) && varDecl.initializer !== undefined) {
      const spec = requireSpecOf(varDecl.initializer);
      if (spec !== null) {
        if (isNativeFfiRequire(lowerer, varDecl.initializer)) return null;
        const isBuiltin = spec.startsWith("node:") || builtinModules.includes(spec);
        return isBuiltin && canonicalBuiltinModule(spec) === null ? spec : null;
      }
    }
  }
  let importDecl: ts.Node | undefined;
  if (ts.isImportSpecifier(decl)) importDecl = decl.parent?.parent?.parent;
  else if (ts.isNamespaceImport(decl)) importDecl = decl.parent?.parent;
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
