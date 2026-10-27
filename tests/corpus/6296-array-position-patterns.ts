// Object patterns over arrays that name positions and `length` (jose's
// `const { 0: header, 1: payload, 2: signature, length } = jws.split(".")`):
// each position is the element or undefined past the end, defaults apply
// to missing positions, and `length` is the array's length.
const { 0: header, 1: payload, 2: signature, length } = "aaa.bbb.ccc".split(".");
console.log(header, payload, signature, length);

const short = "aaa.bbb".split(".");
const { 0: first, 2: third, length: count } = short;
console.log(first, third === undefined, count);

const { 1: second = "fallback", 3: fourth = "missing" } = short;
console.log(second, fourth);

function parts(values: number[]): string {
  const { 0: a, 1: b, length: n } = values;
  return `${a}:${b}:${n}`;
}
console.log(parts([1, 2, 3]), parts([7]));

let renamed = "";
for (const { 0: key, 1: value } of [["x", "1"], ["y", "2"]]) renamed += `${key}=${value};`;
console.log(renamed);
