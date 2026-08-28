// @dynamic
// @exit: 13
console.log("before self import");
await import("./2650-top-level-await-self-import.ts");
console.log("unreachable");

export {};
