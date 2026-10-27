// `instanceof` against the primitive wrapper constructors (Boolean, Number,
// String, BigInt, Symbol), as typebox's value guards test: false for
// primitives and for every object, and the operand still evaluates.
function IsBoolean(value) {
  return value instanceof Boolean;
}
function IsNumber(value) {
  return value instanceof Number;
}
function IsString(value) {
  return value instanceof String;
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
const values = [true, 1, "s", 2n, Symbol("k"), null, undefined, new Uint8Array(2), {}, [], () => 1, new Date(0)];
for (const v of values)
  console.log(typeof v, IsBoolean(v), IsNumber(v), IsString(v), IsUint8Array(v), v instanceof BigInt, v instanceof Symbol);
let calls = 0;
const next = () => {
  calls++;
  return { n: calls };
};
console.log(next() instanceof Number, next() instanceof globalThis.String, calls);
