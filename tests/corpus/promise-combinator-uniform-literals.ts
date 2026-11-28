// A uniform promise array literal keeps the specialised combinator lowering:
// Promise.all returns the values array and Promise.allSettled the settled
// records, both in input order. (The checker types such a literal by the
// tuple overload; an unannotated binding to the allSettled result hits the
// unrelated tuple-conversion boundary, so the settled result is annotated as
// the array it is.) Node is the oracle.
const all = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
console.log(all.join(","));

const settled: PromiseSettledResult<string>[] = await Promise.allSettled([
  Promise.resolve("x"),
  Promise.reject(new Error("boom")),
]);
console.log(settled.map((entry) => entry.status).join(","));

const values = await Promise.all([Promise.resolve(10), Promise.resolve(20)]);
console.log(values.reduce((sum, value) => sum + value, 0));
