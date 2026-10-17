import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  isJsonStringifyDynamicType,
  BOOL,
  DYN,
  type IrExpr,
  STRING,
  type SrcLoc,
  canBoxFuncIntoDyn,
  isUnitType,
} from "../../../ir/ir.js";
import { optionalStringTags } from "./arguments.js";

/** JSON parse produces checked-dynamic data; a native reviver walks it
 * bottom-up before any checked cast. Stringify without a callback keeps
 * its type-directed fast path. A function or array replacer boxes the input
 * and walks it before primitive normalization. Both paths share literal gap
 * rules, and callback failures use ordinary native exception unwinding. */
export function lowerJsonMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "JSON");
  if (member === null) return null;
  const loc = locOf(call);
  if (
    (member === "parse" && (call.arguments.length < 1 || call.arguments.length > 2)) ||
    (member === "stringify" && call.arguments.length > 3) ||
    call.arguments.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `JSON.${member} with extra or spread arguments`,
      call,
      "pass the JSON arguments explicitly",
    );
  }
  if (member === "parse") {
    const text = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    const reviver = call.arguments[1];
    if (!reviver || jsonNullishArgument(lowerer, reviver)) {
      return { kind: "libCall", fn: "json.parse", args: [text], type: DYN, loc };
    }
    const callback = lowerJsonCallback(lowerer, reviver, "reviver");
    return { kind: "libCall", fn: "json.parseReviver", args: [text, callback], type: DYN, loc };
  }
  if (member === "stringify") {
    const replacerNode = call.arguments[1];
    const spaceNode = call.arguments[2];
    const runtimeOptions =
      (replacerNode &&
        !jsonNullishArgument(lowerer, replacerNode) &&
        lowerer.mapTypeOf(lowerer.typeOf(replacerNode))?.kind === "dyn") ||
      (spaceNode &&
        !jsonNullishArgument(lowerer, spaceNode) &&
        !ts.isNumericLiteral(spaceNode) &&
        !ts.isStringLiteral(spaceNode) &&
        !ts.isNoSubstitutionTemplateLiteral(spaceNode) &&
        !(ts.isPrefixUnaryExpression(spaceNode) && ts.isNumericLiteral(spaceNode.operand)));
    if (runtimeOptions && call.arguments[0]) {
      const args = [0, 1, 2].map((index) =>
        call.arguments[index]
          ? lowerer.lowerExprExpecting(call.arguments[index]!, DYN)
          : dynUndefinedExpr(loc),
      );
      return { kind: "libCall", fn: "json.stringifyValue", args, type: DYN, loc };
    }
    const indent = stringifySpaceIndent(lowerer, call);
    if (call.arguments.length === 0) {
      return lowerer.wrappedUndefined(lowerer.withUndefinedArm(STRING), loc)!;
    }
    const argNode = call.arguments[0]!;
    let value = lowerer.lowerExpr(argNode);
    // Optional Map/array reads and partially narrowed unions keep their
    // storage representation when lowered as ordinary arguments. Select
    // the JSON walker from the proven use-site type, using a checked
    // conversion so a stale capture cannot read an impossible payload.
    // Optional strings have a serializer that preserves a missing root;
    // an unchecked array read can still be absent despite its checker type.
    // A json-safe union already stringifies each arm. Date.toJSON is
    // `string` to the checker and `string | null` at runtime; narrowing
    // that null arm away throws before Node can print null.
    if (
      value.type.kind === "union" &&
      optionalStringTags(lowerer, value.type) === null &&
      !lowerer.jsonStringifySafe(value.type)
    ) {
      const narrowed = lowerer.mapTypeOf(lowerer.typeOf(argNode));
      if (narrowed && !isUnitType(narrowed) && narrowed.kind !== "void") {
        const helper =
          narrowed.kind === "union"
            ? lowerer.narrowedRetagHelper(argNode, value.type.unionId, narrowed.unionId, loc)
            : lowerer.narrowedArmHelper(value.type.unionId, narrowed, loc);
        if (helper) value = { kind: "call", callee: helper, args: [value], type: narrowed, loc };
      }
    }
    const replacer = call.arguments[1];
    if (replacer && !jsonNullishArgument(lowerer, replacer)) {
      const callback = lowerJsonCallback(lowerer, replacer, "replacer");
      if (value.type.kind === "undefinedT" || value.type.kind === "nullT")
        value = lowerer.coerceToExpected(value, DYN);
      // Evaluate the original arguments before taking a typed snapshot.
      // Creating the callback can itself mutate the input object.
      const inputSlot = lowerer.declareHiddenLocal("%jsonInput", value.type);
      const callbackSlot = lowerer.declareHiddenLocal("%jsonCallback", DYN);
      const boxed = lowerer.coerceToExpected(varRef(inputSlot.id, value.type, loc), DYN);
      if (boxed.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify callback input of type '${lowerer.fmt(value.type)}' (the value must cross the checked-dynamic boundary)`,
        );
      }
      const raw: IrExpr = {
        kind: "libCall",
        fn: "json.stringifyReplacer",
        args: [
          boxed,
          varRef(callbackSlot.id, DYN, loc),
          { kind: "strLit", value: indent, type: STRING, loc },
        ],
        type: DYN,
        loc,
      };
      // A replacer can omit even the root. Preserve actual undefined;
      // an inferred binding adopts this union, while a required string
      // consumer uses the ordinary checked optional-value boundary.
      const result: IrExpr = {
        kind: "dynCheck",
        value: raw,
        type: lowerer.withUndefinedArm(STRING),
        loc,
      };
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: inputSlot.id, init: value, loc },
          { kind: "varDecl", localId: callbackSlot.id, init: callback, loc },
        ],
        result,
        type: result.type,
        loc,
      };
    }
    const optionalString = lowerOptionalStringifyRoot(lowerer, value, indent, loc);
    if (optionalString) return optionalString;
    if (
      value.type.kind === "url" ||
      value.type.kind === "dyn" ||
      isJsonStringifyDynamicType(
        value.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      // Keep the original containers live while the runtime visits them:
      // a toJSON callback can mutate a later field, and shared/cyclic
      // references must retain their identities throughout traversal.
      const boxed: IrExpr =
        value.type.kind === "dyn"
          ? value
          : {
              kind: "dynFrom",
              value,
              ...(value.type.kind === "url" ? {} : { liveRef: true }),
              type: DYN,
              loc,
            };
      const raw: IrExpr = {
        kind: "libCall",
        fn: "json.stringifyReplacer",
        args: [boxed, dynUndefinedExpr(loc), { kind: "strLit", value: indent, type: STRING, loc }],
        type: DYN,
        loc,
      };
      // Preserve the existing dyn-root string ABI, including its textual
      // "undefined" result, while letting the runtime honor toJSON hooks.
      return value.type.kind === "dyn"
        ? { kind: "toString", operand: raw, type: STRING, loc }
        : { kind: "dynCheck", value: raw, type: lowerer.withUndefinedArm(STRING), loc };
    }

    if (!lowerer.jsonStringifySafe(value.type)) {
      // Bare undefined-armed unions get their own wording: Node's
      // stringify of bare undefined is not a string at all — per-type
      // serialization cannot match that exactly, so the fence is
      // deliberate, not a gap. (Undefined-armed RECORD FIELDS pass the
      // fence: the field drops from the output, exactly Node.)
      if (lowerer.bareUndefinedArmedUnion(value.type)) {
        lowerer.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify of '${lowerer.fmt(value.type)}' values ` +
            `(Node's stringify of bare undefined is not a string at all — ` +
            `narrow with '!== undefined' first, model absence with a null arm, ` +
            `or use an optional record field ('{ a?: string }'), which drops ` +
            `from the output like Node's)`,
        );
      }
      lowerer.unsupported(
        "SC1090",
        argNode,
        `JSON.stringify of '${lowerer.fmt(value.type)}' values ` +
          `(only number, string, boolean, records, arrays, unions of those, and 'unknown' stringify)`,
      );
    }
    const node: IrExpr = { kind: "jsonStringify", value, type: STRING, loc };
    if (indent !== "") node.indent = indent;
    return node;
  }
  return null; // unknown members are tsc errors before lowering
}

function lowerOptionalStringifyRoot(
  lowerer: Lowerer,
  value: IrExpr,
  indent: string,
  loc: SrcLoc,
): IrExpr | null {
  const tags = optionalStringTags(lowerer, value.type);
  if (!tags || value.type.kind !== "union") return null;
  const resultT = lowerer.withUndefinedArm(STRING);
  const key = `json.optionalString:${value.type.unionId}:${JSON.stringify(indent)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = `%json.optionalString.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, helper);
    const input = varRef("value.0", value.type, loc);
    const serialized: IrExpr = {
      kind: "jsonStringify",
      value: {
        kind: "unionNarrow",
        unionId: value.type.unionId,
        tag: tags.stringTag,
        value: input,
        type: STRING,
        loc,
      },
      type: STRING,
      loc,
    };
    if (indent !== "") serialized.indent = indent;
    const missing = lowerer.wrappedUndefined(resultT, loc);
    if (!missing)
      throw new InternalCompilerError("optional JSON.stringify result needs an undefined arm");
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: value.type }],
      returnType: resultT,
      locals: [{ id: "value.0", name: "value", type: value.type, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: value.type.unionId,
            tag: tags.undefinedTag,
            negated: false,
            value: input,
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: missing, loc }],
          else_: null,
          loc,
        },
        { kind: "return", value: lowerer.coerceToExpected(serialized, resultT), loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: resultT, loc };
}

/** Only explicit null/undefined select the no-callback path. */
function jsonNullishArgument(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return jsonNullishArgument(lowerer, node.expression);
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (!ts.isIdentifier(node) || node.text !== "undefined") return false;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  return (
    symbol !== undefined &&
    lowerer.checker
      .declarationsOf(symbol)
      .every((decl) => lowerer.isStdlibFile(decl.getSourceFile()))
  );
}

/** JSON callbacks cross the same checked native function boundary as other
 * runtime callbacks. Reviver source contexts need parser source tracking;
 * refuse signatures that request one until that protocol is implemented.
 * A replacer may also be an array of property names, which the runtime
 * reads as Node's PropertyList. */
function lowerJsonCallback(
  lowerer: Lowerer,
  node: ts.Expression,
  role: "replacer" | "reviver",
): IrExpr {
  const callback = lowerer.lowerExpr(node);
  if (callback.type.kind === "dyn") return callback;
  if (
    role === "replacer" &&
    callback.type.kind === "array" &&
    lowerer.dynConvertible(callback.type)
  )
    return lowerer.coerceToExpected(callback, DYN);
  if (
    callback.type.kind === "union" &&
    lowerer.dynConvertible(callback.type) &&
    lowerer.unions
      .get(callback.type.unionId)
      ?.arms.every(
        (arm) =>
          isUnitType(arm) ||
          (role === "replacer" && arm.kind === "array") ||
          (arm.kind === "func" &&
            arm.params.length <= 2 &&
            (role !== "reviver" || (!arm.rest && !arm.argumentsAll))),
      )
  )
    return lowerer.coerceToExpected(callback, DYN);
  if (
    callback.type.kind === "func" &&
    callback.type.params.length <= 2 &&
    (role !== "reviver" || (!callback.type.rest && !callback.type.argumentsAll)) &&
    canBoxFuncIntoDyn(
      callback.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { kind: "dynFrom", value: callback, type: DYN, loc: locOf(node) };
  }
  lowerer.noLowering(
    `JSON ${role} of type '${lowerer.fmt(callback.type)}'`,
    node,
    role === "replacer"
      ? "use a native function taking key and value, or an array of property names"
      : "use a native function taking key and value; reviver source contexts are not supported yet",
  );
}

/** Compile-time Node gap rules: numbers clamp to 0–10 spaces and strings
 * truncate to ten UTF-16 code units. Callback validation is independent. */
function stringifySpaceIndent(lowerer: Lowerer, call: ts.CallExpression): string {
  const fence = (): never =>
    lowerer.noLowering(
      "JSON.stringify with replacer/space parameters",
      call,
      "the serializer is type-directed — shape the value before stringifying",
    );
  if (call.arguments.length <= 1) return "";
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
  const isUndefined = (e: ts.Expression): boolean => jsonNullishArgument(lowerer, e);
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
  throw new InternalCompilerError("unreachable"); // fence() never returns
}

/** Stored stringify uses the same native serializer and keeps omitted roots
 * as undefined. Other JSON method values retain a named refusal. */
export function lowerJsonProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(expr, "JSON");
  if (member === null) return null;
  if (member === "stringify") {
    const loc = locOf(expr);
    const name = "%builtin.JSON.stringify";
    if (!lowerer.builtinCallableValueFns.has(name)) {
      lowerer.builtinCallableValueFns.set(name, name);
      const params = ["value", "replacer", "space"].map((name) => ({
        localId: name,
        name,
        type: DYN,
      }));
      lowerer.liftedFns.push({
        name,
        params,
        returnType: DYN,
        locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "json.stringifyValue",
              args: params.map((p) => varRef(p.localId, DYN, loc)),
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      });
    }
    return {
      kind: "dynFrom",
      value: {
        kind: "closure",
        fnName: name,
        captures: [],
        type: { kind: "func", params: [DYN, DYN, DYN], ret: DYN },
        loc,
      },
      fnName: "stringify",
      type: DYN,
      loc,
    };
  }
  lowerer.unsupported("SC1090", expr, `JSON methods as values (call '${member}' directly)`);
}
