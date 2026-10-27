import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import {
  QS_PARSE_DOCUMENTED_OPTIONS,
  QS_STRINGIFY_DOCUMENTED_OPTIONS,
  fenceOrDropOptionKey,
} from "../surfaces.js";
import { DYN, F64, type IrExpr, STRING, type SrcLoc } from "../../../ir/ir.js";
import { optionMember } from "./arguments.js";

/** querystring's sep/eq arguments: an omitted argument, the literal
 * null, and the literal undefined all mean the default (Node's falsy
 * rule — parse(s, null, null, opts) is the canonical maxKeys spelling);
 * a string expression passes through (the runtime applies the same
 * falsy rule to '' at runtime). Everything else fences. */
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
  if (v.type.kind !== "string") {
    lowerer.noLowering(
      `${what} with a '${lowerer.fmt(v.type)}' separator`,
      node,
      "pass a string, or null/undefined for the default (narrow unions first)",
    );
  }
  return v;
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
  const argument = call.arguments.nodes[0];
  if (!argument) lowerer.noLowering("querystring.parse without a query string", call);
  const str = lowerer.lowerExprExpecting(argument, STRING);
  const sep = qsSepEqArg(lowerer, call.arguments.nodes[1], "&", "querystring.parse", loc);
  const eq = qsSepEqArg(lowerer, call.arguments.nodes[2], "=", "querystring.parse", loc);
  // The options walk: maxKeys lowers (Node's rule — > 0 caps the pair
  // count, 0 and negatives mean unlimited — lives in the runtime, so
  // any number expression works); a custom decodeURIComponent changes
  // every decoded byte and fences by name.
  let maxKeys: IrExpr = { kind: "numLit", value: 1000, type: F64, loc };
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
        maxKeys = lowerer.lowerExprExpecting(m.value, F64);
      } else if (m.name === "decodeURIComponent") {
        lowerer.noLowering(
          "querystring.parse with a custom decodeURIComponent",
          p,
          "the default decoder is the lowered surface (strict decodeURIComponent with Node's lenient fallback)",
        );
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
  return { kind: "libCall", fn: "qs.parse", args: [str, sep, eq, maxKeys], type: result, loc };
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
  if (objV.type.kind === "dyn") {
    obj = objV;
  } else if (objV.type.kind === "record" && lowerer.dynConvertible(objV.type)) {
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
        lowerer.noLowering(
          "querystring.stringify with a custom encodeURIComponent",
          p,
          "the default encoder (querystring.escape's component set) is the lowered surface",
        );
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
  return { kind: "libCall", fn: "qs.stringify", args: [obj, sep, eq], type: STRING, loc };
}
