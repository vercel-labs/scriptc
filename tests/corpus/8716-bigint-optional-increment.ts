// `++`/`--` on a `bigint | undefined` slot, once a guard proved the value
// present: the union slot is read with the checked bigint extraction, the
// step runs in the bigint domain and the result stores back into the slot.
// JavaScript's ToNumeric(undefined) is NaN, which the slot cannot hold, so a
// value that is really undefined there throws instead of yielding a number.
let sequence: bigint | undefined;

function next(): bigint {
  if (sequence === undefined) {
    sequence = 40n;
  } else {
    if (sequence === 45n) throw new RangeError("exhausted");
    sequence++;
  }
  return sequence;
}

console.log(next(), next(), next(), next(), next(), next());
console.log(typeof sequence, sequence);

try {
  next();
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

// A local union slot answers the same way, and the operator's own result is
// the pre-step value for the postfix form.
let local: bigint | undefined;
local = 10n;
const postIncrement = local++;
console.log(postIncrement, local);
const preIncrement = ++local;
console.log(preIncrement, local);
const postDecrement = local--;
console.log(postDecrement, local);
const preDecrement = --local;
console.log(preDecrement, local);
console.log(typeof local, String(local));

// The slot still holds a bigint arm after its last write (a string read of
// the union proves the tag, not a stale number).
let widened: bigint | undefined = 7n;
widened--;
console.log(widened === 6n, typeof widened);
