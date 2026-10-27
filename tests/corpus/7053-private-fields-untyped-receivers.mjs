// Private fields read and written through receivers whose type is known only
// at run time: static factories and helpers that take the instance as an
// argument, compound assignments and updates, `#x in value`, subclasses, and
// Node's TypeErrors for values that do not carry the field.
class Counter {
  #count = 0;
  #label = null;
  constructor(label) {
    this.#label = label;
  }
  static labeled(label, start) {
    let counter = new Counter("pending");
    counter.#label = label;
    counter.#count = start;
    return counter;
  }
  static read(counter) {
    return [counter.#label, counter.#count];
  }
  static bump(counter, by) {
    counter.#count += by;
    counter.#count++;
    ++counter.#count;
    return counter.#count;
  }
  static clear(counter) {
    counter.#label = null;
    return counter;
  }
  static owns(value) {
    return #count in value;
  }
  describe() {
    return `${this.#label}:${this.#count}`;
  }
}
class LimitedCounter extends Counter {
  #limit = 3;
  static limit(value) {
    return value.#limit;
  }
}

const made = Counter.labeled("made", 5);
console.log(made.describe(), Counter.read(made), Counter.bump(made, 10), made.describe());
const held = JSON.parse('{"list":[]}');
held.list.push(new Counter("held"), new LimitedCounter("limited"));
for (const item of held.list) console.log(Counter.read(item), Counter.bump(item, 1), item.describe(), Counter.owns(item));
console.log(LimitedCounter.limit(held.list[1]), Counter.clear(held.list[0]).describe());
for (const value of [{}, [], null, undefined, 1, "text", held.list[0]]) {
  try {
    console.log(Counter.read(value));
  } catch (error) {
    console.log("read", error instanceof TypeError, error.message);
  }
  try {
    Counter.bump(value, 1);
    console.log("bumped");
  } catch (error) {
    console.log("bump", error instanceof TypeError, error.message);
  }
  try {
    console.log(LimitedCounter.limit(value));
  } catch (error) {
    console.log("limit", error instanceof TypeError, error.message);
  }
  try {
    console.log("owns", Counter.owns(value));
  } catch (error) {
    console.log("owns", error instanceof TypeError, error.message);
  }
}
