// perf_hooks.constants: every name reads Node's value at the access site
// (the GC kind and flag numbers @types/node declares, plus the entry-type
// and milestone numbers the runtime object also carries), destructuring
// reads the same values, and the object itself walks the enumerable GC
// numbers in Node's insertion order through Object.keys, spread and
// JSON.stringify. The entry-type and milestone members are own but
// non-enumerable in Node, so a key walk does not list them. Writing a
// member throws in Node (the object's members are read-only), and the
// compiled program throws there too; only whether it threw is compared, as
// Node's TypeError and the compiler's refusal are different classes.
import { constants } from "node:perf_hooks";
import * as ph from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

console.log(
  "gc kinds",
  constants.NODE_PERFORMANCE_GC_MAJOR,
  constants.NODE_PERFORMANCE_GC_MINOR,
  constants.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP,
  constants.NODE_PERFORMANCE_GC_INCREMENTAL,
  constants.NODE_PERFORMANCE_GC_WEAKCB,
);
console.log(
  "gc flags",
  constants.NODE_PERFORMANCE_GC_FLAGS_NO,
  constants.NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED,
  constants.NODE_PERFORMANCE_GC_FLAGS_FORCED,
  constants.NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING,
  constants.NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE,
  constants.NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY,
  constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE,
);
console.log(
  "entry types",
  constants.NODE_PERFORMANCE_ENTRY_TYPE_GC,
  constants.NODE_PERFORMANCE_ENTRY_TYPE_HTTP,
  constants.NODE_PERFORMANCE_ENTRY_TYPE_HTTP2,
  constants.NODE_PERFORMANCE_ENTRY_TYPE_NET,
  constants.NODE_PERFORMANCE_ENTRY_TYPE_DNS,
  constants.NODE_PERFORMANCE_ENTRY_TYPE_QUIC,
);
console.log(
  "milestones",
  constants.NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP,
  constants.NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN,
  constants.NODE_PERFORMANCE_MILESTONE_ENVIRONMENT,
  constants.NODE_PERFORMANCE_MILESTONE_NODE_START,
  constants.NODE_PERFORMANCE_MILESTONE_V8_START,
  constants.NODE_PERFORMANCE_MILESTONE_LOOP_START,
  constants.NODE_PERFORMANCE_MILESTONE_LOOP_EXIT,
  constants.NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE,
);

const { NODE_PERFORMANCE_GC_MAJOR, NODE_PERFORMANCE_ENTRY_TYPE_DNS } = constants;
console.log("destructured", NODE_PERFORMANCE_GC_MAJOR, NODE_PERFORMANCE_ENTRY_TYPE_DNS);

let threw = false;
try {
  constants.NODE_PERFORMANCE_GC_MAJOR = 1;
} catch {
  threw = true;
}
console.log("write threw", threw, constants.NODE_PERFORMANCE_GC_MAJOR);

const held = constants;
console.log("keys", JSON.stringify(Object.keys(held)));
console.log("spread", JSON.stringify({ ...held }));
console.log("json", JSON.stringify(held));
console.log("identity", held === constants, typeof constants);
console.log("stored read", held.NODE_PERFORMANCE_GC_MINOR, held.NODE_PERFORMANCE_GC_FLAGS_NO);

const viaNamespace = ph.constants;
const viaRequire = require("node:perf_hooks").constants;
console.log("namespace", viaNamespace.NODE_PERFORMANCE_GC_MAJOR, ph.constants.NODE_PERFORMANCE_GC_WEAKCB);
console.log("require", viaRequire.NODE_PERFORMANCE_GC_FLAGS_FORCED);
console.log(
  "same value",
  JSON.stringify(viaNamespace) === JSON.stringify(constants),
  JSON.stringify(viaRequire) === JSON.stringify(constants),
);
