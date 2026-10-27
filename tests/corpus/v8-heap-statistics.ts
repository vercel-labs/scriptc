// node:v8 is importable. getHeapStatistics answers allocator-derived
// figures in Node's shape and key order; the values are approximate (no
// V8 heap exists in a compiled binary), so this pins the shape and the
// relations between fields, not the numbers.
import * as v8 from "node:v8";

const warm: string[] = [];
for (let i = 0; i < 1000; i++) warm.push("item " + i);

const stats = v8.getHeapStatistics();
console.log(Object.keys(stats).join(","));
console.log(Object.values(stats).every((value) => typeof value === "number"));
console.log(stats.used_heap_size <= stats.total_heap_size);
console.log(stats.heap_size_limit > 0, stats.total_available_size <= stats.heap_size_limit);
console.log(stats.does_zap_garbage === 0 || stats.does_zap_garbage === 1);
console.log(stats.number_of_native_contexts >= 1, warm.length);
