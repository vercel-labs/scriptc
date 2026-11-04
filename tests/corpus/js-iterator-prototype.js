// %Iterator% and %Iterator.prototype% as values: the helpers called through
// the prototype on plain iterator objects, Iterator.from over objects that
// are not builtin iterables (the wrapper and its return()), instanceof, the
// abstract constructor, the members' descriptors, and argument validation
// with the closing order Node uses.
const log = [];
const t = (label, f) => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, e.constructor.name, e.message);
  }
};

function counter(limit, name) {
  let n = 0;
  return {
    next() {
      log.push(`${name}.next`);
      return n < limit ? { value: n++, done: false } : { value: undefined, done: true };
    },
    return() {
      log.push(`${name}.return`);
      return { value: undefined, done: true };
    },
  };
}

// The values and their members.
console.log(typeof Iterator, typeof Iterator.prototype, Iterator.name, Iterator.length);
console.log(Iterator.prototype.map.name, Iterator.prototype.map.length, Iterator.prototype.toArray.length);
console.log(Iterator.from.name, Iterator.from.length, Iterator.prototype.constructor === Iterator);
for (const key of ["map", "filter", "take", "drop", "flatMap", "reduce", "toArray", "forEach", "some", "every", "find"]) {
  const d = Object.getOwnPropertyDescriptor(Iterator.prototype, key);
  console.log(key, typeof d.value, d.writable, d.enumerable, d.configurable);
}
console.log(Object.keys(Iterator.prototype).length);
t("new Iterator()", () => new Iterator());
t("Iterator()", () => Iterator());

// The helpers through the prototype on a plain iterator object: lazy, with
// the counter, and return() forwarded when a stage closes early.
const mapped = Iterator.prototype.map.call(counter(3, "a"), (v, i) => `${v}@${i}`);
console.log(log.length, mapped.next().value, log.join(" "));
log.length = 0;
console.log(Iterator.prototype.take.call(counter(5, "b"), 2).toArray().join(","), log.join(" "));
log.length = 0;
console.log(Iterator.prototype.filter.call(counter(6, "c"), (v) => v % 2).toArray().join(","));
console.log(Iterator.prototype.drop.call(counter(4, "d"), 2).toArray().join(","));
console.log(Iterator.prototype.flatMap.call(counter(3, "e"), (v) => [v, -v]).toArray().join(","));
console.log(Iterator.prototype.reduce.call(counter(4, "f"), (a, b) => a + b, 10));
console.log(Iterator.prototype.some.call(counter(9, "g"), (v) => v === 2), log.slice(-1)[0]);
console.log(Iterator.prototype.find.call(counter(9, "h"), (v) => v > 3), log.slice(-1)[0]);
let sum = 0;
Iterator.prototype.forEach.call(counter(4, "i"), (v) => {
  sum += v;
});
console.log(sum, Iterator.prototype.every.call(counter(3, "j"), (v) => v < 5));
log.length = 0;

// Argument validation: the receiver first, then the argument, and the
// underlying iterator is closed when the argument is invalid.
t("map(5)", () => Iterator.prototype.map.call(counter(1, "k"), 5));
console.log(log.join(" "));
log.length = 0;
t("take(-1)", () => Iterator.prototype.take.call(counter(1, "l"), -1));
t("take(NaN)", () => Iterator.prototype.take.call(counter(1, "m"), NaN));
console.log(log.join(" "));
t("map on null", () => Iterator.prototype.map.call(null, (x) => x));
t("toArray on 1", () => Iterator.prototype.toArray.call(1));
t("reduce empty", () => Iterator.prototype.reduce.call({ next: () => ({ done: true }) }, (a) => a));

// Iterator.from: builtin iterators and generators come back as they are;
// other iterator objects are wrapped once, with their next read once.
function* gen() {
  yield 1;
  yield 2;
}
const g = gen();
console.log(Iterator.from(g) === g, Iterator.from([4, 5]).toArray().join(","), Iterator.from("xy").toArray().join("|"));
let reads = 0;
const getter = {
  get next() {
    reads++;
    let n = 0;
    return () => ({ value: n, done: n++ > 1 });
  },
};
const wrapped = Iterator.from(getter);
console.log(reads, wrapped instanceof Iterator, typeof wrapped.next, typeof wrapped.return);
console.log(wrapped.map((x) => x * 10).toArray().join(","), reads);
console.log(JSON.stringify(Iterator.from({ next: () => ({ done: true }) }).return()));
const closing = Iterator.from(counter(3, "w"));
console.log(JSON.stringify(closing.next()), JSON.stringify(closing.return()), log.join(" "));
t("Iterator.from(5)", () => Iterator.from(5));
t("Iterator.from(null)", () => Iterator.from(null));

// A chain over a wrapped iterator keeps the helper objects.
let k = 0;
const source = Iterator.from({ next: () => (k < 4 ? { value: k++, done: false } : { value: undefined, done: true }) });
const stage = source.map((x) => x + 1);
console.log(typeof stage.next, typeof stage.return, typeof stage.throw, stage instanceof Iterator);
const evens = stage.filter((x) => x % 2 === 0);
console.log(JSON.stringify(evens.next()), evens.toArray().join(","));

// instanceof over the builtin iterators and other values.
console.log(g instanceof Iterator, [].values() instanceof Iterator, gen().map((x) => x) instanceof Iterator);
console.log({} instanceof Iterator, [] instanceof Iterator, counter(1, "z") instanceof Iterator);
