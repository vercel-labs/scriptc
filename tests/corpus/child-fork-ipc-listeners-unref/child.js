// With every IPC listener removed the channel unrefs, so a child with no
// other work exits instead of waiting on it.
const listener = () => {};
process.on("message", listener);
process.off("message", listener);
