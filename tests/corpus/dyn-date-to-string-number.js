// A Date whose own toString returns a number still converts: ToPrimitive
// takes the number as the primitive and ToString renders it. The handle's
// string conversion keeps that answer instead of reading it as a string.
const d = new Date(0);
d.toString = function () {
  return 42;
};

console.log("String:", String(d));
console.log("concat:", "value=" + d);
