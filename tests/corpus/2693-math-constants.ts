// Math.PI and Math.E are compile-time numeric constants: they remain usable
// in static arithmetic and through static number operations.
const pi = Math.PI;
const e = Math.E;

console.log(Math.PI, Math.E);
console.log(pi + e, pi - e, -pi, -e);
console.log(Math.PI * 2, Math.E * 2);
console.log(pi.toFixed(6), e.toFixed(6));
console.log(Math.PI, Math.PI, Math.E, Math.E);
