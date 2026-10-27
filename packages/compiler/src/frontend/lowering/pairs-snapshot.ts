import { keyedHelperName } from "./stable-names.js";
import {
  arrayOf,
  BOOL,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrParam,
  type IrType,
  STRING,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** Intern a helper that materializes a pure string-index record from a flat
 * `[key, value, ...]` array. Distinct HTTP records use the pair keys and
 * look up each key's full string[] value. */
export function pairsSnapshotHelper(
  lowerer: Lowerer,
  shapeId: string,
  loc: SrcLoc,
  options: {
    keyPrefix: string;
    libCall: IrLibFn;
    params?: IrParam[];
    callArgs?: IrExpr[];
    indexValueOk?: (indexValue: IrType) => boolean;
    lookupValue?: "http.reqHeaderValues" | "http.reqTrailerValues";
    /** A key whose value is the string[] arm, read through `libCall`
     * (set-cookie in `{ ...req.headers }`), when the slot union has one. */
    listKey?: { name: string; libCall: IrLibFn };
  },
): string | null {
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple || shape.fields.length > 0 || !shape.indexValue) return null;
  const indexValue = shape.indexValue;
  const indexValueOk = options.indexValueOk;
  if (indexValueOk && !indexValueOk(indexValue)) return null;
  if (indexValue.kind !== "union") return null;
  const stringTag = options.lookupValue ? -1 : lowerer.armTag(indexValue.unionId, STRING);
  if (options.lookupValue) {
    const arrayValue = lowerer.withUndefinedArm(arrayOf(STRING));
    if (arrayValue.kind !== "union" || indexValue.unionId !== arrayValue.unionId) return null;
  } else if (stringTag < 0) return null;
  const listTag =
    options.listKey && !options.lookupValue
      ? lowerer.armTag(indexValue.unionId, arrayOf(STRING))
      : -1;
  const key = `${options.keyPrefix}.snapshot:${shapeId}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%${options.keyPrefix}.snapshot`, key);
  lowerer.valueHelpers.set(key, name);
  const recordType: IrType = { kind: "record", shapeId };
  const pairsType = arrayOf(STRING);
  const pairAt = (offset: number): IrExpr => ({
    kind: "arrayGet",
    arr: varRef("ps.0", pairsType, loc),
    index:
      offset === 0
        ? varRef("i.0", F64, loc)
        : {
            kind: "bin",
            op: "+",
            left: varRef("i.0", F64, loc),
            right: numLit(offset, loc),
            type: F64,
            loc,
          },
    type: STRING,
    loc,
  });
  lowerer.liftedFns.push({
    name,
    params: options.params ?? [],
    returnType: recordType,
    locals: [
      ...(options.params ?? []).map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      })),
      { id: "ps.0", name: "ps", type: pairsType, mutable: false },
      { id: "out.0", name: "out", type: recordType, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "ps.0",
        init: {
          kind: "libCall",
          fn: options.libCall,
          args: options.callArgs ?? [],
          type: pairsType,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "recordLit", fields: [], type: recordType, loc },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: varRef("i.0", F64, loc),
          right: {
            kind: "arrIntrinsic",
            method: "length",
            receiver: varRef("ps.0", pairsType, loc),
            args: [],
            type: F64,
            loc,
          },
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: "i.0",
          value: {
            kind: "bin",
            op: "+",
            left: varRef("i.0", F64, loc),
            right: numLit(2, loc),
            type: F64,
            loc,
          },
          loc,
        },
        body: [
          ...(listTag >= 0
            ? [
                {
                  kind: "if" as const,
                  cond: {
                    kind: "strEq" as const,
                    negated: false,
                    left: pairAt(0),
                    right: {
                      kind: "strLit" as const,
                      value: options.listKey!.name,
                      type: STRING,
                      loc,
                    },
                    type: BOOL,
                    loc,
                  },
                  then: [
                    {
                      kind: "recordKeySet" as const,
                      obj: varRef("out.0", recordType, loc),
                      shapeId,
                      key: pairAt(0),
                      value: {
                        kind: "unionWrap" as const,
                        unionId: indexValue.unionId,
                        tag: listTag,
                        value: {
                          kind: "libCall" as const,
                          fn: options.listKey!.libCall,
                          args: [...(options.callArgs ?? []), pairAt(0)],
                          type: arrayOf(STRING),
                          loc,
                        },
                        type: indexValue,
                        loc,
                      },
                      loc,
                    },
                    { kind: "continue" as const, loc },
                  ],
                  else_: null,
                  loc,
                },
              ]
            : []),
          {
            kind: "recordKeySet",
            obj: varRef("out.0", recordType, loc),
            shapeId,
            key: pairAt(0),
            value: options.lookupValue
              ? {
                  kind: "libCall",
                  fn: options.lookupValue,
                  args: [...(options.callArgs ?? []), pairAt(0)],
                  type: indexValue,
                  loc,
                }
              : {
                  kind: "unionWrap",
                  unionId: indexValue.unionId,
                  tag: stringTag,
                  value: pairAt(1),
                  type: indexValue,
                  loc,
                },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: varRef("out.0", recordType, loc), loc },
    ],
    loc,
  });
  return name;
}
