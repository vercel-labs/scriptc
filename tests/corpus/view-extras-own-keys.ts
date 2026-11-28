// A record converted into a narrower type keeps the source's other
// properties, and a conversion of such a value keeps them again. The own-key
// queries must answer from those kept properties, not from the target shape,
// so the conversion stays a copy (its view would answer from the shape). The
// self-assignment observes the conversion; the corpus compares every query
// with Node. Differentially vs Node.
type Narrow = { a: number };
type Wide = { a: number; b: number };

const first = { a: 1, b: 2, c: 3 };
const second: Wide = first;
const third: Narrow = second;
third.a = third.a;

console.log("keys", Object.keys(third).join(","));
console.log("hasOwn", Object.hasOwn(third, "b"), "c" in third);
console.log("own", third.hasOwnProperty("b"), third.propertyIsEnumerable("c"));
console.log("entries", JSON.stringify(Object.entries(third)));
console.log("values", JSON.stringify(Object.values(third)));
console.log("names", Object.getOwnPropertyNames(third).join(","));
console.log("json", JSON.stringify(third));
const spread = { ...third };
console.log("spread", Object.keys(spread).join(","), JSON.stringify(spread));
const assigned = Object.assign({}, third);
console.log("assign", Object.keys(assigned).join(","), JSON.stringify(assigned));
const seen: string[] = [];
for (const key in third) seen.push(key);
console.log("forin", seen.join(","));
