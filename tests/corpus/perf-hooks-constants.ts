// perf_hooks.constants through the declared types: the GC kind and flag
// numbers @types/node names read as their Node v24 values, a destructured
// binding reads the same, and the object keeps the declarations' type when
// it is held in a variable, so its members still read the same numbers.
import { constants } from "node:perf_hooks";
import * as ph from "node:perf_hooks";

const major: number = constants.NODE_PERFORMANCE_GC_MAJOR;
const flags: number = constants.NODE_PERFORMANCE_GC_FLAGS_FORCED;
const { NODE_PERFORMANCE_GC_MINOR, NODE_PERFORMANCE_GC_WEAKCB } = constants;
const held: typeof constants = constants;
console.log(
  "values",
  major,
  flags,
  NODE_PERFORMANCE_GC_MINOR,
  NODE_PERFORMANCE_GC_WEAKCB,
  held.NODE_PERFORMANCE_GC_INCREMENTAL,
);
console.log("namespace", ph.constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE);
console.log("keys", JSON.stringify(Object.keys(held)));
