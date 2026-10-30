import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  REGEX,
  STRING,
  arrayOf,
  isUnitType,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";
import { dynUndefinedExpr, numLit, strLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import { locOf } from "../../program.js";
import { PLAIN_SEARCH_CAPTURES, lowerReplacerCallback } from "./replacer-params.js";
import type { Lowerer } from "../lowerer.js";
import {
  coerceStringSearchValue,
  defaultAfterUndefined,
  lowerStaticallyUndefinedArgument,
} from "../optional-arguments.js";

/** String search does not interpret regex syntax or capture substitutions.
 * A string replacement expands in one runtime pass; a callback runs through
 * a helper that receives evaluated arguments and owns its chunks until join.
 * Callbacks see the original immutable subject and UTF-16 match offset. */
export function lowerStringReplacement(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "replace" | "replaceAll",
  receiver: IrExpr,
  args: readonly ts.Expression[],
): IrExpr {
  if (args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`string .${method} with spread or extra arguments`, call);
  }
  const loc = locOf(call);
  const primitive = (type: IrType): boolean =>
    type.kind === "union"
      ? lowerer.unions.get(type.unionId)!.arms.every(primitive)
      : type.kind === "string" ||
        type.kind === "f64" ||
        type.kind === "bool" ||
        type.kind === "bigint" ||
        isUnitType(type);
  const argument = (
    node: ts.Expression | undefined,
    callback: boolean,
    plainSearch = false,
  ): IrExpr => {
    if (!node) return strLit("undefined", loc);
    const absent = lowerStaticallyUndefinedArgument(lowerer, node);
    if (absent) return defaultAfterUndefined(absent, strLit("undefined", loc));
    // A plain search passes (match, offset, subject).
    const value = plainSearch
      ? lowerReplacerCallback(lowerer, node, PLAIN_SEARCH_CAPTURES)
      : lowerer.lowerExpr(node);
    if (value.type.kind === "dyn" || (callback && value.type.kind === "func")) return value;
    if (!primitive(value.type)) {
      lowerer.noLowering(
        `string .${method} with '${lowerer.fmt(value.type)}' ${callback ? "replacement" : "search"} values`,
        node,
        "use a primitive search value and a primitive replacement or a typed callback",
      );
    }
    return coerceStringSearchValue(lowerer, value, node, loc);
  };
  const search = argument(args[0], false);
  const replacement = argument(args[1], true, search.type.kind !== "dyn");
  if (search.type.kind === "dyn" || replacement.type.kind === "dyn") {
    // Evaluate all inputs once before choosing the search protocol. Regexes
    // retain their native pattern; plain values use the string-search helper.
    // A typed callback receives the regex match's arguments or the plain
    // search's (match, offset, subject).
    const values = [receiver, search, replacement];
    const locals = values.map((value) => lowerer.declareHiddenLocal("%replaceArg", value.type));
    const refs = locals.map((local) => varRef(local.id, local.type, loc));
    const callback = replacement.type.kind === "func";
    const checkedReplacement =
      replacement.type.kind === "dyn"
        ? lowerer.coerceInto(args[1] ?? call, refs[2]!, STRING)
        : refs[2]!;
    const plainSearch = lowerer.ensureString(refs[1]!, args[0] ?? call);
    const plain = lowerStringReplacementValues(
      lowerer,
      call,
      method,
      refs[0]!,
      plainSearch,
      checkedReplacement,
    );
    const result: IrExpr =
      search.type.kind === "dyn"
        ? {
            kind: "ternary",
            cond: { kind: "libCall", fn: "dyn.nativeRegexIs", args: [refs[1]!], type: BOOL, loc },
            then: callback
              ? {
                  kind: "libCall",
                  fn: "regex.replaceCallback",
                  args: [
                    refs[0]!,
                    lowerer.coerceInto(args[0] ?? call, refs[1]!, REGEX),
                    lowerer.coerceToExpected(refs[2]!, DYN),
                    { kind: "boolLit", value: method === "replaceAll", type: BOOL, loc },
                  ],
                  type: STRING,
                  loc,
                }
              : {
                  kind: "regexIntrinsic",
                  method,
                  receiver: refs[0]!,
                  args: [lowerer.coerceInto(args[0] ?? call, refs[1]!, REGEX), checkedReplacement],
                  type: STRING,
                  loc,
                },
            else_: plain,
            type: STRING,
            loc,
          }
        : plain;
    return {
      kind: "seqExpr",
      stmts: values.map((value, index): IrStmt => ({
        kind: "varDecl",
        localId: locals[index]!.id,
        init: value,
        loc,
      })),
      result,
      type: STRING,
      loc,
    };
  }
  return lowerStringReplacementValues(lowerer, call, method, receiver, search, replacement);
}

function lowerStringReplacementValues(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "replace" | "replaceAll",
  receiver: IrExpr,
  search: IrExpr,
  replacement: IrExpr,
): IrExpr {
  const loc = locOf(call);
  if (replacement.type.kind === "string") {
    // A replacement template expands in one runtime pass over the subject.
    return {
      kind: "libCall",
      fn: "str.replaceLiteral",
      args: [
        receiver,
        search,
        replacement,
        { kind: "boolLit", value: method === "replaceAll", type: BOOL, loc },
      ],
      type: STRING,
      loc,
    };
  }
  const callback = replacement.type;
  if (callback.kind !== "func") {
    throw new InternalCompilerError(`string .${method} replacement of type ${callback.kind}`);
  }
  // A checked parameter receives the boxed argument (undefined after the
  // subject), and a checked, number or boolean result converts with
  // ToString.
  const full = [STRING, F64, STRING];
  const ret = callback.ret.kind;
  if (
    (ret !== "string" && ret !== "dyn" && ret !== "f64" && ret !== "bool") ||
    !callback.params.every(
      (type, index) =>
        type.kind === "dyn" || (index < full.length && typeEquals(type, full[index]!)),
    )
  ) {
    lowerer.noLowering(
      `string .${method} callback signature`,
      call.arguments.nodes[1] ?? call,
      "use a callback returning string with a prefix of (match: string, offset: number, subject: string)",
    );
  }
  const key = `str.${method}:${typeKey(replacement.type)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%str.${method}`, key);
    lowerer.valueHelpers.set(key, helper);
    const subject = varRef("s.0", STRING, loc);
    const needle = varRef("search.0", STRING, loc);
    const replace = varRef("replace.0", replacement.type, loc);
    const cursor = varRef("cursor.0", F64, loc);
    const end = varRef("end.0", F64, loc);
    const match = varRef("match.0", F64, loc);
    const size = varRef("size.0", F64, loc);
    const chunksType = arrayOf(STRING);
    const chunks = varRef("chunks.0", chunksType, loc);
    const builder = stringBuilder(loc, chunks);
    const result: IrExpr = {
      kind: "callValue",
      callee: replace,
      args: callback.params.map((type, index) => {
        const arg = [needle, match, subject][index];
        if (arg === undefined) return dynUndefinedExpr(loc);
        return type.kind === "dyn" ? lowerer.coerceToExpected(arg, DYN) : arg;
      }),
      type: callback.ret,
      loc,
    };
    const value: IrExpr =
      ret === "dyn"
        ? { kind: "libCall", fn: "dyn.toStringCoerce", args: [result], type: STRING, loc }
        : lowerer.ensureString(result, call);
    const stop: IrStmt = { kind: "break", loc };
    const body: IrStmt[] = [
      builder.declare("chunks.0", { kind: "arrayLit", elems: [], type: chunksType, loc }),
      builder.declare("cursor.0", numLit(0, loc)),
      builder.declare("end.0", numLit(0, loc)),
      builder.declare("size.0", builder.length(needle)),
      {
        kind: "while",
        cond: builder.compare("<=", cursor, builder.length(subject)),
        body: [
          builder.declare("match.0", {
            kind: "strIntrinsic",
            method: "indexOf",
            receiver: subject,
            args: [needle, cursor],
            type: F64,
            loc,
          }),
          {
            kind: "if",
            cond: builder.compare("<", match, numLit(0, loc)),
            then: [stop],
            else_: null,
            loc,
          },
          builder.append(builder.slice(subject, end, match)),
          builder.append(value),
          builder.assign("end.0", builder.add(match, size)),
          ...(method === "replace"
            ? [stop]
            : [
                builder.assign(
                  "cursor.0",
                  builder.add(match, {
                    kind: "ternary",
                    cond: builder.compare("===", size, numLit(0, loc)),
                    then: numLit(1, loc),
                    else_: size,
                    type: F64,
                    loc,
                  }),
                ),
              ]),
        ],
        loc,
      },
      builder.append(builder.slice(subject, end, undefined)),
      { kind: "return", value: builder.join(), loc },
    ];
    const params = [
      { localId: "s.0", name: "s", type: STRING },
      { localId: "search.0", name: "search", type: STRING },
      { localId: "replace.0", name: "replace", type: replacement.type },
    ];
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
        { id: "chunks.0", name: "chunks", type: chunksType, mutable: false },
        ...["cursor", "end", "match", "size"].map((name) => ({
          id: `${name}.0`,
          name,
          type: F64,
          mutable: true,
        })),
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, search, replacement], type: STRING, loc };
}

function stringBuilder(loc: SrcLoc, chunks: IrExpr) {
  return {
    declare(localId: string, init: IrExpr): IrStmt {
      return { kind: "varDecl", localId, init, loc };
    },
    assign(localId: string, value: IrExpr): IrStmt {
      return { kind: "assign", localId, value, loc };
    },
    add(left: IrExpr, right: IrExpr): IrExpr {
      return { kind: "bin", op: "+", left, right, type: F64, loc };
    },
    compare(op: "<" | "<=" | "===", left: IrExpr, right: IrExpr): IrExpr {
      return { kind: "bin", op, left, right, type: BOOL, loc };
    },
    length(receiver: IrExpr): IrExpr {
      return { kind: "strIntrinsic", method: "length", receiver, args: [], type: F64, loc };
    },
    slice(receiver: IrExpr, start: IrExpr, end: IrExpr | undefined): IrExpr {
      return {
        kind: "strIntrinsic",
        method: "slice",
        receiver,
        args: end ? [start, end] : [start],
        type: STRING,
        loc,
      };
    },
    append(value: IrExpr): IrStmt {
      return {
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "push",
          receiver: chunks,
          args: [value],
          type: F64,
          loc,
        },
        loc,
      };
    },
    join(): IrExpr {
      return {
        kind: "arrIntrinsic",
        method: "join",
        receiver: chunks,
        args: [strLit("", loc)],
        type: STRING,
        loc,
      };
    },
  };
}
