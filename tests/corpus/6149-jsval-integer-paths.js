// Dynamic-tier `%` and bitwise operators take an integer path for small
// integral operands and keep JavaScript's exact results at every edge:
// negative zero, NaN, infinities, fractions, operands beyond 2^31 (ToInt32
// wraps them), and shift counts outside 0..31.
function dyn(value) {
  return value;
}

function show(label, value) {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

var values = dyn([0, -0, 1, -1, 7, -7, 2.5, -2.5, 3.9, -3.9, 2147483647, -2147483648,
  2147483648, -2147483649, 4294967295, 4294967296 + 5, 4.5e15 + 0.5, 9007199254740994, 1e18,
  -1e18, 9223372036854775807, 1e20, -1e20, NaN, Infinity, -Infinity]);
var divisors = dyn([1, -1, 3, -3, 0, -0, 2.5, 2147483648, NaN, Infinity]);
var shifts = dyn([0, 1, 31, 32, 33, -1, -33, 2.7]);

for (var i = 0; i < values.length; i++) {
  var x = values[i];
  var rem = [];
  for (var j = 0; j < divisors.length; j++) {
    var r = x % divisors[j];
    rem.push(Object.is(r, -0) ? "-0" : String(r));
  }
  show("rem " + x, rem.join(" "));
  var bits = [x | 0, x & 0xff, x ^ -1, x | 1, ~~x, x >>> 0];
  for (var k = 0; k < shifts.length; k++) bits.push(x << shifts[k], x >> shifts[k], x >>> shifts[k]);
  show("bits " + x, bits.join(" "));
}

// A loop whose accumulator stays an integer, then leaves the int32 range.
var h = dyn(0);
var codes = dyn([7, 1919, 65535, 251, 3]);
for (var round = 0; round < 1000; round++)
  for (var c = 0; c < codes.length; c++) h = ((h * 31) ^ codes[c]) | 0;
show("hash", h);
var acc = dyn(1);
for (var n = 0; n < 40; n++) acc = (acc * 3) % 4294967311;
show("big-mod", acc);
show("neg-rem-zero", dyn(-4) % 2);
show("neg-zero-rem", dyn(-0) % 5);
show("rem-neg-divisor", dyn(5) % -3);
show("min-int", dyn(-2147483648) % -1);
show("ushr-negative", dyn(-1) >>> 28);
