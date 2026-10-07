import type { LlvmEmitterContext } from "./expr-context.js";
import type { IrExpr, IrFunction, IrLocal, IrStmt } from "../../ir/ir.js";
import type { IntegerRange, IntegerRanges } from "../../ir/integer-ranges.js";
import type { IntegerCountedForLoop } from "../../ir/integer-loops.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

export interface ByteWindow {
  receiver: IrExpr;
  stride: number;
  bounds: ReadonlySet<IrExpr | IrStmt>;
  ranges: IntegerRanges;
  targets: { receiver: IrExpr; cursor: IrExpr & { kind: "varRef" }; stride: number }[];
}

/** Extra receivers are read before the loop only when their initialization
 * dominates its head. In particular, a zero-iteration loop must not start
 * reading an otherwise unused, uninitialized output binding. */
export function findInitializedByteLoopBindings(
  fn: IrFunction,
): ReadonlyMap<IrStmt, ReadonlySet<string>> {
  const entries = new Map<IrStmt, ReadonlySet<string>>();
  const initialized = new Set(fn.params.map((p) => p.localId));
  function list(body: readonly IrStmt[], known: Set<string>): void {
    for (const stmt of body) {
      if (stmt.kind === "varDecl") {
        if (stmt.init) known.add(stmt.localId);
        else known.delete(stmt.localId);
      }
      if (stmt.kind === "assign") known.add(stmt.localId);
      if (stmt.kind === "block" && !stmt.labels?.length) list(stmt.body, known);
      if (stmt.kind === "if") {
        const left = new Set(known),
          right = new Set(known);
        list(stmt.then, left);
        list(stmt.else_ ?? [], right);
        for (const id of left) if (right.has(id)) known.add(id);
      }
      if (stmt.kind === "for") {
        entries.set(stmt, new Set(known));
        const inner = new Set(known);
        if (stmt.init) list([stmt.init], inner);
        list(stmt.body, inner);
      }
      if (stmt.kind === "while" || stmt.kind === "doWhile") list(stmt.body, new Set(known));
    }
  }
  list(fn.body, initialized);
  return entries;
}

/** A complete-record guard proves both the last field's extent and exact
 * affine offsets. The checked loop remains authoritative for partial input.
 * Only bounded, synchronous bodies with stable direct receivers qualify. */
export function matchByteWindow(
  loop: IrStmt & { kind: "for" },
  counted: IntegerCountedForLoop,
  locals: ReadonlyMap<string, IrLocal>,
  captured: ReadonlySet<string>,
  ranges: IntegerRanges,
  initialized: ReadonlySet<string>,
): ByteWindow | null {
  if (
    counted.start.kind !== "numLit" ||
    counted.start.value !== 0 ||
    Object.is(counted.start.value, -0) ||
    counted.step <= 1 ||
    counted.inclusive ||
    counted.limit.kind !== "bytesIntrinsic" ||
    (counted.limit.method !== "length" && counted.limit.method !== "byteLength") ||
    counted.limit.receiver.kind !== "varRef" ||
    counted.limit.receiver.type.kind !== "bytes" ||
    counted.limit.receiver.type.elem !== "u8"
  )
    return null;
  const receiver = counted.limit.receiver;
  const receiverId = receiver.localId;
  const local = locals.get(receiverId);
  if (
    !local ||
    local.boxed ||
    local.tdz ||
    captured.has(receiverId) ||
    captured.has(counted.localId)
  )
    return null;
  const initializers = new Map<string, IrExpr>();
  const changed = new Set<string>();
  const declared = new Set<string>();
  const progress = new Map<string, number>();
  const refused = new Set<string>();
  // Summing both branch arms bounds every path. At iteration k, a cursor
  // starts at most k * budget; prefix sums also cover skips and early exits.
  const prefix = new Map<IrExpr | IrStmt, ReadonlyMap<string, number>>();
  const update = (id: string, value: IrExpr | null): void => {
    if (
      value?.kind !== "bin" ||
      value.op !== "+" ||
      value.left.kind !== "varRef" ||
      value.left.localId !== id ||
      value.right.kind !== "numLit" ||
      !Number.isSafeInteger(value.right.value) ||
      value.right.value <= 0
    ) {
      refused.add(id);
      return;
    }
    const next = (progress.get(id) ?? 0) + value.right.value;
    if (!Number.isSafeInteger(next)) refused.add(id);
    progress.set(id, next);
  };
  let cost = 0;
  const countExpr = (e: IrExpr): boolean => {
    if (++cost > 160) return false;
    if (e.kind === "assignExpr" || e.kind === "incDec") changed.add(e.localId);
    if (
      (e.kind === "assignExpr" || e.kind === "incDec") &&
      (e.localId === receiverId || e.localId === counted.localId)
    )
      return false;
    prefix.set(e, new Map(progress));
    const result = everyExprChild(e, countExpr, stableStmt);
    if (e.kind === "assignExpr") refused.add(e.localId);
    if (e.kind === "incDec") refused.add(e.localId);
    return result;
  };
  const stableExpr = (e: IrExpr): boolean => countExpr(e) && isStableReceiverOperand(e, receiverId);
  const stableStmt = (s: IrStmt): boolean => {
    if (++cost > 160) return false;
    switch (s.kind) {
      case "varDecl": {
        declared.add(s.localId);
        const binding = locals.get(s.localId);
        if (initializers.has(s.localId)) changed.add(s.localId);
        if (s.init && binding && !binding.mutable && !binding.boxed && !binding.tdz)
          initializers.set(s.localId, s.init);
        break;
      }
      case "assign":
        changed.add(s.localId);
        if (s.localId === receiverId || s.localId === counted.localId) return false;
        break;
      case "exprStmt":
      case "bytesSet":
      case "if":
      case "block":
      case "break":
      case "continue":
      case "return":
        break;
      default:
        return false;
    }
    prefix.set(s, new Map(progress));
    const result = everyStmtChild(s, stableExpr, stableStmt);
    if (s.kind === "assign") update(s.localId, s.value);
    return result;
  };
  if (!loop.body.every(stableStmt)) return null;
  const resolving = new Set<string>();
  function affine(e: IrExpr, counter: string): { offset: number; maximum: number } | null {
    if (e.kind === "varRef") {
      if (e.localId === counter) return { offset: 0, maximum: 0 };
      if (captured.has(e.localId) || changed.has(e.localId)) return null;
      const init = initializers.get(e.localId);
      if (!init || resolving.has(e.localId)) return null;
      resolving.add(e.localId);
      const offset = affine(init, counter);
      resolving.delete(e.localId);
      return offset;
    }
    if (
      e.kind !== "bin" ||
      (e.op !== "+" && e.op !== "-") ||
      e.right.kind !== "numLit" ||
      !Number.isSafeInteger(e.right.value)
    )
      return null;
    const left = affine(e.left, counter);
    if (left === null) return null;
    const result = left.offset + (e.op === "+" ? e.right.value : -e.right.value);
    return Number.isSafeInteger(result) && result >= 0
      ? { offset: result, maximum: Math.max(left.maximum, result) }
      : null;
  }
  const bounds = new Set<IrExpr | IrStmt>();
  const facts = new Map<IrExpr, IntegerRange | null>(ranges);
  const counterMax = Number.MAX_SAFE_INTEGER - counted.step;
  const targetGroups = new Map<
    string,
    {
      receiver: IrExpr;
      cursor: IrExpr & { kind: "varRef" };
      stride: number;
      nodes: (IrExpr | IrStmt)[];
    }
  >();
  function access(node: IrExpr | IrStmt, array: IrExpr, index: IrExpr, width: number): void {
    if (array.kind !== "varRef") return;
    if (array.localId === receiverId) {
      const offset = affine(index, counted.localId);
      if (offset && offset.maximum <= counted.step && offset.offset + width <= counted.step)
        bounds.add(node);
      return;
    }
    const target = locals.get(array.localId);
    if (
      !target ||
      target.boxed ||
      target.tdz ||
      captured.has(array.localId) ||
      !initialized.has(array.localId) ||
      declared.has(array.localId) ||
      changed.has(array.localId) ||
      array.type.kind !== "bytes" ||
      array.type.elem !== "u8"
    )
      return;
    for (const [id, budget] of progress) {
      const cursorLocal = locals.get(id);
      if (
        !budget ||
        !initialized.has(id) ||
        refused.has(id) ||
        declared.has(id) ||
        captured.has(id) ||
        !cursorLocal ||
        cursorLocal.boxed ||
        cursorLocal.tdz ||
        cursorLocal.type.kind !== "f64"
      )
        continue;
      const offset = affine(index, id);
      if (offset === null) continue;
      const before = prefix.get(node)?.get(id) ?? 0;
      const end = before + offset.offset + width;
      const stride = Math.max(budget, end, before + offset.maximum);
      if (!Number.isSafeInteger(stride) || stride > 2147483647) continue;
      const key = `${array.localId.length}:${array.localId}${id}`;
      const group = targetGroups.get(key);
      if (group) {
        group.stride = Math.max(group.stride, stride);
        group.nodes.push(node);
      } else
        targetGroups.set(key, {
          receiver: array,
          cursor: { kind: "varRef", localId: id, type: cursorLocal.type, loc: index.loc },
          stride,
          nodes: [node],
        });
    }
  }
  const expr = (e: IrExpr): boolean => {
    const offset = affine(e, counted.localId);
    if (offset && offset.maximum <= counted.step) {
      const max = counterMax + offset.offset;
      if (Number.isSafeInteger(max)) facts.set(e, { min: offset.offset, max });
    }
    if (e.kind === "bytesIntrinsic") {
      const numeric = byteNumberAccess(e);
      if (numeric) access(e, e.receiver, e.args[numeric.offsetArg]!, numeric.width);
      else if (e.method === "get" && e.args[0]) access(e, e.receiver, e.args[0], 1);
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "bytesSet") access(s, s.arr, s.index, 1);
    return everyStmtChild(s, expr, stmt);
  };
  loop.body.every(stmt);
  if (bounds.size < 2) return null;
  const targets = [...targetGroups.values()].slice(0, 4);
  for (const target of targets) for (const node of target.nodes) bounds.add(node);
  const cursorStrides = new Map<string, number>();
  for (const target of targets)
    cursorStrides.set(
      target.cursor.localId,
      Math.max(cursorStrides.get(target.cursor.localId) ?? 0, target.stride),
    );
  const scoped = new Map<IrExpr, IntegerRange | null>();
  const cursorExpr = (e: IrExpr): boolean => {
    for (const [id, stride] of cursorStrides) {
      const offset = affine(e, id);
      if (!offset) continue;
      const before = prefix.get(e)?.get(id) ?? 0;
      const max = Number.MAX_SAFE_INTEGER - stride + before + offset.offset;
      const safe = before + offset.maximum <= stride && Number.isSafeInteger(max);
      const previous = scoped.get(e);
      scoped.set(
        e,
        !safe || previous === null
          ? null
          : {
              min: Math.min(previous?.min ?? offset.offset, offset.offset),
              max: Math.max(previous?.max ?? max, max),
            },
      );
    }
    return everyExprChild(e, cursorExpr, cursorStmt);
  };
  const cursorStmt = (s: IrStmt): boolean => everyStmtChild(s, cursorExpr, cursorStmt);
  loop.body.every(cursorStmt);
  for (const [e, range] of scoped) if (range) facts.set(e, range);
  return { receiver, stride: counted.step, bounds, ranges: facts, targets };
}

/** Compare record capacities with division so expanding output records
 * cannot overflow either target's address width. Raw extents establish
 * safe-number limits separately from each field's value validation. */
export function emitByteWindowGuard(host: LlvmEmitterContext, window: ByteWindow): string {
  const B = host.B;
  const receiver = host.emitStableReceiver(window.receiver, []);
  const lengthPtr = B.tmp(),
    length = B.tmp(),
    remaining = B.tmp(),
    complete = B.tmp();
  B.line(`${lengthPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver.name}, i64 0, i32 1`);
  B.line(`${length} = load ${host.sizeType}, ptr ${lengthPtr}`);
  B.line(`${remaining} = urem ${host.sizeType} ${length}, ${window.stride}`);
  B.line(`${complete} = icmp eq ${host.sizeType} ${remaining}, 0`);
  let valid = complete;
  if (host.sizeType === "i64") {
    const exact = B.tmp();
    valid = B.tmp();
    B.line(`${exact} = icmp ule i64 ${length}, ${Number.MAX_SAFE_INTEGER}`);
    B.line(`${valid} = and i1 ${complete}, ${exact}`);
  }
  for (const target of window.targets) {
    const output = host.emitStableReceiver(target.receiver, []);
    const cursor = host.emitExpr(target.cursor);
    const outputPtr = B.tmp(),
      outputLength = B.tmp(),
      records = B.tmp(),
      capacity = B.tmp(),
      fits = B.tmp(),
      zero = B.tmp(),
      both = B.tmp(),
      all = B.tmp();
    B.line(`${outputPtr} = getelementptr inbounds %ScrBytes, ptr ${output.name}, i64 0, i32 1`);
    B.line(`${outputLength} = load ${host.sizeType}, ptr ${outputPtr}`);
    B.line(`${records} = udiv ${host.sizeType} ${length}, ${window.stride}`);
    B.line(`${capacity} = udiv ${host.sizeType} ${outputLength}, ${target.stride}`);
    B.line(`${fits} = icmp uge ${host.sizeType} ${capacity}, ${records}`);
    const cursorBits = B.tmp();
    // Only +0 seeds exact arithmetic; -0 retains the checked number path.
    B.line(`${cursorBits} = bitcast double ${cursor.name} to i64`);
    B.line(`${zero} = icmp eq i64 ${cursorBits}, 0`);
    B.line(`${both} = and i1 ${fits}, ${zero}`);
    B.line(`${all} = and i1 ${valid}, ${both}`);
    valid = all;
    if (host.sizeType === "i64") {
      const exact = B.tmp(),
        guarded = B.tmp();
      B.line(`${exact} = icmp ule i64 ${outputLength}, ${Number.MAX_SAFE_INTEGER}`);
      B.line(`${guarded} = and i1 ${valid}, ${exact}`);
      valid = guarded;
    }
  }
  return valid;
}
