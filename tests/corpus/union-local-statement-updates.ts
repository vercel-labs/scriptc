// Locals holding typed-array reads (a number, or undefined out of range),
// updated by `++`, `--` and compound assignment statements while they hold
// a number, NaN or undefined, including loops that copy one such local into
// another.
function first(values: Int32Array): number {
  return values[0];
}

const filled = new Int32Array([5, 3, 1]);
const empty = new Int32Array(0);

function countDown(values: Int32Array): string {
  const seen: number[] = [];
  let k = values[0];
  let j = k;
  while (j !== undefined && j > 0) {
    seen.push(j);
    j--;
  }
  return `${seen.join(",")} ${j} ${k}`;
}
console.log(countDown(filled), countDown(empty));

function update(values: Float64Array, index: number): string {
  let value = values[index];
  value++;
  value--;
  value += 3;
  value -= 1;
  value *= 2;
  ++value;
  --value;
  return `${value} ${typeof value}`;
}
const samples = new Float64Array([1, NaN, -0]);
console.log(update(samples, 0), update(samples, 1), update(samples, 2), update(samples, 3));

function reverse(values: Int32Array): string {
  const copy = values.slice();
  let k = copy[0];
  let flips = 0;
  while (k !== 0 && flips < 10) {
    let i = 0;
    let j = k;
    while (i < j) {
      const t = copy[i];
      copy[i] = copy[j];
      copy[j] = t;
      i++;
      j--;
    }
    flips++;
    k = copy[0];
  }
  return `${Array.from(copy).join(",")} ${flips}`;
}
console.log(reverse(new Int32Array([2, 0, 1])), reverse(new Int32Array([3, 1, 2, 0])));

// The update reads the local after an earlier statement changed it.
let total = first(filled);
for (let i = 0; i < 3; i++) {
  total += i;
  total--;
}
console.log(total, first(empty));
let missing = first(empty);
missing++;
console.log(missing, Number.isNaN(missing));
