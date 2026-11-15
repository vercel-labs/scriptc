// Headers iteration in TypeScript: for-of, spread, array destructuring,
// keys() / values() / entries(), the iterator called by its symbol, a member
// chosen by a key of two names, and iterators that read the list as it is at
// each step. Names come sorted with their combined values; every Set-Cookie
// value comes alone.
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

// Typed uses of what the iteration yields.
const lengths: number[] = [];
for (const [name, value] of shelf) lengths.push(name.length + value.length);
console.log("lengths:", lengths.join(","));
const copy = new Headers();
for (const [name, value] of shelf) {
  if (name === "set-cookie") continue;
  copy.set(name.toUpperCase(), value + "!");
}
console.log("copy:", JSON.stringify([...copy]));

// The member chosen by a key of two names.
function list(source: Headers, which: "keys" | "values"): string {
  const out: string[] = [];
  for (const item of source[which]()) out.push(item);
  return out.join(",");
}
console.log("by key:", list(copy, "keys"), list(copy, "values"));

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

// Break, continue and a labeled break leave the loops as on an array.
let count = 0;
outer: for (const [name] of shelf) {
  if (name === "set-cookie") continue;
  for (const key of shelf.keys()) {
    if (key === "x-rows") break outer;
    count++;
  }
}
console.log("counted:", count);

// The headers of a Response.
const reply = new Response("ok", { headers: { "x-b": "2", "X-A": "1", "set-cookie": "s=1" } });
reply.headers.append("set-cookie", "t=2");
for (const [name, value] of reply.headers) console.log("reply:", name, value);
console.log("reply keys:", [...reply.headers.keys()].join(","));
