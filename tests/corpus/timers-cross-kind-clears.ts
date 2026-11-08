// clearTimeout of an Immediate and clearImmediate of a Timeout clear
// nothing, like Node, even when both were created before either ran: each
// handle number names one object, not a timeout and an immediate at once.
const keptTimeout = setTimeout(() => console.log("timeout kept"), 20);
const keptImmediate = setImmediate(() => console.log("immediate kept"));
clearTimeout(keptImmediate as unknown as ReturnType<typeof setTimeout>);
clearImmediate(keptTimeout as unknown as ReturnType<typeof setImmediate>);
console.log("cleared");

// The same pair in the other creation order.
const laterImmediate = setImmediate(() => console.log("later immediate kept"));
const laterTimeout = setTimeout(() => console.log("later timeout kept"), 10);
clearImmediate(laterTimeout as unknown as ReturnType<typeof setImmediate>);
clearTimeout(laterImmediate as unknown as ReturnType<typeof setTimeout>);

// Each clear function still clears its own kind.
const clearedTimeout = setTimeout(() => console.log("NOT REACHED timeout"));
const clearedImmediate = setImmediate(() => console.log("NOT REACHED immediate"));
clearTimeout(clearedTimeout);
clearImmediate(clearedImmediate);
