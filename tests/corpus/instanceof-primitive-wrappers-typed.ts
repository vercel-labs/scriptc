// Typed operands tested against the primitive wrapper constructors: always
// false, with the operand's side effects kept.
let reads = 0;
function pick(n: number): unknown {
  reads++;
  return n === 0 ? "text" : n === 1 ? 7 : n === 2 ? { ok: true } : [n];
}
const seen: string[] = [];
for (let i = 0; i < 4; i++) {
  const value = pick(i);
  seen.push(`${value instanceof String}/${value instanceof Number}/${value instanceof Boolean}`);
}
const record: object = { a: 1 };
console.log(seen.join(" "), record instanceof Object, record instanceof String, reads);
