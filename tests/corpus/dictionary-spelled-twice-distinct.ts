// Dictionaries whose value types differ are different types. One dictionary
// type here holds an existing record and keeps its identity; the others, of
// another member type, an optional member, one more member and a primitive,
// are their own types and behave as before.
function show(same: boolean, held: object, source: object, value: unknown): void {
  console.log(same, Object.keys(held).join(","), Object.keys(source).join(","), JSON.stringify(value));
}

const source = { first: { n: 1 } };
const held: { [key: string]: { n: number } } = source;
held.second = { n: 2 };
const again: { [key: string]: { n: number } } = held;
again.third = { n: 3 };
show(again === held, held, source, again);

function texts(bag: { [key: string]: { n: string } }): string {
  bag.added = { n: "late" };
  return Object.keys(bag).map((key) => `${key}=${bag[key]!.n}`).join(",");
}
function optional(bag: { [key: string]: { n?: number } }): string {
  bag.added = {};
  return Object.keys(bag).map((key) => `${key}=${String(bag[key]!.n)}`).join(",");
}
function wider(bag: { [key: string]: { n: number; m?: string } }): string {
  bag.added = { n: 9, m: "m" };
  return Object.keys(bag).map((key) => `${key}=${bag[key]!.n}${bag[key]!.m ?? ""}`).join(",");
}
function numbers(bag: { [key: string]: number }, words: { [key: string]: string }): string {
  bag.added = 4;
  words.added = "w";
  return Object.keys(bag).join(",") + "/" + Object.keys(words).join(",");
}
const textBag: { [key: string]: { n: string } } = { only: { n: "s" } };
const optionalBag: { [key: string]: { n?: number } } = { only: { n: 1 } };
const widerBag: { [key: string]: { n: number; m?: string } } = { only: { n: 1 } };
const numberBag: { [key: string]: number } = { one: 1 };
const wordBag: { [key: string]: string } = { one: "1" };
console.log(texts(textBag), optional(optionalBag), wider(widerBag), numbers(numberBag, wordBag));
console.log(Object.keys(textBag).length, Object.keys(optionalBag).length, Object.keys(widerBag).length, Object.keys(numberBag).length, Object.keys(wordBag).length);
console.log(Object.keys(held).join(","), JSON.stringify(source));
