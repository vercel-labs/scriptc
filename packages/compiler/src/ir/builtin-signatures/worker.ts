import { BOOL, DYN, F64, STRING, SYMBOL_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The worker builtin call slots. */
export const workerSignatures = defineLibFnSignatures({
  "worker.new": { argTypes: [F64, STRING, DYN], result: DYN },
  "worker.isMainThread": { argTypes: [], result: BOOL },
  "worker.threadId": { argTypes: [], result: F64 },
  "worker.root": { argTypes: [], result: F64 },
  "worker.data": { argTypes: [], result: DYN },
  "worker.parentPort": { argTypes: [], result: DYN },
  /** worker_threads.SHARE_ENV: the env option's share marker symbol
   * (scr_worker_events.c). */
  "worker.shareEnv": { argTypes: [], result: SYMBOL_T },
  /** worker_threads.resourceLimits: {} in the main thread; a refusal in a
   * worker (scr_worker_events.c). */
  "worker.resourceLimits": { argTypes: [], result: DYN },
  /** worker_threads.threadName: the Worker's name in a worker, "" in the
   * main thread (scr_worker.c). */
  "worker.threadName": { argTypes: [], result: DYN },
  /** worker.performance: the Worker's { eventLoopUtilization } object
   * (scr_worker_events.c; the receiver is its Worker handle). */
  "worker.performance": { argTypes: [DYN], result: DYN },
  /** new MessageChannel() ({ port1, port2 }) and receiveMessageOnPort(port)
   * (scr_worker_events.c; the latter may throw). */
  "worker.channel": { argTypes: [], result: DYN },
  "worker.portConstruct": { argTypes: [DYN], result: DYN },
  "worker.receiveMessageOnPort": { argTypes: [DYN], result: DYN },
  /** setEnvironmentData(key, value) and getEnvironmentData(key)
   * (scr_worker_events.c; arguments borrowed). */
  "worker.setEnvironmentData": { argTypes: [DYN, DYN], result: VOID },
  "worker.getEnvironmentData": { argTypes: [DYN], result: DYN },
  /** markAsUntransferable(value) and isMarkedAsUntransferable(value)
   * (scr_worker_events.c; the value borrowed). */
  "worker.markUntransferable": { argTypes: [DYN], result: VOID },
  "worker.isMarkedUntransferable": { argTypes: [DYN], result: BOOL },
  /** new BroadcastChannel(...args) (scr_worker_events.c; may throw), after
   * event.broadcastInstall, which installs its EventTarget side. */
  "worker.broadcastChannel": { argTypes: [DYN], result: DYN },
});
