// typeof of a Node 24 global member through the global object is a read of
// the global (SC2020, host-global): Node has FormData, native code does not.
console.log(typeof (globalThis as Record<string, unknown>).FormData);
