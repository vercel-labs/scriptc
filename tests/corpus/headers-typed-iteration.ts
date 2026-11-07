// A typed Headers iterates through keys(), values(), entries() and its own
// [Symbol.iterator]: Fetch's sort-and-combine list, names in byte order with
// their combined values and every Set-Cookie value on its own, read live.
const h = new Headers();
h.append("x-b", "2");
h.append("X-A", "1");
h.append("x-b", "3");
h.append("set-cookie", "s=1");
h.append("set-cookie", "t=2");

// A for-of head over entries(), destructured, in a function that takes the type.
function toRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}
console.log(JSON.stringify(toRecord(h)));

// keys() and values().
const names: string[] = [];
for (const name of h.keys()) names.push(name.toUpperCase());
const values: string[] = [];
for (const value of h.values()) values.push(value + "!");
console.log(names.join(","), values.join(","));

// The Headers itself, and an undestructured pair.
let direct = "";
for (const [key, value] of h) direct += `${key}=${value};`;
console.log(direct);
for (const pair of h.entries()) console.log(pair[0].length, pair[1], pair.length);

// Spreads, Array.from, Object.fromEntries, a Map and a Set.
const small = new Headers({ "X-A": "1", "x-b": "2", "x-c": "3" });
const keys = [...small.keys()];
const pairs = [...small.entries()];
const whole = [...small];
console.log(keys.join(","), [...small.values()].join(","), pairs.length, whole.length, pairs[0]![0], whole[1]![1]);
console.log(Array.from(small.keys()).join("|"));
console.log(JSON.stringify(Object.fromEntries(small.entries())), JSON.stringify(Object.fromEntries(small)));
console.log([...small.entries()].map(([k, v]) => k.length + v.length).join(","));
const asMap = new Map(small);
const asSet = new Set(small.keys());
console.log(asMap.size, asMap.get("x-b"), asSet.has("x-c"), asSet.size);

// Array destructuring of the Headers and of an iterator.
const [first, second] = small;
console.log(first[0], first[1], second[0]);
const [k1, , k3] = small.keys();
console.log(k1, k3);

// An iterator passed where an iterable is expected.
function drain(it: Iterable<[string, string]>): string {
  let out = "";
  for (const [k, v] of it) out += k + v;
  return out;
}
console.log(drain(small.entries()), drain(small));

// The iterator as an object: it is live, and a for-of resumes it.
const it = small.entries();
const start = it.next();
console.log(start.done, start.value?.[0], start.value?.[1]);
small.append("a-first", "0");
small.append("z-last", "9");
const next = it.next();
console.log(next.done, JSON.stringify(next.value));
const rest: string[] = [];
for (const entry of it) rest.push(entry.join("="));
console.log(rest.join(" "), JSON.stringify(it.next()), Array.isArray(it));

// A typed binding stepped by hand.
const stepper: IterableIterator<string> = small.values();
let step = stepper.next();
const got: string[] = [];
while (!step.done) {
  got.push(step.value);
  step = stepper.next();
}
console.log(got.join(""));

// Deleting while iterating skips the deleted name.
const seen: string[] = [];
for (const [key] of small) {
  seen.push(key);
  if (key === "x-a") small.delete("x-b");
}
console.log(seen.join(","));

// A response's headers.
const response = new Response("ok", {
  headers: [
    ["set-cookie", "s=1"],
    ["set-cookie", "t=2"],
    ["content-type", "text/plain"],
  ],
});
for (const [key, value] of response.headers.entries()) console.log(key, value);
function count(headers: Headers): number {
  let n = 0;
  for (const _ of headers.keys()) n++;
  return n;
}
console.log(count(response.headers));
