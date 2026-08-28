import "./b.ts";

console.log("a:start");
await Promise.resolve();
console.log("a:reject");
throw new Error("cycle failed");
