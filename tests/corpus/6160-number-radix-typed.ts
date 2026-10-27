// Number.prototype.toString(radix) with a number-typed radix takes the
// typed entry point: ToIntegerOrInfinity truncates the radix (NaN to 0),
// out-of-range radixes throw the same RangeError, and the argument is
// evaluated once, before formatting. An optional radix keeps the generic
// conversion, where undefined means 10.
const radixes = [2, 2.9, 7, 10, 16, 16.5, 35.99, 36];
const values = [0, -0, 1, -1, 255, -255.5, 0.1, 1 / 3, 2 ** 53, -(2 ** 60), 1e21, 123.456, NaN, Infinity, -Infinity];
for (const radix of radixes) {
  const row: string[] = [];
  for (const value of values) row.push(value.toString(radix));
  console.log(radix, row.join(" "));
}

let calls = 0;
function nextRadix(): number {
  calls++;
  return 8 + calls;
}
console.log((1234).toString(nextRadix()), (1234).toString(nextRadix()), calls);

for (const bad of [-0, 0.5, 1, 1.99, 36.5, 37, -2, NaN, Infinity, -Infinity]) {
  try {
    console.log((42).toString(bad));
  } catch (error) {
    console.log(String(bad), error instanceof RangeError, (error as Error).message);
  }
}

function maybeRadix(i: number): number | undefined {
  return i % 2 === 0 ? undefined : 2 + i;
}
for (let i = 0; i < 4; i++) console.log((255).toString(maybeRadix(i)));

let total = 0;
for (let i = 0; i < 2000; i++) total += (i * 7919).toString(2 + (i % 35)).length;
console.log(total);
