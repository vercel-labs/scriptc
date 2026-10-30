import { keyedHelperName } from "../stable-names.js";
import { matchAllRowsReadByElements } from "./match-row-uses.js";
import {
  boolLit,
  dynUndefinedExpr,
  nodeThrowExpr,
  numLit,
  strLit,
  varRef,
} from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  REGEX,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { own } from "../lowerer.js";
import { isRequireMainFilename } from "../expressions/optional-chains.js";
import { isSafeToDiscard } from "../expressions/evaluation-safety.js";
import { STRING_INDEX_METHODS, STRING_REPLACE_METHODS, STR_METHODS } from "../surfaces.js";
import { execResultCaptureMask } from "./exec-result-uses.js";
import { lowerStringReplacement } from "./string-replacement.js";
import { lowerReplacerCallback, regexLiteralCapturesOf } from "./replacer-params.js";
import {
  coerceStringSearchValue,
  defaultAfterUndefined,
  lowerOptionalArgument,
  lowerPositionArgument,
  lowerStaticallyUndefinedArgument,
  lowerStringSearchArgument,
  positionNumber,
} from "../optional-arguments.js";

function lowerSplitLimitArg(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  const defaultValue: IrExpr = { kind: "numLit", value: 4294967295, type: F64, loc };
  return node ? lowerOptionalArgument(lowerer, node, F64, defaultValue) : defaultValue;
}

/** Split evaluates its arguments before converting the receiver, limit, and
 * separator, in that order. An undefined separator returns the whole string
 * unless ToUint32(limit) is zero; the string-separator intrinsic handles the
 * remaining split loop. */
export function lowerStringSplitCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  receiverNode: ts.Node,
  argumentNodes: readonly ts.Expression[],
): IrExpr {
  const loc = locOf(call);
  if (argumentNodes.length > 2 || argumentNodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`.split with ${argumentNodes.length} arguments`, call);
  }
  const separatorNode = argumentNodes[0];
  const undefinedSeparator = separatorNode
    ? lowerStaticallyUndefinedArgument(lowerer, separatorNode)
    : null;
  const absent = !separatorNode || undefinedSeparator !== null;
  let separator: IrExpr = absent
    ? undefinedSeparator
      ? defaultAfterUndefined(undefinedSeparator, strLit("undefined", loc))
      : strLit("undefined", loc)
    : lowerer.lowerExpr(separatorNode);
  if (separator.type.kind === "nullT")
    separator = defaultAfterUndefined(separator, strLit("null", loc));
  // JS functions returning null use a boxed ABI. Recover the nullish
  // value through a checked union; keep object/@@split forms fenced.
  if (
    separator.type.kind === "dyn" &&
    separatorNode &&
    (lowerer.typeOf(separatorNode).flags & ts.TypeFlags.Null) !== 0
  ) {
    separator = {
      kind: "dynCheck",
      value: separator,
      type: { kind: "union", unionId: lowerer.unions.intern([{ kind: "nullT" }, UNDEFINED_T]) },
      loc,
    };
  }
  if (separator.type.kind === "dyn") {
    separator = {
      kind: "dynCheck",
      value: separator,
      type: {
        kind: "union",
        unionId: lowerer.unions.intern([
          STRING,
          F64,
          BOOL,
          { kind: "bigint" },
          { kind: "nullT" },
          UNDEFINED_T,
        ]),
      },
      loc,
    };
  }
  const scalar =
    separator.type.kind === "string" ||
    separator.type.kind === "f64" ||
    separator.type.kind === "bool" ||
    separator.type.kind === "bigint" ||
    (separator.type.kind === "union" &&
      (lowerer.unions
        .get(separator.type.unionId)
        ?.arms.every(
          (arm) =>
            arm.kind === "string" ||
            arm.kind === "f64" ||
            arm.kind === "bool" ||
            arm.kind === "bigint" ||
            arm.kind === "nullT" ||
            arm.kind === "undefinedT",
        ) ??
        false));
  if (!scalar) {
    lowerer.unsupported(
      "SC1090",
      separatorNode ?? call,
      `'.split()' on a '${lowerer.fmt(separator.type)}' separator (pass a string, or a regex literal)`,
    );
  }
  const defaultLimit = numLit(4294967295, loc);
  const suppliedLimit = lowerPositionArgument(lowerer, argumentNodes[1], defaultLimit);
  const limit =
    suppliedLimit.type.kind === "record" && argumentNodes[1]
      ? lowerer.coerceInto(argumentNodes[1], suppliedLimit, DYN)
      : suppliedLimit;
  const resultType = arrayOf(STRING);
  if (
    receiver.type.kind === "string" &&
    separator.type.kind === "string" &&
    limit.type.kind === "f64" &&
    !absent
  ) {
    return {
      kind: "strIntrinsic",
      method: "split",
      receiver,
      args: [separator, limit],
      type: resultType,
      loc,
    };
  }
  const key = `str.split:${receiver.type.kind === "union" ? typeKey(receiver.type) : receiver.type.kind}:${typeKey(separator.type)}:${typeKey(limit.type)}:${absent}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%str.split", key);
    const values = [receiver, separator, limit];
    const params = values.map((value, index) => ({
      localId: `arg.${index}`,
      name: `arg${index}`,
      type: value.type,
    }));
    const rawReceiver = varRef("arg.0", receiver.type, loc);
    const rawSeparator = varRef("arg.1", separator.type, loc);
    const rawLimit = varRef("arg.2", limit.type, loc);
    const stringReceiver = varRef("receiver.0", STRING, loc);
    const numericLimit = varRef("limit.0", F64, loc);
    const stringSeparator = varRef("separator.0", STRING, loc);
    const undefinedTag =
      separator.type.kind === "union"
        ? lowerer.unions
            .get(separator.type.unionId)!
            .arms.findIndex((arm) => arm.kind === "undefinedT")
        : -1;
    const separatorIsUndefined: IrExpr = absent
      ? { kind: "boolLit", value: true, type: BOOL, loc }
      : undefinedTag >= 0 && separator.type.kind === "union"
        ? {
            kind: "unionIsTag",
            unionId: separator.type.unionId,
            tag: undefinedTag,
            value: rawSeparator,
            negated: false,
            type: BOOL,
            loc,
          }
        : { kind: "boolLit", value: false, type: BOOL, loc };
    const split: IrExpr = {
      kind: "strIntrinsic",
      method: "split",
      receiver: stringReceiver,
      args: [stringSeparator, numericLimit],
      type: resultType,
      loc,
    };
    const result: IrExpr = {
      kind: "ternary",
      cond: {
        kind: "bin",
        op: "===",
        left: { kind: "bin", op: ">>>", left: numericLimit, right: numLit(0, loc), type: F64, loc },
        right: numLit(0, loc),
        type: BOOL,
        loc,
      },
      then: { kind: "arrayLit", elems: [], type: resultType, loc },
      else_: {
        kind: "ternary",
        cond: separatorIsUndefined,
        then: { kind: "arrayLit", elems: [stringReceiver], type: resultType, loc },
        else_: split,
        type: resultType,
        loc,
      },
      type: resultType,
      loc,
    };
    lowerer.valueHelpers.set(key, helper);
    lowerer.liftedFns.push({
      name: helper,
      params,
      returnType: resultType,
      locals: [
        ...params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        { id: "receiver.0", name: "receiver", type: STRING, mutable: false },
        { id: "limit.0", name: "limit", type: F64, mutable: false },
        { id: "separator.0", name: "separator", type: STRING, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "receiver.0",
          init: lowerer.ensureString(rawReceiver, receiverNode),
          loc,
        },
        {
          kind: "varDecl",
          localId: "limit.0",
          init: positionNumber(
            lowerer,
            rawLimit,
            defaultLimit,
            argumentNodes[1] ?? call,
            "string split limit",
          ),
          loc,
        },
        {
          kind: "varDecl",
          localId: "separator.0",
          init: lowerer.ensureString(rawSeparator, separatorNode ?? call),
          loc,
        },
        { kind: "return", value: result, loc },
      ],
      loc,
    });
  }
  return {
    kind: "call",
    callee: helper,
    args: [receiver, separator, limit],
    type: resultType,
    loc,
  };
}

function lowerRegexSubject(lowerer: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  const absent: IrExpr = { kind: "strLit", value: "undefined", type: STRING, loc };
  if (!node) return absent;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, absent);
  const value = lowerer.lowerExpr(node);
  if (value.kind === "unitLit") return { kind: "strLit", value: value.unit, type: STRING, loc };
  return lowerer.ensureString(value, node);
}

/** Extract the checker-proven receiver arm from a runtime-optional property
 * read. The receiver is stabilized once before its tag is tested, and a
 * missing value throws the same property-read TypeError Node throws before
 * evaluating method arguments. */
function lowerMethodReceiver(
  lowerer: Lowerer,
  node: ts.Expression,
  expected: IrType,
  member: string,
): IrExpr {
  const lowered = lowerer.lowerExpr(node);
  const optional = lowerer.runtimeOptionalPropertyReceiver(node, lowered, expected, member);
  if (optional) return optional;
  if (typeEquals(lowered.type, expected)) return lowered;
  return lowerer.coerceInto(node, lowered, expected);
}

/** A `string | undefined | null` receiver of a string method: evaluated
 * once, each unit arm throws the TypeError Node's member read throws
 * ("Cannot read properties of undefined (reading 'replace')") before the
 * arguments evaluate, and the string arm is the receiver. */
function nullableStringReceiver(lowerer: Lowerer, node: ts.Expression, member: string): IrExpr {
  const lowered = lowerer.lowerExpr(node);
  if (lowered.type.kind !== "union") return lowerer.coerceInto(node, lowered, STRING);
  const loc = locOf(node);
  const unionId = lowered.type.unionId;
  const local = lowerer.declareHiddenLocal("%nullableReceiver", lowered.type);
  const ref: IrExpr = { kind: "varRef", localId: local.id, type: lowered.type, loc };
  const arms = lowerer.unions.get(unionId)?.arms ?? [];
  let result: IrExpr = {
    kind: "unionNarrow",
    unionId,
    tag: arms.findIndex((arm) => arm.kind === "string"),
    value: ref,
    type: STRING,
    loc,
  };
  for (const [tag, arm] of arms.entries()) {
    if (!isUnitType(arm)) continue;
    const unit = arm.kind === "nullT" ? "null" : "undefined";
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, value: ref, negated: false, type: BOOL, loc },
      then: nodeThrowExpr(
        1,
        "",
        `Cannot read properties of ${unit} (reading '${member}')`,
        STRING,
        loc,
      ),
      else_: result,
      type: STRING,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: lowered, loc }],
    result,
    type: STRING,
    loc,
  };
}

/** Relative string indexing and code-point decoding over the UTF-16 intrinsics. */
export function lowerStringIndexCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "at" | "codePointAt",
  receiver: IrExpr,
  receiverNode: ts.Node,
  argumentNodes: readonly ts.Expression[],
): IrExpr {
  const loc = locOf(call);
  if (argumentNodes.length > 1 || argumentNodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`String.prototype.${method} with ${argumentNodes.length} arguments`, call);
  }
  const indexNode = argumentNodes[0];
  let index = lowerPositionArgument(lowerer, indexNode, numLit(0, loc));
  if (
    indexNode &&
    (index.type.kind === "record" || index.type.kind === "array" || index.type.kind === "func")
  ) {
    index = lowerer.coerceInto(indexNode, index, DYN);
  }
  return stringIndexHelperCall(lowerer, call, method, receiver, receiverNode, index, indexNode);
}

/** The relative-index / code-point helper call over an already lowered
 * index (any type positionNumber converts — dyn indices included). */
function stringIndexHelperCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "at" | "codePointAt",
  receiver: IrExpr,
  receiverNode: ts.Node,
  index: IrExpr,
  indexNode: ts.Expression | undefined,
): IrExpr {
  const loc = locOf(call);
  const valueType = method === "at" ? STRING : F64;
  const resultType = lowerer.withUndefinedArmOf(valueType);
  if (!resultType || resultType.kind !== "union")
    lowerer.noLowering(`String.prototype.${method} result`, call);
  const undefinedTag = lowerer.armTag(resultType.unionId, UNDEFINED_T);
  const valueTag = lowerer.armTag(resultType.unionId, valueType);
  const key = `str.index:${method}:${typeKey(receiver.type)}:${typeKey(index.type)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%str.index", key);
    lowerer.valueHelpers.set(key, helper);
    const rawReceiver = varRef("arg.0", receiver.type, loc);
    const rawIndex = varRef("arg.1", index.type, loc);
    const stringReceiver = varRef("receiver.0", STRING, loc);
    const length = varRef("length.0", F64, loc);
    const position = varRef("position.0", F64, loc);
    const first = varRef("first.0", F64, loc);
    const second = varRef("second.0", F64, loc);
    const bin = (op: "<" | ">=" | ">" | "+" | "-" | "*", left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "bin",
      op,
      left,
      right,
      type: op === "<" || op === ">=" || op === ">" ? BOOL : F64,
      loc,
    });
    const either = (left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "logical",
      op: "||",
      left,
      right,
      type: BOOL,
      loc,
    });
    const wrap = (value: IrExpr): IrExpr => ({
      kind: "unionWrap",
      unionId: resultType.unionId,
      tag: valueTag,
      value,
      type: resultType,
      loc,
    });
    const miss: IrExpr = {
      kind: "unionWrap",
      unionId: resultType.unionId,
      tag: undefinedTag,
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: resultType,
      loc,
    };
    const numeric = positionNumber(
      lowerer,
      rawIndex,
      numLit(0, loc),
      indexNode ?? call,
      "string index",
    );
    const numericValue = varRef("numeric.0", F64, loc);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "receiver.0",
        init: lowerer.ensureString(rawReceiver, receiverNode),
        loc,
      },
      {
        kind: "varDecl",
        localId: "length.0",
        init: {
          kind: "strIntrinsic",
          method: "length",
          receiver: stringReceiver,
          args: [],
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "numeric.0", init: numeric, loc },
      {
        kind: "varDecl",
        localId: "position.0",
        init: {
          kind: "ternary",
          cond: { kind: "libCall", fn: "num.isNaN", args: [numericValue], type: BOOL, loc },
          then: numLit(0, loc),
          else_: { kind: "libCall", fn: "math.trunc", args: [numericValue], type: F64, loc },
          type: F64,
          loc,
        },
        loc,
      },
    ];
    if (method === "at") {
      body.push({
        kind: "if",
        cond: bin("<", position, numLit(0, loc)),
        then: [{ kind: "assign", localId: "position.0", value: bin("+", position, length), loc }],
        else_: null,
        loc,
      });
    }
    body.push({
      kind: "if",
      cond: either(bin("<", position, numLit(0, loc)), bin(">=", position, length)),
      then: [{ kind: "return", value: miss, loc }],
      else_: null,
      loc,
    });
    if (method === "at") {
      body.push({
        kind: "return",
        value: wrap({
          kind: "strIntrinsic",
          method: "charAt",
          receiver: stringReceiver,
          args: [position],
          type: STRING,
          loc,
        }),
        loc,
      });
    } else {
      body.push({
        kind: "varDecl",
        localId: "first.0",
        init: {
          kind: "strIntrinsic",
          method: "charCodeAt",
          receiver: stringReceiver,
          args: [position],
          type: F64,
          loc,
        },
        loc,
      });
      body.push({
        kind: "if",
        cond: either(
          either(bin("<", first, numLit(0xd800, loc)), bin(">", first, numLit(0xdbff, loc))),
          bin(">=", bin("+", position, numLit(1, loc)), length),
        ),
        then: [{ kind: "return", value: wrap(first), loc }],
        else_: null,
        loc,
      });
      body.push({
        kind: "varDecl",
        localId: "second.0",
        init: {
          kind: "strIntrinsic",
          method: "charCodeAt",
          receiver: stringReceiver,
          args: [bin("+", position, numLit(1, loc))],
          type: F64,
          loc,
        },
        loc,
      });
      body.push({
        kind: "if",
        cond: either(bin("<", second, numLit(0xdc00, loc)), bin(">", second, numLit(0xdfff, loc))),
        then: [{ kind: "return", value: wrap(first), loc }],
        else_: null,
        loc,
      });
      body.push({
        kind: "return",
        value: wrap(
          bin(
            "+",
            bin(
              "+",
              bin("*", bin("-", first, numLit(0xd800, loc)), numLit(1024, loc)),
              bin("-", second, numLit(0xdc00, loc)),
            ),
            numLit(0x10000, loc),
          ),
        ),
        loc,
      });
    }
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "arg.0", name: "receiver", type: receiver.type },
        { localId: "arg.1", name: "index", type: index.type },
      ],
      returnType: resultType,
      locals: [
        { id: "arg.0", name: "receiver", type: receiver.type, mutable: false },
        { id: "arg.1", name: "index", type: index.type, mutable: false },
        { id: "receiver.0", name: "stringReceiver", type: STRING, mutable: false },
        { id: "length.0", name: "length", type: F64, mutable: false },
        { id: "numeric.0", name: "numeric", type: F64, mutable: false },
        { id: "position.0", name: "position", type: F64, mutable: method === "at" },
        ...(method === "codePointAt"
          ? [
              { id: "first.0", name: "first", type: F64, mutable: false },
              { id: "second.0", name: "second", type: F64, mutable: false },
            ]
          : []),
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, index], type: resultType, loc };
}

function paddingFillString(lowerer: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  const loc = value.loc;
  if (value.type.kind === "undefinedT" || value.type.kind === "void") return strLit(" ", loc);
  if (value.type.kind === "nullT") return strLit("null", loc);
  if (value.type.kind === "dyn") {
    return {
      kind: "ternary",
      cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
      then: strLit(" ", loc),
      else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [value], type: STRING, loc },
      type: STRING,
      loc,
    };
  }
  if (value.type.kind === "union") {
    const unionId = value.type.unionId;
    const arms = lowerer.unions.get(unionId)!.arms;
    let result: IrExpr = strLit(" ", loc);
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arms[tag]!, loc };
      const converted = paddingFillString(lowerer, narrowed, node);
      result =
        tag === arms.length - 1
          ? converted
          : {
              kind: "ternary",
              cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
              then: converted,
              else_: result,
              type: STRING,
              loc,
            };
    }
    return result;
  }
  return lowerer.ensureString(value, node);
}

/** Pad arguments are evaluated before receiver/length coercion, while fill
 * conversion runs only if padding is needed. One helper keeps that order for
 * member calls and direct String.prototype calls alike. */
export function lowerStringPaddingCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "padStart" | "padEnd",
  receiver: IrExpr,
  receiverNode: ts.Node,
  argumentNodes: readonly ts.Expression[],
): IrExpr {
  if (argumentNodes.length > 2) {
    lowerer.noLowering(`.${method} with ${argumentNodes.length} arguments`, call);
  }
  const loc = locOf(call);
  const rawLength = lowerPositionArgument(lowerer, argumentNodes[0], numLit(0, loc));
  const maxLength =
    (rawLength.type.kind === "record" || rawLength.type.kind === "object") &&
    lowerer.dynConvertible(rawLength.type)
      ? lowerer.coerceToExpected(rawLength, DYN)
      : rawLength;
  const fillNode = argumentNodes[1];
  const undefinedFill = fillNode ? lowerStaticallyUndefinedArgument(lowerer, fillNode) : null;
  const rawFill = !fillNode
    ? strLit(" ", loc)
    : undefinedFill
      ? defaultAfterUndefined(undefinedFill, strLit(" ", loc))
      : lowerer.lowerExpr(fillNode);
  const fill =
    rawFill.type.kind === "nullT"
      ? defaultAfterUndefined(rawFill, strLit("null", loc))
      : (rawFill.type.kind === "record" || rawFill.type.kind === "object") &&
          lowerer.dynConvertible(rawFill.type)
        ? lowerer.coerceToExpected(rawFill, DYN)
        : rawFill;
  const values = [receiver, maxLength, fill];
  const key = `str.pad:${method}:${values.map((value) => typeKey(value.type)).join(":")}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%str.pad", key);
    const params = values.map((value, index) => ({
      localId: `arg.${index}`,
      name: `arg${index}`,
      type: value.type,
    }));
    const rawReceiver = varRef("arg.0", receiver.type, loc);
    const convertedReceiver: IrExpr =
      receiver.type.kind === "dyn"
        ? {
            kind: "ternary",
            cond: { kind: "dynTest", test: "nullish", value: rawReceiver, type: BOOL, loc },
            then: nodeThrowExpr(
              1,
              "",
              `String.prototype.${method} called on null or undefined`,
              STRING,
              loc,
            ),
            else_: {
              kind: "libCall",
              fn: "dyn.toStringCoerce",
              args: [rawReceiver],
              type: STRING,
              loc,
            },
            type: STRING,
            loc,
          }
        : lowerer.ensureString(rawReceiver, receiverNode);
    const stringReceiver = varRef("receiver.0", STRING, loc);
    const length = varRef("length.0", F64, loc);
    const fillValue = varRef("arg.2", fill.type, loc);
    const padded: IrExpr = {
      kind: "strIntrinsic",
      method,
      receiver: stringReceiver,
      args: [length, paddingFillString(lowerer, fillValue, fillNode ?? call)],
      type: STRING,
      loc,
    };
    const result: IrExpr = {
      kind: "ternary",
      cond: {
        kind: "bin",
        op: ">=",
        left: length,
        right: {
          kind: "bin",
          op: "+",
          left: {
            kind: "strIntrinsic",
            method: "length",
            receiver: stringReceiver,
            args: [],
            type: F64,
            loc,
          },
          right: numLit(1, loc),
          type: F64,
          loc,
        },
        type: BOOL,
        loc,
      },
      then: padded,
      else_: stringReceiver,
      type: STRING,
      loc,
    };
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "receiver.0", init: convertedReceiver, loc },
      {
        kind: "varDecl",
        localId: "length.0",
        init: positionNumber(
          lowerer,
          varRef("arg.1", maxLength.type, loc),
          numLit(0, loc),
          argumentNodes[0] ?? call,
          "string padding length",
        ),
        loc,
      },
      { kind: "return", value: result, loc },
    ];
    lowerer.valueHelpers.set(key, helper);
    lowerer.liftedFns.push({
      name: helper,
      params,
      returnType: STRING,
      locals: [
        ...params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        { id: "receiver.0", name: "receiver", type: STRING, mutable: false },
        { id: "length.0", name: "length", type: F64, mutable: false },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: values, type: STRING, loc };
}

/** String methods whose regex-argument forms lower in lowerRegexMethodCall. */
const REGEX_ARGUMENT_STRING_METHODS = new Set([
  "replace",
  "replaceAll",
  "split",
  "search",
  "matchAll",
]);

export function lowerRegexMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  dynReceiver?: () => IrExpr,
): IrExpr | null {
  // chainBlocked, not a raw token test: an optional-chain re-dispatch
  // (`rawName?.match(re)` — the receiver reads back chain-narrowed)
  // rides the same lowering as the plain spelling.
  if (lowerer.chainBlocked(access, call)) return null;
  // A validated dyn receiver (lowerStringMethodCall's story) is a STRING
  // by construction — the symbol gate doesn't apply to `any` receivers.
  if (dynReceiver === undefined && !lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const mappedReceiver = dynReceiver ? null : lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  // A nullable string receiver of a REGEX-argument call
  // (`part.replace(re, "")` where an unchecked index read typed `part`
  // `string | undefined`) takes the string path, as
  // lowerStringMethodCall's gate does for the string-argument forms:
  // lowerMethodReceiver throws Node's "Cannot read properties of
  // undefined" on the unit arms. (`match` keeps its own gate below.)
  const regexArgument = call.arguments.nodes[0];
  const nullableString =
    REGEX_ARGUMENT_STRING_METHODS.has(name) &&
    regexArgument !== undefined &&
    !ts.isSpreadElement(regexArgument) &&
    lowerer.mapTypeOf(lowerer.typeOf(regexArgument))?.kind === "regex" &&
    mappedReceiver?.kind === "union" &&
    (lowerer.unions.get(mappedReceiver.unionId)?.arms.some((arm) => arm.kind === "string") ??
      false) &&
    (lowerer.unions
      .get(mappedReceiver.unionId)
      ?.arms.every((arm) => arm.kind === "string" || isUnitType(arm)) ??
      false);
  const receiverKind = dynReceiver || nullableString ? "string" : mappedReceiver?.kind;
  const lowerReceiver = (): IrExpr => {
    if (dynReceiver) return dynReceiver();
    if (nullableString) return nullableStringReceiver(lowerer, access.expression, name);
    if (receiverKind === "string")
      return lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
    if (receiverKind === "regex")
      return lowerMethodReceiver(lowerer, access.expression, { kind: "regex" }, access.name.text);
    return lowerer.lowerExpr(access.expression);
  };
  const loc = locOf(call);
  if (receiverKind === "regex" && name === "toString") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering("RegExp.prototype.toString with arguments", call);
    }
    return {
      kind: "regexIntrinsic",
      method: "toString",
      receiver: lowerReceiver(),
      args: [],
      type: STRING,
      loc,
    };
  }
  if (receiverKind === "regex" && name === "test") {
    if (call.arguments.nodes.length > 1 || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering("RegExp.prototype.test with surplus or spread arguments", call);
    }
    const receiver = lowerReceiver();
    const args = [lowerRegexSubject(lowerer, call.arguments.nodes[0], loc)];
    return { kind: "regexIntrinsic", method: "test", receiver, args, type: BOOL, loc };
  }
  // `re.exec(s)` returns the exec-shaped string[] | null slice, with
  // numeric lastIndex state for global/sticky regexes. Nonparticipating
  // captures retain match's present undefined element state.
  if (receiverKind === "regex" && name === "exec") {
    if (call.arguments.nodes.length > 1 || call.arguments.nodes.some(ts.isSpreadElement))
      return null;
    const re = lowerReceiver();
    const subject = lowerRegexSubject(lowerer, call.arguments.nodes[0], loc);
    const resultT: IrType = {
      kind: "union",
      unionId: lowerer.unions.intern([arrayOf(STRING), { kind: "nullT" }]),
    };
    // A result read only through null tests and constant indices skips
    // the captures and properties no reader uses.
    const mask = execResultCaptureMask(lowerer, call);
    if (mask !== null) lowerer.regexGroupResults = true;
    const execCall = (regex: IrExpr): IrExpr => ({
      kind: "regexIntrinsic",
      method: mask === null ? "exec" : "execGroups",
      receiver: subject,
      args: mask === null ? [regex] : [regex, numLit(mask, loc)],
      type: resultT,
      loc,
    });
    // A literal receiver has no evaluation to order against the subject.
    if (re.kind === "regexLit") return execCall(re);
    // The shared match intrinsic takes the string first; preserve exec's
    // receiver-before-subject evaluation order before swapping operands.
    const saved = lowerer.declareHiddenLocal("%execReceiver", re.type);
    const result = execCall(varRef(saved.id, re.type, loc));
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: saved.id, init: re, loc }],
      result,
      type: resultT,
      loc,
    };
  }
  // `s.match(re)` returns all whole matches under /g, otherwise the
  // exec-shaped slice [whole match, ...captures], or null. Non-global /y
  // uses exec's lastIndex transitions. `.groups` reads
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
      const t = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
      if (t?.kind !== "union") return false;
      const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
      return (
        arms.some((a) => a.kind === "string") &&
        arms.every((a) => a.kind === "string" || isUnitType(a))
      );
    })();
  if ((receiverKind === "string" || nullableStringRecv) && name === "match") {
    const arg0 = call.arguments.nodes[0];
    if (!arg0 || call.arguments.nodes.length !== 1) return null;
    const checkedPattern = isCheckedPatternArgument(lowerer, arg0);
    if (!checkedPattern && !isRegexPatternArgument(lowerer, arg0)) return null; // string-pattern match: the SC2020 fence
    const receiver = nullableStringRecv
      ? lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text)
      : lowerReceiver();
    const re = checkedPattern
      ? lowerCheckedPatternArgument(lowerer, arg0)
      : lowerRegexPatternArgument(lowerer, arg0);
    // RegExpMatchArray | null maps to the string[] | null union by
    // itself; intern it directly when the checker's spelling doesn't —
    // or when it maps to something WIDER (an optional-chain call node
    // types `s?.match(re)` with the chain's `| undefined`; the intrinsic
    // itself answers string[] | null, and the chain wrapper widens).
    const exactT: IrType = {
      kind: "union",
      unionId: lowerer.unions.intern([arrayOf(STRING), { kind: "nullT" }]),
    };
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
    const resultT: IrType = mapped && typeEquals(mapped, exactT) ? mapped : exactT;
    // A result read like execGroups' skips the same captures when the
    // regex is not global (a global regex still answers every match).
    const mask = execResultCaptureMask(lowerer, call);
    if (mask !== null) {
      lowerer.regexGroupResults = true;
      return {
        kind: "regexIntrinsic",
        method: "matchGroups",
        receiver,
        args: [re, numLit(mask, loc), numLit(0, loc)],
        type: resultT,
        loc,
      };
    }
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
    const arg0 = call.arguments.nodes[0];
    if (!arg0 || lowerer.mapTypeOf(lowerer.typeOf(arg0))?.kind !== "regex") return null; // string-pattern form: the SC2020 fence
    if (call.arguments.nodes.length !== 1) return null;
    const receiver = lowerReceiver();
    const re = lowerer.lowerExprExpecting(arg0, { kind: "regex" });
    return {
      kind: "regexIntrinsic",
      method: matchAllRowsReadByElements(lowerer, call, false) ? "matchAllCaptures" : "matchAll",
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
    const arg0 = call.arguments.nodes[0];
    if (!arg0 || call.arguments.nodes.length !== 1) return null;
    const checkedPattern = isCheckedPatternArgument(lowerer, arg0);
    if (!checkedPattern && !isRegexPatternArgument(lowerer, arg0)) return null; // string-pattern form: the SC2020 fence
    const receiver = lowerReceiver();
    const re = checkedPattern
      ? lowerCheckedPatternArgument(lowerer, arg0)
      : lowerRegexPatternArgument(lowerer, arg0);
    return { kind: "regexIntrinsic", method: "search", receiver, args: [re], type: F64, loc };
  }
  if (receiverKind === "string" && (name === "replace" || name === "replaceAll")) {
    const chain = lowerReplaceCharChain(lowerer, call);
    if (chain) return chain;
  }
  if (
    receiverKind === "string" &&
    (name === "replace" || name === "replaceAll" || name === "split")
  ) {
    const arg0 = call.arguments.nodes[0];
    if (!arg0 || lowerer.mapTypeOf(lowerer.typeOf(arg0))?.kind !== "regex") return null;
    if (call.arguments.nodes.length > 2 || call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.unsupported(
        "SC1120",
        call,
        `the '${name}' regex form with surplus or spread arguments`,
      );
    const receiver = lowerReceiver();
    // Split's omitted or undefined limit is 2^32-1. Complete it here so
    // the LLVM backend and runtime have one required (regex, limit)
    // shape; an optional-number value selects the default at runtime.
    const args =
      name === "split"
        ? [
            lowerer.lowerExprExpecting(arg0, { kind: "regex" }),
            lowerSplitLimitArg(lowerer, call.arguments.nodes[1], loc),
          ]
        : [
            lowerer.lowerExprExpecting(arg0, { kind: "regex" }),
            call.arguments.nodes[1]
              ? lowerReplacerCallback(
                  lowerer,
                  call.arguments.nodes[1],
                  regexLiteralCapturesOf(arg0),
                )
              : dynUndefinedExpr(loc),
          ];
    if (name !== "split") {
      const replacement = args[1];
      if (replacement?.type.kind === "func" || replacement?.type.kind === "dyn") {
        return {
          kind: "libCall",
          fn: "regex.replaceCallback",
          args: [
            receiver,
            args[0]!,
            lowerer.coerceToExpected(replacement, DYN),
            { kind: "boolLit", value: name === "replaceAll", type: BOOL, loc },
          ],
          type: STRING,
          loc,
        };
      }
      const templateType = (type: IrType): boolean =>
        type.kind === "union"
          ? lowerer.unions.get(type.unionId)!.arms.every(templateType)
          : type.kind === "string" ||
            type.kind === "f64" ||
            type.kind === "bool" ||
            type.kind === "bigint" ||
            isUnitType(type);
      if (!replacement || !templateType(replacement.type)) {
        lowerer.unsupported(
          "SC1120",
          call.arguments.nodes[1] ?? call,
          "replacement values that are not callable or convertible to a string",
        );
      }
      // Array iteration can carry an explicit undefined even when the
      // checker spells string. RegExp replacement applies ToString once,
      // including when the pattern has no match; it does not call that value.
      args[1] = coerceStringSearchValue(lowerer, replacement, call.arguments.nodes[1]!, loc);
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

/** `s.replace(/&/g, "&amp;").replace(/</g, "&lt;")…`: consecutive global
 * replacements of one literal character by plain text (no `$`), where no
 * replacement text contains a character a later step replaces. Replacing
 * every character in one scan is then exactly the steps in turn, and the
 * inline regex objects (fresh per evaluation) leave no lastIndex to
 * observe, so one str.replaceChars call stands for the chain. Null for
 * anything else, including a single step. */
function lowerReplaceCharChain(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const steps: { char: string; text: string }[] = [];
  let node: ts.Expression = call;
  while (ts.isCallExpression(node) && node.questionDotToken === undefined) {
    const callee: ts.Expression = node.expression;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.questionDotToken !== undefined ||
      (callee.name.text !== "replace" && callee.name.text !== "replaceAll") ||
      node.arguments.nodes.length !== 2
    )
      break;
    const [pattern, replacement] = node.arguments.nodes;
    if (
      !pattern ||
      !ts.isRegularExpressionLiteral(pattern) ||
      !replacement ||
      !(ts.isStringLiteral(replacement) || ts.isNoSubstitutionTemplateLiteral(replacement)) ||
      replacement.text.includes("$") ||
      replacement.text.includes("\0") ||
      lowerer.mapTypeOf(lowerer.typeOf(callee.expression))?.kind !== "string" ||
      !lowerer.isStdlibMember(callee)
    )
      break;
    const char = globalCharPattern(pattern.text);
    if (char === null) break;
    steps.push({ char, text: replacement.text });
    node = callee.expression;
  }
  if (steps.length < 2 || steps.length > 16) return null;
  steps.reverse();
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      if (steps[j]!.char === steps[i]!.char || steps[i]!.text.includes(steps[j]!.char)) return null;
    }
  }
  const loc = locOf(call);
  return {
    kind: "libCall",
    fn: "str.replaceChars",
    args: [
      lowerer.lowerExprExpecting(node, STRING),
      strLit(steps.map((step) => step.char).join(""), loc),
      strLit(steps.map((step) => step.text).join("\0"), loc),
    ],
    type: STRING,
    loc,
  };
}

/** The character a `/c/g` literal matches, for one printable ASCII
 * character or an escaped syntax character; null otherwise. */
function globalCharPattern(text: string): string | null {
  if (!text.endsWith("/g")) return null;
  const body = text.slice(1, -2);
  const syntax = "\\^$.|?*+()[]{}/-";
  if (body.length === 1) {
    const code = body.charCodeAt(0);
    return code >= 0x20 && code < 0x7f && !syntax.includes(body) ? body : null;
  }
  if (body.length === 2 && body[0] === "\\" && syntax.includes(body[1]!)) return body[1]!;
  return null;
}

/** `s.slice(1, 4)` and friends → strIntrinsic. Null when this isn't an
 * ambient string method call (caller keeps its generic rejection).
 * Complete position defaults and conversions here before code generation. */
export function lowerStringMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  dynReceiver?: () => IrExpr,
  argumentNodes: readonly ts.Expression[] = call.arguments.nodes,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  if (dynReceiver === undefined && access.name.text === "localeCompare")
    return lowerLocaleCompareCall(lowerer, call, access);
  const entry = own(STR_METHODS, access.name.text);
  const indexMethod = STRING_INDEX_METHODS.has(access.name.text)
    ? (access.name.text as "at" | "codePointAt")
    : null;
  const replaceMethod = STRING_REPLACE_METHODS.has(access.name.text)
    ? (access.name.text as "replace" | "replaceAll")
    : null;
  const extraMethod = EXTRA_STRING_METHODS.has(access.name.text);
  if (!entry && !indexMethod && !replaceMethod && !extraMethod) return null;
  // A validated dyn receiver (`pkg.name.replace(...)` on a JSON.parse
  // value) arrives pre-extracted through `dynReceiver`; its checker type
  // is `any`, so the type/symbol gates don't apply — the dyn value's
  // methods can only BE the string intrinsics.
  if (dynReceiver === undefined) {
    const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
    const nullableString =
      receiverIr?.kind === "union" &&
      (lowerer.unions.get(receiverIr.unionId)?.arms.some((arm) => arm.kind === "string") ??
        false) &&
      (lowerer.unions
        .get(receiverIr.unionId)
        ?.arms.every((arm) => arm.kind === "string" || isUnitType(arm)) ??
        false);
    // `require.main?.filename.startsWith(...)`: the checker types the
    // receiver `string | undefined` (the chain's short-circuit arm), but
    // the entry-module fold lowers it to a compile-time STRING — the
    // suite harness's skip() shape. Everything else keeps the strict
    // string gate.
    if (
      receiverIr?.kind !== "string" &&
      !nullableString &&
      !isRequireMainFilename(lowerer, access.expression)
    )
      return null;
    if (!lowerer.isStdlibMember(access)) return null;
  }
  if (extraMethod && argumentNodes === call.arguments.nodes) {
    const receiver = dynReceiver
      ? dynReceiver()
      : lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
    return lowerExtraStringMethodCall(lowerer, call, access.name.text, receiver, access.expression);
  }
  // The lib declares optional parameters beyond some lowered forms; fence
  // those arities instead of passing arguments the runtime doesn't take.
  if (
    argumentNodes.length < (entry?.minArgs ?? 0) ||
    argumentNodes.length > (entry?.maxArgs ?? (replaceMethod ? 2 : 1))
  ) {
    lowerer.noLowering(
      `.${access.name.text} with ${argumentNodes.length} argument${argumentNodes.length === 1 ? "" : "s"} on strings`,
      call,
    );
  }
  const receiver = dynReceiver
    ? dynReceiver()
    : lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
  const loc = locOf(call);
  if (replaceMethod)
    return lowerStringReplacement(lowerer, call, replaceMethod, receiver, argumentNodes);
  if (indexMethod)
    return lowerStringIndexCall(
      lowerer,
      call,
      indexMethod,
      receiver,
      access.expression,
      argumentNodes,
    );
  if (!entry) return null;
  if (entry.method === "normalize") {
    const form = argumentNodes[0];
    const value = form
      ? lowerOptionalArgument(lowerer, form, STRING, strLit("NFC", loc))
      : strLit("NFC", loc);
    return {
      kind: "strIntrinsic",
      method: "normalize",
      receiver,
      args: [value],
      type: STRING,
      loc,
    };
  }
  if (entry.method === "split")
    return lowerStringSplitCall(lowerer, call, receiver, access.expression, argumentNodes);
  if (entry.method === "padStart" || entry.method === "padEnd") {
    return lowerStringPaddingCall(
      lowerer,
      call,
      entry.method,
      receiver,
      access.expression,
      argumentNodes,
    );
  }
  const searchMethod =
    entry.method === "indexOf" ||
    entry.method === "includes" ||
    entry.method === "startsWith" ||
    entry.method === "endsWith";
  if (searchMethod && argumentNodes.length < 2) {
    const needle = lowerStringSearchArgument(lowerer, argumentNodes[0], loc);
    return {
      kind: "strIntrinsic",
      method: entry.method,
      receiver,
      args: [needle],
      type: entry.result,
      loc,
    };
  }
  if (searchMethod && argumentNodes.length === 2) {
    const needleNode = argumentNodes[0]!;
    const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, needleNode);
    let needle = undefinedArg
      ? defaultAfterUndefined(undefinedArg, strLit("undefined", loc))
      : lowerer.lowerExpr(needleNode);
    if (isUnitType(needle.type)) needle = coerceStringSearchValue(lowerer, needle, needleNode, loc);
    const scalarUnion =
      needle.type.kind === "union" &&
      (lowerer.unions
        .get(needle.type.unionId)
        ?.arms.every(
          (arm) =>
            arm.kind === "string" ||
            arm.kind === "f64" ||
            arm.kind === "bool" ||
            arm.kind === "bigint" ||
            isUnitType(arm),
        ) ??
        false);
    const scalarNeedle =
      needle.type.kind === "f64" ||
      needle.type.kind === "bool" ||
      needle.type.kind === "bigint" ||
      scalarUnion;
    if (needle.type.kind !== "string" && needle.type.kind !== "dyn" && !scalarNeedle) {
      lowerer.noLowering(`.${entry.method} with '${lowerer.fmt(needle.type)}' search values`, call);
    }
    const defaultPosition: IrExpr =
      entry.method === "endsWith"
        ? { kind: "bin", op: "/", left: numLit(1, loc), right: numLit(0, loc), type: F64, loc }
        : numLit(0, loc);
    const position = lowerPositionArgument(lowerer, argumentNodes[1], defaultPosition);
    if (needle.type.kind === "string" && position.type.kind === "f64") {
      return {
        kind: "strIntrinsic",
        method: entry.method,
        receiver,
        args: [needle, position],
        type: entry.result,
        loc,
      };
    }
    const key = `str.positions:${entry.method}:${typeKey(needle.type)}:${typeKey(position.type)}`;
    let helper = lowerer.valueHelpers.get(key);
    if (!helper) {
      helper = keyedHelperName(lowerer, "%str.positions", key);
      const params = [receiver, needle, position].map((arg, index) => ({
        localId: `arg.${index}`,
        name: `arg${index}`,
        type: arg.type,
      }));
      const coerceNeedle = needle.type.kind !== "string";
      const search: IrExpr = coerceNeedle
        ? varRef("search.0", STRING, loc)
        : varRef("arg.1", STRING, loc);
      const result: IrExpr = {
        kind: "strIntrinsic",
        method: entry.method,
        receiver: varRef("arg.0", STRING, loc),
        args: [
          search,
          positionNumber(
            lowerer,
            varRef("arg.2", position.type, loc),
            defaultPosition,
            argumentNodes[1]!,
            "string position",
          ),
        ],
        type: entry.result,
        loc,
      };
      const locals = params.map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      }));
      const body: IrStmt[] = [];
      if (coerceNeedle) {
        const value = varRef("arg.1", needle.type, loc);
        const init: IrExpr =
          needle.type.kind === "dyn"
            ? { kind: "libCall", fn: "dyn.toStringCoerce", args: [value], type: STRING, loc }
            : coerceStringSearchValue(lowerer, value, needleNode, loc);
        locals.push({ id: "search.0", name: "search", type: STRING, mutable: false });
        body.push({ kind: "varDecl", localId: "search.0", init, loc });
      }
      body.push({ kind: "return", value: result, loc });
      lowerer.valueHelpers.set(key, helper);
      lowerer.liftedFns.push({
        name: helper,
        params,
        returnType: entry.result,
        locals,
        body,
        loc,
      });
    }
    return {
      kind: "call",
      callee: helper,
      args: [receiver, needle, position],
      type: entry.result,
      loc,
    };
  }
  if (
    entry.method === "charAt" ||
    entry.method === "charCodeAt" ||
    entry.method === "slice" ||
    entry.method === "substring" ||
    entry.method === "repeat"
  ) {
    const defaults: IrExpr[] = [numLit(0, loc)];
    if (entry.method === "slice" || entry.method === "substring") {
      defaults.push({
        kind: "bin",
        op: "/",
        left: numLit(1, loc),
        right: numLit(0, loc),
        type: F64,
        loc,
      });
    }
    const args = defaults.map((value, index) =>
      lowerPositionArgument(lowerer, argumentNodes[index], value),
    );
    const subject = entry.method === "repeat" ? "string repeat count" : "string position";
    // Keep ordinary numeric calls on the direct intrinsic path, including the

    if (args.every((arg) => arg.type.kind === "f64")) {
      return {
        kind: "strIntrinsic",
        method: entry.method,
        receiver,
        args,
        type: entry.result,
        loc,
      };
    }
    // A helper evaluates all arguments before conversions can invoke hooks or
    // throw. Its parameters also give owned strings/unions a per-call lifetime
    // when the call occurs in a loop condition or short-circuit expression.
    const key = `str.positions:${entry.method}:${args.map((arg) => typeKey(arg.type)).join(":")}`;
    let helper = lowerer.valueHelpers.get(key);
    if (!helper) {
      helper = keyedHelperName(lowerer, "%str.positions", key);
      const params = [receiver, ...args].map((arg, index) => ({
        localId: `arg.${index}`,
        name: `arg${index}`,
        type: arg.type,
      }));
      const result: IrExpr = {
        kind: "strIntrinsic",
        method: entry.method,
        receiver: varRef("arg.0", STRING, loc),
        args: args.map((arg, index) =>
          positionNumber(
            lowerer,
            varRef(`arg.${index + 1}`, arg.type, loc),
            defaults[index]!,
            argumentNodes[index] ?? call,
            subject,
          ),
        ),
        type: entry.result,
        loc,
      };
      lowerer.valueHelpers.set(key, helper);
      lowerer.liftedFns.push({
        name: helper,
        params,
        returnType: entry.result,
        locals: params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        body: [{ kind: "return", value: result, loc }],
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver, ...args], type: entry.result, loc };
  }
  const args = argumentNodes.map((a) => lowerer.lowerExpr(a));
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
 * select collations beyond the default). Lowers to the runtime's
 * root-locale collation (scr_str_locale_compare): Node's ICU order for
 * Latin-script text — letters before case and accents ("a" < "B", "ä" <
 * "z") — and code-point order for other scripts, the documented limit.
 * Null when the receiver isn't a stdlib string (caller keeps its generic
 * rejection). */
function lowerLocaleCompareCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverIr?.kind !== "string") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  if (call.arguments.nodes.length !== 1) {
    lowerer.noLowering(
      `.localeCompare with ${call.arguments.nodes.length} arguments`,
      call,
      "the locales/options parameters select ICU collations that have no lowering — " +
        "pass exactly the comparison string",
    );
  }
  const receiver = lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
  const arg = lowerer.lowerExpr(call.arguments.nodes[0]!);
  if (arg.type.kind !== "string")
    lowerer.badType(call.arguments.nodes[0]!, lowerer.typeOf(call.arguments.nodes[0]!));
  return { kind: "libCall", fn: "str.localeCompare", args: [receiver, arg], type: F64, loc };
}

/* ── String.prototype / Number.prototype members beyond the core tables ──
 * substr, the locale case pair, the Annex B HTML methods, toPrecision and
 * toExponential(fractionDigits) on typed receivers, plus the kind dispatch
 * for every String/Number method a checked-dynamic receiver can name
 * whose runtime dispatch had no answer (`character.codePointAt(0)` in a
 * JS package, `n.toPrecision(3)` on a JS-inferred number). Each path
 * replaces a compile-time refusal, a runtime 'not supported yet' fence or
 * Node's is-not-a-function answer for a real method, so programs that
 * never spell these names compile exactly as before. */

/** String.prototype members (Annex B included) whose typed-receiver
 * lowering lives here. */
export const EXTRA_STRING_METHODS: ReadonlySet<string> = new Set([
  "concat",
  "substr",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "anchor",
  "big",
  "blink",
  "bold",
  "fixed",
  "fontcolor",
  "fontsize",
  "italics",
  "link",
  "small",
  "strike",
  "sub",
  "sup",
]);

/** String methods a dyn receiver dispatches by runtime kind here: a string
 * runs the typed lowering, every other kind takes the runtime dispatch
 * (an object's own member, Node's is-not-a-function otherwise). Only names
 * no other dyn kind's prototype declares: the shared ones (at, concat,
 * slice, ...) already dispatch at run time for arrays, and a kind test in
 * front of them would change array code that works today. The Annex B
 * HTML names (bold, italics, link, ...) stay out too: chalk-style builders
 * call them on functions and objects, whose calls must stay as they are. */
const DYN_STRING_KIND_METHODS: ReadonlySet<string> = new Set([
  "substr",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "codePointAt",
  "isWellFormed",
  "toWellFormed",
  "trimLeft",
  "trimRight",
]);

/** Number methods a dyn receiver dispatches by runtime kind here. */
const DYN_NUMBER_KIND_METHODS: ReadonlySet<string> = new Set(["toPrecision", "toExponential"]);

/** Annex B CreateHTML: the tag and the attribute (null for none). */
const HTML_METHODS: Readonly<Record<string, readonly [string, string | null]>> = {
  anchor: ["a", "name"],
  big: ["big", null],
  blink: ["blink", null],
  bold: ["b", null],
  fixed: ["tt", null],
  fontcolor: ["font", "color"],
  fontsize: ["font", "size"],
  italics: ["i", null],
  link: ["a", "href"],
  small: ["small", null],
  strike: ["strike", null],
  sub: ["sub", null],
  sup: ["sup", null],
};

export function isDynPrimitiveKindMethod(name: string): boolean {
  return DYN_STRING_KIND_METHODS.has(name) || DYN_NUMBER_KIND_METHODS.has(name);
}

/** Evaluate `value` once into a hidden local (effect-free reads stay,
 * unless `snapshot` asks for the value a variable holds now). */
function hoist(
  lowerer: Lowerer,
  value: IrExpr,
  stmts: IrStmt[],
  name: string,
  snapshot = false,
): IrExpr {
  if (
    (value.kind === "varRef" && !snapshot) ||
    value.kind === "numLit" ||
    value.kind === "strLit" ||
    value.kind === "boolLit" ||
    value.kind === "unitLit"
  )
    return value;
  const local = lowerer.declareHiddenLocal(name, value.type);
  stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
  return varRef(local.id, value.type, value.loc);
}

function seq(stmts: IrStmt[], result: IrExpr): IrExpr {
  return stmts.length === 0
    ? result
    : { kind: "seqExpr", stmts, result, type: result.type, loc: result.loc };
}

/** ToString of a method argument: the dyn coercion (symbols throw), the
 * typed conversions elsewhere. */
function stringArg(lowerer: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  if (value.type.kind === "dyn")
    return {
      kind: "libCall",
      fn: "dyn.toStringCoerce",
      args: [value],
      type: STRING,
      loc: value.loc,
    };
  return lowerer.ensureString(value, node);
}

/** An optional numeric argument: its ToNumber value and whether it was
 * supplied (undefined counts as absent, as the spec's checks do). */
function optionalNumber(
  lowerer: Lowerer,
  value: IrExpr | undefined,
  node: ts.Expression,
  stmts: IrStmt[],
  subject: string,
  loc: SrcLoc,
): { value: IrExpr; has: IrExpr } {
  if (!value || value.type.kind === "undefinedT" || value.type.kind === "void")
    return { value: numLit(0, loc), has: boolLit(false, loc) };
  if (
    value.type.kind === "f64" ||
    value.type.kind === "string" ||
    value.type.kind === "bool" ||
    value.type.kind === "nullT"
  )
    return {
      value: positionNumber(lowerer, value, numLit(0, loc), node, subject),
      has: boolLit(true, loc),
    };
  const boxed =
    value.type.kind === "dyn"
      ? value
      : hoist(lowerer, lowerer.coerceToExpected(value, DYN), stmts, "%numArg");
  const absent: IrExpr = { kind: "dynTest", test: "undefined", value: boxed, type: BOOL, loc };
  return {
    value: positionNumber(lowerer, boxed, numLit(0, loc), node, subject),
    has: { kind: "unary", op: "!", operand: absent, type: BOOL, loc },
  };
}

/** The typed result of a String.prototype member over a STRING receiver
 * and already evaluated arguments, or null when the name is not one of
 * this module's. */
function buildStringMethod(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  s: IrExpr,
  args: IrExpr[],
  receiverNode: ts.Node,
  stmts: IrStmt[],
): IrExpr | null {
  const loc = locOf(call);
  const node = (i: number): ts.Expression => call.arguments.nodes[i] ?? call;
  // concat(...values): each argument's ToString, in order, after all of
  // them evaluated.
  if (name === "concat") {
    return args
      .map((arg, i) => stringArg(lowerer, arg, node(i)))
      .reduce((left, right) => ({ kind: "strConcat", left, right, type: STRING, loc }), s);
  }
  if (name === "substr") {
    const start = args[0]
      ? positionNumber(lowerer, args[0], numLit(0, loc), node(0), "substr start")
      : numLit(0, loc);
    const length = optionalNumber(lowerer, args[1], node(1), stmts, "substr length", loc);
    return {
      kind: "libCall",
      fn: "str.substr",
      args: [s, start, length.value, length.has],
      type: STRING,
      loc,
    };
  }
  if (name === "toLocaleLowerCase" || name === "toLocaleUpperCase") {
    const locales = args[0] ? lowerer.coerceToExpected(args[0], DYN) : dynUndefinedExpr(loc);
    return {
      kind: "libCall",
      fn: "str.localeCase",
      args: [s, locales, boolLit(name === "toLocaleUpperCase", loc)],
      type: STRING,
      loc,
    };
  }
  const html = Object.hasOwn(HTML_METHODS, name) ? HTML_METHODS[name] : undefined;
  if (html) {
    const [tag, attribute] = html;
    const subject = hoist(lowerer, s, stmts, "%htmlSubject");
    const pieces: IrExpr[] = [strLit(`<${tag}`, loc)];
    if (attribute !== null) {
      const text = args[0] ? stringArg(lowerer, args[0], node(0)) : strLit("undefined", loc);
      pieces.push(strLit(` ${attribute}="`, loc));
      pieces.push({
        kind: "libCall",
        fn: "str.replaceLiteral",
        args: [text, strLit('"', loc), strLit("&quot;", loc), boolLit(true, loc)],
        type: STRING,
        loc,
      });
      pieces.push(strLit('"', loc));
    }
    pieces.push(strLit(">", loc), subject, strLit(`</${tag}>`, loc));
    return pieces.reduce((left, right) => ({ kind: "strConcat", left, right, type: STRING, loc }));
  }
  if (name === "codePointAt")
    return stringIndexHelperCall(
      lowerer,
      call,
      name,
      s,
      receiverNode,
      args[0] ?? numLit(0, loc),
      call.arguments.nodes[0],
    );
  if (name === "isWellFormed" || name === "toWellFormed")
    return {
      kind: "strIntrinsic",
      method: name,
      receiver: s,
      args: [],
      type: name === "isWellFormed" ? BOOL : STRING,
      loc,
    };
  if (name === "trimLeft" || name === "trimRight")
    return {
      kind: "strIntrinsic",
      method: name === "trimLeft" ? "trimStart" : "trimEnd",
      receiver: s,
      args: [],
      type: STRING,
      loc,
    };
  return null;
}

/** The typed result of toPrecision/toExponential over an F64 receiver. */
function buildNumberMethod(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  x: IrExpr,
  args: IrExpr[],
  stmts: IrStmt[],
): IrExpr | null {
  const loc = locOf(call);
  if (name !== "toPrecision" && name !== "toExponential") return null;
  const digits = optionalNumber(
    lowerer,
    args[0],
    call.arguments.nodes[0] ?? call,
    stmts,
    `${name} digits`,
    loc,
  );
  if (name === "toPrecision")
    return {
      kind: "libCall",
      fn: "num.toPrecision",
      args: [x, digits.value, digits.has],
      type: STRING,
      loc,
    };
  const shortest: IrExpr = {
    kind: "libCall",
    fn: "num.toExponential",
    args: [x],
    type: STRING,
    loc,
  };
  if (digits.has.kind === "boolLit" && !digits.has.value) return shortest;
  const fixed: IrExpr = {
    kind: "libCall",
    fn: "num.toExponentialDigits",
    args: [x, digits.value],
    type: STRING,
    loc,
  };
  if (digits.has.kind === "boolLit") return fixed;
  return { kind: "ternary", cond: digits.has, then: fixed, else_: shortest, type: STRING, loc };
}

/** Operand kinds whose string and number conversions run no program code. */
const PLAIN_CONVERSION_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "f64",
  "bigint",
  "string",
  "bool",
  "symbol",
  "nullT",
  "undefinedT",
]);

/** Evaluate the receiver (when given) and the call's arguments, in order,
 * into hidden locals. A variable read stays a read unless a later operand
 * can assign the variable, or an argument's conversion can run program
 * code: the methods convert their arguments after evaluating all of them
 * (an object's toString or valueOf). */
function evaluatedOperands(
  lowerer: Lowerer,
  call: ts.CallExpression,
  stmts: IrStmt[],
  expected: IrType | undefined,
  receiver?: { value: IrExpr; name: string },
): { receiver: IrExpr | undefined; args: IrExpr[] } {
  const args = call.arguments.nodes.map((arg) =>
    expected ? lowerer.lowerExprExpecting(arg, expected) : lowerer.lowerExpr(arg),
  );
  const conversionsRunCode = args.some((arg) => !PLAIN_CONVERSION_KINDS.has(arg.type.kind));
  const mayChange = (from: number): boolean =>
    conversionsRunCode || !args.slice(from).every(isSafeToDiscard);
  return {
    receiver: receiver && hoist(lowerer, receiver.value, stmts, receiver.name, mayChange(0)),
    args: args.map((arg, i) => hoist(lowerer, arg, stmts, "%methodArg", mayChange(i + 1))),
  };
}

/** A typed STRING receiver calling one of EXTRA_STRING_METHODS: receiver,
 * then arguments, then the method's own conversions — the spec order. */
export function lowerExtraStringMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  receiver: IrExpr,
  receiverNode: ts.Node,
): IrExpr | null {
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const stmts: IrStmt[] = [];
  const operands = evaluatedOperands(lowerer, call, stmts, undefined, {
    value: receiver,
    name: "%stringReceiver",
  });
  const s = operands.receiver!;
  const result = buildStringMethod(lowerer, call, name, s, operands.args, receiverNode, stmts);
  return result ? seq(stmts, result) : null;
}

/** A typed F64 receiver calling toPrecision(p) or toExponential(f). */
export function lowerExtraNumberMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  receiver: IrExpr,
): IrExpr | null {
  if (call.arguments.nodes.some(ts.isSpreadElement) || call.arguments.nodes.length > 1) return null;
  if (name !== "toPrecision" && !(name === "toExponential" && call.arguments.nodes.length === 1))
    return null;
  const stmts: IrStmt[] = [];
  const operands = evaluatedOperands(lowerer, call, stmts, undefined, {
    value: receiver,
    name: "%numberReceiver",
  });
  const x = operands.receiver!;
  const result = buildNumberMethod(lowerer, call, name, x, operands.args, stmts);
  return result ? seq(stmts, result) : null;
}

/** `recv.m(args)` on a checked-dynamic receiver for a String/Number method
 * the runtime dispatch cannot answer: the receiver and arguments evaluate
 * once, a string (or number) receiver runs the typed lowering, and every
 * other kind keeps the runtime dispatch's answer. Null for other names. */
export function lowerDynPrimitiveMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
  calleeName: string,
  recv: IrExpr,
): IrExpr | null {
  const stringMethod = DYN_STRING_KIND_METHODS.has(name);
  const numberMethod = DYN_NUMBER_KIND_METHODS.has(name);
  if (!stringMethod && !numberMethod) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const local = lowerer.declareHiddenLocal("%primitiveReceiver", DYN);
  stmts.push({ kind: "varDecl", localId: local.id, init: recv, loc });
  const r = varRef(local.id, DYN, loc);
  const { args } = evaluatedOperands(lowerer, call, stmts, DYN);
  let result: IrExpr = {
    kind: "dynInvoke",
    recv: r,
    method: name,
    calleeName,
    args,
    type: DYN,
    loc,
  };
  const branch = (
    test: "string" | "number",
    build: (value: IrExpr, branchStmts: IrStmt[]) => IrExpr | null,
  ): void => {
    const branchStmts: IrStmt[] = [];
    const value: IrExpr = {
      kind: "dynCheck",
      value: r,
      type: test === "string" ? STRING : F64,
      loc,
    };
    const built = build(value, branchStmts);
    if (!built) return;
    result = {
      kind: "ternary",
      cond: { kind: "dynTest", test, value: r, type: BOOL, loc },
      then: { kind: "dynFrom", value: seq(branchStmts, built), type: DYN, loc },
      else_: result,
      type: DYN,
      loc,
    };
  };
  if (numberMethod)
    branch("number", (x, branchStmts) =>
      buildNumberMethod(lowerer, call, name, x, args, branchStmts),
    );
  if (stringMethod)
    branch("string", (s, branchStmts) =>
      buildStringMethod(lowerer, call, name, s, args, call.expression, branchStmts),
    );
  return seq(stmts, result);
}

/** Whether the pattern of `match` or `search` is a RegExp, or a RegExp that
 * may be undefined (`s.match(patterns[i])` under noUncheckedIndexedAccess). */
function isRegexPatternArgument(lowerer: Lowerer, node: ts.Expression): boolean {
  const t = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (t?.kind === "regex") return true;
  if (t?.kind !== "union") return false;
  const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
  return (
    arms.length === 2 &&
    arms.some((arm) => arm.kind === "regex") &&
    arms.some((arm) => arm.kind === "undefinedT")
  );
}

/** True when a `match` or `search` pattern is checker-untyped (`any` or
 * `unknown`), so its runtime value decides the protocol. */
function isCheckedPatternArgument(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isSpreadElement(node)) return false;
  return (lowerer.typeOf(node).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** An untyped `match` or `search` pattern as a RegExp, chosen at run time as
 * Node does: a RegExp is used as is (its lastIndex state included), and any
 * other value builds `new RegExp(value)` (undefined is the empty pattern,
 * other values convert with ToString). */
function lowerCheckedPatternArgument(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const loc = locOf(node);
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "regex") return value;
  const checked = lowerer.coerceInto(node, value, DYN);
  const local = lowerer.declareHiddenLocal("%matchPattern", DYN);
  const ref = varRef(local.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: checked, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "libCall", fn: "dyn.nativeRegexIs", args: [ref], type: BOOL, loc },
      then: lowerer.coerceInto(node, ref, REGEX),
      else_: {
        kind: "libCall",
        fn: "regex.newChecked",
        args: [ref, dynUndefinedExpr(loc)],
        type: REGEX,
        loc,
      },
      type: REGEX,
      loc,
    },
    type: REGEX,
    loc,
  };
}

/** The pattern of `match` or `search` as a RegExp: an undefined pattern is
 * `new RegExp(undefined)`, the empty pattern, as in Node. */
function lowerRegexPatternArgument(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const regex: IrType = { kind: "regex" };
  const empty: IrExpr = {
    kind: "regexLit",
    pattern: "(?:)",
    flags: "",
    type: regex,
    loc: locOf(node),
  };
  return lowerOptionalArgument(lowerer, node, regex, empty);
}
