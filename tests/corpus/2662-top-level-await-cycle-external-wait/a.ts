import "./b.ts";

console.log("a:start");
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("a:end");
