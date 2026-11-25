console.log("tla.mjs evaluating");
await new Promise((r) => setTimeout(r, 5));
console.log("tla.mjs resumed");
export const ready = true;
