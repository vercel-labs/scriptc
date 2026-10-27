/* Key-order dispatch for shapes whose values record the order their keys
 * were written in (IrRecordShape.orderVariants): an emitter that walks a
 * record's keys emits one walk per order and branches on the value's
 * KEY_ORDER_FIELD. */
import type { IrRecordShape } from "../../ir/ir.js";
import { KEY_ORDER_FIELD, shapeKeyOrders } from "../../ir/ir.js";
import { mangleRecordStruct } from "../mangle.js";
import type { BlockBuilder } from "./blocks.js";

/** Emits `walk(order, index)` for record `rec` of `shape`, once per order behind a
 * switch on the value's order index when the shape has several. Each walk
 * starts in its own block, and the code after this call continues in the
 * block they all branch to. */
export function emitPerKeyOrder(
  B: BlockBuilder,
  shape: IrRecordShape,
  fieldBase: number,
  rec: string,
  walk: (order: readonly string[], index: number) => void,
): void {
  const orders = shapeKeyOrders(shape);
  if (orders.length === 1) {
    walk(orders[0]!, 0);
    return;
  }
  const index = shape.fields.findIndex((f) => f.name === KEY_ORDER_FIELD) + fieldBase;
  const p = B.tmp();
  const n = B.tmp();
  const i = B.tmp();
  B.line(
    `${p} = getelementptr inbounds %${mangleRecordStruct(shape.id)}, ptr ${rec}, i64 0, i32 ${index} ; .${KEY_ORDER_FIELD}`,
  );
  B.line(`${n} = load double, ptr ${p}`);
  B.line(`${i} = fptosi double ${n} to i32`);
  const labels = orders.map(() => B.newLabel("ko"));
  const join = B.newLabel("ko.join");
  B.terminate(
    `switch i32 ${i}, label %${labels[0]} [ ${labels
      .slice(1)
      .map((label, k) => `i32 ${k + 1}, label %${label}`)
      .join(" ")} ]`,
  );
  orders.forEach((order, k) => {
    B.startBlock(labels[k]!);
    walk(order, k);
    B.br(join);
  });
  B.startBlock(join);
}
