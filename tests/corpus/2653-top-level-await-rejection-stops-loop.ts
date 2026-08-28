// @exit: 1
console.log("before rejection");

setTimeout(() => console.log("late timer"), 10);
await Promise.reject(new Error("top-level stops loop"));

export {};
