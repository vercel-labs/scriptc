/* Namespace lowering (`namespace N { ... }` / legacy `module N { ... }`).
 *
 * A namespace is a STATIC shape: its members are compile-time-known
 * declarations, so the lowering flattens each instantiated namespace body
 * into the enclosing file's parts — functions and classes hoist into the
 * ordinary collection lists under NAMESPACE-QUALIFIED names, and every
 * other statement (member variables, side-effecting statements, nested
 * blocks' statements) stays in the file's init body AT ITS SOURCE
 * POSITION, so declaration-time side effects run exactly when Node runs
 * them. Qualified references (`N.x`, `A.B.f()`, `new N.C()`) resolve
 * through the checker's member symbols to the same registries bare
 * identifiers use; the namespace OBJECT itself has no runtime value and
 * every first-class use of it fences by name.
 *
 * Zero-runtime namespaces stay zero-runtime: ambient declarations
 * (`declare namespace`/`declare module`, `declare global`, string-named
 * modules) and non-instantiated bodies (only interfaces/type aliases/
 * import= aliases inside) lower to NOTHING — reads of ambient namespace
 * members compile to Node's exact catchable ReferenceError at the access
 * (the namespace object never exists at runtime, same stance as ambient
 * `declare const` reads).
 *
 * Honesty guards (Node evaluates namespace bodies in source order, and a
 * namespace member does not exist before its declaration statement ran):
 * - a qualified reference in INIT-EXECUTING position (top level, not
 *   inside a function body) textually above the member's declaration
 *   fences — Node would observe an uninitialized binding where the static
 *   resolution would read the final one;
 * - `import x = N.y` aliases are pure plumbing for IMMUTABLE targets
 *   (namespaces, functions, classes, consts); a mutable (`let`) target
 *   would need snapshot-at-alias semantics and fences;
 * - alias segments in init-position reference chains carry the same
 *   source-order guards (the alias captures its target at the alias
 *   statement).
 * References from FUNCTION BODIES take the module-globals stance the rest
 * of the compiler already takes (a body running before the declaring
 * statement is not modeled — same as top-level const reads through early
 * calls). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { boundIdentifiersOf } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { locOf, resolveImport } from "../program.js";
import { F64, IrExpr, IrStmt, IrType, STRING } from "../../ir/ir.js";

/** True when this module declaration produces NO runtime construct at all:
 * ambient (`declare namespace/module`, `declare global`, string-named
 * modules — .d.ts surface or user-file declares) or a non-instantiated
 * body (only type-world statements inside). */
function nsZeroRuntime(decl: ts.ModuleDeclaration): boolean {
  if (isAmbientModuleDecl(decl)) return true;
  if (!ts.isIdentifier(decl.name)) return true; // string-named: ambient by grammar
  return nsTypeOnlyBody(decl);
}

/** Ambient module declaration: carries `declare` itself, sits in an
 * ambient ancestor, or is the `declare global` augmentation. */
function isAmbientModuleDecl(decl: ts.ModuleDeclaration): boolean {
  if (decl.flags & ts.NodeFlags.Ambient) return true;
  for (let p: ts.Node | undefined = decl; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isModuleDeclaration(p)) {
      if (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Ambient) return true;
      if (ts.isStringLiteral(p.name)) return true;
      if (ts.isIdentifier(p.name) && p.name.text === "global") return true;
    }
  }
  return false;
}

/** Non-instantiated body: only interfaces, type aliases, and recursively
 * non-instantiated namespaces. Such a namespace is pure type world — no
 * emit of Node's transform materializes it. import= aliases COUNT as
 * instantiating (tsc's isInstantiatedModule rule, and Node's transform
 * emits their `var x = ...` unconditionally). */
function nsTypeOnlyBody(decl: ts.ModuleDeclaration): boolean {
  let body = decl.body;
  while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
  if (body === undefined) return true;
  if (!ts.isModuleBlock(body)) return true;
  return body.statements.every(
    (s) =>
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      (ts.isModuleDeclaration(s) && nsTypeOnlyBody(s)),
  );
}

/** A namespace SYMBOL's runtime state: "instantiated" when any merged
 * declaration's block flattened (the object exists once a block ran;
 * merged ambient declarations don't subtract), "typeOnly"/"ambient" when
 * none did. Null for non-namespace symbols. */
function nsSymbolRuntimeKind(lowerer: Lowerer, sym: ts.Symbol): "instantiated" | "typeOnly" | "ambient" | null {
  if (!(sym.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule))) return null;
  let sawTypeOnly = false;
  let sawNamespace = false;
  for (const d of lowerer.checker.declarationsOf(sym)) {
    if (!ts.isModuleDeclaration(d)) continue;
    sawNamespace = true;
    let body = d.body;
    while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
    const kind = body !== undefined ? lowerer.nsBlocks.get(body) : undefined;
    if (kind === "flattened") return "instantiated";
    if (kind === "typeOnly") sawTypeOnly = true;
  }
  if (!sawNamespace) return null;
  return sawTypeOnly ? "typeOnly" : "ambient";
}

/** splitFiles' namespace hook: classify one top-level (or nested)
 * ModuleDeclaration and either skip it (zero runtime — its blocks register
 * as "typeOnly" so import= alias members still resolve statically) or
 * FLATTEN its body into the file's parts: functions/classes hoist into the
 * collection lists, everything else joins the init body in source order.
 * Nested namespaces recurse; dotted declarations (`namespace A.B.C`)
 * descend to the innermost block. */
export function collectNamespaceStmt(lowerer: Lowerer, decl: ts.ModuleDeclaration, fp: FileParts): void {
  if (nsZeroRuntime(decl)) {
    if (!isAmbientModuleDecl(decl)) registerTypeOnlyBlocks(lowerer, decl);
    return;
  }
  let body = decl.body;
  while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
  if (body === undefined || !ts.isModuleBlock(body)) return; // bodyless non-ambient: tsc-rejected
  lowerer.nsBlocks.set(body, "flattened");
  for (const s of body.statements) {
    if (ts.isFunctionDeclaration(s)) fp.fnDecls.push(s);
    else if (ts.isClassDeclaration(s)) fp.classDecls.push(s);
    else if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
    else if (ts.isModuleDeclaration(s)) collectNamespaceStmt(lowerer, s, fp);
    // Everything else — member variables, side-effecting statements,
    // import= aliases (lowerStmt handles them), enums (their own fence) —
    // runs in the init body at its source position.
    else fp.topStmts.push(s);
  }
}

function registerTypeOnlyBlocks(lowerer: Lowerer, decl: ts.ModuleDeclaration): void {
  let body = decl.body;
  while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
  if (body === undefined || !ts.isModuleBlock(body)) return;
  lowerer.nsBlocks.set(body, "typeOnly");
  for (const s of body.statements) {
    if (ts.isModuleDeclaration(s)) registerTypeOnlyBlocks(lowerer, s);
  }
}

/** The namespace-path prefix of a declaration's emitted name ("A%B." for
 * an exported member of namespace A.B; "" at real top level). Segments
 * join with '%' — a character no user identifier can contain, so a
 * namespaced name can never collide with a plain top-level one after
 * mangling. NON-exported members (and non-exported nested namespace
 * segments) append the declaring block's source position: they are
 * block-local bindings — two blocks of the same namespace may each declare
 * one under the same spelling, and the position keeps their storage
 * distinct (resolution is by symbol; names only need uniqueness and
 * determinism). `modifierDecl` carries the declaration whose modifiers
 * decide exportedness (the first declarator of a variable statement). */
export function nsPathPrefix(node: ts.Node, modifierDecl?: ts.Node): string {
  const parent = node.parent;
  if (parent === undefined || !ts.isModuleBlock(parent)) return "";
  const flagsHost = modifierDecl ?? node;
  const exported =
    (ts.getCombinedModifierFlags(flagsHost as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  const segs: string[] = [];
  for (let p: ts.Node | undefined = parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isModuleDeclaration(p) && ts.isIdentifier(p.name)) {
      // A nested namespace STATEMENT without `export` is block-local;
      // dotted continuations (parent is a ModuleDeclaration) and top-level
      // declarations merge by name and take the plain segment.
      const nested = p.parent !== undefined && ts.isModuleBlock(p.parent);
      const nonExported =
        nested && (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Export) === 0;
      segs.unshift(p.name.text + (nonExported ? `%${p.getStart()}` : ""));
    }
  }
  return `${segs.join("%")}${exported ? "" : `%${parent.getStart()}`}.`;
}

/** The registered namespace-block kind a symbol's declaration sits in
 * ("flattened" — a lowered value namespace; "typeOnly" — a skipped
 * non-instantiated one, whose only value members are import= aliases), or
 * null. The walk stops at class/function boundaries: a static member of a
 * class INSIDE a namespace is the class's business, not the namespace's. */
function nsBlockKindOfSymbol(lowerer: Lowerer, sym: ts.Symbol): "flattened" | "typeOnly" | null {
  for (const d of lowerer.checker.declarationsOf(sym)) {
    // TYPE declarations don't make a member a namespace VALUE: a class
    // static `C.B` whose name also carries `namespace C { export
    // interface B }` is the static's business — value references consult
    // value declarations only. AMBIENT member declarations inside a real
    // block (`export declare const x` — nothing defines the property, so
    // Node reads undefined off the live object) stay unclaimed too: the
    // receiver-path fences own them, never a wrong static read.
    if (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) continue;
    if (ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Ambient) continue;
    let blocked = false;
    for (let p: ts.Node | undefined = d.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
      const kind = lowerer.nsBlocks.get(p);
      if (kind !== undefined) {
        if (!blocked) return kind;
        break;
      }
      if (
        ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isFunctionLike(p) ||
        ts.isInterfaceDeclaration(p) || ts.isObjectLiteralExpression(p) || ts.isEnumDeclaration(p)
      ) {
        blocked = true; // the member belongs to that construct, not the namespace
      }
    }
  }
  return null;
}

/** The program SOURCE FILE a module-namespace expression denotes: the
 * receiver is an identifier (an `import * as ns` / `export * as ns`
 * binding — re-export chains resolve through getAliasedSymbol) or a
 * property access whose member itself names a module (`agg.ns` where agg
 * re-exports `* as ns`), and the alias chain lands on a module symbol
 * whose declaration is a NON-DECLARATION source file of this program.
 * Builtin/stdlib module namespaces (string-named ambient modules in
 * .d.ts files) and npm packages answer null — their own chokepoints and
 * fences keep ownership. */
function moduleNsSourceFileOf(lowerer: Lowerer, e: ts.Expression): ts.SourceFile | null {
  let sym: ts.Symbol | undefined;
  if (ts.isIdentifier(e)) {
    sym = lowerer.checker.getSymbolAtLocation(e);
  } else if (
    ts.isPropertyAccessExpression(e) &&
    e.questionDotToken === undefined &&
    ts.isIdentifier(e.name)
  ) {
    sym = lowerer.checker.getSymbolAtLocation(e.name);
  }
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) sym = lowerer.checker.getAliasedSymbol(sym);
  for (const d of lowerer.checker.declarationsOf(sym)) {
    if (
      sym.flags & ts.SymbolFlags.ValueModule &&
      ts.isSourceFile(d) && !d.isDeclarationFile && lowerer.fileTag.has(d)
    ) {
      return d;
    }
    // A symbol MERGED with type-world declarations (`export type Drink =
    // ...; export * as Drink from "./constants"`) does not alias-resolve
    // to the bare module symbol — but its namespace-import/export
    // declaration still names the module: resolve through the statement's
    // own specifier.
    if (ts.isNamespaceImport(d) || ts.isNamespaceExport(d)) {
      const stmt = ts.isImportClause(d.parent) ? d.parent.parent : d.parent;
      if (
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const dep = resolveImport(lowerer.program, d.getSourceFile(), stmt.moduleSpecifier.text);
        if (dep && !dep.isDeclarationFile && lowerer.fileTag.has(dep)) return dep;
      }
    }
  }
  return null;
}

/** The member identifier of a qualified namespace reference, when `access`
 * reads a member declared in a lowered (or type-only) namespace block —
 * or an EXPORT of a program module read through its namespace-import
 * binding (`import * as ns from "./m"; ns.f`): the checker binds the
 * member name to the exporter's own symbol either way. Callers delegate
 * the actual lowering to the identifier paths — the member NAME resolves
 * through resolveValueSymbol exactly like a bare reference (globals,
 * function values, classes, generic functions). Module-namespace member
 * reads are LIVE bindings in Node (the namespace object's properties
 * alias the exporter's storage), which is exactly what resolving to the
 * exporter's module global gives. */
export function nsMemberIdentOf(lowerer: Lowerer, access: ts.PropertyAccessExpression): ts.Identifier | null {
  if (access.questionDotToken !== undefined) return null;
  if (!ts.isIdentifier(access.name)) return null;
  const memberSym = lowerer.checker.getSymbolAtLocation(access.name);
  if (!memberSym) return null;
  if (nsBlockKindOfSymbol(lowerer, memberSym) !== null) return access.name;
  if (moduleNsSourceFileOf(lowerer, access.expression) !== null) return access.name;
  return null;
}

/** The ROOT identifier of a qualifier chain that denotes a user-file
 * AMBIENT namespace (every value declaration an ambient identifier-named
 * ModuleDeclaration outside the stdlib/@types surface), or null. Reads
 * through it compile to Node's ReferenceError naming the root — the
 * ambient namespace object never exists at runtime. */
export function ambientNsRootOf(lowerer: Lowerer, e: ts.Expression): ts.Identifier | null {
  let root: ts.Expression = e;
  while (ts.isPropertyAccessExpression(root) && root.questionDotToken === undefined) {
    root = root.expression;
  }
  if (!ts.isIdentifier(root)) return null;
  let sym = lowerer.checker.getSymbolAtLocation(root);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = lowerer.checker.getAliasedSymbol(sym);
  if (!sym || !(sym.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule))) return null;
  if (lowerer.isStdlibSymbol(sym)) return null;
  const decls = lowerer.checker.declarationsOf(sym);
  if (decls.length === 0) return null;
  for (const d of decls) {
    // A namespace declaration, or the fundule/clazzdule merge partners
    // (`declare function B(): ...; declare namespace B { ... }`) — every
    // declaration must be AMBIENT in a user program file for the root to
    // be a nothing-defines-it name.
    if (!ts.isModuleDeclaration(d) && !ts.isFunctionDeclaration(d) && !ts.isClassDeclaration(d)) {
      return null;
    }
    if (ts.isModuleDeclaration(d) && !ts.isIdentifier(d.name)) return null;
    if (d.getSourceFile().isDeclarationFile) return null; // lib/@types keep their own fences
    if (ts.isModuleDeclaration(d) ? !isAmbientModuleDecl(d) : !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient)) {
      return null;
    }
  }
  return root;
}

/** The ROOT identifier of an expression whose FIRST runtime step is a read
 * Node cannot serve — the `declare const __VERSION__` stance's CHAIN form,
 * widened over every chain shape whose root evaluates first. Three root
 * families qualify:
 *
 *   - an initializer-less AMBIENT variable (`declare const/let/var x: T;`)
 *     in a user program file — Node erases the declaration entirely, so
 *     the root read throws the catchable ReferenceError "<name> is not
 *     defined";
 *   - an ambient `declare function` nothing defines (the same erasure,
 *     ambientUndefinedFnSymbolOf);
 *   - a TRAP BINDING (lowerer.trapBindings) — a binding whose own initializer
 *     provably threw before producing a value, so module init unwound and
 *     no reference to it can ever execute (any lowering is sound there;
 *     the trap keeps the shape honest if reachability analysis is wrong).
 *
 * The walk steps through parens, non-null/as/satisfies assertions,
 * property and element accesses (OPTIONAL chains included — `?.` guards
 * null/undefined AFTER a successful read; it cannot guard the root's own
 * ReferenceError), calls and `new` (the callee evaluates before any
 * argument), instantiation expressions, and tagged templates (the tag
 * evaluates first). A manifest-validated direct FFI call is the narrow
 * exception: its ambient declaration supplies a native implementation, so
 * the call itself is not an undefined-root read and outer transparent chains
 * retain that native result. Callers lower every other whole expression to
 * the root's throw, typed by the use site — and never lower the arguments,
 * exactly the order Node dies in. Null for stdlib/@types roots (their own
 * chokepoints stand) and anything declared with a value. */
export function ambientUndefVarRootOf(lowerer: Lowerer, e: ts.Expression): ts.Identifier | null {
  let root: ts.Expression = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(root) ||
      ts.isNonNullExpression(root) ||
      ts.isAsExpression(root) ||
      ts.isSatisfiesExpression(root) ||
      ts.isTypeAssertion(root)
    ) {
      root = root.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      root = root.expression;
      continue;
    }
    if (ts.isCallExpression(root) || ts.isNewExpression(root)) {
      // A configured native binding owns this exact call node. Do not walk
      // into its signature-only declaration: the call produces a native
      // result, and normal call lowering must retain its ffiCall IR.
      if (ts.isCallExpression(root) && lowerer.ownsFfiCall(root)) return null;
      root = root.expression;
      continue;
    }
    if (ts.isExpressionWithTypeArguments(root)) {
      root = root.expression;
      continue;
    }
    if (ts.isTaggedTemplateExpression(root)) {
      root = root.tag;
      continue;
    }
    break;
  }
  if (!ts.isIdentifier(root)) return null;
  // PROBE resolution: every caller asks "is this chain ambient-rooted?"
  // and proceeds to its ordinary lowering on a null answer — so the
  // question must not carry resolution's side effects. Bare
  // resolveValueSymbol flushes the root's DEFERRED collection
  // diagnostics onto the build (reached-only-by-the-probe declarations
  // reported eagerly — collectGlobals runs this walk on every
  // initializer) and throws the cross-block merged-namespace fence's
  // PoisonError out of collection entirely. The collect-phase guard
  // suppresses both; the ordinary lowering that follows a null answer
  // re-resolves with full effects at its own site.
  const wasCollecting = lowerer.collecting;
  lowerer.collecting = true;
  try {
    const sym = lowerer.resolveValueSymbol(root);
    if (!sym) return null;
    if (lowerer.trapBindings.has(sym)) return root;
    if (lowerer.isStdlibSymbol(sym)) return null;
    if (ambientUndefinedFnSymbolOf(lowerer, root) !== null) return root;
    const decls = lowerer.checker.declarationsOf(sym);
    if (decls.length === 0) return null;
    for (const d of decls) {
      if (!ts.isVariableDeclaration(d) || d.initializer !== undefined) return null;
      if (d.getSourceFile().isDeclarationFile) return null; // lib/@types keep their own fences
      if (!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient)) return null;
    }
    return root;
  } finally {
    lowerer.collecting = wasCollecting;
  }
}

/** The declaration-classification form of ambientUndefVarRootOf: the root
 * that makes `decl` a TRAP BINDING — its initializer provably throws the
 * root's ReferenceError, so the binding never holds a value and needs no
 * storage — with the storage question answered honestly: a binding the
 * program WRITES anywhere keeps ordinary storage instead, because the
 * no-storage stance would fence every write site ("assignment to 'x'
 * (not a writable local or module global)") where the ordinary lowering
 * compiles them (`declare const numLiteral: 0; let t1 = numLiteral;
 * t1 = t1 + 42` — the literal-widening corpus shape). The writes still
 * never RUN either way — module init unwinds at the declaration's throw,
 * which the initializer READ lowers to through the ordinary chain walk
 * (lower-exprs) — so runtime semantics are identical; only the binding's
 * storage story changes.
 *
 * The decline is exactly as wide as its rationale: it only buys anything
 * when ordinary storage COMPILES, so a written binding whose declared
 * type has no static mapping keeps the trap claim (registration would
 * only trade the compiling no-storage stance for a guaranteed SC2009 on
 * a value that never exists — `var x = a(); x = y` over the recursive
 * interface pair, recursiveInheritance2). bindingEverWritten itself
 * skips the write forms the no-storage lowering already compiles (a
 * statement-position `x = <ambient-rooted chain>` IS the RHS root's
 * throw — lowerExprStatement never touches the target's storage). */
export function trapDeclRootOf(lowerer: Lowerer, decl: ts.VariableDeclaration): ts.Identifier | null {
  if (decl.initializer === undefined) return null;
  const root = ambientUndefVarRootOf(lowerer, decl.initializer);
  if (root === null) return null;
  for (const nameNode of boundIdentifiersOf(decl.name)) {
    const sym = lowerer.checker.getSymbolAtLocation(nameNode);
    if (sym && bindingEverWritten(lowerer, sym, decl.getSourceFile())) {
      const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(sym));
      if (mapped !== null && mapped.kind !== "void") return null;
    }
  }
  return root;
}

/** True when any identifier resolving to `sym` sits in a WRITE position in
 * `sf` (module-scope bindings cannot be written from other modules — ESM
 * imported bindings are read-only): an assignment LHS (compound forms
 * included), a destructuring-assignment element, ++/--, or a bare
 * for-in/of cursor. Resolution is plain getSymbolAtLocation — a probe
 * must not flush deferred diagnostics or fence.
 *
 * One write form does NOT count: a statement-position plain `=` whose
 * RHS chain roots at an ambient-undefined name. That statement lowers to
 * the RHS root's throw before any target resolution (lowerExprStatement's
 * first claim — Node evaluates the RHS first and dies there), so it never
 * needs the binding's storage and cannot justify declining the trap claim
 * (`export let c = obj["prop"]<T>\`…\`; c = obj.prop<T>\`…\`` — the
 * taggedTemplatesWithTypeArguments1 shape, where the decline pushed the
 * initializer into an ordinary lowering that fences). ambientUndefVarRootOf
 * carries its own collect-guard, so the extra question stays a probe. */
function bindingEverWritten(lowerer: Lowerer, sym: ts.Symbol, sf: ts.SourceFile): boolean {
  const symText = sym.name;
  const namesSym = (e: ts.Node): boolean =>
    ts.isIdentifier(e) && e.text === symText && lowerer.checker.getSymbolAtLocation(e) === sym;
  const patternWrites = (target: ts.Node): boolean => {
    if (namesSym(target)) return true;
    let hit = false;
    const walk = (m: ts.Node): void => {
      if (hit) return;
      if (namesSym(m)) hit = true;
      else m.forEachChild(walk);
    };
    target.forEachChild(walk);
    return hit;
  };
  let written = false;
  const visit = (n: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
        let lhs: ts.Expression = n.left;
        while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
        const throwsBeforeTheWrite = (): boolean => {
          if (k !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(lhs)) return false;
          let p: ts.Node = n.parent;
          while (ts.isParenthesizedExpression(p)) p = p.parent;
          if (!ts.isExpressionStatement(p)) return false;
          return ambientUndefVarRootOf(lowerer, n.right) !== null;
        };
        if (namesSym(lhs)) {
          if (!throwsBeforeTheWrite()) written = true;
        } else if (ts.isArrayLiteralExpression(lhs) || ts.isObjectLiteralExpression(lhs)) {
          if (patternWrites(lhs)) written = true;
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      let op: ts.Expression = n.operand as ts.Expression;
      while (ts.isParenthesizedExpression(op)) op = op.expression;
      if (namesSym(op)) written = true;
    } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      let t: ts.Node = n.initializer;
      while (ts.isParenthesizedExpression(t as ts.Expression)) t = (t as ts.ParenthesizedExpression).expression;
      if (namesSym(t) || ((ts.isArrayLiteralExpression(t) || ts.isObjectLiteralExpression(t)) && patternWrites(t))) {
        written = true;
      }
    }
    n.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return written;
}

/** ambientUndefReadType's CONTEXTUAL fallback: when the use site's own
 * type has no mapping (an `any`-typed member off a narrowed ambient), the
 * type the value flows INTO types the throw instead — sound because the
 * read never returns, so the typed dummy is never observed. */
export function contextualUndefReadType(lowerer: Lowerer, node: ts.Expression): IrType | null {
  const ctx = lowerer.checker.getContextualType(node);
  const mapped = ctx ? lowerer.mapTypeOf(ctx) : null;
  if (mapped && mapped.kind !== "void" && !lowerer.typeNamesUnregisteredClass(mapped)) return mapped;
  return null;
}

/** The IR type an ambient-namespace undefRead carries at `node`: the use
 * site's mapped type when it has one, the F64 dummy when the value is
 * DISCARDED anyway (expression-statement position — the bare `Foo.a;`
 * reads conformance tests are full of), null otherwise (the callers fall
 * through to their ordinary fences). The read always throws, so the typed
 * dummy is never observed. */
export function ambientUndefReadType(lowerer: Lowerer, node: ts.Node): IrType | null {
  const declared = lowerer.mapTypeOf(lowerer.typeOf(node));
  // A type naming an UNREGISTERED class (an ambient class's instance —
  // nothing collected a shape) would make the emitter name a struct that
  // does not exist; the F64 dummy serves discarded positions instead.
  if (declared && declared.kind !== "void" && !lowerer.typeNamesUnregisteredClass(declared)) {
    return declared;
  }
  const p = node.parent;
  if (p !== undefined && ts.isExpressionStatement(p)) return F64;
  return null;
}

/** The symbol behind `ident` when it names an ambient `declare function`
 * NOTHING defines: every function declaration on the symbol is body-less
 * and ambient in a USER program file (merge partners — the fundule's
 * ambient namespace, an ambient class — may ride along; type-world
 * declarations don't count). Node erases the declaration entirely, so a
 * reference throws the catchable ReferenceError "<name> is not defined"
 * at the use site — the `declare const` / ambient-namespace undefRead
 * stance. Null for stdlib/@types surfaces (their own chokepoints stand),
 * for overload signatures (an implementation exists), and for anything
 * declared in a .d.ts. */
export function ambientUndefinedFnSymbolOf(lowerer: Lowerer, ident: ts.Identifier): ts.Symbol | null {
  const sym = lowerer.resolveValueSymbol(ident);
  if (!sym || !(sym.flags & ts.SymbolFlags.Function)) return null;
  if (lowerer.isStdlibSymbol(sym)) return null;
  let sawFn = false;
  for (const d of lowerer.checker.declarationsOf(sym)) {
    if (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) continue; // type-world merge partners
    if (ts.isFunctionDeclaration(d)) {
      if (d.body) return null; // an implementation exists — not ambient-undefined
      sawFn = true;
    } else if (!ts.isModuleDeclaration(d) && !ts.isClassDeclaration(d)) {
      return null;
    }
    if (d.getSourceFile().isDeclarationFile) return null;
    if (!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient)) return null;
  }
  return sawFn ? sym : null;
}

/** Node's ReferenceError at an ambient namespace access — the undefRead
 * libCall the ambient `declare const` path already uses, typed by the use
 * site (it always throws; the typed dummy is abandoned by the unwind). */
export function nsUndefRead(lowerer: Lowerer, rootName: string, node: ts.Node, type: IrType): IrExpr {
  const loc = locOf(node);
  return {
    kind: "libCall",
    fn: "global.undefRead",
    args: [{ kind: "strLit", value: rootName, type: STRING, loc }],
    type,
    loc,
  };
}

/** True when `node` executes during module INIT (top-level statement
 * position — namespace bodies included — not inside any function-like
 * body). Class static blocks and field initializers count as init-time:
 * static blocks literally are, and over-fencing an early instance-field
 * read is conservative, never wrong output. */
function initExecutingPosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p)) return false;
    if (ts.isSourceFile(p)) break;
  }
  return true;
}

function earliestSameFileDeclStart(lowerer: Lowerer, sym: ts.Symbol, sf: ts.SourceFile): number {
  let earliest = Infinity;
  for (const d of lowerer.checker.declarationsOf(sym)) {
    if (d.getSourceFile() === sf) earliest = Math.min(earliest, d.getStart());
  }
  return earliest;
}

/** The source-order guard for one import=-alias segment (or a bare alias
 * use): the alias statement captures its target's CURRENT value, so an
 * init-position use above the alias — or an alias above its target — would
 * observe what Node leaves uninitialized. Fences instead of diverging. */
export function fenceEarlyAliasUse(lowerer: Lowerer, ident: ts.Identifier, refNode: ts.Node): void {
  const sym = lowerer.checker.getSymbolAtLocation(ident);
  if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return;
  const aliasDecl = lowerer.checker.declarationsOf(sym).find(ts.isImportEqualsDeclaration);
  if (!aliasDecl || ts.isExternalModuleReference(aliasDecl.moduleReference)) return;
  if (!initExecutingPosition(refNode)) return;
  const sf = refNode.getSourceFile();
  if (aliasDecl.getSourceFile() !== sf) return; // cross-file: module init order applies
  const aliasStart = aliasDecl.getStart();
  if (refNode.getStart() < aliasStart) {
    lowerer.unsupported(
      "SC1090",
      refNode,
      `reading '${ident.text}' above its \`import ${ident.text} = ...\` alias (Node binds the alias at its statement — this read would observe an uninitialized binding; move it below the alias)`,
    );
  }
  // The alias itself must run AFTER its target exists: a namespace target
  // needs a contributing block above the alias, a value target its
  // declaration.
  const target = lowerer.checker.getAliasedSymbol(sym);
  const targetStart = earliestSameFileDeclStart(lowerer, target, sf);
  if (targetStart !== Infinity && aliasStart < targetStart) {
    lowerer.unsupported(
      "SC1090",
      refNode,
      `the \`import ${ident.text} = ...\` alias above its target's declaration (Node binds the alias at its statement, when the target is still uninitialized; move the alias below the target)`,
    );
  }
}

/** The source-order guard for a qualified namespace-member reference in
 * init-executing position: the member's declaration (and every import=
 * alias segment in the qualifier chain) must precede the reference —
 * Node's namespace bodies run in source order, and `N.x` above the
 * declaring statement observes an uninitialized binding (undefined member
 * reads, TypeErrors on calls) that static resolution cannot reproduce.
 * Function-body references are exempt: they take the module-globals stance
 * the compiler already takes for top-level consts read through early
 * calls. */
export function fenceEarlyNsMemberRef(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  memberSym: ts.Symbol,
): void {
  if (!initExecutingPosition(access)) return;
  const sf = access.getSourceFile();
  const refStart = access.getStart();
  const memberStart = earliestSameFileDeclStart(lowerer, memberSym, sf);
  if (memberStart !== Infinity && refStart < memberStart) {
    lowerer.unsupported(
      "SC1090",
      access,
      `reading namespace member '${access.name.text}' above its declaration (Node evaluates namespace bodies in source order — this read would observe an uninitialized binding; move it below the declaring block)`,
    );
  }
  // Alias segments in the qualifier chain (`C.a.Origin` where `a` is
  // `import a = A`): each captures its target at ITS statement.
  for (let e: ts.Expression = access.expression; ; ) {
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      fenceEarlyAliasUse(lowerer, e.name, access);
      e = e.expression;
      continue;
    }
    if (ts.isIdentifier(e)) fenceEarlyAliasUse(lowerer, e, access);
    break;
  }
}

/** The cross-block bare-reference fence. tsc's checker puts every
 * exported member of EVERY block of a merged namespace in scope inside
 * every other block, and tsc's own emit rewrites such bare references to
 * the qualified form — but Node's transform (the oracle) does NOT:
 * a bare `f()` in one block referring to `export function f` in a SIBLING
 * block throws ReferenceError at runtime under
 * `--experimental-transform-types`. Static resolution would silently
 * print what Node crashes on, so those references fence with the fix in
 * the message. References to members of the SAME block or an ENCLOSING
 * namespace's block are lexically bound in the emitted nesting and lower
 * fine; alias bindings (import=/ESM imports) are exempt here — the alias
 * machinery carries its own guards. Called from resolveValueSymbol with
 * the PRE-alias symbol; property NAMES (qualified reads — runtime
 * property lookups, always fine) never reach it. */
export function fenceCrossBlockNsRef(lowerer: Lowerer, ident: ts.Identifier, symbol: ts.Symbol): void {
  if (lowerer.nsBlocks.size === 0 || lowerer.collecting) return;
  if (symbol.flags & ts.SymbolFlags.Alias) return;
  const p = ident.parent;
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.name === ident) return;
  // The registered blocks enclosing the REFERENCE, innermost first.
  const refBlocks: ts.Node[] = [];
  for (let q: ts.Node | undefined = ident.parent; q !== undefined && !ts.isSourceFile(q); q = q.parent) {
    if (lowerer.nsBlocks.has(q)) refBlocks.push(q);
  }
  for (const d of lowerer.checker.declarationsOf(symbol)) {
    for (let q: ts.Node | undefined = d.parent; q !== undefined && !ts.isSourceFile(q); q = q.parent) {
      if (!lowerer.nsBlocks.has(q)) continue;
      // Declared in a registered block: fine when that block encloses the
      // reference too (same block, or an enclosing namespace's block).
      if (refBlocks.includes(q)) return;
      const nsName = (() => {
        const m = q.parent;
        return m !== undefined && ts.isModuleDeclaration(m) && ts.isIdentifier(m.name) ? m.name.text : "N";
      })();
      lowerer.unsupported(
        "SC1090",
        ident,
        `the bare reference to '${ident.text}' from a different block of the merged namespace (Node's TypeScript transform does not bind exported members across namespace blocks — it throws ReferenceError where tsc's emit would qualify; write ${nsName}.${ident.text})`,
      );
    }
  }
}

/** Assignment-target resolution for namespace-qualified writes
 * (`N.x = v`, `N.x += v`, `N.x++`): the member's module global — exported
 * `let` members are ordinary mutable globals (tsc already rejected writes
 * to consts/functions/classes through the qualifier). Null when `access`
 * is not a lowered-namespace member at all; a member whose declaration
 * never registered storage takes the blocked-binding cascade. */
export function nsWritableTarget(lowerer: Lowerer, access: ts.PropertyAccessExpression): { id: string; type: IrType } | null {
  const nsMember = nsMemberIdentOf(lowerer, access);
  if (!nsMember) return null;
  const memberSym = lowerer.checker.getSymbolAtLocation(nsMember);
  if (memberSym) fenceEarlyNsMemberRef(lowerer, access, memberSym);
  const resolved = lowerer.resolveValueSymbol(nsMember);
  const g = resolved ? lowerer.globalsBySymbol.get(resolved) : undefined;
  if (!g) {
    lowerer.rejectUnresolved(nsMember, `assignment to namespace member '${nsMember.text}' (not a writable module global)`);
  }
  return { id: g.id, type: g.type };
}

/** lowerStmt's ImportEqualsDeclaration case. The RUNTIME require form
 * keeps its fence (preflight owns the top-level sites; namespace-internal
 * ones land here); `import type x = require(...)` is pure type surface and
 * lowers to nothing. The entity form is pure alias plumbing — references
 * resolve through the checker to the target's own registrations and the
 * statement emits nothing — EXCEPT aliases of MUTABLE bindings: Node's
 * transform emits `var x = N.y` (a snapshot at the alias statement), so
 * collection registered the alias its own const global (keyed by the
 * pre-alias symbol — resolveValueSymbol stops there) and this statement
 * assigns it from the target's storage, exactly when Node does. */
export function lowerImportEquals(lowerer: Lowerer, stmt: ts.ImportEqualsDeclaration): IrStmt | null {
  if (stmt.isTypeOnly) return null;
  if (ts.isExternalModuleReference(stmt.moduleReference)) {
    lowerer.unsupported("SC1013", stmt, "import = require(...) assignments");
  }
  // A BARE-identifier entity target (`import g = f` inside a block):
  // Node emits `var g = f` — the same cross-block bare-reference hole as
  // any other bare use; the shared fence applies at the alias statement.
  if (ts.isIdentifier(stmt.moduleReference)) {
    const refSym = lowerer.checker.getSymbolAtLocation(stmt.moduleReference);
    if (refSym) fenceCrossBlockNsRef(lowerer, stmt.moduleReference, refSym);
  }
  // Node's transform ALWAYS emits `var x = <entity>` — it never elides
  // type-only aliases the way tsc's emit does — so an alias whose entity
  // ROOT names an uninstantiated (type-only or ambient) namespace throws
  // ReferenceError AT THIS STATEMENT under the oracle. Reproduce it
  // exactly: the statement lowers to the undefRead throw and nothing
  // after it in this module's init runs, just like Node.
  {
    let root: ts.Node = stmt.moduleReference;
    while (ts.isQualifiedName(root)) root = root.left;
    if (ts.isIdentifier(root)) {
      let rootSym = lowerer.checker.getSymbolAtLocation(root);
      if (rootSym && rootSym.flags & ts.SymbolFlags.Alias) {
        rootSym = lowerer.checker.getAliasedSymbol(rootSym);
      }
      const kind = rootSym ? nsSymbolRuntimeKind(lowerer, rootSym) : null;
      if (kind === "typeOnly" || kind === "ambient") {
        const loc = locOf(stmt);
        return {
          kind: "exprStmt",
          expr: nsUndefRead(lowerer, root.text, stmt, F64),
          loc,
        };
      }
    }
  }
  const nameSym = lowerer.checker.getSymbolAtLocation(stmt.name);
  const aliasG = nameSym ? lowerer.globalsBySymbol.get(nameSym) : undefined;
  if (nameSym && aliasG) {
    // The snapshot assignment. The target is a mutable binding with its
    // own module global (a namespace `export var` member, a top-level
    // var reached through an alias chain); a target whose declaration
    // never registered storage takes the blocked-binding cascade.
    const target = lowerer.checker.getAliasedSymbol(nameSym);
    const targetG = lowerer.globalsBySymbol.get(target);
    if (!targetG) {
      lowerer.rejectUnresolvedSymbol(
        target,
        stmt.name.text,
        stmt.name,
        `the alias target of '${stmt.name.text}' (no lowered storage)`,
      );
    }
    const loc = locOf(stmt);
    return {
      kind: "assign",
      localId: aliasG.id,
      value: { kind: "varRef", localId: targetG.id, type: targetG.type, loc },
      loc,
    };
  }
  return null;
}

/** The bare-identifier fence for namespace objects used as VALUES: the
 * namespace has no first-class runtime object here — members lower at
 * their qualified access sites. Ambient namespaces compile to Node's
 * ReferenceError instead when the use site's type maps (the object never
 * exists at runtime). Returns null when `ident` is not a namespace
 * reference at all. */
export function lowerNsIdentifierValue(lowerer: Lowerer, ident: ts.Identifier): IrExpr | null {
  const sym = lowerer.resolveValueSymbol(ident);
  if (!sym || !(sym.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule))) {
    return null;
  }
  if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.RegularEnum | ts.SymbolFlags.ConstEnum | ts.SymbolFlags.Variable)) {
    return null; // merged with a value declaration — its own paths and fences apply
  }
  const ambientRoot = ambientNsRootOf(lowerer, ident);
  if (ambientRoot !== null) {
    const t = ambientUndefReadType(lowerer, ident);
    if (t) return nsUndefRead(lowerer, ambientRoot.text, ident, t);
  }
  if (lowerer.isStdlibSymbol(sym)) return null; // stdlib namespaces keep their chokepoints
  // A MODULE namespace object as a first-class value (`import * as ns`
  // passed/stored/iterated): member accesses resolve statically, but the
  // object itself has no runtime representation — Node's frozen,
  // alphabetically-keyed namespace object is not materialized. Named
  // residual of the SC1013 lowering.
  if (moduleNsSourceFileOf(lowerer, ident) !== null) {
    lowerer.unsupported(
      "SC1013",
      ident,
      `module namespace objects as first-class values (access '${ident.text}' members directly: ${ident.text}.<member>)`,
    );
  }
  lowerer.unsupported(
    "SC1090",
    ident,
    `namespace objects as first-class values (access '${ident.text}' members directly: ${ident.text}.<member>)`,
  );
}
