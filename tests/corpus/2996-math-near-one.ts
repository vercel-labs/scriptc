const nan = 0 / 0;
console.log(Math.expm1(0), 1 / Math.expm1(-0), Math.expm1(Infinity), Math.expm1(-Infinity), Math.expm1(nan));
console.log(Math.log1p(0), 1 / Math.log1p(-0), Math.log1p(-1), Math.log1p(-2), Math.log1p(Infinity), Math.log1p(nan));
console.log(Math.expm1(1).toFixed(9), Math.expm1(-1).toFixed(9), Math.log1p(1).toFixed(9), Math.log1p(-0.5).toFixed(9));
const tiny = 1e-16;
console.log(Math.expm1(tiny) > 0, Math.abs(Math.expm1(tiny) - tiny) < 1e-30);
console.log(Math.log1p(tiny) > 0, Math.abs(Math.log1p(tiny) - tiny) < 1e-30);
console.log(Math.log1p(-tiny) < 0, Math.abs(Math.log1p(-tiny) + tiny) < 1e-30);
let order = "";
function input(label: string, value: number): number { order += label; return value; }
console.log(Math.expm1(input("e", 0)), Math.log1p(input("l", 0)), order);
