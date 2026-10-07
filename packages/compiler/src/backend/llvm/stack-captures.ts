import {
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { vAdapters } from "./shapes.js";
import type { StackCallbacks } from "./stack-callbacks.js";

/** A captured binding can stay in its declaring frame only when every
 * environment that contains it finishes within that binding's scope.
 * Payload values can still escape: their ordinary owned reads retain them. */
export class StackCaptures {
  private readonly recaptured = new Map<string, Set<string>>();
  private locals = new Set<string>();
  private remaining = 0;

  constructor(
    private readonly functions: ReadonlyMap<string, IrFunction>,
    private readonly lifetimes: CallLifetimes,
    private readonly callbacks: StackCallbacks,
  ) {}

  reset(fn: IrFunction, enabled: boolean): void {
    this.locals = new Set();
    this.remaining = enabled ? 2048 : 0;
    if (!enabled) return;
    const possible = new Set(
      fn.locals.filter((local) => local.boxed && !local.tdz).map((local) => local.id),
    );
    if (possible.size === 0) return;
    const invalid = new Set([
      ...fn.params.map((param) => param.localId),
      ...(fn.captures ?? []).map((capture) => capture.localId),
      ...(fn.classCaptures ?? []).map((capture) => capture.localId),
    ]);
    const declarations = new Map<string, number>();
    let nodes = 0;
    const expr = (node: IrExpr, immediate: boolean): boolean => {
      if (++nodes > 4096) return false;
      if (node.kind === "closure") {
        const target = this.functions.get(node.fnName);
        const safe = immediate && this.callbacks.eligible(node.fnName);
        const nested = safe ? this.nestedCaptures(target!) : null;
        node.captures.forEach((id, index) => {
          const capture = target?.captures?.[index];
          if (!safe || !capture || nested!.has(capture.localId)) invalid.add(id);
        });
      } else if (node.kind === "classRef") {
        for (const id of node.captures ?? []) invalid.add(id);
      } else if (node.kind === "call") {
        const parameters = this.lifetimes.parameters.get(node.callee);
        return node.args.every((arg, index) => expr(arg, parameters?.has(index) === true));
      } else if (node.kind === "callValue") {
        return (
          expr(node.callee, true) &&
          (!node.receiver || expr(node.receiver, false)) &&
          node.args.every((arg) => expr(arg, false))
        );
      }
      return everyExprChild(node, (child) => expr(child, false), stmt);
    };
    const stmt = (node: IrStmt): boolean => {
      if (++nodes > 4096) return false;
      if (node.kind === "varDecl")
        declarations.set(node.localId, (declarations.get(node.localId) ?? 0) + 1);
      else if (node.kind === "forOf") invalid.add(node.localId);
      else if (node.kind === "tryCatch" && node.catchLocalId !== null)
        invalid.add(node.catchLocalId);
      else if (node.kind === "for") {
        // Loop-head lets are freshened by a separate allocation path.
        const initializers =
          node.init?.kind === "block" ? node.init.body : node.init ? [node.init] : [];
        for (const init of initializers) if (init.kind === "varDecl") invalid.add(init.localId);
      }
      return everyStmtChild(node, (child) => expr(child, false), stmt);
    };
    if (!fn.body.every(stmt)) return;
    for (const id of possible) {
      if (!invalid.has(id) && declarations.get(id) === 1) this.locals.add(id);
    }
  }

  emit(
    host: LlvmEmitterContext,
    id: string,
    type: IrType,
  ): { box: string; owner?: { slot: string; type: IrType } } | null {
    // 48 bytes also bounds the smaller wasm32 layout. Charge actual emitted
    // sites, including duplicated finally bodies and versioned loops.
    if (!this.locals.has(id) || this.remaining < 48) return null;
    const ref = isRefCounted(type);
    if (
      !ref &&
      type.kind !== "f64" &&
      type.kind !== "date" &&
      type.kind !== "procStream" &&
      type.kind !== "bool"
    )
      return null;
    this.remaining -= 48;
    const B = host.B;
    const box = B.slot();
    B.entryAllocas.push(`${box} = alloca %ScrBox`);
    B.entryAllocas.push(`store %ScrBox zeroinitializer, ptr ${box}`);
    let retain = "null",
      release = "null";
    if (ref) {
      const adapters = vAdapters(host.shapeHost, type);
      retain = adapters.retain;
      release = adapters.release;
    }
    const kind = ref ? 5 : type.kind === "bool" ? 1 : 0;
    B.line(
      `store %ScrBox { ${host.sizeType} -1, i32 ${kind}, ptr ${retain}, ptr ${release}, ptr null, i64 0 }, ptr ${box}`,
    );
    if (!ref) return { box };
    const payload = B.slot();
    B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrBox, ptr ${box}, i32 0, i32 5`);
    // The immortal box is invisible to cycle tracing. Its one payload owner
    // is an ordinary external root, released at the original scope boundary.
    return { box, owner: { slot: payload, type } };
  }

  private nestedCaptures(fn: IrFunction): Set<string> {
    const cached = this.recaptured.get(fn.name);
    if (cached) return cached;
    const captures = new Set<string>();
    // eligible() already bounded this target's complete body traversal.
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (node) => {
        if (node.kind === "closure" || node.kind === "classRef") {
          for (const id of node.captures ?? []) captures.add(id);
        }
        return true;
      },
    });
    this.recaptured.set(fn.name, captures);
    return captures;
  }
}
