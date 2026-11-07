import type { IrExpr, IrFunction } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

/** A synchronous, invocation-only consumer cannot retain the environment.
 * Capture boxes still have independent owners in the ordinary call frame;
 * only the closure allocation and its cycle header disappear. */
export class StackCallbacks {
  private readonly targets = new Map<string, boolean>();
  private remaining = 0;

  constructor(private readonly functions: ReadonlyMap<string, IrFunction>) {}

  reset(enabled: boolean): void {
    // Bound entry-block storage even when a function contains many sites.
    this.remaining = enabled ? 4096 : 0;
  }

  emit(host: LlvmEmitterContext, value: IrExpr): LlValue | null {
    if (value.kind !== "closure" || value.captures.length > 32) return null;
    // An environment that holds values has one more word, its descriptor,
    // which nothing reads here: this closure is never traced or destroyed.
    const layout = value.adapts === true ? null : host.valueCaptures.layout(value.fnName);
    const words = 6 + value.captures.length + (layout === null ? 0 : 2);
    const bytes = words * 8;
    if (bytes > this.remaining || !this.eligible(value.fnName)) return null;
    this.remaining -= bytes;
    const B = host.B;
    const closure = B.slot();
    const boxes = layout?.boxes ?? value.captures.length;
    B.entryAllocas.push(
      `${closure} = alloca ${layout === null ? `{ %ScrClosure, [${boxes} x ptr] }` : host.environmentType(layout)}`,
    );
    B.line(`store %ScrClosure zeroinitializer, ptr ${closure}`);
    B.line(`store ${host.sizeType} -1, ptr ${closure}`);
    const fn = B.tmp();
    B.line(`${fn} = getelementptr inbounds %ScrClosure, ptr ${closure}, i32 0, i32 1`);
    B.line(`store ptr @${host.callTarget(value.fnName)}, ptr ${fn}`);
    const count = B.tmp();
    B.line(`${count} = getelementptr inbounds %ScrClosure, ptr ${closure}, i32 0, i32 2`);
    B.line(`store ${host.sizeType} ${boxes}, ptr ${count}`);
    const target = this.functions.get(value.fnName);
    const functionKind = target ? host.closureFunctionKind(target) : 0;
    if (functionKind !== 0) {
      const kind = B.tmp();
      B.line(`${kind} = getelementptr inbounds %ScrClosure, ptr ${closure}, i32 0, i32 4`);
      B.line(`store i32 ${functionKind}, ptr ${kind}`);
    }
    // The closure's own `length` (IrExpr closure.length) is not recorded
    // here: reading it boxes the function value, which an invocation-only
    // consumer never does, and a header that stores its own address would
    // keep LLVM from dissolving the allocation.
    value.captures.forEach((localId, capture) => {
      const place = layout?.slots[capture];
      if (place !== undefined && place.kind !== "box") {
        // The binding keeps its value for the statement: the environment
        // borrows it.
        host.storeEnvironmentValue(layout!, closure, capture, localId, false, value.loc);
        return;
      }
      const index = place?.index ?? capture;
      const box = host.retainBox(host.captureBox(localId));
      const caps = B.tmp();
      const slot = B.tmp();
      B.line(`${caps} = getelementptr inbounds %ScrClosure, ptr ${closure}, i32 1`);
      B.line(`${slot} = getelementptr inbounds ptr, ptr ${caps}, ${host.sizeType} ${index}`);
      B.line(`store ptr ${box}, ptr ${slot}`);
      // Use the same forward capture order as scr_closure_release, on both
      // normal and exceptional exits. The immortal stack header owns none.
      host.own({ name: slot, type: value.type, slot: true, boxed: true });
    });
    return { name: closure, type: value.type };
  }

  eligible(name: string): boolean {
    const cached = this.targets.get(name);
    if (cached !== undefined) return cached;
    const fn = this.functions.get(name);
    let nodes = 0;
    // A self-reference can publish the running environment even when its
    // caller only invokes it. Async/generator bodies can outlive the call.
    const safe =
      fn !== undefined &&
      fn.captures !== undefined &&
      !fn.async &&
      !fn.generator &&
      everyStmtList(fn.body, {
        expr: (expr) => ++nodes <= 512 && expr.kind !== "selfRef",
        stmt: () => ++nodes <= 512,
      });
    this.targets.set(name, safe);
    return safe;
  }
}
