// Stored ArrayIterator<number> values consumed by for-of. The iterator
// keeps its cursor across loops, advances before the body runs, observes
// live array growth until it is exhausted, and stays exhausted after that
// even if the source grows again. Node is the byte-for-byte oracle.
const numbers = [10, 20, 30];
const values = numbers.values();

for (const n of values) {
  console.log("first", n);
  if (n === 10) break;
}

numbers.push(40);
for (const n of values) {
  if (n === 30) continue;
  console.log("resume", n);
}

numbers.push(50);
for (const n of values) console.log("exhausted", n);

// The default array iterator is the same values protocol. A pre-declared
// head is assigned per step, and a break leaves the cursor ready to resume.
const viaSymbol = [1, 2, 3][Symbol.iterator]();
let current = 0;
for (current of viaSymbol) {
  console.log("symbol", current);
  break;
}
for (current of viaSymbol) console.log("symbol-rest", current);
console.log("last", current);

// Growth while a loop is active is visible because ArrayIterator.next()
// re-reads the source length for each step.
const liveNumbers = [7];
const liveValues = liveNumbers.values();
for (const n of liveValues) {
  console.log("live", n);
  if (n < 9) liveNumbers.push(n + 1);
}

// Function-local iterator state is independent per call, and the source
// expression is evaluated exactly once when the iterator is created.
function makeNumbers(limit: number): number[] {
  console.log("make", limit);
  return [limit, limit + 1];
}
function walkLocal(limit: number): number {
  const localValues = makeNumbers(limit).values();
  let sum = 0;
  for (const n of localValues) sum += n;
  return sum;
}
console.log("local", walkLocal(4), walkLocal(8));

// Uint8Array uses the same numeric value-iterator protocol. Direct
// iteration evaluates the source once and observes element writes that
// happen before a later index is visited.
function makeBytes(): Uint8Array {
  console.log("make-bytes");
  return new Uint8Array([250, 2, 3]);
}
const directBytes = makeBytes();
for (const byte of directBytes) {
  console.log("byte", byte);
  if (byte === 250) directBytes[1] = 8;
}

// Stored typed-array iterators retain their cursor across loops just like
// stored number[] iterators.
const byteValues = new Uint8Array([11, 12, 13]).values();
for (const byte of byteValues) {
  console.log("byte-first", byte);
  break;
}
for (const byte of byteValues) console.log("byte-rest", byte);
for (const byte of byteValues) console.log("byte-exhausted", byte);

// Both direct and stored default-iterator spellings yield numbers.
for (const byte of new Uint8Array([21, 22]).values()) {
  console.log("byte-direct-values", byte);
}
for (const byte of new Uint8Array([31, 32])[Symbol.iterator]()) {
  console.log("byte-direct-symbol", byte);
}
const byteSymbol = new Uint8Array([41, 42])[Symbol.iterator]();
for (const byte of byteSymbol) console.log("byte-symbol", byte);
