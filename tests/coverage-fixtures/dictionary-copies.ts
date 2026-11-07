// A dictionary that holds an existing record keeps its identity, and so does
// every spelling of its type. A dictionary of another value type is another
// type: converting into it copies the entries, and a write or comparison
// through the copy is reported.
const source = { first: { n: 1 } };
const held: { [key: string]: { n: number } } = source;
held.second = { n: 2 };

// The same type spelled again: the same object, nothing to report.
const again: { [key: string]: { n: number } } = held;
again.third = { n: 3 };

// One more optional member in the value type: a copy that is written through.
const wider: { [key: string]: { n: number; m?: string } } = held;
wider.fourth = { n: 4, m: "wide" };

// A wider union as the value type, compared with the original.
const counts = { one: 1 };
const numbers: { [key: string]: number } = counts;
numbers.two = 2;
const mixed: { [key: string]: number | string } = numbers;
console.log(mixed === numbers);

// A parameter of the wider type that writes.
function label(bag: { [key: string]: number | string }): void {
  bag.label = "l";
}
label(numbers);
console.log(Object.keys(source).length, Object.keys(counts).length);
