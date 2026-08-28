import "./main.ts";

console.log("a");
void Promise.resolve().then(() => console.log("a micro"));
process.nextTick(() => console.log("a tick"));
