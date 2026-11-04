import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import {
  QS_PARSE_DOCUMENTED_OPTIONS,
  QS_STRINGIFY_DOCUMENTED_OPTIONS,
  fenceOrDropOptionKey,
} from "../surfaces.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  type IrExpr,
  type IrType,
  STRING,
  type SrcLoc,
  isUnitType,
} from "../../../ir/ir.js";
import { optionMember } from "./arguments.js";

/** querystring's sep/eq arguments under Node's falsy rule: an omitted
 * argument, the literal null and the literal undefined mean the default
 * (parse(s, null, null, opts) is the canonical maxKeys spelling), and so
 * does an empty string; any other string is the separator. Any other value
 * converts at run time (qs.separator): a falsy value is the default, and a
 * truthy one is String(value), which can be explicitly empty
 * (String([]) is ''). */
function qsSepEqArg(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  dflt: string,
  what: string,
  loc: SrcLoc,
): IrExpr {
  if (
    !node ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  ) {
    return { kind: "strLit", value: dflt, type: STRING, loc };
  }
  const v = lowerer.lowerExpr(node);
  if (v.type.kind === "string") {
    if (v.kind === "strLit") return v.value === "" ? { ...v, value: dflt } : v;
    const local = lowerer.declareHiddenLocal("%qsSeparator", STRING);
    const read = (): IrExpr => ({ kind: "varRef", localId: local.id, type: STRING, loc });
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: v, loc }],
      result: {
        kind: "ternary",
        cond: {
          kind: "strEq",
          negated: false,
          left: read(),
          right: { kind: "strLit", value: "", type: STRING, loc },
          type: BOOL,
          loc,
        },
        then: { kind: "strLit", value: dflt, type: STRING, loc },
        else_: read(),
        type: STRING,
        loc,
      },
      type: STRING,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: "qs.separator",
    args: [
      lowerer.coerceInto(node, v, DYN),
      { kind: "strLit", value: dflt, type: STRING, loc },
      { kind: "boolLit", value: what === "querystring.parse", type: BOOL, loc },
    ],
    type: STRING,
    loc,
  };
}

/** querystring.parse / querystring.decode: the scan runs in the runtime
 * (scr_qs_parse_into fills the result dictionary's overflow map), so the
 * frontend completes sep/eq/maxKeys to Node's defaults and verifies the
 * call site's mapped result IS the ParsedUrlQuery dictionary — a pure
 * index-signature record over `string | string[]` (an undefined arm
 * tolerated: @types/node's Dict) — the networkInterfaces verification
 * stance. The default decoder is the one lowered decoder; a custom
 * decodeURIComponent option fences by name. */
export function lowerQuerystringParseCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.nodes.length > 4 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`querystring.parse with ${call.arguments.nodes.length} arguments`, call);
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      "querystring.parse where the result is not the ParsedUrlQuery dictionary",
      call,
      "the `{ [key: string]: string | string[] }` shape is the supported result",
    );
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "record") fence();
  const dictShape = lowerer.shapes.get(result.shapeId);
  if (!dictShape || dictShape.tuple || dictShape.fields.length > 0 || !dictShape.indexValue)
    fence();
  const iv = dictShape.indexValue;
  if (iv.kind !== "union") fence();
  const ivDef = lowerer.unions.get(iv.unionId);
  if (!ivDef) fence();
  let sawStr = false;
  let sawArr = false;
  for (const arm of ivDef.arms) {
    if (arm.kind === "string") sawStr = true;
    else if (arm.kind === "array" && arm.elem.kind === "string") sawArr = true;
    // undefined rides @types/node's Dict; the f64 arm is the
    // header-family canonicalization (type-mapper.ts interns every
    // `string | string[]`-slotted dictionary as the one canonical
    // header shape, whose slot adds number type-level only — parse
    // never stores one).
    else if (arm.kind !== "undefinedT" && arm.kind !== "f64") fence();
  }
  if (!sawStr || !sawArr) fence();
  // Node's parse answers an empty object for a query that is not a string,
  // an omitted one included.
  const argument = call.arguments.nodes[0];
  let str: IrExpr;
  if (!argument) {
    str = { kind: "strLit", value: "", type: STRING, loc };
  } else if ((lowerer.typeOf(argument).flags & ts.TypeFlags.StringLike) !== 0) {
    str = lowerer.lowerExprExpecting(argument, STRING);
  } else {
    const input = lowerer.declareHiddenLocal("%qsInput", DYN);
    const read = (): IrExpr => ({ kind: "varRef", localId: input.id, type: DYN, loc });
    str = {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: input.id,
          init: lowerer.coerceInto(argument, lowerer.lowerExpr(argument), DYN),
          loc,
        },
      ],
      result: {
        kind: "ternary",
        cond: { kind: "dynTest", test: "string", value: read(), type: BOOL, loc },
        then: { kind: "dynCheck", value: read(), type: STRING, loc },
        else_: { kind: "strLit", value: "", type: STRING, loc },
        type: STRING,
        loc,
      },
      type: STRING,
      loc,
    };
  }
  const sep = qsSepEqArg(lowerer, call.arguments.nodes[1], "&", "querystring.parse", loc);
  const eq = qsSepEqArg(lowerer, call.arguments.nodes[2], "=", "querystring.parse", loc);
  // The options walk: maxKeys lowers (Node's rule — > 0 caps the pair
  // count, 0 and negatives mean unlimited — lives in the runtime, so
  // any number expression works, and a value that is not a number means
  // the default 1000); a decodeURIComponent value goes to qs.parseCustom,
  // which decodes with it when it is a function.
  let maxKeys: IrExpr = { kind: "numLit", value: 1000, type: F64, loc };
  let decoder: IrExpr | null = null;
  const optsNode = call.arguments.nodes[3];
  if (optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      lowerer.noLowering(
        "querystring.parse with a non-literal options argument",
        optsNode,
        "the supported form spells the options inline: parse(s, sep, eq, { maxKeys: n })",
      );
    }
    for (const p of optsNode.properties.nodes) {
      const m = optionMember(p);
      if (!m) {
        lowerer.noLowering(
          "querystring.parse with this options shape",
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      if (m.name === "maxKeys") {
        maxKeys =
          (lowerer.typeOf(m.value).flags & ts.TypeFlags.NumberLike) !== 0
            ? lowerer.lowerExprExpecting(m.value, F64)
            : numberOrDefault(lowerer, m.value, 1000, loc);
      } else if (m.name === "decodeURIComponent") {
        decoder = lowerer.coerceInto(m.value, lowerer.lowerExpr(m.value), DYN);
      } else {
        fenceOrDropOptionKey(
          lowerer,
          p,
          m.name,
          "querystring.parse",
          QS_PARSE_DOCUMENTED_OPTIONS,
          "maxKeys is the supported option",
        );
      }
    }
  }
  if (decoder)
    return {
      kind: "libCall",
      fn: "qs.parseCustom",
      args: [str, sep, eq, maxKeys, decoder],
      type: result,
      loc,
    };
  return { kind: "libCall", fn: "qs.parse", args: [str, sep, eq, maxKeys], type: result, loc };
}

/** A value that is a number at run time, or `fallback` (Node's `typeof
 * options.maxKeys === 'number'` test). */
function numberOrDefault(
  lowerer: Lowerer,
  node: ts.Expression,
  fallback: number,
  loc: SrcLoc,
): IrExpr {
  const local = lowerer.declareHiddenLocal("%qsNumber", DYN);
  const read = (): IrExpr => ({ kind: "varRef", localId: local.id, type: DYN, loc });
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: local.id,
        init: lowerer.coerceInto(node, lowerer.lowerExpr(node), DYN),
        loc,
      },
    ],
    result: {
      kind: "ternary",
      cond: { kind: "dynTest", test: "number", value: read(), type: BOOL, loc },
      then: { kind: "dynCheck", value: read(), type: F64, loc },
      else_: { kind: "numLit", value: fallback, type: F64, loc },
      type: F64,
      loc,
    },
    type: F64,
    loc,
  };
}

/** querystring.stringify / querystring.encode: the object crosses as a
 * dyn value (dynFrom — JSON-safe records and, in JS sources, dyn values
 * directly) and Node's encodeStringified rules run in the runtime
 * (scr_qs_stringify), so arrays expand to repeated keys and
 * null/undefined values are empty. The default encoder is the one
 * lowered encoder; a custom encodeURIComponent option fences by name. */
export function lowerQuerystringStringifyCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.nodes.length > 4 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`querystring.stringify with ${call.arguments.nodes.length} arguments`, call);
  }
  const objNode = call.arguments.nodes[0];
  // stringify() / stringify(undefined) / stringify(null): Node answers
  // '' for every non-object — the constant folds.
  if (
    !objNode ||
    objNode.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(objNode) && objNode.text === "undefined")
  ) {
    return { kind: "strLit", value: "", type: STRING, loc };
  }
  const objV = lowerer.lowerExpr(objNode);
  let obj: IrExpr;
  // Records and arrays stringify their own keys; Node answers '' for a value
  // that is not an object, which the runtime does after the arguments are
  // evaluated. Typed arrays, maps and sets keep the fence: their dynamic
  // copies would not have the keys Node's Object.keys answers.
  const crosses = (t: IrType): boolean =>
    t.kind === "record" ||
    t.kind === "array" ||
    t.kind === "f64" ||
    t.kind === "string" ||
    t.kind === "bool" ||
    t.kind === "bigint" ||
    isUnitType(t) ||
    (t.kind === "union" && (lowerer.unions.get(t.unionId)?.arms.every(crosses) ?? false));
  if (objV.type.kind === "dyn") {
    obj = objV;
  } else if (crosses(objV.type) && lowerer.dynConvertible(objV.type)) {
    obj = { kind: "dynFrom", value: objV, type: DYN, loc };
  } else {
    lowerer.noLowering(
      `querystring.stringify of '${lowerer.fmt(objV.type)}' values`,
      objNode,
      "pass a record of string/number/boolean values (arrays of those expand to repeated keys; null/undefined values serialize empty)",
    );
  }
  const sep = qsSepEqArg(lowerer, call.arguments.nodes[1], "&", "querystring.stringify", loc);
  const eq = qsSepEqArg(lowerer, call.arguments.nodes[2], "=", "querystring.stringify", loc);
  let encoder: IrExpr | null = null;
  const optsNode = call.arguments.nodes[3];
  if (optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      lowerer.noLowering(
        "querystring.stringify with a non-literal options argument",
        optsNode,
        "the supported form spells the options inline (and the only documented option, encodeURIComponent, has no lowering)",
      );
    }
    for (const p of optsNode.properties.nodes) {
      const m = optionMember(p);
      if (!m) {
        lowerer.noLowering(
          "querystring.stringify with this options shape",
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      if (m.name === "encodeURIComponent") {
        encoder = lowerer.coerceInto(m.value, lowerer.lowerExpr(m.value), DYN);
      } else {
        fenceOrDropOptionKey(
          lowerer,
          p,
          m.name,
          "querystring.stringify",
          QS_STRINGIFY_DOCUMENTED_OPTIONS,
          "no stringify options have a lowering",
        );
      }
    }
  }
  // The encoder can change the object while stringify reads it, so a typed
  // record or array crosses as a live capsule rather than a copy. Primitives
  // have nothing to change and cross by value.
  const mutable = (t: IrType): boolean =>
    t.kind === "record" ||
    t.kind === "array" ||
    (t.kind === "union" && (lowerer.unions.get(t.unionId)?.arms.some(mutable) ?? false));
  if (encoder && obj.kind === "dynFrom" && mutable(objV.type)) obj = { ...obj, liveRef: true };
  if (encoder)
    return {
      kind: "libCall",
      fn: "qs.stringifyCustom",
      args: [obj, sep, eq, encoder],
      type: STRING,
      loc,
    };
  return { kind: "libCall", fn: "qs.stringify", args: [obj, sep, eq], type: STRING, loc };
}

/** querystring.unescapeBuffer(s, decodeSpaces?): Node's scan of s into a
 * new Buffer; decodeSpaces is tested for truthiness. */
export function lowerQuerystringUnescapeBufferCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = call.arguments.nodes;
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement))
    lowerer.noLowering(`querystring.unescapeBuffer with ${args.length} arguments`, call);
  const text = lowerer.lowerExprExpecting(args[0]!, STRING);
  let spaces: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  if (args[1]) {
    const value = lowerer.lowerExpr(args[1]);
    spaces =
      value.type.kind === "bool"
        ? value
        : {
            kind: "dynTest",
            test: "truthy",
            value: lowerer.coerceInto(args[1], value, DYN),
            type: BOOL,
            loc,
          };
  }
  return {
    kind: "libCall",
    fn: "qs.unescapeBuffer",
    args: [text, spaces],
    type: BYTES_U8,
    loc,
  };
}

/** querystring.escape(value) of a value whose type is not string: Node's
 * qsEscape converts it first (String(value) for an object or null, value +
 * "" for other values), then escapes the result. A string argument takes
 * the table's qs.escape; null here. */
export function lowerQuerystringEscapeValueCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const args = call.arguments.nodes;
  if (args.length !== 1 || ts.isSpreadElement(args[0]!)) return null;
  if ((lowerer.typeOf(args[0]!).flags & ts.TypeFlags.StringLike) !== 0) return null;
  const value = lowerer.lowerExpr(args[0]!);
  return {
    kind: "libCall",
    fn: "qs.escapeValue",
    args: [lowerer.coerceInto(args[0]!, value, DYN)],
    type: STRING,
    loc,
  };
}
