const nan = 0 / 0;
console.log(Math.clz32(0), Math.clz32(-0), Math.clz32(1), Math.clz32(2), Math.clz32(0x80000000), Math.clz32(0xffffffff));
console.log(Math.clz32(-1), Math.clz32(0xffffffff + 1), Math.clz32(1.9), Math.clz32(Infinity), Math.clz32(nan));
console.log(Math.clz32(2 ** 53 + 2), Math.clz32(1e308), Math.clz32(-(2 ** 53 + 2)));
console.log(Math.imul(2, 3), Math.imul(-1, 5), Math.imul(0xffffffff, 5), Math.imul(0x7fffffff, 2));
console.log(Math.imul(-1, 0xffffffff), Math.imul(1.9, 2.9), Math.imul(Infinity, 5), Math.imul(nan, 5));
console.log(Math.imul(2 ** 53 + 2, -3), Math.imul(-(2 ** 53 + 2), 3), Math.imul(1e308, 7));
console.log(Math.fround(0), 1 / Math.fround(-0), Math.fround(Infinity), Math.fround(-Infinity), Math.fround(nan));
console.log(Math.fround(1 + 2 ** -24), Math.fround(1 + 2 ** -23), Math.fround(16777217), Math.fround(-5e-324));
console.log(Math.fround(3.402823669209385e38) === Infinity, Math.fround(-3.402823669209385e38) === -Infinity);
let order = "";
function input(label: string, value: number): number { order += label; return value; }
console.log(Math.clz32(input("c", 1)), Math.imul(input("a", 2), input("b", 3)), Math.fround(input("f", 1.5)), order);
