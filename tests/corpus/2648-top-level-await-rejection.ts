// @exit: 1
console.log("before rejection");
await Promise.reject(new Error("top-level boom"));
console.log("unreachable");

export {};
