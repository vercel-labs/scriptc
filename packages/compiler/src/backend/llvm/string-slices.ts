import {
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrStrIntrinsicMethod,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { F64_INF, f64Lit, sizeToDouble } from "./common.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitStringAsciiFlag, emitStringByteLength } from "./string-reads.js";

type Slice = IrExpr & { kind: "strIntrinsic" };

function isSlice(value: IrExpr): value is Slice {
  return (
    value.kind === "strIntrinsic" && (value.method === "slice" || value.method === "substring")
  );
}

/** A local used exclusively for scalar indexing needs no copied bytes.
 * Snapshot the receiver and normalized bounds at its initializer, including
 * side effects in the bounds. Escapes, captures, writes, suspension, and all
 * other string consumers keep the ordinary materialized representation. */
export function findScalarStringSlices(
  fn: IrFunction,
  lifetimes: CallLifetimes,
): Map<string, Slice> {
  const slices = new Map<string, Slice>();
  if (fn.async || fn.generator) return slices;
  const bindings = lifetimes.bindings.get(fn.name);
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        bindings?.has(stmt.localId) &&
        stmt.init?.kind === "strIntrinsic" &&
        (stmt.init.method === "slice" || stmt.init.method === "substring")
      )
        slices.set(stmt.localId, stmt.init);
      return true;
    },
  });
  if (slices.size === 0) return slices;
  const invalid = new Set<string>();
  function expr(value: IrExpr): boolean {
    if (
      value.kind === "strIntrinsic" &&
      (value.method === "length" || value.method === "charCodeAt") &&
      value.receiver.kind === "varRef" &&
      slices.has(value.receiver.localId)
    ) {
      value.args.forEach(expr);
      return true;
    }
    if (value.kind === "varRef" && slices.has(value.localId)) invalid.add(value.localId);
    if (value.kind === "closure" || value.kind === "classRef")
      for (const id of value.captures ?? []) invalid.add(id);
    return everyExprChild(value, expr, stmt);
  }
  function stmt(value: IrStmt): boolean {
    return everyStmtChild(value, expr, stmt);
  }
  fn.body.forEach(stmt);
  for (const id of invalid) slices.delete(id);
  return slices;
}

/** scr_slice_unit: a slice()/substring() bound `v` over `length` units. A
 * non-negative bound clamps to the length; a negative one counts from the
 * end for slice (truncated toward zero) and is 0 for substring, as is NaN. */
function emitSliceUnit(
  host: LlvmEmitterContext,
  v: string,
  length: string,
  substring: boolean,
): string {
  const B = host.B;
  const size = host.sizeType;
  const lengthNumber = B.tmp(),
    nonNegative = B.tmp(),
    past = B.tmp(),
    whole = B.tmp(),
    clamped = B.tmp(),
    result = B.tmp();
  B.line(`${lengthNumber} = ${sizeToDouble(size)} ${size} ${length} to double`);
  B.line(`${nonNegative} = fcmp oge double ${v}, 0.0`);
  B.line(`${past} = fcmp oge double ${v}, ${lengthNumber}`);
  // Frozen: the conversion is only used where the bound is in range.
  const raw = B.tmp();
  B.line(`${raw} = fptosi double ${v} to i64`);
  B.line(`${whole} = freeze i64 ${raw}`);
  let unit = whole;
  if (size !== "i64") {
    unit = B.tmp();
    B.line(`${unit} = trunc i64 ${whole} to ${size}`);
  }
  B.line(`${clamped} = select i1 ${past}, ${size} ${length}, ${size} ${unit}`);
  if (substring) {
    B.line(`${result} = select i1 ${nonNegative}, ${size} ${clamped}, ${size} 0`);
    return result;
  }
  // Negative: (-length, -1] counts back from the end; (-1, 0) truncates to
  // 0, and at or below -length, and NaN, give 0.
  const negLength = B.tmp(),
    inside = B.tmp(),
    zero = B.tmp(),
    back = B.tmp(),
    counted = B.tmp(),
    negative = B.tmp();
  B.line(`${negLength} = fneg double ${lengthNumber}`);
  B.line(`${inside} = fcmp ogt double ${v}, ${negLength}`);
  B.line(`${zero} = icmp eq ${size} ${unit}, 0`);
  B.line(`${back} = add ${size} ${length}, ${unit}`);
  B.line(`${counted} = select i1 ${zero}, ${size} 0, ${size} ${back}`);
  B.line(`${negative} = select i1 ${inside}, ${size} ${counted}, ${size} 0`);
  B.line(`${result} = select i1 ${nonNegative}, ${size} ${clamped}, ${size} ${negative}`);
  return result;
}

export interface StringSliceSnapshot {
  source: string;
  range: string;
}

/** Own the original string for the complete local scope. A later append
 * cannot mutate it in place, even when the original binding was unique. */
export function emitStringSliceSnapshot(
  host: LlvmEmitterContext,
  slice: Slice,
): StringSliceSnapshot {
  const B = host.B;
  const source = host.emitExpr(slice.receiver);
  const args = slice.args.map((arg) => host.emitExpr(arg));
  const sourceSlot = B.slot(),
    range = B.slot();
  B.entryAllocas.push(
    `${sourceSlot} = alloca ptr`,
    `${range} = alloca { ${host.sizeType}, ${host.sizeType}, i32 }`,
  );
  B.line(`store ptr ${source.name}, ptr ${sourceSlot}`);
  const start = args[0]?.name ?? f64Lit(0),
    end = args[1]?.name ?? F64_INF;
  const substring = slice.method === "substring";
  // A proven-ASCII receiver's units are its bytes, so the range is the
  // runtime's clamped bounds over its byte length, and no boundary splits a
  // surrogate pair (scr_str_slice_range); other strings ask the runtime.
  const ascii = B.newLabel("slice.range.ascii"),
    runtime = B.newLabel("slice.range.runtime"),
    done = B.newLabel("slice.range.done");
  B.condBr(emitStringAsciiFlag(host, source.name), ascii, runtime);
  B.startBlock(ascii);
  const size = host.sizeType;
  const length = emitStringByteLength(host, source.name);
  let from = emitSliceUnit(host, start, length, substring),
    to = emitSliceUnit(host, end, length, substring);
  if (substring) {
    const swap = B.tmp(),
      low = B.tmp(),
      high = B.tmp();
    B.line(`${swap} = icmp ugt ${size} ${from}, ${to}`);
    B.line(`${low} = select i1 ${swap}, ${size} ${to}, ${size} ${from}`);
    B.line(`${high} = select i1 ${swap}, ${size} ${from}, ${size} ${to}`);
    from = low;
    to = high;
  }
  const nonEmpty = B.tmp(),
    difference = B.tmp(),
    units = B.tmp(),
    startPtr = B.tmp(),
    lengthPtr = B.tmp(),
    splitPtr = B.tmp();
  B.line(`${nonEmpty} = icmp ugt ${size} ${to}, ${from}`);
  B.line(`${difference} = sub ${size} ${to}, ${from}`);
  B.line(`${units} = select i1 ${nonEmpty}, ${size} ${difference}, ${size} 0`);
  const rangeType = `{ ${size}, ${size}, i32 }`;
  B.line(`${startPtr} = getelementptr inbounds ${rangeType}, ptr ${range}, i32 0, i32 0`);
  B.line(`store ${size} ${from}, ptr ${startPtr}`);
  B.line(`${lengthPtr} = getelementptr inbounds ${rangeType}, ptr ${range}, i32 0, i32 1`);
  B.line(`store ${size} ${units}, ptr ${lengthPtr}`);
  B.line(`${splitPtr} = getelementptr inbounds ${rangeType}, ptr ${range}, i32 0, i32 2`);
  B.line(`store i32 0, ptr ${splitPtr}`);
  B.br(done);
  B.startBlock(runtime);
  host.declare("declare void @scr_str_slice_range(ptr, double, double, i1 zeroext, ptr)");
  B.line(
    `call void @scr_str_slice_range(ptr ${source.name}, double ${start}, double ${end}, i1 ${substring ? "true" : "false"}, ptr ${range})`,
  );
  B.br(done);
  B.startBlock(done);
  host.toFrame(source);
  return { source: sourceSlot, range };
}

export function emitStringSliceRead(host: LlvmEmitterContext, value: Slice): LlValue | null {
  if (value.receiver.kind !== "varRef") return null;
  const snapshot = host.stringSlices.get(value.receiver.localId);
  if (!snapshot) return null;
  const B = host.B;
  if (value.method === "length") {
    const pointer = B.tmp(),
      length = B.tmp(),
      number = B.tmp();
    B.line(
      `${pointer} = getelementptr inbounds { ${host.sizeType}, ${host.sizeType}, i32 }, ptr ${snapshot.range}, i32 0, i32 1`,
    );
    B.line(`${length} = load ${host.sizeType}, ptr ${pointer}`);
    B.line(`${number} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${length} to double`);
    return { name: number, type: value.type };
  }
  if (value.method !== "charCodeAt") return null;
  const index = value.args[0] ? host.emitExpr(value.args[0]) : { name: f64Lit(0) };
  const source = B.tmp(),
    result = B.tmp();
  B.line(`${source} = load ptr, ptr ${snapshot.source}`);
  host.declare("declare double @scr_str_slice_char_code_at(ptr, ptr, double)");
  B.line(
    `${result} = call double @scr_str_slice_char_code_at(ptr ${source}, ptr ${snapshot.range}, double ${index.name})`,
  );
  return { name: result, type: value.type };
}

/** Bytes of the stack buffer behind one scratch slice, header included. */
export const SCRATCH_SLICE_BYTES = 96;

/** String methods that read a lent receiver or argument only during their
 * runtime call and never return it. Methods returning a string can return
 * their unchanged receiver, so they stay on the owned path. */
const LENDING_METHODS: ReadonlySet<IrStrIntrinsicMethod> = new Set([
  "length",
  "charCodeAt",
  "indexOf",
  "includes",
  "startsWith",
  "endsWith",
]);

/** Numeric parsers read their text during the call. */
const LENDING_LIB_FNS: ReadonlySet<string> = new Set([
  "num.fromString",
  "num.parseInt",
  "num.parseFloat",
]);

/** Searches of string arrays compare the needle with the elements during
 * the call. */
const LENDING_ARRAY_SEARCHES: ReadonlySet<string> = new Set(["includes", "indexOf", "lastIndexOf"]);

/** Typed string-keyed collection operations: reads probe with the key, and
 * an insertion stores scr_str_scratch_keep's copy (scr_map_append). */
const LENDING_KEY_METHODS: ReadonlySet<string> = new Set(["get", "has", "set", "add", "delete"]);

function stringKeyed(value: IrExpr & { kind: "mapIntrinsic" | "setIntrinsic" }): boolean {
  const receiver = value.receiver.type;
  if (receiver.kind === "map")
    return receiver.key.kind === "string" && receiver.value.kind !== "dyn";
  if (receiver.kind === "set") return receiver.elem.kind === "string";
  return false;
}

/** String parameters, by function and index, that the body reads only in
 * lending positions (findLentStringParameters). */
export type LentStringParameters = ReadonlyMap<string, ReadonlySet<number>>;

/** The operands `value` reads only while it runs, keeping no reference. */
function lentOperands(value: IrExpr, parameters: LentStringParameters): readonly IrExpr[] {
  switch (value.kind) {
    case "strEq":
    case "strCmp":
      return [value.left, value.right];
    case "strIntrinsic":
      return LENDING_METHODS.has(value.method) ? [value.receiver, ...value.args] : [];
    case "libCall":
      return LENDING_LIB_FNS.has(value.fn) ? value.args.slice(0, 1) : [];
    case "mapIntrinsic":
    case "setIntrinsic":
      return LENDING_KEY_METHODS.has(value.method) && stringKeyed(value)
        ? value.args.slice(0, 1)
        : [];
    case "arrIntrinsic":
      return LENDING_ARRAY_SEARCHES.has(value.method) &&
        value.receiver.type.kind === "array" &&
        value.receiver.type.elem.kind === "string"
        ? value.args.slice(0, 1)
        : [];
    case "call": {
      const lent = parameters.get(value.callee);
      return lent ? value.args.filter((_, index) => lent.has(index)) : [];
    }
    default:
      return [];
  }
}

/** Record parameters, by function and index, that the body only projects:
 * it reads their fields and passes them only to such parameters. The set
 * lists the string fields some read keeps (reads outside a lending
 * position); every other string field is lent (findLentRecordFields). */
export type LentRecordFields = ReadonlyMap<string, ReadonlyMap<number, ReadonlySet<string>>>;

/** Functions whose body only returns a record literal that stores some
 * parameters, each read once, directly as fields: by function, parameter
 * index to field (findRecordFieldProducers). A call stores those arguments
 * in the fields of its result and keeps them nowhere else. */
export type RecordFieldProducers = ReadonlyMap<string, ReadonlyMap<number, string>>;

/** What lends a string: lent string parameters, lent record fields and
 * record field producers. */
export interface LendingFacts {
  strings: LentStringParameters;
  records: LentRecordFields;
  producers: RecordFieldProducers;
}

const NO_LENDING_FACTS: LendingFacts = {
  strings: new Map(),
  records: new Map(),
  producers: new Map(),
};

interface LendingScan {
  /** Slice operands of lending consumers, excluding any node also reached
   * in an owning position. */
  scratch: Set<IrExpr>;
  /** Candidates read anywhere other than a lending position. */
  invalid: Set<string>;
  /** Record candidates read other than by a field read or a lent record
   * argument. */
  invalidRecords: Set<string>;
  /** String fields of record candidates read outside a lending position. */
  keptFields: Map<string, Set<string>>;
  /** Direct callees, for the parameter fixpoints. */
  callees: Set<string>;
}

/** One pass over `fn`: which candidate bindings only lending consumers read
 * (a slice initializer of a candidate local is not itself a read), and
 * which slice operands those consumers lend. A switch discriminant is only
 * compared with the case tests. Record candidates (`records`) may only be
 * projected: their field reads are checked as reads of the field, and they
 * may be passed to lent record parameters. A record `container`
 * declaration stores candidates in fields of a record candidate; those
 * stores are not reads. */
function scanLending(
  fn: IrFunction,
  candidates: ReadonlySet<string>,
  initializers: ReadonlyMap<string, Slice>,
  facts: LendingFacts,
  records: ReadonlySet<string> = new Set(),
  containers: ReadonlyMap<string, RecordContainer> = new Map(),
): LendingScan {
  const scan: LendingScan = {
    scratch: new Set(),
    invalid: new Set(),
    invalidRecords: new Set(),
    keptFields: new Map(),
    callees: new Set(),
  };
  const owned = new Set<IrExpr>();
  const keep = (record: string, field: string): void => {
    let fields = scan.keptFields.get(record);
    if (!fields) scan.keptFields.set(record, (fields = new Set()));
    fields.add(field);
  };
  const projected = (value: IrExpr): value is IrExpr & { kind: "recordGet" } =>
    value.kind === "recordGet" && value.obj.kind === "varRef" && records.has(value.obj.localId);
  function lent(value: IrExpr): boolean {
    if (value.kind === "varRef" && candidates.has(value.localId)) return true;
    if (projected(value)) return true;
    if (!isSlice(value)) return expr(value);
    scan.scratch.add(value);
    return everyExprChild(value, expr, stmt);
  }
  /** A call's arguments: lent string parameters lend, lent record
   * parameters project their record, and `stored` arguments (a producer's
   * fields in a container declaration) are not reads. */
  function callArgs(value: IrExpr & { kind: "call" }, stored: ReadonlySet<number> | null): void {
    scan.callees.add(value.callee);
    const strings = facts.strings.get(value.callee);
    const recordParams = facts.records.get(value.callee);
    value.args.forEach((arg, index) => {
      if (stored !== null && stored.has(index)) return;
      const kept = recordParams?.get(index);
      if (kept && arg.kind === "varRef" && records.has(arg.localId)) {
        for (const field of kept) keep(arg.localId, field);
        return;
      }
      if (strings?.has(index)) lent(arg);
      else expr(arg);
    });
  }
  function expr(value: IrExpr): boolean {
    if (isSlice(value)) owned.add(value);
    if (projected(value)) {
      if (value.type.kind === "string")
        keep((value.obj as { localId: string }).localId, value.field);
      return true;
    }
    if (value.kind === "varRef" && candidates.has(value.localId)) scan.invalid.add(value.localId);
    if (value.kind === "varRef" && records.has(value.localId))
      scan.invalidRecords.add(value.localId);
    if (value.kind === "closure" || value.kind === "classRef")
      for (const id of value.captures ?? []) {
        scan.invalid.add(id);
        scan.invalidRecords.add(id);
      }
    if (value.kind === "call") {
      callArgs(value, null);
      return true;
    }
    const operands = lentOperands(value, facts.strings);
    if (operands.length === 0) return everyExprChild(value, expr, stmt);
    return everyExprChild(
      value,
      (child) => (operands.includes(child) ? lent(child) : expr(child)),
      stmt,
    );
  }
  function stmt(value: IrStmt): boolean {
    // A candidate's single declaration initializes it with its slice.
    if (value.kind === "varDecl" && value.init !== null && initializers.has(value.localId))
      return everyExprChild(value.init, expr, stmt);
    const container = value.kind === "varDecl" ? containers.get(value.localId) : undefined;
    if (container && value.kind === "varDecl" && value.init !== null) {
      const init = value.init;
      if (init.kind === "recordLit")
        for (const field of init.fields) {
          if (!container.stored.has(field.value)) expr(field.value);
        }
      else if (init.kind === "call")
        callArgs(
          init,
          new Set(init.args.flatMap((arg, i) => (container.stored.has(arg) ? [i] : []))),
        );
      return true;
    }
    if (value.kind === "switch" && value.disc.type.kind === "string") {
      lent(value.disc);
      for (const entry of value.cases) {
        if (entry.test) expr(entry.test);
        entry.body.forEach(stmt);
      }
      return true;
    }
    return everyStmtChild(value, expr, stmt);
  }
  fn.body.forEach(stmt);
  for (const node of owned) scan.scratch.delete(node);
  return scan;
}

/** String parameters that every body reads only in lending positions,
 * including lent arguments of other such parameters: a caller may pass a
 * scratch slice to them. Start from every borrowed (unchanged) string
 * parameter of a synchronous function and drop violations until nothing changes, so
 * recursion through a lent parameter stays lent. A coroutine can keep its
 * parameters past the caller's frame, so it never lends. */
export function findLentStringParameters(
  functions: ReadonlyMap<string, IrFunction>,
  lifetimes: CallLifetimes,
): Map<string, Set<number>> {
  const lent = new Map<string, Set<number>>();
  for (const fn of functions.values()) {
    if (fn.async || fn.generator) continue;
    // Borrowed parameters are the unchanged ones nothing redeclares.
    const stable = lifetimes.borrowed.get(fn.name);
    const indexes = new Set<number>();
    fn.params.forEach((param, index) => {
      if (param.type.kind === "string" && stable?.has(index)) indexes.add(index);
    });
    if (indexes.size > 0) lent.set(fn.name, indexes);
  }
  const callers = new Map<string, Set<string>>();
  const pending = new Set(lent.keys());
  while (pending.size > 0) {
    const name = pending.values().next().value as string;
    pending.delete(name);
    const indexes = lent.get(name);
    const fn = functions.get(name);
    if (!indexes || !fn) continue;
    const ids = new Set([...indexes].map((index) => fn.params[index]!.localId));
    const scan = scanLending(fn, ids, new Map(), { ...NO_LENDING_FACTS, strings: lent });
    for (const callee of scan.callees) {
      let set = callers.get(callee);
      if (!set) callers.set(callee, (set = new Set()));
      set.add(name);
    }
    let changed = false;
    for (const index of [...indexes]) {
      if (!scan.invalid.has(fn.params[index]!.localId)) continue;
      indexes.delete(index);
      changed = true;
    }
    if (!changed) continue;
    if (indexes.size === 0) lent.delete(name);
    const affected = callers.get(name);
    if (affected) for (const caller of affected) if (lent.has(caller)) pending.add(caller);
  }
  return lent;
}

/** Functions whose whole body is `return { ... }`, a record literal storing
 * some parameters, each read nowhere else, directly as fields (a factory
 * such as `token(kind, text, pos)`). A synchronous body only: the result
 * then holds those arguments, and nothing else does. */
export function findRecordFieldProducers(
  functions: ReadonlyMap<string, IrFunction>,
): Map<string, Map<number, string>> {
  const producers = new Map<string, Map<number, string>>();
  for (const fn of functions.values()) {
    if (fn.async || fn.generator || fn.body.length !== 1) continue;
    const only = fn.body[0]!;
    if (only.kind !== "return" || only.value?.kind !== "recordLit") continue;
    const literal = only.value;
    const reads = new Map<string, number>();
    everyStmtList(fn.body, {
      expr: (value) => {
        if (value.kind === "varRef") reads.set(value.localId, (reads.get(value.localId) ?? 0) + 1);
        // A closure or class that captures a parameter keeps it too.
        if (value.kind === "closure" || value.kind === "classRef")
          for (const id of value.captures ?? []) reads.set(id, (reads.get(id) ?? 0) + 1);
        return true;
      },
      stmt: () => true,
    });
    const fields = new Map<number, string>();
    fn.params.forEach((param, index) => {
      if (param.type.kind !== "string" || reads.get(param.localId) !== 1) return;
      const field = literal.fields.find(
        (entry) =>
          !entry.overflow && entry.value.kind === "varRef" && entry.value.localId === param.localId,
      );
      if (field) fields.set(index, field.name);
    });
    if (fields.size > 0) producers.set(fn.name, fields);
  }
  return producers;
}

/** Record parameters that every body only projects (LentRecordFields), with
 * the string fields some read keeps. Start from every borrowed record
 * parameter of a synchronous function, keeping no field, and grow the kept
 * fields and drop escaping parameters until nothing changes; a record passed
 * to another lent record parameter keeps what that parameter keeps. */
export function findLentRecordFields(
  functions: ReadonlyMap<string, IrFunction>,
  lifetimes: CallLifetimes,
  strings: LentStringParameters,
): Map<string, Map<number, Set<string>>> {
  const lent = new Map<string, Map<number, Set<string>>>();
  for (const fn of functions.values()) {
    if (fn.async || fn.generator) continue;
    const stable = lifetimes.borrowed.get(fn.name);
    const indexes = new Map<number, Set<string>>();
    fn.params.forEach((param, index) => {
      if (param.type.kind === "record" && stable?.has(index)) indexes.set(index, new Set());
    });
    if (indexes.size > 0) lent.set(fn.name, indexes);
  }
  const callers = new Map<string, Set<string>>();
  const pending = new Set(lent.keys());
  while (pending.size > 0) {
    const name = pending.values().next().value as string;
    pending.delete(name);
    const indexes = lent.get(name);
    const fn = functions.get(name);
    if (!indexes || !fn) continue;
    const ids = new Set([...indexes.keys()].map((index) => fn.params[index]!.localId));
    const scan = scanLending(
      fn,
      new Set(),
      new Map(),
      { strings, records: lent, producers: new Map() },
      ids,
    );
    for (const callee of scan.callees) {
      let set = callers.get(callee);
      if (!set) callers.set(callee, (set = new Set()));
      set.add(name);
    }
    let changed = false;
    for (const [index, kept] of [...indexes]) {
      const id = fn.params[index]!.localId;
      if (scan.invalidRecords.has(id)) {
        indexes.delete(index);
        changed = true;
        continue;
      }
      const fields = scan.keptFields.get(id);
      if (fields)
        for (const field of fields) {
          if (kept.has(field)) continue;
          kept.add(field);
          changed = true;
        }
    }
    if (!changed) continue;
    if (indexes.size === 0) lent.delete(name);
    const affected = callers.get(name);
    if (affected) for (const caller of affected) if (lent.has(caller)) pending.add(caller);
  }
  return lent;
}

/** A record local whose declaration stores slice locals directly in some of
 * its fields: a record literal, or a call to a record field producer. */
interface RecordContainer {
  /** The stored candidate reads of the declaration, by field. */
  stored: Map<IrExpr, { field: string; slice: string }>;
}

/** Record locals declared with slice locals in their fields. */
function findRecordContainers(
  fn: IrFunction,
  bindings: ReadonlySet<string> | undefined,
  slices: ReadonlySet<string>,
  producers: RecordFieldProducers,
): Map<string, RecordContainer> {
  const containers = new Map<string, RecordContainer>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (stmt.kind !== "varDecl" || stmt.init === null || !bindings?.has(stmt.localId))
        return true;
      if (stmt.init.type.kind !== "record") return true;
      const stored = new Map<IrExpr, { field: string; slice: string }>();
      const init = stmt.init;
      if (init.kind === "recordLit") {
        for (const field of init.fields)
          if (!field.overflow && field.value.kind === "varRef" && slices.has(field.value.localId))
            stored.set(field.value, { field: field.name, slice: field.value.localId });
      } else if (init.kind === "call") {
        const fields = producers.get(init.callee);
        init.args.forEach((arg, index) => {
          const field = fields?.get(index);
          if (field !== undefined && arg.kind === "varRef" && slices.has(arg.localId))
            stored.set(arg, { field, slice: arg.localId });
        });
      }
      if (stored.size > 0) containers.set(stmt.localId, { stored });
      return true;
    },
  });
  return containers;
}

/** Slices whose every reader borrows them are written into a stack buffer
 * instead of a heap allocation (scr_str_slice_scratch): a slice operand of
 * a lending consumer, and the initializer of a stable local read only by
 * lending consumers. The copy is ASCII, bounded, and immortal for retain and
 * release, so it neither pins its source nor needs to be freed; longer or
 * non-ASCII results keep the ordinary owned string. Each site owns its
 * buffer: a site runs again only after its previous value is dead, since
 * nothing can keep it. Coroutine frames do not keep stack buffers across a
 * suspension, so they are left alone.
 *
 * A slice local may also be stored in a field of a stable record local
 * declared with it (a record literal, or a record field producer's result):
 * the record is then only projected, and every read of that field lends.
 * The record is declared after the slice in its scope and is never kept, so
 * it is dead before the slice's site runs again. */
export function findScratchStringSlices(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  scalar: ReadonlyMap<string, Slice>,
  facts: LendingFacts = NO_LENDING_FACTS,
): Set<IrExpr> {
  if (fn.async || fn.generator) return new Set();
  const bindings = lifetimes.bindings.get(fn.name);
  const locals = new Map<string, Slice>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        bindings?.has(stmt.localId) &&
        !scalar.has(stmt.localId) &&
        stmt.init !== null &&
        isSlice(stmt.init)
      )
        locals.set(stmt.localId, stmt.init);
      return true;
    },
  });
  const containers = findRecordContainers(fn, bindings, new Set(locals.keys()), facts.producers);
  const scan = scanLending(
    fn,
    new Set(locals.keys()),
    locals,
    facts,
    new Set(containers.keys()),
    containers,
  );
  for (const [record, container] of containers)
    for (const { field, slice } of container.stored.values())
      if (scan.invalidRecords.has(record) || scan.keptFields.get(record)?.has(field))
        scan.invalid.add(slice);
  for (const [id, init] of locals) if (!scan.invalid.has(id)) scan.scratch.add(init);
  return scan.scratch;
}

/** Write a scratch slice into its own stack buffer. The result is owned:
 * releasing the scratch copy does nothing, and a heap fallback is freed. */
export function emitScratchStringSlice(
  host: LlvmEmitterContext,
  slice: Slice,
  receiver: LlValue,
  args: readonly LlValue[],
): LlValue {
  const B = host.B;
  const buffer = B.slot();
  B.entryAllocas.push(`${buffer} = alloca [${SCRATCH_SLICE_BYTES} x i8], align 8`);
  host.declare(
    `declare ptr @scr_str_slice_scratch(ptr, double, double, i1 zeroext, ptr, ${host.sizeType})`,
  );
  const result = B.tmp();
  B.line(
    `${result} = call ptr @scr_str_slice_scratch(ptr ${receiver.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}, i1 ${slice.method === "substring" ? "true" : "false"}, ptr ${buffer}, ${host.sizeType} ${SCRATCH_SLICE_BYTES})`,
  );
  return host.own({ name: result, type: slice.type });
}
