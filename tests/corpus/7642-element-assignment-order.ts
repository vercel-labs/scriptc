// An element assignment evaluates its receiver and index before its value,
// also when the value is an optional element read or a call that assigns
// the bindings the receiver and index read.
const a = [10, 20, 30, 40];
const b = [1, 2, 3, 4];
let n = 0;
a[n++] = b[n]!;
console.log(a.join(), n);
a[n] = b[n++];
console.log(a.join(), n);

const optional: (number | undefined)[] = [undefined, 5, undefined];
let k = 0;
optional[k++] = optional[k];
console.log(optional, k);

// A call in the value assigns the receiver and the index through closures.
let target: (number | undefined)[] = [0, 0, 0];
const first = target;
let at = 0;
function swap(): number | undefined {
  target = [9, 9, 9];
  at = 2;
  return b[3];
}
target[at] = swap();
console.log(first, target, at);

// The index and receiver are not evaluated twice.
let reads = 0;
function index(): number {
  reads++;
  return 1;
}
const c: (number | undefined)[] = [0, 0];
c[index()] = optional[1];
console.log(c, reads);

// The index assigns the receiver's binding: the store uses the receiver
// evaluated before it.
let receiver: (number | undefined)[] = [0, 0];
const original = receiver;
const replacement: (number | undefined)[] = [7, 7];
receiver[((receiver = replacement), 1)] = optional[1];
console.log(original, replacement, receiver === replacement);
