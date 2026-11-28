// Promise.allSettled over a checked-dynamic input (an any-typed array):
// Node iterates at run time, so fulfilled values and rejection reasons both
// land in the settled records in input order. Node is the oracle.
const inputs: any = [
  Promise.resolve("a"),
  Promise.reject(new Error("boom")),
  Promise.resolve("c"),
];
const settled = await Promise.allSettled(inputs);
for (const entry of settled) {
  if (entry.status === "fulfilled") console.log("fulfilled", entry.value);
  else console.log("rejected", String(entry.reason));
}
console.log("count:", settled.length);
