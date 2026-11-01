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
import type { IrExpr, IrFunction, IrLocal, IrType, SrcLoc } from "../../ir/ir.js";
import { BOOL, DYN, VOID, recordTextCodecClass, shapeHasAccessorSlots } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { replaceThroughParents } from "../../ir/replace-children.js";
import { varRef } from "../../ir/build.js";
import { keyedHelperName } from "./stable-names.js";
import { isSafeToRepeat } from "./expressions/evaluation-safety.js";
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
  declare: DeclareLocal = (name, type) => lowerer.declareHiddenLocal(name, type),
): IrExpr {
  const local = declare("%sourcedRecord", receiver.type);
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

/** `throughRecordSource` for a site that may be written after the pass
 * (deferSourceAnswer): a pure receiver is read again instead of being held
 * in a local, so the answer stays an ordinary expression the site keeps
 * inline and no local has to be declared there. A receiver that must be
 * evaluated once takes the ordinary form, with its local owned by `declare`. */
export function recordSourceAnswer(
  lowerer: Lowerer,
  receiver: IrExpr,
  loc: SrcLoc,
  staticAnswer: (record: IrExpr) => IrExpr,
  viewAnswer: (view: IrExpr, type: IrType) => IrExpr,
  declare: DeclareLocal,
): IrExpr {
  if (isSafeToRepeat(receiver)) {
    const plain = staticAnswer(receiver);
    const view: IrExpr = { kind: "dynFrom", value: receiver, liveRef: true, type: DYN, loc };
    return {
      kind: "ternary",
      cond: recordSourceTest(receiver, loc),
      then: viewAnswer(view, plain.type),
      else_: plain,
      type: plain.type,
      loc,
    };
  }
  return throughRecordSource(lowerer, receiver, loc, staticAnswer, viewAnswer, declare);
}

/** The own properties of `value`, in its own-key order, as an ordinary dyn
 * object: the mirror a record keeps as its source (noteRecordSource). */
export function dynMirrorOf(value: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "dyn.assign",
    args: [
      { kind: "dynObjLit", fields: [], type: DYN, loc },
      { kind: "dynFrom", value, liveRef: true, type: DYN, loc },
    ],
    type: DYN,
    loc,
  };
}

/** `record.sourceNote(built, mirror)`: `built` keeps the mirror's own
 * properties as its checked source (scr_record_source_note), so its
 * reflective surfaces — JSON serialization, inspect, Object.keys, `in` —
 * observe the keys it has no slot for, in the mirror's key order. The
 * mirror must be an ordinary dyn object (dynMirrorOf). */
export function noteRecordSource(built: IrExpr, mirror: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "record.sourceNote", args: [built, mirror], type: VOID, loc };
}

/** Declares a local of the function being built: `declareHiddenLocal`
 * while a unit lowers, the helper's own list when a deferred answer builds
 * its body after the pass (finalizePendingSourceAnswers). */
export type DeclareLocal = (name: string, type: IrType) => IrLocal;

/** A reflective `in` answer over a record that can keep a source, deferred
 * to the end of the pass. Lowering meets the question before the pass knows
 * whether the program keeps a source anywhere (the fact settles only after
 * every function body lowered, and a merge establishes it part-way through),
 * so the site keeps the static answer it built and records how to build the
 * source-aware one. The finalizer leaves the static answer in place when the
 * program keeps no source — such a program keeps the IR it had before — and
 * otherwise writes the source-aware answer into the site
 * (finalizePendingSourceAnswers). */
export interface PendingSourceAnswer {
  /** The site's static answer, replaced in place when the fact holds. */
  readonly node: IrExpr;
  /** The receiver the helper is called with; the static answer evaluated it
   * for its effects, so the call owns its single evaluation. */
  readonly recv: IrExpr;
  /** The question's identity: `keyedHelperName` turns it into a name that
   * depends only on it, so two sites asking the same question share a
   * helper. */
  readonly key: string;
  /** Builds the answer over a parameter ref, inside the helper's body. */
  readonly build: (recv: () => IrExpr, declare: DeclareLocal) => IrExpr;
}

/** Record a `in` answer that must be settled after the pass ends; returns
 * the static answer the site uses until then. */
export function deferSourceAnswer(
  lowerer: Lowerer,
  node: IrExpr,
  recv: IrExpr,
  key: string,
  build: (recv: () => IrExpr, declare: DeclareLocal) => IrExpr,
): IrExpr {
  lowerer.pendingSourceAnswers.push({ node, recv, key, build });
  return node;
}

/** Settle the deferred answers (deferSourceAnswer) once the pass knows
 * whether the program keeps a record source. A program that does not keeps
 * every site's static answer, unchanged. One that does gets the source-aware
 * answer written into the site; when the receiver is pure that answer is an
 * ordinary inline expression, and a receiver that must be evaluated once is
 * passed to a `%record.in.<hash>(v)` helper that owns the local holding it
 * (the caller has no function context left to declare one). */
export function finalizePendingSourceAnswers(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): void {
  const pending = lowerer.pendingSourceAnswers;
  const sites = [...pending];
  pending.length = 0;
  if (!lowerer.recordSourcesPossible) return;
  const built = new Set<string>();
  // Each answer replaces its site through the node that holds it
  // (replaceThroughParents). A site of a unit that lowered again is no
  // longer in any function, and its replacement finds no parent.
  const replacements = new Map<IrExpr, IrExpr>();
  for (const site of sites) {
    const loc = site.node.loc;
    // An answer that declares no local keeps its own receiver and is
    // written into the site as it is: the common case, and the one that
    // must cost a program nothing but the answer.
    const inlineLocals: IrLocal[] = [];
    const inlineDeclare: DeclareLocal = (name, type) => {
      const local: IrLocal = { id: `${name}.0`, name, type, mutable: false };
      inlineLocals.push(local);
      return local;
    };
    const inline = site.build(() => site.recv, inlineDeclare);
    if (inlineLocals.length === 0) {
      replacements.set(site.node, inline);
      continue;
    }
    const name = keyedHelperName(lowerer, "%record.in", site.key);
    if (!built.has(name)) {
      built.add(name);
      const param: IrLocal = { id: "v.0", name: "value", type: site.recv.type, mutable: false };
      const input = (): IrExpr => ({ kind: "varRef", localId: param.id, type: param.type, loc });
      const helperLocals: IrLocal[] = [];
      // The helper owns the locals the answer declares: no unit is lowering,
      // so `declareHiddenLocal` has no function context to attach them to.
      const counts = new Map<string, number>();
      const declare: DeclareLocal = (name, type) => {
        const count = counts.get(name) ?? 0;
        counts.set(name, count + 1);
        const local: IrLocal = { id: `${name}.${count}`, name, type, mutable: false };
        helperLocals.push(local);
        return local;
      };
      const outerSink = lowerer.localSink;
      lowerer.localSink = helperLocals;
      let answer: IrExpr;
      try {
        answer = site.build(input, declare);
      } finally {
        lowerer.localSink = outerSink;
      }
      lowerer.liftedFns.push({
        name,
        params: [{ localId: param.id, name: param.name, type: param.type }],
        returnType: BOOL,
        locals: [param, ...helperLocals],
        body: [{ kind: "return", value: answer, loc }],
        loc,
      });
    }
    replacements.set(site.node, { kind: "call", callee: name, args: [site.recv], type: BOOL, loc });
  }
  for (const fn of functions) replaceThroughParents(fn.body, replacements);
}
