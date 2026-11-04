// Module-level numeric tables large enough to keep their elements in the
// program image (ir/constant-tables.ts): the array neither allocates nor
// copies, and reads must see the same values, holes and edge cases as an
// ordinary literal array. The table and its header are written entirely at
// emission time, including NaN, the infinities, negative zero and the
// smallest double.

const widths = [
  3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4, 3, 3, 8, 3, 2, 7, 9, 5,
  0, 2, 8, 8, 4, 1, 9, 7, 1, 6, 9, 3,
];

function widthAt(i: number): number {
  return widths[i] * 1;
}

console.log(
  "widths",
  widths.length,
  widthAt(0),
  widthAt(13),
  widthAt(43),
  widthAt(-1),
  widthAt(0.5),
  widthAt(43.5),
  widthAt(widths.length),
  widthAt(NaN),
  widthAt(Infinity),
  widthAt(4294967295),
  widths[100],
);

// Summing the table by index stays exact for int32 values.
let sum = 0;
for (let i = 0; i < widths.length; i++) sum += widths[i] * 1;
console.log("sum", sum);

const signed = [
  -2147483648, 2147483647, -1, 0, 1, -0.5, 2.5, -3.75, 1e21, 1e-7, -1e21, 123456789, 0.1, 0.2, 0.3,
  -0, 5e-324, 1.7976931348623157e308, Infinity, -Infinity, NaN,
];

function signedAt(i: number): string {
  const value = signed[i];
  return value === undefined ? "missing" : `${value} ${1 / value}`;
}

console.log(
  "signed",
  signed.length,
  signedAt(0),
  signedAt(1),
  signedAt(15),
  signedAt(17),
  signedAt(19),
  signedAt(20),
  signedAt(21),
  `${signed[16]}`,
);

// Nested reads see the same elements.
function nested(i: number): number {
  return widths[widths[i] * 1] * 10;
}
console.log("nested", nested(0), nested(5), nested(40));

// A table that escapes to dynamic code through a spread keeps the ordinary
// construction; the copy and the original agree.
const scaled = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
const copy = [...scaled];
copy[3] = 99;
console.log("copy", scaled.length, copy.length, scaled[3], copy[3], scaled[17], copy[17]);

// A written table stays a heap array; the image data is only for tables the
// module never writes.
const counters = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
counters[7] = 3;
counters[19] += 2;
console.log("counters", counters[7], counters[19], counters[18], counters.length);

// Array methods on a table read its elements through the generic paths.
const listed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const doubled = listed.map((value) => value * 2);
console.log("mapped", doubled[0], doubled[17], doubled.length, listed.includes(9));
