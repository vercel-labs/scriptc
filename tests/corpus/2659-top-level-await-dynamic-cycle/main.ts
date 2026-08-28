// @dynamic
// @exit: 13
console.log("before dynamic cycle");
await import("./late.ts");
console.log("unreachable");

export {};
