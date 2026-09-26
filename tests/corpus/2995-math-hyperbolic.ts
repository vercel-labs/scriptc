const nan = 0 / 0;
console.log(Math.sinh(0), 1 / Math.sinh(-0), Math.sinh(Infinity), Math.sinh(-Infinity), Math.sinh(nan));
console.log(Math.cosh(0), Math.cosh(-0), Math.cosh(Infinity), Math.cosh(-Infinity), Math.cosh(nan));
console.log(Math.tanh(0), 1 / Math.tanh(-0), Math.tanh(Infinity), Math.tanh(-Infinity), Math.tanh(nan));
console.log(Math.asinh(0), 1 / Math.asinh(-0), Math.asinh(Infinity), Math.asinh(-Infinity), Math.asinh(nan));
console.log(Math.acosh(1), Math.acosh(0), Math.acosh(-1), Math.acosh(Infinity), Math.acosh(nan));
console.log(Math.atanh(0), 1 / Math.atanh(-0), Math.atanh(1), Math.atanh(-1), Math.atanh(2), Math.atanh(nan));
console.log(Math.sinh(1).toFixed(9), Math.cosh(1).toFixed(9), Math.tanh(1).toFixed(9));
console.log(Math.asinh(1).toFixed(9), Math.acosh(2).toFixed(9), Math.atanh(0.5).toFixed(9));
const tiny = 1e-12;
console.log(Math.abs(Math.sinh(tiny) - tiny) < 1e-23, Math.abs(Math.asinh(tiny) - tiny) < 1e-23, Math.abs(Math.atanh(tiny) - tiny) < 1e-23);
let order = "";
function input(label: string, value: number): number { order += label; return value; }
console.log(Math.sinh(input("s", 0)), Math.acosh(input("c", 1)), Math.atanh(input("t", 0)), order);
