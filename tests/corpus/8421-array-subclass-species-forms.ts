// One class that extends Array sends every array method call in the program
// through the species lowering, plain-array receivers included. Two callback
// forms the species path used to refuse: a filter whose callback narrows the
// element union (a type predicate, or a discriminant test tsc infers one
// from), which wraps the filtered array in a checked-narrowing conversion,
// and a flatMap whose callback returns a union holding an array arm.
class Stack extends Array<number> {}

type Item = { kind: "a"; n: number } | { kind: "b"; s: string };
const items: Item[] = [
  { kind: "a", n: 1 },
  { kind: "b", s: "x" },
  { kind: "a", n: 2 },
];
const isA = (item: Item): item is { kind: "a"; n: number } => item.kind === "a";

const tagged = items.filter(isA);
const inferred = items.filter((item) => item.kind === "b");
const blocked = items.filter((item) => {
  return item.kind === "b";
});
const flattened = items.flatMap((item) => (item.kind === "a" ? [item.n] : []));
const mixed = items.flatMap((item) => (item.kind === "a" ? [item.n] : undefined));
console.log(tagged.length, tagged.map((item) => item.n).join(","));
console.log(inferred.length, inferred.map((item) => item.s).join(","), blocked.length);
console.log(flattened.join(","), mixed.length, mixed.join(","));

const stack = Stack.from([1, 2, 3]);
const even = stack.filter((n) => n % 2 === 0);
const doubled = stack.flatMap((n) => (n > 1 ? [n, n * 10] : []));
console.log(even instanceof Stack, even.join(","), stack.length);
console.log(doubled instanceof Stack, doubled.join(","), stack.length);
