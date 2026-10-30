// A number[] or string[] seen as `unknown[]` holds the values written
// through the view that its element type cannot hold, as in Node. The view
// and the typed array are the same array: length, the view's reads and
// iteration, printing, JSON, join, searches, copies, Math over a spread,
// sorting and truncation see the written values.

const numbers: number[] = [1, 2];
const numbersView: unknown[] = numbers;
numbersView.push("x");
numbersView[0] = true;
console.log(numbers.length, numbersView.length, numbers === numbersView);
console.log(numbersView[0], numbersView[2], typeof numbersView[2]);
console.log(numbers, String(numbers), numbers.join("|"), JSON.stringify(numbers));
for (const value of numbersView) console.log("value", value, typeof value);
console.log(numbers.indexOf(2), numbers.includes(2));
console.log([...numbers], numbers.slice(1), numbers.slice(1, 2), numbers.concat([9]));

// Math over a spread applies ToNumber to every element, as in Node.
const digits: number[] = [5];
const digitsView: unknown[] = digits;
digitsView.push("4", null);
console.log(Math.max(...digits), Math.min(...digits), Math.hypot(...digits));

// Present undefined, null and objects keep their own values.
const mixed: number[] = [1];
const mixedView: unknown[] = mixed;
mixedView.push(undefined, null, { a: 1 }, [2, 3]);
console.log(mixed, mixed.length, 1 in mixed, mixedView[2] === null);
console.log(JSON.stringify(mixed), mixed.join("-"));

// Writing a number over a foreign element makes it a number again.
const replaced: number[] = [1, 2];
const replacedView: unknown[] = replaced;
replacedView.push("x");
replaced[2] = 5;
console.log(replaced, replacedView, replaced[2] + 1);

// Default sort orders every element by its string, as in Node.
const sorted: number[] = [10, 9, 1];
const sortedView: unknown[] = sorted;
sortedView.push("b", "a");
console.log(sorted.sort(), sorted.length, sortedView[4]);

// Truncation drops written values; growing again leaves holes.
const truncated: number[] = [1];
const truncatedView: unknown[] = truncated;
truncatedView.push("x", "y");
truncated.length = 1;
truncated.length = 3;
console.log(truncated, truncatedView.length);

// string[] holds values of other types the same way.
const words: string[] = ["a"];
const wordsView: unknown[] = words;
wordsView.push(1, false);
console.log(words, words.join("-"), words.length, typeof wordsView[1]);

// A conversion that changes the array does not change the spread's values,
// and toSorted reads holes as undefined.
const grown: number[] = [3, 1];
const grownView: unknown[] = grown;
grownView.push({
  valueOf: () => {
    for (let i = 0; i < 64; i++) grown.push(i);
    grown.length = 1;
    return 2;
  },
});
console.log(Math.max(...grown), Math.min(...grown), grown.length);
const holey: string[] = ["c", "a"];
const holeyView: unknown[] = holey;
holeyView[4] = 7;
holeyView[6] = undefined;
console.log(holey.toSorted(), holey.length);
holey.sort();
console.log(holey, holey.length);

// Conversions during an in-place sort that change the array's length:
// elements added past the sorted length stay.
const appended: number[] = [3, 1, 2];
const appendedView: unknown[] = appended;
let appendedCalls = 0;
appendedView[1] = {
  toString(): string {
    if (appendedCalls++ === 0) appended.push(7, 8);
    return "1";
  },
};
appended.sort();
console.log(appended.length, appended.slice(3), String(appendedView[0]), appended[2]);
const reduced: number[] = [3, 1, 2];
const reducedView: unknown[] = reduced;
reducedView[4] = 4;
let reducedCalls = 0;
reducedView[1] = {
  toString(): string {
    if (reducedCalls++ === 0) reduced.length = 1;
    return "1";
  },
};
reduced.sort();
console.log(reduced.length, 3 in reduced, 4 in reduced, reduced[1], reduced[2]);
const padded: number[] = [3, 1, 2];
const paddedView: unknown[] = padded;
paddedView.length = 5;
let paddedCalls = 0;
paddedView[1] = {
  toString(): string {
    if (paddedCalls++ === 0) padded.push(9);
    return "1";
  },
};
padded.sort();
console.log(padded.length, 3 in padded, 4 in padded, padded[5]);
const spread: number[] = [4, 3];
const spreadView: unknown[] = spread;
let spreadCalls = 0;
spreadView.push({
  toString(): string {
    if (spreadCalls++ === 0) {
      spreadView[1000] = 1;
      for (let i = 0; i < 64; i++) spread.push(i);
    }
    return "2";
  },
});
console.log(spread.toSorted().length, spread.length);
spread.sort();
console.log(spread.length, spread[0], spread[1], spread[3], 999 in spread, spread[1000]);
const grownMath: number[] = [1];
const grownMathView: unknown[] = grownMath;
grownMathView[10] = {
  valueOf(): number {
    grownMathView[5000] = 7;
    for (let i = 0; i < 256; i++) grownMath.push(i);
    return 3;
  },
};
console.log(Math.max(...grownMath), grownMath.length);

// A conversion that removes the element it converts.
const shrinking: number[] = [1];
const shrinkingView: unknown[] = shrinking;
shrinkingView.push({
  toString: () => {
    shrinking.length = 0;
    return "gone";
  },
});
console.log(shrinking.join("+"), shrinking.length);
const cut: string[] = ["a", "b"];
const cutView: unknown[] = cut;
cutView.splice(1, 0, { toString: () => ((cut.length = 0), "x") });
console.log(JSON.stringify(cut.join("-")), cut.length);

// JSON of elements whose getters change the array or record holding them.
const fillers: number[][] = [];
const rows: number[][] = [[1], [2]];
const rowView: unknown[] = rows[0]!;
rowView.push({
  get grown() {
    for (let i = 0; i < 64; i++) rows.push([i]);
    rows.length = 3;
    // Reuse the memory the old storage held.
    for (let i = 0; i < 64; i++) fillers.push([i, i]);
    return true;
  },
});
console.log(JSON.stringify(rows), rows.length);
const holder = { values: [5] as number[], name: "h" };
const holderView: unknown[] = holder.values;
holderView.push({
  get replaced() {
    holder.values = [9];
    for (let i = 0; i < 64; i++) fillers.push([i]);
    return true;
  },
});
console.log(JSON.stringify(holder), JSON.stringify(holder));

// toSorted keeps the full length and reads holes as undefined; indexOf,
// lastIndexOf and includes skip the undefined and foreign elements.
const searched: string[] = ["b", "a"];
const searchedView: unknown[] = searched;
searchedView[9] = 4;
searchedView[5] = undefined;
console.log(searched.indexOf("b"), searched.lastIndexOf("b"), searched.lastIndexOf("a", 8));
console.log(searched.includes("a"), searched.lastIndexOf("z"));
const searchedSorted = searched.toSorted();
console.log(searchedSorted.length, searchedSorted.slice(0, 4), searchedSorted.lastIndexOf("b"));
console.log(searchedSorted.indexOf("a"), searchedSorted.includes("b"));
const counts: number[] = [3, 1];
const countsView: unknown[] = counts;
countsView[6] = "x";
countsView[4] = 2;
const countsSorted = counts.toSorted();
console.log(countsSorted.length, countsSorted, countsSorted.lastIndexOf(3), counts.lastIndexOf(2));
const far: number[] = [5];
const farView: unknown[] = far;
farView[70000] = "z";
const farSorted = far.toSorted();
console.log(farSorted.length, farSorted.slice(0, 3), farSorted.slice(69999), farSorted.lastIndexOf(5));
