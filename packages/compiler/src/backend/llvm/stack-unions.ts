import {
  isRefCounted,
  isUnitType,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

type UnionWrap = IrExpr & { kind: "unionWrap" };

/** `unionWrap(unionNarrow(u))` that stores the narrowed arm under the same
 * tag with the same type (`T | undefined` from an element of `T`'s union, a
 * retag between overlapping unions). Boxes are immutable and hold only the
 * tag, the slot and the arm's RC entry points, so the source box already IS
 * the target value and the emitter shares it. That retains the source box,
 * so call-lifetime analysis must treat the operand as escaping: it can then
 * never be a stack box. `boxed` holds only `%ScrUnion`-represented unions. */
export function sharesNarrowedUnionBox(
  value: UnionWrap,
  boxed: ReadonlyMap<string, IrUnionDef>,
): value is UnionWrap & { value: IrExpr & { kind: "unionNarrow" } } {
  const narrowed = value.value;
  if (narrowed.kind !== "unionNarrow" || narrowed.tag !== value.tag) return false;
  const sourceArm = boxed.get(narrowed.unionId)?.arms[narrowed.tag];
  const targetArm = boxed.get(value.unionId)?.arms[value.tag];
  return (
    sourceArm !== undefined &&
    targetArm !== undefined &&
    !isUnitType(sourceArm) &&
    typeEquals(sourceArm, targetArm)
  );
}

/** The ordinary tag and payload ABI can live on the stack when every
 * consumer is a projection. No RC or tracing entry point may receive this
 * box: its payload retains its ordinary independent owner instead. */
export function canStackUnion(
  value: IrExpr,
  unions: ReadonlyMap<string, IrUnionDef>,
): value is UnionWrap {
  if (
    value.kind !== "unionWrap" ||
    value.type.kind !== "union" ||
    value.type.unionId !== value.unionId
  )
    return false;
  const arm = unions.get(value.unionId)?.arms[value.tag];
  if (!arm || !typeEquals(arm, value.value.type)) return false;
  return (
    isRefCounted(arm) ||
    arm.kind === "f64" ||
    arm.kind === "bool" ||
    arm.kind === "procStream" ||
    (isUnitType(arm) && value.value.kind === "unitLit")
  );
}

export function findLocalStackUnions(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  unions: ReadonlyMap<string, IrUnionDef>,
): Map<string, UnionWrap> {
  const result = new Map<string, UnionWrap>();
  const safe = lifetimes.locals.get(fn.name);
  if (!safe?.size) return result;
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        safe.has(stmt.localId) &&
        stmt.init &&
        canStackUnion(stmt.init, unions)
      )
        result.set(stmt.localId, stmt.init);
      return true;
    },
  });
  return result;
}

export interface StackUnion {
  value: LlValue;
  /** The existing statement frame owns this value until a local binding
   * explicitly moves it into lexical cleanup. Null for scalar/unit arms. */
  payload: LlValue | null;
  payloadSlot: string;
}

export function emitStackUnion(host: LlvmEmitterContext, expr: UnionWrap): StackUnion {
  const B = host.B;
  const box = B.slot(),
    tag = B.slot(),
    slot = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  B.entryAllocas.push(`${slot} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  const type = expr.value.type;
  let payload: LlValue | null = null;
  if (isUnitType(type)) {
    B.line(`store i64 0, ptr ${slot}`);
  } else {
    // Evaluate before publishing the box. An exception still belongs to
    // the ordinary statement frame; a partial local never gains ownership.
    const value = host.emitExpr(expr.value);
    if (isRefCounted(type)) {
      B.line(`store i64 0, ptr ${slot}`);
      B.line(`store ptr ${value.name}, ptr ${slot}`);
      payload = value;
    } else if (type.kind === "bool") {
      const bits = B.tmp();
      B.line(`${bits} = zext i1 ${value.name} to i64`);
      B.line(`store i64 ${bits}, ptr ${slot}`);
    } else {
      B.line(`store double ${value.name}, ptr ${slot}`);
    }
  }
  B.line(`store i32 ${expr.tag}, ptr ${tag}`);
  return { value: { name: box, type: expr.type }, payload, payloadSlot: slot };
}
