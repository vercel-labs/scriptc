import { keyedHelperName } from "./stable-names.js";
import { InternalCompilerError } from "../../errors.js";
import { dynUndefinedExpr, helperLoc, numLit, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  isIntegerBytesElem,
  isUnitType,
  canBoxFuncIntoDyn,
  type SrcLoc,
  STRING,
  UNDEFINED_T,
  typeEquals,
  sortArms,
  typeKey,
  unionContainerArmsOk,
} from "../../ir/ir.js";
import { everyExpr } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";
import { isCheckerPanic } from "../../diagnostics/diagnostic.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";

/** Test whether one array index contains a value rather than a hole. */
export function arrayIndexPresent(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "arrayHas",
    arr,
    index,
    type: BOOL,
    loc,
  };
}

/** Test the conventional `a.0[i.0]` slot used by synthesized array loops. */
export function currentArrayIndexPresent(arrType: IrType, loc: SrcLoc): IrExpr {
  return arrayIndexPresent(varRef("a.0", arrType, loc), varRef("i.0", F64, loc), loc);
}

/** The value yielded by a JavaScript array read, independent of its slot's storage type. */
export function arrayValueType(lowerer: Lowerer, elem: IrType): IrType {
  if (elem.kind === "dyn") return elem;
  return elem.kind === "union"
    ? (lowerer.withUndefinedArmOf(elem) ?? elem)
    : lowerer.withUndefinedArm(elem);
}

/** ToNumber of one stabilized `number[]` element read: a hole, a present
 * undefined and a missing index all read as NaN, which is
 * ToNumber(undefined). Numeric updates use it in place of the optional
 * element value. */
export function arrayNumberRead(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: arr,
    args: [index],
    type: F64,
    loc,
  };
}

/** A foreign element read into a typed result: it never fits, so the read
 * throws the checked conversion's TypeError (array.foreignThrow). */
export function foreignElementThrow(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "libCall",
    fn: "array.foreignThrow",
    args: [arr, index, { kind: "strLit", value: lowerer.fmt(type), type: STRING, loc }],
    type,
    loc,
  };
}

/** Arrays of this element type can hold elements outside it, stored
 * through dynamic views (Lowerer.foreignElementKeys). */
export function elementMayBeForeign(lowerer: Lowerer, elem: IrType): boolean {
  const keys = lowerer.foreignElementKeys;
  return keys.size > 0 && elem.kind !== "dyn" && (keys.has("*") || keys.has(typeKey(elem)));
}

/** Read one stabilized receiver/index pair. Both a hole and present undefined yield undefined;
 * a foreign element (state 3) takes the checked conversion into the typed result. */
export function arrayValueRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr {
  const type = arrayValueType(lowerer, elem);
  const read: IrExpr = { kind: "arrayGet", arr, index, type: elem, loc };
  let missing: IrExpr =
    type.kind === "dyn" ? dynUndefinedExpr(loc) : lowerer.wrappedUndefined(type, loc)!;
  if (elementMayBeForeign(lowerer, elem)) {
    missing = {
      kind: "ternary",
      cond: {
        kind: "bin",
        op: "===",
        left: { kind: "arrayState", arr, index, type: F64, loc },
        right: { kind: "numLit", value: 3, type: F64, loc },
        type: BOOL,
        loc,
      },
      then: foreignElementThrow(lowerer, arr, index, type, loc),
      else_: missing,
      type,
      loc,
    };
  }
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: typeEquals(elem, type) ? read : lowerer.coerceToExpected(read, type),
    else_: missing,
    type,
    loc,
  };
}

/** A tuple arm's answer at a constant position: its field, or "past" its
 * end. Null when the arm is not a tuple or the position is not constant. */
function tupleArmField(
  lowerer: Lowerer,
  arm: IrType,
  position: string | null,
): { name: string; type: IrType } | "past" | null {
  if (arm.kind !== "record" || position === null) return null;
  const shape = lowerer.shapes.get(arm.shapeId);
  if (!shape?.tuple) return null;
  return shape.fields.find((f) => f.name === position) ?? "past";
}

/** A union of tuples and arrays read where the checker sees ONE array type
 * (`(stops as readonly string[]).includes(stop)`, `.length`, `[i]`, a
 * `for…of`, over the values of an `as const` table: the assertion is
 * erased, so the value keeps its union layout). A slot of the array type
 * converts such a value arm by arm into a fresh array (widthLiftPlan's
 * unionArr). These consumers are no slot and must read the value itself: a
 * callback, a loop body or an index expression can write a tuple the value
 * holds, and a copy made when the receiver was evaluated would not show
 * the write. They get the value with its unit arms taken off by the
 * checked narrowing (the checker excluded those arms; a value that still
 * holds one throws there) and read each arm in place: an array arm as any
 * array, a tuple arm position by position. Null when the value is no such
 * union. */
export function unionArmsView(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
  read: IrType | null,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "union" || read?.kind !== "array") return null;
  if (lowerer.widthLiftPlan(value.type, read)?.how !== "unionArr") return null;
  refuseReadBesideMutableSlot(lowerer, node);
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms ?? [];
  const present = arms.filter((arm) => !isUnitType(arm));
  if (present.length === arms.length) return value;
  if (present.length === 1) {
    const helper = lowerer.narrowedArmHelper(unionId, present[0]!, loc);
    return helper ? lowerer.checkedNarrowCall(helper, value, present[0]!, loc) : null;
  }
  const toId = lowerer.unions.intern(present);
  const helper = lowerer.narrowedRetagHelper(node, unionId, toId, loc);
  return helper
    ? { kind: "call", callee: helper, args: [value], type: { kind: "union", unionId: toId }, loc }
    : null;
}

/** Reading a union of tuples in place makes programs build that stopped
 * at those reads before. One kind of them must keep stopping: a program
 * that also hands the same binding to a slot of a MUTABLE array type
 * (`const alias = names as unknown as string[]`, an argument for a
 * `string[]` parameter). That slot holds a copy of the tuple
 * (unionArrayWidthHelper), so a write through it is lost for the tuple,
 * and the read here would answer the unwritten elements without an error.
 * The read is refused, naming the slot, until tuples that reach an array
 * slot are arrays. A `readonly` array slot cannot be written through and
 * does not count. Only a binding named by the read is followed: the same
 * tuple reached through another expression is not seen. */
function refuseReadBesideMutableSlot(lowerer: Lowerer, node: ts.Node): void {
  if (!ts.isExpression(node)) return;
  const read = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(read)) return;
  const symbol = lowerer.checker.getSymbolAtLocation(read);
  if (!symbol) return;
  const slot = mutableArraySlotUseOf(lowerer, symbol, read.text);
  if (slot === null) return;
  const line =
    ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(slot), ts.tokenStartOfNode(slot)).line +
    1;
  lowerer.unsupported(
    "SC1090",
    node,
    `reading a union of tuples in place while '${read.text}' is also handed to a mutable array slot (line ${line}: that slot holds a copy of the tuple, so a write through it would not be seen here; declare the slot 'readonly', or narrow the value to one tuple first)`,
  );
}

/** Where the binding `symbol` is handed to a slot of a mutable array type
 * in the source that declares it: an initializer, an argument, a returned
 * or assigned value, a property or element of a literal, behind any
 * assertion. Null when it never is. */
function mutableArraySlotUseOf(lowerer: Lowerer, symbol: ts.Symbol, name: string): ts.Node | null {
  const known = lowerer.mutableArraySlotUses.get(symbol);
  if (known !== undefined) return known;
  let found: ts.Node | null = null;
  const declaration = symbol.declarations[0];
  if (declaration !== undefined) {
    ts.walkPreorder(ts.getSourceFileOfNode(declaration), (node) => {
      if (
        !ts.isIdentifier(node) ||
        node.text !== name ||
        lowerer.checker.getSymbolAtLocation(node) !== symbol
      )
        return undefined;
      // The reference with every assertion around it: the value a slot gets.
      let value: ts.Expression = node;
      while (
        value.parent !== undefined &&
        (ts.isParenthesizedExpression(value.parent) ||
          ts.isAsExpression(value.parent) ||
          ts.isTypeAssertion(value.parent) ||
          ts.isSatisfiesExpression(value.parent) ||
          ts.isNonNullExpression(value.parent)) &&
        value.parent.expression === value
      )
        value = value.parent;
      if (handedToMutableArraySlot(lowerer, value)) {
        found = value;
        return "stop";
      }
      return undefined;
    });
  }
  lowerer.mutableArraySlotUses.set(symbol, found);
  return found;
}

/** Whether `value` sits where a slot takes it and that slot's type is a
 * mutable array: the slot's own type where the checker has one (a
 * parameter, a declared binding, a return type), else the value's own type
 * as the initializer of an undeclared binding. A receiver, an iterable or
 * a spread operand is no slot. */
function handedToMutableArraySlot(lowerer: Lowerer, value: ts.Expression): boolean {
  const parent = value.parent;
  if (parent === undefined || ts.isSpreadElement(parent)) return false;
  let type: ts.Type | null | undefined;
  try {
    type = lowerer.checker.getContextualType(value);
    if (
      !type &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === value &&
      parent.type === undefined
    )
      type = lowerer.typeOf(value);
  } catch (e) {
    if (isCheckerPanic(e)) return false;
    throw e;
  }
  if (!type) return false;
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  return members.some((member) => {
    const symbol = member.getSymbol();
    return symbol !== undefined && ts.symbolName(symbol) === "Array";
  });
}

/** The same union where every element is read at once, with no code of
 * the program between the receiver's evaluation and the last read (a
 * spread): the array a slot's conversion builds is then what the value
 * holds at that moment, and nothing can tell it from the original. Null
 * when the value is no such union. */
export function unionReadAsArray(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
  read: IrType | null,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "union" || read?.kind !== "array") return null;
  const lift = lowerer.widthLiftPlan(value.type, read);
  if (lift?.how !== "unionArr") return null;
  refuseReadBesideMutableSlot(lowerer, node);
  return lowerer.applyWidthLift(lift, value, read, loc);
}

/** A tuple's fields in position order. */
function tupleFields(
  lowerer: Lowerer,
  tuple: IrType,
): { shapeId: string; fields: { name: string; type: IrType }[] } | null {
  if (tuple.kind !== "record") return null;
  const shape = lowerer.shapes.get(tuple.shapeId);
  if (!shape?.tuple) return null;
  return {
    shapeId: tuple.shapeId,
    fields: [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name)),
  };
}

/** One position of a tuple at an index known only when the program runs:
 * the field the index names, read when the index is known, or the missing
 * value past its end. `tuple` and `index` are read several times and must
 * be stable. */
function tupleMovingRead(
  lowerer: Lowerer,
  tuple: IrExpr,
  index: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr | null {
  const layout = tupleFields(lowerer, tuple.type);
  if (layout === null) return null;
  let read = positionMissing(lowerer, type, loc);
  if (!read) return null;
  for (let i = layout.fields.length - 1; i >= 0; i--) {
    const field = layout.fields[i]!;
    const held = positionAnswer(
      lowerer,
      {
        kind: "recordGet",
        obj: tuple,
        shapeId: layout.shapeId,
        field: field.name,
        type: field.type,
        loc,
      },
      type,
    );
    if (held === null) return null;
    read = {
      kind: "ternary",
      cond: {
        kind: "bin",
        op: "===",
        left: index,
        right: numLit(Number(field.name), loc),
        type: BOOL,
        loc,
      },
      then: held,
      else_: read,
      type,
      loc,
    };
  }
  return read;
}

/** Whether the checked-dynamic value holds a value of type `arm` itself:
 * by value (the scalars and the unit values are its own kinds) or by
 * reference (a URL, a function it can box). These are the arms the type
 * mapper lets share the checked-dynamic representation with a
 * checked-dynamic arm (`Response | undefined`, `string | Response`),
 * without the records, arrays and promises, which enter it as copies: a
 * position read answers the element the tuple holds, never a copy. */
function dynHoldsItself(lowerer: Lowerer, arm: IrType): boolean {
  switch (arm.kind) {
    case "dyn":
    case "f64":
    case "string":
    case "bool":
    case "undefinedT":
    case "nullT":
    case "url":
      return true;
    case "func":
      return canBoxFuncIntoDyn(
        arm,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      );
    default:
      return false;
  }
}

/** The one type the arms' answers at a position read as: the answer itself
 * when they agree, the checked-dynamic value when one answer is
 * checked-dynamic (a fetch handle) and it holds every other answer itself
 * (dynHoldsItself): the representation the checker's type of the read
 * (`Response | undefined`) has in any other slot. Otherwise the union of
 * the answers. Null when they have no common native representation. */
function positionAnswerType(lowerer: Lowerer, answers: IrType[]): IrType | null {
  const joined = sortArms(answers);
  if (joined.length === 1) return joined[0]!;
  if (joined.some((arm) => arm.kind === "generator" || arm.kind === "caught")) return null;
  if (joined.some((arm) => arm.kind === "dyn"))
    return joined.every((arm) => dynHoldsItself(lowerer, arm)) ? DYN : null;
  if (!unionContainerArmsOk(joined)) return null;
  return { kind: "union", unionId: lowerer.unions.intern(joined) };
}

/** What a position read of type `type` answers where an arm has no such
 * position: undefined in the read's representation. Null when `type` has
 * no undefined. */
function positionMissing(lowerer: Lowerer, type: IrType, loc: SrcLoc): IrExpr | null {
  return type.kind === "dyn" ? dynUndefinedExpr(loc) : lowerer.wrappedUndefined(type, loc);
}

/** One arm's answer in the read's representation. Null when the
 * conversion into the checked-dynamic value does not reach it. */
function positionAnswer(lowerer: Lowerer, answer: IrExpr, type: IrType): IrExpr | null {
  const held = lowerer.coerceToExpected(answer, type);
  return type.kind !== "dyn" || held.type.kind === "dyn" ? held : null;
}

/** The type a position of a tuple reads as when the index is known only
 * when the program runs: every field's type and undefined past its end.
 * Null when they have no common native representation. */
function tupleMovingType(lowerer: Lowerer, tuple: IrType): IrType | null {
  const layout = tupleFields(lowerer, tuple);
  if (layout === null) return null;
  const answers = new Map<string, IrType>([[typeKey(UNDEFINED_T), UNDEFINED_T]]);
  for (const field of layout.fields) {
    const parts =
      field.type.kind === "union" ? lowerer.unions.get(field.type.unionId)!.arms : [field.type];
    for (const part of parts) answers.set(typeKey(part), part);
  }
  if (answers.size < 2) return null;
  return positionAnswerType(lowerer, [...answers.values()]);
}

/** `view[key]` over what unionArmsView answers: the position is read in
 * place after the receiver and the key have been evaluated, in that order,
 * each once. Null when the arms' elements have no common representation. */
export function unionArmsIndexRead(
  lowerer: Lowerer,
  view: IrExpr,
  key: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  const type =
    view.type.kind === "union"
      ? unionArrayValueType(lowerer, view.type, null, false, true)
      : tupleMovingType(lowerer, view.type);
  if (type === null) return null;
  const stmts: IrStmt[] = [];
  const stable = (e: IrExpr, name: string, keep: boolean): IrExpr => {
    if (keep) return e;
    const local = lowerer.declareHiddenLocal(name, e.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: e, loc });
    return varRef(local.id, e.type, loc);
  };
  // A receiver local stays a direct read only when the key cannot assign it.
  const plainKey = key.kind === "varRef" || key.kind === "numLit";
  const receiver = stable(view, "%indexReceiver", view.kind === "varRef" && plainKey);
  const index = stable(key, "%indexKey", plainKey);
  const read =
    receiver.type.kind === "union"
      ? unionArrayValueRead(lowerer, receiver, index, loc, undefined, true)
      : tupleMovingRead(lowerer, receiver, index, type, loc);
  if (read === null) return null;
  return stmts.length === 0 ? read : { kind: "seqExpr", stmts, result: read, type: read.type, loc };
}

/** `view.length` over what unionArmsView answers: an array arm's length,
 * a tuple arm's number of positions. The receiver is evaluated once. */
export function unionArmsLength(lowerer: Lowerer, view: IrExpr, loc: SrcLoc): IrExpr {
  const armLength = (arm: IrType, value: IrExpr): IrExpr => {
    const layout = tupleFields(lowerer, arm);
    return layout === null
      ? { kind: "arrIntrinsic", method: "length", receiver: value, args: [], type: F64, loc }
      : numLit(layout.fields.length, loc);
  };
  const stmts: IrStmt[] = [];
  let receiver = view;
  if (view.kind !== "varRef") {
    const local = lowerer.declareHiddenLocal("%lengthReceiver", view.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: view, loc });
    receiver = varRef(local.id, view.type, loc);
  }
  let length: IrExpr;
  if (receiver.type.kind !== "union") {
    length = armLength(receiver.type, receiver);
  } else {
    const unionId = receiver.type.unionId;
    const arms = lowerer.unions.get(unionId)!.arms;
    const narrowed = (tag: number): IrExpr => ({
      kind: "unionNarrow",
      unionId,
      tag,
      value: receiver,
      type: arms[tag]!,
      loc,
    });
    length = armLength(arms[arms.length - 1]!, narrowed(arms.length - 1));
    for (let tag = arms.length - 2; tag >= 0; tag--) {
      length = {
        kind: "ternary",
        cond: {
          kind: "unionIsTag",
          unionId,
          tag,
          negated: false,
          value: receiver,
          type: BOOL,
          loc,
        },
        then: armLength(arms[tag]!, narrowed(tag)),
        else_: length,
        type: F64,
        loc,
      };
    }
  }
  return stmts.length === 0 ? length : { kind: "seqExpr", stmts, result: length, type: F64, loc };
}

/** The array type a union of tuples and arrays converts to where nothing
 * names one (`for (const stop of LINES[key])`, `stops.includes(stop)` over
 * the values of an `as const` table): every arm is an array or a tuple, at
 * least one of them a tuple, and all their elements have one type (unit
 * arms aside). A union of arrays alone has its own walk and keeps it. Null
 * for any other type. */
export function unionTupleJoin(
  lowerer: Lowerer,
  type: IrType | null,
): (IrType & { kind: "array" }) | null {
  if (type?.kind !== "union") return null;
  const arms = lowerer.unions.get(type.unionId)?.arms;
  if (!arms?.length) return null;
  let elem: IrType | null = null;
  let tuple = false;
  for (const arm of arms) {
    let parts: IrType[];
    // A unit arm the checker excluded (the slot's own `undefined`): the
    // conversion throws for it, as it does into a declared array slot.
    if (arm.kind === "undefinedT" || arm.kind === "nullT") continue;
    if (arm.kind === "array") {
      parts = [arm.elem];
    } else {
      const shape = arm.kind === "record" ? lowerer.shapes.get(arm.shapeId) : undefined;
      if (!shape?.tuple) return null;
      tuple = true;
      parts = shape.fields.map((field) => field.type);
    }
    for (const part of parts) {
      if (elem === null) elem = part;
      else if (!typeEquals(elem, part)) return null;
    }
  }
  if (!tuple || elem === null) return null;
  const target: IrType & { kind: "array" } = { kind: "array", elem };
  return lowerer.widthLiftPlan(type, target)?.how === "unionArr" ? target : null;
}

/** The type one position of a union of native arrays and tuples reads as
 * (unionArrayValueRead): the join of every arm's answer — an array arm's
 * element value with its missing-value case, a tuple arm's field at the
 * constant `position` or undefined past its end, and with `strings` a
 * string arm's code point. Null when an arm answers no position, or the
 * answers have no common native representation. */
export function unionArrayValueType(
  lowerer: Lowerer,
  union: IrType,
  position: string | null = null,
  strings = false,
  moving = false,
): IrType | null {
  if (union.kind !== "union") return null;
  const arms = lowerer.unions.get(union.unionId)?.arms;
  if (!arms?.length) return null;
  // Keep the collection's IrType union layout and narrow each element at
  // its use; an inferred array predicate changes the collection's ABI.
  const stringArm = (arm: IrType): boolean => arm.kind === "string" && strings;
  // With `moving`, a tuple arm answers a position known only when the
  // program runs: any of its fields, or undefined past its end.
  const movingArm = (arm: IrType): IrType | null =>
    moving && position === null ? tupleMovingType(lowerer, arm) : null;
  for (const arm of arms)
    if (
      arm.kind !== "array" &&
      !stringArm(arm) &&
      movingArm(arm) === null &&
      tupleArmField(lowerer, arm, position) === null
    )
      return null;
  const answers = new Map<string, IrType>();
  for (const arm of arms) {
    const anyField = arm.kind === "array" || stringArm(arm) ? null : movingArm(arm);
    const field =
      arm.kind === "array" || stringArm(arm) || anyField !== null
        ? null
        : tupleArmField(lowerer, arm, position);
    const answer =
      arm.kind === "array"
        ? arrayValueType(lowerer, arm.elem)
        : stringArm(arm)
          ? arrayValueType(lowerer, STRING)
          : anyField !== null
            ? anyField
            : field === "past"
              ? UNDEFINED_T
              : field!.type;
    const parts = answer.kind === "union" ? lowerer.unions.get(answer.unionId)!.arms : [answer];
    for (const part of parts) answers.set(typeKey(part), part);
  }
  if (answers.size === 1 && answers.has(typeKey(UNDEFINED_T))) return null;
  return positionAnswerType(lowerer, [...answers.values()]);
}

/** Read one position of a stabilized union of native arrays and tuples
 * (`const [a, b] = re.exec(s) || ["", ""]`) without copying the receiver
 * or its elements. Every array arm contributes its missing-value case; a
 * tuple arm answers its field, or undefined past its end. Tuple arms need
 * a constant position, or `moving` (the field the index names when the
 * program runs; `value` and `index` must then be stable: they are read
 * once per field). With `stringChars` (the string iterator's code
 * points as a fresh string[]), a string arm (`re.exec(s) || ""`) answers
 * its code point at the position, or undefined past its end. */
export function unionArrayValueRead(
  lowerer: Lowerer,
  value: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
  stringChars?: (text: IrExpr) => IrExpr,
  moving = false,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms?.length) return null;
  const position = !moving && index.kind === "numLit" ? String(index.value) : null;
  const tupleField = (arm: IrType): { name: string; type: IrType } | "past" | null =>
    tupleArmField(lowerer, arm, position);
  const stringArm = (arm: IrType): boolean => arm.kind === "string" && stringChars !== undefined;
  const type = unionArrayValueType(
    lowerer,
    value.type,
    position,
    stringChars !== undefined,
    moving,
  );
  if (type === null) return null;
  let result: IrExpr | null = null;
  for (let tag = arms.length - 1; tag >= 0; tag--) {
    const arm = arms[tag]!;
    const receiver: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arm, loc };
    let read: IrExpr | null;
    if (arm.kind === "array") {
      read = positionAnswer(lowerer, arrayValueRead(lowerer, receiver, index, arm.elem, loc), type);
    } else if (stringArm(arm)) {
      read = positionAnswer(
        lowerer,
        arrayValueRead(lowerer, stringChars!(receiver), index, STRING, loc),
        type,
      );
    } else if (moving && position === null) {
      // `value` and `index` are stable here: the caller holds both.
      read = tupleMovingRead(lowerer, receiver, index, type, loc);
    } else {
      const field = tupleField(arm);
      if (field === null) return null;
      read =
        field === "past"
          ? positionMissing(lowerer, type, loc)
          : positionAnswer(
              lowerer,
              {
                kind: "recordGet",
                obj: receiver,
                shapeId: (arm as IrType & { kind: "record" }).shapeId,
                field: field.name,
                type: field.type,
                loc,
              },
              type,
            );
    }
    if (read === null) return null;
    result =
      result === null
        ? read
        : {
            kind: "ternary",
            cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
            then: read,
            else_: result,
            type,
            loc,
          };
  }
  return result;
}

/** Expression kinds that evaluate without running other code or writing
 * a binding. */
const PURE_KINDS = new Set<IrExpr["kind"]>([
  "varRef",
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "bin",
  "unary",
  "logical",
  "ternary",
  "toBool",
  "fieldGet",
  "recordGet",
  "arrayGet",
  "arrayState",
  "arrayHas",
  "unionIsTag",
  "unionNarrow",
  "unionWrap",
  // Its statements are checked on their own (declarations and assignments
  // are recorded writes).
  "seqExpr",
]);

/** The locals evaluating `value` may assign, and whether it may run other
 * code (anything but the pure kinds and the read-only element helpers),
 * which can assign locals and fields through closures. */
function valueEffects(lowerer: Lowerer, value: IrExpr): { writes: Set<string>; opaque: boolean } {
  const readers = new Set<string>();
  for (const [key, name] of lowerer.arrHofHelpers) if (key.startsWith("idxOr:")) readers.add(name);
  const writes = new Set<string>();
  let opaque = false;
  everyExpr(value, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") writes.add(e.localId);
      else if (e.kind === "libCall") {
        // The "undefined" key of an undefined index is a constant.
        if (e.fn !== "array.undefinedKey") opaque = true;
      } else if (e.kind === "call" ? !readers.has(e.callee) : !PURE_KINDS.has(e.kind))
        opaque = true;
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl" || s.kind === "assign") writes.add(s.localId);
      else opaque = true;
      return true;
    },
  });
  return { writes, opaque };
}

/** Whether evaluating `e` after `value` gives what it gives before it: a
 * literal, or a local and field read `value` cannot change. */
function unaffectedBy(e: IrExpr, effects: { writes: Set<string>; opaque: boolean }): boolean {
  switch (e.kind) {
    case "numLit":
    case "strLit":
      return true;
    case "varRef":
      return !effects.writes.has(e.localId);
    case "bin":
      return unaffectedBy(e.left, effects) && unaffectedBy(e.right, effects);
    case "fieldGet":
    case "recordGet":
      return !effects.opaque && unaffectedBy(e.obj, effects);
    default:
      return false;
  }
}

/** Whether `e` reads a `let` or `var` binding, which code the value runs
 * can assign through a closure. */
function readsMutableLocal(lowerer: Lowerer, e: IrExpr): boolean {
  return !everyExpr(e, {
    expr: (x) =>
      x.kind !== "varRef" || lowerer.ctx.locals.find((l) => l.id === x.localId)?.mutable === false,
    stmt: () => true,
  });
}

/** Whether `receiver` still reads the same value after `index` runs: the
 * index assigns none of the bindings it reads, and runs no code that could
 * assign them through a closure. */
export function unaffectedByIndex(lowerer: Lowerer, receiver: IrExpr, index: IrExpr): boolean {
  const effects = valueEffects(lowerer, index);
  return (
    unaffectedBy(receiver, effects) && !(effects.opaque && readsMutableLocal(lowerer, receiver))
  );
}

/** A number, string or boolean element type. Arrays of it hold a present
 * undefined in the element's state, so `(T | undefined)[]` stores T
 * elements (the type mapper) and a T[] seen as one stays the same array. */
export function primitiveElement(elem: IrType): boolean {
  return elem.kind === "f64" || elem.kind === "string" || elem.kind === "bool";
}

/** `value` is the element type with undefined, stored into an array of a
 * primitive element type: a present undefined or the element. */
export function optionalElementValue(lowerer: Lowerer, value: IrExpr, elem: IrType): boolean {
  if (!primitiveElement(elem)) return false;
  if (value.type.kind === "undefinedT") return true;
  return (
    value.type.kind === "union" &&
    lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0 &&
    typeEquals(lowerer.stripUndefinedArm(value.type), elem)
  );
}

/** A value of a primitive element type that holds a slot until the value
 * stored there replaces it (insertedValues), or stands for a slot that is
 * not read. */
export function elementPlaceholder(elem: IrType, loc: SrcLoc): IrExpr {
  if (elem.kind === "f64") return { kind: "numLit", value: 0, type: F64, loc };
  if (elem.kind === "bool") return { kind: "boolLit", value: false, type: BOOL, loc };
  return { kind: "strLit", value: "", type: STRING, loc };
}

/** Values inserted into an array (push, unshift, splice, a literal), in
 * source order. A value that can be undefined (optionalElementValue) is
 * kept in a temporary: the insertion takes a placeholder for it, and
 * `fill` then stores the value at the placeholder's index. */
export function insertedValues(
  lowerer: Lowerer,
  values: readonly IrExpr[],
  elem: IrType,
  coerce: (value: IrExpr, index: number) => IrExpr,
  loc: SrcLoc,
): {
  stmts: IrStmt[];
  args: IrExpr[];
  optional: boolean;
  fill: (arr: IrExpr, first: IrExpr) => IrStmt[];
} {
  if (!values.some((value) => optionalElementValue(lowerer, value, elem)))
    return { stmts: [], args: values.map(coerce), optional: false, fill: () => [] };
  const stmts: IrStmt[] = [];
  const args: IrExpr[] = [];
  const held: { offset: number; value: IrExpr }[] = [];
  values.forEach((value, offset) => {
    // Every value is evaluated in order before the insertion.
    if (value.type.kind === "undefinedT") {
      if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
      args.push(elementPlaceholder(elem, loc));
      held.push({ offset, value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc } });
      return;
    }
    const temp = lowerer.declareHiddenLocal("%inserted", value.type);
    stmts.push({ kind: "varDecl", localId: temp.id, init: value, loc });
    const stable = varRef(temp.id, temp.type, loc);
    if (optionalElementValue(lowerer, value, elem)) {
      args.push(elementPlaceholder(elem, loc));
      held.push({ offset, value: stable });
    } else {
      args.push(coerce(stable, offset));
    }
  });
  const fill = (arr: IrExpr, first: IrExpr): IrStmt[] =>
    held.map(({ offset, value }) =>
      arrayValueStore(
        lowerer,
        arr,
        offset === 0
          ? first
          : {
              kind: "bin",
              op: "+",
              left: first,
              right: { kind: "numLit", value: offset, type: F64, loc },
              type: F64,
              loc,
            },
        value,
        elem,
        loc,
      ),
    );
  return { stmts, args, optional: true, fill };
}

/** Statements appending `value` to `arr` inside a lifted helper. A value
 * that can be undefined in a primitive array (optionalElementValue) is held
 * in the helper's local `slot` (which the caller declares with the value's
 * type) and stored as a present undefined or the element; any other value
 * converts to the element type. */
export function appendElement(
  lowerer: Lowerer,
  arr: IrExpr,
  value: IrExpr,
  elem: IrType,
  slot: string,
  loc: SrcLoc,
): IrStmt[] {
  if (optionalElementValue(lowerer, value, elem) && value.type.kind !== "undefinedT") {
    const held = varRef(slot, value.type, loc);
    const length: IrExpr = {
      kind: "arrIntrinsic",
      method: "length",
      receiver: arr,
      args: [],
      type: F64,
      loc,
    };
    return [
      { kind: "varDecl", localId: slot, init: value, loc },
      arrayValueStore(lowerer, arr, length, held, elem, loc),
    ];
  }
  return [
    {
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: arr,
        args: [lowerer.coerceToExpected(value, elem)],
        type: F64,
        loc,
      },
      loc,
    },
  ];
}

/** The argument a helper passes in place of an element its callback never
 * reads (lowerArrayCallback's `unread`): a constant of the parameter's
 * type, so the slot stays unread and an element the type cannot hold
 * (stored through a dynamic view) passes. Null for a type without one. */
export function unreadArgument(lowerer: Lowerer, type: IrType, loc: SrcLoc): IrExpr | null {
  if (type.kind === "f64") return { kind: "numLit", value: NaN, type: F64, loc };
  if (type.kind === "bool") return { kind: "boolLit", value: false, type: BOOL, loc };
  if (type.kind === "string") return { kind: "strLit", value: "", type: STRING, loc };
  if (type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0)
    return lowerer.wrappedUndefined(type, loc) ?? null;
  return null;
}

/** The locals of an element snapshot (arraySlotSnapshot): whether the slot
 * held an element outside the element type, the value read otherwise, and
 * that element's dynamic value otherwise. */
export interface SlotSnapshot {
  isForeign: string;
  value: string;
  foreign: string;
}

/** The locals a snapshot of an `elem` element uses. */
export function slotSnapshotLocals(lowerer: Lowerer, elem: IrType, ids: SlotSnapshot): IrLocal[] {
  return [
    { id: ids.isForeign, name: "foreign", type: BOOL, mutable: false },
    { id: ids.value, name: "value", type: arrayValueType(lowerer, elem), mutable: false },
    { id: ids.foreign, name: "element", type: DYN, mutable: false },
  ];
}

/** Read the element at `arr[index]` as it is stored, before a callback runs,
 * as JavaScript reads it before calling a callback that ignores it: a value
 * or a present undefined into `ids.value`, or an element outside the element
 * type (stored through a dynamic view) as its dynamic value into
 * `ids.foreign`, which `ids.isForeign` tells apart. */
export function arraySlotSnapshot(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  elem: IrType,
  ids: SlotSnapshot,
  loc: SrcLoc,
): IrStmt[] {
  const valueT = arrayValueType(lowerer, elem);
  const isForeign: IrExpr = { kind: "varRef", localId: ids.isForeign, type: BOOL, loc };
  const missing =
    valueT.kind === "dyn" ? dynUndefinedExpr(loc) : lowerer.wrappedUndefined(valueT, loc)!;
  return [
    {
      kind: "varDecl",
      localId: ids.isForeign,
      init: {
        kind: "bin",
        op: "===",
        left: { kind: "arrayState", arr, index, type: F64, loc },
        right: { kind: "numLit", value: 3, type: F64, loc },
        type: BOOL,
        loc,
      },
      loc,
    },
    {
      kind: "varDecl",
      localId: ids.value,
      init: {
        kind: "ternary",
        cond: isForeign,
        then: missing,
        else_: arrayValueRead(lowerer, arr, index, elem, loc),
        type: valueT,
        loc,
      },
      loc,
    },
    {
      kind: "varDecl",
      localId: ids.foreign,
      init: {
        kind: "ternary",
        cond: isForeign,
        then: { kind: "libCall", fn: "array.foreign", args: [arr, index], type: DYN, loc },
        else_: dynUndefinedExpr(loc),
        type: DYN,
        loc,
      },
      loc,
    },
  ];
}

/** Append a snapshot (arraySlotSnapshot) of an element to `out`, an array of
 * the same element type, as it was stored: an element outside the element
 * type stays one, appended as the view's push appends it. `out` is a
 * binding. */
export function arraySnapshotAppend(
  lowerer: Lowerer,
  out: IrExpr,
  elem: IrType,
  ids: SlotSnapshot,
  loc: SrcLoc,
): IrStmt {
  const end: IrExpr = {
    kind: "arrIntrinsic",
    method: "length",
    receiver: out,
    args: [],
    type: F64,
    loc,
  };
  const value: IrExpr = {
    kind: "varRef",
    localId: ids.value,
    type: arrayValueType(lowerer, elem),
    loc,
  };
  return {
    kind: "if",
    cond: { kind: "varRef", localId: ids.isForeign, type: BOOL, loc },
    then: [
      {
        kind: "exprStmt",
        expr: {
          kind: "dynInvoke",
          recv: { kind: "dynFrom", value: out, liveRef: true, type: DYN, loc },
          method: "push",
          calleeName: "push",
          args: [{ kind: "varRef", localId: ids.foreign, type: DYN, loc }],
          type: DYN,
          loc,
        },
        loc,
      },
    ],
    else_: [arrayValueStore(lowerer, out, end, value, elem, loc)],
    loc,
  };
}

/** A snapshot (arraySlotSnapshot) as a value of `type`: the value read, or
 * the element outside the element type through the checked conversion,
 * which such an element fails as a typed read does. `typed` converts the
 * value read. */
export function arraySnapshotValue(
  lowerer: Lowerer,
  elem: IrType,
  ids: SlotSnapshot,
  type: IrType,
  typed: (value: IrExpr) => IrExpr,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "ternary",
    cond: { kind: "varRef", localId: ids.isForeign, type: BOOL, loc },
    then: lowerer.coerceToExpected({ kind: "varRef", localId: ids.foreign, type: DYN, loc }, type),
    else_: typed({ kind: "varRef", localId: ids.value, type: arrayValueType(lowerer, elem), loc }),
    type,
    loc,
  };
}

/** Store a stabilized value without changing the array's element ABI. */
export function arrayValueStore(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  value: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrStmt {
  if (typeEquals(value.type, elem)) return { kind: "arraySet", arr, index, value, loc };
  // An undefined value of a `(T | undefined)[]` (primitiveElement).
  if (value.type.kind === "undefinedT" && primitiveElement(elem)) {
    const write: IrStmt = { kind: "arraySetUndefined", arr, index, loc };
    if (value.kind === "unitLit") return write;
    return { kind: "block", body: [{ kind: "exprStmt", expr: value, loc }, write], loc };
  }
  if (value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0) {
    // The tag test and the VALUE arm extraction both consume the value. Keep
    // an arbitrary expression (especially an array read or call) single
    // evaluated before branching; this also gives the native emitters one
    // owned union temporary to release on every path.
    const unionId = value.type.unionId;
    let stable = value;
    const prefix: IrStmt[] = [];
    // The stores below evaluate the receiver and the index after the value.
    // JavaScript evaluates them first (`out[n++] = src[n]` reads src[1]), so
    // either may need its value held before the value runs.
    if (value.kind !== "varRef") {
      const valueFx = valueEffects(lowerer, value);
      const hold = (e: IrExpr, name: string, effects: typeof valueFx): IrExpr => {
        if (unaffectedBy(e, effects) && !(effects.opaque && readsMutableLocal(lowerer, e)))
          return e;
        const temp = lowerer.declareHiddenLocal(name, e.type);
        prefix.push({ kind: "varDecl", localId: temp.id, init: e, loc });
        return varRef(temp.id, temp.type, loc);
      };
      // The receiver runs before the index and the value, so the index's
      // effects can change it too (`a[(a = b, 0)] = c[0]!`).
      const indexFx = valueEffects(lowerer, index);
      arr = hold(arr, "%arrayTarget", {
        writes: new Set([...valueFx.writes, ...indexFx.writes]),
        opaque: valueFx.opaque || indexFx.opaque,
      });
      index = hold(index, "%arrayIndex", valueFx);
    }
    if (value.kind !== "varRef") {
      const temp = lowerer.declareHiddenLocal("%arrayValue", value.type);
      prefix.push({ kind: "varDecl", localId: temp.id, init: value, loc });
      stable = varRef(temp.id, temp.type, loc);
    }
    const write: IrStmt = {
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId,
        tag: lowerer.armTag(unionId, UNDEFINED_T),
        negated: false,
        value: stable,
        type: BOOL,
        loc,
      },
      then: [{ kind: "arraySetUndefined", arr, index, loc }],
      else_: [{ kind: "arraySet", arr, index, value: lowerer.coerceToExpected(stable, elem), loc }],
      loc,
    };
    if (prefix.length > 0) return { kind: "block", body: [...prefix, write], loc };
    return write;
  }
  return { kind: "arraySet", arr, index, value: lowerer.coerceToExpected(value, elem), loc };
}

/** An ordinary indexed read: values retain their element type, while
 * holes, missing properties, and present undefined yield undefined. */
export function lowerSafeIndexRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (arr.type.kind !== "array") throw new InternalCompilerError("indexed read requires an array");
  const elem = arr.type.elem;
  if (elem.kind === "void") return null;
  const resultT = arrayValueType(lowerer, elem);
  // An element union that cannot take an undefined arm has no value for a
  // missing element.
  if (resultT.kind !== "dyn" && lowerer.wrappedUndefined(resultT, loc) === null) return null;
  const key = `idxOr:${typeKey(elem)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    const at = helperLoc(loc);
    name = keyedHelperName(lowerer, "%arr.idxOr", key);
    lowerer.arrHofHelpers.set(key, name);
    const arrT = arr.type;
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "i.0", name: "i", type: F64 },
      ],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: arrayValueRead(lowerer, varRef("a.0", arrT, at), varRef("i.0", F64, at), elem, at),
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [arr, index], type: resultT, loc };
}

/** An ordinary typed-array element read `t[i]`: like Node, an index that
 * is not an integer in [0, length) answers undefined (the storage is
 * never touched out of bounds). The result is `number | undefined`, the
 * same optional shape ordinary array reads carry; numeric consumers fuse
 * back to the plain element read (tryLowerNumericIndexRead), where the
 * invalid case reads as NaN — exactly ToNumber(undefined). */
export function lowerSafeBytesRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const bytesT = receiver.type;
  if (bytesT.kind !== "bytes") throw new InternalCompilerError("typed read requires bytes");
  const resultT = lowerer.withUndefinedArm(F64);
  const key = `bytesIdxOr:${typeKey(bytesT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    const at = helperLoc(loc);
    name = keyedHelperName(lowerer, "%bytes.idxOr", key);
    lowerer.arrHofHelpers.set(key, name);
    const b = varRef("b.0", bytesT, at);
    const i = varRef("i.0", F64, at);
    const cmp = (op: "<" | ">=" | "===", left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "bin",
      op,
      left,
      right,
      type: BOOL,
      loc: at,
    });
    const inRange: IrExpr = {
      kind: "logical",
      op: "&&",
      left: cmp(">=", i, { kind: "numLit", value: 0, type: F64, loc: at }),
      right: {
        kind: "logical",
        op: "&&",
        left: cmp("<", i, {
          kind: "bytesIntrinsic",
          method: "length",
          receiver: b,
          args: [],
          type: F64,
          loc: at,
        }),
        right: cmp("===", { kind: "libCall", fn: "math.trunc", args: [i], type: F64, loc: at }, i),
        type: BOOL,
        loc: at,
      },
      type: BOOL,
      loc: at,
    };
    const read: IrExpr = {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: b,
      args: [i],
      type: F64,
      loc: at,
    };
    if (isIntegerBytesElem(bytesT.elem)) {
      // An integer element is never NaN, so the NaN-for-invalid read
      // decides presence with one inline index check (no separate range
      // and integrality tests).
      const v = varRef("v.0", F64, at);
      lowerer.liftedFns.push({
        name,
        params: [
          { localId: "b.0", name: "b", type: bytesT },
          { localId: "i.0", name: "i", type: F64 },
        ],
        returnType: resultT,
        locals: [
          { id: "b.0", name: "b", type: bytesT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: false },
          { id: "v.0", name: "v", type: F64, mutable: false },
        ],
        body: [
          { kind: "varDecl", localId: "v.0", init: { ...read, invalidNaN: true }, loc: at },
          {
            kind: "return",
            value: {
              kind: "ternary",
              cond: { kind: "libCall", fn: "num.isNaN", args: [v], type: BOOL, loc: at },
              then: lowerer.wrappedUndefined(resultT, at)!,
              else_: lowerer.coerceToExpected(v, resultT),
              type: resultT,
              loc: at,
            },
            loc: at,
          },
        ],
        loc: at,
      });
      return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
    }
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "b.0", name: "b", type: bytesT },
        { localId: "i.0", name: "i", type: F64 },
      ],
      returnType: resultT,
      locals: [
        { id: "b.0", name: "b", type: bytesT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: inRange,
            then: lowerer.coerceToExpected(read, resultT),
            else_: lowerer.wrappedUndefined(resultT, at)!,
            type: resultT,
            loc: at,
          },
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
}

/** Whether `operand` is a call of the typed-array read helper. */
function isBytesReadHelperCall(lowerer: Lowerer, operand: IrExpr): boolean {
  if (operand.kind !== "call" || operand.args.length !== 2) return false;
  const receiver = operand.args[0]!;
  return (
    receiver.type.kind === "bytes" &&
    operand.args[1]!.type.kind === "f64" &&
    operand.callee === lowerer.arrHofHelpers.get(`bytesIdxOr:${typeKey(receiver.type)}`)
  );
}

/** Fuse only our own f64-array read helper with immediate ToNumber.
 * Reuse its arguments verbatim so the receiver and index still evaluate
 * exactly once, in order, before the read. Do not specialize user calls,
 * union-element arrays, or optional values stored in locals. */
export function tryLowerNumericIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (operand.kind === "call" && isBytesReadHelperCall(lowerer, operand)) {
    // The plain element read: an invalid index reads as NaN, which is
    // ToNumber(undefined).
    const [receiver, index] = operand.args;
    return {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: receiver!,
      args: [index!],
      type: F64,
      loc,
      invalidNaN: true,
    };
  }
  if (
    operand.kind !== "call" ||
    operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(F64)}`)
  )
    return null;
  // ToNumber of a foreign element differs from its own value under `+`,
  // comparisons and ToBoolean.
  if (elementMayBeForeign(lowerer, F64)) return null;
  const [arr, index] = operand.args;
  if (
    operand.args.length !== 2 ||
    arr?.type.kind !== "array" ||
    arr.type.elem.kind !== "f64" ||
    index?.type.kind !== "f64"
  )
    return null;
  // The intrinsic owns the evaluated receiver through index evaluation,
  // then borrows it for one slot lookup. No extra helper parameter or
  // separate state/getter expressions need to retain the array again.
  return {
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: arr,
    args: [index],
    type: F64,
    loc,
  };
}

/** Fuse our own typed-array read helper with strict equality against a
 * plain number: `t[i] === b` is false when `t[i]` is undefined, and the
 * NaN-for-invalid read is never equal to anything either, so the plain
 * read answers exactly (`!==` is the negation). The other operand must
 * lower to a double that never stands for undefined: a union keeps the
 * box (undefined === undefined is true), and so does a NaN-coded value
 * (nan-coded-reads.ts), which encodes undefined as NaN. The read keeps
 * its arguments, so evaluation order is unchanged. */
export function tryLowerBytesReadNumberEquality(
  lowerer: Lowerer,
  operand: IrExpr,
  other: IrExpr,
  otherNode: ts.Expression,
): IrExpr | null {
  if (other.type.kind !== "f64" || !isBytesReadHelperCall(lowerer, operand)) return null;
  if (lowerer.nanCodedReads?.mayStandForUndefined(otherNode) === true) return null;
  return tryLowerNumericIndexRead(lowerer, operand, operand.loc);
}

/** Fuse our own scalar-array read helper with an immediate ToBoolean, so a
 * condition such as `if (flags[i])` never boxes `T | undefined`. Numbers
 * reuse getNumber: a missing slot reads as NaN, which is falsy exactly like
 * undefined. Booleans test the slot state and then read the value; both
 * operands are evaluated twice, so they must be plain bindings/literals
 * (the same proof the indexed-comparison fusion uses). Returns a BOOL
 * expression with the original evaluation order, or null. */
export function tryLowerIndexTruthiness(
  lowerer: Lowerer,
  operand: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  if (isBytesReadHelperCall(lowerer, operand)) {
    // NaN (the invalid read) is falsy exactly like undefined.
    const number = tryLowerNumericIndexRead(lowerer, operand, loc);
    return number ? lowerer.ensureBool(number, node) : null;
  }
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind !== "f64" && elem.kind !== "bool") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  if (elem.kind === "f64") {
    const number = tryLowerNumericIndexRead(lowerer, operand, loc);
    return number ? lowerer.ensureBool(number, node) : null;
  }
  return tryFuseIndexRead(lowerer, operand, BOOL, (read) => read, {
    kind: "boolLit",
    value: false,
    type: BOOL,
    loc,
  });
}

/** Fuse our own non-union array read helper with its single consumer:
 * `present` receives the strict element read, `missing` answers holes,
 * present undefined, and absent indices. The receiver and index evaluate
 * once more than in the helper form, so both must be plain bindings or
 * numeric literals (nothing can run between the state test and the read). */
export function tryFuseIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  type: IrType,
  present: (read: IrExpr) => IrExpr,
  missing: IrExpr,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind === "union" || elem.kind === "void") return null;
  // A foreign element is neither the present value nor the missing one.
  if (elementMayBeForeign(lowerer, elem)) return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  if (arr.kind !== "varRef" || (index.kind !== "varRef" && index.kind !== "numLit")) return null;
  const loc = operand.loc;
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: present({ kind: "arrayGet", arr, index, type: elem, loc }),
    else_: missing,
    type,
    loc,
  };
}
