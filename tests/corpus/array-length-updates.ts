// A native array's `length` is a writable number: `a.length++`,
// `a.length--` and the compound assignments read the length, combine, and
// write the result back with the same grow and truncate semantics as
// `a.length = n`. Postfix yields the old length and prefix the new one, the
// read happens before the right side, and a length that is not a valid array
// length throws Node's RangeError.

const numbers: number[] = [1, 2, 3];
console.log(numbers.length++, numbers.length);
console.log(++numbers.length, numbers.length, numbers.join(","));

// Truncation drops the removed elements; growth appends holes.
numbers.length--;
console.log(numbers.length, numbers.join(","), JSON.stringify(numbers));
numbers.length += 2;
console.log(numbers.length, JSON.stringify(numbers));
numbers.length -= 3;
console.log(numbers.length, JSON.stringify(numbers));

const words: string[] = ["a", "b", "c", "d"];
console.log(words.length--, words.length, words.join(","));
words.length /= 3;
console.log(words.length, words.join(","));
words.length *= 3;
console.log(words.length, JSON.stringify(words));
words.length **= 1;
console.log(words.length);
words.length %= 2;
console.log(words.length);
words.length = 5;
words.length >>= 1;
console.log(words.length, JSON.stringify(words));

// The receiver and the length read are saved before the right side runs.
let steps: string[] = [];
function take(): number[] {
  steps.push("receiver");
  return numbers;
}
function amount(): number {
  steps.push("rhs");
  return 1;
}
console.log(take().length += amount(), numbers.length, steps.join(","));

// A member array and a getter each update their own array once.
const holder = { items: [4, 5, 6] };
holder.items.length--;
console.log(holder.items.length, holder.items.join(","));
let reads = 0;
const accessed = {
  get list(): number[] {
    reads++;
    return holder.items;
  },
};
accessed.list.length += 2;
console.log(reads, holder.items.length, JSON.stringify(holder.items));

// Invalid lengths throw RangeError, leave the array unchanged, and are
// catchable around the whole update.
function rejects(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    console.log(label, error instanceof RangeError, (error as Error).message);
  }
}
const empty: number[] = [];
rejects("decrement empty", () => empty.length--);
rejects("negative", () => {
  empty.length -= 2;
});
rejects("fraction", () => {
  empty.length += 0.5;
});
console.log(empty.length);

// Growing past the initial capacity keeps holes and appends values.
const grown: number[] = [9];
grown.length = 3;
grown.push(10);
grown.length++;
console.log(grown.length, JSON.stringify(grown), grown.join(","));
grown.length = 1;
console.log(grown.length, JSON.stringify(grown));
