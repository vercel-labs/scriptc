import { dynUndefinedExpr, nodeThrowExpr } from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";
/* Class lowering: shape collection over the single-inheritance graph
 * (fields, methods, accessors, overrides), constructor/member lowering with
 * synthesized derived ctors and field initializers, super calls and super
 * accessor access, upcasts, `new` expressions, and the builtin Error
 * hierarchy registration. */
import * as ts from "../ts7/adapter.js";
import type { FnCtx, Lowerer } from "./lowerer.js";
import {
  BOOL,
  DATE_T,
  DYN,
  F64,
  bytesOf,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  JSVAL,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  isSupportedMapKey,
  isSupportedMapValue,
  isSupportedSetElem,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import {
  genericCallInstance,
  implicitAnyParamSymbolsOf,
  implicitCallInstance,
  implicitMonoFile,
  type GenericFnInfo,
} from "./generic-functions.js";
import {
  extendInstantiationPath,
  MAX_INSTANTIATION_RECURSION,
  type InstantiationPath,
} from "./instantiation-path.js";
import { appendImplicitUndefinedReturn, hasExplicitJsDocReturn } from "./function-returns.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import { generatorMeta, type ParamShape } from "./call-signatures.js";
import { omittedArgFor } from "./call-arguments.js";
import {
  isGenericCallableMemberType,
  jsOpenObjectType,
  typeKey,
  withUnitArm,
} from "../type-mapper.js";
import {
  cjsClassExprWholeExportOf,
  isCjsJsFile,
  isJsSourceFile,
  isModuleExportsAccess,
  isNodeTypesPath,
  locOf,
} from "../program.js";
import { PoisonError, dynFallbackType, newFnCtx, own } from "./lowerer.js";
import { lowerArrayConstructor } from "./containers/array-construction.js";
import { lowerMapSeedNew, lowerSetSeedNew } from "./containers/collection-methods.js";
import { lowerObjectConstructor } from "./containers/indexed-objects.js";
import { bufEncoding } from "./containers/bytes.js";
import { isSafeToRepeat } from "./expressions/evaluation-safety.js";
import { lowerSearchParamsNew } from "./builtins/url.js";
import { lowerTextCodecNew } from "./builtins/text-codecs.js";
import {
  requiresDynamicPackageDiag,
  unsupportedDiag,
  type ScrDiagnostic,
} from "../../diagnostics/diagnostic.js";
import {
  STREAM_API_MEMBERS,
  STREAM_PROP_MEMBERS,
  UNDERSCORE_METHODS,
  lowerStreamNew,
  lowerStreamSuperCall,
  streamCtorShape,
} from "./lower-stream.js";
import {
  emitOverrideShapeReason,
  emitSpecSuperForward,
  emitterRooted,
  lowerEmitterSuperCall,
  type EmitOverrideRec,
} from "./lower-event-emitter.js";
import { declSymbolOf } from "./lower-modules.js";
import {
  classSymbolKeyOf,
  classSymbolKeyOfSymbol,
  symbolFieldDisplayName,
} from "./symbol-fields.js";
import { builtinFenceHintOf } from "./surfaces.js";
import { lowerHttpAgentNew, lowerHttpServerNew } from "./lower-server.js";
import {
  ambientNsRootOf,
  ambientUndefReadType,
  ambientUndefVarRootOf,
  ambientUndefinedFnSymbolOf,
  fenceEarlyAliasUse,
  fenceEarlyNsMemberRef,
  nsMemberIdentOf,
  nsUndefRead,
} from "./lower-namespaces.js";
import { mixinResultBindingClassOf, type MixinInstanceInfo } from "./lower-mixins.js";
import { hasLexicalPrivateReference, hasStaticThis, rejectStaticThis } from "./static-this.js";
import { lowerUrlNew } from "./lower-url.js";
import { isNativeProxyInitializer, lowerNativeProxy } from "./expressions/native-proxy.js";
import { classStaticDataFor } from "./class-static-data.js";
import { lowerObjectFactoryNew } from "./object-factory-new.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { lowerInstanceConstructorNew } from "./class-instance-constructor.js";
import { classPrototypeData } from "./class-prototypes.js";
import { checkedClassConstruction, checkedClassConstructionPacked } from "./class-construction.js";
import { initializeRuntimeStatics, hasRuntimeStatics } from "./class-runtime-statics.js";
import { reflectedClassStaticMethodValue } from "./class-method-values.js";

export function returnsOnlyThis(member: ts.MethodDeclaration): boolean {
  const body = member.body;
  const last = body?.statements.at(-1);
  if (!body || !last || !ts.isReturnStatement(last)) return false;
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      let value = node.expression;
      while (value && ts.isParenthesizedExpression(value)) value = value.expression;
      if (!value || value.kind !== ts.SyntaxKind.ThisKeyword) valid = false;
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return valid;
}

function functionLocalClass(decl: ts.ClassLikeDeclaration): boolean {
  for (
    let parent: ts.Node | undefined = decl.parent;
    parent && !ts.isSourceFile(parent);
    parent = parent.parent
  ) {
    if (ts.isFunctionLike(parent)) return true;
  }
  return false;
}

export function storedClassValueType(
  lowerer: Lowerer,
  expression: ts.Expression,
  visiting = new Set<ts.Node>(),
): IrType | null {
  if (visiting.has(expression)) return null;
  visiting.add(expression);
  if (ts.isParenthesizedExpression(expression))
    return storedClassValueType(lowerer, expression.expression, visiting);
  if (
    ts.isClassExpression(expression) &&
    !functionLocalClass(expression) &&
    !lowerer.collectingExprClasses.has(expression)
  ) {
    const info = lowerer.lowerClassExpressionInfo(expression);
    return { kind: "classval", className: info.def.name };
  }
  if (ts.isPropertyAccessExpression(expression) && !expression.questionDotToken) {
    const member = nsMemberIdentOf(lowerer, expression);
    if (member) return storedClassValueType(lowerer, member, visiting);
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    const stored = lowerer.resolveThis();
    if (stored?.type.kind === "classval") return stored.type;
  }
  if (ts.isIdentifier(expression)) {
    const stored = lowerer.peekLocal(expression) ?? lowerer.globalOf(expression);
    if (stored?.type.kind === "classval" && lowerer.classes.has(stored.type.className))
      return stored.type;
    const symbol = lowerer.resolveValueSymbol(expression);
    const declaration =
      symbol &&
      lowerer.checker
        .declarationsOf(symbol)
        .find(
          (decl) =>
            ts.isVariableDeclaration(decl) &&
            decl.initializer &&
            (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0,
        );
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const value = storedClassValueType(lowerer, declaration.initializer, visiting);
      if (value?.kind === "classval") return value;
    }
  }
  const type = lowerer.typeOf(expression);
  const mapped = lowerer.mapTypeOf(type);
  if (mapped?.kind === "classval" && !lowerer.classes.has(mapped.className)) {
    for (const signature of lowerer.checker.getConstructSignatures(type)) {
      const constructor = lowerer.checker.signatureDeclaration(signature);
      const declaration =
        constructor && ts.isConstructorDeclaration(constructor) ? constructor.parent : undefined;
      if (
        declaration &&
        ts.isClassExpression(declaration) &&
        !functionLocalClass(declaration) &&
        !lowerer.collectingExprClasses.has(declaration)
      ) {
        const info = lowerer.lowerClassExpressionInfo(declaration);
        return { kind: "classval", className: info.def.name };
      }
    }
  }
  if (mapped?.kind === "classval" || !ts.isCallExpression(expression)) return mapped;
  let callee = expression.expression;
  let calls = 1;
  const aliases = new Set<ts.Node>();
  for (;;) {
    if (aliases.has(callee)) break;
    aliases.add(callee);
    if (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
      continue;
    }
    if (ts.isCallExpression(callee)) {
      calls++;
      callee = callee.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const member = nsMemberIdentOf(lowerer, callee);
      if (member) {
        callee = member;
        continue;
      }
    }
    if (ts.isIdentifier(callee)) {
      const symbol = lowerer.resolveValueSymbol(callee);
      const declaration =
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .find(
            (decl) =>
              ts.isVariableDeclaration(decl) &&
              decl.initializer &&
              (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0,
          );
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        callee = declaration.initializer;
        continue;
      }
    }
    break;
  }
  if (
    (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) &&
    isJsSourceFile(callee.getSourceFile()) &&
    !callee.typeParameters?.length &&
    !lowerer.preparingClassFactories.has(callee)
  ) {
    const signature = lowerer.checker.getSignatureFromDeclaration(callee);
    let result = signature && lowerer.checker.getReturnTypeOfSignature(signature);
    for (let i = 1; result && i < calls; i++) {
      const signatures = lowerer.checker.getCallSignatures(result);
      result =
        signatures.length === 1
          ? lowerer.checker.getReturnTypeOfSignature(signatures[0]!)
          : undefined;
    }
    if (result && lowerer.checker.getConstructSignatures(result).length > 0) {
      const returned = (value: IrExpr): IrType | null => {
        let type = value.type;
        for (let i = 0; i < calls && type.kind === "func"; i++) type = type.ret;
        return type.kind === "classval" ? type : null;
      };
      const home = callee.parent;
      const generic =
        ts.isVariableDeclaration(home) && ts.isIdentifier(home.name)
          ? lowerer.genericFnOf(home.name)
          : null;
      if (generic?.implicitParams && ts.isVariableDeclaration(home) && ts.isIdentifier(home.name)) {
        const factory = lowerer.lowerGenericFnValue(home.name, generic);
        const type = returned(factory);
        if (type) return type;
      }
      lowerer.preparingClassFactories.add(callee);
      const collecting = lowerer.collecting,
        sink = lowerer.diagSink;
      lowerer.collecting = false;
      lowerer.diagSink = null;
      try {
        const factory = lowerer.preparedClassFactories.get(callee) ?? lowerer.lowerLambda(callee);
        lowerer.preparedClassFactories.set(callee, factory);
        const type = returned(factory);
        if (type) return type;
      } finally {
        lowerer.collecting = collecting;
        lowerer.diagSink = sink;
        lowerer.preparingClassFactories.delete(callee);
      }
    }
  }
  // A checked call can erase its returned constructor's ABI while the
  // checker still identifies the class declaration. Collect that class in
  // its factory's lexical scope before choosing the derived native layout.
  // Cache the module-level closure so its captures and lifted bodies are
  // exactly the ones used when the declaration executes.
  for (const signature of lowerer.checker.getConstructSignatures(type)) {
    const declaration = lowerer.checker.signatureDeclaration(signature);
    const cls = declaration && ts.isConstructorDeclaration(declaration) ? declaration.parent : null;
    if (!cls || (!ts.isClassExpression(cls) && !ts.isClassDeclaration(cls))) continue;
    let factory: ts.ArrowFunction | ts.FunctionExpression | undefined;
    for (
      let parent: ts.Node | undefined = cls.parent;
      parent && !ts.isSourceFile(parent);
      parent = parent.parent
    ) {
      if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) factory = parent;
      else if (ts.isFunctionLike(parent)) {
        factory = undefined;
        break;
      }
    }
    if (
      !factory ||
      !isJsSourceFile(factory.getSourceFile()) ||
      factory.typeParameters?.length ||
      !ts.isVariableDeclaration(factory.parent) ||
      factory.parent.initializer !== factory ||
      !ts.isVariableDeclarationList(factory.parent.parent) ||
      !(factory.parent.parent.flags & ts.NodeFlags.Const) ||
      !ts.isVariableStatement(factory.parent.parent.parent) ||
      !ts.isSourceFile(factory.parent.parent.parent.parent) ||
      lowerer.preparingClassFactories.has(factory)
    )
      continue;
    if (!lowerer.preparedClassFactories.has(factory)) {
      lowerer.preparingClassFactories.add(factory);
      const collecting = lowerer.collecting,
        sink = lowerer.diagSink;
      lowerer.collecting = false;
      lowerer.diagSink = null;
      try {
        lowerer.preparedClassFactories.set(factory, lowerer.lowerLambda(factory));
      } finally {
        lowerer.collecting = collecting;
        lowerer.diagSink = sink;
        lowerer.preparingClassFactories.delete(factory);
      }
    }
    const resolved = lowerer.mapTypeOf(type);
    if (resolved?.kind === "classval") return resolved;
  }
  return mapped;
}

export interface ClassMethodSignature {
  params: ParamShape[];
  ret: IrType;
  abstract?: true;
  async?: true;
  gen?: NonNullable<IrFunction["generator"]>;
}

export interface ClassInfo {
  def: IrClassDef;
  expressionInitializationEmitted?: true;
  runtimeStatics?: readonly ts.ClassElement[];
  runtimePrototypeMembers?: readonly ts.ClassElement[];
  localPrototypeData?: true;
  prototypeMethodValues?: Map<string, IrExpr>;
  prototypeReflectionReady?: true;
  prototypeObservedMethodsReady?: true;
  prototypeReflectionRefusal?: string;
  localClass?: {
    context: FnCtx | null;
    bodies: Map<string, IrFunction>;
    captureSources: string[];
    ready: boolean;
    baseExpression?: ts.Expression;
  };
  /** ALL fields visible on instances — the inherited ones included — for
   * receiver-side lookup (def.fields carries the layout order). */
  fields: Map<string, IrType>;
  /** OWN fields only (declaration order) with their initializers: the
   * class's constructor runs exactly these — inherited fields initialize in
   * the base constructor, before/via super(). */
  fieldOrder: {
    name: string;
    type: IrType;
    initializer: ts.Expression | undefined;
    /** A bare JS dyn field defines undefined at its declaration position,
     * even if an earlier initializer or base constructor wrote the slot. */
    undefinedInitializer?: SrcLoc;
    /** Redeclared field: initialize the existing slot at this position;
     * no new slot (def.fields excludes it). */
    redeclared?: true;
    errorCause?: true;
  }[];
  /** OWN declared methods only — inherited lookups walk the base chain
   * (findMethodOn). An `abstract` entry is a signature with no body (and
   * no module function): it declares the vtable slot; concrete subclasses
   * fill it (tsc guarantees every instantiable class implements).
   * #PRIVATE members key by their spelled name ('#m', "get:#x") — no
   * public identifier can collide, subclass redeclarations of an
   * inherited private name are fenced at collection, and tsc confines
   * every access site to the declaring class's body, so the base-chain
   * walk IS lexical resolution and privates never join vtables (JS's
   * no-dynamic-dispatch semantics by construction). A `gen` entry has a
   * generator body whose direct calls enter through its spawn wrapper. */
  methods: Map<string, ClassMethodSignature>;
  /** Own JS overrides whose signature cannot use the inherited ABI. The slot
   * retains that ABI, but its implementation throws before executing. */
  methodEntryFences?: Map<string, ScrDiagnostic>;
  /** OWN GENERIC instance methods (own type parameters — `m<T>(x: T)`),
   * monomorphized per call site like top-level generic functions: instance
   * `n` is the module function `%C.m%n` taking `this` as param 0. They
   * never enter `methods` (no single ABI signature, no vtable slot), so
   * dispatch is STATIC — calls resolve the nearest declarer on the
   * receiver's static class, and a receiver whose runtime class could
   * override (genericOverrideBelow) must be exact or fences. Inherited
   * lookups walk the base chain (findGenericMethodOn). */
  genericMethods?: Map<string, GenericFnInfo>;
  /** OWN GENERIC static methods — `%C.static:m%n` module functions, the
   * generic twin of staticMethods (same this/super fence, same
   * through-a-VALUE shadowing rules via staticShadowBelow). */
  genericStatics?: Map<string, GenericFnInfo>;
  /** DEFERRED-INIT fields (inherited included, like `fields`): a
   * `stream!: T` definite-assignment assertion (or an SPI-off
   * initializer-less field) whose first assignment happens past the
   * constructor's top level. The SLOT is the undefined-armed union —
   * allocation writes the interned undefined, exactly Node's
   * pre-assignment read — writes wrap into the arm, and every READ is a
   * CHECKED extraction back to the declared type: a genuinely
   * unassigned read throws the catchable TypeError instead of yielding
   * an undefined the declared type cannot hold (SEMANTICS.md). */
  deferredInitFields?: Set<string>;
  /** null for the builtin error classes (runtime-provided; no source).
   * Class EXPRESSIONS carry their ts.ClassExpression here — members,
   * accessors, and locs read identically off either form. */
  decl: ts.ClassLikeDeclaration | null;
  /** Runtime-provided builtin (the Error hierarchy): no bodies lower, `new`
   * and super() calls become error.* libCalls, toString is the runtime's. */
  builtinError?: true;
  /** Runtime-provided node:events EventEmitter: no bodies lower, `new` and
   * super() become emitter.* libCalls, and the whole method surface
   * (on/emit/...) lowers through lower-event-emitter.ts over any class rooted
   * here. Subclass structs embed the ScrEmitter prefix. */
  builtinEmitter?: true;
  /** Runtime-provided node:stream class (Readable/Writable/Duplex/
   * Transform/PassThrough — emitter-rooted): no bodies lower, `new`
   * becomes a stream constructor libCall, the stream method/property
   * surface lowers through lower-stream.ts, and the emitter surface rides
   * the base chain. The value names which SIDES the class carries. User
   * `extends` of these classes is fenced at the declaration (phase 1). */
  builtinStream?: "r" | "w" | "rw";
  /** This class's own `emit` override in the FORWARDING SHAPE (the one
   * EventEmitter member a subclass may re-declare): never in `methods` —
   * emit calls keep routing through the emitter spoke, which lowers the
   * body once per event name as the specialization method `emit:<event>`
   * (lower-event-emitter.ts's emit-overrides block has the whole story). */
  emitOverride?: EmitOverrideRec;
  ctor: ts.ConstructorDeclaration | null;
  /** PARAMETER PROPERTIES (`constructor(public x: number)`), in parameter
   * order: each declares a field (placed BEFORE the class's declared
   * fields in the layout — Node's transform hoists the definitions to the
   * top of the class body, verified) and assigns it from the parameter's
   * body local AFTER the field initializers run (Node's order: super() →
   * field initializers → parameter-property assignments → ctor body). */
  paramProps?: { name: string; type: IrType; param: ts.ParameterDeclaration }[];
  /** EFFECTIVE constructor params: the own constructor's, or (constructor
   * omitted) the base's — `new Derived(...)` is typed by tsc against the
   * inherited signature, and the synthesized constructor forwards to it
   * (forwarding the completed ABI values; defaults apply in the base). */
  ctorParams: ParamShape[];
  base: ClassInfo | null;
  /** Family heritage resolves its type arguments separately for each instance. */
  genericBase?: ts.ExpressionWithTypeArguments;
  /** A module class may inherit a compiled ordinary JS constructor. Its
   * callable and prototype are captured when the class declaration runs. */
  callableBase?: { expression: ts.Expression; constructorId: string; prototypeId: string };
  factoryBaseExpression?: ts.Expression;
  /** DIRECT subclasses, filled as derived classes collect — the frontend's
   * side of whole-program devirtualization (overrideBelow). */
  subclasses: ClassInfo[];
  /** Property names whose setter this class SYNTHESIZES as a throw: a
   * getter-only override shadows an inherited get/set pair in JS, so a
   * base-typed write reaches this class and throws TypeError (Node's
   * behavior, matched exactly — see collectClassShape). */
  throwingSetters: string[];
  /** STATIC fields with initializers — the honest static subset: each is
   * a module global (`%g.s.<C>.<name>`), assigned once in the declaring
   * file's %init at the class statement's source position (exactly when
   * JS evaluates static initializers, so an initializer reading earlier
   * module bindings sees their values), and read as `C.name` anywhere
   * (lowerStaticFieldRead). Writable (non-readonly) fields are MUTABLE
   * globals; writes lower only through the DECLARING class's own name
   * (`D.x = v` where x is inherited creates an OWN property on D in JS —
   * different storage — and writes through class VALUES would need the
   * same dynamic story: both are named fences). Accessors and
   * initializer-less fields keep the fence. */
  staticFields: {
    name: string;
    type: IrType;
    initializer: ts.Expression;
    globalId: string;
    readonly: boolean;
  }[];
  /** Shared expando data added after a JS class declaration. */
  staticDataHelper?: string;
  /** STATIC methods — ordinary module functions named `%C.static:m` (the
   * accessor-colon trick: no user identifier can spell it, and statics
   * never join vtables, so IrClassDef doesn't know them). `C.m(args)` is
   * a direct call; `const f = C.m` a zero-capture closure; calls through
   * class VALUES devirtualize when no strict descendant redeclares the
   * member. Receiver-dependent methods specialize for exact receivers;
   * detached methods and `super` retain their fences. Absent on builtins. */
  staticMethods?: Map<
    string,
    {
      params: ParamShape[];
      ret: IrType;
      member: ts.MethodDeclaration;
      receiverInfo?: GenericFnInfo;
    }
  >;
  staticMethodValues?: Map<string, IrExpr>;
  /** `static { ... }` blocks, in declaration order. They are DECLARATION-TIME
   * CODE, not shape: JS runs each block once when the class statement
   * evaluates, whether or not anything ever references the class — so their
   * statements lower into the declaring file's %init at the class statement's
   * source position, interleaved with the static field initializers in member
   * order (lowerStaticFieldInits). `this` inside a block (the class
   * constructor value — no value form here) fences at collection. Absent on
   * builtin classes and classes without blocks. */
  staticBlocks?: ts.ClassStaticBlockDeclaration[];
  /** SYMBOL-KEYED fields with stable module-level Symbol()/Symbol.for()
   * keys: each identity resolves to an ordinary hidden slot in the static
   * layout. Registry keys share one identity across declarations. The map
   * goes key identity → reserved layout field name; inspect recovers the
   * Symbol(limit) spelling. Inherited entries are seeded from the base.
   * Absent on builtin classes and classes with no symbol-keyed fields. */
  symbolFields?: Map<ts.Symbol, string>;
  /** Stable symbol keys for computed instance methods. */
  symbolMethods?: Map<ts.Symbol, string>;
  /** GENERIC class FAMILY (`class Box<T>` itself): the synthetic,
   * never-constructed ancestor every instantiation extends. It owns what
   * JS's one runtime `Box` owns — the statics (one storage location for
   * every instantiation) and the `instanceof Box` interval — and declares
   * no fields, no instance methods, no constructor function. Construction
   * and instance types resolve to instantiations instead (`generic`
   * carries the instance table). */
  generic?: GenericClassInfo;
  /** GENERIC class INSTANTIATION (`Box%0` for `Box<number>`): the family,
   * the type-parameter bindings member lowering runs under (the
   * generic-fn typeParamResolver mechanism), the rendered type arguments
   * for diagnostics, and the demand ordinal (only the FIRST instantiation
   * counts statements toward coverage — re-instantiations re-visit the
   * same source lines). */
  genericInstance?: {
    path: InstantiationPath;
    family: ClassInfo;
    bindings: Map<ts.Symbol, IrType>;
    typeArgsText: string;
    ordinal: number;
  };
  /** MIXIN instantiation (`%mx<start>.<name>` for `M(Base)` at one call
   * site): the call that minted it, the base-parameter type binding its
   * members lower under, the forwarding-constructor flag, and where its
   * static declaration-time code emits (lower-mixins.ts). */
  mixinInstance?: MixinInstanceInfo;
  /** CLASS decorators (`@dec class C`) — standard (TC39 stage-3 / TS 5+)
   * semantics, lowered statically as declaration-time CALLS in %init at
   * the class statement's position: decorator expressions evaluate in
   * source order, applications run in REVERSE order over the class object,
   * and static field initializers/blocks run AFTER the applications (the
   * verified Node order). Present exactly when the declaration carries
   * class-level decorators; `shapes` fills in the post-collection analysis
   * pass (a decorator's return type may name a subclass declared BELOW the
   * class, so analysis cannot run while shapes are still collecting). */
  classDecorators?: ClassDecorationInfo;
  /** The class's decoration PROVABLY throws before anything else in its
   * definition evaluates (the first effectful item in TC39 evaluation
   * order — class decorators, then heritage, then member decorators and
   * computed keys interleaved — is an AMBIENT decorator name nothing
   * defines; Node erases the declaration, so the read is a
   * ReferenceError). The class registers as an empty SHELL: no members
   * collect (nothing after the throw ever runs — member fences would be
   * fences on dead code), the %init at the class statement is exactly the
   * throw, and every VALUE use (new, the class as a value, extends)
   * fences — the binding never initializes, so compiled code can never
   * legitimately reach one. */
  decorationThrows?: { name: string };
}

/** A decorated class's decoration state (see ClassInfo.classDecorators). */
export interface ClassDecorationInfo {
  /** The class-level decorator nodes, source order. */
  nodes: ts.Decorator[];
  /** Per-decorator analysis (parallel to `nodes`). `call`: the decorator
   * expression's completed function type — the type its VALUE lowers to
   * and the ABI the application call dispatches — and whether it can
   * REPLACE the class (return type is the class or a subclass, per the
   * classval flow rule) rather than returning void/undefined.
   * `ambientThrow`: the decorator names an ambient declaration NOTHING
   * defines (`declare let dec: any`, `declare function dec<T>(t: T): T`)
   * — Node erases it, so evaluating the decorator expression throws the
   * ReferenceError; the program compiles to exactly that crash. */
  shapes?: (
    | { kind: "call"; funcType: Extract<IrType, { kind: "func" }>; replaces: boolean }
    | { kind: "ambientThrow"; name: string }
  )[];
  /** Analysis fenced — diagnostics already reported; emission skips. */
  poisoned?: true;
  /** The MUTABLE classval module global holding the decoration RESULT,
   * present exactly when some decorator can replace the class. TC39 binds
   * the class NAME to the last non-undefined decorator return, so every
   * reference to the name routes through this value: bare reads load it,
   * `new C()` dispatches newValue through it, `C.x` takes the
   * through-a-VALUE static paths, and `instanceof C` reads its interval
   * (instanceOfValue). Absent when every decorator returns void/undefined
   * — the binding provably stays the original class object and every
   * direct path stays direct. */
  valueGlobalId?: string;
}

/** A generic class declaration's monomorphization state, hung off the
 * FAMILY ClassInfo (registered under the class's own qualified name and
 * bound to its symbol — `new`, `instanceof`, statics, and extends all
 * resolve to the family first and reroute to instantiations from there).
 * Instances key by comma-joined type-argument typeKeys; `info` is null
 * WHILE the instance's shape collects (self-referential layouts — `next:
 * Box<T> | null` — re-enter by key and take the name without recursing)
 * and stays null with `poisoned` set when collection fenced. */
export interface GenericClassInfo {
  decl: ts.ClassDeclaration;
  /** Unqualified source name, for diagnostics. */
  baseName: string;
  /** Declaration-order type parameter symbols. */
  typeParams: ts.Symbol[];
  family: ClassInfo;
  instances: Map<string, { name: string; info: ClassInfo | null; poisoned?: boolean }>;
}

/** The KEY symbol behind a LATE-BOUND (`__@name@id`) property: resolved
 * from the argument of the element-access assignment that declared it
 * (`this[kLimit] = v` — the declaration list holds the BinaryExpression
 * or the ElementAccessExpression itself). Null when no declaration has
 * that shape (well-known-symbol members like `[Symbol.iterator]`). */
function lateBoundKeySymOf(lowerer: Lowerer, p: ts.Symbol): ts.Symbol | null {
  for (const d of lowerer.checker.declarationsOf(p)) {
    const access =
      ts.isBinaryExpression(d) && ts.isElementAccessExpression(d.left)
        ? d.left
        : ts.isElementAccessExpression(d)
          ? d
          : null;
    if (!access || !ts.isIdentifier(access.argumentExpression)) continue;
    const sym = lowerer.resolveValueSymbol(access.argumentExpression);
    if (sym) return sym;
  }
  return null;
}

/** Symbol-slot RETURN refinement (5.9.3 ABI parity): tsgo synthesizes no
 * late-bound property for a JS class's `this[k] = v` declaration (the
 * finding-5 family), so an unannotated method whose returns read a
 * declared symbol-keyed slot infers `any` — the checked-dynamic
 * fallback would box a value whose static type the class layout already
 * knows (5.9.3 inferred it through the late-bound property; runtime
 * output was identical either way, but the method ABI carried a dyn
 * box). Recovered here from the layout itself, under a shape that
 * cannot mis-type: an unannotated, non-async, non-generator JS method
 * whose LAST top-level statement is a return (no fall-through
 * `undefined` completion), where EVERY return statement (nested
 * functions excluded — they return elsewhere) returns `this[k]` with a
 * statically-resolved key declared in symbolFields, and all the slots
 * agree on one IR type. Null when the shape doesn't hold — the value
 * stays checked-dynamic exactly as before. */
function symbolSlotReturnType(
  lowerer: Lowerer,
  fnLike: ts.MethodDeclaration,
  symbolFields: ReadonlyMap<ts.Symbol, string>,
  fields: ReadonlyMap<string, IrType>,
): IrType | null {
  if (symbolFields.size === 0) return null;
  if (fnLike.type !== undefined || !fnLike.body) return null;
  if (!isJsSourceFile(fnLike.getSourceFile())) return null;
  if (fnLike.asteriskToken !== undefined) return null;
  if (fnLike.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  const stmts = fnLike.body.statements;
  const last = stmts[stmts.length - 1];
  if (!last || !ts.isReturnStatement(last)) return null;
  const returns: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) returns.push(n);
    n.forEachChild(visit);
  };
  fnLike.body.forEachChild(visit);
  let out: IrType | null = null;
  for (const r of returns) {
    let e = r.expression;
    while (e !== undefined && ts.isParenthesizedExpression(e)) e = e.expression;
    if (e === undefined || !ts.isElementAccessExpression(e)) return null;
    if (e.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
    const key = classSymbolKeyOf(lowerer, e.argumentExpression);
    const fieldName = key ? symbolFields.get(key.identity) : undefined;
    const t = fieldName !== undefined ? fields.get(fieldName) : undefined;
    if (t === undefined || t.kind === "dyn") return null;
    if (out !== null && !typeEquals(out, t)) return null;
    out = t;
  }
  return out;
}

/** The builtin Error hierarchy
 * as eagerly-registered ClassInfos: mapType names them the moment a lib
 * Error type appears, so the infos must exist before any lowering. They
 * are runtime-provided — no decl, no lowerable bodies; `new`/super()/
 * toString reach them through dedicated error.* libCall lowerings, and
 * user classes extend them like any base (the emitted subclass struct
 * embeds ScrError's prefix). */
export function registerBuiltinErrorClasses(lowerer: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    const base = rec.base ? (lowerer.classes.get(rec.base) ?? null) : null;
    const info: ClassInfo = {
      def: {
        name: irName,
        runtime: true,
        ...(rec.base ? { base: rec.base } : {}),
        // Layout only — `%code` is ScrError's third slot (NULL = absent;
        // fs/exec throw sites stamp it): subclass structs embed it in
        // their prefix, and teardown releases it NULL-guarded like any
        // string field. The '%' name keeps it out of user reach (a
        // subclass declaring its own `code` field lays out AFTER it,
        // never colliding), and it is NOT in the fields map below: the
        // READ has its own `string | undefined` lowering (error.code),
        // never a plain-string field access. `%cause` is the following
        // owned dyn slot; NULL means absent, dyn undefined means present.
        fields: [
          { name: "name", type: STRING },
          { name: "message", type: STRING },
          { name: "%code", type: STRING },
          { name: "%cause", type: DYN },
          { name: "%causeEnumerable", type: BOOL },
          { name: "%messagePresent", type: BOOL },
          { name: "%messageEnumerable", type: BOOL },
          { name: "%namePresent", type: BOOL },
          { name: "%nameEnumerable", type: BOOL },
          { name: "%stackFrames", type: STRING },
          { name: "%stack", type: STRING },
        ],
        loc,
      },
      fields: new Map([
        ["name", STRING],
        ["message", STRING],
      ]),
      fieldOrder: [],
      // Only the root declares toString — subclasses (builtin and user)
      // reach it through the base-chain walk, so its declarer is always
      // %Error and calls lower to the one runtime implementation.
      methods:
        rec.base === null
          ? new Map<
              string,
              {
                params: ParamShape[];
                ret: IrType;
                abstract?: true;
                async?: true;
                gen?: NonNullable<IrFunction["generator"]>;
              }
            >([["toString", { params: [], ret: STRING }]])
          : new Map(),
      decl: null,
      builtinError: true,
      ctor: null,
      // Inherited constructors forward both raw arguments. The runtime
      // applies the undefined message default and InstallErrorCause.
      ctorParams: [
        { type: DYN, mode: "omittable" },
        { type: DYN, mode: "omittable" },
      ],
      base,
      subclasses: [],
      throwingSetters: [],
      staticFields: [],
    };
    if (base) base.subclasses.push(info);
    lowerer.classes.set(irName, info);
  }
}

/** The runtime-provided node:events EventEmitter as an eagerly-registered
 * ClassInfo (the error-hierarchy story): mapType names `%EventEmitter`
 * the moment an emitter type appears, so the info must exist before any
 * lowering. No decl, no lowerable bodies — `new`/super() reach it
 * through emitter.* libCalls, the method surface lowers through
 * lower-event-emitter.ts, and user classes extend it like any base (the
 * emitted subclass struct embeds ScrEmitter's registry/name prefix —
 * carried by the BACKEND, not by IR fields, so the fields list stays
 * empty and subclass field layout starts right after the prefix). */
export function registerBuiltinEmitterClass(lowerer: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  const info: ClassInfo = {
    def: { name: RUNTIME_EMITTER_CLASS, runtime: true, fields: [], loc },
    fields: new Map(),
    fieldOrder: [],
    methods: new Map(),
    decl: null,
    builtinEmitter: true,
    ctor: null,
    // `new EventEmitter()` — zero-argument (the options bag fences at
    // construction sites; the checker may admit it via @types/node).
    ctorParams: [],
    base: null,
    subclasses: [],
    throwingSetters: [],
    staticFields: [],
  };
  lowerer.classes.set(RUNTIME_EMITTER_CLASS, info);
}

/** The runtime-provided node:stream classes as eagerly-registered
 * ClassInfos (the emitter story): mapType names `%Readable` et al the
 * moment a stream type appears, so the infos must exist before any
 * lowering. Each roots at the emitter through its base chain, so the
 * EventEmitter method surface, upcasts, and instanceof intervals apply
 * unchanged; the stream method/property surface lowers through
 * lower-stream.ts. No decl, no lowerable bodies, empty field lists —
 * every instance is runtime-allocated (user `extends` is fenced). */
export function registerBuiltinStreamClasses(lowerer: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  for (const [irName, rec] of RUNTIME_STREAM_CLASSES) {
    const base = lowerer.classes.get(rec.base) ?? null;
    const info: ClassInfo = {
      def: { name: irName, runtime: true, base: rec.base, fields: [], loc },
      fields: new Map(),
      fieldOrder: [],
      methods: new Map(),
      decl: null,
      builtinStream: rec.sides,
      ctor: null,
      // `new Readable(opts?)` — the options bag is parsed structurally
      // by the stream spoke (lowerNew never completes against this).
      ctorParams: [],
      base,
      subclasses: [],
      throwingSetters: [],
      staticFields: [],
    };
    if (base) base.subclasses.push(info);
    lowerer.classes.set(irName, info);
  }
}

/** The stream ClassInfo a VALUE symbol refers to (`new Readable(...)`,
 * `x instanceof Writable`) — any import spelling resolves to the
 * ambient class. Provenance: a stdlib-file CLASS declaration inside the
 * "stream" ambient module, EXCLUDING @types/node's (whose stream.Readable
 * also types child stdio — under @types/node the childStream mapping
 * keeps priority and the static stream classes stand down; the shipped
 * fallback declarations are the supported surface). */
export function builtinStreamInfoOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): ClassInfo | null {
  if (!symbol) return null;
  if (!lowerer.isStdlibSymbol(symbol)) {
    // A const ALIAS of a namespace member (`const Writable =
    // stream.Writable` — the two-step spelling; the one-step
    // require('stream').Writable rides the same walk): follow the
    // member to the stdlib class symbol. The declaration itself is
    // alias plumbing (streamClassAliasDecl — both declaration walks
    // skip it).
    const decl = lowerer.checker.valueDeclarationOf(symbol);
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
      decl.initializer !== undefined &&
      ts.isPropertyAccessExpression(decl.initializer) &&
      !decl.initializer.questionDotToken &&
      lowerer.builtinNamespaceModuleOf(decl.initializer.expression) === "stream"
    ) {
      const mSym = lowerer.checker.getSymbolAtLocation(decl.initializer.name);
      const target =
        mSym && mSym.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(mSym) : mSym;
      if (target && target !== symbol) return builtinStreamInfoOf(lowerer, target);
    }
    return null;
  }
  let irName: string | null = null;
  for (const [name, rec] of RUNTIME_STREAM_CLASSES) {
    if (rec.lib === symbol.name) irName = name;
  }
  if (!irName) return null;
  const declared = lowerer.checker.declarationsOf(symbol).some((d) => {
    if (!ts.isClassDeclaration(d)) return false;
    if (isNodeTypesPath(d.getSourceFile().fileName)) return false;
    let node: ts.Node | undefined = d.parent;
    while (node) {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return node.name.text === "stream" || node.name.text === "node:stream";
      }
      node = node.parent;
    }
    return false;
  });
  return declared ? (lowerer.classes.get(irName) ?? null) : null;
}

/** A dictionary lookup may be absent even when its checker type is a
 * required reference. Keep literal nullish fallbacks in inferred JS storage. */
function jsFieldInitializerType(lowerer: Lowerer, type: IrType, expression: ts.Expression): IrType {
  if (ts.isIdentifier(expression)) {
    const symbol = lowerer.checker.getSymbolAtLocation(expression);
    if (
      symbol &&
      lowerer.checker
        .declarationsOf(symbol)
        .some(
          (decl) =>
            ts.isParameter(decl) &&
            (ts.isConstructorDeclaration(decl.parent) ||
              (lowerer.typeOf(expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
        )
    )
      return DYN;
  }
  if (type.kind === "array" || type.kind === "record") return DYN;
  // JavaScript documentation cannot guarantee that a call or an indexed
  // read returns a present number. Numeric fields receiving those values
  // must retain undefined, so later arithmetic performs JS coercion (NaN).
  if (type.kind === "f64" && isJsSourceFile(expression.getSourceFile())) {
    const assignment = expression.parent;
    const left = ts.isBinaryExpression(assignment) ? assignment.left : null;
    const field =
      left &&
      ts.isPropertyAccessExpression(left) &&
      left.expression.kind === ts.SyntaxKind.ThisKeyword
        ? left.name.text
        : null;
    let owner: ts.Node | undefined = expression.parent;
    while (owner && !ts.isClassDeclaration(owner) && !ts.isClassExpression(owner))
      owner = owner.parent;
    if (field && owner) {
      let acceptsUnchecked = false;
      const scan = (node: ts.Node): void => {
        if (
          acceptsUnchecked ||
          (node !== owner && (ts.isClassDeclaration(node) || ts.isClassExpression(node)))
        )
          return;
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          node.left.name.text === field
        ) {
          let rhs = node.right;
          while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
          if (ts.isCallExpression(rhs) || ts.isElementAccessExpression(rhs))
            acceptsUnchecked = true;
        }
        node.forEachChild(scan);
      };
      scan(owner);
      if (acceptsUnchecked) return DYN;
    }
  }
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isCallExpression(node) && type.kind === "bytes") {
    let prototypeArgument = false;
    for (const argument of node.arguments)
      ts.walkPreorder(argument, (part) => {
        if (
          !ts.isPropertyAccessExpression(part) ||
          part.expression.kind !== ts.SyntaxKind.ThisKeyword
        )
          return;
        const symbol = lowerer.checker.getSymbolAtLocation(part.name);
        if (
          symbol &&
          lowerer.checker.declarationsOf(symbol).some((decl) => {
            const member = ts.isBinaryExpression(decl) ? decl.left : decl;
            return (
              ts.isPropertyAccessExpression(member) &&
              ts.isPropertyAccessExpression(member.expression) &&
              member.expression.name.text === "prototype"
            );
          })
        )
          prototypeArgument = true;
        // JS checkers can synthesize a property declaration for prototype
        // assignments. Keep the source ownership proof when that happens.
        let owner: ts.Node | undefined = node.parent;
        while (owner && !(ts.isClassDeclaration(owner) || ts.isClassExpression(owner)))
          owner = owner.parent;
        if (owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && owner.name) {
          const className = owner.name.text;
          for (const statement of owner.getSourceFile().statements) {
            if (
              !ts.isExpressionStatement(statement) ||
              !ts.isBinaryExpression(statement.expression)
            )
              continue;
            const left = statement.expression.left;
            if (
              statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(left) &&
              left.name.text === part.name.text &&
              ts.isPropertyAccessExpression(left.expression) &&
              left.expression.name.text === "prototype" &&
              ts.isIdentifier(left.expression.expression) &&
              left.expression.expression.text === className
            )
              prototypeArgument = true;
          }
        }
      });
    // A prototype-selected conversion can return different container kinds
    // in subclasses even when JSDoc describes the base class's default.
    if (prototypeArgument) return DYN;
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const ret = lowerer.declaredReturnType(node, node);
    const arms = type.kind === "union" ? (lowerer.unions.get(type.unionId)?.arms ?? []) : [type];
    // Inferred arithmetic may return a checked Number or BigInt. Preserve
    // the callable when its native return ABI differs from the checker slot.
    if (arms.some((arm) => arm.kind === "func" && !typeEquals(arm.ret, ret))) return DYN;
  }
  if (node.kind === ts.SyntaxKind.NullKeyword)
    return withUnitArm(type, "nullT", lowerer.unions) ?? type;
  const inferred = lowerer.typeOf(node);
  const scalar =
    (inferred.flags & ts.TypeFlags.BooleanLike) !== 0
      ? "bool"
      : (inferred.flags & ts.TypeFlags.NumberLike) !== 0
        ? "f64"
        : (inferred.flags & ts.TypeFlags.StringLike) !== 0
          ? "string"
          : (inferred.flags & ts.TypeFlags.BigIntLike) !== 0
            ? "bigint"
            : (inferred.flags & ts.TypeFlags.ESSymbolLike) !== 0
              ? "symbol"
              : null;
  if (
    scalar &&
    type.kind !== "dyn" &&
    type.kind !== scalar &&
    !(
      type.kind === "union" &&
      lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === scalar)
    )
  )
    return DYN;
  for (const arm of inferred.isUnionType() ? ts.constituentTypes(inferred) : [inferred]) {
    if ((arm.flags & ts.TypeFlags.Undefined) !== 0) type = lowerer.withUndefinedArmOf(type) ?? type;
    if ((arm.flags & ts.TypeFlags.Null) !== 0)
      type = withUnitArm(type, "nullT", lowerer.unions) ?? type;
  }
  if (ts.isConditionalExpression(node)) {
    return jsFieldInitializerType(
      lowerer,
      jsFieldInitializerType(lowerer, type, node.whenTrue),
      node.whenFalse,
    );
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      type = jsFieldInitializerType(lowerer, type, node.left);
    if (
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
      return jsFieldInitializerType(lowerer, type, node.right);
  }
  return type;
}

function inheritedJsFieldType(
  lowerer: Lowerer,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  name: string,
  type: IrType,
): IrType {
  for (const expression of lowerer.inheritedJsFieldWrites.get(decl)?.get(name) ?? []) {
    // Keep one shared layout, including sibling subclasses. A descendant
    // initializer that exceeds the base slot needs checked JS storage.
    if (!typeEquals(type, jsFieldInitializerType(lowerer, type, expression))) return DYN;
  }
  return type;
}

function returnsWidenedJsField(
  lowerer: Lowerer,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  member: ts.MethodDeclaration,
  fields: ReadonlyMap<string, IrType>,
  ret: IrType,
): boolean {
  if (
    !isJsSourceFile(member.getSourceFile()) ||
    member.type ||
    member.asteriskToken ||
    hasExplicitJsDocReturn(member)
  )
    return false;
  const widened = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) return widened(expression.expression);
    if (ts.isConditionalExpression(expression))
      return widened(expression.whenTrue) || widened(expression.whenFalse);
    if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      const symbol = ts.isPropertyAccessExpression(callee)
        ? lowerer.checker.getSymbolAtLocation(callee.name)
        : ts.isElementAccessExpression(callee)
          ? lowerer.checker.getPropertyOfType(
              lowerer.typeOf(callee.expression),
              lowerer.foldedStringKeyOf(callee.argumentExpression) ?? "",
            )
          : undefined;
      if (
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .some(
            (declaration) =>
              ts.isMethodDeclaration(declaration) &&
              lowerer.checkedVirtualJsMethods.has(declaration),
          )
      )
        return true;
    }
    const name = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isElementAccessExpression(expression)
        ? lowerer.foldedStringKeyOf(expression.argumentExpression)
        : null;
    if (ts.isPropertyAccessExpression(expression)) {
      const symbol = lowerer.checker.getSymbolAtLocation(expression.name);
      if (
        symbol &&
        lowerer.checker
          .declarationsOf(symbol)
          .some(
            (declaration) =>
              (ts.isGetAccessorDeclaration(declaration) ||
                ts.isSetAccessorDeclaration(declaration)) &&
              lowerer.checkedVirtualJsAccessors.has(declaration),
          )
      )
        return true;
    }
    if (
      name !== null &&
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return (
        fields.get(name)?.kind === "dyn" ||
        inheritedJsFieldType(lowerer, decl, name, ret).kind === "dyn"
      );
    }
    return false;
  };
  let result = false;
  const scan = (node: ts.Node): void => {
    if (result || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression && widened(node.expression)) result = true;
    node.forEachChild(scan);
  };
  if (member.body) scan(member.body);
  return result;
}

/** The undefined-armed union of a JS class property's inferred type — the
 * honest slot for a field first assigned outside the constructor's top
 * level (undefined until the write runs, Node-exact). Null when the
 * inference is unmappable or an arm-less kind that cannot join a union
 * (genResultRecord's list, including scalar-backed Date values). */
function undefArmedFieldType(lowerer: Lowerer, p: ts.Symbol): IrType | null {
  const t = lowerer.checker.getTypeOfSymbol(p);
  const site = lowerer.checker.declarationsOf(p)[0];
  let mapped = lowerer.mapTypeOf(t) ?? (site ? dynFallbackType(lowerer, site, t) : null);
  if (mapped && site) mapped = jsOpenObjectType(site, mapped, lowerer.shapes, lowerer.unions);
  if (!mapped || mapped.kind === "void") return null;
  for (const declaration of lowerer.checker.declarationsOf(p)) {
    const assignment = ts.isBinaryExpression(declaration) ? declaration : declaration.parent;
    if (
      assignment &&
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      mapped = jsFieldInitializerType(lowerer, mapped, assignment.right);
    }
  }
  // An implicit JS value already carries undefined in its native box.
  if (mapped.kind === "dyn") return mapped;
  const byKey = new Map<string, IrType>();
  const arms =
    mapped.kind === "union" ? (lowerer.unions.get(mapped.unionId)?.arms ?? []) : [mapped];
  for (const a of arms) {
    if (
      a.kind === "map" ||
      a.kind === "regex" ||
      a.kind === "date" ||
      a.kind === "jsval" ||
      a.kind === "generator"
    ) {
      return null;
    }
    byKey.set(typeKey(a), a);
  }
  byKey.set(typeKey(UNDEFINED_T), UNDEFINED_T);
  const sorted = [...byKey.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: lowerer.unions.intern(sorted) };
}

/** The emitter ClassInfo a VALUE symbol refers to (`new EventEmitter`,
 * `extends EventEmitter`, `x instanceof EventEmitter`) — any import
 * spelling (named/default/namespace member, CJS require) resolves to
 * the ambient class. Provenance-checked like the error classes: only a
 * stdlib-file declaration inside the "events" ambient module counts. */
export function builtinEmitterInfoOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): ClassInfo | null {
  if (!symbol) return null;
  if (!lowerer.isStdlibSymbol(symbol)) {
    // A const ALIAS of the emitter class member (`const EventEmitter =
    // require('node:events').EventEmitter` — commander's spelling; the
    // two-step `const EE = events.EventEmitter` rides the same walk):
    // follow the member off the module namespace. The declaration
    // itself is alias plumbing (builtinMemberRequireDecl — both
    // declaration walks skip it).
    const decl = lowerer.checker.valueDeclarationOf(symbol);
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
      decl.initializer !== undefined &&
      ts.isPropertyAccessExpression(decl.initializer) &&
      !decl.initializer.questionDotToken &&
      decl.initializer.name.text === "EventEmitter" &&
      lowerer.builtinNamespaceModuleOf(decl.initializer.expression) === "events"
    ) {
      return lowerer.classes.get(RUNTIME_EMITTER_CLASS) ?? null;
    }
    return null;
  }
  if (symbol.name !== "EventEmitter") return null;
  const declared = lowerer.checker.declarationsOf(symbol).some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    let node: ts.Node | undefined = d.parent;
    while (node) {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return node.name.text === "events" || node.name.text === "node:events";
      }
      node = node.parent;
    }
    return false;
  });
  return declared ? (lowerer.classes.get(RUNTIME_EMITTER_CLASS) ?? null) : null;
}

/** The builtin error ClassInfo a VALUE symbol refers to (`new Error`,
 * `extends TypeError`, `x instanceof RangeError`), or null. Provenance-
 * checked: only the standard library's declarations count — a user's own
 * `class Error` resolves through classBySymbol instead. */
export function builtinErrorInfoOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): ClassInfo | null {
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    if (rec.lib === symbol.name) return lowerer.classes.get(irName) ?? null;
  }
  return null;
}

/** The instance-method surface the runtime EventEmitter owns — subclass
 * members with these names are fenced (collectClassShapeInner) and calls
 * to them on emitter-rooted receivers lower through lower-event-emitter.ts. */
export const EMITTER_API_MEMBERS: ReadonlySet<string> = new Set([
  "on",
  "addListener",
  "once",
  "prependListener",
  "prependOnceListener",
  "off",
  "removeListener",
  "removeAllListeners",
  "emit",
  "listenerCount",
  "listeners",
  "rawListeners",
  "eventNames",
  "setMaxListeners",
  "getMaxListeners",
]);

/** The decorators of a class-like or member node (they live in
 * `modifiers` since TS 4.8). */
export function decoratorNodesOf(n: ts.Node): ts.Decorator[] {
  return (((n as { modifiers?: readonly ts.Node[] }).modifiers ?? []) as ts.Node[]).filter(
    (m): m is ts.Decorator => m.kind === ts.SyntaxKind.Decorator,
  );
}

/** The AMBIENT name a decorator expression's evaluation throws on, or
 * null. Node erases ambient declarations (`declare let dec: any`,
 * `declare const instance: T`, `declare function dec<T>(t: T): T`), so
 * reading the name is a ReferenceError. Factory spellings ride along —
 * `@dec(...)` evaluates the CALLEE before any argument — and property
 * chains throw at their ROOT (`@instance.decorate` reads `instance`
 * first). */
function ambientDecoratorThrowNameOf(lowerer: Lowerer, dExpr: ts.Expression): string | null {
  let e: ts.Expression = dExpr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const target = ts.isCallExpression(e) ? e.expression : e;
  const root = ambientUndefVarRootOf(lowerer, target);
  if (root) return root.text;
  let callee: ts.Expression = target;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee) && ambientUndefinedFnSymbolOf(lowerer, callee) !== null)
    return callee.text;
  return null;
}

/** The guaranteed decoration THROW of a decorated class, or null. Walks
 * the class definition's evaluation-order items — class decorators
 * (source order), the heritage expression, then per member in body
 * order its decorators and computed key (the verified TC39/tsc-downlevel
 * order) — and answers the first AMBIENT decorator name, provided every
 * item BEFORE it is provably effect-free and non-throwing: bare
 * identifier decorators over defined values (a pure read), an absent /
 * `null` / bare-identifier heritage, literal or bare-identifier
 * computed keys. Anything richer (factory calls over defined values,
 * property-access reads, computed-key calls) stops the proof — the
 * named fences answer instead. */
export function guaranteedDecorationThrow(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
): { name: string; node: ts.Decorator } | null {
  const stripParens = (e: ts.Expression): ts.Expression => {
    let x = e;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  const decoratorVerdict = (
    d: ts.Decorator,
  ): { name: string; node: ts.Decorator } | "effectFree" | "opaque" => {
    const name = ambientDecoratorThrowNameOf(lowerer, d.expression);
    if (name !== null) return { name, node: d };
    const e = stripParens(d.expression);
    // A bare identifier over a DEFINED value: a pure read.
    if (ts.isIdentifier(e)) return "effectFree";
    return "opaque";
  };
  for (const d of decoratorNodesOf(decl)) {
    const v = decoratorVerdict(d);
    if (v === "opaque") return null;
    if (v !== "effectFree") return v;
  }
  const heritage = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types[0];
  if (heritage) {
    const h = stripParens(heritage.expression);
    if (h.kind !== ts.SyntaxKind.NullKeyword && !ts.isIdentifier(h)) return null;
  }
  for (const member of decl.members) {
    for (const d of decoratorNodesOf(member)) {
      const v = decoratorVerdict(d);
      if (v === "opaque") return null;
      if (v !== "effectFree") return v;
    }
    const name = (member as { name?: ts.PropertyName }).name;
    if (name && ts.isComputedPropertyName(name)) {
      const k = stripParens(name.expression);
      const literalKey = ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) || ts.isIdentifier(k);
      if (!literalKey) return null;
    }
  }
  return null;
}

export function collectClassShape(lowerer: Lowerer, decl: ts.ClassDeclaration): void {
  if (
    lowerer.classes.has(lowerer.classNamer(decl)) ||
    lowerer.collectingClassDeclarations.has(decl)
  )
    return;
  lowerer.collectingClassDeclarations.add(decl);
  try {
    collectClassShapeDeferring(lowerer, decl);
  } finally {
    lowerer.collectingClassDeclarations.delete(decl);
  }
}

function collectClassShapeDeferring(lowerer: Lowerer, decl: ts.ClassDeclaration): void {
  const symbol = lowerer.collectDeferring(
    () => declSymbolOf(lowerer, decl),
    () => {
      // A forward type reference can demand this class before collection
      // reaches its earlier base declaration. Collect that dependency first;
      // a later same-file base remains subject to the runtime order boundary.
      const heritage = decl.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types[0]?.expression;
      const reference =
        heritage && ts.isPropertyAccessExpression(heritage) ? heritage.name : heritage;
      const baseSymbol =
        reference && ts.isIdentifier(reference) ? lowerer.resolveValueSymbol(reference) : undefined;
      const baseDeclaration = baseSymbol
        ? lowerer.checker.declarationsOf(baseSymbol).find(ts.isClassDeclaration)
        : undefined;
      if (
        baseDeclaration &&
        !lowerer.isStdlibSymbol(baseSymbol ?? undefined) &&
        !baseDeclaration.getSourceFile().isDeclarationFile &&
        (baseDeclaration.getSourceFile() !== decl.getSourceFile() ||
          baseDeclaration.getStart() < decl.getStart())
      )
        lowerer.collectClassShape(baseDeclaration);
      lowerer.collectClassShapeInner(decl);
    },
  );
  // Typed receivers and module retention know the class only by its
  // qualified IR name — index the deferral under it too.
  if (symbol) lowerer.deferredClassByName.set(lowerer.classNamer(decl), symbol);
  // A poisoned class containing a static BLOCK or a DECORATOR must report
  // EAGERLY: deferral's premise ("an unreached broken declaration costs
  // nothing") fails here — Node runs the block (and calls the decorator)
  // when the class statement evaluates, referenced or not, so silently
  // dropping the declaration would drop observable side effects (the
  // classStaticBlock13/28 miscompiles).
  const hasDeclTimeCode = (n: ts.Node): boolean =>
    ts.isClassStaticBlockDeclaration(n) ||
    ((n as { modifiers?: readonly ts.Node[] }).modifiers ?? []).some(
      (m) => m.kind === ts.SyntaxKind.Decorator,
    );
  if (symbol && (hasDeclTimeCode(decl) || decl.members.some(hasDeclTimeCode))) {
    const diags = lowerer.deferredDiags.get(symbol);
    if (diags) {
      lowerer.deferredDiags.delete(symbol);
      if (!lowerer.alreadyFlushed.has(symbol)) {
        lowerer.flushedSymbols.add(symbol);
        for (const d of diags) lowerer.pushDiag(d);
      }
    }
  }
  // A poisoned BASE this class EXTENDS must report EAGERLY for the same
  // reason: the derived statement evaluates its heritage when module
  // init reaches it (these are top-level declarations), and the base's
  // fence is the COMPILER's, not Node's — Node defines the base fine and
  // runs on — so a deferred trap there is a manufactured divergence, not
  // the Node-parity deferral is licensed by (classFieldSuperAccessibleJs2:
  // the binary refused at `class D extends C` where Node prints five
  // lines). Leaf poisoned classes stay deferred — only the extends edge
  // reports. Resolution runs under the collect pass's guard (this is
  // collectProgram), so the lookup neither flushes nor fences.
  {
    const baseIdent = decl.heritageClauses
      ?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
      ?.types.map((t) => t.expression)
      .filter(ts.isIdentifier)[0];
    const baseSym = baseIdent ? lowerer.resolveValueSymbol(baseIdent) : null;
    const baseDiags = baseSym ? lowerer.deferredDiags.get(baseSym) : undefined;
    if (baseSym && baseDiags) {
      lowerer.deferredDiags.delete(baseSym);
      if (!lowerer.alreadyFlushed.has(baseSym)) {
        lowerer.flushedSymbols.add(baseSym);
        for (const d of baseDiags) lowerer.pushDiag(d);
      }
    }
  }
}

function inferredEmptyCollectionFieldType(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  field: string,
  initializer: ts.Expression,
): IrType | null {
  if (
    !ts.isNewExpression(initializer) ||
    (initializer.arguments?.length ?? 0) !== 0 ||
    !ts.isIdentifier(initializer.expression)
  )
    return null;
  const collection = initializer.expression.text;
  if (collection !== "Map" && collection !== "Set") return null;
  const symbol = lowerer.checker.getSymbolAtLocation(initializer.expression);
  if (!lowerer.isStdlibSymbol(symbol)) return null;
  const mapKeys: IrType[] = [];
  const mapValues: IrType[] = [];
  const setElements: IrType[] = [];
  const mappedArgument = (argument: ts.Expression): IrType | null => {
    const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(argument));
    const mapped = lowerer.mapTypeOf(type);
    if (
      !mapped ||
      mapped.kind === "dyn" ||
      mapped.kind === "jsval" ||
      mapped.kind === "void" ||
      isUnitType(mapped)
    )
      return null;
    return mapped;
  };
  const visit = (node: ts.Node): "skip" | undefined => {
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return "skip";
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
      return undefined;
    const receiver = node.expression.expression;
    if (
      !ts.isPropertyAccessExpression(receiver) ||
      receiver.expression.kind !== ts.SyntaxKind.ThisKeyword ||
      receiver.name.text !== field
    ) {
      return undefined;
    }
    if (
      collection === "Map" &&
      node.expression.name.text === "set" &&
      node.arguments.length === 2
    ) {
      const key = mappedArgument(node.arguments[0]!);
      const value = mappedArgument(node.arguments[1]!);
      if (
        key !== null &&
        value !== null &&
        isSupportedMapKey(
          key,
          key.kind === "union" ? lowerer.unions.get(key.unionId)?.arms : undefined,
        ) &&
        isSupportedMapValue(value)
      ) {
        mapKeys.push(key);
        mapValues.push(value);
      }
    }
    if (
      collection === "Set" &&
      (node.expression.name.text === "add" ||
        node.expression.name.text === "has" ||
        node.expression.name.text === "delete") &&
      node.arguments.length === 1
    ) {
      const element = mappedArgument(node.arguments[0]!);
      if (
        element !== null &&
        isSupportedSetElem(
          element,
          element.kind === "union" ? lowerer.unions.get(element.unionId)?.arms : undefined,
        )
      )
        setElements.push(element);
    }
    return undefined;
  };
  for (const member of decl.members) {
    const body =
      ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isAccessor(member)
        ? member.body
        : undefined;
    if (body !== undefined) ts.walkPreorder(body, visit);
  }
  const unique = (types: readonly IrType[]): IrType | null => {
    const first = types[0];
    return first !== undefined && types.every((type) => typeEquals(type, first)) ? first : null;
  };
  if (collection === "Map") {
    const key = unique(mapKeys);
    const value = unique(mapValues);
    return key !== null && value !== null ? { kind: "map", key, value } : null;
  }
  const element = unique(setElements);
  return element !== null ? { kind: "set", elem: element } : null;
}

export function collectClassShapeInner(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  jsNameOverride?: string,
  inst?: {
    path: InstantiationPath;
    family: ClassInfo;
    name: string;
    bindings: Map<ts.Symbol, IrType>;
    typeArgsText: string;
    ordinal: number;
  },
  /** MIXIN instantiation mode (lower-mixins.ts): the class inside a
   * mixin function, collected per call site — `base` is the ARGUMENT
   * class (the heritage clause names the mixin's parameter and is
   * resolved here, never through the loop below), `name` the
   * position-derived instance name. */
  mixin?: {
    base: ClassInfo;
    name: string;
    call: ts.CallExpression;
    bindings: Map<ts.Symbol, IrType>;
    context: string;
    ordinal: number;
  },
): void {
  {
    // Anonymous class EXPRESSIONS are ordinary (their .name follows
    // NamedEvaluation — jsNameOverride carries it). The one legal
    // nameless class DECLARATION is `export default class {}` — its
    // symbol is the module's default export (declSymbolOf) and it
    // registers under classNamer's "%anon" spelling (unique per file).
    if (!decl.name && ts.isClassDeclaration(decl) && declSymbolOf(lowerer, decl) === undefined) {
      lowerer.unsupported("SC1090", decl, "anonymous classes");
    }
    // Decorators are declaration-time CALLS (they run when the class
    // statement evaluates and may replace the declaration outright).
    // CLASS decorators lower statically (collected here, analyzed
    // post-collection, emitted in %init at the class statement's
    // position — see ClassDecorationInfo). A decoration that PROVABLY
    // throws before anything else evaluates (an ambient decorator name,
    // the corpus's dominant shape — class-level or MEMBER-level) makes
    // the whole declaration a shell whose %init is exactly the throw.
    // Remaining MEMBER decorators stay named fences — a method/field
    // replacement would have to rebind vtable slots and initializer
    // chains at declaration time, and the standard context object
    // (addInitializer, access) has no static story yet. Parameter
    // decorators are not valid ES decorators — the checker rejects
    // them first.
    const classDecoratorNodes: ts.Decorator[] = [];
    {
      classDecoratorNodes.push(...decoratorNodesOf(decl));
      const decoratedMembers = decl.members.filter((m) => decoratorNodesOf(m).length > 0);
      if (classDecoratorNodes.length > 0 || decoratedMembers.length > 0) {
        // Node itself cannot execute decorator syntax in a JavaScript
        // source (V8 has not shipped the proposal; the type-stripping
        // loaders leave `@dec` in place) — there is no runtime behavior
        // to be exact against.
        if (isJsSourceFile(decl.getSourceFile())) {
          lowerer.unsupported(
            "SC1090",
            (classDecoratorNodes[0] ?? decoratorNodesOf(decoratedMembers[0]!)[0])!,
            "decorators in JavaScript sources (V8 has not shipped decorators — Node cannot execute this file)",
          );
        }
        // The guaranteed-throw SHELL: declarations only (expressions
        // lower their throw at the expression — lowerClassExpression),
        // never instantiations/mixins (they share a family declaration).
        if (
          inst === undefined &&
          mixin === undefined &&
          ts.isClassDeclaration(decl) &&
          decl.typeParameters === undefined
        ) {
          const thrown = guaranteedDecorationThrow(lowerer, decl);
          if (thrown) {
            const className = lowerer.classNamer(decl);
            const info: ClassInfo = {
              def: {
                name: className,
                jsName: jsNameOverride ?? decl.name?.text ?? "",
                fields: [],
                loc: locOf(decl),
              },
              fields: new Map(),
              fieldOrder: [],
              methods: new Map(),
              decl,
              ctor: null,
              ctorParams: [],
              base: null,
              subclasses: [],
              throwingSetters: [],
              staticFields: [],
              decorationThrows: { name: thrown.name },
              // The existing ambientThrow emission (lowerClassDecoration)
              // owns the %init: earlier expressions are all pure reads,
              // so the throw is the first observable effect.
              classDecorators: {
                nodes: [thrown.node],
                shapes: [{ kind: "ambientThrow", name: thrown.name }],
              },
            };
            lowerer.classes.set(className, info);
            const classSymbol = decl.name
              ? lowerer.checker.getSymbolAtLocation(decl.name)
              : declSymbolOf(lowerer, decl);
            if (classSymbol) lowerer.classBySymbol.set(classSymbol, info);
            return;
          }
        }
        for (const member of decoratedMembers) {
          const dec = decoratorNodesOf(member)[0]!;
          const kind = ts.isMethodDeclaration(member)
            ? "method decorators"
            : ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)
              ? "accessor decorators"
              : ts.isPropertyDeclaration(member)
                ? member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AccessorKeyword)
                  ? "auto-accessor decorators"
                  : "field decorators"
                : "member decorators";
          lowerer.unsupported(
            "SC1090",
            dec,
            `${kind} (the standard context object and member replacement have no static lowering — class decorators and provably-throwing ambient decorations compile)`,
          );
        }
      }
      if (classDecoratorNodes.length > 0) {
        // Each evaluation of a class EXPRESSION decorates a freshly
        // minted class; only once-evaluated declarations have a single
        // decoration event to lower.
        if (!ts.isClassDeclaration(decl)) {
          lowerer.unsupported(
            "SC1090",
            classDecoratorNodes[0]!,
            "decorators on class expressions (each evaluation decorates a distinct class)",
          );
        }
        // A generic class declares ONCE in JS (one decoration event over
        // the one runtime Box) but compiles per instantiation here — the
        // family object is never constructed and the instantiations were
        // never individually decorated.
        if (decl.typeParameters !== undefined) {
          lowerer.unsupported(
            "SC1090",
            classDecoratorNodes[0]!,
            "decorators on generic classes (JS decorates the one runtime class; the compiled family instantiates per type argument)",
          );
        }
      }
    }
    // An abstract class is a class nothing constructs directly — tsc
    // rejects `new` on it (through class values too), so no runtime
    // trap exists to lower. It collects like any class; only the flag
    // is recorded (abstract MEMBERS are per-member, below).
    const abstractClass =
      ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true;
    // A GENERIC class declaration collects as its FAMILY (statics + the
    // instanceof interval; no instance members — those collect per
    // instantiation, `inst` set). Generic class EXPRESSIONS stay fenced:
    // each evaluation mints a distinct class in JS, and a distinct
    // FAMILY of classes has no once-evaluated story.
    const familyMode = decl.typeParameters !== undefined && inst === undefined;
    if (familyMode && !ts.isClassDeclaration(decl)) {
      lowerer.unsupported("SC1090", decl, "generic class expressions");
    }
    const className = inst ? inst.name : mixin ? mixin.name : lowerer.classNamer(decl); // program-wide qualified name

    // Collection follows module order for runtime heritage. Ordinary
    // instances use the family as their storage base; generic heritage
    // resolves a concrete base under each instance's type bindings.
    const computedBase = lowerer.computedClassBases.get(lowerer.classNamer(decl));
    let base: ClassInfo | null = inst
      ? inst.family
      : mixin
        ? mixin.base
        : (computedBase?.classInfo ?? null);
    let genericBase: ts.ExpressionWithTypeArguments | undefined;
    let callableBase: ClassInfo["callableBase"];
    let factoryBaseExpression: ts.Expression | undefined;
    const adoptCallableBase = (expression: ts.Expression): boolean => {
      if (familyMode || inst || mixin) return false;
      if (lowerer.computedCallableBases.has(decl)) {
        callableBase = {
          expression,
          constructorId: `%g.${className}.base`,
          prototypeId: `%g.${className}.basePrototype`,
        };
        return true;
      }
      const signatures = lowerer.checker.getCallSignatures(lowerer.typeOf(expression));
      const source =
        signatures.length === 1 ? lowerer.checker.signatureDeclaration(signatures[0]!) : undefined;
      if (
        !source ||
        !isJsSourceFile(source.getSourceFile()) ||
        !(ts.isFunctionDeclaration(source) || ts.isFunctionExpression(source))
      )
        return false;
      callableBase = {
        expression,
        constructorId: `%g.${className}.base`,
        prototypeId: `%g.${className}.basePrototype`,
      };
      return true;
    };
    const ownGenericBase = inst?.family.genericBase;
    if (inst && ownGenericBase) {
      const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(ownGenericBase));
      base = mapped?.kind === "object" ? (lowerer.classes.get(mapped.className) ?? null) : null;
      if (!base || base.generic)
        lowerer.unsupported(
          "SC1090",
          ownGenericBase,
          "a generic base whose type arguments have no concrete layout",
        );
    }
    for (const clause of inst || mixin || computedBase ? [] : (decl.heritageClauses ?? [])) {
      // `implements` is pure type-world: tsc checked the conformance and
      // the clause erases — nothing about the runtime class changes.
      // (Assigning an instance INTO an interface-typed slot is a separate
      // question, owned by the shape-coercion fences at those sites.)
      if (clause.token === ts.SyntaxKind.ImplementsKeyword) continue;
      const t = clause.types[0];
      if (familyMode && t) {
        const reference = ts.isPropertyAccessExpression(t.expression)
          ? t.expression.name
          : t.expression;
        const symbol = ts.isIdentifier(reference)
          ? lowerer.resolveValueSymbol(reference)
          : undefined;
        const familyBase = symbol ? lowerer.classBySymbol.get(symbol) : undefined;
        if (familyBase?.generic) {
          if (symbol && ts.isPropertyAccessExpression(t.expression))
            fenceEarlyNsMemberRef(lowerer, t.expression, symbol);
          base = familyBase;
          genericBase = t;
          continue;
        }
      }
      // `extends events.EventEmitter` — the namespace-member spelling of
      // the ambient emitter base resolves like the named import.
      if (t && ts.isPropertyAccessExpression(t.expression) && ts.isIdentifier(t.expression.name)) {
        const memberSym = lowerer.checker.getSymbolAtLocation(t.expression.name);
        const resolved =
          memberSym && memberSym.flags & ts.SymbolFlags.Alias
            ? lowerer.checker.getAliasedSymbol(memberSym)
            : memberSym;
        const globalError =
          !t.expression.questionDotToken &&
          lowerer.isStdlibGlobal(t.expression.expression, "globalThis")
            ? lowerer.builtinErrorInfoOf(resolved)
            : null;
        if (globalError && globalError.def.name !== "%DOMException") {
          if (t.typeArguments) lowerer.unsupported("SC1090", t, "extending generic classes");
          base = globalError;
          continue;
        }
        const emitterBase = lowerer.builtinEmitterInfoOf(resolved);
        const streamBaseNs = builtinStreamInfoOf(lowerer, resolved);
        if (emitterBase || streamBaseNs) {
          if (t.typeArguments) lowerer.unsupported("SC1090", t, "extending generic classes");
          base = (emitterBase ?? streamBaseNs)!;
          continue;
        }
        // `class Tower extends Shapes.Cube` — the namespace-qualified
        // base: the member resolves to the registered program class
        // (import= alias chains included), with the source-order guard
        // (the class statement evaluates at its init position; a base
        // block below it would still be uninitialized in Node).
        if (!t.expression.questionDotToken && nsMemberIdentOf(lowerer, t.expression)) {
          if (memberSym) fenceEarlyNsMemberRef(lowerer, t.expression, memberSym);
          const stored = storedClassValueType(lowerer, t.expression);
          const nsBase =
            (resolved ? lowerer.classBySymbol.get(resolved) : undefined) ??
            (stored?.kind === "classval" ? lowerer.classes.get(stored.className) : undefined);
          if (!nsBase) {
            if (adoptCallableBase(t.expression)) continue;
            lowerer.unsupported(
              "SC1090",
              t,
              `extending the namespace member '${t.expression.name.text}' (no class lowering)`,
            );
          }
          if (t.typeArguments) lowerer.unsupported("SC1090", t, "extending generic classes");
          base = nsBase;
          continue;
        }
        // `Common.O = class extends Common.I {}` — the base is a
        // PROPERTY-ASSIGNED class expression (the salsa expando form and
        // its CJS spellings `exports.I` / `module.exports.I`): the
        // member's single top-level assignment pins the class, so the
        // base resolves like a declaration. Source order guards the
        // same-file case — Node evaluates the extends clause at THIS
        // statement, and a base assigned below it is still undefined
        // here (TypeError at runtime; the fence is the honest answer).
        // Reassigned properties never reach this branch (the resolver
        // answers null for them) and keep the computed-expression fence:
        // the runtime base is whichever assignment ran last.
        if (!t.expression.questionDotToken) {
          const propBase = propertyAssignedClassInfoOf(lowerer, memberSym);
          if (propBase) {
            if (t.typeArguments) lowerer.unsupported("SC1090", t, "extending generic classes");
            const baseDecl = propBase.decl;
            if (
              baseDecl != null &&
              baseDecl.getSourceFile() === decl.getSourceFile() &&
              baseDecl.getStart() > decl.getStart()
            ) {
              lowerer.unsupported(
                "SC1090",
                t,
                `extending '${t.expression.getText()}' above the statement that assigns it (the property is still undefined when this class evaluates — Node throws here; assign the base first)`,
              );
            }
            base = propBase;
            continue;
          }
          // The REASSIGNED spelling of the same family gets its own
          // fence (the generic computed-expression one below would hide
          // what actually blocks it).
          const rebinds =
            memberSym !== undefined &&
            lowerer.checker
              .declarationsOf(memberSym)
              .filter(
                (d) =>
                  ts.isBinaryExpression(d) && d.operatorToken.kind === ts.SyntaxKind.EqualsToken,
              ).length > 1;
          if (rebinds) {
            lowerer.unsupported(
              "SC1090",
              t,
              `extending the reassigned property '${t.expression.getText()}' (the runtime base is whichever assignment ran last — bind the class exactly once)`,
            );
          }
        }
      }
      // `class extends class {…} {…}` — a class-EXPRESSION base:
      // collect it recursively (JS evaluates the extends clause first,
      // so its statics queue ahead of the derived class's — the
      // recursion order delivers exactly that).
      if (t && ts.isClassExpression(t.expression)) {
        if (t.typeArguments) lowerer.unsupported("SC1090", t, "extending generic classes");
        const baseExpr = lowerer.lowerClassExpressionInfo(t.expression);
        base = baseExpr;
        continue;
      }
      // `class D extends Mixin(Base)` — a MIXIN call as the base: the
      // call's per-site instantiation (its heritage the argument class)
      // is the base — interval nesting, fields, and methods compose
      // through the monomorphized chain (lower-mixins.ts). A call whose
      // callee is NOT a mixin function keeps the computed-expression
      // fence below.
      if (t && ts.isCallExpression(t.expression) && !t.typeArguments) {
        const mixinBase = lowerer.mixinCallClassInfoOf(t.expression);
        if (mixinBase) {
          base = mixinBase;
          continue;
        }
        const stored = storedClassValueType(lowerer, t.expression);
        const factoryBase =
          stored?.kind === "classval" ? lowerer.classes.get(stored.className) : undefined;
        if (factoryBase) {
          base = factoryBase;
          factoryBaseExpression = t.expression;
          continue;
        }
      }
      if (!t || !ts.isIdentifier(t.expression)) {
        if (t && adoptCallableBase(t.expression)) continue;
        lowerer.unsupported("SC1090", clause, "extending computed expressions");
      }
      const symbol = lowerer.resolveValueSymbol(t.expression);
      // Extending a REBINDABLE decorated class (analysis already ran —
      // this collection is a class expression or a generic
      // instantiation demanded during lowering): the runtime base is
      // the decoration result, not the declaration. Declared
      // subclasses collected BEFORE analysis meet the same fence from
      // analyzeClassDecoration's subclasses check.
      {
        const directBase = symbol && lowerer.classBySymbol.get(symbol);
        if (directBase && directBase.classDecorators?.valueGlobalId !== undefined) {
          lowerer.unsupported(
            "SC1090",
            t,
            `extending the decorated class '${directBase.def.jsName ?? directBase.def.name}' (its decorators may replace it — the runtime base would be the decoration result)`,
          );
        }
        if (directBase) fenceDecorationThrows(lowerer, directBase, t);
      }
      // `extends DOMException`: the runtime instance carries hidden
      // slots (the legacy code, the cause) BEYOND the ScrError prefix
      // the IR fields describe — a subclass layout would overlap them.
      if (lowerer.builtinErrorInfoOf(symbol)?.def.name === "%DOMException") {
        lowerer.unsupported(
          "SC1090",
          t,
          "extending DOMException (its runtime layout carries hidden slots a subclass would overlap — extend Error and set name/code yourself)",
        );
      }
      const named =
        (symbol && lowerer.classBySymbol.get(symbol)) ??
        lowerer.builtinErrorInfoOf(symbol) ??
        lowerer.builtinEmitterInfoOf(symbol) ??
        builtinStreamInfoOf(lowerer, symbol) ??
        // A const BINDING holding exactly one class (`const B = Animal`,
        // `const B = class {…}`): the base is that class — extends
        // through the alias is the declaration story (a general class
        // VALUE stays fenced: the runtime base would be dynamic).
        exactClassOfReceiver(lowerer, t.expression) ??
        // A require BINDING of a class-expression whole export
        // (`const C = require('./x')` over `module.exports = class {…}`):
        // the alias resolves to the expression's own symbol — the same
        // declaration story, collected on demand.
        propertyAssignedClassInfoOf(lowerer, symbol) ??
        // A const BINDING of a mixin call (`const Tagged = M(Base);
        // class D extends Tagged {}`): the binding pins that call's
        // instantiation — collected on demand (lower-mixins.ts).
        mixinResultBindingClassOf(lowerer, symbol) ??
        (() => {
          const stored = storedClassValueType(lowerer, t.expression);
          return stored?.kind === "classval" ? lowerer.classes.get(stored.className) : null;
        })() ??
        null;
      // `extends Box<number>` — a GENERIC program class as the base: the
      // base is the concrete INSTANTIATION, resolved through the heritage
      // type (mapType registers/reuses `Box%0`).
      if (named?.generic) {
        const instT = lowerer.checker.getTypeAtLocation(t);
        const mappedBase = lowerer.mapTypeOf(instT);
        const instBase =
          mappedBase?.kind === "object" ? lowerer.classes.get(mappedBase.className) : undefined;
        if (!instBase || instBase.generic) {
          lowerer.unsupported(
            "SC1090",
            t,
            `extending the generic class '${t.expression.text}' without a compiled concrete instantiation (the type arguments must map — see the instantiation's own diagnostic)`,
          );
        }
        base = instBase;
        continue;
      }
      if (t.typeArguments) lowerer.unsupported("SC1090", t, "extending generic classes");
      base = named;
      if (!base) {
        if (adoptCallableBase(t.expression)) continue;
        lowerer.unsupported(
          "SC1090",
          t,
          `extending classes not declared in the program ('${t.expression.text}')`,
        );
      }
    }

    if (base?.localClass && !functionLocalClass(decl) && !computedBase && !factoryBaseExpression) {
      const heritage = decl.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types[0];
      if (heritage) factoryBaseExpression = heritage.expression;
      else
        lowerer.unsupported("SC1090", decl, "extending a function-local class outside a function");
    }
    if (lowerer.collectingExprClasses.has(decl)) {
      for (let parent = base; parent; parent = parent.base) {
        if (parent.builtinEmitter || parent.builtinStream !== undefined) {
          lowerer.unsupported(
            "SC1090",
            decl,
            "classes extending builtin bases as values (the inherited runtime constructor has no class-value adapter)",
          );
        }
      }
    }
    const fields = new Map<string, IrType>(base ? base.fields : []);
    const errorRooted = (() => {
      for (let c = base; c; c = c.base) if (c.builtinError) return true;
      return false;
    })();
    const symbolFields = new Map<ts.Symbol, string>();
    if (base?.symbolFields)
      for (const [symbol, name] of base.symbolFields) symbolFields.set(symbol, name);
    const symbolMethods = new Map<ts.Symbol, string>();
    if (base?.symbolMethods)
      for (const [symbol, name] of base.symbolMethods) symbolMethods.set(symbol, name);
    const fieldOrder: ClassInfo["fieldOrder"] = [];
    const methods = new Map<
      string,
      {
        params: ParamShape[];
        ret: IrType;
        abstract?: true;
        async?: true;
        gen?: NonNullable<IrFunction["generator"]>;
      }
    >();
    const methodEntryFences = new Map<string, ScrDiagnostic>();
    // Own accessor declarations ("get:x"/"set:x" → node), for the
    // partial-override analysis below (diagnostics need the node).
    const accessorNodes = new Map<string, ts.AccessorDeclaration>();
    /** Non-override methods whose collected return stayed dyn — the
     * symbol-slot refinement retries them after the constructor scan
     * declares this class's OWN symbol-keyed slots. */
    const dynRetMethods = new Map<string, ts.MethodDeclaration>();
    /** The class's own `emit` override in the forwarding shape (emitter-
     * rooted classes only) — recorded here, NEVER in `methods`, so emit
     * calls keep routing through the emitter spoke's dispatch. */
    let emitOverride: EmitOverrideRec | undefined;
    let ctor: ts.ConstructorDeclaration | null = null;
    /** Initializer-less fields whose type cannot hold undefined and whose
     * definite assignment tsc did NOT verify (a `!` assertion, or
     * strictPropertyInitialization off) — checked against the
     * constructor's top-level assignments after the member loop. */
    const unguardedFields: { node: ts.Node; name: string; why: string }[] = [];
    /** Parameter properties, in parameter order — spliced in FRONT of the
     * declared fields after the member loop (Node's layout, probed: the
     * transform hoists their definitions above every declared field). */
    const paramProps: NonNullable<ClassInfo["paramProps"]> = [];

    const staticFields: ClassInfo["staticFields"] = [];
    const staticMethods: NonNullable<ClassInfo["staticMethods"]> = new Map();
    const staticBlocks: ts.ClassStaticBlockDeclaration[] = [];
    const runtimeStatics: ts.ClassElement[] = [];
    const runtimePrototypeMembers: ts.ClassElement[] = [];
    // Public JS accessors need live constructor descriptors, including
    // receiver-sensitive getters and setters inherited by subclasses.
    const checkedStatics =
      isJsSourceFile(decl.getSourceFile()) &&
      ((base && hasRuntimeStatics(base)) ||
        decl.members.some(
          (member) =>
            ts.isAccessor(member) &&
            !ts.isPrivateIdentifier(member.name) &&
            member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
        )) &&
      !decl.members.some(
        (member) =>
          member.name &&
          ts.isPrivateIdentifier(member.name) &&
          ts
            .getModifiers(member)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
      );
    // GENERIC methods (own type parameters), instance and static: only
    // the SYNTAX is checked here — parameter/return types mention the
    // type parameters and cannot map yet; bodies lower per call-site
    // instantiation (collectGenericSignature's rule, member form). The
    // `member.cls` backlink fills after the ClassInfo assembles below.
    const genericMethods = new Map<string, GenericFnInfo>();
    const genericStatics = new Map<string, GenericFnInfo>();
    // Accepts generic METHODS and instance FIELDS initialized with a
    // generic arrow/function expression (`time = async <T>(...) => {...}`
    // — the field form of a generic method: no closure slot can hold a
    // generic function, so the member collects aside like a method and
    // calls dispatch statically per instantiation; the arrow's lexical
    // `this` IS the instance, exactly the method's param 0). ASYNC
    // members collect too: a generic async instance is an async
    // IrFunction like any other (lowerGenericInstance), calls enter
    // through the instance's own spawn wrapper, and no vtable slot is
    // ever involved — generic members always dispatch statically.
    const collectGenericMember = (
      member: ts.MethodDeclaration | ts.PropertyDeclaration,
      isStatic: boolean,
    ): void => {
      const fnNode: ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression =
        ts.isPropertyDeclaration(member)
          ? (genericFieldFnNodeOf(member) as ts.ArrowFunction | ts.FunctionExpression)
          : member;
      if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name)) {
        lowerer.unsupported("SC1090", member, "computed generic method names");
      }
      if (fnNode.asteriskToken) lowerer.unsupported("SC1071", member);
      const mName = (member.name as ts.Identifier | ts.PrivateIdentifier).text;
      const typeParams: ts.Symbol[] = [];
      for (const tp of fnNode.typeParameters!) {
        const sym = lowerer.checker.getSymbolAtLocation(tp.name);
        if (!sym) lowerer.unsupported("SC1090", member, "this method form");
        typeParams.push(sym);
      }
      for (const param of fnNode.parameters) {
        if (
          !ts.isIdentifier(param.name) &&
          !ts.isObjectBindingPattern(param.name) &&
          !ts.isArrayBindingPattern(param.name)
        ) {
          lowerer.unsupported("SC1031", param);
        }
      }
      (isStatic ? genericStatics : genericMethods).set(mName, {
        decl: fnNode,
        baseName: mName,
        qualifiedName: `%${className}.${isStatic ? "static:" : ""}${mName}`,
        typeParams,
        instances: new Map(),
      });
    };
    for (const member of decl.members) {
      if (
        (functionLocalClass(decl) || checkedStatics) &&
        isJsSourceFile(decl.getSourceFile()) &&
        (ts.isClassStaticBlockDeclaration(member) ||
          ts
            .getModifiers(member)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
      ) {
        runtimeStatics.push(member);
        continue;
      }
      if (
        functionLocalClass(decl) &&
        isJsSourceFile(decl.getSourceFile()) &&
        (ts.isMethodDeclaration(member) || ts.isAccessor(member)) &&
        member.body &&
        !ts.isPrivateIdentifier(member.name)
      ) {
        runtimePrototypeMembers.push(member);
        if (
          ts.isComputedPropertyName(member.name) &&
          classMemberNameOf(lowerer, member.name) === null
        )
          continue;
      }
      if (ts.isClassStaticBlockDeclaration(member)) {
        // Statics live on the FAMILY (JS has one class, one static
        // storage, however many instantiations exist) — instantiations
        // skip them.
        if (inst) continue;
        // A static block is declaration-time CODE — Node runs it when the
        // class statement evaluates, referenced or not — so it collects
        // for %init lowering (lowerStaticFieldInits) instead of fencing.
        // `this` (and super) inside the block means the class constructor
        // value, which has no value form here: fenced at the reference,
        // with arrow functions transparent (they inherit the block's
        // `this`) and this-binding function forms opaque (their `this` is
        // their own).
        rejectStaticThis(
          lowerer,
          member.body,
          () =>
            "'this' in class static blocks (it names the class — reference the class by name instead)",
        );
        staticBlocks.push(member);
        continue;
      }
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
      if (modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
        // Statics live on the FAMILY (one storage location for every
        // instantiation — JS's one class); instantiations skip them and
        // reach them through the base chain (findStaticOn).
        if (inst) continue;
        // The honest static subset: a field WITH an initializer is a
        // module global (mutable when not readonly) assigned once at
        // the class statement's position in module init and read as
        // `C.name` anywhere; a static METHOD is an ordinary module
        // function `%C.static:m`. No per-class runtime property table
        // exists, so the members that would need one — accessors, and
        // initializer-less fields (undefined until someone assigns
        // them) — keep the fence, each named at its use site.
        // #PRIVATE statics ride along under their spelled names
        // ('#count' → the module global %g.s.C.#count, '#make' → the
        // module function %C.static:#make): tsc confines every access
        // to the declaring class's body, and the resolution guard in
        // findStaticOn's callers keeps a SUBCLASS-named receiver
        // (`D.#s` — Node's brand TypeError) from resolving up the
        // chain. Class-VALUE receivers fence for privates (a classval
        // slot can hold a descendant at runtime, and only the declaring
        // class object carries the brand in JS).
        if (
          ts.isPropertyDeclaration(member) &&
          (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) &&
          member.initializer &&
          member.postfixToken?.kind !== ts.SyntaxKind.QuestionToken
        ) {
          const initializerSymbol = ts.isIdentifier(member.initializer)
            ? lowerer.resolveValueSymbol(member.initializer)
            : null;
          // Enum namespace aliases are erased; member reads fold through the checker.
          if (initializerSymbol && (initializerSymbol.flags & ts.SymbolFlags.Enum) !== 0) continue;
          const type = lowerer.irTypeOf(member.name);
          if (type.kind === "void") lowerer.badType(member.name, lowerer.typeOf(member.name));
          if (
            type.kind === "dyn" &&
            !isJsSourceFile(member.getSourceFile()) &&
            !lowerer.classImplementedProtocol(lowerer.typeOf(member.name)) &&
            (member.type !== undefined ||
              (lowerer.typeOf(member.name).flags & ts.TypeFlags.Any) === 0)
          ) {
            lowerer.unsupported("SC1090", member.name, "'unknown'-typed static fields");
          }
          staticFields.push({
            name: member.name.text,
            type,
            initializer: member.initializer,
            globalId: `%g.s.${lowerer.classNamer(decl)}.${member.name.text}`,
            readonly: modifiers.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword),
          });
        }
        // Async statics collect like any static method: the module
        // function `%C.static:m` is an async IrFunction (fiber spawn
        // wrapper), no vtable in sight — statics never dispatch.
        if (
          ts.isMethodDeclaration(member) &&
          (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) &&
          member.body &&
          member.typeParameters === undefined
        ) {
          const { shapes, funcType: ft } = lowerer.lambdaSignature(member);
          if (member.asteriskToken !== undefined && ft.ret.kind !== "generator") {
            lowerer.badType(member.name, lowerer.typeOf(member.name));
          }
          staticMethods.set(member.name.text, { params: shapes, ret: ft.ret, member });
          if (
            implicitMonoFile(decl.getSourceFile()) &&
            !functionLocalClass(decl) &&
            inst === undefined &&
            decl.typeParameters === undefined
          ) {
            const implicit = implicitAnyParamSymbolsOf(lowerer, member, true);
            if (implicit)
              genericStatics.set(member.name.text, {
                decl: member,
                baseName: member.name.text,
                qualifiedName: `%${className}.static:${member.name.text}%implicit`,
                typeParams: [],
                instances: new Map(),
                implicitParams: implicit,
              });
          }
        }
        // GENERIC static methods monomorphize like top-level generic
        // functions (`%C.static:m%n`), async ones included — a generic
        // async instance is an async module function entered through its
        // own spawn wrapper (the async-static precedent above, per
        // instantiation).
        if (
          ts.isMethodDeclaration(member) &&
          (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) &&
          member.body &&
          member.typeParameters !== undefined
        ) {
          collectGenericMember(member, true);
        }
        // Statics that don't qualify for the module-global/module-
        // function treatment (accessors, initializer-less fields,
        // async/generic methods) never live on instances, so they must
        // not poison the class either — constructions and instance
        // members stay compilable, and each USE of an unsupported
        // static fences at its own site.
        continue;
      }
      // INSTANCE members of a generic class collect per instantiation
      // (`inst` set, the type-parameter bindings threaded through every
      // mapType) — the family declares none.
      if (familyMode) continue;
      // 7's ClassElement base carries no `name`; read it structurally
      // (every named member kind stores a PropertyName there).
      const memberName = (member as { name?: ts.PropertyName }).name;
      if (errorRooted && memberName && classMemberNameOf(lowerer, memberName) === "cause") {
        if (
          ts.isPropertyDeclaration(member) &&
          !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
        ) {
          if (!isJsSourceFile(member.getSourceFile()))
            lowerer.unsupported(
              "SC1090",
              memberName,
              "redeclaring Error.cause (pass the cause in the Error constructor options)",
            );
          fieldOrder.push({
            name: "cause",
            type: DYN,
            initializer: member.initializer,
            ...(member.initializer ? {} : { undefinedInitializer: locOf(member) }),
            redeclared: true,
            errorCause: true,
          });
          continue;
        }
        lowerer.unsupported("SC1090", memberName, "Error.cause accessors");
      }
      // #PRIVATE members compile: their names ('#m') are unspellable by
      // any public identifier, so they ride the ordinary fields/methods
      // maps collision-free — with the base-chain walks doubling as
      // LEXICAL resolution because a subclass re-declaring an inherited
      // private NAME is fenced here (JS would give the two classes
      // DISTINCT private slots under one spelling; one name, one slot is
      // the static story — rename one). tsc guarantees every access site
      // sits inside the declaring class's body, and privates never
      // enter vtables (no redeclaration below ⇒ overrideBelow is false
      // ⇒ every call devirtualizes), which is exactly JS's semantics:
      // lexically bound, no dynamic dispatch, a subclass cannot
      // override.
      if (memberName && ts.isPrivateIdentifier(memberName)) {
        const pname = memberName.text;
        if (
          base !== null &&
          (base.fields.has(pname) ||
            lowerer.findMethodOn(base, pname) !== null ||
            lowerer.findMethodOn(base, `get:${pname}`) !== null ||
            lowerer.findMethodOn(base, `set:${pname}`) !== null ||
            findGenericMethodOn(lowerer, base, pname) !== null)
        ) {
          lowerer.unsupported(
            "SC1090",
            memberName,
            `redeclaring the private name '${pname}' of a base class (JS gives each class its own distinct '${pname}' slot; these layouts have one slot per name — rename one)`,
          );
        }
      }
      // The EventEmitter API surface is runtime-provided: a subclass
      // member with one of its names would shadow behavior the runtime
      // dispatches internally (meta events, once removal), so the
      // override is fenced rather than silently split-brained — with ONE
      // exception: `emit` in the forwarding shape on a plain (non-
      // stream) emitter-rooted class monomorphizes per event name
      // (lower-event-emitter.ts's emit-overrides block). Stream-rooted classes
      // keep the fence for emit too: the runtime stream machinery emits
      // 'data'/'end'/... internally, which could never route through
      // the override.
      if (
        memberName &&
        ts.isIdentifier(memberName) &&
        EMITTER_API_MEMBERS.has(memberName.text) &&
        (() => {
          for (let c = base; c; c = c.base) if (c.builtinEmitter) return true;
          return false;
        })()
      ) {
        const streamRooted = (() => {
          for (let c = base; c; c = c.base) if (c.builtinStream !== undefined) return true;
          return false;
        })();
        if (
          memberName.text === "emit" &&
          !streamRooted &&
          !inst &&
          !mixin &&
          ts.isMethodDeclaration(member) &&
          !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
        ) {
          const reason = emitOverrideShapeReason(lowerer, member);
          if (reason === null) {
            const eventSym = lowerer.checker.getSymbolAtLocation(member.parameters[0]!.name);
            const restSym = lowerer.checker.getSymbolAtLocation(member.parameters[1]!.name);
            if (eventSym && restSym) {
              emitOverride = { decl: member, eventSym, restSym };
              continue;
            }
          }
          lowerer.unsupported(
            "SC1090",
            memberName,
            `overriding EventEmitter's 'emit' outside the forwarding shape (${reason ?? "its parameters do not resolve statically"}; the compiled form is \`emit(event: string, ...args: unknown[]): boolean\`)`,
          );
        }
        lowerer.unsupported(
          "SC1090",
          memberName,
          `overriding the EventEmitter member '${memberName.text}' (the runtime owns the emitter surface)`,
        );
      }
      // The stream surface is likewise runtime-provided on stream-rooted
      // subclasses: API members (push/read/write/...) and the property
      // family (readableEnded/destroyed/...) dispatch into the runtime
      // state, so an override or shadowing field would split-brain.
      // Underscore methods are the SUPPORTED override form — but only
      // the ones the class's own base consumes (a `_read` on a
      // Transform, or `_writev`/`_construct` anywhere, would be consumed
      // by Node machinery that has no lowering here).
      if (memberName && ts.isIdentifier(memberName)) {
        const streamBase = (() => {
          for (let c = base; c; c = c.base) if (c.builtinStream) return c;
          return null;
        })();
        if (streamBase) {
          const name = memberName.text;
          if (STREAM_API_MEMBERS.has(name) || STREAM_PROP_MEMBERS.has(name)) {
            lowerer.unsupported(
              "SC1090",
              memberName,
              `overriding the stream member '${name}' (the runtime owns the stream surface)`,
            );
          }
          if (name === "_writev" || name === "_construct") {
            lowerer.unsupported(
              "SC1090",
              memberName,
              `declaring '${name}' on a stream subclass (${name === "_writev" ? "batched writes are" : "deferred construction is"} not lowered — writes deliver one chunk at a time)`,
            );
          }
          const accepted = streamCtorShape(streamBase.def.name).accepted;
          for (const [option, methodName] of UNDERSCORE_METHODS) {
            if (name === methodName && !accepted.includes(option)) {
              lowerer.unsupported(
                "SC1090",
                memberName,
                `declaring '${name}' on a ${streamBase.def.name.slice(1)} subclass (its constructor consumes ${accepted.map((a) => `'${UNDERSCORE_METHODS.get(a)}'`).join("/")})`,
              );
            }
          }
        }
      }
      if (ts.isPropertyDeclaration(member)) {
        // An ABSTRACT property declaration is erased at runtime — Node
        // defines NO field for it (verified: `abstract p: number` in the
        // base leaves the concrete subclass's own `p = 3` as the only
        // property, at the SUBCLASS's position in inspect order). So it
        // contributes nothing to the layout; the concrete subclass's
        // declaration is an ordinary OWN field (tsc guarantees every
        // instantiable subclass declares it and, under
        // strictPropertyInitialization, initializes it). Reads through
        // ABSTRACT-typed receivers have no slot to read and keep a
        // per-site fence.
        if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) continue;
        if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AccessorKeyword)) {
          // `accessor x = 1` desugars (in JS) to a private slot plus a
          // get/set pair — declare the field and accessors explicitly.
          lowerer.unsupported("SC1090", member, "auto-accessor fields ('accessor x')");
        }
        if (
          ts.isComputedPropertyName(member.name) ||
          ts.isStringLiteralLike(member.name) ||
          ts.isNumericLiteral(member.name)
        ) {
          const symbolKey = ts.isComputedPropertyName(member.name)
            ? classSymbolKeyOf(lowerer, member.name.expression)
            : null;
          const stringKey = ts.isComputedPropertyName(member.name)
            ? lowerer.foldedStringKeyOf(member.name.expression)
            : ts.isNumericLiteral(member.name)
              ? String(Number(member.name.text))
              : member.name.text;
          const fieldName = symbolKey?.fieldName ?? stringKey;
          if (
            fieldName === null ||
            (!member.initializer && !isJsSourceFile(member.getSourceFile()))
          ) {
            lowerer.unsupported(
              "SC1090",
              member,
              "computed class fields without an initializer and a stable string, number, or module-level literal Symbol()/Symbol.for() key",
            );
          }
          const declared = lowerer.typeOf(member);
          const inferred =
            member.type || !member.initializer
              ? declared
              : lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(member.initializer));
          const mapped = member.initializer
            ? (lowerer.mapTypeOf(inferred) ?? dynFallbackType(lowerer, member, inferred))
            : DYN;
          let type =
            mapped?.kind === "record" && isJsSourceFile(member.getSourceFile()) && !member.type
              ? DYN
              : mapped
                ? jsOpenObjectType(member, mapped, lowerer.shapes, lowerer.unions)
                : null;
          if (
            !type ||
            type.kind === "void" ||
            (type.kind === "dyn" &&
              !isJsSourceFile(member.getSourceFile()) &&
              !lowerer.classImplementedProtocol(inferred))
          )
            lowerer.badType(member, inferred);
          if (isJsSourceFile(member.getSourceFile())) {
            type = inheritedJsFieldType(lowerer, decl, fieldName, type);
            if (base?.fields.get(fieldName)?.kind === "dyn") type = DYN;
            if (base && !fields.has(fieldName) && lowerer.dynConvertible(type)) type = DYN;
          }
          const undefinedInitializer = !member.initializer ? locOf(member) : undefined;
          const previous = fields.get(fieldName);
          if (previous) {
            if (symbolKey && !symbolFields.has(symbolKey.identity)) {
              lowerer.unsupported(
                "SC1090",
                member.name,
                `distinct keys sharing the printable name '${symbolFieldDisplayName(fieldName)}' in one class`,
              );
            }
            if (!typeEquals(previous, type)) {
              lowerer.unsupported(
                "SC1090",
                member.name,
                "redeclaring computed fields at a different type",
              );
            }
            fieldOrder.push({
              name: fieldName,
              type,
              initializer: member.initializer,
              ...(undefinedInitializer ? { undefinedInitializer } : {}),
              redeclared: true,
            });
          } else {
            fields.set(fieldName, type);
            fieldOrder.push({
              name: fieldName,
              type,
              initializer: member.initializer,
              ...(undefinedInitializer ? { undefinedInitializer } : {}),
            });
          }
          if (symbolKey) symbolFields.set(symbolKey.identity, fieldName);
          continue;
        }
        // #private fields ride the ordinary field machinery — the '#'
        // name is unspellable publicly, so the slot never collides, and
        // enumeration surfaces (inspect) exclude it like Node.
        if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name)) {
          lowerer.unsupported("SC1090", member, "computed field names");
        }
        // A field initialized with a GENERIC arrow/function expression
        // (`time = async <T>(label, fn) => {...}` — the Output.time
        // idiom): a generic MEMBER, not a field. No closure slot can
        // hold a generic function (the record-shape exclusion rule), so
        // the member collects like a generic method — no field slot,
        // static per-instantiation dispatch, `this` as param 0 (the
        // arrow's lexical `this` IS the instance). Reads of the field as
        // a VALUE and writes to it fence at their sites — there is no
        // slot — which enforces never-reassigned by construction.
        // Guarded on the member TYPE still carrying its type parameters:
        // an annotation that pins a concrete signature makes an ordinary
        // closure field, which the normal path below owns.
        if (
          genericFieldFnNodeOf(member) !== null &&
          isGenericCallableMemberType(lowerer.typeOf(member.name), lowerer.checker)
        ) {
          if (fields.has(member.name.text)) {
            lowerer.unsupported("SC1090", member.name, "redeclaring inherited fields");
          }
          if (lowerer.findMethodOn(base, member.name.text)) {
            lowerer.unsupported("SC1090", member.name, "fields shadowing inherited methods");
          }
          if (findGenericMethodOn(lowerer, base, member.name.text)) {
            lowerer.unsupported(
              "SC1090",
              member.name,
              `redeclaring the inherited generic member '${member.name.text}' (generic members dispatch statically, so the base's call sites could never reach this redeclaration)`,
            );
          }
          collectGenericMember(member, false);
          continue;
        }
        // Non-generic fields shadowing an inherited GENERIC member split
        // the two dispatch worlds (static per-instantiation calls would
        // never see the field's value) — the method-vs-generic mixing
        // fence, field form.
        if (findGenericMethodOn(lowerer, base, member.name.text)) {
          lowerer.unsupported(
            "SC1090",
            member.name,
            `fields shadowing the inherited generic member '${member.name.text}' (generic members dispatch statically and would never reach this field's value)`,
          );
        }
        // OPTIONAL fields (`a?: string`) are the record-field precedent
        // applied to class shapes: the checker already types the slot
        // `string | undefined`, the allocation writes the interned
        // undefined arm (undefFieldInitLineC — Node defines the property
        // as undefined on construction, verified), and reads/writes ride
        // the ordinary undefined-armed union machinery.
        let type = lowerer.irTypeOf(member.name);
        if (isJsSourceFile(member.getSourceFile()) && !member.initializer) {
          const constructor = decl.members.find(
            (part): part is ts.ConstructorDeclaration =>
              ts.isConstructorDeclaration(part) && !!part.body,
          );
          for (const statement of constructor?.body?.statements ?? []) {
            if (
              !ts.isExpressionStatement(statement) ||
              !ts.isBinaryExpression(statement.expression) ||
              statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
            )
              continue;
            const left = statement.expression.left;
            if (
              !ts.isPropertyAccessExpression(left) ||
              left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
              left.name.text !== member.name.text
            )
              continue;
            type =
              statement.expression.right.kind === ts.SyntaxKind.NullKeyword
                ? DYN
                : jsFieldInitializerType(lowerer, type, statement.expression.right);
          }
        }
        // Unannotated JavaScript callback slots retain the original
        // callable and its receiver instead of adapting its signature.
        if (
          isJsSourceFile(member.getSourceFile()) &&
          !member.type &&
          !/@type\b/.test(member.getSourceFile().text.slice(member.pos, member.getStart())) &&
          (type.kind === "func" || type.kind === "record") &&
          lowerer.dynConvertible(type)
        )
          type = DYN;
        // JS permits reads before a constructor's first assignment even
        // when its inferred field type omits undefined.
        if (isJsSourceFile(member.getSourceFile()) && !member.initializer && type.kind !== "dyn") {
          type = lowerer.withUndefinedArmOf(type) ?? DYN;
        }
        if (isJsSourceFile(member.getSourceFile())) {
          type = inheritedJsFieldType(lowerer, decl, member.name.text, type);
          if (base?.fields.get(member.name.text)?.kind === "dyn") type = DYN;
          if (base && !fields.has(member.name.text) && lowerer.dynConvertible(type)) type = DYN;
        }
        if (type.kind === "void") lowerer.badType(member.name, lowerer.typeOf(member.name));
        // Bundled JS declares fields without annotations before assigning
        // them in the constructor. Use the same native checked-dynamic
        // storage as implicit constructor-assigned JS fields.
        if (
          type.kind === "dyn" &&
          !isJsSourceFile(member.getSourceFile()) &&
          !lowerer.classImplementedProtocol(lowerer.typeOf(member.name))
        ) {
          lowerer.unsupported("SC1090", member.name, "'unknown'-typed class fields");
        }
        const undefinedInitializer =
          type.kind === "dyn" && !member.initializer ? locOf(member) : undefined;
        if (fields.has(member.name.text)) {
          // REDECLARING an inherited field: Node [[Define]]s the OWN
          // property again when THIS class's field initializers run
          // (after super()), so the base slot simply takes the new
          // value at that position — a slot-type-exact redeclare WITH
          // an initializer lowers as an assignment into the inherited
          // slot, no new slot, no layout change (the `class
          // ConfigError extends Error { name = "ConfigError" }`; the
          // builtin Error prefix included — reads, toString, and throw
          // reports all answer the overwritten name like Node). A bare
          // JS dyn redeclaration resets the existing slot to undefined.
          // Other bare or type-changing redeclarations keep the fence.
          const baseType = fields.get(member.name.text)!;
          if ((member.initializer || type.kind === "dyn") && typeEquals(type, baseType)) {
            fieldOrder.push({
              name: member.name.text,
              type,
              initializer: member.initializer,
              ...(undefinedInitializer ? { undefinedInitializer } : {}),
              redeclared: true,
            });
            continue;
          }
          lowerer.unsupported(
            "SC1090",
            member.name,
            member.initializer
              ? "redeclaring inherited fields at a different type"
              : "redeclaring inherited fields without an initializer (Node resets the field to undefined)",
          );
        }
        if (lowerer.findMethodOn(base, member.name.text)) {
          lowerer.unsupported("SC1090", member.name, "fields shadowing inherited methods");
        }
        // Initializer-less fields whose type ADMITS undefined start as
        // JS's undefined (the allocation writes the interned undefined
        // arm — see the backend's undefFieldInitLineC), exactly Node's
        // fresh-instance read. A field whose type CANNOT hold undefined
        // has no honest pre-assignment value in these monomorphic
        // layouts — zeroed memory would read as garbage (0, NULL) where
        // Node reads undefined — so it needs a definite-assignment
        // guarantee. tsc's strictPropertyInitialization is that
        // guarantee; where the program waives it — a `x!: T` assertion,
        // or a project tsconfig with the option off (scriptc adopts the
        // project's strictness knobs) — the field goes on the deferred
        // list checked against the constructor after the member loop
        // (the constructor may be declared later in the class body).
        const admitsUndefined =
          (type.kind === "union" &&
            (lowerer.unions.get(type.unionId)?.arms.some((a) => a.kind === "undefinedT") ??
              false)) ||
          type.kind === "jsval" ||
          type.kind === "dyn";
        if (!member.initializer && !admitsUndefined) {
          const opts = lowerer.program.getCompilerOptions();
          const spi = opts.strictPropertyInitialization ?? opts.strict ?? false;
          if (member.postfixToken?.kind === ts.SyntaxKind.ExclamationToken) {
            unguardedFields.push({
              node: member.name,
              name: member.name.text,
              why: `definite assignment assertions on fields not assigned at the constructor's top level ('${member.name.text}!' defers the first assignment past construction — the field would hold garbage, not undefined, until it runs; assign it in the constructor or include undefined in its type)`,
            });
          } else if (!spi) {
            unguardedFields.push({
              node: member.name,
              name: member.name.text,
              why: `initializer-less fields not assigned at the constructor's top level when strictPropertyInitialization is off (nothing guarantees '${member.name.text}' is assigned before a read — enable the option, assign it unconditionally at the top of the constructor, or include undefined in its type)`,
            });
          }
        }
        fields.set(member.name.text, type);
        fieldOrder.push({
          name: member.name.text,
          type,
          initializer: member.initializer,
          ...(undefinedInitializer ? { undefinedInitializer } : {}),
        });
      } else if (ts.isConstructorDeclaration(member)) {
        // A body-less constructor is an OVERLOAD SIGNATURE: type-world,
        // lowers to nothing — tsc resolved each `new` against the
        // signatures, and construction flows through the implementation's
        // ABI (its parameter types are supersets by the
        // overload-compatibility rules).
        if (!member.body) continue;
        if (ctor) lowerer.unsupported("SC1090", member, "constructor overloads");
        // PARAMETER PROPERTIES (`constructor(public x: number)`): pure
        // sugar — the parameter declares a field and assigns it from the
        // parameter's value. Visibility (public/private/protected) and
        // readonly/override are type-world; the field is an ordinary
        // property at runtime. The field's type is the parameter's BODY
        // type (paramShape's contract: the plain T of a defaulted
        // `public x = e`, the `T | undefined` union of `public x?: T`) —
        // exactly what the ctor's body local carries, so the synthesized
        // assignment is slot-exact. Layout/inspect position and
        // assignment order are Node's, probed exactly: the fields define
        // FIRST (before every declared field, as undefined), and the
        // assignments run after super() and the field initializers, in
        // parameter order (see paramPropInitStmts).
        for (const p of member.parameters) {
          const isParamProp = p.modifiers?.some(
            (m) =>
              m.kind === ts.SyntaxKind.PublicKeyword ||
              m.kind === ts.SyntaxKind.PrivateKeyword ||
              m.kind === ts.SyntaxKind.ProtectedKeyword ||
              m.kind === ts.SyntaxKind.ReadonlyKeyword ||
              m.kind === ts.SyntaxKind.OverrideKeyword,
          );
          if (!isParamProp) {
            // Non-keyword modifiers (parameter decorators) are rejected
            // by tsc under standard decorators; defensive.
            if (p.modifiers?.length) lowerer.unsupported("SC1090", p, "this parameter form");
            continue;
          }
          // tsc rejects binding patterns (TS1187) and rest params
          // (TS1317) as parameter properties; defensive.
          if (!ts.isIdentifier(p.name) || p.dotDotDotToken) {
            lowerer.unsupported("SC1090", p, "this parameter property form");
          }
          const name = (p.name as ts.Identifier).text;
          if (errorRooted && name === "cause") {
            lowerer.unsupported(
              "SC1090",
              p.name,
              "redeclaring Error.cause (pass the cause in the Error constructor options)",
            );
          }
          const shape = lowerer.paramShape(p);
          const type = shape.bodyType ?? shape.type;
          if (type.kind === "void") lowerer.badType(p.name, lowerer.typeOf(p.name));
          // The class-field dyn rule verbatim (KEEP NARROW).
          if (type.kind === "dyn" && !lowerer.classImplementedProtocol(lowerer.typeOf(p))) {
            lowerer.unsupported("SC1090", p.name, "'unknown'-typed class fields");
          }
          // `override x` (and any same-named inherited member) would
          // redeclare a base slot — the declared-field rule verbatim.
          if (fields.has(name)) {
            lowerer.unsupported("SC1090", p.name, "redeclaring inherited fields");
          }
          if (lowerer.findMethodOn(base, name)) {
            lowerer.unsupported("SC1090", p.name, "fields shadowing inherited methods");
          }
          paramProps.push({ name, type, param: p });
        }
        ctor = member;
      } else if (ts.isMethodDeclaration(member)) {
        const mName = classMemberNameOf(lowerer, member.name);
        if (mName === null) lowerer.unsupported("SC1090", member, "computed method names");
        if (ts.isComputedPropertyName(member.name)) {
          const key = classSymbolKeyOf(lowerer, member.name.expression);
          if (key) {
            if (
              [...symbolMethods, ...symbolFields].some(
                ([identity, name]) => name === mName && identity !== key.identity,
              )
            ) {
              lowerer.unsupported(
                "SC1090",
                member.name,
                `distinct symbol keys sharing the printable name '${symbolFieldDisplayName(mName)}' in one class`,
              );
            }
            symbolMethods.set(key.identity, mName);
          }
        }
        // Generator calls use their spawn wrapper. Public methods are
        // direct calls only when no subclass overrides the method;
        // override chains involving generators fence below.
        // An ABSTRACT method is a signature with no body — type-world,
        // except that it declares the vtable slot: calls through
        // base-typed receivers are ordinary virtual dispatch, and tsc
        // guarantees every instantiable subclass implements it (so a
        // dispatch can never land on the empty declaration). It enters
        // `methods` (marked abstract) for slot declaration and the
        // override-exactness rule; no module function ever exists.
        if (ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) {
          // A GENERIC abstract method has no body to monomorphize —
          // per-call-site instantiation needs a nearest declarer WITH a
          // body, which an abstract declaration never has.
          if (member.typeParameters !== undefined) {
            lowerer.unsupported(
              "SC1090",
              member,
              "abstract generic methods (generic methods monomorphize from the nearest declaration's body, and an abstract declaration has none)",
            );
          }
          const { shapes, ret } = abstractMemberSignature(lowerer, member);
          if (fields.has(mName)) {
            lowerer.unsupported("SC1090", member.name, "methods shadowing inherited fields");
          }
          if (findGenericMethodOn(lowerer, base, mName)) {
            lowerer.unsupported(
              "SC1090",
              member.name,
              `overriding the inherited generic method '${mName}' with a non-generic method (generic methods dispatch statically and would never reach this override)`,
            );
          }
          // Abstract re-declarations keep the overridden ABI exactly,
          // like any override (a concrete implementation below must
          // agree with BOTH, which exactness makes one constraint).
          const overridden = lowerer.findMethodOn(base, mName);
          if (
            overridden &&
            (overridden.sig.params.length !== shapes.length ||
              !overridden.sig.params.every((p, i) => typeEquals(p.type, shapes[i]!.type)) ||
              !typeEquals(overridden.sig.ret, ret))
          ) {
            lowerer.unsupported(
              "SC1090",
              member.name,
              "overriding a method with a different signature (parameter and return types must match the base declaration exactly)",
            );
          }
          methods.set(mName, { params: shapes, ret, abstract: true });
          continue;
        }
        // A body-less method is an OVERLOAD SIGNATURE (abstract methods
        // collected above): type-world, exactly the constructor story.
        if (!member.body) continue;
        // GENERIC methods (own type parameters): collected aside — never
        // in `methods` (no single ABI signature, no vtable slot); bodies
        // lower per call-site instantiation as `%C.m%n`. Mixing generic
        // and non-generic declarations of one name across the hierarchy
        // fences (the two dispatch worlds — static per-instantiation
        // calls vs vtable slots — cannot see each other's overrides).
        if (member.typeParameters !== undefined) {
          if (fields.has(mName)) {
            lowerer.unsupported("SC1090", member.name, "methods shadowing inherited fields");
          }
          if (lowerer.findMethodOn(base, mName)) {
            lowerer.unsupported(
              "SC1090",
              member.name,
              `overriding the inherited method '${mName}' with a generic method (generic methods dispatch statically, so the base's vtable slot could never reach this override)`,
            );
          }
          collectGenericMember(member, false);
          continue;
        }
        // Async methods collect with the same direct-call spawn wrapper
        // for JavaScript and TypeScript classes. Override chains remain
        // fenced below because vtable slots cannot enter that wrapper.
        // IMPLICIT-ANY monomorphization (npm-static JS): a method whose
        // signature carries bindable untyped params collects like a
        // GENERIC method — into genericMethods, no vtable slot, one
        // instance per call-site type tuple (the untyped params ARE the
        // type parameters; see generic-functions.ts). DECLINES
        // (falls through to the normal all-dyn ABI) wherever the two
        // dispatch worlds could meet: an inherited declaration of the
        // name (the override stays on the vtable), a shadowed field, or
        // a generic-class instantiation's member.
        if (
          implicitMonoFile(decl.getSourceFile()) &&
          !functionLocalClass(decl) &&
          ts.isIdentifier(member.name) &&
          !lowerer.virtualJsMethods.has(member) &&
          !lowerer.prototypeMethodAccesses.has(member.name.text) &&
          inst === undefined &&
          decl.typeParameters === undefined &&
          !fields.has(member.name.text) &&
          !lowerer.findMethodOn(base, member.name.text) &&
          !findGenericMethodOn(lowerer, base, member.name.text)
        ) {
          const implicit = implicitAnyParamSymbolsOf(lowerer, member, true);
          if (implicit) {
            genericMethods.set(member.name.text, {
              decl: member,
              baseName: member.name.text,
              qualifiedName: `%${className}.${member.name.text}`,
              typeParams: [],
              instances: new Map(),
              implicitParams: implicit,
            });
            continue;
          }
        }
        const { shapes, funcType: ft } = lowerer.lambdaSignature(member);
        const fieldRet = ft.ret.kind === "promise" ? ft.ret.inner : ft.ret;
        if (returnsWidenedJsField(lowerer, decl, member, fields, fieldRet)) {
          ft.ret = ft.ret.kind === "promise" ? { ...ft.ret, inner: DYN } : DYN;
        }
        if (lowerer.checkedVirtualJsMethods.has(member)) {
          for (const shape of shapes) {
            shape.type = DYN;
            if (shape.bodyType) shape.bodyType = DYN;
          }
          ft.params = shapes.map((shape) => shape.type);
          if (ft.ret.kind !== "void" || lowerer.checkedVirtualJsValueReturns.has(member))
            ft.ret = DYN;
        }
        // JS inference may retain only a symbol sentinel while a method
        // also returns values from an untyped mutable field or local.
        if (
          isJsSourceFile(member.getSourceFile()) &&
          !member.type &&
          !hasExplicitJsDocReturn(member) &&
          ft.ret.kind === "symbol"
        )
          ft.ret = DYN;
        if (
          isJsSourceFile(member.getSourceFile()) &&
          lowerer.prototypeMethodAccesses.has(mName) &&
          !lowerer.findMethodOn(base, mName)?.declarer.def.runtime &&
          shapes.every((p) => p.mode === "required" || p.mode === "omittable")
        ) {
          for (const shape of shapes) {
            shape.type = DYN;
            if (shape.bodyType) shape.bodyType = DYN;
          }
          ft.params = shapes.map((shape) => shape.type);
          if (ft.ret.kind !== "void") ft.ret = DYN;
        }
        // JS subclasses can add parameters to a method. Reserve checked
        // argument slots in the base before constructing its vtable; shorter
        // bodies ignore them and omitted call arguments become undefined.
        const virtualArity = lowerer.virtualJsMethodArity.get(member) ?? shapes.length;
        if (
          virtualArity > shapes.length &&
          !bodyReadsArguments(member) &&
          shapes.every(
            (p) => p.type.kind === "dyn" && (p.mode === "required" || p.mode === "omittable"),
          )
        ) {
          while (shapes.length < virtualArity) shapes.push({ type: DYN, mode: "omittable" });
        }
        if (fields.has(mName)) {
          lowerer.unsupported("SC1090", member.name, "methods shadowing inherited fields");
        }
        if (findGenericMethodOn(lowerer, base, mName)) {
          lowerer.unsupported(
            "SC1090",
            member.name,
            `overriding the inherited generic method '${mName}' with a non-generic method (generic methods dispatch statically and would never reach this override)`,
          );
        }
        // Symbol-slot return refinement, INHERITED slots (own ctor-declared
        // slots refine in the post-scan pass below — the constructor hasn't
        // been scanned yet here, but base slots are already in
        // symbolFields/fields). Doing it before the exactness check keeps
        // a derived override of a refined base method agreeing.
        if (ft.ret.kind === "dyn") {
          const refined = symbolSlotReturnType(lowerer, member, symbolFields, fields);
          if (refined) ft.ret = refined;
        }
        // Overrides keep the EXACT overridden ABI signature. tsc's method
        // bivariance would let a narrowed parameter type through, and a
        // vtable-dispatched call could then hand the override a base
        // instance it reads out-of-bounds fields from — exactness keeps
        // every slot sound (covariant returns can come later). Comparing
        // ABI types only (not modes) is deliberate: call sites complete
        // against the STATIC receiver's shape, so `m(x?: number)` and
        // `m(x: number | undefined)` interchange soundly in overrides.
        const overridden = lowerer.findMethodOn(base, mName);
        if (overridden && isJsSourceFile(member.getSourceFile())) {
          // An unannotated JS override can return a checked value into
          // the inherited native ABI, just as its untyped parameters do.
          // Body lowering inserts the conversion at each return.
          if (
            !member.type &&
            ft.ret.kind === "dyn" &&
            overridden.sig.ret.kind !== "dyn" &&
            !overridden.sig.async &&
            !overridden.sig.gen
          )
            ft.ret = overridden.sig.ret;
          // Fluent overrides return the same native receiver. Keep the
          // inherited return ABI and upcast `this` when lowering returns.
          if (
            overridden.sig.ret.kind === "object" &&
            base &&
            (base.def.name === overridden.sig.ret.className ||
              lowerer.isSubclassOf(base.def.name, overridden.sig.ret.className)) &&
            returnsOnlyThis(member)
          )
            ft.ret = overridden.sig.ret;
          // An unannotated JS parameter can use the base's typed ABI.
          // Defaults stay local to each declaration, so only inherited
          // required/optional slots participate in this refinement.
          for (let i = 0; i < shapes.length; i++) {
            const parameter = member.parameters[i];
            const inherited = overridden.sig.params[i];
            if (
              parameter &&
              inherited &&
              !parameter.type &&
              !parameter.initializer &&
              !parameter.dotDotDotToken &&
              shapes[i]!.type.kind === "dyn" &&
              inherited.type.kind !== "dyn" &&
              (inherited.mode === "required" || inherited.mode === "omittable")
            ) {
              shapes[i] = { ...inherited };
            }
          }
        }
        // JS overrides may ignore trailing arguments. Retain the base's
        // checked-value ABI slots as unused parameters, and let shorter
        // calls fill them with undefined. Typed tails and rest/arguments
        // readers keep the exact-signature fence.
        if (
          overridden &&
          isJsSourceFile(member.getSourceFile()) &&
          shapes.length < overridden.sig.params.length &&
          !bodyReadsArguments(member) &&
          shapes.every(
            (p, i) =>
              (p.mode === "required" || p.mode === "omittable") &&
              typeEquals(p.type, overridden.sig.params[i]!.type),
          ) &&
          overridden.sig.params
            .slice(shapes.length)
            .every(
              (p) => p.type.kind === "dyn" && (p.mode === "required" || p.mode === "omittable"),
            )
        ) {
          shapes.push(
            ...overridden.sig.params
              .slice(shapes.length)
              .map((p): ParamShape => ({ type: p.type, mode: "omittable" })),
          );
        }
        if (
          overridden &&
          member.asteriskToken === undefined &&
          (overridden.sig.params.length !== shapes.length ||
            !overridden.sig.params.every((p, i) => typeEquals(p.type, shapes[i]!.type)) ||
            !typeEquals(overridden.sig.ret, ft.ret))
        ) {
          const fencedJsOverride =
            isJsSourceFile(member.getSourceFile()) &&
            overridden.declarer.decl !== null &&
            isJsSourceFile(overridden.declarer.decl.getSourceFile()) &&
            overridden.sig.gen === undefined;
          if (fencedJsOverride) {
            // A dormant JS method must not poison the whole class. Keep
            // the inherited call/dispatch ABI and refuse at method entry;
            // lowering this body with the base signature would change JS.
            const returnOnly =
              overridden.sig.params.length === shapes.length &&
              overridden.sig.params.every((p, i) => typeEquals(p.type, shapes[i]!.type)) &&
              !member.parameters.some((parameter, index) => {
                if (!parameter.initializer) return false;
                const baseMember = overridden.declarer.decl?.members.find(
                  (candidate) =>
                    ts.isMethodDeclaration(candidate) &&
                    classMemberNameOf(lowerer, candidate.name) === mName,
                );
                const inherited =
                  baseMember && ts.isMethodDeclaration(baseMember)
                    ? baseMember.parameters[index]?.initializer
                    : undefined;
                if (!inherited) return false;
                const ownType = lowerer.mapTypeOf(lowerer.typeOf(parameter.initializer));
                const baseType = lowerer.mapTypeOf(lowerer.typeOf(inherited));
                return ownType !== null && baseType !== null && !typeEquals(ownType, baseType);
              });
            methodEntryFences.set(
              mName,
              unsupportedDiag(
                "SC1090",
                locOf(member.name),
                returnOnly
                  ? `overriding method '${mName}' with a different return type (the native return type must match the base declaration exactly)`
                  : `overriding method '${mName}' with a different signature (the native parameter and return types must match the base declaration exactly)`,
              ),
            );
            shapes.splice(0, shapes.length, ...overridden.sig.params);
            ft.ret = overridden.sig.ret;
          } else {
            lowerer.unsupported(
              "SC1090",
              member.name,
              "overriding a method with a different signature (parameter and return types must match the base declaration exactly)",
            );
          }
        }
        const asyncMember =
          member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
        // Async methods dispatch STATICALLY (the body enters through its
        // fiber spawn wrapper; vtable slots hold raw implementations) —
        // an override chain touching an async method on either end would
        // put a spawn wrapper behind a virtual slot, so it fences.
        if (overridden && (asyncMember || overridden.sig.async === true)) {
          const message = `overriding ${overridden.sig.async === true ? "the async method" : "a method with an async method"} '${mName}' (async methods dispatch statically — the vtable slot machinery has no fiber-spawn story)`;
          if (isJsSourceFile(member.getSourceFile()))
            methodEntryFences.set(mName, unsupportedDiag("SC1090", locOf(member.name), message));
          else lowerer.unsupported("SC1090", member.name, message);
        }
        if (
          overridden &&
          (member.asteriskToken !== undefined || overridden.sig.gen !== undefined)
        ) {
          const message = `overriding the generator method '${mName}' (generator methods dispatch statically — a virtual slot cannot enter their spawn wrapper)`;
          if (isJsSourceFile(member.getSourceFile()))
            methodEntryFences.set(mName, unsupportedDiag("SC1090", locOf(member.name), message));
          else lowerer.unsupported("SC1090", member.name, message);
        }
        // A GENERATOR method carries its channels on the sig:
        // the body lowers as a generator IrFunction (`this` as param 0),
        // and every call — direct by construction — enters through the
        // emitted gen-spawn wrapper, answering the suspended generator.
        if (member.asteriskToken !== undefined) {
          if (ft.ret.kind !== "generator")
            lowerer.badType(member.name, lowerer.typeOf(member.name));
          methods.set(mName, {
            params: shapes,
            ret: ft.ret,
            gen: generatorMeta(lowerer, ft.ret),
            ...(asyncMember ? { async: true as const } : {}),
          });
        } else {
          methods.set(
            mName,
            asyncMember
              ? { params: shapes, ret: ft.ret, async: true as const }
              : { params: shapes, ret: ft.ret },
          );
        }
        // Overrides keep the inherited ABI exactly, so only non-override
        // methods may still refine once the ctor scan runs.
        if (ft.ret.kind === "dyn" && !overridden) {
          dynRetMethods.set(mName, member);
        }
      } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        // Accessors are methods with property syntax: `get x()` collects
        // as the method entry "get:x" (a name no user identifier can
        // spell, so it can never collide with a real method) and `set x`
        // as "set:x" — every downstream mechanism (override exactness,
        // whole-program devirtualization, vtable slots, may-throw) then
        // applies verbatim, with the get and set halves independent.
        const isGet = ts.isGetAccessor(member);
        // #private accessors collect as "get:#x"/"set:#x" — the same
        // reserved spelling, one more unspellable segment.
        const prop = classMemberNameOf(lowerer, member.name);
        if (prop === null) {
          lowerer.unsupported("SC1090", member, "computed accessor names");
        }
        if (ts.isComputedPropertyName(member.name)) {
          const key = classSymbolKeyOf(lowerer, member.name.expression);
          if (key) {
            if (
              [...symbolMethods, ...symbolFields].some(
                ([identity, name]) => name === prop && identity !== key.identity,
              )
            ) {
              lowerer.unsupported(
                "SC1090",
                member.name,
                `distinct symbol keys sharing the printable name '${symbolFieldDisplayName(prop)}' in one class`,
              );
            }
            symbolMethods.set(key.identity, prop);
          }
        }
        // ABSTRACT accessors are the abstract-method story with property
        // syntax: body-less by definition, they enter `methods` (marked
        // abstract) as their "get:x"/"set:x" halves — slot declaration
        // and override exactness verbatim; no module function exists.
        const abstractAccessor =
          ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true;
        if (!member.body && !abstractAccessor)
          lowerer.unsupported("SC1090", member, "bodyless accessors");
        const mName = `${isGet ? "get" : "set"}:${prop}`;
        if (
          fields.has(prop) &&
          isJsSourceFile(decl.getSourceFile()) &&
          base?.fields.has(prop) &&
          !fieldOrder.some((field) => field.name === prop)
        ) {
          // JS may override an inherited data field with a prototype
          // accessor. Retain the base storage prefix for its constructor;
          // property dispatch on this subclass selects the accessor.
          fields.delete(prop);
        }
        if (
          fields.has(prop) &&
          !(
            (prop === "message" || prop === "name") &&
            base &&
            (base.def.name === "%Error" || lowerer.isSubclassOf(base.def.name, "%Error"))
          )
        ) {
          // tsc rejects field/accessor mixing (TS2610/2611); defensive.
          lowerer.unsupported("SC1090", member.name, "accessors sharing a name with a field");
        }
        let sig: { params: ParamShape[]; ret: IrType };
        if (isGet) {
          const ret = lowerer.declaredReturnType(member, member.name);
          if (ret.kind === "void") lowerer.badType(member.name, lowerer.typeOf(member.name));
          sig = { params: [], ret };
        } else {
          // tsc rejects optional/default/rest setter params (TS1051-53).
          sig = { params: lowerer.paramShapes(member.parameters), ret: VOID };
        }
        if (lowerer.checkedVirtualJsAccessors.has(member)) {
          if (isGet) sig.ret = DYN;
          else for (const parameter of sig.params) parameter.type = DYN;
        }
        // One property, ONE type: tsc (5.1+) admits get/set pairs with
        // unrelated annotated types; a property slot here has a single
        // IR type, so the pair must agree exactly.
        const twin = methods.get(`${isGet ? "set" : "get"}:${prop}`);
        const twinType = twin ? (isGet ? twin.params[0]!.type : twin.ret) : null;
        const ownType = isGet ? sig.ret : sig.params[0]!.type;
        if (twinType && !typeEquals(twinType, ownType)) {
          lowerer.unsupported(
            "SC1090",
            member.name,
            `getter/setter pairs with different types (the property '${prop}' must have one type)`,
          );
        }
        // Same exactness rule as methods — an accessor override keeps
        // the overridden accessor's type (getter return / setter param).
        const overridden = lowerer.findMethodOn(base, mName);
        if (
          overridden &&
          (overridden.sig.params.length !== sig.params.length ||
            !overridden.sig.params.every((p, i) => typeEquals(p.type, sig.params[i]!.type)) ||
            !typeEquals(overridden.sig.ret, sig.ret))
        ) {
          lowerer.unsupported(
            "SC1090",
            member.name,
            "overriding an accessor with a different type (the property type must match the base declaration exactly)",
          );
        }
        methods.set(mName, abstractAccessor ? { ...sig, abstract: true } : sig);
        // Abstract accessors stay OUT of accessorNodes: they are erased
        // at runtime (nothing shadows an inherited pair, nothing needs a
        // synthesized throwing setter) — the partial-override analysis
        // below reasons about accessors that EXIST on the instance.
        if (!abstractAccessor) accessorNodes.set(mName, member);
      } else if (ts.isIndexSignatureDeclaration(member)) {
        lowerer.unsupported("SC1090", member, "index signatures");
      } else if (!ts.isSemicolonClassElement(member)) {
        lowerer.unsupported("SC1090", member, `syntax '${ts.syntaxKindName(member.kind)}'`);
      }
    }

    // Parameter properties join the shape FIRST among own fields —
    // Node's transform hoists their definitions above every declared
    // field (probed: `constructor(public x, private w)` after a declared
    // `z` still prints `{ x, w, z }`), so layout/inspect order follows.
    // No definite-assignment analysis applies: the constructor assigns
    // them unconditionally (paramPropInitStmts).
    if (paramProps.length > 0) {
      for (const pp of paramProps) fields.set(pp.name, pp.type);
      fieldOrder.unshift(
        ...paramProps.map((pp): ClassInfo["fieldOrder"][number] => ({
          name: pp.name,
          type: pp.type,
          initializer: undefined,
        })),
      );
    }

    // The deferred definite-assignment check: a field on the unguarded
    // list passes only with an unconditional `this.x = ...` at the
    // constructor's TOP LEVEL — the same standard the JS-class path
    // below applies to constructor-declared fields. Anything less
    // (conditional branches, assignment in a method, no constructor at
    // all) leaves a window where Node reads undefined and these layouts
    // would read zeroed memory, so it fences instead.
    const deferredInitFields = new Set<string>(base?.deferredInitFields ?? []);
    if (unguardedFields.length > 0) {
      const topAssigned = new Set<string>();
      for (const stmt of ctor?.body?.statements ?? []) {
        if (
          ts.isExpressionStatement(stmt) &&
          ts.isBinaryExpression(stmt.expression) &&
          stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(stmt.expression.left) &&
          stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          topAssigned.add(stmt.expression.left.name.text);
        }
      }
      for (const f of unguardedFields) {
        if (topAssigned.has(f.name)) continue;
        // DEFERRED INITIALIZATION (the Output.initialize idiom —
        // `stream!: T` assigned inside a method the constructor calls):
        // the slot becomes the undefined-armed union — allocation writes
        // the interned undefined (Node's pre-assignment value), writes
        // wrap, and reads CHECKED-extract the declared type, trapping a
        // genuinely-unassigned read with the catchable TypeError.
        // Only single-arm declared types take the deferral (the checked
        // extraction targets one arm); union-typed `!` fields keep the
        // fence.
        const declared = fields.get(f.name);
        const armable =
          declared !== undefined &&
          !isUnitType(declared) &&
          declared.kind !== "union" &&
          declared.kind !== "jsval" &&
          declared.kind !== "dyn" &&
          declared.kind !== "map" &&
          declared.kind !== "date" &&
          declared.kind !== "generator" &&
          declared.kind !== "void" &&
          declared.kind !== "caught";
        const armed = armable ? lowerer.withUndefinedArm(declared) : null;
        if (armed !== null && armed.kind === "union") {
          fields.set(f.name, armed);
          const fo = fieldOrder.find((x) => x.name === f.name);
          if (fo) fo.type = armed;
          deferredInitFields.add(f.name);
          continue;
        }
        lowerer.unsupported("SC1090", f.node, f.why);
      }
    }

    // Partial overrides of an inherited accessor pair. JS gives the
    // derived class ONE own accessor property that SHADOWS the whole
    // inherited pair — the missing half does NOT resolve to the base's
    // (verified against Node):
    //   - getter-only override where the chain has a setter: a write
    //     through a base-typed reference (tsc-clean — the base has a
    //     setter) throws TypeError at runtime. Matched exactly: a
    //     synthesized throwing setter fills the derived class's slot.
    //   - setter-only override where the chain has a getter: a read
    //     through a base-typed reference yields undefined — a value
    //     these property types cannot represent. Rejected.
    const throwingSetters: string[] = [];
    for (const [mName, node] of accessorNodes) {
      const prop = mName.slice(4);
      if (mName.startsWith("get:") && !accessorNodes.has(`set:${prop}`)) {
        // An ABSTRACT inherited setter is erased at runtime — there is
        // no accessor pair to shadow, so no throwing setter to
        // synthesize (tsc makes an instantiable class implement it, and
        // that implementation shadows nothing either).
        const baseSet = lowerer.findMethodOn(base, `set:${prop}`);
        if (baseSet && baseSet.sig.abstract !== true) {
          if (!typeEquals(baseSet.sig.params[0]!.type, methods.get(mName)!.ret)) {
            // Unreachable when the base pair agrees (induction through
            // the exactness rule); a base setter-only + new getter of a
            // different type would break the slot signature.
            lowerer.unsupported(
              "SC1090",
              node.name,
              "accessors whose getter and inherited setter types differ",
            );
          }
          methods.set(`set:${prop}`, { params: [baseSet.sig.params[0]!], ret: VOID });
          throwingSetters.push(prop);
        }
      }
      if (mName.startsWith("set:") && !accessorNodes.has(`get:${prop}`)) {
        // The abstract-inherited-getter case is the same erasure story.
        const baseGet = lowerer.findMethodOn(base, `get:${prop}`);
        if (baseGet && baseGet.sig.abstract !== true) {
          lowerer.unsupported(
            "SC1090",
            node.name,
            `overriding only the setter of an inherited accessor pair (JS shadows the inherited getter — reads of '${prop}' would yield undefined; declare the getter too)`,
          );
        }
      }
    }

    // JavaScript classes declare fields by ASSIGNMENT: `this.x = v` in
    // the constructor IS the declaration (checkJs infers the property —
    // its type is the checker's, exactly like an annotated field). The
    // supported form is a definite assignment at the constructor's TOP
    // LEVEL, in source order — the layout is then as fixed as a TS field
    // list and the assignment itself doubles as the initializer (fields
    // are zero until the ctor body runs, same as TS's ctor-assigned
    // declared fields). Properties the checker infers from anywhere else
    // (conditional branches, methods) would be readable before any
    // assignment ran — the zeroed-memory trap a TS declaration order
    // forbids via strictPropertyInitialization — so they keep a named
    // fence instead of a silent undefined.
    if (isJsSourceFile(decl.getSourceFile())) {
      const hasAccessor = (name: string): boolean =>
        methods.has(`get:${name}`) ||
        methods.has(`set:${name}`) ||
        lowerer.findMethodOn(base, `get:${name}`) !== null ||
        lowerer.findMethodOn(base, `set:${name}`) !== null;
      // Named classes (declarations and self-binding expressions) resolve
      // by name; the nameless default-export declaration by its module's
      // default-export symbol.
      const classSym = decl.name
        ? lowerer.checker.getSymbolAtLocation(decl.name)
        : ts.isClassDeclaration(decl)
          ? declSymbolOf(lowerer, decl)
          : undefined;
      const instType = classSym ? lowerer.checker.getDeclaredTypeOfSymbol(classSym) : undefined;
      // LATE-BOUND properties (the checker's `__@name@id` spelling —
      // `this[kLimit] = v` where kLimit is a unique symbol const) by
      // their KEY symbol: the scan below needs the checker's property
      // type (tsc types computed declarations with unique-symbol keys
      // statically, exactly like named ones) but getSymbolAtLocation
      // answers null on element-access declaration sites, so the link
      // goes through the key.
      const lateBoundByKey = new Map<ts.Symbol, ts.Symbol>();
      for (const p of instType ? lowerer.checker.getPropertiesOfType(instType) : []) {
        if (!p.name.startsWith("__@")) continue;
        const keySym = lateBoundKeySymOf(lowerer, p);
        if (keySym) lateBoundByKey.set(keySym, p);
      }
      if (ctor?.body) {
        for (const stmt of ctor.body.statements) {
          const lhs =
            ts.isExpressionStatement(stmt) &&
            ts.isBinaryExpression(stmt.expression) &&
            stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ? stmt.expression.left
              : null;
          if (
            lhs &&
            ts.isPropertyAccessExpression(lhs) &&
            lhs.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const assign = lhs;
            const name = assign.name.text;
            if (errorRooted && name === "cause") continue;
            // Later assignments to an already-declared field (own or
            // inherited) are writes, not declarations.
            if (fields.has(name) || hasAccessor(name)) continue;
            if (methods.has(name) || lowerer.findMethodOn(base, name)) {
              // An own JS callable shadows its prototype declaration.
              // Keep the method in the prototype and store the assigned
              // value in the instance property bag.
              lowerer.prototypeMethodAccesses.set(name, assign);
              continue;
            }
            const sym = lowerer.checker.getSymbolAtLocation(assign);
            const t = sym ? lowerer.checker.getTypeOfSymbol(sym) : undefined;
            const rhs = ((stmt as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
            // Implicit-any fields (assigned from UNTYPED ctor params —
            // countdown.js's `this.limit = limit`) take the JS checked-
            // dynamic fallback like every JS binding: the slot holds a dyn
            // box, reads validate per use, writes convert in (dynFrom).
            // TS-annotated `unknown` fields keep their fence (KEEP NARROW
            // applies where an annotation could say better).
            let type = t ? (lowerer.mapTypeOf(t) ?? dynFallbackType(lowerer, assign, t)) : null;
            if (
              t &&
              (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0 &&
              isJsSourceFile(decl.getSourceFile())
            )
              type = DYN;
            if (type) type = jsOpenObjectType(assign, type, lowerer.shapes, lowerer.unions);
            if (type?.kind === "dyn") {
              type = inferredEmptyCollectionFieldType(lowerer, decl, name, rhs) ?? type;
            }
            if (!type || type.kind === "void") lowerer.badType(assign, t ?? lowerer.typeOf(assign));
            type = jsFieldInitializerType(lowerer, type, rhs);
            // A JSDoc claim the BODY contradicts (`@type {Command}`
            // assigned `undefined` — the lazy-init idiom): the
            // representation follows the body — the field widens to the
            // undefined-armed union, so the declaring assignment and
            // every pre-init read carry Node's actual undefined.
            // Trust-but-verify: the claim never silently narrows the
            // runtime value.
            {
              const rhsT = lowerer.typeOf(rhs);
              const assignsUndef = (rhsT.flags & ts.TypeFlags.Undefined) !== 0;
              const admitsUndef =
                type.kind === "dyn" ||
                isUnitType(type) ||
                (type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0);
              if (assignsUndef && !admitsUndef) {
                const widened = lowerer.withUndefinedArmOf(type);
                if (widened !== null) type = widened;
              }
            }
            type = inheritedJsFieldType(lowerer, decl, name, type);
            // super() can invoke a subclass setter or method before its
            // constructor assignments run. These slots start undefined.
            if (base && lowerer.dynConvertible(type)) type = DYN;
            fields.set(name, type);
            fieldOrder.push({ name, type, initializer: undefined });
            continue;
          }
          // `this[kLimit] = v` at the constructor's top level with a
          // STATICALLY-RESOLVABLE symbol key (classSymbolKeyOf's
          // contract — the countdown.js idiom): the key is a compile-time
          // identity, so the member is an ordinary hidden field of the
          // static layout under Node's inspect spelling; no runtime
          // symbol table exists. Its type is the checker's late-bound
          // property type, through the same JS checked-dynamic fallback
          // as named fields. Keys that DON'T resolve fall through to the
          // late-bound fence below.
          if (
            lhs &&
            ts.isElementAccessExpression(lhs) &&
            lhs.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const key = classSymbolKeyOf(lowerer, lhs.argumentExpression);
            const stringKey = lowerer.foldedStringKeyOf(lhs.argumentExpression);
            const fieldName = key?.fieldName ?? stringKey;
            if (fieldName === null) {
              if (lowerer.mapTypeOf(lowerer.typeOf(lhs.argumentExpression))?.kind === "symbol") {
                lowerer.unsupported(
                  "SC1090",
                  lhs,
                  "symbol-keyed class fields require a stable module-level key",
                );
              }
              continue;
            }
            if (!key && (fields.has(fieldName) || hasAccessor(fieldName))) continue;
            if (!key && (methods.has(fieldName) || lowerer.findMethodOn(base, fieldName))) {
              lowerer.prototypeMethodAccesses.set(fieldName, lhs);
              continue;
            }
            // A key already declared (own or inherited) makes later
            // assignments writes, not declarations.
            if (key && symbolFields.has(key.identity)) continue;
            if (fields.has(fieldName)) {
              // Two DISTINCT Symbol(...) consts with one description in
              // one layout would need one printable name for two slots.
              lowerer.unsupported(
                "SC1090",
                lhs,
                `distinct symbol keys sharing the printable name '${symbolFieldDisplayName(fieldName)}' in one class`,
              );
            }
            const propSym = key
              ? lateBoundByKey.get(key.sym)
              : instType
                ? lowerer.checker.getPropertyOfType(instType, fieldName)
                : undefined;
            // tsgo does not synthesize the late-bound `__@name@id`
            // property for a JS `this[k] = v` declaration (the finding-5
            // family: no expando/late-bound synthesis in its stricter
            // CJS-JS modeling), so when the key found no property the
            // field's type comes from the SAME inference source 5.9.3's
            // property type did — the declaring assignment's RHS, widened.
            const rhs =
              ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)
                ? stmt.expression.right
                : undefined;
            const t = propSym
              ? lowerer.checker.getTypeOfSymbol(propSym)
              : rhs
                ? lowerer.checker.getBaseTypeOfLiteralType(lowerer.checker.getTypeAtLocation(rhs))
                : undefined;
            let type = t ? (lowerer.mapTypeOf(t) ?? dynFallbackType(lowerer, lhs, t)) : null;
            if (type) type = jsOpenObjectType(lhs, type, lowerer.shapes, lowerer.unions);
            if (!type || type.kind === "void") lowerer.badType(lhs, t ?? lowerer.typeOf(lhs));
            type = inheritedJsFieldType(lowerer, decl, fieldName, type);
            if (base && lowerer.dynConvertible(type)) type = DYN;
            fields.set(fieldName, type);
            if (key) symbolFields.set(key.identity, fieldName);
            fieldOrder.push({ name: fieldName, type, initializer: undefined });
          }
        }
      }
      // Every OTHER inferred instance property — assigned only in
      // methods, only in conditional constructor positions, or via
      // computed keys — is undefined until its first write, which these
      // static layouts cannot represent. Named fence, at the first
      // assignment site.
      for (const p of instType ? lowerer.checker.getPropertiesOfType(instType) : []) {
        if (errorRooted && p.name === "cause") continue;
        if (fields.has(p.name) || methods.has(p.name)) continue;
        if (hasAccessor(p.name)) continue;
        if (base && (base.fields.has(p.name) || lowerer.findMethodOn(base, p.name))) continue;
        const site = lowerer.checker
          .declarationsOf(p)
          .find(
            (d) =>
              ts.isPropertyAccessExpression(d) ||
              ts.isBinaryExpression(d) ||
              ts.isElementAccessExpression(d),
          );
        if (!site) continue;
        // Late-bound properties: the ones the scan above collected are
        // real fields under their printable names — skip. The rest keep
        // a fence that names the supported form: keys that are runtime
        // identities (symbol parameters, mutable bindings, computed
        // descriptions) or assignments outside the constructor's top
        // level.
        if (p.name.startsWith("__@")) {
          const keySym = lateBoundKeySymOf(lowerer, p);
          const key = keySym ? classSymbolKeyOfSymbol(lowerer, keySym) : null;
          if (key && symbolFields.has(key.identity)) continue;
          lowerer.unsupported(
            "SC1090",
            site,
            "symbol-keyed class fields outside the supported form (a stable module-level literal Symbol()/Symbol.for() key, assigned unconditionally at the top of the constructor)",
          );
        }
        // JS classes: a property first assigned in a method or a
        // conditional constructor position holds `undefined` until the
        // write runs — exactly representable as the undefined-armed
        // union of the inferred property type, so the field COLLECTS
        // (pre-write reads answer undefined, like Node) instead of
        // poisoning the class (commander's `this.required` switch
        // assignment, `this.runningCommand` method assignment).
        // Unmappable inferences and arm-less kinds keep the fence.
        // TypeScript classes keep the loud fence too: an annotated
        // program can spell `T | undefined` itself.
        if (isJsSourceFile(decl.getSourceFile())) {
          const original = undefArmedFieldType(lowerer, p);
          const armed =
            original === null ? null : inheritedJsFieldType(lowerer, decl, p.name, original);
          if (armed !== null) {
            // Unknown JS properties use the instance bag: they do not
            // exist until assigned, and a subclass may declare the same
            // name as an ordinary layout field.
            if (armed.kind === "dyn") continue;
            fields.set(p.name, armed);
            fieldOrder.push({ name: p.name, type: armed, initializer: undefined });
            continue;
          }
        }
        lowerer.unsupported(
          "SC1090",
          site,
          `fields assigned outside the constructor's top level ('this.${p.name}' would be undefined until the first assignment runs — assign it unconditionally at the top of the constructor)`,
        );
      }
    }

    // Second refinement chance, OWN symbol slots: the member loop ran
    // before the constructor scan declared this class's own symbol-keyed
    // fields, so methods returning those slots (1731's `extra()` —
    // `return this[kExtra]`) retry here with the layout complete.
    for (const [mName, node] of dynRetMethods) {
      const sig = methods.get(mName);
      if (!sig || sig.ret.kind !== "dyn") continue;
      const refined = symbolSlotReturnType(lowerer, node, symbolFields, fields);
      if (refined) sig.ret = refined;
    }

    // The mixin FORWARDING constructor — `constructor(...args: any[]) {
    // super(...args); … }`: under monomorphization the base's signature
    // is known, so the instantiation's ABI IS the base's — synthetic
    // params forward to super unchanged (defaults apply in the base's
    // own prologue, exactly JS's raw-argument forwarding) and the rest
    // parameter never materializes. A rest constructor in a mixin that
    // is NOT the pure forwarding shape has no static story — named
    // fence, never a mis-typed array.
    const mixinForwarding =
      mixin !== undefined && ctor !== null && mixinForwardingCtor(lowerer, ctor);
    if (mixin && ctor && !mixinForwarding && ctor.parameters.some((p) => p.dotDotDotToken)) {
      lowerer.unsupported(
        "SC1090",
        ctor.parameters.find((p) => p.dotDotDotToken)!,
        "mixin constructors whose rest parameter does anything but forward (`super(...args)` as the first statement is the compiled shape)",
      );
    }
    // Constructor omitted on a derived class: it inherits the base's
    // (tsc types `new Derived(...)` against the inherited signature; the
    // synthesized constructor forwards the same params to super).
    const ctorParams: ParamShape[] =
      ctor && !mixinForwarding
        ? lowerer.paramShapes(ctor.parameters)
        : (base?.ctorParams ?? (callableBase ? [{ type: DYN, mode: "dynRest" }] : []));
    if (
      ctor &&
      !mixinForwarding &&
      isJsSourceFile(ctor.getSourceFile()) &&
      !ctorParams.some(
        (shape) => shape.mode === "rest" || shape.mode === "dynRest" || shape.mode === "islandRest",
      ) &&
      bodyReadsArguments(ctor)
    ) {
      ctorParams.push({ type: DYN, mode: "arguments" });
    }

    const info: ClassInfo = {
      ...(runtimeStatics.length || checkedStatics ? { runtimeStatics } : {}),
      ...(runtimePrototypeMembers.length ? { runtimePrototypeMembers } : {}),
      def: {
        name: className,
        // The JS-observable .name (the class object's name string and
        // what `C.name` folds to): the declared name, or NamedEvaluation's
        // answer for class expressions ("" when truly anonymous). An
        // INSTANTIATION prints its family's name — JS has one `Box`.
        jsName: jsNameOverride ?? decl.name?.text ?? "",
        ...(base ? { base: base.def.name } : {}),
        jsLength:
          ctor?.parameters.findIndex(
            (parameter) => parameter.initializer || parameter.dotDotDotToken,
          ) === -1
            ? ctor.parameters.length
            : Math.max(
                0,
                ctor?.parameters.findIndex(
                  (parameter) => parameter.initializer || parameter.dotDotDotToken,
                ) ?? 0,
              ),
        // Layout order: the base chain's fields as an IDENTICAL prefix,
        // then this class's own — what makes an upcast a reinterpret.
        // Redeclared INHERITED fields contribute no slot (their
        // initializers assign the prefix slot).
        fields: [
          ...(base?.def.fields ?? []),
          ...fieldOrder
            .filter((f) => f.redeclared !== true)
            .map((f) => ({ name: f.name, type: f.type })),
        ],
        ...(methods.size > 0 ? { methods: [...methods.keys()] } : {}),
        ...(abstractClass ? { abstract: true as const } : {}),
        ...((): { abstractMethods?: string[] } => {
          const am = [...methods.entries()].filter(([, s]) => s.abstract === true).map(([n]) => n);
          return am.length > 0 ? { abstractMethods: am } : {};
        })(),
        ...(inst ? { genericOf: inst.family.def.name } : {}),
        loc: locOf(decl),
      },
      fields,
      fieldOrder,
      methods,
      ...(methodEntryFences.size > 0 ? { methodEntryFences } : {}),
      decl,
      ...(emitOverride !== undefined ? { emitOverride } : {}),
      ctor,
      ctorParams,
      ...(paramProps.length > 0 ? { paramProps } : {}),
      base,
      ...(genericBase ? { genericBase } : {}),
      ...(callableBase ? { callableBase } : {}),
      ...(factoryBaseExpression ? { factoryBaseExpression } : {}),
      subclasses: [],
      throwingSetters,
      staticFields,
      ...(staticMethods.size > 0 ? { staticMethods } : {}),
      ...(staticBlocks.length > 0 ? { staticBlocks } : {}),
      ...(symbolFields.size > 0 ? { symbolFields } : {}),
      ...(symbolMethods.size > 0 ? { symbolMethods } : {}),
      ...(classDecoratorNodes.length > 0
        ? { classDecorators: { nodes: classDecoratorNodes } }
        : {}),
      ...(deferredInitFields.size > 0 ? { deferredInitFields } : {}),
    };
    // GENERIC members get their declaring-class backlink now that the
    // info exists (instance lowering reads it for `this` typing and the
    // generic-class binding merge).
    if (genericMethods.size > 0) {
      for (const gm of genericMethods.values()) gm.member = { cls: info, kind: "method" };
      info.genericMethods = genericMethods;
    }
    if (genericStatics.size > 0) {
      for (const gs of genericStatics.values()) gs.member = { cls: info, kind: "static" };
      info.genericStatics = genericStatics;
    }
    if (inst) {
      info.genericInstance = {
        path: inst.path,
        family: inst.family,
        bindings: inst.bindings,
        typeArgsText: inst.typeArgsText,
        ordinal: inst.ordinal,
      };
    }
    if (mixin) {
      info.mixinInstance = {
        call: mixin.call,
        bindings: mixin.bindings,
        context: mixin.context,
        ordinal: mixin.ordinal,
        ...(mixinForwarding ? { forwardingCtor: true } : {}),
      };
    }
    if (familyMode) {
      const typeParams: ts.Symbol[] = [];
      for (const tp of decl.typeParameters!) {
        const sym = lowerer.checker.getSymbolAtLocation(tp.name);
        if (!sym) lowerer.unsupported("SC1090", tp, "this type parameter form");
        typeParams.push(sym);
      }
      info.generic = {
        decl: decl as ts.ClassDeclaration,
        baseName: decl.name?.text ?? "%anon",
        typeParams,
        family: info,
        instances: new Map(),
      };
      lowerer.genericClassByDecl.set(decl, info.generic);
    }
    if (base) base.subclasses.push(info);
    lowerer.classes.set(className, info);
    if (computedBase && !functionLocalClass(decl)) {
      info.def.baseValueGlobal = `%g.${className}.computedBase`;
      lowerer.globalsList.push({
        id: info.def.baseValueGlobal,
        name: `${className} base`,
        type: computedBase.value.type,
        mutable: false,
      });
    }
    if (factoryBaseExpression && !functionLocalClass(decl)) {
      info.def.baseValueGlobal = `%g.${className}.computedBase`;
      lowerer.globalsList.push({
        id: info.def.baseValueGlobal,
        name: `${className} base`,
        type: { kind: "classval", className: base!.def.name },
        mutable: false,
      });
    }
    if (callableBase && !functionLocalClass(decl)) {
      lowerer.globalsList.push(
        { id: callableBase.constructorId, name: `${className} base`, type: DYN, mutable: false },
        {
          id: callableBase.prototypeId,
          name: `${className} base prototype`,
          type: DYN,
          mutable: false,
        },
      );
    }
    // A NAMED class binds its name (declarations in their scope, class
    // expressions inside their own bodies — tsc resolves both to this
    // symbol); a nameless default-export declaration binds its module's
    // default-export symbol; anonymous expressions have nothing to bind.
    // Instantiations bind nothing — the FAMILY owns the symbol. A mixin
    // instantiation binds nothing either: the inner class's name would
    // alias EVERY instantiation (self-references by name inside mixin
    // classes fence at their use sites).
    const classSymbol =
      inst || mixin
        ? undefined
        : decl.name
          ? lowerer.checker.getSymbolAtLocation(decl.name)
          : ts.isClassDeclaration(decl)
            ? declSymbolOf(lowerer, decl)
            : undefined;
    if (classSymbol) lowerer.classBySymbol.set(classSymbol, info);
    // Static-field storage registers with the module's globals only
    // once the whole shape collected (a poisoned class never leaves a
    // half-registered global behind).
    for (const f of staticFields) {
      lowerer.globalsList.push({
        id: f.globalId,
        name: `${info.def.jsName ?? className}.${f.name}`,
        type: f.type,
        mutable: !f.readonly,
      });
    }
  }
}

/** mapType's generic-class hook: the INSTANTIATION a concrete type
 * reference (`Box<number>`) names — registered on first demand. The
 * instance's NAME reserves its key before the shape collects, so
 * self-referential layouts (`next: Box<T> | null`) re-enter here and
 * take the name without recursing; a poisoned collection (a field type
 * with no lowering under these bindings — the diagnostic carries the
 * instantiation context) leaves the entry poisoned and the type
 * unmapped, the fenced-JS-class story. Null answers (unmappable type
 * arguments, the instance cap, an uncollected family) make the whole
 * reference unmappable — per-site diagnostics own the fence. */
export function genericClassInstanceType(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  ref: ts.Type,
  mapArgument?: (type: ts.Type) => IrType | null,
): IrType | null {
  let gci = lowerer.genericClassByDecl.get(decl);
  if (!gci && ts.isClassDeclaration(decl)) {
    // A method signature can reference a generic class declared later in
    // the same module. Resolve its family now rather than freezing the
    // signature at the erased family layout for the rest of the build.
    lowerer.collectClassShape(decl);
    gci = lowerer.genericClassByDecl.get(decl);
  }
  if (!gci) {
    // The family never collected (a deferred/poisoned declaration): the
    // pre-generics answer — the class's own name, unregistered, so dead
    // storage prunes (typeNamesUnregisteredClass) and live references
    // flush the declaration's deferred diagnostics (moduleArtifacts /
    // the validator backstop). Exactly the fenced-class story.
    return { kind: "object", className: lowerer.classNamer(decl) };
  }
  // A degenerate reference collapses to the FAMILY's object type instead
  // of going unmapped: `Box<any>` under a static build, wilder arguments
  // no instantiation can carry (`X<<T>() => T>`), and the instance cap.
  // The family is nominal Box-ness with only the INHERITED layout: no
  // value can be CONSTRUCTED at such a type (construction resolves
  // instantiations and fences), real instantiations may UPCAST into its
  // slots (the ancestor rule — `let b: Box<any> = new Box(1)`), interval
  // instanceof answers for the whole family, inherited concrete fields
  // read through the shared prefix, and every per-instantiation member
  // keeps a named per-site fence.
  const familyT: IrType = { kind: "object", className: gci.family.def.name };
  // The checker appends `this` (and outer type parameters) to
  // getTypeArguments — only the declaration's own count participates.
  const args = lowerer.checker
    .getTypeArguments(ref as ts.TypeReference)
    .slice(0, gci.typeParams.length);
  const mapped: IrType[] = [];
  if (args.length === gci.typeParams.length) {
    for (const a of args) {
      const m = lowerer.mapTypeOf(a, mapArgument);
      if (!m || m.kind === "void") {
        // An UNBOUND type parameter argument (`Box<T>` outside any
        // instantiation) stays honestly unmapped — nothing concrete is
        // being named; everything else degrades to the family.
        return a.flags & ts.TypeFlags.TypeParameter ? null : familyT;
      }
      mapped.push(m);
    }
  } else {
    // No argument list — the `this` TYPE inside the generic class's own
    // body (`this.v = v` types the receiver as `this`, not a reference).
    // Inside an instantiation the CURRENT bindings are the arguments;
    // anywhere else the reference is honestly unmappable.
    for (const tp of gci.typeParams) {
      const b = lowerer.typeParamBindings?.get(tp);
      if (!b) return null;
      mapped.push(b);
    }
  }
  const key = mapped.map(typeKey).join(",");
  const existing = gci.instances.get(key);
  if (existing) {
    if (existing.info) lowerer.noteGenericClassInstanceDemand(existing.info);
    return existing.poisoned ? null : { kind: "object", className: existing.name };
  }
  // Recursive class fields and queued member bodies share the function
  // demand budget. Independent uses do not limit the family size.
  const path = extendInstantiationPath(lowerer.genericInstantiationPath, decl);
  if (!path) {
    lowerer.unsupported(
      "SC1090",
      decl,
      `unbounded generic class instantiation ('${gci.baseName}' exceeded ${MAX_INSTANTIATION_RECURSION} recursive specializations on one demand path)`,
    );
  }
  const ordinal = gci.instances.size;
  const name = `${gci.family.def.name}%${ordinal}`;
  const entry: { name: string; info: ClassInfo | null; poisoned?: boolean } = { name, info: null };
  gci.instances.set(key, entry);
  const bindings = new Map<ts.Symbol, IrType>();
  gci.typeParams.forEach((tp, i) => bindings.set(tp, mapped[i]!));
  const rendered = mapped.map((m) => lowerer.fmt(m)).join(", ");
  const typeArgsText = `<${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered}>`;
  const prevBindings = lowerer.typeParamBindings;
  const prevContext = lowerer.instantiationContext;
  const previousPath = lowerer.genericInstantiationPath;
  lowerer.genericInstantiationPath = path;
  lowerer.typeParamBindings = bindings;
  lowerer.instantiationContext = `instantiating class '${gci.baseName}' with ${typeArgsText}`;
  try {
    lowerer.collectClassShapeInner(decl, undefined, {
      path,
      family: gci.family,
      name,
      bindings,
      typeArgsText,
      ordinal,
    });
  } catch (e) {
    // Collection fenced under THESE bindings: the diagnostic (with the
    // instantiation context) is recorded; the type stays unmapped.
    if (!(e instanceof PoisonError)) throw e;
    entry.poisoned = true;
    return null;
  } finally {
    lowerer.typeParamBindings = prevBindings;
    lowerer.instantiationContext = prevContext;
    lowerer.genericInstantiationPath = previousPath;
  }
  const info = lowerer.classes.get(name);
  if (!info) {
    entry.poisoned = true;
    return null;
  }
  entry.info = info;
  lowerer.genericClassInstances.push(info);
  lowerer.noteGenericClassInstanceDemand(info);
  lowerer.onLateClassCollected?.(info);
  return { kind: "object", className: name };
}

/** Runs a member-lowering thunk under an INSTANTIATION's type-parameter
 * bindings (the generic-fn typeParamResolver mechanism) — the checker
 * keeps reporting the unsubstituted `T`s inside the shared body AST.
 * Coverage counts a generic class's statements once: only the FIRST
 * instantiation contributes (the lowerGenericInstance rule). A no-op
 * for ordinary classes. */
function withInstanceBindings<T>(lowerer: Lowerer, info: ClassInfo, fn: () => T): T {
  const gi = info.genericInstance;
  if (!gi) {
    // MIXIN instantiations ride the same mechanism: T (the base
    // parameter's type parameter) resolves to the argument's classval,
    // fences carry the instantiation context, and only the first
    // instantiation of a mixin's class counts toward coverage.
    const mi = info.mixinInstance;
    if (!mi) return fn();
    const prevBindings = lowerer.typeParamBindings;
    const prevContext = lowerer.instantiationContext;
    const prevSuppress = lowerer.suppressStats;
    const prevMixinCtx = lowerer.mixinTypeContext;
    lowerer.typeParamBindings = mi.bindings;
    lowerer.instantiationContext = mi.context;
    lowerer.suppressStats = prevSuppress || mi.ordinal > 0;
    lowerer.mixinTypeContext = { classNode: info.decl!, className: info.def.name };
    try {
      return fn();
    } finally {
      lowerer.typeParamBindings = prevBindings;
      lowerer.instantiationContext = prevContext;
      lowerer.suppressStats = prevSuppress;
      lowerer.mixinTypeContext = prevMixinCtx;
    }
  }
  const prevBindings = lowerer.typeParamBindings;
  const prevContext = lowerer.instantiationContext;
  const prevSuppress = lowerer.suppressStats;
  const previousPath = lowerer.genericInstantiationPath;
  lowerer.genericInstantiationPath = gi.path;
  lowerer.typeParamBindings = gi.bindings;
  lowerer.instantiationContext = `instantiating class '${gi.family.generic?.baseName ?? info.def.jsName ?? ""}' with ${gi.typeArgsText}`;
  lowerer.suppressStats = prevSuppress || gi.ordinal > 0;
  try {
    return fn();
  } finally {
    lowerer.typeParamBindings = prevBindings;
    lowerer.instantiationContext = prevContext;
    lowerer.suppressStats = prevSuppress;
    lowerer.genericInstantiationPath = previousPath;
  }
}

/** The `%init` statements for one class's static readonly fields AND
 * static blocks, interleaved in member order — emitted at the class
 * statement's source position (see lowerFileInit's merge), exactly when
 * JS evaluates static initializers and blocks. Field failures poison per
 * field, like fieldInitStmts; a block lowers as the block statement it
 * is, so its statements poison individually inside lowerStmts. */
export function lowerStaticFieldInits(lowerer: Lowerer, info: ClassInfo): IrStmt[] {
  if (info.localClass) return [];
  // Mixin instantiations lower their initializers under the
  // instantiation's bindings/context (a no-op for everything else —
  // generic FAMILIES own their statics and carry no genericInstance).
  const diagsBefore = lowerer.diags.length;
  try {
    return withInstanceBindings(lowerer, info, () => lowerStaticFieldInitsInner(lowerer, info));
  } catch (error) {
    // Heritage and decorators run before the per-field recovery below.
    // Keep their refusal attached to the class declaration instead of
    // letting a poisoned initializer escape the module lowering pass.
    if (!(error instanceof PoisonError)) throw error;
    if (info.decl && isJsSourceFile(info.decl.getSourceFile()) && lowerer.diagSink === null) {
      const fence = lowerer.deferToRuntimeFence(diagsBefore, info.decl, { kind: "statement" });
      if (fence) return [fence];
    }
    return [];
  }
}

function lowerStaticFieldInitsInner(lowerer: Lowerer, info: ClassInfo): IrStmt[] {
  // Decoration first: TC39 evaluates decorator expressions, creates the
  // class, applies the decorators, and only THEN runs static field
  // initializers and static blocks (verified against Node — the
  // decorated result is what `this`/the class name mean inside them).
  const out: IrStmt[] = [...lowerClassDecoration(lowerer, info)];
  const computedBase = info.decl
    ? lowerer.computedClassBases.get(lowerer.classNamer(info.decl))
    : undefined;
  if (info.factoryBaseExpression && info.def.baseValueGlobal) {
    const loc = locOf(info.factoryBaseExpression);
    const type: IrType = { kind: "classval", className: info.base!.def.name };
    out.push({
      kind: "assign",
      localId: info.def.baseValueGlobal,
      value: lowerer.lowerExprExpecting(info.factoryBaseExpression, type),
      loc,
    });
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.classInherit",
        args: [
          lowerer.coerceToExpected(classValueRef(lowerer, info, info.decl!), DYN),
          lowerer.coerceToExpected(
            { kind: "varRef", localId: info.def.baseValueGlobal, type, loc },
            DYN,
          ),
        ],
        type: DYN,
        loc,
      },
      loc,
    });
  }
  if (computedBase && info.def.baseValueGlobal) {
    const loc = computedBase.value.loc;
    out.push({ kind: "assign", localId: info.def.baseValueGlobal, value: computedBase.value, loc });
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.classInherit",
        args: [
          lowerer.coerceToExpected(classValueRef(lowerer, info, info.decl!), DYN),
          lowerer.coerceToExpected(
            {
              kind: "varRef",
              localId: info.def.baseValueGlobal,
              type: computedBase.value.type,
              loc,
            },
            DYN,
          ),
        ],
        type: DYN,
        loc,
      },
      loc,
    });
  }
  if (info.callableBase) {
    const { expression, constructorId, prototypeId } = info.callableBase;
    const loc = locOf(expression);
    out.push(
      {
        kind: "assign",
        localId: constructorId,
        value:
          info.decl && lowerer.computedCallableBases.has(info.decl)
            ? lowerer.coerceToExpected(lowerer.computedCallableBases.get(info.decl)!, DYN)
            : lowerer.lowerExprExpecting(expression, DYN),
        loc,
      },
      {
        kind: "assign",
        localId: prototypeId,
        value: {
          kind: "libCall",
          fn: "dyn.classBasePrototype",
          args: [{ kind: "varRef", localId: constructorId, type: DYN, loc }],
          type: DYN,
          loc,
        },
        loc,
      },
    );
    const prototype = classPrototypeData(lowerer, info, loc);
    if (prototype) out.push({ kind: "exprStmt", expr: prototype, loc });
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.classInherit",
        args: [
          lowerer.coerceToExpected(classValueRef(lowerer, info, info.decl!), DYN),
          { kind: "varRef", localId: constructorId, type: DYN, loc },
        ],
        type: DYN,
        loc,
      },
      loc,
    });
  }
  if (info.runtimeStatics && !info.localClass && info.decl) {
    out.push({
      kind: "exprStmt",
      expr: initializeRuntimeStatics(lowerer, info, classValueRef(lowerer, info, info.decl)),
      loc: locOf(info.decl),
    });
  }
  type Item =
    | { pos: number; kind: "field"; f: ClassInfo["staticFields"][number] }
    | { pos: number; kind: "block"; b: ts.ClassStaticBlockDeclaration };
  const items: Item[] = [
    ...info.staticFields.map((f): Item => ({ pos: f.initializer.getStart(), kind: "field", f })),
    ...(info.staticBlocks ?? []).map((b): Item => ({ pos: b.getStart(), kind: "block", b })),
  ].sort((a, b) => a.pos - b.pos);
  for (const item of items) {
    if (item.kind === "block") {
      // The block's body IS a Block statement: lowerStmts scopes its
      // let/const like any nested block and poisons per inner statement.
      out.push(...lowerer.lowerStmts([item.b.body]));
      continue;
    }
    const f = item.f;
    lowerer.stats.statementsTotal++;
    lowerer.bumpFileStat(locOf(f.initializer).file, "total");
    const diagsBefore = lowerer.diags.length;
    try {
      const previousThis = lowerer.ctx.thisLocal;
      const receiver =
        f.initializer.kind === ts.SyntaxKind.ThisKeyword || hasStaticThis(f.initializer)
          ? lowerer.declareHiddenLocal("%staticThis", {
              kind: "classval",
              className: info.def.name,
            })
          : null;
      if (receiver) {
        lowerer.noteEdge(`%${info.def.name}.constructor`);
        out.push({
          kind: "varDecl",
          localId: receiver.id,
          init: {
            kind: "classRef",
            className: info.def.name,
            type: receiver.type,
            loc: locOf(f.initializer),
          },
          loc: locOf(f.initializer),
        });
      }
      let value: IrExpr;
      try {
        if (receiver) lowerer.ctx.thisLocal = receiver;
        value = lowerer.lowerExprExpecting(f.initializer, f.type);
      } finally {
        lowerer.ctx.thisLocal = previousThis;
      }
      out.push({ kind: "assign", localId: f.globalId, value, loc: locOf(f.initializer) });
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      lowerer.stats.statementsFailed++;
      lowerer.bumpFileStat(locOf(f.initializer).file, "failed");
      if (isJsSourceFile(f.initializer.getSourceFile()) && lowerer.diagSink === null) {
        const fence = lowerer.deferToRuntimeFence(diagsBefore, f.initializer, {
          kind: "statement",
        });
        if (fence) out.push(fence);
      }
    }
  }
  return out;
}

/** Post-collection analysis of a decorated class (all shapes registered —
 * a decorator's return type may name a subclass declared BELOW the
 * class). Classifies every class-level decorator by its checker type:
 * exactly one parameter, itself a classval the decorated class legally
 * flows into (the class, or a base sharing its completed constructor
 * ABI — the classval widening rule), returning void/undefined (an
 * effect-only decorator) or the class/a same-ABI subclass (a REPLACING
 * decorator, whose result rebinds the name). Everything else is a named
 * fence: the standard context parameter, structural sibling
 * replacements tsc admits but the nominal classval world cannot carry,
 * unions mixing the class with undefined. A replacing decorator
 * registers the mutable classval global the name rebinds through, and
 * fences the two shapes the value rebinding cannot keep exact —
 * subclasses of the decorated class (the compiled hierarchy is fixed at
 * build time; the runtime base would be the decoration result) and
 * namespace-nested declarations (qualified references resolve the class
 * directly, not through the rebound value). */
export function analyzeClassDecoration(lowerer: Lowerer, info: ClassInfo): void {
  const cd = info.classDecorators;
  if (!cd || cd.shapes !== undefined || cd.poisoned) return;
  const display = info.def.jsName ?? info.def.name;
  try {
    const shapes: NonNullable<ClassDecorationInfo["shapes"]> = [];
    for (const d of cd.nodes) {
      // An ambient declaration NOTHING defines (`declare let dec: any`,
      // `declare function dec<T>(t: T): T` — the conformance corpus's
      // dominant decorator shape): Node erases it, so the decorator
      // EXPRESSION itself throws ReferenceError when the class statement
      // evaluates. That is runnable semantics, not a fence — the
      // undefRead story (the ambient `declare const` stance verbatim).
      // Factory spellings ride along: `@dec("x")` evaluates the CALLEE
      // before any argument, so the ReferenceError is still the first
      // observable effect.
      const ambientCallee =
        ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression)
          ? d.expression.expression
          : ts.isIdentifier(d.expression)
            ? d.expression
            : null;
      if (ambientCallee !== null) {
        const sym = lowerer.resolveValueSymbol(ambientCallee);
        const vdecl =
          sym && !lowerer.isStdlibSymbol(sym) ? lowerer.checker.declarationsOf(sym)[0] : undefined;
        const ambientVar =
          vdecl !== undefined &&
          ts.isVariableDeclaration(vdecl) &&
          vdecl.initializer === undefined &&
          (ts.getCombinedModifierFlags(vdecl) & ts.ModifierFlags.Ambient) !== 0 &&
          !vdecl.getSourceFile().isDeclarationFile;
        if (ambientVar || ambientUndefinedFnSymbolOf(lowerer, ambientCallee) !== null) {
          shapes.push({ kind: "ambientThrow", name: ambientCallee.text });
          continue;
        }
      }
      const t = lowerer.typeOf(d.expression);
      // Param-count first, off the checker signature: the context-taking
      // shape deserves its own name before mapType (whose failure on
      // ClassDecoratorContext would blur the story).
      const sigs = lowerer.checker.getCallSignatures(t);
      if (sigs.length === 1 && sigs[0]!.getParameters().length > 1) {
        lowerer.unsupported(
          "SC1090",
          d,
          "class decorators that take the standard 'context' parameter (its object — addInitializer, metadata — has no static lowering; single-parameter decorators compile)",
        );
      }
      const mapped = lowerer.mapTypeOf(t);
      if (!mapped || mapped.kind !== "func" || mapped.rest === true || mapped.params.length > 1) {
        lowerer.unsupported(
          "SC1090",
          d,
          "class decorators without one concrete (class) => class-or-void signature ('any'-typed and generic decorators have no compilable call ABI — declare the parameter as the class type)",
        );
      }
      // The parameter: a classval slot the decorated class's object can
      // legally inhabit — the class itself, or a BASE with the same
      // completed constructor ABI (the classval widening rule).
      if (mapped.params.length === 1) {
        const p = mapped.params[0]!;
        const paramOk =
          p.kind === "classval" &&
          (p.className === info.def.name ||
            (isSubclassOf(lowerer, info.def.name, p.className) &&
              (() => {
                const sup = lowerer.classes.get(p.className);
                return sup !== undefined && !sup.generic && ctorAbiEquals(lowerer, info, sup);
              })()));
        if (!paramOk) {
          lowerer.unsupported(
            "SC1090",
            d,
            `class decorators whose parameter is not the decorated class ('${display}' cannot flow into a '${lowerer.fmt(p)}' slot — declare the parameter as 'typeof ${display}' or a base class sharing its constructor signature)`,
          );
        }
      }
      // The return: void/undefined keeps the original binding; the class
      // itself or a same-ABI SUBCLASS is a legal replacement (a classval
      // of the decorated class per the flow rule). tsc also admits
      // structurally-compatible siblings and bases — the nominal classval
      // world cannot carry those, so they fence by name.
      const ret = mapped.ret;
      const replaces = ret.kind === "classval";
      if (replaces) {
        const retOk =
          ret.className === info.def.name ||
          (isSubclassOf(lowerer, ret.className, info.def.name) &&
            (() => {
              const sub = lowerer.classes.get(ret.className);
              return sub !== undefined && !sub.generic && ctorAbiEquals(lowerer, sub, info);
            })());
        if (!retOk) {
          lowerer.unsupported(
            "SC1090",
            d,
            `class decorators returning '${lowerer.fmt(ret)}' (a replacement must be '${display}' itself or a subclass sharing its constructor signature — tsc's structural check admits shapes the compiled nominal hierarchy cannot rebind)`,
          );
        }
      } else if (ret.kind !== "void") {
        lowerer.unsupported(
          "SC1090",
          d,
          `class decorators returning '${lowerer.fmt(ret)}' (supported returns: the decorated class type, a subclass with the same constructor signature, or void)`,
        );
      }
      shapes.push({ kind: "call", funcType: mapped, replaces });
    }
    if (shapes.some((s) => s.kind === "call" && s.replaces)) {
      // The name can rebind at runtime: every reference must route
      // through the decoration result. Two shapes cannot: a compiled
      // subclass (its base pointer, vtable prefix, and interval are
      // fixed at build time, but JS would extend the decoration result)
      // and namespace-nested declarations (the qualified-access paths
      // resolve the class directly, not through the rebound binding).
      if (info.subclasses.length > 0) {
        lowerer.unsupported(
          "SC1090",
          cd.nodes[0]!,
          `class decorators that can replace a class with subclasses ('${info.subclasses[0]!.def.jsName ?? info.subclasses[0]!.def.name}' extends '${display}', but the runtime base would be the decoration result — return void, or decorate the leaf classes)`,
        );
      }
      if (info.decl && !ts.isSourceFile(info.decl.parent)) {
        lowerer.unsupported(
          "SC1090",
          cd.nodes[0]!,
          "class decorators that can replace a namespace-nested class (qualified references resolve the declaration directly — return void, or declare the class at top level)",
        );
      }
      const globalId = `%g.dec.${info.def.name}`;
      lowerer.globalsList.push({
        id: globalId,
        name: `${display}.decorated`,
        type: { kind: "classval", className: info.def.name },
        mutable: true,
      });
      cd.valueGlobalId = globalId;
    }
    cd.shapes = shapes;
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
    cd.poisoned = true;
  }
}

/** The decoration statements of a decorated class — the %init code that
 * runs at the class statement's position, BEFORE its static field
 * initializers and blocks (lowerStaticFieldInits composes them; the
 * lower-modules interleave places the whole bundle). Verified Node
 * order: decorator expressions evaluate in SOURCE order (factories run
 * here), then applications run in REVERSE member order over the class
 * object, each replacing decorator's non-undefined result feeding the
 * next application; the final value binds the class name (the mutable
 * classval global) when any decorator can replace. */
function lowerClassDecoration(lowerer: Lowerer, info: ClassInfo): IrStmt[] {
  const cd = info.classDecorators;
  if (!cd || cd.poisoned || cd.shapes === undefined || info.decl === null) return [];
  const loc = locOf(info.decl);
  const stmts: IrStmt[] = [];
  try {
    // 1. Decorator expressions evaluate in source order, into hidden
    // locals — a later factory's side effects must not precede an
    // earlier one's, and every expression evaluates before any applies.
    // An ambient (never-defined) decorator name throws Node's
    // ReferenceError HERE: earlier expressions still evaluate, nothing
    // after — expression, application, or the class's own static
    // initializers — ever runs (the %init unwinds).
    const temps: {
      localId: string;
      funcType: Extract<IrType, { kind: "func" }>;
      replaces: boolean;
    }[] = [];
    for (let i = 0; i < cd.nodes.length; i++) {
      const d = cd.nodes[i]!;
      const shape = cd.shapes[i]!;
      if (shape.kind === "ambientThrow") {
        stmts.push({
          kind: "exprStmt",
          expr: nsUndefRead(lowerer, shape.name, d, F64),
          loc: locOf(d),
        });
        return stmts;
      }
      const value = lowerer.lowerExprExpecting(d.expression, shape.funcType);
      const local = lowerer.declareHiddenLocal("dec", shape.funcType);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: locOf(d) });
      temps.push({ localId: local.id, funcType: shape.funcType, replaces: shape.replaces });
    }
    // 2. Applications, reverse order, over the accumulating class value.
    let current: IrExpr = classValueRef(lowerer, info, info.decl);
    for (let i = temps.length - 1; i >= 0; i--) {
      const t = temps[i]!;
      const dLoc = locOf(cd.nodes[i]!);
      const callee: IrExpr = { kind: "varRef", localId: t.localId, type: t.funcType, loc: dLoc };
      const args: IrExpr[] = [];
      if (t.funcType.params.length === 1) {
        const p = t.funcType.params[0]!;
        const widened = lowerer.coerceToExpected(current, p);
        lowerer.requireExactShape(cd.nodes[i]!, widened.type, p);
        args.push(widened);
      }
      const call: IrExpr = { kind: "callValue", callee, args, type: t.funcType.ret, loc: dLoc };
      if (t.replaces) {
        const target: IrType = { kind: "classval", className: info.def.name };
        const widened = lowerer.coerceToExpected(call, target);
        lowerer.requireExactShape(cd.nodes[i]!, widened.type, target);
        const res = lowerer.declareHiddenLocal("decres", target);
        stmts.push({ kind: "varDecl", localId: res.id, init: widened, loc: dLoc });
        current = { kind: "varRef", localId: res.id, type: target, loc: dLoc };
      } else {
        stmts.push({ kind: "exprStmt", expr: call, loc: dLoc });
      }
    }
    // 3. The binding: TC39 rebinds the class name to the final result.
    if (cd.valueGlobalId !== undefined) {
      stmts.push({ kind: "assign", localId: cd.valueGlobalId, value: current, loc });
    }
    return stmts;
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
    lowerer.stats.statementsFailed++;
    lowerer.bumpFileStat(loc.file, "failed");
    return [];
  }
}

/** The nearest declaration of static member `name` at or above `info` —
 * the compile-time prototype-chain walk (`D.x` reads C's global when C
 * declared x and nothing between redeclares it; a redeclaration shadows
 * with its OWN storage, exactly JS). */
export function findStaticOn(
  lowerer: Lowerer,
  info: ClassInfo | null,
  name: string,
):
  | { declarer: ClassInfo; field: ClassInfo["staticFields"][number]; method?: undefined }
  | {
      declarer: ClassInfo;
      method: {
        params: ParamShape[];
        ret: IrType;
        member: ts.MethodDeclaration;
        receiverInfo?: GenericFnInfo;
      };
      field?: undefined;
    }
  | null {
  for (let c = info; c; c = c.base) {
    const field = c.staticFields.find((s) => s.name === name);
    if (field) return { declarer: c, field };
    const method = c.staticMethods?.get(name);
    if (method) return { declarer: c, method };
  }
  return null;
}

/** True when some STRICT descendant of `info` redeclares static `name` —
 * the through-a-VALUE devirtualization test: a classval(info) slot can
 * hold any descendant, and a shadowing redeclaration means the runtime
 * class decides which storage answers. */
export function staticShadowBelow(info: ClassInfo, name: string): boolean {
  return info.subclasses.some(
    (s) =>
      s.staticFields.some((f) => f.name === name) ||
      s.staticMethods?.has(name) === true ||
      s.genericStatics?.has(name) === true ||
      staticShadowBelow(s, name),
  );
}

/** The nearest GENERIC static declaration of `name` at/above `info` —
 * findStaticOn's twin over the genericStatics tables. */
export function findGenericStaticOn(
  lowerer: Lowerer,
  info: ClassInfo | null,
  name: string,
): { declarer: ClassInfo; info: GenericFnInfo } | null {
  for (let c = info; c; c = c.base) {
    const gs = c.genericStatics?.get(name);
    if (gs) return { declarer: c, info: gs };
  }
  return null;
}

/** A static METHOD taken as a value: the zero-capture closure over its
 * module function — the declared-function-as-value rule verbatim
 * (interned by the backend, so `C.m === C.m` holds). */
function staticMethodValue(
  lowerer: Lowerer,
  declarer: ClassInfo,
  name: string,
  sig: { params: ParamShape[]; ret: IrType },
  blame: ts.Expression,
  loc: SrcLoc,
): IrExpr {
  const reflected = reflectedClassStaticMethodValue(lowerer, declarer, name);
  if (reflected) return reflected;
  const fnName = `%${declarer.def.name}.static:${name}`;
  lowerer.noteEdge(fnName);
  const funcType: IrType = {
    kind: "func",
    params: sig.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
    ret: sig.ret,
    ...(sig.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
  };
  lowerer.requireExactArityValue(blame, blame, sig.params, funcType);
  return { kind: "closure", fnName, captures: [], type: funcType, loc };
}

/** The class itself taken as a VALUE (`const X = C`, an argument, an
 * array element, a class expression's result): the classRef over the
 * per-class immortal class object. The construct thunk needs a thunk-
 * shaped constructor, so classes whose construction is libCall-shaped —
 * the runtime-provided builtins and anything inheriting a builtin
 * constructor (Error/EventEmitter/stream chains complete their `new`
 * by special rules) — are named fences here. The constructor edge is
 * noted at every classRef: a value can always be constructed through. */
export function classValueRef(lowerer: Lowerer, info: ClassInfo, blame: ts.Node): IrExpr {
  const display = info.def.name.replace(/^%|^%m\d+\./, "");
  fenceDecorationThrows(lowerer, info, blame);
  if (info.localClass && ts.isIdentifier(blame)) {
    const stored = lowerer.resolveLocal(blame);
    if (stored)
      return lowerer.coerceToExpected(
        { kind: "varRef", localId: stored.id, type: stored.type, loc: locOf(blame) },
        { kind: "classval", className: info.def.name },
      );
  }
  if (info.localClass && !ts.isClassExpression(blame) && !ts.isClassDeclaration(blame)) {
    lowerer.unsupported("SC1090", blame, "named self references inside function-local classes");
  }
  if (info.generic) {
    // `typeof Box` — the uninstantiated FAMILY as a value: no thunk, no
    // single constructor ABI. INSTANTIATIONS have class objects
    // (`const B = Box<number>`, `new (v: number) => Box<number>` slots).
    lowerer.unsupported(
      "SC1090",
      blame,
      `generic classes as values ('typeof ${display}' keeps the type parameter — instantiation expressions ('${display}<number>') and concrete constructor-typed slots compile)`,
    );
  }
  if (info.builtinError || info.builtinEmitter || info.builtinStream !== undefined) {
    lowerer.unsupported(
      "SC1090",
      blame,
      `builtin classes as values ('${display}' is runtime-provided — reference program-declared classes instead)`,
    );
  }
  if (
    lowerer.inheritsBuiltinEmitterCtor(info) ||
    inheritsBuiltinStreamCtor(lowerer, info) ||
    (() => {
      for (let c = info.base; c; c = c.base)
        if (c.builtinEmitter || c.builtinStream !== undefined) return true;
      return false;
    })()
  ) {
    lowerer.unsupported(
      "SC1090",
      blame,
      `classes extending builtin bases as values ('${display}' inherits a runtime-provided constructor)`,
    );
  }
  lowerer.noteEdge(`%${info.def.name}.constructor`);
  return {
    kind: "classRef",
    className: info.def.name,
    type: { kind: "classval", className: info.def.name },
    loc: locOf(blame),
  };
}

/** Constructor-ABI equality — the classval widening rule: a classval(D)
 * value may flow into a classval(C) slot only when D's completed
 * constructor signature equals C's (same count, modes, and ABI types),
 * which is what keeps newValue completion against C's one signature
 * sound for every value legally in the slot. */
export function ctorAbiEquals(lowerer: Lowerer, sub: ClassInfo, sup: ClassInfo): boolean {
  const a = sub.ctorParams;
  const b = sup.ctorParams;
  return (
    a.length === b.length &&
    a.every((p, i) => p.mode === b[i]!.mode && typeEquals(p.type, b[i]!.type))
  );
}

/** Writable storage for an own static field named through its exact class.
 * Inherited writes create a new subclass property in JS, so they must not
 * update the declaring class's global. */
export function staticFieldWriteTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): { id: string; type: IrType } | null {
  if (
    access.questionDotToken ||
    (!ts.isIdentifier(access.expression) && access.expression.kind !== ts.SyntaxKind.ThisKeyword)
  )
    return null;
  const info = lowerer.exactClassOfReceiver(access.expression);
  if (!info) return null;
  const found = lowerer.findStaticOn(info, access.name.text);
  if (!found?.field) return null;
  if (found.declarer !== info) {
    lowerer.unsupported(
      "SC1090",
      access,
      `assigning the inherited static '${access.name.text}' through a subclass name (JS creates an OWN property on the subclass — assign through '${found.declarer.def.jsName ?? found.declarer.def.name}' instead)`,
    );
  }
  if (found.field.readonly) {
    lowerer.unsupported("SC1090", access, `assigning the readonly static '${access.name.text}'`);
  }
  return { id: found.field.globalId, type: found.field.type };
}

/** `C.x` where C is a class declared in the program and x a static
 * member of its chain: field reads are the module global, static
 * methods become interned closures, and `.name` folds to the class's
 * compile-time name. Null for everything else — unresolved members
 * fall through to the ordinary chain so the static fence or the
 * generic member rejection names the site. */
export function lowerStaticFieldRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.name.text === "prototype") return null;
  if (expr.questionDotToken) return null;
  if (
    !ts.isIdentifier(expr.expression) &&
    expr.expression.kind !== ts.SyntaxKind.ThisKeyword &&
    exactClassOfReceiver(lowerer, expr.expression) === null
  )
    return null;
  const symbol = ts.isIdentifier(expr.expression)
    ? lowerer.resolveValueSymbol(expr.expression)
    : null;
  const info =
    (symbol ? lowerer.classBySymbol.get(symbol) : undefined) ??
    // A require binding over `module.exports = class {…}` (the alias
    // lands on the expression's own symbol): resolve/collect on demand,
    // or `C.name` below would fall through to paths that answer for
    // stdlib globals instead of this class.
    propertyAssignedClassInfoOf(lowerer, symbol) ??
    exactClassOfReceiver(lowerer, expr.expression) ??
    undefined;
  if (!info) return null;
  // A decorated name that can REBIND (a replacing decorator): the
  // receiver is the decoration result, not the declaration — fall
  // through to the through-a-VALUE paths (lowerClassValueProperty),
  // whose devirtualization and .name rules answer for every legal
  // runtime value.
  if (info.classDecorators?.valueGlobalId !== undefined) return null;
  const loc = locOf(expr);
  const found = findStaticOn(lowerer, info, expr.name.text);
  if (hasRuntimeStatics(info) && !found?.field)
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(classValueRef(lowerer, info, expr.expression), DYN),
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
      type: DYN,
      loc,
    };
  // A #private static resolves only through the DECLARING class's own
  // name: in JS the brand lives on that one constructor object, so
  // `D.#s` (a subclass receiver) throws Node's TypeError instead of
  // reaching up the chain — fenced rather than silently resolved.
  if (found && expr.name.text.startsWith("#") && found.declarer !== info) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `reading the private static '${expr.name.text}' through the subclass '${info.def.name.replace(/^%|^%m\d+\./, "")}' (JS brands the declaring class object alone — Node throws a TypeError here; spell the declaring class's name)`,
    );
  }
  if (found?.field !== undefined) {
    return lowerer.maybeNarrow(
      { kind: "varRef", localId: found.field.globalId, type: found.field.type, loc },
      expr,
    );
  }
  if (found) {
    return staticMethodValue(lowerer, found.declarer, expr.name.text, found.method, expr, loc);
  }
  // A GENERIC static method as a VALUE: the pinned-value rule verbatim
  // (lowerGenericFnValue) — a slot spelling one concrete signature names
  // an instance, an unpinned reference fences by name.
  {
    const gfound = findGenericStaticOn(lowerer, info, expr.name.text);
    if (gfound) return lowerer.lowerGenericFnValue(expr, gfound.info);
  }
  // `C.name` — the JS-observable class name, a compile-time constant on
  // the direct spelling (tsc rejects user statics named `name`, so the
  // chain above can never shadow it in TypeScript sources).
  if (expr.name.text === "name" && info.def.jsName !== undefined) {
    return { kind: "strLit", value: info.def.jsName, type: STRING, loc };
  }
  if (info.callableBase)
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(classValueRef(lowerer, info, expr.expression), DYN),
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
      type: DYN,
      loc,
    };
  const data = classStaticDataFor(lowerer, info, expr.name.text, loc);
  if (data) {
    const value: IrExpr = {
      kind: "dynKeyGet",
      value: data,
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
      type: DYN,
      loc,
    };
    // JavaScript often assigns public statics after the class declaration.
    // Their storage stays mutable and checked, while reads retain the
    // checker's concrete type instead of losing the method receiver.
    const type = isJsSourceFile(expr.getSourceFile())
      ? null
      : lowerer.mapTypeOf(lowerer.typeOf(expr));
    return type ? lowerer.coerceToExpected(value, type) : value;
  }
  return null;
}

/** NamedEvaluation's answer for a class expression's `.name`: its own
 * declared name, else the binding name when the expression is the
 * direct initializer of a variable declaration / the RHS of a simple
 * assignment / an object-literal property value / a default parameter —
 * "" everywhere else (array elements, call arguments). Verified against
 * Node for each shape. */
function namedEvaluationName(expr: ts.ClassLikeDeclaration): string {
  if (expr.name) return expr.name.text;
  let p: ts.Node | undefined = expr.parent;
  while (ts.isParenthesizedExpression(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer !== undefined)
    return p.name.text;
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(p.left)
  )
    return p.left.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isParameter(p) && ts.isIdentifier(p.name)) return p.name.text;
  return "";
}

/** Collect a class expression once per enclosing specialization. Function-local
 * evaluations allocate fresh constructor objects; top-level expressions use
 * immortal templates. Static initialization remains limited to whole top-level
 * initializers, where pendingClassExprInits preserves its evaluation point. */
export function lowerClassExpressionInfo(
  lowerer: Lowerer,
  expr: ts.ClassLikeDeclaration,
): ClassInfo {
  const cached = lowerer.exprClassInfoByName.get(lowerer.classNamer(expr));
  if (cached) return cached;
  // Reentrancy guard: heritage resolution can DEMAND another class
  // expression's collection (extends through property assignments —
  // propertyAssignedClassInfoOf), so a cyclic base chain would re-enter
  // its own collection here. The tsc gate rejects every such cycle it
  // can see (TS2506/TS2303 — direct, indirect, and cross-file require
  // cycles all probed); this fence is the backstop that turns anything
  // it misses into a diagnostic instead of a stack overflow.
  if (lowerer.collectingExprClasses.has(expr)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "class expressions whose extends chain re-enters their own collection (a cyclic base through property assignments)",
    );
  }
  let local = false;
  for (
    let p: ts.Node | undefined = expr.parent;
    p !== undefined && !ts.isSourceFile(p);
    p = p.parent
  ) {
    if (ts.isClassStaticBlockDeclaration(p)) {
      lowerer.unsupported("SC1090", expr, "class expressions inside static blocks");
    }
    if (ts.isFunctionLike(p)) local = true;
  }
  if (local && expr.members.some((member) => member.name && ts.isPrivateIdentifier(member.name))) {
    lowerer.unsupported("SC1090", expr, "function-local classes with private brands");
  }
  if (
    local &&
    (expr.typeParameters?.length ||
      decoratorNodesOf(expr).length ||
      expr.members.some(
        (member) =>
          decoratorNodesOf(member).length ||
          (!isJsSourceFile(expr.getSourceFile()) &&
            (ts.isClassStaticBlockDeclaration(member) ||
              ts
                .getModifiers(member)
                ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))) ||
          (ts.isMethodDeclaration(member) && member.typeParameters?.length),
      ))
  ) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "function-local classes with statics, decorators, or generic members",
    );
  }
  lowerer.collectingExprClasses.add(expr);
  try {
    if (
      local &&
      lowerer.fnStack.length > 0 &&
      !lowerer.computedClassBases.has(lowerer.classNamer(expr))
    ) {
      const heritage = expr.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types[0]?.expression;
      if (
        heritage &&
        (ts.isCallExpression(heritage) ||
          (ts.isIdentifier(heritage) &&
            (lowerer.peekLocal(heritage) ?? lowerer.globalOf(heritage)) != null))
      ) {
        let value = lowerer.lowerExpr(heritage);
        const known = value.type.kind === "dyn" ? storedClassValueType(lowerer, heritage) : null;
        if (known?.kind === "classval") value = lowerer.coerceToExpected(value, known);
        const base =
          value.type.kind === "classval" ? lowerer.classes.get(value.type.className) : undefined;
        if (base)
          lowerer.computedClassBases.set(lowerer.classNamer(expr), { value, classInfo: base });
        else if (value.type.kind === "dyn" || value.type.kind === "func")
          lowerer.computedCallableBases.set(expr, value);
      }
    }
    lowerer.collectClassShapeInner(expr, namedEvaluationName(expr));
  } finally {
    lowerer.collectingExprClasses.delete(expr);
  }
  const info = lowerer.classes.get(lowerer.classNamer(expr));
  if (!info) throw new PoisonError(); // collection poisoned and reported
  if (local) {
    info.def.localCaptures = [];
    info.def.fields.push({
      name: `%classEnvironment:${info.def.name}`,
      type: { kind: "classval", className: info.def.name },
    });
    info.localClass = { context: null, bodies: new Map(), captureSources: [], ready: false };
    if (info.base?.localClass) {
      const baseExpression = expr.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types[0]?.expression;
      if (baseExpression) info.localClass.baseExpression = baseExpression;
    }
  }
  lowerer.exprClassInfoByName.set(info.def.name, info);
  lowerer.exprClasses.push(info);
  lowerer.onExprClassCollected?.(info);
  // Static field initializers and static blocks run when the class
  // expression EVALUATES. The supported positions evaluate exactly once,
  // at the top-level statement containing the expression — the pending
  // buffer lands them immediately before that statement (lowerFileInit
  // drains it), which is JS's order for whole-initializer positions.
  // Anything subtler (multi-declarator statements, arguments evaluated
  // after other side effects) is a named fence, never a reordering.
  if (
    !local &&
    (info.callableBase ||
      info.def.baseValueGlobal ||
      info.runtimeStatics ||
      info.staticFields.length > 0 ||
      (info.staticBlocks?.length ?? 0) > 0)
  ) {
    let holder: ts.Node | undefined = expr.parent;
    while (
      ts.isParenthesizedExpression(holder) ||
      ts.isClassExpression(holder) ||
      ts.isHeritageClause(holder) ||
      ts.isExpressionWithTypeArguments(holder)
    ) {
      holder = holder.parent;
    }
    const wholeInit =
      (ts.isVariableDeclaration(holder) &&
        holder.initializer !== undefined &&
        ts.isVariableDeclarationList(holder.parent) &&
        holder.parent.declarations.length === 1 &&
        ts.isVariableStatement(holder.parent.parent) &&
        ts.isSourceFile(holder.parent.parent.parent)) ||
      (ts.isBinaryExpression(holder) &&
        holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isExpressionStatement(holder.parent) &&
        ts.isSourceFile(holder.parent.parent)) ||
      (ts.isExpressionStatement(holder) && ts.isSourceFile(holder.parent));
    if (!wholeInit) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "class expressions with static initializers or static blocks outside a whole-initializer position (their declaration-time code must run exactly where the expression evaluates — bind the class in its own top-level `const C = class …` statement)",
      );
    }
  }
  return info;
}

/** `class {…}` in expression position: a class definition bound to no
 * statement — once the static side is a value, the expression IS the
 * definition plus a classRef over it. A DECORATED class expression
 * whose decoration provably throws (the ambient-decorator shape) never
 * mints a class at all: evaluating the expression IS the
 * ReferenceError, so it lowers to exactly that read — every evaluation
 * throws identically, which is why the once-evaluated restriction and
 * the member fences don't apply. */
export function lowerClassExpression(lowerer: Lowerer, expr: ts.ClassLikeDeclaration): IrExpr {
  if (
    decoratorNodesOf(expr).length > 0 ||
    expr.members.some((m) => decoratorNodesOf(m).length > 0)
  ) {
    if (!isJsSourceFile(expr.getSourceFile()) && expr.typeParameters === undefined) {
      const thrown = guaranteedDecorationThrow(lowerer, expr);
      if (thrown) {
        // The expression's static type never materializes — the read
        // throws — so the nominal IR type only has to satisfy the
        // consumer. F64 is the ambient-undefRead convention.
        return nsUndefRead(lowerer, thrown.name, expr, F64);
      }
    }
  }
  const info = lowerClassExpressionInfo(lowerer, expr);
  if (
    !info.localClass &&
    !info.expressionInitializationEmitted &&
    (info.callableBase ||
      info.def.baseValueGlobal ||
      info.runtimeStatics ||
      info.staticFields.length > 0 ||
      (info.staticBlocks?.length ?? 0) > 0)
  ) {
    info.expressionInitializationEmitted = true;
    lowerer.pendingClassExprInits.push(...lowerer.lowerStaticFieldInits(info));
  }
  if (info.localClass && !info.localClass.ready) {
    const context = newFnCtx(true, null, null, VOID);
    info.localClass.context = context;
    lowerer.fnStack.push(context);
    try {
      const bodies = lowerClassMembers(lowerer, info);
      for (const body of bodies) info.localClass.bodies.set(body.name, body);
      info.def.localCaptures = context.captures!;
      info.localClass.captureSources = context.captureSources;
      if (info.localClass.baseExpression && info.base) {
        info.def.localBaseCapture = info.def.localCaptures.length;
        info.def.localCaptures.push({
          localId: "%base",
          name: "base",
          type: { kind: "classval", className: info.base.def.name },
        });
      }
      info.localClass.ready = true;
      lowerer.onExprClassCollected?.(info);
    } finally {
      lowerer.fnStack.pop();
      info.localClass.context = null;
    }
  }
  const value = classValueRef(lowerer, info, expr);
  if (info.localClass && info.callableBase && value.kind === "classRef") {
    const loc = locOf(expr);
    const base = lowerer.lowerExprExpecting(info.callableBase.expression, DYN);
    const baseLocal = lowerer.declareHiddenLocal("%classBase", DYN);
    const clsLocal = lowerer.declareHiddenLocal("%classValue", value.type);
    const baseRef: IrExpr = { kind: "varRef", localId: baseLocal.id, type: DYN, loc };
    const clsRef: IrExpr = { kind: "varRef", localId: clsLocal.id, type: value.type, loc };
    const boxed: IrExpr = { kind: "dynFrom", value: clsRef, type: DYN, loc };
    info.localPrototypeData = true;
    return initializeRuntimeStatics(lowerer, info, {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: baseLocal.id, init: base, loc },
        {
          kind: "varDecl",
          localId: clsLocal.id,
          init: { ...value, captures: info.localClass.captureSources },
          loc,
        },
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.classInherit", args: [boxed, baseRef], type: DYN, loc },
          loc,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.classPrototype",
            args: [
              boxed,
              { kind: "libCall", fn: "dyn.classBasePrototype", args: [baseRef], type: DYN, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      result: clsRef,
      type: value.type,
      loc,
    });
  }
  if (info.localClass?.baseExpression && info.base && value.kind === "classRef") {
    const loc = locOf(expr);
    const base = lowerer.lowerExprExpecting(info.localClass.baseExpression, {
      kind: "classval",
      className: info.base.def.name,
    });
    const baseLocal = lowerer.declareHiddenLocal("%classBase", base.type);
    baseLocal.boxed = true;
    const clsLocal = lowerer.declareHiddenLocal("%classValue", value.type);
    const baseRef: IrExpr = { kind: "varRef", localId: baseLocal.id, type: base.type, loc };
    const clsRef: IrExpr = { kind: "varRef", localId: clsLocal.id, type: value.type, loc };
    const basePrototype = classPrototypeData(lowerer, info.base, loc, baseRef)!;
    info.localPrototypeData = true;
    return initializeRuntimeStatics(lowerer, info, {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: baseLocal.id, init: base, loc },
        {
          kind: "varDecl",
          localId: clsLocal.id,
          init: { ...value, captures: [...info.localClass.captureSources, baseLocal.id] },
          loc,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.classInherit",
            args: [
              { kind: "dynFrom", value: clsRef, type: DYN, loc },
              { kind: "dynFrom", value: baseRef, type: DYN, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.classPrototype",
            args: [{ kind: "dynFrom", value: clsRef, type: DYN, loc }, basePrototype],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      result: clsRef,
      type: value.type,
      loc,
    });
  }
  return info.localClass
    ? initializeRuntimeStatics(
        lowerer,
        info,
        value.kind === "classRef" ? { ...value, captures: info.localClass.captureSources } : value,
      )
    : value;
}

/** The EXACT class a receiver expression is statically known to BE (not
 * merely be typed by): the class name itself, or a `const` binding
 * whose initializer is a class expression / class name. Such receivers
 * can never hold a subclass at runtime, so static WRITES through them
 * hit the declaring class's storage exactly (the shadowing hazards of
 * general class values don't arise). Null for everything else. */
export function exactClassOfReceiver(lowerer: Lowerer, expr: ts.Expression): ClassInfo | null {
  if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
    const member = nsMemberIdentOf(lowerer, expr);
    if (member) return exactClassOfReceiver(lowerer, member);
  }
  // A class-valued lexical this is introduced only for an exact static
  // receiver specialization; ordinary instance this remains an object.
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const receiver = lowerer.resolveThis();
    return receiver?.type.kind === "classval"
      ? (lowerer.classes.get(receiver.type.className) ?? null)
      : null;
  }
  if (!ts.isIdentifier(expr)) return null;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol) return null;
  const direct = lowerer.classBySymbol.get(symbol);
  // A rebindable decorated name is NOT exactly its class — the binding
  // may hold a replacing decorator's result (a subclass value), where a
  // static write would create an own property in JS. The general
  // class-value write fence answers instead.
  if (direct) return direct.classDecorators?.valueGlobalId !== undefined ? null : direct;
  const decl = lowerer.checker.valueDeclarationOf(symbol);
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (ts.isClassExpression(init))
    return lowerer.exprClassInfoByName.get(lowerer.classNamer(init)) ?? null;
  if (ts.isIdentifier(init)) {
    const initSym = lowerer.resolveValueSymbol(init);
    const aliased = initSym ? (lowerer.classBySymbol.get(initSym) ?? null) : null;
    // `const X = C` over a rebindable decorated name: X holds the
    // decoration result — not exactly C (see the direct case above).
    return aliased?.classDecorators?.valueGlobalId !== undefined ? null : aliased;
  }
  return null;
}

/** The class a PROPERTY-ASSIGNMENT binding pins — the salsa/CJS
 * declaration forms of a class expression: `Common.I = class {…}`
 * (expando members of a plain object), `exports.I = class {…}` /
 * `module.exports.I = class {…}` (CJS member exports), and
 * `module.exports = class {…}` (the whole-export replacement, whose
 * export symbol requirer bindings alias to). The symbol arrives in two
 * shapes — an ALIAS resolving to the class expression's own symbol
 * (valueDeclaration IS the ts.ClassExpression), or the expando property
 * symbol whose declarations are the assignment BinaryExpressions — and
 * both pin the class exactly when ONE top-level assignment declares it:
 * a reassigned property is a dynamic binding (the runtime class is
 * whichever assignment ran last), so it answers null and the caller's
 * fence names it. Collection is on demand and idempotent
 * (lowerClassExpressionInfo), so resolution order between files and
 * passes never matters. */
export function propertyAssignedClassInfoOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): ClassInfo | null {
  if (!symbol) return null;
  const resolved =
    symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
  const registered = lowerer.classBySymbol.get(resolved);
  if (registered) return registered;
  const decls = lowerer.checker.declarationsOf(resolved);
  // The class expression's OWN symbol (tsgo's answer through CJS export
  // aliases): the declaration is the expression itself. Its top-level
  // assignment statement must be the binding's ONLY producer. The
  // resolved symbol registers in classBySymbol so every downstream
  // path — static reads, the `.name` fold, instanceof — answers like a
  // declaration from then on.
  if (decls.length === 1 && decls[0] !== undefined && ts.isClassExpression(decls[0])) {
    const assign = enclosingTopLevelClassAssignment(decls[0]);
    if (!assign || countAssignmentsTo(assign) !== 1) return null;
    const info = lowerer.lowerClassExpressionInfo(decls[0]);
    lowerer.classBySymbol.set(resolved, info);
    return info;
  }
  // The expando property symbol: every top-level `X.N = …` assignment is
  // one of its declarations — exactly one, binding a class expression,
  // pins the class.
  const assigns = decls.filter(
    (d): d is ts.BinaryExpression =>
      ts.isBinaryExpression(d) && d.operatorToken.kind === ts.SyntaxKind.EqualsToken,
  );
  if (assigns.length !== 1 || assigns.length !== decls.length) return null;
  const a = assigns[0]!;
  if (!ts.isExpressionStatement(a.parent) || !ts.isSourceFile(a.parent.parent)) return null;
  let rhs: ts.Expression = a.right;
  while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
  if (!ts.isClassExpression(rhs)) return null;
  const info = lowerer.lowerClassExpressionInfo(rhs);
  lowerer.classBySymbol.set(resolved, info);
  return info;
}

/** The top-level `… = <this class expression>` assignment a class
 * expression is the (paren-unwrapped) RHS of, or null. */
function enclosingTopLevelClassAssignment(expr: ts.ClassExpression): ts.BinaryExpression | null {
  let value: ts.Expression = expr;
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  const p = value.parent;
  if (
    !ts.isBinaryExpression(p) ||
    p.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    p.right !== value ||
    !ts.isExpressionStatement(p.parent) ||
    !ts.isSourceFile(p.parent.parent)
  ) {
    return null;
  }
  return p;
}

/** How many top-level statements of the file assign the same target as
 * `assign` (textual LHS match — `module.exports`, `exports.I`,
 * `Common.I`): a second assignment makes the binding dynamic, so
 * callers refuse to pin the first one's class. */
function countAssignmentsTo(assign: ts.BinaryExpression): number {
  const sf = assign.getSourceFile();
  // `exports.I` and `module.exports.I` are the SAME binding in Node
  // (exports aliases module.exports until a table replaces it) — fold
  // the member spellings together before comparing.
  const canon = (lhs: ts.Expression): string => {
    const text = lhs.getText().replace(/\s+/g, "");
    return text.startsWith("module.exports.") ? text.slice("module.".length) : text;
  };
  const target = canon(assign.left);
  let n = 0;
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const e = stmt.expression;
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      canon(e.left) === target
    ) {
      n++;
    }
  }
  return n;
}

/** `C.m(args)` / `X.m(args)` — static method calls, on the class name
 * directly or through a class VALUE. Resolution walks the chain
 * (nearest declarer, the compile-time prototype chain); through a
 * VALUE the call devirtualizes exactly when no strict descendant
 * redeclares the member (values never leave the static class's
 * subtree). A func-typed static FIELD in call position reads the
 * global and calls through the value. Null when the receiver isn't a
 * class name/value or the member doesn't resolve (the fences name the
 * site downstream). */
export function lowerStaticMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const receiver = lowerer.resolveThis();
    const info =
      receiver?.type.kind === "classval" ? lowerer.classes.get(receiver.type.className) : undefined;
    if (info) return staticCallOn(lowerer, call, access, info, false);
  }
  // Namespace exports are immutable bindings to the same declaration as
  // named imports. Resolve them before asking for a constructor-value ABI:
  // a generic family has statics but no single constructor signature.
  if (ts.isPropertyAccessExpression(access.expression) && !access.expression.questionDotToken) {
    const member = nsMemberIdentOf(lowerer, access.expression);
    const symbol = member ? lowerer.resolveValueSymbol(member) : null;
    const info = symbol ? lowerer.classBySymbol.get(symbol) : undefined;
    if (info && info.classDecorators?.valueGlobalId === undefined) {
      if (symbol) fenceEarlyNsMemberRef(lowerer, access.expression, symbol);
      return staticCallOn(lowerer, call, access, info, false);
    }
  }
  // `module.exports.describe()` in a module whose whole export IS a
  // class expression: the receiver is exactly that class (the kept
  // export assignment pins it) — the direct-name rules apply.
  if (!ts.isIdentifier(access.expression)) {
    if (
      !isModuleExportsAccess(access.expression) ||
      !isCjsJsFile(access.getSourceFile(), lowerer.program)
    ) {
      let receiverType = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
      if (receiverType?.kind !== "classval" && isJsSourceFile(call.getSourceFile())) {
        const receiver = tryLowerExpression(lowerer, access.expression);
        if (receiver?.type.kind === "classval") receiverType = receiver.type;
      }
      if (receiverType?.kind !== "classval") return null;
      const info = lowerer.classes.get(receiverType.className);
      if (!info) return null;
      const result = staticCallOn(lowerer, call, access, info, true);
      if (!result) return null;
      // Evaluate and validate the receiver before evaluating arguments.
      // A typed checker projection cannot turn a replaced field into a call
      // to the class that originally occupied it.
      const receiver = lowerer.lowerExprExpecting(access.expression, receiverType);
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: receiver, loc: locOf(access.expression) }],
        result,
        type: result.type,
        loc: locOf(call),
      };
    }
    const whole = cjsClassExprWholeExportOf(access.getSourceFile());
    if (!whole) return null;
    return staticCallOn(
      lowerer,
      call,
      access,
      lowerer.lowerClassExpressionInfo(whole.classExpr),
      false,
    );
  }
  const symbol = lowerer.resolveValueSymbol(access.expression);
  const direct =
    (symbol ? lowerer.classBySymbol.get(symbol) : undefined) ??
    // A require binding over `module.exports = class {…}`: the alias
    // lands on the expression's own symbol — exact, like the name.
    propertyAssignedClassInfoOf(lowerer, symbol) ??
    undefined;
  let info = direct ?? null;
  // A rebindable decorated name is a class VALUE receiver: the call
  // devirtualizes under the value rules (shadow fences below).
  let throughValue = direct?.classDecorators?.valueGlobalId !== undefined;
  if (!info) {
    const recvT = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
    if (recvT?.kind !== "classval") return null;
    info = lowerer.classes.get(recvT.className) ?? null;
    throughValue = true;
  }
  if (!info) return null;
  return staticCallOn(lowerer, call, access, info, throughValue);
}

/** True when a class-VALUE receiver can only hold `info`'s own class
 * object at runtime: the receiver provably IS the class
 * (exactClassOfReceiver — the name, or a const bound to the class
 * expression / class name), or `info` is a LEAF class, so no strict
 * descendant exists to flow into the slot (the static-write path's
 * rule — a rebindable decorated name rides this arm, since replacement
 * decorators fence any class with subclasses before minting the
 * rebindable global). Exactly then a #private static access through
 * the value always carries the declaring class's brand — Node's
 * TypeError cannot arise. */
function classValueIsExactlyOwn(lowerer: Lowerer, recv: ts.Expression, info: ClassInfo): boolean {
  return exactClassOfReceiver(lowerer, recv) === info || info.subclasses.length === 0;
}

function staticCallOn(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  info: ClassInfo,
  throughValue: boolean,
): IrExpr | null {
  const loc = locOf(call);
  if (
    (hasRuntimeStatics(info) && !findStaticOn(lowerer, info, access.name.text)?.field) ||
    (info.callableBase &&
      !findStaticOn(lowerer, info, access.name.text) &&
      !findGenericStaticOn(lowerer, info, access.name.text))
  )
    return {
      kind: "dynInvoke",
      recv: lowerer.lowerExprExpecting(access.expression, DYN),
      method: access.name.text,
      calleeName: access.name.text,
      args: call.arguments.map((argument) => lowerer.lowerExprExpecting(argument, DYN)),
      type: DYN,
      loc,
    };
  // #private statics: through-a-VALUE receiver the call devirtualizes
  // exactly when the value can only BE the declaring class
  // (classValueIsExactlyOwn — a slot that could hold a descendant at
  // runtime fences, since only the declaring class object carries the
  // brand in JS), and the direct spelling resolves only on the
  // declaring class itself — `D.#s` is Node's TypeError.
  if (
    access.name.text.startsWith("#") &&
    throughValue &&
    !classValueIsExactlyOwn(lowerer, access.expression, info)
  ) {
    lowerer.unsupported(
      "SC1090",
      call,
      `calling the private static '${access.name.text}' through a class value (JS brands the declaring class object alone — call it through the class's own name)`,
    );
  }
  const found = findStaticOn(lowerer, info, access.name.text);
  if (found && access.name.text.startsWith("#") && found.declarer !== info) {
    lowerer.unsupported(
      "SC1090",
      call,
      `calling the private static '${access.name.text}' through the subclass '${info.def.name.replace(/^%|^%m\d+\./, "")}' (JS brands the declaring class object alone — Node throws a TypeError here; spell the declaring class's name)`,
    );
  }
  if (!found) {
    // GENERIC static methods: monomorphized like top-level generic
    // functions, called directly as `%C.static:m%n` — with the same
    // through-a-VALUE shadowing fence as plain statics.
    const gfound = findGenericStaticOn(lowerer, info, access.name.text);
    if (!gfound) return null;
    if (throughValue && staticShadowBelow(info, access.name.text)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `calling the static member '${access.name.text}' through a class value (a subclass of '${info.def.name.replace(/^%|^%m\d+\./, "")}' redeclares it, so the runtime class decides which declaration answers)`,
      );
    }
    const instance = genericCallInstance(
      lowerer,
      call,
      staticMethodForReceiver(lowerer, access, gfound.info, info, throughValue),
    );
    const args = lowerer.completeArgs(call.arguments, instance.params, loc, call);
    return { kind: "call", callee: instance.name, args, type: instance.returnType, loc };
  }
  if (throughValue && staticShadowBelow(info, access.name.text)) {
    lowerer.unsupported(
      "SC1090",
      call,
      `calling the static member '${access.name.text}' through a class value (a subclass of '${info.def.name.replace(/^%|^%m\d+\./, "")}' redeclares it, so the runtime class decides which declaration answers)`,
    );
  }
  const specialized = findGenericStaticOn(lowerer, info, access.name.text);
  if (specialized?.declarer === found.declarer && specialized.info.implicitParams) {
    const instance = implicitCallInstance(
      lowerer,
      call,
      staticMethodForReceiver(lowerer, access, specialized.info, info, throughValue),
    );
    const args = lowerer.completeArgs(call.arguments, instance.params, loc, call);
    return { kind: "call", callee: instance.name, args, type: instance.returnType, loc };
  }
  if (found.field !== undefined) {
    // A func-typed static field in call position: read the global,
    // call through the value (the ctor-assigned-callback pattern).
    if (found.field.type.kind !== "func") return null;
    const callee: IrExpr = {
      kind: "varRef",
      localId: found.field.globalId,
      type: found.field.type,
      loc,
    };
    const params = found.field.type.params;
    const args = call.arguments.map((a, i) => lowerer.lowerExprExpecting(a, params[i]));
    for (let i = args.length; i < params.length; i++) {
      const absent = omittedArgFor(lowerer, params[i]!, loc);
      if (!absent) {
        lowerer.unsupported(
          "SC1090",
          call,
          "calls omitting a non-optional parameter of the callee's type",
        );
      }
      args.push(absent);
    }
    return {
      kind: "callValue",
      callee,
      receiver: lowerer.lowerExprExpecting(access.expression, DYN),
      args,
      type: found.field.type.ret,
      loc,
    };
  }
  if (found.method.member.body && hasStaticThis(found.method.member)) {
    const generic = (found.method.receiverInfo ??= {
      decl: found.method.member,
      baseName: access.name.text,
      qualifiedName: `%${found.declarer.def.name}.static:${access.name.text}`,
      typeParams: [],
      instances: new Map(),
      member: { cls: found.declarer, kind: "static" },
    });
    const instance = genericCallInstance(
      lowerer,
      call,
      staticMethodForReceiver(lowerer, access, generic, info, throughValue),
    );
    return {
      kind: "call",
      callee: instance.name,
      args: lowerer.completeArgs(call.arguments, instance.params, loc, call),
      type: instance.returnType,
      loc,
    };
  }
  const fnName = `%${found.declarer.def.name}.static:${access.name.text}`;
  lowerer.noteEdge(fnName);
  const args = lowerer.completeArgs(call.arguments, found.method.params, loc, call);
  return { kind: "call", callee: fnName, args, type: found.method.ret, loc };
}

function staticMethodForReceiver(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  method: GenericFnInfo,
  receiver: ClassInfo,
  throughValue: boolean,
): GenericFnInfo {
  if (!hasStaticThis(method.decl)) return method;
  // A private name in the inherited body belongs to the declaring class,
  // even when the receiver declares a different private with that spelling.
  // Do not resolve it by receiver name until the static ABI tracks the brand.
  if (method.member && method.member.cls !== receiver && hasLexicalPrivateReference(method.decl)) {
    lowerer.unsupported(
      "SC1090",
      access,
      "private member references in an inherited receiver-dependent static method",
    );
  }
  if (throughValue && !classValueIsExactlyOwn(lowerer, access.expression, receiver)) {
    lowerer.unsupported(
      "SC1090",
      access,
      "receiver-dependent static methods through a polymorphic class value",
    );
  }
  const instances = (method.receiverSpecializations ??= new Map());
  let specialized = instances.get(receiver.def.name);
  if (!specialized) {
    specialized = {
      ...method,
      qualifiedName: `${method.qualifiedName}%on.${receiver.def.name}`,
      instances: new Map(),
      staticReceiver: receiver,
      receiverSpecializations: new Map(),
    };
    instances.set(receiver.def.name, specialized);
  }
  return specialized;
}

/** Static member access through a class VALUE (`X.m` where X is
 * classval-typed): devirtualized — the member resolves against the
 * static class's chain, exact when no strict descendant redeclares it
 * (values in the slot never leave the subtree). `X.name` is the one
 * genuinely dynamic member: the class.name libCall reads the runtime
 * class object's stored name. Null when the receiver isn't a class
 * value or the member doesn't resolve. */
export function lowerClassValueProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const recvT = storedClassValueType(lowerer, expr.expression);
  if (recvT?.kind !== "classval") return null;
  const loc = locOf(expr);
  const member = expr.name.text;
  const info = lowerer.classes.get(recvT.className);
  if (
    info &&
    ((hasRuntimeStatics(info) && !findStaticOn(lowerer, info, member)?.field) ||
      (info.callableBase && !findStaticOn(lowerer, info, member)))
  )
    return {
      kind: "dynKeyGet",
      value: lowerer.lowerExprExpecting(expr.expression, DYN),
      key: { kind: "strLit", value: member, type: STRING, loc },
      type: DYN,
      loc,
    };
  // `X.name` reads the RUNTIME class object's stored name — the one
  // genuinely dynamic member. It CONSUMES the receiver (no evaluation
  // is discarded), so any receiver expression is fine here.
  if (member === "name") {
    const recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind !== "classval") return null;
    return { kind: "libCall", fn: "class.name", args: [recv], type: STRING, loc };
  }
  if (!info) return null;
  if (
    !ts.isIdentifier(expr.expression) &&
    expr.expression.kind !== ts.SyntaxKind.ThisKeyword &&
    // `module.exports.label` in a class-replaced CJS module: the
    // receiver is the exact exported class, and the read is
    // side-effect-free — as bindable as an identifier.
    !(isModuleExportsAccess(expr.expression) && isCjsJsFile(expr.getSourceFile(), lowerer.program))
  ) {
    // Devirtualized reads DISCARD the receiver value, so only
    // side-effect-free receivers are claimed (the instanceOf fold
    // rule); computed ones meet the pointed fence with a bindable fix.
    lowerer.unsupported(
      "SC1090",
      expr,
      "static member access through a computed class-value expression (bind the class value to a variable first)",
    );
  }
  // The direct class-name spelling resolved in lowerStaticFieldRead;
  // reaching here means the receiver is a classval-typed BINDING.
  const found = findStaticOn(lowerer, info, member);
  if (!found) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `the static member '${member}' of class '${info.def.name.replace(/^%|^%m\d+\./, "")}' (static accessors and initializer-less static fields have no lowering, and Function members like .call/.bind/.prototype have no value form)`,
    );
  }
  // #private statics read through a class VALUE exactly when the value
  // can only BE the declaring class (classValueIsExactlyOwn — a const
  // bound to the class expression / class name, or a leaf class): a
  // slot that could hold a descendant at runtime fences, since JS
  // brands the declaring class object alone (Node's TypeError on any
  // other receiver). The direct class-name spelling resolved in
  // lowerStaticFieldRead, so a private reaching here is a
  // classval-typed binding.
  if (member.startsWith("#")) {
    if (!classValueIsExactlyOwn(lowerer, expr.expression, info)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `reading the private static '${member}' through a class value (JS brands the declaring class object alone — spell the declaring class's name)`,
      );
    }
    if (found.declarer !== info) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `reading the private static '${member}' through the subclass '${info.def.name.replace(/^%|^%m\d+\./, "")}' (JS brands the declaring class object alone — Node throws a TypeError here; spell the declaring class's name)`,
      );
    }
  }
  if (staticShadowBelow(info, member)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `reading the static member '${member}' through a class value (a subclass of '${info.def.name.replace(/^%|^%m\d+\./, "")}' redeclares it, so the runtime class decides which declaration answers)`,
    );
  }
  if (found.field !== undefined) {
    return lowerer.maybeNarrow(
      { kind: "varRef", localId: found.field.globalId, type: found.field.type, loc },
      expr,
    );
  }
  return staticMethodValue(lowerer, found.declarer, member, found.method, expr, loc);
}

/** An abstract method's signature — lambdaSignature minus the body check
 * (an abstract declaration IS exactly a signature; tsc rejects the
 * async/generator/generic-with-body combinations before this runs, and
 * the generic case fences at the caller). */
function abstractMemberSignature(
  lowerer: Lowerer,
  member: ts.MethodDeclaration,
): { shapes: ParamShape[]; ret: IrType } {
  for (const param of member.parameters) {
    if (!ts.isIdentifier(param.name)) lowerer.unsupported("SC1031", param);
  }
  return {
    shapes: lowerer.paramShapes(member.parameters),
    ret: lowerer.declaredReturnType(member, member.name),
  };
}

/** The nearest declaration of `name` at or above `info` — the method a
 * receiver of that static class runs when nothing below overrides it. */
export function findMethodOn(
  lowerer: Lowerer,
  info: ClassInfo | null,
  name: string,
): {
  declarer: ClassInfo;
  sig: {
    params: ParamShape[];
    ret: IrType;
    abstract?: true;
    async?: true;
    gen?: NonNullable<IrFunction["generator"]>;
  };
} | null {
  for (let c = info; c; c = c.base) {
    const sig = c.methods.get(name);
    if (sig) return { declarer: c, sig };
  }
  return null;
}

/** True when `sub` is a STRICT descendant of `sup` in the class graph. */
export function isSubclassOf(lowerer: Lowerer, sub: string, sup: string): boolean {
  if (sub === sup) return false;
  for (let c = lowerer.classes.get(sub); c; c = c.base ?? undefined) {
    if (c.def.name === sup && c.def.name !== sub) return true;
    for (let family = c.genericInstance?.family; family; family = family.base ?? undefined) {
      if (family.def.name === sup) return true;
    }
  }
  return false;
}

/** In an extends-hierarchy (as base or derived): the class carries a
 * vtable and participates in dynamic instanceof; standalone classes keep
 * their exact pre-inheritance layout and behavior. */
export function inHierarchy(lowerer: Lowerer, info: ClassInfo): boolean {
  // The runtime emitter class is ALWAYS a hierarchy member: ScrEmitter
  // carries its vtable word whether or not the program subclasses it
  // (the runtime allocates bare instances with scr_emitter_vt).
  return info.base !== null || info.subclasses.length > 0 || info.builtinEmitter === true;
}

/** True when some STRICT descendant of `info` declares `name` with a BODY
 * — the whole-program devirtualization test: a call through this static
 * class can reach a distinct implementation, so it must dispatch
 * dynamically. Abstract re-declarations don't count (they carry no
 * implementation; the concrete ones below them do, via the recursion). */
export function overrideBelow(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  return info.subclasses.some((s) => {
    const m = s.methods.get(name);
    return (m !== undefined && m.abstract !== true) || lowerer.overrideBelow(s, name);
  });
}

/** The nearest GENERIC-method declaration of `name` at/above `info` —
 * findMethodOn's twin over the genericMethods tables. */
export function findGenericMethodOn(
  lowerer: Lowerer,
  info: ClassInfo | null,
  name: string,
): { declarer: ClassInfo; info: GenericFnInfo } | null {
  for (let c = info; c; c = c.base) {
    const gm = c.genericMethods?.get(name);
    if (gm) return { declarer: c, info: gm };
  }
  return null;
}

/** True when some STRICT descendant of `info` re-declares the generic
 * method `name` — overrideBelow's twin: generic methods have no vtable
 * slot, so a call that could reach an override compiles only when the
 * receiver's runtime class is statically exact. */
export function genericOverrideBelow(info: ClassInfo, name: string): boolean {
  return info.subclasses.some(
    (s) => s.genericMethods?.has(name) === true || genericOverrideBelow(s, name),
  );
}

/** Discover inherited data writes before any base storage ABI is chosen.
 * The checker does not widen a base field for assignments in JS subclasses. */
export function collectInheritedJsFieldWrites(
  lowerer: Lowerer,
  files: readonly ts.SourceFile[],
): void {
  for (const file of files) {
    if (!isJsSourceFile(file)) continue;
    ts.walkPreorder(file, (node) => {
      if (
        (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) ||
        !node.heritageClauses?.length
      )
        return;
      const writes = new Map<string, ts.Expression[]>();
      const addWrite = (name: string, expression: ts.Expression): void => {
        const existing = writes.get(name);
        if (existing) existing.push(expression);
        else writes.set(name, [expression]);
      };
      const scan = (part: ts.Node): void => {
        if (
          ts.isClassDeclaration(part) ||
          ts.isClassExpression(part) ||
          (ts.isFunctionLike(part) && !ts.isArrowFunction(part))
        )
          return;
        if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = part.left;
          if (
            ts.isPropertyAccessExpression(left) &&
            left.expression.kind === ts.SyntaxKind.ThisKeyword
          )
            addWrite(left.name.text, part.right);
          else if (
            ts.isElementAccessExpression(left) &&
            left.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const name = lowerer.foldedStringKeyOf(left.argumentExpression);
            if (name !== null) addWrite(name, part.right);
          }
        }
        part.forEachChild(scan);
      };
      for (const member of node.members) {
        if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
          continue;
        if (ts.isPropertyDeclaration(member) && member.initializer) {
          const name = ts.isPrivateIdentifier(member.name)
            ? null
            : classMemberNameOf(lowerer, member.name);
          if (name !== null) addWrite(name, member.initializer);
          scan(member.initializer);
        }
        if (
          ts.isConstructorDeclaration(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isAccessor(member)
        ) {
          if (member.body) scan(member.body);
        }
      }
      if (writes.size === 0) return;
      const symbol = lowerer.typeOf(node).getSymbol();
      const instance = symbol ? lowerer.checker.getDeclaredTypeOfSymbol(symbol) : null;
      const seen = new Set<ts.Type>();
      const markBases = (type: ts.Type): void => {
        const target = type.isTypeReference() ? type.getTarget() : type;
        if (!target?.isClassOrInterface() || seen.has(target)) return;
        seen.add(target);
        for (const base of lowerer.checker.getBaseTypes(target)) {
          for (const [name, expressions] of writes) {
            const property = lowerer.checker.getPropertyOfType(base, name);
            for (const declaration of property ? lowerer.checker.declarationsOf(property) : []) {
              if (ts.isMethodDeclaration(declaration) || ts.isAccessor(declaration)) continue;
              let owner: ts.Node | undefined = declaration.parent;
              while (owner && !ts.isClassDeclaration(owner) && !ts.isClassExpression(owner))
                owner = owner.parent;
              if (
                !owner ||
                (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) ||
                !isJsSourceFile(owner.getSourceFile())
              )
                continue;
              let fields = lowerer.inheritedJsFieldWrites.get(owner);
              if (!fields) lowerer.inheritedJsFieldWrites.set(owner, (fields = new Map()));
              const existing = fields.get(name);
              if (existing) existing.push(...expressions);
              else fields.set(name, [...expressions]);
            }
          }
          markBases(base);
        }
      };
      if (instance) markBases(instance);
    });
  }
}

/** Discover overrides before choosing inferred method ABIs. Class collection
 * visits bases first, including imported bases and class expressions, so the
 * collected subclass graph cannot answer this question yet. The checker
 * hierarchy identifies the original declarations through aliases as well. */
export function collectVirtualJsMethods(lowerer: Lowerer, files: readonly ts.SourceFile[]): void {
  const families: [ts.MethodDeclaration, ts.MethodDeclaration][] = [];
  // Record named prototype accesses before collecting method signatures.
  // Those slots need a callable ABI even when JavaScript would otherwise
  // specialize each call independently.
  for (const file of files)
    ts.walkPreorder(file, (node) => {
      if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      if (name === null) return;
      const prototype =
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prototype";
      const assigned =
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      const symbol = !assigned
        ? undefined
        : ts.isPropertyAccessExpression(node)
          ? lowerer.checker.getSymbolAtLocation(node.name)
          : lowerer.checker.getPropertyOfType(lowerer.typeOf(node.expression), name);
      if (
        prototype ||
        (symbol && lowerer.checker.declarationsOf(symbol).some(ts.isMethodDeclaration))
      ) {
        lowerer.prototypeMethodAccesses.set(name, node);
      }
    });
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const accessors = node.members.filter(
        (member): member is ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
          (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
          ts.isIdentifier(member.name) &&
          !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
      );
      if (
        node.heritageClauses?.length &&
        accessors.length &&
        isJsSourceFile(node.getSourceFile())
      ) {
        const symbol = lowerer.typeOf(node).getSymbol();
        const instance = symbol ? lowerer.checker.getDeclaredTypeOfSymbol(symbol) : null;
        const seen = new Set<ts.Type>();
        const markAccessors = (type: ts.Type): void => {
          const target = type.isTypeReference() ? type.getTarget() : type;
          if (!target?.isClassOrInterface() || seen.has(target)) return;
          seen.add(target);
          for (const base of lowerer.checker.getBaseTypes(target)) {
            for (const member of accessors) {
              if (!ts.isIdentifier(member.name)) continue;
              const property = lowerer.checker.getPropertyOfType(base, member.name.text);
              for (const declaration of property ? lowerer.checker.declarationsOf(property) : []) {
                if (
                  (ts.isGetAccessorDeclaration(declaration) ||
                    ts.isSetAccessorDeclaration(declaration)) &&
                  isJsSourceFile(declaration.getSourceFile())
                ) {
                  lowerer.checkedVirtualJsAccessors.add(declaration);
                  lowerer.checkedVirtualJsAccessors.add(member);
                  for (const twin of node.members)
                    if (
                      (ts.isGetAccessorDeclaration(twin) || ts.isSetAccessorDeclaration(twin)) &&
                      ts.isIdentifier(twin.name) &&
                      twin.name.text === member.name.text
                    )
                      lowerer.checkedVirtualJsAccessors.add(twin);
                }
              }
            }
            markAccessors(base);
          }
        };
        if (instance) markAccessors(instance);
      }
      const members = node.members.filter(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
      );
      if (node.heritageClauses?.length && members.length > 0) {
        const symbol = lowerer.typeOf(node).getSymbol();
        const instance = symbol ? lowerer.checker.getDeclaredTypeOfSymbol(symbol) : null;
        const seen = new Set<ts.Type>();
        const markBases = (type: ts.Type): void => {
          const target = type.isTypeReference() ? type.getTarget() : type;
          if (target === undefined || !target.isClassOrInterface() || seen.has(target)) return;
          seen.add(target);
          for (const base of lowerer.checker.getBaseTypes(target)) {
            for (const member of members) {
              if (!ts.isIdentifier(member.name)) continue;
              const property = lowerer.checker.getPropertyOfType(base, member.name.text);
              for (const declaration of property ? lowerer.checker.declarationsOf(property) : []) {
                if (
                  ts.isMethodDeclaration(declaration) &&
                  isJsSourceFile(declaration.getSourceFile())
                ) {
                  lowerer.virtualJsMethods.add(declaration);
                  if (
                    isJsSourceFile(member.getSourceFile()) &&
                    !member.typeParameters &&
                    !member.asteriskToken &&
                    !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
                    !bodyReadsArguments(member) &&
                    member.parameters.every((p) => !p.dotDotDotToken)
                  ) {
                    lowerer.virtualJsMethodArity.set(
                      declaration,
                      Math.max(
                        lowerer.virtualJsMethodArity.get(declaration) ?? 0,
                        member.parameters.length,
                      ),
                    );
                    const checked =
                      !declaration.typeParameters &&
                      !declaration.asteriskToken &&
                      !declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
                      !bodyReadsArguments(declaration) &&
                      [...member.parameters, ...declaration.parameters].every(
                        (p) => !p.dotDotDotToken,
                      );
                    if (checked) {
                      lowerer.checkedVirtualJsMethods.add(declaration);
                      lowerer.checkedVirtualJsMethods.add(member);
                      families.push([declaration, member]);
                    }
                  }
                }
              }
            }
            markBases(base);
          }
        };
        if (instance) markBases(instance);
      }
    }
  };
  for (const file of files) ts.walkPreorder(file, visit);
  for (const member of lowerer.checkedVirtualJsMethods) {
    const scan = (node: ts.Node): void => {
      if (node !== member && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression)
        lowerer.checkedVirtualJsValueReturns.add(member);
      node.forEachChild(scan);
    };
    scan(member);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [base, derived] of families) {
      if (
        !lowerer.checkedVirtualJsValueReturns.has(base) &&
        !lowerer.checkedVirtualJsValueReturns.has(derived)
      )
        continue;
      for (const member of [base, derived])
        if (!lowerer.checkedVirtualJsValueReturns.has(member)) {
          lowerer.checkedVirtualJsValueReturns.add(member);
          changed = true;
        }
    }
  }
}

/** The receiver's EXACT runtime class, when the expression proves it: a
 * `new C(...)` expression directly, or a const binding initialized with
 * one (the binding can never be reassigned to a subclass instance).
 * The class is read off the mapped INITIALIZER type — a `const b: Base =
 * new D()` receiver is exactly D, not its annotation. Distinct from
 * exactClassOfReceiver, which answers for CLASS-VALUE receivers. */
export function exactInstanceClassOf(lowerer: Lowerer, expr: ts.Expression): ClassInfo | null {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const classOfNew = (n: ts.Expression): ClassInfo | null => {
    if (!ts.isNewExpression(n)) return null;
    const t = lowerer.mapTypeOf(lowerer.typeOf(n));
    return t?.kind === "object" ? (lowerer.classes.get(t.className) ?? null) : null;
  };
  const direct = classOfNew(e);
  if (direct) return direct;
  if (!ts.isIdentifier(e)) return null;
  const symbol = lowerer.resolveValueSymbol(e);
  const decl = symbol ? lowerer.checker.valueDeclarationOf(symbol) : undefined;
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  return classOfNew(init);
}

/** `const r: Repo = new MemRepo()` where EVERY member of the annotation's
 * checker type is a generic-callable method (`interface Repo { get<T>(id:
 * string): T }`): the record shape maps EMPTY — generic members are
 * excluded (no closure slot can hold a generic function) — so the
 * copy-reshape width coercion would DROP the exact class the method
 * calls monomorphize against, and in JS the binding IS the instance (no
 * copy exists). The binding keeps the initializer's class
 * representation instead: generic-method calls resolve like class-typed
 * receivers (exactInstanceClassOf reads the same const+new discipline),
 * and uses that want the empty record width-coerce at the use site.
 * Const + direct `new` only — a reassignable binding or a produced
 * value keeps today's record story and its fences. */
export function genericIfaceBindingKeepsClass(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  declaredType: IrType,
): boolean {
  if (declaredType.kind !== "record" && declaredType.kind !== "dyn") return false;
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined || decl.type === undefined)
    return false;
  if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return false;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isNewExpression(init)) return false;
  const annT = lowerer.typeOf(decl.name);
  const props = lowerer.checker.getPropertiesOfType(annT);
  if (props.length === 0) return false;
  if (declaredType.kind === "dyn")
    return (
      lowerer.classImplementedProtocol(annT) &&
      props.some((property) =>
        isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(property), lowerer.checker),
      )
    );
  const shape = lowerer.shapes.get(declaredType.shapeId);
  if (!shape || shape.fields.length > 0 || shape.indexValue !== undefined || shape.tuple === true)
    return false;
  return props.every((p) =>
    isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(p), lowerer.checker),
  );
}

/** `recv.m<T>(args)` — a GENERIC method call, dispatched STATICALLY: the
 * checker's resolved signature (type arguments substituted, inferred or
 * explicit) keys one instantiation of the nearest declarer's body, and
 * the call is a direct `call` of `%C.m%n` over the (up/down)cast
 * receiver. No per-instantiation vtable slots exist, so a receiver whose
 * runtime class could OVERRIDE the method (genericOverrideBelow) must be
 * statically exact (exactInstanceClassOf) — the override set then
 * resolves at compile time — or fences by name. */
export function lowerClassGenericMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recvInfo: ClassInfo,
  found: { declarer: ClassInfo; info: GenericFnInfo },
  recvIr?: IrExpr,
): IrExpr {
  const name = access.name.text;
  let { declarer, info } = found;
  if (genericOverrideBelow(recvInfo, name)) {
    const exact = exactInstanceClassOf(lowerer, access.expression);
    const refound = exact ? findGenericMethodOn(lowerer, exact, name) : null;
    if (!refound) {
      lowerer.unsupported(
        "SC1090",
        call,
        `calling the generic method '${name}' through a receiver whose runtime class may override it (a subclass of '${recvInfo.def.name.replace(/^%|^%m\d+\./, "")}' redeclares it and generic methods dispatch statically — bind the receiver to a const initialized with its 'new' expression)`,
      );
    }
    ({ declarer, info } = refound);
  }
  // Implicit-any methods instantiate over the call's ARGUMENT types
  // (there is no resolved generic signature — the untyped params are the
  // type parameters); everything else about the dispatch — static
  // resolution, the exactness rule above — is the generic story.
  const instance = info.implicitParams
    ? implicitCallInstance(lowerer, call, info)
    : genericCallInstance(lowerer, call, info);
  const receiver = recvIr ?? lowerer.lowerExpr(access.expression);
  const loc = locOf(call);
  // The declarer sits at/above the receiver's static class on the plain
  // path; the EXACT path can land below it (a base-typed const provably
  // holding the subclass) — that direction is the checker-grade downcast
  // (the exactness proof is static, stronger than an instanceof guard).
  const thisArg =
    receiver.type.kind === "object" &&
    isSubclassOf(lowerer, declarer.def.name, receiver.type.className)
      ? {
          kind: "downcast" as const,
          value: receiver,
          type: { kind: "object" as const, className: declarer.def.name },
          loc,
        }
      : upcastTo(lowerer, receiver, declarer.def.name);
  const args = lowerer.completeArgs(call.arguments, instance.params, loc, call);
  return {
    kind: "call",
    callee: instance.name,
    args: [thisArg, ...args],
    type: instance.returnType,
    loc,
  };
}

/** Wraps a derived-class expression in an upcast when the target base
 * class differs (a no-op reinterpret at runtime; keeps IR types exact). */
export function upcastTo(lowerer: Lowerer, expr: IrExpr, className: string): IrExpr {
  if (expr.type.kind === "object" && expr.type.className !== className) {
    return { kind: "upcast", value: expr, type: { kind: "object", className }, loc: expr.loc };
  }
  return expr;
}

/** Constructor and methods become module functions `%C.name` whose first
 * param is `this`. Field initializers run in declaration order at the top
 * of a base class's constructor; a derived class's run right after its
 * super() call returns (tsc/JS initialization order). Reachability gates
 * each member independently: an unreached method body never lowers and
 * never emits (pinned by the corpus), while every override a reachable
 * virtualCall can dispatch to was marked by the discovery pass. */
/** True when a MIXIN class's constructor is the pure forwarding shape:
 * exactly one rest parameter, `super(...args)` as the first statement,
 * and no other reference to the parameter — the one rest-constructor
 * form with an exact static story under monomorphization (the
 * instantiation adopts the base's ABI; see collectClassShapeInner). */
function mixinForwardingCtor(lowerer: Lowerer, ctor: ts.ConstructorDeclaration): boolean {
  if (ctor.parameters.length !== 1 || !ctor.body) return false;
  const p = ctor.parameters[0]!;
  if (!p.dotDotDotToken || !ts.isIdentifier(p.name)) return false;
  const paramName = p.name;
  const paramSym = lowerer.checker.getSymbolAtLocation(paramName);
  if (!paramSym) return false;
  const first = ctor.body.statements[0];
  if (!first || !ts.isExpressionStatement(first) || !ts.isCallExpression(first.expression))
    return false;
  const call = first.expression;
  if (call.expression.kind !== ts.SyntaxKind.SuperKeyword) return false;
  if (call.arguments.length !== 1) return false;
  const a = call.arguments[0]!;
  if (!ts.isSpreadElement(a) || !ts.isIdentifier(a.expression)) return false;
  const spreadIdent = a.expression;
  if (lowerer.checker.getSymbolAtLocation(spreadIdent) !== paramSym) return false;
  let extraRef = false;
  ts.walkPreorder(ctor.body, (n) => {
    if (n === spreadIdent) return undefined;
    if (
      ts.isIdentifier(n) &&
      n.text === paramName.text &&
      lowerer.checker.getSymbolAtLocation(n) === paramSym
    ) {
      extraRef = true;
      return "stop";
    }
    return undefined;
  });
  return !extraRef;
}

export function lowerClassMembers(lowerer: Lowerer, info: ClassInfo): IrFunction[] {
  // Local class bodies are lowered when their expression captures its
  // lexical environment. Type collection alone can discover a class in
  // an owner skipped by the coverage remainder; it must not relower the
  // constructor without that environment.
  if (info.localClass && info.localClass.context === null) {
    return [...info.localClass.bodies.values()];
  }
  const out: IrFunction[] = [];
  const className = info.def.name;
  // Generic-class INSTANTIATIONS (and mixin instantiations) are
  // demand-driven like generic-fn instances, not reachability units:
  // they are never registered as units, so wantBody's name-keyed gate
  // cannot apply — every member of a demanded instantiation lowers.
  const always =
    info.genericInstance !== undefined ||
    info.mixinInstance !== undefined ||
    info.localClass !== undefined;
  // A FAMILY has no constructor function at all (nothing constructs it;
  // construction resolves to instantiations) and declares no instance
  // members — only its statics lower below.
  // A poison OUTSIDE the per-statement catches (a fenced parameter
  // default — declareParams lowers it before any statement-level catch
  // exists): the diagnostic is recorded — the member skips like a
  // signature-blocked function (lowerStaticMethod's rule) instead of
  // crashing the whole lowering.
  if (!info.generic && (always || lowerer.wantBody(`%${className}.constructor`))) {
    const diagsBefore = lowerer.diags.length;
    try {
      out.push(lowerer.lowerClassCtor(info));
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      if (info.decl && isJsSourceFile(info.decl.getSourceFile())) {
        const types: IrType[] = [
          { kind: "object", className },
          ...info.ctorParams.map((param) => param.type),
        ];
        const fallback = lowerer.deferToRuntimeFence(diagsBefore, info.ctor ?? info.decl, {
          kind: "function",
          name: `%${className}.constructor`,
          returnType: VOID,
          params: types.map((type, index) => ({
            localId: `p.${index}`,
            name: index === 0 ? "this" : `p${index}`,
            type,
          })),
        });
        if (fallback) out.push(fallback);
      }
    }
  }
  for (const { mName, member } of lowerer.classMethodMembers(info)) {
    if (!always && !lowerer.wantBody(`%${className}.${mName}`)) continue;
    try {
      const fn = lowerer.lowerClassMethodMember(info, member);
      if (fn) out.push(fn);
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
    }
  }
  if (info.staticMethods)
    for (const [name] of info.staticMethods) {
      if (!lowerer.wantBody(`%${className}.static:${name}`)) continue;
      const fn = lowerStaticMethod(lowerer, info, name);
      if (fn) out.push(fn);
    }
  for (const prop of info.throwingSetters) {
    if (always || lowerer.wantBody(`%${className}.set:${prop}`))
      out.push(lowerer.throwingSetterFn(info, prop));
  }
  return out;
}

/** The constructor function `%C.constructor`. Synthesized when absent: a
 * base class runs just its field initializers; a derived class inherits
 * the base's signature — forward every param to super(), then run own
 * field initializers. */
export function lowerClassCtor(lowerer: Lowerer, info: ClassInfo): IrFunction {
  const cached = info.localClass?.bodies.get(`%${info.def.name}.constructor`);
  if (cached) return cached;
  return withInstanceBindings(lowerer, info, () => lowerClassCtorInner(lowerer, info));
}

function classCaptureParams(info: ClassInfo, context: FnCtx): Pick<IrFunction, "classCaptures"> {
  if (!info.localClass) return {};
  const environment = info.localClass.context;
  if (!environment)
    throw new InternalCompilerError("local class lowered outside its lexical environment");
  return {
    classCaptures: (context.captures ?? []).map((capture, index) => {
      if (!capture) throw new InternalCompilerError("missing local class capture");
      return {
        ...capture,
        slot: environment.captures!.findIndex(
          (entry) => entry.localId === context.captureSources[index],
        ),
      };
    }),
  };
}

function lowerClassCtorInner(lowerer: Lowerer, info: ClassInfo): IrFunction {
  const className = info.def.name;
  const thisType: IrType = { kind: "object", className };
  const prevClass = lowerer.currentClass;
  lowerer.currentClass = info;
  lowerer.fnStack.push(newFnCtx(info.localClass !== undefined, null, null, VOID));
  try {
    const thisLocal = lowerer.declareThis(thisType);
    const params: IrParam[] = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const body: IrStmt[] = [];
    // The construction-relevant base: generic families are transparent
    // (an instantiation of a base-less generic class IS a base class —
    // its source has no super()).
    const ctorBase = superBaseOf(info);
    if (info.ctor && info.mixinInstance?.forwardingCtor) {
      // The mixin FORWARDING constructor: the declared rest parameter
      // never materializes — the ABI is the base's (synthetic params,
      // the synthesized-ctor rule), `super(...args)` forwards them
      // unchanged, and the remaining statements lower normally.
      const loc = locOf(info.ctor);
      const forward: IrExpr[] = info.ctorParams.map((shape, i) => {
        const local: IrLocal = {
          id: `arg${i}.0`,
          name: `arg${i}`,
          type: shape.type,
          mutable: false,
        };
        lowerer.ctx.locals.push(local);
        params.push({ localId: local.id, name: local.name, type: shape.type });
        return { kind: "varRef", localId: local.id, type: shape.type, loc };
      });
      body.push(...lowerer.lowerDerivedCtorBody(info, thisLocal, forward));
    } else if (info.ctor) {
      // The default-param prologue runs FIRST — before field initializers
      // and (in a derived class) before super(): JS evaluates parameter
      // defaults on entry, ahead of everything the body does.
      const declared = lowerer.declareParams(info.ctor.parameters, info.ctorParams);
      params.push(...declared.params);
      if (info.ctorParams.at(-1)?.mode === "arguments") {
        const local = lowerer.declareHiddenLocal("%arguments", DYN);
        params.push({ localId: local.id, name: local.name, type: DYN });
        lowerer.ctx.argumentsLocal = local;
      }
      body.push(...declared.prologue);
      if (!ctorBase && !info.callableBase) {
        // Node's base-class order: field initializers run at the start
        // of construction, the parameter-property assignments open the
        // constructor body (probed — a field initializer reading a
        // parameter property sees undefined).
        body.push(...lowerer.fieldInitStmts(info, thisLocal));
        body.push(...paramPropInitStmts(lowerer, info, thisLocal));
        if (info.ctor.body) body.push(...lowerer.lowerStmts(info.ctor.body.statements));
      } else if (info.ctor.body) {
        body.push(...lowerer.lowerDerivedCtorBody(info, thisLocal));
      }
    } else {
      if (ctorBase || info.callableBase) {
        // Synthetic forwarding params (the inherited ABI signature).
        // Nothing references them by symbol — only the super call below,
        // which forwards the already-completed values UNCHANGED (defaults
        // apply in the base constructor's own prologue, never twice).
        const loc = locOf(info.decl!);
        const superArgs: IrExpr[] = info.ctorParams.map((shape, i) => {
          const local: IrLocal = {
            id: `arg${i}.0`,
            name: `arg${i}`,
            type: shape.type,
            mutable: false,
          };
          lowerer.ctx.locals.push(local);
          params.push({ localId: local.id, name: local.name, type: shape.type });
          return { kind: "varRef", localId: local.id, type: shape.type, loc };
        });
        try {
          body.push(lowerer.superCallStmt(info, thisLocal, superArgs, loc));
        } catch (e) {
          // A synthesized super() can fence (a stream base whose
          // underscore methods have no lowering): the diagnostic was
          // pushed; the half-initialized ctor stays out of the body.
          if (!(e instanceof PoisonError)) throw e;
        }
      }
      body.push(...lowerer.fieldInitStmts(info, thisLocal));
    }
    return {
      name: `%${className}.constructor`,
      params,
      returnType: VOID,
      locals: lowerer.ctx.locals,
      ...classCaptureParams(info, lowerer.ctx),
      body,
      loc: locOf(info.ctor ?? info.decl!),
    };
  } finally {
    lowerer.fnStack.pop();
    lowerer.currentClass = prevClass;
  }
}

/** The lowered method-map name of a class member: identifier text, a
 * COMPUTED name that folds to one compile-time string
 * (foldedStringKeyOf — the object-literal computed-key machinery
 * applied to method positions; tsc late-bound the member under exactly
 * that name), or a reserved `sym:*` slot for the well-known symbols the
 * compiler consumes as language protocols (iterator and explicit
 * resource management). These names are unspellable as user identifiers,
 * like the accessor `get:x` convention. Null for genuinely
 * runtime-keyed names — the computed-member fences stay. */
export function classMemberNameOf(lowerer: Lowerer, name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  // #private methods key by their spelled name ('#m') — '#' is
  // unspellable in public identifiers, the accessor-colon precedent.
  if (ts.isPrivateIdentifier(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return null;
  let e = name.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) {
    const member = lowerer.stdlibGlobalMember(e, "Symbol");
    if (
      member === "iterator" ||
      member === "asyncIterator" ||
      member === "dispose" ||
      member === "asyncDispose"
    ) {
      return `sym:${member}`;
    }
  }
  return (
    classSymbolKeyOf(lowerer, name.expression)?.fieldName ??
    lowerer.foldedStringKeyOf(name.expression)
  );
}

/** A class type's ITERATOR PROTOCOL shape, statically resolved: the
 * receiver declares (or inherits) `[Symbol.iterator]()` (the
 * "sym:iterator" method slot) returning a class whose zero-parameter
 * `next()` returns a record with a `value` field and an optional
 * boolean `done` field (`{ value, done: false }` — the self-iterator
 * idiom returns `this`, so the iterator class is usually the receiver
 * itself). A MISSING done field never terminates — exactly JS, where
 * `undefined` is falsy forever (Node loops forever too; corpus
 * iterators of that shape are deliberately infinite). Iterator classes
 * declaring `return`/`throw` members stay out — the desugars below
 * never call IteratorClose, and silently skipping a declared return()
 * would drop user cleanup. Null when the shape doesn't hold — callers
 * keep their fences. */
export interface ClassIteratorInfo {
  /** The `[Symbol.iterator]()` call's receiver class + its declarer. */
  className: string;
  /** The iterator object's type (the method's return). */
  iterT: IrType & { kind: "object" };
  /** next()'s result record type. */
  resultT: IrType & { kind: "record" };
  valueT: IrType;
  /** False: no done field — the protocol never terminates. */
  hasDone: boolean;
}
export function classIteratorOf(lowerer: Lowerer, t: IrType): ClassIteratorInfo | null {
  if (t.kind !== "object") return null;
  const info = lowerer.classes.get(t.className);
  if (!info) return null;
  const iter = findMethodOn(lowerer, info, "sym:iterator");
  if (!iter || iter.sig.params.length !== 0 || iter.sig.abstract === true) return null;
  const iterT = iter.sig.ret;
  if (iterT.kind !== "object") return null;
  const itInfo = lowerer.classes.get(iterT.className);
  if (!itInfo) return null;
  // IteratorClose honesty: a declared return()/throw() would be called
  // by JS on abrupt completion; these desugars never close.
  if (findMethodOn(lowerer, itInfo, "return") || findMethodOn(lowerer, itInfo, "throw"))
    return null;
  const next = findMethodOn(lowerer, itInfo, "next");
  if (!next || next.sig.params.length !== 0 || next.sig.abstract === true) return null;
  const resultT = next.sig.ret;
  if (resultT.kind !== "record") return null;
  const shape = lowerer.shapes.get(resultT.shapeId);
  const value = shape?.fields.find((f) => f.name === "value");
  if (!shape || !value) return null;
  const done = shape.fields.find((f) => f.name === "done");
  if (done && done.type.kind !== "bool") return null;
  return {
    className: t.className,
    iterT,
    resultT,
    valueT: value.type,
    hasDone: done !== undefined,
  };
}

/** The `it.next()` step of a class iterator as an ordinary (possibly
 * virtual) method call. */
export function classIteratorNextCall(
  lowerer: Lowerer,
  cit: ClassIteratorInfo,
  itRef: IrExpr,
  loc: SrcLoc,
): IrExpr {
  return accessorCall(lowerer, cit.iterT.className, "next", itRef, [], cit.resultT, loc);
}

/** `recv[Symbol.iterator]()` as an ordinary method call. */
export function classIteratorOpenCall(
  lowerer: Lowerer,
  cit: ClassIteratorInfo,
  recv: IrExpr,
  loc: SrcLoc,
): IrExpr {
  return accessorCall(lowerer, cit.className, "sym:iterator", recv, [], cit.iterT, loc);
}

/** `[...new C]` / `f(...new C)` over a CLASS ITERABLE: the eager drain —
 * an interned `%iter.drain.<n>(recv)` lifted function running the
 * whole protocol into a fresh element array (a doneless iterator loops
 * forever, exactly Node's spread of an infinite iterator). `elemT`
 * (default: the iterator's own value type) is the DESTINATION element —
 * a spread into a union-element literal (`[...numbers, ...symbols]` as
 * `(number | symbol)[]`) pushes each value wrapped into its arm. Null
 * when the value isn't a recognized class iterable or the element
 * doesn't coerce — spread fences stay. */
export function classIteratorDrainCall(
  lowerer: Lowerer,
  src: IrExpr,
  loc: SrcLoc,
  elemT?: IrType,
): IrExpr | null {
  const cit = classIteratorOf(lowerer, src.type);
  if (!cit) return null;
  const outElem = elemT ?? cit.valueT;
  // Probe the element coercion purely: identical types, or an arm of a
  // union destination (the wrap coerceToExpected applies below).
  if (!typeEquals(outElem, cit.valueT)) {
    if (outElem.kind !== "union" || lowerer.armTag(outElem.unionId, cit.valueT) < 0) return null;
  }
  const outT = arrayOf(outElem);
  const key = `${cit.className}:${typeKey(outElem)}`;
  let name = lowerer.iterDrainHelpers.get(key);
  if (!name) {
    name = `%iter.drain.${lowerer.iterDrainHelpers.size}`;
    lowerer.iterDrainHelpers.set(key, name);
    const recvT: IrType = { kind: "object", className: cit.className };
    const recvRef: IrExpr = { kind: "varRef", localId: "r.0", type: recvT, loc };
    const itRef: IrExpr = { kind: "varRef", localId: "it.0", type: cit.iterT, loc };
    const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: outT, loc };
    const resRef: IrExpr = { kind: "varRef", localId: "res.0", type: cit.resultT, loc };
    const valueRead: IrExpr = {
      kind: "recordGet",
      obj: resRef,
      shapeId: cit.resultT.shapeId,
      field: "value",
      type: cit.valueT,
      loc,
    };
    const loop: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "res.0",
        init: classIteratorNextCall(lowerer, cit, itRef, loc),
        loc,
      },
      ...(cit.hasDone
        ? [
            {
              kind: "if",
              cond: {
                kind: "recordGet",
                obj: resRef,
                shapeId: cit.resultT.shapeId,
                field: "done",
                type: BOOL,
                loc,
              },
              then: [{ kind: "return", value: outRef, loc }],
              else_: null,
              loc,
            } satisfies IrStmt,
          ]
        : []),
      {
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "push",
          receiver: outRef,
          args: [lowerer.coerceToExpected(valueRead, outElem)],
          type: F64,
          loc,
        },
        loc,
      },
    ];
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: recvT }],
      returnType: outT,
      locals: [
        { id: "r.0", name: "r", type: recvT, mutable: false },
        { id: "it.0", name: "it", type: cit.iterT, mutable: false },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "res.0", name: "res", type: cit.resultT, mutable: true },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: outT, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: "it.0",
          init: classIteratorOpenCall(lowerer, cit, recvRef, loc),
          loc,
        },
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: loop,
          loc,
        },
        // Doneless iterators never leave the loop; satisfies the
        // all-paths-return rule (the retag-helper convention).
        {
          kind: "throw",
          value: {
            kind: "strLit",
            value: "scriptc: internal error: iterator drain fell through",
            type: STRING,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [src], type: outT, loc };
}

/** The tail of a class iterable's protocol from an already-open ITERATOR
 * object (`var [a, ...rest] = new C` — the rest element drains whatever
 * next() still yields): the drain loop keyed by the iterator class. */
export function classIteratorRestDrainCall(
  lowerer: Lowerer,
  cit: ClassIteratorInfo,
  itVal: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const outT = arrayOf(cit.valueT);
  const key = `it:${cit.iterT.className}`;
  let name = lowerer.iterDrainHelpers.get(key);
  if (!name) {
    name = `%iter.drain.${lowerer.iterDrainHelpers.size}`;
    lowerer.iterDrainHelpers.set(key, name);
    const itRef: IrExpr = { kind: "varRef", localId: "it.0", type: cit.iterT, loc };
    const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: outT, loc };
    const resRef: IrExpr = { kind: "varRef", localId: "res.0", type: cit.resultT, loc };
    const loop: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "res.0",
        init: classIteratorNextCall(lowerer, cit, itRef, loc),
        loc,
      },
      ...(cit.hasDone
        ? [
            {
              kind: "if",
              cond: {
                kind: "recordGet",
                obj: resRef,
                shapeId: cit.resultT.shapeId,
                field: "done",
                type: BOOL,
                loc,
              },
              then: [{ kind: "return", value: outRef, loc }],
              else_: null,
              loc,
            } satisfies IrStmt,
          ]
        : []),
      {
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "push",
          receiver: outRef,
          args: [
            {
              kind: "recordGet",
              obj: resRef,
              shapeId: cit.resultT.shapeId,
              field: "value",
              type: cit.valueT,
              loc,
            },
          ],
          type: F64,
          loc,
        },
        loc,
      },
    ];
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "it.0", name: "it", type: cit.iterT }],
      returnType: outT,
      locals: [
        { id: "it.0", name: "it", type: cit.iterT, mutable: false },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "res.0", name: "res", type: cit.resultT, mutable: true },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: outT, loc },
          loc,
        },
        { kind: "while", cond: { kind: "boolLit", value: true, type: BOOL, loc }, body: loop, loc },
        {
          kind: "throw",
          value: {
            kind: "strLit",
            value: "scriptc: internal error: iterator drain fell through",
            type: STRING,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [itVal], type: outT, loc };
}

/** One method or accessor body as its module function `%C.name`
 * (accessors are methods with property syntax: "get:x"/"set:x" entries —
 * see collectClassShape). */
export function lowerClassMethodMember(
  lowerer: Lowerer,
  info: ClassInfo,
  fnLike: ts.MethodDeclaration | ts.AccessorDeclaration,
): IrFunction | null {
  if (info.localClass?.ready) {
    const member = classMemberNameOf(lowerer, fnLike.name);
    const name = ts.isMethodDeclaration(fnLike)
      ? member
      : `${ts.isGetAccessor(fnLike) ? "get" : "set"}:${member}`;
    return info.localClass.bodies.get(`%${info.def.name}.${name}`) ?? null;
  }
  return withInstanceBindings(lowerer, info, () =>
    lowerClassMethodMemberInner(lowerer, info, fnLike),
  );
}

function lowerClassMethodMemberInner(
  lowerer: Lowerer,
  info: ClassInfo,
  fnLike: ts.MethodDeclaration | ts.AccessorDeclaration,
): IrFunction | null {
  const className = info.def.name;
  const thisType: IrType = { kind: "object", className };
  const memberName = classMemberNameOf(lowerer, fnLike.name);
  if (memberName === null) return null;
  const mName = ts.isMethodDeclaration(fnLike)
    ? memberName
    : `${ts.isGetAccessor(fnLike) ? "get" : "set"}:${memberName}`;
  const sig = info.methods.get(mName);
  if (!sig || !fnLike.body) return null;
  const entryFence = info.methodEntryFences?.get(mName);
  if (entryFence) {
    lowerer.runtimeFences.push(entryFence);
    return lowerer.deferToRuntimeFence(lowerer.diags.length, fnLike.name, {
      kind: "function",
      name: `%${className}.${mName}`,
      params: [
        { localId: "this.0", name: "this", type: thisType },
        ...sig.params.map((p, i) => ({ localId: `p.${i}`, name: `p${i}`, type: p.type })),
      ],
      returnType: sig.ret,
      fallback: entryFence,
      allowDiagSink: true,
    });
  }
  const prevClass = lowerer.currentClass;
  lowerer.currentClass = info;
  // ASYNC methods: the module function is an async IrFunction — its
  // body returns the promise's INNER type (a `return v` fulfills with
  // v) and every call enters through the emitted fiber spawn wrapper
  // (callTargetC routes by fn.async; `this` rides as param 0 in the
  // spawn's argument pack). Dispatch is static by construction — the
  // override fence at collection keeps async methods out of vtables.
  const isAsync = sig.async === true;
  // GENERATOR methods: the module function returns the TReturn channel,
  // yields ride ctx.generator, and direct calls enter through the emitted
  // gen-spawn wrapper with `this` in the argument pack.
  const genCh = sig.gen !== undefined && sig.ret.kind === "generator" ? sig.gen : null;
  const bodyReturn =
    genCh !== null
      ? lowerer.genBodyReturnType(sig.ret)
      : isAsync && sig.ret.kind === "promise"
        ? sig.ret.inner
        : sig.ret;
  const fnCtx = newFnCtx(info.localClass !== undefined, null, null, bodyReturn);
  fnCtx.isAsync = isAsync;
  if (genCh !== null) fnCtx.generator = genCh;
  lowerer.fnStack.push(fnCtx);
  try {
    const thisLocal = lowerer.declareThis(thisType);
    const params: IrParam[] = [{ localId: thisLocal.id, name: "this", type: thisType }];
    // `this` is declared first, so method parameter DEFAULTS may use it
    // (JS allows this in method defaults; it is param 0 here).
    const declared = lowerer.declareParams(fnLike.parameters, sig.params);
    params.push(...declared.params);
    // A shorter JS override still implements every inherited ABI slot.
    // These tail parameters have no source binding or default prologue.
    for (const shape of sig.params.slice(declared.params.length)) {
      const name = shape.mode === "arguments" ? "%arguments" : "%ignored";
      const local = lowerer.declareHiddenLocal(name, shape.type);
      params.push({ localId: local.id, name, type: shape.type });
      if (shape.mode === "arguments") fnCtx.argumentsLocal = local;
    }
    const body = [...declared.prologue, ...lowerer.lowerStmts(fnLike.body.statements)];
    appendImplicitUndefinedReturn(lowerer, body, bodyReturn, locOf(fnLike));
    const fn: IrFunction = {
      name: `%${className}.${mName}`,
      params,
      returnType: bodyReturn,
      locals: lowerer.ctx.locals,
      ...classCaptureParams(info, lowerer.ctx),
      body,
      loc: locOf(fnLike),
    };
    if (isAsync) fn.async = true;
    if (genCh !== null) fn.generator = genCh;
    return fn;
  } finally {
    lowerer.fnStack.pop();
    lowerer.currentClass = prevClass;
  }
}

/** One static method body as its module function `%C.static:m` — an
 * ordinary function with NO `this` param. `this` and `super` inside
 * name the RECEIVER class in JS (dynamic — `F.who()` sees F even when
 * who() is declared on E), which has no static story here: both are
 * named fences, with arrow functions transparent (they inherit the
 * method's `this`) and this-binding function forms opaque — the static-
 * block rule verbatim. */
export function lowerStaticMethod(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
): IrFunction | null {
  const entry = info.staticMethods?.get(name);
  if (!entry?.member.body) return null;
  const isAsync =
    entry.member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = entry.member.asteriskToken !== undefined;
  if (isGenerator && (entry.ret.kind !== "generator" || (entry.ret.async === true) !== isAsync)) {
    lowerer.badType(entry.member.name, lowerer.typeOf(entry.member.name));
  }
  if (isAsync && !isGenerator && entry.ret.kind !== "promise") {
    lowerer.badType(entry.member.name, lowerer.typeOf(entry.member.name));
  }
  const genCh =
    isGenerator && entry.ret.kind === "generator" ? generatorMeta(lowerer, entry.ret) : null;
  const bodyReturn =
    genCh !== null
      ? lowerer.genBodyReturnType(entry.ret)
      : isAsync && entry.ret.kind === "promise"
        ? entry.ret.inner
        : entry.ret;
  const fnCtx = newFnCtx(false, null, null, bodyReturn);
  fnCtx.isAsync = isAsync;
  if (genCh !== null) fnCtx.generator = genCh;
  lowerer.fnStack.push(fnCtx);
  try {
    rejectStaticThis(
      lowerer,
      entry.member.body,
      (keyword) =>
        `'${keyword}' in static methods (it names the RECEIVER class — a dynamic value; reference the class by name instead)`,
    );
    const declared = lowerer.declareParams(entry.member.parameters, entry.params);
    if (entry.params.at(-1)?.mode === "arguments") {
      const local = lowerer.declareHiddenLocal("%arguments", DYN);
      declared.params.push({ localId: local.id, name: "%arguments", type: DYN });
      fnCtx.argumentsLocal = local;
    }
    const body = [...declared.prologue, ...lowerer.lowerStmts(entry.member.body.statements)];
    appendImplicitUndefinedReturn(lowerer, body, bodyReturn, locOf(entry.member));
    const fn: IrFunction = {
      name: `%${info.def.name}.static:${name}`,
      params: declared.params,
      returnType: bodyReturn,
      locals: lowerer.ctx.locals,
      body,
      loc: locOf(entry.member),
    };
    if (isAsync) fn.async = true;
    if (genCh !== null) fn.generator = genCh;
    return fn;
  } catch (e) {
    // A poison OUTSIDE the per-statement catches (the this/super fence,
    // a fenced parameter default): the diagnostic is recorded — the
    // method skips like a signature-blocked function (lowerFunction's
    // rule) instead of killing the whole analysis.
    if (!(e instanceof PoisonError)) throw e;
    return null;
  } finally {
    lowerer.fnStack.pop();
  }
}

/** A synthesized throwing setter: a getter-only override shadows the
 * inherited pair (JS), so a base-typed write dispatches HERE and must
 * throw exactly like Node's TypeError — a real instance (a typed catch's
 * `e instanceof TypeError` matches), catchable, exit 1 uncaught (message
 * text is compiler-worded; stdout and exit code are the contract). */
export function throwingSetterFn(lowerer: Lowerer, info: ClassInfo, prop: string): IrFunction {
  const className = info.def.name;
  const thisType: IrType = { kind: "object", className };
  const sig = info.methods.get(`set:${prop}`)!;
  const loc = locOf(info.decl!);
  const locals: IrLocal[] = [
    { id: "this.0", name: "this", type: thisType, mutable: false },
    { id: "v.0", name: "v", type: sig.params[0]!.type, mutable: false },
  ];
  return {
    name: `%${className}.set:${prop}`,
    params: locals.map((l) => ({ localId: l.id, name: l.name, type: l.type })),
    returnType: VOID,
    locals,
    body: [
      {
        kind: "throw",
        value: {
          kind: "libCall",
          fn: "error.new",
          args: [
            {
              kind: "strLit",
              value: `Cannot set property ${prop} which has only a getter`,
              type: STRING,
              loc,
            },
          ],
          type: { kind: "object", className: "%TypeError" },
          loc,
        },
        loc,
      },
    ],
    loc,
  };
}

/** The base a constructor chain actually CALLS into: generic FAMILIES are
 * never constructed (no `%<family>.constructor` exists), so an
 * instantiation's construction-relevant base is the family's own base —
 * null when the generic class extends nothing, exactly the source's
 * story (tsc forbids super() there). Ordinary classes answer their base
 * unchanged. */
function superBaseOf(info: ClassInfo): ClassInfo | null {
  const b = info.base;
  return b?.generic ? b.base : b;
}

/** The class's OWN field initializers as fieldSet statements (declaration
 * order) — a base constructor's prologue, a derived constructor's
 * super()-return continuation. */
export function fieldInitStmts(lowerer: Lowerer, info: ClassInfo, thisLocal: IrLocal): IrStmt[] {
  const out: IrStmt[] = [];
  const thisType: IrType = { kind: "object", className: info.def.name };
  for (const f of info.fieldOrder) {
    if (f.errorCause) {
      const loc = f.initializer ? locOf(f.initializer) : f.undefinedInitializer!;
      const value = f.initializer
        ? lowerer.lowerExprExpecting(f.initializer, DYN)
        : dynUndefinedExpr(loc);
      out.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "error.defineCause",
          args: [{ kind: "varRef", localId: thisLocal.id, type: thisType, loc }, value],
          type: VOID,
          loc,
        },
        loc,
      });
      continue;
    }
    if (f.undefinedInitializer) {
      const loc = f.undefinedInitializer;
      out.push({
        kind: "fieldSet",
        obj: { kind: "varRef", localId: thisLocal.id, type: thisType, loc },
        className: info.def.name,
        field: f.name,
        value: dynUndefinedExpr(loc),
        loc,
      });
    }
    if (!f.initializer) continue;
    lowerer.stats.statementsTotal++;
    lowerer.bumpFileStat(locOf(f.initializer).file, "total");
    const diagsBefore = lowerer.diags.length;
    try {
      const value = lowerer.lowerExprExpecting(f.initializer, f.type);
      out.push({
        kind: "fieldSet",
        obj: { kind: "varRef", localId: thisLocal.id, type: thisType, loc: locOf(f.initializer) },
        className: info.def.name,
        field: f.name,
        value,
        loc: locOf(f.initializer),
      });
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      lowerer.stats.statementsFailed++;
      lowerer.bumpFileStat(locOf(f.initializer).file, "failed");
      if (isJsSourceFile(f.initializer.getSourceFile()) && lowerer.diagSink === null) {
        const fence = lowerer.deferToRuntimeFence(diagsBefore, f.initializer, {
          kind: "statement",
        });
        if (fence) out.push(fence);
      }
    }
  }
  return out;
}

/** PARAMETER-PROPERTY assignments (`this.x = x`, synthesized): run AFTER
 * the field initializers — Node's transform defines the fields at the
 * top of the class body (undefined until assigned) and injects the
 * assignments at the start of the constructor body, i.e. after super()
 * and after the (native) field initializers ran (probed: a field
 * initializer reading `this.x` sees undefined; the body sees the value).
 * Each assignment reads the parameter's BODY local (defaults already
 * applied by the declareParams prologue), whose type the collection made
 * the field's type — slot-exact by construction. */
function paramPropInitStmts(lowerer: Lowerer, info: ClassInfo, thisLocal: IrLocal): IrStmt[] {
  const out: IrStmt[] = [];
  const thisType: IrType = { kind: "object", className: info.def.name };
  for (const pp of info.paramProps ?? []) {
    const loc = locOf(pp.param);
    const local = ts.isIdentifier(pp.param.name) ? lowerer.resolveLocal(pp.param.name) : null;
    if (!local || !typeEquals(local.type, pp.type)) {
      // Defensive: collection derived the field type from the same
      // paramShape the ctor's declareParams bound — they cannot diverge.
      lowerer.unsupported("SC1090", pp.param, "this parameter property form");
    }
    out.push({
      kind: "fieldSet",
      obj: { kind: "varRef", localId: thisLocal.id, type: thisType, loc },
      className: info.def.name,
      field: pp.name,
      value: { kind: "varRef", localId: local!.id, type: local!.type, loc },
      loc,
    });
  }
  return out;
}

/** Super statements initialize the base and then the derived fields on
 * whichever control-flow path executes. Repeated calls are explicitly
 * refused until native layouts can allocate a second receiver. */
export function lowerDerivedCtorBody(
  lowerer: Lowerer,
  info: ClassInfo,
  thisLocal: IrLocal,
  forward?: IrExpr[],
): IrStmt[] {
  let superSeen = false;
  const initialized = lowerer.declareHiddenLocal("%superInitialized", BOOL);
  initialized.mutable = true;
  const context = lowerer.ctx;
  const previous = context.superCall;
  const previousInitialized = context.superInitialized;
  context.superInitialized = initialized;
  context.superCall = (superCall) => {
    if (!ts.isExpressionStatement(superCall.parent))
      lowerer.unsupported("SC1090", superCall, "super() in an expression position");
    superSeen = true;
    const loc = locOf(superCall);
    const statements: IrStmt[] = [
      {
        kind: "if",
        cond: { kind: "varRef", localId: initialized.id, type: BOOL, loc },
        then: [
          {
            kind: "exprStmt",
            expr: nodeThrowExpr(
              0,
              "SC2020",
              "repeated super() calls require a fresh receiver and are not supported yet",
              DYN,
              loc,
            ),
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ];
    if (info.callableBase) {
      if (superCall.arguments.some(ts.isSpreadElement))
        lowerer.unsupported(
          "SC1090",
          superCall,
          "spreading explicit super arguments into an ordinary constructor",
        );
      const pack: IrExpr = {
        kind: "dynArrLit",
        elems: superCall.arguments.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      };
      statements.push(lowerer.superCallStmt(info, thisLocal, [pack], loc));
    } else {
      const base = superBaseOf(info)!;
      if (base.builtinEmitter && superCall.arguments.length > 0)
        lowerer.unsupported(
          "SC1090",
          superCall,
          "EventEmitter constructor options ('captureRejections')",
        );
      if (base.builtinStream) {
        statements.push(
          ...lowerStreamSuperCall(
            lowerer,
            info,
            base,
            superCall.arguments,
            thisLocal,
            loc,
            superCall,
          ),
        );
      } else {
        const surplusSpread =
          forward === undefined &&
          !base.builtinError &&
          !base.builtinEmitter &&
          base.ctorParams.length === 0 &&
          superCall.arguments.some(ts.isSpreadElement);
        if (surplusSpread) {
          const evaluated = lowerer.completeArgs(
            superCall.arguments,
            [{ mode: "dynRest", type: DYN }],
            loc,
            superCall,
          );
          for (const value of evaluated) statements.push({ kind: "exprStmt", expr: value, loc });
        }
        const surplus =
          forward === undefined &&
          !base.builtinError &&
          !base.builtinEmitter &&
          !base.ctorParams.some(
            (param) =>
              param.mode === "rest" || param.mode === "dynRest" || param.mode === "islandRest",
          ) &&
          !superCall.arguments.some(ts.isSpreadElement) &&
          superCall.arguments.length > base.ctorParams.length;
        let args = surplusSpread
          ? []
          : forward !== undefined
            ? forward
            : base.builtinError
              ? lowerer.errorConstructorArgs(superCall.arguments, loc, superCall)
              : base.builtinEmitter
                ? []
                : lowerer.completeArgs(
                    surplus
                      ? superCall.arguments.slice(0, base.ctorParams.length)
                      : superCall.arguments,
                    base.ctorParams,
                    loc,
                    superCall,
                  );
        if (surplus) {
          args = args.map((arg) => {
            const local = lowerer.declareHiddenLocal("%superArgument", arg.type);
            statements.push({ kind: "varDecl", localId: local.id, init: arg, loc });
            return { kind: "varRef", localId: local.id, type: arg.type, loc };
          });
          for (const argument of superCall.arguments.slice(base.ctorParams.length)) {
            statements.push({
              kind: "exprStmt",
              expr: lowerer.lowerExpr(argument),
              loc: locOf(argument),
            });
          }
        }
        statements.push(lowerer.superCallStmt(info, thisLocal, args, loc));
      }
    }
    statements.push({
      kind: "assign",
      localId: initialized.id,
      value: { kind: "boolLit", value: true, type: BOOL, loc },
      loc,
    });
    delete context.superInitialized;
    try {
      statements.push(
        ...lowerer.fieldInitStmts(info, thisLocal),
        ...paramPropInitStmts(lowerer, info, thisLocal),
      );
    } finally {
      context.superInitialized = initialized;
    }
    const result: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc };
    return {
      kind: "seqExpr",
      stmts: statements.map((statement) =>
        statement.kind === "runtimeFence"
          ? {
              kind: "exprStmt",
              expr: nodeThrowExpr(0, statement.code, statement.message, DYN, statement.loc),
              loc: statement.loc,
            }
          : statement,
      ),
      result,
      type: result.type,
      loc,
    };
  };
  try {
    const result = lowerer.lowerStmts(info.ctor!.body!.statements);
    result.push({
      kind: "if",
      cond: {
        kind: "unary",
        op: "!",
        operand: { kind: "varRef", localId: initialized.id, type: BOOL, loc: locOf(info.ctor!) },
        type: BOOL,
        loc: locOf(info.ctor!),
      },
      then: [
        {
          kind: "exprStmt",
          expr: nodeThrowExpr(
            5,
            "",
            "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
            DYN,
            locOf(info.ctor!),
          ),
          loc: locOf(info.ctor!),
        },
      ],
      else_: null,
      loc: locOf(info.ctor!),
    });
    if (!superSeen)
      lowerer.pushDiag(
        unsupportedDiag(
          "SC1090",
          locOf(info.ctor!),
          "derived constructors without a lowered super() call",
        ),
      );
    return [
      {
        kind: "varDecl",
        localId: initialized.id,
        init: { kind: "boolLit", value: false, type: BOOL, loc: locOf(info.ctor!) },
        loc: locOf(info.ctor!),
      },
      ...result,
    ];
  } finally {
    if (previous) context.superCall = previous;
    else delete context.superCall;
    if (previousInitialized) context.superInitialized = previousInitialized;
    else delete context.superInitialized;
  }
}

/** `super(args)` → direct call of the base constructor with the SAME
 * `this` (upcast; retained by the varRef read — the callee owns and
 * releases its param per the universal convention). */
export function superCallStmt(
  lowerer: Lowerer,
  info: ClassInfo,
  thisLocal: IrLocal,
  args: IrExpr[],
  loc: SrcLoc,
): IrStmt {
  const base = superBaseOf(info)!;
  const thisRef: IrExpr = {
    kind: "varRef",
    localId: thisLocal.id,
    type: { kind: "object", className: info.def.name },
    loc,
  };
  if (info.callableBase)
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.classSuper",
        args: [
          info.localClass
            ? {
                kind: "libCall",
                fn: "dyn.getPrototype",
                args: [
                  {
                    kind: "dynFrom",
                    value: {
                      kind: "fieldGet",
                      obj: thisRef,
                      className: info.def.name,
                      field: `%classEnvironment:${info.def.name}`,
                      type: { kind: "classval", className: info.def.name },
                      loc,
                    },
                    type: DYN,
                    loc,
                  },
                ],
                type: DYN,
                loc,
              }
            : { kind: "varRef", localId: info.callableBase.constructorId, type: DYN, loc },
          lowerer.coerceToExpected(thisRef, DYN),
          args[0]!,
        ],
        type: VOID,
        loc,
      },
      loc,
    };
  if (base.builtinError) {
    // super(message) into the runtime-provided Error constructor: stamps
    // name/message on the (already-allocated) object. Receiver + message
    // are BORROWED by the libCall — no ownership transfer, unlike the
    // call form below.
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "error.ctorOptions",
        args: [lowerer.upcastTo(thisRef, base.def.name), ...args],
        type: VOID,
        loc,
      },
      loc,
    };
  }
  if (base.builtinEmitter) {
    // super() into the runtime-provided EventEmitter: the emitted
    // allocation already initialized the prefix (registry NULL, display
    // name stamped), so the call is a placeholder site. Receiver
    // borrowed, like error.ctor.
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "emitter.ctor",
        args: [lowerer.upcastTo(thisRef, base.def.name)],
        type: VOID,
        loc,
      },
      loc,
    };
  }
  if (base.builtinStream) {
    // The SYNTHESIZED constructor of a ctor-less stream subclass:
    // super() with default options (underscore methods still bind; a
    // construction passing options requires a declared constructor —
    // lowerNew fences that). Zero options ⇒ exactly one init stmt.
    return lowerStreamSuperCall(
      lowerer,
      info,
      base,
      [],
      thisLocal,
      loc,
      info.decl ?? info.ctor!,
    )[0]!;
  }
  lowerer.noteEdge(`%${base.def.name}.constructor`);
  return {
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: `%${base.def.name}.constructor`,
      args: [lowerer.upcastTo(thisRef, base.def.name), ...args],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** `super.method(args)`: the base chain's implementation, called
 * DIRECTLY over this method's own `this` (upcast to the declarer) —
 * super dispatch is static in JS too, never through the dynamic class. */
export function lowerSuperMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const cls = lowerer.currentClass;
  if (!cls?.base) {
    // tsc rejects super outside derived-class bodies first; defensive.
    lowerer.unsupported("SC1090", access, "'super' outside a derived class");
  }
  // An emit-override SPECIALIZATION body's forward — `super.emit(event,
  // ...args)` — carries no literal event name; the specialization's own
  // context answers it (matched before any lookup: neither identifier
  // resolves through the ordinary lowering).
  const forward = emitSpecSuperForward(lowerer, call, access);
  if (forward) return forward;
  const found = lowerer.findMethodOn(cls.base, access.name.text);
  if (!found) {
    // `super.m(...)` of a GENERIC method: super dispatch is static in JS
    // too, so the base chain's declaration answers unconditionally — the
    // ordinary instantiation route over this method's own `this`.
    const gfound = findGenericMethodOn(lowerer, cls.base, access.name.text);
    if (gfound) {
      const thisL = lowerer.resolveThis();
      if (!thisL) lowerer.unsupported("SC1080", access);
      const instance = genericCallInstance(lowerer, call, gfound.info);
      const loc = locOf(call);
      const thisRef: IrExpr = { kind: "varRef", localId: thisL.id, type: thisL.type, loc };
      const args = lowerer.completeArgs(call.arguments, instance.params, loc, call);
      return {
        kind: "call",
        callee: instance.name,
        args: [lowerer.upcastTo(thisRef, gfound.declarer.def.name), ...args],
        type: instance.returnType,
        loc,
      };
    }
    // The runtime-provided emitter surface through `super` —
    // `super.emit('x', v)`, `super.on(...)`: Node's prototype-chain rule
    // is STATIC dispatch above the lexical class, which the emitter
    // spoke lowers with this method's own `this` as the receiver (an
    // emit override at-or-below `cls` never answers; the nearest one
    // strictly above does).
    if (EMITTER_API_MEMBERS.has(access.name.text) && emitterRooted(lowerer, cls.base)) {
      const viaEmitter = lowerEmitterSuperCall(lowerer, call, access, cls);
      if (viaEmitter) return viaEmitter;
    }
    lowerer.unsupported(
      "SC1090",
      access,
      `'super.${access.name.text}' (no base class declares it)`,
    );
  }
  // tsc rejects super-access of abstract members (TS2513); defensive —
  // no function exists behind an abstract declaration.
  if (found.sig.abstract === true) {
    lowerer.unsupported("SC1090", access, `'super.${access.name.text}' of an abstract method`);
  }
  const thisLocal = lowerer.resolveThis();
  if (!thisLocal) lowerer.unsupported("SC1080", access);
  const loc = locOf(call);
  const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc };
  if (lowerer.prototypeMethodAccesses.has(access.name.text)) {
    const prototype = classPrototypeData(lowerer, cls.base, loc);
    if (prototype) {
      const callee: IrExpr = {
        kind: "dynKeyGet",
        value: prototype,
        key: { kind: "strLit", value: access.name.text, type: STRING, loc },
        type: DYN,
        loc,
      };
      const value: IrExpr = {
        kind: "dynCall",
        callee,
        receiver: lowerer.coerceToExpected(thisRef, DYN),
        calleeName: access.getText(),
        args: call.arguments.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      };
      return found.sig.ret.kind === "void" ? value : lowerer.coerceToExpected(value, found.sig.ret);
    }
  }
  if (found.declarer.builtinError) {
    return {
      kind: "libCall",
      fn: "error.toString",
      args: [lowerer.upcastTo(thisRef, "%Error")],
      type: STRING,
      loc,
    };
  }
  lowerer.noteEdge(`%${found.declarer.def.name}.${access.name.text}`);
  const args = lowerer.completeArgs(call.arguments, found.sig.params, loc, call);
  return {
    kind: "call",
    callee: `%${found.declarer.def.name}.${access.name.text}`,
    args: [lowerer.upcastTo(thisRef, found.declarer.def.name), ...args],
    type: found.sig.ret,
    loc,
  };
}

/** The `this` reference for super accessor reads/writes, with the shared
 * validity checks (derived-class body, resolvable this). */
export function superThisRef(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): { thisRef: IrExpr; base: ClassInfo } {
  const cls = lowerer.currentClass;
  if (!cls?.base) {
    lowerer.unsupported("SC1090", access, "'super' outside a derived class");
  }
  const thisLocal = lowerer.resolveThis();
  if (!thisLocal) lowerer.unsupported("SC1080", access);
  const loc = locOf(access);
  return {
    thisRef: { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc },
    base: cls.base,
  };
}

/** `super.x` read: a DIRECT call of the base chain's getter over this
 * method's own `this` (upcast to the declarer) — like super.method(),
 * never through the vtable. */
export function lowerSuperAccessorRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const { thisRef, base } = lowerer.superThisRef(access);
  const name = access.name.text;
  const found = lowerer.findMethodOn(base, `get:${name}`);
  if (!found) {
    lowerer.unsupported(
      "SC1090",
      access,
      lowerer.findMethodOn(base, name)
        ? `bound method references through 'super' (call 'super.${name}(...)' directly)`
        : `'super.${name}' (only base-class methods and getter properties are readable through 'super')`,
    );
  }
  // tsc rejects super-access of abstract members (TS2513); defensive.
  if (found.sig.abstract === true) {
    lowerer.unsupported("SC1090", access, `'super.${name}' of an abstract accessor`);
  }
  lowerer.noteEdge(`%${found.declarer.def.name}.get:${name}`);
  return {
    kind: "call",
    callee: `%${found.declarer.def.name}.get:${name}`,
    args: [lowerer.upcastTo(thisRef, found.declarer.def.name)],
    type: found.sig.ret,
    loc: locOf(access),
  };
}

/** `super.x = v`: a DIRECT call of the base chain's setter (same
 * static-dispatch rule as every super member access). */
export function lowerSuperAccessorWrite(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  loc: SrcLoc,
): IrStmt {
  const { thisRef, base } = lowerer.superThisRef(access);
  const name = access.name.text;
  const found = lowerer.findMethodOn(base, `set:${name}`);
  if (!found) {
    lowerer.unsupported(
      "SC1090",
      access,
      `assignment to 'super.${name}' (no base class declares a setter for it)`,
    );
  }
  // tsc rejects super-access of abstract members (TS2513); defensive.
  if (found.sig.abstract === true) {
    lowerer.unsupported("SC1090", access, `assignment to 'super.${name}' of an abstract accessor`);
  }
  lowerer.noteEdge(`%${found.declarer.def.name}.set:${name}`);
  const value = lowerer.lowerExprExpecting(rhs, found.sig.params[0]!.type);
  return {
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: `%${found.declarer.def.name}.set:${name}`,
      args: [lowerer.upcastTo(thisRef, found.declarer.def.name), value],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** True when `info`'s EFFECTIVE constructor — its own, or the one
 * inherited through ctor-less bases — is a builtin error class's. Such
 * classes construct with the error argument rule, and their synthesized
 * constructors forward both checked-dynamic values to error.ctorOptions. */
export function inheritsBuiltinErrorCtor(lowerer: Lowerer, info: ClassInfo): boolean {
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinError) return true;
    if (c.ctor) return false;
  }
  return false;
}

/** The EventEmitter twin: a ctor-less chain into the emitter base
 * inherits `new C()` — zero arguments (the options bag fences). */
export function inheritsBuiltinEmitterCtor(lowerer: Lowerer, info: ClassInfo): boolean {
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinStream) return false; // the stream story owns the chain
    if (c.builtinEmitter) return true;
    if (c.ctor) return false;
  }
  return false;
}

/** The stream twin: a ctor-less chain into a runtime stream base
 * inherits `new C()` — zero arguments (the synthesized constructor runs
 * super() with default options; passing options through an inherited
 * constructor would need the literal at the new-site to plumb, so it
 * asks for a declared constructor instead). */
function inheritsBuiltinStreamCtor(lowerer: Lowerer, info: ClassInfo): boolean {
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinStream) return true;
    if (c.ctor) return false;
  }
  return false;
}

/** Preserve argument evaluation order and option presence through builtin
 * and inherited Error constructors. Checked-dynamic conversion retains
 * Error identity and distinguishes a missing cause from undefined. */
export function errorConstructorArgs(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr[] {
  if (args.length > 2)
    lowerer.unsupported("SC1090", blame, "Error constructors with more than two arguments");
  return [0, 1].map((i) => {
    const arg = args[i];
    if (!arg) return dynUndefinedExpr(loc);
    return lowerer.lowerExprExpecting(arg, DYN);
  });
}

/** `new C(...)` of a registered PROGRAM class — the shared tail of the
 * identifier and namespace-qualified construction forms. */
/** `new Box(1)` / `new Box<string>("s")` — construction of a GENERIC
 * class resolves to the INSTANTIATION the expression's checker type names
 * (inference and explicit type arguments both land there; defaults apply).
 * The identity function for ordinary classes. */
function genericNewTarget(lowerer: Lowerer, expr: ts.NewExpression, info: ClassInfo): ClassInfo {
  if (!info.generic) return info;
  const t = lowerer.typeOf(expr);
  const mapped = lowerer.mapTypeOf(t);
  const instInfo = mapped?.kind === "object" ? lowerer.classes.get(mapped.className) : undefined;
  // Unmappable type arguments (or a poisoned instantiation): the site
  // reports the type it cannot compile — the instantiation's own
  // diagnostic (context-tagged) already told the deeper story.
  if (!instInfo || instInfo.generic) lowerer.badType(expr, t);
  return instInfo;
}

/** A class whose decoration provably throws has no reachable VALUE form:
 * the binding never initializes (the %init ReferenceError unwinds first),
 * so `new`, the class as a value, and `extends` all fence — reaching one
 * in compiled code would require executing past the throw. */
function fenceDecorationThrows(lowerer: Lowerer, info: ClassInfo, blame: ts.Node): void {
  if (info.decorationThrows === undefined) return;
  lowerer.unsupported(
    "SC1090",
    blame,
    `using the class '${info.def.jsName || info.def.name}' whose decoration provably throws ('${info.decorationThrows.name}' is an ambient name nothing defines — the class statement crashes before the binding exists)`,
  );
}

function lowerProgramClassNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  declaredInfo: ClassInfo,
  loc: SrcLoc,
): IrExpr {
  const info = genericNewTarget(lowerer, expr, declaredInfo);
  fenceDecorationThrows(lowerer, info, expr);
  if (info.localClass)
    lowerer.unsupported(
      "SC1090",
      expr,
      "construction through a function-local class's internal name",
    );
  lowerer.noteEdge(`%${info.def.name}.constructor`);
  // A ctor-less chain into an EventEmitter base inherits `new C()` —
  // zero arguments (the options bag fences, like the super() form).
  // Stream subclasses come first: their chain roots at the emitter
  // too, but the message should name the stream story.
  if (inheritsBuiltinStreamCtor(lowerer, info) && (expr.arguments ?? []).length > 0) {
    lowerer.noLowering(
      `new ${info.def.name.replace(/^%/, "")} with arguments through an inherited stream constructor`,
      expr.arguments![0]!,
      "declare a constructor that passes an inline options object to super(...)",
    );
  }
  if (lowerer.inheritsBuiltinEmitterCtor(info) && (expr.arguments ?? []).length > 0) {
    lowerer.unsupported(
      "SC1090",
      expr.arguments![0]!,
      "EventEmitter constructor options ('captureRejections')",
    );
  }
  // A ctor-less chain into a builtin error base inherits both arguments;
  // each synthesized constructor forwards the same pair to its base.
  const args = lowerer.inheritsBuiltinErrorCtor(info)
    ? lowerer.errorConstructorArgs(expr.arguments ?? [], loc, expr)
    : lowerer.completeArgs(expr.arguments ?? [], info.ctorParams, loc, expr);
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (current.def.baseValueGlobal)
      return {
        kind: "newValue",
        callee: classValueRef(lowerer, info, expr),
        args,
        type: { kind: "object", className: info.def.name },
        loc,
      };
  }
  return {
    kind: "new",
    className: info.def.name,
    args,
    type: { kind: "object", className: info.def.name },
    loc,
  };
}

function assignedThisFieldType(lowerer: Lowerer, expr: ts.NewExpression): IrType | null {
  const parent = expr.parent;
  if (
    !ts.isBinaryExpression(parent) ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    parent.right !== expr ||
    !ts.isPropertyAccessExpression(parent.left) ||
    parent.left.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null;
  }
  return lowerer.currentClass?.fields.get(parent.left.name.text) ?? null;
}

export function lowerNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const loc = locOf(expr);
  let intlConstructor = expr.expression;
  if (ts.isIdentifier(intlConstructor)) {
    const symbol = lowerer.resolveValueSymbol(intlConstructor);
    const declaration = symbol ? lowerer.checker.valueDeclarationOf(symbol) : undefined;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      intlConstructor = declaration.initializer;
  }
  const intl = ts.isPropertyAccessExpression(intlConstructor)
    ? lowerer.stdlibGlobalMember(intlConstructor, "Intl")
    : null;
  if (intl && intl !== "Segmenter")
    lowerer.noLowering(
      `new Intl.${intl}`,
      expr,
      undefined,
      lowerer.checker.getSymbolAtLocation(expr.expression),
    );
  const instanceConstructor = lowerInstanceConstructorNew(lowerer, expr);
  if (instanceConstructor) return instanceConstructor;
  const objectFactory = lowerObjectFactoryNew(lowerer, expr);
  if (objectFactory) return objectFactory;
  if (ts.isIdentifier(expr.expression)) {
    const symbol = lowerer.resolveValueSymbol(expr.expression);
    const declaration =
      symbol &&
      lowerer.checker
        .declarationsOf(symbol)
        .find((node) => ts.isFunctionDeclaration(node) && node.body !== undefined);
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) {
      const last = declaration.body.statements.at(-1);
      if (
        last &&
        ts.isReturnStatement(last) &&
        last.expression &&
        ts.isObjectLiteralExpression(last.expression)
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "object-returning constructors that observe this or return mixed primitive/object values",
        );
      }
    }
  }
  let selected: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(selected)) selected = selected.expression;
  if (ts.isConditionalExpression(selected)) {
    const yes = exactClassOfReceiver(lowerer, selected.whenTrue);
    const no = exactClassOfReceiver(lowerer, selected.whenFalse);
    if (yes && no && !yes.classDecorators && !no.classDecorators) {
      const yesType: IrType = { kind: "object", className: yes.def.name };
      const noType: IrType = { kind: "object", className: no.def.name };
      const type: IrType =
        yes === no
          ? yesType
          : {
              kind: "union",
              unionId: lowerer.unions.intern(
                [yesType, noType].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1)),
              ),
            };
      return {
        kind: "ternary",
        cond: lowerer.lowerCondition(selected.condition),
        then: lowerer.coerceInto(expr, lowerProgramClassNew(lowerer, expr, yes, loc), type),
        else_: lowerer.coerceInto(expr, lowerProgramClassNew(lowerer, expr, no, loc), type),
        type,
        loc,
      };
    }
  }
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "Segmenter" &&
    lowerer.isStdlibGlobal(expr.expression.expression, "Intl")
  ) {
    const args = expr.arguments ?? [];
    const undefinedArg = (arg: ts.Expression): boolean =>
      (lowerer.typeOf(arg).flags & ts.TypeFlags.Undefined) !== 0;
    if (args.length > 2 || (args[0] && !undefinedArg(args[0]))) {
      lowerer.noLowering(
        "Intl.Segmenter locale negotiation",
        expr,
        "omit the locale or pass undefined for default Unicode grapheme segmentation",
      );
    }
    const options = args[1];
    if (
      options &&
      !undefinedArg(options) &&
      !(
        ts.isObjectLiteralExpression(options) &&
        options.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === "granularity" &&
            ts.isStringLiteral(property.initializer) &&
            property.initializer.text === "grapheme",
        )
      )
    ) {
      lowerer.noLowering(
        "Intl.Segmenter options",
        options,
        'the native segmenter supports default options and { granularity: "grapheme" }; word and sentence segmentation remain unsupported',
      );
    }
    // Explicit undefined expressions can carry effects; retain argument order.
    const stmts: IrStmt[] = args.map((arg) => {
      const value = lowerer.lowerExpr(arg);
      return {
        kind: "exprStmt",
        expr: value.type.kind === "void" ? value : lowerer.coerceInto(arg, value, DYN),
        loc: locOf(arg),
      };
    });
    const result: IrExpr = { kind: "libCall", fn: "intl.segmenterNew", args: [], type: DYN, loc };
    return stmts.length ? { kind: "seqExpr", stmts, result, type: DYN, loc } : result;
  }
  const consoleCtor = ts.isIdentifier(expr.expression)
    ? lowerer.builtinImportOf(expr.expression)
    : ts.isPropertyAccessExpression(expr.expression) &&
        lowerer.builtinNamespaceModuleOf(expr.expression.expression) === "console"
      ? { module: "console", member: expr.expression.name.text }
      : null;
  if (consoleCtor?.module === "console" && consoleCtor.member === "Console") {
    lowerer.noLowering("new console.Console", expr, builtinFenceHintOf("console", "Console"));
  }
  // `new X(...)` where X is a package-declared class, in a static build:
  // the per-package requires-dynamic diagnostic (the constructor runs in
  // the embedded engine). Under --dynamic, X is jsval-typed and lowers
  // to the construct op below.
  if (!lowerer.dynamic) {
    const pkg = ts.isIdentifier(expr.expression)
      ? lowerer.npmPackageOfSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
      : null;
    if (pkg) {
      lowerer.pushDiag(requiresDynamicPackageDiag(pkg, loc));
      throw new PoisonError();
    }
  }
  // Island construction: a jsval-typed callee (a package-declared class,
  // or any 'any'-typed constructor value) runs JS_CallConstructor —
  // `new Command()` is the npm entry point. Arguments marshal in; the
  // instance stays an island handle.
  if (lowerer.isIslandExpr(expr.expression)) {
    const callee = lowerer.lowerExpr(expr.expression);
    const args = (expr.arguments ?? []).map((a) => lowerer.jsvalIn(lowerer.lowerExpr(a), a));
    return { kind: "jsOp", op: "construct", args: [callee, ...args], type: JSVAL, loc };
  }
  // `new events.EventEmitter()` — the namespace-member (and CJS
  // `require('events').EventEmitter`) construction form: the property's
  // symbol resolves to the same ambient class as the named import.
  if (ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.name)) {
    const memberSym = lowerer.checker.getSymbolAtLocation(expr.expression.name);
    const resolved =
      memberSym && memberSym.flags & ts.SymbolFlags.Alias
        ? lowerer.checker.getAliasedSymbol(memberSym)
        : memberSym;
    const emitterInfo = lowerer.builtinEmitterInfoOf(resolved);
    if (emitterInfo) {
      if ((expr.arguments ?? []).length > 0) {
        lowerer.unsupported(
          "SC1090",
          expr.arguments![0]!,
          "EventEmitter constructor options ('captureRejections')",
        );
      }
      return {
        kind: "libCall",
        fn: "emitter.new",
        args: [],
        type: { kind: "object", className: RUNTIME_EMITTER_CLASS },
        loc,
      };
    }
    // `new stream.Readable({...})` — the namespace-member (and CJS
    // `require('stream').Readable`) construction form.
    const streamInfoNs = builtinStreamInfoOf(lowerer, resolved);
    if (streamInfoNs) return lowerStreamNew(lowerer, expr, streamInfoNs);
    // `new N.C(...)` / `new a.Point(...)` — construction through a
    // USER namespace qualifier (import= alias chains included): the
    // member resolves to the registered program class, guarded by the
    // namespace source-order fences (lower-namespaces.ts).
    if (!expr.expression.questionDotToken && nsMemberIdentOf(lowerer, expr.expression)) {
      if (memberSym) fenceEarlyNsMemberRef(lowerer, expr.expression, memberSym);
      // resolveValueSymbol (not the bare alias chase): the reference
      // must flush deferred collection diagnostics like any other.
      const classSym = lowerer.resolveValueSymbol(expr.expression.name);
      const info = classSym ? lowerer.classBySymbol.get(classSym) : undefined;
      // Qualified spellings of a rebindable decorated class (an import=
      // alias chain landing on it) cannot construct the declaration
      // directly — the decoration result decides. The bare-name path
      // routes through the class VALUE; the qualified one fences.
      if (info?.classDecorators?.valueGlobalId !== undefined) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "constructing a decorated class through a qualified name (a replacing decorator rebinds the class name — construct through the bare name)",
        );
      }
      if (info && !info.localClass) return lowerProgramClassNew(lowerer, expr, info, loc);
      // A namespace export can hold a class returned by a factory.
      // Let the class-value path below preserve that constructor's
      // lexical environment instead of requiring a class declaration.
    }
    // `new B.C()` where B is an AMBIENT namespace (fundule merges
    // included): Node evaluates the callee first and throws
    // ReferenceError before any argument runs — undefRead reproduces it
    // exactly.
    if (!expr.expression.questionDotToken) {
      const ambientRoot = ambientNsRootOf(lowerer, expr.expression.expression);
      if (ambientRoot !== null) {
        const t = ambientUndefReadType(lowerer, expr);
        if (t) return nsUndefRead(lowerer, ambientRoot.text, expr, t);
      }
    }
    // Construction through a CJS export member tsgo types `any`
    // (expando members — `new module.exports.Sub()` / `new
    // exports.Sub()` in-file, `new C.Sub()` through the require
    // binding): the member IS its pre-registered export global —
    // construction dispatches through the class VALUE, the classval
    // path's newValue with the global as the callee. Resolution is the
    // member-export symbol's; the class collects on demand (a body
    // lowering ahead of the assignment statement).
    if (
      !expr.expression.questionDotToken &&
      ((isCjsJsFile(expr.getSourceFile(), lowerer.program) &&
        (isModuleExportsAccess(expr.expression.expression) ||
          (ts.isIdentifier(expr.expression.expression) &&
            expr.expression.expression.text === "exports" &&
            !lowerer.peekLocal(expr.expression.expression) &&
            !lowerer.globalOf(expr.expression.expression)))) ||
        lowerer.cjsLocalModuleBindingOf(expr.expression.expression))
    ) {
      // Candidate symbols for the export global: the member symbol as
      // spelled, its alias-chased resolution (resolveValueSymbol carries
      // the dep-module fallback tsgo needs at member-use sites), and the
      // in-file module-export symbol.
      const candidates = [
        memberSym,
        resolved,
        lowerer.resolveValueSymbol(expr.expression.name) ?? undefined,
        lowerer.cjsModuleExportSymbol(expr.getSourceFile(), expr.expression.name.text),
      ];
      const exportSym = candidates.find((s) => s !== undefined);
      const g = candidates
        .map((s) => (s ? lowerer.globalsBySymbol.get(s) : undefined))
        .find((x) => x !== undefined);
      if (g && g.type.kind === "classval") {
        const info =
          lowerer.classes.get(g.type.className) ??
          propertyAssignedClassInfoOf(lowerer, exportSym) ??
          lowerer.classes.get(g.type.className);
        if (info && !info.generic) {
          lowerer.noteEdge(`%${info.def.name}.constructor`);
          const below = (c: ClassInfo): void => {
            for (const s of c.subclasses) {
              lowerer.noteEdge(`%${s.def.name}.constructor`);
              below(s);
            }
          };
          below(info);
          const callee: IrExpr = { kind: "varRef", localId: g.id, type: g.type, loc };
          const args = lowerer.completeArgs(expr.arguments ?? [], info.ctorParams, loc, expr);
          return {
            kind: "newValue",
            callee,
            args,
            type: { kind: "object", className: info.def.name },
            loc,
          };
        }
      }
    }
  }
  // `new http.Server([options][, handler])` — the constructor spelling
  // of http.createServer (Node's Server class IS the factory's
  // product); routed to lower-server ahead of the stdlib-ctor fences.
  {
    const httpServer = lowerHttpServerNew(lowerer, expr);
    if (httpServer) return httpServer;
  }
  // `new http.Agent(opts?)` / `new https.Agent(opts?)` — the Agent
  // handle (lower-server): getName/destroy/counters through the dyn
  // handle ops, requests thread it via the agent option.
  {
    const agent = lowerHttpAgentNew(lowerer, expr);
    if (agent) return agent;
  }
  if (
    ts.isIdentifier(expr.expression) ||
    (ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.name) &&
      lowerer.isStdlibGlobal(expr.expression.expression, "globalThis"))
  ) {
    // `import C = N.C; new C()` — the alias's own source-order guards
    // (a no-op for every non-import= binding).
    if (ts.isIdentifier(expr.expression)) fenceEarlyAliasUse(lowerer, expr.expression, expr);
    const identifier = ts.isIdentifier(expr.expression) ? expr.expression : expr.expression.name;
    const symbol = ts.isIdentifier(identifier) ? lowerer.resolveValueSymbol(identifier) : null;
    if (ts.isIdentifier(identifier) && lowerer.isStdlibGlobal(identifier, "Array")) {
      return lowerArrayConstructor(lowerer, expr, expr.arguments ?? []);
    }
    if (isNativeProxyInitializer(lowerer, expr)) return lowerNativeProxy(lowerer, expr);
    // `new Error(msg?)` and its standard subclasses: the
    // runtime-provided classes construct through one libCall — the result
    // TYPE names which builtin, and the message completes to "" exactly
    // like Node's message property default.
    const errInfo = lowerer.builtinErrorInfoOf(symbol);
    // `new DOMException(message?, nameOrOptions?)`: both arguments cross
    // as dyn values (absent → the dyn undefined), and the runtime owns
    // WebIDL's resolution — ToString of the message ("" for undefined),
    // name from a string / an options object's `name` member (with the
    // `cause` own-property record) / "Error" for absent, and the legacy
    // numeric code from the name table.
    if (errInfo && errInfo.def.name === "%DOMException") {
      const args = expr.arguments ?? [];
      if (args.length > 2) {
        lowerer.noLowering(`new DOMException with ${args.length} arguments`, expr);
      }
      const toDynArg = (a: ts.Expression | undefined): IrExpr => {
        if (!a) return dynUndefinedExpr(loc);
        const v = lowerer.lowerExpr(a);
        if (v.type.kind === "dyn") return v;
        if (v.kind === "unitLit" || (v.type.kind !== "jsval" && lowerer.dynConvertible(v.type))) {
          return { kind: "dynFrom", value: v, type: DYN, loc };
        }
        lowerer.noLowering(
          `new DOMException with a '${lowerer.fmt(v.type)}' argument`,
          a,
          "message strings and string/options-object names lower (Node ToStrings other values — convert explicitly)",
        );
      };
      const msgArg = toDynArg(args[0]);
      const nameArg = toDynArg(args[1]);
      return {
        kind: "libCall",
        fn: "error.newDom",
        args: [msgArg, nameArg],
        type: { kind: "object", className: "%DOMException" },
        loc,
      };
    }
    if (errInfo) {
      const args = lowerer.errorConstructorArgs(expr.arguments ?? [], loc, expr);
      return {
        kind: "libCall",
        fn: "error.newOptions",
        args,
        type: { kind: "object", className: errInfo.def.name },
        loc,
      };
    }
    // `new EventEmitter()`: the runtime-provided emitter constructs
    // through one libCall. Zero arguments — the options bag
    // (@types/node's captureRejections) has no lowering.
    const emitterInfo = lowerer.builtinEmitterInfoOf(symbol);
    if (emitterInfo) {
      if ((expr.arguments ?? []).length > 0) {
        lowerer.unsupported(
          "SC1090",
          expr.arguments![0]!,
          "EventEmitter constructor options ('captureRejections')",
        );
      }
      return {
        kind: "libCall",
        fn: "emitter.new",
        args: [],
        type: { kind: "object", className: RUNTIME_EMITTER_CLASS },
        loc,
      };
    }
    // `new Readable({...})` and the other stream classes: the options
    // object parses structurally in the stream spoke.
    const streamInfo = builtinStreamInfoOf(lowerer, symbol);
    if (streamInfo) return lowerStreamNew(lowerer, expr, streamInfo);
    // `new URL(input)`: the WHATWG URL class (stdlib/@types provenance —
    // a user's own `class URL` resolves through classBySymbol below).
    // Invalid input or base throws a catchable TypeError ("Invalid URL").
    // `new RegExp(pattern, flags?)`: runtime construction over the same
    // libregexp engine the literals ride. The pattern compiles EAGERLY,
    // so bad input throws Node's catchable SyntaxError at construction.
    // Checked arguments retain native regexes and perform runtime coercion.
    if (symbol && symbol.name === "RegExp" && lowerer.isStdlibSymbol(symbol)) {
      const args = expr.arguments ?? [];
      if (args.length > 2) {
        lowerer.noLowering(`new RegExp with ${args.length} arguments`, expr);
      }
      if (args.some(ts.isSpreadElement))
        lowerer.noLowering("new RegExp with spread arguments", expr);
      const values = args.map((arg) => lowerer.lowerExpr(arg));
      if (values.some((value) => value.type.kind === "dyn" || value.type.kind === "regex")) {
        const checked = [0, 1].map((index): IrExpr =>
          values[index]
            ? lowerer.coerceInto(args[index]!, values[index]!, DYN)
            : dynUndefinedExpr(loc),
        );
        return {
          kind: "libCall",
          fn: "regex.newChecked",
          args: checked,
          type: { kind: "regex" },
          loc,
        };
      }
      const strArg = (a: ts.Expression | undefined, what: string): IrExpr => {
        if (!a) return { kind: "strLit", value: "", type: STRING, loc };
        const v = values[args.indexOf(a)]!;
        const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
        if (v.type.kind === "undefinedT") {
          if (v.kind === "unitLit") return empty;
          return {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: lowerer.coerceToExpected(v, DYN), loc: locOf(a) }],
            result: empty,
            type: STRING,
            loc,
          };
        }
        if (
          v.type.kind === "union" &&
          lowerer.unions
            .get(v.type.unionId)
            ?.arms.every((arm) => arm.kind === "string" || arm.kind === "undefinedT")
        ) {
          return { kind: "nullish", left: v, right: empty, type: STRING, loc: locOf(a) };
        }
        if (v.type.kind !== "string") {
          lowerer.noLowering(
            `new RegExp with a '${lowerer.fmt(v.type)}' ${what}`,
            a,
            "string or undefined arguments are the lowered form (a RegExp copy or ToString coercion has no lowering)",
          );
        }
        return v;
      };
      const pattern = strArg(args[0], "pattern");
      const flags = strArg(args[1], "flags argument");
      return {
        kind: "libCall",
        fn: "regex.new",
        args: [pattern, flags],
        type: { kind: "regex" },
        loc,
      };
    }
    if (symbol && symbol.name === "URL" && lowerer.isStdlibSymbol(symbol)) {
      return lowerUrlNew(lowerer, expr);
    }
    // `new URLSearchParams(init?)`: the WHATWG list (stdlib provenance —
    // see lowerSearchParamsNew for the lowered init shapes).
    if (symbol && symbol.name === "URLSearchParams" && lowerer.isStdlibSymbol(symbol)) {
      return lowerSearchParamsNew(lowerer, expr, loc);
    }
    // Date's read-only value slice: store the constructor's TimeClip'd
    // epoch milliseconds as the scalar date kind. That is sufficient
    // for every getter and toISOString; identity and setters stay
    // fenced, so copying the scalar cannot create an observable lie.
    if (symbol && symbol.name === "Date" && lowerer.isStdlibSymbol(symbol)) {
      const args = expr.arguments ?? [];
      if (args.some(ts.isSpreadElement) || args.length > 1) {
        lowerer.noLowering(
          `new Date with ${args.length} arguments`,
          expr,
          "new Date(), new Date(milliseconds), and new Date(dateString) are supported; the local-time year/month field constructor has no lowering",
          symbol,
        );
      }
      if (isJsSourceFile(expr.getSourceFile())) {
        return {
          kind: "libCall",
          fn: "date.nativeNew",
          args: [
            {
              kind: "dynArrLit",
              elems: args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
              type: DYN,
              loc,
            },
          ],
          type: DYN,
          loc,
        };
      }
      if (args.length === 0) {
        return { kind: "libCall", fn: "date.newNow", args: [], type: DATE_T, loc };
      }
      const arg = lowerer.lowerExpr(args[0]!);
      if (arg.type.kind === "f64") {
        return { kind: "libCall", fn: "date.newMs", args: [arg], type: DATE_T, loc };
      }
      if (arg.type.kind === "string") {
        return { kind: "libCall", fn: "date.newString", args: [arg], type: DATE_T, loc };
      }
      if (arg.type.kind === "date") {
        return arg;
      }
      lowerer.noLowering(
        `new Date of '${lowerer.fmt(arg.type)}' values`,
        args[0]!,
        "pass milliseconds, a date string, or another Date value",
        symbol,
      );
    }
    // `new StringDecoder(encoding?)` (node:string_decoder): the decoder
    // is a two-field record — the CANONICAL encoding name (aliases fold
    // at compile time, exactly what `.encoding` answers in Node) and
    // the packed-f64 pending state starting at 0 (nothing buffered).
    // The encoding must be a literal (Node's alias set); omitted means
    // utf8, Node's default.
    if (symbol && symbol.name === "StringDecoder" && lowerer.isStdlibSymbol(symbol)) {
      const args = expr.arguments ?? [];
      if (args.length > 1) {
        lowerer.noLowering("new StringDecoder with 2 arguments", expr, undefined, symbol);
      }
      const encName =
        args.length === 1 ? bufEncoding(lowerer, "new StringDecoder", args[0]!) : "utf8";
      const decT = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (decT?.kind !== "record") lowerer.badType(expr, lowerer.typeOf(expr));
      return {
        kind: "recordLit",
        fields: [
          { name: "%enc", value: { kind: "strLit", value: encName, type: STRING, loc } },
          { name: "%pending", value: { kind: "numLit", value: 0, type: F64, loc } },
        ],
        type: decT,
        loc,
      };
    }
    if (
      symbol &&
      (symbol.name === "TextDecoder" || symbol.name === "TextEncoder") &&
      lowerer.isStdlibSymbol(symbol)
    ) {
      return lowerTextCodecNew(lowerer, expr, symbol.name);
    }
    // `new Uint8Array(...)` / `new Uint32Array(...)` / `new
    // Float32Array(...)` / `new Float64Array(...)`: the typed-array
    // constructors with a runtime representation (stdlib provenance — see lowerBytesNew for the
    // lowered argument shapes; a user's own class with one of the names
    // resolves through classBySymbol below).
    const bytesNew = lowerer.lowerBytesNew(expr, symbol);
    if (bytesNew) return bytesNew;
    const info =
      (symbol ? lowerer.classBySymbol.get(symbol) : undefined) ??
      // `const C = require('./x'); new C()` over `module.exports =
      // class {…}`: the binding aliases the expression's own symbol —
      // the declaration story, collected on demand.
      propertyAssignedClassInfoOf(lowerer, symbol) ??
      undefined;
    // A rebindable decorated name constructs through its VALUE (the
    // classval-typed path below — newValue through the decoration
    // result's construct thunk), never the declaration directly.
    if (info && !info.localClass && info.classDecorators?.valueGlobalId === undefined) {
      return lowerProgramClassNew(lowerer, expr, info, loc);
    }
    // `new Map<K, V>()`: the lib Map constructor. The SEEDED forms: an
    // entries ARRAY LITERAL of PAIR LITERALS at the construction site
    // (`new Map([[k, v], ...])`) — each pair's key/value lower as
    // ordinary K/V-typed expressions and the backend set()s them in
    // order, so the tuple array never exists as a value — and a
    // `[K, V][]`-typed tuple-array VALUE (lowerMapSeedNew: a
    // construct-and-set loop, pairs in array order, duplicates
    // overwrite). Matching Maps copy their entries; nullish seeds make
    // empty Maps. General iterable seeds retain a fence. Unsupported key/value
    // types get their half named specifically instead of the component
    // fence (SC2009, which names Map slots at value positions elsewhere).
    // Both Array() and new Array() share the elements/count lowering.
    if (symbol?.name === "Object" && lowerer.isStdlibSymbol(symbol)) {
      const object = lowerObjectConstructor(lowerer, expr.arguments ?? [], loc);
      if (object) return object;
    }
    if (symbol?.name === "Array" && lowerer.isStdlibSymbol(symbol)) {
      return lowerArrayConstructor(lowerer, expr, expr.arguments ?? []);
    }
    if (symbol?.name === "Map" && lowerer.isStdlibSymbol(symbol)) {
      const seedArg = (expr.arguments?.length ?? 0) === 1 ? expr.arguments![0]! : null;
      const isPairLit = (el: ts.Expression): el is ts.ArrayLiteralExpression =>
        ts.isArrayLiteralExpression(el) &&
        el.elements.length === 2 &&
        !el.elements.some(ts.isSpreadElement);
      const entriesLit =
        seedArg && ts.isArrayLiteralExpression(seedArg) && seedArg.elements.every(isPairLit)
          ? seedArg.elements.filter(isPairLit)
          : null;
      let tsType = lowerer.typeOf(expr);
      let mapped = lowerer.mapTypeOf(tsType);
      if (mapped === null && isJsSourceFile(expr.getSourceFile())) mapped = lowerer.irTypeOf(expr);
      const fieldType = assignedThisFieldType(lowerer, expr);
      if (mapped?.kind !== "map" && fieldType?.kind === "map") mapped = fieldType;
      // A fresh map built from pair literals can use its destination's
      // layout directly. Inference may otherwise split record values
      // into incompatible shapes (for example a nullable field), even
      // though every seed fits the declared value type. Existing map or
      // tuple-array values retain their own representation.
      let parent = expr.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      // `satisfies` checks a view but retains the expression's own type.
      const contextualSeed =
        !ts.isSatisfiesExpression(parent) &&
        (expr.typeArguments?.length ?? 0) === 0 &&
        (entriesLit !== null || (expr.arguments?.length ?? 0) === 0);
      // JavaScript's `new Map()` has no type-argument syntax: the no-arg
      // constructor overload pins Map<any, any> whatever the JSDoc says
      // (`@type` on the declaration types the VARIABLE, not this
      // expression). The CONTEXTUAL type carries the annotation — adopt
      // it when it is a supported map. TS type arguments keep winning:
      // their expression type already maps.
      if (mapped?.kind !== "map" || contextualSeed) {
        const ctx = lowerer.checker.getContextualType(expr);
        const ctxMapped = ctx ? lowerer.mapTypeOf(ctx) : null;
        if (ctx && ctxMapped?.kind === "map") {
          tsType = ctx;
          mapped = ctxMapped;
        }
      }
      if (seedArg && !entriesLit && mapped?.kind === "map") {
        const seeded = lowerMapSeedNew(lowerer, seedArg, mapped);
        if (seeded) return seeded;
      }
      if ((expr.arguments?.length ?? 0) > 0 && !entriesLit) {
        lowerer.noLowering(
          "new Map(entries)",
          expr,
          "supported seeds: an array literal of [key, value] pair literals, or a " +
            "[K, V][]-typed tuple-array value, a matching collection or collection iterator, or null/undefined",
        );
      }
      if (mapped?.kind === "map") {
        if (!entriesLit) return { kind: "mapNew", type: mapped, loc };
        const seed = entriesLit.map((pair) => ({
          key: lowerer.lowerCollectionKey(pair.elements[0]!, mapped.key),
          value:
            mapped.value.kind === "dyn"
              ? lowerer.lowerCollectionKey(pair.elements[1]!, mapped.value)
              : lowerer.lowerExprExpecting(pair.elements[1]!, mapped.value),
        }));
        return { kind: "mapNew", seed, type: mapped, loc };
      }
      const targs = lowerer.checker.getTypeArguments(tsType as ts.TypeReference);
      // JAVASCRIPT `new Map()` whose arguments never resolved past
      // Map<any, any> (no annotation, no contextual type, no seed): the
      // The VALUE lowers as an opaque dyn object
      // (identity and truthiness are real), and every reached METHOD use
      // meets its own per-site fence at runtime. The formatter's
      // config-cache shape: module init constructs the caches
      // unconditionally; the format path never touches them. TypeScript
      // keeps the compile fence.
      if (
        isJsSourceFile(expr.getSourceFile()) &&
        (expr.arguments?.length ?? 0) === 0 &&
        targs.length > 0 &&
        targs.every((t) => (t.flags & ts.TypeFlags.Any) !== 0)
      ) {
        return { kind: "dynObjLit", type: DYN, loc };
      }
      const keyIr = targs[0] ? lowerer.mapTypeOf(targs[0]) : null;
      if (
        targs[0] &&
        (!keyIr ||
          !isSupportedMapKey(
            keyIr,
            keyIr.kind === "union" ? lowerer.unions.get(keyIr.unionId)?.arms : undefined,
          ))
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `Map keys of type '${lowerer.checker.typeToString(targs[0])}' ` +
            `(Map keys must be numbers, strings, booleans, bigints, identity references, or supported unions)`,
        );
      }
      if (targs[1]) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `Map values of type '${lowerer.checker.typeToString(targs[1])}' ` +
            `(Map values must be number, string, boolean, records, class instances, ` +
            `arrays, promises, Maps, Sets, or unions of those — not functions, 'unknown', or 'any')`,
        );
      }
      lowerer.badType(expr, tsType);
    }
    // Weak containers share checked native key identities and lifetime hooks.
    if (
      (symbol?.name === "WeakMap" || symbol?.name === "WeakSet") &&
      lowerer.isStdlibSymbol(symbol)
    ) {
      const args = expr.arguments ?? [];
      if (args.length > 1 || args.some(ts.isSpreadElement)) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `${symbol.name} construction with surplus or spread arguments`,
        );
      }
      if (lowerer.dynamic) {
        const ctor: IrExpr = {
          kind: "jsOp",
          op: "globalGet",
          name: symbol.name,
          args: [],
          type: JSVAL,
          loc,
        };
        return {
          kind: "jsOp",
          op: "construct",
          args: [ctor, ...args.map((arg) => lowerer.jsvalIn(lowerer.lowerExpr(arg), arg))],
          type: JSVAL,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: symbol.name === "WeakMap" ? "weakMap.new" : "weakSet.new",
        args: [args[0] ? lowerer.lowerExprExpecting(args[0], DYN) : dynUndefinedExpr(loc)],
        type: DYN,
        loc,
      };
    }
    // `new Set<T>()`: construct + bulk add from supported values,
    // including live collection cursors. Duplicates collapse in insertion order.
    if (symbol?.name === "Set" && lowerer.isStdlibSymbol(symbol)) {
      const tsType = lowerer.typeOf(expr);
      let mapped = lowerer.mapTypeOf(tsType);
      const fieldType = assignedThisFieldType(lowerer, expr);
      if (mapped?.kind !== "set" && fieldType?.kind === "set") mapped = fieldType;
      if (mapped?.kind === "set" && (expr.arguments?.length ?? 0) === 1) {
        const seeded = lowerSetSeedNew(lowerer, expr.arguments![0]!, mapped);
        if (seeded) return seeded;
      }
      if (
        !mapped &&
        isJsSourceFile(expr.getSourceFile()) &&
        (expr.arguments?.length ?? 0) <= 1 &&
        !expr.arguments?.some(ts.isSpreadElement)
      ) {
        return {
          kind: "libCall",
          fn: "dyn.nativeSetNew",
          args: [
            expr.arguments?.[0]
              ? lowerer.lowerExprExpecting(expr.arguments[0], DYN)
              : dynUndefinedExpr(loc),
          ],
          type: DYN,
          loc,
        };
      }
      // JavaScript's identity-Set idiom: `new Set([setTimeout, atob,
      // ...])` — the element TYPE (a union of stdlib signatures) has no
      // mapping, but the element VALUES all lower to identity tokens
      // (interned strings — see the JS token stance in lower-exprs), so
      // the honest construction is a Set of those scalars.
      if (
        !mapped &&
        isJsSourceFile(expr.getSourceFile()) &&
        (expr.arguments?.length ?? 0) === 1 &&
        ts.isArrayLiteralExpression(expr.arguments![0]!) &&
        !(expr.arguments![0] as ts.ArrayLiteralExpression).elements.some(ts.isSpreadElement)
      ) {
        const lit = expr.arguments![0] as ts.ArrayLiteralExpression;
        const elems = lit.elements.map((el) => lowerer.lowerExpr(el));
        const first = elems[0];
        if (
          first !== undefined &&
          (first.type.kind === "string" || first.type.kind === "f64") &&
          elems.every((e) => e.type.kind === first.type.kind)
        ) {
          const setT: IrType = { kind: "set", elem: first.type };
          const seed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(first.type), loc };
          return { kind: "setNew", seed, type: setT, loc };
        }
      }
      if ((expr.arguments?.length ?? 0) > 0) {
        lowerer.noLowering(
          "new Set(values)",
          expr,
          "construct the Set empty and add() each value — only nullish values or a matching Set, collection iterator, string, array, or fixed tuple of " +
            "supported key values seeds a Set",
        );
      }
      if (mapped?.kind === "set") return { kind: "setNew", type: mapped, loc };
      const targs = lowerer.checker.getTypeArguments(tsType as ts.TypeReference);
      if (targs[0]) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `Set elements of type '${lowerer.checker.typeToString(targs[0])}' ` +
            `(Set elements must be numbers, strings, booleans, bigints, identity references, or supported unions)`,
        );
      }
      lowerer.badType(expr, tsType);
    }
    // `new AsyncLocalStorage()` (node:async_hooks): a fresh store id —
    // an f64 handle (type-mapper.ts), the Channel story. Construction options
    // ({ defaultValue, name }) have no lowering yet.
    if (symbol?.name === "AsyncLocalStorage" && lowerer.isStdlibSymbol(symbol)) {
      if ((expr.arguments?.length ?? 0) > 0) {
        lowerer.noLowering(
          "new AsyncLocalStorage(options)",
          expr,
          "the zero-argument constructor is the supported form (defaultValue/name options have no lowering yet)",
        );
      }
      return { kind: "libCall", fn: "als.new", args: [], type: F64, loc };
    }
    // `new Promise<T>((resolve) => ...)`: the ambient Promise constructor.
    if (symbol?.name === "Promise" && lowerer.isStdlibSymbol(symbol)) {
      const type = lowerer.irTypeOf(expr);
      if (type.kind !== "promise") lowerer.badType(expr, lowerer.typeOf(expr));
      const args = expr.arguments ?? [];
      if (args.length !== 1) {
        lowerer.unsupported("SC1090", expr, "Promise construction without an executor");
      }
      // `new Promise(setImmediate)` (the Node-suite early-exit shape):
      // the executor IS the stdlib setImmediate, so resolve rides the
      // immediate queue — a dedicated runtime constructor arms an
      // immediate that fulfills with the undefined dyn value.
      {
        const a0 = args[0]!;
        if (ts.isIdentifier(a0) && a0.text === "setImmediate") {
          const sym = lowerer.checker.getSymbolAtLocation(a0);
          const decls = sym ? lowerer.checker.declarationsOf(sym) : [];
          if (decls.length > 0 && decls.every((d) => lowerer.isStdlibFile(d.getSourceFile()))) {
            // The settled value is the undefined dyn value — the result
            // is promise<dyn> whatever T the checker inferred for the
            // unusual executor (Promise<unknown> in the suite's shape).
            return {
              kind: "libCall",
              fn: "timers.immediatePromise",
              args: [],
              type: { kind: "promise", inner: DYN },
              loc,
            };
          }
        }
      }
      // Executors bind resolve alone or (resolve, reject): reject is a
      // real closure rejecting the promise with an Error reason (the
      // ambient override pins `reason: Error` — rejection payloads share
      // the thrown-value representation, and the OBJ kind keeps
      // catch-side instanceof and the uncaught printer working). First
      // settle wins, exactly JS: reject-after-resolve and double-reject
      // are no-ops, and an executor throw after any settle is swallowed.
      const executor = lowerer.lowerExpr(args[0]!);
      if (executor.type.kind !== "func") lowerer.badType(args[0]!, lowerer.typeOf(args[0]!));
      if (executor.type.params.length > 1) {
        const rj = executor.type.params[1]!;
        if (
          executor.type.params.length > 2 ||
          rj.kind !== "func" ||
          rj.ret.kind !== "void" ||
          rj.params.length !== 1 ||
          rj.params[0]!.kind !== "object" ||
          rj.params[0]!.className !== "%Error"
        ) {
          // A non-contextually-typed executor VALUE whose second param
          // isn't the pinned (reason: Error) => void shape.
          lowerer.unsupported(
            "SC1090",
            args[0]!,
            "Promise executors whose reject parameter is not '(reason: Error) => void'",
          );
        }
      }
      return { kind: "newPromise", executor, type, loc };
    }
    // The lib fence's CONSTRUCTOR chokepoint: `new` of any other
    // stdlib-declared constructor (Date, WeakMap, Proxy,
    // ArrayBuffer, RegExp, ... — and @types/node's URL, AbortController,
    // TextEncoder, ...) typechecks and reports SC2020 here. The named
    // families carry pointed hints: each states WHY no honest static
    // lowering exists (or what to use instead).
    if (lowerer.isStdlibSymbol(symbol ?? undefined)) {
      // The deprecated `new Buffer(string, encoding?)` ctor's string arm
      // with a NON-STRING first argument and a string second: Node
      // throws ERR_INVALID_ARG_TYPE synchronously (and DEP0005 never
      // fires on this throwing path, so the compiled silence matches).
      // Every other new Buffer form keeps the fence below — the
      // constructing forms would owe the deprecation warning.
      if (
        expr.expression.text === "Buffer" &&
        expr.arguments?.length === 2 &&
        !expr.arguments.some(ts.isSpreadElement) &&
        lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[0]!))?.kind !== "string" &&
        lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[1]!))?.kind === "string"
      ) {
        const first = lowerer.lowerExpr(expr.arguments[0]!);
        if (
          first.kind === "unitLit" ||
          first.type.kind === "dyn" ||
          lowerer.dynConvertible(first.type)
        ) {
          const got: IrExpr =
            first.type.kind === "dyn" ? first : { kind: "dynFrom", value: first, type: DYN, loc };
          // The encoding argument still evaluates in Node before the
          // throw only via the ctor body's later reads — it does NOT
          // observe it before throwing, so dropping it is exact for
          // effect-free operands; effectful ones keep the fence.
          const enc = lowerer.lowerExpr(expr.arguments[1]!);
          if (enc.kind === "strLit" || isSafeToRepeat(enc)) {
            return {
              kind: "libCall",
              fn: "buffer.newStringFail",
              args: [got],
              type: bytesOf("u8"),
              loc,
            };
          }
        }
      }
      const ctorHints: Record<string, string | undefined> = {
        RegExp: "use a regex literal (/pattern/flags) — constructed regexes have no lowering",
        String:
          "boxed wrapper objects have no lowering — use the string primitive (the box is only distinguishable via typeof/identity, which nothing here can honor)",
        Number: "boxed wrapper objects have no lowering — use the number primitive",
        Boolean: "boxed wrapper objects have no lowering — use the boolean primitive",
        WeakRef:
          "deref()-after-collect exposes GC timing — genuinely dynamic; hold a strong reference instead",
        FinalizationRegistry:
          "finalization callbacks expose GC timing — genuinely dynamic; release resources explicitly instead",
        SharedArrayBuffer:
          "no shared-memory threads exist in a compiled program — Uint8Array is the byte storage",
        ArrayBuffer:
          "native ArrayBuffer construction supports fixed-length storage; resizable buffers remain unsupported",
        Proxy: "native Proxy construction requires checked-native plain targets and handlers",
        Function:
          "runtime code generation cannot be compiled ahead of time (the eval stance) — write the function",
      };
      lowerer.noLowering(
        `new ${expr.expression.text}`,
        expr,
        ctorHints[
          ts.isIdentifier(expr.expression) ? expr.expression.text : expr.expression.name.text
        ],
        symbol,
      );
    }
  }
  // `new crypto.X509Certificate(data)` — the Dirent-style data record:
  // the certificate's lowered members (fingerprint — the SHA-1 of the
  // DER, uppercase colon-separated — plus the validFrom/validTo
  // validity window in Node's ASN1_TIME_print shape) compute AT
  // CONSTRUCTION, when Node parses too, so unparseable input throws
  // Node's exact PEM error here (ERR_OSSL_PEM_NO_START_LINE) and the
  // handle never exists. Both import forms (`crypto.X509Certificate`
  // through the namespace, named `X509Certificate`); Buffer input only
  // — the readFileSync idiom. mapType interns the matching record, so
  // locals and the composed member reads all flow. The data argument
  // feeds THREE field computations, so construction goes through an
  // interned helper whose parameter evaluates it exactly once.
  {
    const callee = expr.expression;
    const isX509 =
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "X509Certificate" &&
        lowerer.builtinNamespaceModuleOf(callee.expression) === "crypto") ||
      (ts.isIdentifier(callee) &&
        (() => {
          const bi = lowerer.builtinImportOf(callee);
          return bi?.module === "crypto" && bi.member === "X509Certificate";
        })());
    if (isX509) {
      const args: readonly ts.Expression[] = expr.arguments ?? [];
      if (args.length !== 1) {
        lowerer.noLowering(
          "X509Certificate with this argument shape",
          expr,
          "the supported form is new X509Certificate(readFileSync(path))",
        );
      }
      const data = lowerer.lowerExpr(args[0]!);
      const isBytes = data.type.kind === "bytes" && data.type.elem === "u8";
      if (!isBytes && data.type.kind !== "string") {
        lowerer.noLowering(
          `X509Certificate over '${lowerer.fmt(data.type)}' data`,
          args[0]!,
          "pass the certificate Buffer or PEM string (an fs.readFileSync result)",
        );
      }
      const t = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (t?.kind !== "record") lowerer.badType(expr, lowerer.typeOf(expr));
      const key = `x509.record:${isBytes ? "bytes" : "str"}`;
      let helper = lowerer.valueHelpers.get(key);
      if (!helper) {
        helper = `%x509.record.${lowerer.valueHelpers.size}`;
        lowerer.valueHelpers.set(key, helper);
        const dataT = data.type;
        const dRef: IrExpr = { kind: "varRef", localId: "d.0", type: dataT, loc };
        const field = (
          name: string,
          fn:
            | "crypto.x509Fingerprint"
            | "crypto.x509FingerprintStr"
            | "crypto.x509ValidFrom"
            | "crypto.x509ValidFromStr"
            | "crypto.x509ValidTo"
            | "crypto.x509ValidToStr",
        ): { name: string; value: IrExpr } => ({
          name,
          value: { kind: "libCall", fn, args: [dRef], type: STRING, loc },
        });
        lowerer.liftedFns.push({
          name: helper,
          params: [{ localId: "d.0", name: "d", type: dataT }],
          returnType: t,
          locals: [{ id: "d.0", name: "d", type: dataT, mutable: false }],
          body: [
            {
              kind: "return",
              value: {
                kind: "recordLit",
                fields: [
                  field(
                    "fingerprint",
                    isBytes ? "crypto.x509Fingerprint" : "crypto.x509FingerprintStr",
                  ),
                  field("validFrom", isBytes ? "crypto.x509ValidFrom" : "crypto.x509ValidFromStr"),
                  field("validTo", isBytes ? "crypto.x509ValidTo" : "crypto.x509ValidToStr"),
                ],
                type: t,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
      }
      return { kind: "call", callee: helper, args: [data], type: t, loc };
    }
  }
  // `new X(...)` through a class VALUE (a classval-typed binding, array
  // element, map read, param): the newValue dispatch through the class
  // object's construct thunk. Arguments complete against the STATIC
  // class's one constructor signature — exact for every value legally
  // in the slot (the classval widening rule pins the ABI). tsc typed
  // the site against the slot's construct signature; a UNION-typed
  // callee (unannotated heterogeneous registries) keeps a pointed
  // fence — annotate the slot with the common constructor type.
  {
    const calleeT = storedClassValueType(lowerer, expr.expression);
    if (calleeT?.kind === "classval") {
      let info = lowerer.classes.get(calleeT.className);
      if (
        !info &&
        ts.isPropertyAccessExpression(expr.expression) &&
        ts.isIdentifier(expr.expression.name)
      ) {
        // A property-assigned class expression not collected yet (this
        // body lowers ahead of the assignment statement — hoisted
        // functions): collect it on demand and retry, keeping the
        // dynamic newValue dispatch below (the runtime field value
        // decides, exactly Node under reassignment-through-aliases).
        propertyAssignedClassInfoOf(
          lowerer,
          lowerer.checker.getSymbolAtLocation(expr.expression.name),
        );
        info = lowerer.classes.get(calleeT.className);
      }
      if (!info) {
        // The TYPE world names a class the lowering never registered —
        // a fenced class expression, an abstract/deferred declaration:
        // flush its own diagnostics (they tell the real story) and
        // poison this construction site, never an ICE.
        lowerer.flushDeferredClass(calleeT.className);
        lowerer.unsupported(
          "SC1090",
          expr,
          "constructing through a class value whose class has no lowering (the class declaration itself was rejected — see its own diagnostic)",
        );
      }
      // A classval of a generic FAMILY (`new () => Box<any>` slots): no
      // single constructor ABI exists to complete against. No producer
      // can fill such a slot (family values and widenings both fence),
      // so the construction site is the honest place to name it.
      if (info.generic) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "constructing through a class value of an uninstantiated generic type (annotate the slot with a concrete instantiation — e.g. 'new (v: number) => Box<number>')",
        );
      }
      const callee = lowerer.lowerExpr(expr.expression);
      if (callee.type.kind === "dyn") return lowerCheckedConstructor(lowerer, expr, callee);
      if (callee.type.kind !== "classval")
        lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
      lowerer.noteEdge(`%${info.def.name}.constructor`);
      // Every constructor a value in this slot can dispatch to is a
      // descendant's — mark them reachable like a virtual edge.
      const below = (c: ClassInfo): void => {
        for (const s of c.subclasses) {
          lowerer.noteEdge(`%${s.def.name}.constructor`);
          below(s);
        }
      };
      below(info);
      const args = lowerer.completeArgs(expr.arguments ?? [], info.ctorParams, loc, expr);
      return {
        kind: "newValue",
        callee,
        args,
        type: { kind: "object", className: info.def.name },
        loc,
      };
    }
    if (calleeT?.kind === "union") {
      const def = lowerer.unions.get(calleeT.unionId);
      if (def?.arms.some((a) => a.kind === "classval")) {
        if (
          def.arms.every(
            (arm) =>
              arm.kind === "classval" || (isJsSourceFile(expr.getSourceFile()) && isUnitType(arm)),
          ) &&
          lowerer.dynConvertible(calleeT)
        ) {
          const callee = lowerer.lowerExprExpecting(expr.expression, DYN);
          return lowerCheckedConstructor(lowerer, expr, callee);
        }
        lowerer.unsupported(
          "SC1090",
          expr,
          "constructing through a union of class values (annotate the slot with the common constructor type — e.g. `new () => Base` — or narrow first)",
        );
      }
    }
  }
  // Declared-but-unlowered stdlib classes (fallback surface: the
  // http/https Agent): the fence points at the lowered shapes instead
  // of the generic construction rejection.
  {
    const STDLIB_CTOR_HINTS: Record<string, string | undefined> = {
      Agent:
        "constructing an http Agent through an indirect class binding (spell the construction on the module binding — new http.Agent(...)/new https.Agent(...) or the named Agent import — which lowers to the Agent handle)",
    };
    const ctorName = ts.isIdentifier(expr.expression)
      ? expr.expression
      : ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.name)
        ? expr.expression.name
        : null;
    if (ctorName !== null) {
      const raw = lowerer.checker.getSymbolAtLocation(ctorName);
      const sym =
        raw && raw.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(raw) : raw;
      const hint =
        sym && lowerer.isStdlibSymbol(sym) ? own(STDLIB_CTOR_HINTS, sym.name) : undefined;
      if (hint !== undefined) {
        lowerer.unsupported("SC1090", expr, hint);
      }
    }
  }
  // Checked construction supports emitted classes and builtin typed arrays.
  const callee = tryLowerExpression(lowerer, expr.expression);
  if (
    callee &&
    (callee.type.kind === "dyn" ||
      ((callee.type.kind === "func" || callee.type.kind === "classval") &&
        lowerer.dynConvertible(callee.type)))
  ) {
    return lowerCheckedConstructor(lowerer, expr, lowerer.coerceToExpected(callee, DYN));
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "constructing values other than classes declared in the program",
  );
}

function lowerCheckedConstructor(lowerer: Lowerer, expr: ts.NewExpression, callee: IrExpr): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  if (args.some(ts.isSpreadElement)) {
    const packed = lowerer.completeArgs(args, [{ type: DYN, mode: "dynRest" }], loc, expr)[0]!;
    return checkedClassConstructionPacked(lowerer, callee, packed, loc);
  }
  return checkedClassConstruction(
    lowerer,
    callee,
    args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    loc,
  );
}

/** A getter/setter invocation over an accessor target's receiver — the
 * same whole-program devirtualization as method calls: a virtualCall
 * when some strict subclass of the receiver's static class overrides
 * this HALF of the accessor (get and set devirtualize independently),
 * a direct call of the nearest declaration otherwise. */
export function accessorCall(
  lowerer: Lowerer,
  className: string,
  member: string,
  obj: IrExpr,
  extraArgs: IrExpr[],
  ret: IrType,
  loc: SrcLoc,
): IrExpr {
  const info = lowerer.classes.get(className);
  if (!info)
    throw new InternalCompilerError(`lowerer bug: accessor call on unknown class ${className}`);
  const found = lowerer.findMethodOn(info, member);
  if (!found) throw new InternalCompilerError(`lowerer bug: no ${member} on ${className}`);
  // The abstract direct-call fence, accessor form (see
  // lowerObjectMethodCall): an abstract accessor with no concrete
  // override below has no implementation for a direct call to target.
  if (found.sig.abstract === true && !lowerer.overrideBelow(info, member)) {
    lowerer.pushDiag(
      unsupportedDiag(
        "SC1090",
        loc,
        `${member.startsWith("get:") ? "reads" : "writes"} of the abstract accessor '${member.slice(4)}' with no concrete implementation below the receiver's static class`,
      ),
    );
    throw new PoisonError();
  }
  if (lowerer.overrideBelow(info, member)) lowerer.noteVirtualEdge(info, member);
  else lowerer.noteEdge(`%${found.declarer.def.name}.${member}`);
  if (lowerer.overrideBelow(info, member)) {
    return {
      kind: "virtualCall",
      className: info.def.name,
      method: member,
      args: [lowerer.upcastTo(obj, info.def.name), ...extraArgs],
      type: ret,
      loc,
    };
  }
  return {
    kind: "call",
    callee: `%${found.declarer.def.name}.${member}`,
    args: [lowerer.upcastTo(obj, found.declarer.def.name), ...extraArgs],
    type: ret,
    loc,
  };
}

/** The generic function-like INITIALIZER behind a class FIELD —
 * `time = async <T>(...) => {...}` or `= function g<T>(...) {...}`
 * (parens stripped): bindingGenericFnNodeOf's shape rule, member form.
 * Null when the field isn't that shape. */
function genericFieldFnNodeOf(
  member: ts.PropertyDeclaration,
): ts.FunctionExpression | ts.ArrowFunction | null {
  if (member.initializer === undefined) return null;
  let init: ts.Expression = member.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (
    (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
    init.typeParameters !== undefined &&
    init.body !== undefined
  ) {
    return init;
  }
  return null;
}
