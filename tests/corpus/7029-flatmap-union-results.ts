// flatMap callbacks that return a value or an array: an array result
// appends its elements (holes skipped), any other result appends itself,
// and an empty `[]` arm appends nothing.
const words = ["a", "", "c", "", "e"];
console.log(words.flatMap((s) => (s ? s : [])));
console.log(words.flatMap((s, i) => (s ? [s, String(i)] : [])));

function expand(line: string): string | string[] {
  return line.includes(",") ? line.split(",") : line;
}
console.log(["x", "y,z", "w"].flatMap(expand), ["x", "y,z"].flatMap((l) => expand(l)).length);

const numbers = [1, 2, 3, 4];
console.log(numbers.flatMap((n) => (n % 2 ? n : [n, n * 10])));
const sparse: number[] = [];
sparse[0] = 1;
sparse[2] = 3;
console.log(numbers.flatMap((n) => (n === 2 ? sparse : n)));

interface Entry {
  name: string;
  tags?: string[];
}
const entries: Entry[] = [{ name: "a", tags: ["t1", "t2"] }, { name: "b" }];
console.log(entries.flatMap((e) => e.tags ?? []), entries.flatMap((e) => e.tags ?? e.name));
let calls = 0;
const out = words.flatMap((s) => {
  calls++;
  return s.length > 0 ? s.toUpperCase() : [];
});
console.log(out, calls);

// One union result type with an empty arm in one callback and a populated
// array arm in another.
const counts = [1, 2, 3];
console.log(counts.flatMap((n) => (n % 2 ? n : [])), counts.flatMap((n) => (n % 2 ? n : [n, n])));

// Array results keep present undefined elements, and an undefined result
// appends itself.
const withGaps: (number | undefined)[] = [4, undefined, 6];
const maybe: (number | undefined)[] = [1, 2, undefined];
console.log(maybe.flatMap((n) => (n === 2 ? withGaps : n)));
const gaps: (string | undefined)[] = ["x", undefined];
console.log(["a", "b"].flatMap((s) => (s === "b" ? gaps : s)));
