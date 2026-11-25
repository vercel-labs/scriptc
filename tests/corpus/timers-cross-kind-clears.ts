// clearTimeout of an Immediate and clearImmediate of a Timeout clear
// nothing, like Node, even when both were created before either ran: each
// handle number names one object, not a timeout and an immediate at once.
//
// The order of the lines does not depend on how long the process is held
// up. The later timeout has the longer delay, so it expires later however
// much time passes between the two calls. And a timeout prints from an
// immediate it queues: when the script took so long that the timeout is due
// in the loop's first turn, its callback runs before the script's
// immediates, and the immediate it queues runs after them in that turn.
function afterImmediates(line: string): () => void {
  return () => {
    setImmediate(() => console.log(line));
  };
}
const keptTimeout = setTimeout(afterImmediates("timeout kept"), 10);
const keptImmediate = setImmediate(() => console.log("immediate kept"));
clearTimeout(keptImmediate as unknown as ReturnType<typeof setTimeout>);
clearImmediate(keptTimeout as unknown as ReturnType<typeof setImmediate>);
console.log("cleared");

// The same pair in the other creation order.
const laterImmediate = setImmediate(() => console.log("later immediate kept"));
const laterTimeout = setTimeout(afterImmediates("later timeout kept"), 20);
clearImmediate(laterTimeout as unknown as ReturnType<typeof setImmediate>);
clearTimeout(laterImmediate as unknown as ReturnType<typeof setTimeout>);

// Each clear function still clears its own kind.
const clearedTimeout = setTimeout(() => console.log("NOT REACHED timeout"));
const clearedImmediate = setImmediate(() => console.log("NOT REACHED immediate"));
clearTimeout(clearedTimeout);
clearImmediate(clearedImmediate);
