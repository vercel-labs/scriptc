// The DSP-oriented scalar Math surface compiles without the dynamic engine.
// Transcendentals print at a precision that is stable across V8's fdlibm and
// the target libc while fround and the constants pin exact JavaScript values.
console.log(
  Math.sin(1).toFixed(9),
  Math.cos(1).toFixed(9),
  Math.sqrt(2).toFixed(9),
  Math.exp(1).toFixed(9),
  Math.log(10).toFixed(9),
  Math.pow(2, 0.5).toFixed(9),
);
console.log(Math.PI.toFixed(12), Math.E.toFixed(12));
console.log(Math.fround(1 / 3), Math.fround(16777217), 1 / Math.fround(-0));
console.log(Math.sqrt(-1), Math.log(0), Math.pow(0, -1));
