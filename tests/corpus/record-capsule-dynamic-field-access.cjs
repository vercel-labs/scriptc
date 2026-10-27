"use strict";
// Records built by an object literal and reached by dynamic-tier code: their
// declared fields read and write through the record, while other types,
// undeclared and absent keys, and frozen records keep JavaScript semantics.
function makeTask(node, childIndex) {
  return { node: node, childIndex: childIndex, keyPath: null, done: false };
}
function step(task, i) {
  task.childIndex = i;
  task.keyPath = [task.node, i];
  return task.childIndex + ":" + task.keyPath.join("/") + ":" + task.done;
}
const tasks = [makeTask("a", 0), makeTask("b", 1)];
for (let i = 0; i < 3; i++) for (const t of tasks) console.log(step(t, i));
// A value of another type, an undeclared key, and an absent key.
tasks[0].childIndex = "seven";
tasks[0].extra = 1;
console.log(tasks[0].childIndex, tasks[0].extra, tasks[0].missing, Object.keys(tasks[0]).join(","));
// A frozen record refuses the write in strict mode.
const frozen = Object.freeze(makeTask("f", 9));
try {
  step(frozen, 1);
} catch (e) {
  console.log(e instanceof TypeError, frozen.childIndex);
}
