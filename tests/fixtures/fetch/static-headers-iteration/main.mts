// Headers iteration in a TypeScript source: for-of, spread, array
// destructuring, keys() / values() / entries(), the iterator called by its
// symbol, and iterators that stay live while the list changes, on Headers
// the program builds and on the headers of a fetched response. Names come
// sorted with their combined values; every Set-Cookie value comes alone.
const base = process.argv[2]!;

const shelf = new Headers({ "X-Rows": "12", "x-aisle": "north" });
shelf.append("set-cookie", "a=1; Path=/");
shelf.append("x-rows", "13");
shelf.append("Set-Cookie", "b=2, c=3");

for (const [name, value] of shelf) console.log("for-of:", name, "=", value);
for (const pair of shelf) console.log("pair:", pair.length, pair[0]);
console.log("spread:", JSON.stringify([...shelf]));
console.log("from:", Array.from(shelf).length, JSON.stringify(Object.fromEntries(shelf)));
const [first, second, ...others] = shelf;
console.log("destructured:", first[0], second[1], others.length);
console.log("map:", new Map(shelf).get("x-aisle"));

for (const name of shelf.keys()) console.log("key:", name);
for (const value of shelf.values()) console.log("value:", value);
for (const [name, value] of shelf.entries()) console.log("entry:", name, value);
console.log(
  "lists:",
  JSON.stringify([...shelf.keys()]),
  JSON.stringify(Array.from(shelf.values())),
  JSON.stringify([...shelf.entries()]),
);

// An iterator reads the list as it is when each step runs.
const live = new Headers();
live.append("b-two", "2");
live.append("a-one", "1");
live.append("c-three", "3");
const seen: string[] = [];
for (const [name, value] of live) {
  seen.push(`${name}=${value}`);
  if (name === "a-one") live.delete("b-two");
  if (name === "c-three" && !live.has("d-four")) live.append("d-four", "4");
}
console.log("live for-of:", seen.join(" | "));

const walk = shelf.entries();
console.log("step:", JSON.stringify(walk.next()));
shelf.append("a-first", "0");
shelf.append("z-last", "9");
console.log("steps:", JSON.stringify(walk.next()), JSON.stringify(walk.next()));
const rest: string[] = [];
for (const entry of walk) rest.push(entry.join("="));
console.log("rest:", rest.join(" "), JSON.stringify(walk.next()));

const names = shelf.keys();
console.log("iterator:", JSON.stringify(names[Symbol.iterator]().next()), JSON.stringify(names.next()));
const remaining: string[] = [];
for (const name of names) remaining.push(name);
console.log("remaining keys:", remaining.join(","));
const bySymbol = shelf[Symbol.iterator]();
const head = bySymbol.next();
console.log("by symbol:", head.done, head.value?.[0], head.value?.[1]);
let behind = 0;
for (const pair of bySymbol) behind += pair.length;
console.log("behind the first:", behind);

// Break, continue and a labeled break leave the loop as on an array.
let count = 0;
outer: for (const [name] of shelf) {
  if (name === "set-cookie") continue;
  for (const key of shelf.keys()) {
    if (key === "x-rows") break outer;
    count++;
  }
}
console.log("counted:", count);

// A fetched response's headers.
const response = await fetch(`${base}/text`);
const content: string[] = [];
for (const [name, value] of response.headers) {
  if (name.startsWith("content-")) content.push(`${name}=${value}`);
}
console.log("response:", content.join(";"));
const contentNames: string[] = [];
for (const name of response.headers.keys()) if (name.startsWith("content-")) contentNames.push(name);
console.log("response keys:", contentNames.join(","), [...response.headers].length > 0);
console.log("body:", await response.text());

// A copy made by iterating.
const copy = new Headers();
for (const [name, value] of response.headers.entries()) {
  if (name.startsWith("content-")) copy.set(name.toUpperCase(), value);
}
console.log("copy:", JSON.stringify([...copy.keys()]));

// Repeated and Set-Cookie headers of a response.
const echoed = await fetch(`${base}/header-echo`);
for (const [name, value] of echoed.headers) {
  if (name === "set-cookie" || name.startsWith("x-")) console.log("echoed:", name, "=", value);
}
console.log("echoed values:", JSON.stringify([...echoed.headers.values()].filter((v) => v.includes("="))));
await echoed.text();
