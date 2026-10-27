import { shapeOverlayAnnotated } from "../shape-inference/index.js";
import { documentedParameter } from "./call-signatures.js";
import { staticNameBindings } from "./static-function-names.js";
import { positionTag } from "./structural-positions.js";
import { keyedHelperName } from "./stable-names.js";
import * as ts from "../ts7/adapter.js";
import { heritageElementTarget, isHeritageTypeReference } from "../heritage-elements.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import type { Lowerer } from "./lowerer.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
  STRING,
  VOID,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { helperLoc, nodeThrowExpr } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import { typeKey } from "../type-mapper.js";
import { functionCanReturnUndefined } from "../function-completion.js";
import { PoisonError, dynFallbackType, neverTaintedJsType, newFnCtx } from "./lowerer.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { findGenericMethodOn, storedClassValueType, type ClassInfo } from "./lower-classes.js";
import { nsPathPrefix } from "./lower-namespaces.js";
import { declSymbolOf } from "./lower-modules.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { rejectStaticThis } from "./static-this.js";
import { isVarDeclared, jsBindingHasOpenWrites } from "./lower-stmts.js";
import {
  type ParamShape,
  paramShapes,
  generatorMeta,
  funcTypeFromParamShapes,
} from "./call-signatures.js";
import {
  fenceGenericSignatureResult,
  blockBodyOf,
  resolveInferredReturn,
  appendImplicitUndefinedReturn,
  hasExplicitJsDocReturn,
  promiseCarriesDyn,
} from "./function-returns.js";
import { bindingNeverReassigned, stripValueWrappers } from "./binding-analysis.js";
import {
  extendInstantiationPath,
  MAX_INSTANTIATION_RECURSION,
  type InstantiationPath,
} from "./instantiation-path.js";

/** A generic function-like declaration, collected instead of an FnSig —
 * top-level generic function declarations, class GENERIC METHODS (own type
 * parameters, instance and static), and object-literal generic methods.
 * The body is NOT lowered at collection: each call site's checker-resolved
 * signature (type arguments substituted) becomes an instantiation key, and
 * the body is lowered once per distinct key (monomorphization). */
export interface GenericFnInfo {
  decl: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;
  /** Unqualified source name, for diagnostics. */
  baseName: string;
  /** Program-wide qualified name; instance `n` is named `<qualified>%<n>`
   * ('%' cannot appear in a TS identifier, so instance names can never
   * collide with user functions). */
  qualifiedName: string;
  /** Declaration-order type parameter symbols. */
  typeParams: ts.Symbol[];
  /** Lazily computed (keyofConstrainedTypeParams): the type parameters
   * declared `K extends keyof …`. Their bound LITERAL keys are semantic —
   * the body's `o[k]` reads the named field — so instances key on the
   * literal (no cross-literal sharing) and keep the checker types
   * (tsBindings) the body resolves through. */
  keyofTps?: Set<ts.Symbol>;
  /** Instantiation key (comma-joined typeKeys of the mapped param types +
   * `=>` + return typeKey) → instance. Key identity IS signature identity:
   * two call sites whose inferred types map to the same IR types share one
   * native function. */
  instances: Map<string, GenericInstance>;
  /** CLASS-member generic methods: the declaring ClassInfo and flavor.
   * Instance methods take `this` (object:<declarer>) as param 0 and lower
   * under the declarer's instantiation bindings (generic-class receivers)
   * MERGED with the method instantiation's own; statics lower as plain
   * module functions with an exact receiver or the this/super fence. Absent for
   * top-level functions and object-literal methods. */
  member?: { cls: ClassInfo; kind: "method" | "static" };
  /** Direct static calls specialize lexical this for the proven receiver. */
  staticReceiver?: ClassInfo;
  receiverSpecializations?: Map<string, GenericFnInfo>;
  /** Object-literal generic methods (`{ m<T>(x: T) {...} }` and generic
   * arrow/function-expression properties): lowered as plain module
   * functions — `this` inside is fenced (rejectThisInObjectMethod) and the
   * defining literal must sit at module scope (no enclosing frame to
   * capture). */
  objectLiteral?: true;
  /** A binding declared inside a function: each evaluation of the
   * declaration makes a new function object in JavaScript, while the
   * compiled instances are shared module functions, so only calls lower. */
  functionScoped?: true;
  /** The declaration of a generic arrow/function-expression binding. */
  bindingDecl?: ts.VariableDeclaration;
  /** A module-scope binding that code can use before its declaration
   * runs: the BOOL global its declaration sets, and whether it is a
   * `let`/`const` (a temporal dead zone) or a `var` (undefined). */
  presence?: { flagId: string; lexical: boolean };
  /** genericValueForwarder's lifted functions, by instance name. */
  valueForwarders?: Map<string, string>;
  /** runsAfterDeclaration's answers for the function declarations whose
   * calls it placed. */
  ordering?: Map<ts.Node, boolean>;
  /** IMPLICIT-ANY monomorphization (npm-static JS): parallel to
   * decl.parameters — the param's own symbol when the slot is a BINDABLE
   * implicit-any parameter (untyped, identifier-named, never written in
   * the body), null for typed or unbindable slots. Present ⇔ this info
   * monomorphizes over its implicit-any params instead of declared type
   * parameters (typeParams stays empty): each call site's WIDENED argument
   * checker types key an instantiation, exactly the generic machinery —
   * the untyped params ARE the type parameters (see implicitCallInstance). */
  implicitParams?: (ts.Symbol | null)[];
  /** Implicit-any monomorphization of destructured object parameters
   * (implicitPatternsOf): parallel to decl.parameters, the destructured
   * names where the slot binds the call site's object type. Computed on
   * first use. */
  implicitPatterns?: (ImplicitPattern | null)[];
  /** Parameter index → symbol for the function parameters whose `.name`
   * the body reads (static-function-names.ts); computed on first use. */
  nameReadParams?: Map<number, ts.Symbol>;
}

export interface GenericInstance {
  path: InstantiationPath;
  name: string;
  /** 0 for the first instance of a base function — the only one whose
   * statements count toward coverage stats (re-instantiations re-visit the
   * same source lines). */
  ordinal: number;
  params: ParamShape[];
  returnType: IrType;
  /** Type-parameter symbol → concrete IR type, consulted by mapType (via
   * typeParamResolver) while the instance body lowers. */
  bindings: Map<ts.Symbol, IrType>;
  /** Call-keyed instances: type-parameter symbol → the bound CHECKER type
   * (pre-widening), consulted while the body lowers where the IrType
   * binding has already lost what the body needs — `T[K]` and `o[k]` reads
   * whose K is bound to one literal key (typeParamTsBindings). */
  tsBindings?: Map<ts.Symbol, ts.Type>;
  /** Rendered type arguments ("<number, string>") for diagnostics. */
  typeArgsText: string;
  /** A factory returning one of its local classes through a declared
   * constructor type: that type (by id) and the class value it maps to
   * while the body lowers (Lowerer.instanceResultClass). */
  resultClass?: { declared: number; value: IrType };
  /** Implicit instances only: param symbol → the call site's (widened)
   * checker type, consulted by the Lowerer's typeOf while this instance's
   * body lowers (the implicit twin of `bindings`). */
  implicitArgTypes?: Map<ts.Symbol, ts.Type>;
  /** Implicit instances only: eager-lowering lifecycle. "lowering" while
   * the body builds (a re-demand is same-key recursion: the caller uses
   * the PINNED fallback returnType and returnPinned locks it); "done" once
   * returnType holds the inferred (or pinned) truth. */
  implicitState?: "lowering" | "done" | "failed";
  /** Same-key recursion observed the fallback return type mid-lowering, so
   * the ABI is locked to it — the return post-pass coerces every return
   * value to the pinned type instead of adopting the inferred one. */
  returnPinned?: boolean;
  /** Implicit instances only: the declared return did not map (the
   * any-params poisoned it) — the body lowers in return-INFERENCE mode
   * (returnType holds the DYN recursion pin until the post-pass settles). */
  implicitInferReturn?: true;
  /** An erased instance (every type parameter bound to `unknown`). */
  erased?: true;
  /** Name-keyed instances: function parameter → its call site's static
   * name (null when only known at run time), folded at `.name` reads. */
  staticFnNames?: Map<ts.Symbol, string | null>;
}

/** Defaults bind during inference; collection only resolves symbols in
 * declaration order and preserves each declaration form's diagnostic. */
function declaredTypeParameterSymbols(
  lowerer: Lowerer,
  parameters: readonly ts.TypeParameterDeclaration[],
  blame: ts.Node,
  detail: string,
): ts.Symbol[] {
  return parameters.map((parameter) => {
    const symbol = lowerer.checker.getSymbolAtLocation(parameter.name);
    if (!symbol) lowerer.unsupported("SC1090", blame, detail);
    return symbol;
  });
}

/** Pattern parameters are admitted by declarations and value bindings;
 * object-literal generic methods retain their identifier-only boundary. */
function checkGenericParameterNames(
  lowerer: Lowerer,
  parameters: readonly ts.ParameterDeclaration[],
  allowPatterns: boolean,
): void {
  for (const parameter of parameters) {
    if (
      !ts.isIdentifier(parameter.name) &&
      !(
        allowPatterns &&
        (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name))
      )
    ) {
      lowerer.unsupported("SC1031", parameter);
    }
  }
}

/** Static generic values must keep their initializer for their lifetime.
 * Merged var declarations count as writes even when the assignment scan
 * cannot see them; const bindings need no whole-file write scan. */
function requireStableGenericBinding(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  symbol: ts.Symbol,
  name: string,
): void {
  const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
  const redeclared = symbol.declarations.some(
    (d) => d !== decl && ts.isVariableDeclaration(d) && d.initializer !== undefined,
  );
  if (!isConst && (redeclared || !bindingNeverReassigned(lowerer, symbol, decl))) {
    lowerer.unsupported(
      "SC1090",
      decl.name,
      `generic function values in reassigned bindings (calls of '${name}' resolve statically against this initializer, so the binding must provably hold it — a const, or a let/var nothing in its declaring file writes)`,
    );
  }
}

/** Registers a top-level generic function. Only the SYNTAX is checked
 * here — parameter/return types mention the type parameters and cannot
 * map yet; the body is lowered per instantiation, on demand (an unused
 * generic function requires no body lowering). Called inside
 * collectSignature's poison catch. */
export function collectGenericSignature(lowerer: Lowerer, decl: ts.FunctionDeclaration): void {
  const typeParams = declaredTypeParameterSymbols(
    lowerer,
    decl.typeParameters!.nodes,
    decl,
    "this function form",
  );
  checkGenericParameterNames(lowerer, decl.parameters.nodes, true);
  const nameText = decl.name?.text ?? "%default"; // nameless = the default export (checked by collectSignatureInner)
  const symbol = declSymbolOf(lowerer, decl);
  if (!symbol) lowerer.unsupported("SC1090", decl, "this function form");
  lowerer.genericFnsBySymbol.set(symbol, {
    decl,
    baseName: nameText,
    qualifiedName: lowerer.qualify(
      ts.getSourceFileOfNode(decl),
      nsPathPrefix(lowerer, decl) + nameText,
    ),
    typeParams,
    instances: new Map(),
  });
}

export function genericFnOf(lowerer: Lowerer, ident: ts.Identifier): GenericFnInfo | null {
  const symbol = lowerer.resolveValueSymbol(ident);
  return symbol ? (lowerer.genericFnsBySymbol.get(symbol) ?? null) : null;
}

/** Call of a generic top-level function. The checker already inferred (or
 * was told, via explicit type arguments) the concrete signature —
 * getResolvedSignature returns it with type arguments substituted. The
 * mapped param+return IR types form the INSTANTIATION KEY; the first call
 * with a new key queues the body for monomorphic lowering as
 * `<qualifiedName>%<n>`, and every call lowers to a direct `call` of that
 * instance. */
export function lowerGenericCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  info: GenericFnInfo,
): IrExpr {
  const loc = locOf(expr);
  const instance = info.implicitParams
    ? implicitCallInstance(lowerer, expr, info)
    : genericCallInstance(lowerer, expr, info);
  const args = lowerer.completeArgs(expr.arguments.nodes, instance.params, loc, expr);
  const call: IrExpr & { kind: "call" } = {
    kind: "call",
    callee: instance.name,
    args,
    type: instance.returnType,
    loc,
  };
  return guardEarlyBindingCall(lowerer, info, expr, call);
}

/** The instance a CALL of a generic function-like names: resolved
 * signature → mapped param shapes/return → interned instance. Shared by
 * top-level generic calls, class generic-method calls (the caller
 * prepends the receiver), and object-literal generic-method calls. */
export function genericCallInstance(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  info: GenericFnInfo,
): GenericInstance {
  const rsig = lowerer.checker.getResolvedSignature(expr);
  // A GENERIC function with overload signatures: the call resolved to a
  // signature that is not the implementation's, so the per-instantiation
  // body lowering would type the body against parameter/return types it
  // was never checked under. Named fence until generic overloads get an
  // honest story (monomorphize per implementation signature with the
  // reconcile bridge, like the non-generic path).
  {
    const rdecl = rsig ? rsig.declaration : undefined;
    if (
      rsig &&
      rdecl &&
      (ts.isFunctionDeclaration(rdecl) || ts.isMethodDeclaration(rdecl)) &&
      !rdecl.body
    ) {
      const overload = overloadCallInstance(lowerer, expr, info, rsig, rdecl);
      if (overload) return overload;
      lowerer.unsupported(
        "SC1090",
        expr,
        `calls selecting an overload signature of a generic ${ts.isMethodDeclaration(rdecl) ? "method" : "function"} (only the implementation signature monomorphizes)`,
      );
    }
  }
  if (!rsig || rsig.getParameters().length !== info.decl.parameters.nodes.length) {
    lowerer.unsupported("SC1090", expr, "this call form");
  }
  // Per-param shapes from the RESOLVED signature (types substituted) plus
  // the declaration's modes: rest stays the resolved array, a default's
  // ABI union is synthesized over the resolved body type — exactly the
  // paramShape rules, applied to post-substitution types.
  const params = paramShapes(
    lowerer,
    info.decl.parameters.nodes,
    rsig,
    (_param, i) => expr.arguments.nodes[i] ?? expr,
  );
  const retTs = lowerer.checker.getReturnTypeOfSignature(rsig);
  const local = localClassResultInstance(lowerer, expr, info, rsig, params, retTs);
  if (local) return local;
  // A result instantiated at `any` (a type argument inferred from an
  // untyped value, such as an untyped forwarding call) is checked-dynamic,
  // and so is a JavaScript result whose JSDoc names a type the file never
  // declares or imports (`@returns {MiddlewareHandler<E>}` in a published
  // bundle): the checker's error type is documentation it could not
  // resolve, not a contract.
  const mappedReturn =
    lowerer.mapTypeOf(retTs) ??
    ((retTs.flags & ts.TypeFlags.Any) !== 0 &&
    (!isJsSourceFile(ts.getSourceFileOfNode(info.decl)) || retTs.isErrorType())
      ? DYN
      : null);
  if (!mappedReturn) {
    fenceGenericSignatureResult(lowerer, expr, retTs);
    lowerer.badType(expr, retTs);
  }
  const returnType = runtimeReturnType(lowerer, info, mappedReturn);

  // keyof-constrained type parameters (`K extends keyof T`): the bound
  // LITERAL is semantic — the instance body reads the named field — so
  // the bindings compute EAGERLY (the key needs them) and each literal
  // keys its own instance (`pick(o, "a")` and `pick(o, "b")` map to the
  // same IR signature when the fields agree, but their bodies read
  // different fields). Non-literal bindings (a key union, plain string)
  // share one runtime-keyed instance per IR signature, exactly the
  // widened discipline.
  const named = staticNameBindings(lowerer, expr, info);
  if (keyofConstrainedTypeParams(info).size > 0) {
    const tsBindings = new Map<ts.Symbol, ts.Type>();
    const bindings = lowerer.inferTypeParamBindings(expr, info, rsig, tsBindings);
    return internGenericInstance(lowerer, expr, info, params, returnType, () => bindings, {
      extraKey: `${keyofLiteralKey(info, tsBindings)}${named?.key ?? ""}`,
      tsBindings,
      ...(named ? { staticFnNames: named.names } : {}),
    });
  }
  return internGenericInstance(
    lowerer,
    expr,
    info,
    params,
    returnType,
    (tsBindings) => lowerer.inferTypeParamBindings(expr, info, rsig, tsBindings),
    named ? { extraKey: named.key, staticFnNames: named.names } : undefined,
  );
}

/** A call that resolved to an OVERLOAD signature of a generic function
 * or method with an implementation (`request<T>(p: WithHandler<T>):
 * Promise<T>; request(p: Plain): Promise<Res>; request<T>(p: Params<T>)
 * {...}`): the implementation monomorphizes under the bindings the
 * overload's resolved signature proves for its type parameters (the
 * structural unification every generic call uses, run against the
 * overload; unbound parameters take their declared defaults). The
 * instance's parameters and result are the IMPLEMENTATION's under those
 * bindings — the body was checked against them — and the call's
 * arguments and result coerce across, exactly as a non-generic overload
 * call reconciles with its implementation (parameters the overload omits
 * must be optional in the implementation). Null when the overload does
 * not belong to this implementation or the arities do not line up. */
function overloadCallInstance(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  info: GenericFnInfo,
  rsig: ts.Signature,
  rdecl: ts.FunctionDeclaration | ts.MethodDeclaration,
): GenericInstance | null {
  const impl = info.decl;
  if (
    rdecl.parent !== impl.parent ||
    rdecl.name === undefined ||
    impl.name === undefined ||
    rdecl.name.getText() !== impl.name.getText() ||
    rdecl.parameters.nodes.length > impl.parameters.nodes.length ||
    impl.parameters.nodes
      .slice(rdecl.parameters.nodes.length)
      .some((p) => p.questionToken === undefined && p.initializer === undefined) ||
    rdecl.parameters.nodes.some((p) => p.dotDotDotToken !== undefined)
  )
    return null;
  const declSig = lowerer.checker.getSignatureFromDeclaration(impl);
  if (!declSig) return null;
  const tsBindings = new Map<ts.Symbol, ts.Type>();
  const bindings = new Map<ts.Symbol, IrType>();
  unifySignatureBindings(lowerer, info, rsig, bindings, tsBindings);
  // Explicit type arguments name the OVERLOAD's type parameters, which
  // need not match the implementation's in order: the resolved overload
  // already carries them, so unification binds first, and an explicit
  // argument binds only a still-unbound implementation parameter of the
  // same name.
  const overloadTps = rdecl.typeParameters?.nodes ?? [];
  expr.typeArguments?.nodes.forEach((ta, i) => {
    const name = overloadTps[i]?.name.text;
    const tp = info.typeParams.find((p) => ts.symbolName(p) === name);
    if (!tp || bindings.has(tp)) return;
    const taT = lowerer.checker.getTypeFromTypeNode(ta);
    const mapped = lowerer.mapTypeOf(taT);
    if (mapped) {
      bindings.set(tp, mapped);
      tsBindings.set(tp, taT);
    }
  });
  bindDefaultTypeParams(lowerer, info.typeParams, impl.typeParameters?.nodes, bindings, tsBindings);
  // A type parameter the overload never mentions (a handler the overload
  // omits) is `unknown`, the checker's own answer for an uninferred one.
  for (const tp of info.typeParams) {
    if (bindings.has(tp)) continue;
    bindings.set(tp, DYN);
    tsBindings.set(tp, lowerer.checker.getUnknownType());
  }
  const previous = lowerer.typeParamBindings;
  const previousTs = lowerer.typeParamTsBindings;
  lowerer.typeParamBindings = bindings;
  lowerer.typeParamTsBindings = tsBindings;
  let params: ParamShape[];
  let returnType: IrType | null;
  try {
    params = paramShapes(
      lowerer,
      impl.parameters.nodes,
      declSig,
      (_param, i) => expr.arguments.nodes[i] ?? expr,
    );
    returnType = lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(declSig));
  } finally {
    lowerer.typeParamBindings = previous;
    lowerer.typeParamTsBindings = previousTs;
  }
  if (!returnType) return null;
  // keyof-constrained parameters key their instance on the bound literal,
  // as on the implementation-signature path.
  const runtimeReturn = runtimeReturnType(lowerer, info, returnType);
  return internGenericInstance(lowerer, expr, info, params, runtimeReturn, () => bindings, {
    ...(keyofConstrainedTypeParams(info).size > 0
      ? { extraKey: keyofLiteralKey(info, tsBindings) }
      : {}),
    tsBindings,
  });
}

/** An instance's result type: a body that can return an indexed read
 * that misses returns undefined there, as in JavaScript, whatever the
 * declared result says. An async body's promise is always present and
 * settles with undefined there. */
function runtimeReturnType(lowerer: Lowerer, info: GenericFnInfo, mapped: IrType): IrType {
  if (!lowerer.runtimeOptionalGenericReturns.has(info.decl)) return mapped;
  return mapped.kind === "promise"
    ? { kind: "promise", inner: lowerer.runtimeOptionalType(mapped.inner) }
    : lowerer.runtimeOptionalType(mapped);
}

/** A generic factory whose result is one of its own local classes
 * (`function base<T>(v: T) { return class { value: T = v }; }`). Each
 * instance has its own class, so the instance is keyed on its bindings and
 * the result maps inside it, where the local class takes the instance's
 * name and bindings. */
function localClassResultInstance(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  info: GenericFnInfo,
  rsig: ts.Signature,
  params: ParamShape[],
  retTs: ts.Type,
): GenericInstance | null {
  const resultClass = localClassOfResult(lowerer, info, retTs);
  if (!resultClass) return null;
  const tsBindings = new Map<ts.Symbol, ts.Type>();
  const bindings = lowerer.inferTypeParamBindings(expr, info, rsig, tsBindings);
  const bindingKey = info.typeParams
    .map((tp) => {
      const bound = bindings.get(tp);
      return bound ? typeKey(bound) : "?";
    })
    .join(",");
  const pending: IrType = { kind: "void" };
  const inst = internGenericInstance(lowerer, expr, info, params, pending, () => bindings, {
    extraKey: `@class<${bindingKey}>`,
    tsBindings,
  });
  if (inst.returnType !== pending) return inst;
  // A result typed by a declared constructor type rather than the class
  // (`Struct<S>`) is the class value of the local class the body returns.
  const declaredResult = info.decl.type
    ? lowerer.checker.getTypeFromTypeNode(info.decl.type)
    : undefined;
  const viaConstructorType = retTs.getSymbol()?.valueDeclaration !== resultClass;
  const returnType = withInstanceScope(lowerer, info, inst, () => {
    if (!viaConstructorType) return lowerer.mapTypeOf(retTs);
    // The local class's own constructor type: a class expression's type is
    // its constructor type, named or not (`return class { ... } as Struct<S>`).
    const classSymbol =
      !ts.isClassExpression(resultClass) && resultClass.name
        ? lowerer.checker.getSymbolAtLocation(resultClass.name)
        : undefined;
    const classType = ts.isClassExpression(resultClass)
      ? lowerer.checker.getTypeAtLocation(resultClass)
      : classSymbol
        ? lowerer.checker.getTypeOfSymbol(classSymbol)
        : undefined;
    return classType ? lowerer.mapTypeOf(classType) : null;
  });
  if (!returnType) {
    fenceGenericSignatureResult(lowerer, expr, retTs);
    lowerer.badType(expr, retTs);
  }
  inst.returnType = returnType;
  if (viaConstructorType && returnType.kind === "classval") {
    if (declaredResult) inst.resultClass = { declared: declaredResult.id, value: returnType };
    if (lowerer.typeParamBindings === null) lowerer.localClassValueTypes.set(retTs.id, returnType);
    return inst;
  }
  // Values of the class outside the factory (`const b = new B()`, `b.read()`)
  // carry the instantiated checker type; record which class it names. A
  // call inside another generic instance can have a type that depends on
  // that instance's parameters, which no single class answers.
  if (lowerer.typeParamBindings !== null) return inst;
  const instance =
    returnType.kind === "classval"
      ? lowerer.checker
          .getConstructSignatures(retTs)
          .map((sig) => lowerer.checker.getReturnTypeOfSignature(sig))
      : [retTs];
  const className =
    returnType.kind === "classval" || returnType.kind === "object" ? returnType.className : null;
  if (className !== null)
    for (const type of instance) lowerer.localClassInstanceTypes.set(type.id, className);
  return inst;
}

/** The class value a call of a generic factory returns when the result is
 * one of the factory's local classes (`class C extends base(42) {}`), or
 * null for any other call. */
export function genericLocalClassResult(lowerer: Lowerer, expr: ts.CallExpression): IrType | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  const info = lowerer.genericFnOf(expr.expression);
  if (!info || info.implicitParams) return null;
  const rsig = lowerer.checker.getResolvedSignature(expr);
  if (!rsig || !localClassOfResult(lowerer, info, lowerer.checker.getReturnTypeOfSignature(rsig)))
    return null;
  return genericCallInstance(lowerer, expr, info).returnType;
}

/** The type of a `const` binding whose initializer calls a generic factory
 * returning one of its local classes (`const B = base(7)`), or constructs
 * such a class (`const b = new B()`); null for any other binding. */
export function genericLocalClassBinding(lowerer: Lowerer, node: ts.Node): IrType | null {
  const decl = node.parent;
  if (
    !ts.isIdentifier(node) ||
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    decl.name !== node ||
    !decl.initializer ||
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0
  )
    return null;
  // An `any` binding keeps the checked-dynamic representation.
  if ((lowerer.typeOf(node).flags & ts.TypeFlags.Any) !== 0) return null;
  let init = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (ts.isCallExpression(init)) return genericLocalClassResult(lowerer, init);
  if (!ts.isNewExpression(init)) return null;
  const constructed = storedClassValueType(lowerer, init.expression);
  if (constructed?.kind !== "classval") return null;
  const classDecl = lowerer.classes.get(constructed.className)?.decl;
  return classDecl && insideGenericFunction(classDecl)
    ? { kind: "object", className: constructed.className }
    : null;
}

/** Whether `node` is declared inside a function with type parameters. */
function insideGenericFunction(node: ts.Node): boolean {
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent)
    if (ts.isFunctionLike(parent) && (parent.typeParameters?.nodes.length ?? 0) > 0) return true;
  return false;
}

/** The class declared inside a generic function that `type` is the
 * constructor or instance type of, or null. */
function localClassOfResult(
  lowerer: Lowerer,
  info: GenericFnInfo,
  type: ts.Type,
): ts.ClassLikeDeclaration | null {
  const symbol = type.getSymbol();
  const decl = symbol && symbol.flags & ts.SymbolFlags.Class ? symbol.valueDeclaration : undefined;
  if (decl && (ts.isClassExpression(decl) || ts.isClassDeclaration(decl)))
    return declaredInside(decl, info.decl) ? decl : null;
  // A result typed by a constructor type (`Struct<S>`, `new () => S`) whose
  // every return gives back the one local class, through parentheses and
  // assertions (`return Base as Struct<S>`).
  // A mixin (a class extending one of the function's parameters) keeps the
  // mixin instantiation, which keys on the argument class.
  if (lowerer.checker.getConstructSignatures(type).length === 0) return null;
  const returned = returnedLocalClass(lowerer, info);
  return returned && !extendsParameter(lowerer, returned, info) ? returned : null;
}

function extendsParameter(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  info: GenericFnInfo,
): boolean {
  const params = new Set<ts.Symbol>();
  for (const param of info.decl.parameters.nodes) {
    const symbol = ts.isIdentifier(param.name)
      ? lowerer.checker.getSymbolAtLocation(param.name)
      : undefined;
    if (symbol !== undefined) params.add(symbol);
  }
  for (const clause of decl.heritageClauses?.nodes ?? [])
    for (const base of clause.types.nodes) {
      const target = heritageElementTarget(base);
      const symbol = ts.isIdentifier(target)
        ? lowerer.checker.getSymbolAtLocation(target)
        : undefined;
      if (symbol !== undefined && params.has(symbol)) return true;
    }
  return false;
}

function declaredInside(node: ts.Node, owner: ts.Node): boolean {
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent)
    if (parent === owner) return true;
  return false;
}

/** The local class every return of `info`'s body gives back, or null when a
 * return gives anything else (or nothing). Nested functions and classes keep
 * their own returns. */
function returnedLocalClass(lowerer: Lowerer, info: GenericFnInfo): ts.ClassLikeDeclaration | null {
  const body = info.decl.body;
  if (!body) return null;
  const classOf = (node: ts.Expression): ts.ClassLikeDeclaration | null => {
    let expr = node;
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      expr = expr.expression;
    if (ts.isClassExpression(expr)) return declaredInside(expr, info.decl) ? expr : null;
    if (!ts.isIdentifier(expr)) return null;
    const declaration = lowerer.checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (!declaration || !declaredInside(declaration, info.decl)) return null;
    if (ts.isClassDeclaration(declaration)) return declaration;
    // A `const` bound to a class expression (`const C = class { ... }; return C`).
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const &&
      declaration.initializer
    ) {
      let init: ts.Expression = declaration.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isClassExpression(init)) return init;
    }
    return null;
  };
  if (!ts.isBlock(body)) return classOf(body as ts.Expression);
  let found: ts.ClassLikeDeclaration | null = null;
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (
      !valid ||
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return;
    if (ts.isReturnStatement(node)) {
      const returned = node.expression ? classOf(node.expression) : null;
      if (!returned || (found !== null && found !== returned)) valid = false;
      else found = returned;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return valid ? found : null;
}

/** Runs `fn` under an instance's type bindings and local-class names, as
 * its body lowers. */
function withInstanceScope<T>(
  lowerer: Lowerer,
  info: GenericFnInfo,
  inst: GenericInstance,
  fn: () => T,
): T {
  const prevBindings = lowerer.typeParamBindings;
  const prevTsBindings = lowerer.typeParamTsBindings;
  const previousPath = lowerer.genericInstantiationPath;
  const prevContext = lowerer.instantiationContext;
  const prevResultClass = lowerer.instanceResultClass;
  lowerer.typeParamBindings = inst.bindings;
  lowerer.typeParamTsBindings = inst.tsBindings ?? null;
  lowerer.genericInstantiationPath = inst.path;
  lowerer.instantiationContext = `instantiating '${info.baseName}' with ${inst.typeArgsText}`;
  lowerer.instanceResultClass = inst.resultClass ?? null;
  lowerer.localClassInstantiations.push({ owner: info.decl, name: inst.name });
  try {
    return fn();
  } finally {
    lowerer.instanceResultClass = prevResultClass;
    lowerer.localClassInstantiations.pop();
    lowerer.typeParamBindings = prevBindings;
    lowerer.typeParamTsBindings = prevTsBindings;
    lowerer.genericInstantiationPath = previousPath;
    lowerer.instantiationContext = prevContext;
  }
}

/** The one instance table both instantiation routes share: key identity IS
 * signature identity, so a call (`identity(1)`) and a pinned VALUE
 * (`const f: (x: number) => number = identity`) reuse one compiled
 * instance. `makeBindings` runs only for a NEW key (binding inference
 * costs checker walks). */
function internGenericInstance(
  lowerer: Lowerer,
  blame: ts.Node,
  info: GenericFnInfo,
  params: ParamShape[],
  returnType: IrType,
  makeBindings: (tsBindings: Map<ts.Symbol, ts.Type>) => Map<ts.Symbol, IrType>,
  opts?: {
    extraKey?: string;
    tsBindings?: Map<ts.Symbol, ts.Type>;
    staticFnNames?: Map<ts.Symbol, string | null>;
  },
): GenericInstance {
  // keyof-constrained instantiations append their literal keys
  // (extraKey): the IR signature alone under-discriminates there — two
  // literals can map to one IR signature while their bodies read
  // different fields.
  const key = `${params.map((s) => typeKey(s.type)).join(",")}=>${typeKey(returnType)}${opts?.extraKey ?? ""}`;
  let inst = info.instances.get(key);
  if (!inst) {
    const path = extendInstantiationPath(lowerer.genericInstantiationPath, info.decl);
    if (!path) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `unbounded generic instantiation ('${info.baseName}' exceeded ` +
          `${MAX_INSTANTIATION_RECURSION} recursive specializations on one demand path)`,
      );
    }
    const tsBindings = opts?.tsBindings ?? new Map<ts.Symbol, ts.Type>();
    const bindings = makeBindings(tsBindings);
    const rendered = info.typeParams
      .map((tp) => {
        // A literal-bound keyof parameter renders its literal — the
        // instance is per-literal, and '<…, string>' would misname it.
        const tsBound = tsBindings.get(tp);
        if (info.keyofTps?.has(tp) && tsBound?.isStringLiteralType()) {
          return JSON.stringify(tsBound.value);
        }
        const bound = bindings.get(tp);
        return bound ? lowerer.fmt(bound) : ts.symbolName(tp);
      })
      .join(", ");
    // Deep polymorphic recursion renders unbounded types — keep messages sane.
    const typeArgsText = `<${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered}>`;
    inst = {
      path,
      name: keyedHelperName(lowerer, `${info.qualifiedName}%`, key, ""),
      ordinal: info.instances.size,
      params,
      returnType,
      bindings,
      tsBindings,
      typeArgsText,
      ...(opts?.staticFnNames ? { staticFnNames: opts.staticFnNames } : {}),
    };
    info.instances.set(key, inst);
    lowerer.instantiationQueue.push({ info, inst });
  }
  lowerer.noteGenericInstanceDemand(inst);
  return inst;
}

/** The type parameters of `info` declared with a `keyof` CONSTRAINT
 * (`K extends keyof T`) — the parameters whose bound literal is semantic
 * (the body's `o[k]` reads the named field), computed once per info from
 * the declaration's syntax. */
function keyofConstrainedTypeParams(info: GenericFnInfo): Set<ts.Symbol> {
  if (info.keyofTps) return info.keyofTps;
  const out = new Set<ts.Symbol>();
  info.decl.typeParameters?.nodes.forEach((tpDecl, i) => {
    const sym = info.typeParams[i];
    if (!sym || tpDecl.constraint === undefined) return;
    if (
      ts.isTypeOperatorNode(tpDecl.constraint) &&
      tpDecl.constraint.operator === ts.SyntaxKind.KeyOfKeyword
    ) {
      out.add(sym);
    }
  });
  info.keyofTps = out;
  return out;
}

/** The instance-key suffix of the literals bound to `info`'s
 * keyof-constrained type parameters (`@"a"`; `*` for a non-literal
 * binding): two literals can map to one IR signature while their bodies
 * read different fields. */
function keyofLiteralKey(info: GenericFnInfo, tsBindings: Map<ts.Symbol, ts.Type>): string {
  const keyofTps = keyofConstrainedTypeParams(info);
  const literals = info.typeParams
    .filter((tp) => keyofTps.has(tp))
    .map((tp) => {
      const bound = tsBindings.get(tp);
      return bound?.isStringLiteralType()
        ? JSON.stringify(bound.value)
        : bound?.isNumberLiteralType()
          ? String(bound.value)
          : "*";
    });
  return `@${literals.join(",")}`;
}

/** Type-parameter symbol → concrete IR type for one instantiation.
 * Explicit type arguments bind directly; the rest come from structurally
 * matching each DECLARED param/return type (which mentions the type
 * parameters) against the checker's INSTANTIATED one — the latter is the
 * former with the substitution applied, so the shapes are parallel by
 * construction. A type parameter left unbound only matters if the body
 * mentions it, where mapType fails and badType names the shape
 * (carrying the instantiation context). */
export function inferTypeParamBindings(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  info: GenericFnInfo,
  rsig: ts.Signature,
  tsBindings?: Map<ts.Symbol, ts.Type>,
): Map<ts.Symbol, IrType> {
  const bindings = new Map<ts.Symbol, IrType>();
  expr.typeArguments?.nodes.forEach((ta, i) => {
    const tp = info.typeParams[i];
    if (!tp) return;
    const taT = lowerer.checker.getTypeFromTypeNode(ta);
    const mapped = lowerer.mapTypeOf(taT);
    if (mapped) {
      bindings.set(tp, mapped);
      tsBindings?.set(tp, taT);
    }
  });
  unifySignatureBindings(lowerer, info, rsig, bindings, tsBindings);
  bindDefaultTypeParams(
    lowerer,
    info.typeParams,
    info.decl.typeParameters?.nodes,
    bindings,
    tsBindings,
  );
  return bindings;
}

/** Type parameters still unbound after unification take their declared
 * DEFAULT (`<T = number>`), mapped — the checker already substituted the
 * default into every resolved signature, so this only fills the bindings
 * an instance body's mapType consults. */
function bindDefaultTypeParams(
  lowerer: Lowerer,
  typeParams: readonly ts.Symbol[],
  typeParamDecls: readonly ts.TypeParameterDeclaration[] | undefined,
  bindings: Map<ts.Symbol, IrType>,
  tsBindings?: Map<ts.Symbol, ts.Type>,
): void {
  typeParamDecls?.forEach((tpDecl, i) => {
    const tp = typeParams[i];
    if (!tp || bindings.has(tp) || !tpDecl.defaultType) return;
    const defT = lowerer.checker.getTypeFromTypeNode(tpDecl.defaultType);
    const mapped = lowerer.mapTypeOf(defT);
    if (mapped) {
      bindings.set(tp, mapped);
      tsBindings?.set(tp, defT);
    }
  });
}

/** The structural half of binding inference: unify the DECLARED signature
 * (whose types mention the type parameters) against a TARGET signature
 * with the substitution applied — a call's resolved signature, or the
 * completed signature a VALUE reference is pinned to (the contextual
 * type's one call signature). Mutates `bindings`; already-bound
 * parameters (explicit type arguments) win. */
function unifySignatureBindings(
  lowerer: Lowerer,
  info: GenericFnInfo,
  rsig: ts.Signature,
  bindings: Map<ts.Symbol, IrType>,
  tsBindings?: Map<ts.Symbol, ts.Type>,
): void {
  const tpSet = new Set(info.typeParams);

  const seen = new Set<ts.Type>(); // recursive declared types must not loop
  // The identity-keyed set cannot catch LAZILY INFINITE anonymous types
  // (`function rec<T>(x: T) { return { deeper: <U>(y: U) => rec<[T, U]>(...) }; }`
  // — every property/signature walk instantiates FRESH type objects, and
  // no Reference target exists to shortcut on), so a depth cap bounds the
  // walk. Stopping only stops INFERENCE: a type parameter left unbound
  // surfaces as an ordinary mapping diagnostic later, never a wrong
  // binding — and every practical signature binds its parameters within
  // a few levels.
  const MAX_UNIFY_DEPTH = 24;
  const unify = (declared: ts.Type, inst: ts.Type, depth = 0): void => {
    if (depth > MAX_UNIFY_DEPTH) return;
    if (declared.flags & ts.TypeFlags.TypeParameter) {
      const sym: ts.Symbol | undefined = declared.getSymbol();
      if (sym && tpSet.has(sym)) {
        // The checker type records even when an explicit type argument
        // already bound the IrType: the raw type is the SAME binding
        // pre-widening, and first-hit-wins keeps the two maps parallel.
        // A generic body FORWARDING its own parameter (`pluck`'s
        // `pick(it, key)` binds pick's K to pluck's K) resolves through
        // the enclosing instantiation's ts bindings first — the literal
        // carries through the chain.
        if (tsBindings && !tsBindings.has(sym)) {
          tsBindings.set(sym, lowerer.typeParamTsResolver(inst) ?? inst);
        }
        if (!bindings.has(sym)) {
          const mapped =
            lowerer.mapTypeOf(inst) ??
            ((inst.flags & ts.TypeFlags.Any) !== 0 &&
            !isJsSourceFile(ts.getSourceFileOfNode(info.decl))
              ? DYN
              : null);
          // A visitor's inferred T can be void. It still binds the
          // return convention of `(node) => T`; discarding it leaves
          // the callback's return type spuriously uninstantiated.
          if (mapped) bindings.set(sym, mapped);
        }
      }
      return;
    }
    if (seen.has(declared)) return;
    seen.add(declared);
    // Optional-flavored unions (`x?: T` declares `T | undefined`): strip
    // the unit parts from both sides and unify the lone remaining pair.
    // Multi-part unions have no positional correspondence — skipped (an
    // unbound type parameter surfaces as a mapping diagnostic later).
    if (declared.isUnionType()) {
      const unitFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
      const declaredParts = ts.constituentTypes(declared);
      const declaredUnits = declaredParts.reduce((flags, t) => flags | (t.flags & unitFlags), 0);
      const dParts = declaredParts.filter((t) => !(t.flags & unitFlags));
      const iParts: readonly ts.Type[] = inst.isUnionType()
        ? ts.constituentTypes(inst).filter((t) => !(t.flags & declaredUnits))
        : [inst];
      if (dParts.length === 1 && iParts.length === 1) unify(dParts[0]!, iParts[0]!, depth + 1);
      else if (
        dParts.length === 1 &&
        iParts.length > 1 &&
        iParts.every((t) => (t.flags & unitFlags) === 0)
      ) {
        // T | undefined can receive boolean | undefined: boolean itself
        // has two literal arms. There is still one declared data slot,
        // so match it against the whole remaining union. Removing null
        // too is safe only when no undeclared null arm remains.
        unify(dParts[0]!, lowerer.checker.getNonNullableType(inst), depth + 1);
      } else if (dParts.length > 1 && iParts.length === dParts.length) {
        // `T | Promise<T>` against `Res | Promise<Res>`: each declared
        // part that names a generic target (Promise, an interface, an
        // alias) pairs with the one instantiated part of the same target;
        // a single remaining bare type parameter takes the single
        // remaining instantiated part.
        const remaining = [...iParts];
        const bare: ts.Type[] = [];
        for (const d of dParts) {
          if (d.flags & ts.TypeFlags.TypeParameter) {
            bare.push(d);
            continue;
          }
          const target = d.getSymbol() ?? d.getAliasSymbol();
          if (target === undefined) return;
          const matches = remaining.filter((i) => (i.getSymbol() ?? i.getAliasSymbol()) === target);
          if (matches.length !== 1) return;
          remaining.splice(remaining.indexOf(matches[0]!), 1);
          unify(d, matches[0]!, depth + 1);
        }
        if (bare.length === 1 && remaining.length === 1) unify(bare[0]!, remaining[0]!, depth + 1);
      }
      return;
    }
    // Instantiations of the SAME generic ALIAS (Partial<T> vs
    // Partial<Config>) unify by alias arguments: instantiation preserves
    // aliasSymbol/aliasTypeArguments, and the two argument lists are
    // parallel by construction. Without this, a mapped-type parameter
    // leaves T unbound — the declared `Partial<T>` has no resolvable
    // members for the property walk below (keyof T is unknown).
    const dAlias = declared.getAliasSymbol();
    const dAliasArgs = declared.getAliasTypeArguments();
    const iAliasArgs = inst.getAliasTypeArguments();
    if (
      dAlias &&
      dAlias === inst.getAliasSymbol() &&
      dAliasArgs.length &&
      iAliasArgs.length === dAliasArgs.length
    ) {
      if (tsBindings && declared !== inst) {
        let entries = lowerer.boundAliasInstances.get(declared);
        if (!entries) lowerer.boundAliasInstances.set(declared, (entries = []));
        // A body forwarding its own alias (`inner(g)` returning `Catalog<G,
        // "x">` inside an instance) resolves through the enclosing one.
        if (!entries.some((entry) => entry.tsBindings === tsBindings))
          entries.push({ tsBindings, instance: lowerer.boundAliasTsResolver(inst) ?? inst });
      }
      dAliasArgs.forEach((da, i) => {
        const ia = iAliasArgs[i];
        if (ia) unify(da, ia, depth + 1);
      });
      return;
    }
    // References to the SAME generic (Promise<T> vs Promise<string>, or
    // any interface reference) unify by type ARGUMENTS only. Walking
    // members instead diverges: a self-referential member like Promise's
    // `then<U>(...): Promise<U>` instantiates a FRESH type object on
    // every property read, so an identity-keyed visited set never trips.
    const dRef = declared as ts.TypeReference;
    const iRef = inst as ts.TypeReference;
    if (
      declared.flags & ts.TypeFlags.Object &&
      inst.flags & ts.TypeFlags.Object &&
      (declared as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
      (inst as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
      dRef.getTarget() === iRef.getTarget()
    ) {
      const dArgs = lowerer.checker.getTypeArguments(dRef);
      const iArgs = lowerer.checker.getTypeArguments(iRef);
      dArgs.forEach((da, i) => {
        const ia = iArgs[i];
        if (ia) unify(da, ia, depth + 1);
      });
      return;
    }
    if (lowerer.checker.isArrayType(declared) && lowerer.checker.isArrayType(inst)) {
      const dElem = lowerer.checker.getTypeArguments(declared as ts.TypeReference)[0];
      const iElem = lowerer.checker.getTypeArguments(inst as ts.TypeReference)[0];
      if (dElem && iElem) unify(dElem, iElem, depth + 1);
      return;
    }
    const dSigs = lowerer.checker.getCallSignatures(declared);
    const iSigs = lowerer.checker.getCallSignatures(inst);
    if (dSigs.length === 1 && iSigs.length === 1) {
      const ds = dSigs[0]!;
      const is = iSigs[0]!;
      const instanceParams = is.getParameters();
      ds.getParameters().forEach((dp, i) => {
        const ip = instanceParams[i];
        if (ip)
          unify(
            lowerer.checker.getTypeOfSymbol(dp),
            lowerer.checker.getTypeOfSymbol(ip),
            depth + 1,
          );
      });
      unify(
        lowerer.checker.getReturnTypeOfSignature(ds),
        lowerer.checker.getReturnTypeOfSignature(is),
        depth + 1,
      );
      return;
    }
    if (declared.flags & ts.TypeFlags.Object) {
      for (const dp of lowerer.checker.getPropertiesOfType(declared)) {
        const ip = lowerer.checker.getPropertyOfType(inst, ts.symbolName(dp));
        if (ip)
          unify(
            lowerer.checker.getTypeOfSymbol(dp),
            lowerer.checker.getTypeOfSymbol(ip),
            depth + 1,
          );
      }
    }
  };

  const declSig = lowerer.checker.getSignatureFromDeclaration(info.decl);
  if (declSig) {
    const instanceParams = rsig.getParameters();
    declSig.getParameters().forEach((dp, i) => {
      const ip = instanceParams[i];
      if (ip) unify(lowerer.checker.getTypeOfSymbol(dp), lowerer.checker.getTypeOfSymbol(ip));
    });
    unify(
      lowerer.checker.getReturnTypeOfSignature(declSig),
      lowerer.checker.getReturnTypeOfSignature(rsig),
    );
  }
}

/** Lowers ONE monomorphic instance of a generic function: the same body
 * AST, re-lowered with the type parameters bound (threaded into every
 * mapType call via typeParamResolver — the checker keeps reporting the
 * unsubstituted `T`s inside the body). Coverage stats count a base
 * function's statements once: only the FIRST instance contributes. */
export function lowerGenericInstance(
  lowerer: Lowerer,
  info: GenericFnInfo,
  inst: GenericInstance,
): IrFunction {
  const decl = info.decl;
  const cls = info.member?.cls ?? null;
  const prevBindings = lowerer.typeParamBindings;
  const previousPath = lowerer.genericInstantiationPath;
  const prevContext = lowerer.instantiationContext;
  const prevSuppress = lowerer.suppressStats;
  const prevClass = lowerer.currentClass;
  const prevImplicit = lowerer.implicitParamTypes;
  const prevStaticFnNames = lowerer.staticFnNames;
  lowerer.staticFnNames = inst.staticFnNames ?? null;
  // A generic METHOD of a generic-class INSTANTIATION lowers under BOTH
  // binding sets: the receiver instantiation's class type parameters
  // underneath, the method instantiation's own on top (disjoint symbol
  // sets — tsc rejects shadowing a class type parameter in a method).
  const clsBindings = cls?.genericInstance?.bindings;
  lowerer.typeParamBindings = clsBindings
    ? new Map([...clsBindings, ...inst.bindings])
    : inst.bindings;
  // The ts-level bindings ride along: `T[K]` and literal-keyed `o[k]`
  // reads inside the body resolve through the bound CHECKER types
  // (typeParamTsResolver). Generic-class instantiations carry no
  // ts-level bindings (their type arguments widened at the reference),
  // so only the method instantiation's own map installs.
  const prevTsBindings = lowerer.typeParamTsBindings;
  lowerer.typeParamTsBindings = inst.tsBindings ?? null;
  // Implicit-any instances thread their param bindings through typeOf
  // (the checker reports `any` inside the body — there is no T for
  // mapType to substitute); see the implicit-monomorphization section.
  lowerer.implicitParamTypes =
    info.implicitParams !== undefined ? (inst.implicitArgTypes ?? new Map()) : null;
  lowerer.instantiationContext = `instantiating '${info.baseName}' with ${inst.typeArgsText}`;
  // Coverage counts a generic source body once: re-instantiations of the
  // method AND re-instantiations of the declaring generic class re-visit
  // the same source lines.
  lowerer.suppressStats = inst.ordinal > 0 || (cls?.genericInstance?.ordinal ?? 0) > 0;
  // A generic ASYNC instance is an async IrFunction like any other: the
  // body returns the resolved promise's INNER type, calls enter through
  // the instance's own spawn wrapper (the emitter routes by fn.async),
  // and awaits park this instance's fibers.
  const isAsync = decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const nameBlame: ts.Node = (ts.isArrowFunction(decl) ? undefined : decl.name) ?? decl;
  const isGenerator = decl.asteriskToken !== undefined;
  if (isAsync && !isGenerator && inst.returnType.kind !== "promise") {
    lowerer.badType(nameBlame, lowerer.checker.getTypeAtLocation(nameBlame));
  }
  // A generic GENERATOR instance mirrors async: the body returns the
  // resolved TReturn channel, calls enter through the instance's own
  // gen-spawn wrapper (the emitter routes by fn.generator).
  if (
    isGenerator &&
    (inst.returnType.kind !== "generator" || (inst.returnType.async === true) !== isAsync)
  ) {
    lowerer.badType(nameBlame, lowerer.checker.getTypeAtLocation(nameBlame));
  }
  let bodyReturn = isGenerator
    ? lowerer.genBodyReturnType(inst.returnType)
    : lowerer.bodyReturnType(isAsync, inst.returnType);
  const fnCtx = newFnCtx(false, null, null, bodyReturn);
  fnCtx.isAsync = isAsync;
  // Instances lower on demand, on top of whichever caller reached them.
  fnCtx.thisBoundary = true;
  // Implicit-any instances whose declared return did not map lower in
  // return-INFERENCE mode: `return` statements record here bare, and the
  // post-pass (resolveInferredReturn) settles the type and wraps them.
  if (inst.implicitInferReturn) fnCtx.inferReturn = { entries: [] };
  if (cls && info.member!.kind === "method") lowerer.currentClass = cls;
  if (isGenerator && inst.returnType.kind === "generator") {
    fnCtx.generator = generatorMeta(lowerer, inst.returnType);
  }
  lowerer.fnStack.push(fnCtx);
  lowerer.localClassInstantiations.push({ owner: decl, name: inst.name });
  lowerer.genericInstantiationPath = inst.path;
  if (inst.erased) lowerer.erasingDepth++;
  try {
    // Static specializations bind lexical this only when the caller
    // proved its exact receiver. Other instances retain the fence;
    // super remains unsupported. Arrows inherit the lexical receiver.
    if (info.member?.kind === "static" && decl.body) {
      rejectStaticThis(
        lowerer,
        decl.body,
        (keyword) =>
          `'${keyword}' in static methods (it names the RECEIVER class — a dynamic value; reference the class by name instead)`,
        false,
        info.staticReceiver !== undefined,
      );
    }
    const params: IrParam[] = [];
    const receiverInit: IrStmt[] = [];
    if (info.staticReceiver) {
      const value = lowerer.classValueRef(info.staticReceiver, decl);
      const local = lowerer.declareThis(value.type);
      receiverInit.push({ kind: "varDecl", localId: local.id, init: value, loc: locOf(decl) });
    }
    if (cls && info.member!.kind === "method") {
      // Instance methods take `this` as param 0, exactly like plain
      // `%C.method` functions (lowerClassMethodMemberInner).
      const thisType: IrType = { kind: "object", className: cls.def.name };
      const thisLocal = lowerer.declareThis(thisType);
      params.push({ localId: thisLocal.id, name: "this", type: thisType });
    }
    // Default-param initializers lower per instance, with the bindings
    // threaded — a default mentioning T resolves like any body expression.
    const declared = lowerer.declareParams(decl.parameters.nodes, inst.params);
    params.push(...declared.params);
    const body = [...receiverInit, ...declared.prologue];
    const bodyBlock = blockBodyOf(decl);
    if (bodyBlock) {
      body.push(...lowerer.lowerStmts(bodyBlock.statements.nodes));
      if (fnCtx.inferReturn) {
        bodyReturn = resolveInferredReturn(lowerer, inst, fnCtx.inferReturn, body, decl);
        inst.returnType = bodyReturn;
      }
      appendImplicitUndefinedReturn(lowerer, body, bodyReturn, locOf(decl));
    } else if (ts.isArrowFunction(decl) && decl.body !== undefined && !ts.isBlock(decl.body)) {
      // A concise arrow body: the expression IS the return value —
      // generic properties (`id: <T>(x: T) => x`), and implicit-any
      // local arrows (`(cmd) => [cmd.name()].concat(cmd.aliases())`),
      // whose inferred return is simply the expression's own type.
      if (fnCtx.inferReturn) {
        const value = lowerer.lowerExpr(decl.body);
        if (value.type.kind === "void") {
          body.push({ kind: "exprStmt", expr: value, loc: locOf(decl.body) });
          bodyReturn = resolveInferredReturn(lowerer, inst, fnCtx.inferReturn, body, decl);
          inst.returnType = bodyReturn;
          appendImplicitUndefinedReturn(lowerer, body, bodyReturn, locOf(decl));
        } else {
          const stmt: IrStmt = { kind: "return", value, loc: locOf(decl.body) };
          fnCtx.inferReturn.entries.push({ stmt, node: decl.body });
          body.push(stmt);
          bodyReturn = resolveInferredReturn(lowerer, inst, fnCtx.inferReturn, body, decl);
          inst.returnType = bodyReturn;
        }
      } else {
        const value = lowerer.lowerExprExpecting(decl.body, bodyReturn);
        if (bodyReturn.kind === "void") {
          body.push({ kind: "exprStmt", expr: value, loc: locOf(decl.body) });
        } else {
          body.push({ kind: "return", value, loc: locOf(decl.body) });
        }
      }
    } else {
      lowerer.unsupported(
        "SC1090",
        decl,
        "function declarations whose block body the frontend cannot locate",
      );
    }
    const fn: IrFunction = {
      name: inst.name,
      sourceName: info.baseName,
      ...(!isAsync &&
      !decl.asteriskToken &&
      (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl))
        ? { ownsPrototype: true as const }
        : {}),
      params,
      returnType: bodyReturn,
      locals: lowerer.ctx.locals,
      body,
      loc: locOf(decl),
    };
    if (isAsync) fn.async = true;
    if (fnCtx.generator) fn.generator = fnCtx.generator;
    return fn;
  } finally {
    lowerer.fnStack.pop();
    lowerer.genericInstantiationPath = previousPath;
    lowerer.currentClass = prevClass;
    lowerer.typeParamBindings = prevBindings;
    lowerer.typeParamTsBindings = prevTsBindings;
    lowerer.implicitParamTypes = prevImplicit;
    lowerer.staticFnNames = prevStaticFnNames;
    lowerer.instantiationContext = prevContext;
    lowerer.localClassInstantiations.pop();
    lowerer.suppressStats = prevSuppress;
    if (inst.erased) lowerer.erasingDepth--;
  }
}

/** A generic function taken as a VALUE, monomorphized by flow. A function
 * value needs ONE concrete signature; tsc pins one at exactly two
 * reference shapes — an instantiation EXPRESSION (`identity<number>`,
 * whose own checker type is the substituted signature) and a reference
 * whose CONTEXTUAL type completes the signature (`const f: (x: number) =>
 * number = identity`, `take(identity)`). The declared signature unifies
 * against the pinned one to recover the bindings; the instance then
 * registers in the SAME table call sites use (one compiled copy per
 * signature however it is reached), and the value is the instance's
 * zero-capture closure — `f === f` holds within an instantiation, the
 * declared-function identity rule. References with no pinning context
 * (the slot keeps `<T>(x: T) => T`) fence by name. */
export function lowerGenericFnValue(
  lowerer: Lowerer,
  ref: ts.Expression,
  info: GenericFnInfo,
): IrExpr {
  const loc = locOf(ref);
  // An IMPLICIT-ANY function taken as a VALUE: indirect calls carry no
  // per-site types to bind, so the value is the all-dyn DEFAULT
  // instance's closure — today's compiled body exactly (one interned
  // closure per function, so `f === f` holds like any declaration).
  if (info.implicitParams) {
    const inst = implicitDefaultInstance(lowerer, ref, info);
    const funcType: IrType = funcTypeFromParamShapes(inst.params, inst.returnType);
    lowerer.requireExactArityValue(ref, ref, inst.params, funcType);
    lowerer.noteEdge(inst.name);
    return { kind: "closure", fnName: inst.name, captures: [], type: funcType, loc };
  }
  // Each call of the enclosing function makes a new function object for a
  // binding declared inside it (`make() !== make()` when make returns
  // it), which one shared compiled instance cannot give.
  if (info.functionScoped) {
    lowerer.unsupported(
      "SC1090",
      ref,
      `generic arrow/function-expression bindings declared inside functions as values (each call of the enclosing function makes a new '${info.baseName}' function object, while its compiled instances are shared module functions — call '${info.baseName}' directly, or declare it at module scope)`,
    );
  }
  const fenceUnpinned: () => never = () =>
    lowerer.unsupported(
      "SC1090",
      ref,
      `generic functions as values without a pinned concrete signature (annotate the destination — e.g. 'const f: (x: number) => number = ${info.baseName}' — instantiate explicitly ('${info.baseName}<number>'), or call '${info.baseName}' directly)`,
    );
  // The PINNING type: an instantiation expression's own checker type
  // (explicit type arguments applied), else the reference's contextual
  // type — the slot or argument the value flows into. Namespace/CJS
  // member paths delegate the member NAME here (`lib.tag` hands over
  // `tag`), and the checker hangs the contextual type on the whole
  // property access — hop to it.
  const ctxNode =
    ref.parent !== undefined && ts.isPropertyAccessExpression(ref.parent) && ref.parent.name === ref
      ? ref.parent
      : ref;
  const pinT = ts.isExpressionWithTypeArguments(ref)
    ? lowerer.typeOf(ref)
    : lowerer.checker.getContextualType(ctxNode);
  let target: ts.Signature | null = null;
  if (pinT) {
    const sigs = lowerer.checker.getCallSignatures(pinT);
    if (sigs.length === 1) target = sigs[0]!;
    else if (sigs.length === 0 && pinT.isUnionType()) {
      // A `Fn | undefined`-flavored slot: the value can only inhabit the
      // one callable arm — judge by it (the requireExactArityValue union
      // rule).
      const callable = ts
        .constituentTypes(pinT)
        .map((t) => lowerer.checker.getCallSignatures(t))
        .filter((s) => s.length === 1);
      if (callable.length === 1) target = callable[0]![0]!;
    }
  }
  if (!target) fenceUnpinned();
  return guardEarlyBindingValue(
    lowerer,
    info,
    ref,
    pinnedGenericClosure(lowerer, ref, info, target, fenceUnpinned),
  );
}

/** The value a generic binding declared inside a function stores when a
 * nested function read it before the declaration lowered (`const read =
 * () => id; const id: (x: number) => number = <T>(x: T): T => x`): such
 * a read resolves to an ordinary TDZ local, so the declaration assigns it
 * the instance its concrete declared signature pins. Each evaluation of
 * the declaration makes a new function object, as in JavaScript: the
 * value is a closure over a forwarder to the instance, not the instance's
 * interned closure. */
export function genericBindingStoredValue(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  info: GenericFnInfo,
): IrExpr {
  const name = decl.name as ts.Identifier;
  const fenceUnpinned = (): never =>
    lowerer.unsupported(
      "SC1090",
      name,
      `generic function bindings read before their declaration without a concrete declared signature (annotate '${info.baseName}' with one, or declare it before its uses)`,
    );
  const sigs = lowerer.checker.getCallSignatures(lowerer.typeOf(name));
  if (sigs.length !== 1) fenceUnpinned();
  const pinned = pinnedGenericClosure(lowerer, name, info, sigs[0]!, fenceUnpinned);
  const async = ts.getModifiers(info.decl)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (pinned.kind !== "closure" || pinned.type.kind !== "func" || pinned.type.rest || async)
    return lowerer.unsupported(
      "SC1090",
      name,
      `async or rest-parameter generic function bindings read before their declaration (each evaluation of '${info.baseName}' makes a new function object)`,
    );
  return {
    ...pinned,
    fnName: genericValueForwarder(lowerer, info, pinned.fnName, pinned.type, pinned.loc),
  };
}

/** A lifted function that calls the instance `instance` (of type `type`)
 * with its own arguments. Lifted functions get a new closure object per
 * evaluation; module functions, which instances are, get one interned
 * closure. */
function genericValueForwarder(
  lowerer: Lowerer,
  info: GenericFnInfo,
  instance: string,
  type: IrType & { kind: "func" },
  at: SrcLoc,
): string {
  info.valueForwarders ??= new Map();
  const existing = info.valueForwarders.get(instance);
  if (existing !== undefined) return existing;
  const name = `${instance}%value`;
  const loc = helperLoc(at);
  const params: IrParam[] = type.params.map((paramType, i) => ({
    localId: `%arg${i}.0`,
    name: `%arg${i}`,
    type: paramType,
  }));
  const call: IrExpr = {
    kind: "call",
    callee: instance,
    args: params.map((p): IrExpr => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
    type: type.ret,
    loc,
  };
  lowerer.liftedFns.push({
    name,
    params,
    returnType: type.ret,
    locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    captures: [],
    ...(ts.isFunctionExpression(info.decl) ? { ownsPrototype: true } : {}),
    body:
      type.ret.kind === "void"
        ? [
            { kind: "exprStmt", expr: call, loc },
            { kind: "return", value: null, loc },
          ]
        : [{ kind: "return", value: call, loc }],
    loc,
  });
  lowerer.noteEdge(name);
  info.valueForwarders.set(instance, name);
  return name;
}

/** The closure of the instance of `info` that `target` pins, for a value
 * read at `ref`. `fenceUnpinned` reports a signature that leaves a type
 * parameter unbound. */
function pinnedGenericClosure(
  lowerer: Lowerer,
  ref: ts.Expression,
  info: GenericFnInfo,
  target: ts.Signature,
  fenceUnpinned: () => never,
): IrExpr {
  const loc = locOf(ref);
  const bindings = new Map<ts.Symbol, IrType>();
  unifySignatureBindings(lowerer, info, target, bindings);
  const hofBinding = runtimeOptionalHofGenericBinding(lowerer, ref, info);
  if (hofBinding) bindings.set(hofBinding.typeParam, hofBinding.type);
  bindDefaultTypeParams(lowerer, info.typeParams, info.decl.typeParameters?.nodes, bindings);
  // A pinning signature that itself keeps type parameters (`let g: <T>(x:
  // T) => T = identity` — storing the generic signature as such) binds
  // nothing: mapType answers null for an unsubstituted parameter.
  if (info.typeParams.some((tp) => !bindings.get(tp))) fenceUnpinned();
  const inst = genericValueInstance(lowerer, ref, info, bindings);
  // The value's type is the completed ABI signature. Typed rest keeps its
  // packed-array slot; dynRest stays hidden behind the rest marker.
  const funcType: IrType = funcTypeFromParamShapes(inst.params, inst.returnType);
  lowerer.requireExactArityValue(ref, ref, inst.params, funcType);
  lowerer.noteEdge(inst.name);
  return { kind: "closure", fnName: inst.name, captures: [], type: funcType, loc };
}

function runtimeOptionalHofGenericBinding(
  lowerer: Lowerer,
  ref: ts.Expression,
  info: GenericFnInfo,
): { typeParam: ts.Symbol; type: IrType } | null {
  let argument = ref;
  while (argument.parent && ts.isParenthesizedExpression(argument.parent))
    argument = argument.parent;
  const call = argument.parent;
  if (!ts.isCallExpression(call) || call.arguments.nodes[0] !== argument) return null;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "map")
    return null;
  if (!lowerer.isStdlibMember(call.expression)) return null;
  const receiver = lowerer.mapTypeOf(lowerer.typeOf(call.expression.expression));
  if (receiver?.kind !== "array") return null;
  const parameter = info.decl.parameters.nodes[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) return null;
  const parameterType = lowerer.typeOf(parameter.name);
  if ((parameterType.flags & ts.TypeFlags.TypeParameter) === 0) return null;
  const typeParam = parameterType.getSymbol();
  if (!typeParam || !info.typeParams.includes(typeParam)) return null;
  return { typeParam, type: lowerer.runtimeOptionalType(receiver.elem) };
}

/** The erased instance of a generic declaration: every type parameter
 * bound to `unknown`, the function JavaScript runs for any type arguments.
 * Values of generic methods (dynamic dispatch, interface views) call it. */
export function erasedGenericInstance(
  lowerer: Lowerer,
  blame: ts.Node,
  info: GenericFnInfo,
): GenericInstance {
  lowerer.erasingDepth++;
  try {
    const instance = genericValueInstance(
      lowerer,
      blame,
      info,
      new Map(info.typeParams.map((tp) => [tp, DYN])),
    );
    instance.erased = true;
    return instance;
  } finally {
    lowerer.erasingDepth--;
  }
}

/** The instance a pinned VALUE reference names: the declaration's modes
 * over the DECLARED types mapped under the bindings (mapType's resolver
 * substitutes — the instance-body trick), which is the same result the
 * call path computes from the resolved signature, so both routes land on
 * one instance per key. */
function genericValueInstance(
  lowerer: Lowerer,
  ref: ts.Node,
  info: GenericFnInfo,
  bindings: Map<ts.Symbol, IrType>,
): GenericInstance {
  const prevBindings = lowerer.typeParamBindings;
  const prevContext = lowerer.instantiationContext;
  const rendered = info.typeParams
    .map((tp) => {
      const bound = bindings.get(tp);
      return bound ? lowerer.fmt(bound) : ts.symbolName(tp);
    })
    .join(", ");
  lowerer.typeParamBindings = bindings;
  lowerer.instantiationContext = `instantiating '${info.baseName}' with <${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered}>`;
  try {
    const declSig = lowerer.checker.getSignatureFromDeclaration(info.decl);
    if (!declSig) lowerer.unsupported("SC1090", ref, "this function form");
    const params = paramShapes(lowerer, info.decl.parameters.nodes, declSig);
    const retTs = lowerer.checker.getReturnTypeOfSignature(declSig);
    const returnType = lowerer.mapTypeOf(retTs);
    if (!returnType) {
      fenceGenericSignatureResult(lowerer, ref, retTs);
      lowerer.badType(ref, retTs);
    }
    return internGenericInstance(lowerer, ref, info, params, returnType, () => bindings);
  } finally {
    lowerer.typeParamBindings = prevBindings;
    lowerer.instantiationContext = prevContext;
  }
}

/* ── implicit-any monomorphization (npm-static JS) ─────────────────────
 *
 * A JS function whose signature carries UNTYPED parameters is, morally, a
 * generic function: the author wrote it for whatever the call sites pass.
 * Inside an opted-in npm-static package the frontend treats each bindable
 * implicit-any parameter as an implicit TYPE parameter and instantiates
 * the body per call site over the WIDENED checker types of the arguments —
 * the generic-binding machinery verbatim, with two twists:
 *
 *   1. The checker reports `any` INSIDE the body (there is no `T` for
 *      mapType to substitute), so the binding threads through the
 *      Lowerer's typeOf instead: an identifier reference to a bound param
 *      whose checker answer is still `any` answers the bound ts.Type, and
 *      every receiver-typed lowering downstream (field targets, method
 *      dispatch, narrowing) sees the concrete type. Where tsc's own
 *      flow analysis DID narrow the `any` (typeof/instanceof guards), a
 *      narrow CONSISTENT with the binding wins (it is the binding, or an
 *      arm of it); a contradicting narrow — the statically-dead branch of
 *      a typeof dispatch this instantiation cannot take — answers the
 *      bound type, so dead branches fence honestly instead of lowering
 *      the live value under a lying type.
 *   2. The instance's RETURN type cannot come from the checker when the
 *      params poisoned it to `any`: instances lower EAGERLY at first
 *      demand (nested body lowering, the lambda discipline) and infer the
 *      return from the lowered return statements; same-key recursion
 *      observes the checker-fallback type ("pinned") and the post-pass
 *      coerces every return to the settled type — per-return fences where
 *      a value cannot ride it. Recursive demands are bounded per
 *      function, the polymorphic-recursion cap.
 *
 * Bindings are SOUND by construction: the bound type is the argument's own
 * checker type at the call site (never a guess), a param the body ever
 * WRITES is not bindable (it stays checked-dynamic — `options = options
 * || {}` keeps today's story), and an argument whose type does not map
 * statically binds the checked-dynamic DYN — the all-dyn instance IS
 * today's compiled body, so nothing regresses where nothing binds. */

/** The npm-static gate: implicit-any monomorphization applies to functions
 * DECLARED in an opted-in package's JS files (user JS keeps today's
 * checked-dynamic story until the corpus is re-baselined). */
export function implicitMonoFile(sf: ts.SourceFile): boolean {
  return isJsSourceFile(sf) && npmStaticPackageOfPath(sf.fileName) !== null;
}

/** True when the body (or a nested function capturing it) ever WRITES the
 * parameter symbol — assignment, compound assignment, ++/--, a
 * destructuring-assignment target, or a for-in/of cursor. A written
 * param's binding could lie after the write, so it stays dyn. */
export function paramWrittenInBody(
  lowerer: Lowerer,
  body: ts.Node,
  sym: ts.Symbol,
  name: string,
): boolean {
  let written = false;
  const targetsSym = (e: ts.Expression): boolean => {
    let n: ts.Expression = e;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (ts.isIdentifier(n) && n.text === name) {
      return lowerer.checker.getSymbolAtLocation(n) === sym;
    }
    // Destructuring-assignment patterns ([a] = xs, {a} = o): any
    // identifier inside the target literal counts (conservative — a
    // nested `a.b` member write through the pattern is a write THROUGH,
    // not a rebind, but patterns are rare enough to over-approximate).
    if (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) {
      let hit = false;
      const scan = (m: ts.Node): void => {
        if (hit) return;
        if (
          ts.isIdentifier(m) &&
          m.text === name &&
          lowerer.checker.getSymbolAtLocation(m) === sym
        ) {
          hit = true;
          return;
        }
        ts.forEachChild(m, scan);
      };
      scan(n);
      return hit;
    }
    return false;
  };
  const walk = (n: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      const isAssign = k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
      if (isAssign && targetsSym(n.left)) {
        written = true;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      targetsSym(n.operand)
    ) {
      written = true;
      return;
    }
    if (
      (ts.isForInStatement(n) || ts.isForOfStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer) &&
      ts.isExpression(n.initializer) &&
      targetsSym(n.initializer)
    ) {
      written = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return written;
}

function broadPromiseParam(lowerer: Lowerer, type: ts.Type): boolean {
  const mapped = lowerer.mapTypeOf(type);
  const arms =
    mapped?.kind === "union"
      ? lowerer.unions.get(mapped.unionId)?.arms
      : mapped === null
        ? undefined
        : [mapped];
  return (
    !!arms &&
    arms.some((arm) => arm.kind === "promise" && arm.inner.kind === "dyn") &&
    arms.every((arm) => isUnitType(arm) || (arm.kind === "promise" && arm.inner.kind === "dyn"))
  );
}

/** A destructured object parameter (`function f({ Base, name })`) whose
 * names bind the call site argument's property types. */
export interface ImplicitPattern {
  elements: { property: string; symbol: ts.Symbol }[];
}

/** The destructured object parameters of a JS function-like that bind like
 * implicit type parameters: every element a plain name (optionally renamed
 * from an identifier or string key) with no default, no rest element, and
 * no write in the body, under a broad inferred type. Parallel to
 * decl.parameters. */
export function implicitPatternsOf(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): (ImplicitPattern | null)[] {
  return decl.parameters.nodes.map((param): ImplicitPattern | null => {
    if (!ts.isObjectBindingPattern(param.name) || !decl.body) return null;
    if (param.dotDotDotToken || param.questionToken || param.initializer) return null;
    const elements: ImplicitPattern["elements"] = [];
    for (const element of param.name.elements.nodes) {
      if (element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name))
        return null;
      const key = element.propertyName ?? element.name;
      if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return null;
      const symbol = lowerer.checker.getSymbolAtLocation(element.name);
      if (!symbol || paramWrittenInBody(lowerer, decl.body, symbol, element.name.text)) return null;
      // A JSDoc or contextual type names the properties: keep its ABI.
      if ((lowerer.typeOf(element.name).flags & ts.TypeFlags.Any) === 0) return null;
      elements.push({ property: key.text, symbol });
    }
    return elements.length > 0 ? { elements } : null;
  });
}

/** The type a destructured parameter takes at one call site (the object's
 * own representation, a record or a checked value) and the checker type
 * each destructured name binds. An object literal argument types the names
 * from its property expressions, which see the enclosing instance's
 * bindings (`makeClass({ Base, name })` inside a specialized
 * `extend(Base, name)`); any other argument uses its checker type. Null
 * when the argument lacks a destructured property, or passes a class the
 * callee itself defines: each such class would instantiate the callee
 * again (a static `extend` calling `makeClass({ Base: this })`). */
function implicitPatternBinding(
  lowerer: Lowerer,
  callee: ts.Node,
  pattern: ImplicitPattern,
  arg: ts.Expression,
): { record: IrType; types: Map<ts.Symbol, ts.Type> } | null {
  let literal: ts.Expression = arg;
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
  const types = new Map<ts.Symbol, ts.Type>();
  if (ts.isObjectLiteralExpression(literal)) {
    const values = new Map<string, ts.Expression>();
    /** Shorthand properties name the binding they read. */
    const shorthand = new Map<string, ts.Symbol>();
    for (const property of literal.properties.nodes) {
      if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        values.set(property.name.text, property.name);
        const read = lowerer.checker.getShorthandAssignmentValueSymbol(property);
        if (read) shorthand.set(property.name.text, read);
      } else if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      )
        values.set(property.name.text, property.initializer);
      else return null;
    }
    for (const element of pattern.elements) {
      const value = values.get(element.property);
      if (!value) return null;
      const read = shorthand.get(element.property);
      const type = (read && lowerer.implicitParamTypes?.get(read)) ?? lowerer.typeOf(value);
      types.set(element.symbol, lowerer.checker.getBaseTypeOfLiteralType(type));
    }
    // The object keeps the representation the call site lowers it to; the
    // destructured names read their static types back out of it.
    const lowered = tryLowerExpression(lowerer, literal);
    if (lowered?.type.kind !== "record" && lowered?.type.kind !== "dyn") return null;
    if (lowered.type.kind === "record") {
      for (const field of lowerer.shapes.get(lowered.type.shapeId)?.fields ?? [])
        if (field.type.kind === "classval" && classDefinedIn(lowerer, field.type.className, callee))
          return null;
    }
    return { record: lowered.type, types };
  }
  const argType = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(arg));
  const record = lowerer.mapTypeOf(argType);
  if (record?.kind !== "record") return null;
  for (const element of pattern.elements) {
    const property = lowerer.checker.getPropertyOfType(argType, element.property);
    if (!property) return null;
    types.set(element.symbol, lowerer.checker.getTypeOfSymbol(property));
  }
  return { record, types };
}

/** The class is declared inside `scope`. */
function classDefinedIn(lowerer: Lowerer, className: string, scope: ts.Node): boolean {
  for (
    let n: ts.Node | undefined = lowerer.classes.get(className)?.decl ?? undefined;
    n;
    n = n.parent
  )
    if (n === scope) return true;
  return false;
}

/** The implicit-type-parameter slots of a JS function-like: parallel to
 * decl.parameters, the param SYMBOL where the slot is a bindable
 * implicit param (identifier-named, broad inferred/JSDoc type, not
 * rest/optional/defaulted, never written), null elsewhere. Package JS
 * methods may also specialize class parameters: JSDoc names a nominal
 * class even when the body accepts other objects with the same members.
 * Null overall when nothing qualifies — the declaration keeps its ABI. */
export function implicitAnyParamSymbolsOf(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  classParams = false,
): (ts.Symbol | null)[] | null {
  if (!decl.body) return null;
  if (decl.asteriskToken) return null;
  if (decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if (decl.typeParameters !== undefined) return null; // real generics own the machinery
  if (decl.parameters.nodes.length === 0) return null;
  // The variadic-`arguments` form keeps its dynRest story whole.
  if (bodyReadsArguments(decl)) return null;
  let hasImplicitParams = false;
  const overlayTyped = shapeOverlayAnnotated(decl);
  const out = decl.parameters.nodes.map((param): ts.Symbol | null => {
    if (!ts.isIdentifier(param.name)) return null;
    if (param.dotDotDotToken || param.questionToken || param.initializer) return null;
    if (param.name.text === "this") return null;
    // A parameter typed by shape inference's overlay is a proven type,
    // not an implicit type parameter.
    if (overlayTyped && documentedParameter(param)) return null;
    const t = lowerer.typeOf(param.name);
    const broadFunction = lowerer.checker.typeToString(t) === "Function";
    const broadArray = lowerer.checkerAnyArrayType(t);
    const broadPromise = broadPromiseParam(lowerer, t);
    const declaredKind = classParams ? lowerer.mapTypeOf(t)?.kind : undefined;
    const classParam = classParams && (declaredKind === "object" || declaredKind === "array");
    if (
      (t.flags & ts.TypeFlags.Any) === 0 &&
      !broadFunction &&
      !broadArray &&
      !broadPromise &&
      !classParam
    )
      return null;
    const sym = lowerer.checker.getSymbolAtLocation(param.name);
    if (!sym) return null;
    if (paramWrittenInBody(lowerer, decl.body!, sym, param.name.text)) return null;
    hasImplicitParams = true;
    return sym;
  });
  // Destructured object parameters monomorphize too (implicitPatternsOf);
  // their slots stay null here.
  if (!hasImplicitParams && isJsSourceFile(ts.getSourceFileOfNode(decl)))
    hasImplicitParams = implicitPatternsOf(lowerer, decl).some((pattern) => pattern !== null);
  return hasImplicitParams ? out : null;
}

/** The checker-fallback return type an implicit instance PROMISES before
 * its body lowers: the declared/inferred return when it maps statically
 * (JSDoc @returns, `void`, concrete inference the any-params didn't
 * poison) — used as the expected return, no inference — or null, which
 * selects return INFERENCE with DYN as the recursion pin. */
function implicitDeclaredReturn(lowerer: Lowerer, info: GenericFnInfo): IrType | null {
  try {
    // Static JS helpers can accept a structurally compatible class despite
    // narrower JSDoc (for example a Vector2 target documented as Vector3).
    // Infer their result from the specialized body as well.
    if (
      info.member?.kind === "static" &&
      info.decl.parameters.nodes.some(
        (param, index) =>
          info.implicitParams?.[index] &&
          lowerer.mapTypeOf(lowerer.typeOf(param.name))?.kind === "object",
      )
    )
      return null;
    const broadCallbackSymbols = new Set(
      info.decl.parameters.nodes.flatMap((param, index) => {
        const symbol = info.implicitParams?.[index];
        return symbol !== null &&
          symbol !== undefined &&
          lowerer.checker.typeToString(lowerer.typeOf(param.name)) === "Function"
          ? [symbol]
          : [];
      }),
    );
    let returnsBroadCallback = false;
    if (broadCallbackSymbols.size > 0 && info.decl.body !== undefined) {
      ts.walkPreorder(info.decl.body, (node) => {
        if (node !== info.decl.body && ts.isFunctionLike(node)) return "skip";
        if (!ts.isReturnStatement(node) || node.expression === undefined) return undefined;
        let expression = node.expression;
        while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        if (
          ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          (() => {
            const symbol = lowerer.checker.getSymbolAtLocation(expression.expression);
            return symbol !== undefined && broadCallbackSymbols.has(symbol);
          })()
        ) {
          returnsBroadCallback = true;
          return "stop";
        }
        return undefined;
      });
    }
    if (returnsBroadCallback) return null;
    const declSig = lowerer.checker.getSignatureFromDeclaration(info.decl);
    if (!declSig) return null;
    const retTs = lowerer.checker.getReturnTypeOfSignature(declSig);
    if (retTs.flags & ts.TypeFlags.Any) return null;
    if (retTs.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return DYN;
    if (lowerer.checker.isArrayType(retTs)) {
      // Inferred JavaScript arrays can hold values selected through a
      // mutable constructor registry. The checker may retain only one
      // constructor's element type; settle the result from the lowered
      // container instead of checking every element against that guess.
      if (!hasExplicitJsDocReturn(info.decl)) return null;
      if (
        info.decl.parameters.nodes.some(
          (param, index) =>
            info.implicitParams?.[index] &&
            lowerer.mapTypeOf(lowerer.typeOf(param.name))?.kind === "array",
        )
      )
        return null;
      const elem = lowerer.checker.getTypeArguments(retTs as ts.TypeReference)[0];
      // An implicit-any parameter poisons an inferred array result to
      // any[] even when this instance's body produces one concrete
      // element type (`knownBy(cmd)` in commander). Let the existing
      // lowered-return unifier recover that type. Explicit unknown[]
      // remains a declared checked-dynamic contract and stays pinned.
      if (elem && (elem.flags & ts.TypeFlags.Any) !== 0) return null;
    }
    const mapped = lowerer.mapTypeOf(retTs);
    // Mixed inferred results can select a closure or a class instance.
    // Their callable ABI is settled by the lowered body, including native
    // classes whose reflected calls return checked values.
    if (
      mapped?.kind === "union" &&
      !hasExplicitJsDocReturn(info.decl) &&
      lowerer.unions.get(mapped.unionId)?.arms.some((arm) => arm.kind === "func")
    )
      return null;
    if (mapped?.kind === "symbol" && !hasExplicitJsDocReturn(info.decl)) return null;
    if (mapped?.kind === "date" && !hasExplicitJsDocReturn(info.decl)) return DYN;
    if (!hasExplicitJsDocReturn(info.decl) && info.decl.body) {
      let openReturn = false;
      ts.walkPreorder(info.decl.body, (node) => {
        if (node !== info.decl.body && ts.isFunctionLike(node)) return "skip";
        if (!ts.isReturnStatement(node) || !node.expression || !ts.isIdentifier(node.expression))
          return undefined;
        const symbol = lowerer.resolveValueSymbol(node.expression);
        if (
          symbol &&
          symbol.declarations.some(
            (decl) => ts.isVariableDeclaration(decl) && jsBindingHasOpenWrites(lowerer, decl),
          )
        )
          openReturn = true;
        return undefined;
      });
      if (openReturn) return null;
    }
    // A JavaScript result inferred from an initial record can later
    // carry additional fields. Settle its representation from the
    // lowered returns instead of copying it back into that initial shape.
    const resultArms =
      mapped?.kind === "union" ? lowerer.unions.get(mapped.unionId)?.arms : mapped ? [mapped] : [];
    if (
      resultArms?.some(
        (arm) => arm.kind === "record" || arm.kind === "object" || arm.kind === "classval",
      ) &&
      resultArms.every(
        (arm) =>
          isUnitType(arm) ||
          arm.kind === "record" ||
          arm.kind === "object" ||
          arm.kind === "classval",
      ) &&
      !hasExplicitJsDocReturn(info.decl)
    )
      return null;
    // Inferred variadic results carry runtime argument packs. Their
    // factory must retain the lowered callable rather than extracting a
    // fixed native signature from a checked value.
    if (
      mapped?.kind === "func" &&
      mapped.rest === true &&
      mapped.restAbi === undefined &&
      !hasExplicitJsDocReturn(info.decl)
    )
      return null;
    if (mapped !== null && promiseCarriesDyn(lowerer, mapped) && !hasExplicitJsDocReturn(info.decl))
      return null;
    // A JavaScript body that can complete without returning yields
    // undefined there, whatever its JSDoc claims (bcryptjs's `hash`
    // returns a promise only when no callback is passed), exactly as
    // declaredReturnType widens non-generic JavaScript functions.
    if (
      mapped !== null &&
      isJsSourceFile(ts.getSourceFileOfNode(info.decl)) &&
      functionCanReturnUndefined(info.decl)
    )
      return lowerer.withUndefinedArmOf(mapped) ?? mapped;
    return mapped;
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
    return null;
  }
}

/** True when a `this.method(...)` call targets an implicit npm-static
 * method whose result is settled from its lowered body rather than the
 * checker declaration. Uninitialized-local inference uses this to avoid
 * freezing an evolving `any` slot to stale JSDoc. */
export function implicitMethodCallInfersReturn(lowerer: Lowerer, call: ts.CallExpression): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
    lowerer.currentClass === null
  ) {
    return false;
  }
  const found = findGenericMethodOn(lowerer, lowerer.currentClass, call.expression.name.text);
  return (
    found?.info.implicitParams !== undefined && implicitDeclaredReturn(lowerer, found.info) === null
  );
}

/** True when an IR type may BIND an implicit param (a concrete static
 * type — the checked-dynamic kinds keep the dyn slot, units have no
 * standalone representation). */
function bindableImplicitIr(t: IrType | null): t is IrType {
  return (
    t !== null &&
    t.kind !== "void" &&
    t.kind !== "dyn" &&
    t.kind !== "caught" &&
    t.kind !== "undefinedT" &&
    t.kind !== "nullT"
  );
}

/** A represented binding or direct callable result can be wider than the
 * checker's inferred shape. Preserve that boundary when specializing JS. */
function storedImplicitArgumentType(lowerer: Lowerer, arg: ts.Expression): IrType | null {
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(arg)) &&
    (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
  ) {
    // A closure lowered here before (another call site's instance key, or
    // a repeated demand) keeps its value for the argument's own lowering.
    const known = lowerer.speculatedClosure(arg);
    if (known !== null) return known.type;
    const saved = lowerer.diagSink;
    const diagnostics: typeof lowerer.diags = [];
    lowerer.diagSink = diagnostics;
    let value: IrExpr | null;
    try {
      value = tryLowerExpression(lowerer, arg);
    } finally {
      lowerer.diagSink = saved;
    }
    // Direct inferred helpers can receive native callbacks even when their
    // result is an opaque handle that cannot cross checked storage. The
    // argument's own lowering then takes this value instead of lowering
    // the closure a second time.
    if (diagnostics.length === 0 && value?.type.kind === "func") {
      lowerer.speculatedClosures.set(arg, {
        ctx: lowerer.ctx,
        bindings: lowerer.typeParamBindings,
        value,
      });
      return value.type;
    }
  }
  if (arg.kind === ts.SyntaxKind.ThisKeyword) return lowerer.resolveThis()?.type ?? null;
  if (ts.isAwaitExpression(arg)) {
    const awaited = storedImplicitArgumentType(lowerer, arg.expression);
    return awaited?.kind === "promise" ? awaited.inner : awaited;
  }
  if (
    ts.isObjectLiteralExpression(arg) &&
    isJsSourceFile(ts.getSourceFileOfNode(arg)) &&
    (arg.properties.nodes.length === 0 ||
      arg.properties.nodes.some(
        (property) =>
          ts.isMethodDeclaration(property) ||
          ts.isAccessor(property) ||
          (!ts.isSpreadAssignment(property) &&
            property.name !== undefined &&
            ts.isComputedPropertyName(property.name)),
      ))
  )
    return DYN;
  if (ts.isIdentifier(arg))
    return lowerer.peekLocal(arg)?.type ?? lowerer.globalOf(arg)?.type ?? null;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(arg)) &&
    (ts.isPropertyAccessExpression(arg) || ts.isElementAccessExpression(arg))
  ) {
    // Mutable JS members can retain an initializer-only checker type (for
    // example a linked-list slot initially null). Specialize to the value
    // we actually represent, rather than checking it back into that type.
    const represented = tryLowerExpression(lowerer, arg);
    if (represented) return represented.type;
  }
  if (
    isJsSourceFile(ts.getSourceFileOfNode(arg)) &&
    (ts.isCallExpression(arg) ||
      ts.isConditionalExpression(arg) ||
      (ts.isBinaryExpression(arg) &&
        (arg.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          arg.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          arg.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)))
  ) {
    // Calls and fallback expressions can retain checked storage wider than
    // the checker's inference (for example Object.assign on a JS instance).
    const represented = tryLowerExpression(lowerer, arg);
    if (represented?.type.kind === "dyn" || represented?.type.kind === "func")
      return represented.type;
  }
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
    const callee = storedImplicitArgumentType(lowerer, arg.expression);
    if (callee?.kind === "dyn") return DYN;
    if (callee?.kind === "func") return callee.ret;
    return lowerer.fnSigOf(arg.expression)?.returnType ?? null;
  }
  return null;
}

/** The instance a CALL of an implicit-any function-like names: each
 * bindable implicit param takes the call's WIDENED argument checker type
 * when it maps statically (DYN otherwise — today's slot), typed params
 * keep their declared shapes, and the param-type tuple is the
 * instantiation key. New keys lower EAGERLY (return inference — see the
 * section comment); a same-key re-demand mid-lowering pins the fallback
 * return type. */
export function implicitCallInstance(
  lowerer: Lowerer,
  call: ts.CallExpression,
  info: GenericFnInfo,
): GenericInstance {
  const shapes: ParamShape[] = [];
  const argTypes = new Map<ts.Symbol, ts.Type>();
  const patterns = (info.implicitPatterns ??= implicitPatternsOf(lowerer, info.decl));
  /** The destructured names' bound types, which the object's own
   * representation does not always carry. */
  const patternKey: string[] = [];
  info.decl.parameters.nodes.forEach((param, i) => {
    const pattern = patterns[i];
    const patternArg = call.arguments.nodes[i];
    if (pattern && patternArg && !ts.isSpreadElement(patternArg)) {
      // The argument's object type binds each destructured name, so a
      // class passed as `{ Base }` keeps its static class type.
      const bound = implicitPatternBinding(lowerer, info.decl, pattern, patternArg);
      if (bound) {
        for (const [symbol, type] of bound.types) {
          argTypes.set(symbol, type);
          const mapped = lowerer.mapTypeOf(type);
          patternKey.push(mapped ? typeKey(mapped) : "?");
        }
        shapes.push({ type: bound.record, mode: "required" });
        return;
      }
    }
    const sym = info.implicitParams![i];
    if (!sym) {
      shapes.push(lowerer.paramShape(param));
      return;
    }
    let bound: IrType = DYN;
    const declared = lowerer.paramShape(param);
    if ((lowerer.typeOf(param.name).flags & ts.TypeFlags.Any) === 0) bound = declared.type;
    const arg = call.arguments.nodes[i];
    if (arg && !ts.isSpreadElement(arg)) {
      const stored = storedImplicitArgumentType(lowerer, arg);
      if (stored?.kind === "dyn") {
        bound = DYN;
        argTypes.set(sym, lowerer.checker.getUnknownType());
        shapes.push({ type: bound, mode: "required" });
        return;
      }
      // `this` in a static method specialized for its receiver class is
      // that class: bind it as a call naming the class would.
      if (stored?.kind === "classval" && arg.kind === ts.SyntaxKind.ThisKeyword) {
        const classDecl = lowerer.classes.get(stored.className)?.decl;
        const classType = classDecl?.name ? lowerer.typeOf(classDecl.name) : null;
        if (classType) {
          argTypes.set(sym, classType);
          shapes.push({ type: stored, mode: "required" });
          return;
        }
      }
      // A represented native array must keep its storage when a direct
      // inferred helper receives it. Re-boxing a checker-any array would
      // copy it, losing writes (and attempting to read unfilled slots).
      if (stored?.kind === "array") {
        argTypes.set(sym, lowerer.typeOf(arg));
        shapes.push({ type: stored, mode: "required" });
        return;
      }
      if (stored?.kind === "func") {
        // The lowered closure may have an inferred JS destructuring
        // parameter widened from the checker's exact tuple to dyn.
        // Preserve that signature throughout the specialization.
        const checkerType = lowerer.mapTypeOf(lowerer.typeOf(arg));
        argTypes.set(
          sym,
          checkerType && typeEquals(checkerType, stored)
            ? lowerer.typeOf(arg)
            : lowerer.checker.getUnknownType(),
        );
        shapes.push({ type: stored, mode: "required" });
        return;
      }
      // The argument's own checker type, literal-widened ('add' binds
      // string) — typeOf consults the ACTIVE instance's bindings, so a
      // bound param forwarded into another implicit call transitively
      // instantiates it (this._initCommandGroup(command)).
      const t = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(arg));
      const mapped =
        (neverTaintedJsType(lowerer, arg, t) ? null : lowerer.mapTypeOf(t)) ??
        dynFallbackType(lowerer, arg, t);
      if (
        isJsSourceFile(ts.getSourceFileOfNode(arg)) &&
        ts.isArrayLiteralExpression(arg) &&
        mapped?.kind === "array" &&
        (mapped.elem.kind === "classval" ||
          (mapped.elem.kind === "union" &&
            lowerer.unions.get(mapped.elem.unionId)?.arms.every((arm) => arm.kind === "classval")))
      ) {
        argTypes.set(sym, lowerer.checker.getUnknownType());
        shapes.push({ type: DYN, mode: "required" });
        return;
      }
      // JavaScript arguments-based callables travel as checked functions.
      // Specializing a parameter to the inferred rest signature would
      // require extracting a native variadic ABI that the value does not
      // expose. Its checked invocation preserves the complete argument pack.
      if (mapped?.kind === "func" && mapped.rest === true && mapped.restAbi === undefined) {
        argTypes.set(sym, lowerer.checker.getUnknownType());
        shapes.push({ type: DYN, mode: "required" });
        return;
      }
      // JS inference can absorb heterogeneous loop values into `{}`.
      // That checker supertype is not an empty-record runtime layout:
      // preserve represented arms through the checked boundary instead
      // of specializing a call to a union that would discard them.
      if (
        isJsSourceFile(ts.getSourceFileOfNode(arg)) &&
        mapped?.kind === "func" &&
        !lowerer.dynConvertible(mapped)
      ) {
        argTypes.set(sym, lowerer.checker.getUnknownType());
        shapes.push({ type: DYN, mode: "required" });
        return;
      }
      const mappedArms =
        mapped?.kind === "union"
          ? (lowerer.unions.get(mapped.unionId)?.arms ?? [])
          : mapped
            ? [mapped]
            : [];
      const hasTopObject = mappedArms.some((arm) => {
        const shape = arm.kind === "record" ? lowerer.shapes.get(arm.shapeId) : undefined;
        return shape && !shape.tuple && !shape.indexValue && shape.fields.length === 0;
      });
      if (
        stored?.kind === "union" &&
        hasTopObject &&
        lowerer.dynConvertible(stored) &&
        lowerer.unions
          .get(stored.unionId)
          ?.arms.some(
            (arm) =>
              !isUnitType(arm) &&
              !mappedArms.some((target) => lowerer.widthLiftPlan(arm, target) !== null),
          )
      ) {
        argTypes.set(sym, lowerer.checker.getUnknownType());
        shapes.push({ type: DYN, mode: "required" });
        return;
      }
      if (
        ts.isArrowFunction(arg) &&
        arg.type === undefined &&
        mapped?.kind === "func" &&
        promiseCarriesDyn(lowerer, mapped.ret)
      ) {
        bound = { ...mapped, ret: DYN };
        lowerer.runtimeOptionalFunctionReturns.set(arg, DYN);
        argTypes.set(sym, t);
      } else if (mapped?.kind === "dyn") {
        bound = DYN;
        argTypes.set(sym, t);
      } else if (bindableImplicitIr(mapped)) {
        bound = mapped;
        argTypes.set(sym, t);
      }
    }
    shapes.push({ type: bound, mode: "required" });
  });
  return internImplicitInstance(lowerer, call, info, shapes, argTypes, patternKey.join(","));
}

/** The all-dyn DEFAULT instance — today's compiled body exactly: what a
 * VALUE reference of an implicit-any function names (indirect calls
 * carry no per-site types to bind). */
export function implicitDefaultInstance(
  lowerer: Lowerer,
  blame: ts.Node,
  info: GenericFnInfo,
): GenericInstance {
  const shapes: ParamShape[] = info.decl.parameters.nodes.map((param, i) =>
    info.implicitParams![i] ? { type: DYN, mode: "required" as const } : lowerer.paramShape(param),
  );
  const argTypes = new Map<ts.Symbol, ts.Type>();
  // Newly bindable nominal class parameters must not retain their JSDoc
  // receiver type in the checked fallback. Keep existing broad JS inference.
  for (let i = 0; i < info.decl.parameters.nodes.length; i++) {
    const symbol = info.implicitParams?.[i];
    const kind = lowerer.mapTypeOf(lowerer.typeOf(info.decl.parameters.nodes[i]!.name))?.kind;
    if (symbol && (kind === "object" || kind === "array")) {
      argTypes.set(symbol, lowerer.checker.getUnknownType());
    }
  }
  return internImplicitInstance(lowerer, blame, info, shapes, argTypes);
}

export function internImplicitInstance(
  lowerer: Lowerer,
  blame: ts.Node,
  info: GenericFnInfo,
  shapes: ParamShape[],
  argTypes: Map<ts.Symbol, ts.Type>,
  patternKey = "",
  declaredReturn?: IrType,
): GenericInstance {
  return internImplicitInstanceOr(
    lowerer,
    blame,
    info,
    shapes,
    argTypes,
    patternKey,
    declaredReturn,
    false,
  )!;
}

/** internImplicitInstance; with `fallible`, a body that does not lower
 * leaves no instance and no diagnostics, and the answer is null (the caller
 * keeps its own lowering). */
export function internImplicitInstanceOr(
  lowerer: Lowerer,
  blame: ts.Node,
  info: GenericFnInfo,
  shapes: ParamShape[],
  argTypes: Map<ts.Symbol, ts.Type>,
  patternKey: string,
  declaredReturn: IrType | undefined,
  fallible: boolean,
): GenericInstance | null {
  const key = shapes.map((s) => typeKey(s.type)).join(",") + (patternKey ? `|${patternKey}` : "");
  let inst = info.instances.get(key);
  if (inst?.implicitState === "failed") {
    if (fallible) return null;
    lowerer.unsupported("SC1090", blame, `the failed specialization of '${info.baseName}'`);
  }
  if (inst) {
    // A recursive caller has observed this ABI before inference settles.
    // Keep the promised return slot and coerce the completed body's returns.
    if (inst.implicitState === "lowering") inst.returnPinned = true;
    return inst;
  }
  const path = extendInstantiationPath(lowerer.genericInstantiationPath, info.decl);
  if (!path) {
    lowerer.unsupported(
      "SC1090",
      blame,
      `unbounded implicit-any instantiation ('${info.baseName}' exceeded ` +
        `${MAX_INSTANTIATION_RECURSION} recursive specializations on one demand path)`,
    );
  }
  const rendered = shapes.map((s) => lowerer.fmt(s.type)).join(", ");
  const dynamicBroadPromise = info.decl.parameters.nodes.some(
    (param, index) =>
      info.implicitParams?.[index] !== null &&
      info.implicitParams?.[index] !== undefined &&
      shapes[index]?.type.kind === "dyn" &&
      broadPromiseParam(lowerer, lowerer.typeOf(param.name)),
  );
  const declared =
    declaredReturn ?? (dynamicBroadPromise ? null : implicitDeclaredReturn(lowerer, info));
  inst = {
    path,
    name: keyedHelperName(lowerer, `${info.qualifiedName}%`, key, ""),
    ordinal: info.instances.size,
    params: shapes,
    // The promise callers rely on before the body settles it: the
    // declared truth when it maps, else DYN (the recursion pin — and
    // exactly today's checked-dynamic result slot).
    returnType: declared ?? DYN,
    bindings: new Map(),
    typeArgsText: `(${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered})`,
    implicitArgTypes: argTypes,
    implicitState: "lowering",
    ...(declared === null ? { implicitInferReturn: true as const } : {}),
  };
  info.instances.set(key, inst);
  // Eager lowering settles the return ABI before callers use it. A failed
  // JS body must still have a throwing implementation: later references
  // (including recursive ones) can already hold its cached signature.
  const diagsBefore = lowerer.diags.length;
  const fencesBefore = lowerer.runtimeFences.length;
  const totalBefore = lowerer.stats.statementsTotal;
  const failedBefore = lowerer.stats.statementsFailed;
  const skippedBefore = lowerer.stats.functionsSkipped;
  const blockedBefore = fallible ? new Set(lowerer.blockedBindings) : null;
  const deferredBefore = fallible ? new Set(lowerer.deferredDiags.keys()) : null;
  /** Undoes what a failed fallible body recorded: the instance's
   * statements share their symbols with the declaration's own body. */
  const rollback = (): void => {
    lowerer.diags.splice(diagsBefore);
    lowerer.runtimeFences.splice(fencesBefore);
    lowerer.stats.statementsTotal = totalBefore;
    lowerer.stats.statementsFailed = failedBefore;
    lowerer.stats.functionsSkipped = skippedBefore;
    for (const symbol of [...lowerer.blockedBindings])
      if (!blockedBefore!.has(symbol)) lowerer.blockedBindings.delete(symbol);
    for (const symbol of [...lowerer.deferredDiags.keys()])
      if (!deferredBefore!.has(symbol)) lowerer.deferredDiags.delete(symbol);
  };
  // The instance is cached even when a receiver probe requested it.
  // Its body must retain statement fences instead of dropping failures
  // into that probe's temporary diagnostic sink and caching empty code.
  const previousSink = lowerer.diagSink;
  lowerer.diagSink = null;
  try {
    // Implicit-any instances lower EAGERLY at the call site so their
    // inferred return type is available immediately. They therefore do
    // not pass through emitReachable's queued generic-instance wave,
    // which normally batches checker work before lowering a body. Prime
    // this exact committed instance body here; repeated instantiations of
    // the same declaration find the facade memos warm.
    lowerer.checker.prefetchRoots([
      ...info.decl.parameters.nodes.flatMap((param) =>
        param.initializer ? [param.initializer] : [],
      ),
      ...(info.decl.body ? [info.decl.body] : []),
    ]);
    const fn = lowerer.lowerGenericInstance(info, inst);
    if (
      fallible &&
      (lowerer.diags.length > diagsBefore || lowerer.runtimeFences.length > fencesBefore)
    ) {
      inst.implicitState = "failed";
      rollback();
      return null;
    }
    lowerer.implicitFns.push(fn);
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
    inst.implicitState = "failed";
    if (fallible) {
      rollback();
      return null;
    }
    const types: IrType[] = shapes.map((shape) => shape.type);
    if (info.member?.kind === "method")
      types.unshift({ kind: "object", className: info.member.cls.def.name });
    const fn = lowerer.deferToRuntimeFence(diagsBefore, info.decl, {
      kind: "function",
      name: inst.name,
      returnType: inst.returnType,
      params: types.map((type, index) => ({ localId: `p.${index}`, name: `p${index}`, type })),
    });
    if (!fn) throw e;
    lowerer.implicitFns.push(fn);
  } finally {
    lowerer.diagSink = previousSink;
  }
  inst.implicitState = "done";
  return inst;
}

/** The implicit-any twin of bindingGenericFnNodeOf, for LOCAL and module
 * bindings alike (`const knownBy = (cmd) => [cmd.name()].concat(...)`
 * inside a method body — commander's _registerCommand shape): the
 * initializer function-like when the WHOLE declaration qualifies for
 * implicit monomorphization, else null — non-qualifying shapes keep
 * today's closure story without a diagnostic (no fence: the flag must not make
 * working code worse). Qualification: an npm-static JS file, a const (or
 * never-reassigned, never-redeclared) identifier binding, an
 * arrow/function-expression initializer with bindable implicit-any
 * params, and a body with NO captures — no `this`/`super`, and no
 * reference to a function-scoped declaration outside itself (compiled
 * instances are module functions; module-scope references are fine).
 * Cached per declaration on lowerer.implicitLocalFns. */
export function implicitLocalFnNodeOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): ts.FunctionExpression | ts.ArrowFunction | null {
  const cached = lowerer.implicitLocalFns.get(decl);
  if (cached !== undefined)
    return cached ? (cached.decl as ts.FunctionExpression | ts.ArrowFunction) : null;
  const probe = (): ts.FunctionExpression | ts.ArrowFunction | null => {
    if (!implicitMonoFile(ts.getSourceFileOfNode(decl))) return null;
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return null;
    if (init.typeParameters !== undefined || init.body === undefined) return null;
    if (!implicitAnyParamSymbolsOf(lowerer, init)) return null;
    const sym = lowerer.checker.getSymbolAtLocation(decl.name);
    if (!sym) return null;
    const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
    const redeclared = sym.declarations.some(
      (d) => d !== decl && ts.isVariableDeclaration(d) && d.initializer !== undefined,
    );
    if (redeclared) return null;
    if (!isConst && !bindingNeverReassigned(lowerer, sym, decl)) return null;
    // Instances are module functions with no frame.
    return capturesEnclosingFrame(lowerer, init, decl, init.body) ? null : init;
  };
  const node = probe();
  if (node === null) {
    lowerer.implicitLocalFns.set(decl, null);
    return null;
  }
  return node;
}

/** True when `fn`, bound by `decl`, uses its enclosing function's frame
 * somewhere in `scope`: `this`, `super`, `arguments` or `new.target`, or
 * a value or type declared in an enclosing function (a local, a parameter,
 * an enclosing generic's type parameter). Module-scope declarations and
 * the binding itself are reachable from the module functions the
 * instances compile to. */
function capturesEnclosingFrame(
  lowerer: Lowerer,
  fn: ts.FunctionExpression | ts.ArrowFunction,
  decl: ts.VariableDeclaration,
  scope: ts.Node,
): boolean {
  const file = ts.getSourceFileOfNode(decl);
  const self = lowerer.checker.getSymbolAtLocation(decl.name);
  let captures = false;
  const scan = (n: ts.Node): void => {
    if (captures) return;
    if (
      n.kind === ts.SyntaxKind.ThisKeyword ||
      n.kind === ts.SyntaxKind.SuperKeyword ||
      ts.isMetaProperty(n)
    ) {
      // Arrow bodies see the ENCLOSING this; function expressions
      // rebind their own — but a bare `this` there is untyped JS
      // dynamism either way. Reject both, cheaply and soundly.
      captures = true;
      return;
    }
    if (ts.isIdentifier(n)) {
      const s = lowerer.checker.getSymbolAtLocation(n);
      if (s === undefined) {
        if (n.text === "arguments") captures = true;
      } else if (s !== self) {
        for (const d of s.declarations) {
          if (ts.getSourceFileOfNode(d) !== file || (d.pos >= fn.pos && d.end <= fn.end)) continue;
          // Declared outside the function, in this file: a capture
          // exactly when some enclosing FUNCTION scope declares it.
          for (
            let p: ts.Node | undefined = d.parent;
            p !== undefined && !ts.isSourceFile(p);
            p = p.parent
          ) {
            if (ts.isFunctionLike(p)) {
              captures = true;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(scope);
  return captures;
}

/** Registers (or returns) the GenericFnInfo of a qualifying implicit-any
 * function-value binding — implicitLocalFnNodeOf's companion, the
 * bindingGenericFnInfoOf shape: the info enters genericFnsBySymbol under
 * the binding's symbol (and a named function expression's inner name),
 * so calls and value references resolve through genericFnOf; the
 * declaration statement emits nothing and the binding has no runtime
 * value. The declaration's source position joins the qualified name —
 * two same-named locals in one file stay distinct. */
export function implicitLocalFnInfoOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  fnNode: ts.FunctionExpression | ts.ArrowFunction,
): GenericFnInfo {
  const existing = lowerer.implicitLocalFns.get(decl);
  if (existing) return existing;
  const name = (decl.name as ts.Identifier).text;
  const sym = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!sym) lowerer.unsupported("SC1090", decl.name, "this binding form");
  const implicit = implicitAnyParamSymbolsOf(lowerer, fnNode);
  if (!implicit) lowerer.unsupported("SC1090", fnNode, "this function form"); // defensive: the probe proved it
  const stmt = decl.parent?.parent;
  const info: GenericFnInfo = {
    decl: fnNode,
    baseName: name,
    qualifiedName: lowerer.qualify(
      ts.getSourceFileOfNode(decl),
      nsPathPrefix(lowerer, stmt ?? decl, decl) + `${name}%l${positionTag(lowerer, decl)}`,
    ),
    typeParams: [],
    instances: new Map(),
    implicitParams: implicit,
  };
  lowerer.implicitLocalFns.set(decl, info);
  lowerer.genericFnsBySymbol.set(sym, info);
  if (ts.isFunctionExpression(fnNode) && fnNode.name !== undefined) {
    const inner = lowerer.checker.getSymbolAtLocation(fnNode.name);
    if (inner) lowerer.genericFnsBySymbol.set(inner, info);
  }
  return info;
}

/** The function-like node behind an object-literal generic-method member:
 * the MethodDeclaration itself (`{ m<T>(x: T) {...} }`) or a generic
 * arrow/function-expression property's initializer (`{ m: <T>(x: T) =>
 * ... }`). Null when the property's declaration isn't that shape. */
export function objLitGenericFnNodeOf(
  lowerer: Lowerer,
  propSym: ts.Symbol,
): {
  fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;
  literal: ts.ObjectLiteralExpression;
} | null {
  const decl = propSym.valueDeclaration;
  if (!decl) return null;
  if (ts.isMethodDeclaration(decl) && ts.isObjectLiteralExpression(decl.parent)) {
    return decl.typeParameters !== undefined && decl.body !== undefined
      ? { fnNode: decl, literal: decl.parent }
      : null;
  }
  if (ts.isPropertyAssignment(decl) && ts.isObjectLiteralExpression(decl.parent)) {
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (
      (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
      init.typeParameters !== undefined &&
      init.body !== undefined
    ) {
      return { fnNode: init, literal: decl.parent };
    }
  }
  return null;
}

/** The interned GenericFnInfo for one object-literal generic method, with
 * the supportability fences applied ONCE per declaration: the defining
 * literal must sit at module scope (the compiled instance is a plain
 * module function — an enclosing frame would need captures), and
 * async/generator forms keep the method fences. The name is source-
 * position-derived (`%ol<start>.<name>`, qualified per file) —
 * deterministic across the discovery and emit passes. */
export function objLitGenericFnInfoOf(
  lowerer: Lowerer,
  blame: ts.Node,
  name: string,
  found: {
    fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;
    literal: ts.ObjectLiteralExpression;
  },
): GenericFnInfo {
  const { fnNode, literal } = found;
  const existing = lowerer.objLitGenericFns.get(fnNode);
  if (existing) return existing;
  if (fnNode.asteriskToken) lowerer.unsupported("SC1071", blame);
  if (fnNode.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    lowerer.unsupported("SC1090", blame, "async object-literal generic methods");
  }
  // `this` is the receiver object — records don't model it (the
  // lowerObjectLiteral fence, applied at registration because
  // arrow/function-expression properties skip that walk and the compiled
  // instances are plain module functions).
  if (fnNode.body) lowerer.rejectThisInObjectMethod(fnNode.body);
  for (let n: ts.Node | undefined = literal.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n)) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `object-literal generic methods declared inside functions (the compiled instantiations of '${name}' are module functions and cannot capture the enclosing frame — declare the object at module scope)`,
      );
    }
  }
  const typeParams = declaredTypeParameterSymbols(
    lowerer,
    fnNode.typeParameters!.nodes,
    blame,
    "this method form",
  );
  checkGenericParameterNames(lowerer, fnNode.parameters.nodes, false);
  const info: GenericFnInfo = {
    decl: fnNode,
    baseName: name,
    qualifiedName: lowerer.qualify(
      ts.getSourceFileOfNode(fnNode),
      `%ol${positionTag(lowerer, fnNode)}.${name}`,
    ),
    typeParams,
    instances: new Map(),
    objectLiteral: true,
  };
  lowerer.objLitGenericFns.set(fnNode, info);
  return info;
}

/** The generic function-like INITIALIZER behind a binding declaration —
 * `const f = <T>(x: T) => x` or `const f = function g<T>(x: T) {...}`
 * (parens stripped). Null when the declaration isn't that shape; the
 * SHAPE only — whether the binding qualifies (module scope, never
 * reassigned) is bindingGenericFnInfoOf's business. */
export function bindingGenericFnNodeOf(
  decl: ts.VariableDeclaration,
): ts.FunctionExpression | ts.ArrowFunction | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  // Assertion wrappers strip like parens: `const r = (<T>(x: T) => x) as
  // Mapper` evaluates the arrow — the cast only renames its type.
  const init = stripValueWrappers(decl.initializer);
  if (
    (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
    init.typeParameters !== undefined &&
    init.body !== undefined
  ) {
    return init;
  }
  return null;
}

/** The CONTEXTUAL twin of bindingGenericFnNodeOf: `const g: Mapper = (x)
 * => x` where `type Mapper = <T>(x: T) => T` — the initializer declares
 * no type parameters of its own, but the ANNOTATION's one call signature
 * does, and the checker types the arrow's parameters by those (`x: T`).
 * Such a binding monomorphizes exactly like `const g = <T>(x: T) => x`;
 * bindingGenericFnInfoOf reads the type parameters off the annotation's
 * signature. Null when the shape doesn't match (a concrete annotation, a
 * generic arrow — the syntactic probe's case, an overloaded alias). */
export function bindingContextualGenericFnNodeOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): ts.FunctionExpression | ts.ArrowFunction | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  // The generic signature can arrive as an ANNOTATION or as a type
  // ASSERTION on the initializer (`var r = < <T>(x: T) => T >((x) => x)`
  // — the checker contextually types the operand's parameters by the
  // asserted signature exactly like an annotation would).
  const asserted = ts.isAsExpression(decl.initializer) || ts.isTypeAssertion(decl.initializer);
  if (decl.type === undefined && !asserted) return null;
  const init = stripValueWrappers(decl.initializer);
  if (
    !(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ||
    init.typeParameters !== undefined ||
    init.body === undefined
  ) {
    return null;
  }
  const sigs = lowerer.checker.getCallSignatures(lowerer.typeOf(decl.name));
  if (sigs.length !== 1 || sigs[0]!.getTypeParameters().length === 0) return null;
  return init;
}

/** The interned GenericFnInfo for one generic arrow/function-expression
 * binding initializer, with the supportability fences applied ONCE per
 * declaration: the binding must sit at module scope (the compiled
 * instances are plain module functions — an enclosing frame would need
 * captures) and must provably HOLD the initializer once initialized — a
 * const, or a let/var nothing in its declaring file ever writes (ESM
 * import bindings are read-only, so the file scan is the whole story;
 * observing the UNINITIALIZED state needs a hoisted early call, the
 * same temporal hole const TDZ leaves — the object-literal generic-
 * method receiver stance). Successful registration enters the info
 * in genericFnsBySymbol under the binding's symbol — and under a named
 * function expression's own inner name (it binds itself inside the
 * body, the class-expression rule) — so every genericFnOf consumer
 * (calls, pinned values, instantiation expressions, namespace and CJS
 * member paths) resolves it like a top-level generic declaration. */
export function bindingGenericFnInfoOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  fnNode: ts.FunctionExpression | ts.ArrowFunction,
): GenericFnInfo {
  const existing = lowerer.bindingGenericFns.get(fnNode);
  if (existing) return existing;
  const name = (decl.name as ts.Identifier).text;
  if (fnNode.asteriskToken) lowerer.unsupported("SC1071", fnNode);
  // Inside a function, the compiled instances are module functions, so
  // the initializer may not use the enclosing frame.
  let functionScoped = false;
  for (
    let n: ts.Node | undefined = decl.parent;
    n !== undefined && !ts.isSourceFile(n);
    n = n.parent
  ) {
    if (ts.isFunctionLike(n)) {
      if (capturesEnclosingFrame(lowerer, fnNode, decl, fnNode)) {
        lowerer.unsupported(
          "SC1090",
          fnNode,
          `generic arrow/function-expression bindings that use the frames of their enclosing functions (the compiled instantiations of '${name}' are module functions and cannot capture its locals, parameters, type parameters or 'this' — pass them as arguments, or declare the binding at module scope)`,
        );
      }
      functionScoped = true;
      break;
    }
  }
  const sym = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!sym) lowerer.unsupported("SC1090", decl.name, "this binding form");
  requireStableGenericBinding(lowerer, decl, sym, name);
  const typeParams: ts.Symbol[] = [];
  if (fnNode.typeParameters !== undefined) {
    typeParams.push(
      ...declaredTypeParameterSymbols(
        lowerer,
        fnNode.typeParameters.nodes,
        fnNode,
        "this function form",
      ),
    );
  } else {
    // The CONTEXTUAL shape (bindingContextualGenericFnNodeOf): the type
    // parameters live on the annotation's one call signature, and the
    // checker types the initializer's parameters by them — the same
    // symbols the instance bodies resolve through.
    const sigs = lowerer.checker.getCallSignatures(lowerer.typeOf(decl.name));
    const tps = sigs.length === 1 ? sigs[0]!.getTypeParameters() : [];
    if (tps.length === 0) lowerer.unsupported("SC1090", fnNode, "this function form");
    for (const tp of tps) {
      const tpSym: ts.Symbol | undefined = tp.getSymbol();
      if (!tpSym) lowerer.unsupported("SC1090", fnNode, "this function form");
      typeParams.push(tpSym);
    }
  }
  checkGenericParameterNames(lowerer, fnNode.parameters.nodes, true);
  const stmt = decl.parent?.parent; // declarator → list → statement (nsPathPrefix wants the statement)
  // A binding in a function or block can share its name with another; its
  // instances take the declaration's position.
  const topLevel =
    stmt?.parent !== undefined && (ts.isSourceFile(stmt.parent) || ts.isModuleBlock(stmt.parent));
  const info: GenericFnInfo = {
    decl: fnNode,
    baseName: name,
    qualifiedName: lowerer.qualify(
      ts.getSourceFileOfNode(decl),
      nsPathPrefix(lowerer, stmt ?? decl, decl) +
        (topLevel ? name : `${name}%l${ts.tokenStartOfNode(decl)}`),
    ),
    typeParams,
    instances: new Map(),
    ...(functionScoped ? { functionScoped: true as const } : {}),
    bindingDecl: decl,
  };
  lowerer.bindingGenericFns.set(fnNode, info);
  lowerer.genericFnsBySymbol.set(sym, info);
  // Module-scope uses resolve to the instances from the start, so those
  // that can run first need the flag. Inside a function the declaration
  // registers before any later use lowers, and earlier uses read a TDZ
  // box (genericBindingStoredValue).
  if (!functionScoped) {
    const presence = bindingPresenceOf(lowerer, info, decl, sym);
    if (presence !== undefined) info.presence = presence;
  }
  if (ts.isFunctionExpression(fnNode) && fnNode.name !== undefined) {
    const inner = lowerer.checker.getSymbolAtLocation(fnNode.name);
    if (inner) lowerer.genericFnsBySymbol.set(inner, info);
  }
  return info;
}

/** Whether `use`, a reference to the binding `info` declares, can only
 * run after the declaration has run: it follows the declaration in its
 * statement list (closures count where they are created), sits inside the
 * initializer itself, or is inside a function declaration whose every
 * reference does. References from other modules run after this module's
 * body, and export specifiers only export. A use the check cannot place
 * answers false. */
export function runsAfterDeclaration(lowerer: Lowerer, info: GenericFnInfo, use: ts.Node): boolean {
  const decl = info.bindingDecl;
  if (decl === undefined) return true;
  info.ordering ??= new Map();
  return useRunsAfter(lowerer, decl, use, info.ordering, new Set());
}

function useRunsAfter(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  use: ts.Node,
  memo: Map<ts.Node, boolean>,
  inProgress: Set<ts.Node>,
): boolean {
  if (ts.getSourceFileOfNode(use) !== ts.getSourceFileOfNode(decl)) return true;
  const init = decl.initializer;
  if (init !== undefined && use.pos >= init.pos && use.end <= init.end) return true;
  const stmt = decl.parent?.parent;
  const list = stmt?.parent;
  if (stmt === undefined || list === undefined) return false;
  for (let n: ts.Node = use; n.parent !== undefined; n = n.parent) {
    if (n.parent === list) return n === stmt ? use.pos >= decl.end : n.pos >= stmt.end;
    if (ts.isFunctionDeclaration(n)) return functionRunsAfter(lowerer, decl, n, memo, inProgress);
  }
  return false;
}

/** Whether every call of the function declaration `fn` runs after `decl`
 * has run. A function in progress counts as running after: its calls of
 * itself, directly or through other functions, add no earlier caller.
 * Only answers that depend on no function in progress are memoized. */
function functionRunsAfter(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  fn: ts.FunctionDeclaration,
  memo: Map<ts.Node, boolean>,
  inProgress: Set<ts.Node>,
): boolean {
  const known = memo.get(fn);
  if (known !== undefined) return known;
  if (inProgress.has(fn)) return true;
  // `export default function () {}`: only importers call it, after this
  // module's body has run.
  if (fn.name === undefined) return true;
  inProgress.add(fn);
  let result = true;
  try {
    const symbol = lowerer.checker.getSymbolAtLocation(fn.name);
    if (symbol === undefined) result = false;
    else {
      for (const ref of bindingReferences(lowerer, ts.getSourceFileOfNode(fn), symbol, fn.name)) {
        if (ref.pos >= fn.pos && ref.end <= fn.end) continue;
        if (!useRunsAfter(lowerer, decl, ref, memo, inProgress)) {
          result = false;
          break;
        }
      }
    }
  } finally {
    inProgress.delete(fn);
  }
  if (inProgress.size === 0) memo.set(fn, result);
  return result;
}

/** The value references of `symbol` in `file` other than `name` (its
 * declaration name): identifiers spelled like it that resolve to it,
 * outside type positions and export specifiers. */
function bindingReferences(
  lowerer: Lowerer,
  file: ts.SourceFile,
  symbol: ts.Symbol,
  name: ts.Identifier,
): ts.Identifier[] {
  let byName = lowerer.bindingIdentifiers.get(file);
  if (byName === undefined) {
    byName = new Map();
    lowerer.bindingIdentifiers.set(file, byName);
  }
  let idents = byName.get(name.text);
  if (idents === undefined) {
    const found: ts.Identifier[] = [];
    ts.walkPreorder(file, (node) => {
      if (ts.isIdentifier(node) && node.text === name.text) found.push(node);
      return undefined;
    });
    lowerer.checker.prefetchSymbolNodesExact(found);
    byName.set(name.text, found);
    idents = found;
  }
  return idents.filter((ident) => {
    if (ident === name) return false;
    const parent = ident.parent;
    if (parent === undefined || ts.isExportSpecifier(parent) || ts.isExportAssignment(parent))
      return false;
    let resolved = lowerer.checker.getSymbolAtLocation(ident);
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === ident)
      resolved = lowerer.checker.getShorthandAssignmentValueSymbol(parent) ?? resolved;
    if (resolved !== symbol) return false;
    for (let p: ts.Node | undefined = parent; p !== undefined; p = p.parent) {
      if (
        ts.isTypeNode(p) &&
        p.kind !== ts.SyntaxKind.ExpressionWithTypeArguments &&
        !isHeritageTypeReference(p)
      )
        return false;
      if (ts.isStatement(p) || ts.isFunctionLike(p)) break;
    }
    return true;
  });
}

/** The presence flag of a module-scope generic binding that code can use
 * before its declaration runs (a hoisted function or an earlier closure
 * called during module evaluation), or undefined when every use runs
 * after it. The declaration statement sets the flag. */
function bindingPresenceOf(
  lowerer: Lowerer,
  info: GenericFnInfo,
  decl: ts.VariableDeclaration,
  symbol: ts.Symbol,
): GenericFnInfo["presence"] {
  const name = decl.name as ts.Identifier;
  const early = bindingReferences(lowerer, ts.getSourceFileOfNode(decl), symbol, name).some(
    (ref) => !runsAfterDeclaration(lowerer, info, ref),
  );
  if (!early) return undefined;
  const flagId = `%g.${info.qualifiedName}%initialized`;
  lowerer.globalsList.push({ id: flagId, name: "%initialized", type: BOOL, mutable: true });
  return { flagId, lexical: !isVarDeclared(decl) };
}

/** The statement that records a generic binding's declaration as run,
 * for a binding with a presence flag. */
export function genericBindingPresenceStore(
  info: GenericFnInfo,
  decl: ts.VariableDeclaration,
): IrStmt | null {
  if (info.presence === undefined) return null;
  const loc = locOf(decl);
  return {
    kind: "assign",
    localId: info.presence.flagId,
    value: { kind: "boolLit", value: true, type: BOOL, loc },
    loc,
  };
}

/** A call of a generic binding where the binding may not be initialized
 * yet. A `let`/`const` binding in its temporal dead zone throws Node's
 * ReferenceError before the arguments run; an unassigned `var` is
 * undefined, so the arguments run and the call throws "is not a
 * function". Calls that run after the declaration stay direct. */
function guardEarlyBindingCall(
  lowerer: Lowerer,
  info: GenericFnInfo,
  expr: ts.CallExpression,
  call: IrExpr & { kind: "call" },
): IrExpr {
  if (info.bindingDecl === undefined || runsAfterDeclaration(lowerer, info, expr)) return call;
  const loc = call.loc;
  const presence = requirePresence(lowerer, info, expr.expression);
  const flag: IrExpr = { kind: "varRef", localId: presence.flagId, type: BOOL, loc };
  if (presence.lexical)
    return {
      kind: "seqExpr",
      stmts: [tdzCheck(flag, info.baseName, loc)],
      result: call,
      type: call.type,
      loc,
    };
  // Arguments first, in order, then the check: Node evaluates them
  // before it finds the callee is not callable.
  const stmts: IrStmt[] = [];
  const args = call.args.map((arg): IrExpr => {
    const id = `%earlyCallArg.${lowerer.ctx.locals.length}`;
    lowerer.ctx.locals.push({ id, name: "%earlyCallArg", type: arg.type, mutable: false });
    stmts.push({ kind: "varDecl", localId: id, init: arg, loc });
    return { kind: "varRef", localId: id, type: arg.type, loc };
  });
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "ternary",
      cond: flag,
      then: { ...call, args },
      else_: nodeThrowExpr(1, "", `${info.baseName} is not a function`, call.type, loc),
      type: call.type,
      loc,
    },
    type: call.type,
    loc,
  };
}

/** A generic binding read as a value where it may not be initialized
 * yet: a `let`/`const` binding checks its temporal dead zone first. */
function guardEarlyBindingValue(
  lowerer: Lowerer,
  info: GenericFnInfo,
  ref: ts.Expression,
  value: IrExpr,
): IrExpr {
  if (info.bindingDecl === undefined || runsAfterDeclaration(lowerer, info, ref)) return value;
  const presence = requirePresence(lowerer, info, ref);
  if (!presence.lexical)
    lowerer.unsupported(
      "SC1090",
      ref,
      `generic 'var' bindings read as values before their declaration runs (Node reads undefined there; declare '${info.baseName}' with const)`,
    );
  const loc = value.loc;
  const flag: IrExpr = { kind: "varRef", localId: presence.flagId, type: BOOL, loc };
  return {
    kind: "seqExpr",
    stmts: [tdzCheck(flag, info.baseName, loc)],
    result: value,
    type: value.type,
    loc,
  };
}

/** The presence flag a use that can run before the declaration checks.
 * Only module-scope bindings have one: a binding inside a function would
 * need a per-call flag that its closures share. */
function requirePresence(
  lowerer: Lowerer,
  info: GenericFnInfo,
  blame: ts.Node,
): NonNullable<GenericFnInfo["presence"]> {
  if (info.presence !== undefined) return info.presence;
  return lowerer.unsupported(
    "SC1090",
    blame,
    `generic arrow/function-expression bindings declared inside functions that code can call before their declaration runs (the binding '${info.baseName}' is a 'var' in a branch or block, or is called from a place that can run first — declare it with const before its uses)`,
  );
}

function tdzCheck(flag: IrExpr, name: string, loc: SrcLoc): IrStmt {
  return {
    kind: "exprStmt",
    expr: {
      kind: "intrinsic",
      name: "module.tdzCheck",
      args: [flag, { kind: "strLit", value: name, type: STRING, loc }],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** `const h = id` — a binding ALIASING a generic function (a top-level
 * declaration, a registered generic binding, or another alias — resolved
 * left to right in declaration order). The alias registers the SAME info
 * under its own symbol, so calls (`h(3)`) and pinned values (`take(h)`)
 * resolve exactly like the target's own name, and the binding itself has
 * no runtime value (a generic function value cannot materialize). Claims
 * only bindings whose OWN type still keeps type parameters — a
 * concrete-annotated alias (`const h: (x: number) => number = id`) is a
 * pinned VALUE, the existing lowerGenericFnValue story. Null when the
 * shape doesn't match or the target isn't a registered generic; fences
 * (reassignment, var redeclaration) report by name inside. */
export function bindingGenericFnAliasInfoOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): GenericFnInfo | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isIdentifier(init)) return null;
  const target = genericFnOf(lowerer, init);
  if (!target) return null;
  // A concrete annotation pins one signature — that value story
  // (lowerGenericFnValue at the reference) stays untouched.
  const ownSigs = lowerer.checker.getCallSignatures(lowerer.typeOf(decl.name));
  if (ownSigs.length === 0 || !ownSigs.every((s) => s.getTypeParameters().length > 0)) return null;
  const sym = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!sym) return null;
  const existing = lowerer.genericFnsBySymbol.get(sym);
  if (existing) return existing;
  const name = decl.name.text;
  requireStableGenericBinding(lowerer, decl, sym, name);
  lowerer.genericFnsBySymbol.set(sym, target);
  return target;
}

/** Static resolution stands in for the receiver's runtime value, so an
 * object-literal generic-method receiver must provably HOLD the defining
 * literal: a direct read of a binding whose initializer IS that literal
 * and that nothing ever reassigns — a const, or a let with no write in
 * its declaring file (ESM import bindings are read-only, so the file
 * scan is the whole story). The read is pure — call and value sites skip
 * evaluating it entirely. A reassignable binding could hold a
 * structurally identical literal with a DIFFERENT body, which static
 * resolution would miss without a diagnostic. */
export function requireObjLitGenericReceiver(
  lowerer: Lowerer,
  blame: ts.Node,
  recvExpr: ts.Expression,
  literal: ts.ObjectLiteralExpression,
  name: string,
): void {
  let recv: ts.Expression = recvExpr;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  const fenceReceiver: () => never = () =>
    lowerer.unsupported(
      "SC1090",
      blame,
      `reaching the object-literal generic method '${name}' through this receiver (resolution is static, so the receiver must be a never-reassigned binding initialized with the defining literal)`,
    );
  if (!ts.isIdentifier(recv)) fenceReceiver();
  const recvSym = lowerer.resolveValueSymbol(recv);
  const recvDecl = recvSym ? recvSym.valueDeclaration : undefined;
  if (
    !recvDecl ||
    !ts.isVariableDeclaration(recvDecl) ||
    !ts.isVariableDeclarationList(recvDecl.parent) ||
    recvDecl.initializer === undefined
  ) {
    fenceReceiver();
  }
  if (
    (recvDecl.parent.flags & ts.NodeFlags.Const) === 0 &&
    !bindingNeverReassigned(lowerer, recvSym!, recvDecl)
  ) {
    fenceReceiver();
  }
  let init: ts.Expression = recvDecl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (init !== literal) fenceReceiver();
}
