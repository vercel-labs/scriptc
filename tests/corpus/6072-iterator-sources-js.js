// The JavaScript form: iterator objects from strings and typed arrays,
// Iterator.from over the built-in iterables, return() on helper objects,
// and flatMap over Set, Map and string results.
const log           = [];
function* count(label        , n        )                    {
  try {
    for (let i = 1; i <= n; i++) {
      log.push(`${label}${i}`);
      yield i;
    }
  } finally {
    log.push(`${label}:closed`);
  }
}
function flush(what         )       {
  console.log(what, "|", log.join(" "));
  log.length = 0;
}

// String iterators step by code point; a lone surrogate is one step.
const text = "a\u{1F600}b\uD800";
const chars = text[Symbol.iterator]();
console.log(chars.next(), chars.next().value.length, [...chars].length);
console.log(text[Symbol.iterator]().map((c) => c.length).toArray());
console.log("naïve"[Symbol.iterator]().filter((c) => c !== "ï").toArray().join(""));
for (const c of "xyz"[Symbol.iterator]().drop(1)) console.log("char", c);
console.log("hello"[Symbol.iterator]().some((c) => c === "l"), "hello"[Symbol.iterator]().find((c) => c > "h"));

// Typed array iterators.
const bytes = new Uint8Array([9, 8, 7]);
console.log(bytes.values().map((x) => x * 2).toArray(), bytes.keys().filter((i) => i > 0).toArray());
console.log(bytes.entries().map(([i, v]) => i * v).toArray());
const floats = new Float64Array([0.5, 1.5, 2.5]).values().map((x) => x + 1);
console.log(floats.next(), [...floats]);
for (const [i, v] of new Int16Array([-1, 2, -3, 4]).entries().filter(([, v]) => v > 0)) console.log(i, v);

// Iterator.from returns each built-in iterable's own iterator.
const list = [1, 2];
const fromList = Iterator.from(list);
list.push(3);
console.log([...fromList], Iterator.from("a\u{1F600}").toArray());
console.log(Iterator.from(new Set(["p", "q"])).toArray(), Iterator.from(new Map([["k", 1]])).toArray());
console.log(Iterator.from(new Uint8Array([4, 5])).reduce((a, b) => a + b, 0));
const fromGen = Iterator.from(count("a", 3));
flush([fromGen.next(), fromGen.take(1).toArray()]);
flush(Iterator.from(count("b", 9).map((x) => x * 3)).take(2).toArray());

// return() on helper objects.
const started = count("c", 3);
started.next();
const doubled = started.map((x) => x * 2);
flush([doubled.return(), started.next()]);
const fresh = count("d", 3);
const kept = fresh.filter(() => true);
flush([kept.return?.(), fresh.next(), kept.next()]);
const stepping = count("e", 5).drop(1);
flush([stepping.next(), stepping.return(), stepping.next()]);
flush(count("f", 4).map((x) => x).take(2).return());

// flatMap over Set and Map results, and a string result's TypeError.
console.log([1, 2].values().flatMap((x) => new Set([x, x * 10])).toArray());
console.log([1, 2].values().flatMap((x) => new Map([[`k${x}`, x]])).toArray());
const pairs = new Map                ([["m", 1], ["n", 2]]);
for (const [k, v] of [0].values().flatMap(() => pairs)) console.log(k, v);
try {
  count("g", 3).flatMap((x) => `s${x}`).toArray();
} catch (e) {
  log.push(`${e.name}: ${e.message}`);
}
flush("string result");
