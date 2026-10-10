import { numLit } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { lowerOptionalArgument, lowerStringSearchArgument } from "../optional-arguments.js";
import { lowerToNumberArgument } from "../lower-exprs.js";
import { F64, type IrExpr, STRING, arrayOf, isUnitType, typeEquals } from "../../../ir/ir.js";

/** `String.fromCharCode/fromCodePoint(...codes)` on THE String global: every argument
 * lowers as a number and packs into ONE f64[] array-literal argument
 * (the path.join convention) — or ONE whole-array spread forwards the
 * array itself. String.raw has its own template path below.
 * Null for non-String receivers. */
export function lowerStringStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "String");
  if (member !== "fromCharCode" && member !== "fromCodePoint" && member !== "raw") return null;
  const loc = locOf(call);
  // String.raw(template, ...substitutions): the template's `raw` member
  // is a string[] read off any record that carries one (the lib's
  // parameter type — an object literal or a TemplateStringsArray-shaped
  // record); each substitution stringifies through the static ToString
  // (numbers/booleans/strings — the toString node; records print
  // "[object Object]" there like JS) and packs into ONE string[]
  // literal, the fromCharCode convention. The runtime interleaves per
  // the spec's loop.
  if (member === "raw") {
    if (call.arguments.length < 1 || call.arguments.some((a) => ts.isSpreadElement(a))) {
      lowerer.noLowering(
        `String.raw with ${call.arguments.length === 0 ? "no template" : "spread substitutions"}`,
        call,
      );
    }
    const tmplNode = call.arguments[0]!;
    const tmpl = lowerer.lowerExpr(tmplNode);
    const rawT = arrayOf(STRING);
    let raw: IrExpr | null = null;
    if (tmpl.type.kind === "record") {
      const shape = lowerer.shapes.get(tmpl.type.shapeId);
      const rawField = shape?.fields.find((f) => f.name === "raw");
      if (rawField && typeEquals(rawField.type, rawT)) {
        raw = {
          kind: "recordGet",
          obj: tmpl,
          shapeId: tmpl.type.shapeId,
          field: "raw",
          type: rawT,
          loc,
        };
      }
    }
    if (raw === null) {
      lowerer.noLowering(
        "String.raw over this template shape",
        tmplNode,
        "the template must carry a string[] `raw` member: String.raw({ raw: [...] }, ...subs)",
      );
    }
    const subs = call.arguments.slice(1).map((a): IrExpr => {
      const v = lowerer.lowerExpr(a);
      if (isUnitType(v.type)) return lowerer.ensureString(v, a);
      if (v.type.kind === "string") return v;
      if (v.type.kind === "f64" || v.type.kind === "bool" || v.type.kind === "record") {
        return { kind: "toString", operand: v, type: STRING, loc };
      }
      lowerer.noLowering(
        `String.raw substitutions of type '${lowerer.fmt(v.type)}'`,
        a,
        "numbers, strings, booleans, and records stringify statically",
      );
    });
    const packedSubs: IrExpr = { kind: "arrayLit", elems: subs, type: rawT, loc };
    return { kind: "libCall", fn: "string.raw", args: [raw, packedSubs], type: STRING, loc };
  }
  const spread = call.arguments.find(ts.isSpreadElement);
  if (spread) {
    if (call.arguments.length !== 1) {
      lowerer.noLowering(
        `String.${member} with a mixed spread call`,
        call,
        `spread a whole array (String.${member}(...codes)) or pass plain arguments`,
      );
    }
    // A typed-array/Buffer spread (String.fromCharCode(...data.slice(4, 8))
    // — the magic-number ASCII probe) passes the bytes value through; the
    // runtime reads its elements like the packed-array form.
    const spreadT = lowerer.mapTypeOf(lowerer.typeOf(spread.expression));
    if (spreadT?.kind === "bytes") {
      const packed = lowerer.lowerExpr(spread.expression);
      if (packed.type.kind !== "bytes")
        lowerer.badType(spread.expression, lowerer.typeOf(spread.expression));
      return { kind: "libCall", fn: `string.${member}`, args: [packed], type: STRING, loc };
    }
    const packed = lowerer.lowerExprExpecting(spread.expression, arrayOf(F64));
    return { kind: "libCall", fn: `string.${member}`, args: [packed], type: STRING, loc };
  }
  // Each code converts with ToNumber: a missing value is NaN (code unit 0
  // for fromCharCode, a RangeError for fromCodePoint), exactly Node.
  const elems = call.arguments.map((a) => lowerToNumberArgument(lowerer, a));
  const packed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(F64), loc };
  return { kind: "libCall", fn: `string.${member}`, args: [packed], type: STRING, loc };
}

/** `s.lastIndexOf(searchValue?, position?)` on string receivers, using UTF-16
 * indices. An omitted search value searches for "undefined". Omitted or undefined positions clamp to the string's end;
 * MAX_SAFE_INTEGER has the same effect for every representable string.
 * Null for non-string receivers and other members. */
export function lowerStringLastIndexOfCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "lastIndexOf") return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "string") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  if (call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "lastIndexOf with this argument shape",
      call,
      "pass no arguments, or a search value with an optional numeric position",
    );
  }
  const receiver = lowerer.lowerExprExpecting(access.expression, STRING);
  const positionNode = call.arguments[1];
  if (!positionNode) {
    const needle = lowerStringSearchArgument(lowerer, call.arguments[0], loc);
    return { kind: "libCall", fn: "string.lastIndexOf", args: [receiver, needle], type: F64, loc };
  }
  const needle = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
  const position = lowerOptionalArgument(
    lowerer,
    positionNode,
    F64,
    numLit(Number.MAX_SAFE_INTEGER, loc),
  );
  return {
    kind: "libCall",
    fn: "string.lastIndexOfFrom",
    args: [receiver, needle, position],
    type: F64,
    loc,
  };
}
