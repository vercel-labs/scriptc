// Math members print the values Node prints, the transcendentals
// included: they are V8's fdlibm functions.
console.log(Math.floor(7.6), Math.ceil(7.2), Math.round(7.5), Math.round(-7.5), Math.trunc(-7.9));
console.log(Math.abs(-3.5), Math.sign(-12), Math.sign(0), Math.sign(4.2));
console.log(Math.sqrt(144), Math.sqrt(2), Math.pow(2, 10), Math.pow(2, 0.5));
console.log(Math.hypot(3, 4), Math.min(2, -9), Math.max(2, -9));
console.log(Math.log2(1024), Math.log10(100000), Math.exp(0), Math.log(1));
console.log(Math.PI, Math.E);
console.log(Math.cbrt(27), Math.exp(1), Math.log(10));
console.log(Math.sin(1), Math.cos(1), Math.tan(1));
console.log(Math.asin(0.5), Math.acos(0.5));
console.log(Math.atan(1), Math.atan2(1, 1), Math.atan2(-1, -1));
// Math results chain into static arithmetic like any number.
const area = Math.PI * Math.pow(2, 2);
console.log(area.toFixed(6), Math.floor(area) + 1);
// Non-finite results.
console.log(Math.log(0), Math.log(-1), Math.sqrt(-1), Math.pow(0, -1));
