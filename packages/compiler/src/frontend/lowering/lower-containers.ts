/* Container-surface call lowering: array methods (including the HOF family
 * map/filter/forEach with their synthesized helper functions), Map/Set
 * methods with Node-exact forEach desugaring, and the string and regex
 * method surfaces. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, BYTES_U8, CAUGHT, DYN, F64, IrBytesElem, IrBytesIntrinsicMethod, IrExpr, IrFunction, IrLocal, IrMapIntrinsicMethod, IrParam, IrRecordShape, IrSetIntrinsicMethod, IrStmt, IrType, JSVAL, STRING, SrcLoc, UNDEFINED_T, VOID, arrayOf, bytesOf, funcOf, isRefCounted, isSupportedArrayElem, isSupportedIndexValue, isUnitType, typeEquals } from "../../ir/nodes.js";
import { ARRAY_METHODS, MAP_METHODS, SET_COMBINE_METHODS, SET_METHODS, STR_METHODS } from "./surfaces.js";
import { droppableStatic, isRequireMainFilename, lowerDynObjectLiteral, probeLower, pureReemittable } from "./lower-exprs.js";
import { forOfVarTarget, lowerDestructuringAssign } from "./lower-stmts.js";
import { isJsSourceFile, locOf } from "../program.js";
import { islandPrimitiveExit, lowerDynDispatchMethodCall } from "./lower-calls.js";
import { typeKey } from "../types.js";
import { dynUndefinedExpr, own, WidthLift } from "./lowerer.js";

/** Lower an expression whose checker type is statically `undefined`/`void`.
 * Optional builtin arguments use this before their ordinary expected-type
 * coercion so every equivalent spelling (`undefined`, `void 0`, a typed
 * binding, or an effectful call returning undefined) selects the default.
 * An effectful `void e` is exact in this context: evaluate e, then produce
 * undefined, instead of hitting value-position void's general fence. */
function lowerStaticallyUndefinedArg(L: Lowerer, node: ts.Expression): IrExpr | null {
  const peelErasableWrappers = (value: ts.Expression): ts.Expression => {
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
  if (
    (L.typeOf(expr).flags &
      (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) ===
    0
  ) {
    return null;
  }
  // TypeScript erases `as`, angle-bracket assertions, and `satisfies`.
  // Peel them only for the void recognition: a non-void assertion still
  // lowers through the ordinary path below, preserving the checked-dynamic
  // cast discipline. Nested voids add no effects of their own, so the one
  // innermost operand carries the complete runtime evaluation.
  expr = peelErasableWrappers(expr);
  let sawVoid = false;
  while (ts.isVoidExpression(expr)) {
    sawVoid = true;
    expr = peelErasableWrappers(expr.expression);
  }
  if (sawVoid) {
    // The caller discards this token before producing the parameter
    // default, so the operand itself carries exactly the required effects;
    // no bare undefined value needs to enter the IR.
    return L.lowerExpr(expr);
  }
  return L.lowerExpr(node);
}

/** Preserve a statically-undefined argument's effects, then answer the
 * optional parameter's already-lowered default value. */
function defaultAfterUndefined(value: IrExpr, defaultValue: IrExpr): IrExpr {
  if (droppableStatic(value)) return defaultValue;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
    result: defaultValue,
    type: defaultValue.type,
    loc: value.loc,
  };
}

function lowerOptionalDefaultArg(
  L: Lowerer,
  node: ts.Expression,
  expected: IrType,
  defaultValue: IrExpr,
): IrExpr {
  const undefinedArg = lowerStaticallyUndefinedArg(L, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, defaultValue);
  const value = L.lowerExpr(node);
  if (value.type.kind === "union") {
    const def = L.unions.get(value.type.unionId);
    if (
      def?.arms.length === 2 &&
      def.arms.some((arm) => arm.kind === "undefinedT") &&
      def.arms.some((arm) => typeEquals(arm, expected))
    ) {
      // A runtime optional argument uses its API default only on the
      // undefined arm. The exact two-arm gate deliberately excludes null:
      // optional parameters do not admit it, and an asserted null must keep
      // the ordinary checked-narrow failure instead of defaulting.
      return { kind: "nullish", left: value, right: defaultValue, type: expected, loc: value.loc };
    }
  }
  return L.coerceInto(node, value, expected);
}

function lowerSplitLimitArg(L: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  const defaultValue: IrExpr = { kind: "numLit", value: 4294967295, type: F64, loc };
  return node ? lowerOptionalDefaultArg(L, node, F64, defaultValue) : defaultValue;
}

/** Callback-driven array producers bypass mapType's ordinary T[] mapping:
 * the callback is lowered first, then the helper's result array is built
 * directly from its IR return type. Fence element kinds ScrArr cannot hold
 * before constructing that array type. */
function fenceProducedArrayElem(L: Lowerer, node: ts.Node, producer: string, elem: IrType): void {
  if (elem.kind === "dyn") {
    L.unsupported(
      "SC1090",
      node,
      `${producer} with a callback returning 'unknown'-typed values (the result array has no static element type — annotate the callback's return)`,
    );
  }
  if (!isSupportedArrayElem(elem)) {
    L.unsupported(
      "SC1090",
      node,
      `${producer} with a callback returning '${L.fmt(elem)}' values (arrays of this element kind have no representation — store the values individually)`,
    );
  }
}

/** Ambient array method calls. `push`/`unshift`/`pop`/`reverse`/
 * `indexOf`/`includes`/`join`
   * lower to arrIntrinsic; the HOF family — `map`/`filter`/`forEach`/
   * `find`/`some`/`every`/`flatMap`/`reduce`/`reduceRight` — desugars to a
   * direct call of a synthetic loop function (see lowerArrayHofCall and
   * friends). Null when this isn't an ambient array method call. tsc has
   * already checked arity and argument types against ambient/scriptc.d.ts. */
  export function lowerArrayMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    if (!ARRAY_METHODS.has(name) && name !== "sort" && name !== "shift" && name !== "splice") return null;
    let receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    // A checker-`any[]` receiver (the readonly-array Array.isArray quirk)
    // whose VALUE lowers to a real static array (maybeNarrow's isArray
    // bridge): ride the ordinary tables on the lowered element type — the
    // dyn-receiver string precedent (re-lowering is pure IR construction).
    // A checker-untyped receiver has no stdlib-declared member symbol, so
    // the isStdlibMember gate is skipped for probed receivers (nothing
    // user-declared can shadow a method on a value the checker calls any).
    let probedUntyped = false;
    if (
      !receiverIr &&
      (L.checkerAnyArray(access.expression) ||
        // A checker-`any` CHAIN whose value lowers to a real static array
        // (`context.stack.split('\n').slice(2)` — the dyn-receiver string
        // machinery answered string[]): same rule, any-typed spelling.
        ((L.typeOf(access.expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 &&
          isJsSourceFile(access.getSourceFile())))
    ) {
      const probe = L.lowerExpr(access.expression);
      if (probe.type.kind === "array") {
        receiverIr = probe.type;
        probedUntyped = true;
      }
    }
    if (receiverIr?.kind !== "array") return null;
    if (!probedUntyped && !L.isStdlibMember(access)) return null;
    let elem = receiverIr.elem;
    const loc = locOf(call);
    // An island handle behind an array-typed .d.ts surface
    // (`parts().join("-")` — arrays never exit eagerly, so the value
    // stays jsval): the ENGINE's own Array.prototype method runs on the
    // engine array — every declared call form (fromIndex, comparators
    // and HOF callbacks as marshaled host functions), Node-exact by
    // construction, with the declared-primitive result exit. Never a
    // static arrIntrinsic over a jsval (the validator ICE).
    {
      const receiver = L.lowerExpr(access.expression);
      if (receiver.type.kind === "jsval") {
        const loweredArgs = call.arguments.map((a) => L.lowerExpr(a));
        if (name === "filter" && loweredArgs[0]?.type.kind === "func" && loweredArgs[0].type.ret.kind === "void") {
          L.unsupported(
            "SC1090",
            call.arguments[0]!,
            "'.filter()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)",
          );
        }
        const args = loweredArgs.map((arg, i) => L.jsvalIn(arg, call.arguments[i]!));
        const result: IrExpr = { kind: "jsOp", op: "callMethod", name, args: [receiver, ...args], type: JSVAL, loc };
        return islandPrimitiveExit(L, call, result);
      }
      // An array-mapped CHECKER type whose VALUE lives in the checked-dynamic tree
      // (`Object.keys(dynObj).sort()` — the key-walk answers a dyn array):
      // the record family's array sibling. Methods with a runtime
      // receiver-kind dispatch ride dynInvoke — the real method runs on
      // the dyn array, JS-exact; the rest keep an honest fence instead of
      // handing a static array intrinsic a dyn receiver (the validator
      // ICE). Consumers validate the dyn result where a static type is
      // required (dynCheck — the member-read discipline).
      if (receiver.type.kind === "dyn") {
        const dispatched = lowerDynDispatchMethodCall(L, call, access, receiver, true);
        if (dispatched) return dispatched;
        L.noLowering(
          `.${name} on an array value held in a checked-dynamic binding`,
          call,
          "assign it to an array-typed binding first (the validated extraction), then call the method",
        );
      }
      // An evolving-`any` array binding under --dynamic whose flow type
      // EVOLVED past `any[]` (`const fns = []; fns.push(() => 1);
      // fns.map(...)` — the binding lowered array<jsval> at its `any[]`
      // declaration, while tsc's evolving-array analysis answers the
      // pushed element type at this site): the VALUE's element type is
      // the truth — ride the explicit-`any[]` handle-element lowering
      // (pushes marshal in, HOF callbacks bind the handle, results exit
      // per the checker type), never a typed intrinsic over a jsval-
      // element array (the validator ICE).
      if (receiver.type.kind === "array" && receiver.type.elem.kind === "jsval" && !typeEquals(receiverIr, receiver.type)) {
        receiverIr = receiver.type;
        elem = receiver.type.elem;
      }
    }
    if (name === "sort" || name === "toSorted") {
      return lowerArraySortCall(L, call, access, elem, receiverIr);
    }
    if (name === "toReversed") {
      if (call.arguments.length !== 0) {
        L.noLowering(`.toReversed with ${call.arguments.length} arguments`, call);
      }
      return {
        kind: "arrIntrinsic",
        method: "toReversed",
        receiver: L.lowerExpr(access.expression),
        args: [],
        type: receiverIr,
        loc,
      };
    }
    if (name === "reverse") {
      if (call.arguments.length !== 0) {
        L.noLowering(`.reverse with ${call.arguments.length} arguments`, call);
      }
      return {
        kind: "arrIntrinsic",
        method: "reverse",
        receiver: L.lowerExpr(access.expression),
        args: [],
        type: receiverIr,
        loc,
      };
    }
    if (name === "with") {
      if (call.arguments.length !== 2 || call.arguments.some(ts.isSpreadElement)) {
        L.noLowering(`.with with ${call.arguments.length} arguments`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const index = L.lowerExprExpecting(call.arguments[0]!, F64);
      const value = L.coerceInto(
        call.arguments[1]!,
        L.lowerExpr(call.arguments[1]!),
        elem,
      );
      return {
        kind: "arrIntrinsic",
        method: "with",
        receiver,
        args: [index, value],
        type: receiverIr,
        loc,
      };
    }
    if (name === "toSpliced") {
      if (call.arguments.some(ts.isSpreadElement)) {
        L.unsupported("SC1090", call, "spread arguments to Array.toSpliced");
      }
      const receiver = L.lowerExpr(access.expression);
      const start = call.arguments[0]
        ? L.lowerExprExpecting(call.arguments[0], F64)
        : { kind: "numLit" as const, value: 0, type: F64, loc };
      const deleteCountDefault: IrExpr = {
        kind: "numLit",
        value: NaN,
        type: F64,
        loc,
      };
      const deleteCount =
        call.arguments.length === 0
          ? { kind: "numLit" as const, value: 0, type: F64, loc }
          : call.arguments[1]
            ? lowerOptionalDefaultArg(
                L,
                call.arguments[1],
                F64,
                deleteCountDefault,
              )
            : { kind: "numLit" as const, value: Infinity, type: F64, loc };
      const items: IrExpr = {
        kind: "arrayLit",
        elems: call.arguments.slice(2).map((arg) =>
          L.coerceInto(arg, L.lowerExpr(arg), elem)),
        type: receiverIr,
        loc,
      };
      return {
        kind: "arrIntrinsic",
        method: "toSpliced",
        receiver,
        args: [start, deleteCount, items],
        type: receiverIr,
        loc,
      };
    }

    // The lib declares wider call forms than the lowered surface —
    // indexOf/includes take a fromIndex, join's separator is optional, the
    // predicate/mapping HOFs take a thisArg. Each unlowered form is fenced
    // per site (SC2020), never silently truncated to the supported
    // arguments. push/unshift lower every declared form (variadic, 0 args
    // included — Node returns the unchanged length); reduce/reduceRight
    // lower both declared forms (with and without an initial value).
    const arity = {
      push: [0, Number.MAX_SAFE_INTEGER], unshift: [0, Number.MAX_SAFE_INTEGER], pop: [0, 0], indexOf: [1, 1], includes: [1, 1], join: [1, 1],
      concat: [0, Number.MAX_SAFE_INTEGER],
      slice: [0, 2], shift: [0, 0], splice: [1, 2], at: [1, 1],
      map: [1, 1], filter: [1, 1], forEach: [1, 1], find: [1, 1], findIndex: [1, 1], some: [1, 1],
      findLast: [1, 1], findLastIndex: [1, 1],
      every: [1, 1], flatMap: [1, 1], reduce: [1, 2], reduceRight: [1, 2],
    }[
      name as
        | "push" | "unshift" | "pop" | "concat" | "indexOf" | "includes" | "join" | "slice" | "shift" | "splice" | "at" | "map" | "filter"
        | "forEach" | "find" | "findIndex" | "findLast" | "findLastIndex" | "some" | "every" | "flatMap" | "reduce" | "reduceRight"
    ];
    if (call.arguments.length < arity[0]! || call.arguments.length > arity[1]!) {
      const hint =
        name === "splice"
          ? "the removal forms lower — splice(start, deleteCount?); to insert, build a new array with slice and push"
          : name === "join"
            ? 'pass the separator explicitly: join(",")'
            : name === "indexOf" || name === "includes"
              ? "the fromIndex parameter has no lowering — slice first, or loop"
              : name === "map" || name === "filter" || name === "forEach" ||
                  name === "find" || name === "some" || name === "every" || name === "flatMap"
                ? "the thisArg parameter has no lowering — use an arrow function"
                : undefined;
      L.noLowering(
        `.${name} with ${call.arguments.length} argument${call.arguments.length === 1 ? "" : "s"}`,
        call,
        hint,
      );
    }
    if (name === "push" || name === "unshift" || name === "pop") {
      const receiver = L.lowerExpr(access.expression);
      // `a.push(...src)` / `a.unshift(...src)`: copy src's elements in
      // order (count snapshotted first, so the self-spread forms duplicate
      // like JS) and return the new length.
      const spreadArg = call.arguments.length === 1 && ts.isSpreadElement(call.arguments[0]!)
        ? call.arguments[0]!
        : null;
      if ((name === "push" || name === "unshift") && spreadArg && ts.isSpreadElement(spreadArg)) {
        let src = L.lowerExpr(spreadArg.expression);
        // `a.push(...someSet)` / `a.unshift(...someSet)`: a same-element Set drains first
        // (setIntrinsic toArray — insertion order), then appends.
        if (src.type.kind === "set" && typeEquals(src.type.elem, elem)) {
          src = { kind: "setIntrinsic", method: "toArray", receiver: src, args: [], type: arrayOf(src.type.elem), loc };
        }
        if (!typeEquals(src.type, receiverIr)) {
          L.unsupported(
            "SC1090",
            spreadArg,
            `${name === "push" ? "pushing" : "unshifting"} a spread of '${L.fmt(src.type)}' onto a '${L.fmt(receiverIr)}' array (only a same-element-type array spreads)`,
          );
        }
        return {
          kind: "arrIntrinsic",
          method: name === "push" ? "pushSpread" : "unshiftSpread",
          receiver,
          args: [src],
          type: F64,
          loc,
        };
      }
      // Inserted values flow into the element slot like an assignment would:
      // union-element arrays wrap plain arm values (coerceInto is inert
      // when the types already agree).
      const args = call.arguments.map((a) =>
        name === "push" || name === "unshift" ? L.lowerExprExpecting(a, elem) : L.lowerExpr(a),
      );
      return {
        kind: "arrIntrinsic",
        method: name,
        receiver,
        args,
        type: name === "push" || name === "unshift" ? F64 : elem,
        loc,
      };
    }
    if (name === "indexOf" || name === "includes") {
      // Union elements are fenced: the runtime compares ref elements by
      // POINTER identity (JS-exact for records/objects/arrays), but a
      // union BOX is a compiler artifact — two boxes of the same arm value
      // are distinct pointers where JS would say ===. Honest answer: none.
      if (elem.kind === "union") {
        L.unsupported(
          "SC1090",
          call,
          `'.${name}()' on union-element arrays (union values have no stable identity — ` +
            "loop and compare the narrowed values instead)",
        );
      }
      const receiver = L.lowerExpr(access.expression);
      let needle = L.lowerExpr(call.arguments[0]!);
      // A derived CLASS VALUE against a base-classval element widens (the
      // same pointer — identity search is exact); the coercion path owns
      // the ABI gate and its pointed fences.
      if (needle.type.kind === "classval" && elem.kind === "classval" && !typeEquals(needle.type, elem)) {
        needle = L.coerceInto(call.arguments[0]!, needle, elem);
      }
      if (!typeEquals(needle.type, elem)) {
        L.badType(call.arguments[0]!, L.typeOf(call.arguments[0]!));
      }
      return {
        kind: "arrIntrinsic",
        method: name,
        receiver,
        args: [needle],
        type: name === "indexOf" ? F64 : BOOL,
        loc,
      };
    }
    if (name === "concat") {
      // `a.concat(x, ys, ...)` — a fresh array of a's elements followed by
      // each argument in order: JS spreads array arguments one level
      // (IsArray, never deeper) and appends plain values. Each argument is
      // either an ELEMENT (pushed) or a SAME-ELEMENT ARRAY (spread) —
      // decided by its static type, which matches IsArray exactly here
      // because the two kinds map differently. The one ambiguous corner —
      // an array-of-arrays receiver given a bare inner array, where TS
      // types it as an element but JS would SPREAD it — is fenced.
      const receiver = L.lowerExpr(access.expression);
      const shape: ("e" | "a")[] = [];
      const args: IrExpr[] = [];
      for (const argNode of call.arguments) {
        if (ts.isSpreadElement(argNode)) {
          L.unsupported("SC1090", argNode, "spread arguments to concat (pass the array itself — concat already spreads array arguments)");
        }
        const argIr = L.mapTypeOf(L.typeOf(argNode));
        if (argIr !== null && argIr.kind === "array" && typeEquals(argIr.elem, elem)) {
          if (elem.kind === "array" && typeEquals(argIr, elem)) {
            // number[][].concat(inner: number[]) — TS says element, JS's
            // IsArray says spread; no honest static answer exists.
            L.unsupported(
              "SC1090",
              argNode,
              "concat of a bare inner array onto an array-of-arrays (JS would SPREAD it one level — wrap it: a.concat([inner]))",
            );
          }
          const arg = L.lowerExpr(argNode);
          if (arg.type.kind !== "array") L.badType(argNode, L.typeOf(argNode));
          shape.push("a");
          args.push(arg);
          continue;
        }
        // A handle-element receiver given an argument whose CHECKER type
        // spells evolved elements while its VALUE is a jsval-element
        // array (`fns.concat(tail)` — both sides of the evolving-`any`
        // adoption): the value's array-ness decides, exactly JS's
        // IsArray — spread it. Non-array values fall through to the
        // element push (the jsvalIn coercion).
        if (elem.kind === "jsval") {
          const arg = L.lowerExpr(argNode);
          if (arg.type.kind === "array" && arg.type.elem.kind === "jsval") {
            shape.push("a");
            args.push(arg);
            continue;
          }
        }
        // An element value — union elements wrap exactly like a push.
        shape.push("e");
        args.push(L.lowerExprExpecting(argNode, elem));
      }
      const helper = arrayConcatHelper(L, elem, shape, loc);
      return { kind: "call", callee: helper, args: [receiver, ...args], type: receiverIr, loc };
    }
    if (name === "slice") {
      // `a.slice(start?, end?)` — a fresh shallow copy of the index range,
      // JS-exact index handling (ToIntegerOrInfinity, negatives from the
      // end, clamping; omitted args are omitted from the IR — the backend
      // fills 0 / +Infinity, the string-slice convention). Ref elements
      // are RETAINED into the copy: the same references, exactly JS's
      // shallow copy. Every element kind slices — the receiver's own type
      // is the result type.
      const receiver = L.lowerExpr(access.expression);
      const args = call.arguments.map((a) => L.lowerExpr(a));
      for (let i = 0; i < args.length; i++) {
        if (args[i]!.type.kind !== "f64") L.badType(call.arguments[i]!, L.typeOf(call.arguments[i]!));
      }
      return { kind: "arrIntrinsic", method: "slice", receiver, args, type: receiverIr, loc };
    }
    if (name === "splice") {
      // The REMOVAL forms: splice(start) and splice(start, deleteCount) —
      // Node-exact relative/clamped indices, the removed elements back in
      // order (their ownership moves out of the receiver). Insertion
      // (3+ args) fenced by arity above.
      const receiver = L.lowerExpr(access.expression);
      const args = call.arguments.map((a) => L.lowerExpr(a));
      for (let i = 0; i < args.length; i++) {
        if (args[i]!.type.kind !== "f64") L.badType(call.arguments[i]!, L.typeOf(call.arguments[i]!));
      }
      return { kind: "arrIntrinsic", method: "splice", receiver, args, type: receiverIr, loc };
    }
    if (name === "shift") {
      // JS shift exactly: undefined on an empty array, else the first
      // element with the tail sliding down — the result is the interned
      // `elem | undefined` union, the env-read convention. Union-element
      // arrays are fenced: their shift result would collapse arms
      // (`(string | undefined)[]`'s shift is `string | undefined` too, and
      // the box can't say which world the undefined came from).
      if (elem.kind === "union") {
        L.unsupported(
          "SC1090",
          call,
          "'.shift()' on union-element arrays (read [0] and splice(0, 1) with the narrowed value instead)",
        );
      }
      const receiver = L.lowerExpr(access.expression);
      return { kind: "arrIntrinsic", method: "shift", receiver, args: [], type: L.withUndefinedArm(elem), loc };
    }
    if (name === "join") {
      // The ambient declares join on every Array<T> (a per-element-type
      // interface split isn't expressible there), so string-convertible
      // elements are enforced here: nested arrays would need JS's recursive
      // Array#toString. UNIONS of the convertible kinds join too —
      // undefined/null arms print EMPTY per Array.prototype.join (the
      // `.filter(Boolean)` idiom keeps its checker type `(string |
      // undefined)[]`, and JS joins the units silently) — via a per-union
      // interned walker in the backend.
      const joinableUnion =
        elem.kind === "union" &&
        (L.unions
          .get(elem.unionId)
          ?.arms.every(
            (a) => a.kind === "f64" || a.kind === "string" || a.kind === "bool" || isUnitType(a),
          ) ??
          false);
      if (elem.kind !== "f64" && elem.kind !== "string" && elem.kind !== "bool" && !joinableUnion) {
        L.unsupported(
          "SC1090",
          call,
          "'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS)",
        );
      }
      const receiver = L.lowerExpr(access.expression);
      const sep = L.lowerExpr(call.arguments[0]!);
      return { kind: "arrIntrinsic", method: "join", receiver, args: [sep], type: STRING, loc };
    }
    if (name === "map" || name === "filter" || name === "forEach") {
      return lowerArrayHofCall(L, call, access, name, elem);
    }
    if (
      name === "find" || name === "findIndex" || name === "findLast" ||
      name === "findLastIndex" || name === "some" || name === "every"
    ) {
      return lowerArrayFindLikeCall(L, call, access, name, elem);
    }
    if (name === "at") return lowerArrayAtCall(L, call, access, elem);
    if (name === "flatMap") return lowerArrayFlatMapCall(L, call, access, elem);
    // reduce / reduceRight
    return lowerArrayReduceCall(L, call, access, name as "reduce" | "reduceRight", elem);
  }

/** Lowers and validates a HOF callback argument. The lib declares optional
   * trailing (index, array) parameters after `lead` (the element for the
   * map family, accumulator + element for reduce); a callback may declare
   * any PREFIX of [...lead, index, array] — ordinary TS — and the desugared
   * loop passes exactly what it declares (JS passes everything; a callback
   * only sees the parameters it names). Returns the lowered callback and
   * its declared arity. */
  function hofCallbackArg(L: Lowerer, argNode: ts.Expression, lead: IrType[], arrT: IrType):
    { fnArg: IrExpr & { type: IrType & { kind: "func" } }; arity: number } {
    // A DYN-receiver HOF's callback (`parsed.flatMap((value) => ...)`):
    // the contextual signature types the unannotated param `any` (the
    // receiver is checker-`any[]`), while the VALUE each call receives is
    // the dyn element `unknown` code sees — narrow the param declaration
    // to `unknown` so it lowers as the dyn it carries (typeof tests and
    // validated extractions ride as usual) instead of fencing on `any`.
    const overridden: ts.Node[] = [];
    if (lead[0]?.kind === "dyn" && (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode))) {
      for (const p of argNode.parameters) {
        if (!ts.isIdentifier(p.name) || p.type || p.initializer || p.dotDotDotToken) continue;
        const t = L.checker.getTypeAtLocation(p.name);
        if ((t.flags & ts.TypeFlags.Any) !== 0 && !L.chainNarrowedType.has(p.name)) {
          L.chainNarrowedType.set(p.name, L.checker.getUnknownType());
          overridden.push(p.name);
        }
      }
    }
    // A JSVAL-element receiver behind an EVOLVED contextual type (the
    // evolving-`any` array under --dynamic — lowerArrayMethodCall adopted
    // the value's handle element while tsc's evolving analysis types the
    // callback's params by the pushed elements): the lead params BIND the
    // handles the loop passes, whatever the contextual type spelled —
    // paramShape's island-handle early-out, the then-handler rule.
    if (ts.isArrowFunction(argNode) || ts.isFunctionExpression(argNode)) {
      argNode.parameters.forEach((p, i) => {
        if (i >= lead.length || lead[i]!.kind !== "jsval") return;
        if (!ts.isIdentifier(p.name) || p.type || p.initializer || p.dotDotDotToken) return;
        L.jsvalParamOverrides.add(p);
      });
    }
    let fnArg: IrExpr;
    try {
      fnArg = L.lowerExpr(argNode);
    } finally {
      for (const n of overridden) L.chainNarrowedType.delete(n);
    }
    const full = [...lead, F64, arrT];
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > full.length ||
      !fnArg.type.params.every((p, i) => typeEquals(p, full[i]!))
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    return {
      fnArg: fnArg as IrExpr & { type: IrType & { kind: "func" } },
      arity: fnArg.type.params.length,
    };
  }

/** `a.map(fn)` / `a.filter(fn)` / `a.forEach(fn)` desugar to a direct
   * call of a synthetic module function — one per method + element/result
   * type + callback-arity combination, interned — whose body is a plain
   * loop over EXISTING IR nodes (varDecl/for/arrayGet/callValue/push/
   * return). No new IR kinds, no backend or runtime involvement. JS
   * semantics: the length is read ONCE up front (Array.prototype.map/
   * filter/forEach cache it — elements appended by the callback are not
   * visited), elements are read fresh each iteration, callbacks run
   * left-to-right and receive whatever prefix of (element, index, array)
   * they declare. */
  function lowerArrayHofCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    method: "map" | "filter" | "forEach",
    elem: IrType,): IrExpr {
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    const argNode = call.arguments[0];
    if (!argNode) L.unsupported("SC1090", call, "this call form"); // tsc-guarded
    const { fnArg, arity } = hofCallbackArg(L, argNode, [elem], arrayOf(elem));
    const fnRet = fnArg.type.ret;
    if (method === "map" && (fnRet.kind === "void" || fnRet.kind === "func")) {
      // The result array U[] is unrepresentable here (no void elements;
      // the map helper's closure-returning form has no fixture-backed
      // story yet).
      L.badType(call, L.typeOf(call));
    }
    if (method === "map") fenceProducedArrayElem(L, call, "'.map()'", fnRet);
    // JS applies ToBoolean to whatever the predicate answers, so a non-bool
    // result is not an error — the filter loop wraps the call in the same
    // toBool an `if` statement would apply. The island/dyn shapes, whose
    // truthiness needs the engine, and void, whose real answer the ABI has
    // already discarded, keep the fence. No separate
    // requireTruthyUnion call belongs here: its check (no dyn/caught arm)
    // IS filterPredicateOk's union branch, so it could never speak.
    if (method === "filter" && !filterPredicateOk(L, fnRet)) {
      if (fnRet.kind === "void") {
        L.unsupported(
          "SC1090",
          argNode,
          "'.filter()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)",
        );
      }
      L.badType(argNode, L.typeOf(argNode));
    }
    const helper = arrayHofHelper(L, method, elem, fnRet, arity, loc);
    const resultType: IrType =
      method === "map" ? arrayOf(fnRet) : method === "filter" ? arrayOf(elem) : VOID;
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: resultType, loc };
  }

/** The predicate result kinds `.filter()` accepts. JS applies ToBoolean to
 * whatever the callback answers, so a bool is not required: the scalars and
 * the reference kinds have constant or by-value answers, and a union is fine
 * when every arm does. void/dyn/jsval/caught stay out — see below. */
function filterPredicateOk(L: Lowerer, ret: IrType): boolean {
  if (ret.kind === "bool") return true;
  // VOID is a TYPE erasure, not a runtime value: TS lets a value-returning
  // function sit in a void-returning slot (`const p: (n: number) => void =
  // (n) => n`), so the predicate's real answer can be truthy while the
  // compiled ABI has already discarded it. Treating void as constantly
  // falsy would silently answer [] where Node answers [1]. Fenced until
  // the returned value can be preserved through the void ABI.
  // dyn/jsval/caught stay out too: no native ToBoolean to compile against.
  if (ret.kind === "void") return false;
  if (ret.kind === "dyn" || ret.kind === "jsval" || ret.kind === "caught") return false;
  if (ret.kind === "union") {
    const def = L.unions.get(ret.unionId);
    return def !== undefined && def.arms.every((a) => a.kind !== "dyn" && a.kind !== "caught");
  }
  return true;
}

/** The filter loop's condition: the predicate's result put through JS
 * ToBoolean. A bool answer is already the condition; everything else takes
 * the same `toBool` wrapper an `if` statement would apply (a union answer
 * routes through its interned per-arm truthy helper). */
function filterCond(call: IrExpr, fnRet: IrType, loc: SrcLoc): IrExpr {
  if (fnRet.kind === "bool") return call;
  // No constant-false arm here: void is fenced at the call site, and a
  // bare undefinedT/nullT return cannot arise (mapType sends `undefined`/
  // `void` returns to void and a standalone `null` return to the unit-ONLY
  // UNION, which routes through toBool below; ir/validate.ts rejects a
  // bare unit return type outright). filterPredicateOk already rejected
  // the arms with no native ToBoolean (dyn/caught) — which is exactly what
  // requireTruthyUnion checks — and it did so at the call site, where a
  // real node exists for the diagnostic.
  return { kind: "toBool", operand: call, type: BOOL, loc };
}

/** Interned synthetic loop function for one (method, elem, fnRet, arity)
   * combo. Named `%arr.<method>.<n>` ('%' keeps it out of the user
   * namespace); rides `liftedFns` into the module like a lifted lambda (it
   * is a plain function — no captures). */
  function arrayHofHelper(L: Lowerer, method: "map" | "filter" | "forEach",
    elem: IrType,
    fnRet: IrType,
    arity: number,
    loc: SrcLoc,): string {
    const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.${method}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    L.liftedFns.push(buildArrayHofFn(L, name, method, elem, fnRet, arity, loc));
    return name;
  }

/** READ-ONLY array methods on TUPLE receivers — `t.slice(...)` and
   * `t.map(f)`: a tuple is a fixed-shape record, but these methods never
   * write, so the positions snapshot into a fresh array (the for-of-over-
   * tuples stance — pure receivers only, since the reads re-emit per
   * position) and the ordinary array machinery runs over it. The element
   * type is the one position type, or the positions' interned union with
   * each read wrapped into its arm (exactly the checker's callback
   * parameter type). Null when this isn't a tuple slice/map — writers and
   * the rest of the surface keep their fences. */
  export function lowerTupleReadMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    if (name !== "slice" && name !== "map") return null;
    if (!L.isStdlibMember(access)) return null;
    let receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    let receiver: IrExpr | null = null;
    // A readonly tuple union under Array.isArray is checker-typed as an
    // unmappable intersection with any[], while maybeNarrow still extracts
    // its one tuple arm. Dispatch the supported tuple read methods from
    // that lowered representation, like tuple indexing and `.length`.
    const checkerArray = L.checkerArrayValue(access.expression);
    if (checkerArray?.type.kind === "record") {
      receiverIr = checkerArray.type;
      receiver = checkerArray;
    }
    if (receiverIr?.kind !== "record") return null;
    const shape = L.shapes.get(receiverIr.shapeId);
    if (!shape?.tuple) return null;
    receiver ??= L.lowerExpr(access.expression);
    if (receiver.type.kind !== "record") return null;
    if (!pureReemittable(receiver)) {
      L.noLowering(
        `${L.checker.typeToString(L.typeOf(access.expression))}.${name}`,
        call,
        "tuple receivers snapshot per position, so only effect-free receivers lower — bind the tuple to a const first",
      );
    }
    const loc = locOf(call);
    const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
    let elemT: IrType | null = null;
    {
      const arms: IrType[] = [];
      for (const f of byIndex) {
        if (f.type.kind === "union") { elemT = null; break; }
        if (!arms.some((a) => typeEquals(a, f.type))) arms.push(f.type);
        elemT = arms.length === 1 ? arms[0]! : { kind: "union", unionId: L.unions.intern(arms) };
      }
    }
    if (elemT === null || byIndex.length === 0) return null; // empty/union-position tuples keep the fence
    const snapshotElem = elemT;
    const snapshot: IrExpr = {
      kind: "arrayLit",
      elems: byIndex.map((f) => {
        const read: IrExpr = {
          kind: "recordGet",
          obj: receiver,
          shapeId: receiverIr.shapeId,
          field: f.name,
          type: f.type,
          loc,
        };
        return typeEquals(f.type, snapshotElem) ? read : L.coerceInto(access.expression, read, snapshotElem);
      }),
      type: arrayOf(snapshotElem),
      loc,
    };
    if (name === "slice") {
      if (call.arguments.length > 2) {
        L.noLowering(`.slice with ${call.arguments.length} arguments`, call);
      }
      const args = call.arguments.map((a) => L.lowerExpr(a));
      for (let i = 0; i < args.length; i++) {
        if (args[i]!.type.kind !== "f64") L.badType(call.arguments[i]!, L.typeOf(call.arguments[i]!));
      }
      return { kind: "arrIntrinsic", method: "slice", receiver: snapshot, args, type: arrayOf(snapshotElem), loc };
    }
    // map
    if (call.arguments.length !== 1) {
      L.noLowering(`.map with ${call.arguments.length} arguments`, call, "the thisArg parameter has no lowering — use an arrow function");
    }
    const argNode = call.arguments[0]!;
    const { fnArg, arity } = hofCallbackArg(L, argNode, [snapshotElem], arrayOf(snapshotElem));
    const fnRet = fnArg.type.ret;
    if (fnRet.kind === "void" || fnRet.kind === "func") L.badType(call, L.typeOf(call));
    fenceProducedArrayElem(L, call, "'.map()'", fnRet);
    const helper = arrayHofHelper(L, "map", snapshotElem, fnRet, arity, loc);
    return { kind: "call", callee: helper, args: [snapshot, fnArg], type: arrayOf(fnRet), loc };
  }

/** An OOB-SAFE indexed read: `xs[i]`
   * answers the interned `elem | undefined` union — the element when `i`
   * is an integer in [0, len), JS's property-miss undefined otherwise —
   * instead of the trap divergence 4 documents for program code.
   * Package JS is inference-typed, guard-style code (`registeredArguments
   * .slice(-1)[0]`, commander's last-element probe), and the trap would
   * fire on working Node idioms; program files keep the documented trap
   * (their annotations can prove bounds). Existing element unions retag
   * into the canonical union with an added undefined arm. */
  export function lowerSafeIndexRead(
    L: Lowerer,
    arr: IrExpr & { type: { kind: "array" } },
    index: IrExpr,
    loc: SrcLoc,
  ): IrExpr | null {
    const elem = (arr.type as IrType & { kind: "array" }).elem;
    if (elem.kind === "void" || elem.kind === "dyn") return null;
    const resultT = elem.kind === "union" ? L.withUndefinedArmOf(elem) : L.withUndefinedArm(elem);
    if (!resultT || resultT.kind !== "union") return null;
    const undefTag = L.armTag(resultT.unionId, UNDEFINED_T);
    const foundTag = elem.kind === "union" ? -1 : L.armTag(resultT.unionId, elem);
    if (undefTag < 0 || (elem.kind !== "union" && foundTag < 0)) return null;
    const arrT = arr.type;
    const key = `idxOr:${typeKey(elem)}`;
    let name = L.arrHofHelpers.get(key);
    if (!name) {
      name = `%arr.idxOr.${L.arrHofHelpers.size}`;
      L.arrHofHelpers.set(key, name);
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const i = ref("i.0", F64);
      const n = ref("n.0", F64);
      const v = ref("v.0", elem);
      const lt = (l: IrExpr, r: IrExpr): IrExpr => ({ kind: "bin", op: "<", left: l, right: r, type: BOOL, loc });
      const miss: IrExpr = {
        kind: "unionWrap",
        unionId: resultT.unionId,
        tag: undefTag,
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: resultT,
        loc,
      };
      const body: IrStmt[] = [
        readLenStmt(arrT, loc),
        { kind: "if", cond: { kind: "bin", op: "!==", left: i, right: i, type: BOOL, loc }, then: [{ kind: "return", value: miss, loc }], else_: null, loc },
        { kind: "if", cond: lt(i, num(0)), then: [{ kind: "return", value: miss, loc }], else_: null, loc },
        { kind: "if", cond: { kind: "bin", op: ">=", left: i, right: n, type: BOOL, loc }, then: [{ kind: "return", value: miss, loc }], else_: null, loc },
        // A fractional index is a property miss too (floor(i) < i exactly
        // when i has a fraction; negatives already returned above).
        {
          kind: "if",
          cond: lt({ kind: "libCall", fn: "math.floor", args: [i], type: F64, loc }, i),
          then: [{ kind: "return", value: miss, loc }],
          else_: null,
          loc,
        },
        { kind: "varDecl", localId: "v.0", init: { kind: "arrayGet", arr: ref("a.0", arrT), index: i, type: elem, loc }, loc },
        {
          kind: "return",
          value: elem.kind === "union"
            ? L.coerceToExpected(v, resultT)
            : { kind: "unionWrap", unionId: resultT.unionId, tag: foundTag, value: v, type: resultT, loc },
          loc,
        },
      ];
      L.liftedFns.push({
        name,
        params: [
          { localId: "a.0", name: "a", type: arrT },
          { localId: "i.0", name: "i", type: F64 },
        ],
        returnType: resultT,
        locals: [
          { id: "a.0", name: "a", type: arrT, mutable: true },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "n.0", name: "n", type: F64, mutable: false },
          { id: "v.0", name: "v", type: elem, mutable: false },
        ],
        body,
        loc,
      });
    }
    return { kind: "call", callee: name, args: [arr, index], type: resultT, loc };
  }

  /** Backward-compatible name for the npm-static probe path. */
  export const lowerNpmStaticSafeIndexRead = lowerSafeIndexRead;

/** Interned synthetic function for one (elem, argument-shape) concat —
   * `%arr.concat.<n>(a, x0, x1, ...)`: a fresh array takes a's elements
   * (pushSpread), then each argument pushes (element) or spreads (array)
   * in order; the receiver and array arguments are only READ. Rides
   * liftedFns like the HOF helpers (a plain function — no captures). */
  function arrayConcatHelper(L: Lowerer, elem: IrType, shape: ("e" | "a")[], loc: SrcLoc): string {
    const key = `concat:${typeKey(elem)}:${shape.join("")}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.concat.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: arrT, mutable: false },
      ...shape.map((s, i): IrLocal => ({ id: `x.${i}`, name: `x${i}`, type: s === "a" ? arrT : elem, mutable: false })),
      { id: "out.0", name: "out", type: arrT, mutable: false },
    ];
    const params: IrParam[] = [
      { localId: "a.0", name: "a", type: arrT },
      ...shape.map((s, i): IrParam => ({ localId: `x.${i}`, name: `x${i}`, type: s === "a" ? arrT : elem })),
    ];
    const append = (s: "e" | "a", src: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: s === "a" ? "pushSpread" : "push",
        receiver: ref("out.0", arrT),
        args: [src],
        type: F64,
        loc,
      },
      loc,
    });
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: arrT, loc }, loc },
      append("a", ref("a.0", arrT)),
      ...shape.map((s, i) => append(s, ref(`x.${i}`, s === "a" ? arrT : elem))),
      { kind: "return", value: ref("out.0", arrT), loc },
    ];
    L.liftedFns.push({ name, params, returnType: arrT, locals, body, loc });
    return name;
  }

/** The loop body of one synthetic array HOF, from existing IR nodes:
   *
   *   map:     out = []; n = a.length; for (i = 0; i < n; i++) out.push(f(a[i])); return out;
   *   filter:  out = []; n = a.length; for (...) { v = a[i]; if (f(v)) out.push(v); } return out;
   *   forEach: n = a.length; for (...) f(a[i]);
   *
   * `filter` reads the element once into `v` so the callback and the push
   * see the same value even if the callback mutates `a[i]` (JS-exact).
   * `arity` is the callback's declared parameter count (1–3): the loop
   * passes the index and the receiver itself after the element when the
   * callback names them, exactly the arguments JS supplies. */
  function buildArrayHofFn(L: Lowerer, name: string,
    method: "map" | "filter" | "forEach",
    elem: IrType,
    fnRet: IrType,
    arity: number,
    loc: SrcLoc,): IrFunction {
    const arrT = arrayOf(elem);
    const fnT = funcOf([elem, F64, arrT].slice(0, arity), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ];
    const params: IrParam[] = [
      { localId: "a.0", name: "a", type: arrT },
      { localId: "f.0", name: "f", type: fnT },
    ];
    const callF = (arg: IrExpr): IrExpr => ({
      kind: "callValue",
      callee: ref("f.0", fnT),
      args: [arg, ref("i.0", F64), ref("a.0", arrT)].slice(0, arity),
      type: fnRet,
      loc,
    });
    const getElem: IrExpr = {
      kind: "arrayGet",
      arr: ref("a.0", arrT),
      index: ref("i.0", F64),
      type: elem,
      loc,
    };
    const push = (outT: IrType, value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: ref("out.0", outT),
        args: [value],
        type: F64,
        loc,
      },
      loc,
    });
    const readLen: IrStmt = {
      kind: "varDecl",
      localId: "n.0",
      init: { kind: "arrIntrinsic", method: "length", receiver: ref("a.0", arrT), args: [], type: F64, loc },
      loc,
    };
    const forLoop = (body: IrStmt[]): IrStmt => ({
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
      cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: ref("n.0", F64), type: BOOL, loc },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
        loc,
      },
      body,
      loc,
    });

    let returnType: IrType;
    let body: IrStmt[];
    if (method === "map") {
      const outT = arrayOf(fnRet);
      locals.push({ id: "out.0", name: "out", type: outT, mutable: false });
      returnType = outT;
      body = [
        { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
        readLen,
        forLoop([push(outT, callF(getElem))]),
        { kind: "return", value: ref("out.0", outT), loc },
      ];
    } else if (method === "filter") {
      locals.push(
        { id: "out.0", name: "out", type: arrT, mutable: false },
        { id: "v.0", name: "v", type: elem, mutable: false },
      );
      returnType = arrT;
      body = [
        { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: arrT, loc }, loc },
        readLen,
        forLoop([
          { kind: "varDecl", localId: "v.0", init: getElem, loc },
          {
            kind: "if",
            // ToBoolean over the predicate's answer — inert when it already
            // returned bool, the per-union helper when it returned a union.
            cond: filterCond(callF(ref("v.0", elem)), fnRet, loc),
            then: [push(arrT, ref("v.0", elem))],
            else_: null,
            loc,
          },
        ]),
        { kind: "return", value: ref("out.0", arrT), loc },
      ];
    } else {
      returnType = VOID;
      body = [readLen, forLoop([{ kind: "exprStmt", expr: callF(getElem), loc }])];
    }
    return { name, params, returnType, locals, body, loc };
  }

/** `a.find(f)` / `a.findIndex(f)` / `a.findLast(f)` / `a.findLastIndex(f)`
   * / `a.some(f)` / `a.every(f)` — the early-return HOFs, same
   * desugar-to-loop machinery. some/every return bool from a short-circuit
   * loop; findIndex/findLastIndex return the first matching index or -1
   * (plain f64 — no union). find/findLast return `T | undefined` — the
   * checker's own result union —
   * with the found element wrapped into its arm and the miss producing the
   * undefined unit arm (for REF elements that arm is the unit instance, the
   * standard union machinery). The Last pair is the SAME loop walked
   * backwards (`i = n - 1; i >= 0; i--`), exactly the es2023 spec's
   * descending index walk. All require a bool-returning callback
   * (JS's ToBoolean of arbitrary predicate results has no lowering). */
  function lowerArrayFindLikeCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    method: "find" | "findIndex" | "findLast" | "findLastIndex" | "some" | "every",
    elem: IrType,): IrExpr {
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    const arrT = arrayOf(elem);
    const argNode = call.arguments[0];
    if (!argNode) L.unsupported("SC1090", call, "this call form"); // tsc-guarded
    const { fnArg, arity } = hofCallbackArg(L, argNode, [elem], arrT);
    // JS takes the ToBoolean of the predicate's result — allowed wherever
    // that ToBoolean has a static answer (bool passes through; f64/string
    // by value; a truthy-answerable union by its arm — the
    // `packages.some((p) => p.scripts[name])` idiom, whose callback
    // returns the index read's `string | undefined`).
    const fnRet = fnArg.type.ret;
    const truthyRet =
      fnRet.kind === "bool" || fnRet.kind === "f64" || fnRet.kind === "string" ||
      (fnRet.kind === "union" &&
        (L.unions.get(fnRet.unionId)?.arms ?? []).every((a) => a.kind !== "dyn" && a.kind !== "caught" && a.kind !== "jsval"));
    if (!truthyRet) L.badType(argNode, L.typeOf(argNode));
    const last = method === "findLast" || method === "findLastIndex";
    if (method === "some" || method === "every" || method === "findIndex" || method === "findLastIndex") {
      const helper =
        method === "findIndex" || method === "findLastIndex"
          ? findIndexHelper(L, elem, fnRet, arity, last, loc)
          : someEveryHelper(L, method, elem, fnRet, arity, loc);
      return {
        kind: "call",
        callee: helper,
        args: [receiver, fnArg],
        type: method === "findIndex" || method === "findLastIndex" ? F64 : BOOL,
        loc,
      };
    }
    // find: the result is the checker's `T | undefined` union. When the
    // element type IS that union already (it carries an undefined arm), the
    // found element passes through untouched; otherwise it wraps into its
    // arm. A union element whose result union differs would need the
    // union-into-union re-tag that doesn't exist — fenced.
    const resultT = L.irTypeOf(call);
    if (resultT.kind !== "union") L.badType(call, L.typeOf(call)); // defensive: T | undefined always maps to a union
    const undefTag = L.armTag(resultT.unionId, UNDEFINED_T);
    if (undefTag < 0) L.badType(call, L.typeOf(call));
    let foundTag: number | null = null;
    if (!typeEquals(resultT, elem)) {
      foundTag = L.armTag(resultT.unionId, elem);
      if (foundTag < 0) {
        L.unsupported(
          "SC1090",
          call,
          `'.${method}' on '${L.fmt(elem)}'-element arrays (the found element would need a union ` +
            "re-tag that is not supported yet — loop and test instead)",
        );
      }
    }
    const helper = findHelper(L, elem, resultT, foundTag, undefTag, fnRet, arity, last, loc);
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: resultT, loc };
  }

/** ToBoolean of a predicate result inside a synthesized HOF helper — the
   * ensureBool subset the find-like path admits (bool through; f64/string/
   * truthy-answerable unions via toBool). */
  function predToBool(e: IrExpr): IrExpr {
    if (e.type.kind === "bool") return e;
    return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
  }

/** The find loop, from existing IR nodes:
   *
   *   n = a.length;
   *   for (i = 0; i < n; i++) { v = a[i]; if (f(v)) return <v as result arm>; }
   *   return <undefined arm>;
   */
  function findHelper(L: Lowerer, elem: IrType,
    resultT: IrType & { kind: "union" },
    foundTag: number | null,
    undefTag: number,
    fnRet: IrType,
    arity: number,
    last: boolean,
    loc: SrcLoc,): string {
    const method = last ? "findLast" : "find";
    const key = `${method}:${typeKey(elem)}:${typeKey(resultT)}:${typeKey(fnRet)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.${method}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const fnT = funcOf([elem, F64, arrT].slice(0, arity), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const v = ref("v.0", elem);
    const found: IrExpr =
      foundTag === null
        ? v
        : { kind: "unionWrap", unionId: resultT.unionId, tag: foundTag, value: v, type: resultT, loc };
    const miss: IrExpr = {
      kind: "unionWrap",
      unionId: resultT.unionId,
      tag: undefTag,
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: resultT,
      loc,
    };
    const body: IrStmt[] = [
      readLenStmt(arrT, loc),
      (last ? reverseCountedForLoop : countedForLoop)(loc, [
        { kind: "varDecl", localId: "v.0", init: getElemExpr(arrT, elem, loc), loc },
        {
          kind: "if",
          cond: predToBool({
            kind: "callValue",
            callee: ref("f.0", fnT),
            args: [v, ref("i.0", F64), ref("a.0", arrT)].slice(0, arity),
            type: fnRet,
            loc,
          }),
          then: [{ kind: "return", value: found, loc }],
          else_: null,
          loc,
        },
      ]),
      { kind: "return", value: miss, loc },
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "f.0", name: "f", type: fnT, mutable: true },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "v.0", name: "v", type: elem, mutable: false },
      ],
      body,
      loc,
    });
    return name;
  }

/** The findIndex/findLastIndex loop — find's index-returning sibling, no
   * union; findLastIndex is the identical loop walked backwards:
   *
   *   n = a.length; for (...) if (f(a[i], i, a)) return i;  return -1;
   */
  function findIndexHelper(L: Lowerer, elem: IrType, fnRet: IrType, arity: number, last: boolean, loc: SrcLoc): string {
    const method = last ? "findLastIndex" : "findIndex";
    const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.${method}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const fnT = funcOf([elem, F64, arrT].slice(0, arity), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const body: IrStmt[] = [
      readLenStmt(arrT, loc),
      (last ? reverseCountedForLoop : countedForLoop)(loc, [
        {
          kind: "if",
          cond: predToBool({
            kind: "callValue",
            callee: ref("f.0", fnT),
            args: [getElemExpr(arrT, elem, loc), ref("i.0", F64), ref("a.0", arrT)].slice(0, arity),
            type: fnRet,
            loc,
          }),
          then: [{ kind: "return", value: ref("i.0", F64), loc }],
          else_: null,
          loc,
        },
      ]),
      { kind: "return", value: { kind: "numLit", value: -1, type: F64, loc }, loc },
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: F64,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "f.0", name: "f", type: fnT, mutable: true },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    });
    return name;
  }

/** The some/every loops — short-circuit early returns, JS-exact:
   *
   *   some:  n = a.length; for (...) if (f(a[i])) return true;  return false;
   *   every: n = a.length; for (...) if (!f(a[i])) return false; return true;
   */
  function someEveryHelper(L: Lowerer, method: "some" | "every",
    elem: IrType,
    fnRet: IrType,
    arity: number,
    loc: SrcLoc,): string {
    const key = `${method}:${typeKey(elem)}:${typeKey(fnRet)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.${method}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const fnT = funcOf([elem, F64, arrT].slice(0, arity), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const bool = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
    const callF: IrExpr = predToBool({
      kind: "callValue",
      callee: ref("f.0", fnT),
      args: [getElemExpr(arrT, elem, loc), ref("i.0", F64), ref("a.0", arrT)].slice(0, arity),
      type: fnRet,
      loc,
    });
    const body: IrStmt[] = [
      readLenStmt(arrT, loc),
      countedForLoop(loc, [
        {
          kind: "if",
          cond: method === "some" ? callF : { kind: "unary", op: "!", operand: callF, type: BOOL, loc },
          then: [{ kind: "return", value: bool(method === "some"), loc }],
          else_: null,
          loc,
        },
      ]),
      { kind: "return", value: bool(method !== "some"), loc },
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: BOOL,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "f.0", name: "f", type: fnT, mutable: true },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    });
    return name;
  }

/** `a.flatMap(f)` — map plus a one-level flatten. A callback returning
   * `U[]` appends the returned array's elements per receiver element; a
   * callback returning a non-array U doesn't flatten (JS pushes it as-is),
   * which IS map — those calls share map's interned helper. A union return
   * mixing array and non-array arms would need a per-value flatten decision
   * — fenced. */
  function lowerArrayFlatMapCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    elem: IrType,): IrExpr {
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    const arrT = arrayOf(elem);
    const argNode = call.arguments[0];
    if (!argNode) L.unsupported("SC1090", call, "this call form"); // tsc-guarded
    const { fnArg, arity } = hofCallbackArg(L, argNode, [elem], arrT);
    const fnRet = fnArg.type.ret;
    if (fnRet.kind === "union") {
      const def = L.unions.get(fnRet.unionId);
      if (def?.arms.some((a) => a.kind === "array")) {
        L.unsupported(
          "SC1090",
          argNode,
          "'.flatMap' callbacks returning a union with an array arm (whether one value flattens " +
            "would be a per-element decision — return an array from every path instead)",
        );
      }
    }
    if (fnRet.kind !== "array") {
      // No flatten happens: exactly map's loop, map's helper.
      if (fnRet.kind === "void" || fnRet.kind === "func") L.badType(call, L.typeOf(call));
      fenceProducedArrayElem(L, call, "'.flatMap()'", fnRet);
      const helper = arrayHofHelper(L, "map", elem, fnRet, arity, loc);
      return { kind: "call", callee: helper, args: [receiver, fnArg], type: arrayOf(fnRet), loc };
    }
    const helper = flatMapHelper(L, elem, fnRet, arity, loc);
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: fnRet, loc };
  }

/** The flatMap loop (array-returning callback), from existing IR nodes:
   *
   *   out = []; n = a.length;
   *   for (i = 0; i < n; i++) {
   *     r = f(a[i]); m = r.length;
   *     for (j = 0; j < m; j++) out.push(r[j]);
   *   }
   *   return out;
   */
  function flatMapHelper(L: Lowerer, elem: IrType,
    fnRet: IrType & { kind: "array" },
    arity: number,
    loc: SrcLoc,): string {
    const key = `flatMap:${typeKey(elem)}:${typeKey(fnRet)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.flatMap.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const inner = fnRet.elem;
    const fnT = funcOf([elem, F64, arrT].slice(0, arity), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const innerLoop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: "j.0", init: num(0), loc },
      cond: { kind: "bin", op: "<", left: ref("j.0", F64), right: ref("m.0", F64), type: BOOL, loc },
      update: {
        kind: "assign",
        localId: "j.0",
        value: { kind: "bin", op: "+", left: ref("j.0", F64), right: num(1), type: F64, loc },
        loc,
      },
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "arrIntrinsic",
            method: "push",
            receiver: ref("out.0", fnRet),
            args: [{ kind: "arrayGet", arr: ref("r.0", fnRet), index: ref("j.0", F64), type: inner, loc }],
            type: F64,
            loc,
          },
          loc,
        },
      ],
      loc,
    };
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: fnRet, loc }, loc },
      readLenStmt(arrT, loc),
      countedForLoop(loc, [
        {
          kind: "varDecl",
          localId: "r.0",
          init: {
            kind: "callValue",
            callee: ref("f.0", fnT),
            args: [getElemExpr(arrT, elem, loc), ref("i.0", F64), ref("a.0", arrT)].slice(0, arity),
            type: fnRet,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: "m.0",
          init: { kind: "arrIntrinsic", method: "length", receiver: ref("r.0", fnRet), args: [], type: F64, loc },
          loc,
        },
        innerLoop,
      ]),
      { kind: "return", value: ref("out.0", fnRet), loc },
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: fnRet,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "f.0", name: "f", type: fnT, mutable: true },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "out.0", name: "out", type: fnRet, mutable: false },
        { id: "r.0", name: "r", type: fnRet, mutable: false },
        { id: "m.0", name: "m", type: F64, mutable: false },
        { id: "j.0", name: "j", type: F64, mutable: true },
      ],
      body,
      loc,
    });
    return name;
  }

/** `a.reduce(f)` / `a.reduce(f, init)` and reduceRight — both declared
   * forms. The accumulator type is the call's own checked result: U with an
   * initial value, the element type without one. The callback may declare
   * any prefix of (acc, element, index, array). Without an initial value an
   * empty receiver throws Node's exact TypeError at runtime. */
  function lowerArrayReduceCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    method: "reduce" | "reduceRight",
    elem: IrType,): IrExpr {
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    const arrT = arrayOf(elem);
    const argNode = call.arguments[0];
    if (!argNode) L.unsupported("SC1090", call, "this call form"); // tsc-guarded
    const hasInit = call.arguments.length === 2;
    const accT = hasInit ? L.irTypeOf(call) : elem;
    if (accT.kind === "void" || accT.kind === "func") L.badType(call, L.typeOf(call));
    const { fnArg, arity } = hofCallbackArg(L, argNode, [accT, elem], arrT);
    if (!typeEquals(fnArg.type.ret, accT)) L.badType(argNode, L.typeOf(argNode));
    const helper = reduceHelper(L, method, elem, accT, arity, hasInit, loc);
    const args: IrExpr[] = [receiver, fnArg];
    if (hasInit) args.push(L.lowerExprExpecting(call.arguments[1]!, accT));
    return { kind: "call", callee: helper, args, type: accT, loc };
  }

/** The reduce/reduceRight loops, from existing IR nodes:
   *
   *   with init:    acc = z; n = a.length; for (...) acc = f(acc, a[i]); return acc;
   *   without init: n = a.length;
   *                 if (n === 0) throw new TypeError("Reduce of empty array with no initial value");
   *                 acc = a[<first>]; for (<rest>) acc = f(acc, a[i]); return acc;
   *
   * reduce walks 0→n-1, reduceRight n-1→0; the seed without an initial
   * value is a[0] / a[n-1] and the loop starts one past it. The empty-array
   * TypeError message is Node's, byte for byte. */
  function reduceHelper(L: Lowerer, method: "reduce" | "reduceRight",
    elem: IrType,
    accT: IrType,
    arity: number,
    hasInit: boolean,
    loc: SrcLoc,): string {
    const key = `${method}:${typeKey(elem)}:${typeKey(accT)}:${arity}:${hasInit ? "init" : "seed"}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.${method}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const fnT = funcOf([accT, elem, F64, arrT].slice(0, arity), accT);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const n = ref("n.0", F64);
    const i = ref("i.0", F64);
    const right = method === "reduceRight";
    const at = (index: IrExpr): IrExpr => ({ kind: "arrayGet", arr: ref("a.0", arrT), index, type: elem, loc });
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      ...(hasInit ? [{ id: "z.0", name: "z", type: accT, mutable: true } as IrLocal] : []),
      { id: "acc.0", name: "acc", type: accT, mutable: true },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ];
    const params: IrParam[] = [
      { localId: "a.0", name: "a", type: arrT },
      { localId: "f.0", name: "f", type: fnT },
      ...(hasInit ? [{ localId: "z.0", name: "z", type: accT }] : []),
    ];
    const seedStmts: IrStmt[] = hasInit
      ? [{ kind: "varDecl", localId: "acc.0", init: ref("z.0", accT), loc }]
      : [
          {
            kind: "if",
            cond: { kind: "bin", op: "===", left: n, right: num(0), type: BOOL, loc },
            then: [
              {
                kind: "throw",
                value: {
                  kind: "libCall",
                  fn: "error.new",
                  args: [
                    {
                      kind: "strLit",
                      value: "Reduce of empty array with no initial value",
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
            else_: null,
            loc,
          },
          {
            kind: "varDecl",
            localId: "acc.0",
            init: at(right ? { kind: "bin", op: "-", left: n, right: num(1), type: F64, loc } : num(0)),
            loc,
          },
        ];
    // Loop bounds: with init the walk covers every index; the seeded form
    // starts one past the seed. reduce ascends, reduceRight descends.
    const start: IrExpr = right
      ? { kind: "bin", op: "-", left: n, right: num(hasInit ? 1 : 2), type: F64, loc }
      : num(hasInit ? 0 : 1);
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: start, loc },
      cond: right
        ? { kind: "bin", op: ">=", left: i, right: num(0), type: BOOL, loc }
        : { kind: "bin", op: "<", left: i, right: n, type: BOOL, loc },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: right ? "-" : "+", left: i, right: num(1), type: F64, loc },
        loc,
      },
      body: [
        {
          kind: "assign",
          localId: "acc.0",
          value: {
            kind: "callValue",
            callee: ref("f.0", fnT),
            args: [ref("acc.0", accT), at(i), i, ref("a.0", arrT)].slice(0, arity),
            type: accT,
            loc,
          },
          loc,
        },
      ],
      loc,
    };
    const body: IrStmt[] = [
      readLenStmt(arrT, loc),
      ...seedStmts,
      loop,
      { kind: "return", value: ref("acc.0", accT), loc },
    ];
    L.liftedFns.push({ name, params, returnType: accT, locals, body, loc });
    return name;
  }

/** `a.sort(cmp)` / `a.toSorted(cmp)`, desugared to an interned synthetic
   * function like the other array HOFs. sort mutates and returns the receiver;
   * toSorted takes its shallow snapshot INSIDE the helper, after the receiver
   * and comparator expressions have both been evaluated, then sorts and
   * returns that copy without touching the receiver. The loop is a
   * binary-free INSERTION sort: stable (equal-comparing elements keep their
   * source order, which is what Node's stable TimSort produces for any
   * consistent comparator) and JS-faithful on the comparator contract — an
   * element moves left only while cmp(left, v) > 0, so a NaN or 0 result holds
   * position exactly like the spec's "treat as equal". The SEQUENCE of
   * comparator calls differs from V8's TimSort (SEMANTICS.md); results are
   * identical for consistent comparators. The comparator-less form lowers for
   * STRING elements only — JS's default converts every element to string and
   * compares UTF-16 units, so the interned synthesized comparator selects the
   * runtime's code-unit ordering rather than scriptc's documented code-point
   * relational operators. For numbers that default is the notorious string
   * sort ([10, 9, 1] → [1, 10, 9]), deliberately fenced toward an explicit
   * comparator. */
  function lowerArraySortCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    elem: IrType,
    arrT: IrType & { kind: "array" },): IrExpr {
    const loc = locOf(call);
    const method = access.name.text === "toSorted" ? "toSorted" : "sort";
    const copyFirst = method === "toSorted";
    if (call.arguments.length === 0 && elem.kind === "string") {
      const receiver = L.lowerExpr(access.expression);
      const cmp = defaultStringCmpHelper(L, loc);
      const fnT = funcOf([STRING, STRING], F64);
      const key = `${method}:${typeKey(STRING)}:2`;
      let helper = L.arrHofHelpers.get(key);
      if (!helper) {
        helper = `%arr.${method}.${L.arrHofHelpers.size}`;
        L.arrHofHelpers.set(key, helper);
        L.liftedFns.push(buildArraySortFn(helper, STRING, 2, copyFirst, null, loc));
      }
      const fnArg: IrExpr = { kind: "closure", fnName: cmp, captures: [], type: fnT, loc };
      return { kind: "call", callee: helper, args: [receiver, fnArg], type: arrT, loc };
    }
    if (call.arguments.length !== 1) {
      L.noLowering(
        `.${method} with ${call.arguments.length} arguments`,
        call,
        "the default string-conversion ordering lowers only for string[] — pass a comparator: " +
          `${method}((a, b) => a - b) for numbers`,
      );
    }
    const receiver = L.lowerExpr(access.expression);
    const argNode = call.arguments[0]!;
    const fnArg = L.lowerExpr(argNode);
    // The comparator receives exactly (a, b); declaring a prefix is
    // ordinary TS. Its result must be number (the spec coerces arbitrary
    // results — no lowering for that).
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > 2 ||
      !fnArg.type.params.every((p) => typeEquals(p, elem)) ||
      fnArg.type.ret.kind !== "f64"
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    const arity = fnArg.type.params.length;
    const key = `${method}:${typeKey(elem)}:${arity}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%arr.${method}.${L.arrHofHelpers.size}`;
      L.arrHofHelpers.set(key, helper);
      const undefinedTag =
        elem.kind === "union" ? L.armTag(elem.unionId, UNDEFINED_T) : -1;
      L.liftedFns.push(
        buildArraySortFn(
          helper,
          elem,
          arity,
          copyFirst,
          undefinedTag >= 0 ? undefinedTag : null,
          loc,
        ),
      );
    }
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: arrT, loc };
  }

/** JS's default sort comparator for STRING elements, interned once:
   *
   *   (a, b) => a < b ? -1 : a > b ? 1 : 0
   *
   * The dedicated UTF-16 comparison flag keeps this exact across
   * supplementary-plane code points and U+E000..U+FFFF, where the runtime's
   * ordinary code-point relational order deliberately differs. */
  function defaultStringCmpHelper(L: Lowerer, loc: SrcLoc): string {
    const key = "sortCmpStr";
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.sortCmpStr`;
    L.arrHofHelpers.set(key, name);
    const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const cmp = (op: "<" | ">"): IrExpr => ({
      kind: "strCmp", op, left: ref("a.0"), right: ref("b.0"), utf16: true, type: BOOL, loc,
    });
    const body: IrStmt[] = [
      {
        kind: "return",
        value: {
          kind: "ternary",
          cond: cmp("<"),
          then: num(-1),
          else_: { kind: "ternary", cond: cmp(">"), then: num(1), else_: num(0), type: F64, loc },
          type: F64,
          loc,
        },
        loc,
      },
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: STRING },
        { localId: "b.0", name: "b", type: STRING },
      ],
      returnType: F64,
      locals: [
        { id: "a.0", name: "a", type: STRING, mutable: true },
        { id: "b.0", name: "b", type: STRING, mutable: true },
      ],
      body,
      loc,
    });
    return name;
  }

/** The insertion-sort loop, from existing IR nodes:
   *
   *   n = a.length;
    *   for (i = 1; i < n; i++) {
    *     v = a[i]; j = i - 1;
    *     while (j >= 0) {
    *       if (CompareArrayElements(a[j], v, f) > 0) {
    *         a[j + 1] = a[j]; j = j - 1;
    *       } else break;
   *     }
   *     a[j + 1] = v;
   *   }
   *   return a;
   */
  function buildArraySortFn(
    name: string,
    elem: IrType,
    arity: number,
    copyFirst: boolean,
    undefinedTag: number | null,
    loc: SrcLoc,
  ): IrFunction {
    const arrT = arrayOf(elem);
    const fnT = funcOf([elem, elem].slice(0, arity), F64);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const j = ref("j.0", F64);
    const at = (index: IrExpr): IrExpr => ({ kind: "arrayGet", arr: ref("a.0", arrT), index, type: elem, loc });
    const jPlus1: IrExpr = { kind: "bin", op: "+", left: j, right: num(1), type: F64, loc };
    const isUndefined = (value: IrExpr): IrExpr | null => {
      if (elem.kind === "union" && undefinedTag !== null) {
        return {
          kind: "unionIsTag",
          unionId: elem.unionId,
          tag: undefinedTag,
          negated: false,
          value,
          type: BOOL,
          loc,
        };
      }
      if (elem.kind === "jsval") {
        return {
          kind: "jsOp",
          op: "eq",
          args: [
            value,
            { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc },
          ],
          type: BOOL,
          loc,
        };
      }
      return null;
    };
    const compareGreater: IrExpr = {
      kind: "bin",
      op: ">",
      left: {
        kind: "callValue",
        callee: ref("f.0", fnT),
        args: [at(j), ref("v.0", elem)].slice(0, arity),
        type: F64,
        loc,
      },
      right: num(0),
      type: BOOL,
      loc,
    };
    const leftUndefined = isUndefined(at(j));
    const valueUndefined = isUndefined(ref("v.0", elem));
    // CompareArrayElements: undefined always sinks and never reaches the
    // user comparator. Ternaries preserve that callback suppression.
    const shouldShift: IrExpr =
      leftUndefined !== null && valueUndefined !== null
        ? {
            kind: "ternary",
            cond: leftUndefined,
            then: {
              kind: "unary",
              op: "!",
              operand: valueUndefined,
              type: BOOL,
              loc,
            },
            else_: {
              kind: "ternary",
              cond: valueUndefined,
              then: { kind: "boolLit", value: false, type: BOOL, loc },
              else_: compareGreater,
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          }
        : compareGreater;
    const shiftLoop: IrStmt = {
      kind: "while",
      cond: { kind: "bin", op: ">=", left: j, right: num(0), type: BOOL, loc },
      body: [
        {
          kind: "if",
          cond: shouldShift,
          then: [
            { kind: "arraySet", arr: ref("a.0", arrT), index: jPlus1, value: at(j), loc },
            { kind: "assign", localId: "j.0", value: { kind: "bin", op: "-", left: j, right: num(1), type: F64, loc }, loc },
          ],
          else_: [{ kind: "break", loc }],
          loc,
        },
      ],
      loc,
    };
    const body: IrStmt[] = [
      ...(copyFirst
        ? [{
            kind: "assign" as const,
            localId: "a.0",
            value: {
              kind: "arrIntrinsic" as const,
              method: "slice" as const,
              receiver: ref("a.0", arrT),
              args: [],
              type: arrT,
              loc,
            },
            loc,
          }]
        : []),
      readLenStmt(arrT, loc),
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(1), loc },
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: ref("n.0", F64), type: BOOL, loc },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          { kind: "varDecl", localId: "v.0", init: getElemExpr(arrT, elem, loc), loc },
          { kind: "varDecl", localId: "j.0", init: { kind: "bin", op: "-", left: ref("i.0", F64), right: num(1), type: F64, loc }, loc },
          shiftLoop,
          { kind: "arraySet", arr: ref("a.0", arrT), index: jPlus1, value: ref("v.0", elem), loc },
        ],
        loc,
      },
      { kind: "return", value: ref("a.0", arrT), loc },
    ];
    return {
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: arrT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "f.0", name: "f", type: fnT, mutable: true },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "v.0", name: "v", type: elem, mutable: false },
        { id: "j.0", name: "j", type: F64, mutable: true },
      ],
      body,
      loc,
    };
  }

/** Uint8Array.prototype.toSorted. The receiver/comparator expressions are
 * evaluated before entering the helper; the helper snapshots with
 * TypedArray.prototype.slice before its first comparison, then performs
 * the same stable insertion walk as Array.toSorted. Uint8Array's default
 * comparator is numeric ascending, so its comparator-less form needs no
 * string-conversion machinery. */
  function lowerBytesToSortedCall(
    L: Lowerer,
    call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    bytesT: IrType & { kind: "bytes" },
  ): IrExpr {
    const loc = locOf(call);
    if (call.arguments.length > 1 || call.arguments.some(ts.isSpreadElement)) {
      L.noLowering(`.toSorted with ${call.arguments.length} arguments on Uint8Array`, call);
    }
    const receiver = L.lowerExpr(access.expression);
    const undefinedArg = call.arguments[0]
      ? lowerStaticallyUndefinedArg(L, call.arguments[0])
      : null;
    if (call.arguments.length === 0 || undefinedArg) {
      const key = "bytes.toSorted:u8:default";
      let helper = L.arrHofHelpers.get(key);
      if (!helper) {
        helper = `%bytes.toSorted.${L.arrHofHelpers.size}`;
        L.arrHofHelpers.set(key, helper);
        L.liftedFns.push(buildBytesSortFn(helper, 0, false, loc));
      }
      if (!undefinedArg || droppableStatic(undefinedArg)) {
        return { kind: "call", callee: helper, args: [receiver], type: bytesT, loc };
      }
      // The default helper takes no comparator argument. Snapshot the
      // receiver into a hidden local so the discarded undefined argument
      // still evaluates after the receiver and before the helper call.
      const saved = L.declareHiddenLocal("%bytesSortRecv", bytesT);
      const savedRef: IrExpr = {
        kind: "varRef",
        localId: saved.id,
        type: bytesT,
        loc,
      };
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: saved.id, init: receiver, loc },
          { kind: "exprStmt", expr: undefinedArg, loc: undefinedArg.loc },
        ],
        result: {
          kind: "call",
          callee: helper,
          args: [savedRef],
          type: bytesT,
          loc,
        },
        type: bytesT,
        loc,
      };
    }
    const argNode = call.arguments[0]!;
    const fnArg = L.lowerExpr(argNode);
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > 2 ||
      !fnArg.type.params.every((p) => p.kind === "f64") ||
      fnArg.type.ret.kind !== "f64"
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    const arity = fnArg.type.params.length;
    const key = `bytes.toSorted:u8:${arity}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%bytes.toSorted.${L.arrHofHelpers.size}`;
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push(buildBytesSortFn(helper, arity, true, loc));
    }
    return {
      kind: "call",
      callee: helper,
      args: [receiver, fnArg],
      type: bytesT,
      loc,
    };
  }

  function buildBytesSortFn(
    name: string,
    arity: number,
    hasComparator: boolean,
    loc: SrcLoc,
  ): IrFunction {
    const bytesT = BYTES_U8;
    const fnT = funcOf([F64, F64].slice(0, arity), F64);
    const ref = (localId: string, type: IrType): IrExpr => ({
      kind: "varRef",
      localId,
      type,
      loc,
    });
    const num = (value: number): IrExpr => ({
      kind: "numLit",
      value,
      type: F64,
      loc,
    });
    const j = ref("j.0", F64);
    const at = (index: IrExpr): IrExpr => ({
      kind: "bytesIntrinsic",
      method: "get",
      receiver: ref("a.0", bytesT),
      args: [index],
      type: F64,
      loc,
    });
    const jPlus1: IrExpr = {
      kind: "bin",
      op: "+",
      left: j,
      right: num(1),
      type: F64,
      loc,
    };
    const compare: IrExpr = hasComparator
      ? {
          kind: "callValue",
          callee: ref("f.0", fnT),
          args: [at(j), ref("v.0", F64)].slice(0, arity),
          type: F64,
          loc,
        }
      : {
          kind: "bin",
          op: "-",
          left: at(j),
          right: ref("v.0", F64),
          type: F64,
          loc,
        };
    const shiftLoop: IrStmt = {
      kind: "while",
      cond: {
        kind: "bin",
        op: ">=",
        left: j,
        right: num(0),
        type: BOOL,
        loc,
      },
      body: [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: ">",
            left: compare,
            right: num(0),
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "bytesSet",
              arr: ref("a.0", bytesT),
              index: jPlus1,
              value: at(j),
              loc,
            },
            {
              kind: "assign",
              localId: "j.0",
              value: {
                kind: "bin",
                op: "-",
                left: j,
                right: num(1),
                type: F64,
                loc,
              },
              loc,
            },
          ],
          else_: [{ kind: "break", loc }],
          loc,
        },
      ],
      loc,
    };
    const params: IrParam[] = [
      { localId: "a.0", name: "a", type: bytesT },
      ...(hasComparator
        ? [{ localId: "f.0", name: "f", type: fnT }]
        : []),
    ];
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: bytesT, mutable: true },
      ...(hasComparator
        ? [{ id: "f.0", name: "f", type: fnT, mutable: true }]
        : []),
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "v.0", name: "v", type: F64, mutable: false },
      { id: "j.0", name: "j", type: F64, mutable: true },
    ];
    const body: IrStmt[] = [
      {
        kind: "assign",
        localId: "a.0",
        value: {
          kind: "bytesIntrinsic",
          method: "slice",
          receiver: ref("a.0", bytesT),
          args: [],
          type: bytesT,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "n.0",
        init: {
          kind: "bytesIntrinsic",
          method: "length",
          receiver: ref("a.0", bytesT),
          args: [],
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "for",
        init: {
          kind: "varDecl",
          localId: "i.0",
          init: num(1),
          loc,
        },
        cond: {
          kind: "bin",
          op: "<",
          left: ref("i.0", F64),
          right: ref("n.0", F64),
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: "i.0",
          value: {
            kind: "bin",
            op: "+",
            left: ref("i.0", F64),
            right: num(1),
            type: F64,
            loc,
          },
          loc,
        },
        body: [
          {
            kind: "varDecl",
            localId: "v.0",
            init: at(ref("i.0", F64)),
            loc,
          },
          {
            kind: "varDecl",
            localId: "j.0",
            init: {
              kind: "bin",
              op: "-",
              left: ref("i.0", F64),
              right: num(1),
              type: F64,
              loc,
            },
            loc,
          },
          shiftLoop,
          {
            kind: "bytesSet",
            arr: ref("a.0", bytesT),
            index: jPlus1,
            value: ref("v.0", F64),
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("a.0", bytesT), loc },
    ];
    return {
      name,
      params,
      returnType: bytesT,
      locals,
      body,
      loc,
    };
  }

/** `n = a.length` — the once-up-front length read every array HOF loop
   * starts with (locals a.0/n.0 by convention). */
  function readLenStmt(arrT: IrType, loc: SrcLoc): IrStmt {
    return {
      kind: "varDecl",
      localId: "n.0",
      init: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: { kind: "varRef", localId: "a.0", type: arrT, loc },
        args: [],
        type: F64,
        loc,
      },
      loc,
    };
  }

/** `a[i]` inside a HOF loop (locals a.0/i.0 by convention). */
  function getElemExpr(arrT: IrType, elem: IrType, loc: SrcLoc): IrExpr {
    return {
      kind: "arrayGet",
      arr: { kind: "varRef", localId: "a.0", type: arrT, loc },
      index: { kind: "varRef", localId: "i.0", type: F64, loc },
      type: elem,
      loc,
    };
  }

/** `for (i = 0; i < n; i++) { ...body }` over the conventional locals. */
  function countedForLoop(loc: SrcLoc, body: IrStmt[]): IrStmt {
    const i: IrExpr = { kind: "varRef", localId: "i.0", type: F64, loc };
    return {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: { kind: "numLit", value: 0, type: F64, loc }, loc },
      cond: {
        kind: "bin",
        op: "<",
        left: i,
        right: { kind: "varRef", localId: "n.0", type: F64, loc },
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: "+", left: i, right: { kind: "numLit", value: 1, type: F64, loc }, type: F64, loc },
        loc,
      },
      body,
      loc,
    };
  }

/** `for (i = n - 1; i >= 0; i--) { ...body }` over the conventional locals
   * — countedForLoop walked backwards (the findLast pair's descending
   * index walk). */
  function reverseCountedForLoop(loc: SrcLoc, body: IrStmt[]): IrStmt {
    const i: IrExpr = { kind: "varRef", localId: "i.0", type: F64, loc };
    const one: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
    return {
      kind: "for",
      init: {
        kind: "varDecl",
        localId: "i.0",
        init: { kind: "bin", op: "-", left: { kind: "varRef", localId: "n.0", type: F64, loc }, right: one, type: F64, loc },
        loc,
      },
      cond: {
        kind: "bin",
        op: ">=",
        left: i,
        right: { kind: "numLit", value: 0, type: F64, loc },
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: "-", left: i, right: one, type: F64, loc },
        loc,
      },
      body,
      loc,
    };
  }

/** `a.at(i)` — the es2022 relative-index read. Desugars to an interned
   * helper over existing IR nodes, ToIntegerOrInfinity-exact: the index
   * truncates toward zero (floor for non-negatives, mirrored floor for
   * negatives, NaN → 0), negatives wrap by the length once, and anything
   * still outside [0, n) answers the undefined arm — never a bounds throw.
   * The result is the checker's own `T | undefined` union, the find
   * machinery's wrap rules (an undefined-armed element type passes
   * through). */
  function lowerArrayAtCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    elem: IrType,): IrExpr {
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    const index = L.lowerExprExpecting(call.arguments[0]!, F64);
    const resultT = L.irTypeOf(call);
    if (resultT.kind !== "union") L.badType(call, L.typeOf(call)); // defensive: T | undefined always maps to a union
    const undefTag = L.armTag(resultT.unionId, UNDEFINED_T);
    if (undefTag < 0) L.badType(call, L.typeOf(call));
    let foundTag: number | null = null;
    if (!typeEquals(resultT, elem)) {
      foundTag = L.armTag(resultT.unionId, elem);
      if (foundTag < 0) {
        L.unsupported(
          "SC1090",
          call,
          `'.at' on '${L.fmt(elem)}'-element arrays (the element would need a union ` +
            "re-tag that is not supported yet — index and test instead)",
        );
      }
    }
    const key = `at:${typeKey(elem)}:${typeKey(resultT)}`;
    let name = L.arrHofHelpers.get(key);
    if (!name) {
      name = `%arr.at.${L.arrHofHelpers.size}`;
      L.arrHofHelpers.set(key, name);
      const arrT = arrayOf(elem);
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const t = ref("t.0", F64);
      const i = ref("i.0", F64);
      const n = ref("n.0", F64);
      const v = ref("v.0", elem);
      const found: IrExpr =
        foundTag === null
          ? v
          : { kind: "unionWrap", unionId: resultT.unionId, tag: foundTag, value: v, type: resultT, loc };
      const miss: IrExpr = {
        kind: "unionWrap",
        unionId: resultT.unionId,
        tag: undefTag,
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: resultT,
        loc,
      };
      const floorOf = (e: IrExpr): IrExpr => ({ kind: "libCall", fn: "math.floor", args: [e], type: F64, loc });
      const lt = (l: IrExpr, r: IrExpr): IrExpr => ({ kind: "bin", op: "<", left: l, right: r, type: BOOL, loc });
      const body: IrStmt[] = [
        readLenStmt(arrT, loc),
        // ToIntegerOrInfinity: floor is trunc for i >= 0; negatives mirror
        // (trunc(i) = -floor(-i)); NaN becomes 0. ±Infinity floors to
        // itself and falls out of range below, exactly the spec.
        { kind: "varDecl", localId: "t.0", init: floorOf(i), loc },
        {
          kind: "if",
          cond: lt(i, num(0)),
          then: [{ kind: "assign", localId: "t.0", value: { kind: "bin", op: "-", left: num(0), right: floorOf({ kind: "bin", op: "-", left: num(0), right: i, type: F64, loc }), type: F64, loc }, loc }],
          else_: null,
          loc,
        },
        {
          kind: "if",
          cond: { kind: "libCall", fn: "num.isNaN", args: [i], type: BOOL, loc },
          then: [{ kind: "assign", localId: "t.0", value: num(0), loc }],
          else_: null,
          loc,
        },
        {
          kind: "if",
          cond: lt(t, num(0)),
          then: [{ kind: "assign", localId: "t.0", value: { kind: "bin", op: "+", left: t, right: n, type: F64, loc }, loc }],
          else_: null,
          loc,
        },
        {
          kind: "if",
          cond: lt(t, num(0)),
          then: [{ kind: "return", value: miss, loc }],
          else_: null,
          loc,
        },
        {
          kind: "if",
          cond: { kind: "bin", op: ">=", left: t, right: n, type: BOOL, loc },
          then: [{ kind: "return", value: miss, loc }],
          else_: null,
          loc,
        },
        {
          kind: "varDecl",
          localId: "v.0",
          init: { kind: "arrayGet", arr: ref("a.0", arrT), index: t, type: elem, loc },
          loc,
        },
        { kind: "return", value: found, loc },
      ];
      L.liftedFns.push({
        name,
        params: [
          { localId: "a.0", name: "a", type: arrT },
          { localId: "i.0", name: "i", type: F64 },
        ],
        returnType: resultT,
        locals: [
          { id: "a.0", name: "a", type: arrT, mutable: true },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "n.0", name: "n", type: F64, mutable: false },
          { id: "t.0", name: "t", type: F64, mutable: true },
          { id: "v.0", name: "v", type: elem, mutable: false },
        ],
        body,
        loc,
      });
    }
    return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
  }

/** `Array.from({ length: n }, mapfn)` — the counted-generation idiom — on
   * THE stdlib Array global. The source must be an OBJECT LITERAL whose
   * single property is `length` (the shape the idiom always spells; the
   * ArrayLike record never exists as a value). Desugars to an interned
   * synthetic loop calling the mapper with (undefined, i) exactly like JS —
   * the first argument is the dyn undefined singleton, matching the
   * checker's own `unknown` for it — and pushing each result. The loop
   * bound is `i <= n - 1`, which IS ToLength for the finite lengths that
   * terminate (fractional lengths truncate, negative/NaN produce an empty
   * array — Node-exact). Every other Array.from shape (arrays, iterables,
   * no mapper) keeps the fence. Null when the callee isn't an
   * Array-static access. */
  export function lowerArrayFromCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!L.isStdlibGlobal(access.expression, "Array")) return null;
    if (access.name.text !== "from") return null;
    const loc = locOf(call);
    const args = call.arguments;
    // MAPPER-LESS `Array.from({ length: n })` (usually with an explicit
    // type argument — the pMap results-array idiom): a length-n array of
    // ABSENT slots, filled by index before any read. Union elements with
    // an undefined arm hold the interned undefined (JS-exact); other
    // refcounted elements hold NULL and must be assigned before they are
    // read (SEMANTICS.md 46). Scalar elements have no absent value that
    // isn't a LIE on read (0 where Node says undefined) — fenced.
    if (args.length === 1 && ts.isObjectLiteralExpression(args[0]!) && args[0]!.properties.length === 1) {
      const n = lowerLengthProp(L, args[0]!.properties[0]!);
      if (n) {
        if (n.type.kind !== "f64") L.badType(args[0]!, L.typeOf(args[0]!));
        const arrT = L.mapTypeOf(L.typeOf(call));
        if (arrT?.kind !== "array") L.badType(call, L.typeOf(call));
        const elem = arrT.elem;
        const absent =
          elem.kind === "union" ? L.wrappedUndefined(elem, loc) !== null : isRefCounted(elem);
        if (!absent) {
          L.noLowering(
            `mapper-less Array.from({ length: n }) with '${L.fmt(elem)}' elements`,
            call,
            "scalar slots would read 0/false/\"\" where Node reads undefined — " +
              "pass a mapper (Array.from({ length: n }, () => init)) instead",
          );
        }
        return { kind: "arrayNewLen", length: n, type: arrT, loc };
      }
    }
    // `Array.from(s)` on a STRING: the string iterator's code-point walk
    // into a fresh string[] (astral characters stay whole, where a
    // charAt/index walk would truncate the surrogate halves) — the same
    // interned helper `[...s]` lowers through.
    if (args.length === 1 && !ts.isObjectLiteralExpression(args[0]!)) {
      const src = L.lowerExpr(args[0]!);
      if (src.type.kind === "string") return strCharsCall(L, src, loc);
      L.noLowering(
        "Array.from with this argument shape",
        call,
        "Array.from({ length: n }, (v, i) => ...) and Array.from(aString) are the lowered " +
          "forms — copy arrays with [...a] and drain Map/Set iterators where they are made",
      );
    }
    const n =
      args.length === 2 && ts.isObjectLiteralExpression(args[0]!) && args[0]!.properties.length === 1
        ? lowerLengthProp(L, args[0]!.properties[0]!)
        : null;
    if (!n) {
      L.noLowering(
        "Array.from with this argument shape",
        call,
        "Array.from({ length: n }, (v, i) => ...) is the lowered form — copy arrays " +
          "with [...a] and drain Map/Set iterators where they are made",
      );
    }
    if (n.type.kind !== "f64") L.badType(args[0]!, L.typeOf(args[0]!));
    const fnArg = L.lowerExpr(args[1]!);
    // The mapper may declare any prefix of (v, i): v is the checker's own
    // `unknown` (Node passes undefined there — the dyn undefined singleton
    // here), i the index. The result type must be a legal array element.
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > 2 ||
      (fnArg.type.params.length >= 1 && fnArg.type.params[0]!.kind !== "dyn") ||
      (fnArg.type.params.length === 2 && fnArg.type.params[1]!.kind !== "f64")
    ) {
      L.badType(args[1]!, L.typeOf(args[1]!));
    }
    const fnT = fnArg.type as IrType & { kind: "func" };
    const fnRet = fnT.ret;
    if (fnRet.kind === "void" || fnRet.kind === "func") L.badType(call, L.typeOf(call));
    fenceProducedArrayElem(L, call, "'Array.from({ length }, mapper)'", fnRet);
    const arity = fnT.params.length;
    const key = `fromLen:${typeKey(fnRet)}:${arity}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%arr.fromLen.${L.arrHofHelpers.size}`;
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push(buildArrayFromLenFn(helper, fnRet, arity, loc));
    }
    return { kind: "call", callee: helper, args: [n, fnArg], type: arrayOf(fnRet), loc };
  }

/** `Array.from(s)` / `[...s]` on a STRING: the code-point split into a
   * fresh string[], through one interned helper per module. */
  export function strCharsCall(L: Lowerer, src: IrExpr, loc: SrcLoc): IrExpr {
    const key = "strChars";
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = "%str.chars";
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push(buildStrCharsFn(helper, loc));
    }
    return { kind: "call", callee: helper, args: [src], type: arrayOf(STRING), loc };
  }

/** The code-point split, from existing IR nodes — the string for-of
   * desugar's UTF-16 cursor as a function:
   *
   *   out = [];
   *   i = 0;
   *   while (i < s.length) { ch = cpAt(s, i); i += ch.length; out.push(ch); }
   *   return out;
   */
  function buildStrCharsFn(name: string, loc: SrcLoc): IrFunction {
    const outT = arrayOf(STRING);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const sLen = (recv: IrExpr): IrExpr => ({ kind: "strIntrinsic", method: "length", receiver: recv, args: [], type: F64, loc });
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
      { kind: "varDecl", localId: "i.0", init: { kind: "numLit", value: 0, type: F64, loc }, loc },
      {
        kind: "while",
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: sLen(ref("s.0", STRING)), type: BOOL, loc },
        body: [
          { kind: "varDecl", localId: "ch.0", init: { kind: "strIntrinsic", method: "cpAt", receiver: ref("s.0", STRING), args: [ref("i.0", F64)], type: STRING, loc }, loc },
          { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: ref("i.0", F64), right: sLen(ref("ch.0", STRING)), type: F64, loc }, loc },
          { kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: ref("out.0", outT), args: [ref("ch.0", STRING)], type: F64, loc }, loc },
        ],
        loc,
      },
      { kind: "return", value: ref("out.0", outT), loc },
    ];
    return {
      name,
      params: [{ localId: "s.0", name: "s", type: STRING }],
      returnType: outT,
      locals: [
        { id: "s.0", name: "s", type: STRING, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "ch.0", name: "ch", type: STRING, mutable: false },
      ],
      body,
      loc,
    };
  }

/** The lowered `length` value of the one-property source literal, or null
   * (shorthand `{ length }` counts — resolved through the shorthand VALUE
   * symbol like any object literal; spreads/accessors/computed names do
   * not). */
  function lowerLengthProp(L: Lowerer, prop: ts.ObjectLiteralElementLike): IrExpr | null {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "length") {
      return L.lowerExprExpecting(prop.initializer, F64);
    }
    if (ts.isShorthandPropertyAssignment(prop) && (prop.name as ts.Identifier).text === "length") {
      return L.lowerShorthandValue(prop);
    }
    return null;
  }

/** The generation loop, from existing IR nodes:
   *
   *   out = [];
   *   for (i = 0; i <= n - 1; i++) out.push(f(undefined, i));
   *   return out;
   */
  function buildArrayFromLenFn(name: string, fnRet: IrType, arity: number, loc: SrcLoc): IrFunction {
    const outT = arrayOf(fnRet);
    const fnT = funcOf([DYN, F64].slice(0, arity), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const undef: IrExpr = {
      kind: "dynFrom",
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: DYN,
      loc,
    };
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: {
          kind: "bin",
          op: "<=",
          left: ref("i.0", F64),
          right: { kind: "bin", op: "-", left: ref("n.0", F64), right: num(1), type: F64, loc },
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: ref("out.0", outT),
              args: [
                {
                  kind: "callValue",
                  callee: ref("f.0", fnT),
                  args: [undef, ref("i.0", F64)].slice(0, arity),
                  type: fnRet,
                  loc,
                },
              ],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("out.0", outT), loc },
    ];
    return {
      name,
      params: [
        { localId: "n.0", name: "n", type: F64 },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: outT,
      locals: [
        { id: "n.0", name: "n", type: F64, mutable: true },
        { id: "f.0", name: "f", type: fnT, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    };
  }

/** Ambient Map method calls. `get`/`set`/`has`/`delete`/`clear` lower to
   * mapIntrinsic; `forEach` desugars to a direct call of a synthetic loop
   * function over the iteration primitives (lowerMapForEachCall). Null when
   * this isn't an ambient Map method call. tsc has already checked arity
   * and argument types against ambient/scriptc.d.ts. */
  export function lowerMapMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    if (!MAP_METHODS.has(name) && !MAP_ITER_METHODS.has(name)) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverIr?.kind !== "map") return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    // The lib's `set` returns the Map (chaining typechecks); the lowered
    // set is a void statement, so a chained receiver has no value — fence
    // it instead of emitting a void receiver.
    if (receiver.type.kind !== "map") {
      L.noLowering(
        "chained Map method calls",
        access.expression,
        "the lowered set() produces no value — call each set(k, v) as its own statement",
      );
    }
    // The lib declares a thisArg parameter on forEach; unlowered — fenced.
    if (name === "forEach" && call.arguments.length !== 1) {
      L.noLowering(
        `.forEach with ${call.arguments.length} arguments`,
        call,
        "the thisArg parameter has no lowering — use an arrow function",
      );
    }

    if (name === "get") {
      const k = L.lowerExprExpecting(call.arguments[0]!, receiverIr.key);
      // The checker types the call `V | undefined`, which interns the
      // result union. `undefined` sorts LAST among all possible arm
      // typeKeys, so when V is itself a union its arms keep their tags in
      // the result union — the backend leans on that (docs/ir.md).
      const type = L.irTypeOf(call);
      if (type.kind !== "union") L.badType(call, L.typeOf(call));
      return { kind: "mapIntrinsic", method: "get", receiver, args: [k], type, loc };
    }
    if (name === "set") {
      const k = L.lowerExprExpecting(call.arguments[0]!, receiverIr.key);
      const v = L.lowerExprExpecting(call.arguments[1]!, receiverIr.value);
      return { kind: "mapIntrinsic", method: "set", receiver, args: [k, v], type: VOID, loc };
    }
    if (name === "has" || name === "delete") {
      const k = L.lowerExprExpecting(call.arguments[0]!, receiverIr.key);
      return { kind: "mapIntrinsic", method: name, receiver, args: [k], type: BOOL, loc };
    }
    if (name === "clear") {
      return { kind: "mapIntrinsic", method: "clear", receiver, args: [], type: VOID, loc };
    }
    if (MAP_ITER_METHODS.has(name)) {
      return lowerMapIterDrainCall(L, call, receiver, receiverIr, name as "keys" | "values" | "entries");
    }
    // forEach
    return L.lowerMapForEachCall(call, receiver, receiverIr);
  }

/** The iterator methods the lowering DOES cover — in exactly one context. */
const MAP_ITER_METHODS = new Set(["keys", "values", "entries"]);

/** `[...m.keys()]` / `[...m.values()]` / `[...m.entries()]` — the iterator
   * methods, lowered ONLY as the operand of a spread inside an array
   * literal, where JS drains the iterator on the spot. The call desugars to
   * a direct call of a synthetic drain function whose loop walks the same
   * iteration primitives as the forEach desugar and pushes each live entry
   * into a fresh array — key, value, or `[K, V]` tuple record per method.
   * No user code runs mid-drain (and nothing here mutates the map), so no
   * compaction can shift indices: the enter/exit bracket is unnecessary and
   * the snapshot IS what JS's immediate drain observes. Every other context
   * (storing the iterator, .next(), passing it along) would need a real
   * iterator value — fenced with the spread spelling as the hint. */
  function lowerMapIterDrainCall(L: Lowerer, call: ts.CallExpression,
    receiver: IrExpr,
    mapT: IrType & { kind: "map" },
    method: "keys" | "values" | "entries",): IrExpr {
    const loc = locOf(call);
    const inArraySpread =
      ts.isSpreadElement(call.parent) && ts.isArrayLiteralExpression(call.parent.parent);
    if (!inArraySpread) {
      L.noLowering(
        `.${method}() outside an immediate array spread`,
        call,
        `iterator objects have no lowering — drain it into an array where it is made: [...m.${method}()]`,
      );
    }
    // The pushed element type. For entries the checker's own element type —
    // the [K, V] tuple behind MapIterator<[K, V]> — carries the interned
    // tuple shape the surrounding literal will intern too.
    let elemT: IrType;
    let tupleT: (IrType & { kind: "record" }) | null = null;
    if (method === "keys") elemT = mapT.key;
    else if (method === "values") elemT = mapT.value;
    else {
      const iterT = L.typeOf(call);
      const targ = L.checker.getTypeArguments(iterT as ts.TypeReference)[0];
      const mapped = targ ? L.mapTypeOf(targ) : null;
      const shape = mapped?.kind === "record" ? L.shapes.get(mapped.shapeId) : null;
      if (
        mapped?.kind !== "record" || !shape?.tuple || shape.fields.length !== 2 ||
        !typeEquals(shape.fields.find((f) => f.name === "0")!.type, mapT.key) ||
        !typeEquals(shape.fields.find((f) => f.name === "1")!.type, mapT.value)
      ) {
        L.badType(call, L.typeOf(call)); // defensive: the lib declares [K, V]
      }
      tupleT = mapped as IrType & { kind: "record" }; // narrowed by the check above
      elemT = tupleT!;
    }
    const key = `${method}:${typeKey(mapT.key)}:${typeKey(mapT.value)}`;
    let helper = L.mapHofHelpers.get(key);
    if (!helper) {
      helper = `%map.${method}.${L.mapHofHelpers.size}`;
      L.mapHofHelpers.set(key, helper);
      L.liftedFns.push(buildMapIterDrainFn(helper, mapT, method, elemT, tupleT, loc));
    }
    return { kind: "call", callee: helper, args: [receiver], type: arrayOf(elemT), loc };
  }

/** The drain loop, from existing IR nodes:
   *
   *   out = [];
   *   for (i = 0; i < m.iterCount; i++) {
   *     if (m.iterLive(i)) out.push(<key | value | [key, value]>);
   *   }
   *   return out;
   */
  function buildMapIterDrainFn(name: string,
    mapT: IrType & { kind: "map" },
    method: "keys" | "values" | "entries",
    elemT: IrType,
    tupleT: (IrType & { kind: "record" }) | null,
    loc: SrcLoc,): IrFunction {
    const outT = arrayOf(elemT);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const iter = (
      m: "iterCount" | "iterLive" | "iterKey" | "iterValue",
      args: IrExpr[],
      type: IrType,
    ): IrExpr => ({ kind: "mapIntrinsic", method: m, receiver: ref("m.0", mapT), args, type, loc });
    const keyRead = iter("iterKey", [ref("i.0", F64)], mapT.key);
    const valRead = iter("iterValue", [ref("i.0", F64)], mapT.value);
    const pushed: IrExpr =
      method === "keys"
        ? keyRead
        : method === "values"
          ? valRead
          : {
              kind: "recordLit",
              fields: [
                { name: "0", value: keyRead },
                { name: "1", value: valRead },
              ],
              type: tupleT!,
              loc,
            };
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: iter("iterCount", [], F64), type: BOOL, loc },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "if",
            cond: iter("iterLive", [ref("i.0", F64)], BOOL),
            then: [
              {
                kind: "exprStmt",
                expr: { kind: "arrIntrinsic", method: "push", receiver: ref("out.0", outT), args: [pushed], type: F64, loc },
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
    return {
      name,
      params: [{ localId: "m.0", name: "m", type: mapT }],
      returnType: outT,
      locals: [
        { id: "m.0", name: "m", type: mapT, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    };
  }

/** `m.forEach(fn)` desugars to a direct call of a synthetic module
   * function — one per key/value type + callback arity, interned — whose
   * body is an index loop over the map's ITERATION PRIMITIVES: read
   * iterCount fresh every pass (entries appended by the callback are
   * visited), skip tombstones with iterLive (deleted entries are skipped),
   * and bracket the loop with iterEnter/iterExit inside try/finally so the
   * runtime never compacts indices out from under it — even when the
   * callback throws. That is JS's live-iteration contract, Node-verified
   * (SEMANTICS.md). The callback receives (value, key) like JS; declaring
   * fewer parameters — (value) or () — is ordinary TS and supported. */
  export function lowerMapForEachCall(L: Lowerer, call: ts.CallExpression,
    receiver: IrExpr,
    mapT: IrType & { kind: "map" },): IrExpr {
    const loc = locOf(call);
    const argNode = call.arguments[0];
    if (!argNode) L.unsupported("SC1090", call, "this call form"); // tsc-guarded
    const fnArg = L.lowerExpr(argNode);
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > 2 ||
      (fnArg.type.params.length >= 1 && !typeEquals(fnArg.type.params[0]!, mapT.value)) ||
      (fnArg.type.params.length === 2 && !typeEquals(fnArg.type.params[1]!, mapT.key))
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    // A void-returning contextual type accepts callbacks returning anything
    // (TS void-assignability), so the callback's ACTUAL return type rides
    // the helper signature — the desugared call discards the result like
    // JS's forEach does.
    const arity = fnArg.type.params.length;
    const fnRet = fnArg.type.ret;
    const key = `${typeKey(mapT.key)}:${typeKey(mapT.value)}:${arity}:${typeKey(fnRet)}`;
    let helper = L.mapHofHelpers.get(key);
    if (!helper) {
      helper = `%map.forEach.${L.mapHofHelpers.size}`;
      L.mapHofHelpers.set(key, helper);
      L.liftedFns.push(L.buildMapForEachFn(helper, mapT, arity, fnRet, loc));
    }
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: VOID, loc };
  }

/** The loop body of the Map.forEach desugar, from existing IR nodes:
   *
   *   m.iterEnter();
   *   try {
   *     for (i = 0; i < m.iterCount; i++) {
   *       if (m.iterLive(i)) { v = m.iterValue(i); k = m.iterKey(i); f(v, k); }
   *     }
   *   } finally { m.iterExit(); }
   *
   * The finally keeps the runtime's iteration depth exact when the callback
   * throws (unwinding runs the finally with the exception pending and
   * propagation resumes — the emitter's standard contract). */
  export function buildMapForEachFn(L: Lowerer, name: string,
    mapT: IrType & { kind: "map" },
    arity: number,
    fnRet: IrType,
    loc: SrcLoc,): IrFunction {
    const fnT = funcOf(
      arity === 0 ? [] : arity === 1 ? [mapT.value] : [mapT.value, mapT.key],
      fnRet,
    );
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const iter = (
      method: "iterCount" | "iterLive" | "iterKey" | "iterValue" | "iterEnter" | "iterExit",
      args: IrExpr[],
      type: IrType,
    ): IrExpr => ({
      kind: "mapIntrinsic",
      method,
      receiver: ref("m.0", mapT),
      args,
      type,
      loc,
    });
    const locals: IrLocal[] = [
      { id: "m.0", name: "m", type: mapT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ];
    const callArgs: IrExpr[] = [];
    const visitBody: IrStmt[] = [];
    if (arity >= 1) {
      locals.push({ id: "v.0", name: "v", type: mapT.value, mutable: false });
      visitBody.push({
        kind: "varDecl",
        localId: "v.0",
        init: iter("iterValue", [ref("i.0", F64)], mapT.value),
        loc,
      });
      callArgs.push(ref("v.0", mapT.value));
    }
    if (arity === 2) {
      locals.push({ id: "k.0", name: "k", type: mapT.key, mutable: false });
      visitBody.push({
        kind: "varDecl",
        localId: "k.0",
        init: iter("iterKey", [ref("i.0", F64)], mapT.key),
        loc,
      });
      callArgs.push(ref("k.0", mapT.key));
    }
    visitBody.push({
      kind: "exprStmt",
      expr: { kind: "callValue", callee: ref("f.0", fnT), args: callArgs, type: fnRet, loc },
      loc,
    });
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: ref("i.0", F64),
        right: iter("iterCount", [], F64),
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
        loc,
      },
      body: [
        {
          kind: "if",
          cond: iter("iterLive", [ref("i.0", F64)], BOOL),
          then: visitBody,
          else_: null,
          loc,
        },
      ],
      loc,
    };
    const body: IrStmt[] = [
      { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
      {
        kind: "tryCatch",
        tryBody: [loop],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }],
        loc,
      },
    ];
    return {
      name,
      params: [
        { localId: "m.0", name: "m", type: mapT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: VOID,
      locals,
      body,
      loc,
    };
  }

/** Ambient Set method calls — Map's lowering with the value slot gone.
   * `add`/`has`/`delete`/`clear` lower to setIntrinsic; `forEach` desugars
   * like Map's over the shared iteration primitives. Null when this isn't
   * an ambient Set method call. */
  export function lowerSetMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    if (!SET_METHODS.has(name) && !SET_COMBINE_METHODS.has(name)) return null;
    let receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    // The identity-Set idiom (JS): the CHECKER type is an unmappable
    // Set<union-of-signatures>, but the VALUE lowered as a real Set of
    // identity tokens (the new-Set probe) — the lowered receiver's type
    // is the honest dispatch key.
    if (receiverIr === null && isJsSourceFile(access.getSourceFile())) {
      const probed = probeLower(L, access.expression);
      if (probed?.type.kind === "set") receiverIr = probed.type;
    }
    if (receiverIr?.kind !== "set") return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    const receiver = L.lowerExpr(access.expression);
    // The lib's `add` returns the Set (chaining typechecks); the lowered
    // add is a void statement — fence chained receivers like Map's set.
    if (receiver.type.kind !== "set") {
      L.noLowering(
        "chained Set method calls",
        access.expression,
        "the lowered add() produces no value — call each add(v) as its own statement",
      );
    }
    if (name === "forEach" && call.arguments.length !== 1) {
      L.noLowering(
        `.forEach with ${call.arguments.length} arguments`,
        call,
        "the thisArg parameter has no lowering — use an arrow function",
      );
    }
    if (SET_COMBINE_METHODS.has(name)) {
      return lowerSetCombineCall(L, call, name, receiver, receiverIr);
    }
    if (name === "add") {
      const v = L.lowerExprExpecting(call.arguments[0]!, receiverIr.elem);
      return { kind: "setIntrinsic", method: "add", receiver, args: [v], type: VOID, loc };
    }
    if (name === "has" || name === "delete") {
      const v = L.lowerExprExpecting(call.arguments[0]!, receiverIr.elem);
      return { kind: "setIntrinsic", method: name, receiver, args: [v], type: BOOL, loc };
    }
    if (name === "clear") {
      return { kind: "setIntrinsic", method: "clear", receiver, args: [], type: VOID, loc };
    }
    // forEach
    return L.lowerSetForEachCall(call, receiver, receiverIr);
  }

/** `s.forEach(fn)` — Map's desugar shape over the set primitives. JS
   * passes (value, value, set): the second parameter IS the element again,
   * so both one- and two-parameter callbacks receive elem-typed arguments
   * (iterKey read once, passed twice). Same live-iteration bracketing. */
  export function lowerSetForEachCall(L: Lowerer, call: ts.CallExpression,
    receiver: IrExpr,
    setT: IrType & { kind: "set" },): IrExpr {
    const loc = locOf(call);
    const argNode = call.arguments[0];
    if (!argNode) L.unsupported("SC1090", call, "this call form"); // tsc-guarded
    const fnArg = L.lowerExpr(argNode);
    if (
      fnArg.type.kind !== "func" ||
      fnArg.type.params.length > 2 ||
      !fnArg.type.params.every((p) => typeEquals(p, setT.elem))
    ) {
      L.badType(argNode, L.typeOf(argNode));
    }
    const arity = fnArg.type.params.length;
    const fnRet = fnArg.type.ret;
    const key = `${typeKey(setT.elem)}:${arity}:${typeKey(fnRet)}`;
    let helper = L.setHofHelpers.get(key);
    if (!helper) {
      helper = `%set.forEach.${L.setHofHelpers.size}`;
      L.setHofHelpers.set(key, helper);
      L.liftedFns.push(L.buildSetForEachFn(helper, setT, arity, fnRet, loc));
    }
    return { kind: "call", callee: helper, args: [receiver, fnArg], type: VOID, loc };
  }

/** The loop body of the Set.forEach desugar — buildMapForEachFn with
   * iterKey as the (single) element read:
   *
   *   s.iterEnter();
   *   try {
   *     for (i = 0; i < s.iterCount; i++) {
   *       if (s.iterLive(i)) { v = s.iterKey(i); f(v, v); }
   *     }
   *   } finally { s.iterExit(); }
   */
  export function buildSetForEachFn(L: Lowerer, name: string,
    setT: IrType & { kind: "set" },
    arity: number,
    fnRet: IrType,
    loc: SrcLoc,): IrFunction {
    const elem = setT.elem;
    const fnT = funcOf(Array.from({ length: arity }, () => elem), fnRet);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const iter = (
      method: "iterCount" | "iterLive" | "iterKey" | "iterEnter" | "iterExit",
      args: IrExpr[],
      type: IrType,
    ): IrExpr => ({
      kind: "setIntrinsic",
      method,
      receiver: ref("m.0", setT),
      args,
      type,
      loc,
    });
    const locals: IrLocal[] = [
      { id: "m.0", name: "m", type: setT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ];
    const visitBody: IrStmt[] = [];
    const callArgs: IrExpr[] = [];
    if (arity >= 1) {
      locals.push({ id: "v.0", name: "v", type: elem, mutable: false });
      visitBody.push({
        kind: "varDecl",
        localId: "v.0",
        init: iter("iterKey", [ref("i.0", F64)], elem),
        loc,
      });
      for (let i = 0; i < arity; i++) callArgs.push(ref("v.0", elem));
    }
    visitBody.push({
      kind: "exprStmt",
      expr: { kind: "callValue", callee: ref("f.0", fnT), args: callArgs, type: fnRet, loc },
      loc,
    });
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: ref("i.0", F64),
        right: iter("iterCount", [], F64),
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: "i.0",
        value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
        loc,
      },
      body: [
        {
          kind: "if",
          cond: iter("iterLive", [ref("i.0", F64)], BOOL),
          then: visitBody,
          else_: null,
          loc,
        },
      ],
      loc,
    };
    const body: IrStmt[] = [
      { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
      {
        kind: "tryCatch",
        tryBody: [loop],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }],
        loc,
      },
    ];
    return {
      name,
      params: [
        { localId: "m.0", name: "m", type: setT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: VOID,
      locals,
      body,
      loc,
    };
  }

/** Object.groupBy / Map.groupBy (ES2024): group an ARRAY's elements by a
   * per-element key. Both lower to one interned helper loop per callback
   * type — the callback runs synchronously per element (index included in
   * the two-parameter form), the first occurrence of a key creates its
   * group in encounter order, and later hits push onto the same array
   * (JS's exact accumulation — the stored arrays are the live groups).
   * Map.groupBy keeps typed keys under SameValueZero; Object.groupBy
   * requires a STRING-KEYED result (Partial<Record<string, T[]>> — a
   * literal-union key type makes a fixed-field record, which has no
   * grouping representation) and stringifies number keys like JS property
   * keys. Node's result carries a null prototype — records here have no
   * prototype at all, so the difference is unobservable except through
   * util.inspect's "[Object: null prototype]" prefix (ledgered). Other
   * iterables fence (spread into an array first); Null when the callee
   * isn't the stdlib Object/Map groupBy. */
  export function lowerGroupByStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (access.name.text !== "groupBy") return null;
    const isMap = L.isStdlibGlobal(access.expression, "Map");
    const isObject = !isMap && L.isStdlibGlobal(access.expression, "Object");
    if (!isMap && !isObject) return null;
    if (!L.isStdlibMember(access)) return null;
    const what = isMap ? "Map.groupBy" : "Object.groupBy";
    const loc = locOf(call);
    if (call.arguments.length !== 2 || call.arguments.some((a) => ts.isSpreadElement(a))) {
      L.noLowering(`${what} with ${call.arguments.length} arguments`, call);
    }
    const items = L.lowerExpr(call.arguments[0]!);
    if (items.type.kind !== "array") {
      L.noLowering(
        `${what} over an iterable of type '${L.checker.typeToString(L.typeOf(call.arguments[0]!))}'`,
        call.arguments[0]!,
        "arrays are the supported items form — spread other iterables first: [...items]",
      );
    }
    const elem = items.type.elem;
    const f = L.lowerExpr(call.arguments[1]!);
    if (
      f.type.kind !== "func" ||
      f.type.params.length > 2 ||
      (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
      (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64")
    ) {
      L.badType(call.arguments[1]!, L.typeOf(call.arguments[1]!));
    }
    const keyT = f.type.ret;
    // The call's own type keeps the callback's literal-union key type
    // (Partial<Record<"even" | "odd", T[]>> — a FIXED-FIELD record, which
    // has no grouping representation); a CONTEXT naming the string-keyed
    // form (the annotated-const idiom) is the groupable reading, so it
    // wins when it maps that way.
    const ctxT = L.checker.getContextualType(call);
    const ctxMapped = ctxT !== undefined ? L.mapTypeOf(ctxT) : null;
    const ownMapped = L.mapTypeOf(L.typeOf(call));
    if (isMap) {
      const resultT = ctxMapped?.kind === "map" ? ctxMapped : ownMapped;
      if (resultT?.kind !== "map" || !typeEquals(resultT.key, keyT) || !typeEquals(resultT.value, items.type)) {
        L.noLowering(
          `${what} at this result type`,
          call,
          "the result must be Map<K, T[]> over the callback's K and the items' T — annotate: Map.groupBy<K, T>(items, f)",
        );
      }
      const key = `map.groupBy:${typeKey(f.type)}`;
      let helper = L.mapHofHelpers.get(key);
      if (!helper) {
        helper = `%map.groupBy.${L.mapHofHelpers.size}`;
        L.mapHofHelpers.set(key, helper);
        L.liftedFns.push(buildGroupByFn(L, helper, items.type, f.type, resultT, loc));
      }
      return { kind: "call", callee: helper, args: [items, f], type: resultT, loc };
    }
    // A groupable reading is an INDEX-SIGNATURE record (no declared
    // fields). Either candidate qualifying proves the checker committed
    // the result to the string-keyed form; the VALUE's shape is then
    // minted exactly (fields none, index value T[] | undefined — the
    // structural intern, so a matching annotation shares the id) rather
    // than adopted, because mapped-type instantiations can arrive with a
    // widened index value.
    const indexShaped = (t: IrType | null): boolean => {
      if (t?.kind !== "record") return false;
      const s = L.shapes.get(t.shapeId);
      return s !== undefined && s.fields.length === 0 && s.indexValue !== undefined;
    };
    if ((!indexShaped(ctxMapped) && !indexShaped(ownMapped)) || (keyT.kind !== "string" && keyT.kind !== "f64")) {
      L.noLowering(
        `${what} at this result type`,
        call,
        "a string-keyed result (Partial<Record<string, T[]>>) is the supported form — a literal-union " +
          "key type makes a fixed-field record: widen the callback's key type to string " +
          "(numbers stringify like JS property keys)",
      );
    }
    const resultT: IrType & { kind: "record" } = {
      kind: "record",
      shapeId: L.shapes.intern([], false, L.withUndefinedArm(items.type), []),
    };
    const key = `object.groupBy:${typeKey(f.type)}`;
    let helper = L.mapHofHelpers.get(key);
    if (!helper) {
      helper = `%object.groupBy.${L.mapHofHelpers.size}`;
      L.mapHofHelpers.set(key, helper);
      L.liftedFns.push(buildGroupByFn(L, helper, items.type, f.type, resultT, loc));
    }
    return { kind: "call", callee: helper, args: [items, f], type: resultT, loc };
  }

/** The groupBy helper body — one loop, two grouping stores:
   *
   *   g = new Map() | {}
   *   for (i = 0; i < items.length; i++) {
   *     v = items[i]; k = f(v[, i]);
   *     cur = g.get(k)                    // the V|undefined union read
   *     if (cur is undefined) g.set(k, [v]); else cur.push(v);
   *   }
   *   return g
   *
   * The map read/write are mapIntrinsic get/set; the record pair are the
   * overflow keyed get/set with an f64 key stringified first (JS property
   * keys). Both reads answer the value-or-undefined union, so the arm
   * test IS the has() check with one lookup. */
  function buildGroupByFn(L: Lowerer, name: string,
    itemsT: IrType & { kind: "array" },
    fnT: IrType & { kind: "func" },
    resultT: (IrType & { kind: "map" }) | (IrType & { kind: "record" }),
    loc: SrcLoc,): IrFunction {
    const elem = itemsT.elem;
    const keyT = fnT.ret;
    const arity = fnT.params.length;
    const isMap = resultT.kind === "map";
    // The union the group read answers: the map value's undefined-armed
    // union, or the record shape's index value (validated by the caller).
    const iv: IrType & { kind: "union" } = isMap
      ? (L.withUndefinedArm(itemsT) as IrType & { kind: "union" })
      : (L.shapes.get(resultT.shapeId)!.indexValue as IrType & { kind: "union" });
    const arrTag = L.armTag(iv.unionId, itemsT);
    const undefTag = L.armTag(iv.unionId, UNDEFINED_T);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const gRef = (): IrExpr => ref("g.0", resultT);
    const kRef = (): IrExpr => ref("k.0", keyT);
    // Record keys are property keys: an f64 key stringifies (JS's exact
    // number ToString); map keys stay typed.
    const storeKey = (): IrExpr =>
      isMap || keyT.kind === "string" ? kRef() : { kind: "toString", operand: kRef(), type: STRING, loc };
    const groupRead = (): IrExpr =>
      isMap
        ? { kind: "mapIntrinsic", method: "get", receiver: gRef(), args: [storeKey()], type: iv, loc }
        : { kind: "recordKeyGet", obj: gRef(), shapeId: (resultT as IrType & { kind: "record" }).shapeId, key: storeKey(), overflowOnly: true, type: iv, loc };
    const freshGroup = (): IrExpr =>
      ({ kind: "arrayLit", elems: [ref("v.0", elem)], type: itemsT, loc });
    const groupWrite = (): IrStmt =>
      isMap
        ? { kind: "exprStmt", expr: { kind: "mapIntrinsic", method: "set", receiver: gRef(), args: [storeKey(), freshGroup()], type: VOID, loc }, loc }
        : { kind: "recordKeySet", obj: gRef(), shapeId: (resultT as IrType & { kind: "record" }).shapeId, key: storeKey(), value: { kind: "unionWrap", unionId: iv.unionId, tag: arrTag, value: freshGroup(), type: iv, loc }, loc };
    const callArgs: IrExpr[] = [];
    if (arity >= 1) callArgs.push(ref("v.0", elem));
    if (arity === 2) callArgs.push(ref("i.0", F64));
    const locals: IrLocal[] = [
      { id: "items.0", name: "items", type: itemsT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "g.0", name: "g", type: resultT, mutable: false },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "v.0", name: "v", type: elem, mutable: false },
      { id: "k.0", name: "k", type: keyT, mutable: false },
      { id: "cur.0", name: "cur", type: iv, mutable: false },
    ];
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "g.0",
        init: isMap
          ? { kind: "mapNew", type: resultT, loc }
          : { kind: "recordLit", fields: [], type: resultT, loc },
        loc,
      },
      { kind: "varDecl", localId: "n.0", init: { kind: "arrIntrinsic", method: "length", receiver: ref("items.0", itemsT), args: [], type: F64, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: ref("n.0", F64), type: BOOL, loc },
        update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc }, loc },
        body: [
          { kind: "varDecl", localId: "v.0", init: { kind: "arrayGet", arr: ref("items.0", itemsT), index: ref("i.0", F64), type: elem, loc }, loc },
          { kind: "varDecl", localId: "k.0", init: { kind: "callValue", callee: ref("f.0", fnT), args: callArgs, type: keyT, loc }, loc },
          { kind: "varDecl", localId: "cur.0", init: groupRead(), loc },
          {
            kind: "if",
            cond: { kind: "unionIsTag", unionId: iv.unionId, tag: undefTag, negated: false, value: ref("cur.0", iv), type: BOOL, loc },
            then: [groupWrite()],
            else_: [
              {
                kind: "exprStmt",
                expr: {
                  kind: "arrIntrinsic",
                  method: "push",
                  receiver: { kind: "unionNarrow", unionId: iv.unionId, tag: arrTag, value: ref("cur.0", iv), type: itemsT, loc },
                  args: [ref("v.0", elem)],
                  type: F64,
                  loc,
                },
                loc,
              },
            ],
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: gRef(), loc },
    ];
    return {
      name,
      params: [
        { localId: "items.0", name: "items", type: itemsT },
        { localId: "f.0", name: "f", type: fnT },
      ],
      returnType: resultT,
      locals,
      body,
      loc,
    };
  }

/* ── iterator helpers (ES2025) ─────────────────────────────────────────── */

/** The lowered iterator-helper chains: `arr.values()` (the array
   * iterator) through any run of map/filter/take/drop/flatMap into a
   * consuming terminal (toArray/forEach/reduce/some/every/find), FUSED
   * into one per-element loop — which IS the helpers' lazy pull order:
   * each source element flows through every stage before the next is
   * touched, take closes the pipeline without pulling upstream again
   * (budget checked before delivery), and short-circuit terminals stop
   * the walk at their hit. Stage callbacks take (value) or (value,
   * counter) — counters count each stage's own input stream, per spec.
   * take/drop budgets validate eagerly AT THE CALL (Node's RangeError,
   * raw value in the message) through an interned checker call inserted
   * at the argument's evaluation position. The source array is iterated
   * LIVE by index against a re-read length, exactly the array iterator's
   * contract. Everything else — iterator objects stored in bindings,
   * generator/Set/Map receivers, Iterator.from — keeps the lib fences.
   * Null when the callee isn't a terminal over such a chain. */
  export function lowerIteratorHelperCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    const terminal = access.name.text;
    if (!ITER_TERMINALS.has(terminal)) return null;
    // Walk receiver: stage* ← values()/entries() ← array-typed source
    // (entries seeds the chain with [index, element] pairs — the
    // checker's own tuple type).
    const stages: { name: string; argNode: ts.Expression }[] = [];
    let cur: ts.Expression = access.expression;
    let source: ts.Expression | null = null;
    let srcProj: "values" | "entries" = "values";
    for (;;) {
      if (!ts.isCallExpression(cur) || !ts.isPropertyAccessExpression(cur.expression)) return null;
      if (cur.questionDotToken || cur.expression.questionDotToken) return null;
      const name = cur.expression.name.text;
      if ((name === "values" || name === "entries") && cur.arguments.length === 0) {
        const recvIr = L.mapTypeOf(L.typeOf(cur.expression.expression));
        if (recvIr?.kind !== "array") return null;
        if (!L.isStdlibMember(cur.expression)) return null;
        source = cur.expression.expression;
        srcProj = name;
        break;
      }
      if (!ITER_STAGES.has(name) || cur.arguments.length !== 1 || ts.isSpreadElement(cur.arguments[0]!)) return null;
      stages.push({ name, argNode: cur.arguments[0]! });
      cur = cur.expression.expression;
    }
    stages.reverse(); // source order
    for (const s of stages) {
      const acc = findStageAccess(call, s);
      if (acc !== null && !L.isStdlibMember(acc)) return null;
    }
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    // Lower everything in SOURCE ORDER (the chain's own evaluation
    // order): the source array, each stage argument, the terminal's.
    const items = L.lowerExpr(source);
    if (items.type.kind !== "array") return null;
    // The entries() seed: the interned [number, T] tuple — the same shape
    // the checker's own [number, T] maps to, so stage callbacks typed
    // against the lib's pairs intern equal.
    let elem: IrType = srcProj === "entries"
      ? { kind: "record", shapeId: L.shapes.intern([{ name: "0", type: F64 }, { name: "1", type: items.type.elem }], true) }
      : items.type.elem;
    type StageIr =
      | { kind: "map" | "filter" | "flatMap"; fn: IrExpr & { type: IrType & { kind: "func" } }; out: IrType }
      | { kind: "take" | "drop"; budget: IrExpr };
    const stageIrs: StageIr[] = [];
    for (const s of stages) {
      if (s.name === "take" || s.name === "drop") {
        const n = L.lowerExpr(s.argNode);
        if (n.type.kind !== "f64") L.badType(s.argNode, L.typeOf(s.argNode));
        // Node validates at the take()/drop() call — the checked budget
        // rides an interned helper call AT this argument position.
        stageIrs.push({ kind: s.name, budget: { kind: "call", callee: internBudgetChecker(L, loc), args: [n], type: F64, loc } });
        continue;
      }
      const f = L.lowerExpr(s.argNode);
      if (
        f.type.kind !== "func" || f.type.params.length > 2 ||
        (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
        (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64")
      ) {
        L.badType(s.argNode, L.typeOf(s.argNode));
      }
      const fn = f as IrExpr & { type: IrType & { kind: "func" } };
      if (s.name === "map") {
        stageIrs.push({ kind: "map", fn, out: fn.type.ret });
        elem = fn.type.ret;
      } else if (s.name === "filter") {
        if (fn.type.ret.kind !== "bool") L.badType(s.argNode, L.typeOf(s.argNode));
        stageIrs.push({ kind: "filter", fn, out: elem });
      } else {
        if (fn.type.ret.kind !== "array") {
          L.noLowering(
            `.flatMap over a callback returning '${L.fmt(fn.type.ret)}'`,
            s.argNode,
            "an array-returning callback is the supported form (iterators/strings have no lowering here)",
          );
        }
        stageIrs.push({ kind: "flatMap", fn, out: fn.type.ret.elem });
        elem = fn.type.ret.elem;
      }
    }
    // The terminal's own arguments.
    const termArgs: IrExpr[] = [];
    let resultT: IrType;
    if (terminal === "toArray") {
      if (call.arguments.length !== 0) L.noLowering(`.toArray with ${call.arguments.length} arguments`, call);
      resultT = arrayOf(elem);
    } else if (terminal === "forEach" || terminal === "some" || terminal === "every" || terminal === "find") {
      const argNode = call.arguments[0];
      if (call.arguments.length !== 1 || argNode === undefined || ts.isSpreadElement(argNode)) {
        L.noLowering(`.${terminal} with ${call.arguments.length} arguments`, call);
      }
      const f = L.lowerExpr(argNode);
      if (
        f.type.kind !== "func" || f.type.params.length > 2 ||
        (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
        (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64") ||
        (terminal !== "forEach" && f.type.ret.kind !== "bool")
      ) {
        L.badType(argNode, L.typeOf(argNode));
      }
      termArgs.push(f);
      resultT = terminal === "forEach" ? VOID : terminal === "find" ? L.withUndefinedArm(elem) : BOOL;
    } else {
      // reduce(f[, initial])
      const fNode = call.arguments[0];
      if (call.arguments.length < 1 || call.arguments.length > 2 || fNode === undefined || call.arguments.some((a) => ts.isSpreadElement(a))) {
        L.noLowering(`.reduce with ${call.arguments.length} arguments`, call);
      }
      const f = L.lowerExpr(fNode);
      if (
        f.type.kind !== "func" || f.type.params.length < 2 || f.type.params.length > 3 ||
        !typeEquals(f.type.params[1]!, elem) ||
        (f.type.params.length === 3 && f.type.params[2]!.kind !== "f64") ||
        !typeEquals(f.type.params[0]!, f.type.ret)
      ) {
        L.badType(fNode, L.typeOf(fNode));
      }
      const accT = (f.type as IrType & { kind: "func" }).ret;
      if (call.arguments.length === 1 && !typeEquals(accT, elem)) {
        L.noLowering(
          ".reduce without an initial value where the accumulator's type differs from the elements'",
          call,
          "pass the initial value: .reduce(f, init)",
        );
      }
      termArgs.push(f);
      if (call.arguments[1] !== undefined) termArgs.push(L.lowerExprExpecting(call.arguments[1], accT));
      resultT = accT;
    }
    // The checker's own result type must agree (annotation drift fences).
    const checkerT = L.mapTypeOf(L.typeOf(call));
    if (terminal !== "forEach" && (checkerT === null || !typeEquals(checkerT, resultT))) {
      L.noLowering(
        `.${terminal} at this result type`,
        call,
        "the chain's element and result types must be representable — annotate the callbacks' types",
      );
    }
    const stageKeys = stageIrs.map((s) => (s.kind === "take" || s.kind === "drop" ? s.kind : `${s.kind}:${typeKey((s as { fn: IrExpr }).fn.type)}`));
    const key = `iter:${srcProj}:${typeKey(items.type)}:${stageKeys.join(",")}:${terminal}:${termArgs.map((a) => typeKey(a.type)).join(",")}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%iter.${terminal}.${L.arrHofHelpers.size}`;
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push(buildIterChainFn(L, helper, items.type, srcProj, stageIrs, terminal, termArgs.map((a) => a.type), resultT, loc));
    }
    const budgetOrFn = stageIrs.map((s) => (s.kind === "take" || s.kind === "drop" ? s.budget : (s as { fn: IrExpr }).fn));
    return { kind: "call", callee: helper, args: [items, ...budgetOrFn, ...termArgs], type: resultT, loc };
  }

const ITER_STAGES = new Set(["map", "filter", "take", "drop", "flatMap"]);
const ITER_TERMINALS = new Set(["toArray", "forEach", "reduce", "some", "every", "find"]);

/** The ts.PropertyAccessExpression of stage `s` inside the chain under
   * `call` — for the stdlib-membership check. Walks the same spine the
   * parser walked; null only on shape drift (checked defensively). */
  function findStageAccess(call: ts.CallExpression,
    s: { name: string; argNode: ts.Expression },): ts.PropertyAccessExpression | null {
    let cur: ts.Expression = (call.expression as ts.PropertyAccessExpression).expression;
    while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      if (cur.arguments[0] === s.argNode) return cur.expression;
      cur = cur.expression.expression;
    }
    return null;
  }

/** The eager take/drop budget check, interned once per program:
   *
   *   %iter.budget(v) { if (v !== v || trunc(v) < 0) throw RangeError(`${v} must be positive`); return trunc(v) }
   *
   * Node's exact behavior: NaN and negative INTEGER budgets throw (the
   * message carries the RAW argument — take(-1.5) says "-1.5"), -0.5
   * truncates to 0 and passes, Infinity passes through. */
  function internBudgetChecker(L: Lowerer, loc: SrcLoc): string {
    const key = "iter:budget";
    let name = L.arrHofHelpers.get(key);
    if (name !== undefined) return name;
    name = "%iter.budget";
    L.arrHofHelpers.set(key, name);
    const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: F64, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    // trunc without an Infinity-poisoned fmod: values at or past 2^53 are
    // already integers (Infinity included), so only smaller ones truncate.
    const t = (): IrExpr => ({
      kind: "ternary",
      cond: { kind: "bin", op: "<", left: v(), right: num(9007199254740992), type: BOOL, loc },
      then: { kind: "bin", op: "-", left: v(), right: { kind: "bin", op: "%", left: v(), right: num(1), type: F64, loc }, type: F64, loc },
      else_: v(),
      type: F64,
      loc,
    });
    const bad: IrExpr = {
      kind: "logical",
      op: "||",
      left: { kind: "bin", op: "!==", left: v(), right: v(), type: BOOL, loc },
      right: { kind: "bin", op: "<", left: t(), right: num(0), type: BOOL, loc },
      type: BOOL,
      loc,
    };
    const throwStmt: IrStmt = {
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [concatAll([{ kind: "toString", operand: v(), type: STRING, loc }, { kind: "strLit", value: " must be positive", type: STRING, loc }], loc)],
        type: { kind: "object", className: "%RangeError" },
        loc,
      },
      loc,
    };
    L.liftedFns.push({
      name,
      params: [{ localId: "v.0", name: "v", type: F64 }],
      returnType: F64,
      locals: [{ id: "v.0", name: "v", type: F64, mutable: true }],
      body: [
        { kind: "if", cond: bad, then: [throwStmt], else_: null, loc },
        { kind: "return", value: t(), loc },
      ],
      loc,
    });
    return name;
  }

/** The fused chain body. One loop over the LIVE source (length re-read
   * per pass), a `done` flag every loop condition carries (take closing
   * the pipeline, short-circuit terminals), stage code nested inside in
   * source order, flatMap as an inner loop over its returned array.
   * Pre-loop, a zero take budget marks done immediately — Node pulls
   * nothing at all through a take(0). */
  function buildIterChainFn(L: Lowerer, name: string,
    itemsT: IrType & { kind: "array" },
    srcProj: "values" | "entries",
    stages: { kind: string; fn?: IrExpr & { type: IrType & { kind: "func" } } }[],
    terminal: string,
    termArgTs: IrType[],
    resultT: IrType,
    loc: SrcLoc,): IrFunction {
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const boolLit = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
    const locals: IrLocal[] = [{ id: "items.0", name: "items", type: itemsT, mutable: true }];
    const params: IrParam[] = [{ localId: "items.0", name: "items", type: itemsT }];
    let n = 0;
    const addLocal = (base: string, type: IrType, mutable: boolean): string => {
      const id = `${base}.${n++}`;
      locals.push({ id, name: base, type, mutable });
      return id;
    };
    const addParam = (base: string, type: IrType): string => {
      const id = `${base}.${n++}`;
      locals.push({ id, name: base, type, mutable: true });
      params.push({ localId: id, name: base, type });
      return id;
    };
    const doneId = addLocal("done", BOOL, true);
    const done = (): IrExpr => ref(doneId, BOOL);
    const setDone: IrStmt = { kind: "assign", localId: doneId, value: boolLit(true), loc };
    // Parameters in call order: per-stage budget/callback, then terminal's.
    interface StageSlot { kind: string; paramId: string; fnT?: (IrType & { kind: "func" }) | undefined; cntId?: string | undefined; elem: IrType }
    // The entries() seed builds each pass's [index, element] pair — the
    // same interned tuple the caller computed its stage types against.
    const seedT: IrType = srcProj === "entries"
      ? { kind: "record", shapeId: L.shapes.intern([{ name: "0", type: F64 }, { name: "1", type: itemsT.elem }], true) }
      : itemsT.elem;
    let elem: IrType = seedT;
    const slots: StageSlot[] = [];
    for (const s of stages) {
      if (s.kind === "take" || s.kind === "drop") {
        const paramId = addParam("n", F64);
        const cntId = addLocal(s.kind === "take" ? "taken" : "dropped", F64, true);
        slots.push({ kind: s.kind, paramId, cntId, elem });
        continue;
      }
      const fnT = s.fn!.type;
      const paramId = addParam("f", fnT);
      const cntId = fnT.params.length === 2 ? addLocal("c", F64, true) : undefined;
      const out = s.kind === "map" ? fnT.ret : s.kind === "flatMap" ? (fnT.ret as IrType & { kind: "array" }).elem : elem;
      slots.push({ kind: s.kind, paramId, fnT, cntId, elem: out });
      elem = out;
    }
    const termIds = termArgTs.map((t, i) => addParam(i === 0 ? "tf" : "init", t));
    const termFnT = termArgTs[0]?.kind === "func" ? (termArgTs[0] as IrType & { kind: "func" }) : null;
    const termCntId =
      (terminal === "reduce" && termFnT !== null && termFnT.params.length === 3) ||
      (terminal !== "reduce" && terminal !== "toArray" && termFnT !== null && termFnT.params.length === 2) ||
      terminal === "reduce"
        ? addLocal("k", F64, true)
        : undefined;
    const bump = (id: string): IrStmt =>
      ({ kind: "assign", localId: id, value: { kind: "bin", op: "+", left: ref(id, F64), right: num(1), type: F64, loc }, loc });
    const callWith = (fnT: IrType & { kind: "func" }, fnId: string, value: IrExpr, cntId: string | undefined): IrExpr => {
      const args: IrExpr[] = [];
      if (fnT.params.length >= 1) args.push(value);
      if (cntId !== undefined && fnT.params.length >= 2) args.push(ref(cntId, F64));
      return { kind: "callValue", callee: ref(fnId, fnT), args, type: fnT.ret, loc };
    };
    // Terminal state.
    const preLoop: IrStmt[] = [];
    const postLoop: IrStmt[] = [];
    let outId = "";
    let accId = "";
    let hasAccId = "";
    let resId = "";
    if (terminal === "toArray") {
      outId = addLocal("out", resultT, false);
      preLoop.push({ kind: "varDecl", localId: outId, init: { kind: "arrayLit", elems: [], type: resultT, loc }, loc });
      postLoop.push({ kind: "return", value: ref(outId, resultT), loc });
    } else if (terminal === "some" || terminal === "every") {
      resId = addLocal("res", BOOL, true);
      preLoop.push({ kind: "varDecl", localId: resId, init: boolLit(terminal === "every"), loc });
      postLoop.push({ kind: "return", value: ref(resId, BOOL), loc });
    } else if (terminal === "find") {
      resId = addLocal("res", resultT, true);
      const undef = L.wrappedUndefined(resultT, loc);
      if (undef === null) throw new Error("lowerer bug: find result union lacks undefined");
      preLoop.push({ kind: "varDecl", localId: resId, init: undef, loc });
      postLoop.push({ kind: "return", value: ref(resId, resultT), loc });
    } else if (terminal === "reduce") {
      accId = addLocal("acc", resultT, true);
      if (termIds.length === 2) {
        preLoop.push({ kind: "varDecl", localId: accId, init: ref(termIds[1]!, resultT), loc });
      } else {
        hasAccId = addLocal("hasAcc", BOOL, true);
        preLoop.push({ kind: "varDecl", localId: hasAccId, init: boolLit(false), loc });
        postLoop.push({
          kind: "if",
          cond: { kind: "unary", op: "!", operand: ref(hasAccId, BOOL), type: BOOL, loc },
          then: [throwTypeError({ kind: "strLit", value: "Reduce of a done iterator with no initial value", type: STRING, loc }, loc)],
          else_: null,
          loc,
        });
      }
      postLoop.push({ kind: "return", value: ref(accId, resultT), loc });
    } else {
      postLoop.push({ kind: "return", value: null, loc });
    }
    if (termCntId !== undefined) preLoop.push({ kind: "varDecl", localId: termCntId, init: num(0), loc });
    // done starts true when any take budget is zero (nothing pulls).
    let doneInit: IrExpr = boolLit(false);
    for (const s of slots) {
      if (s.kind !== "take") continue;
      const isZero: IrExpr = { kind: "bin", op: "===", left: ref(s.paramId, F64), right: num(0), type: BOOL, loc };
      doneInit = doneInit.kind === "boolLit" ? isZero : { kind: "logical", op: "||", left: doneInit, right: isZero, type: BOOL, loc };
    }
    preLoop.unshift({ kind: "varDecl", localId: doneId, init: doneInit, loc });
    for (const s of slots) {
      if (s.cntId !== undefined) preLoop.push({ kind: "varDecl", localId: s.cntId, init: num(0), loc });
    }
    // The terminal's per-element statements over `value`.
    const terminalBody = (value: IrExpr): IrStmt[] => {
      const out: IrStmt[] = [];
      if (terminal === "toArray") {
        out.push({ kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: ref(outId, resultT), args: [value], type: F64, loc }, loc });
      } else if (terminal === "forEach") {
        out.push({ kind: "exprStmt", expr: callWith(termFnT!, termIds[0]!, value, termCntId), loc });
      } else if (terminal === "some" || terminal === "every") {
        const hit = callWith(termFnT!, termIds[0]!, value, termCntId);
        const cond: IrExpr = terminal === "some" ? hit : { kind: "unary", op: "!", operand: hit, type: BOOL, loc };
        out.push({
          kind: "if",
          cond,
          then: [{ kind: "assign", localId: resId, value: boolLit(terminal === "some"), loc }, setDone],
          else_: null,
          loc,
        });
      } else if (terminal === "find") {
        const undefTag = resultT.kind === "union" ? L.armTag(resultT.unionId, UNDEFINED_T) : -1;
        const valueTag = resultT.kind === "union" ? (undefTag === 0 ? 1 : 0) : -1;
        if (resultT.kind !== "union" || valueTag < 0) throw new Error("lowerer bug: find result is not the undefined-armed union");
        out.push({
          kind: "if",
          cond: callWith(termFnT!, termIds[0]!, value, termCntId),
          then: [
            { kind: "assign", localId: resId, value: { kind: "unionWrap", unionId: resultT.unionId, tag: valueTag, value, type: resultT, loc }, loc },
            setDone,
          ],
          else_: null,
          loc,
        });
      } else {
        // reduce
        const reducer = (): IrExpr => {
          const args: IrExpr[] = [ref(accId, resultT), value];
          if (termFnT!.params.length === 3) args.push(ref(termCntId!, F64));
          return { kind: "callValue", callee: ref(termIds[0]!, termFnT!), args, type: resultT, loc };
        };
        if (hasAccId !== "") {
          out.push({
            kind: "if",
            cond: { kind: "unary", op: "!", operand: ref(hasAccId, BOOL), type: BOOL, loc },
            then: [
              { kind: "assign", localId: accId, value, loc },
              { kind: "assign", localId: hasAccId, value: boolLit(true), loc },
            ],
            else_: [{ kind: "assign", localId: accId, value: reducer(), loc }],
            loc,
          });
        } else {
          out.push({ kind: "assign", localId: accId, value: reducer(), loc });
        }
      }
      if (termCntId !== undefined) out.push(bump(termCntId));
      return out;
    };
    // Fold stages from the terminal outward.
    let emit: (value: IrExpr) => IrStmt[] = terminalBody;
    for (let si = slots.length - 1; si >= 0; si--) {
      const s = slots[si]!;
      const inner = emit;
      if (s.kind === "map") {
        emit = (value) => {
          const vId = addLocal("m", s.fnT!.ret, false);
          return [
            { kind: "varDecl", localId: vId, init: callWith(s.fnT!, s.paramId, value, s.cntId), loc },
            ...(s.cntId !== undefined ? [bump(s.cntId)] : []),
            ...inner(ref(vId, s.fnT!.ret)),
          ];
        };
      } else if (s.kind === "filter") {
        emit = (value) => {
          const okId = addLocal("ok", BOOL, false);
          return [
            { kind: "varDecl", localId: okId, init: callWith(s.fnT!, s.paramId, value, s.cntId), loc },
            ...(s.cntId !== undefined ? [bump(s.cntId)] : []),
            { kind: "if", cond: { kind: "unary", op: "!", operand: ref(okId, BOOL), type: BOOL, loc }, then: [{ kind: "continue", loc }], else_: null, loc },
            ...inner(value),
          ];
        };
      } else if (s.kind === "drop") {
        emit = (value) => [
          {
            kind: "if",
            cond: { kind: "bin", op: "<", left: ref(s.cntId!, F64), right: ref(s.paramId, F64), type: BOOL, loc },
            then: [bump(s.cntId!), { kind: "continue", loc }],
            else_: null,
            loc,
          },
          ...inner(value),
        ];
      } else if (s.kind === "take") {
        // Budget consumed BEFORE delivery: the nth element flows on with
        // done already set, so no later element pulls upstream — and a
        // downstream `continue` can't skip the close (the loop conditions
        // carry !done).
        emit = (value) => [
          bump(s.cntId!),
          {
            kind: "if",
            cond: { kind: "bin", op: ">=", left: ref(s.cntId!, F64), right: ref(s.paramId, F64), type: BOOL, loc },
            then: [setDone],
            else_: null,
            loc,
          },
          ...inner(value),
        ];
      } else {
        // flatMap: an inner loop over the returned array, `!done` carried.
        emit = (value) => {
          const innerT = s.fnT!.ret as IrType & { kind: "array" };
          const arrId = addLocal("fm", innerT, false);
          const jId = addLocal("j", F64, true);
          const wId = addLocal("w", innerT.elem, false);
          return [
            { kind: "varDecl", localId: arrId, init: callWith(s.fnT!, s.paramId, value, s.cntId), loc },
            ...(s.cntId !== undefined ? [bump(s.cntId)] : []),
            {
              kind: "for",
              init: { kind: "varDecl", localId: jId, init: num(0), loc },
              cond: {
                kind: "logical",
                op: "&&",
                left: { kind: "bin", op: "<", left: ref(jId, F64), right: { kind: "arrIntrinsic", method: "length", receiver: ref(arrId, innerT), args: [], type: F64, loc }, type: BOOL, loc },
                right: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
                type: BOOL,
                loc,
              },
              update: { kind: "assign", localId: jId, value: { kind: "bin", op: "+", left: ref(jId, F64), right: num(1), type: F64, loc }, loc },
              body: [
                { kind: "varDecl", localId: wId, init: { kind: "arrayGet", arr: ref(arrId, innerT), index: ref(jId, F64), type: innerT.elem, loc }, loc },
                ...inner(ref(wId, innerT.elem)),
              ],
              loc,
            },
          ];
        };
      }
    }
    const iId = addLocal("i", F64, true);
    const vId = addLocal("v", seedT, false);
    const elemRead = (): IrExpr => ({ kind: "arrayGet", arr: ref("items.0", itemsT), index: ref(iId, F64), type: itemsT.elem, loc });
    const seedInit: IrExpr = srcProj === "entries"
      ? {
          kind: "recordLit",
          fields: [
            { name: "0", value: ref(iId, F64) },
            { name: "1", value: elemRead() },
          ],
          type: seedT,
          loc,
        }
      : elemRead();
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: iId, init: num(0), loc },
      cond: {
        kind: "logical",
        op: "&&",
        left: { kind: "bin", op: "<", left: ref(iId, F64), right: { kind: "arrIntrinsic", method: "length", receiver: ref("items.0", itemsT), args: [], type: F64, loc }, type: BOOL, loc },
        right: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
        type: BOOL,
        loc,
      },
      update: { kind: "assign", localId: iId, value: { kind: "bin", op: "+", left: ref(iId, F64), right: num(1), type: F64, loc }, loc },
      body: [
        { kind: "varDecl", localId: vId, init: seedInit, loc },
        ...emit(ref(vId, seedT)),
      ],
      loc,
    };
    return {
      name,
      params,
      returnType: resultT,
      locals,
      body: [...preLoop, loop, ...postLoop],
      loc,
    };
  }

/** The ES2025 Set composition methods (union/intersection/difference/
   * symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom): one
   * set-like argument, desugared to an interned two-set helper loop. Only
   * a REAL Set argument of the receiver's element type lowers — the
   * desugar substitutes the builtin has/size for the spec's observable
   * calls, which is exact for Sets and wrong for anything else (a Map or
   * a custom { has, size, keys } object fences). */
  function lowerSetCombineCall(L: Lowerer, call: ts.CallExpression,
    name: string,
    receiver: IrExpr,
    setT: IrType & { kind: "set" },): IrExpr {
    const loc = locOf(call);
    const argNode = call.arguments[0];
    if (call.arguments.length !== 1 || argNode === undefined || ts.isSpreadElement(argNode)) {
      L.noLowering(
        `Set.prototype.${name} with ${call.arguments.length} arguments`,
        call,
        "exactly one Set argument is the supported form",
      );
    }
    const other = L.lowerExpr(argNode);
    if (other.type.kind !== "set") {
      L.noLowering(
        `Set.prototype.${name} over a set-like argument of type '${L.checker.typeToString(L.typeOf(argNode))}'`,
        argNode,
        "only a real Set lowers (the argument's has/size must be the builtins) — build one first: new Set(...)",
      );
    }
    if (!typeEquals(other.type.elem, setT.elem)) {
      L.noLowering(
        `Set.prototype.${name} across element types`,
        call,
        "both sides must share ONE element type — annotate the sets to a common Set<T>",
      );
    }
    const predicate = name === "isSubsetOf" || name === "isSupersetOf" || name === "isDisjointFrom";
    const resultT: IrType = predicate ? BOOL : setT;
    const key = `${name}:${typeKey(setT.elem)}`;
    let helper = L.setHofHelpers.get(key);
    if (!helper) {
      helper = `%set.${name}.${L.setHofHelpers.size}`;
      L.setHofHelpers.set(key, helper);
      L.liftedFns.push(buildSetCombineFn(helper, name, setT, loc));
    }
    return { kind: "call", callee: helper, args: [receiver, other], type: resultT, loc };
  }

/** The two-set helper bodies. No user code runs mid-walk (has/add are
   * the builtins), so the loops skip the live-iteration enter/exit
   * bracketing — nothing can compact the entries underneath them. The
   * spec's iteration orders are kept where observable: union appends the
   * receiver's elements then the argument's; intersection walks the
   * SMALLER side (the result's insertion order follows the walked side,
   * per spec's size branch); difference/symmetricDifference walk
   * receiver-then-argument. The predicates return at the first
   * counterexample.
   *
   *   union(a, b):               r = new Set; for v of a: r.add(v); for v of b: r.add(v); return r
   *   intersection(a, b):        r = new Set; walk the smaller side, keep what the other has
   *   difference(a, b):          r = new Set; for v of a: if (!b.has(v)) r.add(v)
   *   symmetricDifference(a, b): a's not-in-b, then b's not-in-a
   *   isSubsetOf(a, b):          for v of a: if (!b.has(v)) return false; return true
   *   isSupersetOf(a, b):        for v of b: if (!a.has(v)) return false; return true
   *   isDisjointFrom(a, b):      for v of a: if (b.has(v)) return false; return true
   */
  function buildSetCombineFn(name: string, method: string,
    setT: IrType & { kind: "set" },
    loc: SrcLoc,): IrFunction {
    const elem = setT.elem;
    const predicate = method === "isSubsetOf" || method === "isSupersetOf" || method === "isDisjointFrom";
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const boolLit = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
    const setOp = (recv: string, m: IrSetIntrinsicMethod, args: IrExpr[], type: IrType): IrExpr =>
      ({ kind: "setIntrinsic", method: m, receiver: ref(recv, setT), args, type, loc });
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: setT, mutable: true },
      { id: "b.0", name: "b", type: setT, mutable: true },
    ];
    let nextLocal = 0;
    /* for (i = 0; i < src.iterCount; i++) if (src.iterLive(i)) { v = src.iterKey(i); <visit(v)> } */
    const loopOver = (src: string, visit: (v: IrExpr) => IrStmt[]): IrStmt => {
      const iId = `i.${nextLocal}`;
      const vId = `v.${nextLocal}`;
      nextLocal += 1;
      locals.push({ id: iId, name: "i", type: F64, mutable: true });
      locals.push({ id: vId, name: "v", type: elem, mutable: false });
      const v = ref(vId, elem);
      return {
        kind: "for",
        init: { kind: "varDecl", localId: iId, init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref(iId, F64), right: setOp(src, "iterCount", [], F64), type: BOOL, loc },
        update: {
          kind: "assign",
          localId: iId,
          value: { kind: "bin", op: "+", left: ref(iId, F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "if",
            cond: setOp(src, "iterLive", [ref(iId, F64)], BOOL),
            then: [
              { kind: "varDecl", localId: vId, init: setOp(src, "iterKey", [ref(iId, F64)], elem), loc },
              ...visit(v),
            ],
            else_: null,
            loc,
          },
        ],
        loc,
      };
    };
    const has = (src: string, v: IrExpr): IrExpr => setOp(src, "has", [v], BOOL);
    const not = (e: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand: e, type: BOOL, loc });
    const addTo = (v: IrExpr): IrStmt =>
      ({ kind: "exprStmt", expr: { kind: "setIntrinsic", method: "add", receiver: ref("r.0", setT), args: [v], type: VOID, loc }, loc });
    const addIf = (cond: IrExpr, v: IrExpr): IrStmt[] => [{ kind: "if", cond, then: [addTo(v)], else_: null, loc }];
    const returnIf = (cond: IrExpr, value: boolean): IrStmt[] =>
      [{ kind: "if", cond, then: [{ kind: "return", value: boolLit(value), loc }], else_: null, loc }];
    const body: IrStmt[] = [];
    if (!predicate) {
      locals.push({ id: "r.0", name: "r", type: setT, mutable: false });
      body.push({ kind: "varDecl", localId: "r.0", init: { kind: "setNew", type: setT, loc }, loc });
    }
    switch (method) {
      case "union":
        body.push(loopOver("a.0", (v) => [addTo(v)]));
        body.push(loopOver("b.0", (v) => [addTo(v)]));
        break;
      case "intersection":
        body.push({
          kind: "if",
          cond: { kind: "bin", op: "<=", left: setOp("a.0", "size", [], F64), right: setOp("b.0", "size", [], F64), type: BOOL, loc },
          then: [loopOver("a.0", (v) => addIf(has("b.0", v), v))],
          else_: [loopOver("b.0", (v) => addIf(has("a.0", v), v))],
          loc,
        });
        break;
      case "difference":
        body.push(loopOver("a.0", (v) => addIf(not(has("b.0", v)), v)));
        break;
      case "symmetricDifference":
        body.push(loopOver("a.0", (v) => addIf(not(has("b.0", v)), v)));
        body.push(loopOver("b.0", (v) => addIf(not(has("a.0", v)), v)));
        break;
      case "isSubsetOf":
        body.push(loopOver("a.0", (v) => returnIf(not(has("b.0", v)), false)));
        break;
      case "isSupersetOf":
        body.push(loopOver("b.0", (v) => returnIf(not(has("a.0", v)), false)));
        break;
      case "isDisjointFrom":
        body.push(loopOver("a.0", (v) => returnIf(has("b.0", v), false)));
        break;
      default:
        throw new Error(`lowerer bug: unknown set combine method ${method}`);
    }
    body.push({ kind: "return", value: predicate ? boolLit(true) : ref("r.0", setT), loc });
    return {
      name,
      params: [
        { localId: "a.0", name: "a", type: setT },
        { localId: "b.0", name: "b", type: setT },
      ],
      returnType: predicate ? BOOL : setT,
      locals,
      body,
      loc,
    };
  }

/** `for (const [k, v] of m)` / `for (const e of m)` — for-of over a Map,
   * desugared IN PLACE (the body is user code, so no helper function) over
   * the same iteration primitives as the forEach desugar, with the same
   * Node-exact live-iteration contract: iterCount re-read every pass
   * (entries appended by the body are visited), tombstones skipped
   * (deleted entries are not). Shape:
   *
   *   %m = <iterable>; %m.iterEnter();
   *   try {
   *     for (%i = 0; %i < %m.iterCount; %i++) {
   *       if (%m.iterLive(%i)) { <bindings>; <body> }
   *     }
   *   } catch (%c) { %m.iterExit(); rethrow %c; }
   *   %m.iterExit();
   *
   * catch-and-rethrow instead of a finally because break/continue/return
   * may not cross a finally (the emitter's documented contract) and a
   * for-of body legitimately contains all three: break/continue bind to
   * the desugared loop INSIDE the plain try (jumps out of plain try need
   * nothing), and every `return` in the body gets an iterExit inserted
   * before it (exitBeforeReturns) so the depth count stays exact on that
   * path too. A `[k, v]` head of plain identifiers binds straight from
   * iterKey/iterValue — the tuple record never materializes; an identifier
   * head binds the checker's own [K, V] tuple built per iteration. */
  /** The iterator-method projections a for-of can ride directly:
   * `for (const k of m.keys())`, `.values()`, `.entries()` — the SAME
   * live-iteration walk as `for..of m` (JS's container iterators are live
   * views, not snapshots), just yielding the key, the value, or the pair. */
  export type ForOfIterProjection = "keys" | "values" | "entries";

/** for-of over a URLSearchParams (and its keys()/values()/entries()
   * projections consumed directly by the head): the LIVE index walk —
   * sp.size re-reads every pass, so entries appended mid-walk are visited
   * and deletes shift, the spec's index-based iterator exactly. No
   * enter/exit bracketing: the pair list compacts immediately (no
   * tombstones), so there is no iteration depth to keep exact. */
  export function lowerForOfSearchParams(L: Lowerer, stmt: ts.ForOfStatement,
    iterable: IrExpr,
    proj?: ForOfIterProjection,): IrStmt {
    const loc = locOf(stmt);
    const SP: IrType = iterable.type;
    const yieldsPair = proj === undefined || proj === "entries";
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
      );
    }
    const list = stmt.initializer;
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || isVar;
    const decl = list.declarations[0]!; // the grammar allows exactly one
    L.scopes.push(new Map());
    try {
      const sp = L.declareHiddenLocal("%spof", SP);
      const i = L.declareHiddenLocal("%iterof", F64);
      i.mutable = true;
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const read = (fn: "sp.size" | "sp.keyAt" | "sp.valAt", idx: boolean): IrExpr => ({
        kind: "libCall",
        fn,
        args: idx ? [ref(sp.id, SP), ref(i.id, F64)] : [ref(sp.id, SP)],
        type: idx ? STRING : F64,
        loc,
      });
      const keyRead = (): IrExpr => read("sp.keyAt", true);
      const valRead = (): IrExpr => read("sp.valAt", true);
      const singleRead = (): IrExpr => (proj === "values" ? valRead() : keyRead());

      const binds: IrStmt[] = [];
      const isPlainIdent = (el: ts.ArrayBindingElement): el is ts.BindingElement & { name: ts.Identifier } =>
        ts.isBindingElement(el) && el.name !== undefined && ts.isIdentifier(el.name) && !el.initializer && !el.dotDotDotToken;
      if (
        yieldsPair &&
        !isVar && // var pattern names assign hoisted slots — the generic desugar below owns them
        ts.isArrayBindingPattern(decl.name) &&
        decl.name.elements.length >= 1 && decl.name.elements.length <= 2 &&
        decl.name.elements.every(isPlainIdent)
      ) {
        // `for (const [k, v] of sp)` — bind straight from the reads; the
        // tuple never exists. `[k]` alone reads only the key.
        const els = decl.name.elements as readonly (ts.BindingElement & { name: ts.Identifier })[];
        const kLocal = L.declareLocal(els[0]!.name, els[0]!.name.text, STRING, isLet);
        binds.push({ kind: "varDecl", localId: kLocal.id, init: keyRead(), loc });
        if (els[1]) {
          const vLocal = L.declareLocal(els[1].name, els[1].name.text, STRING, isLet);
          binds.push({ kind: "varDecl", localId: vLocal.id, init: valRead(), loc });
        }
      } else {
        // Identifier heads and the remaining patterns bind through the
        // checker's own element type — [string, string] for pair yields,
        // string otherwise — the Map desugar's exact shape.
        const elemT = L.mapTypeOf(L.checker.getTypeAtLocation(decl.name));
        if (yieldsPair) {
          const shape = elemT?.kind === "record" ? L.shapes.get(elemT.shapeId) : null;
          if (
            elemT?.kind !== "record" || !shape?.tuple || shape.fields.length !== 2 ||
            shape.fields.some((f) => f.type.kind !== "string")
          ) {
            L.badType(decl.name, L.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares [string, string]
          }
        } else if (elemT?.kind !== "string") {
          L.badType(decl.name, L.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares string
        }
        const elemInit: IrExpr = yieldsPair
          ? {
              kind: "recordLit",
              fields: [
                { name: "0", value: keyRead() },
                { name: "1", value: valRead() },
              ],
              type: elemT!,
              loc,
            }
          : singleRead();
        if (ts.isIdentifier(decl.name)) {
          const varTarget = forOfVarTarget(L, decl);
          if (varTarget) {
            // `for (var x of ...)`: one function-scoped binding, assigned
            // per pass — closures made in the loop share it, and the value
            // persists after the loop (both Node-exact for var).
            const tmp = L.declareHiddenLocal("%vof", elemT!);
            binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
            binds.push({
              kind: "assign",
              localId: varTarget.id,
              value: L.coerceInto(decl.name, { kind: "varRef", localId: tmp.id, type: elemT!, loc }, varTarget.type),
              loc,
            });
          } else {
            const local = L.declareLocal(decl.name, decl.name.text, elemT!, isLet);
            binds.push({ kind: "varDecl", localId: local.id, init: elemInit, loc });
          }
        } else {
          const tmp = L.declareHiddenLocal("%destr", elemT!);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
          L.lowerBindingPattern(
            decl.name,
            () => ({ kind: "varRef", localId: tmp.id, type: elemT!, loc }),
            elemT!,
            isLet,
            binds,
          );
        }
      }

      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement));
      const loop: IrStmt = {
        kind: "for",
        init: { kind: "varDecl", localId: i.id, init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref(i.id, F64), right: read("sp.size", false), type: BOOL, loc },
        update: {
          kind: "assign",
          localId: i.id,
          value: { kind: "bin", op: "+", left: ref(i.id, F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [...binds, ...body],
        loc,
      };
      return {
        kind: "block",
        body: [{ kind: "varDecl", localId: sp.id, init: iterable, loc }, loop],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** for-of over an ARRAY/typed-array keys()/entries() projection consumed directly
   * by the head (`for (const [index, line] of lines.entries())` — the
   * dominant formatter idiom): the LIVE index walk — the length re-reads
   * every pass, exactly the array iterator's contract (elements appended
   * mid-walk are visited; a shrink ends the loop early) — yielding the
   * index (`keys`, a number) or the [index, element] pair (`entries`).
   * `values` never lands here: lowerForOf's receiver unwrap owns it. A
   * `[i, v]` head of plain identifiers binds straight from the reads (the
   * tuple never materializes); identifier heads and the remaining
   * patterns bind through the checker's own element type — the interned
   * [number, T] tuple record. Stored iterator OBJECTS keep their fence
   * (only the direct for-of position unwraps). */
  export function lowerForOfArrayIter(L: Lowerer, stmt: ts.ForOfStatement,
    iterable: IrExpr & {
      type:
        | (IrType & { kind: "array" })
        | (IrType & { kind: "bytes" });
    },
    proj: "keys" | "entries",): IrStmt {
    const loc = locOf(stmt);
    const arrT = iterable.type;
    const elemT = arrT.kind === "array" ? arrT.elem : F64;
    const yieldsPair = proj === "entries";
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
      );
    }
    const list = stmt.initializer;
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || isVar;
    const decl = list.declarations[0]!; // the grammar allows exactly one
    L.scopes.push(new Map());
    try {
      const arr = L.declareHiddenLocal("%arof", arrT);
      const i = L.declareHiddenLocal("%iterof", F64);
      i.mutable = true;
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const keyRead = (): IrExpr => ref(i.id, F64);
      const valRead = (): IrExpr =>
        arrT.kind === "array"
          ? {
              kind: "arrayGet",
              arr: ref(arr.id, arrT),
              index: ref(i.id, F64),
              type: elemT,
              loc,
            }
          : {
              kind: "bytesIntrinsic",
              method: "get",
              receiver: ref(arr.id, arrT),
              args: [ref(i.id, F64)],
              type: F64,
              loc,
            };

      const binds: IrStmt[] = [];
      const isPlainIdent = (el: ts.ArrayBindingElement): el is ts.BindingElement & { name: ts.Identifier } =>
        ts.isBindingElement(el) && el.name !== undefined && ts.isIdentifier(el.name) && !el.initializer && !el.dotDotDotToken;
      if (
        yieldsPair &&
        !isVar && // var pattern names assign hoisted slots — the generic desugar below owns them
        ts.isArrayBindingPattern(decl.name) &&
        decl.name.elements.length >= 1 && decl.name.elements.length <= 2 &&
        decl.name.elements.every(isPlainIdent)
      ) {
        // `for (const [i, v] of xs.entries())` — bind straight from the
        // reads; the tuple never exists. `[i]` alone reads only the index.
        const els = decl.name.elements as readonly (ts.BindingElement & { name: ts.Identifier })[];
        const kLocal = L.declareLocal(els[0]!.name, els[0]!.name.text, F64, isLet);
        binds.push({ kind: "varDecl", localId: kLocal.id, init: keyRead(), loc });
        if (els[1]) {
          const vLocal = L.declareLocal(els[1].name, els[1].name.text, elemT, isLet);
          binds.push({ kind: "varDecl", localId: vLocal.id, init: valRead(), loc });
        }
      } else {
        // Identifier heads and the remaining patterns bind through the
        // checker's own element type — [number, T] for pair yields,
        // number otherwise — the Map desugar's exact shape.
        const declT = L.mapTypeOf(L.checker.getTypeAtLocation(decl.name));
        if (yieldsPair) {
          const shape = declT?.kind === "record" ? L.shapes.get(declT.shapeId) : null;
          if (
            declT?.kind !== "record" || !shape?.tuple || shape.fields.length !== 2 ||
            shape.fields.find((f) => f.name === "0")?.type.kind !== "f64" ||
            !typeEquals(shape.fields.find((f) => f.name === "1")?.type ?? F64, elemT)
          ) {
            L.badType(decl.name, L.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares [number, T]
          }
        } else if (declT?.kind !== "f64") {
          L.badType(decl.name, L.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares number
        }
        const elemInit: IrExpr = yieldsPair
          ? {
              kind: "recordLit",
              fields: [
                { name: "0", value: keyRead() },
                { name: "1", value: valRead() },
              ],
              type: declT!,
              loc,
            }
          : keyRead();
        if (ts.isIdentifier(decl.name)) {
          const varTarget = forOfVarTarget(L, decl);
          if (varTarget) {
            // `for (var x of ...)`: one function-scoped binding, assigned
            // per pass — closures made in the loop share it, and the value
            // persists after the loop (both Node-exact for var).
            const tmp = L.declareHiddenLocal("%vof", declT!);
            binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
            binds.push({
              kind: "assign",
              localId: varTarget.id,
              value: L.coerceInto(decl.name, { kind: "varRef", localId: tmp.id, type: declT!, loc }, varTarget.type),
              loc,
            });
          } else {
            const local = L.declareLocal(decl.name, decl.name.text, declT!, isLet);
            binds.push({ kind: "varDecl", localId: local.id, init: elemInit, loc });
          }
        } else {
          const tmp = L.declareHiddenLocal("%destr", declT!);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
          L.lowerBindingPattern(
            decl.name,
            () => ({ kind: "varRef", localId: tmp.id, type: declT!, loc }),
            declT!,
            isLet,
            binds,
          );
        }
      }

      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement));
      const loop: IrStmt = {
        kind: "for",
        init: { kind: "varDecl", localId: i.id, init: num(0), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: ref(i.id, F64),
          right:
            arrT.kind === "array"
              ? {
                  kind: "arrIntrinsic",
                  method: "length",
                  receiver: ref(arr.id, arrT),
                  args: [],
                  type: F64,
                  loc,
                }
              : {
                  kind: "bytesIntrinsic",
                  method: "length",
                  receiver: ref(arr.id, arrT),
                  args: [],
                  type: F64,
                  loc,
                },
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: i.id,
          value: { kind: "bin", op: "+", left: ref(i.id, F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [...binds, ...body],
        loc,
      };
      return {
        kind: "block",
        body: [{ kind: "varDecl", localId: arr.id, init: iterable, loc }, loop],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

  export function lowerForOfMap(L: Lowerer, stmt: ts.ForOfStatement,
    iterable: IrExpr,
    mapT: IrType & { kind: "map" },
    proj?: ForOfIterProjection,): IrStmt {
    return lowerForOfMapOrSet(L, stmt, iterable, mapT, proj);
  }

/** `for (const v of s)` — for-of over a Set: the Map desugar with iterKey
   * as the (single) element read; same live-iteration contract. */
  export function lowerForOfSet(L: Lowerer, stmt: ts.ForOfStatement,
    iterable: IrExpr,
    setT: IrType & { kind: "set" },
    proj?: ForOfIterProjection,): IrStmt {
    return lowerForOfMapOrSet(L, stmt, iterable, setT, proj);
  }

  function lowerForOfMapOrSet(L: Lowerer, stmt: ts.ForOfStatement,
    iterable: IrExpr,
    contT: (IrType & { kind: "map" }) | (IrType & { kind: "set" }),
    proj?: ForOfIterProjection,): IrStmt {
    const loc = locOf(stmt);
    const isMap = contT.kind === "map";
    // What each pass YIELDS: a [first, second] pair (the Map default and
    // `.entries()` — a Set's entries are [v, v], like JS), or one value
    // (the Set default/keys/values; a Map's `.keys()` or `.values()`).
    const yieldsPair = proj === "entries" || (isMap && proj === undefined);
    // Expression heads (`for ([k = "", v = false] of map)`): the pair (or
    // single value) builds into a hidden per-iteration local and the
    // destructuring-assignment machinery assigns the pre-declared
    // bindings — handled below where the reads exist. Identifier heads
    // ride the same shape.
    const exprHead = !ts.isVariableDeclarationList(stmt.initializer) ? stmt.initializer : null;
    let isVar = false;
    let isLet = false;
    let decl: ts.VariableDeclaration | null = null;
    if (!exprHead) {
      const list = stmt.initializer as ts.VariableDeclarationList;
      if ((list.flags & ts.NodeFlags.Using) !== 0) {
        L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
      }
      isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
      isLet = (list.flags & ts.NodeFlags.Let) !== 0 || isVar;
      decl = list.declarations[0]!; // the grammar allows exactly one
    }
    L.scopes.push(new Map());
    try {
      const m = L.declareHiddenLocal(isMap ? "%mapof" : "%setof", contT);
      const i = L.declareHiddenLocal("%iterof", F64);
      i.mutable = true; // the loop counter reassigns (hidden locals default const)
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const iter = (method: string, args: IrExpr[], type: IrType): IrExpr =>
        isMap
          ? { kind: "mapIntrinsic", method: method as IrMapIntrinsicMethod, receiver: ref(m.id, contT), args, type, loc }
          : { kind: "setIntrinsic", method: method as IrSetIntrinsicMethod, receiver: ref(m.id, contT), args, type, loc };
      const keyT = isMap ? (contT as IrType & { kind: "map" }).key : (contT as IrType & { kind: "set" }).elem;
      const keyRead = (): IrExpr => iter("iterKey", [ref(i.id, F64)], keyT);
      const valRead = (): IrExpr =>
        iter("iterValue", [ref(i.id, F64)], (contT as IrType & { kind: "map" }).value);
      // The pair's second position (a Map's value; a Set entry repeats the
      // element — JS's [v, v]) and the single yield (a Map's `.values()`
      // reads the value; everything else reads the key/element).
      const secondT = isMap ? (contT as IrType & { kind: "map" }).value : keyT;
      const secondRead = (): IrExpr => (isMap ? valRead() : keyRead());
      const singleT = isMap && proj === "values" ? (contT as IrType & { kind: "map" }).value : keyT;
      const singleRead = (): IrExpr => (isMap && proj === "values" ? valRead() : keyRead());

      // The per-iteration bindings at the top of the loop body.
      const binds: IrStmt[] = [];
      if (exprHead) {
        // A PRE-DECLARED head: the element (the [K, V] pair or the single
        // value) lands in a hidden per-iteration local, then either the
        // plain assignment or the destructuring-assignment machinery
        // writes the existing bindings — the array for-of's exact rule.
        let target = exprHead as ts.Expression;
        while (ts.isParenthesizedExpression(target)) target = target.expression;
        const elemT: IrType = yieldsPair
          ? { kind: "record", shapeId: L.shapes.intern([{ name: "0", type: keyT }, { name: "1", type: secondT }], true) }
          : singleT;
        const elemInit: IrExpr = yieldsPair
          ? { kind: "recordLit", fields: [{ name: "0", value: keyRead() }, { name: "1", value: secondRead() }], type: elemT, loc }
          : singleRead();
        const tmp = L.declareHiddenLocal("%vof", elemT);
        binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
        const elemRef: IrExpr = { kind: "varRef", localId: tmp.id, type: elemT, loc };
        if (ts.isIdentifier(target)) {
          const w = L.resolveWritable(target);
          if (!w) L.rejectUnresolved(target, `assignment to '${target.text}' (not a writable local or module global)`);
          binds.push({ kind: "assign", localId: w.id, value: L.coerceInto(target, elemRef, w.type), loc });
        } else if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
          binds.push(lowerDestructuringAssign(L, target, elemRef, target, loc));
        } else {
          L.unsupported("SC1090", exprHead, "for-of heads assigning member expressions (assign a variable, then write the member out)");
        }
      } else {
      const isPlainIdent = (el: ts.ArrayBindingElement): el is ts.BindingElement & { name: ts.Identifier } =>
        ts.isBindingElement(el) && el.name !== undefined && ts.isIdentifier(el.name) && !el.initializer && !el.dotDotDotToken;
      if (
        yieldsPair &&
        !isVar && // var pattern names assign hoisted slots — the generic desugar below owns them
        ts.isArrayBindingPattern(decl!.name) &&
        decl!.name.elements.length >= 1 && decl!.name.elements.length <= 2 &&
        decl!.name.elements.every(isPlainIdent)
      ) {
        // `for (const [k, v] of m)` — bind straight from the primitives;
        // the tuple never exists. `[k]` alone reads only the key.
        const els = decl!.name.elements as readonly (ts.BindingElement & { name: ts.Identifier })[];
        const kLocal = L.declareLocal(els[0]!.name, els[0]!.name.text, keyT, isLet);
        binds.push({ kind: "varDecl", localId: kLocal.id, init: keyRead(), loc });
        if (els[1]) {
          const vLocal = L.declareLocal(els[1].name, els[1].name.text, secondT, isLet);
          binds.push({ kind: "varDecl", localId: vLocal.id, init: secondRead(), loc });
        }
      } else {
        // Identifier heads and the remaining patterns bind through the
        // checker's own element type — the [K, V] tuple for pair yields,
        // T otherwise — built/read once into a hidden per-iteration
        // local, the array for-of's exact desugar.
        const elemT = L.mapTypeOf(L.checker.getTypeAtLocation(decl!.name));
        if (yieldsPair) {
          const shape = elemT?.kind === "record" ? L.shapes.get(elemT.shapeId) : null;
          if (
            elemT?.kind !== "record" || !shape?.tuple || shape.fields.length !== 2 ||
            !typeEquals(shape.fields.find((f) => f.name === "0")!.type, keyT) ||
            !typeEquals(shape.fields.find((f) => f.name === "1")!.type, secondT)
          ) {
            L.badType(decl!.name, L.checker.getTypeAtLocation(decl!.name)); // defensive: the lib declares [K, V]
          }
        } else if (!elemT || !typeEquals(elemT, singleT)) {
          L.badType(decl!.name, L.checker.getTypeAtLocation(decl!.name)); // defensive: the lib declares T
        }
        const elemInit: IrExpr = yieldsPair
          ? {
              kind: "recordLit",
              fields: [
                { name: "0", value: keyRead() },
                { name: "1", value: secondRead() },
              ],
              type: elemT!,
              loc,
            }
          : singleRead();
        if (ts.isIdentifier(decl!.name)) {
          const varTarget = forOfVarTarget(L, decl!);
          if (varTarget) {
            // `for (var x of ...)`: one function-scoped binding, assigned
            // per pass — closures made in the loop share it, and the value
            // persists after the loop (both Node-exact for var).
            const tmp = L.declareHiddenLocal("%vof", elemT!);
            binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
            binds.push({
              kind: "assign",
              localId: varTarget.id,
              value: L.coerceInto(decl!.name, { kind: "varRef", localId: tmp.id, type: elemT!, loc }, varTarget.type),
              loc,
            });
          } else {
            const local = L.declareLocal(decl!.name, decl!.name.text, elemT!, isLet);
            binds.push({ kind: "varDecl", localId: local.id, init: elemInit, loc });
          }
        } else {
          const tmp = L.declareHiddenLocal("%destr", elemT!);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
          L.lowerBindingPattern(
            decl!.name,
            () => ({ kind: "varRef", localId: tmp.id, type: elemT!, loc }),
            elemT!,
            isLet,
            binds,
          );
        }
      }

      }
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement));
      const exitStmt = (): IrStmt => ({ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc });
      const loop: IrStmt = {
        kind: "for",
        init: { kind: "varDecl", localId: i.id, init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref(i.id, F64), right: iter("iterCount", [], F64), type: BOOL, loc },
        update: {
          kind: "assign",
          localId: i.id,
          value: { kind: "bin", op: "+", left: ref(i.id, F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "if",
            cond: iter("iterLive", [ref(i.id, F64)], BOOL),
            then: [...binds, ...exitBeforeReturns(body, exitStmt)],
            else_: null,
            loc,
          },
        ],
        loc,
      };
      const caught = L.declareHiddenLocal("%iterexc", CAUGHT);
      return {
        kind: "block",
        body: [
          { kind: "varDecl", localId: m.id, init: iterable, loc },
          { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
          {
            kind: "tryCatch",
            tryBody: [loop],
            catchBody: [exitStmt(), { kind: "rethrow", localId: caught.id, loc }],
            catchLocalId: caught.id,
            finallyBody: null,
            loc,
          },
          exitStmt(),
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** Rewrites a lowered for-of-over-Map/Set body so every `return` runs the
   * loop's iterExit first (JS closes the live iterator before returning).
   * Recurses through every nested statement list; nested functions are
   * lifted elsewhere and never appear here, so every return found exits
   * THIS function through the active iteration. */
  function exitBeforeReturns(stmts: IrStmt[], make: () => IrStmt): IrStmt[] {
    const walk = (list: IrStmt[]): IrStmt[] =>
      list.flatMap((s): IrStmt[] => {
        switch (s.kind) {
          case "return":
            return [make(), s];
          case "if":
            return [{ ...s, then: walk(s.then), else_: s.else_ ? walk(s.else_) : null }];
          case "for":
            return [{ ...s, body: walk(s.body) }];
          case "while":
          case "doWhile":
          case "forOf":
          case "block":
            return [{ ...s, body: walk(s.body) }];
          case "switch":
            return [{ ...s, cases: s.cases.map((c) => ({ ...c, body: walk(c.body) })) }];
          case "tryCatch":
            return [
              {
                ...s,
                tryBody: walk(s.tryBody),
                catchBody: s.catchBody ? walk(s.catchBody) : null,
                finallyBody: s.finallyBody ? walk(s.finallyBody) : null,
              },
            ];
          default:
            return [s];
        }
      });
    return walk(stmts);
  }

/** `new Map(entries)` from a tuple-array VALUE — any `[K, V][]`-typed
   * expression (a variable, a .map() result, a sorted entries spread), not
   * just the pair-literal form lower-classes handles inline. Desugars to a
   * direct call of a synthetic function that constructs the empty map and
   * set()s each pair in array order — JS-exact: pairs are visited in
   * insertion order and a later duplicate key overwrites while keeping the
   * first occurrence's position (set()'s own contract). Null when the
   * argument isn't a matching tuple array (the caller keeps its fence). */
  export function lowerMapSeedArrayNew(L: Lowerer, argNode: ts.Expression,
    mapT: IrType & { kind: "map" },): IrExpr | null {
    if (ts.isSpreadElement(argNode)) return null;
    const seed = L.lowerExpr(argNode);
    if (seed.type.kind !== "array" || seed.type.elem.kind !== "record") return null;
    const elem = seed.type.elem;
    const shape = L.shapes.get(elem.shapeId);
    if (!shape?.tuple || shape.fields.length !== 2) return null;
    const kT = shape.fields.find((f) => f.name === "0")!.type;
    const vT = shape.fields.find((f) => f.name === "1")!.type;
    if (!typeEquals(kT, mapT.key) || !typeEquals(vT, mapT.value)) return null;
    const loc = locOf(argNode);
    const key = `seed:${typeKey(mapT.key)}:${typeKey(mapT.value)}:${elem.shapeId}`;
    let helper = L.mapHofHelpers.get(key);
    if (!helper) {
      helper = `%map.seed.${L.mapHofHelpers.size}`;
      L.mapHofHelpers.set(key, helper);
      L.liftedFns.push(buildMapSeedFn(mapT, helper, seed.type, elem, kT, vT, loc));
    }
    return { kind: "call", callee: helper, args: [seed], type: mapT, loc };
  }

/** The seeding loop, from existing IR nodes:
   *
   *   m = new Map();
   *   for (i = 0; i < a.length; i++) { e = a[i]; m.set(e[0], e[1]); }
   *   return m;
   *
   * No user code runs mid-loop (keys/values are plain reads), so the length
   * read's freshness is unobservable — it re-reads anyway, matching the
   * array iterator `new Map(arr)` drains in JS. */
  function buildMapSeedFn(mapT: IrType & { kind: "map" }, name: string,
    arrT: IrType & { kind: "array" },
    tupleT: IrType & { kind: "record" },
    kT: IrType,
    vT: IrType,
    loc: SrcLoc,): IrFunction {
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const e = ref("e.0", tupleT);
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "m.0", init: { kind: "mapNew", type: mapT, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: ref("i.0", F64),
          right: { kind: "arrIntrinsic", method: "length", receiver: ref("a.0", arrT), args: [], type: F64, loc },
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
          loc,
        },
        body: [
          { kind: "varDecl", localId: "e.0", init: getElemExpr(arrT, tupleT, loc), loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "mapIntrinsic",
              method: "set",
              receiver: ref("m.0", mapT),
              args: [
                { kind: "recordGet", obj: e, shapeId: tupleT.shapeId, field: "0", type: kT, loc },
                { kind: "recordGet", obj: e, shapeId: tupleT.shapeId, field: "1", type: vT, loc },
              ],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("m.0", mapT), loc },
    ];
    return {
      name,
      params: [{ localId: "a.0", name: "a", type: arrT }],
      returnType: mapT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "m.0", name: "m", type: mapT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "e.0", name: "e", type: tupleT, mutable: false },
      ],
      body,
      loc,
    };
  }

/** Regex method calls, both directions: `re.test(s)` on a regex receiver,
   * and `s.replace(re, tpl)` / `s.replaceAll(re, tpl)` / `s.split(re)` on a
   * string receiver whose FIRST ARGUMENT is a regex (the string-pattern
   * overloads keep their island lowering — the argument's mapped type is
   * what routes here, before lowerIslandMethodCall can claim the name).
   * Null when neither shape matches. */
  export function lowerRegexMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    dynReceiver?: () => IrExpr,): IrExpr | null {
    // chainBlocked, not a raw token test: an optional-chain re-dispatch
    // (`rawName?.match(re)` — the receiver reads back chain-narrowed)
    // rides the same lowering as the plain spelling.
    if (L.chainBlocked(access, call)) return null;
    // A validated dyn receiver (lowerStringMethodCall's story) is a STRING
    // by construction — the symbol gate doesn't apply to `any` receivers.
    if (dynReceiver === undefined && !L.isStdlibMember(access)) return null;
    const name = access.name.text;
    const receiverKind = dynReceiver ? "string" : L.mapTypeOf(L.typeOf(access.expression))?.kind;
    const lowerReceiver = (): IrExpr => (dynReceiver ? dynReceiver() : L.lowerExpr(access.expression));
    const loc = locOf(call);
    if (receiverKind === "regex" && name === "test") {
      // The statefulness fence, at compile time where the flags are
      // visible: a literal receiver (possibly parenthesized). Values that
      // flow through variables hit the same fence at runtime.
      let recv: ts.Expression = access.expression;
      while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
      if (ts.isRegularExpressionLiteral(recv)) {
        const flags = recv.text.slice(recv.text.lastIndexOf("/") + 1);
        if (flags.includes("g") || flags.includes("y")) {
          L.unsupported("SC1121", call);
        }
      }
      const receiver = L.lowerExpr(access.expression);
      const args = call.arguments.map((a) => L.lowerExpr(a));
      return { kind: "regexIntrinsic", method: "test", receiver, args, type: BOOL, loc };
    }
    // `re.exec(s)` for non-g/y regexes: spec-identical to `s.match(re)`
    // (Symbol.match delegates to exec when lastIndex is out of play), so
    // it lowers to the SAME match intrinsic with the operands swapped —
    // the honest `string[] | null` slice, nonparticipating captures ""
    // (match's documented rule). The g/y statefulness fence applies at
    // compile time on literal receivers, exactly test()'s stance; values
    // reaching the runtime with those flags abort there.
    if (receiverKind === "regex" && name === "exec") {
      if (call.arguments.length !== 1) return null; // exec takes exactly the subject
      let recv: ts.Expression = access.expression;
      while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
      if (ts.isRegularExpressionLiteral(recv)) {
        const flags = recv.text.slice(recv.text.lastIndexOf("/") + 1);
        if (flags.includes("g") || flags.includes("y")) {
          L.unsupported("SC1121", call);
        }
      }
      const re = L.lowerExpr(access.expression);
      const subject = L.lowerExprExpecting(call.arguments[0]!, STRING);
      const resultT: IrType = { kind: "union", unionId: L.unions.intern([arrayOf(STRING), { kind: "nullT" }]) };
      return { kind: "regexIntrinsic", method: "match", receiver: subject, args: [re], type: resultT, loc };
    }
    // `s.match(re)` for non-g/y regexes: Node's exec-shaped result reduced
    // to the honest slice — the `string[] | null` union holding
    // [whole match, ...captures] or the null arm. The g-flag match returns
    // EVERY match (a different shape) and /y is stateful — both fence at
    // compile time on literal arguments (values reaching the runtime with
    // those flags abort, the test() stance). `.index`/`.input` reads on
    // the result fence per member (array-typed value); `.groups` reads
    // desugar at their access sites when the regex is statically known
    // (lowerMatchGroupsRead).
    // `s.match(re)` also claims a NULLABLE string receiver (string + unit
    // arms — `process.versions.openssl.match(...)`, the Dict<string>
    // member the node suite's crypto helper reads): the checked
    // extraction narrows to the string arm and a unit value throws the
    // catchable TypeError at the read, where Node's own member read
    // throws — tsc only admits the spelling in JS sources.
    const nullableStringRecv =
      receiverKind === "union" &&
      name === "match" &&
      (() => {
        const t = L.mapTypeOf(L.typeOf(access.expression));
        if (t?.kind !== "union") return false;
        const arms = L.unions.get(t.unionId)?.arms ?? [];
        return arms.some((a) => a.kind === "string") && arms.every((a) => a.kind === "string" || isUnitType(a));
      })();
    if ((receiverKind === "string" || nullableStringRecv) && name === "match") {
      const arg0 = call.arguments[0];
      if (!arg0 || L.mapTypeOf(L.typeOf(arg0))?.kind !== "regex") return null; // string-pattern match: the SC2020 fence
      if (call.arguments.length !== 1) return null;
      let reNode: ts.Expression = arg0;
      while (ts.isParenthesizedExpression(reNode)) reNode = reNode.expression;
      if (ts.isRegularExpressionLiteral(reNode)) {
        const flags = reNode.text.slice(reNode.text.lastIndexOf("/") + 1);
        if (flags.includes("g") || flags.includes("y")) {
          L.unsupported(
            "SC1120",
            call,
            "'.match()' with the 'g' or 'y' flag (an every-match array is a different shape — use replaceAll/split, or test() per position)",
          );
        }
      }
      const receiver = nullableStringRecv ? L.lowerExprExpecting(access.expression, STRING) : lowerReceiver();
      const re = L.lowerExpr(arg0);
      // RegExpMatchArray | null maps to the string[] | null union by
      // itself; intern it directly when the checker's spelling doesn't —
      // or when it maps to something WIDER (an optional-chain call node
      // types `s?.match(re)` with the chain's `| undefined`; the intrinsic
      // itself answers string[] | null, and the chain wrapper widens).
      const exactT: IrType = { kind: "union", unionId: L.unions.intern([arrayOf(STRING), { kind: "nullT" }]) };
      const mapped = L.mapTypeOf(L.typeOf(call));
      const resultT: IrType = mapped && typeEquals(mapped, exactT) ? mapped : exactT;
      return { kind: "regexIntrinsic", method: "match", receiver, args: [re], type: resultT, loc };
    }
    // `s.matchAll(re)` — the every-match iterator drained EAGERLY into a
    // string[][] (one honest match slice per row — match's rule). Lazy vs
    // eager is unobservable here: strings are immutable, and the spec
    // clones the regex at the call, so nothing can perturb the drain. The
    // eager array IS what the two lowered consumers see anyway (the
    // immediate [...spread] and the for-of walk); a stored iterator's
    // .next() fences as an array member like any other. Non-global
    // regexes throw Node's exact TypeError at runtime, catchably
    // (replaceAll's stance).
    if (receiverKind === "string" && name === "matchAll") {
      const arg0 = call.arguments[0];
      if (!arg0 || L.mapTypeOf(L.typeOf(arg0))?.kind !== "regex") return null; // string-pattern form: the SC2020 fence
      if (call.arguments.length !== 1) return null;
      const receiver = lowerReceiver();
      const re = L.lowerExpr(arg0);
      return {
        kind: "regexIntrinsic",
        method: "matchAll",
        receiver,
        args: [re],
        type: arrayOf(arrayOf(STRING)),
        loc,
      };
    }
    // `s.search(re)` — the first match's UTF-16 index, or -1. No g/y fence
    // (unlike test/match): Symbol.search neither reads nor writes lastIndex
    // — a fresh exec from position 0, so /g is irrelevant and /y anchors at
    // 0, exactly Node. Never throws.
    if (receiverKind === "string" && name === "search") {
      const arg0 = call.arguments[0];
      if (!arg0 || L.mapTypeOf(L.typeOf(arg0))?.kind !== "regex") return null; // string-pattern form: the SC2020 fence
      if (call.arguments.length !== 1) return null;
      const receiver = lowerReceiver();
      const re = L.lowerExpr(arg0);
      return { kind: "regexIntrinsic", method: "search", receiver, args: [re], type: F64, loc };
    }
    if (
      receiverKind === "string" &&
      (name === "replace" || name === "replaceAll" || name === "split")
    ) {
      const arg0 = call.arguments[0];
      if (!arg0 || L.mapTypeOf(L.typeOf(arg0))?.kind !== "regex") return null;
      const receiver = lowerReceiver();
      // Split's omitted or undefined limit is 2^32-1. Complete it here so
      // both IR backends and the runtime have one required (regex, limit)
      // shape; an optional-number value selects the default at runtime.
      const args = name === "split"
        ? [L.lowerExpr(arg0), lowerSplitLimitArg(L, call.arguments[1], loc)]
        : call.arguments.map((a) => L.lowerExpr(a));
      if (name !== "split" && args[1]?.type.kind !== "string") {
        L.unsupported(
          "SC1120",
          call.arguments[1] ?? call,
          "function replacement values (replacements must be string templates)",
        );
      }
      return {
        kind: "regexIntrinsic",
        method: name,
        receiver,
        args,
        type: name === "split" ? arrayOf(STRING) : STRING,
        loc,
      };
    }
    return null;
  }

/** `s.slice(1, 4)` and friends → strIntrinsic. Null when this isn't an
   * ambient string method call (caller keeps its generic rejection). Missing
   * optional arguments are omitted from `args` — the backend fills the
   * documented defaults; the IR never encodes them (Infinity isn't
   * JSON-safe). tsc has already checked arity and argument types against
   * ambient/scriptc.d.ts. */
  export function lowerStringMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    dynReceiver?: () => IrExpr,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    if (dynReceiver === undefined && access.name.text === "localeCompare") return lowerLocaleCompareCall(L, call, access);
    const entry = own(STR_METHODS, access.name.text);
    if (!entry) return null;
    // A validated dyn receiver (`pkg.name.replace(...)` on a JSON.parse
    // value) arrives pre-extracted through `dynReceiver`; its checker type
    // is `any`, so the type/symbol gates don't apply — the dyn value's
    // methods can only BE the string intrinsics.
    if (dynReceiver === undefined) {
      const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
      // `require.main?.filename.startsWith(...)`: the checker types the
      // receiver `string | undefined` (the chain's short-circuit arm), but
      // the entry-module fold lowers it to a compile-time STRING — the
      // suite harness's skip() shape. Everything else keeps the strict
      // string gate.
      if (receiverIr?.kind !== "string" && !isRequireMainFilename(L, access.expression)) return null;
      if (!L.isStdlibMember(access)) return null;
    }
    // The lib declares optional parameters beyond the lowered forms
    // (includes/startsWith/endsWith take a position); fence the unlowered
    // arities instead of passing arguments the runtime doesn't take.
    if (call.arguments.length < entry.minArgs || call.arguments.length > entry.maxArgs) {
      L.noLowering(
        `.${access.name.text} with ${call.arguments.length} argument${call.arguments.length === 1 ? "" : "s"} on strings`,
        call,
      );
    }
    const receiver = dynReceiver ? dynReceiver() : L.lowerExpr(access.expression);
    const args = entry.method === "split"
      ? [L.lowerExpr(call.arguments[0]!), lowerSplitLimitArg(L, call.arguments[1], locOf(call))]
      : call.arguments.map((a) => L.lowerExpr(a));
    // split's separator must BE a string here (a regex argument was
    // claimed by lowerRegexMethodCall before this path) — the lib's
    // `string | RegExp` union has no lowering as a VALUE.
    if (entry.method === "split" && args[0]!.type.kind !== "string") {
      L.unsupported(
        "SC1090",
        call.arguments[0]!,
        `'.split()' on a '${L.fmt(args[0]!.type)}' separator (pass a string, or a regex literal)`,
      );
    }
    // padStart/padEnd with the fill omitted: Node pads with " " — the
    // same call with the default made explicit.
    if ((entry.method === "padStart" || entry.method === "padEnd") && args.length === 1) {
      args.push({ kind: "strLit", value: " ", type: STRING, loc: locOf(call) });
    }
    return {
      kind: "strIntrinsic",
      method: entry.method,
      receiver,
      args,
      type: entry.result,
      loc: locOf(call),
    };
  }

/** `a.localeCompare(b)` — the one-argument form only (locales/options
   * select ICU collations that do not exist here). Lowers to an interned
   * synthetic function returning -1/0/1 by CODE-UNIT order — the same
   * ordering as the string relational operators — NOT Node's ICU default
   * collation: a documented divergence (SEMANTICS.md; e.g. Node says
   * "a" < "B" under ICU while code units say "B" < "a"). For same-case
   * ASCII the orders agree. Null when the receiver isn't a stdlib string
   * (caller keeps its generic rejection). */
  function lowerLocaleCompareCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverIr?.kind !== "string") return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    if (call.arguments.length !== 1) {
      L.noLowering(
        `.localeCompare with ${call.arguments.length} arguments`,
        call,
        "the locales/options parameters select ICU collations that have no lowering — " +
          "pass exactly the comparison string",
      );
    }
    const receiver = L.lowerExpr(access.expression);
    const arg = L.lowerExpr(call.arguments[0]!);
    if (arg.type.kind !== "string") L.badType(call.arguments[0]!, L.typeOf(call.arguments[0]!));
    const key = "localeCompare";
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%str.localeCompare`;
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push(buildLocaleCompareFn(helper, loc));
    }
    return { kind: "call", callee: helper, args: [receiver, arg], type: F64, loc };
  }

/** `return a < b ? -1 : a > b ? 1 : 0` over the strCmp primitive (the
   * relational operators' exact machinery — one interned helper, no new IR
   * or runtime surface). */
  function buildLocaleCompareFn(name: string, loc: SrcLoc): IrFunction {
    const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const cmp = (op: "<" | ">"): IrExpr => ({ kind: "strCmp", op, left: ref("a.0"), right: ref("b.0"), type: BOOL, loc });
    const body: IrStmt[] = [
      {
        kind: "return",
        value: {
          kind: "ternary",
          cond: cmp("<"),
          then: num(-1),
          else_: { kind: "ternary", cond: cmp(">"), then: num(1), else_: num(0), type: F64, loc },
          type: F64,
          loc,
        },
        loc,
      },
    ];
    return {
      name,
      params: [
        { localId: "a.0", name: "a", type: STRING },
        { localId: "b.0", name: "b", type: STRING },
      ],
      returnType: F64,
      locals: [
        { id: "a.0", name: "a", type: STRING, mutable: true },
        { id: "b.0", name: "b", type: STRING, mutable: true },
      ],
      body,
      loc,
    };
  }

/* ── typed arrays / Buffer ─────────────────────────────────────────────── */

/** The typed-array constructors with a runtime representation, by lib
 * interface name. The other TypedArray flavors (Int8Array, Float64Array,
 * DataView, ...) fall through to the generic stdlib-constructor fence. */
const BYTES_CTORS: Record<string, IrBytesElem | undefined> = {
  Uint8Array: "u8",
  Uint32Array: "u32",
  Int32Array: "i32",
  Float32Array: "f32",
};

/** `new Uint8Array(...)` / `new Uint32Array(...)` / `new Float32Array(...)`
   * (stdlib provenance — a user's own class with the name resolves through
   * classBySymbol). Lowered argument shapes: none (empty), a length
   * (zero-filled; ToIndex at runtime — invalid lengths throw Node's
   * RangeError), a same-kind typed array or Buffer (an independent COPY —
   * the readFile chain's `new Uint8Array(await readFile(p))`), a number[]
   * literal (element-coerced; its contextual type is the lib's
   * ArrayLike/Iterable union, which cannot map — the Set-seed pattern), or
   * a number[]-typed value. ArrayBuffer/view forms are fenced: scriptc
   * typed arrays own their storage. Null when this isn't a stdlib
   * typed-array construction. */
  export function lowerBytesNew(L: Lowerer, expr: ts.NewExpression, symbol: ts.Symbol | null | undefined): IrExpr | null {
    if (symbol && symbol.name === "DataView" && L.isStdlibSymbol(symbol)) {
      return lowerDataViewNew(L, expr);
    }
    const elem = symbol ? own(BYTES_CTORS, symbol.name) : undefined;
    if (!elem || !symbol || !L.isStdlibSymbol(symbol)) return null;
    const name = symbol.name;
    const type = bytesOf(elem);
    const loc = locOf(expr);
    const args = expr.arguments ?? [];
    if (args.length === 0) return { kind: "bytesNew", source: null, type, loc };
    if (args.length === 1 && !ts.isSpreadElement(args[0]!)) {
      const argNode = args[0]!;
      if (ts.isArrayLiteralExpression(argNode) && !argNode.elements.some(ts.isSpreadElement)) {
        const elems = argNode.elements.map((el) => L.lowerExprExpecting(el, F64));
        const seed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(F64), loc };
        return { kind: "bytesNew", source: seed, type, loc };
      }
      // The SYNTACTIC `new T(new ArrayBuffer(n))` and `new T(new
      // SharedArrayBuffer(n))` forms — fresh-buffer construction (the
      // shared spelling is the Atomics.wait sleep idiom's). The buffer
      // never exists as a value: n must be a byte-length LITERAL divisible
      // by the element size (tsc would admit any number; a bad one is
      // Node's RangeError — rejected at compile time instead of
      // half-lowering), and the whole expression is a zero-filled typed
      // array of n/elemSize elements. Erasing the buffer is exact: nothing
      // else can ever reference it, so neither sharing (scriptc has no
      // threads) nor aliasing is observable — SEMANTICS.md documents the
      // stance. The RESIZABLE form (a maxByteLength options bag) fences by
      // name: resize needs the buffer to exist as a value, and none does.
      if (
        ts.isNewExpression(argNode) &&
        ts.isIdentifier(argNode.expression) &&
        (argNode.expression.text === "ArrayBuffer" ||
          argNode.expression.text === "SharedArrayBuffer") &&
        L.isStdlibSymbol(L.resolveValueSymbol(argNode.expression) ?? undefined)
      ) {
        const bufCtor = argNode.expression.text;
        if ((argNode.arguments?.length ?? 0) > 1) {
          L.noLowering(
            `new ${name} over a resizable ${bufCtor}`,
            argNode,
            "a maxByteLength options bag makes the buffer resizable, and resizing needs the buffer " +
              "to exist as a runtime value — no free-standing ArrayBuffer value exists (the buffer here " +
              "erases into the view): drop the options bag",
          );
        }
        const elemSize = elem === "u8" ? 1 : 4;
        const lenArg = argNode.arguments?.length === 1 ? argNode.arguments[0] : undefined;
        const lenT = lenArg ? L.typeOf(lenArg) : null;
        const byteLen = lenT?.isNumberLiteralType() ? lenT.value : null;
        if (byteLen === null || byteLen % elemSize !== 0 || byteLen < 0) {
          L.noLowering(
            `new ${name} over this ${bufCtor}`,
            argNode,
            `the byte length must be a number literal divisible by ${elemSize} — new ${name}(new ${bufCtor}(${elemSize}))`,
          );
        }
        const count: IrExpr = { kind: "numLit", value: byteLen / elemSize, type: F64, loc };
        return { kind: "bytesNew", source: count, type, loc };
      }
      const src = L.lowerExpr(argNode);
      if (
        src.type.kind === "f64" ||
        typeEquals(src.type, type) ||
        (src.type.kind === "array" && src.type.elem.kind === "f64")
      ) {
        return { kind: "bytesNew", source: src, type, loc };
      }
      if (src.type.kind === "bytes") {
        L.noLowering(
          `new ${name} over a '${L.fmt(src.type)}'`,
          argNode,
          "cross-kind typed-array conversion has no lowering — copy element by element",
        );
      }
      L.noLowering(
        `new ${name} over '${L.fmt(src.type)}' values`,
        argNode,
        `supported: new ${name}(), (length), (typedArray) — always a copy — or (number[]); ` +
          "ArrayBuffers and views do not exist here (narrow unions first)",
      );
    }
    L.noLowering(
      `new ${name} with ${args.length} arguments`,
      expr,
      `supported: new ${name}(), (length), (typedArray), or (number[])`,
    );
  }

/** `new DataView(x.buffer, byteOffset?, byteLength?)` (stdlib provenance).
   * The first argument must be the SYNTACTIC `.buffer` of a typed-array/
   * Buffer value — `x.buffer` names x's own storage (scriptc typed arrays
   * always own it whole, byteOffset 0), so the view construction takes x
   * itself as the receiver and no ArrayBuffer value ever exists.
   * byteOffset/byteLength are optional f64s (omitted args OMITTED, like
   * slice); bad indices THROW Node's RangeErrors catchably. The result is
   * a true borrowed view: reads and writes through it alias x. */
  function lowerDataViewNew(L: Lowerer, expr: ts.NewExpression): IrExpr {
    const loc = locOf(expr);
    const args = expr.arguments ?? [];
    const bufNode = args[0];
    if (!bufNode || args.length > 3 || args.some(ts.isSpreadElement)) {
      L.noLowering(
        `new DataView with ${args.length} arguments`,
        expr,
        "supported: new DataView(x.buffer), (x.buffer, byteOffset), or (x.buffer, byteOffset, byteLength)",
      );
    }
    // The FRESH-BUFFER form: `new DataView(new ArrayBuffer(n), ...)` — the
    // buffer erases into the view (nothing else can ever reference it, so
    // the aliasing a shared buffer would exhibit is unobservable): the
    // view's storage is a fresh zero-filled n-byte allocation. n must be a
    // non-negative integer LITERAL (tsc admits any number; a fractional
    // one is ToIndex truncation nothing here implements). byteOffset and
    // byteLength keep their runtime Node-RangeError story. The RESIZABLE
    // form (a maxByteLength options bag) fences by name.
    if (
      ts.isNewExpression(bufNode) &&
      ts.isIdentifier(bufNode.expression) &&
      bufNode.expression.text === "ArrayBuffer" &&
      L.isStdlibSymbol(L.resolveValueSymbol(bufNode.expression) ?? undefined)
    ) {
      if ((bufNode.arguments?.length ?? 0) > 1) {
        L.noLowering(
          "new DataView over a resizable ArrayBuffer",
          bufNode,
          "a maxByteLength options bag makes the buffer resizable, and resizing needs the buffer " +
            "to exist as a runtime value — no free-standing ArrayBuffer value exists (the buffer here " +
            "erases into the view): drop the options bag",
        );
      }
      const lenArg = bufNode.arguments?.length === 1 ? bufNode.arguments[0] : undefined;
      const lenT = lenArg ? L.typeOf(lenArg) : null;
      const byteLen = lenT?.isNumberLiteralType() ? lenT.value : null;
      if (byteLen === null || !Number.isInteger(byteLen) || byteLen < 0) {
        L.noLowering(
          "new DataView over this ArrayBuffer",
          bufNode,
          "the byte length must be a non-negative integer literal — new DataView(new ArrayBuffer(8))",
        );
      }
      const count: IrExpr = { kind: "numLit", value: byteLen, type: F64, loc };
      const receiver: IrExpr = { kind: "bytesNew", source: count, type: BYTES_U8, loc };
      const idxArgs = args.slice(1).map((a) => L.lowerExprExpecting(a, F64));
      return { kind: "bytesIntrinsic", method: "dataViewNew", receiver, args: idxArgs, type: BYTES_U8, loc };
    }
    const hint =
      "views compile over a typed array's own storage — new DataView(x.buffer, byteOffset?, byteLength?) " +
      "where x is a Uint8Array/Uint32Array/Float32Array/Buffer value — or a fresh buffer erased into " +
      "the view: new DataView(new ArrayBuffer(n), ...); free-standing ArrayBuffers have no representation";
    if (!ts.isPropertyAccessExpression(bufNode) || bufNode.name.text !== "buffer" || bufNode.questionDotToken) {
      L.noLowering("new DataView over this buffer expression", bufNode, hint);
    }
    const srcIr = L.mapTypeOf(L.typeOf(bufNode.expression));
    if (srcIr?.kind !== "bytes" || !L.isStdlibMember(bufNode)) {
      L.noLowering(
        `new DataView over '.buffer' of a '${L.checker.typeToString(L.typeOf(bufNode.expression))}'`,
        bufNode,
        hint,
      );
    }
    const receiver = L.lowerExpr(bufNode.expression);
    const idxArgs = args.slice(1).map((a) => L.lowerExprExpecting(a, F64));
    return { kind: "bytesIntrinsic", method: "dataViewNew", receiver, args: idxArgs, type: BYTES_U8, loc };
  }

/** Method calls on typed-array/Buffer receivers: slice and subarray (BOTH
   * copy — subarray's sharing is the documented divergence), set(src,
   * offset?), and the u8-only Buffer surface: toString(enc?) plus the
   * whole numeric read/write family (fixed widths BE/LE and the
   * variable-width read/writeUIntLE quartet — BUF_NUM_METHODS). Everything
   * else the lib declares (fill, indexOf, reverse, ...) falls through to
   * the SC2020 member fence. Null when this isn't a bytes method call. */
  export function lowerBytesMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    const receiverIr = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverIr?.kind !== "bytes") return null;
    if (!L.isStdlibMember(access)) return null;
    const loc = locOf(call);
    const nArgs = call.arguments.length;
    if (receiverIr.elem === "u8" && name === "toSorted") {
      return lowerBytesToSortedCall(L, call, access, receiverIr);
    }
    if (receiverIr.elem === "u8" && name === "toReversed") {
      if (nArgs !== 0) {
        L.noLowering(`.toReversed with ${nArgs} arguments on Uint8Array`, call);
      }
      return {
        kind: "bytesIntrinsic",
        method: "toReversed",
        receiver: L.lowerExpr(access.expression),
        args: [],
        type: receiverIr,
        loc,
      };
    }
    if (receiverIr.elem === "u8" && name === "with") {
      if (nArgs !== 2 || call.arguments.some(ts.isSpreadElement)) {
        L.noLowering(`.with with ${nArgs} arguments on Uint8Array`, call);
      }
      return {
        kind: "bytesIntrinsic",
        method: "with",
        receiver: L.lowerExpr(access.expression),
        args: [
          L.lowerExprExpecting(call.arguments[0]!, F64),
          L.lowerExprExpecting(call.arguments[1]!, F64),
        ],
        type: receiverIr,
        loc,
      };
    }
    if (receiverIr.elem === "u8" && name === "join") {
      if (nArgs > 1 || call.arguments.some(ts.isSpreadElement)) {
        L.noLowering(`.join with ${nArgs} arguments on Uint8Array`, call);
      }
      const separatorDefault: IrExpr = {
        kind: "strLit",
        value: ",",
        type: STRING,
        loc,
      };
      const separator = call.arguments[0]
        ? lowerOptionalDefaultArg(
            L,
            call.arguments[0],
            STRING,
            separatorDefault,
          )
        : separatorDefault;
      return {
        kind: "bytesIntrinsic",
        method: "join",
        receiver: L.lowerExpr(access.expression),
        args: [separator],
        type: STRING,
        loc,
      };
    }
    if (name === "slice" || name === "subarray") {
      if (nArgs > 2) {
        L.noLowering(`.${name} with ${nArgs} arguments on typed arrays`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const args = call.arguments.map((a) => L.lowerExprExpecting(a, F64));
      // subarray is a VIEW (TypedArray.prototype.subarray aliases), and
      // Buffer's slice() is subarray's deprecated Node alias — resolved by
      // where the member is declared, the toString discipline below. Only
      // the plain typed arrays' slice() copies (JS-exact).
      const declaredOnBuffer =
        name === "slice" &&
        (() => {
          const nameSym = L.checker.getSymbolAtLocation(access.name);
          return nameSym !== undefined && L.checker.declarationsOf(nameSym).some(
            (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
          );
        })();
      const method = name === "subarray" || declaredOnBuffer ? "subarray" : "slice";
      return { kind: "bytesIntrinsic", method, receiver, args, type: receiverIr, loc };
    }
    if (name === "fill" && receiverIr.elem !== "u8") {
      // TypedArray.prototype.fill on the non-u8 kinds: per-element value
      // coercion, slice-clamped relative indices, never throws. u8
      // receivers keep the Buffer fill family (string patterns, throwing
      // offset validation) — lowerBufferInstanceMethod's surface.
      if (nArgs < 1 || nArgs > 3) {
        L.noLowering(`.fill with ${nArgs} arguments on typed arrays`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const v = L.lowerExprExpecting(call.arguments[0]!, F64);
      const idx = call.arguments.slice(1).map((a) => L.lowerExprExpecting(a, F64));
      return { kind: "bytesIntrinsic", method: "fillElem", receiver, args: [v, ...idx], type: receiverIr, loc };
    }
    if (name === "set") {
      if (nArgs < 1 || nArgs > 2) {
        L.noLowering(`.set with ${nArgs} arguments on typed arrays`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const src = L.lowerExpr(call.arguments[0]!);
      if (!typeEquals(src.type, receiverIr)) {
        L.noLowering(
          `.set from '${L.fmt(src.type)}' values`,
          call.arguments[0]!,
          "only a same-kind typed array copies in (number[] sources have no lowering — narrow unions first)",
        );
      }
      const args = [src];
      if (nArgs === 2) args.push(L.lowerExprExpecting(call.arguments[1]!, F64));
      return { kind: "bytesIntrinsic", method: "setFrom", receiver, args, type: VOID, loc };
    }
    if (name === "toString") {
      // Buffer's toString(encoding?) — utf8 by default. A 0-arg toString
      // resolved against the plain Uint8Array interface is JS's
      // Array-toString (comma join), a different operation: fenced.
      const declaredOnBuffer = (() => {
        const nameSym = L.checker.getSymbolAtLocation(access.name);
        return nameSym !== undefined && L.checker.declarationsOf(nameSym).some(
          (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
        );
      })();
      if (receiverIr.elem !== "u8" || !declaredOnBuffer) {
        L.noLowering(
          "typed-array toString",
          call,
          'Buffer.from(x).toString("utf8" | "hex" | "base64") is the lowered string conversion',
        );
      }
      if (nArgs > 3) L.noLowering(`.toString with ${nArgs} arguments on Buffers`, call);
      const receiver = L.lowerExpr(access.expression);
      const encNode = call.arguments[0];
      let method: IrBytesIntrinsicMethod = "toString";
      let enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
      if (encNode) {
        const encType = L.typeOf(encNode);
        const encName = encType.isStringLiteralType()
          ? knownBufEncoding(encType.value)
          : undefined;
        if (encName !== undefined) {
          // Keep literals on the canonical, non-throwing fast path.
          enc = { kind: "strLit", value: encName, type: STRING, loc };
        } else {
          const undefinedArg = lowerStaticallyUndefinedArg(L, encNode);
          if (undefinedArg) {
            // An explicit undefined is the omitted-encoding default. Keep
            // the canonical, non-throwing path while preserving effects
            // from equivalent spellings such as `void sideEffect()`.
            enc = defaultAfterUndefined(undefinedArg, enc);
          } else {
            // A BufferEncoding-typed variable selects its decoder at
            // runtime. Optional variables default their undefined arm to
            // utf8; the checked intrinsic canonicalizes every present
            // alias/case and raises Node's ERR_UNKNOWN_ENCODING when a cast
            // lets a bad value through.
            enc = lowerOptionalDefaultArg(L, encNode, STRING, enc);
            method = "toStringVar";
          }
        }
      }
      // The range form toString(enc, start[, end]) decodes the clamped
      // [start, end) byte window (Node's slice-then-decode). An omitted
      // end stays omitted (2 intrinsic args) — the emitter supplies the
      // receiver's length, because EXPLICIT negative ends clamp to empty
      // in Node and no in-band sentinel can represent "omitted" safely.
      if (nArgs > 1) {
        const start = L.lowerExprExpecting(call.arguments[1]!, F64);
        if (nArgs === 3) {
          const end = L.lowerExprExpecting(call.arguments[2]!, F64);
          return { kind: "bytesIntrinsic", method, receiver, args: [enc, start, end], type: STRING, loc };
        }
        return { kind: "bytesIntrinsic", method, receiver, args: [enc, start], type: STRING, loc };
      }
      return { kind: "bytesIntrinsic", method, receiver, args: [enc], type: STRING, loc };
    }
    // The Buffer-declared comparison/search/mutation surface. All of
    // these resolve against the Buffer interface (the checker keeps most
    // off plain typed arrays; where the lib DOES declare a same-named
    // TypedArray member — indexOf, includes, fill — the semantics differ,
    // so only Buffer-declared resolutions lower and u8 receivers gate the
    // rest).
    const declOnBuffer = (() => {
      const nameSym = L.checker.getSymbolAtLocation(access.name);
      return nameSym !== undefined && L.checker.declarationsOf(nameSym).some(
        (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
      );
    })();
    if (declOnBuffer && receiverIr.elem === "u8") {
      const bufMethod = lowerBufferInstanceMethod(L, call, access, name, loc);
      if (bufMethod) return bufMethod;
    }
    // The Buffer numeric read/write families — every fixed-width kind in
    // both endiannesses ("Uint" and "UInt" alike: Node aliases both), plus
    // the variable-width read/writeUIntLE quartet. The kind token rides as
    // a strLit args[0]; omitted offsets complete to Node's default 0.
    const numKind = own(BUF_NUM_METHODS, name);
    if (numKind !== undefined) {
      if (receiverIr.elem !== "u8") {
        L.noLowering(`.${name} on a '${L.fmt(receiverIr)}'`, call, "the numeric families read/write Buffer bytes");
      }
      const write = name.startsWith("write");
      const required = write ? 1 : 0; // value; offset defaults to 0
      if (nArgs < required || nArgs > required + 1) {
        L.noLowering(`.${name} with ${nArgs} arguments`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const kind: IrExpr = { kind: "strLit", value: numKind, type: STRING, loc };
      const args = [kind, ...call.arguments.map((a) => L.lowerExprExpecting(a, F64))];
      if (nArgs === required) {
        args.push({ kind: "numLit", value: 0, type: F64, loc }); // Node's offset default
      }
      return { kind: "bytesIntrinsic", method: write ? "writeNum" : "readNum", receiver, args, type: F64, loc };
    }
    const varKind = own(BUF_NUM_VAR_METHODS, name);
    if (varKind !== undefined) {
      if (receiverIr.elem !== "u8") {
        L.noLowering(`.${name} on a '${L.fmt(receiverIr)}'`, call, "the numeric families read/write Buffer bytes");
      }
      const write = name.startsWith("write");
      const required = write ? 3 : 2; // Node declares offset AND byteLength required
      if (nArgs !== required) {
        L.noLowering(`.${name} with ${nArgs} arguments`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const kind: IrExpr = { kind: "strLit", value: varKind, type: STRING, loc };
      const args = [kind, ...call.arguments.map((a) => L.lowerExprExpecting(a, F64))];
      return { kind: "bytesIntrinsic", method: write ? "writeNumVar" : "readNumVar", receiver, args, type: F64, loc };
    }
    // DataView getters (DataView maps to bytes<u8>, so the receiver kind
    // and stdlib provenance land here; the checker keeps these names off
    // typed arrays and Buffers). The multi-byte kinds take the optional
    // littleEndian bool (omitted = big-endian, the JS default). All THROW
    // Node's RangeError on a bad offset (may-throw seeds).
    const dvGetter = own(DV_GETTERS, name);
    if (dvGetter !== undefined && receiverIr.elem === "u8") {
      if (dvGetter.method === "dvGetBigUint64Number" || dvGetter.method === "dvGetBigInt64Number") {
        // bigint values have no representation — only the COMPOSED
        // `Number(view.getBigUint64/getBigInt64(...))` compiles (the
        // randomBytesToString pattern): the 8-byte integer converts to
        // double exactly as Number(bigint) would, and the bigint never
        // exists as a value (the f64-typed intrinsic result IS what the
        // identity Number(f64) lowering hands back).
        const p = call.parent;
        const composed =
          ts.isCallExpression(p) &&
          p.arguments.length === 1 &&
          p.arguments[0] === call &&
          ts.isIdentifier(p.expression) &&
          p.expression.text === "Number" &&
          L.isStdlibSymbol(L.resolveValueSymbol(p.expression) ?? undefined);
        if (!composed) {
          L.noLowering(
            `.${name} outside Number(...)`,
            call,
            `bigint values have no representation — Number(view.${name}(offset, littleEndian?)) is the lowered form`,
          );
        }
      }
      const maxArgs = dvGetter.le ? 2 : 1;
      if (nArgs < 1 || nArgs > maxArgs) {
        L.noLowering(`.${name} with ${nArgs} arguments`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const args = [L.lowerExprExpecting(call.arguments[0]!, F64)];
      if (nArgs === 2) args.push(L.lowerExprExpecting(call.arguments[1]!, BOOL));
      return { kind: "bytesIntrinsic", method: dvGetter.method, receiver, args, type: F64, loc };
    }
    // DataView setters — the getters' mirror: (byteOffset, value) plus the
    // optional littleEndian bool on the multi-byte kinds. Void results;
    // the same constant Node RangeError on a bad offset (may-throw seeds).
    // setBigUint64/setBigInt64 never lower (bigint ARGUMENTS have no
    // representation and no composed form exists) — they keep the member
    // fence, as does setFloat16.
    const dvSetter = own(DV_SETTERS, name);
    if (dvSetter !== undefined && receiverIr.elem === "u8") {
      const maxArgs = dvSetter.le ? 3 : 2;
      if (nArgs < 2 || nArgs > maxArgs) {
        L.noLowering(`.${name} with ${nArgs} arguments`, call);
      }
      const receiver = L.lowerExpr(access.expression);
      const args = [
        L.lowerExprExpecting(call.arguments[0]!, F64),
        L.lowerExprExpecting(call.arguments[1]!, F64),
      ];
      if (nArgs === 3) args.push(L.lowerExprExpecting(call.arguments[2]!, BOOL));
      return { kind: "bytesIntrinsic", method: dvSetter.method, receiver, args, type: VOID, loc };
    }
    return null;
  }

/** Node's Buffer encoding names → the runtime's canonical spelling (every
 * alias folds at compile time; the runtime sees only canonical names).
 * Shared by toString, Buffer.from, and Buffer.byteLength. */
const BUF_ENCODINGS: Record<string, string | undefined> = {
  utf8: "utf8",
  "utf-8": "utf8",
  hex: "hex",
  base64: "base64",
  base64url: "base64url",
  latin1: "latin1",
  binary: "latin1",
  ascii: "ascii",
  utf16le: "utf16le",
  "utf-16le": "utf16le",
  ucs2: "utf16le",
  "ucs-2": "utf16le",
};

/** A literal encoding's canonical name, or undefined for a spelling Node
 * does not know — the ladder callers (stream options) turn unknown
 * literals into Node's runtime ERR_UNKNOWN_ENCODING throw. */
export function knownBufEncoding(name: string): string | undefined {
  return own(BUF_ENCODINGS, name);
}

/** The literal encoding argument of a Buffer surface, normalized — or a
 * fence when it isn't a literal alias Node knows. */
export function bufEncoding(L: Lowerer, what: string, encNode: ts.Expression): string {
  const t = L.typeOf(encNode);
  const v = t.isStringLiteralType() ? own(BUF_ENCODINGS, t.value) : undefined;
  if (v === undefined) {
    L.noLowering(
      `${what} with this encoding`,
      encNode,
      'a literal "utf8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", or "ucs2" spelling is the lowered encoding surface',
    );
  }
  return v;
}

/** The fixed-width Buffer numeric methods by source name → the readNum/
 * writeNum kind token. Node declares BOTH capitalizations ("UInt" is the
 * original, "Uint" the aliased spelling) — the tables carry both. */
const BUF_NUM_METHODS: Record<string, string | undefined> = (() => {
  const out: Record<string, string> = {};
  for (const rw of ["read", "write"]) {
    for (const u of ["UInt", "Uint"]) {
      out[`${rw}${u}8`] = "u8";
      out[`${rw}${u}16BE`] = "u16be";
      out[`${rw}${u}16LE`] = "u16le";
      out[`${rw}${u}32BE`] = "u32be";
      out[`${rw}${u}32LE`] = "u32le";
    }
    out[`${rw}Int8`] = "i8";
    out[`${rw}Int16BE`] = "i16be";
    out[`${rw}Int16LE`] = "i16le";
    out[`${rw}Int32BE`] = "i32be";
    out[`${rw}Int32LE`] = "i32le";
    out[`${rw}FloatBE`] = "f32be";
    out[`${rw}FloatLE`] = "f32le";
    out[`${rw}DoubleBE`] = "f64be";
    out[`${rw}DoubleLE`] = "f64le";
  }
  return out;
})();

/** The variable-width quartet (offset + byteLength) → sign/endian token. */
const BUF_NUM_VAR_METHODS: Record<string, string | undefined> = {
  readUIntBE: "ube",
  readUintBE: "ube",
  readUIntLE: "ule",
  readUintLE: "ule",
  readIntBE: "ibe",
  readIntLE: "ile",
  writeUIntBE: "ube",
  writeUintBE: "ube",
  writeUIntLE: "ule",
  writeUintLE: "ule",
  writeIntBE: "ibe",
  writeIntLE: "ile",
};

/** The Buffer-declared comparison/search/mutation methods on a u8
 * receiver: equals, compare, indexOf/lastIndexOf/includes (number,
 * string-with-encoding, and Buffer needles), fill, copy, swap16/32/64,
 * and write. Null when `name` isn't one of them (the numeric families
 * and the generic bytes surface try next). Encodings must be literals
 * (bufEncoding's fence); a trailing string-typed argument is the
 * encoding, exactly Node's overloads. */
function lowerBufferInstanceMethod(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression, name: string, loc: SrcLoc): IrExpr | null {
  const args = call.arguments;
  const nArgs = args.length;
  if (args.some(ts.isSpreadElement)) return null;
  const isStringArg = (i: number): boolean => L.mapTypeOf(L.typeOf(args[i]!))?.kind === "string";
  const u8Arg = (i: number): IrExpr => {
    const v = L.lowerExpr(args[i]!);
    if (!(v.type.kind === "bytes" && v.type.elem === "u8")) {
      L.noLowering(
        `.${name} of '${L.fmt(v.type)}' values`,
        args[i]!,
        "a Buffer/Uint8Array argument is the lowered shape (narrow unions first)",
      );
    }
    return v;
  };

  // The checked-dynamic crossing for a compare/equals argument slot: dyn
  // passes through, convertible statics (the invalid-input probes'
  // literals) wrap in dynFrom, `undefined` literals ride the same wrap.
  // Fences (never returns) when the value cannot cross — an island jsval.
  const chkArg = (i: number): IrExpr => {
    // Object literals take the dyn literal path directly (method members
    // box as dyn functions — the typed record fence never applies).
    if (ts.isObjectLiteralExpression(args[i]!)) {
      return lowerDynObjectLiteral(L, args[i] as ts.ObjectLiteralExpression);
    }
    const v = L.lowerExpr(args[i]!);
    if (v.type.kind === "dyn") return v;
    if (v.kind === "unitLit" || L.dynConvertible(v.type)) {
      return { kind: "dynFrom", value: v, type: DYN, loc: v.loc };
    }
    L.noLowering(
      `.${name} of '${L.fmt(v.type)}' values`,
      args[i]!,
      "a Buffer/Uint8Array argument is the lowered shape (narrow unions first)",
    );
  };
  const argIrKind = (i: number): IrType | null => L.mapTypeOf(L.typeOf(args[i]!));

  if (name === "equals") {
    if (nArgs !== 1) L.noLowering(`.equals with ${nArgs} arguments`, call);
    if (argIrKind(0)?.kind === "bytes") {
      const other = u8Arg(0);
      const receiver = L.lowerExpr(access.expression);
      return { kind: "bytesIntrinsic", method: "equals", receiver, args: [other], type: BOOL, loc };
    }
    // Not statically bytes (the invalid-input probes, untyped JS
    // helpers): Node's "otherBuffer" argument ladder runs at runtime.
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "bytes.equalsChk", args: [receiver, chkArg(0)], type: BOOL, loc };
  }
  if (name === "compare") {
    if (nArgs > 5) L.noLowering(`.compare with ${nArgs} arguments`, call);
    const fast =
      nArgs >= 1 &&
      argIrKind(0)?.kind === "bytes" &&
      call.arguments.slice(1).every((a) => L.mapTypeOf(L.typeOf(a))?.kind === "f64");
    if (fast) {
      const target = u8Arg(0);
      const idx = call.arguments.slice(1).map((a) => L.lowerExprExpecting(a, F64));
      const receiver = L.lowerExpr(access.expression);
      return { kind: "bytesIntrinsic", method: "compareBuf", receiver, args: [target, ...idx], type: F64, loc };
    }
    // An absent/ill-typed target or offset (`a.compare()`, string
    // offsets, explicit undefined): Node's target/targetStart/targetEnd/
    // sourceStart/sourceEnd ladder runs at runtime; absent slots pass
    // the undefined dyn (Node defaults apply there).
    const receiver = L.lowerExpr(access.expression);
    const slots: IrExpr[] = [];
    for (let i = 0; i < 5; i++) slots.push(i < nArgs ? chkArg(i) : dynUndefinedExpr(loc));
    return { kind: "libCall", fn: "bytes.compareChk", args: [receiver, ...slots], type: F64, loc };
  }
  if (name === "indexOf" || name === "lastIndexOf" || name === "includes") {
    if (nArgs < 1 || nArgs > 3) L.noLowering(`.${name} with ${nArgs} arguments`, call);
    // The overloads: (v), (v, byteOffset), (v, encoding), (v, byteOffset,
    // encoding) — a trailing string-typed arg is the encoding.
    let encName = "utf8";
    let offNode: ts.Expression | undefined;
    if (nArgs === 3) {
      offNode = args[1]!;
      encName = bufEncoding(L, `.${name}`, args[2]!);
    } else if (nArgs === 2) {
      if (isStringArg(1)) encName = bufEncoding(L, `.${name}`, args[1]!);
      else offNode = args[1]!;
    }
    const resultT = name === "includes" ? BOOL : F64;
    const vT = L.mapTypeOf(L.typeOf(args[0]!));
    const receiver = L.lowerExpr(access.expression);
    if (vT?.kind === "f64") {
      // A number needle wraps & 0xFF at runtime (Buffer semantics; the
      // encoding is irrelevant, like Node).
      const v = L.lowerExprExpecting(args[0]!, F64);
      const numArgs = [v, ...(offNode ? [L.lowerExprExpecting(offNode, F64)] : [])];
      const method = name === "indexOf" ? "indexOfNum" : name === "lastIndexOf" ? "lastIndexOfNum" : "includesNum";
      return { kind: "bytesIntrinsic", method, receiver, args: numArgs, type: resultT, loc };
    }
    let needle: IrExpr;
    let align = 1;
    if (vT?.kind === "string") {
      const s = L.lowerExprExpecting(args[0]!, STRING);
      const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
      needle = { kind: "libCall", fn: "buffer.fromStr", args: [s, enc], type: BYTES_U8, loc };
      if (encName === "utf16le") align = 2;
    } else if (vT?.kind === "bytes" && vT.elem === "u8") {
      needle = L.lowerExpr(args[0]!);
    } else {
      L.noLowering(
        `.${name} of '${L.checker.typeToString(L.typeOf(args[0]!))}' values`,
        args[0]!,
        "string, number, and Buffer/Uint8Array needles search (narrow unions first)",
      );
    }
    const alignLit: IrExpr = { kind: "numLit", value: align, type: F64, loc };
    const searchArgs = [needle, alignLit, ...(offNode ? [L.lowerExprExpecting(offNode, F64)] : [])];
    return { kind: "bytesIntrinsic", method: name, receiver, args: searchArgs, type: resultT, loc };
  }
  if (name === "fill") {
    if (nArgs < 1 || nArgs > 4) L.noLowering(`.fill with ${nArgs} arguments`, call);
    // A trailing string-typed arg past the value is the encoding.
    let encNode: ts.Expression | undefined;
    let idxNodes = call.arguments.slice(1);
    if (idxNodes.length > 0 && isStringArg(nArgs - 1)) {
      encNode = idxNodes[idxNodes.length - 1];
      idxNodes = idxNodes.slice(0, -1);
    }
    if (idxNodes.length > 2) L.noLowering(`.fill with ${nArgs} arguments`, call);
    const idx = idxNodes.map((a) => L.lowerExprExpecting(a, F64));
    const receiverT = L.mapTypeOf(L.typeOf(access.expression));
    if (receiverT?.kind !== "bytes") L.badType(access.expression, L.typeOf(access.expression));
    const vT = L.mapTypeOf(L.typeOf(args[0]!));
    const receiver = L.lowerExpr(access.expression);
    if (vT?.kind === "string") {
      const encName = encNode ? bufEncoding(L, ".fill", encNode) : "utf8";
      const s = L.lowerExprExpecting(args[0]!, STRING);
      const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
      return { kind: "bytesIntrinsic", method: "fillStr", receiver, args: [s, enc, ...idx], type: BYTES_U8, loc };
    }
    if (encNode) L.noLowering(".fill with an encoding on a non-string value", encNode);
    if (vT?.kind === "f64") {
      const v = L.lowerExprExpecting(args[0]!, F64);
      return { kind: "bytesIntrinsic", method: "fillNum", receiver, args: [v, ...idx], type: BYTES_U8, loc };
    }
    const pattern = u8Arg(0);
    return { kind: "bytesIntrinsic", method: "fill", receiver, args: [pattern, ...idx], type: BYTES_U8, loc };
  }
  if (name === "copy") {
    if (nArgs < 1 || nArgs > 4) L.noLowering(`.copy with ${nArgs} arguments`, call);
    const target = u8Arg(0);
    const idx = call.arguments.slice(1).map((a) => L.lowerExprExpecting(a, F64));
    const receiver = L.lowerExpr(access.expression);
    return { kind: "bytesIntrinsic", method: "copy", receiver, args: [target, ...idx], type: F64, loc };
  }
  if (name === "swap16" || name === "swap32" || name === "swap64") {
    if (nArgs !== 0) L.noLowering(`.${name} with ${nArgs} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "bytesIntrinsic", method: name, receiver, args: [], type: BYTES_U8, loc };
  }
  if (name === "write") {
    if (nArgs < 1 || nArgs > 4) L.noLowering(`.write with ${nArgs} arguments`, call);
    // (str), (str, enc), (str, offset), (str, offset, enc),
    // (str, offset, length), (str, offset, length, enc).
    let encNode: ts.Expression | undefined;
    let idxNodes = call.arguments.slice(1);
    if (idxNodes.length > 0 && isStringArg(nArgs - 1)) {
      encNode = idxNodes[idxNodes.length - 1];
      idxNodes = idxNodes.slice(0, -1);
    }
    if (idxNodes.length > 2) L.noLowering(`.write with ${nArgs} arguments`, call);
    const encName = encNode ? bufEncoding(L, "Buffer.write", encNode) : "utf8";
    const s = L.lowerExprExpecting(args[0]!, STRING);
    const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
    const offset: IrExpr = idxNodes[0]
      ? L.lowerExprExpecting(idxNodes[0], F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    const writeArgs = [s, enc, offset, ...(idxNodes[1] ? [L.lowerExprExpecting(idxNodes[1], F64)] : [])];
    const receiver = L.lowerExpr(access.expression);
    return { kind: "bytesIntrinsic", method: "writeStr", receiver, args: writeArgs, type: F64, loc };
  }
  return null;
}

/** The DataView getter surface by source name. `le` marks the multi-byte
 * kinds whose lib signature declares the optional littleEndian parameter
 * (the 8-bit getters take none). The Big pair only compiles composed
 * inside Number(...) — see the use site. */
const DV_GETTERS: Record<string, { method: IrBytesIntrinsicMethod; le: boolean } | undefined> = {
  getUint8: { method: "dvGetUint8", le: false },
  getInt8: { method: "dvGetInt8", le: false },
  getUint16: { method: "dvGetUint16", le: true },
  getInt16: { method: "dvGetInt16", le: true },
  getUint32: { method: "dvGetUint32", le: true },
  getInt32: { method: "dvGetInt32", le: true },
  getFloat32: { method: "dvGetFloat32", le: true },
  getFloat64: { method: "dvGetFloat64", le: true },
  getBigUint64: { method: "dvGetBigUint64Number", le: true },
  getBigInt64: { method: "dvGetBigInt64Number", le: true },
};

const DV_SETTERS: Record<string, { method: IrBytesIntrinsicMethod; le: boolean } | undefined> = {
  setUint8: { method: "dvSetUint8", le: false },
  setInt8: { method: "dvSetInt8", le: false },
  setUint16: { method: "dvSetUint16", le: true },
  setInt16: { method: "dvSetInt16", le: true },
  setUint32: { method: "dvSetUint32", le: true },
  setInt32: { method: "dvSetInt32", le: true },
  setFloat32: { method: "dvSetFloat32", le: true },
  setFloat64: { method: "dvSetFloat64", le: true },
};

/** The Buffer statics — `Buffer.from(...)`, `Buffer.alloc(n)`,
   * `Buffer.concat(list)`, `Buffer.isBuffer(x)` — on THE stdlib Buffer
   * global (name + provenance; fallback and @types/node alike). Null when
   * the callee isn't a Buffer-static access. */
  export function lowerBufferStaticCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!L.isStdlibGlobal(access.expression, "Buffer")) return null;
    const member = access.name.text;
    const loc = locOf(call);
    const args = call.arguments;
    if (member === "from") {
      // Buffer.from(x.buffer[, byteOffset[, length]]): a u8 VIEW sharing
      // x's storage (Node shares the ArrayBuffer; length is in BYTES).
      // The first argument must be the SYNTACTIC `.buffer` of a typed
      // array — the DataView peel — and the construction rides the same
      // dataViewNew intrinsic (offset/length validation throws Node's
      // DataView-shaped RangeErrors; valid indices behave exactly).
      if (
        args.length >= 1 && args.length <= 3 && !args.some(ts.isSpreadElement) &&
        ts.isPropertyAccessExpression(args[0]!) && args[0].name.text === "buffer"
      ) {
        const srcNode = args[0].expression;
        const srcIr = L.mapTypeOf(L.typeOf(srcNode));
        if (srcIr?.kind === "bytes") {
          const receiver = L.lowerExpr(srcNode);
          const idxArgs = args.slice(1).map((a) => L.lowerExprExpecting(a, F64));
          return { kind: "bytesIntrinsic", method: "dataViewNew", receiver, args: idxArgs, type: BYTES_U8, loc };
        }
      }
      if (args.length >= 1 && args.length <= 2 && !ts.isSpreadElement(args[0]!)) {
        const argNode = args[0]!;
        if (ts.isArrayLiteralExpression(argNode) && !argNode.elements.some(ts.isSpreadElement)) {
          // A number[] literal (contextually typed by the lib's readonly
          // number[] slot — build it element-wise, the Set-seed pattern).
          if (args.length === 1) {
            const elems = argNode.elements.map((el) => L.lowerExprExpecting(el, F64));
            const seed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(F64), loc };
            return { kind: "bytesNew", source: seed, type: BYTES_U8, loc };
          }
        } else {
          const srcIr = L.mapTypeOf(L.typeOf(argNode));
          if (srcIr?.kind === "string") {
            const encNode = args[1];
            const encName = encNode ? bufEncoding(L, "Buffer.from", encNode) : "utf8";
            const s = L.lowerExprExpecting(argNode, STRING);
            const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
            return { kind: "libCall", fn: "buffer.fromStr", args: [s, enc], type: BYTES_U8, loc };
          }
          if (args.length === 1 && srcIr?.kind === "bytes" && srcIr.elem === "u8") {
            return { kind: "bytesNew", source: L.lowerExpr(argNode), type: BYTES_U8, loc };
          }
          if (args.length === 1 && srcIr?.kind === "array" && srcIr.elem.kind === "f64") {
            return { kind: "bytesNew", source: L.lowerExpr(argNode), type: BYTES_U8, loc };
          }
        }
      }
      L.noLowering(
        "Buffer.from with this argument shape",
        call,
        "supported: Buffer.from(string, encoding?) with a literal encoding, Buffer.from(u8Array) — a copy — " +
          "Buffer.from(number[]), or Buffer.from(x.buffer, byteOffset?, length?) — a view sharing x's " +
          "storage (no free-standing ArrayBuffer value exists; narrow unions first)",
      );
    }
    if (member === "alloc" || member === "allocUnsafe") {
      const maxArgs = member === "alloc" ? 3 : 1;
      if (args.length < 1 || args.length > maxArgs || args.some(ts.isSpreadElement)) {
        L.noLowering(`Buffer.${member} with ${args.length} arguments`, call);
      }
      // allocUnsafe's contents are UNSPECIFIED in Node (uninitialized pool
      // memory); a zero-filled buffer is a valid instance of unspecified,
      // and the deterministic choice — a program observing the difference
      // is depending on garbage.
      const size = L.lowerExprExpecting(args[0]!, F64);
      const fresh: IrExpr = { kind: "bytesNew", source: size, type: BYTES_U8, loc };
      if (args.length === 1) return fresh;
      // alloc(size, fill, encoding?): the fill semantics ARE fill()'s —
      // the fresh buffer is the receiver of a whole-range fill.
      const fillT = L.mapTypeOf(L.typeOf(args[1]!));
      if (fillT?.kind === "string") {
        const encName = args[2] ? bufEncoding(L, "Buffer.alloc", args[2]) : "utf8";
        const s = L.lowerExprExpecting(args[1]!, STRING);
        const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
        return { kind: "bytesIntrinsic", method: "fillStr", receiver: fresh, args: [s, enc], type: BYTES_U8, loc };
      }
      if (args.length > 2) {
        L.noLowering("Buffer.alloc with an encoding on a non-string fill", args[2]!);
      }
      if (fillT?.kind === "f64") {
        const v = L.lowerExprExpecting(args[1]!, F64);
        return { kind: "bytesIntrinsic", method: "fillNum", receiver: fresh, args: [v], type: BYTES_U8, loc };
      }
      if (fillT?.kind === "bytes" && fillT.elem === "u8") {
        const pattern = L.lowerExpr(args[1]!);
        return { kind: "bytesIntrinsic", method: "fill", receiver: fresh, args: [pattern], type: BYTES_U8, loc };
      }
      L.noLowering(
        `Buffer.alloc with a '${L.checker.typeToString(L.typeOf(args[1]!))}' fill`,
        args[1]!,
        "number, string, and Buffer/Uint8Array fills are the lowered shapes",
      );
    }
    if (member === "concat") {
      if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
        L.noLowering(`Buffer.concat with ${args.length} arguments`, call);
      }
      const argNode = args[0]!;
      let list: IrExpr;
      if (ts.isArrayLiteralExpression(argNode) && !argNode.elements.some(ts.isSpreadElement)) {
        const elems = argNode.elements.map((el) => L.lowerExprExpecting(el, BYTES_U8));
        list = { kind: "arrayLit", elems, type: arrayOf(BYTES_U8), loc };
      } else {
        list = L.lowerExpr(argNode);
        if (!typeEquals(list.type, arrayOf(BYTES_U8))) {
          L.noLowering(
            `Buffer.concat of '${L.fmt(list.type)}' values`,
            argNode,
            "one Uint8Array[]/Buffer[] value (or literal) is the lowered list shape",
          );
        }
      }
      if (args.length === 2) {
        // The totalLength form truncates or zero-pads (and THROWS Node's
        // 'length' RangeError on bad totals).
        const total = L.lowerExprExpecting(args[1]!, F64);
        return { kind: "libCall", fn: "buffer.concatLen", args: [list, total], type: BYTES_U8, loc };
      }
      return { kind: "libCall", fn: "buffer.concat", args: [list], type: BYTES_U8, loc };
    }
    if (member === "compare") {
      // The static form: Buffer.compare(a, b) IS a.compare(b).
      if (args.length !== 2 || args.some(ts.isSpreadElement)) {
        L.noLowering(`Buffer.compare with ${args.length} arguments`, call);
      }
      const sides = args.map((a) => L.lowerExpr(a));
      if (sides.every((v) => v.type.kind === "bytes" && v.type.elem === "u8")) {
        return { kind: "bytesIntrinsic", method: "compareBuf", receiver: sides[0]!, args: [sides[1]!], type: F64, loc };
      }
      // A side that is not statically bytes (the invalid-input probes,
      // untyped JS helpers): Node's "buf1"/"buf2" argument ladder runs
      // at runtime — a well-typed dyn still compares.
      const dyns = sides.map((v, i) => {
        if (v.type.kind === "dyn") return v;
        if (v.kind === "unitLit" || L.dynConvertible(v.type)) {
          return { kind: "dynFrom", value: v, type: DYN, loc: v.loc } as IrExpr;
        }
        L.noLowering(
          `Buffer.compare of '${L.fmt(v.type)}' values`,
          args[i]!,
          "Buffer/Uint8Array values compare (narrow unions first)",
        );
      });
      return { kind: "libCall", fn: "buffer.compareChk", args: dyns, type: F64, loc };
    }
    if (member === "isBuffer") {
      // The type-predicate narrowing test. Lowered where it DECIDES
      // something: a union-typed argument with a Buffer arm becomes a
      // runtime tag test (tsc's narrowing then types the branches, the
      // discriminated-union machinery). Statically-decided arguments are
      // fenced — the answer is a constant, and the operand's evaluation
      // would have to be discarded.
      if (args.length === 1 && !ts.isSpreadElement(args[0]!)) {
        const v = L.lowerExpr(args[0]!);
        if (v.type.kind === "union") {
          const def = L.unions.get(v.type.unionId);
          const tag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
          if (tag >= 0) {
            return { kind: "unionIsTag", unionId: v.type.unionId, tag, negated: false, value: v, type: BOOL, loc };
          }
        }
        L.noLowering(
          `Buffer.isBuffer of '${L.fmt(v.type)}' values`,
          args[0]!,
          "the check lowers as a runtime tag test on unions with a Buffer arm — here the answer is static",
        );
      }
      L.noLowering("Buffer.isBuffer with this argument shape", call);
    }
    if (member === "byteLength") {
      // Buffer.byteLength(string, enc?) — the UTF-16-aware per-encoding
      // count — or of a typed array/Buffer (its byte length, a property
      // read at heart).
      if (args.length >= 1 && args.length <= 2 && !ts.isSpreadElement(args[0]!)) {
        const srcIr = L.mapTypeOf(L.typeOf(args[0]!));
        if (srcIr?.kind === "string") {
          const encName = args[1] ? bufEncoding(L, "Buffer.byteLength", args[1]) : "utf8";
          const s = L.lowerExprExpecting(args[0]!, STRING);
          const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
          return { kind: "libCall", fn: "buffer.byteLenStr", args: [s, enc], type: F64, loc };
        }
        if (srcIr?.kind === "bytes" && args.length === 1) {
          const receiver = L.lowerExpr(args[0]!);
          return { kind: "bytesIntrinsic", method: "byteLength", receiver, args: [], type: F64, loc };
        }
      }
      L.noLowering(
        "Buffer.byteLength with this argument shape",
        call,
        "supported: Buffer.byteLength(string, literalEncoding?) or Buffer.byteLength(typedArray)",
      );
    }
    if (member === "isEncoding") {
      // The runtime alias-set test — a plain bool over any string value
      // (Node's case-insensitive normalizeEncoding check).
      if (args.length === 1 && !ts.isSpreadElement(args[0]!) && L.mapTypeOf(L.typeOf(args[0]!))?.kind === "string") {
        const s = L.lowerExprExpecting(args[0]!, STRING);
        return { kind: "libCall", fn: "buffer.isEncoding", args: [s], type: BOOL, loc };
      }
      L.noLowering(
        "Buffer.isEncoding with this argument shape",
        call,
        "one string-typed argument is the lowered form",
      );
    }
    return null; // of, copyBytesFrom, ... → the SC2020 member fence
  }

/** `Object.keys/values/entries` over an INDEX-SIGNATURE (overflow-carrying)
   * record shape: declared fields answer first from the compile-time field
   * list (declaration order, undefined-valued fields skipped — exactly the
   * fixed-shape lowering and SEMANTICS.md 37), then the overflow map's live
   * keys in JS OWN-KEY order (canonical array indices ascending, then
   * insertion order — recordOvfKeys). For a PURE index-signature shape
   * (Record<string, T> — no declared fields, the typical CLI config patterns) the
   * result order is Node-exact; hybrids inherit the documented
   * declared-then-overflow divergence. Values surface as the checker's
   * result element type: identity, an arm-into-union wrap, or (dyn
   * results) the dyn conversion — recordKeyGet's own surfacing rules for
   * the overflow, mirrored statically for declared fields. */
  export function lowerObjectIterOverIndexShape(L: Lowerer, call: ts.CallExpression,
    member: "keys" | "values" | "entries",
    argIr: IrType & { kind: "record" },
    shape: IrRecordShape,): IrExpr {
    const resultT = L.irTypeOf(call);
    if (resultT.kind !== "array") L.badType(call, L.typeOf(call)); // defensive
    return objectIterOverIndexShape(L, call, member, argIr, shape, L.lowerExpr(call.arguments[0]!), resultT, locOf(call));
  }

  /** The construction core, receiver/result pre-resolved — `node` anchors
   * the fences. for-in reuses the "keys" arm directly (it iterates exactly
   * the keys Object.keys answers; same intern key, one helper). */
  export function objectIterOverIndexShape(L: Lowerer, node: ts.Node,
    member: "keys" | "values" | "entries",
    argIr: IrType & { kind: "record" },
    shape: IrRecordShape,
    receiver: IrExpr,
    resultT: IrType & { kind: "array" },
    loc: SrcLoc,): IrExpr {
    const iv = shape.indexValue!;

    // The result-element type values flow into (string for keys, the
    // checker's element for values, the [string, V] tuple's "1" for
    // entries).
    let valueT: IrType | null = null;
    let tupleT: (IrType & { kind: "record" }) | null = null;
    if (member === "values") valueT = resultT.elem;
    if (member === "entries") {
      if (resultT.elem.kind !== "record") L.badType(node, L.typeOf(node as ts.Expression));
      tupleT = resultT.elem;
      const tupleShape = L.shapes.get(resultT.elem.shapeId);
      if (!tupleShape?.tuple || tupleShape.fields.length !== 2) L.badType(node, L.typeOf(node as ts.Expression));
      valueT = tupleShape.fields.find((f) => f.name === "1")!.type;
    }

    // JS lists integer-like OWN keys first regardless of where they live;
    // the declared-then-overflow order can only honor that when no
    // DECLARED field name is integer-like (the overflow walk handles its
    // own). Shapes that mix one in keep a fence, not a silent reorder.
    const arrayIndexRe = /^(0|[1-9][0-9]{0,9})$/;
    if (shape.fields.some((f) => arrayIndexRe.test(f.name) && Number(f.name) <= 4294967294)) {
      L.unsupported(
        "SC1090",
        node,
        `Object.${member} over '${L.fmt(argIr)}' (a declared field name is integer-like — JS orders integer keys first, across declared and overflow keys)`,
      );
    }
    // The overflow value must surface as the element type (identity, an
    // arm of a union element, or a dyn element over a dyn signature).
    if (valueT) {
      const ivSurfaces =
        typeEquals(iv, valueT) ||
        (valueT.kind === "union" && L.armTag(valueT.unionId, iv) >= 0) ||
        (valueT.kind === "dyn" && iv.kind === "dyn");
      if (!ivSurfaces) {
        L.unsupported(
          "SC1090",
          node,
          `Object.${member} over '${L.fmt(argIr)}' (the index signature's '${L.fmt(iv)}' value cannot flow into the '${L.fmt(valueT)}' result element)`,
        );
      }
    }

    const key = `obj.${member}:ovf:${argIr.shapeId}:${typeKey(resultT)}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.${member}.${L.arrHofHelpers.size}`;
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const outRef = ref("out.0", resultT);
      const rRef = ref("r.0", argIr);
      const push = (value: IrExpr): IrStmt => ({
        kind: "exprStmt",
        expr: { kind: "arrIntrinsic", method: "push", receiver: outRef, args: [value], type: F64, loc },
        loc,
      });
      const body: IrStmt[] = [
        { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: resultT, loc }, loc },
      ];
      const fieldStmts = new Map<string, IrStmt>();

      // Declared fields, in declaration order. Undefined-valued fields
      // skip at runtime (the unset-optional convention); values surface
      // into the element type or the site fences with the field named.
      const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
      for (const name of order) {
        const f = shape.fields.find((x) => x.name === name)!;
        const raw: IrExpr = { kind: "recordGet", obj: rRef, shapeId: argIr.shapeId, field: f.name, type: f.type, loc };
        const utag = f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
        // The pushed value per member; null when the field cannot surface.
        const surfaced = (): IrExpr | null => {
          if (!valueT) return null;
          if (typeEquals(f.type, valueT)) return raw;
          if (valueT.kind === "dyn") {
            return L.dynConvertible(f.type) ? { kind: "dynFrom", value: raw, type: DYN, loc } : null;
          }
          if (valueT.kind === "union") {
            const tag = L.armTag(valueT.unionId, f.type);
            if (tag >= 0) return { kind: "unionWrap", unionId: valueT.unionId, tag, value: raw, type: valueT, loc };
            // An undefined-armed field union whose ONE other arm is an
            // element arm: narrow (the undefined case is guard-skipped),
            // then wrap.
            if (utag >= 0 && f.type.kind === "union") {
              const others = (L.unions.get(f.type.unionId)?.arms ?? []).filter((a) => a.kind !== "undefinedT");
              if (others.length === 1) {
                const otherTag = L.armTag(valueT.unionId, others[0]!);
                const narrowTag = L.armTag(f.type.unionId, others[0]!);
                if (otherTag >= 0 && narrowTag >= 0) {
                  const other = others[0]!;
                  // A UNIT other arm pushes the unit LITERAL (undefined
                  // was filtered above, so the unit is null; units carry
                  // no payload and narrowing to a unit arm is malformed
                  // IR) — the fixed-shape helper's rule exactly.
                  const narrowed: IrExpr = isUnitType(other)
                    ? { kind: "unitLit", unit: "null", type: other, loc }
                    : { kind: "unionNarrow", unionId: f.type.unionId, tag: narrowTag, value: raw, type: other, loc };
                  return { kind: "unionWrap", unionId: valueT.unionId, tag: otherTag, value: narrowed, type: valueT, loc };
                }
              }
            }
          }
          return null;
        };
        let pushed: IrExpr;
        if (member === "keys") {
          pushed = { kind: "strLit", value: f.name, type: STRING, loc };
        } else {
          const s = surfaced();
          if (!s) {
            L.unsupported(
              "SC1090",
              node,
              `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' of type '${L.fmt(f.type)}' cannot flow into the '${L.fmt(valueT!)}' result element — read the fields directly)`,
            );
          }
          pushed =
            member === "values"
              ? s
              : {
                  kind: "recordLit",
                  fields: [
                    { name: "0", value: { kind: "strLit", value: f.name, type: STRING, loc } },
                    { name: "1", value: s },
                  ],
                  type: tupleT!,
                  loc,
                };
        }
        const fieldStmt: IrStmt =
          utag >= 0 && f.type.kind === "union"
            ? {
                kind: "if",
                cond: { kind: "unionIsTag", unionId: f.type.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc },
                then: [push(pushed)],
                else_: null,
                loc,
              }
            : push(pushed);
        fieldStmts.set(f.name, fieldStmt);
        body.push(fieldStmt);
      }

      // The overflow walk: a fresh key snapshot in JS own-key order, each
      // value read back through the overflow-only keyed read (declared
      // names never live in the overflow map).
      const ksT = arrayOf(STRING);
      const ksRef = ref("ks.0", ksT);
      const kRef = ref("k.0", STRING);
      const readValue: IrExpr | null = valueT
        ? { kind: "recordKeyGet", obj: rRef, shapeId: argIr.shapeId, key: kRef, overflowOnly: true, type: valueT, loc }
        : null;
      const loopPushed: IrExpr =
        member === "keys"
          ? kRef
          : member === "values"
            ? readValue!
            : {
                kind: "recordLit",
                fields: [
                  { name: "0", value: kRef },
                  { name: "1", value: readValue! },
                ],
                type: tupleT!,
                loc,
              };
      body.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: rRef, shapeId: argIr.shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: ref("i.0", F64),
            right: { kind: "arrIntrinsic", method: "length", receiver: ksRef, args: [], type: F64, loc },
            type: BOOL,
            loc,
          },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
            loc,
          },
          body: [
            { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: ksRef, index: ref("i.0", F64), type: STRING, loc }, loc },
            push(loopPushed),
          ],
          loc,
        },
        { kind: "return", value: outRef, loc },
      );
      const suffix = body.slice(1 + fieldStmts.size);
      L.arrHofHelpers.set(key, helper);
      const fn: IrFunction = {
        name: helper,
        params: [{ localId: "r.0", name: "r", type: argIr }],
        returnType: resultT,
        locals: [
          { id: "r.0", name: "r", type: argIr, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
          { id: "ks.0", name: "ks", type: ksT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "k.0", name: "k", type: STRING, mutable: false },
        ],
        body,
        loc,
      };
      L.shapeOrderHelperFinalizers.push(() => {
        const current = L.shapes.get(argIr.shapeId) ?? shape;
        const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
        fn.body = [body[0]!, ...currentOrder.flatMap((name) => {
          const stmt = fieldStmts.get(name);
          return stmt ? [stmt] : [];
        }), ...suffix];
      });
      L.liftedFns.push(fn);
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }

/** `Object.fromEntries(pairs)` over a `[string, V][]` VALUE into the
   * checker's own index-signature result shape (`{ [k: string]: V }` —
   * always declared-field-free from the lib signature): an interned helper
   * loops the pairs and keyed-writes each into a fresh record's overflow —
   * later duplicates overwrite in place (first insertion position wins for
   * ORDER, last value wins — exactly JS). Values flow into the signature's
   * value slot (dyn slots convert JSON-safe values, identity otherwise).
   * The `as ModelPricing` reshape AFTER it is the width-coercion capture
   * (lowerRecordOvfCaptureHelper). Null when the argument or result shape
   * is outside this (Maps, richer iterables → the SC2020 fence). */
  export function lowerObjectFromEntriesCall(L: Lowerer, call: ts.CallExpression,
    callee: ts.Expression,): IrExpr | null {
    if (!ts.isPropertyAccessExpression(callee)) return null;
    if (call.questionDotToken || callee.questionDotToken) return null;
    if (!L.isStdlibGlobal(callee.expression, "Object")) return null;
    if (callee.name.text !== "fromEntries") return null;
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return null;
    const argNode = call.arguments[0]!;
    const argIr = L.mapTypeOf(L.typeOf(argNode));
    if (argIr?.kind !== "array") return null;
    // `Object.fromEntries(rows)` over a `string[][]` VALUE — the env-line
    // idiom (`envArray.map((env) => env.split('='))`). The checker has no
    // tuple to type here (string[] misses the lib's [PropertyKey, T]
    // overload, so the Iterable<readonly any[]> one answers `any`), but
    // the honest static result IS typable: the index-signature record over
    // the row's read positions — key ToPropertyKey(row[0]) ("undefined"
    // when the row is empty, exactly Node), value row[1] as the
    // `string | undefined` union (a 1-element row's [1] read IS undefined
    // in Node; 'A=B=C'.split('=') takes 'B' and drops the tail). Later
    // duplicates overwrite in place — first insertion position wins for
    // ORDER, last value wins, the tuple path's rule.
    if (argIr.elem.kind === "array" && argIr.elem.elem.kind === "string") {
      return lowerFromEntriesStringRows(L, call, argNode, argIr as IrType & { kind: "array" });
    }
    if (argIr.elem.kind !== "record") return null;
    const tupleShape = L.shapes.get(argIr.elem.shapeId);
    if (!tupleShape?.tuple || tupleShape.fields.length !== 2) return null;
    const keyT = tupleShape.fields.find((f) => f.name === "0")!.type;
    const valT = tupleShape.fields.find((f) => f.name === "1")!.type;
    if (keyT.kind !== "string") return null;
    // The result shape is interned directly — the lib's `{ [k: string]: T }`
    // return type is lib-declared and deliberately does not map through
    // provenance; the PURE index-signature shape over the tuple's value
    // type IS that type (structurally identical to Record<string, T>, so
    // it interns to the same shape a user annotation would).
    if (!isSupportedIndexValue(valT)) return null;
    const resultT: IrType & { kind: "record" } = {
      kind: "record",
      shapeId: L.shapes.intern([], false, valT, []),
    };
    const iv = valT;
    const loc = locOf(call);
    // The tuple's value position must flow into the index-value slot.
    const convertible =
      typeEquals(valT, iv) || (iv.kind === "dyn" && L.dynConvertible(valT));
    const convert = (v: IrExpr): IrExpr =>
      typeEquals(valT, iv) ? v : { kind: "dynFrom", value: v, type: DYN, loc };
    if (!convertible) {
      L.unsupported(
        "SC1090",
        call,
        `Object.fromEntries over '${L.fmt(argIr)}' (the tuple's '${L.fmt(valT)}' value cannot flow into the '${L.fmt(iv)}' signature slot)`,
      );
    }
    const receiver = L.lowerExpr(argNode);
    const key = `obj.fromEntries:${argIr.elem.shapeId}:${resultT.shapeId}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.fromEntries.${L.arrHofHelpers.size}`;
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const tRef = ref("t.0", argIr.elem);
      const body: IrStmt[] = [
        { kind: "varDecl", localId: "out.0", init: { kind: "recordLit", fields: [], type: resultT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: ref("i.0", F64),
            right: { kind: "arrIntrinsic", method: "length", receiver: ref("a.0", argIr), args: [], type: F64, loc },
            type: BOOL,
            loc,
          },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
            loc,
          },
          body: [
            { kind: "varDecl", localId: "t.0", init: { kind: "arrayGet", arr: ref("a.0", argIr), index: ref("i.0", F64), type: argIr.elem, loc }, loc },
            {
              kind: "recordKeySet",
              obj: ref("out.0", resultT),
              shapeId: resultT.shapeId,
              key: { kind: "recordGet", obj: tRef, shapeId: argIr.elem.shapeId, field: "0", type: STRING, loc },
              value: convert({ kind: "recordGet", obj: tRef, shapeId: argIr.elem.shapeId, field: "1", type: valT, loc })!,
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: ref("out.0", resultT), loc },
      ];
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push({
        name: helper,
        params: [{ localId: "a.0", name: "a", type: argIr }],
        returnType: resultT,
        locals: [
          { id: "a.0", name: "a", type: argIr, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "t.0", name: "t", type: argIr.elem, mutable: false },
        ],
        body,
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }

/** The string-rows half of lowerObjectFromEntriesCall (see the caller's
   * comment): an interned helper loops the `string[][]` rows and
   * keyed-writes ToPropertyKey(row[0]) → row[1] into a fresh
   * `{ [k: string]: string | undefined }` record. Row reads are lazy
   * ternaries over the row's length — a static string[] read past the end
   * would trap, but Node's fromEntries reads entry[0]/entry[1] as plain
   * (possibly-undefined) gets: the empty row keys "undefined", the
   * 1-element row's value is the union's undefined arm. */
  function lowerFromEntriesStringRows(L: Lowerer, call: ts.CallExpression,
    argNode: ts.Expression, argIr: IrType & { kind: "array" },): IrExpr {
    const loc = locOf(call);
    const rowT = argIr.elem; // string[]
    const valT: IrType = { kind: "union", unionId: L.unions.intern([STRING, UNDEFINED_T]) };
    const strTag = L.armTag(valT.unionId, STRING);
    const resultT: IrType & { kind: "record" } = {
      kind: "record",
      shapeId: L.shapes.intern([], false, valT, []),
    };
    const receiver = L.lowerExpr(argNode);
    const key = `obj.fromEntries:strrows:${resultT.shapeId}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.fromEntries.${L.arrHofHelpers.size}`;
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const tRef = ref("t.0", rowT);
      const rowLen: IrExpr = { kind: "arrIntrinsic", method: "length", receiver: tRef, args: [], type: F64, loc };
      const lenAtLeast = (n: number): IrExpr =>
        ({ kind: "bin", op: ">=", left: rowLen, right: num(n), type: BOOL, loc });
      const body: IrStmt[] = [
        { kind: "varDecl", localId: "out.0", init: { kind: "recordLit", fields: [], type: resultT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: ref("i.0", F64),
            right: { kind: "arrIntrinsic", method: "length", receiver: ref("a.0", argIr), args: [], type: F64, loc },
            type: BOOL,
            loc,
          },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
            loc,
          },
          body: [
            { kind: "varDecl", localId: "t.0", init: { kind: "arrayGet", arr: ref("a.0", argIr), index: ref("i.0", F64), type: rowT, loc }, loc },
            {
              kind: "recordKeySet",
              obj: ref("out.0", resultT),
              shapeId: resultT.shapeId,
              key: {
                kind: "ternary",
                cond: lenAtLeast(1),
                then: { kind: "arrayGet", arr: tRef, index: num(0), type: STRING, loc },
                else_: { kind: "strLit", value: "undefined", type: STRING, loc },
                type: STRING,
                loc,
              },
              value: {
                kind: "ternary",
                cond: lenAtLeast(2),
                then: {
                  kind: "unionWrap",
                  unionId: valT.unionId,
                  tag: strTag,
                  value: { kind: "arrayGet", arr: tRef, index: num(1), type: STRING, loc },
                  type: valT,
                  loc,
                },
                else_: L.wrappedUndefined(valT, loc)!,
                type: valT,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: ref("out.0", resultT), loc },
      ];
      L.arrHofHelpers.set(key, helper);
      L.liftedFns.push({
        name: helper,
        params: [{ localId: "a.0", name: "a", type: argIr }],
        returnType: resultT,
        locals: [
          { id: "a.0", name: "a", type: argIr, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "t.0", name: "t", type: rowT, mutable: false },
        ],
        body,
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }

/** Interned `%rec.capture.<n>(s)` — the INDEX-SIGNATURE reshape behind
   * `Object.fromEntries(entries) as ModelPricing` (hybrid→hybrid width
   * coercion) and `const r: Record<string, number> = { a: 1, b: 2 }`
   * (a DECLARED-fields shape narrowing into a pure overflow shape — the
   * record becomes width-free key/value storage), both called from
   * widthCoerce after recordWidthHelper declines: builds the target shape
   * fresh — declared fields default to their undefined arms — then
   * keyed-writes every source key into it, declared fields first in the
   * source's DECLARATION order (skipping ones holding the undefined arm,
   * the unset convention — insertion order is what Object.keys/JSON
   * answer, stance 37), then the source overflow in JS own-key order. A
   * key colliding with a target DECLARED field validates through the
   * keyed write's dynCheck (a mismatch throws the catchable TypeError —
   * divergence 34), which is exactly what makes the `as` honest. The
   * result is a COPY (divergence 36's stance). Null when the pair is
   * outside the supported matrix: the target needs an index signature,
   * every source value (declared fields, and the overflow slot when the
   * source carries one) must enter the target's value slot (identity, a
   * width lift — arm wrap/re-tag/nested reshape, or JSON-safe into a dyn
   * slot), and every target field must either be initialized directly by
   * a same-named source declared field (the rule that admits REQUIRED
   * declared members) or be optional-flavored (the fresh record's
   * default) and writable at runtime. */
  export function lowerRecordOvfCaptureHelper(L: Lowerer, fromId: string, toId: string, loc: SrcLoc,): string | null {
    const from = L.shapes.get(fromId);
    const to = L.shapes.get(toId);
    if (!from || !to?.indexValue || from.tuple || to.tuple) return null;
    const fIv = from.indexValue ?? null;
    const tIv = to.indexValue;
    // How a source value enters the target's value slot: identity, the
    // dyn conversion, or a width lift (wrap/retag/nested reshape).
    const slotLift = (t: IrType): WidthLift | "dyn" | null => {
      if (typeEquals(t, tIv)) return { how: "copy" };
      if (tIv.kind === "dyn" && (t.kind === "dyn" || L.dynConvertible(t))) return "dyn";
      return L.widthLiftPlan(t, tIv);
    };
    // The overflow value slot must line up (sources without an index
    // signature have no overflow to carry over).
    if (fIv && slotLift(fIv) === null) return null;
    // Target declared fields initialize one of two ways. A same-named
    // SOURCE declared field whose type lifts initializes the slot DIRECTLY
    // (consumed — no keyed write below): the declared half of a width flow
    // into a hybrid target (`{ a: 1, b: 2 }` into `{ a: number;
    // [k: string]: number }`), which is also what admits REQUIRED declared
    // target fields — tsc guarantees the source declares them (an index
    // signature alone never satisfies a required member), and an
    // index-signature source's OVERFLOW can never collide with them (its
    // own declared name owns the key). Every other target field defaults
    // to its undefined arm (fresh record), so it must be optional-flavored
    // and must accept a runtime collision (dyn slots validate via dynCheck
    // — fields must be dyn-convertible; typed slots write through
    // directly).
    type FieldInit =
      | { name: string; kind: "undef"; unionId: string; utag: number }
      | { name: string; kind: "direct"; src: IrType; lift: WidthLift };
    const inits: FieldInit[] = [];
    const consumed = new Set<string>();
    for (const tf of to.fields) {
      const sf = from.fields.find((f) => f.name === tf.name);
      const directLift = sf ? L.widthLiftPlan(sf.type, tf.type) : null;
      if (sf && directLift) {
        inits.push({ name: tf.name, kind: "direct", src: sf.type, lift: directLift });
        consumed.add(tf.name);
        continue;
      }
      if (tf.type.kind !== "union") return null;
      const utag = L.armTag(tf.type.unionId, UNDEFINED_T);
      if (utag < 0) return null;
      if (tIv.kind === "dyn" ? !L.dynConvertible(tf.type) : !typeEquals(tf.type, tIv)) return null;
      inits.push({ name: tf.name, kind: "undef", unionId: tf.type.unionId, utag });
    }
    // Every source declared field must flow into the keyed-write slot —
    // in DECLARATION order (insertion order below; declaredOrder omits
    // internal '%'-fields, which never enter the copy).
    const orderedFields = from.declaredOrder
      ? from.declaredOrder.flatMap((n) => {
          const f = from.fields.find((x) => x.name === n);
          return f ? [f] : [];
        })
      : from.fields;
    const fieldLifts = new Map<string, WidthLift | "dyn">();
    for (const ff of orderedFields) {
      if (consumed.has(ff.name)) continue; // direct-initialized above
      const lift = slotLift(ff.type);
      if (lift === null) return null;
      fieldLifts.set(ff.name, lift);
    }
    // DISPATCH writes — keys that can hit a declared target slot: the
    // overflow loop's runtime keys, and a literal source-field name the
    // target also declares. Non-dyn slots store THROUGH on a collision, so
    // such writes need every declared field to BE the slot type (the
    // validator's recordKeySet rule); dyn slots validate per field
    // (dynCheck), so each field must be dyn-convertible. Writes to
    // literal names the target does NOT declare are overflowOnly and
    // exempt — which is what lets a direct-initialized required field
    // (`id: number` beside a `number | undefined` slot) coexist with a
    // declared-only source, while an index-signature source declines.
    const dispatchWrites =
      fIv !== undefined ||
      orderedFields.some((ff) => !consumed.has(ff.name) && to.fields.some((f) => f.name === ff.name));
    if (dispatchWrites) {
      if (tIv.kind === "dyn" ? !to.fields.every((f) => L.dynConvertible(f.type)) : !to.fields.every((f) => typeEquals(f.type, tIv))) {
        return null;
      }
    }
    const key = `ovf:${fromId}:${toId}`;
    const existing = L.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%rec.capture.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const toT: IrType = { kind: "record", shapeId: toId };
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const sRef = ref("s.0", fromT);
    const outRef = ref("out.0", toT);
    const intoSlot = (v: IrExpr, lift: WidthLift | "dyn"): IrExpr =>
      lift === "dyn"
        ? { kind: "dynFrom", value: v, type: DYN, loc }
        : L.applyWidthLift(lift, v, tIv, loc);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: {
          kind: "recordLit",
          fields: inits.map((d) => ({
            name: d.name,
            value:
              d.kind === "direct"
                ? L.applyWidthLift(
                    d.lift,
                    { kind: "recordGet", obj: sRef, shapeId: fromId, field: d.name, type: d.src, loc },
                    to.fields.find((f) => f.name === d.name)!.type,
                    loc,
                  )
                : ({
                    kind: "unionWrap",
                    unionId: d.unionId,
                    tag: d.utag,
                    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
                    type: to.fields.find((f) => f.name === d.name)!.type,
                    loc,
                  } satisfies IrExpr),
          })),
          type: toT,
          loc,
        },
        loc,
      },
    ];
    const fieldStmts = new Map<string, IrStmt>();
    // Source declared fields in declaration order, skipping unset
    // optionals (stance 37) and the direct-initialized (consumed) names.
    for (const ff of orderedFields) {
      if (consumed.has(ff.name)) continue;
      const raw: IrExpr = { kind: "recordGet", obj: sRef, shapeId: fromId, field: ff.name, type: ff.type, loc };
      const utag = ff.type.kind === "union" ? L.armTag(ff.type.unionId, UNDEFINED_T) : -1;
      const write: IrStmt = {
        kind: "recordKeySet",
        obj: outRef,
        shapeId: toId,
        key: { kind: "strLit", value: ff.name, type: STRING, loc },
        value: intoSlot(raw, fieldLifts.get(ff.name)!),
        // A literal name the target does not declare can only land in the
        // overflow — skip the declared dispatch (and its validator gate).
        ...(to.fields.some((f) => f.name === ff.name) ? {} : { overflowOnly: true as const }),
        loc,
      };
      const fieldStmt: IrStmt =
        utag >= 0 && ff.type.kind === "union"
          ? {
              kind: "if",
              cond: { kind: "unionIsTag", unionId: ff.type.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc },
              then: [write],
              else_: null,
              loc,
            }
          : write;
      fieldStmts.set(ff.name, fieldStmt);
      body.push(fieldStmt);
    }
    // The source overflow, in JS own-key order (only index-signature
    // sources carry one).
    const ksT = arrayOf(STRING);
    if (fIv) {
      const ovfLift = slotLift(fIv)!;
      body.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: sRef, shapeId: fromId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: ref("i.0", F64),
            right: { kind: "arrIntrinsic", method: "length", receiver: ref("ks.0", ksT), args: [], type: F64, loc },
            type: BOOL,
            loc,
          },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
            loc,
          },
          body: [
            { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: ref("ks.0", ksT), index: ref("i.0", F64), type: STRING, loc }, loc },
            {
              kind: "recordKeySet",
              obj: outRef,
              shapeId: toId,
              key: ref("k.0", STRING),
              value: intoSlot({ kind: "recordKeyGet", obj: sRef, shapeId: fromId, key: ref("k.0", STRING), overflowOnly: true, type: fIv, loc }, ovfLift),
              loc,
            },
          ],
          loc,
        },
      );
    }
    body.push({ kind: "return", value: outRef, loc });
    const suffix = body.slice(1 + fieldStmts.size);
    const fn: IrFunction = {
      name,
      params: [{ localId: "s.0", name: "s", type: fromT }],
      returnType: toT,
      locals: [
        { id: "s.0", name: "s", type: fromT, mutable: true },
        { id: "out.0", name: "out", type: toT, mutable: false },
        ...(fIv
          ? [
              { id: "ks.0", name: "ks", type: ksT, mutable: false },
              { id: "i.0", name: "i", type: F64, mutable: true },
              { id: "k.0", name: "k", type: STRING, mutable: false },
            ]
          : []),
      ],
      body,
      loc,
    };
    L.shapeOrderHelperFinalizers.push(() => {
      const current = L.shapes.get(fromId) ?? from;
      const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
      fn.body = [body[0]!, ...currentOrder.flatMap((field) => {
        const stmt = fieldStmts.get(field);
        return stmt ? [stmt] : [];
      }), ...suffix];
    });
    L.liftedFns.push(fn);
    return name;
  }

/** `Object.assign(target, ...sources)` into an INDEX-SIGNATURE record:
   * the capture helper's keyed-write walk aimed at the EXISTING target —
   * each source's declared fields write in declaration order (unset
   * optionals skip, stance 37), then its overflow in JS own-key order,
   * and the result IS the target (identity, like JS — later reads through
   * the target see every merged key). One interned `%obj.assign.<n>(t, s)`
   * per (target shape, source shape) pair; multiple sources chain. Null
   * when outside the matrix: the target needs an index signature, every
   * source value must enter its value slot (identity, a width lift, or
   * the dyn conversion), and tsc's `T & U` result type must collapse back
   * to the target's own record shape (the self-shaped merges init-config
   * patterns spell). */
  export function lowerObjectAssignIndexShape(L: Lowerer, call: ts.CallExpression): IrExpr | null {
    if (call.arguments.length < 2 || call.arguments.some((a) => ts.isSpreadElement(a))) return null;
    const loc = locOf(call);
    const targetIr = L.mapTypeOf(L.typeOf(call.arguments[0]!));
    if (targetIr?.kind !== "record") return null;
    const to = L.shapes.get(targetIr.shapeId);
    if (!to?.indexValue || to.tuple) return null;
    // tsc types the call `T & U & …`; the runtime value is the TARGET
    // record (its shape, its identity). The lowering is honest exactly
    // when nothing observes the intersection: the result is DISCARDED
    // (expression-statement position — the mutate-in-place spelling), or
    // the intersection collapses back to the target's own mapped record.
    let parent: ts.Node = call.parent;
    while (ts.isParenthesizedExpression(parent) || ts.isVoidExpression(parent)) parent = parent.parent;
    const discarded = ts.isExpressionStatement(parent);
    if (!discarded) {
      const resultIr = L.mapTypeOf(L.typeOf(call));
      if (!resultIr || !typeEquals(resultIr, targetIr)) return null;
    }
    const tIv = to.indexValue;
    const slotLift = (t: IrType): WidthLift | "dyn" | null => {
      if (typeEquals(t, tIv)) return { how: "copy" };
      if (tIv.kind === "dyn" && (t.kind === "dyn" || L.dynConvertible(t))) return "dyn";
      return L.widthLiftPlan(t, tIv);
    };
    // Validate EVERY source before interning anything.
    interface SourcePlan {
      fromId: string;
      fields: { name: string; type: IrType; lift: WidthLift | "dyn" }[];
      ovfLift: (WidthLift | "dyn") | null;
    }
    const plans: SourcePlan[] = [];
    for (const argNode of call.arguments.slice(1)) {
      const srcIr = L.mapTypeOf(L.typeOf(argNode));
      if (srcIr?.kind !== "record") return null;
      const from = L.shapes.get(srcIr.shapeId);
      if (!from || from.tuple) return null;
      if (from.fields.some((f) => f.name.startsWith("%"))) return null;
      const orderedFields = from.declaredOrder
        ? from.declaredOrder.flatMap((n) => {
            const f = from.fields.find((x) => x.name === n);
            return f ? [f] : [];
          })
        : from.fields;
      const fields: SourcePlan["fields"] = [];
      for (const ff of orderedFields) {
        const lift = slotLift(ff.type);
        if (lift === null) return null;
        fields.push({ name: ff.name, type: ff.type, lift });
      }
      let ovfLift: (WidthLift | "dyn") | null = null;
      if (from.indexValue) {
        ovfLift = slotLift(from.indexValue);
        if (ovfLift === null) return null;
      }
      plans.push({ fromId: srcIr.shapeId, fields, ovfLift });
    }
    const helperFor = (plan: SourcePlan): string => {
      const key = `assign:${targetIr.shapeId}:${plan.fromId}`;
      const existing = L.widthHelpers.get(key);
      if (existing) return existing;
      const name = `%obj.assign.${L.widthHelpers.size}`;
      L.widthHelpers.set(key, name);
      const toT: IrType = { kind: "record", shapeId: targetIr.shapeId };
      const fromT: IrType = { kind: "record", shapeId: plan.fromId };
      const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
      const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
      const tRef = ref("t.0", toT);
      const sRef = ref("s.0", fromT);
      const intoSlot = (v: IrExpr, lift: WidthLift | "dyn"): IrExpr =>
        lift === "dyn" ? { kind: "dynFrom", value: v, type: DYN, loc } : L.applyWidthLift(lift, v, tIv, loc);
      const body: IrStmt[] = [];
      const fieldStmts = new Map<string, IrStmt>();
      for (const ff of plan.fields) {
        const raw: IrExpr = { kind: "recordGet", obj: sRef, shapeId: plan.fromId, field: ff.name, type: ff.type, loc };
        const utag = ff.type.kind === "union" ? L.armTag(ff.type.unionId, UNDEFINED_T) : -1;
        const write: IrStmt = {
          kind: "recordKeySet",
          obj: tRef,
          shapeId: targetIr.shapeId,
          key: { kind: "strLit", value: ff.name, type: STRING, loc },
          value: intoSlot(raw, ff.lift),
          loc,
        };
        const fieldStmt: IrStmt =
          utag >= 0 && ff.type.kind === "union"
            ? {
                kind: "if",
                cond: { kind: "unionIsTag", unionId: ff.type.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc },
                then: [write],
                else_: null,
                loc,
              }
            : write;
        fieldStmts.set(ff.name, fieldStmt);
        body.push(fieldStmt);
      }
      const ksT = arrayOf(STRING);
      const fromShape = L.shapes.get(plan.fromId)!;
      if (plan.ovfLift !== null && fromShape.indexValue) {
        const fIv = fromShape.indexValue;
        body.push(
          { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: sRef, shapeId: plan.fromId, type: ksT, loc }, loc },
          {
            kind: "for",
            init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
            cond: {
              kind: "bin",
              op: "<",
              left: ref("i.0", F64),
              right: { kind: "arrIntrinsic", method: "length", receiver: ref("ks.0", ksT), args: [], type: F64, loc },
              type: BOOL,
              loc,
            },
            update: {
              kind: "assign",
              localId: "i.0",
              value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc },
              loc,
            },
            body: [
              { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: ref("ks.0", ksT), index: ref("i.0", F64), type: STRING, loc }, loc },
              {
                kind: "recordKeySet",
                obj: tRef,
                shapeId: targetIr.shapeId,
                key: ref("k.0", STRING),
                value: intoSlot({ kind: "recordKeyGet", obj: sRef, shapeId: plan.fromId, key: ref("k.0", STRING), overflowOnly: true, type: fIv, loc }, plan.ovfLift),
                loc,
              },
            ],
            loc,
          },
        );
      }
      body.push({ kind: "return", value: tRef, loc });
      const suffix = body.slice(fieldStmts.size);
      const fn: IrFunction = {
        name,
        params: [
          { localId: "t.0", name: "t", type: toT },
          { localId: "s.0", name: "s", type: fromT },
        ],
        returnType: toT,
        locals: [
          { id: "t.0", name: "t", type: toT, mutable: true },
          { id: "s.0", name: "s", type: fromT, mutable: true },
          ...(plan.ovfLift !== null && fromShape.indexValue
            ? [
                { id: "ks.0", name: "ks", type: ksT, mutable: false },
                { id: "i.0", name: "i", type: F64, mutable: true },
                { id: "k.0", name: "k", type: STRING, mutable: false },
              ]
            : []),
        ],
        body,
        loc,
      };
      L.shapeOrderHelperFinalizers.push(() => {
        const current = L.shapes.get(plan.fromId) ?? fromShape;
        const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
        fn.body = [...currentOrder.flatMap((field) => {
          const stmt = fieldStmts.get(field);
          return stmt ? [stmt] : [];
        }), ...suffix];
      });
      L.liftedFns.push(fn);
      return name;
    };
    let acc = L.lowerExprExpecting(call.arguments[0]!, targetIr);
    for (let i = 0; i < plans.length; i++) {
      const src = L.lowerExprExpecting(call.arguments[i + 1]!, { kind: "record", shapeId: plans[i]!.fromId });
      acc = { kind: "call", callee: helperFor(plans[i]!), args: [acc, src], type: targetIr, loc };
    }
    return acc;
  }

/** One contributor of a pure-index-record MERGE literal: a full spread of
 * an index-signature record, or one explicit key. */
export type IndexMergeContributor =
  | { kind: "spread"; shapeId: string; value: IrExpr }
  | { kind: "field"; name: string; value: IrExpr }
  /** A RUNTIME-keyed property (`{ ...m, ["a" + "b"]: v }`, `{ [K]: v }`
   * over a runtime string K): the key is its own helper argument, passed
   * immediately BEFORE its value (JS's per-property key-then-value order
   * rides the call's argument evaluation), already stringified by the
   * caller (ToPropertyKey). */
  | { kind: "keyedField"; key: IrExpr; value: IrExpr }
  /** `...(cond ? { k: v } : {})` at its literal position: the key writes
   * ONLY when the value isn't the undefined arm (overflow entries model
   * presence — an absent key stays absent, exactly JS's empty-arm spread).
   * The caller builds `value` as `cond ? v : <interned undefined arm of
   * the target's value slot>` — cond evaluates once, `v` lazily — so the
   * target's index-value type must carry an undefined arm. The explicit
   * `{ k: undefined }` true-arm collapses to absence, divergence 56's
   * documented stance. */
  | { kind: "condField"; name: string; value: IrExpr };

/** The interned merge helper behind `{ ...a, ...b, K: v }` literals whose
   * TARGET shape is a PURE index-signature record (no declared fields) —
   * the spawn-env pattern (`{ ...process.env, ...extraEnv }`). Contributors
   * apply in literal order with keyed writes, so JS's last-write-wins holds
   * for colliding runtime keys. Spread sources must be index-signature
   * records whose value slot IS the target's or LIFTS into it (a
   * `Record<string, string>` spreads into a `string | undefined` target by
   * wrapping each copied value); their declared fields copy first (skipping
   * undefined-armed absents — the unset convention), then their overflow in
   * JS own-key order. Explicit values arrive pre-coerced to the target's
   * value slot. Null when a spread source is outside that matrix (the
   * caller keeps its fence). */
  export function lowerIndexMergeHelper(L: Lowerer, toId: string,
    contributors: IndexMergeContributor[], loc: SrcLoc,): string | null {
    const to = L.shapes.get(toId);
    if (!to?.indexValue || to.tuple || to.fields.length > 0) return null;
    const tIv = to.indexValue;
    // Per-source plan: how each spread's values reach the target slot —
    // identity, a one-arm wrap, or (a SUB-UNION value slot: the
    // `{ ...proxyRes.headers }` spread into OutgoingHttpHeaders, whose
    // slot adds arms the source never carries) an arm-wise re-tag. A
    // FIXED-shape source (the `{ ...DEFAULT_TOKENS }` config-defaults
    // pattern) plans per FIELD instead: each declared field keyed-writes
    // when its type enters the slot (identity, the dyn conversion, or a
    // width lift — the capture helper's matrix); accessor/reserved slots
    // decline (a spread would need the getter's computed value).
    const srcPlans: { shapeId: string; wrapTag: number; retag: string | null; fields: Map<string, WidthLift | "dyn"> | null }[] = [];
    for (const c of contributors) {
      // A conditional spread needs the undefined arm as its "absent"
      // value — a target slot without one can't carry the empty arm.
      if (c.kind === "condField" && (tIv.kind !== "union" || L.armTag(tIv.unionId, UNDEFINED_T) < 0)) {
        return null;
      }
      if (c.kind !== "spread") continue;
      const from = L.shapes.get(c.shapeId);
      if (!from || from.tuple) return null;
      if (!from.indexValue) {
        if (from.fields.some((f) => f.name.startsWith("%"))) return null;
        const fields = new Map<string, WidthLift | "dyn">();
        for (const ff of from.fields) {
          const lift = typeEquals(ff.type, tIv)
            ? ({ how: "copy" } as WidthLift)
            : tIv.kind === "dyn" && (ff.type.kind === "dyn" || L.dynConvertible(ff.type))
              ? "dyn"
              : L.widthLiftPlan(ff.type, tIv);
          if (lift === null) return null;
          fields.set(ff.name, lift);
        }
        srcPlans.push({ shapeId: c.shapeId, wrapTag: -1, retag: null, fields });
        continue;
      }
      const fIv = from.indexValue;
      let wrapTag = -1;
      let retag: string | null = null;
      if (!typeEquals(fIv, tIv)) {
        if (tIv.kind !== "union") return null;
        wrapTag = L.armTag(tIv.unionId, fIv);
        if (wrapTag < 0) {
          if (!(fIv.kind === "union" && L.unionRetagMappable(fIv.unionId, tIv.unionId))) return null;
          retag = L.unionRetagHelper(fIv.unionId, tIv.unionId, loc);
          if (retag === null) return null;
        }
      }
      for (const ff of from.fields) {
        // Declared source fields must reach the slot the same way the
        // overflow does (fields typed AS the source's own value slot); a
        // shape outside that keeps the fence.
        if (!typeEquals(ff.type, fIv)) return null;
      }
      srcPlans.push({ shapeId: c.shapeId, wrapTag, retag, fields: null });
    }
    const key =
      `ixmerge:${toId}:` +
      contributors
        .map((c) => (c.kind === "spread" ? `s${c.shapeId}` : c.kind === "condField" ? `c${c.name}` : c.kind === "keyedField" ? "k" : `f${c.name}`))
        .join(",");
    const existing = L.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%rec.merge.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const toT: IrType = { kind: "record", shapeId: toId };
    const ksT = arrayOf(STRING);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const outRef = ref("out.0", toT);
    const params: IrParam[] = [];
    const locals: IrLocal[] = [{ id: "out.0", name: "out", type: toT, mutable: false }];
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "recordLit", fields: [], type: toT, loc }, loc },
    ];
    let spreadNo = 0;
    contributors.forEach((c, ci) => {
      if (c.kind === "keyedField") {
        // The runtime key and its value are consecutive parameters — the
        // call site's argument order IS the property's key-then-value
        // evaluation order.
        const kid = `kk.${ci}`;
        const pid = `v.${ci}`;
        params.push({ localId: kid, name: `kk${ci}`, type: STRING }, { localId: pid, name: `v${ci}`, type: tIv });
        locals.push({ id: kid, name: `kk${ci}`, type: STRING, mutable: false }, { id: pid, name: `v${ci}`, type: tIv, mutable: false });
        body.push({
          kind: "recordKeySet",
          obj: outRef,
          shapeId: toId,
          key: ref(kid, STRING),
          value: ref(pid, tIv),
          overflowOnly: true,
          loc,
        });
        return;
      }
      if (c.kind === "field" || c.kind === "condField") {
        const pid = `v.${ci}`;
        params.push({ localId: pid, name: `v${ci}`, type: tIv });
        locals.push({ id: pid, name: `v${ci}`, type: tIv, mutable: false });
        const write: IrStmt = {
          kind: "recordKeySet",
          obj: outRef,
          shapeId: toId,
          key: { kind: "strLit", value: c.name, type: STRING, loc },
          value: ref(pid, tIv),
          overflowOnly: true,
          loc,
        };
        if (c.kind === "condField" && tIv.kind === "union") {
          // The key writes only when the spread's condition held (its
          // value arg holds the interned undefined arm otherwise) — an
          // absent key STAYS absent, presence being the observable.
          // (The pre-pass above guaranteed the undefined arm exists.)
          const undefTag = L.armTag(tIv.unionId, UNDEFINED_T);
          body.push({
            kind: "if",
            cond: { kind: "unionIsTag", unionId: tIv.unionId, tag: undefTag, negated: true, value: ref(pid, tIv), type: BOOL, loc },
            then: [write],
            else_: null,
            loc,
          });
          return;
        }
        body.push(write);
        return;
      }
      const plan = srcPlans[spreadNo]!;
      const n = spreadNo++;
      const from = L.shapes.get(plan.shapeId)!;
      const fromT: IrType = { kind: "record", shapeId: plan.shapeId };
      const sid = `s.${ci}`;
      params.push({ localId: sid, name: `s${ci}`, type: fromT });
      locals.push({ id: sid, name: `s${ci}`, type: fromT, mutable: false });
      const sRef = ref(sid, fromT);
      // A FIXED-shape source: each declared field keyed-writes through its
      // own planned lift (absent optionals skip — the unset convention);
      // no overflow exists to walk.
      if (plan.fields !== null) {
        for (const ff of from.fields) {
          const lift = plan.fields.get(ff.name)!;
          const raw: IrExpr = { kind: "recordGet", obj: sRef, shapeId: plan.shapeId, field: ff.name, type: ff.type, loc };
          const utag = ff.type.kind === "union" ? L.armTag(ff.type.unionId, UNDEFINED_T) : -1;
          const write: IrStmt = {
            kind: "recordKeySet",
            obj: outRef,
            shapeId: toId,
            key: { kind: "strLit", value: ff.name, type: STRING, loc },
            value: lift === "dyn" ? { kind: "dynFrom", value: raw, type: DYN, loc } : L.applyWidthLift(lift, raw, tIv, loc),
            overflowOnly: true,
            loc,
          };
          body.push(
            utag >= 0 && ff.type.kind === "union"
              ? { kind: "if", cond: { kind: "unionIsTag", unionId: ff.type.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc }, then: [write], else_: null, loc }
              : write,
          );
        }
        return;
      }
      const fIv = from.indexValue!;
      const intoSlot = (v: IrExpr): IrExpr =>
        plan.retag !== null
          ? { kind: "call", callee: plan.retag, args: [v], type: tIv, loc }
          : plan.wrapTag < 0
            ? v
            : { kind: "unionWrap", unionId: (tIv as IrType & { kind: "union" }).unionId, tag: plan.wrapTag, value: v, type: tIv, loc };
      // Declared source fields first (literal keys; absent optionals skip).
      for (const ff of from.fields) {
        const raw: IrExpr = { kind: "recordGet", obj: sRef, shapeId: plan.shapeId, field: ff.name, type: ff.type, loc };
        const utag = ff.type.kind === "union" ? L.armTag(ff.type.unionId, UNDEFINED_T) : -1;
        const write: IrStmt = {
          kind: "recordKeySet",
          obj: outRef,
          shapeId: toId,
          key: { kind: "strLit", value: ff.name, type: STRING, loc },
          value: intoSlot(raw),
          overflowOnly: true,
          loc,
        };
        body.push(
          utag >= 0 && ff.type.kind === "union"
            ? { kind: "if", cond: { kind: "unionIsTag", unionId: ff.type.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc }, then: [write], else_: null, loc }
            : write,
        );
      }
      // Then the source overflow, in JS own-key order.
      const ks = `ks.${ci}`;
      const iv = `i.${ci}`;
      const kv = `k.${ci}`;
      locals.push(
        { id: ks, name: `ks${n}`, type: ksT, mutable: false },
        { id: iv, name: `i${n}`, type: F64, mutable: true },
        { id: kv, name: `k${n}`, type: STRING, mutable: false },
      );
      body.push(
        { kind: "varDecl", localId: ks, init: { kind: "recordOvfKeys", obj: sRef, shapeId: plan.shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: iv, init: num(0), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: ref(iv, F64),
            right: { kind: "arrIntrinsic", method: "length", receiver: ref(ks, ksT), args: [], type: F64, loc },
            type: BOOL,
            loc,
          },
          update: { kind: "assign", localId: iv, value: { kind: "bin", op: "+", left: ref(iv, F64), right: num(1), type: F64, loc }, loc },
          body: [
            { kind: "varDecl", localId: kv, init: { kind: "arrayGet", arr: ref(ks, ksT), index: ref(iv, F64), type: STRING, loc }, loc },
            {
              kind: "recordKeySet",
              obj: outRef,
              shapeId: toId,
              key: ref(kv, STRING),
              value: intoSlot({ kind: "recordKeyGet", obj: sRef, shapeId: plan.shapeId, key: ref(kv, STRING), overflowOnly: true, type: fIv, loc }),
              overflowOnly: true,
              loc,
            },
          ],
          loc,
        },
      );
    });
    body.push({ kind: "return", value: outRef, loc });
    L.liftedFns.push({ name, params, returnType: toT, locals, body, loc });
    return name;
  }

/** The interned helper flattening an env-shaped record into the
   * [k0, v0, k1, v1, ...] string[] cp.execSync consumes — declared string
   * fields first (undefined-armed absents skipped, the Node-drops-undefined
   * rule), then index-signature overflow in JS own-key order. Every value
   * source must be a string or a `string | undefined` union whose value arm
   * is a string. Null when the shape carries a non-string field/value slot
   * (the caller fences). */
  export function lowerEnvToPairsHelper(L: Lowerer, shapeId: string, loc: SrcLoc): string | null {
    const shape = L.shapes.get(shapeId);
    if (!shape || shape.tuple) return null;
    // A string | undefined value flows as its string arm; a bare string
    // flows directly. `unwrapStr` returns the code (or null → fence).
    const strArmTag = (t: IrType): number | "plain" | null => {
      if (t.kind === "string") return "plain";
      if (t.kind !== "union") return null;
      const def = L.unions.get(t.unionId);
      if (!def) return null;
      const nonUnit = def.arms.filter((a) => !isRefCounted(a) || a.kind === "string");
      // Exactly a string arm plus unit arms (string | undefined).
      const strTag = def.arms.findIndex((a) => a.kind === "string");
      if (strTag < 0) return null;
      if (!def.arms.every((a) => a.kind === "string" || a.kind === "undefinedT" || a.kind === "nullT")) {
        return null;
      }
      void nonUnit;
      return strTag;
    };
    // The HEADER value matrix (OutgoingHttpHeaders — `number | string |
    // string[] | undefined`): numbers format (Node's String(n)), arrays
    // expand to one pair per element (Node writes one line each), units
    // skip. Slots whose arms fit neither matrix keep the fence.
    const headerArms = (t: IrType): { str: number; f64: number; arr: number } | null => {
      if (t.kind !== "union") return null;
      const def = L.unions.get(t.unionId);
      if (!def) return null;
      if (!def.arms.every(
        (a) => a.kind === "string" || a.kind === "f64" ||
          (a.kind === "array" && a.elem.kind === "string") ||
          a.kind === "undefinedT" || a.kind === "nullT",
      )) {
        return null;
      }
      return {
        str: def.arms.findIndex((a) => a.kind === "string"),
        f64: def.arms.findIndex((a) => a.kind === "f64"),
        arr: def.arms.findIndex((a) => a.kind === "array"),
      };
    };
    const slotOk = (t: IrType): boolean => strArmTag(t) !== null || headerArms(t) !== null;
    for (const f of shape.fields) {
      if (!slotOk(f.type)) return null;
    }
    if (shape.indexValue && !slotOk(shape.indexValue)) return null;
    const key = `env.pairs:${shapeId}`;
    const existing = L.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%env.pairs.${L.widthHelpers.size}`;
    L.widthHelpers.set(key, name);
    const recT: IrType = { kind: "record", shapeId };
    const arrT = arrayOf(STRING);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const sRef = ref("s.0", recT);
    const outRef = ref("out.0", arrT);
    // The string value of a field/overflow read: unwrap the union arm, or
    // pass a plain string through.
    const asStr = (raw: IrExpr, t: IrType): IrExpr => {
      const tag = strArmTag(t);
      if (tag === "plain" || tag === null) return raw;
      if (t.kind !== "union") return raw;
      return { kind: "unionNarrow", unionId: t.unionId, tag, value: raw, type: STRING, loc };
    };
    const pushOne = (v: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: { kind: "arrIntrinsic", method: "push", receiver: outRef, args: [v], type: F64, loc },
      loc,
    });
    const push = (k: IrExpr, v: IrExpr): IrStmt => ({ kind: "block", body: [pushOne(k), pushOne(v)], loc });
    const locals: IrLocal[] = [
      { id: "s.0", name: "s", type: recT, mutable: true },
      { id: "out.0", name: "out", type: arrT, mutable: false },
    ];
    // One write per entry: the string|undefined fast path keeps its
    // historic shape; a header slot dispatches arm-wise (string pushes,
    // f64 formats via toString, string[] expands element-wise — repeated
    // same-name pairs, one per element — and units skip).
    let siteNo = 0;
    const writeFor = (k: IrExpr, raw: IrExpr, t: IrType): IrStmt => {
      const st = strArmTag(t);
      if (st !== null) {
        const write = push(k, asStr(raw, t));
        const utag = t.kind === "union" ? L.armTag(t.unionId, UNDEFINED_T) : -1;
        return utag >= 0 && t.kind === "union"
          ? { kind: "if", cond: { kind: "unionIsTag", unionId: t.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc }, then: [write], else_: null, loc }
          : write;
      }
      if (t.kind !== "union") throw new Error("lowerer bug: header slot outside the pairs matrix");
      const ha = headerArms(t)!;
      const isTag = (tag: number): IrExpr =>
        ({ kind: "unionIsTag", unionId: t.unionId, tag, negated: false, value: raw, type: BOOL, loc });
      const narrowTo = (tag: number, nt: IrType): IrExpr =>
        ({ kind: "unionNarrow", unionId: t.unionId, tag, value: raw, type: nt, loc });
      let chain: IrStmt[] = [];
      if (ha.arr >= 0) {
        const uid = siteNo++;
        const aT = arrayOf(STRING);
        locals.push(
          { id: `a.${uid}`, name: `a${uid}`, type: aT, mutable: false },
          { id: `j.${uid}`, name: `j${uid}`, type: F64, mutable: true },
        );
        const aRef = ref(`a.${uid}`, aT);
        const jRef = ref(`j.${uid}`, F64);
        chain = [{
          kind: "if",
          cond: isTag(ha.arr),
          then: [
            { kind: "varDecl", localId: `a.${uid}`, init: narrowTo(ha.arr, aT), loc },
            {
              kind: "for",
              init: { kind: "varDecl", localId: `j.${uid}`, init: num(0), loc },
              cond: { kind: "bin", op: "<", left: jRef, right: { kind: "arrIntrinsic", method: "length", receiver: aRef, args: [], type: F64, loc }, type: BOOL, loc },
              update: { kind: "assign", localId: `j.${uid}`, value: { kind: "bin", op: "+", left: jRef, right: num(1), type: F64, loc }, loc },
              body: [push(k, { kind: "arrayGet", arr: aRef, index: jRef, type: STRING, loc })],
              loc,
            },
          ],
          else_: chain.length > 0 ? chain : null,
          loc,
        }];
      }
      if (ha.f64 >= 0) {
        chain = [{
          kind: "if",
          cond: isTag(ha.f64),
          then: [push(k, { kind: "toString", operand: narrowTo(ha.f64, F64), type: STRING, loc })],
          else_: chain.length > 0 ? chain : null,
          loc,
        }];
      }
      if (ha.str >= 0) {
        chain = [{
          kind: "if",
          cond: isTag(ha.str),
          then: [push(k, narrowTo(ha.str, STRING))],
          else_: chain.length > 0 ? chain : null,
          loc,
        }];
      }
      return { kind: "block", body: chain, loc };
    };
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: arrT, loc }, loc },
    ];
    for (const f of shape.fields) {
      const raw: IrExpr = { kind: "recordGet", obj: sRef, shapeId, field: f.name, type: f.type, loc };
      const k: IrExpr = { kind: "strLit", value: f.name, type: STRING, loc };
      body.push(writeFor(k, raw, f.type));
    }
    if (shape.indexValue) {
      const iv = shape.indexValue;
      const ksT = arrayOf(STRING);
      locals.push(
        { id: "ks.0", name: "ks", type: ksT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "k.0", name: "k", type: STRING, mutable: false },
        { id: "raw.0", name: "raw", type: iv, mutable: false },
      );
      const rawRead: IrExpr = { kind: "recordKeyGet", obj: sRef, shapeId, key: ref("k.0", STRING), overflowOnly: true, type: iv, loc };
      const utag = iv.kind === "union" ? L.armTag(iv.unionId, UNDEFINED_T) : -1;
      const innerBody: IrStmt[] = [
        { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: ref("ks.0", ksT), index: ref("i.0", F64), type: STRING, loc }, loc },
        { kind: "varDecl", localId: "raw.0", init: rawRead, loc },
      ];
      const rawRef = ref("raw.0", iv);
      void utag;
      innerBody.push(writeFor(ref("k.0", STRING), rawRef, iv));
      body.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: sRef, shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: { kind: "arrIntrinsic", method: "length", receiver: ref("ks.0", ksT), args: [], type: F64, loc }, type: BOOL, loc },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc }, loc },
          body: innerBody,
          loc,
        },
      );
    }
    body.push({ kind: "return", value: outRef, loc });
    L.liftedFns.push({ name, params: [{ localId: "s.0", name: "s", type: recT }], returnType: arrT, locals, body, loc });
    return name;
  }

/* ── dyn METHOD receivers ──────────────────────────────────────────────────
 * Method calls on `unknown`/JSON.parse-derived receivers (`pkg.name
 * .replace(...)`, `ws.packages.filter(...)`): validate the receiver's dyn
 * kind, extract, then ride the STATIC method machinery — the dyn boundary's
 * trust-but-VERIFY stance extended to receivers. A receiver of the wrong
 * kind throws the catchable Node-shaped TypeError V8 would ("x.replace is
 * not a function"; nullish receivers throw the property-READ message,
 * "Cannot read properties of undefined (reading 'replace')"). */

/** a + b (+ c...) over strConcat. */
function concatAll(pieces: IrExpr[], loc: SrcLoc): IrExpr {
  return pieces.reduce((left, right) => ({ kind: "strConcat", left, right, type: STRING, loc }));
}

const TYPE_ERROR_T: IrType = { kind: "object", className: "%TypeError" };

/** `throw new TypeError(<msg>)` from IR pieces (the runtime error class —
 * catchable, instanceof TypeError). */
function throwTypeError(msg: IrExpr, loc: SrcLoc): IrStmt {
  return {
    kind: "throw",
    value: { kind: "libCall", fn: "error.new", args: [msg], type: TYPE_ERROR_T, loc },
    loc,
  };
}

/** The three mismatch throws of a dyn method receiver, Node's own order and
 * messages: undefined/null receivers fail the property READ ("Cannot read
 * properties of undefined (reading 'replace')"), anything else of the wrong
 * kind fails the CALL ("pkg.name.replace is not a function"). `m` and
 * `full` are the helper's string params holding the method name and the
 * source text of the whole access. */
function dynRecvThrows(dRef: IrExpr, mRef: IrExpr, fullRef: IrExpr, loc: SrcLoc): IrStmt[] {
  const reading = (unit: "undefined" | "null"): IrStmt => ({
    kind: "if",
    cond: { kind: "dynTest", test: unit, value: dRef, type: BOOL, loc },
    then: [
      throwTypeError(
        concatAll(
          [
            { kind: "strLit", value: `Cannot read properties of ${unit} (reading '`, type: STRING, loc },
            mRef,
            { kind: "strLit", value: "')", type: STRING, loc },
          ],
          loc,
        ),
        loc,
      ),
    ],
    else_: null,
    loc,
  });
  return [
    reading("undefined"),
    reading("null"),
    throwTypeError(
      concatAll([fullRef, { kind: "strLit", value: " is not a function", type: STRING, loc }], loc),
      loc,
    ),
  ];
}

/** The interned `%dyn.recvstr` helper: validate a dyn receiver as a STRING
 * and extract it (+1), or throw the Node-shaped TypeError. One helper for
 * the whole module — the method name and access text ride as arguments. */
  function dynRecvStringHelper(L: Lowerer, loc: SrcLoc): string {
    const key = "dynrecv:string";
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = "%dyn.recvstr";
    L.arrHofHelpers.set(key, name);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const d = ref("d.0", DYN);
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: { kind: "dynTest", test: "string", value: d, type: BOOL, loc },
        then: [{ kind: "return", value: { kind: "dynCheck", value: d, type: STRING, loc }, loc }],
        else_: null,
        loc,
      },
      ...dynRecvThrows(d, ref("m.0", STRING), ref("full.0", STRING), loc),
    ];
    L.liftedFns.push({
      name,
      params: [
        { localId: "d.0", name: "d", type: DYN },
        { localId: "m.0", name: "m", type: STRING },
        { localId: "full.0", name: "full", type: STRING },
      ],
      returnType: STRING,
      locals: [
        { id: "d.0", name: "d", type: DYN, mutable: false },
        { id: "m.0", name: "m", type: STRING, mutable: false },
        { id: "full.0", name: "full", type: STRING, mutable: false },
      ],
      body,
      loc,
    });
    return name;
  }

/** The validated-STRING extraction of a dyn method receiver — the receiver
 * expression the string/regex method lowerings consume. */
  export function dynStringReceiver(L: Lowerer, recv: IrExpr, access: ts.PropertyAccessExpression): IrExpr {
    const loc = locOf(access);
    const helper = dynRecvStringHelper(L, loc);
    return {
      kind: "call",
      callee: helper,
      args: [
        recv,
        { kind: "strLit", value: access.name.text, type: STRING, loc },
        { kind: "strLit", value: access.getText(), type: STRING, loc },
      ],
      type: STRING,
      loc,
    };
  }

/** `d.filter(pred)` on a dyn receiver: the receiver must BE a dyn array
 * (else the Node-shaped TypeError above); the predicate runs per element
 * over the dyn value, and each SURVIVOR is validated-extracted into the
 * result's element type T — the type the checker already committed the
 * call to (the contextual `RouteMapping[]`/`string[]` slot). Extraction is
 * the checked-cast machinery: a survivor that doesn't fit T throws the
 * catchable TypeError instead of misreading (a LYING predicate is the only
 * way there). The result is a fresh STATIC array of extracted copies —
 * the dyn boundary's marshal-copy stance (SEMANTICS.md). Null when the
 * call shape isn't claimable (the method-call fence stays). */
  export function lowerDynArrayFilterCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    recv: IrExpr,): IrExpr | null {
    if (call.arguments.length !== 1) return null;
    const argNode = call.arguments[0]!;
    const loc = locOf(call);
    // The result element type, from what the call flows INTO: the
    // contextual array (or the single array arm of a contextual union —
    // the `string[] | null` return slot), falling back to a type-guard
    // predicate's target (`(r: unknown) => r is T`). Both are tsc's own
    // verdicts on the element; the runtime check makes them honest.
    let elemT: IrType | null = null;
    const ctx = L.checker.getContextualType(call);
    const ctxIr = ctx ? L.mapTypeOf(ctx) : null;
    if (ctxIr?.kind === "array") elemT = ctxIr.elem;
    if (!elemT && ctxIr?.kind === "union") {
      const def = L.unions.get(ctxIr.unionId);
      const arrayArms = def ? def.arms.filter((a) => a.kind === "array") : [];
      if (arrayArms.length === 1 && arrayArms[0]!.kind === "array") elemT = arrayArms[0]!.elem;
    }
    if (!elemT) {
      const sigs = L.checker.getCallSignatures(L.typeOf(argNode));
      const pred = sigs.length === 1 ? L.checker.getTypePredicateOfSignature(sigs[0]!) : undefined;
      if (pred?.type) elemT = L.mapTypeOf(pred.type);
    }
    if (!elemT || !L.jsonSafe(elemT)) {
      // No JSON-representable destination (`const failed = checks.filter(
      // fn)` in untyped JS — test/common's runCallChecks): the result
      // STAYS in the checked-dynamic tree — the runtime prototype dispatch (scr_dyn_invoke)
      // runs the real filter over the dyn array and the survivors keep
      // their dyn selves, no extraction needed. The typed-destination path
      // above stays preferred: it hands back a real T[].
      return null;
    }
    const { fnArg, arity } = hofCallbackArg(L, argNode, [DYN], DYN);
    if (fnArg.type.ret.kind !== "bool") L.badType(argNode, L.typeOf(argNode));
    const helper = dynFilterHelper(L, elemT, arity, loc);
    return {
      kind: "call",
      callee: helper,
      args: [
        recv,
        fnArg,
        { kind: "strLit", value: access.name.text, type: STRING, loc },
        { kind: "strLit", value: access.getText(), type: STRING, loc },
      ],
      type: arrayOf(elemT),
      loc,
    };
  }

/** `.flatMap(f)` on a dyn ('unknown'/`any[]`-narrowed) receiver where the
   * callback returns a STATIC array (`parsed.flatMap((v) => typeof v ===
   * "string" ? parseTldList(v) : [])` — the tlds-file shape): the checked-dynamic tree
   * array walks element-by-element, the callback sees each element as the
   * dyn value `unknown` code sees, and its typed results concatenate —
   * depth-1 flatten by construction, no validation needed on the results
   * (they are already typed; only the RECEIVER is dynamic). Non-array
   * receivers throw the Node-shaped TypeError. Callbacks returning
   * NON-array values (JS would keep them as single elements) or dynamic
   * results keep the fence — nothing drives them yet. */
  export function lowerDynArrayFlatMapCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    recv: IrExpr,): IrExpr | null {
    if (call.arguments.length !== 1) return null;
    const argNode = call.arguments[0]!;
    const loc = locOf(call);
    const { fnArg, arity } = hofCallbackArg(L, argNode, [DYN], DYN);
    const ret = fnArg.type.ret;
    if (ret.kind !== "array") {
      // A DYNAMIC-returning callback (`plugins.flatMap((plugin) =>
      // plugin.languages ?? [])` — the getSupportInfo shape, where the
      // callback's members ride the checked-dynamic tree): the call dispatches on the
      // RECEIVER's runtime kind (dynInvoke) with the callback boxed —
      // a wrapped ISLAND receiver runs the ENGINE's own JS-exact
      // Array.prototype.flatMap (the routed-ops lane), a native dyn
      // array runs the runtime's flatMap, and non-arrays throw Node's
      // TypeError. The result stays dyn, checked per use.
      if (ret.kind === "dyn" || ret.kind === "jsval") {
        const boxed: IrExpr = { kind: "dynFrom", value: fnArg, type: DYN, loc };
        return {
          kind: "dynInvoke",
          recv,
          method: "flatMap",
          calleeName: access.getText(),
          args: [boxed],
          type: DYN,
          loc,
        };
      }
      L.unsupported(
        "SC1090",
        call,
        `'.flatMap' on 'unknown' receivers whose callback returns '${L.fmt(ret)}' ` +
          `(only callbacks returning a typed ARRAY compile — the results concatenate ` +
          `without validation; return one-element/empty arrays instead of bare values)`,
      );
    }
    const helper = dynFlatMapHelper(L, ret.elem, arity, loc);
    return {
      kind: "call",
      callee: helper,
      args: [
        recv,
        fnArg,
        { kind: "strLit", value: access.name.text, type: STRING, loc },
        { kind: "strLit", value: access.getText(), type: STRING, loc },
      ],
      type: arrayOf(ret.elem),
      loc,
    };
  }

/** Interned `%dyn.flatmap.<n>` — one per (element type, callback arity). */
  function dynFlatMapHelper(L: Lowerer, elemT: IrType, arity: number, loc: SrcLoc): string {
    const key = `dynflatmap:${typeKey(elemT)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%dyn.flatmap.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    L.liftedFns.push(buildDynFlatMapFn(name, elemT, arity, loc));
    return name;
  }

/** out = []; n = d.length; for (i..n) { v = d[i]; r = f(v, i, d); for
 * (j..r.length) out.push(r[j]); } return out; — the receiver-kind gate up
 * front, the length read once, elements through the canonical-index keyed
 * read (buildDynFilterFn's discipline). */
  function buildDynFlatMapFn(name: string, elemT: IrType, arity: number, loc: SrcLoc): IrFunction {
    const outT = arrayOf(elemT);
    const retT = arrayOf(elemT);
    const fnT = funcOf([DYN, F64, DYN].slice(0, arity), retT);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const d = ref("d.0", DYN);
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: { kind: "dynTest", test: "array", negated: true, value: d, type: BOOL, loc },
        then: dynRecvThrows(d, ref("m.0", STRING), ref("full.0", STRING), loc),
        else_: null,
        loc,
      },
      {
        kind: "varDecl",
        localId: "n.0",
        init: {
          kind: "dynCheck",
          value: { kind: "dynKeyGet", key: { kind: "strLit", value: "length", type: STRING, loc }, value: d, type: DYN, loc },
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: ref("n.0", F64), type: BOOL, loc },
        update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc }, loc },
        body: [
          {
            kind: "varDecl",
            localId: "v.0",
            init: { kind: "dynKeyGet", key: { kind: "toString", operand: ref("i.0", F64), type: STRING, loc }, value: d, type: DYN, loc },
            loc,
          },
          {
            kind: "varDecl",
            localId: "r.0",
            init: {
              kind: "callValue",
              callee: ref("f.0", fnT),
              args: [ref("v.0", DYN), ref("i.0", F64), d].slice(0, arity),
              type: retT,
              loc,
            },
            loc,
          },
          {
            kind: "varDecl",
            localId: "rn.0",
            init: { kind: "arrIntrinsic", method: "length", receiver: ref("r.0", retT), args: [], type: F64, loc },
            loc,
          },
          {
            kind: "for",
            init: { kind: "varDecl", localId: "j.0", init: num(0), loc },
            cond: { kind: "bin", op: "<", left: ref("j.0", F64), right: ref("rn.0", F64), type: BOOL, loc },
            update: { kind: "assign", localId: "j.0", value: { kind: "bin", op: "+", left: ref("j.0", F64), right: num(1), type: F64, loc }, loc },
            body: [
              {
                kind: "exprStmt",
                expr: {
                  kind: "arrIntrinsic",
                  method: "push",
                  receiver: ref("out.0", outT),
                  args: [{ kind: "arrayGet", arr: ref("r.0", retT), index: ref("j.0", F64), type: elemT, loc }],
                  type: F64,
                  loc,
                },
                loc,
              },
            ],
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("out.0", outT), loc },
    ];
    return {
      name,
      params: [
        { localId: "d.0", name: "d", type: DYN },
        { localId: "f.0", name: "f", type: fnT },
        { localId: "m.0", name: "m", type: STRING },
        { localId: "full.0", name: "full", type: STRING },
      ],
      returnType: outT,
      locals: [
        { id: "d.0", name: "d", type: DYN, mutable: false },
        { id: "f.0", name: "f", type: fnT, mutable: false },
        { id: "m.0", name: "m", type: STRING, mutable: false },
        { id: "full.0", name: "full", type: STRING, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "v.0", name: "v", type: DYN, mutable: false },
        { id: "r.0", name: "r", type: retT, mutable: false },
        { id: "rn.0", name: "rn", type: F64, mutable: false },
        { id: "j.0", name: "j", type: F64, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
      ],
      body,
      loc,
    };
  }

/** Interned `%dyn.filter.<n>` — one per (element type, callback arity). */
  function dynFilterHelper(L: Lowerer, elemT: IrType, arity: number, loc: SrcLoc): string {
    const key = `dynfilter:${typeKey(elemT)}:${arity}`;
    const existing = L.arrHofHelpers.get(key);
    if (existing) return existing;
    const name = `%dyn.filter.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    L.liftedFns.push(buildDynFilterFn(name, elemT, arity, loc));
    return name;
  }

/** out = []; n = d.length; for (i..n) { v = d[i]; if (f(v, i, d)) out.push(
 * check<T>(v)); } return out; — with the receiver-kind gate up front. The
 * length reads ONCE (the checked-dynamic tree is immutable under the static surface), the
 * element reads through the canonical-index keyed read, the callback gets
 * whatever prefix of (element, index, receiver) it declares — the element
 * and receiver as dyn values, exactly what `unknown` code sees. */
  function buildDynFilterFn(name: string, elemT: IrType, arity: number, loc: SrcLoc): IrFunction {
    const outT = arrayOf(elemT);
    const fnT = funcOf([DYN, F64, DYN].slice(0, arity), BOOL);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    const d = ref("d.0", DYN);
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: { kind: "dynTest", test: "array", negated: true, value: d, type: BOOL, loc },
        then: dynRecvThrows(d, ref("m.0", STRING), ref("full.0", STRING), loc),
        else_: null,
        loc,
      },
      {
        kind: "varDecl",
        localId: "n.0",
        init: {
          kind: "dynCheck",
          value: { kind: "dynKeyGet", key: { kind: "strLit", value: "length", type: STRING, loc }, value: d, type: DYN, loc },
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
        cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: ref("n.0", F64), type: BOOL, loc },
        update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc }, loc },
        body: [
          {
            kind: "varDecl",
            localId: "v.0",
            init: { kind: "dynKeyGet", key: { kind: "toString", operand: ref("i.0", F64), type: STRING, loc }, value: d, type: DYN, loc },
            loc,
          },
          {
            kind: "if",
            cond: {
              kind: "callValue",
              callee: ref("f.0", fnT),
              args: [ref("v.0", DYN), ref("i.0", F64), d].slice(0, arity),
              type: BOOL,
              loc,
            },
            then: [
              {
                kind: "exprStmt",
                expr: {
                  kind: "arrIntrinsic",
                  method: "push",
                  receiver: ref("out.0", outT),
                  args: [{ kind: "dynCheck", value: ref("v.0", DYN), type: elemT, loc }],
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
    return {
      name,
      params: [
        { localId: "d.0", name: "d", type: DYN },
        { localId: "f.0", name: "f", type: fnT },
        { localId: "m.0", name: "m", type: STRING },
        { localId: "full.0", name: "full", type: STRING },
      ],
      returnType: outT,
      locals: [
        { id: "d.0", name: "d", type: DYN, mutable: false },
        { id: "f.0", name: "f", type: fnT, mutable: false },
        { id: "m.0", name: "m", type: STRING, mutable: false },
        { id: "full.0", name: "full", type: STRING, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "v.0", name: "v", type: DYN, mutable: false },
        { id: "out.0", name: "out", type: outT, mutable: false },
      ],
      body,
      loc,
    };
  }
