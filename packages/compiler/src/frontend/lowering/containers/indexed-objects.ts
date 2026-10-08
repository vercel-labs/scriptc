import { countedFor, numLit, varRef } from "../../../ir/build.js";
import { objectEnumerationReceiver } from "../object-enumeration-receiver.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  isRefCounted,
  isSupportedIndexValue,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import { locOf } from "../../program.js";
import { typeKey } from "../../type-mapper.js";
import { type WidthLift } from "../lowerer.js";

/** Object() and new Object() preserve known object inputs. Primitive
 * boxing and unproven checked-dynamic values retain their refusal. */
export function lowerObjectConstructor(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr | null {
  if (args.length === 0) {
    return {
      kind: "recordLit",
      fields: [],
      type: { kind: "record", shapeId: lowerer.shapes.intern([]) },
      loc,
    };
  }
  if (args.length !== 1 || ts.isSpreadElement(args[0]!)) return null;
  const value = lowerer.lowerExpr(args[0]!);
  if (value.kind === "dynObjLit" || value.kind === "dynArrLit") return value;
  if (
    [
      "record",
      "array",
      "object",
      "regex",
      "date",
      "bytes",
      "map",
      "set",
      "func",
      "classval",
    ].includes(value.type.kind)
  )
    return value;
  return null;
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
export function lowerObjectIterOverIndexShape(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "keys" | "values" | "entries",
  argIr: IrType & { kind: "record" },
  shape: IrRecordShape,
): IrExpr {
  const resultT = lowerer.irTypeOf(call);
  if (resultT.kind !== "array") lowerer.badType(call, lowerer.typeOf(call)); // defensive
  return objectIterOverIndexShape(
    lowerer,
    call,
    member,
    argIr,
    shape,
    objectEnumerationReceiver(lowerer, lowerer.lowerExpr(call.arguments[0]!), argIr, locOf(call)),
    resultT,
    locOf(call),
  );
}

/** The construction core, receiver/result pre-resolved — `node` anchors
 * the fences. for-in reuses the "keys" arm directly (it iterates exactly
 * the keys Object.keys answers; same intern key, one helper). */
export function objectIterOverIndexShape(
  lowerer: Lowerer,
  node: ts.Node,
  member: "keys" | "values" | "entries",
  argIr: IrType & { kind: "record" },
  shape: IrRecordShape,
  receiver: IrExpr,
  resultT: IrType & { kind: "array" },
  loc: SrcLoc,
): IrExpr {
  const iv = shape.indexValue!;

  // The result-element type values flow into (string for keys, the
  // checker's element for values, the [string, V] tuple's "1" for
  // entries).
  let valueT: IrType | null = null;
  let tupleT: (IrType & { kind: "record" }) | null = null;
  if (member === "values") valueT = resultT.elem;
  if (member === "entries") {
    if (resultT.elem.kind !== "record")
      lowerer.badType(node, lowerer.typeOf(node as ts.Expression));
    tupleT = resultT.elem;
    const tupleShape = lowerer.shapes.get(resultT.elem.shapeId);
    if (!tupleShape?.tuple || tupleShape.fields.length !== 2)
      lowerer.badType(node, lowerer.typeOf(node as ts.Expression));
    valueT = tupleShape.fields.find((f) => f.name === "1")!.type;
  }

  // JS lists integer-like OWN keys first regardless of where they live;
  // the declared-then-overflow order can only honor that when no
  // DECLARED field name is integer-like (the overflow walk handles its
  // own). Shapes that mix one in keep a fence, not a silent reorder.
  const arrayIndexRe = /^(0|[1-9][0-9]{0,9})$/;
  if (shape.fields.some((f) => arrayIndexRe.test(f.name) && Number(f.name) <= 4294967294)) {
    lowerer.unsupported(
      "SC1090",
      node,
      `Object.${member} over '${lowerer.fmt(argIr)}' (a declared field name is integer-like — JS orders integer keys first, across declared and overflow keys)`,
    );
  }
  // The overflow value must surface as the element type (identity, an
  // arm of a union element, or a dyn element over a dyn signature).
  if (valueT) {
    const ivSurfaces =
      typeEquals(iv, valueT) ||
      (valueT.kind === "union" && lowerer.armTag(valueT.unionId, iv) >= 0) ||
      (valueT.kind === "dyn" && iv.kind === "dyn");
    if (!ivSurfaces) {
      lowerer.unsupported(
        "SC1090",
        node,
        `Object.${member} over '${lowerer.fmt(argIr)}' (the index signature's '${lowerer.fmt(iv)}' value cannot flow into the '${lowerer.fmt(valueT)}' result element)`,
      );
    }
  }

  const key = `obj.${member}:ovf:${argIr.shapeId}:${typeKey(resultT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%obj.${member}.${lowerer.arrHofHelpers.size}`;

    const outRef = varRef("out.0", resultT, loc);
    const rRef = varRef("r.0", argIr, loc);
    const push = (value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: outRef,
        args: [value],
        type: F64,
        loc,
      },
      loc,
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: resultT, loc },
        loc,
      },
    ];
    const fieldStmts = new Map<string, IrStmt>();

    // Declared fields, in declaration order. Absent optional fields skip
    // at runtime; values surface into the element type or the site
    // fences with the field named.
    const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
    for (const name of order) {
      const f = shape.fields.find((x) => x.name === name)!;
      const raw: IrExpr = {
        kind: "recordGet",
        obj: rRef,
        shapeId: argIr.shapeId,
        field: f.name,
        type: f.type,
        loc,
      };
      const utag = f.type.kind === "union" ? lowerer.armTag(f.type.unionId, UNDEFINED_T) : -1;
      // Set when the surfaced value narrows away the undefined arm.
      let narrowedPush = false;
      // The pushed value per member; null when the field cannot surface.
      const surfaced = (): IrExpr | null => {
        if (!valueT) return null;
        if (typeEquals(f.type, valueT)) return raw;
        if (valueT.kind === "dyn") {
          return lowerer.dynConvertible(f.type)
            ? { kind: "dynFrom", value: raw, type: DYN, loc }
            : null;
        }
        if (valueT.kind === "union") {
          const tag = lowerer.armTag(valueT.unionId, f.type);
          if (tag >= 0)
            return {
              kind: "unionWrap",
              unionId: valueT.unionId,
              tag,
              value: raw,
              type: valueT,
              loc,
            };
          // An undefined-armed field union whose ONE other arm is an
          // element arm: narrow (the undefined case is guard-skipped),
          // then wrap.
          if (utag >= 0 && f.type.kind === "union") {
            const others = (lowerer.unions.get(f.type.unionId)?.arms ?? []).filter(
              (a): boolean => a.kind !== "undefinedT",
            );
            if (others.length === 1) {
              const otherTag = lowerer.armTag(valueT.unionId, others[0]!);
              const narrowTag = lowerer.armTag(f.type.unionId, others[0]!);
              if (otherTag >= 0 && narrowTag >= 0) {
                const other = others[0]!;
                // A UNIT other arm pushes the unit LITERAL (undefined
                // was filtered above, so the unit is null; units carry
                // no payload and narrowing to a unit arm is malformed
                // IR) — the fixed-shape helper's rule exactly.
                const narrowed: IrExpr = isUnitType(other)
                  ? { kind: "unitLit", unit: "null", type: other, loc }
                  : {
                      kind: "unionNarrow",
                      unionId: f.type.unionId,
                      tag: narrowTag,
                      value: raw,
                      type: other,
                      loc,
                    };
                narrowedPush = true;
                return {
                  kind: "unionWrap",
                  unionId: valueT.unionId,
                  tag: otherTag,
                  value: narrowed,
                  type: valueT,
                  loc,
                };
              }
            }
          }
        }
        return null;
      };
      const pushedOf = (element: IrExpr): IrExpr =>
        member === "values"
          ? element
          : {
              kind: "recordLit",
              fields: [
                { name: "0", value: { kind: "strLit", value: f.name, type: STRING, loc } },
                { name: "1", value: element },
              ],
              type: tupleT!,
              loc,
            };
      let pushed: IrExpr;
      if (member === "keys") {
        pushed = { kind: "strLit", value: f.name, type: STRING, loc };
      } else {
        const s = surfaced();
        if (!s) {
          lowerer.unsupported(
            "SC1090",
            node,
            `Object.${member} over '${lowerer.fmt(argIr)}' (field '${f.name}' of type '${lowerer.fmt(f.type)}' cannot flow into the '${lowerer.fmt(valueT!)}' result element — read the fields directly)`,
          );
        }
        pushed = pushedOf(s);
      }
      // Fields that can be absent contribute only when present; a present
      // undefined behind a narrowed push surfaces the element's own
      // undefined (the element union carries one whenever the checker
      // typed the optional field into it).
      let fieldStmt: IrStmt = push(pushed);
      if (utag >= 0 && f.type.kind === "union") {
        if (narrowedPush) {
          const undefinedElement = valueT ? lowerer.wrappedUndefined(valueT, loc) : null;
          fieldStmt = {
            kind: "if",
            cond: {
              kind: "unionIsTag",
              unionId: f.type.unionId,
              tag: utag,
              negated: true,
              value: raw,
              type: BOOL,
              loc,
            },
            then: [fieldStmt],
            else_: undefinedElement ? [push(pushedOf(undefinedElement))] : null,
            loc,
          };
        }
        fieldStmt = {
          kind: "if",
          cond: lowerer.recordFieldPresent(rRef, argIr.shapeId, f.name, loc),
          then: [fieldStmt],
          else_: null,
          loc,
        };
      }
      fieldStmts.set(f.name, fieldStmt);
      body.push(fieldStmt);
    }

    // The overflow walk: a fresh key snapshot in JS own-key order, each
    // value read back through the overflow-only keyed read (declared
    // names never live in the overflow map).
    const ksT = arrayOf(STRING);
    const ksRef = varRef("ks.0", ksT, loc);
    const kRef = varRef("k.0", STRING, loc);
    const readValue: IrExpr | null = valueT
      ? {
          kind: "recordKeyGet",
          obj: rRef,
          shapeId: argIr.shapeId,
          key: kRef,
          overflowOnly: true,
          type: valueT,
          loc,
        }
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
      {
        kind: "varDecl",
        localId: "ks.0",
        init: { kind: "recordOvfKeys", obj: rRef, shapeId: argIr.shapeId, type: ksT, loc },
        loc,
      },
      countedFor(
        loc,
        { kind: "arrIntrinsic", method: "length", receiver: ksRef, args: [], type: F64, loc },
        () => [
          {
            kind: "varDecl",
            localId: "k.0",
            init: {
              kind: "arrayGet",
              arr: ksRef,
              index: varRef("i.0", F64, loc),
              type: STRING,
              loc,
            },
            loc,
          },
          push(loopPushed),
        ],
      ),
      { kind: "return", value: outRef, loc },
    );
    const suffix = body.slice(1 + fieldStmts.size);
    lowerer.arrHofHelpers.set(key, helper);
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
    lowerer.shapeOrderHelperFinalizers.push(() => {
      const current = lowerer.shapes.get(argIr.shapeId) ?? shape;
      const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
      fn.body = [
        body[0]!,
        ...currentOrder.flatMap((name) => {
          const stmt = fieldStmts.get(name);
          return stmt ? [stmt] : [];
        }),
        ...suffix,
      ];
    });
    lowerer.liftedFns.push(fn);
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
export function lowerObjectFromEntriesCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  callee: ts.Expression,
): IrExpr | null {
  const typed = lowerTypedObjectFromEntriesCall(lowerer, call, callee);
  if (typed) return typed;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    call.questionDotToken ||
    callee.questionDotToken ||
    !lowerer.isStdlibGlobal(callee.expression, "Object") ||
    callee.name.text !== "fromEntries" ||
    call.arguments.length !== 1 ||
    ts.isSpreadElement(call.arguments[0]!)
  )
    return null;
  if (lowerer.dynamic) return null;
  return {
    kind: "libCall",
    fn: "dyn.fromEntries",
    type: DYN,
    loc: locOf(call),
    args: [lowerer.lowerExprExpecting(call.arguments[0]!, DYN)],
  };
}

function lowerTypedObjectFromEntriesCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  callee: ts.Expression,
): IrExpr | null {
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (call.questionDotToken || callee.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(callee.expression, "Object")) return null;
  if (callee.name.text !== "fromEntries") return null;
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return null;
  const argNode = call.arguments[0]!;
  const argIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  if (argIr?.kind !== "array") return null;
  const represented = tryLowerExpression(lowerer, argNode);
  if (represented && !typeEquals(represented.type, argIr)) return null;
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
    return lowerFromEntriesStringRows(lowerer, call, argNode, argIr as IrType & { kind: "array" });
  }
  if (argIr.elem.kind !== "record") return null;
  const tupleShape = lowerer.shapes.get(argIr.elem.shapeId);
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
    shapeId: lowerer.shapes.intern([], false, valT, []),
  };
  const iv = valT;
  const loc = locOf(call);
  // The tuple's value position must flow into the index-value slot.
  const convertible = typeEquals(valT, iv) || (iv.kind === "dyn" && lowerer.dynConvertible(valT));
  const convert = (v: IrExpr): IrExpr =>
    typeEquals(valT, iv) ? v : { kind: "dynFrom", value: v, type: DYN, loc };
  if (!convertible) {
    lowerer.unsupported(
      "SC1090",
      call,
      `Object.fromEntries over '${lowerer.fmt(argIr)}' (the tuple's '${lowerer.fmt(valT)}' value cannot flow into the '${lowerer.fmt(iv)}' signature slot)`,
    );
  }
  // Enumeration/filtering may keep the array in checked-dynamic storage.
  // Validate its tuple layout before calling a helper with a native-array
  // ABI; opaque tuple values themselves retain their original references.
  const receiver = lowerer.lowerExprExpecting(argNode, argIr);
  const key = `obj.fromEntries:${argIr.elem.shapeId}:${resultT.shapeId}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%obj.fromEntries.${lowerer.arrHofHelpers.size}`;

    const tupleT = argIr.elem as IrType & { kind: "record" };
    const tRef = varRef("t.0", tupleT, loc);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "recordLit", fields: [], type: resultT, loc },
        loc,
      },
      countedFor(
        loc,
        {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("a.0", argIr, loc),
          args: [],
          type: F64,
          loc,
        },
        () => [
          {
            kind: "varDecl",
            localId: "t.0",
            init: {
              kind: "arrayGet",
              arr: varRef("a.0", argIr, loc),
              index: varRef("i.0", F64, loc),
              type: tupleT,
              loc,
            },
            loc,
          },
          {
            kind: "recordKeySet",
            obj: varRef("out.0", resultT, loc),
            shapeId: resultT.shapeId,
            key: {
              kind: "recordGet",
              obj: tRef,
              shapeId: tupleT.shapeId,
              field: "0",
              type: STRING,
              loc,
            },
            value: convert({
              kind: "recordGet",
              obj: tRef,
              shapeId: tupleT.shapeId,
              field: "1",
              type: valT,
              loc,
            })!,
            loc,
          },
        ],
      ),
      { kind: "return", value: varRef("out.0", resultT, loc), loc },
    ];
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "a.0", name: "a", type: argIr }],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: argIr, mutable: true },
        { id: "out.0", name: "out", type: resultT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "t.0", name: "t", type: tupleT, mutable: false },
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
function lowerFromEntriesStringRows(
  lowerer: Lowerer,
  call: ts.CallExpression,
  argNode: ts.Expression,
  argIr: IrType & { kind: "array" },
): IrExpr {
  const loc = locOf(call);
  const rowT = argIr.elem; // string[]
  const valT: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, UNDEFINED_T]) };
  const strTag = lowerer.armTag(valT.unionId, STRING);
  const resultT: IrType & { kind: "record" } = {
    kind: "record",
    shapeId: lowerer.shapes.intern([], false, valT, []),
  };
  const receiver = lowerer.lowerExpr(argNode);
  const key = `obj.fromEntries:strrows:${resultT.shapeId}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%obj.fromEntries.${lowerer.arrHofHelpers.size}`;

    const tRef = varRef("t.0", rowT, loc);
    const rowLen: IrExpr = {
      kind: "arrIntrinsic",
      method: "length",
      receiver: tRef,
      args: [],
      type: F64,
      loc,
    };
    const lenAtLeast = (n: number): IrExpr => ({
      kind: "bin",
      op: ">=",
      left: rowLen,
      right: numLit(n, loc),
      type: BOOL,
      loc,
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "recordLit", fields: [], type: resultT, loc },
        loc,
      },
      countedFor(
        loc,
        {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("a.0", argIr, loc),
          args: [],
          type: F64,
          loc,
        },
        () => [
          {
            kind: "varDecl",
            localId: "t.0",
            init: {
              kind: "arrayGet",
              arr: varRef("a.0", argIr, loc),
              index: varRef("i.0", F64, loc),
              type: rowT,
              loc,
            },
            loc,
          },
          {
            kind: "recordKeySet",
            obj: varRef("out.0", resultT, loc),
            shapeId: resultT.shapeId,
            key: {
              kind: "ternary",
              cond: lenAtLeast(1),
              then: { kind: "arrayGet", arr: tRef, index: numLit(0, loc), type: STRING, loc },
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
                value: { kind: "arrayGet", arr: tRef, index: numLit(1, loc), type: STRING, loc },
                type: valT,
                loc,
              },
              else_: lowerer.wrappedUndefined(valT, loc)!,
              type: valT,
              loc,
            },
            loc,
          },
        ],
      ),
      { kind: "return", value: varRef("out.0", resultT, loc), loc },
    ];
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push({
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
export function lowerRecordOvfCaptureHelper(
  lowerer: Lowerer,
  fromId: string,
  toId: string,
  loc: SrcLoc,
): string | null {
  const from = lowerer.shapes.get(fromId);
  const to = lowerer.shapes.get(toId);
  if (!from || !to?.indexValue || from.tuple || to.tuple) return null;
  const fIv = from.indexValue ?? null;
  const tIv = to.indexValue;
  // How a source value enters the target's value slot: identity, the
  // dyn conversion, or a width lift (wrap/retag/nested reshape).
  const slotLift = (t: IrType): WidthLift | "dyn" | null => {
    if (typeEquals(t, tIv)) return { how: "copy" };
    if (tIv.kind === "dyn" && (t.kind === "dyn" || lowerer.dynConvertible(t))) return "dyn";
    return lowerer.widthLiftPlan(t, tIv);
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
    const directLift = sf ? lowerer.widthLiftPlan(sf.type, tf.type) : null;
    if (sf && directLift) {
      inits.push({ name: tf.name, kind: "direct", src: sf.type, lift: directLift });
      consumed.add(tf.name);
      continue;
    }
    if (tf.type.kind !== "union") return null;
    const utag = lowerer.armTag(tf.type.unionId, UNDEFINED_T);
    if (utag < 0) return null;
    if (tIv.kind === "dyn" ? !lowerer.dynConvertible(tf.type) : !typeEquals(tf.type, tIv))
      return null;
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
    if (
      tIv.kind === "dyn"
        ? !to.fields.every((f) => lowerer.dynConvertible(f.type))
        : !to.fields.every((f) => typeEquals(f.type, tIv))
    ) {
      return null;
    }
  }
  const key = `ovf:${fromId}:${toId}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = `%rec.capture.${lowerer.valueHelpers.size}`;
  lowerer.valueHelpers.set(key, name);
  const fromT: IrType = { kind: "record", shapeId: fromId };
  const toT: IrType = { kind: "record", shapeId: toId };

  const sRef = varRef("s.0", fromT, loc);
  const outRef = varRef("out.0", toT, loc);
  const intoSlot = (v: IrExpr, lift: WidthLift | "dyn"): IrExpr =>
    lift === "dyn"
      ? { kind: "dynFrom", value: v, type: DYN, loc }
      : lowerer.applyWidthLift(lift, v, tIv, loc);
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
              ? lowerer.presenceKeepingCopy(
                  sRef,
                  fromId,
                  d.name,
                  lowerer.applyWidthLift(
                    d.lift,
                    {
                      kind: "recordGet",
                      obj: sRef,
                      shapeId: fromId,
                      field: d.name,
                      type: d.src,
                      loc,
                    },
                    to.fields.find((f) => f.name === d.name)!.type,
                    loc,
                  ),
                  loc,
                )
              : ({
                  // No source property of this name: the field starts
                  // absent (an overflow write below can supply it).
                  kind: "fieldAbsent",
                  unionId: d.unionId,
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
    const raw: IrExpr = {
      kind: "recordGet",
      obj: sRef,
      shapeId: fromId,
      field: ff.name,
      type: ff.type,
      loc,
    };
    const utag = ff.type.kind === "union" ? lowerer.armTag(ff.type.unionId, UNDEFINED_T) : -1;
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
            cond: lowerer.recordFieldPresent(sRef, fromId, ff.name, loc),
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
      {
        kind: "varDecl",
        localId: "ks.0",
        init: { kind: "recordOvfKeys", obj: sRef, shapeId: fromId, type: ksT, loc },
        loc,
      },
      countedFor(
        loc,
        {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("ks.0", ksT, loc),
          args: [],
          type: F64,
          loc,
        },
        () => [
          {
            kind: "varDecl",
            localId: "k.0",
            init: {
              kind: "arrayGet",
              arr: varRef("ks.0", ksT, loc),
              index: varRef("i.0", F64, loc),
              type: STRING,
              loc,
            },
            loc,
          },
          {
            kind: "recordKeySet",
            obj: outRef,
            shapeId: toId,
            key: varRef("k.0", STRING, loc),
            value: intoSlot(
              {
                kind: "recordKeyGet",
                obj: sRef,
                shapeId: fromId,
                key: varRef("k.0", STRING, loc),
                overflowOnly: true,
                type: fIv,
                loc,
              },
              ovfLift,
            ),
            loc,
          },
        ],
      ),
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
  lowerer.shapeOrderHelperFinalizers.push(() => {
    const current = lowerer.shapes.get(fromId) ?? from;
    const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
    fn.body = [
      body[0]!,
      ...currentOrder.flatMap((field) => {
        const stmt = fieldStmts.get(field);
        return stmt ? [stmt] : [];
      }),
      ...suffix,
    ];
  });
  lowerer.liftedFns.push(fn);
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
export function lowerObjectAssignIndexShape(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (call.arguments.length < 2 || call.arguments.some((a) => ts.isSpreadElement(a))) return null;
  const loc = locOf(call);
  const targetIr = lowerer.mapTypeOf(lowerer.typeOf(call.arguments[0]!));
  if (targetIr?.kind !== "record") return null;
  const to = lowerer.shapes.get(targetIr.shapeId);
  if (!to?.indexValue || to.tuple) return null;
  // tsc types the call `T & U & …`; the runtime value is the TARGET
  // record (its shape, its identity). The lowering is honest exactly
  // when nothing observes the intersection: the result is DISCARDED
  // (expression-statement position — the mutate-in-place spelling), or
  // the intersection collapses back to the target's own mapped record.
  let parent: ts.Node | undefined = call.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isVoidExpression(parent))
    parent = parent.parent;
  const discarded = ts.isExpressionStatement(parent);
  if (!discarded) {
    const resultIr = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (!resultIr || !typeEquals(resultIr, targetIr)) return null;
  }
  const tIv = to.indexValue;
  const slotLift = (t: IrType): WidthLift | "dyn" | null => {
    if (typeEquals(t, tIv)) return { how: "copy" };
    if (tIv.kind === "dyn" && (t.kind === "dyn" || lowerer.dynConvertible(t))) return "dyn";
    return lowerer.widthLiftPlan(t, tIv);
  };
  // Validate EVERY source before interning anything.
  interface SourcePlan {
    fromId: string;
    fields: { name: string; type: IrType; lift: WidthLift | "dyn" }[];
    ovfLift: (WidthLift | "dyn") | null;
  }
  const plans: SourcePlan[] = [];
  for (const argNode of call.arguments.slice(1)) {
    const srcIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
    if (srcIr?.kind !== "record") return null;
    const from = lowerer.shapes.get(srcIr.shapeId);
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
    const existing = lowerer.valueHelpers.get(key);
    if (existing) return existing;
    const name = `%obj.assign.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, name);
    const toT: IrType = { kind: "record", shapeId: targetIr.shapeId };
    const fromT: IrType = { kind: "record", shapeId: plan.fromId };

    const tRef = varRef("t.0", toT, loc);
    const sRef = varRef("s.0", fromT, loc);
    const intoSlot = (v: IrExpr, lift: WidthLift | "dyn"): IrExpr =>
      lift === "dyn"
        ? { kind: "dynFrom", value: v, type: DYN, loc }
        : lowerer.applyWidthLift(lift, v, tIv, loc);
    const body: IrStmt[] = [];
    const fieldStmts = new Map<string, IrStmt>();
    for (const ff of plan.fields) {
      const raw: IrExpr = {
        kind: "recordGet",
        obj: sRef,
        shapeId: plan.fromId,
        field: ff.name,
        type: ff.type,
        loc,
      };
      const utag = ff.type.kind === "union" ? lowerer.armTag(ff.type.unionId, UNDEFINED_T) : -1;
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
              cond: lowerer.recordFieldPresent(sRef, plan.fromId, ff.name, loc),
              then: [write],
              else_: null,
              loc,
            }
          : write;
      fieldStmts.set(ff.name, fieldStmt);
      body.push(fieldStmt);
    }
    const ksT = arrayOf(STRING);
    const fromShape = lowerer.shapes.get(plan.fromId)!;
    if (plan.ovfLift !== null && fromShape.indexValue) {
      const fIv = fromShape.indexValue;
      const ovfLift = plan.ovfLift;
      body.push(
        {
          kind: "varDecl",
          localId: "ks.0",
          init: { kind: "recordOvfKeys", obj: sRef, shapeId: plan.fromId, type: ksT, loc },
          loc,
        },
        countedFor(
          loc,
          {
            kind: "arrIntrinsic",
            method: "length",
            receiver: varRef("ks.0", ksT, loc),
            args: [],
            type: F64,
            loc,
          },
          () => [
            {
              kind: "varDecl",
              localId: "k.0",
              init: {
                kind: "arrayGet",
                arr: varRef("ks.0", ksT, loc),
                index: varRef("i.0", F64, loc),
                type: STRING,
                loc,
              },
              loc,
            },
            {
              kind: "recordKeySet",
              obj: tRef,
              shapeId: targetIr.shapeId,
              key: varRef("k.0", STRING, loc),
              value: intoSlot(
                {
                  kind: "recordKeyGet",
                  obj: sRef,
                  shapeId: plan.fromId,
                  key: varRef("k.0", STRING, loc),
                  overflowOnly: true,
                  type: fIv,
                  loc,
                },
                ovfLift,
              ),
              loc,
            },
          ],
        ),
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
    lowerer.shapeOrderHelperFinalizers.push(() => {
      const current = lowerer.shapes.get(plan.fromId) ?? fromShape;
      const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
      fn.body = [
        ...currentOrder.flatMap((field) => {
          const stmt = fieldStmts.get(field);
          return stmt ? [stmt] : [];
        }),
        ...suffix,
      ];
    });
    lowerer.liftedFns.push(fn);
    return name;
  };
  let acc = lowerer.lowerExprExpecting(call.arguments[0]!, targetIr);
  for (let i = 0; i < plans.length; i++) {
    const src = lowerer.lowerExprExpecting(call.arguments[i + 1]!, {
      kind: "record",
      shapeId: plans[i]!.fromId,
    });
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
export function lowerIndexMergeHelper(
  lowerer: Lowerer,
  toId: string,
  contributors: IndexMergeContributor[],
  loc: SrcLoc,
): string | null {
  const to = lowerer.shapes.get(toId);
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
  const srcPlans: {
    shapeId: string;
    wrapTag: number;
    retag: string | null;
    fields: Map<string, WidthLift | "dyn"> | null;
  }[] = [];
  for (const c of contributors) {
    // A conditional spread needs the undefined arm as its "absent"
    // value — a target slot without one can't carry the empty arm.
    if (
      c.kind === "condField" &&
      (tIv.kind !== "union" || lowerer.armTag(tIv.unionId, UNDEFINED_T) < 0)
    ) {
      return null;
    }
    if (c.kind !== "spread") continue;
    const from = lowerer.shapes.get(c.shapeId);
    if (!from || from.tuple) return null;
    if (!from.indexValue) {
      if (from.fields.some((f) => f.name.startsWith("%"))) return null;
      const fields = new Map<string, WidthLift | "dyn">();
      for (const ff of from.fields) {
        const lift = typeEquals(ff.type, tIv)
          ? ({ how: "copy" } as WidthLift)
          : tIv.kind === "dyn" && (ff.type.kind === "dyn" || lowerer.dynConvertible(ff.type))
            ? "dyn"
            : lowerer.widthLiftPlan(ff.type, tIv);
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
      wrapTag = lowerer.armTag(tIv.unionId, fIv);
      if (wrapTag < 0) {
        if (!(fIv.kind === "union" && lowerer.unionRetagMappable(fIv.unionId, tIv.unionId)))
          return null;
        retag = lowerer.unionRetagHelper(fIv.unionId, tIv.unionId, loc);
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
      .map((c) =>
        c.kind === "spread"
          ? `s${c.shapeId}`
          : c.kind === "condField"
            ? `c${c.name}`
            : c.kind === "keyedField"
              ? "k"
              : `f${c.name}`,
      )
      .join(",");
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = `%rec.merge.${lowerer.valueHelpers.size}`;
  lowerer.valueHelpers.set(key, name);
  const toT: IrType = { kind: "record", shapeId: toId };
  const ksT = arrayOf(STRING);

  const outRef = varRef("out.0", toT, loc);
  const params: IrParam[] = [];
  const locals: IrLocal[] = [{ id: "out.0", name: "out", type: toT, mutable: false }];
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "recordLit", fields: [], type: toT, loc },
      loc,
    },
  ];
  let spreadNo = 0;
  contributors.forEach((c, ci) => {
    if (c.kind === "keyedField") {
      // The runtime key and its value are consecutive parameters — the
      // call site's argument order IS the property's key-then-value
      // evaluation order.
      const kid = `kk.${ci}`;
      const pid = `v.${ci}`;
      params.push(
        { localId: kid, name: `kk${ci}`, type: STRING },
        { localId: pid, name: `v${ci}`, type: tIv },
      );
      locals.push(
        { id: kid, name: `kk${ci}`, type: STRING, mutable: false },
        { id: pid, name: `v${ci}`, type: tIv, mutable: false },
      );
      body.push({
        kind: "recordKeySet",
        obj: outRef,
        shapeId: toId,
        key: varRef(kid, STRING, loc),
        value: varRef(pid, tIv, loc),
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
        value: varRef(pid, tIv, loc),
        overflowOnly: true,
        loc,
      };
      if (c.kind === "condField" && tIv.kind === "union") {
        // The key writes only when the spread's condition held (its
        // value arg holds the interned undefined arm otherwise) — an
        // absent key STAYS absent, presence being the observable.
        // (The pre-pass above guaranteed the undefined arm exists.)
        const undefTag = lowerer.armTag(tIv.unionId, UNDEFINED_T);
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: tIv.unionId,
            tag: undefTag,
            negated: true,
            value: varRef(pid, tIv, loc),
            type: BOOL,
            loc,
          },
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
    const from = lowerer.shapes.get(plan.shapeId)!;
    const fromT: IrType = { kind: "record", shapeId: plan.shapeId };
    const sid = `s.${ci}`;
    params.push({ localId: sid, name: `s${ci}`, type: fromT });
    locals.push({ id: sid, name: `s${ci}`, type: fromT, mutable: false });
    const sRef = varRef(sid, fromT, loc);
    // A FIXED-shape source: each declared field keyed-writes through its
    // own planned lift (absent optionals skip — the unset convention);
    // no overflow exists to walk.
    if (plan.fields !== null) {
      for (const ff of from.fields) {
        const lift = plan.fields.get(ff.name)!;
        const raw: IrExpr = {
          kind: "recordGet",
          obj: sRef,
          shapeId: plan.shapeId,
          field: ff.name,
          type: ff.type,
          loc,
        };
        const utag = ff.type.kind === "union" ? lowerer.armTag(ff.type.unionId, UNDEFINED_T) : -1;
        const write: IrStmt = {
          kind: "recordKeySet",
          obj: outRef,
          shapeId: toId,
          key: { kind: "strLit", value: ff.name, type: STRING, loc },
          value:
            lift === "dyn"
              ? { kind: "dynFrom", value: raw, type: DYN, loc }
              : lowerer.applyWidthLift(lift, raw, tIv, loc),
          overflowOnly: true,
          loc,
        };
        body.push(
          utag >= 0 && ff.type.kind === "union"
            ? {
                kind: "if",
                cond: lowerer.recordFieldPresent(sRef, plan.shapeId, ff.name, loc),
                then: [write],
                else_: null,
                loc,
              }
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
          : {
              kind: "unionWrap",
              unionId: (tIv as IrType & { kind: "union" }).unionId,
              tag: plan.wrapTag,
              value: v,
              type: tIv,
              loc,
            };
    // Declared source fields first (literal keys; absent optionals skip).
    for (const ff of from.fields) {
      const raw: IrExpr = {
        kind: "recordGet",
        obj: sRef,
        shapeId: plan.shapeId,
        field: ff.name,
        type: ff.type,
        loc,
      };
      const utag = ff.type.kind === "union" ? lowerer.armTag(ff.type.unionId, UNDEFINED_T) : -1;
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
          ? {
              kind: "if",
              cond: lowerer.recordFieldPresent(sRef, plan.shapeId, ff.name, loc),
              then: [write],
              else_: null,
              loc,
            }
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
      {
        kind: "varDecl",
        localId: ks,
        init: { kind: "recordOvfKeys", obj: sRef, shapeId: plan.shapeId, type: ksT, loc },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: iv, init: numLit(0, loc), loc },
        cond: {
          kind: "bin",
          op: "<",
          left: varRef(iv, F64, loc),
          right: {
            kind: "arrIntrinsic",
            method: "length",
            receiver: varRef(ks, ksT, loc),
            args: [],
            type: F64,
            loc,
          },
          type: BOOL,
          loc,
        },
        update: {
          kind: "assign",
          localId: iv,
          value: {
            kind: "bin",
            op: "+",
            left: varRef(iv, F64, loc),
            right: numLit(1, loc),
            type: F64,
            loc,
          },
          loc,
        },
        body: [
          {
            kind: "varDecl",
            localId: kv,
            init: {
              kind: "arrayGet",
              arr: varRef(ks, ksT, loc),
              index: varRef(iv, F64, loc),
              type: STRING,
              loc,
            },
            loc,
          },
          {
            kind: "recordKeySet",
            obj: outRef,
            shapeId: toId,
            key: varRef(kv, STRING, loc),
            value: intoSlot({
              kind: "recordKeyGet",
              obj: sRef,
              shapeId: plan.shapeId,
              key: varRef(kv, STRING, loc),
              overflowOnly: true,
              type: fIv,
              loc,
            }),
            overflowOnly: true,
            loc,
          },
        ],
        loc,
      },
    );
  });
  body.push({ kind: "return", value: outRef, loc });
  lowerer.liftedFns.push({ name, params, returnType: toT, locals, body, loc });
  return name;
}

/** The interned helper flattening an env-shaped record into the
 * [k0, v0, k1, v1, ...] string[] cp.execSync consumes — declared string
 * fields first (undefined-armed absents skipped, the Node-drops-undefined
 * rule), then index-signature overflow in JS own-key order. Every value
 * source must be a string or a `string | undefined` union whose value arm
 * is a string. Null when the shape carries a non-string field/value slot
 * (the caller fences). */
export function lowerEnvToPairsHelper(
  lowerer: Lowerer,
  shapeId: string,
  loc: SrcLoc,
): string | null {
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple) return null;
  // A string | undefined value flows as its string arm; a bare string
  // flows directly. `unwrapStr` returns the code (or null → fence).
  const strArmTag = (t: IrType): number | "plain" | null => {
    if (t.kind === "string") return "plain";
    if (t.kind !== "union") return null;
    const def = lowerer.unions.get(t.unionId);
    if (!def) return null;
    const nonUnit = def.arms.filter((a) => !isRefCounted(a) || a.kind === "string");
    // Exactly a string arm plus unit arms (string | undefined).
    const strTag = def.arms.findIndex((a) => a.kind === "string");
    if (strTag < 0) return null;
    if (
      !def.arms.every((a) => a.kind === "string" || a.kind === "undefinedT" || a.kind === "nullT")
    ) {
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
    const def = lowerer.unions.get(t.unionId);
    if (!def) return null;
    if (
      !def.arms.every(
        (a) =>
          a.kind === "string" ||
          a.kind === "f64" ||
          (a.kind === "array" && a.elem.kind === "string") ||
          a.kind === "undefinedT" ||
          a.kind === "nullT",
      )
    ) {
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
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = `%env.pairs.${lowerer.valueHelpers.size}`;
  lowerer.valueHelpers.set(key, name);
  const recT: IrType = { kind: "record", shapeId };
  const arrT = arrayOf(STRING);

  const sRef = varRef("s.0", recT, loc);
  const outRef = varRef("out.0", arrT, loc);
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
  const push = (k: IrExpr, v: IrExpr): IrStmt => ({
    kind: "block",
    body: [pushOne(k), pushOne(v)],
    loc,
  });
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
      const utag = t.kind === "union" ? lowerer.armTag(t.unionId, UNDEFINED_T) : -1;
      return utag >= 0 && t.kind === "union"
        ? {
            kind: "if",
            cond: {
              kind: "unionIsTag",
              unionId: t.unionId,
              tag: utag,
              negated: true,
              value: raw,
              type: BOOL,
              loc,
            },
            then: [write],
            else_: null,
            loc,
          }
        : write;
    }
    if (t.kind !== "union")
      throw new InternalCompilerError("lowerer bug: header slot outside the pairs matrix");
    const ha = headerArms(t)!;
    const isTag = (tag: number): IrExpr => ({
      kind: "unionIsTag",
      unionId: t.unionId,
      tag,
      negated: false,
      value: raw,
      type: BOOL,
      loc,
    });
    const narrowTo = (tag: number, nt: IrType): IrExpr => ({
      kind: "unionNarrow",
      unionId: t.unionId,
      tag,
      value: raw,
      type: nt,
      loc,
    });
    let chain: IrStmt[] = [];
    if (ha.arr >= 0) {
      const uid = siteNo++;
      const aT = arrayOf(STRING);
      locals.push(
        { id: `a.${uid}`, name: `a${uid}`, type: aT, mutable: false },
        { id: `j.${uid}`, name: `j${uid}`, type: F64, mutable: true },
      );
      const aRef = varRef(`a.${uid}`, aT, loc);
      const jRef = varRef(`j.${uid}`, F64, loc);
      chain = [
        {
          kind: "if",
          cond: isTag(ha.arr),
          then: [
            { kind: "varDecl", localId: `a.${uid}`, init: narrowTo(ha.arr, aT), loc },
            {
              kind: "for",
              init: { kind: "varDecl", localId: `j.${uid}`, init: numLit(0, loc), loc },
              cond: {
                kind: "bin",
                op: "<",
                left: jRef,
                right: {
                  kind: "arrIntrinsic",
                  method: "length",
                  receiver: aRef,
                  args: [],
                  type: F64,
                  loc,
                },
                type: BOOL,
                loc,
              },
              update: {
                kind: "assign",
                localId: `j.${uid}`,
                value: { kind: "bin", op: "+", left: jRef, right: numLit(1, loc), type: F64, loc },
                loc,
              },
              body: [push(k, { kind: "arrayGet", arr: aRef, index: jRef, type: STRING, loc })],
              loc,
            },
          ],
          else_: chain.length > 0 ? chain : null,
          loc,
        },
      ];
    }
    if (ha.f64 >= 0) {
      chain = [
        {
          kind: "if",
          cond: isTag(ha.f64),
          then: [push(k, { kind: "toString", operand: narrowTo(ha.f64, F64), type: STRING, loc })],
          else_: chain.length > 0 ? chain : null,
          loc,
        },
      ];
    }
    if (ha.str >= 0) {
      chain = [
        {
          kind: "if",
          cond: isTag(ha.str),
          then: [push(k, narrowTo(ha.str, STRING))],
          else_: chain.length > 0 ? chain : null,
          loc,
        },
      ];
    }
    return { kind: "block", body: chain, loc };
  };
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: arrT, loc },
      loc,
    },
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
    const rawRead: IrExpr = {
      kind: "recordKeyGet",
      obj: sRef,
      shapeId,
      key: varRef("k.0", STRING, loc),
      overflowOnly: true,
      type: iv,
      loc,
    };
    const utag = iv.kind === "union" ? lowerer.armTag(iv.unionId, UNDEFINED_T) : -1;
    const innerBody: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "k.0",
        init: {
          kind: "arrayGet",
          arr: varRef("ks.0", ksT, loc),
          index: varRef("i.0", F64, loc),
          type: STRING,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "raw.0", init: rawRead, loc },
    ];
    const rawRef = varRef("raw.0", iv, loc);
    void utag;
    innerBody.push(writeFor(varRef("k.0", STRING, loc), rawRef, iv));
    body.push(
      {
        kind: "varDecl",
        localId: "ks.0",
        init: { kind: "recordOvfKeys", obj: sRef, shapeId, type: ksT, loc },
        loc,
      },
      countedFor(
        loc,
        {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("ks.0", ksT, loc),
          args: [],
          type: F64,
          loc,
        },
        () => innerBody,
      ),
    );
  }
  body.push({ kind: "return", value: outRef, loc });
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "s.0", name: "s", type: recT }],
    returnType: arrT,
    locals,
    body,
    loc,
  });
  return name;
}
