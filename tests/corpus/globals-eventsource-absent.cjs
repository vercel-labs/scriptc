// Node 24 defines the EventSource global only when the process starts with
// --experimental-eventsource (the globals chapter marks it "Enable this API
// with --experimental-eventsource"), so a default Node process and a scriptc
// binary agree that the name is absent.
console.log(typeof EventSource, globalThis.EventSource === undefined);
console.log("EventSource" in globalThis);
