import { builtinModules } from "node:module";
import * as ts from "../../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { type Lowerer } from "../lowerer.js";
import {
  canonicalBuiltinModule,
  isCreateRequireBinding7,
  isJsSourceFile,
  locOf,
  requireSpecOf,
} from "../../program.js";
import { staticString } from "./module-resolution.js";
import { isCjsRequireGlobal } from "../lower-node-module.js";
import { builtinModuleHasMember } from "../builtin-module-members.js";
import { namespaceNonExportDiag, type ScrDiagnostic } from "../../../diagnostics/diagnostic.js";

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

/** The member a node:stream/web import binding names (`import {
 * WritableStream } from "node:stream/web"`, or its CommonJS twin), or null. */
export function streamWebImportOf(lowerer: Lowerer, ident: ts.Identifier): string | null {
  const binding = builtinModuleBindingOf(lowerer, ident);
  return binding?.module === "stream/web" ? binding.member : null;
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

/** The refusal of a TypeScript read, through an ES module namespace
 * (`import * as zlib from "node:zlib"; zlib.Z_NO_FLUSH`), of a member Node's
 * namespace object does not export: the module's exports object owns the
 * name without enumerating it, the namespace has exactly the exports, and
 * Node reads undefined, which the member's declared type (it describes the
 * exports object) cannot hold. Null for every other read, JavaScript
 * sources included (their read is untyped). The named import of such a
 * member fails to link in Node, which the ES module link analysis answers
 * (program.ts analyzeEsmNamedImportLinks). */
export function namespaceNonExportRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  module: string,
  member: string,
): ScrDiagnostic | null {
  if (
    isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
    builtinModuleHasMember(module, "esm", member) !== false ||
    lowerer.builtinNamespaceShapeOf(expr.expression)?.flavor !== "esm"
  )
    return null;
  return namespaceNonExportDiag(
    module,
    member,
    builtinModuleHasMember(module, "esm", "constants") === true,
    locOf(expr),
  );
}

/** True when `expr` evaluates to a builtin's ES module namespace OBJECT,
 * the value whose members are copies of the module's exports: a namespace
 * import, the literal `import()` awaited where it is read (or through the
 * casts a program writes around it), and a `const` bound to one. The
 * CommonJS module object — `require()`, a default import, a
 * getBuiltinModule result — is not: its members read the module's own
 * mutable properties, as `events.defaultMaxListeners` does. */
export function isBuiltinEsmNamespaceOf(lowerer: Lowerer, expr: ts.Expression): boolean {
  if (awaitedBuiltinDynamicImportOf(lowerer, expr) !== null) return true;
  const e = withoutParenthesesTypeWrappers(expr);
  if (!ts.isIdentifier(e)) return false;
  if (esmImportBindingKind(lowerer, e) === "namespace") return true;
  const decl = lowerer.checker.getSymbolAtLocation(e)?.declarations[0];
  return (
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    ts.isIdentifier(decl.name) &&
    decl.initializer !== undefined &&
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
    awaitedBuiltinDynamicImportOf(lowerer, decl.initializer) !== null
  );
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

/** The member's own symbol for a variable bound to a builtin module's
 * member (`const SD = require("string_decoder").StringDecoder`,
 * builtinMemberRequireDecl) when the member is a class, so the variable
 * resolves as a named import of the class does. The symbol itself
 * otherwise. */
export function builtinMemberBindingTarget(
  lowerer: Lowerer,
  symbol: ts.Symbol | null,
): ts.Symbol | null {
  const decl = symbol?.valueDeclaration;
  if (
    decl === undefined ||
    !ts.isVariableDeclaration(decl) ||
    !builtinMemberRequireDecl(decl.name, decl.initializer)
  )
    return symbol;
  const init = decl.initializer as ts.PropertyAccessExpression;
  let member = lowerer.checker.getSymbolAtLocation(init.name);
  if (member && member.flags & ts.SymbolFlags.Alias)
    member = lowerer.checker.getAliasedSymbol(member);
  // Only a class member: `require("events").EventEmitter` is a static
  // property of the exported class, which builtinEmitterInfoOf follows
  // from the variable itself.
  return member?.declarations.some(ts.isClassDeclaration) ? member : symbol;
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
 * here (its own arm already resolves it).
 *
 * `await import("node:crypto")` is a namespace source too: its value is
 * the same immortal builtin namespace token the static import yields, so
 * the bindings are the same alias plumbing (Node's per-module caching
 * makes the token identical on every import). The await itself is an
 * observable step — the statement lowering still evaluates it — so only
 * the bindings skip storage. */
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
  // `const { join } = require("node:path")`, through the global require or a
  // createRequire binding: the call IS the namespace — same table keying.
  // The casts strip, so an assertion over the call (`require("fs") as {…}`,
  // a statically known `any`) destructures the same namespace it names.
  let module: string | null = null;
  const init = withoutParenthesesTypeWrappers(decl.initializer);
  if (ts.isCallExpression(init)) {
    if (ts.isIdentifier(init.expression) && isCjsRequireGlobal(lowerer, init.expression)) {
      const spec = requireSpecOf(init);
      module = spec !== null ? canonicalBuiltinModule(spec) : null;
    } else {
      const cr = createRequireSpecOf(lowerer, init);
      module = cr !== null && cr.spec !== null ? canonicalBuiltinModule(cr.spec) : null;
    }
  } else if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
    // `const { open } = fs.promises` / `= require("fs").promises`: a member
    // that is itself a supported module.
    module = lowerer.builtinNamespaceModuleOf(init);
  } else if (ts.isAwaitExpression(init)) {
    // `const { createHash } = await import("node:crypto")`: the awaited
    // literal import of a builtin yields its namespace, whose members key
    // the same tables — including the mutable-declaration case the static
    // namespace form already admits, where a write to a binding has the
    // alias form's usual refusal rather than a slot.
    module = awaitedBuiltinDynamicImportOf(lowerer, init)?.module ?? null;
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

/** `await import("<builtin literal>")`: the awaited literal dynamic
 * import of a builtin module (a folded constant specifier counts — the
 * same spellings the dynamic-import lowering resolves). The value is the
 * builtin's namespace token; null for every other dynamic import, whose
 * namespace has no alias-plumbing representation, and for a literal that
 * names no builtin. */
export function awaitedBuiltinDynamicImportOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): { module: string; awaited: ts.AwaitExpression } | null {
  const awaited = withoutParenthesesTypeWrappers(expr);
  if (!ts.isAwaitExpression(awaited)) return null;
  const call = withoutParenthesesTypeWrappers(awaited.expression);
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword)
    return null;
  if (call.arguments.nodes.length !== 1) return null;
  const spec = staticString(lowerer, call.arguments.nodes[0]);
  if (spec === null) return null;
  const module = canonicalBuiltinModule(spec);
  return module === null ? null : { module, awaited };
}

/** The `createRequire(<base>)` call over the node:module import binding
 * with a supported base — import.meta.url, import.meta.filename, or
 * __filename, every spelling of "this file" — or null. The base never
 * LOWERS (import.meta has no value representation): it only names the
 * file whose directory anchors the returned require's relative
 * resolution, and every supported spelling names the call's own file. */
/** `undefined` in either spelling, through casts. */
function isUndefinedValue(expr: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(expr);
  return ts.isIdentifier(e) ? e.text === "undefined" : ts.isVoidExpression(e);
}

/** True for a read of the createRequire import binding itself (the value
 * tested by a conditional initializer). */
function isCreateRequireImportValue(lowerer: Lowerer, expr: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(expr);
  if (!ts.isIdentifier(e)) return false;
  const bi = builtinImportOf(lowerer, e);
  return bi !== null && bi.module === "module" && bi.member === "createRequire";
}

function createRequireBaseCallOf(lowerer: Lowerer, expr: ts.Expression): ts.CallExpression | null {
  const e = withoutParenthesesTypeWrappers(expr);
  // `const require = createRequire ? createRequire(import.meta.url) :
  // undefined`: the import binding is always a function, so the true arm
  // is the value. Only that polarity folds; with the arms swapped the
  // binding is undefined at run time.
  if (ts.isConditionalExpression(e)) {
    if (!isCreateRequireImportValue(lowerer, e.condition) || !isUndefinedValue(e.whenFalse))
      return null;
    return createRequireBaseCallOf(lowerer, e.whenTrue);
  }
  if (!ts.isCallExpression(e) || e.questionDotToken) return null;
  if (!ts.isIdentifier(e.expression)) return null;
  const bi = builtinImportOf(lowerer, e.expression);
  if (!bi || bi.module !== "module" || bi.member !== "createRequire") return null;
  if (e.arguments.nodes.length !== 1) return null;
  const base = withoutParenthesesTypeWrappers(e.arguments.nodes[0]!);
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

/** The variable declaration `ident` names, following the import alias of
 * an importing module, or null. */
function createRequireBindingDeclOf(
  lowerer: Lowerer,
  ident: ts.Identifier,
): ts.VariableDeclaration | null {
  let symbol = lowerer.checker.getSymbolAtLocation(ident);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  const decl = symbol ? symbol.declarations[0] : undefined;
  return decl !== undefined && ts.isVariableDeclaration(decl) ? decl : null;
}

/** The declaration a name reaches through any import alias, or null. */
function declaredNodeOf(lowerer: Lowerer, ident: ts.Identifier): ts.Node | null {
  let symbol = lowerer.checker.getSymbolAtLocation(ident);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  const decl = symbol ? symbol.declarations[0] : undefined;
  return decl ?? null;
}

/** The stable identity anchor of a createRequire-made loader, and of its
 * `resolve` member: the DECLARATION the read reaches through any import
 * alias, not the read's own position. Node's loader is one function object,
 * so every read of one binding must lower to one value (`r === r`,
 * `r.resolve === r.resolve`, a copy stored twice compares equal). An inline
 * `createRequire(base)` receiver has no binding: each such expression is a
 * fresh require function in Node, so it anchors at its own position and
 * distinct positions stay distinct. */
export function createRequireLoaderAnchorOf(lowerer: Lowerer, receiver: ts.Expression): string {
  let e = withoutParenthesesTypeWrappers(receiver);
  // `r.resolve.paths` names a member of the loader's `resolve`: anchor on
  // the loader, so both members share it (each surface keeps its own key).
  if (ts.isPropertyAccessExpression(e) && e.name.text === "resolve")
    e = withoutParenthesesTypeWrappers(e.expression);
  const decl = ts.isIdentifier(e) ? declaredNodeOf(lowerer, e) : null;
  const at = locOf(decl ?? e);
  return `${at.file}:${at.start}`;
}

/** True for a binding destructured from the node:module namespace —
 * `const { createRequire: cr } = require("node:module")` — the CommonJS
 * twin of the named import: a factory that makes a require over a
 * run-time base. */
export function createRequireFactoryBinding(lowerer: Lowerer, ident: ts.Identifier): boolean {
  if (!isJsSourceFile(ts.getSourceFileOfNode(ident))) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isBindingElement(decl)) return false;
  if (decl.dotDotDotToken !== undefined || decl.initializer !== undefined) return false;
  if (!ts.isIdentifier(decl.name)) return false;
  const name = decl.propertyName ?? decl.name;
  if (!ts.isIdentifier(name) || name.text !== "createRequire") return false;
  if (!ts.isObjectBindingPattern(decl.parent)) return false;
  const varDecl = decl.parent.parent;
  if (
    !ts.isVariableDeclaration(varDecl) ||
    varDecl.initializer === undefined ||
    !ts.isVariableDeclarationList(varDecl.parent) ||
    (varDecl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  const call = withoutParenthesesTypeWrappers(varDecl.initializer);
  if (!ts.isCallExpression(call)) return false;
  const cr = createRequireSpecOf(lowerer, call);
  return cr !== null && cr.spec !== null && canonicalBuiltinModule(cr.spec) === "module";
}

/** True when `expr` evaluates to a createRequire-made require whose base
 * is a RUN-TIME value — `createRequire(from)`, through a factory binding
 * (`cr(rootFile)`), or a stable binding over one. No file anchors the
 * returned require's resolution, so uses lower to a deferred run-time
 * fence rather than a static resolution. JavaScript sources only;
 * TypeScript sources keep the refusal. */
export function createRequireRuntimeBaseOf(lowerer: Lowerer, expr: ts.Expression): boolean {
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return false;
  const e = withoutParenthesesTypeWrappers(expr);
  if (ts.isCallExpression(e)) {
    if (e.questionDotToken || !ts.isIdentifier(withoutParenthesesTypeWrappers(e.expression)))
      return false;
    const callee = withoutParenthesesTypeWrappers(e.expression) as ts.Identifier;
    // `cr(base)` — the factory call IS the run-time-base loader, so
    // `cr(base)(spec)` reaches the loader through it.
    if (createRequireFactoryBinding(lowerer, callee)) return true;
    if (!isCreateRequireImportValue(lowerer, callee)) return false;
    return createRequireBaseCallOf(lowerer, e) === null;
  }
  if (!ts.isIdentifier(e)) return false;
  const decl = createRequireBindingDeclOf(lowerer, e);
  if (
    decl === null ||
    decl.initializer === undefined ||
    !ts.isIdentifier(decl.name) ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  const init = withoutParenthesesTypeWrappers(decl.initializer);
  if (ts.isConditionalExpression(init)) return false;
  if (!ts.isCallExpression(init) || init.questionDotToken) return false;
  const callee = withoutParenthesesTypeWrappers(init.expression);
  if (!ts.isIdentifier(callee)) return false;
  if (createRequireFactoryBinding(lowerer, callee)) return true;
  return (
    isCreateRequireImportValue(lowerer, callee) && createRequireBaseCallOf(lowerer, init) === null
  );
}

/** True for the destructuring declaration `const { createRequire: cr } =
 * require("node:module")` (or `= <loader>("module")`): the factory
 * binding is compile-time plumbing, and its calls lower through
 * createRequireFactoryBinding. */
export function createRequireFactoryDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (init === undefined || !ts.isObjectBindingPattern(nameNode)) return false;
  if (!isJsSourceFile(ts.getSourceFileOfNode(nameNode))) return false;
  const varDecl = nameNode.parent;
  if (
    !ts.isVariableDeclaration(varDecl) ||
    varDecl.initializer === undefined ||
    !ts.isVariableDeclarationList(varDecl.parent) ||
    (varDecl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  for (const element of nameNode.elements.nodes) {
    if (element.dotDotDotToken !== undefined || element.initializer !== undefined) return false;
    const name = element.propertyName ?? element.name;
    if (!ts.isIdentifier(name) || name.text !== "createRequire") return false;
    if (!ts.isIdentifier(element.name)) return false;
  }
  const call = withoutParenthesesTypeWrappers(init);
  if (!ts.isCallExpression(call) || call.questionDotToken) return false;
  const cr = createRequireSpecOf(lowerer, call);
  return cr !== null && cr.spec !== null && canonicalBuiltinModule(cr.spec) === "module";
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
  if (!ts.isIdentifier(nameNode) || init === undefined) return false;
  // Preserve const loaders acquired through CommonJS member/destructure
  // aliases, which builtinImportOf also recognizes. Mutable syntax uses
  // preflight's narrower import provenance and whole-file stability proof.
  const decl = nameNode.parent;
  const isConst =
    ts.isVariableDeclaration(decl) &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0;
  if (createRequireBaseCallOf(lowerer, init) === null) {
    // A run-time base has no build-time resolution: the binding is
    // erased and every use lowers to the deferred fence.
    return isConst && createRequireRuntimeBaseOf(lowerer, init);
  }
  if (isConst) return true;
  return isCreateRequireBinding7(lowerer.program, nameNode);
}

/** The base expression a RUN-TIME createRequire binding's declaration must
 * still evaluate, or null. Node calls `createRequire(base)` when the
 * declaration runs, so the argument's side effects happen there and
 * anything it throws unwinds the module then; the binding is erased as
 * compile-time plumbing, but the declaration keeps the base. A build-time
 * base (`import.meta.url`, `__filename`) has no effect to keep. */
export function createRequireEvaluatedBaseOf(
  lowerer: Lowerer,
  init: ts.Expression | undefined,
): ts.Expression | null {
  if (init === undefined) return null;
  const e = withoutParenthesesTypeWrappers(init);
  if (!ts.isCallExpression(e) || e.questionDotToken) return null;
  if (e.arguments.nodes.length !== 1) return null;
  return createRequireRuntimeBaseOf(lowerer, e) ? e.arguments.nodes[0]! : null;
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
  const e = withoutParenthesesTypeWrappers(callee);
  if (ts.isCallExpression(e)) {
    return createRequireBaseCallOf(lowerer, e) !== null ? ts.getSourceFileOfNode(e) : null;
  }
  if (!ts.isIdentifier(e)) return null;
  // A run-time base anchors nothing at build time: no static resolution
  // through the loader (its uses take the deferred fence instead).
  if (createRequireRuntimeBaseOf(lowerer, e)) return null;
  let symbol = lowerer.checker.getSymbolAtLocation(e);
  // An importing module reaches the loader through its export alias
  // (`import { __require as require } from "./chunk"`): preflight proves
  // those uses are the same supported calls, and the loader's own file
  // anchors resolution either way.
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
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
  const call = withoutParenthesesTypeWrappers(expr);
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
  const call = withoutParenthesesTypeWrappers(init);
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
  const call = withoutParenthesesTypeWrappers(expr);
  if (!ts.isCallExpression(call)) return null;
  const cr = createRequireSpecOf(lowerer, call);
  if (cr === null || cr.spec === null || canonicalBuiltinModule(cr.spec) !== null) return null;
  const dep =
    lowerer.facts.importedModule(cr.baseFile, cr.spec, "require") ??
    lowerer.facts.npmStaticModule(cr.baseFile, cr.spec, "require");
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
