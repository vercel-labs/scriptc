// EventEmitter's emit dispatches a SNAPSHOT of the listener list. Removing
// a later listener during that dispatch does not cancel its pending call,
// and a once wrapper skips only after it fired itself (Node's `fired`
// flag), not because its registration is gone. A nested emit that already
// fired the once entry is the one case the outer snapshot must skip.

const order = [];

// Once listener removed by an earlier listener in the same dispatch.
function removeLate() {
  order.push("remove");
  process.off("SIGTSTP", late);
}
function late() {
  order.push("late");
}
process.on("SIGTSTP", removeLate);
process.once("SIGTSTP", late);
process.emit("SIGTSTP");
console.log("removed:", order.join(","));

// The once listener first, removed by a later listener after it ran.
order.length = 0;
function after() {
  order.push("after");
  process.off("SIGUSR1", early);
}
function early() {
  order.push("early");
}
process.once("SIGUSR1", early);
process.on("SIGUSR1", after);
process.emit("SIGUSR1");
console.log("ran:", order.join(","));

// A nested emit fires the later once entry; the outer snapshot is a no-op.
order.length = 0;
let nested = false;
process.on("SIGUSR2", () => {
  order.push("outer");
  if (!nested) {
    nested = true;
    process.emit("SIGUSR2");
  }
});
process.once("SIGUSR2", () => {
  order.push("once");
});
process.emit("SIGUSR2");
console.log("nested:", order.join(","));

// A once listener re-added by the callback survives for the next emit.
order.length = 0;
let reentered = false;
function readd() {
  order.push("readd");
  if (!reentered) {
    reentered = true;
    process.once("SIGHUP", readd);
  }
}
process.once("SIGHUP", readd);
process.emit("SIGHUP");
process.emit("SIGHUP");
console.log("readd:", order.join(","));
