// Array.prototype.toSorted — the stable ordering of sort on a fresh shallow
// snapshot. The receiver is not mutated, receiver/comparator expressions run
// before the snapshot, and comparator mutations of the source cannot change
// the values being sorted. Node is the oracle.

const nums = [5, 1, 4, 1, 3];
const ascending = nums.toSorted((a, b) => a - b);
console.log(ascending.join(","));
console.log(nums.join(","));

// Stability: equal keys keep their source order.
const entries = [
  { key: "b", order: 1 },
  { key: "a", order: 2 },
  { key: "b", order: 3 },
  { key: "a", order: 4 },
];
const byKey = entries.toSorted((a, b) => a.key.localeCompare(b.key));
for (const entry of byKey) {
  console.log(entry.key, entry.order);
}
console.log(entries.map((entry) => entry.order).join(","));

// The copy is shallow: its record elements retain identity.
byKey[0]!.order = 20;
console.log(entries[1]!.order);

// Comparator-less string ordering and empty/single-element arrays.
const words = ["z", "alpha", "beta", "Alpha"];
console.log(words.toSorted().join(","));
console.log(words.join(","));
const empty: string[] = [];
console.log(empty.toSorted().length, ["only"].toSorted().join(","));

// Default ordering is UTF-16 code-unit order: supplementary pairs sort
// before U+E000..U+FFFF even though UTF-8/code-point order reverses them.
const utf16Ordered = ["\uE000", "\u{10000}"].toSorted();
console.log(utf16Ordered[0]!.charCodeAt(0), utf16Ordered[1]!.charCodeAt(0));

// Undefined values sink to the end without ever reaching compareFn.
let optionalCalls = 0;
const optionals: (number | undefined)[] = [undefined, 2, 1, undefined];
const sortedOptionals = optionals.toSorted((a, b) => {
  optionalCalls++;
  if (a === undefined || b === undefined) throw new Error("undefined reached compareFn");
  return a - b;
});
console.log(sortedOptionals.join(","), optionalCalls);
console.log(optionals.join(","));

// Both the receiver expression and comparator expression are evaluated once,
// left-to-right, before toSorted snapshots the receiver.
const evaluationOrder: string[] = [];
const evaluated = (() => {
  evaluationOrder.push("receiver");
  return [3, 2, 1];
})().toSorted((() => {
  evaluationOrder.push("comparator");
  return (a: number, b: number) => a - b;
})());
console.log(evaluated.join(","), evaluationOrder.join(","));

// Argument evaluation precedes the method body and therefore the snapshot.
const argumentSource = [3, 2, 1];
const afterArgumentMutation = argumentSource.toSorted((() => {
  argumentSource[0] = 0;
  return (a: number, b: number) => a - b;
})());
console.log(afterArgumentMutation.join(","));

// The method snapshots before its first comparator call. Mutating the source
// during comparison therefore changes only the source.
const source = [3, 1, 2];
const snapshot = source.toSorted((a, b) => {
  source[0] = 99;
  if (source.length === 3) source.push(4);
  return a - b;
});
console.log(snapshot.join(","));
console.log(source.join(","));
