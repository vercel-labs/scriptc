/* Undeclared properties of checked records.
 *
 * A checked conversion from an ordinary object into a closed declared-field
 * record (JSON.parse results, `any` values) stores only the declared fields
 * natively. When the source object carried other own properties, the
 * runtime keeps them beside the record (scr_record_source_note), and the
 * reflective surfaces that Node answers from the whole object — JSON
 * serialization, untyped views, inspect, Object.keys/values/entries —
 * answer through the record's live checked view instead of its static
 * field list. This module names the record types that can carry such a
 * source, the runtime test the surfaces branch on, and whether the program
 * can give any record one at all (functionKeepsRecordSources). A program
 * that cannot answers the test false everywhere, so its captures keep static
 * copies and its tests are removed with the branches they guard
 * (foldRecordSourceTests): typed code that enumerates a closed record then
 * holds no checked view of it. */
import type { IrExpr, IrFunction, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import {
  BOOL,
  DYN,
  RUNTIME_ERROR_CLASSES,
  recordTextCodecClass,
  shapeHasAccessorSlots,
  typeKey,
  STRING,
  canDynCheckTo,
} from "../../ir/ir.js";
import {
  everyExprChild,
  everyStmtChild,
  everyTypeChild,
  mapExprChildren,
  mapStmtChildren,
  everyStmtList,
} from "../../ir/traverse.js";
import { boolLit, varRef } from "../../ir/build.js";
import { ALWAYS_THROW_LIB_FNS } from "../../ir/builtin-effects.js";
import type { IrLibFn } from "../../ir/builtin-signatures.js";
import type { Lowerer } from "./lowerer.js";
import { isPerfEntryType } from "./builtins/performance.js";

/** Closed declared-field layouts with an ordinary data surface: the targets
 * the checked record builder notes sources for. */
export function recordMayKeepSource(lowerer: Lowerer, t: IrType & { kind: "record" }): boolean {
  const shape = lowerer.shapes.get(t.shapeId);
  return (
    shape !== undefined &&
    !shape.tuple &&
    shape.indexValue === undefined &&
    shape.fields.length > 0 &&
    !shapeHasAccessorSlots(shape) &&
    recordTextCodecClass(shape) === null &&
    !isPerfEntryType(lowerer, t) &&
    lowerer.dynConvertible(t)
  );
}

/** `record.sourceHas(value)`: whether this record kept undeclared source
 * properties. */
export function recordSourceTest(value: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "record.sourceHas", args: [value], type: BOOL, loc };
}

/** A union or record revisited while it is being visited answers as if its
 * cycle member were empty (`keeps: false`), so the caller's answer is
 * incomplete until the outer one settles. `cycled` marks that incompleteness: such an answer is
 * never memoized, because another entry point into the same cycle could reach
 * the missing arm. */
interface KeepsSourceAnswer {
  keeps: boolean;
  cycled: boolean;
}

/** Shared work list of the whole-program scan: settled union and record
 * answers, and the unions and records on the current path, by id; the
 * settled answers of exposesKeptRecord, by type key; and the source tests
 * the walk met. */
export interface KeepsSourceScan {
  memo: Map<string, boolean>;
  visiting: Set<string>;
  exposed?: Map<string, boolean>;
  tests?: number;
}

/** Whether a checked conversion into `target` can leave a record holding
 * undeclared source keys. The conversion reads one record at a time, so the
 * records nested in a union arm, a promise, an array, a record field or an
 * index signature's values count too (`Record<string, { x: string }>` keeps
 * the sources of its closed values). Unions and records are memoized by id;
 * one revisited on the current path answers `cycled`. */
function conversionKeepsSource(
  lowerer: Lowerer,
  target: IrType,
  scan: KeepsSourceScan,
): KeepsSourceAnswer {
  if (target.kind === "promise") return conversionKeepsSource(lowerer, target.inner, scan);
  if (target.kind === "array") return conversionKeepsSource(lowerer, target.elem, scan);
  if (target.kind === "record" && recordMayKeepSource(lowerer, target))
    return { keeps: true, cycled: false };
  let id: string;
  let members: IrType[];
  if (target.kind === "union") {
    id = target.unionId;
    members = lowerer.unions.get(target.unionId)?.arms ?? [];
  } else if (target.kind === "record") {
    id = target.shapeId;
    const shape = lowerer.shapes.get(target.shapeId);
    members = [
      ...(shape?.fields.map((field) => field.type) ?? []),
      ...(shape?.indexValue !== undefined ? [shape.indexValue] : []),
    ];
  } else return { keeps: false, cycled: false };
  const known = scan.memo.get(id);
  if (known !== undefined) return { keeps: known, cycled: false };
  if (scan.visiting.has(id)) return { keeps: false, cycled: true };
  scan.visiting.add(id);
  let keeps = false;
  let cycled = false;
  for (const member of members) {
    const answer = conversionKeepsSource(lowerer, member, scan);
    keeps = keeps || answer.keeps;
    cycled = cycled || answer.cycled;
    if (keeps) break;
  }
  scan.visiting.delete(id);
  if (!cycled || keeps) scan.memo.set(id, keeps);
  return { keeps, cycled: cycled && !keeps };
}

/** Whether a value of type `t` that untyped code or the runtime library
 * holds by reference, or hands back, can be a record with a source or lead
 * to one. Untyped code writes into what it holds: it calls a function with
 * an object of its own, stores one in a field, an element or a map entry, or
 * settles a promise with one; the library hands a callback the values it
 * read from a stream, a message or a response. Each of those writes converts
 * the object into the declared type as a checked conversion does, in a
 * helper the backend emits with the box or the call, so no `dynCheck` names
 * it. The answer is therefore whether a record type that can keep a source
 * is reachable from `t` at all. A class instance, a class value and a module
 * namespace answer true without a walk of their members: untyped code
 * reaches their methods' parameters, their fields and their subclasses. The
 * builtin error classes hold no record. */
function exposesKeptRecord(lowerer: Lowerer, t: IrType, scan: KeepsSourceScan): boolean {
  switch (t.kind) {
    case "record":
    case "union":
    case "array":
    case "set":
    case "map":
    case "promise":
    case "func":
    case "generator":
      break;
    case "object":
      return !RUNTIME_ERROR_CLASSES.has(t.className);
    case "classval":
    case "moduleNs":
      return true;
    default:
      // Numbers, strings and the other kinds that name no further type.
      return false;
  }
  const exposed = (scan.exposed ??= new Map<string, boolean>());
  const root = typeKey(t);
  const known = exposed.get(root);
  if (known !== undefined) return known;
  // One walk of the types reachable from `t`. A false answer holds for every
  // record and union the walk saw; a true one is recorded for `t` only.
  const seen = new Set<string>();
  const reaches = (type: IrType): boolean => {
    switch (type.kind) {
      case "object":
        return !RUNTIME_ERROR_CLASSES.has(type.className);
      case "classval":
      case "moduleNs":
        return true;
      case "record": {
        if (recordMayKeepSource(lowerer, type)) return true;
        const key = typeKey(type);
        if (seen.has(key)) return false;
        seen.add(key);
        const shape = lowerer.shapes.get(type.shapeId);
        if (shape === undefined) return false;
        if (shape.indexValue !== undefined && reaches(shape.indexValue)) return true;
        return shape.fields.some((field) => reaches(field.type));
      }
      case "union": {
        const key = typeKey(type);
        if (seen.has(key)) return false;
        seen.add(key);
        return (lowerer.unions.get(type.unionId)?.arms ?? []).some(reaches);
      }
      default:
        // Arrays, sets, maps, promises, functions and generators hold the
        // types they name; every other kind holds none.
        return !everyTypeChild(type, (child) => !reaches(child));
    }
  };
  const answer = reaches(t);
  if (!answer) for (const key of seen) exposed.set(key, false);
  exposed.set(root, answer);
  return answer;
}

/** A value whose type says nothing about what it holds: an untyped value,
 * or a caught one, which wraps an untyped value. */
function isUntyped(t: IrType): boolean {
  return t.kind === "dyn" || t.kind === "jsval" || t.kind === "caught";
}

/** `record.sourceHas(local)`: a test the fold can remove without losing an
 * evaluation. */
function isLocalSourceTest(expr: IrExpr): boolean {
  return (
    expr.kind === "libCall" && expr.fn === "record.sourceHas" && expr.args[0]?.kind === "varRef"
  );
}

/** Whether `cond` holds only for a record that kept a source: the test, or
 * a conjunction with it. */
function impliesRecordSource(cond: IrExpr): boolean {
  return (
    isLocalSourceTest(cond) ||
    (cond.kind === "logical" &&
      cond.op === "&&" &&
      (impliesRecordSource(cond.left) || impliesRecordSource(cond.right)))
  );
}

/** The library calls that give a record a source of their own accord: the
 * copies and width spreads the key-order pass keeps, a composed link, and a
 * delete of an undeclared key. */
const SOURCE_KEEPING_CALL = /^record\.source(?!Has$)/;

/** Whether `fn` can give a record a source. A record gets one where an
 * untyped value becomes a typed one, and nowhere else:
 *
 *  - a node in which an untyped value and a typed one meet, when a record
 *    type that keeps a source is reachable from the typed one
 *    (exposesKeptRecord). The node's own value counts as well as its
 *    operands, so this is a checked conversion (`dynCheck`: untyped in, typed
 *    out), a box (`dynFrom`, a keyed read: typed in, untyped out, and what
 *    is written through the box is converted back), a keyed write and a call
 *    that takes both;
 *  - a library call that hands back such a value or calls back with one: it
 *    was read from a stream, a message or a response;
 *  - a thrown value, which its handler holds untyped;
 *  - a library call that keeps a source itself (SOURCE_KEEPING_CALL).
 *
 * The code a source test guards does not count: it runs only for a record
 * that already has a source, so the first source of a run is not made
 * there. The reflective surfaces box their record inside such a branch
 * (throughRecordSource); without this rule every program that enumerates a
 * closed record would answer for itself that it keeps sources. A function
 * that a guarded branch calls is scanned as any other.
 *
 * The backend holds the other end of this answer: it knows each conversion
 * it emits, and stops when it emits one that keeps a source for a record
 * type whose tests were removed (IrModule.recordSourcesFolded). */
export function functionKeepsRecordSources(
  lowerer: Lowerer,
  fn: IrFunction,
  scan: KeepsSourceScan,
): boolean {
  const exposes = (t: IrType): boolean => exposesKeptRecord(lowerer, t, scan);
  // Whether an operand of the node being walked is untyped: each expression
  // says so to the node that holds it, as the one walk passes. Only a node
  // with an untyped side is then asked for a typed side that exposes a
  // record, so typed code pays the walk and nothing else.
  let untypedOperand = false;
  let exposed = false;
  const exposedOperand = (child: IrExpr): boolean => !(exposed = exposes(child.type));
  const nested = (): boolean => true;
  // Both visitors answer false at the first keeping node, which ends the walk.
  const expr = (e: IrExpr): boolean => {
    const untyped = isUntyped(e.type);
    if (untyped) untypedOperand = true;
    let guarded = false;
    switch (e.kind) {
      case "varRef":
      case "numLit":
      case "strLit":
      case "boolLit":
        return true;
      case "libCall":
        if (e.fn === "record.sourceHas") {
          scan.tests = (scan.tests ?? 0) + 1;
          break;
        }
        if (SOURCE_KEEPING_CALL.test(e.fn)) return false;
        // The compiler's own record operations read typed records only.
        if (e.fn.startsWith("record.")) break;
        for (const arg of e.args) if (arg.type.kind === "func" && exposes(arg.type)) return false;
        // An always-throwing call stands in for a value of the type its
        // node carries, and never hands one back.
        if (ALWAYS_THROW_LIB_FNS.has(e.fn as IrLibFn)) break;
        if (exposes(e.type)) return false;
        break;
      case "ternary":
        guarded = impliesRecordSource(e.cond);
        break;
      case "logical":
        guarded = e.op === "&&" && impliesRecordSource(e.left);
        break;
      default:
        break;
    }
    const holder = untypedOperand;
    untypedOperand = false;
    // Of a guarded node, the test and what runs without it.
    const walked = !guarded
      ? everyExprChild(e, expr, stmt)
      : e.kind === "ternary"
        ? expr(e.cond) && expr(e.else_)
        : e.kind === "logical" && expr(e.left);
    const meets = untyped || untypedOperand;
    untypedOperand = holder;
    if (!walked) return false;
    if (guarded || !meets) return true;
    exposed = exposes(e.type);
    if (!exposed) everyExprChild(e, exposedOperand, nested);
    return !exposed;
  };
  const stmt = (s: IrStmt): boolean => {
    const guarded = s.kind === "if" && impliesRecordSource(s.cond);
    const holder = untypedOperand;
    untypedOperand = false;
    const walked =
      s.kind === "if" && guarded
        ? expr(s.cond) && (s.else_ === null || s.else_.every(stmt))
        : everyStmtChild(s, expr, stmt);
    const meets = untypedOperand;
    untypedOperand = holder;
    if (!walked) return false;
    if (s.kind === "throw" && exposes(s.value.type)) return false;
    if (guarded || !meets) return true;
    exposed = false;
    everyStmtChild(s, exposedOperand, nested);
    return !exposed;
  };
  return !fn.body.every(stmt);
}

/** Whether `fn` holds a checked conversion into a record type that keeps a
 * source, anywhere in its body. */
function functionConvertsIntoKeptRecords(
  lowerer: Lowerer,
  fn: IrFunction,
  scan: KeepsSourceScan,
): boolean {
  const expr = (e: IrExpr): boolean =>
    !(e.kind === "dynCheck" && conversionKeepsSource(lowerer, e.type, scan).keeps) &&
    everyExprChild(e, expr, stmt);
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  return !fn.body.every(stmt);
}

/** Lowerer.recordSourcesPossible as the lowered bodies settle it, for the
 * passes that run before the module is final (the key-order pass, the copy
 * helpers' kept-source tails): whether a function converts an untyped value
 * into a record type that keeps a source, unless every such conversion sits
 * behind a source test and nothing else in the program makes a source
 * (functionKeepsRecordSources). Those passes keep keys only for the record
 * types the written conversions build, so the boxes and library calls
 * functionKeepsRecordSources also counts do not make this answer true:
 * they only keep it from being withdrawn. */
export function programKeepsRecordSources(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): boolean {
  const scan: KeepsSourceScan = { memo: new Map(), visiting: new Set() };
  return (
    functions.some((fn) => functionConvertsIntoKeptRecords(lowerer, fn, scan)) &&
    functions.some((fn) => functionKeepsRecordSources(lowerer, fn, scan))
  );
}

/** Removes the source tests of a program none of whose functions can give
 * a record a source (functionKeepsRecordSources): each `record.sourceHas`
 * of a local is false, so the branch it guards goes with it, and with the
 * branch the checked view of the record and every helper only that view
 * needs. Answers the record types whose tests it removed, sorted by shape
 * id, or null when it removed none: a program that keeps sources, or has no
 * test, is left as it is. */
export function foldRecordSourceTests(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): string[] | null {
  const scan: KeepsSourceScan = { memo: new Map(), visiting: new Set(), tests: 0 };
  for (const fn of functions) if (functionKeepsRecordSources(lowerer, fn, scan)) return null;
  if (scan.tests === 0) return null;
  const folded = new Set<string>();
  // The `false` each removed test became. Only these decide a branch: a
  // constant condition the program wrote stays as it is.
  const answers = new Set<IrExpr>();
  const isFalse = (e: IrExpr): boolean => answers.has(e);
  // The empty blocks that stand for a removed `if` until its list is rebuilt.
  const removed = new Set<IrStmt>();
  const live = (list: IrStmt[]): IrStmt[] => list.filter((s) => !removed.has(s));
  const expr = (e: IrExpr): IrExpr => {
    if (isLocalSourceTest(e) && e.kind === "libCall") {
      const tested = e.args[0]!.type;
      if (tested.kind === "record") folded.add(tested.shapeId);
      const answer = boolLit(false, e.loc);
      answers.add(answer);
      return answer;
    }
    const mapped = mapExprChildren(e, expr, stmt);
    switch (mapped.kind) {
      case "ternary":
        return isFalse(mapped.cond) ? mapped.else_ : mapped;
      case "logical":
        if (!isFalse(mapped.left)) return mapped;
        return mapped.op === "&&" ? mapped.left : mapped.right;
      case "seqExpr":
        return { ...mapped, stmts: live(mapped.stmts) };
      default:
        return mapped;
    }
  };
  const stmt = (s: IrStmt): IrStmt => {
    const mapped = mapStmtChildren(s, expr, stmt);
    switch (mapped.kind) {
      case "if": {
        if (!isFalse(mapped.cond))
          return {
            ...mapped,
            then: live(mapped.then),
            else_: mapped.else_ === null ? null : live(mapped.else_),
          };
        const rest: IrStmt = { kind: "block", body: live(mapped.else_ ?? []), loc: mapped.loc };
        if (rest.body.length === 0) removed.add(rest);
        return rest;
      }
      case "block":
        return { ...mapped, body: live(mapped.body) };
      default:
        return mapped;
    }
  };
  const tests = (e: IrExpr): boolean => !isLocalSourceTest(e) && everyExprChild(e, tests, inStmt);
  const inStmt = (s: IrStmt): boolean => everyStmtChild(s, tests, inStmt);
  for (const fn of functions) {
    if (fn.body.every(inStmt)) continue;
    fn.body = live(fn.body.map(stmt));
  }
  return folded.size === 0 ? null : [...folded].sort();
}

/** A target field of a width copy that the record source does not declare:
 * Node keeps the source object through the conversion, so the field may
 * hold a kept key. */
export interface AbsentSourceField {
  name: string;
  type: IrType;
}

/** The record literal a width projection builds: the first literal of the
 * projection's return type, after the key-order and link passes have
 * settled its fields. */
function projectionRecordLit(projection: IrFunction): (IrExpr & { kind: "recordLit" }) | null {
  const target = projection.returnType;
  if (target.kind !== "record") return null;
  let found: (IrExpr & { kind: "recordLit" }) | null = null;
  everyStmtList(projection.body, {
    stmt: () => found === null,
    expr: (expr) => {
      if (found !== null) return false;
      if (
        expr.kind === "recordLit" &&
        expr.type.kind === "record" &&
        expr.type.shapeId === target.shapeId
      ) {
        found = expr;
        return false;
      }
      return true;
    },
  });
  return found;
}

/** `record.sourceHasKey(r, name) ? <name read from r's kept source, typed
 * `field.type`> : absent`. The presence test is per key: a record that keeps
 * an unrelated extra key must still answer this field as absent, exactly as
 * the erased assertion leaves a key the source never held. */
function absentFieldFromSource(
  field: AbsentSourceField,
  receiver: IrExpr,
  absent: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const member: IrExpr = {
    kind: "libCall",
    fn: "record.sourceGet",
    args: [receiver, { kind: "strLit", value: field.name, type: STRING, loc }],
    type: DYN,
    loc,
  };
  const present: IrExpr = {
    kind: "libCall",
    fn: "record.sourceHasKey",
    args: [receiver, { kind: "strLit", value: field.name, type: STRING, loc }],
    type: BOOL,
    loc,
  };
  return {
    kind: "ternary",
    cond: present,
    then:
      field.type.kind === "dyn"
        ? member
        : { kind: "dynCheck", value: member, type: field.type, loc },
    else_: absent,
    type: field.type,
    loc,
  };
}

/** Carries an undeclared kept key through a record→record conversion: a
 * target field the source type does not declare reads the source record's
 * kept source when the record has one (Node keeps the whole object through
 * the assertion), and answers its absent state otherwise. The read is the
 * record-source runtime's own-key read (record.sourceGet), so the copy
 * answers the key without building the record's capsule.
 *
 * Only a program that converts a value with a kept source into the source
 * type can take the read, so the rewrite waits for finalizeRecordLinks'
 * scan: `sourced` names those types, and a program without one keeps the
 * projection — and its IR — exactly as it was. Fields outside the dynCheck
 * domain keep their absent value rather than emit an invalid check. */
export function carryAbsentFieldsFromSource(
  lowerer: Lowerer,
  projection: IrFunction,
  source: IrType & { kind: "record" },
  fields: readonly AbsentSourceField[],
  loc: SrcLoc,
): void {
  if (fields.length === 0 || !recordMayKeepSource(lowerer, source)) return;
  lowerer.linkedHelperFinalizers.push((sourced) => {
    if (!sourced.has(source.shapeId)) return;
    const checkable = fields.filter(
      (field) =>
        field.type.kind === "dyn" ||
        canDynCheckTo(
          field.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        ),
    );
    if (checkable.length === 0) return;
    const literal = projectionRecordLit(projection);
    if (literal === null) return;
    const param = projection.params[0];
    if (param === undefined) return;
    const receiver = varRef(param.localId, source, loc);
    for (const field of checkable) {
      const slot = literal.fields.find((entry) => entry.name === field.name);
      if (slot === undefined) continue;
      slot.value = absentFieldFromSource(field, receiver, slot.value, loc);
    }
  });
}

/** A reflective answer over a record value that branches on its kept
 * source: `staticAnswer` walks the declared fields, `viewAnswer` answers
 * from the live checked view (typed `type`, the static answer's type). The
 * receiver evaluates once. */
export function throughRecordSource(
  lowerer: Lowerer,
  receiver: IrExpr,
  loc: SrcLoc,
  staticAnswer: (record: IrExpr) => IrExpr,
  viewAnswer: (view: IrExpr, type: IrType) => IrExpr,
): IrExpr {
  const local = lowerer.declareHiddenLocal("%sourcedRecord", receiver.type);
  const record = (): IrExpr => varRef(local.id, receiver.type, loc);
  const plain = staticAnswer(record());
  const view: IrExpr = { kind: "dynFrom", value: record(), liveRef: true, type: DYN, loc };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
    result: {
      kind: "ternary",
      cond: recordSourceTest(record(), loc),
      then: viewAnswer(view, plain.type),
      else_: plain,
      type: plain.type,
      loc,
    },
    type: plain.type,
    loc,
  };
}
