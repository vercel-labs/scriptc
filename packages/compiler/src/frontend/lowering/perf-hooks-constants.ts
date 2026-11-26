/* node:perf_hooks constants — the values Node v24.22.1 carries on the
 * perf_hooks.constants object, generated with
 *   node -p "require('perf_hooks').constants"
 * plus Object.getOwnPropertyNames/descriptors for the enumerability, and
 * baked as literals at every access site (the zlib.constants precedent).
 * The first table is the object's own enumerable properties, in its
 * insertion order (what Object.keys, spread and JSON.stringify observe on
 * the value form); the second table's names are own but non-enumerable,
 * so they answer a read by name and stay out of every key walk. */

export const PERF_HOOKS_CONSTANTS: Record<string, number> = {
  "NODE_PERFORMANCE_GC_MAJOR": 4,
  "NODE_PERFORMANCE_GC_MINOR": 1,
  "NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP": 2,
  "NODE_PERFORMANCE_GC_INCREMENTAL": 8,
  "NODE_PERFORMANCE_GC_WEAKCB": 16,
  "NODE_PERFORMANCE_GC_FLAGS_NO": 0,
  "NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED": 2,
  "NODE_PERFORMANCE_GC_FLAGS_FORCED": 4,
  "NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING": 8,
  "NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE": 16,
  "NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY": 32,
  "NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE": 64,
};

export const PERF_HOOKS_HIDDEN_CONSTANTS: Record<string, number> = {
  "NODE_PERFORMANCE_ENTRY_TYPE_GC": 0,
  "NODE_PERFORMANCE_ENTRY_TYPE_HTTP": 1,
  "NODE_PERFORMANCE_ENTRY_TYPE_HTTP2": 2,
  "NODE_PERFORMANCE_ENTRY_TYPE_NET": 3,
  "NODE_PERFORMANCE_ENTRY_TYPE_DNS": 4,
  "NODE_PERFORMANCE_ENTRY_TYPE_QUIC": 5,
  "NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP": 0,
  "NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN": 1,
  "NODE_PERFORMANCE_MILESTONE_ENVIRONMENT": 2,
  "NODE_PERFORMANCE_MILESTONE_NODE_START": 3,
  "NODE_PERFORMANCE_MILESTONE_V8_START": 4,
  "NODE_PERFORMANCE_MILESTONE_LOOP_START": 5,
  "NODE_PERFORMANCE_MILESTONE_LOOP_EXIT": 6,
  "NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE": 7,
};
