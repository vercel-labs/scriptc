// A string enum's object holds only its member names; a mixed enum's has a
// reverse entry for each numeric member and none for the string ones.
enum Color {
  Red = "red",
  Green = "green",
  Empty = "",
  "dark-blue" = "navy",
}
enum Mixed {
  A,
  B = "b",
  C = 5,
  D,
  "e-f" = 7,
  G = "g",
}
enum One {
  Only = "only",
}

console.log(Object.keys(Color).join(","), Object.values(Color).join(","));
console.log(JSON.stringify(Object.entries(Color)), JSON.stringify(Color));
console.log(Color);
console.log(JSON.stringify(Object.entries(Mixed)), JSON.stringify(Mixed));
console.log(Mixed);
console.log(Object.keys(One), Object.values(One), Object.entries(One));

// Membership tests over the values: the usual validation of an input.
function isColor(text: string): text is Color {
  return Object.values(Color).includes(text as Color);
}
const raw: string = process.argv[2] ?? "green";
console.log(isColor(raw), isColor("purple"), isColor(""), isColor("Red"));
const byValue = new Map(Object.entries(Color).map(([name, value]) => [value, name]));
console.log(byValue.get(Color.Green), byValue.get("navy" as Color), byValue.size);
console.log(new Set(Object.values(Color)).has(Color.Red), Object.values(Mixed).length);
for (const [name, value] of Object.entries(Mixed)) console.log(name, typeof value, value);

// A reverse lookup on a mixed enum.
const index: number = raw.length;
console.log(Mixed[index], Mixed[index + 1], Mixed[index + 2], Mixed[0]);

// Two enums and an object literal with the same keys and value types each
// enumerate in their own creation order.
enum Forward {
  A = "x",
  B = "y",
}
enum Backward {
  B = "y",
  A = "x",
}
const literal = { B: "b", A: "a" };
console.log(Object.keys(Forward).join(","), Object.keys(Backward).join(","), Object.keys(literal).join(","));
console.log(JSON.stringify(Forward), JSON.stringify(Backward), JSON.stringify(literal));
const either = raw.length > 3 ? Forward : Backward;
console.log(Object.keys(either).join(","), Object.values(either).join(","));
