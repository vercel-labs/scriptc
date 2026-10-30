/* Typed-array header fields read once at a speculative loop's entry.
 *
 * A view's length, data pointer and shared storage are set at construction
 * and never change, and a view held by a const local or a parameter that
 * the loop does not rebind is the same view in every iteration. The entry
 * reads those fields once, and every element access in the loop's copies
 * (the ordinary copy, the fast copy and the copy a failed check resumes in)
 * uses the values. No header read is then left inside the copies for LLVM's
 * load PRE to move ahead of the fast copy's exits: such a move keeps the
 * fast loop's first iteration in the loop, with the checks that one
 * iteration of it makes redundant. */
import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { everyStmt } from "../../ir/traverse.js";
import { emitBytesData, emitBytesHeaderLength, emitBytesSharedStorage } from "./expr-bytes.js";
import type { LlEmitter } from "./emitter.js";

export interface BytesHeader {
  length: string;
  data: string;
  /** The view's shared storage (worker programs only). */
  shared: string | null;
}

export interface BytesHeaderScope {
  /** The function the scope's values belong to. */
  fn: string;
  locals: ReadonlyMap<string, BytesHeader>;
  /** The header of each receiver value read from one of `locals`. */
  values: Map<string, BytesHeader>;
}

/** Reads the header fields of the views `loop` accesses through a const
 * local or a parameter it does not rebind, at the current block, which must
 * dominate every copy of the loop. Null when there are none. */
export function emitLoopBytesHeaders(
  emitter: LlEmitter,
  loop: IrStmt,
  parameters: ReadonlySet<string>,
): BytesHeaderScope | null {
  const receivers = new Set<string>();
  const rebound = new Set<string>();
  const receiver = (e: IrExpr): void => {
    if (e.kind === "varRef") receivers.add(e.localId);
  };
  everyStmt(loop, {
    expr: (e) => {
      if (e.kind === "bytesIntrinsic") receiver(e.receiver);
      else if (e.kind === "assignExpr" || e.kind === "incDec") rebound.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "bytesSet") receiver(s.arr);
      else if (s.kind === "assign" || s.kind === "forOf" || s.kind === "varDecl")
        rebound.add(s.localId);
      else if (s.kind === "tryCatch" && s.catchLocalId !== null) rebound.add(s.catchLocalId);
      return true;
    },
  });
  const locals = new Map<string, BytesHeader>();
  for (const id of receivers) {
    if (rebound.has(id)) continue;
    const local = emitter.currentLocals.get(id);
    if (local === undefined || local.boxed === true || local.type.kind !== "bytes") continue;
    if (local.mutable && !parameters.has(id)) continue;
    if (emitter.integerLoopBindings.has(id) || emitter.int32Locals.has(id)) continue;
    const B = emitter.B;
    const view = B.tmp();
    B.line(`${view} = load ptr, ptr ${emitter.binding(id).slot}${emitter.slotAlias(id)}`);
    locals.set(id, {
      length: emitBytesHeaderLength(emitter, view),
      data: emitBytesData(emitter, view),
      shared: emitter.mod.workers ? emitBytesSharedStorage(emitter, view) : null,
    });
  }
  if (locals.size === 0) return null;
  return { fn: emitter.currentFunctionName, locals, values: new Map() };
}
