// `++`/`--` on a `bigint | undefined` binding the checker narrowed to its
// bigint arm: the update reads through the union's bigint arm, steps by 1n
// and writes the result back tagged, so the assignment stays a bigint.
let sequence: bigint | undefined;

function next(): bigint {
  if (sequence === undefined) sequence = 5n;
  else sequence++;
  return sequence;
}
console.log(next(), next(), next());

// The postfix value is the old one, the prefix value the new one, and both
// spellings write the stepped value back.
function postfix(): string {
  if (sequence === undefined) return "none";
  const before = sequence++;
  return `${before} -> ${sequence}`;
}
console.log(postfix(), postfix());

function prefix(): string {
  if (sequence === undefined) return "none";
  const after = ++sequence;
  return `${after} ${after === sequence}`;
}
console.log(prefix());

function decrement(): string {
  if (sequence === undefined) return "none";
  const after = sequence--;
  const before = --sequence;
  return `${after} ${sequence} ${before} ${before === sequence}`;
}
console.log(decrement());

// The same update on a binding narrowed by a guard rather than a branch.
function stepTwice(value: bigint | undefined): bigint {
  if (value === undefined) return 0n;
  value++;
  value++;
  return value;
}
console.log(stepTwice(undefined), stepTwice(41n), stepTwice(-2n));

// Negative and wide magnitudes keep their exact bigint arithmetic.
function wideStep(): string {
  let wide: bigint | undefined = 2n ** 64n - 1n;
  if (wide === undefined) return "none";
  const previous = wide--;
  const trimmed = wide;
  const restored = ++wide;
  return `${previous} ${trimmed} ${restored} ${restored === previous}`;
}
console.log(wideStep());
console.log(typeof sequence, String(sequence));
