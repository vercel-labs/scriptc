import "./main.ts";

console.log("b");
void import("./b.ts").then(() => console.log("b import ok"));
