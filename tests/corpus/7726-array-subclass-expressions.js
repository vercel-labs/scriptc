// Classes extending Array reached through expressions rather than
// declarations and locals: a construction used in place, a class
// expression held by a binding, and an instanceof test whose class the
// program never constructs.
class Sized extends Array {
  describe() {
    return `sized ${this.length}`;
  }
}

console.log(new Sized(3).length, new Sized(2).describe(), new Sized(1, 2).join("-"));
console.log(new Sized(4).fill(1), (new Sized(2)).length);

const Holder = class extends Array {};
const held = new Holder();
held.push("a", "b");
console.log(held instanceof Holder, held instanceof Array, [] instanceof Holder, held.length);

class Unbuilt extends Array {}
const values = [[1, 2], "text", new Sized(1)];
for (const value of values) console.log(value instanceof Unbuilt, Array.isArray(value));
