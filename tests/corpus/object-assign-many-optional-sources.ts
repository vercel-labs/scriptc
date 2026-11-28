// Object.assign into an index-signature record with 30 optional sources:
// each source is a Record | undefined whose value arrives at run time, so
// the merge must stay linear in the compiler (a ternary over the
// accumulated expression would double it per optional source). Node is
// the oracle.
type Input = { type: "string" | "array" | "boolean" };
const target: Record<string, Input> = {};
function maybe(i: number): Record<string, Input> | undefined {
  if (i % 3 === 2) return undefined;
  const out: Record<string, Input> = {};
  out["k" + String(i)] = { type: "string" };
  return out;
}
Object.assign(target, maybe(0), maybe(1), maybe(2), maybe(3), maybe(4), maybe(5), maybe(6), maybe(7), maybe(8), maybe(9), maybe(10), maybe(11), maybe(12), maybe(13), maybe(14), maybe(15), maybe(16), maybe(17), maybe(18), maybe(19), maybe(20), maybe(21), maybe(22), maybe(23), maybe(24), maybe(25), maybe(26), maybe(27), maybe(28), maybe(29));
console.log(Object.keys(target).length);
console.log(Object.keys(target).join(","));
