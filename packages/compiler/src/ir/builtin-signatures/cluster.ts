import { BOOL, DYN, F64, VOID, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The cluster builtin call slots. */
export const clusterSignatures = defineLibFnSignatures({
  /** node:cluster (scr_cluster.c). The module's reads are runtime values
   * (a compiled program can be either a primary or a worker), fork
   * answers the worker handle, and the cluster object's events take a
   * checked-dynamic listener. */
  "cluster.init": { argTypes: [], result: VOID },
  "cluster.isPrimary": { argTypes: [], result: BOOL },
  "cluster.isWorker": { argTypes: [], result: BOOL },
  "cluster.schedulingPolicy": { argTypes: [], result: F64 },
  "cluster.fork": { argTypes: [DYN], result: DYN },
  "cluster.setup": { argTypes: [DYN], result: VOID },
  "cluster.disconnect": { argTypes: [DYN], result: VOID },
  "cluster.settings": { argTypes: [], result: DYN },
  "cluster.workers": { argTypes: [], result: DYN },
  "cluster.worker": { argTypes: [], result: DYN },
  "cluster.on": { argTypes: [STRING, DYN, BOOL], result: VOID },
  "cluster.off": { argTypes: [STRING, DYN], result: VOID },
});
