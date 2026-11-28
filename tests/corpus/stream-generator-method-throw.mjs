// A throw into a generator an object's iterator method returned reaches the
// generator's catch, as Node's iterator.throw does.
const events = [];
const iterable = {
  *[Symbol.iterator]() {
    try {
      yield "a";
    } catch (error) {
      events.push(`caught ${error.message}`);
    } finally {
      events.push("finally");
    }
  },
};

const iterator = iterable[Symbol.iterator]();
console.log(`first ${iterator.next().value}`);
const result = iterator.throw(new Error("boom"));
console.log(`done ${result.done} events ${events.join(",")}`);
