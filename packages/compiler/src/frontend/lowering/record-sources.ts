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
 * converts anything into one at all (a program without such a conversion
 * answers the test false everywhere, so its captures keep static copies). */
import type { IrExpr, IrFunction, IrType, SrcLoc } from "../../ir/ir.js";
import { BOOL, DYN, recordTextCodecClass, shapeHasAccessorSlots } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { varRef } from "../../ir/build.js";
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
 * answers, and the unions and records on the current path, by id. */
export interface KeepsSourceScan {
  memo: Map<string, boolean>;
  visiting: Set<string>;
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

/** Whether `fn` holds a validated conversion that can note a record source:
 * a `dynCheck` whose target accepts `recordMayKeepSource`. Only such a
 * conversion creates the kept view `recordSourceTest` answers, so a program
 * without one never needs a capture to consult the view. */
export function functionKeepsRecordSources(
  lowerer: Lowerer,
  fn: IrFunction,
  scan: KeepsSourceScan,
): boolean {
  return !everyStmtList(fn.body, {
    expr: (expr) =>
      expr.kind !== "dynCheck" || !conversionKeepsSource(lowerer, expr.type, scan).keeps,
    stmt: () => true,
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
