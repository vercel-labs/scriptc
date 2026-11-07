// Typed-array reads held in `let` bindings that are updated (`j--`, `j = …`)
// and used as typed-array indexes under a relational guard (`i < j`): the
// guard is false for undefined and for NaN, so inside it the binding holds
// a number. Covers while, for, if, `?:` and `&&` guards, reads of missing
// elements (undefined), a binding updated in a for loop's update, and
// writes between the guard and the use, directly and in a closure.
function reverseFrom(values: Int32Array): string {
  const copy = values.slice();
  let flips = 0;
  let k = copy[0];
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
  return `${Array.from(copy).join(",")} ${flips} ${k}`;
}
console.log(reverseFrom(new Int32Array([2, 0, 1])), reverseFrom(new Int32Array([3, 1, 2, 0])));
console.log(reverseFrom(new Int32Array([5, 1, 2])), reverseFrom(new Int32Array(0)));

// The binding is undefined (empty array) or NaN (a float element), so the
// guard is false and the binding keeps that value.
function countDown(values: Float64Array, out: Float64Array): string {
  let j = values[0];
  const seen: number[] = [];
  while (0 < j) {
    out[j] = j;
    seen.push(j);
    j--;
  }
  return `${seen.join(",")} ${j} ${typeof j} ${Array.from(out).join(",")}`;
}
console.log(countDown(new Float64Array([3]), new Float64Array(4)));
console.log(countDown(new Float64Array(0), new Float64Array(2)));
console.log(countDown(new Float64Array([NaN]), new Float64Array(2)));
console.log(countDown(new Float64Array([2.5]), new Float64Array(4)));

// The same loop where nothing observes undefined: the binding is a double
// that holds NaN for undefined.
function countDownSum(values: Float64Array, out: Float64Array): string {
  let j = values[0];
  let sum = 0;
  while (0 < j) {
    out[j] = j;
    sum += j;
    j--;
  }
  return `${sum} ${j - 0} ${Array.from(out).join(",")}`;
}
console.log(countDownSum(new Float64Array([3]), new Float64Array(4)));
console.log(countDownSum(new Float64Array(0), new Float64Array(2)));
console.log(countDownSum(new Float64Array([NaN]), new Float64Array(2)));
console.log(countDownSum(new Float64Array([1.5]), new Float64Array(2)));

// A for loop guard, with the binding updated in the loop's update.
function fill(values: Int32Array, out: Int32Array): string {
  let at = values[1];
  for (; at < out.length; at++) out[at] = at * 10;
  return `${Array.from(out).join(",")} ${at * 1}`;
}
console.log(fill(new Int32Array([0, 2]), new Int32Array(4)), fill(new Int32Array(1), new Int32Array(2)));

// If, `?:` and `&&` guards, with the binding reassigned elsewhere.
function guarded(values: Uint8Array, out: Uint8Array): string {
  let p = values[0];
  if (p >= 0) out[p] = 1;
  p = values[1];
  const read = p < out.length ? out[p] : -1;
  p = values[2];
  const both = p > 0 && out[p] === 0;
  return `${Array.from(out).join(",")} ${read} ${both} ${p}`;
}
console.log(guarded(new Uint8Array([1, 1, 2]), new Uint8Array(3)));
console.log(guarded(new Uint8Array([0]), new Uint8Array(3)));

// A write between the guard and the use: the use sees the new value.
function rewritten(values: Int32Array, out: Int32Array): string {
  let j = values[0];
  const seen: (number | undefined)[] = [];
  if (j < 10) {
    j = values[5];
    seen.push(j, out[j]);
  }
  return `${seen.join("|")} ${j}`;
}
console.log(rewritten(new Int32Array([1, 2]), new Int32Array(3)));

// A closure writes the binding between the guard and the use.
function viaClosure(values: Int32Array, out: Int32Array): string {
  let j = values[0];
  const reset = (): void => {
    j = values[7];
  };
  let result: number | undefined = -1;
  if (j > 0) {
    reset();
    result = out[j];
  }
  return `${result} ${j}`;
}
console.log(viaClosure(new Int32Array([1]), new Int32Array([4, 5])));
