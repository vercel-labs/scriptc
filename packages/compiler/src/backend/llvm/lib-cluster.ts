import { InternalCompilerError } from "../../errors.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { abiValue, finishRuntimeCall } from "./lib-abi.js";

/** node:cluster (scr_cluster.c): the module's value reads and calls, one
 * C entry point each. The worker handle is a checked-dynamic value, so its
 * members dispatch through the runtime's handle ops and need no emission
 * here. */
export function emitClusterLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  // Cluster events, worker startup and the 'setup' emission are deferred
  // work: the program's main must enter the event loop even when nothing
  // else it does is asynchronous.
  host.usesTimers = true;
  const a = e.args.map((arg) => abiValue(host, host.emitExpr(arg)));
  switch (e.fn) {
    case "cluster.init":
      return finishRuntimeCall(host, e, "scr_cluster_init", []);
    case "cluster.isPrimary":
      return finishRuntimeCall(host, e, "scr_cluster_is_primary", []);
    case "cluster.isWorker":
      return finishRuntimeCall(host, e, "scr_cluster_is_worker", []);
    case "cluster.schedulingPolicy":
      return finishRuntimeCall(host, e, "scr_cluster_scheduling_policy", []);
    case "cluster.fork":
      return finishRuntimeCall(host, e, "scr_cluster_fork", [a[0]!]);
    case "cluster.setup":
      return finishRuntimeCall(host, e, "scr_cluster_setup", [a[0]!]);
    case "cluster.disconnect":
      return finishRuntimeCall(host, e, "scr_cluster_disconnect", [a[0]!]);
    case "cluster.settings":
      return finishRuntimeCall(host, e, "scr_cluster_settings", []);
    case "cluster.workers":
      return finishRuntimeCall(host, e, "scr_cluster_workers", []);
    case "cluster.worker":
      return finishRuntimeCall(host, e, "scr_cluster_worker_value", []);
    case "cluster.on":
      return finishRuntimeCall(host, e, "scr_cluster_on", [a[0]!, a[1]!, a[2]!]);
    case "cluster.off":
      return finishRuntimeCall(host, e, "scr_cluster_off", [a[0]!, a[1]!]);
    default:
      throw new InternalCompilerError(`llvm emitter bug: no cluster emission for ${e.fn}`);
  }
}
