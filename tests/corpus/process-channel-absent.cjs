// process.channel in a process that never had an IPC channel is undefined
// (not null — null means a channel that went away), and process.connected
// is false. The absent channel has no ref/unref to call.
console.log("typeof", typeof process.channel, "undefined", process.channel === undefined);
console.log("connected", process.connected);
console.log("null", process.channel === null);
