// Two-counter loops over typed arrays (`for (let i = lo, j = hi; i < j;
// i++, j--)`), with starts inside the arrays and outside them: past the
// end, negative, fractional and NaN. Views over one buffer, other element
// types, inclusive conditions and steps other than one.

function reverse(a: Int32Array, lo: number, hi: number): string {
  for (let i = lo, j = hi; i < j; i++, j--) {
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return Array.from(a).join();
}

function mirror(a: Float64Array, b: Float64Array, hi: number): number {
  let sum = 0;
  for (let i = 0, j = hi; i <= j; i++, j--) {
    b[i] = a[j]! * 2;
    sum += a[i]! - b[j]!;
  }
  return sum;
}

function skipping(a: Uint8ClampedArray, hi: number): string {
  for (let i = 0, j = hi; i < j; i += 2, j -= 3) {
    a[i] = a[j]! + 200;
    a[j] = i - 10;
  }
  return Array.from(a).join();
}

function palindrome(text: Uint16Array, n: number): boolean {
  for (let i = 0, j = n - 1; i < j; i++, j--) if (text[i] !== text[j]) return false;
  return true;
}

console.log(reverse(new Int32Array([1, 2, 3, 4, 5, 6]), 0, 5));
console.log(reverse(new Int32Array([1, 2, 3, 4, 5, 6]), 1, 3));
console.log(reverse(new Int32Array([1, 2, 3, 4]), 0, 6));
console.log(reverse(new Int32Array([1, 2, 3, 4]), -2, 2));
console.log(reverse(new Int32Array([1, 2, 3, 4]), 0.5, 3.5));
console.log(reverse(new Int32Array([1, 2, 3, 4]), 0, NaN));
console.log(reverse(new Int32Array([1, 2, 3, 4]), 3, 0));

const buffer = new ArrayBuffer(48);
const whole = new Float64Array(buffer);
for (let k = 0; k < whole.length; k++) whole[k] = k + 0.5;
const tail = new Float64Array(buffer, 16, 3);
console.log(mirror(whole, tail, 4), Array.from(whole).join());
console.log(mirror(tail, tail, 2), Array.from(whole).join());
console.log(mirror(tail, whole, 7), Array.from(whole).join());

console.log(skipping(new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80]), 7));
console.log(skipping(new Uint8ClampedArray([10, 20, 30]), 9));

const word = new Uint16Array([114, 97, 99, 101, 99, 97, 114]);
console.log(palindrome(word, 7), palindrome(word, 6), palindrome(word, 9), palindrome(word, 0));
