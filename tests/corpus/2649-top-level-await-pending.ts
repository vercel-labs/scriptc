// @exit: 13
console.log("before pending");
await new Promise<void>(() => {});
console.log("unreachable");

export {};
