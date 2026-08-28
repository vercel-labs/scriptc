import "./a.ts";

console.log("b");
void import("./b.ts")
  .then(() => console.log("inner ok"))
  .catch(() => console.log("inner rejected"));
