// os.getPriority's pid is Node's default parameter: an undefined pid
// selects the current process (pid 0) and still runs the query — it is not
// a constant — while the argument expression itself runs, and arguments
// past the pid evaluate after it. The probe below changes only the nice
// value this process already may change unprivileged.
const os = require("node:os");

console.log("query", os.getPriority(undefined) === os.getPriority(0));

// Undefined runs the query rather than answering a constant zero: the
// process's own nice value changes, and the new value shows through it.
// Lowering the priority (a larger nice value) is always permitted, and the
// original is not restored — raising the priority back needs a privilege an
// unprivileged runner does not have.
const prior = os.getPriority();
const lowered = prior < 19 ? prior + 1 : prior;
os.setPriority(0, lowered);
console.log("query runs", os.getPriority(undefined), os.getPriority(undefined) === lowered);
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
