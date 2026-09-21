// Pin ToUint32 fast/slow boundaries and expression evaluation order.
// 140-bitwise-operators.ts covers every operator's JS edge semantics.
const values = [
  -9007199254740994, -9007199254740992, -9007199254740991,
  -4294967297, -4294967296, -2147483649, -2147483648.5,
  -1.9, -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE, 1.9,
  2147483647.5, 2147483648, 4294967295.5, 4294967296, 4294967297,
  9007199254740991, 9007199254740992, 9007199254740994,
  Number.MAX_VALUE, -Number.MAX_VALUE, NaN, Infinity, -Infinity,
];
for (const a of values) {
  for (const b of values) {
    console.log(a & b, a | b, a ^ b, a << b, a >> b, a >>> b, ~a);
    console.log(((a ^ b) << 5) >>> 0, (a >>> b) >> 1, ~~a);
  }
}

let calls = 0;
function next(value: number): number {
  calls++;
  console.log("operand", calls);
  return value;
}
console.log((next(-3.75) ^ next(2147483648)) >>> next(33), calls);
console.log(~next(-4294967297), calls);
let state = 3;
console.log(state++ ^ (state = 7), state);
console.log((state = -1) >>> state++, state);

function xorshift(seed: number, count: number): number {
  let value = seed >>> 0;
  for (let i = 0; i < count; i++) {
    value = (value ^ (value << 13)) >>> 0;
    value = (value ^ (value >>> 17)) >>> 0;
    value = (value ^ (value << 5)) >>> 0;
  }
  return value;
}
for (const seed of values) console.log(xorshift(seed, 1000));
