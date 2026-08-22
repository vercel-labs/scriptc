/* Mixin heritage: `class D extends Serializable(Base)` and the
 * `Constructor<T>`-parameterized mixin-function pattern, monomorphized per
 * call site.
 *
 * The honest static mixin is a function whose parameter and return are
 * class values with statically-traceable flow:
 *
 *     function Tagged<T extends Ctor>(Base: T) {
 *       class C extends Base { ... }
 *       return C;
 *     }
 *
 * Called with a concrete program class, the class inside the mixin
 * instantiates PER CALL SITE — its heritage is the ARGUMENT class, its
 * members lower under the mixin's type-parameter binding (T → the
 * argument's classval), and the call expression's value is the
 * instantiation's immortal class object (classRef). Everything downstream
 * rides the classval machinery unchanged: `new` through the value,
 * instanceof against the result and against every base (interval nesting
 * through the monomorphized chain), statics, `extends` of the result.
 *
 * Keying by CALL SITE (position-derived `%mx<start>.<name>` names, the
 * class-expression trick) is what makes one immortal class object exact:
 * each supported call position evaluates exactly once, so JS's
 * fresh-class-per-call semantics collapses to one class per site. Calls
 * inside functions or class members would mint a distinct class per
 * evaluation and are named fences.
 *
 * Named fences (never silent divergence): mixin functions whose base
 * parameter flow isn't traceable (the parameter referenced anywhere but
 * the extends clause, extra statements in the body), mixins over builtin
 * or decorated or generic-family classes, calls whose argument isn't
 * statically one program class, mixin calls inside functions/members, and
 * statics-bearing mixin classes outside a plain top-level statement
 * (their declaration-time code must run exactly where the call
 * evaluates). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { IrType } from "../../ir/nodes.js";
import { ClassInfo, builtinStreamInfoOf, exactClassOfReceiver, propertyAssignedClassInfoOf } from "./lower-classes.js";

/** A recognized mixin function: one base-class parameter, a body that
 * defines and returns exactly one class extending that parameter, and no
 * other use of the parameter (statically-traceable flow). */
export interface MixinFnShape {
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  /** The base parameter's symbol (referenced exactly once: the extends
   * clause of `classNode`). */
  paramSym: ts.Symbol;
  /** The base parameter's declared type when it names one of the mixin's
   * OWN type parameters — bound to the argument's classval per
   * instantiation so member types written in T resolve. */
  paramTypeParam: ts.Symbol | null;
  /** The class the mixin mints per call (an anonymous expression or the
   * returned local declaration). */
  classNode: ts.ClassLikeDeclaration;
  /** Source name for diagnostics. */
  name: string;
}

/** Mixin-instantiation state hung off the instantiation's ClassInfo (the
 * mixin twin of genericInstance). */
export interface MixinInstanceInfo {
  /** The call site that minted this instantiation. */
  call: ts.CallExpression;
  /** T → the argument class's classval, for member lowering (the
   * generic-instance typeParamResolver mechanism). */
  bindings: Map<ts.Symbol, IrType>;
  /** Diagnostic context appended to every fence inside the instantiation. */
  context: string;
  /** Demand ordinal per class node — only the first instantiation counts
   * statements toward coverage (the generic-instance rule). */
  ordinal: number;
  /** The constructor is the forwarding shape (`constructor(...args) {
   * super(...args); … }`): the instantiation's ABI is the base's, the
   * synthetic params forward to super directly, and the rest parameter
   * never materializes. */
  forwardingCtor?: boolean;
  /** Static fields/blocks exist: their %init statements emit positionally
   * in this file's init, at the top-level statement containing the call —
   * exactly when JS evaluates them (lowerFileInit's merge). */
  statics?: { sf: ts.SourceFile; pos: number };
}

/** Strips parentheses. */
function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** The class a mixin FUNCTION's body defines and returns, with every
 * traceability requirement checked — null when the function is not a
 * (supported) mixin. Cached per function node; recognition is pure (no
 * diagnostics, no registration), so a null answer simply leaves the call
 * to the generic/direct machinery and ITS fences. */
export function mixinFnShapeOf(
  L: Lowerer,
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): MixinFnShape | null {
  const cached = L.mixinFnShapes.get(fn);
  if (cached !== undefined) return cached;
  const shape = mixinFnShapeInner(L, fn);
  L.mixinFnShapes.set(fn, shape);
  return shape;
}

function mixinFnShapeInner(
  L: Lowerer,
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): MixinFnShape | null {
  if (fn.asteriskToken) return null;
  if (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if (fn.parameters.length !== 1) return null;
  const p = fn.parameters[0]!;
  if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) return null;
  const paramSym = L.checker.getSymbolAtLocation(p.name);
  if (!paramSym || !fn.body) return null;

  // The body must define-and-return exactly one class: an arrow whose
  // expression body IS the class, `{ return class … }`, or `{ class C …
  // return C; }`. Anything else (extra statements — side effects we would
  // not execute) disqualifies.
  let classNode: ts.ClassLikeDeclaration | null = null;
  if (!ts.isBlock(fn.body)) {
    const e = unparen(fn.body);
    if (ts.isClassExpression(e)) classNode = e;
  } else {
    const stmts = fn.body.statements;
    if (stmts.length === 1 && ts.isReturnStatement(stmts[0]!) && stmts[0]!.expression) {
      const e = unparen(stmts[0]!.expression!);
      if (ts.isClassExpression(e)) classNode = e;
    } else if (
      stmts.length === 2 &&
      ts.isClassDeclaration(stmts[0]!) &&
      stmts[0]!.name !== undefined &&
      ts.isReturnStatement(stmts[1]!) &&
      stmts[1]!.expression !== undefined
    ) {
      const ret = unparen(stmts[1]!.expression!);
      if (ts.isIdentifier(ret)) {
        const clsSym = L.checker.getSymbolAtLocation(stmts[0]!.name!);
        if (clsSym && L.checker.getSymbolAtLocation(ret) === clsSym) classNode = stmts[0]!;
      }
    }
  }
  if (!classNode) return null;
  // A generic class would mint a FAMILY per call; decorators are
  // declaration-time calls with per-evaluation semantics — both
  // disqualify (decorator-composed mixins are a named non-goal).
  if (classNode.typeParameters) return null;
  const mods = (classNode as { modifiers?: readonly ts.Node[] }).modifiers ?? [];
  if (mods.some((m) => m.kind === ts.SyntaxKind.Decorator)) return null;

  // Heritage: exactly `extends <the parameter>`.
  const clauses = classNode.heritageClauses ?? [];
  if (clauses.length !== 1 || clauses[0]!.token !== ts.SyntaxKind.ExtendsKeyword) return null;
  const types = clauses[0]!.types;
  if (types.length !== 1) return null;
  const t = types[0]!;
  if (t.typeArguments || !ts.isIdentifier(t.expression)) return null;
  if (L.checker.getSymbolAtLocation(t.expression) !== paramSym) return null;

  // The parameter's flow must be fully traceable: the extends clause is
  // its ONE reference (a parameter that is stored, compared, reassigned,
  // or read inside members is dynamic base flow).
  let extraRef = false;
  ts.walkPreorder(fn.body, (n) => {
    if (n === t.expression) return undefined;
    if (ts.isIdentifier(n) && n.text === p.name.getText() && L.checker.getSymbolAtLocation(n) === paramSym) {
      extraRef = true;
      return "stop";
    }
    return undefined;
  });
  if (extraRef) return null;

  // The parameter's own type parameter, when it has one (`<T extends
  // Ctor>(Base: T)`): instantiations bind it to the argument's classval.
  let paramTypeParam: ts.Symbol | null = null;
  if (p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName)) {
    const refSym = L.checker.getSymbolAtLocation(p.type.typeName);
    if (
      refSym &&
      fn.typeParameters?.some((tp) => L.checker.getSymbolAtLocation(tp.name) === refSym)
    ) {
      paramTypeParam = refSym;
    }
  }

  const name = (ts.isFunctionDeclaration(fn) ? fn.name?.text : undefined) ??
    (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
      ? fn.parent.name.text
      : "%anon");
  return { fn, paramSym, paramTypeParam, classNode, name };
}

/** The mixin function a CALLEE expression names, or null: an identifier
 * resolving to a single function declaration or a const binding holding
 * an arrow/function expression (never-reassigned by constness), whose
 * shape qualifies. */
export function mixinFnOfCallee(L: Lowerer, callee: ts.Expression): MixinFnShape | null {
  if (!ts.isIdentifier(callee)) return null;
  // A shadowing local owns the name (heritage-time demands have no
  // function context — nothing can shadow at collection). peekLocal: this
  // is a probe, and probes must not thread capture state (resolveLocal's
  // side effect — an ICE through a non-lifted enclosing function).
  if (L.fnStack.length > 0 && L.peekLocal(callee)) return null;
  // Recognition is a side-effect-free PROBE (it runs on every candidate
  // call/binding/reference): resolve without resolveValueSymbol's
  // deferred-diagnostic flush — a non-mixin callee's own paths flush when
  // THEY resolve it.
  let sym = L.checker.getSymbolAtLocation(callee) ?? null;
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
  if (!sym) return null;
  const decls = L.checker.declarationsOf(sym);
  if (decls.length !== 1 || decls[0] === undefined) return null; // overloads / merged declarations
  const d = decls[0];
  if (ts.isFunctionDeclaration(d)) return mixinFnShapeOf(L, d);
  if (ts.isVariableDeclaration(d)) {
    const fn = mixinFnNodeOfBinding(d);
    return fn ? mixinFnShapeOf(L, fn) : null;
  }
  return null;
}

/** The arrow/function-expression initializer of a CONST binding — the
 * value-binding spelling of a mixin function declaration. */
function mixinFnNodeOfBinding(
  decl: ts.VariableDeclaration,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  if (
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const init = unparen(decl.initializer);
  return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
}

/** True when this variable declaration is a recognized mixin FUNCTION
 * binding (`const M = (Base: T) => class extends Base {…}`): no global
 * exists (the binding is never read as a value; calls instantiate per
 * site), and both collectGlobals and the statement lowering skip it by
 * this test. */
export function isMixinFnBinding(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  const fn = mixinFnNodeOfBinding(decl);
  return fn !== null && mixinFnShapeOf(L, fn) !== null;
}

/** The class a mixin ARGUMENT statically names, with every unsupported
 * argument shape a named fence (recognition already established the call
 * is a mixin call — from here failures are honest diagnostics, never a
 * fallthrough to a wronger message). */
function mixinBaseClassOf(L: Lowerer, arg: ts.Expression): ClassInfo {
  const e = unparen(arg);
  // A nested mixin call: `Tagged(Printable(Derived))` — the inner
  // instantiation is the outer's base (instantiated first, exactly JS's
  // argument-before-call order).
  if (ts.isCallExpression(e)) {
    const inner = mixinCallClassInfoOf(L, e);
    if (inner) return inner;
    L.unsupported(
      "SC1090",
      arg,
      "mixin arguments that are calls of anything but another mixin function (the base class must be statically known)",
    );
  }
  // A class expression argument: `Tagged(class { … })` — collected like
  // any expression class (its own position fences apply).
  if (ts.isClassExpression(e)) return checkedMixinBase(L, arg, L.lowerClassExpressionInfo(e));
  if (ts.isIdentifier(e)) {
    const sym = L.resolveValueSymbol(e);
    const builtin = L.builtinErrorInfoOf(sym) ?? L.builtinEmitterInfoOf(sym) ?? builtinStreamInfoOf(L, sym);
    if (builtin) {
      L.unsupported(
        "SC1090",
        arg,
        `mixins over the builtin class '${e.text}' (its construction is libCall-shaped — only program classes compose)`,
      );
    }
    const direct = (sym ? L.classBySymbol.get(sym) : undefined) ??
      propertyAssignedClassInfoOf(L, sym) ??
      exactClassOfReceiver(L, e) ??
      // A const holding a mixin RESULT declared earlier (`const A = M(B);
      // class D extends M2(A) {}`): the binding pins that call's
      // instantiation — collected on demand, registered so every later
      // path answers like a declaration (collectGlobals does the same).
      mixinResultBindingClassOf(L, sym);
    if (direct) return checkedMixinBase(L, arg, direct);
  }
  L.unsupported(
    "SC1090",
    arg,
    "mixin arguments that are not statically one program class (the compiled mixin monomorphizes per concrete base)",
  );
}

/** Argument classes the classval story cannot carry compose-fences. */
function checkedMixinBase(L: Lowerer, blame: ts.Node, info: ClassInfo): ClassInfo {
  if (info.builtinError || info.builtinEmitter || info.builtinStream) {
    L.unsupported(
      "SC1090",
      blame,
      `mixins over the builtin class '${info.def.jsName || info.def.name}' (its construction is libCall-shaped — only program classes compose)`,
    );
  }
  if (info.generic) {
    L.unsupported(
      "SC1090",
      blame,
      "mixins over a generic class family (pass a concrete class)",
    );
  }
  if (info.classDecorators?.valueGlobalId !== undefined) {
    L.unsupported(
      "SC1090",
      blame,
      "mixins over a decorated class (its decorators may replace it — the runtime base would be the decoration result)",
    );
  }
  return info;
}

/** A const binding whose initializer is a mixin call: the binding pins
 * exactly that instantiation. Registers classBySymbol on success so every
 * downstream path (construction, statics, extends, instanceof, reads)
 * answers like a declaration from then on. */
export function mixinResultBindingClassOf(
  L: Lowerer,
  sym: ts.Symbol | null | undefined,
): ClassInfo | null {
  if (!sym) return null;
  const decls = L.checker.declarationsOf(sym);
  if (decls.length !== 1 || decls[0] === undefined || !ts.isVariableDeclaration(decls[0])) return null;
  const decl = decls[0];
  if (
    !ts.isIdentifier(decl.name) || decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const init = unparen(decl.initializer);
  if (!ts.isCallExpression(init)) return null;
  const info = mixinCallClassInfoOf(L, init);
  if (info) L.classBySymbol.set(sym, info);
  return info;
}

/** The heart: the ClassInfo a mixin CALL mints — one instantiation per
 * call site, cached by node (idempotent across the discovery/emit passes'
 * repeated demands from heritage clauses, const bindings, and the call
 * expression's own lowering). Null when the callee is NOT a mixin
 * function (the caller's own machinery and fences answer); every failure
 * PAST recognition is a named diagnostic + poison. */
export function mixinCallClassInfoOf(L: Lowerer, call: ts.CallExpression): ClassInfo | null {
  const cached = L.mixinInstanceByCall.get(call);
  if (cached !== undefined) {
    if (cached === null) {
      // The first demand's diagnostics may have deferred under a class
      // symbol nothing flushed — this site still needs a hard answer.
      L.unsupported(
        "SC1090",
        call,
        "this mixin call (its instantiation failed to collect — see the instantiation's own diagnostics)",
      );
    }
    return cached;
  }
  const shape = mixinFnOfCallee(L, call.expression);
  if (!shape) return null;
  try {
    const info = instantiateMixinCall(L, call, shape);
    L.mixinInstanceByCall.set(call, info);
    return info;
  } catch (e) {
    if (e instanceof PoisonError) L.mixinInstanceByCall.set(call, null);
    throw e;
  }
}

function instantiateMixinCall(L: Lowerer, call: ts.CallExpression, shape: MixinFnShape): ClassInfo {
  // Reentrancy backstop: a cyclic base chain through const bindings would
  // re-enter its own instantiation (the tsc gate rejects the cycles it
  // sees; this turns anything it misses into a diagnostic, the
  // class-expression rule).
  if (L.mixinCollectingCalls.has(call)) {
    L.unsupported("SC1090", call, "mixin calls whose base chain re-enters their own instantiation (a cyclic extends)");
  }
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
    L.unsupported("SC1090", call, "mixin calls with anything but exactly one direct class argument");
  }
  // Evaluation-position fence: one immortal class object is exact only
  // for once-evaluated calls. Function bodies (and class members) may run
  // any number of times; a class ancestor is legal exactly when the path
  // enters through its heritage clause (the extends expression of a
  // once-evaluated declaration).
  let prev: ts.Node = call;
  for (let p: ts.Node = call.parent; !ts.isSourceFile(p); prev = p, p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) {
      L.unsupported(
        "SC1090",
        call,
        "mixin calls inside functions (each call mints a DISTINCT class in JS — call the mixin at top level and bind or extend the result)",
      );
    }
    if ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && !ts.isHeritageClause(prev)) {
      L.unsupported(
        "SC1090",
        call,
        "mixin calls inside class members (they evaluate per instance/access — call the mixin at top level)",
      );
    }
  }

  const base = mixinBaseClassOf(L, call.arguments[0]!);
  const instName = L.qualify(
    call.getSourceFile(),
    `%mx${call.getStart()}.${shape.classNode.name?.text ?? ""}`,
  );
  const ordinal = L.mixinOrdinals.get(shape.classNode) ?? 0;
  L.mixinOrdinals.set(shape.classNode, ordinal + 1);
  const bindings = new Map<ts.Symbol, IrType>();
  if (shape.paramTypeParam) {
    bindings.set(shape.paramTypeParam, { kind: "classval", className: base.def.name });
  }
  const context = `instantiating mixin '${shape.name}' over '${base.def.jsName || base.def.name}'`;
  const prevBindings = L.typeParamBindings;
  const prevContext = L.instantiationContext;
  const prevMixinCtx = L.mixinTypeContext;
  L.typeParamBindings = bindings;
  L.instantiationContext = context;
  L.mixinTypeContext = { classNode: shape.classNode, className: instName };
  L.mixinCollectingCalls.add(call);
  try {
    L.collectClassShapeInner(shape.classNode, undefined, undefined, {
      base,
      name: instName,
      call,
      bindings,
      context,
      ordinal,
    });
  } finally {
    L.typeParamBindings = prevBindings;
    L.instantiationContext = prevContext;
    L.mixinTypeContext = prevMixinCtx;
    L.mixinCollectingCalls.delete(call);
  }
  const info = L.classes.get(instName);
  if (!info) throw new PoisonError(); // collection poisoned and reported
  // Members lower in the shared monomorphization fixpoint (demand-driven,
  // like generic-class instantiations — never wantBody-gated).
  L.genericClassInstances.push(info);
  L.onLateClassCollected?.(info);
  // Pinned-position instantiations join the intersection resolver's
  // registry (mixinIntersectionInstanceType).
  if (pinnedMixinCallPosition(call)) {
    const list = L.mixinInstancesByClassNode.get(shape.classNode) ?? [];
    list.push(info);
    L.mixinInstancesByClassNode.set(shape.classNode, list);
  }

  // Statics are declaration-time code: they run when THIS call evaluates.
  // The supported positions put that point at one top-level statement of
  // the call's file — lowerFileInit's positional merge emits them there
  // (before the statement; every allowed shape evaluates nothing
  // observable ahead of the call). Anything subtler is a named fence,
  // never a reordering.
  if (info.staticFields.length > 0 || (info.staticBlocks?.length ?? 0) > 0) {
    const holder = staticsEvalStatementOf(call);
    if (!holder) {
      L.unsupported(
        "SC1090",
        call,
        "mixin classes with static members outside a plain top-level position (their declaration-time code must run exactly where the call evaluates — bind the result in its own top-level `const X = M(Base)` statement, or extend the call directly in a top-level class declaration)",
      );
    }
    if (info.mixinInstance) {
      info.mixinInstance.statics = { sf: call.getSourceFile(), pos: holder.getStart() };
    }
  }
  return info;
}

/** MIXIN instance intersections — `Tagged.C & Derived`, the checker's
 * type for values built THROUGH a mixin result (`new Thing1(...)` — the
 * inner class node is one shared AST, so its bare reference cannot name a
 * call site). The chain structure disambiguates: the intersection lists
 * the head class plus every mixin layer and the concrete base(s) below
 * it, so an instantiation matches exactly when its mixin-instance
 * ancestors' class NODES are the other mixin parts' nodes (multiset) and
 * every plain-class part sits in its base chain. A unique match answers
 * that instantiation's object type — layout-true by construction (same
 * source, same base chain). Anything ambiguous (two same-shaped
 * instantiations — where picking one could mis-devirtualize against the
 * other's subtree) stays honestly unmapped, and the per-site SC2008
 * names the type. Only instantiations from PINNED positions (const
 * bindings, heritage clauses) participate: they are registered before
 * any body lowers in BOTH passes, so discovery and emit answer alike. */
export function mixinIntersectionInstanceType(L: Lowerer, widened: ts.Type): IrType | null {
  const parts = widened.isIntersectionType() ? ts.constituentTypes(widened) : null;
  if (!parts || L.mixinInstancesByClassNode.size === 0) return null;
  const mixinParts: ts.ClassLikeDeclaration[] = [];
  const plainParts: string[] = [];
  for (const part of parts) {
    const sym = part.getSymbol();
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    const node =
      decl && (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) &&
      L.mixinInstancesByClassNode.has(decl)
        ? decl
        : null;
    if (node) {
      // The STATIC side of a mixin class in an intersection (a construct
      // signature) is not an instance part — decline the whole shape.
      if (L.checker.getConstructSignatures(part).length > 0) return null;
      mixinParts.push(node);
      continue;
    }
    const mapped = L.mapTypeOf(part);
    if (mapped?.kind !== "object") return null;
    plainParts.push(mapped.className);
  }
  if (mixinParts.length === 0) return null;
  // Try each mixin part as the HEAD (the most-derived layer): a candidate
  // instantiation of its node matches when the OTHER mixin parts' nodes
  // are exactly its mixin ancestors' nodes and the plain parts all sit in
  // its chain.
  const matches: ClassInfo[] = [];
  for (let h = 0; h < mixinParts.length; h++) {
    const restNodes = mixinParts.filter((_, i) => i !== h);
    for (const cand of L.mixinInstancesByClassNode.get(mixinParts[h]!) ?? []) {
      // The candidate's structure: its mixin ancestors' class NODES, and
      // the plain classes ANCHORING each mixin layer (the direct base
      // where a layer sits on a named class) — exactly what the checker
      // flattens into the intersection, so both sides must agree exactly
      // (`Audited & Linked & Node2` matches the Node2-anchored chain, not
      // the Fussy-anchored one whose deeper chain merely CONTAINS Node2).
      const ancestorNodes: ts.ClassLikeDeclaration[] = [];
      const anchors = new Set<string>();
      for (let c: ClassInfo | null = cand; c; c = c.base) {
        if (!c.mixinInstance) break;
        if (c !== cand && c.decl) ancestorNodes.push(c.decl);
        if (c.base && !c.base.mixinInstance) anchors.add(c.base.def.name);
      }
      if (ancestorNodes.length !== restNodes.length) continue;
      const pool = [...ancestorNodes];
      const multisetEq = restNodes.every((n) => {
        const i = pool.indexOf(n);
        if (i < 0) return false;
        pool.splice(i, 1);
        return true;
      });
      if (!multisetEq) continue;
      const plainSet = new Set(plainParts);
      if (plainSet.size !== anchors.size || ![...plainSet].every((c) => anchors.has(c))) continue;
      if (!matches.includes(cand)) matches.push(cand);
    }
  }
  return matches.length === 1 ? { kind: "object", className: matches[0]!.def.name } : null;
}

/** True when a mixin call sits in a PINNED position — a const binding's
 * initializer or a heritage clause (possibly through other mixin-call
 * argument slots): such instantiations register before any body lowers in
 * both passes, so the intersection resolver above may name them without
 * discovery/emit drift. */
function pinnedMixinCallPosition(call: ts.CallExpression): boolean {
  let n: ts.Node = call;
  for (let p: ts.Node = n.parent; !ts.isSourceFile(p); n = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p)) continue;
    if (ts.isCallExpression(p) && p.arguments.length === 1 && p.arguments[0] === n) continue;
    if (ts.isVariableDeclaration(p) && p.initializer === n) {
      return ts.isVariableDeclarationList(p.parent) && (p.parent.flags & ts.NodeFlags.Const) !== 0;
    }
    return ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent);
  }
  return false;
}

/** The top-level statement whose evaluation IS a statics-bearing mixin
 * call's evaluation point, or null: the path from the call to the source
 * file may cross only parens, enclosing mixin-call argument positions,
 * a sole-declarator top-level variable statement, a bare expression
 * statement, or a top-level class declaration's heritage clause. */
function staticsEvalStatementOf(call: ts.CallExpression): ts.Statement | null {
  let n: ts.Node = call;
  for (let p: ts.Node = n.parent; ; n = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p)) continue;
    if (ts.isCallExpression(p) && p.arguments.length === 1 && p.arguments[0] === n) continue;
    if (
      ts.isVariableDeclaration(p) && p.initializer === n &&
      ts.isVariableDeclarationList(p.parent) && p.parent.declarations.length === 1 &&
      ts.isVariableStatement(p.parent.parent) && ts.isSourceFile(p.parent.parent.parent)
    ) {
      return p.parent.parent;
    }
    if (ts.isExpressionStatement(p) && ts.isSourceFile(p.parent)) return p;
    if (ts.isExpressionWithTypeArguments(p) || ts.isHeritageClause(p)) continue;
    if (ts.isClassDeclaration(p) && ts.isSourceFile(p.parent) && ts.isHeritageClause(n)) return p;
    return null;
  }
}
