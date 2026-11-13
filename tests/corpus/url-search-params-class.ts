// URLSearchParams as Node documents it: every constructor shape, every
// reader and mutator with its optional argument, the encoding rules, sorting,
// size, and the three iterator views and forEach. Each line prints one
// observation so the differential run pins both the value and the order.

// Construction from a query string: the leading '?' is the only one
// stripped, empty segments are skipped, '+' is a space and a bad escape
// stays literal.
const inits = [
  "",
  "?",
  "a=1",
  "?a=1",
  "??a=1",
  "a",
  "a=",
  "=b",
  "=",
  "a=1&a=2&a=3",
  "a+b=c+d",
  "a=%2B&b=%20",
  "a=%zz&b=%",
  "a=1&&&b=2&",
  "&&&",
  "ü=ü&é=%C3%A9",
  "a=1&b",
  "A=1&a=2",
];
for (const init of inits) console.log("parse", JSON.stringify(init), new URLSearchParams(init).toString());

// The other documented init shapes: pairs, a record (properties with a
// defined value, in source order), a copy of another list, and none.
console.log("pairs", new URLSearchParams([["a", "1"], ["a", "2"], ["b", "x y"]]).toString());
const noPairs: string[][] = [];
console.log("pairs empty", new URLSearchParams(noPairs).toString());
console.log("record", new URLSearchParams({ a: "1", b: "2 words", c: "" }).toString());
console.log("record order", new URLSearchParams({ z: "1", a: "2", m: "3" }).toString());
const source = new URLSearchParams("k=1&k=2");
const copy = new URLSearchParams(source);
copy.append("k", "3");
console.log("copy", copy.toString(), source.toString());
console.log("omitted", new URLSearchParams().size, new URLSearchParams(undefined).toString() === "");
const conditional: boolean = new URLSearchParams("x=1").has("x");
console.log("conditional", new URLSearchParams(conditional ? { on: "1" } : { off: "1" }).toString());

// Readers, including the optional value argument of has() and delete().
const params = new URLSearchParams("a=1&a=2&b=x+y&c=%zz&d=&e");
console.log("get", params.get("a"), params.get("c"), params.get("zzz"));
console.log("getAll", params.getAll("a").join("|"), params.getAll("zzz").length);
console.log("has", params.has("a"), params.has("zzz"), params.has("d"));
console.log(
  "has value",
  params.has("a", "1"),
  params.has("a", "9"),
  params.has("b", "x y"),
  params.has("d", ""),
  params.has("e", ""),
);
console.log("size", params.size, params.toString());
console.log("delete value", new URLSearchParams("a=1&a=2&a=1").toString());
const filtered = new URLSearchParams("a=1&a=2&a=1");
filtered.delete("a", "1");
console.log("delete one value", filtered.toString());
filtered.delete("a");
console.log("delete name", filtered.toString(), filtered.size);
const absent = new URLSearchParams("a=1");
absent.delete("zzz");
console.log("delete absent", absent.toString());

// Mutators re-encode on write.
const written = new URLSearchParams();
written.append("a b", "c&d=e+f");
written.append("ü", "~*'!()");
written.append("dup", "1");
written.set("dup", "2");
written.set("new", "3");
console.log("written", written.toString());

// sort() orders by name and keeps equal names in insertion order; the
// original code units compare.
const sorted = new URLSearchParams("b=1&a=2&B=3&a=1&z=4&a=5&B=0");
sorted.sort();
console.log("sorted", sorted.toString());
const empty: URLSearchParams = new URLSearchParams();
empty.sort();
console.log("sort empty", empty.toString() === "");

// The iterator views: entries, keys, values and the default iterator are
// the same live list.
const view = new URLSearchParams("a=1&b=2&a=3");
console.log("entries", [...view.entries()].map((pair) => pair.join("=")).join("&"));
console.log("keys", [...view.keys()].join(","));
console.log("values", [...view.values()].join(","));
console.log("default", [...view].map((pair) => pair[0] + ":" + pair[1]).join(","));
const iterator = view.entries();
const first = iterator.next();
const second = iterator.next();
console.log("steps", JSON.stringify(first), JSON.stringify(second));
console.log("spread strings", JSON.stringify([...new URLSearchParams("t=1")]));

// A stored iterator sees later appends; a delete shifts the rest.
const live = new URLSearchParams("a=1&b=2");
const walker = live.values();
console.log("live first", walker.next().value);
live.append("c", "3");
console.log("live rest", [...walker].join(","));

// forEach: the callback's arity selects what it receives, thisArg binds
// `this`, and the walk visits appends made during it.
const visited: string[] = [];
params.forEach((value) => visited.push(value));
console.log("forEach values", visited.join(","));
const pairsSeen: string[] = [];
params.forEach((value, name) => pairsSeen.push(name + "=" + value));
console.log("forEach pairs", pairsSeen.join("&"));
const parents: boolean[] = [];
params.forEach((value, name, parent) => parents.push(parent === params));
console.log("forEach parent", parents.join(","), parents.length);
const tally = { hits: 0 };
params.forEach(function (this: { hits: number }, value) {
  this.hits += value.length;
}, tally);
console.log("forEach this", tally.hits);
const growing = new URLSearchParams("a=1");
const order: string[] = [];
growing.forEach((value, name) => {
  order.push(name);
  if (order.length < 3) growing.append(name + "x", value);
});
console.log("forEach live", order.join(","), growing.size);

// A URL's searchParams is the live list, in both directions.
const url = new URL("https://example.com/p?a=1#f");
url.searchParams.append("b", "2");
console.log("url live", url.href, url.search, url.searchParams.size);
url.search = "?c=3";
console.log("url replaced", url.searchParams.get("c"), url.searchParams.has("a"));
url.searchParams.sort();
console.log("url sorted", url.href);
