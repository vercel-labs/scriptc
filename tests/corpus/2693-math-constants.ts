// Standard Math constants remain usable in static arithmetic and number operations.
const pi = Math.PI;
const e = Math.E;

console.log(Math.E, Math.LN10, Math.LN2, Math.LOG10E, Math.LOG2E, Math.PI, Math.SQRT1_2, Math.SQRT2);
console.log(pi + e, pi - e, -pi, -e);
console.log(Math.PI * 2, Math.E * 2);
console.log(pi.toFixed(6), e.toFixed(6));
console.log(Math.PI, Math.PI, Math.E, Math.E);
console.log(Math.LN10.toFixed(12), Math.LN2.toFixed(12), Math.LOG10E.toFixed(12), Math.LOG2E.toFixed(12));
console.log(Math.SQRT1_2.toFixed(12), Math.SQRT2.toFixed(12), Math.SQRT1_2 * Math.SQRT2);
