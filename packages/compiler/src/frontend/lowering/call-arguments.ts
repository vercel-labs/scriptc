import { keyedHelperName } from "./stable-names.js";
import { forwardedTupleType, pureForwardedValues, stripTypeWrappers } from "./typed-arguments.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import { AstNode } from "../ts7/ast-node.js";
import type { Lowerer } from "./lowerer.js";
import {
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  canDynCheckTo,
  typeEquals,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "./optional-arguments.js";
import { checkedIterableSpread } from "./checked-iterable-spread.js";
import { type ParamShape } from "./call-signatures.js";
import { arrayValueRead, arrayValueType } from "./array-values.js";
import { buildArrayConversion } from "./coercions/builders.js";
import { restTupleElementTypes, typeKey } from "../type-mapper.js";

function fixedTupleSpreadInfo(
  lowerer: Lowerer,
  node: ts.Expression,
): { type: IrType & { kind: "record" }; fields: { name: string; type: IrType }[] } | null {
  const type = forwardedTupleType(lowerer, node) ?? lowerer.mapTypeOf(lowerer.typeOf(node));
  if (type?.kind !== "record") return null;
  const shape = lowerer.shapes.get(type.shapeId);
  if (!shape?.tuple || shape.fields.length === 0) return null;
  return {
    type,
    fields: [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name)),
  };
}

/** `...t` over a provably EMPTY tuple bound to a plain name (`[]`, a rest
 * tuple whose type parameter or `Parameters<F>` resolved to no positions):
 * it contributes no arguments, and reading the name has no effect. */
function emptyTupleSpread(lowerer: Lowerer, node: ts.Expression): boolean {
  let operand = node;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (!ts.isIdentifier(operand)) return false;
  const forwarded = forwardedTupleType(lowerer, operand);
  if (forwarded) return forwarded.kind === "array";
  return restTupleElementTypes(lowerer.typeOf(operand), lowerer.typeCtx)?.length === 0;
}

/** A call's arguments as one checked-dynamic array, built in source order
 * into a fresh hidden local: each argument converts to dyn, and a spread
 * contributes the values its iteration yields (holes as undefined).
 * `lowerSpread` lowers a spread's operand; the default lowers it here. */
export function dynArgumentPack(
  lowerer: Lowerer,
  argNodes: readonly ts.Expression[],
  loc: SrcLoc,
  options: {
    /** Pre-lowered values pushed before the arguments. */
    leading?: readonly IrExpr[] | undefined;
    blame?: ts.Node | undefined;
    lowerSpread?: (arg: ts.SpreadElement) => IrExpr;
  } = {},
): { stmts: IrStmt[]; pack: () => IrExpr } {
  const blame = options.blame ?? argNodes[0]!;
  const lowerSpread =
    options.lowerSpread ?? ((arg: ts.SpreadElement) => lowerer.lowerExpr(arg.expression));
  const pack = lowerer.declareHiddenLocal("%spreadArgs", DYN);
  const ref = (): IrExpr => ({ kind: "varRef", localId: pack.id, type: DYN, loc });
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: pack.id,
      init: { kind: "dynArrLit", elems: [], type: DYN, loc },
      loc,
    },
  ];
  const push = (value: IrExpr, fn: "dyn.packPush" | "dyn.packPushSpreadIter") => {
    stmts.push({
      kind: "exprStmt",
      expr: { kind: "libCall", fn, args: [ref(), value], type: VOID, loc: value.loc },
      loc: value.loc,
    });
  };
  for (const value of options.leading ?? [])
    push(lowerer.coerceInto(blame, value, DYN), "dyn.packPush");
  const spreads = argNodes.filter(ts.isSpreadElement).length;
  argNodes.forEach((arg, index) => {
    if (!ts.isSpreadElement(arg)) {
      push(lowerer.lowerExprExpecting(arg, DYN), "dyn.packPush");
      return;
    }
    let value = lowerSpread(arg);
    if (value.type.kind === "set") {
      value = {
        kind: "setIntrinsic",
        method: "toArray",
        receiver: value,
        args: [],
        type: arrayOf(value.type.elem),
        loc: value.loc,
      };
    } else if (value.type.kind === "object") {
      value = lowerer.classIteratorDrainCall(value, locOf(arg)) ?? value;
    }
    if (value.type.kind === "array") {
      // Argument iteration materializes holes as present undefined
      // before conversion to the dense checked-dynamic argument pack.
      value = {
        kind: "arrayLit",
        elems: [value],
        spreads: [0],
        type: value.type,
        loc: value.loc,
      };
    }
    value = checkedIterableSpread(lowerer, value, ts.getTextOfNode(arg.expression), loc);
    if (spreads === 1 && index === argNodes.length - 1) {
      stmts.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.packPushSpread",
          args: [
            ref(),
            value,
            { kind: "strLit", value: ts.getTextOfNode(arg.expression), type: STRING, loc },
          ],
          type: VOID,
          loc,
        },
        loc,
      });
    } else push(value, "dyn.packPushSpreadIter");
  });
  return { stmts, pack: ref };
}

export function completeArgs(
  lowerer: Lowerer,
  argNodes: readonly ts.Expression[],
  shapes: readonly ParamShape[],
  loc: SrcLoc,
  blame: ts.Node,
  /** Pre-lowered values virtually PREPENDED to the argument list — the
   * tagged-template strings object, which has no ts.Expression to lower
   * (lowerTaggedTemplate builds it). Each rides the same slot-directed
   * coercion an ordinary argument gets (coerceInto against its shape,
   * DYN conversion in a dyn rest, element coercion in a typed rest). */
  leading?: readonly IrExpr[],
): IrExpr[] {
  // Conversion eligibility can traverse the whole recursive parameter
  // graph. Ordinary calls and fixed tuples never need that analysis.
  const runtimeSpreads = argNodes.filter(
    (arg): arg is ts.SpreadElement =>
      ts.isSpreadElement(arg) &&
      !fixedTupleSpreadInfo(lowerer, arg.expression) &&
      !emptyTupleSpread(lowerer, arg.expression),
  );
  // Spread operands lowered while choosing the completion, each exactly once.
  const loweredSpreads = new Map<ts.Expression, IrExpr>();
  const lowerSpread = (arg: ts.SpreadElement): IrExpr =>
    loweredSpreads.get(arg) ?? lowerer.lowerExpr(arg.expression);
  if (
    runtimeSpreads.length > 0 &&
    canCompleteRuntimeSpread(lowerer, shapes) &&
    !spreadsFillTypedRest(
      lowerer,
      shapes,
      argNodes,
      leading?.length ?? 0,
      runtimeSpreads,
      loweredSpreads,
    )
  ) {
    // Runtime-length spreads determine the complete argument list before
    // any parameter default runs. Build it once in source order, then
    // extract the fixed native ABI slots; missing elements are undefined.
    const { stmts, pack: ref } = dynArgumentPack(lowerer, argNodes, loc, {
      leading,
      blame,
      lowerSpread,
    });
    const args = shapes.map((shape, index): IrExpr => {
      if (shape.mode === "arguments") return ref();
      const value: IrExpr =
        shape.mode === "rest" || shape.mode === "dynRest"
          ? {
              kind: "dynInvoke",
              recv: ref(),
              method: "slice",
              calleeName: "arguments.slice",
              args: [
                {
                  kind: "dynFrom",
                  value: { kind: "numLit", value: index, type: F64, loc },
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            }
          : {
              kind: "dynKeyGet",
              value: ref(),
              key: { kind: "strLit", value: String(index), type: STRING, loc },
              type: DYN,
              loc,
            };
      return lowerer.coerceInto(blame, value, shape.type);
    });
    // Every supported form has at least one native slot to carry the
    // evaluation prefix, including calls whose only slot is their rest.
    args[0] = { kind: "seqExpr", stmts, result: args[0]!, type: args[0]!.type, loc };
    return args;
  }
  type ArgSource = ts.Expression | { ir: IrExpr };
  const isIr = (s: ArgSource | undefined): s is { ir: IrExpr } =>
    s !== undefined && !(s instanceof AstNode);
  const sources: ArgSource[] = leading?.map((ir) => ({ ir })) ?? [];
  for (const arg of argNodes) {
    if (!ts.isSpreadElement(arg)) {
      sources.push(arg);
      continue;
    }
    if (emptyTupleSpread(lowerer, arg.expression)) continue;
    const pure = pureForwardedValues(lowerer, arg.expression);
    if (pure) {
      for (const value of pure) sources.push({ ir: value });
      continue;
    }
    const tuple = fixedTupleSpreadInfo(lowerer, arg.expression);
    if (!tuple) {
      sources.push(arg);
      continue;
    }
    // A fixed tuple has a compile-time argument count, so flatten it into
    // the callee's ordinary positional ABI. The operand itself still
    // evaluates exactly once and at the spread's source-order position:
    // the first extracted field carries a seqExpr that initializes one
    // hidden tuple local, and every later field reads that same local.
    // Tuple fields are owned reads, so the call receives the same +1
    // values as separately written arguments while the saved tuple stays
    // alive through the call.
    const spreadLoc = locOf(arg);
    // A forwarded tuple seen through type assertions (`...(arguments as
    // unknown as Parameters<F>)`) spreads the tuple itself.
    const operand =
      forwardedTupleType(lowerer, arg.expression) !== null
        ? stripTypeWrappers(arg.expression)
        : arg.expression;
    const value = lowerer.coerceInto(arg.expression, lowerer.lowerExpr(operand), tuple.type);
    const saved = lowerer.declareHiddenLocal("%callSpread", tuple.type);
    const savedRef = (): IrExpr => ({
      kind: "varRef",
      localId: saved.id,
      type: tuple.type,
      loc: spreadLoc,
    });
    tuple.fields.forEach((field, i) => {
      const read: IrExpr = {
        kind: "recordGet",
        obj: savedRef(),
        shapeId: tuple.type.shapeId,
        field: field.name,
        type: field.type,
        loc: spreadLoc,
      };
      sources.push({
        ir:
          i === 0
            ? {
                kind: "seqExpr",
                stmts: [{ kind: "varDecl", localId: saved.id, init: value, loc: spreadLoc }],
                result: read,
                type: field.type,
                loc: spreadLoc,
              }
            : read,
      });
    });
  }
  const restAt = shapes.findIndex(
    (s) => s.mode === "rest" || s.mode === "dynRest" || s.mode === "arguments",
  );
  const positional = restAt >= 0 ? shapes.slice(0, restAt) : [...shapes];
  if (restAt >= 0 && shapes[restAt]!.mode === "arguments") {
    // JS `arguments` contains every supplied value, including fixed
    // parameters. Store each call expression once, in source order, so
    // both the native parameter slots and the full array read it.
    const stmts: IrStmt[] = [];
    const passed: IrExpr[] = sources.map((source, i) => {
      if (!isIr(source) && ts.isSpreadElement(source)) {
        lowerer.unsupported(
          "SC1090",
          source,
          "spread arguments into fixed parameter positions (a spread can only fill a rest parameter)",
        );
      }
      const slotType = i < restAt ? positional[i]!.type : DYN;
      let value: IrExpr;
      if (isIr(source)) {
        let ir = source.ir;
        // Tuple-spread storage also feeds later arguments. Declare it in
        // this shared sequence, not inside one argument's initializer,
        // whose statement frame ends before the next field is read.
        if (ir.kind === "seqExpr") {
          stmts.push(...ir.stmts);
          ir = ir.result;
        }
        value = lowerer.coerceInto(blame, ir, slotType);
      } else value = lowerer.lowerExprExpecting(source, slotType);
      const saved = lowerer.declareHiddenLocal("%callArg", slotType);
      stmts.push({ kind: "varDecl", localId: saved.id, init: value, loc: value.loc });
      return { kind: "varRef", localId: saved.id, type: slotType, loc: value.loc };
    });
    const fixed = positional.map((shape, i): IrExpr => {
      if (i < passed.length) return passed[i]!;
      if (shape.mode === "omittable" || lowerer.bareUndefinedArmedUnion(shape.type))
        return shape.callDefault ?? lowerer.undefinedArgFor(shape.type, loc, blame);
      if (shape.type.kind === "dyn") return dynUndefinedExpr(loc);
      lowerer.unsupported("SC1090", blame, "this call form");
    });
    const elems = passed.map((value) => lowerer.coerceInto(blame, value, DYN));
    const full: IrExpr = { kind: "dynArrLit", elems, type: DYN, loc };
    const out = [...fixed, full];
    if (stmts.length > 0) {
      out[0] = { kind: "seqExpr", stmts, result: out[0]!, type: out[0]!.type, loc };
    }
    return out;
  }
  const out: IrExpr[] = positional.map((shape, i) => {
    const src = sources[i];
    if (isIr(src)) return lowerer.coerceInto(blame, src.ir, shape.type);
    const arg = src;
    if (arg && ts.isSpreadElement(arg)) {
      // A spread landing on FIXED parameter positions would need the
      // array's length to decide arity at runtime — the compile-time
      // completion has no home for that. Spreads fill REST slots only.
      lowerer.unsupported(
        "SC1090",
        arg,
        "spread arguments into fixed parameter positions (a spread can only fill a rest parameter)",
      );
    }
    if (arg) {
      let operand = arg;
      while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
      if (ts.isVoidExpression(operand)) {
        const absent = omittedArgFor(lowerer, shape.type, loc);
        const effect = lowerStaticallyUndefinedArgument(lowerer, operand);
        if (absent && effect) return defaultAfterUndefined(effect, absent);
      }
      return lowerer.lowerExprExpecting(arg, shape.type);
    }
    if (shape.mode !== "omittable" && !lowerer.bareUndefinedArmedUnion(shape.type)) {
      // A missing argument for a CHECKED-DYNAMIC param (an implicit-any
      // JS signature called short — `mustCall(fn)` with `expected`
      // omitted): JS fills undefined, and the dyn slot holds exactly
      // that — the undefined dyn value. tsc's arity families don't gate
      // .js builds (SEMANTICS.md 116), so the completion lands here.
      if (shape.type.kind === "dyn") {
        return dynUndefinedExpr(loc);
      }
      // tsc's arity checking admits omitting only the omittable suffix;
      // reaching here means a call form we don't model — defensive.
      lowerer.unsupported("SC1090", blame, "this call form");
    }
    if (shape.callDefault) return shape.callDefault;
    return lowerer.undefinedArgFor(shape.type, loc, blame);
  });
  if (restAt >= 0 && shapes[restAt]!.mode === "dynRest") {
    // The VARIADIC dyn pack (a JS `...args` with no static element
    // type, or the synthetic `arguments` slot): surplus arguments
    // convert through the dyn boundary into one fresh dyn array —
    // exactly what the boxed call thunk builds for indirect calls.
    const elems = sources.slice(restAt).map((a): IrExpr => {
      if (isIr(a)) return lowerer.coerceInto(blame, a.ir, DYN);
      if (ts.isSpreadElement(a)) {
        lowerer.unsupported("SC1090", a, "spread arguments into a dynamic rest parameter");
      }
      return lowerer.lowerExprExpecting(a, DYN);
    });
    out.push({ kind: "dynArrLit", elems, type: DYN, loc });
  } else if (restAt >= 0) {
    const restType = shapes[restAt]!.type;
    // A TUPLE-typed rest (`(...[x, y]: [number, number])` — the pattern
    // rest form): tsc pins the call to exactly the tuple's arity, so
    // the pack is a positional record literal. Spreads stay fenced —
    // their length is a runtime fact the fixed shape cannot take.
    if (restType.kind === "record") {
      const tupleShape = lowerer.shapes.get(restType.shapeId);
      if (tupleShape?.tuple) {
        const rest = sources.slice(restAt);
        if (
          rest.some((a) => !isIr(a) && ts.isSpreadElement(a)) ||
          rest.length !== tupleShape.fields.length
        ) {
          lowerer.unsupported(
            "SC1090",
            blame,
            "spread or arity-mismatched arguments into a tuple-typed rest parameter",
          );
        }
        out.push({
          kind: "recordLit",
          fields: rest.map((a, i) => {
            const f = tupleShape.fields.find((x) => x.name === String(i))!;
            return {
              name: f.name,
              value: isIr(a)
                ? lowerer.coerceInto(blame, a.ir, f.type)
                : lowerer.lowerExprExpecting(a, f.type),
            };
          }),
          type: restType,
          loc,
        });
        return out;
      }
    }
    if (restType.kind !== "array") lowerer.unsupported("SC1090", blame, "this call form");
    // The rest pack is a fresh array per call; surplus SPREADS copy
    // their elements in (JS-exact — `f(a, ...xs, b, ...ys)` packs in
    // order, sources untouched).
    const spreads: number[] = [];
    const elems = sources.slice(restAt).map((a, i) => {
      if (isIr(a)) return lowerer.coerceInto(blame, a.ir, restType.elem);
      if (ts.isSpreadElement(a)) {
        let src = lowerSpread(a);
        // A `T[]` into a `(T | undefined)[]` rest: read every element as JS
        // does, holes and present undefined as undefined.
        const lift = holeReadingLift(lowerer, src.type, restType, loc);
        if (lift) src = { kind: "call", callee: lift, args: [src], type: restType, loc: src.loc };
        // A same-element Set spread drains first (setIntrinsic toArray).
        if (src.type.kind === "set" && typeEquals(src.type.elem, restType.elem)) {
          src = {
            kind: "setIntrinsic",
            method: "toArray",
            receiver: src,
            args: [],
            type: arrayOf(src.type.elem),
            loc: locOf(a),
          };
        }
        // A CLASS ITERABLE spread (`foo(...new SymbolIterator)`) drains
        // through its protocol into a fresh array (classIteratorDrainCall).
        if (src.type.kind === "object") {
          const drained = lowerer.classIteratorDrainCall(src, locOf(a), restType.elem);
          if (drained) src = drained;
        }
        // Same-family arrays whose element lifts reshape through the
        // interned width helper (the array-literal spread rule).
        if (src.type.kind === "array" && !typeEquals(src.type, restType)) {
          const w = lowerer.widthCoerce(src, restType);
          if (w) src = w;
        }
        if (!typeEquals(src.type, restType)) {
          lowerer.unsupported(
            "SC1090",
            a,
            `spreading '${lowerer.fmt(src.type)}' into a '${lowerer.fmt(restType)}' rest parameter (only a same-element-type array spreads)`,
          );
        }
        spreads.push(i);
        return src;
      }
      return lowerer.lowerExprExpecting(a, restType.elem);
    });
    out.push({
      kind: "arrayLit",
      elems,
      ...(spreads.length > 0 ? { spreads } : {}),
      type: restType,
      loc,
    });
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
    // completion, so it fences by name rather than being skipped without a diagnostic.
    for (let i = positional.length; i < sources.length; i++) {
      const a = sources[i]!;
      if (isIr(a)) continue; // pre-lowered leading values are effect-free
      if (ts.isSpreadElement(a)) {
        lowerer.unsupported(
          "SC1090",
          a,
          "spread arguments into fixed parameter positions (a spread can only fill a rest parameter)",
        );
      }
      const v = lowerer.lowerExpr(a);
      if (!isSafeToDiscard(v)) {
        lowerer.unsupported(
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
export function wrappedUndefined(lowerer: Lowerer, type: IrType, loc: SrcLoc): IrExpr | null {
  const unit: IrExpr = { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
  const wrapped = lowerer.coerceToExpected(unit, type);
  return wrapped.kind === "unionWrap" ? wrapped : null;
}

/** The synthesized argument for an omitted omittable param: the interned
 * undefined arm of the param's `T | undefined` ABI union, or the checked-dynamic tree
 * undefined for a checked-dynamic param (`bar?: any`). */

export function omittedArgFor(lowerer: Lowerer, type: IrType, loc: SrcLoc): IrExpr | null {
  if (type.kind === "dyn") return dynUndefinedExpr(loc);

  return lowerer.wrappedUndefined(type, loc);
}

/** Complete an indirect static call against its func value ABI. Ordinary
 * fixed-width values retain the historical optional-suffix completion.
 * Typed-rest values reinterpret their final array slot as a rest ParamShape
 * and reuse completeArgs, including fixed-tuple and same-element array
 * spreads with source-order/evaluate-once semantics. */
export function completeFuncValueArgs(
  lowerer: Lowerer,
  call: ts.CallExpression,
  funcType: IrType & { kind: "func" },
  loc: SrcLoc,
): IrExpr[] {
  if (funcType.rest === true && funcType.restAbi === "typed") {
    const rest = funcType.params[funcType.params.length - 1];
    if (!rest || rest.kind !== "array") {
      throw new InternalCompilerError("typed-rest function value has no trailing array ABI slot");
    }
    const shapes: ParamShape[] = funcType.params.slice(0, -1).map((type) => ({
      type,
      mode: omittedArgFor(lowerer, type, loc) ? "omittable" : "required",
    }));
    shapes.push({ type: rest, mode: "rest" });
    return completeArgs(lowerer, call.arguments.nodes, shapes, loc, call);
  }
  // A fixed-tuple spread (`fn(...args)` over a tuple-typed rest binding)
  // has a compile-time arity: completion flattens it into the positional
  // slots exactly like a direct call's.
  if (
    funcType.rest !== true &&
    call.arguments.nodes.some(ts.isSpreadElement) &&
    call.arguments.nodes.every(
      (arg) =>
        !ts.isSpreadElement(arg) ||
        fixedTupleSpreadInfo(lowerer, arg.expression) !== null ||
        emptyTupleSpread(lowerer, arg.expression),
    )
  ) {
    const shapes: ParamShape[] = funcType.params.map((type) => ({
      type,
      mode: omittedArgFor(lowerer, type, loc) ? "omittable" : "required",
    }));
    return completeArgs(lowerer, call.arguments.nodes, shapes, loc, call);
  }
  const args = call.arguments.nodes.map((arg, index) =>
    lowerer.lowerExprExpecting(arg, funcType.params[index]),
  );
  // Effect-free surplus arguments of a fixed-arity value (`(r: void) =>
  // void` drops its void slot) evaluate to nothing observable: drop them,
  // as the callee ignores them.
  while (
    funcType.rest !== true &&
    args.length > funcType.params.length &&
    isSafeToDiscard(args[args.length - 1]!)
  ) {
    args.pop();
  }
  for (let i = args.length; i < funcType.params.length; i++) {
    const absent = omittedArgFor(lowerer, funcType.params[i]!, loc);
    if (!absent) {
      lowerer.unsupported(
        "SC1090",
        call,
        "calls omitting a non-optional parameter of the callee's type",
      );
    }
    args.push(absent);
  }
  return args;
}

export function undefinedArgFor(
  lowerer: Lowerer,
  type: IrType,
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr {
  if (type.kind === "dyn") return dynUndefinedExpr(loc);

  const wrapped = lowerer.wrappedUndefined(type, loc);
  if (!wrapped) {
    // Omittable params always carry an undefined-armed union (paramShape
    // guarantees it) — defensive.
    lowerer.unsupported("SC1090", blame, "this call form");
  }
  return wrapped;
}

export function lowerSpreadArgsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  callee: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  // TypeScript reaches this lane only for checked-dynamic variadic callees
  // (`(...args: unknown[]) => R`), whose ABI is the JS one.
  if (
    !isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    !(callee.type.kind === "func" && callee.type.rest === true && callee.type.restAbi === undefined)
  )
    return null;
  if (!expr.arguments.nodes.some((a) => ts.isSpreadElement(a))) return null;
  if (callee.type.kind !== "dyn" && callee.type.kind !== "func") return null;
  const calleeName =
    ts.isPropertyAccessExpression(expr.expression) || ts.isElementAccessExpression(expr.expression)
      ? ts.getTextOfNode(expr.expression)
      : ts.isIdentifier(expr.expression)
        ? expr.expression.text
        : "value";
  // Lower every argument ONCE, in source order (the IR nests them in
  // exactly this order, so runtime evaluation order is JS's).
  const parts = expr.arguments.nodes.map((a) =>
    ts.isSpreadElement(a)
      ? { spreadOf: a.expression, node: null, v: lowerer.lowerExpr(a.expression) }
      : { spreadOf: null, node: a as ts.Expression, v: lowerer.lowerExpr(a) },
  );
  const spreadParts = parts.filter((p) => p.spreadOf !== null);
  const getR = (id: string) => lowerer.shapes.get(id);
  const getU = (id: string) => lowerer.unions.get(id);
  const anyJsvalSpread = spreadParts.some((_p) => false);
  if (
    !anyJsvalSpread &&
    (callee.type.kind === "dyn" ||
      (callee.type.kind === "func" && canBoxFuncIntoDyn(callee.type, getR, getU))) &&
    spreadParts.every((p) => p.v.type.kind === "dyn" || canConvertToDyn(p.v.type, getR, getU))
  ) {
    const args: IrExpr[] = [];
    const spreads: { arg: number; what: string }[] = [];
    for (const p of parts) {
      if (p.spreadOf !== null) {
        // The spelling rides along for V8's nullish spread-call
        // TypeError ("v is not iterable (cannot read property ...)").
        spreads.push({ arg: args.length, what: ts.getTextOfNode(p.spreadOf) });
        args.push(checkedIterableSpread(lowerer, p.v, ts.getTextOfNode(p.spreadOf), loc));
      } else {
        args.push(lowerer.coerceInto(p.node!, p.v, DYN));
      }
    }
    const boxed =
      callee.type.kind === "dyn" ? callee : lowerer.coerceInto(expr.expression, callee, DYN);
    return { kind: "dynCall", callee: boxed, calleeName, args, spreads, type: DYN, loc };
  }
  // No native spread-call form fits. Arguments are already lowered, so
  // falling back to the historical
  // per-site fences would lower them a second time (duplicate lambda
  // lifts, duplicated diagnostics).
  lowerer.unsupported("SC1090", expr, "spread arguments");
}

/** True when a spread argument lands where the compile-time completion
 * cannot take it — a FIXED parameter position, or a dynamic rest slot
 * (dynRest, whose packs are built per-argument): the shapes
 * the runtime-arity lane (lowerSpreadArgsCall) serves. Typed `rest`
 * slots keep completeArgs' same-element spread packing. */
export function spreadNeedsRuntimeArity(
  lowerer: Lowerer,
  shapes: readonly ParamShape[],
  argNodes: readonly ts.Expression[],
): boolean {
  const restAt = shapes.findIndex((s) => s.mode === "rest" || s.mode === "dynRest");
  let position = 0;
  for (const arg of argNodes) {
    if (ts.isSpreadElement(arg)) {
      const tuple = fixedTupleSpreadInfo(lowerer, arg.expression);
      if (tuple) {
        position += tuple.fields.length;
        continue;
      }
      if (restAt < 0 || position < restAt || shapes[restAt]!.mode !== "rest") {
        return !canCompleteRuntimeSpread(lowerer, shapes);
      }
    }
    position++;
  }
  return false;
}

/** True when every runtime-length spread only fills a typed rest with its
 * own array type, or a `T[]` into an argument-widened `(T | undefined)[]`
 * rest. The static completion then builds one fresh rest array and converts
 * no argument to a checked-dynamic value: boxing an instance would give its
 * class (and, through the generated property helpers, the classes it
 * references) a hidden property bag. Lowers the spread operands it checks
 * into `lowered`, so each is lowered exactly once. */
function spreadsFillTypedRest(
  lowerer: Lowerer,
  shapes: readonly ParamShape[],
  argNodes: readonly ts.Expression[],
  leading: number,
  runtimeSpreads: readonly ts.SpreadElement[],
  lowered: Map<ts.Expression, IrExpr>,
): boolean {
  const restAt = typedRestAfterSpreads(lowerer, shapes, argNodes, leading);
  const restType = restAt >= 0 ? shapes[restAt]!.type : null;
  if (restType?.kind !== "array") return false;
  for (const arg of runtimeSpreads) lowered.set(arg, lowerer.lowerExpr(arg.expression));
  return runtimeSpreads.every((arg) => {
    const type = lowered.get(arg)!.type;
    return typeEquals(type, restType) || canReadHolesInto(lowerer, type, restType);
  });
}

/** The index of the typed `rest` parameter when every runtime-length spread
 * lands in it (after the fixed positions), else -1. */
function typedRestAfterSpreads(
  lowerer: Lowerer,
  shapes: readonly ParamShape[],
  argNodes: readonly ts.Expression[],
  leading: number,
): number {
  const restAt = shapes.findIndex((s) => s.mode !== "required" && s.mode !== "omittable");
  if (restAt < 0 || shapes[restAt]!.mode !== "rest") return -1;
  let position = leading;
  for (const arg of argNodes) {
    if (ts.isSpreadElement(arg)) {
      const tuple = fixedTupleSpreadInfo(lowerer, arg.expression);
      if (tuple) {
        position += tuple.fields.length;
        continue;
      }
      if (position < restAt) return -1;
    }
    position++;
  }
  return restAt;
}

/** A `T[]` spread into a `(T | undefined)[]` rest, `T | undefined` being
 * exactly what a JS read of a `T[]` element yields. */
function canReadHolesInto(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (from.kind !== "array" || to.kind !== "array" || typeEquals(from, to)) return false;
  const elem = from.elem;
  if (elem.kind === "dyn") return false;
  return typeEquals(arrayValueType(lowerer, elem), to.elem);
}

/** The interned `%arr.holes.<n>` copy for canReadHolesInto pairs: spread
 * iteration reads holes and present undefined as undefined. Null for any
 * other pair. */
function holeReadingLift(lowerer: Lowerer, from: IrType, to: IrType, loc: SrcLoc): string | null {
  if (from.kind !== "array" || !canReadHolesInto(lowerer, from, to)) return null;
  const elem = from.elem;
  const key = `arr.holes:${typeKey(elem)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.holes", key);
  lowerer.valueHelpers.set(key, name);
  lowerer.liftedFns.push(
    buildArrayConversion(
      name,
      from,
      { kind: "arrayLit", elems: [], type: to, loc },
      (element, index, result) => ({
        kind: "arrIntrinsic",
        method: "push",
        receiver: result,
        args: [arrayValueRead(lowerer, sourceArray(element), index, elem, loc)],
        type: F64,
        loc,
      }),
      loc,
    ),
  );
  return name;
}

/** The array a buildArrayConversion element read indexes. */
function sourceArray(element: IrExpr): IrExpr {
  if (element.kind !== "arrayGet")
    throw new InternalCompilerError("array conversion element is not an array read");
  return element.arr;
}

function canCompleteRuntimeSpread(lowerer: Lowerer, shapes: readonly ParamShape[]): boolean {
  return (
    shapes.length > 0 &&
    shapes.every(
      (shape) =>
        shape.callDefault === undefined &&
        canDynCheckTo(
          shape.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        ),
    )
  );
}
