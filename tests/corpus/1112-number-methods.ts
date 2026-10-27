// Number.prototype.toFixed, toPrecision and toString(radix) on typed
// numbers all compile statically and stay byte-exact differential.
const n = 1234.5678;
console.log(n.toFixed(0), n.toFixed(2), n.toFixed(6));
console.log((0.1 + 0.2).toFixed(17), (-3.7).toFixed(1), (0).toFixed(2));
console.log((1e21).toFixed(2), (0 / 0).toFixed(2));
console.log(n.toPrecision(2), n.toPrecision(8), (0.000123).toPrecision(2));
console.log((255).toString(16), (255).toString(2), (511).toString(8), (12345).toString(36));
console.log((-255).toString(16), (0.5).toString(2));
const digits = 3;
console.log(Math.PI.toFixed(digits));
// Results are ordinary static strings: length, concat, further island calls.
const hex = (48879).toString(16);
console.log(hex.length, hex.toUpperCase(), "0x" + hex);
