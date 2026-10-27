// Iterator helpers on untyped iterators in JavaScript: the receivers come
// from parameters without inferred types, so the helpers run on the
// runtime's iterator objects.
const log = [];
function flush(what) {
  console.log(what, "|", log.join(" "));
  log.length = 0;
}
function values(xs) {
  return xs.values();
}
function keysOf(m) {
  return m.keys();
}
function charsOf(s) {
  return s[Symbol.iterator]();
}

// Stages and consuming methods.
const evens = values([1, 2, 3, 4, 6]).filter((x) => x % 2 === 0);
console.log(evens.next(), evens.take(1).toArray(), [...evens]);
console.log(values([1, 2, 3]).map((x, i) => x * 10 + i).toArray(), values([]).map((x) => x).toArray());
console.log(values([1, 2, 3]).reduce((a, b) => a + b), values([1, 2]).reduce((a, b, i) => a + b * i, 100));
console.log(values([5, 6, 7]).drop(1).toArray(), values([5, 6, 7]).take(Infinity).toArray());
console.log(values(new Set([1, 3, 5])).find((x) => x > 2), values(new Set()).find(() => true));
console.log(values([1, 2, 3]).some((x) => x === 2), values([1, 2, 3]).every((x) => x < 3));
console.log(keysOf(new Map([["a", 1], ["b", 2]])).map((k) => k.toUpperCase()).toArray());
console.log(charsOf("a-b-c").filter((c) => c !== "-").toArray().join(""));
const seen = [];
values(["p", "q"]).forEach((v, i) => seen.push(v + i));
console.log(seen.join(","));

// Helper objects.
const doubled = values([1, 2, 3]).map((x) => x * 2);
console.log(typeof doubled.next, typeof doubled.return, typeof doubled.map, typeof doubled.throw);
console.log(doubled.next(), doubled.return(), doubled.next());
for (const x of values([1, 2, 3]).drop(1)) log.push(`of${x}`);
flush("for...of");
console.log([...values([4, 5]).flatMap((x) => [x, x])]);
console.log(Object.prototype.toString.call(doubled), String(doubled));
console.log(doubled);
let self = null;
self = values([1, 2]).map((x) => {
  if (x === 2) {
    try {
      self.next();
    } catch (e) {
      log.push(`${e.name}: ${e.message}`);
    }
  }
  return x;
});
flush(self.toArray());

// flatMap closes an inner iterator it leaves early.
function inner(label) {
  let n = 0;
  return {
    next() {
      n++;
      return { value: `${label}${n}`, done: n > 3 };
    },
    return() {
      log.push(`${label}:closed`);
      return { done: true };
    },
  };
}
flush(values([1, 2]).flatMap((x) => inner(`i${x}`)).take(2).toArray());
const stepping = values([1]).flatMap(() => inner("j"));
stepping.next();
flush([stepping.return(), stepping.next()]);

// Node's errors for invalid arguments.
function attempt(f) {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.name}: ${e.message}`);
  }
}
attempt(() => values([1]).take("x"));
attempt(() => values([1]).drop(-1));
attempt(() => values([1]).map(5));
attempt(() => values([1]).filter(null));
attempt(() => values([1]).reduce(undefined));
attempt(() => values([1]).forEach("f"));
attempt(() => values([]).reduce((a, b) => a));
attempt(() => values([1, 2]).flatMap((x) => x).toArray());
