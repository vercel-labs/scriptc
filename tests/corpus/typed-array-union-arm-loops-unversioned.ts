// Loops over unions the arm-binding pass leaves alone: a union past its arm
// count, a union with an undefined arm, one whose arms are not typed arrays,
// and one whose source the loop declares itself. Each keeps its per-element
// dispatch and still reads the same values.

function histogram(xs: Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array): number {
  let buckets = 0;
  for (let i = 0; i < xs.length; i++) buckets += (xs[i]! + 128) & 7;
  return buckets;
}

function countDefined(xs: Uint8Array | undefined): number {
  let n = 0;
  for (let i = 0; i < 8; i++) if (xs !== undefined && i < xs.length) n += xs[i]!;
  return n;
}

function texts(values: (string | number)[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    total += typeof v === "number" ? v : v.length;
  }
  return total;
}

function rederive(xs: Uint8Array | Uint16Array, picked: boolean): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const current: Uint8Array | Uint16Array = picked ? xs : new Uint16Array(4).fill(i);
    total += current[i]!;
  }
  return total;
}

const wide = new Int16Array([1, 2, 3, 4, 5]);
const narrow = new Uint8Array([250, 251, 252]);
console.log(histogram(wide), histogram(narrow));
console.log(countDefined(narrow), countDefined(undefined));
console.log(texts(["abcdefg", 4, 5, 6]));
console.log(rederive(new Uint16Array([7, 8, 9, 10]), true));
console.log(rederive(new Uint16Array([7, 8, 9, 10]), false));
