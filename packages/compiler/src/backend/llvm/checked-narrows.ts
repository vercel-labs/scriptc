import {
  isRefCounted,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrType,
} from "../../ir/ir.js";
import { mangleBorrowedFunction } from "../mangle.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitCallArrayRead } from "./local-array-reads.js";

interface CheckedNarrowShape {
  unionId: string;
  tag: number;
  target: IrType;
}

/** A call to a checked single-arm extraction and the union it narrows. */
export interface CheckedNarrowCall {
  call: IrExpr & { kind: "call" };
  value: IrExpr;
  tag: number;
}

/** Recognize the complete checked-extraction body, not the helper's name:
 * one test per arm of the parameter's union, where the target arm returns
 * its payload and every other arm throws, followed by a final throw. A
 * helper that returns a default for some arm is not a checked extraction. */
function checkedNarrowShape(fn: IrFunction): CheckedNarrowShape | null {
  if (
    fn.async ||
    fn.generator ||
    fn.captures ||
    fn.classCaptures ||
    fn.params.length !== 1 ||
    fn.locals.length !== 1 ||
    fn.locals.some((local) => local.boxed || local.tdz) ||
    !isRefCounted(fn.returnType)
  )
    return null;
  const param = fn.params[0]!;
  if (param.type.kind !== "union") return null;
  const unionId = param.type.unionId;
  const last = fn.body[fn.body.length - 1];
  if (last?.kind !== "throw") return null;
  let tag = -1;
  for (const [index, stmt] of fn.body.slice(0, -1).entries()) {
    if (
      stmt.kind !== "if" ||
      stmt.else_ !== null ||
      stmt.cond.kind !== "unionIsTag" ||
      stmt.cond.negated ||
      stmt.cond.tag !== index ||
      stmt.cond.unionId !== unionId ||
      stmt.cond.value.kind !== "varRef" ||
      stmt.cond.value.localId !== param.localId ||
      stmt.then.length !== 1
    )
      return null;
    const branch = stmt.then[0]!;
    if (branch.kind === "throw") continue;
    const value = branch.kind === "return" ? branch.value : null;
    if (
      tag >= 0 ||
      value?.kind !== "unionNarrow" ||
      value.unionId !== unionId ||
      value.tag !== index ||
      value.value.kind !== "varRef" ||
      value.value.localId !== param.localId ||
      !typeEquals(value.type, fn.returnType)
    )
      return null;
    tag = index;
  }
  return tag < 0 ? null : { unionId, tag, target: fn.returnType };
}

/** Checked extractions in finalized IR, indexed once per module. */
export class CheckedNarrows {
  private readonly shapes = new Map<string, CheckedNarrowShape>();

  constructor(functions: ReadonlyMap<string, IrFunction>) {
    for (const fn of functions.values()) {
      const shape = checkedNarrowShape(fn);
      if (shape) this.shapes.set(fn.name, shape);
    }
  }

  get(e: IrExpr): CheckedNarrowCall | null {
    if (e.kind !== "call" || e.args.length !== 1) return null;
    const shape = this.shapes.get(e.callee);
    const value = e.args[0]!;
    if (
      !shape ||
      !typeEquals(shape.target, e.type) ||
      value.type.kind !== "union" ||
      value.type.unionId !== shape.unionId
    )
      return null;
    return { call: e, value, tag: shape.tag };
  }
}

/** A checked extraction consumed at once by a field or tag load. The
 * successful arm borrows the payload from the union, which itself borrows
 * from its source: a dense array read keeps the element in the array slot,
 * and no user code runs before the consumer loads from it. Every other arm
 * calls the helper with the same union, so the thrown error is unchanged.
 * Returns null, having emitted nothing, when the helper would own its
 * argument. */
export function emitCheckedNarrowReceiver(
  host: LlvmEmitterContext,
  narrow: CheckedNarrowCall,
): LlValue | null {
  const callee = narrow.call.callee;
  if (!host.callLifetimes.borrowed.get(callee)?.has(0) || !host.mayThrow.has(callee)) return null;
  const B = host.B;
  const read = host.optionalArrayReads.get(narrow.value);
  const union = read
    ? emitCallArrayRead(host, { ...read, borrow: true }, true)
    : host.emitUnionProjection(narrow.value);
  const tagPtr = B.tmp(),
    tag = B.tmp(),
    present = B.tmp();
  B.line(`${tagPtr} = getelementptr inbounds %ScrUnion, ptr ${union.name}, i64 0, i32 1`);
  B.line(`${tag} = load i32, ptr ${tagPtr}`);
  B.line(`${present} = icmp eq i32 ${tag}, ${narrow.tag}`);
  const yes = B.newLabel("narrow.present"),
    no = B.newLabel("narrow.other");
  B.condBr(present, yes, no);
  B.startBlock(no);
  B.line(`call ptr @${mangleBorrowedFunction(callee)}(ptr ${union.name})`);
  host.emitPendingCheck();
  // Every arm but the target throws, so the helper never returns here.
  B.terminate("unreachable");
  B.startBlock(yes);
  return { name: host.unionPeek(union.name), type: narrow.call.type };
}
