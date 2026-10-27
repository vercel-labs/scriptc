// new URLSearchParams(pairs) over [string, string] tuple rows, such as an
// Object.entries result: each pair appends its name and value in array
// order, so repeated names keep every value and an empty array gives empty
// params. The params are then as mutable as any other.
const record: Record<string, string> = { a: "1", "b c": "x&y", é: "ü" };
const fromEntries = new URLSearchParams(Object.entries(record));
console.log(fromEntries.toString(), fromEntries.size);

const pairs: [string, string][] = [
  ["k", "v"],
  ["k", "w"],
  ["", ""],
  ["plus", "a+b c"],
];
const repeated = new URLSearchParams(pairs);
console.log(repeated.toString(), JSON.stringify(repeated.getAll("k")));

const none: [string, string][] = [];
const empty = new URLSearchParams(none);
console.log(JSON.stringify(empty.toString()), empty.size);

const edited = new URLSearchParams(pairs);
edited.append("y", "2");
edited.delete("k");
edited.sort();
console.log(edited.toString(), pairs.length);

const lone: [string, string][] = [["z", "\uD800x"]];
console.log(new URLSearchParams(lone).toString());

const url = new URL("https://example.test/?q=1");
for (const [name, value] of new URLSearchParams(Object.entries({ q: "2", r: "3" })))
  url.searchParams.set(name, value);
console.log(url.href);
