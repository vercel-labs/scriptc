// os.getPriority's pid is Node's default parameter: an undefined pid
// selects the current process (pid 0) and still runs the query — it is not
// a constant — while the argument expression itself runs, and arguments
// past the pid evaluate after it.
const os = require("node:os");

console.log("query", os.getPriority(undefined) === os.getPriority(0));

// Undefined runs the query rather than answering a constant zero: raising
// this process's own priority is visible through it.
const prior = os.getPriority();
const raised = prior < 19 ? prior + 1 : prior;
os.setPriority(0, raised);
console.log("query runs", os.getPriority(undefined), os.getPriority(undefined) === raised);
os.setPriority(0, prior);
console.log("omitted", os.getPriority() === os.getPriority(0));
console.log("named", os.getPriority(process.pid) === os.getPriority());
console.log("same", os.getPriority(undefined) === os.getPriority());

const order = [];
const note = (tag) => {
  order.push(tag);
};
console.log("effect", os.getPriority(note("pid")) === os.getPriority(0), order.join(","));

// @ts-expect-error -- getPriority reads only the pid
const surplus = os.getPriority(undefined, note("extra"), 7);
console.log("surplus", surplus === os.getPriority(0), order.join(","));

// @ts-expect-error -- the pid stays undefined; the extra still runs
const second = os.getPriority(undefined, note("second"));
console.log("surplus-only", second === os.getPriority(0), order.join(","));
