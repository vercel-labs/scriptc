/* Call lowering: the lowerCall dispatch chain, parameter-shape analysis and
 * argument completion (optional/default/rest, explicit-undefined ≡ omission),
 * function/lambda lowering and signature collection, and monomorphizing
 * generic instantiation (bounded by MAX_GENERIC_INSTANCES). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { lowerGenMethodCall } from "./lower-generators.js";
import { BOOL, CAUGHT, DYN, F64, IrExpr, IrFunction, IrLocal, IrParam, IrStmt, IrType, JSVAL, STRING, SYMBOL_T, SrcLoc, UNDEFINED_T, VOID, arrayOf, canBoxFuncIntoDyn, canConvertToDyn, canDynCheckTo, canMarshalTypedFuncIntoIsland, ffiClassType, ffiSourceParamTypes, funcOf, isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam, isUnitType, shapeHasAccessorSlots, typeEquals } from "../../ir/nodes.js";
import type { IrFfiCallbackParam, IrFfiCallbackParamClass, IrFfiImport, IrFfiReleaseParam } from "../../ir/nodes.js";
import { isJsSourceFile, locOf } from "../program.js";
import { isGenericCallableMemberType, typeKey } from "../types.js";
import { PoisonError, dynFallbackType, dynUndefinedExpr, importCallHandleType, jsFuncNameOf, newFnCtx, nodeThrowExpr } from "./lowerer.js";
import { enforceLibBoundary } from "./lib-boundary.js";
import { NARROW_FIRST, builtinFenceHintOf, builtinModuleFnOf } from "./surfaces.js";
import { ffiBindingDiag, ffiSignatureDiag, libCallbackDiag, requiresDynamicDiag } from "../../diagnostics/diagnostic.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { mixinFnShapeOf } from "./lower-mixins.js";
import { bufEncoding, dynStringReceiver, lowerArrayFromCall, lowerDynArrayFilterCall, lowerDynArrayFlatMapCall, lowerGroupByStaticCall, lowerIteratorHelperCall, lowerObjectAssignIndexShape, lowerObjectFromEntriesCall, lowerObjectIterOverIndexShape, lowerRegexMethodCall, lowerStringMethodCall, lowerTupleReadMethodCall } from "./lower-containers.js";
import { lowerChildStreamMethodCall, lowerCreateRequireCall, lowerDirentMethodCall, lowerFileHandleMethodCall, lowerPerfHooksCall, lowerProcStreamMethodCall, lowerReflectApplyCall, lowerWatcherMethodCall } from "./lower-builtins.js";
import { droppableStatic, lowerAbsenceProbe, lowerPromiseAllTupleCall, lowerPromiseRejectCall, probeLower, templateRawTextOf } from "./lower-exprs.js";
import { httpClientFnBindingOf, isStreamUndefCallExpr, lowerCompatReqStreamOptionalCall, lowerHttpClientFnCall } from "./lower-server.js";
import { EMITTER_API_MEMBERS, exactInstanceClassOf, findGenericMethodOn, lowerClassGenericMethodCall, lowerStaticMethodCall, type ClassInfo } from "./lower-classes.js";
import { emitterRooted, lowerEmitterMethodCall } from "./lower-emitter.js";
import { lowerConsoleInspectArg, lowerFormatCall } from "./lower-inspect.js";
import { STREAM_API_MEMBERS, lowerStreamMethodCall, lowerStreamModuleCall, lowerStreamStaticCall, streamSidesOf } from "./lower-stream.js";
import { ambientNsRootOf, ambientUndefReadType, ambientUndefVarRootOf, ambientUndefinedFnSymbolOf, contextualUndefReadType, fenceEarlyAliasUse, fenceEarlyNsMemberRef, nsMemberIdentOf, nsPathPrefix, nsUndefRead } from "./lower-namespaces.js";
import { declSymbolOf } from "./lower-modules.js";
import { expandoMemberRead } from "./lower-expando.js";
import { npmStaticPackageOfPath } from "../npm-static.js";

/** How a parameter participates in CALL-SITE COMPLETION (the frontend
 * completes every call to the one full signature, so the IR and backends
 * stay count-exact — see docs/ir.md). `required` params must be passed;
 * `omittable` params (declared `x?: T` or `x: T = e`) may be omitted by a
 * trailing-suffix call, and the frontend appends the interned undefined arm;
 * `rest` (always last) receives the surplus arguments packed into one array
 * literal at each call site. */
export type ParamMode = "required" | "omittable" | "rest" | "dynRest" | "islandRest";

/** One parameter of a signature, as call sites and callee prologues see it.
 * `type` is the ABI type — what the emitted C parameter carries: the
 * checker's `T | undefined` union for `x?: T`, a synthesized `T | undefined`
 * union for `x: T = e`, `T[]` for `...xs: T[]`, the plain declared type
 * otherwise. `bodyType` is present exactly for DEFAULTED params: the plain T
 * the body sees after the prologue applies the default (see declareParams). */
export interface ParamShape {
  type: IrType;
  mode: ParamMode;
  bodyType?: IrType;
}

export interface FnSig {
  name: string;
  params: ParamShape[];
  /** Call-site result type — Promise<inner> for async functions, the
   * generator type for generator functions. */
  returnType: IrType;
  /** Async: the IrFunction's returnType is the promise's INNER type. */
  isAsync?: boolean;
  /** Generator: the IrFunction's returnType is the TReturn channel; the
   * yield/next channels ride here (IrFunction.generator's exact shape). */
  generator?: { yieldT: IrType; nextT: IrType };
}

/** Instantiation cap per generic function: same-key recursion (`len<T>`
 * calling itself) converges, but POLYMORPHIC recursion (`f<T>` calling
 * `f<T[]>`) would request new instances forever — the cap turns that into a
 * diagnostic instead of a hang. */
export const MAX_GENERIC_INSTANCES = 100;

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
   * module functions with the static-method this/super fence. Absent for
   * top-level functions and object-literal methods. */
  member?: { cls: ClassInfo; kind: "method" | "static" };
  /** Object-literal generic methods (`{ m<T>(x: T) {...} }` and generic
   * arrow/function-expression properties): lowered as plain module
   * functions — `this` inside is fenced (rejectThisInObjectMethod) and the
   * defining literal must sit at module scope (no enclosing frame to
   * capture). */
  objectLiteral?: true;
  /** IMPLICIT-ANY monomorphization (npm-static JS): parallel to
   * decl.parameters — the param's own symbol when the slot is a BINDABLE
   * implicit-any parameter (untyped, identifier-named, never written in
   * the body), null for typed or unbindable slots. Present ⇔ this info
   * monomorphizes over its implicit-any params instead of declared type
   * parameters (typeParams stays empty): each call site's WIDENED argument
   * checker types key an instantiation, exactly the generic machinery —
   * the untyped params ARE the type parameters (see implicitCallInstance). */
  implicitParams?: (ts.Symbol | null)[];
}

export interface GenericInstance {
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
  /** Implicit instances only: param symbol → the call site's (widened)
   * checker type, consulted by the Lowerer's typeOf while this instance's
   * body lowers (the implicit twin of `bindings`). */
  implicitArgTypes?: Map<ts.Symbol, ts.Type>;
  /** Implicit instances only: eager-lowering lifecycle. "lowering" while
   * the body builds (a re-demand is same-key recursion: the caller uses
   * the PINNED fallback returnType and returnPinned locks it); "done" once
   * returnType holds the inferred (or pinned) truth. */
  implicitState?: "lowering" | "done";
  /** Same-key recursion observed the fallback return type mid-lowering, so
   * the ABI is locked to it — the return post-pass coerces every return
   * value to the pinned type instead of adopting the inferred one. */
  returnPinned?: boolean;
  /** Implicit instances only: the declared return did not map (the
   * any-params poisoned it) — the body lowers in return-INFERENCE mode
   * (returnType holds the DYN recursion pin until the post-pass settles). */
  implicitInferReturn?: true;
}

/** One parameter's ParamShape — the shared signature-shaped collection
   * point for function declarations, methods, constructors, and lambdas
   * (generic declarations defer to their call sites, where the resolved
   * types exist; see lowerGenericCall).
   *
   * - `x?: T`: the checker already types the param `T | undefined` under
   *   strictNullChecks, so the ABI type IS that union and the body narrows
   *   with `!== undefined` like any union local.
   * - `x: T = e`: the ABI type is a synthesized `T | undefined` union (the
   *   caller may omit the arg or pass undefined — both trigger the default,
   *   JS-exact); the body sees plain T through the two-local prologue
   *   (declareParams). A single-arm T narrows in the prologue; a UNION T
   *   re-tags through the interned retag helper (the undefined arm is the
   *   one stranded case, unreachable from the else-branch by construction).
   * - `...xs: T[]`: the ABI type is the array; call sites pack the surplus.
   */
  export function paramShape(L: Lowerer, param: ts.ParameterDeclaration): ParamShape {
    // Island-handle params (a then-handler receiving a dynamic import's
    // namespace handle — markJsvalHandlerParams): jsval, whatever the
    // contextual type spelled.
    if (ts.isIdentifier(param.name) && L.jsvalParamOverrides.has(param)) {
      return { type: JSVAL, mode: param.questionToken ? "omittable" : "required" };
    }
    if (!ts.isIdentifier(param.name)) {
      // A destructuring pattern parameter — `([label, value]) => ...`,
      // `({ x }) => ...`. The ABI slot carries the SOURCE value (the
      // tuple/array/record itself); the callee prologue desugars the reads
      // through the declaration-destructuring machinery (declareParams →
      // lowerBindingPattern), so the fences inside patterns (computed
      // keys, class-instance sources, union sources) are the declaration
      // fences verbatim. A rest parameter bound to a pattern would need
      // the packing machinery on top — fenced.
      if (param.questionToken) {
        L.unsupported("SC1031", param, "optional destructuring pattern parameters");
      }
      if (param.dotDotDotToken) {
        // A REST parameter bound to a pattern (`(...[[k1, v1]]: [string,
        // number][])`): the ABI packs the surplus arguments into one
        // array exactly like an identifier rest param; the prologue then
        // destructures the packed array through the declaration
        // machinery (declareParams → lowerBindingPattern).
        const type = L.irTypeOf(param.name);
        const tupleRest = type.kind === "record" && L.shapes.get(type.shapeId)?.tuple === true;
        if (type.kind !== "array" && !tupleRest) L.badType(param.name, L.typeOf(param.name));
        return { type, mode: "rest" };
      }
      if (param.initializer) {
        // A WHOLE-PATTERN default (`({ x } = { x: 1 }) => ...`): the ABI
        // slot arms the pattern's type with undefined, exactly the
        // identifier-param default below; the callee prologue picks the
        // default when the argument was omitted or undefined, then the
        // pattern destructures the picked value (declareParams).
        const raw = L.irTypeOf(param.name);
        // A DYNAMIC-TIER pattern source (`function f({} = a)` with
        // `a: any` — jsval for island values, dyn for the checked-dynamic
        // dyn): the slot holds its tier's undefined DIRECTLY, so the ABI
        // is the slot itself — no synthesized union; the prologue tests
        // undefined at runtime (declareParams).
        if (raw.kind === "dyn" || raw.kind === "jsval") {
          return { type: raw, mode: "omittable", bodyType: raw };
        }
        const bodyType = L.stripUndefinedArm(raw);
        L.checkDefaultParamBodyType(param, bodyType);
        const abi = bodyType.kind === "union" ? L.withUndefinedArmOf(bodyType) : L.withUndefinedArm(bodyType);
        if (!abi) {
          L.badType(param.name, L.typeOf(param.name)); // defensive: unknown union id
        }
        return { type: abi, mode: "omittable", bodyType };
      }
      return { type: L.irTypeOf(param.name), mode: "required" };
    }
    if (param.dotDotDotToken) {
      // A JS rest param with no static element type (`(...args)` — any[]):
      // the VARIADIC dyn form. The lifted function takes one trailing dyn
      // ARRAY param the dyn call thunk fills with the call's surplus
      // arguments; the binding is that array (dynRest — funcType marks
      // `rest`, and the value only ever calls through the boxed thunk).
      if (isJsSourceFile(param.getSourceFile())) {
        const restMapped = L.mapTypeOf(L.typeOf(param.name));
        // `any[]` under --dynamic maps to an island-element array — that
        // is inference residue, not element information; the binding is
        // the ENGINE's own arguments array (an island handle) and the
        // value crosses as a REST host function (the withPlugins
        // `async (...args) =>` shape). Static builds keep the variadic
        // dyn form for every unmappable JS rest.
        if (restMapped?.kind === "array" && restMapped.elem.kind === "jsval" && L.dynamic) {
          return { type: JSVAL, mode: "islandRest" };
        }
        if (restMapped?.kind !== "array") {
          return { type: DYN, mode: "dynRest" };
        }
      }
      const type = L.irTypeOf(param.name);
      // Tuple-typed rest params don't map to an array; generic rest is the
      // generic path's business. Anything non-array here is unmappable.
      if (type.kind !== "array") L.badType(param.name, L.typeOf(param.name));
      return { type, mode: "rest" };
    }
    if (param.initializer) {
      const raw = L.irTypeOf(param.name);
      // A DYNAMIC-TIER defaulted param (`function f(x = a)` with `a: any`
      // — tsc types x any; jsval for island values, dyn for the checked-
      // dynamic dyn): the slot holds its tier's undefined directly, so
      // the ABI is the slot itself and the prologue's default test is the
      // runtime undefined test (declareParams).
      if (raw.kind === "dyn" || raw.kind === "jsval") {
        return { type: raw, mode: "omittable", bodyType: raw };
      }
      // A default that may ITSELF be undefined (`x = process.env.FOO`):
      // tsc keeps undefined in the body's type, so there is nothing to
      // narrow — the ABI union IS the body type and the prologue passes a
      // present argument through unchanged (declareParams's pass-through
      // branch). The generic strip-and-narrow below would demand a
      // `string`-typed default and fence on the union re-tag.
      if (L.bareUndefinedArmedUnion(raw)) {
        const initT = L.mapTypeOf(L.typeOf(param.initializer));
        if (initT && (initT.kind === "undefinedT" || L.bareUndefinedArmedUnion(initT))) {
          return { type: raw, mode: "omittable", bodyType: raw };
        }
      }
      const bodyType = L.stripUndefinedArm(raw);
      L.checkDefaultParamBodyType(param, bodyType);
      // A UNION body type (`tlds: string | string[] = "localhost"`) arms
      // the ABI with undefined ON TOP of the body's arms; the prologue
      // re-tags a present argument back into the body union (undefined
      // sorts last among arm typeKeys in practice, so the mapping is
      // usually the identity prefix — the interned retag helper handles
      // any order).
      const abi = bodyType.kind === "union" ? L.withUndefinedArmOf(bodyType) : L.withUndefinedArm(bodyType);
      if (!abi) {
        L.badType(param.name, L.typeOf(param.name)); // defensive: unknown union id
      }
      return { type: abi, mode: "omittable", bodyType };
    }
    const type = L.irTypeOf(param.name);
    if (param.questionToken && !L.bareUndefinedArmedUnion(type) && type.kind !== "dyn" && type.kind !== "jsval") {
      // `x?: unknown` where unknown came from an annotation: undefined is
      // absorbed into the hole type, so no undefined ARM exists — but a
      // checked-dynamic slot holds the dyn undefined directly (`bar?: any`
      // — an omitted call passes it, undefinedArgFor), and an island slot
      // the engine's own undefined likewise (`options?: [string?]` — an
      // optional-tuple param, jsval-mapped), so dyn and jsval params stay
      // omittable.
      L.unsupported("SC1090", param, `optional parameters of type '${L.fmt(type)}'`);
    }
    return { type, mode: param.questionToken ? "omittable" : "required" };
  }

/** ParamShapes for a whole parameter list. */
/** A `this` PARAMETER declaration (`function f(this: void, x: {}) ...`)
   * — type-world only: tsc types the receiver with it, callers never pass
   * it, and signature.getParameters() excludes it. The syntactic walks
   * (paramShapes, declareParams) skip it with this predicate so ABI slots
   * and call completion stay aligned with what JS actually passes. */
  export function isThisParameter(param: ts.ParameterDeclaration): boolean {
    return ts.isIdentifier(param.name) && param.name.text === "this";
  }

  export function paramShapes(L: Lowerer, params: readonly ts.ParameterDeclaration[]): ParamShape[] {
    return params.filter((p) => !isThisParameter(p)).map((param) => L.paramShape(param));
  }

/** The fences on a defaulted parameter's body type: it becomes the value
   * arm of the synthesized `T | undefined` ABI union, so it must be a valid
   * single arm. func and Set ARE valid here: the ABI union's only test is
   * the prologue's own undefined-tag check (never a user narrowing, which
   * is what keeps map/set out of general unions), so `runner: Runner =
   * defaultRunner` and `skip: Set<string> = new Set()` arm like any ref
   * kind — the nullable-callback union shape, built by the compiler. */
  export function checkDefaultParamBodyType(L: Lowerer, param: ts.ParameterDeclaration, bodyType: IrType): void {
    if (
      bodyType.kind === "void" ||
      bodyType.kind === "map" ||
      bodyType.kind === "regex" ||
      bodyType.kind === "date" ||
      bodyType.kind === "dyn" ||
      bodyType.kind === "jsval" ||
      isUnitType(bodyType)
    ) {
      L.unsupported(
        "SC1090",
        param,
        `parameter default values on '${L.fmt(bodyType)}'-typed parameters`,
      );
    }
  }

/** CALL-SITE COMPLETION — the frontend half of the one-signature contract
   * (docs/ir.md): every call lowers to exactly the callee's full ABI
   * parameter list, so backends and the validator stay count-exact and no
   * runtime arity machinery exists. Omitted trailing args for omittable
   * params become the interned undefined arm (which is also what an
   * explicitly-passed `undefined` wraps to — both trigger a default, JS-
   * exact); a rest param packs the surplus args (possibly zero) into one
   * array literal, evaluated in source order at the call site. */
  export function completeArgs(L: Lowerer, argNodes: readonly ts.Expression[],
    shapes: readonly ParamShape[],
    loc: SrcLoc,
    blame: ts.Node,
    /** Pre-lowered values virtually PREPENDED to the argument list — the
     * tagged-template strings object, which has no ts.Expression to lower
     * (lowerTaggedTemplate builds it). Each rides the same slot-directed
     * coercion an ordinary argument gets (coerceInto against its shape,
     * DYN conversion in a dyn rest, element coercion in a typed rest). */
    leading?: readonly IrExpr[],): IrExpr[] {
    type ArgSource = ts.Expression | { ir: IrExpr };
    const isIr = (s: ArgSource | undefined): s is { ir: IrExpr } =>
      s !== undefined && !("kind" in s);
    const sources: readonly ArgSource[] =
      leading && leading.length > 0 ? [...leading.map((ir) => ({ ir })), ...argNodes] : argNodes;
    const restAt = shapes.findIndex((s) => s.mode === "rest" || s.mode === "dynRest" || s.mode === "islandRest");
    const positional = restAt >= 0 ? shapes.slice(0, restAt) : [...shapes];
    const out: IrExpr[] = positional.map((shape, i) => {
      const src = sources[i];
      if (isIr(src)) return L.coerceInto(blame, src.ir, shape.type);
      const arg = src;
      if (arg && ts.isSpreadElement(arg)) {
        // A spread landing on FIXED parameter positions would need the
        // array's length to decide arity at runtime — the compile-time
        // completion has no home for that. Spreads fill REST slots only.
        L.unsupported(
          "SC1090",
          arg,
          "spread arguments into fixed parameter positions (a spread can only fill a rest parameter)",
        );
      }
      if (arg) return L.lowerExprExpecting(arg, shape.type);
      if (shape.mode !== "omittable") {
        // A missing argument for a CHECKED-DYNAMIC param (an implicit-any
        // JS signature called short — `mustCall(fn)` with `expected`
        // omitted): JS fills undefined, and the dyn slot holds exactly
        // that — the undefined dyn value. tsc's arity families don't gate
        // .js builds (SEMANTICS.md 116), so the completion lands here.
        if (shape.type.kind === "dyn") {
          return { kind: "dynFrom", value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, type: DYN, loc };
        }
        // tsc's arity checking admits omitting only the omittable suffix;
        // reaching here means a call form we don't model — defensive.
        L.unsupported("SC1090", blame, "this call form");
      }
      return L.undefinedArgFor(shape.type, loc, blame);
    });
    if (restAt >= 0 && shapes[restAt]!.mode === "islandRest") {
      // The ISLAND variadic pack: surplus arguments marshal into one
      // fresh ENGINE array — exactly what the REST host-call adapter
      // hands the closure for indirect calls.
      const elems = sources.slice(restAt).map((a): IrExpr => {
        if (isIr(a)) return L.coerceInto(blame, a.ir, JSVAL);
        if (ts.isSpreadElement(a)) {
          L.unsupported("SC1090", a, "spread arguments into an island rest parameter");
        }
        return L.lowerExprExpecting(a, JSVAL);
      });
      out.push({ kind: "jsOp", op: "arrLit", args: elems, type: JSVAL, loc });
    } else if (restAt >= 0 && shapes[restAt]!.mode === "dynRest") {
      // The VARIADIC dyn pack (a JS `...args` with no static element
      // type, or the synthetic `arguments` slot): surplus arguments
      // convert through the dyn boundary into one fresh dyn array —
      // exactly what the boxed call thunk builds for indirect calls.
      const elems = sources.slice(restAt).map((a): IrExpr => {
        if (isIr(a)) return L.coerceInto(blame, a.ir, DYN);
        if (ts.isSpreadElement(a)) {
          L.unsupported("SC1090", a, "spread arguments into a dynamic rest parameter");
        }
        return L.lowerExprExpecting(a, DYN);
      });
      out.push({ kind: "dynArrLit", elems, type: DYN, loc });
    } else if (restAt >= 0) {
      const restType = shapes[restAt]!.type;
      // A TUPLE-typed rest (`(...[x, y]: [number, number])` — the pattern
      // rest form): tsc pins the call to exactly the tuple's arity, so
      // the pack is a positional record literal. Spreads stay fenced —
      // their length is a runtime fact the fixed shape cannot take.
      if (restType.kind === "record") {
        const tupleShape = L.shapes.get(restType.shapeId);
        if (tupleShape?.tuple) {
          const rest = sources.slice(restAt);
          if (rest.some((a) => !isIr(a) && ts.isSpreadElement(a)) || rest.length !== tupleShape.fields.length) {
            L.unsupported("SC1090", blame, "spread or arity-mismatched arguments into a tuple-typed rest parameter");
          }
          out.push({
            kind: "recordLit",
            fields: rest.map((a, i) => {
              const f = tupleShape.fields.find((x) => x.name === String(i))!;
              return { name: f.name, value: isIr(a) ? L.coerceInto(blame, a.ir, f.type) : L.lowerExprExpecting(a, f.type) };
            }),
            type: restType,
            loc,
          });
          return out;
        }
      }
      if (restType.kind !== "array") L.unsupported("SC1090", blame, "this call form");
      // The rest pack is a fresh array per call; surplus SPREADS copy
      // their elements in (JS-exact — `f(a, ...xs, b, ...ys)` packs in
      // order, sources untouched).
      const spreads: number[] = [];
      const elems = sources.slice(restAt).map((a, i) => {
        if (isIr(a)) return L.coerceInto(blame, a.ir, restType.elem);
        if (ts.isSpreadElement(a)) {
          let src = L.lowerExpr(a.expression);
          // A same-element Set spread drains first (setIntrinsic toArray).
          if (src.type.kind === "set" && typeEquals(src.type.elem, restType.elem)) {
            src = { kind: "setIntrinsic", method: "toArray", receiver: src, args: [], type: arrayOf(src.type.elem), loc: locOf(a) };
          }
          // A CLASS ITERABLE spread (`foo(...new SymbolIterator)`) drains
          // through its protocol into a fresh array (classIteratorDrainCall).
          if (src.type.kind === "object") {
            const drained = L.classIteratorDrainCall(src, locOf(a), restType.elem);
            if (drained) src = drained;
          }
          // Same-family arrays whose element lifts reshape through the
          // interned width helper (the array-literal spread rule).
          if (src.type.kind === "array" && !typeEquals(src.type, restType)) {
            const w = L.widthCoerce(src, restType);
            if (w) src = w;
          }
          if (!typeEquals(src.type, restType)) {
            L.unsupported(
              "SC1090",
              a,
              `spreading '${L.fmt(src.type)}' into a '${L.fmt(restType)}' rest parameter (only a same-element-type array spreads)`,
            );
          }
          spreads.push(i);
          return src;
        }
        return L.lowerExprExpecting(a, restType.elem);
      });
      out.push({ kind: "arrayLit", elems, ...(spreads.length > 0 ? { spreads } : {}), type: restType, loc });
    } else {
      // Surplus args without a rest param: JS evaluates them in order and
      // DROPS them (tsc's arity families don't gate .js builds —
      // SEMANTICS.md 116, so `f(a, b, c, d)` against `function f(a, b, c)`
      // reaches here). The completed call has no slot for them — pushing
      // them through would break the one-signature contract (the validator
      // catches exactly that). Effect-free lowerings (literals, plain
      // reads, closures — the recordLit drop-field list) drop at compile
      // time, JS-exact; an EFFECTFUL surplus (a call, an await, an
      // assignment) has no evaluation slot in an expression-position
      // completion, so it fences by name rather than silently not running.
      for (let i = positional.length; i < sources.length; i++) {
        const a = sources[i]!;
        if (isIr(a)) continue; // pre-lowered leading values are effect-free
        if (ts.isSpreadElement(a)) {
          L.unsupported(
            "SC1090",
            a,
            "spread arguments into fixed parameter positions (a spread can only fill a rest parameter)",
          );
        }
        const v = L.lowerExpr(a);
        if (
          v.kind !== "unitLit" && v.kind !== "numLit" && v.kind !== "strLit" &&
          v.kind !== "boolLit" && v.kind !== "varRef" && v.kind !== "closure"
        ) {
          L.unsupported(
            "SC1090",
            a,
            "surplus arguments with side effects (JS evaluates surplus arguments to a function without a rest parameter, then drops them; only effect-free surplus arguments compile)",
          );
        }
      }
    }
    return out;
  }

/** The undefined arm of an undefined-armed union `type`, wrapped (a
   * unitLit under a unionWrap) — the value every "absent" slot holds: an
   * omitted optional argument, an omitted optional record field. Null when
   * `type` has no undefined arm to wrap into. */
  export function wrappedUndefined(L: Lowerer, type: IrType, loc: SrcLoc): IrExpr | null {
    const unit: IrExpr = { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
    const wrapped = L.coerceToExpected(unit, type);
    return wrapped.kind === "unionWrap" ? wrapped : null;
  }

/** The synthesized argument for an omitted omittable param: the interned
   * undefined arm of the param's `T | undefined` ABI union, or the checked-dynamic tree
   * undefined for a checked-dynamic param (`bar?: any`). */
/** The "absent argument" value for a param SLOT type, or null when the
   * slot cannot hold one: the interned undefined arm for undefined-armed
   * unions, the dyn undefined for checked-dynamic slots, the engine's own
   * undefined for island slots. Shared by every call-completion loop
   * (direct calls and calls through func-typed values). */
  export function omittedArgFor(L: Lowerer, type: IrType, loc: SrcLoc): IrExpr | null {
    if (type.kind === "dyn") return dynUndefinedExpr(loc);
    if (type.kind === "jsval") return { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc };
    return L.wrappedUndefined(type, loc);
  }

  export function undefinedArgFor(L: Lowerer, type: IrType, loc: SrcLoc, blame: ts.Node): IrExpr {
    if (type.kind === "dyn") return dynUndefinedExpr(loc);
    // An omitted argument for an ISLAND-typed omittable param (`f()` where
    // f's `x = a` default is jsval-shaped): the engine's own undefined.
    if (type.kind === "jsval") return { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc };
    const wrapped = L.wrappedUndefined(type, loc);
    if (!wrapped) {
      // Omittable params always carry an undefined-armed union (paramShape
      // guarantees it) — defensive.
      L.unsupported("SC1090", blame, "this call form");
    }
    return wrapped;
  }

/** DECISION (docs/ir.md): function VALUES keep exact-arity semantics — a
   * func-typed IrType spells one completed signature, so a function whose
   * declaration has optional/default/rest parameters can become a value only
   * where the target type spells that exact signature with required
   * parameters (`x?: T` / `x: T = e` params appear as literal `T | undefined`
   * unions; a rest signature is never spellable without `...`, which func
   * types reject). Direct calls get the full feature. */
  export function requireExactArityValue(L: Lowerer, blame: ts.Node,
    contextual: ts.Expression | null,
    shapes: readonly ParamShape[],
    funcType: IrType,): void {
    // dynRest params ride the boxed thunk (JS arity — no completed-ABI
    // spelling exists or is needed); they don't gate the value form.
    // Dynamic-tier omittable params (`{} = a` with `a: any` — jsval/dyn
    // slots) don't either: their ABI slot IS the declared param type (no
    // synthesized union), so every func-type spelling of the signature
    // already matches and short calls through the value complete with the
    // tier's undefined (omittedArgFor).
    if (
      shapes.every(
        (s) =>
          s.mode === "required" ||
          s.mode === "dynRest" ||
          s.mode === "islandRest" ||
          (s.mode === "omittable" && (s.type.kind === "dyn" || s.type.kind === "jsval")),
      )
    ) {
      return;
    }
    if (shapes.some((s) => s.mode === "rest")) {
      L.unsupported("SC1090", blame, "functions with rest parameters as values (call them directly)");
    }
    // The type the value FLOWS under must spell the completed ABI: the
    // contextual (target) type when one exists, otherwise the expression's
    // OWN inferred type — the unannotated-const case (`const f = (x = 5) =>
    // ...`), where every later read types the value by that inference and
    // optional/defaulted params spell their `T | undefined` slots (mapType's
    // completed-signature contract), so omitted trailing args complete with
    // the undefined arm like any direct call.
    const target = contextual ? L.checker.getContextualType(contextual) : undefined;
    const mapped = target
      ? L.mapTypeOf(target)
      : contextual
        ? L.mapTypeOf(L.typeOf(contextual))
        : null;
    if (mapped && typeEquals(mapped, funcType)) return;
    // A union-typed slot (`runner || defaultRunner` under a
    // `CommandRunner | undefined` context): the value can only inhabit
    // the union's one func arm — judge by it.
    let mappedFn: IrType | null =
      mapped?.kind === "union"
        ? (() => {
            const arms = L.unions.get(mapped.unionId)?.arms.filter((a) => a.kind === "func") ?? [];
            return arms.length === 1 ? arms[0]! : null;
          })()
        : mapped;
    // A contextual type that maps to something non-functional (`picked ||
    // defaultRunner` — tsc's contextual answer for the rhs is not the
    // slot): judge by the expression's OWN completed type; the slot's
    // coercion still enforces (or adapts) the flow it lands in.
    if (mappedFn?.kind !== "func" && contextual) {
      mappedFn = L.mapTypeOf(L.typeOf(contextual));
    }
    if (mappedFn && typeEquals(mappedFn, funcType)) return;
    // A target signature that agrees on the completed parameters and
    // differs only by RETURNING the structural spawnSync-result record
    // (the CommandRunner shape): the slot coercion bridges with the
    // interned runner-value adapter, so the value passes here.
    if (
      mappedFn?.kind === "func" &&
      funcType.kind === "func" &&
      L.spawnResFnAdapterPlan(funcType, mappedFn) !== null
    ) {
      return;
    }
    // An 'any'-typed slot is the ISLAND boundary: the host-function
    // trampoline already implements JS call semantics over the completed
    // signature — a missing engine argument arrives as undefined and takes
    // the omittable param's undefined arm (which is what triggers the
    // default), surplus arguments drop. So a function with optional/
    // defaulted params may flow into a package API whenever the completed
    // signature can cross at all (jsvalIn re-checks and speaks otherwise) —
    // commander's `.option(flags, desc, collector, [])` pattern.
    if (mapped?.kind === "jsval" &&
      canMarshalTypedFuncIntoIsland(funcType, (id) => L.shapes.get(id), (id) => L.unions.get(id))
    ) {
      return;
    }
    L.unsupported(
      "SC1090",
      blame,
      "functions with optional or defaulted parameters as values, except where the " +
        "target type spells the completed signature with required parameters " +
        "(a '(x?: T) => R' function flows into a '(x: T | undefined) => R' slot, " +
        "and a package/'any' slot takes any signature that can cross the island " +
        "boundary; otherwise call the function directly)",
    );
  }

/** The BODY-facing return type of a (possibly async) function: an async
   * body's `return v` fulfills its promise with v, so the body returns the
   * promise's INNER type while call sites keep Promise<T>. The declared
   * type of an async function is always a promise (collectSignature /
   * lowerLambda reject anything else before calling this). */
  export function bodyReturnType(L: Lowerer, isAsync: boolean, declared: IrType): IrType {
    return isAsync && declared.kind === "promise" ? declared.inner : declared;
  }

/** A union-returning body may complete WITHOUT returning — JS yields
   * undefined then (`(): string | undefined => { if (c) return "x"; }`), so
   * an undefined-armed union return gets a trailing `return <undefined
   * arm>` appended unless the body's last statement already returns or
   * throws (deeper always-returning control flow keeps the appended return
   * as dead code — harmless).
   *
   * Every OTHER non-void body gets a trailing UNREACHABLE trap instead:
   * tsc's reachability can prove completions the validator's conservative
   * alwaysReturns cannot (an exhaustive `switch (typeof x)` with a return
   * in every case — signature 16), and those bodies end without a terminal
   * statement of their own. The trap satisfies the must-return rule as the
   * dead code it is; it can only fire if the checker's proof was violated,
   * which would be a lowering bug — hence the please-report wording. */
  export function appendImplicitUndefinedReturn(L: Lowerer, body: IrStmt[],
    bodyReturn: IrType, loc: SrcLoc,): void {
    if (bodyReturn.kind === "void") return;
    const last = body[body.length - 1];
    if (last && (last.kind === "return" || last.kind === "throw" || last.kind === "rethrow" || last.kind === "runtimeFence")) {
      return;
    }
    // A DYN body that can complete without returning (a JS function whose
    // guarded return may not run — mustSucceed's `if (typeof fn ===
    // 'function') return fn.apply(...)`): JS completes with undefined —
    // the undefined dyn value.
    if (bodyReturn.kind === "dyn") {
      body.push({
        kind: "return",
        value: { kind: "dynFrom", value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, type: DYN, loc },
        loc,
      });
      return;
    }
    if (bodyReturn.kind === "union") {
      const value = L.wrappedUndefined(bodyReturn, loc);
      if (value) {
        body.push({ kind: "return", value, loc });
        return;
      }
      // no undefined arm: the trap below stands in, exactly like non-unions
    }
    body.push({
      kind: "runtimeFence",
      code: "SC9002",
      message:
        "unreachable: a non-void function completed without returning " +
        "(the checker proved every path returns) — please report this",
      loc,
    });
  }

/** A declaration's checker-derived IR return type. The unmappable-type
   * diagnostic points at `blame` (the name for top-level declarations, the
   * whole node for lambda-likes — preserving each caller's historical loc). */
  export function declaredReturnType(L: Lowerer, decl: ts.SignatureDeclaration, blame: ts.Node): IrType {
    const sig = L.checker.getSignatureFromDeclaration(decl);
    if (!sig) L.unsupported("SC1090", decl, "this function form");
    const retTsType = L.checker.getReturnTypeOfSignature(sig);
    // A body that always throws infers `never` — as a RETURN type that is
    // void with a stronger guarantee (`() => never` is assignable to
    // `() => void`), and throw-only callbacks are ordinary code
    // (`.action(() => { throw ... })`). `never` VALUES stay unmapped.
    if (retTsType.flags & ts.TypeFlags.Never) return VOID;
    // A JS function whose UNANNOTATED return infers a FUNCTION type
    // (test/common's mustCall — tsc infers `() => any` from the wrapper
    // it returns): the inferred arity is the wrapper's spelling, not a
    // contract — JS callers call the result however they like, and a
    // static func slot would force an arity-narrowing adapter that DROPS
    // arguments. Function-valued results stay checked-dynamic (dyn): the
    // value rides its own box, calls go through the boxed thunk (JS
    // arity), and typed slots re-check with dynCheck as usual.
    if (
      isJsSourceFile(decl.getSourceFile()) &&
      decl.type === undefined &&
      L.mapTypeOf(retTsType)?.kind === "func"
    ) {
      return DYN;
    }
    // The RECORD twin (the tracing suite's traced closures — `function ()
    // { return expectedResult; }` infers `{ foo: string }`): JS object
    // literals are checked-dynamic VALUES, so a record-typed return would
    // copy the dyn value into a struct at the return and copy it back out
    // at any dyn boundary — identity lost twice (found.result !==
    // expectedResult where Node passes the object through). The inferred
    // shape is inference, not a contract: the return stays checked-
    // dynamic, and typed consumers re-check with dynCheck as usual.
    // GATED to the untyped-wrapper shape — every parameter itself
    // checked-dynamic (or none): a lambda with RECORD-typed parameters
    // (a reduce reducer over a typed array) legitimately returns its
    // parameters' records and keeps the static type.
    if (
      isJsSourceFile(decl.getSourceFile()) &&
      decl.type === undefined &&
      L.mapTypeOf(retTsType)?.kind === "record" &&
      decl.parameters.every((p) => {
        const mt = L.mapTypeOf(L.typeOf(p));
        return mt === null || mt.kind === "dyn";
      })
    ) {
      return DYN;
    }
    const returnType = L.mapTypeOf(retTsType);
    if (!returnType) {
      // JS inference residue (an `any` return, an unmappable union): the
      // checked-dynamic fallback, exactly the declaration story in
      // irTypeOf — callers' typed slots re-check with dynCheck.
      const js = dynFallbackType(L, decl, retTsType);
      if (js) return js;
      fenceGenericSignatureResult(L, blame, retTsType);
      L.badType(blame, retTsType);
    }
    return returnType;
  }

/** A RESULT position whose type is itself a generic signature (`const
   * satisfies = <T>() => <N extends T>(n: N) => n` — the call's result
   * keeps type parameters): the returned value is a fresh generic value
   * per call, the pinned/unpinned rule applies at the result, and nothing
   * here can pin it — the value would also need the producing call's
   * frame, which module-function instances cannot capture. Named fence
   * instead of the generic supported-types recitation; a no-op for every
   * other unmappable type (the caller's badType reports those). */
  function fenceGenericSignatureResult(L: Lowerer, blame: ts.Node, t: ts.Type): void {
    const parts = t.isUnionType() ? t.getTypes() : [t];
    if (!parts.some((p) => L.checker.getCallSignatures(p).some((s) => (s.typeParameters?.length ?? 0) > 0))) {
      return;
    }
    L.unsupported(
      "SC1090",
      blame,
      `results that are themselves generic functions ('${L.checker.typeToString(t)}' keeps its type parameters — no call-site instantiation pins them, and the returned value would need the producing call's frame; restructure to one generic function taking all arguments)`,
    );
  }

export function collectSignature(L: Lowerer, decl: ts.FunctionDeclaration): void {
    L.collectDeferring(
      () => declSymbolOf(L, decl),
      () => L.collectSignatureInner(decl),
    );
  }

export function collectSignatureInner(L: Lowerer, decl: ts.FunctionDeclaration): void {
    // The one legal nameless declaration form is `export default function
    // () {}` — its symbol is the module's default export (declSymbolOf)
    // and it registers under the synthetic "%default" spelling.
    if (!decl.name && declSymbolOf(L, decl) === undefined) {
      L.unsupported("SC1090", decl, "anonymous function declarations");
    }
    // A body-less declaration is type-world and lowers to NOTHING: an
    // OVERLOAD SIGNATURE when an implementation shares the symbol (the
    // implementation's own collection registers the one real ABI — tsc
    // resolved every call site against the signatures, and the
    // implementation's parameter types are supersets by the
    // overload-compatibility rules, so calls flow through that ABI), or an
    // AMBIENT `declare function` nothing defines (references compile to
    // Node's ReferenceError at the use site — the `declare const` /
    // ambient-namespace undefRead stance, ambientUndefinedFnSymbolOf).
    if (!decl.body) return;
    // A MIXIN function (`function M(Base: T) { return class extends Base
    // {…} }`) has no callable signature of its own — its return type is a
    // per-call class, so calls instantiate per site (lower-mixins.ts) and
    // nothing ever dispatches through an ABI. Recognized here so the
    // declaration neither registers a broken signature nor lowers as a
    // body (run()/discover() skip by the same test). Generic mixins still
    // register their generic signature below: non-mixin-shaped calls
    // degrade to the generic machinery's own per-site fences.
    if (!decl.typeParameters && mixinFnShapeOf(L, decl)) return;
    const isAsync = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
    const isGenerator = decl.asteriskToken !== undefined;
    if (isGenerator && isAsync) {
      L.unsupported("SC1071", decl, "async generators (async function*)");
    }
    if (decl.typeParameters) {
      // Generic async composes: each monomorphized instance is an async
      // IrFunction like any other — its own spawn wrapper, its body
      // returning the resolved promise's inner (lowerGenericInstance).
      L.collectGenericSignature(decl);
      return;
    }
    // IMPLICIT-ANY monomorphization (npm-static JS): a function whose
    // signature carries bindable untyped params registers like a generic
    // declaration — no ABI of its own, one instance per call-site type
    // tuple (see the implicit-monomorphization section). Everything that
    // routes generic declarations (direct calls, namespace/CJS member
    // calls, value references) resolves it through genericFnsBySymbol
    // unchanged.
    if (implicitMonoFile(decl.getSourceFile()) && !isAsync && !isGenerator) {
      const implicit = implicitAnyParamSymbolsOf(L, decl);
      if (implicit) {
        const nameText = decl.name?.text ?? "%default";
        const symbol = declSymbolOf(L, decl);
        if (!symbol) L.unsupported("SC1090", decl, "this function form");
        L.genericFnsBySymbol.set(symbol, {
          decl,
          baseName: nameText,
          qualifiedName: L.qualify(decl.getSourceFile(), nsPathPrefix(decl) + nameText),
          typeParams: [],
          instances: new Map(),
          implicitParams: implicit,
        });
        return;
      }
    }

    const params = L.paramShapes(decl.parameters);
    // The VARIADIC `arguments` form on a DECLARED function: same rule as
    // lambdas (lambdaSignature) — zero declared params, the body reads
    // `arguments`, a synthetic trailing dynRest shape carries the call's
    // arguments (completeArgs packs direct calls; the boxed thunk packs
    // indirect ones; lowerFunction declares the `arguments` local).
    if (
      !params.some((sh) => sh.mode === "dynRest") &&
      isJsSourceFile(decl.getSourceFile()) &&
      bodyReadsArguments(decl)
    ) {
      if (decl.parameters.length > 0) {
        L.unsupported(
          "SC1090",
          decl,
          "'arguments' in functions with declared parameters (use a rest parameter: (...args))",
        );
      }
      params.push({ type: DYN, mode: "dynRest" });
    }
    const nameBlame: ts.Node = decl.name ?? decl;
    const returnType = L.declaredReturnType(decl, nameBlame);
    if (isAsync && returnType.kind !== "promise") {
      L.badType(nameBlame, L.typeOf(nameBlame));
    }
    if (isGenerator && returnType.kind !== "generator") {
      L.badType(nameBlame, L.typeOf(nameBlame));
    }

    const symbol = declSymbolOf(L, decl);
    if (!symbol) L.unsupported("SC1090", decl, "this function form");
    L.fnSigsBySymbol.set(symbol, {
      // Namespace-nested functions carry the namespace path (nsPathPrefix)
      // so `namespace A { export function f }` and a top-level `f` never
      // collide. The anonymous default export takes the synthetic
      // "%default" spelling ('%' cannot appear in a user identifier).
      name: L.qualify(decl.getSourceFile(), nsPathPrefix(decl) + (decl.name?.text ?? "%default")),
      params,
      returnType,
      isAsync,
      ...(isGenerator && returnType.kind === "generator"
        ? { generator: { yieldT: returnType.yieldT, nextT: returnType.nextT } }
        : {}),
    });
  }

/** Registers a top-level generic function. Only the SYNTAX is checked
   * here — parameter/return types mention the type parameters and cannot
   * map yet; the body is lowered per instantiation, on demand (an unused
   * generic function costs nothing, like a C++ template). Called inside
   * collectSignature's poison catch. */
  export function collectGenericSignature(L: Lowerer, decl: ts.FunctionDeclaration): void {
    const typeParams: ts.Symbol[] = [];
    for (const tp of decl.typeParameters!) {
      // Defaults (`<T = number>`) are supported: call sites receive
      // default-substituted types from getResolvedSignature already, and
      // inferTypeParamBindings binds any still-unbound parameter from its
      // mapped defaultType.
      const sym = L.checker.getSymbolAtLocation(tp.name);
      if (!sym) L.unsupported("SC1090", decl, "this function form");
      typeParams.push(sym);
    }
    // Only NAME syntax is checkable here; optional/default/rest shapes are
    // computed per call site from the resolved signature (lowerGenericCall).
    // Binding-PATTERN parameters (`retry<T>(fn, { retries = 3 } = {})`)
    // pass: declareParams desugars patterns per instance exactly as it
    // does for non-generic functions.
    for (const param of decl.parameters) {
      if (!ts.isIdentifier(param.name) && !ts.isObjectBindingPattern(param.name) && !ts.isArrayBindingPattern(param.name)) {
        L.unsupported("SC1031", param);
      }
    }
    const nameText = decl.name?.text ?? "%default"; // nameless = the default export (checked by collectSignatureInner)
    const symbol = declSymbolOf(L, decl);
    if (!symbol) L.unsupported("SC1090", decl, "this function form");
    L.genericFnsBySymbol.set(symbol, {
      decl,
      baseName: nameText,
      qualifiedName: L.qualify(decl.getSourceFile(), nsPathPrefix(decl) + nameText),
      typeParams,
      instances: new Map(),
    });
  }

export function genericFnOf(L: Lowerer, ident: ts.Identifier): GenericFnInfo | null {
    const symbol = L.resolveValueSymbol(ident);
    return symbol ? (L.genericFnsBySymbol.get(symbol) ?? null) : null;
  }

/** Call of a generic top-level function. The checker already inferred (or
   * was told, via explicit type arguments) the concrete signature —
   * getResolvedSignature returns it with type arguments substituted. The
   * mapped param+return IR types form the INSTANTIATION KEY; the first call
   * with a new key queues the body for monomorphic lowering as
   * `<qualifiedName>%<n>`, and every call lowers to a direct `call` of that
   * instance. */
  export function lowerGenericCall(L: Lowerer, expr: ts.CallExpression, info: GenericFnInfo): IrExpr {
    const loc = locOf(expr);
    const instance = info.implicitParams
      ? implicitCallInstance(L, expr, info)
      : genericCallInstance(L, expr, info);
    const args = L.completeArgs(expr.arguments, instance.params, loc, expr);
    return { kind: "call", callee: instance.name, args, type: instance.returnType, loc };
  }

/** The instance a CALL of a generic function-like names: resolved
   * signature → mapped param shapes/return → interned instance. Shared by
   * top-level generic calls, class generic-method calls (the caller
   * prepends the receiver), and object-literal generic-method calls. */
  export function genericCallInstance(L: Lowerer, expr: ts.CallExpression, info: GenericFnInfo): GenericInstance {
    const rsig = L.checker.getResolvedSignature(expr);
    // A GENERIC function with overload signatures: the call resolved to a
    // signature that is not the implementation's, so the per-instantiation
    // body lowering would type the body against parameter/return types it
    // was never checked under. Named fence until generic overloads get an
    // honest story (monomorphize per implementation signature with the
    // reconcile bridge, like the non-generic path).
    {
      const rdecl = rsig ? L.checker.signatureDeclaration(rsig) : undefined;
      if (rdecl && (ts.isFunctionDeclaration(rdecl) || ts.isMethodDeclaration(rdecl)) && !rdecl.body) {
        L.unsupported("SC1090", expr, `calls selecting an overload signature of a generic ${ts.isMethodDeclaration(rdecl) ? "method" : "function"} (only the implementation signature monomorphizes)`);
      }
    }
    if (!rsig || rsig.getParameters().length !== info.decl.parameters.length) {
      L.unsupported("SC1090", expr, "this call form");
    }
    // Per-param shapes from the RESOLVED signature (types substituted) plus
    // the declaration's modes: rest stays the resolved array, a default's
    // ABI union is synthesized over the resolved body type — exactly the
    // paramShape rules, applied to post-substitution types.
    const params: ParamShape[] = [];
    rsig.getParameters().forEach((p, i) => {
      const declParam = info.decl.parameters[i]!;
      const pt = L.checker.getTypeOfSymbol(p);
      const mapped = L.mapTypeOf(pt);
      if (!mapped || mapped.kind === "void") L.badType(expr.arguments[i] ?? expr, pt);
      if (declParam.dotDotDotToken) {
        if (mapped.kind !== "array") L.badType(expr.arguments[i] ?? expr, pt);
        params.push({ type: mapped, mode: "rest" });
      } else if (declParam.initializer) {
        if (mapped.kind === "dyn" || mapped.kind === "jsval") {
          // Dynamic-tier default: the slot holds its tier's undefined
          // directly (paramShape's rule — declareParams tests at runtime).
          params.push({ type: mapped, mode: "omittable", bodyType: mapped });
        } else {
          const bodyType = L.stripUndefinedArm(mapped);
          L.checkDefaultParamBodyType(declParam, bodyType);
          params.push({ type: L.withUndefinedArm(bodyType), mode: "omittable", bodyType });
        }
      } else {
        if (declParam.questionToken && !L.bareUndefinedArmedUnion(mapped)) {
          L.unsupported("SC1090", declParam, `optional parameters of type '${L.fmt(mapped)}'`);
        }
        params.push({ type: mapped, mode: declParam.questionToken ? "omittable" : "required" });
      }
    });
    const retTs = L.checker.getReturnTypeOfSignature(rsig);
    const returnType = L.mapTypeOf(retTs);
    if (!returnType) {
      fenceGenericSignatureResult(L, expr, retTs);
      L.badType(expr, retTs);
    }

    // keyof-constrained type parameters (`K extends keyof T`): the bound
    // LITERAL is semantic — the instance body reads the named field — so
    // the bindings compute EAGERLY (the key needs them) and each literal
    // keys its own instance (`pick(o, "a")` and `pick(o, "b")` map to the
    // same IR signature when the fields agree, but their bodies read
    // different fields). Non-literal bindings (a key union, plain string)
    // share one runtime-keyed instance per IR signature, exactly the
    // widened discipline.
    const keyofTps = keyofConstrainedTypeParams(info);
    if (keyofTps.size > 0) {
      const tsBindings = new Map<ts.Symbol, ts.Type>();
      const bindings = L.inferTypeParamBindings(expr, info, rsig, tsBindings);
      const litKey = info.typeParams
        .filter((tp) => keyofTps.has(tp))
        .map((tp) => {
          const bound = tsBindings.get(tp);
          return bound?.isStringLiteralType() ? JSON.stringify(bound.value)
            : bound?.isNumberLiteralType() ? String(bound.value)
            : "*";
        })
        .join(",");
      return internGenericInstance(L, expr, info, params, returnType, () => bindings, {
        extraKey: `@${litKey}`,
        tsBindings,
      });
    }
    return internGenericInstance(L, expr, info, params, returnType, (tsBindings) =>
      L.inferTypeParamBindings(expr, info, rsig, tsBindings),
    );
  }

/** The one instance table both instantiation routes share: key identity IS
   * signature identity, so a call (`identity(1)`) and a pinned VALUE
   * (`const f: (x: number) => number = identity`) reuse one compiled
   * instance. `makeBindings` runs only for a NEW key (binding inference
   * costs checker walks). */
  export function internGenericInstance(L: Lowerer, blame: ts.Node,
    info: GenericFnInfo,
    params: ParamShape[],
    returnType: IrType,
    makeBindings: (tsBindings: Map<ts.Symbol, ts.Type>) => Map<ts.Symbol, IrType>,
    opts?: { extraKey?: string; tsBindings?: Map<ts.Symbol, ts.Type> },): GenericInstance {
    // keyof-constrained instantiations append their literal keys
    // (extraKey): the IR signature alone under-discriminates there — two
    // literals can map to one IR signature while their bodies read
    // different fields.
    const key = `${params.map((s) => typeKey(s.type)).join(",")}=>${typeKey(returnType)}${opts?.extraKey ?? ""}`;
    let inst = info.instances.get(key);
    if (!inst) {
      if (info.instances.size >= MAX_GENERIC_INSTANCES) {
        L.unsupported(
          "SC1090",
          blame,
          `unbounded generic instantiation ('${info.baseName}' exceeded ` +
            `${MAX_GENERIC_INSTANCES} instances — polymorphic recursion?)`,
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
          return bound ? L.fmt(bound) : tp.name;
        })
        .join(", ");
      // Deep polymorphic recursion renders unbounded types — keep messages sane.
      const typeArgsText = `<${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered}>`;
      inst = {
        name: `${info.qualifiedName}%${info.instances.size}`,
        ordinal: info.instances.size,
        params,
        returnType,
        bindings,
        tsBindings,
        typeArgsText,
      };
      info.instances.set(key, inst);
      L.instantiationQueue.push({ info, inst });
    }
    return inst;
  }

/** The type parameters of `info` declared with a `keyof` CONSTRAINT
   * (`K extends keyof T`) — the parameters whose bound literal is semantic
   * (the body's `o[k]` reads the named field), computed once per info from
   * the declaration's syntax. */
  export function keyofConstrainedTypeParams(info: GenericFnInfo): Set<ts.Symbol> {
    if (info.keyofTps) return info.keyofTps;
    const out = new Set<ts.Symbol>();
    info.decl.typeParameters?.forEach((tpDecl, i) => {
      const sym = info.typeParams[i];
      if (!sym || tpDecl.constraint === undefined) return;
      if (ts.isTypeOperatorNode(tpDecl.constraint) && tpDecl.constraint.operator === ts.SyntaxKind.KeyOfKeyword) {
        out.add(sym);
      }
    });
    info.keyofTps = out;
    return out;
  }

/** Type-parameter symbol → concrete IR type for one instantiation.
   * Explicit type arguments bind directly; the rest come from structurally
   * matching each DECLARED param/return type (which mentions the type
   * parameters) against the checker's INSTANTIATED one — the latter is the
   * former with the substitution applied, so the shapes are parallel by
   * construction. A type parameter left unbound only matters if the body
   * mentions it, where mapType fails and badType names the shape
   * (carrying the instantiation context). */
  export function inferTypeParamBindings(L: Lowerer, expr: ts.CallExpression,
    info: GenericFnInfo,
    rsig: ts.Signature,
    tsBindings?: Map<ts.Symbol, ts.Type>,): Map<ts.Symbol, IrType> {
    const bindings = new Map<ts.Symbol, IrType>();
    expr.typeArguments?.forEach((ta, i) => {
      const tp = info.typeParams[i];
      if (!tp) return;
      const taT = L.checker.getTypeFromTypeNode(ta);
      const mapped = L.mapTypeOf(taT);
      if (mapped && mapped.kind !== "void") {
        bindings.set(tp, mapped);
        tsBindings?.set(tp, taT);
      }
    });
    unifySignatureBindings(L, info, rsig, bindings, tsBindings);
    bindDefaultTypeParams(L, info.typeParams, info.decl.typeParameters, bindings, tsBindings);
    return bindings;
  }

/** Type parameters still unbound after unification take their declared
   * DEFAULT (`<T = number>`), mapped — the checker already substituted the
   * default into every resolved signature, so this only fills the bindings
   * an instance body's mapType consults. */
  export function bindDefaultTypeParams(L: Lowerer, typeParams: readonly ts.Symbol[],
    typeParamDecls: readonly ts.TypeParameterDeclaration[] | undefined,
    bindings: Map<ts.Symbol, IrType>,
    tsBindings?: Map<ts.Symbol, ts.Type>,): void {
    typeParamDecls?.forEach((tpDecl, i) => {
      const tp = typeParams[i];
      if (!tp || bindings.has(tp) || !tpDecl.defaultType) return;
      const defT = L.checker.getTypeFromTypeNode(tpDecl.defaultType);
      const mapped = L.mapTypeOf(defT);
      if (mapped && mapped.kind !== "void") {
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
  export function unifySignatureBindings(L: Lowerer, info: GenericFnInfo,
    rsig: ts.Signature,
    bindings: Map<ts.Symbol, IrType>,
    tsBindings?: Map<ts.Symbol, ts.Type>,): void {
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
            tsBindings.set(sym, L.typeParamTsResolver(inst) ?? inst);
          }
          if (!bindings.has(sym)) {
            const mapped = L.mapTypeOf(inst);
            if (mapped && mapped.kind !== "void") bindings.set(sym, mapped);
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
        const dParts = declared.getTypes().filter((t) => !(t.flags & unitFlags));
        const iParts: readonly ts.Type[] = inst.isUnionType() ? inst.getTypes().filter((t) => !(t.flags & unitFlags)) : [inst];
        if (dParts.length === 1 && iParts.length === 1) unify(dParts[0]!, iParts[0]!, depth + 1);
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
        const dArgs = L.checker.getTypeArguments(dRef);
        const iArgs = L.checker.getTypeArguments(iRef);
        dArgs.forEach((da, i) => {
          const ia = iArgs[i];
          if (ia) unify(da, ia, depth + 1);
        });
        return;
      }
      if (L.checker.isArrayType(declared) && L.checker.isArrayType(inst)) {
        const dElem = L.checker.getTypeArguments(declared as ts.TypeReference)[0];
        const iElem = L.checker.getTypeArguments(inst as ts.TypeReference)[0];
        if (dElem && iElem) unify(dElem, iElem, depth + 1);
        return;
      }
      const dSigs = L.checker.getCallSignatures(declared);
      const iSigs = L.checker.getCallSignatures(inst);
      if (dSigs.length === 1 && iSigs.length === 1) {
        const ds = dSigs[0]!;
        const is = iSigs[0]!;
        ds.getParameters().forEach((dp, i) => {
          const ip = is.getParameters()[i];
          if (ip) unify(L.checker.getTypeOfSymbol(dp), L.checker.getTypeOfSymbol(ip), depth + 1);
        });
        unify(L.checker.getReturnTypeOfSignature(ds), L.checker.getReturnTypeOfSignature(is), depth + 1);
        return;
      }
      if (declared.flags & ts.TypeFlags.Object) {
        for (const dp of L.checker.getPropertiesOfType(declared)) {
          const ip = L.checker.getPropertyOfType(inst, dp.name);
          if (ip) unify(L.checker.getTypeOfSymbol(dp), L.checker.getTypeOfSymbol(ip), depth + 1);
        }
      }
    };

    const declSig = L.checker.getSignatureFromDeclaration(info.decl);
    if (declSig) {
      declSig.getParameters().forEach((dp, i) => {
        const ip = rsig.getParameters()[i];
        if (ip) unify(L.checker.getTypeOfSymbol(dp), L.checker.getTypeOfSymbol(ip));
      });
      unify(
        L.checker.getReturnTypeOfSignature(declSig),
        L.checker.getReturnTypeOfSignature(rsig),
      );
    }
  }

/** Lowers ONE monomorphic instance of a generic function: the same body
   * AST, re-lowered with the type parameters bound (threaded into every
   * mapType call via typeParamResolver — the checker keeps reporting the
   * unsubstituted `T`s inside the body). Coverage stats count a base
   * function's statements once: only the FIRST instance contributes. */
  export function lowerGenericInstance(L: Lowerer, info: GenericFnInfo, inst: GenericInstance): IrFunction {
    const decl = info.decl;
    const cls = info.member?.cls ?? null;
    const prevBindings = L.typeParamBindings;
    const prevContext = L.instantiationContext;
    const prevSuppress = L.suppressStats;
    const prevClass = L.currentClass;
    const prevImplicit = L.implicitParamTypes;
    // A generic METHOD of a generic-class INSTANTIATION lowers under BOTH
    // binding sets: the receiver instantiation's class type parameters
    // underneath, the method instantiation's own on top (disjoint symbol
    // sets — tsc rejects shadowing a class type parameter in a method).
    const clsBindings = cls?.genericInstance?.bindings;
    L.typeParamBindings = clsBindings
      ? new Map([...clsBindings, ...inst.bindings])
      : inst.bindings;
    // The ts-level bindings ride along: `T[K]` and literal-keyed `o[k]`
    // reads inside the body resolve through the bound CHECKER types
    // (typeParamTsResolver). Generic-class instantiations carry no
    // ts-level bindings (their type arguments widened at the reference),
    // so only the method instantiation's own map installs.
    const prevTsBindings = L.typeParamTsBindings;
    L.typeParamTsBindings = inst.tsBindings ?? null;
    // Implicit-any instances thread their param bindings through typeOf
    // (the checker reports `any` inside the body — there is no T for
    // mapType to substitute); see the implicit-monomorphization section.
    L.implicitParamTypes =
      info.implicitParams !== undefined ? (inst.implicitArgTypes ?? new Map()) : null;
    L.instantiationContext = `instantiating '${info.baseName}' with ${inst.typeArgsText}`;
    // Coverage counts a generic source body once: re-instantiations of the
    // method AND re-instantiations of the declaring generic class re-visit
    // the same source lines.
    L.suppressStats = inst.ordinal > 0 || (cls?.genericInstance?.ordinal ?? 0) > 0;
    // A generic ASYNC instance is an async IrFunction like any other: the
    // body returns the resolved promise's INNER type, calls enter through
    // the instance's own spawn wrapper (the emitter routes by fn.async),
    // and awaits park this instance's fibers.
    const isAsync = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
    const nameBlame: ts.Node = (ts.isArrowFunction(decl) ? undefined : decl.name) ?? decl;
    if (isAsync && inst.returnType.kind !== "promise") {
      L.badType(nameBlame, L.checker.getTypeAtLocation(nameBlame));
    }
    // A generic GENERATOR instance mirrors async: the body returns the
    // resolved TReturn channel, calls enter through the instance's own
    // gen-spawn wrapper (the emitter routes by fn.generator).
    const isGenerator = decl.asteriskToken !== undefined;
    if (isGenerator && isAsync) {
      L.unsupported("SC1071", decl, "async generators (async function*)");
    }
    if (isGenerator && inst.returnType.kind !== "generator") {
      L.badType(nameBlame, L.checker.getTypeAtLocation(nameBlame));
    }
    let bodyReturn = isGenerator
      ? L.genBodyReturnType(inst.returnType)
      : L.bodyReturnType(isAsync, inst.returnType);
    const fnCtx = newFnCtx(false, null, null, bodyReturn);
    fnCtx.isAsync = isAsync;
    // Implicit-any instances whose declared return did not map lower in
    // return-INFERENCE mode: `return` statements record here bare, and the
    // post-pass (resolveInferredReturn) settles the type and wraps them.
    if (inst.implicitInferReturn) fnCtx.inferReturn = { entries: [] };
    if (cls && info.member!.kind === "method") L.currentClass = cls;
    if (isGenerator && inst.returnType.kind === "generator") {
      fnCtx.generator = { yieldT: inst.returnType.yieldT, nextT: inst.returnType.nextT };
    }
    L.fnStack.push(fnCtx);
    try {
      // STATIC generic methods: `this`/`super` name the RECEIVER class (a
      // dynamic value) — the lowerStaticMethod fence, applied here because
      // generic statics have no non-generic lowering pass. Arrow functions
      // are transparent (they inherit the method's `this`); this-binding
      // function forms are opaque.
      if (info.member?.kind === "static" && decl.body) {
        const checkThis = (n: ts.Node): void => {
          if (
            ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) ||
            ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
            ts.isGetAccessor(n) || ts.isSetAccessor(n) ||
            ts.isClassDeclaration(n) || ts.isClassExpression(n)
          ) {
            return;
          }
          if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) {
            L.unsupported(
              "SC1090",
              n,
              `'${n.kind === ts.SyntaxKind.ThisKeyword ? "this" : "super"}' in static methods (it names the RECEIVER class — a dynamic value; reference the class by name instead)`,
            );
          }
          n.forEachChild(checkThis);
        };
        decl.body.forEachChild(checkThis);
      }
      const params: IrParam[] = [];
      if (cls && info.member!.kind === "method") {
        // Instance methods take `this` as param 0, exactly like plain
        // `%C.method` functions (lowerClassMethodMemberInner).
        const thisType: IrType = { kind: "object", className: cls.def.name };
        const thisLocal = L.declareThis(thisType);
        params.push({ localId: thisLocal.id, name: "this", type: thisType });
      }
      // Default-param initializers lower per instance, with the bindings
      // threaded — a default mentioning T resolves like any body expression.
      const declared = L.declareParams(decl.parameters, inst.params);
      params.push(...declared.params);
      const body = [...declared.prologue];
      const bodyBlock = blockBodyOf(decl);
      if (bodyBlock) {
        body.push(...L.lowerStmts(bodyBlock.statements));
        if (fnCtx.inferReturn) {
          bodyReturn = resolveInferredReturn(L, inst, fnCtx.inferReturn, body, decl);
        }
        appendImplicitUndefinedReturn(L, body, bodyReturn, locOf(decl));
      } else if (ts.isArrowFunction(decl) && decl.body !== undefined && !ts.isBlock(decl.body)) {
        // A concise arrow body: the expression IS the return value —
        // generic properties (`id: <T>(x: T) => x`), and implicit-any
        // local arrows (`(cmd) => [cmd.name()].concat(cmd.aliases())`),
        // whose inferred return is simply the expression's own type.
        if (fnCtx.inferReturn) {
          const value = L.lowerExpr(decl.body);
          if (value.type.kind === "void") {
            body.push({ kind: "exprStmt", expr: value, loc: locOf(decl.body) });
            bodyReturn = resolveInferredReturn(L, inst, fnCtx.inferReturn, body, decl);
            appendImplicitUndefinedReturn(L, body, bodyReturn, locOf(decl));
          } else {
            const stmt: IrStmt = { kind: "return", value, loc: locOf(decl.body) };
            fnCtx.inferReturn.entries.push({ stmt, node: decl.body });
            body.push(stmt);
            bodyReturn = resolveInferredReturn(L, inst, fnCtx.inferReturn, body, decl);
          }
        } else {
          const value = L.lowerExprExpecting(decl.body, bodyReturn);
          if (bodyReturn.kind === "void") {
            body.push({ kind: "exprStmt", expr: value, loc: locOf(decl.body) });
          } else {
            body.push({ kind: "return", value, loc: locOf(decl.body) });
          }
        }
      } else {
        L.unsupported("SC1090", decl, "function declarations whose block body the frontend cannot locate");
      }
      const fn: IrFunction = {
        name: inst.name,
        params,
        returnType: bodyReturn,
        locals: L.ctx.locals,
        body,
        loc: locOf(decl),
      };
      if (isAsync) fn.async = true;
      if (fnCtx.generator) fn.generator = fnCtx.generator;
      return fn;
    } finally {
      L.fnStack.pop();
      L.currentClass = prevClass;
      L.typeParamBindings = prevBindings;
      L.typeParamTsBindings = prevTsBindings;
      L.implicitParamTypes = prevImplicit;
      L.instantiationContext = prevContext;
      L.suppressStats = prevSuppress;
    }
  }

/** The return-inference post-pass of an implicit-any instance: unify the
   * recorded return statements' value types into the instance's settled
   * return type, then wrap each return to it — arm values wrap into the
   * union, dyn-convertible values ride dynFrom, and a value that cannot
   * ride the settled type converts ITS return statement into the standard
   * per-statement runtime fence (JS sources defer fences to runtime).
   *
   * The settled type: the one distinct value type when every return
   * agrees; `T | undefined` when a bare `return;` or possible fallthrough
   * adds JS's undefined; DYN when returns disagree (the checked-dynamic
   * result slot — today's shape). Same-key recursion PINNED the fallback
   * type mid-lowering (callers already hold it), so a pinned instance
   * keeps it and the wrap pass coerces every return to the pin. */
  function resolveInferredReturn(L: Lowerer, inst: GenericInstance,
    infer: NonNullable<import("./lowerer.js").FnCtx["inferReturn"]>,
    body: IrStmt[],
    decl: ts.Node,): IrType {
    // The conservative completion test appendImplicitUndefinedReturn uses:
    // a body whose last statement isn't a terminator may complete without
    // returning — JS answers undefined.
    const last = body[body.length - 1];
    const mayFallThrough =
      !last || !(last.kind === "return" || last.kind === "throw" || last.kind === "rethrow" || last.kind === "runtimeFence");
    const valued = infer.entries.filter(
      (e): e is { stmt: IrStmt & { kind: "return"; value: IrExpr }; node: ts.Expression | null } =>
        e.stmt.kind === "return" && e.stmt.value !== null && e.stmt.value !== undefined,
    );
    const sawBare =
      mayFallThrough || infer.entries.some((e) => e.stmt.kind === "return" && (e.stmt.value === null || e.stmt.value === undefined));
    let final: IrType;
    if (inst.returnPinned) {
      final = inst.returnType;
    } else {
      const distinct: IrType[] = [];
      for (const e of valued) {
        if (!distinct.some((t) => typeEquals(t, e.stmt.value.type))) distinct.push(e.stmt.value.type);
      }
      if (distinct.length === 0) {
        final = DYN; // no valued return: JS completes with undefined — the dyn undefined, today's slot
      } else if (distinct.length === 1) {
        const t = distinct[0]!;
        final = !sawBare ? t : t.kind === "dyn" ? DYN : (L.withUndefinedArmOf(t) ?? DYN);
      } else {
        final = DYN; // disagreeing returns: the checked-dynamic join
      }
      inst.returnType = final;
    }
    // The wrap pass: settle every recorded return onto `final`, in place.
    for (const e of infer.entries) {
      if (e.stmt.kind !== "return") continue;
      const st = e.stmt as IrStmt & { kind: "return"; value: IrExpr | null };
      const diagsBefore = L.diags.length;
      try {
        if (st.value === null || st.value === undefined) {
          if (final.kind === "dyn") st.value = dynUndefinedExpr(st.loc);
          else if (final.kind === "union") {
            const wrapped = L.wrappedUndefined(final, st.loc);
            if (!wrapped) {
              L.unsupported("SC1090", e.node ?? decl, `bare 'return' in a function whose inferred return type is '${L.fmt(final)}'`);
            }
            st.value = wrapped;
          }
          // void final: bare return stands as-is
        } else if (!typeEquals(st.value.type, final)) {
          st.value = L.coerceInto(e.node ?? decl, st.value, final);
        }
      } catch (err) {
        if (!(err instanceof PoisonError)) throw err;
        // The per-return fence: this value cannot ride the settled type —
        // executing THIS return throws the recorded reason (the JS
        // per-statement deferral, applied to one return of an instance).
        const captured = L.diags.splice(diagsBefore);
        const ice = captured.filter((d) => d.code === "SC9001");
        if (ice.length > 0) L.diags.push(...ice);
        L.runtimeFences.push(...captured.filter((d) => d.code !== "SC9001"));
        const first = captured.find((d) => d.code !== "SC9001");
        const mutable = st as unknown as Record<string, unknown>;
        delete mutable["value"];
        mutable["kind"] = "runtimeFence";
        mutable["code"] = first?.code ?? "SC1090";
        mutable["message"] = first
          ? `${first.message} [${first.code}]`
          : "this return value has no lowering onto the instance's settled return type [SC1090]";
      }
    }
    return final;
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
  export function lowerGenericFnValue(L: Lowerer, ref: ts.Expression, info: GenericFnInfo): IrExpr {
    const loc = locOf(ref);
    // An IMPLICIT-ANY function taken as a VALUE: indirect calls carry no
    // per-site types to bind, so the value is the all-dyn DEFAULT
    // instance's closure — today's compiled body exactly (one interned
    // closure per function, so `f === f` holds like any declaration).
    if (info.implicitParams) {
      const inst = implicitDefaultInstance(L, ref, info);
      const funcType: IrType = {
        kind: "func",
        params: inst.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
        ret: inst.returnType,
        ...(inst.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
      };
      L.requireExactArityValue(ref, ref, inst.params, funcType);
      L.noteEdge(inst.name);
      return { kind: "closure", fnName: inst.name, captures: [], type: funcType, loc };
    }
    const fenceUnpinned: () => never = () =>
      L.unsupported(
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
      ? L.typeOf(ref)
      : L.checker.getContextualType(ctxNode);
    let target: ts.Signature | null = null;
    if (pinT) {
      const sigs = L.checker.getCallSignatures(pinT);
      if (sigs.length === 1) target = sigs[0]!;
      else if (sigs.length === 0 && pinT.isUnionType()) {
        // A `Fn | undefined`-flavored slot: the value can only inhabit the
        // one callable arm — judge by it (the requireExactArityValue union
        // rule).
        const callable = pinT.getTypes().map((t) => L.checker.getCallSignatures(t)).filter((s) => s.length === 1);
        if (callable.length === 1) target = callable[0]![0]!;
      }
    }
    if (!target) fenceUnpinned();
    const bindings = new Map<ts.Symbol, IrType>();
    unifySignatureBindings(L, info, target, bindings);
    bindDefaultTypeParams(L, info.typeParams, info.decl.typeParameters, bindings);
    // A pinning signature that itself keeps type parameters (`let g: <T>(x:
    // T) => T = identity` — storing the generic signature as such) binds
    // nothing: mapType answers null for an unsubstituted parameter.
    if (info.typeParams.some((tp) => !bindings.get(tp))) fenceUnpinned();
    const inst = genericValueInstance(L, ref, info, bindings);
    // The value's type is the completed ABI signature — exact-arity, the
    // declared-function value rule (dynRest slots stay out of the param
    // list; the rest marker carries the trailing dyn-array ABI).
    const funcType: IrType = {
      kind: "func",
      params: inst.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
      ret: inst.returnType,
      ...(inst.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
    };
    L.requireExactArityValue(ref, ref, inst.params, funcType);
    L.noteEdge(inst.name);
    return { kind: "closure", fnName: inst.name, captures: [], type: funcType, loc };
  }

/** The instance a pinned VALUE reference names: the declaration's modes
   * over the DECLARED types mapped under the bindings (mapType's resolver
   * substitutes — the instance-body trick), which is the same result the
   * call path computes from the resolved signature, so both routes land on
   * one instance per key. */
  function genericValueInstance(L: Lowerer, ref: ts.Expression,
    info: GenericFnInfo,
    bindings: Map<ts.Symbol, IrType>,): GenericInstance {
    const prevBindings = L.typeParamBindings;
    const prevContext = L.instantiationContext;
    const rendered = info.typeParams
      .map((tp) => {
        const bound = bindings.get(tp);
        return bound ? L.fmt(bound) : tp.name;
      })
      .join(", ");
    L.typeParamBindings = bindings;
    L.instantiationContext = `instantiating '${info.baseName}' with <${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered}>`;
    try {
      const declSig = L.checker.getSignatureFromDeclaration(info.decl);
      if (!declSig) L.unsupported("SC1090", ref, "this function form");
      const params: ParamShape[] = [];
      info.decl.parameters.forEach((declParam, i) => {
        const p = declSig.getParameters()[i];
        const pt = p ? L.checker.getTypeOfSymbol(p) : L.typeOf(declParam.name);
        const mapped = L.mapTypeOf(pt);
        if (!mapped || mapped.kind === "void") L.badType(declParam.name, pt);
        if (declParam.dotDotDotToken) {
          if (mapped.kind !== "array") L.badType(declParam.name, pt);
          params.push({ type: mapped, mode: "rest" });
        } else if (declParam.initializer) {
          if (mapped.kind === "dyn" || mapped.kind === "jsval") {
            // Dynamic-tier default: the slot holds its tier's undefined
            // directly (paramShape's rule).
            params.push({ type: mapped, mode: "omittable", bodyType: mapped });
          } else {
            const bodyType = L.stripUndefinedArm(mapped);
            L.checkDefaultParamBodyType(declParam, bodyType);
            params.push({ type: L.withUndefinedArm(bodyType), mode: "omittable", bodyType });
          }
        } else {
          if (declParam.questionToken && !L.bareUndefinedArmedUnion(mapped)) {
            L.unsupported("SC1090", declParam, `optional parameters of type '${L.fmt(mapped)}'`);
          }
          params.push({ type: mapped, mode: declParam.questionToken ? "omittable" : "required" });
        }
      });
      const retTs = L.checker.getReturnTypeOfSignature(declSig);
      const returnType = L.mapTypeOf(retTs);
      if (!returnType) {
        fenceGenericSignatureResult(L, ref, retTs);
        L.badType(ref, retTs);
      }
      return internGenericInstance(L, ref, info, params, returnType, () => bindings);
    } finally {
      L.typeParamBindings = prevBindings;
      L.instantiationContext = prevContext;
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
 *      a value cannot ride it. Bounded: MAX_GENERIC_INSTANCES per
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
  function paramWrittenInBody(L: Lowerer, body: ts.Node, sym: ts.Symbol, name: string): boolean {
    let written = false;
    const targetsSym = (e: ts.Expression): boolean => {
      let n: ts.Expression = e;
      while (ts.isParenthesizedExpression(n)) n = n.expression;
      if (ts.isIdentifier(n) && n.text === name) {
        return L.checker.getSymbolAtLocation(n) === sym;
      }
      // Destructuring-assignment patterns ([a] = xs, {a} = o): any
      // identifier inside the target literal counts (conservative — a
      // nested `a.b` member write through the pattern is a write THROUGH,
      // not a rebind, but patterns are rare enough to over-approximate).
      if (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) {
        let hit = false;
        const scan = (m: ts.Node): void => {
          if (hit) return;
          if (ts.isIdentifier(m) && m.text === name && L.checker.getSymbolAtLocation(m) === sym) {
            hit = true;
            return;
          }
          m.forEachChild(scan);
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
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
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
      n.forEachChild(walk);
    };
    walk(body);
    return written;
  }

/** The implicit-type-parameter slots of a JS function-like: parallel to
   * decl.parameters, the param SYMBOL where the slot is a bindable
   * implicit-any param (identifier-named, no annotation/JSDoc type, not
   * rest/optional/defaulted, never written), null elsewhere. Null overall
   * when nothing qualifies — the declaration keeps today's path. */
  export function implicitAnyParamSymbolsOf(L: Lowerer,
    decl: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,): (ts.Symbol | null)[] | null {
    if (!decl.body) return null;
    if (decl.asteriskToken) return null;
    if (decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
    if (decl.typeParameters !== undefined) return null; // real generics own the machinery
    if (decl.parameters.length === 0) return null;
    // The variadic-`arguments` form keeps its dynRest story whole.
    if (bodyReadsArguments(decl)) return null;
    let any = false;
    const out = decl.parameters.map((param): ts.Symbol | null => {
      if (!ts.isIdentifier(param.name)) return null;
      if (param.dotDotDotToken || param.questionToken || param.initializer) return null;
      if (param.name.text === "this") return null;
      const t = L.typeOf(param.name);
      if ((t.flags & ts.TypeFlags.Any) === 0) return null;
      const sym = L.checker.getSymbolAtLocation(param.name);
      if (!sym) return null;
      if (paramWrittenInBody(L, decl.body!, sym, param.name.text)) return null;
      any = true;
      return sym;
    });
    return any ? out : null;
  }

/** The checker-fallback return type an implicit instance PROMISES before
   * its body lowers: the declared/inferred return when it maps statically
   * (JSDoc @returns, `void`, concrete inference the any-params didn't
   * poison) — used as the expected return, no inference — or null, which
   * selects return INFERENCE with DYN as the recursion pin. */
  function implicitDeclaredReturn(L: Lowerer, info: GenericFnInfo): IrType | null {
    try {
      const declSig = L.checker.getSignatureFromDeclaration(info.decl);
      if (!declSig) return null;
      const retTs = L.checker.getReturnTypeOfSignature(declSig);
      if (retTs.flags & ts.TypeFlags.Any) return null;
      return L.mapTypeOf(retTs);
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      return null;
    }
  }

/** True when an IR type may BIND an implicit param (a concrete static
   * type — the checked-dynamic kinds keep the dyn slot, units have no
   * standalone representation). */
  function bindableImplicitIr(t: IrType | null): t is IrType {
    return (
      t !== null &&
      t.kind !== "void" && t.kind !== "dyn" && t.kind !== "jsval" &&
      t.kind !== "caught" && t.kind !== "undefinedT" && t.kind !== "nullT"
    );
  }

/** The instance a CALL of an implicit-any function-like names: each
   * bindable implicit param takes the call's WIDENED argument checker type
   * when it maps statically (DYN otherwise — today's slot), typed params
   * keep their declared shapes, and the param-type tuple is the
   * instantiation key. New keys lower EAGERLY (return inference — see the
   * section comment); a same-key re-demand mid-lowering pins the fallback
   * return type. */
  export function implicitCallInstance(L: Lowerer, call: ts.CallExpression, info: GenericFnInfo): GenericInstance {
    const shapes: ParamShape[] = [];
    const argTypes = new Map<ts.Symbol, ts.Type>();
    info.decl.parameters.forEach((param, i) => {
      const sym = info.implicitParams![i];
      if (!sym) {
        shapes.push(L.paramShape(param));
        return;
      }
      let bound: IrType = DYN;
      const arg = call.arguments[i];
      if (arg && !ts.isSpreadElement(arg)) {
        // The argument's own checker type, literal-widened ('add' binds
        // string) — typeOf consults the ACTIVE instance's bindings, so a
        // bound param forwarded into another implicit call transitively
        // instantiates it (this._initCommandGroup(command)).
        const t = L.checker.getBaseTypeOfLiteralType(L.typeOf(arg));
        const mapped = L.mapTypeOf(t);
        if (bindableImplicitIr(mapped)) {
          bound = mapped;
          argTypes.set(sym, t);
        }
      }
      shapes.push({ type: bound, mode: "required" });
    });
    return internImplicitInstance(L, call, info, shapes, argTypes);
  }

/** The all-dyn DEFAULT instance — today's compiled body exactly: what a
   * VALUE reference of an implicit-any function names (indirect calls
   * carry no per-site types to bind). */
  export function implicitDefaultInstance(L: Lowerer, blame: ts.Node, info: GenericFnInfo): GenericInstance {
    const shapes: ParamShape[] = info.decl.parameters.map((param, i) =>
      info.implicitParams![i] ? { type: DYN, mode: "required" as const } : L.paramShape(param),
    );
    return internImplicitInstance(L, blame, info, shapes, new Map());
  }

  function internImplicitInstance(L: Lowerer, blame: ts.Node,
    info: GenericFnInfo,
    shapes: ParamShape[],
    argTypes: Map<ts.Symbol, ts.Type>,): GenericInstance {
    const key = shapes.map((s) => typeKey(s.type)).join(",");
    let inst = info.instances.get(key);
    if (inst) return inst;
    if (info.instances.size >= MAX_GENERIC_INSTANCES) {
      L.unsupported(
        "SC1090",
        blame,
        `unbounded implicit-any instantiation ('${info.baseName}' exceeded ` +
          `${MAX_GENERIC_INSTANCES} instances — polymorphic recursion?)`,
      );
    }
    const rendered = shapes.map((s) => L.fmt(s.type)).join(", ");
    const declared = implicitDeclaredReturn(L, info);
    inst = {
      name: `${info.qualifiedName}%${info.instances.size}`,
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
    // EAGER lowering (nested, the lambda discipline): the call site needs
    // the settled return type NOW. A body-level poison (a fenced parameter
    // form) skips the function like lowerFunction's rule — calls then meet
    // the pinned signature over a missing body, which the linker never
    // sees because the poison also fenced the call statement.
    try {
      const fn = L.lowerGenericInstance(info, inst);
      L.implicitFns.push(fn);
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      inst.implicitState = "done";
      throw e;
    }
    inst.implicitState = "done";
    return inst;
  }

/** The implicit-any twin of bindingGenericFnNodeOf, for LOCAL and module
   * bindings alike (`const knownBy = (cmd) => [cmd.name()].concat(...)`
   * inside a method body — commander's _registerCommand shape): the
   * initializer function-like when the WHOLE declaration qualifies for
   * implicit monomorphization, else null — non-qualifying shapes keep
   * today's closure story silently (never a fence: the flag must not make
   * working code worse). Qualification: an npm-static JS file, a const (or
   * never-reassigned, never-redeclared) identifier binding, an
   * arrow/function-expression initializer with bindable implicit-any
   * params, and a body with NO captures — no `this`/`super`, and no
   * reference to a function-scoped declaration outside itself (compiled
   * instances are module functions; module-scope references are fine).
   * Cached per declaration on L.implicitLocalFns. */
  export function implicitLocalFnNodeOf(L: Lowerer, decl: ts.VariableDeclaration): ts.FunctionExpression | ts.ArrowFunction | null {
    const cached = L.implicitLocalFns.get(decl);
    if (cached !== undefined) return cached ? (cached.decl as ts.FunctionExpression | ts.ArrowFunction) : null;
    const probe = (): ts.FunctionExpression | ts.ArrowFunction | null => {
      if (!implicitMonoFile(decl.getSourceFile())) return null;
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return null;
      if (init.typeParameters !== undefined || init.body === undefined) return null;
      if (!implicitAnyParamSymbolsOf(L, init)) return null;
      const sym = L.checker.getSymbolAtLocation(decl.name);
      if (!sym) return null;
      const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
      const redeclared = L.checker
        .declarationsOf(sym)
        .some((d) => d !== decl && ts.isVariableDeclaration(d) && d.initializer !== undefined);
      if (redeclared) return null;
      if (!isConst && !bindingNeverReassigned(L, sym, decl)) return null;
      // The capture scan: instances are module functions with no frame.
      let captures = false;
      const scan = (n: ts.Node): void => {
        if (captures) return;
        if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) {
          // Arrow bodies see the ENCLOSING this; function expressions
          // rebind their own — but a bare `this` there is untyped JS
          // dynamism either way. Reject both, cheaply and soundly.
          captures = true;
          return;
        }
        if (ts.isIdentifier(n)) {
          const s = L.checker.getSymbolAtLocation(n);
          const d = s ? L.checker.valueDeclarationOf(s) : undefined;
          if (d && d.getSourceFile() === decl.getSourceFile() && !(d.pos >= init.pos && d.end <= init.end)) {
            // Declared outside the initializer, in this file: a capture
            // exactly when some enclosing FUNCTION scope declares it —
            // module-scope declarations are reachable from any module
            // function.
            for (let p: ts.Node | undefined = d.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
              if (ts.isFunctionLike(p)) {
                captures = true;
                return;
              }
            }
          }
        }
        n.forEachChild(scan);
      };
      scan(init.body);
      return captures ? null : init;
    };
    const node = probe();
    if (node === null) {
      L.implicitLocalFns.set(decl, null);
      return null;
    }
    return node;
  }

/** Registers (or returns) the GenericFnInfo of a qualifying implicit-any
   * function-value binding — implicitLocalFnNodeOf's companion, the
   * bindingGenericFnInfoOf shape: the info enters genericFnsBySymbol under
   * the binding's symbol (and a named function expression's inner name),
   * so calls and value references resolve through genericFnOf; the
   * declaration statement emits nothing and the binding has no runtime
   * value. The declaration's source position joins the qualified name —
   * two same-named locals in one file stay distinct. */
  export function implicitLocalFnInfoOf(L: Lowerer, decl: ts.VariableDeclaration,
    fnNode: ts.FunctionExpression | ts.ArrowFunction,): GenericFnInfo {
    const existing = L.implicitLocalFns.get(decl);
    if (existing) return existing;
    const name = (decl.name as ts.Identifier).text;
    const sym = L.checker.getSymbolAtLocation(decl.name);
    if (!sym) L.unsupported("SC1090", decl.name, "this binding form");
    const implicit = implicitAnyParamSymbolsOf(L, fnNode);
    if (!implicit) L.unsupported("SC1090", fnNode, "this function form"); // defensive: the probe proved it
    const stmt = decl.parent.parent;
    const info: GenericFnInfo = {
      decl: fnNode,
      baseName: name,
      qualifiedName: L.qualify(decl.getSourceFile(), nsPathPrefix(stmt, decl) + `${name}%l${decl.getStart()}`),
      typeParams: [],
      instances: new Map(),
      implicitParams: implicit,
    };
    L.implicitLocalFns.set(decl, info);
    L.genericFnsBySymbol.set(sym, info);
    if (ts.isFunctionExpression(fnNode) && fnNode.name !== undefined) {
      const inner = L.checker.getSymbolAtLocation(fnNode.name);
      if (inner) L.genericFnsBySymbol.set(inner, info);
    }
    return info;
  }

/** An island call result the .d.ts DECLARES as a primitive exits eagerly
 * to that static type — the member-read rule's call sibling (see the
 * getProp lowering in lower-exprs.ts): primitives copy by value, every
 * static consumer works on the result, and a lying declaration throws the
 * catchable TypeError. Chain-handled forms stay jsval (the optChain's
 * unit path is the engine's undefined). */
export function islandPrimitiveExit(L: Lowerer, call: ts.CallExpression, result: IrExpr): IrExpr {
  if (call.questionDotToken) return result;
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.questionDotToken) return result;
  const declared = L.mapTypeOf(L.typeOf(call));
  if (declared && (declared.kind === "f64" || declared.kind === "bool" || declared.kind === "string")) {
    return { kind: "jsExit", value: result, type: declared, loc: result.loc };
  }
  return result;
}

/** setTimeout invokes its callback with NO arguments, but @types/node's
   * generic signature admits callbacks DECLARED with parameters — the
   * `setTimeout(resolve, ms)` sleep idiom, where Promise<unknown>'s
   * resolve is (value: unknown) => void, i.e. func(dyn)=>void. That one
   * shape adapts through an interned wrapper closure that calls the
   * callback with the dyn undefined — exactly what JS's zero-argument
   * invocation delivers (resolve(undefined) fulfills with undefined).
   * Zero-param callbacks pass through; any other parameterized callback
   * fences (a value for its parameter would have to be invented). */
  function adaptZeroArgTimerCallback(L: Lowerer, cb: IrExpr, node: ts.Node, loc: SrcLoc): IrExpr {
    // A REST-marked callback is not the zero-param ABI even with an empty
    // fixed-param list — `setTimeout(function(){ arguments }, 0)` infers
    // func(...dyn[])=>void (the variadic `arguments` form), and passing it
    // through unadapted hands the libCall a shape it does not accept (the
    // 12-settimeout-arguments ICE). It adapts below like any other
    // parameterized callback: boxed through the checked-dynamic boundary
    // when boxable, the named fence otherwise.
    if (cb.type.kind !== "func" || (cb.type.params.length === 0 && !cb.type.rest && cb.type.ret.kind === "void")) return cb;
    // A zero-param callback whose RETURN isn't void (`setTimeout(push, 1)`
    // where push answers boolean|undefined; async callbacks — func()=>
    // promise): JS ignores a timer callback's return value, so the shape
    // adapts through an interned return-dropping wrapper that calls the
    // callback and discards the result (a returned promise is Node's own
    // fire-and-forget — rejections take the unhandled-rejection path,
    // exactly as if the async callback ran under the timer directly).
    if (cb.type.params.length === 0 && !cb.type.rest) {
      const fromT = cb.type;
      const toT: IrType = { kind: "func", params: [], ret: VOID };
      const key = `timer.dropret:${typeKey(fromT)}`;
      const existing = L.arrHofHelpers.get(key);
      const name = existing ?? `%timer.dropret.${L.arrHofHelpers.size}`;
      if (!existing) {
        L.arrHofHelpers.set(key, name);
        const impl = `${name}.impl`;
        L.liftedFns.push({
          name: impl,
          params: [],
          returnType: VOID,
          captures: [{ localId: "f.0", name: "f", type: fromT }],
          locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "callValue",
                callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
                args: [],
                type: fromT.ret,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
        L.liftedFns.push({
          name,
          params: [{ localId: "f.0", name: "f", type: fromT }],
          returnType: toT,
          locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
          body: [
            { kind: "return", value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc }, loc },
          ],
          loc,
        });
      }
      return { kind: "call", callee: name, args: [cb], type: toT, loc };
    }
    const fromT = cb.type;
    const toT0: IrType = { kind: "func", params: [], ret: VOID };
    if (fromT.rest || fromT.params.length !== 1 || fromT.params[0]!.kind !== "dyn" || fromT.ret.kind !== "void") {
      // Any other BOXABLE signature rides the checked-dynamic function
      // boundary instead: box the closure (dynFrom), adapt to () => void
      // (dynCheck) — the thunk delivers JS's zero-argument invocation
      // (each param sees undefined; a param type undefined fails checks
      // throws the catchable TypeError, the SEMANTICS.md 117 stance).
      // The JS-inferred mustCall wrapper (func(dyn,dyn)=>dyn) lands here.
      if (canBoxFuncIntoDyn(fromT, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
        const boxed: IrExpr = { kind: "dynFrom", value: cb, type: DYN, loc };
        return { kind: "dynCheck", value: boxed, type: toT0, loc };
      }
      L.noLowering(
        "setTimeout with a callback that takes arguments",
        node,
        "the callback is invoked with no arguments — wrap it: setTimeout(() => cb(...), ms)",
      );
    }
    const toT: IrType = { kind: "func", params: [], ret: VOID };
    const key = `timer.droparg:${typeKey(fromT)}`;
    const existing = L.arrHofHelpers.get(key);
    const name = existing ?? `%timer.droparg.${L.arrHofHelpers.size}`;
    if (!existing) {
      L.arrHofHelpers.set(key, name);
      const impl = `${name}.impl`;
      L.liftedFns.push({
        name: impl,
        params: [],
        returnType: VOID,
        captures: [{ localId: "f.0", name: "f", type: fromT }],
        locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "callValue",
              callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
              args: [{ kind: "dynFrom", value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, type: DYN, loc }],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
      L.liftedFns.push({
        name,
        params: [{ localId: "f.0", name: "f", type: fromT }],
        returnType: toT,
        locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
        body: [
          { kind: "return", value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc }, loc },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: [cb], type: toT, loc };
  }

/** The trailing-argument timer forms — `setTimeout(cb, ms, ...args)`,
   * `setInterval(cb, ms, ...args)`, `setImmediate(cb, ...args)` — invoke
   * the callback WITH those arguments (Node passes them through). The
   * callback and every argument box into dyn and an interned per-arity
   * thunk delivers the dynCall at fire time: JS's exact call semantics
   * (per-argument checks against the callee's declared signature, extras
   * ignored, a non-function callee throwing the catchable TypeError).
   * Non-boxable callbacks fence. */
  export function timerStyleCallback(L: Lowerer, callArgs: readonly ts.Expression[], what: string, loc: SrcLoc): IrExpr {
    // The shared callback adaptation for timer-shaped surfaces whose
    // trailing arguments start right after the callback (setImmediate,
    // process.nextTick): zero-arg callbacks pass through, boxable
    // parameterized ones ride the checked-dynamic boundary, trailing
    // call arguments ride the interned per-arity dyn thunk.
    return callArgs.length > 1
      ? makeTimerArgsThunk(L, callArgs[0]!, callArgs.slice(1), what, loc)
      : adaptZeroArgTimerCallback(L, L.lowerExpr(callArgs[0]!), callArgs[0]!, loc);
  }

  function makeTimerArgsThunk(L: Lowerer, cbNode: ts.Expression, argNodes: readonly ts.Expression[], what: string, loc: SrcLoc): IrExpr {
    const cbLowered = L.lowerExpr(cbNode);
    let boxedCb: IrExpr;
    if (cbLowered.type.kind === "dyn") {
      boxedCb = cbLowered;
    } else if (
      cbLowered.type.kind === "func" &&
      canBoxFuncIntoDyn(cbLowered.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
    ) {
      boxedCb = { kind: "dynFrom", value: cbLowered, type: DYN, loc };
    } else {
      L.noLowering(
        `${what} with trailing arguments and a '${L.fmt(cbLowered.type)}' callback`,
        cbNode,
        "the callback must be a boxable function (or wrap it: () => cb(...))",
      );
    }
    const args = argNodes.map((a) => L.lowerExprExpecting(a, DYN));
    const n = args.length;
    const toT: IrType = { kind: "func", params: [], ret: VOID };
    const key = `timer.argsthunk:${n}`;
    const existing = L.arrHofHelpers.get(key);
    const name = existing ?? `%timer.argsthunk.${L.arrHofHelpers.size}`;
    if (!existing) {
      L.arrHofHelpers.set(key, name);
      const impl = `${name}.impl`;
      const capIds = ["f.0", ...args.map((_, i) => `a${i}.0`)];
      const capNames = ["f", ...args.map((_, i) => `a${i}`)];
      L.liftedFns.push({
        name: impl,
        params: [],
        returnType: VOID,
        captures: capIds.map((id, i) => ({ localId: id, name: capNames[i]!, type: DYN })),
        locals: capIds.map((id, i) => ({ id, name: capNames[i]!, type: DYN, mutable: false, boxed: true })),
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "dynCall",
              callee: { kind: "varRef", localId: "f.0", type: DYN, loc },
              calleeName: "callback",
              args: args.map((_, i) => ({ kind: "varRef", localId: `a${i}.0`, type: DYN, loc }) as IrExpr),
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
      L.liftedFns.push({
        name,
        params: capIds.map((id, i) => ({ localId: id, name: capNames[i]!, type: DYN })),
        returnType: toT,
        locals: capIds.map((id, i) => ({ id, name: capNames[i]!, type: DYN, mutable: false, boxed: true })),
        body: [
          { kind: "return", value: { kind: "closure", fnName: impl, captures: capIds, type: toT, loc }, loc },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: [boxedCb, ...args], type: toT, loc };
  }

/** The timer surface's member names — the ambient globals AND the
   * node:timers module's exports (one set: Node's timers module re-exports
   * the globals). */
  export const TIMER_MODULE_MEMBERS: ReadonlySet<string> = new Set([
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  ]);

/** Node tolerates clearTimeout/clearInterval/clearImmediate of anything
   * that is not a live handle — null, undefined, plain objects, or no
   * argument at all are silent no-ops. The SYNTACTICALLY side-effect-free
   * spellings of those (the shapes Node's own tests use) lower to the
   * dropped VOID no-op; an expression that must evaluate keeps the typed
   * path. Null when the argument might be a real handle. */
  function tolerantClearNoop(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
    const noop: IrExpr = { kind: "libCall", fn: "timers.clearNoop", args: [], type: VOID, loc };
    if (expr.arguments.length === 0) return noop;
    if (expr.arguments.length !== 1) return null;
    let arg = expr.arguments[0]!;
    // `{} as never` / parenthesized spellings: the cast changes no value.
    while (ts.isAsExpression(arg) || ts.isTypeAssertion(arg) || ts.isParenthesizedExpression(arg)) arg = arg.expression;
    if (arg.kind === ts.SyntaxKind.NullKeyword) return noop;
    if (ts.isObjectLiteralExpression(arg) && arg.properties.length === 0) return noop;
    if (ts.isIdentifier(arg)) {
      const t = L.mapTypeOf(L.typeOf(arg));
      if (t && (t.kind === "nullT" || t.kind === "undefinedT")) return noop;
      if (arg.text === "undefined") return noop;
    }
    return null;
  }

/** One timer call by MEMBER NAME — the shared lowering behind the ambient
   * globals, the node:timers named/destructured imports, and the namespace
   * form (`timers.setTimeout(...)`). Null when the member isn't a lowered
   * timer function (the caller's fence machinery takes over). */
  export function lowerTimersMemberCall(L: Lowerer, expr: ts.CallExpression, member: string, loc: SrcLoc): IrExpr | null {
    // setTimeout: the loop-owned one-shot. The one-argument form defaults
    // the delay to 1ms (Node coerces an absent delay to 1); trailing
    // arguments beyond the delay pass to the callback at fire time via
    // the interned dyn thunk.
    if (member === "setTimeout") {
      if (expr.arguments.length === 0) {
        L.noLowering("setTimeout with 0 arguments", expr, "the supported form is setTimeout(callback, ms?, ...args)");
      }
      const cb = expr.arguments.length > 2
        ? makeTimerArgsThunk(L, expr.arguments[0]!, expr.arguments.slice(2), "setTimeout", loc)
        : adaptZeroArgTimerCallback(L, L.lowerExpr(expr.arguments[0]!), expr.arguments[0]!, loc);
      const ms: IrExpr = expr.arguments.length >= 2
        ? L.lowerExpr(expr.arguments[1]!)
        : { kind: "numLit", value: 1, type: F64, loc };
      // The use position decides the shape: a Timeout handle (mapped to
      // f64) when the call is USED (assigned, `.unref()`d, cleared) — the
      // clearable-handle timer; plain void in statement position (the
      // historic fire-and-forget setTimeout, no clear surface). Both ride
      // the same heap; only the handle form can be unref'd/cleared.
      const resultT = L.mapTypeOf(L.typeOf(expr));
      if (resultT?.kind === "f64" && !ts.isExpressionStatement(expr.parent)) {
        return { kind: "libCall", fn: "timers.setTimeoutHandle", args: [cb, ms], type: F64, loc };
      }
      return { kind: "libCall", fn: "timers.setTimeout", args: [cb, ms], type: VOID, loc };
    }
    // clearTimeout(handle): shares the interval clear (the handle ids
    // share one space). A `Timeout | null` handle narrows first, like
    // clearInterval.
    if (member === "clearTimeout") {
      const noop = tolerantClearNoop(L, expr, loc);
      if (noop) return noop;
      if (expr.arguments.length !== 1) {
        L.noLowering(`clearTimeout with ${expr.arguments.length} arguments`, expr);
      }
      const handle = L.lowerExpr(expr.arguments[0]!);
      if (handle.type.kind !== "f64") {
        L.noLowering(
          `clearTimeout of '${L.fmt(handle.type)}' handles`,
          expr.arguments[0]!,
          "the handle is the Timeout setTimeout returned (narrow 'Timeout | null' first)",
        );
      }
      return { kind: "libCall", fn: "timers.clearTimeout", args: [handle], type: VOID, loc };
    }
    // setInterval/clearInterval: the repeating pair. The Timeout handle
    // maps to the f64 interval id; a live interval keeps the event loop
    // alive and clearInterval releases it, like Node. The callback adapts
    // exactly like setTimeout's: zero-param passes through, the
    // one-dyn-param sleep idiom drops its argument, any other boxable
    // shape (the JS-inferred mustCall wrapper) rides the checked-dynamic
    // function boundary; trailing arguments beyond the delay pass to the
    // callback each tick via the interned dyn thunk.
    if (member === "setInterval") {
      if (expr.arguments.length === 0) {
        L.noLowering("setInterval with 0 arguments", expr, "the supported form is setInterval(callback, ms?, ...args)");
      }
      const cb = expr.arguments.length > 2
        ? makeTimerArgsThunk(L, expr.arguments[0]!, expr.arguments.slice(2), "setInterval", loc)
        : adaptZeroArgTimerCallback(L, L.lowerExpr(expr.arguments[0]!), expr.arguments[0]!, loc);
      const ms: IrExpr = expr.arguments.length >= 2
        ? L.lowerExpr(expr.arguments[1]!)
        : { kind: "numLit", value: 1, type: F64, loc };
      return { kind: "libCall", fn: "timers.setInterval", args: [cb, ms], type: F64, loc };
    }
    if (member === "clearInterval") {
      const noop = tolerantClearNoop(L, expr, loc);
      if (noop) return noop;
      if (expr.arguments.length !== 1) {
        L.noLowering(`clearInterval with ${expr.arguments.length} arguments`, expr);
      }
      const handle = L.lowerExpr(expr.arguments[0]!);
      if (handle.type.kind !== "f64") {
        L.noLowering(
          `clearInterval of '${L.fmt(handle.type)}' handles`,
          expr.arguments[0]!,
          "the handle is the number setInterval returned (narrow `number | null` first)",
        );
      }
      return { kind: "libCall", fn: "timers.clearInterval", args: [handle], type: VOID, loc };
    }
    // setImmediate/clearImmediate: Node's check-phase pair. The handle is
    // the f64 immediate id (its own space — clearTimeout of an Immediate
    // no-ops, like Node); the callback adapts like setTimeout's.
    if (member === "setImmediate") {
      if (expr.arguments.length === 0) {
        L.noLowering("setImmediate with 0 arguments", expr, "the supported form is setImmediate(callback, ...args)");
      }
      const cb = expr.arguments.length > 1
        ? makeTimerArgsThunk(L, expr.arguments[0]!, expr.arguments.slice(1), "setImmediate", loc)
        : adaptZeroArgTimerCallback(L, L.lowerExpr(expr.arguments[0]!), expr.arguments[0]!, loc);
      return { kind: "libCall", fn: "timers.setImmediate", args: [cb], type: F64, loc };
    }
    if (member === "clearImmediate") {
      const noop = tolerantClearNoop(L, expr, loc);
      if (noop) return noop;
      if (expr.arguments.length !== 1) {
        L.noLowering(`clearImmediate with ${expr.arguments.length} arguments`, expr);
      }
      const handle = L.lowerExpr(expr.arguments[0]!);
      if (handle.type.kind !== "f64") {
        L.noLowering(
          `clearImmediate of '${L.fmt(handle.type)}' handles`,
          expr.arguments[0]!,
          "the handle is the Immediate setImmediate returned (narrow 'Immediate | undefined' first)",
        );
      }
      return { kind: "libCall", fn: "timers.clearImmediate", args: [handle], type: VOID, loc };
    }
    return null;
  }

function ffiSourceParams(binding: IrFfiImport): Exclude<IrFfiImport["params"][number], { context: string }>[] {
  return binding.params.filter((param) => !isFfiContextParam(param)) as Exclude<
    IrFfiImport["params"][number],
    { context: string }
  >[];
}

function ffiParamDisplay(param: ReturnType<typeof ffiSourceParams>[number]): string {
  return isFfiCallbackParam(param)
    ? `callback '${param.callback.id}'`
    : isFfiReleaseParam(param)
      ? `release callback '${param.callback.release}'`
      : `class '${param}'`;
}

/** Callback arguments flow from native code into TypeScript. Their source
 * declarations therefore need to cover the whole scalar domain represented
 * by the manifest class: IR widening alone cannot distinguish `0`, a numeric
 * enum, or `never` from an unrestricted `number`. */
function ffiCallbackInputDiagnostic(
  L: Lowerer,
  descriptor: IrFfiCallbackParam | IrFfiReleaseParam,
  callbackType: ts.Type,
): string | null {
  const signatures = L.checker.getCallSignatures(callbackType);
  if (signatures.length !== 1) return null;

  const nativeParams = descriptor.callback.params.filter(
    (param): param is IrFfiCallbackParamClass => !isFfiContextParam(param),
  );
  let nativeIndex = 0;
  const params = signatures[0]!.getParameters();
  for (let i = 0; i < params.length; i++) {
    const paramType = L.checker.getTypeOfSymbol(params[i]!);
    const mapped = L.mapTypeOf(paramType);
    // Function mapping drops a `void` parameter because it consumes no
    // argument. Mirror that alignment before comparing manifest slots.
    if (mapped?.kind === "void") continue;

    const nativeClass = nativeParams[nativeIndex++];
    if (
      nativeClass === undefined ||
      mapped === null ||
      !typeEquals(mapped, ffiClassType(nativeClass))
    ) {
      continue;
    }

    if (nativeClass === "bytes") continue;
    const domain = nativeClass === "bool"
      ? "boolean"
      : nativeClass === "cstring" || nativeClass === "string"
      ? "string"
      : "number";
    const coversDomain = nativeClass === "bool"
      ? (paramType.flags & ts.TypeFlags.Boolean) !== 0
      : nativeClass === "cstring" || nativeClass === "string"
      ? (paramType.flags & ts.TypeFlags.String) !== 0
      : (paramType.flags & ts.TypeFlags.Number) !== 0;
    if (!coversDomain) {
      const descriptorName = isFfiCallbackParam(descriptor)
        ? descriptor.callback.id
        : descriptor.callback.release;
      return (
        `callback '${descriptorName}' parameter ${i + 1} is '${L.checker.typeToString(paramType)}', ` +
        `but native class '${nativeClass}' may supply any ${domain}; declare it as '${domain}'`
      );
    }
  }

  return null;
}

/** Values returned by native code flow into TypeScript, so a declaration
 * must admit the whole scalar domain the ABI class can produce. `mapType`
 * intentionally widens literal and enum types to their storage type; that
 * is sound for script-owned values but not for an external return contract
 * (`(): true` cannot describe a bool callback that is free to return false). */
function ffiReturnDomainDiagnostic(
  L: Lowerer,
  nativeClass: IrFfiImport["returns"],
  returnType: ts.Type,
): string | null {
  if (nativeClass === "void") return null;
  const domain = nativeClass === "bool" ? "boolean" : "number";
  const coversDomain = nativeClass === "bool"
    ? (returnType.flags & ts.TypeFlags.Boolean) !== 0
    : (returnType.flags & ts.TypeFlags.Number) !== 0;
  return coversDomain
    ? null
    : `the return type is '${L.checker.typeToString(returnType)}', but native class '${nativeClass}' may supply ` +
      `any ${domain}; declare it as '${domain}'`;
}

/** The binding surface's diagnostic flavor: native-manifest bindings
 * speak the SC5002/SC5003 FFI codes; library-mode host callbacks are the
 * same recognition machinery under the profile's vocabulary — SC4024 for
 * both the binding and signature halves, with "manifest" respelled
 * "profile" in the shared detail strings so the teaching names the
 * document the author actually edits. */
function ffiFlavor(L: Lowerer): {
  binding: (name: string, detail: string, loc: SrcLoc) => ScrDiagnostic;
  signature: (name: string, detail: string, loc: SrcLoc) => ScrDiagnostic;
} {
  if (!L.libraryCallbacks) return { binding: ffiBindingDiag, signature: ffiSignatureDiag };
  const lib = (name: string, detail: string, loc: SrcLoc): ScrDiagnostic =>
    libCallbackDiag(name, detail.replaceAll("manifest", "profile"), loc);
  return { binding: lib, signature: lib };
}

/** The declaration half of an outbound FFI binding. Kept independent of
 * call-site argument checks so the whole manifest can be validated even
 * when a configured function is never called. */
function ffiDeclarationDiagnostic(
  L: Lowerer,
  binding: IrFfiImport,
  symbol: ts.Symbol,
  loc: SrcLoc,
): ScrDiagnostic | null {
  const { binding: bindingDiag, signature: signatureDiag } = ffiFlavor(L);
  const declarations = L.checker.declarationsOf(symbol);
  const functionDecls = declarations.filter(ts.isFunctionDeclaration);
  if (
    functionDecls.length === 0 ||
    declarations.some((decl) => !ts.isFunctionDeclaration(decl)) ||
    functionDecls.some((decl) => decl.body !== undefined)
  ) {
    return bindingDiag(
      binding.name,
      "the configured name does not resolve exclusively to signature-only function declarations",
      loc,
    );
  }
  if (functionDecls.some((decl) => (decl.typeParameters?.length ?? 0) > 0)) {
    return signatureDiag(
      binding.name,
      "generic ambient declarations cannot describe one fixed C ABI",
      loc,
    );
  }
  const signatures = L.checker.getCallSignatures(L.checker.getTypeOfSymbol(symbol));
  if (signatures.length !== 1) {
    return signatureDiag(
      binding.name,
      `the ambient binding has ${signatures.length} call signatures; exactly one non-overloaded signature is required`,
      loc,
    );
  }
  const signature = signatures[0]!;
  const params = signature.getParameters();
  const sourceParams = ffiSourceParams(binding);
  if (params.length !== sourceParams.length) {
    return signatureDiag(
      binding.name,
      `the TypeScript declaration has ${params.length} parameter(s), but the manifest declares ${sourceParams.length} source parameter(s) ` +
        `(${binding.params.length - sourceParams.length} additional native context slot(s) are compiler-supplied)`,
      loc,
    );
  }
  const expectedParams = ffiSourceParamTypes(binding.params);
  for (let i = 0; i < params.length; i++) {
    const paramType = L.checker.getTypeOfSymbol(params[i]!);
    const sourceParam = sourceParams[i]!;
    // `mapType` deliberately gives uninhabited value positions a cheap f64
    // slot because no TypeScript value can ever reach them. An FFI
    // declaration is different: it is a callable external contract, so a
    // `never` slot cannot truthfully describe any native parameter.
    if ((paramType.flags & ts.TypeFlags.Never) !== 0) {
      return signatureDiag(
        binding.name,
        `parameter ${i + 1} is 'never', an uninhabited TypeScript type that cannot describe a native ABI parameter`,
        loc,
      );
    }
    if (isFfiCallbackParam(sourceParam) || isFfiReleaseParam(sourceParam)) {
      const callbackDiagnostic = ffiCallbackInputDiagnostic(L, sourceParam, paramType);
      if (callbackDiagnostic !== null) {
        return signatureDiag(binding.name, callbackDiagnostic, loc);
      }
    }
    const mapped = L.mapTypeOf(paramType);
    const expected = expectedParams[i]!;
    if (mapped === null || !typeEquals(mapped, expected)) {
      return signatureDiag(
        binding.name,
        `parameter ${i + 1} maps to '${mapped === null ? L.checker.typeToString(paramType) : L.fmt(mapped)}', ` +
          `which does not fit manifest ${ffiParamDisplay(sourceParam)}`,
        loc,
      );
    }
  }
  const returnType = L.checker.getReturnTypeOfSignature(signature);
  // A native function is allowed to return. Accepting `never` here would
  // let tsc erase all control flow after the call while the linked function
  // continues, making the generated program disagree with TypeScript.
  if ((returnType.flags & ts.TypeFlags.Never) !== 0) {
    return signatureDiag(
      binding.name,
      "the return type is 'never', but a native ABI return cannot uphold TypeScript's non-returning contract",
      loc,
    );
  }
  const declaredReturn = L.mapTypeOf(returnType);
  const expectedReturn = ffiClassType(binding.returns);
  if (declaredReturn === null || !typeEquals(declaredReturn, expectedReturn)) {
    return signatureDiag(
      binding.name,
      `the return maps to '${declaredReturn === null ? L.checker.typeToString(returnType) : L.fmt(declaredReturn)}', ` +
        `which does not fit manifest class '${binding.returns}'`,
      loc,
    );
  }
  const returnDomainDiagnostic = ffiReturnDomainDiagnostic(L, binding.returns, returnType);
  if (returnDomainDiagnostic !== null) {
    return signatureDiag(binding.name, returnDomainDiagnostic, loc);
  }
  return null;
}

export interface FfiValidationResult {
  diagnostics: ScrDiagnostic[];
  symbolsByName: ReadonlyMap<string, ReadonlySet<ts.Symbol>>;
}

/** True when a library callback may claim declarations from this file.
 * Ordinary program source is always eligible. Declaration files are
 * eligible only when they are project-owned: the standard library and
 * installed/workspace package declarations are existing ambient surfaces,
 * never callback declarations merely because a profile channel shares their
 * spelling. */
function libraryCallbackOwnsFile(L: Lowerer, file: ts.SourceFile): boolean {
  return !file.isDeclarationFile || (!L.isStdlibFile(file) && !L.isNpmFile(file));
}

/** Resolve and validate every configured outbound binding before emit.
 * Candidate declarations are signature-only functions bearing the manifest
 * name anywhere in the program. Multiple scoped declarations are all native
 * bindings under the existing name-based call surface, so every candidate
 * must fit the one manifest ABI. Library callbacks additionally exclude
 * standard-library and package declaration files while retaining project
 * declaration files as authored callback surface. */
export function validateFfiImports(L: Lowerer): FfiValidationResult {
  const diagnostics: ScrDiagnostic[] = [];
  const symbolsByName = new Map<string, ReadonlySet<ts.Symbol>>();
  const configuredNames = new Set(L.ffiImports.map((binding) => binding.name));
  const candidates = new Map<string, Map<ts.Symbol, ts.FunctionDeclaration>>();

  if (configuredNames.size === 0) return { diagnostics, symbolsByName };

  for (const file of L.program.getSourceFiles()) {
    if (L.libraryCallbacks && !libraryCallbackOwnsFile(L, file)) continue;
    ts.walkPreorder(file, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        if (
          node.body === undefined &&
          node.name !== undefined &&
          configuredNames.has(node.name.text)
        ) {
          const symbol = L.checker.getSymbolAtLocation(node.name);
          if (symbol !== undefined) {
            let bySymbol = candidates.get(node.name.text);
            if (bySymbol === undefined) {
              bySymbol = new Map();
              candidates.set(node.name.text, bySymbol);
            }
            if (!bySymbol.has(symbol)) bySymbol.set(symbol, node);
          }
        }
        return "skip";
      }
      if (ts.isFunctionLike(node)) return "skip";
    });
  }

  for (const binding of L.ffiImports) {
    const bySymbol = candidates.get(binding.name);
    if (bySymbol === undefined || bySymbol.size === 0) {
      // A native-manifest binding with no declaration is a broken build
      // input. A library callback channel with no declaration is unused
      // CAPACITY: the registration symbol still dispatches it, nothing
      // calls it, and a later program revision may (a program that calls
      // the name without declaring it fails ordinary typechecking first).
      if (!L.libraryCallbacks) {
        diagnostics.push(
          ffiBindingDiag(
            binding.name,
            "the program has no signature-only function declaration with this name",
            { file: L.entry.fileName, start: 0, end: 0 },
          ),
        );
      } else {
        // Preserve the distinction between unused capacity and a binding
        // whose program declaration was found but failed validation. The
        // latter deliberately leaves no map entry so calls poison without
        // duplicating the program-level diagnostic; the empty set lets call
        // lowering inspect same-named builtins, implementations, and
        // unsupported ambient declaration shapes individually.
        symbolsByName.set(binding.name, new Set());
      }
      continue;
    }
    const validSymbols = new Set<ts.Symbol>();
    let valid = true;
    for (const [symbol, declaration] of bySymbol) {
      const diagnostic = ffiDeclarationDiagnostic(
        L,
        binding,
        symbol,
        locOf(declaration),
      );
      if (diagnostic === null) {
        validSymbols.add(symbol);
      } else {
        diagnostics.push(diagnostic);
        valid = false;
      }
    }
    if (valid) symbolsByName.set(binding.name, validSymbols);
  }

  return { diagnostics, symbolsByName };
}

/** A manifest-bound call of a signature-only ambient declaration. This
 * recognition deliberately runs before ambientUndefVarRootOf: without the
 * manifest the exact same source keeps Node's ReferenceError semantics;
 * with it, only the resolved declaration binding (never a shadowing
 * function with a body) becomes a direct native call. */
export function lowerFfiCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
    if (!ts.isIdentifier(expr.expression)) return null;
    const binding = L.ffiImportsByName.get(expr.expression.text);
    if (binding === undefined) {
      // LIBRARY mode with a declared callback surface: a CALL of a
      // program-authored signature-only ambient function that names no
      // channel is the author reaching for the host seam the profile does
      // not provide — refuse with the callback teaching instead of the
      // ambient ReferenceError lowering. Scoped to project-owned source and
      // declaration files so lib.d.ts/@types/package ambients (parseInt,
      // setTimeout, …) keep every existing lowering; callback-free profiles
      // are untouched.
      if (L.libraryCallbacks) {
        const symbol = L.resolveValueSymbol(expr.expression);
        const decls = symbol === null ? [] : L.checker.declarationsOf(symbol);
        const callbackShaped =
          decls.length > 0 &&
          decls.every(
            (decl) =>
              ts.isFunctionDeclaration(decl) &&
              decl.body === undefined &&
              libraryCallbackOwnsFile(L, decl.getSourceFile()),
          );
        if (callbackShaped) {
          L.pushDiag(
            libCallbackDiag(
              expr.expression.text,
              "the profile declares no callback channel with this name",
              locOf(expr),
            ),
          );
          throw new PoisonError();
        }
      }
      return null;
    }
    const loc = locOf(expr);
    const { binding: bindingFlavor, signature: signatureFlavor } = ffiFlavor(L);
    const bindingError = (detail: string): never => {
      L.pushDiag(bindingFlavor(binding.name, detail, loc));
      throw new PoisonError();
    };
    const signatureError = (detail: string): never => {
      L.pushDiag(signatureFlavor(binding.name, detail, loc));
      throw new PoisonError();
    };
    const symbol =
      L.resolveValueSymbol(expr.expression) ??
      bindingError("the call has no resolved TypeScript symbol");
    if (L.ffiBindingSymbols !== null) {
      const validSymbols = L.ffiBindingSymbols.get(binding.name);
      // No entry means the program-level pass already diagnosed this
      // binding. Poison the statement without duplicating that diagnostic.
      if (validSymbols === undefined) throw new PoisonError();
      if (!validSymbols.has(symbol)) {
        if (L.libraryCallbacks) {
          const declarations = L.checker.declarationsOf(symbol);
          const programDeclarations = declarations.filter((decl) =>
            libraryCallbackOwnsFile(L, decl.getSourceFile())
          );
          const programAmbient =
            programDeclarations.length > 0 &&
            programDeclarations.every(
              (decl) =>
                decl.getSourceFile().isDeclarationFile ||
                (ts.getCombinedModifierFlags(decl as ts.Declaration) &
                  ts.ModifierFlags.Ambient) !== 0,
            );
          if (programAmbient) {
            // A called, program-authored ambient with a configured channel
            // name is not unused capacity. Validate the resolved symbol now
            // so unsupported declaration forms (`declare const cb: ...`)
            // refuse SC4024 instead of silently dropping the call. A valid
            // declaration missed by the up-front syntax walk may proceed as
            // the callback binding after this exact-symbol check.
            const diagnostic = ffiDeclarationDiagnostic(L, binding, symbol, loc);
            if (diagnostic !== null) {
              L.pushDiag(diagnostic);
              throw new PoisonError();
            }
          } else {
            // Standard-library/package ambients and same-named program
            // implementations remain their ordinary TypeScript bindings;
            // the profile does not claim them.
            return null;
          }
        } else {
          // TypeScript resolved this call to a distinct local declaration.
          // The manifest owns only the exact validated ambient binding; a
          // same-named function with a body remains ordinary scriptc code.
          return null;
        }
      }
    } else {
      const diagnostic = ffiDeclarationDiagnostic(L, binding, symbol, loc);
      if (diagnostic !== null) {
        L.pushDiag(diagnostic);
        throw new PoisonError();
      }
    }
    if (expr.questionDotToken !== undefined || expr.typeArguments !== undefined) {
      signatureError("native bindings support direct, non-generic calls only");
    }
    if (expr.arguments.some(ts.isSpreadElement)) {
      signatureError("spread arguments do not have a fixed native ABI");
    }
    const expectedParams = ffiSourceParamTypes(binding.params);
    if (expr.arguments.length !== expectedParams.length) {
      signatureError(
        `this call passes ${expr.arguments.length} argument(s), but the native binding requires exactly ${expectedParams.length}`,
      );
    }
    const expectedReturn = ffiClassType(binding.returns);
    const sourceParams = ffiSourceParams(binding);
    const args = expr.arguments.map((arg, i) => {
      const sourceParam = sourceParams[i]!;
      const expected = expectedParams[i]!;
      const lowered = L.lowerExprExpecting(arg, expected);
      // Retained identity is the runtime closure pointer. A coercion adapter
      // would be freshly allocated at registration and release sites, so an
      // assignable-but-different function shape (notably `() => number` into
      // `() => void`) cannot honestly participate in explicit release. The
      // adapter set comes from the mint sites themselves (Lowerer's
      // freshClosureAdapters), not name-prefix matching, so a new coercion
      // helper cannot silently slip past this guard.
      if (
        isFfiReleaseParam(sourceParam) ||
        (isFfiCallbackParam(sourceParam) && sourceParam.callback.lifetime === "retained")
      ) {
        if (
          lowered.kind === "dynCheck" ||
          (lowered.kind === "call" && L.freshClosureAdapters.has(lowered.callee))
        ) {
          signatureError(
            `retained callback argument ${i + 1} must have the exact manifest function type; ` +
              `an implicit function adapter would change its release identity`,
          );
        }
        // An inline function value at a RELEASE site can never match:
        // lifted lambdas always carry a captures list (even an empty one),
        // so both backends mint a fresh closure per evaluation of the
        // expression — the release argument is a pointer no registration
        // holds, a guaranteed runtime trap. Declared functions stay valid
        // here — their value is the interned immortal closure (captures
        // undefined), one pointer for every mention. Registration sites
        // still accept literals: an unnameable registration is simply
        // permanent, released by the exit teardown (the live-at-exit
        // fixture shape), and hides no matching failure.
        if (
          isFfiReleaseParam(sourceParam) &&
          lowered.kind === "closure" &&
          L.liftedFns.some((f) => f.name === lowered.fnName && f.captures !== undefined)
        ) {
          signatureError(
            `retained callback argument ${i + 1} cannot be an inline function value; ` +
              `each evaluation creates a fresh closure no registration holds — ` +
              `pass the same named value used to register`,
          );
        }
      }
      return lowered;
    });
    return {
      kind: "ffiCall",
      import: binding.name,
      args,
      type: expectedReturn,
      loc,
    };
  }

export function lowerCall(L: Lowerer, expr: ts.CallExpression): IrExpr {
    const loc = locOf(expr);

    // A call whose chain ROOTS at an ambient-undefined name (`declare
    // const value: Y | undefined; value?.foo("a")`, `declare function
    // chain...; chain(o).mapValues(f).value()`, a trap binding's read):
    // Node evaluates the root FIRST and throws the catchable
    // ReferenceError before any member, type argument, or argument runs —
    // the whole call IS that throw, typed by the use site (arguments
    // never lower; Node never evaluates them). Claimed before every
    // intrinsic and dispatch path: no lowering can answer differently
    // when the root read itself is the crash.
    {
      const root = ambientUndefVarRootOf(L, expr);
      if (root !== null) {
        const mapped = L.mapTypeOf(L.typeOf(expr));
        const t =
          mapped && mapped.kind !== "void" && !L.typeNamesUnregisteredClass(mapped)
            ? mapped
            : (contextualUndefReadType(L, expr) ?? F64);
        return nsUndefRead(L, root.text, expr, t);
      }
    }
    // A method call through a NULLISH binding (`const i: I<A & B> = null
    // as any; i.fn(...)` — the receiver provably holds null/undefined
    // forever): the member READ throws Node's exact TypeError before any
    // argument evaluates — the whole call lowers to that throw. Claimed
    // when the receiver's type has no mapping (no other story exists) or
    // the member is a generic signature (the alternative is the
    // interface-dispatch fence — the runtime truth is this throw).
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.questionDotToken === undefined
    ) {
      const recvSym = L.resolveValueSymbol(expr.expression.expression);
      const unit = nullishValueUnitOf(L, recvSym);
      if (unit !== null) {
        const recvUnmappable =
          recvSym !== null && L.mapTypeOf(L.checker.getTypeOfSymbol(recvSym)) === null;
        const propSym = L.checker.getPropertyOfType(
          L.typeOf(expr.expression.expression),
          expr.expression.name.text,
        );
        const genericMember =
          propSym !== undefined && propSym !== null &&
          isGenericCallableMemberType(L.checker.getTypeOfSymbol(propSym), L.checker);
        if (recvUnmappable || genericMember) {
          const mapped = L.mapTypeOf(L.typeOf(expr));
          const t = mapped && mapped.kind !== "void" && !L.typeNamesUnregisteredClass(mapped) ? mapped : F64;
          return nodeThrowExpr(1, "", `Cannot read properties of ${unit} (reading '${expr.expression.name.text}')`, t, loc);
        }
      }
    }

    // `require("spec")` through a createRequire binding (and the inline
    // `createRequire(import.meta.url)("spec")` spelling — a CallExpression
    // callee no other dispatch path serves): the static erasure —
    // builtins/json/npm per lowerCreateRequireCall's arms.
    {
      const crServed = lowerCreateRequireCall(L, expr, loc);
      if (crServed) return crServed;
    }

    // `process.getuid?.()` — intercepted BEFORE the optional-chain
    // machinery (the member always exists on a POSIX target, so the
    // optional call IS the call; `process.getuid` itself has no value
    // lowering for the chain to guard).
    const processOptional = L.lowerProcessOptionalMethodCall(expr);
    if (processOptional) return processOptional;
    const reqStreamOptional = lowerCompatReqStreamOptionalCall(L, expr);
    if (reqStreamOptional) return reqStreamOptional;
    // `t.unref?.()` on a Timeout handle — same story: the method always
    // exists, so the optional call is the call.
    if (expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
      const timeoutOptional = L.lowerTimeoutMethodCall(expr, expr.expression);
      if (timeoutOptional) return timeoutOptional;
    }
    // `req.session?.m(...)` remains absent on compatibility requests. Live
    // `req.stream` calls now pass through the normal optional-chain and h2
    // stream lowering using lowerServerProperty's checked getter.
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isPropertyAccessExpression(expr.expression.expression) &&
      !expr.expression.expression.questionDotToken &&
      expr.expression.expression.name.text === "session" &&
      ts.isIdentifier(expr.expression.expression.expression) &&
      L.mapTypeOf(L.typeOf(expr.expression.expression.expression))?.kind === "httpReq" &&
      L.isStdlibMember(expr.expression.expression)
    ) {
      const member = expr.expression.expression.name.text;
      if (!ts.isExpressionStatement(expr.parent) && !ts.isArrowFunction(expr.parent)) {
        L.unsupported(
          "SC1090",
          expr,
          `using the result of the '${member}${expr.expression.questionDotToken ? "?." : "."}${expr.expression.name.text}(...)' call (${member} is always undefined on this HTTP/1.1 lowering — call it as its own statement)`,
        );
      }
      if (!expr.expression.questionDotToken) {
        // The UNGUARDED form: on this lowering (and in Node, on every
        // HTTP/1.1 connection of an allowHTTP1 server) req.stream is
        // undefined — the member read on undefined THROWS Node's exact
        // TypeError, catchably (JS evaluates the receiver, throws reading
        // the method, and never evaluates the arguments — the identifier
        // receiver and unevaluated arguments make that order exact here).
        return {
          kind: "libCall",
          fn: "http2.streamUndefCall",
          args: [{ kind: "strLit", value: expr.expression.name.text, type: STRING, loc }],
          type: VOID,
          loc,
        };
      }
      return { kind: "libCall", fn: "http2.streamNoop", args: [], type: VOID, loc };
    }

    // Optional-chain call forms: `f?.()` (the token on the call) and
    // `a?.m()` (the token on the member access). The handled markers keep
    // the chain lowering's re-entrant dispatch from looping.
    if (
      (expr.questionDotToken && !L.chainHandled.has(expr)) ||
      (ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.questionDotToken &&
        !L.chainHandled.has(expr.expression))
    ) {
      return L.lowerOptionalChain(expr);
    }

    // super(...) is handled by the derived-constructor lowering as a
    // top-level statement (its field-initializer ordering lives there);
    // any other position would misorder initialization — rejected.
    if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
      L.unsupported("SC1090", expr, "super() calls anywhere but as a top-level constructor statement");
    }
    // super.method(...): a DIRECT (never virtual) call of the base chain's
    // implementation over the same `this` — JS's super dispatch exactly.
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      return L.lowerSuperMethodCall(expr, expr.expression);
    }

    const consoleMember = L.consoleCallMember(expr);
    if (consoleMember !== null) {
      // console.log/info/debug write stdout; console.error and console.warn
      // are one stream in Node (warn IS error, info and debug ARE log) and
      // write stderr with the exact same formatting. Node's formatter is
      // formatWithOptions: string arguments print verbatim, numbers and
      // booleans directly, and EVERYTHING else through util.inspect at the
      // rest-args depth 2 — which the static inspect machinery renders
      // here (arrays, records, unions, Maps/Sets, undefined/null, ...);
      // shapes inspect cannot render keep honest per-argument fences.
      const surface = `console.${consoleMember}`;
      const stdoutMember = consoleMember === "log" || consoleMember === "info" || consoleMember === "debug";
      // A LITERAL format string with %-specifiers and further arguments
      // (`console.log('Mismatched %s function calls. Expected %s, actual
      // %d.', name, seg, n)` — test/common's exit report): Node's console
      // formatter IS util.format — route through the format lowering and
      // print its one string. Specifier-free first strings keep the
      // plain space-joined path below (identical output, cheaper).
      if (
        expr.arguments.length > 1 &&
        expr.arguments[0] !== undefined &&
        (ts.isStringLiteral(expr.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(expr.arguments[0])) &&
        /%[sdifjoOc%]/.test(expr.arguments[0].text)
      ) {
        const formatted = lowerFormatCall(L, expr, loc, false);
        return {
          kind: "intrinsic",
          name: stdoutMember ? "console.log" : "console.error",
          args: [formatted],
          type: VOID,
          loc,
        };
      }
      const args = expr.arguments.map((a) => {
        const lowered = L.lowerExpr(a);
        if (lowered.type.kind === "jsval") {
          // Node prints objects with util.inspect formatting, which
          // String() cannot match — silent divergence is banned. Templates
          // are ToString (Node-exact), casts are validated: both honest.
          L.unsupported(
            "SC1090",
            a,
            `${surface} of 'any' values (wrap it: ${surface}(\`\${v}\`), or validate with 'as <type>' first)`,
          );
        }
        // Checked-dynamic values carry their own shape, so the runtime
        // renders them exactly like Node's console formatter renders a
        // non-format argument: strings VERBATIM, everything else through
        // inspect at the rest-args depth 2 (formatWithOptions) — scalar
        // kinds byte-exactly, boxed functions as [Function: name] /
        // [Function (anonymous)], composites through the dyn walk
        // (insp.dyn). Never throws — Node's console.log never does.
        if (lowered.type.kind === "dyn") {
          return {
            kind: "libCall",
            fn: "insp.dynS",
            args: [lowered, { kind: "numLit", value: 2, type: F64, loc }],
            type: STRING,
            loc,
          } satisfies IrExpr;
        }
        // A function VALUE prints Node's [Function: name] form by boxing
        // across the checked-dynamic boundary (the box carries the
        // best-effort reference-site name — the documented naming stance)
        // and rendering through the same dyn arm.
        if (
          lowered.type.kind === "func" &&
          canBoxFuncIntoDyn(lowered.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
        ) {
          const name = jsFuncNameOf(a);
          const boxed: IrExpr = {
            kind: "dynFrom",
            value: lowered,
            type: DYN,
            ...(name !== null ? { fnName: name } : {}),
            loc,
          };
          return {
            kind: "libCall",
            fn: "insp.dynS",
            args: [boxed, { kind: "numLit", value: 2, type: F64, loc }],
            type: STRING,
            loc,
          } satisfies IrExpr;
        }
        // number/string/boolean ride the ScrLogArg protocol directly (the
        // runtime formats them Node-exactly — including -0).
        if (lowered.type.kind === "f64" || lowered.type.kind === "string" || lowered.type.kind === "bool") {
          return lowered;
        }
        // Everything else renders through the static inspect machinery at
        // the rest-args depth 2 (formatWithOptions): arrays, records,
        // unions (a string arm prints VERBATIM — the console.log vs
        // inspect distinction, per arm), Maps/Sets, plain undefined/null,
        // regexes, symbols, error values, Buffers. Shapes inspect cannot
        // render fence honestly with the reason.
        return lowerConsoleInspectArg(L, a, lowered, surface, loc);
      });
      return {
        kind: "intrinsic",
        name: stdoutMember ? "console.log" : "console.error",
        args,
        type: VOID,
        loc,
      };
    }

    // The timer globals — setTimeout/clearTimeout, setInterval/
    // clearInterval, setImmediate/clearImmediate. Provenance-checked (a
    // user function shadowing the name has a different, non-ambient
    // symbol); the shared member dispatch also serves the node:timers
    // module forms (Node's timers module re-exports the globals).
    if (
      ts.isIdentifier(expr.expression) &&
      TIMER_MODULE_MEMBERS.has(expr.expression.text) &&
      L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined) &&
      // A named/destructured node:timers/promises import shares the
      // spelling but is the PROMISIFIED surface (`await setTimeout(1)`)
      // — its own builtin-module lowering owns it below.
      L.builtinImportOf(expr.expression)?.module !== "timers/promises"
    ) {
      const served = lowerTimersMemberCall(L, expr, expr.expression.text, loc);
      if (served) return served;
    }

    // queueMicrotask: the callback enters the SAME FIFO promise
    // continuations ride (one microtask order), and a throw surfaces as
    // an UNCAUGHT exception, like Node. A checked-dynamic argument (the
    // mustCall wrapper, the suite's invalid-input probes) routes to the
    // runtime form that throws Node's ERR_INVALID_ARG_TYPE synchronously
    // on non-functions; extra arguments are Node-ignored (evaluated
    // nowhere — a documented residue: Node evaluates them). Provenance-
    // checked like setTimeout.
    if (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "queueMicrotask" &&
      L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      if (expr.arguments.length === 0) {
        // Node: queueMicrotask() throws ERR_INVALID_ARG_TYPE at runtime
        // (the undefined callback) — the Dyn form delivers exactly that.
        return { kind: "libCall", fn: "timers.queueMicrotaskDyn", args: [dynUndefinedExpr(loc)], type: VOID, loc };
      }
      const raw = expr.arguments[0]!;
      const cb = L.lowerExpr(raw);
      if (cb.type.kind === "dyn") {
        return { kind: "libCall", fn: "timers.queueMicrotaskDyn", args: [cb], type: VOID, loc };
      }
      if (cb.type.kind !== "func" && (cb.kind === "unitLit" || L.dynConvertible(cb.type))) {
        // A statically-typed non-function (the invalid-input probes'
        // scalars and unions): Node's synchronous ERR_INVALID_ARG_TYPE,
        // through the Dyn form.
        return {
          kind: "libCall",
          fn: "timers.queueMicrotaskDyn",
          args: [{ kind: "dynFrom", value: cb, type: DYN, loc }],
          type: VOID,
          loc,
        };
      }
      const adapted = adaptZeroArgTimerCallback(L, cb, raw, loc);
      if (adapted.type.kind !== "func") {
        L.noLowering(
          `queueMicrotask with a '${L.fmt(cb.type)}' argument`,
          raw,
          "a zero-parameter function is the lowered form",
        );
      }
      return { kind: "libCall", fn: "timers.queueMicrotask", args: [adapted], type: VOID, loc };
    }

    // structuredClone: the JSON-safe + bytes subset over the checked-dynamic tree, deep;
    // %DOMException clones through WebIDL serialization (name/message,
    // the code re-derives). Functions/handles throw the spec's catchable
    // DataCloneError; cycles fence (the checked-dynamic tree cannot represent them — Node
    // clones cycles, a documented divergence). Option validation throws
    // Node's exact errors; the zero-argument call Node's
    // ERR_MISSING_ARGS. Provenance-checked like setTimeout.
    if (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "structuredClone" &&
      L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      if (expr.arguments.length === 0) {
        return { kind: "libCall", fn: "dyn.cloneMissing", args: [], type: DYN, loc };
      }
      if (expr.arguments.length > 2) {
        L.noLowering(`structuredClone with ${expr.arguments.length} arguments`, expr);
      }
      const toDynArg = (a: ts.Expression | undefined): IrExpr => {
        if (!a) return dynUndefinedExpr(loc);
        const v = L.lowerExpr(a);
        const conv = L.coerceToExpected(v, DYN);
        if (conv.type.kind !== "dyn") {
          L.noLowering(
            `structuredClone with a '${L.fmt(v.type)}' argument`,
            a,
            "JSON-safe data, bytes, and DOMException values are the cloneable subset",
          );
        }
        return conv;
      };
      const valueNode = expr.arguments[0]!;
      // A NON-EMPTY transfer array of static values: nothing static is
      // transferable, so the call is Node's DataCloneError — decided here
      // (the list's values need no dyn representation to fail). An EMPTY
      // literal transfer list is a no-op member and drops.
      {
        let optNode = expr.arguments[1];
        while (optNode && ts.isParenthesizedExpression(optNode)) optNode = optNode.expression;
        if (optNode && ts.isObjectLiteralExpression(optNode)) {
          const tr = optNode.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name !== undefined &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "transfer",
          );
          if (tr && ts.isArrayLiteralExpression(tr.initializer) && tr.initializer.elements.length > 0) {
            return { kind: "libCall", fn: "dyn.cloneTransferFail", args: [], type: DYN, loc };
          }
        }
      }
      const optsArg = toDynArg(expr.arguments[1]);
      // A DOMException value clones through its own runtime arm — the
      // typed result keeps the class (instanceof, .code, throwability).
      const valueT = L.mapTypeOf(L.typeOf(valueNode));
      if (valueT?.kind === "object" && valueT.className === "%DOMException") {
        const recv = L.lowerExpr(valueNode);
        return {
          kind: "libCall",
          fn: "error.domClone",
          args: [recv, optsArg],
          type: { kind: "object", className: "%DOMException" },
          loc,
        };
      }
      const value = toDynArg(valueNode);
      const cloned: IrExpr = { kind: "libCall", fn: "dyn.structuredClone", args: [value, optsArg], type: DYN, loc };
      // The declared result is the value's own type (the generic's T):
      // validate the dyn copy back into it when the type can be checked;
      // dyn-typed and unmappable results stay dyn values (JS files).
      const resultT = L.mapTypeOf(L.typeOf(expr));
      if (
        resultT !== null && resultT.kind !== "dyn" && resultT.kind !== "void" &&
        canDynCheckTo(resultT, (id) => L.shapes.get(id), (id) => L.unions.get(id))
      ) {
        return { kind: "dynCheck", value: cloned, type: resultT, loc };
      }
      return cloned;
    }

    // comptime: compile-time evaluation. Provenance-checked like setTimeout —
    // a user function named `comptime` has a different, non-ambient symbol
    // and takes the ordinary call paths.
    if (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "comptime" &&
      L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      return L.lowerComptime(expr);
    }

    // The lib constructors-as-functions with STATIC conversion semantics:
    // String(x) is exactly the template-literal ToString, Boolean(x) is
    // exactly the condition ToBoolean (union arms included), Number(x) is
    // ToNumber where it lowers exactly: numbers pass through, booleans
    // become 1/0, and strings run the runtime's ECMA-exact
    // StringToNumber (num.fromString — the full StringNumericLiteral
    // grammar, scr_string.c). Other argument types (unions included —
    // narrow first) keep the fence.
    // Provenance-checked like setTimeout; zero-arg forms are the JS
    // constants ("", false, 0). `new String(...)` (wrapper objects) stays
    // on the SC2020 fence.
    if (
      ts.isIdentifier(expr.expression) &&
      (expr.expression.text === "String" ||
        expr.expression.text === "Boolean" ||
        expr.expression.text === "Number") &&
      L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      const name = expr.expression.text;
      if (expr.arguments.length > 1) {
        L.noLowering(`${name} with ${expr.arguments.length} arguments`, expr);
      }
      const argNode = expr.arguments[0];
      if (!argNode) {
        if (name === "String") return { kind: "strLit", value: "", type: STRING, loc };
        if (name === "Boolean") return { kind: "boolLit", value: false, type: BOOL, loc };
        return { kind: "numLit", value: 0, type: F64, loc };
      }
      // String(e) on a catch binding: the snapshot's own ToString —
      // intercepted before lowerExpr (caughtRead would fence the raw read).
      if (name === "String") {
        const caught = L.caughtToString(argNode);
        if (caught) return caught;
      }
      // Boolean(x) IS condition position: route through lowerCondition so
      // `&&`/`||` operands descend as ToBoolean'd conditions (JS-exact —
      // `Boolean(a && b)` ≡ `Boolean(a) && Boolean(b)`, short-circuit
      // preserved). This also admits mixed-kind operands with no VALUE
      // representation (`Boolean(rec && list.some(f))` — a record and a
      // bool) that a value lowering of the `&&` would fence on.
      if (name === "Boolean") return L.lowerCondition(argNode);
      const arg = L.lowerExpr(argNode);
      if (name === "String") return L.ensureString(arg, argNode);
      if (arg.type.kind === "f64") return arg;
      if (arg.type.kind === "bool") {
        return {
          kind: "ternary",
          cond: arg,
          then: { kind: "numLit", value: 1, type: F64, loc },
          else_: { kind: "numLit", value: 0, type: F64, loc },
          type: F64,
          loc,
        };
      }
      if (arg.type.kind === "string") {
        return { kind: "libCall", fn: "num.fromString", args: [arg], type: F64, loc };
      }
      L.noLowering(
        `Number of ${L.fmt(arg.type)} values`,
        argNode,
        arg.type.kind === "union"
          ? "numbers, booleans, and strings lower (the full ToNumber string grammar included) — narrow the union first"
          : undefined,
      );
    }

    // __island_eval: the internal island testing hook (eval in the embedded
    // engine, String(result) back). Provenance-checked like setTimeout.
    // Only meaningful when the engine is linked: without --dynamic it is a
    // clean requires-dynamic diagnostic, never an ICE or a link error.
    if (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "__island_eval" &&
      L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      if (!L.dynamic) {
        L.pushDiag(requiresDynamicDiag("'__island_eval'", loc));
        throw new PoisonError();
      }
      const code = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      return { kind: "libCall", fn: "island.eval", args: [code], type: STRING, loc };
    }

    // Island calls. A property-access callee whose receiver is an 'any'
    // value is an engine method call (this = receiver, JS-exact); any other
    // 'any'-typed callee is an engine function call. Arguments marshal in;
    // results stay island values.
    // A questionDotToken here is always chain-handled (the gate at the top
    // of lowerCall routed unhandled ones to the chain lowering), so
    // `x?.y(...)` re-dispatches into this same method-call form with the
    // receiver reading back as the chain's bound handle.
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      L.isIslandExpr(expr.expression.expression)
    ) {
      // Typed fetch/Web Streams handles map to island values under
      // --dynamic, but their inventory still owns which methods exist.
      // Reject unsupported rows before the universal jsval method path.
      L.fenceStaticResponseMember(expr.expression, "call");
      L.fenceStaticHeadersMember(expr.expression, "call");
      L.fenceStaticReadableStreamMember(expr.expression, "call");
      const receiver = L.lowerExpr(expr.expression.expression);
      // A checker-`any` receiver whose VALUE lives in the checked-dynamic tree (a
      // checked-dynamic local behind the any-typed spelling — the JS
      // WeakSet placeholder, rest-args arrays): the checked-dynamic
      // method machinery owns it — receiver-kind dispatch, stored-member
      // calls, honest fences — never an engine op over a dyn value.
      if (receiver.type.kind === "dyn") {
        const served = lowerDynReceiverMethodCall(L, expr, expr.expression);
        if (served) return served;
        L.unsupported(
          "SC1100",
          expr,
          `'.${expr.expression.name.text}()' calls through 'unknown'-valued receivers in dynamically-executed positions`,
        );
      }
      const args = expr.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
      const result: IrExpr = {
        kind: "jsOp", op: "callMethod", name: expr.expression.name.text,
        args: [receiver, ...args], type: JSVAL, loc,
      };
      return islandPrimitiveExit(L, expr, result);
    }
    if (L.isIslandExpr(expr.expression)) {
      // `o.m(...)` where o LOWERS checked-dynamic and the checker types
      // `o.m` 'any' (a member read behind an 'object'/'unknown'-typed
      // bag): METHOD-CALL semantics — receiver-kind dispatch (dynInvoke),
      // so `this` binds and a WRAPPED island receiver runs the ENGINE's
      // own method (the routed-ops lane). A stored-member dynCall would
      // call engine prototype methods receiverless — the this-less
      // `list.slice()` ToObject TypeError. Spread arguments keep the
      // stored-member path below (the runtime-arity lane owns them).
      if (
        ts.isPropertyAccessExpression(expr.expression) &&
        !expr.expression.questionDotToken &&
        !expr.questionDotToken &&
        !expr.arguments.some((a) => ts.isSpreadElement(a))
      ) {
        const recvProbe = probeLower(L, expr.expression.expression);
        if (recvProbe?.type.kind === "dyn") {
          const args = expr.arguments.map((a) => L.lowerExprExpecting(a, DYN));
          return {
            kind: "dynInvoke",
            recv: recvProbe,
            method: expr.expression.name.text,
            calleeName: expr.expression.getText(),
            args,
            type: DYN,
            loc,
          };
        }
      }
      const callee = L.lowerExpr(expr.expression);
      // A checker-`any` callee that LOWERED checked-dynamic (a dyn member
      // chain's stored function): the checked-dynamic tree's own call — dynCall reads and
      // calls the stored member with Node's is-not-a-function TypeError
      // on refusal.
      if (callee.type.kind === "dyn") {
        const args = expr.arguments.map((a) => L.lowerExprExpecting(a, DYN));
        const calleeName = ts.isPropertyAccessExpression(expr.expression)
          ? expr.expression.getText()
          : ts.isIdentifier(expr.expression)
            ? expr.expression.text
            : "value";
        return { kind: "dynCall", callee, calleeName, args, type: DYN, loc };
      }
      // `fn(...args)` — a TRAILING spread into an island call: the
      // engine's own apply (`fn.apply(undefined, argsArray)`); leading
      // plain arguments prepend through `[l1, l2].concat(argsArray)`
      // (concat flattens the array argument one level — exactly the
      // spread). Other spread shapes keep the syntax fence.
      if (
        expr.arguments.length > 0 &&
        ts.isSpreadElement(expr.arguments[expr.arguments.length - 1]!) &&
        expr.arguments.slice(0, -1).every((a) => !ts.isSpreadElement(a))
      ) {
        const spread = expr.arguments[expr.arguments.length - 1] as ts.SpreadElement;
        const spreadV = L.jsvalIn(L.lowerExpr(spread.expression), spread.expression);
        const leading = expr.arguments.slice(0, -1).map((a) => L.jsvalIn(L.lowerExpr(a), a));
        const argsArr: IrExpr =
          leading.length === 0
            ? spreadV
            : {
                kind: "jsOp",
                op: "callMethod",
                name: "concat",
                args: [{ kind: "jsOp", op: "arrLit", args: leading, type: JSVAL, loc }, spreadV],
                type: JSVAL,
                loc,
              };
        const result: IrExpr = {
          kind: "jsOp",
          op: "callMethod",
          name: "apply",
          args: [callee, { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }, argsArr],
          type: JSVAL,
          loc,
        };
        return islandPrimitiveExit(L, expr, result);
      }
      const args = expr.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
      const result: IrExpr = { kind: "jsOp", op: "callFn", args: [callee, ...args], type: JSVAL, loc };
      return islandPrimitiveExit(L, expr, result);
    }

    // Builtin-module functions (fs, path, os, ...): named imports whose
    // binding resolves to a supported builtin specifier lower to `libCall`.
    // A user local shadowing an import has a different symbol and never
    // lands here. The fallback declarations make unsupported call forms
    // type errors; under @types/node the real (much wider) signatures
    // typecheck — options objects, omitted encodings, Buffer data — so the
    // supported form is fenced here per site. Members with no lowering at
    // all (fs.watch, os.cpus, ...) fence with the module-qualified name.
    if (ts.isIdentifier(expr.expression)) {
      // A call through a `const execFileAsync = promisify(execFile)`
      // binding — the one lowered util.promisify shape: the interned
      // async-exec helper (Node's promisified execFile behind an
      // already-settled promise).
      {
        const sym = L.resolveValueSymbol(expr.expression);
        if (sym && L.promisifiedExecFile.has(sym)) {
          return L.lowerExecFileAsyncCall(expr, loc);
        }
        // A call through a `const requestFn = tls ? https.request :
        // http.request` binding (the client-function ternary): the http
        // client lowering with the RUNTIME-secure dial.
        const rf = sym ? httpClientFnBindingOf(L, sym) : undefined;
        if (rf) return lowerHttpClientFnCall(L, expr, rf, loc);
      }
      const bi = L.builtinImportOf(expr.expression);
      if (bi) {
        // The timers spoke: the node:timers module's exports ARE the
        // timer globals (Node re-exports them), so a named/destructured
        // import lands on the same shared lowering. Unknown members fall
        // through to the module-qualified fence below.
        if (bi.module === "timers") {
          const timersServed = lowerTimersMemberCall(L, expr, bi.member, loc);
          if (timersServed) return timersServed;
        }
        // The server-surface spoke (lower-server.ts) owns the net module
        // wholesale — call shapes there are all special-cased (closures,
        // optional middles), so it never rides the param-table path.
        const served = L.lowerNetModuleCall(expr, bi, loc);
        if (served) return served;
        // The dgram spoke (lower-dgram.ts) owns dgram and dns the same way.
        const dgramServed = L.lowerDgramDnsModuleCall(expr, bi, loc);
        if (dgramServed) return dgramServed;
        // The assert spoke (lower-assert.ts) owns node:assert the same way
        // (`import { strictEqual } from "node:assert"` and the destructured
        // require twin land here).
        const assertServed = L.lowerAssertModuleCall(expr, bi, loc);
        if (assertServed) return assertServed;
        // The node:test spoke (lower-test.ts) owns node:test the same way
        // (`import { test, describe } from "node:test"` and the
        // destructured require twin land here).
        const testServed = L.lowerNodeTestModuleCall(expr, bi, loc);
        if (testServed) return testServed;
        // The util spoke (lower-inspect.ts) owns inspect/format —
        // `const { inspect } = require('util')` and the named-import
        // twin land here.
        const utilServed = L.lowerUtilModuleCall(expr, bi, loc);
        if (utilServed) return utilServed;
        // The stream spoke owns finished/pipeline (the callback forms)
        // and getDefaultHighWaterMark the same way.
        const streamServed = lowerStreamModuleCall(L, expr, bi, loc);
        if (streamServed) return streamServed;
        const fsTs = L.lowerFsToUnixTimestampCall(expr, bi, loc);
        if (fsTs) return fsTs;
        // The fs validation-ladder spoke (checked-dynamic lane): misuse
        // of implemented-namespace members throws Node's typed errors
        // instead of meeting the table fence.
        const fsLadder = L.lowerFsLadderCall(expr, bi, loc);
        if (fsLadder) return fsLadder;
        // The crypto introspection statics (getFips and the name lists)
        // bake at the call site — no runtime entry exists to table.
        const cryptoServed = L.lowerCryptoModuleCall(expr, bi, loc);
        if (cryptoServed) return cryptoServed;
        const builtinFn = builtinModuleFnOf(L, bi.module, bi.member);
        if (!builtinFn) {
          // Typed by @types/node (the fallback declarations only declare
          // what lowers, so this form is a type error there), no lowering:
          // the module-qualified member names the gap, and the ALIASED
          // symbol (the @types/node declaration) picks the blame wording.
          // Buffer-bound members (zlib, crypto.randomBytes) carry their
          // specific hint.
          L.noLowering(
            `${bi.module}.${bi.member}`,
            expr,
            builtinFenceHintOf(bi.module, bi.member),
            L.resolveValueSymbol(expr.expression),
          );
        }
        return L.lowerBuiltinModuleCall(expr, bi, builtinFn, loc);
      }
      // The assert module binding called DIRECTLY (`assert(x)` — a default
      // import or the CJS `const assert = require("assert")`): Node's
      // module object IS assert.ok; namespace-import bindings fence inside
      // (ES namespace objects are not callable in Node).
      {
        const direct = L.lowerAssertDirectCall(expr, loc);
        if (direct) return direct;
      }
      // The node:test module binding called DIRECTLY (`test(...)` — a
      // default import or the CJS `const test = require('node:test')`):
      // Node's module object IS the test function.
      {
        const direct = L.lowerTestDirectCall(expr, loc);
        if (direct) return direct;
      }
      // `Symbol(desc?)` — the global Symbol factory (provenance like
      // parseInt: a user function shadowing the name has a different,
      // non-stdlib symbol). A fresh runtime-unique identity per call;
      // the optional description must be a string (Node ToStrings other
      // values — no static lowering, fenced with the honest hint).
      // `new Symbol()` throws in Node and is a checker error — the
      // generic new fence keeps it.
      if (
        expr.expression.text === "Symbol" &&
        L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
      ) {
        if (expr.arguments.length > 1) {
          L.noLowering(`Symbol with ${expr.arguments.length} arguments`, expr);
        }
        const argNode = expr.arguments[0];
        // A literal `undefined` argument IS the no-description form
        // (Symbol(undefined).description is undefined, like Symbol()).
        if (
          !argNode ||
          (ts.isIdentifier(argNode) && argNode.text === "undefined")
        ) {
          return { kind: "libCall", fn: "sym.newAnon", args: [], type: SYMBOL_T, loc };
        }
        const desc = L.lowerExpr(argNode);
        if (desc.type.kind !== "string") {
          L.noLowering(
            `Symbol with a '${L.fmt(desc.type)}' description`,
            argNode,
            "only string descriptions lower (Node would ToString the value — convert it explicitly)",
          );
        }
        return { kind: "libCall", fn: "sym.new", args: [desc], type: SYMBOL_T, loc };
      }
      // STATIC parseInt/parseFloat/isNaN/isFinite (num.parseInt /
      // num.parseFloat / num.isNaN / number.isFinite — scr_string.c,
      // scr_lib.c; ECMA-exact, Node is the oracle). Provenance like the
      // island globals: a user function shadowing the name has a
      // different, non-stdlib symbol. parseInt's omitted radix completes
      // to 0 — the spec's "undefined" (base 10 with the 0x hex escape);
      // parseFloat lowers the STRING form only (Node would ToString other
      // values — no static story); isNaN/isFinite's arguments are
      // checker-pinned (or checked) to number, where the global's ToNumber
      // coercion is the identity and the tests are Number.isNaN /
      // Number.isFinite exactly (ms's `isFinite(val)` guard).
      if (
        (expr.expression.text === "parseInt" || expr.expression.text === "isNaN") &&
        L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
      ) {
        const name = expr.expression.text;
        const maxArgs = name === "parseInt" ? 2 : 1;
        if (expr.arguments.length < 1 || expr.arguments.length > maxArgs) {
          L.noLowering(
            `${name} with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
            expr,
          );
        }
        if (name === "isNaN") {
          const x = L.lowerExprExpecting(expr.arguments[0]!, F64);
          return { kind: "libCall", fn: "num.isNaN", args: [x], type: BOOL, loc };
        }
        const radix: IrExpr = expr.arguments[1]
          ? L.lowerExprExpecting(expr.arguments[1], F64)
          : { kind: "numLit", value: 0, type: F64, loc };
        const optional = lowerAbsenceProbe(L, expr.arguments[0]!);
        if (optional?.type.kind === "union") {
          const def = L.unions.get(optional.type.unionId);
          const stringTag = def?.arms.findIndex((arm) => arm.kind === "string") ?? -1;
          if (
            def &&
            stringTag >= 0 &&
            def.arms.every((arm) => arm.kind === "string" || isUnitType(arm))
          ) {
            const unionT = optional.type;
            const key = `parseInt.optional:${unionT.unionId}`;
            let helper = L.widthHelpers.get(key);
            if (!helper) {
              helper = `%parseInt.optional.${L.widthHelpers.size}`;
              L.widthHelpers.set(key, helper);
              const value: IrExpr = { kind: "varRef", localId: "value.0", type: unionT, loc };
              const radixRef: IrExpr = { kind: "varRef", localId: "radix.0", type: F64, loc };
              const body: IrStmt[] = def.arms.flatMap((arm, tag): IrStmt[] =>
                isUnitType(arm)
                  ? [{
                      kind: "if",
                      cond: { kind: "unionIsTag", unionId: unionT.unionId, tag, negated: false, value, type: BOOL, loc },
                      then: [{ kind: "return", value: { kind: "numLit", value: NaN, type: F64, loc }, loc }],
                      else_: null,
                      loc,
                    }]
                  : [],
              );
              body.push({
                kind: "return",
                value: {
                  kind: "libCall",
                  fn: "num.parseInt",
                  args: [{ kind: "unionNarrow", unionId: unionT.unionId, tag: stringTag, value, type: STRING, loc }, radixRef],
                  type: F64,
                  loc,
                },
                loc,
              });
              L.liftedFns.push({
                name: helper,
                params: [
                  { localId: "value.0", name: "value", type: unionT },
                  { localId: "radix.0", name: "radix", type: F64 },
                ],
                returnType: F64,
                locals: [
                  { id: "value.0", name: "value", type: unionT, mutable: true },
                  { id: "radix.0", name: "radix", type: F64, mutable: true },
                ],
                body,
                loc,
              });
            }
            return { kind: "call", callee: helper, args: [optional, radix], type: F64, loc };
          }
        }
        const s = L.lowerExprExpecting(expr.arguments[0]!, STRING);
        return { kind: "libCall", fn: "num.parseInt", args: [s, radix], type: F64, loc };
      }
      // STATIC parseFloat/isFinite over exactly-typed arguments —
      // parseInt's siblings (num.parseFloat is ECMA 19.2.4's decimal-
      // literal prefix parse in scr_string.c; a number-typed isFinite IS
      // Number.isFinite — the global's ToNumber coercion is the identity
      // there, ms's `isFinite(val)` guard). Other argument types fall
      // through to today's island path (--dynamic) or its SC2012 fence:
      // the ToNumber/ToString coercions on arbitrary values stay engine
      // territory. The probe never emits — lowering is IR construction.
      if (
        (expr.expression.text === "parseFloat" || expr.expression.text === "isFinite") &&
        expr.arguments.length === 1 &&
        L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
      ) {
        const name = expr.expression.text;
        const probed = probeLower(L, expr.arguments[0]!);
        if (name === "parseFloat" && probed?.type.kind === "string") {
          return { kind: "libCall", fn: "num.parseFloat", args: [probed], type: F64, loc };
        }
        if (name === "isFinite" && probed?.type.kind === "f64") {
          return { kind: "libCall", fn: "number.isFinite", args: [probed], type: BOOL, loc };
        }
      }
      // STATIC encodeURIComponent/encodeURI/decodeURIComponent
      // (str.encodeUriComponent / str.encodeUri / str.decodeUriComponent —
      // scr_string.c; ECMA-exact over the runtime's UTF-8 strings, Node
      // is the oracle). Provenance like parseInt: a user function
      // shadowing the name has a different, non-stdlib symbol. The
      // ENCODERS accept string | number | boolean — the spec ToStrings
      // first, which ensureString reproduces exactly for these types;
      // they are total (the spec's URIError is the unpaired surrogate,
      // which cannot exist in well-formed UTF-8). decode THROWS the
      // spec's URIError ("URI malformed") catchably and keeps the
      // string-only argument rule.
      if (
        (expr.expression.text === "encodeURIComponent" ||
          expr.expression.text === "encodeURI" ||
          expr.expression.text === "decodeURIComponent") &&
        L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
      ) {
        const name = expr.expression.text;
        if (expr.arguments.length !== 1) {
          L.noLowering(
            `${name} with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
            expr,
          );
        }
        const loc = locOf(expr);
        const argNode = expr.arguments[0]!;
        if (name === "decodeURIComponent") {
          const d = L.lowerExpr(argNode);
          if (d.type.kind !== "string") {
            L.noLowering(
              `${name} with a '${L.fmt(d.type)}' argument`,
              argNode,
              "only string arguments lower (Node would ToString the value — convert it explicitly)",
            );
          }
          return { kind: "libCall", fn: "str.decodeUriComponent", args: [d], type: STRING, loc };
        }
        const s = L.ensureString(L.lowerExpr(argNode), argNode);
        return {
          kind: "libCall",
          fn: name === "encodeURIComponent" ? "str.encodeUriComponent" : "str.encodeUri",
          args: [s],
          type: STRING,
          loc,
        };
      }
      // STATIC atob/btoa (str.atob / str.btoa — scr_string.c; WHATWG
      // forgiving-base64, Node is the oracle). The argument crosses as a
      // dyn value: WebIDL ToString runs in the runtime over the dyn kind
      // (Node's atob(null) decodes "null"), a malformed input throws the
      // catchable DOMException InvalidCharacterError, and the
      // zero-argument call throws Node's TypeError [ERR_MISSING_ARGS].
      // Provenance like parseInt: a shadowing user function has a
      // different, non-stdlib symbol.
      if (
        (expr.expression.text === "atob" || expr.expression.text === "btoa") &&
        L.isStdlibSymbol(L.resolveValueSymbol(expr.expression) ?? undefined)
      ) {
        const name = expr.expression.text;
        if (expr.arguments.length === 0) {
          return { kind: "libCall", fn: "str.b64Missing", args: [], type: STRING, loc };
        }
        if (expr.arguments.length > 1) {
          L.noLowering(`${name} with ${expr.arguments.length} arguments`, expr);
        }
        const argNode = expr.arguments[0]!;
        const v = L.lowerExpr(argNode);
        let data: IrExpr;
        if (v.type.kind === "dyn") {
          data = v;
        } else if (v.kind === "unitLit" || (v.type.kind !== "jsval" && L.dynConvertible(v.type))) {
          data = { kind: "dynFrom", value: v, type: DYN, loc };
        } else {
          L.noLowering(
            `${name} with a '${L.fmt(v.type)}' argument`,
            argNode,
            "string-convertible arguments lower (Node ToStrings the value — convert it explicitly)",
          );
        }
        return {
          kind: "libCall",
          fn: name === "atob" ? "str.atob" : "str.btoa",
          args: [data],
          type: STRING,
          loc,
        };
      }
      // Island-backed globals (parseFloat, isFinite): the engine's own
      // global function executes — callFn(globalGet(name)) — and the
      // result exits to the declared static type. A user function
      // shadowing the name has a different, non-stdlib symbol.
      const islFn = L.islandGlobalFnOf(expr.expression);
      if (islFn && expr.arguments.length !== islFn.args.length) {
        const name = expr.expression.text;
        L.noLowering(
          `${name} with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
          expr,
        );
      }
      if (islFn && expr.arguments.length === islFn.args.length) {
        L.requireDynamicApi(`'${expr.expression.text}'`, expr);
        const callee: IrExpr = {
          kind: "jsOp", op: "globalGet", name: expr.expression.text, args: [], type: JSVAL, loc,
        };
        const args = expr.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
        const result: IrExpr = {
          kind: "jsOp", op: "callFn", args: [callee, ...args], type: JSVAL, loc,
        };
        return { kind: "jsExit", value: result, type: islFn.ret, loc };
      }
    }

    // A TYPE-GUARD call on a catch binding (`isErrnoException(err)` —
    // `(x: unknown) => x is T` with a single-return body): the caught
    // snapshot cannot cross a call boundary (KEEP NARROW), so the
    // predicate's return expression inlines HERE with the parameter bound
    // to the caught local — every caught lowering (instanceof, `in`,
    // typeof tests) applies inside it, tsc's call-site narrowing types
    // the guarded branch, and a body construct with no caught lowering
    // fences per site at its own location.
    if (ts.isIdentifier(expr.expression) && expr.arguments.length === 1) {
      const caughtArg = L.caughtLocalOf(expr.arguments[0]!);
      if (caughtArg) {
        const inlined = lowerCaughtPredicateCall(L, expr, caughtArg);
        if (inlined) return inlined;
      }
    }

    // A MIXIN call in value position (`const Thing1 = Tagged(Derived)`,
    // an argument, a log): the value is the per-call-site instantiation's
    // immortal class object — everything downstream (construction,
    // statics, extends, instanceof, identity) rides the classval
    // machinery unchanged (lower-mixins.ts). Non-mixin callees fall
    // through untouched; a recognized mixin with an unsupported argument
    // or position fences by name inside.
    if (ts.isIdentifier(expr.expression)) {
      const mixinInfo = L.mixinCallClassInfoOf(expr);
      if (mixinInfo) return L.classValueRef(mixinInfo, expr);
    }

    // Direct call of a top-level declared function: the fast path (no
    // closure object, plain C call). Generic functions route through
    // monomorphization (the call targets a per-instantiation instance).
    if (ts.isIdentifier(expr.expression) && !L.isSelfReference(expr.expression)) {
      // A JS spread argument the compile-time completion cannot take (a
      // fixed position, a dynamic rest slot) sends the call down the
      // VALUE path — the runtime-arity lane (lowerSpreadArgsCall) boxes
      // the declaration's value and applies through a runtime-built
      // argument list. Typed .ts spreads keep completeArgs' rest packing.
      const jsSpreadArgs =
        expr.arguments.some((a) => ts.isSpreadElement(a)) && isJsSourceFile(expr.getSourceFile());
      if (L.isTopLevelFnSymbol(expr.expression) && !L.peekLocal(expr.expression)) {
        // `import g = N.f; g()` — the alias's own source-order guards
        // (a no-op for every non-import= binding).
        fenceEarlyAliasUse(L, expr.expression, expr);
        const generic = L.genericFnOf(expr.expression);
        // An implicit-any JS function spread-forwarded into: per-site
        // monomorphization has no slot for a runtime-length argument
        // list — the value path's boxed thunk delivers JS arity instead.
        if (generic && !(jsSpreadArgs && generic.implicitParams)) return L.lowerGenericCall(expr, generic);
        const sig = generic ? null : L.fnSigOf(expr.expression);
        if (sig && !(jsSpreadArgs && spreadNeedsRuntimeArity(sig.params, expr.arguments))) {
          L.noteEdge(sig.name);
          const args = L.completeArgs(expr.arguments, sig.params, loc, expr);
          return reconcileOverloadReturn(L, expr, { kind: "call", callee: sig.name, args, type: sig.returnType, loc });
        }
        // An ambient `declare function` nothing defines: Node evaluates
        // the callee first and throws ReferenceError before any argument
        // runs — undefRead reproduces it exactly (the ambient-namespace
        // callee stance; arguments never lower, Node never evaluates
        // them). The result type is what the use site sees; a VOID,
        // unmappable, or unregistered-class result takes the F64 dummy
        // (the read always throws first, so the dummy is never observed).
        if (ambientUndefinedFnSymbolOf(L, expr.expression)) {
          const mapped = L.mapTypeOf(L.typeOf(expr));
          const t =
            mapped && mapped.kind !== "void" && !L.typeNamesUnregisteredClass(mapped) ? mapped : F64;
          return nsUndefRead(L, expr.expression.text, expr, t);
        }
      }
      // Calls through a generic function value BINDING (`const f = <T>(x:
      // T) => x; f(1)`): the binding provably holds its initializer
      // forever (never-reassigned — bindingGenericFnInfoOf's fences), so
      // the call monomorphizes against it exactly like a generic function
      // declaration and the binding is never read. Symbol identity does
      // the discrimination — a shadowing local has its own symbol, and
      // registered bindings never declare locals or globals. Implicit-any
      // JS bindings spread-forwarded into skip to the value path (the
      // runtime-arity lane), like the declaration form above.
      {
        const generic = L.genericFnOf(expr.expression);
        if (generic && !(jsSpreadArgs && generic.implicitParams)) return L.lowerGenericCall(expr, generic);
      }
    }
    // Expando member calls (`example.isFoo('test')` after `example.isFoo
    // = fn`): read the member's global and call through the value —
    // lower-expando.ts owns the member storage.
    if (
      (ts.isPropertyAccessExpression(expr.expression) || ts.isElementAccessExpression(expr.expression)) &&
      !expr.expression.questionDotToken
    ) {
      const callee = expandoMemberRead(L, expr.expression);
      if (callee) {
        if (callee.type.kind !== "func") L.badType(expr.expression, L.typeOf(expr.expression));
        const params = callee.type.params;
        const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
        for (let i = args.length; i < params.length; i++) {
          const absent = omittedArgFor(L, params[i]!, loc);
          if (!absent) {
            L.unsupported("SC1090", expr, "calls omitting a non-optional parameter of the callee's type");
          }
          args.push(absent);
        }
        return { kind: "callValue", callee, args, type: callee.type.ret, loc };
      }
    }
    // Namespace-qualified calls (`N.f(1)`, `A.B.g()`, calls through
    // import= alias chains): the member resolves like a bare identifier —
    // the direct path when a signature exists (generic instantiation
    // included), the ordinary call-through-value otherwise. Guarded by the
    // namespace source-order fences (lower-namespaces.ts).
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      !expr.expression.questionDotToken &&
      ts.isIdentifier(expr.expression.name)
    ) {
      const nsMember = nsMemberIdentOf(L, expr.expression);
      if (nsMember) {
        // A builtin RE-EXPORT FACADE member (`import * as assert from
        // "./facade.js"` over `export { ok } from "node:assert"` —
        // a universal re-export facade): builtinMemberOf's alias chase
        // resolves the builtin module/member, and the spokes own the call
        // exactly as a direct builtin import. Ordinary user-module
        // members answer null there and resolve below.
        const facadeServed = L.lowerNamespaceBuiltinCall(expr, expr.expression);
        if (facadeServed) return facadeServed;
        const memberSym = L.checker.getSymbolAtLocation(nsMember);
        if (memberSym) fenceEarlyNsMemberRef(L, expr.expression, memberSym);
        const generic = L.genericFnOf(nsMember);
        if (generic) return L.lowerGenericCall(expr, generic);
        const sig = L.fnSigOf(nsMember);
        if (sig) {
          L.noteEdge(sig.name);
          const args = L.completeArgs(expr.arguments, sig.params, loc, expr);
          return reconcileOverloadReturn(L, expr, { kind: "call", callee: sig.name, args, type: sig.returnType, loc });
        }
        let callee = L.lowerExpr(nsMember);
        if (callee.type.kind === "record") callee = L.hybridCallUnwrap(callee);
        if (callee.type.kind !== "func") L.badType(expr.expression, L.typeOf(expr.expression));
        const params = callee.type.params;
        const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
        for (let i = args.length; i < params.length; i++) {
          const absent = omittedArgFor(L, params[i]!, loc);
          if (!absent) {
            L.unsupported("SC1090", expr, "calls omitting a non-optional parameter of the callee's type");
          }
          args.push(absent);
        }
        return { kind: "callValue", callee, args, type: callee.type.ret, loc };
      }
      // An AMBIENT namespace callee (`M.f()` where only `declare
      // namespace M` exists): Node evaluates the callee first and throws
      // ReferenceError before any argument runs — undefRead reproduces it
      // exactly (arguments never lower; Node never evaluates them).
      const ambientRoot = ambientNsRootOf(L, expr.expression.expression);
      if (ambientRoot !== null) {
        // The result type is what the use site sees; a VOID, unmappable,
        // or unregistered-class result takes the F64 dummy (the read
        // always throws first, so the dummy is never observed — tsc keeps
        // void results out of value positions).
        const mapped = L.mapTypeOf(L.typeOf(expr));
        const t =
          mapped && mapped.kind !== "void" && !L.typeNamesUnregisteredClass(mapped) ? mapped : F64;
        return nsUndefRead(L, ambientRoot.text, expr, t);
      }
    }
    // CommonJS namespace member calls (`lib.double(5)` where lib is
    // `const lib = require("./lib.js")`): the export table is alias
    // plumbing, so the member call IS a call of the exporter's declaration
    // — the direct path when a signature exists (generic instantiation
    // included), the ordinary call-through-value otherwise (func-typed
    // export globals).
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      !expr.expression.questionDotToken &&
      L.cjsLocalModuleBindingOf(expr.expression.expression)
    ) {
      // A binding whose dep is a class-expression WHOLE export
      // (`module.exports = class {…}`): `C.describe()` is a STATIC call
      // on that class — the static machinery answers before the member
      // delegation below resolves `describe` as a bare name (which no
      // binding form supports).
      const viaStatic = lowerStaticMethodCall(L, expr, expr.expression);
      if (viaStatic) return viaStatic;
      const nameId = expr.expression.name;
      if (!ts.isIdentifier(nameId)) {
        L.unsupported("SC1090", nameId, "private-named module members");
      }
      const generic = L.genericFnOf(nameId);
      if (generic) return L.lowerGenericCall(expr, generic);
      const sig = L.fnSigOf(nameId);
      if (sig) {
        L.noteEdge(sig.name);
        const args = L.completeArgs(expr.arguments, sig.params, loc, expr);
        return reconcileOverloadReturn(L, expr, { kind: "call", callee: sig.name, args, type: sig.returnType, loc });
      }
      let callee = L.lowerExpr(nameId);
      if (callee.type.kind === "record") callee = L.hybridCallUnwrap(callee);
      if (callee.type.kind !== "func") L.badType(expr.expression, L.typeOf(expr.expression));
      const params = callee.type.params;
      const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
      for (let i = args.length; i < params.length; i++) {
        const absent = omittedArgFor(L, params[i]!, loc);
        if (!absent) {
          L.unsupported("SC1090", expr, "calls omitting a non-optional parameter of the callee's type");
        }
        args.push(absent);
      }
      return { kind: "callValue", callee, args, type: callee.type.ret, loc };
    }
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const intrinsic =
        // Builtin namespace imports first (`fs.readFileSync(...)` where fs
        // is `import * as fs from "node:fs"`): the same tables and fences
        // as named builtin imports — before anything below tries to lower
        // the namespace object itself as a receiver.
        L.lowerNamespaceBuiltinCall(expr, expr.expression) ??
        // The node:perf_hooks spoke: performance.now() and its
        // .bind(performance) function value over the runtime's
        // process-start-anchored monotonic clock.
        lowerPerfHooksCall(L, expr, expr.expression) ??
        // The composed crypto pattern (randomBytes(n).toString(enc))
        // — its receiver is a Buffer-typed CALL no other lowering claims.
        L.lowerCryptoComposedCall(expr, expr.expression) ??
        L.lowerProcessMethodCall(expr, expr.expression) ??
        L.lowerJsonMethodCall(expr, expr.expression) ??
        // Reflect.apply of a builtin rest-parameter fn (fixtures.js's
        // fixturesPath idiom) — before the stdlib member fence claims it.
        lowerReflectApplyCall(L, expr, expr.expression) ??
        L.lowerNumberStaticCall(expr, expr.expression) ??
        L.lowerDateCall(expr, expr.expression) ??
        L.lowerTextCodecCall(expr, expr.expression) ??
        L.lowerStringStaticCall(expr, expr.expression) ??
        L.lowerStringLastIndexOfCall(expr, expr.expression) ??
        L.lowerPromiseMethodCall(expr, expr.expression) ??
        // Homogeneous promise-tuple literals claim BEFORE the static path
        // (whose array bound would fence them); Promise.reject follows it
        // (the static path leaves resolve/reject for the member fence).
        lowerPromiseAllTupleCall(L, expr, expr.expression) ??
        L.lowerPromiseStaticCall(expr, expr.expression) ??
        lowerPromiseRejectCall(L, expr, expr.expression) ??
        // Before the island path: regex-argument replace/replaceAll/split
        // lower STATICALLY; only the string-pattern overloads are island.
        L.lowerRegexMethodCall(expr, expr.expression) ??
        L.lowerUrlMethodCall(expr, expr.expression) ??
        L.lowerSearchParamsMethodCall(expr, expr.expression) ??
        L.lowerStatsMethodCall(expr, expr.expression) ??
        lowerFileHandleMethodCall(L, expr, expr.expression) ??
        L.lowerChildMethodCall(expr, expr.expression) ??
        // Piped child-output stream receivers — on/once("data" | "end").
        lowerChildStreamMethodCall(L, expr, expr.expression) ??
        // First-class process-stream receivers — write(data).
        lowerProcStreamMethodCall(L, expr, expr.expression) ??
        // FSWatcher receivers — close() (fs.watch's handle).
        lowerWatcherMethodCall(L, expr, expr.expression) ??
        // Atomics.wait — the synchronous-sleep idiom (no threads exist,
        // so the compare-then-sleep lowering IS the spec's behavior).
        L.lowerAtomicsCall(expr, expr.expression) ??
        // StringDecoder receivers — BEFORE the record method paths (the
        // decoder maps to its one-field pending record).
        L.lowerStringDecoderMethodCall(expr, expr.expression) ??
        // Dirent receivers — same story: the type probes read the record's
        // hidden %dtype field.
        lowerDirentMethodCall(L, expr, expr.expression) ??
        // readline Interface receivers — BEFORE the Timeout path (both
        // map to f64 handles; the checker symbol discriminates).
        L.lowerReadlineMethodCall(expr, expr.expression) ??
        // diagnostics_channel Channel receivers — the same f64-handle
        // story (publish/subscribe/unsubscribe).
        L.lowerDcChannelMethodCall(expr, expr.expression) ??
        // AsyncLocalStorage receivers — run/getStore/exit/enterWith over
        // the f64 store handle.
        L.lowerAlsMethodCall(expr, expr.expression) ??
        // TracingChannel receivers — subscribe/unsubscribe/traceSync/
        // traceCallback over the f64 tracing handle.
        L.lowerDcTracingChannelMethodCall(expr, expr.expression) ??
        L.lowerServerMethodCall(expr, expr.expression) ??
        L.lowerDgramMethodCall(expr, expr.expression) ??
        // node:test — skip/todo/only twins on named import bindings, the
        // TestContext surface (t.test/t.skip/t.diagnostic), t.assert.*.
        L.lowerTestMethodCall(expr, expr.expression) ??
        L.lowerTimeoutMethodCall(expr, expr.expression) ??
        L.lowerStringMethodCall(expr, expr.expression) ??
        // Typed-array/Buffer receivers and the Buffer statics — before the
        // island path (bytes never cross the boundary).
        L.lowerBytesMethodCall(expr, expr.expression) ??
        L.lowerBufferStaticCall(expr, expr.expression) ??
        // URL.revokeObjectURL's zero-argument contract (the one-argument
        // form keeps the fence — createObjectURL does too).
        lowerUrlStaticCall(L, expr, expr.expression) ??
        // Readable.from — the stream classes' one static (before the
        // stdlib chokepoint claims the member).
        lowerStreamStaticCall(L, expr, expr.expression) ??
        // Radix-free n.toString() is the STATIC number formatter (identical
        // to `${n}` / String(n)); the explicit-radix form stays island.
        lowerNumberToStringCall(L, expr, expr.expression) ??
        // Union receivers whose every arm has a text — the ngrok
        // `(chunk: Buffer | string) => chunk.toString()` idiom.
        lowerUnionToStringCall(L, expr, expr.expression) ??
        // Object.prototype.toString's default answer on records and
        // override-free program classes — "[object Object]", folded.
        lowerDefaultToStringCall(L, expr, expr.expression) ??
        // The remaining primitive prototype statics — toExponential(),
        // both toFixed() forms, hasOwnProperty over literal keys. Before
        // the island path. Optional-chain spellings first enter the chain
        // machinery above, then re-enter here with a narrowed chainRecv.
        lowerPrimitiveProtoCall(L, expr, expr.expression.expression,
          expr.expression.name.text, L.checker.getSymbolAtLocation(expr.expression.name)) ??
        // hasOwnProperty on a program class CONSTRUCTOR — own statics are
        // compile-time-known, so a literal key folds to a constant.
        lowerClassHasOwnPropertyCall(L, expr, expr.expression) ??
        // Response constructor-object operations are unsupported in both
        // tiers. Keep their SC2020 inventory contract ahead of the island
        // and generic-call fallbacks (Response.json otherwise reports the
        // generic SC1090 fence).
        L.fenceUnsupportedFetchConstructorMember(expr.expression) ??
        // Static fetch responses are checked-dynamic handles, but the
        // adopted undici declaration exposes a wider API than that handle.
        // Fence unimplemented members before either the island or generic
        // dyn receiver path can compile them into a runtime missing-method
        // failure. Dynamic-only rows pass through these checks unchanged.
        L.fenceStaticResponseMember(expr.expression, "call") ??
        L.fenceStaticHeadersMember(expr.expression, "call") ??
        L.fenceStaticReadableStreamMember(expr.expression, "call") ??
        L.lowerIslandMethodCall(expr, expr.expression) ??
        // Dyn receivers (JSON.parse-derived `unknown`/`any` values) —
        // validated-extract, then the static machinery. After the island
        // path (jsval receivers belong there), before the fences.
        lowerDynReceiverMethodCall(L, expr, expr.expression) ??
        // Narrowing filters (inferred predicates, filter(Boolean)) claim
        // their calls before the generic array HOF path types the result
        // by the receiver's own element.
        L.lowerFilterNarrowCall(expr, expr.expression) ??
        lowerArrayIsArrayCall(L, expr, expr.expression) ??
        lowerSymbolStaticCall(L, expr, expr.expression) ??
        lowerSymbolMethodCall(L, expr, expr.expression) ??
        lowerRegExpStaticCall(L, expr, expr.expression) ??
        // The composed en-US Intl.NumberFormat form — before the member
        // fences (the receiver's Intl.NumberFormat type has no mapping).
        lowerIntlNumberFormatCall(L, expr, expr.expression) ??
        lowerGroupByStaticCall(L, expr, expr.expression) ??
        // Iterator-helper chains rooted at arr.values() — before the
        // array method paths (the terminal names collide with array
        // methods, but only iterator-typed receivers reach this).
        lowerIteratorHelperCall(L, expr, expr.expression) ??
        lowerIteratorStaticFence(L, expr, expr.expression) ??
        lowerObjectStaticCall(L, expr, expr.expression) ??
        lowerObjectFromEntriesCall(L, expr, expr.expression) ??
        lowerArrayFromCall(L, expr, expr.expression) ??
        L.lowerArrayMethodCall(expr, expr.expression) ??
        // Read-only array methods (slice/map) on TUPLE receivers — the
        // positions snapshot into a fresh array (the for-of stance).
        lowerTupleReadMethodCall(L, expr, expr.expression) ??
        lowerGenMethodCall(L, expr, expr.expression) ??
        L.lowerMapMethodCall(expr, expr.expression) ??
        L.lowerSetMethodCall(expr, expr.expression) ??
        // Static method calls — on the class name directly (`C.make()`)
        // or through a class VALUE (devirtualized; shadowing fences).
        lowerStaticMethodCall(L, expr, expr.expression) ??
        L.lowerObjectMethodCall(expr, expr.expression) ??
        L.lowerRecordFieldCall(expr, expr.expression) ??
        // Object-literal GENERIC methods (excluded from record shapes) —
        // monomorphized against the defining literal's declaration.
        lowerObjLitGenericMethodCall(L, expr, expr.expression);
      if (intrinsic) return intrinsic;
      // A method call rooted at an initializer-less ambient `declare
      // const/var` whose declared type has no mapping: Node throws the
      // catchable ReferenceError at the ROOT read before the member, the
      // arguments, or the call — the whole call lowers to that throw,
      // typed by the use site (or its context; never observed).
      {
        const ambientRoot = ambientUndefVarRootOf(L, expr.expression);
        if (ambientRoot !== null) {
          const t = ambientUndefReadType(L, expr) ?? contextualUndefReadType(L, expr);
          if (t) return nsUndefRead(L, ambientRoot.text, expr, t);
        }
      }
      // The lib fence's METHOD-CALL chokepoint: a stdlib-declared member
      // that every lowering above declined — an unlowered member
      // (m.keys(), p.then(f), Object.keys(o)) or an unlowered call FORM of
      // a lowered one (Math.min with three arguments, s.padStart(8),
      // x.toFixed()).
      L.stdlibMemberFence(expr.expression);
      // The npm METHOD-CALL chokepoint: a call on a package-typed receiver
      // in a static build — attributed to the package.
      L.npmMemberFence(expr.expression);
      // The chalk shape: a FUNCTION carrying properties
      // (`Object.assign(identity, { bold })`, typed `F & { bold: F }`) —
      // a callable-record hybrid this representation doesn't model yet.
      // Name the shape and the working split instead of the generic
      // method fence.
      {
        const recvT = L.typeOf(expr.expression.expression);
        if (recvT.isIntersectionType() && L.checker.getCallSignatures(recvT).length > 0) {
          L.unsupported(
            "SC1090",
            expr,
            `calls through function-with-properties values ('${expr.expression.expression.getText()}' is callable AND carries members — the chalk shape; no hybrid representation exists yet: export the base and the property as separate functions)`,
          );
        }
      }
      // A GENERIC method no lowering above claimed — an ambient `declare
      // class`, an interface-typed receiver, a class whose collection
      // fenced: monomorphization needs a declaration WITH A BODY resolved
      // statically, and this receiver offers none. Name the shape instead
      // of the generic method fence.
      {
        const propSym = L.checker.getPropertyOfType(L.typeOf(expr.expression.expression), expr.expression.name.text);
        if (propSym && isGenericCallableMemberType(L.checker.getTypeOfSymbol(propSym), L.checker)) {
          L.unsupported(
            "SC1090",
            expr,
            `calls of the generic method '${expr.expression.name.text}' through this receiver (no compiled declaration with a body resolves statically here — ambient 'declare class' and interface-only methods are signature-only, and only class, static, and object-literal generic methods with bodies monomorphize)`,
          );
        }
      }
      L.unsupported("SC1090", expr, `method calls like '${expr.expression.getText()}'`);
    }

    // The element spelling of an unsupported native Web method must fence
    // before lowering the callee into a checked-dynamic keyed read.
    if (ts.isElementAccessExpression(expr.expression)) {
      const headersIterator = L.lowerDynamicHeadersIteratorCall(expr, expr.expression);
      if (headersIterator) return headersIterator;
      L.fenceUnsupportedFetchConstructorMember(expr.expression);
      L.fenceStaticResponseMember(expr.expression, "call");
      L.fenceStaticHeadersMember(expr.expression, "call");
      L.fenceStaticReadableStreamMember(expr.expression, "call");
    }

    // The ELEMENT spelling of a primitive method call — `x['toString']()`,
    // `s['charAt'](0)`: JS resolves it exactly like the dot form, so the
    // literal-keyed shapes with a static lowering route there before the
    // callee-as-value path could fence on the member read.
    if (
      ts.isElementAccessExpression(expr.expression) &&
      !expr.expression.questionDotToken &&
      !expr.questionDotToken &&
      ts.isStringLiteralLike(expr.expression.argumentExpression)
    ) {
      const memberName = expr.expression.argumentExpression.text;
      // ts7's getSymbolAtLocation does not resolve element accesses; the
      // member symbol comes from the receiver's (apparent) type instead —
      // same provenance answer as the dot spelling's name symbol.
      const recvType = L.typeOf(expr.expression.expression);
      const memberSym = L.checker.getPropertyOfType(recvType, memberName);
      const prim = lowerPrimitiveProtoCall(
        L,
        expr,
        expr.expression.expression,
        memberName,
        memberSym,
      );
      if (prim) return prim;
    }
    // Everything else: evaluate the callee as a value and call through it
    // (func-typed locals/params/captures, self-recursion, IIFEs, results of
    // calls). tsc guarantees the callee is callable; anything that lowers to
    // a non-func IR type was already rejected while lowering the callee.
    // HYBRID (function-with-properties) values call through their %call slot.
    let callee = L.lowerExpr(expr.expression);
    if (callee.type.kind === "record") callee = L.hybridCallUnwrap(callee);
    // A CHECKED-DYNAMIC callee — `fn(a, b)` where fn is an implicit-any
    // JS binding (the mustCall body's `fn(...args)`), a dyn capture, or a
    // keyed read off a dyn value: the dynCall boundary. Arguments convert
    // INTO dyn (typed values through dynFrom — closures box); the boxed
    // thunk validates them against the callee's declared signature and a
    // non-function callee throws Node's catchable "<name> is not a
    // function" TypeError. The result is dyn (checked per use like every
    // any-origin value). Spread arguments keep their fence.
    if (callee.type.kind === "dyn") {
      if (expr.arguments.some((a) => ts.isSpreadElement(a))) {
        // The runtime-arity lane: a dyn callee is already boxed — the
        // spread-marked dynCall applies through a fresh dyn argument
        // array (lowerSpreadArgsCall). Sources outside it keep the fence.
        const spreadServed = lowerSpreadArgsCall(L, expr, callee, loc);
        if (spreadServed) return spreadServed;
        L.unsupported("SC1090", expr, "spread arguments in calls through 'unknown' values");
      }
      const args = expr.arguments.map((a) => L.lowerExprExpecting(a, DYN));
      const calleeName = ts.isPropertyAccessExpression(expr.expression) || ts.isElementAccessExpression(expr.expression)
        ? expr.expression.getText()
        : ts.isIdentifier(expr.expression)
          ? expr.expression.text
          : "value";
      return { kind: "dynCall", callee, calleeName, args, type: DYN, loc };
    }
    if (callee.type.kind !== "func") {
      L.badType(expr.expression, L.typeOf(expr.expression));
    }
    // A SPREAD argument on a func-typed callee — the rest-forwarding
    // idiom (`(...args) => from(...args)`): the runtime-arity lane boxes
    // or marshals the callee and applies through a runtime-built argument
    // list (lowerSpreadArgsCall). Shapes outside its lanes fall through
    // to the historical fences.
    if (expr.arguments.some((a) => ts.isSpreadElement(a))) {
      const spreadServed = lowerSpreadArgsCall(L, expr, callee, loc);
      if (spreadServed) return spreadServed;
    }
    // An ISLAND-REST func value called directly (`f(1, 2)` where f is the
    // --dynamic `(...args) =>` lambda): the type SPELLS its trailing
    // engine-array param — complete the call exactly like completeArgs'
    // island pack (fixed slots positionally, missing ones with the
    // engine's undefined, the surplus marshaled into one fresh engine
    // array). JS arity, no runtime machinery.
    if (
      callee.type.rest === true &&
      callee.type.restAbi === "jsval" &&
      callee.type.params.length >= 1 &&
      callee.type.params[callee.type.params.length - 1]!.kind === "jsval" &&
      !expr.arguments.some((a) => ts.isSpreadElement(a))
    ) {
      const fixed = callee.type.params.slice(0, -1);
      const args: IrExpr[] = fixed.map((p, i) => {
        const a = expr.arguments[i];
        if (a) return L.lowerExprExpecting(a, p);
        const absent = omittedArgFor(L, p, loc);
        if (!absent) {
          L.unsupported("SC1090", expr, "calls omitting a non-optional parameter of the callee's type");
        }
        return absent;
      });
      const restArgs = expr.arguments.slice(fixed.length).map((a) => L.lowerExprExpecting(a, JSVAL));
      args.push({ kind: "jsOp", op: "arrLit", args: restArgs, type: JSVAL, loc });
      return { kind: "callValue", callee, args, type: callee.type.ret, loc };
    }
    // A JS call with MORE arguments than the callee's lowered signature
    // (`cb(1, 'x')` where the mustCall wrapper's inferred type declared
    // fewer params — tsc's JS world doesn't police arity): ride the
    // checked-dynamic boundary — box the callee, dynCall — which delivers
    // JS arity exactly (the thunk ignores extras). Result dyn, checked
    // per use like every any-origin value.
    if (
      (expr.arguments.length > callee.type.params.length || callee.type.rest === true) &&
      isJsSourceFile(expr.getSourceFile()) &&
      !expr.arguments.some((a) => ts.isSpreadElement(a)) &&
      canBoxFuncIntoDyn(callee.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
    ) {
      const args = expr.arguments.map((a) => L.lowerExprExpecting(a, DYN));
      const calleeName = ts.isIdentifier(expr.expression) ? expr.expression.text : "value";
      const boxed: IrExpr = { kind: "dynFrom", value: callee, type: DYN, loc };
      return { kind: "dynCall", callee: boxed, calleeName, args, type: DYN, loc };
    }
    const params = callee.type.params;
    const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
    // Optional-param func TYPES map their `x?: T` slots as `T | undefined`
    // ABI unions, and tsc admits calls that omit the optional suffix —
    // complete the missing trailing args with the interned undefined arm,
    // exactly what completeArgs does for direct calls (the ABI stays
    // count-exact). A missing arg whose param has no undefined arm means
    // the callee value's type spelled a required param tsc let the caller
    // skip — not a shape this surface models; fence.
    for (let i = args.length; i < params.length; i++) {
      // A missing argument completes with the slot's absent value — the
      // interned undefined arm, the dyn undefined for checked-dynamic
      // slots (a JS-inferred wrapper like mustCall's, called short), or
      // the engine undefined for island slots.
      const absent = omittedArgFor(L, params[i]!, loc);
      if (!absent) {
        L.unsupported("SC1090", expr, "calls omitting a non-optional parameter of the callee's type");
      }
      args.push(absent);
    }
    return { kind: "callValue", callee, args, type: callee.type.ret, loc };
  }

/** The RUNTIME-ARITY spread call — `f(...args)`, the rest-forwarding idiom
   * (`const f = (...args) => from(...args)`): a spread whose length is a
   * runtime fact has no home in the compile-time completion, so the call
   * rides a dynamic boundary instead. Two lanes, picked by the spread
   * source's tier:
   *
   * - CHECKED-DYNAMIC (dyn spread sources — a JS rest binding, a dyn
   *   value): box the callee (dynFrom; a dyn callee is already boxed),
   *   convert every argument into dyn, and emit the spread-marked dynCall
   *   — the emitters build one fresh dyn argument array (spreads flatten
   *   left-to-right, non-iterables throw V8's TypeError) and apply through
   *   it; the boxed thunk delivers JS arity exactly. Result dyn, checked
   *   per use like every any-origin value.
   * - ISLAND (a jsval spread source — the --dynamic rest binding is the
   *   engine's own arguments array): marshal the callee in and emit jsOp
   *   callSpread — the prelude helper's REAL `f(...pre, ...s)`, so
   *   iterator protocols and the not-iterable TypeError are the engine's
   *   own. One trailing spread after the fixed arguments is the modeled
   *   shape (exactly the forwarding idiom).
   *
   * Answers null when neither lane fits (typed .ts spreads keep
   * completeArgs' rest packing and its fences). JS sources only — the
   * same guard as the over-arity dynCall precedent. */
  export function lowerSpreadArgsCall(L: Lowerer, expr: ts.CallExpression, callee: IrExpr, loc: SrcLoc): IrExpr | null {
    if (!isJsSourceFile(expr.getSourceFile())) return null;
    if (!expr.arguments.some((a) => ts.isSpreadElement(a))) return null;
    if (callee.type.kind !== "dyn" && callee.type.kind !== "func" && callee.type.kind !== "jsval") return null;
    const calleeName =
      ts.isPropertyAccessExpression(expr.expression) || ts.isElementAccessExpression(expr.expression)
        ? expr.expression.getText()
        : ts.isIdentifier(expr.expression)
          ? expr.expression.text
          : "value";
    // Lower every argument ONCE, in source order (the IR nests them in
    // exactly this order, so runtime evaluation order is JS's).
    const parts = expr.arguments.map((a) =>
      ts.isSpreadElement(a)
        ? { spreadOf: a.expression, node: null, v: L.lowerExpr(a.expression) }
        : { spreadOf: null, node: a as ts.Expression, v: L.lowerExpr(a) },
    );
    const spreadParts = parts.filter((p) => p.spreadOf !== null);
    const getR = (id: string) => L.shapes.get(id);
    const getU = (id: string) => L.unions.get(id);
    const anyJsvalSpread = spreadParts.some((p) => p.v.type.kind === "jsval");
    if (
      !anyJsvalSpread &&
      (callee.type.kind === "dyn" || (callee.type.kind === "func" && canBoxFuncIntoDyn(callee.type, getR, getU))) &&
      spreadParts.every((p) => p.v.type.kind === "dyn" || canConvertToDyn(p.v.type, getR, getU))
    ) {
      const args: IrExpr[] = [];
      const spreads: { arg: number; what: string }[] = [];
      for (const p of parts) {
        if (p.spreadOf !== null) {
          // The spelling rides along for V8's nullish spread-call
          // TypeError ("v is not iterable (cannot read property ...)").
          spreads.push({ arg: args.length, what: p.spreadOf.getText() });
          args.push(L.coerceInto(p.spreadOf, p.v, DYN));
        } else {
          args.push(L.coerceInto(p.node!, p.v, DYN));
        }
      }
      const boxed = callee.type.kind === "dyn" ? callee : L.coerceInto(expr.expression, callee, DYN);
      return { kind: "dynCall", callee: boxed, calleeName, args, spreads, type: DYN, loc };
    }
    if (
      spreadParts.length > 0 &&
      spreadParts.every((p) => p.v.type.kind === "jsval") &&
      (callee.type.kind === "jsval" || callee.type.kind === "func")
    ) {
      if (spreadParts.length !== 1 || parts[parts.length - 1]!.spreadOf === null) {
        L.unsupported(
          "SC1090",
          expr,
          "spread arguments before positional arguments in island calls (one trailing spread after the fixed arguments is the supported form)",
        );
      }
      const f = L.coerceInto(expr.expression, callee, JSVAL);
      const pre: IrExpr[] = parts
        .slice(0, -1)
        .map((p) => L.coerceInto(p.node!, p.v, JSVAL));
      const preArr: IrExpr = { kind: "jsOp", op: "arrLit", args: pre, type: JSVAL, loc };
      const last = parts[parts.length - 1]!;
      // The spelling rides in `name` for V8's nullish spread-call
      // TypeError ("v is not iterable (cannot read property ...)").
      return { kind: "jsOp", op: "callSpread", name: last.spreadOf!.getText(), args: [f, preArr, last.v], type: JSVAL, loc };
    }
    // No lane fits (a spread source outside both tiers, a callee neither
    // boxable nor marshalable, mixed dyn/jsval spreads): fence HERE — the
    // arguments are already lowered, and falling back to the historical
    // per-site fences would lower them a second time (duplicate lambda
    // lifts, duplicated diagnostics).
    L.unsupported("SC1090", expr, "spread arguments");
  }

/** True when a spread argument lands where the compile-time completion
   * cannot take it — a FIXED parameter position, or a dynamic rest slot
   * (dynRest/islandRest, whose packs are built per-argument): the shapes
   * the runtime-arity lane (lowerSpreadArgsCall) serves. Typed `rest`
   * slots keep completeArgs' same-element spread packing. */
  export function spreadNeedsRuntimeArity(shapes: readonly ParamShape[], argNodes: readonly ts.Expression[]): boolean {
    const restAt = shapes.findIndex((s) => s.mode === "rest" || s.mode === "dynRest" || s.mode === "islandRest");
    return argNodes.some(
      (a, i) =>
        ts.isSpreadElement(a) && (restAt < 0 || i < restAt || shapes[restAt]!.mode !== "rest"),
    );
  }

/** METHOD calls on dyn receivers (`pkg.name.replace(...)`, `rawName.split`,
 * `ws.packages.filter(...)` — JSON.parse-derived values): validate the
 * receiver's dyn kind, extract, and ride the STATIC method machinery — the
 * dyn boundary's trust-but-verify stance extended to receivers. The
 * receiver-kind mismatch throws V8's own catchable TypeErrors (nullish:
 * "Cannot read properties of undefined (reading 'replace')"; other kinds:
 * "pkg.name.replace is not a function") — though BEFORE the arguments
 * evaluate, where JS evaluates them first for the non-nullish case
 * (SEMANTICS.md). String methods ride the string/regex intrinsic tables
 * through a validated-string receiver; `.filter` runs the predicate over
 * the dyn array and validated-extracts the survivors into the element type
 * the checker committed the result to. Null when the receiver isn't a dyn
 * value or the method isn't claimable (the method-call fence stays). */
  function lowerDynReceiverMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(call, access)) return null;
    // Only checker-untyped receivers: `any`/`unknown`, or the `any[]` an
    // Array.isArray guard narrows them to (the value is STILL the checked-dynamic tree
    // array — scalar narrowings bridge through maybeNarrow's dynCheck and
    // take the ordinary typed paths, but there is no static home for an
    // any-elemented array). Typed receivers keep their own lowerings.
    const recvTs = L.typeOf(access.expression);
    const arrayReceiver = L.checker.isArrayType(recvTs);
    const anyArray =
      arrayReceiver &&
      ((L.checker.getTypeArguments(recvTs as ts.TypeReference)[0]?.flags ?? 0) &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    let recv: IrExpr;
    if (recvTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || anyArray) {
      recv = L.lowerExpr(access.expression);
    } else {
      // A checker-TYPED spelling whose VALUE is still checked-dynamic (an
      // evolving `let h = {}` object flowing back out of a JS helper —
      // tsc types the return by the evolved shape, the binding lowered
      // dyn): probe the lowering and claim exactly the dyn results.
      const probed = probeLower(L, access.expression);
      if (probed?.type.kind !== "dyn") return null;
      recv = probed;
    }
    // A checker-`any` receiver that already lowered to a real STRING (the
    // chained form — `cfg.host.trim().toLowerCase()`, where the first step
    // extracted): no validation needed, ride the string tables directly.
    if (recv.type.kind === "string") {
      return lowerRegexMethodCall(L, call, access, () => recv) ?? lowerStringMethodCall(L, call, access, () => recv);
    }
    if (recv.type.kind !== "dyn") return null;
    // Typed-destination filter first (validated extraction into a real
    // T[]); an untyped destination falls through to the runtime dispatch
    // below (the survivors stay dyn values).
    if (access.name.text === "filter") {
      const extracted = lowerDynArrayFilterCall(L, call, access, recv);
      if (extracted) return extracted;
    }
    if (access.name.text === "flatMap") return lowerDynArrayFlatMapCall(L, call, access, recv);
    // String methods claim only names NO other dyn-representable kind's
    // prototype declares (Array carries includes/indexOf/slice too): for
    // these, "the receiver is a string, or the call throws V8's TypeError"
    // IS Node's semantics for every possible dyn value. Shared names would
    // need a receiver-kind dispatch — they keep the fence.
    if (DYN_STRING_ONLY_METHODS.has(access.name.text)) {
      const checked = (): IrExpr => dynStringReceiver(L, recv, access);
      return lowerRegexMethodCall(L, call, access, checked) ?? lowerStringMethodCall(L, call, access, checked);
    }
    // toString() is a shared prototype name with its OWN receiver-kind
    // dispatched runtime lowering (dyn.toString: Buffer-flavored bytes
    // decode per the encoding — a stream chunk's common consumption —
    // and strings/numbers/booleans/arrays/objects answer JS-exactly).
    // The optional argument is a literal encoding (meaningful for bytes;
    // JS ignores extra toString arguments on the other kinds, and so
    // does the runtime dispatch).
    if (access.name.text === "toString" && call.arguments.length <= 1) {
      const enc = call.arguments[0]
        ? bufEncoding(L, "toString", call.arguments[0])
        : "utf8";
      // The source spelling rides along for the ONE receiver whose
      // prototype lacks toString: a null-prototype dictionary throws
      // Node's "<spelling> is not a function" at runtime.
      return {
        kind: "libCall",
        fn: "dyn.toString",
        args: [
          recv,
          { kind: "strLit", value: enc, type: STRING, loc: locOf(call) },
          { kind: "strLit", value: access.getText(), type: STRING, loc: locOf(call) },
        ],
        type: STRING,
        loc: locOf(call),
      };
    }
    // SHARED prototype names with a runtime dispatch (scr_dyn_invoke):
    // push/slice/join/forEach/map/apply/... dispatch on the receiver's
    // RUNTIME kind — the honest answer for names more than one dyn-
    // representable prototype declares (test/common's mustCall internals:
    // mustCallChecks.push(context), failed.forEach(fn), fn.apply(this,
    // args)). Implemented (kind, name) pairs run JS-exact; real-but-
    // unimplemented methods throw a LOUD not-supported Error; names the
    // kind's prototype lacks throw Node's "x.y is not a function"; OBJ
    // receivers call the own member.
    const dispatched = lowerDynDispatchMethodCall(L, call, access, recv, arrayReceiver);
    if (dispatched) return dispatched;
    // Names NO dyn-representable prototype declares: the member can only
    // be an OWN property, so "read the member, call it" IS Node's
    // semantics for every possible dyn value — `handlers.onDone(x)` on a
    // checked-dynamic object calls the stored function (dynKeyGet answers
    // the member or undefined; dynCall throws Node's exact catchable
    // "handlers.onDone is not a function" on a non-function). Prototype
    // names (map/join/hasOwnProperty/call/...) keep the fence: on a real
    // dyn array/string/object Node would run the METHOD, which no stored
    // member models. Order note: JS reads the callee before evaluating
    // arguments — dynKeyGet's undefined-receiver TypeError fires first,
    // exactly Node.
    if (DYN_PROTO_METHOD_NAMES.has(access.name.text)) return null;
    // Optional forms (`obj.cb?.()`, `obj?.cb()`) belong to the chain
    // machinery's short-circuit semantics — not modeled here yet.
    if (call.questionDotToken || access.questionDotToken) return null;
    const loc = locOf(call);
    if (call.arguments.some((a) => ts.isSpreadElement(a))) {
      L.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
    }
    const member: IrExpr = {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: access.name.text, type: STRING, loc: locOf(access) },
      value: recv,
      type: DYN,
      loc: locOf(access),
    };
    const args = call.arguments.map((a) => L.lowerExprExpecting(a, DYN));
    return { kind: "dynCall", callee: member, calleeName: access.getText(), args, type: DYN, loc };
  }

/** Prototype method names of the checked-dynamic tree-representable kinds (String, Array,
 * Object, Function, Number prototypes): a dyn receiver call on one of
 * these could be a REAL method on a real value, which a stored-member
 * read would silently mis-answer — they keep the fence. Everything else
 * is own-property-or-throw for every dyn value (the honest dynCall). */
const DYN_PROTO_METHOD_NAMES = new Set([
  // Object.prototype
  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf",
  // Function.prototype
  "apply", "bind", "call",
  // Array.prototype (less the dyn-claimed filter/flatMap — still listed:
  // the claim above runs first)
  "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toReversed", "toSorted", "toSpliced", "unshift", "values", "with",
  // String.prototype (the shared-name remainder — the string-only set
  // was claimed above)
  "anchor", "big", "blink", "bold", "codePointAt", "fixed", "fontcolor", "fontsize", "isWellFormed", "italics", "link", "localeCompare", "normalize", "small", "strike", "sub", "sup", "toLocaleLowerCase", "toLocaleUpperCase", "toWellFormed",
  // Number.prototype
  "toExponential", "toFixed", "toPrecision",
]);

/** The SHARED prototype names scr_dyn_invoke dispatches at runtime (the
 * subset of DYN_PROTO_METHOD_NAMES with a receiver-kind dispatch): the
 * runtime runs the real method for the receiver's kind, throws Node's
 * is-not-a-function where the kind's prototype lacks the name, and
 * fences LOUDLY on real-but-unimplemented pairs. */
export const DYN_DISPATCH_METHODS = new Set([
  "apply", "call",
  "push", "pop", "shift", "unshift", "slice", "at",
  "indexOf", "lastIndexOf", "includes", "join", "concat", "reverse", "sort",
  "forEach", "map", "filter", "some", "every", "find", "findIndex",
  // The native-handle receiver surface (SCR_DYN_HANDLE — req/res/socket
  // boxed through the checked-dynamic boundary): these names dispatch on
  // the runtime kind so a boxed IncomingMessage/ServerResponse/Socket
  // routes onto the same entry points the static lowerings use (modeled
  // members) or the loud not-supported ladder (real-but-unmodeled ones).
  // On every other dyn kind they answer exactly what the stored-member
  // path answered (OBJ own members call; the rest throw Node's
  // is-not-a-function).
  "on", "once", "addListener", "removeListener", "off", "removeAllListeners",
  "emit", "prependListener", "prependOnceListener", "listeners", "listenerCount",
  "write", "end", "destroy", "pipe", "unpipe", "resume", "pause",
  "setEncoding", "setDefaultEncoding", "setTimeout", "read", "isPaused",
  "writeHead", "setHeader", "getHeader", "hasHeader", "removeHeader",
  "getHeaders", "getHeaderNames", "appendHeader", "flushHeaders",
  "append", "delete", "get", "getSetCookie", "has", "set",
  "writeContinue", "writeEarlyHints", "cork", "uncork", "addTrailers",
  "ref", "unref", "address", "setNoDelay", "setKeepAlive", "connect",
  "resetAndDestroy", "destroySoon",
  // The Agent handle's own member (no other dyn prototype declares it,
  // so the remainder keeps the stored-member answers).
  "getName",
  // The netServer half of the handle surface (`let server; server =
  // createServer(...)` — the handle lives in a dyn binding whose
  // closures the checker cannot narrow): listen/close dispatch onto the
  // server ops; no other dyn prototype declares either name, so the
  // remainder keeps the stored-member answers.
  "listen", "close",
  // The native WHATWG readable-stream and AbortSignal handles used by
  // static fetch. These route through SCR_DYN_HANDLE dispatch just like
  // the http/net names above.
  "getReader", "cancel", "releaseLock", "enqueue", "error",
  "throwIfAborted", "addEventListener", "removeEventListener",
  "dispatchEvent",
  "preventDefault", "stopPropagation", "stopImmediatePropagation",
  "composedPath",
  "json", "text", "bytes",
  // Promise.prototype (SCR_DYN_PROMISE receivers): the reaction trio
  // rides the fiber machinery (scr_dyn_promise_then); on every other dyn
  // kind then/catch/finally answer the stored-member path (OBJ own
  // members call, the rest throw Node's is-not-a-function).
  "then", "catch", "finally",
  // The h2 session/stream half (SCR_DYNH_H2_SESSION/STREAM — boxed
  // through a mustCall-wrapped listener's parameter): request/respond
  // and the stream/session methods dispatch onto the http2 ops. Names
  // shared with the http/net surface (write/end/close/on/...) are
  // already above; these are the h2-only additions.
  "respond", "respondWithFile", "respondWithFD", "pushStream",
  "request", "sendTrailers", "priority", "settings", "goaway", "ping",
  "additionalHeaders", "altsvc", "origin",
]);

export function lowerDynDispatchMethodCall(
  L: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
  arrayReceiver: boolean,
): IrExpr | null {
  const method = access.name.text;
  if (!DYN_DISPATCH_METHODS.has(method) || call.questionDotToken || access.questionDotToken) return null;
  if (call.arguments.some((arg) => ts.isSpreadElement(arg))) {
    L.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
  }
  const predicate = method === "filter" && call.arguments[0]
    ? L.lowerExpr(call.arguments[0])
    : null;
  if (arrayReceiver && predicate?.type.kind === "func" && predicate.type.ret.kind === "void") {
    L.unsupported(
      "SC1090",
      call.arguments[0]!,
      "'.filter()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)",
    );
  }
  const args = call.arguments.map((arg, i) =>
    i === 0 && predicate ? L.coerceInto(arg, predicate, DYN) : L.lowerExprExpecting(arg, DYN),
  );
  return {
    kind: "dynInvoke",
    recv,
    method,
    calleeName: access.getText(),
    args,
    type: DYN,
    loc: locOf(call),
  };
}

/** STR_METHODS ∪ the regex-form names, MINUS everything Array (or any
 * other dyn kind's prototype) also declares. */
const DYN_STRING_ONLY_METHODS = new Set([
  "charCodeAt", "charAt", "startsWith", "endsWith", "substring", "repeat",
  "trim", "trimStart", "trimEnd", "split", "padStart", "padEnd",
  "toLowerCase", "toUpperCase", "replace", "replaceAll", "match", "matchAll",
  "search",
]);

/** `Array.isArray(v)` — a real runtime test on `unknown` values (the checked-dynamic tree's
 * array kind: dyn arrays answer true, bytes/objects/scalars false — exactly
 * JS, Uint8Array included), a compile-time constant on statically-typed
 * ones (an `T[]` value IS an array, every other static kind is not; folded
 * only over side-effect-free reads, the `in`-operator discipline; unions
 * fence with the narrow-first hint). Null when the callee isn't THE
 * stdlib Array.isArray, so the chain keeps trying. */
  function lowerArrayIsArrayCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (L.stdlibGlobalMember(access, "Array") !== "isArray") return null;
    if (call.arguments.length !== 1) return null; // the stdlib chokepoint fences
    const argNode = call.arguments[0]!;
    const arg = L.lowerExpr(argNode);
    const loc = locOf(call);
    if (arg.type.kind === "dyn") {
      return { kind: "dynTest", test: "array", value: arg, type: BOOL, loc };
    }
    if (arg.type.kind === "union") {
      // A union answers by its RUNTIME TAG: true iff the active arm is an
      // array value (homogeneous array or fixed tuple; bytes arms answer
      // false — Array.isArray(new Uint8Array) is false in JS too). One
      // array arm compiles to the plain tag test
      // (`Array.isArray(tlds)` on `string | readonly string[]` — the
      // narrowing test tsc's control flow then builds on); several array
      // arms OR their tag tests, and zero arms fold to false — both only
      // over side-effect-free reads (the operand re-evaluates/drops, the
      // `in`-operator fold discipline). dyn/caught/jsval arms have no
      // static tag answer and keep the narrow-first fence.
      const def = L.unions.get(arg.type.unionId);
      const opaque = !def || def.arms.some((a) => a.kind === "dyn" || a.kind === "caught" || a.kind === "jsval");
      const arrayTags = L.arrayValueTags(arg.type.unionId);
      const freeRead = arg.kind === "varRef" || arg.kind === "recordGet" || arg.kind === "fieldGet";
      if (!opaque && arrayTags.length === 1) {
        return { kind: "unionIsTag", unionId: arg.type.unionId, tag: arrayTags[0]!, negated: false, value: arg, type: BOOL, loc };
      }
      if (!opaque && freeRead && arrayTags.length === 0) {
        return { kind: "boolLit", value: false, type: BOOL, loc };
      }
      if (!opaque && freeRead && arrayTags.length > 1) {
        return arrayTags
          .map((tag): IrExpr => ({ kind: "unionIsTag", unionId: (arg.type as { unionId: string }).unionId, tag, negated: false, value: arg, type: BOOL, loc }))
          .reduce((left, right) => ({ kind: "logical", op: "||", left, right, type: BOOL, loc }));
      }
      L.unsupported(
        "SC1090",
        argNode,
        `Array.isArray on '${L.fmt(arg.type)}' values (narrow first: check a discriminant field, or compare with '!== undefined'/'!== null' for unit arms)`,
      );
    }
    if (arg.type.kind === "jsval" || arg.type.kind === "caught") return null;
    if (arg.kind === "varRef" || arg.kind === "recordGet" || arg.kind === "fieldGet") {
      return { kind: "boolLit", value: L.isArrayValueType(arg.type), type: BOOL, loc };
    }
    L.unsupported(
      "SC1090",
      call,
      "statically-decided Array.isArray on computed arguments (bind the value to a variable first)",
    );
  }

/** Predicate declarations currently being inlined — re-entrancy guard
 * (a self-recursive guard body would otherwise inline forever). */
const inliningPredicates = new Set<ts.Symbol>();

/** `p(err)` where err is a CATCH BINDING and p a top-level type-guard
 * `(x: unknown) => x is T` whose body is a single `return <expr>;`: lowers
 * <expr> in the caller with the parameter aliased to the caught local.
 * Null when the callee isn't that shape (ordinary paths — and their
 * caught-argument fences — apply). */
  function lowerCaughtPredicateCall(L: Lowerer, call: ts.CallExpression,
    caughtLocal: IrLocal,): IrExpr | null {
    if (call.questionDotToken) return null;
    const callee = call.expression;
    if (!ts.isIdentifier(callee)) return null;
    const symbol = L.resolveValueSymbol(callee);
    const decl = symbol ? L.checker.declarationsOf(symbol).find(ts.isFunctionDeclaration) : undefined;
    if (!symbol || !decl || !decl.body) return null;
    if (!decl.type || !ts.isTypePredicateNode(decl.type)) return null;
    if (decl.parameters.length !== 1) return null;
    const param = decl.parameters[0]!;
    if (!ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken) return null;
    const paramSymbol = L.checker.getSymbolAtLocation(param.name);
    if (!paramSymbol) return null;
    const ret = decl.body.statements.length === 1 ? decl.body.statements[0] : undefined;
    if (!ret || !ts.isReturnStatement(ret) || !ret.expression) {
      L.unsupported(
        "SC1090",
        call,
        `the type-guard '${callee.text}' on a catch binding (only single-'return' guard bodies inline over the caught value)`,
      );
    }
    if (inliningPredicates.has(symbol)) {
      L.unsupported("SC1090", call, `the self-recursive type-guard '${callee.text}' on a catch binding`);
    }
    inliningPredicates.add(symbol);
    L.scopes.push(new Map([[paramSymbol, caughtLocal]]));
    try {
      const result = L.lowerExpr(ret.expression);
      return L.ensureBool(result, ret.expression);
    } finally {
      L.scopes.pop();
      inliningPredicates.delete(symbol);
    }
  }

/** Radix-free `.toString()` on a PRIMITIVE receiver: numbers take the
   * STATIC JS-exact number formatter — the same `toString` node templates
   * and String(n) lower to (Number::toString with radix 10 IS that
   * conversion, per spec) — booleans the "true"/"false" texts, and strings
   * the identity read (String.prototype.toString returns `this`). The
   * explicit-radix number form keeps its island lowering (ISLAND_SURFACE);
   * null for other receivers, argument shapes, or non-lib members (a
   * user's own `.toString` takes the ordinary paths). */
  export function lowerNumberToStringCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(call, access)) return null;
    if (access.name.text !== "toString" || call.arguments.length !== 0) return null;
    const recvKind = L.mapTypeOf(L.typeOf(access.expression))?.kind;
    if (recvKind !== "f64" && recvKind !== "bool" && recvKind !== "string") return null;
    if (!L.isStdlibMember(access)) return null;
    const operand = L.lowerExpr(access.expression);
    if (operand.type.kind === "string") return operand; // identity, receiver evaluated
    if (operand.type.kind !== "f64" && operand.type.kind !== "bool") return null;
    return { kind: "toString", operand, type: STRING, loc: locOf(call) };
  }

/** Radix-free `.toString()` on a UNION receiver whose every arm has one
   * (string identity, JS-exact number/bool texts, and the Buffer arm's
   * utf8 decode — Node's default encoding): the per-union ToString
   * helper dispatches on the tag, so `chunk.toString()` over the ngrok
   * `Buffer | string` listener param needs no narrowing. Unit-armed
   * unions stay out — `(undefined).toString()` THROWS in JS, and
   * claiming it here would silently print "undefined" instead. Null for
   * other receivers/arms (the narrow-first fences stay). */
  export function lowerUnionToStringCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "toString" || call.arguments.length !== 0) return null;
    const recvT = L.mapTypeOf(L.typeOf(access.expression));
    if (recvT?.kind !== "union") return null;
    if (!L.isStdlibMember(access)) return null;
    const def = L.unions.get(recvT.unionId);
    const stringable = def?.arms.every(
      (a) =>
        a.kind === "string" || a.kind === "f64" || a.kind === "bool" ||
        (a.kind === "bytes" && a.elem === "u8"),
    );
    if (!stringable) return null;
    const operand = L.lowerExpr(access.expression);
    if (operand.type.kind !== "union") return null;
    return { kind: "toString", operand, type: STRING, loc: locOf(call) };
  }

/** `x.toString()` resolving to Object.prototype.toString (stdlib
   * provenance, zero arguments) on a RECORD or program-class receiver:
   * the spec's default answer is the constant "[object Object]". Records
   * carry no method storage at all, and a class receiver folds only when
   * neither its chain nor ANY subclass declares toString (dynamic
   * dispatch could reach an override otherwise — and a resolved override
   * is the USER's symbol, which never lands here). Pure receivers elide
   * evaluation; effectful ones evaluate through an interned identity
   * helper so the receiver's effects keep their place. */
  export function lowerDefaultToStringCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "toString" || call.arguments.length !== 0) return null;
    if (!L.isStdlibMember(access)) return null;
    const recvT = L.mapTypeOf(L.typeOf(access.expression));
    if (!recvT) return null;
    if (recvT.kind === "object") {
      const info = L.classes.get(recvT.className);
      // Runtime-provided classes (Error, EventEmitter, streams) have real
      // toString stories of their own — only source-declared classes fold.
      if (!info || !info.decl) return null;
      if (L.findMethodOn(info, "toString") !== null) return null;
      if (L.overrideBelow(info, "toString")) return null;
      if (findGenericMethodOn(L, info, "toString") !== null) return null;
    } else if (recvT.kind !== "record") {
      return null;
    }
    const loc = locOf(call);
    const constant: IrExpr = { kind: "strLit", value: "[object Object]", type: STRING, loc };
    // `(<A>{}).toString()` — assertion-wrapped literals and plain reads
    // have nothing to evaluate; pureObjectToStringReceiver widens
    // pureReceiverNode with the empty object literal.
    if (pureObjectToStringReceiver(access.expression)) return constant;
    const recv = L.lowerExpr(access.expression);
    const key = `objToStr:${typeKey(recv.type)}`;
    let helper = L.widthHelpers.get(key);
    if (!helper) {
      helper = `%obj.tostr.${L.widthHelpers.size}`;
      L.widthHelpers.set(key, helper);
      L.liftedFns.push({
        name: helper,
        params: [{ localId: "o.0", name: "o", type: recv.type }],
        returnType: STRING,
        locals: [{ id: "o.0", name: "o", type: recv.type, mutable: false }],
        body: [{ kind: "return", value: { ...constant }, loc }],
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [recv], type: STRING, loc };
  }

/** pureReceiverNode plus the empty object literal — the default-toString
   * fold's receiver test (an empty literal allocates and nothing more,
   * which the discard cannot observe). */
  function pureObjectToStringReceiver(node: ts.Expression): boolean {
    let e = node;
    while (
      ts.isParenthesizedExpression(e) || ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) || ts.isTypeAssertion(e)
    ) {
      e = e.expression;
    }
    if (ts.isObjectLiteralExpression(e) && e.properties.length === 0) return true;
    return pureReceiverNode(e);
  }

/** `A.hasOwnProperty(lit)` on a PROGRAM CLASS constructor: the own
   * properties of a class object are compile-time-known — its OWN static
   * member names (fields, methods, accessors; inherited statics live on
   * the base, not here) plus the function-object trio prototype/name/
   * length — so a literal key folds to a constant. Builtin classes and
   * non-literal keys keep the fence. */
  function lowerClassHasOwnPropertyCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "hasOwnProperty" || call.arguments.length !== 1) return null;
    if (!ts.isIdentifier(access.expression)) return null;
    const argNode = call.arguments[0]!;
    if (!ts.isStringLiteralLike(argNode)) return null;
    if (!L.isStdlibMember(access)) return null;
    const sym = L.resolveValueSymbol(access.expression);
    const info = sym ? L.classBySymbol.get(sym) : undefined;
    if (!info || !info.decl) return null; // builtin/runtime classes keep the fence
    const key = argNode.text;
    const own = new Set(["prototype", "name", "length"]);
    for (const m of info.decl.members) {
      const isStatic = ts.canHaveModifiers(m) &&
        (ts.getModifiers(m) ?? []).some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic) continue;
      if (
        !ts.isPropertyDeclaration(m) && !ts.isMethodDeclaration(m) &&
        !ts.isGetAccessorDeclaration(m) && !ts.isSetAccessorDeclaration(m)
      ) {
        continue; // static blocks and constructors carry no own name
      }
      if (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name)) own.add(m.name.text);
      else return null; // computed static names — the answer isn't static
    }
    return { kind: "boolLit", value: own.has(key), type: BOOL, loc: locOf(call) };
  }

/** Side-effect-free receiver test for the CONSTANT primitive-prototype
   * answers (hasOwnProperty below): the constant elides the receiver's
   * evaluation, which is only honest when evaluating it could do nothing —
   * identifiers, literals, and parens over those. */
  function pureReceiverNode(node: ts.Expression): boolean {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    }
    return (
      ts.isIdentifier(e) ||
      ts.isStringLiteralLike(e) ||
      ts.isNumericLiteral(e) ||
      e.kind === ts.SyntaxKind.TrueKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword ||
      e.kind === ts.SyntaxKind.ThisKeyword
    );
  }

/** The remaining PRIMITIVE prototype surface with a static story, in both
   * member spellings (`x.hasOwnProperty(...)` and `x['hasOwnProperty'](...)`
   * — JS resolves the two identically, so the element spelling routes here
   * from lowerCall's element-access hook):
   *   - `n.toExponential()` and both `n.toFixed()` forms — the static
   *     runtime formatters (num.toExponential's shortest-mantissa form,
   *     num.toFixed0's ties-up integer fast path, and num.toFixed's exact
   *     binary-value rounding for an explicit fractionDigits).
   *   - `hasOwnProperty(lit)` on number/boolean receivers — the boxes own
   *     NOTHING, so any key answers false (a compile-time constant; the
   *     receiver must be effect-free since the constant elides it).
   *   - `hasOwnProperty(lit)` on string receivers — "length" is true,
   *     a canonical array index answers `index < s.length` (indices ARE
   *     own properties of the box, per spec), every other literal false.
   *   - the element-access spellings of `toString()` (the primitive
   *     lowering above) and `charAt(i)` — the two the element hook needs
   *     beyond this file's own claims.
   * Null elsewhere: non-literal keys, other members, other receivers. */
  export function lowerPrimitiveProtoCall(L: Lowerer, call: ts.CallExpression,
    recv: ts.Expression, name: string, memberSym: ts.Symbol | undefined,): IrExpr | null {
    if (call.questionDotToken) return null;
    if (!L.isStdlibSymbol(memberSym)) return null;
    const recvKind = L.mapTypeOf(L.typeOf(recv))?.kind;
    if (recvKind !== "f64" && recvKind !== "bool" && recvKind !== "string") return null;
    const loc = locOf(call);
    if (name === "toString" && call.arguments.length === 0) {
      const operand = L.lowerExpr(recv);
      if (operand.type.kind === "string") return operand; // identity
      if (operand.type.kind !== "f64" && operand.type.kind !== "bool") return null;
      return { kind: "toString", operand, type: STRING, loc };
    }
    if ((name === "toExponential" || name === "toFixed") && recvKind === "f64" &&
        call.arguments.length === 0) {
      const operand = L.lowerExpr(recv);
      if (operand.type.kind !== "f64") return null;
      const fn = name === "toExponential" ? "num.toExponential" : "num.toFixed0";
      return { kind: "libCall", fn, args: [operand], type: STRING, loc };
    }
    if (name === "toFixed" && recvKind === "f64" && call.arguments.length === 1) {
      const operand = L.lowerExpr(recv);
      let digits = L.lowerExpr(call.arguments[0]!);
      // The optional parameter also admits undefined. Exact unit values
      // become the default 0 after preserving any evaluation effects; an
      // optional number selects 0 at runtime through the same narrowed
      // nullish IR used by `digits ?? 0`.
      const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc: digits.loc };
      const defaultUnitDigits = (value: IrExpr): IrExpr =>
        droppableStatic(value)
          ? zero
          : {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
              result: zero,
              type: F64,
              loc: value.loc,
            };
      if (digits.type.kind === "undefinedT" || digits.type.kind === "void") {
        digits = defaultUnitDigits(digits);
      } else if (digits.type.kind === "union") {
        const def = L.unions.get(digits.type.unionId);
        if (def?.arms.every(isUnitType)) {
          digits = defaultUnitDigits(digits);
        } else if (
          def?.arms.length === 2 &&
          def.arms.some((arm) => arm.kind === "f64") &&
          def.arms.some((arm) => arm.kind === "undefinedT")
        ) {
          digits = { kind: "nullish", left: digits, right: zero, type: F64, loc: digits.loc };
        }
      }
      if (operand.type.kind !== "f64" || digits.type.kind !== "f64") return null;
      return { kind: "libCall", fn: "num.toFixed", args: [operand, digits], type: STRING, loc };
    }
    // Number.prototype.toLocaleString("en-US") — the spec makes it
    // NumberFormat(locale).format(this), so the en-US embedded formatter
    // answers exactly. The unlowered forms fence by NAME: no locale (the
    // host environment's default, which a compiled binary cannot carry),
    // other locales (ICU data the binary does not embed), options bags.
    if (name === "toLocaleString" && recvKind === "f64") {
      if (call.arguments.length === 0) {
        L.noLowering(
          "Number.prototype.toLocaleString without a locale",
          call,
          "the default locale is the host environment's, which a compiled binary cannot carry — " +
            'pass it explicitly: x.toLocaleString("en-US")',
        );
      }
      if (call.arguments.length > 1) {
        L.noLowering(
          "Number.prototype.toLocaleString with an options bag",
          call,
          "the embedded data covers DEFAULT options only (decimal notation, up to 3 fraction " +
            'digits, grouping) — x.toLocaleString("en-US")',
        );
      }
      const locNode = call.arguments[0]!;
      if (ts.isSpreadElement(locNode) || !ts.isStringLiteralLike(locNode) || locNode.text !== "en-US") {
        L.noLowering(
          !ts.isSpreadElement(locNode) && ts.isStringLiteralLike(locNode)
            ? `Number.prototype.toLocaleString at locale "${locNode.text}"`
            : "Number.prototype.toLocaleString with a non-literal locale",
          locNode,
          '"en-US" (Node\'s default-build locale) is the one locale whose data the runtime embeds — ' +
            "everything else is ICU data the binary does not carry",
        );
      }
      const operand = L.lowerExpr(recv);
      if (operand.type.kind !== "f64") return null;
      return { kind: "libCall", fn: "intl.numFormatEnUs", args: [operand], type: STRING, loc };
    }
    if (name === "charAt" && recvKind === "string" && call.arguments.length === 1 &&
        !ts.isSpreadElement(call.arguments[0]!)) {
      const receiver = L.lowerExpr(recv);
      if (receiver.type.kind !== "string") return null;
      const idx = L.lowerExprExpecting(call.arguments[0]!, F64);
      return { kind: "strIntrinsic", method: "charAt", receiver, args: [idx], type: STRING, loc };
    }
    if (name !== "hasOwnProperty" || call.arguments.length !== 1) return null;
    const argNode = call.arguments[0]!;
    if (!ts.isStringLiteralLike(argNode)) return null;
    const key = argNode.text;
    if (recvKind === "string") {
      if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= 2 ** 32 - 2) {
        // A canonical array index: an own property exactly when it is in
        // range — `index < s.length` (UTF-16 units, the box's indices).
        const receiver = L.lowerExpr(recv);
        if (receiver.type.kind !== "string") return null;
        const len: IrExpr = { kind: "strIntrinsic", method: "length", receiver, args: [], type: F64, loc };
        return { kind: "bin", op: "<", left: { kind: "numLit", value: Number(key), type: F64, loc }, right: len, type: BOOL, loc };
      }
      if (!pureReceiverNode(recv)) return null; // the constant elides the receiver
      return { kind: "boolLit", value: key === "length", type: BOOL, loc };
    }
    // Number/Boolean boxes own nothing: false for every key.
    if (!pureReceiverNode(recv)) return null;
    return { kind: "boolLit", value: false, type: BOOL, loc };
  }

/** Reconciles a direct call's recorded type with the checker's answer at
   * the site when the callee is OVERLOADED: tsc resolved the call against
   * one overload SIGNATURE, so every downstream lowering sees that
   * overload's return type — but the value arrives through the
   * implementation's ABI (the only compiled body). Same mapped type: the
   * call stands (overloads differing only in parameters). A union
   * implementation return whose resolved type is one ARM: the CHECKED
   * extraction (narrowedArmHelper — the `x!` machinery), because nothing
   * ever CHECKED the implementation's body against the resolved signature
   * (tsc only checks it against the implementation signature), so a lying
   * implementation throws the catchable TypeError instead of a misread
   * payload. Everything else rides the ordinary coercion path — sub-union
   * re-tags bridge (stranded arms trap, the lying-cast stance), and pairs
   * with no honest bridge keep coerceInto's exactness fences. Calls that
   * resolved to the implementation itself (non-overloaded callees) pass
   * through untouched. */
  function reconcileOverloadReturn(L: Lowerer, expr: ts.CallExpression | ts.TaggedTemplateExpression, call: IrExpr): IrExpr {
    const rsig = L.checker.getResolvedSignature(expr);
    const rdecl = rsig ? L.checker.signatureDeclaration(rsig) : undefined;
    if (!rsig || !rdecl || !(ts.isFunctionDeclaration(rdecl) || ts.isMethodDeclaration(rdecl)) || rdecl.body) {
      return call;
    }
    const rt = L.mapTypeOf(L.checker.getReturnTypeOfSignature(rsig));
    // Unmappable, void, or unit resolved returns keep the implementation's
    // type: a discarded result never looks, a USED one meets its use
    // site's own mapping (and that site's honest fences). Unit narrowing
    // follows maybeNarrow's stance — a unit arm has no payload to extract.
    if (!rt || rt.kind === "void" || isUnitType(rt) || typeEquals(rt, call.type)) return call;
    // An ISLAND-valued implementation return (`any` under --dynamic): the
    // resolved overload's return type is a claim tsc never checked against
    // the body — extracting it HERE would throw the boundary TypeError
    // where Node just lets the value flow (functionOverloads35: the
    // implementation returns its object argument under a number-returning
    // overload signature; Node exits clean). The checker-trust trap keeps
    // governing edges the checker actually vouches for; this edge it never
    // did. The handle stays the value's only story: bindings store it
    // (uncheckedOverloadHandleCall's rule at the declaration sites), and
    // uses dispatch to engine ops like any island value.
    if (call.type.kind === "jsval") return call;
    // The CHECKED-DYNAMIC twin of the island rule: an `any`-returning
    // implementation under a typed overload signature is the same
    // never-vouched-for edge (functionOverloads35's shape without
    // --dynamic) — extracting the resolved type HERE would throw the
    // boundary TypeError where Node lets the value flow. Uses stay
    // checked per read like every any-origin value.
    if (call.type.kind === "dyn") return call;
    if (call.type.kind === "union" && rt.kind !== "union") {
      const helper = L.narrowedArmHelper(call.type.unionId, rt, call.loc);
      if (helper) return { kind: "call", callee: helper, args: [call], type: rt, loc: call.loc };
    }
    return L.coerceInto(expr, call, rt);
  }

/** Escape validity of a TAGGED template span's raw text: an invalid
   * escape is legal syntax in a tagged template (ES2018) but cooks to
   * UNDEFINED — a hole no string[] strings object can carry, so those
   * sites keep a named fence. Valid: \x?? (two hex), \u???? (four hex),
   * \u{...} (≤ 0x10FFFF), \0 not followed by a digit, and every
   * non-digit character escape (identity escapes included). Invalid:
   * malformed hex/unicode forms and the legacy octal / \8 \9 family. */
  function templateEscapesValid(raw: string): boolean {
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== "\\") continue;
      const c = raw[i + 1];
      if (c === undefined) return true; // trailing backslash: unreachable (the parser owns delimiters)
      if (c === "x") {
        if (!/^[0-9a-fA-F]{2}/.test(raw.slice(i + 2))) return false;
        i += 3;
        continue;
      }
      if (c === "u") {
        if (raw[i + 2] === "{") {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(raw.slice(i + 2));
          if (!m || parseInt(m[1]!, 16) > 0x10ffff) return false;
          i += 1 + m[0].length;
          continue;
        }
        if (!/^[0-9a-fA-F]{4}/.test(raw.slice(i + 2))) return false;
        i += 5;
        continue;
      }
      if (c === "0") {
        if (/[0-9]/.test(raw[i + 2] ?? "")) return false;
        i += 1;
        continue;
      }
      if (/[1-9]/.test(c)) return false;
      i += 1; // any other escaped character (identity escapes, \n, line continuations)
    }
    return true;
  }

/** Tagged templates `tag\`a${x}b\`` — ES's call: tag(strings, ...values).
   * The strings object is the per-SITE interned cooked array (the
   * templateStrings node: one immortal string[] per occurrence, so the
   * spec's identity contract holds — the same site evaluated twice hands
   * the tag the SAME array; two sites never share). TemplateStringsArray
   * maps to string[] (types.ts), so the array rides the ordinary
   * slot-directed coercion into whatever the tag's first parameter wants
   * — string[] exactly, an `any` slot through the dyn boundary, a rest
   * pack's first element. `.raw` does not exist on the lowered object:
   * reads fence per member, and String.raw itself lowered above (the raw
   * spans splice directly, no array materializes).
   *
   * Tag forms: a top-level declared function (the direct-call fast path —
   * overload sets reconcile through the resolved signature exactly like
   * plain calls), an island value under --dynamic (engine method/function
   * call: the engine side sees a plain marshaled array — a tag reading
   * `.raw` there answers undefined where Node carries the raw spans), and
   * a checked-dynamic value (the dynCall boundary — a non-function tag
   * throws Node's catchable TypeError). Everything else — generic tags,
   * method tags, function-value bindings — fences by name. */
  export function lowerTaggedTemplate(L: Lowerer, expr: ts.TaggedTemplateExpression): IrExpr {
    const loc = locOf(expr);
    const pieces = ts.isNoSubstitutionTemplateLiteral(expr.template)
      ? [expr.template]
      : [expr.template.head, ...expr.template.templateSpans.map((s) => s.literal)];
    for (const p of pieces) {
      if (!templateEscapesValid(templateRawTextOf(p))) {
        L.unsupported(
          "SC1090",
          p,
          "tagged templates with invalid escape sequences (the span cooks to undefined, which the strings array cannot carry)",
        );
      }
    }
    const strings: IrExpr = {
      kind: "templateStrings",
      key: `${loc.file}:${expr.template.getStart()}`,
      cooked: pieces.map((p) => p.text),
      type: arrayOf(STRING),
      loc,
    };
    const values: readonly ts.Expression[] = ts.isNoSubstitutionTemplateLiteral(expr.template)
      ? []
      : expr.template.templateSpans.map((s) => s.expression);

    // Island tags (--dynamic): the engine call forms, mirroring lowerCall's
    // island paths — a property-access tag is a method call (this = the
    // receiver, JS-exact), any other island tag a function call. The
    // strings argument builds ENGINE-NATIVE with its `.raw` property (the
    // tplStrings op): a JSON marshal would drop `.raw`, and tags dispatch
    // on it (the outdent idiom treats a raw-less argument as its OPTIONS
    // form and answers a function). A fresh array per evaluation — tags
    // caching by strings identity re-compute per call (SEMANTICS.md).
    const islandStrings = (): IrExpr => ({
      kind: "jsOp",
      op: "tplStrings",
      args: [
        ...pieces.map((p): IrExpr => ({ kind: "jsMarshal", value: { kind: "strLit", value: p.text, type: STRING, loc }, type: JSVAL, loc })),
        ...pieces.map((p): IrExpr => ({ kind: "jsMarshal", value: { kind: "strLit", value: templateRawTextOf(p), type: STRING, loc }, type: JSVAL, loc })),
      ],
      type: JSVAL,
      loc,
    });
    if (ts.isPropertyAccessExpression(expr.tag) && L.isIslandExpr(expr.tag.expression)) {
      const receiver = L.lowerExpr(expr.tag.expression);
      const args = [
        islandStrings(),
        ...values.map((a) => L.jsvalIn(L.lowerExpr(a), a)),
      ];
      return {
        kind: "jsOp", op: "callMethod", name: expr.tag.name.text,
        args: [receiver, ...args], type: JSVAL, loc,
      };
    }
    if (L.isIslandExpr(expr.tag)) {
      const callee = L.lowerExpr(expr.tag);
      const args = [
        islandStrings(),
        ...values.map((a) => L.jsvalIn(L.lowerExpr(a), a)),
      ];
      return { kind: "jsOp", op: "callFn", args: [callee, ...args], type: JSVAL, loc };
    }

    // Direct call of a top-level declared function — the plain-call fast
    // path with the strings array as the leading completed argument.
    if (ts.isIdentifier(expr.tag) && !L.isSelfReference(expr.tag)) {
      if (L.isTopLevelFnSymbol(expr.tag) && !L.peekLocal(expr.tag)) {
        fenceEarlyAliasUse(L, expr.tag, expr);
        if (L.genericFnOf(expr.tag)) {
          L.unsupported("SC1090", expr, "tagged templates with generic tag functions");
        }
        const sig = L.fnSigOf(expr.tag);
        if (sig) {
          L.noteEdge(sig.name);
          const args = completeArgs(L, values, sig.params, loc, expr, [strings]);
          return reconcileOverloadReturn(L, expr, { kind: "call", callee: sig.name, args, type: sig.returnType, loc });
        }
        // An ambient `declare function` nothing defines: Node throws
        // ReferenceError reading the tag before the template object is
        // built — the plain-call stance (nsUndefRead) reproduces it. An
        // `any`-typed result takes the DYN dummy rather than F64 so
        // downstream any-shaped consumers (`tag\`...\` as string`) keep
        // compiling — the read always throws first, the dummy is never
        // observed either way.
        if (ambientUndefinedFnSymbolOf(L, expr.tag)) {
          const mapped = L.mapTypeOf(L.typeOf(expr));
          const t =
            mapped && mapped.kind !== "void" && !L.typeNamesUnregisteredClass(mapped)
              ? mapped
              : (L.typeOf(expr).flags & ts.TypeFlags.Any) !== 0
                ? DYN
                : F64;
          return nsUndefRead(L, expr.tag.text, expr, t);
        }
      }
    }

    // Checked-dynamic tags (`var f: any; f\`abc\``, dyn property chains):
    // the dynCall boundary — arguments convert into dyn, a non-function
    // tag throws Node's catchable "<name> is not a function" TypeError.
    const callee = L.lowerExpr(expr.tag);
    if (callee.type.kind === "dyn") {
      const args = [
        L.coerceInto(expr.template, strings, DYN),
        ...values.map((a) => L.lowerExprExpecting(a, DYN)),
      ];
      const calleeName = ts.isPropertyAccessExpression(expr.tag) || ts.isElementAccessExpression(expr.tag)
        ? expr.tag.getText()
        : ts.isIdentifier(expr.tag)
          ? expr.tag.text
          : "value";
      return { kind: "dynCall", callee, calleeName, args, type: DYN, loc };
    }
    L.unsupported(
      "SC1090",
      expr,
      "tagged templates with this tag form (top-level functions and dynamic values tag; call the function directly otherwise)",
    );
  }

/** True when the identifier resolves (through import aliases) to a
   * top-level function declaration of ANY program file (not merely a
   * same-named local shadowing one). Functions declared directly in a
   * FLATTENED namespace block count — splitFiles hoisted them into the
   * same collection lists top-level declarations ride. */
  export function isTopLevelFnSymbol(L: Lowerer, ident: ts.Identifier): boolean {
    const symbol = L.resolveValueSymbol(ident);
    const decl = symbol ? L.checker.declarationsOf(symbol)[0] : undefined;
    return (
      !!decl &&
      ts.isFunctionDeclaration(decl) &&
      (ts.isSourceFile(decl.parent) || L.nsBlocks.get(decl.parent) === "flattened")
    );
  }

/** Nested `function name(...) {...}`: lowered as `const name = <lambda>`
   * at the declaration's statement position (JS hoists function declarations
   * to the top of the enclosing function — calling one before this statement
   * is a compile error here, not a silent divergence). Self-references inside
   * the body lower to `selfRef`, not a capture: a box holding its own
   * closure would be an RC cycle. */
  export function lowerNestedFunctionDecl(L: Lowerer, stmt: ts.FunctionDeclaration): IrStmt {
    if (!stmt.name) L.unsupported("SC1090", stmt, "anonymous function declarations");
    const { funcType } = L.lambdaSignature(stmt);
    const local = L.declareLocal(stmt.name, stmt.name.text, funcType, false);
    const init = L.lowerLambda(stmt);
    return { kind: "varDecl", localId: local.id, init, loc: locOf(stmt) };
  }

/** Signature checks + param shapes + IR func type for any lambda-like
   * node. The func type's params are the ABI types, so a lambda with
   * optional/default params has the same IR type as one spelling the
   * `T | undefined` unions with required params — exactly the exact-arity
   * value rule (requireExactArityValue decides who may become a value). */
  export function lambdaSignature(L: Lowerer, node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,): { shapes: ParamShape[]; funcType: IrType & { kind: "func" } } {
    if (!node.body) L.unsupported("SC1090", node, "function overload signatures");
    if (
      node.asteriskToken &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      L.unsupported("SC1071", node, "async generators (async function*)");
    }
    if (node.typeParameters) {
      // Generic function-like forms monomorphize only where a static home
      // exists: top-level generic function declarations, generic methods
      // (class and object-literal), and module-scope never-reassigned
      // bindings initialized with a generic arrow/function expression —
      // all collected before this path. Everything else lambda-shaped
      // (arguments, IIFEs, default exports, nested declarations) has no
      // per-instantiation story and stays out.
      L.unsupported(
        "SC1090",
        node,
        ts.isMethodDeclaration(node)
          ? "generic methods"
          : ts.isFunctionDeclaration(node)
            ? "generic nested functions (only top-level generic function declarations are supported)"
            : "generic arrow/function expressions outside a never-reassigned module-scope binding (only `const f = <T>(x: T) => ...` bindings and top-level generic function declarations monomorphize)",
      );
    }
    const shapes = L.paramShapes(node.parameters);
    // A concise arrow over an h2-only stream/session call (`() =>
    // req.stream.destroy()`): the call ALWAYS throws on this lowering
    // (stream is undefined — the streamUndefCall precedent), so the body
    // is throw-only and the declared return type (ServerHttp2Stream,
    // unmappable) must not decide the ABI — void, the `never` stance.
    let ret =
      ts.isArrowFunction(node) && !ts.isBlock(node.body) && isStreamUndefCallExpr(L, node.body)
        ? VOID
        : L.declaredReturnType(node, node);
    // A contextually-typed arrow/function EXPRESSION whose slot signature
    // returns a UNION the inferred return doesn't spell adopts the slot's
    // return as its ABI: `(n) => work()` (inferring Promise<void>) against
    // an `(n) => Promise<void> | void` field must RETURN that union — the
    // body's returns coerce into it per return site (arm values wrap;
    // width-coercible records rebuild into their arm — the runJobs
    // `{ data, id }` literal against `Buffer | string | GeneratedOutput`),
    // a void body's implicit completion becomes the undefined arm, and the
    // closure VALUE matches the slot exactly (no runtime re-tag exists for
    // func returns). tsc vetted the assignability — a return the coercion
    // path can't carry fences per site with its own actionable message.
    // ASYNC lambdas adopt through the promise: an inferred Promise<record>
    // against a Promise<union> slot returns the union promise (the fiber's
    // returns coerce; the spawn-wrapper ABI still returns a promise).
    // jsval-returning bodies stay out (adoption would force validated
    // exits the writer never asked for).
    const isAsyncLike =
      !ts.isMethodDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
    const innerRet = isAsyncLike && ret.kind === "promise" ? ret.inner : ret;
    // Union-inferred returns adopt too (a mixed-return body inferring a
    // SUB-union of the slot's union — adopting is a no-op when the two
    // already agree); only jsval stays out.
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (!isAsyncLike || ret.kind === "promise") &&
      innerRet.kind !== "jsval"
    ) {
      // The slot's signature: the contextual type stripped of its nullish
      // parts (an OPTIONAL callback field's context is the whole
      // `(...) | undefined` union) with exactly one call signature — and
      // declared in USER code: stdlib callback slots (flatMap's
      // `U | readonly U[]`, sort comparators) have intrinsic lowerings
      // that inspect the INFERRED type, so they must not widen.
      const ctxType = L.checker.getContextualType(node);
      const ctxSigs = ctxType
        ? L.checker.getCallSignatures(L.checker.getNonNullableType(ctxType))
        : [];
      const ctxDecl = ctxSigs.length === 1 ? L.checker.signatureDeclaration(ctxSigs[0]!) : undefined;
      const ctxRetRaw =
        ctxDecl && !ctxDecl.getSourceFile().isDeclarationFile
          ? L.mapTypeOf(L.checker.getReturnTypeOfSignature(ctxSigs[0]!))
          : null;
      const ctxRet =
        isAsyncLike && ctxRetRaw?.kind === "promise" ? ctxRetRaw.inner : ctxRetRaw;
      if (
        ctxRet?.kind === "union" &&
        (innerRet.kind === "void" ? L.armTag(ctxRet.unionId, UNDEFINED_T) >= 0 : true)
      ) {
        ret = isAsyncLike ? { kind: "promise", inner: ctxRet } : ctxRet;
      }
      // A VOID slot discards the callback's result (TS's void-returning
      // assignability rule; JS ignores the value), so an UNANNOTATED
      // sync lambda adopts void regardless of what its body infers —
      // `() => socket.destroy()` infers Socket (destroy returns `this`
      // for chaining) but the error-listener slot never looks. Stdlib
      // slots included: no intrinsic lowering inspects an inferred
      // return where its own declared slot is void. Async lambdas stay
      // out (the spawn-wrapper ABI must still return a promise), and an
      // explicit return annotation keeps its word.
      if (
        !isAsyncLike &&
        !node.type &&
        ret.kind !== "void" &&
        ctxSigs.length === 1 &&
        !!(L.checker.getReturnTypeOfSignature(ctxSigs[0]!).flags & ts.TypeFlags.Void)
      ) {
        ret = VOID;
      }
    }
    // VARIADIC JS functions: a dynRest param (above), or a plain function
    // whose body reads `arguments` (test/common's mustCall wrapper —
    // `function() { ...; return fn.apply(this, arguments); }`). Both mark
    // the func type `rest`: the lifted body takes one trailing dyn-array
    // param, filled by the boxed call thunk with the call's arguments
    // from index params.length on. `arguments` is only claimed in
    // ZERO-param functions (there it IS the surplus array); alongside
    // declared params the alias story has no model — the fence says to
    // use a rest parameter. Arrows never claim it (JS: an arrow's
    // `arguments` is the enclosing function's).
    const hasDynRest = shapes.some((s) => s.mode === "dynRest");
    const hasIslandRest = shapes.some((s) => s.mode === "islandRest");
    const usesArguments =
      !hasDynRest &&
      !ts.isArrowFunction(node) &&
      isJsSourceFile(node.getSourceFile()) &&
      bodyReadsArguments(node);
    if (usesArguments && node.parameters.length > 0) {
      L.unsupported(
        "SC1090",
        node,
        "'arguments' in functions with declared parameters (use a rest parameter: (...args))",
      );
    }
    return {
      shapes,
      funcType: {
        kind: "func",
        // dynRest is EXCLUDED (the boxed thunk fills the trailing dyn
        // array — no spelled slot); islandRest is INCLUDED (the trailing
        // jsval param IS the engine arguments array, the REST host-call
        // adapter's one uniform shape).
        params: shapes.filter((s) => s.mode !== "dynRest").map((s) => s.type),
        ret,
        ...(hasDynRest || usesArguments || hasIslandRest ? { rest: true as const } : {}),
        ...(hasIslandRest ? { restAbi: "jsval" as const } : {}),
      },
    };
  }

/** Does this function's OWN body read `arguments`? Nested plain functions
   * and methods have their own `arguments` (the walk skips them); arrows
   * see the enclosing one (the walk descends). Exported for the lowerer's
   * dynFallbackType: tsgo does not synthesize the `arguments` rest
   * parameter into inferred signatures (5.9.3 did — its param-count
   * mismatch was the detector), so the 7 world asks the BODY directly. */
  export function bodyReadsArguments(fn: { body?: ts.Node | undefined }): boolean {
    let found = false;
    if (fn.body === undefined) return false;
    // Iterative walk (walkPreorder): function bodies can hold pathologically
    // deep expression chains that a recursive visit would die on.
    ts.walkPreorder(fn.body, (n) => {
      if (ts.isIdentifier(n) && n.text === "arguments" && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        found = true;
        return "stop";
      }
      if (
        (ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
        n !== fn
      ) {
        return "skip"; // own `arguments` scope
      }
      return undefined;
    });
    return found;
  }

/** Lifts an arrow function / function expression / nested declaration /
   * object-literal shorthand method to a module-level function and yields
   * the `closure` expression creating it. */
  export function lowerLambda(L: Lowerer, node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,): IrExpr {
    const loc = locOf(node);
    const { shapes, funcType } = L.lambdaSignature(node);
    // A lambda IS a value: the exact-arity rule applies at birth. The
    // contextual (target) type decides — `(x?: number) => void` may flow
    // into a slot annotated `(x: number | undefined) => void` (same ABI
    // signature), anything else is fenced. Nested function declarations and
    // object-literal shorthand methods aren't expressions — always fenced.
    L.requireExactArityValue(
      node,
      ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node : null,
      shapes,
      funcType,
    );
    const nameIdent =
      !ts.isArrowFunction(node) && node.name && ts.isIdentifier(node.name) ? node.name : null;
    const baseName = nameIdent ? nameIdent.text : "";
    const fnName = `%fn${L.lambdaCounter++}${baseName ? `_${baseName}` : ""}`;
    // Named function expressions/declarations can self-reference by name; an
    // object-literal method's name is a PROPERTY, not a binding — no self.
    const selfSymbol =
      nameIdent && !ts.isMethodDeclaration(node) && !ts.isAccessor(node)
        ? (L.checker.getSymbolAtLocation(nameIdent) ?? null)
        : null;

    // Async lambdas — object-literal async METHODS included (a method in
    // an object literal is a function value in a record field; no vtable
    // exists to dispatch through): the VALUE's type returns Promise<T>,
    // the lifted body returns the inner T (a `return v` fulfills with v).
    const isAsync =
      !ts.isAccessor(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
    if (isAsync && funcType.ret.kind !== "promise") L.badType(node, L.typeOf(node));
    // Generator lambdas (function* expressions and object-literal
    // *methods): the VALUE's type returns the generator; the lifted body
    // returns the TReturn channel (a `return v` is the done-value).
    const isGenerator = node.asteriskToken !== undefined;
    if (isGenerator && funcType.ret.kind !== "generator") L.badType(node, L.typeOf(node));
    const bodyReturn = isGenerator
      ? L.genBodyReturnType(funcType.ret)
      : L.bodyReturnType(isAsync, funcType.ret);

    const fnCtx = newFnCtx(true, selfSymbol, funcType, bodyReturn);
    fnCtx.isAsync = isAsync;
    if (isGenerator && funcType.ret.kind === "generator") {
      fnCtx.generator = { yieldT: funcType.ret.yieldT, nextT: funcType.ret.nextT };
    }
    const diagsBefore = L.diags.length;
    L.fnStack.push(fnCtx);
    try {
      const { params, prologue } = L.declareParams(node.parameters, shapes);
      // The VARIADIC `arguments` form (rest-marked with no declared rest
      // param): a synthetic trailing dyn-array param carries the call's
      // arguments; `arguments` reads resolve to it (identifier lowering).
      if (funcType.rest && !shapes.some((s) => s.mode === "dynRest" || s.mode === "islandRest")) {
        const argsLocal = L.declareHiddenLocal("%arguments", DYN);
        params.push({ localId: argsLocal.id, name: "%arguments", type: DYN });
        fnCtx.argumentsLocal = argsLocal;
      }

      let body: IrStmt[];
      if (ts.isBlock(node.body!)) {
        body = L.lowerStmts(node.body!.statements);
      } else {
        // Bare-expression arrow body: `x => e` is `x => { return e; }`
        // (or an expression statement when the signature returns void — or
        // when a union-returning signature wraps a void expression, whose
        // value is the implicit undefined arm appended below).
        const bodyExpr = node.body as ts.Expression;
        if (bodyReturn.kind === "void") {
          // `() => undefined` — the return type maps to void (standalone
          // undefined IS void in the type mapping) and the body value is a
          // bare unit literal: a pure no-op, dropped rather than tripping
          // the validator's bare-unitLit rule (typeCheckReturnExpression).
          // A `void e` body rides the statement lowering (the value is
          // discarded here, so the operand evaluates for effect alone —
          // `(name) => void doThing(name)`, the fire-and-forget arrow).
          let stripped: ts.Expression = bodyExpr;
          while (ts.isParenthesizedExpression(stripped)) stripped = stripped.expression;
          if (ts.isVoidExpression(stripped)) {
            body = [L.lowerExprStatement(stripped)];
          } else {
            const value = L.lowerExpr(bodyExpr);
            body = value.kind === "unitLit" ? [] : [{ kind: "exprStmt", expr: value, loc: locOf(node.body!) }];
          }
        } else {
          let value = L.lowerExpr(bodyExpr);
          // An async concise body whose value is itself a promise
          // (`async () => p`): the async machinery RESOLVES the returned
          // thenable into the function's own promise — lowerReturnValue's
          // await-through, applied to the implicit return.
          if (isAsync && value.type.kind === "promise" && bodyReturn.kind !== "promise") {
            value = { kind: "awaitExpr", value, type: value.type.inner, loc: value.loc };
          }
          body =
            value.type.kind === "void" && L.wrappedUndefined(bodyReturn, locOf(node.body!))
              ? [{ kind: "exprStmt", expr: value, loc: locOf(node.body!) }]
              : [
                  {
                    kind: "return",
                    value: L.coerceInto(bodyExpr, value, bodyReturn),
                    loc: locOf(node.body!),
                  },
                ];
        }
      }
      body = [...prologue, ...body];
      // Bare-expression bodies never pass through lowerStmts, so the
      // lib-boundary chokepoint runs here (idempotent for block bodies,
      // whose statements were already walked). A fence poisons the
      // enclosing statement — the lambda IS part of it.
      enforceLibBoundary(L, body);
      appendImplicitUndefinedReturn(L, body, bodyReturn, loc);

      const ctx = L.ctx;
      const lifted: IrFunction = {
        name: fnName,
        params,
        returnType: bodyReturn,
        locals: ctx.locals,
        captures: ctx.captures!,
        body,
        loc,
      };
      if (isAsync) lifted.async = true;
      if (fnCtx.generator) lifted.generator = fnCtx.generator;
      L.liftedFns.push(lifted);
      return { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
    } catch (e) {
      // JS sources defer LAMBDA poisons like function declarations
      // (lowerFunction's catch, lambda form — entry the function-level
      // deferral): a fenced concise body (`(list) => new Intl.ListFormat
      // (...).format(list)` — the error-message list-join idiom) would
      // otherwise poison the ENCLOSING statement, stopping module init
      // where Node only stops when the lambda is CALLED. The value
      // compiles as a capture-free closure over a runtimeFence body —
      // calling throws the first captured diagnostic at its source
      // position. ICEs (SC9001) stay compile errors, exactly like
      // lowerStmts; probe mode (diagSink) keeps the poison.
      if (!(e instanceof PoisonError)) throw e;
      if (
        !isJsSourceFile(node.getSourceFile()) ||
        L.diagSink !== null ||
        L.diags.length <= diagsBefore ||
        L.diags.slice(diagsBefore).some((d) => d.code === "SC9001")
      ) {
        throw e;
      }
      const captured = L.diags.splice(diagsBefore);
      L.runtimeFences.push(...captured);
      const first = captured[0]!;
      const pos = ts.getLineAndCharacterOfPosition(
        L.program.getSourceFile(first.loc.file) ?? node.getSourceFile(),
        first.loc.start,
      );
      const params: IrParam[] = funcType.params.map((t, i) => ({ localId: `%pf${i}`, name: `%pf${i}`, type: t }));
      // A REST-MARKED value type hides one synthetic trailing dyn-array
      // param in the lifted function (the boxed call thunk fills it) —
      // the fence lambda must spell that slot too or the validator's
      // closure-signature check trips (SC9001). Island rest types SPELL
      // their trailing engine-array param, so funcType.params already
      // covers those.
      if (funcType.rest === true && funcType.restAbi !== "jsval") {
        params.push({ localId: "%pfrest", name: "%pfrest", type: DYN });
      }
      const lifted: IrFunction = {
        name: fnName,
        params,
        returnType: bodyReturn,
        locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        captures: [],
        body: [
          {
            kind: "runtimeFence",
            code: first.code,
            message: `${first.message} [${first.code} at ${first.loc.file}:${pos.line + 1}]`,
            loc,
          },
        ],
        loc,
      };
      if (isAsync) lifted.async = true;
      if (fnCtx.generator) lifted.generator = fnCtx.generator;
      L.liftedFns.push(lifted);
      return { kind: "closure", fnName, captures: [], type: funcType, loc };
    } finally {
      L.fnStack.pop();
    }
  }

/** `p.then(f)` / `p.catch(handler)` / `p.finally(cb)` — fiber-level
   * DESUGARS. Each synthesizes a small async wrapper (lifted like a
   * lambda) and calls it with the receiver, so promise machinery,
   * microtask ordering, and rejection bookkeeping all ride the existing
   * await path:
   *
   *   p.then(f)    ≡ (async (pp, f) => { return f(await pp); })(p, f)
   *   p.catch(h)   ≡ (async (pp) => { try { return await pp; } catch (e) { <h's body> } })(p)
   *   p.finally(f) ≡ (async (pp, f) => { try { const v = await pp; f(); return v; } catch (e) { f(); throw e; } })(p, f)
   *
   * Node-exact by construction: the wrapper's await parks on pending
   * receivers and takes the settled-await microtask hop otherwise; the
   * catch handler's parameter binds the rejection reason as a CAUGHT
   * local — the typed-catch machinery (instanceof/typeof narrowing,
   * rethrow) IS the handler's surface; a handler throw rejects the
   * result; a handler falling off its end resolves with undefined
   * (checker-typed — the result union carries the arm); an unawaited
   * rejected result enters the unhandled-rejection ledger. The catch
   * HANDLER must be an inline arrow/function expression: its parameter
   * becomes the catch binding, and a handler VALUE would need a
   * caught-typed closure parameter, which cannot exist. finally takes
   * any () => void closure (its callback sees no arguments). then takes
   * exactly one FULFILLMENT handler (any closure value of the settled
   * value's type — the two-argument onRejected form stays fenced toward
   * .catch); a promise-returning handler flattens through the async
   * return path, a receiver rejection passes through untouched (the
   * wrapper's await re-throws it), and a handler throw rejects the
   * result — the spec's onFulfilled rules by construction. Null for
   * non-promise receivers and other members. */
  /** The storage type behind a promise-valued expression whose CHECKER type
   * has no mapping — the dynamic-import receiver rule (--dynamic): a direct
   * `import("...")` call is the island promise itself; an identifier bound
   * to a promise-of-jsval local or module global answers the binding's
   * type. Null everywhere else. */
  function islandPromiseStorageTypeOf(L: Lowerer, e: ts.Expression): IrType | null {
    const direct = importCallHandleType(e);
    if (direct?.kind === "promise") return direct;
    if (!ts.isIdentifier(e)) return null;
    const local = L.resolveLocal(e);
    if (local?.type.kind === "promise" && local.type.inner.kind === "jsval") return local.type;
    if (local) return null;
    let sym = L.checker.getSymbolAtLocation(e);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
    const g = sym ? L.globalsBySymbol.get(sym) : undefined;
    if (g?.type.kind === "promise" && g.type.inner.kind === "jsval") return g.type;
    return null;
  }

/** Marks an INLINE then-handler's unannotated identifier parameters for
   * the island-handle (jsval) binding type — paramShape's early-out. Only
   * the inline arrow/function forms qualify: a handler VALUE keeps its own
   * declared signature (and the settled-type equality check below). */
  function markJsvalHandlerParams(L: Lowerer, handler: ts.Expression): void {
    let e = handler;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) return;
    for (const p of e.parameters) {
      if (ts.isIdentifier(p.name) && p.type === undefined && !p.dotDotDotToken && !p.initializer) {
        L.jsvalParamOverrides.add(p);
      }
    }
  }

export function lowerPromiseMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    const member = access.name.text;
    if (member !== "then" && member !== "catch" && member !== "finally") return null;
    let recvT = L.mapTypeOf(L.typeOf(access.expression));
    // A dynamic-import promise under an unmappable checker type
    // (`Promise<typeof import("./m")>` — module-namespace types have no
    // static mapping): the BINDING holds the island promise
    // (importCallHandleType / the island-HANDLE var rules), so the storage
    // type is the receiver's truth. Direct `import("./m").then(...)`
    // spells the same promise with no binding at all.
    if (!recvT && L.dynamic) recvT = islandPromiseStorageTypeOf(L, access.expression);
    if (recvT?.kind !== "promise") return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    // Handler-less spellings — `p.then()`, `p.catch()`, `p.finally()`,
    // and the explicit `undefined`/`null` handler: the spec substitutes
    // identity/thrower/no-op, so each is the PASSTHROUGH promise — a
    // fresh promise settling exactly as the receiver does (never the
    // receiver itself: `p.catch() !== p` in JS). Detected here; built
    // after the receiver lowers below.
    const isAbsentHandler = (a: ts.Expression | undefined): boolean => {
      if (a === undefined) return true;
      let e = a;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      return e.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(e) && e.text === "undefined" &&
          (L.typeOf(e).flags & ts.TypeFlags.Undefined) !== 0);
    };
    const passthrough =
      call.arguments.length === 0 ||
      (call.arguments.length === 1 && isAbsentHandler(call.arguments[0]));
    if (call.arguments.length !== 1 && !passthrough) {
      L.noLowering(
        `${member} with ${call.arguments.length} arguments`,
        call,
        member === "then"
          ? "the supported form takes exactly one fulfillment handler — chain .catch(...) for the rejection half"
          : `the supported form takes exactly one ${member === "catch" ? "inline handler" : "callback"}`,
      );
    }
    // The receiver evaluates FIRST, in the enclosing function, like JS.
    let receiver = L.lowerExpr(access.expression);
    // A PACKAGE-returned promise lowers as an island value (jsval): the
    // promise lives in the engine, so bridge it — a static promise the
    // engine promise settles (fulfillment = the retained handle or void,
    // rejection = the bridged reason) — and desugar over the BRIDGE
    // exactly like a native receiver. This is the classic CLI entry line,
    // `program.parseAsync(process.argv).catch(handler)`.
    if (receiver.type.kind === "jsval") {
      receiver = {
        kind: "jsBridgePromise",
        value: receiver,
        type: { kind: "promise", inner: recvT.inner.kind === "void" ? VOID : JSVAL },
        loc,
      };
    }
    if (receiver.type.kind !== "promise") {
      // mapTypeOf said promise but the value lowered as something else —
      // a lowering gap, named rather than ICEd on.
      L.unsupported("SC1090", call, `'.${member}' on this receiver`);
    }
    // The wrapper types follow the RECEIVER's promise type (the bridge's
    // promise-of-jsval for package receivers, the mapped type otherwise);
    // typed uses of the settled value exit through coerceInto below.
    const promT = receiver.type;
    const inner = promT.inner;

    if (passthrough) {
      // The absent-handler forms: a lifted `async (p) => await p` — the
      // fresh promise adopts p's settlement exactly (fulfillment value
      // through the await, rejection through the await's rethrow), which
      // IS the spec's identity/thrower/no-op substitution for all three
      // members. An argument expression, when present, is undefined/null
      // by construction — nothing to evaluate.
      const fnName = `%fn${L.lambdaCounter++}_${member}pass`;
      const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT], ret: promT };
      const fnCtx = newFnCtx(true, null, funcType, inner);
      fnCtx.isAsync = true;
      L.fnStack.push(fnCtx);
      try {
        const pLocal = L.declareHiddenLocal("p", promT);
        const awaitE: IrExpr = {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
          type: inner,
          loc,
        };
        const body: IrStmt[] =
          inner.kind === "void"
            ? [{ kind: "exprStmt", expr: awaitE, loc }, { kind: "return", value: null, loc }]
            : [{ kind: "return", value: awaitE, loc }];
        const ctx = L.ctx;
        const lifted: IrFunction = {
          name: fnName,
          params: [{ localId: pLocal.id, name: pLocal.name, type: promT }],
          returnType: inner,
          locals: ctx.locals,
          captures: ctx.captures!,
          body,
          loc,
          async: true,
        };
        L.liftedFns.push(lifted);
        const closure: IrExpr = { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
        return { kind: "callValue", callee: closure, args: [receiver], type: promT, loc };
      } finally {
        L.fnStack.pop();
      }
    }

    if (member === "then") {
      // The settled value is an island HANDLE: an inline handler's
      // unannotated parameter binds it as jsval, whatever the checker's
      // contextual type spelled (a module-namespace type has no mapping —
      // the handle is the value's only story, isIslandExpr's local rule).
      if (inner.kind === "jsval") markJsvalHandlerParams(L, call.arguments[0]!);
      let cb = L.lowerExpr(call.arguments[0]!);
      // A TYPED handler on a DYN-settling promise (the tracePromise
      // result's `.then((value) => ...)` — the checker's generic
      // instantiation typed the parameter, but the settled value is a
      // dyn value): box the handler and ride the dyn-handler desugar
      // below — its call thunk validates the settled value into the
      // declared parameter type (the per-arg dynCheck), Node's own
      // runtime contract for a value that came off the wire untyped.
      if (
        inner.kind === "dyn" &&
        cb.type.kind === "func" &&
        cb.type.params.some((p) => p.kind !== "dyn") &&
        canBoxFuncIntoDyn(cb.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
      ) {
        cb = { kind: "dynFrom", value: cb, type: DYN, loc };
      }
      // A CHECKED-DYNAMIC handler VALUE (`p.then(common.mustCall())` — the
      // Node-suite wrapper is an untyped rest-args function): the same
      // async desugar with the handler called through the checked-dynamic tree — the
      // settled value boxes (dyn passes through; void arrives as JS's
      // explicit undefined argument), the result promise settles with the
      // handler's dyn result. A receiver rejection passes through the
      // await like the typed path; the dyn call's own argument checking
      // throws Node's TypeError for non-callables.
      if (cb.type.kind === "dyn") {
        const settledToDyn = (v: IrExpr): IrExpr => {
          if (v.type.kind === "dyn") return v;
          if (canConvertToDyn(v.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
            return { kind: "dynFrom", value: v, type: DYN, loc };
          }
          L.unsupported(
            "SC1090",
            call.arguments[0]!,
            `then handlers receiving '${L.fmt(v.type)}' values through an untyped handler (the settled value cannot cross the checked-dynamic tree boundary)`,
          );
        };
        const resultT: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
        const fnName = `%fn${L.lambdaCounter++}_then`;
        const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT, DYN], ret: resultT };
        const fnCtx = newFnCtx(true, null, funcType, DYN);
        fnCtx.isAsync = true;
        L.fnStack.push(fnCtx);
        try {
          const pLocal = L.declareHiddenLocal("p", promT);
          const cbLocal = L.declareHiddenLocal("cb", DYN);
          const awaitE: IrExpr = {
            kind: "awaitExpr",
            value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
            type: inner,
            loc,
          };
          const body: IrStmt[] = [];
          let handlerArgs: IrExpr[];
          if (inner.kind === "void") {
            body.push({ kind: "exprStmt", expr: awaitE, loc });
            handlerArgs = [dynUndefinedExpr(loc)];
          } else {
            const vLocal = L.declareHiddenLocal("v", inner);
            body.push({ kind: "varDecl", localId: vLocal.id, init: awaitE, loc });
            handlerArgs = [settledToDyn({ kind: "varRef", localId: vLocal.id, type: inner, loc })];
          }
          body.push({
            kind: "return",
            value: {
              kind: "dynCall",
              callee: { kind: "varRef", localId: cbLocal.id, type: DYN, loc },
              calleeName: jsFuncNameOf(call.arguments[0]!) ?? "onFulfilled",
              args: handlerArgs,
              type: DYN,
              loc,
            },
            loc,
          });
          const ctx = L.ctx;
          const lifted: IrFunction = {
            name: fnName,
            params: [
              { localId: pLocal.id, name: pLocal.name, type: promT },
              { localId: cbLocal.id, name: cbLocal.name, type: DYN },
            ],
            returnType: DYN,
            locals: ctx.locals,
            captures: ctx.captures!,
            body,
            loc,
            async: true,
          };
          L.liftedFns.push(lifted);
          const closure: IrExpr = { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
          return { kind: "callValue", callee: closure, args: [receiver, cb], type: resultT, loc };
        } finally {
          L.fnStack.pop();
        }
      }
      if (cb.type.kind !== "func" || cb.type.params.length > 1) {
        L.unsupported(
          "SC1090",
          call.arguments[0]!,
          "then handlers with more than one parameter (the two-argument onRejected form has no lowering — chain .catch(...) instead)",
        );
      }
      const param = cb.type.params[0];
      if (param !== undefined && !typeEquals(param, inner)) {
        L.unsupported(
          "SC1090",
          call.arguments[0]!,
          `then handlers whose parameter is not the settled value's type (expected '${L.fmt(inner)}', got '${L.fmt(param)}')`,
        );
      }
      const resultT = L.mapTypeOf(L.typeOf(call));
      if (resultT?.kind !== "promise") {
        L.noLowering(
          "then with this handler's result type",
          call,
          "the combined result must be a representable promise",
        );
      }
      const R = resultT.inner;
      const fnName = `%fn${L.lambdaCounter++}_then`;
      const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT, cb.type], ret: resultT };
      const fnCtx = newFnCtx(true, null, funcType, R);
      fnCtx.isAsync = true;
      L.fnStack.push(fnCtx);
      try {
        const pLocal = L.declareHiddenLocal("p", promT);
        const cbLocal = L.declareHiddenLocal("cb", cb.type);
        const awaitE: IrExpr = {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
          type: inner,
          loc,
        };
        const body: IrStmt[] = [];
        // The settled value: awaited into a local when the handler wants
        // it (a zero-param handler still awaits — the receiver must settle
        // before the handler runs, and a rejection must pass through).
        let handlerArgs: IrExpr[] = [];
        if (param !== undefined && inner.kind !== "void") {
          const vLocal = L.declareHiddenLocal("v", inner);
          body.push({ kind: "varDecl", localId: vLocal.id, init: awaitE, loc });
          handlerArgs = [{ kind: "varRef", localId: vLocal.id, type: inner, loc }];
        } else {
          body.push({ kind: "exprStmt", expr: awaitE, loc });
        }
        const handlerCall: IrExpr = {
          kind: "callValue",
          callee: { kind: "varRef", localId: cbLocal.id, type: cb.type, loc },
          args: handlerArgs,
          type: cb.type.ret,
          loc,
        };
        // The handler's result: promise returns flatten exactly like
        // `return p` in any async body (awaitExpr re-throws rejections —
        // the spec's thenable adoption); everything else coerces into R.
        if (R.kind === "void") {
          if (handlerCall.type.kind === "promise") {
            body.push({
              kind: "exprStmt",
              expr: { kind: "awaitExpr", value: handlerCall, type: handlerCall.type.inner, loc },
              loc,
            });
          } else {
            body.push({ kind: "exprStmt", expr: handlerCall, loc });
          }
          body.push({ kind: "return", value: null, loc });
        } else if (handlerCall.type.kind === "promise" && R.kind !== "promise") {
          const awaited: IrExpr = { kind: "awaitExpr", value: handlerCall, type: handlerCall.type.inner, loc };
          body.push({ kind: "return", value: L.coerceInto(call, awaited, R), loc });
        } else {
          body.push({ kind: "return", value: L.coerceInto(call, handlerCall, R), loc });
        }
        const ctx = L.ctx;
        const lifted: IrFunction = {
          name: fnName,
          params: [
            { localId: pLocal.id, name: pLocal.name, type: promT },
            { localId: cbLocal.id, name: cbLocal.name, type: cb.type },
          ],
          returnType: R,
          locals: ctx.locals,
          captures: ctx.captures!,
          body,
          loc,
          async: true,
        };
        L.liftedFns.push(lifted);
        const closure: IrExpr = { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
        return { kind: "callValue", callee: closure, args: [receiver, cb], type: resultT, loc };
      } finally {
        L.fnStack.pop();
      }
    }

    if (member === "finally") {
      const cb = L.lowerExpr(call.arguments[0]!);
      if (cb.type.kind !== "func" || cb.type.params.length !== 0 || cb.type.ret.kind !== "void") {
        L.unsupported(
          "SC1090",
          call.arguments[0]!,
          "finally callbacks with parameters or a return value (use () => { ... })",
        );
      }
      const fnName = `%fn${L.lambdaCounter++}_finally`;
      const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT, cb.type], ret: promT };
      const fnCtx = newFnCtx(true, null, funcType, inner);
      fnCtx.isAsync = true;
      L.fnStack.push(fnCtx);
      try {
        const pLocal = L.declareHiddenLocal("p", promT);
        const cbLocal = L.declareHiddenLocal("cb", cb.type);
        const cbCall = (): IrStmt => ({
          kind: "exprStmt",
          expr: {
            kind: "callValue",
            callee: { kind: "varRef", localId: cbLocal.id, type: cb.type, loc },
            args: [],
            type: VOID,
            loc,
          },
          loc,
        });
        const awaitE: IrExpr = {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
          type: inner,
          loc,
        };
        const tryBody: IrStmt[] = [];
        if (inner.kind === "void") {
          tryBody.push({ kind: "exprStmt", expr: awaitE, loc });
          tryBody.push(cbCall());
          tryBody.push({ kind: "return", value: null, loc });
        } else {
          const vLocal = L.declareHiddenLocal("v", inner);
          tryBody.push({ kind: "varDecl", localId: vLocal.id, init: awaitE, loc });
          tryBody.push(cbCall());
          tryBody.push({
            kind: "return",
            value: { kind: "varRef", localId: vLocal.id, type: inner, loc },
            loc,
          });
        }
        // catch (e) { cb(); throw e; } — a throwing callback replaces the
        // in-flight rejection, exactly the spec's onFinally rule.
        const eLocal = L.declareHiddenLocal("e", CAUGHT);
        const catchBody: IrStmt[] = [cbCall(), { kind: "rethrow", localId: eLocal.id, loc }];
        const ctx = L.ctx;
        const lifted: IrFunction = {
          name: fnName,
          params: [
            { localId: pLocal.id, name: pLocal.name, type: promT },
            { localId: cbLocal.id, name: cbLocal.name, type: cb.type },
          ],
          returnType: inner,
          locals: ctx.locals,
          captures: ctx.captures!,
          body: [{ kind: "tryCatch", tryBody, catchBody, catchLocalId: eLocal.id, finallyBody: null, loc }],
          loc,
          async: true,
        };
        L.liftedFns.push(lifted);
        const closure: IrExpr = { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
        return { kind: "callValue", callee: closure, args: [receiver, cb], type: promT, loc };
      } finally {
        L.fnStack.pop();
      }
    }

    // .catch on a DYN-SETTLING promise (the tracePromise result's
    // `.catch((e) => ...)`): the rejection reason is a dyn value, so the
    // handler runs through the checked-dynamic tree — a lifted async helper awaits the
    // receiver, passes fulfillments through as dyn, and on rejection
    // calls the boxed handler with caughtToDyn's identity-preserving
    // snapshot (the dyn-then desugar's catch twin).
    if (member === "catch" && inner.kind === "dyn") {
      let cb = L.lowerExpr(call.arguments[0]!);
      if (
        cb.type.kind === "func" &&
        canBoxFuncIntoDyn(cb.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
      ) {
        cb = { kind: "dynFrom", value: cb, type: DYN, loc };
      }
      if (cb.type.kind === "dyn") {
        const resultT: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
        const fnName = `%fn${L.lambdaCounter++}_catchdyn`;
        const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT, DYN], ret: resultT };
        const fnCtx = newFnCtx(true, null, funcType, DYN);
        fnCtx.isAsync = true;
        L.fnStack.push(fnCtx);
        try {
          const pLocal = L.declareHiddenLocal("p", promT);
          const cbLocal = L.declareHiddenLocal("cb", DYN);
          const eLocal = L.declareHiddenLocal("e", CAUGHT);
          const vLocal = L.declareHiddenLocal("v", DYN);
          const tryBody: IrStmt[] = [
            {
              kind: "varDecl",
              localId: vLocal.id,
              init: {
                kind: "awaitExpr",
                value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
                type: DYN,
                loc,
              },
              loc,
            },
            { kind: "return", value: { kind: "varRef", localId: vLocal.id, type: DYN, loc }, loc },
          ];
          const catchBody: IrStmt[] = [
            {
              kind: "return",
              value: {
                kind: "dynCall",
                callee: { kind: "varRef", localId: cbLocal.id, type: DYN, loc },
                calleeName: jsFuncNameOf(call.arguments[0]!) ?? "onRejected",
                args: [
                  {
                    kind: "caughtToDyn",
                    value: { kind: "varRef", localId: eLocal.id, type: CAUGHT, loc },
                    type: DYN,
                    loc,
                  },
                ],
                type: DYN,
                loc,
              },
              loc,
            },
          ];
          const body: IrStmt[] = [
            { kind: "tryCatch", tryBody, catchBody, catchLocalId: eLocal.id, finallyBody: null, loc },
          ];
          const ctx = L.ctx;
          const lifted: IrFunction = {
            name: fnName,
            params: [
              { localId: pLocal.id, name: pLocal.name, type: promT },
              { localId: cbLocal.id, name: cbLocal.name, type: DYN },
            ],
            returnType: DYN,
            locals: ctx.locals,
            captures: ctx.captures!,
            body,
            loc,
            async: true,
          };
          L.liftedFns.push(lifted);
          const closure: IrExpr = { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
          return { kind: "callValue", callee: closure, args: [receiver, cb], type: resultT, loc };
        } finally {
          L.fnStack.pop();
        }
      }
    }

    // .catch: the handler must be INLINE — its parameter becomes the
    // catch binding.
    let handlerNode: ts.Expression = call.arguments[0]!;
    while (ts.isParenthesizedExpression(handlerNode)) handlerNode = handlerNode.expression;
    if (!ts.isArrowFunction(handlerNode) && !ts.isFunctionExpression(handlerNode)) {
      L.unsupported(
        "SC1090",
        call.arguments[0]!,
        "catch handlers that are not inline function literals (the handler's parameter " +
          "becomes a typed-catch binding, which only an inline `(e) => ...` can receive)",
      );
    }
    if (handlerNode.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      L.unsupported("SC1090", handlerNode, "async catch handlers");
    }
    if (handlerNode.parameters.length > 1) {
      L.unsupported("SC1090", handlerNode, "catch handlers with more than one parameter");
    }
    const param = handlerNode.parameters[0];
    if (param && (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer)) {
      L.unsupported("SC1062", param);
    }
    if (
      param?.type &&
      param.type.kind !== ts.SyntaxKind.AnyKeyword &&
      param.type.kind !== ts.SyntaxKind.UnknownKeyword
    ) {
      L.unsupported(
        "SC1090",
        param,
        "catch handlers with a typed parameter (the reject payload can be any thrown " +
          "value — take `(e)` or `(e: unknown)` and narrow with instanceof)",
      );
    }
    const resultT = L.mapTypeOf(L.typeOf(call));
    if (resultT?.kind !== "promise") {
      L.noLowering(
        "catch with this handler's result type",
        call,
        "the combined result must be representable — a handler with no return value over a " +
          "non-void promise makes the result 'T | void': return a fallback of the promise's " +
          "own type, or annotate the handler `(): undefined =>` for the T | undefined result",
      );
    }
    const R = resultT.inner;
    const fnName = `%fn${L.lambdaCounter++}_catch`;
    const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT], ret: resultT };
    const fnCtx = newFnCtx(true, null, funcType, R);
    fnCtx.isAsync = true;
    L.fnStack.push(fnCtx);
    try {
      const pLocal = L.declareHiddenLocal("p", promT);
      const awaitE: IrExpr = {
        kind: "awaitExpr",
        value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
        type: inner,
        loc,
      };
      const tryBody: IrStmt[] =
        R.kind === "void"
          ? [
              { kind: "exprStmt", expr: awaitE, loc },
              { kind: "return", value: null, loc },
            ]
          : [{ kind: "return", value: L.coerceInto(call, awaitE, R), loc }];
      // The handler body lowers as the catch clause, its parameter bound
      // as the CAUGHT local — exactly `catch (e) { ... }`.
      let catchLocalId: string | null = null;
      let catchBody: IrStmt[];
      L.scopes.push(new Map());
      try {
        if (param && ts.isIdentifier(param.name)) {
          catchLocalId = L.declareLocal(param.name, param.name.text, CAUGHT, false).id;
        }
        const hb = handlerNode.body;
        if (ts.isBlock(hb)) {
          catchBody = L.lowerStmts(hb.statements);
        } else if (R.kind === "void") {
          catchBody = [{ kind: "exprStmt", expr: L.lowerExpr(hb), loc: locOf(hb) }];
        } else {
          // Bare-expression handler: `(e) => v` (promise results flatten
          // through the async-return path, like any `return v`).
          catchBody = [{ kind: "return", value: L.lowerReturnValue(hb), loc: locOf(hb) }];
        }
      } finally {
        L.scopes.pop();
      }
      // A handler falling off its end resolves with undefined — the
      // checker already typed R with the undefined arm; the appended wrap
      // also satisfies the validator's always-returns analysis.
      if (R.kind === "union") {
        const def = L.unions.get(R.unionId);
        const undefTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
        if (undefTag >= 0) {
          catchBody.push({
            kind: "return",
            value: {
              kind: "unionWrap",
              unionId: R.unionId,
              tag: undefTag,
              value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
              type: R,
              loc,
            },
            loc,
          });
        }
      } else if (R.kind === "void") {
        catchBody.push({ kind: "return", value: null, loc });
      } else if (R.kind === "dyn") {
        // A checked-dynamic result (the dyn-handler .then's promise-of-dyn
        // chained into .catch): falling off the handler's end resolves
        // with the dyn undefined.
        catchBody.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
      } else if (R.kind === "jsval") {
        // A package-typed result (Promise<Command> — the parseAsync().catch
        // entry line): falling off the handler's end resolves with
        // undefined, which on the island side is the engine's own
        // undefined. Also what makes a never-returning handler (ending in
        // process.exit) satisfy the always-returns analysis.
        catchBody.push({
          kind: "return",
          value: { kind: "jsOp", op: "globalGet", name: "undefined", args: [], type: JSVAL, loc },
          loc,
        });
      }
      const ctx = L.ctx;
      const lifted: IrFunction = {
        name: fnName,
        params: [{ localId: pLocal.id, name: pLocal.name, type: promT }],
        returnType: R,
        locals: ctx.locals,
        captures: ctx.captures!,
        body: [{ kind: "tryCatch", tryBody, catchBody, catchLocalId, finallyBody: null, loc }],
        loc,
        async: true,
      };
      L.liftedFns.push(lifted);
      const closure: IrExpr = { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
      return { kind: "callValue", callee: closure, args: [receiver], type: resultT, loc };
    } finally {
      L.fnStack.pop();
    }
  }

/** NARROWING `a.filter(...)` — the two callback forms whose result the
   * checker types as a NARROWER array than the receiver:
   *
   *   xs.filter((x) => x !== undefined)   // TS-inferred type predicate
   *   xs.filter(Boolean)                  // BooleanConstructor overload
   *
   * Trust discipline: only tests the RUNTIME actually performs may re-tag.
   * An INFERRED predicate (inline arrow/function expression with no return
   * annotation — TS 5.5 only infers `x is T` when the body proves it) and
   * `Boolean` (retained elements are truthy, hence never the undefined/
   * null arm) both qualify; a HAND-WRITTEN `x is T` annotation is an
   * unchecked assertion (a lying one would corrupt the extraction) and
   * stays fenced. The narrowed element must be a SINGLE arm of the
   * receiver's union — retained elements re-tag through unionNarrow in the
   * synthesized loop; a multi-arm target would need the union-to-union
   * re-tag that doesn't exist (fenced with the annotate-the-callback
   * escape). Null hands non-narrowing filters to the generic HOF path. */
  export function lowerFilterNarrowCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "filter") return null;
    if (L.chainBlocked(access, call)) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverIr?.kind !== "array") return null;
    if (!L.isStdlibMember(access)) return null;
    if (call.arguments.length !== 1) return null; // the generic path's arity fence
    const elem = receiverIr.elem;
    const argNode = call.arguments[0]!;
    const loc = locOf(call);

    const isBooleanArg =
      ts.isIdentifier(argNode) &&
      argNode.text === "Boolean" &&
      L.isStdlibSymbol(L.resolveValueSymbol(argNode) ?? undefined);

    // The checker's verdict on the call: filter(Boolean) and predicate
    // callbacks type the result element NARROWER than the receiver's.
    const callT = L.typeOf(call);
    const resultIr = L.mapTypeOf(callT);
    let outElem = resultIr?.kind === "array" ? resultIr.elem : null;
    if (outElem !== null && !typeEquals(outElem, elem)) {
      // An annotation pinning the receiver's own element type opts OUT of
      // the narrowing (`const kept: (Hit | undefined)[] = xs.filter(...)`):
      // tsc allows the covariant assignment, and the wide result is what
      // the desugared loop produces — the pre-predicate behavior, kept.
      const ctxIr = L.mapTypeOf(L.checker.getContextualType(call) ?? callT);
      if (ctxIr?.kind === "array" && typeEquals(ctxIr.elem, elem)) outElem = elem;
    }
    const narrowed = outElem !== null && !typeEquals(outElem, elem);
    if (!narrowed && !isBooleanArg) return null;

    const annotateEscape =
      "keep the receiver's element type instead — annotate the callback's return ': boolean' " +
      "(the checker then skips the predicate) or annotate the result with the receiver's own " +
      "element type — and narrow the elements after";
    let tag: number | null = null;
    if (narrowed) {
      if (outElem === null || elem.kind !== "union") {
        L.badType(call, callT); // defensive: a narrowed non-union receiver
      }
      tag = L.armTag(elem.unionId, outElem);
      if (tag < 0) {
        L.unsupported(
          "SC1090",
          call,
          `'.filter' narrowing '${L.fmt(elem)}' elements to the multi-arm '${L.fmt(outElem)}' ` +
            `(only a SINGLE arm re-tags — ${annotateEscape})`,
        );
      }
    }

    if (isBooleanArg) {
      // ToBoolean must be answerable per element (dyn/caught arms are not).
      if (elem.kind === "union") L.requireTruthyUnion(elem.unionId, argNode);
      if (elem.kind === "dyn" || elem.kind === "jsval" || elem.kind === "void" || isUnitType(elem)) {
        L.badType(argNode, L.typeOf(argNode));
      }
      const receiver = L.lowerExpr(access.expression);
      const helper = filterNarrowHelper(L, "truthy", elem, outElem ?? elem, tag, loc);
      return { kind: "call", callee: helper, args: [receiver], type: arrayOf(outElem ?? elem), loc };
    }

    // Inferred type predicate: inline function literal, NO return
    // annotation (a written one is an unchecked assertion), and the
    // checker reports a predicate over parameter 0.
    if (!ts.isArrowFunction(argNode) && !ts.isFunctionExpression(argNode)) {
      L.unsupported(
        "SC1090",
        argNode,
        `narrowing '.filter' through a callback VALUE ` +
          `(only an inline callback whose predicate the checker inferred can re-tag — ${annotateEscape})`,
      );
    }
    if (argNode.type) {
      L.unsupported(
        "SC1090",
        argNode,
        `narrowing '.filter' with a hand-written type predicate ` +
          `(a written 'x is T' is an unchecked assertion nothing validates at runtime — ${annotateEscape})`,
      );
    }
    // The receiver evaluates FIRST, in the enclosing function, like JS.
    const receiver = L.lowerExpr(access.expression);
    const fnArg = L.lowerExpr(argNode);
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length !== 1 ||
      !typeEquals(fnArg.type.params[0]!, elem) ||
      fnArg.type.ret.kind !== "bool"
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    const helper = filterNarrowHelper(L, "callback", elem, outElem!, tag, loc);
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: arrayOf(outElem!), loc };
  }

/** Interned synthetic loop for one narrowing/truthy filter combo — the
   * filter twin of arrayHofHelper, with the retained element re-tagged
   * (unionNarrow) when the output arm is narrower than the element union:
   *
   *   out = []; n = a.length;
   *   for (i = 0; i < n; i++) { v = a[i]; if (<test>) out.push(narrow(v)); }
   *   return out;
   *
   * <test> is f(v) for the predicate form and ToBoolean(v) for Boolean.
   * The re-tag is sound exactly because the test just PASSED for v: an
   * inferred predicate proved the arm dynamically, and a truthy value is
   * never the undefined/null arm. */
  function filterNarrowHelper(L: Lowerer, test: "callback" | "truthy",
    elem: IrType,
    outElem: IrType,
    tag: number | null,
    loc: SrcLoc,): string {
    const key = `filterNarrow:${test}:${typeKey(elem)}:${typeKey(outElem)}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.filterNarrow.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);

    const arrT = arrayOf(elem);
    const outT = arrayOf(outElem);
    const fnT = funcOf([elem], BOOL);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      ...(test === "callback" ? [{ id: "f.0", name: "f", type: fnT, mutable: true } as IrLocal] : []),
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "v.0", name: "v", type: elem, mutable: false },
    ];
    const params: IrParam[] = [
      { localId: "a.0", name: "a", type: arrT },
      ...(test === "callback" ? [{ localId: "f.0", name: "f", type: fnT }] : []),
    ];
    const v = ref("v.0", elem);
    const cond: IrExpr =
      test === "callback"
        ? { kind: "callValue", callee: ref("f.0", fnT), args: [v], type: BOOL, loc }
        : { kind: "toBool", operand: v, type: BOOL, loc };
    const kept: IrExpr =
      tag !== null && elem.kind === "union"
        ? { kind: "unionNarrow", unionId: elem.unionId, tag, value: v, type: outElem, loc }
        : v;
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
      {
        kind: "varDecl",
        localId: "n.0",
        init: { kind: "arrIntrinsic", method: "length", receiver: ref("a.0", arrT), args: [], type: F64, loc },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: ref("n.0", F64), type: BOOL, loc },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "varDecl",
            localId: "v.0",
            init: { kind: "arrayGet", arr: ref("a.0", arrT), index: ref("i.0", F64), type: elem, loc },
            loc,
          },
          {
            kind: "if",
            cond,
            then: [
              {
                kind: "exprStmt",
                expr: {
                  kind: "arrIntrinsic",
                  method: "push",
                  receiver: ref("out.0", outT),
                  args: [kept],
                  type: F64,
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("out.0", outT), loc },
    ];
    L.liftedFns.push({ name, params, returnType: outT, locals, body, loc });
    return name;
  }

/** `Object.keys(r)` / `Object.values(r)` / `Object.entries(r)` over FIXED
   * record shapes: the field list is compile-time-known, so each lowers to
   * an interned helper whose body is a sequence of pushes — no reflection,
   * no runtime walk. ORDER is the shape's first-seen DECLARATION order
   * (threaded through the shape registry), which matches Node whenever
   * objects are constructed in declaration order — the divergence for
   * reordered construction is SEMANTICS.md 36. Fields holding the
   * undefined arm of their union are SKIPPED at runtime (Node's missing
   * key: an unset optional never made it into the object), which also
   * means an EXPLICIT `{ a: undefined }` key is dropped where Node lists
   * it — same rule as jsonStringify, same SEMANTICS entry. Values wrap
   * into the checker's result-element type per field; a multi-arm field
   * union that differs from the result union would need a re-tag — fenced.
   * Null when this isn't an Object static over a fixed record (index
   * signatures keep the SC2020 fence: the overflow needs a runtime walk). */
  /** Statics on the global Symbol object: `Symbol.for(key)` (the global
   * registry — one interned symbol per key, identical on every call, like
   * Node across realms) and `Symbol.keyFor(sym)` (the registry key as the
   * checker's `string | undefined` — undefined for unregistered symbols).
   * Every OTHER member of SymbolConstructor is a well-known symbol
   * (Symbol.iterator, Symbol.asyncIterator, Symbol.toStringTag, ...) —
   * language-level protocol uses (for-of, template literals) already
   * compile through their constructs without reifying the symbol, so the
   * VALUE forms fence with a named message rather than a blanket
   * SymbolConstructor type fence. */
  function lowerSymbolStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!L.isStdlibGlobal(access.expression, "Symbol")) return null;
    const member = access.name.text;
    const loc = locOf(call);
    if (member === "for") {
      if (call.arguments.length !== 1) {
        L.noLowering(`Symbol.for with ${call.arguments.length} arguments`, call);
      }
      const key = L.lowerExprExpecting(call.arguments[0]!, STRING);
      return { kind: "libCall", fn: "sym.for", args: [key], type: SYMBOL_T, loc };
    }
    if (member === "keyFor") {
      if (call.arguments.length !== 1) {
        L.noLowering(`Symbol.keyFor with ${call.arguments.length} arguments`, call);
      }
      const sym = L.lowerExpr(call.arguments[0]!);
      if (sym.type.kind !== "symbol") {
        L.noLowering(
          `Symbol.keyFor of a '${L.fmt(sym.type)}' value`,
          call.arguments[0]!,
          "the argument must be symbol-typed",
        );
      }
      // The checker types the call `string | undefined`, which interns
      // the result union (the map.get pattern); the backend builds the
      // arms from the runtime's +1-or-NULL answer.
      const type = L.irTypeOf(call);
      if (type.kind !== "union") L.badType(call, L.typeOf(call));
      const read: IrExpr = { kind: "libCall", fn: "sym.keyFor", args: [sym], type, loc };
      return L.maybeNarrow(read, call);
    }
    L.unsupported(
      "SC1090",
      call,
      `well-known symbols as values (Symbol.${member} — for-of, iteration protocols, and template literals compile through their language constructs; the reified symbol has no static lowering)`,
    );
  }

  /** Method calls on symbol-typed receivers: `.toString()` is the
   * "Symbol(desc)" text (Node's Symbol.prototype.toString — note that
   * template literals and concatenation THROW in JS and stay fenced;
   * toString is the one sanctioned spelling). `.valueOf()` is the
   * identity read. */
  function lowerSymbolMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "symbol") return null;
    if (!L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    if (name === "toString" && call.arguments.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      if (receiver.type.kind !== "symbol") return null;
      return { kind: "libCall", fn: "sym.toString", args: [receiver], type: STRING, loc };
    }
    if (name === "valueOf" && call.arguments.length === 0) {
      const receiver = L.lowerExpr(access.expression);
      if (receiver.type.kind !== "symbol") return null;
      return receiver;
    }
    return null; // description-as-a-call, ... → the stdlib member fence
  }

  /** The interned keys-array helper over a FIXED record shape: a call of a
   * lifted helper whose body pushes each declared field name in first-seen
   * DECLARATION order, skipping fields currently holding the undefined arm
   * of their union at runtime (Node's missing key — an unset optional
   * never made it into the object; SEMANTICS.md 37's rules). ONE
   * construction, interned per shape, shared by Object.keys and for-in —
   * for-in iterates exactly the keys Object.keys answers. */
  export function recordKeysArrayCall(
    L: Lowerer,
    receiver: IrExpr,
    argIr: IrType & { kind: "record" },
    shape: { declaredOrder?: string[]; fields: { name: string; type: IrType }[] },
    loc: SrcLoc,
  ): IrExpr {
    const resultT = arrayOf(STRING);
    const key = `obj.keys:${argIr.shapeId}:${typeKey(resultT)}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.keys.${L.arrHofHelpers.size}`;
      const ref: IrExpr = { kind: "varRef", localId: "r.0", type: argIr, loc };
      const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: resultT, loc };
      L.arrHofHelpers.set(key, helper);
      const fn: IrFunction = {
        name: helper,
        params: [{ localId: "r.0", name: "r", type: argIr }],
        returnType: resultT,
        locals: [
          { id: "r.0", name: "r", type: argIr, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
        ],
        body: [],
        loc,
      };
      const finalize = (): void => {
        const current = L.shapes.get(argIr.shapeId) ?? shape;
        const body: IrStmt[] = [
          { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: resultT, loc }, loc },
        ];
        const order = current.declaredOrder ?? current.fields.map((f) => f.name);
        for (const name of order) {
          const f = current.fields.find((x) => x.name === name)!;
          const pushStmt: IrStmt = {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: outRef,
              args: [{ kind: "strLit", value: f.name, type: STRING, loc }],
              type: F64,
              loc,
            },
            loc,
          };
          // Undefined-armed fields: the push is guarded by a tag test (the
          // key exists exactly when Object.keys would list it).
          const utag = f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
          body.push(
            utag >= 0 && f.type.kind === "union"
              ? {
                  kind: "if",
                  cond: {
                    kind: "unionIsTag",
                    unionId: f.type.unionId,
                    tag: utag,
                    negated: true,
                    value: { kind: "recordGet", obj: ref, shapeId: argIr.shapeId, field: f.name, type: f.type, loc },
                    type: BOOL,
                    loc,
                  },
                  then: [pushStmt],
                  else_: null,
                  loc,
                }
              : pushStmt,
          );
        }
        body.push({ kind: "return", value: outRef, loc });
        fn.body = body;
      };
      finalize();
      L.shapeOrderHelperFinalizers.push(finalize);
      L.liftedFns.push(fn);
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }

  /** Interned `%obj.hasOwn.<n>(r, k)` — Object.hasOwn's membership walk
   * over a signature-free record shape: the key compares against each
   * declared field name, undefined-armed fields answering by their tag
   * (a key is own exactly when Object.keys would list it — the two share
   * the guard), everything else true, no match false. */
  function recordHasOwnHelper(L: Lowerer, shapeId: string, loc: SrcLoc): string {
    const key = `obj.hasOwn:${shapeId}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const helper = `%obj.hasOwn.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const shape = L.shapes.get(shapeId)!;
    const recT: IrType = { kind: "record", shapeId };
    const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
    const kRef: IrExpr = { kind: "varRef", localId: "k.0", type: STRING, loc };
    const body: IrStmt[] = [];
    for (const f of shape.fields) {
      const utag = f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
      const answer: IrExpr =
        utag >= 0 && f.type.kind === "union"
          ? {
              kind: "unionIsTag",
              unionId: f.type.unionId,
              tag: utag,
              negated: true,
              value: { kind: "recordGet", obj: rRef, shapeId, field: f.name, type: f.type, loc },
              type: BOOL,
              loc,
            }
          : { kind: "boolLit", value: true, type: BOOL, loc };
      body.push({
        kind: "if",
        cond: { kind: "strEq", negated: false, left: kRef, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc },
        then: [{ kind: "return", value: answer, loc }],
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc });
    L.liftedFns.push({
      name: helper,
      params: [
        { localId: "r.0", name: "r", type: recT },
        { localId: "k.0", name: "k", type: STRING },
      ],
      returnType: BOOL,
      locals: [
        { id: "r.0", name: "r", type: recT, mutable: true },
        { id: "k.0", name: "k", type: STRING, mutable: false },
      ],
      body,
      loc,
    });
    return helper;
  }

  /** Interned `%obj.assign.<n>(t, s)` — Object.assign's per-field copy
   * over signature-free records (every source field lands on a same-named,
   * same-typed target field — the caller's gate): undefined-armed source
   * fields copy behind the not-undefined guard, everything else straight,
   * and the TARGET returns (JS's aliasing). */
  function recordAssignHelper(L: Lowerer, targetShapeId: string, srcShapeId: string, loc: SrcLoc): string {
    const key = `obj.assign:${targetShapeId}:${srcShapeId}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const helper = `%obj.assign.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const sShape = L.shapes.get(srcShapeId)!;
    const tT: IrType = { kind: "record", shapeId: targetShapeId };
    const sT: IrType = { kind: "record", shapeId: srcShapeId };
    const tRef: IrExpr = { kind: "varRef", localId: "t.0", type: tT, loc };
    const sRef: IrExpr = { kind: "varRef", localId: "s.0", type: sT, loc };
    const body: IrStmt[] = [];
    for (const f of sShape.fields) {
      const get: IrExpr = { kind: "recordGet", obj: sRef, shapeId: srcShapeId, field: f.name, type: f.type, loc };
      const set: IrStmt = { kind: "recordSet", obj: tRef, shapeId: targetShapeId, field: f.name, value: get, loc };
      const utag = f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
      body.push(
        utag >= 0 && f.type.kind === "union"
          ? {
              kind: "if",
              cond: { kind: "unionIsTag", unionId: f.type.unionId, tag: utag, negated: true, value: get, type: BOOL, loc },
              then: [set],
              else_: null,
              loc,
            }
          : set,
      );
    }
    body.push({ kind: "return", value: tRef, loc });
    L.liftedFns.push({
      name: helper,
      params: [
        { localId: "t.0", name: "t", type: tT },
        { localId: "s.0", name: "s", type: sT },
      ],
      returnType: tT,
      locals: [
        { id: "t.0", name: "t", type: tT, mutable: true },
        { id: "s.0", name: "s", type: sT, mutable: true },
      ],
      body,
      loc,
    });
    return helper;
  }

  /** The `Iterator` global's statics (ES2025 — Iterator.from, and the
   * abstract constructor as a value): no first-class iterator objects
   * exist here, so every member fences with the working spelling named
   * instead of the generic-method fence's monomorphization wording. */
  function lowerIteratorStaticFence(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (!L.isStdlibGlobal(access.expression, "Iterator")) return null;
    if (!L.isStdlibMember(access)) return null;
    L.noLowering(
      `Iterator.${access.name.text}`,
      call,
      "first-class iterator objects have no lowering — iterator helpers compile as one chain on an " +
        "array iterator, consumed in place: arr.values().map(f).take(n).toArray()",
    );
  }

  /** `RegExp.escape(s)` (ES2025) — the one RegExp static with a lowering:
   * a total string→string libCall (scr_regexp_escape). The lib pins the
   * argument to string, so the only unlowered shape is a non-string-typed
   * lowering (dyn/union), which fences. Null for other RegExp members
   * (the stdlib member fence names them). */
  function lowerRegExpStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!L.isStdlibGlobal(access.expression, "RegExp")) return null;
    if (access.name.text !== "escape") return null;
    if (!L.isStdlibMember(access)) return null;
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
      L.noLowering(`RegExp.escape with ${call.arguments.length} arguments`, call);
    }
    const arg = L.lowerExprExpecting(call.arguments[0]!, STRING);
    if (arg.type.kind !== "string") L.badType(call.arguments[0]!, L.typeOf(call.arguments[0]!));
    return { kind: "libCall", fn: "regexp.escape", args: [arg], type: STRING, loc: locOf(call) };
  }

  /** The composed en-US Intl.NumberFormat form: `new Intl.NumberFormat(
   * "en-US").format(x)` (and the callable spelling without `new` — the
   * spec makes them the same formatter). Only the COMPOSED form lowers —
   * formatter values have no representation — and only the one locale
   * whose data the runtime embeds, with default options: decimal
   * notation, 0–3 fraction digits rounded half-up on the shortest
   * round-tripping decimal (ICU's rounding input — format(1.0005) is
   * "1.001" though toFixed(3) answers "1.000"), "," grouping. The
   * unlowered forms fence by NAME (no locale — the host environment's
   * default, which a compiled binary cannot carry; other locales — ICU
   * data the binary does not embed; options bags; non-number arguments).
   * Null when the callee isn't a NumberFormat-construction .format. */
  function lowerIntlNumberFormatCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "format") return null;
    let recv: ts.Expression = access.expression;
    while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
    let ctorArgs: readonly ts.Expression[];
    if (ts.isNewExpression(recv) || (ts.isCallExpression(recv) && !recv.questionDotToken)) {
      const ctor = recv.expression;
      if (
        !ts.isPropertyAccessExpression(ctor) || ctor.questionDotToken ||
        ctor.name.text !== "NumberFormat" || !L.isStdlibGlobal(ctor.expression, "Intl")
      ) {
        return null;
      }
      ctorArgs = recv.arguments ?? [];
    } else {
      return null;
    }
    const loc = locOf(call);
    if (ctorArgs.length === 0) {
      L.noLowering(
        "Intl.NumberFormat without a locale",
        recv,
        "the default locale is the host environment's, which a compiled binary cannot carry — " +
          'pass it explicitly: new Intl.NumberFormat("en-US").format(x)',
      );
    }
    if (ctorArgs.length > 1) {
      L.noLowering(
        "Intl.NumberFormat with an options bag",
        ctorArgs[1]!,
        "the embedded data covers DEFAULT options only (decimal notation, up to 3 fraction digits, " +
          'grouping) — new Intl.NumberFormat("en-US").format(x)',
      );
    }
    const locArg = ctorArgs[0]!;
    if (ts.isSpreadElement(locArg) || !ts.isStringLiteralLike(locArg) || locArg.text !== "en-US") {
      L.noLowering(
        !ts.isSpreadElement(locArg) && ts.isStringLiteralLike(locArg)
          ? `Intl.NumberFormat at locale "${locArg.text}"`
          : "Intl.NumberFormat with a non-literal locale",
        locArg,
        '"en-US" (Node\'s default-build locale) is the one locale whose data the runtime embeds — ' +
          "everything else is ICU data the binary does not carry",
      );
    }
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
      L.noLowering(`Intl.NumberFormat("en-US").format with ${call.arguments.length} arguments`, call);
    }
    const argNode = call.arguments[0]!;
    if (L.mapTypeOf(L.typeOf(argNode))?.kind !== "f64") {
      L.noLowering(
        `Intl.NumberFormat("en-US").format over a '${L.checker.typeToString(L.typeOf(argNode))}'`,
        argNode,
        "a number argument is the lowered form (bigint and numeric-string inputs have no representation)",
      );
    }
    const arg = L.lowerExprExpecting(argNode, F64);
    if (arg.type.kind !== "f64") L.badType(argNode, L.typeOf(argNode));
    return { kind: "libCall", fn: "intl.numFormatEnUs", args: [arg], type: STRING, loc };
  }

  /** Object.is over statically disjoint kinds: the constant false, with
   * both operands still evaluated for their effects (droppable statics
   * fold away — JS evaluates arguments, but nothing observes a pure one). */
  function objectIsDisjointFalse(left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr {
    const stmts: IrStmt[] = [];
    for (const e of [left, right]) {
      if (!droppableStatic(e)) stmts.push({ kind: "exprStmt", expr: e, loc });
    }
    const answer: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
    if (stmts.length === 0) return answer;
    return { kind: "seqExpr", stmts, result: answer, type: BOOL, loc };
  }

  function lowerObjectStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!L.isStdlibGlobal(access.expression, "Object")) return null;
    const member = access.name.text;
    // Object.is — the spec's SameValue over the static kinds. Number
    // pairs take the runtime SameValue (NaN equals NaN, +0 differs from
    // -0 — the two divergences from ===); every other supported pair
    // rides exactly the strict-equality machinery, whose answers
    // SameValue shares: strings by bytes, bools by value, unit literals
    // by tag, unions per arm (a number arm's payload compare upgrades to
    // SameValue via unionEq's flag), and the reference kinds by pointer
    // identity. Statically DISJOINT kind pairs answer the constant false
    // with the operands still evaluated (tsc admits any pair — Object.is
    // is (any, any) — and JS evaluates the arguments either way).
    // dyn/jsval operands keep strict equality's stance: validate first.
    if (member === "is") {
      if (call.arguments.length !== 2 || call.arguments.some((a) => ts.isSpreadElement(a))) {
        L.noLowering(
          `Object.is with ${call.arguments.length} arguments`,
          call,
          "exactly two arguments are the lowered form (JS treats a missing one as undefined — pass it explicitly)",
        );
      }
      const loc = locOf(call);
      const leftNode = call.arguments[0]!;
      const rightNode = call.arguments[1]!;
      const left = L.lowerExpr(leftNode);
      const right = L.lowerExpr(rightNode);
      const lk = left.type.kind;
      const rk = right.type.kind;
      if (lk === "f64" && rk === "f64") {
        return { kind: "libCall", fn: "num.sameValue", args: [left, right], type: BOOL, loc };
      }
      if (left.type.kind === "string" && right.type.kind === "string") {
        return { kind: "strEq", negated: false, left, right, type: BOOL, loc };
      }
      if (lk === "bool" && rk === "bool") {
        return { kind: "bin", op: "===", left, right, type: BOOL, loc };
      }
      const unitTest = L.lowerUnitComparison(left, right, false, loc);
      if (unitTest) return unitTest;
      if (lk === "dyn" || rk === "dyn" || lk === "jsval" || rk === "jsval") {
        L.noLowering(
          "Object.is over a dynamic operand",
          call,
          "validate/narrow the value first (strict equality's rule) — SameValue only differs from === on numbers (NaN, ±0)",
        );
      }
      if (left.type.kind === "union" || right.type.kind === "union") {
        const ut = left.type.kind === "union" ? left.type : (right.type as IrType & { kind: "union" });
        const bothUnion = left.type.kind === "union" && right.type.kind === "union";
        const sameUnion = bothUnion && typeEquals(left.type, right.type);
        if ((sameUnion || !bothUnion) && L.eqComparableUnion(ut.unionId)) {
          const plain = left.type.kind === "union" ? right : left;
          const arms = L.unions.get(ut.unionId)?.arms ?? [];
          // The plain side wraps into the union exactly like === when the
          // union holds its type; a plain PRIMITIVE the union has no arm
          // for is the disjoint constant false (coercing it would strand).
          if (bothUnion || arms.some((a) => typeEquals(a, plain.type))) {
            const sameValue = arms.some((a) => a.kind === "f64");
            return {
              kind: "unionEq",
              unionId: ut.unionId,
              negated: false,
              sameValue,
              left: L.coerceInto(leftNode, left, ut),
              right: L.coerceInto(rightNode, right, ut),
              type: BOOL,
              loc,
            };
          }
          if (
            plain.type.kind === "f64" || plain.type.kind === "string" ||
            plain.type.kind === "bool" || isUnitType(plain.type)
          ) {
            return objectIsDisjointFalse(left, right, loc);
          }
        }
        L.noLowering(
          "Object.is over these union operands",
          call,
          `union-typed comparisons need one comparable shape (${NARROW_FIRST})`,
        );
      }
      // Reference kinds: pointer identity — exactly strict equality
      // (hierarchy-related classes widen the derived side first).
      let idLeft = left;
      let idRight = right;
      if (left.type.kind === "object" && right.type.kind === "object") {
        if (L.isSubclassOf(left.type.className, right.type.className)) {
          idLeft = L.upcastTo(left, right.type.className);
        } else if (L.isSubclassOf(right.type.className, left.type.className)) {
          idRight = L.upcastTo(right, left.type.className);
        }
      }
      if (
        (idLeft.type.kind === "func" && idRight.type.kind === "func") ||
        (idLeft.type.kind === "classval" && idRight.type.kind === "classval")
      ) {
        return { kind: "bin", op: "===", left: idLeft, right: idRight, type: BOOL, loc };
      }
      if (
        (idLeft.type.kind === "array" || idLeft.type.kind === "map" ||
          idLeft.type.kind === "set" || idLeft.type.kind === "object" ||
          idLeft.type.kind === "record" || idLeft.type.kind === "symbol" ||
          idLeft.type.kind === "bytes" || idLeft.type.kind === "promise") &&
        typeEquals(idLeft.type, idRight.type)
      ) {
        return { kind: "bin", op: "===", left: idLeft, right: idRight, type: BOOL, loc };
      }
      // Statically disjoint pairs with a primitive/unit side: SameValue
      // never crosses kinds, so the answer is the constant false.
      const disjoint = new Set(["f64", "string", "bool", "undefinedT", "nullT"]);
      if (lk !== rk && (disjoint.has(lk) || disjoint.has(rk))) {
        return objectIsDisjointFalse(left, right, loc);
      }
      L.noLowering(
        `Object.is over '${L.fmt(left.type)}' and '${L.fmt(right.type)}' operands`,
        call,
        "the operands must share one comparable kind (numbers, strings, booleans, units, one union shape, or one reference type)",
      );
    }
    // Object.create — the null-prototype DICTIONARY (`Object.create(null)`
    // then keyed assignment, the memo-table idiom prettier's index/
    // group-mode maps spell) and, under --dynamic, the engine's own
    // Object.create for engine-held prototypes. Everything else is a
    // NAMED fence: the compiled representations have no prototype chain,
    // and the own-copy stand-in would answer WRONG observably — Node's
    // Object.keys/inspect/JSON of the created object list NO own keys,
    // and mutating the prototype afterwards is visible through the
    // created object (live delegation), which no copy can honor.
    if (member === "create") {
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        L.noLowering("Object.create with spread arguments", call);
      }
      if (call.arguments.length >= 2) {
        L.noLowering(
          "Object.create with a properties-descriptor argument",
          call,
          "create first, then assign: const o = Object.create(null); o.k = v",
        );
      }
      if (call.arguments.length !== 1) {
        L.noLowering(`Object.create with ${call.arguments.length} arguments`, call);
      }
      const loc = locOf(call);
      let protoNode: ts.Expression = call.arguments[0]!;
      while (ts.isParenthesizedExpression(protoNode)) protoNode = protoNode.expression;
      const nullProto = protoNode.kind === ts.SyntaxKind.NullKeyword;
      if (L.dynamic) {
        // The checker types the result `any` — an ENGINE value under
        // --dynamic — and the engine's own Object.create answers with
        // REAL prototype semantics: reads delegate LIVE, writes shadow,
        // and inspect renders Node's exact shapes ("[Object: null
        // prototype]" included). null and engine-held (jsval) prototypes
        // route; checked-dynamic (dyn) prototypes keep the named fence —
        // their marshal into the engine is a DEEP COPY, so a later
        // prototype mutation would be invisible through the created
        // object where Node delegates live.
        const objectGlobal = (): IrExpr => ({ kind: "jsOp", op: "globalGet", name: "Object", args: [], type: JSVAL, loc });
        if (nullProto) {
          const nullIn: IrExpr = { kind: "jsOp", op: "nullLit", args: [], type: JSVAL, loc };
          return { kind: "jsOp", op: "callMethod", name: "create", args: [objectGlobal(), nullIn], type: JSVAL, loc };
        }
        const proto = L.lowerExpr(protoNode);
        if (proto.type.kind === "jsval") {
          return { kind: "jsOp", op: "callMethod", name: "create", args: [objectGlobal(), proto], type: JSVAL, loc };
        }
        L.noLowering(
          `Object.create over '${L.fmt(proto.type)}' prototypes`,
          call,
          "prototype reads delegate LIVE in Node (mutating the prototype shows through the created object), which the boundary's deep copy cannot honor — only null and engine-held ('any') prototypes lower",
        );
      }
      if (nullProto) {
        return { kind: "libCall", fn: "dyn.objCreateNullProto", args: [], type: DYN, loc };
      }
      const proto = L.lowerExpr(protoNode);
      L.noLowering(
        `Object.create over '${L.fmt(proto.type)}' prototypes`,
        call,
        "the compiled representations have no prototype chain, and an own-copy would answer wrong observably (Node lists NO own keys on the created object, and prototype mutations show through it live) — only Object.create(null) lowers",
      );
    }
    // `Object.assign(fn, { props })` whose RESULT type maps to the hybrid
    // (function-with-properties) record: the chalk-shape CONSTRUCTOR.
    if (member === "assign") {
      const hybrid = lowerObjectAssignHybrid(L, call);
      if (hybrid) return hybrid;
      // `Object.assign({}, lit)` — an EMPTY fresh-literal target and one
      // object-literal source: the result is a fresh object carrying
      // exactly the source literal's properties, which IS the source
      // literal evaluated (both fresh, no alias can tell them apart).
      // Everything else keeps the spread hint (stdlibMemberFence).
      if (call.arguments.length === 2 && !call.arguments.some((a) => ts.isSpreadElement(a))) {
        let target: ts.Expression = call.arguments[0]!;
        while (ts.isParenthesizedExpression(target)) target = target.expression;
        let source: ts.Expression = call.arguments[1]!;
        while (ts.isParenthesizedExpression(source)) source = source.expression;
        if (
          ts.isObjectLiteralExpression(target) && target.properties.length === 0 &&
          ts.isObjectLiteralExpression(source)
        ) {
          return L.lowerExpr(source);
        }
      }
      // `Object.assign(target, ...sources)` into an INDEX-SIGNATURE record
      // (the init-config merge pattern): the keyed-write walk over each
      // source, returning the target — lower-containers owns the matrix.
      const merged = lowerObjectAssignIndexShape(L, call);
      if (merged) return merged;
      // `Object.assign(target, source)` over signature-free RECORDS whose
      // source fields all land on same-named, same-typed target fields
      // (the mockable-clock restore: `Object.assign(mocked,
      // implementations)` over one shape): the per-field copy helper,
      // returning the TARGET — JS's aliasing, the target mutates in
      // place. Undefined-armed source fields copy behind the
      // not-undefined guard (an omitted optional field holds the
      // undefined arm and must not erase the target's value — Node
      // copies own keys only; an EXPLICIT `k: undefined` source diverges,
      // the explicit-undefined-is-absent stance). Everything else keeps
      // the spread hint.
      if (call.arguments.length === 2 && !call.arguments.some((a) => ts.isSpreadElement(a))) {
        const tProbe = probeLower(L, call.arguments[0]!);
        const sProbe = probeLower(L, call.arguments[1]!);
        // CHECKED-DYNAMIC target and source (the JS file-scope
        // object-literal identity story): the runtime dyn copy — own
        // members of the source land on the target, which returns.
        if (tProbe?.type.kind === "dyn") {
          const loc = locOf(call);
          const target = L.lowerExpr(call.arguments[0]!);
          const source = L.coerceToExpected(L.lowerExpr(call.arguments[1]!), DYN);
          if (target.type.kind === "dyn" && source.type.kind === "dyn") {
            return { kind: "libCall", fn: "dyn.assign", args: [target, source], type: DYN, loc };
          }
        }
        if (tProbe?.type.kind === "record" && sProbe?.type.kind === "record") {
          const tShape = L.shapes.get(tProbe.type.shapeId);
          const sShape = L.shapes.get(sProbe.type.shapeId);
          const ok =
            tShape && sShape &&
            !tShape.tuple && !sShape.tuple &&
            !tShape.indexValue && !sShape.indexValue &&
            !shapeHasAccessorSlots(tShape) && !shapeHasAccessorSlots(sShape) &&
            sShape.fields.every((sf) => {
              const tf = tShape.fields.find((x) => x.name === sf.name);
              return tf !== undefined && typeEquals(tf.type, sf.type);
            });
          if (ok) {
            const loc = locOf(call);
            const target = L.lowerExpr(call.arguments[0]!);
            const source = L.lowerExpr(call.arguments[1]!);
            if (target.type.kind === "record" && source.type.kind === "record") {
              const helper = recordAssignHelper(L, target.type.shapeId, source.type.shapeId, loc);
              return { kind: "call", callee: helper, args: [target, source], type: target.type, loc };
            }
          }
        }
      }
      // `Object.assign(target, ...sources)` over a CHECKED-DYNAMIC target
      // — the n-ary/spread form (`Object.assign({}, ...plugins.map(p =>
      // p.options), coreOptions)`, support.js's option-table merge). The
      // sources pack into one fresh dyn array FIRST — plain sources
      // retain in, spread sources flatten through the spread-call walk
      // (V8's exact TypeError texts, the source spelling carried for the
      // nullish form) — so every source evaluates and flattens before any
      // copying (JS's ArgumentListEvaluation: a throwing spread leaves
      // the target untouched), then one runtime walk copies each source's
      // own enumerable keys left to right and answers the TARGET
      // (identity, like JS). Each source must enter the dyn world (dyn
      // already, or dynFrom's JSON-safe conversion — a STATIC array
      // spread copies in at the boundary, the documented aliasing
      // stance); anything else keeps the fence. Targets: dyn values, a
      // FRESH object-literal target (`Object.assign({}, ...)` — no alias
      // exists, so building it as a dyn object instead of a record is
      // unobservable), or a nullish unit (Node's ToObject TypeError
      // throws at the call, catchably); aliased record targets keep the
      // fence — their identity could not survive the conversion.
      if (call.arguments.length >= 1 && !ts.isSpreadElement(call.arguments[0]!)) {
        let targetNode: ts.Expression = call.arguments[0]!;
        while (ts.isParenthesizedExpression(targetNode)) targetNode = targetNode.expression;
        const freshLiteralTarget = ts.isObjectLiteralExpression(targetNode);
        const tProbe = freshLiteralTarget ? null : probeLower(L, call.arguments[0]!);
        const tKind = tProbe?.type.kind;
        if (freshLiteralTarget || tKind === "dyn" || tKind === "nullT" || tKind === "undefinedT") {
          const loc = locOf(call);
          const target = L.lowerExprExpecting(call.arguments[0]!, DYN);
          if (target.type.kind === "dyn") {
            const t = L.declareHiddenLocal("%oat", DYN);
            const p = L.declareHiddenLocal("%oap", DYN);
            const tRef = (): IrExpr => ({ kind: "varRef", localId: t.id, type: DYN, loc });
            const pRef = (): IrExpr => ({ kind: "varRef", localId: p.id, type: DYN, loc });
            const stmts: IrStmt[] = [
              { kind: "varDecl", localId: t.id, init: target, loc },
              { kind: "varDecl", localId: p.id, init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
            ];
            // V8 spells the optimized apply-path texts (the expression
            // named for a nullish source) only when the spread is the
            // SINGLE LAST argument; every other spread position drives
            // the real iterator protocol, whose failure describes the
            // value — the two runtime variants, picked here by position.
            const sources = call.arguments.slice(1);
            const spreadCount = sources.filter((a) => ts.isSpreadElement(a)).length;
            let ok = true;
            for (let i = 0; i < sources.length; i++) {
              const argNode = sources[i]!;
              const spread = ts.isSpreadElement(argNode);
              const srcNode = spread ? argNode.expression : argNode;
              const src = L.coerceToExpected(L.lowerExpr(srcNode), DYN);
              if (src.type.kind !== "dyn") {
                ok = false;
                break;
              }
              const argLoc = locOf(argNode);
              const optimized = spreadCount === 1 && i === sources.length - 1;
              stmts.push({
                kind: "exprStmt",
                expr: spread
                  ? optimized
                    ? {
                        kind: "libCall",
                        fn: "dyn.packPushSpread",
                        args: [pRef(), src, { kind: "strLit", value: srcNode.getText(), type: STRING, loc: argLoc }],
                        type: VOID,
                        loc: argLoc,
                      }
                    : { kind: "libCall", fn: "dyn.packPushSpreadIter", args: [pRef(), src], type: VOID, loc: argLoc }
                  : { kind: "libCall", fn: "dyn.packPush", args: [pRef(), src], type: VOID, loc: argLoc },
                loc: argLoc,
              });
            }
            if (ok) {
              return {
                kind: "seqExpr",
                stmts,
                result: { kind: "libCall", fn: "dyn.assignAll", args: [tRef(), pRef()], type: DYN, loc },
                type: DYN,
                loc,
              };
            }
          }
        }
      }
      return null;
    }
    // Object.defineProperties over a CHECKED-DYNAMIC target (test/common's
    // _mustCallInner copying name/length onto the mustCall wrapper): the
    // runtime turns each descriptor's `value` into a plain own property on
    // the dyn node (OBJ members; FUNC nodes carry an own-property table) —
    // flags accepted and ignored, accessors throw loudly (SEMANTICS.md).
    // The result is the target, like JS. Typed targets keep the fence:
    // static shapes have no property table to extend.
    if (member === "defineProperties" && call.arguments.length === 2 &&
        !call.arguments.some((a) => ts.isSpreadElement(a))) {
      let target = probeLower(L, call.arguments[0]!);
      // A FUNCTION-typed target boxes through the dyn boundary: the
      // property table lives on the CLOSURE (shared by every box of this
      // function value), so defining through a fresh box sticks — the
      // wrapper returned later reads the same table.
      if (
        target && target.type.kind === "func" &&
        canBoxFuncIntoDyn(target.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
      ) {
        target = { kind: "dynFrom", value: target, type: DYN, loc: locOf(call.arguments[0]!) };
      }
      if (target?.type.kind === "dyn") {
        const descs = L.lowerExprExpecting(call.arguments[1]!, DYN);
        if (descs.type.kind === "dyn") {
          return { kind: "libCall", fn: "dyn.defineProps", args: [target, descs], type: DYN, loc: locOf(call) };
        }
      }
      return null;
    }
    // Object.freeze: on a FRESH literal (object or array) the result IS
    // the argument — no alias exists, so the frozen bit is unobservable
    // (writes through the Readonly<T> result are compile errors, and no
    // other reference can write). Primitives pass through per ES2015.
    // Aliased objects keep a fence: a later write through the original
    // reference would need the runtime frozen bit (strict mode throws).
    if (member === "freeze") {
      if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
        L.noLowering(`Object.freeze with ${call.arguments.length} arguments`, call);
      }
      const argNode = call.arguments[0]!;
      let inner: ts.Expression = argNode;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner)) inner = inner.expression;
      const value = L.lowerExpr(argNode);
      if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
        return value; // fresh — freeze is identity here, honestly
      }
      if (
        value.type.kind === "string" || value.type.kind === "f64" ||
        value.type.kind === "bool" || value.type.kind === "symbol" ||
        isUnitType(value.type)
      ) {
        return value; // ES2015: freeze of a primitive is the primitive
      }
      L.noLowering(
        "Object.freeze of a possibly-aliased value",
        call,
        "freeze of a FRESH object/array literal (and of primitives) compiles — frozen-ness is unobservable there; an aliased target's later writes would need the runtime frozen bit",
      );
    }
    // `Object.hasOwn(r, k)` over a RECORD receiver: a record's own-key set
    // is its declared field list, so membership is a compare chain against
    // the field names (interned per shape). Undefined-armed (optional)
    // fields answer by their runtime tag — the explicit-undefined-is-absent
    // stance: an omitted optional field holds the undefined arm and reads
    // as NOT own, exactly Node's absent key (an EXPLICIT `k: undefined`
    // diverges — documented next to the child-env/JSON rule). Tuple,
    // index-signature (overflow membership lives in the runtime map), and
    // accessor-carrying shapes keep the SC2020 fence; non-record receivers
    // do too.
    if (member === "hasOwn" && call.arguments.length === 2 && !call.arguments.some((a) => ts.isSpreadElement(a))) {
      const recvNode = call.arguments[0]!;
      const keyNode = call.arguments[1]!;
      const probed = probeLower(L, recvNode);
      // A CHECKED-DYNAMIC receiver (the JS file-scope object-literal
      // identity story): the runtime dyn probe — OBJ member presence, ARR
      // index bounds, Node's ToObject TypeError on nullish.
      if (probed?.type.kind === "dyn") {
        const loc = locOf(call);
        const receiver = L.lowerExpr(recvNode);
        let key = L.lowerExpr(keyNode);
        if (key.type.kind === "f64" || key.type.kind === "bool" || key.type.kind === "dyn") {
          key = { kind: "toString", operand: key, type: STRING, loc: locOf(keyNode) };
        }
        if (key.type.kind !== "string") return null;
        return { kind: "libCall", fn: "dyn.hasOwn", args: [receiver, key], type: BOOL, loc };
      }
      if (probed?.type.kind !== "record") return null;
      const shape = L.shapes.get(probed.type.shapeId);
      if (!shape || shape.tuple || shape.indexValue || shapeHasAccessorSlots(shape)) return null;
      const loc = locOf(call);
      const receiver = L.lowerExpr(recvNode);
      if (receiver.type.kind !== "record") return null; // probe/lower drift: keep the fence
      let key = L.lowerExpr(keyNode);
      // Number/boolean/dyn keys stringify — ToPropertyKey, the keyed-write
      // path's rule; symbol and composite keys keep the fence.
      if (key.type.kind === "f64" || key.type.kind === "bool" || key.type.kind === "dyn") {
        key = { kind: "toString", operand: key, type: STRING, loc: locOf(keyNode) };
      }
      if (key.type.kind !== "string") return null;
      const helper = recordHasOwnHelper(L, receiver.type.shapeId, loc);
      return { kind: "call", callee: helper, args: [receiver, key], type: BOOL, loc };
    }
    if (member !== "keys" && member !== "values" && member !== "entries") return null;
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return null;
    const argNode = call.arguments[0]!;
    // A CHECKED-DYNAMIC argument — the checker may still spell a record
    // type (the JS file-scope object-literal identity story stores the
    // dyn object), so the LOWERED value's kind is the dispatch: the
    // runtime walks the dyn node's own keys (integer-like keys first,
    // JS's own-key order) and answers a dyn array.
    {
      const probed = probeLower(L, argNode);
      const isDyn = probed?.type.kind === "dyn";
      // Unit-typed arguments (Object.keys(null)) ride the same runtime
      // walk: it throws Node's catchable TypeError.
      const isUnit = probed !== null && probed !== undefined && isUnitType(probed.type);
      if (isDyn || isUnit) {
        const fn = member === "keys" ? "dyn.objKeys" : member === "values" ? "dyn.objValues" : "dyn.objEntries";
        let v = L.lowerExpr(argNode);
        if (v.type.kind !== "dyn") v = { kind: "dynFrom", value: v, type: DYN, loc: locOf(call) };
        return { kind: "libCall", fn, args: [v], type: DYN, loc: locOf(call) };
      }
    }
    let argIr = L.mapTypeOf(L.typeOf(argNode));
    // JS: an unmappable CHECKER type over a value that lowered to a real
    // record (the narrowed export-table literal) — the lowered value's
    // shape is the honest dispatch key, exactly the identity-Set stance.
    if (argIr === null && isJsSourceFile(argNode.getSourceFile())) {
      const probed = probeLower(L, argNode);
      if (probed?.type.kind === "record") argIr = probed.type;
    }
    if (argIr?.kind !== "record") return null; // Maps, classes, arrays → the SC2020 fence
    const shape = L.shapes.get(argIr.shapeId);
    if (!shape || shape.tuple) return null; // tuple → the fence
    // Accessor-carrying shapes: Node's answer includes the accessor NAMES
    // (own enumerable properties) and — for values/entries — the getter
    // RESULTS, invoked in key order. The static field walk models neither
    // (accessor slots live outside declaredOrder), so the surface fences.
    if (shapeHasAccessorSlots(shape)) {
      L.unsupported(
        "SC1090",
        call,
        `Object.${member} over a shape carrying get/set accessor properties (Node lists the accessor names${member === "keys" ? "" : " and invokes the getters"} — the static key walk cannot; read the properties explicitly)`,
      );
    }
    if (shape.indexValue) {
      // Index-signature (overflow-carrying) shapes: the runtime walk —
      // declared fields first, then the overflow in JS own-key order
      // (lowerObjectIterOverIndexShape in lower-containers).
      return lowerObjectIterOverIndexShape(L, call, member, argIr, shape);
    }
    const loc = locOf(call);
    const resultT = L.irTypeOf(call);
    if (resultT.kind !== "array") L.badType(call, L.typeOf(call)); // defensive
    const receiver = L.lowerExpr(argNode);
    if (member === "keys") {
      // The keys walk is shared with for-in (which iterates exactly the
      // keys Object.keys answers — one construction, one intern key).
      return recordKeysArrayCall(L, receiver, argIr, shape, loc);
    }

    // The result-element type each field's value flows into: string for
    // keys, the checker's value union for values, the [string, V] tuple's
    // "1" field for entries.
    let valueT: IrType | null = null;
    let tupleT: (IrType & { kind: "record" }) | null = null;
    if (member === "values") valueT = resultT.elem;
    if (member === "entries") {
      if (resultT.elem.kind !== "record") L.badType(call, L.typeOf(call));
      tupleT = resultT.elem;
      const tupleShape = L.shapes.get(resultT.elem.shapeId);
      if (!tupleShape?.tuple || tupleShape.fields.length !== 2) L.badType(call, L.typeOf(call));
      valueT = tupleShape.fields.find((f) => f.name === "1")!.type;
    }

    const key = `obj.${member}:${argIr.shapeId}:${typeKey(resultT)}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.${member}.${L.arrHofHelpers.size}`;
      const recT = argIr;
      const ref: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
      const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: resultT, loc };
      L.arrHofHelpers.set(key, helper);
      const fn: IrFunction = {
        name: helper,
        params: [{ localId: "r.0", name: "r", type: recT }],
        returnType: resultT,
        locals: [
          { id: "r.0", name: "r", type: recT, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
        ],
        body: [],
        loc,
      };
      const finalize = (): void => {
        const current = L.shapes.get(argIr.shapeId) ?? shape;
        const body: IrStmt[] = [
          { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: resultT, loc }, loc },
        ];
        const order = current.declaredOrder ?? current.fields.map((f) => f.name);
        for (const name of order) {
          const f = current.fields.find((x) => x.name === name)!;
          const raw: IrExpr = { kind: "recordGet", obj: ref, shapeId: argIr.shapeId, field: f.name, type: f.type, loc };
          // The pushed element per member; null when the field's value
          // cannot flow into the result element type.
          const elemOf = (value: IrExpr, vt: IrType): IrExpr | null => {
            if (!valueT) return null;
            if (typeEquals(vt, valueT)) return value;
            if (valueT.kind === "union" && vt.kind !== "union") {
              const tag = L.armTag(valueT.unionId, vt);
              if (tag >= 0) {
                return { kind: "unionWrap", unionId: valueT.unionId, tag, value, type: valueT, loc };
              }
            }
            return null;
          };
          // Undefined-armed fields: the push is guarded by a tag test, and
          // the pushed value is the narrowed non-undefined arm.
          let guardUndefTag: number | null = null;
          let value: IrExpr = raw;
          let vt: IrType = f.type;
          if (f.type.kind === "union") {
            const undefTag = L.armTag(f.type.unionId, UNDEFINED_T);
            if (undefTag >= 0) {
              guardUndefTag = undefTag;
              const arms = L.unions.get(f.type.unionId)?.arms ?? [];
              const others = arms.filter((a) => a.kind !== "undefinedT");
              if (typeEquals(f.type, valueT ?? f.type)) {
              // The field union IS the result union (single-field shapes):
              // push the raw box — but then the undefined skip must NOT
              // narrow. Handled below via vt === valueT.
                value = raw;
                vt = f.type;
              } else if (others.length === 1) {
                vt = others[0]!;
              // A UNIT other arm (`null | undefined` fields — the mixed-
              // defaults spread idiom; undefined was filtered above, so
              // the unit is null): units carry no payload, so the guarded
              // push writes the unit LITERAL — unionNarrow to a unit arm
              // (and unionWrap of a narrowed unit) is malformed IR; the
              // literal is the one legal unit spelling.
                value = isUnitType(vt)
                  ? { kind: "unitLit", unit: "null", type: vt, loc }
                  : { kind: "unionNarrow", unionId: f.type.unionId, tag: L.armTag(f.type.unionId, vt), value: raw, type: vt, loc };
              } else {
                L.unsupported(
                  "SC1090",
                  call,
                  `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' is a multi-arm union that ` +
                    "cannot re-tag into the result element type — read the fields directly)",
                );
              }
            } else if (!typeEquals(f.type, valueT ?? f.type)) {
              L.unsupported(
                "SC1090",
                call,
                `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' is a union that cannot ` +
                  "re-tag into the result element type — read the fields directly)",
              );
            }
          }
          const coerced = elemOf(value, vt);
          if (!coerced) {
            L.unsupported(
              "SC1090",
              call,
              `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' of type '${L.fmt(f.type)}' ` +
                `cannot flow into the '${L.fmt(valueT!)}' result element — read the fields directly)`,
            );
          }
          const pushed: IrExpr =
            member === "values"
              ? coerced
              : {
                  kind: "recordLit",
                  fields: [
                    { name: "0", value: { kind: "strLit", value: f.name, type: STRING, loc } },
                    { name: "1", value: coerced },
                  ],
                  type: tupleT!,
                  loc,
                };
          const pushStmt: IrStmt = {
            kind: "exprStmt",
            expr: { kind: "arrIntrinsic", method: "push", receiver: outRef, args: [pushed], type: F64, loc },
            loc,
          };
          body.push(
            guardUndefTag !== null && f.type.kind === "union"
              ? {
                  kind: "if",
                  cond: { kind: "unionIsTag", unionId: f.type.unionId, tag: guardUndefTag, negated: true, value: raw, type: BOOL, loc },
                  then: [pushStmt],
                  else_: null,
                  loc,
                }
              : pushStmt,
          );
        }
        body.push({ kind: "return", value: outRef, loc });
        fn.body = body;
      };
      finalize();
      L.shapeOrderHelperFinalizers.push(finalize);
      L.liftedFns.push(fn);
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }

/** The declaration's real Block body. tsgo's remote child indexing can hand
 * back a jsdoc node as `.body` — a JS `function f() {...}` annotated
 * `@type {() => undefined}` answers the jsdoc FUNCTION TYPE node (the
 * 09-lower-stmts-undefined crash signature) while the actual Block sits
 * elsewhere in the children — so recover it by kind, never by slot. Null
 * when the declaration truly has no block. */
function blockBodyOf(decl: ts.FunctionLikeDeclaration): ts.Block | null {
  const body = decl.body;
  if (body === undefined) return null;
  if (ts.isBlock(body)) return body;
  return decl.forEachChild((c) => (ts.isBlock(c) ? c : undefined)) ?? null;
}

export function lowerFunction(L: Lowerer, decl: ts.FunctionDeclaration): IrFunction | null {
    // Overload signatures and ambient declarations are type-world: they
    // share the implementation's symbol (when one exists) but have no body
    // of their own — collection skipped them and the run/discover loops do
    // too; this guard is defensive.
    if (!decl.body) return null;
    const declSymbol = declSymbolOf(L, decl);
    const sig = declSymbol ? L.fnSigsBySymbol.get(declSymbol) : undefined;
    if (!sig) return null; // signature collection failed

    const bodyReturn = sig.generator !== undefined
      ? L.genBodyReturnType(sig.returnType)
      : L.bodyReturnType(sig.isAsync === true, sig.returnType);
    const ctx = newFnCtx(false, null, null, bodyReturn);
    ctx.isAsync = sig.isAsync === true;
    if (sig.generator !== undefined) ctx.generator = sig.generator;
    const diagsBefore = L.diags.length;
    L.fnStack.push(ctx);
    try {
      const { params, prologue } = L.declareParams(decl.parameters, sig.params);
      // The synthetic `arguments` slot (a dynRest shape BEYOND the declared
      // parameters — collectSignatureInner appended it): one trailing
      // dyn-array param, resolved by `arguments` reads.
      if (sig.params.length > decl.parameters.length && sig.params[sig.params.length - 1]!.mode === "dynRest") {
        const argsLocal = L.declareHiddenLocal("%arguments", DYN);
        params.push({ localId: argsLocal.id, name: "%arguments", type: DYN });
        ctx.argumentsLocal = argsLocal;
      }
      const bodyBlock = blockBodyOf(decl);
      if (!bodyBlock) {
        L.unsupported("SC1090", decl, "function declarations whose block body the frontend cannot locate");
      }
      const body = [...prologue, ...L.lowerStmts(bodyBlock.statements)];
      appendImplicitUndefinedReturn(L, body, bodyReturn, locOf(decl));
      const fn: IrFunction = {
        name: sig.name,
        params,
        returnType: bodyReturn,
        locals: L.ctx.locals,
        body,
        loc: locOf(decl),
      };
      if (sig.isAsync) fn.async = true;
      if (sig.generator !== undefined) fn.generator = sig.generator;
      return fn;
    } catch (e) {
      // A poison OUTSIDE the per-statement catches (a parameter DEFAULT
      // whose initializer is fenced, a parameter PATTERN over a class
      // that never lowered): the diagnostic is already recorded — the
      // function skips, like a signature-blocked one, instead of killing
      // the whole analysis.
      if (!(e instanceof PoisonError)) throw e;
      // JS sources defer function-level poisons like statement fences
      // (the sentence-walker idiom `({ parent: sentenceNode })` over the
      // #private-fenced AstPath): the function compiles as its OWN
      // runtimeFence — CALLING it throws the first captured diagnostic
      // at the declaration's position — so a reachable-but-broken
      // signature stops the RUN at its own site instead of the build.
      // ICEs (SC9001) stay compile errors, exactly like lowerStmts.
      if (
        isJsSourceFile(decl.getSourceFile()) &&
        L.diagSink === null &&
        L.diags.length > diagsBefore &&
        !L.diags.slice(diagsBefore).some((d) => d.code === "SC9001")
      ) {
        const captured = L.diags.splice(diagsBefore);
        L.runtimeFences.push(...captured);
        // An ABI type naming a class that never REGISTERED (the sentence-
        // walker idiom's path type — the #private fence) is fine to emit:
        // callers CAN lower calls to this symbol (a same-typed param
        // passes straight through — no construction needed), so the fence
        // function must exist, and run()'s unregistered-class sweep
        // rewrites every such slot to the inert f64 placeholder before
        // emission — caller and fence stay ABI-consistent.
        const first = captured[0]!;
        const loc = locOf(decl);
        const pos = ts.getLineAndCharacterOfPosition(
          L.program.getSourceFile(first.loc.file) ?? decl.getSourceFile(),
          first.loc.start,
        );
        const params: IrParam[] = sig.params.map((p, i) => ({ localId: `%pf${i}`, name: `%pf${i}`, type: p.type }));
        const fn: IrFunction = {
          name: sig.name,
          params,
          returnType: bodyReturn,
          locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
          body: [
            {
              kind: "runtimeFence",
              code: first.code,
              message: `${first.message} [${first.code} at ${first.loc.file}:${pos.line + 1}]`,
              loc,
            },
          ],
          loc,
        };
        if (sig.isAsync) fn.async = true;
        if (sig.generator !== undefined) fn.generator = sig.generator;
        return fn;
      }
      return null;
    } finally {
      L.fnStack.pop();
    }
  }

/** `r.f(args)` where `r` is a record and `f` a func-typed field: an
   * ordinary indirect call through the field's closure value. Deliberately
   * record-only — calling a func-typed CLASS field stays rejected (the
   * generic method-call rejection in lowerCall). */
/** `Object.assign(fn, { bold, ... })` → a HYBRID record literal: the
   * reserved %call field takes the function, each source object literal's
   * properties fill their declared fields (later sources override, JS's
   * last-write-wins — one entry per name, source values still evaluate in
   * order through the literal lowering's shared rules). Bounded to the
   * chalk shape on purpose: the RESULT type must map to a %call-carrying
   * record, sources must be plain object literals (an `as` cast unwraps),
   * and every declared field must be filled. REPRESENTATION NOTE
   * (SEMANTICS.md): the result is a FRESH record, not the mutated `fn` —
   * `assigned === fn` is false here where JS answers true, and `typeof`
   * would answer object; portless's colors.ts never observes either.
   * Null (→ the stdlib fence) for every other Object.assign form. */
  function lowerObjectAssignHybrid(L: Lowerer, call: ts.CallExpression): IrExpr | null {
    const mapped = L.mapTypeOf(L.typeOf(call));
    if (mapped?.kind !== "record") return null;
    const shape = L.shapes.get(mapped.shapeId);
    const callField = shape?.fields.find((f) => f.name === "%call");
    if (!shape || !callField || callField.type.kind !== "func") return null;
    if (call.arguments.length < 2 || call.arguments.some((a) => ts.isSpreadElement(a))) return null;
    const loc = locOf(call);
    const values = new Map<string, IrExpr>();
    values.set("%call", L.lowerExprExpecting(call.arguments[0]!, callField.type));
    for (const argNode of call.arguments.slice(1)) {
      let src: ts.Expression = argNode;
      while (ts.isParenthesizedExpression(src) || ts.isAsExpression(src) || ts.isTypeAssertion(src)) src = src.expression;
      if (!ts.isObjectLiteralExpression(src)) {
        L.unsupported(
          "SC1090",
          argNode,
          "Object.assign sources other than plain object literals when building a function-with-properties value",
        );
      }
      for (const prop of src.properties) {
        const nameOk =
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name));
        if (!nameOk) {
          L.unsupported(
            "SC1090",
            prop,
            "this property form in an Object.assign source building a function-with-properties value",
          );
        }
        const name = (prop.name as ts.Identifier | ts.StringLiteral).text;
        const fieldType = shape.fields.find((f) => f.name === name)?.type;
        if (!fieldType) {
          L.unsupported(
            "SC1090",
            prop,
            `the property '${name}' missing from the assigned result type '${L.fmt(mapped)}'`,
          );
        }
        const value = ts.isPropertyAssignment(prop)
          ? L.lowerExprExpecting(prop.initializer, fieldType)
          : L.coerceInto(prop, L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment), fieldType);
        values.set(name, value);
      }
    }
    const fields: { name: string; value: IrExpr }[] = [];
    for (const f of shape.fields) {
      const v = values.get(f.name);
      if (!v) {
        const absent = L.wrappedUndefined(f.type, loc);
        if (!absent) {
          L.unsupported(
            "SC1090",
            call,
            `Object.assign leaving the required field '${f.name}' of '${L.fmt(mapped)}' unfilled`,
          );
        }
        fields.push({ name: f.name, value: absent });
        continue;
      }
      fields.push({ name: f.name, value: v });
    }
    return { kind: "recordLit", fields, type: mapped, loc };
  }

  export function lowerRecordFieldCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(call)) return null;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "record") return null;
    const target = L.fieldTarget(access);
    let callee = target ? L.fieldGetExpr(target, locOf(access), access) : null;
    if (!callee) return null;
    // A HYBRID (function-with-properties) field is callable through its
    // reserved %call slot — `colors.blue("x")` where blue also carries
    // `.bold` (the chalk shape).
    if (callee.type.kind === "record") callee = L.hybridCallUnwrap(callee);
    if (callee.type.kind !== "func") L.badType(access, L.typeOf(access));
    const params = callee.type.params;
    const args = call.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
    return { kind: "callValue", callee, args, type: callee.type.ret, loc: locOf(call) };
  }

/** The function-like node behind an object-literal generic-method member:
   * the MethodDeclaration itself (`{ m<T>(x: T) {...} }`) or a generic
   * arrow/function-expression property's initializer (`{ m: <T>(x: T) =>
   * ... }`). Null when the property's declaration isn't that shape. */
  export function objLitGenericFnNodeOf(L: Lowerer, propSym: ts.Symbol): { fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction; literal: ts.ObjectLiteralExpression } | null {
    const decl = L.checker.valueDeclarationOf(propSym);
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
        init.typeParameters !== undefined && init.body !== undefined
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
  export function objLitGenericFnInfoOf(L: Lowerer, blame: ts.Node, name: string,
    found: { fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction; literal: ts.ObjectLiteralExpression },): GenericFnInfo {
    const { fnNode, literal } = found;
    const existing = L.objLitGenericFns.get(fnNode);
    if (existing) return existing;
    if (fnNode.asteriskToken) L.unsupported("SC1071", blame);
    if (fnNode.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      L.unsupported("SC1090", blame, "async object-literal generic methods");
    }
    // `this` is the receiver object — records don't model it (the
    // lowerObjectLiteral fence, applied at registration because
    // arrow/function-expression properties skip that walk and the compiled
    // instances are plain module functions).
    if (fnNode.body) L.rejectThisInObjectMethod(fnNode.body);
    for (let n: ts.Node = literal.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isFunctionLike(n)) {
        L.unsupported(
          "SC1090",
          blame,
          `object-literal generic methods declared inside functions (the compiled instantiations of '${name}' are module functions and cannot capture the enclosing frame — declare the object at module scope)`,
        );
      }
    }
    const typeParams: ts.Symbol[] = [];
    for (const tp of fnNode.typeParameters!) {
      const sym = L.checker.getSymbolAtLocation(tp.name);
      if (!sym) L.unsupported("SC1090", blame, "this method form");
      typeParams.push(sym);
    }
    for (const param of fnNode.parameters) {
      if (!ts.isIdentifier(param.name)) L.unsupported("SC1031", param);
    }
    const info: GenericFnInfo = {
      decl: fnNode,
      baseName: name,
      qualifiedName: L.qualify(fnNode.getSourceFile(), `%ol${fnNode.getStart()}.${name}`),
      typeParams,
      instances: new Map(),
      objectLiteral: true,
    };
    L.objLitGenericFns.set(fnNode, info);
    return info;
  }

/** True when nothing in `sym`'s DECLARING FILE ever writes it after the
   * initializer: assignments (plain and compound, destructuring targets
   * included), ++/--, and for-of/for-in expression targets all count.
   * Sound file-locally for module-scope bindings because ESM import
   * bindings are read-only — no other file can write one. Cached per
   * symbol (the scan walks the whole file once). */
  export function bindingNeverReassigned(L: Lowerer, sym: ts.Symbol, decl: ts.Node): boolean {
    const cached = L.neverReassignedCache.get(sym);
    if (cached !== undefined) return cached;
    let written = false;
    // Text pre-check keeps the file walk cheap: only same-named
    // identifiers pay a symbol resolution.
    const symText = sym.name;
    const namesSym = (e: ts.Node): boolean =>
      ts.isIdentifier(e) && e.text === symText && L.resolveValueSymbol(e) === sym;
    const scanTarget = (t: ts.Expression): void => {
      let e: ts.Expression = t;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (namesSym(e)) {
        written = true;
        return;
      }
      // Destructuring assignment targets: any identifier inside the LHS
      // pattern could be the binding — over-approximate by scanning.
      if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
        const walk = (n: ts.Node): void => {
          if (namesSym(n)) written = true;
          else n.forEachChild(walk);
        };
        walk(e);
      }
    };
    const visit = (n: ts.Node): void => {
      if (written) return;
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
          scanTarget(n.left);
        }
      } else if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        scanTarget(n.operand as ts.Expression);
      } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
        scanTarget(n.initializer as ts.Expression);
      }
      n.forEachChild(visit);
    };
    decl.getSourceFile().forEachChild(visit);
    L.neverReassignedCache.set(sym, !written);
    return !written;
  }

/** Strips the value-preserving wrappers off an expression: parens,
   * non-null assertions, `as`/`satisfies`/angle-bracket casts. What
   * remains is the expression that actually evaluates. */
  export function stripValueWrappers(e: ts.Expression): ts.Expression {
    let v: ts.Expression = e;
    for (;;) {
      if (
        ts.isParenthesizedExpression(v) || ts.isNonNullExpression(v) ||
        ts.isAsExpression(v) || ts.isSatisfiesExpression(v) || ts.isTypeAssertion(v)
      ) {
        v = v.expression;
        continue;
      }
      return v;
    }
  }

/** The nullish unit `e` provably evaluates to: a bare null/undefined
   * literal (assertion-wrapped — `null as any`, `null!`), or a read of a
   * registered NULLISH binding (nullishGenericBindingUnitOf). Null when
   * the value could be anything else. */
  export function nullishExprUnitOf(L: Lowerer, e: ts.Expression): "null" | "undefined" | null {
    const v = stripValueWrappers(e);
    if (v.kind === ts.SyntaxKind.NullKeyword) return "null";
    if (ts.isIdentifier(v)) {
      if (v.text === "undefined" && (L.typeOf(v).flags & ts.TypeFlags.Undefined) !== 0) {
        return "undefined";
      }
      return nullishValueUnitOf(L, L.resolveValueSymbol(v));
    }
    return null;
  }

/** The nullish unit a binding provably holds FOREVER, by VALUE alone: its
   * initializer is nullish (`const i: I<A & B> = null as any`) and every
   * write in its declaring file is nullish too (`a = b` where b is
   * another nullish binding). No type condition — callers add their own
   * (nullishGenericBindingUnitOf gates the no-storage family on
   * unmappable types; the generic-method call path rescues its fence with
   * the value fact alone). Cached per symbol; the pre-seeded null entry
   * guards probe cycles (mutually-assigned bindings resolve link by link,
   * declaration order). */
  export function nullishValueUnitOf(L: Lowerer, sym: ts.Symbol | null): "null" | "undefined" | null {
    if (!sym) return null;
    const cached = L.nullishBindings.get(sym);
    if (cached !== undefined) return cached;
    L.nullishBindings.set(sym, null); // cycle guard: self-referential probes answer non-qualifying
    const decl = L.checker.valueDeclarationOf(sym);
    // Statement-position declarators only: a for-loop head (`for (let x =
    // null as any; ...)`) declares a LOCAL with per-iteration semantics —
    // lowerVarDeclList's contract requires a lowered statement for it, so
    // the no-storage family never claims it.
    if (
      !decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) ||
      decl.getSourceFile().isDeclarationFile || decl.initializer === undefined ||
      !ts.isVariableStatement(decl.parent.parent)
    ) {
      return null;
    }
    const unit = nullishExprUnitOf(L, decl.initializer);
    if (unit === null) return null;
    // Bindings with a CHECKED-DYNAMIC fallback (`const maybe: any =
    // undefined`, JS inference residue) keep that story: the dyn world
    // already holds null/undefined correctly and serves every read form
    // (optional chains included) — this family exists for types with NO
    // other home.
    if (dynFallbackType(L, decl.name, L.checker.getTypeOfSymbol(sym)) !== null) return null;
    if (!allWritesNullish(L, sym, decl)) return null;
    // A use inside a class HERITAGE clause (`class X extends Mixin(...)`)
    // declines the whole family: heritage resolution is structural (the
    // mixin machinery can pin the instantiation from the ARGUMENT class
    // expression without ever reading the callee binding), so a claimed
    // nullish callee would compile a working class where Node throws
    // "Mixin is not a function" evaluating the extends expression. The
    // declaration keeps its type fence instead.
    if (usedInHeritageClause(L, sym)) return null;
    L.nullishBindings.set(sym, unit);
    return unit;
  }

/** True when any identifier resolving to `sym` sits inside a class
   * heritage clause anywhere in the program. */
  function usedInHeritageClause(L: Lowerer, sym: ts.Symbol): boolean {
    const symText = sym.name;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (
        ts.isIdentifier(n) && n.text === symText &&
        L.resolveValueSymbol(n) === sym
      ) {
        for (let p: ts.Node | undefined = n.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
          if (ts.isHeritageClause(p)) {
            found = true;
            return;
          }
        }
        return;
      }
      n.forEachChild(visit);
    };
    for (const file of L.program.getSourceFiles()) {
      if (found) break;
      if (file.isDeclarationFile) continue;
      file.forEachChild(visit);
    }
    return found;
  }

/** nullishValueUnitOf gated on a declared type that CANNOT hold the
   * value — the NO-STORAGE family: an unmappable type has no other story,
   * and a RECORD-mapped one (`const i: I<A & B> = null as any` — an
   * interface whose members are all generic signatures interns an empty
   * shape) has a slot null can never inhabit, so storing would throw the
   * representation error where Node stores null silently. Either way the
   * declaration emits nothing and reads know the value. Null-tolerant
   * mappings (unions with a null/undefined arm, dyn) keep their real
   * storage and every ordinary lowering. */
  export function nullishGenericBindingUnitOf(L: Lowerer, sym: ts.Symbol | null): "null" | "undefined" | null {
    if (!sym) return null;
    // The VALUE probe first — it is purely syntactic, so no checker type
    // query runs for the overwhelmingly common non-nullish declarations
    // (a query can even panic upstream — the 1e999 checker bug).
    const unit = nullishValueUnitOf(L, sym);
    if (unit === null) return null;
    const mapped = L.mapTypeOf(L.checker.getTypeOfSymbol(sym));
    if (mapped !== null) {
      // Only the EMPTY interned shape qualifies among record mappings —
      // the all-generic-signature interface (`I<A & B>`) whose struct has
      // no slot at all. A record with DATA fields (`const value: { inner:
      // number | string } = null as any`) keeps its real storage and
      // every ordinary lowering: its reads flow through positions (comma
      // chains, call arguments) the no-storage read paths never claim,
      // so claiming the binding would fence working programs.
      if (mapped.kind !== "record") return null;
      const shape = L.shapes.get(mapped.shapeId);
      if (!shape || shape.fields.length > 0 || shape.tuple !== undefined || shape.indexValue !== undefined) {
        return null;
      }
    }
    return unit;
  }

/** True when every write of `sym` in its declaring file is a plain `x =
   * <nullish>` assignment — the discipline that keeps a nullish binding's
   * value knowable. Compound assignments, ++/--, for-in/of cursors, and
   * destructuring targets all disqualify. */
  function allWritesNullish(L: Lowerer, sym: ts.Symbol, decl: ts.Node): boolean {
    const symText = sym.name;
    const namesSym = (e: ts.Node): boolean =>
      ts.isIdentifier(e) && e.text === symText && L.resolveValueSymbol(e) === sym;
    let ok = true;
    const visit = (n: ts.Node): void => {
      if (!ok) return;
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
          let lhs: ts.Expression = n.left;
          while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
          if (namesSym(lhs)) {
            if (k !== ts.SyntaxKind.EqualsToken || nullishExprUnitOf(L, n.right) === null) ok = false;
          } else if (ts.isArrayLiteralExpression(lhs) || ts.isObjectLiteralExpression(lhs)) {
            const walk = (m: ts.Node): void => {
              if (namesSym(m)) ok = false;
              else m.forEachChild(walk);
            };
            walk(lhs);
          }
        }
      } else if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        let op: ts.Expression = n.operand as ts.Expression;
        while (ts.isParenthesizedExpression(op)) op = op.expression;
        if (namesSym(op)) ok = false;
      } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
        let t: ts.Node = n.initializer;
        while (ts.isParenthesizedExpression(t as ts.Expression)) t = (t as ts.ParenthesizedExpression).expression;
        if (namesSym(t)) ok = false;
      }
      n.forEachChild(visit);
    };
    decl.getSourceFile().forEachChild(visit);
    return ok;
  }

/** A VALUE-ONLY expression: materializing it has no observable effect
   * beyond the value itself — function/arrow literals, class-free
   * literals, nullish units. The dead-binding rule's purity test: Node
   * builds the value and drops it, so skipping the build entirely is
   * unobservable. Bare identifier reads stay OUT (a read above a `let`
   * declaration is a TDZ throw Node WOULD serve). */
  function sideEffectFreeValueExpr(L: Lowerer, e: ts.Expression): boolean {
    const v = stripValueWrappers(e);
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return true;
    if (ts.isLiteralExpression(v) || v.kind === ts.SyntaxKind.NullKeyword ||
        v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword) {
      return true;
    }
    if (ts.isIdentifier(v) && v.text === "undefined" && (L.typeOf(v).flags & ts.TypeFlags.Undefined) !== 0) {
      return true;
    }
    return false;
  }

/** True when `sym` — a binding whose type has NO static mapping — is DEAD:
   * never read anywhere in the program, not exported through a specifier,
   * declared with no initializer or a side-effect-free one, and written
   * (if at all) only by plain assignments of side-effect-free values. Node
   * materializes those values and drops them — zero observable effect —
   * so the declaration and its writes lower to NOTHING instead of fencing
   * on a type the program never consumes (`var xs2: typeof Array;`, the
   * write-only `var f2: { <T, U>(x: T, y: U): T }`). TS program files
   * only: JS bindings keep their checked-dynamic fallbacks. Positive
   * answers register in L.deadBindings (the assignment lowering skips
   * writes by the same set). */
  export function deadUnmappableBinding(L: Lowerer, sym: ts.Symbol | null, decl: ts.VariableDeclaration): boolean {
    if (!sym) return false;
    if (L.deadBindings.has(sym)) return true;
    if (!ts.isIdentifier(decl.name)) return false;
    // Statement-position declarators only: a for-loop head (`for (let x;
    // false;) {}`) declares a LOCAL with per-iteration semantics —
    // lowerVarDeclList's contract requires a lowered statement for it, so
    // the no-storage family never claims it (catch bindings sit outside a
    // variable statement too and stay out the same way).
    if (!ts.isVariableStatement(decl.parent.parent)) return false;
    const sf = decl.getSourceFile();
    if (sf.isDeclarationFile || isJsSourceFile(sf)) return false;
    if (decl.initializer !== undefined && !sideEffectFreeValueExpr(L, decl.initializer)) return false;
    // Exported bindings stay out: a library build's exports are consumed
    // from outside the graph, and export specifiers double as reads.
    if (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) return false;
    // The type gate LAST among the cheap checks: querying the checker for
    // a type is the expensive step (and can panic upstream — the 1e999
    // bug), so only survivors of the syntactic filters pay it. Mappable
    // types keep their real storage.
    if (L.mapTypeOf(L.checker.getTypeOfSymbol(sym)) !== null) return false;
    const symText = sym.name;
    const namesSym = (e: ts.Node): boolean =>
      ts.isIdentifier(e) && e.text === symText && L.resolveValueSymbol(e) === sym;
    let dead = true;
    const visit = (n: ts.Node): void => {
      if (!dead) return;
      if (ts.isIdentifier(n) && n.text === symText) {
        // Declaration-name occurrences are not reads.
        if (n.parent !== undefined && ts.isVariableDeclaration(n.parent) && n.parent.name === n) {
          n.forEachChild(visit);
          return;
        }
        // A plain-assignment LHS is a WRITE — dead only when the RHS
        // builds no observable effect (the value is dropped with the
        // binding).
        const p = n.parent;
        if (
          p !== undefined && ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === n
        ) {
          if (!namesSym(n)) return;
          if (!sideEffectFreeValueExpr(L, p.right)) dead = false;
          return;
        }
        // Import/export specifiers, and every other occurrence, count as
        // reads.
        if (namesSym(n)) dead = false;
        return;
      }
      n.forEachChild(visit);
    };
    for (const file of L.program.getSourceFiles()) {
      if (!dead) break;
      if (file.isDeclarationFile) continue;
      file.forEachChild(visit);
    }
    if (dead) L.deadBindings.add(sym);
    return dead;
  }

/** The generic function-like INITIALIZER behind a binding declaration —
   * `const f = <T>(x: T) => x` or `const f = function g<T>(x: T) {...}`
   * (parens stripped). Null when the declaration isn't that shape; the
   * SHAPE only — whether the binding qualifies (module scope, never
   * reassigned) is bindingGenericFnInfoOf's business. */
  export function bindingGenericFnNodeOf(decl: ts.VariableDeclaration): ts.FunctionExpression | ts.ArrowFunction | null {
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    // Assertion wrappers strip like parens: `const r = (<T>(x: T) => x) as
    // Mapper` evaluates the arrow — the cast only renames its type.
    const init = stripValueWrappers(decl.initializer);
    if (
      (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
      init.typeParameters !== undefined && init.body !== undefined
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
  export function bindingContextualGenericFnNodeOf(L: Lowerer, decl: ts.VariableDeclaration): ts.FunctionExpression | ts.ArrowFunction | null {
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    // The generic signature can arrive as an ANNOTATION or as a type
    // ASSERTION on the initializer (`var r = < <T>(x: T) => T >((x) => x)`
    // — the checker contextually types the operand's parameters by the
    // asserted signature exactly like an annotation would).
    const asserted =
      ts.isAsExpression(decl.initializer) || ts.isTypeAssertion(decl.initializer);
    if (decl.type === undefined && !asserted) return null;
    const init = stripValueWrappers(decl.initializer);
    if (
      !(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ||
      init.typeParameters !== undefined || init.body === undefined
    ) {
      return null;
    }
    const sigs = L.checker.getCallSignatures(L.typeOf(decl.name));
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
  export function bindingGenericFnInfoOf(L: Lowerer, decl: ts.VariableDeclaration,
    fnNode: ts.FunctionExpression | ts.ArrowFunction,): GenericFnInfo {
    const existing = L.bindingGenericFns.get(fnNode);
    if (existing) return existing;
    const name = (decl.name as ts.Identifier).text;
    if (fnNode.asteriskToken) L.unsupported("SC1071", fnNode);
    for (let n: ts.Node = decl.parent; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isFunctionLike(n)) {
        L.unsupported(
          "SC1090",
          fnNode,
          `generic arrow/function-expression bindings declared inside functions (the compiled instantiations of '${name}' are module functions and cannot capture the enclosing frame — declare the binding at module scope)`,
        );
      }
    }
    const sym = L.checker.getSymbolAtLocation(decl.name);
    if (!sym) L.unsupported("SC1090", decl.name, "this binding form");
    const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
    // Merged `var` redeclarations (`var f = <T>...; var f = ...`) are one
    // symbol with several initializers — writes the assignment scan never
    // sees; they fence exactly like a reassignment.
    const redeclared = L.checker
      .declarationsOf(sym)
      .some((d) => d !== decl && ts.isVariableDeclaration(d) && d.initializer !== undefined);
    if (!isConst && (redeclared || !bindingNeverReassigned(L, sym, decl))) {
      L.unsupported(
        "SC1090",
        decl.name,
        `generic function values in reassigned bindings (calls of '${name}' resolve statically against this initializer, so the binding must provably hold it — a const, or a let/var nothing in its declaring file writes)`,
      );
    }
    const typeParams: ts.Symbol[] = [];
    if (fnNode.typeParameters !== undefined) {
      for (const tp of fnNode.typeParameters) {
        const tpSym = L.checker.getSymbolAtLocation(tp.name);
        if (!tpSym) L.unsupported("SC1090", fnNode, "this function form");
        typeParams.push(tpSym);
      }
    } else {
      // The CONTEXTUAL shape (bindingContextualGenericFnNodeOf): the type
      // parameters live on the annotation's one call signature, and the
      // checker types the initializer's parameters by them — the same
      // symbols the instance bodies resolve through.
      const sigs = L.checker.getCallSignatures(L.typeOf(decl.name));
      const tps = sigs.length === 1 ? sigs[0]!.getTypeParameters() : [];
      if (tps.length === 0) L.unsupported("SC1090", fnNode, "this function form");
      for (const tp of tps) {
        const tpSym: ts.Symbol | undefined = tp.getSymbol();
        if (!tpSym) L.unsupported("SC1090", fnNode, "this function form");
        typeParams.push(tpSym);
      }
    }
    // Only NAME syntax is checkable here; optional/default/rest shapes are
    // computed per instantiation from the resolved signature — exactly
    // collectGenericSignature's rule, binding patterns included.
    for (const param of fnNode.parameters) {
      if (!ts.isIdentifier(param.name) && !ts.isObjectBindingPattern(param.name) && !ts.isArrayBindingPattern(param.name)) {
        L.unsupported("SC1031", param);
      }
    }
    const stmt = decl.parent.parent; // declarator → list → statement (nsPathPrefix wants the statement)
    const info: GenericFnInfo = {
      decl: fnNode,
      baseName: name,
      qualifiedName: L.qualify(decl.getSourceFile(), nsPathPrefix(stmt, decl) + name),
      typeParams,
      instances: new Map(),
    };
    L.bindingGenericFns.set(fnNode, info);
    L.genericFnsBySymbol.set(sym, info);
    if (ts.isFunctionExpression(fnNode) && fnNode.name !== undefined) {
      const inner = L.checker.getSymbolAtLocation(fnNode.name);
      if (inner) L.genericFnsBySymbol.set(inner, info);
    }
    return info;
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
  export function bindingGenericFnAliasInfoOf(L: Lowerer, decl: ts.VariableDeclaration): GenericFnInfo | null {
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (!ts.isIdentifier(init)) return null;
    const target = genericFnOf(L, init);
    if (!target) return null;
    // A concrete annotation pins one signature — that value story
    // (lowerGenericFnValue at the reference) stays untouched.
    const ownSigs = L.checker.getCallSignatures(L.typeOf(decl.name));
    if (ownSigs.length === 0 || !ownSigs.every((s) => s.getTypeParameters().length > 0)) return null;
    const sym = L.checker.getSymbolAtLocation(decl.name);
    if (!sym) return null;
    const existing = L.genericFnsBySymbol.get(sym);
    if (existing) return existing;
    const name = decl.name.text;
    const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
    // The same holds-it-forever discipline as generic arrow bindings:
    // calls through the alias resolve statically against the target, so
    // nothing may ever rebind it (merged `var` redeclarations included).
    const redeclared = L.checker
      .declarationsOf(sym)
      .some((d) => d !== decl && ts.isVariableDeclaration(d) && d.initializer !== undefined);
    if (!isConst && (redeclared || !bindingNeverReassigned(L, sym, decl))) {
      L.unsupported(
        "SC1090",
        decl.name,
        `generic function values in reassigned bindings (calls of '${name}' resolve statically against this initializer, so the binding must provably hold it — a const, or a let/var nothing in its declaring file writes)`,
      );
    }
    L.genericFnsBySymbol.set(sym, target);
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
   * resolution would silently miss. */
  export function requireObjLitGenericReceiver(L: Lowerer, blame: ts.Node, recvExpr: ts.Expression,
    literal: ts.ObjectLiteralExpression, name: string,): void {
    let recv: ts.Expression = recvExpr;
    while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
    const fenceReceiver: () => never = () =>
      L.unsupported(
        "SC1090",
        blame,
        `reaching the object-literal generic method '${name}' through this receiver (resolution is static, so the receiver must be a never-reassigned binding initialized with the defining literal)`,
      );
    if (!ts.isIdentifier(recv)) fenceReceiver();
    const recvSym = L.resolveValueSymbol(recv);
    const recvDecl = recvSym ? L.checker.valueDeclarationOf(recvSym) : undefined;
    if (
      !recvDecl || !ts.isVariableDeclaration(recvDecl) ||
      !ts.isVariableDeclarationList(recvDecl.parent) ||
      recvDecl.initializer === undefined
    ) {
      fenceReceiver();
    }
    if (
      (recvDecl.parent.flags & ts.NodeFlags.Const) === 0 &&
      !bindingNeverReassigned(L, recvSym!, recvDecl)
    ) {
      fenceReceiver();
    }
    let init: ts.Expression = recvDecl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (init !== literal) fenceReceiver();
  }

/** `o.m(args)` where `m` is an object-literal GENERIC method (own type
   * parameters — the member is excluded from the record shape, see
   * isGenericCallableMemberType): monomorphized per call site against the
   * DEFINING literal's declaration, exactly like top-level generic
   * functions. Resolution is static, so the receiver must provably BE the
   * defining literal: a const binding whose initializer is that literal,
   * read directly. The receiver read is pure and the compiled instance is
   * a plain module function (no `this`, fenced), so the call lowers to a
   * direct `call` of the instance with the receiver unevaluated. Claims
   * every call whose member is generic-callable — lowering it or fencing
   * with a named message. */
  /** URL.revokeObjectURL() with NO argument: Node's ERR_MISSING_ARGS
   * throws before the registry lookup, so the zero-argument contract is
   * exact without any blob machinery. The one-argument form (Node's
   * silent no-op for unregistered ids) and createObjectURL keep their
   * fences — a compiled program has no blob registry to consult. */
  function lowerUrlStaticCall(L: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
    if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "URL") return null;
    if (callee.name.text !== "revokeObjectURL" || call.arguments.length !== 0) return null;
    const sym = L.resolveValueSymbol(callee.expression);
    if (!sym || !L.isStdlibSymbol(sym)) return null;
    return nodeThrowExpr(1, "ERR_MISSING_ARGS", 'The "url" argument must be specified', VOID, locOf(call));
  }

  const SP_BRAND_METHODS = new Set([
    "append", "delete", "get", "getAll", "has", "set", "sort",
    "forEach", "keys", "values", "entries", "toString",
  ]);

  export function lowerObjLitGenericMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    // URLSearchParams method values through Function.prototype.call/apply
    // with a receiver that is provably NOT a URLSearchParams (the suite's
    // `params.append.call(undefined)` probes): the WHATWG brand check
    // throws ERR_INVALID_THIS before any argument conversion — the whole
    // call IS that throw. A receiver that IS searchParams-typed, or one
    // whose runtime kind is unknowable (dyn/'any'), keeps the fence.
    if (
      (name === "call" || name === "apply") &&
      ts.isPropertyAccessExpression(access.expression) &&
      L.mapTypeOf(L.typeOf(access.expression.expression))?.kind === "searchParams" &&
      SP_BRAND_METHODS.has(access.expression.name.text) &&
      L.isStdlibMember(access.expression)
    ) {
      const thisArg = call.arguments[0];
      const thisT = thisArg ? L.mapTypeOf(L.typeOf(thisArg)) : { kind: "undefinedT" as const };
      const provablyNot =
        thisT !== null &&
        thisT.kind !== "searchParams" &&
        thisT.kind !== "dyn" &&
        thisT.kind !== "jsval" &&
        (!thisArg || ts.isIdentifier(thisArg) || ts.isLiteralExpression(thisArg) ||
          thisArg.kind === ts.SyntaxKind.UndefinedKeyword ||
          thisArg.kind === ts.SyntaxKind.NullKeyword ||
          isUnitType(thisT));
      if (provablyNot) {
        return nodeThrowExpr(
          1,
          "ERR_INVALID_THIS",
          'Value of "this" must be of type URLSearchParams',
          L.mapTypeOf(L.typeOf(call)) ?? VOID,
          locOf(call),
        );
      }
    }
    const recvT = L.typeOf(access.expression);
    const propSym = L.checker.getPropertyOfType(recvT, name);
    if (!propSym) return null;
    if (!isGenericCallableMemberType(L.checker.getTypeOfSymbol(propSym), L.checker)) return null;
    // CLASS members belong to the class path (lowerClassGenericMethodCall
    // claimed compilable ones; a class that failed collection keeps its
    // own diagnostics and the generic method-call fence downstream).
    if (
      L.checker.declarationsOf(propSym).some(
        (d) => d.parent !== undefined && (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)),
      )
    ) {
      return null;
    }
    // An INTERFACE-typed receiver over a class instance (`const r: Repo =
    // new MemRepo(); r.get(...)` — the declaration is signature-only, but
    // the receiver's exact class is statically proven and the binding
    // kept the class representation, genericIfaceBindingKeepsClass): the
    // call is a class generic-method call on that exact class. The
    // receiver must LOWER as the class — a record-held value (a `let`, a
    // produced value, a parameter) has already dropped it, and keeps the
    // named fence below.
    {
      const exact = exactInstanceClassOf(L, access.expression);
      const gfound = exact ? findGenericMethodOn(L, exact, name) : null;
      if (gfound && ts.isIdentifier(access.expression)) {
        const recv = L.lowerExpr(access.expression); // identifier reads are pure — no double evaluation
        if (recv.type.kind === "object") {
          return lowerClassGenericMethodCall(L, call, access, exact!, gfound, recv);
        }
      }
    }
    const found = objLitGenericFnNodeOf(L, propSym);
    if (!found) {
      // Function.prototype.apply/call/bind spelled through a FUNCTION
      // receiver: compiled functions are direct calls with no runtime
      // `this`/arguments object to re-route — name the working spelling
      // instead of a class-receiver hint (or an SC2020 recitation) no
      // function value can follow. Before the stdlib decline: these ARE
      // stdlib members (CallableFunction), but the pointed message is
      // the honest one.
      if (
        (name === "apply" || name === "call" || name === "bind") &&
        L.checker.getCallSignatures(recvT).length > 0
      ) {
        L.unsupported(
          "SC1090",
          call,
          `Function.prototype.${name} on a compiled function value (compiled calls are direct — no runtime 'this' or arguments object exists to re-route; spell the call directly: '${access.expression.getText()}(...)')`,
        );
      }
      // STANDARD-LIBRARY generic members (Promise.then, Object.
      // defineProperty, Array-augmentation methods) are the lib fence's
      // story (SC2020, naming the member) — decline so the stdlib
      // chokepoint downstream reports, instead of an interface-dispatch
      // recitation about a receiver no user constructed.
      if (L.isStdlibMember(access)) return null;
      // Interface-declared generic methods dispatch statically, so the
      // receiver's runtime class must be provable — name that discipline
      // instead of the object-literal wording when the method lives on an
      // interface.
      const onInterface = L.checker
        .declarationsOf(propSym)
        .some((d) => d.parent !== undefined && ts.isInterfaceDeclaration(d.parent));
      if (onInterface) {
        L.unsupported(
          "SC1090",
          call,
          `calls of the generic method '${name}' through this receiver (the interface declaration is signature-only and generic methods dispatch statically, so the receiver's runtime class must be provable — bind the receiver to a const initialized with its 'new' expression, e.g. 'const r: ${L.checker.typeToString(recvT)} = new C(...)')`,
        );
      }
      L.unsupported(
        "SC1090",
        call,
        `calls of the generic method '${name}' with no defining object literal (the declaration is signature-only — only methods declared with a body in an object literal monomorphize)`,
      );
    }
    requireObjLitGenericReceiver(L, call, access.expression, found.literal, name);
    const info = objLitGenericFnInfoOf(L, call, name, found);
    const instance = genericCallInstance(L, call, info);
    const loc = locOf(call);
    const args = L.completeArgs(call.arguments, instance.params, loc, call);
    return { kind: "call", callee: instance.name, args, type: instance.returnType, loc };
  }

/** `obj.method(args)` — whole-program devirtualization decides the form:
   * a method some strict subclass of the receiver's STATIC class overrides
   * must dispatch on the dynamic class (`virtualCall`, through the vtable);
   * everything else — standalone classes, non-overridden methods, leaf
   * receivers — stays a direct `call` of the nearest declaration, exactly
   * as before inheritance existed. */
  export function lowerObjectMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverIr?.kind !== "object") return null;
    const info = L.classes.get(receiverIr.className);
    if (!info) L.flushDeferredClass(receiverIr.className);
    const found = info ? L.findMethodOn(info, access.name.text) : null;
    // The stream surface: API-named calls on stream-rooted receivers
    // lower through the stream spoke (checked before the emitter surface
    // — the two member sets are disjoint, but streams root at the emitter
    // so both guards would pass an emitter-named call).
    if (info && !found && STREAM_API_MEMBERS.has(access.name.text) && streamSidesOf(L, info) !== null) {
      const stream = lowerStreamMethodCall(L, call, access, info);
      if (stream) return stream;
    }
    // The EventEmitter surface: API-named calls on emitter-rooted
    // receivers lower through the emitter spoke (subclass members with
    // these names are fenced at collection, so `found` never shadows).
    if (info && !found && EMITTER_API_MEMBERS.has(access.name.text) && emitterRooted(L, info)) {
      return lowerEmitterMethodCall(L, call, access, info);
    }
    // GENERIC methods (own type parameters) never enter the methods table:
    // they monomorphize per call site and dispatch statically
    // (lowerClassGenericMethodCall has the exactness rules).
    if (info && !found) {
      const gfound = findGenericMethodOn(L, info, access.name.text);
      if (gfound) return lowerClassGenericMethodCall(L, call, access, info, gfound);
    }
    // A FUNC- or DYN-typed FIELD in call position: `this.cb()` — the
    // ctor-assigned callback field (countdown.js's shape). The call is an
    // ordinary call through the field's VALUE — read the field, then
    // callValue (func fields) or the dynCall boundary (checked-dynamic
    // fields: implicit-any ctor params, validated at the call like every
    // dyn callee). Every other field type falls through to the fences.
    if (info && !found) {
      const fieldType = info.fields.get(access.name.text);
      if (fieldType && (fieldType.kind === "func" || fieldType.kind === "dyn")) {
        const target = L.fieldTarget(access);
        const callee = target ? L.fieldGetExpr(target, locOf(access), access) : null;
        if (callee?.type.kind === "func") {
          const params = callee.type.params;
          const args = call.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
          for (let i = args.length; i < params.length; i++) {
            const absent = omittedArgFor(L, params[i]!, locOf(call));
            if (!absent) {
              L.unsupported("SC1090", call, "calls omitting a non-optional parameter of the callee's type");
            }
            args.push(absent);
          }
          return { kind: "callValue", callee, args, type: callee.type.ret, loc: locOf(call) };
        }
        if (callee?.type.kind === "dyn") {
          if (call.arguments.some((a) => ts.isSpreadElement(a))) {
            L.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
          }
          const args = call.arguments.map((a) => L.lowerExprExpecting(a, DYN));
          return { kind: "dynCall", callee, calleeName: access.getText(), args, type: DYN, loc: locOf(call) };
        }
      }
      return null;
    }
    if (!info || !found) return null;
    const method = access.name.text;
    if (found.declarer.builtinError) {
      // The one builtin method: Error.prototype.toString, a runtime
      // implementation called directly (overriding it is fenced, so no
      // dispatch can ever be needed). Receiver BORROWED by the libCall.
      const receiver = L.lowerExpr(access.expression);
      return {
        kind: "libCall",
        fn: "error.toString",
        args: [L.upcastTo(receiver, found.declarer.def.name)],
        type: STRING,
        loc: locOf(call),
      };
    }
    // An ABSTRACT nearest declaration with no concrete override below the
    // static class: no implementation exists for a direct call to target.
    // Unreachable in a program that constructs anything of this type (tsc
    // makes instantiable subclasses implement, and their declarations flip
    // overrideBelow) — reaching here means the receiver can only be a
    // non-value (`null!`); the fence is the honest answer.
    if (found.sig.abstract === true && !L.overrideBelow(info, method)) {
      L.unsupported(
        "SC1090",
        call,
        `calls of the abstract method '${method}' with no concrete implementation below the receiver's static class`,
      );
    }
    if (L.overrideBelow(info, method)) L.noteVirtualEdge(info, method);
    else L.noteEdge(`%${found.declarer.def.name}.${method}`);
    const receiver = L.lowerExpr(access.expression);
    const args = L.completeArgs(call.arguments, found.sig.params, locOf(call), call);
    if (L.overrideBelow(info, method)) {
      return reconcileOverloadReturn(L, call, {
        kind: "virtualCall",
        className: info.def.name,
        method,
        args: [L.upcastTo(receiver, info.def.name), ...args],
        type: found.sig.ret,
        loc: locOf(call),
      });
    }
    return reconcileOverloadReturn(L, call, {
      kind: "call",
      callee: `%${found.declarer.def.name}.${method}`,
      args: [L.upcastTo(receiver, found.declarer.def.name), ...args],
      type: found.sig.ret,
      loc: locOf(call),
    });
  }
