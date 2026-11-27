// process.emit('<signal>') dispatches the signal's listeners synchronously,
// as Node's EventEmitter emit does: registration order, a once listener
// leaves before it runs, and the return value says whether any existed.
let calls = 0;
const onTerm = () => {
  calls += 1;
  console.log("listener", calls);
};
process.on("SIGTSTP", onTerm);
console.log(process.emit("SIGTSTP"));
console.log(process.emit("SIGTSTP"));
process.off("SIGTSTP", onTerm);
console.log(process.emit("SIGTSTP"));

let once = 0;
process.once("SIGHUP", () => {
  once += 1;
  console.log("once", once);
});
console.log(process.emit("SIGHUP"));
console.log(process.emit("SIGHUP"));
console.log(process.emit("SIGUSR1"));
