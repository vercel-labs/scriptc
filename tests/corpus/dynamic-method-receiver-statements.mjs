// Untyped methods that return their receiver, called as statements on
// receivers whose class is known: side effects, throws, overrides, and
// results that are used.
class Builder {
  constructor() {
    this.parts = [];
    this.count = 0;
  }
  add(part) {
    if (part === "") throw new TypeError("empty part");
    this.parts.push(part);
    this.count++;
    return this;
  }
  reset() {
    this.parts.length = 0;
    return this;
  }
}
class LoudBuilder extends Builder {
  add(part) {
    super.add(part.toUpperCase());
    return this;
  }
}
const b = new Builder();
for (let i = 0; i < 1000; i++) {
  b.add("p" + (i % 3));
  if (i % 100 === 99) b.reset();
}
console.log(b.count, b.parts.join(","));
b.add("x").add("y");
const same = b.add("z");
console.log(same === b, b.parts.join(","));
try {
  b.add("");
} catch (e) {
  console.log(e instanceof TypeError, e.message, b.count);
}
const loud = new LoudBuilder();
loud.add("a");
loud.add("b").add("c");
console.log(loud.parts.join(","), loud.count, loud instanceof Builder);
const builders = [new Builder(), new LoudBuilder()];
for (const each of builders) each.add("q");
console.log(builders.map((each) => each.parts.join("")).join("|"));
