// A class that extends Array overrides the generic Array method map. The
// override's own type parameter is instantiated per call site, and an
// ordinary array's map call in the same program keeps the builtin, including
// a call that passes the inherited thisArg (which the override ignores);
// the override only answers for receivers that are instances of the class.
class Mapped extends Array<number> {
  map<U>(cb: (value: number, index: number, array: number[]) => U): U[] {
    console.log("override map");
    return super.map(cb);
  }
}

const plain = [1, 2, 3];
console.log("plain", plain.map((value) => value * 2).join(","));
const context = { step: 10 };
console.log(
  "plain thisArg",
  plain
    .map(function (value) {
      return value + 1;
    }, context)
    .join(","),
);
console.log("plain strings", plain.map((value) => String(value)).join("|"));

const mapped = new Mapped();
mapped.push(4, 5);
const base: number[] = mapped;
console.log("base", base.map((value) => value).join(","));
console.log("typed", mapped.map((value) => String(value)).join("|"));
console.log("plain again", [6, 7].map((value) => value * 3).join(","));
console.log("lengths", plain.length, mapped.length);
