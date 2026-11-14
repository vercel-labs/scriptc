// os.cpus() read the way untyped JavaScript reads it: the array and each
// row are ordinary objects. Rows carry { model, speed, times: { user,
// nice, sys, idle, irq } } in Node's key order, every row reads its own
// fields after an intermediate binding, Array methods over the snapshot
// see both fields and times, and every call answers a fresh snapshot the
// program may change without changing the next one.
const os = require("node:os");

const list = os.cpus();
console.log("count", list.length > 0, Array.isArray(list));
const first = list[0];
console.log("keys", Object.keys(first).join(","));
console.log("times keys", Object.keys(first.times).join(","));
console.log(
  "types",
  typeof first.model,
  typeof first.speed,
  typeof first.times.user,
  typeof first.times.irq,
);
console.log(
  "invariants",
  first.model.length >= 0 &&
    Number.isInteger(first.speed) &&
    first.speed >= 0 &&
    ["user", "nice", "sys", "idle", "irq"].every(
      (name) => Number.isInteger(first.times[name]) && first.times[name] >= 0,
    ),
);

// The untyped access patterns: an index off a stored snapshot, a map over
// the array, a for-of loop and a destructuring pattern.
console.log("indexed", list[0].times.user >= 0, list[list.length - 1].times.idle >= 0);
const users = list.map((cpu) => cpu.times.user);
console.log("map", users.length === list.length, users.every((v) => v >= 0));
let looped = 0;
for (const cpu of list) {
  if (cpu.times.sys >= 0 && cpu.model.length >= 0) looped += 1;
}
console.log("for-of", looped === list.length);
const { times } = first;
console.log("destructured", times.nice >= 0, typeof times.sys);

// Each call takes a new snapshot: the rows are fresh objects the program
// can change, and the next call answers the machine's data again. CPU
// times are live cumulative counters, so two snapshots are compared for
// shape and monotonic growth — the user time of a CPU never decreases —
// never for exact equality.
const second = os.cpus();
console.log("fresh", second !== list, second[0] !== first);
const usersBefore = second.map((cpu) => cpu.times.user);
second[0].model = "changed";
second[0].times.user = -1;
const third = os.cpus();
const shared = Math.min(second.length, third.length);
let monotonic = shared > 0;
for (let i = 0; i < shared; i++) {
  if (!Number.isInteger(third[i].times.user) || third[i].times.user < usersBefore[i]) monotonic = false;
}
console.log(
  "independent",
  third[0] !== second[0],
  third[0].model !== "changed",
  monotonic,
);
