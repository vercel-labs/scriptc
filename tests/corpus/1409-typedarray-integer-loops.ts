// Canonical byte loops use integer induction internally while every ordinary
// observation of the index remains a JavaScript number. Body mutation falls
// back to the general f64 path; changing the fixed-length receiver binding is
// safe because the loop condition and accesses read the current receiver.
function byteSum(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum;
}

function byteFill(buf: Uint8Array, value: number): void {
  for (let i = 0; i < buf.length; i++) buf[i] = value;
}

function weighted(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i === 2) continue;
    sum += i * buf[i];
  }
  return sum;
}

function bodyMutation(buf: Uint8Array): number {
  let digits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i === 1) i++;
    digits = digits * 10 + buf[i];
  }
  return digits;
}

function receiverChange(first: Uint8Array, replacement: Uint8Array): number {
  let current = first;
  let sum = 0;
  for (let i = 0; i < current.length; i++) {
    if (i === 1) current = replacement;
    sum += current[i];
  }
  return sum;
}

const bytes = new Uint8Array([1, 2, 3, 4]);
console.log("sum", byteSum(bytes));
console.log("weighted", weighted(bytes));
console.log("mutated", bodyMutation(bytes));
console.log("receiver", receiverChange(new Uint8Array([5, 6]), new Uint8Array([10, 20, 30, 40])));
byteFill(bytes, 9);
console.log("filled", bytes.join(","), byteSum(bytes));
