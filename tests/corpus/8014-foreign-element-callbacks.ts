// Callbacks over a number[] or string[] that holds elements written
// through an unknown[] view, when the callback never reads the element:
// it declares no element parameter, or never references the one it
// declares. The methods visit every element as in Node, and filter keeps
// a written element as it is.

const numbers: number[] = [1, 2];
const numbersView: unknown[] = numbers;
numbersView.push("x", undefined, { k: 1 });
numbers.push(5);

// Inline callbacks (fused loops).
console.log(numbers.filter(() => true));
console.log(numbers.filter((_, i) => i % 2 === 0));
console.log(numbers.map(() => 0));
console.log(numbers.map((_, i) => i * 10));
console.log(numbers.some(() => false), numbers.every((_v) => true));
console.log(numbers.findIndex((_, i) => i === 2), numbers.findLastIndex((_, i) => i < 3));
console.log(numbers.find(() => false), numbers.findLast((_, i) => i === 0));
console.log(numbers.reduce((s) => s + 1, 0), numbers.reduce((s, v) => s + 1, 100));
console.log(numbers.reduceRight((s, _v, i) => s + i, 0));
let visits = 0;
numbers.forEach((_, i) => {
  visits += i;
});
console.log(visits);
console.log(numbers.filter((_, i) => i > 1).map((_, i) => i));
console.log(numbers.flatMap(() => [7]), numbers.flatMap((_, i) => [i, -i]));
console.log(numbers.filter(() => true).length, typeof (numbers.filter(() => true) as unknown[])[2]);

// Callback values (shared helpers).
const always = (): boolean => true;
const never = (): boolean => false;
const count = (s: number): number => s + 1;
console.log(numbers.filter(always));
console.log(numbers.some(never), numbers.every(always), numbers.find(never));
console.log(numbers.findIndex(never), numbers.reduce(count, 0));
console.log(numbers.map(always));

// A kept written element is the same value in the result.
const kept = numbers.filter(always) as unknown[];
console.log(kept[2] === "x", kept[3] === undefined, 3 in kept, kept[4], kept.length);

// string[] the same way.
const words: string[] = ["a", "b"];
const wordsView: unknown[] = words;
wordsView.push(7, null);
console.log(words.filter(() => true), words.map((_, i) => `#${i}`));
console.log(words.filter((_w, i) => i !== 1), words.reduce((s) => s + 1, 0));

// Holes stay holes and are skipped as in Node.
const sparse: number[] = [1];
const sparseView: unknown[] = sparse;
sparseView[3] = "z";
console.log(sparse.filter(() => true), sparse.map((_, i) => i), sparse.findIndex((_, i) => i === 1));

// A parameter used only through a shorthand property is still read.
const plain = [1, 2, 3];
console.log(plain.map((v) => ({ v })), plain.reduce((acc, v) => ({ sum: acc.sum + v, v }), { sum: 0, v: 0 }));
console.log(plain.filter((v) => [{ v }].length > 0 && v > 1));

// A callback that ignores its element still receives the element as it was
// before the callback ran: filter keeps it, and find returns it, even when
// the callback overwrites or removes the slot.
const changing: number[] = [1, 2, 3];
const changingView: unknown[] = changing;
changingView.push("x");
let at = 0;
console.log(
  changing.filter(() => {
    changingView[at] = at === 1 ? "w" : 100 + at;
    at++;
    return true;
  }),
  changing,
);
const found: number[] = [1, 2];
(found as unknown[]).push("y");
let step = 0;
console.log(
  found.find(() => {
    found[step] = 50;
    step++;
    return step === 2;
  }),
  found,
);
const shrinking: number[] = [4, 5];
(shrinking as unknown[]).push("z", 6);
console.log(
  shrinking.findLast(() => {
    shrinking.length = 1;
    return true;
  }),
  shrinking.length,
);
const cut: number[] = [7, 8, 9];
(cut as unknown[]).push("q");
console.log(
  cut.filter((_v, i) => {
    if (i === 1) cut.length = 1;
    return true;
  }),
  cut.length,
);

// Arrays proven to hold no undefined keep their elements in filter results
// when the predicate ignores them.
const dense = [1, 2, 3, 4];
let calls = 0;
console.log(
  dense.filter((_v, i) => {
    calls++;
    return i % 2 === 0;
  }),
  calls,
  dense.filter((_v, i) => i > 1),
);
